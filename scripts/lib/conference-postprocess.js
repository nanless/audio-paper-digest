'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adapter = require('./conference-analysis-adapter.js');
const taxonomyApi = require('./paper-taxonomy.js');
const identityApi = require('./paper-identity.js');
const planApi = require('./conference-plan.js');
const pageApi = require('./historical-page-staging.js');
const fresh = require('./fresh-rewrite-run.js');
const analysisEngine = require('../analysis-engine.js');
const analysisContract = require('../analysis-contract.js');
const taxonomyRuntimeApi = require('./taxonomy-runtime.js');

const CONTRACT = 'conference-paper-page-staging-v1';
const AGGREGATE_CONTRACT = 'conference-aggregate-staging-v1';
const ASSIGNMENT_CONTRACT = 'conference-taxonomy-assignment-v1';
const PROJECTION_CONTRACT = 'conference-page-projection-v1';
const VERSION = 1;
const ID_RE = /^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const WEAK = { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' };
const READER_CONTRACT = 'beginner-researcher-v3';
const SOURCE_BINDINGS_CONTRACT = 'api-reader-source-bindings-v4';
const SCORING_CONTRACT = 'api-scoring-audit-v2';
const PUBLICATION_CONTRACT = 'conference-official-publication-v1';
const READER_FACING_CONTRACT = 'reader-facing-v3';
const SCORE_DIMENSIONS = Object.freeze([
    ['innovationScore', '创新', 2], ['technicalRigorScore', '技术严谨', 1.5],
    ['experimentalSufficiencyScore', '实验充分', 1.5], ['clarityScore', '清晰度', 1],
    ['impactScore', '影响力', 1.5], ['openSourceScore', '开源', 1.5],
    ['reproducibilityScore', '可复现', 0.5], ['engineeringScore', '工程/实践', 1.5]
]);
const stableHash = fresh.stableHash;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
function fail(message) { const error = new Error(`Conference postprocess rejected: ${message}`); error.code = 'CONFERENCE_POSTPROCESS_INTEGRITY'; throw error; }
function publicHttps(value, label, { identitySafe = false, conferenceOnly = false } = {}) {
    if (identitySafe) {
        try {
            const normalized = identityApi.validateOfficialUrl(value, label);
            if (conferenceOnly && /(^|\.)arxiv\.org$/i.test(new URL(normalized).hostname)) {
                fail(`${label} must be a public conference HTTPS URL`);
            }
            return normalized;
        }
        catch (error) { fail(`${label} is invalid: ${error.message}`); }
    }
    let parsed;
    try { parsed = new URL(value); } catch { fail(`${label} is not a URL`); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname
        || parsed.port || parsed.hash || !parsed.hostname.includes('.')
        || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')
        || parsed.hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
        || !parsed.hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
        || (conferenceOnly && /(^|\.)arxiv\.org$/i.test(parsed.hostname))) fail(`${label} must be a public conference HTTPS URL`);
    if (parsed.href !== value) fail(`${label} must use canonical URL spelling`);
    return parsed.href;
}
function publicationProjection(paper) {
    const value = paper?.conferencePublication;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== ['contract', 'pdfUrl', 'recordUrl'].sort().join('\0')
        || value.contract !== PUBLICATION_CONTRACT) fail('sealed canonical conference publication URLs are required');
    const recordUrl = publicHttps(value.recordUrl, 'official record URL', { identitySafe: true, conferenceOnly: true });
    const pdfUrl = publicHttps(value.pdfUrl, 'official PDF URL', { conferenceOnly: true });
    if (recordUrl === pdfUrl) fail('official record and PDF URLs must be distinct');
    return { contract: PUBLICATION_CONTRACT, recordUrl, pdfUrl };
}
function validateReaderAndScoring(paper) {
    const contracts = paper?.analysisManifest?.contracts || {};
    const scoring = paper?.analysisManifest?.stages?.scoringAudit || {};
    const acquisition = paper?.analysisManifest?.sourceAcquisition || {};
    const sectionIssue = analysisContract.validateTopLevelSectionContract(paper?.analysis);
    const coreSummaryIssue = analysisContract.validateCoreSummaryStageBinding(paper);
    if (sectionIssue || coreSummaryIssue || acquisition.fullTextAvailable !== true || acquisition.analysisSource === 'abstract') {
        const issue = sectionIssue || coreSummaryIssue;
        fail(`canonical 13-section/core-summary-detailed-v3 full-text analysis is required${issue ? `: ${issue}` : ''}`);
    }
    if (contracts.apiReaderArticle !== READER_CONTRACT
        || contracts.apiReaderSourceBindings !== SOURCE_BINDINGS_CONTRACT
        || paper?.apiReaderPlan?.contract !== READER_CONTRACT
        || paper?.apiReaderPlan?.sourceBindingsContract !== SOURCE_BINDINGS_CONTRACT
        || !analysisEngine.apiReaderV3BindsCanonical(paper)) {
        fail('Reader beginner-researcher-v3/source-bindings-v4 proof is not replayable');
    }
    if (scoring.status !== 'complete' || scoring.scoringContract !== SCORING_CONTRACT
        || !analysisEngine.scoringAuditBindsFinalAnalysis(paper)
        || !analysisEngine.scoringStabilityIsResolved(scoring)) {
        fail('api-scoring-audit-v2 proof is not replayable');
    }
    return publicationProjection(paper);
}
function authority(planHandle, dependencies = {}) {
    try { return (dependencies.planHandleAuthority || planApi.planHandleAuthority)(planHandle); }
    catch (error) { fail(`authenticated conference plan handle is required: ${error.message}`); }
}
function planProof(planHandle, dependencies = {}) {
    const authenticated = authority(planHandle, dependencies); const { run, receipt, receiptFileSha256, runFileSha256 } = authenticated.snapshot;
    const paperIds = run.members.map(item => item.paperId).sort();
    if (!paperIds.length || new Set(paperIds).size !== paperIds.length
        || run.selectedMemberSetSha256 !== stableHash(paperIds)
        || receipt.filter.selectedMemberSetSha256 !== run.selectedMemberSetSha256
        || receipt.filter.selectionReceiptSha256 !== run.selectionReceiptSha256
        || receipt.filter.filterPolicySha256 !== run.filterPolicySha256) fail('authenticated plan selected member set/provenance drifted');
    const body = { conferenceId: run.conferenceId, runIdentitySha256: run.identitySha256,
        runStateSha256: run.stateSha256, membershipSha256: run.membershipSha256,
        planReceiptSha256: receipt.receiptSha256, planReceiptFileSha256: receiptFileSha256,
        runFileSha256, filterPolicySha256: run.filterPolicySha256,
        selectionReceiptSha256: run.selectionReceiptSha256,
        selectedMemberSetSha256: run.selectedMemberSetSha256, paperIds };
    return { authenticated, proof: { ...body, proofSha256: stableHash(body) } };
}
function loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot }, dependencies = {}) {
    if (!UUID_RE.test(executionId || '')) fail('analysis execution ID must be a UUID');
    authority(planHandle, dependencies);
    const loaded = (dependencies.loadConferenceAnalysis || adapter.loadConferenceAnalysis)({ analysisRoot, executionId });
    try { (dependencies.verifyPlanAuthority || adapter.verifyPlanAuthority)(loaded, planHandle, sourceRoot); }
    catch (error) { fail(`conference analysis does not replay against the authenticated plan: ${error.message}`); }
    const receipt = loaded.run?.completionReceipt; const receiptBody = receipt && structuredClone(receipt); if (receiptBody) delete receiptBody.receiptSha256;
    if (loaded.run?.status !== 'complete' || loaded.analysis?.status !== 'complete' || !ID_RE.test(loaded.run.paperId || '')
        || loaded.run.executionId !== executionId || receipt?.executionId !== executionId
        || receipt?.analysisSha256 !== loaded.analysisFileSha256 || receipt?.paperId !== loaded.run.paperId
        || receipt?.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256 || receipt?.receiptSha256 !== stableHash(receiptBody)
        || loaded.run.analysisSha256 !== loaded.analysisFileSha256 || loaded.analysis.papers?.length !== 1
        || loaded.analysis.papers[0].id !== loaded.run.paperId || loaded.analysis.papers[0].arxivId || loaded.analysis.papers[0].paper_id) fail('sealed conference analysis completion is required');
    if (stableHash(loaded.run.capabilities) !== stableHash(WEAK)) fail('only weak unavailable-structure conference completion is supported');
    const artifacts = loaded.source?.sourceDetails?.structuredArtifacts;
    if (!artifacts || artifacts.tables.length || artifacts.formulas.length || artifacts.figures.length) fail('weak unavailable structures must remain empty');
    const sourcePaper = loaded.analysis.papers[0];
    const publication = validateReaderAndScoring(sourcePaper);
    const successful = dependencies.isSuccessful || analysisEngine.isSuccessfulAnalysisRecord;
    if (!successful(loaded.analysis.papers[0])) fail('conference canonical paper is not analysis-complete');
    const coordinates = identityApi.conferenceCoordinates(loaded.run.conference);
    const identity = identityApi.normalizeIdentity({ contract: identityApi.CONTRACT, kind: 'conference',
        canonicalId: loaded.run.paperId, arxivId: null, conference: coordinates,
        externalId: structuredClone(sourcePaper.externalId), source: { status: 'official', url: publication.recordUrl }, citation: null });
    loaded.identity = identity; loaded.identitySha256 = identityApi.identitySha256(identity); loaded.publication = publication;
    return loaded;
}
function labelProjection(paper) {
    const parsed = paper.parsed; const reparsed = require('../utils.js').parseAnalysis(paper.analysis);
    const pick = value => ({ tags: (value.tags || []).map(item => String(item).trim()),
        primaryTaskTag: String(value.primaryTaskTag || '').trim(), primaryMethodTag: String(value.primaryMethodTag || '').trim(),
        summary: String(value.summary || '').trim(), score: String(value.score || '').trim(),
        rankBucket: String(value.rankBucket || '').trim(), documentType: String(value.documentType || '').trim(),
        scoringReason: String(value.scoringReason || '').trim(),
        scoreDimensions: Object.fromEntries(SCORE_DIMENSIONS.map(([field]) => [field, String(value[field] ?? '').trim()])) });
    if (!parsed || stableHash(pick(parsed)) !== stableHash(pick(reparsed || {}))) fail('cached conference labels drifted from canonical analysis');
    const value = pick(parsed); const score = Number(value.score);
    if (!Number.isFinite(score) || score < 0 || score > 10 || !value.summary || !value.scoringReason
        || !value.rankBucket || !value.documentType
        || SCORE_DIMENSIONS.some(([field, , maximum]) => {
            const dimension = Number(value.scoreDimensions[field]);
            return !Number.isFinite(dimension) || dimension < 0 || dimension > maximum;
        }) || reparsed?.scoreValidation?.valid !== true) fail('canonical conference summary/document type/eight-dimensional score is incomplete');
    return value;
}
function resolve(taxonomy, label, facet, reasons, role) {
    const found = taxonomyApi.resolveLabelCandidates(taxonomy, label, facet);
    if (found.length !== 1 || found[0].status !== 'active') { reasons.push(`${role}:${found.length ? 'ambiguous-or-deprecated' : 'unknown'}:${label}`); return null; }
    return found[0];
}
function buildAssignment(loaded, taxonomy) {
    const paper = loaded.analysis.papers[0], input = labelProjection(paper), reasons = [], concepts = new Map();
    const taxonomyRuntime = taxonomyRuntimeApi.createTaxonomyRuntime({ taxonomy });
    const taxonomyIssue = analysisContract.validateTaxonomyStageBinding(paper, {
        parsed: require('../utils.js').parseAnalysis(paper.analysis), taxonomyRuntime
    });
    if (taxonomyIssue) fail(`current taxonomy seal is not replayable: ${taxonomyIssue}`);
    const task = resolve(taxonomy, input.primaryTaskTag, 'task', reasons, 'primary-task');
    const method = resolve(taxonomy, input.primaryMethodTag, 'method', reasons, 'primary-method');
    for (const label of input.tags) {
        const candidates = [task, method].filter(item => item && [item.preferredLabel.zh, item.preferredLabel.en, ...item.aliases]
            .some(value => taxonomyApi.normalizeLabel(value) === taxonomyApi.normalizeLabel(label)));
        const concept = candidates.length === 1 ? candidates[0] : resolve(taxonomy, label, undefined, reasons, 'tag');
        if (concept) concepts.set(concept.id, concept);
    }
    for (const item of [task, method]) if (item) concepts.set(item.id, item);
    if (!input.tags.includes(input.primaryTaskTag)) reasons.push('primary-task:not-in-tags');
    if (!input.tags.includes(input.primaryMethodTag)) reasons.push('primary-method:not-in-tags');
    const ids = taxonomyApi.pruneAncestors(taxonomy, [...concepts.keys()].sort()).sort();
    if ((task && !ids.includes(task.id)) || (method && !ids.includes(method.id))) reasons.push('primary-concept:ancestor-pruned');
    const blockedReasons = [...new Set(reasons)].sort(); const receipt = loaded.run.completionReceipt;
    const body = { contract: ASSIGNMENT_CONTRACT, version: VERSION, paperId: loaded.run.paperId,
        analysisExecutionId: loaded.run.executionId, analysisSha256: loaded.analysisFileSha256,
        completionReceiptSha256: receipt.receiptSha256, sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        registryVersion: taxonomyRuntime.registryVersion, registrySha256: taxonomy.registrySha256,
        selectionContract: taxonomyRuntime.selectionContract, flatCompatContract: taxonomyRuntime.flatCompatContract,
        status: blockedReasons.length ? 'blocked' : 'assigned', blockedReasons,
        primaryTaskId: blockedReasons.length ? null : task.id, primaryMethodId: blockedReasons.length ? null : method.id,
        conceptIds: blockedReasons.length ? [] : ids, concepts: blockedReasons.length ? [] : ids.map(id => { const item = concepts.get(id);
            return { id, facet: item.facet, preferredLabel: structuredClone(item.preferredLabel) }; }) };
    return { ...body, assignmentSha256: stableHash(body) };
}
function safeStem(loaded) {
    const parts = loaded.run.paperId.split(':'); const value = parts[4].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `conference-${parts[1]}-${parts[2]}-${parts[3]}-${value}-${sha256(loaded.run.paperId).slice(0, 10)}`;
}
function render(packet) {
    const output = execFileSync('bash', [path.join(__dirname, '..', 'python-runtime.sh'), path.join(__dirname, '..', 'conference-page-render.py')],
        { input: JSON.stringify(packet), maxBuffer: 64 * 1024 * 1024 });
    return pageApi.strictJson(output, 'conference renderer output');
}
function implementationFingerprint() {
    const sources = { nodeSourceSha256: pageApi.readRegular(__filename, 4 * 1024 * 1024, 'conference projection source').fileSha256,
        rendererSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'conference-page-render.py'), 4 * 1024 * 1024, 'conference renderer source').fileSha256,
        publisherSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'publish-to-blog.py'), 8 * 1024 * 1024, 'conference publisher source').fileSha256,
        loaderSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'blog_entry_loader.py'), 2 * 1024 * 1024, 'conference renderer loader source').fileSha256,
        parserSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'utils.js'), 8 * 1024 * 1024, 'conference parser source').fileSha256,
        taxonomySourceSha256: pageApi.readRegular(path.join(__dirname, 'paper-taxonomy.js'), 4 * 1024 * 1024, 'conference taxonomy source').fileSha256,
        identitySourceSha256: pageApi.readRegular(path.join(__dirname, 'paper-identity.js'), 4 * 1024 * 1024, 'conference identity source').fileSha256 };
    const body = { contract: PROJECTION_CONTRACT, version: VERSION, ...sources };
    return { ...body, implementationSha256: stableHash(body) };
}
function fingerprint(dependencies) {
    const value = (dependencies.implementationFingerprint || implementationFingerprint)(); const body = structuredClone(value); delete body.implementationSha256;
    const expectedKeys = ['contract', 'version', 'nodeSourceSha256', 'rendererSourceSha256', 'publisherSourceSha256',
        'loaderSourceSha256', 'parserSourceSha256', 'taxonomySourceSha256', 'identitySourceSha256', 'implementationSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
        || value.contract !== PROJECTION_CONTRACT || value.version !== VERSION || value.implementationSha256 !== stableHash(body)
        || Object.entries(value).filter(([key]) => key.endsWith('Sha256')).some(([, sha]) => !/^[a-f0-9]{64}$/.test(sha || ''))) fail('conference projection implementation fingerprint is invalid');
    return value;
}
function projection(loaded, taxonomy, renderFn, implementation) {
    const assignment = buildAssignment(loaded, taxonomy); if (assignment.status !== 'assigned') return { assignment };
    const stem = safeStem(loaded), conferenceId = loaded.run.conference.id;
    const date = loaded.run.completionReceipt.completedAt.slice(0, 10);
    const packet = { paper: { ...structuredClone(loaded.analysis.papers[0]), paper_id: loaded.run.paperId }, taxonomy: assignment,
        paper_id: loaded.run.paperId, conference: loaded.run.conference, capabilities: loaded.run.capabilities,
        publication: structuredClone(loaded.publication), date,
        aggregateUrl: `/posts/conference-${conferenceId}/` };
    delete packet.paper.arxivId;
    const rendered = renderFn(packet);
    if (!rendered || typeof rendered.markdown !== 'string' || !rendered.markdown.trim() || !Array.isArray(rendered.assets)
        || rendered.assets.length || JSON.stringify(rendered).includes('paper_digest_arxiv_id') || /arxiv\.org/i.test(rendered.markdown)) fail('generic renderer failed or emitted arXiv identity/weak assets');
    const pageBytes = Buffer.from(rendered.markdown, 'utf8'); const assignmentBytes = canonicalBytes(assignment);
    const body = { contract: CONTRACT, version: VERSION, status: 'complete', paperId: loaded.run.paperId,
        analysisExecutionId: loaded.run.executionId, analysisSha256: loaded.analysisFileSha256,
        completionReceiptSha256: loaded.run.completionReceipt.receiptSha256, sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        identity: loaded.identity, identitySha256: loaded.identitySha256, implementation,
        capabilities: structuredClone(loaded.run.capabilities), date,
        taxonomy: assignment, taxonomyAssignmentFileSha256: sha256(assignmentBytes), pagePath: `content/posts/${stem}.md`,
        primaryUrl: `/posts/${stem}/`, contentSha256: sha256(pageBytes), title: loaded.analysis.papers[0].title,
        publication: structuredClone(loaded.publication), readerContract: READER_CONTRACT,
        sourceBindingsContract: SOURCE_BINDINGS_CONTRACT, scoringContract: SCORING_CONTRACT,
        readerTitle: loaded.analysis.papers[0].apiReaderPlan.readerTitle,
        oneSentenceThesis: loaded.analysis.papers[0].apiReaderPlan.oneSentenceThesis,
        summary: loaded.analysis.papers[0].parsed.summary, score: Number(loaded.analysis.papers[0].parsed.score),
        rankBucket: loaded.analysis.papers[0].parsed.rankBucket,
        documentType: loaded.analysis.papers[0].parsed.documentType,
        scoreDimensions: Object.fromEntries(SCORE_DIMENSIONS.map(([field]) => [field, Number(loaded.analysis.papers[0].parsed[field])])),
        authors: structuredClone(loaded.analysis.papers[0].apiReaderAuthors.authors),
        resources: structuredClone(loaded.analysis.papers[0].apiReaderResources.resources) };
    return { assignment, assignmentBytes, pageBytes, manifest: { ...body, manifestSha256: stableHash(body) } };
}
function stageDirectory(stagingRoot, executionId, registrySha256, implementationSha256, create = false) {
    const root = fresh.assertSafeDirectory(stagingRoot, create); const run = fresh.assertSafeDirectory(path.join(root, executionId), create);
    const registry = fresh.assertSafeDirectory(path.join(run, registrySha256), create);
    return fresh.assertSafeDirectory(path.join(registry, implementationSha256), create);
}
function rejectExtraStageFiles(directory, allowed) {
    const entries = fs.readdirSync(directory).sort(); if (entries.some(name => !allowed.includes(name))) fail('conference stage contains unexpected recovery content');
}
function stagePaper({ analysisRoot, executionId, taxonomyFile, stagingRoot, planHandle, sourceRoot, apply = false }, dependencies = {}) {
    const loaded = loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot }, dependencies);
    const taxonomy = (dependencies.loadTaxonomy || taxonomyApi.loadTaxonomy)(taxonomyFile);
    const implementation = fingerprint(dependencies); const projected = projection(loaded, taxonomy, dependencies.render || render, implementation);
    if (stableHash(fingerprint(dependencies)) !== stableHash(implementation)) fail('conference projection implementation changed while rendering');
    if (apply) {
        const directory = stageDirectory(stagingRoot, executionId, taxonomy.registrySha256, implementation.implementationSha256, true);
        rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json']);
        pageApi.writeExact(path.join(directory, 'assignment.json'), projected.assignmentBytes || canonicalBytes(projected.assignment));
        if (projected.assignment.status === 'assigned') {
            pageApi.writeExact(path.join(directory, 'page.md'), projected.pageBytes);
            pageApi.writeExact(path.join(directory, 'manifest.json'), canonicalBytes(projected.manifest));
            rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json']);
        }
    }
    if (projected.assignment.status !== 'assigned') return { status: 'blocked', assignment: projected.assignment };
    return { status: apply ? 'staged' : 'dry-run', manifest: projected.manifest, markdown: projected.pageBytes.toString('utf8') };
}
function loadStage({ analysisRoot, executionId, taxonomyFile, stagingRoot, planHandle, sourceRoot }, dependencies = {}) {
    const loaded = loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot }, dependencies);
    const taxonomy = (dependencies.loadTaxonomy || taxonomyApi.loadTaxonomy)(taxonomyFile);
    const implementation = fingerprint(dependencies); const expected = projection(loaded, taxonomy, dependencies.render || render, implementation);
    if (stableHash(fingerprint(dependencies)) !== stableHash(implementation)) fail('conference projection implementation changed while rendering');
    if (expected.assignment.status !== 'assigned') fail('current taxonomy projection is blocked');
    const directory = stageDirectory(stagingRoot, executionId, taxonomy.registrySha256, implementation.implementationSha256); rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json']);
    const assignmentRecord = pageApi.readRegular(path.join(directory, 'assignment.json'), 16 * 1024 * 1024, 'conference taxonomy assignment');
    const manifestRecord = pageApi.readRegular(path.join(directory, 'manifest.json'), 16 * 1024 * 1024, 'conference page manifest');
    const pageRecord = pageApi.readRegular(path.join(directory, 'page.md'), 32 * 1024 * 1024, 'conference staged page');
    const assignment = pageApi.strictJson(assignmentRecord.bytes, 'conference taxonomy assignment');
    const manifest = pageApi.strictJson(manifestRecord.bytes, 'conference page manifest');
    if (!assignmentRecord.bytes.equals(expected.assignmentBytes) || !manifestRecord.bytes.equals(canonicalBytes(expected.manifest))
        || !pageRecord.bytes.equals(expected.pageBytes) || stableHash(assignment) !== stableHash(expected.assignment)
        || stableHash(manifest) !== stableHash(expected.manifest)) fail('conference stage is not the deterministic projection of current completion/taxonomy/renderer');
    return { directory, manifest, manifestFileSha256: manifestRecord.fileSha256,
        assignmentFileSha256: assignmentRecord.fileSha256, pageFileSha256: pageRecord.fileSha256 };
}
function md(value) { return String(value).replace(/([\\`*_[\]<>|{}#()+.!-])/g, '\\$1').replace(/\s+/g, ' ').trim(); }
function scoreLine(score, dimensions) {
    const detail = SCORE_DIMENSIONS.map(([field, label, maximum]) => `${label} ${Number(dimensions[field]).toFixed(1)}/${maximum}`).join(' | ');
    return `**${Number(score).toFixed(1)}/10** | ${detail}`;
}
function resourceLine(resource, paperId) {
    const labels = { code: '代码相关资源', model: '模型相关资源', dataset: '数据相关资源', demo: '演示资源',
        reproduction: '复现相关资源', third_party: '第三方资源' };
    const statuses = { available: '链接可访问', unavailable: '链接不可用', temporarily_unreachable: '暂时无法访问' };
    const original = publicHttps(resource.originalUrl, `${paperId} resource original URL`);
    const final = publicHttps(resource.finalUrl, `${paperId} resource final URL`);
    const links = `<${original}>${final === original ? '' : ` → <${final}>`}`;
    const http = resource.status === null ? '' : `（HTTP ${resource.status}）`;
    return `- ${labels[resource.type]}：${links} — ${statuses[resource.availability]}${http}`;
}
function aggregateConference({ analysisRoot, executionIds, taxonomyFile, stagingRoot, aggregateRoot,
    planHandle, sourceRoot, apply = false }, dependencies = {}) {
    if (!Array.isArray(executionIds) || !executionIds.length || new Set(executionIds).size !== executionIds.length
        || executionIds.some(id => !UUID_RE.test(id))) fail('unique selection execution IDs required');
    const authenticated = planProof(planHandle, dependencies); const expectedIds = authenticated.proof.paperIds;
    if (executionIds.length !== expectedIds.length) fail('analysis execution set must cover the complete authenticated selected member set');
    const taxonomy = (dependencies.loadTaxonomy || taxonomyApi.loadTaxonomy)(taxonomyFile); const byPaper = new Map();
    for (const executionId of executionIds) {
        const completed = loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot }, dependencies);
        if (byPaper.has(completed.run.paperId)) fail('multiple analysis executions claim one selected paper');
        byPaper.set(completed.run.paperId, { executionId, completed });
    }
    if (stableHash([...byPaper.keys()].sort()) !== stableHash(expectedIds)) fail('analysis executions are not the exact authenticated selected member set');
    const stages = expectedIds.map(paperId => {
        const item = byPaper.get(paperId); const staged = loadStage({ analysisRoot, executionId: item.executionId,
            taxonomyFile, stagingRoot, planHandle, sourceRoot }, dependencies);
        return { ...staged, completed: item.completed };
    });
    if (new Set(stages.map(item => item.manifest.pagePath)).size !== stages.length) fail('selected pages have duplicate path ownership');
    const conferenceId = authenticated.proof.conferenceId;
    const members = stages.map(item => ({ paperId: item.manifest.paperId, title: item.manifest.title, date: item.manifest.date,
        readerTitle: item.manifest.readerTitle, summary: item.manifest.summary,
        score: item.manifest.score, scoreDimensions: structuredClone(item.manifest.scoreDimensions),
        rankBucket: item.manifest.rankBucket, documentType: item.manifest.documentType,
        primaryTask: item.manifest.taxonomy.concepts.find(concept => concept.id === item.manifest.taxonomy.primaryTaskId).preferredLabel.zh,
        primaryMethod: item.manifest.taxonomy.concepts.find(concept => concept.id === item.manifest.taxonomy.primaryMethodId).preferredLabel.zh,
        authors: structuredClone(item.manifest.authors), resources: structuredClone(item.manifest.resources),
        officialRecordUrl: item.manifest.publication.recordUrl, officialPdfUrl: item.manifest.publication.pdfUrl,
        pagePath: item.manifest.pagePath, url: item.manifest.primaryUrl,
        taxonomyAssignmentSha256: item.manifest.taxonomy.assignmentSha256,
        labels: item.manifest.taxonomy.concepts.map(concept => concept.preferredLabel.zh),
        pageContentSha256: item.manifest.contentSha256, pageManifestSha256: item.manifest.manifestSha256,
        pageManifestFileSha256: item.manifestFileSha256, assignmentFileSha256: item.assignmentFileSha256 }))
        .sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId))
        .map((item, index) => ({ rank: index + 1, ...item }));
    const taxonomyProjection = members.length ? stages[0].manifest.taxonomy : null;
    if (!taxonomyProjection || stages.some(item => item.manifest.taxonomy.registrySha256 !== taxonomy.registrySha256
        || item.manifest.taxonomy.registryVersion !== taxonomyProjection.registryVersion
        || item.manifest.taxonomy.selectionContract !== taxonomyProjection.selectionContract
        || item.manifest.taxonomy.flatCompatContract !== taxonomyProjection.flatCompatContract)) fail('aggregate taxonomy metadata is missing or mixed');
    const directions = [...members.reduce((counts, item) => counts.set(item.primaryTask,
        (counts.get(item.primaryTask) || 0) + 1), new Map()).entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
    const aggregateTags = [...new Set(members.flatMap(item => item.labels))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const aggregateDate = members.map(item => item.date).sort().at(-1);
    const lines = ['---', `title: "${conferenceId} 论文深度解读"`, `date: ${aggregateDate}`, 'draft: false', 'paper_digest_pipeline_owned: true',
        `tags: ${JSON.stringify(aggregateTags)}`, `categories: ${JSON.stringify([`${conferenceId} 论文`])}`,
        `description: "共收录 ${members.length} 篇 ${conferenceId} 会议论文的 Reader 深度解读"`,
        'paper_digest_page_type: index', `paper_digest_reader_quality: "${READER_FACING_CONTRACT}"`,
        `paper_digest_taxonomy_contract: "${taxonomyProjection.flatCompatContract}"`,
        `paper_digest_taxonomy_selection_contract: "${taxonomyProjection.selectionContract}"`,
        `paper_digest_taxonomy_registry_version: "${taxonomyProjection.registryVersion}"`,
        `paper_digest_taxonomy_registry_sha256: "${taxonomy.registrySha256}"`,
        'paper_digest_taxonomy_scope: "aggregate-primary-task-counts"', '---', '', `# ${conferenceId} 论文深度解读`, '',
        `本汇总收录 authenticated plan 选择集内全部 ${members.length} 篇已完成分析、重标和单篇 staging 的论文。`, '',
        '🏷️ 标签说明：本期使用新版受控 taxonomy；热门方向只统计主任务。', '',
        '## ⚡ 今日概览', '', `✅ authenticated plan 入选 ${members.length} 篇 → 🔬 深度分析、Reader 与页面投影完成`, '',
        '### 🏷️ 热门方向', '', '| 方向（仅主任务） | 数量 |', '|---|---:|'];
    for (const [label, count] of directions) lines.push(`| #${md(label)} | ${count} 篇 |`);
    lines.push('', '## 📊 论文评分排行榜', '',
        '| 排名 | Reader 中文题目 | 英文题目 | 八维评分 | 分档 | 文档类型 | 主任务 |',
        '|---:|---|---|---|---|---|---|');
    for (const item of members) lines.push(`| ${item.rank} | [${md(item.readerTitle)}](${item.url}) | [${md(item.title)}](${item.url}) | ${scoreLine(item.score, item.scoreDimensions).replace(/ \| /g, ' · ')} | ${md(item.rankBucket)} | ${md(item.documentType)} | #${md(item.primaryTask)} |`);
    lines.push('', '---', '', '## 📋 论文列表', '');
    for (const item of members) lines.push(`### ${item.rank}. [${md(item.readerTitle)}](${item.url})`, '',
        `> 英文题目：*[${md(item.title)}](${item.url})*`, '',
        `标签：${item.labels.map(label => `#${md(label)}`).join(' ')}`, '', `评分：${scoreLine(item.score, item.scoreDimensions)}`, '',
        `排名：${md(item.rankBucket)} | 文档类型：${md(item.documentType)} | 主任务：#${md(item.primaryTask)} | 主方法：#${md(item.primaryMethod)}`, '',
        `会议来源：[官方记录](${item.officialRecordUrl}) · [官方 PDF](${item.officialPdfUrl})`, '',
        '👥 **作者与机构**', '',
        ...item.authors.map(author => `- ${md(author.name)}：${author.affiliations.map(md).join('；')}`), '',
        '📌 **核心摘要**', '', md(item.summary), '', '🔗 **开源资源**', '',
        ...(item.resources.length ? item.resources.map(resource => resourceLine(resource, item.paperId))
            : ['本次未形成可展示的已核验资源记录，开放状态尚未核实。']),
        '可达状态仅表示本次链接检查结果，不代表许可证、本文权重或运行复现已验证。', '', '---', '');
    const markdown = lines.join('\n');
    const selection = stages.map(item => ({ executionId: item.manifest.analysisExecutionId, paperId: item.manifest.paperId,
        analysisSha256: item.manifest.analysisSha256, completionReceiptSha256: item.manifest.completionReceiptSha256,
        sourceSnapshotSha256: item.manifest.sourceSnapshotSha256, pageManifestSha256: item.manifest.manifestSha256,
        pageManifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const selectionSetSha256 = stableHash(selection);
    const aggregateId = stableHash({ planProofSha256: authenticated.proof.proofSha256,
        registrySha256: taxonomy.registrySha256, selectionSetSha256 }).slice(0, 32);
    const body = { contract: AGGREGATE_CONTRACT, version: VERSION, status: 'complete', aggregateId, conferenceId, date: aggregateDate,
        plan: authenticated.proof, readerQuality: READER_FACING_CONTRACT,
        taxonomy: { contract: taxonomyProjection.flatCompatContract, selectionContract: taxonomyProjection.selectionContract,
            registryVersion: taxonomyProjection.registryVersion, registrySha256: taxonomy.registrySha256,
            scope: 'aggregate-primary-task-counts' },
        primaryTaskCounts: directions.map(([label, count]) => ({ label, count })),
        registrySha256: taxonomy.registrySha256, selection, selectionSetSha256, members,
        memberSetSha256: stableHash(members), pagePath: `content/posts/conference-${conferenceId}.md`, markdown,
        markdownSha256: sha256(Buffer.from(markdown)) };
    const manifest = { ...body, manifestSha256: stableHash(body) };
    if (apply) {
        const root = fresh.assertSafeDirectory(aggregateRoot, true); const conference = fresh.assertSafeDirectory(path.join(root, conferenceId), true);
        const directory = fresh.assertSafeDirectory(path.join(conference, aggregateId), true);
        const entries = fs.readdirSync(directory); if (entries.some(name => !['aggregate.md', 'manifest.json'].includes(name))) fail('conference aggregate contains unexpected recovery content');
        pageApi.writeExact(path.join(directory, 'aggregate.md'), Buffer.from(markdown));
        pageApi.writeExact(path.join(directory, 'manifest.json'), canonicalBytes(manifest));
    }
    return { status: apply ? 'staged' : 'dry-run', manifest };
}

module.exports = { CONTRACT, AGGREGATE_CONTRACT, ASSIGNMENT_CONTRACT, PROJECTION_CONTRACT, VERSION, stableHash, planProof,
    loadCompleted, labelProjection, buildAssignment, safeStem, render, implementationFingerprint, fingerprint,
    stagePaper, loadStage, aggregateConference };

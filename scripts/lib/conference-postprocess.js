'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adapter = require('./conference-analysis-adapter.js');
const tagCatalogApi = require('./tag-catalog.js');
const identityApi = require('./paper-identity.js');
const planApi = require('./conference-plan.js');
const pageApi = require('./historical-page-staging.js');
const fresh = require('./fresh-rewrite-run.js');
const analysisEngine = require('../analysis-engine.js');
const analysisContract = require('../analysis-contract.js');
const tagRulesApi = require('./tag-rules.js');
const sourceContextApi = require('./conference-source-context.js');

const CONTRACT = 'conference-paper-page-staging-v1';
const AGGREGATE_CONTRACT = 'conference-aggregate-staging-v1';
const ASSIGNMENT_CONTRACT = 'conference-taxonomy-assignment-v1';
const PROJECTION_CONTRACT = 'conference-page-projection-v1';
const HIERARCHY_CONTRACT = 'conference-taxonomy-hierarchy-v1';
const VERSION = 1;
const ID_RE = /^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const WEAK = { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' };
const FULL = { fullText: 'full', tables: 'available', formulas: 'available', figures: 'available' };
const PDF_VISUAL = { fullText: 'full', tables: 'unavailable', formulas: 'unavailable', figures: 'available' };
const READER_CONTRACT = 'beginner-researcher-v3';
const SOURCE_BINDINGS_CONTRACT = 'api-reader-source-bindings-v4';
const SCORING_CONTRACT = 'api-scoring-audit-v2';
const PUBLICATION_CONTRACT = 'conference-official-publication-v1';
const READER_FACING_CONTRACT = 'reader-facing-v3';
const CONFERENCE_IMAGE_BASE_URL = (process.env.PAPER_DIGEST_IMAGE_BASE_URL
    || 'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main').replace(/\/$/, '');
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
function publicHttps(value, label, { identitySafe = false, conferenceOnly = false, normalize = false } = {}) {
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
    // Fragments are client-side anchors (for example, a paper's #demo or
    // #code section); they are not sent to the network and are safe to keep in
    // the published clickable resource identity.
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname
        || parsed.port || !parsed.hostname.includes('.')
        || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')
        || parsed.hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
        || !parsed.hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
        || (conferenceOnly && /(^|\.)arxiv\.org$/i.test(parsed.hostname))) fail(`${label} must be a public conference HTTPS URL`);
    if (parsed.href !== value && !normalize) fail(`${label} must use canonical URL spelling`);
    return parsed.href;
}
function getPublicationUrls(paper) {
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
    return getPublicationUrls(paper);
}
function authority(planHandle, dependencies = {}) {
    try { return (dependencies.planHandleAuthority || planApi.planHandleAuthority)(planHandle); }
    catch (error) { fail(`authenticated conference plan handle is required: ${error.message}`); }
}
function planProof(planHandle, dependencies = {}) {
    const authenticated = authority(planHandle, dependencies); const { run, receipt, receiptFileSha256, runFileSha256 } = authenticated.snapshot;
    // Conference plan/run creation canonicalizes paper IDs with
    // localeCompare. Replaying the proof with Array#sort() uses a different
    // ordering for IDs containing uppercase title fragments (for example
    // CVPR paper identities), producing a false selected-member-set drift.
    const paperIds = run.members.map(item => item.paperId)
        .sort((left, right) => left.localeCompare(right));
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
function loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot, trustEvidence = false }, dependencies = {}) {
    if (!UUID_RE.test(executionId || '')) fail('analysis execution ID must be a UUID');
    authority(planHandle, dependencies);
    const loaded = (dependencies.loadConferenceAnalysis || adapter.loadConferenceAnalysis)({ analysisRoot, executionId });
    // trustEvidence（仅 promote 混合入账显式传入）：跨实现时代的分析各自绑定其录制时的
    // plan-receipt（原始=origin 时代、升级=新代），单一 live plan 只能匹配其一——此时
    // 只信任分析自带的证据链（下方 run/analysis/receipt/source/sourceDetails/membership
    // 校验一条不少），跳过“live plan==录制代”的交叉检查；其余调用方行为不变。
    if (!trustEvidence) {
        try { (dependencies.verifyPlanAuthority || adapter.verifyPlanAuthority)(loaded, planHandle, sourceRoot); }
        catch (error) { fail(`conference analysis does not replay against the authenticated plan: ${error.message}`); }
    }
    const receipt = loaded.run?.completionReceipt; const receiptBody = receipt && structuredClone(receipt); if (receiptBody) delete receiptBody.receiptSha256;
    if (loaded.run?.status !== 'complete' || loaded.analysis?.status !== 'complete' || !ID_RE.test(loaded.run.paperId || '')
        || loaded.run.executionId !== executionId || receipt?.executionId !== executionId
        || receipt?.analysisSha256 !== loaded.analysisFileSha256 || receipt?.paperId !== loaded.run.paperId
        || receipt?.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256 || receipt?.receiptSha256 !== stableHash(receiptBody)
        || loaded.run.analysisSha256 !== loaded.analysisFileSha256 || loaded.analysis.papers?.length !== 1
        || loaded.analysis.papers[0].id !== loaded.run.paperId || loaded.analysis.papers[0].arxivId || loaded.analysis.papers[0].paper_id) fail('sealed conference analysis completion is required');
    if (stableHash(loaded.run.capabilities) !== stableHash(WEAK)
        && stableHash(loaded.run.capabilities) !== stableHash(FULL)
        && stableHash(loaded.run.capabilities) !== stableHash(PDF_VISUAL)) fail('conference capability projection is unsupported');
    const artifacts = loaded.source?.sourceDetails?.structuredArtifacts;
    if (!artifacts || !Array.isArray(artifacts.tables) || !Array.isArray(artifacts.formulas)
        || !Array.isArray(artifacts.figures)) fail('conference structured artifacts are missing');
    if (stableHash(loaded.run.capabilities) === stableHash(WEAK)
        && (artifacts.tables.length || artifacts.formulas.length || artifacts.figures.length)) {
        fail('weak unavailable structures must remain empty');
    }
    // Reopen authenticated source evidence, not the lossy Reader adapter's
    // formula projection. This also makes uncertain formula regions visible.
    loaded.formulaEvidence = null;
    if (stableHash(loaded.run.capabilities) === stableHash(FULL)) {
        const source = (dependencies.buildConferenceSourceContext || sourceContextApi.buildConferenceSourceContext)({
            planHandle, paperId: loaded.run.paperId, sourceRoot });
        if (source.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256) fail('formula source snapshot drifted');
        loaded.formulaEvidence = buildFormulaEvidenceRecord(source);
    }
    if (stableHash(loaded.run.capabilities) === stableHash(PDF_VISUAL)
        && (artifacts.tables.length || artifacts.formulas.length
            || artifacts.parserVersion !== 'conference-pdf-structure-v2-visual-only-math-tables')) {
        fail('PDF visual source cannot claim original table cells or TeX');
    }
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
function getConsistentPublicationFields(paper) {
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
function resolve(tagCatalog, label, facet, reasons, role) {
    const found = tagCatalogApi.resolveLabelCandidates(tagCatalog, label, facet);
    if (found.length !== 1 || found[0].status !== 'active') { reasons.push(`${role}:${found.length ? 'ambiguous-or-deprecated' : 'unknown'}:${label}`); return null; }
    return found[0];
}
function buildAssignment(loaded, tagCatalog) {
    const paper = loaded.analysis.papers[0], input = getConsistentPublicationFields(paper), reasons = [], concepts = new Map();
    const tagRules = tagRulesApi.createTagRules({ tagCatalog });
    const parsed = require('../utils.js').parseAnalysis(paper.analysis);
    const tagStageProofIssue = analysisContract.validateTagStageProof(paper, { parsed, tagRules: tagRules });
    // A tag selection the current registry cannot resolve is not byte-level
    // integrity drift: it is exactly the `needs_taxonomy_review` case the
    // 标签 design promises (§6 "进入 标签 review"). Record it as an
    // explicit blocked assignment so the record joins the review queue and its
    // page is never rendered; every other seal replay failure stays fail-closed
    // with a hard integrity error.
    const unresolvedSelection = parsed?.taxonomyValidation?.valid !== true;
    if (tagStageProofIssue && !unresolvedSelection) fail(`current taxonomy seal is not replayable: ${tagStageProofIssue}`);
    if (unresolvedSelection) {
        for (const issue of parsed.taxonomyValidation.errors || []) {
            reasons.push(`selection:${String(issue).slice(0, 200)}`);
        }
    }
    // parseAnalysis canonicalizes an unresolvable role label to '', so recover
    // the raw role line: the review queue must name the label it could not
    // classify instead of reporting an empty `primary-task:unknown:`.
    const rawRoleTag = role => {
        const match = paper.analysis.match(new RegExp(`${role}\\s*[：:]\\s*(.+)`));
        return match ? String(match[1]).trim() : '';
    };
    const primaryTaskLabel = input.primaryTaskTag || rawRoleTag('主任务标签');
    const primaryMethodLabel = input.primaryMethodTag || rawRoleTag('主方法标签');
    const task = resolve(tagCatalog, primaryTaskLabel, 'task', reasons, 'primary-task');
    const method = resolve(tagCatalog, primaryMethodLabel, 'method', reasons, 'primary-method');
    for (const label of input.tags) {
        const candidates = [task, method].filter(item => item && [item.preferredLabel.zh, item.preferredLabel.en, ...item.aliases]
            .some(value => tagCatalogApi.normalizeLabel(value) === tagCatalogApi.normalizeLabel(label)));
        const concept = candidates.length === 1 ? candidates[0] : resolve(tagCatalog, label, undefined, reasons, 'tag');
        if (concept) concepts.set(concept.id, concept);
    }
    for (const item of [task, method]) if (item) concepts.set(item.id, item);
    if (!input.tags.includes(input.primaryTaskTag)) reasons.push('primary-task:not-in-tags');
    if (!input.tags.includes(input.primaryMethodTag)) reasons.push('primary-method:not-in-tags');
    const ids = tagCatalogApi.pruneAncestors(tagCatalog, [...concepts.keys()].sort()).sort();
    if ((task && !ids.includes(task.id)) || (method && !ids.includes(method.id))) reasons.push('primary-concept:ancestor-pruned');
    const blockedReasons = [...new Set(reasons)].sort(); const receipt = loaded.run.completionReceipt;
    const body = { contract: ASSIGNMENT_CONTRACT, version: VERSION, paperId: loaded.run.paperId,
        analysisExecutionId: loaded.run.executionId, analysisSha256: loaded.analysisFileSha256,
        completionReceiptSha256: receipt.receiptSha256, sourceSnapshotSha256: loaded.run.sourceSnapshotSha256,
        registryVersion: tagRules.registryVersion, registrySha256: tagCatalog.registrySha256,
        selectionContract: tagRules.selectionContract, flatCompatContract: tagRules.flatCompatContract,
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
    // Passing a large Figure-bearing JSON packet through execFileSync's stdin
    // can leave the Python child waiting for EOF on macOS.  Use an exact,
    // private temporary file instead; the renderer validates and consumes the
    // same bytes, while the parent can always close and clean up the input.
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conference-page-render-'));
    const packetFile = path.join(temporaryRoot, 'packet.json');
    try {
        fs.writeFileSync(packetFile, JSON.stringify(packet), { flag: 'wx', mode: 0o600 });
        const output = execFileSync('bash', [path.join(__dirname, '..', 'python-runtime.sh'),
            path.join(__dirname, '..', 'conference-page-render.py'), '--packet-file', packetFile],
        { maxBuffer: 64 * 1024 * 1024 });
        return pageApi.strictJson(output, 'conference renderer output');
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}
function implementationFingerprint() {
    const sources = { nodeSourceSha256: pageApi.readRegular(__filename, 4 * 1024 * 1024, 'conference projection source').fileSha256,
        rendererSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'conference-page-render.py'), 4 * 1024 * 1024, 'conference renderer source').fileSha256,
        publisherSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'publish-to-blog.py'), 8 * 1024 * 1024, 'conference publisher source').fileSha256,
        publisherCommonSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'publish_common.py'), 8 * 1024 * 1024, 'conference shared publisher source').fileSha256,
        loaderSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'blog_entry_loader.py'), 2 * 1024 * 1024, 'conference renderer loader source').fileSha256,
        parserSourceSha256: pageApi.readRegular(path.join(__dirname, '..', 'utils.js'), 8 * 1024 * 1024, 'conference parser source').fileSha256,
        taxonomySourceSha256: pageApi.readRegular(path.join(__dirname, 'tag-catalog.js'), 4 * 1024 * 1024, 'conference taxonomy source').fileSha256,
        identitySourceSha256: pageApi.readRegular(path.join(__dirname, 'paper-identity.js'), 4 * 1024 * 1024, 'conference identity source').fileSha256 };
    const body = { contract: PROJECTION_CONTRACT, version: VERSION, ...sources };
    return { ...body, implementationSha256: stableHash(body) };
}
function fingerprint(dependencies) {
    const value = (dependencies.implementationFingerprint || implementationFingerprint)(); const body = structuredClone(value); delete body.implementationSha256;
    const expectedKeys = ['contract', 'version', 'nodeSourceSha256', 'rendererSourceSha256', 'publisherSourceSha256',
        'publisherCommonSourceSha256',
        'loaderSourceSha256', 'parserSourceSha256', 'taxonomySourceSha256', 'identitySourceSha256', 'implementationSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
        || value.contract !== PROJECTION_CONTRACT || value.version !== VERSION || value.implementationSha256 !== stableHash(body)
        || Object.entries(value).filter(([key]) => key.endsWith('Sha256')).some(([, sha]) => !/^[a-f0-9]{64}$/.test(sha || ''))) fail('conference projection implementation fingerprint is invalid');
    return value;
}

function conferenceFigureAssets(loaded) {
    const paper = loaded.analysis.papers[0];
    return (paper.apiReaderFigures || []).map((figure, index) => {
        const filename = String(figure.assetFilename || '');
        const expected = path.join(loaded.directory, 'reader-assets', filename);
        if (!/^figure-\d+-[a-f0-9]{16}\.png$/.test(filename)
            || figure.cachePath !== expected || figure.assetMediaType !== 'image/png') {
            fail(`会议 Figure ${index + 1} 的缓存身份不闭合`);
        }
        const record = pageApi.readRegular(expected, 32 * 1024 * 1024, `conference Figure ${index + 1}`);
        if (record.fileSha256 !== figure.assetSha256 || record.bytes.length !== figure.assetBytes) {
            fail(`会议 Figure ${index + 1} 的缓存字节不闭合`);
        }
        return { ordinal: figure.ordinal, url: figure.url, assetSha256: figure.assetSha256,
            mediaType: 'image/png', base64: record.bytes.toString('base64') };
    });
}

function buildFormulaEvidenceRecord(source) {
    const raw = source.structuredArtifacts;
    const { validatePdfFormulaRecord } = require('./conference-extraction-receipt.js');
    const regions = (raw.formulas || []).map((formula, index) => {
        validatePdfFormulaRecord(formula, index, raw.visualAudit, raw.pages.length);
        return { ordinal: formula.ordinal, page: formula.page,
            sourceRef: formula.sourceRef, sourceExpression: structuredClone(formula.sourceExpression) };
    });
    const body = { contract: 'conference-pdf-formula-images-v1',
        pdfSha256: source.sourceBinding.pdfSha256, sourceSnapshotSha256: source.sourceSnapshotSha256,
        candidateCount: raw.visualAudit?.formulaCandidates?.length || 0, regions };
    return { ...body, evidenceSha256: stableHash(body) };
}

function buildConferencePageArtifacts(loaded, tagCatalog, renderFn, implementation) {
    const assignment = buildAssignment(loaded, tagCatalog); if (assignment.status !== 'assigned') return { assignment };
    const stem = safeStem(loaded), conferenceId = loaded.run.conference.id;
    const date = loaded.run.completionReceipt.completedAt.slice(0, 10);
    const packet = { paper: { ...structuredClone(loaded.analysis.papers[0]), paper_id: loaded.run.paperId }, taxonomy: assignment,
        paper_id: loaded.run.paperId, conference: loaded.run.conference, capabilities: loaded.run.capabilities,
        publication: structuredClone(loaded.publication), date,
        figureAssets: conferenceFigureAssets(loaded),
        formulaEvidence: loaded.formulaEvidence,
        aggregateUrl: `/posts/conference-${conferenceId}/` };
    delete packet.paper.arxivId;
    const rendered = renderFn(packet);
    if (!rendered || typeof rendered.markdown !== 'string' || !rendered.markdown.trim() || !Array.isArray(rendered.assets)) {
        fail('generic renderer failed or emitted invalid conference assets');
    }
    if (JSON.stringify(rendered).includes('paper_digest_arxiv_id') || /arxiv\.org/i.test(rendered.markdown)) {
        fail('arXiv identity leaked into conference renderer output');
    }
    if (stableHash(loaded.run.capabilities) === stableHash(WEAK) && rendered.assets.length) {
        fail('weak assets are not permitted for weak conference sources');
    }
    const assetFiles = rendered.assets.map((asset, index) => {
        if (!asset || typeof asset.path !== 'string'
            || !/^static\/images\/conference\/[a-z0-9-]+\/[a-f0-9]{12}\/figure-\d+\.png$/.test(asset.path)
            || typeof asset.base64 !== 'string'
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) {
            fail(`conference renderer returned unsafe asset ${index + 1}`);
        }
        const bytes = Buffer.from(asset.base64, 'base64');
        if (!bytes.length) fail(`conference renderer returned empty asset ${index + 1}`);
        return { path: asset.path, bytes, sha256: sha256(bytes), size: bytes.length };
    });
    if (new Set(assetFiles.map(asset => asset.path)).size !== assetFiles.length) fail('conference renderer returned duplicate assets');
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
        resources: structuredClone(loaded.analysis.papers[0].apiReaderResources.resources),
        assets: assetFiles.map(({ bytes, ...record }) => record),
        assetSetSha256: stableHash(assetFiles.map(({ bytes, ...record }) => record)) };
    return { assignment, assignmentBytes, pageBytes, assetFiles,
        manifest: { ...body, manifestSha256: stableHash(body) } };
}
// A blocked assignment is a pending-review placeholder, never a published
// artifact. Once the labels are fixed, the resolved projection may replace that
// placeholder in place (needs_taxonomy_review -> assigned); anything else keeps
// the immutable "refuses to overwrite staging bytes" behaviour.
function supersedeBlockedAssignment(directory, assignment) {
    const filename = path.join(directory, 'assignment.json');
    if (!fs.existsSync(filename)) return false;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) return false;
    if (fs.existsSync(path.join(directory, 'page.md')) || fs.existsSync(path.join(directory, 'manifest.json'))) return false;
    let existing;
    try {
        existing = pageApi.strictJson(pageApi.readRegular(filename, 16 * 1024 * 1024, 'existing conference assignment').bytes,
            'existing conference assignment');
    } catch { return false; }
    const body = { ...existing }; const previousSha256 = body.assignmentSha256; delete body.assignmentSha256;
    if (existing.status !== 'blocked' || previousSha256 !== stableHash(body)
        || existing.paperId !== assignment.paperId
        || existing.analysisExecutionId !== assignment.analysisExecutionId) return false;
    fs.unlinkSync(filename);
    return true;
}
function stageDirectory(stagingRoot, executionId, registrySha256, implementationSha256, create = false) {    const root = fresh.assertSafeDirectory(stagingRoot, create); const run = fresh.assertSafeDirectory(path.join(root, executionId), create);
    const registry = fresh.assertSafeDirectory(path.join(run, registrySha256), create);
    return fresh.assertSafeDirectory(path.join(registry, implementationSha256), create);
}
function rejectExtraStageFiles(directory, allowed) {
    const entries = fs.readdirSync(directory).sort(); if (entries.some(name => !allowed.includes(name))) fail('conference stage contains unexpected recovery content');
}
function stagePaper({ analysisRoot, executionId, tagCatalogPath, stagingRoot, planHandle, sourceRoot, apply = false, trustEvidence = false }, dependencies = {}) {
    const loaded = loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot, trustEvidence }, dependencies);
    const tagCatalog = (dependencies.loadTagCatalog || tagCatalogApi.loadTagCatalog)(tagCatalogPath);
    const implementation = fingerprint(dependencies); const projected = buildConferencePageArtifacts(loaded, tagCatalog, dependencies.render || render, implementation);
    if (stableHash(fingerprint(dependencies)) !== stableHash(implementation)) fail('conference projection implementation changed while rendering');
    if (apply) {
        const directory = stageDirectory(stagingRoot, executionId, tagCatalog.registrySha256, implementation.implementationSha256, true);
        rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json', 'assets']);
        supersedeBlockedAssignment(directory, projected.assignment);
        pageApi.writeExact(path.join(directory, 'assignment.json'), projected.assignmentBytes || canonicalBytes(projected.assignment));
        if (projected.assignment.status === 'assigned') {
            pageApi.writeExact(path.join(directory, 'page.md'), projected.pageBytes);
            for (const asset of projected.assetFiles || []) {
                const target = path.resolve(directory, 'assets', ...asset.path.split('/'));
                if (!target.startsWith(`${path.join(directory, 'assets')}${path.sep}`)) fail('conference asset escapes staging directory');
                pageApi.writeExact(target, asset.bytes);
            }
            pageApi.writeExact(path.join(directory, 'manifest.json'), canonicalBytes(projected.manifest));
            rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json', 'assets']);
        }
    }
    if (projected.assignment.status !== 'assigned') return { status: 'blocked', assignment: projected.assignment };
    return { status: apply ? 'staged' : 'dry-run', manifest: projected.manifest, markdown: projected.pageBytes.toString('utf8') };
}
function loadStage({ analysisRoot, executionId, tagCatalogPath, stagingRoot, planHandle, sourceRoot, trustEvidence = false }, dependencies = {}) {
    const loaded = loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot, trustEvidence }, dependencies);
    const tagCatalog = (dependencies.loadTagCatalog || tagCatalogApi.loadTagCatalog)(tagCatalogPath);
    const implementation = fingerprint(dependencies); const expected = buildConferencePageArtifacts(loaded, tagCatalog, dependencies.render || render, implementation);
    if (stableHash(fingerprint(dependencies)) !== stableHash(implementation)) fail('conference projection implementation changed while rendering');
    if (expected.assignment.status !== 'assigned') fail('current taxonomy projection is blocked');
    const directory = stageDirectory(stagingRoot, executionId, tagCatalog.registrySha256, implementation.implementationSha256); rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json', 'assets']);
    const assignmentRecord = pageApi.readRegular(path.join(directory, 'assignment.json'), 16 * 1024 * 1024, 'conference taxonomy assignment');
    const manifestRecord = pageApi.readRegular(path.join(directory, 'manifest.json'), 16 * 1024 * 1024, 'conference page manifest');
    const pageRecord = pageApi.readRegular(path.join(directory, 'page.md'), 32 * 1024 * 1024, 'conference staged page');
    const assignment = pageApi.strictJson(assignmentRecord.bytes, 'conference taxonomy assignment');
    const manifest = pageApi.strictJson(manifestRecord.bytes, 'conference page manifest');
    if (!assignmentRecord.bytes.equals(expected.assignmentBytes) || !manifestRecord.bytes.equals(canonicalBytes(expected.manifest))
        || !pageRecord.bytes.equals(expected.pageBytes) || stableHash(assignment) !== stableHash(expected.assignment)
        || stableHash(manifest) !== stableHash(expected.manifest)) fail('conference stage is not the deterministic projection of current completion/taxonomy/renderer');
    for (const asset of expected.manifest.assets || []) {
        const record = pageApi.readRegular(path.join(directory, 'assets', ...asset.path.split('/')), 32 * 1024 * 1024, 'conference staged asset');
        if (record.fileSha256 !== asset.sha256 || record.bytes.length !== asset.size) fail(`conference staged asset drifted: ${asset.path}`);
    }
    return { directory, manifest, manifestFileSha256: manifestRecord.fileSha256,
        assignmentFileSha256: assignmentRecord.fileSha256, pageFileSha256: pageRecord.fileSha256 };
}
function repairFormulaDelimiters(markdown) {
    return String(markdown).replace(/(?<!\\)\\+\[([\s\S]*?)(\\+)\]|(?<!\\)\\+\(([\s\S]*?)(\\+)\)/g,
        (_match, display, _displaySlashes, inline, _inlineSlashes) => {
            const isDisplay = display !== undefined;
            const value = (isDisplay ? display : inline)
                .replace(/</g, '\\lt ').replace(/>/g, '\\gt ');
            return `${isDisplay ? '\\[' : '\\('}${value}${isDisplay ? '\\]' : '\\)'}`;
        });
}
function repairConferenceImageUrls(markdown) {
    return String(markdown).replace(
        /(?<![A-Za-z0-9])(?:\/static)?\/images\/conference\/([a-z0-9-]+)\/([a-f0-9]{12})\/figure-(\d+)\.png(?!\d)/g,
        (_match, conferenceId, figureHash, ordinal) =>
            `${CONFERENCE_IMAGE_BASE_URL}/${conferenceId}/${figureHash}/figure-${ordinal}.png`,
    );
}
function repairCaptionQuotedGlossLinks(markdown) {
    // Quoted phonetic glosses are source text, not relative link targets.
    // Keep the original visible text and reserve this repair for generated
    // Figure caption lines; article links, image labels and formulas stay intact.
    let fence = null;
    return String(markdown).split('\n').map(line => {
        const ending = line.endsWith('\r') ? '\r' : '';
        const text = ending ? line.slice(0, -1) : line;
        const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            if (!fence) fence = { char: marker[1][0], length: marker[1].length };
            else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
            return line;
        }
        if (fence || !/^\*论文图\s+\d+。[^\n]*\*$/.test(text)) return line;
        // The new repair is deliberately limited to plain generated captions.
        // Existing repairs still apply separately; mixed Markdown/TeX is not parsed here.
        const caption = text.slice(1, -1);
        if (/[\\$`<>*_~]/.test(caption) || caption.includes('![')) return line;
        let depth = 0;
        for (const char of caption) {
            if (char === '[' && ++depth > 1) return line;
            if (char === ']' && --depth < 0) return line;
        }
        if (depth !== 0) return line;
        return text.replace(/(?<![\\!])\[([^\[\]\n]+)\]\((‘[^‘’\n]*’|“[^“”\n]*”|'[^'\n]*'|"[^"\n]*")\)/g,
            (_match, label, gloss) => `&#91;${label}&#93;(${gloss})`) + ending;
    }).join('\n');
}

function repairPreservedPage(markdown) {
    const source = String(markdown);
    const frontmatter = source.match(/^---\n[\s\S]*?\n---\n/);
    const prefix = frontmatter ? frontmatter[0] : '';
    const body = frontmatter ? source.slice(prefix.length) : source;
    return prefix + repairConferenceImageUrls(repairUnpairedMarkdownStars(
        repairTechnicalNotationAsterisks(repairStatisticalSignificanceStars(
            repairCurrencyDollars(repairFormulaDelimiters(repairCaptionQuotedGlossLinks(body)))))));
}
function repairCurrencyDollars(markdown) {
    // Currency markers are literal prose, not Goldmark math delimiters.
    // Restrict this repair to a dollar immediately followed by a number so
    // ordinary TeX-like `$x$` expressions remain available to repairDollarMath.
    return String(markdown).replace(/(?<!\\)\$(?=\s*[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g, '\\\$');
}
function repairTechnicalNotationAsterisks(markdown) {
    // Compact notation such as H1*-H2* is scientific text, not Markdown
    // emphasis.  Escape only a star immediately following a letter/digit
    // technical token; real ** emphasis markers remain untouched.
    return String(markdown).replace(/(?<!\\)\b[A-Za-z]+\d+\*(?!\*)/g,
        match => `${match.slice(0, -1)}\\*`);
}
function repairStatisticalSignificanceStars(markdown) {
    return String(markdown).replace(
        /((?:p|P)\s*(?:=|<|>)\s*(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?))(?<!\\)(\*{1,3})(?!\*)/g,
        (_match, value, stars) => `${value}${stars.split('').map(() => '\\*').join('')}`,
    );
}
function repairUnpairedMarkdownStars(markdown) {
    let inFence = false;
    return String(markdown).split('\n').map(line => {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
        if (inFence) return line;
        const runs = [...line.matchAll(/(?<!\\)(\*+)/g)]
            .filter(match => match[1].length === 1);
        if (!runs.length || /^\s*\*\s+/.test(line)) return line;
        const likelyOpening = match => {
            const start = match.index;
            const previous = start > 0 ? line[start - 1] : '';
            const next = line[start + 1] || '';
            return (!previous || /\s/.test(previous)) && next !== '' && !/\s/.test(next);
        };
        // A linguistic marker can contain several opening stars on one line
        // (for example “*Vː2 ... *mättīsin”) without a closing emphasis star.
        // Keep genuine *italic* pairs, but escape the whole run when every
        // single star is an opening marker and there is no plausible closer.
        const shouldEscape = runs.length === 1 || runs.every(likelyOpening);
        if (!shouldEscape) return line;
        return runs.reduceRight((current, match) => {
            const start = match.index;
            return current.slice(0, start) + '\\*' + current.slice(start + 1);
        }, line);
    }).join('\n');
}
function repairDollarMath(markdown) {
    return String(markdown).replace(/(?<!\\)\$(?!\$)([\s\S]*?)(?<!\\)\$(?!\$)/g,
        (_match, body) => `\\(${body.replace(/\\\(/g, '(').replace(/\\\)/g, ')')}\\)`);
}
function safeStageChild(directory, name, label) {
    if (typeof name !== 'string' || !/^[a-f0-9]{64}$/i.test(name)) fail(`${label} directory name is invalid`);
    const child = path.join(directory, name);
    if (path.dirname(child) !== directory) fail(`${label} directory escapes staging root`);
    return fresh.assertSafeDirectory(child);
}
function stageAssetInventory(directory) {
    const assetsRoot = path.join(directory, 'assets');
    if (!fs.existsSync(assetsRoot)) return [];
    fresh.assertSafeDirectory(assetsRoot);
    const files = [];
    const walk = current => {
        for (const name of fs.readdirSync(current).sort()) {
            if (!/^[A-Za-z0-9._-]+$/.test(name)) fail('preserved conference asset name is invalid');
            const target = path.join(current, name);
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) fail('preserved conference assets cannot contain symlinks');
            if (stat.isDirectory()) { fresh.assertSafeDirectory(target); walk(target); }
            else if (stat.isFile()) files.push(path.relative(assetsRoot, target).split(path.sep).join('/'));
            else fail('preserved conference assets contain an unsupported file type');
        }
    };
    walk(assetsRoot);
    return files.sort();
}
function loadPreservedStage({ stagingRoot, executionId, paperId, pageProof, repair = false, repairMode, repairPolicy }, dependencies = {}) {
    if (repairMode !== undefined && (repairMode !== 'caption-only' || !repair
        || repairPolicy?.contract !== 'conference-caption-only-page-repair-policy-v1'
        || repairPolicy.mode !== repairMode || repairPolicy.implementationSha256 !== sha256(fs.readFileSync(__filename))
        || Object.keys(repairPolicy).sort().join('\0') !== ['contract', 'mode', 'implementationSha256'].sort().join('\0'))) {
        fail('caption-only repair requires the exact authorized policy');
    }
    if (!UUID_RE.test(executionId || '') || !ID_RE.test(paperId || '') || !pageProof
        || !/^[a-f0-9]{64}$/i.test(pageProof.manifestSha256 || '')
        || !/^[a-f0-9]{64}$/i.test(pageProof.contentSha256 || '')
        || typeof pageProof.pagePath !== 'string') fail('preserved conference stage proof is invalid');
    const root = fresh.assertSafeDirectory(stagingRoot);
    const runRoot = fresh.assertSafeDirectory(path.join(root, executionId));
    const matches = [];
    for (const registryName of fs.readdirSync(runRoot).sort()) {
        const registry = safeStageChild(runRoot, registryName, 'preserved registry');
        for (const implementationName of fs.readdirSync(registry).sort()) {
            const directory = safeStageChild(registry, implementationName, 'preserved projection');
            rejectExtraStageFiles(directory, ['assignment.json', 'page.md', 'manifest.json', 'assets']);
            const assignmentRecord = pageApi.readRegular(path.join(directory, 'assignment.json'), 16 * 1024 * 1024, 'preserved conference taxonomy assignment');
            const manifestRecord = pageApi.readRegular(path.join(directory, 'manifest.json'), 16 * 1024 * 1024, 'preserved conference page manifest');
            const pageRecord = pageApi.readRegular(path.join(directory, 'page.md'), 32 * 1024 * 1024, 'preserved conference staged page');
            const assignment = pageApi.strictJson(assignmentRecord.bytes, 'preserved conference taxonomy assignment');
            const manifest = pageApi.strictJson(manifestRecord.bytes, 'preserved conference page manifest');
            const manifestBody = { ...manifest }; delete manifestBody.manifestSha256;
            if (manifest.contract !== CONTRACT || manifest.version !== VERSION || manifest.status !== 'complete'
                || manifest.paperId !== paperId || manifest.analysisExecutionId !== executionId
                || manifest.manifestSha256 !== stableHash(manifestBody)
                || manifest.contentSha256 !== sha256(pageRecord.bytes)
                || manifest.contentSha256 !== pageProof.contentSha256
                || manifest.manifestSha256 !== pageProof.manifestSha256
                || manifest.pagePath !== pageProof.pagePath) continue;
            const assignmentBody = { ...assignment }; delete assignmentBody.assignmentSha256;
            if (assignment.contract !== ASSIGNMENT_CONTRACT || assignment.version !== VERSION
                || assignment.paperId !== paperId || assignment.analysisExecutionId !== executionId
                || assignment.status !== 'assigned' || assignment.assignmentSha256 !== stableHash(assignmentBody)
                || manifest.taxonomy?.assignmentSha256 !== assignment.assignmentSha256
                || manifest.taxonomy?.registrySha256 !== assignment.registrySha256) {
                fail(`preserved conference taxonomy assignment is invalid: ${paperId}`);
            }
            const declaredAssets = manifest.assets || [];
            if (!Array.isArray(declaredAssets) || declaredAssets.some(asset => !asset || Object.keys(asset).sort().join('\0') !== ['path', 'sha256', 'size'].sort().join('\0'))
                || new Set(declaredAssets.map(asset => asset.path)).size !== declaredAssets.length) {
                fail(`preserved conference asset manifest is invalid: ${paperId}`);
            }
            const expectedAssets = declaredAssets.map(asset => asset.path).sort();
            const actualAssets = stageAssetInventory(directory).map(asset => asset);
            if (stableHash(expectedAssets) !== stableHash(actualAssets)) fail(`preserved conference asset inventory drifted: ${paperId}`);
            for (const asset of declaredAssets) {
                if (typeof asset.path !== 'string' || path.posix.normalize(asset.path) !== asset.path
                    || asset.path.startsWith('/') || asset.path.includes('..')
                    || !/^[A-Za-z0-9._/-]+$/.test(asset.path)
                    || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '') || !Number.isSafeInteger(asset.size) || asset.size < 0) {
                    fail(`preserved conference asset record is invalid: ${paperId}`);
                }
                const assetFile = path.join(directory, 'assets', ...asset.path.split('/'));
                const loaded = pageApi.readRegular(assetFile, 32 * 1024 * 1024, 'preserved conference asset');
                if (loaded.fileSha256 !== asset.sha256 || loaded.bytes.length !== asset.size) fail(`preserved conference asset drifted: ${paperId} ${asset.path}`);
            }
            const repairedPageBytes = repair ? Buffer.from((repairMode === 'caption-only'
                ? repairCaptionQuotedGlossLinks : repairPreservedPage)(pageRecord.bytes.toString('utf8')), 'utf8') : pageRecord.bytes;
            if (repairedPageBytes.equals(pageRecord.bytes)) {
                matches.push({ status: 'staged', directory, manifest, manifestFileSha256: manifestRecord.fileSha256,
                    assignmentFileSha256: assignmentRecord.fileSha256, pageFileSha256: pageRecord.fileSha256 });
                continue;
            }
            const repairBody = repairMode === 'caption-only'
                ? { contract: 'conference-deterministic-page-repair-v1', version: 11, mode: repairMode,
                    implementationSha256: repairPolicy.implementationSha256,
                    fromManifestSha256: manifest.manifestSha256, fromContentSha256: manifest.contentSha256,
                    assignmentFileSha256: assignmentRecord.fileSha256, assetSetSha256: stableHash(declaredAssets),
                    replacements: ['literal-quoted-phonetic-gloss-in-generated-figure-caption'] }
                : { contract: 'conference-deterministic-page-repair-v1', version: 10,
                fromManifestSha256: manifest.manifestSha256, fromContentSha256: manifest.contentSha256,
                replacements: ['math-angle-brackets-to-tex-commands', 'normalize-math-closing-delimiters',
                    'local-conference-image-path-to-dedicated-image-repository-url',
                    'escape-currency-dollar-markers', 'escape-technical-notation-asterisks',
                    'preserve-frontmatter-bytes', 'escape-statistical-significance-stars',
                    'escape-unpaired-technical-asterisks', 'literal-quoted-phonetic-gloss-in-generated-figure-caption'] };
            const repairDirectory = path.join(path.dirname(directory), stableHash(repairBody));
            fresh.assertSafeDirectory(repairDirectory, true);
            const repairedManifestBody = { ...manifest, contentSha256: sha256(repairedPageBytes), deterministicPageRepair: repairBody };
            delete repairedManifestBody.manifestSha256;
            const repairedManifest = { ...repairedManifestBody, manifestSha256: stableHash(repairedManifestBody) };
            pageApi.writeExact(path.join(repairDirectory, 'assignment.json'), assignmentRecord.bytes);
            pageApi.writeExact(path.join(repairDirectory, 'page.md'), repairedPageBytes);
            for (const asset of declaredAssets) {
                const sourceAsset = path.join(directory, 'assets', ...asset.path.split('/'));
                const targetAsset = path.join(repairDirectory, 'assets', ...asset.path.split('/'));
                pageApi.writeExact(targetAsset, pageApi.readRegular(sourceAsset, 32 * 1024 * 1024, 'preserved conference asset').bytes);
            }
            pageApi.writeExact(path.join(repairDirectory, 'manifest.json'), canonicalBytes(repairedManifest));
            matches.push({ status: 'staged', directory: repairDirectory, manifest: repairedManifest,
                manifestFileSha256: pageApi.readRegular(path.join(repairDirectory, 'manifest.json'), 16 * 1024 * 1024, 'repaired conference page manifest').fileSha256,
                assignmentFileSha256: assignmentRecord.fileSha256, pageFileSha256: sha256(repairedPageBytes),
                repairedFrom: { manifestSha256: manifest.manifestSha256, contentSha256: manifest.contentSha256 } });
        }
    }
    if (matches.length !== 1) fail(`preserved conference stage is not uniquely bound: ${paperId}`);
    return matches[0];
}
function md(value) {
    // Parentheses in aggregate titles/labels are literal text, not inline
    // TeX delimiters.  HTML entities render identically while avoiding the
    // `\\(` / `\\)` spelling that the Markdown math gate must reserve for
    // actual formulas.
    return String(value).replace(/[()]/g, char => char === '(' ? '&#40;' : '&#41;')
        .replace(/([\\`*_\[\]<>|{}#+.!-])/g, '\\$1').replace(/\s+/g, ' ').trim();
}
function scoreLine(score, dimensions) {
    const detail = SCORE_DIMENSIONS.map(([field, label, maximum]) => `${label} ${Number(dimensions[field]).toFixed(1)}/${maximum}`).join(' | ');
    return `**${Number(score).toFixed(1)}/10** | ${detail}`;
}
function isArxivResource(resource) {
    return [resource?.originalUrl, resource?.finalUrl].some(value => {
        try { return /(^|\.)arxiv\.org$/i.test(new URL(value).hostname); }
        catch { return false; }
    });
}
function resourceLine(resource, paperId) {
    const labels = { code: '代码相关资源', model: '模型相关资源', dataset: '数据相关资源', demo: '演示资源',
        reproduction: '复现相关资源', third_party: '第三方资源' };
    const statuses = { available: '链接可访问', unavailable: '链接不可用', temporarily_unreachable: '暂时无法访问' };
    // Resource identity preserves the exact URL spelling seen in the paper;
    // the rendered link may use URL.href normalization (for example, adding
    // the root slash to https://example.org/) without changing that evidence.
    let original, final;
    try {
        original = publicHttps(resource.originalUrl, `${paperId} resource original URL`, { normalize: true });
        final = publicHttps(resource.finalUrl, `${paperId} resource final URL`, { normalize: true });
    } catch (error) {
        // A legacy Reader may have sealed an incomplete URL together with an
        // explicitly unavailable status. It cannot support a positive link
        // claim, so represent it as an unclickable unavailable record rather
        // than rejecting the whole conference aggregate. Available resources
        // remain fail-closed: malformed positive evidence must never publish.
        if (resource?.availability !== 'available') {
            const status = statuses[resource?.availability] || '状态未核实';
            return `- ${labels[resource?.type] || '资源'}：本次 URL 不完整，未作为可点击链接展示 — ${status}`;
        }
        throw error;
    }
    const links = `<${original}>${final === original ? '' : ` → <${final}>`}`;
    const http = resource.status === null ? '' : `（HTTP ${resource.status}）`;
    return `- ${labels[resource.type]}：${links} — ${statuses[resource.availability]}${http}`;
}
function aggregateHierarchy(tagCatalog, memberConceptIds) {
    // The hierarchy is always rebuilt from the exact registry bytes the batch
    // was staged against: the caller has already proven every staged page
    // sealed the same registrySha256, so a concept id this registry cannot
    // resolve is impossible — and fails closed here anyway.
    if (!tagCatalog || typeof tagCatalog !== 'object' || !Array.isArray(tagCatalog.facets)
        || !Array.isArray(tagCatalog.concepts) || typeof tagCatalog.version !== 'string'
        || !/^[a-f0-9]{64}$/.test(String(tagCatalog.registrySha256 || ''))) {
        fail('taxonomy hierarchy requires the loaded registry bytes and their SHA');
    }
    if (!Array.isArray(memberConceptIds)) fail('aggregate member concept projections are required');
    const byId = new Map();
    for (const concept of tagCatalog.concepts) {
        if (byId.has(concept.id)) fail('registry contains duplicate concept IDs');
        byId.set(concept.id, concept);
    }
    const direct = new Map(); const subtree = new Map();
    memberConceptIds.forEach((conceptIds, index) => {
        if (!Array.isArray(conceptIds)) fail(`aggregate member ${index + 1} concept projection must be an array`);
        const carried = new Set();
        for (const id of conceptIds) {
            const concept = typeof id === 'string' ? byId.get(id) : null;
            if (!concept || concept.status !== 'active') {
                fail(`aggregate member carries a concept the current registry does not know: ${String(id)}`);
            }
            carried.add(id);
        }
        for (const id of carried) direct.set(id, (direct.get(id) || 0) + 1);
        // 含子树 = 本节点 ∪ 全部后代，按成员（论文）去重；一个成员把同一条
        // 祖先链推进两次也只算一次，绝不能把子标签频次直接相加。
        const covered = new Set();
        for (const id of carried) {
            let current = id;
            while (current !== null && !covered.has(current)) {
                covered.add(current);
                current = byId.get(current).broaderId;
            }
        }
        for (const id of covered) subtree.set(id, (subtree.get(id) || 0) + 1);
    });
    const levelOf = concept => {
        let level = 0; let current = concept;
        while (current.broaderId !== null) {
            const parent = byId.get(current.broaderId);
            if (!parent) fail(`registry concept ${current.id} references an unknown broader concept`);
            current = parent; level += 1;
            if (level > 64) fail('registry concept hierarchy is too deep');
        }
        return level;
    };
    const nodes = new Map();
    for (const concept of tagCatalog.concepts) {
        const directCount = direct.get(concept.id) || 0;
        const subtreeCount = subtree.get(concept.id) || 0;
        if (!directCount && !subtreeCount) continue;
        nodes.set(concept.id, { id: concept.id, label: concept.preferredLabel.zh, facet: concept.facet,
            level: levelOf(concept), directCount, subtreeCount, children: [] });
    }
    const compare = (left, right) => right.subtreeCount - left.subtreeCount
        || right.directCount - left.directCount
        || left.label.localeCompare(right.label, 'zh-CN');
    for (const [id, node] of nodes) {
        const parentId = byId.get(id).broaderId;
        if (parentId === null) continue;
        const parent = nodes.get(parentId);
        if (!parent) fail(`counted taxonomy node ${id} is missing its counted ancestor ${parentId}`);
        parent.children.push(node);
    }
    for (const node of nodes.values()) node.children.sort(compare);
    return { contract: HIERARCHY_CONTRACT, registryVersion: tagCatalog.version,
        registrySha256: tagCatalog.registrySha256, memberCount: memberConceptIds.length,
        // 每分面一棵树；只有计数 > 0 的节点存在，空分面保留为 nodes: []。
        facets: tagCatalog.facets.map(facet => ({ id: facet.id, label: facet.label,
            nodes: tagCatalog.concepts.filter(concept => concept.facet === facet.id
                && concept.broaderId === null && nodes.has(concept.id))
                .map(concept => nodes.get(concept.id)).sort(compare) })) };
}

function tagHref(label) {
    // Hugo 的 标签 词页 URL 走 URLize：ASCII 大小写被折成小写（线上
    // /tags/Transformer/ 404、/tags/transformer/ 200），空格折成 '-'；中文
    // 标签则按 UTF-8 百分号编码（/tags/%E9%B2%81%E6%A3%92%E6%80%A7/ 200）。
    // 这里复刻同一规则，保证 8 个英文专名标签的链接不会打到 404。
    return `/tags/${encodeURIComponent(String(label).trim().replace(/\s+/g, '-').toLowerCase())}/`;
}

function hierarchyLines(hierarchy) {
    const lines = ['### 🏷️ 多级标签统计', '',
        `每个层级都统计本期论文数：\`直接\` 是成员页面直接标记该标签的篇数，\`含子树\` 是该标签及其全部下级标签的去重论文数（registry 共 ${hierarchy.facets.length} 个分面，本期只列出有论文的分面）。零级标签可点开进入对应标签页，点开下级标签可看该级论文数。`, ''];
    const used = hierarchy.facets.filter(facet => facet.nodes.length);
    const walk = nodes => {
        for (const node of nodes) {
            lines.push(`${'  '.repeat(node.level)}- [#${md(node.label)}](${tagHref(node.label)})`
                + ` — 直接 ${node.directCount} 篇 · 含子树 ${node.subtreeCount} 篇`);
            walk(node.children);
        }
    };
    for (const facet of used) {
        lines.push(`#### ${md(facet.label)}`, '');
        walk(facet.nodes);
        lines.push('');
    }
    if (!used.length) lines.push('本期没有可统计的受控标签。', '');
    lines.pop();
    return lines;
}

function aggregateConference({ analysisRoot, executionIds, tagCatalogPath, stagingRoot, aggregateRoot,
    planHandle, sourceRoot, preservedStages = {}, apply = false, trustEvidence = false }, dependencies = {}) {
    if (!Array.isArray(executionIds) || !executionIds.length || new Set(executionIds).size !== executionIds.length
        || executionIds.some(id => !UUID_RE.test(id))) fail('unique selection execution IDs required');
    const authenticated = planProof(planHandle, dependencies); const expectedIds = authenticated.proof.paperIds;
    if (executionIds.length !== expectedIds.length) fail('analysis execution set must cover the complete authenticated selected member set');
    const tagCatalog = (dependencies.loadTagCatalog || tagCatalogApi.loadTagCatalog)(tagCatalogPath); const byPaper = new Map();
    for (const executionId of executionIds) {
        const preserved = Object.hasOwn(preservedStages, executionId) ? preservedStages[executionId] : null;
        const completed = preserved ? null : loadCompleted({ analysisRoot, executionId, planHandle, sourceRoot, trustEvidence }, dependencies);
        const staged = preserved ? loadPreservedStage({ stagingRoot, executionId, paperId: preserved.paperId, pageProof: preserved.pageProof }, dependencies) : null;
        const paperId = preserved ? staged.manifest.paperId : completed.run.paperId;
        if (byPaper.has(paperId)) fail('multiple analysis executions claim one selected paper');
        byPaper.set(paperId, { executionId, completed, ...(staged ? { staged } : {}) });
    }
    if (stableHash([...byPaper.keys()].sort((left, right) => left.localeCompare(right)))
            !== stableHash(expectedIds)) {
        fail('analysis executions are not the exact authenticated selected member set');
    }
    const stages = expectedIds.map(paperId => {
        const item = byPaper.get(paperId); const staged = item.staged || loadStage({ analysisRoot, executionId: item.executionId,
            tagCatalogPath, stagingRoot, planHandle, sourceRoot, trustEvidence }, dependencies);
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
        authors: structuredClone(item.manifest.authors),
        // Conference pages are isolated to the official proceedings identity.
        // Related arXiv links can still exist in the sealed Reader evidence,
        // but must not leak into the conference aggregate's public surface.
        resources: structuredClone(item.manifest.resources).filter(resource => !isArxivResource(resource)),
        officialRecordUrl: item.manifest.publication.recordUrl, officialPdfUrl: item.manifest.publication.pdfUrl,
        pagePath: item.manifest.pagePath, url: item.manifest.primaryUrl,
        taxonomyAssignmentSha256: item.manifest.taxonomy.assignmentSha256,
        labels: item.manifest.taxonomy.concepts.map(concept => concept.preferredLabel.zh),
        pageContentSha256: item.manifest.contentSha256, pageManifestSha256: item.manifest.manifestSha256,
        pageManifestFileSha256: item.manifestFileSha256, assignmentFileSha256: item.assignmentFileSha256 }))
        .sort((left, right) => right.score - left.score || left.paperId.localeCompare(right.paperId))
        .map((item, index) => ({ rank: index + 1, ...item }));
    const aggregateTagMetadata = members.length ? stages[0].manifest.taxonomy : null;
    if (!aggregateTagMetadata || stages.some(item => item.manifest.taxonomy.registrySha256 !== tagCatalog.registrySha256
        || item.manifest.taxonomy.registryVersion !== aggregateTagMetadata.registryVersion
        || item.manifest.taxonomy.selectionContract !== aggregateTagMetadata.selectionContract
        || item.manifest.taxonomy.flatCompatContract !== aggregateTagMetadata.flatCompatContract)) fail('aggregate taxonomy metadata is missing or mixed');
    // 混合防线（同一 registrySha256）成立之后才允许把成员 conceptIds 折成
    // 多级树：directCount = 成员页面直接标记该概念的篇数，subtreeCount = 该
    // 概念及其全部后代按成员去重的篇数（与检索的祖先召回语义一致）。
    const hierarchy = aggregateHierarchy(tagCatalog,
        stages.map(item => item.manifest.taxonomy.conceptIds));
    const directions = [...members.reduce((counts, item) => counts.set(item.primaryTask,
        (counts.get(item.primaryTask) || 0) + 1), new Map()).entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
    // The aggregate only counts primary tasks as directions, but it must still
    // publish the {id, facet, label} concept records behind those counts so the
    // paper library search does not silently treat an aggregate page as a
    // taxonomy-free legacy page.  The projection is rebuilt from the exact
    // staged single-page taxonomies (same registry/selection already checked
    // above), never from the rendered labels alone.
    const taskConceptByLabel = new Map();
    for (const stage of stages) {
        const projection = stage.manifest.taxonomy;
        const concept = projection.concepts.find(item => item.id === projection.primaryTaskId);
        if (!concept || concept.facet !== 'task') fail('aggregate primary task concept projection is incomplete');
        // Keys are sorted to match the single-page frontmatter JSON spelling.
        const record = { facet: concept.facet, id: concept.id, label: concept.preferredLabel.zh };
        const known = taskConceptByLabel.get(record.label);
        if (known && known.id !== record.id) fail('aggregate primary task label maps to multiple taxonomy concepts');
        taskConceptByLabel.set(record.label, record);
    }
    const directionConcepts = directions.map(([label]) => {
        const concept = taskConceptByLabel.get(label);
        if (!concept) fail(`aggregate direction lacks a staged primary task concept: ${label}`);
        return concept;
    });
    const aggregateTags = [...new Set(members.flatMap(item => item.labels))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const aggregateDate = members.map(item => item.date).sort().at(-1);
    const lines = ['---', `title: "${conferenceId} 论文深度解读"`, `date: ${aggregateDate}`, 'draft: false', 'paper_digest_pipeline_owned: true',
        `tags: ${JSON.stringify(aggregateTags)}`, `categories: ${JSON.stringify([`${conferenceId} 论文`])}`,
        `description: "共收录 ${members.length} 篇 ${conferenceId} 会议论文的 Reader 深度解读"`,
        'paper_digest_page_type: index', `paper_digest_reader_quality: "${READER_FACING_CONTRACT}"`,
        `paper_digest_taxonomy_contract: "${aggregateTagMetadata.flatCompatContract}"`,
        `paper_digest_taxonomy_selection_contract: "${aggregateTagMetadata.selectionContract}"`,
        `paper_digest_taxonomy_registry_version: "${aggregateTagMetadata.registryVersion}"`,
        `paper_digest_taxonomy_registry_sha256: "${tagCatalog.registrySha256}"`,
        `paper_digest_taxonomy_concepts: ${JSON.stringify(directionConcepts)}`,
        'paper_digest_taxonomy_scope: "aggregate-primary-task-counts"', '---', '', `# ${conferenceId} 论文深度解读`, '',
        `本汇总收录 authenticated plan 选择集内全部 ${members.length} 篇已完成分析、重标和单篇 staging 的论文。`, '',
        '🏷️ 标签说明：本期使用新版受控 taxonomy；热门方向只统计主任务。', '',
        '## ⚡ 今日概览', '', `✅ authenticated plan 入选 ${members.length} 篇 → 🔬 深度分析、Reader 与页面投影完成`, '',
        '### 🏷️ 热门方向', '', '| 方向（仅主任务） | 数量 |', '|---|---:|'];
    for (const [label, count] of directions) lines.push(`| #${md(label)} | ${count} 篇 |`);
    // 热门方向表之后给出同一 registry 的多级下钻统计；排版保持与现有表格
    // 一致的中文克制风格（分面小节 + 缩进层级列表 + 可点开的 /tags/ 链接）。
    lines.push('', ...hierarchyLines(hierarchy));
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
    const markdown = repairFormulaDelimiters(repairDollarMath(lines.join('\n')));
    const selection = stages.map(item => ({ executionId: item.manifest.analysisExecutionId, paperId: item.manifest.paperId,
        analysisSha256: item.manifest.analysisSha256, completionReceiptSha256: item.manifest.completionReceiptSha256,
        sourceSnapshotSha256: item.manifest.sourceSnapshotSha256, pageManifestSha256: item.manifest.manifestSha256,
        pageManifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const selectionSetSha256 = stableHash(selection);
    const aggregateImplementationSha256 = fingerprint(dependencies).implementationSha256;
    const aggregateId = stableHash({ planProofSha256: authenticated.proof.proofSha256,
        registrySha256: tagCatalog.registrySha256, selectionSetSha256, aggregateImplementationSha256 }).slice(0, 32);
    const body = { contract: AGGREGATE_CONTRACT, version: VERSION, status: 'complete', aggregateId, conferenceId, date: aggregateDate,
        plan: authenticated.proof, readerQuality: READER_FACING_CONTRACT,
        taxonomy: { contract: aggregateTagMetadata.flatCompatContract, selectionContract: aggregateTagMetadata.selectionContract,
            registryVersion: aggregateTagMetadata.registryVersion, registrySha256: tagCatalog.registrySha256,
            scope: 'aggregate-primary-task-counts' },
        primaryTaskCounts: directions.map(([label, count]) => ({ label, count })),
        // 兼容：primaryTaskCounts / 标签 头保持原样，多级统计只新增字段。
        taxonomyHierarchy: hierarchy,
        registrySha256: tagCatalog.registrySha256, selection, selectionSetSha256, members,
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

module.exports = { CONTRACT, AGGREGATE_CONTRACT, ASSIGNMENT_CONTRACT, PROJECTION_CONTRACT, HIERARCHY_CONTRACT,
    VERSION, stableHash, planProof,
    loadCompleted, getConsistentPublicationFields, buildAssignment, safeStem, render, implementationFingerprint, fingerprint, buildFormulaEvidenceRecord,
    repairFormulaDelimiters, repairCurrencyDollars, repairTechnicalNotationAsterisks,
    repairStatisticalSignificanceStars, repairUnpairedMarkdownStars, repairDollarMath,
    stagePaper, loadStage, loadPreservedStage, aggregateConference, aggregateHierarchy, hierarchyLines, tagHref,
    repairConferenceImageUrls, repairCaptionQuotedGlossLinks, repairPreservedPage };

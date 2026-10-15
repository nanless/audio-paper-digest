'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const deep = require('../scripts/deep-analyzer');
const context = require('../scripts/lib/conference-analysis-context');
const repair = require('../scripts/lib/reader-repair');

test('会议原resolved完整输出冷核不写记录，父稿/活动失败/坏档案不能授完成', async t => {
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-resolved-proof-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const executionId = '11111111-1111-4111-8111-111111111111';
    const executionDir = path.join(folder, executionId); fs.mkdirSync(executionDir);
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const draft = sample.draft;
    draft.formulaBindings = [];
    draft.sections[4].body = draft.sections[4].body.replace('\n\n[[FORMULA_1]]', '');
    const text = sample.sourceDetails.text;
    const artifactBody = { version: 1, sourceKind: 'conference_pdf',
        parserVersion: 'conference-pdf-structure-v2-visual-only-math-tables',
        tables: [], formulas: [], figures: [], flattenedTextSha256: repair.shaText(text) };
    const artifacts = { ...artifactBody, payloadSha256: deep.stableFingerprint(artifactBody) };
    const id = 'conference:interspeech:2026:conference-paper-id:fixture';
    const source = { source: 'conference_pdf_text', sourceId: id, text, structuredArtifacts: artifacts,
        conferenceCapabilities: { fullText: 'full', tables: 'unavailable', formulas: 'unavailable', figures: 'available' } };
    const scope = { executionId, executionDir, paperId: id, sourceDetails: source, readerRetryEpoch: 1 };
    const run = callback => context.withConferenceAnalysisSource(scope, callback);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), { arxivId: id, requiredVersion: 3,
        requireIntegratedTables: true, minimumIntegratedTables: 0, availableFigureOrdinals: [],
        requireSourceBindings: true, allowDeterministicQuoteRepair: true, sourceText: text, structuredArtifacts: artifacts });
    const rendered = deep.injectApiReaderFigures(parsed, artifacts, id);
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: repair.shaText(text), resources: [] };
    const resources = { ...body, identitySha256: deep.stableFingerprint(body) };
    const evidence = deep.buildApiReaderEvidenceContext('', text, artifacts, id, null, resources);
    const paper = { id, source: 'conference', sourceSha256: repair.shaText(text), analysis: 'paid main',
        title: 'Reader fixture', apiReaderResources: resources, apiReaderArticle: rendered.article,
        apiReaderPlan: rendered.plan, apiReaderPlanSha256: deep.stableFingerprint(rendered.plan), apiReaderFigures: [] };
    const { identity } = await run(() => deep.prepareApiReaderRetryIdentity(paper, paper.analysis, evidence,
        { sourceText: text, structuredArtifacts: artifacts, readerResources: resources }));
    const stage = { status: 'complete', contentMode: 'reader-source-only-v1', attempts: 1, fullAttempts: 1,
        transportFailures: 0, evidenceSha256: repair.shaText(evidence), model: identity.model.model,
        protocol: identity.model.protocol, temperature: identity.model.temperature, maxTokens: identity.model.maxTokens,
        maxResponseBytes: identity.model.maxResponseBytes, promptTemplateSha256: identity.promptSha256,
        repairPromptTemplateSha256: identity.repairPromptSha256, repairMaxTokens: identity.repairMaxTokens,
        repairTemperature: identity.repairTemperature, sourceBindingsSourceTextSha256: identity.sourceSha256,
        structuredArtifactsSha256: artifacts.payloadSha256, imageEvidenceSha256: repair.hashDraft([]), imageEvidenceCount: 0,
        articleSha256: repair.shaText(rendered.article), planSha256: paper.apiReaderPlanSha256 };
    paper.analysisManifest = { stages: { apiReaderArticle: stage } };
    const parentPaper = { ...paper, analysisManifest: { stages: { apiReaderArticle: { status: 'complete', fingerprint: 'old' } } } };
    const options = { executionId, executionDir, parentPaper, revision: { executionId, paperId: id } };
    assert.equal(await run(() => deep.inspectSavedConferenceReaderCompletion(paper, options)), null);
    const directory = path.join(executionDir, 'reader-attempts');
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft), issues: [], attempts: 1,
        fullAttempts: 1, noProgress: 0, failureSignature: '', transportFailures: 0, imageEvidence: [] };
    repair.saveFailedCandidate(directory, identity, payload);
    const archived = repair.retireFailedCandidate(directory, identity);
    const original = fs.readFileSync(archived);
    const proof = await run(() => deep.inspectSavedConferenceReaderCompletion(paper, options));
    assert.ok(proof); assert.equal(proof.articleSha256, repair.shaText(rendered.article));
    assert.deepEqual(fs.readFileSync(archived), original);
    assert.equal(await run(() => deep.inspectSavedConferenceReaderCompletion(paper, { ...options, parentPaper: paper })), null);
    repair.saveFailedCandidate(directory, identity, payload);
    assert.equal(await run(() => deep.inspectSavedConferenceReaderCompletion(paper, options)), null);
    fs.unlinkSync(path.join(directory, repair.hashDraft(identity) + '.json'));
    const altered = JSON.parse(original); altered.payload.draft.sections[0].body += 'changed';
    fs.writeFileSync(archived, JSON.stringify(altered), { mode: 0o600 });
    await assert.rejects(run(() => deep.inspectSavedConferenceReaderCompletion(paper, options)), /档案名称、版本或内容证明不一致/);
    await assert.rejects(run(() => deep.inspectSavedConferenceReaderCompletion(paper,
        { ...options, executionId: '22222222-2222-4222-8222-222222222222' })), /同一认证子运行/);
});

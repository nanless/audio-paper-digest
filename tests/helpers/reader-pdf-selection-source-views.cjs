'use strict';
// Test-only source component views, never a completion record or paid request.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const writeResult = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const evidencePath = process.env.PD_READER_PDF_SELECTION_REAL_EVIDENCE;
const evidenceSha = process.env.PD_READER_PDF_SELECTION_REAL_EVIDENCE_SHA256;
const deny = () => { throw new Error('PDF source regression forbids network and models'); };
for (const name of ['node:net', 'node:tls']) {
    const api = require(name); api.connect = deny; api.createConnection = deny;
    if (api.Socket) api.Socket.prototype.connect = deny;
}
for (const name of ['node:http', 'node:https', 'node:http2']) {
    const api = require(name); api.request = deny; api.get = deny; api.connect = deny;
}
globalThis.fetch = deny;
console.log = (...items) => process.stderr.write(items.join(' ') + '\n');
require('../../scripts/utils').requestLlmJson = deny;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const evidence = fs.readFileSync(evidencePath);
assert.equal(sha(evidence), evidenceSha);
const snapshot = JSON.parse(evidence), candidate = fs.readFileSync(snapshot.candidateFile);
assert.equal(sha(candidate), snapshot.candidateSha256);
const draft = JSON.parse(candidate).payload.draft, runDir = path.dirname(path.dirname(snapshot.candidateFile));
const daily = require('../../scripts/lib/daily-fresh-source-plan');
const fresh = require('../../scripts/lib/fresh-analysis-context');
const deep = require('../../scripts/deep-analyzer');
const protocol = require('../../scripts/lib/reader-stage-protocols');
const identity = require('../../scripts/lib/reader-identity-format');
const authors = require('../../scripts/lib/reader-author-parser');
const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
const plan = daily.readDailyFreshSourcePlan(daily.dailyFreshSourceReference({ ...run, runDir }));
const paper = structuredClone(snapshot.paperInput), source = daily.readDailyFreshSource(plan, paper);
const sourceDir = path.join(runDir, 'sources', paper.arxivId.replace(/v\d+$/, ''), 'generation-000001');
const sourceHashes = () => Object.fromEntries(fs.readdirSync(sourceDir).map(name => [name, sha(fs.readFileSync(path.join(sourceDir, name)))]));
const before = sourceHashes();
const output = daily.withDailyFreshAnalysisContext(plan, () => fresh.withFreshPaperContext(paper, () => {
    const descriptor = source.freshSourceDescriptor;
    const bundle = { rootDir: path.join(runDir, 'sources'),
        arxivId: descriptor.paperId, generation: descriptor.sourceGeneration,
        sourceManifestSha256: descriptor.sourceManifestSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256 };
    const actualAuthors = fresh.withVerifiedBundleReaderAuthorFiles(bundle, details => authors.resolveVerifiedReaderAuthors(paper, details));
    return [false, true].map(compileCurrent => {
        const result = deep.parseApiReaderArticleResult(JSON.stringify(draft), {
            arxivId: paper.arxivId, availableFigureOrdinals: [1, 2], requireIntegratedTables: true,
            minimumIntegratedTables: 2, requireSourceBindings: true, compileCurrent,
            allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
            structuredArtifacts: source.structuredArtifacts, sourceText: source.text,
            verifiedResourceIdentity: paper.apiReaderResources, enforceResourceAvailabilityClaims: true
        });
        const view = structuredClone(paper), manifest = view.analysisManifest, stage = manifest.stages.apiReaderArticle;
        view.apiReaderArticle = result.article; view.apiReaderPlan = result.plan; view.apiReaderAuthors = actualAuthors;
        manifest.contracts.apiReaderArticle = result.plan.contract;
        manifest.contracts.apiReaderSourceBindings = result.plan.sourceBindingsContract;
        manifest.contracts.apiReaderAuthorIdentity = actualAuthors.identity.contract;
        stage.readerAuthorIdentitySha256 = actualAuthors.identitySha256;
        stage.readerAuthorsSha256 = daily.stableHash(actualAuthors);
        identity.refreshAuthorFields(stage, actualAuthors, view.apiReaderResources);
        Object.assign(stage, { sourceBindingsSha256: result.plan.sourceBindingsSha256,
            sourceBindingsSourceTextSha256: view.sourceSha256,
            structuredArtifactsSha256: source.structuredArtifacts.payloadSha256,
            tableBindingCount: result.plan.tableBindings.length, formulaBindingCount: result.plan.formulaBindings.length });
        if (compileCurrent) Object.assign(stage, protocol.stageFields(result.plan, result.qualityMetrics),
            require('../../scripts/lib/reader-content-mode').fields('source-only'));
        else stage.sourceBindingsContractVersion = result.plan.sourceBindingsContract;
        assert.equal(fresh.withVerifiedBundleReaderAuthorFiles(bundle,
            details => authors.readerAuthorIdentityMatchesSource(view, details)), true);
        return view;
    });
}));
assert.equal(sha(fs.readFileSync(snapshot.candidateFile)), snapshot.candidateSha256);
assert.deepEqual(sourceHashes(), before);
writeResult(JSON.stringify(output));

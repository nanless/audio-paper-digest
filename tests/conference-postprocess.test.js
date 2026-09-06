'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/conference-postprocess.js');
const taxonomyApi = require('../scripts/lib/paper-taxonomy.js');
const cli = require('../scripts/conference-postprocess.js');
const executionCli = require('../scripts/conference-execution.js');
const adapter = require('../scripts/lib/conference-analysis-adapter.js');
const pageApi = require('../scripts/lib/historical-page-staging.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');

const TAXONOMY = path.resolve(__dirname, '../config/paper-taxonomy.json');
const WEAK = { fullText: 'weak', tables: 'unavailable', formulas: 'unavailable', figures: 'unavailable' };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function canonical(index) {
    return `## 评分\n${8 + index / 10}/10\n\n## 机器摘要\nprimary_task_tag: #语音识别\nprimary_method_tag: #Transformer\n\n`
        + `## 标签\n#语音识别 #Transformer\n\n## 核心摘要\n只来自会议 canonical 的摘要 ${index}。`;
}

function completed(executionId, index = 0) {
    const paperId = `conference:icassp:2026:icassp-arnumber:${100 + index}`;
    const analysis = canonical(index); const parsed = require('../scripts/utils.js').parseAnalysis(analysis);
    const article = `会议 Reader 全新正文 ${index}。`; const articleSha = sha256(article);
    const plan = { contract: 'beginner-researcher-v3', readerTitle: `会议解读 ${index}`, formulaBindings: [] };
    const planSha = api.stableHash(plan);
    const paper = { id: paperId, conferencePaperId: paperId, title: `会议论文 ${index}`, authors: ['作者'],
        abstract: '摘要', source: 'conference', conference: { id: 'icassp-2026', year: 2026 },
        externalId: { scheme: 'icassp-arnumber', value: String(100 + index) }, analysis, parsed,
        apiReaderArticle: article, apiReaderArticleSha256: articleSha, apiReaderPlan: plan, apiReaderPlanSha256: planSha,
        apiReaderFigures: [], analysisManifest: { contracts: { apiReaderArticle: 'beginner-researcher-v3' },
            stages: { apiReaderArticle: { status: 'complete', articleSha256: articleSha, planSha256: planSha,
                figureCount: 0, formulaBindingCount: 0 } } } };
    const analysisRecord = { status: 'complete', papers: [paper] };
    const analysisFileSha256 = sha256(JSON.stringify(analysisRecord)); const completedAt = '2026-09-07T00:00:00.000Z';
    const receiptBody = { contract: 'conference-analysis-completion-receipt-v1', version: 1, executionId,
        paperId, sourceSnapshotSha256: 'b'.repeat(64), analysisSha256: analysisFileSha256, completedAt };
    const completionReceipt = { ...receiptBody, receiptSha256: api.stableHash(receiptBody) };
    return { planKey: 'a', analysis: analysisRecord, analysisFileSha256, run: { status: 'complete', executionId, paperId,
        conference: { id: 'icassp-2026', year: 2026 }, capabilities: WEAK, sourceSnapshotSha256: 'b'.repeat(64),
        analysisSha256: analysisFileSha256, completionReceipt }, source: { sourceDetails: { structuredArtifacts: {
            tables: [], formulas: [], figures: [] } } } };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-postprocess-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runs = new Map(); const one = '11111111-1111-4111-8111-111111111111';
    const two = '22222222-2222-4222-8222-222222222222';
    runs.set(one, completed(one, 1)); runs.set(two, completed(two, 2));
    const paperIds = [...runs.values()].map(item => item.run.paperId).sort(); const selectedMemberSetSha256 = api.stableHash(paperIds);
    const run = { conferenceId: 'icassp-2026', identitySha256: '1'.repeat(64), stateSha256: '2'.repeat(64),
        membershipSha256: '3'.repeat(64), filterPolicySha256: '4'.repeat(64), selectionReceiptSha256: '5'.repeat(64),
        selectedMemberSetSha256, members: paperIds.map(paperId => ({ paperId })) };
    const receipt = { receiptSha256: '6'.repeat(64), filter: { filterPolicySha256: run.filterPolicySha256,
        selectionReceiptSha256: run.selectionReceiptSha256, selectedMemberSetSha256 } };
    const planHandle = { key: 'a' }; const planAuthority = { snapshot: { run, receipt,
        receiptFileSha256: '7'.repeat(64), runFileSha256: '8'.repeat(64) } };
    const dependencies = { loadConferenceAnalysis: ({ executionId }) => structuredClone(runs.get(executionId)),
        planHandleAuthority: handle => { if (handle?.key !== 'a') throw new Error('wrong plan'); return structuredClone(planAuthority); },
        verifyPlanAuthority: (loaded, handle) => { if (loaded.planKey !== handle?.key) throw new Error('cross-plan'); return true; },
        isSuccessful: () => true, render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\n${packet.paper.parsed.summary}\n`, assets: [] }) };
    return { root, one, two, runs, planHandle, sourceRoot: path.join(root, 'source'), dependencies };
}

test('generic conference stage binds sealed completion, identity, taxonomy and registry-isolated bytes', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    const result = api.stagePaper({ analysisRoot: path.join(f.root, 'analysis'), executionId: f.one,
        taxonomyFile: TAXONOMY, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    assert.equal(result.status, 'staged'); assert.equal(result.manifest.paperId, f.runs.get(f.one).run.paperId);
    assert.equal(result.manifest.identity.kind, 'conference'); assert.equal(result.manifest.identity.arxivId, null);
    assert.doesNotMatch(result.markdown, /arxiv/i); assert.deepEqual(result.manifest.capabilities, WEAK);
    const registry = taxonomyApi.loadTaxonomy(TAXONOMY);
    const replayed = api.loadStage({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies);
    assert.equal(replayed.manifest.manifestSha256, result.manifest.manifestSha256);
    assert.ok(fs.existsSync(path.join(stagingRoot, f.one, registry.registrySha256,
        result.manifest.implementation.implementationSha256, 'page.md')));
    assert.equal(api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies).manifest.manifestSha256, result.manifest.manifestSha256);
});

test('completion drift, arXiv renderer leakage and weak assets fail closed', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    f.runs.get(f.one).run.completionReceipt.analysisSha256 = 'c'.repeat(64);
    assert.throws(() => api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /sealed conference analysis/);
    f.runs.set(f.one, completed(f.one, 1));
    assert.throws(() => api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, { ...f.dependencies, render: () => ({ markdown: 'https://arxiv.org/abs/1234.5678', assets: [] }) }), /arXiv identity/);
    assert.throws(() => api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, { ...f.dependencies, render: () => ({ markdown: 'generic', assets: [{ path: 'x' }] }) }), /weak assets/);
});

test('production Node stage invokes the generic Python renderer without an arXiv identity', t => {
    const f = fixture(t); const dependencies = { ...f.dependencies }; delete dependencies.render;
    const stagingRoot = path.join(f.root, 'dry-staging');
    const result = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, dependencies);
    assert.match(result.markdown, /paper_digest_paper_id: "conference:icassp:2026:icassp-arnumber:101"/);
    assert.match(result.markdown, /表格、公式与 Figure 均不可用/);
    assert.doesNotMatch(result.markdown, /paper_digest_arxiv_id|arxiv\.org/i);
    assert.equal(fs.existsSync(stagingRoot), false);
});

test('aggregate replays every selected stage and emits only when the full explicit selection is complete', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging'); const aggregateRoot = path.join(f.root, 'aggregate');
    f.runs.get(f.one).analysis.papers[0].title = 'Bad [link](https://evil.invalid) # heading';
    for (const executionId of [f.one, f.two]) api.stagePaper({ analysisRoot: 'ignored', executionId,
        taxonomyFile: TAXONOMY, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    const result = api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one, f.two], taxonomyFile: TAXONOMY,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    assert.equal(result.manifest.members.length, 2); assert.equal(result.manifest.members[0].paperId, f.runs.get(f.two).run.paperId);
    assert.doesNotMatch(result.manifest.markdown, /\]\(https:\/\/evil\.invalid\)|\n# heading/);
    assert.doesNotMatch(result.manifest.markdown, /旧会议汇总正文/);
    assert.ok(fs.existsSync(path.join(aggregateRoot, 'icassp-2026', result.manifest.aggregateId, 'manifest.json')));
    const secondStage = api.loadStage({ analysisRoot: 'ignored', executionId: f.two, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies);
    fs.appendFileSync(path.join(secondStage.directory, 'page.md'), 'drift');
    assert.throws(() => api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one, f.two], taxonomyFile: TAXONOMY,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /deterministic projection/);
});

test('aggregate rejects a selected-member subset and executions from another authenticated plan', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging'); const aggregateRoot = path.join(f.root, 'aggregate');
    for (const executionId of [f.one, f.two]) api.stagePaper({ analysisRoot: 'ignored', executionId,
        taxonomyFile: TAXONOMY, stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    assert.throws(() => api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one], taxonomyFile: TAXONOMY,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /complete authenticated selected member set/);
    f.runs.get(f.two).planKey = 'b';
    assert.throws(() => api.aggregateConference({ analysisRoot: 'ignored', executionIds: [f.one, f.two], taxonomyFile: TAXONOMY,
        stagingRoot, aggregateRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /cross-plan/);
});

test('loadStage re-renders current completion and rejects re-signed metadata or extra files', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    const staged = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, f.dependencies);
    const registry = taxonomyApi.loadTaxonomy(TAXONOMY); const directory = path.join(stagingRoot, f.one,
        registry.registrySha256, staged.manifest.implementation.implementationSha256);
    const manifestFile = path.join(directory, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.title = 'attacker title'; const body = structuredClone(manifest); delete body.manifestSha256;
    manifest.manifestSha256 = api.stableHash(body); fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => api.loadStage({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /deterministic projection/);
    fs.writeFileSync(manifestFile, `${JSON.stringify(staged.manifest, null, 2)}\n`); fs.writeFileSync(path.join(directory, 'extra.json'), '{}');
    assert.throws(() => api.loadStage({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, f.dependencies), /unexpected recovery content/);
});

test('renderer/projection upgrade receives a new immutable stage identity', t => {
    const f = fixture(t); const stagingRoot = path.join(f.root, 'staging');
    const implementation = marker => { const body = { contract: api.PROJECTION_CONTRACT, version: 1,
        nodeSourceSha256: marker.repeat(64), rendererSourceSha256: 'b'.repeat(64), publisherSourceSha256: 'c'.repeat(64),
        loaderSourceSha256: 'd'.repeat(64), parserSourceSha256: 'e'.repeat(64), taxonomySourceSha256: 'f'.repeat(64),
        identitySourceSha256: '1'.repeat(64) };
        return { ...body, implementationSha256: api.stableHash(body) }; };
    const firstDeps = { ...f.dependencies, implementationFingerprint: () => implementation('a') };
    const secondDeps = { ...f.dependencies, implementationFingerprint: () => implementation('d'),
        render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\nUPGRADED\n`, assets: [] }) };
    const first = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, firstDeps);
    const second = api.stagePaper({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot, apply: true }, secondDeps);
    assert.notEqual(first.manifest.implementation.implementationSha256, second.manifest.implementation.implementationSha256);
    assert.notEqual(api.loadStage({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, firstDeps).directory,
    api.loadStage({ analysisRoot: 'ignored', executionId: f.one, taxonomyFile: TAXONOMY,
        stagingRoot, planHandle: f.planHandle, sourceRoot: f.sourceRoot }, secondDeps).directory);
});

test('real plan authority, source replay and sealed analysis can stage one conference paper', async t => {
    const fixture = productionPlanFixture(t); const executionId = '99999999-9999-4999-8999-999999999999';
    const analysisRoot = path.join(fixture.root, 'analysis'); const stagingRoot = path.join(fixture.root, 'page-staging');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId, now: '2026-09-07T00:00:00.000Z' });
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot, executionId }); const generated = completed(executionId, 0).analysis.papers[0];
    const paper = { ...loaded.analysis.papers[0], analysis: generated.analysis, parsed: generated.parsed,
        apiReaderArticle: generated.apiReaderArticle, apiReaderArticleSha256: generated.apiReaderArticleSha256,
        apiReaderPlan: generated.apiReaderPlan, apiReaderPlanSha256: generated.apiReaderPlanSha256,
        apiReaderFigures: [], analysisManifest: generated.analysisManifest };
    const analysis = { ...loaded.analysis, status: 'complete', completedAt: '2026-09-07T01:00:00.000Z', papers: [paper] };
    fs.writeFileSync(path.join(analysisRoot, executionId, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId }));
    const result = api.stagePaper({ analysisRoot, executionId, taxonomyFile: TAXONOMY, stagingRoot,
        planHandle: fixture.planHandle, sourceRoot: fixture.sourceRoot, apply: true }, { isSuccessful: () => true,
        render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\nFRESH`, assets: [] }) });
    assert.equal(result.manifest.paperId, fixture.paperId); assert.equal(result.status, 'staged');
    const aggregate = api.aggregateConference({ analysisRoot, executionIds: [executionId], taxonomyFile: TAXONOMY,
        stagingRoot, aggregateRoot: path.join(fixture.root, 'aggregates'), planHandle: fixture.planHandle,
        sourceRoot: fixture.sourceRoot, apply: true }, { isSuccessful: () => true,
        render: packet => ({ markdown: `---\npaper_digest_paper_id: "${packet.paper_id}"\n---\n\nFRESH`, assets: [] }) });
    assert.equal(aggregate.manifest.plan.selectedMemberSetSha256,
        api.stableHash([fixture.paperId])); assert.equal(aggregate.manifest.members.length, 1);
});

test('analysis loader rejects a re-signed source file whose actual SHA no longer matches run.json', t => {
    const fixture = productionPlanFixture(t); const executionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const analysisRoot = path.join(fixture.root, 'analysis');
    adapter.prepareConferenceAnalysis({ planHandle: fixture.planHandle, paperId: fixture.paperId,
        sourceRoot: fixture.sourceRoot, analysisRoot, executionId });
    const filename = path.join(analysisRoot, executionId, 'source.json'); const source = JSON.parse(fs.readFileSync(filename));
    source.sourceDetails.text += ' drift'; source.sourceDetails.structuredArtifacts.flattenedTextSha256 = sha256(source.sourceDetails.text);
    const artifacts = structuredClone(source.sourceDetails.structuredArtifacts); delete artifacts.payloadSha256;
    source.sourceDetails.structuredArtifacts.payloadSha256 = sha256(JSON.stringify(artifacts));
    const body = structuredClone(source); delete body.recordSha256; source.recordSha256 = api.stableHash(body);
    fs.writeFileSync(filename, `${JSON.stringify(source, null, 2)}\n`);
    assert.throws(() => adapter.loadConferenceAnalysis({ analysisRoot, executionId }), /evidence drifted/);
});

test('shared immutable staging writer removes its own short EIO file and retries safely', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-short-write-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const filename = path.join(root, 'page.md');
    let calls = 0; const io = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync,
        writeSync: (fd, buffer, offset, length, position) => {
            calls += 1; if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.min(3, length), position);
            const error = new Error('injected short-write EIO'); error.code = 'EIO'; throw error;
        } };
    assert.throws(() => pageApi.writeExact(filename, Buffer.from('complete bytes'), { io }), /EIO/);
    assert.equal(fs.existsSync(filename), false);
    assert.equal(pageApi.writeExact(filename, Buffer.from('complete bytes')), sha256('complete bytes'));
});

test('CLI requires full authority, configured roots and distinct UUID selections', () => {
    const authority = executionCli.AUTHORITY_FLAGS.flatMap(flag => [flag, flag === '--filter' ? '33333333-3333-4333-8333-333333333333' : 'proof.json']);
    const parsed = cli.parseArgs(['aggregate', '--dry-run', ...authority,
        '--analysis-runs', '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222']);
    assert.equal(parsed.executionIds.length, 2);
    assert.throws(() => cli.parseArgs(['paper', '--apply', '--analysis-run', '11111111-1111-4111-8111-111111111111']), /Use/);
    assert.throws(() => cli.configured({ conferenceAnalysisDir: 'relative' }), /configured absolute path/);
});

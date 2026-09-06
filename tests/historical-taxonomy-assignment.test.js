'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-taxonomy-assignment.js');
const cli = require('../scripts/historical-taxonomy-assignment.js');
const taxonomyApi = require('../scripts/lib/paper-taxonomy.js');
const { parseAnalysis } = require('../scripts/utils.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

const RUN_ID = '77777777-7777-4777-8777-777777777777';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function paper(id = '2609.03622', analysis = validAnalysisText()) {
    return { arxivId: id, paper_id: id, title: `Paper ${id}`, abstract: 'Source abstract', authors: ['Author'],
        categories: ['cs.SD'], analysis, parsed: parseAnalysis(analysis) };
}

function runFixture(t, papers = [paper()]) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-taxonomy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runDir = path.join(root, 'runs', RUN_ID); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const analysis = { version: 1, contract: 'fresh-rewrite-analysis-v1', runId: RUN_ID,
        batchDate: '2026-09-04', status: 'complete', generation: 1, papers };
    const bytes = Buffer.from(`${JSON.stringify(analysis, null, 2)}\n`);
    fs.writeFileSync(path.join(runDir, 'analysis.json'), bytes, { mode: 0o600 });
    const run = { runId: RUN_ID, status: 'complete', analysisSha256: sha(bytes),
        baseline: { contract: api.HISTORICAL_BASELINE_CONTRACT } };
    const dependencies = { loadRun: () => ({ run, analysis, runDir }), isSuccessfulAnalysisRecord: () => true };
    const handle = api.loadCompletedHistoricalAnalysisRun({ analysisRoot: path.join(root, 'runs'), runId: RUN_ID }, dependencies);
    return { root, runDir, run, analysis, dependencies, handle, output: path.join(root, 'assignments') };
}

function registry() {
    return taxonomyApi.loadTaxonomy(path.join(__dirname, '..', 'config', 'paper-taxonomy.json'));
}

test('completed historical canonical maps exact concepts, prunes task ancestors, and binds all source SHA values', t => {
    let analysis = validAnalysisText()
        .replace('primary_task_tag: #语音识别', 'primary_task_tag: #音视频语音识别')
        .replace('#语音识别 #Transformer #鲁棒性', '#语音识别 #音视频语音识别 #Transformer #鲁棒性')
        .replace('主任务标签: #语音识别', '主任务标签: #音视频语音识别')
        .replace('补充标签: #鲁棒性', '补充标签: #语音识别 #鲁棒性');
    const f = runFixture(t, [paper('2609.03622', analysis)]);
    const assignment = api.buildAssignments({ runHandle: f.handle, taxonomy: registry() })[0];
    assert.equal(assignment.status, 'assigned');
    assert.equal(assignment.primaryTaskId, 'task.av-asr');
    assert.equal(assignment.primaryMethodId, 'method.transformer');
    assert.ok(assignment.conceptIds.includes('task.av-asr'));
    assert.ok(!assignment.conceptIds.includes('task.asr'));
    assert.equal(assignment.analysisSha256, sha(analysis));
    assert.match(assignment.registrySha256, /^[a-f0-9]{64}$/);
    const body = structuredClone(assignment); delete body.assignmentSha256;
    assert.equal(assignment.assignmentSha256, api.stableHash(body));
});

test('unknown, cross-facet ambiguous, deprecated, or missing primary labels become blocked', t => {
    const unknownAnalysis = validAnalysisText().replaceAll('#鲁棒性', '#在线');
    const f = runFixture(t, [paper('2609.03622', unknownAnalysis)]);
    const unknown = api.buildAssignment({ runHandle: f.handle, paper: f.analysis.papers[0], taxonomy: registry() });
    assert.equal(unknown.status, 'blocked'); assert.ok(unknown.blockedReasons.some(reason => reason.includes('tag:unknown:#在线')));
    assert.deepEqual(unknown.conceptIds, []); assert.equal(unknown.primaryTaskId, null);

    const ambiguousRegistry = registry();
    ambiguousRegistry.concepts.find(item => item.id === 'task.asr').aliases.push('Transformer');
    const original = runFixture(t, [paper('2609.03623')]);
    const ambiguous = api.buildAssignment({ runHandle: original.handle, paper: original.analysis.papers[0], taxonomy: ambiguousRegistry });
    assert.equal(ambiguous.status, 'blocked'); assert.ok(ambiguous.blockedReasons.some(reason => reason.includes('tag:ambiguous:#Transformer')));
});

test('loader rejects incomplete, non-historical, drifted, or stale parsed analysis runs', t => {
    const f = runFixture(t);
    for (const mutate of [
        run => { run.status = 'analysis_partial'; },
        run => { run.baseline.contract = 'fresh-rewrite-baseline-v1'; },
        run => { run.analysisSha256 = 'f'.repeat(64); }
    ]) {
        const changed = structuredClone(f.run); mutate(changed);
        assert.throws(() => api.loadCompletedHistoricalAnalysisRun({ analysisRoot: path.join(f.root, 'runs'), runId: RUN_ID },
            { ...f.dependencies, loadRun: () => ({ run: changed, analysis: f.analysis, runDir: f.runDir }) }));
    }
    const stale = structuredClone(f.analysis.papers[0]); stale.parsed.tags = ['#在线'];
    assert.throws(() => api.buildAssignment({ runHandle: f.handle, paper: stale, taxonomy: registry() }), /exact canonical record/);
});

test('CLI supports batch and single dry-run with zero writes; apply writes private idempotent artifacts', t => {
    const f = runFixture(t, [paper('2609.03622'), paper('2609.03623')]);
    const config = { FILES: { freshRewriteRunsDir: path.join(f.root, 'runs'),
        taxonomyRegistry: path.join(__dirname, '..', 'config', 'paper-taxonomy.json'),
        historicalTaxonomyAssignmentDir: f.output } };
    const runtime = { config, dependencies: f.dependencies };
    const batch = cli.main(['assign', '--dry-run', '--analysis-run', RUN_ID], runtime);
    assert.equal(batch.mode, 'batch'); assert.equal(batch.total, 2); assert.equal(fs.existsSync(f.output), false);
    const single = cli.main(['assign', '--dry-run', '--analysis-run', RUN_ID,
        '--paper-id', 'arxiv:2609.03622'], runtime);
    assert.equal(single.mode, 'single'); assert.equal(single.total, 1); assert.equal(fs.existsSync(f.output), false);
    const applied = cli.main(['assign', '--apply', '--analysis-run', RUN_ID,
        '--paper-id', 'arxiv:2609.03622'], runtime);
    assert.equal(applied.outputs.length, 1);
    assert.equal(fs.statSync(f.output).mode & 0o777, 0o700);
    assert.equal(fs.statSync(applied.outputs[0].filename).mode & 0o777, 0o600);
    assert.equal(cli.main(['assign', '--apply', '--analysis-run', RUN_ID,
        '--paper-id', 'arxiv:2609.03622'], runtime).outputs[0].fileSha256, applied.outputs[0].fileSha256);
    assert.throws(() => cli.parseArgs(['assign', '--dry-run', '--analysis-run', RUN_ID,
        '--paper-id', '../escape']));
});

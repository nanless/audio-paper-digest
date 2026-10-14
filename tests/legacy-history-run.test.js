'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fresh = require('../scripts/lib/fresh-rewrite-run.js');
const legacy = require('../scripts/lib/legacy-history-run.js');
const resume = require('../scripts/history-resume.js');

const RUN = '77777777-7777-4777-8777-777777777777';
const CROSSWALK = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'legacy-history-run-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const roots = Object.fromEntries(['freshRewriteRunsDir', 'historicalAnalysisSchedulerDir', 'historicalPostprocessSchedulerDir']
        .map(key => [key, path.join(root, key)]));
    for (const directory of Object.values(roots)) fs.mkdirSync(directory);
    const runDir = path.join(roots.freshRewriteRunsDir, RUN); fs.mkdirSync(runDir);
    const paper = fresh.metadataOnly({ arxivId: '2609.03622', title: 'Source title', abstract: 'Source metadata', authors: ['A'] });
    const bytes = Buffer.from('<feed>preserved captured metadata bytes</feed>');
    const metadata = { contract: 'official-arxiv-atom-metadata-v1', paperId: 'arxiv:2609.03622', sourceName: 'captured.atom.xml',
        fileSha256: fresh.sha256(bytes), recordSha256: fresh.stableHash(paper) };
    const inputs = { version: 1, contract: fresh.INPUT_CONTRACT, runId: RUN, date: '2026-09-04', papers: [paper] };
    const inputBytes = Buffer.from(JSON.stringify(inputs)); fs.writeFileSync(path.join(runDir, 'inputs.json'), inputBytes);
    const run = { version: 1, contract: fresh.RUN_CONTRACT, runId: RUN, date: inputs.date,
        paperIds: ['2609.03622'], paperSetSha256: fresh.stableHash(['2609.03622']), inputsSha256: fresh.sha256(inputBytes),
        baseline: { version: 1, contract: legacy.BASELINE_CONTRACT, paperId: metadata.paperId, metadata },
        sourceExpectations: { '2609.03622': { sourceSha256: 'b'.repeat(64), structuredArtifactsSha256: 'c'.repeat(64) } },
        metadataSources: { historicalRawMetadata: metadata }, status: 'analysis_partial' };
    run.identitySha256 = fresh.stableHash({ version: run.version, contract: run.contract, runId: run.runId, date: run.date,
        paperIds: run.paperIds, paperSetSha256: run.paperSetSha256, inputsSha256: run.inputsSha256,
        baseline: run.baseline, sourceExpectations: run.sourceExpectations, metadataSources: run.metadataSources });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run));
    const analysis = { version: 1, contract: fresh.ANALYSIS_CONTRACT, runId: RUN, batchDate: inputs.date,
        status: 'partial', papers: [{ ...paper, latestAnalysisError: 'preserved failure', attempts: 3, paidUsage: { tokens: 12345 } }] };
    fs.writeFileSync(path.join(runDir, 'analysis.json'), JSON.stringify(analysis));
    const metadataFile = path.join(runDir, 'metadata-2609.03622.atom.xml'); fs.writeFileSync(metadataFile, bytes);
    return { roots, runDir, metadataFile, config: { FILES: roots } };
}

test('保存的 metadata/complete SHA 守卫迁移后不写失败、费用或原始来源', t => {
    const f = fixture(t); const analysisFile = path.join(f.runDir, 'analysis.json'); const before = fs.readFileSync(analysisFile);
    const loaded = fresh.loadRun(RUN, { rootDir: f.roots.freshRewriteRunsDir });
    assert.equal(legacy.assertSavedLegacyRun(loaded).status, 'analysis_partial');
    assert.deepEqual(fs.readFileSync(analysisFile), before);
    const complete = structuredClone(loaded); complete.run.status = 'complete'; complete.analysis.status = 'complete';
    complete.run.analysisSha256 = '0'.repeat(64);
    assert.throws(() => legacy.assertSavedLegacyRun(complete), /正式分析文件 SHA/);
    const badProof = structuredClone(loaded); badProof.run.baseline.metadata.recordSha256 = '0'.repeat(64);
    assert.throws(() => legacy.assertSavedLegacyRun(badProof), /元数据 SHA/);
    fs.appendFileSync(f.metadataFile, 'tampered');
    assert.throws(() => legacy.assertSavedLegacyRun(loaded), /原封存 SHA/);
    assert.deepEqual(fs.readFileSync(analysisFile), before);
});

test('旧 scheduler/postprocess 只定位真实已有 run ID，重签坏记录或缺失运行不触发旧 writer', t => {
    const f = fixture(t); const item = { paperId: 'arxiv:2609.03622', runId: RUN, status: 'failed' };
    const scheduler = { contract: 'historical-arxiv-analysis-scheduler-v1', version: 1, crosswalkId: CROSSWALK,
        items: { [item.paperId]: item } };
    const filename = path.join(f.roots.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`);
    fs.writeFileSync(filename, JSON.stringify(scheduler)); const before = fs.readFileSync(filename);
    assert.equal(resume.parseArgs(['locate', '--scheduler', filename]).action, 'locate');
    const found = legacy.locateSavedSchedulerRuns({ filename, config: f.config });
    assert.deepEqual(found.runs, [{ paperId: item.paperId, runId: RUN, storedStatus: 'analysis_partial' }]);
    assert.deepEqual(fs.readFileSync(filename), before);
    const post = { contract: 'historical-postprocess-scheduler-v1', version: 1, crosswalkId: CROSSWALK,
        items: { [item.paperId]: { paperId: item.paperId, analysisRunId: RUN } }, daily: {}, generation: 1 };
    post.checkpointSha256 = fresh.stableHash(post);
    const postFile = path.join(f.roots.historicalPostprocessSchedulerDir, 'preserved.json');
    fs.writeFileSync(postFile, JSON.stringify(post));
    assert.equal(legacy.locateSavedSchedulerRuns({ filename: postFile, config: f.config }).runs[0].runId, RUN);
    post.checkpointSha256 = '0'.repeat(64); fs.writeFileSync(postFile, JSON.stringify(post));
    assert.throws(() => legacy.locateSavedSchedulerRuns({ filename: postFile, config: f.config }), /内容 SHA/);
    scheduler.items[item.paperId].runId = '88888888-8888-4888-8888-888888888888';
    fs.writeFileSync(filename, JSON.stringify(scheduler));
    const missing = legacy.locateSavedSchedulerRuns({ filename, config: f.config });
    assert.equal(missing.status, 'located_partial'); assert.equal(missing.runs.length, 0);
    assert.equal(missing.unavailable[0].code, 'ENOENT');
    assert.equal(fs.existsSync(path.join(f.roots.freshRewriteRunsDir, scheduler.items[item.paperId].runId)), false);
    assert.throws(() => legacy.locateSavedSchedulerRuns({ filename: path.join(f.runDir, 'run.json'), config: f.config }), /不属于当前项目/);
});

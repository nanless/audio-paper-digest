'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-postprocess-scheduler.js');
const cli = require('../scripts/historical-postprocess-scheduler.js');

const CROSSWALK = '11111111-1111-4111-8111-111111111111';
const REGISTRY = '9'.repeat(64); const DATE = '2026-04-19';
const RENDERER = '8'.repeat(64);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, secondStatus = 'complete') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-postprocess-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperIds = ['arxiv:2604.00001', 'arxiv:2604.00002'];
    const runIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const pages = paperIds.map((paperId, index) => ({ pageKey: `page:${String(index + 1).repeat(64)}`,
        pagePath: `content/posts/paper-${index}.md`, primaryUrl: `https://example.test/posts/paper-${index}/`,
        pageContentSha256: String(index + 4).repeat(64), cohortDate: DATE, scope: { type: 'daily', key: DATE } }));
    const crosswalk = { crosswalkId: CROSSWALK, source: { papers: pages }, assignments: {}, identityGroups: [] };
    for (let index = 0; index < paperIds.length; index += 1) {
        crosswalk.assignments[pages[index].pageKey] = { status: 'verified', sourceAuthority: { paperId: paperIds[index] } };
        crosswalk.identityGroups.push({ paperId: paperIds[index], pageKeys: [pages[index].pageKey] });
    }
    const files = { historicalAnalysisSchedulerDir: path.join(root, 'analysis-scheduler'),
        historicalPostprocessSchedulerDir: path.join(root, 'postprocess'), taxonomyRegistry: path.join(root, 'taxonomy.json'),
        pageSourceCrosswalkDir: path.join(root, 'crosswalk'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalTaxonomyAssignmentDir: path.join(root, 'assignments'), historicalPageStagingDir: path.join(root, 'staging'),
        historicalPageInventoryDir: path.join(root, 'inventory'), historicalDailyAggregateDir: path.join(root, 'aggregates') };
    fs.mkdirSync(files.historicalAnalysisSchedulerDir, { recursive: true });
    const items = Object.fromEntries(paperIds.map((paperId, index) => [paperId, { status: index ? secondStatus : 'complete',
        runId: runIds[index], analysisDate: DATE, cohortDates: [DATE], pageKeys: [pages[index].pageKey] }]));
    const scheduler = { contract: api.ANALYSIS_SCHEDULER_CONTRACT, version: 1, crosswalkId: CROSSWALK, items };
    fs.writeFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`), JSON.stringify(scheduler));
    let tick = 0; let active = 0; let maximumActive = 0; let assignmentWrites = 0;
    const stageCalls = []; const aggregateCalls = [];
    const updateLocked = (filename, updater) => {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        const current = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null;
        const next = updater(current); if (next === undefined) return current;
        fs.writeFileSync(filename, `${JSON.stringify(next, null, 2)}\n`); return next;
    };
    const deps = { files, now: () => `2026-09-07T00:00:${String(tick++).padStart(2, '0')}.000Z`,
        rendererImplementationSha256: () => RENDERER,
        updateLocked, loadTaxonomy: () => ({ registrySha256: REGISTRY }), readCrosswalk: () => crosswalk,
        recoverRun: () => ({ storageSealed: true, currentContractComplete: true }), loadAnalysisRun: ({ runId }) => ({ runId }),
        buildAssignments: ({ runHandle, paperId }) => [{ paperId, analysisRunId: runHandle.runId,
            registrySha256: REGISTRY, status: 'assigned', assignmentSha256: sha(paperId) }],
        writeAssignments: ({ assignments }) => { assignmentWrites += 1; return [{ paperId: assignments[0].paperId,
            fileSha256: sha(`file:${assignments[0].paperId}`) }]; },
        stagePages: async options => { active += 1; maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setImmediate(resolve)); active -= 1; stageCalls.push(options);
            return { status: 'staged', manifestSha256: sha(`manifest:${options.stagingRunId}`) }; },
        loadAggregateInputs: options => ({ options }),
        buildAggregates: ({ inputs, date }) => [{ date, manifestSha256: sha(`aggregate:${date}`), inputs }],
        aggregateRunIdFor: () => '66666666-6666-4666-8666-666666666666',
        writeAggregates: options => { aggregateCalls.push(options); return [{ fileSha256: sha('aggregate-file') }]; } };
    return { root, files, deps, crosswalk, paperIds, runIds, stageCalls, aggregateCalls,
        maximumActive: () => maximumActive, assignmentWrites: () => assignmentWrites };
}

test('sealed per-paper runs are assigned/staged concurrently and two runs aggregate one complete date', async t => {
    const f = fixture(t); const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 2 }, f.deps);
    assert.equal(result.status, 'complete'); assert.equal(result.processed.length, 2);
    assert.equal(f.stageCalls.length, 2); assert.equal(f.maximumActive(), 2);
    assert.equal(f.aggregateCalls.length, 1);
    assert.equal(f.aggregateCalls[0].aggregates[0].inputs.options.stagingRunIds.length, 2);
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpoint));
    assert.equal(checkpoint.checkpointSha256, api.sealCheckpoint({ ...checkpoint, checkpointSha256: undefined }).checkpointSha256);
    const firstSha = sha(fs.readFileSync(result.checkpoint));
    const repeated = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 3 }, f.deps);
    assert.equal(repeated.status, 'complete'); assert.equal(sha(fs.readFileSync(result.checkpoint)), firstSha);
    assert.equal(repeated.processed[0].stagingRunId, result.processed[0].stagingRunId);
    const changedOnlyVolatile = { ...JSON.parse(fs.readFileSync(path.join(f.files.historicalAnalysisSchedulerDir,
        `${CROSSWALK}.json`))).items[f.paperIds[0]], updatedAt: 'later', lastError: 'ignored while complete' };
    const rebound = { ...changedOnlyVolatile, paperId: f.paperIds[0],
        analysisSchedulerItemSha256: api.stableHash(api.analysisSchedulerItemBinding(f.paperIds[0], changedOnlyVolatile)) };
    assert.equal(api.deterministicStagingRunId(CROSSWALK, rebound, REGISTRY, RENDERER), result.processed[0].stagingRunId);
});

test('renderer implementation change creates a new staging run and checkpoint without reusing old proof', async t => {
    const f = fixture(t); const options = { apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 };
    const first = await api.runHistoricalPostprocess(options, f.deps);
    const firstCheckpoint = JSON.parse(fs.readFileSync(first.checkpoint));
    const oldRunId = first.processed[0].stagingRunId;
    const replacementRenderer = '7'.repeat(64);
    f.deps.rendererImplementationSha256 = () => replacementRenderer;
    const second = await api.runHistoricalPostprocess(options, f.deps);
    const secondCheckpoint = JSON.parse(fs.readFileSync(second.checkpoint));
    assert.notEqual(second.checkpoint, first.checkpoint);
    assert.notEqual(second.processed[0].stagingRunId, oldRunId);
    assert.equal(fs.existsSync(first.checkpoint), true);
    assert.equal(firstCheckpoint.items[f.paperIds[0]].rendererImplementationSha256, RENDERER);
    assert.equal(secondCheckpoint.items[f.paperIds[0]].rendererImplementationSha256, replacementRenderer);
    assert.throws(() => api.validateCheckpoint(firstCheckpoint, CROSSWALK, REGISTRY,
        replacementRenderer), /checkpoint identity\/schema drifted/);
    assert.doesNotThrow(() => api.validateCheckpoint(secondCheckpoint, CROSSWALK, REGISTRY,
        replacementRenderer));
    assert.equal(f.stageCalls.at(-1).rendererImplementationSha256, replacementRenderer);
});

test('checkpoint self-SHA survives the production JSON updater generation field', async t => {
    const f = fixture(t, 'pending'); f.deps.updateLocked = require('../scripts/analysis-engine.js').updateJsonFileLocked;
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpoint));
    assert.doesNotThrow(() => api.validateCheckpoint(checkpoint, CROSSWALK, REGISTRY, RENDERER));
    assert.ok(checkpoint.generation >= 2);
});

test('dry-run is zero-write and reports only sealed-complete scheduler candidates', async t => {
    const f = fixture(t, 'pending'); const result = await api.runHistoricalPostprocess({ apply: false,
        crosswalkId: CROSSWALK, date: null, limit: 'pilot', concurrency: 1 }, f.deps);
    assert.equal(result.status, 'dry-run'); assert.equal(result.completeAvailable, 1); assert.equal(result.selected.length, 1);
    assert.equal(fs.existsSync(f.files.historicalPostprocessSchedulerDir), false);
    assert.equal(f.stageCalls.length, 0); assert.equal(f.aggregateCalls.length, 0);
});

test('dry-run never advertises checkpoint-complete but unsealed analysis', async t => {
    const f = fixture(t, 'pending'); f.deps.recoverRun = () => ({ storageSealed: true, currentContractComplete: false });
    const result = await api.runHistoricalPostprocess({ apply: false, crosswalkId: CROSSWALK,
        date: null, limit: null, concurrency: 1 }, f.deps);
    assert.equal(result.checkpointComplete, 1); assert.equal(result.completeAvailable, 0);
    assert.equal(result.unsealed, 1); assert.deepEqual(result.selected, []);
});

test('a date remains blocked until every historical paper has completed single-page staging', async t => {
    const f = fixture(t, 'pending'); const result = await api.runHistoricalPostprocess({ apply: true,
        crosswalkId: CROSSWALK, date: DATE, limit: null, concurrency: 3 }, f.deps);
    assert.equal(result.status, 'partial'); assert.deepEqual(result.daily, [
        { date: DATE, status: 'blocked', rendererImplementationSha256: RENDERER,
            reason: 'not-all-date-papers-staged' }
    ]); assert.equal(f.aggregateCalls.length, 0);
});

test('unsealed analysis run is recorded failed and never reaches staging', async t => {
    const f = fixture(t, 'pending'); f.deps.recoverRun = () => ({ storageSealed: true, currentContractComplete: false });
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    assert.equal(result.processed[0].status, 'failed'); assert.equal(f.stageCalls.length, 0);
});

test('blocked deterministic taxonomy is preserved as an audit artifact but never staged', async t => {
    const f = fixture(t, 'pending'); const build = f.deps.buildAssignments;
    f.deps.buildAssignments = options => build(options).map(item => ({ ...item, status: 'blocked' }));
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    assert.equal(result.processed[0].status, 'failed'); assert.equal(f.assignmentWrites(), 1);
    assert.equal(f.stageCalls.length, 0); assert.match(result.processed[0].lastError, /taxonomy assignment is blocked/);
});

test('CLI validates mode/date/limit/concurrency and forwards dry-run', async () => {
    assert.equal(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--concurrency', '3']).concurrency, 3);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--concurrency', '4']), /Use/);
    const result = await cli.main(['--dry-run', '--crosswalk', CROSSWALK], { run: async options => ({ options }) });
    assert.equal(result.options.apply, false);
});

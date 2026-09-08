'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const control = require('../scripts/lib/historical-direct-control.js');
const cli = require('../scripts/historical-direct-control.js');
const aggregateApi = require('../scripts/lib/historical-direct-aggregate.js');
const runner = require('../scripts/lib/historical-direct-rewrite-runner.js');

function minimalPlan() {
    const body = { contract: 'historical-direct-rewrite-plan-v5', version: 5,
        catalogFileSha256: 'a'.repeat(64), inventory: { ledgerSha256: 'b'.repeat(64), pageSetSha256: 'c'.repeat(64) },
        conferenceProjectionArtifactSha256: 'd'.repeat(64), queue: [], queueSha256: control.stableHash([]),
        projectedPages: [], dailyPrimaryArxivBindings: [], dailyPrimaryArxivBindingSetSha256: control.stableHash([]),
        dailyIcmlPosterBindings: [], dailyIcmlPosterBindingSetSha256: control.stableHash([]),
        dailyIcmlPosterRoutableBindings: [], dailyIcmlPosterRoutableBindingSetSha256: control.stableHash([]),
        icmlPosterAuthoritySha256: null,
        unprojectedCatalogEntries: [], unprojectedCatalogEntrySetSha256: control.stableHash([]),
        projectedPageSetSha256: control.stableHash([]), uncoveredFrozenPaperPages: [],
        uncoveredFrozenPaperPageSetSha256: control.stableHash([]), paperPageCoverage: {
            frozenPaperPages: 0, projectedPaperPages: 0, uncoveredFrozenPaperPages: 0,
            coverageComplete: true, byScope: [], uncoveredByIdentityHintStatus: [] } };
    return { ...body, planSha256: control.stableHash(body) };
}

test('pause marker is immutable, resumable, and bound to plan/generation', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-control-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const plan = minimalPlan();
    const first = control.writePauseRequest({ registryRoot: root, plan, generation: 2,
        requestedAt: '2026-09-07T00:00:00.000Z' });
    assert.equal(first.status, 'pause-requested'); assert.equal(fs.statSync(first.pauseFile).mode & 0o777, 0o600);
    const recovered = control.writePauseRequest({ registryRoot: root, plan, generation: 2,
        requestedAt: '2026-09-07T00:01:00.000Z' });
    assert.equal(recovered.status, 'already-pause-requested');
    assert.equal(recovered.record.requestedAt, '2026-09-07T00:00:00.000Z');
    const resumed = control.resumeRewrite({ registryRoot: root, plan, generation: 2 });
    assert.equal(resumed.status, 'resumed'); assert.equal(fs.existsSync(first.pauseFile), false);
    assert.equal(control.resumeRewrite({ registryRoot: root, plan, generation: 2 }).status, 'already-running');
});

test('source pause uses an isolated plan-generation marker and resumes independently', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-source-control-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const plan = minimalPlan();
    const paused = control.writePauseRequest({ phase: 'source', sourceRoot: root, plan,
        requestedAt: '2026-09-07T00:00:00.000Z' });
    assert.equal(paused.phase, 'source'); assert.match(paused.pauseFile, /\.generation-000001\.source\.pause$/);
    assert.equal(control.resumeRewrite({ phase: 'source', sourceRoot: root, plan }).status, 'resumed');
});

test('source status checkpoint is immutable in shape and advances resumable conference progress', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-source-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const plan = minimalPlan();
    const created = control.loadOrCreateSourceStatus({ sourceRoot: root, plan, apply: true,
        now: '2026-09-07T00:00:00.000Z' });
    assert.deepEqual(control.sourceStatusCounts(created.status), { pending: 0, ready: 0, handoff: 0, failed: 0 });
    assert.equal(control.sourceSnapshot({ sourceRoot: root, plan }).conference.durableSchedulerProgressAvailable, true);
    assert.equal(control.normalizeSourceStatus(created.status, plan, 1).statusSha256, created.status.statusSha256);
    const tampered = structuredClone(created.status); tampered.planSha256 = 'f'.repeat(64);
    assert.throws(() => control.normalizeSourceStatus(tampered, plan, 1), /source status envelope/);
});

test('status counts a staged page with an old renderer as unfinished', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-renderer-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const item = { paperId: 'arxiv:2601.00001', runId: '11111111-1111-4111-8111-111111111111',
        route: { kind: 'arxiv-fresh-fetch' }, projectionSha256: 'd'.repeat(64) };
    const plan = { ...minimalPlan(), queue: [item] };
    const entry = { paperId: item.paperId, runId: item.runId, route: item.route.kind,
        projectionSha256: item.projectionSha256, status: 'staged', source: {}, analysis: {},
        staging: { pageStaging: { rendererImplementationSha256: 'a'.repeat(64) } },
        attempts: 1, latestError: null, updatedAt: '2026-09-08T00:00:00.000Z' };
    const body = { contract: runner.REGISTRY_CONTRACT, version: 1, planSha256: plan.planSha256,
        createdAt: '2026-09-08T00:00:00.000Z', entries: [entry] };
    const registryFile = path.join(root, 'registry.json');
    fs.writeFileSync(registryFile, `${JSON.stringify({ ...body, registrySha256: runner.stableHash(body) })}\n`);
    const snapshot = control.registrySnapshot({ registryFile, plan,
        currentRendererImplementationSha256: 'b'.repeat(64) });
    assert.equal(snapshot.counts.staged, 1);
    assert.equal(snapshot.currentStagedCount, 0);
    assert.equal(snapshot.staleStagedCount, 1);
    assert.deepEqual(snapshot.staleStagedPaperIds, [item.paperId]);
});

test('resume refuses to remove pause request while direct-run lock exists', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-control-lock-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const plan = minimalPlan();
    const request = control.writePauseRequest({ registryRoot: root, plan, requestedAt: '2026-09-07T00:00:00.000Z' });
    fs.mkdirSync(request.operationLockDirectory);
    assert.throws(() => control.resumeRewrite({ registryRoot: root, plan }), /still holds its operation lock/);
    assert.equal(fs.existsSync(request.pauseFile), true);
});

test('status reports pause, progress and explicit unfinished publication closeout', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const registryRoot = path.join(root, 'registries'); const aggregateRoot = path.join(root, 'aggregates');
    const aggregateProjectionRoot = path.join(root, 'aggregate-projections'); const sourceRoot = path.join(root, 'sources');
    for (const value of [registryRoot, aggregateRoot, aggregateProjectionRoot, sourceRoot]) fs.mkdirSync(value);
    const plan = minimalPlan(); const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    control.writePauseRequest({ registryRoot, plan, requestedAt: '2026-09-07T00:00:00.000Z' });
    const status = control.buildStatus({ planFile, registryRoot, sourceRoot, aggregateRoot, aggregateProjectionRoot,
        observedAt: '2026-09-07T00:00:01.000Z' }, {
        publicationStatus: () => { throw new Error('ordinary status must not inspect publication or remote'); }
    });
    assert.equal(status.completion.phase, 'paused'); assert.equal(status.execution.pauseRequested, true);
    assert.equal(status.execution.progressPercent, 100);
    assert.equal(status.publication.supported, true);
    assert.equal(status.publication.liveRemoteRequested, false);
    assert.ok(status.completion.blockers.some(item => item.code === 'historical-publication-not-selected'));
});

test('selected publication defaults to live remote and must bind the current history plan', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-status-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plan = minimalPlan(); const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const roots = Object.fromEntries(['registryRoot', 'sourceRoot', 'aggregateRoot', 'aggregateProjectionRoot', 'publicationRoot']
        .map(name => [name, path.join(root, name)]));
    for (const value of Object.values(roots)) fs.mkdirSync(value);
    let observed = null;
    const selected = control.buildStatus({ planFile, ...roots,
        publicationId: '12345678-1234-4123-8123-123456789abc' }, {
        publicationStatus: options => { observed = options; return { contract: 'fixture', phase: 'published',
            complete: true, planSha256: plan.planSha256 }; }
    });
    assert.equal(observed.liveRemote, true);
    assert.equal(selected.publication.outputRoot, roots.publicationRoot);
    assert.equal(selected.publication.planMatchesHistory, true);
    const mismatch = control.buildStatus({ planFile, ...roots,
        publicationId: '12345678-1234-4123-8123-123456789abc' }, {
        publicationStatus: () => ({ contract: 'fixture', phase: 'published', complete: true,
            planSha256: 'f'.repeat(64) })
    });
    assert.equal(mismatch.publication.complete, false);
    assert.ok(mismatch.completion.blockers.some(item => item.code === 'historical-publication-plan-mismatch'));
});

test('aggregate snapshot reports exact ordinary and conference-task totals', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-status-aggregate-counts-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const snapshot = control.aggregateSnapshot({ aggregateRoot: root, plan: minimalPlan(),
        expectedTaskKeys: ['icassp-2026-asr', 'iclr-2026-audio'] });
    assert.deepEqual(snapshot.expected, { daily: 0, conference: 0, conferenceTask: 2,
        aggregate: 0, total: 2 });
    assert.deepEqual(snapshot.complete, { daily: 0, conference: 0, conferenceTask: 0,
        aggregate: 0, total: 0 });
    assert.deepEqual(snapshot.missing.conferenceTask, ['icassp-2026-asr', 'iclr-2026-audio']);
});

test('status reports pausing until each requested phase releases its operation lock', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-status-pausing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const plan = minimalPlan(); const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    for (const phase of ['source', 'analysis']) {
        const registryRoot = path.join(root, `${phase}-registries`);
        const aggregateRoot = path.join(root, `${phase}-aggregates`);
        const aggregateProjectionRoot = path.join(root, `${phase}-aggregate-projections`);
        const sourceRoot = path.join(root, `${phase}-sources`);
        for (const value of [registryRoot, aggregateRoot, aggregateProjectionRoot, sourceRoot]) fs.mkdirSync(value);
        const request = control.writePauseRequest({ phase, registryRoot, sourceRoot, plan,
            requestedAt: '2026-09-07T00:00:00.000Z' });
        fs.mkdirSync(request.operationLockDirectory);
        const active = control.buildStatus({ planFile, registryRoot, sourceRoot, aggregateRoot,
            aggregateProjectionRoot, observedAt: '2026-09-07T00:00:01.000Z' });
        assert.equal(active.completion.phase, 'pausing');
        assert.equal(phase === 'source' ? active.sources.running : active.execution.running, true);
        fs.rmdirSync(request.operationLockDirectory);
        const settled = control.buildStatus({ planFile, registryRoot, sourceRoot, aggregateRoot,
            aggregateProjectionRoot, observedAt: '2026-09-07T00:00:02.000Z' });
        assert.equal(settled.completion.phase, 'paused');
    }
});

test('aggregate status replays page bytes and requires exact projection task keys', t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-aggregate-status-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const aggregateRoot = path.join(root, 'aggregates'); const runId = '12345678-1234-4123-8123-123456789abc';
    const runRoot = path.join(aggregateRoot, runId); const stagedPath = 'pages/content/posts/task.md';
    fs.mkdirSync(path.join(runRoot, 'pages', 'content', 'posts'), { recursive: true });
    const bytes = Buffer.from('task page\n'); fs.writeFileSync(path.join(runRoot, stagedPath), bytes);
    const body = { contract: aggregateApi.CONTRACT, version: aggregateApi.VERSION, status: 'complete',
        scope: 'conference-task', key: 'icassp-2026-task-unexpected',
        source: { planSha256: minimalPlan().planSha256 },
        outputPage: { stagedPath, contentSha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') } };
    const manifest = { ...body, manifestSha256: aggregateApi.stableHash(body) };
    fs.writeFileSync(path.join(runRoot, 'conference-task-icassp-2026-task-unexpected.json'), `${JSON.stringify(manifest)}\n`);
    const snapshot = control.aggregateSnapshot({ aggregateRoot, plan: minimalPlan(),
        expectedTaskKeys: ['icassp-2026-task-required'] });
    assert.deepEqual(snapshot.missing.conferenceTask, ['icassp-2026-task-required']);
    assert.deepEqual(snapshot.unexpectedTaskKeys, ['conference-task:icassp-2026-task-unexpected']);
    fs.writeFileSync(path.join(runRoot, stagedPath), 'drifted page\n');
    assert.equal(control.aggregateSnapshot({ aggregateRoot, plan: minimalPlan(),
        expectedTaskKeys: ['icassp-2026-task-required'] }).errors.some(item => /page bytes drifted/.test(item.error)), true);
});

test('control CLI accepts status watch only and rejects unsafe combinations', () => {
    assert.deepEqual(cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--generation', '2', '--watch-seconds', '5']), {
        action: 'status', planFile: '/tmp/plan.json', generation: 2, watchSeconds: 5, phase: null,
        publicationId: null, liveRemote: false });
    assert.throws(() => cli.parseArgs(['pause', '--plan', '/tmp/plan.json', '--watch-seconds', '5']), /Use/);
    assert.deepEqual(cli.parseArgs(['pause', '--plan', '/tmp/plan.json', '--phase', 'source']), {
        action: 'pause', planFile: '/tmp/plan.json', generation: 1, watchSeconds: null, phase: 'source' });
    assert.throws(() => cli.parseArgs(['resume', '--plan', '/tmp/plan.json']), /Use/);
    assert.throws(() => cli.parseArgs(['status', '--plan', 'relative.json']), /Use/);
    assert.equal(cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--verify-sources', 'true']).verifySources, true);
    const publication = cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--publication-id',
        '12345678-1234-4123-8123-123456789abc']);
    assert.equal(publication.liveRemote, true);
    assert.equal(publication.publicationId, '12345678-1234-4123-8123-123456789abc');
    assert.throws(() => cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--live-remote', 'true']), /Use/);
    assert.throws(() => cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--publication-id',
        '12345678-1234-4123-8123-123456789abc', '--watch-seconds', '5']), /Use/);
    assert.throws(() => cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--verify-sources', 'true',
        '--watch-seconds', '5']), /Use/);
});

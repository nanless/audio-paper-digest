'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const control = require('../scripts/lib/historical-direct-control.js');
const cli = require('../scripts/historical-direct-control.js');

function minimalPlan() {
    const body = { contract: 'historical-direct-rewrite-plan-v3', version: 3,
        catalogFileSha256: 'a'.repeat(64), inventory: { ledgerSha256: 'b'.repeat(64), pageSetSha256: 'c'.repeat(64) },
        conferenceProjectionArtifactSha256: 'd'.repeat(64), queue: [], queueSha256: control.stableHash([]),
        projectedPages: [], unprojectedCatalogEntries: [], unprojectedCatalogEntrySetSha256: control.stableHash([]),
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
    assert.equal(control.normalizeSourceStatus(created.status, plan, 1).statusSha256, created.status.statusSha256);
    const tampered = structuredClone(created.status); tampered.planSha256 = 'f'.repeat(64);
    assert.throws(() => control.normalizeSourceStatus(tampered, plan, 1), /source status envelope/);
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
        observedAt: '2026-09-07T00:00:01.000Z' });
    assert.equal(status.completion.phase, 'paused'); assert.equal(status.execution.pauseRequested, true);
    assert.equal(status.execution.progressPercent, 100);
    assert.ok(status.completion.blockers.some(item => item.code === 'direct-history-publication-not-implemented'));
});

test('control CLI accepts status watch only and rejects unsafe combinations', () => {
    assert.deepEqual(cli.parseArgs(['status', '--plan', '/tmp/plan.json', '--generation', '2', '--watch-seconds', '5']), {
        action: 'status', planFile: '/tmp/plan.json', generation: 2, watchSeconds: 5, phase: null });
    assert.throws(() => cli.parseArgs(['pause', '--plan', '/tmp/plan.json', '--watch-seconds', '5']), /Use/);
    assert.deepEqual(cli.parseArgs(['pause', '--plan', '/tmp/plan.json', '--phase', 'source']), {
        action: 'pause', planFile: '/tmp/plan.json', generation: 1, watchSeconds: null, phase: 'source' });
    assert.throws(() => cli.parseArgs(['resume', '--plan', '/tmp/plan.json']), /Use/);
    assert.throws(() => cli.parseArgs(['status', '--plan', 'relative.json']), /Use/);
});

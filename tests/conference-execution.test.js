'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const runApi = require('../scripts/lib/conference-run.js');
const planApi = require('../scripts/lib/conference-plan.js');
const execution = require('../scripts/lib/conference-execution.js');
const cli = require('../scripts/conference-execution.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-06T00:00:00.000Z';
const executionId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const operationId2 = '33333333-3333-4333-8333-333333333333';
const paperId = paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value: '1001' });

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-execution-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const record = { identity: { type: 'icassp-arnumber', value: '1001' },
        metadataFile: 'm.json', metadataSha256: sha('m'), pdfFile: 'p.pdf', pdfSha256: sha('p'),
        textFile: 't.txt', textSha256: sha('t'), artifactsFile: 'a.json', artifactsSha256: sha('a') };
    record.status = { state: 'verified', updatedAt: stamp, reason: 'fixture', evidence: ['metadata', 'pdf', 'text', 'artifacts']
        .map(kind => ({ kind, sha256: record[`${kind}Sha256`] })) };
    const ledger = ledgerApi.createLedger({ id: 'icassp-2026', year: 2026 }, [record]);
    const ledgerFile = path.join(root, 'ledger.json'); ledgerApi.writeLedger(ledgerFile, ledger);
    const ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile);
    const members = [{ paperId, sourceIdentity: 'icassp-arnumber:1001' }];
    const selectedMemberSetSha256 = runApi.stableHash([paperId]);
    const run = runApi.createConferenceRunFromVerifiedLedger({ ledgerHandle, taxonomyVersion: 'taxonomy-v1',
        filterPolicySha256: sha('filter policy'), selectionReceiptSha256: sha('selection receipt'),
        selectedMemberSetSha256, members, shards: [{ shardId: 'all', paperIds: [paperId] }] });
    const snapshot = { run, receipt: { receiptSha256: sha('plan receipt'),
        import: { receiptSha256: sha('import receipt') }, filter: {
            filterPolicySha256: run.filterPolicySha256, selectionReceiptSha256: run.selectionReceiptSha256,
            selectedMemberSetSha256: run.selectedMemberSetSha256 } },
    receiptFileSha256: sha('plan receipt file'), runFileSha256: sha('run file') };
    const handle = Object.freeze({ fixture: root });
    const originalAuthority = planApi.planHandleAuthority; const originalSnapshot = planApi.planHandleSnapshot;
    planApi.planHandleAuthority = value => value === handle ? { snapshot: structuredClone(snapshot), ledgerHandle } : originalAuthority(value);
    planApi.planHandleSnapshot = value => value === handle ? structuredClone(snapshot) : originalSnapshot(value);
    t.after(() => { planApi.planHandleAuthority = originalAuthority; planApi.planHandleSnapshot = originalSnapshot; });
    return { root, handle, snapshot };
}

test('v2 prepare requires plan authority and writes a durable immutable authority receipt', t => {
    const f = fixture(t);
    assert.equal(execution.prepareExecution, undefined);
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: {}, executionId }), /authenticated plan handle/);
    const state = execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle, executionId, now: stamp });
    const directory = path.join(f.root, executionId);
    assert.equal(state.source.planReceiptFileSha256, f.snapshot.receiptFileSha256);
    assert.equal(state.source.runFileSha256, f.snapshot.runFileSha256);
    assert.equal(fs.statSync(path.join(directory, 'authority.json')).mode & 0o777, 0o600);
    const authority = JSON.parse(fs.readFileSync(path.join(directory, 'authority.json'), 'utf8'));
    assert.equal(authority.contract, execution.AUTHORITY_CONTRACT);
    assert.equal(execution.readExecution({ executionRoot: f.root, executionId, planHandle: f.handle }).stateSha256,
        state.stateSha256);
    assert.throws(() => execution.readExecution({ executionRoot: f.root, executionId, planHandle: {} }), /authenticated plan handle/);
    assert.equal(execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId, now: '2026-09-07T00:00:00.000Z' }).stateSha256, state.stateSha256);
});

test('prepare recovers only authenticated known half-products and remains retryable after staged EIO', t => {
    const f = fixture(t);
    const ids = [
        '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'
    ];
    fs.mkdirSync(path.join(f.root, ids[0]), { mode: 0o700 });
    assert.equal(execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: ids[0], now: stamp }).attempts.length, 0);

    execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle, executionId: ids[1], now: stamp });
    fs.unlinkSync(path.join(f.root, ids[1], 'state.json'));
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: ids[1], now: '2026-09-07T00:00:00.000Z' }), /authority-only execution cannot be recovered/);

    execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle, executionId: ids[2], now: stamp });
    fs.unlinkSync(path.join(f.root, ids[2], 'authority.json'));
    assert.equal(execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: ids[2], now: '2026-09-07T00:00:00.000Z' }).attempts.length, 0);

    const progressedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let progressed = execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: progressedId, now: stamp });
    progressed = execution.transitionExecution({ executionRoot: f.root, executionId: progressedId,
        planHandle: f.handle, owner: 'worker', now: stamp, patch: { operationId,
            expectedStateSha256: progressed.stateSha256, paperId,
            nextState: { status: 'source_ready', usage: { requests: 1 } } } });
    assert.equal(progressed.attempts.length, 1);
    assert.equal(fs.readdirSync(path.join(f.root, progressedId, 'patches')).length, 0);
    fs.unlinkSync(path.join(f.root, progressedId, 'state.json'));
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: progressedId, now: '2026-09-07T00:00:00.000Z' }), /authority-only execution cannot be recovered/);

    fs.mkdirSync(path.join(f.root, ids[3]), { mode: 0o700 });
    fs.mkdirSync(path.join(f.root, ids[3], 'patches'), { mode: 0o700 });
    fs.writeFileSync(path.join(f.root, ids[3], 'unknown'), 'x');
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: ids[3], now: stamp }), /unknown recovery content/);

    const linkedId = '99999999-9999-4999-8999-999999999999';
    const linkedDirectory = path.join(f.root, linkedId); fs.mkdirSync(linkedDirectory, { mode: 0o700 });
    const outside = path.join(f.root, 'outside-authority.json'); fs.writeFileSync(outside, '{}', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(linkedDirectory, 'authority.json'));
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: linkedId, now: stamp }), /unsafe controlled JSON file/);

    const orphanPatchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: orphanPatchId, now: stamp });
    fs.unlinkSync(path.join(f.root, orphanPatchId, 'state.json'));
    fs.writeFileSync(path.join(f.root, orphanPatchId, 'patches', 'orphan.json'), '{}', { mode: 0o600 });
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: orphanPatchId, now: stamp }), /non-empty patches/);

    const interruptedId = '88888888-8888-4888-8888-888888888888';
    const originalWrite = fs.writeFileSync; let writes = 0;
    fs.writeFileSync = function failSecondDescriptor(target, ...args) {
        if (typeof target === 'number' && ++writes === 2) { const error = new Error('fixture EIO'); error.code = 'EIO'; throw error; }
        return originalWrite.call(this, target, ...args);
    };
    try {
        assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
            executionId: interruptedId, now: stamp }), /fixture EIO/);
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(fs.existsSync(path.join(f.root, interruptedId)), false);
    assert.equal(execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: interruptedId, now: stamp }).attempts.length, 0);
});

test('real plan concurrent authority link preserves the successful bundle and remains idempotent', t => {
    const f = productionPlanFixture(t); const executionRoot = path.join(f.root, 'executions');
    const concurrentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const originalLink = fs.linkSync; let collided = false;
    fs.linkSync = function linkAuthorityFirst(source, target) {
        if (!collided && path.basename(target) === 'authority.json') {
            collided = true;
            originalLink.call(this, source, target);
        }
        return originalLink.call(this, source, target);
    };
    let state;
    try {
        state = execution.prepareExecutionFromPlan({ executionRoot, planHandle: f.planHandle,
            executionId: concurrentId, now: stamp });
    } finally { fs.linkSync = originalLink; }
    const directory = path.join(executionRoot, concurrentId);
    assert.equal(collided, true);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['authority.json', 'patches', 'state.json']);
    assert.equal(execution.readExecution({ executionRoot, executionId: concurrentId,
        planHandle: f.planHandle }).stateSha256, state.stateSha256);
    assert.equal(execution.prepareExecutionFromPlan({ executionRoot, planHandle: f.planHandle,
        executionId: concurrentId, now: '2026-09-07T00:00:00.000Z' }).stateSha256, state.stateSha256);
});

test('prepare rollback never deletes a state path whose created inode was replaced before EIO', t => {
    const f = fixture(t); const interruptedId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const stateFile = path.join(f.root, interruptedId, 'state.json');
    const originalWrite = fs.writeFileSync; let writes = 0;
    fs.writeFileSync = function replaceStateBeforeFailure(target, ...args) {
        if (typeof target === 'number' && ++writes === 2) {
            fs.unlinkSync(stateFile); originalWrite.call(fs, stateFile, 'FOREIGN-STATE\n', { mode: 0o600 });
            const error = new Error('fixture EIO after state replacement'); error.code = 'EIO'; throw error;
        }
        return originalWrite.call(this, target, ...args);
    };
    try {
        assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
            executionId: interruptedId, now: stamp }), /fixture EIO after state replacement/);
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(fs.readFileSync(stateFile, 'utf8'), 'FOREIGN-STATE\n');
    assert.throws(() => execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId: interruptedId, now: stamp }), /execution recovery state/);
});

test('status/transition replay durable authority and reject authority or state drift', t => {
    const f = fixture(t);
    let state = execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle, executionId, now: stamp });
    state = execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle, owner: 'worker', now: stamp,
        patch: { operationId, expectedStateSha256: state.stateSha256, paperId,
            nextState: { status: 'source_ready', usage: { requests: 1 } } } });
    assert.equal(state.paperStates[paperId].status, 'source_ready');
    const authorityFile = path.join(f.root, executionId, 'authority.json');
    const authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
    authority.source.runFileSha256 = sha('forged');
    const body = structuredClone(authority); delete body.authoritySha256;
    authority.authoritySha256 = runApi.stableHash(body);
    fs.writeFileSync(authorityFile, `${JSON.stringify(authority)}\n`);
    assert.throws(() => execution.readExecution({ executionRoot: f.root, executionId, planHandle: f.handle }), /does not replay/);
});

test('transition preserves CAS, operation idempotency, lock and patch-path boundaries, and replays attempts', t => {
    const f = fixture(t);
    let state = execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle, executionId, now: stamp });
    const first = { operationId, expectedStateSha256: state.stateSha256, paperId,
        nextState: { status: 'source_ready', usage: { requests: 1, totalTokens: 10 } } };
    state = execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle,
        owner: 'worker', now: stamp, patch: first });
    assert.equal(execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle,
        executionId, now: '2026-09-07T00:00:00.000Z' }).attempts.length, 1);
    assert.equal(execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle,
        owner: 'worker', patch: first }).attempts.length, 1);
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle,
        owner: 'worker', patch: { ...first, expectedStateSha256: state.stateSha256,
            nextState: { status: 'blocked', reason: 'different', usage: { requests: 1, totalTokens: 10 } } } }), /already been used/);
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle,
        owner: 'worker', patch: { operationId: operationId2, expectedStateSha256: first.expectedStateSha256,
            paperId, nextState: { status: 'analyzing', usage: { requests: 2, totalTokens: 20 } } } }), /compare-and-swap/);

    const directory = path.join(f.root, executionId); const lock = path.join(directory, 'operation.lock');
    fs.writeFileSync(lock, '{}', { mode: 0o600 });
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle,
        owner: 'worker', patch: { operationId: operationId2, expectedStateSha256: state.stateSha256,
            paperId, nextState: { status: 'analyzing', usage: { requests: 2, totalTokens: 20 } } } }), /locked/);
    fs.unlinkSync(lock);
    assert.throws(() => execution.transitionExecutionFromPatchFile({ executionRoot: f.root, executionId,
        planHandle: f.handle, patchName: '../outside.json', owner: 'worker' }), /unsafe/);

    const stateFile = path.join(directory, 'state.json'); const corrupted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    corrupted.attempts[0].patch.nextState.usage.requests = 99;
    fs.writeFileSync(stateFile, `${JSON.stringify(corrupted)}\n`);
    assert.throws(() => execution.readExecution({ executionRoot: f.root, executionId, planHandle: f.handle }),
        /patch SHA does not bind patch content|state SHA drifted/);
});

test('insecure legacy execution source and completed transitions remain rejected', t => {
    const f = fixture(t);
    const state = execution.prepareExecutionFromPlan({ executionRoot: f.root, planHandle: f.handle, executionId, now: stamp });
    const insecure = structuredClone(state);
    for (const field of ['planReceiptSha256', 'planReceiptFileSha256', 'runFileSha256', 'importReceiptSha256',
        'filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256']) delete insecure.source[field];
    assert.throws(() => execution.assertConferenceExecution(insecure), /unknown or missing fields/);
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId, planHandle: f.handle,
        owner: 'worker', patch: { operationId, expectedStateSha256: state.stateSha256, paperId,
            nextState: { status: 'completed', usage: {}, projection: {} } } }), /completion-proof receipt bundle/);
});

test('every execution CLI command requires the complete upstream authority chain', () => {
    const authority = ['--run', 'run.json', '--plan-receipt', 'run.plan-receipt.json', '--plan', 'plan.json',
        '--ledger', 'ledger.json', '--import-receipt', 'ledger.import-receipt.json', '--import', 'import.json',
        '--staging-receipt', 'staging.json', '--filter', executionId, '--catalog', 'catalog.json', '--report', 'report.json'];
    assert.equal(cli.parseArgs(['prepare', ...authority, '--execution', executionId]).executionId, executionId);
    assert.equal(cli.parseArgs(['status', ...authority, '--execution', executionId]).runName, 'run.json');
    assert.equal(cli.parseArgs(['transition', ...authority, '--execution', executionId, '--patch', 'step.json', '--owner', 'worker']).patchName, 'step.json');
    for (const args of [['status', '--execution', executionId], ['transition', '--execution', executionId,
        '--patch', 'step.json', '--owner', 'worker']]) assert.throws(() => cli.parseArgs(args), /complete/);
});

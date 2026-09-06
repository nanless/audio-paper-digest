'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const runApi = require('../scripts/lib/conference-run.js');
const execution = require('../scripts/lib/conference-execution.js');
const cli = require('../scripts/conference-execution.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-06T00:00:00.000Z';
const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444'
];

function verifiedLedger() {
    const make = value => {
        const record = {
            identity: { type: 'icassp-arnumber', value }, metadataFile: `meta/${value}.json`, metadataSha256: sha(`meta:${value}`),
            pdfFile: `pdf/${value}.pdf`, pdfSha256: sha(`pdf:${value}`), textFile: `text/${value}.txt`, textSha256: sha(`text:${value}`),
            artifactsFile: `artifacts/${value}.json`, artifactsSha256: sha(`art:${value}`)
        };
        record.status = { state: 'verified', updatedAt: stamp, reason: 'fixture bound', evidence: ['metadata', 'pdf', 'text', 'artifacts']
            .map(kind => ({ kind, sha256: record[`${kind}Sha256`] })) };
        return record;
    };
    return ledgerApi.createLedger({ id: 'icassp-2026', year: 2026 }, [make('1001'), make('1002')]);
}
function fixture() {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-execution-'));
    const ledger = verifiedLedger(); const ledgerFile = path.join(root, 'ledger.json'); ledgerApi.writeLedger(ledgerFile, ledger);
    const ledgerHandle = ledgerApi.loadLedgerHandle(ledgerFile); const { ledgerSha256 } = ledgerApi.ledgerHandleSnapshot(ledgerHandle);
    const members = [{ paperId: 'icassp-1001', sourceIdentity: 'icassp-arnumber:1001' }, { paperId: 'icassp-1002', sourceIdentity: 'icassp-arnumber:1002' }];
    const run = runApi.createConferenceRunFromVerifiedLedger({ ledgerHandle, taxonomyVersion: 'paper-taxonomy-v2',
        selectionPolicySha256: sha('selection'), members, shards: [{ shardId: 'all', paperIds: members.map(member => member.paperId) }] });
    return { root, ledger, ledgerHandle, ledgerSha256, run };
}
function patch(operationId, expectedStateSha256, paperId, nextState) { return { operationId, expectedStateSha256, paperId, nextState }; }
function resealExecution(state) {
    state.stateSha256 = runApi.stableHash({
        executionId: state.executionId, source: state.source, paperStates: state.paperStates,
        attempts: state.attempts.map(({ nextStateSha256: _receipt, ...attempt }) => attempt)
    });
    return state;
}

test('prepare isolates a strongly-bound initial verified run and is idempotent for the same UUID', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const first = execution.prepareExecution({ executionRoot: f.root, run: f.run, ledgerHandle: f.ledgerHandle, executionId: ids[0], now: stamp });
    const second = execution.prepareExecution({ executionRoot: f.root, run: f.run, ledgerHandle: f.ledgerHandle, executionId: ids[0], now: '2026-09-07T00:00:00.000Z' });
    assert.equal(first.contract, 'conference-execution-v1'); assert.equal(first.stateSha256, second.stateSha256);
    assert.equal(first.source.runIdentitySha256, f.run.identitySha256); assert.equal(first.attempts.length, 0);
    assert.equal(fs.statSync(path.join(f.root, ids[0], 'state.json')).mode & 0o777, 0o600);
    const altered = structuredClone(f.run); altered.paperStates['icassp-1001'] = { status: 'source_ready', usage: runApi.normalizeUsage() };
    altered.stateSha256 = runApi.stableHash({ identitySha256: altered.identitySha256, paperStates: altered.paperStates });
    assert.throws(() => execution.prepareExecution({ executionRoot: f.root, run: altered, ledgerHandle: f.ledgerHandle, executionId: ids[1] }), /initial pending/);
    assert.throws(() => execution.prepareExecution({ executionRoot: f.root, run: f.run, ledgerHandle: structuredClone(f.ledgerHandle), executionId: ids[1] }), /authenticated loaded ledger handle/);
});

test('transition is CAS-protected, append-only, monotonic and idempotent by operation ID', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = execution.prepareExecution({ executionRoot: f.root, run: f.run, ledgerHandle: f.ledgerHandle, executionId: ids[0], now: stamp });
    const first = patch(ids[1], state.stateSha256, 'icassp-1001', { status: 'source_ready', usage: { requests: 1, totalTokens: 10 } });
    state = execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: first, owner: 'worker-1', now: stamp });
    assert.equal(state.paperStates['icassp-1001'].status, 'source_ready'); assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].nextStateSha256, state.stateSha256);
    assert.equal(execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: first, owner: 'worker-1' }).attempts.length, 1);
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: patch(ids[2], first.expectedStateSha256, 'icassp-1001', { status: 'analyzing', usage: { requests: 2, totalTokens: 20 } }), owner: 'worker-2' }), /compare-and-swap/);
    const second = patch(ids[2], state.stateSha256, 'icassp-1001', { status: 'analyzing', usage: { requests: 2, totalTokens: 20 } });
    state = execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: second, owner: 'worker-2', now: '2026-09-06T00:01:00.000Z' });
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: patch(ids[3], state.stateSha256, 'icassp-1001', { status: 'failed', reason: 'fixture failure', usage: { requests: 1, totalTokens: 20 } }), owner: 'worker-3' }), /cannot regress/);
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: { ...second, expectedStateSha256: state.stateSha256, nextState: { status: 'blocked', reason: 'different' } }, owner: 'worker-2' }), /already been used/);
});

test('state, locks, execution directories and patch paths fail closed on tampering', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = execution.prepareExecution({ executionRoot: f.root, run: f.run, ledgerHandle: f.ledgerHandle, executionId: ids[0], now: stamp });
    const dir = path.join(f.root, ids[0]);
    fs.writeFileSync(path.join(dir, 'operation.lock'), '{"owner":"other"}\n', { mode: 0o600 });
    assert.throws(() => execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], patch: patch(ids[1], state.stateSha256, 'icassp-1001', { status: 'source_ready', usage: {} }), owner: 'worker' }), /locked/);
    fs.unlinkSync(path.join(dir, 'operation.lock'));
    fs.mkdirSync(path.join(dir, 'patches'));
    fs.writeFileSync(path.join(dir, 'patches', 'step-1.json'), JSON.stringify(patch(ids[1], state.stateSha256, 'icassp-1001', { status: 'source_ready', usage: {} })));
    state = execution.transitionExecutionFromPatchFile({ executionRoot: f.root, executionId: ids[0], patchName: 'step-1.json', owner: 'worker', now: stamp });
    assert.equal(state.attempts.length, 1);
    assert.throws(() => execution.transitionExecutionFromPatchFile({ executionRoot: f.root, executionId: ids[0], patchName: '../outside.json', owner: 'worker' }), /unsafe/);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); raw.paperStates['icassp-1001'].status = 'blocked';
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw));
    assert.throws(() => execution.readExecution({ executionRoot: f.root, executionId: ids[0] }), /state SHA|attempt|state does not match|requires a reason/);
});

test('execution receipts replay the initial source state, full patch payload and monotonic clock', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = execution.prepareExecution({ executionRoot: f.root, run: f.run, ledgerHandle: f.ledgerHandle, executionId: ids[0], now: stamp });
    state = execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], owner: 'worker', now: '2026-09-06T00:01:00.000Z',
        patch: patch(ids[1], state.stateSha256, 'icassp-1001', { status: 'source_ready', usage: { requests: 1 } }) });
    state = execution.transitionExecution({ executionRoot: f.root, executionId: ids[0], owner: 'worker', now: '2026-09-06T00:02:00.000Z',
        patch: patch(ids[2], state.stateSha256, 'icassp-1001', { status: 'analyzing', usage: { requests: 2 } }) });

    const badSource = structuredClone(state); badSource.source.runStateSha256 = sha('not-the-initial-run');
    assert.throws(() => execution.assertConferenceExecution(resealExecution(badSource)), /rebuilt initial run state/);

    const badFirstPrior = structuredClone(state); badFirstPrior.attempts[0].priorStateSha256 = sha('bad-first-prior');
    badFirstPrior.attempts[0].patch.expectedStateSha256 = badFirstPrior.attempts[0].priorStateSha256;
    badFirstPrior.attempts[0].patchSha256 = runApi.stableHash(badFirstPrior.attempts[0].patch);
    assert.throws(() => execution.assertConferenceExecution(resealExecution(badFirstPrior)), /SHA history is discontinuous/);

    const badPatch = structuredClone(state); badPatch.attempts[0].patch.nextState.usage.requests = 99;
    assert.throws(() => execution.assertConferenceExecution(resealExecution(badPatch)), /patch SHA does not bind patch content/);

    const backwards = structuredClone(state); backwards.attempts[1].recordedAt = '2026-09-06T00:00:30.000Z';
    backwards.attempts[1].nextStateSha256 = resealExecution(backwards).stateSha256;
    assert.throws(() => execution.assertConferenceExecution(resealExecution(backwards)), /moves backwards in time/);
});

test('CLI accepts only direct names, safe UUIDs and controlled patch files', () => {
    assert.deepEqual(cli.parseArgs(['prepare', '--run', 'pilot.json', '--ledger', 'icassp.json', '--execution', ids[0]]), { command: 'prepare', runName: 'pilot.json', ledgerName: 'icassp.json', executionId: ids[0] });
    assert.deepEqual(cli.parseArgs(['status', '--execution', ids[0]]), { command: 'status', executionId: ids[0] });
    assert.deepEqual(cli.parseArgs(['transition', '--execution', ids[0], '--patch', 'step-1.json', '--owner', 'worker.1']), { command: 'transition', executionId: ids[0], patchName: 'step-1.json', owner: 'worker.1' });
    for (const args of [[], ['status', '--execution', '../x'], ['prepare', '--run', '../x.json', '--ledger', 'x.json'], ['transition', '--execution', ids[0], '--patch', '../x.json', '--owner', 'x']]) assert.throws(() => cli.parseArgs(args));
});

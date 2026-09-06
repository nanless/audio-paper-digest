'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const filter = require('../scripts/lib/conference-filter.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const ledger = require('../scripts/lib/conference-source-ledger.js');
const cli = require('../scripts/conference-filter.js');
const h = value => crypto.createHash('sha256').update(value).digest('hex');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const stamp = '2026-09-06T00:00:00.000Z';
const papers = ['100', '200'].map(value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value }));
function spec(overrides = {}) { return { contract: filter.SPEC_CONTRACT, version: filter.VERSION, filterPolicySha256: h('policy'), promptSha256: h('prompt'),
    model: 'muse-spark-1.2-contributor', endpointProtocol: 'openai-responses', taxonomyRegistrySha256: h('taxonomy'), ...overrides }; }
function fixture() {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-filter-'));
    for (const name of ['filters', 'catalogs', 'reports']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const manifest = { contract: discovery.CONTRACT, version: discovery.VERSION, adapter: 'icassp', conference: { id: 'icassp-2026', year: 2026 },
        metadataSnapshot: { file: path.join(root, 'metadata.json'), sha256: h('metadata'), size: 100 }, pdfRoot: root,
        pdfCatalogSha256: ledger.stableHash([]), pdfCatalog: [], members: [100, 200].map((number, index) => ({
            identity: { type: 'icassp-arnumber', value: String(number) }, metadataIndex: index, title: `Paper ${number}`,
            numericAlias: null, match: { kind: 'unmatched', candidates: [] }
        })), memberSetSha256: '' };
    manifest.memberSetSha256 = ledger.memberSetSha256(manifest.members);
    const report = discovery.buildReport(manifest);
    const catalogFile = path.join(root, 'catalogs', 'conference.json'); const reportFile = path.join(root, 'reports', 'conference.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(report), { mode: 0o600 });
    return { root, filters: path.join(root, 'filters'), discoveryHandle: discovery.loadDiscoveryHandle(catalogFile, reportFile) };
}
function prepare(f) { return filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: f.discoveryHandle,
    spec: spec(), filterId: ids[0], now: stamp }); }
function artifactHandle(f, state, paperId, status, operationId, options = {}) {
    const manual = options.actor === 'manual'; const n = options.n ?? 1;
    const artifact = filter.buildDecisionArtifact({ state, paperId, operationId,
        actor: { type: manual ? 'manual' : 'llm', id: manual ? 'reviewer.1' : 'filter-worker' },
        model: manual ? null : (options.model || spec().model), endpointProtocol: manual ? 'manual' : spec().endpointProtocol,
        requestBytes: `request for ${paperId}`, responseBytes: status === 'failed' ? null : `${status} evidence`,
        status, reason: `${status} fixture`, usage: manual ? {} : { requests: n, inputTokens: n * 10, outputTokens: n * 5, totalTokens: n * 15 },
        now: options.now || stamp });
    const name = `${operationId}.json`;
    const filename = filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: state.filterId, decisionName: name, artifact });
    return { handle: filter.loadDecisionHandle(filename), filename };
}
function apply(f, state, paperId, status, operationId, options = {}) {
    const decision = artifactHandle(f, state, paperId, status, operationId, options);
    return filter.applyDecision({ filterRoot: f.filters, filterId: state.filterId,
        decisionHandle: decision.handle, owner: 'worker', now: options.now || stamp });
}

test('production prepare requires authenticated discovery and closes over source identities', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    assert.deepEqual(Object.keys(state.decisions), papers); assert.equal(state.completion.pending, 2);
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, discoveryHandle: structuredClone(f.discoveryHandle),
        spec: spec(), filterId: ids[3] }), /authenticated discovery handle/);
    assert.throws(() => filter.prepareFilter({ filterRoot: f.filters, catalog: { members: [] }, spec: spec(), filterId: ids[3] }),
        /authenticated discovery handle/);
});

test('final decisions require preserved evidence and receipt contains included identities only', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f);
    state = apply(f, state, papers[0], 'included', ids[1]);
    state = apply(f, state, papers[1], 'excluded', ids[2], { actor: 'manual', now: '2026-09-06T00:01:00.000Z' });
    const receipt = filter.readSelectionReceipt({ filterRoot: f.filters, filterId: ids[0] });
    assert.deepEqual(receipt.included.map(item => item.paperId), [papers[0]]);
    assert.equal(receipt.included[0].sourceSha256, state.decisions[papers[0]].sourceSha256);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(papers[1]));
    const selectionHandle = filter.loadSelectionHandle(f.filters, ids[0], f.discoveryHandle);
    assert.deepEqual(filter.selectionHandleSnapshot(selectionHandle).included, [{ paperId: papers[0],
        sourceIdentity: 'icassp-arnumber:100', sourceSha256: state.decisions[papers[0]].sourceSha256,
        decisionArtifactSha256: state.attempts[0].decisionArtifactSha256 }]);
    assert.throws(() => filter.selectionHandleSnapshot(structuredClone(selectionHandle)), /authenticated filter selection handle/);
    assert.throws(() => filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: ids[0],
        decisionName: `${ids[1]}.json`, artifact: {} }), /artifact|exclusively/);
});

test('idempotent final-decision retry heals a selection receipt write interrupted after complete state', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f);
    state = apply(f, state, papers[0], 'included', ids[1]);
    const finalDecision = artifactHandle(f, state, papers[1], 'excluded', ids[2], { actor: 'manual' });
    const originalOpen = fs.openSync; const originalWrite = fs.writeFileSync;
    let receiptFd;
    let interrupted = false;
    fs.openSync = function trackReceiptOpen(target, ...args) {
        const fd = originalOpen.call(this, target, ...args);
        if (String(target).endsWith('/selection-receipt.json')) receiptFd = fd;
        return fd;
    };
    fs.writeFileSync = function interruptedReceiptWrite(target, ...args) {
        if (!interrupted && target === receiptFd) {
            interrupted = true;
            const error = new Error('fixture interrupted receipt write'); error.code = 'EIO'; throw error;
        }
        return originalWrite.call(this, target, ...args);
    };
    try {
        assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
            decisionHandle: finalDecision.handle, owner: 'worker', now: stamp }), /interrupted receipt write/);
    } finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; }
    assert.equal(filter.readFilter({ filterRoot: f.filters, filterId: ids[0] }).completion.status, 'complete');
    assert.equal(fs.existsSync(path.join(f.filters, ids[0], 'selection-receipt.json')), false);
    const healed = filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
        decisionHandle: finalDecision.handle, owner: 'worker', now: stamp });
    assert.equal(healed.completion.status, 'complete');
    assert.equal(filter.readSelectionReceipt({ filterRoot: f.filters, filterId: ids[0] }).filterId, ids[0]);
});

test('bare response hashes, zero-usage LLM finals and forged handles fail closed', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: {}, owner: 'worker' }), /authenticated decision/);
    assert.throws(() => filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1], actor: { type: 'llm', id: 'worker' },
        model: spec().model, endpointProtocol: spec().endpointProtocol, requestBytes: 'request', responseBytes: 'response',
        status: 'included', reason: 'yes', usage: {} }), /at least one request/);
    assert.throws(() => filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1], actor: { type: 'llm', id: 'worker' },
        model: spec().model, endpointProtocol: spec().endpointProtocol, requestBytes: 'request', responseBytes: 'response',
        status: 'included', reason: 'yes', usage: { requests: 1, inputTokens: 10, outputTokens: 0, totalTokens: 10 } }),
    /positive output\/total tokens/);
    assert.doesNotThrow(() => filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1], actor: { type: 'llm', id: 'worker' },
        model: spec().model, endpointProtocol: spec().endpointProtocol, requestBytes: 'request', responseBytes: 'response',
        status: 'included', reason: 'yes', usage: { requests: 1, inputTokens: null, outputTokens: null, totalTokens: null } }));
    assert.equal(filter.adaptDiscoveryCatalog, undefined); assert.equal(filter.discoveryDocumentToFilterCatalog, undefined);
});

test('decision bytes are replayed and drift fails closed', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f); const decision = artifactHandle(f, state, papers[0], 'included', ids[1]);
    state = filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: decision.handle, owner: 'worker', now: stamp });
    const changed = JSON.parse(fs.readFileSync(decision.filename, 'utf8')); changed.response.data = Buffer.from('tampered').toString('base64');
    fs.writeFileSync(decision.filename, `${JSON.stringify(changed, null, 2)}\n`);
    assert.throws(() => filter.readFilter({ filterRoot: f.filters, filterId: ids[0] }), /SHA drifted|artifact replay drifted|size\/base64/);
});

test('failed remains retryable, cumulative usage monotonic, final cannot change', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    let state = prepare(f); state = apply(f, state, papers[0], 'failed', ids[1]);
    assert.equal(state.completion.failed, 1); assert.equal(state.completion.excluded, 0);
    assert.throws(() => apply(f, state, papers[0], 'included', ids[2], { n: 0 }), /at least one request|usage cannot regress/);
    state = apply(f, state, papers[0], 'included', ids[2], { n: 2, now: '2026-09-06T00:01:00.000Z' });
    assert.throws(() => apply(f, state, papers[0], 'excluded', ids[3], { n: 3 }), /final decision cannot be changed/);
});

test('model and protocol drift are rejected at apply', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f); const decision = artifactHandle(f, state, papers[0], 'included', ids[1], { model: 'wrong-model' });
    assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
        decisionHandle: decision.handle, owner: 'worker' }), /model\/protocol drifted/);
});

test('operation idempotency is bound to the exact preserved decision artifact', t => {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const state = prepare(f);
    const first = artifactHandle(f, state, papers[0], 'included', ids[1]);
    const different = filter.buildDecisionArtifact({ state, paperId: papers[0], operationId: ids[1],
        actor: { type: 'llm', id: 'filter-worker' }, model: spec().model, endpointProtocol: spec().endpointProtocol,
        requestBytes: 'different request bytes', responseBytes: 'included evidence', status: 'included', reason: 'included fixture',
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }, now: stamp });
    const secondFile = filter.writeDecisionArtifact({ filterRoot: f.filters, filterId: ids[0], decisionName: 'different.json', artifact: different });
    const applied = filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: first.handle, owner: 'worker', now: stamp });
    assert.equal(filter.applyDecision({ filterRoot: f.filters, filterId: ids[0], decisionHandle: first.handle, owner: 'worker', now: stamp }).attempts.length, 1);
    assert.throws(() => filter.applyDecision({ filterRoot: f.filters, filterId: ids[0],
        decisionHandle: filter.loadDecisionHandle(secondFile), owner: 'worker', now: stamp }), /different decision evidence/);
    assert.equal(applied.attempts.length, 1);
});

test('CLI requires catalog+report+spec and decision artifacts, not raw patches', () => {
    assert.deepEqual(cli.parseArgs(['prepare', '--catalog', 'icassp.json', '--report', 'icassp-report.json', '--spec', 'filter.json', '--filter', ids[0]]),
        { command: 'prepare', catalogName: 'icassp.json', reportName: 'icassp-report.json', specName: 'filter.json', filterId: ids[0] });
    assert.deepEqual(cli.parseArgs(['apply', '--filter', ids[0], '--decision', 'one.json', '--owner', 'worker.1']),
        { command: 'apply', filterId: ids[0], decisionName: 'one.json', owner: 'worker.1' });
    for (const args of [['prepare', '--catalog', 'x.json', '--spec', 'x.json'],
        ['apply', '--filter', ids[0], '--patch', 'one.json', '--owner', 'worker.1']]) assert.throws(() => cli.parseArgs(args));
});

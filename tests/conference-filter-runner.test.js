'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const discovery = require('../scripts/lib/conference-discovery.js');
const filter = require('../scripts/lib/conference-filter.js');
const ledger = require('../scripts/lib/conference-source-ledger.js');
const runner = require('../scripts/conference-filter-run.js');
const Config = require('../scripts/config.js');
const paperIdentity = require('../scripts/lib/paper-identity.js');

const filterId = '11111111-1111-4111-8111-111111111111';
const lockToken = '22222222-2222-4222-8222-222222222222';
const stamp = '2026-09-06T00:00:00.000Z';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pid = value => paperIdentity.canonicalConferencePaperId(
    { id: 'icassp-2026', year: 2026 }, { type: 'icassp-arnumber', value });

function chatResponse(text, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
    return { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage };
}

async function serverFixture(t, replies = []) {
    const calls = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', async () => {
            const call = { url: request.url, headers: request.headers,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
            calls.push(call);
            const reply = replies.length ? replies.shift() : { body: chatResponse('{"decision":"included","reason":"Audio is primary."}') };
            if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
            response.writeHead(reply.statusCode || 200, { 'content-type': 'application/json' });
            response.end(reply.raw === undefined ? JSON.stringify(reply.body) : reply.raw);
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { calls, endpoint: `http://127.0.0.1:${server.address().port}/v1` };
}

function fixture(t, endpoint, metadata = null) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-filter-runner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dirs = Object.fromEntries(['catalogs', 'reports', 'specs', 'filters']
        .map(name => [name, path.join(root, name)]));
    for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { mode: 0o700 });
    metadata ||= [{ arnumber: '100', title: 'Speech enhancement with diffusion' },
        { arnumber: '200', title: 'Image segmentation only' }];
    const metadataBytes = Buffer.from(JSON.stringify(metadata)); const metadataFile = path.join(root, 'metadata.json');
    fs.writeFileSync(metadataFile, metadataBytes, { mode: 0o600 });
    const manifest = { contract: discovery.CONTRACT, version: discovery.VERSION, adapter: 'icassp',
        conference: { id: 'icassp-2026', year: 2026 },
        metadataSnapshot: { file: metadataFile, sha256: sha(metadataBytes), size: metadataBytes.length }, pdfRoot: root,
        pdfCatalogSha256: ledger.stableHash([]), pdfCatalog: [], members: metadata.map((record, metadataIndex) => ({
            identity: { type: 'icassp-arnumber', value: record.arnumber }, metadataIndex, title: record.title,
            numericAlias: null, match: { kind: 'unmatched', candidates: [] }
        })), memberSetSha256: '' };
    manifest.memberSetSha256 = ledger.memberSetSha256(manifest.members);
    const report = discovery.buildReport(manifest);
    fs.writeFileSync(path.join(dirs.catalogs, 'catalog.json'), discovery.canonicalBytes(manifest), { mode: 0o600 });
    fs.writeFileSync(path.join(dirs.reports, 'report.json'), discovery.canonicalBytes(report), { mode: 0o600 });
    const discoveryHandle = discovery.loadDiscoveryHandle(path.join(dirs.catalogs, 'catalog.json'),
        path.join(dirs.reports, 'report.json'));
    const taxonomyFile = path.join(root, 'taxonomy.json'); fs.writeFileSync(taxonomyFile, '{"version":"taxonomy-v1"}\n', { mode: 0o600 });
    const model = 'fixture-filter-model';
    const spec = { contract: filter.SPEC_CONTRACT, version: filter.VERSION,
        filterPolicySha256: filter.LLM_FILTER_POLICY_SHA256, promptSha256: filter.LLM_FILTER_PROMPT_SHA256,
        model, endpointProtocol: 'openai-chat', endpointIdentitySha256: filter.endpointIdentitySha256(endpoint, model),
        taxonomyRegistrySha256: sha(fs.readFileSync(taxonomyFile)) };
    fs.writeFileSync(path.join(dirs.specs, 'spec.json'), `${JSON.stringify(spec)}\n`, { mode: 0o600 });
    filter.prepareFilter({ filterRoot: dirs.filters, discoveryHandle, spec, filterId, now: stamp });
    const files = { conferenceDiscoveryCatalogDir: dirs.catalogs, conferenceDiscoveryReportDir: dirs.reports,
        conferenceFilterSpecsDir: dirs.specs, conferenceFiltersDir: dirs.filters, taxonomyRegistry: taxonomyFile,
        llmAccountPoolState: path.join(root, 'account-pool.json') };
    const env = { PAPER_ANALYZER_ENDPOINT: endpoint, PAPER_ANALYZER_API_KEY: 'fixture-key', PAPER_ANALYZER_MODEL: model };
    return { root, dirs, spec, files, env };
}

function args(extra = []) {
    return ['--apply', '--catalog', 'catalog.json', '--report', 'report.json', '--spec', 'spec.json',
        '--filter', filterId, '--owner', 'runner.1', ...extra];
}

function onlyJson(directory) {
    const names = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
    assert.equal(names.length, 1); return path.join(directory, names[0]);
}

test('production runner uses real common transport and preserves bound intent, raw response, and usage', async t => {
    const service = await serverFixture(t, [{ body: chatResponse('{"decision":"included","reason":"Primary contribution is speech enhancement."}') }]);
    const f = fixture(t, service.endpoint);
    const result = await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(result.processed[0].status, 'included'); assert.equal(service.calls.length, 1);
    assert.equal(service.calls[0].url, '/v1/chat/completions'); assert.equal(service.calls[0].headers.authorization, 'Bearer fixture-key');
    const envelope = JSON.parse(service.calls[0].body.messages[1].content);
    assert.equal(envelope.paperId, pid('100')); assert.equal(envelope.metadataRecord.arnumber, '100');
    assert.equal(envelope.discovery.metadataIndex, 0); assert.equal(envelope.sourceSha256, state.decisions[pid('100')].sourceSha256);
    const root = path.join(f.dirs.filters, filterId);
    const artifactFile = onlyJson(path.join(root, 'decisions')); const artifact = JSON.parse(fs.readFileSync(artifactFile));
    const intent = JSON.parse(fs.readFileSync(onlyJson(path.join(root, 'llm-intents'))));
    const receipt = JSON.parse(fs.readFileSync(onlyJson(path.join(root, 'llm-responses'))));
    assert.equal(artifact.request.sha256, intent.request.sha256);
    assert.equal(artifact.transportReceiptSha256, receipt.transportReceiptSha256);
    assert.equal(receipt.usageLedgerBindings.length, 1);
    assert.equal(receipt.usageLedgerBindings[0].persistence, 'unavailable');
    assert.deepEqual(artifact.result.usage, { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.equal(filter.runLlmDecision, undefined);
    assert.equal(runner.productionLlmConfig, undefined);
    await assert.rejects(() => runner.main(args(), { files: f.files, env: f.env, transportRequestFn: async () => ({}) }),
        /transport injection is forbidden/);
});

test('partial provider usage is durable failed evidence rather than a post-billing throw', async t => {
    const service = await serverFixture(t, [{ body: chatResponse('{"decision":"included","reason":"Audio."}',
        { prompt_tokens: 5, completion_tokens: 2 }) }]);
    const f = fixture(t, service.endpoint);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.decisions[pid('100')].status, 'failed');
    assert.equal(state.decisions[pid('100')].reason, 'LLM_USAGE_PARTIAL_OR_UNAVAILABLE');
    assert.deepEqual(state.decisions[pid('100')].usage,
        { requests: 1, inputTokens: 5, outputTokens: 2, totalTokens: null });
});

test('an explicit retry can finalize after earlier transport usage became unavailable', async t => {
    const service = await serverFixture(t, [{ raw: 'not-json' },
        { body: chatResponse('{"decision":"included","reason":"Audio is primary."}') }]);
    const f = fixture(t, service.endpoint, [{ arnumber: '100', title: 'Speech enhancement' }]);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const previous = Config.FILTER_CONFIG.conferenceRetryBackoffMs;
    Config.FILTER_CONFIG.conferenceRetryBackoffMs = 0;
    try {
        await runner.main(args(['--limit', '1', '--retry-failed']), { files: f.files, env: f.env });
    } finally { Config.FILTER_CONFIG.conferenceRetryBackoffMs = previous; }
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(service.calls.length, 2); assert.equal(state.decisions[pid('100')].status, 'included');
    assert.deepEqual(state.decisions[pid('100')].usage,
        { requests: 2, inputTokens: null, outputTokens: null, totalTokens: null });
});

test('pending papers precede failed retries and failed work requires explicit bounded retry', async t => {
    const service = await serverFixture(t, [
        { body: chatResponse('not-json') },
        { body: chatResponse('{"decision":"excluded","reason":"Not an audio contribution."}') }
    ]);
    const f = fixture(t, service.endpoint);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
    assert.equal(state.decisions[pid('100')].status, 'failed');
    assert.equal(state.decisions[pid('200')].status, 'excluded'); assert.equal(service.calls.length, 2);
    await runner.main(args(), { files: f.files, env: f.env });
    assert.equal(service.calls.length, 2);
    assert.equal(filter.selectNextCandidate(state, { retryFailed: false, retryBackoffMs: 0 }), null);
    assert.equal(filter.selectNextCandidate(state, { retryFailed: true, retryBackoffMs: 0 }), pid('100'));
    assert.equal(filter.selectNextCandidate(state, { retryFailed: true, maxAttempts: 1, retryBackoffMs: 0 }), null);
    assert.equal(filter.selectNextCandidate(state, { retryFailed: true, retryBackoffMs: Number.MAX_SAFE_INTEGER }), null);
});

test('crashes after request do not produce a second billed call on recovery', async t => {
    await t.test('missing transport receipt becomes typed unavailable evidence', async t => {
        const service = await serverFixture(t); const f = fixture(t, service.endpoint);
        const original = fs.openSync; let injected = false;
        fs.openSync = function (filename, ...rest) {
            if (!injected && String(filename).includes('/llm-responses/')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
            return original.call(this, filename, ...rest);
        };
        try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
        finally { fs.openSync = original; }
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        const state = filter.readFilter({ filterRoot: f.dirs.filters, filterId });
        assert.equal(service.calls.length, 1); assert.equal(state.decisions[pid('100')].status, 'failed');
        assert.match(state.decisions[pid('100')].reason, /^LLM_TRANSPORT_UNAVAILABLE:INTERRUPTED_/);
    });
    await t.test('preserved response is reused when artifact write failed', async t => {
        const service = await serverFixture(t); const f = fixture(t, service.endpoint);
        const original = fs.openSync; let injected = false;
        fs.openSync = function (filename, ...rest) {
            if (!injected && String(filename).includes('/decisions/llm-')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
            return original.call(this, filename, ...rest);
        };
        try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
        finally { fs.openSync = original; }
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        assert.equal(service.calls.length, 1);
        assert.equal(filter.readFilter({ filterRoot: f.dirs.filters, filterId }).decisions[pid('100')].status, 'included');
    });
    await t.test('preserved artifact is applied when state CAS write failed', async t => {
        const service = await serverFixture(t); const f = fixture(t, service.endpoint);
        const original = fs.renameSync; let injected = false;
        fs.renameSync = function (source, target) {
            if (!injected && String(target).endsWith('/state.json')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
            return original.call(this, source, target);
        };
        try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
        finally { fs.renameSync = original; }
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        assert.equal(service.calls.length, 1);
        assert.equal(filter.readFilter({ filterRoot: f.dirs.filters, filterId }).decisions[pid('100')].status, 'included');
    });
});

test('live concurrent runner cannot race a paid request', async t => {
    const service = await serverFixture(t, [{ delayMs: 100,
        body: chatResponse('{"decision":"included","reason":"Audio is primary."}') }]);
    const f = fixture(t, service.endpoint);
    const first = runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /locked by a live process/);
    await first; assert.equal(service.calls.length, 1);
});

test('endpoint and request drift fail before a second transport', async t => {
    const service = await serverFixture(t); const other = await serverFixture(t); const f = fixture(t, service.endpoint);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files,
        env: { ...f.env, PAPER_ANALYZER_ENDPOINT: other.endpoint } }), /endpoint differs/);
    assert.equal(service.calls.length + other.calls.length, 0);
    const original = fs.openSync; let injected = false;
    fs.openSync = function (filename, ...rest) {
        if (!injected && String(filename).includes('/decisions/llm-')) { injected = true; const error = new Error('EIO'); error.code = 'EIO'; throw error; }
        return original.call(this, filename, ...rest);
    };
    try { await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /EIO/); }
    finally { fs.openSync = original; }
    const intentFile = onlyJson(path.join(f.dirs.filters, filterId, 'llm-intents'));
    const intent = JSON.parse(fs.readFileSync(intentFile)); const request = JSON.parse(Buffer.from(intent.request.data, 'base64'));
    const envelope = JSON.parse(request.messages[1].content); envelope.metadataRecord.title = 'tampered';
    envelope.discovery.metadataRecordSha256 = filter.stableHash(envelope.metadataRecord);
    const envelopeBody = { ...envelope }; delete envelopeBody.requestSha256; envelope.requestSha256 = filter.stableHash(envelopeBody);
    request.messages[1].content = JSON.stringify(envelope); const requestBytes = Buffer.from(JSON.stringify(request));
    intent.request = { encoding: 'base64', size: requestBytes.length, sha256: sha(requestBytes), data: requestBytes.toString('base64') };
    intent.requestEnvelopeSha256 = envelope.requestSha256; const intentBody = { ...intent }; delete intentBody.intentSha256;
    intent.intentSha256 = filter.stableHash(intentBody); fs.writeFileSync(intentFile, `${JSON.stringify(intent, null, 2)}\n`);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /source metadata/);
    assert.equal(service.calls.length, 1);
});

test('lock reclaim is fail-closed for live owners and safe for a stale dead owner', async t => {
    const service = await serverFixture(t); const f = fixture(t, service.endpoint);
    const directory = path.join(f.dirs.filters, filterId); const lock = path.join(directory, 'operation.lock');
    function writeLock(processId) {
        fs.mkdirSync(lock, { mode: 0o700 });
        const body = { contract: filter.LOCK_OWNER_CONTRACT, version: filter.VERSION, owner: 'fixture.lock', pid: processId,
            hostname: os.hostname(), token: lockToken, startedAt: stamp, heartbeatAt: stamp, leaseMs: filter.LOCK_STALE_MS };
        const record = { ...body, ownerSha256: filter.stableHash(body) };
        fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        const old = new Date(Date.now() - filter.LOCK_STALE_MS - 60_000);
        fs.utimesSync(path.join(lock, 'owner.json'), old, old); fs.utimesSync(lock, old, old);
    }
    writeLock(process.pid);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /locked by a live process/);
    fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
    fs.symlinkSync(f.root, lock);
    await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /unsafe|canonical/);
    fs.unlinkSync(lock);
    writeLock(99999999);
    await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
    assert.equal(service.calls.length, 1);
});

test('oversize request is rejected before transport and malformed provider bytes are not copied into reason', async t => {
    await t.test('oversize metadata', async t => {
        const service = await serverFixture(t); const huge = 'x'.repeat(filter.MAX_LLM_REQUEST_BYTES + 1024);
        const f = fixture(t, service.endpoint, [{ arnumber: '100', title: 'Speech', supplemental: huge }]);
        await assert.rejects(() => runner.main(args(['--limit', '1']), { files: f.files, env: f.env }), /durable evidence limit/);
        assert.equal(service.calls.length, 0);
    });
    await t.test('malformed raw response', async t => {
        const service = await serverFixture(t, [{ raw: 'provider-secret-fragment:not-json' }]); const f = fixture(t, service.endpoint);
        await runner.main(args(['--limit', '1']), { files: f.files, env: f.env });
        const decision = filter.readFilter({ filterRoot: f.dirs.filters, filterId }).decisions[pid('100')];
        assert.equal(decision.status, 'failed'); assert.doesNotMatch(decision.reason, /provider-secret-fragment/);
    });
});

test('runner CLI parser rejects unsafe or ambiguous retry controls', () => {
    assert.throws(() => runner.parseArgs(['--apply', '--catalog', '../x.json']), /safe|Missing|Use/);
    assert.throws(() => runner.parseArgs(['--dry-run', '--catalog', 'x.json']), /must be --apply/);
    assert.throws(() => runner.parseArgs([...args(), '--retry-failed', '--retry-failed']), /Use/);
    assert.equal(runner.parseArgs([...args(), '--retry-failed']).retryFailed, true);
    assert.throws(() => filter.parseLlmDecisionText('{"decision":"included","reason":"x","extra":1}'), /unknown or missing/);
    assert.throws(() => filter.parseLlmDecisionText('```json\n{}\n```'), /strict JSON/);
});

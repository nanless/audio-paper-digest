'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('../scripts/lib/arxiv-source-authority.js');
const authorityApi = require('../scripts/lib/paper-source-authority.js');
const cli = require('../scripts/arxiv-source-authority.js');
const deep = require('../scripts/deep-analyzer.js');

const stamp = '2026-09-07T00:00:00.000Z';
const operationId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'arxiv-source-adapter-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function source(id = '2601.00001') {
    const text = `${'Official paper body with methods, experiments, evidence, and references. '.repeat(200)}\n`;
    const flattenedTextSha256 = crypto.createHash('sha256').update(text).digest('hex');
    const artifactBody = { version: 1, source: 'arxiv_html', tables: [], formulas: [], flattenedTextSha256 };
    return { text, source: 'html', sourceId: id, imageInfos: [], readerAuthors: [], htmlAvailability: 'available',
        htmlAttempts: 1, warnings: [], structuredArtifacts: { ...artifactBody,
            payloadSha256: crypto.createHash('sha256').update(JSON.stringify(artifactBody)).digest('hex') } };
}
function mockOfficialFetcher(t, implementation) {
    const original = deep.fetchArxivTextDetailed;
    deep.fetchArxivTextDetailed = implementation;
    t.after(() => { deep.fetchArxivTextDetailed = original; });
}

test('dry-run validates direct identity/name but performs no network or writes', async t => {
    const parent = fixture(t); const root = path.join(parent, 'missing-authority-root'); let calls = 0;
    mockOfficialFetcher(t, async () => { calls++; return source(); });
    const result = await api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: 'arxiv-2601.00001.json' });
    assert.equal(result.status, 'dry-run'); assert.equal(calls, 0); assert.equal(fs.existsSync(root), false);
    assert.throws(() => api.namesFor('../escape.json', '2601.00001'), /safe direct/);
    assert.throws(() => api.identityFor('2601.00001v2'), /versionless/);
});

test('apply preserves request/source/snapshot/receipt/authority and recovers without refetching', async t => {
    const root = fixture(t); let calls = 0;
    mockOfficialFetcher(t, async id => { calls++; return source(id); });
    const options = { authorityRoot: root, arxivId: '2601.00001', authorityName: 'arxiv-2601.00001.json',
        apply: true, now: stamp, operationId };
    const created = await api.prepareArxivSourceAuthority(options);
    assert.equal(created.status, 'created'); assert.equal(calls, 1);
    assert.equal(authorityApi.authorityHandleSnapshot(created.authorityHandle).productionAuthorized, true);
    const liveDetails = api.readLiveProductionSourceDetails(created.authorityHandle);
    assert.equal(liveDetails.text, source().text);
    assert.deepEqual(liveDetails.imageInfos, []);
    assert.equal(liveDetails.structuredArtifacts.flattenedTextSha256,
        authorityApi.authorityHandleSnapshot(created.authorityHandle).fulltextSha256);
    for (const name of Object.values(created.artifacts)) {
        const file = path.join(root, name); assert.equal(fs.existsSync(file), true);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    const recovered = await api.prepareArxivSourceAuthority(options);
    assert.equal(recovered.status, 'recovered'); assert.equal(calls, 1);
    assert.equal(authorityApi.authorityHandleSnapshot(recovered.authorityHandle).productionAuthorized, false);
    assert.throws(() => authorityApi.replayAuthorityHandle(recovered.authorityHandle, { requireProduction: true }), /production-authorized/);
    const durableOnly = authorityApi.loadAuthorityHandle({ authorityRoot: root, authorityName: options.authorityName });
    assert.equal(authorityApi.authorityHandleSnapshot(durableOnly).productionAuthorized, false);
    assert.throws(() => api.readLiveProductionSourceDetails(durableOnly), /authenticated paper source authority handle|required/);
    const live = await api.prepareArxivSourceAuthority({ ...options, requireLiveAuthorization: true });
    assert.equal(live.status, 'live-verified'); assert.equal(calls, 2);
    assert.equal(authorityApi.authorityHandleSnapshot(
        authorityApi.replayAuthorityHandle(live.authorityHandle, { requireProduction: true })).productionAuthorized, true);
});

test('recovery resumes after durable request and refuses partial or changed source evidence', async t => {
    const root = fixture(t); const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const request = api.requestFor({ arxivId: '2601.00001', authorityName: names.authorityName, operationId, now: stamp });
    fs.writeFileSync(path.join(root, names.requestName), authorityApi.prettyBytes(request), { mode: 0o600 });
    let calls = 0;
    mockOfficialFetcher(t, async () => { calls++; return source(); });
    await api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: names.authorityName, apply: true, now: stamp, operationId });
    assert.equal(calls, 1);
    fs.appendFileSync(path.join(root, names.fulltextName), 'tamper');
    assert.throws(() => authorityApi.loadAuthorityHandle({ authorityRoot: root,
        authorityName: names.authorityName }), /chain drifted|proof file\/SHA drifted/);
});

test('partial source pair is fail-closed and generated fields/source aliases are rejected', async t => {
    const root = fixture(t); const names = api.namesFor('arxiv-2601.00001.json', '2601.00001');
    const request = api.requestFor({ arxivId: '2601.00001', authorityName: names.authorityName, operationId, now: stamp });
    fs.writeFileSync(path.join(root, names.requestName), authorityApi.prettyBytes(request), { mode: 0o600 });
    fs.writeFileSync(path.join(root, names.fulltextName), 'partial', { mode: 0o600 });
    mockOfficialFetcher(t, async () => source());
    await assert.rejects(api.prepareArxivSourceAuthority({ authorityRoot: root, arxivId: '2601.00001',
        authorityName: names.authorityName, apply: true }), /partial source evidence/);
    assert.throws(() => api.normalizeFetchedSource({ ...source(), analysis: 'old prose' }, '2601.00001', stamp), /generated/);
    assert.throws(() => api.normalizeFetchedSource(source('2601.99999'), '2601.00001', stamp), /another paper/);
});

test('CLI accepts only explicit mode, normalized ID and direct authority name', async t => {
    const root = fixture(t);
    assert.throws(() => cli.parseArgs(['--apply', '--id', '2601.00001v2', '--authority', 'arxiv-2601.00001.json']), /versionless/);
    const output = await cli.main(['--dry-run', '--id', '2601.00001', '--authority', 'arxiv-2601.00001.json'],
        { files: { paperSourceAuthorityDir: root } });
    assert.equal(output.status, 'dry-run'); assert.equal(output.productionAuthorized, false);
});

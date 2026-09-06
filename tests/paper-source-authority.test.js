'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/paper-source-authority.js');
const identityApi = require('../scripts/lib/paper-identity.js');
const contextApi = require('../scripts/lib/conference-source-context.js');
const { productionPlanFixture } = require('./helpers/conference-production-plan-fixture.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function writeJson(root, name, value) { const bytes = api.prettyBytes(value); fs.writeFileSync(path.join(root, name), bytes, { mode: 0o600 }); return sha(bytes); }
function seal(body, field) { return { ...body, [field]: api.stableHash(body) }; }

function arxivFixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'paper-source-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperId = 'arxiv:2601.00001'; const fulltextName = 'paper.txt';
    const text = `${'full source evidence '.repeat(1200)}\n`; fs.writeFileSync(path.join(root, fulltextName), text, { mode: 0o600 });
    const fulltextSha256 = sha(text); const snapshotName = 'snapshot.json';
    const snapshot = seal({ contract: api.ARXIV_SNAPSHOT_CONTRACT, version: api.VERSION, paperId,
        arxivId: '2601.00001', officialUrl: 'https://arxiv.org/abs/2601.00001', fulltextSha256 }, 'snapshotSha256');
    const snapshotFileSha256 = writeJson(root, snapshotName, snapshot); const receiptName = 'source-receipt.json';
    const receipt = seal({ contract: api.ARXIV_RECEIPT_CONTRACT, version: api.VERSION,
        snapshotName, snapshotFileSha256, snapshotSha256: snapshot.snapshotSha256,
        fulltextName, fulltextSha256 }, 'receiptSha256');
    const receiptFileSha256 = writeJson(root, receiptName, receipt);
    const identity = { contract: identityApi.CONTRACT, kind: 'arxiv', canonicalId: paperId,
        arxivId: '2601.00001', conference: null, externalId: null,
        source: { status: 'official', url: 'https://arxiv.org/abs/2601.00001' }, citation: null };
    const body = { contract: api.CONTRACT, version: api.VERSION, paperId, identity,
        identitySha256: identityApi.identitySha256(identity), identityRecordSha256: identityApi.recordSha256(identity),
        evidenceKind: 'arxiv-official-fulltext',
        proof: { snapshotName, snapshotFileSha256, snapshotSha256: snapshot.snapshotSha256,
            receiptName, receiptFileSha256, receiptSha256: receipt.receiptSha256,
            fulltextName, fulltextSha256 } };
    const authority = seal(body, 'authoritySha256'); writeJson(root, 'authority.json', authority);
    return { root, paperId, authority };
}

test('arXiv authority replays canonical identity, official snapshot/receipt and exact full text into an opaque handle', t => {
    const f = arxivFixture(t); const handle = api.loadAuthorityHandle({ authorityRoot: f.root, authorityName: 'authority.json' });
    const snapshot = api.authorityHandleSnapshot(handle);
    assert.equal(snapshot.authority.paperId, f.paperId); assert.equal(snapshot.fulltextSha256, f.authority.proof.fulltextSha256);
    assert.equal(snapshot.productionAuthorized, false);
    assert.throws(() => api.replayAuthorityHandle(handle, { requireProduction: true }), /production-authorized/);
    assert.throws(() => api.authorityHandleSnapshot(structuredClone(handle)), /authenticated/);
    fs.appendFileSync(path.join(f.root, 'paper.txt'), 'drift');
    assert.throws(() => api.loadAuthorityHandle({ authorityRoot: f.root, authorityName: 'authority.json' }), /proof file\/SHA drifted/);
});

test('arXiv authority rejects title-like self claims, unsafe files and mismatched official source identity', t => {
    const f = arxivFixture(t); const changed = structuredClone(f.authority);
    changed.identity.source.url = 'https://arxiv.org/abs/2601.00002';
    const body = structuredClone(changed); delete body.authoritySha256; changed.authoritySha256 = api.stableHash(body);
    writeJson(f.root, 'wrong.json', changed);
    assert.throws(() => api.loadAuthorityHandle({ authorityRoot: f.root, authorityName: 'wrong.json' }), /official arxiv|paperId\/identity/);
    fs.symlinkSync(path.join(f.root, 'authority.json'), path.join(f.root, 'linked.json'));
    assert.throws(() => api.loadAuthorityHandle({ authorityRoot: f.root, authorityName: 'linked.json' }), /single-link/);

    const noncanonical = JSON.stringify(f.authority, null, 2) + '\n';
    assert.notEqual(noncanonical, api.prettyBytes(f.authority).toString('utf8'));
    fs.writeFileSync(path.join(f.root, 'noncanonical.json'), noncanonical, { mode: 0o600 });
    assert.throws(() => api.loadAuthorityHandle({ authorityRoot: f.root,
        authorityName: 'noncanonical.json' }), /canonical pretty JSON/);

    const citation = structuredClone(f.authority);
    citation.identity.citation = { title: 'Legacy page title', authors: ['Unverified Author'], venue: null, year: 2026 };
    citation.identityRecordSha256 = identityApi.recordSha256(citation.identity);
    const citationBody = structuredClone(citation); delete citationBody.authoritySha256;
    citation.authoritySha256 = api.stableHash(citationBody); writeJson(f.root, 'citation.json', citation);
    assert.throws(() => api.loadAuthorityHandle({ authorityRoot: f.root,
        authorityName: 'citation.json' }), /citation must be null/);
});

test('conference authority requires and replays a real plan/import/ledger/source-context chain', t => {
    const fixture = productionPlanFixture(t); const root = path.join(fixture.root, 'authorities'); fs.mkdirSync(root, { mode: 0o700 });
    const context = contextApi.buildConferenceSourceContext({ planHandle: fixture.planHandle,
        paperId: fixture.paperId, sourceRoot: fixture.sourceRoot });
    const sourceContextName = 'conference-context.json'; const sourceContextFileSha256 = writeJson(root, sourceContextName, context);
    const identity = { contract: identityApi.CONTRACT, kind: 'conference', canonicalId: fixture.paperId,
        arxivId: null, conference: { slug: 'icassp', year: 2026 },
        externalId: { scheme: 'icassp-arnumber', value: '100' },
        source: { status: 'unavailable', url: null }, citation: null };
    const proof = { sourceContextName, sourceContextFileSha256, sourceContextSha256: api.stableHash(context),
        sourceSnapshotSha256: context.sourceSnapshotSha256,
        observationBindingSha256: context.observationBindingSha256,
        planAuthorityBindingSha256: context.productionAuthorization.binding.bindingSha256,
        fulltextSha256: sha(Buffer.from(context.text, 'utf8')) };
    const body = { contract: api.CONTRACT, version: api.VERSION, paperId: fixture.paperId, identity,
        identitySha256: identityApi.identitySha256(identity), identityRecordSha256: identityApi.recordSha256(identity),
        evidenceKind: 'conference-plan-source-context', proof };
    writeJson(root, 'conference-authority.json', seal(body, 'authoritySha256'));
    assert.throws(() => api.loadAuthorityHandle({ authorityRoot: root,
        authorityName: 'conference-authority.json' }), /live authenticated plan handle/);
    const handle = api.loadAuthorityHandle({ authorityRoot: root, authorityName: 'conference-authority.json',
        conferencePlanHandle: fixture.planHandle, conferenceSourceRoot: fixture.sourceRoot });
    assert.equal(api.authorityHandleSnapshot(handle).authority.paperId, fixture.paperId);
    assert.equal(api.authorityHandleSnapshot(handle).productionAuthorized, true);
    assert.equal(api.authorityHandleSnapshot(api.replayAuthorityHandle(handle, { requireProduction: true }))
        .authority.paperId, fixture.paperId);
});

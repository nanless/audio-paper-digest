'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-archive-crawl-authority.js');
const paperAuthority = require('../scripts/lib/paper-source-authority.js');
const { originalCrawlApi, savedCrawlFixture } = require('./helpers/original-crawl-authority');
const original = originalCrawlApi('archive');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'archive-crawl-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, 'data'); const day = path.join(dataRoot, 'archive', '2026-02-03');
    fs.mkdirSync(day, { recursive: true, mode: 0o700 });
    const record = { arxivId: '2602.00001', paper_id: '2602.00001', title: 'Source metadata', abstract: 'Metadata only',
        authors: ['A'], categories: ['cs.SD'], source: 'arxiv', sources: ['arxiv'] };
    fs.writeFileSync(path.join(day, 'filtered-papers.json'), JSON.stringify({ papers: [record] }), { mode: 0o600 });
    fs.mkdirSync(path.join(dataRoot, 'current'), { mode: 0o700 });
    fs.writeFileSync(path.join(dataRoot, 'current', 'filtered-papers.json'), JSON.stringify({ papers: [{ ...record,
        arxivId: '2602.99999', paper_id: '2602.99999' }] }), { mode: 0o600 });
    return { root, dataRoot, identityRoot: path.join(root, 'identities'), record };
}

test('原归档凭据按真实原字节只读复核，保留身份而不提供全文', t => {
    const f = fixture(t); const index = original.scanRetainedFilteredPapers({ dataRoot: f.dataRoot });
    assert.deepEqual(index.files.map(item => item.relativePath), ['archive/2026-02-03/filtered-papers.json']);
    assert.equal(index.matches.has('2602.99999'), false);
    const match = index.matches.get('2602.00001')[0];
    const prepared = savedCrawlFixture('archive', { identityRoot: f.identityRoot, dataRoot: f.dataRoot,
        arxivId: '2602.00001', match });
    const file = path.join(f.identityRoot, prepared.authorityName), before = fs.readFileSync(file);
    const snapshot = api.authorityHandleSnapshot(prepared.authorityHandle);
    assert.equal(snapshot.productionAuthorized, true);
    assert.equal(snapshot.authority.contract, original.CONTRACT);
    assert.equal(snapshot.authority.evidenceKind, api.EVIDENCE_KIND);
    assert.equal(snapshot.authority.archiveRelativePath, 'archive/2026-02-03/filtered-papers.json');
    assert.equal('fulltextSha256' in snapshot, false);
    assert.throws(() => paperAuthority.replayAuthorityHandle(prepared.authorityHandle), /authenticated paper source authority/);
    assert.equal(api.replayAuthorityHandle(prepared.authorityHandle, { requireProduction: true }), prepared.authorityHandle);
    assert.ok(api.loadArchiveCrawlAuthorityHandle({ identityRoot: f.identityRoot, dataRoot: f.dataRoot,
        authorityName: prepared.authorityName }));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(api.prepareArchiveCrawlAuthority, undefined);
    assert.equal(api.scanRetainedFilteredPapers, undefined);
    fs.appendFileSync(path.join(f.dataRoot, 'archive', '2026-02-03', 'filtered-papers.json'), ' ');
    assert.throws(() => api.replayAuthorityHandle(prepared.authorityHandle, { requireProduction: true }), /retained filtered snapshot no longer matches/);
});

test('退役归档读取器拒绝替换稳定头、换用当前论文身份或篡改原记录 ID', t => {
    const f = fixture(t), codec = require('../scripts/lib/protocol-codec');
    const ids = require('../scripts/lib/paper-identity');
    const arxivId = '2602.00001';
    const prepared = savedCrawlFixture('archive', { identityRoot: f.identityRoot, dataRoot: f.dataRoot, arxivId,
        match: original.scanRetainedFilteredPapers({ dataRoot: f.dataRoot }).matches.get(arxivId)[0] });
    const saved = api.authorityHandleSnapshot(prepared.authorityHandle).authority;
    const { contract, version, authoritySha256: ignored, ...body } = saved;
    const reseal = value => ({ ...value, authoritySha256: api.stableHash(value) });
    assert.throws(() => api.normalizeAuthority(reseal(codec.record('historical-archive-crawl-identity-authority', body))), /只接受已登记的原历史格式/);
    const { contract: originalTag, ...identityFields } = body.identity;
    const identity = ids.createIdentity(identityFields);
    assert.throws(() => api.normalizeAuthority(reseal({ contract, version, ...body, identity,
        identitySha256: ids.identitySha256(identity), identityRecordSha256: ids.recordSha256(identity) })), /不能换用当前论文身份/);
    const record = { ...body.record, paper_id: '2602.00002' };
    assert.throws(() => api.normalizeAuthority(reseal({ contract, version, ...body, record, recordSha256: api.stableHash(record) })), /arXiv ID/);
});

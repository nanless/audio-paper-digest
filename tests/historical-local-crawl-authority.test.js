'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const local = require('../scripts/lib/historical-local-crawl-authority.js');
const legacy = require('../scripts/lib/historical-archive-crawl-authority.js');
const paperAuthority = require('../scripts/lib/paper-source-authority.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'local-crawl-authority-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, 'data'); const archive = path.join(dataRoot, 'archive', '2026-02-03'); const current = path.join(dataRoot, 'current');
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 }); fs.mkdirSync(current, { mode: 0o700 });
    const archiveRecord = { arxivId: '2602.00001', paper_id: '2602.00001', title: 'Archived metadata', abstract: 'Do not copy.' };
    fs.writeFileSync(path.join(archive, 'filtered-papers.json'), JSON.stringify({ papers: [archiveRecord] }), { mode: 0o600 });
    const currentId = '2602.99999';
    const currentRecord = { arxivId: currentId, title: 'Crawler content must not enter authority', abstract: 'Neither title nor body can match.',
        analysis: { generated: 'discarded' }, apiReader: { generated: 'discarded' } };
    fs.writeFileSync(path.join(current, 'papers.json'), JSON.stringify({ generation: 7, papers: { [currentId]: currentRecord } }), { mode: 0o600 });
    return { root, dataRoot, archiveRecord, currentId, identityRoot: path.join(root, 'local-identities'), snapshotRoot: path.join(root, 'identity-snapshots'), legacyIdentityRoot: path.join(root, 'legacy-identities') };
}

test('current papers map accepts no paper_id, stores only ID/SHA evidence, and replays after current changes', t => {
    const f = fixture(t); const index = local.scanLocalCrawlPapers({ dataRoot: f.dataRoot });
    const current = index.matches.get(f.currentId).find(item => item.sourceKind === 'current');
    assert.deepEqual(current.recordIdentity, { arxivId: f.currentId, paperId: f.currentId });
    assert.equal(current.recordPointer.value, f.currentId);
    const prepared = local.prepareLocalCrawlAuthority({ identityRoot: f.identityRoot, snapshotRoot: f.snapshotRoot, dataRoot: f.dataRoot,
        arxivId: f.currentId, match: current, apply: true });
    const snapshot = local.authorityHandleSnapshot(prepared.authorityHandle);
    assert.equal(snapshot.authority.contract, local.CONTRACT);
    assert.equal(snapshot.authority.sourceRelativePath, 'current/papers.json');
    assert.equal(snapshot.authority.currentIdentitySnapshot !== null, true);
    const serialized = JSON.stringify(snapshot.authority);
    for (const forbidden of ['Crawler content must not enter authority', 'Neither title nor body can match.', 'generated', 'analysis', 'apiReader', 'abstract', 'title']) {
        assert.equal(serialized.includes(forbidden), false);
    }
    assert.throws(() => paperAuthority.replayAuthorityHandle(prepared.authorityHandle), /authenticated paper source authority/);
    fs.writeFileSync(path.join(f.dataRoot, 'current', 'papers.json'), JSON.stringify({ generation: 8, papers: { '2603.00001': { arxivId: '2603.00001' } } }), { mode: 0o600 });
    assert.equal(local.replayAuthorityHandle(prepared.authorityHandle, { requireProduction: true }), prepared.authorityHandle);
    assert.ok(local.loadLocalCrawlAuthorityHandle({ identityRoot: f.identityRoot, snapshotRoot: f.snapshotRoot,
        dataRoot: f.dataRoot, authorityName: prepared.authorityName }));
});

test('current papers reader admits a 126 MiB valid snapshot within its 128 MiB bound', t => {
    const f = fixture(t); const filename = path.join(f.dataRoot, 'current', 'papers.json');
    const prefix = JSON.stringify({ papers: { '2602.99999': { arxivId: '2602.99999' } }, padding: '' });
    const bytes = (126 * 1024 * 1024) - Buffer.byteLength(prefix) + 1;
    fs.writeFileSync(filename, JSON.stringify({ papers: { '2602.99999': { arxivId: '2602.99999' } }, padding: 'x'.repeat(bytes) }), { mode: 0o600 });
    const loaded = local.readLocalCrawlFile(f.dataRoot, 'current/papers.json');
    assert.ok(loaded.bytes.length >= 126 * 1024 * 1024);
    assert.equal(loaded.records.filter(item => item.identity).length, 1);
});

test('legacy archive identities replay through the separate legacy root without state migration', t => {
    const f = fixture(t); const archiveFile = path.join(f.dataRoot, 'archive', '2026-02-03', 'filtered-papers.json');
    const records = Array.from({ length: 5 }, (_value, index) => {
        const id = `2602.0000${index + 1}`; return { arxivId: id, paper_id: id, title: `metadata ${index}` };
    });
    fs.writeFileSync(archiveFile, JSON.stringify({ papers: records }), { mode: 0o600 });
    const index = legacy.scanRetainedFilteredPapers({ dataRoot: f.dataRoot });
    const names = [];
    for (const record of records) {
        const prepared = legacy.prepareArchiveCrawlAuthority({ identityRoot: f.legacyIdentityRoot, dataRoot: f.dataRoot,
            arxivId: record.arxivId, match: index.matches.get(record.arxivId)[0], apply: true });
        names.push(prepared.authorityName);
    }
    for (const authorityName of names) {
        const handle = local.loadLocalCrawlAuthorityHandle({ identityRoot: f.identityRoot, legacyIdentityRoot: f.legacyIdentityRoot,
            snapshotRoot: f.snapshotRoot, dataRoot: f.dataRoot, authorityName });
        assert.equal(local.authorityHandleSnapshot(handle).authority.contract, local.LEGACY_CONTRACT);
        assert.equal(local.replayAuthorityHandle(handle, { requireProduction: true }), handle);
    }
    assert.equal(fs.existsSync(f.identityRoot), false);
});

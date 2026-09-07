'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-archive-crawl-authority.js');
const paperAuthority = require('../scripts/lib/paper-source-authority.js');

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

test('retained archive scan excludes current and writes a replayable identity-only authority', t => {
    const f = fixture(t); const index = api.scanRetainedFilteredPapers({ dataRoot: f.dataRoot });
    assert.deepEqual(index.files.map(item => item.relativePath), ['archive/2026-02-03/filtered-papers.json']);
    assert.equal(index.matches.has('2602.99999'), false);
    const match = index.matches.get('2602.00001')[0];
    const prepared = api.prepareArchiveCrawlAuthority({ identityRoot: f.identityRoot, dataRoot: f.dataRoot,
        arxivId: '2602.00001', match, apply: true });
    const snapshot = api.authorityHandleSnapshot(prepared.authorityHandle);
    assert.equal(snapshot.productionAuthorized, true);
    assert.equal(snapshot.authority.contract, api.CONTRACT);
    assert.equal(snapshot.authority.evidenceKind, api.EVIDENCE_KIND);
    assert.equal(snapshot.authority.archiveRelativePath, 'archive/2026-02-03/filtered-papers.json');
    assert.equal('fulltextSha256' in snapshot, false);
    assert.throws(() => paperAuthority.replayAuthorityHandle(prepared.authorityHandle), /authenticated paper source authority/);
    assert.equal(api.replayAuthorityHandle(prepared.authorityHandle, { requireProduction: true }), prepared.authorityHandle);
    assert.equal(api.prepareArchiveCrawlAuthority({ identityRoot: f.identityRoot, dataRoot: f.dataRoot,
        arxivId: '2602.00001', match, apply: true }).status, 'recovered');
    fs.appendFileSync(path.join(f.dataRoot, 'archive', '2026-02-03', 'filtered-papers.json'), ' ');
    assert.throws(() => api.replayAuthorityHandle(prepared.authorityHandle, { requireProduction: true }), /retained filtered snapshot no longer matches/);
});

test('archive authority rejects a record that is not an exact normalized arXiv ID pair', t => {
    const f = fixture(t); const filename = path.join(f.dataRoot, 'archive', '2026-02-03', 'filtered-papers.json');
    fs.writeFileSync(filename, JSON.stringify({ papers: [{ ...f.record, paper_id: '2602.00002' }] }), { mode: 0o600 });
    const index = api.scanRetainedFilteredPapers({ dataRoot: f.dataRoot });
    assert.equal(index.matches.size, 0);
});

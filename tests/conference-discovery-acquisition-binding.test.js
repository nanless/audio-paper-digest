'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acquisition = require('../scripts/lib/official-conference-acquisition.js');
const discovery = require('../scripts/lib/conference-discovery.js');
const cli = require('../scripts/conference-discover.js');

const STAMP = '2026-09-09T00:00:00.000Z';
const INDEX_HTML = '<!doctype html><article class="acl-paper"><a class="title" href="/2026.iwslt-1.1/">Simultaneous Translation</a><div class="acl-paper-authors"><a>Alice Example</a><a>Bob Example</a></div><div class="abstract">Translation evidence.</div></article>';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-acquisition-binding-'));
    for (const directory of ['responses', 'pdfs', 'receipts']) fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const provider = acquisition.providerFor('iwslt-2026');
    const indexBytes = Buffer.from(INDEX_HTML);
    fs.writeFileSync(path.join(root, 'responses/index.html'), indexBytes, { mode: 0o600 });
    const responseBody = { contract: acquisition.HTTP_RECEIPT_CONTRACT, version: acquisition.VERSION,
        providerId: provider.conference.id, resource: 'catalog-index', requestedUrl: provider.indexUrl,
        finalUrl: provider.indexUrl, redirects: [], responseStatus: 200, contentType: 'text/html',
        observedAt: STAMP, body: { relativePath: 'responses/index.html', bytes: indexBytes.length,
            sha256: acquisition.sha256(indexBytes) } };
    const response = { ...responseBody, receiptSha256: acquisition.stableHash(responseBody) };
    const responseBytes = acquisition.prettyBytes(response);
    fs.writeFileSync(path.join(root, 'responses/index.receipt.json'), responseBytes, { mode: 0o600 });

    const metadata = acquisition.parseCatalog(provider.conference.id, INDEX_HTML);
    const metadataBytes = acquisition.prettyBytes(metadata);
    fs.writeFileSync(path.join(root, 'metadata.json'), metadataBytes, { mode: 0o600 });
    const catalogBody = { contract: acquisition.CATALOG_RECEIPT_CONTRACT, version: acquisition.VERSION,
        providerId: provider.conference.id, parserVersion: acquisition.PARSER_VERSION,
        indexReceiptSha256: response.receiptSha256, indexReceiptFileSha256: acquisition.sha256(responseBytes),
        metadata: { relativePath: 'metadata.json', bytes: metadataBytes.length, sha256: acquisition.sha256(metadataBytes) },
        paperSetSha256: acquisition.stableHash(metadata.papers) };
    const catalog = { ...catalogBody, receiptSha256: acquisition.stableHash(catalogBody) };
    fs.writeFileSync(path.join(root, 'catalog.receipt.json'), acquisition.prettyBytes(catalog), { mode: 0o600 });

    for (const paper of metadata.papers) {
        const pdfBytes = Buffer.from('%PDF-1.7\nfixture pdf\n');
        fs.writeFileSync(path.join(root, paper.pdfFile), pdfBytes, { mode: 0o600 });
        const receiptBody = { contract: acquisition.PDF_RECEIPT_CONTRACT, version: acquisition.VERSION,
            providerId: provider.conference.id, paperId: paper.id, metadataSha256: acquisition.sha256(metadataBytes),
            requestedUrl: paper.pdfUrl, finalUrl: paper.pdfUrl, redirects: [], responseStatus: 200,
            contentType: 'application/pdf', observedAt: STAMP,
            pdf: { relativePath: paper.pdfFile, bytes: pdfBytes.length, sha256: acquisition.sha256(pdfBytes) } };
        fs.writeFileSync(path.join(root, 'receipts', `${paper.id}.json`),
            acquisition.prettyBytes({ ...receiptBody, receiptSha256: acquisition.stableHash(receiptBody) }), { mode: 0o600 });
    }
    return { root, metadataFile: path.join(root, 'metadata.json'), provider };
}

test('new official discovery binds and replays the complete acquisition receipt chain', t => {
    const f = fixture(t);
    const found = discovery.discoverConference({ adapter: 'official-proceedings', conferenceId: 'iwslt-2026',
        year: 2026, metadataFile: f.metadataFile, pdfRoot: f.root, acquisitionRoot: f.root });
    assert.equal(found.manifest.acquisitionReceipt.providerId, f.provider.conference.id);
    const catalogFile = path.join(f.root, 'candidate.json'); const reportFile = path.join(f.root, 'report.json');
    fs.writeFileSync(catalogFile, discovery.canonicalBytes(found.manifest), { mode: 0o600 });
    fs.writeFileSync(reportFile, discovery.canonicalBytes(found.report), { mode: 0o600 });
    assert.doesNotThrow(() => discovery.loadDiscoveryHandle(catalogFile, reportFile));

    const receiptFile = path.join(f.root, 'catalog.receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    receipt.paperSetSha256 = 'f'.repeat(64);
    fs.writeFileSync(receiptFile, acquisition.prettyBytes(receipt), { mode: 0o600 });
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /catalog receipt|acquisition receipt|paper set/i);
});

test('new-conference CLI rejects official discovery without acquisition-root', t => {
    const f = fixture(t);
    const previous = process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
    process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = '1';
    t.after(() => {
        if (previous === undefined) delete process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;
        else process.env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE = previous;
    });
    assert.throws(() => cli.main(['--dry-run', '--adapter', 'official-proceedings', '--conference-id', 'iwslt-2026',
        '--year', '2026', '--metadata', f.metadataFile, '--pdf-root', f.root]), /acquisition-root/);
});

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const discovery = require('../scripts/lib/conference-discovery.js');
const cli = require('../scripts/conference-discover.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-discovery-'));
    const pdf = path.join(root, 'pdf'); const catalogs = path.join(root, 'catalogs'); const reports = path.join(root, 'reports');
    fs.mkdirSync(pdf, { mode: 0o700 }); fs.mkdirSync(catalogs, { mode: 0o700 }); fs.mkdirSync(reports, { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, pdf, catalogs, reports, metadata: path.join(root, 'metadata.json') };
}

function writePdf(root, relative, content = 'fixture') {
    const filename = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, `%PDF-1.7\n${content}`, { mode: 0o600 });
    return filename;
}

function writeJson(filename, value) {
    fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
}

function writeCanonical(filename, value) {
    fs.writeFileSync(filename, discovery.canonicalBytes(value), { mode: 0o600 });
}

test('ICASSP freezes metadata/catalog bytes and reports exact, normalized, ambiguous, unmatched without verification', t => {
    const f = fixture(t);
    writeJson(f.metadata, [
        { arnumber: '100', title: 'Exact Paper' },
        { arnumber: '200', title: 'Normalized: Paper!' },
        { arnumber: '300', title: 'Duplicate Paper' },
        { arnumber: '400', title: 'No PDF' }
    ]);
    writePdf(f.pdf, 'Exact Paper.pdf', 'exact');
    writePdf(f.pdf, 'normalized paper.pdf', 'normalized');
    writePdf(f.pdf, 'a/Duplicate Paper.pdf', 'duplicate-a');
    writePdf(f.pdf, 'b/Duplicate Paper.pdf', 'duplicate-b');
    writePdf(f.pdf, 'orphan.pdf', 'orphan');
    const { manifest, report } = discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.equal(manifest.contract, discovery.CONTRACT);
    assert.deepEqual(manifest.members.map(member => member.match.kind), ['exact', 'normalized', 'ambiguous', 'unmatched']);
    assert.equal(Object.hasOwn(manifest.members[0], 'status'), false);
    assert.equal(Object.hasOwn(manifest.members[0], 'verified'), false);
    assert.equal(manifest.metadataSnapshot.sha256, sha(fs.readFileSync(f.metadata)));
    assert.equal(manifest.pdfCatalog.length, 5);
    assert.equal(report.candidateManifestSha256, sha(discovery.canonicalBytes(manifest)));
    assert.deepEqual(report.counts, { metadataRecords: 4, pdfFiles: 5, exact: 1, normalized: 1, ambiguous: 1, unmatched: 1, orphanPdfFiles: 1 });
});

test('duplicate ICASSP titles sharing one exact PDF are ambiguous rather than auto-bound', t => {
    const f = fixture(t);
    writeJson(f.metadata, [{ arnumber: '1', title: 'Same' }, { arnumber: '2', title: 'Same' }]);
    writePdf(f.pdf, 'Same.pdf');
    const result = discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.deepEqual(result.manifest.members.map(member => member.match.kind), ['ambiguous', 'ambiguous']);
});

test('ICLR uses forum_id and only exact root <id>.pdf, never title or nested basename', t => {
    const f = fixture(t);
    writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'A title' }, { forum_id: 'XyZ987_65', title: 'AbCdef_12' }]);
    writePdf(f.pdf, 'AbCdef_12.pdf');
    writePdf(f.pdf, 'nested/XyZ987_65.pdf');
    writePdf(f.pdf, 'A title.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.deepEqual(result.manifest.members.map(member => member.match.kind), ['exact', 'unmatched']);
    assert.deepEqual(result.manifest.members[0].identity, { type: 'openreview-forum-id', value: 'AbCdef_12' });
});

test('ICML records an optional numeric alias but keeps OpenReview ID as sole primary identity and match key', t => {
    const f = fixture(t);
    writeJson(f.metadata, { conference: 'ICML 2026', papers: [
        { id: 'OpenRv_123', paper_number: 63469, title: 'Paper title' },
        { forum_id: 'ForumX_456', id: 65000, title: '63469' }
    ] });
    writePdf(f.pdf, 'OpenRv_123.pdf');
    writePdf(f.pdf, '63469.pdf');
    const result = discovery.discoverConference({ adapter: 'icml', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.equal(result.manifest.members[0].numericAlias, '65000');
    assert.equal(result.manifest.members[0].identity.value, 'ForumX_456');
    assert.equal(result.manifest.members[0].match.kind, 'unmatched');
    assert.equal(result.manifest.members[1].numericAlias, '63469');
    assert.equal(result.manifest.members[1].identity.value, 'OpenRv_123');
    assert.equal(result.manifest.members[1].match.kind, 'exact');
});

test('rejects duplicate identities, conflicting IDs/aliases, duplicate JSON keys, and noncanonical identities', t => {
    const f = fixture(t);
    writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }, { forum_id: 'AbCdef_12', title: 'Two' }]);
    assert.throws(() => discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /duplicate primary identities/);
    writeJson(f.metadata, { papers: [{ forum_id: 'AbCdef_12', id: 'OtherID_99', title: 'One' }] });
    assert.throws(() => discovery.discoverConference({ adapter: 'icml', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /conflicting OpenReview/);
    writeJson(f.metadata, { papers: [{ id: 'AbCdef_12', paper_number: 1, numericAlias: 2, title: 'One' }] });
    assert.throws(() => discovery.discoverConference({ adapter: 'icml', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /conflicting numeric aliases/);
    fs.writeFileSync(f.metadata, '[{"arnumber":"1","arnumber":"2","title":"One"}]', { mode: 0o600 });
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /duplicate JSON key/);
    writeJson(f.metadata, [{ arnumber: '001', title: 'One' }]);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /canonical positive integer/);
});

test('rejects symlink, hardlink, FIFO, malformed PDF, unsafe metadata, and relative source paths', t => {
    const f = fixture(t); writeJson(f.metadata, [{ arnumber: '1', title: 'One' }]);
    const original = writePdf(f.pdf, 'one.pdf');
    fs.symlinkSync(original, path.join(f.pdf, 'linked.pdf'));
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /symbolic link/);
    fs.unlinkSync(path.join(f.pdf, 'linked.pdf'));
    fs.linkSync(original, path.join(f.pdf, 'hard.pdf'));
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /hard-linked|single-link/);
    fs.unlinkSync(path.join(f.pdf, 'hard.pdf'));
    execFileSync('mkfifo', [path.join(f.pdf, 'pipe')]);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /non-regular/);
    fs.unlinkSync(path.join(f.pdf, 'pipe'));
    fs.writeFileSync(original, 'not a pdf');
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /standard PDF header/);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: 'relative.json', pdfRoot: f.pdf }), /absolute filename/);
    const hardMetadata = path.join(f.root, 'hard-metadata.json'); fs.linkSync(f.metadata, hardMetadata);
    assert.throws(() => discovery.discoverConference({ adapter: 'icassp', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf }), /single-link/);
});

test('CLI dry-run writes nothing; apply writes bound O_EXCL artifacts and rolls back reservations on collision', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const base = ['--adapter', 'iclr', '--year', '2026', '--metadata', f.metadata, '--pdf-root', f.pdf];
    const files = { conferenceDiscoveryCatalogDir: f.catalogs, conferenceDiscoveryReportDir: f.reports };
    const dry = cli.main(['--dry-run', ...base], { files });
    assert.equal(dry.status, 'dry-run'); assert.deepEqual(fs.readdirSync(f.catalogs), []); assert.deepEqual(fs.readdirSync(f.reports), []);
    const candidate = path.join(f.catalogs, 'candidate.json'); const report = path.join(f.reports, 'report.json');
    const applied = cli.main(['--apply', ...base, '--candidate-output', 'candidate.json', '--report-output', 'report.json'], { files });
    assert.equal(applied.status, 'written');
    assert.equal(JSON.parse(fs.readFileSync(report)).candidateManifestSha256, sha(fs.readFileSync(candidate)));
    assert.equal(fs.statSync(candidate).mode & 0o777, 0o600);
    assert.throws(() => cli.main(['--apply', ...base, '--candidate-output', 'candidate.json', '--report-output', 'other.json'], { files }), /EEXIST/);
    assert.equal(fs.existsSync(path.join(f.reports, 'other.json')), false);
    assert.throws(() => cli.parseCommand(['--apply', ...base, '--candidate-output', 'candidate.json']), /requires/);
    assert.throws(() => cli.parseCommand(['--dry-run', ...base, '--candidate-output', 'candidate.json', '--report-output', 'report.json']), /must not specify/);
    for (const unsafe of ['/tmp/x.json', '../x.json', 'nested/x.json', 'X.json']) {
        assert.throws(() => cli.parseCommand(['--apply', ...base, '--candidate-output', unsafe, '--report-output', 'report.json']), /safe direct/);
    }
});

test('apply refuses outputs inside the catalog root', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.throws(() => cli.writeOutputsOnce({ catalogDir: f.pdf, catalogName: 'candidate.json', candidate: result.manifest,
        reportDir: f.reports, reportName: 'report.json', report: result.report, forbiddenRoot: result.manifest.pdfRoot }), /must not be inside pdfRoot/);
});

test('strict bundle validation replays every source, candidate, cardinality, count, and member-set binding', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const original = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    assert.equal(discovery.validateDiscoveryBundle(original.manifest, original.report).catalogSha256,
        original.report.candidateManifestSha256);

    const expectRejected = (mutateManifest, mutateReport, pattern) => {
        const manifest = JSON.parse(JSON.stringify(original.manifest)); mutateManifest?.(manifest);
        const report = discovery.buildReport(manifest); mutateReport?.(report);
        assert.throws(() => discovery.validateDiscoveryBundle(manifest, report), pattern);
    };
    expectRejected(manifest => { manifest.pdfCatalogSha256 = sha('forged'); }, null, /pdfCatalog SHA drifted/);
    expectRejected(manifest => { manifest.members[0].match.candidates[0].size += 1; }, null, /exactly match/);
    expectRejected(manifest => { manifest.members[0].match.candidates = []; }, null, /cardinality/);
    expectRejected(manifest => { manifest.members[0].match.kind = 'normalized'; }, null, /cannot be replayed/);
    expectRejected(manifest => { manifest.members[0].metadataIndex = 4; }, null, /metadata indexes/);
    expectRejected(manifest => { manifest.members[0].identity = { type: 'icassp-arnumber', value: '42' }; }, null, /identity type.*adapter/);
    expectRejected(manifest => { manifest.members[0].numericAlias = '42'; }, null, /only supported by the icml/);
    expectRejected(manifest => { manifest.memberSetSha256 = sha('forged'); }, null, /member set SHA drifted/);
    expectRejected(null, report => { report.metadataSnapshotSha256 = sha('other metadata'); }, /source SHA bindings/);
    expectRejected(null, report => { report.counts.exact = 0; }, /counts drifted/);
    expectRejected(manifest => { manifest.extra = true; }, null, /unknown or missing fields/);
    const reportDrift = structuredClone(original.report); reportDrift.candidateManifestSha256 = sha('forged');
    assert.throws(() => discovery.validateDiscoveryBundle(original.manifest, reportDrift), /canonical candidate manifest bytes/);
});

test('loaded discovery handle requires canonical paired files, is unforgeable, and returns defensive snapshots', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    const catalogName = 'iclr-2026.json'; const reportName = 'iclr-2026.report.json';
    const catalogFile = path.join(f.catalogs, catalogName); const reportFile = path.join(f.reports, reportName);
    writeCanonical(catalogFile, result.manifest); writeCanonical(reportFile, result.report);
    const handle = discovery.loadDiscoveryHandle({ catalogDir: f.catalogs, catalogName, reportDir: f.reports, reportName });
    assert.deepEqual(Object.keys(handle), []);
    const first = discovery.discoveryHandleSnapshot(handle);
    assert.equal(first.catalogSha256, result.report.candidateManifestSha256);
    assert.equal(first.candidateManifest.members[0].identity.value, 'AbCdef_12');
    first.candidateManifest.members[0].identity.value = 'Mutated_12';
    assert.equal(discovery.discoveryHandleSnapshot(handle).candidateManifest.members[0].identity.value, 'AbCdef_12');
    assert.throws(() => discovery.discoveryHandleSnapshot(Object.freeze(Object.create(null))), /authenticated loaded/);
    assert.equal(discovery.discoveryHandleSnapshot(discovery.loadDiscoveryHandle(catalogFile, reportFile)).catalogSha256,
        result.report.candidateManifestSha256);

    fs.writeFileSync(catalogFile, JSON.stringify(result.manifest), { mode: 0o600 });
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /exact canonical bytes/);
});

test('loaded discovery handle rejects cross-paired reports, duplicate keys, and descriptor tampering', t => {
    const f = fixture(t); writeJson(f.metadata, [{ forum_id: 'AbCdef_12', title: 'One' }]); writePdf(f.pdf, 'AbCdef_12.pdf');
    const result = discovery.discoverConference({ adapter: 'iclr', year: 2026, metadataFile: f.metadata, pdfRoot: f.pdf });
    const catalogFile = path.join(f.catalogs, 'catalog.json'); const reportFile = path.join(f.reports, 'report.json');
    writeCanonical(catalogFile, result.manifest);
    const wrongReport = structuredClone(result.report); wrongReport.candidateManifestSha256 = sha('different catalog');
    writeCanonical(reportFile, wrongReport);
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /canonical candidate manifest bytes/);
    fs.writeFileSync(reportFile, '{"contract":"conference-discovery-report-v1","contract":"other"}\n', { mode: 0o600 });
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /duplicate JSON key/);

    const tampered = JSON.parse(JSON.stringify(result.manifest)); tampered.members[0].match.candidates[0].sha256 = sha('tampered pdf');
    writeCanonical(catalogFile, tampered); writeCanonical(reportFile, discovery.buildReport(tampered));
    assert.throws(() => discovery.loadDiscoveryHandle(catalogFile, reportFile), /exactly match/);
});

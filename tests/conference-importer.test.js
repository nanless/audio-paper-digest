'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const importer = require('../scripts/lib/conference-importer.js');
const ledgerApi = require('../scripts/lib/conference-source-ledger.js');
const cli = require('../scripts/conference-import.js');

const NOW = '2026-09-06T12:00:00.000Z';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-import-'));
    const source = path.join(root, 'source'); const cache = path.join(root, 'cache'); const output = path.join(root, 'output');
    for (const dir of [source, cache, output]) fs.mkdirSync(dir, { mode: 0o700 });
    for (const dir of ['metadata', 'pdf', 'text', 'artifacts']) fs.mkdirSync(path.join(source, dir), { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, source, cache, output };
}

function input(f, { full = true } = {}) {
    const metadata = '{"conference":{"id":"icassp-2026","year":2026},"identity":{"type":"icassp-arnumber","value":"100"},"title":"This title is only metadata"}';
    const pdf = '%PDF-1.4\nsource'; const extracted = 'extracted text'; const artifacts = '{"pages":[]}';
    fs.writeFileSync(path.join(f.source, 'metadata', '100.json'), metadata, { mode: 0o600 });
    fs.writeFileSync(path.join(f.source, 'pdf', '100.pdf'), pdf, { mode: 0o600 });
    if (full) {
        fs.writeFileSync(path.join(f.source, 'text', '100.txt'), extracted, { mode: 0o600 });
        fs.writeFileSync(path.join(f.source, 'artifacts', '100.json'), artifacts, { mode: 0o600 });
    }
    const member = {
        identity: { type: 'icassp-arnumber', value: '100' },
        metadata: { file: 'metadata/100.json', sha256: sha(metadata), identityEvidence: {
            conferenceIdPointer: '/conference/id', conferenceYearPointer: '/conference/year',
            identityTypePointer: '/identity/type', identityValuePointer: '/identity/value'
        }, provenance: { kind: 'official-metadata', locator: 'ieee:100', retrievedAt: NOW } },
        pdf: { file: 'pdf/100.pdf', sha256: sha(pdf), provenance: { kind: 'official-pdf', locator: 'ieee-pdf:100', retrievedAt: NOW } },
        text: full ? { file: 'text/100.txt', sha256: sha(extracted), provenance: { extractor: 'pdftotext', version: '24.02' } } : null,
        artifacts: full ? { file: 'artifacts/100.json', sha256: sha(artifacts), provenance: { extractor: 'layout', version: '1' } } : null
    };
    return { contract: importer.CONTRACT, version: importer.VERSION, conference: { id: 'icassp-2026', year: 2026 },
        members: [member], memberSetSha256: ledgerApi.memberSetSha256([{ identity: member.identity }]) };
}

test('manifest-bound dry run and apply copy only declared local artifacts and create a replayable verified ledger', t => {
    const f = fixture(t); const manifest = input(f);
    const dry = importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW });
    assert.equal(dry.mode, 'dry-run'); assert.equal(dry.verified, 1); assert.equal(fs.readdirSync(f.cache).length, 0);
    const applied = importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true });
    assert.equal(applied.verified, 1); assert.equal(applied.blocked, 0);
    assert.equal(ledgerApi.verifyMemberFiles(applied.ledger, f.cache), true);
    assert.equal(applied.ledger.members[0].identity.value, '100');
    assert.match(applied.ledger.members[0].metadataFile, /^icassp-2026-2026\/icassp-arnumber--100\/metadata\.json$/);
    // Re-entry is safe only when byte-identical cache artifacts already exist.
    assert.equal(importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true }).verified, 1);
});

test('missing PDF is kept blocked, and metadata title cannot become an identity or select another file', t => {
    const f = fixture(t); const manifest = input(f, { full: false });
    manifest.members[0].pdf = null;
    manifest.memberSetSha256 = ledgerApi.memberSetSha256([{ identity: manifest.members[0].identity }]);
    const result = importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true });
    assert.equal(result.blocked, 1); assert.equal(result.ledger.members[0].availability.pdf, 'absent');
    assert.equal(result.ledger.members[0].status.state, 'blocked');
    const titleIdentity = structuredClone(manifest);
    titleIdentity.members[0].identity.value = 'This title is only metadata';
    assert.throws(() => importer.validateManifest(titleIdentity), /invalid/);
});

test('rejects undeclared/traversing/link/hard-link files, malformed PDFs and pre-existing byte drift', t => {
    const f = fixture(t); const manifest = input(f);
    const traversal = structuredClone(manifest); traversal.members[0].pdf.file = '../pdf/100.pdf';
    assert.throws(() => importer.importConferenceSources({ manifest: traversal, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /relative path/);
    fs.symlinkSync(path.join(f.source, 'pdf', '100.pdf'), path.join(f.source, 'pdf', 'linked.pdf'));
    const linked = structuredClone(manifest); linked.members[0].pdf.file = 'pdf/linked.pdf';
    assert.throws(() => importer.importConferenceSources({ manifest: linked, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /unsafe|single-link/);
    fs.unlinkSync(path.join(f.source, 'pdf', 'linked.pdf'));
    fs.linkSync(path.join(f.source, 'pdf', '100.pdf'), path.join(f.source, 'pdf', 'hard.pdf'));
    const hard = structuredClone(manifest); hard.members[0].pdf.file = 'pdf/hard.pdf';
    assert.throws(() => importer.importConferenceSources({ manifest: hard, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /single-link/);
    fs.unlinkSync(path.join(f.source, 'pdf', 'hard.pdf'));
    importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true });
    const changedPdf = '%PDF-1.4\nchanged'; fs.writeFileSync(path.join(f.source, 'pdf', '100.pdf'), changedPdf);
    const drift = structuredClone(manifest); drift.members[0].pdf.sha256 = sha(changedPdf);
    assert.throws(() => importer.importConferenceSources({ manifest: drift, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW, apply: true }), /different bytes/);
});

test('requires manifest input SHA values and strict metadata identity evidence before any member can verify', t => {
    const f = fixture(t); const manifest = input(f);
    const badSha = structuredClone(manifest); badSha.members[0].pdf.sha256 = 'a'.repeat(64);
    assert.throws(() => importer.importConferenceSources({ manifest: badSha, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /expected SHA-256/);
    const missingSha = structuredClone(manifest); delete missingSha.members[0].text.sha256;
    assert.throws(() => importer.validateManifest(missingSha), /unknown or missing fields/);
    const wrongIdentity = structuredClone(manifest); wrongIdentity.members[0].metadata.identityEvidence.identityValuePointer = '/title';
    assert.throws(() => importer.importConferenceSources({ manifest: wrongIdentity, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /must exactly bind/);
    const missingEvidence = structuredClone(manifest); delete missingEvidence.members[0].metadata.identityEvidence;
    assert.throws(() => importer.validateManifest(missingEvidence), /unknown or missing fields/);
});

test('rejects overlapping roots, FIFO sources, non-UTF8 text, and duplicate metadata/artifact JSON keys', t => {
    const f = fixture(t); const manifest = input(f);
    assert.throws(() => importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: f.source, updatedAt: NOW }), /must not overlap/);
    const nestedCache = path.join(f.source, 'nested-cache'); fs.mkdirSync(nestedCache, { mode: 0o700 });
    assert.throws(() => importer.importConferenceSources({ manifest, sourceRoot: f.source, cacheRoot: nestedCache, updatedAt: NOW }), /must not overlap/);
    const fifo = structuredClone(manifest); fs.unlinkSync(path.join(f.source, 'text', '100.txt'));
    execFileSync('mkfifo', [path.join(f.source, 'text', '100.txt')]);
    assert.throws(() => importer.importConferenceSources({ manifest: fifo, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /regular single-link/);
    fs.unlinkSync(path.join(f.source, 'text', '100.txt'));
    fs.writeFileSync(path.join(f.source, 'text', '100.txt'), Buffer.from([0xc3, 0x28]), { mode: 0o600 });
    fifo.members[0].text.sha256 = sha(Buffer.from([0xc3, 0x28]));
    assert.throws(() => importer.importConferenceSources({ manifest: fifo, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /strict UTF-8/);
    const duplicateMetadata = structuredClone(manifest); const duplicated = '{"conference":{"id":"icassp-2026","year":2026},"identity":{"type":"icassp-arnumber","value":"100"},"identity":{"type":"icassp-arnumber","value":"100"}}';
    fs.writeFileSync(path.join(f.source, 'metadata', '100.json'), duplicated, { mode: 0o600 }); duplicateMetadata.members[0].metadata.sha256 = sha(duplicated);
    assert.throws(() => importer.importConferenceSources({ manifest: duplicateMetadata, sourceRoot: f.source, cacheRoot: f.cache, updatedAt: NOW }), /valid UTF-8 JSON/);
    const f2 = fixture(t); const artifactsManifest = input(f2); const duplicateArtifacts = '{"pages":[],"pages":[]}';
    fs.writeFileSync(path.join(f2.source, 'artifacts', '100.json'), duplicateArtifacts, { mode: 0o600 });
    artifactsManifest.members[0].artifacts.sha256 = sha(duplicateArtifacts);
    assert.throws(() => importer.importConferenceSources({ manifest: artifactsManifest, sourceRoot: f2.source, cacheRoot: f2.cache, updatedAt: NOW }), /valid UTF-8 JSON/);
});

test('CLI requires explicit mode and writes an O_EXCL ledger only in apply mode', t => {
    const f = fixture(t); const manifest = input(f); const manifestFile = path.join(f.root, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    assert.throws(() => cli.parseCommand(['--apply', '--manifest', manifestFile, '--source-root', f.source, '--cache-root', f.cache, '--updated-at', NOW]), /ledger-output/);
    const dry = cli.main(['--dry-run', '--manifest', manifestFile, '--source-root', f.source, '--cache-root', f.cache, '--updated-at', NOW]);
    assert.equal(dry.status, 'dry-run');
    const output = path.join(f.output, 'ledger.json');
    const applied = cli.main(['--apply', '--manifest', manifestFile, '--source-root', f.source, '--cache-root', f.cache, '--updated-at', NOW, '--ledger-output', output]);
    assert.equal(applied.status, 'imported'); assert.equal(ledgerApi.loadLedger(output).ledger.members.length, 1);
    assert.throws(() => cli.main(['--apply', '--manifest', manifestFile, '--source-root', f.source, '--cache-root', f.cache, '--updated-at', NOW, '--ledger-output', output]), /EEXIST/);
});

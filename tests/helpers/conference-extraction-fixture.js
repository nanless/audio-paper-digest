'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const extraction = require('../../scripts/lib/conference-extraction-receipt.js');
const paperIdentity = require('../../scripts/lib/paper-identity.js');

const ROOT = path.resolve(__dirname, '..', '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function buildPdf(label, lines = 120) {
    const text = Array.from({ length: lines }, (_, index) => `${label}-line-${String(index).padStart(3, '0')}-${'x'.repeat(56)}`);
    const commands = text.map(line => `(${line.replace(/([\\()])/g, '\\$1')}) Tj T*`).join(' ');
    const stream = Buffer.from(`BT /F1 9 Tf 30 760 Td 10 TL ${commands} ET`, 'ascii');
    const objects = new Map([
        [1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii')],
        [2, Buffer.from('<< /Type /Pages /Kids [4 0 R] /Count 1 >>', 'ascii')],
        [3, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')],
        [4, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>', 'ascii')],
        [5, Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'ascii'), stream,
            Buffer.from('\nendstream', 'ascii')])]
    ]);
    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary')];
    const offsets = [0]; let length = chunks[0].length;
    for (const [id, body] of objects) {
        offsets[id] = length;
        const object = Buffer.concat([Buffer.from(`${id} 0 obj\n`, 'ascii'), body, Buffer.from('\nendobj\n', 'ascii')]);
        chunks.push(object); length += object.length;
    }
    const xref = length;
    const trailer = ['xref', `0 ${objects.size + 1}`, '0000000000 65535 f ',
        ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
        'trailer', `<< /Size ${objects.size + 1} /Root 1 0 R >>`, 'startxref', String(xref), '%%EOF', ''].join('\n');
    chunks.push(Buffer.from(trailer, 'ascii'));
    return Buffer.concat(chunks);
}

function runProductionExtraction({ sourceRoot, value, discoveryBinding, pdfBytes, stamp }) {
    const sourceRecord = { type: 'icassp-arnumber', value };
    const paperId = paperIdentity.canonicalConferencePaperId({ id: 'icassp-2026', year: 2026 }, sourceRecord);
    const sourceIdentity = `icassp-arnumber:${value}`;
    const names = { request: `${value}-request.json`, metadata: `${value}-metadata.json`, pdf: `${value}.pdf`,
        text: `${value}.txt`, artifacts: `${value}-artifacts.json`, receipt: `${value}-receipt.json` };
    for (const name of Object.values(names)) {
        try { fs.unlinkSync(path.join(sourceRoot, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const metadata = Buffer.from(JSON.stringify({ conferenceId: 'icassp-2026', year: 2026,
        identity: { type: 'icassp-arnumber', value }, title: `Paper ${value}` }));
    const identityEvidence = { conferenceIdPointer: '/conferenceId', conferenceYearPointer: '/year',
        identityTypePointer: '/identity/type', identityValuePointer: '/identity/value' };
    const request = { contract: extraction.REQUEST_CONTRACT, version: extraction.VERSION, paperId, sourceIdentity,
        source: { metadata: { file: names.metadata, sha256: sha256(metadata), identityEvidence,
            discoveryBinding, provenance: { kind: 'official-metadata', locator: `fixture:${value}:metadata`, retrievedAt: stamp } },
        pdf: { file: names.pdf, sha256: sha256(pdfBytes),
            provenance: { kind: 'official-pdf', locator: `fixture:${value}:pdf`, retrievedAt: stamp } } },
        outputs: { textFile: names.text, artifactsFile: names.artifacts, receiptFile: names.receipt },
        options: { ...extraction.OPTIONS } };
    fs.writeFileSync(path.join(sourceRoot, names.request), JSON.stringify(request), { mode: 0o600 });
    fs.writeFileSync(path.join(sourceRoot, names.metadata), metadata, { mode: 0o600 });
    fs.writeFileSync(path.join(sourceRoot, names.pdf), pdfBytes, { mode: 0o600 });
    const code = 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[3]); from conference_extractor import run_extraction; run_extraction(sys.argv[1], apply=True, source_root=Path(sys.argv[2]))';
    execFileSync('bash', [path.join(ROOT, 'scripts', 'python-runtime.sh'),
        '-c', code, names.request, sourceRoot, path.join(ROOT, 'scripts')], { cwd: ROOT, stdio: 'pipe' });
    return { paperId, sourceIdentity, receiptName: names.receipt, names };
}

module.exports = { buildPdf, runProductionExtraction, sha256 };

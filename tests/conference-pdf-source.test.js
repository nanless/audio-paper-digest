'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const source = require('../scripts/lib/conference-pdf-source.js');

const temporary = [];
afterEach(() => {
    while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function fixture({ bytes = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'binary') } = {}) {
    // macOS commonly exposes /var as a compatibility symlink to /private/var.
    // Keep the controlled-root fixture below the repository so this test also
    // exercises the adapter's intentional refusal of symlinked root ancestry.
    const root = fs.mkdtempSync(path.join(process.cwd(), '.conference-pdf-source-'));
    temporary.push(root);
    fs.mkdirSync(path.join(root, 'papers'), { mode: 0o700 });
    const relativePath = 'papers/example.pdf';
    const filename = path.join(root, relativePath);
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    return {
        root, filename, bytes,
        record: {
            identity: { conference: 'icassp-2026', arnumber: '12345678' },
            pdfRelativePath: relativePath,
            pdfSha256: digest(bytes),
        },
    };
}

test('local PDF source descriptor binds verified identity, bytes and explicit unavailable extraction', () => {
    const f = fixture();
    const result = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record });
    assert.equal(result.descriptor.contract, 'conference-pdf-source-v1');
    assert.equal(result.descriptor.kind, 'local_pdf');
    assert.equal(result.descriptor.pdfSha256, f.record.pdfSha256);
    assert.equal(result.descriptor.pdfBytes, f.bytes.length);
    assert.equal(result.descriptor.textSha256, null);
    assert.equal(result.descriptor.structuredArtifactsSha256, null);
    assert.equal(result.descriptor.formulaTeXSha256, null);
    assert.deepEqual(result.descriptor.availability, { text: false, structuredArtifacts: false, formulaTeX: false });
    assert.deepEqual(result.formulaTeX, { available: false, reason: 'no-reliable-structured-tex' });
    assert.deepEqual(source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor }), result.descriptor);
});

test('local extraction records replayable hashes and refuses formula availability without reliable structured TeX', () => {
    const f = fixture();
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record,
        extractPdf: () => ({ extractorVersion: 'pdftotext-24.02', text: 'plain extracted text', formulaTeX: { available: true } }),
    }), /reliable structured TeX/);
    const structuredArtifacts = { sections: [{ id: 'method', text: 'Method' }], formulaIndex: [] };
    const result = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record,
        extractPdf: ({ pdfBytes }) => {
            assert.notEqual(pdfBytes, f.bytes, 'extractor receives a separate Buffer');
            return { extractorVersion: 'local-pdf-extractor-v1', text: 'local extracted text', structuredArtifacts,
                formulaTeX: { available: false, reason: 'pdf-has-no-reliable-structured-tex' } };
        },
    });
    assert.equal(result.descriptor.availability.text, true);
    assert.equal(result.descriptor.availability.structuredArtifacts, true);
    assert.equal(result.descriptor.availability.formulaTeX, false);
    source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor,
        text: result.text, structuredArtifacts: result.structuredArtifacts });
    assert.throws(() => source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor,
        text: 'modified', structuredArtifacts }), /text artifact/);
    const reliable = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record,
        extractPdf: () => ({ extractorVersion: 'structured-tex-v1', text: 'text', structuredArtifacts: { formulaIndex: ['eq-1'] },
            formulaTeX: { available: true, reliability: 'reliable', formulas: [{ tex: 'x^2', sourceRef: 'page-1:eq-1' }] } }),
    });
    assert.equal(reliable.descriptor.availability.formulaTeX, true);
    assert.match(reliable.descriptor.formulaTeXSha256, /^[a-f0-9]{64}$/);
    source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: reliable.descriptor,
        text: reliable.text, structuredArtifacts: reliable.structuredArtifacts, formulaTeX: reliable.formulaTeX });
});

test('only a regular single-link PDF below the limit inside the controlled root is accepted', t => {
    const f = fixture();
    for (const pdfRelativePath of ['/tmp/outside.pdf', '../outside.pdf', 'papers/../example.pdf', 'papers\\example.pdf']) {
        assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfRelativePath } }),
            /relative path|traversal/);
    }
    fs.symlinkSync(f.filename, path.join(f.root, 'papers', 'linked.pdf'));
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfRelativePath: 'papers/linked.pdf' } }),
        /regular, non-linked/);
    fs.linkSync(f.filename, path.join(f.root, 'papers', 'hard-linked.pdf'));
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfRelativePath: 'papers/hard-linked.pdf' } }),
        /regular, non-linked/);
    fs.unlinkSync(path.join(f.root, 'papers', 'hard-linked.pdf'));
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record, maxBytes: f.bytes.length - 1 }), /size limit/);
    t.diagnostic('security checks reject traversal, symbolic links, hard links, and oversized files');
});

test('bad header, changed bytes, bad record hash and mutated descriptors fail closed', () => {
    const bad = fixture({ bytes: Buffer.from('not a PDF') });
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: bad.root, record: bad.record }), /standard PDF/);
    const f = fixture();
    assert.throws(() => source.buildConferencePdfSource({ cacheRoot: f.root, record: { ...f.record, pdfSha256: '0'.repeat(64) } }), /SHA-256 differs/);
    const result = source.buildConferencePdfSource({ cacheRoot: f.root, record: f.record });
    const mutated = { ...result.descriptor, pdfBytes: result.descriptor.pdfBytes + 1 };
    assert.throws(() => source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: mutated }), /checksum/);
    fs.writeFileSync(f.filename, Buffer.concat([f.bytes, Buffer.from('changed')]), { mode: 0o600 });
    assert.throws(() => source.replayConferencePdfSource({ cacheRoot: f.root, record: f.record, descriptor: result.descriptor }), /bytes no longer replay/);
});

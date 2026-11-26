'use strict';
// Independent read-only capability. No Reader generation or source-table policy is installed here.
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const proofFormat = require('./reader-proof-format');
const codec = require('./protocol-codec');
const FAMILY = 'reader-sealed-pdf-table-grid';
const CONTRACT = codec.contract(FAMILY);
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const root = path.resolve(__dirname, '../..');
const program = path.join(root, 'scripts/reader_sealed_pdf_table_evidence.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./reader-repair').hashDraft(value);
function extractionImplementationFiles() {
    const catalog = path.join(root, 'config/protocols');
    return [program, ...['reader_proof_format.py', 'protocol_codec.py', 'git_file_bytes.py']
        .map(name => path.join(root, 'scripts', name)),
        ...fs.readdirSync(catalog).filter(name => name.endsWith('.json')).sort().map(name => path.join(catalog, name))];
}
function extractionImplementationSha256(files = extractionImplementationFiles()) {
    return stable(files.map(file => [path.relative(root, file), sha(fs.readFileSync(file))]));
}

function deriveBundle(expectation, requestedHeader = proofFormat.header(FAMILY)) {
    const declaredHeader = proofFormat.readHeader(requestedHeader, FAMILY);
    if (!isDeepStrictEqual(declaredHeader, requestedHeader)) throw new Error('PDF metadata header contains non-format fields');
    require('../env-loader').requireExternalRuntime('reader-sealed-pdf-table-evidence');
    require('../workspace-role').requireWorkspaceRole('daily', root);
    const fresh = require('./fresh-analysis-context');
    fresh.assertSealedFourFileArxivRoot(expectation.rootDir, 'Expected current daily sealed source root');
    return fresh.withVerifiedBundleReaderAuthorFiles(expectation, source => {
        const sourceApi = require('./fresh-arxiv-rewrite-source');
        const before = sourceApi.readFreshArxivRewriteSource(expectation);
        const tables = source.structuredArtifacts?.tables;
        if (source.source !== 'html' || !Array.isArray(tables)) throw new Error('Exact PDF grid requires sealed official HTML table coordinates');
        const files = { 'source.txt': before.manifest.text.responseSha256,
            'source.pdf': before.manifest.pdf.responseSha256,
            'source-runtime.json': before.manifest.runtimeMetadata.responseSha256,
            'source-manifest.json': before.sourceManifestSha256 };
        const implFiles = extractionImplementationFiles();
        const programSha256 = extractionImplementationSha256(implFiles);
        const raw = require('./reader-pdf-extraction-scope').runPdfExtractorJson(program, {
            pdfBuffer: before.pdf,
            pdfSha256: files['source.pdf'],
            meta: { pdfSha256: files['source.pdf'], tables, proofHeader: declaredHeader },
            tmpPrefix: 'sealed-pdf-grid-'
        }, implFiles.filter(file => file !== program));
        const response = JSON.parse(raw);
        if (!isDeepStrictEqual(proofFormat.readHeader(response, FAMILY), declaredHeader)
            || !Array.isArray(response.results) || response.results.length !== tables.length) throw new Error('Incomplete PDF grid response');
        const after = sourceApi.readFreshArxivRewriteSource(expectation);
        if (after.sourceManifestSha256 !== before.sourceManifestSha256 || !isDeepStrictEqual(after.manifest, before.manifest)
            || stable(after.runtimeDetails) !== stable(before.runtimeDetails)
            || extractionImplementationSha256() !== programSha256) throw new Error('PDF source or extraction program changed');
        return response.results.map((entry, index) => {
            const table = tables[index];
            if (entry.sourceTableOrdinal !== table.ordinal || entry.sourceTableDomSha256 !== table.sourceDomSha256) throw new Error('PDF result table identity mismatch');
            if (!entry.eligible) return entry;
            const proof = entry.evidence, matrix = proof?.displayMatrix;
            if (!isDeepStrictEqual(proofFormat.readHeader(proof, FAMILY), declaredHeader)
                || proof.valueOrigin !== 'sealed_pdf' || proof.pdfSha256 !== files['source.pdf']
                || proof.sourceTableSha256 !== stable(table) || proof.sourceTableDomSha256 !== table.sourceDomSha256
                || !Array.isArray(matrix) || matrix.length !== table.matrix.length
                || matrix.some((row, r) => !Array.isArray(row) || row.length !== table.matrix[r].length)
                || proof.cells.length !== table.cells.length || !proof.caption.words.length) throw new Error('Incomplete exact PDF grid evidence');
            const used = new Set();
            for (const cell of proof.cells) {
                const original = table.cells.find(c => c.row === cell.row && c.column === cell.column);
                const key = `${cell.row}:${cell.column}`;
                if (!original || used.has(key) || cell.sourceDomSha256 !== original.sourceDomSha256
                    || cell.sourceHtmlText !== original.text || cell.pdfText !== matrix[cell.row][cell.column]
                    || cell.valueOrigin !== 'sealed_pdf' || !cell.words.length
                    || cell.words.some(w => w.length !== 5 || w.slice(0, 4).some(n => !Number.isFinite(n)) || typeof w[4] !== 'string')) throw new Error('Exact PDF cell/source coordinate mismatch');
                used.add(key);
            }
            return { ...entry, evidence: structuredClone(proof) };
        });
    });
}

function deriveCurrent(paper) {
    const fresh = require('./fresh-analysis-context');
    if (!fresh.isSealedFourFileArxivScope()) throw new Error('Exact PDF grid requires the actual daily source scope');
    const bundle = fresh.resolveActiveSealedFourFileArxivBundle(paper);
    if (!bundle) throw new Error('Exact PDF grid requires the actual daily source scope');
    return deriveBundle(bundle.expectation);
}

function verifyEvidence(expectation, evidence) {
    const current = deriveBundle(expectation, proofFormat.readHeader(evidence, FAMILY))
        .filter(entry => entry.eligible && entry.sourceTableOrdinal === evidence.sourceTableOrdinal);
    if (current.length !== 1 || !isDeepStrictEqual(current[0].evidence, evidence)) throw new Error('Saved exact PDF grid cannot be replayed');
    return structuredClone(evidence);
}

function withArtifacts(artifacts, paperId, callback) {
    const fresh = require('./fresh-analysis-context');
    if (!fresh.isSealedFourFileArxivScope()) return callback();
    const bundle = fresh.resolveActiveSealedFourFileArxivBundle(paperId);
    if (!bundle) return callback();
    if (!isDeepStrictEqual(bundle.source.structuredArtifacts, artifacts)) throw new Error('PDF grid artifacts differ from the current sealed source');
    const current = scope.getStore();
    const representation = proofFormat.header(FAMILY);
    if (current?.artifacts === artifacts && isDeepStrictEqual(current.header, representation)) return callback();
    // 按引用表懒加载：只有真正查询某个表的 PDF 格证据时才触发 PyMuPDF，
    // 既避免未引用表触发 20+ 次无用子进程，又完整保留所有防篡改校验。
    const state = { artifacts, paperId, proofs: null, header: representation };
    return scope.run(state, callback);
}
function evidence(table) {
    const current = scope.getStore();
    if (!current || !current.artifacts.tables.includes(table)) return null;
    if (current.proofs === null) {
        const entries = deriveCurrent(current.paperId);
        current.proofs = new Map(entries.filter(entry => entry.eligible).map(entry => [entry.sourceTableOrdinal, entry.evidence]));
    }
    const proof = current.proofs.get(table.ordinal);
    return proof && proof.sourceTableDomSha256 === table.sourceDomSha256 && proof.sourceTableSha256 === stable(table)
        ? structuredClone(proof) : null;
}
function displayCell(table, row, column) {
    const proof = evidence(table);
    return proof ? proof.displayMatrix[row]?.[column] ?? null : null;
}
function assertProof(table, proof) {
    const actual = evidence(table);
    if (!actual || !isDeepStrictEqual(actual, proof)) throw new Error('Exact PDF proof is outside its verified source scope');
    return true;
}
module.exports = { CONTRACT, deriveBundle, deriveCurrent, verifyEvidence, withArtifacts,
    evidence, getProof: evidence, displayCell, assertProof };

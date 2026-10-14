'use strict';
// Independent read-only capability. No Reader generation or source-table policy is installed here.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), child = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-sealed-pdf-table-grid-v1';
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const root = path.resolve(__dirname, '../..');
const program = path.join(root, 'scripts/reader_sealed_pdf_table_evidence.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./reader-repair').hashDraft(value);

function deriveBundle(expectation) {
    require('../env-loader').requireExternalRuntime('reader-sealed-pdf-table-evidence');
    require('../workspace-role').requireWorkspaceRole('daily', root);
    const config = require('../config'), fresh = require('./fresh-analysis-context');
    const sources = path.resolve(expectation.rootDir || '');
    const run = path.basename(path.dirname(sources));
    if (path.basename(sources) !== 'sources' || path.dirname(path.dirname(sources)) !== path.resolve(config.FILES.dailyFreshSourceRunsDir)
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw new Error('Expected current daily sealed source root');
    return fresh.withVerifiedBundleReaderAuthorFiles(expectation, source => {
        const sourceApi = require('./fresh-arxiv-rewrite-source');
        const before = sourceApi.readFreshArxivRewriteSource(expectation);
        const tables = source.structuredArtifacts?.tables;
        if (source.source !== 'html' || !Array.isArray(tables)) throw new Error('Exact PDF grid requires sealed official HTML table coordinates');
        const files = { 'source.txt': before.manifest.text.responseSha256,
            'source.pdf': before.manifest.pdf.responseSha256,
            'source-runtime.json': before.manifest.runtimeMetadata.responseSha256,
            'source-manifest.json': before.sourceManifestSha256 };
        const programSha256 = sha(fs.readFileSync(program));
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-pdf-grid-'));
        fs.chmodSync(directory, 0o700);
        const filename = path.join(directory, 'private-input.json');
        let fd;
        try {
            fs.writeFileSync(filename, JSON.stringify({ pdfBase64: before.pdf.toString('base64'), pdfSha256: files['source.pdf'], tables }), { mode: 0o600 });
            fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const raw = child.execFileSync('bash', [path.join(root, 'scripts/python-runtime.sh'), program, '3'], {
                cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe', fd],
                env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_SANDBOX: process.env.CODEX_SANDBOX || '' }
            });
            const response = JSON.parse(raw);
            if (response.contract !== CONTRACT || !Array.isArray(response.results) || response.results.length !== tables.length) throw new Error('Incomplete PDF grid response');
            const after = sourceApi.readFreshArxivRewriteSource(expectation);
            if (after.sourceManifestSha256 !== before.sourceManifestSha256 || !isDeepStrictEqual(after.manifest, before.manifest)
                || stable(after.runtimeDetails) !== stable(before.runtimeDetails) || sha(fs.readFileSync(program)) !== programSha256) throw new Error('PDF source or extraction program changed');
            return response.results.map((entry, index) => {
                const table = tables[index];
                if (entry.sourceTableOrdinal !== table.ordinal || entry.sourceTableDomSha256 !== table.sourceDomSha256) throw new Error('PDF result table identity mismatch');
                if (!entry.eligible) return entry;
                const proof = entry.evidence, matrix = proof?.displayMatrix;
                if (proof.contract !== CONTRACT || proof.valueOrigin !== 'sealed_pdf' || proof.pdfSha256 !== files['source.pdf']
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
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}

function deriveCurrent(paper) {
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (!context || !fresh.isDailyFreshSourceScope()) throw new Error('Exact PDF grid requires the actual daily source scope');
    const source = fresh.readFreshSource(context.runDir, paper, context), d = source.freshSourceDescriptor;
    return deriveBundle({ rootDir: path.join(context.runDir, 'sources'), arxivId: d.paperId,
        generation: d.sourceGeneration, sourceManifestSha256: d.sourceManifestSha256, sourceSnapshotSha256: d.sourceSnapshotSha256 });
}

function verifyEvidence(expectation, evidence) {
    const current = deriveBundle(expectation).filter(entry => entry.eligible && entry.sourceTableOrdinal === evidence.sourceTableOrdinal);
    if (current.length !== 1 || !isDeepStrictEqual(current[0].evidence, evidence)) throw new Error('Saved exact PDF grid cannot be replayed');
    return structuredClone(evidence);
}

function withArtifacts(artifacts, paperId, callback) {
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (!context || !fresh.isDailyFreshSourceScope()) return callback();
    const source = fresh.readFreshSource(context.runDir, paperId, context);
    if (!isDeepStrictEqual(source.structuredArtifacts, artifacts)) throw new Error('PDF grid artifacts differ from the current sealed source');
    const current = scope.getStore();
    if (current?.artifacts === artifacts) return callback();
    const entries = deriveCurrent(paperId);
    const proofs = new Map(entries.filter(entry => entry.eligible).map(entry => [entry.sourceTableOrdinal, entry.evidence]));
    return scope.run({ artifacts, proofs }, callback);
}
function evidence(table) {
    const current = scope.getStore();
    if (!current || !current.artifacts.tables.includes(table)) return null;
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

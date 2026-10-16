'use strict';
// Separate PDF quotation origin; it never changes HTML evidence or an input identity.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const CONTRACT = 'reader-sealed-pdf-quotes-v1';
const scope = new AsyncLocalStorage(), root = path.resolve(__dirname, '../..');
const program = path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./reader-repair').hashDraft(value);

function deriveBundle(expectation, quotes = []) {
    require('../env-loader').requireExternalRuntime('reader-sealed-pdf-quote-evidence');
    require('../workspace-role').requireWorkspaceRole('daily', root);
    const sources = path.resolve(expectation.rootDir || ''), run = path.basename(path.dirname(sources));
    if (path.basename(sources) !== 'sources' || path.dirname(path.dirname(sources)) !== path.resolve(require('../config').FILES.dailyFreshSourceRunsDir)
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw new Error('Expected current daily sealed source root');
    if (!Array.isArray(quotes) || quotes.length > 64 || quotes.some(q => typeof q !== 'string')) throw new Error('Expected bounded PDF quote requests');
    return require('./fresh-analysis-context').withVerifiedBundleReaderAuthorFiles(expectation, source => {
        const api = require('./fresh-arxiv-rewrite-source'), before = api.readFreshArxivRewriteSource(expectation);
        const programSha256 = sha(fs.readFileSync(program));
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-pdf-quotes-'));
        fs.chmodSync(directory, 0o700);
        const file = path.join(directory, 'private-input.json'); let fd;
        try {
            fs.writeFileSync(file, JSON.stringify({ pdfBase64: before.pdf.toString('base64'), pdfSha256: sha(before.pdf), quotes }), { mode: 0o600 });
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const raw = require('./reader-pdf-extraction-scope').runPdfExtractor(program, fd);
            const response = JSON.parse(raw), after = api.readFreshArxivRewriteSource(expectation);
            if (response.contract !== CONTRACT || response.document?.contract !== CONTRACT
                || response.document.pdfSha256 !== sha(before.pdf) || !Array.isArray(response.results) || response.results.length !== quotes.length
                || !isDeepStrictEqual(before.manifest, after.manifest) || before.sourceManifestSha256 !== after.sourceManifestSha256
                || stable(before.runtimeDetails) !== stable(after.runtimeDetails) || sha(fs.readFileSync(program)) !== programSha256) throw new Error('PDF quotation source or extraction program changed');
            if (response.document.available && (sha(response.document.rawFullText) !== response.document.rawFullTextSha256
                || sha(response.document.normalizedFullText) !== response.document.normalizedFullTextSha256)) throw new Error('PDF text projection hash differs');
            for (const result of response.results.filter(r => r.eligible)) {
                const proof = result.evidence;
                if (proof.contract !== CONTRACT || proof.valueOrigin !== 'sealed_pdf' || proof.pdfSha256 !== response.document.pdfSha256
                    || proof.rawFullTextSha256 !== response.document.rawFullTextSha256
                    || proof.normalizedFullTextSha256 !== response.document.normalizedFullTextSha256
                    || sha(proof.quote) !== proof.quoteSha256 || sha(proof.rawFragment) !== proof.rawFragmentSha256
                    || !isDeepStrictEqual(proof.extraction, response.document.extraction)) throw new Error('PDF quote evidence identity differs');
            }
            return { ...response, sourceDescriptor: source.freshSourceDescriptor };
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}

function withArtifacts(artifacts, paperId, callback) {
    const fresh = require('./fresh-analysis-context'), context = fresh.getFreshAnalysisContext();
    if (!context || !fresh.isDailyFreshSourceScope()) return callback();
    const source = fresh.readFreshSource(context.runDir, paperId, context), d = source.freshSourceDescriptor;
    // Older text-only sources cannot acquire the new four-file PDF capability.
    if (d?.contract !== 'fresh-source-bundle-v2') return callback();
    if (!isDeepStrictEqual(source.structuredArtifacts, artifacts)) throw new Error('PDF quotation artifacts differ from sealed source');
    const active = scope.getStore();
    if (active?.artifacts === artifacts) return callback();
    const expectation = { rootDir: path.join(context.runDir, 'sources'), arxivId: d.paperId,
        generation: d.sourceGeneration, sourceManifestSha256: d.sourceManifestSha256, sourceSnapshotSha256: d.sourceSnapshotSha256 };
    const response = deriveBundle(expectation);
    return scope.run({ artifacts, expectation, sourceText: source.text, document: response.document }, callback);
}

function verifiedSourceContext() {
    const active = scope.getStore();
    return active ? structuredClone({ artifacts: active.artifacts, expectation: active.expectation, sourceText: active.sourceText }) : null;
}
function document() { return scope.getStore()?.document ? structuredClone(scope.getStore().document) : null; }
function evidenceForQuotes(quotes) {
    const active = scope.getStore();
    if (!active) throw new Error('PDF quotation requires the actual verified source scope');
    const response = deriveBundle(active.expectation, quotes);
    if (!isDeepStrictEqual(response.document, active.document)) throw new Error('PDF quotation text changed inside source scope');
    if (response.results.some(r => !r.eligible)) throw new Error('PDF quotation is missing or ambiguous: ' + response.results.filter(r => !r.eligible).map(r => r.reason).join('; '));
    return response.results.map(r => structuredClone(r.evidence));
}
function quoteEvidence(quote) { return evidenceForQuotes([quote])[0]; }
function assertQuoteEvidence(proof) {
    const actual = quoteEvidence(proof?.quote);
    if (!isDeepStrictEqual(actual, proof)) throw new Error('PDF quotation proof differs from the actual sealed PDF');
    return true;
}

function withSavedPaper(paper, callback) {
    const bindings = paper?.apiReaderPlan?.tableBindings || [];
    const marked = bindings.filter(binding => binding.sealedPdfQuoteEvidence !== undefined);
    if (!marked.length) return callback();
    const fresh = require('./fresh-analysis-context'), proof = paper.freshRewriteProvenance;
    if (!proof || proof.contract !== 'fresh-source-analysis-v1' || !isDeepStrictEqual(proof, paper.analysisManifest?.freshRewriteProvenance)
        || !/^[a-f0-9-]{36}$/.test(proof.runId || '')) throw new Error('PDF quotation lacks the actual daily provenance');
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, proof.runId);
    const run = require('./reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
    if (run.contract !== fresh.DAILY_SOURCE_RUN_CONTRACT) throw new Error('PDF quotation run contract differs');
    const source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
    const d = source.freshSourceDescriptor, acquisition = paper.analysisManifest?.sourceAcquisition;
    if (paper.sourceSha256 !== d.sourceSha256 || acquisition?.sourceSha256 !== d.sourceSha256
        || acquisition.structuredArtifactsSha256 !== d.structuredArtifactsSha256
        || ['runId','sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256','sourceGeneration','sourceManifestSha256'].some(k => proof[k] !== d[k])
        || paper.apiReaderPlan.structuredSourcePayload !== require('../deep-analyzer').readerStructuredSourcePayload(source.structuredArtifacts)) throw new Error('PDF quotation saved four-source payload differs');
    const expectation = { rootDir: path.join(runDir, 'sources'), arxivId: d.paperId, generation: d.sourceGeneration,
        sourceManifestSha256: d.sourceManifestSha256, sourceSnapshotSha256: d.sourceSnapshotSha256 };
    const all = marked.flatMap(binding => {
        if (binding.sourceType !== 'source_quotes' || !Array.isArray(binding.sealedPdfQuoteEvidence) || !binding.sealedPdfQuoteEvidence.length) throw new Error('PDF quotations only authorize source_quotes bindings');
        if (!Array.isArray(binding.sourceQuotes) || binding.sourceQuotes.some(item =>
            !item || typeof item.quote !== 'string' || item.quote.length < 12 || item.quote.length > 4000
            || !source.text.includes(item.quote) || item.sourceQuoteSha256 !== sha(item.quote)))
            throw new Error('Mixed PDF quotation HTML evidence is absent from the sealed source');
        return binding.sealedPdfQuoteEvidence;
    });
    const response = deriveBundle(expectation, all.map(evidence => evidence.quote));
    if (response.results.some((entry, index) => !entry.eligible || !isDeepStrictEqual(entry.evidence, all[index]))) throw new Error('Saved PDF quotation cannot be replayed');
    return scope.run({ artifacts: source.structuredArtifacts, expectation, sourceText: source.text, document: response.document }, callback);
}

const extractionScope = callback => require('./reader-pdf-extraction-scope').withPdfExtractionScope(callback);
module.exports = { CONTRACT, deriveBundle, withArtifacts: (...args) => extractionScope(() => withArtifacts(...args)),
    document, evidenceForQuotes, quoteEvidence, assertQuoteEvidence,
    withSavedPaper: (...args) => extractionScope(() => withSavedPaper(...args)), verifiedSourceContext };

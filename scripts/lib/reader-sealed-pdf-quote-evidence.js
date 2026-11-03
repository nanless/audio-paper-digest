'use strict';
// Separate PDF quotation origin; it never changes HTML evidence or an input identity.
const { isFreshSourceProvenance } = require('./daily-source-format');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const codec = require('./protocol-codec'), format = require('./reader-proof-format');
const CONTRACT = 'reader-sealed-pdf-quotes';
const SCIENTIFIC_CONTRACT = 'reader-sealed-pdf-scientific-quantities';
const SCIENTIFIC_OPERATION = 'scientific-glyph-atoms';
const PROJECTION = 'reader-pdf-quote-projection', SCHEDULE = 'reader-pdf-adamw-schedule';
const scope = new AsyncLocalStorage(), root = path.resolve(__dirname, '../..');
const scientificCapabilities = new WeakMap();
const program = path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py');
const projectionProgram = path.join(root, 'scripts/reader_pdf_quote_projection.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./reader-repair').hashDraft(value);
const isQuote = value => format.hasHeader(value, CONTRACT);
const currentHeader = family => codec.recordHeader(codec.contract(family), family);
const originalHeader = (family, variant) => codec.historicalHeader(family, variant);
function extractionInputs(current) {
    if (!current) return [program];
    const catalog = path.join(root, 'config/protocols');
    return [program, projectionProgram, ...['protocol_codec.py', 'git_file_bytes.py']
        .map(name => path.join(root, 'scripts', name)), ...fs.readdirSync(catalog).filter(name => name.endsWith('.json'))
        .sort().map(name => path.join(catalog, name))];
}

function deriveBundle(expectation, quotes = [], operation = null, requested = format.header(CONTRACT)) {
    const header = format.readHeader(requested, CONTRACT);
    if (!isDeepStrictEqual(header, requested) || operation !== null && operation !== SCIENTIFIC_OPERATION) {
        throw new Error('Unknown sealed PDF quotation representation or operation');
    }
    const current = isDeepStrictEqual(header, currentHeader(CONTRACT));
    if (!current && !isDeepStrictEqual(header, originalHeader(CONTRACT, 'unique-contiguous-official-pdf-fragment'))) {
        throw new Error('PDF quotation representation lacks an exact encoder');
    }
    const extractor = current ? projectionProgram : program;
    const responseFamily = operation ? SCIENTIFIC_CONTRACT : CONTRACT;
    const responseHeader = !operation ? header : current ? currentHeader(SCIENTIFIC_CONTRACT)
        : originalHeader(SCIENTIFIC_CONTRACT, 'font-and-position-authenticated-atoms');
    require('../env-loader').requireExternalRuntime('reader-sealed-pdf-quote-evidence');
    require('../workspace-role').requireWorkspaceRole('daily', root);
    const sources = path.resolve(expectation.rootDir || ''), run = path.basename(path.dirname(sources));
    if (path.basename(sources) !== 'sources' || path.dirname(path.dirname(sources)) !== path.resolve(require('../config').FILES.dailyFreshSourceRunsDir)
        || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run)) throw new Error('Expected current daily sealed source root');
    if (!Array.isArray(quotes) || quotes.length > 64 || quotes.some(q => typeof q !== 'string')) throw new Error('Expected bounded PDF quote requests');
    return require('./fresh-analysis-context').withVerifiedBundleReaderAuthorFiles(expectation, source => {
        const api = require('./fresh-arxiv-rewrite-source'), before = api.readFreshArxivRewriteSource(expectation);
        const files = extractionInputs(current);
        const implementation = files.map(file => sha(fs.readFileSync(file)));
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-pdf-quotes-'));
        fs.chmodSync(directory, 0o700);
        const file = path.join(directory, 'private-input.json'); let fd;
        try {
            const wireOperation = !operation ? {} : { operation: current ? operation
                : codec.historicalContract('reader-pdf-scientific-extraction-operation', 'glyph-atoms') };
            fs.writeFileSync(file, JSON.stringify({ ...wireOperation, pdfBase64: before.pdf.toString('base64'), pdfSha256: sha(before.pdf), quotes }), { mode: 0o600 });
            fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const raw = require('./reader-pdf-extraction-scope').runPdfExtractor(extractor, fd, files.filter(file => file !== extractor));
            const response = JSON.parse(raw), after = api.readFreshArxivRewriteSource(expectation);
            if (!isDeepStrictEqual(format.readHeader(response, responseFamily), responseHeader)
                || !isDeepStrictEqual(format.readHeader(response.document, CONTRACT), header)
                || response.document.pdfSha256 !== sha(before.pdf) || !Array.isArray(response.results) || response.results.length !== quotes.length
                || !isDeepStrictEqual(before.manifest, after.manifest) || before.sourceManifestSha256 !== after.sourceManifestSha256
                || stable(before.runtimeDetails) !== stable(after.runtimeDetails)
                || !isDeepStrictEqual(extractionInputs(current), files)
                || files.some((file, index) => sha(fs.readFileSync(file)) !== implementation[index])) throw new Error('PDF quotation source or extraction program changed');
            if (response.document.available && (sha(response.document.rawFullText) !== response.document.rawFullTextSha256
                || sha(response.document.normalizedFullText) !== response.document.normalizedFullTextSha256)) throw new Error('PDF text projection hash differs');
            for (const result of response.results.filter(r => r.eligible)) {
                const proof = result.evidence;
                if (!isDeepStrictEqual(format.readHeader(proof, CONTRACT), header) || proof.valueOrigin !== 'sealed_pdf' || proof.pdfSha256 !== response.document.pdfSha256
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
    if (!fresh.isBundleDescriptor(d)) return callback();
    if (!isDeepStrictEqual(source.structuredArtifacts, artifacts)) throw new Error('PDF quotation artifacts differ from sealed source');
    const active = scope.getStore();
    const header = format.header(CONTRACT);
    if (active?.artifacts === artifacts && isDeepStrictEqual(active.header, header)) return callback();
    const expectation = { rootDir: path.join(context.runDir, 'sources'), arxivId: d.paperId,
        generation: d.sourceGeneration, sourceManifestSha256: d.sourceManifestSha256, sourceSnapshotSha256: d.sourceSnapshotSha256 };
    const response = deriveBundle(expectation, [], null, header);
    return scope.run({ artifacts, expectation, sourceText: source.text, document: response.document, header }, callback);
}

function verifiedSourceContext() {
    const active = scope.getStore();
    return active ? structuredClone({ artifacts: active.artifacts, expectation: active.expectation, sourceText: active.sourceText }) : null;
}
function document() { return scope.getStore()?.document ? structuredClone(scope.getStore().document) : null; }
function originalRequestDocument() {
    // The paid request renderer still has the original exact text domain.
    // Metadata-only proof migration may not change that request's bytes.
    const value = document();
    if (!value || !codec.isCurrentHeader(value, CONTRACT)) return value;
    delete value.schemaFingerprint;
    value.contract = originalHeader(CONTRACT, 'unique-contiguous-official-pdf-fragment').contract;
    if (value.extraction) value.extraction.projection = originalHeader(PROJECTION, 'collapse-whitespace-only').contract;
    return value;
}
function evidenceForQuotes(quotes) {
    const active = scope.getStore();
    if (!active) throw new Error('PDF quotation requires the actual verified source scope');
    const response = deriveBundle(active.expectation, quotes, null, active.header);
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

// The caller has resolved actual sealed-PDF quotations in the current source
// scope. A JSON object or a copied returned token cannot create this authority.
function scientificCoverageForQuotes(quotes) {
    const active = scope.getStore();
    if (!active || !Array.isArray(quotes)) throw new Error('Scientific PDF coverage requires the actual source scope');
    const selected = quotes.flatMap((quote, index) => quote?.valueOrigin === 'sealed_pdf'
        && isQuote(quote) ? [{quote,index}] : []);
    if (!selected.length) return null;
    const response = deriveBundle(active.expectation, selected.map(item=>item.quote.quote), SCIENTIFIC_OPERATION, active.header);
    if (!isDeepStrictEqual(response.document, active.document)
        || response.results.some((result,index)=>!result.eligible || !isDeepStrictEqual(result.evidence,selected[index].quote)))
        throw new Error('Scientific PDF coverage differs from the original complete quotations');
    const expectedSchedule = codec.isCurrentHeader(active.header, CONTRACT) ? currentHeader(SCHEDULE)
        : originalHeader(SCHEDULE, 'complete-three-stage-learning-rates').contract;
    const schedules = response.results.flatMap((result,index)=>isDeepStrictEqual(result.family, expectedSchedule)
        && result.scientificQuantities?.length === 3
        ? [{quoteIndex:selected[index].index, atoms:result.scientificQuantities}] : []);
    const token = Object.freeze(Object.create(null));
    scientificCapabilities.set(token, {active,values:quotes.map(item=>typeof item==='string'?item:item?.quote),schedules});
    return token;
}
function readScientificCoverage(token, values) {
    const entry = scientificCapabilities.get(token);
    if (!entry || entry.active !== scope.getStore() || !isDeepStrictEqual(entry.values,values))
        throw new Error('Scientific PDF coverage token is absent, copied, stale or from another source');
    return structuredClone(entry.schedules);
}

function withSavedPaper(paper, callback) {
    const bindings = paper?.apiReaderPlan?.tableBindings || [];
    const marked = bindings.filter(binding => binding.sealedPdfQuoteEvidence !== undefined);
    if (!marked.length) return callback();
    const fresh = require('./fresh-analysis-context'), proof = paper.freshRewriteProvenance;
    if (!proof || !isFreshSourceProvenance(proof) || !isDeepStrictEqual(proof, paper.analysisManifest?.freshRewriteProvenance)
        || !/^[a-f0-9-]{36}$/.test(proof.runId || '')) throw new Error('PDF quotation lacks the actual daily provenance');
    const runDir = path.join(require('../config').FILES.dailyFreshSourceRunsDir, proof.runId);
    const run = require('./reader-proof-read-scope').readReaderProofJson(path.join(runDir, 'run.json')).value;
    if (!fresh.isDailySourceRun(run)) throw new Error('PDF quotation run contract differs');
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
    const header = format.readHeader(all[0], CONTRACT);
    if (all.some(evidence => !isDeepStrictEqual(format.readHeader(evidence, CONTRACT), header))) {
        throw new Error('Saved PDF quotations mix original and current representations');
    }
    const response = deriveBundle(expectation, all.map(evidence => evidence.quote), null, header);
    if (response.results.some((entry, index) => !entry.eligible || !isDeepStrictEqual(entry.evidence, all[index]))) throw new Error('Saved PDF quotation cannot be replayed');
    return scope.run({ artifacts: source.structuredArtifacts, expectation, sourceText: source.text, document: response.document, header }, callback);
}

const extractionScope = callback => require('./reader-pdf-extraction-scope').withPdfExtractionScope(callback);
module.exports = { CONTRACT, isQuote, deriveBundle, withArtifacts: (...args) => extractionScope(() => withArtifacts(...args)),
    document, originalRequestDocument, evidenceForQuotes, quoteEvidence, assertQuoteEvidence,
    withSavedPaper: (...args) => extractionScope(() => withSavedPaper(...args)), verifiedSourceContext,
    scientificCoverageForQuotes, readScientificCoverage };

'use strict';
// Separate PDF quotation origin; it never changes HTML evidence or an input identity.
const { isFreshSourceProvenance } = require('./daily-source-format');
const fs = require('node:fs'), path = require('node:path');
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
    require('./fresh-analysis-context').assertSealedFourFileArxivRoot(expectation.rootDir, 'Expected current daily sealed source root');
    if (!Array.isArray(quotes) || quotes.length > 64 || quotes.some(q => typeof q !== 'string')) throw new Error('Expected bounded PDF quote requests');
    return require('./fresh-analysis-context').withVerifiedBundleReaderAuthorFiles(expectation, source => {
        const api = require('./fresh-arxiv-rewrite-source'), before = api.readFreshArxivRewriteSource(expectation);
        const files = extractionInputs(current);
        const implementation = files.map(file => sha(fs.readFileSync(file)));
        const pdfSha256 = sha(before.pdf);
        const wireOperation = !operation ? {} : { operation: current ? operation
            : codec.historicalContract('reader-pdf-scientific-extraction-operation', 'glyph-atoms') };
        const raw = require('./reader-pdf-extraction-scope').runPdfExtractorJson(extractor, {
            pdfBuffer: before.pdf,
            pdfSha256,
            meta: { ...wireOperation, pdfSha256, quotes },
            tmpPrefix: 'sealed-pdf-quotes-'
        }, files.filter(file => file !== extractor));
        const response = JSON.parse(raw), after = api.readFreshArxivRewriteSource(expectation);
        if (!isDeepStrictEqual(format.readHeader(response, responseFamily), responseHeader)
            || !isDeepStrictEqual(format.readHeader(response.document, CONTRACT), header)
            || response.document.pdfSha256 !== pdfSha256 || !Array.isArray(response.results) || response.results.length !== quotes.length
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
    });
}

function withArtifacts(artifacts, paperId, callback) {
    const fresh = require('./fresh-analysis-context');
    if (!fresh.isSealedFourFileArxivScope()) return callback();
    const bundle = fresh.resolveActiveSealedFourFileArxivBundle(paperId);
    // Older text-only sources or mock contexts without physical four-file bundles cannot acquire the PDF capability.
    if (!bundle) return callback();
    const source = bundle.source;
    if (!isDeepStrictEqual(source.structuredArtifacts, artifacts)) throw new Error('PDF quotation artifacts differ from sealed source');
    const active = scope.getStore();
    const header = format.header(CONTRACT);
    if (active?.artifacts === artifacts && isDeepStrictEqual(active.header, header)) return callback();
    const expectation = bundle.expectation;
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
    // 逐项点名失败位置与原因：修复轮必须知道是第几条、缺在 PDF 还是出现多次，
    // 否则只能猜着改整条绑定。
    const failed = response.results.map((result, index) => ({ result, index }))
        .filter(item => !item.result.eligible);
    if (failed.length) throw new Error('PDF quotation is missing or ambiguous: '
        + failed.map(item => `[${item.index}] ${item.result.reason}`).join('; '));
    return response.results.map(r => structuredClone(r.evidence));
}
function quoteEvidence(quote) { return evidenceForQuotes([quote])[0]; }
function lookupVerifiedProof(active, headerKey, proof) {
    if (!active?.verifiedProofs || typeof proof?.quote !== 'string') return false;
    const verified = active.verifiedProofs.get(`${headerKey}\0${proof.quote}`);
    return Boolean(verified && isDeepStrictEqual(verified, proof));
}
function assertQuoteEvidence(proof) {
    const active = scope.getStore();
    const header = format.readHeader(proof, CONTRACT);
    if (!active) throw new Error('PDF quotation requires the actual verified source scope');
    if (lookupVerifiedProof(active, stable(header), proof)) return true;
    const actual = isDeepStrictEqual(header, active.header) ? quoteEvidence(proof.quote)
        : deriveBundle(active.expectation, [proof.quote], null, header).results[0]?.evidence;
    if (!isDeepStrictEqual(actual, proof)) throw new Error('PDF quotation proof differs from the actual sealed PDF');
    return true;
}
function assertQuoteEvidences(proofs) {
    if (!Array.isArray(proofs)) throw new Error('Expected array of sealed PDF quote proofs');
    if (proofs.length === 0) return true;
    if (proofs.length === 1) return assertQuoteEvidence(proofs[0]);
    const active = scope.getStore();
    if (!active) throw new Error('PDF quotation requires the actual verified source scope');
    const groups = new Map();
    for (const proof of proofs) {
        const header = format.readHeader(proof, CONTRACT);
        const key = stable(header);
        if (lookupVerifiedProof(active, key, proof)) continue;
        if (!groups.has(key)) groups.set(key, { header, items: [] });
        groups.get(key).items.push(proof);
    }
    for (const { header, items } of groups.values()) {
        const sameHeader = isDeepStrictEqual(header, active.header);
        const uniqueQuotes = [];
        const seen = new Set();
        for (const proof of items) {
            if (typeof proof?.quote !== 'string') throw new Error('PDF quotation proof differs from the actual sealed PDF');
            if (!seen.has(proof.quote)) {
                seen.add(proof.quote);
                uniqueQuotes.push(proof.quote);
            }
        }
        const actualByQuote = new Map();
        for (let offset = 0; offset < uniqueQuotes.length; offset += 64) {
            const batch = uniqueQuotes.slice(offset, offset + 64);
            if (sameHeader) {
                const evidences = evidenceForQuotes(batch);
                batch.forEach((quote, idx) => actualByQuote.set(quote, evidences[idx]));
            } else {
                const response = deriveBundle(active.expectation, batch, null, header);
                batch.forEach((quote, idx) => actualByQuote.set(quote, response.results[idx]?.evidence));
            }
        }
        for (const proof of items) {
            if (!isDeepStrictEqual(actualByQuote.get(proof.quote), proof)) {
                throw new Error('PDF quotation proof differs from the actual sealed PDF');
            }
        }
    }
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
    const configFiles = require('../config').FILES;
    const runDir = path.join(configFiles.dailyFreshSourceRunsDir, proof.runId);
    const runJsonPath = path.join(runDir, 'run.json');
    let source;
    let expectation;
    const acquisition = paper.analysisManifest?.sourceAcquisition;
    if (fs.existsSync(runJsonPath)) {
        const run = require('./reader-proof-read-scope').readReaderProofJson(runJsonPath).value;
        if (!fresh.isDailySourceRun(run)) throw new Error('PDF quotation run contract differs');
        source = fresh.readFreshSource(runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
        const d = source.freshSourceDescriptor;
        if (paper.sourceSha256 !== d.sourceSha256 || acquisition?.sourceSha256 !== d.sourceSha256
            || acquisition.structuredArtifactsSha256 !== d.structuredArtifactsSha256
            || ['runId','sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256','sourceGeneration','sourceManifestSha256'].some(k => proof[k] !== d[k])
            || paper.apiReaderPlan.structuredSourcePayload !== require('../deep-analyzer').readerStructuredSourcePayload(source.structuredArtifacts)) throw new Error('PDF quotation saved four-source payload differs');
        expectation = { rootDir: path.join(runDir, 'sources'), arxivId: d.paperId, generation: d.sourceGeneration,
            sourceManifestSha256: d.sourceManifestSha256, sourceSnapshotSha256: d.sourceSnapshotSha256 };
    } else {
        const arxivId = String(paper?.arxivId || paper?.directPaperId || '').replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
        const activeBundle = fresh.isSealedFourFileArxivScope() ? fresh.resolveActiveSealedFourFileArxivBundle(arxivId) : null;
        const historicalRoot = (activeBundle && activeBundle.kind === 'historical' && activeBundle.generation === proof.sourceGeneration
            && activeBundle.sourceManifestSha256 === proof.sourceManifestSha256)
            ? activeBundle.rootDir
            : configFiles.freshArxivFetchedSourcesDir;
        if (!historicalRoot || !/^\d{4}\.\d{4,5}$/.test(arxivId)
            || !Number.isSafeInteger(proof.sourceGeneration) || proof.sourceGeneration < 1
            || !require('./fresh-arxiv-rewrite-source').generationExists(historicalRoot, arxivId, proof.sourceGeneration)) {
            throw new Error('PDF quotation lacks the actual daily provenance');
        }
        const stored = require('./fresh-arxiv-rewrite-source').readFreshArxivRewriteSource({
            rootDir: historicalRoot, arxivId, generation: proof.sourceGeneration
        });
        const historicalSnapshotSha = fresh.historicalSourceSnapshotSha(stored.runtimeDetails);
        const runtime = stored.runtimeDetails;
        if (stored.sourceManifestSha256 !== proof.sourceManifestSha256
            || stored.manifest.text.responseSha256 !== proof.sourceSha256
            || runtime?.structuredArtifacts?.payloadSha256 !== proof.structuredArtifactsSha256
            || historicalSnapshotSha !== proof.sourceSnapshotSha256
            || paper.sourceSha256 !== proof.sourceSha256
            || acquisition?.sourceSha256 !== proof.sourceSha256
            || acquisition?.structuredArtifactsSha256 !== proof.structuredArtifactsSha256
            || paper.apiReaderPlan.structuredSourcePayload !== require('../deep-analyzer').readerStructuredSourcePayload(runtime.structuredArtifacts)) {
            throw new Error('PDF quotation saved four-source payload differs');
        }
        source = { text: runtime.text, structuredArtifacts: runtime.structuredArtifacts };
        expectation = { rootDir: path.resolve(historicalRoot), arxivId, generation: proof.sourceGeneration,
            sourceManifestSha256: stored.sourceManifestSha256, sourceSnapshotSha256: proof.sourceSnapshotSha256 };
    }
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
    const headerKey = stable(header);
    const verifiedProofs = new Map(response.results.map(entry => [`${headerKey}\0${entry.evidence.quote}`, structuredClone(entry.evidence)]));
    return scope.run({ artifacts: source.structuredArtifacts, expectation, sourceText: source.text, document: response.document, header, verifiedProofs }, callback);
}

const extractionScope = callback => require('./reader-pdf-extraction-scope').withPdfExtractionScope(callback);
module.exports = { CONTRACT, isQuote, deriveBundle, withArtifacts: (...args) => extractionScope(() => withArtifacts(...args)),
    document, originalRequestDocument, evidenceForQuotes, quoteEvidence, assertQuoteEvidence, assertQuoteEvidences,
    withSavedPaper: (...args) => extractionScope(() => withSavedPaper(...args)), verifiedSourceContext,
    scientificCoverageForQuotes, readScientificCoverage };

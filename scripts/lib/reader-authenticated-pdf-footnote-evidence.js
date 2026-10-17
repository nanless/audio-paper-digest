'use strict';
// A source capability, independent of HTTP reachability and old resource quotes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage();
const CONTRACT = 'reader-authenticated-pdf-footnote-evidence-v1';
const CORRECTION_CONTRACT = 'reader-authenticated-pdf-footnote-identity-correction-v1';
const EXTRACTION_CONTRACT = 'reader-authenticated-pdf-footnote-extraction-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => sha(JSON.stringify(canonical(value)));
const SHA = /^[a-f0-9]{64}$/u;
const program = path.resolve(__dirname, '../reader_authenticated_pdf_footnote_evidence.py');

function sourceFailure(cause) {
    const error = new Error('认证 PDF 脚注来源核验失败：' + String(cause?.message || cause), { cause });
    Object.assign(error, { code: 'READER_AUTHENTICATED_PDF_FOOTNOTE_INTEGRITY', scope: 'run', retryable: false });
    return error;
}
function boundary(callback) { try { return callback(); } catch (cause) { throw sourceFailure(cause); } }
function withVerifiedSource(handle, callback) {
    const source = boundary(() => require('./conference-source-context').readerPdfSourceForContext(handle));
    if (typeof callback !== 'function' || !source || !Buffer.isBuffer(source.pdf)
        || typeof source.sourceText !== 'string' || sha(source.pdf) !== source.pdfSha256
        || ![source.pdfSha256, source.sourceSnapshotSha256, source.structuredArtifactsSha256].every(value => SHA.test(value || ''))
        || !source.sourceIdentity || typeof source.assertUnchanged !== 'function') {
        throw sourceFailure('缺少真实认证 PDF 句柄');
    }
    const active = scope.getStore();
    if (active?.active && active.handle === handle && isDeepStrictEqual(active.source.sourceIdentity, source.sourceIdentity)) return callback();
    const state = { handle, source, active: true, candidates: null, document: null };
    const finish = () => { state.active = false; state.candidates = null; state.document = null; };
    return require('./reader-pdf-extraction-scope').withPdfExtractionScope(() => {
        try {
            const result = scope.run(state, callback);
            if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish);
            finish(); return result;
        } catch (error) { finish(); throw error; }
    });
}
function withoutVerifiedSource(callback) { return scope.run(null, callback); }
function extract(source) {
    require('../env-loader').requireExternalRuntime('reader-authenticated-pdf-footnote-evidence');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'authenticated-pdf-footnote-'));
    let fd;
    try {
        fs.chmodSync(directory, 0o700);
        const file = path.join(directory, 'input.json');
        fs.writeFileSync(file, JSON.stringify({ pdfBase64: source.pdf.toString('base64'), pdfSha256: source.pdfSha256 }), { mode: 0o600, flag: 'wx' });
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return JSON.parse(require('./reader-pdf-extraction-scope').runAuthenticatedPdfFootnoteExtractor(fd));
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
function checkedState(sourceText) {
    const state = scope.getStore();
    if (!state?.active) return null;
    boundary(() => state.source.assertUnchanged());
    if (state.extractorSha256 && state.extractorSha256 !== sha(fs.readFileSync(program))) throw sourceFailure('PDF 脚注证明器在核验期间变化');
    if (sourceText !== undefined && sourceText !== state.source.sourceText) throw sourceFailure('当前全文与真实 PDF 来源不一致');
    return state;
}
function deriveCandidates(sourceText) {
    const state = checkedState(sourceText);
    if (!state) return [];
    if (state.candidates) return structuredClone(state.candidates);
    const implementationSha256 = sha(fs.readFileSync(program));
    const document = boundary(() => extract(state.source));
    if (sha(fs.readFileSync(program)) !== implementationSha256) throw sourceFailure('PDF 脚注证明器在提取期间变化');
    state.extractorSha256 = implementationSha256;
    if (document.contract !== EXTRACTION_CONTRACT || document.pdfSha256 !== state.source.pdfSha256
        || !Array.isArray(document.candidates) || !Array.isArray(document.rejected)
        || document.candidates.length > 128) throw sourceFailure('脚注证明器返回了不匹配的 PDF 身份');
    const result = [];
    for (const candidate of document.candidates) {
        const url = candidate.url;
        const index = state.source.sourceText.indexOf(url);
        // Source text and exact PDF URL must both exist; do not guess a URL from a caption or redirected endpoint.
        if (index < 0 || state.source.sourceText.indexOf(url, index + url.length) >= 0) continue;
        const marker = String(candidate.marker);
        const start = state.source.sourceText.slice(index - marker.length, index) === marker ? index - marker.length : index;
        const sourceQuote = state.source.sourceText.slice(start, index + url.length);
        const body = { contract: CONTRACT, paperId: state.source.paperId, sourceIdentity: state.source.sourceIdentity,
            sourceSnapshotSha256: state.source.sourceSnapshotSha256, sourceTextSha256: sha(state.source.sourceText),
            structuredArtifactsSha256: state.source.structuredArtifactsSha256, pdfSha256: state.source.pdfSha256,
            originalUrl: url, sourceQuote, sourceQuoteSha256: sha(sourceQuote),
            extraction: document.backend, extractorImplementationSha256: state.extractorSha256,
            pdfFootnote: candidate };
        const proof = { ...body, evidenceSha256: stable(body) };
        for (const type of candidate.resourceFacets) result.push({ type, url, sourceToken: url, line: sourceQuote,
            authenticatedPdfFootnoteEvidence: proof });
    }
    boundary(() => state.source.assertUnchanged());
    state.document = document; state.candidates = result;
    return structuredClone(result);
}
function assertEvidence(resource, sourceText) {
    const state = checkedState(sourceText);
    if (!state) throw sourceFailure('已保存的 PDF 脚注证明缺少真实来源作用域');
    const proof = resource?.authenticatedPdfFootnoteEvidence;
    if (!proof || proof.contract !== CONTRACT || resource.origin !== 'paper_source'
        || resource.sourceQuote !== proof.sourceQuote || resource.sourceQuoteSha256 !== proof.sourceQuoteSha256) {
        throw sourceFailure('资源类型或原引文与 PDF 脚注证明不一致');
    }
    const matches = deriveCandidates(state.source.sourceText).filter(candidate => candidate.url === resource.originalUrl
        && candidate.type === resource.type && isDeepStrictEqual(candidate.authenticatedPdfFootnoteEvidence, proof));
    if (matches.length !== 1) throw sourceFailure('已保存脚注证明的编号、归属、URL、坐标或来源已变化');
    boundary(() => state.source.assertUnchanged());
    return true;
}
function diagnostics() {
    const state = checkedState();
    if (!state) return [];
    deriveCandidates(state.source.sourceText);
    return structuredClone(state.document.rejected);
}

// This is an unsigned source correction proposal. Installation, original CAS,
// score semantics and Reader/publication qualification belong to the controlled caller.
function deriveCorrectedIdentity(originalIdentity, sourceText) {
    const state = checkedState(sourceText);
    if (!state) throw sourceFailure('来源纠正需要真实 PDF 句柄');
    const { identitySha256, ...body } = originalIdentity || {};
    if (body.contract !== 'api-reader-resource-identity-v1' || identitySha256 !== stable(body)
        || body.sourceTextSha256 !== sha(sourceText) || !Array.isArray(body.resources)) throw sourceFailure('待纠正原资源身份或全文 SHA 无效');
    const candidates = deriveCandidates(sourceText), byUrl = new Map();
    for (const candidate of candidates) {
        if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, []);
        byUrl.get(candidate.url).push(candidate);
    }
    const resources = [], corrections = [], visited = new Set();
    const sourceFields = new Set(['type', 'origin', 'sourceQuote', 'sourceQuoteSha256', 'sourceUrlToken',
        'sourceUrlTokenSha256', 'sourceUrlBindingContract', 'authenticatedPdfFootnoteEvidence']);
    const preserved = resource => Object.fromEntries(Object.entries(resource).filter(([key]) => !sourceFields.has(key)));
    for (const [index, original] of body.resources.entries()) {
        const same = byUrl.get(original.originalUrl);
        if (!same || original.origin !== 'paper_source') { resources.push(structuredClone(original)); continue; }
        if (visited.has(original.originalUrl)) continue;
        visited.add(original.originalUrl);
        const originals = body.resources.map((resource, originalIndex) => ({ resource, originalIndex }))
            .filter(entry => entry.resource.originalUrl === original.originalUrl);
        if (originals.some(entry => entry.resource.origin !== 'paper_source'
            || stable(preserved(entry.resource)) !== stable(preserved(original)))) throw sourceFailure('同一原 URL 的可达状态记录不唯一');
        const statuses = ['available', 'unavailable', 'temporarily_unreachable'];
        if (!statuses.includes(original.availability) || !Array.isArray(original.redirects)
            || !/^https:\/\//.test(original.finalUrl || '') || !/^https:\/\//.test(original.originalUrl || '')) throw sourceFailure('原 URL 可达状态记录不完整');
        if (originals.some(({ resource }) => resource.sourceQuoteSha256 !== sha(String(resource.sourceQuote || ''))
            || !sourceText.replace(/\s+/g, ' ').includes(String(resource.sourceQuote || '').replace(/\s+/g, ' ').trim()))
            || (original.availability === 'available' && (!Number.isInteger(original.status) || original.status < 200 || original.status >= 400))
            || (original.availability === 'unavailable' && (!Number.isInteger(original.status) || original.status < 400 || original.status >= 500
                || [408, 425, 429].includes(original.status)))
            || (original.availability === 'temporarily_unreachable' && (original.retryable !== true
                || !(original.status === null || [408, 425, 429].includes(original.status)
                    || Number.isInteger(original.status) && original.status >= 500)))) throw sourceFailure('原引文或原可达状态不符合其声明');
        for (const candidate of same) {
            const proof = candidate.authenticatedPdfFootnoteEvidence;
            resources.push({ ...structuredClone(preserved(original)), type: candidate.type, origin: 'paper_source',
                sourceQuote: proof.sourceQuote, sourceQuoteSha256: proof.sourceQuoteSha256,
                authenticatedPdfFootnoteEvidence: structuredClone(proof) });
        }
        corrections.push({ originalResourceIndexes: originals.map(entry => entry.originalIndex),
            originalResourceSha256s: originals.map(entry => stable(entry.resource)),
            originalTypes: originals.map(entry => entry.resource.type),
            originalSourceQuoteSha256s: originals.map(entry => entry.resource.sourceQuoteSha256),
            originalUrl: original.originalUrl, resourceFacets: same.map(candidate => candidate.type),
            evidenceSha256: same[0].authenticatedPdfFootnoteEvidence.evidenceSha256,
            retainedReachabilitySha256: stable(preserved(original)) });
    }
    const identityBody = { ...structuredClone(body), resources };
    const identity = { ...identityBody, identitySha256: stable(identityBody) };
    const proposal = { contract: CORRECTION_CONTRACT, originalIdentitySha256: identitySha256,
        sourceIdentity: structuredClone(state.source.sourceIdentity), identity, corrections, modelRequests: 0, networkRequests: 0 };
    boundary(() => state.source.assertUnchanged());
    return { ...proposal, correctionSha256: stable(proposal) };
}
module.exports = { CONTRACT, CORRECTION_CONTRACT, withVerifiedSource, withoutVerifiedSource,
    deriveCandidates, assertEvidence, diagnostics, deriveCorrectedIdentity };

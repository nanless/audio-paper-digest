'use strict';
// A capability for one complete literal PDF table; it never grants prose units.
const fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const formats = require('./protocol-codec');
const CONTRACT = 'reader-sealed-pdf-column-units-v1';
const root = path.resolve(__dirname, '../..');
const PROJECTION = 'reader-pdf-column-unit-projection';
const program = path.join(root, 'scripts/reader_pdf_column_unit_projection.py');
const domProgram = path.join(root, 'scripts/reader_sealed_pdf_column_units.py');
const quoteProgram = path.join(root, 'scripts/reader_sealed_pdf_quote_evidence.py');
const literalProgram = path.join(root, 'scripts/reader_sealed_pdf_literal_column_units.py');
const geometryProgram = path.join(root, 'scripts/reader_authenticated_pdf_hierarchical_table.py');
const LITERAL_CONTRACT = 'reader-sealed-pdf-literal-column-units-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const stable = value => sha(JSON.stringify(normalize(value)));
function literalUnitColumnAllowed(proof, view, item) {
    if (!Number.isSafeInteger(item?.column) || item.column < 0 || item.column >= view[0].length) return false;
    return item.column > 0 || (proof.axisProfile === 'complete-literal-snr-axis-v1'
        && view[0][0] === 'SNR (dB)' && item.unit === 'db'
        && isDeepStrictEqual(proof.identityColumns, [0]));
}
function deriveBundle(expectation, view, quotes) {
    require('../env-loader').requireExternalRuntime('reader-sealed-pdf-column-units');
    require('../workspace-role').requireWorkspaceRole('daily', root);
    require('./fresh-analysis-context').assertSealedFourFileArxivRoot(expectation.rootDir, 'Column units require the actual daily sealed source root');
    return require('./fresh-analysis-context').withVerifiedBundleReaderAuthorFiles(expectation, source => {
        const api = require('./fresh-arxiv-rewrite-source'), before = api.readFreshArxivRewriteSource(expectation);
        const files = [domProgram, quoteProgram, literalProgram, geometryProgram], implementation = files.map(file => sha(fs.readFileSync(file)));
        const projectionSha256 = sha(fs.readFileSync(program));
        const pdfSha256 = sha(before.pdf);
        const result = JSON.parse(require('./reader-pdf-extraction-scope').runPdfExtractorJson(program, {
            pdfBuffer: before.pdf,
            pdfSha256,
            meta: { pdfSha256, tables: source.structuredArtifacts.tables, view, quotes },
            tmpPrefix: 'sealed-pdf-column-units-'
        }, files));
        const after = api.readFreshArxivRewriteSource(expectation);
        const fields = ['contract', 'schemaFingerprint', 'eligible', ...(result?.eligible === true
            ? ['originalEvidenceSha256', 'originalProof'] : ['reason'])];
        if (!formats.isCurrentHeader(result, PROJECTION) || typeof result.eligible !== 'boolean'
            || !isDeepStrictEqual(Object.keys(result).sort(), fields.sort())
            || !isDeepStrictEqual(before.manifest, after.manifest)
            || before.sourceManifestSha256 !== after.sourceManifestSha256
            || !isDeepStrictEqual(before.runtimeDetails, after.runtimeDetails)
            || sha(fs.readFileSync(program)) !== projectionSha256
            || files.some((file,index) => sha(fs.readFileSync(file)) !== implementation[index])) throw new Error('Column unit source or implementation changed');
        if (!result.eligible) return null;
        const proof = result.originalProof;
        if (!/^[a-f0-9]{64}$/.test(result.originalEvidenceSha256 || '')
            || proof?.evidenceSha256 !== result.originalEvidenceSha256) throw new Error('Original PDF column proof digest differs');
        if (proof?.contract === LITERAL_CONTRACT) {
            if (proof.valueOrigin !== 'sealed_pdf' || proof.sourceBasis !== 'independent-complete-pdf-grid'
                || proof.pdfSha256 !== pdfSha256 || proof.viewSha256 !== stable(view)
                || !isDeepStrictEqual(proof.renderedView, view) || proof.sourceTableOrdinal !== undefined
                || !Array.isArray(proof.units) || !proof.units.length
                || proof.units.some(item => !literalUnitColumnAllowed(proof, view, item) || !Array.isArray(item.values)
                    || !isDeepStrictEqual(item.values, view.slice(1).map(row => row[item.column]))
                    || !/^(?:%|db|ms|s|h|hz|khz|mhz|gb|mb|kb|pp)$/.test(item.unit))
                || !Array.isArray(proof.rowIdentities) || proof.rowIdentities.length !== view.length - 1
                || !isDeepStrictEqual(proof.implementationFiles, files.map((file, index) =>
                    ({ file: path.basename(file), sha256: implementation[index] })))
                || !Array.isArray(proof.quoteEvidence) || proof.quoteEvidence.length !== quotes.length)
                throw new Error('Independent sealed PDF column proof/source identity differs');
            return structuredClone(proof);
        }
        const table = source.structuredArtifacts.tables.find(t => t.ordinal === proof.sourceTableOrdinal);
        if (!table || proof.contract !== CONTRACT || proof.valueOrigin !== 'sealed_pdf'
            || proof.pdfSha256 !== pdfSha256 || proof.sourceTableDomSha256 !== table.sourceDomSha256
            || proof.sourceTableSha256 !== stable(table)
            || proof.cells.length !== table.cells.length || !Array.isArray(proof.units)) throw new Error('Column unit proof/source identity differs');
        return structuredClone(proof);
    });
}
function coverage(table, quotes) {
    const quoteApi = require('./reader-sealed-pdf-quote-evidence'), context = quoteApi.verifiedSourceContext();
    if (!context) return [];
    const pdf = quotes.filter(quoteApi.isQuote);
    if (!pdf.length) return [];
    // Every bound quote is replayed; a model string/boolean cannot claim this capability.
    quoteApi.assertQuoteEvidences(pdf);
    const proof = deriveBundle(context.expectation, [table.header, ...table.rows], pdf.map(item => item.quote));
    return proof ? proof.units.flatMap(item => item.values.map((value,index) => ({ row:index+1, column:item.column, value, unit:item.unit }))) : [];
}
module.exports = { CONTRACT, deriveBundle, coverage };

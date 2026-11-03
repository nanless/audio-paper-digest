'use strict';
const codec = require('./protocol-codec');
const equal = require('node:util').isDeepStrictEqual;
const FAMILY = 'reader-resource-availability-claims';
const header = () => codec.recordHeader(codec.contract(FAMILY), FAMILY);
function declared(manifest, stage) {
    return manifest?.contracts?.readerResourceClaims !== undefined
        || stage?.readerResourceClaimsContractVersion !== undefined || stage?.readerResourceClaimsProtocol !== undefined;
}
function requiredForSavedPaper(paper) {
    const manifest = paper?.analysisManifest, stage = manifest?.stages?.apiReaderArticle;
    if (declared(manifest, stage)) return true;
    const provenance = paper?.freshRewriteProvenance;
    // Reject-only hint: actual current sealed-source records cannot acquire
    // the old no-marker interpretation by stripping both claims markers.
    return Number.isInteger(provenance?.sourceGeneration)
        && /^[a-f0-9]{64}$/.test(String(provenance?.sourceManifestSha256 || ''))
        && (Object.hasOwn(stage || {}, 'readerProtocols') || Object.hasOwn(stage || {}, 'readerIdentityProtocols'));
}
function matches(manifest, stage) {
    const raw = manifest?.contracts?.readerResourceClaims;
    if (Object.hasOwn(stage || {}, 'readerResourceClaimsProtocol')) {
        const value = stage.readerResourceClaimsProtocol;
        return !Object.hasOwn(stage, 'readerResourceClaimsContractVersion')
            && codec.hasValidHeader(value, FAMILY) && value.contract === raw
            && equal(value, codec.recordHeader(value.contract, FAMILY, value.schemaFingerprint));
    }
    return raw === codec.historicalContract(FAMILY, 'authenticated-source-replay')
        && stage?.readerResourceClaimsContractVersion === raw;
}
const stageFields = () => ({ readerResourceClaimsProtocol: header() });
module.exports = { header, declared, requiredForSavedPaper, matches, stageFields };

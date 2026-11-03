'use strict';
// Exact metadata decoding only; body/source/ledger checks remain mandatory.
const codec = require('./protocol-codec');
const equal = require('node:util').isDeepStrictEqual;
const families = Object.freeze({ authors: 'api-reader-author-identity', resources: 'api-reader-resource-identity' });
const fields = Object.freeze({ authors: 'readerAuthorIdentityContractVersion', resources: 'resourceIdentityContractVersion' });
const soloFields = Object.freeze({ authors: 'readerAuthorIdentityProtocol', resources: 'readerResourceIdentityProtocol' });
const manifestFields = Object.freeze({ authors: 'apiReaderAuthorIdentity', resources: 'apiReaderResourceIdentity' });
function family(role) { if (!families[role]) throw new Error('Reader identity role is unknown'); return families[role]; }
function header(role, ...records) {
    const name = family(role);
    if (!records.length) return codec.recordHeader(codec.contract(name), name);
    const [value] = records;
    if (!codec.hasValidHeader(value, name)) throw new Error('Reader identity header is unknown or mixed');
    return codec.recordHeader(value.contract, name, value.schemaFingerprint);
}
function hasIdentity(value, role) { try { header(role, value); return true; } catch { return false; } }
function group(authors, resources) {
    return codec.record('reader-identity-bindings', { authors: header('authors', authors.identity), resources: header('resources', resources) });
}
function payloadBinding(paper, role) {
    try {
        const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
        const value = role === 'authors' ? paper?.apiReaderAuthors?.identity : paper?.apiReaderResources;
        const actual = header(role, value);
        if (paper?.analysisManifest?.contracts?.[manifestFields[role]] !== actual.contract) return false;
        if (Object.hasOwn(stage || {}, 'readerIdentityProtocols')) {
            if ([...Object.values(fields), ...Object.values(soloFields)].some(field => Object.hasOwn(stage, field))) return false;
            return equal(stage.readerIdentityProtocols, group(paper.apiReaderAuthors, paper.apiReaderResources));
        }
        if (Object.hasOwn(stage || {}, soloFields[role]))
            return !Object.hasOwn(stage, fields[role]) && equal(stage[soloFields[role]], actual);
        return !Object.hasOwn(actual, 'schemaFingerprint') && stage?.[fields[role]] === actual.contract;
    } catch { return false; }
}
function stageFields(authors, resources) { return { readerIdentityProtocols: group(authors, resources) }; }
function refreshAuthorFields(stage, authors, resources) {
    delete stage.readerAuthorIdentityContractVersion;
    if (Object.hasOwn(stage, 'readerIdentityProtocols')) {
        delete stage.readerAuthorIdentityProtocol;
        stage.readerIdentityProtocols = group(authors, resources);
    } else stage.readerAuthorIdentityProtocol = header('authors', authors.identity);
}
function openSourceFields(resources) { return { resourceEvidenceProtocol: header('resources', resources) }; }
function assignOpenSourceBinding(stage, resources) {
    // A completed source scan is protected upstream. Reusing its unchanged
    // actual resource identity preserves its original encoding as well.
    if (openSourceBinding(stage, resources)) return stage;
    delete stage.resourceEvidenceContract; delete stage.resourceEvidenceProtocol;
    return Object.assign(stage, openSourceFields(resources));
}
function openSourceBinding(stage, resources) {
    try {
        const actual = header('resources', resources);
        return Object.hasOwn(stage || {}, 'resourceEvidenceProtocol')
            ? !Object.hasOwn(stage, 'resourceEvidenceContract') && equal(stage.resourceEvidenceProtocol, actual)
            : !Object.hasOwn(actual, 'schemaFingerprint') && stage?.resourceEvidenceContract === actual.contract;
    } catch { return false; }
}
// Reconstruct the original comparison domain from source-derived values. This
// never rewrites the saved record or accepts its contents as source evidence.
function inSavedHeaderDomain(identity, saved, role) {
    const expected = header(role, saved), current = header(role, identity);
    const body = Object.fromEntries(Object.entries(identity).filter(([key]) => !Object.hasOwn(current, key)));
    return { ...expected, ...body };
}
function originalFingerprintFields() {
    return { authorIdentityContractVersion: codec.historicalContract(families.authors, 'source-bound-identity'),
        resourceIdentityContractVersion: codec.historicalContract(families.resources, 'source-bound-identity') };
}
function fingerprintFields(stage = null) {
    return stage?.status === 'complete' && !Object.hasOwn(stage, 'readerIdentityProtocols')
        ? originalFingerprintFields() : { readerIdentityPolicy: codec.record('reader-identity-bindings', {
            authors: header('authors'), resources: header('resources') }) };
}
module.exports = { header, hasIdentity, payloadBinding, stageFields, refreshAuthorFields, openSourceFields, assignOpenSourceBinding, openSourceBinding,
    inSavedHeaderDomain, originalFingerprintFields, fingerprintFields };

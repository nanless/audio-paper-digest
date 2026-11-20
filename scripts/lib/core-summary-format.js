'use strict';

const protocols = require('./protocol-codec');
const name = 'core-summary';
const legacySchemaFingerprint = '0492b17abed5cb34bcd340790cb9bd803e79c59b2e7bbb08a13de750e0f66ba6';
const originalTag = protocols.historicalHeader(name, 'source-bound-detailed-summary', null).contract;
const legacyHeader = () => protocols.historicalHeader(name, 'source-bound-detailed-summary', legacySchemaFingerprint);
const currentHeader = () => protocols.recordHeader(name, name);

function readDeclaration(value) {
    if (value === originalTag) return { contract: originalTag };
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === 'contract,schemaFingerprint'
        && protocols.hasValidHeader(value, name) ? { ...value } : null;
}

function isExecutiveAbstractHeader(header) {
    const resolved = typeof header === 'string' ? readDeclaration(header) : header;
    return Boolean(resolved && typeof resolved === 'object' && !Array.isArray(resolved)
        && protocols.isCurrentHeader(resolved, name));
}

function stageFields(header) {
    return { contractVersion: header.contract,
        ...(Object.hasOwn(header, 'schemaFingerprint') ? { contractSchemaFingerprint: header.schemaFingerprint } : {}) };
}

function readStage(declaration, stage) {
    const header = readDeclaration(declaration);
    if (!header || !stage) return null;
    const fields = stageFields(header);
    return stage.contractVersion === fields.contractVersion
        && Object.hasOwn(stage, 'contractSchemaFingerprint') === Object.hasOwn(fields, 'contractSchemaFingerprint')
        && stage.contractSchemaFingerprint === fields.contractSchemaFingerprint ? header : null;
}

module.exports = {
    originalTag,
    legacySchemaFingerprint,
    legacyHeader,
    currentHeader,
    isExecutiveAbstractHeader,
    readDeclaration,
    readStage,
    stageFields
};

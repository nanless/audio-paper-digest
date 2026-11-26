'use strict';

const protocols = require('./protocol-codec');
const name = 'core-summary';
const legacySchemaFingerprint = '0492b17abed5cb34bcd340790cb9bd803e79c59b2e7bbb08a13de750e0f66ba6';
const v4SchemaFingerprint = 'f4354643c215dba4717d9769a310db87adafec301da7ec30434c8f43c1ef8f99';
const EXECUTIVE_ABSTRACT_PROFILES = Object.freeze(['executive-abstract', 'executive-abstract-v4']);
const originalTag = protocols.historicalHeader(name, 'source-bound-detailed-summary', null).contract;
const legacyHeader = () => protocols.historicalHeader(name, 'source-bound-detailed-summary', legacySchemaFingerprint);
const v4Header = () => protocols.historicalHeader(name, 'source-bound-detailed-summary', v4SchemaFingerprint);
const currentHeader = () => protocols.recordHeader(name, name);

function readDeclaration(value) {
    if (value === originalTag) return { contract: originalTag };
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === 'contract,schemaFingerprint'
        && protocols.hasValidHeader(value, name) ? { ...value } : null;
}

function isExecutiveAbstractHeader(header) {
    const resolved = typeof header === 'string' ? readDeclaration(header) : header;
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)
        || !protocols.hasValidHeader(resolved, name)
        || !Object.hasOwn(resolved, 'schemaFingerprint')) {
        return false;
    }
    const schema = protocols.declaredSchema(resolved.contract, name, resolved.schemaFingerprint);
    return EXECUTIVE_ABSTRACT_PROFILES.includes(schema?.summaryProfile);
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
    v4SchemaFingerprint,
    EXECUTIVE_ABSTRACT_PROFILES,
    legacyHeader,
    v4Header,
    currentHeader,
    isExecutiveAbstractHeader,
    readDeclaration,
    readStage,
    stageFields
};

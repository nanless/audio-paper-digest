'use strict';

const protocols = require('./protocol-codec');
const name = 'core-summary';
const originalTag = protocols.historicalContract(name, 'source-bound-detailed-summary');
const currentHeader = () => protocols.recordHeader(name, name);

function readDeclaration(value) {
    if (value === originalTag) return { contract: originalTag };
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === 'contract,schemaFingerprint'
        && protocols.hasValidHeader(value, name) ? { ...value } : null;
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

module.exports = { originalTag, currentHeader, readDeclaration, readStage, stageFields };

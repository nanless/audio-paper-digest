'use strict';

// Only the historical input format is described here. Looking up a path or an
// original budget never grants source, completion, replay, or paid authority.
const records = require('./prompt-legacy-records.json');
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}
freeze(records);
const entries = new Map(records.stages.map(row => [`${row.stage}\0${row.contract}`, Object.freeze(row)]));
function declaration(value) { return String(value || '') || records.defaultDeclaration; }
function legacyPromptRecord(stage, value) {
    const row = entries.get(`${stage}\0${declaration(value)}`);
    if (!row) throw new Error(`阶段 ${stage} 的原提示词声明 ${declaration(value)} 没有登记`);
    return row;
}
function legacyPromptPath(stage, value) { return legacyPromptRecord(stage, value).path; }
function legacyPromptPaths(stage) { return [...new Set(records.stages.filter(row => row.stage === stage).map(row => row.path))]; }
function legacyStageMaxTokens(stage, value, budgets) {
    const row = legacyPromptRecord(stage, value);
    return budgets[row.outputBudget];
}
function legacyDeclarations(stage) { return records.stages.filter(row => row.stage === stage).map(row => row.contract); }
module.exports = { legacyPromptRecord, legacyPromptPath, legacyPromptPaths, legacyStageMaxTokens,
    defaultPromptFiles: Object.freeze(Object.fromEntries(records.stages.filter(row =>
        row.contract === records.defaultDeclaration).map(row => [row.stage, row.path]))),
    filterRecords: Object.freeze(records.filter),
    legacyDeclarations, defaultDeclaration: records.defaultDeclaration,
    indexFormats: Object.freeze(records.indexFormats),
    currentPathPredecessors: Object.freeze(records.currentPathPredecessors), originalSpecialPrompts: records.originalSpecialPrompts,
    originalCurrent: records.originalCurrent, summaryMigrationDeclaration: records.summaryMigrationDeclaration, compatibilityExports: records.compatibilityExports };

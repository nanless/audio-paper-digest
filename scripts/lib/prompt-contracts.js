'use strict';

// New requests use stable paths and content hashes. Original path/declaration
// identities are read only through the historical codec, never a worktree alias.
const current = require('./prompt-current-records.json');
for (const value of Object.values(current)) if (value && typeof value === 'object') Object.freeze(value);
Object.freeze(current);
const legacy = require('./prompt-legacy-codec.js');
const CURRENT_PROMPT_CONTRACT = require('./protocol-codec').contract('analysis-prompt-text');
if (current.contract !== CURRENT_PROMPT_CONTRACT) throw new Error('现用提示词声明与协议目录不一致');
const LEGACY_DEFAULT_PROMPT_DECLARATION = legacy.defaultDeclaration;
const LEGACY_DEFAULT_PROMPT_FILES = legacy.defaultPromptFiles;
const LEGACY_SUMMARY_MIGRATION_DECLARATION = legacy.summaryMigrationDeclaration;
const PROMPT_FILE_VERSIONS = Object.freeze(Object.fromEntries(Object.entries(current.stages)
    .map(([stage, row]) => [stage, Object.freeze({ ...row })])));
const LLM_FILTER_PROMPT_PATH = current.filter;
const CURRENT_SPECIAL_PROMPT_FILES = Object.freeze([...current.special]);
const CURRENT_PROMPT_FILES = Object.freeze([...new Set([
    ...Object.values(PROMPT_FILE_VERSIONS).map(row => row.path), LLM_FILTER_PROMPT_PATH,
    ...CURRENT_SPECIAL_PROMPT_FILES
])].sort());
function currentPromptTextContract(stage) {
    if (!PROMPT_FILE_VERSIONS[stage]) throw new Error(`阶段 ${stage} 没有登记提示词`);
    return CURRENT_PROMPT_CONTRACT;
}
function currentTextStagePromptPath(stage) {
    currentPromptTextContract(stage);
    return PROMPT_FILE_VERSIONS[stage].path;
}
function promptFilePathForContract(stage, declared) {
    if (stage === 'apiReaderRepair' && declared === current.specialContracts.readerFactRepair)
        return current.specialByRole.readerFactRepair;
    return declared === CURRENT_PROMPT_CONTRACT ? currentTextStagePromptPath(stage)
        : legacy.legacyPromptPath(stage, declared);
}
function currentSpecialPromptPath(role) {
    const value = current.specialByRole[role];
    if (!value) throw new Error(`局部提示词 ${role} 没有登记`);
    return value;
}
function promptTextContractForStage(stage) {
    return PROMPT_FILE_VERSIONS[stage] ? CURRENT_PROMPT_CONTRACT : legacy.defaultDeclaration;
}
function currentOrFrozenPromptPath(stage) {
    return PROMPT_FILE_VERSIONS[stage] ? currentTextStagePromptPath(stage) : legacy.legacyPromptPath(stage);
}
function stageForFrozenPromptPath(relativePath) {
    return Object.keys(PROMPT_FILE_VERSIONS).find(stage => legacy.legacyPromptPath(stage) === relativePath) || null;
}
function promptStageMaxTokens(stage, declared, budgets) {
    return declared === CURRENT_PROMPT_CONTRACT ? budgets.configured
        : legacy.legacyStageMaxTokens(stage, declared, budgets);
}
module.exports = {
    CURRENT_PROMPT_CONTRACT, LEGACY_DEFAULT_PROMPT_DECLARATION, LEGACY_DEFAULT_PROMPT_FILES,
    LEGACY_SUMMARY_MIGRATION_DECLARATION, PROMPT_FILE_VERSIONS, LLM_FILTER_PROMPT_PATH,
    CURRENT_SPECIAL_PROMPT_FILES, CURRENT_PROMPT_FILES, currentPromptTextContract,
    currentTextStagePromptPath, promptFilePathForContract, promptTextContractForStage,
    currentOrFrozenPromptPath, stageForFrozenPromptPath, promptStageMaxTokens,
    currentSpecialPromptPath, specialPromptContracts: Object.freeze({ ...current.specialContracts })
};

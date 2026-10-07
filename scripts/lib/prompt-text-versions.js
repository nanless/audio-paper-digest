'use strict';

// prompts/*.md 的提示词正文版本登记表。这里是唯一的真相来源：deep-analyzer 按它
// 选正文，会议与 manual 的指纹也按它决定要哈希哪一份文件。
//
// 已发布的 v1 正文永久冻结在原路径，改文字只新增 -v2 文件。读取旧记录时按记录里
// 声明的版本选路径重算：字段缺失按 v1 处理，未知版本直接报错，不退化成「只校验
// 64 位十六进制」。

const ANALYSIS_PROMPT_TEXT_V1_CONTRACT = 'analysis-prompt-text-v1';
const ANALYSIS_PROMPT_TEXT_V2_CONTRACT = 'analysis-prompt-text-v2';

// 恢复阶段的 v1 冻结路径，外加读者局部修复提示词（它不是一个恢复阶段，但同样
// 参与读者阶段的指纹和失败草稿身份）。旧记录的指纹一律按这里复算。
const FROZEN_V1_PROMPT_FILES = Object.freeze({
    primaryAnalysis: 'prompts/deep-analysis.md',
    openSourceScan: 'prompts/opensource-scan.md',
    revision: 'prompts/gap-fill.md',
    tableRepair: 'prompts/table-fill.md',
    methodRepair: 'prompts/method-fill.md',
    tagSelection: 'prompts/tag-repair.md',
    coreSummaryRepair: 'prompts/core-summary-repair.md',
    structureRepair: 'prompts/structure-repair.md',
    scoringAudit: 'prompts/scoring-audit.md',
    apiReaderArticle: 'prompts/api-reader-article.md',
    apiReaderRepair: 'prompts/api-reader-repair.md',
    imageSupplement: 'prompts/image-supplement.md'
});

// 表里登记的是各阶段当前版本。v1 不写在这里，固定由 FROZEN_V1_PROMPT_FILES 给出。
const PROMPT_FILE_VERSIONS = Object.freeze({
    primaryAnalysis: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/deep-analysis-v2.md'
    }),
    openSourceScan: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/opensource-scan-v2.md'
    }),
    revision: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/gap-fill-v2.md'
    }),
    tableRepair: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/table-fill-v2.md'
    }),
    methodRepair: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/method-fill-v2.md'
    }),
    coreSummaryRepair: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/core-summary-repair-v2.md'
    }),
    structureRepair: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/structure-repair-v2.md'
    }),
    tagSelection: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/tag-repair-v2.md'
    }),
    scoringAudit: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/scoring-audit-v2.md'
    }),
    imageSupplement: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/image-supplement-v2.md'
    }),
    // 读者阶段有两份文件：文章正文和局部修复提示词。它们内容不同、可以分别改字，
    // 所以各自登记版本，记录里也用两个字段分开声明。
    apiReaderArticle: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/api-reader-article-v2.md'
    }),
    apiReaderRepair: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/api-reader-repair-v2.md'
    })
});

// v1 路径反查阶段名。会议实现清单只记路径，需要据此换成当前版本的正文。
const STAGE_BY_FROZEN_V1_PATH = Object.freeze(Object.fromEntries(
    Object.entries(FROZEN_V1_PROMPT_FILES).map(([stage, relativePath]) => [relativePath, stage])
));

// 筛选提示词不进上面那张阶段表：它的身份是「渲染占位符之后的首块」，算法和阶段指纹
// 那套不一样。所以单独给两条路径——v1 永久冻结，新请求读 v2，恢复旧记录时按 v1 重算。
const LLM_FILTER_PROMPT_PATH = 'prompts/filter-v2.md';
const FROZEN_LLM_FILTER_PROMPT_PATH = 'prompts/filter.md';

function promptTextContractForStage(stage) {
    return PROMPT_FILE_VERSIONS[stage]?.contract || ANALYSIS_PROMPT_TEXT_V1_CONTRACT;
}

function currentPromptTextContract(stage) {
    const entry = PROMPT_FILE_VERSIONS[stage];
    if (!entry) throw new Error(`阶段 ${stage} 没有登记提示词版本`);
    return entry.contract;
}

// v1 一律走 FROZEN_V1_PROMPT_FILES 的冻结路径，不跟着当前版本走，
// 否则升到 v2 之后旧记录会被按 v2 文件重算。
function promptFilePathForContract(stage, promptTextContract) {
    const declared = String(promptTextContract || '') || ANALYSIS_PROMPT_TEXT_V1_CONTRACT;
    if (declared === ANALYSIS_PROMPT_TEXT_V1_CONTRACT) {
        const frozen = FROZEN_V1_PROMPT_FILES[stage];
        if (!frozen) throw new Error(`阶段 ${stage} 没有冻结的 v1 提示词路径`);
        return frozen;
    }
    const entry = PROMPT_FILE_VERSIONS[stage];
    if (entry && declared === entry.contract) return entry.path;
    const known = [ANALYSIS_PROMPT_TEXT_V1_CONTRACT];
    if (entry && !known.includes(entry.contract)) known.push(entry.contract);
    throw new Error(`阶段 ${stage} 的提示词版本 ${declared} 没有登记；只认识 ${known.join(' 和 ')}。`);
}

// 新请求用当前版本的提示词正文；旧记录的指纹核验仍走 promptFilePathForContract
// 的 v1 冻结路径，不会因为新版本上线而按 v2 文件重算。
function currentTextStagePromptPath(stage) {
    return promptFilePathForContract(stage, currentPromptTextContract(stage));
}

// 阶段还没登记新版本时当前版本就是 v1，此时这里与 currentTextStagePromptPath 等价，
// 但不抛错。会议与 manual 的清单里有不含 v2 的阶段（例如 demoLinkScan 这种合成的）。
function currentOrFrozenPromptPath(stage) {
    const entry = PROMPT_FILE_VERSIONS[stage];
    return promptFilePathForContract(stage, entry ? entry.contract : ANALYSIS_PROMPT_TEXT_V1_CONTRACT);
}

function stageForFrozenPromptPath(relativePath) {
    return STAGE_BY_FROZEN_V1_PATH[relativePath] || null;
}

module.exports = {
    ANALYSIS_PROMPT_TEXT_V1_CONTRACT,
    ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
    FROZEN_V1_PROMPT_FILES,
    PROMPT_FILE_VERSIONS,
    promptTextContractForStage,
    currentPromptTextContract,
    promptFilePathForContract,
    currentTextStagePromptPath,
    currentOrFrozenPromptPath,
    stageForFrozenPromptPath,
    LLM_FILTER_PROMPT_PATH,
    FROZEN_LLM_FILTER_PROMPT_PATH
};

'use strict';

// prompts/*.md 的提示词正文版本登记表。各阶段实际加载的路径以这张表为准：deep-analyzer 按它
// 选正文，会议与 manual 的指纹也按它决定要哈希哪一份文件。
//
// 已发布的 v1 正文永久冻结在原路径，改文字时新增对应版本文件。读取旧记录时按记录里
// 声明的版本选路径重算：字段缺失按 v1 处理，未知版本直接报错，不退化成「只校验
// 64 位十六进制」。

const ANALYSIS_PROMPT_TEXT_V1_CONTRACT = 'analysis-prompt-text-v1';
const ANALYSIS_PROMPT_TEXT_V2_CONTRACT = 'analysis-prompt-text-v2';
const ANALYSIS_PROMPT_TEXT_V3_CONTRACT = 'analysis-prompt-text-v3';
const ANALYSIS_PROMPT_TEXT_V4_CONTRACT = 'analysis-prompt-text-v4';
const ANALYSIS_PROMPT_TEXT_V5_CONTRACT = 'analysis-prompt-text-v5';

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
    imageSupplement: 'prompts/image-supplement.md',
    // 发布后视觉阶段的两份提示词。它们不进 deep-analyzer 的阶段检查点，身份只
    // 落在视觉 manifest 的 promptSha256 和 taskToken 上，但同样按「记录声明版本」
    // 选路径，所以登记方式与上面一致。
    visualSummary: 'prompts/visual-summary.md',
    digestCover: 'prompts/digest-cover.md'
});

// 这里登记已发布的 v2 阶段路径；当前版本在下方 PROMPT_FILE_VERSIONS 登记。
// v1 路径固定由 FROZEN_V1_PROMPT_FILES 给出。
const FROZEN_V2_PROMPT_FILES = Object.freeze({
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
    }),
    visualSummary: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/visual-summary-v2.md'
    }),
    digestCover: Object.freeze({
        contract: ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        path: 'prompts/digest-cover-v2.md'
    })
});

// 已发布的 v3 文件保留原路径，旧记录仍按它们核验。
const FROZEN_V3_PROMPT_FILES = Object.freeze({
    primaryAnalysis: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/deep-analysis-v3.md' }),
    apiReaderArticle: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/api-reader-article-v3.md' }),
    apiReaderRepair: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/api-reader-repair-v3.md' }),
    openSourceScan: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/opensource-scan-v3.md' }),
    revision: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/gap-fill-v3.md' }),
    scoringAudit: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/scoring-audit-v3.md' }),
    imageSupplement: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V3_CONTRACT, path: 'prompts/image-supplement-v3.md' }),
});

// 已发布的 v4 文件永久保留，旧记录按原路径读取。
const FROZEN_V4_PROMPT_FILES = Object.freeze({
    primaryAnalysis: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V4_CONTRACT, path: 'prompts/deep-analysis-v4.md' }),
    scoringAudit: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V4_CONTRACT, path: 'prompts/scoring-audit-v4.md' }),
});

// 评分升级到 v5 前，Manual 配置实际使用的完整阶段组合。仅用于核验旧配置。
const FROZEN_V4_MIXED_PROMPT_FILES = Object.freeze({
    ...FROZEN_V2_PROMPT_FILES,
    ...FROZEN_V3_PROMPT_FILES,
    ...FROZEN_V4_PROMPT_FILES,
});

// 只有评分使用 v5；主分析保持 v4，其他阶段保持已登记的 v3 或 v2。
const PROMPT_FILE_VERSIONS = Object.freeze({
    ...FROZEN_V4_MIXED_PROMPT_FILES,
    scoringAudit: Object.freeze({ contract: ANALYSIS_PROMPT_TEXT_V5_CONTRACT, path: 'prompts/scoring-audit-v5.md' }),
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
    const archivedV2 = FROZEN_V2_PROMPT_FILES[stage];
    if (declared === ANALYSIS_PROMPT_TEXT_V2_CONTRACT && archivedV2) return archivedV2.path;
    const archivedV3 = FROZEN_V3_PROMPT_FILES[stage];
    if (declared === ANALYSIS_PROMPT_TEXT_V3_CONTRACT && archivedV3?.contract === declared) return archivedV3.path;
    const archivedV4 = FROZEN_V4_PROMPT_FILES[stage];
    if (declared === ANALYSIS_PROMPT_TEXT_V4_CONTRACT && archivedV4?.contract === declared) return archivedV4.path;
    const entry = PROMPT_FILE_VERSIONS[stage];
    if (entry && declared === entry.contract) return entry.path;
    const known = [ANALYSIS_PROMPT_TEXT_V1_CONTRACT];
    if (archivedV2) known.push(ANALYSIS_PROMPT_TEXT_V2_CONTRACT);
    if (archivedV3?.contract === ANALYSIS_PROMPT_TEXT_V3_CONTRACT) known.push(ANALYSIS_PROMPT_TEXT_V3_CONTRACT);
    if (archivedV4?.contract === ANALYSIS_PROMPT_TEXT_V4_CONTRACT) known.push(ANALYSIS_PROMPT_TEXT_V4_CONTRACT);
    if (entry && !known.includes(entry.contract)) known.push(entry.contract);
    throw new Error(`阶段 ${stage} 的提示词版本 ${declared} 没有登记；只认识 ${known.join(' 和 ')}。`);
}

// 新请求用当前版本的提示词正文；旧记录的指纹核验仍由 promptFilePathForContract
// 选择其声明版本的冻结路径，不按新版本文件重算。
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
    ANALYSIS_PROMPT_TEXT_V3_CONTRACT,
    ANALYSIS_PROMPT_TEXT_V4_CONTRACT,
    ANALYSIS_PROMPT_TEXT_V5_CONTRACT,
    FROZEN_V1_PROMPT_FILES,
    FROZEN_V2_PROMPT_FILES,
    FROZEN_V3_PROMPT_FILES,
    FROZEN_V4_PROMPT_FILES,
    FROZEN_V4_MIXED_PROMPT_FILES,
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

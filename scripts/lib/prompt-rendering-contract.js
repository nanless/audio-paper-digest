'use strict';

const PROMPT_RENDERING_CONTRACT = 'prompt-single-pass-v1';
// 只识别当前调用真正使用的模板键，不把普通 TeX 花括号视作旧渲染风险。
const PROMPT_INPUT_KEYS = Object.freeze([
    'title', 'abstract', 'categories', 'hasFullText', 'authors', 'arxivId', 'textForAnalysis',
    'tagPromptText', 'imageList', 'anchorCatalog', 'primaryAnalysis', 'existingAnalysis',
    'sourceEvidence', 'validationFeedback', 'previousDraft', 'mechanicalContract', 'repairTargets',
    'missingSections', 'summaryIssue', 'existingSummary', 'methodSection', 'resultsSection'
]);
const reservedPlaceholder = new RegExp(`\\{(?:${PROMPT_INPUT_KEYS.join('|')})\\}`);

function containsPromptInputPlaceholder(value) {
    if (typeof value === 'string') return reservedPlaceholder.test(value);
    if (Array.isArray(value)) return value.some(containsPromptInputPlaceholder);
    return Boolean(value && typeof value === 'object'
        && Object.values(value).some(containsPromptInputPlaceholder));
}

function sequentialSubstitutionChangesInput(vars) {
    const entries = Object.entries(vars);
    return entries.some(([, value], index) => entries.slice(index + 1)
        .some(([key]) => String(value).includes(`{${key}}`)));
}

function promptRenderingFingerprintFields(...inputs) {
    return containsPromptInputPlaceholder(inputs)
        ? { promptRenderingContract: PROMPT_RENDERING_CONTRACT } : {};
}

function legacyPromptRenderingNeedsReplay(paper, sourceDetails = '') {
    if (paper?.analysisManifest?.sourceAcquisition?.promptRenderingContract === PROMPT_RENDERING_CONTRACT) return false;
    // 旧记录没有每次请求的完整渲染输入，不能猜它是否碰巧逃过了二次替换。
    // 只对含已知模板字面量的论文保守重跑；普通旧记录保持原来的复用资格。
    return containsPromptInputPlaceholder([
        paper?.title, paper?.authors, paper?.categories, paper?.abstract, paper?.summary,
        paper?.analysis, paper?.analysisCheckpoint, paper?.analysisStageCheckpoints,
        paper?.apiReaderArticle, paper?.apiReaderPlan, sourceDetails
    ]);
}

module.exports = { PROMPT_RENDERING_CONTRACT, PROMPT_INPUT_KEYS, containsPromptInputPlaceholder,
    sequentialSubstitutionChangesInput, promptRenderingFingerprintFields, legacyPromptRenderingNeedsReplay };

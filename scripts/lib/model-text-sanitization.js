'use strict';

const MODEL_TEXT_SANITIZATION_CONTRACT = 'model-text-unicode-scalars-v1';

function containsSupplementaryCharacter(value) {
    if (typeof value === 'string') return /[\u{10000}-\u{10ffff}]/u.test(value);
    if (Array.isArray(value)) return value.some(containsSupplementaryCharacter);
    return Boolean(value && typeof value === 'object'
        && Object.values(value).some(containsSupplementaryCharacter));
}

function modelTextFingerprintFields(...inputs) {
    return containsSupplementaryCharacter(inputs)
        ? { modelTextSanitizationContract: MODEL_TEXT_SANITIZATION_CONTRACT } : {};
}

function legacyModelTextNeedsReplay(paper, sourceDetails) {
    if (paper?.analysisManifest?.sourceAcquisition?.modelTextSanitizationContract
        === MODEL_TEXT_SANITIZATION_CONTRACT) return false;
    return containsSupplementaryCharacter([
        paper?.title, paper?.authors, paper?.categories, paper?.abstract, paper?.summary,
        paper?.analysis, paper?.analysisCheckpoint, paper?.analysisStageCheckpoints,
        paper?.apiReaderArticle, paper?.apiReaderPlan, sourceDetails
    ]);
}

function currentModelInputSource(paper) {
    const fresh = require('./fresh-analysis-context.js');
    const active = fresh.getFreshAnalysisContext();
    if (active) return fresh.readFreshSource(active.runDir, paper, active);
    const conference = require('./conference-analysis-context.js');
    if (conference.getConferenceAnalysisContext()) return conference.getConferenceAnalysisSource(paper);
    const direct = require('./direct-rewrite-analysis-context.js');
    if (direct.getDirectRewriteAnalysisContext()) return direct.getDirectRewriteSource(paper);
    return null;
}

// 这是生产复用资格，不改变旧记录的结构完整性或只读历史状态。
// 旧记录缺少清洗版本时，必须取得已核验来源，不能从元数据里没见到特殊字符推定安全。
function canReuseModelTextInputs(paper, sourceDetails = null) {
    if (paper?.analysisManifest?.sourceAcquisition?.modelTextSanitizationContract
        === MODEL_TEXT_SANITIZATION_CONTRACT) return true;
    const details = sourceDetails || currentModelInputSource(paper);
    return Boolean(details && typeof details.text === 'string'
        && !legacyModelTextNeedsReplay(paper, details));
}

module.exports = { MODEL_TEXT_SANITIZATION_CONTRACT, containsSupplementaryCharacter,
    modelTextFingerprintFields, legacyModelTextNeedsReplay, canReuseModelTextInputs };

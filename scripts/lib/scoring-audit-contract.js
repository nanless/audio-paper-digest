'use strict';

const crypto = require('crypto');
const {
    parseAnalysis,
    normalizeDocumentType,
    normalizeScoreToOneDecimal,
    isOpenSourceScoreAnchor,
    OPEN_SOURCE_SCORE_ANCHORS
} = require('../utils.js');
const scoringFormat = require('./scoring-record-format');
const readerIdentityFormat = require('./reader-identity-format');
const {
    stableFingerprint,
    findSectionBounds,
    mergeSectionByTitle,
    setMachineSummaryField,
    validRepositoryDocumentationEvidence
} = require('./public-resource-probe.js');

const SCORING_DIMENSIONS = Object.freeze([
    { key: 'innovation', machineKey: 'innovation', label: '创新性', max: 2 },
    { key: 'technicalRigor', machineKey: 'technical_rigor', label: '技术严谨性', max: 1.5 },
    { key: 'experimentalSufficiency', machineKey: 'experimental_sufficiency', label: '实验充分性', max: 1.5 },
    { key: 'clarity', machineKey: 'clarity', label: '清晰度', max: 1 },
    { key: 'impact', machineKey: 'impact', label: '影响力', max: 1.5 },
    { key: 'openSource', machineKey: 'open_source', label: '开源', max: 1.5 },
    { key: 'reproducibility', machineKey: 'reproducibility', label: '可复现性', max: 0.5 },
    { key: 'engineering', machineKey: 'engineering_score', label: '工程/实践价值', max: 1.5 }
]);

const TYPE_AWARE_EVIDENCE_GUIDES = Object.freeze({
    '方法研究': '代表性基线、消融、跨数据集泛化、统计检验、误差分析，以及组件级声明对应的因果证据。',
    '系统技术报告': '端到端质量、延迟、吞吐、成本、规模、压力测试、公平竞品对比、失败案例与部署约束。',
    '模型报告': '端到端能力、训练与推理规模、质量/延迟/成本权衡、公平竞品对比、安全或失败案例。',
    '数据集与基准': '覆盖范围、标注质量、泄漏控制、协议设计、代表性基线与数据治理证据。',
    '综述': '检索方法、覆盖范围、分类体系、比较框架、综合洞察与遗漏分析。',
    '理论研究': '证明、假设、边界条件、反例，以及理论声明与实验验证之间的对应关系。',
    '应用研究': '真实场景、外部验证、用户研究、部署约束、失败案例与实际效益。'
});

function getTypeAwareEvidenceGuide(documentType) {
    return TYPE_AWARE_EVIDENCE_GUIDES[documentType]
        || '先依据主要贡献形态确定文档类型，再使用对应证据标准；不得机械套用方法论文的消融要求。';
}

const AUDIT_TOP_LEVEL_KEYS = Object.freeze(['documentType', 'confidence', 'dimensions']);
const AUDIT_TOP_LEVEL_KEYS_V2 = Object.freeze([
    'documentType', 'confidence', 'evidenceProfile', 'dimensions'
]);
const AUDIT_ITEM_KEYS = Object.freeze(['score', 'reason']);
const SCORING_EVIDENCE_PROFILE_KEYS = Object.freeze([
    'multiComponentClaimed', 'ablationStatus', 'targetEvaluation',
    'sampleScaleReported', 'deploymentMeasured', 'publicGeneralizationEvaluated',
    'engineeringEvidence', 'evidenceBoundary', 'evidenceIds'
]);

const OPEN_SOURCE_DEFICIT = /(?:不开源|闭源|未开源|没有开源|代码未提供|权重未提供|数据集未提供|缺少(?:代码|权重|数据集|核心(?:产物|材料))|(?:代码|权重|数据集|核心(?:产物|材料))(?:未|没有|尚未)公开)/;
const VERIFIED_RESOURCE_DENIAL = /(?:(?:未|没有|尚未)(?:发布|公开|提供)[^.。；;]{0,16}(?:代码|模型权重|数据集)|(?:代码|模型权重|数据集)[^.。；;]{0,16}(?:未|没有|尚未)(?:发布|公开|提供))/;
const REPRODUCIBILITY_DEFICIT = /(?:无法复现|不可复现|缺少|未提供|未披露|没有|不足|不完整|不清楚)[^.。；;]{0,18}(?:超参数|训练配置|硬件配置|复现步骤|实现细节)|(?:超参数|训练配置|硬件配置|复现步骤|实现细节)[^.。；;]{0,18}(?:缺失|不足|不完整|未提供|未披露|不清楚)/;

const FORBIDDEN_SCORING_REASON_PATTERNS = Object.freeze({
    innovation: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    technicalRigor: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    experimentalSufficiency: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    clarity: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    impact: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT],
    openSource: [REPRODUCIBILITY_DEFICIT],
    reproducibility: [OPEN_SOURCE_DEFICIT],
    engineering: [OPEN_SOURCE_DEFICIT, REPRODUCIBILITY_DEFICIT]
});

const EXPLICIT_NON_DEDUCTION = /(?:不应|不会|不该|不能|未被用来|并未用来)(?:据此)?(?:影响|降低|扣分|失分)|(?:不影响|不损害|无损于)|(?:不能|不应|不可)作为[^。；;]{0,20}扣分/;

function extractJsonObjectText(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1).trim();
    }
    return text;
}

function findForbiddenDeductionClauses(reason, patterns) {
    return String(reason || '').split(/[。！？；;\n]/).map(clause => clause.trim()).filter(clause => {
        if (!clause) return false;
        if (EXPLICIT_NON_DEDUCTION.test(clause)) return false;
        return patterns.some(pattern => {
            pattern.lastIndex = 0;
            const checked = pattern === OPEN_SOURCE_DEFICIT
                ? clause.replace(/((?:领先|优于|超过|对比|比较|相比)(?:当前|现有|主流|其他|部分|已有|最强|多种|多个|所有|的|了|于){0,3})闭源((?:(?:与|和|及)开源)?(?:基线|竞品))/gu,
                    '$1对照$2')
                    .replace(/([，,]与依赖\s*[A-Z][A-Za-z0-9 .+-]{0,79}等)闭源(教师的做法形成差异化组合)(?=[，,]|$)/gu,
                        '$1对照$2')
                : clause;
            return pattern.test(checked);
        });
    });
}

function reasonUsesForbiddenDeduction(reason, patterns) {
    return findForbiddenDeductionClauses(reason, patterns).length > 0;
}

function prepareScoringAuditAnalysis(analysis) {
    if (!findSectionBounds(analysis, '评分理由')) return analysis;
    return mergeSectionByTitle(
        analysis,
        '评分理由',
        '旧评分理由已由代码移除，禁止复用。请仅依据确定性评分证据账本重新建立八维理由。'
    );
}

function assertExactObjectKeys(value, expectedKeys, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${context} 必须是对象`);
    }
    const actual = Object.keys(value);
    const missing = expectedKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    const extra = actual.filter(key => !expectedKeys.includes(key));
    if (missing.length > 0) throw new Error(`${context} 缺少字段: ${missing.join(', ')}`);
    if (extra.length > 0) throw new Error(`${context} 包含额外字段: ${extra.join(', ')}`);
}

function recalculateScoringAudit(audit) {
    const subtotal = SCORING_DIMENSIONS.reduce(
        (sum, spec) => sum + normalizeScoreToOneDecimal(audit.dimensions[spec.key].score),
        0
    );
    const total = normalizeScoreToOneDecimal(Math.min(10, subtotal));
    const rankBucket = total >= 9 ? '前10%' : total >= 7.5 ? '前25%' : total >= 5.5 ? '前50%' : '后50%';
    return { ...audit, total, rankBucket };
}

function parseScoringAuditResult(raw, allowedEvidenceIds = null) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObjectText(raw));
    } catch (error) {
        throw new Error(`评分审计 JSON 无法解析: ${error.message}`);
    }

    const hasEvidenceProfile = Object.prototype.hasOwnProperty.call(parsed, 'evidenceProfile');
    assertExactObjectKeys(
        parsed,
        hasEvidenceProfile ? AUDIT_TOP_LEVEL_KEYS_V2 : AUDIT_TOP_LEVEL_KEYS,
        '评分审计顶层'
    );
    if (typeof parsed.documentType !== 'string' || !parsed.documentType.trim()) {
        throw new Error('评分审计 documentType 必须是非空字符串');
    }
    const documentType = normalizeDocumentType(parsed.documentType);
    if (!documentType) throw new Error('评分审计缺少有效 documentType');

    if (typeof parsed.confidence !== 'string' || !parsed.confidence.trim()) {
        throw new Error('评分审计 confidence 必须是非空字符串');
    }
    const confidence = parsed.confidence.trim();
    if (!['高', '中', '低'].includes(confidence)) throw new Error('评分审计 confidence 非法');
    let evidenceProfile = null;
    if (hasEvidenceProfile) {
        evidenceProfile = parsed.evidenceProfile;
        const evidenceHeader = scoringFormat.evidenceProfileHeader(evidenceProfile);
        if (!evidenceHeader) throw new Error('评分证据说明的格式或结构指纹无效');
        assertExactObjectKeys(
            evidenceProfile, [...Object.keys(evidenceHeader), ...SCORING_EVIDENCE_PROFILE_KEYS], '评分证据说明'
        );
        for (const key of [
            'multiComponentClaimed', 'sampleScaleReported', 'deploymentMeasured',
            'publicGeneralizationEvaluated'
        ]) {
            if (typeof evidenceProfile[key] !== 'boolean') {
                throw new Error(`评分证据画像 ${key} 必须是布尔值`);
            }
        }
        if (evidenceProfile.ablationStatus === 'missing') {
            evidenceProfile.ablationStatus = 'none';
        }
        if (!evidenceProfile.multiComponentClaimed
            && evidenceProfile.ablationStatus !== 'not_applicable') {
            evidenceProfile.ablationStatus = 'not_applicable';
        }
        if (!['direct', 'partial', 'none', 'not_applicable'].includes(evidenceProfile.ablationStatus)) {
            throw new Error(
                `评分证据画像 ablationStatus 非法: ${JSON.stringify(evidenceProfile.ablationStatus)}`
            );
        }
        if (!['public', 'internal', 'mixed', 'not_applicable'].includes(evidenceProfile.targetEvaluation)) {
            throw new Error('评分证据画像 targetEvaluation 非法');
        }
        if (!['measured_deployment', 'reusable_pipeline', 'public_artifact_or_benchmark', 'claim_only', 'not_applicable']
            .includes(evidenceProfile.engineeringEvidence)) {
            throw new Error('评分证据画像 engineeringEvidence 非法');
        }
        if (evidenceProfile.deploymentMeasured
            !== (evidenceProfile.engineeringEvidence === 'measured_deployment')) {
            throw new Error('评分证据画像 deploymentMeasured 与 engineeringEvidence 不一致');
        }
        if (evidenceProfile.multiComponentClaimed
            && evidenceProfile.ablationStatus === 'not_applicable') {
            throw new Error('存在多组件因果主张时 ablationStatus 不得为 not_applicable');
        }
        if (!evidenceProfile.multiComponentClaimed
            && evidenceProfile.ablationStatus !== 'not_applicable') {
            throw new Error('不存在多组件因果主张时 ablationStatus 必须为 not_applicable');
        }
        if (evidenceProfile.targetEvaluation === 'not_applicable'
            && !['理论研究', '综述'].includes(documentType)) {
            throw new Error('经验型文档的 targetEvaluation 不得为 not_applicable');
        }
        if (typeof evidenceProfile.evidenceBoundary !== 'string'
            || evidenceProfile.evidenceBoundary.trim().length < 20) {
            throw new Error('评分证据画像 evidenceBoundary 至少 20 个字符');
        }
        if (!Array.isArray(evidenceProfile.evidenceIds)
            || evidenceProfile.evidenceIds.length < 1
            || evidenceProfile.evidenceIds.length > 12
            || new Set(evidenceProfile.evidenceIds).size !== evidenceProfile.evidenceIds.length) {
            throw new Error('评分证据画像 evidenceIds 必须是 1-12 个不重复 ID');
        }
        if (allowedEvidenceIds instanceof Set) {
            const unknown = evidenceProfile.evidenceIds.filter(id => !allowedEvidenceIds.has(id));
            if (unknown.length > 0) {
                throw new Error(`评分证据画像引用了账本外 ID: ${unknown.join(', ')}`);
            }
        }
        const boundaryIds = [...evidenceProfile.evidenceBoundary
            .matchAll(/\[([A-Z][A-Z0-9_/-]*)\]/g)].map(match => match[1]);
        if (boundaryIds.length === 0
            || !boundaryIds.some(id => evidenceProfile.evidenceIds.includes(id))) {
            throw new Error('评分证据画像 evidenceBoundary 必须引用 evidenceIds 中的账本 ID');
        }
    }
    assertExactObjectKeys(parsed.dimensions, SCORING_DIMENSIONS.map(spec => spec.key), '评分审计 dimensions');

    const dimensions = {};
    for (const spec of SCORING_DIMENSIONS) {
        const item = parsed.dimensions[spec.key];
        assertExactObjectKeys(item, AUDIT_ITEM_KEYS, `评分审计维度 ${spec.key}`);
        if (typeof item.score !== 'number' || !Number.isFinite(item.score)) {
            throw new Error(`评分审计维度 ${spec.key} score 必须是有限数字`);
        }
        if (!Number.isInteger(item.score * 10)) {
            throw new Error(`评分审计维度 ${spec.key} score 最多一位小数`);
        }
        const score = normalizeScoreToOneDecimal(item.score);
        if (score < 0 || score > spec.max) {
            throw new Error(`评分审计维度 ${spec.key} 分数越界`);
        }
        if (spec.key === 'openSource' && !isOpenSourceScoreAnchor(score)) {
            throw new Error(`评分审计维度 openSource 必须使用固定锚点 ${OPEN_SOURCE_SCORE_ANCHORS.join('/')}`);
        }
        if (typeof item.reason !== 'string' || !item.reason.trim()) {
            throw new Error(`评分审计维度 ${spec.key} reason 必须是非空字符串`);
        }
        const reason = item.reason.trim();
        if (reason.length < 20) throw new Error(`评分审计维度 ${spec.key} 理由过短`);
        if (allowedEvidenceIds instanceof Set) {
            const citedIds = [...reason.matchAll(/\[([A-Z][A-Z0-9_/-]*)\]/g)].map(match => match[1]);
            if (citedIds.length === 0) {
                throw new Error(`评分审计维度 ${spec.key} 理由缺少证据账本 ID`);
            }
            const unknownIds = citedIds.filter(id => !allowedEvidenceIds.has(id));
            if (unknownIds.length > 0) {
                throw new Error(`评分审计维度 ${spec.key} 引用了账本外 ID: ${[...new Set(unknownIds)].join(', ')}`);
            }
        }
        const forbiddenPatterns = FORBIDDEN_SCORING_REASON_PATTERNS[spec.key] || [];
        const forbiddenClauses = findForbiddenDeductionClauses(reason, forbiddenPatterns);
        if (forbiddenClauses.length > 0) {
            throw new Error(
                `评分审计维度 ${spec.key} 使用了属于其他维度的扣分事实；` +
                `违规分句：${forbiddenClauses.map(clause => `「${clause}」`).join('、')}；` +
                '请删除这些分句，并只使用该维度负责的证据重写理由'
            );
        }
        dimensions[spec.key] = { score, reason };
    }

    return recalculateScoringAudit({
        documentType, confidence, dimensions,
        ...(evidenceProfile ? { evidenceProfile } : {})
    });
}

function applyScoringEvidenceCaps(audit) {
    const profile = audit?.evidenceProfile;
    if (!profile) return audit;
    const updated = structuredClone(audit);
    const capsApplied = [];
    const cap = (dimension, maximum, rule, explanation) => {
        const item = updated.dimensions[dimension];
        if (!item || item.score <= maximum) return;
        capsApplied.push({ rule, dimension, before: item.score, after: maximum });
        item.score = maximum;
        item.reason = `${item.reason} ${explanation}，本项最高计 ${maximum.toFixed(1)} 分。`;
    };
    if (profile.multiComponentClaimed && profile.ablationStatus === 'none') {
        cap('experimentalSufficiency', 1.2, 'multi_component_without_direct_ablation', '多组件的因果贡献缺少直接消融支持');
    }
    if (profile.multiComponentClaimed && profile.ablationStatus === 'partial') {
        cap('experimentalSufficiency', 1.3, 'multi_component_with_partial_ablation', '多组件的因果贡献只有部分消融支持');
    }
    if (profile.targetEvaluation === 'internal' && !profile.sampleScaleReported) {
        cap('experimentalSufficiency', 1.2, 'internal_evaluation_without_sample_scale', '内部评测未报告样本规模');
    }
    if (profile.engineeringEvidence === 'claim_only') {
        cap('engineering', 1.0, 'engineering_claim_without_measured_or_reusable_evidence', '当前证据仅以叙述或间接指标支持工程价值，未包含部署测量或可复用的工程成果');
    }
    const recalculated = recalculateScoringAudit(updated);
    if (recalculated.confidence !== '高' && recalculated.total > 9.0) {
        throw new Error('评分置信度不是“高”时总分不得超过 9.0');
    }
    if (profile.multiComponentClaimed && profile.ablationStatus === 'none'
        && profile.targetEvaluation === 'internal' && recalculated.total > 8.5) {
        throw new Error('多组件主张缺少直接消融且主要依赖内部评测时，总分不得超过 8.5');
    }
    return { ...recalculated, capsApplied };
}

function applyScoringAuditResult(analysis, audit) {
    let updated = mergeSectionByTitle(analysis, '评分', `${Number(audit.total).toFixed(1)}/10`);
    updated = setMachineSummaryField(updated, 'document_type', audit.documentType);
    updated = setMachineSummaryField(updated, 'rank_bucket', audit.rankBucket);
    updated = setMachineSummaryField(updated, 'confidence', audit.confidence);
    for (const spec of SCORING_DIMENSIONS) {
        updated = setMachineSummaryField(updated, spec.machineKey, audit.dimensions[spec.key].score.toFixed(1));
    }

    const scoringReason = SCORING_DIMENSIONS.map(spec => {
        const item = audit.dimensions[spec.key];
        return `*   ${spec.label} (${item.score.toFixed(1)}/${spec.max})：${item.reason}`;
    }).join('\n\n');
    return mergeSectionByTitle(updated, '评分理由', scoringReason);
}

function sourceReleasePromise(sourceEvidence, identity) {
    const source = String(sourceEvidence || '');
    if (!source || !identity || crypto.createHash('sha256').update(source).digest('hex')
        !== identity.sourceTextSha256) return null;
    const pattern = /\b(?:We will (?:instead )?(?:release|provide)|The accompanying repository will (?:release|provide))\b[^.!?。]{1,600}[.!?。]?/gi;
    for (const match of source.matchAll(pattern)) {
        const sentence = match[0];
        const before = source.slice(0, match.index);
        const sentencePrefix = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'),
            before.lastIndexOf('?'), before.lastIndexOf('。'), before.lastIndexOf('\n')) + 1);
        if (sentencePrefix.trim()) continue;
        const linesBefore = before.split('\n');
        const paragraphPrefix = linesBefore.at(-1);
        const previousLine = linesBefore.slice(0, -1).reverse().find(line => line.trim()) || '';
        const context = paragraphPrefix + '\n' + previousLine;
        const paragraphBoundary = /\n\s*\n/g;
        let paragraphStart = 0;
        let previousParagraphStart = 0;
        for (const boundary of before.matchAll(paragraphBoundary)) {
            previousParagraphStart = paragraphStart;
            paragraphStart = boundary.index + boundary[0].length;
        }
        const paragraphContext = before.slice(previousParagraphStart);
        if (/\bwrote\b|\bquot(?:e|ed|es|ing|ation)\b|following statement|(?:authors?|they)\s+(?:state|claim|write|say)|\b(?:authors?|articles?|papers?|they)\b[^\n.!?]{0,60}\bsaid\b|(?:^|\n)[A-Z][a-zA-Z-]+\s+said\b/i.test(paragraphContext)) continue;

        if (/related work|quot(?:e|ed|es|ing|ation)|following statement|third[- ]party|unrelated|(?:authors?|they)\s+(?:state|claim|write|wrote|say|said)|(?:previous|prior|another|other|cited)\s+(?:work|studies|papers?|articles?|authors?)|\b(?:wrote|said)\b|et al\.[^\n]*(?:state|claim|write|wrote|say|said)|["“”'‘’`]/i.test(context)) continue;
        if (!paragraphPrefix.trim() && /:\s*$/.test(previousLine)) continue;
        let fence = null;
        for (const line of linesBefore) {
            const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
            if (!marker) continue;
            if (!fence) fence = marker[0];
            else if (marker[0] === fence) fence = null;
        }
        if (fence || /^\s*>/.test(paragraphPrefix)) continue;
        if (/\b(?:not|never|no|third[- ]party|unrelated|external|borrowed)\b|developed by|other authors|["“”'‘’`]/i.test(sentence)) continue;
        const accompanyingRepository = /^The accompanying repository will/i.test(sentence);
        const ownsCoreMaterial = /\bour\b[^.!?。]{0,80}\b(?:code|models?|weights|datasets?)\b|\bresulting\s+(?:ASR\s+)?(?:models?|weights)\b/i.test(sentence);
        if ((!accompanyingRepository && !ownsCoreMaterial)
            || !/\b(?:code|models?|weights|datasets?)\b/i.test(sentence)) continue;
        return {
            conditional: /\bsubject to\b|\bconsent\b|\binstitutional requirements\b/i.test(sentence),
            consentOrInstitution: /\bconsent\b|\binstitutional requirements\b/i.test(sentence)
        };
    }
    return null;
}

function hasAffirmativeReleasePromise(sourceText) {
    const segments = String(sourceText || '').split(/[\n。；;]/).map(part => part.trim()).filter(Boolean);
    return segments.some(segment => {
        const positive = /承诺(?:未来|后续)?(?:将|会)?(?:公开|开放|开源)|计划(?:未来|后续)?(?:公开|开放|开源)|将(?:会)?(?:公开|开放|开源)|will\s+(?:be\s+)?(?:released|open[- ]sourced)|plan(?:s|ned)?\s+to\s+(?:release|open[- ]source)/i.test(segment);
        if (!positive) return false;
        return !/(?:未(?!来)|没有|无|尚未|并未|不)(?:明确)?(?:承诺|计划|表示|说明|提及)?[^\n。；;]{0,12}(?:公开|开放|开源)|(?:no|not|never|without)\b[^.]{0,20}\b(?:plan|promise|release|open[- ]source)/i.test(segment);
    });
}

function hasAffirmativeDemoEvidence(sourceText) {
    const segments = String(sourceText || '').split(/[\n。；;]/).map(part => part.trim()).filter(Boolean);
    return segments.some(segment => {
        if (!/(?:\bdemo\b|demo_available|在线演示|线上演示|体验页面|演示页面)/i.test(segment)) return false;
        if (/(?:未|没有|无|尚未|并未|不)(?:提供|公开|开放|包含|提及|可用|可访问)?[^\n。；;]{0,12}(?:\bdemo\b|在线演示|线上演示|体验页面|演示页面)|(?:\bdemo\b|在线演示|线上演示|体验页面|演示页面)\s*[：:]?\s*(?:否|无|未|没有|不可用|未提及|none|false|no\b|not\s+available|unavailable)|(?:no|not|without)\b[^.]{0,12}\bdemo\b|\bdemo\b[^.]{0,12}\bnot\s+available/i.test(segment)) {
            return false;
        }
        const hasUrl = /https?:\/\/[^\s<>()\[\]{}"']+/i.test(segment);
        const affirmativeStructuredValue = /(?:\bdemo\b|在线演示|线上演示|体验页面|演示页面)\s*(?:可用|可访问|已提供|已上线|available)|(?:\bdemo\b|demo_available|在线演示|线上演示|体验页面|演示页面)\s*[：:=]\s*(?:是|有|true|yes|available|可用|可访问|已提供|已上线)/i.test(segment);
        return hasUrl || affirmativeStructuredValue;
    });
}

function validateScoringAuditAgainstAnalysis(analysis, audit, verifiedResourceIdentity = null, sourceEvidence = '') {
    const current = parseAnalysis(analysis) || {};
    if (audit.documentType === '理论研究') return applyScoringEvidenceCaps(audit);
    let verifiedAvailableTypes = null;
    if (verifiedResourceIdentity !== null && verifiedResourceIdentity !== undefined) {
        const { identitySha256, ...identityBody } = verifiedResourceIdentity || {};
        if (!readerIdentityFormat.hasIdentity(verifiedResourceIdentity, 'resources')
            || identitySha256 !== stableFingerprint(identityBody)
            || !Array.isArray(verifiedResourceIdentity?.resources)) {
            throw new Error('核对评分中的开源状态时，资源身份记录必须包含正确的协议、对应内容的哈希和资源列表。');
        }
        verifiedAvailableTypes = new Set(verifiedResourceIdentity.resources
            .filter(item => item?.availability === 'available')
            .map(item => item.type));
    }
    const hasReleasedArtifact = verifiedAvailableTypes
        ? ['code', 'model', 'dataset'].some(type => verifiedAvailableTypes.has(type))
        : [current.hasCode, current.hasModel, current.hasDataset]
            .some(value => value === '是' || value === 'yes');
    if (!hasReleasedArtifact) {
        const sourceText = String(current.opensource || '');
        const sourcePromise = sourceReleasePromise(sourceEvidence, verifiedResourceIdentity);
        const promisesRelease = sourceEvidence && verifiedResourceIdentity
            ? Boolean(sourcePromise) : hasAffirmativeReleasePromise(sourceText);
        const hasDemo = hasAffirmativeDemoEvidence(sourceText);
        const normalizedScore = promisesRelease ? 0.5 : hasDemo ? 0.2 : 0;
        const normalizedReason = promisesRelease
            ? sourcePromise?.conditional
                ? sourcePromise.consentOrInstitution
                    ? '[A_OPEN] 作者说明未来发布核心材料须满足同意或机构要求；这是有条件的发布计划，当前尚未核实材料可用，不据此推断许可证。'
                    : '[A_OPEN] 作者说明未来发布核心材料须满足原文所列条件；这是有条件的发布计划，当前尚未核实材料可用，不据此推断许可证。'
                : '[A_OPEN] 论文明确说明未来发布核心材料，当前尚未核实代码、模型权重或数据资源可用。'
            : hasDemo
                ? '[A_OPEN] 本项按演示证据计分，当前尚未核实核心代码、模型权重或数据资源可用，不据此否认原文中的其他资源声明。'
                : '[A_OPEN] 当前尚无已核实可用的代码、模型权重或数据资源；本项仅按当前核验状态计分，不据此否认论文中的资源声明或后续发布计划。';
        if (audit.dimensions.openSource.score !== normalizedScore) {
            console.log(`    [deep] ℹ️  开源分按资源状态归一化: ${audit.dimensions.openSource.score} → ${normalizedScore}`);
        }
        const normalizedAudit = {
            ...audit,
            dimensions: {
                ...audit.dimensions,
                openSource: { score: normalizedScore, reason: normalizedReason }
            }
        };
        return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
    }
    if (verifiedAvailableTypes && hasReleasedArtifact) {
        const openSource = audit.dimensions.openSource;
        const hasCompleteCoreRelease = verifiedAvailableTypes.has('code')
            && verifiedAvailableTypes.has('model');
        const hasCompleteDocumentation = verifiedResourceIdentity.resources.some(resource => (
            resource?.type === 'code'
            && resource?.availability === 'available'
            && resource?.documentationEvidence?.completeness === 'complete'
            && validRepositoryDocumentationEvidence(
                resource.documentationEvidence, resource.originalUrl
            )
        ));
        if (hasCompleteCoreRelease && hasCompleteDocumentation
            && openSource.score !== 1.5) {
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: 1.5,
                        reason: '[A_OPEN] 已验证代码仓库与模型权重当前可用，且官方仓库 README 完整覆盖安装、推理与微调文档，符合核心材料和文档完整开放的 1.5 分标准。'
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        if (openSource.score < 1.0
            || OPEN_SOURCE_DEFICIT.test(String(openSource.reason || ''))
            || VERIFIED_RESOURCE_DENIAL.test(String(openSource.reason || ''))) {
            const labels = { code: '代码', model: '模型权重', dataset: '数据集' };
            const available = ['code', 'model', 'dataset']
                .filter(type => verifiedAvailableTypes.has(type))
                .map(type => labels[type])
                .join('、');
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: Math.max(1.0, openSource.score),
                        reason: `[A_OPEN] 已由论文来源中的精确链接及 HTTPS 可达性验证确认${available}可用；其余核心材料与文档完整度仅按现有证据评价。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
    }
    return applyScoringEvidenceCaps(audit);
}

function revalidateScoringAudit(audit, allowedEvidenceIds) {
    return parseScoringAuditResult(JSON.stringify({
        documentType: audit.documentType,
        confidence: audit.confidence,
        ...(audit.evidenceProfile ? { evidenceProfile: audit.evidenceProfile } : {}),
        dimensions: audit.dimensions
    }), allowedEvidenceIds);
}

module.exports = {
    SCORING_DIMENSIONS,
    TYPE_AWARE_EVIDENCE_GUIDES,
    getTypeAwareEvidenceGuide,
    AUDIT_TOP_LEVEL_KEYS,
    AUDIT_TOP_LEVEL_KEYS_V2,
    AUDIT_ITEM_KEYS,
    SCORING_EVIDENCE_PROFILE_KEYS,
    OPEN_SOURCE_DEFICIT,
    VERIFIED_RESOURCE_DENIAL,
    REPRODUCIBILITY_DEFICIT,
    FORBIDDEN_SCORING_REASON_PATTERNS,
    EXPLICIT_NON_DEDUCTION,
    findForbiddenDeductionClauses,
    reasonUsesForbiddenDeduction,
    prepareScoringAuditAnalysis,
    assertExactObjectKeys,
    parseScoringAuditResult,
    recalculateScoringAudit,
    applyScoringEvidenceCaps,
    setMachineSummaryField,
    applyScoringAuditResult,
    validateScoringAuditAgainstAnalysis,
    revalidateScoringAudit,
    sourceReleasePromise,
    hasAffirmativeReleasePromise,
    hasAffirmativeDemoEvidence
};

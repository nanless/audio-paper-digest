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
const scoringRubricV2 = require('./scoring-rubric-v2');
const protocolCodec = require('./protocol-codec');
const {
    stableFingerprint,
    findSectionBounds,
    mergeSectionByTitle,
    setMachineSummaryField,
    validRepositoryDocumentationEvidence,
    normalizeArtifactProbeUrl
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

const SCORING_DIMENSIONS_V2 = Object.freeze(
    SCORING_DIMENSIONS.map(spec => Object.freeze({ ...spec, max: 10 }))
);

function getScoringDimensionsForRubric(rubricVersion) {
    return scoringRubricV2.isV2Rubric(rubricVersion) ? SCORING_DIMENSIONS_V2 : SCORING_DIMENSIONS;
}

function isV2EvidenceProfileHeader(header) {
    if (!header || !Object.hasOwn(header, 'schemaFingerprint')) return false;
    try {
        const schema = protocolCodec.declaredSchema(
            header.contract, 'scoring-evidence-profile', header.schemaFingerprint
        );
        return schema?.rubricScale === 'unified-ten-point';
    } catch (_) {
        return false;
    }
}

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
const AUDIT_ITEM_KEYS = Object.freeze(['reason', 'score']);
const SCORING_EVIDENCE_PROFILE_KEYS = Object.freeze([
    'multiComponentClaimed', 'ablationStatus', 'targetEvaluation',
    'sampleScaleReported', 'deploymentMeasured', 'publicGeneralizationEvaluated',
    'engineeringEvidence', 'evidenceBoundary', 'evidenceIds'
]);
const SCORING_EVIDENCE_PROFILE_KEYS_V2 = Object.freeze([
    ...SCORING_EVIDENCE_PROFILE_KEYS,
    'primaryStrengths', 'primaryDefects'
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

function findForbiddenDeductionClauses(reason, patterns, options = {}) {
    const dimensionKey = options?.dimensionKey || '';
    return String(reason || '').split(/[。！？；;\n]/).map(clause => clause.trim()).filter(clause => {
        if (!clause) return false;
        if (EXPLICIT_NON_DEDUCTION.test(clause)) return false;
        return patterns.some(pattern => {
            pattern.lastIndex = 0;
            let checked = clause;
            if (pattern === OPEN_SOURCE_DEFICIT) {
                checked = clause.replace(/((?:领先|优于|超过|对比|比较|相比)(?:当前|现有|主流|其他|部分|已有|最强|多种|多个|所有|的|了|于){0,3})闭源((?:(?:与|和|及)开源)?(?:基线|竞品))/gu,
                    '$1对照$2')
                    .replace(/([，,]与依赖\s*[A-Z][A-Za-z0-9 .+-]{0,79}等)闭源(教师的做法形成差异化组合)(?=[，,]|$)/gu,
                        '$1对照$2')
                    .replace(/(^|[，,、]|\[[A-Z][A-Z0-9_/-]*\]\s*|(?:涵盖|包含|覆盖|包括|比较|对比|针对|按|分|报告|给出|统计|测量|记录|列出))闭源((?:(?:与|和|及)开源)(?:分组|排序|系统|模型|基线|竞品|对照|方案|两类|两组|两套)|(?:API|商业|商用|专有)?(?:API|系统|模型)(?:[^，,。；;\n]{0,20})(?:与|和|及)开源)/gu,
                        '$1对照$2')
                    .replace(/((?:与|相比|对比|比较|超越|超过|逼近|接近|赶超|媲美|领先|优于|对标|匹敌)(?:当前|现有|主流|商用|商业|大型|顶级|头部|其他|部分|已有|最强|多种|多个|多项|所有|同类|工业级|外部|第三方|的|了|于|较){0,4})闭源((?:商业|商用|专有)?\s*(?:模型|系统|服务|API|方案|产品|数据集|基线|竞品))/giu,
                        '$1对照$2')
                    .replace(/(对照(?:商业|商用|专有)?\s*(?:模型|系统|服务|API|方案|产品|数据集|基线|竞品)\s*(?:、|与|和|及|以及)\s*)闭源((?:商业|商用|专有)?\s*(?:模型|系统|服务|API|方案|产品|数据集|基线|竞品))/giu,
                        '$1对照$2')
                    .replace(/((?:^|[，,、在的]|(?:公开|开源)(?:与|和|及)))闭源((?:商业|商用|专有)?\s*(?:模型|系统|服务|API|方案|产品|数据集)(?:评测|测试)?基准)/giu,
                        (full, lead, tail, offset, whole) => (/(?:本文|本论文|本研究|本工作|自身|作者|该文)(?:的)?$/u.test(whole.slice(0, offset + lead.length)) ? full : `${lead}对照${tail}`))
                    .replace(/(^|[，,、]|与|和|及|将|把|对|用|以|多个|主流|外部|第三方|既有|现有)闭源((?:商业|商用|专有)?\s*(?:模型|系统|服务|API|方案|产品|数据集)(?:[^，,。；;\n]{0,12}(?:相比|对比|比较|基准|对照|作为基准)))/giu,
                        (full, lead, tail, offset, whole) => (/(?:本文|本论文|本研究|本工作|自身|作者|该文)(?:的)?$/u.test(whole.slice(0, offset + lead.length)) ? full : `${lead}对照${tail}`));
            } else if (pattern === REPRODUCIBILITY_DEFICIT && dimensionKey === 'engineering') {
                // 工程/实践价值维度允许指出缺失“推理/实测/实时/流式/部署”硬件配置，
                // 但训练硬件配置、超参数与复现步骤仍严格归可复现性维度，不得跨维扣分。
                checked = clause.replace(
                    /(?<!(?:训练|预训练|微调)[和与及、/])((?:推理|实测|实时|流式|部署)(?:(?![.。；;，,]|训练).){0,12})硬件配置/gu,
                    '$1部署平台'
                );
            }
            return pattern.test(checked);
        });
    });
}

function reasonUsesForbiddenDeduction(reason, patterns, options = {}) {
    return findForbiddenDeductionClauses(reason, patterns, options).length > 0;
}

const BLIND_AUDIT_ALLOWED_MACHINE_KEYS = new Set([
    'document_type', 'primary_task_tag', 'primary_method_tag',
    'sota_claim', 'has_code', 'has_model', 'has_dataset'
]);

function replaceFullTopLevelSection(text, title, replacementBody) {
    const bounds = findSectionBounds(text, title);
    if (!bounds) return text;
    const before = text.slice(0, bounds.contentStart);
    const after = text.slice(bounds.end);
    const trailing = after && !after.startsWith('\n') ? '\n\n' : (after ? '\n' : '');
    return `${before}${String(replacementBody || '').trim()}${trailing}${after}`;
}

function prepareScoringAuditAnalysis(analysis, options = {}) {
    let blinded = String(analysis || '');
    if (options?.legacyReasonOnly === true) {
        if (!findSectionBounds(blinded, '评分理由')) return blinded;
        return mergeSectionByTitle(
            blinded,
            '评分理由',
            '旧评分理由已由代码移除，禁止复用。请仅依据确定性评分证据账本重新建立八维理由。'
        );
    }
    if (findSectionBounds(blinded, '评分')) {
        blinded = replaceFullTopLevelSection(
            blinded,
            '评分',
            '旧总分已由代码移除，禁止复用。请仅依据正文与确定性评分证据账本独立评定。'
        );
    }
    const machineBounds = findSectionBounds(blinded, '机器摘要');
    if (machineBounds) {
        const machineText = blinded.slice(machineBounds.contentStart, machineBounds.end);
        const keptLines = [];
        for (const rawLine of machineText.split('\n')) {
            const trimmed = rawLine.trim();
            if (!trimmed || /^#{1,6}\s/.test(trimmed)) continue;
            const cleaned = trimmed.replace(/^(?:[-*+]\s*|\d+[.)]\s*)/, '').trim();
            const match = cleaned.match(/^(?:\*\*|`|__)?([a-z_]+)(?:\*\*|`|__)?\s*[：:]\s*(.*)$/i);
            if (!match) continue;
            const key = match[1].toLowerCase();
            if (BLIND_AUDIT_ALLOWED_MACHINE_KEYS.has(key)) {
                keptLines.push(`${key}: ${match[2].trim()}`);
            }
        }
        const cleanedMachine = keptLines.join('\n').trim();
        blinded = replaceFullTopLevelSection(
            blinded,
            '机器摘要',
            cleanedMachine
                ? `${cleanedMachine}\n（旧评分、分档与置信度已由代码盲化移除，禁止继承。）`
                : '旧评分、分档与置信度已由代码盲化移除，禁止继承。'
        );
    }
    if (findSectionBounds(blinded, '论文评价')) {
        blinded = replaceFullTopLevelSection(
            blinded,
            '论文评价',
            '旧论文评价已由代码盲化移除，禁止据此锚定。请仅依据正文事实与编号证据账本独立评定。'
        );
    }
    if (findSectionBounds(blinded, '评分理由')) {
        blinded = replaceFullTopLevelSection(
            blinded,
            '评分理由',
            '旧评分理由已由代码移除，禁止复用。请仅依据确定性评分证据账本重新建立八维理由。'
        );
    }
    return blinded;
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
    const rubricVersion = scoringRubricV2.isV2Rubric(audit?.rubricVersion)
        ? scoringRubricV2.SCORING_RUBRIC_V2
        : scoringRubricV2.SCORING_RUBRIC_V1;
    if (rubricVersion === scoringRubricV2.SCORING_RUBRIC_V2) {
        const calc = scoringRubricV2.calculateV2WeightedTotal(audit.documentType, audit.dimensions);
        return {
            ...audit,
            rubricVersion,
            coreWeighted: calc.coreWeighted,
            openSourceBonus: calc.openSourceBonus,
            openSourceMaxBonus: calc.openSourceMaxBonus,
            total: calc.total,
            rankBucket: calc.rankBucket
        };
    }
    const subtotal = SCORING_DIMENSIONS.reduce(
        (sum, spec) => sum + normalizeScoreToOneDecimal(audit.dimensions[spec.key].score),
        0
    );
    const total = normalizeScoreToOneDecimal(Math.min(10, subtotal));
    const rankBucket = total >= 9 ? '前10%' : total >= 7.5 ? '前25%' : total >= 5.5 ? '前50%' : '后50%';
    return { ...audit, total, rankBucket };
}

function validateEvidenceClaimList(items, fieldName, minLen, maxLen, allowedEvidenceIds) {
    if (!Array.isArray(items) || items.length < minLen || items.length > maxLen) {
        throw new Error(`评分证据画像 ${fieldName} 必须是包含 ${minLen}-${maxLen} 条具体证据的数组`);
    }
    for (let i = 0; i < items.length; i++) {
        const text = typeof items[i] === 'string' ? items[i].trim() : '';
        if (text.length < 12) {
            throw new Error(`评分证据画像 ${fieldName}[${i}] 长度不足 12 个字符`);
        }
        if (allowedEvidenceIds instanceof Set) {
            const cited = [...text.matchAll(/\[([A-Z][A-Z0-9_/-]*)\]/g)].map(m => m[1]);
            if (cited.length === 0) {
                throw new Error(`评分证据画像 ${fieldName}[${i}] 缺少证据账本 ID`);
            }
            const unknown = cited.filter(id => !allowedEvidenceIds.has(id));
            if (unknown.length > 0) {
                throw new Error(`评分证据画像 ${fieldName}[${i}] 引用了账本外 ID: ${[...new Set(unknown)].join(', ')}`);
            }
        }
    }
}

function parseScoringAuditResult(raw, allowedEvidenceIds = null, options = {}) {
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
    let isV2 = scoringRubricV2.isV2Rubric(options?.rubricVersion);
    if (hasEvidenceProfile) {
        evidenceProfile = parsed.evidenceProfile;
        const evidenceHeader = scoringFormat.evidenceProfileHeader(evidenceProfile);
        if (!evidenceHeader) throw new Error('评分证据说明的格式或结构指纹无效');
        const profileIsV2 = isV2EvidenceProfileHeader(evidenceHeader);
        if (profileIsV2) isV2 = true;
        const expectedProfileKeys = profileIsV2
            ? SCORING_EVIDENCE_PROFILE_KEYS_V2
            : SCORING_EVIDENCE_PROFILE_KEYS;
        assertExactObjectKeys(
            evidenceProfile, [...Object.keys(evidenceHeader), ...expectedProfileKeys], '评分证据说明'
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
        if (!['direct', 'partial', 'none', 'not_applicable'].includes(evidenceProfile.ablationStatus)) {
            throw new Error(
                `评分证据画像 ablationStatus 非法: ${JSON.stringify(evidenceProfile.ablationStatus)}`
            );
        }
        if (!evidenceProfile.multiComponentClaimed
            && evidenceProfile.ablationStatus !== 'not_applicable') {
            evidenceProfile.ablationStatus = 'not_applicable';
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
        if (allowedEvidenceIds instanceof Set) {
            const unknownBoundaryIds = boundaryIds.filter(id => !allowedEvidenceIds.has(id));
            if (unknownBoundaryIds.length > 0) {
                throw new Error(`评分证据画像 evidenceBoundary 引用了账本外 ID: ${[...new Set(unknownBoundaryIds)].join(', ')}`);
            }
        }
        if (profileIsV2) {
            validateEvidenceClaimList(evidenceProfile.primaryStrengths, 'primaryStrengths', 1, 3, allowedEvidenceIds);
            validateEvidenceClaimList(evidenceProfile.primaryDefects, 'primaryDefects', 0, 3, allowedEvidenceIds);
        }
    }
    const rubricVersion = isV2 ? scoringRubricV2.SCORING_RUBRIC_V2 : scoringRubricV2.SCORING_RUBRIC_V1;
    const dimSpecs = getScoringDimensionsForRubric(rubricVersion);
    assertExactObjectKeys(parsed.dimensions, dimSpecs.map(spec => spec.key), '评分审计 dimensions');

    const dimensions = {};
    for (const spec of dimSpecs) {
        const item = parsed.dimensions[spec.key];
        assertExactObjectKeys(item, AUDIT_ITEM_KEYS, `评分审计维度 ${spec.key}`);
        if (typeof item.score !== 'number' || !Number.isFinite(item.score)) {
            throw new Error(`评分审计维度 ${spec.key} score 必须是有限数字`);
        }
        if (!Number.isInteger(Math.round(item.score * 1000) / 100)) {
            throw new Error(`评分审计维度 ${spec.key} score 最多一位小数`);
        }
        const score = normalizeScoreToOneDecimal(item.score);
        if (score < 0 || score > spec.max) {
            throw new Error(`评分审计维度 ${spec.key} 分数越界`);
        }
        if (spec.key === 'openSource') {
            if (isV2 && !scoringRubricV2.isV2OpenSourceAnchor(score)) {
                throw new Error(`评分审计维度 openSource 必须使用固定锚点 ${scoringRubricV2.V2_OPEN_SOURCE_ANCHORS.join('/')}`);
            }
            if (!isV2 && !isOpenSourceScoreAnchor(score)) {
                throw new Error(`评分审计维度 openSource 必须使用固定锚点 ${OPEN_SOURCE_SCORE_ANCHORS.join('/')}`);
            }
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
        const forbiddenClauses = findForbiddenDeductionClauses(reason, forbiddenPatterns, { dimensionKey: spec.key });
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
        ...(isV2 ? { rubricVersion } : {}),
        documentType, confidence, dimensions,
        ...(evidenceProfile ? { evidenceProfile } : {})
    });
}

function applyScoringEvidenceCaps(audit) {
    const profile = audit?.evidenceProfile;
    if (!profile) return audit;
    const isV2 = scoringRubricV2.isV2Rubric(audit?.rubricVersion);
    const updated = structuredClone(audit);
    const capsApplied = [];
    const cap = (dimension, maximum, rule, explanation) => {
        const item = updated.dimensions[dimension];
        if (!item || item.score <= maximum) return;
        capsApplied.push({ rule, dimension, before: item.score, after: maximum });
        item.score = maximum;
        item.reason = `${item.reason} ${explanation}，本项最高计 ${maximum.toFixed(1)} 分。`;
    };
    const capsCfg = scoringRubricV2.V2_EVIDENCE_CAPS;
    const isReportWithPublicGen = ['模型报告', '系统技术报告'].includes(updated.documentType)
        && ['public', 'mixed'].includes(profile.targetEvaluation)
        && profile.publicGeneralizationEvaluated === true;
    if (profile.multiComponentClaimed && profile.ablationStatus === 'none') {
        const noAblationCap = isV2
            ? (isReportWithPublicGen
                ? capsCfg.multiComponentWithoutDirectAblationReportPublicGenExpMax
                : capsCfg.multiComponentWithoutDirectAblationExpMax)
            : 1.2;
        cap(
            'experimentalSufficiency',
            noAblationCap,
            'multi_component_without_direct_ablation',
            '多组件的因果贡献缺少直接消融支持'
        );
    }
    if (profile.multiComponentClaimed && profile.ablationStatus === 'partial') {
        const partialCap = isV2
            ? (isReportWithPublicGen ? capsCfg.multiComponentPartialAblationReportPublicGenExpMax : capsCfg.multiComponentPartialAblationDefaultExpMax)
            : (isReportWithPublicGen ? 1.4 : 1.3);
        cap('experimentalSufficiency', partialCap, 'multi_component_with_partial_ablation', '多组件的因果贡献只有部分消融支持');
    }
    if (profile.targetEvaluation === 'internal' && !profile.sampleScaleReported) {
        cap(
            'experimentalSufficiency',
            isV2 ? capsCfg.internalEvalWithoutSampleScaleExpMax : 1.2,
            'internal_evaluation_without_sample_scale',
            '内部评测未报告样本规模'
        );
    }
    if (profile.engineeringEvidence === 'claim_only') {
        cap(
            'engineering',
            isV2 ? capsCfg.engineeringClaimOnlyMax : 1.0,
            'engineering_claim_without_measured_or_reusable_evidence',
            '当前证据仅以叙述或间接指标支持工程价值，未包含部署测量或可复用的工程成果'
        );
    } else if (isV2
        && ['系统技术报告', '应用研究'].includes(updated.documentType)
        && !profile.deploymentMeasured
        && profile.targetEvaluation === 'internal') {
        cap(
            'engineering',
            capsCfg.systemInternalUnmeasuredEngMax,
            'system_internal_without_measured_deployment',
            '系统/应用类工作仅内部评测且缺少真实部署性能测量'
        );
    }
    const recalculated = recalculateScoringAudit(updated);
    const nonHighMax = isV2 ? capsCfg.nonHighConfidenceTotalMax : 9.0;
    if (recalculated.confidence !== '高' && recalculated.total > nonHighMax) {
        throw new Error(`评分置信度不是“高”时总分不得超过 ${nonHighMax.toFixed(1)}`);
    }
    const noAblationInternalMax = isV2 ? capsCfg.multiComponentNoAblationInternalTotalMax : 8.5;
    if (profile.multiComponentClaimed && profile.ablationStatus === 'none'
        && profile.targetEvaluation === 'internal' && recalculated.total > noAblationInternalMax) {
        throw new Error(`多组件主张缺少直接消融且主要依赖内部评测时，总分不得超过 ${noAblationInternalMax.toFixed(1)}`);
    }
    return { ...recalculated, capsApplied };
}

function applyScoringAuditResult(analysis, audit) {
    const isV2 = scoringRubricV2.isV2Rubric(audit?.rubricVersion);
    const dimSpecs = getScoringDimensionsForRubric(audit?.rubricVersion);
    let updated = mergeSectionByTitle(analysis, '评分', `${Number(audit.total).toFixed(1)}/10`);
    if (isV2) {
        updated = setMachineSummaryField(updated, 'rubric_version', scoringRubricV2.SCORING_RUBRIC_V2);
    }
    updated = setMachineSummaryField(updated, 'document_type', audit.documentType);
    updated = setMachineSummaryField(updated, 'rank_bucket', audit.rankBucket);
    updated = setMachineSummaryField(updated, 'confidence', audit.confidence);
    for (const spec of dimSpecs) {
        updated = setMachineSummaryField(updated, spec.machineKey, audit.dimensions[spec.key].score.toFixed(1));
    }

    const scoringReason = dimSpecs.map(spec => {
        const item = audit.dimensions[spec.key];
        return `*   ${spec.label} (${item.score.toFixed(1)}/${spec.max})：${item.reason}`;
    }).join('\n\n');
    return mergeSectionByTitle(updated, '评分理由', scoringReason);
}

function sourceReleasePromise(sourceEvidence, identity) {
    const source = String(sourceEvidence || '');
    if (!source || !identity || crypto.createHash('sha256').update(source).digest('hex')
        !== identity.sourceTextSha256) return null;
    const abbrevLookbehind = '(?:(?<=\\b(?:e\\.g|i\\.e|vs|Secs?|Sects?|Figs?|Tabs?|Eqs?|Apps?|Nos?|Dr|Prof|Vol|cf|incl|approx|Refs?|Ch|Chaps?|Suppl?s?|Algs?))\\.|(?<=\\b(?:etc|al))\\.(?!\\s+[A-Z]))';
    const nonEndChar = `(?:[^.!?。]|\\.(?=\\d|[a-z])|${abbrevLookbehind})`;
    const nonEndSameLine = `(?:[^.!?。\\n]|\\.(?=\\d|[a-z])|${abbrevLookbehind})`;
    const nonEndSameLineNoSemi = `(?:[^.!?。;\\n]|\\.(?=\\d|[a-z])|${abbrevLookbehind})`;
    const nonArtifactAdj = '(?:(?:qualitative|quantitative|detailed|full|complete|final|summary|ablation|empirical|experimental|additional|supplementary|audio|visual|raw|preliminary|comprehensive|per-utterance|end-to-end|listening|speech|music|human|public|generated|synthetic|inference|training|demonstration|showcase|diagnostic|test|validation|annotation|prompt|labeling|labelling)\\s+){0,3}';
    const nonArtifactEvalGuard = 'evaluations?(?!\\s+(?:code|scripts?|suite|pipeline)(?!\\s+(?:results?|details?|snippets?|listings?|outputs?|logs?|curves?|reports?|metrics?|scores?|tables?|figures?|examples?|statistics?|overviews?|descriptions?|discussions?|summar(?:y|ies)|analys(?:is|es)|comparisons?|protocols?|documentation)\\b)\\b)';
    const nonArtifactHead = `(?!(?:[’']s|[’'])?\\s+${nonArtifactAdj}(?:architectures?|designs?|details?|statistics?|setups?|settings?|formulations?|overviews?|analys(?:is|es)|descriptions?|discussions?|summar(?:y|ies)|${nonArtifactEvalGuard}|predictions?|outputs?|results?|performance|behaviors?|comparisons?|examples?|hyperparameters?|splits?|specifications?|configurations?|scores?|metrics?|tasks?|demos?|samples?|clips?|figures?|tables?|diagrams?|reports?|papers?|leaderboards?|snippets?|listings?|documentation|datasheets?|cards?|stud(?:y|ies)|prompts?|templates?|guidelines?|recordings?|transcripts?|visualizations?|ablations?|breakdowns?|logs?|curves?|protocols?|(?:training|inference|construction|collection)\\s+(?:details?|statistics?|setups?|settings?|protocols?|costs?|latenc(?:y|ies)|curves?|logs?))\\b)`;
    const nonCompoundHyphen = '(?![-–][A-Za-z])';
    const noPrefixHyphen = '(?<![A-Za-z][-–])';
    const passiveSubject = `(?:${noPrefixHyphen}source[- ]code${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}code(?:s|[-–]?base)?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}implementation${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}repo(?:sitory)?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}models?(?:[’']s|[’'])?[\\s-]weights?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}models?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}weights?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}checkpoints?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}datasets?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}corpus${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}corpora${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}benchmarks?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}annotations?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}scripts?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}toolkits?${nonCompoundHyphen}${nonArtifactHead}|evaluation\\s+(?:code|scripts?|suite|pipeline)${nonCompoundHyphen}${nonArtifactHead}|reproduction\\s+(?:code|scripts?|pipeline)${nonCompoundHyphen}${nonArtifactHead})`;
    const activePattern = new RegExp(`\\b(?:(?:Upon\\s+(?:acceptance|publication),\\s+)?We\\s+(?:will|plan\\s+to|intend\\s+to)\\s+(?:instead\\s+|publicly\\s+|openly\\s+)?(?:release|provide|open[- ]source|publish|make\\s+(?:publicly\\s+|openly\\s+)?available)|The\\s+accompanying\\s+repository\\s+will\\s+(?:release|provide))\\b${nonEndChar}{1,600}[.!?。]?`, 'gi');
    const passivePattern = new RegExp(`\\b(?:(?:Our|The|All)\\s+)?(?:(?:all|full|complete|trained|pre-?trained|training|evaluation|eval|inference|source|reproduction|official|public|accompanying|entire|proposed|curated|annotated|supporting)\\s+){0,3}${passiveSubject}\\b${nonEndSameLineNoSemi}{0,220}\\bwill\\s+be\\s+(?:publicly\\s+|openly\\s+)?(?:released|made\\s+(?:publicly\\s+|openly\\s+)?available|open[- ]sourced)\\b${nonEndChar}{0,320}[.!?。]?`, 'gi');
    const passivePredRe = /\bwill\s+be\s+(?:publicly\s+|openly\s+)?(?:released|made\s+(?:publicly\s+|openly\s+)?available|open[- ]sourced)\b/gi;
    const passiveSubjectRe = new RegExp(`\\b(${passiveSubject})\\b`, 'gi');
    const finiteVerbOrModalRe = /\b(?:is|are|was|were|has|have|had|can|could|may|might|should|must|outperforms?|outperformed|achieves?|achieved|attains?|attained|reaches?|reached|improves?|improved|uses?|evaluates?|trains?|shows?|showed|demonstrates?|demonstrated|produces?|contains?|works?|worked|runs?|ran|requires?|supports?|generates?|yields?|yielded|learns?|covers?|excels?|excelled|synthesizes?|enables?|scales?|scaled|handles?|predicts?|reduces?|operates?|performs?|processes?|captures?|estimates?|extracts?|decodes?|encodes?|beats?|surpasses?|surpassed|matches?|solves?|eliminates?|mitigates?|avoids?|preserves?|retains?|combines?|integrates?|leverages?|utilizes?|adopts?|employs?|incorporates?|introduces?|presents?|proposes?|builds?|extends?|expands?|includes?|consists?|comprises?|provides?|offers?|delivers?|targets?|addresses?|tackles?|focuses?|relies?|depends?|benefits?|differs?|varies?|remains?|becomes?|allows?|facilitates?|accelerates?|simplifies?|stabilizes?|generalizes?|generalized|ranks?|ranked|converges?|converged|scores?|scored|exhibits?|exhibited|suffers?|suffered|degrades?|degraded|fails?|failed|reconstructs?|reconstructed|will\s+be\s+(?:evaluated|tested|trained|used|applied|compared|discussed|described|presented|reported|analyzed|shown))\b/i;
    const relativeBodyBadStartRe = /^(?:as|in|on|at|for|with|upon|after|before|once|when|if|until|soon|very|also|only|just|still|already|later|eventually|currently|although|though|because|since|unless|whereas|while|provided|assuming|even)\b/i;
    const reportingVerbPat = '(?:show[ns]?|showed|demonstrat(?:e[sd]?)|present(?:s|ed)?|propos(?:e[sd]?)|claim(?:s|ed)?|stat(?:e[sd]?)|say[s]?|said|mention(?:s|ed)?|report(?:s|ed)?|confirm(?:s|ed)?|promis(?:e[sd]?)|indicat(?:e[sd]?)|suggest(?:s|ed)?|explain(?:s|ed)?|describ(?:e[sd]?)|argu(?:e[sd]?)|assert(?:s|ed)?|believ(?:e[sd]?)|expect(?:s|ed)?|hop(?:e[sd]?)|plan(?:s|ned)?|intend(?:s|ed)?|not(?:e[sd]?)|remark(?:s|ed)?|point(?:s|ed)?\\s+out|clarif(?:y|ies|ied)|emphasiz(?:e[sd]?)|highlight(?:s|ed)?)';
    const reportingLocPat = '(?:(?:in|on|at)\\s+(?:(?:the\\s+)?(?:appendix|supplement(?:ary)?|paper|section|manuscript|text)|(?:Section|Sec\\.?|Sect\\.?|Appendix|App\\.?|Table|Tab\\.?|Figure|Fig\\.?|Part|Chapter)\\s+[A-Za-z0-9.]{1,16})|above|below|herein|earlier|later)';
    const parentheticalReportingFrameRe = new RegExp(
        `^(?:(?:the|our|this)\\s+(?:paper|authors?|work|study|manuscript|section|appendix)|we|they)(?:\\s+${reportingLocPat})?\\s+(?:(?:has|have|had|can|could|may|might|will|would|should|also|already|explicitly|further|briefly|clearly|specifically|recently|previously|earlier|here|later|now)\\s+){0,3}${reportingVerbPat}(?:\\s+${reportingLocPat})?\\s*$`,
        'i'
    );
    const relativeFiniteVerbMorphRe = /^(?:(?:[a-z]{3,}ly|we|it|they|this|these|our\s+[a-z-]+|the\s+[a-z-]+)\s+)?(?!as\b|thus\b|plus\b|this\b|ours\b|hers\b|his\b|its\b|yes\b|less\b|across\b|towards\b|afterwards\b|forwards\b|backwards\b|upwards\b|downwards\b|besides\b|always\b|sometimes\b|nowadays\b|otherwise\b|likewise\b|anyways\b|whereas\b|unless\b|perhaps\b|details\b|results\b|weights\b|models\b|datasets\b|benchmarks\b|samples\b|demos\b|examples\b|metrics\b|scores\b|figures\b|tables\b|scripts\b|checkpoints\b|annotations\b|authors\b|papers\b|studies\b|tasks\b|languages\b|domains\b|hours\b|clips\b|outputs\b|predictions\b|based\b|related\b|shown\b|given\b|notes?\b|noted\b|remarks?\b|remarked\b|clarifies\b|clarified\b|emphasizes\b|emphasized\b|highlights\b|highlighted\b|claims?\b|claimed\b|states?\b|stated\b|says?\b|said\b|mentions?\b|mentioned\b|reports?\b|reported\b|confirms?\b|confirmed\b|promises?\b|promised\b|indicates?\b|indicated\b|suggests?\b|suggested\b|explains?\b|explained\b|describes?\b|described\b|argues?\b|argued\b|asserts?\b|asserted\b|believes?\b|believed\b|expects?\b|expected\b|hopes?\b|hoped\b|plans?\b|planned\b|intends?\b|intended\b)[a-z]{3,}(?:s|ed)\b/i;
    const hasRelativeFiniteVerb = body => {
        const b = String(body || '')
            .replace(/,\s*as\s+(?:(?:is|was|we|they|(?:the|our|this)\s+(?:paper|authors?|work|study))\s+)?(?:show[ns]?|showed|describ(?:e[sd]?)|detail(?:s|ed)?|discuss(?:es|ed)?|not(?:e[sd]?)|report(?:s|ed)?|illustrat(?:e[sd]?)|summariz(?:e[sd]?)|outlin(?:e[sd]?)|present(?:s|ed)?|mention(?:s|ed)?|stat(?:e[sd]?)|claim(?:s|ed)?)\b[^,]{0,80},/gi, ' ')
            .replace(/,\s*(?:in|on|at|see|cf\.?)\s+(?:Section|Sec\.?|Sect\.?|Appendix|App\.?|Table|Tab\.?|Figure|Fig\.?|Part|Chapter)\s+[A-Za-z0-9.]{1,16}\s*,/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!b || relativeBodyBadStartRe.test(b) || parentheticalReportingFrameRe.test(b)) return false;
        return finiteVerbOrModalRe.test(b) || relativeFiniteVerbMorphRe.test(b);
    };
    const nonArtifactCoordinatedHeadRe = new RegExp(`\\b(?:supplementary|tables?|figures?|reports?|guidelines?|demos?|samples?|clips?|results?|documentation|datasheets?|cards?|scores?|metrics?|outputs?|predictions?|examples?|logs?|curves?|protocols?|statistics?|details?|${nonArtifactEvalGuard}|leaderboards?|analys(?:is|es)|summar(?:y|ies)|comparisons?|templates?|prompts?|recordings?|transcripts?)\\b`, 'i');
    const prepLeadRe = '(?:of|for|from|between|on|in|at|about|regarding|analyzing|evaluating|comparing|using|with|across|over|via|by|under|into|upon|against|showcasing|illustrating|demonstrating|depicting|showing|featuring|highlighting|visualizing|detailing|explaining|describing|summarizing|presenting|displaying|running|to\\s+(?:showcase|illustrate|demonstrate|show|evaluate|test|train|benchmark|validate|explain|describe|run))';
    const prepWordToken = "(?:(?!\\band\\b|\\bor\\b)(?:[A-Za-z0-9'’.,/-]+|\\([^()]{1,40}\\)))";
    const passiveGovPrepRe = new RegExp(`\\b(?:${prepLeadRe}|to)\\s+(?:both\\s+|either\\s+)?(?:${prepWordToken}\\s+){0,10}$`, 'i');
    const activeGovPrepRe = new RegExp(`\\b${prepLeadRe}\\s+(?:both\\s+|either\\s+)?(?:${prepWordToken}\\s+){0,10}$`, 'i');
    const prepItemToken = "(?:(?!\\band\\b|\\bor\\b)(?:[A-Za-z0-9'’./-]+|\\([^()]{1,40}\\)))";
    const prepCommaItem = `(?:${prepItemToken}(?:\\s+${prepItemToken}){0,4})`;
    const coordinatedInPrepRe = new RegExp(`\\b(?:between\\s+(?:(?:[A-Za-z0-9'’.,/-]+|\\([^()]{1,40}\\))\\s+){1,10}and|${prepLeadRe}\\s+(?:both\\s+(?:${prepItemToken}\\s+){1,8}and|(?:${prepItemToken}\\s+){1,8}(?:and|or)|${prepCommaItem},\\s*(?:${prepCommaItem},\\s*){0,3}${prepCommaItem},?\\s*(?:and|or)))\\s+(?:${prepWordToken}\\s+){0,4}$`, 'i');
    const containerAdjGuard = '(?!(?:of|for|from|in|on|at|to|by|with|under|between|across|over|via|against|about|regarding|samples?|examples?|demos?|clips?|tests?|analys(?:is|es)|results?|outputs?|predictions?|evaluations?|comparisons?|tables?|figures?|reports?|metrics?|scores?|logs?|curves?|statistics?|summar(?:y|ies)|guidelines?|templates?|prompts?|recordings?|transcripts?|descriptions?|discussions?|details?|overviews?|stud(?:y|ies))\\b)';
    const allowedContainerPrepRe = new RegExp(`\\b(?:(?:along|together)\\s+with|as\\s+well\\s+as|access\\s+to|(?:code|scripts?|repo(?:sitory)?|implementation|weights?|checkpoints?|(?:full|open|public|curated|complete)\\s+versions?|subsets?|variants?|famil(?:y|ies)|suites?|series|sets?|collections?|packages?|bundles?)\\s+(?:of|for))\\s+(?:${containerAdjGuard}[A-Za-z0-9'’,-]+\\s+){0,6}$`, 'i');
    const isPureOxfordArtifactList = beforeCommaAnd => {
        const trimmed = String(beforeCommaAnd || '').trim();
        if (!trimmed.startsWith(',')) return false;
        const items = trimmed.slice(1).split(',').map(part => part.trim()).filter(Boolean);
        if (!items.length) return false;
        const appositiveOrClauseRe = /^(?:a|an)\s+|^the\s+proposed\b|\b(?:evaluated|trained|tested|compared|measured|applied|derived|obtained|built|developed|fine-?tuned|proposed|described|introduced|presented|shown|denoted)\s+(?:on|in|at|with|under|from|using|by|over|across|as)\b|\d+%/i;
        return items.every(item => {
            const words = item.split(/\s+/).filter(Boolean);
            return words.length >= 1 && words.length <= 6
                && !finiteVerbOrModalRe.test(item)
                && !appositiveOrClauseRe.test(item);
        });
    };
    const hasValidPassiveDirectArtifact = text => {
        const str = String(text || '');
        for (const pm of str.matchAll(passivePredRe)) {
            const beforePred = str.slice(Math.max(0, pm.index - 220), pm.index);
            const cutAt = Math.max(beforePred.lastIndexOf('\n'), beforePred.lastIndexOf(';'), beforePred.lastIndexOf('；'));
            const clauseWindow = cutAt >= 0 ? beforePred.slice(cutAt + 1) : beforePred;
            for (const sm of clauseWindow.matchAll(passiveSubjectRe)) {
                const beforeSm = clauseWindow.slice(0, sm.index);
                if ((passiveGovPrepRe.test(beforeSm) || coordinatedInPrepRe.test(beforeSm))
                    && !allowedContainerPrepRe.test(beforeSm)) continue;
                let midCleaned = clauseWindow.slice(sm.index + sm[0].length)
                    .replace(/\([^()]*\)/g, ' ')
                    .replace(/,\s*(?:which|that|who)\b([^,]{1,120}),/gi, (full, body) => (
                        (/\b(?:that|which|whose)\b/i.test(body) || !hasRelativeFiniteVerb(body)) ? full : ' '
                    ))
                    .replace(
                        /(?<!\b(?:for|on|in|from|with|to|by|at|of|under|via|through|about|into|over|upon|against|across|between|without|toward|towards|behind|within)\s+)\b(?:that|which)\s+((?=\S)(?:(?!,\s*(?:and|but|while|whereas)\b|\b(?:that|which)\b)[^.;]){2,100}\S)\s*$/gi,
                        (full, body) => {
                            const b = body.trim();
                            if (b.split(/\s+/).length < 2 || !hasRelativeFiniteVerb(b)) return full;
                            return ' ';
                        }
                    )
                    .replace(/\s+/g, ' ');
                if (/\b(?:that|which|whose)\b/i.test(midCleaned)) continue;
                if (/\b(?:while|whereas|but|however|yet|although|though|where|so)\b/i.test(midCleaned)) continue;
                const commaAndMatch = /,\s*and\b/i.exec(midCleaned);
                if (commaAndMatch) {
                    const beforeCommaAnd = midCleaned.slice(0, commaAndMatch.index);
                    const afterCommaAnd = midCleaned.slice(commaAndMatch.index + commaAndMatch[0].length);
                    const isOxfordSubjectList = isPureOxfordArtifactList(beforeCommaAnd);
                    if (finiteVerbOrModalRe.test(beforeCommaAnd)
                        || (!isOxfordSubjectList && nonArtifactCoordinatedHeadRe.test(afterCommaAnd))) {
                        continue;
                    }
                }
                if (finiteVerbOrModalRe.test(midCleaned)) continue;
                const trimmedMid = midCleaned.trim();
                if (trimmedMid && !/^(?:,|and\b|or\b|&|at\b|of\b|for\b|with\b|in\b|from\b|on\b|to\b|under\b|behind\b|used\b|trained\b|developed\b|described\b|introduced\b|proposed\b|presented\b|built\b|created\b|collected\b|generated\b|associated\b|accompanying\b|supporting\b|including\b|needed\b|required\b|necessary\b|evaluated\b|tested\b|along\b|as\s+well\s+as\b|together\b|plus\b|\/|-(?!\w))/i.test(trimmedMid)) {
                    continue;
                }
                return true;
            }
        }
        return false;
    };
    const matches = [...source.matchAll(activePattern), ...source.matchAll(passivePattern)]
        .sort((left, right) => left.index - right.index);
    const stripPossessiveApostrophes = text => String(text || '')
        .replace(/([A-Za-z])[’']s\b/g, '$1 s')
        .replace(/([A-Za-z]s)[’'](?=\s|$)/g, '$1');
    const artifactNoun = `(?:${noPrefixHyphen}source[- ]code${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}code(?:s|[-–]?base)?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}implementation${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}repo(?:sitory)?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}models?(?:[’']s|[’'])?[\\s-]weights?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}models?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}weights?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}checkpoints?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}datasets?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}corpus${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}corpora${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}benchmarks?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}annotations?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}scripts?${nonCompoundHyphen}${nonArtifactHead}|${noPrefixHyphen}toolkits?${nonCompoundHyphen}${nonArtifactHead}|evaluation\\s+(?:code|scripts?|suite|pipeline)${nonCompoundHyphen}${nonArtifactHead}|reproduction\\s+(?:code|scripts?|pipeline)${nonCompoundHyphen}${nonArtifactHead})`;
    const releaseVerbRe = /\b(?:release|open[- ]source|make\s+(?:publicly\s+|openly\s+)?available|(?<=The\s+accompanying\s+repository\s+will\s+)provide)\b/gi;
    const afterVerbClauseRe = new RegExp(`^(${nonEndChar}{0,120})`);
    const artifactNounRe = new RegExp(`\\b(${artifactNoun})\\b`, 'gi');
    const nonArtifactRelHeadBase = `\\b(?:samples?|examples?|demos?|demo\\s+pages?|project\\s+pages?|clips?|figures?|tables?|diagrams?|reports?|papers?|results?|outputs?|predictions?|${nonArtifactEvalGuard}|comparisons?|analys(?:is|es)|summar(?:y|ies)|descriptions?|discussions?|details?|overviews?|stud(?:y|ies)|documentation|datasheets?|cards?|guidelines?|templates?|prompts?|recordings?|transcripts?|metrics?|scores?|logs?|curves?|protocols?|statistics?|leaderboards?|videos?|audios?|pages?|websites?|interfaces?|playgrounds?|apps?|applications?|portals?|viewers?|players?|galler(?:y|ies)|showcases?|widgets?|uis?|guis?)\\b(?:[^,.;]{0,60}(?:,\\s*[^,.;]{1,40})?,?\\s*)\\b(?:where|when|while|that|which|whose)\\b`;
    const nonArtifactRelHeadInBetweenRe = new RegExp(`${nonArtifactRelHeadBase}(?:(?!,\\s*and\\b)[^.;])*$`, 'i');
    const nonArtifactRelHeadCoordRe = new RegExp(`${nonArtifactRelHeadBase}[^.;]*,\\s*and\\b[^.;]*$`, 'i');
    const coordRelPreVerbModPat = '(?:v\\d+(?:\\.\\d+)*\\s+)?(?:\\([^()]{1,24}\\)\\s+)?(?:(?:also|both|only|still|just|now|even|always|often|seldom|rarely|usually|typically|frequently|sometimes|directly|automatically|[a-z]{3,}ly)\\s+)*';
    const coordRelParticipleModRe = /^\s+(?:v\d+(?:\.\d+)*\s+)?(?:\([^()]{1,24}\)\s+)?(?:[a-z]{3,}ly\s+)?(?:hosted|trained|pre-?trained|fine-?tuned|licensed|released|stored|published|shared|provided|located|packaged|maintained|implemented|used|utilized|employed|described|presented|introduced|proposed|developed|designed|built|created|collected|curated|annotated|derived|obtained|adapted|evaluated|tested|validated|benchmarked|measured|compared|applied|associated|accompanying|needed|required|included|contained)\s+(?:on|in|at|under|with|by|from|for|to|via|as|using|over|across|into|within)\b/i;
    const coordRelPluralBaseVerbRe = new RegExp(`^\\s+${coordRelPreVerbModPat}(?:synthesize|run|generate|produce|convert|process|render|predict|estimate|extract|decode|encode|operate|perform|work|handle|support|take|accept|output|return|play|stream|transform|translate|transcribe|classify|detect|recognize|separate|enhance|reconstruct|align|compute|infer|learn|adapt|respond|interact|achieve|outperform|beat|surpass|improve|reduce|enable|allow|provide|offer|deliver|serve|require|use|utilize|employ|adopt|leverage|combine|integrate|contain|include|consist|comprise|cover|span|vary|differ|remain|become|fail|suffer|degrade|exhibit|converge|generalize|scale|excel)\\b`, 'i');
    const coordRelFiniteVerbRe = new RegExp(`^\\s+${coordRelPreVerbModPat}(?:is|are|was|were|has|have|can|could|may|might|should|must|will\\s+(?!be\\s+(?:publicly\\s+|openly\\s+)?(?:released|available|open[- ]sourced)\\b)|[a-z]{3,}(?:s|ed))\\b`, 'i');
    const coordRelModifierNonVerbNouns = new Set([
        'parameters', 'hours', 'minutes', 'seconds', 'samples', 'examples', 'layers', 'tokens', 'frames',
        'models', 'datasets', 'weights', 'checkpoints', 'scripts', 'results', 'metrics', 'scores', 'files',
        'demos', 'clips', 'speakers', 'languages', 'domains', 'channels', 'steps', 'epochs', 'batches',
        'gpus', 'cpus', 'tpus', 'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'tasks', 'benchmarks',
        'corpora', 'annotations', 'labels', 'prompts', 'features', 'embeddings', 'audios', 'videos', 'texts',
        'images', 'voices', 'sounds', 'users', 'authors', 'papers', 'studies', 'details', 'settings', 'configs'
    ]);
    const hasCoordRelFollowingFiniteVerb = afterArtifact => {
        const raw = String(afterArtifact || '');
        const trimmedLead = raw.replace(/^\s*(?:v\d+(?:\.\d+)*\b\s*)?(?:\([^()]{1,24}\)\s*)?/, ' ');
        const partMatch = coordRelParticipleModRe.exec(raw);
        const prepMatch = !partMatch ? /^\s+(?:for|with|on|in|at|from|by|via|under)\b/i.exec(trimmedLead) : null;
        if (partMatch || prepMatch) {
            const afterModHead = partMatch
                ? raw.slice(partMatch.index + partMatch[0].length)
                : trimmedLead.slice(prepMatch.index + prepMatch[0].length);
            const stopMatch = /[,.;!?。]|\b(?:upon|and|or)\b/i.exec(afterModHead);
            const modSlice = stopMatch ? afterModHead.slice(0, stopMatch.index) : afterModHead;
            // Scan token offsets after 1..8 modifier words to detect a genuine finite verb following the PP/participle phrase.
            const tokMatches = [...modSlice.matchAll(/\S+/g)];
            const maxScan = Math.min(tokMatches.length, 8);
            for (let ti = 1; ti < maxScan; ti += 1) {
                const candidate = ` ${modSlice.slice(tokMatches[ti].index)}`;
                const headWord = tokMatches[ti][0].toLowerCase().replace(/[^a-z]/g, '');
                if (coordRelModifierNonVerbNouns.has(headWord)) continue;
                if (coordRelFiniteVerbRe.test(candidate) || coordRelPluralBaseVerbRe.test(candidate)) {
                    return true;
                }
            }
            return false;
        }
        return coordRelFiniteVerbRe.test(raw) || coordRelPluralBaseVerbRe.test(raw);
    };
    const coreCodeOrWeightArtifactRe = /^(?:source[- ]code|code(?:s|[-–]?base)?|implementation|models?(?:[’']s|[’'])?[\s-]weights?|weights?|checkpoints?|scripts?)$/i;
    const isIndependentDirectCoordinatedArtifact = (between, matchedArtifact) => {
        if (/\b(?:between|both)\b/i.test(between)) return false;
        const coordHeadMatch = /\band\s+(our|full|complete|source|the\s+(?:full|complete|source|training|inference|official|accompanying|entire))\s+(?:[A-Za-z-]+\s+){0,2}$/i.exec(between);
        if (!coordHeadMatch) {
            return false;
        }
        if (/\band\s+(?:our|the)?\s*(?:[A-Za-z-]+\s+){0,2}\b(?:baseline|reference|prior|existing|other|original|base|fine-?tuned|quantized|teacher|student|pre-?trained)\b/i.test(between)) {
            return false;
        }
        if (coreCodeOrWeightArtifactRe.test(matchedArtifact)) {
            return /\b(?:demos?|demo\s+page|project\s+page|samples?|clips?|examples?|results?|performance|metrics?|scores?|figures?|tables?|evaluations?|outputs?)\s+(?:of|for|from|on)\s+/i.test(between);
        }
        if (/^(?:datasets?|benchmarks?|corpus|corpora|annotations?)$/i.test(matchedArtifact)) {
            return /\b(?:results?|evaluations?|scores?|metrics?|performance|comparisons?)\s+on\s+(?:[A-Z][A-Za-z0-9._-]*\s+){1,3}and\s+our\s+$/i.test(between);
        }
        return false;
    };
    const hasValidStrongDirectArtifact = text => {
        const str = String(text || '');
        for (const vm of str.matchAll(releaseVerbRe)) {
            const afterVerb = str.slice(vm.index + vm[0].length);
            const clause = afterVerbClauseRe.exec(afterVerb)?.[1] || '';
            for (const am of clause.matchAll(artifactNounRe)) {
                const between = clause.slice(0, am.index);
                if (nonArtifactRelHeadInBetweenRe.test(between)) continue;
                const afterArtifact = clause.slice(am.index + am[0].length);
                if (nonArtifactRelHeadCoordRe.test(between) && hasCoordRelFollowingFiniteVerb(afterArtifact)) {
                    continue;
                }
                const governedByPrep = activeGovPrepRe.test(between);
                const coordinatedInPrep = coordinatedInPrepRe.test(between)
                    && !isIndependentDirectCoordinatedArtifact(between, am[0]);
                const allowedPrep = allowedContainerPrepRe.test(between);
                if ((governedByPrep || coordinatedInPrep) && !allowedPrep) continue;
                return true;
            }
        }
        return false;
    };
    const weakDirectArtifact = new RegExp(`\\b(?:provide|publish)\\s+(?:(?:public|open|free|full)\\s+)?(?:access\\s+to\\s+)?(?:(?:the|our|all|full|complete|trained|pretrained|accompanying|supporting|official|benchmark|evaluation|training|inference|source|analysis|optimization|reproduction|preprocessing|data|model|and)\\s+){0,5}${artifactNoun}\\b`, 'i');
    const standardAvailabilityHeaderRe = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:justification|code\s+availability|data\s+availability|dataset\s+availability|model\s+availability|artifact\s+availability|resource\s+availability|software\s+availability|(?:code|data|dataset|model|artifact|resource|software)(?:\s+(?:and|&|\/)\s+(?:code|data|dataset|model|artifact|resource|software))*\s+availability|availability(?:\s+statement)?|reproducibility(?:\s+statement)?|open[- ]source(?:\s+(?:statement|release|availability|plan))?|broader\s+impact|ethics(?:\s+statement)?)\s*:\s*$/i;
    for (const match of matches) {
        const sentence = match[0];
        const before = source.slice(0, match.index);
        const sentencePrefix = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'),
            before.lastIndexOf('?'), before.lastIndexOf('。'), before.lastIndexOf(';'), before.lastIndexOf('；'),
            before.lastIndexOf('\n')) + 1);
        if (sentencePrefix.trim()) continue;
        const linesBefore = before.split('\n');
        const paragraphPrefix = linesBefore.at(-1);
        const previousLine = linesBefore.slice(0, -1).reverse().find(line => line.trim()) || '';
        const context = stripPossessiveApostrophes(paragraphPrefix + '\n' + previousLine);
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
        if (!paragraphPrefix.trim() && /:\s*$/.test(previousLine) && !standardAvailabilityHeaderRe.test(previousLine.trim())) continue;
        let fence = null;
        for (const line of linesBefore) {
            const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
            if (!marker) continue;
            if (!fence) fence = marker[0];
            else if (marker[0] === fence) fence = null;
        }
        if (fence || /^\s*>/.test(paragraphPrefix)) continue;
        const sentenceForChecks = stripPossessiveApostrophes(sentence)
            .replace(/\b(?:retaining|subject\s+to|with)\s+(?:upstream\s+attribution\s+and\s+)?(?:applicable\s+)?third[- ]party\s+(?:terms|licenses?|notices?)\b/gi, '');
        if (/\b(?:not|never|no|cannot|can[’']t|won[’']t|don[’']t|doesn[’']t|isn[’']t|aren[’']t|unable\s+to|proprietary|confidential|internal\s+only|third[- ]party|unrelated|external|borrowed)\b|developed by|other authors|["“”'‘’`]/i.test(sentenceForChecks)) continue;
        const nonReleaseProse = /\b(?:provide\s+(?:more\s+|further\s+|additional\s+)?(?:details?|an?\s+(?:overview|analysis|description|discussion|summary|comprehensive\s+analysis)|examples?|qualitative\s+examples?|proofs?|results?)|publish\s+(?:a|an|the|our)?\s*(?:follow[- ]up\s+)?(?:paper|report|analysis|study|results?)|(?:model|benchmark|dataset)\s+(?:predictions?|outputs?|results?|statistics?)\s+will\s+be)\b/i;
        if (nonReleaseProse.test(sentence)) continue;
        const directArtifactObject = hasValidStrongDirectArtifact(sentence)
            || weakDirectArtifact.test(sentence)
            || hasValidPassiveDirectArtifact(sentence);
        if (!directArtifactObject) continue;
        const accompanyingRepository = /^The accompanying repository will/i.test(sentence);
        const firstPersonActive = /^(?:Upon\s+(?:acceptance|publication),\s+)?We\s+(?:will|plan\s+to|intend\s+to)\b/i.test(sentence);
        const passiveRelease = /\bwill\s+be\s+(?:publicly\s+|openly\s+)?(?:released|made\s+(?:publicly\s+|openly\s+)?available|open[- ]sourced)\b/i.test(sentence);
        if (!accompanyingRepository && !firstPersonActive && !passiveRelease) continue;
        return {
            conditional: /\bsubject to\b|\bconsent\b|\binstitutional requirements\b|\bupon\s+(?:acceptance|publication)\b/i.test(sentence),
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

function findMatchingArtifactProbe(resource, artifactProbes) {
    if (!resource || !Array.isArray(artifactProbes) || artifactProbes.length === 0) return null;
    const targets = new Set(
        [resource.originalUrl, resource.finalUrl]
            .map(normalizeArtifactProbeUrl)
            .filter(Boolean)
    );
    if (targets.size === 0) return null;
    return artifactProbes.find(probe => {
        if (!probe || typeof probe !== 'object' || probe.ok !== true) return false;
        const probeUrls = [probe.canonicalUrl, probe.url, probe.originalUrl]
            .map(normalizeArtifactProbeUrl)
            .filter(Boolean);
        return probeUrls.some(u => targets.has(u));
    }) || null;
}

function isConfirmedPlaceholderArtifactProbe(probe) {
    return Boolean(
        probe
        && probe.ok === true
        && probe.placeholderSuspected === true
        && probe.hasCodeFiles !== true
        && probe.hasWeightFiles !== true
        && probe.hasDatasetFiles !== true
    );
}

const VERIFIED_TYPE_DENIAL_PATTERNS = Object.freeze({
    code: /(?:完全闭源|闭源|不开源|未开源|没有开源|代码未提供|源码未提供|(?:未|没有|尚未|缺少)[^.。；;]{0,16}(?:代码|源码|实现代码)|(?:代码|源码|代码仓库)(?:未|没有|尚未)(?:公开|发布|提供|开源))/,
    model: /(?:完全闭源|闭源|不开源|未开源|没有开源|权重未提供|模型未提供|(?:未|没有|尚未|缺少)[^.。；;]{0,16}(?:模型权重|权重|checkpoint|ckpt)|(?:模型权重|权重)(?:未|没有|尚未)(?:公开|发布|提供))/,
    dataset: /(?:完全闭源|闭源|不开源|未开源|没有开源|数据集未提供|(?:未|没有|尚未|缺少)[^.。；;]{0,16}(?:数据集|语料)|(?:数据集|语料)(?:未|没有|尚未)(?:公开|发布|提供))/
});

const BLANKET_CORE_MATERIAL_DENIAL = /(?:缺少核心(?:材料|产物)|核心(?:材料|产物)(?:未|没有|尚未)(?:公开|发布|提供))/;

function reasonDeniesVerifiedAvailableResourceType(reason, verifiedAvailableTypes) {
    const clauses = String(reason || '').split(/[。！？；;\n]/).map(c => c.trim()).filter(Boolean);
    const hasVerifiedCore = ['code', 'model', 'dataset'].some(type => verifiedAvailableTypes.has(type));
    if (hasVerifiedCore && clauses.some(clause => !EXPLICIT_NON_DEDUCTION.test(clause) && BLANKET_CORE_MATERIAL_DENIAL.test(clause))) {
        return true;
    }
    for (const type of ['code', 'model', 'dataset']) {
        if (!verifiedAvailableTypes.has(type)) continue;
        const pattern = VERIFIED_TYPE_DENIAL_PATTERNS[type];
        if (clauses.some(clause => !EXPLICIT_NON_DEDUCTION.test(clause) && pattern.test(clause))) {
            return true;
        }
    }
    return false;
}

function validateScoringAuditAgainstAnalysis(analysis, audit, verifiedResourceIdentity = null, sourceEvidence = '', options = {}) {
    const current = parseAnalysis(analysis) || {};
    const isV2 = scoringRubricV2.isV2Rubric(audit?.rubricVersion);
    const artifactProbes = Array.isArray(options?.artifactProbes) ? options.artifactProbes : [];
    const scores = isV2
        ? { complete: 10.0, incompleteDocs: 8.0, partial: 6.0, promise: 3.0, demo: 1.5, closed: 0.0 }
        : { complete: 1.5, incompleteDocs: 1.2, partial: 1.0, promise: 0.5, demo: 0.2, closed: 0.0 };
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
    if (audit.documentType === '理论研究') {
        if (!isV2) return applyScoringEvidenceCaps(audit);
        if (!hasReleasedArtifact) {
            // 理论研究不因正文出现公式就白嫖满分开源；无已核验验证代码/数据时最高仅计 3.0（B_t=0.2 → 最多 +0.06）。
            if (audit.dimensions.openSource.score > scores.promise) {
                const normalizedAudit = {
                    ...audit,
                    dimensions: {
                        ...audit.dimensions,
                        openSource: {
                            score: scores.promise,
                            reason: '[A_OPEN] 理论研究在正文/附录公开推导与证明但无已核验复现代码或实验数据仓库，本项按理论公开材料上限计 3.0 分（类型上限加分 B_t=0.2）。'
                        }
                    }
                };
                return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
            }
            return applyScoringEvidenceCaps(audit);
        }
        // 理论研究若确实有已核验代码/数据产物，则继续走下方统一核验与防否认逻辑。
    }
    if (!hasReleasedArtifact) {
        const sourceText = String(current.opensource || '');
        const sourcePromise = sourceReleasePromise(sourceEvidence, verifiedResourceIdentity);
        const promisesRelease = sourceEvidence && verifiedResourceIdentity
            ? Boolean(sourcePromise) : hasAffirmativeReleasePromise(sourceText);
        const hasDemo = hasAffirmativeDemoEvidence(sourceText);
        const normalizedScore = promisesRelease ? scores.promise : hasDemo ? scores.demo : scores.closed;
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
        const availableCoreResources = verifiedResourceIdentity.resources.filter(
            item => item?.availability === 'available' && ['code', 'model', 'dataset'].includes(item.type)
        );
        const substantiveCoreResources = availableCoreResources.filter(resource => (
            !isConfirmedPlaceholderArtifactProbe(findMatchingArtifactProbe(resource, artifactProbes))
        ));
        const substantiveAvailableTypes = new Set(substantiveCoreResources.map(item => item.type));
        const allAvailableCorePlaceholder = artifactProbes.length > 0
            && availableCoreResources.length > 0
            && substantiveCoreResources.length === 0;
        if (substantiveAvailableTypes.size === 0 && allAvailableCorePlaceholder) {
            if (openSource.score <= scores.promise) {
                return applyScoringEvidenceCaps(audit);
            }
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: scores.promise,
                        reason: `[A_OPEN] 自动探测确认当前可访问的核心仓库仅为占位框架、尚未包含实质代码、模型权重或数据文件，按未实质发布核心产物上限计 ${scores.promise.toFixed(1)} 分。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        const isDatasetPaper = audit.documentType === '数据集与基准';
        const isCodeOnlyType = ['理论研究', '综述'].includes(audit.documentType);
        const hasCompleteCoreRelease = !allAvailableCorePlaceholder && (
            isV2 && isDatasetPaper
                ? substantiveAvailableTypes.has('dataset')
                : (isV2 && isCodeOnlyType
                    ? (substantiveAvailableTypes.has('code') || substantiveAvailableTypes.has('dataset'))
                    : (substantiveAvailableTypes.has('code') && substantiveAvailableTypes.has('model')))
        );
        const hasCompleteDocumentation = substantiveCoreResources.some(resource => (
            (resource?.type === 'code' || (isDatasetPaper && isV2 && resource?.type === 'dataset'))
            && resource?.availability === 'available'
            && resource?.documentationEvidence?.completeness === 'complete'
            && validRepositoryDocumentationEvidence(
                resource.documentationEvidence, resource.originalUrl
            )
        ));
        const hasPartialDocumentation = substantiveCoreResources.some(resource => (
            (resource?.type === 'code' || (isDatasetPaper && isV2 && resource?.type === 'dataset'))
            && resource?.availability === 'available'
            && resource?.documentationEvidence?.completeness === 'partial'
            && Object.values(resource?.documentationEvidence?.capabilities || {}).some(Boolean)
            && validRepositoryDocumentationEvidence(
                resource.documentationEvidence, resource.originalUrl
            )
        ));
        if (hasCompleteCoreRelease && hasCompleteDocumentation
            && openSource.score !== scores.complete) {
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: scores.complete,
                        reason: isDatasetPaper && isV2
                            ? `[A_OPEN] 已验证核心数据集当前可用且官方文档完整，符合数据集与基准类核心材料和文档完整开放的 ${scores.complete.toFixed(1)} 分标准。`
                            : `[A_OPEN] 已验证代码仓库与模型权重当前可用，且官方仓库 README 完整覆盖安装、推理与微调文档，符合核心材料和文档完整开放的 ${scores.complete.toFixed(1)} 分标准。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        if (hasCompleteCoreRelease && hasPartialDocumentation && openSource.score < scores.incompleteDocs) {
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: scores.incompleteDocs,
                        reason: isDatasetPaper && isV2
                            ? `[A_OPEN] 已验证核心数据集当前可用且文档可访问但尚未完整覆盖全部使用说明，符合核心材料开放但文档不完整的 ${scores.incompleteDocs.toFixed(1)} 分标准。`
                            : `[A_OPEN] 已验证代码仓库与模型权重当前可用，且官方仓库 README 可访问但尚未覆盖全部安装、推理与微调文档，符合核心材料开放但文档不完整的 ${scores.incompleteDocs.toFixed(1)} 分标准。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        if (isDatasetPaper && isV2 && substantiveAvailableTypes.has('dataset') && openSource.score < scores.incompleteDocs && substantiveAvailableTypes.has('code')) {
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: scores.incompleteDocs,
                        reason: `[A_OPEN] 已验证数据集与配套代码当前可用，符合数据集与基准类核心材料开放的 ${scores.incompleteDocs.toFixed(1)} 分标准。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        if (isV2 && !hasCompleteCoreRelease && openSource.score > scores.partial) {
            const labels = { code: '代码', model: '模型权重', dataset: '数据集' };
            const available = ['code', 'model', 'dataset']
                .filter(type => substantiveAvailableTypes.has(type))
                .map(type => labels[type])
                .join('、');
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: scores.partial,
                        reason: `[A_OPEN] 当前仅核实${available}可用、尚未构成完整核心产物开放，按部分开放上限计 ${scores.partial.toFixed(1)} 分。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        if (isV2 && hasCompleteCoreRelease && !hasCompleteDocumentation && openSource.score > scores.incompleteDocs) {
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: scores.incompleteDocs,
                        reason: `[A_OPEN] 已核实核心产物可用，但尚未验证完整官方文档（安装/推理/微调或完整数据卡），按文档不完整上限计 ${scores.incompleteDocs.toFixed(1)} 分。`
                    }
                }
            };
            return applyScoringEvidenceCaps(recalculateScoringAudit(normalizedAudit));
        }
        const reasonText = String(openSource.reason || '');
        if (substantiveAvailableTypes.size > 0 && (
            openSource.score < scores.partial
            || reasonDeniesVerifiedAvailableResourceType(reasonText, substantiveAvailableTypes)
        )) {
            const labels = { code: '代码', model: '模型权重', dataset: '数据集' };
            const available = ['code', 'model', 'dataset']
                .filter(type => substantiveAvailableTypes.has(type))
                .map(type => labels[type])
                .join('、');
            const normalizedAudit = {
                ...audit,
                dimensions: {
                    ...audit.dimensions,
                    openSource: {
                        score: Math.max(scores.partial, openSource.score),
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
    }), allowedEvidenceIds, { rubricVersion: audit?.rubricVersion });
}

module.exports = {
    SCORING_DIMENSIONS,
    SCORING_DIMENSIONS_V2,
    getScoringDimensionsForRubric,
    TYPE_AWARE_EVIDENCE_GUIDES,
    getTypeAwareEvidenceGuide,
    AUDIT_TOP_LEVEL_KEYS,
    AUDIT_TOP_LEVEL_KEYS_V2,
    AUDIT_ITEM_KEYS,
    SCORING_EVIDENCE_PROFILE_KEYS,
    SCORING_EVIDENCE_PROFILE_KEYS_V2,
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

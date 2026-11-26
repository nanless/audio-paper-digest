'use strict';

/**
 * Shared Node.js engine for the unified type-aware scoring rubric.
 * Loads `config/scoring-rubric.json` and mirrors `scripts/scoring_rubric.py`
 * using exact integer thousandths arithmetic so JS and Python agree bit-for-bit.
 */

const fs = require('node:fs');
const path = require('node:path');

const SPEC_PATH = path.resolve(__dirname, '../../config/scoring-rubric.json');
const SPEC = Object.freeze(JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')));

const LEGACY_SCORING_RUBRIC = SPEC.legacyRubricVersion;
const CURRENT_SCORING_RUBRIC = SPEC.rubricVersion;
const HISTORICAL_UNIFIED_SCORING_RUBRICS = Object.freeze(['type-aware-v2']);
const UNIFIED_SCORING_RUBRIC_VERSIONS = Object.freeze([CURRENT_SCORING_RUBRIC, ...HISTORICAL_UNIFIED_SCORING_RUBRICS]);
const SUPPORTED_SCORING_RUBRIC_VERSIONS = Object.freeze([LEGACY_SCORING_RUBRIC, ...HISTORICAL_UNIFIED_SCORING_RUBRICS, CURRENT_SCORING_RUBRIC]);

const ALL_DIM_BY_KEY = new Map([
    ...SPEC.coreDimensions.map(item => [item.key, Object.freeze({ ...item, max: SPEC.scaleMax, isCore: true })]),
    [SPEC.openSourceDimension.key, Object.freeze({ ...SPEC.openSourceDimension, max: SPEC.scaleMax, isCore: false })]
]);

const UNIFIED_DIMENSIONS = Object.freeze(
    SPEC.dimensionDisplayOrder.map(key => ALL_DIM_BY_KEY.get(key))
);
const UNIFIED_CORE_DIMENSIONS = Object.freeze(SPEC.coreDimensions.map(item => ALL_DIM_BY_KEY.get(item.key)));
const UNIFIED_OPEN_SOURCE_ANCHORS = Object.freeze([...SPEC.openSourceDimension.anchors]);
const UNIFIED_OPEN_SOURCE_RELEASED_THRESHOLD = SPEC.openSourceDimension.releasedThreshold;
const UNIFIED_EVIDENCE_CAPS = Object.freeze({ ...SPEC.evidenceCaps });
const CALIBRATION_PROFILE = typeof SPEC.calibrationProfile === 'string' && SPEC.calibrationProfile.trim()
    ? SPEC.calibrationProfile.trim()
    : 'audio-rubric-calibration';
const CALIBRATION_ANCHORS = Object.freeze(
    Array.isArray(SPEC.calibrationAnchors)
        ? SPEC.calibrationAnchors.map(card => Object.freeze({
            ...card,
            keySignals: Object.freeze(Array.isArray(card.keySignals) ? [...card.keySignals] : [])
        }))
        : []
);
const DOMAIN_RED_LINES = Object.freeze(
    Array.isArray(SPEC.domainRedLines)
        ? SPEC.domainRedLines.map(item => Object.freeze({
            ...item,
            targetDimensions: Object.freeze(Array.isArray(item.targetDimensions) ? [...item.targetDimensions] : [])
        }))
        : []
);
const COMPACT_WEIGHT_LABELS = Object.freeze({
    innovation: '创新',
    technicalRigor: '严谨',
    experimentalSufficiency: '实验',
    clarity: '清晰',
    impact: '影响',
    reproducibility: '复现',
    engineering: '工程'
});
const UNIFIED_SCORE_DIMENSIONS_BY_PARSED_FIELD = Object.freeze(
    Object.fromEntries(UNIFIED_DIMENSIONS.map(item => [item.parsedField, Object.freeze({ label: item.label, max: item.max, shortLabel: item.shortLabel })]))
);

function isUnifiedRubric(version) {
    return UNIFIED_SCORING_RUBRIC_VERSIONS.includes(String(version || '').trim());
}

function isLegacyRubric(version) {
    return String(version || '').trim() === LEGACY_SCORING_RUBRIC;
}

function normalizeTenths(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return NaN;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return NaN;
        // Exact decimal HALF_UP parsing matching Python Decimal(str(value))
        const m = trimmed.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
        if (m) {
            const sign = m[1] === '-' ? -1 : 1;
            const intPart = Number(m[2]);
            const frac = m[3] || '';
            const first = frac.length >= 1 ? Number(frac[0]) : 0;
            const second = frac.length >= 2 ? Number(frac[1]) : 0;
            const absTenths = intPart * 10 + first + (second >= 5 ? 1 : 0);
            return (sign * absTenths) || 0;
        }
    }
    const num = Number(value);
    if (!Number.isFinite(num)) return NaN;
    // Exact string-decimal conversion avoids IEEE-754 ulp drift at >=2.0
    const canonical = num.toFixed(10);
    const m = canonical.match(/^(-?)(\d+)\.(\d)(\d)/);
    if (!m) return NaN;
    const sign = m[1] === '-' ? -1 : 1;
    const absTenths = Number(m[2]) * 10 + Number(m[3]) + (Number(m[4]) >= 5 ? 1 : 0);
    return (sign * absTenths) || 0;
}

function isOpenSourceAnchor(value) {
    const tenths = normalizeTenths(value);
    if (!Number.isFinite(tenths)) return false;
    return UNIFIED_OPEN_SOURCE_ANCHORS.some(anchor => Math.round(anchor * 10) === tenths);
}

function getDocumentTypePolicy(documentType) {
    const key = String(documentType || '').trim();
    const policy = Object.hasOwn(SPEC.documentTypes, key) ? SPEC.documentTypes[key] : null;
    if (!policy) {
        throw new Error(`${CURRENT_SCORING_RUBRIC} 不支持的文档类型: ${String(documentType || '')}`);
    }
    return policy;
}

function formatDocumentTypeWeightsSummary(documentType) {
    const key = String(documentType || '').trim();
    const policy = Object.hasOwn(SPEC.documentTypes, key) ? SPEC.documentTypes[key] : null;
    if (!policy) return '';
    const parts = UNIFIED_CORE_DIMENSIONS.map(dim => {
        const label = COMPACT_WEIGHT_LABELS[dim.key] || dim.shortLabel || dim.label;
        const pct = policy.coreWeightPct[dim.key];
        return `${label} ${pct}%`;
    });
    const bonus = (policy.openSourceMaxBonusTenths / 10).toFixed(1);
    return `${parts.join(' · ')}（开源上限加分 +${bonus}）`;
}

/**
 * Compute exact unified type-aware total score from dimension scores (accepting either
 * audit keys like `innovation`/`technicalRigor` or parsed keys like `innovationScore`).
 *
 * Uses exact integer thousandths arithmetic:
 * - coreScaled = sum(weightPct_d * round(score_d * 10)) in [0, 10000]
 * - bonusScaled = round(openSource * 10) * openSourceMaxBonusTenths in [0, 800]
 * - rawTotalScaled = coreScaled + bonusScaled (thousandths of a point)
 * - totalTenths = min(100, floor((rawTotalScaled + 50) / 100))  // HALF_UP to 0.1
 */
function calculateWeightedTotal(documentType, scoresMap) {
    const policy = getDocumentTypePolicy(documentType);
    const readDim = dim => {
        let raw;
        for (const k of [dim.key, dim.parsedField, dim.machineKey]) {
            const candidate = scoresMap?.[k];
            if (candidate !== undefined && candidate !== null && candidate !== '') {
                raw = typeof candidate === 'object' ? candidate.score : candidate;
                break;
            }
        }
        const tenths = normalizeTenths(raw);
        if (!Number.isFinite(tenths) || tenths < 0 || tenths > 100) {
            throw new Error(`${CURRENT_SCORING_RUBRIC} 维度 ${dim.key} 分数无效: ${String(raw)}`);
        }
        return tenths;
    };

    let coreScaled = 0;
    for (const dim of UNIFIED_CORE_DIMENSIONS) {
        const weightPct = policy.coreWeightPct[dim.key];
        coreScaled += weightPct * readDim(dim);
    }
    const openSourceTenths = readDim(ALL_DIM_BY_KEY.get('openSource'));
    const bonusTenths = policy.openSourceMaxBonusTenths;
    const bonusScaled = openSourceTenths * bonusTenths;
    const rawTotalScaled = coreScaled + bonusScaled;
    const totalTenths = Math.min(100, Math.floor((rawTotalScaled + 50) / 100));

    return {
        coreWeighted: Number((coreScaled / 1000).toFixed(3)),
        openSourceBonus: Number((bonusScaled / 1000).toFixed(3)),
        openSourceMaxBonus: bonusTenths / 10,
        rawTotal: Number((rawTotalScaled / 1000).toFixed(3)),
        total: totalTenths / 10,
        rankBucket: rankBucketForScore(totalTenths / 10)
    };
}

function rankBucketForScore(score) {
    const tenths = normalizeTenths(score);
    if (!Number.isFinite(tenths)) return '';
    for (const bucket of SPEC.rankBuckets) {
        if (tenths >= Math.round(bucket.minScore * 10)) {
            return bucket.label;
        }
    }
    return '后50%';
}

function rankBucketForRubric(score, rubricVersion = LEGACY_SCORING_RUBRIC) {
    if (isUnifiedRubric(rubricVersion)) return rankBucketForScore(score);
    const tenths = normalizeTenths(score);
    if (!Number.isFinite(tenths)) return '';
    if (tenths >= 90) return '前10%';
    if (tenths >= 75) return '前25%';
    if (tenths >= 55) return '前50%';
    return '后50%';
}

module.exports = {
    SPEC_PATH,
    SPEC,
    LEGACY_SCORING_RUBRIC,
    CURRENT_SCORING_RUBRIC,
    HISTORICAL_UNIFIED_SCORING_RUBRICS,
    UNIFIED_SCORING_RUBRIC_VERSIONS,
    SUPPORTED_SCORING_RUBRIC_VERSIONS,
    UNIFIED_DIMENSIONS,
    UNIFIED_CORE_DIMENSIONS,
    UNIFIED_OPEN_SOURCE_ANCHORS,
    UNIFIED_OPEN_SOURCE_RELEASED_THRESHOLD,
    UNIFIED_EVIDENCE_CAPS,
    CALIBRATION_PROFILE,
    CALIBRATION_ANCHORS,
    DOMAIN_RED_LINES,
    UNIFIED_SCORE_DIMENSIONS_BY_PARSED_FIELD,
    isUnifiedRubric,
    isLegacyRubric,
    normalizeTenths,
    isOpenSourceAnchor,
    getDocumentTypePolicy,
    formatDocumentTypeWeightsSummary,
    calculateWeightedTotal,
    rankBucketForScore,
    rankBucketForRubric
};

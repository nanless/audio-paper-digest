'use strict';

/**
 * The single public validation entry point for newly-authored Manual tutorials.
 *
 * The three underlying modules remain pure, independently testable validators:
 * - tutorial quality checks reader pedagogy and Markdown;
 * - tutorial artifacts checks deterministic source inventory coverage;
 * - research/longform checks evidence bindings and exact block replay.
 *
 * Preview, sealed v5 payloads and v6 ingestion call this orchestrator instead
 * of composing a slightly different subset of those validators themselves.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizedId } = require('./utils.js');
const {
    MANUAL_TUTORIAL_QUALITY_CONTRACT,
    validateManualTutorialQualityPacket
} = require('./manual-tutorial-quality-contract.js');
const {
    TUTORIAL_ARTIFACT_PLAN_VERSION,
    validateTutorialArtifactPlan
} = require('./manual-tutorial-artifacts.js');
const {
    MANUAL_RESEARCH_CONTRACT_VERSION,
    READER_FORMAT_CONTRACT_VERSION,
    validateReaderArticle
} = require('./manual-research-contract.js');
const {
    MANUAL_LONGFORM_CONTRACT_VERSION,
    MANUAL_LONGFORM_BUNDLE_VERSION,
    validateManualLongformBundle
} = require('./manual-longform-contract.js');

const MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT = 'manual-tutorial-validation-orchestrator-v1';
const TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT = 'manual-table-transcription-attestation-v1';
const DEFAULT_TABLE_ATTESTATION_ROOT = path.resolve(
    __dirname, '..', 'data', 'current', 'manual-tutorial-previews'
);
const SHA256_RE = /^[a-f0-9]{64}$/;
const SCORE_DIMENSIONS = Object.freeze([
    ['innovationScore', 2],
    ['technicalRigorScore', 1.5],
    ['experimentalSufficiencyScore', 1.5],
    ['clarityScore', 1],
    ['impactScore', 1.5],
    ['openSourceScore', 1.5],
    ['reproducibilityScore', 0.5],
    ['engineeringScore', 1.5]
]);
const PROTOCOL_DESCRIPTOR = Object.freeze({
    contract: MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    version: 1,
    tutorialQuality: MANUAL_TUTORIAL_QUALITY_CONTRACT,
    artifactPlanVersion: TUTORIAL_ARTIFACT_PLAN_VERSION,
    tableTranscriptionAttestation: TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT,
    readerPathOrdering: 'reader-tutorial-partial-order-v2',
    researcherFocus: MANUAL_RESEARCH_CONTRACT_VERSION,
    readerFormat: READER_FORMAT_CONTRACT_VERSION,
    readerLongform: MANUAL_LONGFORM_CONTRACT_VERSION,
    readerLongformBundleVersion: MANUAL_LONGFORM_BUNDLE_VERSION,
    scoringDimensions: SCORE_DIMENSIONS.map(([field, maximum]) => `${field}:${maximum}`)
});
const MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT = crypto
    .createHash('sha256')
    .update(JSON.stringify(PROTOCOL_DESCRIPTOR), 'utf8')
    .digest('hex');

function normalizeScore(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (value && typeof value === 'object' && Number.isFinite(value.total)) return value.total;
    return null;
}

function validateTutorialScorePresentation(qualityPacket, options = {}) {
    const presentation = qualityPacket?.presentation;
    if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
        if (options.required) throw new Error('qualityPacket.presentation 必须包含总分与八维分项');
        return null;
    }
    const breakdown = presentation.scoreBreakdown;
    if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
        throw new Error('qualityPacket.presentation.scoreBreakdown 必须包含八维分项');
    }
    let sum = 0;
    const normalized = {};
    for (const [field, maximum] of SCORE_DIMENSIONS) {
        const score = Number(breakdown[field]);
        if (!Number.isFinite(score) || score < 0 || score > maximum) {
            throw new Error(`qualityPacket.presentation.scoreBreakdown.${field} 缺失或越界（0-${maximum}）`);
        }
        normalized[field] = score;
        sum += score;
    }
    const total = normalizeScore(presentation.score);
    if (total === null || total < 0 || total > 10 || Math.abs(total - Math.min(10, sum)) > 0.05) {
        throw new Error(`qualityPacket.presentation 总分与八维分项不一致: total=${presentation.score}, dimensions=${sum.toFixed(1)}`);
    }
    return { total, dimensions: normalized };
}

function artifactPlanBindingSha256(plan) {
    return crypto.createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');
}

function fileSha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadTableTranscriptionAttestation(binding, paperId, articleFileSha256, allowedRoot) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
        || binding.contract !== TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT
        || !SHA256_RE.test(String(binding.sha256 || ''))) {
        throw new Error(`${paperId} quality.tableTranscriptionAttestation 缺少受控审查文件绑定`);
    }
    const root = path.resolve(allowedRoot || DEFAULT_TABLE_ATTESTATION_ROOT);
    const filePath = path.resolve(String(binding.path || ''));
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || !relative.split(path.sep).includes(paperId)
        || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()
        || fs.lstatSync(filePath).isSymbolicLink() || fileSha256(filePath) !== binding.sha256) {
        throw new Error(`${paperId} table transcription attestation 路径、文件或 SHA 非法`);
    }
    let attestation;
    try {
        attestation = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${paperId} table transcription attestation 不是 JSON: ${error.message}`);
    }
    const provenance = attestation?.provenance || {};
    if (attestation?.version !== 1 || attestation?.contract !== TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT
        || normalizedId(attestation.paperId) !== paperId || attestation.passed !== true
        || !Array.isArray(attestation.blockers) || attestation.blockers.length !== 0
        || attestation.articleSha256 !== articleFileSha256
        || provenance.model !== 'gpt-5.6-terra' || provenance.reasoningEffort !== 'high'
        || provenance.independentTask !== true || !String(provenance.taskName || '').trim()
        || !Array.isArray(attestation.tables)) {
        throw new Error(`${paperId} table transcription attestation 未通过或未绑定 Terra/high 独立审查`);
    }
    return { value: attestation, path: filePath };
}

function validateQualityArtifactPlanBinding(qualityPacket, artifactPlan, paperId, options = {}) {
    const binding = qualityPacket?.artifactPlan;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
        || binding.version !== TUTORIAL_ARTIFACT_PLAN_VERSION
        || normalizedId(binding.paperId) !== paperId
        || binding.sha256 !== artifactPlanBindingSha256(artifactPlan)) {
        throw new Error(`${paperId} quality.artifactPlan 未绑定当前确定性 artifact plan`);
    }
    const tableDispositions = new Map(
        (qualityPacket?.artifactDisposition?.tables || []).map(item => [item?.artifactId, item])
    );
    let attestation = null;
    for (const source of artifactPlan.tables || []) {
        const item = tableDispositions.get(source.id);
        const expected = source.disposition === 'appendix' ? 'appendix_full' : 'inline_full';
        if (!item || item.disposition !== expected) {
            throw new Error(`${paperId} quality 表格处置与 artifact plan 不一致: ${source.id}`);
        }
        if (item.fullTableMarkdown === source.renderedMarkdown) continue;
        attestation ||= loadTableTranscriptionAttestation(
            qualityPacket.tableTranscriptionAttestation,
            paperId,
            options.articleFileSha256,
            options.tableAttestationRoot
        );
        const reviewed = attestation.value.tables.find(entry => entry?.artifactId === source.id);
        if (!reviewed || reviewed.status !== 'passed' || reviewed.complete !== true
            || reviewed.sourceMatrixSha256 !== source.sourceMatrixSha256
            || reviewed.articleBlockSha256 !== crypto.createHash('sha256')
                .update(String(item.fullTableMarkdown || ''), 'utf8').digest('hex')) {
            throw new Error(`${paperId} quality 移动端表格转录未被独立逐表审查绑定: ${source.id}`);
        }
        if (Array.isArray(reviewed.blocks) && reviewed.blocks.length > 0) {
            if (!Array.isArray(item.tableBlocks) || item.tableBlocks.length !== reviewed.blocks.length
                || item.tableBlocks.join('') !== item.fullTableMarkdown) {
                throw new Error(`${paperId} quality 多块表格数量或合并顺序不匹配审查凭证: ${source.id}`);
            }
            for (let index = 0; index < reviewed.blocks.length; index++) {
                const expectedSha = reviewed.blocks[index]?.sha256;
                const actualSha = crypto.createHash('sha256')
                    .update(String(item.tableBlocks[index] || ''), 'utf8').digest('hex');
                if (!SHA256_RE.test(String(expectedSha || '')) || actualSha !== expectedSha) {
                    throw new Error(`${paperId} quality 多块表格 SHA 不匹配审查凭证: ${source.id}[${index}]`);
                }
            }
        } else if (item.tableBlocks !== undefined) {
            throw new Error(`${paperId} quality 单块表格不得伪装为多块转录: ${source.id}`);
        }
    }
    const figureDispositions = new Map(
        (qualityPacket?.artifactDisposition?.figures || []).map(item => [item?.artifactId, item])
    );
    for (const source of artifactPlan.figures || []) {
        const item = figureDispositions.get(source.id);
        const expected = source.eligible
            ? (source.disposition === 'appendix' ? 'appendix' : 'inline')
            : 'reject';
        if (!item || item.disposition !== expected) {
            throw new Error(`${paperId} quality 图片处置与 artifact plan 不一致: ${source.id}`);
        }
    }
}

function validateTutorialPayloadBundle(input) {
    const {
        paperId, article, qualityPacket, artifactPlan, artifactIndex,
        articleFileSha256, requireScorePresentation = true
    } = input || {};
    const id = normalizedId(paperId);
    if (!id) throw new Error('tutorial orchestrator.paperId 必须是规范 arXiv ID');
    if (normalizedId(qualityPacket?.paperId) !== id
        || normalizedId(artifactPlan?.paperId) !== id
        || normalizedId(artifactIndex?.paperId) !== id) {
        throw new Error(`${id} tutorial orchestrator 的 quality/plan/ArtifactIndex 必须保持单篇身份一致`);
    }
    validateTutorialArtifactPlan(artifactIndex, artifactPlan);
    validateQualityArtifactPlanBinding(qualityPacket, artifactPlan, id, {
        articleFileSha256,
        tableAttestationRoot: input?.tableAttestationRoot
    });
    const quality = validateManualTutorialQualityPacket(
        qualityPacket,
        article,
        artifactIndex,
        { articleFileSha256 }
    );
    const scoring = validateTutorialScorePresentation(qualityPacket, {
        required: requireScorePresentation
    });
    return {
        contract: MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
        fingerprint: MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
        paperId: id,
        quality,
        scoring,
        artifactCoverage: {
            tables: Array.isArray(artifactPlan.tables) ? artifactPlan.tables.length : 0,
            figures: Array.isArray(artifactPlan.figures) ? artifactPlan.figures.length : 0,
            formulas: Array.isArray(artifactPlan.formulas) ? artifactPlan.formulas.length : 0
        }
    };
}

function validateManualTutorialReaderBundle(plan, article, evidenceLedger = [], options = {}) {
    // Do not exercise the historical direct longform compatibility seam in
    // manual-research-contract; the orchestrator owns cross-validator order.
    const researchOptions = { ...options };
    delete researchOptions.longformBundle;
    delete researchOptions.artifactIndex;
    const readerArticle = validateReaderArticle(plan, article, evidenceLedger, researchOptions);
    if (options.longformBundle || options.artifactIndex) {
        if (!options.longformBundle || !options.artifactIndex) {
            throw new Error(`${options.label || 'readerArticle'} 的 longformBundle 与 artifactIndex 必须同时提供`);
        }
        validateManualLongformBundle(
            options.longformBundle,
            readerArticle,
            options.artifactIndex,
            {
                label: `${options.label || 'readerArticle'}.longformBundle`,
                paperId: options.paperId,
                documentType: options.documentType
            }
        );
    }
    // Preserve the historical return type used by spec/canonical assemblers;
    // the protocol identity is sealed separately in the v5 tutorial payload.
    return readerArticle;
}

function validateManualTutorialLongformBundle(bundle, article, artifactIndex, options = {}) {
    return {
        contract: MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
        fingerprint: MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
        validation: validateManualLongformBundle(bundle, article, artifactIndex, options)
    };
}

module.exports = {
    MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
    PROTOCOL_DESCRIPTOR,
    SCORE_DIMENSIONS,
    MANUAL_TUTORIAL_QUALITY_CONTRACT,
    validateTutorialScorePresentation,
    artifactPlanBindingSha256,
    validateQualityArtifactPlanBinding,
    loadTableTranscriptionAttestation,
    validateTutorialPayloadBundle,
    validateManualTutorialReaderBundle,
    validateManualTutorialLongformBundle
};

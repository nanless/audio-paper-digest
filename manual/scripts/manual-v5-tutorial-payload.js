'use strict';

/**
 * One sealed, file-backed tutorial payload for default Manual v5.
 *
 * The payload joins the cold-start article, the independent tutorial quality
 * packet and the deterministic ArtifactIndex projection.  Every consumer
 * reopens the two JSON files and the article/ArtifactIndex authorities before
 * trusting the receipt; copying a stale quality result beside a new article is
 * therefore insufficient.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizedId } = require('../../scripts/utils.js');
const {
    normalizeArticle,
    stableSha256,
    rawFileSha256
} = require('./manual-fresh-authoring-contract.js');
const {
    MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
    MANUAL_TUTORIAL_QUALITY_CONTRACT,
    validateTutorialPayloadBundle
} = require('./manual-tutorial-contract-orchestrator.js');

const MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT = 'manual-v5-tutorial-payload-v1';
const SHA256_RE = /^[a-f0-9]{64}$/;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPlainFile(filePath, label) {
    const resolved = path.resolve(String(filePath || ''));
    let stat;
    try {
        stat = fs.lstatSync(resolved);
    } catch (error) {
        throw new Error(`${label} 不存在或不可读: ${resolved}: ${error.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是真实普通文件且不得使用符号链接: ${resolved}`);
    }
    return resolved;
}

function assertExactPath(actual, expected, label) {
    const actualPath = path.resolve(String(actual || ''));
    const expectedPath = path.resolve(String(expected || ''));
    if (actualPath !== expectedPath) {
        throw new Error(`${label} 未绑定受控路径: expected=${expectedPath} actual=${actualPath}`);
    }
    return assertPlainFile(actualPath, label);
}

function readJsonFile(filePath, label) {
    const resolved = assertPlainFile(filePath, label);
    let value;
    try {
        value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 顶层必须是对象`);
    }
    return { path: resolved, value, fileSha256: rawFileSha256(resolved, label) };
}

function defaultTutorialPayloadPaths(currentRoot, date, paperId) {
    const id = normalizedId(paperId);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
        throw new Error('tutorial payload path 缺少合法日期或 arXiv ID');
    }
    const root = path.join(
        path.resolve(currentRoot), 'manual-tutorial-previews', String(date), id
    );
    return {
        qualityPath: path.join(root, 'quality.json'),
        artifactPlanPath: path.join(root, 'artifact-plan.json')
    };
}

function artifactPlanBindingSha256(plan) {
    return sha256(Buffer.from(JSON.stringify(plan), 'utf8'));
}

function assertFreshQualityBinding(qualityFresh, freshReceipt, paperId) {
    if (!qualityFresh || !freshReceipt) throw new Error(`${paperId} tutorial payload 缺少 fresh authoring 绑定`);
    const qualitySubset = {
        contract: qualityFresh.contract,
        mode: qualityFresh.mode,
        authoringSessionId: String(qualityFresh.authoringSessionId || '').trim(),
        articleSha256: qualityFresh.articleSha256,
        articleFileSha256: qualityFresh.articleFileSha256,
        prohibitedProseInputs: qualityFresh.prohibitedProseInputs,
        inputs: qualityFresh.inputs
    };
    const receiptSubset = {
        contract: freshReceipt.contract,
        mode: freshReceipt.mode,
        authoringSessionId: String(freshReceipt.authoringSessionId || '').trim(),
        articleSha256: freshReceipt.articleSha256,
        articleFileSha256: freshReceipt.articleFileSha256,
        prohibitedProseInputs: freshReceipt.prohibitedProseInputs,
        inputs: freshReceipt.inputs
    };
    if (stableSha256(qualitySubset) !== stableSha256(receiptSubset)) {
        throw new Error(`${paperId} quality.freshAuthoring 与同一 sealed payload 的 fresh receipt 不一致`);
    }
}

function normalizeReceiptPayload(value) {
    const result = { ...value };
    delete result.receiptSha256;
    return result;
}

function validateTutorialPayloadReceipt(receipt, options) {
    const id = normalizedId(options.paperId);
    if (!id || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || receipt.contract !== MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT) {
        throw new Error(`${id || options.paperId}.tutorialPayload 必须声明 ${MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT}`);
    }
    const expectedPaths = defaultTutorialPayloadPaths(options.currentRoot, options.date, id);
    const qualityPath = assertExactPath(
        receipt.qualityPath, options.qualityPath || expectedPaths.qualityPath,
        `${id}.tutorialPayload.qualityPath`
    );
    const artifactPlanPath = assertExactPath(
        receipt.artifactPlanPath, options.artifactPlanPath || expectedPaths.artifactPlanPath,
        `${id}.tutorialPayload.artifactPlanPath`
    );
    const qualityFile = readJsonFile(qualityPath, `${id} tutorial quality packet`);
    const planFile = readJsonFile(artifactPlanPath, `${id} tutorial artifact plan`);
    const artifactIndex = options.artifactIndex;
    if (!artifactIndex || artifactIndex.inventoryHealth?.status !== 'complete') {
        throw new Error(`${id} tutorial payload 只能绑定 inventoryHealth=complete 的 ArtifactIndex`);
    }
    const article = normalizeArticle(options.article);
    const orchestrated = validateTutorialPayloadBundle({
        paperId: id,
        article,
        qualityPacket: qualityFile.value,
        artifactPlan: planFile.value,
        artifactIndex,
        articleFileSha256: options.articleFileSha256,
        requireScorePresentation: true
    });
    const validation = orchestrated.quality;
    assertFreshQualityBinding(qualityFile.value.freshAuthoring, options.freshAuthoring, id);
    const normalized = {
        contract: MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
        orchestratorContract: MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
        orchestratorFingerprint: MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
        qualityContract: MANUAL_TUTORIAL_QUALITY_CONTRACT,
        paperId: id,
        articleSha256: options.freshAuthoring.articleSha256,
        freshAuthoringReceiptSha256: options.freshAuthoring.receiptSha256,
        artifactIndexSha256: String(
            artifactIndex.outputSha256 || artifactIndex.artifactIndexSha256 || ''
        ),
        qualityPath,
        qualityFileSha256: qualityFile.fileSha256,
        qualityPacketSha256: stableSha256(qualityFile.value),
        artifactPlanPath,
        artifactPlanFileSha256: planFile.fileSha256,
        artifactPlanSha256: stableSha256(planFile.value),
        artifactPlanBindingSha256: artifactPlanBindingSha256(planFile.value),
        validation
    };
    if (!SHA256_RE.test(normalized.artifactIndexSha256)) {
        throw new Error(`${id} tutorial payload 缺少 ArtifactIndex SHA`);
    }
    normalized.receiptSha256 = stableSha256(normalized);
    for (const [field, expected] of Object.entries(normalized)) {
        if (receipt[field] !== undefined && stableSha256(receipt[field]) !== stableSha256(expected)) {
            throw new Error(`${id}.tutorialPayload.${field} 与重放结果不一致`);
        }
    }
    if (receipt.receiptSha256 !== undefined
        && receipt.receiptSha256 !== stableSha256(normalizeReceiptPayload(receipt))) {
        throw new Error(`${id}.tutorialPayload.receiptSha256 未封印提交内容`);
    }
    return normalized;
}

module.exports = {
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
    defaultTutorialPayloadPaths,
    artifactPlanBindingSha256,
    validateTutorialPayloadReceipt
};

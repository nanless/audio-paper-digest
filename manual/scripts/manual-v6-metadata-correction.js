#!/usr/bin/env node
'use strict';

/**
 * Explicit, single-paper metadata correction protocol for production v6.
 *
 * This is deliberately not a normalizer.  A Terra/high leaf must author a
 * correction and receipt.  The batch manifest then binds the original
 * revision output/payload bytes, the correction bytes, and a sorted Merkle
 * root before the records sealer may apply the three permitted fields.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('../../scripts/env-loader.js').requireExternalRuntime('manual-v6-metadata-correction.js');
}
const Config = require('../../scripts/config.js');
const {
    ALLOWED_TAGS, DOCUMENT_TYPES, normalizedId, writeFileAtomic, getBeijingISOString
} = require('../../scripts/utils.js');
const { validateRecord, RECORDS_VERSION } = require('./create-manual-analysis-spec.js');
const { stableSignatureSha256 } = require('./manual-signature-contract.js');
const { withFileLockSync } = require('../../scripts/analysis-engine.js');

const CORRECTION_PACKET_CONTRACT = 'manual-v6-metadata-correction-packet-v1';
const CORRECTION_OUTPUT_CONTRACT = 'manual-v6-metadata-correction-output-v1';
const CORRECTION_RECEIPT_CONTRACT = 'manual-v6-metadata-correction-receipt-v1';
const CORRECTION_MANIFEST_CONTRACT = 'manual-v6-metadata-correction-manifest-v1';
const CORRECTION_MERKLE_CONTRACT = 'manual-v6-metadata-correction-merkle-v1';
const CORRECTION_PROOF_CONTRACT = 'manual-v6-metadata-correction-proof-v1';
const CORRECTION_ROLE = 'metadata_correction';
const CORRECTION_STATE_VERSION = 1;
const CORRECTION_STATE_MODE = 'manual_v6_metadata_correction_runner';
const CORRECTION_ACTIVE_LIMIT = 3;
const MUTABLE_FIELDS = Object.freeze(['/tags', '/task', '/type']);
const SHA_RE = /^[a-f0-9]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;

function stableSha256(value) {
    return stableSignatureSha256(value, 'manual-v6-metadata-correction');
}

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value;
}

function assertSha(value, label) {
    if (!SHA_RE.test(String(value || ''))) throw new Error(`${label} 必须是 SHA-256`);
    return value;
}

function assertExactKeys(value, keys, label) {
    const actual = Object.keys(assertObject(value, label)).sort();
    const expected = [...keys].sort();
    if (stableSha256(actual) !== stableSha256(expected)) {
        throw new Error(`${label} 字段必须精确为 ${expected.join(', ')}`);
    }
}

function readOrdinaryFile(filePath, label, rootPath = null) {
    const declared = path.resolve(filePath);
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的普通文件且不得为 symlink`);
    }
    const realPath = fs.realpathSync(declared);
    if (rootPath) {
        const root = fs.realpathSync(path.resolve(rootPath));
        const relative = path.relative(root, realPath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
            || path.isAbsolute(relative)) {
            throw new Error(`${label} 经 realpath 逃逸受控根目录`);
        }
    }
    return { path: realPath, bytes: fs.readFileSync(realPath) };
}

function readJsonFile(filePath, label, rootPath = null) {
    const file = readOrdinaryFile(filePath, label, rootPath);
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    assertObject(value, label);
    return { ...file, value, fileSha256: sha256Bytes(file.bytes), semanticSha256: stableSha256(value) };
}

function safeRelative(rootPath, filePath, label) {
    const root = fs.realpathSync(path.resolve(rootPath));
    const file = readOrdinaryFile(filePath, label, root);
    return path.relative(root, file.path).replace(/\\/g, '/');
}

function validateExactMetadataFields(record, label = 'record') {
    assertObject(record, label);
    if (!DOCUMENT_TYPES.includes(record.type)) {
        throw new Error(`${label}.type 必须精确使用受控文档类型: ${DOCUMENT_TYPES.join('/')}`);
    }
    if (typeof record.task !== 'string' || !/^#[^\s#]+$/u.test(record.task)
        || !ALLOWED_TAGS.has(record.task)) {
        throw new Error(`${label}.task 必须是单个 ALLOWED_TAGS #标签`);
    }
    if (typeof record.tags !== 'string') {
        throw new Error(`${label}.tags 必须是 3-5 个空格分隔标签，数组不允许`);
    }
    const tags = record.tags.split(/\s+/u).filter(Boolean);
    if (tags.length < 3 || tags.length > 5 || new Set(tags).size !== tags.length
        || tags.some(tag => !/^#[^\s#]+$/u.test(tag) || !ALLOWED_TAGS.has(tag))
        || !tags.includes(record.task) || tags.join(' ') !== record.tags) {
        throw new Error(`${label}.tags 必须是规范空格分隔的 3-5 个不重复白名单标签并包含 task`);
    }
    return { type: record.type, task: record.task, tags: record.tags };
}

function needsMetadataCorrection(payload) {
    try {
        validateExactMetadataFields(payload, 'revision record payload');
        return false;
    } catch (_error) {
        return true;
    }
}

function applyMetadataCorrection(payload, correction) {
    const candidate = structuredClone(payload);
    candidate.type = correction.changes.type;
    candidate.task = correction.changes.task;
    candidate.tags = correction.changes.tags;
    return candidate;
}

function packetSemantic(packet) {
    const value = structuredClone(packet);
    delete value.packetSha256;
    return value;
}

function manifestSemantic(manifest) {
    const value = structuredClone(manifest);
    delete value.manifestSha256;
    return value;
}

function validatePacket(packet, options = {}) {
    const value = assertObject(packet, 'metadata correction packet');
    assertExactKeys(value, [
        'version', 'contract', 'date', 'paperId', 'role', 'singlePaperOnly',
        'isolatedContext', 'mutableFields', 'allowedDocumentTypes', 'allowedTags',
        'revisionOutput', 'recordPayload', 'packetSha256'
    ], 'metadata correction packet');
    if (value.version !== 1 || value.contract !== CORRECTION_PACKET_CONTRACT
        || value.role !== CORRECTION_ROLE || value.singlePaperOnly !== true
        || value.isolatedContext !== true || value.date !== options.date
        || normalizedId(value.paperId) !== options.paperId || value.paperId !== options.paperId) {
        throw new Error('metadata correction packet 身份或隔离契约非法');
    }
    if (stableSha256(value.allowedDocumentTypes) !== stableSha256([...DOCUMENT_TYPES])
        || stableSha256(value.allowedTags) !== stableSha256([...ALLOWED_TAGS].sort())
        || stableSha256(value.mutableFields) !== stableSha256([...MUTABLE_FIELDS])) {
        throw new Error('metadata correction packet 的白名单或可变字段契约漂移');
    }
    for (const [field, ref] of Object.entries({
        revisionOutput: value.revisionOutput,
        recordPayload: value.recordPayload
    })) {
        assertObject(ref, `metadata correction packet.${field}`);
        if (typeof ref.path !== 'string' || !ref.path || path.posix.isAbsolute(ref.path)
            || ref.path.split('/').includes('..')) {
            throw new Error(`metadata correction packet.${field}.path 非法`);
        }
        assertSha(ref.fileSha256, `metadata correction packet.${field}.fileSha256`);
        assertSha(ref.semanticSha256, `metadata correction packet.${field}.semanticSha256`);
    }
    if (value.packetSha256 !== stableSha256(packetSemantic(value))) {
        throw new Error('metadata correction packet.packetSha256 不闭环');
    }
    if (options.dateRoot) {
        const output = readJsonFile(
            path.join(options.dateRoot, value.revisionOutput.path),
            'metadata correction packet revision output', options.dateRoot
        );
        const payload = readJsonFile(
            path.join(options.dateRoot, value.recordPayload.path),
            'metadata correction packet record payload', options.dateRoot
        );
        for (const [label, actual, ref] of [
            ['revision output', output, value.revisionOutput],
            ['record payload', payload, value.recordPayload]
        ]) {
            if (actual.fileSha256 !== ref.fileSha256 || actual.semanticSha256 !== ref.semanticSha256) {
                throw new Error(`metadata correction packet 绑定的 ${label} 已漂移`);
            }
        }
        if (output.value.version !== 2
            || output.value.contract !== 'manual-v6-author-revision-output-v2'
            || output.value.paperId !== options.paperId
            || output.value.recordPayload?.fileSha256 !== payload.fileSha256
            || output.value.recordPayload?.semanticSha256 !== payload.semanticSha256) {
            throw new Error('metadata correction packet 未绑定当前 production revision closure');
        }
    }
    return value;
}

function validateCorrection(correction, packet, payload, options = {}) {
    const value = assertObject(correction, 'metadata correction output');
    assertExactKeys(value, [
        'version', 'contract', 'date', 'paperId', 'role', 'taskName', 'passed',
        'singlePaperOnly', 'isolatedContext', 'model', 'reasoningEffort',
        'packetSha256', 'originalRecordPayload', 'changes', 'changedFields', 'rationale'
    ], 'metadata correction output');
    if (value.version !== 1 || value.contract !== CORRECTION_OUTPUT_CONTRACT
        || value.role !== CORRECTION_ROLE || value.date !== packet.date
        || value.paperId !== packet.paperId || value.packetSha256 !== packet.packetSha256
        || value.singlePaperOnly !== true || value.isolatedContext !== true
        || value.model !== 'gpt-5.6-terra' || value.reasoningEffort !== 'high'
        || value.passed !== true || typeof value.taskName !== 'string'
        || value.taskName.trim().length < 4 || typeof value.rationale !== 'string'
        || value.rationale.trim().length < 20) {
        throw new Error('metadata correction output 身份、Terra-high provenance 或说明非法');
    }
    assertExactKeys(value.changes, ['type', 'task', 'tags'], 'metadata correction output.changes');
    validateExactMetadataFields(value.changes, 'metadata correction output.changes');
    const original = assertObject(value.originalRecordPayload, 'metadata correction output.originalRecordPayload');
    assertExactKeys(original, ['fileSha256', 'semanticSha256'], 'metadata correction output.originalRecordPayload');
    if (original.fileSha256 !== packet.recordPayload.fileSha256
        || original.semanticSha256 !== packet.recordPayload.semanticSha256) {
        throw new Error('metadata correction output 未绑定 packet 的原 revision payload');
    }
    const changedFields = MUTABLE_FIELDS.filter(pointer => {
        const field = pointer.slice(1);
        return payload[field] !== value.changes[field];
    });
    if (changedFields.length === 0) throw new Error('metadata correction output 没有实际字段变化');
    if (stableSha256(value.changedFields) !== stableSha256(changedFields)) {
        throw new Error('metadata correction output.changedFields 必须精确列出实际 /type /task /tags delta');
    }
    const candidate = applyMetadataCorrection(payload, value);
    validateExactMetadataFields(candidate, 'metadata correction candidate');
    if (options.fullPreflight !== false) {
        try {
            validateRecord(candidate, packet.paperId, `metadata correction candidate ${packet.paperId}`, {
                recordsVersion: RECORDS_VERSION
            });
        } catch (error) {
            throw new Error(`metadata correction 不是纯三字段可修复记录: ${error.message}`);
        }
    }
    return value;
}

function validateReceipt(receipt, packet, correction, options = {}) {
    const value = assertObject(receipt, 'metadata correction receipt');
    assertExactKeys(value, [
        'version', 'contract', 'date', 'paperId', 'role', 'taskName',
        'singlePaperOnly', 'isolatedContext', 'model', 'reasoningEffort',
        'consumedPacketSha256', 'correctionSha256', 'queuedAt', 'startedAt',
        'completedAt', 'revision'
    ], 'metadata correction receipt');
    if (value.version !== 1 || value.contract !== CORRECTION_RECEIPT_CONTRACT
        || value.role !== CORRECTION_ROLE || value.date !== packet.date
        || value.paperId !== packet.paperId || value.taskName !== correction.taskName
        || value.singlePaperOnly !== true || value.isolatedContext !== true
        || value.model !== 'gpt-5.6-terra' || value.reasoningEffort !== 'high'
        || value.consumedPacketSha256 !== packet.packetSha256
        || value.correctionSha256 !== stableSha256(correction)
        || !Number.isInteger(value.revision) || value.revision < 1) {
        throw new Error('metadata correction receipt 身份、provenance 或 SHA 绑定非法');
    }
    for (const field of ['queuedAt', 'startedAt', 'completedAt']) {
        if (!TIMESTAMP_RE.test(String(value[field] || ''))) {
            throw new Error(`metadata correction receipt.${field} 必须是北京时间戳`);
        }
    }
    if (Date.parse(value.queuedAt) > Date.parse(value.startedAt)
        || Date.parse(value.startedAt) > Date.parse(value.completedAt)) {
        throw new Error('metadata correction receipt 时间顺序非法');
    }
    if (options.queuedAt !== undefined && value.queuedAt !== options.queuedAt) {
        throw new Error('metadata correction receipt.queuedAt 未绑定 persistent task state');
    }
    if (options.startedAt !== undefined && value.startedAt !== options.startedAt) {
        throw new Error('metadata correction receipt.startedAt 未绑定 persistent task state');
    }
    if (options.taskName !== undefined && value.taskName !== options.taskName) {
        throw new Error('metadata correction receipt.taskName 未绑定 persistent task state');
    }
    return value;
}

function correctionPaths(date, paperId, currentDir = Config.CURRENT_DIR) {
    const dateRoot = path.resolve(currentDir, 'manual-v6', date);
    const artifactRoot = path.join(dateRoot, 'task-runner', 'tasks', paperId);
    const correctionRoot = path.join(artifactRoot, 'metadata-correction');
    return {
        dateRoot, artifactRoot, correctionRoot,
        packetPath: path.join(correctionRoot, 'packet.json'),
        correctionPath: path.join(correctionRoot, 'correction.json'),
        receiptPath: path.join(correctionRoot, 'receipt.json'),
        stateRoot: path.join(dateRoot, 'metadata-corrections'),
        statePath: path.join(dateRoot, 'metadata-corrections', 'state.json'),
        manifestPath: path.join(dateRoot, 'metadata-corrections-manifest.json')
    };
}

function runnerStatePath(date, currentDir) {
    return path.join(path.resolve(currentDir), 'manual-v6', date, 'task-runner', 'state.json');
}

function emptyCorrectionTask() {
    return {
        status: 'awaiting_packet', packetPath: null, packetSha256: null,
        packetFileSha256: null, claimId: null, taskName: null,
        queuedAt: null, startedAt: null, completedAt: null, attempt: 0,
        outputPath: null, outputFileSha256: null, outputSemanticSha256: null,
        receiptPath: null, receiptFileSha256: null, receiptSemanticSha256: null,
        error: null
    };
}

function correctionActiveCount(state) {
    return state.requiredPaperIds
        .map(paperId => state.tasks[paperId])
        .filter(task => ['claimed', 'running'].includes(task.status)).length;
}

function currentCorrectionSets(date, currentDir = Config.CURRENT_DIR) {
    const production = readJsonFile(runnerStatePath(date, currentDir), 'production v6 runner state').value;
    const expectedPaperIds = [...production.expectedPaperIds].sort();
    const requiredPaperIds = [];
    const pendingProductionPaperIds = [];
    for (const paperId of expectedPaperIds) {
        if (production.papers?.[paperId]?.tasks?.author_revision?.status !== 'validated') {
            pendingProductionPaperIds.push(paperId);
            continue;
        }
        const binding = loadRevisionBinding(date, paperId, currentDir);
        if (needsMetadataCorrection(binding.payload.value)) requiredPaperIds.push(paperId);
    }
    return { expectedPaperIds, requiredPaperIds, pendingProductionPaperIds };
}

function initializeCorrectionState(date, currentDir = Config.CURRENT_DIR, now = getBeijingISOString()) {
    if (!TIMESTAMP_RE.test(String(now || ''))) throw new Error('metadata correction createdAt 必须是北京时间');
    const { expectedPaperIds, requiredPaperIds, pendingProductionPaperIds } =
        currentCorrectionSets(date, currentDir);
    return {
        version: CORRECTION_STATE_VERSION,
        mode: CORRECTION_STATE_MODE,
        date,
        generation: 0,
        createdAt: now,
        updatedAt: now,
        activeLimit: CORRECTION_ACTIVE_LIMIT,
        expectedPaperIds,
        requiredPaperIds,
        pendingProductionPaperIds,
        taskNames: {},
        tasks: Object.fromEntries(requiredPaperIds.map(paperId => [paperId, emptyCorrectionTask()]))
    };
}

function validateCorrectionState(state) {
    const value = assertObject(state, 'metadata correction state');
    if (value.version !== CORRECTION_STATE_VERSION || value.mode !== CORRECTION_STATE_MODE
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.date || ''))
        || !Number.isInteger(value.generation) || value.generation < 0
        || value.activeLimit !== CORRECTION_ACTIVE_LIMIT
        || !TIMESTAMP_RE.test(String(value.createdAt || ''))
        || !TIMESTAMP_RE.test(String(value.updatedAt || ''))
        || !Array.isArray(value.expectedPaperIds) || !Array.isArray(value.requiredPaperIds)
        || !Array.isArray(value.pendingProductionPaperIds)
        || !value.tasks || typeof value.tasks !== 'object' || Array.isArray(value.tasks)
        || !value.taskNames || typeof value.taskNames !== 'object' || Array.isArray(value.taskNames)) {
        throw new Error('metadata correction state header 非法');
    }
    for (const [label, ids] of [
        ['expectedPaperIds', value.expectedPaperIds], ['requiredPaperIds', value.requiredPaperIds],
        ['pendingProductionPaperIds', value.pendingProductionPaperIds]
    ]) {
        if (new Set(ids).size !== ids.length || ids.some(id => normalizedId(id) !== id)
            || stableSha256(ids) !== stableSha256([...ids].sort())) {
            throw new Error(`metadata correction state.${label} 必须是有序、唯一规范 ID`);
        }
    }
    if (value.requiredPaperIds.some(id => !value.expectedPaperIds.includes(id))
        || value.pendingProductionPaperIds.some(id => !value.expectedPaperIds.includes(id))
        || value.pendingProductionPaperIds.some(id => value.requiredPaperIds.includes(id))
        || stableSha256(Object.keys(value.tasks).sort()) !== stableSha256(value.requiredPaperIds)) {
        throw new Error('metadata correction state required/task 集合不闭环');
    }
    const seenTaskNames = new Set();
    for (const paperId of value.requiredPaperIds) {
        const task = assertObject(value.tasks[paperId], `metadata correction state.tasks.${paperId}`);
        if (!['awaiting_packet', 'pending', 'claimed', 'running', 'validated', 'failed', 'stale'].includes(task.status)
            || !Number.isInteger(task.attempt) || task.attempt < 0) {
            throw new Error(`${paperId} metadata correction task 状态或 attempt 非法`);
        }
        for (const field of ['packetSha256', 'packetFileSha256', 'outputFileSha256',
            'outputSemanticSha256', 'receiptFileSha256', 'receiptSemanticSha256']) {
            if (task[field] !== null && !SHA_RE.test(String(task[field] || ''))) {
                throw new Error(`${paperId} metadata correction task.${field} 非法`);
            }
        }
        if (task.status !== 'awaiting_packet'
            && (!task.packetPath || !task.packetSha256 || !task.packetFileSha256)) {
            throw new Error(`${paperId} metadata correction task packet 字段不闭环`);
        }
        if (['claimed', 'running'].includes(task.status)
            && (!task.claimId || !TIMESTAMP_RE.test(String(task.queuedAt || '')))) {
            throw new Error(`${paperId} metadata correction active claim 字段不完整`);
        }
        if (['running', 'validated'].includes(task.status)
            && (!task.taskName || !TIMESTAMP_RE.test(String(task.startedAt || '')))) {
            throw new Error(`${paperId} metadata correction start 字段不完整`);
        }
        if (task.startedAt && (!task.queuedAt || Date.parse(task.startedAt) < Date.parse(task.queuedAt))) {
            throw new Error(`${paperId} metadata correction startedAt 早于 queuedAt`);
        }
        if (task.status === 'validated'
            && (!TIMESTAMP_RE.test(String(task.completedAt || '')) || !task.outputPath
                || !task.outputFileSha256 || !task.outputSemanticSha256 || !task.receiptPath
                || !task.receiptFileSha256 || !task.receiptSemanticSha256)) {
            throw new Error(`${paperId} metadata correction validated 工件不闭环`);
        }
        if (task.completedAt && task.startedAt
            && Date.parse(task.completedAt) < Date.parse(task.startedAt)) {
            throw new Error(`${paperId} metadata correction completedAt 早于 startedAt`);
        }
        if (task.taskName) {
            if (seenTaskNames.has(task.taskName)) throw new Error(`metadata correction taskName 重复: ${task.taskName}`);
            seenTaskNames.add(task.taskName);
            const owner = value.taskNames[task.taskName];
            if (!owner || owner.paperId !== paperId || owner.claimId !== task.claimId
                || typeof owner.retired !== 'boolean') {
                throw new Error(`metadata correction taskName owner 不闭环: ${task.taskName}`);
            }
            if (!owner.retired && task.status === 'failed') {
                throw new Error(`metadata correction failed taskName 必须退休: ${task.taskName}`);
            }
        }
    }
    if (correctionActiveCount(value) > CORRECTION_ACTIVE_LIMIT) {
        throw new Error(`metadata correction 活动任务超过 ${CORRECTION_ACTIVE_LIMIT} 槽`);
    }
    for (const [taskName, owner] of Object.entries(value.taskNames)) {
        if (taskName.trim().length < 4 || !owner
            || typeof owner.claimId !== 'string' || typeof owner.retired !== 'boolean'
            || (!owner.retired && !value.tasks[owner.paperId])) {
            throw new Error(`metadata correction state.taskNames.${taskName} 非法`);
        }
        if (!owner.retired && value.tasks[owner.paperId]?.taskName !== taskName) {
            throw new Error(`metadata correction active taskName owner 不闭环: ${taskName}`);
        }
    }
    return value;
}

function loadRevisionBinding(date, paperId, currentDir = Config.CURRENT_DIR) {
    const paths = correctionPaths(date, paperId, currentDir);
    const statePath = runnerStatePath(date, currentDir);
    const state = readJsonFile(statePath, 'production v6 runner state').value;
    if (!state.expectedPaperIds?.includes(paperId)) throw new Error(`${paperId} 不在 production runner 集合`);
    const task = state.papers?.[paperId]?.tasks?.author_revision;
    if (task?.status !== 'validated') throw new Error(`${paperId}.author_revision 尚未 validated`);
    const revision = readJsonFile(task.outputPath, `${paperId}.revision output`, paths.dateRoot);
    if (revision.fileSha256 !== task.outputFileSha256
        || revision.semanticSha256 !== task.outputSemanticSha256) {
        throw new Error(`${paperId}.revision output 已偏离 runner validated state`);
    }
    const payloadPath = path.join(paths.artifactRoot, revision.value.recordPayload?.path || '');
    const payload = readJsonFile(payloadPath, `${paperId}.revision record payload`, paths.artifactRoot);
    if (payload.fileSha256 !== revision.value.recordPayload?.fileSha256
        || payload.semanticSha256 !== revision.value.recordPayload?.semanticSha256
        || normalizedId(payload.value.paperId || payload.value.arxivId) !== paperId) {
        throw new Error(`${paperId}.revision record payload 绑定非法`);
    }
    return { paths, state, task, revision, payload };
}

function createPacketArtifact(options = {}) {
    const { date, paperId, currentDir = Config.CURRENT_DIR, force = false } = options;
    const binding = loadRevisionBinding(date, paperId, currentDir);
    if (!needsMetadataCorrection(binding.payload.value)) {
        throw new Error(`${paperId} 的 revision payload 已使用合法 metadata，不得创建 orphan correction`);
    }
    const packet = {
        version: 1,
        contract: CORRECTION_PACKET_CONTRACT,
        date,
        paperId,
        role: CORRECTION_ROLE,
        singlePaperOnly: true,
        isolatedContext: true,
        mutableFields: [...MUTABLE_FIELDS],
        allowedDocumentTypes: [...DOCUMENT_TYPES],
        allowedTags: [...ALLOWED_TAGS].sort(),
        revisionOutput: {
            path: safeRelative(binding.paths.dateRoot, binding.revision.path, `${paperId}.revision output`),
            fileSha256: binding.revision.fileSha256,
            semanticSha256: binding.revision.semanticSha256
        },
        recordPayload: {
            path: safeRelative(binding.paths.dateRoot, binding.payload.path, `${paperId}.record payload`),
            fileSha256: binding.payload.fileSha256,
            semanticSha256: binding.payload.semanticSha256
        }
    };
    packet.packetSha256 = stableSha256(packetSemantic(packet));
    validatePacket(packet, { date, paperId, dateRoot: binding.paths.dateRoot });
    const bytes = Buffer.from(`${JSON.stringify(packet, null, 2)}\n`, 'utf8');
    const artifactRootStat = fs.lstatSync(binding.paths.artifactRoot, { throwIfNoEntry: false });
    if (!artifactRootStat?.isDirectory() || artifactRootStat.isSymbolicLink()) {
        throw new Error('metadata correction artifactRoot 必须是存在的真实目录且不得为 symlink');
    }
    const artifactRootReal = fs.realpathSync(binding.paths.artifactRoot);
    const correctionRootStat = fs.lstatSync(binding.paths.correctionRoot, { throwIfNoEntry: false });
    if (correctionRootStat && (!correctionRootStat.isDirectory() || correctionRootStat.isSymbolicLink())) {
        throw new Error('metadata correction 受控目录类型非法或使用 symlink');
    }
    fs.mkdirSync(binding.paths.correctionRoot, { recursive: true });
    const correctionRootReal = fs.realpathSync(binding.paths.correctionRoot);
    const correctionRelative = path.relative(artifactRootReal, correctionRootReal);
    if (!correctionRelative || correctionRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(correctionRelative)) {
        throw new Error('metadata correction 受控目录经 realpath 逃逸单篇 artifactRoot');
    }
    const existing = fs.lstatSync(binding.paths.packetPath, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw new Error('metadata correction packet 目标类型非法');
    }
    if (existing && !fs.readFileSync(binding.paths.packetPath).equals(bytes) && !force) {
        throw new Error('metadata correction packet 已存在且输入变化；显式 --force 后才可替换');
    }
    if (!existing || !fs.readFileSync(binding.paths.packetPath).equals(bytes)) {
        writeFileAtomic(binding.paths.packetPath, bytes);
    }
    return { ...binding.paths, packet, cacheHit: Boolean(existing && fs.readFileSync(binding.paths.packetPath).equals(bytes)) };
}

function stateRelativePath(dateRoot, filePath, label) {
    return safeRelative(dateRoot, filePath, label);
}

function readCorrectionState(date, currentDir = Config.CURRENT_DIR) {
    const paths = correctionPaths(date, '2608.00000', currentDir);
    const file = readJsonFile(paths.statePath, 'metadata correction persistent state', paths.dateRoot);
    return { paths, file, state: validateCorrectionState(file.value) };
}

function reconcileCorrectionState(state, date, currentDir = Config.CURRENT_DIR) {
    validateCorrectionState(state);
    const snapshot = currentCorrectionSets(date, currentDir);
    if (stableSha256(snapshot.expectedPaperIds) !== stableSha256(state.expectedPaperIds)) {
        throw new Error('metadata correction state 与 production runner paper set 漂移');
    }
    const nextRequired = new Set(snapshot.requiredPaperIds);
    for (const paperId of state.requiredPaperIds) {
        if (nextRequired.has(paperId)) continue;
        retireCurrentTaskName(state, paperId);
        delete state.tasks[paperId];
    }
    for (const paperId of snapshot.requiredPaperIds) {
        if (!state.tasks[paperId]) state.tasks[paperId] = emptyCorrectionTask();
    }
    state.requiredPaperIds = [...snapshot.requiredPaperIds];
    state.pendingProductionPaperIds = [...snapshot.pendingProductionPaperIds];
    validateCorrectionState(state);
    return state;
}

function verifyCorrectionState(state, date, currentDir = Config.CURRENT_DIR, options = {}) {
    validateCorrectionState(state);
    if (state.date !== date) throw new Error('metadata correction state 日期漂移');
    const snapshot = currentCorrectionSets(date, currentDir);
    const expectedPaperIds = snapshot.expectedPaperIds;
    if (stableSha256(expectedPaperIds) !== stableSha256(state.expectedPaperIds)) {
        throw new Error('metadata correction state 与 production runner paper set 漂移');
    }
    if (stableSha256(snapshot.requiredPaperIds) !== stableSha256(state.requiredPaperIds)
        || stableSha256(snapshot.pendingProductionPaperIds)
            !== stableSha256(state.pendingProductionPaperIds)) {
        throw new Error('metadata correction state 与当前 revision correction set 漂移');
    }
    const dateRoot = correctionPaths(date, '2608.00000', currentDir).dateRoot;
    for (const paperId of state.requiredPaperIds) {
        const task = state.tasks[paperId];
        if (!task.packetPath || options.ignorePacketPaperId === paperId) continue;
        const expectedPaths = correctionPaths(date, paperId, currentDir);
        const packetPath = path.join(dateRoot, task.packetPath);
        if (path.resolve(packetPath) !== path.resolve(expectedPaths.packetPath)) {
            throw new Error(`${paperId} metadata correction state packet 路径不是受控固定路径`);
        }
        const packetFile = readJsonFile(packetPath, `${paperId}.metadata packet`, expectedPaths.artifactRoot);
        const packet = validatePacket(packetFile.value, { date, paperId, dateRoot });
        if (packetFile.fileSha256 !== task.packetFileSha256 || packet.packetSha256 !== task.packetSha256) {
            throw new Error(`${paperId} metadata correction packet 已偏离 persistent state`);
        }
        if (task.status !== 'validated') continue;
        const correctionPath = path.join(dateRoot, task.outputPath);
        const receiptPath = path.join(dateRoot, task.receiptPath);
        if (path.resolve(correctionPath) !== path.resolve(expectedPaths.correctionPath)
            || path.resolve(receiptPath) !== path.resolve(expectedPaths.receiptPath)) {
            throw new Error(`${paperId} metadata correction output/receipt 不是受控固定路径`);
        }
        const binding = loadRevisionBinding(date, paperId, currentDir);
        const correctionFile = readJsonFile(correctionPath, `${paperId}.metadata correction`, expectedPaths.artifactRoot);
        const receiptFile = readJsonFile(receiptPath, `${paperId}.metadata receipt`, expectedPaths.artifactRoot);
        const correction = validateCorrection(correctionFile.value, packet, binding.payload.value, {
            fullPreflight: options.fullPreflight !== false
        });
        validateReceipt(receiptFile.value, packet, correction, {
            queuedAt: task.queuedAt, startedAt: task.startedAt, taskName: task.taskName
        });
        if (correction.taskName !== task.taskName
            || correctionFile.fileSha256 !== task.outputFileSha256
            || correctionFile.semanticSha256 !== task.outputSemanticSha256
            || receiptFile.fileSha256 !== task.receiptFileSha256
            || receiptFile.semanticSha256 !== task.receiptSemanticSha256
            || receiptFile.value.completedAt !== task.completedAt) {
            throw new Error(`${paperId} metadata correction validated output/receipt 已漂移`);
        }
    }
    return state;
}

function retireCurrentTaskName(state, paperId) {
    const task = state.tasks[paperId];
    if (task.taskName && state.taskNames[task.taskName]) {
        state.taskNames[task.taskName] = { ...state.taskNames[task.taskName], retired: true };
    }
}

function resetCorrectionTask(state, paperId, status = 'pending', error = null) {
    const task = state.tasks[paperId];
    retireCurrentTaskName(state, paperId);
    Object.assign(task, {
        status, claimId: null, taskName: null, queuedAt: null, startedAt: null,
        completedAt: null, outputPath: null, outputFileSha256: null,
        outputSemanticSha256: null, receiptPath: null, receiptFileSha256: null,
        receiptSemanticSha256: null, error
    });
    return task;
}

function registerCorrectionPacket(state, date, paperId, currentDir = Config.CURRENT_DIR) {
    validateCorrectionState(state);
    if (!state.tasks[paperId]) throw new Error(`${paperId} 不在 metadata correction required 集合`);
    const paths = correctionPaths(date, paperId, currentDir);
    const packetFile = readJsonFile(paths.packetPath, `${paperId}.metadata packet`, paths.artifactRoot);
    const packet = validatePacket(packetFile.value, { date, paperId, dateRoot: paths.dateRoot });
    const task = state.tasks[paperId];
    const relativePath = stateRelativePath(paths.dateRoot, packetFile.path, `${paperId}.metadata packet`);
    if (task.packetFileSha256 === packetFile.fileSha256 && task.packetSha256 === packet.packetSha256) {
        if (task.status === 'awaiting_packet') task.status = 'pending';
        return task;
    }
    if (['claimed', 'running'].includes(task.status)) {
        throw new Error(`${paperId} metadata correction 活动任务不可替换 packet；先 abandon/retry`);
    }
    resetCorrectionTask(state, paperId, 'pending', null);
    Object.assign(task, {
        packetPath: relativePath,
        packetSha256: packet.packetSha256,
        packetFileSha256: packetFile.fileSha256
    });
    return task;
}

function claimCorrectionTasks(state, options = {}) {
    validateCorrectionState(state);
    const limit = options.limit ?? CORRECTION_ACTIVE_LIMIT;
    const now = options.now || getBeijingISOString();
    const selectedPaperId = options.paperId ? normalizedId(options.paperId) : null;
    if (!Number.isInteger(limit) || limit < 1 || limit > CORRECTION_ACTIVE_LIMIT) {
        throw new Error(`metadata correction claim limit 必须是 1-${CORRECTION_ACTIVE_LIMIT}`);
    }
    if (!TIMESTAMP_RE.test(String(now || ''))) throw new Error('metadata correction queuedAt 必须是北京时间');
    if (selectedPaperId && !state.tasks[selectedPaperId]) throw new Error('metadata correction claim 论文不在 required 集合');
    const capacity = Math.max(0, CORRECTION_ACTIVE_LIMIT - correctionActiveCount(state));
    const candidates = state.requiredPaperIds
        .filter(paperId => (!selectedPaperId || paperId === selectedPaperId)
            && state.tasks[paperId].status === 'pending');
    const claimed = candidates.slice(0, Math.min(limit, capacity)).map(paperId => {
        const task = state.tasks[paperId];
        task.status = 'claimed';
        task.claimId = crypto.randomUUID();
        task.queuedAt = now;
        task.attempt += 1;
        task.error = null;
        return {
            paperId, claimId: task.claimId, queuedAt: now,
            packetPath: task.packetPath, packetSha256: task.packetSha256
        };
    });
    return { claimed, active: correctionActiveCount(state), capacity: CORRECTION_ACTIVE_LIMIT };
}

function findCorrectionClaim(state, claimId) {
    for (const paperId of state.requiredPaperIds) {
        const task = state.tasks[paperId];
        if (task.claimId === claimId) return { paperId, task };
    }
    throw new Error(`未知 metadata correction claimId: ${claimId}`);
}

function startCorrectionTask(state, claimId, taskName, now = getBeijingISOString()) {
    const { paperId, task } = findCorrectionClaim(state, claimId);
    if (task.status !== 'claimed') throw new Error('只有 claimed metadata correction 可 start');
    if (typeof taskName !== 'string' || taskName.trim().length < 4 || state.taskNames[taskName]) {
        throw new Error('metadata correction taskName 非法、重复或历史已退休，不可复用');
    }
    if (!TIMESTAMP_RE.test(String(now || '')) || Date.parse(now) < Date.parse(task.queuedAt)) {
        throw new Error('metadata correction startedAt 必须是 queuedAt 之后的真实北京时间');
    }
    task.status = 'running';
    task.taskName = taskName;
    task.startedAt = now;
    state.taskNames[taskName] = { paperId, claimId, retired: false };
    return {
        paperId, claimId, taskName, queuedAt: task.queuedAt, startedAt: task.startedAt,
        packetPath: task.packetPath, packetSha256: task.packetSha256
    };
}

function submitCorrectionTask(state, claimId, date, currentDir = Config.CURRENT_DIR, options = {}) {
    const { paperId, task } = findCorrectionClaim(state, claimId);
    if (task.status !== 'running') throw new Error('只有 running metadata correction 可 submit');
    const binding = loadRevisionBinding(date, paperId, currentDir);
    const paths = binding.paths;
    const packetFile = readJsonFile(paths.packetPath, `${paperId}.metadata packet`, paths.artifactRoot);
    const packet = validatePacket(packetFile.value, { date, paperId, dateRoot: paths.dateRoot });
    if (packetFile.fileSha256 !== task.packetFileSha256 || packet.packetSha256 !== task.packetSha256) {
        throw new Error(`${paperId} metadata correction submit packet 已漂移`);
    }
    const correctionFile = readJsonFile(paths.correctionPath, `${paperId}.metadata correction`, paths.artifactRoot);
    const receiptFile = readJsonFile(paths.receiptPath, `${paperId}.metadata receipt`, paths.artifactRoot);
    const correction = validateCorrection(correctionFile.value, packet, binding.payload.value, {
        fullPreflight: options.fullPreflight !== false
    });
    const receipt = validateReceipt(receiptFile.value, packet, correction, {
        queuedAt: task.queuedAt, startedAt: task.startedAt, taskName: task.taskName
    });
    if (correction.taskName !== task.taskName) {
        throw new Error('metadata correction output.taskName 未绑定 persistent task state');
    }
    Object.assign(task, {
        status: 'validated',
        outputPath: stateRelativePath(paths.dateRoot, correctionFile.path, `${paperId}.metadata correction`),
        outputFileSha256: correctionFile.fileSha256,
        outputSemanticSha256: correctionFile.semanticSha256,
        receiptPath: stateRelativePath(paths.dateRoot, receiptFile.path, `${paperId}.metadata receipt`),
        receiptFileSha256: receiptFile.fileSha256,
        receiptSemanticSha256: receiptFile.semanticSha256,
        completedAt: receipt.completedAt,
        error: null
    });
    return {
        paperId, status: task.status, outputFileSha256: task.outputFileSha256,
        outputSemanticSha256: task.outputSemanticSha256,
        receiptFileSha256: task.receiptFileSha256,
        receiptSemanticSha256: task.receiptSemanticSha256
    };
}

function abandonCorrectionTask(state, claimId, reason, now = getBeijingISOString()) {
    const { paperId, task } = findCorrectionClaim(state, claimId);
    if (!['claimed', 'running'].includes(task.status)) throw new Error('只有活动 metadata correction claim 可 abandon');
    const explanation = String(reason || '').trim();
    if (explanation.length < 8) throw new Error('metadata correction abandon 原因至少 8 字符');
    if (!TIMESTAMP_RE.test(String(now || ''))) throw new Error('metadata correction abandon 时间必须是北京时间');
    retireCurrentTaskName(state, paperId);
    task.status = 'failed';
    task.completedAt = now;
    task.error = explanation;
    return { paperId, status: task.status };
}

function retryCorrectionTask(state, paperIdValue) {
    const paperId = normalizedId(paperIdValue);
    const task = state.tasks[paperId];
    if (!task) throw new Error('metadata correction retry 论文不在 required 集合');
    if (!['failed', 'validated', 'stale'].includes(task.status)) {
        throw new Error('只有 failed/validated/stale metadata correction 可 retry');
    }
    resetCorrectionTask(state, paperId, 'pending', null);
    return { paperId, status: task.status };
}

function correctionStateSummary(state, manifestPath = null) {
    validateCorrectionState(state);
    const tasks = state.requiredPaperIds.map(paperId => ({ paperId, ...state.tasks[paperId] }));
    const manifestPresent = manifestPath && fs.existsSync(manifestPath);
    return {
        version: state.version,
        mode: state.mode,
        date: state.date,
        activeLimit: CORRECTION_ACTIVE_LIMIT,
        active: correctionActiveCount(state),
        expectedPaperIds: state.expectedPaperIds,
        requiredPaperIds: state.requiredPaperIds,
        pendingProductionPaperIds: state.pendingProductionPaperIds,
        allRequiredValidated: state.pendingProductionPaperIds.length === 0
            && tasks.every(task => task.status === 'validated'),
        manifestStatus: manifestPresent ? 'present_pending_validation' : 'awaiting_manifest',
        counts: Object.fromEntries([...new Set(tasks.map(task => task.status))]
            .map(status => [status, tasks.filter(task => task.status === status).length])),
        tasks
    };
}

function updateCorrectionState(date, currentDir, callback, options = {}) {
    const paths = correctionPaths(date, '2608.00000', currentDir);
    fs.mkdirSync(paths.stateRoot, { recursive: true });
    return withFileLockSync(paths.statePath, () => {
        const existing = fs.lstatSync(paths.statePath, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
            throw new Error('metadata correction state 目标类型非法');
        }
        const state = existing
            ? validateCorrectionState(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')))
            : initializeCorrectionState(date, currentDir);
        reconcileCorrectionState(state, date, currentDir);
        verifyCorrectionState(state, date, currentDir, options.verifyOptions || {});
        const result = callback(state, paths);
        state.generation += 1;
        state.updatedAt = getBeijingISOString();
        validateCorrectionState(state);
        verifyCorrectionState(state, date, currentDir);
        writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
        return { state, result, paths };
    }, { timeoutMs: 0 });
}

function reconcilePersistedCorrectionState(date, currentDir = Config.CURRENT_DIR) {
    const paths = correctionPaths(date, '2608.00000', currentDir);
    return withFileLockSync(paths.statePath, () => {
        const item = readJsonFile(paths.statePath, 'metadata correction persistent state', paths.dateRoot);
        const state = validateCorrectionState(item.value);
        const before = stableSha256(state);
        reconcileCorrectionState(state, date, currentDir);
        verifyCorrectionState(state, date, currentDir);
        if (stableSha256(state) !== before) {
            state.generation += 1;
            state.updatedAt = getBeijingISOString();
            writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
        }
        return { paths, state };
    }, { timeoutMs: 0 });
}

function createPacket(options = {}) {
    const { date, paperId, currentDir = Config.CURRENT_DIR } = options;
    const updated = updateCorrectionState(date, currentDir, state => {
        const item = createPacketArtifact(options);
        registerCorrectionPacket(state, date, paperId, currentDir);
        return item;
    }, { verifyOptions: { ignorePacketPaperId: paperId } });
    return { ...updated.result, state: updated.state };
}

function registerExistingPacket(options = {}) {
    const { date, paperId, currentDir = Config.CURRENT_DIR } = options;
    return updateCorrectionState(date, currentDir, state =>
        registerCorrectionPacket(state, date, paperId, currentDir),
    { verifyOptions: { ignorePacketPaperId: paperId } });
}

function loadValidatedCorrection(date, paperId, currentDir = Config.CURRENT_DIR, options = {}) {
    const binding = loadRevisionBinding(date, paperId, currentDir);
    const packetFile = readJsonFile(binding.paths.packetPath, `${paperId}.metadata packet`, binding.paths.artifactRoot);
    const packet = validatePacket(packetFile.value, { date, paperId, dateRoot: binding.paths.dateRoot });
    const correctionFile = readJsonFile(
        binding.paths.correctionPath, `${paperId}.metadata correction`, binding.paths.artifactRoot
    );
    const receiptFile = readJsonFile(
        binding.paths.receiptPath, `${paperId}.metadata correction receipt`, binding.paths.artifactRoot
    );
    const correction = validateCorrection(
        correctionFile.value, packet, binding.payload.value,
        { fullPreflight: options.fullPreflight !== false }
    );
    const receipt = validateReceipt(receiptFile.value, packet, correction);
    return { ...binding, packetFile, packet, correctionFile, correction, receiptFile, receipt };
}

function correctionLeaf(item, dateRoot) {
    const ref = (file, semanticSha256) => ({
        path: safeRelative(dateRoot, file.path, `${item.payload.value.paperId}.correction artifact`),
        fileSha256: file.fileSha256,
        semanticSha256
    });
    return {
        paperId: item.payload.value.paperId,
        originalRevisionOutput: {
            fileSha256: item.revision.fileSha256,
            semanticSha256: item.revision.semanticSha256
        },
        originalRecordPayload: {
            fileSha256: item.payload.fileSha256,
            semanticSha256: item.payload.semanticSha256
        },
        packet: ref(item.packetFile, item.packet.packetSha256),
        correction: ref(item.correctionFile, stableSha256(item.correction)),
        receipt: ref(item.receiptFile, stableSha256(item.receipt)),
        changedFields: [...item.correction.changedFields]
    };
}

function buildManifest(options = {}) {
    const { date, currentDir = Config.CURRENT_DIR } = options;
    const correctionState = readCorrectionState(date, currentDir);
    verifyCorrectionState(correctionState.state, date, currentDir);
    const expectedIds = [...correctionState.state.expectedPaperIds];
    if (correctionState.state.pendingProductionPaperIds.length) {
        throw new Error(`metadata correction manifest 等待 production author_revision validated: ${correctionState.state.pendingProductionPaperIds.join(', ')}`);
    }
    const pending = correctionState.state.requiredPaperIds
        .filter(paperId => correctionState.state.tasks[paperId].status !== 'validated');
    if (pending.length) {
        throw new Error(`metadata correction manifest 拒绝未 validated 必需任务: ${pending.join(', ')}`);
    }
    const corrections = [];
    for (const paperId of expectedIds) {
        const binding = loadRevisionBinding(date, paperId, currentDir);
        if (!needsMetadataCorrection(binding.payload.value)) {
            const orphan = correctionPaths(date, paperId, currentDir).correctionRoot;
            if (fs.existsSync(orphan)) {
                throw new Error(`${paperId} metadata 已合法但存在 orphan correction 目录`);
            }
            continue;
        }
        corrections.push(loadValidatedCorrection(date, paperId, currentDir));
    }
    const dateRoot = path.resolve(currentDir, 'manual-v6', date);
    const leaves = corrections.map(item => correctionLeaf(item, dateRoot)).sort((a, b) => a.paperId.localeCompare(b.paperId));
    const manifest = {
        version: 1,
        contract: CORRECTION_MANIFEST_CONTRACT,
        date,
        expectedPaperIds: expectedIds,
        correctedPaperIds: leaves.map(item => item.paperId),
        corrections: leaves,
        correctionTaskState: {
            path: stateRelativePath(dateRoot, correctionState.file.path, 'metadata correction state'),
            fileSha256: correctionState.file.fileSha256,
            semanticSha256: correctionState.file.semanticSha256,
            generation: correctionState.state.generation
        },
        merkleRoot: stableSha256({
            contract: CORRECTION_MERKLE_CONTRACT,
            orderedLeaves: leaves.map(item => stableSha256(item))
        })
    };
    manifest.manifestSha256 = stableSha256(manifestSemantic(manifest));
    return manifest;
}

function writeManifest(options = {}) {
    const { date, currentDir = Config.CURRENT_DIR, force = false } = options;
    const paths = correctionPaths(date, '2608.00000', currentDir);
    const dateRootStat = fs.lstatSync(paths.dateRoot, { throwIfNoEntry: false });
    if (!dateRootStat?.isDirectory() || dateRootStat.isSymbolicLink()) {
        throw new Error('metadata correction production 日期根必须是真实目录且不得为 symlink');
    }
    return withFileLockSync(paths.statePath, () => {
        const stateFile = readJsonFile(paths.statePath, 'metadata correction persistent state', paths.dateRoot);
        const state = validateCorrectionState(stateFile.value);
        const before = stableSha256(state);
        reconcileCorrectionState(state, date, currentDir);
        verifyCorrectionState(state, date, currentDir);
        if (stableSha256(state) !== before) {
            state.generation += 1;
            state.updatedAt = getBeijingISOString();
            writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
        }
        const manifest = buildManifest({ date, currentDir });
        const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const existing = fs.lstatSync(paths.manifestPath, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
            throw new Error('metadata corrections manifest 目标类型非法');
        }
        if (existing && !fs.readFileSync(paths.manifestPath).equals(bytes) && !force) {
            throw new Error('metadata corrections manifest 已存在且闭包变化；显式 --force 后才可替换');
        }
        if (!existing || !fs.readFileSync(paths.manifestPath).equals(bytes)) {
            writeFileAtomic(paths.manifestPath, bytes);
        }
        return { manifestPath: paths.manifestPath, manifest, fileSha256: sha256Bytes(bytes) };
    }, { timeoutMs: 0 });
}

function validateManifestObject(manifest, options = {}) {
    const value = assertObject(manifest, 'metadata correction manifest');
    if (value.version !== 1 || value.contract !== CORRECTION_MANIFEST_CONTRACT
        || value.date !== options.date || !Array.isArray(value.expectedPaperIds)
        || !Array.isArray(value.correctedPaperIds) || !Array.isArray(value.corrections)
        || !value.correctionTaskState || typeof value.correctionTaskState !== 'object'
        || Array.isArray(value.correctionTaskState)) {
        throw new Error('metadata correction manifest header 非法');
    }
    assertExactKeys(value.correctionTaskState,
        ['path', 'fileSha256', 'semanticSha256', 'generation'],
        'metadata correction manifest.correctionTaskState');
    if (value.correctionTaskState.path !== 'metadata-corrections/state.json'
        || !SHA_RE.test(String(value.correctionTaskState.fileSha256 || ''))
        || !SHA_RE.test(String(value.correctionTaskState.semanticSha256 || ''))
        || !Number.isInteger(value.correctionTaskState.generation)
        || value.correctionTaskState.generation < 1) {
        throw new Error('metadata correction manifest.correctionTaskState 非法');
    }
    const expectedIds = [...options.expectedPaperIds].sort();
    if (stableSha256(value.expectedPaperIds) !== stableSha256(expectedIds)
        || stableSha256(value.correctedPaperIds) !== stableSha256([...value.correctedPaperIds].sort())
        || new Set(value.correctedPaperIds).size !== value.correctedPaperIds.length
        || stableSha256(value.correctedPaperIds) !== stableSha256(value.corrections.map(item => item.paperId))) {
        throw new Error('metadata correction manifest 论文集合、顺序或去重非法');
    }
    const leaves = value.corrections.map((leaf, index) => {
        assertObject(leaf, `metadata correction manifest.corrections[${index}]`);
        if (normalizedId(leaf.paperId) !== leaf.paperId) throw new Error('metadata correction manifest paperId 非法');
        for (const field of ['originalRevisionOutput', 'originalRecordPayload', 'packet', 'correction', 'receipt']) {
            assertObject(leaf[field], `metadata correction manifest.${leaf.paperId}.${field}`);
            if (field.startsWith('original')) {
                assertSha(leaf[field].fileSha256, `${leaf.paperId}.${field}.fileSha256`);
                assertSha(leaf[field].semanticSha256, `${leaf.paperId}.${field}.semanticSha256`);
            } else {
                if (typeof leaf[field].path !== 'string' || !leaf[field].path) throw new Error(`${leaf.paperId}.${field}.path 非法`);
                assertSha(leaf[field].fileSha256, `${leaf.paperId}.${field}.fileSha256`);
                assertSha(leaf[field].semanticSha256, `${leaf.paperId}.${field}.semanticSha256`);
            }
        }
        if (!Array.isArray(leaf.changedFields)
            || leaf.changedFields.some(field => !MUTABLE_FIELDS.includes(field))) {
            throw new Error(`${leaf.paperId}.changedFields 超出 /type /task /tags`);
        }
        return leaf;
    });
    const merkleRoot = stableSha256({
        contract: CORRECTION_MERKLE_CONTRACT,
        orderedLeaves: leaves.map(item => stableSha256(item))
    });
    if (value.merkleRoot !== merkleRoot || value.manifestSha256 !== stableSha256(manifestSemantic(value))) {
        throw new Error('metadata correction manifest Merkle 或语义 SHA 不闭环');
    }
    return value;
}

function loadValidatedManifest(manifestPath, options = {}) {
    const dateRoot = fs.realpathSync(path.resolve(options.dateRoot || path.dirname(manifestPath)));
    const manifestFile = readJsonFile(manifestPath, 'metadata correction manifest', dateRoot);
    const manifest = validateManifestObject(manifestFile.value, options);
    const stateFile = readJsonFile(
        path.join(dateRoot, manifest.correctionTaskState.path),
        'metadata correction manifest persistent state', dateRoot
    );
    const state = validateCorrectionState(stateFile.value);
    if (stateFile.fileSha256 !== manifest.correctionTaskState.fileSha256
        || stateFile.semanticSha256 !== manifest.correctionTaskState.semanticSha256
        || state.generation !== manifest.correctionTaskState.generation
        || stableSha256(state.expectedPaperIds) !== stableSha256(manifest.expectedPaperIds)
        || stableSha256(state.requiredPaperIds) !== stableSha256(manifest.correctedPaperIds)
        || state.requiredPaperIds.some(paperId => state.tasks[paperId].status !== 'validated')) {
        throw new Error('metadata correction manifest 未绑定当前全 validated persistent state');
    }
    const currentDir = path.dirname(path.dirname(dateRoot));
    verifyCorrectionState(state, options.date, currentDir);
    const byPaper = {};
    const occupied = new Set();
    for (const leaf of manifest.corrections) {
        const files = {};
        for (const field of ['packet', 'correction', 'receipt']) {
            const file = readJsonFile(path.join(dateRoot, leaf[field].path), `${leaf.paperId}.${field}`, dateRoot);
            if (occupied.has(file.path)) throw new Error('metadata correction manifest 工件路径被多个引用复用');
            occupied.add(file.path);
            if (file.fileSha256 !== leaf[field].fileSha256
                || (field === 'packet' ? file.value.packetSha256 : file.semanticSha256) !== leaf[field].semanticSha256) {
                throw new Error(`${leaf.paperId}.${field} 已偏离 metadata correction manifest`);
            }
            files[field] = file;
        }
        const packet = validatePacket(files.packet.value, {
            date: options.date, paperId: leaf.paperId, dateRoot
        });
        const payloadFile = readJsonFile(
            path.join(dateRoot, packet.recordPayload.path), `${leaf.paperId}.original payload`, dateRoot
        );
        const revisionFile = readJsonFile(
            path.join(dateRoot, packet.revisionOutput.path), `${leaf.paperId}.original revision`, dateRoot
        );
        if (payloadFile.fileSha256 !== leaf.originalRecordPayload.fileSha256
            || payloadFile.semanticSha256 !== leaf.originalRecordPayload.semanticSha256
            || revisionFile.fileSha256 !== leaf.originalRevisionOutput.fileSha256
            || revisionFile.semanticSha256 !== leaf.originalRevisionOutput.semanticSha256) {
            throw new Error(`${leaf.paperId} 原 revision/payload 已偏离 correction manifest`);
        }
        if (!needsMetadataCorrection(payloadFile.value)) {
            throw new Error(`${leaf.paperId} metadata correction 是已合法 revision payload 的 orphan`);
        }
        const correction = validateCorrection(files.correction.value, packet, payloadFile.value, { fullPreflight: true });
        const receipt = validateReceipt(files.receipt.value, packet, correction);
        if (stableSha256(correction) !== leaf.correction.semanticSha256
            || stableSha256(receipt) !== leaf.receipt.semanticSha256
            || stableSha256(correction.changedFields) !== stableSha256(leaf.changedFields)) {
            throw new Error(`${leaf.paperId} correction leaf 语义绑定漂移`);
        }
        byPaper[leaf.paperId] = {
            leaf, packet, correction, receipt,
            packetFile: files.packet, correctionFile: files.correction, receiptFile: files.receipt,
            originalPayload: payloadFile.value,
            manifestSha256: manifest.manifestSha256,
            manifestFileSha256: manifestFile.fileSha256,
            merkleRoot: manifest.merkleRoot
        };
    }
    return { manifest, manifestFile, byPaper };
}

function buildCorrectionProof(context) {
    return {
        version: 1,
        contract: CORRECTION_PROOF_CONTRACT,
        manifestSha256: context.manifestSha256,
        manifestFileSha256: context.manifestFileSha256,
        merkleRoot: context.merkleRoot,
        packetSha256: context.packet.packetSha256,
        correctionSha256: stableSha256(context.correction),
        receiptSha256: stableSha256(context.receipt),
        originalRecordPayloadFileSha256: context.leaf.originalRecordPayload.fileSha256,
        originalRecordPayloadSemanticSha256: context.leaf.originalRecordPayload.semanticSha256,
        changedFields: [...context.correction.changedFields]
    };
}

function parseArgs(argv) {
    const options = { force: false };
    const seen = new Set();
    const action = argv[0];
    if (!['packet', 'register', 'claim', 'start', 'submit', 'retry', 'abandon', 'manifest', 'status'].includes(action)) {
        throw new Error('首个参数必须是 packet|register|claim|start|submit|retry|abandon|manifest|status');
    }
    options.action = action;
    for (let index = 1; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--force') {
            if (options.force) throw new Error('--force 重复');
            options.force = true;
            continue;
        }
        if (!['--date', '--paper', '--claim', '--task-name', '--limit', '--reason'].includes(arg)) {
            throw new Error(`未知参数: ${arg}`);
        }
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        const key = ({
            '--date': 'date', '--paper': 'paperId', '--claim': 'claimId',
            '--task-name': 'taskName', '--limit': 'limit', '--reason': 'reason'
        })[arg];
        if (seen.has(key)) throw new Error(`${arg} 重复`);
        seen.add(key);
        options[key] = key === 'limit' ? Number(value) : value;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.date || ''))) throw new Error('--date 非法');
    if (options.paperId !== undefined) {
        options.paperId = normalizedId(options.paperId);
        if (!options.paperId) throw new Error('--paper 非法');
    }
    const required = {
        packet: ['paperId'], register: ['paperId'], start: ['claimId', 'taskName'],
        submit: ['claimId'], retry: ['paperId'], abandon: ['claimId', 'reason']
    }[action] || [];
    const missing = required.filter(key => options[key] === undefined);
    if (missing.length) throw new Error(`${action} 缺少参数: ${missing.join(', ')}`);
    if (!['packet', 'register', 'claim', 'retry'].includes(action) && options.paperId !== undefined) {
        throw new Error(`${action} 不接受 --paper`);
    }
    if (action !== 'claim' && options.limit !== undefined) throw new Error(`${action} 不接受 --limit`);
    if (!['start', 'submit', 'abandon'].includes(action) && options.claimId !== undefined) {
        throw new Error(`${action} 不接受 --claim`);
    }
    if (action !== 'start' && options.taskName !== undefined) throw new Error(`${action} 不接受 --task-name`);
    if (action !== 'abandon' && options.reason !== undefined) throw new Error(`${action} 不接受 --reason`);
    if (action === 'claim') options.limit ??= CORRECTION_ACTIVE_LIMIT;
    if (options.limit !== undefined
        && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > CORRECTION_ACTIVE_LIMIT)) {
        throw new Error(`--limit 必须是 1-${CORRECTION_ACTIVE_LIMIT}`);
    }
    if (options.force && !['packet', 'manifest'].includes(action)) throw new Error(`${action} 不接受 --force`);
    return options;
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const options = parseArgs(argv);
    const currentDir = overrides.currentDir || Config.CURRENT_DIR;
    let result;
    if (options.action === 'packet') {
        result = createPacket({ ...options, currentDir });
        result = { action: options.action, packetPath: result.packetPath, packetSha256: result.packet.packetSha256 };
    } else if (options.action === 'register') {
        const item = registerExistingPacket({ ...options, currentDir });
        result = { action: options.action, paperId: options.paperId, status: item.state.tasks[options.paperId].status };
    } else if (options.action === 'claim') {
        const item = updateCorrectionState(options.date, currentDir, state =>
            claimCorrectionTasks(state, { limit: options.limit, paperId: options.paperId }));
        result = { action: options.action, ...item.result };
    } else if (options.action === 'start') {
        const item = updateCorrectionState(options.date, currentDir, state =>
            startCorrectionTask(state, options.claimId, options.taskName));
        result = { action: options.action, ...item.result };
    } else if (options.action === 'submit') {
        const item = updateCorrectionState(options.date, currentDir, state =>
            submitCorrectionTask(state, options.claimId, options.date, currentDir));
        result = { action: options.action, ...item.result };
    } else if (options.action === 'retry') {
        const item = updateCorrectionState(options.date, currentDir, state =>
            retryCorrectionTask(state, options.paperId));
        result = { action: options.action, ...item.result };
    } else if (options.action === 'abandon') {
        const item = updateCorrectionState(options.date, currentDir, state =>
            abandonCorrectionTask(state, options.claimId, options.reason));
        result = { action: options.action, ...item.result };
    } else if (options.action === 'manifest') {
        const item = writeManifest({ ...options, currentDir });
        result = { action: options.action, manifestPath: item.manifestPath, manifestSha256: item.manifest.manifestSha256, corrected: item.manifest.correctedPaperIds.length };
    } else {
        const stateItem = reconcilePersistedCorrectionState(options.date, currentDir);
        result = { action: options.action, ...correctionStateSummary(stateItem.state, stateItem.paths.manifestPath) };
        if (fs.existsSync(stateItem.paths.manifestPath)) {
            const item = loadValidatedManifest(stateItem.paths.manifestPath, {
                date: options.date, dateRoot: stateItem.paths.dateRoot,
                expectedPaperIds: stateItem.state.expectedPaperIds
            });
            result.manifestStatus = 'validated';
            result.manifestSha256 = item.manifest.manifestSha256;
        }
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
}

if (require.main === module) {
    try { run(); } catch (error) {
        console.error(`Manual v6 metadata correction 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    CORRECTION_PACKET_CONTRACT,
    CORRECTION_OUTPUT_CONTRACT,
    CORRECTION_RECEIPT_CONTRACT,
    CORRECTION_MANIFEST_CONTRACT,
    CORRECTION_PROOF_CONTRACT,
    CORRECTION_STATE_VERSION,
    CORRECTION_STATE_MODE,
    CORRECTION_ACTIVE_LIMIT,
    MUTABLE_FIELDS,
    stableSha256,
    validateExactMetadataFields,
    needsMetadataCorrection,
    applyMetadataCorrection,
    validatePacket,
    validateCorrection,
    validateReceipt,
    correctionPaths,
    initializeCorrectionState,
    validateCorrectionState,
    reconcileCorrectionState,
    verifyCorrectionState,
    correctionActiveCount,
    registerCorrectionPacket,
    claimCorrectionTasks,
    startCorrectionTask,
    submitCorrectionTask,
    abandonCorrectionTask,
    retryCorrectionTask,
    correctionStateSummary,
    updateCorrectionState,
    reconcilePersistedCorrectionState,
    createPacket,
    createPacketArtifact,
    registerExistingPacket,
    loadValidatedCorrection,
    buildManifest,
    writeManifest,
    validateManifestObject,
    loadValidatedManifest,
    buildCorrectionProof,
    parseArgs,
    run
};

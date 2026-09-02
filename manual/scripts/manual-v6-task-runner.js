#!/usr/bin/env node
'use strict';

/** Persistent, API-free task queue for production or explicit-shadow Manual v6 work. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) require('../../scripts/env-loader.js').requireExternalRuntime('manual-v6-task-runner.js');
const Config = require('../../scripts/config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('../../scripts/utils.js');
const { withFileLockSync } = require('../../scripts/analysis-engine.js');
const {
    buildFilteredBatchFingerprint,
    buildPaperInputIdentity
} = require('./manual-fetch-fulltext.js');
const {
    stableSha256, validateTaskPacket, validateAuthorRevisionArtifactLineage,
    validateReviewOutput, validateRevisionOutput
} = require('./manual-v6-workflow.js');
const {
    validateManualTutorialLongformBundle
} = require('./manual-tutorial-contract-orchestrator.js');
const {
    normalizeAuthorOwnedBaseFields,
    validateAuthorOwnedRecordDraft
} = require('./manual-v6-author-base-fields.js');
const {
    RECORDS_VERSION,
    validateRecord
} = require('./create-manual-analysis-spec.js');

const STATE_VERSION = 1;
const MODE = 'manual_v6_task_runner';
const ROLES = Object.freeze(['author', 'technical_scoring', 'pedagogy_readability', 'author_revision']);
const DEPENDENCIES = Object.freeze({
    author: [],
    technical_scoring: ['author'],
    pedagogy_readability: ['author'],
    author_revision: ['technical_scoring', 'pedagogy_readability']
});
const DOWNSTREAM = Object.freeze(Object.fromEntries(ROLES.map(role => [role, ROLES.filter(
    candidate => dependsTransitively(candidate, role)
)])));
const ACTIVE_LIMIT = 3;
const SHA_RE = /^[a-f0-9]{64}$/;
const BEIJING_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;
const AUTHOR_OUTPUT_CONTRACT = 'manual-v6-author-output-v2';
const REVISION_OUTPUT_CONTRACT = 'manual-v6-author-revision-output-v2';

function dependsTransitively(role, ancestor, seen = new Set()) {
    if (seen.has(role)) return false;
    seen.add(role);
    return DEPENDENCIES[role].some(dep => dep === ancestor || dependsTransitively(dep, ancestor, seen));
}

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('date 必须是 YYYY-MM-DD');
    return date;
}

function assertRole(role) {
    if (!ROLES.includes(role)) throw new Error(`role 非法: ${role}`);
    return role;
}

function assertInsideRealRoot(rootPath, filePath, label, kind = 'file') {
    const root = fs.realpathSync(rootPath);
    const declared = path.resolve(filePath);
    const stat = fs.lstatSync(declared);
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`${label} 类型非法或使用 symlink`);
    }
    const real = fs.realpathSync(declared);
    const relative = path.relative(root, real);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} 逃逸单篇 artifactRoot`);
    }
    return real;
}

function runnerPaths(date, workflowRoot = Config.FILES.manualV6Dir) {
    const root = path.join(path.resolve(workflowRoot), assertDate(date), 'task-runner');
    return { root, statePath: path.join(root, 'state.json'), taskRoot: path.join(root, 'tasks') };
}

function emptyTask() {
    return {
        status: 'awaiting_packet', inputKey: null, packetSha256: null, packetFileSha256: null,
        packetPath: null, artifactRoot: null, claimId: null, taskName: null,
        claimedAt: null, startedAt: null, completedAt: null, attempt: 0,
        outputPath: null, outputFileSha256: null, outputSemanticSha256: null,
        receiptPath: null, receiptFileSha256: null, receiptSemanticSha256: null,
        error: null
    };
}

function initializeState(date, paperIds, generatedAt = getBeijingISOString(), filteredInput = {}, executionScope = 'production') {
    const ids = paperIds.map(normalizedId);
    if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length) {
        throw new Error('expectedPaperIds 必须是非空且不重复的规范化论文集合');
    }
    if (!['production', 'shadow'].includes(executionScope)) {
        throw new Error('task runner executionScope 必须是 production 或 shadow');
    }
    return {
        version: STATE_VERSION, mode: MODE, date: assertDate(date), generation: 0,
        executionScope,
        createdAt: generatedAt, updatedAt: generatedAt, activeLimit: ACTIVE_LIMIT,
        filteredInput: {
            path: filteredInput.path || null,
            fileSha256: filteredInput.fileSha256 || null,
            paperSetSha256: filteredInput.paperSetSha256 || stableSha256([...ids].sort())
        },
        expectedPaperIds: [...ids].sort(), taskNames: {},
        papers: Object.fromEntries([...ids].sort().map(id => [id, {
            paperId: id, tasks: Object.fromEntries(ROLES.map(role => [role, emptyTask()]))
        }]))
    };
}

function validateState(state) {
    if (!state || state.version !== STATE_VERSION || state.mode !== MODE) throw new Error('task runner state 版本非法');
    assertDate(state.date);
    if (!['production', 'shadow'].includes(state.executionScope)) {
        throw new Error('task runner executionScope 非法');
    }
    if (!Number.isInteger(state.generation) || state.generation < 0 || state.activeLimit !== ACTIVE_LIMIT
        || !state.taskNames || typeof state.taskNames !== 'object' || Array.isArray(state.taskNames)) {
        throw new Error('task runner generation/activeLimit/taskNames 非法');
    }
    if (!BEIJING_RE.test(String(state.createdAt || '')) || !BEIJING_RE.test(String(state.updatedAt || ''))) {
        throw new Error('task runner createdAt/updatedAt 必须是北京时间');
    }
    if (!state.filteredInput || typeof state.filteredInput.path !== 'string'
        || !SHA_RE.test(String(state.filteredInput.fileSha256 || ''))
        || !SHA_RE.test(String(state.filteredInput.paperSetSha256 || ''))) {
        throw new Error('task runner filteredInput 未封印真实文件与 paper set');
    }
    if (!Array.isArray(state.expectedPaperIds) || !state.papers) throw new Error('task runner state 论文集合非法');
    const seenTaskNames = new Set();
    let active = 0;
    for (const id of state.expectedPaperIds) {
        if (normalizedId(id) !== id || !state.papers[id]?.tasks) throw new Error(`state 缺少规范论文: ${id}`);
        for (const role of ROLES) {
            const task = state.papers[id].tasks[role];
            if (!task || !['awaiting_packet', 'pending', 'blocked', 'claimed', 'running', 'submitted', 'validated', 'failed', 'stale'].includes(task.status)) {
                throw new Error(`${id}.${role}.status 非法`);
            }
            if (['claimed', 'running', 'submitted'].includes(task.status)) active++;
            if (['claimed', 'running', 'submitted'].includes(task.status)
                && (!task.claimId || !BEIJING_RE.test(String(task.claimedAt || '')))) {
                throw new Error(`${id}.${role} 活动 claim 字段不完整`);
            }
            if (['running', 'submitted', 'validated'].includes(task.status)
                && (!task.taskName || !BEIJING_RE.test(String(task.startedAt || '')))) {
                throw new Error(`${id}.${role} started/taskName 字段不完整`);
            }
            if (task.status === 'validated' && !BEIJING_RE.test(String(task.completedAt || ''))) {
                throw new Error(`${id}.${role}.completedAt 非法`);
            }
            if (!Number.isInteger(task.attempt) || task.attempt < 0) throw new Error(`${id}.${role}.attempt 非法`);
            for (const field of ['packetSha256', 'packetFileSha256', 'outputFileSha256', 'outputSemanticSha256',
                'receiptFileSha256', 'receiptSemanticSha256']) {
                if (task[field] !== null && !SHA_RE.test(String(task[field] || ''))) {
                    throw new Error(`${id}.${role}.${field} 非法`);
                }
            }
            if (task.packetSha256 && (!task.packetPath || !task.artifactRoot || !task.packetFileSha256)) {
                throw new Error(`${id}.${role} packet 字段不闭环`);
            }
            if (task.status === 'validated' && (!task.outputPath || !task.receiptPath
                || !task.outputFileSha256 || !task.outputSemanticSha256
                || !task.receiptFileSha256 || !task.receiptSemanticSha256)) {
                throw new Error(`${id}.${role} validated 工件字段不完整`);
            }
            if (task.taskName) {
                if (seenTaskNames.has(task.taskName)) throw new Error(`state taskName 重复: ${task.taskName}`);
                seenTaskNames.add(task.taskName);
                const owner = state.taskNames?.[task.taskName];
                if (!owner || owner.paperId !== id || owner.role !== role) throw new Error(`state taskName owner 不闭环: ${task.taskName}`);
            }
        }
    }
    if (active > ACTIVE_LIMIT) throw new Error(`state 活动任务超过 ${ACTIVE_LIMIT} 槽`);
    for (const [taskName, owner] of Object.entries(state.taskNames)) {
        if (taskName.length < 4 || !owner || !state.papers[owner.paperId]
            || !ROLES.includes(owner.role) || typeof owner.claimId !== 'string'
            || typeof owner.retired !== 'boolean') {
            throw new Error(`state taskNames.${taskName} 非法`);
        }
        if (!owner.retired && state.papers[owner.paperId].tasks[owner.role].taskName !== taskName) {
            throw new Error(`state taskNames.${taskName} active owner 不闭环`);
        }
    }
    return state;
}

function dependencyInputKey(state, paperId, role, packetSha256, packetFileSha256 = null) {
    const tasks = state.papers[paperId].tasks;
    const packetFileSha = packetFileSha256 || tasks[role].packetFileSha256;
    const dependencies = DEPENDENCIES[role].map(dep => ({
        role: dep, outputSemanticSha256: tasks[dep].outputSemanticSha256
    }));
    if (dependencies.some(item => !SHA_RE.test(String(item.outputSemanticSha256 || '')))) return null;
    if (!SHA_RE.test(String(packetFileSha || ''))) return null;
    return stableSha256({
        contract: 'manual-v6-task-input-v1', paperId, role,
        packetSha256, packetFileSha256: packetFileSha, dependencies
    });
}

function invalidateFrom(state, paperId, role, reason) {
    for (const affectedRole of [role, ...DOWNSTREAM[role]]) {
        const task = state.papers[paperId].tasks[affectedRole];
        if (task.taskName) state.taskNames[task.taskName] = {
            ...state.taskNames[task.taskName], retired: true
        };
        // The retried node may reuse its own immutable packet, but every
        // downstream packet binds the old dependency output SHA and must be
        // rematerialized. Keeping a downstream packet here produces an
        // impossible state: the dependency is no longer validated while the
        // stale packet still claims that it is.
        const keepPacket = affectedRole === role && Boolean(task.packetSha256);
        const packetFields = keepPacket ? {
            packetSha256: task.packetSha256, packetFileSha256: task.packetFileSha256,
            packetPath: task.packetPath, artifactRoot: task.artifactRoot
        } : {};
        state.papers[paperId].tasks[affectedRole] = {
            ...emptyTask(), ...packetFields,
            status: keepPacket ? 'stale' : 'awaiting_packet', error: reason
        };
    }
}

function refreshReadiness(state) {
    for (const id of state.expectedPaperIds) {
        for (const role of ROLES) {
            const task = state.papers[id].tasks[role];
            if (!task.packetSha256 || ['claimed', 'running', 'submitted', 'failed'].includes(task.status)) continue;
            const inputKey = dependencyInputKey(state, id, role, task.packetSha256);
            if (task.status === 'validated' && task.inputKey === inputKey) continue;
            if (task.status === 'validated' && task.inputKey !== inputKey) invalidateFrom(state, id, role, 'dependency_content_sha_changed');
            const current = state.papers[id].tasks[role];
            const ready = DEPENDENCIES[role].every(dep => state.papers[id].tasks[dep].status === 'validated');
            if (!['claimed', 'running', 'submitted', 'validated', 'failed'].includes(current.status)) {
                current.status = ready ? 'pending' : 'blocked';
                current.inputKey = ready ? dependencyInputKey(state, id, role, current.packetSha256) : null;
            }
        }
    }
    return state;
}

function registerPacket(state, options) {
    validateState(state);
    const paperId = normalizedId(options.paperId);
    const role = assertRole(options.role);
    if (!state.papers[paperId]) throw new Error(`批次外论文: ${paperId}`);
    const rootStat = fs.lstatSync(options.artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('artifactRoot 必须是真实单篇目录且不得为 symlink');
    const artifactRoot = fs.realpathSync(options.artifactRoot);
    const controlledTaskRoot = fs.realpathSync(options.controlledTaskRoot);
    const expectedPaperRoot = fs.realpathSync(path.join(controlledTaskRoot, paperId));
    if (artifactRoot !== expectedPaperRoot) {
        throw new Error(`artifactRoot 必须精确等于受控 taskRoot/${paperId}`);
    }
    for (const otherId of state.expectedPaperIds) {
        if (otherId === paperId) continue;
        const otherRoots = new Set(ROLES.map(item => state.papers[otherId].tasks[item].artifactRoot).filter(Boolean));
        for (const otherRoot of otherRoots) {
            if (artifactRoot === otherRoot || artifactRoot.startsWith(`${otherRoot}${path.sep}`)
                || otherRoot.startsWith(`${artifactRoot}${path.sep}`)) {
                throw new Error(`artifactRoot 与另一论文 ${otherId} 重叠，违反单篇隔离`);
            }
        }
    }
    const packetPath = assertInsideRealRoot(artifactRoot, options.packetPath, 'task packet');
    const bytes = fs.readFileSync(packetPath);
    const packet = JSON.parse(bytes.toString('utf8'));
    const filtered = verifyFilteredInput(state);
    const expectedPaperMetadata = filtered.papers.find(paper => normalizedId(paper) === paperId);
    const expectedPaperInputSha256 = buildPaperInputIdentity(
        expectedPaperMetadata, buildFilteredBatchFingerprint(filtered), artifactRoot
    ).paperInputSha256;
    validateTaskPacket(packet, {
        paperId, artifactRoot, requireFiles: true, expectedPaperMetadata, expectedPaperInputSha256
    });
    if (packet.role !== role) throw new Error('task packet role 与注册 role 不一致');
    if (role === 'author_revision') {
        const tasks = state.papers[paperId].tasks;
        if (tasks.author.status !== 'validated'
            || tasks.technical_scoring.status !== 'validated'
            || tasks.pedagogy_readability.status !== 'validated') {
            throw new Error('author_revision packet 只能在 author 与两份 review 均经 runner 验证后注册');
        }
        const authorPacket = readSubmissionFile(
            artifactRoot, tasks.author.packetPath, `${paperId}.author.packet`
        ).value;
        validateAuthorRevisionArtifactLineage(authorPacket, packet, {
            technical: {
                path: path.relative(artifactRoot, tasks.technical_scoring.outputPath).replace(/\\/g, '/'),
                sha256: tasks.technical_scoring.outputFileSha256
            },
            readability: {
                path: path.relative(artifactRoot, tasks.pedagogy_readability.outputPath).replace(/\\/g, '/'),
                sha256: tasks.pedagogy_readability.outputFileSha256
            }
        });
    }
    const task = state.papers[paperId].tasks[role];
    const fileSha = sha256Bytes(bytes);
    if (task.packetFileSha256 === fileSha && task.packetSha256 === packet.packetSha256) return refreshReadiness(state);
    if (['claimed', 'running', 'submitted'].includes(task.status)) throw new Error('活动任务不可替换 packet；先显式 fail/retry');
    invalidateFrom(state, paperId, role, 'packet_content_sha_changed');
    Object.assign(state.papers[paperId].tasks[role], {
        packetSha256: packet.packetSha256, packetFileSha256: fileSha,
        packetPath, artifactRoot, error: null
    });
    return refreshReadiness(state);
}

function activeCount(state) {
    return state.expectedPaperIds.flatMap(id => ROLES.map(role => state.papers[id].tasks[role]))
        .filter(task => ['claimed', 'running', 'submitted'].includes(task.status)).length;
}

function claimTasks(state, limit = ACTIVE_LIMIT, now = getBeijingISOString()) {
    validateState(state); refreshReadiness(state);
    if (!BEIJING_RE.test(String(now || ''))) throw new Error('claimedAt 必须是北京时间');
    if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVE_LIMIT) {
        throw new Error(`claim limit 必须是 1-${ACTIVE_LIMIT} 的整数`);
    }
    const capacity = Math.max(0, ACTIVE_LIMIT - activeCount(state));
    const take = Math.min(limit, capacity);
    const candidates = [];
    for (const id of state.expectedPaperIds) for (const role of ROLES) {
        const task = state.papers[id].tasks[role];
        if (task.status === 'pending') candidates.push({ id, role, task });
    }
    const claimed = candidates.slice(0, take).map(({ id, role, task }) => {
        task.status = 'claimed'; task.claimId = crypto.randomUUID(); task.claimedAt = now;
        task.attempt += 1; task.error = null;
        return { paperId: id, role, claimId: task.claimId, claimedAt: now,
            packetPath: task.packetPath, packetSha256: task.packetSha256, inputKey: task.inputKey };
    });
    return { state, claimed, active: activeCount(state), capacity: ACTIVE_LIMIT };
}

function findClaim(state, claimId) {
    for (const id of state.expectedPaperIds) for (const role of ROLES) {
        const task = state.papers[id].tasks[role];
        if (task.claimId === claimId) return { paperId: id, role, task };
    }
    throw new Error(`未知 claimId: ${claimId}`);
}

function startTask(state, claimId, taskName, now = getBeijingISOString()) {
    const { paperId, role, task } = findClaim(state, claimId);
    if (task.status !== 'claimed') throw new Error('只有 claimed 任务可以开始');
    if (typeof taskName !== 'string' || taskName.trim().length < 4 || state.taskNames[taskName]) {
        throw new Error('taskName 非法或已在批次使用');
    }
    if (!BEIJING_RE.test(String(now || '')) || Date.parse(now) < Date.parse(task.claimedAt)) {
        throw new Error('startedAt 必须是 claim 之后的北京时间');
    }
    task.status = 'running'; task.taskName = taskName; task.startedAt = now;
    state.taskNames[taskName] = { paperId, role, claimId, retired: false };
    return { paperId, role, claimId, taskName, claimedAt: task.claimedAt, startedAt: now,
        packetPath: task.packetPath, packetSha256: task.packetSha256 };
}

function readSubmissionFile(root, filePath, label) {
    const real = assertInsideRealRoot(root, filePath, label);
    const bytes = fs.readFileSync(real);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`${label} JSON 损坏: ${error.message}`); }
    return { path: real, bytes, fileSha256: sha256Bytes(bytes), value, semanticSha256: stableSha256(value) };
}

function verifyFilteredInput(state) {
    const declared = state.filteredInput.path;
    if (!fs.existsSync(declared) || fs.lstatSync(declared).isSymbolicLink()) {
        throw new Error('runner 绑定的 filtered 文件缺失或变成 symlink');
    }
    const bytes = fs.readFileSync(declared);
    if (sha256Bytes(bytes) !== state.filteredInput.fileSha256) throw new Error('runner 绑定的 filtered 文件字节已变化');
    const filtered = JSON.parse(bytes.toString('utf8'));
    if (filtered.status !== 'complete' || filtered.batchDate !== state.date || !Array.isArray(filtered.papers)) {
        throw new Error('runner 绑定的 filtered 不再是同日 complete 批次');
    }
    const ids = filtered.papers.map(normalizedId).sort();
    if (new Set(ids).size !== ids.length || stableSha256(ids) !== state.filteredInput.paperSetSha256
        || stableSha256(ids) !== stableSha256(state.expectedPaperIds)) {
        throw new Error('runner 绑定的 filtered paper set 已变化');
    }
    return filtered;
}

function verifyPersistedTaskFiles(state, options = {}) {
    const ignoredPacket = options.ignoredPacket || null;
    const filtered = verifyFilteredInput(state);
    for (const paperId of state.expectedPaperIds) {
        for (const role of ROLES) {
            const task = state.papers[paperId].tasks[role];
            const skipPacket = ignoredPacket?.paperId === paperId && ignoredPacket?.role === role;
            if (task.packetPath && !skipPacket) {
                const packet = readSubmissionFile(task.artifactRoot, task.packetPath, `${paperId}.${role}.packet`);
                if (packet.fileSha256 !== task.packetFileSha256
                    || packet.value.packetSha256 !== task.packetSha256) {
                    throw new Error(`${paperId}.${role} packet 文件被篡改`);
                }
                const expectedPaperMetadata = filtered.papers.find(paper => normalizedId(paper) === paperId);
                const expectedPaperInputSha256 = buildPaperInputIdentity(
                    expectedPaperMetadata, buildFilteredBatchFingerprint(filtered), task.artifactRoot
                ).paperInputSha256;
                validateTaskPacket(packet.value, {
                    paperId, artifactRoot: task.artifactRoot, requireFiles: true,
                    expectedPaperMetadata, expectedPaperInputSha256
                });
            }
            for (const [pathField, fileField, semanticField, label] of [
                ['outputPath', 'outputFileSha256', 'outputSemanticSha256', 'output'],
                ['receiptPath', 'receiptFileSha256', 'receiptSemanticSha256', 'receipt']
            ]) {
                if (!task[pathField]) continue;
                const item = readSubmissionFile(task.artifactRoot, task[pathField], `${paperId}.${role}.${label}`);
                if (item.fileSha256 !== task[fileField] || item.semanticSha256 !== task[semanticField]) {
                    throw new Error(`${paperId}.${role}.${label} 文件被篡改`);
                }
            }
        }
        const tasks = state.papers[paperId].tasks;
        const skipRevisionLineage = ignoredPacket?.paperId === paperId
            && ignoredPacket?.role === 'author_revision';
        if (tasks.author_revision.packetPath && !skipRevisionLineage) {
            if (tasks.author.status !== 'validated'
                || tasks.technical_scoring.status !== 'validated'
                || tasks.pedagogy_readability.status !== 'validated') {
                throw new Error(`${paperId}.author_revision 不再绑定三个 validated 上游任务`);
            }
            const authorPacket = readSubmissionFile(
                tasks.author.artifactRoot, tasks.author.packetPath, `${paperId}.author.packet`
            ).value;
            const revisionPacket = readSubmissionFile(
                tasks.author_revision.artifactRoot, tasks.author_revision.packetPath,
                `${paperId}.author_revision.packet`
            ).value;
            validateAuthorRevisionArtifactLineage(authorPacket, revisionPacket, {
                technical: {
                    path: path.relative(tasks.author_revision.artifactRoot, tasks.technical_scoring.outputPath)
                        .replace(/\\/g, '/'),
                    sha256: tasks.technical_scoring.outputFileSha256
                },
                readability: {
                    path: path.relative(tasks.author_revision.artifactRoot, tasks.pedagogy_readability.outputPath)
                        .replace(/\\/g, '/'),
                    sha256: tasks.pedagogy_readability.outputFileSha256
                }
            });
        }
    }
}

function verifyBoundInputs(state, options = {}) {
    validateState(state); verifyFilteredInput(state); verifyPersistedTaskFiles(state, options); return state;
}

function validateTerraReceipt(receipt, task, paperId, role, outputSemanticSha256) {
    if (!receipt || normalizedId(receipt.paperId) !== paperId || receipt.taskName !== task.taskName
        || receipt.model !== 'gpt-5.6-terra' || receipt.reasoningEffort !== 'high'
        || receipt.singlePaperOnly !== true || receipt.isolatedContext !== true) {
        throw new Error('receipt 必须绑定当前单篇隔离 Terra-high task');
    }
    const consumed = receipt.consumedPacketSha256 || receipt.inputPacketSha256;
    if (consumed !== task.packetSha256) throw new Error('receipt 未绑定实际 packet SHA');
    if (role !== 'author' && receipt.role !== role) throw new Error('receipt.role 与当前任务不一致');
    if (role !== 'author' && receipt.outputSha256 !== outputSemanticSha256) {
        throw new Error('receipt.outputSha256 未绑定真实 output 语义 SHA');
    }
    if (receipt.queuedAt !== task.claimedAt
        || receipt.startedAt !== task.startedAt
        || !Number.isInteger(receipt.revision) || receipt.revision < 1) {
        throw new Error('receipt 未绑定真实 claim/start 时间或修订序号');
    }
    const completedAt = String(receipt.completedAt || '');
    if (!BEIJING_RE.test(completedAt) || Date.parse(completedAt) < Date.parse(task.startedAt)) {
        throw new Error('receipt.completedAt 必须是开始时间之后的北京时间');
    }
}

function normalizedArticleSha256(bytes) {
    const text = bytes.toString('utf8').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
    return sha256Bytes(Buffer.from(text, 'utf8'));
}

function validateProductionAuthorOutput(output, receipt, task, paperId, outputSemanticSha256) {
    if (output?.version !== 2 || output.contract !== AUTHOR_OUTPUT_CONTRACT
        || output.role !== 'author' || normalizedId(output.paperId) !== paperId
        || output.taskName !== task.taskName || output.passed !== true
        || !SHA_RE.test(String(output.articleSha256 || ''))) {
        throw new Error(`production author output 必须是 ${AUTHOR_OUTPUT_CONTRACT}`);
    }
    const refs = [
        ['article', output.article, 'draft/author-article.md'],
        ['recordDraft', output.recordDraft, 'draft/author-record.json']
    ];
    for (const [field, ref, expectedRelative] of refs) {
        if (!ref || ref.path !== expectedRelative || !SHA_RE.test(String(ref.fileSha256 || ''))) {
            throw new Error(`production author output.${field} 必须绑定固定路径与真实文件 SHA`);
        }
        const file = assertInsideRealRoot(
            task.artifactRoot, path.join(task.artifactRoot, expectedRelative),
            `production author output.${field}`
        );
        const bytes = fs.readFileSync(file);
        if (sha256Bytes(bytes) !== ref.fileSha256) {
            throw new Error(`production author output.${field} 文件 SHA 不匹配`);
        }
        if (field === 'article' && normalizedArticleSha256(bytes) !== output.articleSha256) {
            throw new Error('production author output.articleSha256 未绑定真实 NFKC/trim 正文');
        }
        if (field === 'recordDraft') {
            if (!SHA_RE.test(String(ref.semanticSha256 || ''))) {
                throw new Error('production author output.recordDraft 缺少语义 SHA');
            }
            const draft = JSON.parse(bytes.toString('utf8'));
            if (normalizedId(draft.paperId || draft.arxivId) !== paperId
                || draft.sealedRecordSha256 || draft.reviewReceipts || draft.reviewResolution
                || stableSha256(draft) !== ref.semanticSha256) {
                throw new Error('production author record draft 身份、语义 SHA 或未封印状态非法');
            }
            validateAuthorOwnedRecordDraft(draft, 'production author record draft');
            const ledger = draft.evidenceLedger;
            if (!Array.isArray(ledger) || ledger.length < 1) {
                throw new Error('production author record draft 缺少 evidenceLedger');
            }
            const canonicalIds = new Set();
            ledger.forEach((entry, index) => {
                const match = String(entry?.id || '').trim().match(/^E(\d{1,3})$/);
                if (!match) {
                    throw new Error(`production author record draft evidenceLedger[${index}].id 必须匹配 E\\d{1,3}`);
                }
                const canonical = `E${match[1].padStart(2, '0')}`;
                if (canonicalIds.has(canonical)) {
                    throw new Error(`production author record draft evidenceLedger ID 规范化冲突: ${canonical}`);
                }
                canonicalIds.add(canonical);
            });
        }
    }
    if (receipt.inputPacketSha256 !== task.packetSha256
        || receipt.outputSha256 !== outputSemanticSha256
        || receipt.articleSha256 !== output.articleSha256) {
        throw new Error('production author receipt 必须绑定 input packet、真实 output 语义 SHA 与初稿正文 SHA');
    }
}

function validateProductionRevisionOutput(output, receipt, task, paperId, dependencies) {
    if (output?.version !== 2 || output.contract !== REVISION_OUTPUT_CONTRACT
        || output.role !== 'author_revision' || normalizedId(output.paperId) !== paperId
        || output.taskName !== task.taskName || output.passed !== true
        || output.technicalOutputSha256 !== dependencies.technicalOutputSha256
        || output.readabilityOutputSha256 !== dependencies.readabilityOutputSha256
        || !SHA_RE.test(String(output.finalArticleSha256 || ''))) {
        throw new Error(`production author_revision output 必须是 ${REVISION_OUTPUT_CONTRACT}`);
    }
    const refs = [
        ['finalArticle', output.finalArticle, 'draft/final-article.md'],
        ['recordPayload', output.recordPayload, 'draft/revision-record-payload.json']
    ];
    let payload;
    for (const [field, ref, expectedRelative] of refs) {
        if (!ref || ref.path !== expectedRelative || !SHA_RE.test(String(ref.fileSha256 || ''))) {
            throw new Error(`production revision output.${field} 必须绑定固定路径与真实文件 SHA`);
        }
        const file = assertInsideRealRoot(
            task.artifactRoot, path.join(task.artifactRoot, expectedRelative),
            `production revision output.${field}`
        );
        const bytes = fs.readFileSync(file);
        if (sha256Bytes(bytes) !== ref.fileSha256) {
            throw new Error(`production revision output.${field} 文件 SHA 不匹配`);
        }
        if (field === 'finalArticle' && normalizedArticleSha256(bytes) !== output.finalArticleSha256) {
            throw new Error('production revision output.finalArticleSha256 未绑定真实 NFKC/trim 正文');
        }
        if (field === 'recordPayload') {
            if (!SHA_RE.test(String(ref.semanticSha256 || ''))) {
                throw new Error('production revision output.recordPayload 缺少语义 SHA');
            }
            payload = JSON.parse(bytes.toString('utf8'));
            const longform = payload?.editorial?.longformBundle;
            if (payload?.version !== 4 || payload.manualDepth !== 'full-text-evidence-v6'
                || normalizedId(payload.paperId) !== paperId
                || payload.sealedRecordSha256 || payload.reviewReceipts || payload.reviewResolution
                || longform?.authorReceipt || longform?.finalRevisionAuthorReceipt
                || stableSha256(payload) !== ref.semanticSha256) {
                throw new Error('production revision record payload 身份、语义 SHA 或未封印状态非法');
            }
            const normalizedBase = normalizeAuthorOwnedBaseFields(
                payload, 'production revision record payload'
            );
            if (payload.type !== normalizedBase.type || payload.task !== normalizedBase.task
                || payload.tags !== normalizedBase.tags) {
                throw new Error('production revision record payload 的 type/task/tags 必须已规范化后再签名');
            }
            const article = fs.readFileSync(path.join(task.artifactRoot, 'draft', 'final-article.md'), 'utf8')
                .normalize('NFKC').replace(/\r\n?/g, '\n').trim();
            const payloadArticle = String(payload.editorial?.readerArticle || '')
                .normalize('NFKC').replace(/\r\n?/g, '\n').trim();
            if (article !== payloadArticle || longform?.articleSha256 !== output.finalArticleSha256) {
                throw new Error('production revision payload 未逐字绑定最终正文/longform SHA');
            }
            const artifactIndexPath = assertInsideRealRoot(
                task.artifactRoot,
                path.join(task.artifactRoot, 'evidence', 'artifact-index.json'),
                'production revision ArtifactIndex'
            );
            const artifactIndex = JSON.parse(fs.readFileSync(artifactIndexPath, 'utf8'));
            validateManualTutorialLongformBundle(longform, article, artifactIndex, {
                paperId,
                runtimeMode: 'production',
                unsealedRevision: true,
                label: 'production revision payload.editorial.longformBundle'
            });
            validateRecord(payload, paperId, 'production revision record payload', {
                recordsVersion: RECORDS_VERSION
            });
        }
    }
    const auditRef = output.independentAudit;
    if (!auditRef || auditRef.path !== 'reviews/revision-independent-audit.json'
        || !SHA_RE.test(String(auditRef.fileSha256 || ''))
        || !SHA_RE.test(String(auditRef.semanticSha256 || ''))
        || !String(auditRef.taskName || '').startsWith('/root/')) {
        throw new Error('production revision output 缺少独立审计固定引用');
    }
    const auditPath = assertInsideRealRoot(
        task.artifactRoot, path.join(task.artifactRoot, auditRef.path),
        'production revision independent audit'
    );
    const auditBytes = fs.readFileSync(auditPath);
    const audit = JSON.parse(auditBytes.toString('utf8'));
    if (sha256Bytes(auditBytes) !== auditRef.fileSha256
        || stableSha256(audit) !== auditRef.semanticSha256
        || audit.taskName !== auditRef.taskName || normalizedId(audit.paperId) !== paperId
        || audit.contract !== 'manual-v6-independent-revision-audit-v1'
        || audit.finalPassed !== true) {
        throw new Error('production revision independent audit 字节、身份或最终状态不闭环');
    }
    if (!Array.isArray(output.resolvedFindingSha256s)
        || output.resolvedFindingSha256s.some(value => !SHA_RE.test(String(value || '')))
        || !Array.isArray(output.notes) || output.notes.length < 2
        || output.notes.some(value => String(value || '').trim().length < 20)) {
        throw new Error('production revision output 缺少 findings resolution 或具体修订说明');
    }
    if (receipt.articleSha256 !== output.finalArticleSha256
        || receipt.queuedAt !== task.claimedAt || receipt.startedAt !== task.startedAt
        || !Number.isInteger(receipt.revision) || receipt.revision < 1) {
        throw new Error('production revision receipt 未绑定最终正文、真实 claim/start 或修订序号');
    }
    return payload;
}

function submitTask(state, claimId, options) {
    const { paperId, role, task } = findClaim(state, claimId);
    if (task.status !== 'running') throw new Error('只有 running 任务可以提交');
    const output = readSubmissionFile(task.artifactRoot, options.outputPath, 'task output');
    const receiptFile = readSubmissionFile(task.artifactRoot, options.receiptPath, 'task receipt');
    validateTerraReceipt(receiptFile.value, task, paperId, role, output.semanticSha256);
    if (role === 'technical_scoring' || role === 'pedagogy_readability') {
        const expectedOutputName = role === 'technical_scoring'
            ? 'reviews/technical-scoring.json'
            : 'reviews/pedagogy-readability.json';
        const expectedOutputPath = path.resolve(task.artifactRoot, expectedOutputName);
        if (output.path !== expectedOutputPath) {
            throw new Error(`${role} output 必须写入受控固定路径 ${expectedOutputName}`);
        }
        validateReviewOutput(output.value, role, paperId, receiptFile.value, 'task output');
    } else if (role === 'author_revision' && state.executionScope === 'production') {
        if (output.path !== path.resolve(task.artifactRoot, 'outputs', 'author-revision.json')
            || receiptFile.path !== path.resolve(task.artifactRoot, 'receipts', 'author-revision.json')) {
            throw new Error('production author_revision output/receipt 必须写入受控固定路径');
        }
        const tasks = state.papers[paperId].tasks;
        validateProductionRevisionOutput(output.value, receiptFile.value, task, paperId, {
            technicalOutputSha256: tasks.technical_scoring.outputSemanticSha256,
            readabilityOutputSha256: tasks.pedagogy_readability.outputSemanticSha256
        });
    } else if (role === 'author_revision') {
        const tasks = state.papers[paperId].tasks;
        validateRevisionOutput(output.value, paperId, receiptFile.value, {
            technicalOutputSha256: tasks.technical_scoring.outputSemanticSha256,
            readabilityOutputSha256: tasks.pedagogy_readability.outputSemanticSha256,
            finalArticleSha256: output.value.finalArticleSha256,
            runtimeMode: 'shadow'
        });
    } else if (state.executionScope === 'production') {
        if (output.path !== path.resolve(task.artifactRoot, 'outputs', 'author.json')
            || receiptFile.path !== path.resolve(task.artifactRoot, 'receipts', 'author.json')) {
            throw new Error('production author output/receipt 必须写入受控固定路径');
        }
        validateProductionAuthorOutput(
            output.value, receiptFile.value, task, paperId, output.semanticSha256
        );
    } else {
        if (output.value?.version !== 1 || output.value.role !== 'author'
            || normalizedId(output.value.paperId) !== paperId || output.value.taskName !== task.taskName
            || output.value.passed !== true || !SHA_RE.test(String(output.value.articleSha256 || ''))
            || receiptFile.value.articleSha256 !== output.value.articleSha256) {
            throw new Error('shadow author output/receipt 未绑定单篇成稿 SHA');
        }
    }
    task.status = 'submitted';
    Object.assign(task, {
        outputPath: output.path, outputFileSha256: output.fileSha256,
        outputSemanticSha256: output.semanticSha256,
        receiptPath: receiptFile.path, receiptFileSha256: receiptFile.fileSha256,
        receiptSemanticSha256: receiptFile.semanticSha256,
        completedAt: receiptFile.value.completedAt
    });
    task.status = 'validated'; task.error = null;
    refreshReadiness(state);
    return { paperId, role, status: task.status, outputSemanticSha256: task.outputSemanticSha256 };
}

function failTask(state, claimId, reason, now = getBeijingISOString()) {
    const { paperId, role, task } = findClaim(state, claimId);
    if (!['claimed', 'running', 'submitted'].includes(task.status)) throw new Error('只有活动任务可以标记失败');
    const error = String(reason || '').trim();
    if (error.length < 8) throw new Error('失败原因至少 8 字符');
    if (!BEIJING_RE.test(String(now || ''))) throw new Error('failedAt 必须是北京时间');
    task.status = 'failed'; task.error = error; task.completedAt = now;
    return { paperId, role, status: 'failed' };
}

function retryTask(state, paperIdValue, roleValue) {
    const paperId = normalizedId(paperIdValue); const role = assertRole(roleValue);
    if (!state.papers[paperId]) throw new Error('批次外论文');
    const task = state.papers[paperId].tasks[role];
    if (!['failed', 'validated', 'stale'].includes(task.status)) throw new Error('只有 failed/validated/stale 可显式 retry');
    invalidateFrom(state, paperId, role, 'explicit_retry');
    return refreshReadiness(state);
}

function abandonTask(state, claimId, reason) {
    const { paperId, role, task } = findClaim(state, claimId);
    if (!['claimed', 'running', 'submitted'].includes(task.status)) throw new Error('只有活动 claim 可以显式 abandon');
    const explanation = String(reason || '').trim();
    if (explanation.length < 8) throw new Error('abandon 原因至少 8 字符');
    invalidateFrom(state, paperId, role, `explicit_abandon:${explanation}`);
    return refreshReadiness(state);
}

function stateSummary(state, options = {}) {
    refreshReadiness(state);
    const tasks = [];
    for (const paperId of state.expectedPaperIds) for (const role of ROLES) {
        const task = state.papers[paperId].tasks[role];
        tasks.push({ paperId, role, status: task.status, claimId: task.claimId,
            taskName: task.taskName, packetPath: task.packetPath, inputKey: task.inputKey, error: task.error });
    }
    const executionScope = options.executionScope || state.executionScope;
    const allTasksValidated = tasks.length > 0 && tasks.every(item => item.status === 'validated');
    const awaitingPackets = tasks.filter(item => item.status === 'awaiting_packet').length;
    const recordsEnvelope = options.recordsEnvelope || {
        status: 'awaiting_records_envelope', path: null, fileSha256: null
    };
    return {
        version: state.version, mode: state.mode, date: state.date, activeLimit: ACTIVE_LIMIT,
        executionScope,
        workflow: executionScope === 'shadow' ? 'manual-v6-shadow' : 'manual-v6-production',
        recordsContract: 'manual_analysis_records_v4',
        specContract: 'manual_analysis_spec_v6',
        allTasksValidated,
        packetPreparationStatus: awaitingPackets > 0 ? 'awaiting_packet' : 'packets_registered',
        recordsEnvelope,
        active: activeCount(state), counts: Object.fromEntries([...new Set(tasks.map(item => item.status))]
            .map(status => [status, tasks.filter(item => item.status === status).length])),
        pendingTasks: tasks.filter(item => item.status === 'pending'),
        orchestrationBoundary: {
            createsSubagents: false,
            claimOnly: true,
            requiredModel: 'gpt-5.6-terra',
            requiredReasoningEffort: 'high',
            nextAction: awaitingPackets > 0
                ? 'main Agent must materialize and register exact per-role packets'
                : (!allTasksValidated
                    ? 'main Agent must claim and create each real single-paper subagent'
                    : (recordsEnvelope.status === 'awaiting_records_envelope'
                        ? 'main Agent must assemble the real records-v4.json envelope'
                        : 'run manual:spec; the official assembler must fully validate records-v4.json'))
        },
        tasks
    };
}

function recordsEnvelopeStatus(workflowRoot, date) {
    const filePath = path.join(path.resolve(workflowRoot), assertDate(date), 'records-v4.json');
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat) return { status: 'awaiting_records_envelope', path: filePath, fileSha256: null };
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('records-v4.json 必须是真实普通文件且不得为 symlink');
    }
    const bytes = fs.readFileSync(filePath);
    return {
        status: 'present_pending_spec_validation',
        path: fs.realpathSync(filePath),
        bytes: bytes.length,
        fileSha256: sha256Bytes(bytes)
    };
}

function updateState(paths, callback, options = {}) {
    fs.mkdirSync(paths.root, { recursive: true });
    return withFileLockSync(paths.statePath, () => {
        const current = fs.existsSync(paths.statePath)
            ? validateState(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')))
            : null;
        const result = callback(current);
        const state = result?.state || result;
        if (state) {
            state.generation = (current?.generation || 0) + 1;
            state.updatedAt = getBeijingISOString();
            verifyBoundInputs(state, options.verifyOptions || {});
            writeFileAtomic(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
        }
        return result;
    }, { timeoutMs: options.timeoutMs ?? 0 });
}

function parseArgs(argv) {
    const options = { command: argv[0], limit: ACTIVE_LIMIT, shadow: false };
    const seen = new Set();
    if (!['init', 'register', 'claim', 'start', 'submit', 'fail', 'retry', 'abandon', 'status'].includes(options.command)) {
        throw new Error('command 必须是 init/register/claim/start/submit/fail/retry/abandon/status');
    }
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--shadow') {
            if (options.shadow) throw new Error('参数重复: --shadow');
            options.shadow = true;
            continue;
        }
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        const key = ({ '--date': 'date', '--papers': 'papersPath', '--paper': 'paperId', '--role': 'role',
            '--artifact-root': 'artifactRoot', '--packet': 'packetPath', '--limit': 'limit',
            '--claim': 'claimId', '--task-name': 'taskName', '--receipt': 'receiptPath',
            '--output': 'outputPath', '--reason': 'reason' })[arg];
        if (!key) throw new Error(`未知参数: ${arg}`);
        if (seen.has(key)) throw new Error(`参数重复: ${arg}`);
        seen.add(key);
        options[key] = value;
    }
    assertDate(options.date);
    const required = {
        register: ['paperId', 'role', 'artifactRoot', 'packetPath'],
        start: ['claimId', 'taskName'], submit: ['claimId', 'receiptPath', 'outputPath'],
        fail: ['claimId', 'reason'], retry: ['paperId', 'role'], abandon: ['claimId', 'reason']
    }[options.command] || [];
    const missing = required.filter(key => !options[key]);
    if (missing.length) throw new Error(`${options.command} 缺少参数: ${missing.join(', ')}`);
    return options;
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const args = parseArgs(argv);
    const executionScope = args.shadow ? 'shadow' : 'production';
    const workflowRoot = args.shadow
        ? (overrides.shadowRoot || Config.FILES.manualV6ShadowDir)
        : (overrides.productionRoot || Config.FILES.manualV6Dir);
    const paths = runnerPaths(args.date, workflowRoot);
    const summaryOptions = {
        executionScope,
        recordsEnvelope: recordsEnvelopeStatus(workflowRoot, args.date)
    };
    let result;
    if (args.command === 'init') {
        const papersPath = path.resolve(args.papersPath || Config.FILES.filteredPapers);
        if (fs.lstatSync(papersPath).isSymbolicLink()) throw new Error('init filtered 不得使用 symlink');
        const filteredBytes = fs.readFileSync(papersPath);
        const filtered = JSON.parse(filteredBytes.toString('utf8'));
        if (filtered.status !== 'complete' || filtered.batchDate !== args.date) throw new Error('init 只接受同日 complete filtered');
        const ids = filtered.papers.map(normalizedId).sort();
        fs.mkdirSync(paths.taskRoot, { recursive: true });
        ids.forEach(id => fs.mkdirSync(path.join(paths.taskRoot, id), { recursive: true }));
        const binding = {
            path: fs.realpathSync(papersPath), fileSha256: sha256Bytes(filteredBytes),
            paperSetSha256: stableSha256(ids)
        };
        result = updateState(paths, current => {
            if (current) { verifyBoundInputs(current); return current; }
            return initializeState(args.date, ids, getBeijingISOString(), binding, executionScope);
        });
    } else if (args.command === 'status') {
        result = withFileLockSync(paths.statePath, () => {
            const state = verifyBoundInputs(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')));
            return stateSummary(state, summaryOptions);
        }, { timeoutMs: 0 });
    } else {
        const verifyOptions = args.command === 'register' ? {
            ignoredPacket: { paperId: normalizedId(args.paperId), role: args.role }
        } : {};
        result = updateState(paths, state => {
            if (!state) throw new Error('task runner 尚未 init');
            verifyBoundInputs(state, verifyOptions);
            if (args.command === 'register') {
                return registerPacket(state, { ...args, controlledTaskRoot: paths.taskRoot });
            }
            if (args.command === 'claim') return claimTasks(state, Number(args.limit));
            if (args.command === 'start') return { state, started: startTask(state, args.claimId, args.taskName) };
            if (args.command === 'submit') return { state, submitted: submitTask(state, args.claimId, args) };
            if (args.command === 'fail') return { state, failed: failTask(state, args.claimId, args.reason) };
            if (args.command === 'retry') return retryTask(state, args.paperId, args.role);
            if (args.command === 'abandon') return abandonTask(state, args.claimId, args.reason);
            return state;
        }, { verifyOptions });
    }
    const printable = result?.state
        ? { ...result, state: undefined }
        : (args.command === 'status'
            ? result
            : (result?.mode === MODE ? stateSummary(result, summaryOptions) : result));
    console.log(JSON.stringify({
        executionScope,
        workflowRoot: path.resolve(workflowRoot),
        ...printable
    }, null, 2));
    return result;
}

if (require.main === module) {
    try { run(); } catch (error) { console.error(`manual v6 task runner 失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
    STATE_VERSION, MODE, ROLES, DEPENDENCIES, DOWNSTREAM, ACTIVE_LIMIT,
    AUTHOR_OUTPUT_CONTRACT, REVISION_OUTPUT_CONTRACT,
    runnerPaths, initializeState, validateState, dependencyInputKey, invalidateFrom,
    refreshReadiness, registerPacket, activeCount, claimTasks, startTask, submitTask,
    failTask, retryTask, abandonTask, verifyBoundInputs, stateSummary, recordsEnvelopeStatus,
    validateProductionAuthorOutput, validateProductionRevisionOutput,
    parseArgs, run
};

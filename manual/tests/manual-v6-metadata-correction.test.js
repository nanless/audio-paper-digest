'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ALLOWED_TAGS, DOCUMENT_TYPES } = require('../../scripts/utils.js');
const {
    CORRECTION_PACKET_CONTRACT,
    CORRECTION_OUTPUT_CONTRACT,
    CORRECTION_RECEIPT_CONTRACT,
    CORRECTION_MANIFEST_CONTRACT,
    CORRECTION_ACTIVE_LIMIT,
    MUTABLE_FIELDS,
    stableSha256,
    validateExactMetadataFields,
    validatePacket,
    validateCorrection,
    validateReceipt,
    validateManifestObject,
    loadValidatedManifest,
    initializeCorrectionState,
    validateCorrectionState,
    verifyCorrectionState,
    registerCorrectionPacket,
    claimCorrectionTasks,
    startCorrectionTask,
    submitCorrectionTask,
    abandonCorrectionTask,
    retryCorrectionTask,
    createPacketArtifact,
    buildManifest,
    correctionPaths,
    parseArgs
} = require('../scripts/manual-v6-metadata-correction.js');

const ID = '2608.12345';
const DATE = '2026-08-29';
const SHA = 'a'.repeat(64);
const QUEUED_AT = '2026-08-29T08:00:00.000+08:00';
const STARTED_AT = '2026-08-29T08:01:00.000+08:00';

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.writeFileSync(filePath, bytes);
    return { fileSha256: sha256Bytes(bytes), semanticSha256: stableSha256(value) };
}

function setupMinimalProduction(currentDir, ids = [ID]) {
    const dateRoot = path.join(currentDir, 'manual-v6', DATE);
    const papers = {};
    for (const paperId of ids) {
        const artifactRoot = path.join(dateRoot, 'task-runner', 'tasks', paperId);
        const payloadPath = path.join(artifactRoot, 'draft', 'revision-record-payload.json');
        const payload = { paperId, type: 'free text', task: 'speech', tags: ['speech'] };
        const payloadHash = writeJson(payloadPath, payload);
        const revisionPath = path.join(artifactRoot, 'outputs', 'author-revision.json');
        const revision = {
            version: 2,
            contract: 'manual-v6-author-revision-output-v2',
            paperId,
            recordPayload: {
                path: 'draft/revision-record-payload.json',
                fileSha256: payloadHash.fileSha256,
                semanticSha256: payloadHash.semanticSha256
            }
        };
        const revisionHash = writeJson(revisionPath, revision);
        papers[paperId] = {
            tasks: {
                author_revision: {
                    status: 'validated',
                    outputPath: revisionPath,
                    outputFileSha256: revisionHash.fileSha256,
                    outputSemanticSha256: revisionHash.semanticSha256
                }
            }
        };
    }
    writeJson(path.join(dateRoot, 'task-runner', 'state.json'), {
        expectedPaperIds: [...ids].sort(), papers
    });
    return dateRoot;
}

function packetFixture() {
    const packet = {
        version: 1,
        contract: CORRECTION_PACKET_CONTRACT,
        date: DATE,
        paperId: ID,
        role: 'metadata_correction',
        singlePaperOnly: true,
        isolatedContext: true,
        mutableFields: [...MUTABLE_FIELDS],
        allowedDocumentTypes: [...DOCUMENT_TYPES],
        allowedTags: [...ALLOWED_TAGS].sort(),
        revisionOutput: { path: 'task-runner/tasks/2608.12345/outputs/author-revision.json', fileSha256: SHA, semanticSha256: SHA },
        recordPayload: { path: 'task-runner/tasks/2608.12345/draft/revision-record-payload.json', fileSha256: SHA, semanticSha256: SHA }
    };
    packet.packetSha256 = stableSha256(packet);
    return packet;
}

function correctionFixture(packet) {
    return {
        version: 1,
        contract: CORRECTION_OUTPUT_CONTRACT,
        date: DATE,
        paperId: ID,
        role: 'metadata_correction',
        taskName: 'metadata-correction-2608.12345-r1',
        passed: true,
        singlePaperOnly: true,
        isolatedContext: true,
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        packetSha256: packet.packetSha256,
        originalRecordPayload: { fileSha256: SHA, semanticSha256: SHA },
        changes: {
            type: '方法研究',
            task: '#语音识别',
            tags: '#语音识别 #多语言 #低资源'
        },
        changedFields: ['/tags', '/task', '/type'],
        rationale: '依据当前论文题目、任务定义和全文方法证据，将自由文本分类收敛到仓库受控词表。'
    };
}

function receiptFixture(packet, correction) {
    return {
        version: 1,
        contract: CORRECTION_RECEIPT_CONTRACT,
        date: DATE,
        paperId: ID,
        role: 'metadata_correction',
        taskName: correction.taskName,
        singlePaperOnly: true,
        isolatedContext: true,
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        consumedPacketSha256: packet.packetSha256,
        correctionSha256: stableSha256(correction),
        queuedAt: '2026-08-29T08:00:00.000+08:00',
        startedAt: '2026-08-29T08:01:00.000+08:00',
        completedAt: '2026-08-29T08:02:00.000+08:00',
        revision: 1
    };
}

describe('Manual v6 explicit metadata correction protocol', () => {
    it('只接受 canonical type、单个白名单 task 与规范 3-5 tags 字符串', () => {
        assert.deepEqual(validateExactMetadataFields({
            type: '方法研究', task: '#语音识别', tags: '#语音识别 #多语言 #低资源'
        }), { type: '方法研究', task: '#语音识别', tags: '#语音识别 #多语言 #低资源' });
        assert.throws(() => validateExactMetadataFields({
            type: '研究论文', task: '#语音识别', tags: '#语音识别 #多语言 #低资源'
        }), /受控文档类型/);
        assert.throws(() => validateExactMetadataFields({
            type: '方法研究', task: '语音识别', tags: '#语音识别 #多语言 #低资源'
        }), /task/);
        assert.throws(() => validateExactMetadataFields({
            type: '方法研究', task: '#语音识别', tags: ['#语音识别', '#多语言', '#低资源']
        }), /数组不允许/);
    });

    it('packet/correction/receipt 精确绑定 Terra-high 单篇 provenance 与三字段 delta', () => {
        const packet = packetFixture();
        validatePacket(packet, { date: DATE, paperId: ID });
        const payload = { paperId: ID, type: 'free text', task: 'speech', tags: ['speech'] };
        const correction = correctionFixture(packet);
        assert.equal(validateCorrection(correction, packet, payload, { fullPreflight: false }).passed, true);
        assert.equal(validateReceipt(receiptFixture(packet, correction), packet, correction).model, 'gpt-5.6-terra');
        const extra = { ...correction, summary: '禁止夹带第四字段' };
        assert.throws(() => validateCorrection(extra, packet, payload, { fullPreflight: false }), /字段必须精确/);
        const badReceipt = { ...receiptFixture(packet, correction), model: 'gpt-5.6-sol' };
        assert.throws(() => validateReceipt(badReceipt, packet, correction), /provenance/);
    });

    it('三字段修正后仍缺 author-owned 基础内容时预检 fail closed', () => {
        const packet = packetFixture();
        const correction = correctionFixture(packet);
        const incomplete = { paperId: ID, type: 'free text', task: 'speech', tags: ['speech'] };
        assert.throws(
            () => validateCorrection(correction, packet, incomplete),
            /不是纯三字段可修复记录/
        );
    });

    it('空 correction 集也必须由 sorted batch set、Merkle 与 manifest SHA 闭环', () => {
        const manifest = {
            version: 1,
            contract: CORRECTION_MANIFEST_CONTRACT,
            date: DATE,
            expectedPaperIds: [ID],
            correctedPaperIds: [],
            corrections: [],
            correctionTaskState: {
                path: 'metadata-corrections/state.json',
                fileSha256: SHA,
                semanticSha256: SHA,
                generation: 1
            },
            merkleRoot: stableSha256({
                contract: 'manual-v6-metadata-correction-merkle-v1', orderedLeaves: []
            })
        };
        manifest.manifestSha256 = stableSha256(manifest);
        assert.equal(validateManifestObject(manifest, { date: DATE, expectedPaperIds: [ID] }).date, DATE);
        const drift = structuredClone(manifest); drift.merkleRoot = 'b'.repeat(64);
        assert.throws(() => validateManifestObject(drift, { date: DATE, expectedPaperIds: [ID] }), /Merkle/);
    });

    it('persistent state 强制三槽、批次 taskName 永不复用且 retry 退休历史名称', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-correction-state-'));
        const ids = ['2608.12345', '2608.12346', '2608.12347', '2608.12348'];
        setupMinimalProduction(root, ids);
        const state = initializeCorrectionState(DATE, root, QUEUED_AT);
        for (const paperId of ids) {
            createPacketArtifact({ date: DATE, paperId, currentDir: root });
            registerCorrectionPacket(state, DATE, paperId, root);
        }
        const first = claimCorrectionTasks(state, { limit: CORRECTION_ACTIVE_LIMIT, now: QUEUED_AT });
        assert.equal(first.claimed.length, 3);
        assert.equal(first.active, 3);
        assert.equal(claimCorrectionTasks(state, { limit: 3, now: QUEUED_AT }).claimed.length, 0);
        startCorrectionTask(state, first.claimed[0].claimId, 'metadata-correction-unique-a', STARTED_AT);
        assert.throws(
            () => startCorrectionTask(state, first.claimed[1].claimId, 'metadata-correction-unique-a', STARTED_AT),
            /重复|复用/
        );
        abandonCorrectionTask(
            state, first.claimed[0].claimId, 'leaf 进程异常退出，显式释放槽位',
            '2026-08-29T08:02:00.000+08:00'
        );
        retryCorrectionTask(state, ids[0]);
        const reclaimed = claimCorrectionTasks(state, { paperId: ids[0], limit: 1, now: QUEUED_AT });
        assert.throws(
            () => startCorrectionTask(state, reclaimed.claimed[0].claimId, 'metadata-correction-unique-a', STARTED_AT),
            /重复|复用/
        );
        assert.equal(validateCorrectionState(state).activeLimit, 3);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('submit 拒绝未 start 与伪造 queuedAt，并封印 output/receipt raw+semantic SHA 后检测漂移', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-correction-submit-'));
        setupMinimalProduction(root);
        const state = initializeCorrectionState(DATE, root, QUEUED_AT);
        const packetItem = createPacketArtifact({ date: DATE, paperId: ID, currentDir: root });
        registerCorrectionPacket(state, DATE, ID, root);
        const claim = claimCorrectionTasks(state, { limit: 1, now: QUEUED_AT }).claimed[0];
        assert.throws(
            () => submitCorrectionTask(state, claim.claimId, DATE, root, { fullPreflight: false }),
            /running/
        );
        startCorrectionTask(state, claim.claimId, 'metadata-correction-stateful', STARTED_AT);
        const correction = correctionFixture(packetItem.packet);
        correction.taskName = 'metadata-correction-stateful';
        correction.originalRecordPayload = {
            fileSha256: packetItem.packet.recordPayload.fileSha256,
            semanticSha256: packetItem.packet.recordPayload.semanticSha256
        };
        const paths = correctionPaths(DATE, ID, root);
        writeJson(paths.correctionPath, correction);
        const forged = receiptFixture(packetItem.packet, correction);
        forged.taskName = correction.taskName;
        forged.queuedAt = '2026-08-29T07:59:00.000+08:00';
        forged.startedAt = STARTED_AT;
        writeJson(paths.receiptPath, forged);
        assert.throws(
            () => submitCorrectionTask(state, claim.claimId, DATE, root, { fullPreflight: false }),
            /persistent task state/
        );
        forged.queuedAt = QUEUED_AT;
        writeJson(paths.receiptPath, forged);
        const submitted = submitCorrectionTask(state, claim.claimId, DATE, root, { fullPreflight: false });
        assert.equal(submitted.status, 'validated');
        verifyCorrectionState(state, DATE, root, { fullPreflight: false });
        fs.appendFileSync(paths.correctionPath, ' ');
        assert.throws(
            () => verifyCorrectionState(state, DATE, root, { fullPreflight: false }),
            /漂移/
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('manifest 拒绝任何仍需 correction 但未 validated 的单篇任务', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-correction-manifest-state-'));
        setupMinimalProduction(root);
        const state = initializeCorrectionState(DATE, root, QUEUED_AT);
        state.generation = 1;
        const paths = correctionPaths(DATE, ID, root);
        writeJson(paths.statePath, state);
        assert.throws(
            () => buildManifest({ date: DATE, currentDir: root }),
            /拒绝未 validated/
        );
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('manifest 文件 symlink 与 CLI 旁路参数均被拒绝', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-correction-'));
        const target = path.join(root, 'target.json');
        const link = path.join(root, 'metadata-corrections-manifest.json');
        fs.writeFileSync(target, '{}');
        fs.symlinkSync(target, link);
        assert.throws(() => loadValidatedManifest(link, {
            date: DATE, dateRoot: root, expectedPaperIds: [ID]
        }), /symlink/);
        assert.deepEqual(parseArgs(['packet', '--date', DATE, '--paper', ID]), {
            action: 'packet', date: DATE, paperId: ID, force: false
        });
        assert.throws(() => parseArgs(['submit', '--date', DATE, '--paper', ID, '--force']), /缺少参数|不接受 --paper/);
        assert.deepEqual(parseArgs(['claim', '--date', DATE, '--limit', '2']), {
            action: 'claim', date: DATE, force: false, limit: 2
        });
        fs.rmSync(root, { recursive: true, force: true });
    });
});

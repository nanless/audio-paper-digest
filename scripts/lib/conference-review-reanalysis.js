'use strict';

// Explicit blog-review-failure-bound full paper re-analysis for conference processes.
// Never deletes or mutates prior executions, prior failure records, or billing ledgers.
// Runs the standard paid analysis + staging pipeline under a fresh deterministic executionId
// and atomically adopts the newly completed execution under the real process lock and CAS.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const processApi = require('./conference-process.js');

const MANIFEST_CONTRACT = 'conference-review-reanalysis-manifest-v1';
const RECEIPT_CONTRACT = 'conference-review-reanalysis-adoption-v1';
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(message) {
    throw Object.assign(new Error(`会议审查重分析被拒：${message}`), {
        code: 'CONFERENCE_REVIEW_REANALYSIS_INTEGRITY',
        category: 'integrity',
        scope: 'run',
        retryable: false
    });
}

function readRegularJson(filename, label, maxBytes = 64 * 1024 * 1024) {
    if (!path.isAbsolute(filename || '')) fail(`${label} 必须是绝对路径`);
    let stat;
    try { stat = fs.lstatSync(filename); } catch { fail(`${label} 不存在：${filename}`); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > maxBytes) {
        fail(`${label} 不是合法普通文件：${filename}`);
    }
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== stat.size) fail(`${label} 读取期间发生变化：${filename}`);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(`${label} 不是合法 JSON：${filename}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是 JSON 对象：${filename}`);
    return { filename, bytes, sha256: sha256(bytes), value };
}

function exactKeys(obj, keys, label) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(`${label} 必须是对象`);
    const actual = Object.keys(obj).sort().join(',');
    const expected = [...keys].sort().join(',');
    if (actual !== expected) fail(`${label} 字段集合不匹配（期望 ${expected}，实际 ${actual}）`);
}

function findGenerationRecord(runtimeRoot, conferenceId, processId, expectedSemanticSha) {
    const pubDir = path.join(runtimeRoot, 'conference-publications', conferenceId, processId);
    if (!fs.existsSync(pubDir)) fail(`会议发布目录不存在：${pubDir}`);
    const names = fs.readdirSync(pubDir).filter(name => (
        name === 'generation.json' || /^generation\.superseded-[a-f0-9]{12}\.json$/.test(name)
    )).sort();
    for (const name of names) {
        const record = readRegularJson(path.join(pubDir, name), `生成记录 ${name}`);
        const body = { ...record.value };
        const declared = body.generationSha256;
        delete body.generationSha256;
        if (!SHA_RE.test(declared || '') || processApi.stableHash(body) !== declared) continue;
        if (declared === expectedSemanticSha
            && record.value.conferenceId === conferenceId
            && record.value.processId === processId) {
            return record;
        }
    }
    fail(`找不到语义 SHA=${expectedSemanticSha} 对应的会议生成记录`);
}

function verifyReviewFailure(runtimeRoot, failureSha, pageRecord, paperId, aggregateRecord = null) {
    if (!SHA_RE.test(failureSha || '')) fail(`reviewFailureSha256 格式非法：${paperId}`);
    const filename = path.join(runtimeRoot, 'conference-publications', 'page-review-failures', `${failureSha}.json`);
    const loaded = readRegularJson(filename, `审查失败记录 ${failureSha}`);
    const record = loaded.value;
    const body = { ...record };
    delete body.failureSha256;
    if (record.failureSha256 !== failureSha || processApi.stableHash(body) !== failureSha) {
        fail(`审查失败记录自身 SHA 不闭合：${failureSha}`);
    }
    if (record.passed !== false || record.completed !== true || record.failureKind !== 'content') {
        fail(`审查失败记录不是完整内容拒稿：${failureSha}`);
    }
    const matchesPaper = record.paperId === paperId && record.path === pageRecord.path && record.sha256 === pageRecord.sourceSha256;
    const matchesAggregate = record.paperId === null && aggregateRecord
        && record.path === aggregateRecord.path && record.sha256 === aggregateRecord.sourceSha256;
    if (!matchesPaper && !matchesAggregate) {
        fail(`审查失败记录与目标论文页面或汇总页面 SHA 不一致：${paperId}`);
    }
    return loaded;
}

function reanalysisExecutionId(processId, paperId, manifestSha256) {
    return processApi.deterministicUuid(processId, paperId, `review-reanalysis:${manifestSha256}`);
}

function loadAndValidateManifest({ manifestPath, state, runtimeRoot, analysisRoot }) {
    const loaded = readRegularJson(manifestPath, '审查重分析清单');
    const manifest = loaded.value;
    exactKeys(manifest, ['contract', 'conferenceId', 'processId', 'baseGenerationSha256', 'members'], '审查重分析清单');
    if (manifest.contract !== MANIFEST_CONTRACT) fail(`清单合同非法：${manifest.contract}`);
    if (manifest.conferenceId !== state.authority.conferenceId || manifest.processId !== state.processId) {
        fail('清单 conferenceId 或 processId 与当前进程不一致');
    }
    if (!SHA_RE.test(manifest.baseGenerationSha256 || '')) fail('baseGenerationSha256 格式非法');
    if (!Array.isArray(manifest.members) || manifest.members.length === 0) fail('members 必须为非空数组');

    const generation = findGenerationRecord(runtimeRoot, manifest.conferenceId, manifest.processId, manifest.baseGenerationSha256);
    const pagesByPaperId = new Map();
    let aggregateRecord = null;
    for (const file of (generation.value.files || [])) {
        if (file && file.kind === 'paper' && typeof file.paperId === 'string') {
            pagesByPaperId.set(file.paperId, file);
        } else if (file && file.kind === 'aggregate' && typeof file.path === 'string') {
            aggregateRecord = file;
        }
    }

    const seen = new Set();
    const validatedMembers = [];
    for (const member of manifest.members) {
        exactKeys(member, ['paperId', 'previousExecutionId', 'previousAnalysisFileSha256', 'reviewFailureSha256', 'reason'], '清单成员');
        const { paperId, previousExecutionId, previousAnalysisFileSha256, reviewFailureSha256, reason } = member;
        if (typeof paperId !== 'string' || !paperId.trim() || seen.has(paperId)) fail(`paperId 非法或重复：${paperId}`);
        seen.add(paperId);
        if (!UUID_RE.test(previousExecutionId || '') || !SHA_RE.test(previousAnalysisFileSha256 || '')) {
            fail(`成员旧执行 ID 或旧分析 SHA 非法：${paperId}`);
        }
        if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) fail(`成员缺少合法原因说明：${paperId}`);

        const item = state.items?.[paperId];
        if (!item) fail(`论文不在当前进程中：${paperId}`);
        if (item.status !== 'complete') fail(`论文当前不是 complete 状态，不能进入审查重分析：${paperId}`);
        if (item.analysisRunId !== previousExecutionId) {
            fail(`论文当前 analysisRunId 与清单 previousExecutionId 不一致：${paperId}`);
        }
        if (item.analysisProof?.analysisSha256 !== previousAnalysisFileSha256) {
            fail(`论文当前 analysisSha256 与清单 previousAnalysisFileSha256 不一致：${paperId}`);
        }

        const prevAnalysisPath = path.join(analysisRoot, previousExecutionId, 'analysis.json');
        const prevAnalysis = readRegularJson(prevAnalysisPath, `旧分析文件 ${previousExecutionId}`);
        if (prevAnalysis.sha256 !== previousAnalysisFileSha256) {
            fail(`磁盘旧分析字节 SHA 与清单不一致：${paperId}`);
        }

        const pageRecord = pagesByPaperId.get(paperId);
        if (!pageRecord) fail(`原生成记录缺少论文页面：${paperId}`);
        const verifiedFailure = verifyReviewFailure(runtimeRoot, reviewFailureSha256, pageRecord, paperId, aggregateRecord);

        const newExecutionId = reanalysisExecutionId(state.processId, paperId, loaded.sha256);
        if (newExecutionId === previousExecutionId) fail(`新执行 ID 与旧执行 ID 冲突：${paperId}`);

        validatedMembers.push({
            ...member,
            newExecutionId,
            verifiedReviewFailure: {
                paperId,
                reviewFailureSha256,
                stage: verifiedFailure.value.stage || '',
                issues: Array.isArray(verifiedFailure.value.issues) ? verifiedFailure.value.issues : []
            }
        });
    }
    validatedMembers.sort((a, b) => a.paperId.localeCompare(b.paperId));
    return { manifestPath: loaded.filename, manifestSha256: loaded.sha256, manifest, members: validatedMembers };
}

async function runReviewReanalysisBatch({ manifestPath, directory, state, shared, context, options }, deps) {
    const runtimeRoot = path.resolve(deps.files.conferenceProcessDir, '..');
    const analysisRoot = deps.files.conferenceAnalysisDir;
    const plan = loadAndValidateManifest({ manifestPath, state, runtimeRoot, analysisRoot });
    const stateFile = path.join(directory, 'state.json');
    const processOne = deps.processPaper || processApi.processOne;
    const recovery = require('./conference-process-recovery.js');
    const roundApi = require('./analysis-failure-rounds.js');

    const proofs = new Map();
    const failures = [];
    const maxRounds = Math.min(recovery.MAX_ATTEMPTS, deps.analysisConfig?.batchMaxRounds ?? 3);

    await roundApi.runFailureRounds(plan.members, {
        concurrency: Math.min(options.concurrency || 3, plan.members.length),
        maxRounds,
        getItemId: member => member.paperId,
        runItem: async member => {
            const currentItem = state.items[member.paperId];
            const syntheticItem = {
                ...currentItem,
                analysisRunId: member.newExecutionId,
                attempts: 0,
                retryReleases: []
            };
            try {
                const { withReviewReanalysisGuidance } = require('./conference-analysis-context.js');
                const runPaper = () => processOne(context, shared, syntheticItem, deps);
                const proof = await (member.verifiedReviewFailure
                    ? withReviewReanalysisGuidance(member.verifiedReviewFailure, runPaper)
                    : runPaper());
                proofs.set(member.paperId, { member, proof });
                return { success: true };
            } catch (error) {
                const failure = recovery.classifyFailure(error, deps.now());
                if (failure.systemic) throw error;
                failures.push({ paperId: member.paperId, newExecutionId: member.newExecutionId, ...failure });
                return { success: false, error, retryable: failure.retryable, scope: 'paper' };
            }
        }
    });

    if (proofs.size !== plan.members.length) {
        return {
            status: 'partial',
            processId: state.processId,
            conferenceId: state.authority.conferenceId,
            reviewReanalysis: true,
            completed: proofs.size,
            failed: plan.members.length - proofs.size,
            failures
        };
    }

    // All requested papers succeeded through full analysis + qualification + staging.
    // Persist immutable adoption receipts before atomically updating state.json under CAS.
    const previousStateSha256 = state.stateSha256;
    const adoptions = [];
    for (const member of plan.members) {
        const { proof } = proofs.get(member.paperId);
        const previousItem = structuredClone(state.items[member.paperId]);
        const previousItemSha256 = processApi.stableHash(previousItem);
        const receiptBody = {
            contract: RECEIPT_CONTRACT,
            processId: state.processId,
            conferenceId: state.authority.conferenceId,
            previousStateSha256,
            manifestFile: plan.manifestPath,
            manifestSha256: plan.manifestSha256,
            paperId: member.paperId,
            reviewFailureSha256: member.reviewFailureSha256,
            reason: member.reason,
            previousExecutionId: member.previousExecutionId,
            previousAnalysisFileSha256: member.previousAnalysisFileSha256,
            previousItemSha256,
            previousItem,
            newExecutionId: member.newExecutionId,
            proof,
            adoptedAt: deps.now()
        };
        const receiptSha256 = processApi.stableHash(receiptBody);
        const receipt = { ...receiptBody, receiptSha256 };
        const receiptFile = `review-reanalysis-adoption-${member.newExecutionId}-${previousStateSha256.slice(0, 12)}.json`;
        processApi.exactFile(path.join(directory, receiptFile), processApi.canonicalBytes(receipt));
        adoptions.push({
            paperId: member.paperId,
            newExecutionId: member.newExecutionId,
            proof,
            adoptionRecord: {
                manifestFile: plan.manifestPath,
                manifestSha256: plan.manifestSha256,
                reviewFailureSha256: member.reviewFailureSha256,
                previousExecutionId: member.previousExecutionId,
                previousAnalysisFileSha256: member.previousAnalysisFileSha256,
                previousStateSha256,
                previousItemSha256,
                newExecutionId: member.newExecutionId,
                receiptFile,
                receiptSha256
            }
        });
    }

    const nextState = deps.engine.updateJsonFileLocked(stateFile, current => {
        const checked = processApi.assertState(current);
        if (checked.stateSha256 !== previousStateSha256) {
            fail('审查重分析采纳前进程 CAS 发生变化');
        }
        const next = structuredClone(checked);
        for (const entry of adoptions) {
            const currentItem = next.items[entry.paperId];
            if (!currentItem || currentItem.analysisRunId !== entry.adoptionRecord.previousExecutionId) {
                fail(`采纳前论文执行 ID 发生变化：${entry.paperId}`);
            }
            const updatedItem = {
                ...currentItem,
                analysisRunId: entry.newExecutionId,
                analysisProof: entry.proof.analysisProof,
                pageProof: entry.proof.pageProof,
                status: 'complete',
                readerRefreshRequired: false,
                lastError: null,
                lastFailure: null,
                reviewRequired: null,
                retryNotBefore: null,
                updatedAt: deps.now(),
                reviewReanalysisAdoption: entry.adoptionRecord
            };
            delete updatedItem.readerRevision;
            delete updatedItem.textMaintenanceAdoption;
            delete updatedItem.sourceResourceCorrectionAdoption;
            next.items[entry.paperId] = updatedItem;
        }
        next.status = 'running';
        next.aggregate = null;
        next.completionReceiptSha256 = null;
        next.generation = checked.generation + 1;
        next.updatedAt = deps.now();
        next.stateSha256 = processApi.stateDigest(next);
        return processApi.assertState(next);
    });

    if (shared.retainedSources) {
        for (const entry of adoptions) {
            const original = shared.retainedSources.get(entry.adoptionRecord.previousExecutionId);
            if (original) {
                shared.retainedSources.delete(entry.adoptionRecord.previousExecutionId);
                shared.retainedSources.set(entry.newExecutionId, original);
            }
        }
    }

    return {
        status: 'adopted',
        state: nextState,
        adopted: adoptions.map(entry => ({
            paperId: entry.paperId,
            previousExecutionId: entry.adoptionRecord.previousExecutionId,
            newExecutionId: entry.newExecutionId,
            receiptFile: entry.adoptionRecord.receiptFile,
            receiptSha256: entry.adoptionRecord.receiptSha256
        }))
    };
}

module.exports = {
    MANIFEST_CONTRACT,
    RECEIPT_CONTRACT,
    reanalysisExecutionId,
    loadAndValidateManifest,
    runReviewReanalysisBatch
};

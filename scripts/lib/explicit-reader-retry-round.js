'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const grantScope = new AsyncLocalStorage();
const requestScope = new AsyncLocalStorage();
const CONTRACT = 'reader-explicit-paid-retry-round-v1';
const LOCAL_REPAIR_CONTRACT = 'reader-explicit-parent-local-repair-v1';
const parentRecovery = require('./reader-parent-recovery');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const idOf = paper => String(paper.arxivId || paper.paperId || '').replace(/v\d+$/, '');
// 循环依赖中的半成品导出不能固定；只记住已加载完成的模块引用。
const moduleReferences = new Map();
function useModule(id) {
    if (moduleReferences.has(id)) return moduleReferences.get(id);
    const value = require(id);
    if (require.cache[require.resolve(id)]?.loaded) moduleReferences.set(id, value);
    return value;
}
function assertGrant(grant) {
    const local = grant?.contract === LOCAL_REPAIR_CONTRACT;
    const recovery = grant?.contract === parentRecovery.CONTRACT;
    if (recovery) parentRecovery.assertShape(grant);
    if (grant?.fullRegenerationReason !== undefined && (grant.contract !== CONTRACT
        || grant.fullRegenerationReason?.code !== 'complete_failed_draft_no_progress'
        || !/^[a-f0-9]{64}$/.test(grant.fullRegenerationReason.draftSha256 || '')
        || !/^[a-f0-9]{64}$/.test(grant.fullRegenerationReason.issuesSha256 || ''))) {
        throw new Error('Reader 首轮完整再生原因或授权类型不合法');
    }
    if (!grant || ![CONTRACT, LOCAL_REPAIR_CONTRACT, parentRecovery.CONTRACT].includes(grant.contract) || !/^\d{4}\.\d{4,5}$/.test(grant.paperId)
        || !/^[a-f0-9-]{36}$/.test(grant.roundId)
        || ['identitySha256', 'originalIdentitySha256', 'envelopeSha256', 'payloadSha256', 'wholeSha256']
            .some(key => !/^[a-f0-9]{64}$/.test(grant[key] || ''))
        || !/^\d{4}-\d{2}-\d{2}$/.test(grant.batchDate || '') || !/^[a-f0-9-]{36}$/.test(grant.runId || '')
        || !grant.sourceFiles || Object.keys(grant.sourceFiles).sort().join('|') !== ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt'].sort().join('|')
        || Object.values(grant.sourceFiles).some(value => !/^[a-f0-9]{64}$/.test(value))
        || ((local || recovery) && (!/^[a-f0-9-]{36}$/.test(grant.parentRoundId || '')
            || !/^[a-f0-9]{64}$/.test(grant.parentReceiptSha256 || '') || grant.parentRoundId === grant.roundId))
        || (!recovery && (local ? (grant.maxResponses !== 1 || grant.maxFullResponses !== 0
            || grant.maxPhysicalRequests !== 2 || grant.maxReservedOutputTokens !== 32000)
            : (grant.maxResponses !== 3 || grant.maxFullResponses !== 1
                || grant.maxPhysicalRequests !== 6 || grant.maxReservedOutputTokens !== 80000)))) {
        throw new Error('Reader 重试许可的内容或预算不符合要求');
    }
    return grant;
}
function assertFirstFullRegeneration(grant, payload) {
    if (grant.fullRegenerationReason === undefined) return;
    const actual = parentRecovery.fullReason(payload), repair = useModule('./reader-repair');
    if (grant.contract !== CONTRACT || actual?.code !== 'complete_failed_draft_no_progress'
        || repair.hashDraft(actual) !== repair.hashDraft(grant.fullRegenerationReason)) {
        throw new Error('Reader 首轮完整再生原因与真实原失败稿不匹配');
    }
}
function localRepairError(message) {
    return Object.assign(new Error(message), { code: 'READER_LOCAL_REPAIR_PROOF_INVALID', retryable: false,
        scope: 'paper', category: 'reader_recovery', modelRequestClassified: true });
}
function retryInputError(code, message) {
    return Object.assign(new Error(message), { code, retryable: false,
        scope: 'paper', category: 'reader_recovery', modelRequestClassified: true });
}
function assertLocalRepairParent(directory, grant, currentPayload, currentIdentity) {
    assertGrant(grant);
    if (grant.contract !== LOCAL_REPAIR_CONTRACT) return;
    try {
        const parentFile = paths(directory, grant.parentRoundId).receipt;
        const checked = readMigrationEnvelope(parentFile);
        if (hash(checked.bytes) !== grant.parentReceiptSha256) throw localRepairError('局部修复父轮调用记录已变化');
        const parent = checked.envelope;
        assertGrant(parent.grant);
        assertRequestLedger(parent);
        if (parent.grant.contract !== CONTRACT || parent.status !== 'active'
            || parent.grant.paperId !== grant.paperId || parent.grant.runId !== grant.runId
            || parent.grant.batchDate !== grant.batchDate
            || JSON.stringify(parent.grant.sourceFiles) !== JSON.stringify(grant.sourceFiles)) {
            throw localRepairError('局部修复必须对应同篇、同批和同来源的原付费轮');
        }
        const root = path.dirname(parentFile);
        const indexedSibling = useModule('./reader-proof-read-scope').findReaderReceiptSibling(root, grant.parentRoundId, grant.roundId,
            [LOCAL_REPAIR_CONTRACT, parentRecovery.CONTRACT], { privateFile: false });
        if (indexedSibling === true) throw localRepairError('同一父轮已授权另一局部修复轮');
        if (indexedSibling === undefined) {
            for (const name of fs.readdirSync(root).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
                const other = JSON.parse(fs.readFileSync(path.join(root, name)));
                if ([LOCAL_REPAIR_CONTRACT, parentRecovery.CONTRACT].includes(other.grant?.contract)
                    && other.grant.parentRoundId === grant.parentRoundId && other.grant.roundId !== grant.roundId) {
                    throw localRepairError('同一父轮已授权另一局部修复轮');
                }
            }
        }
        if (currentPayload) {
            const repair = useModule('./reader-repair');
            const draft = repair.parseRecoveryDraft(currentPayload.draft) || repair.parseRecoveryDraft(currentPayload.rawDraft);
            if (currentPayload.explicitReaderRetryRound?.roundId !== grant.parentRoundId
                || currentPayload.status !== 'failed'
                || !draft || draft.sections.length < 12
                || draft.sections.some(section => !section || ['kind', 'heading', 'body'].some(key =>
                    typeof section[key] !== 'string' || !section[key].trim()))) {
                throw localRepairError('局部修复只接受父轮已保存的完整失败稿');
            }
            validatePersistedRound(directory, currentIdentity, currentPayload);
            if (currentPayload.attempts < parent.grant.maxResponses
                && parent.physicalRequests < parent.grant.maxPhysicalRequests
                && parent.reservedOutputTokens < parent.grant.maxReservedOutputTokens) {
                throw localRepairError('父轮仍有正常剩余额度，不开局部修复轮');
            }
        }
    } catch (error) {
        if (error?.modelRequestClassified) throw error;
        throw localRepairError('父轮调用记录或局部修复证明无法核验');
    }
}
function withExplicitLocalRepairRound(paper, grant, callback) {
    if (grant?.contract !== LOCAL_REPAIR_CONTRACT) throw new Error('局部修复需要明确父轮授权');
    return withExplicitRound(paper, grant, callback);
}
function readOwner(paper) {
    const engine = useModule('../analysis-engine');
    const owner = JSON.parse(fs.readFileSync(path.join(engine.getPaperAnalysisLockPath(paper) + '.lock', 'owner.json')));
    if (owner.pid !== process.pid || typeof owner.token !== 'string') throw new Error('明确 Reader 新轮必须持有规范论文锁');
    return owner;
}
function assertScopeLock(scope) {
    if (readOwner(scope.paper).token !== scope.token) throw new Error('Reader 新轮论文锁已变化');
}
function assertRoundSource(paper, grant) {
    assertGrant(grant);
    const fresh = useModule('./fresh-analysis-context');
    if (!fresh.isDailyFreshSourceScope()) throw new Error('明确 Reader 新轮只允许完整封存日更来源');
    fresh.assertFreshPaper(paper);
    const context = fresh.getFreshAnalysisContext();
    const run = JSON.parse(fs.readFileSync(path.join(context.runDir, 'run.json')));
    if (context.runId !== grant.runId || run.batchDate !== grant.batchDate) throw new Error('Reader 新轮批次或运行来源不匹配');
    const generation = paper.freshRewriteProvenance.sourceGeneration;
    const sourceDirectory = path.join(context.runDir, 'sources', grant.paperId, `generation-${String(generation).padStart(6, '0')}`);
    for (const [name, expected] of Object.entries(grant.sourceFiles)) {
        if (hash(fs.readFileSync(path.join(sourceDirectory, name))) !== expected) throw new Error('Reader 新轮四份来源 SHA 不匹配');
    }
    if (grant.paperId !== idOf(paper)) throw new Error('Reader 付费轮与当前论文不匹配');
    return readOwner(paper);
}
function withExplicitRound(paper, grant, callback) {
    const owner = assertRoundSource(paper, grant);
    if (hash(paper.analysisCheckpoint || paper.analysis || '') !== grant.wholeSha256) {
        throw new Error('Reader 新轮授权与锁内当前论文不匹配');
    }
    return grantScope.run({ paper, grant, token: owner.token }, callback);
}
function paths(directory, roundId) {
    const root = path.join(directory, 'explicit-retry-rounds');
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('新轮目录不能是符号链接');
    return { receipt: path.join(root, `${roundId}.json`), archived: path.join(root, `${roundId}.original.json`) };
}
function atomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error('Reader 新轮目录不能是符号链接');
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
}
// A first explicit window may follow two completed, unusable full responses.
// This only recognizes the normal saved stop; it neither repairs the response
// nor grants authority outside the existing source/lock/CAS and budget checks.
function exhaustedInitialFullWithoutLocalDraft(payload, paper) {
    const repair = useModule('./reader-repair');
    if (payload?.status !== 'failed' || payload.explicitReaderRetryRound
        || payload.attempts !== 2 || payload.fullAttempts !== 2 || payload.draft !== null
        || payload.noProgress !== 0 || payload.validationFailureStreak !== 1
        || (payload.transportFailures || 0) !== 0
        || typeof payload.rawDraft !== 'string' || !payload.rawDraft.trim()
        || payload.rawDraft.length > 16 * 1024 * 1024
        || !/^[a-f0-9]{64}$/.test(payload.failureSignature || '')
        || !Array.isArray(payload.issues) || !payload.issues.length
        || payload.issues.some(issue => issue?.path !== null || issue.diagnosticOnly === true
            || !/^读者文章 (?:version 必须为|JSON 无法解析:|顶层 缺少字段:)/.test(issue.message || ''))
        || payload.validationFailureSignature !== repair.validationFailureSignature(payload.issues)
        || paper?.latestAnalysisAttemptErrorCode !== 'READER_FULL_ATTEMPTS_EXHAUSTED'
        || paper.latestAnalysisAttemptErrorCategory !== 'reader_recovery'
        || paper.latestAnalysisAttemptErrorScope !== 'paper'
        || paper.latestAnalysisAttemptRetryable !== false
        || !payload.issues.some(issue => String(paper.latestAnalysisAttemptError || '').includes(issue.message))
        || repair.parseRecoveryDraft(payload.draft) || repair.parseRecoveryDraft(payload.rawDraft)
        || repair.buildTopLevelMetadataRepairContext(payload.rawDraft)) return false;
    try {
        const value = JSON.parse(payload.rawDraft);
        return Boolean(value && typeof value === 'object' && !Array.isArray(value));
    } catch (_) { return false; }
}
function beginExplicitRound(directory, identity, recovered, paper) {
    const scope = grantScope.getStore();
    if (!scope) {
        const root = path.join(directory, 'explicit-retry-rounds');
        if (!fs.existsSync(root)) return null;
        const identityHash = useModule('./reader-repair').hashDraft(identity);
        const matching = fs.readdirSync(root).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
            .map(n => JSON.parse(fs.readFileSync(path.join(root, n))))
            .filter(receipt => receipt.grant?.identitySha256 === identityHash);
        const parentIds = new Set(matching.filter(receipt => [LOCAL_REPAIR_CONTRACT, parentRecovery.CONTRACT].includes(receipt.grant?.contract)
            && ['prepared', 'active'].includes(receipt.status))
            .map(receipt => {
                if (receipt.grant.contract === parentRecovery.CONTRACT) parentRecovery.assertParent(directory, receipt.grant,
                    recovered?.explicitReaderRetryRound?.roundId === receipt.grant.parentRoundId ? recovered : undefined, identity);
                else assertLocalRepairParent(directory, receipt.grant);
                return receipt.grant.parentRoundId;
            }));
        const effective = matching.filter(receipt => !parentIds.has(receipt.grant?.roundId));
        if (effective.some(receipt => receipt.status === 'active'
            && recovered?.explicitReaderRetryRound?.roundId !== receipt.grant.roundId)) {
            throw new Error('明确 Reader 新轮当前记录缺失或凭证不同，拒绝自动首次生成');
        }
        const pending = effective.filter(receipt => receipt.status === 'prepared');
        if (pending.length > 1) throw new Error('Reader 新轮准备事务不唯一');
        return pending.length ? withExplicitRound(paper, pending[0].grant,
            () => beginExplicitRound(directory, identity, recovered, paper)) : null;
    }
    assertScopeLock(scope);
    const repair = useModule('./reader-repair');
    useModule('./fresh-analysis-context').freshReaderAttemptsDirectory(directory);
    const grant = scope.grant;
    if (idOf(paper) !== grant.paperId) {
        throw retryInputError('READER_RETRY_PAPER_MISMATCH', '长文重试许可对应另一篇论文，不能开始新一轮。');
    }
    const currentSourceIdentity = useModule('./fresh-analysis-context').freshAnalysisIdentity(paper.arxivId);
    if (repair.hashDraft(identity.freshAnalysis) !== repair.hashDraft(currentSourceIdentity)) {
        throw new Error('Reader 当前输入身份缺少完整封存来源证明');
    }
    if (repair.hashDraft(identity) !== grant.identitySha256) {
        throw retryInputError('READER_RETRY_INPUT_MISMATCH', '长文当前输入与重试许可不一致，不能沿用许可开始新一轮。');
    }
    if (useModule('../analysis-engine').isSuccessfulAnalysisRecord(paper)) {
        throw retryInputError('READER_RETRY_ALREADY_COMPLETE', '论文已经完成分析，不能按失败稿开始长文重试。');
    }
    const loc = paths(directory, grant.roundId);
    let receipt = fs.existsSync(loc.receipt) ? JSON.parse(fs.readFileSync(loc.receipt)) : null;
    if (receipt && JSON.stringify(receipt.grant) !== JSON.stringify(grant)) throw new Error('同一新轮编号授权不能变化');
    const activeFile = path.join(directory, `${repair.hashDraft(identity)}.json`);
    // 只恢复同一次已授权事务，不再次开一轮。
    if (receipt?.status === 'active') {
        if (recovered?.explicitReaderRetryRound?.roundId !== grant.roundId) throw new Error('已消费新轮的当前记录缺失');
        return null; // 同一授权仅续剩余额度，不重新安装或清零。
    }
    if (!receipt) {
        const old = repair.loadFailedCandidate(directory, identity);
        assertFirstFullRegeneration(grant, old);
        if (grant.contract === parentRecovery.CONTRACT) parentRecovery.assertParent(directory, grant, old, identity);
        else if (grant.contract === LOCAL_REPAIR_CONTRACT) assertLocalRepairParent(directory, grant, old, identity);
        else if (old?.explicitReaderRetryRound) throw new Error('同一当前输入不能再次开明确付费新轮');
        if (!old || repair.hasUnusedImplementationAllowance(old)
            || (grant.contract === CONTRACT
                && old.attempts < (old.explicitReaderRetryRound?.maxResponses || 6)
                && old.noProgress < 2 && old.validationFailureStreak < 2
                && !exhaustedInitialFullWithoutLocalDraft(old, paper))) {
            throw new Error('Reader 候选仍有合法尝试或并非经过校验的失败');
        }
        const originalFile = path.join(directory, `${grant.originalIdentitySha256}.json`);
        const audits = recovered?.readerRecoveryRevisions || [];
        const originalAudit = audits.find(audit => audit.fromIdentitySha256 === grant.originalIdentitySha256
            && audit.oldEnvelopeSha256 === grant.envelopeSha256 && audit.oldPayloadSha256 === grant.payloadSha256);
        const archivedOriginal = originalAudit ? path.join(directory, originalAudit.archivedName) : null;
        const originalLocation = fs.existsSync(originalFile) ? originalFile : archivedOriginal;
        if (!originalLocation || path.dirname(originalLocation) !== path.resolve(directory)) throw new Error('Reader 原记录缺少受控恢复历史');
        const originalStat = fs.lstatSync(originalLocation);
        if (!originalStat.isFile() || originalStat.isSymbolicLink() || originalStat.nlink !== 1
            || (originalStat.mode & 0o777) !== 0o600) throw new Error('Reader 原记录不是安全普通文件');
        const bytes = fs.readFileSync(originalLocation);
        const original = JSON.parse(bytes);
        if (hash(bytes) !== grant.envelopeSha256 || repair.hashDraft(original.identity) !== grant.originalIdentitySha256
            || repair.hashDraft(original.payload) !== grant.payloadSha256) throw new Error('Reader 原稿 SHA 已变化');
        const ignored = useModule('./reader-recovery-revision').ALLOWED_FIELDS;
        const semantic = value => Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.includes(key)));
        if (original.identity.readerRecoveryEpochSha256 !== identity.readerRecoveryEpochSha256
            || repair.hashDraft(semantic(original.identity)) !== repair.hashDraft(semantic(identity))
            || repair.hashDraft(original.identity.freshAnalysis) !== repair.hashDraft(currentSourceIdentity)) {
            throw new Error('Reader 完整实际输入已变化，不能沿用旧失败稿授权');
        }
        if (old.attempts !== original.payload.attempts || old.fullAttempts !== original.payload.fullAttempts) {
            throw new Error('Reader 授权后已有新增响应次数');
        }
        receipt = { contract: CONTRACT, grant, status: 'prepared', oldAttempts: old.attempts,
            oldFullAttempts: old.fullAttempts, oldTransportFailures: old.transportFailures || 0,
            physicalRequests: 0, reservedOutputTokens: 0, requests: [], archivedFile: loc.archived,
            originalLocation, currentArchivedFile: `${loc.archived}.current.json`, currentEnvelopeSha256: hash(fs.readFileSync(activeFile)) };
        atomic(loc.receipt, receipt);
        fs.copyFileSync(originalLocation, loc.archived, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(loc.archived, 0o600);
    }
    if (!fs.existsSync(loc.archived)) {
        if (!fs.existsSync(receipt.originalLocation) || hash(fs.readFileSync(receipt.originalLocation)) !== grant.envelopeSha256) throw new Error('新轮准备后缺少原稿');
        fs.copyFileSync(receipt.originalLocation, loc.archived, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(loc.archived, 0o600);
    }
    if (!fs.existsSync(receipt.currentArchivedFile)) {
        if (!fs.existsSync(activeFile) || hash(fs.readFileSync(activeFile)) !== receipt.currentEnvelopeSha256) {
            throw new Error('明确新轮事务缺少原稿，拒绝自动首次生成');
        }
        fs.renameSync(activeFile, receipt.currentArchivedFile);
    }
    const bytes = fs.readFileSync(loc.archived);
    if (hash(bytes) !== grant.envelopeSha256) throw new Error('明确新轮原稿归档 SHA 不一致');
    const oldEnvelope = JSON.parse(bytes);
    if (repair.hashDraft(oldEnvelope.identity) !== grant.originalIdentitySha256
        || repair.hashDraft(oldEnvelope.payload) !== grant.payloadSha256) throw new Error('明确新轮原证明不一致');
    if (fs.existsSync(activeFile) && hash(fs.readFileSync(activeFile)) !== receipt.currentEnvelopeSha256) {
        const active = repair.loadFailedCandidate(directory, identity);
        if (active?.explicitReaderRetryRound?.roundId !== grant.roundId) throw new Error('新轮安装前已有另一候选');
    } else {
        // 原记录在独立位置完整保留，新轮计数明确独立，不冒充旧次数继续。
        const old = oldEnvelope.payload;
        assertFirstFullRegeneration(grant, old);
        const retainedDraft = repair.parseRecoveryDraft(old.rawDraft) || repair.parseRecoveryDraft(old.draft);
        const next = { status: 'failed',
            draft: retainedDraft ? (repair.parseRecoveryDraft(old.draft) || retainedDraft) : null,
            rawDraft: retainedDraft && typeof old.rawDraft === 'string' ? old.rawDraft : '',
            issues: retainedDraft && Array.isArray(old.issues) ? structuredClone(old.issues) : [],
            ...(retainedDraft && old.ephemeralImageEvidence ? { ephemeralImageEvidence: structuredClone(old.ephemeralImageEvidence) } : {}),
            ...(retainedDraft && old.imageEvidence ? { imageEvidence: structuredClone(old.imageEvidence) } : {}),
            ...(retainedDraft && old.providerImageExclusions ? { providerImageExclusions: structuredClone(old.providerImageExclusions) } : {}),
            attempts: 0,
            fullAttempts: 0, noProgress: 0, failureSignature: '', validationFailureSignature: '',
            validationFailureStreak: 0, transportFailures: 0, implementationRepairAllowanceProof: null,
            ...(old.implementationRepairAllowanceLineage ? { implementationRepairAllowanceLineage: old.implementationRepairAllowanceLineage } : {}),
            ...(old.consumedImplementationAllowanceSha256 ? { consumedImplementationAllowanceSha256: old.consumedImplementationAllowanceSha256 } : {}),
            explicitReaderRetryRound: { contract: CONTRACT, roundId: grant.roundId, receiptFile: loc.receipt,
                maxResponses: grant.maxResponses, maxFullResponses: grant.maxFullResponses,
                ...(grant.fullRegenerationReason !== undefined
                    ? { fullRegenerationReasonSha256: repair.hashDraft(grant.fullRegenerationReason) }
                    : grant.contract === parentRecovery.CONTRACT && grant.mode === 'full'
                    && grant.recoveryReason.code === 'complete_failed_draft_no_progress'
                    ? { fullRegenerationReasonSha256: repair.hashDraft(grant.recoveryReason) } : {}) } };
        repair.saveFailedCandidate(directory, identity, next);
    }
    receipt.status = 'active';
    atomic(loc.receipt, receipt);
    return repair.loadFailedCandidate(directory, identity);
}
function assertRequestLedger(receipt) {
    if (!Array.isArray(receipt.requests)
        || receipt.requests.some(request => !request || !['apiReaderArticle', 'apiReaderRepair'].includes(request.stage)
            || !Number.isFinite(Date.parse(request.at)) || !Number.isSafeInteger(request.tokens) || request.tokens < 1)
        || receipt.requests.length !== receipt.physicalRequests
        || receipt.requests.reduce((sum, request) => sum + request.tokens, 0) !== receipt.reservedOutputTokens
        || ((receipt.grant?.contract === LOCAL_REPAIR_CONTRACT
            || receipt.grant?.contract === parentRecovery.CONTRACT && receipt.grant.mode === 'local')
            && receipt.requests.some(request => request.stage !== 'apiReaderRepair'))) {
        throw new Error('Reader 新轮实际请求明细与次数或输出预算不一致');
    }
}
function readMigrationEnvelope(filename) {
    const checked = useModule('./reader-proof-read-scope').readReaderProofJson(filename, {
        unsafeMessage: 'Reader 新轮实现恢复的原文件不安全'
    });
    return { bytes: checked.bytes, envelope: checked.value };
}

function sameRoundIdentityAfterPublicMigration(directory, identity, payload, receipt) {
    const repair = useModule('./reader-repair');
    const revision = useModule('./reader-recovery-revision');
    const equal = (a, b) => repair.hashDraft(a) === repair.hashDraft(b);
    const unchangedInput = value => Object.fromEntries(Object.entries(value)
        .filter(([key]) => !revision.ALLOWED_FIELDS.includes(key)));
    let current = identity;
    let currentPayload = payload;
    const visited = new Set();
    while (repair.hashDraft(current) !== receipt.grant.identitySha256) {
        const currentHash = repair.hashDraft(current);
        if (visited.has(currentHash)) throw new Error('Reader 新轮实现恢复记录出现循环');
        visited.add(currentHash);
        const matching = (currentPayload.readerRecoveryRevisions || []).filter(audit => audit.toIdentitySha256 === currentHash);
        if (matching.length !== 1) throw new Error('Reader 新轮缺少唯一的公共实现恢复记录');
        const audit = matching[0];
        const archivePattern = new RegExp(`^${audit.fromIdentitySha256}\\.migrated-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.json$`);
        if (audit.contract !== revision.CONTRACT || audit.scope !== 'fresh-run'
            || audit.runId !== receipt.grant.runId || audit.paperId !== identity.paperId
            || !/^[a-f0-9]{64}$/.test(audit.fromIdentitySha256 || '')
            || !archivePattern.test(audit.archivedName || '')) throw new Error('Reader 新轮实现恢复来源记录不符合要求');
        let original;
        try { original = readMigrationEnvelope(path.join(directory, audit.archivedName)); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            original = readMigrationEnvelope(path.join(directory, `${audit.fromIdentitySha256}.json`));
        }
        const old = original.envelope;
        const changedFields = [...new Set([...Object.keys(old.identity), ...Object.keys(current)])]
            .filter(key => !equal(old.identity[key] ?? null, current[key] ?? null)).sort();
        if (hash(original.bytes) !== audit.oldEnvelopeSha256
            || repair.hashDraft(old.identity) !== audit.fromIdentitySha256
            || old.payloadSha256 !== audit.oldPayloadSha256 || repair.hashDraft(old.payload) !== audit.oldPayloadSha256
            || !equal(changedFields, [...audit.changedFields].sort()) || !changedFields.length
            || changedFields.some(field => !revision.ALLOWED_FIELDS.includes(field))
            || old.identity.readerRecoveryEpochSha256 !== current.readerRecoveryEpochSha256
            || !equal(old.identity.readerJsonRequestPolicy ?? null, current.readerJsonRequestPolicy ?? null)
            || old.identity.promptSha256 !== current.promptSha256
            || (old.identity.repairPromptSha256 !== current.repairPromptSha256
                && !(current.promptSha256 === 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380'
                    && ['cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965',
                        '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e',
                        '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65'].includes(old.identity.repairPromptSha256)
                    && current.repairPromptSha256 === 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4'))
            || !equal(unchangedInput(old.identity), unchangedInput(current))
            || !equal(old.payload.explicitReaderRetryRound, payload.explicitReaderRetryRound)
            || old.payload.status !== 'failed' || old.payload.attempts !== audit.attempts
            || old.payload.fullAttempts !== audit.fullAttempts
            || (old.payload.transportFailures || 0) !== audit.transportFailures
            || (currentPayload.transportFailures || 0) < (old.payload.transportFailures || 0)
            || currentPayload.attempts < old.payload.attempts || currentPayload.fullAttempts < old.payload.fullAttempts) {
            throw new Error('Reader 新轮实现恢复改变实际输入、原证明或已用次数');
        }
        current = old.identity;
        currentPayload = old.payload;
    }
    return true;
}
function validatePersistedRound(directory, identity, payload) {
    const proof = payload.explicitReaderRetryRound;
    if (!proof) return;
    if (proof.contract !== CONTRACT || !/^[a-f0-9-]{36}$/.test(proof.roundId || '')
        || !((proof.maxResponses === 3 && proof.maxFullResponses === 1)
            || (proof.maxResponses === 1 && proof.maxFullResponses === 0)
            || (proof.maxResponses === 3 && proof.maxFullResponses === 0))
        || payload.attempts > proof.maxResponses || payload.fullAttempts > proof.maxFullResponses) throw new Error('明确 Reader 新轮正文预算或证明不合法');
    const expected = path.join(directory, 'explicit-retry-rounds', `${proof.roundId}.json`);
    if (path.resolve(proof.receiptFile) !== path.resolve(expected)) throw new Error('Reader 新轮证明路径不合法');
    for (const file of [expected, path.join(directory, 'explicit-retry-rounds', `${proof.roundId}.original.json`)]) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Reader 新轮原稿或证明不是安全普通文件');
    }
    const scopedReader = useModule('./reader-proof-read-scope');
    const receipt = scopedReader.readReaderProofJson(expected, { privateFile: false }).value;
    if (path.resolve(receipt.archivedFile) !== path.resolve(directory, 'explicit-retry-rounds', `${proof.roundId}.original.json`)) throw new Error('Reader 新轮原档路径不合法');
    const originalRecord = scopedReader.readReaderProofJson(receipt.archivedFile, { privateFile: false,
        expectedSha256: receipt.grant.envelopeSha256,
        shaMismatchMessage: 'Reader 新轮原稿或实际请求预算证明不一致' });
    if (originalRecord.sha256 !== receipt.grant.envelopeSha256) throw new Error('Reader 新轮原稿或实际请求预算证明不一致');
    const original = originalRecord.value;
    if (receipt.oldAttempts !== original.payload.attempts
        || receipt.oldFullAttempts !== original.payload.fullAttempts
        || receipt.oldTransportFailures !== (original.payload.transportFailures || 0)) {
        throw new Error('Reader 新轮历史调用次数与原档不一致');
    }
    assertGrant(receipt.grant);
    assertFirstFullRegeneration(receipt.grant, original.payload);
    assertRequestLedger(receipt);
    if (receipt.grant.contract === parentRecovery.CONTRACT) {
        parentRecovery.assertParent(directory, receipt.grant, original.payload, original.identity);
    } else if (receipt.grant.contract === LOCAL_REPAIR_CONTRACT) {
        assertLocalRepairParent(directory, receipt.grant, original.payload, original.identity);
    }
    if (proof.maxResponses !== receipt.grant.maxResponses || proof.maxFullResponses !== receipt.grant.maxFullResponses)
        throw new Error('Reader 保存次数与授权预算不匹配');
    const regenerationReason = receipt.grant.fullRegenerationReason !== undefined
        ? useModule('./reader-repair').hashDraft(receipt.grant.fullRegenerationReason)
        : receipt.grant.contract === parentRecovery.CONTRACT && receipt.grant.mode === 'full'
        && receipt.grant.recoveryReason.code === 'complete_failed_draft_no_progress'
        ? useModule('./reader-repair').hashDraft(receipt.grant.recoveryReason) : undefined;
    if (proof.fullRegenerationReasonSha256 !== regenerationReason)
        throw new Error('Reader 完整无进展再生原因与已核验父账不匹配');
    if (!['prepared', 'active'].includes(receipt.status)
        || path.resolve(receipt.archivedFile) !== path.resolve(directory, 'explicit-retry-rounds', `${proof.roundId}.original.json`)
        || receipt.grant.roundId !== proof.roundId
        || (useModule('./reader-repair').hashDraft(identity) !== receipt.grant.identitySha256
            && !sameRoundIdentityAfterPublicMigration(directory, identity, payload, receipt))
        || hash(fs.readFileSync(receipt.archivedFile)) !== receipt.grant.envelopeSha256
        || !Number.isSafeInteger(receipt.physicalRequests) || receipt.physicalRequests < 0 || receipt.physicalRequests > receipt.grant.maxPhysicalRequests
        || !Number.isSafeInteger(receipt.reservedOutputTokens) || receipt.reservedOutputTokens < 0 || receipt.reservedOutputTokens > receipt.grant.maxReservedOutputTokens) {
        throw new Error('Reader 新轮身份、原稿或实际请求预算证明不一致');
    }
    useModule('./reader-transport-continuation').validate(directory, receipt, identity, payload);
}
// 旧首次装轮代码可能丢失仍在原档中的完整稿。只恢复同一已付轮的正文，不装新预算。
function restoreExplicitRoundOriginalDraft(directory, identity, payload, paper) {
    try { return restoreExplicitRoundOriginalDraftChecked(directory, identity, payload, paper); }
    catch (cause) {
        const error = retryInputError('READER_ORIGINAL_DRAFT_RESTORATION_PROOF_INVALID',
            `同一轮原稿恢复证明无效：${cause.message}`);
        error.cause = cause;
        throw error;
    }
}
function restoreExplicitRoundOriginalDraftChecked(directory, identity, payload, paper) {
    const repair = useModule('./reader-repair');
    if (!payload?.explicitReaderRetryRound || payload.status !== 'failed'
        || payload.draft !== null || !['', '无'].includes(String(payload.rawDraft || '').trim())
        || payload.attempts !== 0 || payload.fullAttempts !== 0
        || useModule('../analysis-engine').isSuccessfulAnalysisRecord(paper)) return payload;
    validatePersistedRound(directory, identity, payload);
    const receiptFile = paths(directory, payload.explicitReaderRetryRound.roundId).receipt;
    const checkedReceipt = readMigrationEnvelope(receiptFile);
    const receipt = checkedReceipt.envelope;
    // 局部子轮或已保存新内容不能借此回到祖先稿；物理请求只证明已预留，不证明收到正文。
    if (receipt.status !== 'active' || receipt.grant.contract !== CONTRACT
        || !receipt.requests.length || receipt.requests.some(request => request.stage !== 'apiReaderArticle')) return payload;
    const source = readMigrationEnvelope(receipt.archivedFile);
    const original = source.envelope;
    const allowedFields = useModule('./reader-recovery-revision').ALLOWED_FIELDS;
    const semantic = value => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !allowedFields.includes(key)));
    if (repair.hashDraft(semantic(original.identity)) !== repair.hashDraft(semantic(identity))
        || original.identity.readerRecoveryEpochSha256 !== identity.readerRecoveryEpochSha256
        || repair.hashDraft(original.identity.readerJsonRequestPolicy ?? null) !== repair.hashDraft(identity.readerJsonRequestPolicy ?? null)) {
        throw retryInputError('READER_ORIGINAL_DRAFT_RESTORATION_PROOF_INVALID', '同一轮原稿恢复的封存来源、实际输入或恢复epoch已变化');
    }
    const draft = repair.parseRecoveryDraft(original.payload?.draft) || repair.parseRecoveryDraft(original.payload?.rawDraft);
    if (!draft || draft.sections.length < 12 || draft.sections.some(section => !section
        || ['kind', 'heading', 'body'].some(key => typeof section[key] !== 'string' || !section[key].trim()))) return payload;
    // 恢复已有稿件不安装新轮；实际长文输入已在上方逐项核验。
    // 主文中的评分和资源可达状态可以更新，但四份来源、论文锁和原调用账仍须完全一致。
    const owner = assertRoundSource(paper, receipt.grant);
    useModule('./fresh-analysis-context').freshReaderAttemptsDirectory(directory);
    const currentSourceIdentity = useModule('./fresh-analysis-context').freshAnalysisIdentity(paper.arxivId);
    if (repair.hashDraft(identity.freshAnalysis) !== repair.hashDraft(currentSourceIdentity)) {
        throw retryInputError('READER_ORIGINAL_DRAFT_RESTORATION_PROOF_INVALID', '同一轮原稿恢复缺少当前封存来源证明');
    }
    const currentFile = path.join(directory, `${repair.hashDraft(identity)}.json`);
    const current = readMigrationEnvelope(currentFile);
    if (repair.hashDraft(current.envelope.identity) !== repair.hashDraft(identity)
        || current.envelope.payloadSha256 !== repair.hashDraft(current.envelope.payload)
        || repair.hashDraft(current.envelope.payload) !== repair.hashDraft(payload)
        || hash(source.bytes) !== receipt.grant.envelopeSha256
        || repair.hashDraft(original.payload) !== receipt.grant.payloadSha256
        || repair.hashDraft(original.identity) !== receipt.grant.originalIdentitySha256
        || hash(fs.readFileSync(receiptFile)) !== hash(checkedReceipt.bytes)) {
        throw retryInputError('READER_ORIGINAL_DRAFT_RESTORATION_PROOF_INVALID', '同一轮原稿恢复的当前候选、原档或付费账已变化');
    }
    const archivedName = `${repair.hashDraft(identity)}.round-original-restoration-${hash(current.bytes)}.json`;
    const archivedFile = path.join(directory, archivedName);
    if (fs.existsSync(archivedFile)) {
        if (hash(readMigrationEnvelope(archivedFile).bytes) !== hash(current.bytes)) {
            throw retryInputError('READER_ORIGINAL_DRAFT_RESTORATION_PROOF_INVALID', '同一轮原稿恢复的占位稿原字节已变化');
        }
    } else {
        const fd = fs.openSync(archivedFile, 'wx', 0o600);
        try { fs.writeFileSync(fd, current.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const next = { ...payload, draft, rawDraft: JSON.stringify(draft),
        draftOrderMappings: original.payload.draftOrderMappings || [],
        issues: original.payload.issues || [], noProgress: 0, failureSignature: '',
        validationFailureSignature: '', validationFailureStreak: 0,
        readerOriginalDraftRestorations: [...(payload.readerOriginalDraftRestorations || []), {
            contract: 'reader-explicit-round-original-draft-restoration-v1', restoredAt: new Date().toISOString(),
            roundId: receipt.grant.roundId, currentIdentitySha256: repair.hashDraft(identity),
            placeholderArchiveName: archivedName, placeholderEnvelopeSha256: hash(current.bytes),
            placeholderPayloadSha256: repair.hashDraft(payload), originalEnvelopeSha256: hash(source.bytes),
            originalPayloadSha256: repair.hashDraft(original.payload), originalDraftSha256: repair.hashDraft(draft),
            originalIdentitySha256: repair.hashDraft(original.identity), parentReceiptSha256: hash(checkedReceipt.bytes),
            preservedAttempts: payload.attempts, preservedFullAttempts: payload.fullAttempts,
            preservedPhysicalRequests: receipt.physicalRequests,
            preservedReservedOutputTokens: receipt.reservedOutputTokens,
            originalAttempts: original.payload.attempts, originalFullAttempts: original.payload.fullAttempts
        }] };
    assertScopeLock({ paper, token: owner.token });
    repair.saveFailedCandidate(directory, identity, next);
    return next;
}

function withPhysicalBudget(proof, paper, callback) {
    if (!proof) return callback();
    const owner = readOwner(paper);
    return requestScope.run({ proof, paper, token: owner.token }, callback);
}
function consumePhysicalRequest(body, options) {
    const scope = requestScope.getStore();
    if (!scope) return;
    assertScopeLock(scope);
    const receipt = JSON.parse(fs.readFileSync(scope.proof.receiptFile));
    assertGrant(receipt.grant);
    assertRequestLedger(receipt);
    if (receipt.status !== 'active' || receipt.grant.roundId !== scope.proof.roundId
        || receipt.grant.paperId !== idOf(scope.paper)
        || options.usageContext?.paperId !== scope.paper.arxivId
        || !['apiReaderArticle', 'apiReaderRepair'].includes(options.usageContext?.stage)) {
        throw new Error('明确 Reader 新轮请求范围不合法');
    }
    if (receipt.grant.contract === parentRecovery.CONTRACT) {
        parentRecovery.assertParent(path.dirname(path.dirname(scope.proof.receiptFile)), receipt.grant);
    }
    if (receipt.grant.contract === LOCAL_REPAIR_CONTRACT
        || receipt.grant.contract === parentRecovery.CONTRACT && receipt.grant.mode === 'local') {
        if (receipt.grant.contract === LOCAL_REPAIR_CONTRACT) assertLocalRepairParent(path.dirname(path.dirname(scope.proof.receiptFile)), receipt.grant);
        if (options.usageContext.stage !== 'apiReaderRepair') {
            const error = new Error('父轮后续局部修复不允许全文请求');
            Object.assign(error, { code: 'READER_LOCAL_REPAIR_FULL_REQUEST_FORBIDDEN', retryable: false,
                scope: 'paper', category: 'reader_budget_exhausted', modelRequestClassified: true });
            throw error;
        }
    }
    const tokens = body.max_tokens ?? body.max_output_tokens;
    if (useModule('./reader-transport-continuation').consume({
        directory: path.dirname(path.dirname(scope.proof.receiptFile)),
        parent: receipt, paper: scope.paper, body, options
    })) return;
    if (!Number.isSafeInteger(tokens) || tokens < 1
        || receipt.physicalRequests >= receipt.grant.maxPhysicalRequests
        || receipt.reservedOutputTokens + tokens > receipt.grant.maxReservedOutputTokens) {
        const error = new Error('明确 Reader 新轮实际请求或输出预算耗尽');
        error.code = 'READER_EXPLICIT_ROUND_BUDGET_EXHAUSTED';
        error.retryable = false;
        error.scope = 'paper';
        error.category = 'reader_budget_exhausted';
        error.modelRequestClassified = true;
        throw error;
    }
    receipt.physicalRequests += 1;
    receipt.reservedOutputTokens += tokens;
    receipt.requests.push({ at: new Date().toISOString(), stage: options.usageContext.stage, tokens });
    atomic(scope.proof.receiptFile, receipt);
}
// 只读查询；任何明确新授权均保留原事务路径，不提前消费或改签。
function hasPreparedOrScopedRound(directory, identity) {
    if (grantScope.getStore()) return true;
    const root = path.join(directory, 'explicit-retry-rounds');
    if (!fs.existsSync(root)) return false;
    const expected = useModule('./reader-repair').hashDraft(identity);
    try {
        for (const name of fs.readdirSync(root)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
            let receipt;
            try { receipt = JSON.parse(fs.readFileSync(path.join(root, name))); }
            catch (_) { return true; }
            if (!receipt || !['prepared', 'active'].includes(receipt.status)
                || !/^[a-f0-9]{64}$/.test(receipt.grant?.identitySha256 || '')) return true;
            if (receipt.status === 'prepared' && receipt.grant.identitySha256 === expected) return true;
        }
        return false;
    } catch (_) { return true; }
}

module.exports = { hasPreparedOrScopedRound, CONTRACT, LOCAL_REPAIR_CONTRACT, PARENT_RECOVERY_CONTRACT: parentRecovery.CONTRACT, withExplicitLocalRepairRound, assertGrant, withExplicitRound, beginExplicitRound,
    withPhysicalBudget, consumePhysicalRequest, validatePersistedRound, restoreExplicitRoundOriginalDraft,
    sameRoundIdentityAfterPublicMigration };

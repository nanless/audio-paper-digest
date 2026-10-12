'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const grantScope = new AsyncLocalStorage();
const requestScope = new AsyncLocalStorage();
const CONTRACT = 'reader-explicit-paid-retry-round-v1';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const idOf = paper => String(paper.arxivId || paper.paperId || '').replace(/v\d+$/, '');
function assertGrant(grant) {
    if (!grant || grant.contract !== CONTRACT || !/^\d{4}\.\d{4,5}$/.test(grant.paperId)
        || !/^[a-f0-9-]{36}$/.test(grant.roundId)
        || ['identitySha256', 'originalIdentitySha256', 'envelopeSha256', 'payloadSha256', 'wholeSha256']
            .some(key => !/^[a-f0-9]{64}$/.test(grant[key] || ''))
        || !/^\d{4}-\d{2}-\d{2}$/.test(grant.batchDate || '') || !/^[a-f0-9-]{36}$/.test(grant.runId || '')
        || !grant.sourceFiles || Object.keys(grant.sourceFiles).sort().join('|') !== ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt'].sort().join('|')
        || Object.values(grant.sourceFiles).some(value => !/^[a-f0-9]{64}$/.test(value))
        || grant.maxResponses !== 3 || grant.maxFullResponses !== 1
        || grant.maxPhysicalRequests !== 6 || grant.maxReservedOutputTokens !== 80000) {
        throw new Error('Reader 重试许可的内容或预算不符合要求');
    }
    return grant;
}
function readOwner(paper) {
    const engine = require('../analysis-engine');
    const owner = JSON.parse(fs.readFileSync(path.join(engine.getPaperAnalysisLockPath(paper) + '.lock', 'owner.json')));
    if (owner.pid !== process.pid || typeof owner.token !== 'string') throw new Error('明确 Reader 新轮必须持有规范论文锁');
    return owner;
}
function assertScopeLock(scope) {
    if (readOwner(scope.paper).token !== scope.token) throw new Error('Reader 新轮论文锁已变化');
}
function withExplicitRound(paper, grant, callback) {
    assertGrant(grant);
    const fresh = require('./fresh-analysis-context');
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
    if (grant.paperId !== idOf(paper)
        || hash(paper.analysisCheckpoint || paper.analysis || '') !== grant.wholeSha256) {
        throw new Error('Reader 新轮授权与锁内当前论文不匹配');
    }
    const owner = readOwner(paper);
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
function beginExplicitRound(directory, identity, recovered, paper) {
    const scope = grantScope.getStore();
    if (!scope) {
        const root = path.join(directory, 'explicit-retry-rounds');
        if (!fs.existsSync(root)) return null;
        const identityHash = require('./reader-repair').hashDraft(identity);
        const matching = fs.readdirSync(root).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))
            .map(n => JSON.parse(fs.readFileSync(path.join(root, n))))
            .filter(receipt => receipt.grant?.identitySha256 === identityHash);
        if (matching.some(receipt => receipt.status === 'active'
            && recovered?.explicitReaderRetryRound?.roundId !== receipt.grant.roundId)) {
            throw new Error('明确 Reader 新轮当前记录缺失或凭证不同，拒绝自动首次生成');
        }
        const pending = matching.filter(receipt => receipt.status === 'prepared');
        if (pending.length > 1) throw new Error('Reader 新轮准备事务不唯一');
        return pending.length ? withExplicitRound(paper, pending[0].grant,
            () => beginExplicitRound(directory, identity, recovered, paper)) : null;
    }
    assertScopeLock(scope);
    const repair = require('./reader-repair');
    require('./fresh-analysis-context').freshReaderAttemptsDirectory(directory);
    const grant = scope.grant;
    const currentSourceIdentity = require('./fresh-analysis-context').freshAnalysisIdentity(paper.arxivId);
    if (repair.hashDraft(identity.freshAnalysis) !== repair.hashDraft(currentSourceIdentity)) {
        throw new Error('Reader 当前输入身份缺少完整封存来源证明');
    }
    if (idOf(paper) !== grant.paperId || repair.hashDraft(identity) !== grant.identitySha256
        || require('../analysis-engine').isSuccessfulAnalysisRecord(paper)) {
        throw new Error('不能停用成功草稿或不同当前输入的 Reader 候选');
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
        if (old?.explicitReaderRetryRound) throw new Error('同一当前输入不能再次开明确付费新轮');
        if (!old || repair.hasUnusedImplementationAllowance(old)
            || (old.attempts < (old.explicitReaderRetryRound?.maxResponses || 6) && old.noProgress < 2 && old.validationFailureStreak < 2)) {
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
        const ignored = require('./reader-recovery-revision').ALLOWED_FIELDS;
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
                maxResponses: grant.maxResponses, maxFullResponses: grant.maxFullResponses } };
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
        || receipt.requests.reduce((sum, request) => sum + request.tokens, 0) !== receipt.reservedOutputTokens) {
        throw new Error('Reader 新轮实际请求明细与次数或输出预算不一致');
    }
}
function readMigrationEnvelope(filename) {
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024 * 1024) {
            throw new Error('Reader 新轮实现恢复的原文件不安全');
        }
        const bytes = fs.readFileSync(fd);
        return { bytes, envelope: JSON.parse(bytes) };
    } finally { fs.closeSync(fd); }
}
function sameRoundIdentityAfterPublicMigration(directory, identity, payload, receipt) {
    const repair = require('./reader-repair');
    const revision = require('./reader-recovery-revision');
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
        || proof.maxResponses !== 3 || proof.maxFullResponses !== 1
        || payload.attempts > 3 || payload.fullAttempts > 1) throw new Error('明确 Reader 新轮正文预算或证明不合法');
    const expected = path.join(directory, 'explicit-retry-rounds', `${proof.roundId}.json`);
    if (path.resolve(proof.receiptFile) !== path.resolve(expected)) throw new Error('Reader 新轮证明路径不合法');
    for (const file of [expected, path.join(directory, 'explicit-retry-rounds', `${proof.roundId}.original.json`)]) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Reader 新轮原稿或证明不是安全普通文件');
    }
    const receipt = JSON.parse(fs.readFileSync(expected));
    if (path.resolve(receipt.archivedFile) !== path.resolve(directory, 'explicit-retry-rounds', `${proof.roundId}.original.json`)) throw new Error('Reader 新轮原档路径不合法');
    const originalBytes = fs.readFileSync(receipt.archivedFile);
    if (hash(originalBytes) !== receipt.grant.envelopeSha256) throw new Error('Reader 新轮原稿或实际请求预算证明不一致');
    const original = JSON.parse(originalBytes);
    if (receipt.oldAttempts !== original.payload.attempts
        || receipt.oldFullAttempts !== original.payload.fullAttempts
        || receipt.oldTransportFailures !== (original.payload.transportFailures || 0)) {
        throw new Error('Reader 新轮历史调用次数与原档不一致');
    }
    assertGrant(receipt.grant);
    assertRequestLedger(receipt);
    if (!['prepared', 'active'].includes(receipt.status)
        || path.resolve(receipt.archivedFile) !== path.resolve(directory, 'explicit-retry-rounds', `${proof.roundId}.original.json`)
        || receipt.grant.roundId !== proof.roundId
        || (require('./reader-repair').hashDraft(identity) !== receipt.grant.identitySha256
            && !sameRoundIdentityAfterPublicMigration(directory, identity, payload, receipt))
        || hash(fs.readFileSync(receipt.archivedFile)) !== receipt.grant.envelopeSha256
        || !Number.isSafeInteger(receipt.physicalRequests) || receipt.physicalRequests < 0 || receipt.physicalRequests > 6
        || !Number.isSafeInteger(receipt.reservedOutputTokens) || receipt.reservedOutputTokens < 0 || receipt.reservedOutputTokens > 80000) {
        throw new Error('Reader 新轮身份、原稿或实际请求预算证明不一致');
    }
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
    const tokens = body.max_tokens ?? body.max_output_tokens;
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
module.exports = { CONTRACT, assertGrant, withExplicitRound, beginExplicitRound,
    withPhysicalBudget, consumePhysicalRequest, validatePersistedRound };

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'historical-arxiv-analysis-scheduler-v1';
const VERSION = 1;
const READER_TRANSPORT_COOLDOWN_MS = 5 * 60 * 1000;
const READER_RECOVERY_POLICY_VERSION = 'reader-recovery-policy-v2';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function isStorageWriteFailure(error) {
    const codes = new Set(['EIO', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM']);
    const seen = new Set();
    const inspect = value => {
        if (!value || typeof value !== 'object' || seen.has(value)) return false;
        seen.add(value);
        if (codes.has(value.code)) return true;
        if (value instanceof AggregateError && value.errors.some(inspect)) return true;
        return ['cause', 'errorDetails', 'error'].some(key => inspect(value[key]));
    };
    return inspect(error);
}

function readerImplementationFingerprint() {
    const root = path.join(__dirname, '..', '..');
    const files = ['prompts/api-reader-article.md', 'prompts/api-reader-repair.md',
        'scripts/deep-analyzer.js', 'scripts/editorial-quality.js', 'scripts/lib/reader-contract.js',
        'scripts/lib/reader-tables.js', 'scripts/lib/reader-repair.js', 'scripts/lib/reader-draft-order.js',
        'scripts/lib/reader-recovery-revision.js', 'scripts/lib/reader-source-diagnostics.js'];
    return sha256(`${READER_RECOVERY_POLICY_VERSION}\0`
        + files.map(name => `${name}\0${sha256(fs.readFileSync(path.join(root, name)))}\0`).join(''));
}

function exactOperatorPatchRecovery(runDir, runId, paperId, payload) {
    const repair = require('./reader-repair.js'); const fresh = require('./fresh-rewrite-run.js');
    const audits = payload?.operatorPatches;
    if (!Array.isArray(audits) || !audits.length || !payload.draft) return null;
    const audit = audits.at(-1); const patchSha = String(audit?.patchFileSha256 || '');
    if (audit?.contract !== 'reader-operator-patch-v1' || audit.runId !== runId || audit.paperId !== paperId
        || !/^[a-f0-9]{64}$/.test(patchSha) || !/^[a-f0-9]{64}$/.test(String(audit.oldEnvelopeSha256 || ''))
        || audit.afterDraftSha256 !== repair.hashDraft(payload.draft)
        || audit.archive !== path.posix.join('patches', 'operator-archive', patchSha)) return null;
    try {
        const archive = path.join(runDir, audit.archive);
        const before = fresh.readRegularJson(path.join(archive, 'before.json'));
        const patch = fresh.readRegularJson(path.join(archive, 'patch.json'));
        const intent = fresh.readRegularJson(path.join(archive, 'intent.json')).value;
        if (before.sha256 !== audit.oldEnvelopeSha256 || patch.sha256 !== patchSha
            || fresh.stableHash(intent.audit) !== fresh.stableHash(audit)
            || intent.afterPayloadSha256 !== repair.hashDraft(payload)) return null;
        return audit.afterDraftSha256;
    } catch { return null; }
}

function inspectReaderRecovery({ runId, rootDir, now = new Date().toISOString() } = {}) {
    const fresh = require('./fresh-rewrite-run.js');
    const loaded = fresh.loadRun(runId, { rootDir }); const paper = loaded.analysis.papers[0];
    const stages = paper.analysisManifest?.stages || {}; const reader = stages.apiReaderArticle || {};
    const upstreamReady = stages.primaryAnalysis?.status === 'complete' && stages.scoringAudit?.status === 'complete';
    const attemptsRoot = path.join(loaded.runDir, 'reader-attempts'); const candidates = [];
    try {
        for (const name of fs.readdirSync(attemptsRoot).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
            const filename = path.join(attemptsRoot, name); const stat = fs.lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
            const envelope = fresh.readRegularJson(filename).value;
            if (envelope?.identity?.freshAnalysis?.runId !== runId || envelope.identity.paperId !== loaded.run.paperIds[0]) continue;
            const repair = require('./reader-repair.js');
            if (name !== `${repair.hashDraft(envelope.identity)}.json`) continue;
            const payload = repair.loadFailedCandidate(attemptsRoot, envelope.identity);
            candidates.push({ payload, mtimeMs: stat.mtimeMs });
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); const latestCandidate = candidates[0];
    const payload = latestCandidate?.payload || {};
    const error = String(reader.error || paper.latestAnalysisAttemptError || paper.error || '');
    const failureSignature = String(error ? sha256(error) : payload.failureSignature || '');
    const attempts = Number.isSafeInteger(payload.attempts) ? payload.attempts : 0;
    const noProgress = Number.isSafeInteger(payload.noProgress) ? payload.noProgress : 0;
    const validationFailureStreak = Number.isSafeInteger(payload.validationFailureStreak)
        ? payload.validationFailureStreak : 0;
    const implementationRepairAllowance = Boolean(payload.implementationRepairAllowanceProof);
    const exhausted = /failed candidate exhausted|bounded attempts|连续无进展/i.test(error)
        || (attempts >= 6 && !implementationRepairAllowance) || noProgress >= 2 || validationFailureStreak >= 2;
    const transportOnly = /HTTP 429|rate_limit_exceeded|SSE.*(?:终态|terminal)|SSE_TERMINAL/i.test(error);
    const baseFingerprint = String(reader.fingerprint || loaded.run.sourceExpectations?.[loaded.run.paperIds[0]]?.sourceSnapshotSha256 || '');
    const readerUpdatedMs = new Date(reader.updatedAt || '').getTime();
    const observedAt = Number.isFinite(readerUpdatedMs) ? new Date(readerUpdatedMs).toISOString()
        : latestCandidate ? new Date(latestCandidate.mtimeMs).toISOString() : new Date(now).toISOString();
    const operatorPatchSha256 = exactOperatorPatchRecovery(
        loaded.runDir, runId, loaded.run.paperIds[0], payload);
    return { recoveryKind: upstreamReady && reader.status !== 'complete' ? 'reader' : 'full', upstreamReady,
        recoveryFingerprint: sha256(`${baseFingerprint}\0${readerImplementationFingerprint()}`),
        failureSignature, exhausted, transportOnly, cooldownMs: transportOnly ? READER_TRANSPORT_COOLDOWN_MS : 0,
        attempts, noProgress, validationFailureStreak, implementationRepairAllowance,
        operatorPatchSha256, observedAt };
}

function mergeRecoveryState(existing, observed, now, { attempted = false } = {}) {
    if (!observed || observed.recoveryKind !== 'reader') return { recoveryKind: 'full',
        recoveryFingerprint: null, failureSignature: null, nextEligibleAt: null, exhausted: false,
        implementationRecoveryPendingFingerprint: null, operatorPatchSha256: null,
        operatorRecoveryConsumedSha256: null };
    const fingerprintChanged = Boolean(existing?.recoveryFingerprint
        && existing.recoveryFingerprint !== observed.recoveryFingerprint);
    const pendingImplementationFingerprint = existing?.implementationRecoveryPendingFingerprint || null;
    const implementationRecoveryAvailable = fingerprintChanged
        || pendingImplementationFingerprint === observed.recoveryFingerprint;
    const implementationRecoveryPendingFingerprint = attempted && implementationRecoveryAvailable
        ? null : implementationRecoveryAvailable ? observed.recoveryFingerprint : null;
    const operatorPatchSha256 = observed.operatorPatchSha256 || null;
    const consumedOperatorPatch = existing?.operatorRecoveryConsumedSha256 || null;
    const operatorRecoveryAvailable = Boolean(operatorPatchSha256
        && consumedOperatorPatch !== operatorPatchSha256);
    const operatorRecoveryConsumedSha256 = attempted && operatorRecoveryAvailable
        ? operatorPatchSha256 : consumedOperatorPatch;
    const sameFailure = existing?.recoveryFingerprint === observed.recoveryFingerprint
        && existing?.failureSignature === observed.failureSignature;
    if (sameFailure && !attempted) return { recoveryKind: 'reader', recoveryFingerprint: observed.recoveryFingerprint,
        failureSignature: observed.failureSignature, nextEligibleAt: existing.nextEligibleAt || null,
        exhausted: operatorRecoveryAvailable || implementationRecoveryAvailable
            ? false : existing.exhausted === true || observed.exhausted === true,
        implementationRecoveryPendingFingerprint, operatorPatchSha256, operatorRecoveryConsumedSha256 };
    const base = new Date(attempted ? now : observed.observedAt || now).getTime();
    return { recoveryKind: 'reader', recoveryFingerprint: observed.recoveryFingerprint,
        failureSignature: observed.failureSignature,
        nextEligibleAt: !fingerprintChanged && observed.cooldownMs > 0
            ? new Date(base + observed.cooldownMs).toISOString() : null,
        exhausted: (implementationRecoveryAvailable || operatorRecoveryAvailable) && !attempted
            ? false : observed.exhausted === true,
        implementationRecoveryPendingFingerprint, operatorPatchSha256, operatorRecoveryConsumedSha256 };
}

function deterministicRunId(crosswalkId, paperId) {
    const bytes = Buffer.from(sha256(`${crosswalkId}\0${paperId}`).slice(0, 32), 'hex');
    // 根据 crosswalk ID 和论文 ID 计算稳定的运行 ID；UUID 版本位和变体位
    // 按 v4 设置，因为现有运行记录加载器只接受 v4。
    bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function groupsFromCrosswalk(state) {
    const pages = new Map(state.source.papers.map(page => [page.pageKey, page]));
    return state.identityGroups.filter(group => group.paperId.startsWith('arxiv:')).map(group => {
        const arxivId = group.paperId.slice(6);
        if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) throw new Error(`已核验记录中的 arXiv ID 格式错误：${group.paperId}`);
        const assignments = group.pageKeys.map(key => state.assignments[key]);
        const refs = assignments.map(item => item?.sourceAuthority);
        if (refs.some(ref => !ref || ref.paperId !== group.paperId)) throw new Error(`${group.paperId} 对应的页面中有页面缺少该论文的已核验来源记录`);
        const authorityNames = [...new Set(refs.map(ref => ref.authorityName))];
        const authorityShas = [...new Set(refs.map(ref => ref.authorityFileSha256))];
        if (authorityNames.length !== 1 || authorityShas.length !== 1) throw new Error(`${group.paperId} 对应页面的来源记录名称和文件 SHA 必须各自只有一个取值`);
        const cohortDates = [...new Set(group.pageKeys.map(key => pages.get(key)?.cohortDate))].sort();
        if (!cohortDates.length || cohortDates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date || ''))) throw new Error(`${group.paperId} 缺少页面所属日期，或日期不是 YYYY-MM-DD 格式`);
        return { paperId: group.paperId, arxivId, groupSha256: group.groupSha256,
            identitySha256: group.identitySha256, identityRecordSha256: group.identityRecordSha256,
            pageKeys: group.pageKeys.slice(), cohortDates, analysisDate: cohortDates[0],
            authorityName: authorityNames[0], authorityFileSha256: authorityShas[0],
            runId: deterministicRunId(state.crosswalkId, group.paperId) };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function scopeGroups(groups, requestedPaperIds) {
    if (requestedPaperIds === undefined || requestedPaperIds === null) return groups;
    if (!Array.isArray(requestedPaperIds) || requestedPaperIds.length === 0
        || requestedPaperIds.some(id => !/^arxiv:\d{4}\.\d{4,5}$/.test(id))
        || new Set(requestedPaperIds).size !== requestedPaperIds.length) {
        throw new Error('paperIds 必须是非空数组，元素为不带版本号的 arxiv: ID，且不得重复');
    }
    const requested = new Set(requestedPaperIds); const known = new Set(groups.map(group => group.paperId));
    const unknown = requestedPaperIds.filter(id => !known.has(id));
    if (unknown.length) throw new Error(`paperIds 中有论文不在已核验的 arXiv 论文集合内：${unknown.join(', ')}`);
    return groups.filter(group => requested.has(group.paperId));
}

function defaultDependencies() {
    const Config = require('../config.js'); const engine = require('../analysis-engine.js');
    const history = require('./historical-arxiv-analysis.js'); const fresh = require('./fresh-rewrite-run.js');
    return { files: Config.FILES,
        readCrosswalk: args => require('./page-source-crosswalk.js').readCrosswalk(args),
        fetchMetadata: id => require('./arxiv-metadata-source.js').fetchOfficialArxivMetadata(id),
        prepareAuthority: args => require('./arxiv-source-authority.js').prepareArxivSourceAuthority(args),
        prepareRun: args => history.prepareHistoricalArxivRun(args), recoverRun: args => history.recoverHistoricalArxivRun(args),
        verifyRunAuthority: args => history.verifyHistoricalArxivRunAuthority(args),
        inspectRunRecovery: args => inspectReaderRecovery(args),
        analyzeRun: args => fresh.analyzeRewrite(args), runStatus: args => fresh.rewriteStatus(args),
        updateLocked: engine.updateJsonFileLocked, now: () => new Date().toISOString() };
}

function schedulerPath(root, crosswalkId) {
    const absolute = path.resolve(root); fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (!/^[a-f0-9-]{36}$/i.test(crosswalkId)) throw new Error('crosswalk ID 必须是由十六进制字符和连字符组成的 36 字符标识');
    return path.join(absolute, `${crosswalkId}.json`);
}

function checkpointBindingMatches(existing, group) {
    if (!existing || !Array.isArray(existing.pageKeys)) return false;
    const legacyIdentityBinding = existing.identitySha256 === undefined
        && existing.identityRecordSha256 === undefined
        && existing.groupSha256 === require('./fresh-rewrite-run.js').stableHash({
            paperId: group.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, pageKeys: existing.pageKeys
        });
    return existing.authorityFileSha256 === group.authorityFileSha256
        && existing.authorityName === group.authorityName
        && (legacyIdentityBinding || existing.identitySha256 === group.identitySha256
            && existing.identityRecordSha256 === group.identityRecordSha256)
        && existing.pageKeys.every(pageKey => group.pageKeys.includes(pageKey));
}

function syncCheckpoint(filename, crosswalk, groups, deps) {
    return deps.updateLocked(filename, current => {
        const prior = current || { contract: CONTRACT, version: VERSION, crosswalkId: crosswalk.crosswalkId,
            createdAt: deps.now(), items: {} };
        if (prior.contract !== CONTRACT || prior.version !== VERSION || prior.crosswalkId !== crosswalk.crosswalkId) throw new Error('调度记录的协议标识、版本或 crosswalk ID 与本次不同');
        const items = { ...prior.items };
        for (const group of groups) {
            const existing = items[group.paperId];
            if (existing && !checkpointBindingMatches(existing, group)) {
                throw new Error(`${group.paperId} 的调度记录与当前来源名称、来源文件 SHA、论文身份、页面集合或运行 ID 不同`);
            }
            if (existing && existing.runId !== group.runId) {
                const oldRunDirectory = deps.files?.freshRewriteRunsDir
                    ? path.join(deps.files.freshRewriteRunsDir, existing.runId) : null;
                const untouchedLegacyId = existing.status === 'pending' && existing.lastError === null
                    && /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(existing.runId)
                    && (!oldRunDirectory || !fs.existsSync(oldRunDirectory));
                if (!untouchedLegacyId) throw new Error(`${group.paperId} 的调度记录与当前来源名称、来源文件 SHA、论文身份、页面集合或运行 ID 不同`);
                items[group.paperId] = { ...group, status: 'pending', lastError: null };
            } else {
                items[group.paperId] = existing ? { ...existing, ...group,
                    analysisDate: existing.analysisDate, status: existing.status, lastError: existing.lastError }
                    : { ...group, status: 'pending', lastError: null };
            }
        }
        return { ...prior, crosswalkStateSha256: crosswalk.stateSha256,
            identityGroupsSha256: crosswalk.identityGroupsSha256, items, updatedAt: deps.now() };
    }, { allowMissing: true });
}

function updateItem(filename, group, patch, deps) {
    return deps.updateLocked(filename, current => {
        const item = current?.items?.[group.paperId];
        if (!item || item.runId !== group.runId || item.groupSha256 !== group.groupSha256) throw new Error('保存状态时，调度条目的运行 ID 或分组 SHA 已变化，或条目不存在');
        return { ...current, items: { ...current.items, [group.paperId]: { ...item, ...patch, updatedAt: deps.now() } }, updatedAt: deps.now() };
    });
}

function updateItemRecovery(filename, group, { status, lastError, observed, attempted }, deps) {
    return deps.updateLocked(filename, current => {
        const item = current?.items?.[group.paperId];
        if (!item || item.runId !== group.runId || item.groupSha256 !== group.groupSha256) {
            throw new Error('保存状态时，调度条目的运行 ID 或分组 SHA 已变化，或条目不存在');
        }
        const now = deps.now();
        const recovery = mergeRecoveryState(item, observed, now, { attempted: attempted === true });
        return { ...current, items: { ...current.items, [group.paperId]: {
            ...item, status, lastError, ...recovery, updatedAt: now
        } }, updatedAt: now };
    });
}

function selectCandidates(groups, items, { stage, queue, maximum, now }) {
    const nowMs = new Date(now).getTime();
    return groups.filter(group => {
        const item = items[group.paperId] || { status: 'pending' };
        const status = item.status;
        if (stage === 'prepare-only') return queue !== 'reader-recovery'
            && !['sources_ready', 'complete', 'analysis_partial', 'analyzing'].includes(status);
        const reader = ['analysis_partial', 'analyzing'].includes(status) && item.recoveryKind === 'reader';
        const eligibleReader = reader && item.exhausted !== true
            && (!item.nextEligibleAt || new Date(item.nextEligibleAt).getTime() <= nowMs);
        // 恢复检查会将锁缺失或可回收的中断运行标为 analysis_partial。
        // 仍标为 analyzing 的运行可能尚在执行，不应加入任何待处理队列。
        if (status === 'analyzing') return false;
        if (queue === 'new-full') return !['complete', 'analysis_partial', 'analyzing'].includes(status);
        if (queue === 'reader-recovery') return eligibleReader;
        if (status === 'complete') return false;
        if (reader) return eligibleReader;
        return true;
    }).slice(0, maximum);
}

function recoveredSchedulerStatus(recovered) {
    if (!recovered) return 'pending';
    if (recovered.storageSealed === true
        && recovered.currentContractComplete === true) return 'complete';
    if (recovered.status === 'complete' || recovered.storedStatus === 'complete'
        || recovered.storageSealed === true) return 'analysis_partial';
    return recovered.status;
}

function dryRunState(groups, crosswalkId, files, deps) {
    const filename = path.join(path.resolve(files.historicalAnalysisSchedulerDir), `${crosswalkId}.json`);
    let stored = {};
    if (fs.existsSync(filename)) {
        const snapshot = require('./fresh-rewrite-run.js').readRegularJson(filename).value;
        if (snapshot.contract !== CONTRACT || snapshot.version !== VERSION || snapshot.crosswalkId !== crosswalkId) {
            throw new Error('调度记录的协议标识、版本或 crosswalk ID 与本次不同');
        }
        stored = snapshot.items || {};
    }
    const items = {}; const effectiveGroups = [];
    for (const group of groups) {
        const prior = stored[group.paperId];
        const trustedPrior = prior && prior.runId === group.runId && checkpointBindingMatches(prior, group)
            ? prior : null;
        const effective = { ...group, analysisDate: trustedPrior?.analysisDate || group.analysisDate };
        effectiveGroups.push(effective);
        const recovered = deps.recoverRun({ runId: effective.runId, date: effective.analysisDate,
            arxivId: effective.arxivId, rootDir: files.freshRewriteRunsDir, now: deps.now() });
        const status = recoveredSchedulerStatus(recovered);
        const observed = status === 'analysis_partial'
            ? deps.inspectRunRecovery({ runId: effective.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
        items[effective.paperId] = { ...effective, ...(trustedPrior || {}), status,
            ...mergeRecoveryState(trustedPrior, observed, deps.now()) };
    }
    return { effectiveGroups, items };
}

async function runHistoricalSchedulerUnlocked(options, deps, lockedFilename = null) {
    const files = deps.files;
    const crosswalk = deps.readCrosswalk({ crosswalkRoot: files.pageSourceCrosswalkDir, crosswalkId: options.crosswalkId });
    const groups = groupsFromCrosswalk(crosswalk);
    const scopedGroups = scopeGroups(groups, options.paperIds);
    const maximum = options.limit === 'pilot' ? 1 : options.limit === null ? scopedGroups.length : options.limit;
    const queue = options.queue || 'all';
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !['prepare-only', 'analyze'].includes(options.stage)
        || !['new-full', 'reader-recovery', 'all'].includes(queue)
        || !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) throw new Error('调度参数无效：stage 必须为 prepare-only 或 analyze，queue 必须为 new-full、reader-recovery 或 all，解析后的处理数量必须为正的安全整数，concurrency 必须是 1 至 3 的整数');
    if (!options.apply) {
        const snapshot = dryRunState(scopedGroups, options.crosswalkId, files, deps);
        const selected = selectCandidates(snapshot.effectiveGroups, snapshot.items,
            { stage: options.stage, queue, maximum, now: deps.now() });
        return { status: 'dry-run', stage: options.stage, queue, verifiedArxivIdentities: groups.length,
            selected: selected.map(group => ({ paperId: group.paperId, runId: group.runId,
                pageCount: group.pageKeys.length, cohortDates: group.cohortDates,
                currentStatus: snapshot.items[group.paperId].status,
                recoveryKind: snapshot.items[group.paperId].recoveryKind })) };
    }
    const filename = lockedFilename || schedulerPath(files.historicalAnalysisSchedulerDir, options.crosswalkId);
    let checkpoint = syncCheckpoint(filename, crosswalk, groups, deps);
    const effectiveGroups = scopedGroups.map(group => ({ ...group,
        analysisDate: checkpoint.items[group.paperId].analysisDate }));
    for (const group of effectiveGroups) {
        const recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
            arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir, now: deps.now() });
        if (!recovered) {
            if (checkpoint.items[group.paperId].status !== 'pending') {
                checkpoint = updateItem(filename, group, { status: 'pending',
                    lastError: '找不到对应的分析运行，不能采用调度记录中的已完成状态' }, deps);
            }
            continue;
        }
        const status = recoveredSchedulerStatus(recovered);
        const observed = status === 'analysis_partial'
            ? deps.inspectRunRecovery({ runId: group.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
        const recovery = mergeRecoveryState(checkpoint.items[group.paperId], observed, deps.now());
        checkpoint = updateItem(filename, group, { status, lastError: null, ...recovery }, deps);
    }
    const candidates = selectCandidates(effectiveGroups, checkpoint.items,
        { stage: options.stage, queue, maximum, now: deps.now() });
    let runStopError = null;
    const stateWriteErrors = new Set();
    const saveState = operation => {
        try { return operation(); }
        catch (error) {
            stateWriteErrors.add(error);
            if (isStorageWriteFailure(error)) runStopError ||= error;
            throw error;
        }
    };
    const saveItem = (...args) => saveState(() => updateItem(...args));
    const saveRecovery = (...args) => saveState(() => updateItemRecovery(...args));
    const observeRunStop = error => {
        if (error?.scope === 'run') runStopError ||= error;
    };
    const finishWorkers = (settled, label) => {
        const failures = settled.filter(item => item.status === 'rejected').map(item => item.reason);
        if (failures.length) {
            const error = new AggregateError(runStopError ? [runStopError, ...failures] : failures, label);
            if (runStopError) Object.assign(error, { cause: runStopError, code: runStopError.code, scope: runStopError.scope });
            throw error;
        }
        if (runStopError) throw runStopError;
    };
    const prepareGroup = async group => {
        let recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
            arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir, now: deps.now() });
        let live;
        if (!recovered) {
            const metadata = await deps.fetchMetadata(group.arxivId);
            if (runStopError) return null;
            live = await deps.prepareAuthority({ authorityRoot: files.paperSourceAuthorityDir,
                arxivId: group.arxivId, authorityName: group.authorityName, apply: true, requireLiveAuthorization: true });
            recovered = deps.prepareRun({ authorityHandle: live.authorityHandle, metadata: metadata.metadata,
                metadataProof: metadata.proof, metadataArtifact: metadata.rawBytes, date: group.analysisDate,
                rootDir: files.freshRewriteRunsDir, runId: group.runId });
        } else {
            live = await deps.prepareAuthority({ authorityRoot: files.paperSourceAuthorityDir,
                arxivId: group.arxivId, authorityName: group.authorityName, apply: true, requireLiveAuthorization: true });
            deps.verifyRunAuthority({ runId: group.runId, rootDir: files.freshRewriteRunsDir,
                authorityHandle: live.authorityHandle });
        }
        const status = recovered.status === 'recovered'
            ? 'sources_ready' : recoveredSchedulerStatus(recovered);
        const updated = saveItem(filename, group, { status, lastError: null }, deps);
        return { recovered, item: updated.items[group.paperId] };
    };
    if (options.stage === 'prepare-only') {
        let cursor = 0;
        const worker = async () => {
            while (!runStopError && cursor < candidates.length) {
                const group = candidates[cursor++];
                try { await prepareGroup(group); }
                catch (error) {
                    if (stateWriteErrors.has(error)) throw error;
                    observeRunStop(error);
                    saveItem(filename, group, { status: 'prepare_failed',
                        lastError: String(error.message).slice(0, 2000) }, deps);
                }
            }
        };
        const settled = await Promise.allSettled(Array.from({
            length: Math.min(options.concurrency, candidates.length)
        }, worker));
        finishWorkers(settled, '历史来源准备失败，已等待已经开始的任务结束并尝试保存状态');
    } else {
        let cursor = 0;
        const worker = async () => {
            while (!runStopError && cursor < candidates.length) {
                const group = candidates[cursor++];
                let prepared;
                try { prepared = await prepareGroup(group); }
                catch (error) {
                    if (stateWriteErrors.has(error)) throw error;
                    observeRunStop(error);
                    saveItem(filename, group, { status: 'prepare_failed',
                        lastError: String(error.message).slice(0, 2000) }, deps);
                    continue;
                }
                // 选出论文后，其他运行可能已经完成分析或正在处理同一运行。
                // 依据刚保存的状态决定是否继续分析，不沿用选出论文时的状态。
                if (runStopError || !prepared || prepared.item.status === 'complete' || prepared.item.status === 'analyzing') continue;
                try {
                    const item = prepared.item;
                    const result = await deps.analyzeRun({ runId: group.runId, concurrency: 1,
                        refreshReaderDiagnostics: item?.implementationRecoveryPendingFingerprint === item?.recoveryFingerprint });
                    const sealed = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
                        arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir, now: deps.now() });
                    if (result.status === 'complete' && !(sealed?.storageSealed === true
                        && sealed.currentContractComplete === true)) {
                        throw new Error('分析返回已完成，但恢复检查未确认结果已保存且符合当前正式分析要求');
                    }
                    const status = sealed ? recoveredSchedulerStatus(sealed) : 'analysis_partial';
                    const observed = status === 'analysis_partial'
                        ? deps.inspectRunRecovery({ runId: group.runId, rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
                    saveRecovery(filename, group,
                        { status, lastError: null, observed, attempted: true }, deps);
                } catch (error) {
                    if (stateWriteErrors.has(error)) throw error;
                    observeRunStop(error);
                    try {
                        const recovered = deps.recoverRun({ runId: group.runId, date: group.analysisDate,
                            arxivId: group.arxivId, rootDir: files.freshRewriteRunsDir, now: deps.now() });
                        const recoveredStatus = recoveredSchedulerStatus(recovered);
                        const observed = recoveredStatus === 'analysis_partial'
                            ? deps.inspectRunRecovery({ runId: group.runId,
                                rootDir: files.freshRewriteRunsDir, now: deps.now() }) : null;
                        const status = recoveredStatus === 'complete' ? 'complete'
                            : observed?.recoveryKind === 'reader' ? 'analysis_partial' : 'analysis_failed';
                        saveRecovery(filename, group, { status,
                            lastError: status === 'complete' ? null : String(error.message).slice(0, 2000),
                            observed, attempted: true }, deps);
                    } catch (recoveryError) {
                        if (stateWriteErrors.has(recoveryError)) throw recoveryError;
                        // 恢复检查失败时保留原状态，保存原分析错误和恢复错误。
                        // 等同批已开始的任务结束后，再向调用方报告失败。
                        saveItem(filename, group, { lastError:
                            `${String(error.message)}; 恢复检查失败：${String(recoveryError.message)}`.slice(0, 2000) }, deps);
                        throw recoveryError;
                    }
                }
            }
        };
        const settled = await Promise.allSettled(Array.from({
            length: Math.min(options.concurrency, candidates.length)
        }, worker));
        finishWorkers(settled, '历史分析失败，已等待已经开始的任务结束并尝试保存状态');
    }
    checkpoint = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const values = Object.values(checkpoint.items);
    return { status: values.every(item => item.status === 'complete') ? 'complete' : 'partial', stage: options.stage, queue,
        total: groups.length, complete: values.filter(item => item.status === 'complete').length,
        prepared: values.filter(item => ['sources_ready', 'analysis_partial', 'complete'].includes(item.status)).length,
        failed: values.filter(item => /failed$/.test(item.status)).length, checkpoint: filename };
}

async function runHistoricalScheduler(options, overrides = {}) {
    const deps = { ...defaultDependencies(), ...overrides };
    if (!options.apply) return runHistoricalSchedulerUnlocked(options, deps);
    const filename = schedulerPath(deps.files.historicalAnalysisSchedulerDir, options.crosswalkId);
    const engine = require('../analysis-engine.js');
    const withSchedulerLock = deps.withSchedulerLock
        || ((lockPath, callback, lockOptions) => engine.withFileLock(lockPath, callback, lockOptions));
    return withSchedulerLock(`${filename}.scheduler-operation`,
        () => runHistoricalSchedulerUnlocked(options, deps, filename), {
            recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
        });
}

module.exports = { CONTRACT, VERSION, READER_TRANSPORT_COOLDOWN_MS, READER_RECOVERY_POLICY_VERSION,
    readerImplementationFingerprint,
    exactOperatorPatchRecovery, inspectReaderRecovery, mergeRecoveryState, checkpointBindingMatches,
    selectCandidates, recoveredSchedulerStatus,
    deterministicRunId, groupsFromCrosswalk, scopeGroups, runHistoricalScheduler };

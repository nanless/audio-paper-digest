'use strict';
// Explicit zero-request source corrections share one transaction and normal
// content pipeline. Independent physical resource/core registrations choose
// disjoint policies; JSON flags never mint source or editing capabilities.
// The adapter owns canonical preparation/sealing, the caller owns its CAS
// writer, and this module owns physical admission, source scopes and replay.
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const crypto = require('node:crypto');
const scope = new AsyncLocalStorage();
const verified = new WeakMap();
const CONTRACT = 'conference-source-resource-correction-v1';
const SCORE_KIND = 'deterministic_source_resource_audit';
const CORE_CONTRACT = 'conference-source-core-correction-v1';
const CORE_SCORE_KIND = 'deterministic_source_core_audit';
const CORE_BATCH = 'conference-source-core-correction-batch-v1';
const CORE_RECEIPT = 'conference-source-core-correction-receipt-v1';
const POLICIES = Object.freeze([
    Object.freeze({ kind: 'source_resource_correction', contract: CONTRACT,
        batch: 'conference-source-resource-correction-batch-v1',
        receipt: 'conference-source-resource-correction-receipt-v1',
        scoreKind: SCORE_KIND, directory: 'source-resource-corrections' }),
    Object.freeze({ kind: 'source_core_correction', contract: CORE_CONTRACT,
        batch: CORE_BATCH, receipt: CORE_RECEIPT,
        scoreKind: CORE_SCORE_KIND, directory: 'source-core-corrections' })
]);
function policyForContract(contract) {
    const policy = POLICIES.find(value => value.contract === contract);
    if (!policy) fail('没有当前来源纠正合同对应的独立真实scope');
    return policy;
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => require('./fresh-rewrite-run').stableHash(value);
function fail(message) {
    throw Object.assign(new Error('会议来源资源纠正拒绝：' + message), {
        code: 'CONFERENCE_SOURCE_RESOURCE_CORRECTION_INTEGRITY',
        category: 'integrity', scope: 'run', retryable: false
    });
}
function equal(actual, expected, message) {
    if (!isDeepStrictEqual(actual, expected)) fail(message);
}

// Optional single reason-only correction is not a caller option. It can only
// come from the same privately authenticated transaction/physical approval.
function approvedReasonAudit(original, evidence, ids) {
    const state = scope.getStore();
    const edits = state?.approvedReasonReplacements;
    if (edits === undefined) return { audit: structuredClone(original), replacement: null };
    if (!verified.has(state.handle) || !Array.isArray(edits) || edits.length !== 1) {
        fail('额外理由修正没有同一真实事务的唯一明确批准');
    }
    const r = edits[0];
    const match = /^\/dimensions\/([A-Za-z]+)\/reason$/u.exec(r.path || '');
    const key = match?.[1], dimension = original.dimensions?.[key];
    if (!dimension || key === 'openSource' || r.originalAuditSha256 !== stable(original)
        || r.beforeReasonSha256 !== sha(dimension.reason)
        || typeof r.afterReason !== 'string' || !r.afterReason.trim() || r.afterReason.length > 2000
        || r.afterReasonSha256 !== sha(r.afterReason)
        || r.evidenceContextSha256 !== sha(evidence)
        || !Array.isArray(r.evidence) || !r.evidence.length
        || r.evidence.some(item => !ids.has(item.id) || item.quoteSha256 !== sha(item.quote)
            || !evidence.includes(item.quote))) fail('理由旧值、原审计或真实账本证据变化');
    const cited = [...r.afterReason.matchAll(/\[([A-Z][A-Z0-9_/-]*)\]/gu)].map(match => match[1]);
    if (!cited.length || cited.some(id => !ids.has(id) || !r.evidence.some(item => item.id === id))) {
        fail('新理由含未经本次明确证据支持的引用ID');
    }
    // Registered approval must additionally bind exact source/PDF quotes and
    // their semantic role. A matching ID alone never authorizes new assertions.
    const audit = structuredClone(original);
    audit.dimensions[key].reason = r.afterReason;
    return { audit, replacement: structuredClone(r) };
}

// Real public functions, not a second scorer. The source/PDF scope is supplied
// only by the existing adapter verifyPlanAuthority + withConferenceAnalysisSource.
// This return value is a calculation, never a stage or a source capability.
function deriveLocalAudit(parentPaper, sourceDetails) {
    const deep = require('../deep-analyzer');
    const original = parentPaper.analysisManifest?.stages?.scoringAudit;
    if (original?.status !== 'complete' || original.scoringContract !== 'api-scoring-audit-v2'
        || original.auditSha256 !== stable(original.audit)
        || sha(sourceDetails.text) !== parentPaper.sourceSha256
        || parentPaper.analysisManifest.sourceAcquisition?.sourceSha256 !== parentPaper.sourceSha256
        || !require('../analysis-engine').scoringAuditBindsFinalAnalysis(parentPaper)
        || !require('../analysis-engine').scoringStabilityIsResolved(original)) {
        fail('原完整评分、稳定性或真实来源绑定不成立');
    }
    const correction = require('./reader-authenticated-pdf-footnote-evidence')
        .deriveCorrectedIdentity(parentPaper.apiReaderResources, sourceDetails.text);
    deep.replayVerifiedReaderResourceIdentity(correction.identity, sourceDetails.text);
    const input = deep.applyApiReaderResourceAvailability(parentPaper.analysis, correction.identity);
    const evidence = deep.buildTypeAwareSourceContext(input, sourceDetails.text);
    const ids = new Set([...evidence.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1]));
    const approved = approvedReasonAudit(original.audit, evidence, ids);
    const normalized = deep.validateScoringAuditAgainstAnalysis(input,
        approved.audit, correction.identity, sourceDetails.text);
    const strict = deep.revalidateScoringAudit(normalized, ids);
    const audit = { ...strict,
        ...(Array.isArray(normalized.capsApplied) ? { capsApplied: normalized.capsApplied } : {}) };
    const seven = Object.keys(original.audit.dimensions).filter(key => key !== 'openSource');
    const changedReasonKey = approved.replacement?.path.split('/')[2];
    if (seven.length !== 7 || seven.some(key => {
        const actual = audit.dimensions[key], before = original.audit.dimensions[key];
        if (actual.score !== before.score) return true;
        return !isDeepStrictEqual(actual, key === changedReasonKey
            ? { ...before, reason: approved.replacement.afterReason } : before);
    })) {
        fail('本地资源归一改变了非开源分数、未授权理由或其它六维');
    }
    for (const key of ['documentType', 'confidence', 'evidenceProfile']) {
        equal(audit[key], original.audit[key], '文类、置信度或证据轮廓变化');
    }
    const analysis = deep.applyScoringAuditResult(input, audit);
    const summary = text => deep.extractSectionByTitle(text, '核心摘要');
    equal(summary(analysis), summary(parentPaper.analysis), '核心摘要变化');
    const allowed = new Set(['评分', '机器摘要', '评分理由', '开源详情']);
    const titles = [...parentPaper.analysis.matchAll(/^##\s+([^\r\n]+)\s*$/gm)].map(match => match[1]);
    if (titles.some(title => !allowed.has(title)
        && deep.extractSectionByTitle(analysis, title) !== deep.extractSectionByTitle(parentPaper.analysis, title))) {
        fail('资源/评分显示范围以外的正式正文变化');
    }
    const parsedBefore = require('../utils').parseAnalysis(parentPaper.analysis);
    const parsedAfter = require('../utils').parseAnalysis(analysis);
    // These are the only machine fields the existing public operations may set.
    const machineMutable = new Set(['hasCode', 'hasModel', 'hasDataset', 'opensource', 'score',
        'openSourceScore', 'scoringReason', 'rankBucket']);
    const protectedParsed = parsed => {
        const value = structuredClone(parsed);
        for (const key of machineMutable) delete value[key];
        // Observed on nine original real packages under the public source/PDF
        // scorer. Preserve every unknown nested key and all other seven scores.
        for (const key of ['hasCode', 'hasModel', 'hasDataset', 'openSource', 'rankBucket']) {
            if (value.machineSummary) delete value.machineSummary[key];
        }
        if (value.scoreValidation?.scores) delete value.scoreValidation.scores.openSourceScore;
        return value;
    };
    equal(protectedParsed(parsedAfter), protectedParsed(parsedBefore), '其它机器解析字段变化');
    const sourceScore = audit.dimensions.openSource.score;
    if (parsedAfter.scoreValidation?.valid !== true
        || parsedAfter.scoreValidation.scores?.openSourceScore !== sourceScore
        || parsedAfter.machineSummary?.openSource !== sourceScore.toFixed(1)
        || parsedAfter.machineSummary?.rankBucket !== audit.rankBucket) {
        fail('资源分项、分档或正常评分校验没有精确重算');
    }
    for (const key of ['hasCode', 'hasModel', 'hasDataset']) {
        equal(parsedAfter.machineSummary?.[key], parsedAfter[key], '资源机器字段的内外投影不同');
    }
    const protectedMachineLines = text => deep.extractSectionByTitle(text, '机器摘要')
        .split(/\r?\n/u).filter(line => !/^\s*(?:[-*]\s*)?(?:has_code|has_model|has_dataset|open_source|rank_bucket)\s*[:：]/u.test(line));
    equal(protectedMachineLines(analysis), protectedMachineLines(parentPaper.analysis),
        '非资源/分档机器摘要原行字节变化');
    return {
        executionKind: SCORE_KIND, newApiRequests: 0,
        correction, analysis, parsed: parsedAfter, audit,
        sourceBoundReasonReplacement: approved.replacement,
        originalAuditSha256: original.auditSha256,
        resourceIdentitySha256: correction.identity.identitySha256,
        inputAnalysisSha256: sha(input), evidenceSha256: sha(evidence),
        allowedEvidenceIds: [...ids], auditSha256: stable(audit), outputAnalysisSha256: sha(analysis),
        sevenDimensionsSha256: stable(Object.fromEntries(seven.map(key => [key, audit.dimensions[key]]))),
        summarySha256: sha(summary(analysis))
    };
}


const fs = require('node:fs'), path = require('node:path');
const batches = new WeakMap();
const publicationProjection = new AsyncLocalStorage();
const PROJECTION_ONLY = Object.freeze({});
const BATCH = 'conference-source-resource-correction-batch-v1';
const RECEIPT = 'conference-source-resource-correction-receipt-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const clone = value => structuredClone(value);
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
function sameStat(a, b) {
    return ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']
        .every(key => a[key] === b[key]);
}
function read(filename, json = true) {
    const file = path.resolve(filename), named = fs.lstatSync(file, { bigint: true });
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(file));
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
        || (named.mode & 0o777n) !== 0o600n || named.size > 64n * 1024n * 1024n) {
        fail('必须读取私有有界独立原件');
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!sameStat(named, opened)) fail('原件打开身份变化');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
        const last = fs.lstatSync(file, { bigint: true });
        if (!last.isFile() || last.isSymbolicLink() || !sameStat(opened, after)
            || !sameStat(after, last) || BigInt(bytes.length) !== opened.size) fail('读取期间原件变化');
        return { file, bytes, sha256: sha(bytes), ...(json ? { value: JSON.parse(bytes) } : {}) };
    } finally { fs.closeSync(fd); }
}
function inside(file, root) {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('文件离开受控根目录');
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(path.resolve(file)));
    return file;
}
function tree(directory) {
    const entries = []; let total = 0;
    const visit = (folder, prefix = '') => {
        const stat = fs.lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail('原目录不是私有真实目录');
        for (const name of fs.readdirSync(folder).sort()) {
            if (!/^[A-Za-z0-9._-]{1,220}$/u.test(name) || ['.', '..'].includes(name)) fail('原材料名称非法');
            const file = path.join(folder, name), relative = prefix + name;
            const s = fs.lstatSync(file);
            if (s.isSymbolicLink()) fail('原材料不能为符号链接');
            if (s.isDirectory()) { visit(file, relative + '/'); continue; }
            const record = read(file, false); total += record.bytes.length;
            if (entries.length >= 4096 || total > 256 * 1024 * 1024) fail('原材料超过有界存档');
            entries.push({ path: relative, sha256: record.sha256 });
        }
    };
    visit(directory); return entries;
}
function roots(processId, policy = POLICIES[0]) {
    if (!UUID.test(processId || '')) fail('process UUID 非法');
    const files = require('../config').FILES;
    const analysisRoot = path.resolve(files.conferenceAnalysisDir);
    const processDirectory = path.join(path.resolve(files.conferenceProcessDir), processId);
    return { analysisRoot, processDirectory,
        correctionRoot: path.join(processDirectory, policy.directory), policy };
}
function load(executionId, analysisRoot) {
    if (!UUID.test(executionId || '')) fail('执行 UUID 非法');
    const adapter = require('./conference-analysis-adapter');
    const basic = adapter.loadConferenceAnalysis({ analysisRoot, executionId });
    const revision = path.join(basic.directory, 'reader-revision.json');
    if (!fs.existsSync(revision)) return basic;
    const r = read(revision).value;
    return r.contract === 'conference-reader-recovery-window-v1'
        ? adapter.loadGrantedConferenceRecovery({ analysisRoot, executionId })
        : adapter.loadConferenceReaderRevision({ analysisRoot, executionId });
}
function pinLoaded(loaded, expected, label) {
    for (const key of ['analysisFileSha256', 'runFileSha256', 'sourceFileSha256']) {
        if (!SHA.test(expected?.[key] || '') || loaded[key] !== expected[key]) fail(label + '完整原包 CAS 改变');
    }
}
function roleRefs(record) {
    const roles = {
        readerParent: { executionId: record.readerParentExecutionId, CAS: record.readerParentCAS },
        observedState: { executionId: record.observedStateExecutionId, CAS: record.observedStateCAS },
        main: { executionId: record.selectedMainExecutionId, CAS: record.selectedMainCAS }
    };
    if (record.latestFailedExecutionId !== null) {
        roles.originalFailed = { executionId: record.originalFailedExecutionId, CAS: record.originalFailedCAS };
        roles.latestFailed = { executionId: record.latestFailedExecutionId, CAS: record.latestFailedCAS };
    }
    return roles;
}
function verifyOriginals(batch, row) {
    if (read(batch.manifest.file).sha256 !== batch.manifest.sha256
        || read(row.file.file).sha256 !== row.file.sha256) fail('独立清单或修改记录变化');
    const loaded = {};
    for (const [role, ref] of Object.entries(roleRefs(row.record))) {
        loaded[role] = load(ref.executionId, batch.analysisRoot);
        pinLoaded(loaded[role], ref.CAS, role);
        equal(tree(loaded[role].directory), row.trees[role], role + '原材料变化');
    }
    for (const fee of row.fees) if (read(fee.file).sha256 !== fee.sha256) fail('原费用事件变化');
    if (row.record.coreCorrection) {
        const c = row.record.coreCorrection; inside(c.proposalFile, batch.correctionRoot);
        if (read(c.proposalFile).sha256 !== c.proposalFileSha256) fail('核心原提案变化');
    }
    if (row.record.reasonCorrection) {
        const r = row.record.reasonCorrection;
        inside(r.proposalFile, batch.correctionRoot);
        if (read(r.proposalFile).sha256 !== r.proposalFileSha256) fail('单理由的原批准提案变化');
    }
    return loaded;
}
function loadBatch({ processId, manifestPath }, savedState = null) {
    const resolved = path.resolve(manifestPath || '');
    const base = POLICIES.map(policy => roots(processId, policy)).find(candidate =>
        resolved.startsWith(candidate.correctionRoot + path.sep));
    if (!base) fail('清单不在任一明确source scope的私有根目录');
    inside(manifestPath, base.correctionRoot);
    const manifest = read(manifestPath), m = manifest.value;
    const state = savedState || read(path.join(base.processDirectory, 'state.json'));
    const processApi = require('./conference-process'); processApi.assertState(state.value);
    if (m.contract !== base.policy.batch || m.version !== 1 || m.processId !== processId || !UUID.test(m.batchId || '')
        || state.value.processId !== processId || state.sha256 !== m.stateFileSha256
        || state.value.stateSha256 !== m.stateSha256
        || Object.values(state.value.items).some(item => item.status === 'analyzing')
        || !Array.isArray(m.records) || m.records.length < 1 || m.records.length > 15
        || !Array.isArray(m.authorization?.paperIds) || !Array.isArray(m.sourceCohortPaperIds)
        || m.authorization?.kind !== base.policy.kind || m.authorization.newApiRequests !== 0
        || typeof m.authorization.instruction !== 'string' || !m.authorization.instruction.trim()) {
        fail('不是已停稳、明确零 API 的完整有界来源纠正登记');
    }
    const ids = m.records.map(row => row.paperId).sort();
    if (new Set(ids).size !== ids.length || !isDeepStrictEqual(m.authorization.paperIds?.slice().sort(), ids)
        || !isDeepStrictEqual(m.sourceCohortPaperIds?.slice().sort(), ids)) fail('完整来源纠正集合不一致');
    const rows = new Map(), children = new Set();
    for (const entry of m.records) {
        inside(entry.file, base.correctionRoot);
        const file = read(entry.file), r = file.value;
        const item = state.value.items[r.paperId];
        if (entry.paperId !== r.paperId || file.sha256 !== entry.sha256 || rows.has(r.paperId)
            || r.contract !== base.policy.contract || r.notLlmResponse !== true || r.newApiRequests !== 0
            || !UUID.test(r.childExecutionId || '') || children.has(r.childExecutionId)
            || Object.values(roleRefs(r)).some(ref => ref.executionId === r.childExecutionId)
            || !item || item.analysisRunId !== r.observedStateExecutionId || stable(item) !== r.observedItemSha256
            || !Number.isFinite(Date.parse(r.appliedAt))) fail('来源纠正条目/原指针/范围错误');
        if (base.policy.kind === 'source_core_correction') {
            if (!r.coreCorrection || typeof r.coreCorrection !== 'object' || Array.isArray(r.coreCorrection)
                || r.reasonCorrection !== undefined) fail('核心scope必须唯一core提案且不能借资源单理由权限');
            inside(r.coreCorrection.proposalFile, base.correctionRoot);
            if (read(r.coreCorrection.proposalFile).sha256 !== r.coreCorrection.proposalFileSha256) fail('核心提案原字节不同');
        } else if (r.coreCorrection !== undefined) fail('资源scope不能新增核心编辑');
        children.add(r.childExecutionId);
        if (r.latestFailedExecutionId === null
            && (r.originalFailedExecutionId != null || r.originalFailedCAS != null)) fail('没有追加失败时不能附带未核验的原失败角色');
        const parent = load(r.readerParentExecutionId, base.analysisRoot);
        const originalPaper = parent.analysis.papers[0], originalReader = originalPaper.analysisManifest?.stages?.apiReaderArticle;
        if (originalReader?.status !== 'complete' || originalReader.executionKind === 'operator'
            || originalReader.model === 'operator-local'
            || sha(originalPaper.apiReaderArticle) !== originalPaper.apiReaderArticleSha256
            || originalReader.articleSha256 !== originalPaper.apiReaderArticleSha256
            || stable(originalPaper.apiReaderPlan) !== originalPaper.apiReaderPlanSha256
            || originalReader.planSha256 !== originalPaper.apiReaderPlanSha256
            || originalReader.figuresSha256 !== stable(originalPaper.apiReaderFigures)) fail('原签Reader全输出SHA不成立');
        const observed = load(r.observedStateExecutionId, base.analysisRoot);
        const main = load(r.selectedMainExecutionId, base.analysisRoot);
        const latest = r.latestFailedExecutionId === null ? null : load(r.latestFailedExecutionId, base.analysisRoot);
        pinLoaded(parent, r.readerParentCAS, '完成Reader父稿'); pinLoaded(observed, r.observedStateCAS, '原process指针');
        pinLoaded(main, r.selectedMainCAS, '最新主文基础');
        if (latest) {
            pinLoaded(latest, r.latestFailedCAS, '最新实际失败');
            const originalFailed = latest.recoveryWindow?.failed;
            if (item.status === 'complete' || r.selectedMainExecutionId !== r.latestFailedExecutionId
                || latest.revision?.contract !== 'conference-reader-recovery-window-v1'
                || !UUID.test(r.originalFailedExecutionId || '') || !originalFailed
                || r.originalFailedExecutionId !== originalFailed.run.executionId
                || latest.revision.failedExecutionId !== r.originalFailedExecutionId
                || latest.revision.parentExecutionId !== r.readerParentExecutionId
                || originalFailed.parent.run.executionId !== r.readerParentExecutionId
                || latest.parent.run.executionId !== r.readerParentExecutionId
                || ![r.readerParentExecutionId, r.originalFailedExecutionId].includes(r.observedStateExecutionId)) {
                fail('最新失败未绑定原完成父稿、原失败child和真实process指针的同一追加链');
            }
            pinLoaded(originalFailed, r.originalFailedCAS, '原实际失败child');
            pinLoaded(originalFailed.parent, r.readerParentCAS, '原失败child的完整父稿');
            pinLoaded(latest.parent, r.readerParentCAS, '追加窗口的完整父稿');
            pinLoaded(observed, r.observedStateExecutionId === r.readerParentExecutionId
                ? r.readerParentCAS : r.originalFailedCAS, '原process指针真实链成员');
            if (originalFailed.run.paperId !== r.paperId
                || originalFailed.sourceFileSha256 !== parent.sourceFileSha256
                || originalFailed.run.sourceSnapshotSha256 !== r.sourceSnapshotSha256) fail('原失败child来源不同');
        } else if (item.status !== 'complete' || r.selectedMainExecutionId !== r.observedStateExecutionId) {
            const issue = base.policy.kind === 'source_core_correction'
                ? require('../analysis-contract').validateCoreSummarySemanticContract(main.analysis.papers[0].analysis,
                    { sourceText: main.source.sourceDetails.text }) : null;
            // A real complete package may fail current postprocessing without a
            // newer paid child. This is exclusive to an explicitly bound core
            // defect, not a general permission to ignore pending source11 runs.
            if (base.policy.kind !== 'source_core_correction' || item.status !== 'analysis_partial'
                || item.readerRefreshRequired !== true || r.selectedMainExecutionId !== r.observedStateExecutionId
                || main.run.status !== 'complete' || main.analysis.status !== 'complete'
                || !issue || sha(issue) !== r.coreCorrection.originalSemanticIssueSha256
                || !item.lastFailure || stable(item.lastFailure) !== r.coreCorrection.observedPostprocessFailureSha256
                || typeof item.lastFailure.message !== 'string' || !item.lastFailure.message.includes(issue)
                || item.lastError !== item.lastFailure.message) {
                fail('未完成成员缺最新实际付费失败或精确本地core后处理失败原包');
            }
        }
        if (parent.run.status !== 'complete' || parent.analysis.status !== 'complete'
            || parent.run.paperId !== r.paperId || observed.run.paperId !== r.paperId
            || parent.run.sourceSnapshotSha256 !== observed.run.sourceSnapshotSha256
            || parent.sourceFileSha256 !== observed.sourceFileSha256
            || parent.run.sourceSnapshotSha256 !== r.sourceSnapshotSha256
            || sha(parent.source.sourceDetails.text) !== r.sourceSha256
            || main.analysis.papers[0].apiReaderResources?.identitySha256 !== r.originalResourceIdentitySha256
            || main.run.paperId !== r.paperId || main.sourceFileSha256 !== parent.sourceFileSha256
            || (latest && latest.sourceFileSha256 !== main.sourceFileSha256)) {
            fail('原完成父稿和观察子稿不是同一认证来源');
        }
        if (!Array.isArray(r.feePins) || r.feePins.length > 4096) fail('费用精确索引缺失或超界');
        const fees = r.feePins.map(fee => {
            inside(fee.file, require('../config').FILES.llmUsageDir);
            const actual = read(fee.file);
            if (actual.sha256 !== fee.sha256 || actual.value.paperId !== r.paperId) fail('原费用索引未绑定本篇原事件');
            return { file: actual.file, sha256: actual.sha256 };
        });
        const trees = Object.fromEntries(Object.entries(roleRefs(r)).map(([role, ref]) =>
            [role, tree(path.join(base.analysisRoot, ref.executionId))]));
        rows.set(r.paperId, { file, record: r, trees, fees });
    }
    return { ...base, manifest, state, rows };
}
function openBatch(options) {
    const handle = Object.freeze({}); batches.set(handle, loadBatch(options)); return handle;
}
function batchFor(handle) { const batch = batches.get(handle); if (!batch) fail('需要真实 opaque 批次句柄'); return batch; }
function assertBatchCurrent(batch) {
    if (read(path.join(batch.processDirectory, 'state.json')).sha256 !== batch.state.sha256) fail('原进程已推进，停止来源纠正事务');
}
// Uses the existing normal adapter preparation only. No parent mutation,
// copying of revision/preflight files, paid grant or candidate fabrication.
function prepareChild(batchHandle, paperId, { planHandle, sourceRoot }) {
    const batch = batchFor(batchHandle), row = batch.rows.get(paperId);
    if (!row) fail('论文不在完整来源纠正清单');
    assertBatchCurrent(batch); verifyOriginals(batch, row);
    const adapter = require('./conference-analysis-adapter');
    adapter.prepareConferenceAnalysis({ analysisRoot: batch.analysisRoot, paperId,
        executionId: row.record.childExecutionId, planHandle, sourceRoot, now: row.record.appliedAt });
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot: batch.analysisRoot,
        executionId: row.record.childExecutionId });
    if (loaded.sourceFileSha256 !== row.record.readerParentCAS.sourceFileSha256
        || loaded.run.paperId !== paperId || loaded.run.sourceSnapshotSha256 !== row.record.sourceSnapshotSha256) fail('新本地子运行来源不同');
    if (loaded.run.createdAt !== new Date(row.record.appliedAt).toISOString()) fail('本地child不是本次固定prepare时间身份');
    if (loaded.analysis.status === 'complete') {
        const locator = loaded.analysis.papers[0]?.conferenceSourceCorrection;
        if (locator?.contract !== batch.policy.contract || locator.executionId !== row.record.childExecutionId
            || locator.manifestSha256 !== batch.manifest.sha256
            || !fs.existsSync(path.join(receiptBase(batch, row), 'receipt.json'))) fail('不能复用其它已有完整子稿');
    } else if (loaded.analysis.status !== 'pending' || loaded.run.status !== 'source_ready'
        || loaded.analysisFileSha256 !== read(path.join(loaded.directory, 'intent.json')).value.initialAnalysisFileSha256) {
        fail('只能恢复本次原始prepare或已有本地完成稿，不能覆盖付费partial/analyzing');
    }
    const pdf = adapter.verifyPlanAuthority(loaded, planHandle, sourceRoot);
    const handle = Object.freeze({});
    verified.set(handle, { batch, row, loaded, pdf, cold: false });
    return handle;
}
function memberFor(handle) { const member = verified.get(handle); if (!member) fail('需要真实 opaque 本地子运行句柄'); return member; }
function replayReaderPatch(parentPaper, record) {
    const repair = require('./reader-repair');
    const original = require('./reader-signed-draft-surface').reconstructReaderDraftSurface({ paper: parentPaper, paperId: parentPaper.id });
    if (record.reader.beforeDraftSha256 !== original.draftSha256) fail('原签 Reader 逆算输入变化');
    let draft;
    if (record.reader.noEdit === true) {
        if (record.reader.patch !== undefined || record.reader.afterDraftSha256 !== original.draftSha256) fail('原样重验不得隐藏修改');
        draft = original.draft;
    } else {
        const patch = record.reader.patch;
        if (!Array.isArray(patch?.replacements) || patch.replacements.length < 1 || patch.replacements.length > 8) fail('Reader修改必须为1–8既有节点');
        const paths = patch.replacements.map(item => item.path);
        if (paths.some(pointer => !/^\/(?:sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(?:0|[1-9]\d*)(?:\/(?:body|explanation|sourceQuotes|\d+))*$/u.test(pointer))) fail('Reader路径不是明确既有节点');
        draft = repair.applyReaderPatch(original.draft, patch, paths);
        for (const key of ['sections', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']) {
            if (draft[key].length !== original.draft[key].length) fail('Reader结构数量变化');
        }
    }
    if (!repair.parseRepairableDraft(draft) || repair.hashDraft(draft) !== record.reader.afterDraftSha256) fail('Reader修正未重放到批准草稿');
    return { original, draft };
}
function readReasonApproval(member, evidence) {
    const declared = member.row.record.reasonCorrection;
    if (declared === undefined) return undefined;
    inside(declared.proposalFile, member.batch.correctionRoot);
    const p = read(declared.proposalFile), v = p.value;
    const provider = require('./conference-source-context').readerPdfSourceForContext(member.pdf);
    const parent = load(member.row.record.selectedMainExecutionId, member.batch.analysisRoot).analysis.papers[0];
    const old = parent.analysisManifest.stages.scoringAudit.audit.dimensions.technicalRigor;
    if (p.sha256 !== declared.proposalFileSha256 || !['mousi-local-reference-correction-proposal-readonly-v1', 'source-bound-one-reason-review-v1'].includes(v.contract)
        || v.paperId !== parent.id || v.originalAuditSha256 !== parent.analysisManifest.stages.scoringAudit.auditSha256
        || v.originalSourceSnapshotSha256 !== provider.sourceSnapshotSha256 || v.pdfSha256 !== provider.pdfSha256
        || v.sourceTextSha256 !== sha(provider.sourceText) || v.currentEvidenceContextSha256 !== sha(evidence)
        || !isDeepStrictEqual(v.originalTechnicalRigor, old) || v.proposalOnly?.score !== old.score
        || declared.approvedReasonSha256 !== sha(v.proposalOnly.proposedReason)
        || declared.authorization?.kind !== 'one_source_bound_reason_only'
        || typeof declared.authorization.instruction !== 'string' || !declared.authorization.instruction.trim()) fail('单理由的独立明确审查与原包/源不一致');
    const method = v.currentMethodEvidence, source = v.currentSourceEvidence;
    const fullMethod = require('../deep-analyzer').extractSectionByTitle(parent.analysis, '方法概述和架构');
    if (method?.id !== 'A_METHOD' || method.fullSectionSha256 !== sha(fullMethod)
        || typeof method.quote !== 'string' || !fullMethod.includes(method.quote) || !evidence.includes(method.quote)
        || typeof source?.id !== 'string' || typeof source.text !== 'string'
        || source.textSha256 !== sha(source.text) || !evidence.includes(source.text)) fail('新理由借用了别的账本或事实');
    const facts = [{ id: method.id, text: method.quote }, { id: source.id, text: source.text }];
    return [{ path: '/dimensions/technicalRigor/reason', originalAuditSha256: v.originalAuditSha256,
        beforeReasonSha256: sha(old.reason), afterReason: v.proposalOnly.proposedReason,
        afterReasonSha256: sha(v.proposalOnly.proposedReason), evidenceContextSha256: sha(evidence),
        evidence: facts.map(fact => ({ id: fact.id, quote: fact.text, quoteSha256: sha(fact.text) })),
        originalProposalFile: p.file, originalProposalFileSha256: p.sha256 }];
}
function assertContext(member, paper) {
    verifyOriginals(member.batch, member.row);
    if (!member.cold) assertBatchCurrent(member.batch);
    const context = require('./conference-analysis-context').getConferenceAnalysisContext();
    if (!context || context.paperId !== member.row.record.paperId
        || context.executionId !== member.row.record.childExecutionId
        || context.executionDir !== member.loaded.directory || context.readerPdfSourceHandle !== member.pdf
        || paper.id !== context.paperId || paper.source !== 'conference' || paper.arxivId || paper.paper_id
        || sha(context.sourceDetails.text) !== paper.sourceSha256) fail('本地纠正离开真实子运行/PDF/来源');
    const provider = require('./conference-source-context').readerPdfSourceForContext(member.pdf);
    if (!provider || provider.paperId !== paper.id || provider.sourceSnapshotSha256 !== member.row.record.sourceSnapshotSha256
        || sha(provider.sourceText) !== member.row.record.sourceSha256) fail('本地来源能力不同');
    provider.assertUnchanged(); return provider;
}
function withMember(handle, callback) {
    const member = memberFor(handle), r = member.row.record;
    const context = { paperId: r.paperId, executionId: r.childExecutionId,
        executionDir: member.loaded.directory, sourceDetails: member.loaded.source.sourceDetails,
        readerPdfSourceHandle: member.pdf };
    return require('./conference-analysis-context').withConferenceAnalysisSource(context, () =>
        require('./analysis-stop-control').withModelRequestsForbidden(() => scope.run({ ...member, handle }, callback)));
}
function withLocalSourceCorrection(handle, callback) {
    const member = memberFor(handle);
    if (typeof callback !== 'function' || member.cold
        || !require('../analysis-engine').paperAnalysisLockHeld({ id: member.row.record.paperId })) fail('热纠正须持原论文锁和真实本地句柄');
    return withMember(handle, callback);
}
function current() { const active = scope.getStore(); if (!active || !verified.has(active.handle)) fail('缺少私有来源纠正范围'); return active; }
function projectSelectedMain(loaded, record) {
    const raw = loaded.analysis.papers[0];
    if (raw.analysis !== null) {
        if (record.mainCheckpointRecovery !== undefined) fail('非空主文不能声明检查点恢复');
        return { parent: raw, recovery: null };
    }
    const stages = raw.analysisManifest?.stages, checkpoint = raw.analysisStageCheckpoints?.scoringAudit;
    const images = raw.imageManifest, download = stages?.imageDownload;
    if (record.contract !== CONTRACT || record.selectedMainExecutionId !== record.latestFailedExecutionId
        || typeof checkpoint !== 'string' || !checkpoint.trim()
        || raw.analysisCheckpoint !== checkpoint || stages?.scoringAudit?.status !== 'complete'
        || sha(checkpoint) !== stages.scoringAudit.outputAnalysisSha256
        || stages.apiReaderArticle?.status !== 'invalid_output'
        || !/^(?:READER_|CONFERENCE_READER_)/u.test(raw.latestAnalysisAttemptErrorCode || raw.errorCode || '')
        || !(raw.latestAnalysisAttemptError || raw.error) || stages.imageSupplement !== undefined
        || download?.status !== 'no_candidates' || download.attempted !== 0 || download.downloaded !== 0
        || !Array.isArray(download.outcomes) || download.outcomes.length || images?.totalFound !== 0
        || ['candidates', 'downloaded', 'selected', 'downloadOutcomes'].some(key =>
            !Array.isArray(images?.[key]) || images[key].length)) {
        fail('空主文没有唯一完整评分检查点及原Reader失败，不能恢复');
    }
    const recovery = { contract: 'conference-source-main-checkpoint-recovery-v1', rawAnalysisValue: null,
        rawPaperSha256: stable(raw), analysisCheckpointSha256: sha(raw.analysisCheckpoint),
        scoringCheckpointSha256: sha(checkpoint), scoringOutputAnalysisSha256: stages.scoringAudit.outputAnalysisSha256,
        scoringStageSha256: stable(stages.scoringAudit), readerStageSha256: stable(stages.apiReaderArticle),
        originalFailureFieldsSha256: stable(Object.fromEntries(FAILURE_FIELDS.filter(key => Object.hasOwn(raw, key))
            .map(key => [key, raw[key]]))),
        readerRevisionProgressSha256: stable(loaded.analysis.readerRevisionProgress ?? null), missingImageSupplement: true };
    equal(record.mainCheckpointRecovery, recovery, '原空主文/评分检查点/失败或进度恢复声明不同');
    return { parent: { ...clone(raw), analysis: checkpoint, parsed: require('../utils').parseAnalysis(checkpoint) }, recovery };
}
function prepareFinalizerInput(paper) {
    const active = current(), r = active.row.record; const provider = assertContext(active, paper);
    if (active.finalizerInput) return active.finalizerInput;
    const selected = load(r.selectedMainExecutionId, active.batch.analysisRoot);
    const { parent, recovery } = projectSelectedMain(selected, r);
    active.mainCheckpointRecovery = recovery;
    const readerParent = load(r.readerParentExecutionId, active.batch.analysisRoot).analysis.papers[0];
    const rules = require('./conference-postprocess').readOriginalTagProof(parent).rules;
    let audit;
    if (active.batch.policy.kind === 'source_core_correction') {
        audit = deriveCoreAudit(parent, active);
    } else {
        // The public scientific preflight excludes Reader/image work. It runs
        // in this same authenticated conference source scope, never a daily scope.
        const upstream = recovery
            ? (require('./completed-reader-upstream').completedReaderUpstream(parent, active.loaded.source.sourceDetails)
                ? null : '真实评分检查点未通过完整科学上游核验')
            : require('../analysis-engine').getConferenceReaderRefreshUpstreamReason(parent, { tagRules: rules });
        if (upstream) fail('最新主文/核心/标签/评分未通过来源上游预检：' + upstream);
        const corrected = require('./reader-authenticated-pdf-footnote-evidence')
            .deriveCorrectedIdentity(parent.apiReaderResources, active.loaded.source.sourceDetails.text);
        const deep = require('../deep-analyzer');
        const scoringInput = deep.applyApiReaderResourceAvailability(parent.analysis, corrected.identity);
        const evidence = deep.buildTypeAwareSourceContext(scoringInput, active.loaded.source.sourceDetails.text);
        active.approvedReasonReplacements = readReasonApproval(active, evidence);
        audit = deriveLocalAudit(parent, active.loaded.source.sourceDetails);
    }
    if (readerParent.analysisManifest.stages.apiReaderArticle.contentMode !== 'reader-source-only-v1') fail('旧Reader不是可独立当前source重验的source-only稿');
    const reader = replayReaderPatch(readerParent, r);
    const provenance = { contract: active.batch.policy.contract, scopeKind: active.batch.policy.kind, version: 1, executionKind: 'operator', newApiRequests: 0,
        processId: active.batch.manifest.value.processId, batchId: active.batch.manifest.value.batchId,
        manifestFile: active.batch.manifest.file, manifestSha256: active.batch.manifest.sha256,
        correctionFile: active.row.file.file, correctionSha256: active.row.file.sha256,
        paperId: r.paperId, executionId: r.childExecutionId, readerParentExecutionId: r.readerParentExecutionId,
        observedStateExecutionId: r.observedStateExecutionId, selectedMainExecutionId: r.selectedMainExecutionId,
        latestFailedExecutionId: r.latestFailedExecutionId, originalRoleCAS: clone(roleRefs(r)), sourceSha256: r.sourceSha256,
        sourceSnapshotSha256: r.sourceSnapshotSha256, sourceIdentity: clone(provider.sourceIdentity),
        originalReaderStageSha256: stable(readerParent.analysisManifest.stages.apiReaderArticle),
        beforeDraftSha256: reader.original.draftSha256, afterDraftSha256: r.reader.afterDraftSha256,
        ...(recovery ? { mainCheckpointRecovery: clone(recovery) } : {}),
        ...(audit.pairedAuditValidation ? { pairedAuditValidation: clone(audit.pairedAuditValidation) } : {}),
        appliedAt: r.appliedAt };
    active.calculation = { parent, readerParent, audit, reader, provenance };
    // Object identity, not a rebuilt JSON projection, is the finalizer authority.
    active.finalizerInput = freeze({ scopeKind: active.batch.policy.kind,
        ...(audit.coreStage ? { coreStage: clone(audit.coreStage), coreCheckpoint: audit.coreCheckpoint } : {}),
        parent: clone(parent), rawParent: clone(selected.analysis.papers[0]),
        ...(recovery ? { mainCheckpointRecovery: clone(recovery) } : {}),
        readerParent: clone(readerParent), audit: clone(audit), draft: clone(reader.draft),
        originalFailureFields: Object.fromEntries(FAILURE_FIELDS.filter(key => Object.hasOwn(parent, key))
            .map(key => [key, clone(parent[key])])),
        originalRoleProgress: Object.fromEntries(Object.entries(roleRefs(r)).map(([role, ref]) => {
            const original = load(ref.executionId, active.batch.analysisRoot);
            return [role, { executionId: ref.executionId, CAS: clone(ref.CAS),
                readerRevisionProgress: clone(original.analysis.readerRevisionProgress ?? null) }];
        })),
        resources: clone(audit.correction.identity), provenance: clone(provenance),
        sourceDetails: clone(active.loaded.source.sourceDetails) });
    return active.finalizerInput;
}
function assertPairedCoreAudits(original, strictOriginal, canonicalBefore, canonicalAfter) {
    equal(strictOriginal, original, '原完整8维审计没有通过当前严格重验');
    equal(canonicalAfter, canonicalBefore, '核心前后正常评分归一不同，需另行审查');
    const reason = original.dimensions?.openSource?.reason;
    if (typeof reason !== 'string' || !reason.trim()) fail('原开源理由缺失');
    const comparable = clone(original);
    comparable.dimensions.openSource.reason = canonicalBefore.dimensions?.openSource?.reason;
    equal(comparable, canonicalBefore, '原审计与正常归一并非仅开源理由措辞不同');
    return { contract: 'conference-source-core-paired-audit-validation-v1',
        originalAuditStrictSha256: stable(strictOriginal), validationCanonicalSha256: stable(canonicalBefore) };
}
function deriveCoreAudit(parent, active) {
    const deep = require('../deep-analyzer'), contract = require('../analysis-contract');
    const r = active.row.record, c = r.coreCorrection, source = active.loaded.source.sourceDetails;
    const beforeStage = parent.analysisManifest?.stages?.coreSummaryRepair;
    const oldScore = parent.analysisManifest?.stages?.scoringAudit;
    if (parent.conferenceSourceCorrection || beforeStage?.executionKind === 'operator'
        || beforeStage?.sourceCoreCorrection || beforeStage?.operatorLiteralCorrection
        || !beforeStage || c.originalCoreStageSha256 !== stable(beforeStage)
        || oldScore?.status !== 'complete' || oldScore.auditSha256 !== stable(oldScore.audit)
        || !require('../analysis-engine').scoringAuditBindsFinalAnalysis(parent)
        || !require('./scoring-stability').scoringStabilityIsResolved(oldScore)
        || !require('./model-text-sanitization').canReuseModelTextInputs(parent, source)) {
        fail('核心原包/旧评分或真实模型来源没有完整保护');
    }
    // Only the old semantic defect is repairable. Its existing physical stage
    // chain, tag checkpoint and score bindings must already be authentic.
    const bindingIssue = contract.validateCoreSummaryStageBinding(parent, { skipSemantic: true, sourceText: source.text });
    if (bindingIssue) fail('核心原阶段结构链无效：' + bindingIssue);
    const originalIssue = contract.validateCoreSummarySemanticContract(parent.analysis, { sourceText: source.text });
    if (!originalIssue || c.originalSemanticIssueSha256 !== sha(originalIssue)) fail('原真实核心问题没有精确绑定');
    const proposal = read(c.proposalFile), v = proposal.value;
    const summary = deep.extractSectionByTitle(parent.analysis, '核心摘要');
    const provider = assertContext(active, parent);
    const quote = v.sourceEvidence;
    if (proposal.sha256 !== c.proposalFileSha256 || v.paperId !== parent.id
        || v.executionId !== r.selectedMainExecutionId || v.analysisFileSha256 !== r.selectedMainCAS.analysisFileSha256
        || v.sourceFileSha256 !== r.selectedMainCAS.sourceFileSha256 || v.sourceSha256 !== r.sourceSha256
        || sha(summary) !== c.beforeSummarySha256 || v.beforeCore !== summary || typeof v.afterCore !== 'string'
        || typeof v.beforeSentence !== 'string' || !v.beforeSentence.trim()
        || typeof v.afterSentence !== 'string' || !v.afterSentence.trim()
        || v.beforeSentence.length > 2000 || v.afterSentence.length > 2000
        || /[\r\n]/u.test(v.beforeSentence + v.afterSentence)
        || summary.split(v.beforeSentence).length !== 2
        || v.afterCore !== summary.replace(v.beforeSentence, v.afterSentence)
        || sha(v.afterCore) !== c.afterSummarySha256
        || !quote || !Number.isSafeInteger(quote.startUtf16) || !Number.isSafeInteger(quote.endUtf16)
        || quote.startUtf16 < 0 || quote.endUtf16 <= quote.startUtf16
        || typeof quote.quote !== 'string' || quote.quote.length < 1 || quote.quote.length > 180000
        || source.text.slice(quote.startUtf16, quote.endUtf16) !== quote.quote
        || c.sourceEvidenceSha256 !== stable(quote)
        || c.pdfSha256 !== provider.pdfSha256
        || c.authorization?.kind !== 'one_core_sentence_source_correction'
        || typeof c.authorization.instruction !== 'string' || !c.authorization.instruction.trim()) {
        fail('核心唯一原句/替换范围/真实原文证据或明确授权不同');
    }
    const tag = require('./tag-stage-record').readTagStageRecord(parent.analysisManifest, parent.analysisStageCheckpoints);
    const upstream = parent.analysisStageCheckpoints?.[tag.checkpointKey];
    if (typeof upstream !== 'string' || sha(upstream) !== tag.stage?.outputAnalysisSha256
        || sha(upstream) !== beforeStage.inputAnalysisSha256 || sha(upstream) !== c.upstreamCheckpointSha256) {
        fail('核心必须从真实原taxonomy输出开始，不能拿最终评分正文伪造上游');
    }
    const coreCheckpoint = deep.mergeSectionByTitle(upstream, '核心摘要', v.afterCore);
    const coreMain = deep.mergeSectionByTitle(parent.analysis, '核心摘要', v.afterCore);
    const outside = contract.hashAnalysisWithMaskedCoreSummary;
    if (!outside(upstream) || outside(coreCheckpoint) !== outside(upstream)
        || outside(coreMain) !== outside(parent.analysis)) fail('核心编辑改变了原12节');
    const semanticIssue = contract.validateCoreSummarySemanticContract(coreMain, { sourceText: source.text });
    if (semanticIssue) fail('新核心仍未通过当前真实source语义：' + semanticIssue);
    // This pure helper must be the same seven-field implementation extracted
    // from the normal deep stage, not a second parser or signing authority.
    const body = deep.buildCoreSummaryBindingBody(upstream, coreCheckpoint);
    const provenance = { contract: CORE_CONTRACT, scopeKind: 'source_core_correction',
        processId: active.batch.manifest.value.processId, executionId: r.childExecutionId,
        manifestSha256: active.batch.manifest.sha256, correctionSha256: active.row.file.sha256,
        originalRoleCAS: clone(roleRefs(r)), sourceSha256: r.sourceSha256,
        sourceSnapshotSha256: r.sourceSnapshotSha256, pdfSha256: provider.pdfSha256,
        originalCoreStageSha256: stable(beforeStage), proposalFileSha256: proposal.sha256,
        beforeSummarySha256: c.beforeSummarySha256, afterSummarySha256: c.afterSummarySha256,
        sourceEvidenceSha256: c.sourceEvidenceSha256, upstreamCheckpointSha256: sha(upstream), newApiRequests: 0 };
    const coreStage = { status: 'complete', executionKind: 'operator', model: 'operator-local', protocol: 'local_operator',
        newApiRequests: 0, ...body, bindingSha256: stable(body),
        fingerprint: stable(provenance), sourceCoreCorrection: provenance,
        originApiStage: clone(beforeStage), updatedAt: r.appliedAt,
        ...Object.fromEntries(['attempts', 'transportFailures'].filter(key => Object.hasOwn(beforeStage, key))
            .map(key => [key, beforeStage[key]])) };
    // No footnote classification or availability update in this policy.
    deep.replayVerifiedReaderResourceIdentity(parent.apiReaderResources, source.text);
    const evidence = deep.buildTypeAwareSourceContext(coreMain, source.text);
    const ids = new Set([...evidence.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1]));
    const restoreCaps = (strict, original) => ({ ...strict,
        ...(Array.isArray(original.capsApplied) ? { capsApplied: clone(original.capsApplied) } : {}) });
    const strictOriginal = restoreCaps(deep.revalidateScoringAudit(clone(oldScore.audit), ids), oldScore.audit);
    const canonical = analysis => {
        const normalized = deep.validateScoringAuditAgainstAnalysis(analysis,
            clone(oldScore.audit), parent.apiReaderResources, source.text);
        const context = deep.buildTypeAwareSourceContext(analysis, source.text);
        const contextIds = new Set([...context.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1]));
        return restoreCaps(deep.revalidateScoringAudit(normalized, contextIds), normalized);
    };
    // Validate the original reason against the same real source/resource guard;
    // canonical wording is evidence of validation, not authority to rewrite it.
    deep.enforceReaderResourceClaims({ sections: [{ body: oldScore.audit.dimensions.openSource.reason }] },
        parent.apiReaderResources, source.text, { paper: parent });
    const pairedAuditValidation = assertPairedCoreAudits(oldScore.audit, strictOriginal,
        canonical(parent.analysis), canonical(coreMain));
    const audit = clone(oldScore.audit);
    const analysis = deep.applyScoringAuditResult(coreMain, audit);
    if (outside(analysis) !== outside(parent.analysis)) fail('核心正常评分派生改变其它12节');
    const parsed = require('../utils').parseAnalysis(analysis), beforeParsed = require('../utils').parseAnalysis(parent.analysis);
    const protectedParsed = value => { const out = clone(value); delete out.summary; return out; };
    equal(protectedParsed(parsed), protectedParsed(beforeParsed), '核心scope改变非summary解析字段');
    return { executionKind: CORE_SCORE_KIND, newApiRequests: 0,
        correction: { identity: clone(parent.apiReaderResources), correctionSha256: stable(provenance) },
        analysis, parsed, audit, originalAuditSha256: oldScore.auditSha256,
        resourceIdentitySha256: parent.apiReaderResources.identitySha256, sourceBoundReasonReplacement: null,
        inputAnalysisSha256: sha(coreMain), evidenceSha256: sha(evidence), allowedEvidenceIds: [...ids],
        auditSha256: stable(audit), outputAnalysisSha256: sha(analysis), summarySha256: body.summarySha256,
        pairedAuditValidation, coreStage, coreCheckpoint };
}
function assertVerifiedCoreStage(paper, stage) {
    const active = current(); assertContext(active, paper);
    if (active.batch.policy.kind !== 'source_core_correction'
        || paper.analysisManifest?.stages?.coreSummaryRepair !== stage) fail('核心阶段不在同一独立私有scope');
    const input = prepareFinalizerInput(paper);
    equal(stage, input.coreStage, '核心本地阶段不是同一原文/原句/真实checkpoint派生');
    equal(paper.analysisStageCheckpoints?.coreSummaryRepair, input.coreCheckpoint, '核心本地输出检查点不同');
    equal(require('../deep-analyzer').extractSectionByTitle(paper.analysis, '核心摘要'),
        require('../deep-analyzer').extractSectionByTitle(input.audit.analysis, '核心摘要'), '核心正文不同');
    return true;
}
function currentVerifiedCorrection(paper, sourceDetails) {
    const active = current(); assertContext(active, paper);
    if (stable(sourceDetails) !== stable(active.loaded.source.sourceDetails)) fail('finalizer来源副本不同');
    return prepareFinalizerInput(paper);
}
function verifiedSignedFigureAssets(input, injectedFigures, materialize) {
    const active = current();
    if (input !== active.finalizerInput) fail('原图复用缺少本scope冻结引用');
    assertContext(active, { id: active.row.record.paperId, source: 'conference',
        sourceSha256: active.row.record.sourceSha256 });
    const keys = ['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256',
        'assetBytes', 'assetWidth', 'assetHeight'];
    const strip = figure => Object.fromEntries(Object.entries(figure).filter(([key]) =>
        !keys.includes(key) && key !== 'rawBytes'));
    const old = input.readerParent.apiReaderFigures;
    equal(injectedFigures.map(strip), old.map(strip), '新Reader改变原图科学说明或顺序');
    const directory = path.join(active.batch.analysisRoot, active.row.record.readerParentExecutionId, 'reader-assets');
    return injectedFigures.map((figure, index) => {
        const prior = old[index], filename = `figure-${prior.ordinal}-${prior.assetSha256?.slice(0, 16)}.png`;
        if (!SHA.test(prior.assetSha256 || '') || prior.assetFilename !== filename
            || prior.cachePath !== path.join(directory, filename) || prior.assetMediaType !== 'image/png') fail('原签会议图路径/SHA不规范');
        const raw = read(prior.cachePath, false);
        if (raw.sha256 !== prior.assetSha256 || raw.bytes.length !== prior.assetBytes) fail('原签图像素改变');
        const childPath = path.join(active.loaded.directory, 'reader-assets', filename);
        if (!active.cold && materialize) {
            if (!require('../analysis-engine').paperAnalysisLockHeld({ id: active.row.record.paperId })) {
                fail('新子稿原图保存必须持有同一论文锁');
            }
            // Preserve original pixels and metadata. Only the new child owns
            // this normal asset path; cold replay must never create or repair it.
            immutable(childPath, raw.bytes);
        }
        const child = read(childPath, false);
        if (child.sha256 !== prior.assetSha256 || child.bytes.length !== prior.assetBytes
            || !child.bytes.equals(raw.bytes)) fail('子稿原图与原签父稿字节不同');
        return { ...figure, ...Object.fromEntries(keys.map(key => [key, prior[key]])), cachePath: childPath };
    });
}
function readVerifiedSignedFigures(input, injectedFigures) {
    return verifiedSignedFigureAssets(input, injectedFigures, true);
}
function withCorrection(batchHandle, { executionId, planHandle, sourceRoot }, callback) {
    const batch = batchFor(batchHandle);
    const row = [...batch.rows.values()].find(item => item.record.childExecutionId === executionId);
    if (!row) fail('本地child不属于当前完整来源纠正登记');
    return withLocalSourceCorrection(prepareChild(batchHandle, row.record.paperId,
        { planHandle, sourceRoot }), callback);
}
function batchDescription(handle) {
    const b = batchFor(handle);
    return freeze({ manifestFile: b.manifest.file, manifestSha256: b.manifest.sha256,
        processId: b.manifest.value.processId, batchId: b.manifest.value.batchId,
        stateFileSha256: b.state.sha256, stateSha256: b.state.value.stateSha256,
        records: [...b.rows.values()].map(row => clone(row.record)) });
}
function assertFinalizerInput(value, paper) {
    const active = current(); assertContext(active, paper);
    if (value !== active.finalizerInput) fail('没有同一私有范围中的原 finalizer 输入引用');
    return value;
}
function scoringStage(input) {
    const active = current(); if (input !== active.finalizerInput) fail('本地评分输入未认证');
    const parent = input.parent, old = parent.analysisManifest.stages.scoringAudit;
    const core = input.coreStage || parent.analysisManifest.stages.coreSummaryRepair;
    return { status: 'complete', scoringContract: 'api-scoring-audit-v2', executionKind: active.batch.policy.scoreKind,
        model: 'local-deterministic', protocol: 'local_source_audit', newApiRequests: 0,
        sourceCorrection: clone(input.provenance), originApiStage: clone(old),
        audit: clone(input.audit.audit), auditSha256: input.audit.auditSha256,
        scoringInputSha256: input.audit.inputAnalysisSha256,
        coreSummaryInputAnalysisSha256: core.outputAnalysisSha256,
        inputCoreSummarySha256: core.summarySha256, outputCoreSummarySha256: core.summarySha256,
        evidenceSha256: input.audit.evidenceSha256,
        previousScore: old.audit.total, finalScore: input.audit.audit.total,
        scoreDelta: Number((input.audit.audit.total - old.audit.total).toFixed(1)),
        stabilityWarning: Math.abs(input.audit.audit.total - old.audit.total) > 0.3,
        localStability: { method: active.batch.policy.scoreKind, originalStageSha256: stable(old),
            ...(input.audit.pairedAuditValidation ? { pairedAuditValidation: clone(input.audit.pairedAuditValidation) } : {}),
            unchangedNonOpenSourceScoresSha256: stable(Object.fromEntries(Object.entries(old.audit.dimensions)
                .filter(([key]) => key !== 'openSource').map(([key, value]) => [key, value.score]))),
            sourceBoundReasonReplacement: clone(input.audit.sourceBoundReasonReplacement) },
        outputAnalysisSha256: input.audit.outputAnalysisSha256, refreshedAt: active.row.record.appliedAt };
}
const FAILURE_FIELDS = Object.freeze(['error', 'errorCode', 'errorCategory', 'errorScope', 'errorStatus',
    'retryable', 'latestAnalysisAttemptError', 'latestAnalysisAttemptAt', 'latestAnalysisAttemptErrorCode',
    'latestAnalysisAttemptRetryable', 'latestAnalysisAttemptCategory', 'latestAnalysisAttemptStatus',
    'latestAnalysisAttemptScope', 'latestAnalysisAttemptErrorCategory',
    'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope']);
function assertFailureProjection(parent, paper) {
    const code = parent.latestAnalysisAttemptErrorCode || parent.errorCode;
    const hasFailure = Boolean(parent.latestAnalysisAttemptError || parent.error
        || parent.digestStatus?.latestAttemptStatus === 'analysis_failed');
    if (hasFailure && (!code || !/^(?:READER_|CONFERENCE_READER_)/u.test(code))) {
        fail('来源纠正不授权清除非Reader的最新失败');
    }
    for (const key of FAILURE_FIELDS) {
        if (Object.hasOwn(paper, key)
            && (!Object.hasOwn(parent, key) || !isDeepStrictEqual(paper[key], parent[key]))) {
            fail('新child添加或改写了原失败字段');
        }
    }
    const oldStatus = parent.digestStatus?.latestAttemptStatus, status = paper.digestStatus?.latestAttemptStatus;
    if (oldStatus !== status && !(oldStatus === 'analysis_failed' && status === 'analyzed')) fail('新child状态收尾越界');
}
function clearVerifiedReaderFailure(paper) {
    const active = current(); const input = assertOutput(paper);
    const engine = require('../analysis-engine');
    if (!engine.hasValidApiReaderV3Records(paper)) fail('新Reader尚未通过全部正常记录校验');
    const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
    const upstream = engine.getConferenceReaderRefreshUpstreamReason(paper, { tagRules: rules });
    if (upstream) fail('最新上游仍不合格，不能清除当前child失败：' + upstream);
    assertFailureProjection(input.parent, paper);
    for (const key of FAILURE_FIELDS) delete paper[key];
    if (paper.digestStatus?.latestAttemptStatus === 'analysis_failed') {
        paper.digestStatus = { ...paper.digestStatus, latestAttemptStatus: 'analyzed' };
    }
    assertOutput(paper); return paper;
}
function protectedPaper(paper) {
    const value = clone(paper);
    for (const key of FAILURE_FIELDS) delete value[key];
    if (value.digestStatus) delete value.digestStatus.latestAttemptStatus;
    for (const key of ['analysis', 'parsed', 'apiReaderArticle', 'apiReaderPlan', 'apiReaderFigures',
        'apiReaderAuthors', 'apiReaderResources', 'apiReaderArticleSha256', 'apiReaderPlanSha256',
        'analysisCheckpoint', 'conferenceSourceCorrection', 'conferenceSourceCorrectionObligation']) delete value[key];
    const stages = value.analysisManifest?.stages || {};
    for (const key of ['scoringAudit', 'apiReaderArticle']) delete stages[key];
    if (scope.getStore()?.mainCheckpointRecovery) delete stages.imageSupplement;
    if (scope.getStore()?.batch.policy.kind === 'source_core_correction') delete stages.coreSummaryRepair;
    if (stages.openSourceScan) for (const key of ['resourceEvidenceContract', 'resourceEvidenceSha256']) delete stages.openSourceScan[key];
    const checkpoints = value.analysisStageCheckpoints || {};
    for (const key of ['scoringAudit', 'apiReaderArticle']) delete checkpoints[key];
    if (scope.getStore()?.batch.policy.kind === 'source_core_correction') delete checkpoints.coreSummaryRepair;
    return value;
}
function assertRecoveredImageSupplement(input, paper, requireComplete = false) {
    if (!input.mainCheckpointRecovery) return;
    const saved = paper.analysisManifest?.stages?.imageSupplement;
    if (saved === undefined) {
        // The normal finalizer checks local Reader output before its official
        // image closure. A saved/cold result may never retain that transient gap.
        if (requireComplete || current().cold) fail('检查点恢复的新Reader尚未完成正常官方图收尾');
        return;
    }
    const replay = clone(paper);
    delete replay.analysisManifest.stages.imageSupplement;
    const expected = require('../deep-analyzer').deriveConferenceLocalOfficialImageSupplement(replay,
        input.sourceDetails, { appliedAt: input.provenance.appliedAt });
    if (!expected) fail('没有原空候选对应的正常官方图阶段');
    equal(saved, expected, '检查点恢复的官方图阶段不是同一正常函数的精确派生');
}
function assertOutput(paper) {
    const active = current(); assertContext(active, paper);
    const input = prepareFinalizerInput(paper), deep = require('../deep-analyzer');
    equal(protectedPaper(paper), protectedPaper(input.parent), '本地纠正改变了受保护主文或原阶段');
    assertRecoveredImageSupplement(input, paper);
    assertFailureProjection(input.parent, paper);
    equal(paper.analysis, input.audit.analysis, '评分与资源正文未由公共操作派生');
    equal(paper.parsed, input.audit.parsed, '正式解析字段不同');
    equal(paper.apiReaderResources, input.resources, '资源身份不是同 PDF 的重新派生');
    equal(paper.apiReaderAuthors, input.readerParent.apiReaderAuthors, '未授权改变原签作者字段');
    // The complete cold gate verifies both actual pixel files too, rather than
    // waiting for page staging to discover a missing or changed child asset.
    // This shared helper is read-only here, including during a hot finalizer.
    equal(verifiedSignedFigureAssets(input, paper.apiReaderFigures, false), paper.apiReaderFigures,
        '当前child原图路径、像素或原签元数据不同');
    const locator = { contract: active.batch.policy.contract, processId: active.batch.manifest.value.processId,
        executionId: active.row.record.childExecutionId, manifestSha256: active.batch.manifest.sha256 };
    equal(paper.conferenceSourceCorrection, locator, '本地子运行定位器错误');
    equal(paper.conferenceSourceCorrectionObligation, { ...locator, status: 'complete',
        originalRoleCAS: clone(roleRefs(active.row.record)),
        sourceSha256: active.row.record.sourceSha256, sourceSnapshotSha256: active.row.record.sourceSnapshotSha256 },
        '本次来源事实义务没有由实际整篇输出闭合');
    equal(paper.analysisManifest.stages.scoringAudit, scoringStage(input), '本地评分执行声明不真实');
    if (input.scopeKind === 'source_core_correction') {
        assertVerifiedCoreStage(paper, paper.analysisManifest.stages.coreSummaryRepair);
        equal(paper.analysisStageCheckpoints?.coreSummaryRepair, input.coreCheckpoint, '本地核心新输出检查点不同');
        equal(paper.apiReaderResources, input.parent.apiReaderResources, '核心scope改变资源身份');
        const outside = require('../analysis-contract').hashAnalysisWithMaskedCoreSummary;
        equal(outside(paper.analysis), outside(input.parent.analysis), '核心scope最终原12节变化');
    }
    equal(paper.analysisStageCheckpoints?.scoringAudit, paper.analysis, '新评分检查点不同');
    equal(paper.analysisCheckpoint, paper.analysis, '新活动检查点不同');
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    if (stage.executionKind !== 'operator' || stage.model !== 'operator-local'
        || stage.protocol !== 'local_operator' || stage.newReaderApiRequests !== 0
        || !isDeepStrictEqual(stage.operatorProvenance, input.provenance)
        || !isDeepStrictEqual(stage.originApiStage, input.readerParent.analysisManifest.stages.apiReaderArticle)) fail('新Reader被冒充为原API输出');
    const old = input.readerParent.analysisManifest.stages.apiReaderArticle;
    for (const key of ['attempts', 'fullAttempts', 'transportFailures']) equal(stage[key], old[key], '原计数改变');
    const evidence = deep.buildApiReaderEvidenceContext('', input.sourceDetails.text,
        input.sourceDetails.structuredArtifacts, paper.id);
    const policy = require('./conference-analysis-context').conferenceWeakReaderCapabilityPolicy(paper,
        input.sourceDetails.structuredArtifacts);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(input.draft), {
        arxivId: paper.id, requiredVersion: 3, requireSourceBindings: true, requireIntegratedTables: true,
        minimumIntegratedTables: policy?.minimumIntegratedTables ?? require('./reader-contract').readerRequirements({
            version: 3, availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length }).minimumTables,
        readerCapabilityPolicy: policy, verifiedResourceIdentity: input.resources,
        enforceResourceAvailabilityClaims: true, allowDeterministicQuoteRepair: false,
        allowDeterministicUnsupportedClaimPruning: false,
        exactSignedBridgeSurfaces: input.readerParent.apiReaderPlan.conceptBridges.map(bridge => bridge.explanation),
        availableFigureOrdinals: input.readerParent.apiReaderFigures.map(figure => figure.ordinal),
        structuredArtifacts: input.sourceDetails.structuredArtifacts, sourceText: input.sourceDetails.text });
    equal(parsed.plan.tableBindings.map(binding => binding.sourceQuotes.map(item => item.quote)),
        input.draft.tableBindings.map(binding => binding.sourceQuotes),
        '正常解析增加了未批准sourceQuotes，不能借参考文献或别表补证');
    // One small deep hook factors the existing inject/prune/markdown-display
    // block shared with finalizeApiReaderRefresh. This is not a second parser.
    const expected = deep.replayApiReaderFinalDisplay(parsed, input.sourceDetails, paper.apiReaderFigures, paper.id);
    equal(expected.article, paper.apiReaderArticle, '正常Reader装配正文不同');
    if (deep.stableFingerprint(expected.plan) !== paper.apiReaderPlanSha256) fail('正常Reader计划SHA不同');
    const materialized = new Set(['cachePath', 'assetFilename', 'assetMediaType', 'assetSha256', 'assetBytes', 'assetWidth', 'assetHeight', 'rawBytes']);
    const core = figures => figures.map(figure => Object.fromEntries(Object.entries(figure)
        .filter(([key]) => !materialized.has(key))));
    equal(core(expected.figures), core(paper.apiReaderFigures), '正常原图说明、归属或顺序不同');
    if (active.row.record.reader.noEdit === true) {
        equal(paper.apiReaderArticle, input.readerParent.apiReaderArticle, 'no-edit正文并非exact');
        equal(deep.stableFingerprint(paper.apiReaderPlan), input.readerParent.apiReaderPlanSha256, 'no-edit计划并非exact');
        equal(core(paper.apiReaderFigures), core(input.readerParent.apiReaderFigures), 'no-edit图并非exact');
    }
    return input;
}
function assertVerified(paper) { assertOutput(paper); return current(); }
function localStabilityIsResolved(paper) {
    if (!isSourceCorrectionRecord(paper)) return false;
    assertOutput(paper); return true; // Exact deterministic chain, not API consensus.
}
function assertVerifiedScoringStage(paper, stage) {
    if (paper?.analysisManifest?.stages?.scoringAudit !== stage || stage?.executionKind !== current().batch.policy.scoreKind) {
        fail('本地稳定性必须绑定同一整篇对象的真实评分阶段');
    }
    assertOutput(paper); return true;
}
function assertMayAccessNetwork() { if (scope.getStore()) fail('来源纠正禁止任何网络请求'); }
function isSourceCorrectionRecord(paper) {
    const stages = paper?.analysisManifest?.stages || {};
    return Object.hasOwn(paper || {}, 'conferenceSourceCorrection')
        || Object.hasOwn(paper || {}, 'conferenceSourceCorrectionObligation')
        || [SCORE_KIND, CORE_SCORE_KIND].includes(stages.scoringAudit?.executionKind)
        || [CONTRACT, CORE_CONTRACT].includes(stages.apiReaderArticle?.operatorProvenance?.contract)
        || stages.coreSummaryRepair?.sourceCoreCorrection !== undefined;
}
function receiptBase(batch, row) {
    return path.join(batch.correctionRoot, 'registered', batch.manifest.sha256, row.record.childExecutionId);
}
function immutable(file, bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(file));
    require('./immutable-file').writeImmutableFile(file, bytes, fail);
}
function archiveOriginals(active) {
    const base = receiptBase(active.batch, active.row), index = [];
    for (const [role, ref] of Object.entries(roleRefs(active.row.record))) {
        const directory = path.join(active.batch.analysisRoot, ref.executionId);
        for (const entry of active.row.trees[role]) {
            const original = read(path.join(directory, entry.path), false);
            if (original.sha256 !== entry.sha256) fail('封存前原件改变');
            immutable(path.join(base, 'before', role, entry.path), original.bytes);
            index.push({ role, path: entry.path, original: original.file, sha256: original.sha256 });
        }
    }
    immutable(path.join(base, 'state-before.json'), active.batch.state.bytes);
    immutable(path.join(base, 'manifest-before.json'), active.batch.manifest.bytes);
    immutable(path.join(base, 'correction-before.json'), active.row.file.bytes);
    for (const key of ['coreCorrection', 'reasonCorrection']) if (active.row.record[key]) {
        immutable(path.join(base, key + '-proposal-before.json'), read(active.row.record[key].proposalFile).bytes);
    }
    return index;
}
function seal(paper) {
    const active = current();
    if (active.cold || !require('../analysis-engine').paperAnalysisLockHeld({ id: paper.id })) fail('封存须为真实热事务和论文锁');
    const input = assertOutput(paper);
    assertRecoveredImageSupplement(input, paper, true);
    const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
    if (!require('../analysis-engine').isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) fail('来源纠正未通过正常整篇资格');
    const archived = archiveOriginals(active);
    const body = { contract: active.batch.policy.receipt, version: 1, provenance: clone(input.provenance),
        stateFileSha256: active.batch.state.sha256, afterPaperSha256: stable(paper),
        originalTrees: clone(active.row.trees),
        feePins: clone(active.row.fees), beforeFiles: archived,
        sourceCorrectionSha256: input.audit.correction.correctionSha256,
        localAuditSha256: input.audit.auditSha256, beforeDraftSha256: input.provenance.beforeDraftSha256,
        afterDraftSha256: input.provenance.afterDraftSha256, newApiRequests: 0 };
    const receipt = { ...body, receiptSha256: stable(body) };
    const file = path.join(receiptBase(active.batch, active.row), 'receipt.json');
    immutable(file, Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
    assertContext(active, paper);
    return { receiptFile: file, receiptSha256: receipt.receiptSha256,
        expectedChildAnalysisFileSha256: active.loaded.analysisFileSha256,
        expectedChildRunFileSha256: active.loaded.runFileSha256 };
}
function assertAdoptedPage(loaded, item) {
    // Pure stored-file replay, not loadStage: do not recursively qualify Reader
    // while its source plan is reconstructing this original publication item.
    const stage = require('./conference-postprocess').loadPreservedStage({
        stagingRoot: require('../config').FILES.conferencePageStagingDir,
        executionId: loaded.run.executionId, paperId: loaded.run.paperId,
        pageProof: item.pageProof });
    if (stage.manifest.analysisSha256 !== loaded.analysisFileSha256
        || stage.manifest.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256
        || stage.manifest.completionReceiptSha256 !== loaded.run.completionReceipt?.receiptSha256) {
        fail('采纳的真实暂存页不绑定当前完整analysis/source/completion');
    }
    return stage;
}
function readRegisteredTransaction(paper, projectionToken = null) {
    const locator = paper.conferenceSourceCorrection;
    if (![CONTRACT, CORE_CONTRACT].includes(locator?.contract) || !UUID.test(locator.processId || '')
        || !UUID.test(locator.executionId || '') || !SHA.test(locator.manifestSha256 || '')) fail('本地标记缺少规范定位器');
    const policy = policyForContract(locator.contract), base = roots(locator.processId, policy);
    const loaded = require('./conference-analysis-adapter').loadConferenceAnalysis({
        analysisRoot: base.analysisRoot, executionId: locator.executionId });
    if (loaded.analysis.status !== 'complete' || loaded.run.paperId !== paper.id
        || !isDeepStrictEqual(loaded.analysis.papers[0], paper)) fail('冷核必须是完整实际canonical子稿');
    const directory = path.join(base.correctionRoot, 'registered', locator.manifestSha256, locator.executionId);
    const saved = read(path.join(directory, 'receipt.json'));
    const { receiptSha256, ...body } = saved.value;
    if (body.contract !== policy.receipt || body.version !== 1 || body.newApiRequests !== 0
        || receiptSha256 !== stable(body) || body.afterPaperSha256 !== stable(paper)
        || body.provenance?.executionId !== locator.executionId
        || body.provenance.manifestSha256 !== locator.manifestSha256) fail('冷回执与实际整包不一致');
    const originalState = read(path.join(directory, 'state-before.json'));
    const manifestBefore = read(path.join(directory, 'manifest-before.json'));
    if (originalState.sha256 !== body.stateFileSha256 || manifestBefore.sha256 !== locator.manifestSha256) fail('完整原状态/清单字节不同');
    const batch = loadBatch({ processId: locator.processId, manifestPath: body.provenance.manifestFile }, originalState);
    const row = batch.rows.get(paper.id);
    if (batch.policy !== policy) fail('冷清单合同与当前scope不同');
    if (!row || row.record.childExecutionId !== locator.executionId
        || row.file.sha256 !== body.provenance.correctionSha256
        || read(path.join(directory, 'correction-before.json')).sha256 !== row.file.sha256) fail('冷回执不属于同一原source条目');
    for (const key of ['coreCorrection', 'reasonCorrection']) if (row.record[key]) {
        if (read(path.join(directory, key + '-proposal-before.json')).sha256
            !== row.record[key].proposalFileSha256) fail('独立提案原字节归档缺失或变化');
    }
    equal(body.originalTrees, row.trees, '原Reader父/process指针/latest/main材料索引变化');
    equal(body.feePins, row.fees, '原费用索引变化');
    for (const entry of body.beforeFiles) {
        const ref = roleRefs(row.record)[entry.role];
        if (!ref || entry.path.split('/').some(part => !/^[A-Za-z0-9._-]+$/u.test(part)
            || ['.', '..'].includes(part))) fail('before索引路径非法');
        const expected = row.trees[entry.role].find(item => item.path === entry.path);
        const originalFile = path.join(batch.analysisRoot, ref.executionId, entry.path);
        if (entry.original !== originalFile || !expected || expected.sha256 !== entry.sha256
            || read(path.join(directory, 'before', entry.role, entry.path), false).sha256 !== entry.sha256
            || read(originalFile, false).sha256 !== entry.sha256) fail('before原件不能重放');
    }
    const expectedIndex = Object.entries(row.trees).flatMap(([role, entries]) =>
        entries.map(item => ({ role, path: item.path, sha256: item.sha256 })));
    equal(body.beforeFiles.map(({ role, path, sha256 }) => ({ role, path, sha256 })), expectedIndex, 'before完整成员被裁剪');
    if (loaded.sourceFileSha256 !== row.record.readerParentCAS.sourceFileSha256) fail('新canonical来源漂移');
    const actualState = read(path.join(batch.processDirectory, 'state.json'));
    if (actualState.sha256 !== batch.state.sha256) {
        require('./conference-process').assertState(actualState.value);
        const item = actualState.value.items[paper.id], adoption = item?.sourceResourceCorrectionAdoption;
        if (item?.status !== 'complete' || item.analysisRunId !== locator.executionId
            || item.analysisProof?.analysisSha256 !== loaded.analysisFileSha256
            || item.analysisProof?.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256
            || item.analysisProof?.completionReceiptSha256 !== loaded.run.completionReceipt?.receiptSha256
            || adoption?.manifestSha256 !== batch.manifest.sha256
            || adoption.previousStateSha256 !== batch.state.value.stateSha256
            || !SHA.test(item.pageProof?.manifestSha256 || '') || !SHA.test(item.pageProof?.contentSha256 || '')) fail('当前进程未正常采纳本地纠正子稿');
        assertAdoptedPage(loaded, item);
    }
    if (projectionToken === PROJECTION_ONLY) return { batch, row, loaded, receipt: body };
    const context = require('./conference-analysis-context').getConferenceAnalysisContext();
    const pdf = context?.executionId === locator.executionId && context.paperId === paper.id && context.readerPdfSourceHandle
        ? context.readerPdfSourceHandle : require('./conference-reader-publication-evidence')
            .replayCanonicalReaderPdfSource(paper, body.provenance.sourceIdentity);
    const handle = Object.freeze({});
    verified.set(handle, { batch, row, loaded, pdf, cold: true, receipt: body });
    return handle;
}
function withSavedPaper(paper, callback) {
    if (typeof callback !== 'function') fail('缺少同步完整核验回调');
    if (!isSourceCorrectionRecord(paper)) return callback();
    const hot = scope.getStore();
    if (hot) { assertOutput(paper); return callback(); }
    const handle = readRegisteredTransaction(paper);
    return withMember(handle, () => {
        const active = current(), input = assertOutput(paper);
        equal(input.provenance, active.receipt.provenance, '冷源纠正声明不同');
        if (input.audit.correction.correctionSha256 !== active.receipt.sourceCorrectionSha256
            || input.audit.auditSha256 !== active.receipt.localAuditSha256) fail('本地脚注/审计冷重算不同');
        return callback();
    });
}
function withSavedPublicationPaper(presented, callback) {
    if (typeof callback !== 'function') fail('出版冷重放缺少回调');
    if (!isSourceCorrectionRecord(presented)) return callback(presented);
    const locator = presented.conferenceSourceCorrection;
    if (![CONTRACT, CORE_CONTRACT].includes(locator?.contract) || !UUID.test(locator.executionId || '')) fail('出版视图缺实际定位器');
    const loaded = require('./conference-analysis-adapter').loadConferenceAnalysis({
        analysisRoot: require('../config').FILES.conferenceAnalysisDir, executionId: locator.executionId });
    const canonical = loaded.analysis.papers[0], expected = clone(canonical);
    expected.paper_id = canonical.id; delete expected.arxivId;
    if (!isDeepStrictEqual(presented, canonical) && !isDeepStrictEqual(presented, expected)) {
        fail('出版视图超出固定paper_id/arxivId身份适配');
    }
    return withSavedPaper(canonical, () => {
        const rules = require('./conference-postprocess').readOriginalTagProof(canonical).rules;
        if (!require('../analysis-engine').isSuccessfulAnalysisRecordForReadOnlyConferencePublication(
            canonical, { tagRules: rules })) fail('出版私有桥的来源纠正整篇资格未通过');
        return callback(canonical);
    });
}
function readVerifiedPublicationPdfSource(paper) {
    const active = current();
    if (!active.cold || !active.receipt) fail('私有出版PDF句柄只能来自实际冷回执');
    assertOutput(paper); return active.pdf;
}
function exportPublicationVerification(presented, canonical) {
    const active = current(); assertOutput(canonical);
    const expected = clone(canonical); expected.paper_id = canonical.id; delete expected.arxivId;
    if (!isDeepStrictEqual(presented, canonical) && !isDeepStrictEqual(presented, expected)) fail('出版视图字节未绑定');
    if (!active.cold || !active.receipt) fail('出版证明必须实际冷重放原封存回执');
    return { contract: 'conference-source-correction-verification-v1', verified: true,
        scopeKind: active.batch.policy.kind, sourceCorrectionContract: active.batch.policy.contract,
        executionId: active.row.record.childExecutionId, canonicalPaperSha256: stable(canonical),
        presentedPaperSha256: stable(presented), scoringStageSha256: stable(canonical.analysisManifest.stages.scoringAudit),
        sourceSha256: canonical.sourceSha256, receiptSha256: stable(active.receipt), newApiRequests: 0 };
}
// This API is consumed only by retained-source completion projections. It
// never accepts adoption.previousItem JSON or issues an analysis/source scope.
function readPreviousPublicationItem(item) {
    if (!item?.sourceResourceCorrectionAdoption) return null;
    const files = require('../config').FILES;
    const loaded = require('./conference-analysis-adapter').loadConferenceAnalysis({
        analysisRoot: files.conferenceAnalysisDir, executionId: item.analysisRunId });
    const paper = loaded.analysis.papers[0];
    if (loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
        || item.paperId !== paper.id || item.analysisProof?.analysisSha256 !== loaded.analysisFileSha256
        || item.analysisProof?.completionReceiptSha256 !== loaded.run.completionReceipt?.receiptSha256
        || item.analysisProof?.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256) fail('出版回投不是实际完整本地child');
    const record = readRegisteredTransaction(paper, PROJECTION_ONLY);
    assertAdoptedPage(loaded, item);
    const actual = read(path.join(record.batch.processDirectory, 'state.json'));
    require('./conference-process').assertState(actual.value);
    equal(actual.value.items[item.paperId], item, '出版回投不是当前实际process成员');
    const previous = record.batch.state.value.items[item.paperId], a = item.sourceResourceCorrectionAdoption;
    if (a.previousItemSha256 !== stable(previous) || a.previousStateSha256 !== record.batch.state.value.stateSha256
        || a.manifestFile !== record.batch.manifest.file || a.manifestSha256 !== record.batch.manifest.sha256
        || a.selectedMainExecutionId !== record.row.record.selectedMainExecutionId
        || a.readerParentExecutionId !== record.row.record.readerParentExecutionId
        || item.attempts !== previous.attempts || item.retryBudgetStart !== previous.retryBudgetStart
        || !isDeepStrictEqual(item.retryReleases, previous.retryReleases)
        || !isDeepStrictEqual(item.sourceProof, previous.sourceProof)) fail('出版原成员/次数/来源没有精确保留');
    const key = `${actual.value.processId}:${item.paperId}:${item.analysisRunId}`;
    const stack = publicationProjection.getStore() || [];
    if (stack.includes(key)) {
        // Full cold source replay can itself need the same projection to read
        // the original source plan. Permit only direct identical re-entry,
        // after all actual canonical/before/receipt checks above. This returns
        // old physical identity only; it cannot mint source/Reader authority.
        if (stack.at(-1) !== key) fail('来源出版回投父链循环');
        return clone(previous);
    }
    if (stack.length >= 16) fail('来源出版回投超过16层');
    return publicationProjection.run([...stack, key], () =>
        require('./analysis-stop-control').withModelRequestsForbidden(() => withSavedPaper(paper, () => {
            const rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
            if (!require('../analysis-engine').isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) fail('本地child完整冷核未通过');
            // Re-read after source/Reader replay rather than trusting first read.
            const after = read(path.join(record.batch.processDirectory, 'state.json'));
            equal(after.value.items[item.paperId], item, '冷回投期间当前成员改变');
            return clone(previous);
        })));
}
module.exports = { CONTRACT, SCORE_KIND, BATCH, RECEIPT, CORE_CONTRACT, CORE_SCORE_KIND, CORE_BATCH, CORE_RECEIPT, openBatch, prepareChild,
    withLocalSourceCorrection, prepareFinalizerInput, assertFinalizerInput, scoringStage,
    seal, sealCorrection: seal, withCorrection, currentVerifiedCorrection, readVerifiedSignedFigures, batchDescription,
    withSavedPaper, assertVerified, clearVerifiedReaderFailure, readPreviousPublicationItem,
    isSourceCorrectionRecord, localStabilityIsResolved, assertVerifiedScoringStage,
    withSavedPublicationPaper, exportPublicationVerification, readVerifiedPublicationPdfSource, assertVerifiedCoreStage,
    assertMayAccessNetwork, deriveLocalAudit };

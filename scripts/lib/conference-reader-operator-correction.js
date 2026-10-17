'use strict';
// Explicit human edits are source-bound local operations, never model responses
// or a new response/outer allowance. No API, network or canonical writer lives here.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const scope = new AsyncLocalStorage(), batches = new WeakMap();
const CONTRACT = 'conference-reader-operator-batch-v1';
const CORRECTION = 'conference-reader-operator-correction-v1';
const RECEIPT = 'conference-reader-operator-receipt-v1';
const SINGLE_TABLE_APPEND = 'single-source-table-append-v2';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => require('./reader-repair').hashDraft(value);
const fail = message => { throw Object.assign(new Error('会议人工Reader修正拒绝：' + message), {
    code: 'CONFERENCE_READER_OPERATOR_INTEGRITY', category: 'integrity', scope: 'run', retryable: false }); };
const clone = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function sameStat(a, b) {
    return ['dev','ino','size','mode','nlink','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
}
function read(filename, json = true) {
    const file = path.resolve(filename), named = fs.lstatSync(file, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || (named.mode & 0o777n) !== 0o600n
        || named.size > 64n * 1024n * 1024n) fail('必须读取私有有界独立文件');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameStat(opened, named)) fail('文件打开身份变化');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), last = fs.lstatSync(file, { bigint: true });
        if (!last.isFile() || last.isSymbolicLink() || !sameStat(opened, after) || !sameStat(after, last)
            || BigInt(bytes.length) !== opened.size) fail('文件读取期间变化');
        return { file, bytes, sha256: sha(bytes), ...(json ? { value: JSON.parse(bytes) } : {}) };
    } finally { fs.closeSync(fd); }
}
function inside(file, root) {
    const rel = path.relative(path.resolve(root), path.resolve(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('记录离开受控目录');
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(path.resolve(file)));
}
function tree(directory) {
    const rows = []; let total = 0;
    const visit = (folder, prefix = '') => {
        const s = fs.lstatSync(folder);
        if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700) fail('原材料目录必须私有且无符号链接');
        for (const name of fs.readdirSync(folder).sort()) {
            if (!/^[A-Za-z0-9._-]{1,220}$/u.test(name) || ['.','..'].includes(name)) fail('原材料文件名非法');
            const file = path.join(folder, name), relative = prefix + name, stat = fs.lstatSync(file);
            if (stat.isSymbolicLink()) fail('原材料不能含符号链接');
            if (stat.isDirectory()) { visit(file, relative + '/'); continue; }
            const r = read(file, false); total += r.bytes.length;
            if (rows.length >= 4096 || total > 256 * 1024 * 1024) fail('原材料超过只读边界');
            rows.push({ path: relative, sha256: r.sha256 });
        }
    };
    visit(directory); return rows;
}
function retainedFiles(directory) {
    const files = fs.readdirSync(directory).filter(name => /^reader-grant-(?:request|response)-[a-f0-9-]{36}\.json$/u.test(name)).sort()
        .map(name => ({ path: name, sha256: read(path.join(directory, name)).sha256 }));
    if (files.length > 256) fail('原请求响应超过窗口边界');
    const assetsDirectory = path.join(directory, 'reader-assets');
    return { files, assets: fs.existsSync(assetsDirectory) ? tree(assetsDirectory) : null };
}
// A member subtype is not a grant. Only the existing complete failed-set
// loader, registered window and actual PDF provider may enter this private path.
function correctionMemberKind(record) {
    if (record.version === 2 && record.correctionKind === SINGLE_TABLE_APPEND) {
        if (record.originKind !== undefined) fail('追加表只能使用未声明其它origin的原活跃失败候选');
        if (record.patch !== undefined || !record.tableAppend || typeof record.tableAppend !== 'object'
            || !/^[a-f0-9]{64}$/u.test(record.tableAppend.specSha256 || '')
            || hash(record.tableAppend.spec) !== record.tableAppend.specSha256) fail('追加表缺少固定显式数据规格');
        return SINGLE_TABLE_APPEND;
    }
    if (record.version !== undefined && record.version !== 1 || record.correctionKind !== undefined
        || record.tableAppend !== undefined) fail('未知人工条目版本或结构子类型');
    return 'existing-nodes-v1';
}
function replayMember(record, candidate, source = null) {
    if (correctionMemberKind(record) !== SINGLE_TABLE_APPEND) return { draft: replay(record, candidate), appendData: null };
    if (!source?.loaded || !source.pdf) fail('追加表须由完整失败集私有loader和真实PDF能力重放');
    const { loaded, pdf, beforeAnalysis = null, beforeRun = null, cold = false } = source;
    if (cold && (!beforeAnalysis || !beforeRun)) fail('冷追加必须使用回执原analysis/run字节');
    const spec = record.tableAppend.spec, directory = path.resolve(loaded.directory);
    const expected = ['analysis.json','run.json','source.json','reader-revision.json','reader-grant-budget.json']
        .map(name => path.join(directory, name)).concat(path.resolve(record.baselineCandidateFile));
    if (!isDeepStrictEqual(Object.keys(spec.originalPackageCAS || {}).sort(), expected.sort())
        || path.dirname(path.resolve(record.baselineCandidateFile)) !== path.join(directory, 'reader-attempts')
        || spec.candidatePath !== path.resolve(record.baselineCandidateFile)
        || spec.sourceRecordPath !== path.join(directory, 'source.json')
        || spec.paperId !== record.paperId || spec.executionId !== record.executionId
        || spec.sourceTextSha256 !== record.sourceSha256 || spec.sourceSnapshotSha256 !== record.sourceSnapshotSha256
        || spec.originalEnvelopeSha256 !== record.baselineCandidateEnvelopeSha256
        || spec.originalDraftSha256 !== record.baselineDraftSha256
        || spec.proposedDraftSha256 !== hash(record.draft)
        || spec.originalPackageCAS[path.join(directory, 'analysis.json')] !== record.analysisFileSha256
        || spec.originalPackageCAS[path.join(directory, 'run.json')] !== record.runFileSha256
        || spec.originalPackageCAS[path.join(directory, 'source.json')] !== record.sourceFileSha256) fail('追加规格不是当前成员原六文件/source/CAS');
    const provider = require('./conference-source-context').readerPdfSourceForContext(pdf);
    if (!provider || provider.paperId !== record.paperId || provider.sourceSnapshotSha256 !== record.sourceSnapshotSha256
        || provider.sourceText !== loaded.source.sourceDetails.text || provider.pdfSha256 !== spec.pdfSha256) fail('追加表没有真实同源PDF能力');
    provider.assertUnchanged();
    const packageBytes = {};
    for (const filename of expected) {
        const original = filename === path.join(directory, 'analysis.json') && beforeAnalysis
            || filename === path.join(directory, 'run.json') && beforeRun;
        packageBytes[filename] = original ? original.bytes : read(filename, false).bytes;
    }
    if (!isDeepStrictEqual(JSON.parse(packageBytes[spec.candidatePath].toString('utf8')), candidate)) fail('追加候选不是原物理包');
    let result;
    try { result = require('./reader-single-source-table-append').appendPinnedSingleSourceTable({
        spec, specSha256: record.tableAppend.specSha256, packageBytes, pdfBytes: provider.pdf }); }
    catch (error) { fail(`追加表数据重放失败：${error.message}`); }
    provider.assertUnchanged();
    if (!isDeepStrictEqual(result.draft, record.draft) || result.delta.dataValidationOnly !== true) fail('追加正文与固定批准稿不同');
    return { draft: result.draft, appendData: { correctionKind: SINGLE_TABLE_APPEND, memberVersion: 2, ...result.delta } };
}
function memberProofFields(record, appendData) {
    return correctionMemberKind(record) === SINGLE_TABLE_APPEND
        ? { correctionKind: SINGLE_TABLE_APPEND, memberVersion: 2, singleTableAppend: clone(appendData) } : {};
}
function replay(record, candidate) {
    if (record.contract !== CORRECTION || record.notLlmResponse !== true) fail('不是明确人工补丁');
    if (correctionMemberKind(record) !== 'existing-nodes-v1') fail('结构子类型不能使用公开纯v1 replay取得来源权限');
    // The daily export is a pure patch verifier; its daily admission/scope is
    // deliberately never called and no fresh/arXiv identity is manufactured.
    return require('./daily-reader-operator-correction').replay({ ...record,
        contract: 'reader-human-source-edit-v1' }, candidate);
}
function loadBatchData({ manifestPath, processDirectory, analysisRoot, grantHandle }, savedState = null) {
    const grants = require('./conference-recovery-grant'), summary = grants.recoveryGrantSummary(grantHandle);
    const processDir = path.resolve(processDirectory), root = path.resolve(analysisRoot);
    if (processDir !== path.join(path.dirname(root), 'conference-processes', summary.processId)) fail('进程目录不是许可对应的规范路径');
    if (path.basename(processDir) !== summary.processId) fail('不是原许可进程');
    const recordRoot = path.join(processDir, 'reader-operator-corrections'); inside(manifestPath, recordRoot);
    const manifest = read(manifestPath), m = manifest.value;
    if (m.contract !== CONTRACT || m.version !== 1 || m.processId !== summary.processId
        || m.grantId !== summary.grantId || m.grantSha256 !== summary.grantSha256
        || typeof m.authorization !== 'string' || !m.authorization.trim()
        || !Array.isArray(m.correctionFiles) || !m.correctionFiles.length
        || !/^[a-f0-9]{64}$/u.test(m.stateFileSha256 || '')) fail('显式人工清单身份不完整');
    const state = savedState || read(path.join(processDir, 'state.json'));
    if (state.sha256 !== m.stateFileSha256) fail('最终失败集已变化');
    require('./conference-process').assertState(state.value);
    const checkedState = state.value;
    if (checkedState.processId !== summary.processId || checkedState.status !== 'partial'
        || Object.values(checkedState.items).some(row => row.status === 'analyzing')) fail('不是已停稳原进程');
    const failed = Object.values(checkedState.items).filter(row => row.status !== 'complete').map(row => row.paperId).sort();
    // The human tail is available only after the registered normal window has
    // actually finished its rounds. A manifest cannot assert this by itself.
    const grantDirectory = path.join(path.dirname(root), 'conference-recovery-grants', summary.grantId);
    const registered = read(path.join(grantDirectory, 'manifest.json')),
        baseline = read(path.join(grantDirectory, 'baseline-state.json'));
    if (registered.value.manifestSha256 !== summary.grantSha256
        || baseline.sha256 !== registered.value.baselineStateFileSha256) fail('原许可基线字节不一致');
    require('./conference-process').assertState(baseline.value);
    if (!isDeepStrictEqual(Object.keys(checkedState.items).sort(), Object.keys(baseline.value.items).sort())) fail('不是原许可的完整论文集合');
    const limit = Math.min(15, Math.max(10, Math.floor(Object.keys(baseline.value.items).length / 10)));
    if (!failed.length || failed.length > limit) fail('最终失败集超过少量人工修正上限');
    for (const paperId of failed) {
        const item = checkedState.items[paperId], original = baseline.value.items[paperId];
        const releases = (item.retryReleases || []).filter(release => release.recoveryGrantId === summary.grantId);
        if (!original || !Number.isInteger(original.attempts) || !Number.isInteger(item.attempts)
            || item.retryBudgetStart !== original.attempts || releases.length !== 1
            || releases[0].attempts !== original.attempts || releases[0].recoveryGrantSha256 !== summary.grantSha256
            || item.attempts - original.attempts < summary.limits.maxRounds) fail('尚未完成同一许可的全部正常轮次');
    }
    const records = new Map();
    for (const filename of m.correctionFiles) {
        inside(filename, recordRoot); const file = read(filename), r = file.value;
        const member = grants.readRecoveryGrantMember(grantHandle, r.paperId);
        if (r.contract !== CORRECTION || r.notLlmResponse !== true || records.has(r.paperId)
            || r.executionId !== member.expectedExecutionId || path.resolve(member.analysisRoot) !== root
            || r.sourceSha256 !== member.sourceSha256 || r.sourceSnapshotSha256 !== member.sourceSnapshotSha256
            || !Number.isFinite(Date.parse(r.appliedAt)) || !/^[a-f0-9]{64}$/u.test(r.analysisFileSha256 || '')
            || !/^[a-f0-9]{64}$/u.test(r.runFileSha256 || '') || !/^[a-f0-9]{64}$/u.test(r.sourceFileSha256 || '')) fail('人工条目或原CAS身份错误');
        correctionMemberKind(r);
        records.set(r.paperId, { file, record: r, member });
    }
    if (!isDeepStrictEqual([...records.keys()].sort(), failed)) fail('人工清单必须精确覆盖完整当前失败集合');
    return { manifest, state, processDir, analysisRoot: root, grantHandle, records,
        baselineFile: baseline.file, baselineSha256: baseline.sha256 };
}
function openCorrectionBatch(options) {
    const handle = Object.freeze({}); batches.set(handle, loadBatchData(options)); return handle;
}
function assertSavedBatchMember(handle, paper) {
    const batch = batches.get(handle), row = batch?.records.get(paper?.id), proof = paper?.analysisManifest?.stages?.apiReaderArticle?.operatorProvenance;
    if (!batch || !row || proof?.contract !== CORRECTION) fail('完成稿不是当前真实人工清单的成员');
    assertBatchFiles(batch, row);
    const r = row.record;
    if (correctionMemberKind(r) === SINGLE_TABLE_APPEND
        ? proof.memberVersion !== 2 || proof.correctionKind !== SINGLE_TABLE_APPEND
            || proof.singleTableAppend?.specSha256 !== r.tableAppend.specSha256
        : proof.memberVersion !== undefined || proof.correctionKind !== undefined || proof.singleTableAppend !== undefined) fail('完成稿人工子类型或追加规格不属于本成员');
    if (proof.manifestFile !== batch.manifest.file || proof.manifestSha256 !== batch.manifest.sha256
        || proof.correctionFile !== row.file.file || proof.correctionSha256 !== row.file.sha256
        || proof.paperId !== r.paperId || proof.executionId !== r.executionId
        || proof.sourceSha256 !== r.sourceSha256 || proof.sourceSnapshotSha256 !== r.sourceSnapshotSha256
        || proof.originalAnalysisFileSha256 !== r.analysisFileSha256 || proof.originalRunFileSha256 !== r.runFileSha256
        || proof.originalCandidateEnvelopeSha256 !== r.baselineCandidateEnvelopeSha256
        || proof.beforeDraftSha256 !== r.baselineDraftSha256 || proof.afterDraftSha256 !== hash(r.draft)
        || proof.grantId !== batch.manifest.value.grantId || proof.grantSha256 !== batch.manifest.value.grantSha256
        || paper.sourceSha256 !== r.sourceSha256
        || read(path.join(batch.analysisRoot, r.executionId, 'source.json')).sha256 !== r.sourceFileSha256) fail('完成稿属于不同人工清单、补丁、原CAS或来源');
    return true;
}

function assertBatchFiles(batch, row) {
    if (read(batch.manifest.file).sha256 !== batch.manifest.sha256 || read(row.file.file).sha256 !== row.file.sha256) fail('人工清单或补丁字节变化');
    if (read(batch.baselineFile).sha256 !== batch.baselineSha256) fail('原许可完整基线已变化');
    row.member.assertUnchanged();
}
function readBaseline(batch, row, loaded, planHandle, sourceRoot, { cold = false, beforeAnalysis = null, beforeRun = null } = {}) {
    const adapter = require('./conference-analysis-adapter'), repair = require('./reader-repair'), r = row.record;
    assertBatchFiles(batch, row);
    if (loaded.run.paperId !== r.paperId || loaded.run.executionId !== r.executionId || !loaded.recoveryWindow
        || loaded.recoveryWindow.authority.grantSha256 !== batch.manifest.value.grantSha256
        || loaded.sourceFileSha256 !== r.sourceFileSha256
        || (!cold && (loaded.analysis.status !== 'partial' || loaded.analysisFileSha256 !== r.analysisFileSha256 || loaded.runFileSha256 !== r.runFileSha256))) fail('当前会议子运行与原失败包不一致');
    const pdf = adapter.verifyPlanAuthority(loaded, planHandle, sourceRoot);
    const directory = path.join(loaded.directory, 'reader-attempts'), entries = tree(directory);
    const active = entries.filter(entry => /^[a-f0-9]{64}\.json$/u.test(entry.path));
    if (active.length !== 1) fail('需要唯一原活跃失败候选；无候选的旧签稿不由此入口恢复');
    const candidateFile = path.join(directory, active[0].path), checked = repair.readFailedCandidateEnvelope(directory, null, candidateFile);
    if (!checked || checked.envelopeSha256 !== active[0].sha256 || r.baselineCandidateEnvelopeSha256 !== checked.envelopeSha256
        || path.resolve(r.baselineCandidateFile) !== candidateFile) fail('原活跃候选CAS错误');
    const candidate = checked.envelope, identity = candidate.identity;
    if (identity.paperId !== r.paperId || identity.sourceSha256 !== r.sourceSha256 || identity.freshAnalysis !== undefined
        || identity.contentMode !== 'reader-source-only-v1' || identity.conferenceReaderRetryEpoch !== 1
        || candidate.payload.attempts < 1 || !repair.parseRecoveryDraft(candidate.payload.draft)) fail('原候选不是同源会议失败稿');
    const { draft, appendData } = replayMember(r, candidate, { loaded, pdf, cold, beforeAnalysis, beforeRun });
    for (const key of ['sections','conceptBridges','figurePlacements','tableBindings','formulaBindings']) {
        const delta = appendData && key === 'tableBindings' ? 1 : 0;
        if (draft[key].length !== candidate.payload.draft[key].length + delta) fail('人工补丁不能增删非获准原结构数量');
    }
    const ledger = read(path.join(loaded.directory, 'reader-grant-budget.json'));
    const before = beforeAnalysis?.value || loaded.analysis, beforePaper = before.papers?.[0];
    if (!beforePaper || beforePaper.id !== r.paperId || beforePaper.sourceSha256 !== r.sourceSha256) fail('完整原包缺失');
    const pins = { entries, materials: retainedFiles(loaded.directory), ledgerSha256: ledger.sha256, sourceFileSha256: loaded.sourceFileSha256,
        revisionFileSha256: read(path.join(loaded.directory, 'reader-revision.json')).sha256,
        beforeAnalysisBytes: beforeAnalysis ? beforeAnalysis.bytes : read(path.join(loaded.directory, 'analysis.json')).bytes,
        beforeRunBytes: beforeRun ? beforeRun.bytes : read(path.join(loaded.directory, 'run.json')).bytes };
    return { batch, row, loaded, pdf, candidate, draft, appendData, pins, beforePaper,
        beforeAnalysis: before, beforeRun: beforeRun?.value || loaded.run, cold, planHandle, sourceRoot };
}
function assertOriginals(active) {
    const { batch, row, loaded, pins } = active;
    assertBatchFiles(batch, row);
    if (!active.cold && (read(path.join(loaded.directory, 'analysis.json')).sha256 !== row.record.analysisFileSha256
        || read(path.join(loaded.directory, 'run.json')).sha256 !== row.record.runFileSha256
        || read(path.join(batch.processDir, 'state.json')).sha256 !== batch.state.sha256)) fail('完整原失败包或最终失败集发生变化');
    if (!isDeepStrictEqual(tree(path.join(loaded.directory, 'reader-attempts')), pins.entries)
        || read(path.join(loaded.directory, 'reader-grant-budget.json')).sha256 !== pins.ledgerSha256
        || read(path.join(loaded.directory, 'source.json')).sha256 !== pins.sourceFileSha256
        || read(path.join(loaded.directory, 'reader-revision.json')).sha256 !== pins.revisionFileSha256
        || !isDeepStrictEqual(retainedFiles(loaded.directory), pins.materials)) fail('原候选/响应/预算/来源发生变化');
    require('./conference-source-context').readerPdfSourceForContext(active.pdf).assertUnchanged();
}
function withCorrection(handle, { executionId, planHandle, sourceRoot }, callback) {
    const batch = batches.get(handle); if (!batch || typeof callback !== 'function') fail('需要真实人工清单能力');
    const row = [...batch.records.values()].find(row => row.record.executionId === executionId); if (!row) fail('子运行不在人工清单');
    const loaded = require('./conference-analysis-adapter').loadGrantedConferenceRecovery({ analysisRoot: batch.analysisRoot, executionId });
    const active = readBaseline(batch, row, loaded, planHandle, sourceRoot);
    assertOriginals(active);
    const options = { paperId: loaded.run.paperId, executionId, executionDir: loaded.directory, readerPdfSourceHandle: active.pdf };
    return require('./conference-analysis-context').withConferenceAnalysisSource({ ...options,
        sourceDetails: loaded.source.sourceDetails, readerRetryEpoch: 1 }, () =>
        require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(batch.grantHandle, options, () =>
            require('./analysis-stop-control').withModelRequestsForbidden(() => scope.run(active, callback))));
}

// This view restores only this exact failed run's already-complete scientific
// checkpoint. Original before bytes, failed stages and counters stay archived.
const MAIN_CHECKPOINT = 'conference-reader-main-checkpoint-recovery-v1';
const checkpointStable = value => require('./fresh-rewrite-run').stableHash(value);
const CHECKPOINT_FAILURE_FIELDS = Object.freeze(['error', 'errorCode', 'errorCategory', 'errorScope', 'errorStatus',
    'retryable', 'latestAnalysisAttemptError', 'latestAnalysisAttemptAt', 'latestAnalysisAttemptErrorCode',
    'latestAnalysisAttemptRetryable', 'latestAnalysisAttemptCategory', 'latestAnalysisAttemptStatus',
    'latestAnalysisAttemptScope', 'latestAnalysisAttemptErrorCategory',
    'latestAnalysisAttemptErrorStatus', 'latestAnalysisAttemptErrorScope']);
function projectMainCheckpoint(active) {
    const raw = active.rawBeforePaper || active.beforePaper, r = active.row.record;
    if (raw.analysis !== null) {
        if (r.mainCheckpointRecovery !== undefined) fail('非空主文不能声明评分检查点恢复');
        active.rawBeforePaper = raw; active.beforePaper = raw; active.mainCheckpointRecovery = null;
        return raw;
    }
    const source = active.loaded.source.sourceDetails;
    const context = require('./conference-analysis-context').getConferenceAnalysisContext();
    const stages = raw.analysisManifest?.stages, checkpoint = raw.analysisStageCheckpoints?.scoringAudit;
    const images = raw.imageManifest, download = stages?.imageDownload;
    if (!context || context.paperId !== r.paperId || context.executionId !== r.executionId
        || context.executionDir !== active.loaded.directory || context.readerPdfSourceHandle !== active.pdf
        || active.loaded.revision.mode !== 'normal-analysis' || active.beforeRun?.executionId !== r.executionId
        || raw.id !== r.paperId || raw.source !== 'conference'
        || source.source !== 'conference_pdf_text' || source.sourceId !== r.paperId
        || sha(source.text) !== r.sourceSha256 || raw.sourceSha256 !== r.sourceSha256
        || raw.analysisManifest?.sourceAcquisition?.sourceSha256 !== r.sourceSha256
        || typeof checkpoint !== 'string' || !checkpoint.trim() || raw.analysisCheckpoint !== checkpoint
        || stages?.scoringAudit?.status !== 'complete' || sha(checkpoint) !== stages.scoringAudit.outputAnalysisSha256
        || stages.apiReaderArticle?.status !== 'invalid_output'
        || !/^(?:READER_|CONFERENCE_READER_)/u.test(raw.latestAnalysisAttemptErrorCode || raw.errorCode || '')
        || !(raw.latestAnalysisAttemptError || raw.error) || stages.imageSupplement !== undefined
        || download?.status !== 'no_candidates' || download.attempted !== 0 || download.downloaded !== 0
        || !Array.isArray(download.outcomes) || download.outcomes.length || images?.totalFound !== 0
        || ['candidates', 'downloaded', 'selected', 'downloadOutcomes'].some(key => !Array.isArray(images?.[key]) || images[key].length)
        || !Array.isArray(source.imageInfos) || source.imageInfos.length) fail('空主文缺少同执行的完整评分、原Reader失败或真实零图来源');
    require('./conference-source-context').readerPdfSourceForContext(active.pdf).assertUnchanged();
    const recovery = { contract: MAIN_CHECKPOINT, rawAnalysisValue: null, rawPaperSha256: checkpointStable(raw),
        analysisCheckpointSha256: sha(raw.analysisCheckpoint), scoringCheckpointSha256: sha(checkpoint),
        scoringOutputAnalysisSha256: stages.scoringAudit.outputAnalysisSha256,
        scoringStageSha256: checkpointStable(stages.scoringAudit), readerStageSha256: checkpointStable(stages.apiReaderArticle),
        originalFailureFieldsSha256: checkpointStable(Object.fromEntries(CHECKPOINT_FAILURE_FIELDS.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]))),
        readerRevisionProgressSha256: checkpointStable(active.beforeAnalysis.readerRevisionProgress ?? null), missingImageSupplement: true };
    if (!isDeepStrictEqual(r.mainCheckpointRecovery, recovery)) fail('评分检查点恢复声明与原完整失败包不同');
    const view = { ...clone(raw), analysis: checkpoint, parsed: require('../utils').parseAnalysis(checkpoint) };
    // Only this new normal-analysis checkpoint branch uses the scientific gate.
    // Nonempty inherited main text retains its original-registry preflight.
    if (!require('./completed-reader-upstream').completedReaderUpstream(view, source)) fail('当前评分检查点未通过完整科学上游核验');
    active.rawBeforePaper = raw; active.beforePaper = view; active.mainCheckpointRecovery = recovery;
    return view;
}
function prepareReaderInput() {
    const active = scope.getStore();
    if (!active || active.cold || !require('../analysis-engine').paperAnalysisLockHeld({ id: active.row.record.paperId })) fail('检查点输入须在真实热人工scope及论文锁内');
    assertOriginals(active);
    const paper = projectMainCheckpoint(active);
    return { paper: clone(paper), mainCheckpointRecovery: active.mainCheckpointRecovery ? clone(active.mainCheckpointRecovery) : null };
}
function assertCheckpointImageSupplement(active, paper, requireComplete = false) {
    if (!active.mainCheckpointRecovery) return;
    const saved = paper.analysisManifest?.stages?.imageSupplement;
    if (saved === undefined) {
        if (requireComplete || active.cold) fail('评分检查点恢复尚未正常完成官方图收尾');
        return;
    }
    const replay = clone(paper); delete replay.analysisManifest.stages.imageSupplement;
    const expected = require('../deep-analyzer').deriveConferenceLocalOfficialImageSupplement(replay,
        active.loaded.source.sourceDetails, { appliedAt: active.row.record.appliedAt });
    if (!expected || !isDeepStrictEqual(saved, expected)) fail('官方图阶段不是当前正常函数的精确派生');
}
function finalizeCheckpointImages(paper) {
    const active = scope.getStore(); if (!active || active.cold) fail('官方图收尾须在真实热人工scope');
    if (!active.mainCheckpointRecovery) return paper;
    if (paper.analysisManifest?.stages?.imageSupplement !== undefined) fail('原缺失官方图阶段已被提前填入');
    const expected = require('../deep-analyzer').deriveConferenceLocalOfficialImageSupplement(paper,
        active.loaded.source.sourceDetails, { appliedAt: active.row.record.appliedAt });
    if (!expected) fail('没有正常官方图收尾结果');
    paper.analysisManifest.stages.imageSupplement = expected;
    assertCheckpointImageSupplement(active, paper, true); return paper;
}

function current(paper, identity) {
    const active = scope.getStore(); if (!active) return null;
    const actual = require('./conference-analysis-context').getConferenceAnalysisContext(), r = active.row.record;
    if (!actual || actual.paperId !== r.paperId || actual.executionId !== r.executionId
        || actual.executionDir !== active.loaded.directory || actual.readerPdfSourceHandle !== active.pdf
        || paper.id !== r.paperId || paper.arxivId || paper.paper_id || paper.sourceSha256 !== r.sourceSha256
        || identity.paperId !== r.paperId || identity.sourceSha256 !== r.sourceSha256
        || identity.freshAnalysis !== undefined || identity.contentMode !== 'reader-source-only-v1') fail('人工修正离开真实会议身份/来源作用域');
    assertOriginals(active);
    assertCompatibleIdentity(active.candidate.identity, identity);
    const expectedGrant = require('./conference-reader-recovery-window').getCurrentReaderWindow(paper);
    if (!isDeepStrictEqual(identity.conferenceReaderGrant, expectedGrant)
        || !isDeepStrictEqual(active.candidate.identity.conferenceReaderGrant, expectedGrant)) fail('候选不属于同一原许可窗口');
    active.currentIdentity = clone(identity);
    const proof = { contract: CORRECTION, version: 1, executionKind: 'operator', newReaderApiRequests: 0,
        ...memberProofFields(r, active.appendData),
        paperId: r.paperId, executionId: r.executionId, processId: active.batch.manifest.value.processId,
        grantId: active.batch.manifest.value.grantId, grantSha256: active.batch.manifest.value.grantSha256,
        manifestFile: active.batch.manifest.file, manifestSha256: active.batch.manifest.sha256,
        correctionFile: active.row.file.file, correctionSha256: active.row.file.sha256,
        sourceSha256: r.sourceSha256, sourceSnapshotSha256: r.sourceSnapshotSha256,
        originalAnalysisFileSha256: r.analysisFileSha256, originalRunFileSha256: r.runFileSha256,
        sourceIdentity: clone(require('./conference-source-context').readerPdfSourceForContext(active.pdf).sourceIdentity),
        receiptFile: receiptFile(active),
        originalCandidateEnvelopeSha256: r.baselineCandidateEnvelopeSha256,
        originalIdentitySha256: hash(active.candidate.identity), currentInputIdentitySha256: hash(identity),
        beforeDraftSha256: hash(active.candidate.payload.draft), afterDraftSha256: hash(active.draft),
        retainedAttempts: active.candidate.payload.attempts, retainedFullAttempts: active.candidate.payload.fullAttempts,
        ...(active.mainCheckpointRecovery ? { mainCheckpointRecovery: clone(active.mainCheckpointRecovery) } : {}),
        appliedAt: r.appliedAt };
    active.proof = proof;
    return { payload: { ...clone(active.candidate.payload), draft: clone(active.draft), rawDraft: JSON.stringify(active.draft) }, proof: clone(proof) };
}
function execution(proof) {
    if (proof && (!scope.getStore()?.proof || !isDeepStrictEqual(scope.getStore().proof, proof))) fail('非本scope签发的人工来源');
    return proof ? { executionKind: 'operator', operatorProvenance: clone(proof), newReaderApiRequests: 0,
        model: 'operator-local', protocol: 'local_operator' } : {};
}
// A caller cannot use this scope to request an asset: the normal finalizer must
// use existing same-SHA local assets/resources. Call at network entry points.
function assertMayAccessNetwork() { if (scope.getStore()) fail('人工修正禁止网络请求'); }
const implementationFields = require('./reader-recovery-revision').ALLOWED_FIELDS.filter(key =>
    key.endsWith('ImplementationSha256') || ['repairImplementationSha256','tableCompilerSha256','draftOrderContract','mechanicalContractSha256'].includes(key));
function assertCompatibleIdentity(original, actual) {
    const logical = value => Object.fromEntries(Object.entries(value).filter(([key]) => !implementationFields.includes(key)));
    if (!isDeepStrictEqual(logical(original), logical(actual))) fail('人工重放改变了原Prompt、模型、来源、正文、资源或预算逻辑身份');
}
function originalPrompt(stage, expected) {
    const versions = require('./prompt-text-versions'), matches = [];
    for (const [name, contract] of Object.entries(versions)) {
        if (!/^ANALYSIS_PROMPT_TEXT_V\d+_CONTRACT$/u.test(name)) continue;
        let filename; try { filename = versions.promptFilePathForContract(stage, contract); } catch { continue; }
        const bytes = require('./prompt-evidence').readPromptEvidenceBytes(filename);
        if (require('./prompt-history').promptTemplateSha256(bytes.toString('utf8')) === expected)
            matches.push({ contract, path: filename, fileSha256: sha(bytes), templateSha256: expected });
    }
    if (matches.length !== 1) fail('原候选Prompt声明缺失或不唯一');
    return Object.freeze(matches[0]);
}
function readVerifiedConferenceReaderPrompts(paper, sourceText, identity = null) {
    const active = scope.getStore(); if (!active) return null;
    const context = require('./conference-analysis-context').getConferenceAnalysisContext();
    if (!context || context.executionId !== active.loaded.run.executionId || context.readerPdfSourceHandle !== active.pdf
        || context.paperId !== paper.id || paper.arxivId || paper.paper_id
        || sourceText !== active.loaded.source.sourceDetails.text) fail('原Prompt重放离开会议人工来源');
    assertOriginals(active);
    if (identity) assertCompatibleIdentity(active.candidate.identity, identity);
    if (!active.promptDeclaration) {
        const original = active.candidate.identity, article = originalPrompt('apiReaderArticle', original.promptSha256),
            repair = originalPrompt('apiReaderRepair', original.repairPromptSha256);
        const policies = Object.fromEntries(['readerRequestPolicy','readerJsonRequestPolicy'].filter(key => Object.hasOwn(original,key)).map(key => [key,clone(original[key])]));
        active.promptDeclaration = freeze({ article, repair, requestPolicyFields: policies,
            stageFields: { promptTextContract: article.contract, repairPromptTextContract: repair.contract,
                promptTemplateSha256: article.templateSha256, repairPromptTemplateSha256: repair.templateSha256, ...policies } });
    }
    return active.promptDeclaration;
}
function isVerifiedConferenceReaderPromptDeclaration(value) {
    const active = scope.getStore();
    if (!value || active?.promptDeclaration?.stageFields !== value) return false;
    const context = require('./conference-analysis-context').getConferenceAnalysisContext();
    if (!context || context.executionId !== active.loaded.run.executionId
        || context.paperId !== active.row.record.paperId || context.readerPdfSourceHandle !== active.pdf) fail('原Prompt声明离开真实会议scope');
    assertOriginals(active); return true;
}
function receiptRoot(active) { return path.join(active.batch.processDir, 'reader-operator-corrections', 'registered', active.batch.manifest.sha256); }
function receiptFile(active) { return path.join(receiptRoot(active), active.loaded.run.executionId, 'receipt.json'); }
const mutableReaderFields = new Set(['apiReaderArticle','apiReaderPlan','apiReaderFigures','apiReaderAuthors','apiReaderResources',
    'apiReaderArticleSha256','apiReaderPlanSha256','readerFactReview']);
function protectedPaper(paper) {
    const value = clone(paper);
    for (const key of mutableReaderFields) delete value[key];
    for (const key of Object.keys(value)) if (/^latestAnalysisAttempt/u.test(key)
        || ['error','errorCode','errorCategory','errorStatus','errorScope','retryable'].includes(key)) delete value[key];
    if (value.analysisManifest?.stages) {
        delete value.analysisManifest.stages.apiReaderArticle;
        if (scope.getStore()?.mainCheckpointRecovery) delete value.analysisManifest.stages.imageSupplement;
    }
    if (value.analysisManifest?.contracts) for (const key of ['apiReaderArticle','apiReaderSourceBindings','apiReaderAuthorIdentity',
        'apiReaderResourceIdentity','apiReaderFigurePersistence','readerResourceClaims']) delete value.analysisManifest.contracts[key];
    return value;
}
function assertOutput(active, paper) {
    assertOriginals(active);
    assertCheckpointImageSupplement(active, paper);
    if (!isDeepStrictEqual(protectedPaper(paper), protectedPaper(active.beforePaper))) fail('人工Reader改变了受保护主文、评分、标签或非Reader阶段');
    const stage = paper.analysisManifest?.stages?.apiReaderArticle, proof = active.proof;
    if (!proof || !isDeepStrictEqual(stage?.operatorProvenance, proof) || stage.executionKind !== 'operator'
        || stage.model !== 'operator-local' || stage.protocol !== 'local_operator' || stage.newReaderApiRequests !== 0
        || stage.attempts !== active.candidate.payload.attempts || stage.fullAttempts !== active.candidate.payload.fullAttempts
        || (stage.transportFailures || 0) !== (active.candidate.payload.transportFailures || 0)) fail('新Reader不是保留原计数的真实人工输出');
    const deep = require('../deep-analyzer'), source = active.loaded.source.sourceDetails;
    const evidence = deep.buildApiReaderEvidenceContext('', source.text, source.structuredArtifacts, paper.id);
    const policy = require('./conference-analysis-context').conferenceWeakReaderCapabilityPolicy(paper, source.structuredArtifacts);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(active.draft), { arxivId: paper.id,
        requiredVersion: 3, requireIntegratedTables: true,
        minimumIntegratedTables: require('./reader-contract').readerRequirements({ version: 3,
            availableTableCount: [...evidence.matchAll(/^TABLE_(\d+):/gm)].length,
            ...(policy ? { readerCapabilityPolicy: policy } : {}) }).minimumTables,
        requireSourceBindings: true, allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
        readerCapabilityPolicy: policy, verifiedResourceIdentity: paper.apiReaderResources,
        enforceResourceAvailabilityClaims: true, availableFigureOrdinals: (active.candidate.payload.imageEvidence || []).map(image => image.ordinal),
        structuredArtifacts: source.structuredArtifacts, sourceText: source.text });
    // v2 protects the original draft binding exactly. The true/true parser may
    // derive additional original-table quotes: replay its complete normal final
    // display plan rather than silently editing the protected old draft binding.
    const rendered = active.appendData
        ? deep.replayApiReaderFinalDisplay(parsed, source, paper.apiReaderFigures, paper.id)
        : deep.injectApiReaderFigures(parsed, source.structuredArtifacts, paper.id);
    if (active.appendData && !isDeepStrictEqual(rendered.plan, paper.apiReaderPlan)) fail('追加表正常显示plan与真实保存plan不同');
    const materialized = new Set(['cachePath','assetFilename','assetMediaType','assetSha256','assetBytes','assetWidth','assetHeight','rawBytes']);
    const figures = value => (value || []).map(figure => Object.fromEntries(Object.entries(figure).filter(([key]) => !materialized.has(key))));
    if (rendered.article !== paper.apiReaderArticle || deep.stableFingerprint(rendered.plan) !== paper.apiReaderPlanSha256
        || !isDeepStrictEqual(figures(rendered.figures), figures(paper.apiReaderFigures))) fail('正常解析输出与最终Reader不同');
}
function hasVerifiedOperatorProvenance(paper) {
    const active = scope.getStore();
    if (!active || !active.proof) return false;
    assertOutput(active, paper); return true;
}
function immutable(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    require('./fresh-rewrite-run').assertSafeDirectory(path.dirname(filename));
    require('./immutable-file').writeImmutableFile(filename, bytes, fail);
}
function sealCorrection(paper) {
    const active = scope.getStore(); if (!active || active.cold) fail('只有真实热人工scope能封存');
    if (!require('../analysis-engine').paperAnalysisLockHeld({ id: paper.id })) fail('封存人工输出必须持有原论文锁');
    assertOutput(active, paper);
    assertCheckpointImageSupplement(active, paper, true);
    const engine = require('../analysis-engine'), rules = require('./conference-postprocess').readOriginalTagProof(paper).rules;
    if (!engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules })) fail('正常整篇资格尚未通过');
    assertOriginals(active);
    const base = path.dirname(receiptFile(active));
    const body = { contract: RECEIPT, version: 1, proof: clone(active.proof), currentIdentity: clone(active.currentIdentity),
        beforeAnalysisFileSha256: sha(active.pins.beforeAnalysisBytes), beforeRunFileSha256: sha(active.pins.beforeRunBytes),
        stateFileSha256: active.batch.state.sha256, candidateFiles: clone(active.pins.entries),
        retainedMaterials: clone(active.pins.materials),
        ledgerFileSha256: active.pins.ledgerSha256, revisionFileSha256: active.pins.revisionFileSha256,
        afterPaperSha256: hash(paper), appliedAt: active.row.record.appliedAt };
    if (body.beforeAnalysisFileSha256 !== active.row.record.analysisFileSha256 || body.beforeRunFileSha256 !== active.row.record.runFileSha256) fail('封存原包字节与CAS不同');
    immutable(path.join(receiptRoot(active), 'state-before.json'), active.batch.state.bytes);
    immutable(path.join(base, 'analysis-before.json'), active.pins.beforeAnalysisBytes);
    immutable(path.join(base, 'run-before.json'), active.pins.beforeRunBytes);
    const receipt = { ...body, receiptSha256: hash(body) };
    immutable(receiptFile(active), Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
    return { receiptFile: receiptFile(active), receiptSha256: receipt.receiptSha256,
        proof: clone(active.proof), assertUnchanged: () => assertOriginals(active) };
}
function operatorMarked(paper) {
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    const own = stage?.operatorProvenance?.contract === CORRECTION;
    const conference = paper?.source === 'conference' || /^conference:/u.test(paper?.id || '');
    return own || conference && Object.values(paper?.analysisManifest?.stages || {}).some(item =>
        item?.executionKind === 'operator' || item?.model === 'operator-local'
        || item?.protocol === 'local_operator' || item?.operatorProvenance || item?.operatorHistory);
}
function withSavedPaper(paper, callback) {
    if (typeof callback !== 'function') fail('缺少同步验证回调');
    // A nested ordinary-paper check must not remove the outer operator's
    // network ban. No operator provenance is granted to that ordinary paper.
    if (!operatorMarked(paper)) return callback();
    const active = scope.getStore();
    if (active) { assertOutput(active, paper); return callback(); }
    const proof = paper.analysisManifest?.stages?.apiReaderArticle?.operatorProvenance;
    if (proof?.contract !== CORRECTION || !/^[a-f0-9-]{36}$/u.test(proof.executionId || '')) fail('人工标记缺少真实会议凭证');
    const analysisRoot = path.resolve(require('../config').FILES.conferenceAnalysisDir);
    const loaded = require('./conference-analysis-adapter').loadGrantedConferenceRecovery({ analysisRoot, executionId: proof.executionId });
    if (loaded.analysis.status !== 'complete') fail('冷核需要已保存的完整人工子稿');
    if (!isDeepStrictEqual(paper, loaded.analysis.papers[0])) fail('冷核必须使用完整原canonical论文');
    const processDir = path.join(path.dirname(analysisRoot), 'conference-processes', proof.processId);
    const expected = path.join(processDir, 'reader-operator-corrections', 'registered', proof.manifestSha256, proof.executionId, 'receipt.json');
    if (proof.receiptFile !== expected) fail('冷核凭证位置不规范');
    const saved = read(expected), { receiptSha256, ...body } = saved.value;
    if (saved.value.contract !== RECEIPT || receiptSha256 !== hash(body) || !isDeepStrictEqual(body.proof, proof)
        || body.afterPaperSha256 !== hash(paper)) fail('冷核凭证与最终完整原稿不一致');
    const grantHandle = require('./conference-recovery-grant').reopenRecoveryGrantForWindow({ analysisRoot, windowRecord: loaded.revision });
    const stateRecord = read(path.join(path.dirname(path.dirname(expected)), 'state-before.json'));
    const batch = loadBatchData({ analysisRoot, processDirectory: processDir, manifestPath: proof.manifestFile, grantHandle }, stateRecord);
    if (batch.manifest.sha256 !== proof.manifestSha256 || stateRecord.sha256 !== body.stateFileSha256) fail('冷核原清单或完整失败集不一致');
    const currentState = read(path.join(processDir, 'state.json'));
    if (currentState.sha256 !== stateRecord.sha256) {
        // During local apply the exact original state stays in place. After
        // the normal stage transaction adopts this child, only its real new
        // completion/source/page proof may replace that original pointer.
        require('./conference-process').assertState(currentState.value);
        const item = currentState.value.items[paper.id], adoption = item?.readerOperatorAdoption;
        if (currentState.value.processId !== proof.processId || item?.status !== 'complete'
            || item.analysisRunId !== proof.executionId || item.analysisProof?.analysisSha256 !== loaded.analysisFileSha256
            || item.analysisProof?.sourceSnapshotSha256 !== loaded.run.sourceSnapshotSha256
            || item.analysisProof?.completionReceiptSha256 !== loaded.run.completionReceipt?.receiptSha256
            || !/^[a-f0-9]{64}$/u.test(item.pageProof?.manifestSha256 || '')
            || !/^[a-f0-9]{64}$/u.test(item.pageProof?.contentSha256 || '')
            || !/^content\/posts\/[a-zA-Z0-9._-]+\.md$/u.test(item.pageProof?.pagePath || '')
            || adoption?.manifestSha256 !== proof.manifestSha256 || adoption.manifestFile !== proof.manifestFile
            || adoption.previousStateSha256 !== stateRecord.value.stateSha256) fail('当前进程没有正常采纳本真实人工子稿/页面证明');
    }
    const row = batch.records.get(paper.id); if (!row || row.file.sha256 !== proof.correctionSha256) fail('冷核原补丁不一致');
    const beforeAnalysis = read(path.join(path.dirname(expected), 'analysis-before.json')),
        beforeRun = read(path.join(path.dirname(expected), 'run-before.json'));
    if (beforeAnalysis.sha256 !== body.beforeAnalysisFileSha256 || beforeRun.sha256 !== body.beforeRunFileSha256
        || beforeAnalysis.sha256 !== row.record.analysisFileSha256 || beforeRun.sha256 !== row.record.runFileSha256) fail('冷核完整before包不一致');
    const context = require('./conference-analysis-context'), existing = context.getConferenceAnalysisContext();
    const pdf = existing?.paperId === paper.id && existing.executionId === proof.executionId && existing.readerPdfSourceHandle
        ? existing.readerPdfSourceHandle : require('./conference-reader-publication-evidence').replayCanonicalReaderPdfSource(paper, proof.sourceIdentity);
    // A real source capability replaces plan loading here, avoiding a
    // loader->engine->loader recursion. It independently pins the same chain.
    const provider = require('./conference-source-context').readerPdfSourceForContext(pdf);
    if (!provider || provider.paperId !== paper.id || provider.sourceSnapshotSha256 !== row.record.sourceSnapshotSha256
        || provider.sourceText !== loaded.source.sourceDetails.text) fail('冷核来源能力不一致');
    const candidateDirectory = path.join(loaded.directory, 'reader-attempts'), entries = tree(candidateDirectory),
        candidateFile = path.resolve(row.record.baselineCandidateFile),
        candidate = require('./reader-repair').readFailedCandidateEnvelope(candidateDirectory, null, candidateFile);
    if (!candidate || candidate.envelopeSha256 !== row.record.baselineCandidateEnvelopeSha256
        || !isDeepStrictEqual(entries, body.candidateFiles)
        || !isDeepStrictEqual(retainedFiles(loaded.directory), body.retainedMaterials)
        || read(path.join(loaded.directory, 'reader-grant-budget.json')).sha256 !== body.ledgerFileSha256
        || read(path.join(loaded.directory, 'reader-revision.json')).sha256 !== body.revisionFileSha256) fail('冷核原候选/账/修订变化');
    const replayedMember = replayMember(row.record, candidate.envelope, { loaded, pdf, cold: true, beforeAnalysis, beforeRun });
    const restored = { batch, row, loaded, pdf, candidate: candidate.envelope,
        draft: replayedMember.draft, appendData: replayedMember.appendData,
        pins: { entries, materials: body.retainedMaterials, ledgerSha256: body.ledgerFileSha256, sourceFileSha256: row.record.sourceFileSha256,
            revisionFileSha256: body.revisionFileSha256 }, beforePaper: beforeAnalysis.value.papers[0],
        beforeAnalysis: beforeAnalysis.value, beforeRun: beforeRun.value, cold: true,
        proof: clone(proof), currentIdentity: body.currentIdentity };
    assertCompatibleIdentity(restored.candidate.identity, body.currentIdentity);
    const options = { paperId: paper.id, executionId: proof.executionId, executionDir: loaded.directory, readerPdfSourceHandle: pdf };
    return context.withConferenceAnalysisSource({ ...options, sourceDetails: loaded.source.sourceDetails, readerRetryEpoch: 1 }, () =>
        require('./conference-reader-recovery-window').withConferenceReaderGrantReadOnly(grantHandle, options, () =>
            require('./analysis-stop-control').withModelRequestsForbidden(() => scope.run(restored, () => {
                projectMainCheckpoint(restored);
                const replayed = current(paper, body.currentIdentity);
                if (!isDeepStrictEqual(replayed.proof, proof)) fail('冷核逻辑身份或原候选证明不一致');
                assertOutput(restored, paper); return callback();
            }))));
}
module.exports = { prepareReaderInput, finalizeCheckpointImages, CONTRACT, CORRECTION, RECEIPT, SINGLE_TABLE_APPEND, openCorrectionBatch, withCorrection, current, execution, replay,
    readVerifiedConferenceReaderPrompts, isVerifiedConferenceReaderPromptDeclaration,
    sealCorrection, withSavedPaper, hasVerifiedOperatorProvenance, assertMayAccessNetwork, assertSavedBatchMember };

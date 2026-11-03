'use strict';

// Explicit, immutable additional budgets. A caller's JSON is never the runtime
// capability: only a verified registration can issue this module's WeakMap handle.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const handles = new WeakMap();
const registrations = new Map();
const codec = require('./protocol-codec');
const CONTRACT = codec.contract('conference-recovery-grant');
const RECEIPT = codec.contract('conference-recovery-grant-registration');
const CONTINUATION = codec.contract('conference-recovery-window-continuation');
const currentHeader = name => codec.recordHeader(codec.contract(name), name);
function grantFormat(manifest) {
    const field = manifest?.contract === CONTRACT ? 'contract' : 'version';
    if (!codec.hasValidHeader(manifest, 'conference-recovery-grant', field)) fail('追加许可格式声明未知或混用');
    return codec.format(manifest[field], 'conference-recovery-grant', manifest.schemaFingerprint);
}
function windowFormatForRecord(record, family) {
    if (!codec.hasValidHeader(record, family, family === 'conference-recovery-grant'
        && record?.contract !== CONTRACT ? 'version' : 'contract')) fail('独立窗口的原登记格式未知');
    const value = Object.hasOwn(record, 'schemaFingerprint')
        ? codec.declaredSchema(record.contract, family, record.schemaFingerprint).windowFormat
        : codec.historicalHeader('conference-reader-recovery-window', 'separate-append-only-window', null);
    if (!codec.hasValidHeader(value, 'conference-reader-recovery-window')
        || hash(value) !== hash(codec.recordHeader(value.contract, 'conference-reader-recovery-window', value.schemaFingerprint))) {
        fail('原许可未绑定完整的窗口格式');
    }
    return clone(value);
}
const memberChecks = new Set();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const api = () => require('./conference-process');
const adapter = () => require('./conference-analysis-adapter');
const hash = value => api().stableHash(value);
const clone = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
function fail(message) {
    throw Object.assign(new Error(`会议追加额度：${message}`), {
        code: 'CONFERENCE_RECOVERY_GRANT_INTEGRITY', scope: 'run', retryable: false
    });
}
function directory(filename, create = false) {
    const absolute = path.resolve(filename); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try { const stat = fs.lstatSync(cursor);
            if (!stat.isDirectory() || stat.isSymbolicLink()) fail('目录不能是链接或普通文件');
        } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 });
        }
    }
    return absolute;
}
function read(filename) {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
        fail(`文件必须是0600单链接普通文件：${path.basename(filename)}`);
    }
    return adapter().readJsonRecord(filename);
}
function grantRoot(analysisRoot, create = false) {
    const root = directory(analysisRoot);
    return directory(path.join(path.dirname(root), 'conference-recovery-grants'), create);
}
function grantedRecoveryExecutionId(grantId, failedExecutionId, failedAnalysisFileSha256, windowRecord = null) {
    if (!UUID.test(grantId || '') || !UUID.test(failedExecutionId || '') || !SHA.test(failedAnalysisFileSha256 || '')) {
        fail('恢复窗口身份不合法');
    }
    const header = windowRecord === null ? currentHeader('conference-reader-recovery-window')
        : codec.hasValidHeader(windowRecord, 'conference-reader-recovery-window')
            ? codec.recordHeader(windowRecord.contract, 'conference-reader-recovery-window', windowRecord.schemaFingerprint)
            : fail('恢复窗口的原格式声明无效');
    const domain = Object.hasOwn(header, 'schemaFingerprint') ? hash(header) : header.contract;
    return api().deterministicUuid(hash({ grantId, failedExecutionId, failedAnalysisFileSha256 }), domain);
}
function casPath(repositoryRoot, member, relative) {
    const allowed = [member.parentExecutionId, member.childExecutionId];
    const parts = typeof relative === 'string' ? relative.split('/') : [];
    if (parts.length < 5 || parts.slice(0, 3).join('/') !== 'data/runtime/conference-analysis-executions'
        || !allowed.includes(parts[3]) || parts.some(part => !part || part === '.' || part === '..')
        || !(parts.length === 5 && /^(?:analysis|run|source|reader-revision|reader-resource-preflight)\.json$/u.test(parts[4])
            || parts.length === 6 && parts[4] === 'reader-attempts' && /^[a-f0-9]{64}\.json$/u.test(parts[5]))) {
        fail('成员CAS路径不属于原父/子运行的受控文件');
    }
    const filename = path.join(repositoryRoot, relative);
    directory(path.dirname(filename));
    return filename;
}
function memberPins(member) {
    const base = 'data/runtime/conference-analysis-executions/';
    const digest = (id, name) => member.recordCAS?.[`${base}${id}/${name}`];
    const result = {
        parentAnalysisFileSha256: digest(member.parentExecutionId, 'analysis.json'),
        parentRunFileSha256: digest(member.parentExecutionId, 'run.json'),
        failedAnalysisFileSha256: digest(member.childExecutionId, 'analysis.json'),
        failedRunFileSha256: digest(member.childExecutionId, 'run.json'),
        failedSourceFileSha256: digest(member.childExecutionId, 'source.json'),
        failedRevisionFileSha256: digest(member.childExecutionId, 'reader-revision.json')
    };
    if (Object.values(result).some(value => !SHA.test(value || ''))) fail('成员缺少完整父/子CAS');
    return result;
}
// Hash every retained byte, including the independent Reader ledger, original
// requests/responses, retired/migrated candidates and paid image assets. This
// reads the old window only; it never copies a candidate into a new budget.
function recoveryWindowMaterials(analysisRoot, executionId) {
    if (!UUID.test(executionId || '')) fail('延续窗口 UUID 非法');
    const root = directory(path.join(directory(analysisRoot), executionId));
    const files = []; let bytes = 0;
    function visit(folder, prefix = '') {
        for (const name of fs.readdirSync(folder).sort()) {
            if (!/^[A-Za-z0-9._-]{1,220}$/u.test(name) || ['.', '..'].includes(name)) fail('延续材料文件名非法');
            const file = path.join(folder, name), info = fs.lstatSync(file);
            if (info.isSymbolicLink()) fail('延续材料不能是链接');
            if (info.isDirectory()) { directory(file); visit(file, prefix + name + '/'); continue; }
            if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
                || info.size > 64 * 1024 * 1024) fail('延续材料不是有界0600原文件');
            const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            let content;
            try {
                const before = fs.fstatSync(fd), value = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(file);
                if (['dev','ino','size','mtimeMs','ctimeMs','nlink','mode'].some(key =>
                    before[key] !== info[key] || before[key] !== after[key] || after[key] !== named[key])
                    || value.length !== before.size) fail('读取延续材料期间原文件变化');
                content = value;
            } finally { fs.closeSync(fd); }
            bytes += content.length;
            if (files.length >= 8192 || bytes > 512 * 1024 * 1024) fail('延续材料超过完整窗口界限');
            files.push({ path: prefix + name, sha256: sha(content) });
        }
    }
    visit(root);
    const ledger = files.find(row => row.path === 'reader-grant-budget.json');
    if (ledger) {
        const requests = read(path.join(root, ledger.path)).value.requests;
        if (!Array.isArray(requests)) fail('原窗口 Reader 请求账不完整');
        if (requests.some(row => row?.status === 'pending')) fail('原窗口仍有在途 Reader 请求');
    }
    return { files, materialsSha256: hash(files), ledgerFileSha256: ledger?.sha256 || null };
}
function assertContinuation(state, member) {
    const c = member.continuation;
    const format = grantFormat(state.manifest);
    if (format === 'mixed-initial-and-continuation' && c === null) return;
    if (format === 'initial-only') {
        if (c !== undefined) fail('原初次许可不能借延续字段扩大权限');
        return;
    }
    const key = `${state.manifest.grantId}:${member.paperId}`;
    if (memberChecks.has(key) || memberChecks.size >= 16) fail('追加窗口延续循环或超过16层');
    memberChecks.add(key);
    try {
        const prior = resolveRegisteredRecoveryGrant(c.grantId, c.grantSha256, { analysisRoot: state.analysisRoot });
        const authority = readRecoveryGrantMember(prior, member.paperId);
        if (authority.processId !== state.manifest.processId || authority.expectedExecutionId !== member.childExecutionId
            || authority.parentExecutionId !== member.parentExecutionId
            || authority.sourceSha256 !== member.sourceTextSha256
            || authority.sourceSnapshotSha256 !== member.sourceSnapshotSha256) fail('不是前许可唯一最新窗口及原完整父稿');
        const actual = recoveryWindowMaterials(state.analysisRoot, member.childExecutionId);
        if (actual.materialsSha256 !== c.materialsSha256 || actual.ledgerFileSha256 !== c.ledgerFileSha256) {
            fail('前窗口完整账本、候选、请求响应或资产树变化');
        }
        const folder = path.join(state.analysisRoot, member.childExecutionId);
        const analysis = read(path.join(folder, 'analysis.json')).value;
        const revision = read(path.join(folder, 'reader-revision.json')).value;
        const { revisionSha256, ...body } = revision;
        // Do not call the adapter's recursive loader here: it reopens this
        // grant layer itself and would multiply whole-tree reads at each depth.
        // The adapter independently validates every predecessor's full seed,
        // mode and source/CAS chain before any child preparation or request.
        if (analysis.status !== 'partial' || analysis.papers?.length !== 1
            || analysis.papers[0].id !== member.paperId
            || !codec.hasValidHeader(body, 'conference-reader-recovery-window')
            || revisionSha256 !== hash(body) || body.executionId !== member.childExecutionId
            || body.paperId !== member.paperId || body.parentExecutionId !== member.parentExecutionId
            || body.grantId !== c.grantId || body.grantSha256 !== c.grantSha256
            || body.failedExecutionId !== authority.failedExecutionId
            || body.failedAnalysisFileSha256 !== authority.failedAnalysisFileSha256
            || body.sourceSnapshotSha256 !== member.sourceSnapshotSha256) fail('前窗口不是同一真实已停止失败');
    } finally { memberChecks.delete(key); }
}
function assertMemberFiles(state, member) {
    for (const [relative, expected] of Object.entries(member.recordCAS || {})) {
        if (!SHA.test(expected || '') || read(casPath(state.repositoryRoot, member, relative)).sha256 !== expected) {
            fail('原父稿、失败稿、候选或来源文件已变化');
        }
    }
    const run = read(path.join(state.analysisRoot, member.childExecutionId, 'run.json')).value;
    const source = read(path.join(state.analysisRoot, member.childExecutionId, 'source.json')).value;
    if (run.paperId !== member.paperId || run.sourceSnapshotSha256 !== member.sourceSnapshotSha256
        || sha(source.sourceDetails?.text || '') !== member.sourceTextSha256) {
        fail('原子运行与封存全文身份不一致');
    }
    if (grantFormat(state.manifest) === 'mixed-initial-and-continuation' && member.continuation === null) {
        const failed = adapter().loadConferenceReaderRevision({ analysisRoot: state.analysisRoot,
            executionId: member.childExecutionId });
        if (failed.recoveryWindow || failed.analysis.status !== 'partial' || failed.run.status === 'running'
            || failed.parent.run.executionId !== member.parentExecutionId
            || failed.parent.analysisFileSha256 !== memberPins(member).parentAnalysisFileSha256
            || member.childExecutionId !== adapter().readerRevisionExecutionId(member.parentExecutionId,
                memberPins(member).parentAnalysisFileSha256, failed.revision)
            || !Number.isSafeInteger(failed.analysis.readerRevisionProgress?.attempts)
            || failed.analysis.readerRevisionProgress.attempts < 1
            || failed.analysis.readerRevisionProgress.attempts > failed.revision.maxAttempts
            || !Array.isArray(failed.analysis.readerRevisionProgress.failures)
            || !failed.analysis.readerRevisionProgress.failures.length) fail('初次成员不是当前父稿唯一实际失败的普通修订');
        if (recoveryWindowMaterials(state.analysisRoot, member.childExecutionId).materialsSha256
            !== member.initialMaterialsSha256) fail('初次失败窗口的完整候选、请求响应或资产树变化');
    }
    assertContinuation(state, member);
}
function assertManifest(manifest) {
    const { manifestSha256, ...body } = manifest || {};
    const format = grantFormat(manifest);
    if (!['initial-only', 'continuations-only', 'mixed-initial-and-continuation'].includes(format) || !UUID.test(manifest.grantId || '')
        || !UUID.test(manifest.processId || '') || !SHA.test(manifest.baselineStateFileSha256 || '')
        || !SHA.test(manifest.inventorySha256 || '') || manifestSha256 !== hash(body)
        || !manifest.approval || manifest.approval.kind !== 'explicit-human'
        || typeof manifest.approval.reference !== 'string' || !manifest.approval.reference.trim()
        || typeof manifest.approval.answer !== 'string' || !manifest.approval.answer.trim()
        || !Number.isFinite(Date.parse(manifest.approval.approvedAt))) fail('追加许可格式或明确授权记录无效');
    if (hash(manifest.limits) !== hash({ maxRounds: 3, readerContentResponses: 6,
        readerFullResponses: 2, readerTransportAttempts: 2 })) fail('追加额度必须为同一批3轮、Reader总6/全文2');
    if (!Array.isArray(manifest.members) || !manifest.members.length
        || new Set(manifest.members.map(member => member.paperId)).size !== manifest.members.length) {
        fail('追加集合为空或有重复成员');
    }
    for (const member of manifest.members) {
        if (!/^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$/u.test(member.paperId || '')
            || !UUID.test(member.parentExecutionId || '') || !UUID.test(member.childExecutionId || '')
            || !SHA.test(member.sourceTextSha256 || '') || !SHA.test(member.sourceSnapshotSha256 || '')) {
            fail('成员身份或来源SHA不合法');
        }
        memberPins(member);
        const c = member.continuation;
        if (format === 'mixed-initial-and-continuation' && !Object.hasOwn(member, 'continuation')) fail('混合许可逐成员必须显式声明初次null或原窗口延续');
        if (format === 'mixed-initial-and-continuation' && c === null) {
            if (!SHA.test(member.initialMaterialsSha256 || '')) fail('初次成员缺少完整失败材料树 SHA');
            continue;
        }
        if (format === 'mixed-initial-and-continuation' && Object.hasOwn(member, 'initialMaterialsSha256')) fail('延续成员不能声明初次材料树');
        if (format === 'initial-only' ? c !== undefined : !c || !codec.hasValidHeader(c, 'conference-recovery-window-continuation')
            || Object.keys(c).sort().join(',') !== [...Object.keys(codec.recordHeader(c.contract,
                'conference-recovery-window-continuation', c.schemaFingerprint)),'grantId','grantSha256','materialsSha256','ledgerFileSha256'].sort().join(',')
            || !UUID.test(c.grantId || '') || c.grantId === manifest.grantId
            || !SHA.test(c.grantSha256 || '') || !SHA.test(c.materialsSha256 || '')
            || !(c.ledgerFileSha256 === null || SHA.test(c.ledgerFileSha256 || ''))) {
            fail('延续许可必须显式绑定前许可和完整材料树，原初次许可不授予延续');
        }
        if (Object.hasOwn(manifest, 'schemaFingerprint') && c !== undefined
            && hash(codec.recordHeader(c.contract, 'conference-recovery-window-continuation', c.schemaFingerprint))
                !== hash(codec.declaredSchema(manifest.contract, 'conference-recovery-grant', manifest.schemaFingerprint).continuationFormat)) {
            fail('当前许可没有绑定同一完整延续格式');
        }
    }
    return manifest;
}
function checkBaseline(manifest, baseline, analysisRoot) {
    const format = grantFormat(manifest);
    const state = api().assertState(baseline.value);
    if (baseline.sha256 !== manifest.baselineStateFileSha256 || state.processId !== manifest.processId
        || state.generation !== manifest.baselineGeneration || state.status !== 'partial') fail('原批次基线不匹配');
    const failed = Object.values(state.items).filter(item => item.status !== 'complete');
    if (failed.some(item => item.status === 'analyzing')
        || hash(failed.map(item => item.paperId).sort()) !== hash(manifest.members.map(item => item.paperId).sort())) {
        fail('清单必须精确覆盖原批次完整失败集合');
    }
    for (const member of manifest.members) {
        const item = state.items[member.paperId], pins = memberPins(member);
        if (item.analysisRunId !== member.parentExecutionId
            || item.analysisProof?.analysisSha256 !== pins.parentAnalysisFileSha256
            || item.sourceProof?.textSha256 !== member.sourceTextSha256
            || item.analysisProof?.sourceSnapshotSha256 !== member.sourceSnapshotSha256) {
            fail('成员不对应原批次的父包和来源证明');
        }
        const releases = (item.retryReleases || []).filter(row => row.recoveryGrantId);
        if (format === 'initial-only' && releases.length) fail('已有追加历史必须绑定最新失败窗口，不能重选最旧失败');
        if ((format === 'continuations-only' || format === 'mixed-initial-and-continuation' && member.continuation)
            && (releases.at(-1)?.recoveryGrantId !== member.continuation.grantId
            || releases.at(-1)?.recoveryGrantSha256 !== member.continuation.grantSha256)) {
            fail('延续未绑定原进程最后实际派发的许可');
        }
        if (format === 'mixed-initial-and-continuation' && member.continuation === null && releases.length) {
            const release = releases.at(-1);
            const prior = resolveRegisteredRecoveryGrant(release.recoveryGrantId, release.recoveryGrantSha256,
                { analysisRoot });
            const authority = readRecoveryGrantMember(prior, member.paperId);
            const child = adapter().loadGrantedConferenceRecovery({ analysisRoot: authority.analysisRoot,
                executionId: authority.expectedExecutionId });
            if (authority.processId !== manifest.processId || item.analysisRunId !== authority.expectedExecutionId
                || child.parent.run.executionId !== authority.parentExecutionId || child.analysis.status !== 'complete'
                || child.run.status !== 'complete' || child.run.paperId !== member.paperId
                || child.analysisFileSha256 !== pins.parentAnalysisFileSha256
                || child.runFileSha256 !== pins.parentRunFileSha256
                || child.run.completionReceipt?.receiptSha256 !== item.analysisProof?.completionReceiptSha256
                || child.run.sourceSnapshotSha256 !== member.sourceSnapshotSha256
                || authority.sourceSha256 !== member.sourceTextSha256
                || hash(child.revision) !== hash(item.readerRevision)) {
                fail('初次追加有旧许可历史，但当前父稿并非真实已采纳完成子稿');
            }
        }
    }
    return state;
}
function makeHandle(manifest, directoryPath, analysisRoot, processDirectory) {
    const handle = Object.freeze(Object.create(null));
    const state = { manifest: freeze(clone(manifest)), directory: directoryPath,
        analysisRoot: directory(analysisRoot), processDirectory: directory(processDirectory),
        repositoryRoot: path.resolve(analysisRoot, '../../..') };
    handles.set(handle, state);
    return handle;
}
function registrationStamp(filename) {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n) {
        fail('已登记文件的类型、权限或链接变化');
    }
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink, stat.mode].join(':');
}
function assertRegistration(state) {
    for (const [filename, expected] of state.registrationStamps) {
        if (registrationStamp(filename) !== expected) fail('不可变的已登记许可或原基线文件已变化');
    }
}
function openRecoveryGrant({ manifestPath, processDirectory, analysisRoot, install = false }) {
    if (!path.isAbsolute(manifestPath || '') || !path.isAbsolute(processDirectory || '')
        || !path.isAbsolute(analysisRoot || '')) fail('追加许可与运行目录必须使用绝对路径');
    const original = read(manifestPath), manifest = assertManifest(original.value);
    if (path.basename(processDirectory) !== manifest.processId) fail('追加许可的process目录不匹配');
    const root = grantRoot(analysisRoot, install), target = path.join(root, manifest.grantId);
    const receiptFile = path.join(target, 'registration.json');
    if (!fs.existsSync(receiptFile)) {
        if (!install) fail('追加许可尚未显式登记');
        if (!codec.isCurrentHeader(manifest, 'conference-recovery-grant')) fail('新登记必须使用当前稳定许可格式；原旧清单保留，只能重放已有登记');
        const baseline = read(path.join(processDirectory, 'state.json'));
        checkBaseline(manifest, baseline, analysisRoot);
        const temporaryHandle = makeHandle(manifest, root, analysisRoot, processDirectory);
        const data = handles.get(temporaryHandle);
        for (const member of manifest.members) assertMemberFiles(data, member);
        if (grantFormat(manifest) !== 'initial-only') for (const id of fs.readdirSync(root)) {
            if (id === manifest.grantId || !UUID.test(id) || !fs.existsSync(path.join(root, id, 'registration.json'))) continue;
            const other = assertManifest(read(path.join(root, id, 'manifest.json')).value);
            if (other.processId === manifest.processId && other.members.some(row => manifest.members.some(member =>
                row.paperId === member.paperId && row.childExecutionId === member.childExecutionId))) {
                fail('同一最新失败已有独立追加登记，必须恢复该窗口');
            }
        }
        directory(target, true);
        // Exact writes are no-overwrite and crash-resumable. The receipt is last.
        adapter().writeBytesAtomic(path.join(target, 'manifest.json'), original.bytes);
        adapter().writeBytesAtomic(path.join(target, 'baseline-state.json'), baseline.bytes);
        const body = { ...currentHeader('conference-recovery-grant-registration'), grantId: manifest.grantId,
            grantSha256: manifest.manifestSha256, manifestFileSha256: original.sha256,
            baselineStateFileSha256: baseline.sha256, processId: manifest.processId,
            analysisRoot: directory(analysisRoot), processDirectory: directory(processDirectory),
            inventorySha256: manifest.inventorySha256 };
        adapter().writeBytesAtomic(receiptFile, Buffer.from(JSON.stringify({ ...body, receiptSha256: hash(body) }, null, 2) + '\n'));
    }
    directory(target);
    const registered = read(path.join(target, 'manifest.json'));
    const receipt = read(receiptFile).value, { receiptSha256, ...receiptBody } = receipt;
    if (!codec.hasValidHeader(receipt, 'conference-recovery-grant-registration') || receiptSha256 !== hash(receiptBody)
        || !registered.bytes.equals(original.bytes) || receipt.manifestFileSha256 !== original.sha256
        || receipt.grantId !== manifest.grantId || receipt.grantSha256 !== manifest.manifestSha256
        || receipt.processId !== manifest.processId || receipt.analysisRoot !== directory(analysisRoot)
        || receipt.processDirectory !== directory(processDirectory)
        || receipt.inventorySha256 !== manifest.inventorySha256) fail('已登记追加许可身份不匹配');
    checkBaseline(manifest, read(path.join(target, 'baseline-state.json')), analysisRoot);
    const handle = makeHandle(manifest, target, analysisRoot, processDirectory);
    const data = handles.get(handle);
    for (const member of manifest.members) assertMemberFiles(data, member);
    data.registrationStamps = ['manifest.json', 'registration.json', 'baseline-state.json'].map(name => {
        const filename = path.join(target, name); return [filename, registrationStamp(filename)];
    });
    registrations.set(path.join(target, 'manifest.json'), handle);
    return handle;
}
function readRecoveryGrantMember(handle, paperId) {
    const maintenance = require('./conference-reader-review-maintenance').readMaintenanceRecoveryGrantMember(handle, paperId);
    if (maintenance) return maintenance;
    const state = handles.get(handle);
    if (!state) fail('需要真实已登记的追加许可能力');
    const member = state.manifest.members.find(value => value.paperId === paperId);
    if (!member) fail('论文不在获准的完整集合中');
    const pins = memberPins(member);
    const assertUnchanged = () => {
        assertRegistration(state);
        assertMemberFiles(state, member);
    };
    assertUnchanged();
    const windowFormat = windowFormatForRecord(state.manifest, 'conference-recovery-grant');
    return Object.freeze({ grantId: state.manifest.grantId, grantSha256: state.manifest.manifestSha256,
        processId: state.manifest.processId, member, limits: state.manifest.limits,
        analysisRoot: state.analysisRoot, parentExecutionId: member.parentExecutionId,
        failedExecutionId: member.childExecutionId, ...pins,
        sourceSha256: member.sourceTextSha256, sourceSnapshotSha256: member.sourceSnapshotSha256,
        windowFormat: freeze(windowFormat),
        expectedExecutionId: grantedRecoveryExecutionId(state.manifest.grantId, member.childExecutionId,
            pins.failedAnalysisFileSha256, windowFormat),
        ...(member.continuation ? { continuation: freeze(clone(member.continuation)) } : {}),
        files: Object.freeze(Object.entries(member.recordCAS).map(([relative, sha256]) => Object.freeze({
            path: casPath(state.repositoryRoot, member, relative), sha256 }))), assertUnchanged });
}
function resolveRegisteredRecoveryGrant(grantId, grantSha256, { analysisRoot }) {
    if (!UUID.test(grantId || '') || !SHA.test(grantSha256 || '')) fail('冷恢复许可身份非法');
    const maintenance = require('./conference-reader-review-maintenance')
        .resolveRegisteredMaintenanceWindow(grantId, grantSha256, { analysisRoot });
    if (maintenance) return maintenance;
    const registeredPath = path.join(grantRoot(analysisRoot), grantId, 'manifest.json');
    const cached = registrations.get(registeredPath);
    if (cached) {
        const state = handles.get(cached);
        assertRegistration(state);
        if (state.manifest.manifestSha256 !== grantSha256 || state.analysisRoot !== directory(analysisRoot)) {
            fail('冷恢复缓存与真实许可身份不符');
        }
        return cached;
    }
    const manifest = assertManifest(read(registeredPath).value);
    if (manifest.manifestSha256 !== grantSha256) fail('冷恢复许可SHA不匹配');
    const receipt = read(path.join(path.dirname(registeredPath), 'registration.json')).value;
    return openRecoveryGrant({ manifestPath: registeredPath, processDirectory: receipt.processDirectory, analysisRoot });
}
function reopenRecoveryGrantForWindow({ analysisRoot, windowRecord }) {
    const record = windowRecord;
    const handle = resolveRegisteredRecoveryGrant(record?.grantId, record?.grantSha256, { analysisRoot });
    const member = readRecoveryGrantMember(handle, record.paperId);
    if (!codec.hasValidHeader(record, 'conference-reader-recovery-window')
        || hash(codec.recordHeader(record.contract, 'conference-reader-recovery-window', record.schemaFingerprint)) !== hash(member.windowFormat)
        || record.executionId !== member.expectedExecutionId
        || record.failedExecutionId !== member.failedExecutionId
        || record.failedAnalysisFileSha256 !== member.failedAnalysisFileSha256
        || record.sourceSnapshotSha256 !== member.sourceSnapshotSha256
        || record.originalMemberPaperId !== record.paperId) fail('窗口与已登记原成员不一致');
    return handle;
}
function recoveryGrantSummary(handle) {
    const state = handles.get(handle); if (!state) fail('需要真实追加许可');
    return Object.freeze({ grantId: state.manifest.grantId, grantSha256: state.manifest.manifestSha256,
        processId: state.manifest.processId, paperIds: Object.freeze(state.manifest.members.map(x => x.paperId).sort()),
        limits: state.manifest.limits });
}
module.exports = { CONTRACT, RECEIPT, CONTINUATION, windowFormatForRecord, recoveryWindowMaterials, openRecoveryGrant, readRecoveryGrantMember,
    resolveRegisteredRecoveryGrant, reopenRecoveryGrantForWindow, grantedRecoveryExecutionId, recoveryGrantSummary };

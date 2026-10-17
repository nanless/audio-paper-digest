'use strict';
// A registered, source-authenticated independent Reader window. Old candidates
// and their counters are never migrated into this new response budget.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const active = new AsyncLocalStorage(), leases = new WeakMap();
const CONTRACT = 'conference-granted-reader-budget-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => require('./reader-repair').hashDraft(value);
const fail = (message, cause) => { throw Object.assign(new Error(`会议独立Reader额度拒绝：${message}`, { cause }),
    { code: 'CONFERENCE_READER_GRANT_INTEGRITY', scope: 'run', retryable: false }); };
const exhausted = message => Object.assign(new Error(message), {
    code: 'CONFERENCE_READER_GRANT_BUDGET_EXHAUSTED', scope: 'paper', retryable: false });
function assertSource(state, paper, allowPaidReplay = false) {
    state.registered.assertUnchanged();
    const context = require('./conference-analysis-context').getConferenceAnalysisContext();
    const paidReplay = context && allowPaidReplay && context.executionDir !== state.executionDir
        && require('./conference-reader-active-candidate-replay').readVerifiedConferenceReaderPrompts(
            paper || { id: state.paperId, sourceSha256: state.sourceSha256 }, context.sourceDetails.text);
    if (!context || context.paperId !== state.paperId || context.executionId !== state.executionId
        || (context.executionDir !== state.executionDir && !paidReplay) || context.readerPdfSourceHandle !== state.readerPdfSourceHandle
        || (paper && (paper.id !== state.paperId || paper.arxivId || paper.paper_id))
        || sha(context.sourceDetails.text) !== state.sourceSha256) fail('许可离开原会议论文/来源/子运行范围');
    if (!state.readOnly && !require('../analysis-engine').paperAnalysisLockHeld({ id: state.paperId })) fail('缺少规范会议论文锁');
    const pdf = require('./conference-source-context').readerPdfSourceForContext(state.readerPdfSourceHandle);
    if (!pdf || pdf.paperId !== state.paperId || pdf.sourceSnapshotSha256 !== state.sourceSnapshotSha256
        || sha(pdf.sourceText) !== state.sourceSha256) fail('许可与真实PDF来源能力不一致');
    pdf.assertUnchanged();
    return Boolean(paidReplay);
}
function withGrant(handle, options, callback, readOnly) {
    const registered = require('./conference-recovery-grant').readRecoveryGrantMember(handle, options?.paperId);
    const executionDir = path.join(registered.analysisRoot, registered.expectedExecutionId);
    if (typeof callback !== 'function' || options.executionId !== registered.expectedExecutionId
        || typeof options.executionDir !== 'string' || !path.isAbsolute(options.executionDir)
        || path.resolve(options.executionDir) !== path.resolve(executionDir)
        || registered.limits.readerContentResponses !== 6 || registered.limits.readerFullResponses !== 2
        || registered.limits.maxRounds !== 3) fail('许可子运行或固定6/2/3上限不一致');
    const state = Object.freeze({ registered, readOnly, grantId: registered.grantId, grantSha256: registered.grantSha256,
        processId: registered.processId, paperId: options.paperId, executionId: options.executionId,
        executionDir: path.resolve(executionDir), readerPdfSourceHandle: options.readerPdfSourceHandle,
        readerAttemptsDir: path.join(path.resolve(executionDir), 'reader-attempts'),
        ledgerFile: path.join(path.resolve(executionDir), 'reader-grant-budget.json'),
        sourceSha256: registered.sourceSha256, sourceSnapshotSha256: registered.sourceSnapshotSha256,
        parentAnalysisFileSha256: registered.parentAnalysisFileSha256,
        failedAnalysisFileSha256: registered.failedAnalysisFileSha256 });
    assertSource(state);
    return active.run(state, () => {
        if (readOnly) readLedger(state);
        return require('./llm-usage').withLlmUsageContext({ runId: registered.grantId,
            paperId: options.paperId, unitId: sha(registered.expectedExecutionId) }, callback);
    });
}
function withConferenceReaderGrant(handle, options, callback) {
    return withGrant(handle, options, callback, false);
}
function withConferenceReaderGrantReadOnly(handle, options, callback) {
    return require('./analysis-stop-control').withModelRequestsForbidden(() => withGrant(handle, options, callback, true));
}
function getCurrentReaderWindow(paper, sourceText, candidateDirectory) {
    const state = active.getStore();
    if (!state) return null;
    const paidReplay = assertSource(state, paper, true);
    const replayDirectory = paidReplay ? path.join(require('./conference-analysis-context')
        .getConferenceAnalysisContext().executionDir, 'reader-attempts') : null;
    if ((sourceText !== undefined && sha(String(sourceText)) !== state.sourceSha256)
        || (candidateDirectory !== undefined && path.resolve(candidateDirectory) !== state.readerAttemptsDir
            && path.resolve(candidateDirectory) !== replayDirectory)) {
        fail('候选目录或输入全文不属于已批准的独立窗口');
    }
    return Object.freeze({ grantId: state.grantId, grantSha256: state.grantSha256, paperId: state.paperId,
        executionId: state.executionId, sourceSha256: state.sourceSha256,
        parentAnalysisFileSha256: state.parentAnalysisFileSha256, failedAnalysisFileSha256: state.failedAnalysisFileSha256 });
}
function identityFields(paper, sourceText, candidateDirectory) {
    const window = getCurrentReaderWindow(paper, sourceText, candidateDirectory);
    return window ? { conferenceReaderGrant: window } : {};
}
function binding(state) {
    return { grantId: state.grantId, grantSha256: state.grantSha256, processId: state.processId,
        paperId: state.paperId, executionId: state.executionId, sourceSha256: state.sourceSha256,
        sourceSnapshotSha256: state.sourceSnapshotSha256, parentAnalysisFileSha256: state.parentAnalysisFileSha256,
        failedAnalysisFileSha256: state.failedAnalysisFileSha256 };
}
function readLedger(state) {
    let materialNames;
    try {
        require('./fresh-rewrite-run').assertSafeDirectory(state.executionDir);
        materialNames = fs.readdirSync(state.executionDir).filter(name => /^reader-grant-(?:request|response)-/u.test(name));
    } catch (error) { fail('预算目录无法安全读取', error); }
    let read;
    try { read = require('./conference-analysis-adapter').readJsonRecord(state.ledgerFile); }
    catch (error) { if (error.code !== 'ENOENT') fail('账本无法安全读取', error); }
    if (!read) {
        if (materialNames.length) fail('请求原账或响应仍存在但账本缺失，拒绝重开额度');
        return null;
    }
    const ledger = read.value;
    if (ledger.contract !== CONTRACT || !isDeepStrictEqual(ledger.binding, binding(state))
        || !Array.isArray(ledger.requests) || ledger.requests.length > 128
        || ledger.requests.some((row, index) => row.ordinal !== index + 1
            || !/^[a-f0-9-]{36}$/u.test(row.id) || !['full', 'patch'].includes(row.kind)
            || !['pending', 'content', 'truncated', 'no_content'].includes(row.status)
            || !/^[a-f0-9]{64}$/u.test(row.identitySha256 || '')
            || !Number.isSafeInteger(row.contentAttempt) || row.contentAttempt < 1 || row.contentAttempt > 6)
        || new Set(ledger.requests.map(row => row.id)).size !== ledger.requests.length
        || ledger.requests.filter(row => row.status !== 'no_content').length > 6
        || ledger.requests.filter(row => row.status !== 'no_content' && row.kind === 'full').length > 2) fail('账本身份、请求记录或6/2上限损坏');
    const expectedNames = new Set();
    let consumed = 0;
    for (const row of ledger.requests) {
        if (row.contentAttempt !== consumed + 1) fail('内容次数不连续，原请求账不得裁剪或清零');
        if (row.status !== 'no_content') consumed++;
        const requestName = `reader-grant-request-${row.id}.json`;
        expectedNames.add(requestName);
        try {
            const request = require('./conference-analysis-adapter').readJsonRecord(path.join(state.executionDir, requestName));
            if (!isDeepStrictEqual(request.value, { contract: CONTRACT, binding: binding(state),
                logicalIdentitySha256: ledger.logicalIdentitySha256, id: row.id, ordinal: row.ordinal,
                kind: row.kind, contentAttempt: row.contentAttempt, identitySha256: row.identitySha256,
                startedAt: row.startedAt })) fail('请求原账与可变索引不一致');
            if (row.status === 'content') {
                const responseName = `reader-grant-response-${row.id}.json`;
                expectedNames.add(responseName);
                const response = require('./conference-analysis-adapter').readJsonRecord(path.join(state.executionDir, responseName));
                const value = response.value;
                if (row.responseFile !== responseName || response.sha256 !== row.responseFileSha256
                    || !isDeepStrictEqual(Object.keys(value).sort(), ['contract', 'requestId', 'identitySha256', 'outputTextSha256', 'rawResponse'].sort())
                    || value.contract !== CONTRACT || value.requestId !== row.id || value.identitySha256 !== row.identitySha256
                    || typeof value.rawResponse !== 'string' || !value.rawResponse.length
                    || sha(value.rawResponse) !== row.outputTextSha256 || value.outputTextSha256 !== row.outputTextSha256) {
                    fail('原响应文件、身份或实际输出SHA不一致');
                }
            } else if (row.responseFile || row.responseFileSha256 || row.outputTextSha256) fail('非内容请求不得声明响应');
        } catch (error) { fail('请求/响应原材料无法冷核', error); }
    }
    if (materialNames.length !== expectedNames.size || materialNames.some(name => !expectedNames.has(name))) {
        fail('存在未闭合或被裁剪的请求/响应原账，拒绝新请求');
    }
    return read;
}
function saveLedger(state, ledger, previous) {
    assertSource(state);
    try {
        const adapter = require('./conference-analysis-adapter');
        if (previous) adapter.replaceJson(state.ledgerFile, ledger, previous.sha256);
        else adapter.writeBytesAtomic(state.ledgerFile, Buffer.from(JSON.stringify(ledger, null, 2) + '\n'));
    } catch (error) { fail('账本保存失败，停止新请求', error); }
}
function logicalIdentity(identity) {
    const allowed = require('./reader-recovery-revision').ALLOWED_FIELDS;
    return Object.fromEntries(Object.entries(identity).filter(([key]) => !allowed.includes(key)
        || ['promptSha256', 'repairPromptSha256', 'readerJsonRequestPolicy', 'readerRecoveryEpochSha256'].includes(key)));
}
function reserveReaderResponse(paper, identity, kind, contentAttempt) {
    const state = active.getStore();
    if (!state) return null;
    require('./analysis-stop-control').assertMayStartRequest();
    assertSource(state, paper);
    const expected = identityFields(paper, undefined, state.readerAttemptsDir).conferenceReaderGrant;
    if (!isDeepStrictEqual(identity.conferenceReaderGrant, expected) || !['full', 'patch'].includes(kind)
        || !Number.isSafeInteger(contentAttempt) || contentAttempt < 1 || contentAttempt > 6) fail('请求缺少原授权身份或内容次数非法');
    const previous = readLedger(state), logicalIdentitySha256 = hash(logicalIdentity(identity));
    const ledger = previous?.value || { contract: CONTRACT, binding: binding(state), logicalIdentitySha256, requests: [] };
    if (ledger.logicalIdentitySha256 !== logicalIdentitySha256) fail('同一新窗口的来源/模型/Prompt/逻辑输入发生变化，不能另开预算');
    if (ledger.requests.some(row => row.status === 'pending')) fail('上次在途请求尚未闭合，保守保留其额度，不重复请求');
    if (ledger.requests.filter(row => row.status === 'no_content').length >= state.registered.limits.readerTransportAttempts) {
        throw exhausted('独立会议Reader窗口的原无内容传输失败上限已耗尽');
    }
    const used = ledger.requests.filter(row => row.status !== 'no_content');
    if (used.length >= 6 || (kind === 'full' && used.filter(row => row.kind === 'full').length >= 2)) {
        throw exhausted('独立会议Reader窗口跨全部轮次的6次内容/2次全文预算已耗尽');
    }
    if (contentAttempt !== used.length + 1) fail('候选次数与独立请求账不连续，拒绝重置或换候选');
    const row = { id: crypto.randomUUID(), ordinal: ledger.requests.length + 1, kind, contentAttempt,
        identitySha256: hash(identity), status: 'pending', startedAt: new Date().toISOString() };
    try {
        require('./conference-analysis-adapter').writeBytesAtomic(path.join(state.executionDir, `reader-grant-request-${row.id}.json`),
            Buffer.from(JSON.stringify({ contract: CONTRACT, binding: binding(state), logicalIdentitySha256,
                id: row.id, ordinal: row.ordinal, kind, contentAttempt, identitySha256: row.identitySha256,
                startedAt: row.startedAt }) + '\n'));
    } catch (error) { fail('请求原账无法封存，停止新请求', error); }
    ledger.requests.push(row); saveLedger(state, ledger, previous);
    const lease = Object.freeze({}); leases.set(lease, { state, id: row.id }); return lease;
}
function settleReaderResponse(lease, outcome, raw) {
    if (!lease) return;
    const owned = leases.get(lease), state = active.getStore();
    if (!owned || owned.state !== state || !['content', 'truncated', 'no_content'].includes(outcome)) fail('请求回执离开许可作用域或已消费');
    try { require('./analysis-stop-control').assertMayStartRequest(); }
    catch (error) { if (error.code !== require('./analysis-stop-control').CODE) throw error; }
    assertSource(state);
    const previous = readLedger(state), ledger = previous?.value, row = ledger?.requests.find(row => row.id === owned.id);
    if (!row || row.status !== 'pending') fail('原在途请求身份缺失或已经结算');
    if (outcome === 'content') {
        if (typeof raw !== 'string' || !raw.length || Buffer.byteLength(raw) > 16 * 1024 * 1024) fail('原Reader响应缺失或超过封存上限');
        // Persist the real returned bytes before any parser or candidate changes.
        const name = `reader-grant-response-${row.id}.json`;
        const bytes = Buffer.from(JSON.stringify({ contract: CONTRACT, requestId: row.id,
            identitySha256: row.identitySha256, outputTextSha256: sha(raw), rawResponse: raw }) + '\n');
        try { require('./conference-analysis-adapter').writeBytesAtomic(path.join(state.executionDir, name), bytes); }
        catch (error) { fail('已返回原响应无法封存，停止派发', error); }
        row.responseFile = name; row.responseFileSha256 = sha(bytes); row.outputTextSha256 = sha(raw);
    }
    row.status = outcome; row.finishedAt = new Date().toISOString();
    saveLedger(state, ledger, previous); leases.delete(lease);
}
module.exports = { CONTRACT, withConferenceReaderGrant, withConferenceReaderGrantReadOnly, getCurrentReaderWindow, identityFields,
    reserveReaderResponse, settleReaderResponse };

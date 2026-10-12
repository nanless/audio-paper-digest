'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { READER_SECTION_KINDS: API_READER_KINDS } = require('./reader-draft-order');
const CONTRACT = 'reader-paid-response-replay-v1';
const HISTORICAL_NORMALIZER = Object.freeze({
    gitHead: '4572334a9e47f133fe32b5df370e839536766d0e',
    deepFileSha256: '45660a796b8eca7b7d9d24b725d643905981df88d51f5ade350f5d9bd89b480a',
    functionSha256: 'b1c6b7999b2b6788a61342be745ae5146901117d10344df4949ede1ab3fc14cf',
    draftOrderFileSha256: '7fe3f6b8df7f149747cd1abb308c2ed6fb33aa16005640988a7e6dbe38f83385'
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = value => require('./reader-repair').hashDraft(value);
const fail = message => {
    const error = new Error(`原付费响应复验拒绝：${message}`);
    error.code = 'READER_PAID_RESPONSE_REPLAY_REJECTED';
    error.retryable = false;
    error.scope = 'run';
    throw error;
};
const statFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'];
const sameStat = (a, b) => statFields.every(key => a[key] === b[key]);
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function readPinnedJson(filename, expectedSha) {
    if (!SHA.test(expectedSha || '')) fail('须绑定原文件完整摘要');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o777n) !== 0o600n
            || stat.size > 32n * 1024n * 1024n) fail('原记录类型、权限或大小无效');
        const bytes = fs.readFileSync(fd);
        if (sha(bytes) !== expectedSha || !sameStat(stat, fs.fstatSync(fd, { bigint: true }))
            || !sameStat(stat, fs.lstatSync(filename, { bigint: true }))) fail('原记录读取时变化');
        return { value: JSON.parse(bytes.toString('utf8')), assertUnchanged() {
            if (!sameStat(stat, fs.lstatSync(filename, { bigint: true }))
                || sha(fs.readFileSync(filename)) !== expectedSha) fail('保存前原记录变化');
        } };
    } finally { fs.closeSync(fd); }
}

// 只用于证明旧程序确实产生了已保存的输入。不能把这段历史逻辑用于新的文章。
function normalizeReaderConceptBridgeTerms(candidate) {
    if (!candidate || !Array.isArray(candidate.conceptBridges)
        || !Array.isArray(candidate.sections)) return false;
    const article = candidate.sections.map(section => String(section?.body || '')).join('\n');
    // 模型会把 bridge 对象自己的字段名漏进术语里，比如
    // ["音素识别", "音位", "sectionKind", "component"]。不要一律截断过长的数组：
    // 只在前两个原文可见的术语都合法时，去掉末尾那个完全已知的字段名或 sectionKind
    // 后缀。其他情况仍按 schema 硬失败，交给 Reader 修复循环。
    const knownLeakedTerms = new Set([
        'sectionKind', 'targetKind', 'marker', 'explanation', 'terms', 'kind',
        'body', 'heading', 'focusPoints', 'tableIndex', 'sourceType',
        ...API_READER_KINDS
    ]);
    let changed = false;
    for (const bridge of candidate.conceptBridges) {
        if (!Array.isArray(bridge?.terms)) continue;
        const terms = bridge.terms.map(term => typeof term === 'string' ? term.trim() : term);
        if (terms.length > 2
            && terms.slice(0, 2).every(term => typeof term === 'string'
                && term.length >= 2 && term.length <= 48)
            && terms.slice(2).every(term => typeof term === 'string'
                && knownLeakedTerms.has(term))) {
            bridge.terms = terms.slice(0, 2);
            changed = true;
        }
        // 修复模型会把第一个 bridge 术语重复成第二个的后缀，比如
        // ["声音事件定位与检测", "六自由度声音事件定位与检测"]。只有剩下的前缀在文章里
        // 也可见时，才按这个固定的形态恢复。这样 bridge 仍落在草稿上，不用靠半截子串
        // 去猜术语。
        if (Array.isArray(bridge.terms) && bridge.terms.length === 2) {
            const repairedTerms = bridge.terms.map(term => (
                typeof term === 'string' ? term.trim() : term
            ));
            for (let index = 0; index < repairedTerms.length; index += 1) {
                const otherIndex = index === 0 ? 1 : 0;
                const value = repairedTerms[index];
                const other = repairedTerms[otherIndex];
                if (typeof value !== 'string' || typeof other !== 'string'
                    || value.length <= other.length || !value.endsWith(other)) continue;
                const prefix = value.slice(0, -other.length).trim();
                if (prefix.length < 2 || prefix.length > 48 || prefix === other
                    || !article.includes(prefix)) continue;
                if (typeof bridge.explanation === 'string') {
                    bridge.explanation = bridge.explanation.replaceAll(value, prefix);
                }
                bridge.terms[index] = prefix;
                changed = true;
                break;
            }
        }
        bridge.terms = bridge.terms.map(term => {
            const value = typeof term === 'string' ? term.trim() : term;
            if (value !== '熵' || !article.includes('问题熵')) return term;
            changed = true;
            if (typeof bridge.explanation === 'string' && bridge.explanation.includes('熵')) {
                bridge.explanation = bridge.explanation.replace('熵', '问题熵');
            }
            return '问题熵';
        });
    }
    return changed;
}

function replayPaidReaderResponse(directory, old, identity, options) {
    const allowed = ['candidateIdentitySha256', 'candidateFileSha256', 'responseFile', 'responseFileSha256',
        'usageFileName', 'usageFileSha256', 'usageEventId', 'repairDiagnosticId', 'repairRequestSha256', 'repairResponseSha256'];
    if (!options || Object.keys(options).sort().join(',') !== allowed.sort().join(',')
        || !UUID.test(options.usageEventId) || !UUID.test(options.repairDiagnosticId)
        || !UUID.test(String(options.usageFileName).replace(/\.json$/, ''))
        || path.basename(options.usageFileName) !== options.usageFileName) fail('原响应复验参数不完整');
    const fresh = require('./fresh-analysis-context');
    if (!fresh.getFreshAnalysisContext() || !require('../analysis-engine').paperAnalysisLockHeld({ arxivId: identity.paperId })
        || !isDeepStrictEqual(fresh.freshAnalysisIdentity(identity.paperId), identity.freshAnalysis))
        fail('须在当前论文锁和完整封存来源范围内复验');
    if (path.resolve(fresh.freshReaderAttemptsDirectory(directory)) !== path.resolve(directory))
        fail('原候选必须位于当前封存运行目录');
    const payload = old.envelope.payload;
    const oldIdentity = old.envelope.identity;
    const expected = options.candidateIdentitySha256;
    if (hash(oldIdentity) !== expected || !SHA.test(expected) || old.envelopeSha256 !== options.candidateFileSha256
        || payload.status !== 'failed' || payload.attempts !== 3 || payload.fullAttempts !== 2
        || (payload.transportFailures || 0) !== 0 || payload.explicitReaderRetryRound
        || payload.implementationRepairAllowanceProof || payload.readerRecoveryRevisions?.length
        || oldIdentity.contentMode !== 'reader-source-signed-revision-v1'
        || oldIdentity.model?.model !== 'muse-spark-1.3-contributor'
        || oldIdentity.tableCompilerSha256 !== identity.tableCompilerSha256) fail('原候选身份、次数或恢复范围不符');
    const implementationFields = ['parserImplementationSha256', 'editorialImplementationSha256',
        'mechanicalContractSha256', 'repairImplementationSha256', 'sourceDiagnosticsImplementationSha256',
        'draftOrderImplementationSha256'];
    const omitImplementation = value => Object.fromEntries(Object.entries(value)
        .filter(([key]) => !implementationFields.includes(key)));
    if (!isDeepStrictEqual(omitImplementation(oldIdentity), omitImplementation(identity)))
        fail('不能更换原模型、提示、反馈、来源或逻辑输入');
    if (sha(normalizeReaderConceptBridgeTerms.toString()) !== HISTORICAL_NORMALIZER.functionSha256
        || sha(fs.readFileSync(path.join(__dirname, 'reader-draft-order.js'))) !== HISTORICAL_NORMALIZER.draftOrderFileSha256
        || oldIdentity.draftOrderImplementationSha256 !== HISTORICAL_NORMALIZER.draftOrderFileSha256
        || identity.draftOrderImplementationSha256 !== HISTORICAL_NORMALIZER.draftOrderFileSha256)
        fail('历史术语与表格变换实现不能更换');
    const usageDir = require('../config').FILES.llmUsageDir;
    require('./fresh-rewrite-run').assertSafeDirectory(usageDir);
    const usage = readPinnedJson(path.join(usageDir, options.usageFileName), options.usageFileSha256);
    const response = readPinnedJson(options.responseFile, options.responseFileSha256);
    const body = response.value;
    if (body.status !== 'completed' || body.model !== oldIdentity.model.model || !Array.isArray(body.output))
        fail('原全文响应不是指定模型的完整结果');
    const raw = body.output.flatMap(item => item.content || []).filter(item => item.type === 'output_text')
        .map(item => item.text).join('');
    const event = usage.value;
    if (event.kind !== 'request' || event.version !== 'llm-usage-v1' || event.eventId !== options.usageEventId
        || event.paperId !== oldIdentity.paperId || event.runId !== oldIdentity.freshAnalysis.runId
        || event.stage !== 'apiReaderArticle' || event.contentAttempt !== 2
        || event.protocol !== 'openai_responses' || event.model !== body.model
        || event.statusCode !== 200 || event.outcome !== 'completed' || event.outputTextSha256 !== sha(raw)
        || !SHA.test(event.inputSha256 || '') || event.usage?.status !== 'reported'
        || !Number.isSafeInteger(event.usage.totalTokens) || event.usage.totalTokens <= 0)
        fail('原全文响应与正式请求用量记录不一致');
    const diagnosticsDir = path.join(directory, 'request-diagnostics');
    require('./fresh-rewrite-run').assertSafeDirectory(diagnosticsDir);
    const request = readPinnedJson(path.join(diagnosticsDir, options.repairDiagnosticId + '.request.json'), options.repairRequestSha256);
    const repairResponse = readPinnedJson(path.join(diagnosticsDir, options.repairDiagnosticId + '.response.json'), options.repairResponseSha256);
    const req = request.value, res = repairResponse.value;
    if (req.contract !== 'reader-repair-request-diagnostics-v1' || req.id !== options.repairDiagnosticId
        || req.contentAttempt !== 3 || !isDeepStrictEqual(req.identity, oldIdentity)
        || req.draftSha256 !== hash(req.draft) || req.promptSha256 !== sha(req.prompt)
        || res.contract !== req.contract || res.id !== req.id || res.requestSha256 !== options.repairRequestSha256
        || res.outputTextSha256 !== sha(res.rawResponse) || req.atomicOperation !== null
        || !Array.isArray(req.repairTargets) || req.repairTargets.length !== 8
        || req.repairTargets.some((item, index) => item.path !== `/sections/${index}/body`))
        fail('真实后续修复请求没有绑定原候选和完整输入');
    const draft = require('./reader-repair').parseRecoveryDraft(raw);
    if (!draft) fail('原全文响应不能解析为完整草稿');
    const context = fresh.getFreshAnalysisContext();
    const source = fresh.readFreshSource(context.runDir, identity.paperId, context);
    const historical = structuredClone(draft);
    normalizeReaderConceptBridgeTerms(historical);
    const normalized = require('./reader-draft-order').normalizeReaderDraftOrder(historical,
        { structuredArtifacts: source.structuredArtifacts }).draft;
    if (isDeepStrictEqual(draft, historical) || !isDeepStrictEqual(normalized, req.draft))
        fail('历史归一化不能精确重现正式保存的程序污染');
    const patched = require('./reader-repair').applyReaderPatch(req.draft, JSON.parse(res.rawResponse), req.repairTargets.map(item => item.path));
    if (!isDeepStrictEqual(patched, payload.draft)) fail('当前付费候选不属于该真实后续修复');
    const active = require('./daily-fact-review').current(identity.paperId);
    const review = require('./daily-fact-review').reviewFeedback('apiReaderArticle', identity.paperId);
    if (!active || !active.feedback.readerFeedback?.trim() || !review || !req.prompt.includes(review))
        fail('必须保留同一次已公验事实反馈');
    return { draft, rawDraft: raw, proof: { contract: CONTRACT, historicalNormalizer: HISTORICAL_NORMALIZER, usageEventId: event.eventId,
        outputTextSha256: sha(raw), usageFileSha256: options.usageFileSha256,
        repairDiagnosticId: req.id, repairRequestSha256: options.repairRequestSha256,
        repairResponseSha256: options.repairResponseSha256, originalEnvelopeSha256: old.envelopeSha256,
        originalPayloadSha256: old.envelope.payloadSha256,
        attempts: payload.attempts, fullAttempts: payload.fullAttempts },
        assertUnchanged() { for (const record of [usage, response, request, repairResponse]) record.assertUnchanged(); } };
}
module.exports = { CONTRACT, replayPaidReaderResponse };

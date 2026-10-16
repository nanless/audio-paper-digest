'use strict';

// 已付费失败候选只在私有副本里走正常Reader；这里从不增加一次模型请求或改原候选。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), { isDeepStrictEqual } = require('node:util');
const adapter = require('./conference-analysis-adapter');
const context = require('./conference-analysis-context');
const stop = require('./analysis-stop-control');
const repair = require('./reader-repair');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CONTRACT = 'conference-active-paid-reader-recovery-v1';
const statEqual = (left, right) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => left[key] === right[key]);
function integrity(message) {
    throw Object.assign(new Error(`会议付费候选只读恢复完整性错误：${message}`), {
        code: 'CONFERENCE_ACTIVE_READER_REPLAY_INTEGRITY', scope: 'paper', retryable: false
    });
}
function tree(directory) {
    const entries = []; let totalBytes = 0;
    function visit(folder, relative = '') {
        const stat = fs.lstatSync(folder, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777n) !== 0o700n) integrity('原候选目录不安全');
        for (const name of fs.readdirSync(folder).sort()) {
            if (!/^[A-Za-z0-9._-]{1,220}$/.test(name) || name === '.' || name === '..') integrity('原记录文件名不安全');
            const file = path.join(folder, name), sub = path.join(relative, name), item = fs.lstatSync(file, { bigint: true });
            if (item.isSymbolicLink()) integrity('原记录不能含符号链接');
            if (item.isDirectory()) { visit(file, sub); continue; }
            if (!item.isFile() || item.nlink !== 1n || item.size > 64n * 1024n * 1024n
                || (item.mode & 0o777n) !== 0o600n) integrity('原记录必须是私有有界普通文件');
            const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            let bytes;
            try {
                const opened = fs.fstatSync(fd, { bigint: true });
                if (!opened.isFile() || opened.nlink !== 1n || (opened.mode & 0o777n) !== 0o600n
                    || !statEqual(item, opened)) integrity('打开的原记录与路径不一致');
                bytes = fs.readFileSync(fd);
                const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
                if (!after.isFile() || !named.isFile() || named.isSymbolicLink()
                    || opened.size !== BigInt(bytes.length) || !statEqual(opened, after)
                    || !statEqual(after, named)) integrity('原记录读取期间发生变化');
            } finally { fs.closeSync(fd); }
            totalBytes += bytes.length;
            if (totalBytes > 256 * 1024 * 1024 || entries.length >= 4096) integrity('原记录超过只读副本上限');
            entries.push({ path: sub, sha256: sha(bytes), bytes });
        }
    }
    visit(directory); return entries;
}
function copyTree(entries, target) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
        const filename = path.join(target, entry.path);
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.writeFileSync(filename, entry.bytes, { mode: 0o600, flag: 'wx' });
    }
}
const projection = entries => entries.map(({ path: name, sha256 }) => ({ path: name, sha256 }));
function optionalTree(directory) {
    try { return tree(directory); } catch (error) { if (error.code === 'ENOENT' && !fs.existsSync(directory)) return []; throw error; }
}
function paidCandidateProof(entries, identity, payload, source, usageDirectory) {
    const diagnostics = entries.filter(entry => /^request-diagnostics\/[a-f0-9-]{36}\.request\.json$/.test(entry.path));
    const matches = [];
    for (const entry of diagnostics) {
        const request = JSON.parse(entry.bytes), responseEntry = entries.find(item => item.path === entry.path.replace('.request.json', '.response.json'));
        if (request.contentAttempt !== payload.attempts || !isDeepStrictEqual(request.identity, identity) || !responseEntry) continue;
        const response = JSON.parse(responseEntry.bytes);
        if (request.contract !== 'reader-repair-request-diagnostics-v1'
            || entry.path !== `request-diagnostics/${request.id}.request.json`
            || request.promptSha256 !== sha(request.prompt) || request.draftSha256 !== repair.hashDraft(request.draft)
            || response.contract !== request.contract || response.id !== request.id
            || response.requestSha256 !== entry.sha256 || response.outputTextSha256 !== sha(response.rawResponse)) integrity('原付费请求响应绑定不一致');
        const replayed = require('./reader-compatible-candidate-replay').replayRepair(request, response, payload,
            source, draft => draft, true);
        if (!replayed || !/^applied-response-/.test(replayed.kind || '')
            || replayed.draftSha256 !== repair.hashDraft(payload.draft)) continue;
        matches.push({ entry, responseEntry, request, response, replayed });
    }
    if (matches.length !== 1) return null;
    const selected = matches[0], events = [];
    const usageRoot = fs.realpathSync(usageDirectory);
    if (fs.lstatSync(usageDirectory).isSymbolicLink()) integrity('原用量目录不安全');
    // 原费用目录很大；只对匹配原响应SHA的文件解析并签住精确字节，不建立持久索引。
    for (const name of fs.readdirSync(usageRoot).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
        const filename = path.join(usageRoot, name);
        const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let bytes;
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) integrity('原费用记录不安全');
            bytes = fs.readFileSync(fd);
        } finally { fs.closeSync(fd); }
        if (!bytes.includes(selected.response.outputTextSha256)) continue;
        const pinned = require('./reader-proof-read-scope').readReaderProofJson(filename, { expectedSha256: sha(bytes) });
        const event = pinned.value;
        if (event.kind !== 'request' || event.paperId !== identity.paperId || event.stage !== 'apiReaderRepair'
            || (event.runId ?? null) !== (identity.freshAnalysis?.runId ?? null)
            || event.contentAttempt !== selected.request.contentAttempt
            || event.outputTextSha256 !== selected.response.outputTextSha256
            || event.model !== identity.model?.model || event.protocol !== identity.model?.protocol) continue;
        const at = Date.parse(event.at), requestAt = Date.parse(selected.request.at), responseAt = Date.parse(selected.response.at);
        if (event.version !== 'llm-usage-v1' || !/^[a-f0-9-]{36}$/.test(event.eventId || '')
            || event.outcome !== 'completed' || event.statusCode !== 200
            || !Number.isFinite(at) || !Number.isFinite(requestAt) || !Number.isFinite(responseAt)
            || requestAt > at || requestAt > responseAt || Math.abs(responseAt - at) > 30000) integrity('原付费请求时间、结果或来源不一致');
        events.push({ filename, sha256: pinned.sha256, eventId: event.eventId });
    }
    if (events.length !== 1) return null;
    return { requestSha256: selected.entry.sha256, responseSha256: selected.responseEntry.sha256,
        outputTextSha256: selected.response.outputTextSha256, replay: selected.replayed, usage: events[0] };
}

async function replayActiveConferenceReaderCandidate({ loaded, planHandle, sourceRoot }, overrides = {}) {
    const deep = overrides.deep || require('../deep-analyzer'), engine = overrides.engine || require('../analysis-engine');
    const current = adapter.loadConferenceReaderRevision({ analysisRoot: path.dirname(loaded.directory),
        executionId: loaded.run.executionId });
    if (current.analysisFileSha256 !== loaded.analysisFileSha256 || current.sourceFileSha256 !== loaded.sourceFileSha256
        || current.runFileSha256 !== loaded.runFileSha256 || !isDeepStrictEqual(current.analysis, loaded.analysis)) integrity('原子稿已变化');
    adapter.verifyPlanAuthority(current, planHandle, sourceRoot);
    if (current.analysis.status !== 'partial'
        || !['reader-only', 'scoring-and-reader'].includes(current.revision.mode)
        || (current.revision.mode === 'scoring-and-reader' && !current.analysis.readerRevisionProgress?.scoringCheckpoint)) {
        return { eligible: false, reason: '仅支持上游已完成的同源Reader候选。' };
    }
    const directory = path.join(current.directory, 'reader-attempts'), attempts = optionalTree(directory);
    const active = attempts.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry.path));
    if (active.length !== 1) return { eligible: false, reason: '缺少唯一原活跃付费候选。' };
    const checked = repair.readFailedCandidateEnvelope(directory, null, path.join(directory, active[0].path));
    if (!checked || checked.envelopeSha256 !== active[0].sha256) integrity('候选原字节SHA不一致');
    const { identity, payload } = checked.envelope;
    const original = current.analysis.papers[0], parent = current.parent.analysis.papers[0];
    const sourceSha256 = sha(current.source.sourceDetails.text);
    if (identity.paperId !== current.run.paperId || identity.sourceSha256 !== sourceSha256
        || original.sourceSha256 !== sourceSha256) integrity('候选论文或原全文身份不一致');
    if (identity.contentMode !== 'reader-source-only-v1' || identity.conferenceReaderRetryEpoch !== 1
        || !repair.parseRecoveryDraft(payload.draft) || payload.attempts < 1 || payload.fullAttempts < 1) {
        return { eligible: false, reason: '没有可重放的原source-only付费正文。' };
    }
    const rules = require('./conference-postprocess').readOriginalTagProof(original).rules;
    const upstream = engine.getConferenceReaderRefreshUpstreamReason(original, { tagRules: rules });
    if (upstream) return { eligible: false, reason: upstream };
    const protectedStages = ['primaryAnalysis', 'coreSummaryRepair', 'tagSelection', 'taxonomySeal'];
    for (const name of protectedStages) {
        if (!isDeepStrictEqual(original.analysisManifest?.stages?.[name], parent.analysisManifest?.stages?.[name])) {
            integrity(`原${name}阶段不一致`);
        }
    }
    const preflight = current.resourcePreflight;
    if (!preflight) integrity('原资源预检缺失');
    deep.replayVerifiedReaderResourceIdentity(preflight, current.source.sourceDetails.text);
    const paid = paidCandidateProof(attempts, identity, payload, current.source.sourceDetails,
        overrides.usageDirectory || require('../config').FILES.llmUsageDir);
    if (!paid) return { eligible: false, reason: '原活跃候选缺少唯一真实付费请求响应及费用闭合链。' };
    const assetsDirectory = path.join(current.directory, 'reader-assets'), assets = optionalTree(assetsDirectory);
    const pinned = ['analysis.json', 'run.json', 'source.json', 'reader-revision.json', 'reader-resource-preflight.json']
        .map(name => ({ name, ...adapter.readJsonRecord(path.join(current.directory, name)) }));
    const sameFiles = () => {
        const after = adapter.loadConferenceReaderRevision({ analysisRoot: path.dirname(current.directory), executionId: current.run.executionId });
        if (after.analysisFileSha256 !== current.analysisFileSha256 || after.runFileSha256 !== current.runFileSha256
            || after.sourceFileSha256 !== current.sourceFileSha256) integrity('派生期间原子稿或父稿发生变化');
        for (const record of pinned) if (adapter.readJsonRecord(path.join(current.directory, record.name)).sha256 !== record.sha256) integrity('原修订或预检发生变化');
        if (!isDeepStrictEqual(projection(optionalTree(directory)), projection(attempts))
            || !isDeepStrictEqual(projection(optionalTree(assetsDirectory)), projection(assets))) integrity('原候选、请求响应或图片发生变化');
        require('./reader-proof-read-scope').readReaderProofJson(paid.usage.filename, { expectedSha256: paid.usage.sha256 });
        adapter.verifyPlanAuthority(after, planHandle, sourceRoot);
    };
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-active-reader-'));
    fs.chmodSync(temporary, 0o700);
    const executionDir = path.join(temporary, current.run.executionId);
    fs.mkdirSync(executionDir, { mode: 0o700 });
    try {
        for (const record of pinned) fs.writeFileSync(path.join(executionDir, record.name), record.bytes, { mode: 0o600, flag: 'wx' });
        copyTree(attempts, path.join(executionDir, 'reader-attempts'));
        if (assets.length) copyTree(assets, path.join(executionDir, 'reader-assets'));
        let paper = structuredClone(original);
        if (current.revision.mode === 'reader-only') paper.apiReaderResources = structuredClone(preflight);
        try {
            paper = await stop.withModelRequestsForbidden(() => context.withConferenceAnalysisSource({
                executionId: current.run.executionId, executionDir, paperId: current.run.paperId,
                sourceDetails: current.source.sourceDetails, readerRetryEpoch: 1
            }, () => deep.refreshApiReaderArticleFromSource(paper, current.source.sourceDetails,
                { resumeSavedSourceReader: true, requireExistingSourceCandidate: true })));
        } catch (error) {
            sameFiles();
            const failure = require('./conference-process-recovery').classifyFailure(error, new Date().toISOString());
            if (failure.category === 'storage' || error.code === 'CONFERENCE_ACTIVE_READER_REPLAY_INTEGRITY'
                || ['CONFERENCE_SOURCE_CONTEXT_INTEGRITY', 'READER_IMAGE_SOURCE_INTEGRITY'].includes(error.code)
                || (failure.category === 'integrity' && !error.readerIssues)) throw error;
            return { eligible: false, reason: error.message, code: error.code || null };
        }
        sameFiles();
        const stage = paper.analysisManifest?.stages?.apiReaderArticle;
        if (stage?.contentMode !== identity.contentMode || stage.attempts !== payload.attempts
            || stage.fullAttempts !== payload.fullAttempts || (stage.transportFailures || 0) !== (payload.transportFailures || 0)) integrity('只读重放改变了原模型尝试或费用身份');
        for (const name of protectedStages) if (!isDeepStrictEqual(paper.analysisManifest?.stages?.[name], original.analysisManifest?.stages?.[name])) integrity(`重放改变受保护${name}阶段`);
        if (paper.analysis !== original.analysis) integrity('Reader重放改变了原主文或评分');
        for (const figure of paper.apiReaderFigures || []) {
            const saved = assets.find(entry => entry.path === figure.assetFilename);
            if (!saved || saved.sha256 !== figure.assetSha256) return { eligible: false, reason: '新稿图片缺少原同SHA已存资产。' };
            figure.cachePath = path.join(assetsDirectory, figure.assetFilename);
        }
        // 仅把新生成阶段的物化路径从私有副本还原为同字节原资产；像素及正文未改变。
        stage.figuresSha256 = require('../deep-analyzer').stableFingerprint(paper.apiReaderFigures || []);
        if (JSON.stringify(paper).includes(temporary)) integrity('临时文件路径泄露到原稿');
        const qualified = context.withConferenceAnalysisSource({ executionId: current.run.executionId,
            executionDir: current.directory, paperId: current.run.paperId, sourceDetails: current.source.sourceDetails }, () =>
            engine.isSuccessfulAnalysisRecordForReadOnlyConferencePublication(paper, { tagRules: rules }));
        if (!qualified) return { eligible: false, reason: '原付费候选仍未通过正常整篇资格。' };
        sameFiles();
        const proof = { contract: CONTRACT, version: 1, executionId: current.run.executionId, paperId: current.run.paperId,
            revisionSha256: current.revision.revisionSha256, analysisFileSha256: current.analysisFileSha256,
            sourceFileSha256: current.sourceFileSha256, parentAnalysisFileSha256: current.parent.analysisFileSha256,
            parentRunFileSha256: current.parent.runFileSha256,
            candidate: { name: active[0].path, envelopeSha256: checked.envelopeSha256,
                identitySha256: repair.hashDraft(identity), payloadSha256: checked.envelope.payloadSha256,
                sourceSha256, attempts: payload.attempts, fullAttempts: payload.fullAttempts,
                transportFailures: payload.transportFailures || 0 },
            paid,
            originalFiles: [...projection(attempts).map(item => ({ ...item, path: 'reader-attempts/' + item.path })),
                ...projection(assets).map(item => ({ ...item, path: 'reader-assets/' + item.path }))],
            articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256 };
        return { eligible: true, paper, proof, assertUnchanged: sameFiles };
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { CONTRACT, replayActiveConferenceReaderCandidate };

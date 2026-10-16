'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
test.mock.method(require('../scripts/env-loader'), 'loadProjectEnv', () => {
    Object.assign(process.env, { PAPER_ANALYZER_ENDPOINT: 'https://example.invalid/v1', PAPER_ANALYZER_API_KEY: 'test-only-no-network', PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor', HTTPS_PROXY: 'http://127.0.0.1:9' });
    return process.env;
});
const Config = require('../scripts/config');
const deep = require('../scripts/deep-analyzer');
const diagnostics = require('../scripts/lib/reader-request-diagnostics');
const { validAnalysisText } = require('./valid-analysis-fixture');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const baseline = validAnalysisText();
const sourceText = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
const goodSummary = baseline.match(/## 核心摘要\n([\s\S]*?)(?=\n## 方法概述和架构)/)[1];
const incompleteAnalysis = baseline.replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
    '## 核心摘要\n摘要仍待展开。\n');
const paper = { arxivId: '2610.90009', title: '摘要记录公开控制' };

function snapshot(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).sort().flatMap(name => {
        const file = path.join(root, name);
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) return snapshot(file);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), '记录树必须由真实文件组成');
        return [[file, sha256(fs.readFileSync(file))]];
    });
}

function isolated(t) {
    const originalDirectory = Config.FILES.analysisRepairAttemptsDir;
    const originalBytes = snapshot(originalDirectory);
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-records-test-'));
    Config.FILES.analysisRepairAttemptsDir = folder;
    t.after(() => {
        Config.FILES.analysisRepairAttemptsDir = originalDirectory;
        try {
            assert.deepEqual(snapshot(originalDirectory), originalBytes, '默认摘要记录树原字节必须保持');
        } finally {
            fs.rmSync(folder, { recursive: true, force: true });
        }
    });
    return path.join(folder, '2610.90009');
}

function readRecords(root) {
    const directory = path.join(root, 'request-diagnostics');
    return fs.readdirSync(directory).filter(name => name.endsWith('.request.json')).map(name => {
        const request = JSON.parse(fs.readFileSync(path.join(directory, name)));
        return diagnostics.readCoreSummaryDiagnostic(root, request.id, request.identity);
    });
}

test('真实局部响应解析前完整保存且合格结果保留其他章节', async t => {
    const root = isolated(t);
    let calls = 0;
    const rawResponse = `## 核心摘要\n${goodSummary}`;
    const result = await deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, {
        callModelFn: async () => {
            calls++;
            return rawResponse;
        }
    });
    assert.equal(calls, 1);
    assert.equal(result, baseline);
    const records = readRecords(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].response.rawResponse, rawResponse);
    assert.equal(records[0].disposition.status, 'validated');
    assert.equal(records[0].request.inputAnalysis, incompleteAnalysis);
    assert.equal(records[0].request.sourceText, sourceText);
    assert.equal(records[0].request.evidenceText, sourceText);
    assert.throws(() => diagnostics.readCoreSummaryDiagnostic(root, records[0].request.id, {
        ...records[0].request.identity, inputAnalysisSha256: 'a'.repeat(64)
    }), /当前来源或输入不一致/);
});

test('三个不合格真实原文全部保留且不授成功，原合格摘要零请求零写入', async t => {
    const root = isolated(t);
    let calls = 0;
    const rawResponse = '这不是一节合法摘要，保留 原始 空白\n';
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, {
        callModelFn: async () => {
            calls++;
            return rawResponse;
        }
    }), /核心摘要局部修复失败/);
    assert.equal(calls, 3);
    const records = readRecords(root);
    assert.equal(records.length, 3);
    for (const record of records) {
        assert.equal(record.response.rawResponse, rawResponse);
        assert.equal(record.disposition.status, 'rejected');
    }
    const before = snapshot(root);
    const result = await deep.repairCoreSummarySection(paper, baseline, sourceText, sourceText, {
        callModelFn: async () => assert.fail('合格摘要不请求')
    });
    assert.equal(result, baseline);
    assert.deepEqual(snapshot(root), before);
});

for (const suffix of ['.request.json', '.response.json']) {
    test(`${suffix}写失败在请求前零次或响应后一请求停止且保留原EIO`, async t => {
        const testRoot = isolated(t);
        let calls = 0;
        const originalOpen = fs.openSync;
        fs.openSync = function (file, ...args) {
            if (typeof file === 'string' && file.startsWith(testRoot + path.sep)
                && file.endsWith(suffix) && String(args[0]).includes('w')) {
                throw Object.assign(new Error('真实本地记录故障'), { code: 'EIO' });
            }
            return originalOpen.call(this, file, ...args);
        };
        try {
        await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, {
            callModelFn: async () => {
                calls++;
                return `## 核心摘要\n${goodSummary}`;
            }
        }), error => error.code === 'READER_DIAGNOSTIC_FAILED' && error.scope === 'run'
            && error.retryable === false && error.cause.code === 'EIO');
        assert.equal(calls, suffix === '.request.json' ? 0 : 1);
        } finally { fs.openSync = originalOpen; }
    });
}

test('公开记录权威字段不可覆盖，坏状态和SHA以及保存后状态篡改拒绝', t => {
    const root = isolated(t);
    const identity = {
        inputAnalysisSha256: sha256('input'), sourceTextSha256: sha256('source'),
        evidenceSha256: sha256('evidence')
    };
    const diagnostic = diagnostics.beginCoreSummaryDiagnostic(root, {
        identity, prompt: '真实提示', inputAnalysis: 'input', sourceText: 'source', evidenceText: 'evidence'
    });
    diagnostics.saveCoreSummaryResponse(diagnostic, '原始响应');
    assert.throws(() => diagnostics.saveCoreSummaryDisposition(diagnostic, {
        status: 'complete', outputTextSha256: sha256('原始响应')
    }), /格式无效/);
    assert.throws(() => diagnostics.saveCoreSummaryDisposition(diagnostic, {
        status: 'validated', outputTextSha256: 'bad'
    }), /格式无效/);
    diagnostics.saveCoreSummaryDisposition(diagnostic, {
        status: 'rejected', outputTextSha256: sha256('原始响应'),
        contract: '伪造', id: '伪造', requestSha256: '伪造'
    });
    const loaded = diagnostics.readCoreSummaryDiagnostic(root, diagnostic.id, identity);
    assert.equal(loaded.disposition.contract, 'core-summary-request-diagnostics-v1');
    assert.equal(loaded.disposition.id, diagnostic.id);
    assert.equal(loaded.disposition.requestSha256, diagnostic.requestSha256);
    const file = path.join(root, 'request-diagnostics', `${diagnostic.id}.disposition.json`);
    fs.writeFileSync(file, JSON.stringify({ ...loaded.disposition, status: 'complete' }));
    assert.throws(() => diagnostics.readCoreSummaryDiagnostic(root, diagnostic.id, identity),
        /当前来源或输入不一致|结果记录格式无效/);
});


test('明确原付费记录可正常重验且原拒绝记录和费用不改，错身份及坏响应先拒绝', async t => {
    const root = isolated(t);
    await deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, {
        callModelFn: async () => `## 核心摘要\n${goodSummary}`
    });
    const [saved] = readRecords(root);
    const dispositionPath = path.join(root, 'request-diagnostics', `${saved.request.id}.disposition.json`);
    const rejected = JSON.parse(fs.readFileSync(dispositionPath));
    rejected.status = 'rejected'; rejected.error = '旧实现方法链误拒';
    fs.writeFileSync(dispositionPath, JSON.stringify(rejected));
    const before = snapshot(root);
    let calls = 0;
    const options = { coreSummaryDiagnosticId: saved.request.id, callModelFn: async () => { calls++; throw Error('不得新请求'); } };
    assert.equal(await deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, options), baseline);
    assert.deepEqual(snapshot(root), before);
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis + '\n输入变化', sourceText, sourceText, options), /当前来源或输入不一致/);
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText + '变化', sourceText, options), /当前来源或输入不一致/);
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, { ...options, coreSummaryDiagnosticId: '错ID' }), /身份无效|原请求 ID 无效/);
    const responsePath = path.join(root, 'request-diagnostics', `${saved.request.id}.response.json`);
    const response = JSON.parse(fs.readFileSync(responsePath)); response.rawResponse += '篡改';
    fs.writeFileSync(responsePath, JSON.stringify(response));
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, options), /当前来源或输入不一致/);
    assert.equal(calls, 0);
});

test('原付费响应仍有真实摘要质量错误时拒绝复用且不发新请求', async t => {
    const root = isolated(t);
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, {
        callModelFn: async () => '## 核心摘要\n摘要太短，缺少具体机制与结果。'
    }), /核心摘要局部修复失败/);
    const [saved] = readRecords(root);
    const before = snapshot(root); let calls = 0;
    await assert.rejects(deep.repairCoreSummarySection(paper, incompleteAnalysis, sourceText, sourceText, {
        coreSummaryDiagnosticId: saved.request.id,
        callModelFn: async () => { calls++; throw Error('不应新请求'); }
    }), /原付费摘要仍未通过当前检查/);
    assert.equal(calls, 0); assert.deepEqual(snapshot(root), before);
});

test('普通无需修复的合格摘要不增加论文身份要求', async () => {
    assert.equal(await deep.repairCoreSummarySection({ title: '原无ID普通纯校验' }, baseline, sourceText, sourceText), baseline);
});

test('非arXiv身份显式付费摘要不能绕过记录核验', async () => {
    await assert.rejects(deep.repairCoreSummarySection({ title: '无ID' }, baseline, sourceText, sourceText, { coreSummaryDiagnosticId: 'd9077527-0d59-4d92-8d0c-0e3d7b10007f' }), /规范论文身份/);
});

test('会议摘要沿认证来源保存和零请求重放，会议/执行/全文/原稿身份不交叉复用', async t => {
    isolated(t);
    const conference = require('../scripts/lib/conference-analysis-context');
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conference-core-diagnostic-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const executionId = '77777777-7777-4777-8777-777777777777';
    const executionDir = path.join(folder, executionId); fs.mkdirSync(executionDir);
    const id = 'conference:interspeech:2026:conference-paper-id:ahn26b_interspeech';
    const conferencePaper = { id, conferencePaperId: id, sourceId: id, source: 'conference',
        sourceSha256: sha256(sourceText), title: '规范会议摘要诊断',
        analysisManifest: { sourceAcquisition: { sourceSha256: sha256(sourceText) } } };
    const details = { source: 'conference_pdf_text', sourceId: id, text: sourceText,
        structuredArtifacts: { payloadSha256: 'c'.repeat(64) } };
    const identity = { executionId, executionDir, paperId: id, sourceDetails: details };
    const run = (callback, scope = identity) => conference.withConferenceAnalysisSource(scope, callback);
    let calls = 0;
    const result = await run(() => deep.repairCoreSummarySection(conferencePaper,
        incompleteAnalysis, sourceText, sourceText, { callModelFn: async () => {
            calls += 1; return `## 核心摘要\n${goodSummary}`;
        } }));
    assert.equal(result, baseline); assert.equal(calls, 1);
    const context = run(() => conference.conferenceCoreSummaryRepairContext(conferencePaper, sourceText));
    assert.ok(context.directory.startsWith(executionDir + path.sep));
    assert.match(path.basename(context.directory), /^conference-[a-f0-9]{64}$/);
    const [record] = readRecords(context.directory);
    assert.equal(record.request.identity.paperId, id);
    assert.equal(record.request.identity.sourceIdentity.executionId, executionId);
    assert.equal(record.request.identity.sourceIdentity.sourceSha256, sha256(sourceText));
    const before = snapshot(context.directory);
    const replay = { coreSummaryDiagnosticId: record.request.id,
        callModelFn: async () => assert.fail('会议原付费摘要重放不得再发请求') };
    assert.equal(await run(() => deep.repairCoreSummarySection(conferencePaper,
        incompleteAnalysis, sourceText, sourceText, replay)), baseline);
    assert.deepEqual(snapshot(context.directory), before);
    await assert.rejects(deep.repairCoreSummarySection(conferencePaper,
        incompleteAnalysis, sourceText, sourceText, replay), /规范论文身份/);
    await assert.rejects(run(() => deep.repairCoreSummarySection({ ...conferencePaper, arxivId: '2610.90009' },
        incompleteAnalysis, sourceText, sourceText, replay)), /refuses arXiv aliases/);
    await assert.rejects(run(() => deep.repairCoreSummarySection(conferencePaper,
        incompleteAnalysis, sourceText + 'changed', sourceText, replay)), /相同封存全文/);
    await assert.rejects(run(() => deep.repairCoreSummarySection({ ...conferencePaper, sourceSha256: '0'.repeat(64) },
        incompleteAnalysis, sourceText, sourceText, replay)), /相同封存全文/);
    await assert.rejects(run(() => deep.repairCoreSummarySection(conferencePaper,
        incompleteAnalysis + '\nchanged', sourceText, sourceText, replay)), /当前来源或输入不一致/);
    const otherExecutionId = '88888888-8888-4888-8888-888888888888';
    const otherExecutionDir = path.join(folder, otherExecutionId); fs.mkdirSync(otherExecutionDir);
    const otherScope = { ...identity, executionId: otherExecutionId, executionDir: otherExecutionDir };
    const otherContext = run(() => conference.conferenceCoreSummaryRepairContext(conferencePaper, sourceText), otherScope);
    fs.cpSync(context.directory, otherContext.directory, { recursive: true });
    await assert.rejects(run(() => deep.repairCoreSummarySection(conferencePaper,
        incompleteAnalysis, sourceText, sourceText, replay), otherScope), /当前来源或输入不一致/);
    const otherId = id.replace(':interspeech:', ':icassp:');
    const otherPaper = { ...conferencePaper, id: otherId, conferencePaperId: otherId, sourceId: otherId };
    const otherConferenceContext = run(() => conference.conferenceCoreSummaryRepairContext(otherPaper, sourceText),
        { ...identity, paperId: otherId, sourceDetails: { ...details, sourceId: otherId } });
    assert.notEqual(otherConferenceContext.directory, context.directory);
    assert.deepEqual(snapshot(context.directory), before);
});

for (const historicalConference of [true, false]) {
    test(`历史直改${historicalConference ? '会议' : 'arXiv'}摘要绑定真实运行与来源，跨身份或凭证拒绝`, async t => {
        const defaultRoot = isolated(t);
        const direct = require('../scripts/lib/direct-rewrite-analysis-context');
        const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'direct-core-diagnostic-'));
        t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
        const id = historicalConference ? 'conference:interspeech:2026:conference-paper-id:ahn26b_interspeech' : 'arxiv:2610.90009';
        const target = historicalConference ? { directPaperId: id, id, title: '历史会议摘要' }
            : { directPaperId: id, arxivId: '2610.90009', title: '历史arXiv摘要' };
        const details = { source: historicalConference ? 'conference_pdf_text' : 'html',
            sourceId: historicalConference ? id : '2610.90009v3', text: sourceText,
            structuredArtifacts: { payloadSha256: 'c'.repeat(64) } };
        const runId = '99999999-9999-4999-8999-999999999999';
        const scope = { runId, route: historicalConference ? 'conference-local-pdf' : 'arxiv-fresh-fetch',
            paperId: id, sourceDetails: details, sourceSha256: sha256(sourceText),
            structuredArtifactsSha256: 'c'.repeat(64), sourceSnapshotSha256: 'd'.repeat(64),
            readerAttemptsDir: path.join(folder, runId, 'reader-attempts'),
            ...(!historicalConference ? { sourceGeneration: 3, sourceManifestSha256: 'e'.repeat(64) } : {}) };
        const run = (callback, identity = scope) => direct.withDirectRewriteAnalysisSource(identity, callback);
        let calls = 0;
        assert.equal(await run(() => deep.repairCoreSummarySection(target, incompleteAnalysis, sourceText, sourceText,
            { callModelFn: async () => { calls++; return `## 核心摘要\n${goodSummary}`; } })), baseline);
        assert.equal(calls, 1);
        const diagnostic = run(() => direct.directCoreSummaryRepairContext(target, sourceText));
        assert.ok(diagnostic.directory.startsWith(scope.readerAttemptsDir + path.sep));
        assert.match(path.basename(diagnostic.directory), /^direct-[a-f0-9]{64}$/);
        const [record] = readRecords(diagnostic.directory);
        assert.equal(record.request.identity.paperId, id);
        assert.deepEqual(record.request.identity.sourceIdentity, {
            ...run(() => direct.getDirectSourceRecord(target)), paperId: id, route: scope.route });
        assert.equal(record.request.identity.sourceIdentity.sourceSnapshotSha256, scope.sourceSnapshotSha256);
        const original = snapshot(diagnostic.directory);
        const replay = { coreSummaryDiagnosticId: record.request.id,
            callModelFn: async () => assert.fail('历史付费摘要重放不得新请求') };
        assert.equal(await run(() => deep.repairCoreSummarySection(target, incompleteAnalysis, sourceText, sourceText, replay)), baseline);
        assert.deepEqual(snapshot(diagnostic.directory), original);
        assert.deepEqual(snapshot(defaultRoot), [], '历史arXiv也不得落入普通日更诊断目录');
        const attempt = (paper = target, text = sourceText, identity = scope) => run(() =>
            deep.repairCoreSummarySection(paper, incompleteAnalysis, text, sourceText, replay), identity);
        const { runId: ignored, ...missingRun } = scope;
        await assert.rejects(attempt(target, sourceText, missingRun), /真实直改运行/);
        await assert.rejects(attempt({ ...target, directPaperId: historicalConference
            ? id.replace(':ahn26b_', ':other_') : 'arxiv:2610.90010' }), /不是同一篇|另一篇/);
        await assert.rejects(attempt({ ...target, arxivId: historicalConference ? '2610.90009' : '2610.90010' }), /规范论文身份/);
        await assert.rejects(attempt(target, sourceText + 'changed'), /相同封存全文/);
        await assert.rejects(attempt({ ...target, sourceSha256: '0'.repeat(64) }), /相同封存全文/);
        await assert.rejects(attempt(target, sourceText, { ...scope, sourceSnapshotSha256: 'f'.repeat(64) }), /当前来源或输入不一致/);
        await assert.rejects(attempt(target, sourceText, { ...scope, sourceDetails: { ...details,
            sourceId: historicalConference ? id.replace(':ahn26b_', ':other_') : '2610.90010' } }), /相同封存全文/);
        await assert.rejects(attempt(target, sourceText, { ...scope,
            route: historicalConference ? 'arxiv-fresh-fetch' : 'conference-local-pdf',
            sourceGeneration: 3, sourceManifestSha256: 'e'.repeat(64) }), /规范论文身份/);
        const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const otherScope = { ...scope, runId: otherId, readerAttemptsDir: path.join(folder, otherId, 'reader-attempts') };
        const otherDiagnostic = run(() => direct.directCoreSummaryRepairContext(target, sourceText), otherScope);
        fs.cpSync(diagnostic.directory, otherDiagnostic.directory, { recursive: true });
        await assert.rejects(attempt(target, sourceText, otherScope), /当前来源或输入不一致/);
        assert.deepEqual(snapshot(diagnostic.directory), original);
    });
}

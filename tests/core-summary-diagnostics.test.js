'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');
const originalResult = '在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。';
const source = 'Experiment results on the public test set compare baseline NLL 1.2 versus our NLL 0.6.';
function validate(result) {
    return validateCoreSummarySemanticContract(validAnalysisText().replace(originalResult, result + '上述对比仅适用于该评测范围，不同输入质量与真实使用环境中的可靠程度仍需要进一步核验。'), { sourceText: source });
}

test('真实测试负对数似然指标与明确比较保留，无指标或同名模型不能替代结果', () => {
    for (const result of [
        '在 Nottingham 测试集上，测试 NLL 从 1.2 bits per token 降至 0.6 bits per token，本文模型优于基线。',
        '在 Nottingham 测试集上，负对数似然从 1.2 降至 0.6，本文模型优于基线。',
        '在 Nottingham 测试集上，negative-log-likelihood 从 1.2 降至 0.6，本文模型优于基线。'
    ]) assert.equal(validate(result), null, result);
    for (const result of [
        '在 Nottingham 测试集上，从 1.2 降至 0.6，本文模型优于基线。',
        '在 Nottingham 测试集上，NLL模型从 1.2 降至 0.6，本文模型优于基线。',
        'NLL 从 1.2 降至 0.6，本文模型优于基线。'
    ]) assert.ok(validate(result), result);
});

test('核心三次内容修复耗尽不再触发整篇自动重试，原稿与三份响应保留', async t => {
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-exhaustion-sample-'));
    const previous = Config.FILES.analysisRepairAttemptsDir;
    Config.FILES.analysisRepairAttemptsDir = temporary;
    t.after(() => { Config.FILES.analysisRepairAttemptsDir = previous; fs.rmSync(temporary, { recursive: true, force: true }); });
    const original = validAnalysisText().replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/, '## 核心摘要\n摘要待修。\n');
    const paper = { arxivId: '2610.90019', title: '核心修复耗尽测试样例' };
    let responses = 0;
    const result = await engine.analyzePaperWithRetry(paper, { maxRetries: 2, retryDelayMs: 0,
        analyzeFn: current => deep.repairCoreSummarySection(current, original, source, null, {
            callModelFn: async () => { responses += 1; return '## 核心摘要\n仍是过短的摘要。'; }
        }) });
    assert.equal(result.success, false);
    assert.equal(responses, 3);
    assert.equal(result.result.latestAnalysisAttemptRetryable, false);
    const directory = path.join(temporary, '2610.90019', 'request-diagnostics');
    const files = fs.readdirSync(directory);
    assert.equal(files.filter(file => file.endsWith('.response.json')).length, 3);
    for (const filename of files.filter(file => file.endsWith('.request.json'))) {
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, filename))).inputAnalysis, original);
    }
});

test('核心请求传输失败仍沿正常整篇重试，不冒充三次内容耗尽', async t => {
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-transport-sample-'));
    const previous = Config.FILES.analysisRepairAttemptsDir;
    Config.FILES.analysisRepairAttemptsDir = temporary;
    t.after(() => { Config.FILES.analysisRepairAttemptsDir = previous; fs.rmSync(temporary, { recursive: true, force: true }); });
    const original = validAnalysisText().replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/, '## 核心摘要\n摘要待修。\n');
    let requests = 0;
    const result = await engine.analyzePaperWithRetry({ arxivId: '2610.90020', title: '传输失败测试样例' }, {
        maxRetries: 2, retryDelayMs: 0,
        analyzeFn: current => deep.repairCoreSummarySection(current, original, source, null, {
            callModelFn: async () => { requests += 1; throw Object.assign(new Error('合成DNS失败'), { code: 'ENOTFOUND', retryable: true }); }
        })
    });
    assert.equal(result.success, false);
    assert.equal(requests, 3);
    assert.equal(result.result.latestAnalysisAttemptRetryable, true);
});

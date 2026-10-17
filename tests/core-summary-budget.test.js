'use strict';

require('./core-diagnostics-test-isolation')();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer.js');
const versions = require('../scripts/lib/prompt-text-versions.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

const sampleAnalysis = validAnalysisText();
const sampleSummary = sampleAnalysis.match(/## 核心摘要\n([\s\S]*?)(?=\n## 方法概述和架构)/)[1].trim();
const countChinese = text => (text.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
const replaceSummary = summary => sampleAnalysis.replace(/## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/, '## 核心摘要\n' + summary + '\n');
const sampleSource = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';

function fingerprintPayload(contract) {
    const original = crypto.createHash; let payload;
    crypto.createHash = function (...args) {
        const hash = original.apply(this, args), update = hash.update;
        hash.update = function (value, ...rest) {
            if (typeof value === 'string' && value.startsWith('{')) {
                let candidate; try { candidate = JSON.parse(value); } catch (_) { /* Raw source is not JSON. */ }
                if (candidate?.promptTextContract === contract && candidate.inputAnalysisSha256
                    && candidate.evidenceMaxChars) payload = candidate;
            }
            return update.call(this, value, ...rest);
        };
        return hash;
    };
    try {
        deep.buildTextStageFingerprint('coreSummaryRepair', replaceSummary('摘要待修复。'), sampleSource, contract);
    } finally { crypto.createHash = original; }
    assert.ok(payload, 'must capture the actual public fingerprint JSON');
    return payload;
}

test('当前core7阶段指纹预算与真实核心修复调用一致，原core6预算不变', async () => {
    const current = fingerprintPayload(versions.currentPromptTextContract('coreSummaryRepair'));
    const previous = fingerprintPayload('analysis-prompt-text-v6');
    let calls = 0;
    const repaired = await deep.repairCoreSummarySection(
        { arxivId: '2610.90020', title: '真实预算与指纹一致性合成样例' },
        replaceSummary('摘要待修复。'), sampleSource, sampleSource,
        { callModelFn: async (_messages, maxTokens) => {
            calls++;
            assert.equal(current.maxTokens, maxTokens);
            assert.equal(previous.maxTokens, maxTokens);
            return '## 核心摘要\n' + sampleSummary;
        } });
    assert.equal(calls, 1);
    assert.equal(repaired, sampleAnalysis);
});

test('每次摘要修复请求使用当前候选真实字数与剩余空间，并保留事实及明确逐字保护', async () => {
    const initialSummary = '摘要待修复。';
    const secondSummary = '当前说明仍未交代任务和可核对结果。';
    const summaries = [initialSummary, secondSummary];
    let requestCount = 0;
    const repaired = await deep.repairCoreSummarySection(
        { arxivId: '2610.90019', title: '摘要篇幅测试样例' },
        replaceSummary(initialSummary), sampleSource, sampleSource,
        { callModelFn: async messages => {
            const prompt = messages[0].content;
            const actualCount = countChinese(summaries[requestCount]);
            assert.ok(prompt.includes('当前摘要实际含 ' + actualCount + ' 个汉字与中文标点'));
            assert.ok(prompt.includes('距 600 个上限只剩 ' + (600 - actualCount) + ' 个'));
            assert.match(prompt, /420–520/);
            assert.match(prompt, /320–600/);
            assert.match(prompt, /6–9/);
            assert.match(prompt, /修正缺项应替换原有不完整或重复句/);
            assert.match(prompt, /反馈明确要求逐字保留的句子必须原样保留/);
            assert.match(prompt, /数值可以位于不同方法行/);
            assert.match(prompt, /禁止把不同数据集、评测协议、指标或不连续证据片段拼成同条件比较/);
            assert.doesNotMatch(prompt, /逐字来自同一原表行/);
            requestCount += 1;
            return '## 核心摘要\n' + (requestCount === 1 ? secondSummary : sampleSummary);
        } }
    );
    assert.equal(requestCount, 2);
    assert.equal(repaired, sampleAnalysis);
});

test('旧核心摘要第四版正文仍按原路径和原字节读取，新版本不改变旧正文', () => {
    const oldPath = versions.promptFilePathForContract('coreSummaryRepair', 'analysis-prompt-text-v4');
    assert.equal(oldPath, 'prompts/core-summary-repair-v4.md');
    const oldBytes = require('../scripts/lib/prompt-evidence.js').readPromptEvidenceBytes(oldPath);
    assert.equal(crypto.createHash('sha256').update(oldBytes).digest('hex'), '65cf4a3656fabab76a8203b35c7b01aa1417350f7eb0fe0e304528262e6f5d7e');
    assert.equal(versions.currentTextStagePromptPath('coreSummaryRepair'), 'prompts/core-summary-repair-v7.md');
    assert.notDeepEqual(require('../scripts/lib/prompt-evidence.js').readPromptEvidenceBytes('prompts/core-summary-repair-v5.md'), oldBytes);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const history = require('../scripts/lib/prompt-history.js');
const versions = require('../scripts/lib/prompt-text-versions.js');
const { loadPrompt } = require('../scripts/utils.js');
const contract = require('../scripts/analysis-contract.js');
const { validateImageNarrativeContext } = require('../scripts/deep-analyzer.js');
const ROOT = path.join(__dirname, '..');
const previous = {
    primaryAnalysis: '983688cfe244e4c5c480507bfadaa54de7866b279887365fa5980bf2cece67fd',
    structureRepair: 'cf1e7eb93d06029d2c27b9b8d72bee5d973cf168e8542d05f172e5b785185def',
    imageSupplement: '3f7d360ec5b1ab89e7e1bc8f8f2fd7b56e35b2054a38e5cc03ffc586de41f5f5',
    visualSummary: 'd9316170e683b0f080b2cf2f260b8c12759940bd2927b01b075f58f8311407d4',
    digestCover: '171a5ad339277a2b25c617d4e52db1df9dfa577d04725866012f05df35c02856'
};
const placeholders = text => [...String(text).matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)]
    .map(match => match[1]).sort();

test('五份旧正文仍可按整文件和模板 SHA 核验，新首围栏保留全部输入占位符', () => {
    for (const [stage, sha] of Object.entries(previous)) {
        const old = history.promptBytesForSha256(stage, sha);
        assert.ok(old, `${stage} 的旧字节应存在于归档`);
        assert.equal(history.sha256Buffer(old), sha);
        const relative = versions.currentTextStagePromptPath(stage);
        const current = fs.readFileSync(path.join(ROOT, relative));
        assert.notEqual(history.sha256Buffer(current), sha);
        const oldTemplateSha = history.promptTemplateSha256(old.toString(), versions.currentPromptTextContract(stage));
        assert.deepEqual(history.historicalPromptTemplateBytesForSha256(oldTemplateSha,
            versions.currentPromptTextContract(stage)), old);
        const prompt = loadPrompt(relative, {});
        assert.deepEqual(placeholders(prompt), placeholders(old.toString().match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m)[2]));
        const variables = Object.fromEntries(placeholders(prompt).map(key => [key, `输入_${key}`]));
        const rendered = loadPrompt(relative, variables);
        for (const value of Object.values(variables)) assert.ok(rendered.includes(value));
        assert.deepEqual(placeholders(rendered), []);
    }
});

test('结构修复提示词的摘要长度要求与正式检查一致，方法正文最低长度边界准确', () => {
    const prompt = loadPrompt(versions.currentTextStagePromptPath('structureRepair'), {});
    assert.ok(prompt.includes(`${contract.CORE_SUMMARY_MIN_SENTENCES}–${contract.CORE_SUMMARY_MAX_SENTENCES} 句`));
    assert.ok(prompt.includes(`${contract.CORE_SUMMARY_MIN_CHINESE_CHARS}–${contract.CORE_SUMMARY_MAX_CHINESE_CHARS} 个`));
    const minimum = Number(prompt.match(/方法概述至少 (\d+) 个中文字符/)[1]);
    const paragraphs = Number(prompt.match(/至少分成 (\d+) 个有效段落/)[1]);
    const method = count => '## 方法概述和架构\n' + Array.from({ length: paragraphs }, (_, i) =>
        (i ? '中' : '输入') + '文'.repeat(count - (i ? 1 : 2))).join('\n\n') + '\n## 核心创新点\n';
    assert.equal(contract.validateMethodDetailContract(method(Math.ceil(minimum / paragraphs))), null);
    assert.match(contract.validateMethodDetailContract(method(Math.floor((minimum - 1) / paragraphs))), /字符不足/);
});

test('插图示例的前文引导和图后解释通过真实叙事校验，图后不再指向下图', () => {
    const prompt = loadPrompt(versions.currentTextStagePromptPath('imageSupplement'), {});
    const example = JSON.parse(prompt.slice(prompt.indexOf('{\n  "insertions"'), prompt.indexOf('\n\n字段规则：')));
    const insertion = example.insertions[0];
    assert.match(insertion.lead, /下图/);
    assert.match(insertion.explanation, /图中/);
    assert.doesNotMatch(insertion.explanation, /下图/);
    assert.equal(validateImageNarrativeContext(insertion.lead, insertion.explanation), null);
});

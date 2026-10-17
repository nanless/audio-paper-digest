'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const filename = require.resolve('../scripts/lib/conference-filter.js');
// Test private selection without making a second public issuance API.
const compiled = new Module(filename, module);
compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + `\nmodule.exports.privatePromptTest = {
    renderDeclaredDailyFilterPrompt, dailyFilterPromptMatches, promptFields,
    LLM_FILTER_PROMPT_SHA256, DECLARED_FROZEN_FILTER_PROMPTS, HISTORICAL_FILTER_PROMPT_ARCHIVES
};`, filename);
const api = compiled.exports.privatePromptTest;
const utils = require('../scripts/utils.js');
const history = require('../scripts/lib/prompt-history.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const envelope = declared => ({ filter: { promptSha256: declared }, discovery: { conference: { id: 'interspeech-2026' } },
    metadataRecord: { title: '标题{abstract}', abstract: '摘要{categories}', categories: ['cs.SD', 'cs.SD'], track: 'Speech' } });

test('当前及四个冻结声明走唯一 resolver，逐字保留原字段填充和错误版本隔离', () => {
    const current = require('../scripts/lib/prompt-text-versions.js').LLM_FILTER_PROMPT_PATH;
    const cases = [{ sha256: api.LLM_FILTER_PROMPT_SHA256, path: current }, ...api.DECLARED_FROZEN_FILTER_PROMPTS];
    for (const entry of cases) {
        const bound = envelope(entry.sha256);
        const expected = utils.loadPrompt(entry.path, api.promptFields(bound));
        assert.equal(api.renderDeclaredDailyFilterPrompt(bound), expected);
        assert.equal(api.dailyFilterPromptMatches(expected, bound), true);
        assert.equal(api.dailyFilterPromptMatches(expected + '\nchanged', bound), false);
    }
    const unknown = envelope('f'.repeat(64));
    assert.throws(() => api.renderDeclaredDailyFilterPrompt(unknown), /没有登记/);
    assert.equal(api.dailyFilterPromptMatches('arbitrary', unknown), false);
});

test('已登记 v2-v4 冻结正文漂移同时阻断发行和重放，保留 v1 既有检查职责', t => {
    const original = utils.loadPrompt;
    const frozen = api.DECLARED_FROZEN_FILTER_PROMPTS.find(entry => entry.checkSha);
    const mocked = t.mock.method(utils, 'loadPrompt', (file, fields) =>
        file === frozen.path ? original(file, fields) + 'changed' : original(file, fields));
    assert.throws(() => api.renderDeclaredDailyFilterPrompt(envelope(frozen.sha256)), /没有登记|已变化/);
    assert.equal(api.dailyFilterPromptMatches('arbitrary', envelope(frozen.sha256)), false);
    mocked.mock.restore();
    assert.equal(api.DECLARED_FROZEN_FILTER_PROMPTS[0].checkSha, false);
});

test('真实归档只能核旧请求；单次替换不展开来源花括号，缺失或篡改归档拒绝', t => {
    const [declared, wholeSha] = Object.entries(api.HISTORICAL_FILTER_PROMPT_ARCHIVES)[0];
    const bytes = history.historicalPromptBytesForSha256(wholeSha);
    assert.ok(bytes);
    const block = bytes.toString('utf8').match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m)[2];
    assert.equal(sha(block), declared);
    const bound = envelope(declared), fields = api.promptFields(bound);
    const expected = block.replace(/\{(?:title|abstract|categories)\}/g,
        token => String(fields[token.slice(1, -1)]));
    assert.equal(api.dailyFilterPromptMatches(expected, bound), true);
    assert.ok(expected.includes('标题{abstract}'));
    assert.ok(expected.includes('摘要{categories}'));
    assert.throws(() => api.renderDeclaredDailyFilterPrompt(bound), /没有登记/);
    const mocked = t.mock.method(history, 'historicalPromptBytesForSha256', () => null);
    assert.equal(api.dailyFilterPromptMatches(expected, bound), false);
    mocked.mock.mockImplementation(() => Buffer.from('```text\nchanged\n```'));
    assert.equal(api.dailyFilterPromptMatches(expected, bound), false);
    mocked.mock.mockImplementation(() => Buffer.from('no fenced template'));
    assert.equal(api.dailyFilterPromptMatches(expected, bound), false);
});

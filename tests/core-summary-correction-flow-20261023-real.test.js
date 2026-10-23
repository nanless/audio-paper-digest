'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module); compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.flowObservations=typeof sourceBoundCorrectionRateObservations === "function" ? sourceBoundCorrectionRateObservations : () => [];', filename);
const api = compiled.exports;
const fixture = require('./fixtures/core-summary-correction-flow-20261023-real.json');
const sourceRow = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/structure-checkpoint-20261023-real.json.gz')))).papers.find(row => row.paperId === '2610.30385');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const noModel = fn => () => stop.withModelRequestsForbidden(fn);
const summary = text => text.replace(/^## 核心摘要\s*/u, '').trim();
const latest = summary(fixture.responses[2].scientificSummary);
const observed = (text = latest, source = sourceRow.sourceText) => api.flowObservations(text, source).filter(Boolean);
const family = (text, kind, source) => observed(text, source).filter(row => row.kind === kind);

test('三份完整原付费摘要与复用封存source原SHA，不复制请求或费用包', noModel(() => {
    assert.equal(fixture.responses.length, 3);
    assert.equal(fixture.notGrant, true); assert.equal(fixture.adoptionAuthorized, false);
    assert.equal(sha(sourceRow.sourceText), fixture.sourceTextSha256);
    for (const row of fixture.responses) assert.equal(sha(row.scientificSummary), row.scientificSummarySha256);
}));
for (const [index, row] of fixture.responses.entries()) test('完整真实核心摘要 ' + (index + 1) + ' 正常语义契约保留原率指标和方向', noModel(() => {
    assert.equal(api.validateCoreSummarySemanticContract(row.scientificSummary, { sourceText: sourceRow.sourceText }), null);
    const rows = observed(summary(row.scientificSummary));
    assert.deepEqual(rows.map(row => row.kind), ['break-rate', 'rep']);
    assert.deepEqual(rows.map(row => [row.from, row.to]), [[12.8, 2.3], [2.06, 3.31]]);
    assert.ok(rows.every(row => row.metric && row.direction));
}));

test('当前句group/model/medical/分母/measure端点/方向缺失不能由版本数字或别指标补齐', noModel(() => {
    const cases = [
        ['break-rate', '自我修正设置', '跨系统设置'],
        ['break-rate', '破坏率break-rate', '破坏分量dam'],
        ['break-rate', '破坏率break-rate', '破坏率break-rate模型'],
        ['break-rate', '为12.8%', '为12.9%'],
        ['break-rate', '为12.8%', '为'],
        ['break-rate', '降至2.3%', '降至2.3 pt'],
        ['break-rate', '降至2.3%', '升至2.3%'],
        ['rep', '修复分量rep占参考词元比例', '插入分量ins占参考词元比例'],
        ['rep', '修复分量rep占参考词元比例', '修复分量rep模型占参考词元比例'],
        ['rep', '占参考词元比例', '占无错输入比例'],
        ['rep', '为2.06%', '为2.07%'],
        ['rep', '为2.06%', '为'],
        ['rep', '升至3.31%', '降至3.31%'],
        ['rep', '相对增加61%', '相对增加60%']
    ];
    for (const [kind, from, to] of cases) {
        assert.ok(latest.includes(from));
        assert.equal(family(latest.replace(from, to), kind).length, 0, from + ' → ' + to);
    }
    for (const replacement of ['Gemini 2.6 Flash', 'Other-Model']) {
        const changed = latest.replaceAll('Gemini 2.5 Flash', replacement);
        assert.equal(observed(changed).length, 0);
    }
    assert.equal(observed(latest.replaceAll('医疗听写', '合成俄语')).length, 0);
}));

test('无model的rep只承接紧邻同source的实际primary观察，不跨标题或外部归属', noModel(() => {
    const text = summary(fixture.responses[0].scientificSummary);
    assert.equal(family(text, 'rep').length, 1);
    const breakSentence = text.split('。').find(line => line.includes('12.8%'));
    const repSentence = text.split('。').find(line => line.includes('2.06%'));
    assert.ok(breakSentence && repSentence);
    assert.equal(family(text.replace(breakSentence + '。', ''), 'rep').length, 0);
    assert.equal(family(text.replace('Gemini 2.5 Flash', 'Other-Model'), 'rep').length, 0);
    assert.equal(family(text.replace(repSentence, '第三方研究：\n\n' + repSentence), 'rep').length, 0);
    assert.equal(family(text.replace(repSentence, '### 本文另一个独立实验： ###\n\n' + repSentence), 'rep').length, 0);
}));

test('新率观察不接假设/否定/外部标题，也不从普通rep/dam/ins方法名授权', noModel(() => {
    for (const marker of ['假设', '并非', '第三方研究：', '### 第三方研究： ###\n\n', '__Previous work:__\n\n']) {
        const changed = latest.replace('在自我修正设置下', marker + '在自我修正设置下')
            .replace('在跨系统设置下', marker + '在跨系统设置下');
        assert.equal(observed(changed).length, 0, marker);
    }
    assert.equal(observed('在公开测试集上，rep模型从2.06%升至3.31%，dam模型从12.8%降至2.3%。').length, 0);
    assert.equal(observed('在公开测试集上，ins=2.06%，break-rate=2.3%。').length, 0);
}));

test('source定义/原同组观测/标量双呈现/原表变更均不准借旧率值', noModel(() => {
    for (const [from, to] of [
        ['rates are in % of reference tokens', 'rates are in % of input tokens'],
        ['2.062.06%', '2.062.07%'], ['3.313.31%', '3.313.32%'],
        ['61% relative increase', '60% relative increase'],
        ['12.8% of the error-free drafts', '12.9% of the error-free drafts'],
        ['12.8\u2009→\\to\u20092.3', '12.9\u2009→\\to\u20092.3'],
        ['primary corrector is Gemini 2.5 Flash', 'primary corrector is Other-Model'],
        ['4.2 Repair, damage and break-rate', 'Previous work:\n4.2 Repair, damage and break-rate'],
        ['On medical dictation it goes from', 'Hypothetical experiment.\nOn medical dictation it goes from'],
        ['On medical dictation it goes from', '\n4.2.1 Independent experiment\nOn medical dictation it goes from']
    ]) {
        assert.ok(sourceRow.sourceText.includes(from), from);
        const result = observed(latest, sourceRow.sourceText.replace(from, to));
        if (/2\.06|3\.31|relative|On medical/u.test(from)) assert.equal(result.some(row => row.kind === 'rep'), false, from);
        else if (/12\.8/u.test(from)) assert.equal(result.some(row => row.kind === 'break-rate'), false, from);
        else assert.equal(result.length, 0, from);
    }
}));

test('非法source相对百分比精度不抛RangeError也不授率观察', noModel(() => {
    const changed = sourceRow.sourceText.replace('61% relative increase', '61.' + '0'.repeat(101) + '% relative increase');
    assert.doesNotThrow(() => observed(latest, changed));
    assert.equal(family(latest, 'rep', changed).length, 0);
}));

test('率观察由source实际primary派生，不用固定模型名授权', noModel(() => {
    const primary = /primary corrector is ([^\n\[]+)\s*\[/u.exec(sourceRow.sourceText)[1].trim();
    const replacement = 'Source-Bound-Corrector-7.4';
    const changedSource = sourceRow.sourceText.replaceAll(primary, replacement);
    const changedSummary = latest.replaceAll(primary, replacement);
    assert.deepEqual(observed(changedSummary, changedSource).map(row => row.kind), ['break-rate', 'rep']);
    assert.equal(observed(changedSummary).length, 0);
}));

test('来源表caption邻接第三方/假设标题不能给本实验两率授权', noModel(() => {
    for (const notice of ['Previous work:', 'Hypothetical experiment:', '### Previous work: ###', '__Hypothetical experiment:__']) {
        const changed = sourceRow.sourceText.replace('Table 2: Effect of the audio', notice + '\n\nTable 2: Effect of the audio');
        assert.equal(observed(latest, changed).length, 0, notice);
    }
}));

test('率观察的下一局部撤回声明保肯定极性与Markdown壳，不借否定或条件误撤回', noModel(() => {
    const anchor = latest.split('。').find(value => value.includes('12.8%'));
    const neutralized = latest.replace(/在跨系统设置下医疗听写上[^。]+/u, '跨系统部分保留原背景描述');
    for (const [claim, expected] of [
        ['上述破坏率结果已撤回', false], ['上述破坏率观察不成立', false],
        ['上述破坏率结果并未撤回', true], ['上述破坏率结果没有撤回', true],
        ['上述破坏率结果并无错误', true], ['上述破坏率结果未被否认', true],
        ['假设上述破坏率结果已撤回', true], ['若上述破坏率结果已撤回', true],
        ['倘若上述破坏率结果已撤回', true], ['假如上述破坏率结果已撤回', true],
        ['上述破坏率结果并未撤回，但该破坏率结果已被否认', false],
        ['假设上述破坏率结果已撤回，但该破坏率结果已被否认', false],
        ['其他实验的结果已撤回', true]
    ]) for (const wrap of [value => value, value => '**' + value + '。**', value => '### __' + value + '。__ ###']) {
        const changed = neutralized.replace(anchor, anchor + '。\n\n' + wrap(claim));
        assert.equal(family(changed, 'break-rate').length === 1, expected, claim);
        if (!expected) assert.notEqual(api.validateCoreSummarySemanticContract('## 核心摘要\n' + changed, {sourceText: sourceRow.sourceText}), null);
    }
}));

test('source group和primary实际事实自身的假设或外部归属不能由section标题洗掉', noModel(() => {
    for (const anchor of ['C and A correct the draft', 'primary corrector is Gemini 2.5 Flash']) {
        for (const prefix of ['Hypothetical experiment: ', 'According to previous work: ']) {
            const changed = sourceRow.sourceText.replace(anchor, prefix + anchor);
            assert.equal(observed(latest, changed).length, 0, anchor + ' / ' + prefix);
        }
    }
}));

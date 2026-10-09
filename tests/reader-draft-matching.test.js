'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const api = require('../scripts/lib/reader-draft-order');
const table = value => `| Method | WER |\n|---|---|\n| Baseline | ${value} |`;
const binding = (tableIndex, quotes) => ({ tableIndex, sourceType: 'source_quotes', sourceQuotes: quotes });
function draft(tables, bindings) {
    return { sections: [{ kind: 'result', heading: '结果', body: tables.join('\n\n') },
        { kind: 'background', heading: '背景', body: '原文背景。' }], tableBindings: bindings, conceptBridges: [] };
}
test('12 张同分小表不再穷举排列，公开排序入口及时返回且不猜来源对应', () => {
    const script = `const api=require(${JSON.stringify(require.resolve('../scripts/lib/reader-draft-order'))});
const n=12, table=${JSON.stringify(table('10.2'))};
const input=${JSON.stringify(draft([], []))};
input.sections[0].body=Array(n).fill(table).join('\\n\\n');
input.tableBindings=Array.from({length:n},(_,i)=>({tableIndex:i+1,sourceType:'source_quotes',sourceQuotes:['Baseline achieved WER 10.2.']}));
const result=api.normalizeReaderDraftOrder(input);process.stdout.write(JSON.stringify(result.draft));`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.error, undefined, '真实恢复入口不能在排列搜索中超时');
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sections[0].kind, 'background');
    assert.equal(output.tableBindings.length, 12);
    const original = draft(Array(12).fill(table('10.2')), Array.from({length:12},(_,i)=>binding(i+1,['Baseline achieved WER 10.2.'])));
    const before=structuredClone(original);
    assert.equal(api.alignSourceQuoteBindingsToCurrentTableNodes(original, api.locateReaderDraftTables(original)), false);
    assert.deepEqual(original, before);
});
test('12 张表都有候选时仍找出唯一最佳对应，不因限额误拒或取第一组', () => {
    const tables=Array.from({length:12},(_,i)=>table(100+i));
    const bindings=Array.from({length:12},(_,i)=>binding(i+1,['Baseline Method',tables[(i+5)%12]]));
    const input=draft(tables,bindings);
    assert.equal(api.alignSourceQuoteBindingsToCurrentTableNodes(input,api.locateReaderDraftTables(input)),true);
    assert.deepEqual(input.tableBindings.map(item=>item.sourceQuotes[1]),tables);
    assert.equal(input.sections[0].body,tables.join('\n\n'));
});
test('最大权匹配不能贪心抢占另一条绑定唯一可用的表格', () => {
    const first='| alpha | beta |\n|---|---|\n| gamma | delta |';
    const second='| alpha | beta |\n|---|---|\n| epsilon | zeta |';
    const input=draft([first,second],[binding(1,['alpha beta gamma']),binding(2,['gamma delta'])]);
    assert.equal(api.alignSourceQuoteBindingsToCurrentTableNodes(input,api.locateReaderDraftTables(input)),true);
    assert.deepEqual(input.tableBindings.map(item=>item.sourceQuotes[0]),['gamma delta','alpha beta gamma']);
});
test('每条绑定有候选但无法构成完整一一对应时保留原草稿', () => {
    const input=draft([table('100'),table('200')],[binding(1,['Baseline WER 100.']),binding(2,['Baseline WER 100.'])]);
    const before=structuredClone(input);
    assert.equal(api.alignSourceQuoteBindingsToCurrentTableNodes(input,api.locateReaderDraftTables(input)),false);
    assert.deepEqual(input,before);
});

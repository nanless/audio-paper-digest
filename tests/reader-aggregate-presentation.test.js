'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderReaderAggregatePresentations: display } = require('../scripts/lib/reader-aggregate-presentation.js');
const { validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture.js');

const resultFor = records => ({ readerPresentations: records.map(item => ({
    paperKey: item.paperKey, summary: '摘要', resourceBlock: '资源', scoringBlock: '评分说明', scoreLine: '8/10'
})) });

test('汇总共享展示真实有界桥只返回文本，不改原分析、计划或资源', () => {
    const paper = validLegacyApiAnalysisPaper('2608.00001');
    const sourceText = 'Synthetic source for display-only legacy fallback.';
    paper.sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    paper.apiReaderPlan.oneSentenceThesis = '来源绑定的简要说明。';
    const records = [{ paperKey: 'arxiv:2608.00001', paper, sourceText, resources: paper.apiReaderResources.resources }];
    const before = JSON.stringify(records);
    const output = display(records);
    assert.equal(output.length, 1);
    assert.equal(output[0].summary, paper.apiReaderPlan.oneSentenceThesis);
    assert.match(output[0].scoreLine, /工程\/实践 \d\.\d\/1.5/);
    assert.match(output[0].scoringBlock, /系统判断/);
    assert.match(output[0].resourceBlock, /不代表许可证/);
    assert.deepEqual(Object.keys(output[0]).sort(), ['paperKey', 'resourceBlock', 'scoreLine', 'scoringBlock', 'summary']);
    assert.equal(JSON.stringify(records), before);
});

test('完整成员按8篇有界分组，后组失败不能返回前组部分成功', () => {
    const records = Array.from({ length: 17 }, (_, index) => ({ paperKey: `paper:${index}` }));
    const calls = [];
    const values = display(records, { render: packet => {
        calls.push(packet.aggregatePresentationBatch.length);
        return resultFor(packet.aggregatePresentationBatch);
    } });
    assert.deepEqual(calls, [8, 8, 1]);
    assert.deepEqual(values.map(item => item.paperKey), records.map(item => item.paperKey));
    let count = 0;
    assert.throws(() => display(records, { render: packet => {
        if (++count === 3) throw new Error('last batch failure');
        return resultFor(packet.aggregatePresentationBatch);
    } }), /last batch failure/);
    assert.equal(count, 3);
});

test('未知资格字段、错项、漏项、空文本和重复成员均拒绝', () => {
    const records = [{ paperKey: 'paper:one' }, { paperKey: 'paper:two' }];
    for (const mutate of [
        result => { result.eligible = true; },
        result => { result.readerPresentations.reverse(); },
        result => { result.readerPresentations.pop(); },
        result => { result.readerPresentations[0].summary = ''; },
        result => { result.readerPresentations[0].verified = true; },
    ]) assert.throws(() => display(records, { render: packet => {
        const result = resultFor(packet.aggregatePresentationBatch); mutate(result); return result;
    } }));
    assert.throws(() => display([records[0], records[0]]));
    assert.throws(() => display([]));
});

test('按真实UTF8包大小提前分组，不降低既有传输上限', () => {
    const payload = 'x'.repeat(9 * 1024 * 1024);
    const records = Array.from({ length: 8 }, (_, index) => ({ paperKey: `large:${index}`, payload }));
    const sizes = [];
    display(records, { render: packet => {
        sizes.push(packet.aggregatePresentationBatch.length);
        assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 64 * 1024 * 1024);
        return resultFor(packet.aggregatePresentationBatch);
    } });
    assert.deepEqual(sizes, [7, 1]);
});

test('会议与历史当前实现闭包均绑定共享展示桥及实际Python叶子', () => {
    const root = path.resolve(__dirname, '..');
    const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files.js');
    for (const entry of ['scripts/lib/conference-postprocess.js', 'scripts/lib/historical-direct-aggregate.js']) {
        const files = collectWorkflowImplementationFiles({ root, entryFiles: [entry] });
        for (const leaf of ['scripts/lib/reader-aggregate-presentation.js',
            'scripts/paper_reader_presentation.py', 'scripts/lib/python-json-packet-bridge.js']) {
            assert.ok(files.includes(leaf), `${entry}: ${leaf}`);
        }
    }
});

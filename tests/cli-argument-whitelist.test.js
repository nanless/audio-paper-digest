'use strict';

// batch/reanalyze 的严格参数白名单。以前未知 --flag 会被静默忽略，例如把
// --retry-failed-readers 少写一个 s，程序照常跑普通批量，用户以为重试生效。
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReanalyzeCliArgs } = require('../scripts/lib/reanalysis-helpers.js');
const batchAnalyze = require('../scripts/batch-analyze.js');
const { assertKnownBatchAnalyzeArguments } = batchAnalyze;

test('reanalyze 只接受 --concurrency 和单个数据文件', () => {
    assert.deepEqual(parseReanalyzeCliArgs([]), { concurrency: undefined, dataFile: undefined });
    assert.deepEqual(parseReanalyzeCliArgs(['--concurrency', '5', 'file.json']),
        { concurrency: '5', dataFile: 'file.json' });
    assert.deepEqual(parseReanalyzeCliArgs(['data.json']),
        { concurrency: undefined, dataFile: 'data.json' });
    assert.throws(() => parseReanalyzeCliArgs(['--retry-failed-reader']),
        /未知参数: --retry-failed-reader[\s\S]*用法: npm run reanalyze/);
    assert.throws(() => parseReanalyzeCliArgs(['--concurrency']), /--concurrency 缺少参数值/);
    assert.throws(() => parseReanalyzeCliArgs(['--concurrency', '1', '--concurrency', '2']),
        /参数不能重复: --concurrency/);
    assert.throws(() => parseReanalyzeCliArgs(['a.json', 'b.json']), /多余的位置参数: b.json/);
});

test('batch 拒绝拼错的 Reader 重试开关，同时保留既有合法参数', () => {
    assert.doesNotThrow(() => assertKnownBatchAnalyzeArguments([]));
    assert.doesNotThrow(() => assertKnownBatchAnalyzeArguments([
        '--retry-failed-readers', '--reader-retry-manifest', '/tmp/manifest.json',
        '--refresh-reader-diagnostics'
    ]));
    assert.doesNotThrow(() => assertKnownBatchAnalyzeArguments([
        '--fact-feedback-file', '/tmp/a.json', '--fact-feedback-file', '/tmp/b.json'
    ]));
    assert.throws(() => assertKnownBatchAnalyzeArguments(['--retry-failed-reader']),
        /未知参数: --retry-failed-reader[\s\S]*用法: npm run batch/);
    assert.throws(() => assertKnownBatchAnalyzeArguments(['--reader-retry-manifest']),
        /--reader-retry-manifest 缺少参数值/);
    assert.throws(() => assertKnownBatchAnalyzeArguments([
        '--reader-retry-manifest', 'a.json', '--reader-retry-manifest', 'b.json'
    ]), /参数不能重复: --reader-retry-manifest/);
    assert.throws(() => assertKnownBatchAnalyzeArguments(['extra.json']), /多余的位置参数: extra.json/);
});

test('batch main 在读取结果文件前拒绝未知参数', async () => {
    const originalArgv = [...process.argv];
    process.argv.push('--retry-failed-reader');
    try {
        await assert.rejects(batchAnalyze.main(), /未知参数: --retry-failed-reader/);
    } finally {
        process.argv.splice(0, process.argv.length, ...originalArgv);
    }
});

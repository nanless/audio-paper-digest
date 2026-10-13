'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
// 只给测试暴露真实私有计数函数；不修改正式模块的导出或其他校验。
const filename = path.resolve(__dirname, '../scripts/deep-analyzer.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testQualityMetrics = buildApiReaderQualityMetrics;', filename);
const metrics = loaded.exports.testQualityMetrics;
const body = '回放池五千八到八千九对而随机对有一万九千九百对。';
const quality = { issues: [{ code: 'quantitative_chinese_numeral', match: '八千九对', index: body.indexOf('八千九对'), reason: 'measured_large_integer' }], warnings: [] };
const source = 'replay buffer 5.8k to 8.9k pairs against 19.9k random pairs.';

test('来源支持的数量在持久质量计数中与解析阻断判断一致', () => {
    assert.equal(metrics(quality, body, { sourceText: source }).blockingIssueCount, 0);
    assert.equal(metrics(quality, body, { sourceText: source }).waivedIssueCount, 1);
});
test('缺来源、错误数量和明确未评估仍计为真实阻断', () => {
    for (const evidence of [null, { sourceText: source.replace('8.9k', '8.009k') }, { sourceText: source.replace(/\.$/, ' was not evaluated.') }]) {
        assert.equal(metrics(quality, body, evidence).blockingIssueCount, 1);
    }
});

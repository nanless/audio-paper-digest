'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { manualSha256 } = require('../scripts/analysis-contract');

const PROJECT = path.resolve(__dirname, '..');

// Node 与 Python 对同一份数据算哈希，靠两条隐含前提：键都是字符串且在 BMP 内，
// 数字在 json.dumps 的 repr 与 ECMAScript 的写法下一致。前提一旦失效，两端不报错，
// 只会算出两个不同的哈希，最后表现为一句莫名其妙的 SHA 不一致。下面每条前提给一个
// 反例，确认它真的抛错；再给一组正常值，确认断言没有误伤合法数据。
function pythonChecks() {
    const script = [
        'import json,sys',
        'sys.path.insert(0,"scripts")',
        'from publish_common import (_manual_hash, _assert_hash_key_premises,',
        '    _assert_ecmascript_number_premises)',
        'def run(fn):',
        '    try:',
        '        fn(); return "no-throw"',
        '    except Exception as error: return type(error).__name__ + ": " + str(error)',
        'print(json.dumps({',
        '    "nonStringKey": run(lambda: _manual_hash({1: "a"})),',
        '    "nonBmpKey": run(lambda: _manual_hash({chr(0x1F600): 1})),',
        '    "nestedNonBmpKey": run(lambda: _assert_hash_key_premises({"outer": {chr(0x1F642): 2}}, "x")),',
        '    "integerFloat": run(lambda: _assert_ecmascript_number_premises({"value": 1.0}, "x")),',
        '    "tinyFloat": run(lambda: _assert_ecmascript_number_premises({"value": 0.00002}, "x")),',
        '    "negativeZero": run(lambda: _assert_ecmascript_number_premises({"value": -0.0}, "x")),',
        '    "hugeFloat": run(lambda: _assert_ecmascript_number_premises({"value": 1e17}, "x")),',
        '    "unsafeInteger": run(lambda: _assert_ecmascript_number_premises({"value": 2 ** 53}, "x")),',
        '    "normalManualSha": _manual_hash({"a": 1, "b": [1, 2.5, None, True]}),',
        '    "normalGuard": run(lambda: (_assert_hash_key_premises({"\u4f5c\u8005": 1}, "x"),',
        '        _assert_ecmascript_number_premises({"score": 2.5, "count": 3}, "x"))),',
        '}, ensure_ascii=False))',
    ].join('\n');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
        cwd: PROJECT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000,
    });
    assert.equal(result.error, undefined, `无法启动 Python：${result.error?.message}`);
    assert.equal(result.status, 0, `Python 前提断言检查失败：${result.stderr}`);
    return JSON.parse(result.stdout);
}

test('哈希前提断言：键或数字违反跨语言前提就抛错，正常值不受影响', () => {
    const checks = pythonChecks();
    for (const name of ['nonStringKey', 'nonBmpKey', 'nestedNonBmpKey',
        'integerFloat', 'tinyFloat', 'negativeZero', 'hugeFloat', 'unsafeInteger']) {
        assert.match(checks[name], /^PublishDataValidationError: /,
            `${name} 必须抛出可诊断的 PublishDataValidationError，实际是 ${checks[name]}`);
    }
    assert.match(checks.nonStringKey, /对象键必须是字符串/);
    assert.match(checks.nonBmpKey, /BMP 以外/);
    assert.match(checks.integerFloat, /Python 写 1\.0，Node 写 1/);
    assert.match(checks.hugeFloat, /Python 写 1e\+17，Node 写 100000000000000000/);
    assert.equal(checks.normalGuard, 'no-throw', '正常键与数字不能被断言挡住');
    assert.equal(checks.normalManualSha, manualSha256({ a: 1, b: [1, 2.5, null, true] }),
        '正常输入的 Node 与 Python manual 哈希必须仍然相等');
});

test('哈希前提断言：Node 侧挡住非 BMP 键，BMP 内的中文键仍可哈希', () => {
    assert.throws(() => manualSha256({ '\u{1F600}': 1 }), /BMP 以外/);
    assert.throws(() => manualSha256({ outer: { '\u{1F642}': 2 } }), /BMP 以外/);
    assert.equal(manualSha256({ 作者: 1 }).length, 64);
});

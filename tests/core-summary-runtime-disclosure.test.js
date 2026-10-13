'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const runtime = new Module(filename, module);
runtime.filename = filename;
runtime.paths = Module._nodeModulePaths(path.dirname(filename));
runtime._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.runtime = hasConcreteRuntimeDisclosure;', filename);

const accepted = [
    '两分支独立训练，推理需两次经过共享编码器的提示条件前向。',
    '推理执行2次前向计算。',
    '推理时间（秒/文件）为7.65，低于T5的25.74。',
    '训练每轮时间为2:37。',
    '推理时间为0:08。'
];
const rejected = [
    '推理未执行2次前向计算。',
    '推理未进行两次前向。',
    '推理只讨论需要2次前向的假说。',
    '推理需两次人工确认并进行前向。',
    '推理需两次重置缓存然后另一基线进行前向计算。',
    '推理需两次人工确认，独立分类器只做一次前向。',
    '推理需两次重置缓存，另一基线进行前向计算。',
    '推理经过共享编码器。',
    '训练集有2个前向视角。',
    '可能推理需两次前向。',
    '没有推理需两次前向的结果。',
    '推理不需两次前向。',
    '推理无需2次前向。',
    '推理时间没有报告。',
    '推理时间为7.65。',
    '推理时间为2:87。',
    '推理时间（准确率）为7.65。',
    '推理时间（秒/文件）为７.６５。',
    '未来推理时间（秒/文件）为7.65。'
];

test('明确前向次数、时间口径或分秒值可表达运行负担', () => {
    for (const sentence of accepted) assert.equal(runtime.exports.runtime(sentence), true, sentence);
});

test('否定、假设、无单位数字和非法时间不能充当成本说明', () => {
    for (const sentence of rejected) assert.equal(runtime.exports.runtime(sentence), false, sentence);
});

test('发布端对同一组运行说明作出一致判断', () => {
    const script = String.raw`import ast, json, re, sys
from pathlib import Path
source = Path('scripts/publish-to-blog.py')
tree = ast.parse(source.read_text())
function = next(node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == '_has_concrete_runtime_disclosure')
environment = {'re': re}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), environment)
print(json.dumps([environment[function.name](sentence) for sentence in json.load(sys.stdin)]))`;
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
        cwd: path.resolve(__dirname, '..'),
        input: JSON.stringify([...accepted, ...rejected]),
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
        ...accepted.map(() => true), ...rejected.map(() => false)
    ]);
});

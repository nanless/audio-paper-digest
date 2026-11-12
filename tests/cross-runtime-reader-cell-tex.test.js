'use strict';

// 同一个表格单元格显示投影在 Node（scripts/lib/reader-source-display.js）和
// Python 发布端（scripts/publish-to-blog.py）各有一份实现。2026-11-12 的
// 真实事故就是只改了一侧：共享语料 `reader-cell-tex-display.json` 与实现脱节，
// 而两边的消费测试分别跑在不同套件里，没有一条测试同时核对两份实现。
//
// 本测试从 Node 侧调用 Python 公开入口，对同一份共享语料逐条比较两侧输出。
// 任何一侧单独漂移都会在这里变红，并打印语料、Node 结果与 Python 结果。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { projectReaderCellTexDisplay } = require('../scripts/lib/reader-source-display.js');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'reader-cell-tex-display.json');
const parity = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const PYTHON_PROBE = String.raw`
import json
import sys
from pathlib import Path

root = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(root / 'scripts'))
sys.path.insert(0, str(root / 'tests' / 'python'))

from project_env_isolation import project_env_scope
from blog_entry_loader import load_publish_to_blog

with project_env_scope():
    publish = load_publish_to_blog()

values = json.loads(sys.argv[1])
sys.stdout.write(json.dumps(
    [publish._project_reader_cell_tex_display(value) for value in values],
    ensure_ascii=False,
))
`;

let cachedPython = null;

function pythonProjections(values) {
    if (!cachedPython) {
        const result = spawnSync('bash',
            ['scripts/python-runtime.sh', '-c', PYTHON_PROBE, JSON.stringify(values), ROOT], {
                cwd: ROOT,
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
            });
        assert.equal(result.status, 0,
            `Python 发布端投影探针失败（退出码 ${result.status}）：`
            + `${String(result.stderr || result.error?.message || '').trim()}`);
        let payload;
        try {
            payload = JSON.parse(result.stdout);
        } catch (error) {
            assert.fail(`Python 投影探针输出不是 JSON：${error.message}\n`
                + String(result.stdout).slice(0, 2000));
        }
        assert.ok(Array.isArray(payload), 'Python 投影探针缺少结果数组');
        assert.equal(payload.length, values.length,
            `Python 投影探针返回 ${payload.length} 条，预期 ${values.length} 条`);
        cachedPython = payload;
    }
    return cachedPython;
}

function describe(value) {
    return JSON.stringify(value);
}

test('共享语料结构完整，并覆盖匿名宏与数值去重守卫', () => {
    assert.equal(parity.contract, 'reader-cell-tex-display-parity-v1');
    assert.ok(parity.cases.length >= 60,
        `共享语料只有 ${parity.cases.length} 条，至少需要 60 条才能覆盖既定类别`);
    const inputs = parity.cases.map(item => item.input);
    const unique = new Set(inputs);
    assert.equal(unique.size, inputs.length, '共享语料存在重复 input');
    for (const item of parity.cases) {
        assert.equal(typeof item.input, 'string', `语料 input 不是字符串：${describe(item)}`);
        assert.equal(typeof item.expected, 'string', `语料 expected 不是字符串：${describe(item)}`);
        assert.ok(item.input.length > 0, '语料 input 不能为空');
    }
    // 2026-11-12 的审查阻断里有很大一部分来自匿名投稿自定义宏；语料必须
    // 持续覆盖「方括号匿名写法 + 紧跟真实单词」这条替换规则。
    assert.ok(inputs.some(input => input.includes('\\anon[')),
        '共享语料缺少匿名宏案例（\\anon[匿名写法]真名）');
    // 55/99/22 是正常数值，2020/2021 是年份；都不能被「重复写了两遍」折叠。
    for (const guard of ['55', '99', '22', '2020', '2021']) {
        assert.ok(inputs.includes(guard), `共享语料缺少数值/年份守卫：${guard}`);
    }
    for (const duplicate of ['6464', '1616', '3232', '100100']) {
        assert.ok(inputs.includes(duplicate), `共享语料缺少重复数值折叠案例：${duplicate}`);
    }
    assert.ok(inputs.some(input => input.includes('{,}')),
        '共享语料缺少千位分隔 TeX 案例');
    // 2026-11-12 只改了 Python 的 \varnothing 等符号表，Node 侧漏改，导致同一
    // 单元格在发布端能投影、在渲染端残留裸 TeX。符号双写与不同命令负例必须常在。
    for (const input of ['∅\\varnothing', '∘\\circ', '⋆\\star']) {
        const item = parity.cases.find(candidate => candidate.input === input);
        assert.ok(item, `共享语料缺少符号双写案例：${input}`);
        assert.equal(item.expected, input[0], `${input} 应投影成可见符号`);
    }
    assert.ok(inputs.includes('∅\\circ'),
        '共享语料缺少“可见符号 + 不同命令”负例（应保留裸 TeX 交由闸门拒绝）');
    // 整格可见文字后跟 {}_{}^{} 上下标副本：只丢副本，保留可见正文。
    assert.ok(inputs.includes('vv-MF∅CFGmSTFT{}_{\\mathrm{mSTFT}}^{\\varnothing\\mathrm{CFG}}'),
        '共享语料缺少 {}_{}^{} 双写副本案例');
    assert.equal(parity.cases.find(candidate => candidate.input
        === 'vv-MF∅CFGmSTFT{}_{\\mathrm{mSTFT}}^{\\varnothing\\mathrm{CFG}}').expected,
    'vv-MF∅CFGmSTFT');
});

test('Node 侧投影与共享语料逐条一致，未知命令保持原样', () => {
    for (const item of parity.cases) {
        assert.equal(projectReaderCellTexDisplay(item.input), item.expected, item.input);
    }
    for (const input of ['k=\\tilde{k}', 'FD\\mathrm{FD_{norm}}', '\\unknowncommand']) {
        assert.ok(projectReaderCellTexDisplay(input).includes('\\'), input);
    }
});

test('同一条共享语料在 Node 与 Python 两侧得到同一投影', () => {
    const inputs = parity.cases.map(item => item.input);
    const nodeValues = inputs.map(input => projectReaderCellTexDisplay(input));
    const pythonValues = pythonProjections(inputs);
    const divergences = [];
    for (let index = 0; index < inputs.length; index += 1) {
        if (nodeValues[index] === pythonValues[index]) continue;
        divergences.push([
            `语料：${describe(inputs[index])}`,
            `期望：${describe(parity.cases[index].expected)}`,
            `Node：${describe(nodeValues[index])}`,
            `Python：${describe(pythonValues[index])}`,
        ].join('\n'));
    }
    assert.deepEqual(divergences, [],
        `Node 与 Python 的单元格 TeX 投影不一致（${divergences.length} 条）：\n`
        + divergences.join('\n\n'));
});

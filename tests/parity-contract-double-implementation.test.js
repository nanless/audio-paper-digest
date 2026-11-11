'use strict';

// 「双实现」对照测试（Node 侧）。
//
// 同一个发布规则在 Node 与 Python 各写一份实现，历史上一侧改了另一侧没跟上，
// 就会变成新的发布阻断。本测试用同一批语料分别调用两侧公开入口，断言结论一致；
// 不一致时打印「哪条语料、Node 结果、Python 结果」。
//
// 现状（2026-11-12）：最初登记的 13 条两侧分歧已修 12 条；剩 1 条排名类推文
// （Python 自 2026-09-01 起故意允许自然序数名次，Node exact_rank 未同步）。
// 114 条语料中 113 条作为硬断言，1 条登记在 KNOWN_DIVERGENCES 并动态跳过。
// 新增的未登记分歧会让测试直接失败。
//
// 运行：node --test tests/parity-contract-*.test.js
// Python 侧：bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_parity_*.py"

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const corpus = require('./parity-contract-corpus.cjs');

const ROOT = corpus.ROOT;
let cachedPythonResults = null;

function formatValue(value) {
    return corpus.describe(value);
}

function pythonResults() {
    if (cachedPythonResults) return cachedPythonResults;
    const result = spawnSync('bash',
        ['scripts/python-runtime.sh', path.join('tests', 'python', 'parity_contract_probe.py')], {
            cwd: ROOT,
            encoding: 'utf8',
            input: JSON.stringify({ tasks: corpus.TASKS }),
            maxBuffer: 32 * 1024 * 1024
        });
    assert.equal(result.status, 0,
        `Python 对照探针执行失败（退出码 ${result.status}）: `
        + `${String(result.stderr || result.error?.message || '').trim()}`);
    let payload;
    try {
        payload = JSON.parse(result.stdout);
    } catch (error) {
        assert.fail(`Python 对照探针输出不是 JSON: ${error.message}\n${String(result.stdout).slice(0, 2000)}`);
    }
    assert.ok(Array.isArray(payload.results), 'Python 对照探针缺少 results 数组');
    const map = new Map();
    for (const item of payload.results) {
        map.set(corpus.divergenceKey(item.rule, item.case), item.py);
    }
    assert.equal(map.size, corpus.TASKS.length,
        `Python 对照探针返回 ${map.size} 条，预期 ${corpus.TASKS.length} 条`);
    cachedPythonResults = map;
    return map;
}

function failureDetail(task, js, py) {
    return [
        `规则「${task.rule}」的语料「${task.case}」两侧结论不一致`,
        `Node  : ${formatValue(js)}`,
        `Python: ${formatValue(py)}`,
        `语料  : ${JSON.stringify(task)}`
    ].join('\n');
}

function ruleHit(ruleId, value) {
    return ruleId === 'manual-numeral' ? value === true : value !== null;
}

for (const rule of corpus.RULES) {
    test(`对照 ${rule.id}：${rule.title}`, t => {
        const python = pythonResults();
        const ruleTasks = corpus.tasksFor(rule.id);
        assert.ok(ruleTasks.length >= 4,
            `规则 ${rule.id} 只有 ${ruleTasks.length} 条语料，对照测试至少需要 4 条`);
        let divergent = 0;
        let converged = 0;
        for (const task of ruleTasks) {
            const key = corpus.divergenceKey(task.rule, task.case);
            const js = corpus.evaluateJs(task);
            assert.ok(python.has(key), `Python 侧缺少语料结果: ${key}`);
            const py = python.get(key);
            const documented = corpus.knownDivergence(task.rule, task.case);
            if (js !== py) {
                if (!documented) {
                    assert.fail(`${failureDetail(task, js, py)}\n未登记的新分歧：请先确认语义，`
                        + '修实现（不在本测试范围）或登记到 KNOWN_DIVERGENCES。');
                }
                divergent += 1;
                t.diagnostic(`当前不一致（已登记，未改实现）: ${key}`
                    + ` | Node=${formatValue(js)}`
                    + ` | Python=${formatValue(py)}`
                    + ` | 说明: ${documented.note}`);
                if (documented.js !== js || documented.py !== py) {
                    t.diagnostic(`提示：${key} 的实测值相比登记有变化，`
                        + `登记 Node=${formatValue(documented.js)} Python=${formatValue(documented.py)}`);
                }
                continue;
            }
            if (documented) converged += 1;
            assert.equal(js, py, `\n${failureDetail(task, js, py)}`);
        }
        if (converged) t.diagnostic(`已收敛并转为硬断言: ${converged} 条（仍登记在 KNOWN_DIVERGENCES，可后续清理）`);
        if (divergent) {
            t.skip(`${corpus.RULES.length} 组对照中本组有 ${divergent} 条语料当前不一致，`
                + `已登记在 tests/parity-contract-corpus.cjs 的 KNOWN_DIVERGENCES；其余 ${ruleTasks.length - divergent} 条已按硬断言核对`);
        }
    });
}

test('对照语料自身非退化且覆盖两侧结论', () => {
    assert.equal(corpus.RULES.length, 6, '对照规则应固定为 6 组');
    for (const rule of corpus.RULES) {
        const ruleTasks = corpus.tasksFor(rule.id);
        const values = ruleTasks.map(task => corpus.evaluateJs(task));
        const hits = values.filter(value => ruleHit(rule.id, value)).length;
        assert.ok(hits > 0, `规则 ${rule.id} 没有“命中规则”的语料`);
        assert.ok(hits < values.length, `规则 ${rule.id} 没有“通过”的语料`);
    }
    const ruleIds = new Set(corpus.RULES.map(rule => rule.id));
    for (const key of Object.keys(corpus.KNOWN_DIVERGENCES)) {
        const [ruleId, caseName] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
        assert.ok(ruleIds.has(ruleId), `KNOWN_DIVERGENCES 引用了未知规则: ${ruleId}`);
        const task = corpus.TASKS.find(item => item.rule === ruleId && item.case === caseName);
        assert.ok(task, `KNOWN_DIVERGENCES 引用了不存在的语料: ${key}`);
        assert.ok(corpus.KNOWN_DIVERGENCES[key].note, `KNOWN_DIVERGENCES 缺少说明: ${key}`);
    }
});

test('两侧对照入口都存在', () => {
    const contract = require('../scripts/analysis-contract.js');
    const editorial = require('../scripts/editorial-quality.js');
    assert.equal(typeof contract.validateExperimentTableContract, 'function');
    assert.equal(typeof contract.EXPERIMENT_TABLE_CONTRACT_VERSION, 'string');
    assert.equal(typeof editorial.findQuantitativeChineseNumerals, 'function');
    const python = pythonResults();
    assert.equal(python.size, corpus.TASKS.length);
});

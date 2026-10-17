'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const predicate = require('../scripts/lib/scoring-stability.js').scoringStabilityIsResolved;
const vectors = require('./fixtures/scoring-stability-cases.json');

test('共享评分判据逐项重放固定证明向量且不修改对象', () => {
    for (const { name, stage, expected } of vectors) {
        const before = JSON.stringify(stage);
        assert.equal(predicate(stage), expected, name);
        assert.equal(JSON.stringify(stage), before, name);
    }
    for (const value of [NaN, Infinity, -Infinity]) {
        const stage = structuredClone(vectors.find(item => item.name === 'multi-pass').stage);
        stage.finalScore = value;
        assert.equal(predicate(stage), false);
    }
});

test('深度恢复与最终资格使用同一个函数，不另建宽松判据或保存器', () => {
    const deep = require('../scripts/deep-analyzer.js');
    const engine = require('../scripts/analysis-engine.js');
    assert.equal(deep.scoringStabilityResolutionIsValid, predicate);
    assert.equal(engine.scoringStabilityIsResolved, predicate);
    assert.equal(Object.hasOwn(deep, 'auditTypeAwareScoring'), false);
    assert.equal(Object.hasOwn(engine, 'createFileSaver'), false);
});

test('Python 与 Node 读取同一固定向量并给出完全相同的严格判断', () => {
    const root = path.resolve(__dirname, '..');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', `
import json, sys
sys.path.insert(0, 'scripts')
from scoring_stability import scoring_stability_is_resolved
cases = json.load(sys.stdin)
print(json.dumps([scoring_stability_is_resolved(item['stage']) for item in cases]))
`], { cwd: root, input: JSON.stringify(vectors), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), vectors.map(item => predicate(item.stage)));
});

test('实现闭包包含两端真正使用的评分叶子，旧固定清单不回填', () => {
    const root = path.resolve(__dirname, '..');
    const collector = require('../scripts/lib/workflow-implementation-files.js');
    const files = collector.collectWorkflowImplementationFiles({ root,
        entryFiles: ['scripts/conference-page-render.py', 'scripts/analysis-engine.js'] });
    for (const leaf of ['scripts/lib/scoring-stability.js', 'scripts/scoring_stability.py']) {
        assert.ok(files.includes(leaf), leaf);
        assert.ok(fs.statSync(path.join(root, leaf)).isFile());
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const predicate = require('../scripts/lib/scoring-stability.js').scoringStabilityIsResolved;
const vectors = require('./fixtures/scoring-stability-cases.json');

// Synthetic audit leaves exercise the actual production selection rule; these
// local proof objects are not full audits, source capabilities or paid records.
for (const [name, scores] of [
    ['second-pass-12', [7, 7.2]], ['multi-pass-13', [7, 8, 7.2]],
    ['multi-pass-23', [7, 8, 8.2]]
]) test(`当前生产共识规则的 ${name} 证明绑定被选中的真实审计`, async t => {
    const { runScoringAuditConsensus } = require('../scripts/lib/scoring-audit-consensus');
    const engine = require('../scripts/analysis-engine');
    const hash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const results = scores.map((score, index) => ({ score, audit: { score, ordinal: index + 1 }, attempts: 1 }));
    let next = 1;
    const selected = await runScoringAuditConsensus({ firstResult: results[0], firstScore: scores[0],
        requiresConsensus: true, auditAgain: async () => results[next++],
        scoreOfResult: result => result.score, fingerprintAudit: hash });
    const stage = { stabilityWarning: true, finalScore: selected.result.score,
        auditSha256: hash(selected.result.audit), stabilityResolution: selected.resolution };
    assert.equal(next, results.length);
    assert.equal(predicate(stage), true);
    assert.equal(engine.scoringStabilityIsResolved(stage), true);
    if (name === 'second-pass-12') {
        assert.equal(Object.hasOwn(selected.resolution, 'thirdAuditScore'), false);
        return; // Original second-pass proofs keep their established format.
    }
    assert.equal(selected.result, results[2]);
    assert.equal(selected.resolution.secondAuditScore, selected.resolution.thirdAuditScore);
    assert.equal(selected.resolution.secondAuditSha256, selected.resolution.thirdAuditSha256);
    for (const [mutation, updates] of [
        ['third-score', { thirdAuditScore: 9 }],
        ['third-sha', { thirdAuditSha256: 'd'.repeat(64) }],
        ['both', { thirdAuditScore: 9, thirdAuditSha256: 'd'.repeat(64) }]
    ]) await t.test(mutation, () => {
        const changed = structuredClone(stage);
        Object.assign(changed.stabilityResolution, updates);
        const before = structuredClone(changed);
        assert.deepEqual([predicate(changed), engine.scoringStabilityIsResolved(changed)], [false, false]);
        assert.deepStrictEqual(changed, before);
    });
});

test('当前生产规则三次均不共识只产生拒绝证明', async () => {
    const { runScoringAuditConsensus } = require('../scripts/lib/scoring-audit-consensus');
    const engine = require('../scripts/analysis-engine');
    const hash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const results = [7, 8, 9].map(score => ({ score, audit: { score }, attempts: 1 }));
    let next = 1;
    await assert.rejects(runScoringAuditConsensus({ firstResult: results[0], firstScore: 7,
        requiresConsensus: true, auditAgain: async () => results[next++],
        scoreOfResult: result => result.score, fingerprintAudit: hash }), error => {
        assert.equal(error.code, 'CONTRACT_REJECTED');
        assert.equal(error.stabilityResolution.status, 'unresolved');
        const stage = { stabilityWarning: true, stabilityResolution: error.stabilityResolution };
        assert.deepEqual([predicate(stage), engine.scoringStabilityIsResolved(stage)], [false, false]);
        return true;
    });
    assert.equal(next, 3);
});

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

test('深度恢复保留共享函数，最终资格对普通API完整委托同一严格判据', () => {
    const deep = require('../scripts/deep-analyzer.js');
    const engine = require('../scripts/analysis-engine.js');
    assert.equal(deep.scoringStabilityResolutionIsValid, predicate);
    for (const { name, stage, expected } of vectors) {
        const before = structuredClone(stage);
        assert.equal(engine.scoringStabilityIsResolved(stage), predicate(stage), name);
        assert.equal(engine.scoringStabilityIsResolved(stage), expected, name);
        assert.deepStrictEqual(stage, before, name);
    }
    assert.equal(Object.hasOwn(deep, 'auditTypeAwareScoring'), false);
    assert.equal(Object.hasOwn(engine, 'createFileSaver'), false);
});

test('本地确定性评分不能凭执行类型、原API共识或伪凭证绕过真实私有冷核', () => {
    const engine = require('../scripts/analysis-engine.js');
    for (const kind of ['deterministic_source_resource_audit', 'deterministic_source_core_audit']) {
        for (const { name, stage: original } of vectors.filter(row => row.expected === true)) {
            const stage = { ...structuredClone(original), executionKind: kind,
                originApiStage: structuredClone(original), newApiRequests: 0 };
            // Raw API consensus is intentionally insufficient for a local stage.
            assert.equal(predicate(stage), true, `${kind}: ${name}`);
            const paper = { id: 'conference:interspeech:2026:conference-paper-id:forged26_interspeech',
                source: 'conference', analysisManifest: { stages: { scoringAudit: stage } } };
            const before = structuredClone({ stage, paper });
            assert.equal(engine.scoringStabilityIsResolved(stage), false, `${kind}: no paper`);
            assert.equal(engine.scoringStabilityIsResolved(stage, paper), false, `${kind}: no receipt`);
            const claimed = { ...paper, conferenceSourceCorrection: {
                contract: kind === 'deterministic_source_core_audit'
                    ? 'conference-source-core-correction-v1' : 'conference-source-resource-correction-v1',
                processId: '11111111-2222-4333-8444-555555555555',
                executionId: '11111111-2222-4333-8444-555555555555', manifestSha256: 'a'.repeat(64) } };
            const claimedBefore = structuredClone(claimed);
            assert.equal(engine.scoringStabilityIsResolved(stage, claimed), false, `${kind}: forged locator`);
            assert.equal(engine.scoringStabilityIsResolved(stage, structuredClone(claimed)), false,
                `${kind}: stage object belongs to another paper`);
            assert.deepStrictEqual({ stage, paper }, before);
            assert.deepStrictEqual(claimed, claimedBefore);
        }
    }
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

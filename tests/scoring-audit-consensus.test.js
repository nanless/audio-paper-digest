'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runScoringAuditConsensus } = require('../scripts/lib/scoring-audit-consensus');
const { scoringStabilityIsResolved } = require('../scripts/lib/scoring-stability');
const fingerprintAudit = audit => crypto.createHash('sha256').update(JSON.stringify(audit)).digest('hex');
const result = (score, id, attempts = 1) => ({ audit: { score, id }, attempts });

function fixture(scores, attempts = scores.map(() => 1)) {
    const results = scores.map((score, index) => result(score, index, attempts[index]));
    let requests = 0;
    const validated = [];
    const passes = [];
    return {
        results, requests: () => requests, validated, passes,
        options: { firstResult: results[0], firstScore: scores[0], requiresConsensus: true,
            auditAgain: async () => { requests++; return results[requests]; },
            scoreOfResult: value => { validated.push(value); return value.audit.score; },
            fingerprintAudit, onPass: pass => passes.push(pass) }
    };
}

test('普通稳定评分不增加审计，保留第一次实际内容尝试', async () => {
    const f = fixture([6], [2]);
    const outcome = await runScoringAuditConsensus({ ...f.options, requiresConsensus: false });
    assert.equal(f.requests(), 0);
    assert.equal(outcome.result, f.results[0]);
    assert.equal(outcome.totalAttempts, 2);
    assert.equal(outcome.resolution.status, 'not_required');
});

test('二次共识立即返回且累计两次实际内容尝试', async () => {
    const f = fixture([6, 6.2, 9], [2, 3, 1]);
    const outcome = await runScoringAuditConsensus(f.options);
    assert.equal(f.requests(), 1);
    assert.deepEqual(f.validated, [f.results[1]]);
    assert.equal(outcome.result, f.results[1]);
    assert.equal(outcome.totalAttempts, 5);
    assert.equal(outcome.resolution.method, 'second_pass_consensus');
    assert.equal(outcome.resolution.secondAttempts, 3);
});

for (const scores of [[6, 8, 6.1], [6, 8, 8.1], [6, 6.6, 6.3]]) {
    test(`三次评分仅选原容差内最接近的一对：${scores.join('/')}`, async () => {
        const f = fixture(scores, [1, 2, 3]);
        const outcome = await runScoringAuditConsensus(f.options);
        assert.equal(f.requests(), 2);
        assert.deepEqual(f.passes, [2, 3]);
        assert.deepEqual(f.validated, f.results.slice(1));
        assert.equal(outcome.result, f.results[2]);
        assert.equal(outcome.totalAttempts, 6);
        assert.equal(outcome.resolution.method, 'multi_pass_consensus');
        assert.equal(outcome.resolution.thirdAttempts, 3);
        assert.equal(outcome.resolution.secondAuditSha256, fingerprintAudit(outcome.result.audit));
        assert.equal(outcome.resolution.thirdAuditSha256, fingerprintAudit(f.results[2].audit));
        assert.equal(scoringStabilityIsResolved({ stabilityWarning: true,
            stabilityResolution: outcome.resolution, auditSha256: fingerprintAudit(outcome.result.audit),
            finalScore: outcome.result.audit.score }), true);
    });
}

test('三次都不共识仍拒绝并保留失败证明，不派第四次', async () => {
    const f = fixture([6, 7, 8]);
    await assert.rejects(runScoringAuditConsensus(f.options), error => {
        assert.equal(error.code, 'CONTRACT_REJECTED');
        assert.equal(error.stabilityResolution.status, 'unresolved');
        assert.equal(error.stabilityResolution.method, 'multi_pass_consensus');
        assert.equal(error.stabilityResolution.thirdAuditScore, 8);
        return true;
    });
    assert.equal(f.requests(), 2);
});

test('传输和正常来源校验失败保留原异常，不追加审计', async () => {
    for (const phase of ['transport', 'validation']) {
        const f = fixture([6, 8, 8.1]);
        const failure = Object.assign(new Error(phase), { code: phase === 'transport' ? 'ECONNRESET' : 'CONTRACT_REJECTED' });
        let calls = 0;
        await assert.rejects(runScoringAuditConsensus({ ...f.options,
            auditAgain: async () => { calls++; if (phase === 'transport') throw failure; return f.results[1]; },
            scoreOfResult: () => { throw failure; } }), error => error === failure);
        assert.equal(calls, 1);
    }
});

for (const scores of [[7.4, 7.1], [7.1, 7.4], [10, 9.7]]) {
    test(`原始0.3减法机器误差不派第三次审计：${scores.join('/')}`, async () => {
        const f = fixture(scores, [2, 3]);
        const before = JSON.stringify(f.results);
        const outcome = await runScoringAuditConsensus({ ...f.options,
            auditAgain: async () => {
                assert.equal(f.validated.length, 0, '不应请求第三次审计');
                return f.results[1];
            } });
        assert.deepEqual(f.passes, [2]);
        assert.equal(outcome.result, f.results[1]);
        assert.equal(outcome.totalAttempts, 5);
        assert.equal(outcome.resolution.method, 'second_pass_consensus');
        assert.equal(outcome.resolution.consensusTolerance, 0.3);
        assert.equal(outcome.resolution.scoreDifference, Math.abs(scores[1] - scores[0]));
        assert.equal(outcome.resolution.secondAuditSha256, fingerprintAudit(f.results[1].audit));
        assert.equal(scoringStabilityIsResolved({ stabilityWarning: true,
            stabilityResolution: outcome.resolution }), true);
        assert.equal(JSON.stringify(f.results), before);
    });
}

test('第三次形成原始0.3共识时保留真实选中对、SHA和全部尝试', async () => {
    const f = fixture([7.4, 9, 7.1], [2, 3, 4]);
    const outcome = await runScoringAuditConsensus(f.options);
    assert.equal(f.requests(), 2);
    assert.deepEqual(f.passes, [2, 3]);
    assert.equal(outcome.result, f.results[2]);
    assert.equal(outcome.totalAttempts, 9);
    assert.equal(outcome.resolution.method, 'multi_pass_consensus');
    assert.equal(outcome.resolution.scoreDifference, Math.abs(7.1 - 7.4));
    assert.equal(scoringStabilityIsResolved({ stabilityWarning: true,
        stabilityResolution: outcome.resolution, finalScore: 7.1,
        auditSha256: fingerprintAudit(f.results[2].audit) }), true);
});

for (const secondScore of [7.09, 7, 7.09999999999999]) {
    test(`真实超界差异仍正常第三审并拒绝：7.4/${secondScore}/9`, async () => {
        const f = fixture([7.4, secondScore, 9]);
        await assert.rejects(runScoringAuditConsensus(f.options), error => {
            assert.equal(error.code, 'CONTRACT_REJECTED');
            assert.equal(error.stabilityResolution.status, 'unresolved');
            assert.ok(error.stabilityResolution.scoreDifference > 0.3);
            return true;
        });
        assert.equal(f.requests(), 2);
        assert.deepEqual(f.passes, [2, 3]);
    });
}

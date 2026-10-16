'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const api = require('../scripts/lib/reader-next-request-plan');
function state(patch = {}) {
    return { paperId: '2610.20465v1', identitySha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64),
        attempts: 1, fullAttempts: 1, transportFailures: 2, noProgress: 0, validationFailureStreak: 0,
        attemptLimit: 6, maxFullResponses: 2, changedValidationWithinOriginalBudget: false,
        nextContentAttempt: 2, repairContext: null,
        issues: [{ path: '/sections/2/body', code: 'existing_issue', message: '保留全部当前问题' },
            { path: null, diagnosticOnly: true, message: '诊断项同样保留' }], ...patch };
}
test('实际计划保持原路由与原计数，所有issues隔离且不能当成功凭证', () => {
    const input = state(), before = JSON.stringify(input), plan = api.buildReaderNextRequestPlan(input);
    assert.equal(plan.nextKind, 'full'); assert.equal(plan.action, 'request');
    assert.equal(plan.remainingResponses, 5); assert.equal(plan.remainingFullResponses, 1);
    assert.equal(plan.issueCount, input.issues.length); assert.equal(plan.blockingIssueCount, 1);
    assert.equal(plan.issues[0].message, input.issues[0].message); assert(Object.isFrozen(plan.issues[0]));
    assert.equal(plan.notFinalPreflight, true); assert.equal(plan.notRequestAuthorization, true);
    assert.equal(JSON.stringify(input), before);
    input.issues[0].message = '外部更改'; assert.notEqual(plan.issues[0].message, input.issues[0].message);
    const patch = api.buildReaderNextRequestPlan(state({ fullAttempts: 2,
        repairContext: { targets: [{ path: '/sections/2/body', oldSha256: 'c'.repeat(64) }] } }));
    assert.equal(patch.nextKind, 'patch'); assert.equal(patch.action, 'request');
    assert.equal(patch.fullAttempts, 2); assert.equal(patch.remainingFullResponses, 0);
});
test('原full/content/noProgress/streak边界全部保持，进展证明不能授新full', () => {
    for (const [change, code] of [
        [{ fullAttempts: 2 }, 'READER_FULL_ATTEMPTS_EXHAUSTED'],
        [{ maxFullResponses: 0 }, 'READER_FULL_ATTEMPTS_EXHAUSTED'],
        [{ budgetOnly: true, attempts: 6 }, 'READER_REPAIR_ATTEMPTS_EXHAUSTED'],
        [{ budgetOnly: true, noProgress: 2 }, 'READER_REPAIR_ATTEMPTS_EXHAUSTED'],
        [{ budgetOnly: true, validationFailureStreak: 2 }, 'READER_REPAIR_ATTEMPTS_EXHAUSTED']
    ]) assert.equal(api.buildReaderNextRequestPlan(state(change)).blocker.code, code);
    assert.equal(api.buildReaderNextRequestPlan(state({ noProgress: 2, changedValidationWithinOriginalBudget: true })).action, 'request');
    assert.equal(api.buildReaderNextRequestPlan(state({ fullAttempts: 2, noProgress: 2,
        changedValidationWithinOriginalBudget: true })).blocker.code, 'READER_FULL_ATTEMPTS_EXHAUSTED');
    assert.equal(api.buildReaderNextRequestPlan(state({ noProgress: 2 })).action, 'request',
        'mid-loop planning adds no repeated-failure guard; existing catch stops it');
    assert.equal(api.buildReaderNextRequestPlan(state({ budgetOnly: true, attempts: 6, fullAttempts: 2 })).blocker.code,
        'READER_REPAIR_ATTEMPTS_EXHAUSTED', 'original pre-loop error priority wins');
    assert.throws(() => api.buildReaderNextRequestPlan(state({ fullAttempts: -1 })), /counter/);
});
test('共享预算计划逐分支保持原pre-loop判断，local-only不能覆盖原full耗尽错误', () => {
    for (const attempts of [0, 1, 5, 6]) for (const noProgress of [0, 1, 2])
        for (const validationFailureStreak of [0, 1, 2]) for (const changedValidationWithinOriginalBudget of [false, true]) {
            const oldStops = attempts >= 6 || !changedValidationWithinOriginalBudget
                && (noProgress >= 2 || validationFailureStreak >= 2);
            const plan = api.buildReaderNextRequestPlan(state({ budgetOnly: true, attempts, noProgress,
                validationFailureStreak, changedValidationWithinOriginalBudget }));
            assert.equal(plan.blocker?.code === 'READER_REPAIR_ATTEMPTS_EXHAUSTED', oldStops);
        }
    const plan = api.withReaderLocalRequestsOnly(() => api.buildReaderNextRequestPlan(state({ fullAttempts: 2 })));
    assert.equal(plan.blocker.code, 'READER_FULL_ATTEMPTS_EXHAUSTED');
});
test('问题日志有界且优先包含blocking诊断，完整集合保留计数与SHA', () => {
    const issues = Array.from({ length: 400 }, (_, index) => ({ path: '/sections/0/body',
        code: 'issue', diagnosticOnly: index < 399, message: '源'.repeat(10000), secretSource: '不进入日志'.repeat(10000) }));
    const plan = api.buildReaderNextRequestPlan(state({ issues }));
    assert.equal(plan.issueCount, 400); assert.equal(plan.blockingIssueCount, 1);
    assert.equal(plan.issueProjectionOmitted, 272); assert.equal(plan.issues[0].index, 399);
    assert.match(plan.issuesSha256, /^[a-f0-9]{64}$/);
    assert(Buffer.byteLength(JSON.stringify(plan)) < 256 * 1024);
    assert(!JSON.stringify(plan).includes('不进入日志'));
    const next = api.buildReaderNextRequestPlan(state({ attempts: 2, nextContentAttempt: 3, fullAttempts: 2,
        repairContext: { targets: [] } }));
    assert.equal(next.attempts, 2); assert.equal(next.nextContentAttempt, 3);
    assert.equal(next.remainingResponses, 4); assert.equal(next.fullAttempts, 2);
});
test('local-only作用域只减权、不泄漏、不修改原预算或影响另一异步作用域', async () => {
    await api.withReaderLocalRequestsOnly(async () => {
        await Promise.resolve();
        const plan = api.buildReaderNextRequestPlan(state());
        assert.equal(plan.nextKind, 'full'); assert.equal(plan.blocker.code, 'READER_FULL_REQUEST_FORBIDDEN');
        assert.equal(plan.remainingFullResponses, 1); assert.equal(plan.permittedFullResponses, 0);
        assert.equal(api.buildReaderNextRequestPlan(state({ repairContext: { targets: [] } })).action, 'request');
        await api.withReaderLocalRequestsOnly(() => assert.equal(api.buildReaderNextRequestPlan(state()).action, 'blocked'));
    });
    assert.equal(api.buildReaderNextRequestPlan(state()).action, 'request');
});
test('真实正常生成在usage/transport/空候选保存前拒绝意外full，默认行为不变', async t => {
    const deep = require('../scripts/deep-analyzer'), logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-next-plan-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let calls = 0;
    const paper = { arxivId: '2610.99987', title: '离线正常路由' }, options = {
        sourceText: 'source', readerAttemptsDir: dir, readerMaxAttempts: 1,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => { calls++; return 'invalid JSON'; }
    };
    await assert.rejects(api.withReaderLocalRequestsOnly(() => deep.generateApiReaderArticleDetailed(
        paper, 'canonical', '', options)), error => error.code === 'READER_FULL_REQUEST_FORBIDDEN');
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(dir), []);
    const planned = logs.filter(line => line.includes('[reader-next-request-plan]'))
        .map(line => JSON.parse(line.slice(line.indexOf('{'))));
    assert.equal(planned.at(-1).nextKind, 'full'); assert.equal(planned.at(-1).action, 'blocked');
    assert.equal(planned.at(-1).attempts, 0); assert.equal(planned.at(-1).fullAttempts, 0);
    const ordinaryOptions = { ...options, readerMaxAttempts: 2 };
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, 'canonical', '', ordinaryOptions));
    assert.equal(calls, 2, 'default flow still uses exactly its original two-response budget');
    const dispatched = logs.filter(line => line.includes('[reader-next-request-plan]'))
        .map(line => JSON.parse(line.slice(line.indexOf('{')))).filter(plan => plan.action === 'request');
    assert.deepEqual(dispatched.map(plan => [plan.attempts, plan.nextContentAttempt, plan.fullAttempts]),
        [[0, 1, 0], [1, 2, 1]], 'each iteration uses attempt-1, not stale recovered attempts');
    await assert.rejects(deep.generateApiReaderArticleDetailed(paper, 'canonical', '', ordinaryOptions),
        error => error.code === 'READER_REPAIR_ATTEMPTS_EXHAUSTED');
    assert.equal(calls, 2, 'content gate still takes priority at the exhausted pre-loop state');
    const candidate = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(n => /^[a-f0-9]{64}\.json$/.test(n)))));
    assert.equal(candidate.payload.attempts, 2); assert.equal(candidate.payload.fullAttempts, 2);
});


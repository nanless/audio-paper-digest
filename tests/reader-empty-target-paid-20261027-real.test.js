'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const planner = require('../scripts/lib/reader-next-request-plan');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-empty-target-paid-20261027-real.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const row = fixture.papers[0];
const original = JSON.parse(row.diagnostics[0].requestRaw);
const artifacts = JSON.parse(row.sourceRuntimeRaw).structuredArtifacts;
const counters = payload => Object.fromEntries(['attempts', 'fullAttempts', 'transportFailures',
    'noProgress', 'validationFailureStreak'].map(key => [key, payload[key]]));
function directory(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-empty-target-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function payload(dir) {
    const names = fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    assert.equal(names.length, 1);
    return JSON.parse(fs.readFileSync(path.join(dir, names[0]))).payload;
}
function options(dir, callback, extra = {}) {
    return { sourceText: row.sourceText, structuredArtifacts: artifacts, readerAttemptsDir: dir,
        readerMaxAttempts: 6, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: callback, ...extra };
}
function generate(opts) {
    return deep.generateApiReaderArticleDetailed({ arxivId: row.paperId, title: row.title }, '', row.sourceText, opts);
}
function capturePlans(t) {
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    return () => logs.filter(line => line.includes('[reader-next-request-plan]'))
        .map(line => JSON.parse(line.slice(line.indexOf('{'))));
}

test('四次真实付费现场均为零目标和空补丁，不是过期父SHA；历史不得改写', () => {
    const before = JSON.stringify(fixture);
    assert.equal(fixture.adoptionAuthorized, false);
    assert.equal(fixture.modelRequestsAuthorized, false);
    assert.equal(fixture.budgetResetAuthorized, false);
    assert.equal(fixture.papers.flatMap(paper => paper.diagnostics).length, 4);
    for (const paper of fixture.papers) {
        assert.equal(sha(paper.sourceText), paper.sourceTextSha256);
        assert.equal(sha(paper.sourceRuntimeRaw), paper.sourceRuntimeSha256);
        assert.equal(sha(paper.sourceManifestRaw), paper.sourceManifestSha256);
        assert.equal(sha(paper.failedCandidateRaw), paper.failedCandidateSha256);
        const failed = JSON.parse(paper.failedCandidateRaw).payload;
        assert.deepEqual(counters(failed), { attempts: 3, fullAttempts: 1, transportFailures: 0,
            noProgress: 1, validationFailureStreak: 2 });
        for (const diagnostic of paper.diagnostics) {
            assert.equal(sha(diagnostic.requestRaw), diagnostic.requestFileSha256);
            assert.equal(sha(diagnostic.responseRaw), diagnostic.responseFileSha256);
            const request = JSON.parse(diagnostic.requestRaw), response = JSON.parse(diagnostic.responseRaw);
            const patch = JSON.parse(response.rawResponse);
            assert.equal(response.requestSha256, diagnostic.requestFileSha256);
            assert.equal(sha(request.prompt), request.promptSha256);
            assert.equal(sha(response.rawResponse), response.outputTextSha256);
            assert.equal(request.draftSha256, repair.hashDraft(request.draft));
            assert.equal(request.draftSha256, repair.hashDraft(failed.draft));
            assert.equal(patch.draftSha256, request.draftSha256);
            assert.equal(patch.version, 1);
            assert.deepEqual(Object.keys(patch).sort(), ['draftSha256', 'replacements', 'version']);
            assert.deepEqual(request.repairTargets, []);
            assert.equal(request.atomicOperation, null);
            assert.deepEqual(patch.replacements, []);
            assert.match(request.prompt, /"targets":\[\]/u);
            assert.match(request.prompt, /只提交1–8个授权目标/u);
            assert.throws(() => repair.applyReaderPatch(request.draft, patch, []), /invalid shape or stale draft SHA/u);
        }
        const context = repair.buildRepairContext(failed.draft, failed.issues, paper.sourceText, paper.sourceText,
            { structuredArtifacts: JSON.parse(paper.sourceRuntimeRaw).structuredArtifacts });
        assert.deepEqual(context.targets, []);
        assert.equal(context.atomicOperation, null);
    }
    assert.equal(JSON.stringify(fixture), before);
});

test('真实后续单节点补丁有自己的父稿，不因零目标修正被改成全文或旧稿采纳', () => {
    const diagnostic = fixture.laterValidTargetDiagnostic;
    assert.equal(sha(diagnostic.requestRaw), diagnostic.requestFileSha256);
    assert.equal(sha(diagnostic.responseRaw), diagnostic.responseFileSha256);
    const request = JSON.parse(diagnostic.requestRaw), response = JSON.parse(diagnostic.responseRaw);
    assert.equal(response.requestSha256, diagnostic.requestFileSha256);
    assert.equal(sha(response.rawResponse), response.outputTextSha256);
    assert.equal(request.draftSha256, repair.hashDraft(request.draft));
    const patch = JSON.parse(response.rawResponse), before = JSON.stringify(request.draft);
    assert.equal(patch.draftSha256, request.draftSha256);
    assert.deepEqual(request.repairTargets.map(target => target.path), ['/sections/4/body']);
    const updated = repair.applyReaderPatch(request.draft, patch, request.repairTargets.map(target => target.path));
    assert.equal(updated.sections[4].body, patch.replacements[0].value);
    assert.notEqual(updated.sections[4].body, request.draft.sections[4].body);
    assert.equal(JSON.stringify(request.draft), before);
});

test('构造对照：missing-result仍有闭合的原节点时保留patch，即使full已耗尽', () => {
    const source = 'The compared methods were measured with the same SDR evaluation protocol.';
    const draft = { version: 3, readerTitle: '局部范围对照', oneSentenceThesis: '这是一份仅检验修复范围的构造夹具。',
        sections: [{ kind: 'result', heading: '原结果', body: '| 方法 | SDR ↑ |\n|---|---:|\n| A | 1 |\n| B | 2 |' }],
        conceptBridges: [], figurePlacements: [], formulaBindings: [],
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: [source] }] };
    const issues = [{ code: 'reader_result_table_missing', path: null,
        message: '读者文章主结果表覆盖不足：仍须修复原位置的结果表' }];
    const context = repair.buildRepairContext(draft, issues, source, source);
    assert.deepEqual(context.targets.map(target => target.path), ['/sections/0/body', '/tableBindings/0']);
    assert.equal(deep.readerIssuesRequireFullSourceBindingRetry(null, draft, 2, issues, null, false, context), false);
    const state = { paperId: 'synthetic-local-scope', attempts: 3, fullAttempts: 2,
        transportFailures: 0, noProgress: 0, validationFailureStreak: 0, attemptLimit: 6,
        maxFullResponses: 2, changedValidationWithinOriginalBudget: false, repairContext: context, issues };
    const planned = planner.withReaderLocalRequestsOnly(() => planner.buildReaderNextRequestPlan(state));
    assert.equal(planned.nextKind, 'patch');
    assert.equal(planned.action, 'request');
    assert.equal(planned.remainingFullResponses, 0);
});

test('正常引擎以原full余额恢复空目标，不再付费派发空patch且最多两个full', async t => {
    const plans = capturePlans(t), dir = directory(t), stages = [];
    await assert.rejects(generate(options(dir, async (_messages, _budget, request) => {
        stages.push(request.usageContext.stage);
        return JSON.stringify(original.draft);
    })), /读者文章|Reader|长文/u);
    assert.deepEqual(stages, ['apiReaderArticle', 'apiReaderArticle']);
    const routes = plans().filter(plan => plan.phase !== 'budget_stop');
    assert.ok(routes.some(plan => plan.fullAttempts === 1 && plan.nextKind === 'full'
        && plan.sourceBindingNeedsFullRetry && plan.remainingFullResponses === 1 && plan.repairTargets.length === 0));
    assert.ok(!routes.some(plan => plan.nextKind === 'patch' && plan.repairTargets.length === 0));
    assert.equal(payload(dir).attempts, 2);
    assert.equal(payload(dir).fullAttempts, 2);
    const diagnostics = path.join(dir, 'request-diagnostics');
    assert.deepEqual(fs.existsSync(diagnostics)
        ? fs.readdirSync(diagnostics).filter(name => name.endsWith('.request.json')) : [], []);
    const before = counters(payload(dir));
    let furtherRequests = 0;
    await assert.rejects(generate(options(dir, async () => {
        furtherRequests++; throw new Error('exhausted full budget must not dispatch');
    })), /读者文章|Reader|长文/u);
    assert.equal(furtherRequests, 0);
    assert.deepEqual(counters(payload(dir)), before);
});

test('local-only实际恢复在空目标full规划后零请求停止，旧次数和传输记录不变', async t => {
    const plans = capturePlans(t), dir = directory(t);
    let seedCalls = 0;
    await assert.rejects(generate(options(dir, async () => {
        if (++seedCalls === 1) return JSON.stringify(original.draft);
        throw new Error('isolated test: no second content response');
    })), /isolated test/u);
    const before = payload(dir), expectedCounters = counters(before);
    assert.equal(before.attempts, 1);
    assert.equal(before.fullAttempts, 1);
    let calls = 0;
    await assert.rejects(planner.withReaderLocalRequestsOnly(() => generate(options(dir, async () => {
        calls++; throw new Error('must not dispatch');
    }))), error => error.code === 'READER_FULL_REQUEST_FORBIDDEN');
    assert.equal(calls, 0);
    assert.deepEqual(counters(payload(dir)), expectedCounters);
    assert.equal(repair.hashDraft(payload(dir).draft), repair.hashDraft(before.draft));
    const blocked = plans().at(-1);
    assert.equal(blocked.nextKind, 'full');
    assert.equal(blocked.permittedFullResponses, 0);
    assert.equal(blocked.remainingFullResponses, 1);
    assert.equal(blocked.blocker.code, 'READER_FULL_REQUEST_FORBIDDEN');
    const state = { ...blocked, repairContext: null, maxFullResponses: 0, fullAttempts: 0 };
    const unchanged = JSON.stringify(state);
    assert.equal(planner.buildReaderNextRequestPlan(state).blocker.code, 'READER_FULL_ATTEMPTS_EXHAUSTED',
        'a local window with zero full allowance cannot be upgraded by the fallback');
    assert.equal(JSON.stringify(state), unchanged);
});

test('合法零节点metadata原子删除仍走patch，正文资格与原full次数继续核验', async t => {
    const plans = capturePlans(t), dir = directory(t), stages = [];
    const raw = JSON.stringify({ ...original.draft, sourceBindingsContract: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: 'a'.repeat(64) });
    const operation = repair.buildTopLevelMetadataRepairContext(raw);
    assert.ok(operation);
    await assert.rejects(generate(options(dir, async (_messages, _budget, request) => {
        stages.push(request.usageContext.stage);
        if (stages.length === 1) return raw;
        assert.equal(request.usageContext.stage, 'apiReaderRepair');
        return JSON.stringify({ version: 1, rawSha256: operation.rawSha256, deleteFields: operation.deleteFields });
    }, { readerMaxAttempts: 2 })), /读者文章|Reader|长文/u);
    assert.deepEqual(stages, ['apiReaderArticle', 'apiReaderRepair']);
    assert.ok(plans().some(plan => plan.nextKind === 'patch' && plan.repairTargets.length === 0
        && plan.atomicOperation === 'delete_top_level_program_metadata_v1'));
    assert.equal(payload(dir).attempts, 2);
    assert.equal(payload(dir).fullAttempts, 1);
    assert.ok(!Object.hasOwn(payload(dir).draft, 'sourceBindingsContract'));
});

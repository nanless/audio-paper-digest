'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const utils = require('../scripts/utils');
utils.loadEnvFile = () => {};
process.env.PAPER_ANALYZER_MODEL = 'test-model';
process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
const audit = require('../scripts/lib/reader-table-semantic-audit');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function sample() {
    const article = '| 比较对象 | 条件一得分 | 条件二得分 |\n| --- | --- | --- |\n| 同一模型 | 65.2 | 39.5 |\n\n这里比较同一模型的两种条件。';
    const text = 'The same model has accuracy 65.2 in OV1 and 39.5 in OV2.';
    return { paper: { arxivId: '2610.11156', apiReaderArticle: article, apiReaderArticleSha256: sha(article),
        sourceSha256: sha(text), apiReaderPlan: { tableBindings: [{ sourceQuotes: [text] }] },
        analysisManifest: { stages: { apiReaderArticle: { status: 'complete' } } } },
    source: { text, structuredArtifacts: { payloadSha256: 'a'.repeat(64), tables: [] } } };
}
function response(ctx, issues = []) { return JSON.stringify({ version: 1, inputSha256: ctx.inputSha256, tables: [{ tableIndex: 1, issues }] }); }
test('逐表审校必须有当前文章和原文逐字依据，不能仅凭数字宣告正确', () => {
    const { paper, source } = sample();
    const ctx = audit.buildContext(paper, source);
    const issue = { statementQuote: '这里比较同一模型的两种条件。', sourceQuote: source.text,
        message: '这是同一模型的不同条件，并不是两个模型。', correction: '保持两列分别对应OV1和OV2准确率。' };
    assert.equal(audit.compileResponse(response(ctx, [issue]), ctx).issues[0].bindingPath, '/tableBindings/0');
    assert.throws(() => audit.compileResponse(response(ctx, [{ ...issue, sourceQuote: '准确率不存在' }]), ctx));
    assert.throws(() => audit.compileResponse(response(ctx, [{ ...issue, statementQuote: '当前文章没有此句' }]), ctx));
    assert.throws(() => audit.compileResponse(JSON.stringify({ version: 1, inputSha256: ctx.inputSha256, tables: [] }), ctx));
    assert.throws(() => audit.compileResponse(response({ ...ctx, inputSha256: 'b'.repeat(64) }), ctx));
});
test('硬来源检查失败在模型之前拒绝，原正文与阶段不改', async () => {
    const { paper, source } = sample();
    const before = structuredClone(paper);
    let requests = 0;
    await assert.rejects(audit.run(paper, source, { assertHardBindings() { throw new Error('来源不匹配'); },
        callModel() { requests++; }, async save() {} }), /来源不匹配/);
    assert.equal(requests, 0);
    assert.deepEqual(paper, before);
});
test('模拟回执按公共格式独立记录，同一正文成功审校不再次请求', async () => {
    const usage = require('../scripts/lib/llm-usage');
    const originalWrite = usage.writeLlmUsageEvent;
    const events = [];
    usage.writeLlmUsageEvent = event => events.push(event);
    try {
        const { paper, source } = sample();
        let requests = 0;
        const options = { assertHardBindings() {}, async save() {}, async callModel(messages, maxTokens, opts) {
            requests++;
            assert.equal(maxTokens, 12000);
            const ctx = audit.buildContext(paper, source);
            const raw = response(ctx);
            opts.usageSink({ kind: 'request', outcome: 'completed', model: 'test-model',
                paperId: '2610.11156', stage: audit.STAGE, unitId: ctx.inputSha256, outputTextSha256: sha(raw) });
            return raw;
        } };
        await audit.run(paper, source, options);
        assert.equal(audit.currentProof(paper, source), true);
        await audit.run(paper, source, options);
        assert.equal(requests, 1);
        assert.equal(events.length, 1);
        paper.analysisManifest.stages.apiReaderTableAudit.records[0].requestReceipts[0].outputTextSha256 = 'x';
        assert.equal(audit.currentProof(paper, source), false);
        await assert.rejects(audit.run(paper, source, options), /原始付费响应/);
        assert.equal(requests, 1);
    } finally { usage.writeLlmUsageEvent = originalWrite; }
});
test('已达到六个审校版本时不再请求，所有旧记录保留', async () => {
    const { paper, source } = sample();
    const records = Array.from({ length: 6 }, (_, index) => ({ inputSha256: String(index), status: 'contract_rejected' }));
    paper.analysisManifest.stages.apiReaderTableAudit = { contract: audit.CONTRACT, records };
    let requests = 0;
    await assert.rejects(audit.run(paper, source, { assertHardBindings() {}, async save() {}, callModel() { requests++; } }), /6个正文版本/);
    assert.equal(requests, 0);
    assert.deepEqual(paper.analysisManifest.stages.apiReaderTableAudit.records, records);
});
test('两次真实格式网络失败回执已达上限，重启不额外请求', async () => {
    const usage = require('../scripts/lib/llm-usage');
    const write = usage.writeLlmUsageEvent;
    const ledger = [];
    usage.writeLlmUsageEvent = event => ledger.push(event);
    try {
        const { paper, source } = sample(); let calls = 0;
        const options = { assertHardBindings() {}, async save() {}, async callModel(messages, maxTokens, cfg) {
            calls++;
            for (let i = 0; i < 2; i++) cfg.usageSink({ kind: 'request', outcome: 'transport_error',
                paperId: paper.arxivId, stage: audit.STAGE, model: 'test-model', unitId: cfg.usageContext.unitId });
            throw new Error('模拟两次网络失败');
        } };
        await assert.rejects(audit.run(paper, source, options), /模拟两次/);
        assert.equal(paper.analysisManifest.stages.apiReaderTableAudit.records[0].transportFailures, 2);
        await assert.rejects(audit.run(paper, source, options), /网络失败达到上限/);
        assert.equal(calls, 1); assert.equal(ledger.length, 2);
    } finally { usage.writeLlmUsageEvent = write; }
});
test('只有pass字段或改动来源和正文不能成为审校证明', () => {
    const { paper, source } = sample();
    paper.analysisManifest.stages.apiReaderTableAudit = { contract: audit.CONTRACT, status: 'complete' };
    assert.equal(audit.currentProof(paper, source), false);
    paper.apiReaderArticle += '额外结论';
    assert.throws(() => audit.buildContext(paper, source), /正文SHA/);
});
test('审校许可仅增加真实审校阶段，Reader范围不放行上游，评分范围不放行修复', () => {
    const Module = require('node:module');
    const filename = require.resolve('../scripts/lib/daily-fact-review');
    const scoped = new Module(filename, module); scoped.filename = filename; scoped.paths = module.paths;
    scoped._compile(require('node:fs').readFileSync(filename, 'utf8')
        + '\nmodule.exports.withTestScope = (value, fn) => scope.run(value, fn);', filename);
    const facts = scoped.exports;
    for (const mode of ['readerOnly', 'coreOnly', 'scoringOnly']) {
        facts.withTestScope({ [mode]: true }, () => {
            assert.doesNotThrow(() => facts.assertScoringOnlyModelStageAllowed(audit.STAGE));
            assert.throws(() => facts.assertScoringOnlyModelStageAllowed('primaryAnalysis'));
            if (mode === 'readerOnly') {
                assert.throws(() => facts.assertScoringOnlyModelStageAllowed('coreSummaryRepair'));
                assert.throws(() => facts.assertScoringOnlyModelStageAllowed('scoringAudit'));
            }
            if (mode === 'scoringOnly') assert.throws(() => facts.assertScoringOnlyModelStageAllowed('apiReaderRepair'));
        });
    }
});

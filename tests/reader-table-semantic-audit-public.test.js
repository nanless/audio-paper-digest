'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const utils = require('../scripts/utils');
utils.loadEnvFile = () => {};
process.env.PAPER_ANALYZER_MODEL = 'test-model';
process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
process.env.PAPER_ANALYZER_API_KEY = 'test-only';
const Config = require('../scripts/config');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-table-audit-public-'));
Config.FILES.llmUsageDir = path.join(temporary, 'usage');
let calls = 0;
let repairScenario = false;
let auditCalls = 0;
let stageCalls = [];
const usage = require('../scripts/lib/llm-usage');
usage.writeLlmUsageEvent = event => fs.appendFileSync(path.join(temporary, 'events.jsonl'), JSON.stringify(event) + '\n');
utils.requestLlmJson = async (url, endpoint, model, request, headers, options) => {
    stageCalls.push(options.usageContext.stage);
    calls++;
    const text = require('./fixtures/local-llm-response.cjs').requestText(request);
    let raw;
    if (options.usageContext.stage === 'apiReaderTableAudit') {
        auditCalls++;
        const input = JSON.parse(text.slice(text.lastIndexOf('待审输入：') + '待审输入：'.length).trim());
        const statement = '下表要回答当前比较是否在统一条件下成立，因此先固定控制变量、数据集、指标方向和对照系统。';
        const issues = repairScenario && auditCalls === 1 ? [{ statementQuote: statement,
            sourceQuote: 'The source reports a controlled measurement of 1.0 under the same protocol.', message: '需明确当前行测量值所处的统一协议。',
            correction: '说明本表在相同协议下测量，其他解释保持准确。' }] : [];
        raw = JSON.stringify({ version: 1, inputSha256: input.inputSha256,
            tables: input.tables.map(table => ({ tableIndex: table.tableIndex, issues: table.tableIndex === 1 ? issues : [] })) });
    } else {
        assert.equal(options.usageContext.stage, 'apiReaderRepair');
        const prefix = '允许修改的内容与当前草稿SHA：';
        const input = JSON.parse(text.slice(text.indexOf(prefix) + prefix.length, text.indexOf('与目标相关的论文证据：')).trim());
        const target = input.targets.find(target => target.path.startsWith('/sections/') && typeof target.value === 'string');
        assert.ok(target);
        const changed = target.value.replace('下表要回答当前比较是否在统一条件下成立，因此先固定控制变量、数据集、指标方向和对照系统。',
            '下表在统一协议下测量当前报告值，比较时固定控制变量、数据集、指标方向和对照系统。');
        assert.notEqual(changed, target.value);
        raw = JSON.stringify({ version: 1, draftSha256: input.draftSha256,
            replacements: [{ path: target.path, oldSha256: target.oldSha256, value: changed }] });
    }
    const response = require('./fixtures/local-llm-response.cjs').localLlmResponse(endpoint, model, raw);
    const event = usage.buildLlmUsageEvent({ model, protocol: utils.detectApiType(endpoint, model),
        request, response: response.body, statusCode: 200, outputText: raw, context: options.usageContext });
    if (options.usageSink) options.usageSink(event); else usage.writeLlmUsageEvent(event);
    return response;
};
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const audit = require('../scripts/lib/reader-table-semantic-audit');
test('普通刷新旧完整正文只追加表格审校，公共路由和检查点保留原Reader', async () => {
    const { paper, sourceDetails } = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(80) });
    const scored = require('./valid-analysis-fixture').validAnalysisPaper(paper.arxivId);
    paper.analysis = scored.analysis; paper.parsed = utils.parseAnalysis(scored.analysis);
    paper.analysisManifest.stages.scoringAudit = { ...scored.analysisManifest.stages.scoringAudit,
        audit: {}, auditSha256: require('../scripts/lib/fresh-rewrite-run').stableHash({}),
        outputAnalysisSha256: require('../scripts/lib/fresh-rewrite-run').sha256(paper.analysis) };
    paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = null;
    paper.freshRewriteProvenance.sourceManifestSha256 = 'b'.repeat(64);
    paper.analysisManifest.freshRewriteProvenance.sourceManifestSha256 = 'b'.repeat(64);
    const beforeArticle = paper.apiReaderArticle;
    const beforePlan = structuredClone(paper.apiReaderPlan);
    let saves = 0;
    paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')] = () => saves++;
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    const result = await deep.refreshApiReaderArticleFromSource(paper, sourceDetails);
    assert.equal(calls, 1);
    assert.equal(result.apiReaderArticle, beforeArticle);
    assert.deepEqual(result.apiReaderPlan, beforePlan);
    assert.equal(result.analysisManifest.stages.apiReaderTableAudit.status, 'complete');
    assert.ok(saves >= 2);
    assert.equal(audit.currentProof(result, sourceDetails), true);
    assert.equal(fs.readFileSync(path.join(temporary, 'events.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('普通审校发现问题后走既有Reader局部补丁，再整篇解析和重新审校', async () => {
    repairScenario = true; calls = 0; auditCalls = 0; stageCalls = [];
    const { paper, sourceDetails } = require('./reader-signed-draft-fixture').fixture({ noFigures: true,
        sourceText: 'The source reports a controlled measurement of 1.0 under the same protocol. '.repeat(80) });
    const scored = require('./valid-analysis-fixture').validAnalysisPaper(paper.arxivId);
    paper.analysis = scored.analysis; paper.parsed = utils.parseAnalysis(scored.analysis);
    paper.analysisManifest.stages.scoringAudit = { ...scored.analysisManifest.stages.scoringAudit,
        audit: {}, auditSha256: require('../scripts/lib/fresh-rewrite-run').stableHash({}),
        outputAnalysisSha256: require('../scripts/lib/fresh-rewrite-run').sha256(paper.analysis) };
    paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256 = null;
    paper.freshRewriteProvenance.sourceManifestSha256 = 'b'.repeat(64);
    paper.analysisManifest.freshRewriteProvenance.sourceManifestSha256 = 'b'.repeat(64);
    const before = paper.apiReaderArticle;
    const upstream = structuredClone({ analysis: paper.analysis, parsed: paper.parsed,
        stages: Object.fromEntries(Object.entries(paper.analysisManifest.stages)
            .filter(([name]) => name !== 'apiReaderArticle' && name !== 'apiReaderTableAudit')) });
    const resourceSync = require('../scripts/lib/reader-resource-sync');
    const originalSync = resourceSync.synchronizeReaderResourceAvailability;
    let resourceSyncCalls = 0;
    resourceSync.synchronizeReaderResourceAvailability = () => {
        resourceSyncCalls++;
        throw new Error('表格审校不得同步主文资源状态');
    };
    let result;
    try { result = await deep.refreshApiReaderArticleFromSource(paper, sourceDetails); }
    finally { resourceSync.synchronizeReaderResourceAvailability = originalSync; }
    assert.equal(resourceSyncCalls, 0);
    assert.deepEqual({ analysis: result.analysis, parsed: result.parsed,
        stages: Object.fromEntries(Object.entries(result.analysisManifest.stages)
            .filter(([name]) => name !== 'apiReaderArticle' && name !== 'apiReaderTableAudit')) }, upstream);
    assert.deepEqual(stageCalls, ['apiReaderTableAudit', 'apiReaderRepair', 'apiReaderTableAudit']);
    assert.equal(calls, 3);
    assert.notEqual(result.apiReaderArticle, before);
    assert.equal(result.analysisManifest.stages.apiReaderTableAudit.records.length, 2);
    assert.equal(engine.hasValidApiReaderV3Records(result), true);
    assert.equal(audit.currentProof(result, sourceDetails), true);
});

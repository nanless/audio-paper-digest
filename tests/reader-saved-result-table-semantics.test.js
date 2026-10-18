'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const engine = require('../scripts/analysis-engine');
const { extractMarkdownTables } = require('../scripts/analysis-contract');
const { fixture } = require('./reader-signed-draft-fixture');
const paid = require('./fixtures/reader-resource-paid-tail-20261018.json').cases.find(row => row.name === 'zhang');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function reseal(paper) {
    const plan = paper.apiReaderPlan, stage = paper.analysisManifest.stages.apiReaderArticle;
    extractMarkdownTables(paper.apiReaderArticle).forEach((table, index) => {
        plan.tableBindings[index].renderedTableSha256 = sha(table.markdown);
    });
    plan.sourceBindingsSha256 = deep.stableFingerprint({
        tableBindings: plan.tableBindings, formulaBindings: plan.formulaBindings
    });
    paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
    Object.assign(stage, { articleSha256: paper.apiReaderArticleSha256,
        planSha256: paper.apiReaderPlanSha256, sourceBindingsSha256: plan.sourceBindingsSha256 });
}
function replaceFirstTable(paper, markdown) {
    const before = extractMarkdownTables(paper.apiReaderArticle)[0].markdown;
    paper.apiReaderArticle = paper.apiReaderArticle.replace(before, markdown);
    reseal(paper);
}
function assertOnlySemanticFailure(t, paper) {
    const before = JSON.stringify(paper);
    // Independently prove the existing signatures and all other saved-record
    // checks remain valid; a hash mismatch must not masquerade as this fix.
    const mock = t.mock.method(deep, 'readerPlaceholderResultTableIssues', () => []);
    try { assert.equal(engine.hasValidApiReaderV3Records(paper), true); }
    finally { mock.mock.restore(); }
    for (const options of [{}, { legacyConferenceResourceBindings: true },
        { conferencePublicationEvidence: true },
        { legacyConferenceResourceBindings: true, conferencePublicationEvidence: true }]) {
        assert.equal(engine.hasValidApiReaderV3Records(paper, options), false);
        const diagnostics = engine.getApiReaderV3RecordDiagnostics(paper, options);
        assert.ok(diagnostics.some(issue => issue.check === 'reader_result_table_semantics'
            && issue.code === 'reader_placeholder_result_table'
            && issue.path === '/apiReaderArticle'));
        assert.ok(diagnostics.some(issue => issue.path === '/apiReaderPlan/tableBindings/0'));
    }
    assert.equal(JSON.stringify(paper), before, '资格核验不得改写原正文、签名、阶段、次数或费用');
}

test('旧完整签稿同步全部哈希后仍拒绝占位结果表，所有 legacy 出版选项一致', t => {
    const { paper } = fixture({ noFigures: true });
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
    replaceFirstTable(paper, '| 来源证据 | 量化值一 |\n|---|---|\n| 来源句一 | 1.0 |');
    assertOnlySemanticFailure(t, paper);
});

test('真实付费 Zhang 坏表不能靠完整保存签名取得三流程共用资格', t => {
    const quotes = paid.draft.tableBindings[0].sourceQuotes;
    const sourceText = ['The source reports a controlled measurement of 1.0 under the same protocol.', ...quotes].join('\n');
    const { paper } = fixture({ noFigures: true, sourceText });
    const bad = extractMarkdownTables(paid.draft.sections[8].body)[0];
    assert.match(bad.markdown, /量化值一/);
    assert.match(bad.markdown, /3830/);
    paper.apiReaderPlan.tableBindings[0].sourceQuotes = quotes.map(quote => ({
        quote, sourceQuoteSha256: sha(quote)
    }));
    replaceFirstTable(paper, bad.markdown);
    assertOnlySemanticFailure(t, paper);
});

test('li26f 式来源首列配真实指标以及普通来源说明表仍通过完整保存稿核验', () => {
    for (const markdown of [
        '| 来源证据 | 报告值 |\n|---|---|\n| 统一协议 | 1.0 |',
        '| 来源证据 | 原文引句 | 解释 |\n|---|---|---|\n| 来源句一 | 原文说明测量协议 | 只是来源解释 |'
    ]) {
        const { paper } = fixture({ noFigures: true });
        replaceFirstTable(paper, markdown);
        const before = JSON.stringify(paper);
        assert.equal(engine.hasValidApiReaderV3Records(paper), true);
        assert.deepEqual(engine.getApiReaderV3RecordDiagnostics(paper), []);
        assert.equal(JSON.stringify(paper), before);
    }
});

test('正文代码围栏中的占位表示例不被当成实际结果表', () => {
    const { paper } = fixture({ noFigures: true });
    paper.apiReaderArticle += '\n\n```markdown\n| 来源证据 | 量化值一 |\n|---|---|\n| 来源句一 | 2025 |\n```';
    reseal(paper);
    assert.equal(engine.hasValidApiReaderV3Records(paper), true);
});

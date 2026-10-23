'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const table = (left = '3×10⁻⁴', right = '2×10⁻⁵') =>
    `| Setting | Value |\n| --- | --- |\n| A | ${left} |\n| B | ${right} |`;
const source = 'Original learning-rate settings are listed below.\n3×10⁻⁴\n2×10⁻⁵\nEnd of original settings.';
function bind(article, sourceText = source, quotes = [sourceText], options = {}) {
    return deep.bindApiReaderSourceEvidence(article, [{ tableIndex: 1, sourceType: 'source_quotes',
        sourceTableOrdinal: null, cellBindings: [], sourceQuotes: quotes }], [], {
        sourceText, structuredArtifacts: deep.bindStructuredArtifactsToText({ tables: [], formulas: [] }, sourceText),
        allowDeterministicQuoteRepair: false, allowDeterministicUnsupportedClaimPruning: false, ...options
    });
}

test('公开原文完整连续配置引文支持上标科学量，原稿原quote不改写', () => {
    const f = require('./fixtures/core-summary-training-codec-handoff-20261023-real.json');
    const excerpt = f.papers.find(p => p.paperId === '2610.31415').sourceExcerpts[1];
    assert.equal(sha(excerpt.text), excerpt.sha256);
    assert.match(excerpt.text, /3×10−43\\times 10\^\{-4\}/);
    for (const repair of [false, true]) for (const prune of [false, true]) {
        const result = bind(table(), excerpt.text, [excerpt.text], {
            allowDeterministicQuoteRepair: repair, allowDeterministicUnsupportedClaimPruning: prune });
        assert.equal(result.article, table());
        assert.deepEqual(result.tableBindings[0].sourceQuotes.map(item => item.quote), [excerpt.text]);
    }
});

test('原有同值TeX双份正常显示投影仍可绑定完整原引文', () => {
    const f = require('./fixtures/core-summary-training-codec-handoff-20261023-real.json');
    const quote = f.papers.find(p => p.paperId === '2610.31415').sourceExcerpts[1].text;
    // Mechanical rendering variant; source remains the unchanged public quote.
    const article = table('3×10−43{\\times}10^{-4}', '2×10−52{\\times}10^{-5}');
    const expected = deep.normalizeApiReaderTablePasteArtifacts(article);
    assert.notEqual(expected, article);
    const result = bind(article, quote);
    assert.equal(result.article, expected);
    assert.deepEqual(result.tableBindings[0].sourceQuotes.map(item => item.quote), [quote]);
});

// All mutations below are mechanical negative fixtures, not real paid drafts.
test('严格真实source_quotes消费者拒绝错指数、符号、缺指数及下标，不剪行洗成功', () => {
    assert.equal(bind(table()).article, table());
    for (const value of ['3×10⁻⁹', '3×10⁺⁴', '3×10', '3×10₋₄', '7×10⁻⁴',
        '3.0×10⁻⁴', '3×10⁻⁴ ms', '3×10⁻⁴ kg', '3×10⁻⁴ /s', '3×10⁻⁴ 秒',
        '3×10⁻⁴foo', '3×10⁻⁴†', '3\\unknown10^{-4}', '3×10⁻⁴，训练参数',
        '3×10⁻⁴（学习率）', '3×10⁻⁴ (ms)', '3×10⁻⁴ 3', 'label 3×10⁻⁴']) {
        for (const repair of [false, true]) for (const prune of [false, true]) {
            assert.throws(() => bind(table(value), source, [source], {
                allowDeterministicQuoteRepair: repair, allowDeterministicUnsupportedClaimPruning: prune }),
            /科学量|exact quote\/cell/, value);
        }
    }
});

test('完整科学量不借另一值、跨quote、跨行或矛盾TeX分支的后缀', () => {
    for (const [text, quotes] of [
        ['Original quantities:\n3×10⁻⁵\n2×10⁻⁴\nEnd of settings.'],
        ['Original coefficient is 3.\nOriginal exponent is -4.\nOriginal base is 10.'],
        ['Original quantity:\n3×10\n⁻⁴\nEnd of settings.'],
        ['Original quantity:\n3×10−43\\times 10^{-5}\n2×10⁻⁵\nEnd of settings.'],
        ['Original quantity:\n3×10−44\\times 10^{-4}\n2×10⁻⁵\nEnd of settings.'],
        ['Coefficient for this setting is 3×10. Exponent for this setting is ⁻⁴.',
            ['Coefficient for this setting is 3×10.', 'Exponent for this setting is ⁻⁴.']]
    ]) assert.throws(() => bind(table(), text, quotes || [text]), /科学量|exact quote\/cell/, text);
    const unitSource = 'Original quantities:\n3×10⁻⁴ ms\n2×10⁻⁵ Hz\nEnd of settings.';
    assert.equal(bind(table('3×10⁻⁴ ms', '2×10⁻⁵ Hz'), unitSource).article,
        table('3×10⁻⁴ ms', '2×10⁻⁵ Hz'));
    for (const value of ['3×10⁻⁴ s', '3×10⁻⁴', '3×10⁻⁴ Hz', '3×10⁻⁴ ms/s',
        '3×10⁻⁴ ms / s', '3×10⁻⁴ ms/kg', '3×10⁻⁴ mss', '3×10⁻⁴ MS'])
        assert.throws(() => bind(table(value, '2×10⁻⁵ Hz'), unitSource), /科学量|exact quote\/cell/);
    assert.throws(() => bind(table('3×10', '⁻⁴')), /科学量|exact quote\/cell/);
    assert.throws(() => bind(table() + '\n| Separate scalar | 4 |'), /exact quote\/cell/,
        'a supported scientific cell cannot remove the ordinary scalar from another cell');
    for (const value of ['\\(3\\times10^{-9}\\)', '\\(3\\times10^{-4}', '3\\times10^{-4}\\)',
        '\\(3\\times10^{-4}\\) ms', '\\(3\\times10^{-4} + 1\\)'])
        assert.throws(() => bind(table(value)), /科学量|exact quote\/cell/);
});

test('全角或混合底数只触发拒绝，不能借普通数字绕过科学量门', () => {
    const text = source + '\nA separate scalar observation was 9.';
    assert.equal(bind(table(), text).article, table());
    assert.throws(() => bind(table('3×10⁻⁹'), text), /科学量|exact quote\/cell/);
    for (const value of ['3×１０⁻⁹', '3×１0⁻⁹', '3×1０⁻⁹', '3\\times１０^{-9}',
        '３×１０⁻⁹', '3×１０⁻⁴', '3×𝟙𝟘⁻⁹', '3×¹⁰⁻⁹', '3×₁₀⁻⁹', '3×⑩⁻⁹']) {
        for (const repair of [false, true]) for (const prune of [false, true])
            assert.throws(() => bind(table(value), text, [text], {
                allowDeterministicQuoteRepair: repair, allowDeterministicUnsupportedClaimPruning: prune }),
            /科学量|exact quote\/cell/, value);
    }
    assert.equal(bind(table('3×2'), text).article, table('3×2'),
        'ordinary multipliers remain under the unchanged scalar rules');
});

test('普通HTML精确引用跨行单位仍按原legacy集合剪裁，不能静默删合法行', () => {
    const quotes = ['The first latency is 1', 'ms per inference, while the baseline is 2 ms.'];
    const text = quotes.join('\n');
    const article = '| Method | Latency |\n| --- | --- |\n| Current | 1 ms |\n| Baseline | 2 ms |';
    for (const repair of [false, true]) for (const prune of [false, true]) {
        const result = bind(article, text, quotes, { allowDeterministicQuoteRepair: repair,
            allowDeterministicUnsupportedClaimPruning: prune });
        assert.equal(result.article, article);
        assert.deepEqual(result.tableBindings[0].sourceQuotes.map(item => item.quote), quotes);
    }
});

test('保存稿自洽SHA冷核仍拒错科学量，原合法稿保留', () => {
    const engine = require('../scripts/analysis-engine');
    const { validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture');
    const original = validLegacyApiAnalysisPaper('2601.12345');
    assert.equal(engine.hasValidApiReaderV3Records(original), true);
    function paperWith(value) {
        const paper = structuredClone(original), article = table(value);
        paper.apiReaderArticle += '\n\n' + article;
        const plan = paper.apiReaderPlan, stage = paper.analysisManifest.stages.apiReaderArticle;
        plan.tableBindings = [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            renderedTableSha256: sha(article), cellBindings: [], sourceQuotes: [{ quote: source, sourceQuoteSha256: sha(source) }] }];
        plan.sourceBindingsSha256 = deep.stableFingerprint({ tableBindings: plan.tableBindings, formulaBindings: [] });
        paper.apiReaderPlanSha256 = deep.stableFingerprint(plan);
        paper.apiReaderArticleSha256 = sha(paper.apiReaderArticle);
        Object.assign(stage, { planSha256: paper.apiReaderPlanSha256, articleSha256: paper.apiReaderArticleSha256,
            sourceBindingsSha256: plan.sourceBindingsSha256, tableBindingCount: 1 });
        return paper;
    }
    assert.equal(engine.hasValidApiReaderV3Records(paperWith('3×10⁻⁴')), true);
    for (const value of ['3×10⁻⁹', '3×10⁺⁴', '3×10', '3×10₋₄', '3×10⁻⁴ ms'])
        assert.equal(engine.hasValidApiReaderV3Records(paperWith(value)), false, value);
});

test('科学量实现叶的实际字节进入Reader阶段指纹，上游指纹不变', t => {
    const fs = require('node:fs');
    const implementation = require.resolve('../scripts/lib/reader-scientific-quote-coverage');
    const { validLegacyApiAnalysisPaper } = require('./valid-analysis-fixture');
    const paper = validLegacyApiAnalysisPaper('2601.12345');
    const before = deep.buildRecoveryFingerprints(paper, 'same source', paper.arxivId);
    const read = fs.readFileSync;
    // Change only the bytes observed by the real fingerprint builder. No
    // project file is changed and no business/model entry is invoked.
    t.mock.method(fs, 'readFileSync', function(file, ...args) {
        const bytes = read.call(this, file, ...args);
        return file === implementation ? bytes + '\n// subsequent leaf revision\n' : bytes;
    });
    const after = deep.buildRecoveryFingerprints(paper, 'same source', paper.arxivId);
    assert.notEqual(after.apiReaderArticle, before.apiReaderArticle);
    for (const stage of ['primaryAnalysis', 'demoLinkScan', 'imageSupplement'])
        assert.equal(after[stage], before[stage], stage);
});

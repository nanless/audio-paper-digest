'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeDifference, diagnoseReaderTableSource, buildReaderSourceDiagnostics, readerNumericSpellingGuidance } =
    require('../scripts/lib/reader-source-diagnostics.js');

const sha = 'a'.repeat(64);
function table(matrix, ordinal = 1) {
    return { ordinal, matrix, headerRows: [0], recoveryStatus: 'complete', sourceDomSha256: sha,
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c,
            text, header: r === 0, sourceDomSha256: sha }))) };
}
function diagnose(renderedRows, sourceTable, options = {}) {
    return diagnoseReaderTableSource({ binding: { sourceType: 'source_quotes', sourceTableOrdinal: null,
        cellBindings: [], sourceQuotes: [] }, bindingIndex: 2, sectionIndex: 4, renderedRows,
    failures: [{ renderedRow: 1, renderedColumn: 1 }], structuredArtifacts: { tables: [sourceTable] },
    sourceText: sourceTable.matrix.map(row => row.join('\n')).join('\n'), ...options });
}

test('percent declared in source header diagnoses body edit and exact DOM coordinates', () => {
    const source = table([['Method', 'Accuracy (%)'], ['Model-A', '96.4']]);
    const [issue] = diagnose([['Method', 'Accuracy (%)'], ['Model-A', '96.4%']], source, {
        binding: { sourceType: 'artifact_table', sourceTableOrdinal: 1, cellBindings: [
            { renderedRow: 1, renderedColumn: 1, sourceRow: 1, sourceColumn: 1 }] }
    });
    assert.equal(issue.path, '/sections/4/body');
    assert.equal(issue.bindingPath, '/tableBindings/2');
    assert.equal(issue.candidates[0].text, '96.4');
    assert.equal(issue.candidates[0].difference, 'percent_in_source_header');
    assert.equal(issue.candidates[0].matchBasis, 'declared_dom_coordinate');
    assert.equal(issue.candidates[0].columnHeaders[0].text, 'Accuracy (%)');
    assert.match(issue.message, /不能逐格追加%/);
});

test('percent moved into an independent column points back to original suffixed cell', () => {
    const source = table([['Method', 'Accuracy'], ['Model-B', '96.4%'], ['Model-C', '3.3%']]);
    const [issue] = diagnose([['方法', '准确率', '单位'], ['Model-B', '96.4', '%']], source);
    assert.equal(issue.candidates.length, 1);
    assert.equal(issue.candidates[0].sourceRow, 1);
    assert.equal(issue.candidates[0].text, '96.4%');
    assert.equal(issue.candidates[0].difference, 'percent_position_differs');
    assert.match(issue.message, /仅补sourceQuotes不能修复/);
    assert.ok(issue.sourceQuotes.every(item => source.matrix.map(row => row.join('\n')).join('\n').includes(item.quote)));
});

test('same number in unrelated rows and bibliography cannot discover a candidate', () => {
    const source = table([['Reference', 'Count'], ['Reference-X', '96.4%']]);
    const [issue] = diagnose([['Method', 'Accuracy'], ['Model-B', '96.4']], source,
        { sourceText: 'References\n[96] Model-B produced a result.\n96.4%' });
    assert.deepEqual(issue.candidates, []);
    assert.deepEqual(issue.sourceQuotes, []);
    assert.match(issue.message, /未找到有行列语义锚点/);
});

test('row and metric anchors outrank a numeric coincidence in a different metric', () => {
    const source = table([['Method', 'WER', 'CER'], ['Model-A', '3.345%', '3.3%']]);
    const [issue] = diagnose([['Method', 'WER'], ['Model-A', '3.3%']], source);
    assert.equal(issue.candidates[0].sourceColumn, 1);
    assert.equal(issue.candidates[0].difference, 'possible_rounding');
    assert.equal(issue.candidates.length, 2); // Ambiguity stays explicit, not a chosen answer.
});

test('spelling classifications never equate different units or numeric scaling', () => {
    assert.equal(describeDifference('1234', '1,234'), 'thousands_separator_differs');
    assert.equal(describeDifference('1.2', '1.234'), 'possible_rounding');
    assert.equal(describeDifference('1 s', '1 ms'), 'unit_spelling_differs');
    assert.equal(describeDifference('0.964', '96.4%'), 'different_source_value');
    assert.equal(describeDifference('3.3%', '3.345 ms'), 'different_source_value');
});

test('diagnostics preserve input and refuse cells without DOM provenance', () => {
    const source = table([['Method', 'WER'], ['Model-A', '3.3%']]);
    source.cells[3].sourceDomSha256 = null;
    const before = JSON.stringify(source);
    const [issue] = diagnose([['Method', 'WER'], ['Model-A', '3.3']], source);
    assert.deepEqual(issue.candidates, []);
    assert.equal(JSON.stringify(source), before);
});

test('non source failures do not add speculative numeric diagnostics', () => {
    assert.deepEqual(buildReaderSourceDiagnostics({ draft: {}, parserError: new Error('文章篇幅不足') }), []);
});

test('public wrapper locates the exact candidate body after another selection marker', () => {
    const source = table([['Method', 'WER'], ['Model-A', '3.3%']]);
    const draft = { sections: [{ kind: 'background', body: '[[TABLE_1]]' },
        { kind: 'result', body: '| Method | WER |\n| --- | --- |\n| Model-A | 3.3 |' }],
    tableBindings: [{ tableIndex: 1, selection: {} }, { tableIndex: 2,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [] }] };
    const issues = buildReaderSourceDiagnostics({ draft, structuredArtifacts: { tables: [source] },
        sourceText: 'Method\nWER\nModel-A\n3.3%',
        parserError: new Error('读者文章 tableBindings[1] 关键数字缺少 exact quote/cell 证据: 3.3；row=1,column=1 text="3.3"') });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, '/sections/1/body');
    assert.equal(issues[0].bindingPath, '/tableBindings/1');
    assert.equal(issues[0].candidates[0].text, '3.3%');
    assert.match(issues[0].message, /原文候选上下文 L3/);
});

test('a declared source sentence supports a percentage-placement hint without a matching DOM table', () => {
    const quote = 'For named entities, Hybrid Search recovers 96.4% of the improvement achieved by beam search.';
    const [issue] = diagnose([['指标', '比例', '单位'], ['命名实体改善恢复', '96.4', '%']],
        table([['Method', 'WER'], ['Other', '12.1']]), { sourceText: quote,
            binding: { sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [quote] } });
    assert.deepEqual(issue.candidates, []);
    assert.equal(issue.quoteCandidates[0].text, '96.4%');
    assert.match(issue.message, /该句是否对应本行实验仍须/);
});

test('unrelated global prose, fabricated quotes and reference numbers are never suggested', () => {
    const bibliography = '[96] Model A. Benchmark improvements. 4% of data.';
    const [issue] = diagnose([['方法', '数值'], ['模型', '4']], table([['Method', 'WER'], ['Other', '12.1']]),
        { sourceText: 'The method achieved 4% gain.\n' + bibliography,
            binding: { sourceQuotes: [bibliography, 'The invented model achieved 4% gain.'] } });
    assert.deepEqual(issue.quoteCandidates, []);
    assert.deepEqual(issue.candidates, []);
});

test('Chinese row labels get table-only context with two English anchors despite all-header source metadata', () => {
    const source = table([['System', 'Require-ITN (%)', 'Forbid-ITN (%)'],
        ['System', 'I-CER', 'FSPR'], ['Cascaded', '8.19', '25.60'],
        ['FunASR-Nano', '58.76', '95.18'], ['DF-ASR', '4.64', '95.18']]);
    source.headerRows = [0, 1, 2, 3, 4];
    source.cells.forEach(cell => { cell.header = true; });
    const before = JSON.stringify(source);
    const rendered = [['系统', '误差', '保留率'], ['级联WFST', '8.19%', '25.60%'],
        ['FunASR-Nano', '58.76%', '95.18%'], ['DF-ASR', '4.64%', '95.18%']];
    const [issue, next] = diagnose(rendered, source, { failures: [
        { renderedRow: 1, renderedColumn: 1 }, { renderedRow: 1, renderedColumn: 2 }] });
    assert.deepEqual(issue.candidates, []);
    assert.equal(issue.tableContexts.length, 1);
    assert.deepEqual(issue.tableContexts[0].sharedAnchors, ['funasr-nano', 'df-asr']);
    assert.equal(issue.tableContexts[0].rowCorrespondenceConfirmed, false);
    assert.equal(issue.tableContexts[0].rows[0].cells[1], 'Require-ITN (%)');
    assert.equal(issue.tableContexts[0].rows[2].cells[0], 'Cascaded');
    assert.equal(next.tableContexts, undefined);
    assert.match(issue.message, /不强制改用artifact_table/);
    assert.equal(JSON.stringify(source), before);
    const [singleAnchor] = diagnose(rendered.slice(0, 3), source);
    assert.equal(singleAnchor.tableContexts, undefined);
});

test('explicit per-cell missing token diagnoses Chinese mixed prose against declared original percentage', () => {
    const quote = 'Hybrid Search further reduces average NE-ER by 3.3% while maintaining comparable WER.';
    const draft = { sections: [{ body: '| 方法 | 增量 | 单位 |\n| --- | --- | --- |\n| 方案 | 额外降低3.3 | % |' }],
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceQuotes: [quote] }] };
    const [issue] = buildReaderSourceDiagnostics({ draft, sourceText: quote, structuredArtifacts: { tables: [] },
        parserError: new Error('读者文章 tableBindings[0] 关键数字缺少 exact quote/cell 证据: 3.3；row=1,column=1 text="额外降低3.3" missing=3.3。请核对单位。') });
    assert.equal(issue.renderedCell.text, '额外降低3.3');
    assert.equal(issue.quoteCandidates[0].text, '3.3%');
    assert.equal(issue.quoteCandidates[0].comparedRenderedToken, '3.3');
    const [mismatchedToken] = diagnose([['方法', '数值'], ['方案', '约150']], table([['x', 'y']]),
        { binding: { sourceQuotes: [quote] }, sourceText: quote,
            failures: [{ renderedRow: 1, renderedColumn: 1, missingTokens: ['3.3'] }] });
    assert.deepEqual(mismatchedToken.quoteCandidates, []);
});

test('unique whitespace-only quote recovery returns original newlines and thin spaces, not a rewritten quote', () => {
    const original = 'PESQ-gradient masking is computed once\nper clip and adds roughly\n150\u2009ms, with 21\u2009ms vs. 171\u2009ms latency.';
    const declared = original.replace(/\s+/g, ' ');
    const options = { binding: { sourceQuotes: [declared] }, sourceText: original,
        failures: [{ renderedRow: 1, renderedColumn: 1, missingTokens: ['150'] }] };
    const [issue] = diagnose([['方案', '延迟'], ['掩蔽增量', '约150']], table([['x', 'y']]), options);
    assert.equal(issue.quoteCandidates[0].quote, original);
    assert.equal(issue.quoteCandidates[0].text, '150\u2009ms');
    assert.equal(issue.quoteCandidates[0].whitespaceRecovered, true);
    assert.equal(issue.quoteCandidates[0].lineEnd, 3);
    assert.match(issue.message, /须复制此原始字节/);
    const [ambiguous] = diagnose([['方案', '延迟'], ['掩蔽增量', '约150']], table([['x', 'y']]),
        { ...options, sourceText: original + '\n' + declared });
    assert.deepEqual(ambiguous.quoteCandidates, []);
    const [changed] = diagnose([['方案', '延迟'], ['掩蔽增量', '约150']], table([['x', 'y']]),
        { ...options, sourceText: original.replace('roughly', 'exactly') });
    assert.deepEqual(changed.quoteCandidates, []);
});

test('first-attempt spelling guidance states both unit conventions without granting source equivalence', () => {
    const notice = readerNumericSpellingGuidance();
    assert.match(notice, /171 ms、96.4%/);
    assert.match(notice, /独立单位列不能替代/);
    assert.match(notice, /原表头单位与裸格/);
    assert.match(notice, /逗号和小数精度/);
    assert.match(notice, /换行\/空白/);
    assert.match(notice, /完整来源门禁/);
});

test('canonical missing token cannot turn an explicit two-decimal cell into an integer-rounding guess', () => {
    const quote = 'The proposed model reports a value of 2.35% on the named benchmark.';
    const [issue] = diagnose([['方法', '比例'], ['级联模型', '2.00%']], table([['x', 'y']]),
        { sourceText: quote, binding: { sourceQuotes: [quote] },
            failures: [{ renderedRow: 1, renderedColumn: 1, missingTokens: ['2%'] }] });
    assert.deepEqual(issue.quoteCandidates, []);
});

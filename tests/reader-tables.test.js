'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { renderReaderTableSelection, compileReaderTableSelections,
    assessReaderTableSelectionEligibility, findReaderTablePasteDuplication,
    hasExplicitRepeatedScientificMeasurement, effectiveReaderTableRows,
    canonicalizeReaderSelectionRows } = require('../scripts/lib/reader-tables.js');

function artifactsFixture() {
    const { parseArxivStructuredArtifactsFromHtml, bindStructuredArtifactsToText } = require('../scripts/deep-analyzer.js');
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/arxiv-reader-source-bindings.html'), 'utf8');
    const sourceText = cheerio.load(html)('body').text();
    return { sourceText, artifacts: bindStructuredArtifactsToText(parseArxivStructuredArtifactsFromHtml(html,
        '2609.00001v1', '2609.00001v1'), sourceText) };
}
const selected = (tableIndex = 1, ordinal = 1) => ({ tableIndex, selection: {
    sourceTableOrdinal: ordinal, sourceRows: ordinal === 1 ? [1, 2, 3] : [0, 1, 2], sourceColumns: [0, 1, 2]
} });

test('table evidence explicitly supplies source header rows and shape without guessing its scientific role', () => {
    const { artifacts } = artifactsFixture();
    const evidence = require('../scripts/deep-analyzer.js').buildApiReaderArtifactEvidence(artifacts);
    const headerRows = JSON.parse(evidence.match(/^TABLE_1_HEADER_ROWS: (.+)$/m)[1]);
    const shape = JSON.parse(evidence.match(/^TABLE_1_SHAPE: (.+)$/m)[1]);
    assert.deepEqual(headerRows, [0, 1]);
    assert.deepEqual(shape, { rows: 4, columns: 3, shownRows: 4, role: 'unknown' });
    assert.ok(headerRows.includes(selected().selection.sourceRows[0]));
    assert.equal(JSON.parse(evidence.match(/^TABLE_1_SELECTION: (.+)$/m)[1]).eligible, true);
    const authors = structuredClone(artifacts);
    authors.tables[0].caption = 'Authors and affiliations';
    const authorEvidence = require('../scripts/deep-analyzer.js').buildApiReaderArtifactEvidence(authors);
    assert.match(authorEvidence, /TABLE_1_SHAPE: .*"role":"unknown"/);
});

test('dirty MathML, blank headers and all-header rows are rejected before selection with evidence-visible reasons', () => {
    const { artifacts } = artifactsFixture();
    const table = structuredClone(artifacts.tables[1]);
    table.matrix[0][0] = '';
    table.matrix[0][1] = '';
    table.matrix[1][1] = '2.222.22';
    table.matrix[2][1] = '3.093.09';
    table.headerRows = [0, 1, 2];
    for (const cell of table.cells) {
        cell.header = true;
        cell.text = table.matrix[cell.row][cell.column];
    }
    const before = JSON.stringify(table);
    const result = assessReaderTableSelectionEligibility(table);
    assert.equal(result.eligible, false);
    assert.ok(result.reasonCodes.includes('empty_source_header'));
    assert.ok(result.reasonCodes.includes('no_explicit_data_rows'));
    assert.ok(result.reasonCodes.includes('source_display_cleanup_required'));
    assert.equal(JSON.stringify(table), before, 'preflight must not clean or reinterpret evidence');
    assert.throws(() => renderReaderTableSelection(selected(1, 2), { tables: [table] }), /eligible=false/);
    const evidence = require('../scripts/deep-analyzer.js').buildApiReaderArtifactEvidence({ tables: [table] });
    const visible = JSON.parse(evidence.match(/^TABLE_2_SELECTION: (.+)$/m)[1]);
    assert.deepEqual(visible, result);
    assert.match(visible.action, /source_quotes/);
});

test('cleanup eligibility is conservative and does not convert arbitrary values or units', () => {
    const { artifacts } = artifactsFixture();
    for (const text of ['2.222.22', '3.093.09', '22.96 ±\\pm 0.08', 'k=\\tilde{k}']) {
        const table = structuredClone(artifacts.tables[1]);
        table.matrix[1][1] = text;
        const result = assessReaderTableSelectionEligibility(table);
        assert.equal(result.eligible, false, text);
        assert.ok(result.reasonCodes.some(code => ['source_display_cleanup_required', 'unresolved_source_tex'].includes(code)));
    }
    for (const text of ['2.22', '3.09', '2.22 dB', '3.09 ms', '2025']) {
        const table = structuredClone(artifacts.tables[1]);
        table.matrix[1][1] = text;
        assert.equal(assessReaderTableSelectionEligibility(table).eligible, true, text);
        assert.equal(table.matrix[1][1], text);
    }
});

test('legacy row-header contagion is repaired only with grouped DOM spans and numeric body semantics', () => {
    const sha = 'a'.repeat(64);
    const matrix = [
        ['SLM', 'Smooth', 'Smooth'],
        ['SLM', '1', '1-2'],
        ['Moshi', '68.0', '61.3'],
        ['VocalNet', '92.0', '94.0']
    ];
    const cells = [
        { row: 0, column: 0, rowspan: 2, colspan: 1, text: 'SLM', header: true, sourceDomSha256: sha },
        { row: 0, column: 1, rowspan: 1, colspan: 2, text: 'Smooth', header: true, sourceDomSha256: sha },
        { row: 1, column: 1, rowspan: 1, colspan: 1, text: '1', header: false, sourceDomSha256: sha },
        { row: 1, column: 2, rowspan: 1, colspan: 1, text: '1-2', header: false, sourceDomSha256: sha },
        ...matrix.slice(2).flatMap((row, offset) => row.map((text, column) => ({
            row: offset + 2, column, rowspan: 1, colspan: 1, text,
            header: true, sourceDomSha256: sha
        })))
    ];
    const legacy = { ordinal: 6, matrix, cells, headerRows: [0, 2, 3], bodyRows: [1],
        recoveryStatus: 'complete', sourceDomSha256: sha };
    const before = JSON.stringify(legacy);
    assert.deepStrictEqual(effectiveReaderTableRows(legacy), {
        headerRows: [0, 1], bodyRows: [2, 3], inferred: true,
        inferenceContract: 'grouped-span-row-header-contagion-v1'
    });
    assert.equal(assessReaderTableSelectionEligibility(legacy).eligible, true);
    const rendered = renderReaderTableSelection({ tableIndex: 1, selection: {
        sourceTableOrdinal: 6, sourceRows: [1, 2, 3], sourceColumns: [0, 1, 2]
    } }, { tables: [legacy] });
    assert.match(rendered.markdown, /^\| SLM \| 1 \| 1-2 \|/);
    assert.equal(rendered.binding.cellBindings.length, 9);
    assert.equal(JSON.stringify(legacy), before, 'compatibility projection must not mutate sealed evidence');

    const counterexamples = [
        value => { value.cells.find(cell => cell.row === 0 && cell.column === 1).colspan = 1; },
        value => { value.cells.find(cell => cell.row === 1 && cell.column === 1).header = true; },
        value => { value.matrix[2][1] = 'not-a-number'; },
        value => { value.headerRows = [0, 2]; },
        value => { value.bodyRows = [1, 3]; }
    ];
    for (const mutate of counterexamples) {
        const value = structuredClone(legacy);
        mutate(value);
        assert.equal(effectiveReaderTableRows(value).inferred, false);
    }
});

test('2512.09066 repeated scientific learning rates need staged semantics while extraction shadows still fail', () => {
    const cell = '10k、5k、2k，5e-5、2e-5、2e-5，批量16';
    assert.match(findReaderTablePasteDuplication(cell), /粘连复写/);
    assert.equal(findReaderTablePasteDuplication(cell, { columnIndex: 2,
        header: ['环节', '需对齐的关键量', '原文口径'],
        row: ['训练优化', '步数、学习率、批量与早停', cell] }), null);
    assert.equal(findReaderTablePasteDuplication(
        's1 学习率 5e-5；s2 学习率 2e-5；s3 学习率 2e-5'), null);
    for (const shadow of ['2.222.22', '3.093.09', '5e-55e-5', '值5e-5、2e-5、2e-5']) {
        assert.ok(findReaderTablePasteDuplication(shadow), shadow);
    }
    assert.ok(findReaderTablePasteDuplication(`2.222.22；${cell}`, { columnIndex: 2,
        header: ['环节', '需对齐的关键量', '原文口径'],
        row: ['训练优化', '步数、学习率、批量与早停', `2.222.22；${cell}`] }),
    'a legitimate learning-rate list cannot hide an unrelated extraction shadow');
    assert.ok(findReaderTablePasteDuplication(`${cell}；2.222.22`, { columnIndex: 2,
        header: ['环节', '需对齐的关键量', '原文口径'],
        row: ['训练优化', '步数、学习率、批量与早停', `${cell}；2.222.22`] }),
    'a legitimate learning-rate list cannot hide a later extraction shadow');
});

test('explicit staged scientific measurements use real whitespace and digit regex tokens', () => {
    assert.equal(hasExplicitRepeatedScientificMeasurement(
        'stage 1 lr 5e-5、2e-5、2e-5'), true);
    assert.equal(hasExplicitRepeatedScientificMeasurement(
        '第 2阶段 学习率 5e-5, 2e-5, 2e-5'), true);
    assert.equal(hasExplicitRepeatedScientificMeasurement(
        '值 5e-5、2e-5、2e-5'), false);
    assert.equal(hasExplicitRepeatedScientificMeasurement(
        'stage 1 lr 5e-5、2e-5、1e-5'), false);
});

test('2512.10571 repeated split sizes require an exact three-way dataset context', () => {
    const cell = '71k / 1k / 1k clips';
    const chineseContext = {
        columnIndex: 2,
        header: ['条件', '指标', '数值', '说明', '来源'],
        row: ['数据规模', '训练/验证/测试', cell,
            'totaling over 197 hours，approximately 10 seconds/clip，720P 24 FPS',
            'AVISet构造']
    };
    assert.equal(findReaderTablePasteDuplication(cell, chineseContext), null);
    assert.equal(findReaderTablePasteDuplication(cell, {
        columnIndex: 2,
        header: ['Dataset', 'Split', 'Size'],
        row: ['AVISet', 'train / validation / test', cell]
    }), null);

    for (const [value, context] of [
        [cell, {}],
        [cell, { columnIndex: 2, header: ['条件', '指标', '数值'],
            row: ['模型配置', '三个阶段', cell] }],
        ['71k / 1k / 1k / 1k clips', chineseContext],
        ['71k / 1k / 1k clips71k / 1k / 1k clips', chineseContext],
        ['1k / 1k /', chineseContext]
    ]) {
        assert.match(findReaderTablePasteDuplication(value, context), /粘连复写/, value);
    }
});

test('source row/column selection preserves multilevel headers, spanning DOM identity, values and legacy v4 output', () => {
    const { artifacts, sourceText } = artifactsFixture();
    const bindings = [selected(), selected(2, 2)];
    bindings[1].selection.sourceColumns = [0, 2, 1];
    const sections = [{ kind: 'result', body: '比较语音识别结果。\n\n[[TABLE_1]]\n\n再看部署成本。\n\n[[TABLE_2]]\n\n比较结束。' }];
    const before = JSON.stringify({ sections, bindings, artifacts });
    const compiled = compileReaderTableSelections(sections, bindings, artifacts);
    assert.equal(JSON.stringify({ sections, bindings, artifacts }), before, 'compiler must not mutate its source/candidate');
    assert.match(compiled.sections[0].body, /\| System \| test-clean \| test-other \|/);
    assert.match(compiled.sections[0].body, /\| System \| Memory \| RTF \|/);
    assert.equal(compiled.tableBindings[0].cellBindings.length, 9);
    assert.deepEqual(compiled.tableBindings[0].cellBindings[0], { renderedRow: 0, renderedColumn: 0, sourceRow: 1, sourceColumn: 0 });
    const bound = require('../scripts/deep-analyzer.js').bindApiReaderSourceEvidence(compiled.sections[0].body,
        compiled.tableBindings, [], { structuredArtifacts: artifacts, sourceText, sections: compiled.sections,
            selectionTableIndexes: compiled.selectionTableIndexes });
    assert.equal(bound.tableBindings.length, 2);
    assert.equal(bound.tableBindings[0].sourceType, 'artifact_table');
    assert.equal(bound.tableBindings[0].cellBindings[0].sourceDomSha256, artifacts.tables[0].cells[0].sourceDomSha256);
    assert.ok(bound.tableBindings.every(binding => !('selection' in binding)));
    assert.match(bound.sourceBindingsSha256, /^[a-f0-9]{64}$/);
});

test('selection deterministically moves or prepends an unambiguous source header without changing data cells', () => {
    const { artifacts } = artifactsFixture();
    assert.deepEqual(canonicalizeReaderSelectionRows([2, 1, 3], [0, 1]), [1, 2, 3]);
    assert.deepEqual(canonicalizeReaderSelectionRows([1, 2], [0]), [0, 1, 2]);
    assert.deepEqual(canonicalizeReaderSelectionRows([2, 3], [0, 1]), [2, 3],
        'multiple absent header candidates remain ambiguous');

    const moved = selected(); moved.selection.sourceRows = [2, 1, 3];
    const movedResult = renderReaderTableSelection(moved, artifacts);
    assert.deepEqual([...new Set(movedResult.binding.cellBindings.map(cell => cell.sourceRow))], [1, 2, 3]);
    const prepended = selected(1, 2); prepended.selection.sourceRows = [1, 2];
    const prependedResult = renderReaderTableSelection(prepended, artifacts);
    assert.deepEqual([...new Set(prependedResult.binding.cellBindings.map(cell => cell.sourceRow))], [0, 1, 2]);
});

test('selection rejects duplicate/out-of-range coordinates, fake headers, mixed payload and malformed source matrices', () => {
    const { artifacts } = artifactsFixture();
    for (const mutate of [
        binding => { binding.selection.sourceRows = [1, 2, 2]; },
        binding => { binding.selection.sourceColumns = [0, 3]; },
        binding => { binding.selection.sourceRows = [2, 3]; },
        binding => { binding.selection.sourceRows = [0, 1, 2]; },
        binding => { binding.selection.sourceColumns = [0, 0]; },
        binding => { binding.sourceQuotes = ['unauthorized']; },
        binding => { binding.selection.sourceRows = [1, '2']; }
    ]) {
        const binding = selected(); mutate(binding);
        assert.throws(() => renderReaderTableSelection(binding, artifacts));
    }
    for (const mutate of [
        table => { table.matrix[1].pop(); },
        table => { table.matrix[2][1] = '999'; },
        table => { delete table.matrix[2][1]; },
        table => { table.cells.push({ ...table.cells[0] }); },
        table => { table.recoveryStatus = 'unrecovered'; }
    ]) {
        const bad = structuredClone(artifacts); mutate(bad.tables[0]);
        assert.throws(() => renderReaderTableSelection(selected(), bad));
    }
});

test('唯一原表头可确定性补回，多级表头仍失败关闭', () => {
    const { artifacts } = artifactsFixture();
    const narrowed = structuredClone(artifacts);
    const binding = selected(1, 2);
    binding.selection.sourceRows = [1, 2];
    const compiled = compileReaderTableSelections(
        [{ kind: 'result', body: '[[TABLE_1]]' }],
        [binding],
        narrowed
    );
    assert.deepEqual(
        compiled.tableBindings[0].cellBindings.slice(0, 3).map(cell => cell.sourceRow),
        [0, 0, 0]
    );
    const rowHeaderNoise = structuredClone(artifacts);
    rowHeaderNoise.tables[1].headerRows = [0, 1];
    rowHeaderNoise.tables[1].cells.forEach(cell => {
        if (cell.row === 1) cell.header = cell.column === 0;
    });
    assert.doesNotThrow(() => compileReaderTableSelections(
        [{ kind: 'result', body: '[[TABLE_1]]' }],
        [selected(1, 2)],
        rowHeaderNoise
    ));
    const highlightedWinner = structuredClone(artifacts);
    highlightedWinner.tables[1].matrix[1] = ['Ours', '70.1', '76.9'];
    highlightedWinner.tables[1].headerRows = [0, 1];
    highlightedWinner.tables[1].cells.filter(cell => cell.row === 1).forEach(cell => {
        cell.header = true;
        cell.text = highlightedWinner.tables[1].matrix[1][cell.column];
    });
    assert.doesNotThrow(() => compileReaderTableSelections(
        [{ kind: 'result', body: '[[TABLE_1]]' }],
        [{ tableIndex: 1, selection: { sourceTableOrdinal: 2,
            sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }],
        highlightedWinner
    ));
    const ambiguous = structuredClone(artifacts);
    const ambiguousBinding = selected();
    ambiguousBinding.selection.sourceRows = [2, 3];
    assert.throws(() => compileReaderTableSelections(
        [{ kind: 'result', body: '[[TABLE_1]]' }],
        [ambiguousBinding],
        ambiguous
    ), /第一行必须是原表头/);
});

test('table marker must be unique, standalone, correctly ordered and fully bound', () => {
    const { artifacts } = artifactsFixture();
    for (const body of ['inline [[TABLE_1]]', '[[TABLE_1]]\n\n[[TABLE_1]]', '[[TABLE_2]]\n\n[[TABLE_1]]']) {
        assert.throws(() => compileReaderTableSelections([{ body }], [selected()], artifacts));
    }
    assert.throws(() => compileReaderTableSelections([{ body: '[[TABLE_2]]\n\n[[TABLE_1]]' }], [selected(), selected(2, 2)], artifacts), /顺序/);
    assert.throws(() => compileReaderTableSelections([{ body: '[[TABLE_1]]' }], undefined, artifacts), /未绑定/);
    assert.throws(() => compileReaderTableSelections([{ body: '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n[[TABLE_1]]' }], [selected()], artifacts), /顺序/);
});

test('unsafe source markup is rejected and final source SHA/cell checks still govern compiled selections', () => {
    const { artifacts, sourceText } = artifactsFixture();
    for (const text of ['a | b', 'line\nbreak', '<script>bad</script>', '[link](javascript:bad)', '[[FIGURE_1]]']) {
        const bad = structuredClone(artifacts);
        bad.tables[0].matrix[2][1] = text;
        bad.tables[0].cells.find(cell => cell.row === 2 && cell.column === 1).text = text;
        assert.throws(() => renderReaderTableSelection(selected(), bad), /Markdown/);
    }
    const compiled = compileReaderTableSelections([{ body: '[[TABLE_1]]' }], [selected()], artifacts);
    const bind = require('../scripts/deep-analyzer.js').bindApiReaderSourceEvidence;
    assert.throws(() => bind(compiled.sections[0].body, compiled.tableBindings, [], {
        structuredArtifacts: artifacts, sourceText: `${sourceText} changed` }), /SHA/);
    assert.throws(() => bind(compiled.sections[0].body.replace('4.8', '4.9'), compiled.tableBindings, [], {
        structuredArtifacts: artifacts, sourceText, allowDeterministicQuoteRepair: true,
        selectionTableIndexes: compiled.selectionTableIndexes }), /不一致/);
});

test('full Reader parser compiles two selected wide tables and still emits the existing v3/v4 contract', () => {
    const { parseArxivStructuredArtifactsFromHtml, bindStructuredArtifactsToText, parseApiReaderArticleResult } = require('../scripts/deep-analyzer.js');
    const header = '<thead><tr><th>System</th><th>WER</th><th>CER</th><th>Latency</th><th>Memory</th></tr></thead>';
    const rows = '<tbody><tr><td>Baseline</td><td>4.8%</td><td>3.1%</td><td>2 ms</td><td>8 GB</td></tr><tr><td>Proposed</td><td>4.1%</td><td>2.9%</td><td>3 ms</td><td>9 GB</td></tr></tbody>';
    const html = `<article>${[1, 2].map(ordinal => `<figure class="ltx_table"><figcaption>Table ${ordinal}: Matched conditions.</figcaption><table class="ltx_tabular">${header}${rows}</table></figure>`).join('')}</article>`;
    const sourceText = cheerio.load(html)('body').text();
    const artifacts = bindStructuredArtifactsToText(parseArxivStructuredArtifactsFromHtml(html, '2609.00001v1', '2609.00001v1'), sourceText);
    const stages = ['background', 'related_work', 'problem', 'method_overview', 'component', 'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const labels = ['任务背景', '相关路线', '目标约束', '方法全景', '核心组件', '训练过程', '数据协议', '主要结果', '消融设计', '局限条件', '复现操作', '研究收束'];
    const angles = ['输入信号', '模型操作', '比较条件', '运行顺序'];
    const prose = '沿着同一个语音样本检查表示如何进入后续模块，并说明哪些变化来自参数学习以及哪些量由实验设置预先固定，读者才能判断方法解释是否与真实计算一致，这里需要结合原文报告的测量方式理解局部结果，明确数据采样和硬件资源对结论的约束，再把相邻模块的信息传递与当前任务所需输出对应起来，使复现工作能够从明确的输入和可观察的中间状态开始逐项核查';
    const sections = stages.map((kind, index) => ({ kind, heading: `${labels[index]}怎样限定这篇论文的技术判断？`,
        body: angles.map(angle => `针对${labels[index]}中的${angle}，${prose}。`).join('\n\n') }));
    const pairs = [['声学表示', '语义特征'], ['训练目标', '损失函数'], ['信息融合', '注意力权重'], ['输入序列', '预测结果']];
    const bridges = pairs.map((terms, index) => ({ terms, sectionKind: 'component', marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
        explanation: `${terms[0]}负责保存当前处理环节的信息，${terms[1]}负责把这些信息映射到下一个计算环节，二者搭配后才能把局部证据和整体预测联系起来，新增的作用是让读者可以沿着实际执行顺序核查信息如何影响最终判断。` }));
    sections[4].body += `\n\n${bridges.map(bridge => bridge.marker).join('\n\n')}`;
    for (const [sectionIndex, tableIndex] of [[6, 1], [7, 2]]) {
        sections[sectionIndex].body += `\n\n针对${labels[sectionIndex]}，这里在相同实验条件下比较各个系统，错误率越低越好，同时保留延迟与内存以核对资源代价。\n\n[[TABLE_${tableIndex}]]\n\n针对${labels[sectionIndex]}，该比较显示错误率与运行成本需要分别判断，较低错误率对应的延迟和内存有所增加，因此研究者需要根据实际资源条件选择适合的配置。`;
    }
    const payload = { version: 3, readerTitle: '从局部语音线索理解模型的执行与实验条件',
        oneSentenceThesis: '这篇解读沿着输入表示和任务预测之间的计算过程解释实验结果，并结合相同条件下的基线比较说明可观察收益及其运行代价。',
        sections, conceptBridges: bridges, figurePlacements: [], formulaBindings: [],
        tableBindings: [1, 2].map(tableIndex => ({ tableIndex, selection: { sourceTableOrdinal: tableIndex,
            sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3, 4] } })) };
    const result = parseApiReaderArticleResult(JSON.stringify(payload), { requiredVersion: 3, requireSourceBindings: true,
        requireIntegratedTables: true, minimumIntegratedTables: 2, structuredArtifacts: artifacts, sourceText });
    assert.equal(result.plan.version, 3);
    assert.equal(result.plan.sourceBindingsContract, 'api-reader-source-bindings-v4');
    assert.equal(result.plan.tableBindings.length, 2);
    assert.equal(result.plan.tableBindings[0].cellBindings.length, 15);
    assert.doesNotMatch(result.article, /\[\[TABLE_/);
    assert.ok(result.plan.tableBindings.every(binding => binding.sourceType === 'artifact_table' && !('selection' in binding)));
});

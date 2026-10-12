const test = require('node:test');
const assert = require('node:assert/strict');
function createFullReaderTableSample() {
    const { parseArxivStructuredArtifactsFromHtml, bindStructuredArtifactsToText, parseApiReaderArticleResult } = require('../scripts/deep-analyzer.js');
    const header = '<thead><tr><th>System</th><th>WER</th><th>CER</th><th>Latency</th><th>Memory</th></tr></thead>';
    const rows = '<tbody><tr><td>Baseline</td><td>4.8%</td><td>3.1%</td><td>2 ms</td><td>8 GB</td></tr><tr><td>Proposed</td><td>4.1%</td><td>2.9%</td><td>3 ms</td><td>9 GB</td></tr></tbody>';
    const html = `<article>${[1, 2].map(ordinal => `<figure class="ltx_table"><figcaption>Table ${ordinal}: Matched conditions.</figcaption><table class="ltx_tabular">${header}${rows}</table></figure>`).join('')}</article>`;
    const sourceText = require('cheerio').load(html)('body').text();
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
    payload.tableBindings[0] = { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } };
    return { payload, options: { requiredVersion: 3, requireSourceBindings: true,
        requireIntegratedTables: true, minimumIntegratedTables: 2, structuredArtifacts: artifacts, sourceText } };
}


const { parseApiReaderArticleResult } = require('../scripts/deep-analyzer');
const { extractMarkdownTables } = require('../scripts/analysis-contract');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');
const wrappers = [value => '```text\n\n' + value + '\n\n```', value => `<script>\n\n${value}\n\n</script>`, value => `<style>\n\n${value}\n\n</style>`, value => `<!--\n\n${value}\n\n-->`, value => `<pre>\n\n${value}\n\n</pre>`, value => value.split('\n').map(line => `    ${line}`).join('\n'), value => value.split('\n').map(line => `> ${line}`).join('\n')];
test('隐藏的完整原表和选择表标记不能算作正文展示', () => {
    for (const tableIndex of [1, 2]) {
        for (const wrap of wrappers) {
            const sample = createFullReaderTableSample();
            const section = sample.payload.sections[tableIndex === 1 ? 6 : 7];
            const marker = `[[TABLE_${tableIndex}]]`;
            section.body = section.body.replace(marker, wrap(marker));
            const bytes = JSON.stringify(sample.payload);
            assert.throws(() => parseApiReaderArticleResult(bytes, sample.options));
            assert.equal(JSON.stringify(sample.payload), bytes);
        }
    }
});
test('隐藏的普通来源绑定表格不能补足展示数量，可见原表仍通过', () => {
    const sample = createFullReaderTableSample();
    const normalized = normalizeReaderDraftOrder(sample.payload, sample.options).draft;
    const quote = 'Baseline WER 4.8% CER 3.1% Latency 2 ms Memory 8 GB. Proposed WER 4.1% CER 2.9% Latency 3 ms Memory 9 GB.';
    sample.options.sourceText += '\n' + quote;
    sample.options.structuredArtifacts = require('../scripts/deep-analyzer').bindStructuredArtifactsToText(sample.options.structuredArtifacts, sample.options.sourceText);
    normalized.tableBindings[0] = { tableIndex: 1, sourceType: 'source_quotes',
        sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [quote] };
    assert.doesNotThrow(() => parseApiReaderArticleResult(JSON.stringify(normalized), sample.options));
    const body = normalized.sections[6].body;
    const table = extractMarkdownTables(body)[0];
    assert.ok(table);
    for (const wrap of wrappers) {
        const changed = structuredClone(normalized);
        changed.sections[6].body = body.replace(table.markdown, wrap(table.markdown));
        assert.throws(() => parseApiReaderArticleResult(JSON.stringify(changed), sample.options));
        assert.equal(extractMarkdownTables(changed.sections[6].body).length, 0);
    }
});

test('未闭合隐藏块不计表格，遮罩保留原行号且可见单元格代码不变', () => {
    const { maskProtectedMarkdownTableRegions } = require('../scripts/analysis-contract');
    const visible = '| 参数 | 说明 |\n| --- | --- |\n| `K` | 引用原文的配置 |';
    for (const prefix of ['<!--\n\n', '```text\n\n', '<pre>\n\n']) {
        const body = prefix + visible;
        const masked = maskProtectedMarkdownTableRegions(body);
        assert.equal(masked.length, body.length);
        assert.equal(masked.split('\n').length, body.split('\n').length);
        assert.equal(extractMarkdownTables(body).length, 0);
    }
    const body = '<!--\n隐藏说明\n-->\n\n' + visible;
    const table = extractMarkdownTables(body)[0];
    assert.equal(table.startLine, 4);
    assert.equal(table.endLine, 6);
    assert.equal(table.markdown, visible);
    assert.equal(table.rows[0][0], '`K`');
});

test('原表单元格中的注释字样不隐藏数字，代码块中的注释不影响后续可见表', () => {
    const table = '| A | B |\n| --- | --- |\n| `<!--` | 1 |\n| `-->` | 2 |';
    assert.equal(extractMarkdownTables(table)[0].markdown, table);
    const body = '```html\n<!--\n```\n\n' + table;
    assert.equal(extractMarkdownTables(body)[0].markdown, table);
    for (const body of ['<div>\n' + table + '\n</div>', '> 引用说明\n' + table]) assert.equal(extractMarkdownTables(body).length, 0);
    assert.equal(extractMarkdownTables('<div>\n\n' + table + '\n\n</div>').length, 1);
});

test('HTML原样区块内部注释不泄漏，其他实际隐藏HTML类型不计展示', () => {
    const table = '| A | B |\n| --- | --- |\n| C | 1 |';
    for (const tag of ['script', 'style', 'textarea', 'pre']) {
        assert.equal(extractMarkdownTables(`<${tag}>\n<!--\n</${tag}>\n\n${table}`)[0].markdown, table);
        assert.equal(extractMarkdownTables(`<${tag}>\n\n${table}\n\n</${tag}>`).length, 0);
    }
    for (const body of ['<custom>\n' + table + '\n</custom>', '<![CDATA[\n' + table + '\n]]>', '<?target\n' + table + '\n?>', '<!DECLARATION\n' + table + '\n>']) assert.equal(extractMarkdownTables(body).length, 0);
    assert.equal(extractMarkdownTables('<custom>\n\n' + table + '\n\n</custom>').length, 1);
    assert.equal(extractMarkdownTables('<div>\n```text\n</div>\n\n' + table)[0].markdown, table);
});

test('普通HTML标签名不能冒充原样区块，原HTML内未闭合注释仍保护后文', () => {
    const table = '| A | B |\n| --- | --- |\n| C | 1 |';
    for (const tag of ['script-example', 'pre-note', 'div-extra']) {
        assert.equal(extractMarkdownTables(`<${tag}>\n\n${table}\n\n</${tag}>`)[0].markdown, table);
    }
    assert.equal(extractMarkdownTables('<div>\n<!--\n</div>\n\n' + table).length, 0);
    assert.equal(extractMarkdownTables('<div>\n`<!--`\n</div>\n\n' + table).length, 0);
    assert.equal(extractMarkdownTables('<div>`<!--`\n\n' + table).length, 0);
    assert.equal(extractMarkdownTables('<div>\n<!--\n</div>\n\n-->\n\n' + table)[0].markdown, table);
});

for (const marker of ['[[CONCEPT_BRIDGE_1]]', '[[FORMULA_1]]', '[[FIGURE_1]]']) {
    test(`已绑定 ${marker} 不能在HTML注释中装配，正常标记仍通过完整解析`, () => {
        const sample = require('./reader-signed-draft-fixture').fixture();
        const options = { requiredVersion: 3, requireIntegratedTables: true,
            minimumIntegratedTables: 2, availableFigureOrdinals: [1], requireSourceBindings: true,
            allowDeterministicQuoteRepair: true, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
            sourceText: sample.sourceDetails.text };
        assert.doesNotThrow(() => parseApiReaderArticleResult(JSON.stringify(sample.draft), options));
        const section = sample.draft.sections.find(item => item.body.includes(marker));
        if (marker === '[[FIGURE_1]]') {
            const index = section.body.indexOf('\n\n这张图用于确认');
            section.body = section.body.slice(0, index) + '\n\n<!--\n\n' + section.body.slice(index) + '\n\n-->';
        } else {
            section.body = section.body.replace(marker, `<!--\n\n${marker}\n\n-->`);
        }
        const original = JSON.stringify(sample.draft);
        assert.throws(() => parseApiReaderArticleResult(original, options), /注释、代码或引用/);
        assert.equal(JSON.stringify(sample.draft), original);
    });
}

test('同一段落跨行代码中的四类标记必须在装配前被拒绝', () => {
    for (const marker of ['[[TABLE_1]]', '[[FORMULA_1]]', '[[FIGURE_1]]', '[[CONCEPT_BRIDGE_1]]']) {
        const sample = marker === '[[TABLE_1]]' ? createFullReaderTableSample()
            : (() => { const sample = require('./reader-signed-draft-fixture').fixture(); return {
                payload: sample.draft, options: { requiredVersion: 3, requireIntegratedTables: true,
                    minimumIntegratedTables: 2, availableFigureOrdinals: [1], requireSourceBindings: true,
                    allowDeterministicQuoteRepair: true, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
                    sourceText: sample.sourceDetails.text } }; })();
        const section = sample.payload.sections.find(item => item.body.includes(marker));
        section.body = section.body.replace(marker, '`\n' + marker + '\n`');
        assert.throws(() => parseApiReaderArticleResult(JSON.stringify(sample.payload), sample.options), /注释、代码或引用/);
    }
});

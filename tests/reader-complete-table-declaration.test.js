'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReaderDraftOrder } = require('../scripts/lib/reader-draft-order');

function createCompleteTableSample() {
    const matrix = [['Model', 'Train', 'Train'], ['Model', 'RPA', 'OA'], ['Baseline', '92.45', '95.19']];
    const sourceDomSha256 = 'b'.repeat(64);
    const table = {
        ordinal: 2,
        recoveryStatus: 'complete',
        sourceDomSha256: 'a'.repeat(64),
        matrix,
        cells: [
            { row: 0, column: 0, text: 'Model', rowspan: 2, colspan: 1, sourceDomSha256 },
            { row: 0, column: 1, text: 'Train', rowspan: 1, colspan: 2, sourceDomSha256 },
            { row: 1, column: 1, text: 'RPA', rowspan: 1, colspan: 1, sourceDomSha256 },
            { row: 1, column: 2, text: 'OA', rowspan: 1, colspan: 1, sourceDomSha256 },
            ...matrix[2].map((text, column) => ({ row: 2, column, text, sourceDomSha256 }))
        ]
    };
    return {
        draft: {
            sections: [{ kind: 'result', heading: '原表', body: '比较问题。\n\n[[TABLE_1]]\n\n结果说明。' }],
            tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 2 } }]
        },
        structuredArtifacts: { tables: [table] }
    };
}

test('完整原表声明由程序保留双层表头和合并单元格投影', () => {
    const sample = createCompleteTableSample();
    const original = JSON.stringify(sample);
    const result = normalizeReaderDraftOrder(sample.draft, sample);
    assert.match(result.draft.sections[0].body, /\| Model \| Train \| Train \|\n\| --- \| --- \| --- \|\n\| Model \| RPA \| OA \|\n\| Baseline \| 92.45 \| 95.19 \|/);
    assert.equal(result.draft.tableBindings[0].sourceType, 'artifact_table');
    assert.equal(result.draft.tableBindings[0].cellBindings.length, 9);
    assert.deepEqual(result.draft.tableBindings[0].sourceQuotes, []);
    assert.equal(JSON.stringify(sample), original);
});

const invalidCases = {
    '混入手写单元格': sample => { sample.draft.tableBindings[0].cellBindings = []; },
    '混入选择子集': sample => { sample.draft.tableBindings[0].completeTable.sourceRows = [0, 2]; },
    '缺失标记': sample => { sample.draft.sections[0].body = '结果说明。'; },
    '标记放入未知字段': sample => {
        sample.draft.sections[0].body = '结果说明。';
        sample.draft.sections[0].tableMarker = '[[TABLE_1]]';
    },
    '重复标记': sample => { sample.draft.sections[0].body += '\n\n[[TABLE_1]]'; },
    '非独占标记': sample => { sample.draft.sections[0].body = '文字[[TABLE_1]]文字'; },
    '不存在的原表': sample => { sample.draft.tableBindings[0].completeTable.sourceTableOrdinal = 9; },
    '重复原表身份': sample => { sample.structuredArtifacts.tables.push(sample.structuredArtifacts.tables[0]); },
    '缺失原格': sample => { sample.structuredArtifacts.tables[0].cells.pop(); },
    '伪造原矩阵数值': sample => { sample.structuredArtifacts.tables[0].matrix[2][1] = '999'; },
    '原格缺SHA': sample => { sample.structuredArtifacts.tables[0].cells[0].sourceDomSha256 = ''; },
    '原表未完整恢复': sample => { sample.structuredArtifacts.tables[0].recoveryStatus = 'partial'; }
};

for (const [name, change] of Object.entries(invalidCases)) {
    test(`完整原表声明拒绝${name}`, () => {
        const sample = createCompleteTableSample();
        change(sample);
        assert.throws(() => normalizeReaderDraftOrder(sample.draft, sample));
    });
}

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

test('完整原表声明和已有选择表共同通过完整正文解析及来源核验', () => {
    const { parseApiReaderArticleResult } = require('../scripts/deep-analyzer');
    const sample = createFullReaderTableSample();
    const rawBytes = JSON.stringify(sample.payload);
    const result = parseApiReaderArticleResult(rawBytes, sample.options);
    assert.equal(result.plan.tableBindings.length, 2);
    assert.equal(result.plan.tableBindings[0].cellBindings.length, 15);
    assert.ok(result.plan.tableBindings.every(binding => binding.sourceType === 'artifact_table'));
    assert.doesNotMatch(result.article, /\[\[TABLE_/);
    assert.equal(JSON.stringify(sample.payload), rawBytes);
    const legacyPayload = structuredClone(sample.payload);
    legacyPayload.tableBindings[0] = { tableIndex: 1, selection: { sourceTableOrdinal: 1,
        sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2, 3, 4] } };
    const legacyResult = parseApiReaderArticleResult(JSON.stringify(legacyPayload), sample.options);
    assert.equal(result.article, legacyResult.article);
    assert.deepEqual(result.plan.tableBindings, legacyResult.plan.tableBindings);
});

test('完整正文解析仍拒绝缺来源、错数字、未知字段和重复原表标记', () => {
    const { parseApiReaderArticleResult } = require('../scripts/deep-analyzer');
    const changes = [
        sample => { delete sample.options.structuredArtifacts; },
        sample => { sample.options.structuredArtifacts.tables[0].matrix[1][1] = '999%'; },
        sample => { sample.payload.tableBindings[0].completeTable.sourceRows = [0, 1]; },
        sample => { sample.payload.sections[6].body += '\n\n[[TABLE_1]]'; }
    ];
    for (const change of changes) {
        const sample = createFullReaderTableSample();
        change(sample);
        assert.throws(() => parseApiReaderArticleResult(JSON.stringify(sample.payload), sample.options));
    }
});

test('完整原表的局部修复只修改真实授权记录并重新通过完整解析', () => {
    const repair = require('../scripts/lib/reader-repair');
    const { parseApiReaderArticleResult } = require('../scripts/deep-analyzer');
    const sample = createFullReaderTableSample();
    sample.payload.tableBindings[0].completeTable.sourceTableOrdinal = 99;
    const originalBytes = JSON.stringify(sample.payload);
    let parserError;
    try {
        parseApiReaderArticleResult(originalBytes, sample.options);
    } catch (error) {
        parserError = error;
    }
    assert.ok(parserError);
    const issues = repair.collectDraftIssues(sample.payload, parserError, sample.options);
    assert.ok(issues.some(issue => issue.path === '/tableBindings/0'));
    const context = repair.buildRepairContext(sample.payload, issues, sample.options.sourceText);
    const target = context.targets.find(item => item.path === '/tableBindings/0');
    assert.ok(target);
    const replacement = { path: target.path, oldSha256: target.oldSha256,
        value: { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } } };
    const patch = { version: 1, draftSha256: context.draftSha256, replacements: [replacement] };
    const updated = repair.applyReaderPatch(sample.payload, patch, [target.path]);
    const result = parseApiReaderArticleResult(JSON.stringify(updated), sample.options);
    assert.equal(result.plan.tableBindings[0].cellBindings.length, 15);
    assert.deepEqual(updated.sections, sample.payload.sections);
    assert.equal(JSON.stringify(sample.payload), originalBytes);
    assert.throws(() => repair.applyReaderPatch(sample.payload, { ...patch,
        replacements: [{ ...replacement, oldSha256: '0'.repeat(64) }] }, [target.path]), /stale node SHA/);
    assert.throws(() => repair.applyReaderPatch(sample.payload, { ...patch,
        replacements: [{ ...replacement, path: '/sections/0/body' }] }, [target.path]), /unauthorized/);
    const invalid = repair.applyReaderPatch(sample.payload, { ...patch,
        replacements: [{ ...replacement, value: { ...replacement.value, sourceQuotes: [] } }] }, [target.path]);
    assert.throws(() => parseApiReaderArticleResult(JSON.stringify(invalid), sample.options));
});

test('仅授权来源记录时不能把缺标记或旧 Markdown 自动改成完整原表', () => {
    const repair = require('../scripts/lib/reader-repair');
    const { parseApiReaderArticleResult } = require('../scripts/deep-analyzer');
    for (const useOldMarkdown of [false, true]) {
        const sample = createFullReaderTableSample();
        if (useOldMarkdown) {
            sample.payload.sections[6].body = sample.payload.sections[6].body.replace('[[TABLE_1]]', '| 名称 | 数值 |\n| --- | --- |\n| 原表 | 1 |');
            sample.payload.tableBindings[0] = { tableIndex: 1, sourceQuotes: [], cellBindings: [] };
        } else {
            sample.payload.sections[6].body = sample.payload.sections[6].body.replace('[[TABLE_1]]', '');
        }
        const originalBody = sample.payload.sections[6].body;
        const context = repair.buildRepairContext(sample.payload,
            [{ path: '/tableBindings/0', code: 'source_binding', message: '来源记录需要核对' }], sample.options.sourceText);
        const target = context.targets.find(item => item.path === '/tableBindings/0');
        assert.ok(target);
        const updated = repair.applyReaderPatch(sample.payload, {
            version: 1,
            draftSha256: context.draftSha256,
            replacements: [{ path: target.path, oldSha256: target.oldSha256,
                value: { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } } }]
        }, [target.path]);
        assert.equal(updated.sections[6].body, originalBody);
        assert.throws(() => parseApiReaderArticleResult(JSON.stringify(updated), sample.options));
    }
});

test('实际新提示词的完整原表规则独立于选择资格，固定版本SHA一致', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const history = require('../scripts/lib/prompt-history');
    const article = fs.readFileSync(path.join(__dirname, '../prompts/api-reader-article-v6.md'), 'utf8');
    const repair = fs.readFileSync(path.join(__dirname, '../prompts/api-reader-repair-v7.md'), 'utf8');
    assert.match(article, /四种表格记录方式/);
    assert.doesNotMatch(article, /三种表格记录方式|原表可用性及三种结构/);
    assert.match(repair, /selection` 只能选择 `TABLE_J_SELECTION` 明确标为 `eligible=true`/);
    assert.match(repair, /`completeTable` 独立按完整原矩阵及原始 DOM 核验，`eligible=false` 不禁止完整原表/);
    assert.equal(history.promptTemplateSha256(article), 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380');
    assert.equal(history.promptTemplateSha256(repair), 'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { normalizeReaderDraftOrder, locateReaderDraftTables,
    pruneUniquelyUnboundReaderMarkdownTables } = require('../scripts/lib/reader-draft-order.js');
const { buildRepairTargets, collectDraftIssues } = require('../scripts/lib/reader-repair.js');
const { compileReaderTableSelections } = require('../scripts/lib/reader-tables.js');

const markdown = value => `| Method | Value |\n| --- | --- |\n| ${value} | 12 |`;
const binding = (tableIndex, quote) => ({ tableIndex, sourceType: 'source_quotes', sourceTableOrdinal: null,
    cellBindings: [], sourceQuotes: [quote] });
function fixture() {
    return { sections: [
        { kind: 'result', heading: 'results', body: markdown('result') },
        { kind: 'ablation', heading: 'ablations', body: markdown('ablation') },
        { kind: 'experiment_setup', heading: 'setup', body: markdown('setup') }
    ], tableBindings: [binding(1, 'result quote'), binding(2, 'ablation quote'), binding(3, 'setup quote')],
    conceptBridges: [], figurePlacements: [], formulaBindings: [] };
}

test('稳定的章节排序保留表格与绑定配对，并记录可复核的原始映射', () => {
    const original = fixture();
    const frozen = JSON.stringify(original);
    const { draft, mapping } = normalizeReaderDraftOrder(original);
    assert.equal(JSON.stringify(original), frozen);
    assert.deepEqual(draft.sections.map(item => item.kind), ['experiment_setup', 'result', 'ablation']);
    assert.deepEqual(draft.tableBindings.map(item => item.sourceQuotes[0]), ['setup quote', 'result quote', 'ablation quote']);
    assert.deepEqual(draft.tableBindings.map(item => item.tableIndex), [1, 2, 3]);
    assert.deepEqual(mapping.tables.map(item => item.rawIndex), [2, 0, 1]);
    assert.match(mapping.inputSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(mapping.inputSha256, mapping.outputSha256);
    const again = normalizeReaderDraftOrder(draft);
    assert.deepEqual(again.draft, draft);
    assert.equal(again.mapping.changed, false);
    assert.equal(again.mapping.inputSha256, mapping.outputSha256);
    const targets = buildRepairTargets(draft, [{ message: '读者文章 tableBindings[1] 关键数字缺少 exact quote/cell 证据' }]);
    assert.deepEqual(targets.map(item => item.path), ['/tableBindings/1', '/sections/1/body']);
    assert.match(targets[1].value, /result/);
    assert.doesNotMatch(targets[1].value, /ablation/);
});

test('原始顺序被打乱时，原文引文证据在章节排序前重新对齐绑定', () => {
    const input = { sections: [
        { kind: 'result', heading: 'results', body: '| Method | Score |\n| --- | --- |\n| result-marker | 0.91 |' },
        { kind: 'experiment_setup', heading: 'setup', body: '| Setting | Value |\n| --- | --- |\n| setup-marker | 16 kHz |' }
    ], tableBindings: [
        binding(1, 'setup-marker 16 kHz'),
        binding(2, 'result-marker 0.91')
    ], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const { draft } = normalizeReaderDraftOrder(input);
    assert.deepEqual(draft.sections.map(section => section.kind), ['experiment_setup', 'result']);
    assert.deepEqual(draft.tableBindings.map(item => item.sourceQuotes[0]), [
        'setup-marker 16 kHz', 'result-marker 0.91'
    ]);
    assert.deepEqual(locateReaderDraftTables(draft).map(table => table.table.markdown.includes('setup-marker')),
        [true, false]);
});

test('手写表与选区表混排时保持顺序，同时重命名标记不会冲突', () => {
    const input = fixture();
    input.sections[0].body = '[[TABLE_1]]\n\n' + markdown('result-second');
    input.sections[1].body = '[[TABLE_3]]';
    input.sections[2].body = '[[TABLE_4]]';
    const select = (tableIndex, sourceTableOrdinal) => ({ tableIndex,
        selection: { sourceTableOrdinal, sourceRows: [0, 1], sourceColumns: [0, 1] } });
    input.tableBindings = [select(1, 10), binding(2, 'result-second'), select(3, 30), select(4, 40)];
    const { draft } = normalizeReaderDraftOrder(input);
    assert.equal(draft.sections[0].body, '[[TABLE_1]]');
    assert.match(draft.sections[1].body, /^\[\[TABLE_2\]\]/);
    assert.equal(draft.sections[2].body, '[[TABLE_4]]');
    assert.deepEqual(draft.tableBindings.map(item => item.selection?.sourceTableOrdinal || item.sourceQuotes[0]), [40, 10, 'result-second', 30]);
    assert.deepEqual(locateReaderDraftTables(draft).map(item => item.path), [
        '/sections/0/body', '/sections/1/body', '/sections/1/body', '/sections/2/body'
    ]);
    assert.deepEqual(normalizeReaderDraftOrder(draft).draft, draft);
});

test('规范章节归一化完整的选择标记排列，且不改动正文字节', () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/arxiv-reader-source-bindings.html'), 'utf8');
    const sourceText = cheerio.load(html)('body').text();
    const analyzer = require('../scripts/deep-analyzer.js');
    const artifacts = analyzer.bindStructuredArtifactsToText(
        analyzer.parseArxivStructuredArtifactsFromHtml(html, '2609.00001v1', '2609.00001v1'), sourceText);
    const select = (tableIndex, sourceTableOrdinal, sourceRows) => ({ tableIndex, selection: {
        sourceTableOrdinal, sourceRows, sourceColumns: [0, 1, 2]
    } });
    const originalBody = '先解释部署资源表，保留这段文字和空行。\n\n[[TABLE_2]]\n\n'
        + '再解释识别结果表，正文只能改 marker token。\n\n[[TABLE_1]]\n\n最后收束比较。';
    const input = { sections: [{ kind: 'experiment_setup', heading: 'setup', body: originalBody }],
        tableBindings: [select(1, 1, [1, 2, 3]), select(2, 2, [0, 1, 2])],
        conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const frozen = JSON.stringify(input);
    const { draft, mapping } = normalizeReaderDraftOrder(input);
    assert.equal(JSON.stringify(input), frozen);
    assert.equal(mapping.contract, 'reader-draft-order-v4');
    assert.deepEqual(mapping.tables.map(item => [item.rawIndex, item.canonicalIndex]), [[1, 0], [0, 1]]);
    assert.deepEqual(draft.tableBindings.map(item => [item.tableIndex, item.selection.sourceTableOrdinal]),
        [[1, 2], [2, 1]]);
    assert.equal(draft.sections[0].body.replace(/\[\[TABLE_\d+\]\]/g, '[[TABLE]]'),
        originalBody.replace(/\[\[TABLE_\d+\]\]/g, '[[TABLE]]'));
    assert.deepEqual([...draft.sections[0].body.matchAll(/\[\[TABLE_(\d+)\]\]/g)].map(match => Number(match[1])), [1, 2]);
    const compiled = compileReaderTableSelections(draft.sections, draft.tableBindings, artifacts);
    assert.deepEqual(compiled.tableBindings.map(item => item.sourceTableOrdinal), [2, 1]);
    assert.ok(compiled.sections[0].body.indexOf('| System | Memory | RTF |')
        < compiled.sections[0].body.indexOf('| System | test-clean | test-other |'));
    assert.deepEqual(normalizeReaderDraftOrder(draft).draft, draft);
});

test('规范标记排列归一化拒绝有歧义和混合的反例', () => {
    const select = (tableIndex, sourceTableOrdinal = tableIndex) => ({ tableIndex, selection: {
        sourceTableOrdinal, sourceRows: [0, 1], sourceColumns: [0, 1]
    } });
    const ordinary = binding(1, 'source quote long enough');
    const cases = [
        { body: '[[TABLE_2]]\n\n[[TABLE_2]]', bindings: [select(1), select(2)] },
        { body: '[[TABLE_2]]', bindings: [select(1), select(2)] },
        { body: 'inline [[TABLE_2]]\n\n[[TABLE_1]]', bindings: [select(1), select(2)] },
        { body: '[[TABLE_2]]\n\n[[TABLE_1]]', bindings: [ordinary, select(2)] },
        { body: '[[TABLE_2]]\n\n[[TABLE_1]]', bindings: [select(1), { ...select(2), tableIndex: 1 }] }
    ];
    for (const item of cases) {
        const input = { sections: [{ kind: 'experiment_setup', heading: 'setup', body: item.body }],
            tableBindings: item.bindings, conceptBridges: [], figurePlacements: [], formulaBindings: [] };
        const before = JSON.stringify(input);
        assert.deepEqual(normalizeReaderDraftOrder(input).draft, input);
        assert.equal(JSON.stringify(input), before);
        assert.throws(() => compileReaderTableSelections(input.sections, input.tableBindings, { tables: [] }));
    }
});

test('规范的混合标记与引文流重新对齐，不改动表格正文', () => {
    const select = (tableIndex, sourceTableOrdinal) => ({ tableIndex,
        selection: { sourceTableOrdinal, sourceRows: [0, 1], sourceColumns: [0, 1] } });
    const authored = markdown('quote-middle');
    const input = { sections: [
        { kind: 'experiment_setup', body: `[[TABLE_1]]\n\n[[TABLE_2]]\n\n${authored}` },
        { kind: 'result', body: '[[TABLE_3]]\n\n[[TABLE_4]]' }
    ], tableBindings: [select(1, 11), select(2, 12), select(3, 13), select(4, 14),
        binding(5, 'quote-middle')], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const normalized = normalizeReaderDraftOrder(input).draft;
    assert.deepEqual(normalized.tableBindings.map(item => (
        item.selection?.sourceTableOrdinal || item.sourceQuotes[0]
    )), [11, 12, 'quote-middle', 13, 14]);
    assert.deepEqual(locateReaderDraftTables(normalized).map(item => item.markerIndex || 'markdown'),
        [1, 2, 'markdown', 4, 5]);
    assert.match(normalized.sections[0].body, new RegExp(authored.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(normalizeReaderDraftOrder(normalized).draft, normalized);
});

test('只裁掉不可见的末尾原文引文后缀', () => {
    const input = { sections: [{ kind: 'result', body: `${markdown('one')}\n\n${markdown('two')}` }],
        tableBindings: [binding(1, 'one'), binding(2, 'two'), binding(3, 'missing')],
        conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const normalized = normalizeReaderDraftOrder(input).draft;
    assert.equal(normalized.tableBindings.length, 2);
    assert.deepEqual(normalized.tableBindings.map(item => item.sourceQuotes[0]), ['one', 'two']);
    const twoMissing = structuredClone(input);
    twoMissing.tableBindings.push(binding(4, 'also missing'));
    const pruned = normalizeReaderDraftOrder(twoMissing).draft;
    assert.equal(pruned.tableBindings.length, 2);
    assert.deepEqual(pruned.tableBindings.map(item => item.sourceQuotes[0]), ['one', 'two']);
    const unsafe = structuredClone(twoMissing);
    unsafe.tableBindings[2].selection = { sourceTableOrdinal: 3,
        sourceRows: [0, 1], sourceColumns: [0, 1] };
    assert.equal(normalizeReaderDraftOrder(unsafe).draft.tableBindings.length, 4);
});

test('未排序且有歧义的绑定直接失败，在未改动的输入上报出路径，绝不丢弃表格', () => {
    for (const alter of [draft => draft.tableBindings.pop(), draft => { draft.tableBindings[1].tableIndex = 1; },
        draft => { draft.sections[0].body = '[[TABLE_3]]'; }]) {
        const draft = fixture(); alter(draft); const before = JSON.stringify(draft);
        let error;
        try { normalizeReaderDraftOrder(draft); } catch (caught) { error = caught; }
        assert.equal(error?.code, 'READER_DRAFT_ORDER_AMBIGUOUS');
        assert.equal(error.message, '重排正文前，表格与来源记录不能一一对应。请按当前草稿的正文顺序核对 tableBindings 和 TABLE 占位符，不猜测缺失数据，也不丢弃已有来源的表格。');
        for (const issue of error.readerIssues) {
            assert.deepEqual(Object.keys(issue), ['path', 'message', 'code']);
            assert.equal(issue.code, 'reader_table_binding_order_ambiguous');
            assert.equal(issue.message, error.message);
        }
        assert.equal(JSON.stringify(draft), before);
        assert.ok(error.readerIssues.some(issue => issue.path === '/sections/0/body'));
        assert.ok(error.readerIssues.some(issue => issue.path === '/tableBindings/0'));
    }
});

test('同一章节内有歧义的表格保留重复的正文路径，排在绑定路径之前', () => {
    const draft = fixture();
    draft.sections[0].body += `\n\n${markdown('second-result')}`;
    const before = JSON.stringify(draft);
    assert.throws(() => normalizeReaderDraftOrder(draft), error => {
        assert.equal(error.code, 'READER_DRAFT_ORDER_AMBIGUOUS');
        assert.deepEqual(error.readerIssues.map(issue => issue.path), [
            '/sections/0/body', '/sections/0/body', '/sections/1/body', '/sections/2/body',
            '/tableBindings/0', '/tableBindings/1', '/tableBindings/2'
        ]);
        return true;
    });
    assert.equal(JSON.stringify(draft), before);
});

test('未排序的选区与引文混合绑定按唯一标记身份和正文顺序重新对齐', () => {
    const select = (tableIndex, sourceTableOrdinal) => ({ tableIndex,
        selection: { sourceTableOrdinal, sourceRows: [0, 1], sourceColumns: [0, 1] } });
    const input = { sections: [
        { kind: 'result', heading: 'result', body: `[[TABLE_1]]\n\n${markdown('quote-one')}` },
        { kind: 'ablation', heading: 'ablation', body: markdown('quote-two') },
        { kind: 'result', heading: 'later result', body: '[[TABLE_2]]' }
    ], tableBindings: [
        select(1, 10), select(2, 20), binding(3, 'quote-one'), binding(4, 'quote-two')
    ], conceptBridges: [], figurePlacements: [], formulaBindings: [] };
    const normalized = normalizeReaderDraftOrder(input);
    assert.deepEqual(normalized.draft.sections.map(section => section.kind),
        ['result', 'result', 'ablation']);
    assert.deepEqual(normalized.draft.tableBindings.map(item => (
        item.selection?.sourceTableOrdinal || item.sourceQuotes[0]
    )), [10, 'quote-one', 20, 'quote-two']);
    assert.deepEqual(locateReaderDraftTables(normalized.draft).map(item => item.markerIndex || 'markdown'),
        [1, 'markdown', 3, 'markdown']);
    assert.deepEqual(normalizeReaderDraftOrder(normalized.draft).draft, normalized.draft);
});

test('唯一的选择锚点只裁掉未绑定的手写表及其悬空叙述', () => {
    const select = { tableIndex: 1,
        selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 1] } };
    const input = { sections: [
        { kind: 'experiment_setup', body: ['下表是重复配置。', markdown('extra'), '表后是重复解释。', '保留的实验设置。'].join('\n\n') },
        { kind: 'ablation', body: '[[TABLE_1]]' },
        { kind: 'reproduction', body: markdown('bound') }
    ], tableBindings: [select, binding(2, 'bound quote')] };
    assert.equal(pruneUniquelyUnboundReaderMarkdownTables(input), 1);
    assert.doesNotMatch(input.sections[0].body, /extra|下表是重复|表后是重复/);
    assert.match(input.sections[0].body, /保留的实验设置/);
    assert.deepEqual(locateReaderDraftTables(input).map(item => item.markerIndex || 'markdown'), [1, 'markdown']);
});

test('有歧义的多余手写表一律不裁剪', () => {
    const input = { sections: [{ kind: 'result', body: [markdown('one'), markdown('two')].join('\n\n') }],
        tableBindings: [binding(1, 'quote')] };
    const before = structuredClone(input);
    assert.equal(pruneUniquelyUnboundReaderMarkdownTables(input), 0);
    assert.deepEqual(input, before);
});

test('会议 PDF 的分组数字允许在混合顺序归一化之前裁掉未绑定的表格', () => {
    const select = { tableIndex: 1,
        selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 1] } };
    const result = [
        '| 数据集 | 样本规模 | 准确率 |', '| --- | --- | --- |',
        '| SoundingSVI | 169221 对 | 86.13% |', '| SonicUrban | 236674 对 | 86.13% |'
    ].join('\n');
    const input = { sections: [
        { kind: 'result', body: result },
        { kind: 'ablation', body: '[[TABLE_1]]' },
        { kind: 'reproduction', body: markdown('unbound') }
    ], tableBindings: [select, binding(2, 'The source reports 169,221 pairs and 236,674 pairs.') ] };
    assert.equal(pruneUniquelyUnboundReaderMarkdownTables(input), 1);
    assert.match(input.sections[0].body, /169221 对/);
    assert.doesNotMatch(input.sections[2].body, /unbound/);
    assert.deepEqual(locateReaderDraftTables(input).map(item => item.markerIndex || 'markdown'), [
        'markdown', 1
    ]);
});

test('原文引文证据表只有在得分唯一时才能胜过内容更丰富的重复手写表', () => {
    const select = { tableIndex: 1,
        selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 1] } };
    const rich = [
        '| 评测 | 基线 | 本文 |', '| --- | --- | --- |',
        '| AudioSet | 35.2% | 37.4% |', '| AudioSet-2 | 27.9% | 37.1% |'
    ].join('\n');
    const evidence = [
        '| 来源证据 | 量化值 1 | 量化值 2 |', '| --- | --- | --- |',
        '| 来源句 1 | 35.2% | 37.4% |'
    ].join('\n');
    const input = { sections: [
        { kind: 'result', body: [rich, evidence].join('\n\n') },
        { kind: 'ablation', body: '[[TABLE_1]]' }
    ], tableBindings: [select, binding(2, 'The reported retrieval values are 35.2% and 37.4%.')] };
    assert.equal(pruneUniquelyUnboundReaderMarkdownTables(input), 1);
    assert.doesNotMatch(input.sections[0].body, /\| 评测 \| 基线 \| 本文 \|/);
    assert.match(input.sections[0].body, /\| 来源证据 \| 量化值 1 \| 量化值 2 \|/);
});

test('紧凑的 k 量级原文引文可以唯一定位未绑定的基准表', () => {
    const table = values => [
        '| 评测对象 | 样本规模 | 视频规模 |', '| --- | --- | --- |',
        ...values.map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
    const input = { sections: [
        { kind: 'experiment_setup', body: [
            table([['幻觉基准', 'around 5k samples', 'over 2k unique videos']]),
            table([['无量化配置', '普通偏好优化', '额外前向免梯度']])
        ].join('\n\n') },
        { kind: 'result', body: table([['匹配', 'up to 27%', 'around 3-4 %']]) },
        { kind: 'ablation', body: table([['偏好数据', '18,112', 'over 10,854']]) },
        { kind: 'reproduction', body: table([['轮数', 'four epochs', 'βsens = 0.05, βinv = 0.02']]) }
    ], tableBindings: [
        binding(1, 'up to 27% accuracy and around 3-4 % gain'),
        binding(2, '18,112 preference samples over 10,854 unique videos'),
        binding(3, 'four epochs, βsens = 0.05, βinv = 0.02'),
        binding(4, 'around 5k samples over 2k unique videos')
    ] };
    assert.equal(pruneUniquelyUnboundReaderMarkdownTables(input), 1);
    assert.doesNotMatch(input.sections[0].body, /无量化配置/);
    assert.match(input.sections[0].body, /幻觉基准/);
});

test('结构化表格诊断路径直接带上精确绑定，无需解析消息文本', () => {
    const draft = normalizeReaderDraftOrder(fixture()).draft;
    const targets = buildRepairTargets(draft, [{ path: '/sections/1/body', bindingPath: '/tableBindings/1', message: '表格单位格式不匹配；应检查source quote' }]);
    assert.deepEqual(targets.map(item => item.path), ['/sections/1/body', '/tableBindings/1']);
});

test('稳定的同类章节和未绑定的旧版草稿保留全部正文与表格字节', () => {
    const draft = fixture(); draft.sections[2].kind = 'result'; delete draft.tableBindings;
    const out = normalizeReaderDraftOrder(draft).draft;
    assert.deepEqual(out.sections.map(item => item.body), [draft.sections[0].body, draft.sections[2].body, draft.sections[1].body]);
    assert.equal(out.tableBindings, undefined);
});

test('完整的桥接标记排列只归一化数组，并记录节点 SHA 与下标映射', () => {
    const bridge = n => ({ marker: `[[CONCEPT_BRIDGE_${n}]]`, terms: [`term ${n}`, 'other term'],
        sectionKind: 'component', explanation: `Unchanged explanation ${n}` });
    const input = { sections: [{ kind: 'component', body: '[[CONCEPT_BRIDGE_3]]\n\n[[CONCEPT_BRIDGE_1]]\n\n[[CONCEPT_BRIDGE_2]]' }],
        conceptBridges: [bridge(3), bridge(1), bridge(2)] };
    const before = JSON.stringify(input);
    const { draft, mapping } = normalizeReaderDraftOrder(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(mapping.contract, 'reader-draft-order-v4');
    assert.deepEqual(draft.sections, input.sections);
    assert.deepEqual(draft.conceptBridges, [input.conceptBridges[1], input.conceptBridges[2], input.conceptBridges[0]]);
    assert.deepEqual(mapping.conceptBridges.map(item => [item.rawIndex, item.canonicalIndex]), [[1, 0], [2, 1], [0, 2]]);
    for (const item of mapping.conceptBridges) {
        assert.equal(item.marker, draft.conceptBridges[item.canonicalIndex].marker);
        assert.match(item.inputSha256, /^[a-f0-9]{64}$/);
        assert.equal(item.inputSha256, item.outputSha256);
    }
    assert.equal(mapping.changed, true);
    const again = normalizeReaderDraftOrder(draft);
    assert.equal(again.mapping.changed, false);
    assert.equal(again.mapping.inputSha256, mapping.outputSha256);
    assert.deepEqual(again.draft, draft);
});

test('重复、缺失、非规范和有问题的桥接标记不猜测也不修补', () => {
    for (const markers of [
        ['[[CONCEPT_BRIDGE_2]]', '[[CONCEPT_BRIDGE_2]]'],
        ['[[CONCEPT_BRIDGE_3]]', '[[CONCEPT_BRIDGE_1]]'],
        ['[[CONCEPT_BRIDGE_0]]', '[[CONCEPT_BRIDGE_1]]'],
        ['[[CONCEPT_BRIDGE_02]]', '[[CONCEPT_BRIDGE_1]]'],
        [' [[CONCEPT_BRIDGE_2]]', '[[CONCEPT_BRIDGE_1]]'],
        ['[[CONCEPT_BRIDGE_2]]', null],
        ['[[CONCEPT_BRIDGE_9007199254740993]]', '[[CONCEPT_BRIDGE_1]]']
    ]) {
        const input = { sections: [], conceptBridges: markers.map(marker => ({ marker, explanation: 'unchanged' })) };
        const { draft, mapping } = normalizeReaderDraftOrder(input);
        assert.deepEqual(draft, input);
        assert.equal(mapping.changed, false);
        assert.deepEqual(mapping.conceptBridges, []);
    }
    for (const conceptBridges of [null, 'invalid', [{ marker: '[[CONCEPT_BRIDGE_1]]' }, null]]) {
        const input = { sections: [], conceptBridges };
        assert.deepEqual(normalizeReaderDraftOrder(input).draft, input);
    }
});

test('唯一的概念标记移入或插入某个规范声明章节，不重写正文', () => {
    const bridge = (ordinal, sectionKind) => ({ marker: `[[CONCEPT_BRIDGE_${ordinal}]]`,
        terms: [`term ${ordinal}`, `other ${ordinal}`], sectionKind, explanation: 'unchanged explanation' });
    const input = { sections: [
        { kind: 'problem', body: 'problem prose remains byte exact' },
        { kind: 'component', body: 'component prose remains byte exact\n\n[[CONCEPT_BRIDGE_1]]' },
        { kind: 'training', body: 'training prose remains byte exact' }
    ], conceptBridges: [bridge(1, 'problem'), bridge(2, 'training')] };
    const before = structuredClone(input);
    const { draft, mapping } = normalizeReaderDraftOrder(input);
    assert.deepEqual(input, before);
    assert.equal(draft.sections[0].body, `${before.sections[0].body}\n\n[[CONCEPT_BRIDGE_1]]`);
    assert.equal(draft.sections[1].body, 'component prose remains byte exact');
    assert.equal(draft.sections[2].body, `${before.sections[2].body}\n\n[[CONCEPT_BRIDGE_2]]`);
    assert.deepEqual(mapping.conceptMarkerLocations.map(item => [item.operation,
        item.fromSectionIndex, item.toSectionIndex]), [['move', 1, 0], ['insert', null, 2]]);
    assert.equal(mapping.contract, 'reader-draft-order-v4');
    assert.deepEqual(normalizeReaderDraftOrder(draft).draft, draft);
});

test('相邻的独立概念标记拆成各自独立的 Markdown 段落', () => {
    const bridge = ordinal => ({ marker: `[[CONCEPT_BRIDGE_${ordinal}]]`,
        terms: [`term ${ordinal}`, `other ${ordinal}`], sectionKind: 'component',
        explanation: 'unchanged explanation' });
    const input = { sections: [{ kind: 'component', body:
        'component prose remains byte exact\n\n[[CONCEPT_BRIDGE_1]]\n[[CONCEPT_BRIDGE_2]]\n[[CONCEPT_BRIDGE_3]]' }],
    conceptBridges: [bridge(1), bridge(2), bridge(3)] };
    const normalized = normalizeReaderDraftOrder(input);
    assert.equal(normalized.draft.sections[0].body,
        'component prose remains byte exact\n\n[[CONCEPT_BRIDGE_1]]\n\n[[CONCEPT_BRIDGE_2]]\n\n[[CONCEPT_BRIDGE_3]]');
    assert.deepEqual(normalized.mapping.conceptMarkerLocations.map(item => item.operation),
        ['separate-adjacent']);
    assert.deepEqual(normalizeReaderDraftOrder(normalized.draft).draft, normalized.draft);
});

test('概念标记的移动与插入容忍末尾 LF，但仍拒绝行尾空格', () => {
    const bridge = (ordinal, sectionKind) => ({ marker: `[[CONCEPT_BRIDGE_${ordinal}]]`,
        terms: [`term ${ordinal}`, `other ${ordinal}`], sectionKind, explanation: 'unchanged explanation' });
    const input = { sections: [
        { kind: 'problem', body: 'problem prose remains byte exact\n' },
        { kind: 'component', body: 'component prose remains byte exact\n\n[[CONCEPT_BRIDGE_1]]\n' },
        { kind: 'training', body: 'training prose remains byte exact\n' }
    ], conceptBridges: [bridge(1, 'problem'), bridge(2, 'training')] };
    const { draft, mapping } = normalizeReaderDraftOrder(input);
    assert.equal(draft.sections[0].body, 'problem prose remains byte exact\n\n[[CONCEPT_BRIDGE_1]]\n');
    assert.equal(draft.sections[1].body, 'component prose remains byte exact\n');
    assert.equal(draft.sections[2].body, 'training prose remains byte exact\n\n[[CONCEPT_BRIDGE_2]]\n');
    assert.deepEqual(mapping.conceptMarkerLocations.map(item => item.operation), ['move', 'insert']);
    assert.deepEqual(normalizeReaderDraftOrder(draft).draft, draft);

    const trailingSpace = structuredClone(input);
    trailingSpace.sections[0].body = 'problem prose remains byte exact \n';
    const rejected = normalizeReaderDraftOrder(trailingSpace);
    assert.equal(rejected.draft.sections[0].body, trailingSpace.sections[0].body);
    assert.ok(!rejected.draft.sections[0].body.includes('[[CONCEPT_BRIDGE_1]]'));
});

test('概念标记位置归一化拒绝有歧义、行内和非末尾的移动', () => {
    const bridge = { marker: '[[CONCEPT_BRIDGE_1]]', terms: ['term one', 'term two'],
        sectionKind: 'problem', explanation: 'unchanged explanation' };
    const cases = [
        [{ kind: 'problem', body: 'first' }, { kind: 'problem', body: 'second' },
            { kind: 'component', body: 'source\n\n[[CONCEPT_BRIDGE_1]]' }],
        [{ kind: 'problem', body: 'target' },
            { kind: 'component', body: 'inline [[CONCEPT_BRIDGE_1]]' }],
        [{ kind: 'problem', body: 'target' },
            { kind: 'component', body: 'before\n\n[[CONCEPT_BRIDGE_1]]\n\nafter' }],
        [{ kind: 'problem', body: 'target ' },
            { kind: 'component', body: 'source\n\n[[CONCEPT_BRIDGE_1]]' }],
        [{ kind: 'problem', body: 'target' },
            { kind: 'component', body: 'source\n\n[[CONCEPT_BRIDGE_1]]\n\n[[CONCEPT_BRIDGE_9]]' }],
        [{ kind: 'problem', body: 'target' },
            { kind: 'component', body: '```text\n[[CONCEPT_BRIDGE_1]]\n```' }]
    ];
    for (const sections of cases) {
        const input = { sections, conceptBridges: [bridge] };
        const normalized = normalizeReaderDraftOrder(input);
        assert.deepEqual(normalized.draft, input);
        assert.deepEqual(normalized.mapping.conceptMarkerLocations, []);
    }
});

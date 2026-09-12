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

test('stable section ordering preserves table/binding pairs and records replayable raw mappings', () => {
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

test('mixed handwritten/selection tables retain order and simultaneous marker renames do not collide', () => {
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

test('canonical sections normalize a complete selection marker permutation without changing prose bytes', () => {
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

test('canonical marker permutation normalization rejects ambiguous and mixed counterexamples', () => {
    const select = (tableIndex, sourceTableOrdinal = tableIndex) => ({ tableIndex, selection: {
        sourceTableOrdinal, sourceRows: [0, 1], sourceColumns: [0, 1]
    } });
    const ordinary = binding(1, 'source quote long enough');
    const cases = [
        { body: '[[TABLE_2]]\n\n[[TABLE_2]]', bindings: [select(1), select(2)] },
        { body: '[[TABLE_2]]', bindings: [select(1), select(2)] },
        { body: `[[TABLE_2]]\n\n${markdown('handwritten')}`, bindings: [ordinary, select(2)] },
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

test('unsorted ambiguous bindings fail closed with paths on the unchanged input, never discard tables', () => {
    for (const alter of [draft => draft.tableBindings.pop(), draft => { draft.tableBindings[1].tableIndex = 1; },
        draft => { draft.sections[0].body = '[[TABLE_3]]'; }]) {
        const draft = fixture(); alter(draft); const before = JSON.stringify(draft);
        let error;
        try { normalizeReaderDraftOrder(draft); } catch (caught) { error = caught; }
        assert.equal(error?.code, 'READER_DRAFT_ORDER_AMBIGUOUS');
        assert.equal(JSON.stringify(draft), before);
        assert.ok(error.readerIssues.some(issue => issue.path === '/sections/0/body'));
        assert.ok(error.readerIssues.some(issue => issue.path === '/tableBindings/0'));
    }
});

test('unique selection anchors prune only an unbound handwritten table and its dangling narrative', () => {
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

test('ambiguous extra handwritten tables are never pruned', () => {
    const input = { sections: [{ kind: 'result', body: [markdown('one'), markdown('two')].join('\n\n') }],
        tableBindings: [binding(1, 'quote')] };
    const before = structuredClone(input);
    assert.equal(pruneUniquelyUnboundReaderMarkdownTables(input), 0);
    assert.deepEqual(input, before);
});

test('structured table diagnostic paths include the exact binding without parsing a message', () => {
    const draft = normalizeReaderDraftOrder(fixture()).draft;
    const targets = buildRepairTargets(draft, [{ path: '/sections/1/body', bindingPath: '/tableBindings/1', message: '表格单位格式不匹配；应检查source quote' }]);
    assert.deepEqual(targets.map(item => item.path), ['/sections/1/body', '/tableBindings/1']);
});

test('stable same-kind sections and non-bound legacy drafts keep all prose and table bytes', () => {
    const draft = fixture(); draft.sections[2].kind = 'result'; delete draft.tableBindings;
    const out = normalizeReaderDraftOrder(draft).draft;
    assert.deepEqual(out.sections.map(item => item.body), [draft.sections[0].body, draft.sections[2].body, draft.sections[1].body]);
    assert.equal(out.tableBindings, undefined);
});

test('complete bridge marker permutation normalizes array only and records node SHA/index mapping', () => {
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

test('duplicate, missing, noncanonical and malformed bridge markers are not guessed or repaired', () => {
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

test('unique concept markers move or insert into one canonical declared section without rewriting prose', () => {
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

test('adjacent standalone concept markers are separated into distinct Markdown paragraphs', () => {
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

test('concept marker moves and inserts tolerate terminal LF while still rejecting trailing spaces', () => {
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

test('concept marker location normalization refuses ambiguous, inline and non-final moves', () => {
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

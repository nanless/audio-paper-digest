'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const deep = require('../scripts/deep-analyzer.js');
const codec = require('../scripts/lib/protocol-codec.js');
const readerFormat = require('../scripts/lib/reader-record-format.js');
const tables = require('../scripts/lib/reader-tables.js');
const repair = require('../scripts/lib/reader-repair.js');
const draftOrder = require('../scripts/lib/reader-draft-order.js');
const evidenceSlice = require('../scripts/lib/reader-repair-evidence-slice.js');

const ROOT = path.resolve(__dirname, '..');
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');

function makeTableArtifact({ ordinal = 1, matrix, headerRows = [0], bodyRows = null, cells = null, caption = 'Main benchmark results' }) {
    const derivedCells = cells || matrix.flatMap((row, r) => row.map((text, c) => ({
        row: r,
        column: c,
        text,
        rowspan: 1,
        colspan: 1,
        header: headerRows.includes(r),
        sourceDomSha256: sha256(`table-${ordinal}-${r}-${c}-${text}`)
    })));
    return {
        ordinal,
        caption,
        matrix,
        headerRows,
        ...(Array.isArray(bodyRows) ? { bodyRows } : {}),
        cells: derivedCells,
        recoveryStatus: 'complete',
        sourceDomSha256: sha256(`table-dom-${ordinal}`)
    };
}

test('Wave 9: fresh Reader mechanicalContract resolves STRUCTURED_V5 (5–9 节, conceptBridges 0–4) while historical v4/legacy replays stay exact', () => {
    const fresh = deep.buildApiReaderMechanicalContract({ availableTableCount: 3 });
    assert.equal(fresh.editorialProfile, readerFormat.STRUCTURED_V5);
    assert.equal(fresh.minimumIntegratedTables, 3);
    assert.match(fresh.mechanicalContract, /sections 应包含 5–9 个职责清晰的小节/);
    assert.match(fresh.mechanicalContract, /conceptBridges 允许 0–4 组（默认 \[\]/);
    assert.match(fresh.mechanicalContract, /focusPoints 可填 \[\] 或 2–4 项观察要点/);
    assert.match(fresh.mechanicalContract, /chineseCaption/);
    assert.match(fresh.mechanicalContract, /implementationSpecs/);
    assert.doesNotMatch(fresh.mechanicalContract, /8–18 个小节/);
    assert.doesNotMatch(fresh.mechanicalContract, /conceptBridges 应解释 4–10 组/);

    // Historical pre-v4 prompt replay retains LEGACY_INTEGRATED
    const legacyReplay = deep.buildApiReaderMechanicalContract({
        paidPromptReplay: {
            stageFields: {
                promptTemplateSha256: '3d987ea345aee21223f30d514588ee9e2b2f5da7e8cb03894db921809de1cf18'
            }
        },
        availableTableCount: 2
    });
    assert.equal(legacyReplay.editorialProfile, readerFormat.LEGACY_INTEGRATED);
    assert.match(legacyReplay.mechanicalContract, /sections 应包含 8–18 个小节/);
    assert.match(legacyReplay.mechanicalContract, /conceptBridges 应解释 4–10 组/);

    // Historical COHESIVE_V4 prompt replay keeps COHESIVE_V4
    const v4Replay = deep.buildApiReaderMechanicalContract({
        paidPromptReplay: {
            stageFields: {
                promptTemplateSha256: 'b97a038f6eb6317b8b25df48c87620acd89f82239b1e84b6d805544bd2f1fb2e'
            }
        },
        availableTableCount: 2
    });
    assert.equal(v4Replay.editorialProfile, readerFormat.COHESIVE_V4);
    assert.match(v4Replay.mechanicalContract, /sections 应包含 5–9 个职责清晰的小节/);

    // Signed recovery draft respects draft's own editorialProfile
    const legacyDraft = { version: 3 };
    const currentHeader = codec.recordHeader(codec.contract('reader-draft'), 'reader-draft');
    assert.equal(
        deep.resolveApiReaderTargetEditorialProfile({ signedRecoveryDraft: legacyDraft }),
        readerFormat.LEGACY_INTEGRATED
    );
    assert.equal(
        deep.resolveApiReaderTargetEditorialProfile({ signedRecoveryDraft: currentHeader }),
        readerFormat.STRUCTURED_V5
    );

    // Repair candidate draft profile overrides default during local repair
    const repairLegacy = deep.buildApiReaderMechanicalContract({
        candidateDraft: legacyDraft,
        availableTableCount: 2
    });
    assert.equal(repairLegacy.editorialProfile, readerFormat.LEGACY_INTEGRATED);
    assert.match(repairLegacy.mechanicalContract, /sections 应包含 8–18 个小节/);
});

test('Wave 9: READER_SELECTION_EMPTY_HEADER rejects full-width divider header rows and maps cleanly to repair issue', () => {
    // Reproduces 2611.26409 WeMM-Video blank-metric-header bug: `| STEM/Puzzle |  |  |  |`
    const matrix = [
        ['Model', 'STEM', 'Puzzle', 'Avg'],
        ['STEM/Puzzle', '', '', ''],
        ['Baseline', '61.2', '58.4', '59.8'],
        ['WeMM-Video', '74.5', '71.0', '72.8']
    ];
    const cells = [
        // Row 0: real metric headers
        { row: 0, column: 0, text: 'Model', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r0c0') },
        { row: 0, column: 1, text: 'STEM', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r0c1') },
        { row: 0, column: 2, text: 'Puzzle', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r0c2') },
        { row: 0, column: 3, text: 'Avg', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r0c3') },
        // Row 1: full-width divider row mistakenly tagged as <th>
        { row: 1, column: 0, text: 'STEM/Puzzle', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r1c0') },
        { row: 1, column: 1, text: '', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r1c1') },
        { row: 1, column: 2, text: '', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r1c2') },
        { row: 1, column: 3, text: '', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('r1c3') },
        // Data rows
        ...matrix.slice(2).flatMap((row, idx) => row.map((text, col) => ({
            row: idx + 2, column: col, text, rowspan: 1, colspan: 1, header: false,
            sourceDomSha256: sha256(`r${idx + 2}c${col}-${text}`)
        })))
    ];
    // Simulate a table where row 1 is listed in headerRows (without triggering empty_source_header on row 0)
    // Test empty_source_header protection via assessReaderTableSelectionEligibility first:
    const badTable = makeTableArtifact({ ordinal: 1, matrix, headerRows: [0, 1], cells });
    const elig = tables.assessReaderTableSelectionEligibility(badTable);
    assert.equal(elig.eligible, false);
    assert.ok(elig.reasonCodes.includes('empty_source_header'));

    // Now test a table whose divider row uses colspan=4 with non-empty text (passes empty_source_header!)
    const colspanMatrix = [
        ['Model', 'STEM', 'Puzzle', 'Avg'],
        ['STEM/Puzzle', 'STEM/Puzzle', 'STEM/Puzzle', 'STEM/Puzzle'],
        ['Baseline', '61.2', '58.4', '59.8'],
        ['WeMM-Video', '74.5', '71.0', '72.8']
    ];
    const colspanCells = [
        { row: 0, column: 0, text: 'Model', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('c0c0') },
        { row: 0, column: 1, text: 'STEM', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('c0c1') },
        { row: 0, column: 2, text: 'Puzzle', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('c0c2') },
        { row: 0, column: 3, text: 'Avg', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('c0c3') },
        { row: 1, column: 0, text: 'STEM/Puzzle', rowspan: 1, colspan: 4, header: true, sourceDomSha256: sha256('c1span') },
        ...colspanMatrix.slice(2).flatMap((row, idx) => row.map((text, col) => ({
            row: idx + 2, column: col, text, rowspan: 1, colspan: 1, header: false,
            sourceDomSha256: sha256(`c${idx + 2}c${col}-${text}`)
        })))
    ];
    const colspanTable = makeTableArtifact({ ordinal: 1, matrix: colspanMatrix, headerRows: [0, 1], cells: colspanCells });
    const artifacts = { tables: [colspanTable] };

    // Selecting row 0 (real metric headers) succeeds
    const good = tables.renderReaderTableSelection({
        tableIndex: 1,
        selection: { sourceTableOrdinal: 1, sourceRows: [0, 2, 3], sourceColumns: [0, 1, 2, 3] }
    }, artifacts);
    assert.match(good.markdown, /\| Model \| STEM \| Puzzle \| Avg \|/);

    // Selecting divider row 1 where cells[1..3] are blank or full-width colspan triggers READER_SELECTION_EMPTY_HEADER
    const blankRow1Table = makeTableArtifact({
        ordinal: 2,
        matrix: [
            ['Model', 'STEM', 'Puzzle', 'Avg'],
            ['STEM/Puzzle', 'STEM/Puzzle', 'STEM/Puzzle', 'STEM/Puzzle'],
            ['Baseline', '61.2', '58.4', '59.8']
        ],
        headerRows: [0, 1],
        cells: [
            { row: 0, column: 0, text: 'Model', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('b0c0') },
            { row: 0, column: 1, text: 'STEM', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('b0c1') },
            { row: 0, column: 2, text: 'Puzzle', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('b0c2') },
            { row: 0, column: 3, text: 'Avg', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('b0c3') },
            { row: 1, column: 0, text: 'STEM/Puzzle', rowspan: 1, colspan: 4, header: true, sourceDomSha256: sha256('b1span') },
            { row: 2, column: 0, text: 'Baseline', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('b2c0') },
            { row: 2, column: 1, text: '61.2', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('b2c1') },
            { row: 2, column: 2, text: '58.4', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('b2c2') },
            { row: 2, column: 3, text: '59.8', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('b2c3') }
        ]
    });
    // Also test a divider-only table where every declared header row is a full-width colspan divider
    const dividerOnlyTable = makeTableArtifact({
        ordinal: 3,
        matrix: [
            ['STEM/Puzzle', 'STEM/Puzzle', 'STEM/Puzzle', 'STEM/Puzzle'],
            ['Baseline', '61.2', '58.4', '59.8']
        ],
        headerRows: [0],
        cells: [
            { row: 0, column: 0, text: 'STEM/Puzzle', rowspan: 1, colspan: 4, header: true, sourceDomSha256: sha256('d0span') },
            { row: 1, column: 0, text: 'Baseline', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('d1c0') },
            { row: 1, column: 1, text: '61.2', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('d1c1') },
            { row: 1, column: 2, text: '58.4', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('d1c2') },
            { row: 1, column: 3, text: '59.8', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('d1c3') }
        ]
    });
    const divElig = tables.assessReaderTableSelectionEligibility(dividerOnlyTable);
    assert.equal(divElig.eligible, false);
    assert.ok(divElig.reasonCodes.includes('divider_only_source_headers'));

    // Verify blankRow1Table rejects selecting full-width divider row 1 with READER_SELECTION_EMPTY_HEADER
    assert.ok(tables.assessReaderTableSelectionEligibility(blankRow1Table).eligible);
    let caughtEmptyHeader = null;
    assert.throws(() => {
        tables.compileReaderTableSelections(
            [{ kind: 'result', heading: '主实验验证：STEM对比', body: '表前导读。\n\n[[TABLE_1]]\n\n表后解释。' }],
            [{ tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [1, 2], sourceColumns: [0, 1, 2, 3] } }],
            { tables: [blankRow1Table] }
        );
    }, error => {
        caughtEmptyHeader = error;
        return error.code === 'READER_SELECTION_EMPTY_HEADER'
            && error.readerIssues?.[0]?.code === 'reader_selection_empty_header'
            && error.readerIssues?.[0]?.path === '/tableBindings/0';
    });
    const validSectionBody1 = '为了清晰展示本文方法在各个子任务与基准测试中的性能边界，我们汇总了模型在主要指标上的对比实验结果，并围绕模型规模与关键模块变化展开逐项量化分析，以便读者直观理解性能增益来源。\n\n[[TABLE_1]]\n\n从上表数据可以看到，本文方法在各子集上均稳定超越基线模型，平均指标提升显著且跨任务表现一致，证明核心设计能够有效缓解原方法瓶颈。';
    const validSectionBody2 = '为了验证不同规模变体与门控模块对整体识别准确率和推理效率的实际贡献，我们在相同测试集上开展了对照消融实验，记录了各配置下的关键定量指标变化，用于区分结构收益与参数规模效应。\n\n[[TABLE_2]]\n\n对比结果显示，移除门控模块后错误率明显上升，而完整模型在保持相近推理延迟的前提下取得最优精度，说明模块协同机制是主要增益来源。';
    const emptyHeaderDraft = {
        ...codec.recordHeader(codec.contract('reader-draft'), 'reader-draft'),
        readerTitle: '测试论文核心机制与主实验结果分析',
        oneSentenceThesis: '本文通过系统化的实验对比与消融验证，清晰呈现核心架构在多个指标上的显著性能提升。',
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        sections: [{ kind: 'result', heading: '主实验验证：STEM对比分析与性能边界', body: validSectionBody1 }],
        tableBindings: [{ tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [1, 2], sourceColumns: [0, 1, 2, 3] } }]
    };
    const emptyHeaderIssues = repair.collectDraftIssues(emptyHeaderDraft, caughtEmptyHeader, {
        structuredArtifacts: { tables: [blankRow1Table] }
    });
    assert.ok(emptyHeaderIssues.some(i => i.path === '/tableBindings/0' && i.code === 'reader_selection_empty_header'));
    assert.ok(!emptyHeaderIssues.some(i => i.path === null && i.message === caughtEmptyHeader.message));
    // Wave 9 R1 #2: buildRepairTargets stays strictly narrow (['/tableBindings/0']) and does NOT leak '/sections/0/body'
    const emptyHeaderTargets = repair.buildRepairTargets(emptyHeaderDraft, emptyHeaderIssues.filter(i => i.code === 'reader_selection_empty_header'));
    assert.deepEqual(emptyHeaderTargets.map(t => t.path), ['/tableBindings/0']);

    // Wave 9 R1 #3: Unsorted tableBindings remaps error prefix & routes cleanly without path:null fallback
    const unsortedEmptyDraft = {
        ...emptyHeaderDraft,
        sections: [
            { kind: 'result', heading: '主实验验证：基线对比分析与性能边界', body: validSectionBody1 },
            { kind: 'ablation', heading: '消融分析：分组表头与规模影响验证', body: validSectionBody2 }
        ],
        tableBindings: [
            { tableIndex: 2, selection: { sourceTableOrdinal: 2, sourceRows: [1, 2], sourceColumns: [0, 1, 2, 3] } },
            { tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [0, 2], sourceColumns: [0, 1, 2, 3] } }
        ]
    };
    let caughtUnsortedEmpty = null;
    assert.throws(() => {
        tables.compileReaderTableSelections(
            unsortedEmptyDraft.sections,
            unsortedEmptyDraft.tableBindings,
            { tables: [blankRow1Table] }
        );
    }, error => {
        caughtUnsortedEmpty = error;
        return error.code === 'READER_SELECTION_EMPTY_HEADER'
            && error.message.startsWith('读者文章 tableBindings[0] selection 渲染表头缺少列名（全幅分组标题行）：')
            && error.readerIssues?.[0]?.path === '/tableBindings/0'
            && error.readerIssues?.[0]?.message === error.message;
    });
    const unsortedEmptyIssues = repair.collectDraftIssues(unsortedEmptyDraft, caughtUnsortedEmpty, {
        structuredArtifacts: { tables: [blankRow1Table] }
    });
    assert.equal(unsortedEmptyIssues.filter(i => i.code === 'reader_selection_empty_header').length, 1);
    assert.ok(!unsortedEmptyIssues.some(i => i.path === null && i.message === caughtUnsortedEmpty.message));
    assert.deepEqual(
        repair.buildRepairTargets(unsortedEmptyDraft, unsortedEmptyIssues.filter(i => i.code === 'reader_selection_empty_header')).map(t => t.path),
        ['/tableBindings/0']
    );
    // Wave 9 R2 HIGH-3: UNFILTERED collectDraftIssues -> buildRepairTargets on unsortedEmptyDraft stays strictly ['/tableBindings/0']
    const validFull5Sections = [
        { kind: 'problem', heading: '问题定义：语音识别长尾失真成因', body: validSectionBody1.replace('[[TABLE_1]]', '核心问题在于多模态特征时间对齐误差在长序列中持续累积。') },
        { kind: 'method_overview', heading: '方法框架：跨模态门控融合路径设计', body: validSectionBody2.replace('[[TABLE_2]]', '本文设计双向交叉门控模块以动态调节视觉与声学通道权重。') },
        { kind: 'experiment_setup', heading: '实验设置：基准测试与评估指标说明', body: validSectionBody1.replace('[[TABLE_1]]', '所有实验在相同硬件预算与公开测试集划分下完成对比评估。') },
        { kind: 'result', heading: '主实验验证：基线对比分析与性能边界', body: validSectionBody1 },
        { kind: 'ablation', heading: '消融分析：分组表头与规模影响验证', body: validSectionBody2 }
    ];
    const unsortedFullDraft = {
        ...unsortedEmptyDraft,
        sections: validFull5Sections
    };
    const unfilteredUnsortedIssues = repair.collectDraftIssues(unsortedFullDraft, caughtUnsortedEmpty, {
        structuredArtifacts: { tables: [blankRow1Table] }
    });
    assert.ok(!unfilteredUnsortedIssues.some(i => String(i.message || '').includes('tableBindings[1] selection')));
    assert.deepEqual(
        repair.buildRepairTargets(
            unsortedFullDraft,
            unfilteredUnsortedIssues.filter(i => String(i.message || '').includes('渲染表头缺少列名'))
        ).map(t => t.path),
        ['/tableBindings/0']
    );

    // Wave 9 R2 HIGH-2: Two simultaneous selection-only failures stay strictly ['/tableBindings/0', '/tableBindings/1'] without section bloat
    const twoBadSelectionDraft = {
        ...unsortedFullDraft,
        tableBindings: [
            { tableIndex: 1, selection: { sourceTableOrdinal: 2, sourceRows: [1, 2], sourceColumns: [0, 1, 2, 3] } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 2, sourceRows: [0, 2, 99], sourceColumns: [0, 1, 2, 3] } }
        ]
    };
    const twoBadIssues = repair.collectDraftIssues(twoBadSelectionDraft, caughtEmptyHeader, {
        structuredArtifacts: { tables: [blankRow1Table] }
    });
    assert.deepEqual(
        repair.buildRepairTargets(twoBadSelectionDraft, twoBadIssues).map(t => t.path).sort(),
        ['/tableBindings/0', '/tableBindings/1']
    );

    // Wave 9 R2 MEDIUM-2b: Partial-width colspan group header exclusively selected (| Audio | Audio |) triggers READER_SELECTION_EMPTY_HEADER
    const partialGroupTable = makeTableArtifact({
        ordinal: 7,
        matrix: [
            ['Audio', 'Audio', 'Video', 'Video'],
            ['WER', 'CER', 'PSNR', 'SSIM'],
            ['6.4', '2.3', '31.2', '0.94']
        ],
        headerRows: [0, 1],
        cells: [
            { row: 0, column: 0, text: 'Audio', rowspan: 1, colspan: 2, header: true, sourceDomSha256: sha256('p0g0') },
            { row: 0, column: 2, text: 'Video', rowspan: 1, colspan: 2, header: true, sourceDomSha256: sha256('p0g2') },
            { row: 1, column: 0, text: 'WER', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('p1c0') },
            { row: 1, column: 1, text: 'CER', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('p1c1') },
            { row: 1, column: 2, text: 'PSNR', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('p1c2') },
            { row: 1, column: 3, text: 'SSIM', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('p1c3') },
            { row: 2, column: 0, text: '6.4', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('p2c0') },
            { row: 2, column: 1, text: '2.3', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('p2c1') },
            { row: 2, column: 2, text: '31.2', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('p2c2') },
            { row: 2, column: 3, text: '0.94', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('p2c3') }
        ]
    });
    assert.throws(() => {
        tables.renderReaderTableSelection({
            tableIndex: 1,
            selection: { sourceTableOrdinal: 7, sourceRows: [0, 2], sourceColumns: [0, 1] }
        }, { tables: [partialGroupTable] });
    }, error => error.code === 'READER_SELECTION_EMPTY_HEADER');
    // Selecting real metric header row 1 succeeds
    const partialGroupOk = tables.renderReaderTableSelection({
        tableIndex: 1,
        selection: { sourceTableOrdinal: 7, sourceRows: [1, 2], sourceColumns: [0, 1] }
    }, { tables: [partialGroupTable] });
    assert.match(partialGroupOk.markdown, /\| WER \| CER \|/);

    // Check divider row with whitespace-only cells after TeX display projection
    const singleNonEmptyHeaderTable = makeTableArtifact({
        ordinal: 4,
        matrix: [
            ['Model', 'STEM', 'Puzzle'],
            ['STEM/Puzzle', ' ', ' '],
            ['Baseline', '61.2', '58.4']
        ],
        headerRows: [0, 1]
    });
    assert.equal(tables.assessReaderTableSelectionEligibility(singleNonEmptyHeaderTable).eligible, false);

    // Check divider row where non-empty TeX macro projects to empty display on metric cols
    const texEmptyHeaderTable = makeTableArtifact({
        ordinal: 5,
        matrix: [
            ['Model', 'STEM', 'Puzzle'],
            ['STEM/Puzzle', '\\phantom{x}', '\\phantom{y}'],
            ['Baseline', '61.2', '58.4']
        ],
        headerRows: [0, 1]
    });
    assert.equal(tables.assessReaderTableSelectionEligibility(texEmptyHeaderTable).eligible, false);
});

test('Wave 9: READER_DUPLICATE_TABLE rejects duplicate selection/completeTable bindings (incl. post-normalizeReaderDraftOrder) and preserves full evidence', () => {
    const t1 = makeTableArtifact({
        ordinal: 1,
        matrix: [
            ['Model', 'WER', 'CER'],
            ['Base', '8.2', '3.1'],
            ['Ours-S', '6.4', '2.3'],
            ['Ours-L', '5.1', '1.9']
        ]
    });
    const t2 = makeTableArtifact({
        ordinal: 2,
        caption: 'Ablation results across model scales',
        matrix: [
            ['Variant', 'WER', 'RTF'],
            ['No-Gate', '7.4', '0.12'],
            ['Full', '5.1', '0.11']
        ]
    });
    const artifacts = { tables: [t1, t2] };
    const sections = [
        { kind: 'result', heading: '主实验验证：基线对比分析与性能边界', body: '为了清晰展示本文方法在各个子任务与基准测试中的性能边界，我们汇总了模型在主要指标上的对比实验结果，并围绕模型规模与关键模块变化展开逐项量化分析，以便读者直观理解性能增益来源。\n\n[[TABLE_1]]\n\n从上表数据可以看到，本文方法在各子集上均稳定超越基线模型，平均指标提升显著且跨任务表现一致，证明核心设计能够有效缓解原方法瓶颈。' },
        { kind: 'ablation', heading: '消融分析：规模影响与模块贡献验证', body: '为了验证不同规模变体与门控模块对整体识别准确率和推理效率的实际贡献，我们在相同测试集上开展了对照消融实验，记录了各配置下的关键定量指标变化，用于区分结构收益与参数规模效应。\n\n[[TABLE_2]]\n\n对比结果显示，移除门控模块后错误率明显上升，而完整模型在保持相近推理延迟的前提下取得最优精度，说明模块协同机制是主要增益来源。' }
    ];

    // 1. Exact duplicate selection rejected with READER_DUPLICATE_TABLE
    const dupSelectionBindings = [
        { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } },
        { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
    ];
    let caughtDup = null;
    assert.throws(() => {
        tables.compileReaderTableSelections(sections, dupSelectionBindings, artifacts);
    }, error => {
        caughtDup = error;
        return error.code === 'READER_DUPLICATE_TABLE'
            && error.readerIssues?.[0]?.code === 'reader_duplicate_table'
            && error.readerIssues?.[0]?.path === '/tableBindings/1'
            && error.readerIssues?.[0]?.sectionPath === '/sections/1/body'
            && error.readerIssues?.[0]?.duplicateOfTableIndex === 1;
    });

    // Verify reader-repair.collectDraftIssues maps READER_DUPLICATE_TABLE cleanly to /tableBindings/1 + /sections/1/body
    const draft = {
        ...codec.recordHeader(codec.contract('reader-draft'), 'reader-draft'),
        readerTitle: '测试论文核心机制与主实验结果分析',
        oneSentenceThesis: '本文通过系统化的实验对比与消融验证，清晰呈现核心架构在多个指标上的显著性能提升。',
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        sections,
        tableBindings: dupSelectionBindings
    };
    const repairIssues = repair.collectDraftIssues(draft, caughtDup, { structuredArtifacts: artifacts });
    assert.ok(repairIssues.some(i => i.path === '/tableBindings/1' && i.code === 'reader_duplicate_table'));
    assert.ok(!repairIssues.some(i => i.path === null && i.message === caughtDup.message));
    const dupOnlyIssues = repairIssues.filter(i => i.code === 'reader_duplicate_table');
    assert.deepEqual(
        repair.buildRepairTargets(draft, dupOnlyIssues).map(t => t.path).sort(),
        ['/sections/1/body', '/tableBindings/1']
    );

    // Wave 9 R1 #4: reader_duplicate_table MUST NOT slice away alternative tables (returns fullSourceEvidence)
    const longProse = '为了系统验证本模型在多个基准测试中的稳定性与泛化表现，本文逐项对比了不同规模参数配置下的错误率、计算开销与收敛特性。'.repeat(90);
    const fullEvidenceDraft = {
        ...draft,
        sections: [
            { kind: 'result', heading: '主实验验证：基线对比分析与性能边界', body: `${longProse}\n\n[[TABLE_1]]\n\n从上表数据可以看到，本文方法在各子集上均稳定超越基线模型。` },
            { kind: 'ablation', heading: '消融分析：规模影响与模块贡献验证', body: '为了验证不同规模变体与门控模块对整体识别准确率和推理效率的实际贡献，我们在相同测试集上开展了对照消融实验，记录了各配置下的关键定量指标变化。\n\n[[TABLE_2]]\n\n对比结果显示，移除门控模块后错误率明显上升。' }
        ]
    };
    const fullEvidence = `FULL EVIDENCE WITH TABLE_1 AND TABLE_2 (Variant | WER | RTF | No-Gate | 7.4)\n${'详细实验正文证据段落。'.repeat(400)}`;
    const sliceControl = evidenceSlice.selectProvableRepairSourceEvidence({
        fullSourceEvidence: fullEvidence,
        sourceText: 'Full paper text with Table 1 and Table 2 benchmark comparisons and ablations.',
        structuredSourcePayload: artifacts,
        candidateDraft: fullEvidenceDraft,
        repairContext: {
            requestKind: 'patch',
            targets: [{ path: '/tableBindings/1' }],
            issues: [{ code: 'reader_selection_empty_header', path: '/tableBindings/1', message: '读者文章 tableBindings[1] selection 渲染表头全为空' }]
        },
        maxChars: 240000
    });
    assert.notEqual(sliceControl, fullEvidence, 'control single-table selection error should activate narrow slicing');
    const sliceDup = evidenceSlice.selectProvableRepairSourceEvidence({
        fullSourceEvidence: fullEvidence,
        sourceText: 'Full paper text with Table 1 and Table 2 benchmark comparisons and ablations.',
        structuredSourcePayload: artifacts,
        candidateDraft: fullEvidenceDraft,
        repairContext: {
            requestKind: 'patch',
            targets: [{ path: '/tableBindings/1' }],
            issues: dupOnlyIssues
        },
        maxChars: 240000
    });
    assert.equal(sliceDup, fullEvidence, 'reader_duplicate_table must fall back to fullSourceEvidence so alternative tables remain visible');
    // Wave 9 R2 MEDIUM-2a: plain-message duplicate-table diagnostic without `code` also falls back to fullSourceEvidence
    const sliceDupNoCode = evidenceSlice.selectProvableRepairSourceEvidence({
        fullSourceEvidence: fullEvidence,
        sourceText: 'Full paper text with Table 1 and Table 2 benchmark comparisons and ablations.',
        structuredSourcePayload: artifacts,
        candidateDraft: fullEvidenceDraft,
        repairContext: {
            requestKind: 'patch',
            targets: [{ path: '/tableBindings/1' }],
            issues: [{ path: '/tableBindings/1', message: dupOnlyIssues[0].message }]
        },
        maxChars: 240000
    });
    assert.equal(sliceDupNoCode, fullEvidence, 'plain-message duplicate table issue must also fall back to fullSourceEvidence');

    // 2. Duplicate completeTable rejected BOTH directly AND end-to-end through normalizeReaderDraftOrder!
    const dupCompleteDraft = {
        ...draft,
        sections: structuredClone(sections),
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } }
        ]
    };
    assert.throws(() => {
        tables.compileReaderTableSelections(dupCompleteDraft.sections, dupCompleteDraft.tableBindings, artifacts);
    }, error => error.code === 'READER_DUPLICATE_TABLE' && error.readerIssues?.[0]?.path === '/tableBindings/1');

    // Wave 9 R1 #1: Production pipeline runs normalizeReaderDraftOrder BEFORE compileReaderTableSelections
    const normDupComplete = draftOrder.normalizeReaderDraftOrder(dupCompleteDraft, { structuredArtifacts: artifacts }).draft;
    assert.equal(normDupComplete.tableBindings[0].sourceType, 'artifact_table');
    assert.equal(normDupComplete.tableBindings[1].sourceType, 'artifact_table');
    let caughtNormDup = null;
    assert.throws(() => {
        tables.compileReaderTableSelections(normDupComplete.sections, normDupComplete.tableBindings, artifacts);
    }, error => {
        caughtNormDup = error;
        return error.code === 'READER_DUPLICATE_TABLE'
            && error.readerIssues?.[0]?.path === '/tableBindings/1'
            && error.readerIssues?.[0]?.sectionPath === '/sections/1/body'
            && error.readerIssues?.[0]?.duplicateOfTableIndex === 1;
    });
    const normDupIssues = repair.collectDraftIssues(normDupComplete, caughtNormDup, { structuredArtifacts: artifacts });
    assert.ok(normDupIssues.some(i => i.path === '/tableBindings/1' && i.code === 'reader_duplicate_table'));
    assert.ok(!normDupIssues.some(i => i.path === null && i.message === caughtNormDup.message));
    assert.deepEqual(
        repair.buildRepairTargets(normDupComplete, normDupIssues.filter(i => i.code === 'reader_duplicate_table')).map(t => t.path).sort(),
        ['/sections/1/body', '/tableBindings/1']
    );

    // 3. completeTable + identical full selection rejected in BOTH orders through normalizeReaderDraftOrder!
    for (const pair of [
        [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2, 3], sourceColumns: [0, 1, 2] } }
        ],
        [
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2, 3], sourceColumns: [0, 1, 2] } },
            { tableIndex: 2, completeTable: { sourceTableOrdinal: 1 } }
        ]
    ]) {
        const mixedDraft = { ...draft, sections: structuredClone(sections), tableBindings: pair };
        const normMixed = draftOrder.normalizeReaderDraftOrder(mixedDraft, { structuredArtifacts: artifacts }).draft;
        assert.throws(() => {
            tables.compileReaderTableSelections(normMixed.sections, normMixed.tableBindings, artifacts);
        }, error => error.code === 'READER_DUPLICATE_TABLE'
            && error.readerIssues?.[0]?.path === '/tableBindings/1'
            && error.readerIssues?.[0]?.sectionPath === '/sections/1/body');
    }

    // 4. Out-of-order bindings array reports original draft array index and routes to true section/binding (Wave 9 R1 #3)
    const unsortedDupDraft = {
        ...draft,
        sections: structuredClone(sections),
        tableBindings: [
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } },
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    let caughtUnsortedDup = null;
    assert.throws(() => {
        tables.compileReaderTableSelections(unsortedDupDraft.sections, unsortedDupDraft.tableBindings, artifacts);
    }, error => {
        caughtUnsortedDup = error;
        return error.code === 'READER_DUPLICATE_TABLE'
            && error.message.startsWith('读者文章 tableBindings[0]（[[TABLE_2]]）与第 1 张表完全重复')
            && error.readerIssues?.[0]?.path === '/tableBindings/0'
            && error.readerIssues?.[0]?.sectionPath === '/sections/1/body';
    });
    const unsortedDupIssues = repair.collectDraftIssues(unsortedDupDraft, caughtUnsortedDup, { structuredArtifacts: artifacts });
    assert.ok(unsortedDupIssues.some(i => i.path === '/tableBindings/0' && i.code === 'reader_duplicate_table'));
    assert.ok(!unsortedDupIssues.some(i => i.path === null && i.message === caughtUnsortedDup.message));
    assert.deepEqual(
        repair.buildRepairTargets(unsortedDupDraft, unsortedDupIssues.filter(i => i.code === 'reader_duplicate_table')).map(t => t.path).sort(),
        ['/sections/1/body', '/tableBindings/0']
    );

    // Wave 9 R2 HIGH-1: Row/column permutations and source_quotes duplicates are ALSO rejected!
    // 6a. Row permutation of identical selection
    assert.throws(() => {
        tables.compileReaderTableSelections(sections, [
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2, 3], sourceColumns: [0, 1, 2] } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 3, 2, 1], sourceColumns: [0, 1, 2] } }
        ], artifacts);
    }, error => error.code === 'READER_DUPLICATE_TABLE');
    // 6b. Column permutation of identical selection
    assert.throws(() => {
        tables.compileReaderTableSelections(sections, [
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2, 3], sourceColumns: [0, 1, 2] } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2, 3], sourceColumns: [0, 2, 1] } }
        ], artifacts);
    }, error => error.code === 'READER_DUPLICATE_TABLE');
    // 6c. completeTable + row-permuted selection through normalizeReaderDraftOrder
    const permCompleteDraft = {
        ...draft,
        sections: structuredClone(sections),
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 3, 2, 1], sourceColumns: [0, 1, 2] } }
        ]
    };
    const normPerm = draftOrder.normalizeReaderDraftOrder(permCompleteDraft, { structuredArtifacts: artifacts }).draft;
    assert.throws(() => {
        tables.compileReaderTableSelections(normPerm.sections, normPerm.tableBindings, artifacts);
    }, error => error.code === 'READER_DUPLICATE_TABLE');
    // 6d. completeTable + source_quotes with identical rendered Markdown table
    const renderedT1Md = '| Model | WER | CER |\n| --- | --- | --- |\n| Base | 8.2 | 3.1 |\n| Ours-S | 6.4 | 2.3 |\n| Ours-L | 5.1 | 1.9 |';
    const sqMixSections = [
        structuredClone(sections[0]),
        { ...structuredClone(sections[1]), body: sections[1].body.replace('[[TABLE_2]]', renderedT1Md) }
    ];
    const normSqMix = draftOrder.normalizeReaderDraftOrder({
        ...draft,
        sections: sqMixSections,
        tableBindings: [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2 3.1'] }
        ]
    }, { structuredArtifacts: artifacts }).draft;
    assert.throws(() => {
        tables.compileReaderTableSelections(normSqMix.sections, normSqMix.tableBindings, artifacts);
    }, error => error.code === 'READER_DUPLICATE_TABLE' && error.readerIssues?.[0]?.sectionPath === '/sections/1/body');
    // 6e. source_quotes + source_quotes with identical rendered Markdown table
    const sqDupSections = [
        { ...structuredClone(sections[0]), body: sections[0].body.replace('[[TABLE_1]]', renderedT1Md) },
        { ...structuredClone(sections[1]), body: sections[1].body.replace('[[TABLE_2]]', renderedT1Md) }
    ];
    assert.throws(() => {
        tables.compileReaderTableSelections(sqDupSections, [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2 3.1'] },
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2 3.1'] }
        ], artifacts);
    }, error => error.code === 'READER_DUPLICATE_TABLE' && error.readerIssues?.[0]?.path === '/tableBindings/1');

    // Wave 9 R2 MEDIUM-1: buildRepairTargets matches markerIndex when [[TABLE_N]] markers are out of document order
    const swappedMarkerDraft = {
        ...draft,
        sections: [
            { ...structuredClone(sections[0]), body: sections[0].body.replace('[[TABLE_1]]', '[[TABLE_2]]') },
            { ...structuredClone(sections[1]), body: sections[1].body.replace('[[TABLE_2]]', '[[TABLE_1]]') }
        ],
        tableBindings: [
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } },
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    const swappedTargets = repair.buildRepairTargets(swappedMarkerDraft, [{
        code: 'reader_duplicate_table',
        path: '/tableBindings/0',
        duplicateOfTableIndex: 1,
        message: '读者文章 tableBindings[0]（[[TABLE_2]]）与第 1 张表完全重复（相同原表与相同行列）；'
    }]);
    assert.deepEqual(swappedTargets.map(t => t.path).sort(), ['/sections/0/body', '/tableBindings/0']);

    // 5. Distinct non-duplicate row subsets from the same large source table remain ALLOWED
    const compiled = tables.compileReaderTableSelections(sections, [
        { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } },
        { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 2, 3], sourceColumns: [0, 1, 2] } }
    ], artifacts);
    assert.equal(compiled.tableBindings.length, 2);
    assert.match(compiled.sections[0].body, /\| Base \| 8\.2 \| 3\.1 \|/);
    assert.match(compiled.sections[1].body, /\| Ours-L \| 5\.1 \| 1\.9 \|/);
});

test('Wave 9: upgraded writing prompts preserve exact guardrails across Reader and core summary templates', () => {
    const readerArticle = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-article.md'), 'utf8');
    const readerRepair = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-repair.md'), 'utf8');
    const deepAnalysis = fs.readFileSync(path.join(ROOT, 'prompts/current/deep-analysis.md'), 'utf8');
    const coreRepair = fs.readFileSync(path.join(ROOT, 'prompts/current/core-summary-repair.md'), 'utf8');

    assert.match(readerArticle, /严禁使用“记住这个顺序”“务必记住”“不要忘记”/);
    assert.match(readerArticle, /贯穿全文的具体输入样本/);
    assert.match(readerArticle, /并在紧随其后的自然段中有机讲透三个实质问题/);
    assert.match(readerArticle, /同一原表（相同 `sourceTableOrdinal`）不得重复展示相同完整表或数据格重合 >= 50% 的重叠子集/);
    assert.match(readerArticle, /中文与英文或阿拉伯数字之间留一个半角空格/);
    assert.match(readerArticle, /35B-A3B/);

    assert.match(readerRepair, /严禁使用“记住这个顺序”“务必记住”“不要忘记”/);
    assert.match(readerRepair, /公式背后的数学动机\/极端取值行为\/下游作用/);
    assert.match(readerRepair, /同一原表（相同 `sourceTableOrdinal`）不得重复展示相同完整表或数据格重合 >= 50% 的重叠子集/);

    assert.match(deepAnalysis, /直指现有主流路线在物理、统计或架构上的根本失效因果/);
    assert.match(deepAnalysis, /35B-A3B/);
    assert.match(coreRepair, /直指现有主流路线在物理、统计或架构上的根本失效因果/);
    assert.match(coreRepair, /35B-A3B/);
});

test('Wave 9 R3 回归：legacy v3 兼容、重复 tableIndex 不误报、source_quotes 行列重排与加粗防重、无序绑定通用前缀重映射、混排标记精确定位与多层分组表头拦截', () => {
    const t1 = makeTableArtifact({
        ordinal: 1,
        caption: 'Table 1: Main benchmark results comparison',
        matrix: [
            ['Model', 'WER', 'CER'],
            ['Base', '8.2', '3.1'],
            ['Ours-S', '5.9', '2.2'],
            ['Ours-L', '5.1', '1.9']
        ],
        headerRows: [0]
    });
    const artifacts = { tables: [t1] };

    // HIGH-1: legacy v3 draft with identical source_quotes tables still reports reader_result_table_missing in collectDraftIssues
    const v3Fixture = require('./reader-signed-draft-fixture.js').fixture();
    const v3Draft = structuredClone(v3Fixture.draft);
    const v3Issues = repair.collectDraftIssues(v3Draft, new Error('placeholder'), { structuredArtifacts: artifacts });
    assert.ok(
        v3Issues.some(i => i.code === 'reader_result_table_missing'),
        'legacy v3 draft must not swallow result-table coverage check due to source_quotes dedup'
    );

    // HIGH-2: two completely different plain tables whose bindings both declare tableIndex: 1 must NOT throw false READER_DUPLICATE_TABLE
    assert.doesNotThrow(() => tables.compileReaderTableSelections(
        [
            { kind: 'result', body: '| Model | WER | CER |\n| --- | --- | --- |\n| Base | 8.2 | 3.1 |' },
            { kind: 'ablation', body: '| Variant | Latency | RTF |\n| --- | --- | --- |\n| Full | 12ms | 0.11 |' }
        ],
        [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2 3.1'] },
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Full 12ms 0.11'] }
        ],
        { tables: [] }
    ));

    // HIGH-3: source_quotes row swap, column swap, and Markdown bold/italic/code emphasis still collide with completeTable & source_quotes
    for (const [label, dupMd] of [
        ['row-swap', '| Model | WER | CER |\n| --- | --- | --- |\n| Ours-L | 5.1 | 1.9 |\n| Ours-S | 5.9 | 2.2 |\n| Base | 8.2 | 3.1 |'],
        ['col-swap', '| Model | CER | WER |\n| --- | --- | --- |\n| Base | 3.1 | 8.2 |\n| Ours-S | 2.2 | 5.9 |\n| Ours-L | 1.9 | 5.1 |'],
        ['emphasis', '| **Model** | `WER` | *CER* |\n| --- | --- | --- |\n| Base | 8.2 | 3.1 |\n| Ours-S | 5.9 | 2.2 |\n| **Ours-L** | **5.1** | **1.9** |']
    ]) {
        assert.throws(
            () => tables.compileReaderTableSelections(
                [
                    { kind: 'result', body: '主实验结果。\n\n[[TABLE_1]]' },
                    { kind: 'ablation', body: `复述表。\n\n${dupMd}` }
                ],
                [
                    { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
                    { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Ours-L 5.1 1.9'] }
                ],
                artifacts
            ),
            err => err.code === 'READER_DUPLICATE_TABLE',
            `source_quotes duplicate bypass (${label}) must be rejected`
        );
    }

    // HIGH-4: unsorted tableBindings remaps ALL selection errors (not just EMPTY_HEADER) to the true declared array index
    const unsortedDraft = {
        readerTitle: 'Unsorted Selection Error',
        oneSentenceThesis: '一句话主线',
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        sections: [
            { kind: 'result', heading: '主实验', body: '结果。\n\n[[TABLE_1]]' },
            { kind: 'ablation', heading: '消融', body: '消融。\n\n[[TABLE_2]]' }
        ],
        tableBindings: [
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 99], sourceColumns: [0, 1, 2] } },
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    let caughtUnsorted;
    try {
        tables.compileReaderTableSelections(unsortedDraft.sections, unsortedDraft.tableBindings, artifacts);
    } catch (err) {
        caughtUnsorted = err;
    }
    assert.ok(caughtUnsorted, 'out-of-range selection must throw');
    assert.match(caughtUnsorted.message, /^读者文章 tableBindings\[0\] selection /);
    assert.deepEqual(
        repair.buildRepairTargets(unsortedDraft, [{ path: null, message: caughtUnsorted.message }]).map(t => t.path),
        ['/tableBindings/0']
    );

    // MEDIUM-1: mixed out-of-order [[TABLE_2]] (Sec 0) + plain Markdown table (Sec 1) routes every binding strictly to its own section
    const mixedDraft = {
        readerTitle: 'Mixed Out-Of-Order Tables',
        oneSentenceThesis: '一句话主线',
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        sections: [
            { kind: 'result', heading: '主实验', body: '结果。\n\n[[TABLE_2]]' },
            { kind: 'ablation', heading: '消融', body: '消融。\n\n| Model | WER |\n| --- | --- |\n| Base | 8.2 |' }
        ],
        tableBindings: [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1] } }
        ]
    };
    assert.deepEqual(
        repair.buildRepairTargets(mixedDraft, [{
            code: 'reader_duplicate_table',
            path: '/tableBindings/1',
            duplicateOfTableIndex: 1,
            message: '读者文章 tableBindings[1]（[[TABLE_2]]）与第 1 张表完全重复（相同原表与相同行列）；'
        }]).map(t => t.path).sort(),
        ['/sections/0/body', '/tableBindings/1']
    );
    assert.deepEqual(
        repair.buildRepairTargets(mixedDraft, [{
            code: 'reader_duplicate_table',
            path: '/tableBindings/0',
            duplicateOfTableIndex: 2,
            message: '读者文章 tableBindings[0]（[[TABLE_1]]）与第 2 张表完全重复（相同原表与相同行列）；'
        }]).map(t => t.path).sort(),
        ['/sections/1/body', '/tableBindings/0']
    );
    assert.deepEqual(
        repair.buildRepairTargets(mixedDraft, [
            { path: '/tableBindings/0', message: 'tableBindings[0] 单元格数据异常' },
            { path: '/tableBindings/1', message: 'tableBindings[1] 单元格数据异常' }
        ]).map(t => t.path).sort(),
        ['/sections/0/body', '/sections/1/body', '/tableBindings/0', '/tableBindings/1']
    );

    // MEDIUM-2: multi-level grouped headers with rowspan ID col (`| System | WER | WER |`) or multiple group spans (`| Audio | Audio | Video | Video |`) are rejected
    const rowspanGroupTable = makeTableArtifact({
        ordinal: 9,
        matrix: [
            ['System', 'WER', 'WER'],
            ['System', 'test-clean', 'test-other'],
            ['Base', '4.1', '8.2'],
            ['Ours', '2.3', '5.1']
        ],
        headerRows: [0, 1],
        cells: [
            { row: 0, column: 0, text: 'System', rowspan: 2, colspan: 1, header: true, sourceDomSha256: sha256('rs-0-0') },
            { row: 0, column: 1, text: 'WER', rowspan: 1, colspan: 2, header: true, sourceDomSha256: sha256('rs-0-1') },
            { row: 1, column: 1, text: 'test-clean', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('rs-1-1') },
            { row: 1, column: 2, text: 'test-other', rowspan: 1, colspan: 1, header: true, sourceDomSha256: sha256('rs-1-2') },
            { row: 2, column: 0, text: 'Base', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('rs-2-0') },
            { row: 2, column: 1, text: '4.1', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('rs-2-1') },
            { row: 2, column: 2, text: '8.2', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('rs-2-2') },
            { row: 3, column: 0, text: 'Ours', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('rs-3-0') },
            { row: 3, column: 1, text: '2.3', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('rs-3-1') },
            { row: 3, column: 2, text: '5.1', rowspan: 1, colspan: 1, header: false, sourceDomSha256: sha256('rs-3-2') }
        ]
    });
    assert.throws(
        () => tables.renderReaderTableSelection(
            { tableIndex: 1, selection: { sourceTableOrdinal: 9, sourceRows: [0, 2, 3], sourceColumns: [0, 1, 2] } },
            { tables: [rowspanGroupTable] }
        ),
        err => err.code === 'READER_SELECTION_EMPTY_HEADER'
    );
    // Leaf metric header row (row 1: System | test-clean | test-other) remains VALID!
    const validLeaf = tables.renderReaderTableSelection(
        { tableIndex: 1, selection: { sourceTableOrdinal: 9, sourceRows: [1, 2, 3], sourceColumns: [0, 1, 2] } },
        { tables: [rowspanGroupTable] }
    );
    assert.match(validLeaf.markdown, /\| System \| test-clean \| test-other \|/);
});

test('Wave 9 R4: 未变更快照防误报、双射位置匹配、unbound marker 回退、预检透传与下划线蛇形标识符去重', () => {
    const t1 = makeTableArtifact({
        ordinal: 1,
        matrix: [
            ['Model', 'test_clean', 'test_other'],
            ['Base', '4.1', '8.2'],
            ['Ours', '2.3', '5.1']
        ]
    });

    // HIGH-1: locatedTableNodeAndMdKeys snapshots unmutated sections so expanded [[TABLE_1]] never hijacks missing/unbound tableBindings[1]
    assert.throws(
        () => tables.compileReaderTableSelections(
            [
                { kind: 'result', heading: '结果', body: '主表。\n\n[[TABLE_1]]' },
                { kind: 'ablation', heading: '消融', body: '误写标记。\n\n[[TABLE_2]]' }
            ],
            [
                { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } },
                { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Unrelated 99.9%'] }
            ],
            { tables: [t1] }
        ),
        err => err.code !== 'READER_DUPLICATE_TABLE' && /未绑定的 TABLE marker/.test(err.message)
    );
    // Missing table 2 in Sec 1 (prose only) must NOT falsely throw READER_DUPLICATE_TABLE against Table 1 in Sec 0
    assert.doesNotThrow(() => tables.compileReaderTableSelections(
        [
            { kind: 'result', heading: '结果', body: '主表。\n\n[[TABLE_1]]' },
            { kind: 'ablation', heading: '消融', body: '本节尚未插入表。' }
        ],
        [
            { tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } },
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Unrelated 99.9%'] }
        ],
        { tables: [t1] }
    ));

    // HIGH-2 Case A: 3-table mixed out-of-order draft maps distinct plain tables bijectively without colliding on Sec 1
    const mixedThreeDraft = {
        sections: [
            { kind: 'problem', heading: '问题', body: '导读。\n\n[[TABLE_3]]' },
            { kind: 'result', heading: '结果', body: '表一。\n\n| Model | WER |\n| --- | --- |\n| Base | 8.2 |' },
            { kind: 'ablation', heading: '消融', body: '表二。\n\n| Variant | Latency |\n| --- | --- |\n| Full | 12ms |' }
        ],
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        tableBindings: [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] },
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Full 12ms'] },
            { tableIndex: 3, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    // compileReaderTableSelections fails on TABLE_3 order, NOT false READER_DUPLICATE_TABLE on distinct tables
    assert.throws(
        () => tables.compileReaderTableSelections(mixedThreeDraft.sections, mixedThreeDraft.tableBindings, { tables: [t1] }),
        err => err.code !== 'READER_DUPLICATE_TABLE' && /实际正文表格顺序不一致/.test(err.message)
    );
    // buildRepairTargets routes tableBindings[1] -> /sections/2/body (NOT /sections/1/body)
    assert.deepEqual(
        repair.buildRepairTargets(mixedThreeDraft, [
            { path: '/tableBindings/1', message: 'tableBindings[1] 单元格数据异常' }
        ]).map(t => t.path).sort(),
        ['/sections/2/body', '/tableBindings/1']
    );

    // HIGH-2 Case B: shifted plain tableIndexes [2, 3] on 2 distinct plain tables must NOT falsely throw READER_DUPLICATE_TABLE
    assert.doesNotThrow(() => tables.compileReaderTableSelections(
        [
            { kind: 'result', heading: '结果', body: '| Model | WER |\n| --- | --- |\n| Base | 8.2 |' },
            { kind: 'ablation', heading: '消融', body: '| Variant | Latency |\n| --- | --- |\n| Full | 12ms |' }
        ],
        [
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] },
            { tableIndex: 3, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Full 12ms'] }
        ],
        { tables: [] }
    ));

    // HIGH-2 Case C: null-path "第 N 张表" message routes through unique binding match
    const mixedTwoDraft = {
        sections: [
            { kind: 'result', heading: '结果', body: '主表。\n\n[[TABLE_2]]' },
            { kind: 'ablation', heading: '消融', body: '副表。\n\n| Variant | Latency |\n| --- | --- |\n| Full | 12ms |' }
        ],
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        tableBindings: [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Full 12ms'] },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    assert.deepEqual(
        repair.buildRepairTargets(mixedTwoDraft, [{ path: null, message: '第 2 张表缺少数字' }]).map(t => t.path).sort(),
        ['/sections/0/body', '/tableBindings/1']
    );
    assert.deepEqual(
        repair.buildRepairTargets(mixedTwoDraft, [{ path: null, message: '第 1 张表缺少数字' }]).map(t => t.path).sort(),
        ['/sections/1/body', '/tableBindings/0']
    );

    // HIGH-4: checkDuplicates: false lets read-only preflight expand markers without masking reader_result_table_missing
    const compiledNoDup = tables.compileReaderTableSelections(
        [
            { kind: 'training', heading: '训练', body: '| Model | WER |\n| --- | --- |\n| Base | 8.2 |' },
            { kind: 'result', heading: '结果', body: '| Model | WER |\n| --- | --- |\n| Base | 8.2 |' }
        ],
        [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] },
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] }
        ],
        { tables: [] },
        { checkDuplicates: false }
    );
    assert.equal(compiledNoDup.sections.length, 2);

    // MEDIUM-2: underscore bold/italic wrapping snake_case identifiers (__test_clean__, _test_clean_, ___test_clean___) still caught as duplicate
    for (const wrapped of [
        ['__test_clean__', '__test_other__'],
        ['_test_clean_', '_test_other_'],
        ['___test_clean___', '___test_other___']
    ]) {
        assert.throws(
            () => tables.compileReaderTableSelections(
                [
                    { kind: 'result', heading: '结果', body: '主表。\n\n[[TABLE_1]]' },
                    { kind: 'ablation', heading: '消融', body: `重复表。\n\n| Model | ${wrapped[0]} | ${wrapped[1]} |\n| --- | --- | --- |\n| Base | 4.1 | 8.2 |\n| Ours | 2.3 | 5.1 |` }
                ],
                [
                    { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
                    { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 4.1 8.2 Ours 2.3 5.1'] }
                ],
                { tables: [t1] }
            ),
            err => err.code === 'READER_DUPLICATE_TABLE'
        );
    }
});

test('Wave 9 R5: 历史 v3 重复选区冷重放兼容、表例优先顶部表头行、未绑定 marker 优先路由', () => {
    // R5 #2: readerVerifiedTableIndexExamples prefers top header rows (< firstBodyRow) over trailing/mid-table <th> rows
    const trailingThTable = makeTableArtifact({
        ordinal: 1,
        matrix: [
            ['Model', 'WER', 'CER'],
            ['Base-1', '8.2', '3.1'],
            ['Base-2', '6.4', '2.3'],
            ['WeMM-Video', '4.1', '1.5']
        ],
        headerRows: [0, 3],
        bodyRows: [1, 2]
    });
    const midSectionTable = makeTableArtifact({
        ordinal: 2,
        matrix: [
            ['Model', 'WER', 'CER'],
            ['Base-1', '8.2', '3.1'],
            ['Model', 'PESQ', 'STOI'],
            ['Base-2', '3.4', '0.91']
        ],
        headerRows: [0, 2],
        bodyRows: [1, 3]
    });
    const artifacts = { tables: [trailingThTable, midSectionTable], figures: [], formulas: [] };
    const evidence = deep.buildApiReaderArtifactEvidence(artifacts);
    const ex1 = deep.readerVerifiedTableIndexExamples(
        artifacts, evidence, [{ message: 'sourceTableOrdinal=1' }], {}
    ).match(/^TABLE_1_VERIFIED_INDEX_EXAMPLE: (.+?)；/m);
    assert.ok(ex1);
    assert.deepEqual(JSON.parse(ex1[1]).selection.sourceRows, [0, 1, 2]);
    const ex2 = deep.readerVerifiedTableIndexExamples(
        artifacts, evidence, [{ message: 'sourceTableOrdinal=2' }], {}
    ).match(/^TABLE_2_VERIFIED_INDEX_EXAMPLE: (.+?)；/m);
    assert.ok(ex2);
    assert.deepEqual(JSON.parse(ex2[1]).selection.sourceRows, [0, 1, 3]);

    // R5 #4: unbound [[TABLE_1]] marker on a source_quotes binding routes to its own section (Sec 0) rather than stealing Sec 1's plain table
    const caseADraft = {
        sections: [
            { kind: 'result', heading: '结果', body: '误写标记。\n\n[[TABLE_1]]' },
            { kind: 'ablation', heading: '消融', body: '另一张表。\n\n| Model | WER |\n| --- | --- |\n| Base | 8.2 |' }
        ],
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        tableBindings: [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] },
            { tableIndex: 2, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    assert.deepEqual(
        repair.buildRepairTargets(caseADraft, [{ path: '/tableBindings/0', message: 'tableBindings[0] 单元格数据缺少证据' }]).map(t => t.path).sort(),
        ['/sections/0/body', '/tableBindings/0']
    );

    // R5 #4 Case B: shifted marker + unbound marker + plain table still routes plain binding to Sec 2
    const caseBDraft = {
        sections: [
            { kind: 'problem', heading: '问题', body: '导读。\n\n[[TABLE_3]]' },
            { kind: 'result', heading: '结果', body: '误写标记。\n\n[[TABLE_1]]' },
            { kind: 'ablation', heading: '消融', body: '正文表。\n\n| Variant | Latency |\n| --- | --- |\n| Full | 12ms |' }
        ],
        conceptBridges: [],
        figurePlacements: [],
        formulaBindings: [],
        tableBindings: [
            { tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Base 8.2'] },
            { tableIndex: 2, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['Full 12ms'] },
            { tableIndex: 3, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }
        ]
    };
    assert.deepEqual(
        repair.buildRepairTargets(caseBDraft, [{ path: '/tableBindings/1', message: 'tableBindings[1] 单元格数据缺少证据' }]).map(t => t.path).sort(),
        ['/sections/2/body', '/tableBindings/1']
    );
});

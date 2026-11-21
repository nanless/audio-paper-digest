'use strict';
// 全幅分组标题行被当作唯一表头、而所选列里没有任何列名文字时，渲染表头全空，
// 读者看不到列名，发布端逐格核对也无法对应；选择编译必须拒绝并提示选真正的表头行。
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReaderTableSelection } = require('../scripts/lib/reader-tables.js');

const sha = 'b'.repeat(64);
function table() {
    const matrix = [
        ['t', 'System', '2-way', '3-way'],
        ['Baselines', 'Baselines', 'Baselines', 'Baselines'],
        ['t', 'Majority class', '52.0', '48.0'],
        ['t', 'Word majority', '80.7', '62.0'],
    ];
    const cells = [
        { row: 0, column: 0, text: 't', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 0, column: 1, text: 'System', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 0, column: 2, text: '2-way', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 0, column: 3, text: '3-way', header: true, rowspan: 1, colspan: 1, sourceDomSha256: sha },
        { row: 1, column: 0, text: 'Baselines', header: true, rowspan: 1, colspan: 4, sourceDomSha256: sha },
    ];
    for (const row of [2, 3]) for (let column = 0; column < 4; column += 1) {
        cells.push({ row, column, text: matrix[row][column], header: false, rowspan: 1, colspan: 1, sourceDomSha256: sha });
    }
    return { ordinal: 3, caption: 'Results', recoveryStatus: 'complete', sourceDomSha256: sha,
        matrix, headerRows: [0, 1], bodyRows: [2, 3], cells };
}

test('以全幅分组标题行作唯一表头且所选列无文字时拒绝，真正表头行则通过', () => {
    const artifacts = { tables: [table()] };
    const bad = { tableIndex: 1, selection: { sourceTableOrdinal: 3, sourceRows: [1, 2, 3], sourceColumns: [1, 2, 3] } };
    assert.throws(() => renderReaderTableSelection(bad, artifacts), /渲染表头全为空/);
    const good = { tableIndex: 1, selection: { sourceTableOrdinal: 3, sourceRows: [0, 2, 3], sourceColumns: [1, 2, 3] } };
    const rendered = renderReaderTableSelection(good, artifacts);
    assert.match(rendered.markdown, /^\| System \| 2-way \| 3-way \|/);
});

test('空表头的完整诊断定位原绑定，全文预算耗尽后仍只授权该节点', () => {
    const repair = require('../scripts/lib/reader-repair');
    const artifacts = { tables: [table()] };
    const binding = { tableIndex: 1, selection: { sourceTableOrdinal: 3, sourceRows: [1, 2, 3], sourceColumns: [1, 2, 3] } };
    const draft = { sections: [{ kind: 'result', heading: '实验结果的比较条件', body: '比较原论文在相同测试条件下的不同基线，逐项检查方法与数据范围。'.repeat(3)
        + '\n\n[[TABLE_1]]\n\n' + '解释实际结果与适用条件，保留作者报告的指标与比较设置。'.repeat(3) }],
        conceptBridges: [], figurePlacements: [], formulaBindings: [], tableBindings: [binding] };
    let error;
    try { renderReaderTableSelection(binding, artifacts); } catch (cause) { error = cause; }
    assert.equal(error.code, 'READER_SELECTION_EMPTY_HEADER');
    assert.equal(error.readerIssues[0].path, '/tableBindings/0');
    const issues = repair.collectDraftIssues(draft, error, { structuredArtifacts: artifacts });
    const blocking = issues.filter(issue => !issue.diagnosticOnly);
    assert.ok(blocking.length > 0);
    assert.ok(blocking.every(issue => issue.path === '/tableBindings/0'), JSON.stringify(blocking));
    const context = repair.buildRepairContext(draft, issues, '', '', { structuredArtifacts: artifacts });
    assert.deepEqual(context.targets.map(target => target.path), ['/tableBindings/0']);
    assert.equal(repair.isSafeExistingReaderPatchContext(draft, context, false, issues), true);
    assert.equal(repair.isSafeExistingReaderPatchContext(draft, context, false,
        [...issues, { path: null, message: '另一个无法定位的真实问题' }]), false);
    const bad = Object.assign(new Error(error.message), { code: error.code,
        readerIssues: [{ ...error.readerIssues[0], path: '/tableBindings/1' }] });
    assert.ok(repair.collectDraftIssues(draft, bad, { structuredArtifacts: artifacts })
        .some(issue => issue.path === null && !issue.diagnosticOnly));
});

'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const patch = require('../scripts/lib/daily-reader-signed-fact-patch');
const repair = require('../scripts/lib/reader-repair');
const targets = require('../scripts/lib/reader-signed-table-targets');
function repeatedClaimFixture(uniqueQuoted) {
    const rawClaim = '图中实际有七个框', claim = '图中实际有 7 个框';
    const body = uniqueQuoted ? '图中实际有 7 个框。另一图有七个框。原文例句：“图中实际有七个框。”'
        : '图中实际有七个框。原文例句：“图中实际有七个框。”';
    const original = { version: 3, sections: [{ body }], tableBindings: [], formulaBindings: [], figurePlacements: [], conceptBridges: [] };
    const claims = uniqueQuoted ? [claim, rawClaim] : [rawClaim, rawClaim];
    const starts = [body.indexOf(claims[0]), body.lastIndexOf(claims[1])];
    const edits = starts.map((claimStart, index) => {
        const from = uniqueQuoted && index === 0 ? '7' : '七', start = body.indexOf(from, claimStart);
        return { claimIndex: 0, claimStart, start, end: start + 1, from, to: '九', rawClaim: claims[index] };
    });
    let next = '', cursor = 0;
    for (const edit of edits) { next += body.slice(cursor, edit.start) + edit.to; cursor = edit.end; }
    next += body.slice(cursor);
    const draft = structuredClone(original); draft.sections[0].body = next;
    const record = { contract: patch.CONTRACT, parentPaper: { apiReaderArticle: uniqueQuoted
        ? '图中实际有 7 个框。另一图有 7 个框。原文例句：“图中实际有七个框。”'
        : '图中实际有 7 个框。原文例句：“图中实际有七个框。”' }, draft,
    rangeCorrections: [{ path: '/sections/0/body', oldSha256: repair.hashDraft(body), edits }], tableCorrections: [],
    patch: { version: 1, draftSha256: repair.hashDraft(original), replacements: [
        { path: '/sections/0/body', oldSha256: repair.hashDraft(body), value: next }] } };
    const feedback = { primaryFeedback: '', coreFeedback: '', tagFeedback: '', scoringFeedback: '',
        readerFeedback: '仅纠正普通描述的7框，原文引文保持。', rejectedReaderClaims: [claim] };
    return { original, record, feedback };
}
test('范围补丁不能用一条数词反馈同时编辑普通句与受保护引文', () => {
    for (const unique of [false, true]) {
        const x = repeatedClaimFixture(unique), before = JSON.stringify(x.original);
        assert.throws(() => patch.applyBoundedFactPatch(x.original, x.record, x.feedback, {}), /须唯一|上下文保护/);
        assert.equal(JSON.stringify(x.original), before);
    }
});
function tableFixture() {
    const deep = require('../scripts/deep-analyzer');
    const html = '<article><figure class="ltx_table" id="S1.T1"><figcaption>Table 1: Actual measurements.</figcaption>'
        + '<table><thead><tr><th>Model</th><th>Accuracy</th><th>Latency</th></tr></thead>'
        + '<tbody><tr><td>Alpha</td><td>10</td><td>1</td></tr><tr><td>Beta</td><td>20</td><td>2</td></tr></tbody></table></figure></article>';
    const artifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html,
        '2610.00001v1', '2610.00001v1'), 'Actual measurements Model Accuracy Latency Alpha 10 1 Beta 20 2');
    const sourceTable = artifacts.tables[0];
    const full = require('../scripts/lib/reader-tables').renderReaderCompleteTable(
        { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }, artifacts);
    const record = { draft: { sections: [{ body: full.markdown }] },
        patch: { replacements: [{ path: '/tableBindings/0', value: structuredClone(full.binding) }] } };
    const proof = { path: '/tableBindings/0', sourceTableOrdinal: 1, sourceDomSha256: sourceTable.sourceDomSha256 };
    return { record, proof, source: { structuredArtifacts: artifacts }, matrix: structuredClone(sourceTable.matrix) };
}
function replaceMarkdown(x) {
    const line = cells => `| ${cells.join(' | ')} |`;
    x.record.draft.sections[0].body = [line(x.matrix[0]), line(x.matrix[0].map(() => '---')),
        ...x.matrix.slice(1).map(line)].join('\n');
}
test('同原DOM的逐格完整矩形通过，科学值同时随错行/错列改写仍不能混拼', () => {
    const good = tableFixture();
    assert.equal(targets.renderSignedTableTarget(good.record, good.proof, good.source).markdown, good.record.draft.sections[0].body);
    for (const axis of ['row', 'column']) {
        const x = tableFixture(), cells = x.record.patch.replacements[0].value.cellBindings;
        const cell = cells.find(c => c.renderedRow === 1 && c.renderedColumn === 1);
        if (axis === 'row') { cell.sourceRow = 2; x.matrix[1][1] = '20'; }
        else { cell.sourceColumn = 2; x.matrix[1][1] = '1'; }
        replaceMarkdown(x);
        assert.throws(() => targets.renderSignedTableTarget(x.record, x.proof, x.source), /不同原行或原列/);
    }
});
test('整行/整列一致重排也必须保持原DOM顺序，缺格与双DOM覆盖拒绝', () => {
    for (const axis of ['row', 'column']) {
        const x = tableFixture(), cells = x.record.patch.replacements[0].value.cellBindings;
        if (axis === 'row') {
            [x.matrix[1], x.matrix[2]] = [x.matrix[2], x.matrix[1]];
            for (const cell of cells) if (cell.sourceRow) cell.sourceRow = 3 - cell.sourceRow;
        } else {
            for (const row of x.matrix) [row[0], row[1]] = [row[1], row[0]];
            for (const cell of cells) if (cell.sourceColumn < 2) cell.sourceColumn = 1 - cell.sourceColumn;
        }
        replaceMarkdown(x);
        assert.throws(() => targets.renderSignedTableTarget(x.record, x.proof, x.source), /只能按原顺序/);
    }
    const missing = tableFixture(); missing.record.patch.replacements[0].value.cellBindings.pop();
    assert.throws(() => targets.renderSignedTableTarget(missing.record, missing.proof, missing.source), /逐格完整/);
    const duplicate = tableFixture(); duplicate.source.structuredArtifacts.tables[0].cells.push(
        structuredClone(duplicate.source.structuredArtifacts.tables[0].cells[0]));
    assert.throws(() => targets.renderSignedTableTarget(duplicate.record, duplicate.proof, duplicate.source), /身份不唯一/);
});

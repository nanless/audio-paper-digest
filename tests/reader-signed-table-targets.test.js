'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const slots = require('../scripts/lib/reader-signed-table-targets');
const repair = require('../scripts/lib/reader-repair');
const patch = require('../scripts/lib/daily-reader-signed-fact-patch');
const tables = require('../scripts/lib/reader-tables');
function fixture() {
    const deep = require('../scripts/deep-analyzer'), cheerio = require('cheerio');
    const html = fs.readFileSync(path.join(__dirname, 'fixtures/arxiv-reader-source-bindings.html'), 'utf8');
    const sourceText = cheerio.load(html)('body').text();
    const artifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html,
        '2609.00001v1', '2609.00001v1'), sourceText);
    const binding = { tableIndex: 2, selection: { sourceTableOrdinal: 2, sourceRows: [0, 1], sourceColumns: [0, 1, 2] } };
    const old = tables.renderReaderTableSelection(binding, artifacts);
    const a = '| 首表 | 值 |\n| --- | --- |\n| 甲 | 1 |';
    const c = '| 末表 | 值 |\n| --- | --- |\n| 丙 | 3 |';
    const draft = { version: 3, sections: [{ body: '保持原句。\n\n' + a }, { body: '[[TABLE_2]]' }, { body: c }],
        figurePlacements: [], formulaBindings: [], conceptBridges: [], tableBindings: [
            { tableIndex: 1, sourceType: 'source_quotes' }, binding, { tableIndex: 3, sourceType: 'source_quotes' }] };
    const compiled = ['保持原句。\n\n' + a, old.markdown, c].join('\n\n');
    const canonical = { ...old.binding, sourceTableDomSha256: artifacts.tables.find(t => t.ordinal === 2).sourceDomSha256,
        renderedTableSha256: crypto.createHash('sha256').update(old.markdown).digest('hex') };
    const parentPaper = { apiReaderArticle: compiled,
        apiReaderPlan: { tableBindings: [draft.tableBindings[0], canonical, draft.tableBindings[2]] } };
    const value = draft.sections[0].body.replace('保持', '修正');
    const nextBinding = { tableIndex: 2, completeTable: { sourceTableOrdinal: 2 } };
    const result = structuredClone(draft); result.sections[0].body = value; result.tableBindings[1] = nextBinding;
    const sourceTable = artifacts.tables.find(t => t.ordinal === 2);
    const feedback = { readerFeedback: '修正旧句并完整恢复同一来源表的缺行。', primaryFeedback: '', coreFeedback: '',
        tagFeedback: '', scoringFeedback: '', rejectedReaderClaims: ['保持原句。', old.markdown],
        rejectedPrimaryClaims: [], rejectedCoreClaims: [], rejectedTagClaims: [], rejectedScoringClaims: [] };
    const record = { contract: patch.CONTRACT, parentPaper, draft: result,
        rangeCorrections: [{ path: '/sections/0/body', oldSha256: repair.hashDraft(draft.sections[0].body),
            edits: [{ claimIndex: 0, claimStart: 0, start: 0, end: 2, from: '保持', to: '修正' }] }],
        tableCorrections: [{ path: '/tableBindings/1', sectionPath: '/sections/1/body', claimIndex: 1,
            oldTableSha256: repair.hashDraft(old.markdown), sourceTableOrdinal: 2,
            sourceDomSha256: sourceTable.sourceDomSha256, sourceTableSha256: repair.hashDraft(sourceTable) }],
        patch: { version: 1, draftSha256: repair.hashDraft(draft), replacements: [
            { path: '/sections/0/body', oldSha256: repair.hashDraft(draft.sections[0].body), value },
            { path: '/tableBindings/1', oldSha256: repair.hashDraft(binding), value: nextBinding }] } };
    return { draft, record, feedback, source: { structuredArtifacts: artifacts } };
}
test('表序按inline和TABLE占位符一起计数，后表不再错指邻表', () => {
    const x = fixture(), stream = slots.readerTableSlots(x.draft);
    assert.deepEqual(stream.map(s => [s.tableIndex, s.kind, s.sectionPath]), [
        [1, 'inline', '/sections/0/body'], [2, 'marker', '/sections/1/body'], [3, 'inline', '/sections/2/body']]);
    const proof = { path: '/tableBindings/2', sectionPath: '/sections/2/body' };
    assert.match(slots.resolveSignedOriginalTable(x.draft, x.record, proof, x.source).table.markdown, /末表/);
});
test('同源缺行恢复只换现有marker绑定，真实旧编译父表和完整DOM必须均匹配', () => {
    const x = fixture();
    assert.deepEqual(patch.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source), x.record.draft);
    const target = slots.renderSignedTableTarget(x.record, x.record.tableCorrections[0], x.source);
    assert.equal(target.tableIndex, 2);
    assert.equal(target.markdown, tables.renderReaderCompleteTable(x.record.patch.replacements[1].value,
        x.source.structuredArtifacts).markdown);
    assert.equal(slots.readerTableSlots(x.record.draft).length, 3);
});
test('marker缺父表或错源、错像位、伪cell坐标、非完整替换、邻表、错SHA均拒绝', () => {
    const mutations = [
        x => x.record.parentPaper.apiReaderArticle = '',
        x => delete x.record.parentPaper.apiReaderPlan,
        x => x.record.parentPaper.apiReaderPlan.tableBindings[1].sourceTableDomSha256 = 'a'.repeat(64),
        x => x.record.parentPaper.apiReaderPlan.tableBindings[1].renderedTableSha256 = 'a'.repeat(64),
        x => x.record.parentPaper.apiReaderPlan.tableBindings[1].cellBindings[0].sourceRow++,
        x => x.record.tableCorrections[0].sectionPath = '/sections/2/body',
        x => x.record.tableCorrections[0].oldTableSha256 = 'a'.repeat(64),
        x => x.record.tableCorrections[0].sourceTableOrdinal = 1,
        x => x.record.patch.replacements[1].value = { tableIndex: 2, selection: { sourceTableOrdinal: 2,
            sourceRows: [0, 2], sourceColumns: [0, 1, 2] } },
        x => x.feedback.rejectedReaderClaims[1] = '没有逐字原表的笼统意见',
        x => x.draft.sections[1].body = '[[TABLE_3]]',
        x => x.record.draft.sections.push({ body: '| 新 | 表 |\n| --- | --- |\n| 甲 | 9 |' })];
    for (const mutate of mutations) { const x = fixture(); mutate(x);
        assert.throws(() => patch.applyBoundedFactPatch(x.draft, x.record, x.feedback, x.source)); }
});
test('显式artifact新表仅接受同DOM按原序的完整逐格投影，不混拼行列或猜值', () => {
    const build = () => {
        const x = fixture(), complete = tables.renderReaderCompleteTable({ tableIndex: 2,
            completeTable: { sourceTableOrdinal: 2 } }, x.source.structuredArtifacts);
        x.record.patch.replacements[1].value = structuredClone(complete.binding);
        x.record.draft.tableBindings[1] = structuredClone(complete.binding);
        x.record.draft.sections[1].body = complete.markdown;
        return { x, complete };
    };
    const { x, complete } = build();
    assert.equal(slots.renderSignedTableTarget(x.record, x.record.tableCorrections[0], x.source).markdown, complete.markdown);
    const mutations = [
        a => a.record.patch.replacements[1].value.cellBindings[0].sourceRow++,
        a => a.record.patch.replacements[1].value.cellBindings[0].sourceColumn++,
        a => a.record.patch.replacements[1].value.cellBindings.pop(),
        a => a.record.patch.replacements[1].value.cellBindings[1] = a.record.patch.replacements[1].value.cellBindings[0],
        a => a.record.patch.replacements[1].value.cellBindings[0].sourceRow = -1,
        a => a.record.patch.replacements[1].value.sourceQuotes = ['另一张表的单位'],
        a => a.source.structuredArtifacts.tables.find(t => t.ordinal === 2).cells[0].text = '错误原格',
        a => a.source.structuredArtifacts.tables.find(t => t.ordinal === 2).cells[0].sourceDomSha256 = 'fake',
        a => a.record.draft.sections[1].body = a.record.draft.sections[1].body.replace(/\d/, '9')];
    for (const mutate of mutations) { const { x: bad } = build(); mutate(bad);
        assert.throws(() => slots.renderSignedTableTarget(bad.record, bad.record.tableCorrections[0], bad.source)); }
});

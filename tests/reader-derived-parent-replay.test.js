'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('./fixtures/reader-derived-parent/actual-observed-projections.json');
const replay = require('../scripts/lib/reader-derived-parent-replay');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const sha = require('../scripts/lib/daily-fact-review').sha;
const clone = value => structuredClone(value);
const matches = row => replay.parentReplayMatches({ ...row, allowScopedTables: !!row.record });
function refreshPlan(row) {
    row.current.plan.sourceBindingsSha256 = daily.stableHash({ tableBindings: row.current.plan.tableBindings,
        formulaBindings: row.current.plan.formulaBindings });
}

test('真实三篇派生引文差异只比较来源元数据，不替换原父稿', () => {
    for (const original of fixture.rows.filter(r => !r.record)) {
        const row = clone(original), before = JSON.stringify(row);
        assert.notDeepEqual(row.current.plan, row.parent.apiReaderPlan);
        assert.equal(row.current.article, row.parent.apiReaderArticle);
        assert.equal(matches(row), true, row.paperId);
        assert.equal(JSON.stringify(row), before);
    }
});

test('派生引文不放过缺失显式原引文、假引文、错SHA或其他计划字段', () => {
    for (const original of fixture.rows.filter(r => !r.record)) {
        const index = original.current.plan.tableBindings.findIndex((b, i) =>
            JSON.stringify(b) !== JSON.stringify(original.parent.apiReaderPlan.tableBindings[i]));
        for (const mutate of [
            r => { r.current.plan.tableBindings[index].sourceQuotes[0].quote += ' forged'; },
            r => { r.current.plan.tableBindings[index].sourceQuotes[0].sourceQuoteSha256 = '0'.repeat(64); },
            r => { r.current.plan.tableBindings[index].renderedTableSha256 = '0'.repeat(64); },
            r => { r.current.plan.tableBindings[index].cellBindings = [{ renderedRow: 999 }]; },
            r => { r.current.plan.extraOperatorAllowance = true; },
            r => { r.current.article += '\nExtra unsupported paragraph.'; },
            r => { r.current.figures[0].assetSha256 = '0'.repeat(64); },
            r => { r.parent.analysisManifest.stages.apiReaderArticle.sourceBindingsSourceTextSha256 = '0'.repeat(64); }
        ]) {
            const row = clone(original); mutate(row); assert.notDeepEqual(row, original, "negative must change real input"); refreshPlan(row);
            assert.equal(matches(row), false, original.paperId + ' mutation');
        }
        const explicitIndex = original.draft.tableBindings.findIndex((b, i) => b.sourceQuotes?.length
            && JSON.stringify(original.current.plan.tableBindings[i]) !== JSON.stringify(original.parent.apiReaderPlan.tableBindings[i]));
        if (explicitIndex >= 0) {
            const row = clone(original), quote = row.draft.tableBindings[explicitIndex].sourceQuotes[0];
            row.current.plan.tableBindings[explicitIndex].sourceQuotes = row.current.plan.tableBindings[explicitIndex].sourceQuotes.filter(q => q.quote !== quote);
            refreshPlan(row); assert.equal(matches(row), false, 'explicit paid quote must survive');
        }
    }
});

test('真实DuET仅获准表4的同序prune可回看原父矩阵，目标为完整作者Table3', () => {
    const row = clone(fixture.rows.find(r => r.record)), before = JSON.stringify(row);
    assert.notEqual(row.current.article, row.parent.apiReaderArticle);
    assert.equal(matches(row), true);
    assert.equal(replay.parentReplayMatches({ ...row, allowScopedTables: false }), false);
    assert.equal(JSON.stringify(row), before);
    assert.equal(row.record.patch.replacements.length, 6);
    const table = row.source.structuredArtifacts.tables.find(t => t.ordinal === 3);
    assert.equal(table.matrix.length, 26); assert.equal(table.matrix[0].length, 11);
    assert.equal(table.matrix[3][6], '8.68'); assert.equal(table.matrix[4][6], '10.50');
    assert.equal(table.matrix[15][6], '3.07'); assert.equal(table.matrix[16][6], '3.64');
});

test('DuET父CAS、raw、DOM、目标全格、非目标正文/表/公式/像素任一变化均拒绝', () => {
    const original = fixture.rows.find(r => r.record);
    for (const mutate of [
        r => { r.record.parentPaperSha256 = '0'.repeat(64); },
        r => { r.record.parentPaper.apiReaderArticle += ' changed'; },
        r => { r.record.tableCorrections = []; },
        r => { r.record.tableCorrections[0].path = '/tableBindings/2'; },
        r => { r.record.tableCorrections[0].oldTableSha256 = '0'.repeat(64); },
        r => { r.record.tableCorrections[0].sourceDomSha256 = '0'.repeat(64); },
        r => { r.record.tableCorrections[0].sourceTableSha256 = '0'.repeat(64); },
        r => { r.draft.sections[10].body = r.draft.sections[10].body.replace('10.50%', '10.51%'); },
        r => { r.current.article = r.current.article.replace('3.64%', '3.65%'); },
        r => { r.current.article += '\nUnauthorized paragraph prune.'; },
        r => { r.current.article = r.current.article.replace('ASAP', 'ASAP-forged'); },
        r => { r.current.plan.formulaBindings[0].sourceTex = 'invented'; },
        r => { r.current.plan.tableBindings[0].renderedTableSha256 = '0'.repeat(64); },
        r => { r.current.figures[0].url += '?changed'; },
        r => { r.source.structuredArtifacts.tables.find(t => t.ordinal === 3).matrix[3][6] = '8.69'; },
        r => { r.record.draft.tableBindings[3] = { tableIndex: 4, completeTable: { sourceTableOrdinal: 2 } }; r.record.patch.replacements.find(x => x.path === '/tableBindings/3').value = r.record.draft.tableBindings[3]; }
    ]) {
        const row = clone(original); mutate(row); assert.notDeepEqual(row, original, "negative must change real input"); refreshPlan(row);
        assert.equal(matches(row), false, mutate.toString());
    }
});

test('旧或新自动引文不连续来源及重算假quote SHA均不能冒充派生差异', () => {
    const original = fixture.rows[0];
    for (const side of ['current', 'parent']) {
        const row = clone(original), binding = side === 'current' ? row.current.plan.tableBindings[0] : row.parent.apiReaderPlan.tableBindings[0];
        binding.sourceQuotes[0] = { quote: 'fabricated contiguous quote', sourceQuoteSha256: sha('fabricated contiguous quote') };
        if (side === 'current') refreshPlan(row);
        else {
            row.parent.apiReaderPlan.sourceBindingsSha256 = daily.stableHash({ tableBindings: row.parent.apiReaderPlan.tableBindings, formulaBindings: row.parent.apiReaderPlan.formulaBindings });
            row.parent.apiReaderPlanSha256 = daily.stableHash(row.parent.apiReaderPlan);
            row.parent.analysisManifest.stages.apiReaderArticle.planSha256 = row.parent.apiReaderPlanSha256;
            row.parent.analysisManifest.stages.apiReaderArticle.sourceBindingsSha256 = row.parent.apiReaderPlan.sourceBindingsSha256;
        }
        assert.equal(matches(row), false);
    }
});

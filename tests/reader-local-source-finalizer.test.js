'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const { fixture } = require('./reader-signed-draft-fixture');

test('新共享显示操作保持普通正常装配、去掉未保留图片及原输入', () => {
    const f = fixture(), before = JSON.stringify(f);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(f.draft), {
        requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
        requireSourceBindings: true, allowDeterministicQuoteRepair: false,
        structuredArtifacts: f.sourceDetails.structuredArtifacts, sourceText: f.sourceDetails.text,
        availableFigureOrdinals: [1]
    });
    const injected = deep.injectApiReaderFigures(parsed, f.sourceDetails.structuredArtifacts, '2609.12345');
    for (const figures of [structuredClone(f.paper.apiReaderFigures), []]) {
        const ordinals = new Set(figures.map(value => value.ordinal));
        const expected = {...injected,
            plan:{...injected.plan,figurePlacements:injected.plan.figurePlacements.filter(row => ordinals.has(row.figureOrdinal))},
            article:deep.pruneUnmaterializedApiReaderFigureBlocks(injected.article,injected.figures,figures),figures};
        expected.article = deep.normalizeApiReaderFigureMarkdown(expected.article, figures);
        const result = deep.replayApiReaderFinalDisplay(parsed,f.sourceDetails,figures,'2609.12345');
        assert.deepStrictEqual(result, expected);
    }
    assert.equal(JSON.stringify(f),before);
});

test('新来源收尾入口不能由原API记录、布尔或普通JSON输入授予本地能力', async () => {
    const f = fixture({noFigures:true}), before=JSON.stringify(f);
    for (const paper of [f.paper,{...f.paper,source:'conference'},
        {...f.paper,source:'conference',scopeKind:'source_core_correction',operator:true}]) {
        await assert.rejects(deep.finalizeConferenceLocalSourceCorrection(paper,f.sourceDetails),
            error=>error.code==='CONFERENCE_SOURCE_RESOURCE_CORRECTION_INTEGRITY');
    }
    assert.equal(JSON.stringify(f),before);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { shortProceedingsFixture } = require('./helpers/conference-short-proceedings-fixture');
const context = require('../scripts/lib/conference-analysis-context');
// Expose the actual private gate without changing its body, source or require.cache.
const filename = path.resolve(__dirname, '../scripts/deep-analyzer.js');
const deepModule = new Module(filename, module);
deepModule.filename = filename;
deepModule.paths = Module._nodeModulePaths(path.dirname(filename));
deepModule._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.testTextProfile = resolveConferenceTextProfile;\n', filename);
const deep = deepModule.exports;

for (const conferenceId of ['jep-2026', 'icmc-2026']) {
    test(`${conferenceId} 真实计划、PDF抽取和私有来源在主分析与两种刷新共用短篇全文准入`, async t => {
        const fixture = await shortProceedingsFixture(t, { conferenceId });
        const { paper, details, handle } = fixture;
        assert.ok(details.text.length >= 3000 && details.text.length <= 5000);
        assert.equal(details.conferenceCapabilities.tables, 'unavailable');
        assert.equal(details.conferenceCapabilities.formulas, 'unavailable');
        await fixture.withSource(async () => {
            assert.deepEqual(deep.testTextProfile(paper, details, details.text), {
                hasFullText: true, analysisConfidence: 'short_proceedings', shortProceedings: true
            });
            // Deliberately stop at the next existing SHA guard: no model is reached.
            const saved = { ...paper, analysis: 'saved complete analysis', sourceSha256: '0'.repeat(64),
                analysisManifest: { sourceAcquisition: { sourceSha256: '0'.repeat(64) },
                    stages: { scoringAudit: { status: 'complete' } } } };
            await assert.rejects(deep.refreshApiReaderArticleFromSource(saved, details), /全文 SHA 与 canonical 来源不一致/);
            await assert.rejects(deep.refreshApiScoringAndReaderFromSource(saved, details), /全文 SHA 与 canonical 来源不一致/);
            assert.equal(deep.testTextProfile({ ...paper, conference: { id: 'icassp-2026' } }, details, details.text).hasFullText, false);
            assert.equal(deep.testTextProfile(paper, { ...details, text: details.text + 'x' }, details.text + 'x').hasFullText, false);
            assert.equal(deep.testTextProfile(paper, details, 'x'.repeat(2999)).hasFullText, false);
        });
        assert.equal(deep.testTextProfile(paper, details, details.text).hasFullText, false,
            'persisted JSON alone cannot grant the short-paper exception');
        const identity = { executionId: fixture.loaded.run.executionId, executionDir: fixture.loaded.directory,
            paperId: paper.id, sourceDetails: details };
        context.withConferenceAnalysisSource(identity, () => {
            assert.equal(deep.testTextProfile(paper, details, details.text).hasFullText, false);
        });
        assert.throws(() => context.withConferenceAnalysisSource({ ...identity,
            readerPdfSourceHandle: JSON.parse(JSON.stringify(handle)) }, () => {}), /authority differs/);
    });
}

test('普通来源保留严格5000字符边界，不借会议短篇档位降门槛', () => {
    const paper = { id: '2610.12345', arxivId: '2610.12345' };
    const details = { source: 'arxiv_html', text: 'x'.repeat(5000) };
    assert.equal(deep.testTextProfile(paper, details, details.text).hasFullText, false);
    assert.equal(deep.testTextProfile(paper, details, details.text + 'x').hasFullText, true);
});

test('真实长PDF保留原全文档位，短PDF来源字节变化须拒绝，恢复后仍可正常准入', async t => {
    const long = await shortProceedingsFixture(t, { lines: 120 });
    assert.ok(long.details.text.length > 5000);
    long.withSource(() => assert.deepEqual(deep.testTextProfile(long.paper, long.details, long.details.text), {
        hasFullText: true, analysisConfidence: 'full_text', shortProceedings: false
    }));
    const short = await shortProceedingsFixture(t);
    const ledger = short.ledgerFile;
    const original = fs.readFileSync(ledger);
    short.withSource(() => {
        fs.writeFileSync(ledger, Buffer.concat([original, Buffer.from(' ')]));
        try {
            assert.throws(() => deep.testTextProfile(short.paper, short.details, short.details.text),
                /SHA|读取时|recorded|来源/);
        } finally { fs.writeFileSync(ledger, original); }
        assert.equal(deep.testTextProfile(short.paper, short.details, short.details.text).hasFullText, true);
    });
});

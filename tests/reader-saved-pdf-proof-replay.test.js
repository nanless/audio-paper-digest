'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const inputFile = process.env.PD_SAVED_PDF_REPLAY_RECORDS;
const sourceRoot = process.env.PD_SAVED_PDF_REPLAY_SOURCE_ROOT;
if (sourceRoot) require('../scripts/config').FILES.dailyFreshSourceRunsDir = sourceRoot;
const hash = value => {
    const normalize = x => Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map(k => [k, normalize(x[k])])) : x;
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
};
function renewHashes(paper) {
    paper.apiReaderPlan.sourceBindingsSha256 = hash({ tableBindings: paper.apiReaderPlan.tableBindings,
        formulaBindings: paper.apiReaderPlan.formulaBindings });
    paper.apiReaderPlanSha256 = hash(paper.apiReaderPlan);
    Object.assign(paper.analysisManifest.stages.apiReaderArticle, {
        planSha256: paper.apiReaderPlanSha256, sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256 });
}
const options = { skip: (!inputFile || !sourceRoot) && '需显式提供保存稿及其真实封存来源，不能用模拟证明代替' };
test('真实保存稿仅规则SHA改变时重新核验，不改文章和原执行次数', options, () => {
    const deep = require('../scripts/deep-analyzer');
    const engine = require('../scripts/analysis-engine');
    const bytes = fs.readFileSync(inputFile);
    const papers = JSON.parse(bytes).papers;
    for (const id of ['2610.08847', '2610.03381']) {
        const original = papers.find(p => String(p.arxivId).replace(/v\d+$/, '') === id);
        assert.ok(original);
        const paper = structuredClone(original), stage = original.analysisManifest.stages.apiReaderArticle;
        assert.equal(deep.repairApiReaderArticleAndPlanBindings(paper, paper.analysisManifest), true);
        assert.equal(paper.apiReaderArticle, original.apiReaderArticle);
        assert.equal(paper.apiReaderArticleSha256, original.apiReaderArticleSha256);
        assert.equal(paper.analysis, original.analysis);
        assert.deepEqual(paper.freshRewriteProvenance, original.freshRewriteProvenance);
        for (const field of ['attempts', 'fullAttempts', 'transportFailures', 'status', 'fingerprint']) {
            assert.deepEqual(paper.analysisManifest.stages.apiReaderArticle[field], stage[field]);
        }
        const left = structuredClone(paper), right = structuredClone(original);
        for (const item of [left, right]) {
            delete item.apiReaderPlan; delete item.apiReaderPlanSha256;
            delete item.analysisManifest.stages.apiReaderArticle;
        }
        assert.deepEqual(left, right);
        assert.equal(engine.hasValidApiReaderV3Records(paper), true);
        assert.equal(deep.repairApiReaderArticleAndPlanBindings(paper, paper.analysisManifest), false);
    }
    assert.deepEqual(fs.readFileSync(inputFile), bytes);
});
test('头字形数值PDF后端或原身份不同不允许只更新SHA且不改输入', options, () => {
    const replay = require('../scripts/lib/reader-pdf-cell-evidence').replaySavedProofMetadata;
    const original = JSON.parse(fs.readFileSync(inputFile)).papers.find(p => String(p.arxivId).startsWith('2610.08847'));
    for (const mutate of [
        proof => { proof.pdfSha256 = '0'.repeat(64); },
        proof => { proof.headerProofs[0].text += ' changed'; },
        proof => { proof.confirmedCells[0].visibleText += ' changed'; },
        proof => { proof.backendImplementationSha256 = '0'.repeat(64); },
        proof => { proof.originalTableDomSha256 = '0'.repeat(64); }
    ]) {
        const paper = structuredClone(original);
        mutate(paper.apiReaderPlan.tableBindings.find(b => b.pdfCellConfirmation).pdfCellConfirmation);
        renewHashes(paper);
        const before = structuredClone(paper);
        assert.throws(() => replay(paper), /改变/);
        assert.deepEqual(paper, before);
    }
});

'use strict';
// 2026-11-16 修复回归：只刷新论文图时，若正文或计划发生变化，必须先登记
// 「旧证明作废」再覆盖 stage 的 articleSha256/planSha256。
// readerRevisionHistory.previousArticleSha256 / previousPlanSha256 记的是
// **旧值**；先赋值再 supersede 会把新 SHA 写进历史，后续 verifyRevisionPointer
// 与原始完成证明对不上，整批会按 run 级失败停下（提交 5bace678 的「序号证明
// 作废顺序错」）。这里锁死写入顺序，改回旧顺序应当变红。
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const deep = require('../scripts/deep-analyzer.js');
const direct = require('../scripts/lib/direct-rewrite-analysis-context.js');

const paperId = '2609.12345';
const sourceText = 'An official description of the listening protocol.';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// 与既有 reader-figure-refresh-source.test.js 同形的来源与已签 Reader 记录；
// 不使用 2609.15067，避免命中该论文专属的旧图号/旧图注拒绝分支。
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-revision-order-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const figures = ['overview.png', 'method.png'].map((name, index) => ({
        ordinal: index + 1,
        label: `Figure ${index + 1}:`,
        caption: `Figure ${index + 1}: Source-backed protocol ${index + 1}.`,
        sourceDomSha256: String(index + 1).repeat(64),
        recoveryStatus: 'complete',
        images: [{ kind: 'external_url', mediaType: 'image/png', url: `https://arxiv.org/html/${paperId}v1/${name}` }]
    }));
    const source = {
        paperId: `arxiv:${paperId}`, source: 'html', sourceId: paperId, text: sourceText,
        structuredArtifacts: { figures, tables: [], formulas: [], payloadSha256: sha('sealed figures') }
    };
    const plan = {
        ...require('../scripts/lib/reader-stage-protocols').header('article'),
        sections: [{ kind: 'result', heading: '来源核对' }],
        figurePlacements: [1, 2].map(n => ({
            figureOrdinal: n, targetKind: 'result', marker: `[[FIGURE_${n}]]`
        }))
    };
    const result = deep.injectApiReaderFigures(
        { plan, article: '### 来源核对\n\n[[FIGURE_1]]\n\n[[FIGURE_2]]' }, source.structuredArtifacts, paperId
    );
    const paper = {
        arxivId: paperId, authors: ['Source Author'], sourceSha256: sha(sourceText),
        apiReaderArticle: result.article, apiReaderPlan: result.plan, apiReaderFigures: result.figures,
        analysisManifest: {
            contracts: { apiReaderArticle: deep.API_READER_ARTICLE_CONTRACT },
            sourceAcquisition: {
                sourceSha256: sha(sourceText),
                structuredArtifactsSha256: source.structuredArtifacts.payloadSha256
            },
            stages: {
                apiReaderArticle: {
                    status: 'complete',
                    structuredArtifactsSha256: source.structuredArtifacts.payloadSha256
                }
            }
        }
    };
    deep.refreshApiReaderAuthorsFromSource(paper, source);
    return { source, paper, directory };
}

// 补齐生产不变量：stage 上的正文/计划 SHA 与保存稿一致，并带上一份序号完成证明。
function sealStage(paper) {
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    stage.articleSha256 = sha(paper.apiReaderArticle);
    stage.planSha256 = deep.stableFingerprint(paper.apiReaderPlan);
    stage.ordinalCompletionProof = {
        path: '/tmp/reader-ordinals/completion-00000001.json',
        sha256: 'f'.repeat(64)
    };
    return { articleSha256: stage.articleSha256, planSha256: stage.planSha256 };
}

function refresh(f) {
    return direct.withDirectRewriteAnalysisSource({
        paperId: `arxiv:${paperId}`,
        route: 'arxiv-fresh-fetch',
        sourceDetails: f.source,
        readerAttemptsDir: f.directory,
        materializeReaderFigures: async figures => figures.map(item => ({ ...item, assetSha256: sha(item.url) }))
    }, () => deep.refreshApiReaderFiguresFromSource(f.paper, f.source));
}

test('正文与计划都变化时，重做历史记录的是旧 SHA 而不是已覆盖的新值', async t => {
    const f = fixture(t);
    const before = sealStage(f.paper);
    // 同时制造正文与计划变化：改第一条图注（正文叙事重写）并清空图位置声明
    // （计划 SHA 变化）。两者都变，才能同时验证两个 previous* 字段。
    f.paper.apiReaderFigures[0] = {
        ...f.paper.apiReaderFigures[0],
        caption: 'Figure 1: Revised source-backed protocol.'
    };
    f.paper.apiReaderPlan.figurePlacements = [];
    const result = await refresh(f);
    const stage = result.analysisManifest.stages.apiReaderArticle;
    const history = result.readerRevisionHistory;
    assert.ok(history, '发生重做时必须写入 readerRevisionHistory');
    assert.equal(history.contract, 'daily-reader-revision-history-v1');
    assert.equal(history.reason, 'stage-invalidated');
    assert.equal(history.previousArticleSha256, before.articleSha256);
    assert.equal(history.previousPlanSha256, before.planSha256);
    // 新值确实已更新，排除「两个 previous 只是恰好等于新值」的假绿。
    assert.equal(result.apiReaderArticleSha256, sha(result.apiReaderArticle));
    assert.equal(result.apiReaderPlanSha256, deep.stableFingerprint(result.apiReaderPlan));
    assert.notEqual(result.apiReaderArticleSha256, before.articleSha256);
    assert.notEqual(result.apiReaderPlanSha256, before.planSha256);
    assert.equal(stage.articleSha256, result.apiReaderArticleSha256);
    assert.equal(stage.planSha256, result.apiReaderPlanSha256);
    assert.equal(stage.ordinalCompletionProof, undefined, '旧完成证明应已作废移除');
});

test('正文与计划都没变时属于幂等刷新，不写重做历史也不动旧完成证明', async t => {
    const f = fixture(t);
    const before = sealStage(f.paper);
    const result = await refresh(f);
    assert.equal(result.readerRevisionHistory, undefined);
    assert.equal(result.apiReaderArticleSha256, before.articleSha256);
    assert.equal(result.apiReaderPlanSha256, before.planSha256);
    assert.deepEqual(
        result.analysisManifest.stages.apiReaderArticle.ordinalCompletionProof,
        { path: '/tmp/reader-ordinals/completion-00000001.json', sha256: 'f'.repeat(64) }
    );
});

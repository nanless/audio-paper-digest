'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Reuse the normal sealed-source fixture, including real parent fingerprints,
// without running its tests or mocking a source/lock/Reader qualification gate.
const fixtureFile = path.join(__dirname, 'normal-reader-only-feedback.test.js');
const fixtureModule = new Module(fixtureFile, module);
fixtureModule.filename = fixtureFile; fixtureModule.paths = module.paths;
fixtureModule._compile(fs.readFileSync(fixtureFile, 'utf8').split("const saved = require('../scripts/lib/saved-fact-feedback');")[0]
    .replace('fixture({ noFigures: true,', 'fixture({ noFigures: false,')
    .replace('...signed.sourceDetails, text: sourceText,',
        "...signed.sourceDetails, imageInfos:[{url:'https://arxiv.org/html/2609.12345v1/figure.png',caption:'Official figure'}], text: sourceText,")
    + '\nmodule.exports={createReviewedReaderSample,deep,daily,fresh,engine};', fixtureFile);
const { createReviewedReaderSample, deep, daily, fresh, engine } = fixtureModule.exports;
const deepFile = require.resolve('../scripts/deep-analyzer');
const internals = new Module(deepFile, module);
internals.filename = deepFile; internals.paths = module.paths;
internals._compile(fs.readFileSync(deepFile, 'utf8') + '\nmodule.exports.testNormalImageFingerprints={buildImageDownloadFingerprint,buildImageSupplementBaseFingerprint};', deepFile);
const normal = internals.exports.testNormalImageFingerprints;
const forbidden = require('../scripts/lib/analysis-stop-control').withModelRequestsForbidden;

async function sample(t) {
    const f = await createReviewedReaderSample(t);
    delete f.paper.analysisManifest.stages.apiReaderArticle.factReview;
    delete f.paper.analysisManifest.stages.apiReaderArticle.reviewFeedbackSha256;
    f.paper.analysisStageCheckpoints.scoringAudit = f.paper.analysis;
    delete f.paper.analysisManifest.stages.imageSupplement;
    const candidates = deep.selectImageCandidates(deep.normalizeImageInfos(f.source.imageInfos), 20);
    f.paper.analysisManifest.stages.imageDownload = { status: 'pending',
        reason: 'deferred_until_legacy_image_supplement', attempted: 0, downloaded: 0, outcomes: [],
        fingerprint: normal.buildImageDownloadFingerprint(candidates) };
    f.paper.paidResponseHistory = [{ stage: 'apiReaderArticle', attempts: 5, fullAttempts: 1, cost: 1.25 }];
    f.run = fn => forbidden(() => daily.withDailyFreshAnalysisContext(f.plan, () =>
        engine.withPaperAnalysisLock(f.paper, () => fresh.withFreshPaperContext(f.paper, () =>
            daily.withDailyFreshPaperSource(f.plan, f.paper, source => fn(f.paper, source))))));
    return f;
}
function withoutTail(paper) {
    const clone = structuredClone(paper);
    delete clone.analysisManifest.stages.imageDownload;
    delete clone.analysisManifest.stages.imageSupplement;
    delete clone.analysisManifest.updatedAt;
    return clone;
}

test('正常封存来源和已签Reader用相同正常指纹结束deferred图片，仅变两尾阶段且零模型', async t => {
    const f = await sample(t), before = withoutTail(f.paper);
    await f.run((paper, source) => {
        assert.equal(deep.finalizeDeferredDailyReaderImages(paper, source), true);
        const stages = paper.analysisManifest.stages;
        const candidates = deep.selectImageCandidates(deep.normalizeImageInfos(source.imageInfos), 20);
        const contract = deep.currentPromptTextContract('imageSupplement');
        assert.equal(stages.imageDownload.fingerprint, normal.buildImageDownloadFingerprint(candidates));
        assert.equal(stages.imageSupplement.fingerprint, deep.buildImageSupplementFingerprint(
            normal.buildImageSupplementBaseFingerprint(contract), candidates, [], paper.analysis));
        assert.equal(stages.imageSupplement.promptTextContract, contract);
        assert.equal(stages.imageDownload.status, 'skipped');
        assert.equal(stages.imageSupplement.status, 'skipped');
        assert.equal(stages.imageSupplement.officialFiguresSha256, deep.stableFingerprint(paper.apiReaderFigures));
        assert.equal(engine.hasValidApiReaderV3Records(paper), true);
        assert.deepEqual(withoutTail(paper), before);
        assert.equal(deep.finalizeDeferredDailyReaderImages(paper, source), false);
    });
});

test('无日更作用域不收尾，缺论文锁的当前日更拒绝且原状态不变', async t => {
    const f = await sample(t), before = structuredClone(f.paper);
    assert.equal(deep.finalizeDeferredDailyReaderImages(f.paper, f.source), false);
    await daily.withDailyFreshAnalysisContext(f.plan, () => fresh.withFreshPaperContext(f.paper, () => {
        assert.throws(() => deep.finalizeDeferredDailyReaderImages(f.paper, f.source));
    }));
    assert.deepEqual(f.paper, before);
});

for (const [name, alter] of Object.entries({
    'Reader正文损坏': p => { p.apiReaderArticle += '不属于已签稿'; },
    '官方图绑定损坏': p => { p.apiReaderFigures[0].caption += '篡改'; },
    '没有官方图': p => { p.apiReaderFigures = []; },
    '原请求计数非零': p => { p.analysisManifest.stages.imageDownload.attempted = 1; },
    '原下载非零': p => { p.analysisManifest.stages.imageDownload.downloaded = 1; },
    '原下载指纹不符': p => { p.analysisManifest.stages.imageDownload.fingerprint = '0'.repeat(64); },
    '资源绑定损坏': p => { p.apiReaderResources.identitySha256 = '0'.repeat(64); },
    '评分绑定损坏': p => { p.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = '0'.repeat(64); },
    '评分原稿损坏': p => { p.analysisStageCheckpoints.scoringAudit += '伪造'; },
    '上游阶段变旧': p => { p.analysisManifest.stages.openSourceScan.fingerprint = '0'.repeat(64); },
    '已有插图阶段': p => { p.analysisManifest.stages.imageSupplement = { status: 'pending' }; }
})) test(`拒绝${name}，不补签或修改任何原记录`, async t => {
    const f = await sample(t);
    await f.run((paper, source) => {
        alter(paper); const before = structuredClone(paper);
        assert.throws(() => deep.finalizeDeferredDailyReaderImages(paper, source));
        assert.deepEqual(paper, before);
    });
});

test('不能借同正文替换来源图片元数据或四源身份', async t => {
    const f = await sample(t);
    await f.run((paper, source) => {
        const before = structuredClone(paper);
        for (const bad of [{ ...source, imageInfos: [] }, { ...source, text: source.text + 'changed' },
            { ...source, freshSourceDescriptor: { ...source.freshSourceDescriptor, sourceSha256: '0'.repeat(64) } }]) {
            assert.throws(() => deep.finalizeDeferredDailyReaderImages(paper, bad));
            assert.deepEqual(paper, before);
        }
    });
});

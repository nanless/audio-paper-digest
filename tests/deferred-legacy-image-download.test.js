'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

test('正常日更入口在正文分析前只记录待下载，不下载旧插图', () => {
    const project = path.join(__dirname, '..');
    let prefix = fs.readFileSync(path.join(__dirname, 'daily-fact-review.test.js'), 'utf8')
        .split("test('只读反馈严格绑定")[0];
    prefix = prefix.replace("const deep = require('../scripts/deep-analyzer');", String.raw`
const Module = require('node:module');
const deepFile = require.resolve('../scripts/deep-analyzer');
const compiled = new Module(deepFile, module);
compiled.filename = deepFile;
compiled.paths = module.paths;
require.cache[deepFile] = compiled;
const secondaryBefore = { ...Config.SECONDARY_MODEL_CONFIG };
Object.assign(Config.SECONDARY_MODEL_CONFIG, { model: 'ci-secondary-model',
    endpoint: 'https://opencode.ai/zen/go/v1', key: 'synthetic-local-only' });
try {
compiled._compile(fs.readFileSync(deepFile, 'utf8') + '\n' +
    'let legacyDownloadCalls = 0;\n' +
    'downloadImagesSerial = async () => { legacyDownloadCalls++; throw new Error("不应下载旧插图"); };\n' +
    'module.exports.legacyDownloadCallsForTest = () => legacyDownloadCalls;\n', deepFile);
} finally { Object.assign(Config.SECONDARY_MODEL_CONFIG, secondaryBefore); }
const deep = compiled.exports;`);
    prefix = prefix.replace('imageInfos:[],structuredArtifacts:artifacts',
        "imageInfos:[{url:'https://example.invalid/official-figure.png',caption:'Official figure'}],structuredArtifacts:artifacts");
    const filename = path.join(project, 'tests', 'deferred-legacy-child.cjs');
    fs.writeFileSync(filename, prefix + `
(async () => {
    const sample = await fixture({ after() {} });
    let saved;
    sample.paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')] = paper => {
        if (paper.analysisManifest.stages.imageDownload) {
            saved = structuredClone({ stage: paper.analysisManifest.stages.imageDownload,
                images: paper.analysisRecoveryImageManifest });
            throw new Error('TEST_INITIAL_CHECKPOINT');
        }
    };
    await assert.rejects(daily.withDailyFreshAnalysisContext(sample.plan, () =>
        daily.createDailyAnalyzeFn(sample.plan, { analyze: paper => deep.analyzePaperDeep(paper) })(sample.paper)),
        /TEST_INITIAL_CHECKPOINT/);
    assert.equal(deep.legacyDownloadCallsForTest(), 0);
    assert.equal(saved.stage.status, 'pending');
    assert.equal(saved.stage.reason, 'deferred_until_legacy_image_supplement');
    assert.equal(saved.stage.attempted, 0);
    assert.equal(saved.stage.downloaded, 0);
    assert.deepEqual(saved.stage.outcomes, []);
    fs.rmSync(sample.root, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    try {
        const result = cp.spawnSync(process.execPath, [filename], { cwd: project, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
        fs.unlinkSync(filename);
    }
});

// 末端测试直接编译生产函数中延迟下载的原始代码块；只提供阶段输入，
// 不模拟下载串行器，也不声称已跑过完整正文与 Reader 的事实校验。
function loadDeferredDownloadStep() {
    const Module = require('node:module');
    const filename = require.resolve('../scripts/deep-analyzer');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('    if (deferDailyLegacyImages && isDualModel) {',
        source.indexOf('    const preImageAnalysis ='));
    const end = source.indexOf('    // 失效后阶段已被删除', start);
    assert.ok(start > 0 && end > start);
    const compiled = new Module(filename, module);
    compiled.filename = filename;
    compiled.paths = module.paths;
    const Config = require('../scripts/config');
    const secondaryBefore = { ...Config.SECONDARY_MODEL_CONFIG };
    Object.assign(Config.SECONDARY_MODEL_CONFIG, { model: 'ci-secondary-model',
        endpoint: 'https://opencode.ai/zen/go/v1', key: 'synthetic-local-only' });
    try {
    compiled._compile(source + `
module.exports.runDeferredDownloadStepForTest = async ({ paper, analysisManifest, imageManifest,
    candidateImageUrls, downloader, savedCoreSummaryRepairActive = false }) => {
    const deferDailyLegacyImages = true;
    const directSource = true;
    const directPrimaryImageDownloader = downloader;
    const imageDiscoveryError = null;
    const imageDownloadFingerprint = 'test-download-fingerprint';
    let downloadedImages = [];
    let downloadOutcomes = [];
    let downloadStatus = 'pending';
    const hasBoundApiReaderFigures = hasCompleteApiReaderFigureBinding(paper, analysisManifest);
    const recoveryFingerprints = { imageSupplement: 'test-base' };
    const candidateImageInfos = candidateImageUrls.map(url => ({ url }));
    const preImageAnalysis = '';
    let imageSupplementFingerprint = '';
    invalidateRecoveryStageIfChanged(paper, analysisManifest, 'imageSupplement', 'test-initial-fingerprint');
${source.slice(start, end)}
    return { downloadedImages, downloadOutcomes, downloadStatus, analysisManifest, imageManifest };
};`, filename);
    } finally { Object.assign(Config.SECONDARY_MODEL_CONFIG, secondaryBefore); }
    return compiled.exports;
}

test('官方 Reader 图绑定后旧下载明确跳过；确需旧补图才沿原顺序下载', async () => {
    const deep = loadDeferredDownloadStep();
    const urls = ['https://example.invalid/one.png', 'https://example.invalid/two.png'];
    const figures = [{ figureOrdinal: 1 }];
    const paper = { apiReaderFigures: figures };
    const manifest = { contracts: { apiReaderArticle: 'beginner-researcher-v3' }, stages: {
        apiReaderArticle: { status: 'complete', figureCount: 1, figuresSha256: deep.stableFingerprint(figures) }
    } };
    let calls = 0;
    const skipped = await deep.runDeferredDownloadStepForTest({ paper, analysisManifest: manifest,
        imageManifest: {}, candidateImageUrls: urls, downloader: async () => { calls++; throw new Error('不应下载'); } });
    assert.equal(calls, 0);
    assert.equal(skipped.analysisManifest.stages.imageDownload.status, 'skipped');
    assert.equal(skipped.analysisManifest.stages.imageDownload.attempted, 0);
    const visited = [];
    const downloaded = await deep.runDeferredDownloadStepForTest({ paper: {},
        analysisManifest: { stages: { imageSupplement: { status: 'complete', fingerprint: 'old-stale-fingerprint' } } },
        imageManifest: {}, candidateImageUrls: urls,
        downloader: async url => {
            visited.push(url);
            return { base64: 'YQ==', mime: 'image/png', sha256: 'a'.repeat(64), cacheHit: false };
        } });
    assert.deepEqual(visited, urls);
    assert.equal(downloaded.downloadedImages.length, 2);
    assert.equal(downloaded.analysisManifest.stages.imageDownload.status, 'complete');
    assert.equal(downloaded.analysisManifest.stages.imageDownload.attempted, 2);
    assert.deepEqual(downloaded.imageManifest.downloadOutcomes.map(item => item.status), ['downloaded', 'downloaded']);
});

test('确需旧补图但下载失败时保存实际失败，不假报成功', async () => {
    const deep = loadDeferredDownloadStep();
    let calls = 0;
    const result = await deep.runDeferredDownloadStepForTest({ paper: {}, analysisManifest: { stages: {} },
        imageManifest: {}, candidateImageUrls: ['https://example.invalid/missing.png'],
        downloader: async () => { calls++; return { failureType: 'transient_failure', reason: '测试下载失败' }; } });
    assert.equal(calls, 1);
    assert.equal(result.downloadedImages.length, 0);
    assert.equal(result.analysisManifest.stages.imageDownload.status, 'transient_failure');
    assert.equal(result.analysisManifest.stages.imageDownload.attempted, 1);
    assert.equal(result.analysisManifest.stages.imageDownload.downloaded, 0);
    assert.equal(result.imageManifest.downloadOutcomes[0].reason, '测试下载失败');
});

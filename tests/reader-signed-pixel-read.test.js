'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const child = `
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [code, directory, mode] = process.argv.slice(1);
const Config = require(path.join(code, 'scripts/config.js'));
Config.CURRENT_DIR = directory;
const { createCanvas } = require('@napi-rs/canvas');
const bytes = createCanvas(768, 1200).toBuffer('image/png');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const utils = require(path.join(code, 'scripts/utils.js'));
const originalRequest = utils.requestLlmJson;
let llmRequests = 0;
utils.requestLlmJson = async () => { llmRequests++; throw new Error('本地测试不能请求模型'); };
const { fixture, sign } = require(path.join(code, 'tests/reader-signed-draft-fixture.js'));
const data = fixture(), paper = data.paper;
for (const figure of paper.apiReaderFigures) {
    const filename = 'figure-' + figure.ordinal + '-' + sha.slice(0, 16) + '.png';
    Object.assign(figure, { assetSha256: sha, assetBytes: bytes.length, assetFilename: filename,
        assetMediaType: 'image/png', cachePath: path.join(directory, 'api-reader-assets', paper.arxivId, filename) });
    fs.mkdirSync(path.dirname(figure.cachePath), { recursive: true });
    fs.writeFileSync(figure.cachePath, bytes, { mode: 0o644 });
}
const { stableHash } = require(path.join(code, 'scripts/lib/fresh-rewrite-run.js'));
const stage = paper.analysisManifest.stages.apiReaderArticle;
stage.imageEvidenceCount = paper.apiReaderFigures.length;
stage.imageEvidenceSha256 = stableHash(paper.apiReaderFigures.map(figure => ({
    ordinal: figure.ordinal, url: figure.url, sha256: figure.assetSha256
})));
sign(paper);
const parentBytes = JSON.stringify(paper);
const { reconstructReaderDraftFromVerifiedArticle } = require(path.join(code, 'scripts/lib/reader-signed-draft.js'));
const repair = require(path.join(code, 'scripts/lib/reader-repair.js'));
const recovered = reconstructReaderDraftFromVerifiedArticle(data);
const patch = { version: 1, draftSha256: recovered.proof.draftSha256, replacements: [{
    path: '/sections/0/body', oldSha256: repair.hashDraft(recovered.draft.sections[0].body),
    value: recovered.draft.sections[0].body + String.fromCharCode(10, 10)
        + '补充核对时需要保留实验条件，不能仅凭模型名字认定指标提升。'
}] };
const request = { version: 1, runId: data.runId, paperId: paper.arxivId,
    parentPaperSha256: stableHash(paper), parentArticleSha256: paper.apiReaderArticleSha256,
    parentPlanSha256: paper.apiReaderPlanSha256, sourceSha256: paper.sourceSha256,
    reason: '按原文补充已审查的实验条件边界。', patch };
const run = { runId: data.runId, paperIds: [paper.arxivId],
    sourceExpectations: { [paper.arxivId]: { sourceSha256: paper.sourceSha256 } } };
const target = paper.apiReaderFigures[0].cachePath;
const originalOpen = fs.openSync, originalRead = fs.readFileSync;
let replaced = false, targetFd, pixelReads = 0, replacementIdentity, publicReadStack;
fs.openSync = function (filename, ...args) {
    if (filename === target && mode === 'fifo' && !replaced) {
        replaced = true;
        fs.renameSync(target, target + '.original');
        execFileSync('mkfifo', [target]);
        const stat = fs.lstatSync(target);
        replacementIdentity = { dev: stat.dev, ino: stat.ino };
    }
    if (filename === target) publicReadStack = new Error().stack;
    const fd = originalOpen.call(fs, filename, ...args);
    if (filename === target) targetFd = fd;
    return fd;
};
fs.readFileSync = function (filename, ...args) {
    if (filename === targetFd) pixelReads++;
    return originalRead.call(fs, filename, ...args);
};
(async () => {
    let observation;
    try {
        const result = await require(path.join(code, 'scripts/lib/reader-signed-operator.js'))
            .prepareReaderOperatorPatchResult({ parent: paper, sourceDetails: data.sourceDetails, run, request,
                patchFileSha256: 'e'.repeat(64), appliedAt: '2026-09-06T08:00:00Z' });
        observation = { valid: require(path.join(code, 'scripts/analysis-engine.js')).hasValidApiReaderV3Records(result.paper),
            figures: result.paper.apiReaderFigures.length, newApiRequests: result.provenance.newApiRequests };
    } catch (error) {
        observation = { rejected: true, name: error.name, message: error.message };
    } finally {
        fs.openSync = originalOpen;
        fs.readFileSync = originalRead;
        utils.requestLlmJson = originalRequest;
    }
    let fdClosed = false;
    try { fs.fstatSync(targetFd); } catch (error) { fdClosed = error.code === 'EBADF'; }
    const stat = fs.lstatSync(target);
    Object.assign(observation, { replaced, pixelReads, fdClosed, llmRequests,
        signedPixelRead: publicReadStack?.includes('reuseSignedApiReaderFigureAssets') === true
            && publicReadStack.includes('prepareReaderOperatorPatchResult'), parentUnchanged: JSON.stringify(paper) === parentBytes,
        originalBytesUnchanged: originalRead(target + (replaced ? '.original' : '')).equals(bytes),
        fifoRemains: stat.isFIFO(), replacementUnchanged: !replacementIdentity
            || (replacementIdentity.dev === stat.dev && replacementIdentity.ino === stat.ino) });
    console.log('OBSERVATION:' + JSON.stringify(observation));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const mode of ['normal', 'fifo']) {
    test(mode === 'normal' ? '人工正文修复复用普通 PNG，保留像素文件且不新增 API 请求'
        : '人工正文修复读取的 PNG 被换成命名管道时，在读取像素前及时拒绝',
    { skip: mode === 'fifo' && process.platform === 'win32' }, t => {
        const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'signed-pixel-read-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const result = spawnSync(process.execPath, ['-e', child, path.resolve(__dirname, '..'), directory, mode], {
            encoding: 'utf8', timeout: 5000
        });
        assert.equal(result.error, undefined, '公开人工修复入口应及时结束，不应等待管道写入者');
        assert.equal(result.status, 0, result.stderr);
        const line = result.stdout.split('\n').find(value => value.startsWith('OBSERVATION:'));
        assert.ok(line, result.stdout);
        const observation = JSON.parse(line.slice('OBSERVATION:'.length));
        assert.equal(observation.parentUnchanged, true);
        assert.equal(observation.signedPixelRead, true);
        assert.equal(observation.llmRequests, 0);
        assert.equal(observation.originalBytesUnchanged, true);
        assert.equal(observation.fdClosed, true);
        if (mode === 'normal') {
            assert.equal(observation.valid, true);
            assert.equal(observation.figures, 1);
            assert.equal(observation.newApiRequests, 0);
            assert.equal(observation.pixelReads, 1);
        } else {
            assert.equal(observation.rejected, true);
            assert.equal(observation.name, 'Error');
            assert.equal(observation.message, 'Operator signed figure cache bytes changed');
            assert.equal(observation.pixelReads, 0);
            assert.equal(observation.fifoRemains, true);
            assert.equal(observation.replacementUnchanged, true);
        }
    });
}

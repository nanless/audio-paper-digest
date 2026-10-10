'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4+vUrAAXCAuCuRnaIAAAAAElFTkSuQmCC', 'base64');
const projectRoot = path.resolve(__dirname, '..');

const readReference = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [root, mode, pngBase64] = process.argv.slice(1);
const Config = require(path.join(root, 'scripts/config'));
const originalCurrent = Config.CURRENT_DIR;
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visual-reference-read-')));
console.log(JSON.stringify({ directory }));
const originalOpen = fs.openSync;
const originalClose = fs.closeSync;
let openedDescriptor;
let closed = false;
let replaced = false;
try {
    Config.CURRENT_DIR = directory;
    const { fixture, sign } = require(path.join(root, 'tests/reader-signed-draft-fixture'));
    const { paper } = fixture();
    const originalBytes = Buffer.from(pngBase64, 'base64');
    const bytes = mode === 'bad-png' ? Buffer.alloc(originalBytes.length) : originalBytes;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    for (const figure of paper.apiReaderFigures) {
        const filename = 'figure-' + figure.ordinal + '-' + sha256.slice(0, 16) + '.png';
        Object.assign(figure, {
            assetSha256: sha256,
            assetBytes: bytes.length,
            assetFilename: filename,
            assetMediaType: 'image/png',
            cachePath: path.join(directory, 'api-reader-assets', paper.arxivId, filename)
        });
        fs.mkdirSync(path.dirname(figure.cachePath), { recursive: true });
        fs.writeFileSync(figure.cachePath, bytes, { mode: 0o644 });
    }
    const { stableHash } = require(path.join(root, 'scripts/lib/fresh-rewrite-run'));
    const stage = paper.analysisManifest.stages.apiReaderArticle;
    stage.imageEvidenceCount = paper.apiReaderFigures.length;
    stage.imageEvidenceSha256 = stableHash(paper.apiReaderFigures.map(figure => ({
        ordinal: figure.ordinal, url: figure.url, sha256: figure.assetSha256
    })));
    sign(paper);
    const filename = paper.apiReaderFigures[0].cachePath;
    if (mode === 'hardlink') fs.linkSync(filename, filename + '.linked');
    if (mode === 'symlink') {
        fs.renameSync(filename, filename + '.original');
        fs.symlinkSync(filename + '.original', filename);
    }
    if (mode === 'bad-sha') fs.writeFileSync(filename, Buffer.alloc(bytes.length));
    fs.openSync = function (name, ...args) {
        if (name === filename && mode === 'fifo' && !replaced) {
            replaced = true;
            fs.renameSync(filename, filename + '.original');
            execFileSync('mkfifo', [filename]);
        }
        const descriptor = originalOpen.call(fs, name, ...args);
        if (name === filename) openedDescriptor = descriptor;
        return descriptor;
    };
    fs.closeSync = function (descriptor) {
        if (descriptor === openedDescriptor) closed = true;
        return originalClose.call(fs, descriptor);
    };
    let failure;
    let references;
    try {
        references = require(path.join(root, 'scripts/visual-summary-state'))
            .selectVisualReferenceImages(paper);
    } catch (error) {
        failure = { message: error.message, code: error.code || null };
    }
    console.log(JSON.stringify({
        references: references?.length,
        expected: paper.apiReaderFigures.length,
        allHashCorrect: references?.every(reference => reference.sha256 === sha256),
        mode: fs.lstatSync(mode === 'symlink' ? filename + '.original' : filename).mode & 0o777,
        closed,
        replaced,
        originalBytesUnchanged: mode === 'fifo'
            ? fs.readFileSync(filename + '.original').equals(originalBytes) : null,
        fifoRemains: mode === 'fifo' ? fs.lstatSync(filename).isFIFO() : null,
        failure
    }));
} finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    Config.CURRENT_DIR = originalCurrent;
    fs.rmSync(directory, { recursive: true, force: true });
}
`;

const cases = {
    normal: '权限为 0644 的真实 PNG 正常读取并核对内容 SHA',
    fifo: '打开前换成需要等待写入的管道时及时拒绝并关闭文件',
    hardlink: '图片有多个硬链接时拒绝并关闭文件',
    symlink: '图片被换成符号链接时拒绝',
    'bad-sha': '图片内容与已保存 SHA 不符时仍拒绝',
    'bad-png': '文件 SHA 正确但内容不是 PNG 时仍拒绝'
};
for (const [mode, title] of Object.entries(cases)) {
    test('读取已核验 Reader 的参考图片：' + title, t => {
        if (mode === 'fifo' && process.platform === 'win32') return t.skip('本用例需要系统支持命名管道');
        const result = spawnSync(process.execPath, ['-e', readReference, projectRoot, mode,
            png.toString('base64')], { encoding: 'utf8', timeout: 5000 });
        const firstLine = result.stdout.split('\n')[0];
        if (firstLine) {
            const { directory } = JSON.parse(firstLine);
            t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        }
        assert.equal(result.error, undefined, '公开图片读取入口必须及时返回，不得等待管道写入');
        assert.equal(result.status, 0, result.stderr);
        const observation = JSON.parse(result.stdout.trim().split('\n').at(-1));
        if (mode === 'normal') {
            assert.equal(observation.failure, undefined);
            assert.equal(observation.references, observation.expected);
            assert.equal(observation.allHashCorrect, true);
            assert.equal(observation.mode, 0o644);
        } else {
            assert.ok(observation.failure, '不安全或内容错误的图片必须被拒绝');
            if (mode === 'symlink') assert.equal(observation.failure.code, 'ELOOP');
            else if (mode === 'bad-sha') assert.match(observation.failure.message, /字节 SHA 与已保存记录不一致/);
            else if (mode === 'bad-png') assert.match(observation.failure.message, /必须是真实 PNG/);
            else assert.match(observation.failure.message, /缓存文件\/大小非法/);
        }
        if (mode !== 'symlink') assert.equal(observation.closed, true);
        if (mode === 'fifo') {
            assert.equal(observation.replaced, true);
            assert.equal(observation.originalBytesUnchanged, true);
            assert.equal(observation.fifoRemains, true);
        }
    });
}

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const Config = require('../scripts/config.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
const {
    CARD_KINDS,
    planVisualSummaries: planVisualSummariesImpl,
    recordVisualSummaryCard,
    markVisualSummaryCardFailed,
    pendingVisualSummaryCards,
    validatePngAsset,
    extractGeneratedImagePathFromHint,
    archiveLegacyVisualManifestAssets,
    assertPublishedBlogReceipt,
    assertVisualManifestCurrent,
    selectVisualReferenceImages,
    validateReferenceImageBytes,
    prepareVisualReferenceInputs,
    assertVisualArchiveUniqueness,
    parseArgs,
    main
} = require('../scripts/visual-summary-state.js');

const TEST_PUBLICATION = Object.freeze({
    publicationCommit: 'd'.repeat(40),
    generationManifestSha256: 'e'.repeat(64)
});

function planVisualSummaries(options) {
    return planVisualSummariesImpl({ publication: TEST_PUBLICATION, ...options });
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(kind, payload) {
    const type = Buffer.from(kind, 'ascii');
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    type.copy(chunk, 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])), 8 + payload.length);
    return chunk;
}

function makePng(width = 768, height = 1200) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale
    const scanlines = Buffer.alloc((width + 1) * height);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(scanlines)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

const PNG = makePng();

function patchVisualDirs(currentDir) {
    Config.CURRENT_DIR = currentDir;
    Config.FILES.visualSummaryManifestDir = path.join(currentDir, 'visual-summary-manifests');
    Config.FILES.visualSummaryAssetDir = path.join(path.dirname(currentDir), 'archive');
}

function paper(id = '2607.12345', extra = {}) {
    return validAnalysisPaper(id, {
        title: 'Visual summary paper',
        fetchedAt: '2026-07-13T10:00:00.000+08:00',
        parsed: { score: 6.9, primaryTaskTag: '#语音识别' },
        ...extra
    });
}

function writePublishedReceipt(currentDir, targetDate, publishedPapers, overrides = {}) {
    fs.mkdirSync(currentDir, { recursive: true });
    const generationPath = path.join(currentDir, `blog-generation-manifest-${targetDate}.json`);
    const generation = {
        schemaVersion: 3, date: targetDate, category: '论文速递',
        visualSummaryRequired: false, digestCoverRequired: false,
        inputFingerprint: 'c'.repeat(64), publishedPapers
    };
    const raw = Buffer.from(JSON.stringify(generation));
    fs.writeFileSync(generationPath, raw);
    const receiptPath = path.join(currentDir, `blog-review-receipt-${targetDate}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({
        schemaVersion: 3, date: targetDate, strictReview: true, hugoGate: 'hugo',
        reviewProtocolFingerprint: 'b'.repeat(64),
        generationManifestSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        publicationCommit: 'a'.repeat(40), remoteVerifiedOid: 'a'.repeat(40),
        remoteVerifiedAt: '2026-07-14T02:00:00+08:00', ...overrides
    }));
    return receiptPath;
}

function writeImageCache(currentDir, url, raw, mime = 'image/png') {
    const key = crypto.createHash('sha256').update(url).digest('hex');
    const cacheDir = path.join(currentDir, 'image-cache');
    const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${key}.bin`), raw);
    fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify({
        url, mime, bytes: raw.length, sha256
    }));
    return sha256;
}

describe('visual summary state', () => {
    it('视觉状态 CLI 拒绝未知、缺值和重复参数', () => {
        assert.throws(() => parseArgs(['status', '--unknown', 'value']), /未知参数/);
        assert.throws(() => parseArgs(['status', '--date']), /无效参数/);
        assert.throws(
            () => parseArgs(['status', '--date', '2026-07-13', '--date', '2026-07-14']),
            /只能指定一次/
        );
    });

    it('只把已选中且缓存 SHA 完整匹配的论文关键图绑定到生图任务', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-reference-'));
        const current = path.join(dir, 'current');
        const url = 'https://arxiv.org/html/2607.12345v1/figure/method.png';
        const raw = Buffer.from('verified-paper-figure');
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        try {
            patchVisualDirs(current);
            const sha256 = writeImageCache(current, url, raw);
            const input = paper('2607.12345', {
                selectedImageUrls: [url],
                imageManifest: {
                    selected: [url],
                    candidates: [{ url, caption: 'Figure 1: Method architecture overview.' }],
                    downloaded: [{ url, mime: 'image/png', sha256 }]
                }
            });
            const references = selectVisualReferenceImages(input);
            assert.strictEqual(references.length, 1);
            assert.strictEqual(references[0].role, 'method_reference');
            assert.strictEqual(references[0].sha256, sha256);
            assert.match(references[0].cachePath, /image-cache\/.*\.bin$/);

            const promptPath = path.join(dir, 'prompt.md');
            const manifestPath = path.join(dir, 'manifest.json');
            fs.writeFileSync(promptPath, 'fresh visual prompt');
            const first = planVisualSummaries({
                targetDate: '2026-07-13', papers: [input], manifestPath, promptPath
            });
            assert.deepStrictEqual(first.papers['2607.12345'].generationContext.referenceImages, references);
            assert.strictEqual(
                first.papers['2607.12345'].generationContext.qaClaims.exactEnglishTitle,
                'Visual summary paper'
            );
            assert.deepStrictEqual(
                first.papers['2607.12345'].generationContext.qaClaims.requiredSections,
                ['研究问题与核心贡献', '方法模块与信号流', '关键实验发现', '结论与局限']
            );
            assert.deepStrictEqual(first.papers['2607.12345'].generationContext.rendering, {
                mode: 'full_image_generation_v2',
                renderer: 'built-in image_gen',
                resolutionPolicy: 'highest_available_portrait',
                orientation: 'portrait',
                preferredAspectRatio: '1:2',
                minimumWidth: 768,
                minimumHeight: 1024,
                maxPngBytes: 8 * 1024 * 1024
            });
            assert.ok(!Object.hasOwn(first.papers['2607.12345'].generationContext.rendering, 'width'));
            assert.ok(!Object.hasOwn(first.papers['2607.12345'].generationContext.rendering, 'height'));
            const firstToken = first.papers['2607.12345'].cards.infographic.taskToken;

            fs.writeFileSync(path.join(current, 'image-cache', `${crypto.createHash('sha256').update(url).digest('hex')}.bin`), Buffer.from('changed'));
            const second = planVisualSummaries({
                targetDate: '2026-07-13', papers: [input], manifestPath, promptPath
            });
            assert.deepStrictEqual(second.papers['2607.12345'].generationContext.referenceImages, []);
            assert.notStrictEqual(second.papers['2607.12345'].cards.infographic.taskToken, firstToken);
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
        }
    });

    it('含 per-method EER 的图归为实验参考，不被 method 子串误判为方法图', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-result-reference-'));
        const current = path.join(dir, 'current');
        const url = 'https://arxiv.org/html/2607.12345v1/figure/eer.png';
        const raw = Buffer.from('verified-result-figure');
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = current;
            const sha256 = writeImageCache(current, url, raw);
            const input = paper('2607.12345', {
                selectedImageUrls: [url],
                imageManifest: {
                    selected: [url],
                    candidates: [{ url, caption: 'Figure 3: Per-method EER on Original Samples' }],
                    downloaded: [{ url, mime: 'image/png', sha256 }]
                }
            });
            assert.strictEqual(selectVisualReferenceImages(input)[0].role, 'result_reference');
        } finally {
            Config.CURRENT_DIR = originalCurrent;
        }
    });

    it('把校验通过的 .bin 缓存物化为内置生图可直接上传的规范扩展名', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-prepare-'));
        const current = path.join(dir, 'current');
        const output = path.join(current, 'visual-reference-inputs');
        const url = 'https://arxiv.org/html/2607.12345v1/figure/method.png';
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        try {
            patchVisualDirs(current);
            const sha256 = writeImageCache(current, url, PNG);
            const input = paper('2607.12345', {
                selectedImageUrls: [url],
                imageManifest: {
                    selected: [url],
                    candidates: [{ url, caption: 'Figure 1: Method architecture overview.' }],
                    downloaded: [{ url, mime: 'image/png', sha256 }]
                }
            });
            const promptPath = path.join(dir, 'prompt.md');
            const manifestPath = path.join(dir, 'manifest.json');
            fs.writeFileSync(promptPath, 'fresh visual prompt');
            const manifest = planVisualSummaries({
                targetDate: '2026-07-13', papers: [input], manifestPath, promptPath
            });
            const prepared = prepareVisualReferenceInputs(manifest, {
                targetDate: '2026-07-13', outputRoot: output
            });
            const expected = path.join(output, '2026-07-13', '01-2607.12345', '01-method_reference.png');
            assert.strictEqual(prepared.length, 1);
            assert.deepStrictEqual(prepared[0].referencedImagePaths, [path.resolve(expected)]);
            assert.strictEqual(
                prepared[0].referenceImages[0].relativePath,
                path.relative(Config.PROJECT_ROOT, expected).split(path.sep).join('/')
            );
            assert.deepStrictEqual(fs.readFileSync(expected), PNG);
            assert.strictEqual(validateReferenceImageBytes(PNG, 'image/png'), '.png');
            assert.throws(() => validateReferenceImageBytes(Buffer.from('not-png'), 'image/png'), /文件头/);

            fs.writeFileSync(expected, Buffer.from('stale'));
            prepareVisualReferenceInputs(manifest, { targetDate: '2026-07-13', outputRoot: output });
            assert.deepStrictEqual(fs.readFileSync(expected), PNG);
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('核心规划 API 也拒绝绕过远端发布绑定', () => {
        assert.throws(() => planVisualSummariesImpl({
            targetDate: '2026-07-13', papers: [paper()],
            manifestPath: path.join(os.tmpdir(), `unpublished-${Date.now()}.json`)
        }), /远端已验证/);
    });

    it('只有远端 OID 已验证的博客发布凭证才能启动视觉阶段', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-published-'));
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            const receipt = writePublishedReceipt(dir, '2026-07-13', [paper()], { remoteVerifiedOid: null });
            assert.throws(() => assertPublishedBlogReceipt('2026-07-13', receipt), /远端 OID/);
            writePublishedReceipt(dir, '2026-07-13', [paper()]);
            assert.strictEqual(assertPublishedBlogReceipt('2026-07-13', receipt).publicationCommit, 'a'.repeat(40));
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('默认 manifest 按日期隔离，历史 plan 不会覆盖其他批次', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-dates-'));
        const originalCurrentDir = Config.CURRENT_DIR;
        const originalManifestDir = Config.FILES.visualSummaryManifestDir;
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        try {
            patchVisualDirs(dir);
            planVisualSummaries({ targetDate: '2026-07-13', papers: [paper()] });
            planVisualSummaries({
                targetDate: '2026-07-14',
                papers: [paper('2607.54321', { fetchedAt: '2026-07-14T10:00:00.000+08:00' })]
            });
            const first = path.join(dir, 'visual-summary-manifests', '2026-07-13.json');
            const second = path.join(dir, 'visual-summary-manifests', '2026-07-14.json');
            assert.ok(fs.existsSync(first));
            assert.ok(fs.existsSync(second));
            assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(first)).papers), ['2607.12345']);
            assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(second)).papers), ['2607.54321']);
        } finally {
            Config.CURRENT_DIR = originalCurrentDir;
            Config.FILES.visualSummaryManifestDir = originalManifestDir;
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('从内置绘图 output_hint 只取 as 后的实际 PNG，不把目录与文件拼在一起', () => {
        const hint = 'Generated images are saved to /Users/test/.codex/generated_images/run as /Users/test/.codex/generated_images/run/card.png by default.';
        assert.strictEqual(
            extractGeneratedImagePathFromHint(hint),
            '/Users/test/.codex/generated_images/run/card.png'
        );
    });

    it('建立 TOP 10 单张长图计划，只保留与当前分析和 prompt 一致的已完成项', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-plan-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        fs.writeFileSync(promptPath, 'prompt-v1');

        const first = planVisualSummaries({
            targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
        });
        assert.deepStrictEqual(Object.keys(first.papers['2607.12345'].cards), CARD_KINDS);
        assert.strictEqual(pendingVisualSummaryCards(first).length, 1);
        assert.strictEqual(first.overallStatus, 'pending');
        assert.deepStrictEqual(first.counts, {
            eligiblePapers: 1,
            skippedPapers: 0,
            totalCards: 1,
            completeCards: 0,
            pendingCards: 1,
            failedCards: 0
        });
        assert.ok(first.papers['2607.12345'].cards.infographic.taskToken);
        assert.strictEqual(
            pendingVisualSummaryCards(first)[0].generationContext.title,
            'Visual summary paper'
        );

        first.papers['2607.12345'].cards.infographic = {
            status: 'complete',
            analysisSha256: first.papers['2607.12345'].analysisSha256,
            promptSha256: first.promptSha256,
            assetPath: 'missing.png',
            assetSha256: '0'.repeat(64)
        };
        fs.writeFileSync(manifestPath, JSON.stringify(first));
        const replanned = planVisualSummaries({
            targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
        });
        assert.strictEqual(replanned.papers['2607.12345'].cards.infographic.status, 'pending');

        fs.writeFileSync(promptPath, 'prompt-v2');
        const promptChanged = planVisualSummaries({
            targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
        });
        assert.strictEqual(pendingVisualSummaryCards(promptChanged).length, 1);
    });

    it('只选择最终评分前十，同分时按规范化 arXiv ID 稳定排序', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-top10-'));
        const papers = Array.from({ length: 12 }, (_, index) => paper(
            `2607.${String(index + 1).padStart(5, '0')}`,
            { parsed: { score: index < 2 ? 9 : 8 - index / 10, primaryTaskTag: '#语音识别' } }
        ));
        const manifest = planVisualSummaries({
            targetDate: '2026-07-13', papers,
            manifestPath: path.join(dir, 'manifest.json'),
            promptPath: path.join(__dirname, '..', 'prompts', 'visual-summary.md')
        });
        assert.strictEqual(Object.keys(manifest.papers).length, 10);
        assert.deepStrictEqual(
            Object.values(manifest.papers).slice(0, 2).map(item => item.normalizedArxivId),
            ['2607.00001', '2607.00002']
        );
        assert.deepStrictEqual(Object.values(manifest.papers).map(item => item.rank), [1,2,3,4,5,6,7,8,9,10]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('拒绝重复的规范化论文 ID，避免静默覆盖任务', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-duplicate-'));
        assert.throws(() => planVisualSummaries({
            targetDate: '2026-07-13',
            papers: [paper('2607.1v1'), paper('2607.1v2')],
            manifestPath: path.join(dir, 'manifest.json'),
            promptPath: path.join(__dirname, '..', 'prompts', 'visual-summary.md')
        }), /重复/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('验证 PNG 文件头、原子登记资产，且下次计划只保留有效完成项', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-record-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        const sourcePath = path.join(dir, 'generated.png');
        fs.writeFileSync(promptPath, 'prompt');
        fs.writeFileSync(sourcePath, PNG);

        const originalCurrentDir = Config.CURRENT_DIR;
        const originalManifestDir = Config.FILES.visualSummaryManifestDir;
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        try {
            patchVisualDirs(path.join(dir, 'current'));
            planVisualSummaries({
                targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
            });
            const planned = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const taskToken = planned.papers['2607.12345'].cards.infographic.taskToken;
            const recorded = recordVisualSummaryCard({
                arxivId: '2607.12345v2', kind: 'infographic', sourcePath, taskToken, manifestPath
            });
            const card = recorded.papers['2607.12345'].cards.infographic;
            assert.strictEqual(card.status, 'complete');
            assert.ok(fs.existsSync(path.resolve(Config.PROJECT_ROOT, card.assetPath)));
            assert.match(card.assetPath, /archive\/2026-07-13\/visual-summaries\/01-2607\.12345-visual-summary-paper\.png$/);
            assert.strictEqual(pendingVisualSummaryCards(recorded).length, 0);

            // 兼容旧版 current 资产：plan 校验 PNG/SHA 后迁移回带排名编号的日期归档。
            const archivedPath = path.resolve(Config.PROJECT_ROOT, card.assetPath);
            const legacyPath = path.join(
                Config.CURRENT_DIR, 'visual-summaries', '2026-07-13', '2607.12345', 'infographic.png'
            );
            fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
            fs.renameSync(archivedPath, legacyPath);
            recorded.papers['2607.12345'].cards.infographic.assetPath = path
                .relative(Config.PROJECT_ROOT, legacyPath).split(path.sep).join('/');
            fs.writeFileSync(manifestPath, JSON.stringify(recorded));

            const replanned = planVisualSummaries({
                targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
            });
            assert.strictEqual(replanned.papers['2607.12345'].cards.infographic.status, 'complete');
            assert.ok(fs.existsSync(archivedPath));
            assert.ok(!fs.existsSync(legacyPath));
            assert.ok(replanned.papers['2607.12345'].cards.infographic.archivedAt);
        } finally {
            Config.CURRENT_DIR = originalCurrentDir;
            Config.FILES.visualSummaryManifestDir = originalManifestDir;
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('record 后清理同一归档目录中由调用方留下的非 canonical 临时副本', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-cleanup-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        fs.writeFileSync(promptPath, 'prompt');
        const originalCurrentDir = Config.CURRENT_DIR;
        const originalManifestDir = Config.FILES.visualSummaryManifestDir;
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        try {
            patchVisualDirs(path.join(dir, 'current'));
            const planned = planVisualSummaries({
                targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
            });
            const root = path.join(Config.FILES.visualSummaryAssetDir, '2026-07-13', 'visual-summaries');
            const sourcePath = path.join(root, '01-2607.12345-visual-summary-paper-extra.png');
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(sourcePath, PNG);
            recordVisualSummaryCard({
                arxivId: '2607.12345', kind: 'infographic', sourcePath,
                taskToken: planned.papers['2607.12345'].cards.infographic.taskToken, manifestPath
            });
            assert.ok(!fs.existsSync(sourcePath));
        } finally {
            Config.CURRENT_DIR = originalCurrentDir;
            Config.FILES.visualSummaryManifestDir = originalManifestDir;
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('重排或标题变化时删除旧 canonical 成品，并拒绝归档中的重复排行榜图', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-replan-cleanup-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        const sourcePath = path.join(dir, 'generated.png');
        fs.writeFileSync(promptPath, 'prompt');
        fs.writeFileSync(sourcePath, PNG);
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        try {
            patchVisualDirs(path.join(dir, 'current'));
            const planned = planVisualSummaries({
                targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
            });
            const recorded = recordVisualSummaryCard({
                arxivId: '2607.12345',
                kind: 'infographic',
                sourcePath,
                taskToken: planned.papers['2607.12345'].cards.infographic.taskToken,
                manifestPath
            });
            const oldPath = path.resolve(
                Config.PROJECT_ROOT,
                recorded.papers['2607.12345'].cards.infographic.assetPath
            );
            assert.ok(fs.existsSync(oldPath));

            const replanned = planVisualSummaries({
                targetDate: '2026-07-13',
                papers: [paper('2607.12345', { title: 'Renamed visual summary paper' })],
                manifestPath,
                promptPath
            });
            assert.strictEqual(replanned.papers['2607.12345'].cards.infographic.status, 'pending');
            assert.ok(!fs.existsSync(oldPath));

            const root = path.dirname(oldPath);
            fs.writeFileSync(path.join(root, '00-digest-cover-2026-07-13.png'), PNG);
            fs.writeFileSync(path.join(root, 'unranked-2607.99999-infographic.png'), PNG);
            assert.throws(
                () => assertVisualArchiveUniqueness(replanned),
                /未登记或重复/
            );
            fs.unlinkSync(path.join(root, 'unranked-2607.99999-infographic.png'));
            fs.writeFileSync(path.join(root, '02-2607.12345-duplicate.png'), PNG);
            assert.throws(
                () => assertVisualArchiveUniqueness(replanned),
                /未登记或重复/
            );
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('旧 canonical 清理先保存可续跑清单，并拒绝通过父目录符号链接删除', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-safe-cleanup-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        const sourcePath = path.join(dir, 'generated.png');
        fs.writeFileSync(promptPath, 'prompt');
        fs.writeFileSync(sourcePath, PNG);
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        try {
            patchVisualDirs(path.join(dir, 'current'));
            const planned = planVisualSummaries({
                targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
            });
            const recorded = recordVisualSummaryCard({
                arxivId: '2607.12345',
                kind: 'infographic',
                sourcePath,
                taskToken: planned.papers['2607.12345'].cards.infographic.taskToken,
                manifestPath
            });
            const oldPath = path.resolve(
                Config.PROJECT_ROOT,
                recorded.papers['2607.12345'].cards.infographic.assetPath
            );
            const archiveRoot = path.dirname(oldPath);
            const realRoot = `${archiveRoot}-real`;
            fs.renameSync(archiveRoot, realRoot);
            fs.symlinkSync(realRoot, archiveRoot, 'dir');

            assert.throws(
                () => planVisualSummaries({
                    targetDate: '2026-07-13',
                    papers: [paper('2607.12345', { title: 'Renamed after symlink' })],
                    manifestPath,
                    promptPath
                }),
                /符号链接/
            );
            const interrupted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.strictEqual(interrupted.papers['2607.12345'].cards.infographic.status, 'pending');
            assert.strictEqual(interrupted.obsoleteVisualAssets.length, 1);
            assert.ok(fs.existsSync(path.join(realRoot, path.basename(oldPath))));

            fs.unlinkSync(archiveRoot);
            fs.renameSync(realRoot, archiveRoot);
            const resumed = planVisualSummaries({
                targetDate: '2026-07-13',
                papers: [paper('2607.12345', { title: 'Renamed after symlink' })],
                manifestPath,
                promptPath
            });
            assert.ok(!Object.prototype.hasOwnProperty.call(resumed, 'obsoleteVisualAssets'));
            assert.ok(!fs.existsSync(oldPath));
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史归档命令按已发布排行榜编号并更新旧 manifest 资产路径', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-legacy-archive-'));
        const current = path.join(dir, 'current');
        const archive = path.join(dir, 'archive');
        const manifestPath = path.join(current, 'visual-summary-manifests', '2026-07-13.json');
        const generationPath = path.join(current, 'blog-generation-manifest-2026-07-13.json');
        const source = path.join(current, 'visual-summaries', '2026-07-13', '2607.12345', 'infographic.png');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(source, PNG);
        fs.writeFileSync(generationPath, JSON.stringify({
            date: '2026-07-13', publishedPapers: [paper()]
        }));
        fs.writeFileSync(manifestPath, JSON.stringify({
            version: 2, batchDate: '2026-07-13', papers: {
                '2607.12345': {
                    cards: { infographic: {
                        status: 'complete', assetPath: path.relative(Config.PROJECT_ROOT, source),
                        assetSha256: crypto.createHash('sha256').update(PNG).digest('hex')
                    } }
                }
            }
        }));
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        try {
            Config.CURRENT_DIR = current;
            Config.FILES.visualSummaryManifestDir = path.join(current, 'visual-summary-manifests');
            Config.FILES.visualSummaryAssetDir = archive;
            const result = archiveLegacyVisualManifestAssets({
                targetDate: '2026-07-13', manifestPath, generationManifestPath: generationPath
            });
            const card = result.manifest.papers['2607.12345'].cards.infographic;
            assert.match(card.assetPath, /archive\/2026-07-13\/visual-summaries\/01-2607\.12345-visual-summary-paper\.png$/);
            assert.ok(fs.existsSync(path.resolve(Config.PROJECT_ROOT, card.assetPath)));
            assert.ok(!fs.existsSync(source));
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('失败项保留诊断但仍会出现在待重跑列表', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-fail-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        fs.writeFileSync(promptPath, 'prompt');
        const planned = planVisualSummaries({ targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath });
        const taskToken = planned.papers['2607.12345'].cards.infographic.taskToken;
        const failed = markVisualSummaryCardFailed({
            arxivId: '2607.12345', kind: 'infographic', error: 'image generation failed', taskToken, manifestPath
        });
        assert.strictEqual(failed.papers['2607.12345'].cards.infographic.status, 'failed');
        assert.strictEqual(failed.overallStatus, 'partial_failed');
        assert.strictEqual(failed.counts.failedCards, 1);
        assert.ok(pendingVisualSummaryCards(failed).some(item => item.kind === 'infographic'));
    });

    it('拒绝伪装成 png 扩展名的非图片文件', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-invalid-'));
        const source = path.join(dir, 'fake.png');
        fs.writeFileSync(source, 'not a png');
        assert.throws(() => validatePngAsset(source), /真实 PNG/);
    });

    it('拒绝横图和尺寸过小的图，只接受纵向长图', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-aspect-'));
        try {
            const landscape = path.join(dir, 'landscape.png');
            const tiny = path.join(dir, 'tiny.png');
            const portrait = path.join(dir, 'portrait.png');
            fs.writeFileSync(landscape, makePng(1200, 768));
            fs.writeFileSync(tiny, makePng(320, 640));
            fs.writeFileSync(portrait, PNG);
            assert.throws(() => validatePngAsset(landscape), /纵向长图/);
            assert.throws(() => validatePngAsset(tiny), /纵向长图/);
            assert.doesNotThrow(() => validatePngAsset(portrait));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('将 v1 三卡 manifest 原子迁移为 v3 TOP 10 单长图待生成任务', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-v1-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        fs.writeFileSync(promptPath, 'prompt');
        fs.writeFileSync(manifestPath, JSON.stringify({
            version: 1,
            batchDate: '2026-07-13',
            papers: { '2607.12345': { cards: { overview: {}, method: {}, experiments: {} } } }
        }));
        try {
            const migrated = planVisualSummaries({
                targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath
            });
            assert.strictEqual(migrated.version, 3);
            assert.deepStrictEqual(Object.keys(migrated.papers['2607.12345'].cards), ['infographic']);
            assert.strictEqual(migrated.counts.totalCards, 1);
            assert.strictEqual(migrated.papers['2607.12345'].cards.infographic.status, 'pending');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('同批存在失败论文时拒绝建立发布后视觉任务', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-invalid-analysis-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        fs.writeFileSync(promptPath, 'prompt');
        assert.throws(() => planVisualSummaries({
            targetDate: '2026-07-13',
            papers: [
                paper('2607.0'),
                { arxivId: '2607.1', fetchedAt: '2026-07-13T01:00:00+08:00', analysis: 'bad' },
                paper('2607.2', { latestAnalysisAttemptError: 'timeout' })
            ],
            manifestPath,
            promptPath
        }), /尚有未完成/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('task token 变化后拒绝旧 record/fail，且完成项不会被旧失败覆盖', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-cas-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        const sourcePath = path.join(dir, 'generated.png');
        fs.writeFileSync(promptPath, 'prompt-v1');
        fs.writeFileSync(sourcePath, PNG);

        const originalCurrentDir = Config.CURRENT_DIR;
        const originalManifestDir = Config.FILES.visualSummaryManifestDir;
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        try {
            patchVisualDirs(path.join(dir, 'current'));
            const first = planVisualSummaries({ targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath });
            const oldToken = first.papers['2607.12345'].cards.infographic.taskToken;
            fs.writeFileSync(promptPath, 'prompt-v2');
            const second = planVisualSummaries({ targetDate: '2026-07-13', papers: [paper()], manifestPath, promptPath });
            const newToken = second.papers['2607.12345'].cards.infographic.taskToken;
            assert.notStrictEqual(oldToken, newToken);
            assert.throws(() => recordVisualSummaryCard({
                arxivId: '2607.12345', kind: 'infographic', sourcePath, taskToken: oldToken, manifestPath
            }), /任务令牌已失效/);
            assert.throws(() => markVisualSummaryCardFailed({
                arxivId: '2607.12345', kind: 'infographic', error: 'stale', taskToken: oldToken, manifestPath
            }), /任务令牌已失效/);

            const complete = recordVisualSummaryCard({
                arxivId: '2607.12345', kind: 'infographic', sourcePath, taskToken: newToken, manifestPath
            });
            assert.strictEqual(complete.papers['2607.12345'].cards.infographic.status, 'complete');
            assert.throws(() => markVisualSummaryCardFailed({
                arxivId: '2607.12345', kind: 'infographic', error: 'late failure', taskToken: newToken, manifestPath
            }), /拒绝旧失败回写/);
        } finally {
            Config.CURRENT_DIR = originalCurrentDir;
            Config.FILES.visualSummaryManifestDir = originalManifestDir;
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('status 只读检查已发布权威快照，不受当前分析文件变化影响', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-status-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const analysisPath = path.join(dir, 'deep.json');
        const promptPath = path.join(dir, 'prompt.md');
        fs.writeFileSync(promptPath, 'prompt');

        const originalManifest = Config.FILES.visualSummaryManifest;
        const originalAnalysis = Config.FILES.deepAnalysisResult;
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            Config.FILES.visualSummaryManifest = manifestPath;
            Config.FILES.deepAnalysisResult = analysisPath;
            const published = paper();
            fs.writeFileSync(analysisPath, JSON.stringify({ papers: [published] }));
            const receiptPath = writePublishedReceipt(dir, '2026-07-13', [published]);
            const publication = assertPublishedBlogReceipt('2026-07-13', receiptPath);
            const first = planVisualSummaries({
                targetDate: '2026-07-13', papers: publication.publishedPapers, manifestPath,
                promptPath: path.join(Config.PROJECT_ROOT, 'prompts', 'visual-summary.md'),
                publication
            });
            const staleToken = first.papers['2607.12345'].cards.infographic.taskToken;
            const changedPrompt = path.join(dir, 'changed-prompt.md');
            fs.writeFileSync(changedPrompt, 'changed');
            assert.throws(
                () => assertVisualManifestCurrent(first, publication, '2026-07-13', changedPrompt),
                /prompt 已失效/
            );
            const changed = paper('2607.12345', {
                title: 'Changed analysis input',
                analysis: `${paper().analysis}\n`
            });
            fs.writeFileSync(analysisPath, JSON.stringify({ papers: [changed] }));
            const previousExitCode = process.exitCode;
            process.exitCode = 0;
            main(['status', '--date', '2026-07-13', '--manifest', manifestPath, '--receipt', receiptPath]);
            const reconciled = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.strictEqual(reconciled.papers['2607.12345'].cards.infographic.taskToken, staleToken);
            assert.strictEqual(reconciled.overallStatus, 'pending');
            assert.strictEqual(process.exitCode, 1);
            process.exitCode = previousExitCode;
        } finally {
            Config.FILES.visualSummaryManifest = originalManifest;
            Config.FILES.deepAnalysisResult = originalAnalysis;
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

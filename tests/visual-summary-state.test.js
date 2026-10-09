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
    productionV6GenerationFields, productionV6ReceiptFields,
    llmApiProductionGenerationFields, llmApiProductionReceiptFields
} = require('./production-v6-publication-fixture.js');
const {
    CARD_KINDS,
    planVisualSummaries: planVisualSummariesImpl,
    recordVisualSummaryCard: recordVisualSummaryCardImpl,
    markVisualSummaryCardFailed,
    pendingVisualSummaryCards,
    compactPendingVisualTask,
    compactPreparedVisualTask,
    validatePngAsset,
    validateCompletedCard,
    extractGeneratedImagePathFromHint,
    archiveLegacyVisualManifestAssets,
    assertPublishedBlogReceipt,
    assertVisualManifestCurrent,
    selectVisualReferenceImages,
    buildGenerationContext,
    analysisSha256,
    publishedPapersFingerprint,
    validateReferenceImageBytes,
    prepareVisualReferenceInputs,
    assertVisualArchiveUniqueness,
    parseArgs,
    promptSha256,
    visualSummaryPromptPath,
    main
} = require('../scripts/visual-summary-state.js');

const recordVisualSummaryCard = options => recordVisualSummaryCardImpl({
    ...options,
    qaAttested: options.qaAttested ?? true
});

const TEST_PUBLICATION = Object.freeze({
    publicationCommit: 'd'.repeat(40),
    generationManifestSha256: 'e'.repeat(64)
});

describe('视觉任务的简短输出', () => {
    it('待生成任务的终端输出省略完整生图上下文', () => {
        const item = {
            arxivId: '2607.12345',
            kind: 'infographic',
            label: '论文长图',
            title: 'Paper title',
            taskToken: 'token',
            generationContext: {
                qaClaims: { huge: 'payload' },
                referenceImages: [{ caption: 'figure' }]
            }
        };
        const compact = compactPendingVisualTask(item, {
            batchDate: '2026-07-13',
            papers: { '2607.12345': { rank: 2 } }
        }, '/tmp/visual-manifest.json');
        assert.strictEqual(compact.rank, 2);
        assert.strictEqual(compact.referenceImageCount, 1);
        assert.strictEqual(compact.manifestPath, '/tmp/visual-manifest.json');
        assert.strictEqual(Object.hasOwn(compact, 'generationContext'), false);
    });

    it('准备参考图时，简短输出仍保留内置生图工具所需的绝对路径', () => {
        const compact = compactPreparedVisualTask({
            rank: 1,
            arxivId: '2607.12345',
            title: 'Paper title',
            taskToken: 'token',
            referencedImagePaths: ['/tmp/reference.png'],
            referenceImages: [{ caption: 'large metadata' }]
        }, '/tmp/visual-manifest.json');
        assert.deepStrictEqual(compact.referencedImagePaths, ['/tmp/reference.png']);
        assert.strictEqual(Object.hasOwn(compact, 'referenceImages'), false);
    });
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
    ihdr.set([8, 0, 0, 0, 0], 8); // 8 位灰度
    const scanlines = Buffer.alloc((width + 1) * height);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(scanlines)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

const PNG = makePng();

describe('当前读者文章的视觉任务来源检查', () => {
    function withReader(callback, options = {}) {
        const old = Config.CURRENT_DIR;
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visual-reader-source-')));
        Config.CURRENT_DIR = dir;
        try {
            const { fixture, sign } = require('./reader-signed-draft-fixture.js');
            const { paper: reader } = fixture(options);
            reader.title = 'Exact English Paper Title';
            reader.parsed = { score: 8.1, documentType: 'empirical', primaryTaskTag: '#语音增强',
                primaryMethodTag: '#测试时适应', summary: 'POISON_CANONICAL_SUMMARY',
                architecture: 'POISON_CANONICAL_METHOD', results: 'POISON_CANONICAL_RESULTS',
                limitations: 'POISON_CANONICAL_LIMITS', roast: 'POISON_CANONICAL_ROAST' };
            reader.analysis = 'POISON_CANONICAL_ANALYSIS';
            for (const figure of reader.apiReaderFigures) {
                const sha = crypto.createHash('sha256').update(PNG).digest('hex');
                const filename = `figure-${figure.ordinal}-${sha.slice(0, 16)}.png`;
                Object.assign(figure, { assetSha256: sha, assetBytes: PNG.length, assetFilename: filename,
                    cachePath: path.join(dir, 'api-reader-assets', reader.arxivId, filename) });
                fs.mkdirSync(path.dirname(figure.cachePath), { recursive: true });
                fs.writeFileSync(figure.cachePath, PNG);
            }
            const { stableHash } = require('../scripts/lib/fresh-rewrite-run.js');
            const stage = reader.analysisManifest.stages.apiReaderArticle;
            stage.imageEvidenceCount = reader.apiReaderFigures.length;
            stage.imageEvidenceSha256 = stableHash(reader.apiReaderFigures.map(figure => ({
                ordinal: figure.ordinal, url: figure.url, sha256: figure.assetSha256 })));
            sign(reader);
            return callback(reader, sign, dir);
        } finally {
            Config.CURRENT_DIR = old;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('生图文案、主线、检查依据和原图只取自通过校验的读者文章，忽略正式分析中的干扰文案和旧选图', () => withReader(reader => {
        reader.selectedImageUrls = ['https://example.com/poison.png'];
        reader.imageManifest = { selected: reader.selectedImageUrls };
        const context = buildGenerationContext(reader);
        assert.equal(context.title, reader.title);
        assert.equal(context.summary, reader.apiReaderPlan.oneSentenceThesis);
        assert.equal(context.primaryTask, '#语音增强');
        assert.ok(!JSON.stringify(context).includes('POISON_CANONICAL'));
        assert.ok(context.method.includes('### ' + reader.apiReaderPlan.sections[3].heading));
        assert.ok(context.experiments.includes('| 比较条件 |'));
        assert.equal(context.qaClaims.metricClaims[0].sectionIndex, 6);
        assert.equal(context.sourceIdentity.articleSha256, reader.apiReaderArticleSha256);
        assert.equal(context.sourceIdentity.planSha256, reader.apiReaderPlanSha256);
        assert.equal(context.referenceImages[0].ordinal, 1);
        assert.equal(context.referenceImages[0].url, reader.apiReaderFigures[0].url);
        assert.equal(context.referenceImages[0].sha256, reader.apiReaderFigures[0].assetSha256);
        assert.equal(Object.hasOwn(context.referenceImages[0], 'pixelSeen'), false);
    }));

    it('修改正式分析文案不影响读者文章的来源标识，修订读者文章后必须改变该标识', () => withReader((reader, sign) => {
        const first = analysisSha256(reader);
        reader.parsed.summary = 'another unsupported summary';
        reader.analysis = 'another canonical body';
        assert.equal(analysisSha256(reader), first);
        reader.apiReaderPlan.oneSentenceThesis += ' 同一指标的外推仍须谨慎。';
        sign(reader);
        assert.notEqual(analysisSha256(reader), first);
    }));

    it('选择生图段落或检查依据的程序改变时，旧成图失效，即使读者文章和提示词未变', () => withReader((reader, _sign, dir) => {
        const Module = require('node:module');
        const filename = require.resolve('../scripts/visual-summary-state.js');
        const source = fs.readFileSync(filename, 'utf8');
        const baseline = require(filename);
        const oldSha = baseline.analysisSha256(reader), promptSha = 'p'.repeat(64);
        const oldToken = baseline.cardTaskToken(reader.arxivId, 'infographic', oldSha, promptSha, 1, TEST_PUBLICATION);
        const assetPath = path.join(dir, 'old-complete.png'); fs.writeFileSync(assetPath, PNG);
        const oldRoot = Config.FILES.visualSummaryAssetDir;
        Config.FILES.visualSummaryAssetDir = dir;
        try {
            const card = { status: 'complete', analysisSha256: oldSha, promptSha256: promptSha,
                taskToken: oldToken, assetPath,
                assetSha256: crypto.createHash('sha256').update(PNG).digest('hex'),
                qaAttestation: { attested: true, checklistVersion: 'visual-semantic-v1',
                    attestedAt: '2026-07-13T12:00:00.000+08:00' } };
            assert.equal(baseline.validateCompletedCard(card, oldSha, promptSha, oldToken, assetPath), true);
            for (const [before, after] of [
                ['method: blocks(methods)', 'method: blocks(methods.slice(0, -1))'],
                ['metricClaims: claims(results)', 'metricClaims: claims(results).slice(0, 1)']
            ]) {
                // 只在内存里编译一份独立的视觉任务程序版本，
                // 测试不修改项目源码，也不实际创建视觉任务计划。
                assert.ok(source.includes(before));
                const revised = new Module(filename, module);
                revised.filename = filename; revised.paths = module.paths;
                revised._compile(source.replace(before, after), filename);
                const updated = revised.exports;
                assert.deepEqual(updated.buildGenerationContext(reader).sourceIdentity,
                    baseline.buildGenerationContext(reader).sourceIdentity);
                const newSha = updated.analysisSha256(reader);
                assert.notEqual(newSha, oldSha);
                const newToken = updated.cardTaskToken(reader.arxivId, 'infographic', newSha, promptSha, 1, TEST_PUBLICATION);
                assert.notEqual(newToken, oldToken);
                assert.equal(updated.validateCompletedCard(card, newSha, promptSha, newToken, assetPath), false);
                assert.equal(updated.analysisSha256(paper()), baseline.analysisSha256(paper()));
            }
        } finally { Config.FILES.visualSummaryAssetDir = oldRoot; }
    }));

    it('读者文章、提纲、原图或像素证据校验不通过时，拒绝创建生图上下文，不改用旧文案', () => withReader(reader => {
        for (const mutate of [
            p => { p.apiReaderArticle += 'drift'; },
            p => { p.apiReaderPlan.oneSentenceThesis = 'drift'; },
            p => { p.apiReaderFigures[0].url = 'https://example.com/drift.png'; },
            p => { delete p.analysisManifest.stages.apiReaderArticle.imageEvidenceSha256; }
        ]) {
            const bad = structuredClone(reader); mutate(bad);
            assert.throws(() => buildGenerationContext(bad), /Reader|像素/);
        }
    }));

    it('即使重新计算校验信息，章节不符、私网或其他论文的图片地址以及任意缓存路径仍被拒绝', () => withReader((reader, sign) => {
        for (const mutate of [
            p => { p.apiReaderPlan.sections[0].heading += 'drift'; },
            p => { p.apiReaderFigures[0].url = 'https://127.0.0.1/a.png'; },
            p => { p.apiReaderFigures[0].url = 'https://arxiv.org/html/2609.99999v1/a.png'; },
            p => { p.apiReaderFigures[0].cachePath = '/private/tmp/arbitrary.png'; }
        ]) {
            const bad = structuredClone(reader); mutate(bad); sign(bad);
            assert.throws(() => buildGenerationContext(bad), /Reader/);
        }
    }));

    it('图片内容改变，或图片文件及父目录被换成符号链接时，拒绝读取', () => withReader((reader, _sign, dir) => {
        const file = reader.apiReaderFigures[0].cachePath;
        fs.writeFileSync(file, Buffer.alloc(PNG.length));
        assert.throws(() => selectVisualReferenceImages(reader), /SHA/);
        fs.unlinkSync(file);
        const other = path.join(dir, 'same.png'); fs.writeFileSync(other, PNG);
        fs.symlinkSync(other, file);
        assert.throws(() => selectVisualReferenceImages(reader), /ELOOP|symbolic/i);
        fs.unlinkSync(file); fs.writeFileSync(file, PNG);
        const folder = path.dirname(file), moved = folder + '-moved';
        fs.renameSync(folder, moved); fs.symlinkSync(moved, folder);
        assert.throws(() => selectVisualReferenceImages(reader), /父目录不安全/);
    }));

    it('读者文章没有原图记录时，不编造已读取图片的记录，也不改用旧选图', () => withReader(reader => {
        reader.selectedImageUrls = ['https://example.com/old.png'];
        const context = buildGenerationContext(reader);
        assert.deepEqual(context.referenceImages, []);
        assert.equal(context.sourceIdentity.imageEvidenceCount, 0);
    }, { noFigures: true }));

    it('日更读者文章只保留来源和像素 SHA-256 时，视觉任务不编造本地参考图', () => withReader((reader, sign) => {
        reader.analysisManifest.contracts.apiReaderFigurePersistence =
            'ephemeral-no-persisted-figure-assets-v1';
        for (const figure of reader.apiReaderFigures) {
            delete figure.assetBytes;
            delete figure.assetFilename;
            delete figure.assetMediaType;
            delete figure.assetWidth;
            delete figure.assetHeight;
            delete figure.cachePath;
        }
        sign(reader);
        assert.deepEqual(selectVisualReferenceImages(reader), []);
        const context = buildGenerationContext(reader);
        assert.deepEqual(context.referenceImages, []);
        assert.equal(context.sourceIdentity.imageEvidenceCount, reader.apiReaderFigures.length);
    }));

    it('离线准备参考图时，输出规定目录中的 PNG 绝对路径，并保留已校验的原图来源信息', () => withReader(reader => {
        const context = buildGenerationContext(reader);
        const manifest = { batchDate: '2026-07-13', papers: { [reader.arxivId]: {
            arxivId: reader.arxivId, rank: 1, title: reader.title,
            generationContext: context, cards: { infographic: { taskToken: 'offline-fixture' } }
        } } };
        const result = prepareVisualReferenceInputs(manifest, { targetDate: manifest.batchDate });
        const reference = result[0].referenceImages[0];
        assert.equal(reference.ordinal, reader.apiReaderFigures[0].ordinal);
        assert.equal(reference.url, reader.apiReaderFigures[0].url);
        assert.equal(reference.sourceDomSha256, reader.apiReaderFigures[0].sourceDomSha256);
        assert.ok(path.isAbsolute(result[0].referencedImagePaths[0]));
        assert.equal(path.extname(result[0].referencedImagePaths[0]), '.png');
        assert.deepEqual(fs.readFileSync(result[0].referencedImagePaths[0]), PNG);
        assert.equal(Object.hasOwn(reference, 'pixelSeen'), false);
    }));
});

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

function writePublishedReceipt(currentDir, targetDate, publishedPapers, overrides = {}, mode = 'manual') {
    fs.mkdirSync(currentDir, { recursive: true });
    const generationPath = path.join(currentDir, `blog-generation-manifest-${targetDate}.json`);
    const snapshotFingerprint = publishedPapersFingerprint(publishedPapers);
    const productionFields = mode === 'api'
        ? llmApiProductionGenerationFields(publishedPapers)
        : productionV6GenerationFields(publishedPapers);
    const generation = {
        schemaVersion: 3, date: targetDate, category: '论文速递',
        visualSummaryRequired: false, digestCoverRequired: false,
        inputFingerprint: 'c'.repeat(64), publishAll: false, publishedPapers,
        publishedPapersFingerprintContract: 'typed-json-f64-utf16-v1',
        publishedPapersFingerprint: snapshotFingerprint,
        ...productionFields
    };
    const raw = Buffer.from(JSON.stringify(generation));
    fs.writeFileSync(generationPath, raw);
    const receiptPath = path.join(currentDir, `blog-review-receipt-${targetDate}.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({
        schemaVersion: 3, date: targetDate, strictReview: true, hugoGate: 'hugo',
        reviewProtocolFingerprint: 'b'.repeat(64),
        generationManifestSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        generationInputIntegrity: 'typed-json-f64-utf16-v1',
        generationInputFingerprint: generation.inputFingerprint,
        publishedPapersFingerprint: snapshotFingerprint,
        publicationCommit: 'a'.repeat(40), remoteVerifiedOid: 'a'.repeat(40),
        remoteVerifiedAt: '2026-07-14T02:00:00+08:00',
        ...(mode === 'api'
            ? llmApiProductionReceiptFields(generation)
            : productionV6ReceiptFields(generation)),
        ...overrides
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

describe('视觉汇总状态', () => {
    it('计算已发布论文的校验信息时，包含表情符号等字符的对象键仍按 UTF-16 编码单元排序', () => {
        const probe = JSON.parse(fs.readFileSync(
            path.join(__dirname, 'fixtures', 'published-papers-fingerprint-probe.json'),
            'utf8'
        ));
        assert.strictEqual(
            publishedPapersFingerprint(probe),
            '3ee65da42ed04aa221d4429d960f7b60ed86fb5bee62f428ec67d2f8d2171882'
        );
    });

    it('已完成长图必须保留有效的内容检查声明，缺失或格式错误时重新等待生成', () => {
        const originals = {
            current: Config.CURRENT_DIR,
            manifests: Config.FILES.visualSummaryManifestDir,
            assets: Config.FILES.visualSummaryAssetDir
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-qa-state-'));
        try {
            patchVisualDirs(path.join(dir, 'current'));
            const asset = path.join(Config.FILES.visualSummaryAssetDir, '2026-07-13', 'visual-summaries', '01-paper.png');
            fs.mkdirSync(path.dirname(asset), { recursive: true });
            fs.writeFileSync(asset, PNG);
            const base = {
                status: 'complete', analysisSha256: 'a', promptSha256: 'b', taskToken: 'c',
                assetPath: path.relative(Config.PROJECT_ROOT, asset),
                assetSha256: crypto.createHash('sha256').update(PNG).digest('hex')
            };
            assert.strictEqual(validateCompletedCard(base, 'a', 'b', 'c', asset), false);
            assert.strictEqual(validateCompletedCard({
                ...base,
                qaAttestation: {
                    attested: true,
                    checklistVersion: 'visual-semantic-v1',
                    attestedAt: '2026-07-13T12:00:00.123+08:00'
                }
            }, 'a', 'b', 'c', asset), true);
            assert.strictEqual(validateCompletedCard({
                ...base,
                qaAttestation: {
                    attested: true,
                    checklistVersion: 'wrong-version',
                    attestedAt: '2026-07-13T12:00:00.123+08:00'
                }
            }, 'a', 'b', 'c', asset), false);
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifests;
            Config.FILES.visualSummaryAssetDir = originals.assets;
        }
    });
    it('直接调用长图登记函数也必须明确声明已检查图片内容', () => {
        assert.throws(
            () => recordVisualSummaryCardImpl({
                kind: 'infographic',
                manifestPath: path.join(os.tmpdir(), 'qa-required-visual.json')
            }),
            /qaAttested=true/
        );
    });
    it('视觉状态命令拒绝未知、缺值和重复参数', () => {
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

    it('发布快照的精确图片排除项会过滤视觉参考，同时保留同论文合法图片', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-publish-exclusion-'));
        const current = path.join(dir, 'current');
        const excludedUrl = 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg';
        const retainedUrl = 'https://arxiv.org/html/2608.13610v1/Fig/2_framework.jpg';
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        try {
            patchVisualDirs(current);
            const excludedSha = writeImageCache(current, excludedUrl, Buffer.from('bad-figure'));
            const retainedSha = writeImageCache(current, retainedUrl, Buffer.from('valid-framework'));
            const input = paper('2608.13610v1', {
                selectedImageUrls: [excludedUrl, retainedUrl],
                publishImageExclusions: [{
                    normalizedArxivId: '2608.13610',
                    url: excludedUrl,
                    reason: '图片内含 Manul debugging 拼写错误'
                }],
                imageManifest: {
                    selected: [excludedUrl, retainedUrl],
                    candidates: [
                        { url: excludedUrl, caption: 'Figure 1: Motivation.' },
                        { url: retainedUrl, caption: 'Figure 2: Framework architecture.' }
                    ],
                    downloaded: [
                        { url: excludedUrl, mime: 'image/png', sha256: excludedSha },
                        { url: retainedUrl, mime: 'image/png', sha256: retainedSha }
                    ]
                }
            });
            const references = selectVisualReferenceImages(input);
            assert.deepStrictEqual(references.map(item => item.url), [retainedUrl]);

            const promptPath = path.join(dir, 'prompt.md');
            const manifestPath = path.join(dir, 'manifest.json');
            fs.writeFileSync(promptPath, 'fresh visual prompt');
            const manifest = planVisualSummaries({
                targetDate: '2026-07-13', papers: [input], manifestPath, promptPath
            });
            assert.deepStrictEqual(
                manifest.papers['2608.13610'].generationContext.referenceImages.map(item => item.url),
                [retainedUrl]
            );

            assert.throws(() => selectVisualReferenceImages({
                ...input,
                publishImageExclusions: [{
                    normalizedArxivId: '2608.13610', url: excludedUrl, reason: '   '
                }]
            }), /reason 必须是非空字符串/);
            assert.throws(() => selectVisualReferenceImages({
                ...input,
                publishImageExclusions: [{
                    normalizedArxivId: '2608.13611', url: excludedUrl, reason: 'wrong paper'
                }]
            }), /当前论文的规范化 arXiv ID/);
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

    it('把校验通过的 .bin 缓存按规范扩展名写出，供内置生图直接上传', () => {
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
                targetDate: '2026-07-13', outputRoot: output, manifestPath
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
            const currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            prepareVisualReferenceInputs(currentManifest, {
                targetDate: '2026-07-13', outputRoot: output, manifestPath
            });
            assert.deepStrictEqual(fs.readFileSync(expected), PNG);

            const preparedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const preparedRecord = preparedManifest.papers['2607.12345'].preparedReferenceInputs;
            assert.strictEqual(preparedRecord.manifestGeneration, preparedManifest.generation);
            assert.strictEqual(
                preparedRecord.taskToken,
                preparedManifest.papers['2607.12345'].cards.infographic.taskToken
            );

            // 只增加清单更新次数而不改变该论文的任务，不应让已准备好的输入失效——
            // 只要它的任务令牌和图片哈希都还对得上。
            const unrelatedUpdate = structuredClone(preparedManifest);
            unrelatedUpdate.updatedAt = '2026-07-13T12:00:00+08:00';
            unrelatedUpdate.generation += 1;
            fs.writeFileSync(manifestPath, JSON.stringify(unrelatedUpdate, null, 2));
            const sourcePath = path.join(dir, 'generated.png');
            fs.writeFileSync(sourcePath, PNG);
            const externalReference = path.join(dir, 'external-reference.png');
            fs.writeFileSync(externalReference, PNG);
            fs.unlinkSync(expected);
            fs.symlinkSync(externalReference, expected);
            assert.throws(() => recordVisualSummaryCard({
                arxivId: '2607.12345',
                kind: 'infographic',
                sourcePath,
                taskToken: preparedRecord.taskToken,
                targetDate: '2026-07-13',
                manifestPath
            }), /符号链接/);
            fs.unlinkSync(expected);
            fs.writeFileSync(expected, PNG);
            const recorded = recordVisualSummaryCard({
                arxivId: '2607.12345',
                kind: 'infographic',
                sourcePath,
                taskToken: preparedRecord.taskToken,
                targetDate: '2026-07-13',
                manifestPath
            });
            assert.strictEqual(recorded.papers['2607.12345'].cards.infographic.status, 'complete');
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('准备参考图时，拒绝输出根目录和批次父目录中的符号链接', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-prepare-symlink-'));
        const current = path.join(dir, 'current');
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
            const output = path.join(current, 'visual-reference-inputs');
            const external = path.join(dir, 'external-output');
            fs.mkdirSync(external, { recursive: true });
            fs.symlinkSync(external, output, 'dir');
            assert.throws(() => prepareVisualReferenceInputs(manifest, {
                targetDate: '2026-07-13', outputRoot: output, manifestPath
            }), /根目录不得是符号链接/);
            fs.unlinkSync(output);
            fs.mkdirSync(output, { recursive: true });
            const externalDate = path.join(dir, 'external-date');
            fs.mkdirSync(externalDate, { recursive: true });
            fs.symlinkSync(externalDate, path.join(output, '2026-07-13'), 'dir');
            assert.throws(() => prepareVisualReferenceInputs(manifest, {
                targetDate: '2026-07-13', outputRoot: output, manifestPath
            }), /父目录不得是符号链接/);
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('直接调用视觉规划函数也必须提供已核验远端发布的记录', () => {
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

    it('符合 API 正式发布要求的凭证可以启动视觉任务，但篡改其中的模型记录会被拒绝', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-api-published-'));
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            const receipt = writePublishedReceipt(dir, '2026-07-13', [paper()], {}, 'api');
            const publication = assertPublishedBlogReceipt('2026-07-13', receipt);
            assert.strictEqual(publication.publicationMode, 'llm_api_production');
            assert.match(publication.llmApiProductionFingerprint, /^[a-f0-9]{64}$/);
            const generationPath = path.join(dir, 'blog-generation-manifest-2026-07-13.json');
            const generation = JSON.parse(fs.readFileSync(generationPath, 'utf8'));
            generation.llmApiBindings[0].model = 'tampered-model';
            fs.writeFileSync(generationPath, JSON.stringify(generation));
            assert.throws(
                () => assertPublishedBlogReceipt('2026-07-13', receipt),
                /generation manifest|provenance 指纹/
            );
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('发布凭证中的论文内容被篡改而输入校验信息未更新时，拒绝启动视觉任务', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-snapshot-tamper-'));
        const originalCurrent = Config.CURRENT_DIR;
        try {
            Config.CURRENT_DIR = dir;
            const receiptPath = writePublishedReceipt(dir, '2026-07-13', [paper()]);
            const generationPath = path.join(dir, 'blog-generation-manifest-2026-07-13.json');
            const generation = JSON.parse(fs.readFileSync(generationPath, 'utf8'));
            generation.publishedPapers[0].title = 'tampered after generation';
            const generationRaw = Buffer.from(JSON.stringify(generation));
            fs.writeFileSync(generationPath, generationRaw);
            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            receipt.generationManifestSha256 = crypto.createHash('sha256')
                .update(generationRaw).digest('hex');
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));
            assert.throws(
                () => assertPublishedBlogReceipt('2026-07-13', receiptPath),
                /可反向验证的已发布论文权威快照/
            );
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('视觉任务清单默认按日期分别保存，历史日期的计划不会覆盖其他批次', () => {
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

    it('为评分前十论文各规划一张长图，只复用与当前分析和提示词一致的有效成图', () => {
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

    it('登记长图时校验 PNG 文件头并完整保存图片，下次规划只复用有效成图', () => {
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

            // 兼容旧版 current 目录中的图片：规划时校验 PNG 和 SHA-256，再移入按日期和排名编号保存的归档。
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

    it('登记后清理同一归档目录中由调用方留下、未使用规定文件名的临时图片副本', () => {
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

    it('排名或标题变化时删除旧正式成图，并拒绝归档中未登记或重复的排行榜图片', () => {
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

    it('清理旧正式成图前先保存恢复所需清单，父目录为符号链接时拒绝删除', () => {
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

    it('历史归档命令按已发布排行榜为图片编号，并更新旧清单中的图片路径', () => {
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
            const realSource = `${source}.real`;
            fs.renameSync(source, realSource);
            fs.symlinkSync(realSource, source);
            assert.throws(() => main([
                'archive-legacy', '--date', '2026-07-13',
                '--manifest', manifestPath, '--generation', generationPath
            ]), /符号链接/);
            fs.unlinkSync(source);
            fs.renameSync(realSource, source);
            let output = '';
            const originalWrite = process.stdout.write;
            process.stdout.write = chunk => { output += String(chunk); return true; };
            try {
                main([
                    'archive-legacy', '--date', '2026-07-13',
                    '--manifest', manifestPath, '--generation', generationPath
                ]);
            } finally {
                process.stdout.write = originalWrite;
            }
            const migrated = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const card = migrated.papers['2607.12345'].cards.infographic;
            assert.match(output, /历史视觉资产已按日期归档/);
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

    it('将 v1 三张图的清单完整更新为 v3 评分前十论文各一张长图的待生成任务', () => {
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

    it('任务标识改变后拒绝旧任务的登记和失败记录，已完成结果不会被旧失败覆盖', () => {
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
            // 改用 writeFileAtomic 保存后行为不变：图片字节与源 PNG 一致，文件权限仍为
            // 强制 0600，且只在同目录改名，不留临时文件。
            const cardAssetPath = path.resolve(
                Config.PROJECT_ROOT, complete.papers['2607.12345'].cards.infographic.assetPath);
            assert.deepStrictEqual(fs.readFileSync(cardAssetPath), fs.readFileSync(sourcePath));
            if (process.platform !== 'win32') assert.strictEqual(fs.statSync(cardAssetPath).mode & 0o777, 0o600);
            assert.deepStrictEqual(
                fs.readdirSync(path.dirname(cardAssetPath)).filter(name => name.endsWith('.tmp')), []);
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

    it('状态命令只检查发布凭证中保存的论文内容，当前分析文件变化不影响已有任务', () => {
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

describe('视觉摘要提示词版本机制', () => {
    const V1 = 'analysis-prompt-text-v1';
    const V2 = 'analysis-prompt-text-v2';

    function withDirs(callback) {
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.visualSummaryManifestDir,
            asset: Config.FILES.visualSummaryAssetDir
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-prompt-version-'));
        try {
            patchVisualDirs(path.join(dir, 'current'));
            return callback(dir);
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.manifest;
            Config.FILES.visualSummaryAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('旧记录缺版本字段时按 v1 复算，新请求走 v2，未登记版本抛错', () => withDirs(dir => {
        const published = paper();
        const publication = { ...TEST_PUBLICATION, publishedPapers: [published] };
        const v1Path = path.join(Config.PROJECT_ROOT, 'prompts', 'visual-summary.md');
        const v2Path = path.join(Config.PROJECT_ROOT, 'prompts', 'visual-summary-v2.md');
        assert.strictEqual(visualSummaryPromptPath(V1), v1Path);
        assert.strictEqual(visualSummaryPromptPath(V2), v2Path);
        assert.notStrictEqual(promptSha256(v1Path), promptSha256(v2Path));

        // 旧代码写下的记录没有版本字段，令牌按 v1 字节算。
        const planned = planVisualSummaries({
            targetDate: '2026-07-13', papers: [published],
            manifestPath: path.join(dir, 'legacy.json'), promptPath: v1Path
        });
        const legacy = structuredClone(planned);
        delete legacy.promptTextContract;
        assert.doesNotThrow(() => assertVisualManifestCurrent(legacy, publication, '2026-07-13'));
        assert.strictEqual(
            legacy.papers['2607.12345'].cards.infographic.taskToken,
            planned.papers['2607.12345'].cards.infographic.taskToken
        );
        assert.strictEqual(legacy.promptSha256, promptSha256(v1Path));

        // 新请求不传 promptPath，解析到 v2 并把版本写进记录。
        const fresh = planVisualSummaries({
            targetDate: '2026-07-13', papers: [published],
            manifestPath: path.join(dir, 'fresh.json')
        });
        assert.strictEqual(fresh.promptTextContract, V2);
        assert.strictEqual(fresh.promptSha256, promptSha256(v2Path));
        assert.doesNotThrow(() => assertVisualManifestCurrent(fresh, publication, '2026-07-13'));

        const unknown = structuredClone(fresh);
        unknown.promptTextContract = 'analysis-prompt-text-v9';
        assert.throws(
            () => assertVisualManifestCurrent(unknown, publication, '2026-07-13'),
            /没有登记/
        );
    }));
});

describe('正式长图状态与受控旧路径迁移', () => {
    const { spawnSync } = require('node:child_process');
    const targetDate = '2026-07-13';
    const paperId = '2607.12345';

    function withCompletedVisual(callback) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-card-file-'));
        const originalCurrent = Config.CURRENT_DIR;
        const originalAssets = Config.FILES.visualSummaryAssetDir;
        try {
            Config.CURRENT_DIR = directory;
            Config.FILES.visualSummaryAssetDir = path.join(directory, 'archive');
            const published = paper();
            const receiptPath = writePublishedReceipt(directory, targetDate, [published]);
            const publication = assertPublishedBlogReceipt(targetDate, receiptPath);
            const manifestPath = path.join(directory, 'visual.json');
            const planned = planVisualSummariesImpl({
                targetDate,
                papers: publication.publishedPapers,
                manifestPath,
                publication
            });
            const source = path.join(directory, 'generated.png');
            fs.writeFileSync(source, PNG);
            const completed = recordVisualSummaryCardImpl({
                arxivId: paperId,
                kind: 'infographic',
                sourcePath: source,
                taskToken: planned.papers[paperId].cards.infographic.taskToken,
                targetDate,
                manifestPath,
                qaAttested: true
            });
            const asset = path.resolve(Config.PROJECT_ROOT, completed.papers[paperId].cards.infographic.assetPath);
            const run = command => spawnSync(process.execPath, ['-e', `
                const path = require('node:path');
                const Config = require('./scripts/config.js');
                Config.CURRENT_DIR = process.argv[1];
                Config.FILES.visualSummaryAssetDir = path.join(process.argv[1], 'archive');
                require('./scripts/visual-summary-state.js').main([
                    process.argv[2], '--date', process.argv[3],
                    '--manifest', process.argv[4], '--receipt', process.argv[5]
                ]);
            `, directory, command, targetDate, manifestPath, receiptPath], {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf8',
                timeout: 2500
            });
            callback({ directory, manifestPath, completed, source, asset, run });
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            Config.FILES.visualSummaryAssetDir = originalAssets;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }

    for (const replacement of ['symlink', 'fifo', 'damaged']) {
        it(`实际状态命令拒绝被换成 ${replacement} 的长图，不改动替换后的文件或清单`, () => {
            withCompletedVisual(({ manifestPath, source, asset, run }) => {
                const original = run('status');
                assert.ifError(original.error);
                assert.equal(original.status, 0, original.stderr);
                assert.match(original.stdout, /完成 1\/1 张/);
                const manifestBytes = fs.readFileSync(manifestPath);
                fs.unlinkSync(asset);
                if (replacement === 'symlink') fs.symlinkSync(source, asset);
                else if (replacement === 'fifo') assert.equal(spawnSync('mkfifo', [asset]).status, 0);
                else fs.writeFileSync(asset, 'damaged PNG');
                const inode = fs.lstatSync(asset).ino;
                const rejected = run('status');
                assert.ifError(rejected.error);
                assert.equal(rejected.status, 1, rejected.stderr);
                assert.match(rejected.stdout, /完成 0\/1 张/);
                assert.equal(fs.lstatSync(asset).ino, inode);
                assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
            });
        });
    }

    for (const replacement of ['symlink', 'fifo', 'damaged', 'valid']) {
        it(`实际规划命令检查旧路径长图（${replacement}），仅迁移合法文件并保留原内容检查和发布记录`, () => {
            withCompletedVisual(({ directory, manifestPath, completed, source, asset, run }) => {
                const legacy = path.join(directory, 'visual-summaries', targetDate, paperId, 'infographic.png');
                fs.mkdirSync(path.dirname(legacy), { recursive: true });
                fs.unlinkSync(asset);
                if (replacement === 'symlink') fs.symlinkSync(source, legacy);
                else if (replacement === 'fifo') assert.equal(spawnSync('mkfifo', [legacy]).status, 0);
                else fs.writeFileSync(legacy, replacement === 'valid' ? PNG : Buffer.from('damaged PNG'));
                completed.papers[paperId].cards.infographic.assetPath = path.relative(Config.PROJECT_ROOT, legacy);
                fs.writeFileSync(manifestPath, JSON.stringify(completed));
                const manifestBytes = fs.readFileSync(manifestPath);
                const inode = fs.lstatSync(legacy).ino;
                const result = run('plan');
                assert.ifError(result.error);
                if (replacement === 'valid') {
                    assert.equal(result.status, 0, result.stderr);
                    assert.equal(fs.existsSync(legacy), false);
                    assert.deepEqual(fs.readFileSync(asset), PNG);
                    const next = JSON.parse(fs.readFileSync(manifestPath));
                    assert.deepEqual(next.publication, completed.publication);
                    const oldCard = completed.papers[paperId].cards.infographic;
                    const card = next.papers[paperId].cards.infographic;
                    assert.equal(card.status, 'complete');
                    assert.equal(card.taskToken, oldCard.taskToken);
                    assert.deepEqual(card.qaAttestation, oldCard.qaAttestation);
                    assert.equal(run('status').status, 0);
                } else {
                    assert.equal(result.status, 1, result.stderr);
                    assert.equal(fs.lstatSync(legacy).ino, inode);
                    assert.equal(fs.existsSync(asset), false);
                    assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
                }
            });
        });
    }
});

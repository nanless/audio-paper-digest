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
    buildCoverContext,
    COVER_RANKING_LIMIT,
    planDigestCover: planDigestCoverImpl,
    recordDigestCover: recordDigestCoverImpl,
    markDigestCoverFailed,
    validateCompletedCover,
    archiveLegacyDigestCover,
    assertDigestCoverManifestCurrent,
    compactDigestCoverTask,
    digestCoverPromptPath,
    promptSha256,
    parseArgs,
    main
} = require('../scripts/digest-cover-state.js');

const recordDigestCover = options => recordDigestCoverImpl({
    ...options,
    qaAttested: options.qaAttested ?? true
});

const TEST_PUBLICATION = Object.freeze({
    publicationCommit: 'd'.repeat(40),
    generationManifestSha256: 'e'.repeat(64),
    category: '论文速递'
});

function planDigestCover(options) {
    return planDigestCoverImpl({ publication: TEST_PUBLICATION, ...options });
}

describe('digest cover 命令行', () => {
    it('紧凑任务只打印排行数量和 manifest 路径', () => {
        const compact = compactDigestCoverTask({
            batchDate: '2026-07-13',
            cover: { label: '汇总封面', taskToken: 'token' },
            generationContext: {
                title: '2026-07-13 论文速递',
                paperCount: 20,
                rankingCount: 10,
                ranking: [{ title: 'large payload' }]
            }
        }, '/tmp/cover-manifest.json');
        assert.strictEqual(compact.rankingCount, 10);
        assert.strictEqual(compact.manifestPath, '/tmp/cover-manifest.json');
        assert.strictEqual(Object.hasOwn(compact, 'generationContext'), false);
        assert.strictEqual(Object.hasOwn(compact, 'ranking'), false);
    });

    it('拒绝未知、缺值和重复参数', () => {
        assert.throws(() => parseArgs(['status', '--unknown', 'value']), /未知参数/);
        assert.throws(() => parseArgs(['status', '--date']), /无效参数/);
        assert.throws(
            () => parseArgs(['status', '--date', '2026-07-13', '--date', '2026-07-14']),
            /只能指定一次/
        );
    });
});

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

function chunk(kind, payload) {
    const type = Buffer.from(kind);
    const result = Buffer.alloc(12 + payload.length);
    result.writeUInt32BE(payload.length, 0);
    type.copy(result, 4);
    payload.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([type, payload])), 8 + payload.length);
    return result;
}

function portraitPng() {
    const width = 768;
    const height = 1200;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 0, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.alloc((width + 1) * height))),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

function paper(id, score, task, title) {
    return validAnalysisPaper(id, {
        title,
        fetchedAt: '2026-07-13T10:00:00.000+08:00',
        parsed: {
            ...validAnalysisPaper(id).parsed,
            score: String(score),
            primaryTaskTag: task,
            tags: [task, '#Transformer']
        }
    });
}

describe('digest cover 状态', () => {
    it('封面完成态必须保留合法排行榜 QA 声明', () => {
        const original = Config.FILES.digestCoverAssetDir;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-qa-state-'));
        try {
            Config.FILES.digestCoverAssetDir = path.join(dir, 'archive');
            const asset = path.join(Config.FILES.digestCoverAssetDir, '2026-07-13', 'visual-summaries', '00-digest-cover-2026-07-13.png');
            const raw = portraitPng();
            fs.mkdirSync(path.dirname(asset), { recursive: true });
            fs.writeFileSync(asset, raw);
            const base = {
                status: 'complete', batchDate: '2026-07-13', dataSha256: 'a',
                promptSha256: 'b', taskToken: 'c',
                assetPath: path.relative(Config.PROJECT_ROOT, asset),
                assetSha256: crypto.createHash('sha256').update(raw).digest('hex')
            };
            assert.strictEqual(validateCompletedCover(base, 'a', 'b', 'c'), false);
            assert.strictEqual(validateCompletedCover({
                ...base,
                qaAttestation: {
                    attested: true,
                    checklistVersion: 'digest-cover-semantic-v1',
                    attestedAt: '2026-07-13T12:00:00+08:00'
                }
            }, 'a', 'b', 'c'), true);
        } finally {
            Config.FILES.digestCoverAssetDir = original;
        }
    });
    it('record 核心 API 要求显式排行榜 QA 声明', () => {
        assert.throws(
            () => recordDigestCoverImpl({ manifestPath: path.join(os.tmpdir(), 'qa-required-cover.json') }),
            /qaAttested=true/
        );
    });
    it('核心规划 API 也拒绝绕过远端发布绑定', () => {
        assert.throws(() => planDigestCoverImpl({
            targetDate: '2026-07-13', papers: [paper('2607.1', 8, '#语音识别', 'Paper')],
            manifestPath: path.join(os.tmpdir(), `unpublished-cover-${Date.now()}.json`)
        }), /远端已验证/);
    });

    it('封面只读检查发现提示词变化时拒绝旧记录', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-cover-stale-prompt-'));
        const prompt = path.join(dir, 'prompt.md');
        const changedPrompt = path.join(dir, 'changed.md');
        fs.writeFileSync(prompt, 'v1');
        fs.writeFileSync(changedPrompt, 'v2');
        const papers = [paper('2607.1', 8, '#语音识别', 'Paper')];
        const publication = {
            publicationCommit: 'a'.repeat(40),
            generationManifestSha256: 'b'.repeat(64),
            category: '论文速递',
            publishedPapers: papers
        };
        const manifest = planDigestCover({
            targetDate: '2026-07-13', papers,
            manifestPath: path.join(dir, 'manifest.json'), promptPath: prompt, publication
        });
        assert.throws(
            () => assertDigestCoverManifestCurrent(manifest, publication, '2026-07-13', changedPrompt),
            /prompt 已失效/
        );
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('从汇总页同源字段生成热门方向和动态 TOP N 排行榜', () => {
        const papers = [
            paper('2607.1', 7.5, '#语音识别', 'First'),
            paper('2607.2', 9.1, '#音乐生成', 'Second'),
            paper('2607.3', 8.2, '#语音识别', 'Third')
        ];
        const context = buildCoverContext(papers, '2026-07-13');
        assert.strictEqual(context.paperCount, 3);
        assert.strictEqual(context.rankingCount, 3);
        assert.strictEqual(context.rankingLimit, 10);
        assert.deepStrictEqual(context.hotDirections[0], { tag: '#语音识别', count: 2 });
        assert.deepStrictEqual(context.ranking.map(item => item.title), ['Second', 'Third', 'First']);
        assert.deepStrictEqual(context.ranking.map(item => item.rank), [1, 2, 3]);
    });

    it('汇总排行榜与论文长图统一最多 TOP 10，不再静默截断为 TOP 5', () => {
        const papers = Array.from({ length: 12 }, (_, index) => paper(
            `2607.${String(index + 1).padStart(5, '0')}`,
            10 - index / 10,
            '#语音识别',
            `Paper ${index + 1}`
        ));
        const context = buildCoverContext(papers, '2026-07-13');
        assert.strictEqual(COVER_RANKING_LIMIT, 10);
        assert.strictEqual(context.rankingCount, 10);
        assert.strictEqual(context.ranking.length, 10);
        assert.deepStrictEqual(context.ranking.map(item => item.rank), [1,2,3,4,5,6,7,8,9,10]);
        assert.strictEqual(context.ranking[9].title, 'Paper 10');
    });

    it('汇总封面声明全图 image_gen 与最高可用纵向分辨率，不携带旧固定画布', () => {
        const context = buildCoverContext([paper('2607.1', 8, '#语音识别', 'Paper')], '2026-07-13');
        assert.deepStrictEqual(context.rendering, {
            mode: 'full_image_generation_v2',
            renderer: 'built-in image_gen',
            resolutionPolicy: 'highest_available_portrait',
            orientation: 'portrait',
            preferredAspectRatio: '1:2',
            minimumWidth: 768,
            minimumHeight: 1024,
            maxPngBytes: 8 * 1024 * 1024
        });
        assert.ok(!Object.hasOwn(context.rendering, 'width'));
        assert.ok(!Object.hasOwn(context.rendering, 'height'));
    });

    it('热门方向同票按标签稳定排序，会议 category 使用对应标题', () => {
        const papers = [
            paper('2607.2', 8, '#B方向', 'B'),
            paper('2607.1', 8, '#A方向', 'A')
        ];
        const normal = buildCoverContext(papers, '2026-07-13');
        const reversed = buildCoverContext([...papers].reverse(), '2026-07-13');
        assert.deepStrictEqual(normal.hotDirections, reversed.hotDirections);
        assert.deepStrictEqual(normal.hotDirections.map(item => item.tag), ['#A方向', '#B方向']);
        assert.strictEqual(
            buildCoverContext(papers, '2026-07-13', 'icml-2026').title,
            'ICML 2026 论文速递'
        );
    });

    it('拒绝重复的规范化论文 ID', () => {
        const papers = [
            paper('2607.1v1', 8, '#语音识别', 'A'),
            paper('2607.1v2', 7, '#音乐生成', 'B')
        ];
        assert.throws(() => planDigestCover({
            targetDate: '2026-07-13', papers,
            manifestPath: path.join(os.tmpdir(), `duplicate-cover-${process.pid}.json`)
        }), /重复/);
    });

    it('封面可断点登记，数据变化只使封面失效', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cover-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const promptPath = path.join(dir, 'prompt.md');
        const sourcePath = path.join(dir, 'cover.png');
        fs.writeFileSync(promptPath, 'cover prompt');
        fs.writeFileSync(sourcePath, portraitPng());
        const originalCurrent = Config.CURRENT_DIR;
        const originalManifestDir = Config.FILES.digestCoverManifestDir;
        const originalAssetDir = Config.FILES.digestCoverAssetDir;
        try {
            Config.CURRENT_DIR = path.join(dir, 'current');
            Config.FILES.digestCoverManifestDir = path.join(Config.CURRENT_DIR, 'digest-cover-manifests');
            Config.FILES.digestCoverAssetDir = path.join(dir, 'archive');
            const papers = [paper('2607.1', 8.0, '#语音识别', 'Paper')];
            const planned = planDigestCover({ targetDate: '2026-07-13', papers, manifestPath, promptPath });
            assert.strictEqual(planned.cover.status, 'pending');
            const completed = recordDigestCover({
                sourcePath, taskToken: planned.cover.taskToken, manifestPath
            });
            assert.strictEqual(completed.overallStatus, 'complete');
            assert.ok(fs.existsSync(path.resolve(Config.PROJECT_ROOT, completed.cover.assetPath)));
            assert.match(completed.cover.assetPath, /archive\/2026-07-13\/visual-summaries\/00-digest-cover-2026-07-13\.png$/);
            const archivedPath = path.resolve(Config.PROJECT_ROOT, completed.cover.assetPath);
            // 统一到 writeFileAtomic 后行为不变：保存的字节与源 PNG 一致、权限仍是
            // 强制 0600，且只在同目录改名，不留临时文件。
            assert.deepStrictEqual(fs.readFileSync(archivedPath), fs.readFileSync(sourcePath));
            if (process.platform !== 'win32') assert.strictEqual(fs.statSync(archivedPath).mode & 0o777, 0o600);
            assert.deepStrictEqual(
                fs.readdirSync(path.dirname(archivedPath)).filter(name => name.endsWith('.tmp')), []);
            const legacyPath = path.join(Config.CURRENT_DIR, 'digest-covers', '2026-07-13', 'cover.png');
            fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
            fs.renameSync(archivedPath, legacyPath);
            completed.cover.assetPath = path.relative(Config.PROJECT_ROOT, legacyPath).split(path.sep).join('/');
            fs.writeFileSync(manifestPath, JSON.stringify(completed));
            const reused = planDigestCover({ targetDate: '2026-07-13', papers, manifestPath, promptPath });
            assert.strictEqual(reused.cover.status, 'complete');
            assert.ok(fs.existsSync(archivedPath));
            assert.ok(!fs.existsSync(legacyPath));
            assert.ok(reused.cover.archivedAt);

            const changed = [paper('2607.1', 8.1, '#语音识别', 'Paper')];
            const replanned = planDigestCover({ targetDate: '2026-07-13', papers: changed, manifestPath, promptPath });
            assert.strictEqual(replanned.cover.status, 'pending');
            assert.notStrictEqual(replanned.cover.taskToken, planned.cover.taskToken);
            assert.throws(() => markDigestCoverFailed({
                error: 'stale', taskToken: planned.cover.taskToken, manifestPath
            }), /令牌已失效/);
        } finally {
            Config.CURRENT_DIR = originalCurrent;
            Config.FILES.digestCoverManifestDir = originalManifestDir;
            Config.FILES.digestCoverAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史封面归档命令校验 SHA 后迁移并更新 manifest', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cover-legacy-archive-'));
        const current = path.join(dir, 'current');
        const archive = path.join(dir, 'archive');
        const manifestPath = path.join(current, 'digest-cover-manifests', '2026-07-13.json');
        const source = path.join(current, 'digest-covers', '2026-07-13', 'cover.png');
        const png = portraitPng();
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(source, png);
        fs.writeFileSync(manifestPath, JSON.stringify({
            version: 1, batchDate: '2026-07-13', cover: {
                status: 'complete', assetPath: path.relative(Config.PROJECT_ROOT, source),
                assetSha256: crypto.createHash('sha256').update(png).digest('hex')
            }
        }));
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.digestCoverManifestDir,
            asset: Config.FILES.digestCoverAssetDir
        };
        try {
            Config.CURRENT_DIR = current;
            Config.FILES.digestCoverManifestDir = path.join(current, 'digest-cover-manifests');
            Config.FILES.digestCoverAssetDir = archive;
            const realSource = `${source}.real`;
            fs.renameSync(source, realSource);
            fs.symlinkSync(realSource, source);
            assert.throws(() => main([
                'archive-legacy', '--date', '2026-07-13', '--manifest', manifestPath
            ]), /符号链接/);
            fs.unlinkSync(source);
            fs.renameSync(realSource, source);
            let output = '';
            const originalWrite = process.stdout.write;
            process.stdout.write = chunk => { output += String(chunk); return true; };
            try {
                main(['archive-legacy', '--date', '2026-07-13', '--manifest', manifestPath]);
            } finally {
                process.stdout.write = originalWrite;
            }
            const result = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.match(output, /历史汇总封面已按日期归档/);
            assert.match(result.cover.assetPath, /archive\/2026-07-13\/visual-summaries\/00-digest-cover-2026-07-13\.png$/);
            assert.ok(fs.existsSync(path.resolve(Config.PROJECT_ROOT, result.cover.assetPath)));
            assert.ok(!fs.existsSync(source));
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.digestCoverManifestDir = originals.manifest;
            Config.FILES.digestCoverAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('汇总封面提示词版本机制', () => {
    const V1 = 'analysis-prompt-text-v1';
    const V2 = 'analysis-prompt-text-v2';

    function withDirs(callback) {
        const originals = {
            current: Config.CURRENT_DIR,
            manifest: Config.FILES.digestCoverManifestDir,
            asset: Config.FILES.digestCoverAssetDir
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-prompt-version-'));
        try {
            Config.CURRENT_DIR = path.join(dir, 'current');
            Config.FILES.digestCoverManifestDir = path.join(dir, 'current', 'digest-cover-manifests');
            Config.FILES.digestCoverAssetDir = path.join(dir, 'archive');
            return callback(dir);
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.digestCoverManifestDir = originals.manifest;
            Config.FILES.digestCoverAssetDir = originals.asset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('旧记录缺版本字段时按 v1 复算，新请求走 v2，未登记版本抛错', () => withDirs(dir => {
        const published = paper('2607.12345', 9, '#语音识别', 'Cover paper');
        const publication = { ...TEST_PUBLICATION, publishedPapers: [published] };
        const v1Path = path.join(Config.PROJECT_ROOT, 'prompts', 'digest-cover.md');
        const v2Path = path.join(Config.PROJECT_ROOT, 'prompts', 'digest-cover-v2.md');
        assert.strictEqual(digestCoverPromptPath(V1), v1Path);
        assert.strictEqual(digestCoverPromptPath(V2), v2Path);
        assert.notStrictEqual(promptSha256(v1Path), promptSha256(v2Path));

        const planned = planDigestCover({
            targetDate: '2026-07-13', papers: [published],
            manifestPath: path.join(dir, 'legacy.json'), promptPath: v1Path
        });
        const legacy = structuredClone(planned);
        delete legacy.promptTextContract;
        assert.doesNotThrow(() => assertDigestCoverManifestCurrent(legacy, publication, '2026-07-13'));
        assert.strictEqual(
            legacy.cover.taskToken,
            planned.cover.taskToken
        );
        assert.strictEqual(legacy.promptSha256, promptSha256(v1Path));

        const fresh = planDigestCover({
            targetDate: '2026-07-13', papers: [published],
            manifestPath: path.join(dir, 'fresh.json')
        });
        assert.strictEqual(fresh.promptTextContract, V2);
        assert.strictEqual(fresh.promptSha256, promptSha256(v2Path));
        assert.doesNotThrow(() => assertDigestCoverManifestCurrent(fresh, publication, '2026-07-13'));

        const unknown = structuredClone(fresh);
        unknown.promptTextContract = 'analysis-prompt-text-v9';
        assert.throws(
            () => assertDigestCoverManifestCurrent(unknown, publication, '2026-07-13'),
            /没有登记/
        );
    }));
});

describe('汇总封面状态必须重核当前文件', () => {
    const { spawnSync } = require('node:child_process');
    const {
        productionV6GenerationFields,
        productionV6ReceiptFields
    } = require('./production-v6-publication-fixture.js');
    const {
        publishedPapersFingerprint,
        assertPublishedBlogReceipt
    } = require('../scripts/visual-summary-state.js');

    function withPublishedCover(callback) {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-current-file-'));
        const previousAssetDir = Config.FILES.digestCoverAssetDir;
        const previousCurrentDir = Config.CURRENT_DIR;
        try {
            const assetDir = path.join(directory, 'archive');
            Config.FILES.digestCoverAssetDir = assetDir;
            Config.CURRENT_DIR = directory;
            const targetDate = '2026-07-13';
            const papers = [paper('2607.12345', 6.9, '#语音识别', 'Current cover')];
            const fingerprint = publishedPapersFingerprint(papers);
            const generation = {
                schemaVersion: 3,
                date: targetDate,
                category: '论文速递',
                visualSummaryRequired: false,
                digestCoverRequired: false,
                inputFingerprint: 'c'.repeat(64),
                publishAll: false,
                publishedPapers: papers,
                publishedPapersFingerprintContract: 'typed-json-f64-utf16-v1',
                publishedPapersFingerprint: fingerprint,
                ...productionV6GenerationFields(papers)
            };
            const generationBytes = Buffer.from(JSON.stringify(generation));
            fs.writeFileSync(path.join(directory, `blog-generation-manifest-${targetDate}.json`), generationBytes);
            const receiptPath = path.join(directory, `blog-review-receipt-${targetDate}.json`);
            fs.writeFileSync(receiptPath, JSON.stringify({
                schemaVersion: 3,
                date: targetDate,
                strictReview: true,
                hugoGate: 'hugo',
                reviewProtocolFingerprint: 'b'.repeat(64),
                generationManifestSha256: crypto.createHash('sha256').update(generationBytes).digest('hex'),
                generationInputIntegrity: 'typed-json-f64-utf16-v1',
                generationInputFingerprint: generation.inputFingerprint,
                publishedPapersFingerprint: fingerprint,
                publicationCommit: 'a'.repeat(40),
                remoteVerifiedOid: 'a'.repeat(40),
                remoteVerifiedAt: '2026-07-14T02:00:00+08:00',
                ...productionV6ReceiptFields(generation)
            }));
            const publication = assertPublishedBlogReceipt(targetDate, receiptPath);
            const manifestPath = path.join(directory, 'cover.json');
            const planned = planDigestCoverImpl({
                targetDate,
                papers,
                manifestPath,
                publication
            });
            const sourcePath = path.join(directory, 'generated.png');
            fs.writeFileSync(sourcePath, portraitPng());
            const manifest = recordDigestCoverImpl({
                sourcePath,
                taskToken: planned.cover.taskToken,
                targetDate,
                manifestPath,
                qaAttested: true
            });
            const asset = path.resolve(Config.PROJECT_ROOT, manifest.cover.assetPath);
            const runStatus = () => spawnSync(process.execPath, ['-e', `
                const Config = require('./scripts/config.js');
                Config.FILES.digestCoverAssetDir = process.argv[1];
                Config.CURRENT_DIR = require('node:path').dirname(process.argv[3]);
                require('./scripts/digest-cover-state.js').main([
                    'status', '--date', process.argv[2],
                    '--manifest', process.argv[3], '--receipt', process.argv[4]
                ]);
            `, assetDir, targetDate, manifestPath, receiptPath], {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf8',
                timeout: 2500
            });
            callback({ directory, manifestPath, manifest, sourcePath, asset, runStatus });
        } finally {
            Config.FILES.digestCoverAssetDir = previousAssetDir;
            Config.CURRENT_DIR = previousCurrentDir;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }

    function assertInvalidStatus(result) {
        assert.ifError(result.error);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /汇总图: invalid/);
        assert.doesNotMatch(result.stdout, /汇总图: complete/);
    }

    it('当前发布绑定的原PNG仍完成，缺失或损坏文件不能显示旧complete', () => {
        withPublishedCover(({ asset, manifestPath, runStatus }) => {
            const savedManifest = fs.readFileSync(manifestPath);
            const original = runStatus();
            assert.ifError(original.error);
            assert.equal(original.status, 0, original.stderr);
            assert.match(original.stdout, /汇总图: complete/);
            fs.writeFileSync(asset, 'broken PNG');
            assertInvalidStatus(runStatus());
            fs.unlinkSync(asset);
            assertInvalidStatus(runStatus());
            assert.deepEqual(fs.readFileSync(manifestPath), savedManifest);
        });
    });

    it('相同SHA的符号链接也不是可确认完成的封面文件', () => {
        withPublishedCover(({ asset, sourcePath, manifestPath, runStatus }) => {
            const savedManifest = fs.readFileSync(manifestPath);
            fs.unlinkSync(asset);
            fs.symlinkSync(sourcePath, asset);
            const before = fs.lstatSync(asset);
            assertInvalidStatus(runStatus());
            assert.equal(fs.lstatSync(asset).ino, before.ino);
            assert.deepEqual(fs.readFileSync(manifestPath), savedManifest);
        });
    });

    it('真实status遇无写者FIFO立即拒绝并保留文件和登记记录', () => {
        withPublishedCover(({ asset, manifestPath, runStatus }) => {
            const savedManifest = fs.readFileSync(manifestPath);
            fs.unlinkSync(asset);
            const created = spawnSync('mkfifo', [asset], { encoding: 'utf8' });
            assert.equal(created.status, 0, created.stderr);
            const before = fs.lstatSync(asset);
            assertInvalidStatus(runStatus());
            assert.equal(fs.lstatSync(asset).ino, before.ino);
            assert.deepEqual(fs.readFileSync(manifestPath), savedManifest);
        });
    });
});

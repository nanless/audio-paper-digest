const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const Config = require('../scripts/config.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
const {
    buildCoverContext,
    planDigestCover: planDigestCoverImpl,
    recordDigestCover,
    markDigestCoverFailed,
    assertDigestCoverManifestCurrent
} = require('../scripts/digest-cover-state.js');

const TEST_PUBLICATION = Object.freeze({
    publicationCommit: 'd'.repeat(40),
    generationManifestSha256: 'e'.repeat(64),
    category: '论文速递'
});

function planDigestCover(options) {
    return planDigestCoverImpl({ publication: TEST_PUBLICATION, ...options });
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

describe('digest cover state', () => {
    it('核心规划 API 也拒绝绕过远端发布绑定', () => {
        assert.throws(() => planDigestCoverImpl({
            targetDate: '2026-07-13', papers: [paper('2607.1', 8, '#语音识别', 'Paper')],
            manifestPath: path.join(os.tmpdir(), `unpublished-cover-${Date.now()}.json`)
        }), /远端已验证/);
    });

    it('只读契约检查会发现 prompt 变化，不能让旧完成状态假绿', () => {
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

    it('从汇总页同源字段生成热门方向和降序 TOP 5', () => {
        const papers = [
            paper('2607.1', 7.5, '#语音识别', 'First'),
            paper('2607.2', 9.1, '#音乐生成', 'Second'),
            paper('2607.3', 8.2, '#语音识别', 'Third')
        ];
        const context = buildCoverContext(papers, '2026-07-13');
        assert.strictEqual(context.paperCount, 3);
        assert.deepStrictEqual(context.hotDirections[0], { tag: '#语音识别', count: 2 });
        assert.deepStrictEqual(context.ranking.map(item => item.title), ['Second', 'Third', 'First']);
        assert.deepStrictEqual(context.ranking.map(item => item.rank), [1, 2, 3]);
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
            Config.FILES.digestCoverAssetDir = path.join(Config.CURRENT_DIR, 'digest-covers');
            const papers = [paper('2607.1', 8.0, '#语音识别', 'Paper')];
            const planned = planDigestCover({ targetDate: '2026-07-13', papers, manifestPath, promptPath });
            assert.strictEqual(planned.cover.status, 'pending');
            const completed = recordDigestCover({
                sourcePath, taskToken: planned.cover.taskToken, manifestPath
            });
            assert.strictEqual(completed.overallStatus, 'complete');
            assert.ok(fs.existsSync(path.resolve(Config.PROJECT_ROOT, completed.cover.assetPath)));
            const reused = planDigestCover({ targetDate: '2026-07-13', papers, manifestPath, promptPath });
            assert.strictEqual(reused.cover.status, 'complete');

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
});

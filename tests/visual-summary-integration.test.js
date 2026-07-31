const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
const {
    reconcileVisualSummaryTasks,
    parseArgs
} = require('../scripts/visual-summary-integration.js');

function publishedPaper(id, score) {
    return validAnalysisPaper(id, {
        title: `Published ${id}`,
        fetchedAt: '2026-07-13T10:00:00.000+08:00',
        parsed: {
            ...validAnalysisPaper(id).parsed,
            score: String(score),
            primaryTaskTag: '#语音识别',
            tags: ['#语音识别']
        }
    });
}

function writePublication(currentDir, papers, commit = 'a'.repeat(40)) {
    const date = '2026-07-13';
    const generation = {
        schemaVersion: 3,
        date,
        category: '论文速递',
        inputFingerprint: 'c'.repeat(64),
        visualSummaryRequired: false,
        digestCoverRequired: false,
        publishedPapers: papers
    };
    const raw = Buffer.from(JSON.stringify(generation));
    fs.writeFileSync(path.join(currentDir, `blog-generation-manifest-${date}.json`), raw);
    const receipt = path.join(currentDir, `blog-review-receipt-${date}.json`);
    fs.writeFileSync(receipt, JSON.stringify({
        schemaVersion: 3,
        date,
        strictReview: true,
        hugoGate: 'hugo',
        reviewProtocolFingerprint: 'b'.repeat(64),
        generationManifestSha256: crypto.createHash('sha256').update(raw).digest('hex'),
        publicationCommit: commit,
        remoteVerifiedOid: commit,
        remoteVerifiedAt: '2026-07-14T03:00:00+08:00'
    }));
    return receipt;
}

describe('post-publication visual orchestration', () => {
    it('视觉规划 CLI 拒绝未知、缺值和重复参数', () => {
        assert.throws(() => parseArgs(['--unknown', 'value']), /未知参数/);
        assert.throws(() => parseArgs(['--date']), /无效参数/);
        assert.throws(
            () => parseArgs(['--date', '2026-07-13', '--date', '2026-07-14']),
            /只能指定一次/
        );
    });

    it('只使用 generation 中实际发布快照，并同时规划 TOP 10 长图与汇总图', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-visual-integration-'));
        const originals = {
            current: Config.CURRENT_DIR,
            visualManifest: Config.FILES.visualSummaryManifestDir,
            visualAsset: Config.FILES.visualSummaryAssetDir,
            coverManifest: Config.FILES.digestCoverManifestDir,
            coverAsset: Config.FILES.digestCoverAssetDir
        };
        try {
            Config.CURRENT_DIR = dir;
            Config.FILES.visualSummaryManifestDir = path.join(dir, 'visual-summary-manifests');
            Config.FILES.visualSummaryAssetDir = path.join(dir, 'archive');
            Config.FILES.digestCoverManifestDir = path.join(dir, 'digest-cover-manifests');
            Config.FILES.digestCoverAssetDir = path.join(dir, 'archive');
            const papers = Array.from({ length: 12 }, (_, index) =>
                publishedPaper(`2607.${String(index + 1).padStart(5, '0')}`, 9 - index / 10));
            papers[0].fetchedAt = '2026-07-01T10:00:00.000+08:00';
            const receipt = writePublication(dir, papers);
            const result = reconcileVisualSummaryTasks({
                targetDate: '2026-07-13',
                publicationReceiptPath: receipt
            });
            assert.strictEqual(Object.keys(result.manifest.papers).length, 10);
            assert.strictEqual(result.pendingCards.length, 10);
            assert.strictEqual(result.pendingCover.length, 1);
            assert.strictEqual(result.coverManifest.generationContext.paperCount, 12);
            assert.strictEqual(result.coverManifest.generationContext.rankingCount, 10);
            assert.strictEqual(result.coverManifest.generationContext.ranking.length, 10);
            assert.strictEqual(result.coverManifest.generationContext.rendering.mode, 'full_image_generation_v2');
            assert.strictEqual(result.coverManifest.generationContext.rendering.renderer, 'built-in image_gen');
            assert.strictEqual(result.coverManifest.generationContext.rendering.resolutionPolicy, 'highest_available_portrait');
            assert.ok(!Object.hasOwn(result.coverManifest.generationContext.rendering, 'width'));
            assert.ok(!Object.hasOwn(result.coverManifest.generationContext.rendering, 'height'));
            assert.strictEqual(result.manifest.publication.publicationCommit, 'a'.repeat(40));
        } finally {
            Config.CURRENT_DIR = originals.current;
            Config.FILES.visualSummaryManifestDir = originals.visualManifest;
            Config.FILES.visualSummaryAssetDir = originals.visualAsset;
            Config.FILES.digestCoverManifestDir = originals.coverManifest;
            Config.FILES.digestCoverAssetDir = originals.coverAsset;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('没有远端验证凭证时拒绝规划', () => {
        assert.throws(() => reconcileVisualSummaryTasks({
            targetDate: '2026-07-13',
            publicationReceiptPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`)
        }), /缺少可验证的博客发布凭证/);
    });
});

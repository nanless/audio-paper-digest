const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

before(() => {
    process.env.PAPER_ANALYZER_ENDPOINT = process.env.PAPER_ANALYZER_ENDPOINT || 'https://api.openai.com/v1';
    process.env.PAPER_ANALYZER_API_KEY = process.env.PAPER_ANALYZER_API_KEY || 'test-key';
    process.env.PAPER_ANALYZER_MODEL = process.env.PAPER_ANALYZER_MODEL || 'gpt-4o-mini';
});

describe('arXiv HTML full-text health gate', () => {
    it('拒绝字符数很长但没有论文段落和章节的元数据空壳', () => {
        const { assessArxivHtmlFullText } = require('../scripts/deep-analyzer.js');
        const shell = `<html><body><div>${'Sponsor author navigation '.repeat(400)}</div></body></html>`;
        const $ = cheerio.load(shell);
        const result = assessArxivHtmlFullText($, $('body').text());
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, 'metadata_shell');
    });

    it('接受包含多个正文段落和论文结构标记的完整 HTML', () => {
        const { assessArxivHtmlFullText } = require('../scripts/deep-analyzer.js');
        const paragraph = 'This paragraph explains the speech model, training evidence, evaluation protocol, and measured results in sufficient technical detail. ';
        const html = `<html><body><article>
          <section><h2>Abstract</h2>${`<p>${paragraph.repeat(12)}</p>`.repeat(2)}</section>
          <section><h2>Introduction</h2><p>${paragraph.repeat(12)}</p></section>
          <section><h2>Method</h2><p>${paragraph.repeat(12)}</p></section>
          <section><h2>Experiments and Results</h2><p>${paragraph.repeat(12)}</p></section>
        </article></body></html>`;
        const $ = cheerio.load(html);
        const result = assessArxivHtmlFullText($, $('article').text());
        assert.strictEqual(result.valid, true);
        assert.ok(result.paragraphCount >= 4);
        assert.ok(result.markerCount >= 2);
    });
});

describe('deep-analyzer section helpers', () => {
    it('普通模型 HTTP 请求尝试次数默认服从分析配置并允许显式覆写', () => {
        const { resolveApiMaxRetries } = require('../scripts/deep-analyzer.js');
        const { ANALYSIS_CONFIG } = require('../scripts/config.js');

        assert.strictEqual(resolveApiMaxRetries(), ANALYSIS_CONFIG.apiMaxRetries);
        assert.strictEqual(resolveApiMaxRetries(1), 1);
        assert.strictEqual(resolveApiMaxRetries(0), ANALYSIS_CONFIG.apiMaxRetries);
    });

    it('提取当前 prompt 使用的 ## 方法和实验章节', () => {
        const {
            extractSectionByTitle
        } = require('../scripts/deep-analyzer.js');

        const analysis = `## 评分
8.0/10

## 方法概述和架构
方法第一段。

方法第二段。

## 核心创新点
创新。

## 实验结果
结果引用表1，但没有表格。

## 细节详述
细节。`;

        assert.match(extractSectionByTitle(analysis, '方法概述和架构'), /方法第一段/);
        assert.match(extractSectionByTitle(analysis, '实验结果'), /结果引用表1/);
    });

    it('合并当前 prompt 的 ## 章节而不是追加重复章节', () => {
        const {
            mergeSectionByTitle
        } = require('../scripts/deep-analyzer.js');

        const analysis = `## 方法概述和架构
旧方法。

## 核心创新点
创新。`;
        const merged = mergeSectionByTitle(analysis, '方法概述和架构', '## 方法概述和架构\n新方法。');

        assert.match(merged, /## 方法概述和架构\n新方法。/);
        assert.strictEqual((merged.match(/## 方法概述和架构/g) || []).length, 1);
        assert.match(merged, /## 核心创新点\n创新。/);
    });

    it('合并多行章节时会完整删除旧内容', () => {
        const { mergeSectionByTitle } = require('../scripts/deep-analyzer.js');
        const analysis = `## 方法概述和架构
旧方法第一行。
旧方法第二行。

## 核心创新点
创新。`;
        const merged = mergeSectionByTitle(analysis, '方法概述和架构', '新方法第一行。\n新方法第二行。');
        assert.doesNotMatch(merged, /旧方法/);
        assert.match(merged, /新方法第一行。\n新方法第二行。/);
        assert.match(merged, /## 核心创新点\n创新。/);
    });

    it('移除副模型输出中的未授权 Markdown 图片', () => {
        const {
            removeUnapprovedMarkdownImages
        } = require('../scripts/deep-analyzer.js');

        const cleaned = removeUnapprovedMarkdownImages(
            '保留 ![ok](https://arxiv.org/html/2604.1/x1.png) 删除 ![bad](https://evil.example/fake.png)',
            ['https://arxiv.org/html/2604.1/x1.png']
        );

        assert.match(cleaned, /!\[ok\]\(https:\/\/arxiv\.org\/html\/2604\.1\/x1\.png\)/);
        assert.doesNotMatch(cleaned, /evil\.example/);
    });

    it('预筛图片时优先保留架构、语谱和结果图', () => {
        const {
            selectImageCandidates
        } = require('../scripts/deep-analyzer.js');

        const selected = selectImageCandidates([
            { url: 'https://example.com/logo.png', caption: 'publisher logo' },
            { url: 'data:image/svg+xml;base64,PHN2Zy8+', caption: 'inline svg' },
            { url: 'https://example.com/vector.svg', caption: 'svg diagram' },
            { url: 'https://example.com/architecture.png', caption: 'Model architecture overview' },
            { url: 'https://example.com/spectrogram.png', caption: 'Speech spectrogram comparison' },
            { url: 'https://example.com/author.png', caption: 'author photo' },
            { url: 'https://example.com/results.png', caption: 'Ablation results on benchmarks' },
            { url: 'https://arxiv.org/static/base/1.0.1/images/funders/simons-foundation.png', caption: 'Simons Foundation' }
        ], 3);

        assert.deepStrictEqual(selected.map(x => x.url), [
            'https://example.com/architecture.png',
            'https://example.com/results.png',
            'https://example.com/spectrogram.png'
        ]);
        assert.deepStrictEqual(selectImageCandidates([
            { url: 'https://example.com/foundation-model.png', caption: 'Audio foundation model architecture' },
            { url: 'https://arxiv.org/static/base/1.0.1/images/funders/schmidt-sciences.png', caption: 'Schmidt Sciences' }
        ], 2).map(x => x.url), ['https://example.com/foundation-model.png']);
    });

    it('过滤副模型不稳定的内联图片和 SVG，并截断日志标签', () => {
        const {
            isSupportedImageUrl,
            safeImageLabel,
            normalizeImageInfos
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(isSupportedImageUrl('data:image/svg+xml;base64,PHN2Zy8+'), false);
        assert.strictEqual(isSupportedImageUrl('http://example.com/figure.png'), false);
        assert.strictEqual(isSupportedImageUrl('https://example.com/figure.svg'), false);
        assert.strictEqual(isSupportedImageUrl('https://example.com/figure.png?download=1'), true);
        assert.strictEqual(isSupportedImageUrl('https://example.com/arxiv-figure?id=1'), true);
        assert.strictEqual(isSupportedImageUrl('https://example.com/paper.pdf'), false);
        assert.deepStrictEqual(normalizeImageInfos([
            'data:image/svg+xml;base64,PHN2Zy8+',
            'https://example.com/figure.svg',
            'https://example.com/figure.png'
        ]), [
            { url: 'https://example.com/figure.png', caption: '' }
        ]);
        assert.strictEqual(safeImageLabel('data:image/svg+xml;base64,' + 'x'.repeat(1000)), 'image/svg+xml;base64,<omitted>');
    });

    it('旧图片恢复 checkpoint 在载入与保存边界剔除 HTTP 且保留合法 caption/cache', () => {
        const {
            sanitizePaperImageRecovery,
            saveAnalysisCheckpoint
        } = require('../scripts/deep-analyzer.js');
        const paper = {
            analysisRecoveryImageManifest: {
                candidates: [
                    { url: 'http://legacy.example/unsafe.png', caption: 'unsafe', cachePath: 'cache/unsafe.bin' },
                    { url: 'https://safe.example/architecture.png', caption: 'Architecture', cachePath: 'cache/architecture.bin' }
                ],
                selected: [
                    'http://legacy.example/unsafe.png',
                    'https://safe.example/architecture.png',
                    { url: 'https://safe.example/results.webp', caption: 'Results', cachePath: 'cache/results.bin' }
                ],
                downloaded: [
                    { url: 'http://legacy.example/unsafe.png', cachePath: 'cache/unsafe.bin' },
                    { url: 'https://safe.example/results.webp', cachePath: 'cache/results.bin', cacheHit: true }
                ],
                downloadOutcomes: [
                    { url: 'http://legacy.example/unsafe.png', status: 'downloaded' },
                    { url: 'https://safe.example/results.webp', status: 'downloaded' }
                ]
            },
            imageManifest: {
                candidates: [{ url: 'http://legacy.example/stale.jpg', caption: 'stale' }],
                selected: ['http://legacy.example/stale.jpg']
            },
            imageUrls: [
                'http://legacy.example/unsafe.png',
                { url: 'https://safe.example/results.webp', caption: 'Results', cachePath: 'cache/results.bin' }
            ],
            allImageUrls: ['http://legacy.example/unsafe.png', 'https://safe.example/architecture.png'],
            selectedImageUrls: ['http://legacy.example/unsafe.png', 'https://safe.example/results.webp']
        };

        sanitizePaperImageRecovery(paper);
        const recovery = paper.analysisRecoveryImageManifest;
        assert.deepStrictEqual(recovery.selected, [
            'https://safe.example/architecture.png',
            'https://safe.example/results.webp'
        ]);
        assert.deepStrictEqual(
            recovery.candidates.find(item => item.url.endsWith('/architecture.png')),
            { url: 'https://safe.example/architecture.png', caption: 'Architecture', cachePath: 'cache/architecture.bin' }
        );
        assert.deepStrictEqual(
            recovery.candidates.find(item => item.url.endsWith('/results.webp')),
            { url: 'https://safe.example/results.webp', caption: 'Results', cachePath: 'cache/results.bin' }
        );
        assert.strictEqual(recovery.downloaded[0].cachePath, 'cache/results.bin');
        assert.strictEqual(recovery.downloaded[0].cacheHit, true);
        assert.deepStrictEqual(paper.selectedImageUrls, ['https://safe.example/results.webp']);
        assert.strictEqual(paper.imageUrls[0].caption, 'Results');
        assert.strictEqual(paper.imageUrls[0].cachePath, 'cache/results.bin');
        assert.doesNotMatch(JSON.stringify(paper), /http:\/\//i);

        const persisted = [];
        const checkpointPaper = {
            [Symbol.for('audio-paper-digest.analysisCheckpointCallback')]: value => {
                persisted.push(JSON.parse(JSON.stringify(value)));
            }
        };
        saveAnalysisCheckpoint(checkpointPaper, 'checkpoint', { stages: {} }, {
            candidates: [{ url: 'http://legacy.example/unsafe.png' }],
            selected: ['http://legacy.example/unsafe.png', 'https://safe.example/results.webp'],
            downloaded: [{ url: 'https://safe.example/results.webp', cachePath: 'cache/results.bin' }]
        });
        assert.strictEqual(persisted.length, 1);
        assert.doesNotMatch(JSON.stringify(persisted[0]), /http:\/\//i);
        assert.deepStrictEqual(persisted[0].analysisRecoveryImageManifest.selected, [
            'https://safe.example/results.webp'
        ]);
        assert.strictEqual(
            persisted[0].analysisRecoveryImageManifest.downloaded[0].cachePath,
            'cache/results.bin'
        );
    });

    it('将模型拒绝的透明 PNG 载荷标准化为 RGB JPEG', async () => {
        const { createCanvas } = require('@napi-rs/canvas');
        const {
            normalizeModelImagePayload,
            isCorruptedMultimodalError
        } = require('../scripts/deep-analyzer.js');
        const canvas = createCanvas(4, 3);
        const context = canvas.getContext('2d');
        context.fillStyle = 'rgba(255, 0, 0, 0.5)';
        context.fillRect(0, 0, 4, 3);

        const normalized = await normalizeModelImagePayload({
            url: 'https://example.com/alpha.png',
            mime: 'image/png',
            base64: canvas.toBuffer('image/png').toString('base64')
        });

        assert.strictEqual(normalized.mime, 'image/jpeg');
        assert.strictEqual(normalized.modelPayloadNormalized, true);
        assert.ok(Buffer.from(normalized.base64, 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
        assert.strictEqual(isCorruptedMultimodalError(new Error('Multimodal data is corrupted or cannot be processed.')), true);
        assert.strictEqual(isCorruptedMultimodalError(new Error('HTTP 429')), false);
    });

    it('arXiv figure 内多张图片会全部提取并按 URL 去重', () => {
        const { parseArxivImageInfosFromHtml } = require('../scripts/deep-analyzer.js');
        const html = `
            <figure>
                <img src="panels/a.png" alt="Refer to caption">
                <img src="panels/b.png" alt="Refer to caption">
                <img src="panels/a.png" alt="duplicate">
                <figcaption>Figure 2: Spectrogram comparison across systems.</figcaption>
            </figure>`;
        const images = parseArxivImageInfosFromHtml(html, '2607.12345v1', '2607.12345');

        assert.deepStrictEqual(images, [
            {
                url: 'https://arxiv.org/html/2607.12345v1/panels/a.png',
                caption: 'Figure 2: Spectrogram comparison across systems.',
                sourceOrder: 0
            },
            {
                url: 'https://arxiv.org/html/2607.12345v1/panels/b.png',
                caption: 'Figure 2: Spectrogram comparison across systems.',
                sourceOrder: 1
            }
        ]);
    });

    it('会用同 URL 或唯一文件名匹配补全预提供图片 caption', () => {
        const { mergeImageInfoMetadata } = require('../scripts/deep-analyzer.js');
        const merged = mergeImageInfoMetadata([
            'https://arxiv.org/html/2607.1/figures/x1.png',
            'https://cdn.example/result.png'
        ], [
            { url: 'https://arxiv.org/html/2607.1/figures/x1.png', caption: 'Figure 1: Architecture overview' },
            { url: 'https://arxiv.org/html/2607.1/result.png', caption: 'Figure 2: Result comparison' }
        ]);
        assert.strictEqual(merged[0].caption, 'Figure 1: Architecture overview');
        assert.strictEqual(merged[1].caption, 'Figure 2: Result comparison');
    });

    it('稳定 HTML 404 只尝试一轮，且图片发现可复用永久 miss', async () => {
        const { fetchArxivTextDetailed, fetchArxivImageUrls } = require('../scripts/deep-analyzer.js');
        const originalFetch = global.fetch;
        let calls = 0;
        global.fetch = async () => {
            calls++;
            return { ok: false, status: 404, headers: new Headers(), body: null };
        };
        try {
            const result = await fetchArxivTextDetailed('2607.99999');
            assert.strictEqual(result.source, 'unavailable');
            assert.strictEqual(result.htmlAvailability, 'permanent_miss');
            assert.strictEqual(result.htmlAttempts, 1);
            assert.strictEqual(calls, 6);
            const images = await fetchArxivImageUrls('2607.99999', { htmlAvailability: 'permanent_miss' });
            assert.deepStrictEqual(images, []);
            assert.strictEqual(calls, 6);
        } finally {
            global.fetch = originalFetch;
        }
    });

    it('图片发现的瞬时错误不会降级成空候选终态', async () => {
        const {
            fetchArxivImageUrls,
            classifyImageDiscoveryStatus
        } = require('../scripts/deep-analyzer.js');
        const transient = new Error('simulated timeout');
        transient.code = 'ETIMEDOUT';

        await assert.rejects(
            () => fetchArxivImageUrls('2607.99998', {
                maxRetries: 1,
                dispatcher: {},
                fetchImpl: async () => { throw transient; }
            }),
            error => error.code === 'ARXIV_IMAGE_DISCOVERY_TRANSIENT_FAILURE'
        );
        assert.strictEqual(classifyImageDiscoveryStatus([], transient), 'transient_failure');
        assert.strictEqual(classifyImageDiscoveryStatus([], null), 'no_candidates');
        assert.strictEqual(classifyImageDiscoveryStatus([{ url: 'https://example.com/a.png' }], null), 'complete');
    });

    it('图片发现失败会持久化并保留已有正文 checkpoint 供下轮恢复', () => {
        const {
            createAnalysisRecoveryManifest,
            classifyImageDiscoveryStatus,
            isRecoveryStageComplete,
            markRecoveryStage,
            persistImageDiscoveryFailure
        } = require('../scripts/deep-analyzer.js');
        const checkpointEvents = [];
        const paper = {
            arxivId: '2607.99997',
            analysisCheckpoint: 'existing analyzed body',
            analysisManifest: {
                version: 1,
                stages: { primaryAnalysis: { status: 'complete', fingerprint: 'primary-v1' } }
            }
        };
        Object.defineProperty(paper, Symbol.for('audio-paper-digest.analysisCheckpointCallback'), {
            value: checkpoint => checkpointEvents.push(checkpoint.analysisCheckpoint),
            configurable: true
        });
        const manifest = createAnalysisRecoveryManifest(paper);
        const transient = new Error('simulated discovery timeout');
        transient.code = 'ARXIV_IMAGE_DISCOVERY_TRANSIENT_FAILURE';
        markRecoveryStage(manifest, 'imageDiscovery', 'transient_failure', { error: transient.message });
        markRecoveryStage(manifest, 'imageDownload', 'transient_failure', { reason: 'discovery_failed' });

        const failed = persistImageDiscoveryFailure(
            paper,
            { analysisSource: 'provided_full_text' },
            [],
            manifest,
            { candidates: [], downloaded: [] },
            transient
        );
        assert.strictEqual(failed.analysis, null);
        assert.strictEqual(failed.analysisCheckpoint, 'existing analyzed body');
        assert.strictEqual(failed.analysisManifest.stages.imageDiscovery.status, 'transient_failure');
        assert.strictEqual(failed.analysisManifest.stages.imageDownload.status, 'transient_failure');
        assert.deepStrictEqual(checkpointEvents, ['existing analyzed body']);

        const nextManifest = createAnalysisRecoveryManifest(failed);
        assert.strictEqual(nextManifest.stages.primaryAnalysis.status, 'complete');
        assert.strictEqual(failed.analysisCheckpoint, 'existing analyzed body');
        markRecoveryStage(
            nextManifest,
            'imageDiscovery',
            classifyImageDiscoveryStatus([{ url: 'https://example.com/recovered.png' }], null)
        );
        markRecoveryStage(nextManifest, 'imageDownload', 'complete', { downloaded: 1 });
        assert.strictEqual(isRecoveryStageComplete(nextManifest, 'imageDiscovery'), true);
        assert.strictEqual(isRecoveryStageComplete(nextManifest, 'imageDownload'), true);
    });

    it('图片 HTTP 404 是永久失败且不会重试', async () => {
        const { downloadImageBase64 } = require('../scripts/deep-analyzer.js');
        let calls = 0;
        const requestImpl = async () => {
            calls++;
            return { ok: false, status: 404, headers: new Headers(), body: null };
        };
        const result = await downloadImageBase64(
            `https://8.8.8.8/not-found-${Date.now()}.png`,
            5,
            undefined,
            requestImpl
        );
        assert.strictEqual(result, null);
        assert.strictEqual(calls, 1);
    });

    it('候选图按信息得分决定下载优先级并保留原始顺序', () => {
        const { selectImageCandidates } = require('../scripts/deep-analyzer.js');
        const selected = selectImageCandidates([
            { url: 'https://example.com/first.png', caption: 'Figure' },
            { url: 'https://example.com/result.png', caption: 'Ablation results benchmark comparison' },
            { url: 'https://example.com/third.png', caption: 'Figure' }
        ], 2);

        assert.strictEqual(selected[0].url, 'https://example.com/result.png');
        assert.strictEqual(selected[0].sourceOrder, 1);
        assert.ok(selected[0].candidateScore >= selected[1].candidateScore);
    });

    it('图片下载会拒绝重定向到本机或私网地址', async () => {
        const { fetchPublicImageResponse } = require('../scripts/deep-analyzer.js');
        const requestImpl = async () => ({
            status: 302,
            headers: new Headers({ location: 'http://127.0.0.1/private.png' }),
            body: { cancel: async () => {} }
        });
        await assert.rejects(
            () => fetchPublicImageResponse('https://8.8.8.8/image.png', 5, requestImpl),
            /非公网|localhost/
        );
    });

    it('gap-fill 前缀清理不会误命中评分理由标题', () => {
        const {
            cleanGapFillPrefix
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(cleanGapFillPrefix('废话\n## 评分理由\n理由'), null);
        assert.strictEqual(cleanGapFillPrefix('废话\n## 评分\n8.0/10\n\n## 评分理由\n理由'), '## 评分\n8.0/10\n\n## 评分理由\n理由');
    });

    it('最终评分审计只更新类型、分数和评分理由', () => {
        const {
            parseScoringAuditResult,
            applyScoringAuditResult
        } = require('../scripts/deep-analyzer.js');
        const analysis = `## 评分
4.8/10

## 机器摘要
document_type: 系统技术报告
rank_bucket: 后50%
innovation: 0.8
technical_rigor: 0.7
experimental_sufficiency: 0.6
clarity: 0.6
impact: 0.5
open_source: 0.2
reproducibility: 0.1
engineering_score: 1.3
confidence: 高
primary_task_tag: #音视频生成

## 核心摘要
正文事实和结论必须保持不变。

## 评分理由
旧评分理由。`;
        const reason = '该维度根据已有分析中的具体证据独立判断，不重复使用其他维度的扣分事实。';
        const audit = parseScoringAuditResult(JSON.stringify({
            documentType: 'tech report',
            confidence: '中',
            dimensions: {
                innovation: { score: 1.6, reason },
                technicalRigor: { score: 1.1, reason: '公开方法逻辑基本自洽，技术路线中没有发现明确推导错误或系统逻辑漏洞。' },
                experimentalSufficiency: { score: 0.8, reason: '端到端结果支持系统能力，但组件级贡献缺少独立证据且竞品配置控制不足。' },
                clarity: { score: 0.8, reason },
                impact: { score: 0.5, reason },
                openSource: { score: 0.2, reason },
                reproducibility: { score: 0.1, reason: '模型架构规格、训练细节和完整推理配置披露不足，第三方无法据此重建相同系统。' },
                engineering: { score: 1.5, reason }
            }
        }));
        const updated = applyScoringAuditResult(analysis, audit);

        assert.strictEqual(audit.total, 6.6);
        assert.match(updated, /## 评分\n6\.6\/10/);
        assert.match(updated, /document_type: 系统技术报告/);
        assert.match(updated, /rank_bucket: 前50%/);
        assert.match(updated, /confidence: 中/);
        assert.match(updated, /technical_rigor: 1\.1/);
        assert.match(updated, /正文事实和结论必须保持不变/);
        assert.match(updated, /技术严谨性 \(1\.1\/1\.5\)：公开方法逻辑基本自洽/);
        assert.match(updated, /可复现性 \(0\.1\/0\.5\)：模型架构规格、训练细节/);
        assert.doesNotMatch(updated, /旧评分理由/);
    });

    it('最终评分审计拒绝缺失维度和越界分数', () => {
        const { parseScoringAuditResult } = require('../scripts/deep-analyzer.js');
        assert.throws(() => parseScoringAuditResult('{"documentType":"方法研究","confidence":"高","dimensions":{}}'), /缺少字段/);
    });

    it('最终评分审计拒绝 null、布尔、空值、额外维度和多位小数', () => {
        const { parseScoringAuditResult } = require('../scripts/deep-analyzer.js');
        const reason = '该维度依据原文中可核对的具体证据独立评分，并且没有复用其他维度的扣分事实。';
        const payload = {
            documentType: '方法研究',
            confidence: '高',
            dimensions: {
                innovation: { score: 1.0, reason },
                technicalRigor: { score: 1.0, reason },
                experimentalSufficiency: { score: 1.0, reason },
                clarity: { score: 0.8, reason },
                impact: { score: 1.0, reason },
                openSource: { score: 0.5, reason },
                reproducibility: { score: 0.3, reason },
                engineering: { score: 1.0, reason }
            }
        };
        for (const invalidScore of [null, true, '', 1.11]) {
            const candidate = structuredClone(payload);
            candidate.dimensions.innovation.score = invalidScore;
            assert.throws(() => parseScoringAuditResult(JSON.stringify(candidate)), /有限数字|最多一位小数/);
        }
        const extraDimension = structuredClone(payload);
        extraDimension.dimensions.marketing = { score: 1.0, reason };
        assert.throws(() => parseScoringAuditResult(JSON.stringify(extraDimension)), /额外字段/);
    });

    it('最终评分审计拒绝跨维度重复扣分事实', () => {
        const { parseScoringAuditResult } = require('../scripts/deep-analyzer.js');
        const reason = '该维度根据已有分析中的具体证据独立判断，不重复使用其他维度的扣分事实。';
        const payload = {
            documentType: '系统技术报告',
            confidence: '中',
            dimensions: {
                innovation: { score: 1, reason },
                technicalRigor: { score: 1, reason: '由于训练超参数没有披露，所以本文技术严谨性明显不足，需要在这里扣分。' },
                experimentalSufficiency: { score: 1, reason },
                clarity: { score: 0.8, reason },
                impact: { score: 0.5, reason },
                openSource: { score: 0.2, reason },
                reproducibility: { score: 0.1, reason },
                engineering: { score: 1.2, reason }
            }
        };
        assert.throws(
            () => parseScoringAuditResult(JSON.stringify(payload)),
            /其他维度.*违规分句.*训练超参数没有披露/
        );
    });

    it('最终评分审计在运行时要求每个理由引用账本内证据 ID', () => {
        const { parseScoringAuditResult } = require('../scripts/deep-analyzer.js');
        const reason = '[A_METHOD] 该维度依据方法章节中的具体流程和组件证据独立完成判断。';
        const payload = {
            documentType: '系统技术报告',
            confidence: '中',
            dimensions: {
                innovation: { score: 1.0, reason },
                technicalRigor: { score: 1.0, reason },
                experimentalSufficiency: { score: 1.0, reason: '[A_RESULTS] 实验章节提供了可核对的指标和对照结果。' },
                clarity: { score: 0.8, reason },
                impact: { score: 1.0, reason },
                openSource: { score: 0.5, reason: '[A_OPEN] 开源章节明确记录了当前公开产物状态。' },
                reproducibility: { score: 0.3, reason },
                engineering: { score: 1.0, reason }
            }
        };
        const allowed = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN']);
        assert.doesNotThrow(() => parseScoringAuditResult(JSON.stringify(payload), allowed));
        payload.dimensions.impact.reason = '该理由虽然足够长，但没有引用任何证据账本中的标识。';
        assert.throws(
            () => parseScoringAuditResult(JSON.stringify(payload), allowed),
            /缺少证据账本 ID/
        );
        payload.dimensions.impact.reason = '[A_UNKNOWN] 该理由引用了不存在的账本标识，必须被代码拒绝。';
        assert.throws(
            () => parseScoringAuditResult(JSON.stringify(payload), allowed),
            /账本外 ID: A_UNKNOWN/
        );
    });

    it('归一化后的评分审计二次校验会剥离内部派生字段', () => {
        const {
            parseScoringAuditResult,
            revalidateScoringAudit
        } = require('../scripts/deep-analyzer.js');
        const reason = '[A_METHOD] 该维度依据分析正文中的具体方法、结果和限制证据独立完成判断。';
        const payload = {
            documentType: '方法研究',
            confidence: '高',
            dimensions: Object.fromEntries([
                ['innovation', 1.0],
                ['technicalRigor', 1.0],
                ['experimentalSufficiency', 1.0],
                ['clarity', 0.8],
                ['impact', 1.0],
                ['openSource', 0.5],
                ['reproducibility', 0.3],
                ['engineering', 1.0]
            ].map(([key, score]) => [key, { score, reason }]))
        };
        const allowed = new Set(['A_METHOD']);
        const parsed = parseScoringAuditResult(JSON.stringify(payload), allowed);
        assert.ok(Object.hasOwn(parsed, 'total'));
        assert.ok(Object.hasOwn(parsed, 'rankBucket'));
        assert.doesNotThrow(() => revalidateScoringAudit(parsed, allowed));
    });

    it('最终评分审计输入移除旧评分理由但保留正文证据', () => {
        const { prepareScoringAuditAnalysis } = require('../scripts/deep-analyzer.js');
        const analysis = `## 核心摘要
核心方法与结果证据。

## 评分理由
影响力因模型未开源而受限。

## 局限与问题
论文缺少跨数据集验证。`;
        const prepared = prepareScoringAuditAnalysis(analysis);
        assert.match(prepared, /核心方法与结果证据/);
        assert.match(prepared, /论文缺少跨数据集验证/);
        assert.match(prepared, /旧评分理由已由代码移除/);
        assert.doesNotMatch(prepared, /影响力因模型未开源而受限/);
    });

    it('跨维度检查覆盖创新和工程，但不误杀正向或非扣分证据', () => {
        const { reasonUsesForbiddenDeduction, parseScoringAuditResult } = require('../scripts/deep-analyzer.js');
        assert.strictEqual(reasonUsesForbiddenDeduction('论文已提供完整训练配置和超参数，技术证据可核对。', []), false);
        const reason = '该维度依据原文中可核对的具体证据独立评分，并且没有复用其他维度的扣分事实。';
        const payload = {
            documentType: '系统技术报告',
            confidence: '中',
            dimensions: {
                innovation: { score: 1.0, reason: '虽然系统闭源，但闭源不应影响创新性判断；系统级协同设计具有明确新意。' },
                technicalRigor: { score: 1.0, reason },
                experimentalSufficiency: { score: 1.0, reason },
                clarity: { score: 0.8, reason },
                impact: { score: 1.0, reason },
                openSource: { score: 0.0, reason },
                reproducibility: { score: 0.3, reason },
                engineering: { score: 1.0, reason }
            }
        };
        assert.doesNotThrow(() => parseScoringAuditResult(JSON.stringify(payload)));
        payload.dimensions.engineering.reason = '由于系统闭源且没有开源，因此工程实践价值只能得较低分。';
        assert.throws(() => parseScoringAuditResult(JSON.stringify(payload)), /其他维度/);
    });

    it('恢复 manifest 区分无高价值图成功和瞬时失败', () => {
        const {
            createAnalysisRecoveryManifest,
            markRecoveryStage,
            isRecoveryStageComplete
        } = require('../scripts/deep-analyzer.js');
        const manifest = createAnalysisRecoveryManifest({});
        markRecoveryStage(manifest, 'imageSupplement', 'no_high_value_images', { selectedCount: 0 });
        assert.strictEqual(isRecoveryStageComplete(manifest, 'imageSupplement'), true);
        markRecoveryStage(manifest, 'scoringAudit', 'transient_failure', { error: 'timeout' });
        assert.strictEqual(isRecoveryStageComplete(manifest, 'scoringAudit'), false);
        assert.match(manifest.updatedAt, /\+08:00$/);
    });

    it('整体超时预算使用剩余时间而不是每次重置', () => {
        const {
            createActiveTimeBudget,
            getActiveRemainingTimeoutMs,
            getRemainingTimeoutMs
        } = require('../scripts/deep-analyzer.js');
        assert.strictEqual(getRemainingTimeoutMs(1500, 1000), 500);
        assert.throws(() => getRemainingTimeoutMs(1000, 1000), error => error.code === 'MODEL_OVERALL_TIMEOUT');

        let now = 0;
        const budget = createActiveTimeBudget(100000, {
            now: () => now,
            tickMs: 1000,
            suspendThresholdMs: 30000,
            autoStart: false
        });
        now = 10000;
        assert.strictEqual(budget.elapsedMs(), 10000);
        now += 60 * 60 * 1000;
        assert.strictEqual(budget.elapsedMs(), 12000);
        assert.strictEqual(budget.suspendedMs(), 3598000);
        assert.strictEqual(getActiveRemainingTimeoutMs(100000, budget.elapsedMs()), 88000);
        budget.stop();
    });

    it('类型证据上下文同时包含文类标准和原文', () => {
        const { buildTypeAwareSourceContext } = require('../scripts/deep-analyzer.js');
        const context = buildTypeAwareSourceContext('## 机器摘要\ndocument_type: 系统技术报告', 'latency throughput evidence');
        assert.match(context, /系统技术报告/);
        assert.match(context, /延迟、吞吐、成本/);
        assert.match(context, /latency throughput evidence/);
    });

    it('未截断的短原文也使用稳定证据账本 ID', () => {
        const { buildTaskEvidenceContext } = require('../scripts/deep-analyzer.js');
        assert.strictEqual(
            buildTaskEvidenceContext('short evidence', 12000, [], 'SCORING'),
            '[SCORING_SOURCE_1/1]\nshort evidence'
        );
        assert.strictEqual(buildTaskEvidenceContext('', 12000, [], 'SCORING'), '');
    });

    it('评分证据账本覆盖原文开头、中段和末尾', () => {
        const { buildTypeAwareSourceContext } = require('../scripts/deep-analyzer.js');
        const source = `HEAD_MARKER${'x'.repeat(9000)}MIDDLE_MARKER${'y'.repeat(9000)}TAIL_MARKER`;
        const context = buildTypeAwareSourceContext(validAnalysisText(), source, 12000);
        assert.match(context, /\[SCORING_SOURCE_/);
        assert.match(context, /HEAD_MARKER/);
        assert.match(context, /MIDDLE_MARKER/);
        assert.match(context, /TAIL_MARKER/);
    });

    it('任务证据切片遵守字符预算并优先保留稀疏相关证据', () => {
        const { buildTaskEvidenceContext } = require('../scripts/deep-analyzer.js');
        const source = [
            'HEAD_MARKER ',
            '普通背景。'.repeat(8000),
            '关键开源证据：code and weights will be released at https://github.com/example/audio-model 。',
            '普通附录。'.repeat(8000),
            'TAIL_MARKER'
        ].join('');
        const context = buildTaskEvidenceContext(
            source,
            12000,
            [/github\.com/i, /will be released/i],
            'OPEN_SOURCE'
        );
        assert.ok(context.length <= 12000);
        assert.match(context, /HEAD_MARKER/);
        assert.match(context, /github\.com\/example\/audio-model/);
        assert.match(context, /TAIL_MARKER/);
    });

    it('后处理阶段从完整正文独立选证据而不是复用主分析截断文本', () => {
        const {
            buildTaskEvidenceContext,
            buildStageEvidenceContext
        } = require('../scripts/deep-analyzer.js');
        const source = [
            'PRIMARY_ONLY_HEAD ',
            'neutral background '.repeat(2500),
            'UNIQUE_OPEN_SOURCE_EVIDENCE artifact weights will be released after acceptance ',
            'neutral appendix '.repeat(5000),
            'FULL_SOURCE_TAIL'
        ].join('');
        const truncatedPrimary = buildTaskEvidenceContext(
            source,
            1200,
            [/PRIMARY_ONLY_HEAD/],
            'PRIMARY'
        );
        const stageEvidence = buildStageEvidenceContext('openSourceScan', '', source);

        assert.doesNotMatch(truncatedPrimary, /UNIQUE_OPEN_SOURCE_EVIDENCE/);
        assert.match(stageEvidence, /UNIQUE_OPEN_SOURCE_EVIDENCE/);
        assert.match(stageEvidence, /weights will be released after acceptance/);
    });

    it('低字符预算仍覆盖全文开头、中部和结尾', () => {
        const { buildTaskEvidenceContext } = require('../scripts/deep-analyzer.js');
        const source = `HEAD${'a'.repeat(4500)}MIDDLE${'b'.repeat(4500)}TAIL`;
        const context = buildTaskEvidenceContext(source, 1200, [], 'LOW_BUDGET');
        assert.ok(context.length <= 1200);
        assert.match(context, /HEAD/);
        assert.match(context, /MIDDLE/);
        assert.match(context, /TAIL/);
    });

    it('局部修复上下文只携带该任务需要的分析章节且不冒充评分账本', () => {
        const { buildTypeAwareSourceContext } = require('../scripts/deep-analyzer.js');
        const context = buildTypeAwareSourceContext(
            validAnalysisText(),
            `METHOD_SOURCE ${'方法架构与训练流程。'.repeat(3000)}`,
            30000,
            [/方法|架构|训练/],
            'METHOD'
        );
        assert.match(context, /METHOD 阶段的确定性任务证据/);
        assert.match(context, /\[A_METHOD\]/);
        assert.doesNotMatch(context, /\[A_RESULTS\]/);
        assert.doesNotMatch(context, /确定性评分证据账本/);
    });

    it('输入规模摘要不把图片 base64 计入文本 token 估算', () => {
        const { summarizeModelInput } = require('../scripts/deep-analyzer.js');
        const summary = summarizeModelInput([{
            role: 'user',
            content: [
                { type: 'text', text: '一段文本' },
                { type: 'image', source: { data: 'x'.repeat(10000) } }
            ]
        }]);
        assert.strictEqual(summary.textChars, 4);
        assert.strictEqual(summary.images, 1);
        assert.strictEqual(summary.estimatedTextTokens, 2);
    });

    it('demo 发现的资源链接追加到开源详情且同步资源字段', () => {
        const { updateOpensourceFromDemoLinks } = require('../scripts/deep-analyzer.js');
        const analysis = `## 机器摘要
has_code: 否
has_model: 否
has_dataset: 否

## 开源详情
- Demo：https://example.com/demo
- 复现材料：论文中未提及`;
        const updated = updateOpensourceFromDemoLinks(analysis, [
            'https://github.com/example/project',
            'https://huggingface.co/example/model'
        ]);
        assert.match(updated, /Demo：https:\/\/example\.com\/demo/);
        assert.match(updated, /复现材料：论文中未提及/);
        assert.match(updated, /github\.com\/example\/project/);
        assert.match(updated, /has_code: 是/);
        assert.match(updated, /has_model: 是/);
    });

    it('开源扫描同步结构化资源字段且不用缺失行覆盖旧值', () => {
        const { syncResourceFieldsFromOpenSource } = require('../scripts/deep-analyzer.js');
        const analysis = `## 机器摘要
has_code: 否
has_model: 是
has_dataset: 否

## 开源详情
旧内容`;
        const updated = syncResourceFieldsFromOpenSource(analysis, `## 开源详情
- 代码：https://github.com/example/project
- 数据集：论文中未提及`);

        assert.match(updated, /has_code: 是/);
        assert.match(updated, /has_model: 是/);
        assert.match(updated, /has_dataset: 未说明/);
    });

    it('最终章节契约拒绝额外标题和顺序变化', () => {
        const {
            REQUIRED_ANALYSIS_SECTIONS,
            validateTopLevelSectionContract
        } = require('../scripts/analysis-contract.js');
        const valid = REQUIRED_ANALYSIS_SECTIONS.map(title => `## ${title}\n内容`).join('\n\n');
        assert.strictEqual(validateTopLevelSectionContract(valid), null);
        assert.match(validateTopLevelSectionContract(`${valid}\n\n## 附录\n内容`), /额外一级章节/);
        const swapped = [...REQUIRED_ANALYSIS_SECTIONS];
        [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
        assert.match(validateTopLevelSectionContract(swapped.map(title => `## ${title}\n内容`).join('\n\n')), /顺序非法/);
    });

    it('结构预修复忽略待评分审计修正的总分差异', () => {
        const { getRepairableAnalysisStructureIssues } = require('../scripts/deep-analyzer.js');
        const mismatched = validAnalysisText().replace('6.9/10', '9.9/10');
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(mismatched), []);
    });

    it('结构预修复会在评分前拒绝核心摘要占位符和过短正文', () => {
        const { getRepairableAnalysisStructureIssues } = require('../scripts/deep-analyzer.js');
        const placeholder = validAnalysisText().replace(
            /## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
            '## 核心摘要\nTD\n'
        );

        assert.deepStrictEqual(
            getRepairableAnalysisStructureIssues(placeholder).filter(issue => issue.startsWith('核心摘要内容不足')),
            ['核心摘要内容不足: 2/80 字符']
        );
    });

    it('结构预修复会在评分前接管模型编辑和自检批注泄漏', () => {
        const { getRepairableAnalysisStructureIssues } = require('../scripts/deep-analyzer.js');
        const contaminated = validAnalysisText().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。\n\n这里我补充了协议不一致，并加入了严格限定。'
        );

        assert.match(
            getRepairableAnalysisStructureIssues(contaminated)
                .find(issue => issue.startsWith('模型编辑/自检批注:')),
            /编辑\/自检批注泄漏/
        );
    });

    it('结构预修复不把正常论文叙述当成模型自检批注', () => {
        const { getRepairableAnalysisStructureIssues } = require('../scripts/deep-analyzer.js');
        const legitimate = validAnalysisText().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。这里的 score 用于衡量完整序列一致性；作者在附录中修正了拼写错误并补充实验。已有分析方法依赖静态特征，本文则建模动态轨迹。'
        );

        assert.strictEqual(
            getRepairableAnalysisStructureIssues(legitimate)
                .some(issue => issue.startsWith('模型编辑/自检批注:')),
            false
        );
    });

    it('结构修复持续输出编辑批注时以 contract rejected 终止', async () => {
        const {
            repairMissingAnalysisSections,
            recoveryFailureStatus
        } = require('../scripts/deep-analyzer.js');
        const contaminated = validAnalysisText().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。现在需要生成最终文本。'
        );
        let calls = 0;
        let failure;
        try {
            await repairMissingAnalysisSections(
                { arxivId: '2608.13817', title: 'Leaked analysis' },
                contaminated,
                '完整论文证据',
                '结构修复证据',
                {
                    callModelFn: async () => {
                        calls += 1;
                        return contaminated;
                    }
                }
            );
        } catch (error) {
            failure = error;
        }

        assert.strictEqual(calls, 2);
        assert.strictEqual(failure?.code, 'CONTRACT_REJECTED');
        assert.match(failure?.message || '', /最终结构修复失败.*编辑\/自检批注/);
        assert.strictEqual(recoveryFailureStatus(failure), 'contract_rejected');
    });

    it('方法兜底新增同一行编辑批注时拒绝完成，并可从失败 checkpoint 跨次恢复', async () => {
        const {
            finalizeStructureRepairOutput,
            recoveryFailureStatus,
            saveAnalysisCheckpoint,
            createAnalysisRecoveryManifest,
            prepareTextRecoveryStage,
            isRecoveryStageComplete,
            getRepairableAnalysisStructureIssues
        } = require('../scripts/deep-analyzer.js');
        const paragraph = `输入首先经过模型模块与网络结构处理，随后沿流程进入多个阶段并产生输出。${'方法细节用于说明组件连接关系。'.repeat(12)}`;
        const detailed = validAnalysisText().replace(
            /## 方法概述和架构\n[\s\S]*?\n\n## 核心创新点/,
            `## 方法概述和架构\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n## 核心创新点`
        );
        const contaminated = detailed.replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。现在需要生成最终文本。'
        );
        let failure;
        try {
            await finalizeStructureRepairOutput(
                { arxivId: '2608.13817', title: 'Leaked fallback' },
                validAnalysisText(),
                '完整论文证据',
                { fixMethodSection: async () => contaminated }
            );
        } catch (error) {
            failure = error;
        }
        assert.strictEqual(failure?.code, 'CONTRACT_REJECTED');
        assert.match(failure?.message || '', /最终方法兜底后的分析仍未通过结构契约.*编辑\/自检批注/);

        const paper = {
            analysisStageCheckpoints: { methodRepair: validAnalysisText() }
        };
        const manifest = {
            version: 1,
            stages: {
                methodRepair: { status: 'not_needed', fingerprint: 'method-v1' },
                structureRepair: {
                    status: recoveryFailureStatus(failure),
                    error: failure.message
                },
                scoringAudit: { status: 'complete', fingerprint: 'must-be-removed' }
            }
        };
        // 与生产 catch 一致：Promise 拒绝时调用方仍持有方法兜底前正文，
        // 但 structureRepair 必须保存为非终态，下一次才能重新执行兜底。
        saveAnalysisCheckpoint(paper, validAnalysisText(), manifest);

        const resumedManifest = createAnalysisRecoveryManifest(paper);
        assert.strictEqual(isRecoveryStageComplete(resumedManifest, 'structureRepair'), false);
        assert.strictEqual(resumedManifest.stages.scoringAudit, undefined);
        const prepared = prepareTextRecoveryStage(
            paper,
            resumedManifest,
            'structureRepair',
            paper.analysisCheckpoint,
            '完整论文证据'
        );
        assert.strictEqual(prepared.analysis, validAnalysisText());
        const finalized = await finalizeStructureRepairOutput(
            { arxivId: '2608.13817', title: 'Recovered analysis' },
            prepared.analysis,
            '完整论文证据',
            { fixMethodSection: async () => detailed }
        );
        assert.doesNotMatch(finalized.analysis, /现在需要生成最终文本/);
        assert.match(finalized.analysis, /方法细节用于说明组件连接关系/);
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(finalized.analysis), []);
    });

    it('结构预修复会在评分前收敛超限实验表格', () => {
        const { getRepairableAnalysisStructureIssues } = require('../scripts/deep-analyzer.js');
        const rows = Array.from({ length: 13 }, (_, index) => `| Model ${index + 1} | ${index} |`).join('\n');
        const oversized = validAnalysisText().replace(
            '\n## 细节详述',
            `\n\n| 方法 | WER |\n| --- | --- |\n${rows}\n\n## 细节详述`
        );
        assert.deepStrictEqual(
            getRepairableAnalysisStructureIssues(oversized)
                .filter(issue => issue.startsWith('实验表格:')),
            ['实验表格: 实验结果第 1 张表包含 13 个数据行，最多允许 12 行']
        );
    });

    it('确定性规范化额外标题、机器摘要杂项和破损标签', () => {
        const {
            normalizeAnalysisStructure,
            getRepairableAnalysisStructureIssues,
            parseAnalysis
        } = require('../scripts/deep-analyzer.js');
        const {
            validateMachineSummaryContract,
            validateTagSectionContract,
            validateTopLevelSectionContract
        } = require('../scripts/analysis-contract.js');
        let malformed = validAnalysisText()
            .replace('6.9/10', '9.9/10')
            .replace('has_dataset: 否', 'has_dataset: 否\ntotal_score: 9.9\n#语音识别 #Transformer #鲁棒性')
            .replace(/\n## 标签\n[\s\S]*?(?=\n## 作者与机构)/, '')
            .replace('## 实验结果\n', '## 实验结果\n## # 表 I：对比结果\n')
            .replace('## 细节详述\n', '## 关键结论\n结果总结。\n\n## 细节详述\n');

        const normalized = normalizeAnalysisStructure(malformed);
        const parsed = parseAnalysis(normalized);
        assert.strictEqual(validateTopLevelSectionContract(normalized), null);
        assert.strictEqual(validateMachineSummaryContract(normalized, parsed, { checkScoringConsistency: false }), null);
        assert.strictEqual(validateTagSectionContract(normalized, parsed), null);
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(normalized), []);
        assert.match(normalized, /### 表 I：对比结果/);
        assert.match(normalized, /### 关键结论/);
        assert.doesNotMatch(normalized, /total_score:/);
    });

    it('确定性规范化为双标签补足白名单补充标签', () => {
        const {
            normalizeAnalysisStructure,
            getRepairableAnalysisStructureIssues,
            parseAnalysis
        } = require('../scripts/deep-analyzer.js');
        const { validateTagSectionContract } = require('../scripts/analysis-contract.js');
        const malformed = validAnalysisText()
            .replace('primary_task_tag: #语音识别', 'primary_task_tag: #音频伪造检测')
            .replace('primary_method_tag: #Transformer', 'primary_method_tag: #CNN')
            .replace(
                /## 标签\n[\s\S]*?(?=\n## 作者与机构)/,
                '## 标签\n#音频伪造检测 #CNN\n主任务标签: #音频伪造检测\n主方法标签: #CNN\n补充标签:\n'
            );

        const normalized = normalizeAnalysisStructure(malformed);
        const parsed = parseAnalysis(normalized);
        assert.match(normalized, /#音频伪造检测 #CNN #模型评估/);
        assert.strictEqual(validateTagSectionContract(normalized, parsed), null);
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(normalized), []);
    });

    it('确定性规范化为空文档类型和空标签推断安全兜底', () => {
        const {
            normalizeAnalysisStructure,
            getRepairableAnalysisStructureIssues,
            parseAnalysis
        } = require('../scripts/deep-analyzer.js');
        const {
            validateMachineSummaryContract,
            validateTagSectionContract
        } = require('../scripts/analysis-contract.js');
        const malformed = validAnalysisText()
            .replaceAll('Transformer', '音频语言模型')
            .replace('document_type: 方法研究', 'document_type: ')
            .replace('primary_task_tag: #语音识别', 'primary_task_tag: ')
            .replace('primary_method_tag: #Transformer', 'primary_method_tag: ')
            .replace(
                /## 标签\n[\s\S]*?(?=\n## 作者与机构)/,
                '## 标签\n主任务标签:\n主方法标签:\n补充标签:\n'
            )
            .replace('## 核心摘要\n', '## 核心摘要\n本文审计音频语言模型是否使用副语言情感证据。\n');

        const normalized = normalizeAnalysisStructure(malformed);
        const parsed = parseAnalysis(normalized);
        assert.match(normalized, /document_type: (?:方法研究|数据集与基准|理论研究|综述|模型报告|系统技术报告)/);
        assert.notStrictEqual(parsed.documentType, '');
        assert.match(normalized, /primary_task_tag: #语音情感识别/);
        assert.match(normalized, /primary_method_tag: #大语言模型/);
        assert.strictEqual(validateMachineSummaryContract(normalized, parsed, { checkScoringConsistency: false }), null);
        assert.strictEqual(validateTagSectionContract(normalized, parsed), null);
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(normalized), []);
    });

    it('确定性规范化用评分理由覆盖非法的机器摘要开源分', () => {
        const {
            normalizeAnalysisStructure,
            getRepairableAnalysisStructureIssues,
            parseAnalysis
        } = require('../scripts/deep-analyzer.js');
        const { validateMachineSummaryContract } = require('../scripts/analysis-contract.js');
        const malformed = validAnalysisText().replace('open_source: 0.2', 'open_source: 0.7');

        const normalized = normalizeAnalysisStructure(malformed);
        const parsed = parseAnalysis(normalized);
        assert.match(normalized, /open_source: 0\.0/);
        assert.doesNotMatch(normalized, /open_source: 0\.7/);
        assert.strictEqual(validateMachineSummaryContract(normalized, parsed, { checkScoringConsistency: false }), null);
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(normalized), []);
    });

    it('确定性规范化为缺失的机器摘要开源分补安全零值', () => {
        const {
            normalizeAnalysisStructure,
            getRepairableAnalysisStructureIssues,
            parseAnalysis
        } = require('../scripts/deep-analyzer.js');
        const { validateMachineSummaryContract } = require('../scripts/analysis-contract.js');
        const malformed = validAnalysisText().replace(/^open_source: 0\.2\n/m, '');
        const normalized = normalizeAnalysisStructure(malformed);
        const parsed = parseAnalysis(normalized);
        assert.match(normalized, /open_source: 0\.0/);
        assert.strictEqual(validateMachineSummaryContract(normalized, parsed, { checkScoringConsistency: false }), null);
        assert.deepStrictEqual(getRepairableAnalysisStructureIssues(normalized), []);
    });

    it('确定性规范化机器摘要中的受限枚举和越界数值', () => {
        const {
            normalizeAnalysisStructure,
            getRepairableAnalysisStructureIssues,
            parseAnalysis
        } = require('../scripts/deep-analyzer.js');
        const { validateMachineSummaryContract } = require('../scripts/analysis-contract.js');
        const malformed = validAnalysisText()
            .replace('document_type: 方法研究', 'document_type: 白皮书')
            .replace('confidence: 高', 'confidence: 中等')
            .replace('sota_claim: 否', 'sota_claim: 未明确声称达到 SOTA')
            .replace('has_code: 否', 'has_code: 尚未开源')
            .replace('has_model: 否', 'has_model: 未知')
            .replace('has_dataset: 否', 'has_dataset: 提供数据下载')
            .replace('open_source: 0.2', 'open_source: 7.8');

        const normalized = normalizeAnalysisStructure(malformed);
        const parsed = parseAnalysis(normalized);
        assert.match(normalized, /document_type: 系统技术报告/);
        assert.match(normalized, /confidence:\s*$/m);
        assert.match(normalized, /sota_claim: 未说明/);
        assert.match(normalized, /has_code: 未说明/);
        assert.match(normalized, /has_model: 未说明/);
        assert.match(normalized, /has_dataset: 是/);
        assert.match(normalized, /open_source: 0\.0/);
        assert.match(
            validateMachineSummaryContract(normalized, parsed, { checkScoringConsistency: false }),
            /confidence/
        );
        assert.ok(getRepairableAnalysisStructureIssues(normalized).length > 0);
    });

    it('最终评分审计会按已有资源状态确定性归一化开源分和总分', () => {
        const {
            parseScoringAuditResult,
            validateScoringAuditAgainstAnalysis
        } = require('../scripts/deep-analyzer.js');
        const reason = '该维度根据已有分析中的具体证据独立判断，不重复使用其他维度的扣分事实。';
        const payload = {
            documentType: '系统技术报告',
            confidence: '中',
            dimensions: {
                innovation: { score: 1, reason },
                technicalRigor: { score: 1, reason },
                experimentalSufficiency: { score: 1, reason },
                clarity: { score: 0.8, reason },
                impact: { score: 0.5, reason },
                openSource: { score: 0.5, reason: '论文只提供在线演示页面，没有发布任何核心代码、模型权重或训练数据资源。' },
                reproducibility: { score: 0.1, reason },
                engineering: { score: 1.2, reason }
            }
        };
        const audit = parseScoringAuditResult(JSON.stringify(payload));
        const analysis = `## 评分\n5.0/10\n\n## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n仅提供在线演示 Demo：https://example.com/demo`;
        const normalized = validateScoringAuditAgainstAnalysis(analysis, audit);
        assert.strictEqual(normalized.dimensions.openSource.score, 0.2);
        assert.match(normalized.dimensions.openSource.reason, /只提供可访问的在线演示页面/);
        assert.strictEqual(normalized.total, 5.8);

        const negativeAnalysis = `## 评分\n5.0/10\n\n## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\nDemo：论文中未提及；作者未承诺开源。`;
        const negativeNormalized = validateScoringAuditAgainstAnalysis(negativeAnalysis, audit);
        assert.strictEqual(negativeNormalized.dimensions.openSource.score, 0);
        assert.match(negativeNormalized.dimensions.openSource.reason, /未给出明确的后续开源承诺/);
        assert.strictEqual(negativeNormalized.total, 5.6);
    });

    it('空开源章节仍生成 A_OPEN 账本并通过归一化后的二次校验', () => {
        const {
            buildTypeAwareSourceContext,
            validateScoringAuditAgainstAnalysis,
            revalidateScoringAudit
        } = require('../scripts/deep-analyzer.js');
        const analysis = `## 机器摘要
document_type: 系统技术报告
has_code: 否
has_model: 否
has_dataset: 否

## 方法概述和架构
论文使用多阶段声学编码与语义融合流程。

## 开源详情
`;
        const context = buildTypeAwareSourceContext(analysis, 'short source evidence');
        const allowed = new Set([...context.matchAll(/^\[([A-Z][A-Z0-9_/-]*)\]/gm)].map(match => match[1]));
        assert.match(context, /\[A_OPEN\]/);
        assert.match(context, /has_code=否/);
        assert.ok(allowed.has('A_OPEN'));
        assert.doesNotMatch(context, /\[A_SUMMARY\]/);

        const reason = '[A_METHOD] 该维度仅根据带编号的方法证据账本进行独立判断。';
        const audit = {
            documentType: '系统技术报告',
            confidence: '中',
            dimensions: {
                innovation: { score: 1.0, reason },
                technicalRigor: { score: 1.0, reason },
                experimentalSufficiency: { score: 1.0, reason },
                clarity: { score: 0.8, reason },
                impact: { score: 1.0, reason },
                openSource: { score: 0.5, reason },
                reproducibility: { score: 0.3, reason },
                engineering: { score: 1.0, reason }
            }
        };
        const normalized = validateScoringAuditAgainstAnalysis(analysis, audit);
        assert.strictEqual(normalized.dimensions.openSource.score, 0);
        assert.doesNotThrow(() => revalidateScoringAudit(normalized, allowed));
    });

    it('开源状态不会把否定语境误判为 Demo 或未来开源承诺', () => {
        const {
            hasAffirmativeDemoEvidence,
            hasAffirmativeReleasePromise
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(hasAffirmativeDemoEvidence('Demo：论文中未提及'), false);
        assert.strictEqual(hasAffirmativeDemoEvidence('未提供在线演示'), false);
        assert.strictEqual(hasAffirmativeDemoEvidence('No demo is available.'), false);
        assert.strictEqual(hasAffirmativeDemoEvidence('Demo unavailable: https://example.com/demo'), false);
        assert.strictEqual(hasAffirmativeDemoEvidence('论文提到了 demo 概念，但没有链接'), false);
        assert.strictEqual(hasAffirmativeDemoEvidence('在线演示：https://example.com/demo'), true);
        assert.strictEqual(hasAffirmativeDemoEvidence('demo_available: true'), true);
        assert.strictEqual(hasAffirmativeReleasePromise('论文未承诺开源'), false);
        assert.strictEqual(hasAffirmativeReleasePromise('没有明确的后续开源计划'), false);
        assert.strictEqual(hasAffirmativeReleasePromise('作者承诺未来将开放模型权重'), true);
    });

    it('demo 页面安全检查会拒绝本机和私网地址', async () => {
        const {
            isPrivateIpAddress,
            validatePublicHttpUrl,
            requestPinnedPublicHttps
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(isPrivateIpAddress('127.0.0.1'), true);
        assert.strictEqual(isPrivateIpAddress('10.0.0.8'), true);
        assert.strictEqual(isPrivateIpAddress('100.64.1.1'), true);
        assert.strictEqual(isPrivateIpAddress('172.16.1.1'), true);
        assert.strictEqual(isPrivateIpAddress('192.168.1.1'), true);
        assert.strictEqual(isPrivateIpAddress('::ffff:7f00:1'), true);
        assert.strictEqual(isPrivateIpAddress('::ffff:127.0.0.1'), true);
        assert.strictEqual(isPrivateIpAddress('fe90::1'), true);
        assert.strictEqual(isPrivateIpAddress('ff02::1'), true);
        assert.strictEqual(isPrivateIpAddress('2001:db8::1'), true);
        assert.strictEqual(isPrivateIpAddress('fec0::1'), true);
        assert.strictEqual(isPrivateIpAddress('::7f00:1'), true);
        assert.strictEqual(isPrivateIpAddress('::127.0.0.1'), true);
        assert.strictEqual(isPrivateIpAddress('::ffff:8.8.8.8'), true);
        assert.strictEqual(isPrivateIpAddress('64:ff9b::7f00:1'), true);
        assert.strictEqual(isPrivateIpAddress('2002:7f00:1::'), true);
        assert.strictEqual(isPrivateIpAddress('2001:2::1'), true);
        assert.strictEqual(isPrivateIpAddress('3fff::1'), true);
        assert.strictEqual(isPrivateIpAddress('2001:4860:4860::8888'), false);
        assert.strictEqual(isPrivateIpAddress('2606:4700:4700::1111'), false);
        assert.strictEqual(isPrivateIpAddress('198.18.0.1'), true);
        assert.strictEqual(isPrivateIpAddress('192.0.2.1'), true);
        assert.strictEqual(isPrivateIpAddress('203.0.113.1'), true);
        assert.strictEqual(isPrivateIpAddress('8.8.8.8'), false);
        const publicIpUrl = await validatePublicHttpUrl('https://8.8.8.8/demo');
        assert.strictEqual(publicIpUrl.validatedAddress, '8.8.8.8');
        const publicIpv6Url = await validatePublicHttpUrl('https://[2001:4860:4860::8888]/demo');
        assert.strictEqual(publicIpv6Url.validatedAddress, '2001:4860:4860::8888');
        assert.strictEqual(publicIpv6Url.validatedHostname, '2001:4860:4860::8888');
        await assert.rejects(() => validatePublicHttpUrl('https://[fec0::1]/demo'), /非公网/);
        await assert.rejects(() => validatePublicHttpUrl('http://127.0.0.1/demo'), /非公网|localhost/);
        await assert.rejects(() => validatePublicHttpUrl('file:///tmp/demo.html'), /协议/);
        await assert.rejects(() => validatePublicHttpUrl('https://user:pass@example.com'), /用户名/);
        await assert.rejects(() => requestPinnedPublicHttps('http://8.8.8.8/demo'), /只允许 HTTPS/);
    });

    it('提取 Demo URL 时截断全角括号后的中文说明，避免生成伪 punycode 主机名', () => {
        const { extractDemoUrls } = require('../scripts/deep-analyzer.js');
        const urls = extractDemoUrls('Demo：https://relative-fx.github.io（提供音频示例）');
        assert.deepStrictEqual(urls, ['https://relative-fx.github.io']);
    });

    it('副模型的 replacement 被代码忽略，主模型原文和评分不被重写', () => {
        const {
            parseImageInsertionPlan,
            applyImageInsertionPlan
        } = require('../scripts/deep-analyzer.js');

        const analysis = `## 评分
8.0/10

## 机器摘要
原始摘要。

## 核心摘要
主模型核心结论必须保留。

## 方法概述和架构
模型先做声学编码，再做语义融合。

## 实验结果
实验结果显示低噪声场景更稳定。

## 评分理由
主模型评分理由必须保留。`;
        const images = [
            { url: 'https://arxiv.org/html/2607.1/arch.png', caption: 'Architecture diagram' },
            { url: 'https://arxiv.org/html/2607.1/logo.png', caption: 'logo' }
        ];
        const rawPlan = JSON.stringify({
            insertions: [
                {
                    image: 1,
                    section: '方法概述和架构',
                    anchor: '模型先做声学编码，再做语义融合。',
                    replacement: '模型改成先做文本编码，并删除原有结论。',
                    lead: '下图补充展示模型的声学编码与语义融合流程。',
                    explanation: '图中可以看到声学分支和语义分支在融合模块汇合，支持主模型对架构流程的描述。'
                },
                {
                    image: 2,
                    section: '评分理由',
                    lead: '不应该插入。',
                    explanation: '不应该修改评分理由。'
                }
            ]
        });

        const plans = parseImageInsertionPlan(rawPlan, images);
        const result = applyImageInsertionPlan(analysis, plans, images);

        assert.deepStrictEqual(result.selectedImageUrls, ['https://arxiv.org/html/2607.1/arch.png']);
        assert.match(result.analysis, /8\.0\/10/);
        assert.match(result.analysis, /主模型核心结论必须保留/);
        assert.match(result.analysis, /主模型评分理由必须保留/);
        assert.match(result.analysis, /模型先做声学编码，再做语义融合。/);
        assert.doesNotMatch(result.analysis, /模型改成先做文本编码/);
        assert.strictEqual(plans.diagnostics.replacementIgnored, 1);
        assert.match(result.analysis, /下图补充展示模型的声学编码与语义融合流程/);
        assert.match(result.analysis, /!\[Architecture diagram\]\(https:\/\/arxiv\.org\/html\/2607\.1\/arch\.png\)/);
        assert.doesNotMatch(result.analysis, /logo\.png/);
        assert.doesNotMatch(result.analysis, /不应该修改评分理由/);
    });

    it('候选编号不被当作论文原始 Figure 编号，精确 anchor 决定位置', () => {
        const {
            parseImageInsertionPlan,
            applyImageInsertionPlan
        } = require('../scripts/deep-analyzer.js');

        const analysis = `## 方法概述和架构
系统整体流程如图1所示。第一段先概括输入、编码和融合。

第二段详细解释训练协议。

第三段才是副模型给出的 anchor。`;
        const images = [
            { url: 'https://arxiv.org/html/2607.1/figure_4.jpg', caption: 'Figure 4: System overview' }
        ];
        const plans = parseImageInsertionPlan(JSON.stringify({
            insertions: [{
                image: 1,
                section: '方法概述和架构',
                anchor: '第三段才是副模型给出的 anchor。',
                lead: '图1展示系统整体流程。',
                explanation: '图中可以看到输入、编码和融合模块的连接关系。'
            }]
        }), images);

        const result = applyImageInsertionPlan(analysis, plans, images);

        assert.match(
            result.analysis,
            /第三段才是副模型给出的 anchor。\n\n图1展示系统整体流程。\n\n!\[Figure 4: System overview\]\(https:\/\/arxiv\.org\/html\/2607\.1\/figure_4\.jpg\)/
        );
        assert.match(result.analysis, /第二段详细解释训练协议。/);
        assert.strictEqual(result.insertionDiagnostics[0].anchorMatched, true);
        assert.strictEqual(result.insertionDiagnostics[0].fallbackToSectionEnd, false);
    });

    it('副模型可用稳定 paragraph_id 定位，不依赖自由文本 anchor', () => {
        const { parseImageInsertionPlan, applyImageInsertionPlan, buildImageAnchorCatalog } = require('../scripts/deep-analyzer.js');
        const analysis = `## 方法概述和架构\n第一段。\n\n第二段用于插图。\n\n## 实验结果\n结果段。`;
        const catalog = buildImageAnchorCatalog(analysis);
        const target = catalog.find(item => item.text === '第二段用于插图。');
        const images = [{ url: 'https://example.com/method.png', caption: 'Method overview' }];
        const plans = parseImageInsertionPlan(JSON.stringify({ insertions: [{
            image: 1,
            section: '方法概述和架构',
            paragraph_id: target.id,
            lead: '下图展示方法流程。'
        }] }), images);
        const result = applyImageInsertionPlan(analysis, plans, images);
        assert.strictEqual(result.insertionDiagnostics[0].paragraphId, target.id);
        assert.strictEqual(result.insertionDiagnostics[0].inserted, true);
        assert.match(result.analysis, /第二段用于插图。\n\n下图展示方法流程。/);
    });

    it('单段章节找不到空行时会在段落末尾插图，不会截断句子', () => {
        const { parseImageInsertionPlan, applyImageInsertionPlan } = require('../scripts/deep-analyzer.js');
        const analysis = `## 方法概述和架构\n开头锚点。后半句仍属于同一个段落，必须保持连续。`;
        const images = [{ url: 'https://example.com/method.png', caption: 'Method' }];
        const plans = parseImageInsertionPlan(JSON.stringify({ insertions: [{
            image: 1,
            section: '方法概述和架构',
            anchor: '开头锚点。',
            lead: '下图展示方法。'
        }] }), images);
        const result = applyImageInsertionPlan(analysis, plans, images);

        assert.match(result.analysis, /开头锚点。后半句仍属于同一个段落，必须保持连续。\n\n下图展示方法。/);
        assert.strictEqual(result.insertionDiagnostics[0].anchorMatched, true);
    });

    it('计划解析区分 invalid_json、empty_plan 和 all_items_rejected', () => {
        const { parseImageInsertionPlanDetailed } = require('../scripts/deep-analyzer.js');
        const images = [{ url: 'https://example.com/a.png', caption: '' }];

        assert.strictEqual(parseImageInsertionPlanDetailed('not json', images).diagnostics.status, 'invalid_json');
        assert.strictEqual(parseImageInsertionPlanDetailed('{}', images).diagnostics.status, 'invalid_schema');
        assert.strictEqual(parseImageInsertionPlanDetailed('{"insertions":null}', images).diagnostics.status, 'invalid_schema');
        assert.strictEqual(parseImageInsertionPlanDetailed('{"insertions":[],"note":"extra"}', images).diagnostics.status, 'invalid_schema');
        assert.strictEqual(parseImageInsertionPlanDetailed('[]', images).diagnostics.status, 'invalid_schema');
        assert.strictEqual(parseImageInsertionPlanDetailed('{"insertions":[]}', images).diagnostics.status, 'empty_plan');
        const rejected = parseImageInsertionPlanDetailed('{"insertions":[{"image":2,"section":"评分理由","lead":"x"}]}', images);
        assert.strictEqual(rejected.diagnostics.status, 'all_items_rejected');
        assert.strictEqual(rejected.diagnostics.rejectedItems, 1);
    });

    it('成功 manifest 没有 checkpoint 时会清空主分析及全部下游状态', () => {
        const { createAnalysisRecoveryManifest } = require('../scripts/deep-analyzer.js');
        const manifest = createAnalysisRecoveryManifest({
            analysisManifest: {
                version: 1,
                stages: {
                    imageDownload: { status: 'complete' },
                    primaryAnalysis: { status: 'complete' },
                    revision: { status: 'complete' },
                    scoringAudit: { status: 'complete' },
                    imageSupplement: { status: 'complete' }
                }
            }
        });

        assert.strictEqual(manifest.stages.imageDownload.status, 'complete');
        assert.strictEqual(manifest.stages.primaryAnalysis, undefined);
        assert.strictEqual(manifest.stages.revision, undefined);
        assert.strictEqual(manifest.stages.scoringAudit, undefined);
        assert.strictEqual(manifest.stages.imageSupplement, undefined);
    });

    it('阶段指纹变化时回退到前一阶段快照，只失效当前及下游', () => {
        const {
            invalidateRecoveryStageIfChanged,
            saveAnalysisCheckpoint
        } = require('../scripts/deep-analyzer.js');
        const paper = {};
        const manifest = { version: 1, stages: {} };
        const stages = ['primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision', 'tableRepair'];
        for (const stage of stages) {
            manifest.stages[stage] = { status: 'complete', fingerprint: `old-${stage}` };
            saveAnalysisCheckpoint(paper, `body-after-${stage}`, manifest);
        }
        // saveAnalysisCheckpoint 会在阶段首次达到终态时保留快照。
        paper.analysisStageCheckpoints.demoLinkScan = 'body-after-demo';
        paper.analysisStageCheckpoints.revision = 'body-after-revision';
        const changed = invalidateRecoveryStageIfChanged(paper, manifest, 'revision', 'new-revision');
        assert.strictEqual(changed, true);
        assert.strictEqual(paper.analysisCheckpoint, 'body-after-demo');
        assert.strictEqual(manifest.stages.demoLinkScan.status, 'complete');
        assert.strictEqual(manifest.stages.revision, undefined);
        assert.strictEqual(manifest.stages.tableRepair, undefined);
        assert.strictEqual(paper.analysisStageCheckpoints.revision, undefined);
    });

    it('主分析指纹会绑定实际输入文本和论文元数据', () => {
        const { buildRecoveryFingerprints } = require('../scripts/deep-analyzer.js');
        const base = { title: 'A', authors: ['X'], categories: ['cs.SD'] };
        const first = buildRecoveryFingerprints(base, 'actual input one', '2607.1');
        const textChanged = buildRecoveryFingerprints(base, 'actual input two', '2607.1');
        const metadataChanged = buildRecoveryFingerprints({ ...base, title: 'B' }, 'actual input one', '2607.1');
        assert.notStrictEqual(first.primaryAnalysis, textChanged.primaryAnalysis);
        assert.notStrictEqual(first.primaryAnalysis, metadataChanged.primaryAnalysis);
    });

    it('后处理阶段指纹绑定实际证据并按恢复顺序回退到前序快照', () => {
        const {
            buildStageEvidenceContext,
            buildTextStageFingerprint,
            prepareTextRecoveryStage
        } = require('../scripts/deep-analyzer.js');
        const inputAnalysis = 'body-after-demo';
        const oldEvidence = buildStageEvidenceContext('revision', inputAnalysis, 'old source evidence');
        const oldFingerprint = buildTextStageFingerprint('revision', inputAnalysis, oldEvidence);
        const paper = {
            analysisCheckpoint: 'body-after-table',
            analysisStageCheckpoints: {
                demoLinkScan: inputAnalysis,
                revision: 'body-after-revision',
                tableRepair: 'body-after-table'
            }
        };
        const manifest = { version: 1, stages: {
            demoLinkScan: { status: 'complete', fingerprint: 'demo-v1' },
            revision: { status: 'complete', fingerprint: oldFingerprint },
            tableRepair: { status: 'complete', fingerprint: 'table-v1' }
        } };

        const prepared = prepareTextRecoveryStage(
            paper,
            manifest,
            'revision',
            paper.analysisCheckpoint,
            'new source evidence with changed experiment facts'
        );

        assert.strictEqual(prepared.invalidated, true);
        assert.strictEqual(prepared.analysis, inputAnalysis);
        assert.strictEqual(paper.analysisCheckpoint, inputAnalysis);
        assert.strictEqual(manifest.stages.demoLinkScan.status, 'complete');
        assert.strictEqual(manifest.stages.revision, undefined);
        assert.strictEqual(manifest.stages.tableRepair, undefined);
        assert.notStrictEqual(prepared.fingerprint, oldFingerprint);
        assert.strictEqual(
            prepared.fingerprint,
            buildTextStageFingerprint('revision', inputAnalysis, prepared.evidenceContext)
        );
    });

    it('旧结构 checkpoint 会因新增编辑泄漏契约失效并回退到可修复正文', () => {
        const {
            prepareTextRecoveryStage,
            getRepairableAnalysisStructureIssues
        } = require('../scripts/deep-analyzer.js');
        const contaminated = validAnalysisText().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。\n\n现在需要生成最终文本。'
        );
        const paper = {
            analysisCheckpoint: 'body-after-scoring',
            analysisStageCheckpoints: {
                methodRepair: contaminated,
                structureRepair: contaminated,
                scoringAudit: 'body-after-scoring'
            }
        };
        const manifest = {
            version: 1,
            contracts: {
                experimentTables: 'bounded-v1',
                methodDetail: 'detailed-v1'
            },
            stages: {
                methodRepair: { status: 'not_needed', fingerprint: 'method-v1' },
                structureRepair: { status: 'complete', fingerprint: 'legacy-without-editorial-contract' },
                scoringAudit: { status: 'complete', fingerprint: 'scoring-v1' }
            }
        };

        const prepared = prepareTextRecoveryStage(
            paper,
            manifest,
            'structureRepair',
            paper.analysisCheckpoint,
            '完整论文证据'
        );

        assert.strictEqual(prepared.invalidated, true);
        assert.strictEqual(prepared.analysis, contaminated);
        assert.strictEqual(paper.analysisCheckpoint, contaminated);
        assert.strictEqual(manifest.stages.structureRepair, undefined);
        assert.strictEqual(manifest.stages.scoringAudit, undefined);
        assert.strictEqual(manifest.contracts, undefined);
        assert.ok(
            getRepairableAnalysisStructureIssues(prepared.analysis)
                .some(issue => issue.startsWith('模型编辑/自检批注:'))
        );
    });

    it('来源或实际截断输入变化时均失效主链', () => {
        const { hasActualAnalysisInputChanged } = require('../scripts/deep-analyzer.js');
        const usedTextSha256 = 'used-input-sha';
        assert.strictEqual(hasActualAnalysisInputChanged(
            { sourceSha256: 'raw-v1', usedTextSha256 },
            { sourceSha256: 'raw-v2', usedTextSha256 }
        ), true);
        assert.strictEqual(hasActualAnalysisInputChanged(
            { sourceSha256: 'raw-v1', usedTextSha256 },
            { sourceSha256: 'raw-v2', usedTextSha256: 'changed-input-sha' }
        ), true);
        assert.strictEqual(hasActualAnalysisInputChanged(
            { sourceSha256: 'raw-v1', usedTextSha256, sourceId: 'v1', analysisSource: 'html' },
            { sourceSha256: 'raw-v1', usedTextSha256, sourceId: 'v1', analysisSource: 'html' }
        ), false);
    });

    it('已有全文 checkpoint 时临时抓取失败不会降级清空', () => {
        const { shouldRetainFullTextCheckpoint } = require('../scripts/deep-analyzer.js');
        assert.strictEqual(shouldRetainFullTextCheckpoint(
            { analysisCheckpoint: 'full-text body' },
            { fullTextAvailable: true, usedTextSha256: 'full' },
            false,
            new Error('temporary 503')
        ), true);
        assert.strictEqual(shouldRetainFullTextCheckpoint(
            { analysisCheckpoint: 'abstract body' },
            { fullTextAvailable: false },
            false,
            new Error('temporary 503')
        ), false);
    });

    it('区分 arXiv 永久缺失与瞬时失败，并把 Demo 5xx/限流标为可重试', () => {
        const {
            classifyArxivSourceFailure,
            isTransientDemoHttpStatus
        } = require('../scripts/deep-analyzer.js');
        assert.strictEqual(classifyArxivSourceFailure('permanent_miss', false), 'permanent');
        assert.strictEqual(classifyArxivSourceFailure('transient_failure', false), 'transient');
        assert.strictEqual(classifyArxivSourceFailure('permanent_miss', true), 'transient');
        assert.strictEqual(isTransientDemoHttpStatus(429), true);
        assert.strictEqual(isTransientDemoHttpStatus(503), true);
        assert.strictEqual(isTransientDemoHttpStatus(404), false);
    });

    it('正文来源变化会清除绑定旧来源的图片恢复状态', () => {
        const { invalidateSourceBoundImageRecovery } = require('../scripts/deep-analyzer.js');
        const paper = {
            analysisRecoveryImageManifest: { downloaded: [{ url: 'https://old.example/a.png' }] },
            imageManifest: { selected: ['https://old.example/a.png'] },
            selectedImageUrls: ['https://old.example/a.png'],
            imageUrls: ['https://old.example/a.png'],
            allImageUrls: ['https://old.example/a.png']
        };
        invalidateSourceBoundImageRecovery(paper);
        assert.strictEqual(paper.analysisRecoveryImageManifest, undefined);
        assert.strictEqual(paper.imageManifest, undefined);
        assert.strictEqual(paper.selectedImageUrls, undefined);
        assert.strictEqual(paper.imageUrls, undefined);
        assert.strictEqual(paper.allImageUrls, undefined);
    });

    it('插图补充破坏正文契约时保留审计后的纯文本并丢弃整份插图计划', () => {
        const { discardInvalidImageSupplement } = require('../scripts/deep-analyzer.js');
        const manifest = { selected: ['https://old.example/a.png'] };
        const fallback = discardInvalidImageSupplement(
            validAnalysisText(),
            manifest,
            {
                supplementDiagnostics: { model: 'secondary' },
                parseDiagnostics: { status: 'ok' }
            },
            '评分契约无效'
        );
        assert.strictEqual(fallback.analysis, validAnalysisText());
        assert.deepStrictEqual(fallback.selectedImageUrls, []);
        assert.deepStrictEqual(manifest.selected, []);
        assert.strictEqual(manifest.supplement.discardedInvalidPlan, true);
        assert.strictEqual(manifest.supplement.discardedReason, '评分契约无效');
    });

    it('首次评分审计以审计输入正文计算前后分差', () => {
        const { calculateScoringDelta } = require('../scripts/deep-analyzer.js');
        const input = validAnalysisText();
        const result = calculateScoringDelta(undefined, input, '7.8');
        assert.strictEqual(result.previousScore, 6.9);
        assert.strictEqual(result.finalScore, 7.8);
        assert.strictEqual(result.scoreDelta, 0.9);
        const rerun = calculateScoringDelta('5.0', input, '7.8');
        assert.strictEqual(rerun.previousRunScore, 5.0);
        assert.strictEqual(rerun.previousScore, 6.9);
        assert.strictEqual(rerun.scoreDelta, 0.9);
    });

    it('插图指纹绑定候选、下载内容和评分后正文且只影响插图阶段', () => {
        const {
            buildImageSupplementFingerprint,
            invalidateRecoveryStageIfChanged
        } = require('../scripts/deep-analyzer.js');
        const base = 'image-config';
        const candidates = [{ url: 'https://example.com/a.png', caption: 'A' }];
        const downloads = [{ url: candidates[0].url, sha256: 'download-v1' }];
        const first = buildImageSupplementFingerprint(base, candidates, downloads, 'audited body');
        assert.notStrictEqual(first, buildImageSupplementFingerprint(
            base,
            [{ url: 'https://example.com/b.png', caption: 'B' }],
            downloads,
            'audited body'
        ));
        assert.notStrictEqual(first, buildImageSupplementFingerprint(
            base,
            candidates,
            [{ url: candidates[0].url, sha256: 'download-v2' }],
            'audited body'
        ));
        assert.notStrictEqual(first, buildImageSupplementFingerprint(base, candidates, downloads, 'changed body'));

        const paper = {
            analysisCheckpoint: 'body with old images',
            analysisStageCheckpoints: {
                scoringAudit: 'audited body',
                imageSupplement: 'body with old images'
            }
        };
        const manifest = { version: 1, stages: {
            scoringAudit: { status: 'complete', fingerprint: 'scoring' },
            imageSupplement: { status: 'complete', fingerprint: first }
        } };
        assert.strictEqual(invalidateRecoveryStageIfChanged(paper, manifest, 'imageSupplement', 'new-image-fingerprint'), true);
        assert.strictEqual(manifest.stages.scoringAudit.status, 'complete');
        assert.strictEqual(manifest.stages.imageSupplement, undefined);
        assert.strictEqual(paper.analysisCheckpoint, 'audited body');
    });

    it('评分证据使用 structureRepair 快照而不是评分后 checkpoint', () => {
        const { buildTypeAwareSourceContext } = require('../scripts/deep-analyzer.js');
        const crypto = require('node:crypto');
        const structureBody = validAnalysisText();
        const postScoringBody = structureBody.replace('这篇论文围绕语音识别鲁棒性提出完整方法', '评分后意外改变了核心摘要');
        const source = 'source evidence';
        const storedEvidence = crypto.createHash('sha256')
            .update(buildTypeAwareSourceContext(structureBody, source))
            .digest('hex');
        const resumedEvidence = crypto.createHash('sha256')
            .update(buildTypeAwareSourceContext(structureBody, source))
            .digest('hex');
        const wrongEvidence = crypto.createHash('sha256')
            .update(buildTypeAwareSourceContext(postScoringBody, source))
            .digest('hex');
        assert.strictEqual(resumedEvidence, storedEvidence);
        assert.notStrictEqual(wrongEvidence, storedEvidence);
    });

    it('理论研究的开源分不会因缺少代码模型数据字段被强制归零', () => {
        const { validateScoringAuditAgainstAnalysis } = require('../scripts/deep-analyzer.js');
        const audit = {
            documentType: '理论研究',
            confidence: '高',
            dimensions: {
                innovation: { score: 1, reason: '创新理由足够具体并且能够通过结构校验要求。' },
                technicalRigor: { score: 1, reason: '严谨性理由足够具体并且能够通过结构校验要求。' },
                experimentalSufficiency: { score: 1, reason: '证据理由足够具体并且能够通过结构校验要求。' },
                clarity: { score: 1, reason: '清晰度理由足够具体并且能够通过结构校验要求。' },
                impact: { score: 1, reason: '影响力理由足够具体并且能够通过结构校验要求。' },
                openSource: { score: 1.2, reason: '完整证明已在论文正文和附录中公开，但文档导航仍不完整。' },
                reproducibility: { score: 0.3, reason: '复现理由足够具体并且能够通过结构校验要求。' },
                engineering: { score: 0, reason: '该工作是纯理论研究，没有宣称工程落地或部署价值。' }
            },
            total: 6.5,
            rankBucket: '前50%'
        };
        const analysis = '## 机器摘要\ndocument_type: 理论研究\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n完整证明见正文与附录。';

        assert.strictEqual(validateScoringAuditAgainstAnalysis(analysis, audit), audit);
    });

    it('caption 写入 Markdown alt 前会转义方括号、反斜杠和换行', () => {
        const {
            parseImageInsertionPlan,
            applyImageInsertionPlan,
            sanitizeLogField,
            sanitizeMarkdownImageAlt
        } = require('../scripts/deep-analyzer.js');
        const analysis = '## 实验结果\n结果正文。';
        const caption = String.raw`A [B] \ C` + '\nsecond line';
        const images = [{ url: 'https://example.com/result.png', caption }];
        const plans = parseImageInsertionPlan('{"insertions":[{"image":1,"section":"实验结果","anchor":"结果正文。","lead":"结果图。"}]}', images);
        const result = applyImageInsertionPlan(analysis, plans, images);

        assert.strictEqual(sanitizeMarkdownImageAlt(caption, ''), String.raw`A \[B\] \\ C second line`);
        assert.match(result.analysis, /result\.png/);
        assert.deepStrictEqual(result.selectedImageUrls, ['https://example.com/result.png']);
        assert.strictEqual(sanitizeLogField('first\nsecond\u0000third', 100), 'first second third');
    });

    it('通用图片 alt 和已选 URL 按最终正文出现顺序编号', () => {
        const { parseImageInsertionPlan, applyImageInsertionPlan } = require('../scripts/deep-analyzer.js');
        const analysis = `## 方法概述和架构
方法正文。

## 实验结果
实验正文。`;
        const images = [
            { url: 'https://example.com/result.png', caption: '' },
            { url: 'https://example.com/method.png', caption: '' }
        ];
        const plans = parseImageInsertionPlan(JSON.stringify({ insertions: [
            { image: 1, section: '实验结果', anchor: '实验正文。', lead: '结果图。', explanation: '结果说明内容足够。' },
            { image: 2, section: '方法概述和架构', anchor: '方法正文。', lead: '方法图。', explanation: '方法说明内容足够。' }
        ] }), images);
        const result = applyImageInsertionPlan(analysis, plans, images);

        assert.match(result.analysis, /!\[图1\]\(https:\/\/example\.com\/method\.png\)/);
        assert.match(result.analysis, /!\[图2\]\(https:\/\/example\.com\/result\.png\)/);
        assert.deepStrictEqual(result.selectedImageUrls, [
            'https://example.com/method.png',
            'https://example.com/result.png'
        ]);
    });

    it('插图计划拒绝空锚点、错锚点和超过上限的图片', () => {
        const { parseImageInsertionPlan, applyImageInsertionPlan } = require('../scripts/deep-analyzer.js');
        const analysis = '## 实验结果\n锚点一。\n\n锚点二。\n\n锚点三。\n\n锚点四。\n\n锚点五。';
        const images = Array.from({ length: 7 }, (_, index) => ({
            url: `https://example.com/${index + 1}.png`,
            caption: `Figure ${index + 1}`
        }));
        const raw = JSON.stringify({ insertions: [
            { image: 1, section: '实验结果', anchor: '', lead: '空锚点。' },
            { image: 2, section: '实验结果', anchor: '正文中不存在。', lead: '错锚点。' },
            ...[1, 2, 3, 4, 5].map((number, index) => ({
                image: index + 3,
                section: '实验结果',
                anchor: `锚点${['一', '二', '三', '四', '五'][index]}。`,
                lead: `有效图${number}。`
            }))
        ] });

        const result = applyImageInsertionPlan(analysis, parseImageInsertionPlan(raw, images), images, 4);
        assert.strictEqual(result.selectedImageUrls.length, 4);
        assert.deepStrictEqual(
            result.insertionDiagnostics.map(item => item.rejectionReason || 'inserted'),
            ['anchor_required', 'anchor_not_found', 'inserted', 'inserted', 'inserted', 'inserted', 'insertion_limit']
        );
        assert.doesNotMatch(result.analysis, /\/1\.png|\/2\.png|\/7\.png/);
    });

    it('兼容预提供图片 URL 字符串和对象数组', () => {
        const {
            normalizeImageInfos,
            getPreProvidedImageUrls
        } = require('../scripts/deep-analyzer.js');

        assert.deepStrictEqual(normalizeImageInfos([
            'https://example.com/a.png',
            { url: 'https://example.com/b.png', caption: 'Architecture figure' },
            { url: 'https://example.com/c.png', alt: 'Spectrogram' },
            null
        ]), [
            { url: 'https://example.com/a.png', caption: '' },
            { url: 'https://example.com/b.png', caption: 'Architecture figure' },
            { url: 'https://example.com/c.png', caption: 'Spectrogram' }
        ]);
        assert.deepStrictEqual(getPreProvidedImageUrls({
            allImageUrls: [],
            imageUrls: ['https://example.com/fallback.png']
        }), [{ url: 'https://example.com/fallback.png', caption: '' }]);
        assert.deepStrictEqual(getPreProvidedImageUrls({
            allImageUrls: ['https://example.com/primary.png'],
            imageUrls: ['https://example.com/fallback.png']
        }), [
            { url: 'https://example.com/primary.png', caption: '' },
            { url: 'https://example.com/fallback.png', caption: '' }
        ]);
        assert.deepStrictEqual(getPreProvidedImageUrls({
            imageManifest: { candidates: [{ url: 'https://example.com/primary.png', caption: 'Restored caption' }] },
            allImageUrls: ['https://example.com/primary.png', 'https://example.com/fallback.png']
        }), [
            { url: 'https://example.com/primary.png', caption: 'Restored caption' },
            { url: 'https://example.com/fallback.png', caption: '' }
        ]);
    });

    it('识别原文中的表格证据', () => {
        const {
            sourceTextLikelyHasTables
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(sourceTextLikelyHasTables('Table 1: WER comparison'), true);
        assert.strictEqual(sourceTextLikelyHasTables('Tbl. IV reports the ablation'), true);
        assert.strictEqual(sourceTextLikelyHasTables('表2 展示不同模型结果'), true);
        assert.strictEqual(sourceTextLikelyHasTables('\\begin{tabular}{lll}'), true);
        assert.strictEqual(sourceTextLikelyHasTables('No quantitative table is provided.'), false);
    });

    it('只在分析明确缺表或使用省略标记时触发表格补写', () => {
        const {
            analysisNeedsExperimentTableRepair
        } = require('../scripts/deep-analyzer.js');
        const proseOnly = [
            '## 实验结果',
            '主方法 WER 为 5.1，最强基线为 5.6。',
            '',
            '## 细节详述',
            '细节。'
        ].join('\n');
        assert.strictEqual(
            analysisNeedsExperimentTableRepair(proseOnly, 'Table 1: WER comparison'),
            false
        );

        const citedMissing = proseOnly.replace(
            '主方法 WER 为 5.1，最强基线为 5.6。',
            '如表1所示，主方法更好。'
        );
        assert.strictEqual(
            analysisNeedsExperimentTableRepair(citedMissing, 'Table 1: WER comparison'),
            true
        );

        for (const reference of ['Table 1', 'Table IV', 'Tbl. S2', '表（3）']) {
            const englishOrChineseCitation = proseOnly.replace(
                '主方法 WER 为 5.1，最强基线为 5.6。',
                `As shown in ${reference}, the proposed method is better.`
            );
            assert.strictEqual(
                analysisNeedsExperimentTableRepair(
                    englishOrChineseCitation,
                    `${reference}: WER comparison`
                ),
                true,
                `${reference} should trigger table repair`
            );
        }

        const compactTable = proseOnly.replace(
            '主方法 WER 为 5.1，最强基线为 5.6。',
            '表中保留主方法与最强基线。\n\n| 方法 | WER |\n| --- | --- |\n| Ours | 5.1 |'
        );
        assert.strictEqual(
            analysisNeedsExperimentTableRepair(compactTable, 'Table 1: WER comparison'),
            false
        );

        const omission = proseOnly.replace(
            '主方法 WER 为 5.1，最强基线为 5.6。',
            '表格详见原文。'
        );
        assert.strictEqual(
            analysisNeedsExperimentTableRepair(omission, 'Table 1: WER comparison'),
            true
        );
    });

    it('统一识别论文 ID 字段', () => {
        const {
            getPaperArxivId
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(getPaperArxivId({ arxivId: '2604.1' }), '2604.1');
        assert.strictEqual(getPaperArxivId({ paper_id: '2604.2' }), '2604.2');
        assert.strictEqual(getPaperArxivId({ id: 'openreview-1' }), 'openreview-1');
    });

    it('arXiv HTML URL 尝试顺序不会重复拼接版本号', () => {
        const {
            getArxivHtmlIds
        } = require('../scripts/deep-analyzer.js');

        assert.deepStrictEqual(getArxivHtmlIds('2604.12345'), ['2604.12345', '2604.12345v2', '2604.12345v1']);
        assert.deepStrictEqual(getArxivHtmlIds('2604.12345v2'), ['2604.12345v2']);
    });
});

describe('open-source evidence request safety', () => {
    it('removes LaTeX backslashes that break double-decoding JSON gateways', () => {
        const { sanitizeOpenSourceEvidence } = require('../scripts/deep-analyzer.js');
        const source = String.raw`\underline{x} and \mathbf{G}` + '\uD835';
        const sanitized = sanitizeOpenSourceEvidence(source);
        assert.strictEqual(sanitized, '⧵underline{x} and ⧵mathbf{G}�');
        assert.doesNotMatch(sanitized, /\\/);
        assert.doesNotMatch(sanitized, /[\u0000-\u001F\u007F]/);
    });

    it('cleans invalid text characters while preserving prompt LaTeX and image payloads', () => {
        const { sanitizeModelMessages } = require('../scripts/deep-analyzer.js');
        const messages = sanitizeModelMessages([{ role: 'user', content: [
            { type: 'text', text: String.raw`formula \underline{x}` + '\uD835' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
        ] }]);
        assert.strictEqual(messages[0].content[0].text, String.raw`formula \underline{x}` + '�');
        assert.strictEqual(messages[0].content[1].image_url.url, 'data:image/png;base64,abc');
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(messages)));
    });

    it('can opt into backslash sanitization for isolated evidence blocks', () => {
        const { sanitizeModelMessages } = require('../scripts/deep-analyzer.js');
        const messages = sanitizeModelMessages([
            { role: 'user', content: String.raw`evidence \underline{x}` }
        ], { replaceBackslashes: true });
        assert.strictEqual(messages[0].content, 'evidence ⧵underline{x}');
    });
});

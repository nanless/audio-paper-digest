const { describe, it, before } = require('node:test');
const assert = require('node:assert');

before(() => {
    process.env.PAPER_ANALYZER_ENDPOINT = process.env.PAPER_ANALYZER_ENDPOINT || 'https://api.openai.com/v1';
    process.env.PAPER_ANALYZER_API_KEY = process.env.PAPER_ANALYZER_API_KEY || 'test-key';
    process.env.PAPER_ANALYZER_MODEL = process.env.PAPER_ANALYZER_MODEL || 'gpt-4o-mini';
});

describe('deep-analyzer section helpers', () => {
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
            { url: 'https://example.com/results.png', caption: 'Ablation results on benchmarks' }
        ], 3);

        assert.deepStrictEqual(selected.map(x => x.url), [
            'https://example.com/architecture.png',
            'https://example.com/spectrogram.png',
            'https://example.com/results.png'
        ]);
    });

    it('过滤副模型不稳定的内联图片和 SVG，并截断日志标签', () => {
        const {
            isSupportedImageUrl,
            safeImageLabel,
            normalizeImageInfos
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(isSupportedImageUrl('data:image/svg+xml;base64,PHN2Zy8+'), false);
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

    it('gap-fill 前缀清理不会误命中评分理由标题', () => {
        const {
            cleanGapFillPrefix
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(cleanGapFillPrefix('废话\n## 评分理由\n理由'), null);
        assert.strictEqual(cleanGapFillPrefix('废话\n## 评分\n8.0/10\n\n## 评分理由\n理由'), '## 评分\n8.0/10\n\n## 评分理由\n理由');
    });

    it('校验副模型输出是否保留必要章节', () => {
        const {
            hasRequiredAnalysisSections
        } = require('../scripts/deep-analyzer.js');

        const full = [
            '评分', '机器摘要', '标签', '作者与机构', '毒舌点评', '核心摘要',
            '方法概述和架构', '核心创新点', '实验结果', '细节详述',
            '评分理由', '局限与问题', '开源详情'
        ].map(title => `## ${title}\n内容`).join('\n\n');

        assert.strictEqual(hasRequiredAnalysisSections(full), true);
        assert.strictEqual(hasRequiredAnalysisSections('## 评分\n8.0/10\n\n## 实验结果\n结果'), false);
    });

    it('兼容预提供图片 URL 字符串和对象数组', () => {
        const {
            normalizeImageInfos
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
    });

    it('识别原文中的表格证据', () => {
        const {
            sourceTextLikelyHasTables
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(sourceTextLikelyHasTables('Table 1: WER comparison'), true);
        assert.strictEqual(sourceTextLikelyHasTables('表2 展示不同模型结果'), true);
        assert.strictEqual(sourceTextLikelyHasTables('\\begin{tabular}{lll}'), true);
        assert.strictEqual(sourceTextLikelyHasTables('No quantitative table is provided.'), false);
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

        assert.deepStrictEqual(getArxivHtmlIds('2604.12345'), ['2604.12345v1', '2604.12345v2', '2604.12345']);
        assert.deepStrictEqual(getArxivHtmlIds('2604.12345v2'), ['2604.12345v2', '2604.12345']);
    });
});

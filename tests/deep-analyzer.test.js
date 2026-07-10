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
        assert.throws(() => parseScoringAuditResult('{"documentType":"方法研究","confidence":"高","dimensions":{}}'), /缺少维度/);
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
        assert.throws(() => parseScoringAuditResult(JSON.stringify(payload)), /其他维度/);
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
    });

    it('demo 页面安全检查会拒绝本机和私网地址', async () => {
        const {
            isPrivateIpAddress,
            validatePublicHttpUrl
        } = require('../scripts/deep-analyzer.js');

        assert.strictEqual(isPrivateIpAddress('127.0.0.1'), true);
        assert.strictEqual(isPrivateIpAddress('10.0.0.8'), true);
        assert.strictEqual(isPrivateIpAddress('100.64.1.1'), true);
        assert.strictEqual(isPrivateIpAddress('172.16.1.1'), true);
        assert.strictEqual(isPrivateIpAddress('192.168.1.1'), true);
        assert.strictEqual(isPrivateIpAddress('::ffff:7f00:1'), true);
        assert.strictEqual(isPrivateIpAddress('8.8.8.8'), false);
        const publicIpUrl = await validatePublicHttpUrl('https://8.8.8.8/demo');
        assert.strictEqual(publicIpUrl.validatedAddress, '8.8.8.8');
        await assert.rejects(() => validatePublicHttpUrl('http://127.0.0.1/demo'), /非公网|localhost/);
        await assert.rejects(() => validatePublicHttpUrl('file:///tmp/demo.html'), /协议/);
        await assert.rejects(() => validatePublicHttpUrl('https://user:pass@example.com'), /用户名/);
    });

    it('副模型只输出插图计划，主模型原文和评分不被重写', () => {
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
                    replacement: '模型先做声学编码，再做语义融合；下图展示这两个阶段的连接方式。',
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
        assert.match(result.analysis, /下图展示这两个阶段的连接方式。\n\n下图补充展示模型的声学编码与语义融合流程/);
        assert.match(result.analysis, /下图补充展示模型的声学编码与语义融合流程/);
        assert.match(result.analysis, /!\[Architecture diagram\]\(https:\/\/arxiv\.org\/html\/2607\.1\/arch\.png\)/);
        assert.doesNotMatch(result.analysis, /logo\.png/);
        assert.doesNotMatch(result.analysis, /不应该修改评分理由/);
    });

    it('正文已提到图号时优先把图片插到首次提及的段落后', () => {
        const {
            parseImageInsertionPlan,
            applyImageInsertionPlan
        } = require('../scripts/deep-analyzer.js');

        const analysis = `## 方法概述和架构
系统整体流程如图1所示。第一段先概括输入、编码和融合。

第二段详细解释训练协议。

第三段才是副模型给出的 anchor。`;
        const images = [
            { url: 'https://arxiv.org/html/2607.1/figure_1.jpg', caption: '图1' }
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
            /系统整体流程如图1所示。第一段先概括输入、编码和融合。\n\n图1展示系统整体流程。\n\n!\[图1\]\(https:\/\/arxiv\.org\/html\/2607\.1\/figure_1\.jpg\)/
        );
        assert.match(result.analysis, /第二段详细解释训练协议。/);
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
            { image: 1, section: '实验结果', lead: '结果图。', explanation: '结果说明内容足够。' },
            { image: 2, section: '方法概述和架构', lead: '方法图。', explanation: '方法说明内容足够。' }
        ] }), images);
        const result = applyImageInsertionPlan(analysis, plans, images);

        assert.match(result.analysis, /!\[图1\]\(https:\/\/example\.com\/method\.png\)/);
        assert.match(result.analysis, /!\[图2\]\(https:\/\/example\.com\/result\.png\)/);
        assert.deepStrictEqual(result.selectedImageUrls, [
            'https://example.com/method.png',
            'https://example.com/result.png'
        ]);
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
        }), ['https://example.com/fallback.png']);
        assert.deepStrictEqual(getPreProvidedImageUrls({
            allImageUrls: ['https://example.com/primary.png'],
            imageUrls: ['https://example.com/fallback.png']
        }), ['https://example.com/primary.png']);
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

        assert.deepStrictEqual(getArxivHtmlIds('2604.12345'), ['2604.12345', '2604.12345v2', '2604.12345v1']);
        assert.deepStrictEqual(getArxivHtmlIds('2604.12345v2'), ['2604.12345v2', '2604.12345']);
    });
});

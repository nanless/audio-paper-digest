const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    mergeAndSaveResults,
    analyzeBatch,
    analyzePaperWithRetry,
    getInvalidAnalysisReason
} = require('../scripts/analysis-engine.js');

function validAnalysisText() {
    return `## 评分
7.7/10

## 机器摘要
rank_bucket: 前25%
innovation: 1.5/2
technical_rigor: 1.2/1.5
experimental_sufficiency: 1.1/1.5
clarity: 0.8/1
impact: 1.0/1.5
open_source: 0/1.5
reproducibility: 0.3/0.5
engineering_score: 1.0/1.5
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #Transformer
主任务标签: #语音识别
主方法标签: #Transformer

## 作者与机构
作者信息未说明。

## 毒舌点评
这项工作有明确问题设定，但亮点不算夸张。

## 核心摘要
这篇论文围绕语音识别场景提出改进方法，核心目标是提升复杂声学条件下的稳定性。方法通过编码器、上下文建模和解码模块协同工作，并用多个基准验证效果。论文还讨论了低信噪比、跨说话人和不同录音条件下的表现，说明方法主要改善鲁棒性而不是单纯扩大模型规模。

## 方法概述和架构
方法包含输入特征提取、声学编码、上下文融合和输出解码四个阶段。音频首先被转换为声学特征，再送入 Transformer 编码器建模长程依赖，随后通过任务头输出识别结果。上下文模块把局部帧级信息与更长时间跨度的语义提示结合，用于减少噪声片段对解码路径的干扰，整体结构清楚且和常见 ASR pipeline 兼容。

## 核心创新点
第一，论文把上下文建模显式加入声学编码流程。第二，实验设计覆盖了主要噪声条件。第三，方法结构相对清晰，便于后续复现。

## 实验结果
实验在多个语音识别数据集上比较 WER，结果显示该方法在低信噪比场景下优于基线。论文给出了关键指标，并报告了消融实验。消融部分比较了去掉上下文模块、只保留声学编码器和完整模型三种设置，说明主要收益来自上下文融合设计。

## 细节详述
训练细节包括数据处理、模型训练策略和推理设置。部分超参数在论文中未完整说明。

## 评分理由
创新性：1.5/2，有明确方法增量，虽然不是全新范式，但把上下文信息显式并入声学编码流程，针对噪声鲁棒性给出清楚设计。
技术严谨性：1.2/1.5，实验设置基本合理，训练和评测流程没有明显漏洞，但部分超参数和实现细节仍然可以更完整。
实验充分性：1.1/1.5，覆盖主要基准并提供消融实验，但跨域数据和真实远场场景还可以进一步扩展。
清晰度：0.8/1，结构描述清楚，模块关系和指标解释都比较直接，读者可以较快理解方法作用。
影响力：1.0/1.5，对语音识别读者有参考价值，尤其适合关注噪声鲁棒和上下文建模的研究者。
开源：0/1.5，未说明开源资源，因此代码、模型和数据可得性都不能确认。
可复现性：0.3/0.5，部分细节缺失，但主体 pipeline、评测任务和指标足以支撑粗粒度复现。
工程/实践价值：1.0/1.5，有一定部署参考价值，结构能接入常见 ASR 系统，但论文没有充分讨论延迟、吞吐和资源开销。

## 局限与问题
论文对极端噪声和跨域数据的讨论不足。

## 开源详情
未提及。`;
}

describe('mergeAndSaveResults', () => {
    it('不会用无 analysis 的失败结果覆盖已有成功结果', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-test-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-01-01T00:00:00.000+08:00',
            papers: [{
                arxivId: '2604.12345v1',
                title: 'Existing success',
                analysis: 'successful analysis',
                parsed: { score: '8.0' }
            }]
        }, null, 2));

        await mergeAndSaveResults([{
            arxivId: '2604.12345v2',
            title: 'Failed retry',
            analysis: null,
            parsed: null,
            error: 'failed'
        }], file);

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.papers.length, 1);
        assert.strictEqual(saved.papers[0].title, 'Existing success');
        assert.strictEqual(saved.papers[0].analysis, 'successful analysis');
        assert.deepStrictEqual(saved.papers[0].parsed, { score: '8.0' });
    });
});

describe('analyzePaperWithRetry', () => {
    it('完整分析通过校验并返回 parsed', async () => {
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00001', title: 'Valid' },
            {
                maxRetries: 0,
                analyzeFn: async () => ({ analysis: validAnalysisText() })
            }
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.error, null);
        assert.ok(result.result.parsed.score);
    });

    it('保留深度分析返回的 imageManifest', async () => {
        const imageManifest = {
            totalFound: 3,
            candidates: [{ url: 'https://example.com/architecture.png', score: 10 }],
            downloaded: [{ url: 'https://example.com/architecture.png', mime: 'image/png' }],
            selected: ['https://example.com/architecture.png']
        };
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00010', title: 'Valid with images' },
            {
                maxRetries: 0,
                analyzeFn: async () => ({
                    analysis: validAnalysisText(),
                    selectedImageUrls: imageManifest.selected,
                    allImageUrls: imageManifest.candidates.map(x => x.url),
                    imageManifest
                })
            }
        );

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.result.imageManifest, imageManifest);
    });

    it('缺少必要章节会重试后失败', async () => {
        let calls = 0;
        let retries = 0;
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00002', title: 'Invalid' },
            {
                maxRetries: 1,
                retryDelayMs: 0,
                analyzeFn: async () => {
                    calls++;
                    return { analysis: '## 评分\n8.0/10\n\n## 实验结果\n结果' };
                },
                onRetry: () => { retries++; }
            }
        );

        assert.strictEqual(calls, 2);
        assert.strictEqual(retries, 1);
        assert.strictEqual(result.success, false);
        assert.match(result.error, /缺少必要章节/);
    });

    it('校验会拒绝缺少核心字段的分析', () => {
        assert.strictEqual(getInvalidAnalysisReason(validAnalysisText(), require('../scripts/utils.js').parseAnalysis(validAnalysisText())), null);
        assert.match(getInvalidAnalysisReason('## 评分\n8.0/10', {}), /缺少必要章节/);
    });

    it('校验不会把 0 分误判为缺少评分', () => {
        const parsed = require('../scripts/utils.js').parseAnalysis(validAnalysisText());
        parsed.score = 0;
        assert.strictEqual(getInvalidAnalysisReason(validAnalysisText(), parsed), null);
    });
});

describe('analyzeBatch', () => {
    it('透传自定义 analyzeFn 到每篇论文分析', async () => {
        const calls = [];
        const { results, stats } = await analyzeBatch(
            [{ arxivId: '2604.00003', title: 'Custom analyzer' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async (paper) => {
                    calls.push(paper.arxivId);
                    return { analysis: validAnalysisText() };
                }
            }
        );

        assert.deepStrictEqual(calls, ['2604.00003']);
        assert.strictEqual(stats.success, 1);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].error, null);
    });

    it('shouldSkip 决策只对每篇论文计算一次', async () => {
        const calls = new Map();
        const papers = [
            { arxivId: '2604.00001v1', title: 'A' },
            { arxivId: '2604.00002v1', title: 'B' }
        ];

        const { stats } = await analyzeBatch(papers, {
            concurrency: 2,
            shouldSkip: (paper) => {
                calls.set(paper.arxivId, (calls.get(paper.arxivId) || 0) + 1);
                return true;
            }
        });

        assert.strictEqual(stats.skipped, 2);
        assert.strictEqual(calls.get('2604.00001v1'), 1);
        assert.strictEqual(calls.get('2604.00002v1'), 1);
    });
});

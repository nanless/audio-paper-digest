'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extrema = require('../scripts/lib/table-extrema-verifier.js');
const crossStage = require('../scripts/lib/cross-stage-consistency.js');
const repair = require('../scripts/lib/reader-repair.js');
const deep = require('../scripts/deep-analyzer.js');

const ROOT = path.resolve(__dirname, '..');

describe('Wave 12 Track 12.2: table-extrema-verifier.js', () => {
    it('infers audio & ML metric polarities with explicit header arrow precedence', () => {
        assert.equal(extrema.inferMetricPolarity('WER (%)'), 'down');
        assert.equal(extrema.inferMetricPolarity('RTF'), 'down');
        assert.equal(extrema.inferMetricPolarity('FAD (CLAP)'), 'down');
        assert.equal(extrema.inferMetricPolarity('LSD (dB)'), 'down');
        assert.equal(extrema.inferMetricPolarity('ViSQOL'), 'up');
        assert.equal(extrema.inferMetricPolarity('PESQ'), 'up');
        assert.equal(extrema.inferMetricPolarity('UTMOS'), 'up');
        assert.equal(extrema.inferMetricPolarity('SI-SDR (dB)'), 'up');
        assert.equal(extrema.inferMetricPolarity('T30 gap closure'), 'up');
        assert.equal(extrema.inferMetricPolarity('Predictive Closure Gap'), 'down');
        // Explicit header arrow always overrides dictionary defaults
        assert.equal(extrema.inferMetricPolarity('CustomMetric ↓'), 'down');
        assert.equal(extrema.inferMetricPolarity('CustomMetric ↑'), 'up');
        assert.equal(extrema.inferMetricPolarity('Split'), null);

        // P1-1 edge cases: case-sensitive PER/SECS, parenthesized metrics, reduction flip, FD-PESQ, SI-SDRi, descriptor cols
        assert.equal(extrema.inferMetricPolarity('Frames per second'), null);
        assert.equal(extrema.inferMetricPolarity('PER (%)'), 'down');
        assert.equal(extrema.inferMetricPolarity('Decode Time (secs)'), null);
        assert.equal(extrema.inferMetricPolarity('SECS'), 'up');
        assert.equal(extrema.inferMetricPolarity('1.5 kbps (ViSQOL)'), 'up');
        assert.equal(extrema.inferMetricPolarity('Low-Latency (PESQ)'), 'up');
        assert.equal(extrema.inferMetricPolarity('Packet Loss Concealment (PESQ)'), 'up');
        assert.equal(extrema.inferMetricPolarity('Error Correction (Acc)'), 'up');
        assert.equal(extrema.inferMetricPolarity('WER Reduction (%)'), 'up');
        assert.equal(extrema.inferMetricPolarity('Latency Reduction (%)'), 'up');
        assert.equal(extrema.inferMetricPolarity('FD-PESQ'), 'up');
        assert.equal(extrema.inferMetricPolarity('FD-SI-SDR'), 'up');
        assert.equal(extrema.inferMetricPolarity('SI-SDRi'), 'up');
        assert.equal(extrema.inferMetricPolarity('Params'), null);
        assert.equal(extrema.inferMetricPolarity('Bitrate (kbps)'), null);
        assert.equal(extrema.inferMetricPolarity('Params ↓'), 'down');

        // P1-2 numeric cell parsing: bold+dagger, underline, multi-comma, +/- uncertainty, scientific notation, unit scale
        assert.equal(extrema.parseTableNumericCell('**3.91**†'), 3.91);
        assert.equal(extrema.parseTableNumericCell('<u>3.75</u>*'), 3.75);
        assert.equal(extrema.parseTableNumericCell('1,200,000'), 1200000);
        assert.equal(extrema.parseTableNumericCell('4.28 +/- 0.13'), 4.28);
        assert.equal(extrema.parseTableNumericCell('1.2e-3'), 0.0012);
        assert.equal(extrema.parseTableNumericCellDetailed('45 ms').comparable, 0.045);
        assert.equal(extrema.parseTableNumericCellDetailed('1.2 s').comparable, 1.2);
    });

    it('detects standard column extrema contradictions and direction inversions', () => {
        const article = [
            '### 主实验结果对比',
            '',
            '下面汇总各声学编解码器在 LibriSpeech 上的质量对比。',
            '',
            '| Model | test-clean ViSQOL ↑ | test-clean WER ↓ | RTF ↓ |',
            '| --- | ---: | ---: | ---: |',
            '| GT | 4.95 | 1.10 | 0.001 |',
            '| DAC | 3.91 | 4.80 | 0.031 |',
            '| EnCodec | 3.55 | 5.40 | 0.024 |',
            '| Ours | 3.75 | 3.10 | 0.012 |',
            '',
            '结果显示 Ours 在 test-clean ViSQOL 上达到全表最优的 3.75。此外 DAC 的 WER 4.80 也是全表最低。'
        ].join('\n');

        const issues = extrema.findTableExtremaIssues(article);
        assert.equal(issues.length, 2);
        assert.equal(issues[0].code, 'table_extrema_contradiction');
        assert.equal(issues[0].claimedValue, 3.75);
        assert.equal(issues[0].bestValue, 3.91);
        assert.equal(issues[0].bestRow, 'DAC');
        assert.equal(issues[1].code, 'table_extrema_contradiction');
        assert.equal(issues[1].claimedValue, 4.8);
        assert.equal(issues[1].bestValue, 3.1);
        assert.equal(issues[1].bestRow, 'Ours');

        // Direction inversion check: claiming highest WER is optimal
        const invertedArticle = [
            '### 主实验结果对比',
            '',
            '| Model | WER ↓ | PESQ ↑ |',
            '| --- | ---: | ---: |',
            '| Base | 5.2 | 3.1 |',
            '| Ours | 3.4 | 3.8 |',
            '',
            'Base 的 WER 最高且表现最优。'
        ].join('\n');
        const invIssues = extrema.findTableExtremaIssues(invertedArticle);
        assert.equal(invIssues.length, 1);
        assert.equal(invIssues[0].code, 'metric_polarity_inverted');
    });

    it('detects extrema contradictions in transposed benchmark tables (51.5 亦最优 pattern)', () => {
        const transposed = [
            '### 多模态基准评测',
            '',
            '| Benchmark | Qwen3-Omni | Gemini-3.0-Flash | Ours-2B |',
            '| --- | ---: | ---: | ---: |',
            '| ODU-Bench | 64.2 | 61.8 | 51.5 |',
            '| MMAU | 72.1 | 74.0 | 75.6 |',
            '',
            'Ours-2B 在 ODU-Bench 上以 51.5 取得最高分。'
        ].join('\n');
        const issues = extrema.findTableExtremaIssues(transposed);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, 'table_extrema_contradiction');
        assert.equal(issues[0].claimedValue, 51.5);
        assert.equal(issues[0].bestValue, 64.2);
        assert.equal(issues[0].bestRow, 'Qwen3-Omni');
    });

    it('avoids false positives on GT/Oracle reference rows, grouped splits, qualified/negated claims, comparison pairs, and Best-named metrics', () => {
        const safeArticle = [
            '### 多场景实验结果',
            '',
            '| Set | Method | SI-SDR ↑ | Best F1 ↑ | SA-WER ↓ |',
            '| --- | --- | ---: | ---: | ---: |',
            '| Clean | Ground Truth | 28.0 | 0.99 | 1.0 |',
            '| Clean | Base | 12.1 | 0.82 | 15.2 |',
            '| Clean | Ours | 15.4 | 0.85 | 13.1 |',
            '| Clean | SFT oracle@8 | 16.0 | 0.88 | 12.0 |',
            '| Noisy | Base | 8.2 | 0.71 | 22.0 |',
            '| Noisy | Ours | 10.6 | 0.78 | 18.5 |',
            '',
            '在 Clean 划分上 Ours 的 SI-SDR 达到最优的 15.4（排除 GT 与 oracle），在 Noisy 上 Ours 的 SI-SDR 达到最优的 10.6。',
            'Base 的 SI-SDR 12.1 并非最优，而是次优；在开源基线中 Base 的 0.82 表现最优。',
            '表中 Ours 的 SA-WER 最优（13.1 对 Base 的 15.2），召回最高到 0.85 但 Base 的 Best F1 仍有 0.82，每段选最优的 Oracle@8 为 12.0，均超过最佳基线 15.2。'
        ].join('\n');
        const issues = extrema.findTableExtremaIssues(safeArticle);
        assert.deepEqual(issues, []);
    });

    it('fixes Round 1 P0-3 / P1-2 / P1-3 / P1-4 edge cases: exact numeric matching, multi-split clearance, unit-scaled latency, operating-point 最低, and fenced ### headings', () => {
        // P0-3a: Multi-split clearance when 3.75 IS optimal on test-other (even though beaten on test-clean)
        const multiSplit = [
            '### 跨划分结果',
            '',
            '| Model | test-clean ViSQOL ↑ | test-other ViSQOL ↑ |',
            '| --- | ---: | ---: |',
            '| DAC | **3.91**† | 3.40 |',
            '| Ours | 3.75 | 3.75 |',
            '',
            'Ours 的 ViSQOL 达到全表最优的 3.75。'
        ].join('\n');
        assert.deepEqual(extrema.findTableExtremaIssues(multiSplit), []);

        // P0-3b: Substring "3" in "3.75" must NOT bypass real WER contradiction (DAC=3.00 beats Ours=3.75!)
        const substringBypass = [
            '### 识别结果',
            '',
            '| Model | WER ↓ |',
            '| --- | ---: |',
            '| DAC | 3.00 |',
            '| Ours | 3.75 |',
            '',
            'Ours 的 WER 达到全表最低的 3.75。'
        ].join('\n');
        const subIssues = extrema.findTableExtremaIssues(substringBypass);
        assert.equal(subIssues.length, 1);
        assert.equal(subIssues[0].bestValue, 3);

        // P1-2: Unit-scaled latency (45 ms IS lower than 1.2 s!)
        const latencyScaled = [
            '### 延迟对比',
            '',
            '| Model | Latency ↓ |',
            '| --- | ---: |',
            '| Base | 1.2 s |',
            '| Ours | 45 ms |',
            '',
            'Ours 取得全表最低 Latency 45 ms。'
        ].join('\n');
        assert.deepEqual(extrema.findTableExtremaIssues(latencyScaled), []);

        // P1-3: Bare "最低" on operating point (1.5 kbps) must NEVER flip ViSQOL ↑ polarity
        const opPoint = [
            '### 码率工作点',
            '',
            '| Model | Bitrate (kbps) | ViSQOL ↑ |',
            '| --- | ---: | ---: |',
            '| DAC | 8.0 | 3.91 |',
            '| EnCodec | 1.5 | 3.55 |',
            '| Ours | 1.5 | 3.75 |',
            '',
            '在最低 1.5 kbps 码率下 Ours 的 ViSQOL 为 3.75。'
        ].join('\n');
        assert.deepEqual(extrema.findTableExtremaIssues(opPoint), []);

        // P1-4: Fenced code block containing "### helper comment" must NOT shift sectionIndex
        const fenced = [
            '### 方法概述',
            '',
            '```python',
            '### helper comment inside code block',
            'x = 1',
            '```',
            '',
            '### 实验结果',
            '',
            '| Model | ViSQOL ↑ |',
            '| --- | ---: |',
            '| DAC | **3.91**† |',
            '| Ours | 3.75 |',
            '',
            'Ours 的 ViSQOL 达到全表最优的 3.75。'
        ].join('\n');
        const fencedIssues = extrema.findTableExtremaIssues(fenced, [
            { kind: 'method_overview', heading: '方法概述', body: '' },
            { kind: 'result', heading: '实验结果', body: '' }
        ]);
        assert.equal(fencedIssues.length, 1);
        assert.equal(fencedIssues[0].sectionIndex, 1);

        // Round 2 regression guards: bolded uncertainty cell, glued non-unit scalar, incompatible unit family
        assert.equal(extrema.parseTableNumericCell('**4.28** ± 0.13'), 4.28);
        assert.equal(extrema.parseTableNumericCell('**3.91***'), 3.91);
        assert.equal(extrema.parseTableNumericCell('**3.91**<sup>†</sup>'), 3.91);
        assert.equal(extrema.parseTableNumericCell('10<sup>-3</sup>'), null);

        const gluedAndUnitMd = [
            '### 实验结果',
            '',
            '| Model | WER ↓ |',
            '| --- | ---: |',
            '| Base | 24 |',
            '| Ours | 12 |',
            '',
            '在 24bit 采样与 100h 训练数据下，该方案取得全表最低 WER。',
            '',
            '| Model | WER ↓ |',
            '| --- | ---: |',
            '| Base | 3.1% |',
            '| Ours | 2.0% |',
            '',
            '在 3.1 s 窗口下该方案取得全表最低 WER。',
            '',
            '| Model | MOS ↑ |',
            '| --- | ---: |',
            '| Base | 3.90 ± 0.12 |',
            '| Ours | **4.28** ± 0.13 |',
            '',
            'Base 的 MOS 为全表最高的 3.90。'
        ].join('\n');
        const r2Issues = extrema.findTableExtremaIssues(gluedAndUnitMd);
        assert.equal(r2Issues.length, 1);
        assert.equal(r2Issues[0].tableIndex, 3);
        assert.equal(r2Issues[0].bestValue, 4.28);
    });

    it('routes READER_TABLE_EXTREMA_CONTRADICTION strictly to /sections/<idx>/body in reader-repair.js', () => {
        const draft = {
            sections: [
                { kind: 'problem', heading: '流式音频编码为何在低比特率下出现高频重建失真', body: '低码率神经音频编解码器在流式传输中需要兼顾帧级重建清晰度与推理延迟，现有方案往往在残差量化层数受限时损失高频谐波细节，导致感知质量明显下降。'.repeat(2) },
                {
                    kind: 'result',
                    heading: '主实验结果与编解码质量对比',
                    body: '本节对比各主流音频编解码器在相同码率预算下的感知重建质量。\n\n| Model | ViSQOL ↑ |\n| --- | ---: |\n| DAC | 3.91 |\n| Ours | 3.75 |\n\nOurs 的 ViSQOL 达到全表最优的 3.75。'
                }
            ],
            tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['DAC 3.91 Ours 3.75'] }],
            figurePlacements: [],
            formulaBindings: [],
            conceptBridges: []
        };
        const article = draft.sections.map(s => `### ${s.heading}\n\n${s.body}`).join('\n\n');
        let caught = null;
        try {
            deep.validateApiReaderTableExtrema(article, draft.sections);
        } catch (err) {
            caught = err;
        }
        assert.ok(caught);
        assert.equal(caught.code, 'READER_TABLE_EXTREMA_CONTRADICTION');
        const collected = repair.collectDraftIssues(draft, caught);
        const targets = repair.buildRepairTargets(draft, collected);
        assert.deepEqual(targets.map(t => t.path), ['/sections/1/body']);
    });
});

describe('Wave 12 Track 12.2: cross-stage-consistency.js', () => {
    it('detects open-source contradictions, dangling deep-read guides, terminology drift, and 100x metric scale drift', () => {
        const analysis = [
            '## 机器摘要',
            'rubric_version: type-aware-v2',
            'has_code: 否',
            'has_model: 是',
            'has_dataset: 否',
            '',
            '## 核心摘要',
            '**问题与瓶颈：** 任务存在干扰。',
            '',
            '**关键实验与核心代价：** 本文方法在干预精确率上达到 82.4%，STOI 达到 0.85，对数几率输出稳定。',
            '',
            '**适用边界与深读导览：** 详见下方「实验架构全景」小节，实验设置小节与毒舌点评给出更多说明。',
            '',
            '## 开源详情',
            '- 代码：论文中未提及代码链接',
            '- 模型权重：https://huggingface.co/example/audio-ckpt',
            '- 数据集：论文中未提及'
        ].join('\n');

        const apiReaderArticle = [
            '### 问题与瓶颈',
            '本文使用对数值估计分类边界，干预准确率达到 82.4%，STOI 为 85.0%。',
            '### 核心架构设计',
            '编码器与解码器协作。'
        ].join('\n\n');

        const apiReaderPlan = {
            sections: [
                { kind: 'problem', heading: '问题与瓶颈', body: '...' },
                { kind: 'method_overview', heading: '核心架构设计', body: '...' }
            ],
            implementationSpecs: {
                openSourceArtifacts: '作者已开源完整训练代码仓库，但原文未披露模型权重。'
            }
        };

        const issues = crossStage.checkCrossStageConsistency({ analysis, apiReaderArticle, apiReaderPlan });
        const codes = new Set(issues.map(i => i.code));
        assert.ok(codes.has('cross_stage_opensource_contradiction'));
        assert.ok(codes.has('cross_stage_dangling_guide_target'));
        assert.ok(codes.has('cross_stage_terminology_drift'));
        assert.ok(codes.has('cross_stage_metric_scale_drift'));
        // Verify both directions of open-source contradiction caught (has_code=否 vs claimed open, has_model=是 vs claimed undisclosed)
        const osFields = issues.filter(i => i.code === 'cross_stage_opensource_contradiction').map(i => i.field);
        assert.ok(osFields.includes('has_code'));
        assert.ok(osFields.includes('has_model'));
    });

    it('produces zero issues on fully consistent Core Summary, Reader, implementationSpecs, and Open Source Details', () => {
        const analysis = [
            '## 机器摘要',
            'rubric_version: type-aware-v2',
            'has_code: 是',
            'has_model: 否',
            'has_dataset: 否',
            '',
            '## 核心摘要',
            '**关键实验与核心代价：** 本文方法在干预精确率上达到 82.4%，STOI 为 0.88，模型已开源推理代码。',
            '',
            '**适用边界与深读导览：** 读者可查阅下方「双分支编码与量化机制」小节了解完整推导。',
            '',
            '## 开源详情',
            '- 代码：https://github.com/example/audio-codec',
            '- 模型权重：论文中未提及',
            '- 数据集：论文中未提及'
        ].join('\n');

        const apiReaderArticle = '### 双分支编码与量化机制\n\n本方法在 LibriSpeech 上干预精确率为 82.4%，STOI 达到 0.88。';
        const apiReaderPlan = {
            sections: [{ kind: 'method_overview', heading: '双分支编码与量化机制', body: '...' }],
            implementationSpecs: {
                openSourceArtifacts: '作者已公开代码仓库（https://github.com/example/audio-codec），模型权重与数据集暂未公开。'
            }
        };

        const issues = crossStage.checkCrossStageConsistency({ analysis, apiReaderArticle, apiReaderPlan });
        assert.deepEqual(issues, []);

        // P1-5 & P2-1 & P0-1 false-positive guards + non-mutation of top-level paper.warnings
        const fpAnalysis = [
            '## 机器摘要',
            'rubric_version: type-aware-v2',
            'has_code: 是',
            'has_model: 否',
            'has_dataset: 否',
            '',
            '## 核心摘要',
            '**问题与瓶颈：** 在开放权重系统中基于已开源的 Whisper 代码做对齐，提供了注意力权重分析，对数几率稳定。',
            '',
            '**关键实验与核心代价：** 论文在「消融分析」小节报告 CS-WER 为 0.58，clean 集 WER 0.85%，FAD 为 0.45。',
            '',
            '**适用边界与深读导览：** 读者可查阅下方「实验结果」小节。',
            '',
            '## 开源详情',
            '- 代码：https://github.com/example/partial-release',
            '- 模型权重：论文中未提及',
            '- 数据集：论文中未提及'
        ].join('\n');
        const fpReader = '### 主实验对比\n\n本方法取功率谱对数值，CS-WER 为 .58，noisy 集 WER 为 85.0%，FAD 为 45.0。';
        const fpPlan = {
            sections: [{ kind: 'result', heading: '主实验对比', body: '...' }],
            implementationSpecs: {
                openSourceArtifacts: '作者已开源推理代码（https://github.com/example/partial-release），但未开源训练代码，权重暂未公开。'
            }
        };
        assert.deepEqual(
            crossStage.checkCrossStageConsistency({ analysis: fpAnalysis, apiReaderArticle: fpReader, apiReaderPlan: fpPlan }),
            []
        );

        // P0-1: recordCrossStageConsistencyWarnings must NEVER mutate top-level paper.warnings
        const fakePaper = { arxivId: '2611.99999' };
        deep.recordCrossStageConsistencyWarnings(fakePaper, fpAnalysis, fpReader, fpPlan);
        assert.equal(Object.prototype.hasOwnProperty.call(fakePaper, 'warnings'), false);
    });
});

describe('Wave 12 Track 12.2: Prompt alignment, slimming & pre-edit blob registration', () => {
    it('eliminates CV FID/patch FID/Inception residues, blocks 核心摘要 image insertion, and slims api-reader-article.md', () => {
        const promptDir = path.join(ROOT, 'prompts/current');
        const files = fs.readdirSync(promptDir).filter(f => f.endsWith('.md'));
        assert.equal(files.length, 16);
        for (const f of files) {
            const text = fs.readFileSync(path.join(promptDir, f), 'utf8');
            assert.doesNotMatch(text, /patch\s+fid|inception|\bFID\b/i, `${f} must not retain CV FID/Inception residue`);
        }
        const imgSup = fs.readFileSync(path.join(promptDir, 'image-supplement.md'), 'utf8');
        assert.match(imgSup, /不得插入 `核心摘要`/);
        assert.doesNotMatch(imgSup, /插入章节仅限 `核心摘要`/);

        const readerPromptBytes = fs.statSync(path.join(promptDir, 'api-reader-article.md')).size;
        assert.ok(readerPromptBytes < 17000, `api-reader-article.md should stay slim (<17KB), got ${readerPromptBytes}`);

        const gapFill = fs.readFileSync(path.join(promptDir, 'gap-fill.md'), 'utf8');
        assert.match(gapFill, /五档标尺锚点与反通胀红线/);
        const structRepair = fs.readFileSync(path.join(promptDir, 'structure-repair.md'), 'utf8');
        assert.match(structRepair, /type-aware-v2.*18 个键/);
    });
});

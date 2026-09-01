const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    READABILITY_RUBRIC_DIMENSIONS,
    findQuantitativeChineseNumerals,
    findDoubleNumbering,
    findReaderTemplatePhrases,
    findBrokenProse,
    findNumericTypographyDefects,
    findBareEditorialLabels,
    findEmbeddedGeneratedHeadings,
    findDuplicateGeneratedHeadings,
    findDuplicateLongSentences,
    findCrossSectionNearDuplicates,
    findCrossSectionNumericFactReuse,
    findLongParagraphs,
    findDefensiveNegationSaturation,
    findTechnicalTermAdhesions,
    findMissingComparisonUnits,
    findBatchTemplateReuse,
    validateReadabilityRubric,
    numericLexemes,
    validateResultClaims,
    validateEditorialQuality
} = require('../scripts/editorial-quality.js');

function sixSections(overrides = {}) {
    return {
        summary: '论文提出声学门控方法，并在受控测试集上报告明确的精度、成本和证据边界。',
        method: '输入波形先经过冻结编码器，再由时序门控选择候选窗口，最后把窗口交给视觉语言模型。',
        innovations: '相较逐帧分类，区间级目标只奖励每个动作至少一次可靠触发，从而减少相邻调用。',
        results: '在测试集的固定预算下，门控方法优于直接排序，且配对检验支持该方向。',
        details: '训练和评测固定数据划分、随机种子、解码参数与计费口径，复现者可以逐项核对。',
        limits: '安静事件对音频不可见；高预算时均匀采样更强，因此结论只适用于论文评测的预算区间。',
        ...overrides
    };
}

describe('Manual v4 editorial quality primitives', () => {
    it('collapses only immediately duplicated decimal extraction tokens', () => {
        assert.deepEqual(
            numericLexemes('MRR rises by 3.73.7, 2.82.8, and 0.50.5.'),
            ['3.7', '2.8', '0.5']
        );
        assert.deepEqual(
            numericLexemes('Separate reported values are 3.7 and 3.7; the range also includes 2.8.'),
            ['3.7', '3.7', '2.8']
        );
    });

    it('blocks precise Chinese quantitative forms but allows ordinals and vague non-numeric wording', () => {
        const findings = findQuantitativeChineseNumerals([
            '调用率为百分之二十五，准确率从七十二点五降到三十点四二。',
            '主数据含二千二百零八个动作，窗口为四秒，实验使用五个随机种子。',
            '第一项贡献包含三个组件和两类任务，另有少量失败案例。'
        ].join('\n'));
        assert.ok(findings.some(item => item.match === '百分之二十五'));
        assert.ok(findings.some(item => item.match === '七十二点五'));
        assert.ok(findings.some(item => /二千二百零八/.test(item.match)));
        assert.ok(findings.some(item => /四/.test(item.match) && /窗口|秒/.test(item.match)));
        assert.ok(findings.some(item => /五个随机种子|五随机种子/.test(item.match)));
        assert.ok(findings.some(item => /三个组件/.test(item.match)));
        assert.ok(findings.some(item => /两类/.test(item.match)));
        assert.ok(findings.every(item => !/第一项|少量/.test(item.match)));
        assert.deepEqual(findQuantitativeChineseNumerals('第 3 项贡献包含 3 个组件，窗口为 4 秒，调用率为 25%。'), []);
        assert.deepEqual(findQuantitativeChineseNumerals('进一步审视外推边界；这一步承接上一步，下一步核对每一步；第一阶段与第十二轮只是序数。'), []);
        assert.deepEqual(findQuantitativeChineseNumerals('系统把不同标签统一成同一条件，但不会把它解释为比例。'), []);
        assert.deepEqual(findQuantitativeChineseNumerals('唯一分层用于二分类；单一模型具有有界损失与有限状态。'), []);
        assert.deepEqual(findQuantitativeChineseNumerals('耗时为数十毫秒。'), []);
        assert.ok(findQuantitativeChineseNumerals('命中率达到五成，类别比例为三比二，系统采用七十亿主干。')
            .some(item => item.reason === 'exact_fraction'));
        assert.ok(findQuantitativeChineseNumerals('命中率达到五成，类别比例为三比二，系统采用七十亿主干。')
            .some(item => item.reason === 'exact_ratio'));
        assert.ok(findQuantitativeChineseNumerals('命中率达到五成，类别比例为三比二，系统采用七十亿主干。')
            .some(item => /七十亿主干/.test(item.match)));
        assert.ok(findQuantitativeChineseNumerals('阈值：三，系统训练三 GPU 小时，开销为三 mac、三 gb，评分范围为三至五等级。').length >= 5);
    });

    it('blocks technical counts, malformed mixed numerals and batch-writing scaffolds', () => {
        const findings = findQuantitativeChineseNumerals([
            'LoRA 秩为八、缩放系数三十二，输入为二百五十六维。',
            '板测延迟为几10 毫秒，显存为二点6 MB。',
            '特征图大小为七百二十乘七百二十，训练三10轮。',
            '宽度采用半宽与四分之一宽，命中率约一成，至少一半样本有效。',
            '总排名第三，输入一到2秒，规模为100 万更新。',
            '系统使用六自由度、八卡训练、七十亿主干与十四至15 token。'
        ].join('\n'));
        assert.ok(findings.some(item => item.reason === 'technical_parameter'));
        assert.ok(findings.some(item => item.reason === 'vague_arabic_magnitude'));
        assert.ok(findings.some(item => item.reason === 'mixed_decimal'));
        assert.ok(findings.some(item => item.reason === 'multiplicative_expression'));
        assert.ok(findings.some(item => item.reason === 'mixed_integer'));
        assert.ok(findings.some(item => item.reason === 'mixed_range'));
        assert.ok(findings.some(item => item.reason === 'mixed_magnitude'));
        assert.ok(findings.some(item => item.reason === 'exact_fraction'));
        assert.ok(findings.some(item => item.reason === 'exact_rank'));
        assert.equal(findReaderTemplatePhrases('关键比较问题是：下图用于核对。证据边界在于此。').length, 3);
        assert.equal(findBrokenProse('这段以分号结束；\n\n下一段。').length, 1);
        assert.ok(findBrokenProse('该方法具有有吸引力，但结果有限，但仍可分析。').length >= 2);
        assert.ok(findBrokenProse('只只报告结果，分别分别比较；只有仅有一组，更接近区别于基线。').length >= 4);
        assert.ok(findBrokenProse('收益存在也区别于其基线，无明显退化区别于旧版，却区别于主结果；提高现实性却区别于现场验证。').length >= 1);
        assert.ok(findBrokenProse('长度分组没有消除长上下文的 2 次计算成本。').length >= 1);
        assert.deepStrictEqual(
            findBrokenProse('| 条件 | 结果 |\n| --- | --- |\n| A | 但仅为 1/6，但不代表跨域成立 |'),
            [],
            'Markdown 表格单元格不应进入 prose 断裂检测'
        );
        assert.deepStrictEqual(
            findBrokenProse('块越大，尾巴越平滑，但时间更拖沓；块越小，跟随越锐利，但纹理更粗。'),
            [],
            '分号分隔的平行对照不应被重复“但”规则误杀'
        );
        for (const malformed of [
            '“听懂内容”区别于能辨别音频质量。',
            '参数高效区别于推理廉价。',
            '客服文本区别于自发客服通话。',
            '素材池规模 5400/4800/4200 区别于题量。',
            '源音频虽来自多数据集，仍区别于真实通话场景。'
        ]) {
            assert.ok(findBrokenProse(malformed).some(item => item.reason === 'broken_relation'), malformed);
        }
        assert.deepEqual(
            findBrokenProse('模型具有有界目标与有限状态，功能能否启用取决于输入，性能能够稳定复现；方案 A 区别于方案 B，slimmable 共享网络区别于 3 个独立网络，现实性提高却仍需现场验证。模型真实运行 2 次，并分别记录每次运行的计算成本。'),
            []
        );
    });

    it('blocks numeric-unit adhesion and digit-damaged Chinese connectives without flagging identifiers', () => {
        const findings = findNumericTypographyDefects([
            '该实验包括5个场景，训练50轮，提升19.5个百分点，并把误差从81.7降至81.0。',
            '论文发现T=2已足够；下1步比较同1组数据，8个候选再归1组合。',
            '芯片功耗约4.9mW，读取1次权重。'
        ].join('\n'));
        assert.ok(findings.some(item => item.match === '包括5' || item.match.startsWith('5个')));
        assert.ok(findings.some(item => item.match === '训练50' || item.match === '50轮'));
        assert.ok(findings.some(item => item.match === '提升19.5' || item.match === '19.5个百分点'));
        assert.ok(findings.some(item => item.match === '从81.7'));
        assert.ok(findings.some(item => item.reason === 'technical_assignment_adhesion'));
        assert.ok(findings.some(item => item.match === '下1步'));
        assert.ok(findings.some(item => item.match.startsWith('同1')));
        assert.ok(findings.some(item => item.match.startsWith('归1')));
        assert.ok(findings.some(item => item.match === '约4.9'));
        assert.ok(findNumericTypographyDefects('下1 步比较同1 张表；另 1 个分支追踪哪1 层，模型从公开的T=4初始化。')
            .filter(item => item.reason === 'broken_fixed_word').length >= 4);
        assert.ok(findNumericTypographyDefects('模型从公开的T=4初始化，并在 T=2已足够时停止。')
            .some(item => item.reason === 'technical_assignment_adhesion'));
        for (const malformed of [
            '方法与3 种基线比较。', '第2 个消融。', '模型在0.25 MHz执行5 次。',
            '4B 和9B权重。', '阈值0.96门控。', '模型采用3D记忆。'
        ]) {
            assert.ok(findNumericTypographyDefects(malformed).length > 0, malformed);
        }
        assert.ok(findNumericTypographyDefects('女性256 次发射；官方158 例；模型在2026年完成。').length >= 3);
        assert.deepEqual(findNumericTypographyDefects(
            'Qwen2 音频模型与 GPT-4o 比较；arXiv 2608.22072 报告 81.7%，小数为 0.2158。'
        ), []);
        assert.deepEqual(findNumericTypographyDefects('该模型进入前10%，准确率提升19.5%。'), []);
        assert.deepEqual(findNumericTypographyDefects('| 1 | Paper | 10.0 | 前10% |'), []);
        assert.ok(findNumericTypographyDefects('| 1 | Paper | 10.0分 | 前10% |')
            .some(item => item.match === '10.0'));
        assert.deepEqual(findNumericTypographyDefects(
            '第 1 个分支使用 1 张表；变量 T=2 的条件与 Qwen2 模型都写清楚。'
            + 'Qwen2.5-7B-Instruct 与 6-DoF 控制均作为合法技术标识。'
        ), []);
        assert.deepEqual(findNumericTypographyDefects(
            '该实验包括 5 个场景，训练 50 轮，提升 19.5 个百分点；误差从 81.7 降至 81.0。'
        ), []);
        for (const malformed of [
            '系统根据注意力 一次性保留缓存。',
            '系统一次性 删除全部缓存。'
        ]) {
            assert.ok(findNumericTypographyDefects(malformed)
                .some(item => item.reason === 'fixed_word_spacing'), malformed);
        }
        assert.deepEqual(findNumericTypographyDefects('系统根据注意力一次性保留缓存。'), []);
    });

    it('detects redundant numbering and bare editorial field labels only when they are reader-visible lines', () => {
        assert.equal(findDoubleNumbering('1. 第一项贡献是稀疏门控。\n2. 第 2 个增量是延迟审计。').length, 2);
        assert.equal(findDoubleNumbering('1. 稀疏门控。\n2. 延迟审计。').length, 0);
        assert.equal(findDoubleNumbering('正文比较第 2 个条件与基线。', { implicitList: true }).length, 0);
        assert.equal(findDoubleNumbering('首要贡献说明机制。\n\n第 2 个增量说明证据。', { implicitList: true }).length, 1);
        const implicitListReport = validateEditorialQuality(sixSections({
            innovations: '首要贡献说明门控机制与证据。\n\n第 2 个增量说明延迟审计。'
        }));
        assert.ok(implicitListReport.issues.some(item => (
            item.section === 'innovations' && item.code === 'double_numbering'
        )));
        const legalProseReport = validateEditorialQuality(sixSections({
            summary: '正文比较第 2 个条件与基线，并说明该序数只用于定位实验条件。'
        }));
        assert.ok(!legalProseReport.issues.some(item => item.code === 'double_numbering'));
        assert.deepEqual(
            findBareEditorialLabels('正文。\n论文证据直接支持的边界\n进一步审视\n正文。').map(item => item.line),
            [2, 3]
        );
        assert.equal(findBareEditorialLabels('#### 论文证据直接支持的边界').length, 0);
        assert.deepEqual(
            findEmbeddedGeneratedHeadings('正文。\n#### 论文证据直接支持的边界\n### 进一步审视')
                .map(item => item.title),
            ['论文证据直接支持的边界', '进一步审视']
        );
        assert.deepEqual(findEmbeddedGeneratedHeadings('### 自定义实验分组'), []);
        assert.deepEqual(
            findDuplicateGeneratedHeadings('## 核心摘要\n正文。\n## 核心摘要\n重复。')
                .map(item => item.title),
            ['核心摘要']
        );
    });

    it('blocks assembler-owned headings inside editorial fields and duplicated rendered headings', () => {
        const embedded = validateEditorialQuality(sixSections({
            limits: '### 论文证据直接支持的边界\n证据有限。\n\n### 进一步审视\n仍需开放域验证。'
        }));
        assert.ok(embedded.issues.some(item => (
            item.code === 'embedded_generated_heading' && item.section === 'limits'
        )));

        const rendered = validateEditorialQuality([
            '## 核心摘要', '正文。', '## 局限与问题',
            '### 论文证据直接支持的边界', '证据有限。',
            '### 进一步审视', '仍需开放域验证。',
            '### 进一步审视', '重复标题下的正文。'
        ].join('\n'));
        assert.ok(rendered.issues.some(item => (
            item.code === 'duplicate_generated_heading' && item.title === '进一步审视'
        )));
    });

    it('finds exact long-sentence duplication without flagging short connective fragments', () => {
        const repeated = '该实验在相同数据划分、相同预算和相同解码设置下比较两个系统，因此差异可以归因于门控策略。';
        const sections = sixSections({
            summary: `${repeated} 这是摘要的边界。`,
            results: `${repeated} 这里给出结果解释。`,
            details: '因此差异可以归因于门控策略。复现信息另行给出。'
        });
        const duplicates = findDuplicateLongSentences(sections);
        assert.equal(duplicates.length, 1);
        assert.deepEqual(duplicates[0].occurrences.map(item => item.section), ['summary', 'results']);
    });

    it('finds high-confidence cross-section near duplicates while preserving related but independently written prose', () => {
        const sections = sixSections({
            summary: '在 EK-100 的固定 25% 调用预算下，间隔门控把动作覆盖率从 40.9% 提高到 46.8%，而声学筛选成本约为 3%。',
            results: '在 EK-100 固定 25% 调用预算下，加入间隔门控后，动作覆盖率由 40.9% 提升至 46.8%；声学前线成本约 3%。',
            details: '复现时需固定录像划分、调用计费边界、特征版本和随机种子；这些条件决定跨实现比较是否成立。'
        });
        assert.ok(findCrossSectionNearDuplicates(sections, { threshold: 0.28, minimumChars: 30 }).length >= 1);
        assert.equal(findCrossSectionNearDuplicates(sixSections(), { threshold: 0.65 }).length, 0);
    });

    it('blocks one multi-number fact signature reused in more than two core sections', () => {
        const fact = '在测试集上，方法的 WER 从 14.3% 降至 12.6%，并把 F-score 从 62.2 提高到 81.7。';
        const sections = sixSections({ summary: fact, results: fact, details: fact });
        const findings = findCrossSectionNumericFactReuse(sections);
        assert.equal(findings.length, 1);
        assert.deepEqual(findings[0].occurrences.map(item => item.section), ['summary', 'results', 'details']);
        assert.equal(findCrossSectionNumericFactReuse(sixSections({ summary: fact, results: fact })).length, 0);
    });

    it('uses two paragraph length levels and excludes limitations from defensive-negation saturation', () => {
        const warningParagraph = `${'该设置提供受控比较，'.repeat(24)}因此需要结合指标方向读取。`;
        const errorParagraph = `${'该设置提供受控比较，'.repeat(38)}因此需要结合指标方向读取。`;
        assert.equal(findLongParagraphs(sixSections({ summary: warningParagraph }))[0].severity, 'warning');
        assert.equal(findLongParagraphs(sixSections({ summary: errorParagraph }))[0].severity, 'error');

        const defensive = '该结果不能外推。该数字不足以证明部署收益。该对照不等于真实设备。该现象并不代表普遍规律。该基准不可外推。';
        const saturation = findDefensiveNegationSaturation(sixSections({ summary: defensive }));
        assert.equal(saturation.severity, 'warning');
        assert.equal(findDefensiveNegationSaturation(sixSections({ limits: defensive })), null);
        assert.deepEqual(findLongParagraphs(sixSections({
            method: '$$\na;b;c;d;e;f;g;h;\n$$\n\n```text\na;b;c;d;e;f;g;h;\n```'
        })), []);
    });

    it('applies paragraph overload checks to reader-visible author and auxiliary sections', () => {
        const authorBlock = `作者团队围绕实验设计展开说明${'；这段作者叙事仍在重复机构信息'.repeat(24)}`;
        const findings = findLongParagraphs({ ...sixSections(), authors: authorBlock, openSource: '代码状态清楚。' });
        assert.ok(findings.some(item => item.section === 'authors' && item.severity === 'error'));
        const validation = validateEditorialQuality({ ...sixSections(), authors: authorBlock });
        assert.ok(validation.issues.some(item => item.code === 'paragraph_too_long' && item.section === 'authors'));
        assert.deepEqual(findLongParagraphs({ ...sixSections(), authors: `作者列表：甲${'；机构信息'.repeat(24)}` }), []);
    });

    it('detects Han/ASCII adhesions but ignores URLs and inline code', () => {
        const findings = findTechnicalTermAdhesions('推理时 LoRA缩放，Qwen-CoT在开发集选 gamma。指标为 F-score依赖设置。');
        assert.ok(findings.some(item => /LoRA缩/.test(item.match)));
        assert.ok(findings.some(item => /Qwen-CoT在/.test(item.match)));
        assert.ok(findTechnicalTermAdhesions('使用 **Conformer**编码器与 [Whisper](https://example.com)解码器。').length >= 2);
        assert.ok(findings.some(item => /F-score依/.test(item.match)));
        assert.deepEqual(findTechnicalTermAdhesions('推理时使用 LoRA 缩放；详见 `Qwen-CoT在代码中的键` 和 https://example.com/LoRA缩放。'), []);
        assert.deepEqual(findTechnicalTermAdhesions('S2为音频分支，S2用反向传播更新；T5模型只作编号对照。'), []);
    });

    it('detects percentage-score deltas and asymmetric comparisons missing nearby units', () => {
        const findings = findMissingComparisonUnits([
            '准确率最大提升分别为三十八点四一和六十九点七一。',
            '理论能耗为九十七对三百二十二毫焦。'
        ].join('\n'));
        assert.ok(findings.some(item => item.reason === 'percentage_metric_delta_without_unit'));
        assert.ok(findings.some(item => item.reason === 'comparison_unit_only_on_second_value'));
        assert.deepEqual(
            findMissingComparisonUnits('准确率提高 23.47 个百分点；理论能耗为 97 mJ 对 322 mJ。'),
            []
        );
        assert.deepEqual(findMissingComparisonUnits('mAP 从 0.781 提高到 0.801。'), []);
        assert.deepEqual(findMissingComparisonUnits(
            '图 2 统计前 10 个词的平均 CER：从第 2 至 3 位起优势显现，且在 HAT 上相对 TG-ASR 的分离更明显。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '图 3 显示 Base 优于上下文基线，Small 的 BLEU 高于 Medium，但 CER 反而更差。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '图 3 显示 VIBE 均优于 Video-Robin 与去掉阶段 5 的消融，四项准确率呈现单调提升。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '奖励位于 0 到 1，密集字幕采用 F1@IoU0.5，音乐任务使用 0.45、0.20、0.15 的加权和。'
        ), []);
        assert.deepEqual(
            findMissingComparisonUnits('SylCipher 相对 wav2vec-U 的 CER 收益在匹配域与不匹配域相差多大？'),
            []
        );
        assert.deepEqual(
            findMissingComparisonUnits('第二段取每一步最大词元概率的时均作为置信度，低于阈值就弃权。'),
            []
        );
        assert.deepEqual(
            findMissingComparisonUnits('6 个骨干中 5 个的 WER 低于 0.05，唯 Qwen-Audio-Chat 为 0.202。'),
            []
        );
        assert.deepEqual(
            findMissingComparisonUnits('用一个廉价冻结规则证明无支撑调用可以被大幅拦截且不损伤支撑准确率。'),
            []
        );
        assert.deepEqual(
            findMissingComparisonUnits('Whisper 分数能拒掉 120/150 非语音和 46/54 babble，增量全部来自剩余样本。'),
            []
        );
    });

    it('finds batch-wide sentence templates at the configured paper threshold', () => {
        const template = '下图展示论文的关键实验比较，读图时需同时保留数据集、指标方向和实验条件。';
        const papers = [1, 2, 3, 4].map(index => ({
            id: `paper-${index}`,
            text: `${template}\n本文第 ${index} 篇的具体内容互不相同。`
        }));
        const findings = findBatchTemplateReuse(papers, { paperThreshold: 3 });
        assert.equal(findings.length, 1);
        assert.equal(findings[0].paperCount, 4);
        assert.equal(findBatchTemplateReuse(papers.slice(0, 3), { paperThreshold: 3 }).length, 1);
        assert.equal(findBatchTemplateReuse(papers.slice(0, 2), { paperThreshold: 3 }).length, 0);
    });
});

describe('Manual v4 readability rubric schema', () => {
    function rubric(score = 2) {
        return {
            paperId: '2608.22359',
            dimensions: Object.fromEntries(READABILITY_RUBRIC_DIMENSIONS.map(dimension => [dimension, {
                score,
                reason: `该维度逐段核对了因果、承接和证据边界，结论有明确文本依据：${dimension}。`,
                evidence: [`${dimension}:line-35`]
            }]))
        };
    }

    it('accepts complete evidence-backed scores and applies the 12/14 no-zero floor', () => {
        const accepted = validateReadabilityRubric(rubric());
        assert.equal(accepted.valid, true);
        assert.equal(accepted.passing, true);
        assert.equal(accepted.total, 14);

        const low = rubric(1);
        assert.equal(validateReadabilityRubric(low).valid, true);
        assert.equal(validateReadabilityRubric(low).passing, false);

        const zero = rubric();
        zero.dimensions.paragraphLogic.score = 0;
        assert.equal(validateReadabilityRubric(zero).passing, false);
    });

    it('rejects missing dimensions, generic reasons, empty evidence and unknown keys', () => {
        const invalid = rubric();
        delete invalid.dimensions.sentenceRhythm;
        invalid.dimensions.paragraphLogic.reason = '很好';
        invalid.dimensions.factLocality.evidence = [];
        invalid.dimensions.unknown = { score: 2, reason: '无效的额外维度不应被接受。', evidence: ['line'] };
        const result = validateReadabilityRubric(invalid);
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /sentenceRhythm|paragraphLogic|factLocality|未知维度/);
    });
});

describe('Manual v4 structured result claims', () => {
    const sourceText = [
        '在 EK-100 测试集、25% 调用预算下，间隔调度的动作覆盖率为 46.8%，直接排序为 40.9%。',
        '在相同视频时长的全扫描成本审计中，声学筛选成本约为全扫描的 3%，低于光流筛选的 75%。',
        '在流式 Earnings22 上，TurboBias 全局配置把 F-score 从无增强基线的 62.2 提高到 81.7，WER 从 16.3% 降至 14.3%。',
        '理论分析只给出稳定性条件，未报告经验基线数值。'
    ].join('\n');

    function claims() {
        return [
            {
                datasetOrSetting: 'EK-100',
                splitOrCondition: '测试集，25% 调用预算',
                method: '间隔调度',
                baseline: '直接排序',
                metric: '动作覆盖率',
                value: '46.8%',
                unit: '%',
                direction: 'higher_is_better',
                sourceQuote: '在 EK-100 测试集、25% 调用预算下，间隔调度的动作覆盖率为 46.8%，直接排序为 40.9%。',
                sourceBindings: {
                    datasetOrSetting: 'EK-100', splitOrCondition: '25% 调用预算',
                    method: '间隔调度', baseline: '直接排序', metric: '动作覆盖率',
                    value: '46.8%', unit: '46.8%', direction: '覆盖率'
                },
                readerBindings: {
                    datasetOrSetting: 'EK-100', splitOrCondition: '25% 调用预算',
                    method: '间隔调度', baseline: '直接排序', metric: '动作覆盖率',
                    value: '46.8%', unit: '46.8%', direction: '覆盖率'
                }
            },
            {
                datasetOrSetting: '全扫描成本审计',
                splitOrCondition: '相同视频时长',
                method: '声学筛选',
                baseline: '光流筛选',
                metric: '相对计算成本',
                value: '3%',
                unit: '% of full scan',
                direction: 'lower_is_better',
                sourceQuote: '在相同视频时长的全扫描成本审计中，声学筛选成本约为全扫描的 3%，低于光流筛选的 75%。',
                sourceBindings: {
                    datasetOrSetting: '全扫描成本审计', splitOrCondition: '相同视频时长',
                    method: '声学筛选', baseline: '光流筛选', metric: '筛选成本',
                    value: '3%', unit: '3%', direction: '低于'
                },
                readerBindings: {
                    datasetOrSetting: '全扫描成本审计', splitOrCondition: '相同视频时长',
                    method: '声学筛选', baseline: '光流筛选', metric: '筛选成本',
                    value: '3%', unit: '3%', direction: '低于'
                }
            },
            {
                datasetOrSetting: 'Earnings22',
                splitOrCondition: '流式 global 配置',
                method: 'TurboBias',
                baseline: '无增强',
                metric: 'F-score',
                value: ['62.2', '81.7'],
                unit: 'score points',
                direction: 'higher_is_better',
                sourceQuote: '在流式 Earnings22 上，TurboBias 全局配置把 F-score 从无增强基线的 62.2 提高到 81.7，WER 从 16.3% 降至 14.3%。',
                sourceBindings: {
                    datasetOrSetting: 'Earnings22', splitOrCondition: '流式 Earnings22',
                    method: 'TurboBias', baseline: '无增强基线', metric: 'F-score',
                    value: '62.2 提高到 81.7', unit: 'F-score', direction: '提高'
                },
                readerBindings: {
                    datasetOrSetting: 'Earnings22', splitOrCondition: '流式 Earnings22',
                    method: 'TurboBias', baseline: '无增强基线', metric: 'F-score',
                    value: '62.2 提高到 81.7', unit: 'F-score', direction: '提高'
                }
            }
        ];
    }

    it('accepts three locally bound claims and NFKC/whitespace-equivalent continuous quotes', () => {
        const input = claims();
        input[0].sourceQuote = '在 EK-100 测试集、25% 调用预算下，\n间隔调度的动作覆盖率为 46.8%，直接排序为 40.9%。';
        const result = validateResultClaims(input, sourceText);
        assert.equal(result.valid, true, result.errors.join('\n'));
        assert.equal(result.minimumClaims, 3);
    });

    it('rejects missing fields, non-source quotes and values absent from their quote', () => {
        const input = claims();
        delete input[0].baseline;
        input[1].sourceQuote = '这句话不在绑定全文里。';
        input[2].value = ['62.2', '91.7'];
        const result = validateResultClaims(input, sourceText);
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /baseline 缺失|未按 NFKC|91\.7 未出现在/);
    });

    it('requires exact source/reader binding keys and rejects unbound field evidence', () => {
        const input = claims();
        input[0].sourceBindings.method = '不存在的方法证据';
        delete input[1].readerBindings.metric;
        input[2].readerBindings.unknown = '无关字段';
        const result = validateResultClaims(input, sourceText, { readerResultsText: sourceText });
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /sourceBindings\.method 不存在于本条 sourceQuote/);
        assert.match(result.errors.join('\n'), /readerBindings 必须且只能包含/);
    });

    it('rejects duplicate claims, arbitrary direction values and eight-field fragment reuse', () => {
        const input = claims();
        input[1] = JSON.parse(JSON.stringify(input[0]));
        input[2].direction = 'banana';
        for (const field of Object.keys(input[2].sourceBindings)) {
            input[2].sourceBindings[field] = input[2].sourceQuote;
        }
        const result = validateResultClaims(input, sourceText);
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /重复，不能重复计入最低条数/);
        assert.match(result.errors.join('\n'), /direction 不是受支持的方向语义/);
        assert.match(result.errors.join('\n'), /同一证据片段最多绑定 3 个字段/);
    });

    it('can revalidate stored claim schema without reloading full text while retaining claim-local numbers', () => {
        const storedClaims = claims();
        assert.equal(validateResultClaims(storedClaims, '', {
            requireSourceBinding: false,
            readerResultsText: sourceText
        }).valid, true);
        storedClaims[0].value = 99.9;
        assert.equal(validateResultClaims(storedClaims, '', {
            requireSourceBinding: false,
            readerResultsText: sourceText
        }).valid, false);
    });

    it('rejects a source-bound result number omitted from the reader-visible experiment section', () => {
        const result = validateResultClaims(claims(), sourceText, {
            readerResultsText: '实验结果只报告 46.8% 与 40.9%，其余设置见正文。'
        });
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /readerBindings 未共同落在.*同一局部证据块/);
    });

    it('does not let a section-global number impersonate a claim-local reader block', () => {
        const input = claims();
        const reader = [
            '另一个完全无关的实验报告 46.8%、3%、62.2 和 81.7。',
            '',
            'EK-100、间隔调度、直接排序与动作覆盖率在这里出现，但没有对应数值。',
            '',
            '全扫描成本审计、相同视频时长、声学筛选、光流筛选与筛选成本另行说明。',
            '',
            'Earnings22、TurboBias、无增强基线与 F-score 也只在文字说明中出现。'
        ].join('\n');
        const result = validateResultClaims(input, sourceText, { readerResultsText: reader });
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /readerBindings 未共同落在.*同一局部证据块/);
    });

    it('treats leading-zero decimals, thousands separators and small English number words as equal', () => {
        const quote = 'On Demo test, Proposed reports .40 score, 5,400 clips, and Ten pairs versus Base.';
        const claim = {
            datasetOrSetting: 'Demo', splitOrCondition: 'test', method: 'Proposed',
            baseline: 'Base', metric: 'score', value: ['0.40', '5400', '10'],
            unit: 'score / clips / pairs', direction: 'higher is better', sourceQuote: quote,
            sourceBindings: {
                datasetOrSetting: 'Demo', splitOrCondition: 'test', method: 'Proposed',
                baseline: 'Base', metric: 'score', value: '.40 score, 5,400 clips, and Ten',
                unit: 'score, 5,400 clips, and Ten pairs', direction: 'score'
            },
            readerBindings: {
                datasetOrSetting: 'Demo', splitOrCondition: 'test', method: 'Proposed',
                baseline: 'Base', metric: 'score↑', value: '0.40 / 5400 / 10',
                unit: 'score↑ / clips / pairs', direction: 'score↑'
            }
        };
        const reader = '| Method | Setting | score↑ / clips / pairs |\n|---|---|---:|\n| Proposed vs Base | Demo test | 0.40 / 5400 / 10 |';
        const result = validateResultClaims([claim], quote, {
            minimumClaims: 1,
            documentType: '方法研究',
            readerResultsText: reader
        });
        assert.equal(result.valid, true, result.errors.join('\n'));
    });

    it('allows explicit notReported without inventing a number and rejects mixed sentinels', () => {
        const input = claims();
        input[0] = {
            datasetOrSetting: '理论稳定性分析',
            splitOrCondition: '正文给定条件',
            method: '理论方法',
            baseline: { notReported: true, reason: '正文没有报告经验比较基线' },
            metric: '稳定性条件',
            value: { notReported: true, reason: '正文没有报告经验结果数值' },
            unit: { notReported: true, reason: '正文没有报告经验结果单位' },
            direction: { notReported: true, reason: '正文没有报告经验指标方向' },
            sourceQuote: '理论分析只给出稳定性条件，未报告经验基线数值。',
            sourceBindings: {
                datasetOrSetting: '理论分析', splitOrCondition: '稳定性条件',
                method: '理论分析只给出', baseline: '未报告经验基线', metric: '稳定性条件',
                value: '未报告经验基线数值', unit: '未报告经验基线数值', direction: '未报告经验基线数值'
            },
            readerBindings: {
                datasetOrSetting: '理论分析', splitOrCondition: '稳定性条件',
                method: '理论分析只给出', baseline: '未报告经验基线', metric: '稳定性条件',
                value: '未报告经验基线数值', unit: '未报告经验基线数值', direction: '未报告经验基线数值'
            }
        };
        assert.equal(validateResultClaims(input, sourceText).valid, true);
        input[0].value = 'notReported 61.05%';
        assert.match(validateResultClaims(input, sourceText).errors.join('\n'), /不得把 notReported 与数值混写/);
        input[0].value = 'notReported';
        assert.match(validateResultClaims(input, sourceText).errors.join('\n'), /必须使用 \{notReported:true, reason\}/);
    });

    it('requires an explicit source-bound exception for theoretical or qualitative documents', () => {
        const oneClaim = [claims()[0]];
        assert.match(validateResultClaims(oneClaim, sourceText).errors.join('\n'), /至少需要 3 条/);
        const accepted = validateResultClaims(oneClaim, sourceText, {
            documentType: '理论研究',
            exception: {
                type: 'theoretical',
                reason: '全文以稳定性推导为主要贡献，只提供一个可结构化绑定的经验结果声明。',
                sourceQuote: '理论分析只给出稳定性条件，未报告经验基线数值。'
            }
        });
        assert.equal(accepted.valid, true, accepted.errors.join('\n'));
        const rejected = validateResultClaims(oneClaim, sourceText, {
            documentType: '方法研究',
            exception: {
                type: 'theoretical',
                reason: '试图在普通方法研究中绕过至少三条结果声明的强制约束。',
                sourceQuote: '理论分析只给出稳定性条件，未报告经验基线数值。'
            }
        });
        assert.equal(rejected.valid, false);
    });
});

describe('Manual v4 aggregate gate', () => {
    it('parses Chinese Markdown section aliases without leaking the next heading into the prior body', () => {
        const markdown = [
            '## 核心摘要',
            '调用率为百分之二十五。',
            '',
            '## 方法概述和架构',
            '方法使用带空格的 LoRA 模块。',
            '',
            '## 实验结果',
            '结果采用 25% 调用率。',
            '',
            '## 评分理由',
            '可复现性披露十轮训练，但没有给出硬件吞吐。'
        ].join('\n');
        const result = validateEditorialQuality(markdown);
        assert.equal(result.issues.filter(item => item.code === 'quantitative_chinese_numeral').length, 2);
        assert.equal(result.issues.some(item => item.section === 'scoring' && /十轮/.test(item.match || '')), true);
        assert.equal(result.issues.some(item => item.section === 'method' && /实验结果/.test(item.match || '')), false);
    });

    it('does not force conceptual headings or indefinite prose into Arabic counters', () => {
        const sections = sixSections({
            summary: '这不是一个好看的总分，而是对错误来源的拆解。',
            method: '### 两种视图如何给错误分账\n\n模型分别读取音高与节奏证据。'
        });
        const issues = validateEditorialQuality(sections).issues
            .filter(item => item.code === 'quantitative_chinese_numeral');
        assert.equal(issues.some(item => /一个|两种/.test(item.match || '')), false);
    });

    it('validates rendered level-three emoji headings instead of returning a false empty pass', () => {
        const rendered = `### 👥 作者与机构\n作者列表：甲。\n\n`
            + `### 📌 核心摘要\n下1 步核对数据。\n\n`
            + `### 🔬 细节详述\n复现信息完整。\n\n`
            + `### 🚨 局限与问题\n证据有限。\n\n`
            + `### 进一步审视\n这段仍属于局限正文。`;
        const result = validateEditorialQuality(rendered);
        assert.ok(result.issues.some(item => item.section === 'summary' && item.code === 'numeric_typography'));
    });

    it('returns blocking issues without mutating the supplied sections', () => {
        const sections = sixSections({
            summary: '1. 第一项贡献在百分之二十五预算下提高覆盖率。论文证据直接支持的边界',
            method: '模型通过 LoRA缩放控制适配强度。',
            results: '准确率最大提高三十八点四一。',
            limits: '进一步审视\n该结果只覆盖一个受控基准。'
        });
        const before = JSON.stringify(sections);
        const result = validateEditorialQuality(sections);
        assert.equal(result.valid, false);
        assert.match(result.issues.map(item => item.code).join('\n'), /quantitative_chinese_numeral|double_numbering|technical_term_adhesion|comparison_unit_missing/);
        assert.equal(JSON.stringify(sections), before);
    });
});

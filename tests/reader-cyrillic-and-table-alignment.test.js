'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    findCyrillicProseGarbleIssues,
    validateCyrillicProseGarbleContract,
    validateAnalysisEditorialLeakageContract,
    findMisalignedTableCommentaryIssues,
    validateTableCommentaryAlignmentContract,
    validateExperimentTableContract
} = require('../scripts/analysis-contract.js');
const {
    findReaderLanguageIssues,
    validateEditorialQuality
} = require('../scripts/editorial-quality.js');
const readerRepair = require('../scripts/lib/reader-repair.js');

const ROOT = path.resolve(__dirname, '..');

test('D1：检测中文正文中混入的西里尔字母乱码词，并定位到对应 Reader 节点', () => {
    // 2611.24290 真实乱码正例（紧邻数字/汉字与空格变体）
    for (const sample of [
        '这张图确实可见Alif实线从0.84附近 быстро爬到0.96附近封顶，Shin点线从0.30附近爬到0.62附近。',
        '从 0.84 附近 быстро爬到 0.96 附近封顶。',
        '训练中期模型быстро收敛并保持稳定。',
        '收敛速度быстро，但高噪声下方差较大。',
        'быстро收敛并不代表泛化更好。'
    ]) {
        const findings = findCyrillicProseGarbleIssues(sample);
        assert.ok(findings.length >= 1, `应拦截西里尔乱码: ${sample}`);
        assert.equal(findings[0].code, 'cyrillic_prose_garble');
        assert.match(findings[0].message, /西里尔字母乱码词/);
        assert.match(validateCyrillicProseGarbleContract(sample) || '', /西里尔字母乱码词/);
        assert.match(validateAnalysisEditorialLeakageContract(sample) || '', /西里尔字母乱码词/);

        const readerIssues = findReaderLanguageIssues(sample);
        assert.ok(readerIssues.some(item => item.code === 'reader_awkward_translation'
            && /西里尔字母乱码词/.test(item.message)), `editorial-quality 应拦截: ${sample}`);
    }

    // 验证 collectReaderLanguageIssues 与 buildRepairTargets 精确定位到受损小节正文
    const draft = {
        readerTitle: '强化学习奖励设计与轨迹收敛行为分析',
        oneSentenceThesis: '通过分解阶段奖励与终止条件，模型在受控环境下实现更高累积回报并暴露探索方差代价。',
        sections: [
            {
                kind: 'problem',
                heading: '稀疏奖励下为什么智能体难以稳定收敛',
                body: '在稀疏奖励设定下，智能体在早期探索阶段缺乏局部梯度反馈，导致策略更新方差偏大，需要引入结构化中间信号来引导搜索过程并避免局部停滞。'.repeat(2)
            },
            {
                kind: 'result',
                heading: '学习曲线分层说明了怎样的收敛差异',
                body: '这张图确实可见 Alif 实线从 0.84 附近 быстро爬到 0.96 附近封顶，Shin 点线从 0.30 附近爬到 0.62 附近，Bob 虚线从 0.33 附近爬到 0.44 附近，横轴为幕数。它帮助理解对齐程度如何决定收敛上界。'
            }
        ],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: []
    };
    const languageIssues = readerRepair.collectReaderLanguageIssues(draft);
    assert.equal(languageIssues.length, 1);
    assert.equal(languageIssues[0].path, '/sections/1/body');
    assert.match(languageIssues[0].match, /быстро/);
    const parserError = Object.assign(new Error('读者正文含生硬译法或写作检查话术'), {
        code: readerRepair.LANGUAGE_ERROR_CODE,
        readerIssues: languageIssues
    });
    const collected = readerRepair.collectDraftIssues(draft, parserError);
    const targets = readerRepair.buildRepairTargets(draft, collected);
    assert.deepEqual(targets.map(target => target.path), ['/sections/1/body']);
});

test('D1：英文斯拉夫作者名、代码块、公式、链接、来源逐字引文与俄语术语讨论不误报', () => {
    const negatives = [
        'Markov, Kolmogorov (1950) gave the foundational formulation for stochastic chains.',
        'Марков, Колмогоров (1950).\n本文在此离散状态转移假设上进一步引入声学观测先验。',
        '代码调用 `tokenizer.encode("быстро")` 测试多语种分词鲁棒性。',
        '```python\nword = "быстро"  # 俄语测试输入\n```\n模型只统计子词长度。',
        '链接 https://example.org/быстро/音频样本 不作为正文词元检查。',
        '> 引用块中的原始语料：быстро 仅作输入示例。',
        '原文写道：“модель быстро сходится” 以说明俄语日志样例。',
        '俄语有关键术语、概念词、主导词、语义 доминанта等，英语有 keyword 与 keyphrase。',
        '| 语言 | 样例 |\n| --- | --- |\n| 语料 | быстро |\n\n上表展示了多语种测试集中的原始词形样例。'
    ];
    for (const sample of negatives) {
        assert.deepEqual(findCyrillicProseGarbleIssues(sample), [], `不应误报: ${sample}`);
        assert.equal(validateAnalysisEditorialLeakageContract(sample), null);
        assert.equal(
            findReaderLanguageIssues(sample).filter(item => /西里尔字母乱码词/.test(item.message)).length,
            0,
            `findReaderLanguageIssues 不应误报: ${sample}`
        );
    }

    // 论文原文确实包含对应西里尔词元时按来源放行
    const withSource = '数据集保留了原始标注标签 доминанта 用于跨语种对齐实验。';
    assert.equal(findCyrillicProseGarbleIssues(withSource).length, 1);
    assert.deepEqual(
        findCyrillicProseGarbleIssues(withSource, {
            sourceText: 'We retain the original annotation label доминанта for cross-lingual alignment.'
        }),
        []
    );
});

test('D2：拦截 2611.22456 真实多表与“该表支撑的判断是…”交叉错位，并在修复路由中定位对应小节', () => {
    const permutedSec7 = [
        '### 主结果在什么条件下成立，提升与代价各是什么',
        '',
        '要回答的核心问题是，在相同主干、相同题目与相同候选下，PACD 相对标准解码与最强基线是否更准。下表比较了 2 个主干在 3 个幻觉基准上的准确率。',
        '',
        '| Method | CMM | AVHBench | SVHalluc |',
        '| --- | --- | --- | --- |',
        '| VideoLLaMA2-AV-7B | 77.3 | 72.6 | 51.7 |',
        '| PACD | 82.4 | 80.6 | 60.4 |',
        '| Qwen2.5-Omni-7B | 68.4 | 75.5 | 64.7 |',
        '',
        '该表支撑的判断是，在全部模型与基准组合上 PACD 总体准确率最高，跨 CMM、AVHBench 与 SVHalluc 最高达到 82.4%，在 Qwen2.5-Omni-7B 上也有明显提升。限制是这些数字只在判别式问答下成立。',
        '',
        '下表比较了泛化基准上的表现，比较问题是幻觉之外的通用音视频推理与未来预测是否也受益，条件是同一主干下比较 MAD 与 PACD。',
        '',
        '| Method | CMM | AVHBench | SVHalluc |',
        '| --- | --- | --- | --- |',
        '| Base | 82.4 | 71.1 | 50.9 |',
        '| Uniform | 85.9 | 73.7 | 52.6 |',
        '| Argmax | 84.3 | 72.7 | 53.6 |',
        '| MAD | 85.4 | 75.1 | 53.9 |',
        '| PACD | 87.4 | 78.8 | 63.7 |',
        '',
        '该表支撑的判断是，在 VideoLLaMA2-AV 与 OmniVinci 的 OmniVideoBench 与 FutureOmni 上 PACD 高于 MAD，原文给出相对 MAD 约 9.9% 与 10.2% 以及 7.1% 与 3.5% 的相对提升。限制是泛化评估只覆盖两个主干与两个基准。'
    ].join('\n');

    const permutedSec8 = [
        '### 简化策略与组件拆分说明了哪部分在起作用',
        '',
        '下表在 OmniVinci 上比较均匀加权、独热加权、MAD 与 PACD，条件是相同主干与相同融合系数。',
        '',
        '| Method | CMM | AVHBench | SVHalluc |',
        '| --- | --- | --- | --- |',
        '| Base | 82.4 | 71.1 | 50.9 |',
        '| Routing | 83.5 | 74.3 | 53.6 |',
        '| RGCA | 86.9 | 77.7 | 54.0 |',
        '| R+PBCR | 84.0 | 75.6 | 62.9 |',
        '| PACD | 87.4 | 78.8 | 63.7 |',
        '',
        '该表支撑的判断是，均匀与独热两种简化策略在 CMM、AVHBench 与 SVHalluc 上均低于 PACD，原文指出分别低 1.5、5.1 与 10.1 个百分点。限制是该对照仅在单一主干展示。',
        '',
        '进一步拆分组件时，路由指直接采用目标分支预测，RGCA 指加上置信度仲裁，R 加 PBCR 指保留恢复但去掉仲裁。下表给出三者在 3 个基准上的结果。',
        '',
        '| Method | OmniVideoBench | FutureOmni |',
        '| --- | --- | --- |',
        '| VideoLLaMA2-AV | 27.5 | 38.8 |',
        '| VideoLLaMA2-AV+MAD | 28.3 | 36.3 |',
        '| VideoLLaMA2-AV+PACD | 31.1 | 40.0 |',
        '| OmniVinci | 32.9 | 52.7 |',
        '| OmniVinci+MAD | 32.5 | 51.7 |',
        '| OmniVinci+PACD | 34.8 | 53.5 |',
        '',
        '该表支撑的判断是，两条路径互补，RGCA 在 CMM 与 AVHBench 上相对路由有数个百分点的总体提升，R 加 PBCR 在 SVHalluc 上把语义准确率从约 59.7% 提升到 75.0% 附近，而完整 PACD 在三者上分别达到 87.4%、78.8% 与 63.7%。限制是尚未覆盖多轮开放生成。'
    ].join('\n');

    const permutedArticle = `${permutedSec7}\n\n${permutedSec8}`;
    const issues = findMisalignedTableCommentaryIssues(permutedArticle);
    assert.equal(issues.length, 2);
    assert.equal(issues[0].code, 'table_commentary_misaligned');
    assert.equal(issues[0].tableIndex, 2);
    assert.equal(issues[0].otherTableIndex, 4);
    assert.equal(issues[0].sectionIndex, 0);
    assert.equal(issues[0].otherSectionIndex, 1);
    assert.ok(issues[0].foreignTokens.includes('omnivideobench'));
    assert.ok(issues[0].foreignTokens.includes('futureomni'));

    assert.equal(issues[1].tableIndex, 4);
    assert.equal(issues[1].otherTableIndex, 3);
    assert.ok(issues[1].foreignTokens.includes('avhbench'));
    assert.ok(issues[1].foreignTokens.includes('svhalluc'));

    // 验证 validateEditorialQuality 产生阻塞级错误并能驱动局部修复定位到对应小节
    const quality = validateEditorialQuality({
        summary: '', method: permutedArticle, innovations: '', results: '', details: '', limits: ''
    });
    const misaligned = quality.issues.filter(item => item.code === 'table_commentary_misaligned');
    assert.equal(misaligned.length, 2);
    const details = misaligned.map(item => `${item.code}:${item.match || item.message}`).join('；');
    const error = new Error(`读者文章文风校验失败: ${details}`);

    const draft = {
        readerTitle: '跨模态共识解码如何抑制音视频幻觉',
        oneSentenceThesis: '利用层内来源证据进行置信度仲裁与共识恢复，在不重训主干的前提下降低多模态幻觉。',
        sections: [
            { kind: 'result', heading: '主结果在什么条件下成立，提升与代价各是什么', body: permutedSec7.replace(/^### .+\n\n/, '') },
            { kind: 'ablation', heading: '简化策略与组件拆分说明了哪部分在起作用', body: permutedSec8.replace(/^### .+\n\n/, '') }
        ],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [
            { tableIndex: 1, sourceType: 'artifact_table', sourceTableOrdinal: 1, cellBindings: [], sourceQuotes: [] },
            { tableIndex: 2, sourceType: 'artifact_table', sourceTableOrdinal: 2, cellBindings: [], sourceQuotes: [] },
            { tableIndex: 3, sourceType: 'artifact_table', sourceTableOrdinal: 3, cellBindings: [], sourceQuotes: [] },
            { tableIndex: 4, sourceType: 'artifact_table', sourceTableOrdinal: 4, cellBindings: [], sourceQuotes: [] }
        ],
        formulaBindings: []
    };
    const repairTargets = readerRepair.buildRepairTargets(draft, readerRepair.collectDraftIssues(draft, error));
    const targetPaths = repairTargets.map(item => item.path);
    assert.ok(targetPaths.includes('/sections/0/body'));
    assert.ok(targetPaths.includes('/sections/1/body'));

    // 主分析实验结果契约（最多 2 张表）同样能够拦截两表与表后评述交叉错位
    const twoTablePermutedResults = [
        '## 实验结果',
        '',
        '第一组比较检验均匀与独热简化策略相对完整 PACD 的差异，固定同一主干与融合系数。',
        '',
        '| Method | CMM ↑ | AVHBench ↑ | SVHalluc ↑ |',
        '| --- | --- | --- | --- |',
        '| Uniform | 85.9 | 73.7 | 52.6 |',
        '| Argmax | 84.3 | 72.7 | 53.6 |',
        '| PACD | 87.4 | 78.8 | 63.7 |',
        '',
        '该表支撑的判断是，在 VideoLLaMA2-AV 与 OmniVinci 的 OmniVideoBench 与 FutureOmni 上 PACD 相比基线取得提升，但单一泛化幅度受任务长度限制，不能直接推广到开放域生成。',
        '',
        '第二组比较检验通用视频推理与未来预测泛化基准上的相对表现，固定同一评测划分。',
        '',
        '| Method | OmniVideoBench ↑ | FutureOmni ↑ |',
        '| --- | --- | --- |',
        '| VideoLLaMA2-AV | 27.5 | 38.8 |',
        '| OmniVinci | 32.9 | 52.7 |',
        '| PACD | 34.8 | 53.5 |',
        '',
        '该表支撑的判断是，Uniform 与 Argmax 在 CMM、AVHBench 与 SVHalluc 上均低于 PACD，尤其 Argmax 在音频主导细分类反而下降，证据范围限于判别式问答。'
    ].join('\n');
    const mainTableIssue = validateExperimentTableContract(twoTablePermutedResults, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: '经验研究',
        sourceText: 'Table 1 ablation baseline worse than PACD.'
    });
    assert.match(mainTableIssue || '', /疑似多表与表后评述错位/);
});

test('D2：对齐后的 2611.22456 多表评述、跨表对照句与范围限制句均零误报', () => {
    const alignedArticle = [
        '### 简化策略与组件拆分说明了哪部分在起作用',
        '',
        '下表在 OmniVinci 上比较均匀加权、独热加权、MAD 与 PACD，条件是相同主干与相同融合系数。',
        '',
        '| Method | CMM ↑ | AVHBench ↑ | SVHalluc ↑ |',
        '| --- | --- | --- | --- |',
        '| Base | 82.4 | 71.1 | 50.9 |',
        '| Uniform | 85.9 | 73.7 | 52.6 |',
        '| Argmax | 84.3 | 72.7 | 53.6 |',
        '| MAD | 85.4 | 75.1 | 53.9 |',
        '| PACD | 87.4 | 78.8 | 63.7 |',
        '',
        '该表支撑的判断是，均匀与独热两种简化策略在 CMM、AVHBench 与 SVHalluc 上均低于 PACD，分别只达到 85.9 与 84.3，而 Argmax 在音频主导格反而退化。读者应当拿它与下一张表在 OmniVideoBench 和 FutureOmni 上的泛化提升对照，同时注意限制是该对照仅在 OmniVinci 上完成，未报告 VideoLLaMA2-AV 上的对应消融。',
        '',
        '为判断泛化是否超出幻觉专项基准，下表整理两个主干在两个通用基准上相对 MAD 的提升幅度，条件是相同主干与相同评测集。',
        '',
        '| 主干 | OmniVideoBench 相对提升 ↑ | FutureOmni 相对提升 ↑ |',
        '| --- | --- | --- |',
        '| VideoLLaMA2-AV | 9.9% | 10.2% |',
        '| OmniVinci | 7.1% | 3.5% |',
        '',
        '该表支撑的判断是，PACD 在两个主干与两个通用基准上均高于 MAD，VideoLLaMA2-AV 提升更大，OmniVinci 提升较小但仍为正。限制是此处仅呈现相对提升，未列出绝对准确率与基线分数，不能把相对百分比直接当作百分点增量。'
    ].join('\n');

    assert.deepEqual(findMisalignedTableCommentaryIssues(alignedArticle), []);
    assert.equal(validateTableCommentaryAlignmentContract(alignedArticle), null);
});

test('C2 与 D5：现用 Reader 与局部修复提示词包含列头单位证据、最低表数与图例排他量词核对指引', () => {
    const articlePrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-article.md'), 'utf8');
    const repairPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-repair.md'), 'utf8');

    for (const prompt of [articlePrompt, repairPrompt]) {
        assert.match(prompt, /source_quotes.*(?:列头|单位)/);
        assert.match(prompt, /GiB/);
        assert.match(prompt, /裸数字/);
        assert.match(prompt, /不少于 4 张/);
        assert.match(prompt, /p <= 0\.05/);
        assert.match(prompt, /斜纹/);
        assert.match(prompt, /“全部”“所有”“只有”“唯一”/);
        assert.match(prompt, /条件.*图例颜色.*方法行名/);
    }
});

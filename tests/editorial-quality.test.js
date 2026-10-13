const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    READABILITY_RUBRIC_DIMENSIONS,
    findQuantitativeChineseNumerals,
    normalizeIssueBoundReaderQuantitativeNumerals,
    findDoubleNumbering,
    findReaderTemplatePhrases,
    findReaderLanguageIssues,
    normalizeDanglingReaderConnectors,
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

describe('读者中文的精确怪译与检查话术诊断', () => {
    it('定位真实怪译并给保留数字与来源的修正引导，不改原文', () => {
        const text = '😀 引言。\n\n最优评论家固定时，生成器得到分数差梯度。\n'
            + 'FID 1.04 使用弗雷歇起始距离；补丁距离用于高分辨率细节。';
        const before = text;
        const issues = findReaderLanguageIssues(text);
        assert.deepEqual(issues.map(issue => issue.match),
            ['最优评论家', '弗雷歇起始距离', '补丁距离']);
        for (const issue of issues) {
            assert.equal(issue.code, 'reader_awkward_translation');
            assert.equal(text.slice(issue.index, issue.index + issue.match.length), issue.match);
            assert.match(issue.message, /保留|保持/);
            assert.match(issue.message, /证据|来源/);
        }
        assert.equal(text, before);
    });

    it('历史四稿的原句分别诊断，不把必要模型专名或数学符号当混夹', () => {
        const samples = [
            '评价关心三类事情：分布逼近程度，常用弗雷歇起始距离度量生成分布与参考分布的距离，越低越好。',
            '固定噪声水平 t 和条件 c，记目标噪声边缘为 P=pt，学生噪声边缘为 Q=pθ,t，判别器 logit 为 h，sigmoid 为 S。',
            '下表把这两类证据放在一起，列数满足核对要求。表后解释必须区分人工评价与自动指标。',
            '教师样本限定学生不要偏离教师分布太远，真实数据则提供教师采样分布之外的监督。'
        ];
        assert.equal(findReaderLanguageIssues(samples[0]).length, 1);
        assert.deepEqual(findReaderLanguageIssues(samples[1]), []);
        assert.deepEqual(findReaderLanguageIssues(samples[2]).map(issue => issue.match),
            ['列数满足核对要求', '表后解释必须区分']);
        assert.deepEqual(findReaderLanguageIssues(samples[3]), []);
    });

    it('实际新稿的表前表后指令给出自然承接引导', () => {
        for (const text of ['表前说明如下：下表比较两种方法。',
            '表后解释需要同时看到收益与限制。',
            '表后需强调成本与未胜出项。', '表后需补充机制解释。',
            '表中数值均有原文连续句作为来源。']) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1, text);
            assert.equal(issues[0].code, 'reader_workflow_leakage');
            assert.match(issues[0].message, /自然句/);
            assert.match(issues[0].message, /保留原数字、单位、方法归属和来源证据/);
        }
    });

    it('普通评论、数学距离和代码游戏补丁保持原意', () => {
        for (const text of ['评论家认为这部电影的结构更紧凑。',
            '评委选出本届最优评论家，奖项针对影评作品。',
            '评论区讨论 FID，但影评中的评论家没有训练模型。',
            'Fréchet 距离用于比较两条曲线，离散弗雷歇距离同样适用。',
            '软件补丁距离发布日期还有 2 天。',
            '游戏补丁修复了角色移动距离，patch 操作不改存档。',
            '蒸馏脚本补丁距离发布日期还有 2 天。',
            '表格应区分训练集和测试集，比较结果说明局部图像指标的限制。',
            'SDXL、Wan、ImageNet、COCO、FID 和 patch FID 是模型、数据集与指标名。']) {
            assert.deepEqual(findReaderLanguageIssues(text), [], text);
        }
    });

    it('引用、代码和公式不成为作者自己的解释，后续正文索引仍准确', () => {
        const text = '> 原文引文：最优评论家使用生成器；弗雷歇起始距离。\n\n'
            + '```text\n😀 列数满足核对要求\n```\n\n'
            + '`最优评论家`、$弗雷歇起始距离$、\\(补丁距离\\)只是示例。\n\n'
            + '原文写道：“表后解释必须区分人工评价与自动指标”。\n\n'
            + '$$\n弗雷歇起始距离\n$$\n\n'
            + '\\[\n表后需强调成本\n\\]\n\n'
            + 'FID 的弗雷歇起始距离为 1.04。';
        const issues = findReaderLanguageIssues(text);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].index, text.lastIndexOf('弗雷歇起始距离'));
        assert.equal(issues[0].match, '弗雷歇起始距离');
    });

    it('普通数学定义不因附近其他段落的生成器而误报影评术语', () => {
        assert.deepEqual(findReaderLanguageIssues('生成器通过梯度更新。\n\n本届最优评论家获得影评奖。'), []);
        assert.deepEqual(findReaderLanguageIssues('FID 衡量图像分布。\n\n软件补丁距离发布日期还有 2 天。'), []);
        assert.deepEqual(findReaderLanguageIssues('FID 衡量图像分布。\r\n \r\n软件补丁距离发布日期还有 2 天。'), []);
    });

    it('同一行代码结束后不吞掉后面的真实正文', () => {
        const text = '```弗雷歇起始距离```\n\nFID 使用弗雷歇起始距离。';
        const issues = findReaderLanguageIssues(text);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].index, text.lastIndexOf('弗雷歇起始距离'));
    });

    it('短标题只借对应正文判断术语，不把上下文变成授权检查目标', () => {
        const title = '最优评论家';
        const issues = findReaderLanguageIssues(title, {
            contextText: 'DMD 的生成器用梯度更新；表后需补充机制解释。'
        });
        assert.equal(issues.length, 1);
        assert.equal(issues[0].match, title);
        assert.equal(issues[0].index, 0);
        assert.deepEqual(findReaderLanguageIssues(title, {
            contextText: '这部电影结构紧凑，评论家给出不同评价。'
        }), []);
        assert.deepEqual(findReaderLanguageIssues('补丁距离', {
            contextText: '软件 patch 修复游戏中角色移动距离。'
        }), []);
        assert.equal(findReaderLanguageIssues('补丁距离', {
            contextText: 'patch FID 比较局部图像块的特征分布。'
        })[0].match, '补丁距离');
        assert.deepEqual(findReaderLanguageIssues('正常标题', {
            contextText: '弗雷歇起始距离用于 FID；列数满足核对要求。'
        }), []);
    });

    it('辅助评论家只在对应技术语境下提示，不泛禁影评人物', () => {
        assert.equal(findReaderLanguageIssues('DMD 使用辅助评论家估计学生分数。')[0].match,
            '辅助评论家');
        assert.deepEqual(findReaderLanguageIssues('辅助评论家整理电影采访记录。'), []);
        assert.deepEqual(findReaderLanguageIssues('patch FID 衡量局部图像特征分布。'), []);
    });

    it('真实原表及对齐行保持完整，只定位表后的同词正文', () => {
        const text = '😀 原表如下。\r\n\r\n'
            + '| 指标 | 数值 |\r\n| :--- | ---: |\r\n'
            + '| 弗雷歇起始距离 | 1.04 |\r\n'
            + '| 表后解释必须区分 | 14.47 |\r\n\r\n'
            + '正文将 FID 译成弗雷歇起始距离。';
        const before = text;
        const issues = findReaderLanguageIssues(text);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].match, '弗雷歇起始距离');
        assert.equal(issues[0].index, text.lastIndexOf('弗雷歇起始距离'));
        assert.equal(text, before);
        assert.ok(text.includes('1.04'));
        assert.ok(text.includes('14.47'));
    });

    it('无首尾竖线的合法Markdown原表受保护，普通竖线句仍报', () => {
        const table = '指标 | 数值\n--- | ---\n弗雷歇起始距离 | 1.04';
        assert.deepEqual(findReaderLanguageIssues(table), []);
        for (const text of ['普通说明 | 弗雷歇起始距离用于 FID。',
            '| 弗雷歇起始距离只是普通竖线句，没有表头对齐行 |',
            '列数满足核对要求 | 这是一句普通说明。',
            '指标 | 数值\n不是对齐行 | 弗雷歇起始距离']) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1, text);
            assert.equal(text.slice(issues[0].index, issues[0].index + issues[0].match.length),
                issues[0].match);
        }
    });

    it('共享主分析摘要和方法文本报告精确语言问题，不自动润色或丢证据', () => {
        const sections = sixSections({
            summary: 'FID 1.04 用弗雷歇起始距离评估。',
            method: '表后解释必须区分人工评价与自动指标，原结果为 14.47。'
        });
        const before = JSON.stringify(sections);
        const issues = validateEditorialQuality(sections).issues.filter(issue =>
            ['reader_workflow_leakage', 'reader_awkward_translation'].includes(issue.code));
        assert.equal(issues.length, 2);
        assert.equal(issues[0].section, 'summary');
        assert.equal(issues[0].match, '弗雷歇起始距离');
        assert.equal(issues[1].section, 'method');
        assert.equal(issues[1].match, '表后解释必须区分');
        assert.equal(JSON.stringify(sections), before);
        assert.ok(sections.summary.includes('1.04'));
        assert.ok(sections.method.includes('14.47'));
    });

    it('共享检查沿用原表引用代码公式保护和正常术语边界', () => {
        const sections = sixSections({
            summary: 'Fréchet 距离是数学距离，FID 保留准确指标名。',
            method: '> 引文：弗雷歇起始距离。\n\n'
                + '指标 | 数值\n--- | ---\n弗雷歇起始距离 | 1.04\n\n'
                + '`列数满足核对要求` 是代码示例。\n\n'
                + '$最优评论家$ 是公式示例。\n\n'
                + '评论家评价电影，软件 patch 修补代码。'
        });
        const issues = validateEditorialQuality(sections).issues.filter(issue =>
            ['reader_workflow_leakage', 'reader_awkward_translation'].includes(issue.code));
        assert.deepEqual(issues, []);
    });

    it('真实表格写作自述窄报，普通表前表后描述不误报', () => {
        for (const text of ['表格前后需要完整的独立说明与解释。',
            '表前已说明比较问题、公平条件与指标方向。',
            '表前需要说明比较问题、公平条件和指标方向。',
            '表后解释主要收益、具体代价与限制：各指标并不一致。',
            '表后解释支持的有限判断与反例：局部细节仍受限制。',
            '列数满足比较需要，内容全部来自原文连续句子，没有补造列。']) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1, text);
            assert.equal(issues[0].code, 'reader_workflow_leakage');
        }
        for (const text of ['表前介绍了数据集，表后讨论错误类型。',
            '表后解释了局部图像指标与整体指标为何不同。',
            '表格前后的文字比较了两种训练条件。',
            '该列记录每个方法的指标，不同列用于不同数据集。']) {
            assert.deepEqual(findReaderLanguageIssues(text), [], text);
        }
    });

    it('实际新稿中的段首写作自述拒绝，作者说明与原文表格仍保留', () => {
        const leaked = ['表前说明比较问题与公平条件：两种系统用相同输入。',
            '表后解释结果与限制。主结果和子集结果要分别理解。',
            '表后解释主要收益与限制：两项指标并不一致。',
            '表后解释第一组结论：测试只包含同一数据集。',
            '表后解释需要看两个攻击者的基线差异。',
            '表后解释要分开看两个系统。'];
        for (const text of leaked) {
            for (const prefix of ['', '这里有两项结果。', '\n**']) {
                const issues = findReaderLanguageIssues(prefix + text);
                assert.equal(issues.length, 1, prefix + text);
                assert.equal(issues[0].code, 'reader_workflow_leakage');
            }
            assert.deepEqual(findReaderLanguageIssues('> ' + text), []);
            assert.deepEqual(findReaderLanguageIssues('原文写道：“' + text + '”'), []);
        }
        for (const text of ['作者在表后解释结果与限制，并明确只测单个数据集。',
            '表后解释了两个系统结果不同的原因。',
            '表前说明了比较问题与公平条件：两组使用相同输入。',
            '| 原文标题 | 结果 |\n| --- | --- |\n| 表后解释结果与限制。 | 12 |',
            '`表后解释需要看两个攻击者的基线差异。`']) {
            assert.deepEqual(findReaderLanguageIssues(text), [], text);
        }
    });

    it('最终实测的照抄写作指令拒绝，直接解释概念通过', () => {
        const leaked = '这里的分数若指对数密度对输入的梯度，要说明它不是质量评分。';
        assert.equal(findReaderLanguageIssues(leaked)[0].code, 'reader_workflow_leakage');
        assert.equal(findReaderLanguageIssues(leaked)[0].match, leaked.slice(0, -1));
        assert.deepEqual(findReaderLanguageIssues(
            '分数在这里指对数密度对输入的梯度，不是质量评分。'
        ), []);
        assert.deepEqual(findReaderLanguageIssues(
            '这里的分数描述样本应往哪个方向移动，区别于质量评分。'
        ), []);
    });

    it('真实长文中的来源检查话术拒绝，资源状态与逐字引文说明保留', () => {
        const examples = [
            '论文没有绑定经校验可用的代码与权重资源，因此不能声称作者资源已公开。',
            'LibriSpeech 上原文只说趋势类似，没有在正文中给出可逐字覆盖的完整句子，因此不在此表展开。'
        ];
        for (const text of examples) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1);
            assert.equal(issues[0].code, 'reader_workflow_leakage');
            assert.equal(text.slice(issues[0].index, issues[0].index + issues[0].match.length), issues[0].match);
            assert.deepEqual(findReaderLanguageIssues('> 原文引文：' + text), []);
            assert.deepEqual(findReaderLanguageIssues('```text\n' + text + '\n```'), []);
        }
        for (const text of [
            '目前没有找到作者公开的代码与模型权重。',
            '作者未在正文中给出完整训练参数。',
            '这份逐字引文保留了作者的完整句子。',
            '本表只展示 CSJ；原论文表 4 另有 LibriSpeech 的结果。'
        ]) assert.deepEqual(findReaderLanguageIssues(text), []);
    });

    it('明确禁止错译不算错误术语，同段真正错译仍准确定位', () => {
        for (const text of ['patch FID 在图像块上计算，不叫补丁距离。',
            'FID 不应被译成弗雷歇起始距离。',
            'DMD 的辅助模型不要写成“辅助评论家”。',
            '局部图像指标避免译为补丁距离。']) {
            assert.deepEqual(findReaderLanguageIssues(text), [], text);
        }
        const text = 'patch FID 不叫补丁距离。下一句却用补丁距离比较局部图像。';
        const issues = findReaderLanguageIssues(text);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].index, text.lastIndexOf('补丁距离'));
    });

    it('表前表后写作指令按句法定位，正常作者说明不拦截', () => {
        for (const text of ['表前需要说明公平条件：两组用同一测试集。',
            '表前必须解释各指标的方向。',
            '表后解释需结合原文细节。',
            '表后说明需要结合测量范围。',
            '表后需要解释误差类型。',
            '下表解释主要收益与限制。']) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1, text);
            assert.equal(issues[0].code, 'reader_workflow_leakage');
        }
        for (const text of ['作者在表后解释了误差原因。',
            '表前说明了固定的比较条件，结果不能直接外推。',
            '表后解释了误差为什么集中在短语边界。',
            '表中结果需要结合原文细节理解。',
            '上表显示主要收益与限制，较小模型仍存在误差。']) {
            assert.deepEqual(findReaderLanguageIssues(text), [], text);
        }
    });
});

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

describe('Manual v4 编辑质量的基础函数', () => {
    it('裸重复小数保留完整表面，分隔开的合法值保持独立', () => {
        assert.deepEqual(
            numericLexemes('MRR rises by 3.73.7, 2.82.8, and 0.50.5.'),
            ['3.73.7', '2.82.8', '0.50.5']
        );
        assert.deepEqual(
            numericLexemes('Separate reported values are 3.7 and 3.7; the range also includes 2.8.'),
            ['3.7', '3.7', '2.8']
        );
    });

    it('拦住精确的中文定量表述，但放行序数和含糊的非数字说法', () => {
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
        assert.deepEqual(findQuantitativeChineseNumerals('这一类任务采用声学核心与社会学残差的二分解释，形成有趣二分。'), []);
        assert.deepEqual(findQuantitativeChineseNumerals('耗时为数十毫秒。'), []);
        assert.ok(findQuantitativeChineseNumerals('命中率达到五成，类别比例为三比二，系统采用七十亿主干。')
            .some(item => item.reason === 'exact_fraction'));
        assert.ok(findQuantitativeChineseNumerals('命中率达到五成，类别比例为三比二，系统采用七十亿主干。')
            .some(item => item.reason === 'exact_ratio'));
        assert.deepEqual(findQuantitativeChineseNumerals(
            '待验证的问题有三：一是延迟，二是成本，三是泛化。'
        ).filter(item => item.reason === 'exact_ratio'), []);
        assert.ok(findQuantitativeChineseNumerals('男女样本比例为三：一，训练集按该比例划分。')
            .some(item => item.reason === 'exact_ratio'));
        assert.ok(findQuantitativeChineseNumerals('命中率达到五成，类别比例为三比二，系统采用七十亿主干。')
            .some(item => /七十亿主干/.test(item.match)));
        assert.ok(findQuantitativeChineseNumerals('阈值：三，系统训练三 GPU 小时，开销为三 mac、三 gb，评分范围为三至五等级。').length >= 5);
    });

    it('人物介绍中的一位保留白话，实验人数和位宽仍按数值检查', () => {
        assert.deepEqual(findQuantitativeChineseNumerals(
            '说话人信息以“这是一位 <gender> 性别、说 <language> 语言的说话人的录音”的形式给出。'
        ), []);
        assert.deepEqual(findQuantitativeChineseNumerals('这是一位刚开始研究语音的读者。'), []);
        for (const text of ['实验仅招募一位说话人。', '采用八位量化。',
            '这是一位量化编码，由说话人条件控制。', '这是一位精度参数，由用户选择。',
            '这是一位受试者的平均错误率测试结果。', '这是一位说话人的平均错误率。',
            '测试一位受试者。', '这是一位量化用户。',
            '这是一位。另一句提到说话人。']) {
            assert.ok(findQuantitativeChineseNumerals(text).some(item => /位$/u.test(item.match)), text);
        }
    });

    it('拦住技术性计数、格式错误的混合数字和批量写作套话', () => {
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
        assert.ok(findBrokenProse('该方法具有有吸引力，但结果有限，但仍可分析。').length >= 1);
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
        assert.deepStrictEqual(
            findBrokenProse('三类改写均导致性能下降，但 CodecSep 的回落更平缓且在两类上保持小幅领先，说明通道级掩蔽对词汇级变化有一定鲁棒性，但未测试含时序或关系结构的提示。'),
            [],
            '完整的二次转折不是残句'
        );
        const dangling = '模型在 2 个数据集上有一定鲁棒性，但';
        assert.ok(findBrokenProse(dangling).some(item => item.reason === 'dangling_connector'));
        const normalizedDangling = normalizeDanglingReaderConnectors(dangling);
        assert.strictEqual(normalizedDangling, '模型在 2 个数据集上有一定鲁棒性。');
        assert.deepStrictEqual(numericLexemes(normalizedDangling), numericLexemes(dangling));
        assert.strictEqual(
            normalizeDanglingReaderConnectors('完整句，但。\n\n后续完整句。'),
            '完整句。\n\n后续完整句。'
        );
        for (const protectedOrComplete of [
            '有一定鲁棒性，但未测试更复杂条件。',
            '“原句有一定鲁棒性，但”',
            '`literal，但`',
            '| 条件 | 结论，但 |'
        ]) {
            assert.strictEqual(normalizeDanglingReaderConnectors(protectedOrComplete), protectedOrComplete);
        }
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

    it('只归一化普通 Reader 正文里与问题绑定的阶段计数', () => {
        const source = [
            '训练采用三阶段课程。',
            '`三阶段` 与“原文三阶段”保持逐字。',
            '| 设置 | 三阶段 |',
            '| --- | --- |',
            '$三阶段$ 与 [[CONCEPT_BRIDGE_3]] 不动。',
            '```text',
            '三阶段',
            '```'
        ].join('\n');
        const issue = [{ path: null,
            message: '读者文章文风校验失败: quantitative_chinese_numeral:三阶段' }];
        const normalized = normalizeIssueBoundReaderQuantitativeNumerals(source, issue);
        assert.equal(normalized.split('3 个阶段').length - 1, 1);
        assert.ok(normalized.includes('`三阶段` 与“原文三阶段”保持逐字。'));
        assert.ok(normalized.includes('| 设置 | 三阶段 |'));
        assert.ok(normalized.includes('$三阶段$ 与 [[CONCEPT_BRIDGE_3]] 不动。'));
        assert.ok(normalized.includes('```text\n三阶段\n```'));
        assert.equal(normalizeIssueBoundReaderQuantitativeNumerals(source, []), source);
        assert.equal(normalizeIssueBoundReaderQuantitativeNumerals(source, [{ code:
            'quantitative_chinese_numeral', match: '两阶段' }]), source);
    });

    it('归一化与问题绑定的阿拉伯数字系数及其精确的万亿量级', () => {
        const source = '预训练规模约4万亿token；`4万亿token` 与“原文 4万亿token”保持逐字。';
        const issues = [{ path: null,
            message: '读者文章文风校验失败: quantitative_chinese_numeral:万亿 token' }];
        assert.equal(
            normalizeIssueBoundReaderQuantitativeNumerals(source, issues),
            '预训练规模约4,000,000,000,000 token；`4万亿token` 与“原文 4万亿token”保持逐字。'
        );
    });

    it('按已保存的问题记录，把原句中的简单中文计数转成数字', () => {
        const source = '模型包含三分支，并在一对测试样本上进行比较。';
        const issues = [
            { code: 'quantitative_chinese_numeral', match: '三分支' },
            { code: 'quantitative_chinese_numeral', match: '一对' }
        ];
        assert.equal(
            normalizeIssueBoundReaderQuantitativeNumerals(source, issues),
            '模型包含 3 分支，并在 1 对测试样本上进行比较。'
        );
    });

    it('不会把阿拉伯数字比较里的量级后缀读成中文量词', () => {
        assert.deepEqual(findQuantitativeChineseNumerals(
            '第一段约 500 万对 48 万，此外为 2,459 对 6,578。'
        ), []);
        assert.deepEqual(findQuantitativeChineseNumerals('训练集约2.7千对问答；纯中文千对仍需改写。'), [
            { match: '千对', index: 15, line: 1, reason: 'measured_large_integer' }
        ]);
    });

    it('接受单位由指标标签声明的比较数值', () => {
        assert.deepEqual(findMissingComparisonUnits(
            'WER（%）从 2.132 升到 2.175，SIM（无量纲）从 0.672 降到 0.668；'
            + '词错误率（WER，单位为%）从 2 到 4 到 8 时轻微上升。'
        ), []);
    });

    it('不会把实验组数当成指标值', () => {
        assert.deepEqual(findMissingComparisonUnits(
            '论文在 4 套测试上报告总体准确率等指标，并给出相对基线的提升幅度。'
        ), []);
    });

    it('不会把定性桥接里的数据集数量当成指标值', () => {
        assert.deepEqual(findMissingComparisonUnits(
            '证据是 2 数据集的准确率与消融下降。'
        ), []);
    });

    it('不会把说话人数量当成裸的百分比量级指标值', () => {
        assert.deepEqual(findMissingComparisonUnits(
            '说话人数从 1 人增至 4 人时性能一致下降，开源基线在超过 2 人时计数准确率接近零。'
        ), []);
    });

    it('拦住数字与单位粘连和数字损坏的中文连接词，但不误报标识符', () => {
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
        assert.ok(!findNumericTypographyDefects('输入是 1 段真人录制的语音加上 1 个任务提示。')
            .some(item => item.reason === 'broken_fixed_word'));
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

    it('只有当冗余编号和裸的编辑字段标签出现在读者可见的行里时才报', () => {
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

    it('拦住编辑字段里属于组装器的标题，以及重复渲染的标题', () => {
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

    it('能找出完全重复的长句，但不误报短的连接片段', () => {
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

    it('能找出跨小节的高置信近似重复，同时保留相关但独立写成的正文', () => {
        const sections = sixSections({
            summary: '在 EK-100 的固定 25% 调用预算下，间隔门控把动作覆盖率从 40.9% 提高到 46.8%，而声学筛选成本约为 3%。',
            results: '在 EK-100 固定 25% 调用预算下，加入间隔门控后，动作覆盖率由 40.9% 提升至 46.8%；声学前线成本约 3%。',
            details: '复现时需固定录像划分、调用计费边界、特征版本和随机种子；这些条件决定跨实现比较是否成立。'
        });
        assert.ok(findCrossSectionNearDuplicates(sections, { threshold: 0.28, minimumChars: 30 }).length >= 1);
        assert.equal(findCrossSectionNearDuplicates(sixSections(), { threshold: 0.65 }).length, 0);
    });

    it('拦住同一个多数字事实签名被三个以上核心小节复用', () => {
        const fact = '在测试集上，方法的 WER 从 14.3% 降至 12.6%，并把 F-score 从 62.2 提高到 81.7。';
        const sections = sixSections({ summary: fact, results: fact, details: fact });
        const findings = findCrossSectionNumericFactReuse(sections);
        assert.equal(findings.length, 1);
        assert.deepEqual(findings[0].occurrences.map(item => item.section), ['summary', 'results', 'details']);
        assert.equal(findCrossSectionNumericFactReuse(sixSections({ summary: fact, results: fact })).length, 0);
    });

    it('用两档段落长度，并把局限说明排除在防御性否定饱和统计之外', () => {
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

    it('对读者可见的作者小节和辅助小节也做段落过载检查', () => {
        const authorBlock = `作者团队围绕实验设计展开说明${'；这段作者叙事仍在重复机构信息'.repeat(24)}`;
        const findings = findLongParagraphs({ ...sixSections(), authors: authorBlock, openSource: '代码状态清楚。' });
        assert.ok(findings.some(item => item.section === 'authors' && item.severity === 'error'));
        const validation = validateEditorialQuality({ ...sixSections(), authors: authorBlock });
        assert.ok(validation.issues.some(item => item.code === 'paragraph_too_long' && item.section === 'authors'));
        assert.deepEqual(findLongParagraphs({ ...sixSections(), authors: `作者列表：甲${'；机构信息'.repeat(24)}` }), []);
    });

    it('能发现汉字与 ASCII 粘连，但忽略 URL 和行内代码', () => {
        const findings = findTechnicalTermAdhesions('推理时 LoRA缩放，Qwen-CoT在开发集选 gamma。指标为 F-score依赖设置。');
        assert.ok(findings.some(item => /LoRA缩/.test(item.match)));
        assert.ok(findings.some(item => /Qwen-CoT在/.test(item.match)));
        assert.ok(findTechnicalTermAdhesions('使用 **Conformer**编码器与 [Whisper](https://example.com)解码器。').length >= 2);
        assert.ok(findings.some(item => /F-score依/.test(item.match)));
        assert.deepEqual(findTechnicalTermAdhesions('推理时使用 LoRA 缩放；详见 `Qwen-CoT在代码中的键` 和 https://example.com/LoRA缩放。'), []);
        assert.deepEqual(findTechnicalTermAdhesions('S2为音频分支，S2用反向传播更新；T5模型只作编号对照。'), []);
        assert.deepEqual(findTechnicalTermAdhesions('比较 JSD-质量、AMI-日本语料和 L1-英语说话者。'), []);
        assert.deepEqual(
            findTechnicalTermAdhesions('增强版记作 GatherMOS-ZS*中。').map(item => item.match),
            ['GatherMOS-ZS*中']
        );
        assert.deepEqual(findTechnicalTermAdhesions('增强版记作 GatherMOS-ZS* 中。'), []);
    });

    it('能发现百分比得分差值和缺少邻近单位的非对称比较', () => {
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
        assert.deepEqual(findMissingComparisonUnits(
            '它在 2 个骨干上将区间命中率提升至 2 倍以上，HR0.2 从 0.21 升至 0.73。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '在对抗门控的 202 题上，准确率从 0.188 抬至 0.267，gap 从 0.376 扩大到 0.465。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits('mAP 从 0.781 提高到 0.801。'), []);
        assert.deepEqual(findMissingComparisonUnits(
            '图 2 统计前 10 个词的平均 CER：从第 2 至 3 位起优势显现，且在 HAT 上相对 TG-ASR 的分离更明显。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '早期 token 不再依赖脆弱前缀，从位置 2 到 3 之后显著降低错误率。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '图 3 显示 Base 优于上下文基线，Small 的 BLEU 高于 Medium，但 CER 反而更差。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '红色 BLEU 与蓝色 CER 并非单调：HAT 上 Small BLEU 45.9 高于 Medium 43.41，但绿色 Cos Sim 0.838 低于 0.864 且 CER 更差。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '重建侧 4 种配置在 WER 4.10-4.14、SPKSIM 0.86-0.90、UTMOS 4.24-4.30、PESQ-nb 3.49-3.53、STOI 0.94-0.95 上差异微小，无系统性下降。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '图 3 显示 VIBE 均优于 Video-Robin 与去掉阶段 5 的消融，四项准确率呈现单调提升。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '先看 T12 的 12-8-3 逐天音素错误率，基线随距最后训练日增加而爬升，ALIGN 全程更低。'
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
            findMissingComparisonUnits('先记录误检与词错误率，再用前 100 特征从小强度开始加，观察误检下降与词错误率上升的拐点。'),
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
        assert.deepEqual(findMissingComparisonUnits(
            '反例是 v2、v3、v4、v5 的微调即使加到 4 或 8 小时，也不降低新攻击漂移，等错误率表上 v3、v4、v5 本身起点已接近 0。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '比较 20 mm 与 100 mm 间距时，错误率的下降趋势一致。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '阵列从 2.5 m 扩展到 3 m 后，CER 的下降方向保持一致。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '房间由 4×6×3 m 缩小到 3×4×2 m，覆盖率仍有提升。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            '通过在真实语音上先学习说话人条件的韵律变异，再以同一目标为辅助联合优化伪造分类，'
            + '方法在两种训练分布下均显著降低了在 ASVspoof 2024 与情感化数据上的错误率，'
            + '同时在标准集上保持竞争力，消融也支持了 2 阶段设计的必要性。'
        ), []);
        const directionalMarkersAreNotUnits = findMissingComparisonUnits(
            '固定 Top-2 相对本方法词错误率（WER↓，越低越好）从 2.2 升至 3.1，制作质量（PQ↑）从 7.54 降至 7.47。'
        );
        assert.ok(directionalMarkersAreNotUnits.some(
            item => item.reason === 'percentage_metric_delta_without_unit'
        ));
        const asvspoofMissingUnits = findMissingComparisonUnits(
            '在 ASVspoof 2024 基准上，错误率从 24.5 降至 18.2。'
        );
        assert.ok(asvspoofMissingUnits.some(
            item => item.reason === 'percentage_metric_delta_without_unit'
        ));
        assert.deepEqual(findMissingComparisonUnits(
            '复现第一步做什么：先按上一节顺序打通文本侧对齐与 MelMAE 预训练，'
            + '再实现 drift 目标与同策略展开，用 λR 监控训练是否接近平衡，'
            + '最后在 NFE∈{1,2,4}上跑 MCD 与 WER，确认 K=4 相对 K=2 的改善能复现。'
        ), []);
        for (const text of [
            '在 NFE∈{1,2,4} 上比较 K=4 与 K=2，WER 从 4.18 降到 3.75。',
            '在 NFE∈{1,2,4} 上比较 K=4 与 K=2，CER=4.18 降低到 3.75。',
            '在 NFE∈{1,2,4} 上比较 K=4 与 K=2，错误率从 24.5 降至 18.2。',
            'WER 相对 K=4 的基线从 4.18 降到 3.75。'
        ]) {
            assert.ok(findMissingComparisonUnits(text).some(
                item => item.reason === 'percentage_metric_delta_without_unit'
            ), text);
        }
        assert.deepEqual(findMissingComparisonUnits(
            '端到端 Qwen 3-o 微调后的帧级准确率 0.633 已接近人工参考的 0.646，但描述 F1 0.422 仍低于 0.550。'
        ), []);
        assert.deepEqual(findMissingComparisonUnits(
            'EgoLife 上级联 Gemma 4 微调前的描述召回率、精确率、F1 依次为 0.085、0.560、0.147，微调后为 0.044、0.706、0.084，召回率下降而精确率上升，与论文的解释一致。'
        ), []);
        for (const text of [
            'Qwen 3-o 的 WER 从 4.18 降到 3.75。',
            'Gemma 4 微调后的错误率从 24.5 降至 18.2。',
            '未知型号 3-o 的准确率从 79.6 降到 72.8。',
            'Qwen 3-o 的 CER=4.18 降低到 3.75。'
        ]) {
            assert.ok(findMissingComparisonUnits(text).some(
                item => item.reason === 'percentage_metric_delta_without_unit'
            ), text);
        }
    });

    it('按配置的论文数阈值找出整批共用的句子模板', () => {
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

describe('Manual v4 可读性评分结构', () => {
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

    it('接受证据完整的评分，并套用 12/14 的下限，出零分即不通过', () => {
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

    it('拒绝缺失维度、笼统理由、空证据和未知键', () => {
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

describe('Manual v4 结构化结论声明', () => {
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

    it('接受三条本地绑定的结论，以及 NFKC 和空白等价下的连续引用', () => {
        const input = claims();
        input[0].sourceQuote = '在 EK-100 测试集、25% 调用预算下，\n间隔调度的动作覆盖率为 46.8%，直接排序为 40.9%。';
        const result = validateResultClaims(input, sourceText);
        assert.equal(result.valid, true, result.errors.join('\n'));
        assert.equal(result.minimumClaims, 3);
    });

    it('拒绝缺失字段、非来源引用，以及引用里找不到的数值', () => {
        const input = claims();
        delete input[0].baseline;
        input[1].sourceQuote = '这句话不在绑定全文里。';
        input[2].value = ['62.2', '91.7'];
        const result = validateResultClaims(input, sourceText);
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /baseline 缺失|未按 NFKC|91\.7 未出现在/);
    });

    it('要求精确的来源和 reader 绑定键，拒绝未绑定的字段证据', () => {
        const input = claims();
        input[0].sourceBindings.method = '不存在的方法证据';
        delete input[1].readerBindings.metric;
        input[2].readerBindings.unknown = '无关字段';
        const result = validateResultClaims(input, sourceText, { readerResultsText: sourceText });
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /sourceBindings\.method 不存在于本条 sourceQuote/);
        assert.match(result.errors.join('\n'), /readerBindings 必须且只能包含/);
    });

    it('拒绝重复结论、任意方向值，以及八个字段的片段复用', () => {
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

    it('不重载全文也能重新校验已存结论结构，并保留结论内的数字', () => {
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

    it('来源绑定的结果数字没出现在读者可见的实验小节里，就拒绝', () => {
        const result = validateResultClaims(claims(), sourceText, {
            readerResultsText: '实验结果只报告 46.8% 与 40.9%，其余设置见正文。'
        });
        assert.equal(result.valid, false);
        assert.match(result.errors.join('\n'), /readerBindings 未共同落在.*同一局部证据块/);
    });

    it('不让整个小节的数字冒充结论内的 reader 块', () => {
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

    it('把前导零小数、千位分隔符和小写英文数词视为等同', () => {
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

    it('允许显式的 notReported，但不许编造数字，混合哨兵值一律拒绝', () => {
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

    it('理论或定性文档必须给出显式的、来源绑定的例外', () => {
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

describe('Manual v4 汇总检查', () => {
    it('解析中文 Markdown 小节别名时，不会把下一个标题漏进上一段正文', () => {
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

    it('不会把概念性标题或不定指正文硬塞进阿拉伯数字计数', () => {
        const sections = sixSections({
            summary: '这不是一个好看的总分，而是对错误来源的拆解。',
            method: '### 两种视图如何给错误分账\n\n模型分别读取音高与节奏证据。'
        });
        const issues = validateEditorialQuality(sections).issues
            .filter(item => item.code === 'quantitative_chinese_numeral');
        assert.equal(issues.some(item => /一个|两种/.test(item.match || '')), false);
    });

    it('会校验渲染出来的三级 emoji 标题，而不是误报空通过', () => {
        const rendered = `### 👥 作者与机构\n作者列表：甲。\n\n`
            + `### 📌 核心摘要\n下1 步核对数据。\n\n`
            + `### 🔬 细节详述\n复现信息完整。\n\n`
            + `### 🚨 局限与问题\n证据有限。\n\n`
            + `### 进一步审视\n这段仍属于局限正文。`;
        const result = validateEditorialQuality(rendered);
        assert.ok(result.issues.some(item => item.section === 'summary' && item.code === 'numeric_typography'));
    });

    it('返回阻塞性问题，但不改动传入的小节', () => {
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


describe('论文评价的编辑质量检查', () => {
    it('评价两名混用按同一章节报告，代码示例不参与计数', () => {
        const text = '## 毒舌点评\n旧评价。\n\n## 论文评价\n新评价。';
        const duplicate = findDuplicateGeneratedHeadings(text);
        assert.equal(duplicate.length, 1);
        assert.equal(duplicate[0].title, '论文评价');
        assert.equal(duplicate[0].count, 2);
        assert.equal(validateEditorialQuality(text).issues.some(item => item.code === 'duplicate_generated_heading'), true);
        assert.deepEqual(findDuplicateGeneratedHeadings('```text\n## 毒舌点评\n```\n## 论文评价\n有效评价。'), []);
    });
});


describe('已记录数词问题的完整边界', () => {
    it('普通数词只更正独立数量，较长中文和混合数量保持原文', () => {
        const source = '三层；十三层；二十三层；一百三层；零点三层；负三层；3三层；三阶段；十三阶段；千层；一千层。';
        const issues = ['三层', '三阶段', '千层'].map(match => ({
            code: 'quantitative_chinese_numeral', match
        }));
        assert.equal(normalizeIssueBoundReaderQuantitativeNumerals(source, issues),
            '3 层；十三层；二十三层；一百三层；零点三层；负三层；3三层；3 个阶段；十三阶段；1,000 层；一千层。');
        assert.equal(normalizeIssueBoundReaderQuantitativeNumerals(source, []), source);
    });
});


describe('普通开销说明的英文碎片', () => {
    it('定位真实中英夹写，空格变化不改变判定', () => {
        for (const text of [
            '辅助模型带来额外memory与computation cost，更新比为5:1。',
            '辅助模型带来额外 memory 与 computation cost，更新比为5:1。'
        ]) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1);
            assert.equal(issues[0].code, 'reader_awkward_translation');
            assert.equal(text.slice(issues[0].index, issues[0].index + issues[0].match.length), issues[0].match);
            assert.match(issues[0].message, /数字、单位/);
        }
    });

    it('不拦科学边界、必要英文专名或正常中文计算解释', () => {
        const text = 'MemoryBank 是模型名。额外显存占用与计算开销分别测量，不作超出原文的线性外推。'
            + '原始权重除以归一化分母C，得到归一化权重。现有数据无法证明显存与更新次数存在线性关系。';
        assert.deepEqual(findReaderLanguageIssues(text), []);
    });

    it('原表、引文、代码和公式不变，表后普通正文仍定位', () => {
        const fragment = '额外 memory 与 computation cost';
        const text = `| 指标 | 说明 |\n| --- | --- |\n| 开销 | ${fragment} |\n\n`
            + `原文写道：“${fragment}”。\n\n\`${fragment}\`\n\n$${fragment}$\n\n`
            + `辅助模型带来${fragment}。`;
        const issues = findReaderLanguageIssues(text);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].index, text.lastIndexOf(fragment));
    });
});


describe('已恢复长文的表格标签与资源检查口吻', () => {
    it('真实正文标签与资源指导被拦，资源问题返回专用说明', () => {
        for (const text of ['表后解释：该表的作用是让后来者先对齐数据与评估。',
            '本文设置已对齐。表后解释：限制是只有一个数据集。',
            '表前说明该表只看法官为独立评估器的交换成功率。',
            '表前需要确认公平条件。']) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1, text);
            assert.equal(issues[0].code, 'reader_workflow_leakage');
        }
        for (const text of ['来源方面，原文未给出可直接使用的代码、模型或数据下载，复现需按原文引用自行准备，并区分代码、权重与可运行系统三件事，不得声称已公开。',
            '关于资源公开，依据本次收到的来源核查，没有发现完成 HTTPS 验证的作者代码、模型或数据资源，因此不能声称代码或权重已公开。',
            '关于可用性，本次没有收到经校验的作者代码、模型或数据链接，不得声称已公开。',
            '资源方面，未发现来源绑定且完成 HTTPS 验证的资源，不得声称代码、模型或数据已公开。']) {
            const issues = findReaderLanguageIssues(text);
            assert.equal(issues.length, 1, text);
            assert.match(issues[0].message, /资源是否公开/);
            assert.ok(!issues[0].message.includes('本表比较'));
        }
    });
    it('合理限制说明、作者描述及受保护原句继续保留', () => {
        for (const text of ['作者在表后解释了两种条件的差异。',
            '作者在表后解释：本实验只测一个数据集。',
            '没有对照实验，不能声称该方法更优。',
            '代码未公开，复现需要依照论文实现。',
            '来源方面，作者提供了代码，但没有发布模型权重。',
            '资源方面，论文没有提供代码链接。',
            '作者在表前需要确认公平条件，并在正文说明这项限制。',
            '> 资源方面，未发现来源绑定且完成 HTTPS 验证的资源，不得声称代码已公开。',
            '`表前需要确认公平条件` 是字符串。',
            '> 表后解释：该表比较两种条件。',
            '`表后解释：` 是字符串示例。',
            '原文写道：“来源方面，不得声称已公开。”',
            '| 原句 | 数值 |\n| --- | --- |\n| 表后解释：该表比较两组。 | 12 |']) {
            assert.deepEqual(findReaderLanguageIssues(text), [], text);
        }
    });
});


describe('百分比指标与同一裸数值就近绑定', () => {
    it('真实评估模型名和训练设置不能跨位置拼成缺百分比单位', () => {
        const examples = [
            '训练用专家是 emotion2vec 做情感分类、WavLM 做说话人验证、Whisper 做语音识别，评估用另一套模型，即基于 XLSR-53 的情感分类器、ECAPA-TDNN 做说话人验证、wav2vec2.0 算词错误率、UTMOS 评估自然度，这种训练与评估模型不一致的设计减少了自卖自夸，更能说明泛化。',
            '论文直接报告的是在 3 个 7B 模型和 3 个基准子集上的准确率提升，训练数据固定为 50,000 条工具库问答，路由固定取前 2，K 固定为 6。'
        ];
        for (const text of examples) assert.deepEqual(findMissingComparisonUnits(text), [], text);
    });
    it('同句模型设置旁仍有真实裸准确率或错误率时继续拒绝', () => {
        for (const text of ['wav2vec2.0 的词错误率降低到 12.5。',
            '三个模型在相同设置下准确率提高到 88.75。',
            'XLSR-53 与另一套模型相比，准确率提高到 87.5。',
            '模型固定取前 2，词错误率从 7.3 降至 5.4。',
            '真实测试集词错误率为 5.23 对 5.97%。',
            '准确率提高到 5,000。',
            '准确率提高到 0,005。']) {
            assert.ok(findMissingComparisonUnits(text).length > 0, text);
        }
    });
});


describe('远距指标的显式成对比较', () => {
    it('模型和基准计数不能遮蔽真实裸结果比较', () => {
        assert.ok(findMissingComparisonUnits('准确率在3个基准子集上与另外2个模型相比从88.75提高到90.25。').length > 0);
        assert.deepEqual(findMissingComparisonUnits('准确率在3个基准子集上与另外2个模型相比从88.75%提高到90.25%。'), []);
        assert.deepEqual(findMissingComparisonUnits('准确率在3个基准子集上与另外2个模型相比有所提高。'), []);
    });
});

it('其他分句的网络层数不得作为指标比较值', () => {
    assert.deepEqual(findMissingComparisonUnits('准确率相比基线有所提升，其他训练参数保持同样的选择策略，网络层数从3增加到6。'), []);
    assert.ok(findMissingComparisonUnits('网络层数从3增加到6，词错误率在3个基准子集上与另外2个模型相比从88.75降低到90.25。').length > 0);
});

it('同分句远距单结果提升仍须有单位', () => {
    for (const verb of ['提升至', '提高到']) {
        assert.ok(findMissingComparisonUnits(`准确率在3个基准子集上与另外2个模型相比${verb}90.25。`).length > 0);
        assert.deepEqual(findMissingComparisonUnits(`准确率在3个基准子集上与另外2个模型相比${verb}90.25%。`), []);
        assert.deepEqual(findMissingComparisonUnits(`准确率有所提升，网络层数${verb}6。`), []);
    }
});

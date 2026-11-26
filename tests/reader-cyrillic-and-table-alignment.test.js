'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const {
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    findCyrillicProseGarbleIssues,
    validateCyrillicProseGarbleContract,
    validateAnalysisEditorialLeakageContract,
    findMisalignedTableCommentaryIssues,
    validateTableCommentaryAlignmentContract,
    validateExperimentTableContract,
    getInvalidAnalysisReason
} = require('../scripts/analysis-contract.js');
const {
    getReadOnlyValidationAnalysisRunSummary
} = require('../scripts/analysis-engine.js');
const {
    parseAnalysis
} = require('../scripts/utils.js');
const {
    validAnalysisText,
    validLegacyApiAnalysisPaper
} = require('./valid-analysis-fixture.js');
const {
    findReaderLanguageIssues,
    validateEditorialQuality
} = require('../scripts/editorial-quality.js');
const readerRepair = require('../scripts/lib/reader-repair.js');
const deep = require('../scripts/deep-analyzer.js');

const ROOT = path.resolve(__dirname, '..');

function buildValidReaderDraftFixture() {
    const kinds = [
        'background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'
    ];
    const draft = {
        version: 3,
        readerTitle: '跨模态共识解码与音视频幻觉抑制机制解析',
        oneSentenceThesis: '方法利用层内来源证据进行置信度仲裁与共识恢复，在固定主干参数与统一评测口径下提升多模态判别准确率。',
        sections: kinds.map((kind, index) => ({
            kind,
            heading: `阶段 ${index + 1} 的输入约束与输出证据如何衔接？`,
            body: [
                `进入第 ${index + 1} 个教学阶段时，先固定这一阶段的输入张量、控制变量和失败现象。读者需要明确当前处理哪一类多模态信号，它经过怎样的特征变换，以及哪项可观测差异能够证明该步骤确实生效。`,
                `第 ${index + 1} 个环节对应的教学类型是 ${kind}，它把对比基线、指标方向和样本边界放在同一协议下核对。只有保持输入帧率、提示模板与解码候选完全一致，后续指标变化才具备因果解释力。`,
                `从数据流向看，原始音视频观测先映射为层内表示，仲裁模块再筛除低置信度模态噪声，恢复分支最后将跨层一致性信号汇入输出分布。跳过任一环节都会把表面共现误判为跨模态对齐。`,
                `在证据边界上，正面收益与失效条件需要同时呈现。评测集上的准确率提升只能支撑当前判别式问答设定下的结论，未覆盖的长时开放生成与高噪声部署场景仍需单独复验。`,
                `完成第 ${index + 1} 阶段的分步核验后，还须记录输入采样分布变化对中间统计量的扰动，以便读者判断何时需要重标定阈值。`,
                `因此，第 ${index + 1} 阶段向下一节移交的是一组可检验的核对条件：哪些结论有原表数值直接支撑，哪些机制推断依赖消融对照，哪些外推超出当前实验范围。`
            ].join('\n\n')
        })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: [`置信度仲裁${index + 1}`, `共识恢复${index + 1}`],
            sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: `置信度仲裁${index + 1}负责压制单模态高方差噪声，共识恢复${index + 1}负责补回被误抑的跨模态一致线索。两者协同后才能在不重训主干的前提下稳住判别输出。`
        })),
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: []
    };
    draft.sections[3].body += '\n\n' + draft.conceptBridges.map(item => item.marker).join('\n\n');
    return draft;
}

test('D1：检测中文正文中混入的西里尔字母乱码词（含中英文括号与冒号/分号旁路），并定位到对应 Reader 节点', () => {
    for (const sample of [
        '这张图确实可见Alif实线从0.84附近 быстро爬到0.96附近封顶，Shin点线从0.30附近爬到0.62附近。',
        '从 0.84 附近 быстро爬到 0.96 附近封顶。',
        '训练中期模型быстро收敛并保持稳定。',
        '收敛速度быстро，但高噪声下方差较大。',
        'быстро收敛并不代表泛化更好。',
        '结果是：быстро。',
        '收敛速度（быстро）提升。',
        '实验结论(быстро)表明收敛更快；быстро；后续平稳。'
    ]) {
        const findings = findCyrillicProseGarbleIssues(sample);
        assert.ok(findings.length >= 1, `应拦截西里尔乱码: ${sample}`);
        assert.equal(findings[0].code, 'cyrillic_prose_garble');
        assert.match(findings[0].message, /西里尔字母乱码词/);
        assert.match(validateCyrillicProseGarbleContract(sample) || '', /西里尔字母乱码词/);
        assert.match(
            validateAnalysisEditorialLeakageContract(sample, { enforceCyrillicProseGarble: true }) || '',
            /西里尔字母乱码词/
        );
        assert.equal(validateAnalysisEditorialLeakageContract(sample), null, '默认冷核入口不应回溯拦截历史归档');

        const readerIssues = findReaderLanguageIssues(sample);
        assert.ok(readerIssues.some(item => item.code === 'reader_awkward_translation'
            && /西里尔字母乱码词/.test(item.message)), `editorial-quality 应拦截: ${sample}`);
    }

    const draft = {
        version: 3,
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

test('D1：英文斯拉夫作者名、2610.30385 俄语语境单字母 ё、parseApiReaderArticleResult sourceText 透传豁免与 2611.10973 冷核兼容', () => {
    const negatives = [
        'Markov, Kolmogorov (1950) gave the foundational formulation for stochastic chains.',
        'Марков, Колмогоров (1950).\n本文在此离散状态转移假设上进一步引入声学观测先验。',
        '代码调用 `tokenizer.encode("быстро")` 测试多语种分词鲁棒性。',
        '```python\nword = "быстро"  # 俄语测试输入\n```\n模型只统计子词长度。',
        '链接 https://example.org/быстро/音频样本 不作为正文词元检查。',
        '> 引用块中的原始语料：быстро 仅作输入示例。',
        '原文写道：“модель быстро сходится” 以说明俄语日志样例。',
        '俄语有关键术语、概念词、主导词、语义 доминанта等，英语有 keyword 与 keyphrase。',
        '预处理先把俄文字母ё归并为е以统一词形。\n\n实验对比了去标点和ё归并前后的词错率变化。',
        '| 语言 | 样例 |\n| --- | --- |\n| 语料 | быстро |\n\n上表展示了多语种测试集中的原始词形样例。'
    ];
    for (const sample of negatives) {
        assert.deepEqual(findCyrillicProseGarbleIssues(sample), [], `不应误报: ${sample}`);
        assert.equal(
            validateAnalysisEditorialLeakageContract(sample, { enforceCyrillicProseGarble: true }),
            null
        );
        assert.equal(
            findReaderLanguageIssues(sample).filter(item => /西里尔字母乱码词/.test(item.message)).length,
            0,
            `findReaderLanguageIssues 不应误报: ${sample}`
        );
    }

    // 跨小节俄语语境下的单字母正字法讨论（模拟 2610.30385v1 分节情形）
    const russianOrthographyDraft = {
        readerTitle: '俄语语音识别中的文本规范化与词错率评估',
        oneSentenceThesis: '统一俄语文本规范化规则后，声学模型在多领域测试集上的表面词错率显著下降。',
        sections: [
            {
                kind: 'method_overview',
                heading: '俄语文本规范化包含哪些步骤',
                body: '俄语转写文本在评测前统一转为小写并移除标点符号，同时处理俄文字母变体。'
            },
            {
                kind: 'result',
                heading: '规范化前后词错率变化说明了什么',
                body: '实验对比了去标点和ё归并前后的词错率差异，说明部分误差来自拼写习惯而非声学混淆。'
            }
        ],
        conceptBridges: [],
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: []
    };
    assert.deepEqual(readerRepair.collectReaderLanguageIssues(russianOrthographyDraft), []);

    // 端到端 parseApiReaderArticleResult：sourceText 含西里尔词元时豁免通过，缺失时以 READER_PROSE_LANGUAGE 拦截
    const html = [
        '<html><body>',
        '<p>We retain the original annotation label доминанта in cross-lingual alignment experiments, achieving 82.4 and 77.3 accuracy under identical settings.</p>',
        '<figure class="ltx_table" id="S4.T1"><figcaption>Table 1: Cross-lingual accuracy.</figcaption>',
        '<table><tr><td>Method</td><td>CMM</td><td>AVHBench</td></tr>',
        '<tr><td>Baseline</td><td>77.3</td><td>72.6</td></tr>',
        '<tr><td>Proposed</td><td>82.4</td><td>80.6</td></tr></table></figure>',
        '<figure class="ltx_table" id="S4.T2"><figcaption>Table 2: Ablation accuracy.</figcaption>',
        '<table><tr><td>Variant</td><td>OmniVideoBench</td><td>FutureOmni</td></tr>',
        '<tr><td>Base</td><td>27.5</td><td>38.8</td></tr>',
        '<tr><td>Full</td><td>31.1</td><td>40.0</td></tr></table></figure>',
        '</body></html>'
    ].join('');
    const sourceWithCyrillic = cheerio.load(html)('body').text();
    const sourceWithoutCyrillic = sourceWithCyrillic.replace('доминанта', 'dominanta');
    const artifactsWithCyrillic = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99991', '2611.99991'),
        sourceWithCyrillic
    );
    const artifactsWithoutCyrillic = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html.replace('доминанта', 'dominanta'), '2611.99991', '2611.99991'),
        sourceWithoutCyrillic
    );

    const readerDraftWithSourceToken = buildValidReaderDraftFixture();
    readerDraftWithSourceToken.sections[4].body += '\n\n数据集保留了原始标注标签 доминанта 用于跨语种对齐实验，以便核对词形边界。';
    readerDraftWithSourceToken.sections[7].body += '\n\n下表比较跨语种基准上的准确率，输入条件与评测划分保持一致。\n\n[[TABLE_1]]\n\n'
        + '该表支撑的判断是，Proposed 在 CMM 与 AVHBench 上分别达到 82.4 与 80.6，高于 Baseline 的 77.3 与 72.6。限制是仅覆盖两个基准。';
    readerDraftWithSourceToken.sections[8].body += '\n\n下表比较消融变体在泛化基准上的表现，主干参数固定不变。\n\n[[TABLE_2]]\n\n'
        + '该表支撑的判断是，Full 在 OmniVideoBench 与 FutureOmni 上达到 31.1 与 40.0，高于 Base 的 27.5 与 38.8。限制是未覆盖流式推理。';
    readerDraftWithSourceToken.tableBindings = [
        { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
        { tableIndex: 2, completeTable: { sourceTableOrdinal: 2 } }
    ];

    assert.doesNotThrow(() => deep.parseApiReaderArticleResult(JSON.stringify(readerDraftWithSourceToken), {
        sourceText: sourceWithCyrillic,
        structuredArtifacts: artifactsWithCyrillic,
        requiredVersion: 3,
        requireSourceBindings: true,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2
    }));

    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(readerDraftWithSourceToken), {
            sourceText: sourceWithoutCyrillic,
            structuredArtifacts: artifactsWithoutCyrillic,
            requiredVersion: 3,
            requireSourceBindings: true,
            requireIntegratedTables: true,
            minimumIntegratedTables: 2
        }),
        error => error?.code === readerRepair.LANGUAGE_ERROR_CODE
            && Array.isArray(error.readerIssues)
            && error.readerIssues.some(issue => issue.path === '/sections/4/body' && /доминанта/.test(issue.match))
    );

    // 历史归档冷核兼容（模拟 2611.10973 含“位置 старше 6 秒”在只读冷核汇总下保持 complete，在线显式开启时拦截）
    const crypto = require('node:crypto');
    const archivedLegacyRecord = validLegacyApiAnalysisPaper('2611.10973v1');
    archivedLegacyRecord.analysis = archivedLegacyRecord.analysis.replace(
        '## 细节详述\n',
        '## 细节详述\n预处理阶段位置 старше 6 秒或缺距离高度的行被丢弃，以保证轨迹窗口完整。\n'
    );
    archivedLegacyRecord.parsed = parseAnalysis(archivedLegacyRecord.analysis);
    archivedLegacyRecord.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = crypto
        .createHash('sha256').update(archivedLegacyRecord.analysis).digest('hex');
    assert.equal(getInvalidAnalysisReason(archivedLegacyRecord.analysis, archivedLegacyRecord.parsed, {
        enforceExperimentTableContract: false,
        enforceMethodDetailContract: false
    }), null);
    assert.deepEqual(
        getReadOnlyValidationAnalysisRunSummary([archivedLegacyRecord]),
        { success: 1, remaining: 0, status: 'complete' }
    );
    assert.match(
        getInvalidAnalysisReason(archivedLegacyRecord.analysis, archivedLegacyRecord.parsed, {
            enforceExperimentTableContract: false,
            enforceMethodDetailContract: false,
            enforceCyrillicProseGarble: true,
            sourceText: 'Rows older than 6 seconds or missing range/altitude are discarded.'
        }) || '',
        /西里尔字母乱码词/
    );
});

test('D2：经 parseApiReaderArticleResult（selection 与 completeTable）端到端拦截错位评述，且 5+ 表草稿仅精确授权错位节点', () => {
    const html = [
        '<html><body>',
        '<p>Table 1 reports hallucination accuracy on CMM, AVHBench, and SVHalluc. Table 2 reports weighting strategies on CMM, AVHBench, and SVHalluc. Table 3 reports routing components on CMM, AVHBench, and SVHalluc. Table 4 reports generalization on OmniVideoBench and FutureOmni. Table 5 reports latency in ms and memory in GB.</p>',
        '<figure class="ltx_table" id="S4.T1"><figcaption>Table 1: Main hallucination results.</figcaption>',
        '<table><thead><tr><th>Method</th><th>CMM</th><th>AVHBench</th><th>SVHalluc</th></tr></thead><tbody>',
        '<tr><td>VideoLLaMA2-AV-7B</td><td>77.3</td><td>72.6</td><td>51.7</td></tr>',
        '<tr><td>PACD</td><td>82.4</td><td>80.6</td><td>60.4</td></tr>',
        '<tr><td>Qwen2.5-Omni-7B</td><td>68.4</td><td>75.5</td><td>64.7</td></tr></tbody></table></figure>',
        '<figure class="ltx_table" id="S4.T2"><figcaption>Table 2: Weighting strategies.</figcaption>',
        '<table><thead><tr><th>Strategy</th><th>CMM</th><th>AVHBench</th><th>SVHalluc</th></tr></thead><tbody>',
        '<tr><td>Base</td><td>82.4</td><td>71.1</td><td>50.9</td></tr>',
        '<tr><td>Uniform</td><td>85.9</td><td>73.7</td><td>52.6</td></tr>',
        '<tr><td>Argmax</td><td>84.3</td><td>72.7</td><td>53.6</td></tr>',
        '<tr><td>MAD</td><td>85.4</td><td>75.1</td><td>53.9</td></tr>',
        '<tr><td>PACD</td><td>87.4</td><td>78.8</td><td>63.7</td></tr></tbody></table></figure>',
        '<figure class="ltx_table" id="S4.T3"><figcaption>Table 3: Component ablation.</figcaption>',
        '<table><thead><tr><th>Variant</th><th>CMM</th><th>AVHBench</th><th>SVHalluc</th></tr></thead><tbody>',
        '<tr><td>Routing</td><td>83.5</td><td>74.3</td><td>53.6</td></tr>',
        '<tr><td>RGCA</td><td>86.9</td><td>77.7</td><td>54.0</td></tr>',
        '<tr><td>PACD</td><td>87.4</td><td>78.8</td><td>63.7</td></tr></tbody></table></figure>',
        '<figure class="ltx_table" id="S4.T4"><figcaption>Table 4: Generalization benchmarks.</figcaption>',
        '<table><thead><tr><th>Model</th><th>OmniVideoBench</th><th>FutureOmni</th></tr></thead><tbody>',
        '<tr><td>VideoLLaMA2-AV</td><td>27.5</td><td>38.8</td></tr>',
        '<tr><td>VideoLLaMA2-AV+MAD</td><td>28.3</td><td>36.3</td></tr>',
        '<tr><td>VideoLLaMA2-AV+PACD</td><td>31.1</td><td>40.0</td></tr>',
        '<tr><td>OmniVinci+MAD</td><td>32.5</td><td>51.7</td></tr>',
        '<tr><td>OmniVinci+PACD</td><td>34.8</td><td>53.5</td></tr></tbody></table></figure>',
        '<figure class="ltx_table" id="S4.T5"><figcaption>Table 5: Runtime overhead.</figcaption>',
        '<table><thead><tr><th>Config</th><th>LatencyMs</th><th>PeakMemGB</th></tr></thead><tbody>',
        '<tr><td>Standard</td><td>41.2</td><td>15.4</td></tr>',
        '<tr><td>PACD</td><td>46.8</td><td>16.1</td></tr></tbody></table></figure>',
        '</body></html>'
    ].join('');
    const sourceText = cheerio.load(html)('body').text();
    const structuredArtifacts = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2611.22456', '2611.22456'),
        sourceText
    );
    const parserOptions = {
        sourceText,
        structuredArtifacts,
        requiredVersion: 3,
        requireSourceBindings: true,
        requireIntegratedTables: true,
        minimumIntegratedTables: 4
    };

    const buildFiveTableDraft = ({ permuted }) => {
        const draft = buildValidReaderDraftFixture();
        const commentaryForTable2 = '该表支撑的判断是，Uniform 与 Argmax 两种简化加权在 CMM、AVHBench 与 SVHalluc 上均低于 PACD 的 87.4、78.8 与 63.7。限制是该消融仅在单一主干上完成。';
        const commentaryForTable4 = '该表支撑的判断是，在 VideoLLaMA2-AV 与 OmniVinci 的 OmniVideoBench 与 FutureOmni 上 PACD 全面高于 MAD，无需额外训练即可迁移。限制是泛化评估仅覆盖两个通用基准。';

        draft.sections[6].body += '\n\n下表比较两个主干在三个幻觉基准上的主结果准确率，候选集合保持一致。\n\n[[TABLE_1]]\n\n'
            + '该表支撑的判断是，PACD 在 CMM、AVHBench 与 SVHalluc 上达到 82.4、80.6 与 60.4，显著高于 VideoLLaMA2-AV-7B 基线。限制是仅覆盖判别式问答。';
        draft.sections[7].body += '\n\n下表通过 selection 抽取简化加权策略对比，固定相同融合系数。\n\n[[TABLE_2]]\n\n'
            + (permuted ? commentaryForTable4 : commentaryForTable2);
        draft.sections[8].body += '\n\n下表拆分路由与仲裁组件的独立贡献，保持解码超参数不变。\n\n[[TABLE_3]]\n\n'
            + '该表支撑的判断是，RGCA 在 CMM 与 AVHBench 上把 Routing 的 83.5 与 74.3 提升到 86.9 与 77.7，完整 PACD 在 SVHalluc 上进一步达到 63.7。限制是未单独拆出极端长视频子集。';
        draft.sections[9].body += '\n\n下表通过 completeTable 给出通用音视频推理与未来预测基准上的泛化表现。\n\n[[TABLE_4]]\n\n'
            + (permuted ? commentaryForTable2 : commentaryForTable4);
        draft.sections[10].body += '\n\n下表比较标准解码与共识解码的单步延迟与显存开销，批大小固定为 1。\n\n[[TABLE_5]]\n\n'
            + '该表支撑的判断是，PACD 的 LatencyMs 从 41.2 增至 46.8，PeakMemGB 从 15.4 增至 16.1，推理开销可控。限制是未统计多卡并发吞吐。';

        draft.tableBindings = [
            { tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } },
            { tableIndex: 2, selection: { sourceTableOrdinal: 2, sourceRows: [0, 2, 3, 4, 5], sourceColumns: [0, 1, 2, 3] } },
            { tableIndex: 3, completeTable: { sourceTableOrdinal: 3 } },
            { tableIndex: 4, selection: { sourceTableOrdinal: 4, sourceRows: [0, 2, 3, 4, 5], sourceColumns: [0, 1, 2] } },
            { tableIndex: 5, completeTable: { sourceTableOrdinal: 5 } }
        ];
        return draft;
    };

    // 对齐的 selection + completeTable 5 表草稿完整通过 parseApiReaderArticleResult
    const alignedDraft = buildFiveTableDraft({ permuted: false });
    assert.doesNotThrow(() => deep.parseApiReaderArticleResult(JSON.stringify(alignedDraft), parserOptions));

    // 错位的 selection + completeTable 5 表草稿即使经 omitReaderSelectedTablesForProseCheck 删表，仍被完整表校验层精准拦截
    const permutedDraft = buildFiveTableDraft({ permuted: true });
    let caughtError = null;
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(permutedDraft), parserOptions),
        error => {
            caughtError = error;
            return error?.code === 'table_commentary_misaligned'
                && Array.isArray(error.readerIssues)
                && error.readerIssues.length === 2;
        }
    );

    // 验证 5+ 张表草稿的局部修复目标：严格只授权错位涉及的 sections[7]/sections[9] 与 tableBindings[1]/tableBindings[3]
    const collectedIssues = readerRepair.collectDraftIssues(permutedDraft, caughtError);
    const repairTargets = readerRepair.buildRepairTargets(permutedDraft, collectedIssues, { sourceText });
    assert.deepEqual(
        repairTargets.map(target => target.path),
        ['/sections/7/body', '/sections/9/body', '/tableBindings/1', '/tableBindings/3']
    );

    // 主分析实验结果契约在显式开启 enforceTableCommentaryAlignment 时拦截错位，默认冷核模式不拦截
    const twoTablePermutedResults = [
        '## 实验结果',
        '',
        '第一组消融比较检验均匀与独热简化策略相对完整 PACD 的差异，固定同一主干与融合系数。',
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
    assert.equal(validateExperimentTableContract(twoTablePermutedResults, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: '经验研究',
        sourceText: 'Table 1 ablation baseline worse than PACD.'
    }), null);
    assert.match(validateExperimentTableContract(twoTablePermutedResults, {
        contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
        documentType: '经验研究',
        sourceText: 'Table 1 ablation baseline worse than PACD.',
        enforceTableCommentaryAlignment: true
    }) || '', /疑似多表与表后评述错位/);
});

test('D2：对齐多表评述、2610.32332 双表联合评述与 2610.33377 一位整数及带负号差分绝对值均零误报', () => {
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

    // 2610.32332v1：首句使用“两表…”联合评述上下两张表时不得把第二句拼入单表 opening 误判
    const jointTwoTableArticle = [
        '### 裁判快照与模型排名稳定性',
        '',
        '下表给出第一组基准上的分模型裁判得分。',
        '',
        '| Model | ArenaHard | WildBench |',
        '| --- | --- | --- |',
        '| AlphaLM | 61.2 | 54.8 |',
        '| BetaLM | 58.9 | 51.3 |',
        '',
        '接着给出第二组基准上的汇总胜率表。',
        '',
        '| System | OverallWin | RankShift |',
        '| --- | --- | --- |',
        '| GammaChat | 64.5 | 1 |',
        '| DeltaChat | 59.1 | 2 |',
        '',
        '两表对应同一快照的三裁判结果。即便在 ArenaHard 与 WildBench 上 AlphaLM 与 BetaLM 的分差较小，整体胜率顺序依然保持一致。'
    ].join('\n');
    assert.deepEqual(findMisalignedTableCommentaryIssues(jointTwoTableArticle), []);

    // 2610.33377v1：一位整数与带负号差分绝对值（表中 -4.7，正文写“下降 4.7 分”或引用一位整数 3）不得误报
    const signedDeltaAndSingleDigitArticle = [
        '### 主实验与长上下文退化分析',
        '',
        '下表列出不同方法在标准评测集上的主指标。',
        '',
        '| Method | HotpotQA | MuSiQue |',
        '| --- | --- | --- |',
        '| Baseline | 52.1 | 38.4 |',
        '| Ours | 58.6 | 44.9 |',
        '',
        '该表说明 Ours 在 HotpotQA 与 MuSiQue 上均优于 Baseline。',
        '',
        '下表进一步给出跳数桶与消融差分。',
        '',
        '| Setting | HopCount | DeltaScore |',
        '| --- | --- | --- |',
        '| RemoveMemory | 3 | -4.7 |',
        '| RemovePrune | 4 | -1.9 |',
        '',
        '当问题复杂度达到 3 跳且移除记忆模块时，相对完整版在 HotpotQA 与 MuSiQue 汇总口径上平均下降 4.7 个点，说明多跳推理最依赖该模块。'
    ].join('\n');
    assert.deepEqual(findMisalignedTableCommentaryIssues(signedDeltaAndSingleDigitArticle), []);
});

test('C2 与 D5：现用 Reader 与局部修复提示词包含列头单位证据、最低表数与图例排他量词核对指引', () => {
    const articlePrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-article.md'), 'utf8');
    const repairPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/api-reader-repair.md'), 'utf8');

    assert.match(articlePrompt, /source_quotes.*(?:列头|单位)/);
    assert.match(articlePrompt, /GiB/);
    assert.match(articlePrompt, /图例线型\/颜色\/填充/);
    assert.match(articlePrompt, /全部\/唯一/);
    assert.match(articlePrompt, /\{mechanicalContract\}/);

    assert.match(repairPrompt, /source_quotes.*(?:列头|单位)/);
    assert.match(repairPrompt, /GiB/);
    assert.match(repairPrompt, /裸数字/);
    assert.match(repairPrompt, /不少于 4 张/);
    assert.match(repairPrompt, /p <= 0\.05/);
    assert.match(repairPrompt, /斜纹/);
    assert.match(repairPrompt, /“全部”“所有”“只有”“唯一”/);
    assert.match(repairPrompt, /条件.*图例颜色.*方法行名/);
});

test('主分析在线 getRepairableAnalysisStructureIssues 与补表判定对称开启 D1/D2，默认冷迁移模式保持关闭', async () => {
    const baseAnalysis = validAnalysisText();

    // 1. 主分析含西里尔乱码词：默认冷迁移模式不报错，在线开启模式精准报错，且 sourceText 含原词时豁免
    const cyrillicAnalysis = baseAnalysis.replace(
        '## 细节详述\n',
        '## 细节详述\n训练中期模型быстро收敛并保持稳定。\n'
    );
    assert.deepEqual(
        deep.getRepairableAnalysisStructureIssues(cyrillicAnalysis, {
            sourceText: 'The model converges rapidly at mid-training.'
        }),
        []
    );
    const onlineCyrillicIssues = deep.getRepairableAnalysisStructureIssues(cyrillicAnalysis, {
        sourceText: 'The model converges rapidly at mid-training.',
        enforceCyrillicProseGarble: true,
        enforceTableCommentaryAlignment: true
    });
    assert.equal(onlineCyrillicIssues.length, 1);
    assert.match(onlineCyrillicIssues[0], /西里尔字母乱码词/);
    assert.deepEqual(
        deep.getRepairableAnalysisStructureIssues(cyrillicAnalysis, {
            sourceText: 'We retain token быстро in raw logs.',
            enforceCyrillicProseGarble: true,
            enforceTableCommentaryAlignment: true
        }),
        []
    );

    // 2. 主分析实验结果两表评述错位：默认冷迁移模式不报错，在线开启模式与 analysisNeedsExperimentTableRepair 对称报错
    const permutedResultsSection = [
        '## 实验结果',
        '',
        '第一组消融比较检验均匀与独热简化策略相对完整 PACD 的差异，固定同一主干与融合系数。',
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
    const permutedAnalysis = baseAnalysis.replace(
        /## 实验结果\n[\s\S]*?(?=\n## 细节详述)/,
        permutedResultsSection
    );
    const tableSource = 'Table 1 ablation baseline worse than PACD.';

    assert.deepEqual(
        deep.getRepairableAnalysisStructureIssues(permutedAnalysis, { sourceText: tableSource }),
        []
    );
    const onlineTableIssues = deep.getRepairableAnalysisStructureIssues(permutedAnalysis, {
        sourceText: tableSource,
        enforceCyrillicProseGarble: true,
        enforceTableCommentaryAlignment: true
    });
    assert.equal(onlineTableIssues.length, 1);
    assert.match(onlineTableIssues[0], /疑似多表与表后评述错位/);
    assert.equal(deep.analysisNeedsExperimentTableRepair(permutedAnalysis, tableSource), true);
    await assert.rejects(
        () => deep.finalizeStructureRepairOutput(
            { arxivId: '2611.22456', title: 'Table Alignment Check' },
            permutedAnalysis,
            tableSource
        ),
        /疑似多表与表后评述错位/
    );
});

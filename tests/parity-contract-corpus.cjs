'use strict';

// 「双实现」对照语料库。
//
// 同一批发布规则在 Node（scripts/analysis-contract.js、scripts/editorial-quality.js）
// 与 Python（scripts/publish_common.py）各写一份。这个模块只负责三件事：
//   1. 用同一批可读语料描述每条规则的正例、反例与边界例；
//   2. 在 Node 侧直接调用公开入口得出结论；
//   3. 作为 CLI 探针（node tests/parity-contract-corpus.cjs）把任务清单和 Node
//      结论一起输出，供 Python 侧测试复用同一批语料。
//
// 不修改 scripts/ 下任何实现；两边结论不一致时由测试按 KNOWN_DIVERGENCES 记录，
// 并在报告里列成「当前不一致清单」。

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const contract = require(path.join(ROOT, 'scripts', 'analysis-contract.js'));
const editorial = require(path.join(ROOT, 'scripts', 'editorial-quality.js'));

const DOCUMENT_TYPE = '方法研究';
const NEUTRAL_SOURCE = 'We compare methods on the same test set.';

const BEFORE = '下表比较同一测试集上不同设置的对象，回答条件是否改变错误率。';
const AFTER = '乙相比甲的错误率有所下降，但结论仅适用于上述比较条件，未验证其他语言、数据规模、'
    + '噪声条件或设备中的结果，因此不能直接推断泛化效果。';

function markdownTable(header, rows = [['甲', '12.4%'], ['乙', '10.8%'], ['丙', '9.7%']], metric = 'WER ↓') {
    return [
        `| ${header} | ${metric} |`,
        '|---|---|',
        ...rows.map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
}

function resultsAnalysis(before, table, after) {
    return `## 实验结果\n\n${before}\n\n${table}\n\n${after}\n`;
}

const tasks = [];
function tableCase(rule, name, header, options = {}) {
    tasks.push({
        rule,
        case: name,
        kind: 'experiment-table',
        analysis: resultsAnalysis(options.before || BEFORE, markdownTable(header, options.rows, options.metric), options.after || AFTER),
        sourceText: options.sourceText || NEUTRAL_SOURCE,
        documentType: options.documentType || DOCUMENT_TYPE
    });
}
function numeralCase(name, text) {
    tasks.push({ rule: 'manual-numeral', case: name, kind: 'manual-numeral', text });
}

// ── 规则 1：实验表格识别列、单元格数字格式与方向标记 ───────────────────────────
// Node: analysis-contract.js::validateExperimentTableContract
// Py  : publish_common.py::validate_experiment_table_contract
for (const header of ['方法', 'Family', '拓扑', '对比', '对比对象', '设置 H ↓', '评估 L1 ↓',
    '准确率', '用户画像', '声源', '系统 64 ms ↓']) {
    tableCase('table-identifier', header, header);
}
tableCase('table-identifier', '数字格式-负号', '方法',
    { rows: [['甲', '−1.2%'], ['乙', '10.8%'], ['丙', '9.7%']] });
tableCase('table-identifier', '数字格式-空格百分号', '方法',
    { rows: [['甲', '12.4 %'], ['乙', '10.8%'], ['丙', '9.7%']] });
tableCase('table-identifier', '数字格式-前导小数点', '方法',
    { rows: [['甲', '.5%'], ['乙', '10.8%'], ['丙', '9.7%']] });
tableCase('table-identifier', '单元格-倍数单位', '设置',
    { metric: '加速比 ↑', rows: [['甲', '3×'], ['乙', '2.5×'], ['丙', '1.8×']] });
// 2026-11-11 修复 Python 识别词表（family / 拓扑）后补的守护语料：
// 正例是刚才两侧由分歧转为一致的新写法；负例是“识别词 + 方向指标”的
// 伪识别列，必须继续让位给指标读法（两侧都应报缺少识别列）。
tableCase('table-identifier', 'Family ID', 'Family ID');
tableCase('table-identifier', '系统拓扑', '系统拓扑');
tableCase('table-identifier', '识别词加指标-Family准确率', 'Family 准确率 ↓');
tableCase('table-identifier', '识别词加指标-拓扑相似度', '拓扑相似度 ↓');
// 2026-11-11 把 Python TABLE_DIRECTIONAL_METRIC_RE 补齐到 Node 同表后补的守护语料：
// 这些词都必须按“带方向标记的指标列”处理，不能因为前缀像识别词就当成行身份。
for (const header of ['模型评分 ↓', '评估 L2 ↓', 'NMSE ↓', 'MR-STFT ↓', '裁判分 ↓']) {
    tableCase('table-identifier', header, header);
}

// ── 规则 2：识别列表头“（潜|隐|表征|嵌入|特征|语义）空间” ──────────────────────
// Node: analysis-contract.js::isTableIdentifierHeader 的 TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE
// Py  : publish_common.py::_is_table_identifier_header 的附加识别词
for (const header of ['潜空间', '隐空间', '表征空间', '嵌入空间', '特征空间', '语义空间',
    '潜在空间', '语义相似空间', '潜空间（词级）', '隐空间-说话人']) {
    tableCase('latent-space-header', header, header);
}
// 2026-11-11 两侧统一为“整列 + 一个括号限定”后补的边界语料：带后缀、带空格、
// 带连字符的写法都不是识别列；精确词条仍然通过。
for (const header of ['语义空间分析', '潜空间可视化', '隐空间（说话人）']) {
    tableCase('latent-space-header', header, header);
}

// ── 规则 3：组件开关对照（消融的可替代表述） ───────────────────────────────────
// Node: analysis-contract.js::hasSourceBackedComponentSwitchAblation（经实验表格合同）
// Py  : publish_common.py::_has_source_backed_component_switch_ablation（经实验表格合同）
const ABL_SOURCE = 'Ablation study: adding the branch improves SI-SDRi from 10.47 dB to 11.84 dB '
    + 'on the test set.';
const ABL_TABLE = ['| 设置 | SI-SDRi ↑ |', '|---|---|', '| 基准 | 10.47 |',
    '| 加入分支 | 11.84 |', '| 完整模型 | 11.20 |'].join('\n');
const ABL_BEFORE = '下表比较同一测试集上加入组件分支前后的指标变化，回答该组件是否值得保留。';
const ABL_BOUNDARY = '结论仅适用于上述比较条件，未验证其他数据集或噪声条件，不能直接外推到真实录音场景。';
function ablationCase(name, sentence, sourceText = ABL_SOURCE) {
    tasks.push({
        rule: 'ablation-switch',
        case: name,
        kind: 'experiment-table',
        analysis: resultsAnalysis(ABL_BEFORE, ABL_TABLE, sentence + ABL_BOUNDARY),
        sourceText,
        documentType: DOCUMENT_TYPE
    });
}
ablationCase('正例', '加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，说明该组件有效。');
ablationCase('假设', '如果加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，说明该组件有效。');
ablationCase('否定', '加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，但没有带来改善。');
ablationCase('数值相等', '加入分支后 SI-SDRi 从 11.84 dB 升至 11.84 dB，说明该组件有效。');
ablationCase('数值不在原文', '加入分支后 SI-SDRi 从 9.99 dB 升至 11.84 dB，说明该组件有效。');
ablationCase('他人归属', '先前研究加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，说明该组件有效。');
ablationCase('冻结组件后无改善', '冻结唇编码器时加入分支没有带来改善。');
ablationCase('原文无消融', '加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，说明该组件有效。',
    'We compare the two systems on the same test set.');
ablationCase('原文否定消融', '加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB，说明该组件有效。',
    'No component ablations were conducted in this study.');

// ── 规则 4：表后证据边界（不宜/不能/不可/不应 的完整搭配） ─────────────────────
// Node: analysis-contract.js::validateExperimentTableEvidenceDepth 的 boundaryPattern
// Py  : publish_common.py::_validate_experiment_table_evidence_depth 的 after 判定
const boundaryCases = {
    '明确边界': AFTER,
    '不宜直接解释': '不宜直接解释为通用结论，因为样本仅来自单一语料，比较对象也只有两个基线，'
        + '跨语言与跨设备表现尚未验证，证据范围限于当前设置。',
    '裸不能': '这一比较只覆盖单一错误率指标，不能据此断定其他语言或设备上的表现，'
        + '参与者也仅来自一个公开语料，样本量为三名说话人。',
    '裸不可': '该表只是把两种设置放进同一张表，不可否认两者仍有其他区别，'
        + '因此读者需要结合正文方法部分阅读，不能把结论当作因果证据。',
    '裸不应': '该表的分数来自单一留出集，不应把这组数值推广到全部语料，'
        + '作者也没有报告置信区间，因此结论需要保守解读。',
    '无边界': '结果说明本方法更好，值得进一步研究，也说明该方向很有前景，'
        + '值得更多团队投入跟进，后续可以继续扩大数据规模和模型规模来提升最终效果。',
    '长未验证': '该表的比较只覆盖一个语料，参与者也仅来自同一批公开录音，'
        + '其他语言、采样率、噪声条件和设备均未验证，跨域外推仍需实验支持。',
    '仅说明': '这张表只说明当前设置下的相对差别，不支持把结论外推到其他语料或部署环境，'
        + '作者也未报告置信区间与显著性检验。',
    '证据范围限于': '这些数字只覆盖英语朗读语料，证据范围限于当前测试集与单一采样率，'
        + '换语言或换设备后是否成立仍需重新测量。',
    // 2026-11-11 两侧统一到“边界词 + 推断/外推动词”后补的正例。
    '不能直接解释': '不能直接解释为通用结论，因为样本只来自一个语料，比较对象也只有两个基线，'
        + '换语言与换设备后的表现还需另行测量。',
    '不可直接视为': '不可直接视为因果证据，因为该表只比较两个设置，其他变量的影响没有单独控制，'
        + '读者仍需结合正文方法部分理解各条件之间的关系。',
    '不应直接推广': '不应直接推广到全部语料，因为分数只来自一个留出集，作者也没有报告完整置信区间，'
        + '换数据后的表现仍需重新测量。'
};
for (const [name, after] of Object.entries(boundaryCases)) {
    tableCase('table-boundary', name, '方法', { after });
}

// ── 规则 5：负面证据词表 ──────────────────────────────────────────────────────
// Node: analysis-contract.js::validateExperimentTableEvidenceDepth 的 resultHasNegative
// Py  : publish_common.py::_validate_experiment_table_evidence_depth 的 result_has_negative
const NEG_SOURCE = 'The added module does not improve performance on the noisy test set, '
    + 'and degradation is observed for low-SNR inputs.';
const negativeSentences = {
    '没有带来改善': '加入该模块后指标没有带来改善，部分低信噪比条件下甚至更差。',
    '未改善': '加入该模块后指标未改善，部分低信噪比条件下甚至更差。',
    '没有改善': '加入该模块后指标没有改善，部分低信噪比条件下甚至更差。',
    '未带来提升': '加入该模块后指标未带来提升。',
    '无显著差异': '加入该模块后两组结果无显著差异。',
    '负增益': '加入该模块后出现负增益。',
    '明显劣于基线': '加入该模块后准确率明显劣于基线。',
    '无负面词': '加入该模块后指标为 11.2%，高于基线 10.4%。',
    '假设句中的未改善': '如果加入该模块，指标未改善。'
};
for (const [name, sentence] of Object.entries(negativeSentences)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}
// 2026-11-11 修复 Python 负面证据词表后补的守护语料。正例：JS 已接受、
// 修前被 Python 拒的三类新写法（未…提升、无显著…、负增益）；负例：只差
// 一个否定词的“正向表述”（带来提升 / 存在显著差异 / 净增益为正），
// 两侧都不得把它们读成负面证据。
const negativeFixes = {
    '未产生提升': '加入该模块后指标未产生提升。',
    '并未带来改进': '加入该模块后指标并未带来改进。',
    '无显著区别': '加入该模块后两组结果无显著区别。',
    '负增益-净效应': '加入该模块后净效应为负增益。'
};
for (const [name, sentence] of Object.entries(negativeFixes)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}
const negativeCounterparts = {
    '负例-带来提升': '加入该模块后指标带来了提升。',
    '负例-存在显著差异': '加入该模块后两组结果存在显著差异。',
    '负例-净增益为正': '加入该模块后净增益为正。'
};
for (const [name, sentence] of Object.entries(negativeCounterparts)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}

// ── 规则 6：中文计量单位与精确量词 ────────────────────────────────────────────
// Node: editorial-quality.js::findQuantitativeChineseNumerals
// Py  : publish_common.py::validate_manual_reader_quality（精确定量必须使用阿拉伯数字）
const numeralTexts = [
    '三秒内完成', '耗时两倍', '提升三倍', '提高了三倍', '一点五倍', '十二个样本',
    '三个模块', '排名第三', '二到三成', '2.5 百万条', '三位说话人', '五位评审',
    '这一位说话人', '这是一位说话人，负责核对标注。', '三分之一', '五个百分点',
    '四分之一宽', '阈值二值化', '使用了 3 个模型', '2.5 万条', '3 倍', '2.5 秒',
    '四个方向', '这一位读者',
    // 2026-11-11 补齐人物介绍豁免后补的边界语料。排名类中文序数没有进入
    // 语料：Python 自 2026-09-01「汇总页允许自然序数名次」起故意放行，
    // 与 Node 的 exact_rank 仍是登记分歧（见 KNOWN_DIVERGENCES）。
    '第三阶段', '第三作者',
    '那是一位读者，负责整理笔记。', '这是一位说话人，实验统计人数为三人。',
    '这一位说话人负责核对。',
    // 2026-11-12 复核人物介绍豁免的空白、句末和技术语境边界（与 Node 逐例对齐）。
    '这是 一位说话人，负责核对。', '这是一 位说话人，负责核对。',
    '这是一位说话人。', '这是一位用户，负责整理数据。', '这是一位研究者。',
    '这是一位作者，来自某大学。', '这是一位评审，负责打分。',
    '这是一位讲者，负责报告。', '这是一位说话人负责核对。',
    '这是一位说话人\n实验统计。', '那是一位听者，负责评分。'
];
for (const text of numeralTexts) numeralCase(text, text);

// ── 当前不一致清单（2026-11-11 实测，剩 1 条） ────────────────────────────────
// 本轮已修 7 条并从本清单移除：table-identifier/评估 L1 ↓、
// latent-space-header/潜空间（词级）、隐空间-说话人、table-boundary/裸不能、
// 裸不可、裸不应、manual-numeral/这是一位说话人；上一轮已修 Family、拓扑、
// 未带来提升、无显著差异、负增益。它们现在是普通硬断言。
// 剩下的排名类分歧不是漏修：Python 在 2026-09-01「汇总页允许自然序数名次」
// （231a2a5f）里故意删掉 exact_rank，并有两个回归测试要求放行；Node 侧
// exact_rank 未同步。要收敛只能放松 Node（本任务不可改），或确认改回阿拉伯
// 数字并同步修改那两个测试，需另行决定。
const KNOWN_DIVERGENCES = Object.freeze({
    'manual-numeral/排名第三': {
        js: true,
        py: false,
        note: 'Node exact_rank 命中“排名第/第 N 名”；Python 自 2026-09-01 起'
            + '故意允许自然序数名次（231a2a5f 与 test_publish_common.py 的两个回归用例）'
    }
});

const RULES = Object.freeze([
    {
        id: 'table-identifier',
        title: '表格识别列、方向标记与可核对单元格',
        jsEntry: 'scripts/analysis-contract.js::validateExperimentTableContract',
        pyEntry: 'scripts/publish_common.py::validate_experiment_table_contract',
        pairedRule: 'isTableIdentifierHeader ↔ _is_table_identifier_header（含方向标记分支与数字格式）'
    },
    {
        id: 'latent-space-header',
        title: '“（潜|隐|表征|嵌入|特征|语义）空间”识别列',
        jsEntry: 'scripts/analysis-contract.js::validateExperimentTableContract',
        pyEntry: 'scripts/publish_common.py::validate_experiment_table_contract',
        pairedRule: 'TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE ↔ TABLE_IDENTIFIER_HEADER_RE 空间类词条'
    },
    {
        id: 'ablation-switch',
        title: '组件开关对照（消融的非字面写法）',
        jsEntry: 'scripts/analysis-contract.js::validateExperimentTableContract',
        pyEntry: 'scripts/publish_common.py::validate_experiment_table_contract',
        pairedRule: 'hasSourceBackedComponentSwitchAblation ↔ _has_source_backed_component_switch_ablation'
    },
    {
        id: 'table-boundary',
        title: '表后证据边界（不宜/不能/不可/不应）',
        jsEntry: 'scripts/analysis-contract.js::validateExperimentTableContract',
        pyEntry: 'scripts/publish_common.py::validate_experiment_table_contract',
        pairedRule: 'validateExperimentTableEvidenceDepth 的 boundaryPattern ↔ 同名 Python 复刻的 after 判定'
    },
    {
        id: 'negative-evidence',
        title: '负面证据词表',
        jsEntry: 'scripts/analysis-contract.js::validateExperimentTableContract',
        pyEntry: 'scripts/publish_common.py::validate_experiment_table_contract',
        pairedRule: 'resultHasNegative ↔ result_has_negative 词表'
    },
    {
        id: 'manual-numeral',
        title: '中文计量单位与精确量词（秒/倍/点/分/样本等）',
        jsEntry: 'scripts/editorial-quality.js::findQuantitativeChineseNumerals',
        pyEntry: 'scripts/publish_common.py::validate_manual_reader_quality',
        pairedRule: 'HARD_MEASUREMENT_UNITS/SCALED_ARABIC_MEASUREMENT_UNITS 等 ↔ simple_count_unit_items 等'
    }
]);

const RULE_IDS = new Set(RULES.map(rule => rule.id));

function evaluateJs(task) {
    if (task.kind === 'manual-numeral') {
        return editorial.findQuantitativeChineseNumerals(task.text).length > 0;
    }
    if (task.kind === 'experiment-table') {
        return contract.validateExperimentTableContract(task.analysis, {
            contractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: task.documentType,
            sourceText: task.sourceText
        });
    }
    throw new Error(`未知对照任务类型: ${task.kind}`);
}

function tasksFor(ruleId) {
    return tasks.filter(task => task.rule === ruleId);
}

function divergenceKey(ruleId, caseName) {
    return `${ruleId}/${caseName}`;
}

function knownDivergence(ruleId, caseName) {
    return KNOWN_DIVERGENCES[divergenceKey(ruleId, caseName)];
}

function describe(value) {
    if (value === null || value === undefined) return 'null（通过）';
    if (typeof value === 'boolean') return value ? 'true（命中规则）' : 'false（未命中）';
    return JSON.stringify(value);
}

function probePayload() {
    return {
        root: ROOT,
        rules: RULES,
        tasks,
        jsResults: tasks.map(task => ({
            rule: task.rule,
            case: task.case,
            js: evaluateJs(task)
        })),
        knownDivergences: Object.entries(KNOWN_DIVERGENCES).map(([key, value]) => ({
            key,
            rule: key.slice(0, key.indexOf('/')),
            case: key.slice(key.indexOf('/') + 1),
            ...value
        }))
    };
}

module.exports = {
    ROOT,
    RULES,
    RULE_IDS,
    TASKS: tasks,
    KNOWN_DIVERGENCES,
    evaluateJs,
    tasksFor,
    knownDivergence,
    divergenceKey,
    describe,
    probePayload
};

if (require.main === module) {
    process.stdout.write(JSON.stringify(probePayload()));
}

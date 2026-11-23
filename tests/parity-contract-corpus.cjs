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
function coreSummaryCase(name, summary, sourceText) {
    tasks.push({ rule: 'core-summary-v4', case: name, kind: 'core-summary-v4', summary, sourceText });
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
// 2026-11-12 日更 2611.11777 暴露的识别词缺口：评测对象 / 量化水平 / 操作
// 是合法的行身份列；带指标后缀的“操作耗时 ↓”仍必须让位给指标读法。
tableCase('table-identifier', '评测对象', '评测对象');
tableCase('table-identifier', '量化水平', '量化水平');
tableCase('table-identifier', '操作', '操作');
tableCase('table-identifier', '识别词加指标-操作耗时', '操作耗时 ↓');
// 2026-11-13 逐词对拍发现：语系/语族在 Node 的主识别词表里（e6c334b1 与
// TABLE_STRONG_IDENTITY_HEADER_RE 一起加进去），Python 只加进了强身份词表，
// 于是语言族做行身份的表格 Node 通过、Python 报缺少识别列。语义上是行身份，
// 应补 Python 主词表；在补齐前登记为已知分歧。
for (const header of ['语系', '语族', '语系 ↓', '语族 平均 ↑']) {
    tableCase('table-identifier', header, header);
}

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
// 2026-11-12 日更 2611.12478 暴露的负面证据写法：非单调、净下降。
// 反向的“保持单调提升 / 净提升”不得被读成负面证据。
const negativeFixes20261112 = {
    '非单调': '加入该模块后相邻条件出现非单调的作答变化。',
    '净下降': '加入该模块后不同分组出现 2 个百分点的净下降。'
};
for (const [name, sentence] of Object.entries(negativeFixes20261112)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}
const negativeCounterparts20261112 = {
    '负例-保持单调提升': '加入该模块后结果保持单调提升。',
    '负例-净提升': '加入该模块后指标净提升 2 个百分点。'
};
for (const [name, sentence] of Object.entries(negativeCounterparts20261112)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}
for (const [name, sentence] of Object.entries(negativeCounterparts)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}

// ── 规则 5b：2026-11-13 逐条复核 publish_common.py 得到的差集 ─────────────────
// 三类语料，各自由实测确定是哪一侧慢了一拍：
//   1) 训练配置词：损失函数/损失项/损失权重/损失率是训练超参，不是退化证据。
//      Python 已加排除，Node 原先把裸“损失”一律当负面证据，于是出现了
//      “分析通过、发布拒绝”——Node 放行后 Python 仍报没有保留负面证据。
//   2) 未能完成：Python 已登记为负面证据，Node 词表漏登记（反向误报）。
//   3) 例外/反例 + 低于/下降/更差：Node 独有的负面证据写法，Python 尚无对应
//      分支；这条登记为待 Python 补齐的分歧（见 KNOWN_DIVERGENCES）。
const negativeLossPhrases = {
    '损失函数': '训练损失函数采用交叉熵。',
    '损失项': '训练目标包含三个损失项。',
    '损失权重': '各损失权重保持一致。',
    '损失率': '验证损失率为 2.31。',
    '损失函数-同段正向结论': '训练损失函数使用了标签平滑，主要结果见上表。',
    '未能完成': '部分模型未能完成训练。'
};
for (const [name, sentence] of Object.entries(negativeLossPhrases)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}
// 裸“损失”仍是退化证据：训练损失上升就是负面结果，不能被 1) 的排除吃掉。
tableCase('negative-evidence', '损失-裸上升', '方法',
    { after: AFTER + '训练损失明显上升。', sourceText: NEG_SOURCE });
const negativeExceptionPhrases = {
    '例外-低于': '这组设置是唯一例外，指标低于基线。',
    '反例-下降': '存在反例，指标下降。'
};
for (const [name, sentence] of Object.entries(negativeExceptionPhrases)) {
    tableCase('negative-evidence', name, '方法', { after: AFTER + sentence, sourceText: NEG_SOURCE });
}

// ── 规则 5c：来源侧负面证据词表 ───────────────────────────────────────────────
// Node 的来源侧词表登记了“性能回落/回落至/降幅/负面结果”，Python 的同名词表
// 没有这四个词，于是同一份来源在 Node 判“必须保留负面证据”、在 Python 放行。
// 方向是 Node 先挡住（不会发出坏页面），但两边判定不一致，登记为待 Python 补齐。
const sourceNegativeCases = {
    '来源-性能回落': 'On the harder test set the authors report 性能回落 on the noisy subset.',
    '来源-回落至': 'The score 回落至 10.2% on the noisy subset, below every baseline.',
    '来源-降幅': 'A 降幅 of 3.1 points was observed on the noisy subset.',
    '来源-负面结果': 'The authors report 负面结果 for the low-resource condition.'
};
for (const [name, sourceText] of Object.entries(sourceNegativeCases)) {
    tableCase('negative-evidence', name, '方法', { sourceText });
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
// ── 已收敛的登记项（2026-11-13 复核 → py-publish 补齐 → 转硬断言） ─────────────
// 上一版这里有 10 条 KNOWN_DIVERGENCES，全部是“Node 侧语义正确、Python 慢一拍”。
// py-publish 补齐后两侧一致，条目已删除，语料改为硬断言；下面保留当时的补丁点，
// 供以后再出现单侧改动时定位。
//   publish_common.py TABLE_IDENTIFIER_HEADER_RE += 语系|语族
//     → 语料 语系 / 语族 / 语系 ↓ / 语族 平均 ↑（表头变异 1030 条曾出 14 例分歧）
//   publish_common.py result_has_negative += (?:例外|反例)[^。；\n]{0,80}(?:低于|下降|更差)
//     → 语料 例外-低于 / 反例-下降（结果句变异 25 条曾出 3 例分歧）
//   publish_common.py source_has_negative += 负(?:面)?结果|性能回落|回落至|降幅
//     → 语料 来源-性能回落 / 来源-回落至 / 来源-降幅 / 来源-负面结果（来源句变异 5 条曾出 4 例分歧）
// 单侧再改动时，这里会以“未登记的新分歧”失败，提示先确认语义再动实现。
const IDENTIFIER_MISSING = '实验结果第 1 张表缺少方法、数据集或设置识别列';
const NEGATIVE_MISSING = '全文包含退化、不显著或失败结果，但实验结果没有保留负面证据';

const KNOWN_DIVERGENCES = Object.freeze({
    // 历史登记（2026-11-11 实测），与本轮无关：Python 自 231a2a5f 起故意允许
    // 自然序数名次，Node 的 exact_rank 未同步；要收敛只能改 Node 或改那两个
    // Python 回归用例，需另行决定。
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
    },
    {
        id: 'core-summary-v4',
        title: '核心摘要 v4 指标白名单与数值溯源（CA-SDRi / p 值 / 区间右端点 / 缩放防卫）',
        jsEntry: 'scripts/analysis-contract.js::validateCoreSummarySemanticContract',
        pyEntry: 'scripts/publish-to-blog.py::_detailed_core_summary_semantic_issue',
        pairedRule: 'validateCoreSummarySemanticContract ↔ _detailed_core_summary_semantic_issue'
    }
]);

const EXEC_SUMMARY_TEMPLATE = expSentence => [
    '**问题与瓶颈：** 现有流式语音识别与增强系统在严格低延迟约束下难以维持稳定的声学上下文连贯性。固定短窗口切分在跨帧边界处截断长程声学依赖，使模型在高噪声与强混响条件下频繁出现频谱失真与错词。传统离线整句编码器虽能利用全局上下文，但其整段等待缓冲机制无法满足实时语音交互需求。如何在受限前向视窗内同时保住局部细节与跨块语义连贯，成为流式语音建模的核心瓶颈。',
    '**核心思路与方法架构：** 本文提出一种带缓存门控的流式双路编码解码框架。前端模块将输入波形转换为帧级梅尔频谱特征，并送入因果深度可分离卷积编码器提取局部声学表征。随后，跨块注意力记忆模块通过可学习门控向量将当前块特征与历史压缩状态融合，避免直接拼接全历史序列带来的二次复杂度膨胀。最终，轻量化预测网络与解码器逐帧输出预测结果，整个推理路径严格保持单向因果依赖且无需整句回看。',
    `**关键实验与核心代价：** ${expSentence} 进一步消融实验表明，移除跨块记忆门控后系统在噪声子集上的性能明显回落，证实状态融合机制是主要收益来源。在工程开销方面，该架构需常驻固定大小的缓存状态显存，并在每帧前向步引入额外的门控投影运算。虽然实时率仍满足常规边缘计算需求，但在内存受限微控制器设备上仍需权衡缓存容量与解码吞吐。`,
    '**适用边界与深读导览：** 上述结论主要在英文干净及近场语音评测协议下得到验证。远场多说话人严重重叠、极低信噪比以及跨语种低资源场景尚未纳入系统测试，且本文未与超大参数离线模型做等算力对照。工程团队若准备迁移到真实会议拾音设备，仍需补测麦克风阵列前端失配的影响。读者若希望深入核对门控状态更新方程、各子模块消融明细与部署时延剖面，可继续阅读下方深度解读章节。'
].join('\n\n');

const EXEC_SUMMARY_ISOLATED_TEMPLATE = expSentence => [
    '**问题与瓶颈：** 现有流式语音编码与声学增强系统在严格实时约束下难以维持稳定的声学上下文连贯性。固定短窗口切分在跨帧边界处截断长程声学依赖，使模型在高噪声与强混响条件下频繁出现频谱失真与听感劣化。传统离线整句编码器虽能利用全局上下文，但其整段等待缓冲机制无法满足实时语音交互需求。如何在受限前向视窗内同时保住局部细节与跨块语义连贯，成为流式语音建模的核心瓶颈。',
    '**核心思路与方法架构：** 本文提出一种带缓存门控的流式双路编码解码框架。前端模块将输入波形转换为帧级梅尔频谱特征，并送入因果深度可分离卷积编码器提取局部声学表征。随后，跨块注意力记忆模块通过可学习门控向量将当前块特征与历史压缩状态融合，避免直接拼接全历史序列带来的二次复杂度膨胀。最终，轻量化预测网络与解码器逐帧输出重建结果，整个推理路径严格保持单向因果依赖且无需整句回看。',
    `**关键实验与核心代价：** ${expSentence} 进一步消融实验表明，移除跨块记忆门控后系统在噪声子集上的声学重建结果明显回落，证实状态融合机制是主要收益来源。在工程开销方面，该架构需常驻固定大小的缓存状态显存，并在每帧前向步引入额外的门控投影运算。虽然实时运行仍满足常规边缘计算需求，但在内存受限微控制器设备上仍需权衡缓存容量与解码算力。`,
    '**适用边界与深读导览：** 上述结论主要在英文干净及近场语音评测协议下得到验证。远场多说话人严重重叠、极低信噪比以及跨语种低资源场景尚未纳入系统测试，且本文未与超大参数离线模型做等算力对照。工程团队若准备迁移到真实会议拾音设备，仍需补测麦克风阵列前端失配的影响。读者若希望深入核对门控状态更新方程、各子模块消融明细与部署剖面，可继续阅读下方深度解读章节。'
].join('\n\n');

const CORE_SUMMARY_SRC = [
    'Table 1: Main Results in WER (%) on TestClean:',
    'Baseline achieves 10 and Ours achieves 5 with statistical significance (p < 0.05).',
    'On AudioSet, CA-SDRi improves from 11.2 dB to 14.6 dB at 2.4 GHz with latency 8-12 ms.'
].join('\n');
coreSummaryCase(
    'v4-通过-CASDRi唯一指标',
    EXEC_SUMMARY_ISOLATED_TEMPLATE('在 AudioSet 评测集上，相比强基线模型，本文方法的 CA-SDRi 从 11.2 dB 提升至 14.6 dB。'),
    'Evaluation results on AudioSet test set: CA-SDRi improves from 11.2 dB to 14.6 dB compared to the baseline.'
);
coreSummaryCase(
    'v4-通过-p值5%与区间单位',
    EXEC_SUMMARY_TEMPLATE('在 TestClean 评测集上，本文方法词错误率 WER 降至 5%，明显低于强基线 10%，运行于 2.4 GHz、延迟 8-12 ms。'),
    CORE_SUMMARY_SRC
);
coreSummaryCase(
    'v4-拒绝-连字符区间右端点编造',
    EXEC_SUMMARY_TEMPLATE('在 TestClean 评测集上，本文方法词错误率 WER 降至 5%，低于基线 10%，实测延迟为 8-12.5 ms。'),
    CORE_SUMMARY_SRC
);
coreSummaryCase(
    'v4-拒绝-GHz编造',
    EXEC_SUMMARY_TEMPLATE('在 TestClean 评测集上，本文方法词错误率 WER 降至 5%，低于基线 10%，并运行于 3.6 GHz 平台。'),
    CORE_SUMMARY_SRC
);
coreSummaryCase(
    'v4-拒绝-batchSize小数转百分号',
    EXEC_SUMMARY_TEMPLATE('在公开测试集上，本文方法 WER 从 12.3% 降至 10.1%，且 F1 达到 85%。'),
    'Table 1: WER (%): Baseline 12.3, Ours 10.1. We use batch size 85 and obtain F1 = 0.85.'
);

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
    if (task.kind === 'core-summary-v4') {
        const summaryHeader = require(path.join(ROOT, 'scripts/lib/core-summary-format.js')).currentHeader();
        const issue = contract.validateCoreSummarySemanticContract(`## 核心摘要\n${task.summary}\n`, {
            sourceText: task.sourceText,
            summaryHeader
        });
        return issue ? issue.replace(/^核心摘要未达到 详细摘要规则：/, '') : null;
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

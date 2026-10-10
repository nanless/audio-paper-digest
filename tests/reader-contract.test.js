'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readerRequirements, buildReaderContractNotice, findReaderSectionNearDuplicates } = require('../scripts/lib/reader-contract.js');

test('Reader 提示词告知与解析器共用同一组阈值，并按每次请求的证据给表格要求', () => {
    const requirements = readerRequirements({ availableTableCount: 9 });
    assert.deepEqual([requirements.minimumSections, requirements.maximumSections, requirements.minimumChineseChars,
        requirements.maximumChineseChars, requirements.minimumConceptBridges, requirements.maximumConceptBridges], [12, 18, 5000, 18000, 4, 10]);
    assert.equal(requirements.minimumTables, 4);
    assert.equal(requirements.minimumWideTables, 2);
    assert.equal(readerRequirements({ availableTableCount: 0 }).minimumTables, 2);
    assert.equal(readerRequirements({ version: 2 }).minimumSections, 10);
    const notice = buildReaderContractNotice({ minimumIntegratedTables: 3 });
    assert.match(notice, /至少应包含 3 张表/);
    assert.match(notice, /至少 2 张的列数应不少于 5 列/);
    assert.match(notice, /5000–18000/);
    assert.match(notice, /没有收到像素时，figurePlacements 必须为空/);
    const prompt = fs.readFileSync(path.resolve(__dirname, '../prompts/api-reader-article.md'), 'utf8');
    assert.match(prompt, /\{mechanicalContract\}/);
    assert.doesNotMatch(prompt, /未附像素但允许/);
    assert.throws(() => readerRequirements({ minimumIntegratedTables: 2.5 }), /integer/);
});

test('Reader 提示词区分表格输入模式，并说明字符与图片方向的语义', () => {
    const prompt = fs.readFileSync(path.resolve(__dirname, '../prompts/api-reader-article.md'), 'utf8');
    assert.match(prompt, /`selection`：正文独占一段写 `\[\[TABLE_<tableIndex>\]\]`，不手写该表的 Markdown/);
    assert.match(prompt, /`artifact_table` 是既有兼容模式。.*完整 Markdown 表，不使用 `TABLE` 占位符/);
    assert.match(prompt, /`source_quotes` 用于直接整理原文句子。.*完整 Markdown 表，不使用 `TABLE` 占位符/);
    assert.match(prompt, /`cellBindings=\[\]` 必须为空/);
    assert.match(prompt, /不得发明 `value`、`quoteIndex`/);
    assert.match(prompt, /不是 JSON 字符数、英文长度或 token 数/);
    assert.match(prompt, /原始指标、相对改变量还是改善量/);
    assert.match(prompt, /不能把曲线向下直接写成性能变差/);
});

test('运行时 Reader 提示词保留来源身份规则，没有自相矛盾的示例和多余占位符', () => {
    const { loadPrompt } = require('../scripts/utils.js');
    const prompt = loadPrompt('prompts/api-reader-article.md', {
        title: 'TEST_TITLE', arxivId: '2609.99999', sourceEvidence: 'SOURCE_ONLY_EVIDENCE',
        validationFeedback: 'NO_ERRORS', previousDraft: '无',
        mechanicalContract: buildReaderContractNotice({ availableTableCount: 4 })
    });
    assert.match(prompt, /SOURCE_ONLY_EVIDENCE/);
    assert.doesNotMatch(prompt, /\{(?:title|arxivId|sourceEvidence|validationFeedback|previousDraft|mechanicalContract)\}/);
    assert.match(prompt, /不能把无训练等同于确定性求解/);
    assert.doesNotMatch(prompt, /再解释复用模型、确定性求解和推理过程/);
    assert.match(prompt, /参数如何冻结或更新、梯度经过哪里、监督来自哪里、何时重置，都只能按证据说明/);
    assert.match(prompt, /数值相同不是同一指标的证据/);
    assert.match(prompt, /不要把不同指标的差值放到模型列下/);
    assert.match(prompt, /原文表头、图注或算术互相冲突时明确标注冲突/);
    assert.match(prompt, /单位留在同一单元格/);
    assert.match(prompt, /原文是裸数值时不擅自添单位/);
    assert.doesNotMatch(prompt, /\| 指标 \| 单位 \|/);
    assert.match(prompt, /保留正确的图和公式编号、概念解释占位符及对应关系/);
    assert.doesNotMatch(prompt, /表后必须用 2–4 段/);
    const schema = JSON.parse(prompt.slice(prompt.indexOf('\n{\n') + 1,
        prompt.indexOf('\n\n`sections` 数量')));
    assert.deepEqual(Object.keys(schema), ['version', 'readerTitle', 'oneSentenceThesis',
        'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings', 'sections']);
    assert.equal(schema.version, 3);
    assert.equal(schema.conceptBridges[0].marker, '[[CONCEPT_BRIDGE_1]]');
    assert.match(schema.conceptBridges[0].explanation, /不照抄此占位说明/);
});

const explanation = '声学分支先把连续输入转换为局部表示，融合模块再根据上下文决定保留哪些细节，最后输出层把组合表示映射到当前任务需要的预测。这个执行顺序让读者能够沿着同一个样本检查信息如何跨越模块边界，也说明训练时的监督信号怎样约束各个组件，而评估时需要固定哪些条件才能公平比较不同系统的结果。';

test('真实 Reader ID 能区分重复的组件类型，并识别明显的跨小节改写', () => {
    const article = `### 模块怎样接收局部声音信息？\n\n${explanation}\n\n### 另一个组件为什么需要融合？\n\n${explanation.replace('声学分支先', '这一声学分支首先')}`;
    const findings = findReaderSectionNearDuplicates(article, [{ kind: 'component' }, { kind: 'component' }]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].left.section, 'sections[0]');
    assert.equal(findings[0].right.section, 'sections[1]');
    assert.equal(findings[0].severity, 'warning');
    assert.ok(findings[0].similarity > 0.86);
    assert.ok(!JSON.stringify(findings).includes(explanation), '诊断不重复保存这段完整正文');
});

test('不同上下文、表格和同一小节内重复出现的相同数字不算跨小节重复', () => {
    const article = `### 数据与训练条件如何定义？\n\n${'训练使用 100 个样本，每个样本包含 20 帧声音。数据划分依据说话者身份分离，参数只在训练划分更新，研究者需要检查采样和标注如何支撑这一设置。'.repeat(2)}\n\n### 推理怎样测量成本与延迟？\n\n${'部署系统为 100 个并发请求各分配 20 毫秒预算。计时从收到请求到完成处理，内存分配和设备传输需要分别测量，以便确定哪些计算步骤限制了实时运行。'.repeat(2)}`;
    assert.deepEqual(findReaderSectionNearDuplicates(article), []);
    assert.deepEqual(findReaderSectionNearDuplicates(`### 单个组件怎样工作？\n\n${explanation}\n\n${explanation}`), []);
    const table = `| ${explanation} | value |\n| --- | --- |\n| row | 20 |`;
    assert.deepEqual(findReaderSectionNearDuplicates(`### 数据怎么组织？\n\n${table}\n\n### 结果怎么比较？\n\n${table}`), []);
});

test('小节警告有上限，重复再多也不会无限增长', () => {
    const repeated = Array.from({ length: 18 }, (_, index) => `### section ${index}\n\n${explanation}\n\n${explanation}`).join('\n\n');
    const findings = findReaderSectionNearDuplicates(repeated);
    assert.equal(findings.length, 12);
    assert.equal(new Set(findings.map(finding => `${finding.left.section}:${finding.right.section}`)).size, findings.length);
});

test('Reader 编辑质量集成保留带小节定位的警告，不改动正文', () => {
    const { validateReaderEditorialQuality, buildApiReaderQualityMetrics } = require('../scripts/deep-analyzer.js');
    const article = `### 模块怎样接收局部声音信息？\n\n${explanation}\n\n### 另一个组件为什么需要融合？\n\n${explanation.replace('声学分支先', '这一声学分支首先')}`;
    const before = article;
    const quality = validateReaderEditorialQuality(article, [{ kind: 'component' }, { kind: 'component' }]);
    assert.equal(article, before);
    const metrics = buildApiReaderQualityMetrics(quality, article);
    assert.equal(metrics.warningCodes.reader_cross_section_near_duplicate, 1);
    assert.equal(metrics.sectionWarnings[0].right.section, 'sections[1]');
});

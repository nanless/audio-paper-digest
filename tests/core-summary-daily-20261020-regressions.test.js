'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8')
    + '\nmodule.exports.setting=hasConcreteCoreSummarySetting;module.exports.state=coreSummaryQuantitativeResultState;', filename);
const api = compiled.exports;
const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/core-summary-daily-20261020-real.json.gz'));
const fixture = JSON.parse(zlib.gunzipSync(bytes));
const paper = id => fixture.papers.find(row => row.paperId === id);
const latest = id => paper(id).responses.at(-1).rawResponse;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);
const semantic = (id, text = latest(id)) => api.validateCoreSummarySemanticContract(text, { sourceText: paper(id).sourceText });
const experiment = (id, text = paper(id).checkpointAnalysis, sourceText = paper(id).sourceText) =>
    api.validateExperimentTableContract(text, { sourceText, documentType: '方法研究', contractVersion: api.EXPERIMENT_TABLE_CONTRACT_VERSION });

test('真实压缩包与八份完整来源、原检查点和十五次原付费响应保持原SHA', noModel(() => {
    assert.equal(sha(bytes), '964cb2f120aa4dcaa41d01d7163ebf6f136d1acd1c56de3c4bd116caf1c76161');
    for (const row of fixture.papers) {
        assert.equal(sha(row.sourceText), row.sourceSha256);
        assert.equal(sha(row.checkpointAnalysis), row.checkpointAnalysisSha256);
        for (const response of row.responses) assert.equal(sha(response.rawResponse), response.outputTextSha256);
    }
}));

for (const id of ['2610.25824', '2610.25342', '2610.26614', '2610.24031']) {
    test(`真实${id}唯一最新付费摘要按完整原文通过当前语义检查`, noModel(() => assert.equal(semantic(id), null)));
}
test('旧稿真实缺设置仍拒绝，不能把规则修正解释为全历史通过', noModel(() => {
    for (const response of paper('2610.25824').responses.slice(0, 2)) assert.match(semantic('2610.25824', response.rawResponse), /评测设置/);
    assert.match(semantic('2610.26614', paper('2610.26614').responses[0].rawResponse), /评测设置/);
}));

test('时长加基准的设置须绑定原名称与原时长，否定假设及错归属仍拒绝', noModel(() => {
    const source = paper('2610.25824').sourceText;
    const sentence = latest('2610.25824').split(/[。！？\n]/u).find(s => s.includes('在32.72小时MS-Bench上'));
    assert.equal(api.setting(sentence, source), true);
    for (const text of [sentence.replace('32.72', '37.72'), sentence.replace('MS-Bench', 'Other-Bench'),
        ...['假设', '如果', '预计', '没有', '引用', '他人', '第三方', '相关工作'].map(prefix => prefix + sentence),
        '训练32.72小时后，WER为22.49%，低于基线25.02%。']) assert.equal(api.setting(text, source), false, text);
    assert.equal(api.setting(sentence, 'If MS-Bench contained 32.72 hours, we would evaluate the hypothetical benchmark.'), false);
    assert.equal(api.setting(sentence, 'A previous paper reported:\nMS-Bench is a benchmark with a total duration of 32.72 hours.'), false);
}));

test('中文关键词语料、人工/机器划分均须与实际来源对应', noModel(() => {
    const source = paper('2610.26614').sourceText;
    const sentence = latest('2610.26614').split(/[。！？\n]/u).find(s => s.includes('在巴尔的摩警务关键词集'));
    assert.equal(api.setting(sentence, source), true);
    for (const text of [sentence.replace('巴尔的摩', '火星'), sentence.replace('百分之二十人工', '百分之三十人工'),
        sentence.replace('百分之八十仅机器', '百分之七十仅机器'), sentence.replace('人工转写加', '机器转写加'),
        ...['假设', '如果', '预计', '没有', '引用', '第三方', '先前研究'].map(prefix => prefix + sentence)]) {
        assert.equal(api.setting(text, source), false, text);
    }
    assert.equal(api.setting(sentence, 'A previous paper hypothesizes Baltimore police keyword evaluation using 20% transcribed and 80% untranscribed data.'), false);
}));

for (const [name, id, aliases] of [
    ['顶点', '2610.25342', ['唇顶点误差', '全脸顶点误差']],
    ['手势', '2610.24031', ['Fréchet Gesture Distance', 'Beat Consistency']]
]) {
    test(`${name}指标不接受同名模型、否定、假设或外部归属`, noModel(() => {
        const source = paper(id).sourceText;
        const sentence = latest(id).split(/[。！？\n]/u).find(s => aliases.every(alias => s.includes(alias)) && /从|降低/u.test(s));
        assert.ok(sentence);
        assert.equal(api.state(sentence, source).complete, true);
        for (const prefix of ['假设', '如果', '预计', '并未报告，', '不是', '引用', '他人', '第三方', '相关工作']) {
            assert.equal(api.state(prefix + sentence, source).complete, false, prefix);
        }
        const modelNames = aliases.reduce((s, alias) => s.replaceAll(alias, alias + '模型'), sentence);
        assert.equal(api.state(modelNames, source).complete, false);
    }));
}
test('LVE与MVE为不同指标，裸缩写只按整词匹配', noModel(() => {
    const source = paper('2610.25342').sourceText;
    assert.equal(api.state('在VOCASET上，LVE为3.6424，低于基线LVE为3.8744。', source).complete, true);
    assert.equal(api.state('在VOCASET上，MVE为1.9764，低于基线MVE为2.1171。', source).complete, true);
    assert.equal(api.state('在VOCASET上，LVE为3.6424，低于基线MVE为2.1171。', source).complete, false);
    assert.equal(api.state('在VOCASET上，LVE为3.6424，低于基线WER为12.4。', source).complete, false);
    for (const alias of ['XLVE', 'LVE2', 'LVE模型', 'LVE这个模型', 'MVE这种方法', 'LVE这个系统', 'MVE-Base']) assert.equal(api.state(`在VOCASET上，${alias}从3.8744降至3.6424。`, source).complete, false, alias);
}));

test('具体样本不足的失效边界不接受否定、虚构或其他方法归属', noModel(() => {
    const sentence = '校正估计并非对所有词有效，词频过低、人工样本过少或无标注数据过少时仍可能失效，应用前需按词检验覆盖情况';
    assert.equal(api.hasNaturalScopedBoundary(sentence), true);
    for (const text of ['假设' + sentence, '引用他人说法，' + sentence,
        sentence.replace('仍可能失效', '并不会失效'), sentence.replace('仍可能失效', '不意味着失效'),
        sentence.replace('校正估计', '其他方法'), '估计可能失效。']) assert.equal(api.hasNaturalScopedBoundary(text), false, text);
}));

test('录音日历与音乐年代不成为性能结果，同句真实测量仍保留', noModel(() => {
    assert.equal(semantic('2610.23651', paper('2610.23651').responses[0].rawResponse), null);
    assert.equal(semantic('2610.23651', paper('2610.23651').responses[1].rawResponse), null);
    assert.match(semantic('2610.23651'), /原文无可核定量结果/);
    assert.equal(api.hasCoreSummaryQuantitativeEvidence('The recording sessions ran from15 to19 February1988.'), false);
    assert.equal(api.hasCoreSummaryQuantitativeEvidence('The recording sessions ran from 15 to 19 February 1988.'), false);
    assert.equal(api.hasCoreSummaryQuantitativeEvidence('Stereo reduction was used throughout the 1970s.'), false);
    assert.equal(api.hasCoreSummaryQuantitativeEvidence('During the sessions from 15 to 19 February 1988, test WER reduced from12.4% to9.8%.'), true);
    assert.equal(api.hasCoreSummaryQuantitativeEvidence('相比基线，推理延迟从2000s降至1900s。'), true);
    assert.equal(api.hasCoreSummaryQuantitativeEvidence('Compared with baseline, latency reduced from 2000s to 1900s.'), true);
}));

for (const id of ['2610.26252', '2610.25640', '2610.26168']) test(`真实${id}保存结构稿有来源支持的实验对照与负面范围`, noModel(() => assert.equal(experiment(id), null)));

test('顺序消融须保留真实三行及原数值，否定或虚构对照不冒充消融', noModel(() => {
    const id = '2610.26252', p = paper(id);
    for (const text of [p.checkpointAnalysis.replace('19.67%', '19.68%'), p.checkpointAnalysis.replace('SEAM Shuffled', 'Other Shuffled'),
        p.checkpointAnalysis.replace('只破坏子词条输入顺序', '没有只破坏子词条输入顺序').replace('反转使 CER', '假设反转使 CER')]) {
        assert.match(experiment(id, text), /消融|负面/);
    }
}));
test('阶段开关的识别列必须有真实来源和不同二值配置', noModel(() => {
    const id = '2610.25640', p = paper(id);
    for (const source of [p.sourceText.replaceAll('S4', 'Other4'), p.sourceText.replaceAll('Stage 4', 'Part 4')]) {
        assert.match(experiment(id, p.checkpointAnalysis, source), /识别列/);
    }
    assert.match(experiment(id, p.checkpointAnalysis.replaceAll('| ✓ |', '| 12 |')), /识别列/);
}));
test('顺序消融与阶段开关不借假设或其他研究的源表授予身份', noModel(() => {
    const rows = '\nTable 5: Illustrative source rows only.\nCER\nWER\nSEAM (Original)\n14.88\n34.41\nSEAM (Reversed)\n19.67\n51.99\nSEAM (Shuffled)\n22.91\n53.66';
    for (const source of ['We did not conduct an order sensitivity ablation. The following values are hypothetical examples.' + rows,
        'A previous paper reported this subtoken order ablation. It is not our experiment.' + rows]) {
        assert.match(experiment('2610.26252', paper('2610.26252').checkpointAnalysis, source), /消融/);
    }
    const stages = 'No ablation experiment was performed. These Stage settings are hypothetical and belong to a previous method.\nStage 1: Proposed only.\nStage 2: Proposed only.\nStage 3: Proposed only.\nStage 4: Proposed only.\nS1\nS2\nS3\nS4';
    assert.match(experiment('2610.25640', paper('2610.25640').checkpointAnalysis, stages), /识别列/);
    const previousStages = paper('2610.25640').sourceText.replace('In Tab.\u00a03, we conduct stage-wise ablations', 'A previous paper reported this experiment.\nIn Tab.\u00a03, we conduct stage-wise ablations');
    assert.notEqual(previousStages, paper('2610.25640').sourceText);
    assert.match(experiment('2610.25640', paper('2610.25640').checkpointAnalysis, previousStages), /识别列/);
}));
test('推理误认失败必须来自本研究连续失败实例，不拼接外部或假设句', noModel(() => {
    const id = '2610.25640', p = paper(id);
    const source = p.sourceText.replaceAll('reasoning phase', 'initial phase').replaceAll('cannot recover the correct target', 'cannot restore a target');
    assert.match(experiment(id, p.checkpointAnalysis, source), /负面/);
    for (const extra of ['A previous paper said that its reasoning phase misidentifies the target and compression cannot recover the correct target.',
        'If a hypothetical reasoning phase misidentifies the target, compression cannot recover the correct target.']) {
        assert.match(experiment(id, p.checkpointAnalysis, source + '\n' + extra), /负面/);
    }
}));
test('选择器是身份列，带准确率后不能冒充身份；实际测得失败不能按路由说明删除', noModel(() => {
    const id = '2610.26168', p = paper(id);
    assert.match(experiment(id, p.checkpointAnalysis.replace('| 选择器 |', '| 选择器准确率 ↑ |')), /识别列/);
    const measuredFailureSource = p.sourceText.replace('5 Evaluation\n',
        '5 Evaluation\nEvaluation measured an execution failure rate of 10%.\n');
    assert.notEqual(measuredFailureSource, p.sourceText);
    assert.match(experiment(id, p.checkpointAnalysis, measuredFailureSource), /负面/);
}));


test('顺序消融只读取原caption自己的表块，不能借下一表或图的数值', noModel(() => {
    const p = paper('2610.26252');
    const rows = '\nMethod\nCER (%)\nWER (%)\nSEAM (Original)\n14.88\n34.41\nSEAM (Reversed)\n19.67\n51.99\nSEAM (Shuffled)\n22.91\n53.66';
    for (const boundary of ['Table 4: Unrelated measurements from a different experiment.', 'Figure 4: Unrelated measurements.', '5 Discussion']) {
        const source = 'We disrupt subtoken order before spectral filtering.\nTable 3: Order sensitivity ablation on Russian (5h).\nNo measurements were reported for this table.\n' + boundary + rows;
        assert.match(experiment('2610.26252', p.checkpointAnalysis, source), /消融/);
    }
}));

test('本研究实验与失败例的紧邻后置撤回不能继续作证', noModel(() => {
    const p = paper('2610.25640');
    const stage = p.sourceText.replace(/^(In Tab\.[^\n]*we conduct stage-wise ablations[^\n]*)$/mu, '$1\nThese ablations were not conducted and are hypothetical.');
    assert.notEqual(stage, p.sourceText);
    assert.match(experiment('2610.25640', p.checkpointAnalysis, stage), /识别列/);
    const failure = p.sourceText.replace(/^(In the example, the model compresses[^\n]*reasoning phase misidentifies[^\n]*)$/mu, '$1\nThis failure example was fabricated and has been withdrawn.');
    assert.notEqual(failure, p.sourceText);
    assert.match(experiment('2610.25640', p.checkpointAnalysis, failure), /负面/);
}));

test('BPD与CPD的相同比例各有原文，不能从另一城市借用划分', noModel(() => {
    const p = paper('2610.26614');
    const baltimore = latest('2610.26614').split(/[。！？\n]/u).find(s => s.includes('在巴尔的摩警务关键词集'));
    const chicago = baltimore.replace('巴尔的摩', '芝加哥');
    assert.equal(api.setting(chicago, p.sourceText), true);
    const statement = /We then examine CPD data[^.!?\n]*20% transcribed, 80% untranscribed data splits\./u;
    assert.match(p.sourceText, statement);
    for (const replacement of ['', 'If a hypothetical experiment were conducted, we would examine CPD data with the same 20% transcribed, 80% untranscribed data splits.']) {
        const source = p.sourceText.replace(statement, replacement);
        assert.equal(api.setting(baltimore, source), true);
        assert.equal(api.setting(chicago, source), false);
    }
}));

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const crypto = require('node:crypto'), Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.methodHandoff=hasExplicitNaturalProductChain;', filename);
const api = compiled.exports;
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/core-summary-method-handoff-20261023-real.json.gz'))));
const paper = id => fixture.papers.find(row => row.paperId === id);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);

test('方法链真实材料完整SHA与拒绝历史保留，普通fixture从不授来源或采纳', noModel(() => {
    assert.equal(fixture.papers.length, 5);
    for (const row of fixture.papers) {
        assert.equal(sha(row.sourceText), row.sourceSha256);
        assert.equal(sha(row.summary), row.summarySha256);
        assert.equal(row.adoptionAuthorized, false);
        assert.equal(row.originalDisposition.status, 'rejected');
        assert.ok(row.summary.includes(row.methodWindow));
    }
}));
for (const row of fixture.papers) {
    test(`真实${row.paperId}产物交接在完整稿与原实际窗口中成立`, noModel(() => {
        assert.equal(api.methodHandoff(row.methodWindow, row.sourceText), true);
        assert.equal(api.methodHandoff(row.summary, row.sourceText), true);
        if (row.paperId === '2610.31415') {
            assert.match(row.knownFactIssue, /Never adopt/u);
            assert.match(row.summary, /未披露训练、推理或部署成本/u);
            assert.match(row.sourceText, /RTX\s*4090/u);
        } else assert.equal(api.validateCoreSummarySemanticContract(row.summary, { sourceText: row.sourceText }), null);
    }));
}

test('同一实际窗口的假设否定第三方与撤回不能贡献方法链', noModel(() => {
    for (const row of fixture.papers) {
        for (const prefix of ['假设', '如果', '预计', '并未实现：', '第三方研究：', '相关工作：', 'previous work: ', 'If ', 'hypothetical: ', 'not implemented: ', '基线方法：', '对照系统：'])
            assert.equal(api.methodHandoff(prefix + row.methodWindow, row.sourceText), false, row.paperId + prefix);
        assert.equal(api.methodHandoff(row.methodWindow + '上述方法链并未执行。', row.sourceText), false, row.paperId + 'revoked');
    }
}));

test('同切分输入的机器与听众是并行测量，换为无关输入不借模块列表授链', noModel(() => {
    const row = paper('2610.29150');
    const wrong = row.methodWindow.replace('将切分后语音送入', '将另一段无关录音送入').replace('相同切分构建配对', '另一个独立语料构建配对');
    assert.equal(api.methodHandoff(wrong, row.sourceText), false);
    assert.equal(api.methodHandoff('频带过滤探针、说话人嵌入、梅尔多层感知机与听众评分分别存在。', row.sourceText), false);
    assert.equal(api.methodHandoff(row.methodWindow.replace('送入', '不送入'), row.sourceText), false);
}));

test('梅尔谱与转写符号必须被紧邻消费者实际使用', noModel(() => {
    const mel = paper('2610.28940'), midi = paper('2610.29026');
    for (const [row, from, to] of [[mel, '再由因果声码器变成波形', '另一个无关系统由因果声码器变成波形'], [midi, '再经Karplus-Strong弦合成与MIDI打击乐发声', '另一个无关系统经Karplus-Strong弦合成与MIDI打击乐发声']]) {
        assert.notEqual(row.methodWindow.replace(from, to), row.methodWindow);
        assert.equal(api.methodHandoff(row.methodWindow.replace(from, to), row.sourceText), false);
    }
    assert.equal(api.methodHandoff('生成器输出梅尔谱。另一个系统的声码器输出波形。', mel.sourceText), false);
    for (const consumed of [
        '再经不使用该符号的Karplus-Strong弦合成与MIDI打击乐发声',
        '再经Karplus-Strong弦合成另一段录音后发声',
        '再经Karplus-Strong弦合成与独立输入的MIDI打击乐发声'
    ]) assert.equal(api.methodHandoff(midi.methodWindow.replace('再经Karplus-Strong弦合成与MIDI打击乐发声', consumed), midi.sourceText), false, consumed);
    for (const text of [
        '转写器把音频转写为符号，再经不使用该符号的简化弦合成发声。',
        '转写器把音频转写为符号，再经简化弦合成别的输入后发声。',
        '转写器把音频转写为符号，再经简化弦合成另一段语音发声。'
    ]) assert.equal(api.methodHandoff(text), false, text);

}));

test('并行诊断的join必须接收原局部产物而非把两层串联', noModel(() => {
    const row = paper('2610.29816');
    for (const [from,to] of [['并行送入', '串行送入'], ['接收三层局部诊断与分类结果', '另外讨论三层局部诊断与分类结果'], ['融合后经通信层映射', '丢弃后经通信层映射']])
        assert.equal(api.methodHandoff(row.methodWindow.replace(from,to), row.sourceText), false, from);
    assert.equal(api.methodHandoff('物理层、特征层、协调层与通信层各有不同职责。', row.sourceText), false);
}));

test('优化产物必须由真实内外层更新得到并被同一目标微调消费，配置不是执行', noModel(() => {
    const row = paper('2610.31415');
    for (const [from,to] of [['做50步内层更新得到回合终点', '配置50步内层更新但不执行'], ['该初始化随即用', '另一个独立初始化随即用'], ['向回合终点的平均方向外层移动', '不向回合终点的平均方向外层移动']])
        assert.equal(api.methodHandoff(row.methodWindow.replace(from,to), row.sourceText), false, from);
    assert.equal(api.methodHandoff('模型配置初始化与50步内层更新，随后列出外层更新和目标语音微调。', row.sourceText), false);
}));


test('同角色同产物语法不依赖论文名，逆序生产或纯模块配置仍拒', noModel(() => {
    for (const text of [
        '频带过滤模块把录音按高通切分，将切分后语音送入说话人嵌入余弦计算，并用相同切分构建配对交由听众评分。',
        '声学模型处理输入条件，输出梅尔谱，再由声码器合成波形。',
        '转写器把音频转写为符号，再经简化弦合成发声。',
        '内层更新得到回合终点，再把初始化向回合终点的平均方向外层更新得到新初始化，该初始化随后用目标域真实目标语音微调。',
        '有效的输入块并行送入后两层，物理层检测输入并输出故障标志，表示层监测输入并输出偏移状态。协调层接收两层局部诊断与分类结果，融合后经通信层映射为固定状态与灯号。'
    ]) assert.equal(api.methodHandoff(text), true, text);
    assert.equal(api.methodHandoff('将切分后语音送入说话人嵌入余弦计算，并用相同切分构建配对交由听众评分，最后过滤模块把另一段录音按低通切分。'), false);
}));

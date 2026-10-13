'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('../scripts/analysis-contract');
const summaries = require('./fixtures/core-symbolic-geometry-paid-summaries.json');
const sourceDefinition = 'We define a transformation class for a point-set representation and an inter-pattern transformation graph.\nTable 1 describes this graph.\nWe call such a graph an inter-pattern transformation graph (IPTG) and the corresponding tabular representation is essentially an adjacency matrix [2, pp. 589–592], where an edge from pattern P1P_{1} to pattern P2P_{2} is labelled with the transformation(s) in the specified transformation class that map P1P_{1} onto P2P_{2}.';
const chain = '编码把每个音符转为音高时间平面上的点，得到的点集作为下一步几何判定的输入。几何判定在点集上检验类变换能否把一个主题完全精确重合到另一出现，输出两两映射关系。';
const refused = [
    '编码、点集、几何判定、映射关系、制图分别用于处理数据。',
    chain.replace('转为', '不转为'),
    chain.replace('转为', '不再转为'),
    chain.replace('转为', '未曾被转为'),
    chain.replace('得到的点集', '如果得到的点集'),
    chain.replace('检验类变换', '检验是否应该进行类变换'),
    chain.replace('在点集上', '在其他点集上'),
    chain.replace('编码把', '假设编码把'),
    chain.replace('作为下一步', '未曾作为下一步'),
    chain.replace('得到的点集', '另一组点集'),
    chain.replace('得到的点集', '得到的音频特征'),
    chain.replace('几何判定在点集上检验', '几何判定计划在点集上检验'),
    chain.replace('几何判定在点集上检验', '几何判定把点集交给独立基线检验'),
    chain.replace('几何判定在点集上检验', '另一套独立方法在点集上检验'),
    chain.replace('。几何判定', '。处理成本只有2秒。几何判定'),
    '模型在测试集上准确率从80%提高到90%，处理速度达到2倍。'
];
test('符号图节点映射不作量值方向，真实性能量值仍须完整比较', () => {
    assert.equal(contract.classifySourceQuantitativeEvidence(sourceDefinition), false);
    const measured = 'Our method accuracy improves from 80% to 90% compared with the baseline on the test dataset.';
    assert.equal(contract.classifySourceQuantitativeEvidence(measured), true);
    assert.equal(contract.stripSymbolicPatternRelation(measured), measured);
    for (const raw of summaries) {
        assert.equal(contract.validateCoreSummarySemanticContract(raw, { sourceText: sourceDefinition }), null);
        for (const metric of ['准确率达到99%', 'WER为1.5%', 'F1为0.9', '准确率达到百分之九十九', '得分达到99%', '性能提高99%', 'score is 99%', 'metric is 99%']) {
            const invented = raw.replace('跨作品检索', metric + '，跨作品检索');
            assert.equal(contract.hasScopedSymbolicDemonstration(invented), false);
            assert.match(contract.validateCoreSummarySemanticContract(invented, { sourceText: sourceDefinition }), /关键定量结果/);
        }
        assert.match(contract.validateCoreSummarySemanticContract(raw, { sourceText: sourceDefinition + '\n' + measured }), /关键定量结果/);
    }
});
test('实际点集交接与下游处理共同成立，关键词、假设、否定和其他角色不能充数', () => {
    assert.equal(contract.hasSymbolicGeometryMethodChain(chain), true);
    for (const text of refused) assert.equal(contract.hasSymbolicGeometryMethodChain(text), false, text);
    for (const raw of summaries) {
        assert.equal(contract.hasScopedSymbolicDemonstration(raw), true);
        assert.equal(contract.hasScopedSymbolicDemonstration(raw.replace('结论只在该曲HAYDN主题实例上有证据', '所有作品都普遍有效')), false);
        assert.equal(contract.hasScopedSymbolicDemonstration(raw.replace(/跨作品[^。]*尚未验证/, '跨作品均已得到验证')), false);
        for (const denial of ['跨作品已经得到验证，并非尚未验证', '跨作品并非尚未验证', '跨作品不是尚未验证']) {
            assert.equal(contract.hasScopedSymbolicDemonstration(raw.replace(/跨作品[^。]*尚未验证/, denial)), false);
        }
    }
});
test('Python表达检查镜像三真实付费摘要与相同反例，不替代Node来源分类', () => {
    const script = String.raw`import ast, json, re, sys
from pathlib import Path
source = Path('scripts/publish-to-blog.py')
functions = {node.name: node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef)}
names = {'_detailed_core_summary_semantic_issue', '_has_symbolic_geometry_method_chain'}
while True:
    expanded = names | {node.func.id for name in names for node in ast.walk(functions[name]) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions}
    if expanded == names:
        break
    names = expanded
environment = {'re': re}
exec(compile(ast.Module(body=[functions[name] for name in functions if name in names], type_ignores=[]), str(source), 'exec'), environment)
values = json.load(sys.stdin)
print(json.dumps({'summaries': [environment['_detailed_core_summary_semantic_issue'](text.replace('## 核心摘要', '').strip()) for text in values['summaries']], 'chains': [environment['_has_symbolic_geometry_method_chain'](text) for text in values['chains']]}, ensure_ascii=False))`;
    const deniedLimits = ['跨作品已经得到验证，并非尚未验证', '跨作品并非尚未验证', '跨作品不是尚未验证']
        .map(value => summaries[0].replace(/跨作品[^。]*尚未验证/, value));
    const inventedMetrics = ['准确率达到99%', 'WER为1.5%', 'F1为0.9', '准确率达到百分之九十九', '得分达到99%', '性能提高99%', 'score is 99%', 'metric is 99%']
        .map(metric => summaries[0].replace('跨作品检索', metric + '，跨作品检索'));
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
        cwd: path.resolve(__dirname, '..'), input: JSON.stringify({ summaries: [...summaries, ...deniedLimits, ...inventedMetrics], chains: [chain, ...refused] }), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout);
    assert.deepEqual(values.summaries.slice(0, 3), [null, null, null]);
    for (const issue of values.summaries.slice(3)) assert.match(issue, /关键定量结果/);
    assert.deepEqual(values.chains, [true, ...refused.map(() => false)]);
});

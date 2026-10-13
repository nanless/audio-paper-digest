'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {spawnSync} = require('node:child_process');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const runtime = new Module(filename, module);
runtime.filename = filename;
runtime.paths = Module._nodeModulePaths(path.dirname(filename));
runtime._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.quantitative = coreSummaryQuantitativeResultState;', filename);
const {hasBlockLayoutProductChain, validateCoreSummarySemanticContract, quantitative} = runtime.exports;
const actualSummary = "## 核心摘要\n\n联合视频音频生成需由文本与参考图像同步输出视频流与音频流，2K原生训练单个片段经压缩可达约870K词元，全注意力二次代价过高且重复背景稀释发声区域权重。Prism把视频词元网格组织为时空宏区，每层每头独立估计变化指示，合并视频通道方差与音频到视频交叉注意力范数，分别刻画视觉沿时空方向变化快慢与音频对各区域影响强度。基于这些信号为每个宏区动态分配定制块形状，沿快速变化与强音视耦合轴更细划分，块体积按信息密度分为64、128、256三档以保持块内语义连贯。该布局经置换重排进入查询块与键块筛选，以块均值特征计算块分数并用混合Top-k与Top-p为分散查询补充键块，选中键块进入稀疏注意力内核计算再经逆置换恢复原序。在包含300个未见2K视频的2K-Bench上，Prism相对全注意力骨干MOVA在去同步误差DeSync上从1.05降至0.63，数值越低越好。在同一包含300个未见2K视频的2K-Bench比较中，Prism相对同一全注意力骨干MOVA在运动质量MotionQ上从0.53升至0.89，数值越高越好。在2K原生训练与推理测量口径下，Prism相对全注意力实现2.5倍训练加速，原文报告2K单步训练时间从26.5分钟降至10.6分钟，4卡并行推理延迟从1091秒降至331秒。结论限于视频自注意力稀疏化，音频自注意力与跨模态注意力保持不变，相机频繁变焦致单个宏区混合远近内容时会模糊。\n";
const chain = '该布局经置换重排进入查询块与键块筛选，以块均值特征计算块分数并用混合Top-k与Top-p为分散查询补充键块，选中键块进入稀疏注意力内核计算再经逆置换恢复原序。';
const badChains = [
    chain.replace('进入查询块', '未进入查询块'),
    chain.replace('计算块分数', '不计算块分数'),
    chain.replace('选中键块进入', '选中键块未曾进入'),
    chain.replace('恢复原序', '未恢复原序'),
    chain.replace('该布局', '假设该布局'),
    '讨论' + chain,
    '这里只讨论' + chain.replace('。', '，实际尚不实现。'),
    chain.replace('补充键块', '分别存档'),
    chain.replace('选中键块', '另一组键块'),
    '布局模块、块均值模块、键块筛选模块、稀疏注意力内核和逆置换模块分别负责处理数据。'
];
test('真实块布局产物经筛选交给内核；动词罗列和无实际交接仍拒绝', () => {
    assert.equal(hasBlockLayoutProductChain(chain), true);
    for (const text of badChains) assert.equal(hasBlockLayoutProductChain(text), false, text);
});
test('数字开头且明确Bench后缀的命名设置与MotionQ可组成完整比较', () => {
    const statement = '在300个未见2K视频的2K-Bench上，Prism相对MOVA的MotionQ从0.53升至0.89，越高越好。';
    assert.equal(quantitative(statement).complete, true);
    assert.equal(quantitative(statement.replace('2K-Bench上', '2K-Benchxyz上')).complete, false);
    assert.equal(quantitative(statement.replace('MotionQ', 'MotionQxyz')).complete, false);
    assert.equal(quantitative(statement.replace('2K-Bench上', '2K分辨率上')).complete, false);
});
test('真实自然表述的完整摘要通过；范围否定、缺交接和没有结果设置仍拒', () => {
    assert.equal(validateCoreSummarySemanticContract(actualSummary), null);
    const denied = actualSummary.replace('结论限于视频自注意力稀疏化', '不能认为结论限于视频自注意力稀疏化');
    assert.match(validateCoreSummarySemanticContract(denied), /缺少结论适用边界/);
    for (const refusal of ['并不保持不变', '不会保持不变', '未曾保持不变']) {
        assert.match(validateCoreSummarySemanticContract(actualSummary.replace('保持不变', refusal)), /缺少结论适用边界/);
    }
    assert.match(validateCoreSummarySemanticContract(actualSummary.replace(chain, badChains[5])), /缺少 2–4 步方法链/);
});
test('Python对实际块布局交接及所有否定稿作出相同判定', () => {
    const script = String.raw`import ast, json, re, sys
from pathlib import Path
source = Path('scripts/publish-to-blog.py')
tree = ast.parse(source.read_text())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_has_block_layout_product_chain')
environment = {'re': re}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), environment)
print(json.dumps([environment[function.name](text) for text in json.load(sys.stdin)]))`;
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {cwd:path.resolve(__dirname,'..'), input:JSON.stringify([chain,...badChains]), encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [true, ...badChains.map(() => false)]);
});

test('Python完整摘要与Node一致，正常范围和明确否定不能混同', () => {
    const script = String.raw`import ast, json, re, sys
from pathlib import Path
source = Path('scripts/publish-to-blog.py')
functions = {node.name: node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef)}
names = {'_detailed_core_summary_semantic_issue'}
while True:
    expanded = names | {node.func.id for name in names for node in ast.walk(functions[name]) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions}
    if expanded == names:
        break
    names = expanded
environment = {'re': re}
exec(compile(ast.Module(body=[functions[name] for name in functions if name in names], type_ignores=[]), str(source), 'exec'), environment)
print(json.dumps([environment['_detailed_core_summary_semantic_issue'](text.replace('## 核心摘要', '').strip()) for text in json.load(sys.stdin)], ensure_ascii=False))`;
    const denied = actualSummary.replace('结论限于视频自注意力稀疏化', '不能认为结论限于视频自注意力稀疏化');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {cwd:path.resolve(__dirname,'..'), input:JSON.stringify([actualSummary, denied, actualSummary.replace('保持不变', '并不保持不变'), actualSummary.replace('保持不变', '不会保持不变')]), encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const issues = JSON.parse(result.stdout);
    assert.equal(issues[0], null);
    for (const issue of issues.slice(1)) assert.match(issue, /缺少结论适用边界/);
});

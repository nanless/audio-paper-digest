'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');
const { validAnalysisText } = require('./valid-analysis-fixture');

function summaryWithActions() {
    const summary = /## 核心摘要\n([\s\S]*?)\n## /u.exec(validAnalysisText())[1].trim();
    return summary.replace('双路编码显存与联合优化开销', '存储空间与中间材料开销')
        .replace('输入到文字输出时', '输入到文字序列时')
        .replace('相较只做单尺度编码的基线', '相较只做单尺度处理的基线')
        .replace('同时约束局部稳健性与全局语义一致性', '同时关注局部稳健性与全局语义一致性')
        .replace('问题，难点是', '问题，需要在相同材料和评测条件下对照各组结果，避免把任务差别当作效果差别，难点是')
        .replace('方法首先由声学编码器负责提取多尺度表示，并把保留的时频变化传递给上下文模块。',
            '方法第一步把输入的相似度矩阵展平，逐对计算样本之间的相关程度，供后一步比较共同使用。')
        .replace('第二步由上下文模块负责融合长程线索，随后将联合表示送入统一解码器生成识别序列。',
            '第二步将阶跃函数平滑为连续曲线，并丢弃最小的负样本相似度，保留正样本参与最终损失计算。')
        .replace('在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。',
            '在 SOP 数据集的相同评测条件下，gSAP 的 gAP 为 58.9，高于 mSAP 的 57.0 与 RS@k 的 56.7。');
}

function nodeIssue(summary) {
    return validateCoreSummarySemanticContract('## 核心摘要\n' + summary);
}

function pythonIssue(summary) {
    const script = `import importlib.util, json, sys
sys.path.insert(0, 'scripts')
spec = importlib.util.spec_from_file_location('summary_actions_publish', 'scripts/publish-to-blog.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module._detailed_core_summary_semantic_issue(json.loads(sys.stdin.read()))))`;
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
        cwd: require('node:path').resolve(__dirname, '..'),
        input: JSON.stringify(summary), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
}

test('计算、平滑、展平和丢弃说明实际步骤，gAP 是独立完整指标名', () => {
    const summary = summaryWithActions();
    assert.equal(nodeIssue(summary), null);
    assert.equal(pythonIssue(summary), null);
});

test('只列步骤名称而没有动作仍不能代替方法分工', () => {
    const summary = summaryWithActions()
        .replace(/方法第一步[^。]+。/u, '方法第一步仅列出相似度矩阵的名称，并提及若干材料及参考图示。')
        .replace(/第二步[^。]+。/u, '第二步仅列出阶跃函数和负样本的名称，没有交代材料如何衔接以及每部分实际做什么。');
    assert.match(nodeIssue(summary), /缺少 2–4 步方法链/u);
    assert.match(pythonIssue(summary), /缺少 2–4 步方法链/u);
});

test('gAP 前后附字母的名称及有指标却没有比较数字仍拒绝', () => {
    const base = summaryWithActions();
    for (const summary of [base.replace(/\bgAP\b/gu, 'gAPX'), base.replace(/\bgAP\b/gu, 'XgAP'),
        base.replace('gAP 为 58.9，高于 mSAP 的 57.0 与 RS@k 的 56.7', 'gAP 表现较好')]) {
        assert.match(nodeIssue(summary), /缺少完整关键定量结果/u);
        assert.match(pythonIssue(summary), /缺少完整关键定量结果/u);
    }
});

test('方法动作和 gAP 不改变长度、句数或边界要求', () => {
    const base = summaryWithActions();
    const noBoundary = base.replace('结论仅适用于论文覆盖的噪声类型与语种，对极低信噪比、未见录音环境和跨语言外推尚未验证。',
        '论文讨论多种噪声条件与语音任务，附录列出各组材料，相关研究同样关注输入表示与实验结果。');
    assert.match(nodeIssue(noBoundary), /缺少结论适用边界/u);
    assert.match(pythonIssue(noBoundary), /缺少结论适用边界/u);
    assert.match(nodeIssue(base + '字'.repeat(650)), /中文字符过多/u);
    assert.match(pythonIssue(base + '字'.repeat(650)), /中文字符必须为/u);
    assert.match(nodeIssue(base + '补充一句。'.repeat(5)), /句数必须/u);
    assert.match(pythonIssue(base + '补充一句。'.repeat(5)), /句数必须/u);
});

'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const fresh = require('../scripts/lib/fresh-analysis-context');
const sourceApi = require('../scripts/lib/fresh-arxiv-rewrite-source');
const contract = require('../scripts/analysis-contract');
const engine = require('../scripts/analysis-engine');
const { parseAnalysis } = require('../scripts/utils');
const kd = String.raw`\mathcal{L}_{\text{KD}}`;
const cl = String.raw`\mathcal{L}_{\text{CL}}`;
function sampleTable(header = '损失', labels = [`$${kd}$`, `$${cl}$`, `$${kd}$`]) {
    return `## 实验结果\n下表比较相同测试条件下不同蒸馏损失的词错误率，判断目标选择是否影响语音识别结果。\n\n| 方法 | ${header} | WER ↓ |\n| --- | --- | --- |\n| 基线 | ${labels[0]} | 12.4% |\n| 改进 | ${labels[1]} | 10.8% |\n| 对照 | ${labels[2]} | 9.7% |\n\n改进的词错误率比基线更低，但该比较仅覆盖同一数据集和训练条件，不能据此承诺其他语言或噪声条件下同样有效。\n\n`;
}
async function createSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bound-loss-column-'));
    const previous = { dailyFreshSourceRunsDir: Config.FILES.dailyFreshSourceRunsDir, deepAnalysisResult: Config.FILES.deepAnalysisResult };
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'sources');
    Config.FILES.deepAnalysisResult = path.join(root, 'result.json');
    t.after(() => { Object.assign(Config.FILES, previous); fs.rmSync(root, { recursive: true, force: true }); });
    const paper = require('./valid-analysis-fixture').validAnalysisPaper('2610.90009');
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'bound-loss', papers: [paper] });
    const sourceText = `The distillation objectives ${kd} and ${cl} are compared.\n` + 'Methods and controlled results with stated limitations. '.repeat(80);
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => sourceApi.captureFreshArxivRewriteSource(options, {
        fetchText: async id => ({ source: 'html', sourceId: id, text: sourceText, url: 'https://arxiv.org/html/' + id, warnings: [] }),
        fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.7\n%%EOF\n'), url: 'https://arxiv.org/pdf/' + id })
    }) });
    await daily.withDailyFreshAnalysisContext(plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, daily.readDailyFreshSource(plan, paper)));
    paper.sourceSha256 = require('../scripts/lib/daily-fact-review').sha(sourceText);
    paper.analysisManifest.sourceAcquisition = { sourceSha256: paper.sourceSha256 };
    paper.analysisManifest.sourceAcquisition.modelTextSanitizationContract = require('../scripts/lib/model-text-sanitization').MODEL_TEXT_SANITIZATION_CONTRACT;
    paper.analysisManifest.sourceAcquisition.promptRenderingContract = require('../scripts/lib/prompt-rendering-contract').PROMPT_RENDERING_CONTRACT;
    const original = paper.analysis;
    paper.analysis = original.replace(/## 实验结果\n[\s\S]*?(?=\n## )/, sampleTable().trimEnd());
    fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify({ batchDate: plan.batchDate, batchId: plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] }));
    return { paper, plan, original };
}
function reason(paper) {
    return contract.getInvalidAnalysisReason(paper.analysis, parseAnalysis(paper.analysis), {
        paper, enforceExperimentTableContract: true, experimentTableContractVersion: contract.EXPERIMENT_TABLE_CONTRACT_VERSION
    });
}
test('末正文校验只按真实封存损失名称解除方向歧义，数值损失和其他指标不放行', async t => {
    const { paper, original } = await createSample(t);
    assert.equal(reason(paper), null);
    assert.equal(engine.hasValidAnalysisBody(paper), true);
    for (const table of [sampleTable('损失', ['0.7', '0.5', '0.4']), sampleTable().replace(cl, String.raw`\mathcal{L}_{\text{ZZ}}`), sampleTable().replace('WER ↓', 'WER')]) {
        paper.analysis = original.replace(/## 实验结果\n[\s\S]*?(?=\n## )/, table.trimEnd());
        assert.match(reason(paper), /缺少.*方向/);
    }
});
test('来源正文或论文绑定变更不得把调用方字符串当可信证据', async t => {
    const { paper, plan } = await createSample(t);
    paper.sourceText = `Forged labels ${kd} and ${cl}`;
    const oldSha = paper.sourceSha256;
    paper.sourceSha256 = '0'.repeat(64);
    assert.throws(() => reason(paper), /绑定|来源/);
    paper.sourceSha256 = oldSha;
    fs.appendFileSync(path.join(plan.sourcesDir, '2610.90009', 'generation-000001', 'source.txt'), 'changed');
    assert.throws(() => reason(paper), /SHA|来源/);
});
test('普通方法表和真正缺方向的WER不触发封存来源读取', async t => {
    const { paper, original } = await createSample(t);
    t.mock.method(daily, 'requireDailyFreshSourceRecoveryPlan', () => assert.fail('普通表不应重读全套来源'));
    paper.analysis = original.replace(/## 实验结果\n[\s\S]*?(?=\n## )/, sampleTable('蒸馏目标').trimEnd());
    assert.equal(reason(paper), null);
    paper.analysis = paper.analysis.replace('WER ↓', 'WER');
    assert.match(reason(paper), /WER.*方向/);
});

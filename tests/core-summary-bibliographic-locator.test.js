'use strict';

// 2611.05637 是一篇研究方案：全文没有实测数值，只有计划中的三条件对照与分类表。
// 它的核心摘要连续 20 次写下“原文未提供可核对的关键定量结果”并被同一误报拒绝，
// 因为双栏 PDF 抽取把参考文献行粘进了正文句子（source.txt 第 163–165 行），
// 参考文献页码成了句内唯一数值，与正文的 accuracy 拼成一条并不存在的实测结果。
// 这里固定封存来源的逐字片段、真实付费候选摘要，以及“页码被删掉但真实测量值
// 必须保留”的对照，避免把这条修复做成对任何含 pp. 的句子一律放行。

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

// 逐字来自 data/runtime/daily-fresh-source-runs/3e4ef3f4-.../sources/2611.05637/
// generation-000001/source.txt 第 163–165 行，按 validateCoreSummarySemanticContract
// 的软换行合并规则拼成的完整句。左栏正文与右栏文献行交错是抽取产物，不是作者写法。
const BIBLIOGRAPHIC_SENTENCE = 'We will therefore report time and Computing Machinery, Apr. 2008, '
    + 'pp. 1497–1500. doi: unnecessary repair actions alongside accuracy, and treat a '
    + '10.1145/1357054.1357288. pictogram that adds seconds without changing outcomes as a negative result';

// 同一篇的来源其余部分（逐字取自封存来源的正文与计划段），用于完整校验。
const PROPOSAL_SOURCE = [
    'A speech recognizer will supply a transcript and alternatives for selected low-confidence spans.',
    'We will develop a small test set of everyday requests recorded by multiple speakers in French and Spanish.',
    'Participants will resolve uncertain messages under three displays: top-one transcript, transcript with alternatives, '
        + 'and transcript with alternatives plus validated pictograms.',
    'We will measure critical-word correction, task-intent recovery, time and unnecessary repair actions.',
    'The number of participants and the final noise levels will be refined in pilot testing rather than selected retrospectively.',
    'Coverage and abstention rates will be reported per language, because coverage and suitability are known to differ between languages.',
    BIBLIOGRAPHIC_SENTENCE + '.'
].join(' ');

// 2611.05637 第 7 轮第 3 次候选摘要，逐字来自保存的诊断请求
// reader-attempts/core-summary-repair/direct-22d0.../request-diagnostics/ceaa3d02-....request.json。
const SAVED_CANDIDATE = '带噪、口音或语码混杂的法语和西班牙语日常请求经语音识别转写后，'
    + '地点、对象、否定或时间顺序等关键片段的不确定可能被最可能字符串掩盖，听者易把错误动作当作已核实接受。'
    + '先由固定识别器提供转写文本、低置信片段的词格或混淆网络备选及局部时间戳，'
    + '再由修复策略在任务相关片段上筛选与句式一致的短文本备选并用留出开发集校准中断阈值，把可重放片段送入配图核对环节。'
    + '最后配图查找以候选短语而非孤立词为单位提取候选映射，其输出经按完整短语的人工审核后才允许显示，'
    + '抽象的极性词与时间关系及无合适图像者只输出文本与局部重放控件，并记录完全、部分或未配图状态。'
    + '与把整句直接译成配图序列的工作不同，该方案把配图当作转写主通道上的局部可选核对手段，'
    + '并计划在自录多说话人请求加受控噪声下用三条件显示对照检验关键次纠正、任务意图恢复与时间的增量价值。'
    + `原文未提供可核对的关键定量结果。`
    + '结论只适用于受控噪声下法语和西班牙语具体概念的可行性验证，'
    + '语码混杂、口语变体、区域词汇及仅单侧配图拉偏等情况可能失败，日常会话鲁棒性与葡萄牙语扩展尚未验证。'
    + '原文未披露训练、推理或部署成本。';

function analysisWithSummary(summary) {
    return validAnalysisText().replace(
        /## 核心摘要\n[\s\S]*?\n\n## 方法概述和架构/u,
        `## 核心摘要\n${summary}\n\n## 方法概述和架构`
    );
}

test('参考文献的卷期与页码是文献定位，不是实测数值', () => {
    // 页码单独出现在计划句里：剥掉定位记号后句内没有数值，因此不是结果。
    const locatorsOnly = 'We will therefore report time and unnecessary repair actions alongside accuracy, '
        + 'and treat a pictogram that adds seconds without changing outcomes as a negative result, pp. 1497–1500.';
    assert.equal(contract.hasCoreSummaryQuantitativeEvidence(locatorsOnly), false);
    // 真实句子还夹着 DOI，来源分类器先剥 DOI 再按同一规则判定。
    assert.equal(contract.classifySourceQuantitativeEvidence(BIBLIOGRAPHIC_SENTENCE, [BIBLIOGRAPHIC_SENTENCE]), false);
    assert.equal(contract.classifySourceQuantitativeEvidence(PROPOSAL_SOURCE,
        PROPOSAL_SOURCE.split(/[。！？!?\n]|\.(?=\s+[A-Z][A-Za-z]|$)/u).map(value => value.trim()).filter(Boolean)), false);
});

test('删除文献定位时不连带删除同句的真实测量值', () => {
    const measured = 'Our method accuracy improves from 80% to 90% compared with the baseline on the test dataset, '
        + 'see pp. 1497–1500 for the cited protocol.';
    assert.equal(contract.hasCoreSummaryQuantitativeEvidence(measured), true);
    assert.equal(contract.classifySourceQuantitativeEvidence(measured, [measured]), true);
    // 卷期号同样只是定位：它们不能顶替测量值，也不能掩盖同句的测量值。
    const withoutValue = 'Our method accuracy improves compared with the baseline, vol. 14, no. 1, pp. 5–26.';
    assert.equal(contract.hasCoreSummaryQuantitativeEvidence(withoutValue), false);
});

test('原文只有计划与文献页码时，如实写“未提供关键定量结果”的候选摘要通过', () => {
    assert.equal(contract.validateCoreSummarySemanticContract(analysisWithSummary(SAVED_CANDIDATE),
        { sourceText: PROPOSAL_SOURCE }), null);
    // 同一份摘要删掉声明后仍然被拒：通过的是如实声明，不是放宽阈值。
    const undeclared = SAVED_CANDIDATE.replace('原文未提供可核对的关键定量结果。', '');
    assert.match(contract.validateCoreSummarySemanticContract(analysisWithSummary(undeclared),
        { sourceText: PROPOSAL_SOURCE }), /关键定量结果/u);
});

test('原文确实有实测结果时，同一份“未提供”声明仍被拒绝', () => {
    const measuredSource = `${PROPOSAL_SOURCE} Our method accuracy improves from 80% to 90% compared with the baseline on the test dataset.`;
    assert.match(contract.validateCoreSummarySemanticContract(analysisWithSummary(SAVED_CANDIDATE),
        { sourceText: measuredSource }), /关键定量结果/u);
});

test('把文献规范研究的数值当成本文结果仍被拒绝', () => {
    // 同一篇第 7 轮第 2 次候选摘要（00562fa8-…，15:04Z），逐字来自保存的诊断请求。
    // 它删掉了“未提供”声明，改用 ARASAAC 规范研究 [1] 的 1525 幅配图结果充当本文证据；
    // 修掉页码误报后这条仍然被拒，只是理由回到正确的那一条。
    const literatureCandidate = '带噪、口音或语码混杂的法语和西班牙语日常请求经语音识别转写后，'
        + '不确定片段易把地点、对象、否定或时间顺序写错，只看最可能的字符串会让人接受错误动作。'
        + '论文设定的输入是固定识别器给出的转写文本及低置信片段的候选词与时间戳，输出是听者核对后恢复的关键动作及其参数。'
        + '先由固定识别器保留词假设与局部时间戳，输出可局部重放的不确定片段与形式与句内一致的短文本备选，送入修复界面决定何时打断。'
        + '再以候选短语而非孤立词为单位查找配图，审查员按完整短语批准或禁止配图，多义只认整短语、抽象词与无合适图像时只显示文本和重放控件，该筛选输出进入界面展示。'
        + '在1525幅ARASAAC配图规范数据中，以透明度和可猜度为指标比较，名词得分高于其他词类，意象性和具体性与两者的相关最强。'
        + '最后在自录法语和西班牙语日常请求加受控噪声的条件下，用最优转写、加备选、加备选与已审核配图三条件对照，检验关键词纠正、任务意图恢复、时间与多余修复动作。'
        + '结论只适用于受控噪声下的法语和西班牙语具体任务片段可行性检验，'
        + '语码混杂、俗语地域词与真实日常对话条件覆盖稀疏且尚未验证，部分候选有图、部分无图时图像还可能牵引误选；原文未披露训练、推理或部署成本。';
    assert.match(contract.validateCoreSummarySemanticContract(analysisWithSummary(literatureCandidate),
        { sourceText: PROPOSAL_SOURCE }), /必须明确写“原文未提供可核对的关键定量结果”/u);
});

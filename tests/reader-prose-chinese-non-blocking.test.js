'use strict';
// 2026-11-16 审计：Reader 的「散文汉字」下限从硬失败降级为只提示。
// 起因是实测有 36 篇已发布存档的散文汉字落在 4239–4494（总量仍达标，靠表格、
// 图注和术语组合块补齐），旧的硬门槛会把签名修正、诊断重放与会议冷重放全部
// 无故判失败。本测试固定两点：
//   1) 总字数达标、散文汉字不足的草稿必须继续通过解析；
//   2) 降级只针对散文门槛，总字数门槛本身仍然拦截。
// 说明：实现里的 `proseChineseCharsBelowMinimum`（deep-analyzer.js 约 7837 行）
// 只是 parseApiReaderArticleResultUnchecked 内的局部变量，既没有写进返回的
// plan/article，也没有进入 qualityMetrics 或 analysisManifest，外部无法取得。
// 因此第 1 项只能断言「不抛错」这一可观察行为，无法直接断言该值已被记录。
const assert = require('node:assert/strict');
const test = require('node:test');
const deep = require('../scripts/deep-analyzer.js');
const { fixture } = require('./reader-signed-draft-fixture.js');

const chinese = value => (String(value).match(/[\u3400-\u9fff]/g) || []).length;

// 与 deep-analyzer.js 里 proseSurface 的过滤规则保持一致：去掉表格行、图片块、
// 看图路径、图注与术语组合块后，剩下的才算散文汉字。
function proseChinese(article) {
    const proseLines = String(article).split('\n').filter(line => {
        const text = line.trim();
        if (!text) return false;
        if (text.startsWith('|')) return false;
        if (text.startsWith('![')) return false;
        if (text.startsWith('> **看图路径')) return false;
        if (/^\*论文图/.test(text)) return false;
        if (/^\*\*[^*]+ × [^*]+：\*\*/.test(text)) return false;
        return true;
    });
    return chinese(proseLines.join('\n'));
}

// 每个术语组合解释追加两条互不重复的长句，把非散文汉字补进总字数；图注与
// 表格单元格本来就不计入散文。四组内容各不相同，避免被重复长句清理删掉。
const BRIDGE_PADDING = [
    ['阅读第一组术语时先把两个词的日常含义与技术用法分开，确认前者限定候选范围、后者核对声学细节，再检查组合后新增的约束是否真的用于决策。',
        '若把其中一项替换成同义表达，还要看候选空间与证据核对的先后关系是否仍然成立，不能只凭名称相近就认为组合有效。',
        '如果换成别的任务，还要先确认这两个词是否仍然指向同一类对象，不能把别的论文里的定义直接套用过来，否则后面的比较就没有共同口径。'],
    ['第二组的读法要沿着证据来源走：先看语义锚点排除了哪些候选，再看声学证据如何给出时序判断，最后核对两者一致时才允许输出结果。',
        '这一组还要记录失败样本落在哪一步，因为只有错误可复现时，组合是否真的缩小了搜索范围才有可检验的含义。',
        '记录时把成功与失败样例分开列出，并注明对应的材料、指标和基线版本，这样读者才能复核组合在哪些条件下仍然成立。'],
    ['第三组不能只看名称是否相邻，还要追问若去掉其中一项会发生什么，以及论文用什么对照实验证明这项组合确实改变了错误分布。',
        '如果论文只报告组合后的总指标，就应把缺少拆解当作证据边界，不能替作者补出各部分贡献或假定它们线性相加。',
        '论文若没有给出拆解实验，就只能把组合当作整体观察，不能把总收益平摊到每个词上，也不能据此推断单独使用时的表现。'],
    ['第四组需要回到当前评测条件：同一批材料、同一套指标和同一组基线是否覆盖了组合的使用边界，未覆盖的场景只能留作后续验证。',
        '部署时还要重新测延迟与显存占用，因为离线指标的改善可能来自更长的输入窗口或更大的批大小，这些条件必须单独核对。',
        '最后要把离线结论和在线约束分开陈述，明确哪些限制来自当前材料与评测协议，哪些还需要新的实验或部署验证。']
];

function parseOptions(sourceDetails) {
    return {
        requiredVersion: 3,
        requireIntegratedTables: true,
        minimumIntegratedTables: 2,
        availableFigureOrdinals: [1],
        requireSourceBindings: true,
        allowDeterministicQuoteRepair: true,
        structuredArtifacts: sourceDetails.structuredArtifacts,
        sourceText: sourceDetails.text
    };
}

// 在合法 Reader 草稿上做定向削弱：去掉若干无表格/公式/图片小节的后两段，
// 把散文压到 4500 以下，再用术语组合块把总字数补回 5000 以上。
function buildDraft({ padBridges = true } = {}) {
    const { draft, sourceDetails } = fixture();
    // 两种档位都先砍掉这些段落：它们的散文会压到 4500 以下；padBridges 档
    // 再用术语组合块把解析前的总字数补回 5000 以上，另一档则保留总量不足。
    // 每种小节都至少保留两段正文，避免先撞上「小节正文过短」。
    const cuts = { 0: 3, 1: 3, 2: 3, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2 };
    for (const [index, remove] of Object.entries(cuts)) {
        const paragraphs = draft.sections[Number(index)].body.split(/\n\s*\n/);
        draft.sections[Number(index)].body = paragraphs.slice(0, paragraphs.length - remove).join('\n\n');
    }
    if (padBridges) {
        draft.conceptBridges.forEach((bridge, index) => {
            bridge.explanation += BRIDGE_PADDING[index].join('');
        });
    }
    return { draft, sourceDetails };
}

test('散文汉字不足但总字数达标的草稿继续通过，不再抛硬门槛错误', () => {
    const { draft, sourceDetails } = buildDraft();
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(draft), parseOptions(sourceDetails));
    const article = parsed.article;
    // 先证明用例前提成立：总量达标、散文不足 4500，且确实用了术语组合块凑字数。
    assert.ok(chinese(article) >= 5000, `总汉字应达标，实际 ${chinese(article)}`);
    assert.ok(chinese(article) <= 18000, `总汉字应在上限内，实际 ${chinese(article)}`);
    assert.ok(proseChinese(article) < 4500, `散文汉字应低于提示线，实际 ${proseChinese(article)}`);
    assert.match(article, /\*\* 语义锚点 1 × 声学证据 1：\*\*/);
    // 只有「不抛错」是外部可观察的；散文计数变量没有暴露，见文件头说明。
});

test('散文门槛降级不等于放开总字数：总汉字不足时仍拒绝', () => {
    const { draft, sourceDetails } = buildDraft({ padBridges: false });
    assert.throws(
        () => deep.parseApiReaderArticleResult(JSON.stringify(draft), parseOptions(sourceDetails)),
        /读者文章中文字数必须为 5000-18000/
    );
});

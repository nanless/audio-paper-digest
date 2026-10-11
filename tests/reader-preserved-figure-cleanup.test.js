'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair.js');
function createReaderTestArticle() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '从声音输入到执行输出的机制解释',
        oneSentenceThesis: '语音方法依次处理输入表征与条件约束，实验需保持对照设置一致，再解释指标变化支持的有限结论。',
        sections: kinds.map((kind, index) => ({ kind, heading: `声音处理中步骤 ${index + 1} 的输入输出如何衔接？`,
            body: `这一部分解释声音处理的${kind}环节，先限定输入信号，再描述信息如何沿组件传递。`.repeat(6) })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['声学表示', '语义条件'], sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: '声学表示保存输入信号的发音结构，语义条件限定合理的内容范围，两者分工使预测既遵循声音证据也满足当前任务约束。'
        })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    draft.sections[3].body += '\n\n' + draft.conceptBridges.map(item => item.marker).join('\n\n');
    return draft;
}


function patchFor(draft, replacements) {
    return { version: 1, draftSha256: repair.hashDraft(draft), replacements: replacements.map(([pointer, value]) => {
        let old = draft;
        for (const part of pointer.slice(1).split('/')) old = old[part];
        return { path: pointer, oldSha256: repair.hashDraft(old), value };
    }) };
}

function createArticleWithFigure() {
    const draft = createReaderTestArticle();
    draft.sections[4].body += '\n\n[[FIGURE_1]]';
    draft.sections[4].body2 = null;
    draft.figurePlacements = [{ figureOrdinal: 1, targetKind: 'component', marker: '[[FIGURE_1]]' }];
    return draft;
}
function createCleanSection(draft) {
    const { kind, heading, body } = draft.sections[4];
    return { kind, heading, body };
}
test('无新增像素时仅删除含原图标记小节的非法字段，原正文与图绑定逐字保留', () => {
    const draft = createArticleWithFigure();
    const original = JSON.stringify(draft);
    const next = repair.applyReaderPatch(draft, patchFor(draft, [['/sections/4', createCleanSection(draft)]]),
        ['/sections/4'], { availableFigureOrdinals: [] });
    assert.equal(next.sections[4].body, draft.sections[4].body);
    assert.equal(next.sections[4].heading, draft.sections[4].heading);
    assert.equal(next.sections[4].kind, draft.sections[4].kind);
    assert.equal(Object.hasOwn(next.sections[4], 'body2'), false);
    assert.deepEqual(next.figurePlacements, draft.figurePlacements);
    assert.equal(JSON.stringify(draft), original);
});
test('缺像素时小节内容、标题、类型及图绑定的改变不能借清理字段获得授权', () => {
    const draft = createArticleWithFigure();
    for (const mutate of [
        section => { section.body += '新增解释'; },
        section => { section.heading += '新标题'; },
        section => { section.kind = 'result'; },
        section => { section.body += '\n\n[[FIGURE_2]]'; },
        section => { section.body2 = null; }
    ]) {
        const section = createCleanSection(draft);
        mutate(section);
        assert.throws(() => repair.applyReaderPatch(draft, patchFor(draft, [['/sections/4', section]]),
            ['/sections/4'], { availableFigureOrdinals: [] }), /not included as pixels/);
    }
    const replacements = [['/sections/4', createCleanSection(draft)],
        ['/figurePlacements/0', { ...draft.figurePlacements[0], targetKind: 'result' }]];
    assert.throws(() => repair.applyReaderPatch(draft, patchFor(draft, replacements),
        replacements.map(([pointer]) => pointer), { availableFigureOrdinals: [] }), /not included as pixels/);
});
test('正文路径即使值不变也不冒结构字段清理；合法小节整体替换仍须像素', () => {
    const draft = createArticleWithFigure();
    assert.throws(() => repair.applyReaderPatch(draft, patchFor(draft, [['/sections/4/body', draft.sections[4].body]]),
        ['/sections/4/body'], { availableFigureOrdinals: [] }), /not included as pixels/);
    delete draft.sections[4].body2;
    assert.throws(() => repair.applyReaderPatch(draft, patchFor(draft, [['/sections/4', createCleanSection(draft)]]),
        ['/sections/4'], { availableFigureOrdinals: [] }), /not included as pixels/);
    assert.doesNotThrow(() => repair.applyReaderPatch(draft, patchFor(draft, [['/sections/4', createCleanSection(draft)]]),
        ['/sections/4'], { availableFigureOrdinals: [1] }));
});
function createValidReaderCase() {
    const deep = require('../scripts/deep-analyzer.js');
    const crypto = require('node:crypto');
    const sourceText = '在统一数据协议与输入条件下，基线和完整方法的报告得分均为1.0，仅用于当前离线对照。';
    const artifacts = { parserVersion: 'unstructured-text-signals-v1', tables: [], formulas: [], figures: [],
        flattenedTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex') };
    artifacts.payloadSha256 = deep.stableFingerprint(artifacts);
    const valid = createReaderTestArticle();
    valid.sections.forEach((section, index) => {
        section.body = [
            `进入第${index + 1}个教学阶段时，先固定这一阶段的输入、输出和失败现象。读者需要知道当前处理的是哪一类信号，它经过什么变换，以及哪个可观测结果才能证明这步确实工作。`,
            `第${index + 1}个环节对应的类型是${section.kind}，它不单独追求一个更好看的数字，而是把控制变量、基线、指标方向和证据来源放在同一口径下。只有比较条件一致，后续差异才有解释价值。`,
            `在第${index + 1}个环节的方法层面应沿着数据流检查：原始观测先变成可学习表示，组件再选择或融合证据，目标函数最后把这些选择投影到任务输出。任何一环没有说清，初学者都会把相关性错当成因果。`,
            `第${index + 1}个环节的实验层面则要同时读正面结果与反例。最强结果能说明当前设置下的净收益，未胜出项、未报告方差和缺失的跨域测试则限定该结论能走多远。这些边界不是附注，而是论证的一部分。`,
            `因此，第${index + 1}个教学阶段最终要交给下一节的不是一句重复摘要，而是一份可执行的核对清单：哪些事实来自原文，哪些解释需要消融，哪些判断还缺对照或测量。沿着这份清单，文章才能逐步收紧中心问题。`,
            `完成第${index + 1}个阶段的比较后，还要说明观测条件发生变化时哪些推断需要重新核对。数据采样与部署环境不完全一致时，当前证据仍然有用，但必须结合新的基线实验确定模型是否保留原有优势。`
        ].join('\n\n');
    });
    valid.conceptBridges.forEach((bridge, index) => { bridge.terms = [`语义锚点${index + 1}`, `声学证据${index + 1}`];
        bridge.explanation = `语义锚点${index + 1}负责限定当前候选的意义范围，声学证据${index + 1}负责核对发音与时序细节。两者搭配后才能把语义排除与声学定位连成可检验的决策链。`; });
    valid.sections[3].body += '\n\n' + valid.conceptBridges.map(item => item.marker).join('\n\n');
    [6, 7].forEach((sectionIndex, index) => {
        valid.sections[sectionIndex].body += '\n\n下表比较统一数据协议中的报告值，输入条件和基线保持一致，得分越高越好。\n\n'
            + '| 比较条件 | 控制变量 | 数据集 | 指标方向 | 报告值 | 解释 |\n|---|---|---|---|---:|---|\n'
            + `| ${index ? '完整方法' : '基线'} | 统一设置 | 测试集 | 越高越好 | 1.0 | 仅支持当前口径 |\n\n`
            + `第${index + 1}张表中数字只能支持当前数据和控制条件下的比较，原始输入范围与评估样本规模都必须保持一致。它没有覆盖的反例、方差、跨域条件和部署成本仍然是结论边界，不能从一行数字向外推广。`;
        valid.tableBindings.push({ tableIndex: index + 1, sourceType: 'source_quotes', sourceTableOrdinal: null,
            cellBindings: [], sourceQuotes: [sourceText] });
    });
    return { valid, options: { sourceText, structuredArtifacts: artifacts,
        requiredVersion: 3, requireSourceBindings: true, requireIntegratedTables: true, minimumIntegratedTables: 2 } };
}


test('结构清理不绕过完整解析器的无可用像素门禁', () => {
    const deep = require('../scripts/deep-analyzer.js');
    const { valid, options } = createValidReaderCase();
    assert.doesNotThrow(() => deep.parseApiReaderArticleResult(JSON.stringify(valid), options));
    valid.sections[4].body += '\n\n[[FIGURE_1]]';
    valid.sections[4].body2 = null;
    valid.figurePlacements = [{ figureOrdinal: 1, targetKind: 'component', marker: '[[FIGURE_1]]' }];
    const { kind, heading, body } = valid.sections[4];
    const merged = repair.applyReaderPatch(valid, patchFor(valid, [['/sections/4', { kind, heading, body }]]),
        ['/sections/4'], { availableFigureOrdinals: [] });
    assert.equal(merged.sections[4].body, body);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(merged), {
        ...options, availableFigureOrdinals: []
    }), /论文没有可用 Figure，figurePlacements 必须为空/);
});

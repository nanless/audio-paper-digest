'use strict';
const assert = require('node:assert/strict');
// 此输入只由已核验的 signed Reader seed 提供；不接受来源不明的普通草稿。
function convert(seed) {
    const { article, plan } = JSON.parse(seed.initialDraft);
    let view = article;
    for (const bridge of plan.conceptBridges || []) {
        assert.equal(view.split(bridge.explanation).length, 2, '术语解释必须对应唯一的已签原句');
        view = view.replace(bridge.explanation, bridge.marker);
    }
    const headings = [...view.matchAll(/^### (.+)\r?$/gm)];
    assert.equal(headings.length, plan.sections.length, '已签正文的章节数量与原写作计划不同');
    const sections = plan.sections.map((section, index) => {
        assert.equal(headings[index][1], section.heading, '已签正文的章节标题或顺序与原计划不同');
        return { kind: section.kind, heading: section.heading,
            body: view.slice(headings[index].index + headings[index][0].length,
                headings[index + 1]?.index ?? view.length).trim() };
    });
    return { version: 3, readerTitle: plan.readerTitle, oneSentenceThesis: plan.oneSentenceThesis,
        sections, conceptBridges: structuredClone(plan.conceptBridges),
        figurePlacements: plan.figurePlacements.map(placement => Object.fromEntries(
            ['figureOrdinal', 'targetKind', 'marker', 'focusPoints']
                .map(key => [key, structuredClone(placement[key])]))),
        tableBindings: plan.tableBindings.map(binding => ({ tableIndex: binding.tableIndex,
            sourceType: binding.sourceType, sourceTableOrdinal: binding.sourceTableOrdinal,
            sourceQuotes: structuredClone(binding.sourceQuotes),
            cellBindings: binding.cellBindings.map(cell => Object.fromEntries(
                ['renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn']
                    .map(key => [key, cell[key]]))) })),
        formulaBindings: (plan.formulaBindings || []).map(binding => ({
            formulaOrdinal: binding.formulaOrdinal, targetKind: binding.targetKind, marker: binding.marker })) };
}
module.exports = { convert };

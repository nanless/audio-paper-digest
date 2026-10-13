'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const deepAnalyzer = require('../scripts/deep-analyzer');

function renderTable(headerCell) {
    return `| Method | ${headerCell} |\n| --- | --- |\n| Proposed | 0.803 |`;
}

test('完整同值TeX副本可合并，但avg和worst的区别必须保留', () => {
    const originalHeaders = [
        '𝚫𝐚𝐯𝐠\\boldsymbol{\\Delta_{\\mathrm{avg}}} ↑\\uparrow',
        '𝚫𝐰𝐨𝐫𝐬𝐭\\boldsymbol{\\Delta_{\\mathrm{worst}}} ↑\\uparrow'
    ];
    for (const originalHeader of originalHeaders) {
        const originalTable = renderTable(originalHeader);
        const normalizedTable = deepAnalyzer.normalizeApiReaderTablePasteArtifacts(originalTable);
        const visible = originalHeader.startsWith('𝚫𝐚𝐯𝐠') ? '𝚫𝐚𝐯𝐠 ↑' : '𝚫𝐰𝐨𝐫𝐬𝐭 ↑';
        assert.equal(normalizedTable, renderTable(visible));
    }
});

test('可见指标与TeX下标不一致时不能删掉原注解', () => {
    const mismatched = String.raw`𝚫𝐚𝐯𝐠\boldsymbol{\Delta_{\mathrm{worst}}}`;
    assert.equal(deepAnalyzer.normalizeApiReaderTablePasteArtifacts(renderTable(mismatched)),
        renderTable(mismatched));
    const unfinished = String.raw`𝚫𝐚𝐯𝐠\boldsymbol{\Delta_{\mathrm{avg}}} ^{2}`;
    assert.equal(deepAnalyzer.normalizeApiReaderTablePasteArtifacts(renderTable(unfinished)),
        renderTable(unfinished));
});

test('真正的裸别名和重复单位仍清理', () => {
    const duplicatedUnitTable = renderTable('Hz \\mathrm{Hz}');
    assert.equal(
        deepAnalyzer.normalizeApiReaderTablePasteArtifacts(duplicatedUnitTable),
        renderTable('Hz')
    );
    const duplicatedPlusMinusTable = renderTable('2 ± \\pm 1');
    assert.equal(
        deepAnalyzer.normalizeApiReaderTablePasteArtifacts(duplicatedPlusMinusTable),
        renderTable('2 ± 1')
    );
});

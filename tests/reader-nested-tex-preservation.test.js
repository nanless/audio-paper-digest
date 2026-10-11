'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const deepAnalyzer = require('../scripts/deep-analyzer');

function renderTable(headerCell) {
    return `| Method | ${headerCell} |\n| --- | --- |\n| Proposed | 0.803 |`;
}

test('原表嵌套TeX的avg和worst不能因可见别名被删除', () => {
    const originalHeaders = [
        '𝚫𝐚𝐯𝐠\\boldsymbol{\\Delta_{\\mathrm{avg}}} ↑\\uparrow',
        '𝚫𝐰𝐨𝐫𝐬𝐭\\boldsymbol{\\Delta_{\\mathrm{worst}}} ↑\\uparrow'
    ];
    for (const originalHeader of originalHeaders) {
        const originalTable = renderTable(originalHeader);
        const normalizedTable = deepAnalyzer.normalizeApiReaderTablePasteArtifacts(originalTable);
        assert.equal(normalizedTable, originalTable);
    }
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

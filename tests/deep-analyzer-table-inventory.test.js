'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
    buildApiReaderArtifactEvidence,
    buildApiReaderValidationFeedback
} = require('../scripts/deep-analyzer.js');

const sha = 'a'.repeat(64);
const completeTable = ordinal => ({
    ordinal,
    caption: `Table ${ordinal}`,
    recoveryStatus: 'complete',
    sourceDomSha256: sha,
    headerRows: [0],
    bodyRows: [1],
    matrix: [['System', 'WER'], ['Baseline', '4.8%']],
    cells: [
        { row: 0, column: 0, text: 'System', header: true, sourceDomSha256: sha },
        { row: 0, column: 1, text: 'WER', header: true, sourceDomSha256: sha },
        { row: 1, column: 0, text: 'Baseline', header: false, sourceDomSha256: sha },
        { row: 1, column: 1, text: '4.8%', header: false, sourceDomSha256: sha }
    ]
});

describe('Reader table inventory feedback', () => {
    it('makes a PDF-text source with no recovered table matrix explicitly unselectable', () => {
        const evidence = buildApiReaderArtifactEvidence({
            sourceKind: 'pdf_text',
            health: { status: 'incomplete', detected: { tables: 5 }, recovered: { tables: 0 } },
            tables: [], formulas: [], figures: []
        });
        assert.match(evidence, /^TABLE_ORDINALS_AVAILABLE: \[\]$/m);
    });

    it('lists only uniquely identified, complete and selection-eligible table ordinals', () => {
        const incomplete = { ...completeTable(2), recoveryStatus: 'incomplete' };
        const dirty = completeTable(3);
        dirty.matrix[0][0] = '';
        dirty.cells[0].text = '';
        const duplicateA = completeTable(4);
        const duplicateB = completeTable(4);
        const evidence = buildApiReaderArtifactEvidence({
            tables: [completeTable(1), incomplete, dirty, duplicateA, duplicateB],
            formulas: [], figures: []
        });
        assert.match(evidence, /^TABLE_ORDINALS_AVAILABLE: \[1\]$/m);
    });

    it('turns an unavailable selection identity failure into empty-inventory guidance', () => {
        assert.match(
            buildApiReaderValidationFeedback(
                new Error('读者文章 tableBindings[0] selection 原表身份或恢复状态非法')
            ),
            /TABLE_ORDINALS_AVAILABLE 明确列出的值/
        );
    });
});

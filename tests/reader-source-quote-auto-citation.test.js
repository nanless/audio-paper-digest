'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const deep = require('../scripts/deep-analyzer');
const paid = require('./fixtures/reader-paid-vst-package-concepts.json');

test('automatic table quote selection cannot turn citation integers into output or process counts', () => {
    const table = '| Quantity | Count |\n| --- | --- |\n| Outputs | 8 |\n| Processes | 2 |';
    const source = 'The orchestration uses another implementation (8).\n'
        + 'A separate tool controls instruments and effects from Python (2).';
    assert.deepEqual(deep.deriveExactTableSourceQuotes(table, source), []);
    assert.deepEqual(deep.deriveExactTableSourceQuotes(table, source.replaceAll('(8)', '[8]').replaceAll('(2)', '[2]')), []);
    for (const metadata of ['Communication uses JSON-RPC 2.0 (3).',
        'The supported protocol version is recorded as version 2.0.',
        'Table\n2 maps the components to their owners.', 'Figure 2 illustrates the workflow.',
        'The checks used package commit 02b281a9 and companion commit 27d03a4e.']) {
        assert.deepEqual(deep.deriveExactTableSourceQuotes(table, metadata), [], metadata);
    }
    const actual = 'The held-out run produced 8 outputs in 2 processes under the fixed protocol.';
    assert.ok(deep.deriveExactTableSourceQuotes(table, source + '\n' + actual).includes(actual));
});

test('explicit exact quotes preserve real parenthetical counts and normal scalar values', () => {
    const sourceText = 'Package tests (31) and companion tests (36) passed under the pinned protocol.';
    const article = '| Check | Count |\n| --- | --- |\n| Package | 31 |\n| Companion | 36 |';
    const result = deep.bindApiReaderSourceEvidence(article, [{ tableIndex: 1,
        sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [sourceText] }], [], {
        sourceText, allowDeterministicQuoteRepair: true,
        structuredArtifacts: deep.bindStructuredArtifactsToText({ tables: [], formulas: [] }, sourceText)
    });
    assert.equal(result.article, article);
    assert.ok(deep.deriveExactTableSourceQuotes('| Value |\n| --- |\n| 8.5 |',
        'The observed metric is 8.5 on the fixed evaluation set.').length);
});

test('real paid VST full normal parser keeps missing 8/2 source evidence blocked with automatic quote repair enabled', () => {
    const before = JSON.stringify(paid);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(paid.draft), {
        arxivId: paid.paperId, availableFigureOrdinals: [1, 2], requireIntegratedTables: true,
        minimumIntegratedTables: 2, requiredVersion: 3, requireSourceBindings: true,
        allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true,
        enforceResourceAvailabilityClaims: true, verifiedResourceIdentity: paid.resourceIdentity,
        structuredArtifacts: paid.structuredArtifacts, sourceText: paid.sourceText
    }), /tableBindings\[2\].*关键数字缺少 exact quote\/cell 证据: 8, 2/);
    assert.equal(JSON.stringify(paid), before);
});

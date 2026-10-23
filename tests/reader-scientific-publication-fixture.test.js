'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const { projectScientificQuoteCoverage } = require('../scripts/lib/reader-scientific-quote-coverage');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

// Actual public table and complete quotations shared with Python publication.
// This test exercises pure coverage only: fixture JSON is not a source
// capability and cannot qualify a whole manuscript or grant publication.
function fixture() {
    const bytes = fs.readFileSync(require.resolve('./fixtures/reader-scientific-quantity-actual-31415.json'));
    assert.equal(sha(bytes), '448b6917a08d1d5a11964d7629f43c1c44380a91d49dedde277d326c24e2a3e6');
    const f = JSON.parse(bytes);
    assert.equal(f.notSourceCapability, true);
    assert.equal(f.sourceSha256, '33de2b570a4398d59839a3c08c34eb612df203d87e0defbf694936bcad9b945c');
    assert.equal(sha(f.table.markdown), 'df9e3224979af90d4b371d20d462cd6a4697c0b4821e78de72afe614375b68b0');
    assert.deepEqual(f.sourceQuotes.map(sha), [
        'b0842327bfcb1316f52e4496c16926cd08f411954c6f95961dd85067952291bf',
        'abb4b759dec18c1d67c7ba20a13fc2574ad60f606b756c1067794abb8f7224d6',
        '0e124c6bdeb5d08573af3a8f5765e40823bcff60c136038b333bd88524373ba8'
    ]);
    return f;
}

test('Python出版同一真实完整表与三quotes的Node纯投影保留普通数字和两个精确科学量', () => {
    const f = fixture(), before = JSON.stringify(f);
    assert.equal(f.table.rows.length, 13);
    assert.equal(f.sourceQuotes.length, 3);
    assert.deepEqual(f.table.rows[4].slice(1), ['3×10⁻⁴', '2×10⁻⁵']);
    const projection = projectScientificQuoteCoverage(f.table, f.sourceQuotes, deep.readerNumericTokens);
    assert.deepEqual(projection.failures, []);
    assert.deepEqual(projection.proofs, [
        { row: 5, column: 1, quoteIndex: 0, lineIndex: 18 },
        { row: 5, column: 2, quoteIndex: 0, lineIndex: 19 }
    ]);
    const ordinary = [f.table.header, ...f.table.rows].flatMap((row, r) => row.flatMap((value, c) =>
        r === 5 && (c === 1 || c === 2) ? [] : deep.readerNumericTokens(value)));
    assert.deepEqual(new Set(projection.tokens), new Set(ordinary));
    for (const token of ['500', '50', '0.1', '2', '4090', '1']) assert.ok(projection.tokens.includes(token), token);
    assert.deepEqual(projection.tokens.filter(token =>
        !deep.readerSourceQuotesCoverNumericToken(token, f.sourceQuotes, [])), []);
    assert.equal(JSON.stringify(f), before, 'complete table, quotations and fixture identity remain byte-for-byte unchanged');
});

test('同实际完整表的机械全角和数学底数负例不能借独立scalar9取得纯覆盖', () => {
    const f = fixture(), before = JSON.stringify(f);
    // Synthetic negative supplement only; not a quotation claimed to occur in
    // the real paper, and never submitted to a source owner or publication gate.
    const quotes = [...f.sourceQuotes, 'A separate scalar observation was 9.'];
    for (const value of ['3×１０⁻⁹', '3×𝟙𝟘⁻⁹']) {
        const table = structuredClone(f.table);
        table.rows[4][1] = value;
        table.markdown = table.markdown.replace('3×10⁻⁴', value);
        assert.ok(deep.readerNumericTokens(table.markdown).every(token =>
            deep.readerSourceQuotesCoverNumericToken(token, quotes, [])), 'legacy scalar coverage alone is insufficient');
        const projection = projectScientificQuoteCoverage(table, quotes, deep.readerNumericTokens);
        assert.ok(projection.failures.some(failure => failure.row === 5 && failure.column === 1), value);
        assert.equal(projection.proofs.some(proof => proof.row === 5 && proof.column === 1), false, value);
    }
    assert.equal(JSON.stringify(f), before);
});

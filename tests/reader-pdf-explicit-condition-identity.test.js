'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../scripts/lib/reader-authenticated-pdf-table-evidence');
const { extractMarkdownTables } = require('../scripts/analysis-contract');

// Verbatim text order from the authenticated dai26c PDF Table 1. This is a
// portable structural regression, not an authenticated-source capability.
const raw = ['Table 1: Main results on LibriSpeech test-clean. RTF is end-to-end (generator + decoder); stage-wise breakdown for our best system:',
    'DiT 0.0016 + VAE 0.0030. MOS is reported as mean±95% CI.',
    'System', 'Dim', 'WER(%) ↓', 'SpkSim ↑', 'UTMOS ↑', 'MOS ↑', 'RTF ↓',
    'CosyVoice2 Token2Wav (10-step) [1]', '–', '3.18', '0.940', '3.76', '4.05±0.03', '0.0775',
    'VAE reconstruction (oracle latent)', '24', '2.14', '0.966', '3.67', '4.10±0.04', '–',
    'Latent MeanFlow + VAE (Joint-FT)', '24', '3.41', '0.932', '3.64', '3.85±0.03', '0.0046',
    'Latent MeanFlow + VAE (Joint-FT)', '16', '3.62', '0.927', '3.56', '3.72±0.03', '0.0046'].join('\n');
const markdown = '| System | Dim | WER(%) ↓ | SpkSim ↑ | UTMOS ↑ | MOS ↑ | RTF ↓ |\n'
    + '|---|---|---|---|---|---|---|\n'
    + '|CosyVoice2 Token2Wav (10-step) [1]|–|3.18|0.940|3.76|4.05±0.03|0.0775|\n'
    + '|VAE reconstruction (oracle latent)|24|2.14|0.966|3.67|4.10±0.04|–|\n'
    + '|Latent MeanFlow + VAE (Joint-FT)|24|3.41|0.932|3.64|3.85±0.03|0.0046|\n'
    + '|Latent MeanFlow + VAE (Joint-FT)|16|3.62|0.927|3.56|3.72±0.03|0.0046|';
const table = input => extractMarkdownTables(input)[0];
const doc = input => ({ contract: 'reader-sealed-pdf-quotes-v1', available: true,
    rawFullText: input, normalizedFullText: input.replace(/\s+/gu, ' ').trim() });
const match = (rendered = markdown, source = raw, quotes = [source]) => api.matchLiteralTable(table(rendered), quotes, doc(source), source);

test('原表显式Dim与完整原方法名共同唯一定位，保留全部列和原条件证明', () => {
    const result = match();
    assert.ok(result);
    assert.deepEqual(result.rows.slice(2).map(row => [row.sourceRow, row.conditionIdentity.columns[0].header,
        row.conditionIdentity.columns[0].value]), [[3, 'Dim', '24'], [4, 'Dim', '16']]);
    assert.deepEqual(result.rows[2].values.map(value => [value.sourceColumn, value.sourceValue, value.unit]), [[2, '3.41', '%']]);
    assert.equal(match(markdown.replace(/\| Dim \|/u, '| D |'), raw.replace('\nDim\n', '\nD\n')), null,
        'bare D can name an output distortion score and is not an explicit input dimension');
});

test('不能凭结果数字消解相同行身份：缺Dim、换Dim、漏其它列、同Dim重复仍拒', () => {
    assert.equal(match(markdown.replace('|24|3.41|', '|16|3.41|')), null, 'swap condition while keeping measured outcomes');
    assert.equal(match(markdown.replace('|16|3.62|', '|24|3.62|')), null);
    assert.equal(match(markdown.replaceAll('|0.932|', '|0.931|')), null, 'all original values remain protected');
    assert.equal(match(markdown.replace('Dim', 'Capacity'), raw.replace('\nDim\n', '\nCapacity\n')), null,
        'an arbitrary measured column is not a recognized input dimension');
    assert.equal(match(markdown.replace('|24|3.41|', '|24|3.41|'), raw.replace('\n16\n3.62\n', '\n24\n3.62\n')), null,
        'same explicit condition remains ambiguous even when WER differs');
    const missingDim = markdown.split('\n').map(line => line.replace(/^(\|[^|]+)\|[^|]+\|/u, '$1|')).join('\n');
    assert.equal(match(missingDim), null);
    const missingResult = markdown.split('\n').map(line => line.replace(/\|[^|]+\|$/u, '|')).join('\n');
    assert.equal(match(missingResult), null, 'conditional path requires the complete original numeric row');
});

test('D为输出distortion的真实歧义不能因结果向量不同而获条件能力', () => {
    const source = ['Table 3: Output distortion D and recognition errors.', 'Method', 'D', 'WER (%)',
        'Same', '0.1', '1.2', 'Same', '0.2', '1.1'].join('\n');
    const rendered = '|Method|D|WER (%)|\n|---|---|---|\n|Same|0.1|1.2|\n|Same|0.2|1.1|';
    assert.equal(api.matchLiteralTable(table(rendered), [source], doc(source), source), null);
});

test('显式条件不能跨表借单位、缩短原方法名、漏引用或给错原列', () => {
    assert.equal(match(markdown.replace('WER(%)', 'WER(ms)')), null);
    assert.equal(match(markdown, raw.replace('WER(%)', 'WER')), null);
    assert.equal(match(markdown.replaceAll(' (Joint-FT)', '')), null);
    assert.equal(match(markdown, raw, ['Latent MeanFlow + VAE (Joint-FT) 24 3.41 0.932 3.64']), null);
    const other = raw.replace('Table 1:', 'Table 2:').replace('WER(%)', 'WER(ms)');
    assert.equal(match(markdown.replace('WER(%)', 'WER(ms)'), raw + '\n' + other, [raw]), null);
    assert.equal(match(markdown, raw + '\n' + raw, [raw]), null);
});

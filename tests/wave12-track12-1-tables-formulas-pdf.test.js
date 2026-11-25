'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const deep = require('../scripts/deep-analyzer.js');
const tables = require('../scripts/lib/reader-tables.js');
const freshSource = require('../scripts/lib/fresh-arxiv-rewrite-source.js');

const ROOT = path.resolve(__dirname, '..');

function makeSyntheticPdfWithTable() {
    const pyScript = `
import sys, fitz
doc = fitz.open()
p = doc.new_page(width=595, height=842)
p.insert_text((72, 90), "Table 1: Audio Codec Quality on LibriSpeech test-clean.", fontsize=10)
p.draw_line((72, 102), (480, 102), width=1.0)
p.insert_text((76, 116), "Model", fontsize=9)
p.insert_text((220, 116), "ViSQOL", fontsize=9)
p.insert_text((320, 116), "STOI", fontsize=9)
p.insert_text((410, 116), "RTF", fontsize=9)
p.draw_line((72, 122), (480, 122), width=0.8)
p.insert_text((76, 138), "EnCodec", fontsize=9)
p.insert_text((220, 138), "3.42", fontsize=9)
p.insert_text((320, 138), "0.84", fontsize=9)
p.insert_text((410, 138), "0.025", fontsize=9)
p.insert_text((76, 154), "Ours", fontsize=9)
p.insert_text((220, 154), "3.85", fontsize=9)
p.insert_text((320, 154), "0.91", fontsize=9)
p.insert_text((410, 154), "0.011", fontsize=9)
p.draw_line((72, 164), (480, 164), width=1.0)
sys.stdout.buffer.write(doc.tobytes())
doc.close()
`;
    return execFileSync('bash', ['scripts/python-runtime.sh', '-c', pyScript], {
        cwd: ROOT,
        maxBuffer: 8 * 1024 * 1024
    });
}

describe('Wave 12 Track 12.1: arxiv-html-dom-v6 multi-row header compaction & cell cleanup', () => {
    it('compacts 4-row Quality Metrics / split / metric / arrow headers into a clean single composite header row (2611.25569 pattern)', () => {
        const html = `<article>
          <figure class="ltx_table" id="S4.T1">
            <figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">TABLE I:</span> Audio codec benchmark.</figcaption>
            <table class="ltx_tabular">
              <tr>
                <td class="ltx_td ltx_rowspan_4" rowspan="4">Model</td>
                <td class="ltx_td ltx_colspan_4" colspan="4">Quality Metrics</td>
                <td class="ltx_td ltx_colspan_2" colspan="2">Complexity</td>
              </tr>
              <tr>
                <td class="ltx_td ltx_colspan_2" colspan="2">test-clean</td>
                <td class="ltx_td ltx_colspan_2" colspan="2">test-other</td>
                <td class="ltx_td ltx_rowspan_3" rowspan="3">Param. (M) ↓</td>
                <td class="ltx_td ltx_rowspan_3" rowspan="3">RTF ↓</td>
              </tr>
              <tr>
                <td class="ltx_td">ViSQOL</td>
                <td class="ltx_td">LSD</td>
                <td class="ltx_td">ViSQOL</td>
                <td class="ltx_td">LSD</td>
              </tr>
              <tr>
                <td class="ltx_td">↑</td>
                <td class="ltx_td">(dB) ↓</td>
                <td class="ltx_td">↑</td>
                <td class="ltx_td">(dB) ↓</td>
              </tr>
              <tr>
                <td class="ltx_td">DAC</td>
                <td class="ltx_td">3.62</td>
                <td class="ltx_td">1.12</td>
                <td class="ltx_td">3.31</td>
                <td class="ltx_td">1.25</td>
                <td class="ltx_td">74.2</td>
                <td class="ltx_td">0.031</td>
              </tr>
              <tr>
                <td class="ltx_td">UMelCodec</td>
                <td class="ltx_td">3.89</td>
                <td class="ltx_td">0.94</td>
                <td class="ltx_td">3.61</td>
                <td class="ltx_td">1.05</td>
                <td class="ltx_td">28.5</td>
                <td class="ltx_td">0.012</td>
              </tr>
            </table>
          </figure>
        </article>`;

        const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.25569v1', '2611.25569v1');
        assert.equal(art.parserVersion, 'arxiv-html-dom-v7');
        const tbl = art.tables[0];
        assert.equal(tbl.recoveryStatus, 'complete');
        assert.deepEqual(tbl.headerRows, [0]);
        assert.deepEqual(tbl.bodyRows, [1, 2]);
        assert.deepEqual(tbl.matrix[0], [
            'Model',
            'Quality Metrics test-clean ViSQOL ↑',
            'Quality Metrics test-clean LSD (dB) ↓',
            'Quality Metrics test-other ViSQOL ↑',
            'Quality Metrics test-other LSD (dB) ↓',
            'Complexity Param. (M) ↓',
            'Complexity RTF ↓'
        ]);
        assert.deepEqual(tbl.matrix[1], ['DAC', '3.62', '1.12', '3.31', '1.25', '74.2', '0.031']);

        // Must pass untouched reader-tables.js completeTable AND selection eligibility & rendering!
        assert.equal(tables.assessReaderCompleteTableEligibility(tbl).eligible, true);
        assert.equal(tables.assessReaderTableSelectionEligibility(tbl).eligible, true);
        const rendered = tables.renderReaderCompleteTable({ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }, art);
        assert.ok(rendered.markdown.includes('| Model | Quality Metrics test-clean ViSQOL ↑ |'));
        assert.equal(rendered.markdown.split('\n').length, 4); // header + sep + 2 real data rows (0 fake header rows!)
    });

    it('compacts 2-row pure unit/arrow subheader without rowspan/colspan (2611.25569 Table II pattern)', () => {
        const html = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">TABLE II:</span> Ablation.</figcaption>
            <table class="ltx_tabular">
              <tr><td>Model</td><td>ViSQOL</td><td>LSD</td><td>MCD</td><td>STOI</td></tr>
              <tr><td></td><td>↑</td><td>(dB) ↓</td><td>(dB) ↓</td><td>↑</td></tr>
              <tr><td>UMelCodec w/o MSMD</td><td>3.75</td><td>1.00</td><td>3.33</td><td>0.86</td></tr>
              <tr><td>UMelCodec Full</td><td>3.89</td><td>0.94</td><td>2.95</td><td>0.90</td></tr>
            </table>
          </figure>
        </article>`;
        const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.25569v1', '2611.25569v1');
        const tbl = art.tables[0];
        assert.deepEqual(tbl.headerRows, [0]);
        assert.deepEqual(tbl.matrix[0], ['Model', 'ViSQOL ↑', 'LSD (dB) ↓', 'MCD (dB) ↓', 'STOI ↑']);
        assert.equal(tbl.matrix.length, 3);
        assert.equal(tables.assessReaderCompleteTableEligibility(tbl).eligible, true);
    });

    it('rejoins hyphen-wrapped model headers, demotes section divider <th> rows, and detaches .ltx_note/sup footnotes & numeric macron residue (2611.26409 pattern)', () => {
        const html = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> Multimodal evaluation.</figcaption>
            <table class="ltx_tabular">
              <tr>
                <td rowspan="2">Benchmark<sup class="ltx_sup">1</sup></td>
                <td>Gemini-3.0-</td>
                <td>Seed2.0-Mini-</td>
                <td>WeMM-Video-35B-A3B</td>
                <td>WeMM-Video-35B-A3B</td>
              </tr>
              <tr>
                <td>Flash</td>
                <td>0428</td>
                <td>(Instruct)</td>
                <td>(Thinking)</td>
              </tr>
              <tr>
                <th colspan="5">General Audio-Visual Understanding</th>
              </tr>
              <tr>
                <td>ODU-Bench<span class="ltx_note"><span class="ltx_note_mark">6</span><span class="ltx_note_outer">Footnote text</span></span></td>
                <td>19.7¯</td>
                <td>83.6%‾</td>
                <td>10<sup>6</sup></td>
                <td>86.4\u0332</td>
              </tr>
              <tr>
                <td>Acoustic Area (m<sup>2</sup>) 1<sup>st</sup></td>
                <td>88.6</td>
                <td>82.1</td>
                <td>84.0</td>
                <td>85.2</td>
              </tr>
            </table>
          </figure>
        </article>`;

        const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.26409v1', '2611.26409v1');
        const tbl = art.tables[0];
        assert.deepEqual(tbl.headerRows, [0]);
        assert.deepEqual(tbl.matrix[0], [
            'Benchmark',
            'Gemini-3.0-Flash',
            'Seed2.0-Mini-0428',
            'WeMM-Video-35B-A3B (Instruct)',
            'WeMM-Video-35B-A3B (Thinking)'
        ]);
        // Section divider row stays in bodyRows
        assert.equal(tbl.matrix[1][0], 'General Audio-Visual Understanding');
        // Footnote .ltx_note stripped -> "ODU-Bench"; numeric \underline residue stripped -> "19.7", "83.6%", "86.4"; 10^6 preserved!
        assert.deepEqual(tbl.matrix[2], ['ODU-Bench', '19.7', '83.6%', '106', '86.4']);
        // SI unit m^2 and ordinal 1st preserved!
        assert.equal(tbl.matrix[3][0], 'Acoustic Area (m2) 1st');
        assert.equal(tables.assessReaderCompleteTableEligibility(tbl).eligible, true);
    });

    it('wraps bare multi-line equations in \\begin{aligned}...\\end{aligned} without double-wrapping existing environments', () => {
        assert.equal(
            deep.wrapMultilineLatexAligned('\\mathcal{L}_1 = x + y \\\\ \\mathcal{L}_2 = z'),
            '\\begin{aligned} \\mathcal{L}_1 = x + y \\\\ \\mathcal{L}_2 = z \\end{aligned}'
        );
        // Existing aligned / cases environments stay untouched
        const alreadyAligned = '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}';
        assert.equal(deep.wrapMultilineLatexAligned(alreadyAligned), alreadyAligned);
        const casesExpr = 'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}';
        assert.equal(deep.wrapMultilineLatexAligned(casesExpr), casesExpr);
        // Single line stays untouched
        assert.equal(deep.wrapMultilineLatexAligned('y = Wx + b'), 'y = Wx + b');

        // End-to-end through parseArxivStructuredArtifactsFromHtml
        const html = `<article>
          <table class="ltx_equationgroup ltx_eqn_align">
            <tr class="ltx_eqn_row">
              <td><math><semantics><mi>a</mi><annotation encoding="application/x-tex">\\mathcal{L}_1</annotation></semantics></math></td>
              <td><math><semantics><mo>=</mo><annotation encoding="application/x-tex">= \\|x - \\hat{x}\\|_1</annotation></semantics></math></td>
            </tr>
            <tr class="ltx_eqn_row">
              <td><math><semantics><mi>b</mi><annotation encoding="application/x-tex">\\mathcal{L}_2</annotation></semantics></math></td>
              <td><math><semantics><mo>=</mo><annotation encoding="application/x-tex">= \\|S(x) - S(\\hat{x})\\|_2</annotation></semantics></math></td>
            </tr>
          </table>
        </article>`;
        const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99100v1', '2611.99100v1');
        assert.equal(art.formulas.length, 1);
        assert.match(art.formulas[0].latex, /^\\begin\{aligned\}[\s\S]*\\\\[\s\S]*\\end\{aligned\}$/);
    });

    it('guards against P0/P1 regressions: integer/unit pure-<td> data rows, highlighted all-<th> Ours row, scientific <sup> markers, unit/arrow false positives, and complex LaTeX equations', () => {
        // 1) Pure-<td> audio dataset table with row-0 colspan + integer/unit data rows (16 kHz, 960 h)
        const datasetHtml = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> Dataset specs.</figcaption>
            <table class="ltx_tabular">
              <tr><td rowspan="2">Dataset</td><td colspan="2">Audio Specs</td></tr>
              <tr><td>Sample Rate</td><td>Duration</td></tr>
              <tr><td>LibriSpeech</td><td>16 kHz</td><td>960 h</td></tr>
              <tr><td>VCTK</td><td>48 kHz</td><td>44 h</td></tr>
              <tr><td>LJSpeech</td><td>22.05 kHz</td><td>24 h</td></tr>
            </table>
          </figure>
        </article>`;
        const dsArt = deep.parseArxivStructuredArtifactsFromHtml(datasetHtml, '2611.99401v1', '2611.99401v1');
        assert.deepEqual(dsArt.tables[0].headerRows, [0]);
        assert.deepEqual(dsArt.tables[0].matrix[0], ['Dataset', 'Audio Specs Sample Rate', 'Audio Specs Duration']);
        assert.deepEqual(dsArt.tables[0].matrix[1], ['LibriSpeech', '16 kHz', '960 h']);
        assert.deepEqual(dsArt.tables[0].matrix[2], ['VCTK', '48 kHz', '44 h']);
        assert.equal(dsArt.tables[0].matrix.length, 4);

        // 2) Highlighted all-<th> Ours row stays in bodyRows and is NOT folded into header row 0
        const oursThHtml = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 2:</span> ASR results.</figcaption>
            <table class="ltx_tabular">
              <tr><th></th><th>WER</th><th>CER</th></tr>
              <tr><th>Ours</th><th>3.1</th><th>1.2</th></tr>
              <tr><td>Baseline</td><td>4.5</td><td>1.9</td></tr>
            </table>
          </figure>
        </article>`;
        const oursArt = deep.parseArxivStructuredArtifactsFromHtml(oursThHtml, '2611.99402v1', '2611.99402v1');
        assert.deepEqual(oursArt.tables[0].headerRows, [0]);
        assert.deepEqual(oursArt.tables[0].bodyRows, [1, 2]);
        assert.deepEqual(oursArt.tables[0].matrix[1], ['Ours', '3.1', '1.2']);

        // 3) Preserve *, †, ‡ significance markers, mid-word/math exponents (Audio^2Net, cos^2(x), O(d_model^2)), and x1̄
        const supHtml = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 3:</span> Markers.</figcaption>
            <table class="ltx_tabular">
              <tr><th>Model</th><th>Score</th><th>Complexity</th><th>Note</th></tr>
              <tr><td>EnCodec<sup>*</sup></td><td>4.8<sup>†</sup></td><td>O(d<sub>model</sub><sup>2</sup>)</td><td>cos<sup>2</sup>(x)</td></tr>
              <tr><td>Audio<sup>2</sup>Net</td><td>85.4<sup>‡</sup></td><td>x1\u0304</td><td>19.7¯</td></tr>
            </table>
          </figure>
        </article>`;
        const supArt = deep.parseArxivStructuredArtifactsFromHtml(supHtml, '2611.99403v1', '2611.99403v1');
        assert.deepEqual(supArt.tables[0].matrix[1], ['EnCodec*', '4.8†', 'O(dmodel2)', 'cos2(x)']);
        assert.deepEqual(supArt.tables[0].matrix[2], ['Audio2Net', '85.4‡', 'x1\u0304', '19.7']);

        // 4) Non-unit rows like | S | ↑ | ↓ | ↑ | or | (ours) | (base) | (none) | are NOT absorbed into headerRows
        const trendHtml = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 4:</span> Trends.</figcaption>
            <table class="ltx_tabular">
              <tr><th>Size</th><th>M1</th><th>M2</th><th>M3</th></tr>
              <tr><td>S</td><td>↑</td><td>↓</td><td>↑</td></tr>
              <tr><td>L</td><td>1.2</td><td>3.4</td><td>5.6</td></tr>
            </table>
          </figure>
        </article>`;
        const trendArt = deep.parseArxivStructuredArtifactsFromHtml(trendHtml, '2611.99404v1', '2611.99404v1');
        assert.deepEqual(trendArt.tables[0].headerRows, [0]);
        assert.deepEqual(trendArt.tables[0].matrix[1], ['S', '↑', '↓', '↑']);

        // 5) wrapMultilineLatexAligned negative safety cases
        const substack = '\\sum_{\\substack{i=1 \\\\ j=2}} x_{ij}';
        assert.equal(deep.wrapMultilineLatexAligned(substack), substack);
        const splitLeftRight = 'y = \\left( a + b \\\\ + c + d \\right)';
        assert.equal(deep.wrapMultilineLatexAligned(splitLeftRight), splitLeftRight);
        const nestedEq = '\\begin{equation} a=b \\end{equation} \\\\ \\begin{equation} c=d \\end{equation}';
        assert.equal(deep.wrapMultilineLatexAligned(nestedEq), nestedEq);
        const trailingStar = 'a = b \\\\*';
        assert.equal(deep.wrapMultilineLatexAligned(trailingStar), trailingStar);
        const withTag = 'a = b \\\\ c = d \\tag{1}';
        assert.equal(deep.wrapMultilineLatexAligned(withTag), withTag);
    });

    it('preserves and compacts audio numeric-parameter sub-headers (Bitrate kbps, SNR dB, RVQ codebooks) in both <thead> and pure-<td> tables', () => {
        // 1) Explicit <thead> Bitrate sub-header (1.5 kbps | 3 kbps | 6 kbps)
        const theadBitrateHtml = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 5:</span> Codec bitrate sweep.</figcaption>
            <table class="ltx_tabular">
              <thead>
                <tr><th rowspan="2">Model</th><th colspan="3">Bitrate</th></tr>
                <tr><th>1.5 kbps</th><th>3 kbps</th><th>6 kbps</th></tr>
              </thead>
              <tbody>
                <tr><td>EnCodec</td><td>3.12</td><td>3.54</td><td>3.89</td></tr>
                <tr><td>Ours</td><td>3.48</td><td>3.81</td><td>4.12</td></tr>
              </tbody>
            </table>
          </figure>
        </article>`;
        const brArt = deep.parseArxivStructuredArtifactsFromHtml(theadBitrateHtml, '2611.99405v1', '2611.99405v1');
        assert.deepEqual(brArt.tables[0].headerRows, [0]);
        assert.deepEqual(brArt.tables[0].bodyRows, [1, 2]);
        assert.deepEqual(brArt.tables[0].matrix[0], ['Model', 'Bitrate 1.5 kbps', 'Bitrate 3 kbps', 'Bitrate 6 kbps']);
        assert.equal(tables.assessReaderTableSelectionEligibility(brArt.tables[0]).eligible, true);
        assert.equal(tables.assessReaderCompleteTableEligibility(brArt.tables[0]).eligible, true);

        // 2) Pure-<td> SNR (-5 dB | 0 dB | 5 dB) and RVQ Codebooks (1 | 2 | 4 | 8) grouped headers
        const pureTdSnrHtml = `<article>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 6:</span> Speech enhancement SNR.</figcaption>
            <table class="ltx_tabular">
              <tr><td rowspan="2">System</td><td colspan="3">Input SNR</td></tr>
              <tr><td>-5 dB</td><td>0 dB</td><td>5 dB</td></tr>
              <tr><td>Baseline</td><td>8.4</td><td>12.1</td><td>16.2</td></tr>
              <tr><td>Ours</td><td>10.2</td><td>14.5</td><td>18.0</td></tr>
            </table>
          </figure>
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 7:</span> RVQ codebooks.</figcaption>
            <table class="ltx_tabular">
              <tr><td>Model</td><td colspan="4">Codebooks</td></tr>
              <tr><td></td><td>1</td><td>2</td><td>4</td><td>8</td></tr>
              <tr><td>DAC</td><td>2.41</td><td>2.95</td><td>3.40</td><td>3.78</td></tr>
              <tr><td>Ours</td><td>2.72</td><td>3.21</td><td>3.66</td><td>3.94</td></tr>
            </table>
          </figure>
        </article>`;
        const snrArt = deep.parseArxivStructuredArtifactsFromHtml(pureTdSnrHtml, '2611.99406v1', '2611.99406v1');
        assert.deepEqual(snrArt.tables[0].headerRows, [0]);
        assert.deepEqual(snrArt.tables[0].matrix[0], ['System', 'Input SNR -5 dB', 'Input SNR 0 dB', 'Input SNR 5 dB']);
        assert.deepEqual(snrArt.tables[0].matrix[1], ['Baseline', '8.4', '12.1', '16.2']);
        assert.deepEqual(snrArt.tables[1].headerRows, [0]);
        assert.deepEqual(snrArt.tables[1].matrix[0], ['Model', 'Codebooks 1', 'Codebooks 2', 'Codebooks 4', 'Codebooks 8']);
        assert.deepEqual(snrArt.tables[1].matrix[1], ['DAC', '2.41', '2.95', '3.40', '3.78']);
        assert.equal(tables.assessReaderCompleteTableEligibility(snrArt.tables[0]).eligible, true);
        assert.equal(tables.assessReaderCompleteTableEligibility(snrArt.tables[1]).eligible, true);
    });
});

describe('Wave 12 Track 12.1: HTML->PDF hybrid table rescue & pdf-layout-dom-v2', () => {
    it('rescues an unrecovered HTML table from sealed source.pdf during fresh source capture', async () => {
        const pdfBytes = makeSyntheticPdfWithTable();
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-hybrid-table-'));
        try {
            // HTML has a Table 1 container with caption but NO parseable <table> DOM (recoveryStatus = 'unrecovered')
            const htmlWithBrokenTable = `<html><body><article>
              <h1>Audio Codec Study</h1>
              <p>${'Audio codec acoustic evaluation on LibriSpeech with ViSQOL and STOI metrics. '.repeat(40)}</p>
              <figure class="ltx_table" id="S4.T1">
                <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> Audio Codec Quality on LibriSpeech test-clean.</figcaption>
                <div class="ltx_ERROR">Unsupported LaTeX tabular macro</div>
              </figure>
            </article></body></html>`;
            const htmlArtifacts = deep.parseArxivStructuredArtifactsFromHtml(htmlWithBrokenTable, '2611.99201v1', '2611.99201v1');
            assert.equal(htmlArtifacts.tables[0].recoveryStatus, 'unrecovered');

            const captured = await freshSource.captureFreshArxivRewriteSource({
                rootDir: dir,
                arxivId: '2611.99201',
                generation: 1
            }, {
                fetchText: async () => ({
                    source: 'html',
                    sourceId: '2611.99201v1',
                    url: 'https://arxiv.org/html/2611.99201v1',
                    title: 'Audio Codec Study',
                    text: 'Audio codec acoustic evaluation on LibriSpeech with ViSQOL and STOI metrics. '.repeat(40),
                    imageInfos: [],
                    structuredArtifacts: htmlArtifacts,
                    fetchedAt: '2026-11-24T06:00:00.000Z'
                }),
                fetchPdf: async () => ({
                    sourceId: '2611.99201',
                    url: 'https://arxiv.org/pdf/2611.99201.pdf',
                    bytes: pdfBytes,
                    fetchedAt: '2026-11-24T06:00:01.000Z'
                })
            });

            const rescued = captured.runtimeDetails.structuredArtifacts.tables[0];
            assert.equal(rescued.recoveryStatus, 'complete');
            assert.deepEqual(rescued.headerRows, [0]);
            assert.equal(rescued.matrix.length, 3);
            assert.deepEqual(rescued.matrix[0], ['Model', 'ViSQOL', 'STOI', 'RTF']);
            assert.deepEqual(rescued.matrix[2], ['Ours', '3.85', '0.91', '0.011']);
            assert.equal(captured.runtimeDetails.structuredArtifacts.health.recovered.tables, 1);
            assert.equal(tables.assessReaderCompleteTableEligibility(rescued).eligible, true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('tags PDF-only structured artifacts with parserVersion pdf-layout-dom-v2', () => {
        const pdfBytes = makeSyntheticPdfWithTable();
        const arts = deep.buildPdfStructuredArtifactsFromBytes('Table 1: Audio Codec Quality.', pdfBytes, '2611.99202v1');
        assert.equal(arts.parserVersion, 'pdf-layout-dom-v2');
        assert.equal(arts.tables.length, 1);
        assert.deepEqual(arts.tables[0].matrix[0], ['Model', 'ViSQOL', 'STOI', 'RTF']);
    });

    it('matches Roman<->Arabic (TABLE II <-> Table 2) and dotted appendix Table A.1 during HTML->PDF hybrid rescue', async () => {
        const pyScript = `
import sys, fitz
doc = fitz.open()
p = doc.new_page(width=595, height=842)
p.insert_text((72, 80), "TABLE II: Codec ablation on LibriSpeech.", fontsize=10)
p.draw_line((72, 92), (460, 92), width=1.0)
p.insert_text((76, 106), "Variant", fontsize=9)
p.insert_text((260, 106), "ViSQOL", fontsize=9)
p.insert_text((370, 106), "RTF", fontsize=9)
p.draw_line((72, 112), (460, 112), width=0.8)
p.insert_text((76, 128), "Full", fontsize=9)
p.insert_text((260, 128), "3.91", fontsize=9)
p.insert_text((370, 128), "0.012", fontsize=9)
p.draw_line((72, 138), (460, 138), width=1.0)

p.insert_text((72, 240), "Table A.1: Appendix speaker robustness.", fontsize=10)
p.draw_line((72, 252), (460, 252), width=1.0)
p.insert_text((76, 266), "Split", fontsize=9)
p.insert_text((260, 266), "WER", fontsize=9)
p.insert_text((370, 266), "CER", fontsize=9)
p.draw_line((72, 272), (460, 272), width=0.8)
p.insert_text((76, 288), "Noisy", fontsize=9)
p.insert_text((260, 288), "4.9%", fontsize=9)
p.insert_text((370, 288), "1.8%", fontsize=9)
p.draw_line((72, 298), (460, 298), width=1.0)
sys.stdout.buffer.write(doc.tobytes())
doc.close()
`;
        const pdfBytes = execFileSync('bash', ['scripts/python-runtime.sh', '-c', pyScript], {
            cwd: ROOT, maxBuffer: 8 * 1024 * 1024
        });
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-hybrid-roman-'));
        try {
            const html = `<html><body><article>
              <h1>Codec Study</h1>
              <p>${'Audio codec ablation and appendix robustness evaluation. '.repeat(40)}</p>
              <figure class="ltx_table" id="S4.T2">
                <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 2:</span> Codec ablation on LibriSpeech.</figcaption>
                <div class="ltx_ERROR">Unsupported macro</div>
              </figure>
              <figure class="ltx_table" id="A1.T1">
                <figcaption class="ltx_caption"><span class="ltx_tag_table">Table A.1:</span> Appendix speaker robustness.</figcaption>
                <div class="ltx_ERROR">Unsupported macro</div>
              </figure>
            </article></body></html>`;
            const htmlArtifacts = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99203v1', '2611.99203v1');
            assert.equal(htmlArtifacts.tables.length, 2);
            assert.ok(htmlArtifacts.tables.every(t => t.recoveryStatus === 'unrecovered'));

            const captured = await freshSource.captureFreshArxivRewriteSource({
                rootDir: dir, arxivId: '2611.99203', generation: 1
            }, {
                fetchText: async () => ({
                    source: 'html',
                    sourceId: '2611.99203v1',
                    url: 'https://arxiv.org/html/2611.99203v1',
                    title: 'Codec Study',
                    text: 'Audio codec ablation and appendix robustness evaluation. '.repeat(40),
                    imageInfos: [],
                    structuredArtifacts: htmlArtifacts,
                    fetchedAt: '2026-11-24T06:00:00.000Z'
                }),
                fetchPdf: async () => ({
                    sourceId: '2611.99203',
                    url: 'https://arxiv.org/pdf/2611.99203.pdf',
                    bytes: pdfBytes,
                    fetchedAt: '2026-11-24T06:00:01.000Z'
                })
            });
            const rescued = captured.runtimeDetails.structuredArtifacts.tables;
            assert.equal(rescued[0].recoveryStatus, 'complete');
            assert.deepEqual(rescued[0].matrix, [['Variant', 'ViSQOL', 'RTF'], ['Full', '3.91', '0.012']]);
            assert.equal(rescued[1].recoveryStatus, 'complete');
            assert.deepEqual(rescued[1].matrix, [['Split', 'WER', 'CER'], ['Noisy', '4.9%', '1.8%']]);
            assert.equal(captured.runtimeDetails.structuredArtifacts.health.status, 'complete');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cheerio = require('cheerio');

const {
    parseArxivStructuredArtifactsFromHtml,
    parseArxivImageInfosFromHtml,
    bindStructuredArtifactsToText,
    extractArxivHtmlText,
    arxivCaptionText,
    stripLatexPhantoms
} = require('../scripts/deep-analyzer.js');
const {
    projectReaderCellTexDisplay,
    normalizeReaderSourceDisplayArtifacts
} = require('../scripts/lib/reader-source-display.js');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('2611.24453 回归：表格单元格与正文中 <mphantom>、.ltx_phantom 与 \\phantom{-} 不再把正数染成负数，且保留真实负号', () => {
    const html = `<!doctype html>
<html><body><main class="ltx_page_content"><article class="ltx_document">
  <section class="ltx_section">
    <h2 class="ltx_title ltx_title_section">1 Introduction</h2>
    <div class="ltx_para"><p>Within one chord symbol yields <math alttext="\\phantom{-}"><mphantom><mo>−</mo></mphantom></math>1.36 [1.27, 1.44], whereas non-chord to chord yields <math alttext="-0.13"><mrow><mo>−</mo><mn>0.13</mn></mrow></math> under the same intervention budget.</p></div>
    <div class="ltx_para"><p>Text-mode phantom alignment <span class="ltx_text ltx_phantom"><span style="visibility:hidden"><math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math></span></span>0.06 [0.00, 0.11] versus bass <math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math>0.24 [<math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math>0.33, <math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math>0.16].</p></div>
  </section>
  <section class="ltx_section">
    <h2 class="ltx_title ltx_title_section">2 Results</h2>
    <figure class="ltx_table" id="A5.T2">
      <figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table 2:</span> Net margin drop with <math alttext="\\phantom{-}1.36"><mrow><mphantom><mo>−</mo></mphantom><mn>1.36</mn></mrow></math> positive peak and <math alttext="-0.13"><mrow><mo>−</mo><mn>0.13</mn></mrow></math> negative drop.</figcaption>
      <table class="ltx_tabular">
        <thead>
          <tr><th>Category</th><th>Form A</th><th>Form B</th><th>Form C (.ltx_phantom)</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Positive row</td>
            <td id="cell-pos-a"><math alttext="\\phantom{-}"><mphantom><mo>−</mo></mphantom></math>1.36 [1.27, 1.44]</td>
            <td id="cell-pos-b"><math alttext="\\phantom{-}1.36"><mrow><mphantom><mo>−</mo></mphantom><mn>1.36</mn></mrow></math></td>
            <td id="cell-pos-c"><span class="ltx_text ltx_phantom"><span style="visibility:hidden"><math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math></span></span>1.36 [1.27, 1.44]</td>
          </tr>
          <tr>
            <td>Positive with TeX annotation</td>
            <td id="cell-pos-ann"><math alttext="\\phantom{-}"><semantics><mphantom><mo>−</mo></mphantom><annotation encoding="application/x-tex">\\phantom{-}</annotation></semantics></math>0.06 [0.00, 0.11]</td>
            <td id="cell-pos-bold"><math alttext="\\mathbf{\\phantom{-}0.06\\pm 0.17}"><semantics><mrow><mphantom><mo>−</mo></mphantom><mn>0.06</mn><mo>±</mo><mn>0.17</mn></mrow><annotation encoding="application/x-tex">\\mathbf{\\phantom{-}0.06\\pm 0.17}</annotation></semantics></math></td>
            <td id="cell-pos-pad"><math alttext="\\hphantom{00}84"><semantics><mrow><mphantom><mn>00</mn></mphantom><mn>84</mn></mrow><annotation encoding="application/x-tex">\\hphantom{00}84</annotation></semantics></math></td>
          </tr>
          <tr>
            <td>True negative row</td>
            <td id="cell-neg-a"><math alttext="-0.13"><mrow><mo>−</mo><mn>0.13</mn></mrow></math></td>
            <td id="cell-neg-b"><math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math>0.13 [<math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math>0.16, <math alttext="-"><semantics><mo>−</mo><annotation encoding="application/x-tex">-</annotation></semantics></math>0.11]</td>
            <td id="cell-neg-c"><math alttext="-0.24"><semantics><mrow><mo>−</mo><mn>0.24</mn></mrow><annotation encoding="application/x-tex">-0.24</annotation></semantics></math></td>
          </tr>
        </tbody>
      </table>
    </figure>
  </section>
</article></main></body></html>`;

    const $raw = cheerio.load(html);
    const expectedPosASha = sha256($raw.html($raw('#cell-pos-a')));
    const expectedPosCSha = sha256($raw.html($raw('#cell-pos-c')));
    const expectedTableSha = sha256(`${$raw.html($raw('[id="A5.T2"]'))}\n`);

    const sourceText = extractArxivHtmlText(html);
    const artifacts = bindStructuredArtifactsToText(
        parseArxivStructuredArtifactsFromHtml(html, '2611.24453v1', '2611.24453'),
        sourceText
    );

    assert.equal(artifacts.health.status, 'complete');
    assert.equal(artifacts.tables.length, 1);
    const table = artifacts.tables[0];

    // 1. 正数单元格不含任何 '-' 或 '−'
    assert.equal(table.matrix[1][1], '1.36 [1.27, 1.44]');
    assert.equal(table.matrix[1][2], '1.36');
    assert.equal(table.matrix[1][3], '1.36 [1.27, 1.44]');
    assert.equal(table.matrix[2][1], '0.06 [0.00, 0.11]');
    assert.doesNotMatch(table.matrix[1][1], /[-−]/);
    assert.doesNotMatch(table.matrix[1][2], /[-−]/);
    assert.doesNotMatch(table.matrix[1][3], /[-−]/);
    assert.doesNotMatch(table.matrix[2][1], /[-−]/);

    // 带样式或数字占位的单元格剔除 phantom 后可被下游显示层正常折叠，且无伪负号
    assert.equal(
        normalizeReaderSourceDisplayArtifacts(projectReaderCellTexDisplay(table.matrix[2][2])),
        '0.06 ± 0.17'
    );
    assert.equal(
        normalizeReaderSourceDisplayArtifacts(projectReaderCellTexDisplay(table.matrix[2][3])),
        '84'
    );

    // 2. 真实负数单元格完整保留负号
    assert.equal(table.matrix[3][1], '−0.13');
    assert.equal(table.matrix[3][2], '−-0.13 [−-0.16, −-0.11]');
    assert.equal(
        normalizeReaderSourceDisplayArtifacts(projectReaderCellTexDisplay(table.matrix[3][2])),
        '−0.13 [−0.16, −0.11]'
    );
    assert.equal(table.matrix[3][3], '−0.24-0.24');

    // 3. 图注与正文同样剔除虚影负号并保留真实负号
    assert.equal(
        table.caption,
        'Table 2: Net margin drop with 1.36 positive peak and -0.13 negative drop.'
    );
    assert.match(sourceText, /Within one chord symbol yields 1\.36 \[1\.27, 1\.44\], whereas non-chord to chord yields −0\.13/);
    assert.match(sourceText, /Text-mode phantom alignment 0\.06 \[0\.00, 0\.11\] versus bass −-0\.24 \[−-0\.33, −-0\.16\]\./);
    assert.doesNotMatch(sourceText, /[−-]1\.36|[−-]0\.06/);

    // 4. sourceDomSha256 依然严格绑定未克隆修改前的原始 DOM outerHTML
    assert.equal(table.sourceDomSha256, expectedTableSha);
    const cellPosA = table.cells.find(cell => cell.row === 1 && cell.column === 1);
    const cellPosC = table.cells.find(cell => cell.row === 1 && cell.column === 3);
    assert.equal(cellPosA.text, '1.36 [1.27, 1.44]');
    assert.equal(cellPosA.sourceDomSha256, expectedPosASha);
    assert.equal(cellPosC.text, '1.36 [1.27, 1.44]');
    assert.equal(cellPosC.sourceDomSha256, expectedPosCSha);
});

test('stripLatexPhantoms 与 arxivCaptionText：支持 \\hphantom、嵌套花括号 \\vphantom、转义花括号，并对未闭合语法安全保底', () => {
    // 正常单层与多层嵌套
    assert.equal(stripLatexPhantoms('\\phantom{-}1.36'), '1.36');
    assert.equal(stripLatexPhantoms('\\hphantom{00}9'), '9');
    assert.equal(stripLatexPhantoms('\\vphantom{\\sum_{i=1}^n}x_i'), 'x_i');
    assert.equal(stripLatexPhantoms('\\vphantom{\\sum_{i=1}^{n_{0}}}y'), 'y');
    assert.equal(stripLatexPhantoms('{31.3\\pm 2.8}^{\\phantom{\\mathrm{ZS}}}'), '{31.3\\pm 2.8}^{}');
    assert.equal(stripLatexPhantoms('0.805\\phantom{{}\\pm 0.000}'), '0.805');
    assert.equal(stripLatexPhantoms('\\phantom{\\{1\\}}2.5'), '2.5');
    assert.equal(stripLatexPhantoms('\\phantom{-}-0.13'), '-0.13');
    // LaTeX 换行符 \\ 后紧跟 \phantom
    assert.equal(stripLatexPhantoms('a\\\\\\phantom{-}1'), 'a\\\\1');

    // 负例与防误伤保底：未闭合花括号、转义右花括号致未闭合、偶数反斜杠、其他宏名、普通英文单词 phantom
    assert.equal(stripLatexPhantoms('\\phantom{1.36'), '\\phantom{1.36');
    assert.equal(stripLatexPhantoms('\\phantom{-'), '\\phantom{-');
    assert.equal(stripLatexPhantoms('\\vphantom{\\sum_{i=1}'), '\\vphantom{\\sum_{i=1}');
    assert.equal(stripLatexPhantoms('\\phantom{\\}1.36'), '\\phantom{\\}1.36');
    assert.equal(stripLatexPhantoms('\\\\phantom{1.36}'), '\\\\phantom{1.36}');
    assert.equal(stripLatexPhantoms('\\phantomize{1.36}'), '\\phantomize{1.36}');
    assert.equal(stripLatexPhantoms('no phantom loss -0.13'), 'no phantom loss -0.13');
    // 前半段未闭合不吞后半段，但后半段独立合法的 \phantom 仍按原位处理
    assert.equal(stripLatexPhantoms('\\phantom{1.36 + x'), '\\phantom{1.36 + x');
    assert.equal(stripLatexPhantoms('\\phantom{1.36 and \\phantom{-}2.0'), '\\phantom{1.36 and 2.0');

    // 图注与图片清单中的嵌套 \vphantom、.ltx_phantom 与未闭合保底
    const figHtml = `<article>
      <figure class="ltx_figure" id="S3.F1">
        <img src="figures/arch.png" alt="Refer to caption">
        <figcaption class="ltx_caption">
          <span class="ltx_tag ltx_tag_figure">Figure 1:</span>
          Aligned <span class="ltx_text ltx_phantom">hidden</span> score
          <math alttext="\\vphantom{\\sum_{i=1}^n}S_n"><mrow><mphantom><mo>∑</mo></mphantom><msub><mi>S</mi><mi>n</mi></msub></mrow></math>,
          padded <math alttext="\\hphantom{00}7"><mrow><mphantom><mn>00</mn></mphantom><mn>7</mn></mrow></math>,
          and malformed <math alttext="\\phantom{1.36"><mtext>\\phantom{1.36</mtext></math>.
        </figcaption>
      </figure>
    </article>`;

    const $ = cheerio.load(figHtml);
    const caption = arxivCaptionText($, $('figcaption').first()).replace(/\s+/g, ' ').trim();
    assert.equal(
        caption,
        'Figure 1: Aligned score S_n, padded 7, and malformed \\phantom{1.36.'
    );

    const imageInfos = parseArxivImageInfosFromHtml(figHtml, '2611.24453v1', '2611.24453');
    assert.equal(imageInfos.length, 1);
    assert.equal(imageInfos[0].caption, caption);

    const artifacts = parseArxivStructuredArtifactsFromHtml(figHtml, '2611.24453v1', '2611.24453');
    assert.equal(artifacts.figures.length, 1);
    assert.equal(artifacts.figures[0].caption, caption);
});

test('展示公式保留原始 latex/mathml（含 cases 对齐 \\phantom），但可见文本、参考文献与空框图不把虚影当可见正文', () => {
    const html = `<article class="ltx_document">
      <table class="ltx_equation ltx_eqn_table"><tbody><tr>
        <td>
          <math display="block" alttext="y=\\begin{cases}\\phantom{-}1\\\\ -1\\end{cases}">
            <semantics>
              <mrow><mi>y</mi><mo>=</mo><mphantom><mo>−</mo></mphantom><mn>1</mn></mrow>
              <annotation encoding="application/x-tex">y=\\begin{cases}\\phantom{-}1\\\\ -1\\end{cases}</annotation>
            </semantics>
          </math>
        </td>
        <td><span class="ltx_tag ltx_tag_equation">(1)</span></td>
      </tr></tbody></table>
      <figure class="ltx_figure">
        <div class="ltx_framed"><span class="ltx_text ltx_phantom">invisible only</span></div>
        <figcaption class="ltx_caption"><span class="ltx_tag_figure">Figure 2:</span> Phantom-only framed box.</figcaption>
      </figure>
      <section class="ltx_bibliography">
        <ul class="ltx_biblist">
          <li class="ltx_bibitem" id="bib.1"><span class="ltx_tag_bibitem">[1]</span> <span class="ltx_phantom">00</span>Author, “No phantom loss,” 2026.</li>
        </ul>
      </section>
    </article>`;

    const artifacts = parseArxivStructuredArtifactsFromHtml(html, '2611.24453v1', '2611.24453');
    assert.equal(artifacts.formulas.length, 1);
    assert.equal(artifacts.formulas[0].latex, 'y=\\begin{cases}\\phantom{-}1\\\\ -1\\end{cases}');
    assert.match(artifacts.formulas[0].mathml, /<mphantom><mo>−<\/mo><\/mphantom>/);
    assert.doesNotMatch(artifacts.formulas[0].text, /\\phantom|−1/);
    assert.match(artifacts.formulas[0].text, /y=1/);

    // 框内只有 .ltx_phantom 不可见占位时，不能误恢复成 inline_html 图资源
    assert.equal(artifacts.figures.length, 1);
    assert.equal(artifacts.figures[0].recoveryStatus, 'unrecovered');

    // 参考文献去掉 .ltx_phantom 占位但保留英文单词 phantom
    assert.equal(artifacts.references.length, 1);
    assert.equal(artifacts.references[0].text, '[1] Author, “No phantom loss,” 2026.');
});

test('命名空间 <m:mphantom> 与拆分布局中的 .ltx_phantom 占位不影响表格关联和恢复', () => {
    const html = `<article>
      <div class="ltx_flex_figure">
        <div class="ltx_flex_cell">
          <figure class="ltx_table">
            <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 3:</span> Voice groups on BCMH.</figcaption>
          </figure>
        </div>
        <span class="ltx_text ltx_phantom">spacer</span>
        <div class="ltx_flex_cell">
          <table class="ltx_tabular">
            <tr><th>Voice group</th><th>Net margin drop</th></tr>
            <tr><td>Soprano</td><td><m:math><m:mphantom><m:mo>−</m:mo></m:mphantom><m:mn>0.06</m:mn></m:math> [0.00, 0.11]</td></tr>
            <tr><td>Bass</td><td><m:math><m:mo>−</m:mo><m:mn>0.24</m:mn></m:math> [−0.33, −0.16]</td></tr>
          </table>
        </div>
      </div>
    </article>`;

    const artifacts = parseArxivStructuredArtifactsFromHtml(html, '2611.24453v1', '2611.24453');
    assert.equal(artifacts.health.status, 'complete');
    assert.equal(artifacts.tables.length, 1);
    assert.deepEqual(artifacts.tables[0].matrix, [
        ['Voice group', 'Net margin drop'],
        ['Soprano', '0.06 [0.00, 0.11]'],
        ['Bass', '−0.24 [−0.33, −0.16]']
    ]);
});


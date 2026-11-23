'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const deep = require('../scripts/deep-analyzer.js');
const tables = require('../scripts/lib/reader-tables.js');
const pdfCrop = require('../scripts/lib/reader-pdf-figure-crop.js');
const tableEvidence = require('../scripts/lib/reader-table-pdf-evidence.js');

test('v5 根除 LaTeXML <annotation> 双写与不可见乘号 \\u2062，公式 TeX 仍完整保留', () => {
    const html = `<article>
      <figure class="ltx_table">
        <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> Main comparison results.</figcaption>
        <table class="ltx_tabular">
          <thead><tr><th>Model</th><th>Score</th><th>Formula</th></tr></thead>
          <tbody>
            <tr>
              <td>Ours</td>
              <td><math alttext="0.40"><semantics><mrow><mn>0.40</mn></mrow><annotation encoding="application/x-tex">0.40</annotation></semantics></math></td>
              <td><math alttext="S_{1}"><semantics><mrow><msub><mi>S</mi><mn>1</mn></msub><mo>&#x2062;</mo><mi>x</mi></mrow><annotation encoding="application/x-tex">S_{1} x</annotation></semantics></math></td>
            </tr>
          </tbody>
        </table>
      </figure>
    </article>`;
    const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99001v1', '2611.99001v1');
    assert.equal(art.parserVersion, 'arxiv-html-dom-v5');
    assert.deepEqual(art.tables[0].matrix, [
        ['Model', 'Score', 'Formula'],
        ['Ours', '0.40', 'S1x']
    ]);
    assert.ok(!art.tables[0].matrix[1][2].includes('\u2062'));
    assert.equal(tables.assessReaderTableSelectionEligibility(art.tables[0]).eligible, true);
});

test('v5 完整拼接多 <math> align / ltx_equationgroup 公式而不截断为首个节点', () => {
    const html = `<article>
      <table class="ltx_equationgroup ltx_eqn_align" id="S2.EGx1">
        <tr class="ltx_eqn_row">
          <td class="ltx_eqn_cell"><math alttext="\\mathcal{L}_{\\text{total}}"><semantics><mrow><mi>L</mi></mrow><annotation encoding="application/x-tex">\\mathcal{L}_{\\text{total}}</annotation></semantics></math></td>
          <td class="ltx_eqn_cell"><math alttext="= \\lambda_1 \\mathcal{L}_{\\text{rec}} + \\lambda_2 \\mathcal{L}_{\\text{kl}}"><semantics><mrow><mo>=</mo></mrow><annotation encoding="application/x-tex">= \\lambda_1 \\mathcal{L}_{\\text{rec}} + \\lambda_2 \\mathcal{L}_{\\text{kl}}</annotation></semantics></math></td>
          <td class="ltx_eqn_cell ltx_eqn_eqno"><span class="ltx_tag ltx_tag_equation">(1)</span></td>
        </tr>
        <tr class="ltx_eqn_row">
          <td class="ltx_eqn_cell"><math alttext="z_t"><semantics><mrow><mi>z</mi></mrow><annotation encoding="application/x-tex">z_t</annotation></semantics></math></td>
          <td class="ltx_eqn_cell"><math alttext="= f_\\theta(x_t)"><semantics><mrow><mo>=</mo></mrow><annotation encoding="application/x-tex">= f_\\theta(x_t)</annotation></semantics></math></td>
        </tr>
      </table>
    </article>`;
    const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99002v1', '2611.99002v1');
    assert.equal(art.formulas.length, 1);
    assert.match(art.formulas[0].latex, /\\mathcal\{L\}_\{\\text\{total\}\} = \\lambda_1 \\mathcal\{L\}_\{\\text\{rec\}\} \+ \\lambda_2 \\mathcal\{L\}_\{\\text\{kl\}\}/);
    assert.match(art.formulas[0].latex, /\\\\ z_t = f_\\theta\(x_t\)/);
});

test('v5 保留含布局 <table> 的插图并取外层 <figure> 图注与编号，防止 subfigure 劫持', () => {
    const html = `<article>
      <figure class="ltx_figure" id="S1.F1">
        <table class="ltx_tabular"><tr>
          <td><figure class="ltx_figure ltx_subfigure"><img src="panel_a.png" alt="a"/><figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_subfigure">(a)</span> Panel A</figcaption></figure></td>
          <td><img src="panel_b.png" alt="b"/></td>
        </tr></table>
        <figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 1:</span> Full system pipeline overview.</figcaption>
      </figure>
    </article>`;
    const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99003v1', '2611.99003v1');
    assert.equal(art.figures.length, 1);
    assert.equal(art.tables.length, 0, '插图内布局表格不应生成假空表');
    assert.equal(art.figures[0].recoveryStatus, 'complete');
    assert.equal(art.figures[0].label, 'Figure 1:');
    assert.match(art.figures[0].caption, /Full system pipeline overview/);
    assert.ok(!art.figures[0].caption.startsWith('(a)'));
});

test('v5 确定性恢复纯 <td> 表头、跳过表内全幅分组 <th>，并安全转义管道符 | 双向往返', () => {
    const html = `<article>
      <figure class="ltx_table">
        <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> Ablation results on Audio | Video.</figcaption>
        <table class="ltx_tabular">
          <tr><td></td><td>Audio | Video</td><td>WER (%)</td></tr>
          <tr><th colspan="3">Zero-shot split</th></tr>
          <tr><td>Baseline</td><td>61.2 | 58.4</td><td>4.8</td></tr>
          <tr><td>Ours</td><td>72.4 | 70.1</td><td>3.2</td></tr>
        </table>
      </figure>
    </article>`;
    const art = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99004v1', '2611.99004v1');
    const tbl = art.tables[0];
    assert.deepEqual(tbl.headerRows, [0]);
    const elig = tables.assessReaderTableSelectionEligibility(tbl);
    assert.equal(elig.eligible, true, JSON.stringify(elig));
    const rendered = tables.renderReaderTableSelection({
        tableIndex: 1,
        selection: { sourceTableOrdinal: 1, sourceRows: [0, 2, 3], sourceColumns: [0, 1, 2] }
    }, art);
    assert.match(rendered.markdown, /Audio \\\| Video/);
    assert.match(rendered.markdown, /61\.2 \\\| 58\.4/);
    // Round-trip verification through displayCellMatches with escaped pipe
    assert.equal(tableEvidence.displayCellMatches(tbl, 0, 1, 'Audio \\| Video'), true);
    assert.equal(tableEvidence.displayCellMatches(tbl, 2, 1, '61.2 \\| 58.4'), true);
    // Expanded result table requirement detects ablation caption
    const req = tables.readerResultTableRequirement(art);
    assert.deepEqual(req.sourceTableOrdinals, [1]);
});

test('pdf_crop 描述符校验、零持久图片字节与 Figure 优先级排序上限 16', () => {
    const pdfSha = crypto.createHash('sha256').update('dummy-pdf').digest('hex');
    const figures = Array.from({ length: 20 }, (_, i) => {
        const ordinal = i + 1;
        const cropMeta = {
            bbox: ['50.00', '50.00', '400.00', '300.00'],
            cropContract: pdfCrop.PDF_FIGURE_CROP_CONTRACT,
            dpi: 288,
            page: ordinal,
            pdfSha256: pdfSha
        };
        const cropSha = crypto.createHash('sha256').update(JSON.stringify(cropMeta)).digest('hex');
        const url = `https://arxiv.org/pdf/2611.25489.pdf#pd-pdf-figure-${ordinal}-${cropSha.slice(0, 16)}`;
        const isAppendix = ordinal <= 10 && ordinal > 1;
        return {
            ordinal,
            label: isAppendix ? `Figure A${ordinal}` : `Figure ${ordinal}`,
            caption: ordinal === 18
                ? 'System architecture overview and complete pipeline diagram.'
                : isAppendix
                    ? `Appendix supplementary detail ${ordinal}.`
                    : `Main comparison results on benchmark ${ordinal}.`,
            images: [{
                kind: 'pdf_crop',
                url,
                alt: 'alt',
                mediaType: 'image/png',
                rasterDownloadEligible: false,
                cropContract: pdfCrop.PDF_FIGURE_CROP_CONTRACT,
                pdfSha256: pdfSha,
                page: ordinal,
                bbox: [50, 50, 400, 300],
                dpi: 288,
                cropSha256: cropSha
            }],
            sourceDomSha256: crypto.createHash('sha256').update(`fig-${ordinal}`).digest('hex'),
            recoveryStatus: 'complete'
        };
    });
    const inventory = deep.getApiReaderFigureInventory({ figures }, '2611.25489');
    assert.equal(inventory.length, 16);
    assert.ok(inventory.some(f => f.ordinal === 18), '高优先级架构图 18 应入选前 16');
    assert.ok(inventory.every(f => f.pdfCropContract === pdfCrop.PDF_FIGURE_CROP_CONTRACT));
    // Verify ascending ordinal order preserved among chosen 16
    for (let i = 1; i < inventory.length; i++) {
        assert.ok(inventory[i].ordinal > inventory[i - 1].ordinal);
    }
    // Tampered cropSha256 and URL query/port/userinfo are rejected
    const tampered = structuredClone(figures[0].images[0]);
    tampered.page = 99;
    assert.equal(pdfCrop.pdfCropSourceDescriptor(tampered, '2611.25489'), null);
    const badQuery = structuredClone(figures[0].images[0]);
    badQuery.url = badQuery.url.replace('#', '?x=1#');
    assert.equal(pdfCrop.pdfCropSourceDescriptor(badQuery, '2611.25489'), null);
    // Unbounded limit option preserves cold-replay lookup of lower-priority figures on >16 figure papers
    const fullInventory = deep.getApiReaderFigureInventory({ figures }, '2611.25489', { limit: Infinity });
    assert.equal(fullInventory.length, 20);
});

test('C1/C2/H3 真实跨语言闭环：Python 整数坐标 PDF 裁图 → JS descriptor → 封存四文件 → ephemeralReaderFigures 真实渲染，且部分恢复保留未恢复告警', async t => {
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const Config = require('../scripts/config.js');
    const freshArxiv = require('../scripts/lib/fresh-arxiv-rewrite-source.js');
    const dailyPlan = require('../scripts/lib/daily-fresh-source-plan.js');

    // Generate a real synthetic PDF via PyMuPDF with whole-number bbox edges (tests C2 float 18.0 vs JS 18!)
    const pyScript = `
import fitz, sys
doc = fitz.open()
page = doc.new_page(width=595, height=842)
page.insert_textbox(fitz.Rect(72, 60, 520, 120), "This paper studies audio representation learning in detail across multiple benchmarks and ablation settings for reproducible speech evaluation.", fontsize=10)
s = page.new_shape()
s.draw_rect(fitz.Rect(24, 150, 420, 260))
s.finish(color=(0, 0, 0), width=1.2)
s.commit()
page.insert_text(fitz.Point(180, 205), "Encoder -> Decoder", fontsize=11)
page.insert_text(fitz.Point(220, 282), "Figure 1: Whole-number margin test.", fontsize=10)
sys.stdout.buffer.write(doc.tobytes())
doc.close()
`;
    const pdfBytes = execFileSync('bash', [
        path.join(__dirname, '../scripts/python-runtime.sh'), '-c', pyScript
    ], { cwd: path.join(__dirname, '..'), maxBuffer: 8 * 1024 * 1024 });

    // Cross-language C2 check: Python extractor -> JS pdfCropSourceDescriptor must succeed even on integer coordinates
    const extracted = pdfCrop.extractPdfStructuredArtifactsSync(pdfBytes, '2611.99123');
    assert.equal(extracted.figures.length, 1);
    const desc = pdfCrop.pdfCropSourceDescriptor(extracted.figures[0].images[0], '2611.99123');
    assert.ok(desc, 'Python 整数坐标 bbox 必须通过 JS pdfCropSourceDescriptor 签名核验');

    // H3 partial recovery + C1 ephemeralReaderFigures against a real sealed four-file bundle + run.json
    const tmpBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-wave10-c1h3-'));
    const prevRunsDir = Config.FILES.dailyFreshSourceRunsDir;
    const runsRoot = path.join(tmpBase, 'daily-runs');
    fs.mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
    Config.FILES.dailyFreshSourceRunsDir = runsRoot;
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = prevRunsDir;
        fs.rmSync(tmpBase, { recursive: true, force: true });
    });

    const html = `<article>
      <h1>Test Paper</h1>
      <p>${'Detailed method and evaluation paragraph. '.repeat(80)}</p>
      <figure class="ltx_figure"><figcaption class="ltx_caption"><span class="ltx_tag_figure">Figure 1:</span> Missing raster recovered from PDF.</figcaption></figure>
      <figure class="ltx_figure"><figcaption class="ltx_caption"><span class="ltx_tag_figure">Figure 9:</span> Still unrecovered figure.</figcaption></figure>
    </article>`;
    const htmlArt = deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99123v1', '2611.99123v1');
    const bodyText = 'Test Paper\n' + 'Detailed method and evaluation paragraph. '.repeat(80);
    const boundArt = deep.bindStructuredArtifactsToText(htmlArt, bodyText);
    const plan = dailyPlan.createDailyFreshSourcePlan({
        batchDate: '2026-11-23',
        batchId: 'test-wave10-c1h3',
        papers: [{ arxivId: '2611.99123' }]
    });
    await dailyPlan.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: opts => freshArxiv.captureFreshArxivRewriteSource(opts, {
            fetchText: async () => ({
                source: 'html', sourceId: '2611.99123v1', url: 'https://arxiv.org/html/2611.99123v1',
                fetchedAt: '2026-11-23T08:00:00.000Z', title: 'Test Paper', text: bodyText,
                imageInfos: [], structuredArtifacts: boundArt, readerAuthors: null,
                htmlAvailability: 'available', htmlAttempts: 1, warnings: []
            }),
            fetchPdf: async () => ({
                sourceId: '2611.99123', url: 'https://arxiv.org/pdf/2611.99123.pdf',
                fetchedAt: '2026-11-23T08:00:00.000Z', bytes: pdfBytes
            })
        })
    });
    const details = dailyPlan.readDailyFreshSource(plan, { arxivId: '2611.99123' });
    const savedArt = details.structuredArtifacts;
    assert.equal(savedArt.figures[0].recoveryStatus, 'complete', 'Figure 1 应由封存 PDF 裁图恢复');
    assert.equal(savedArt.figures[1].recoveryStatus, 'unrecovered', 'Figure 9 在 PDF 中不存在应保持 unrecovered');
    assert.equal(savedArt.health.status, 'incomplete', '部分恢复后仍有未恢复图时 health.status 不得错标 complete');
    assert.ok(savedArt.health.issues.some(m => m.includes('figure[2]')), '未恢复的 figure[2] 告警必须保留');
    assert.ok(!savedArt.health.issues.some(m => m.includes('figure[1]')), '已恢复的 figure[1] 告警应精准清除');

    // Exercise C1: ephemeralReaderFigures reading real sealed four-file bundle via readFreshArxivRewriteSource
    const inv = deep.getApiReaderFigureInventory(savedArt, '2611.99123');
    assert.equal(inv.length, 1);
    const materialized = await dailyPlan.ephemeralReaderFigures('2611.99123', inv, plan);
    assert.equal(materialized.length, 1);
    assert.ok(Buffer.isBuffer(materialized[0].rawBytes));
    assert.ok(materialized[0].rawBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    assert.equal(materialized[0].pdfCropContract, pdfCrop.PDF_FIGURE_CROP_CONTRACT);
});

test('C3 管道符 | 转义表格全链路通过 compile → bind → repairApiReaderArticleAndPlanBindings 与 analysis-engine 校验', () => {
    const analysisEngine = require('../scripts/analysis-engine.js');
    const html = `<article>
      <figure class="ltx_table">
        <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> Main results on Audio | Video.</figcaption>
        <table class="ltx_tabular">
          <tr><td></td><td>Audio | Video</td><td>WER (%)</td></tr>
          <tr><td>Baseline</td><td>61.2 | 58.4</td><td>4.8</td></tr>
          <tr><td>Ours</td><td>72.4 | 70.1</td><td>3.2</td></tr>
        </table>
      </figure>
    </article>`;
    const sourceText = 'Main results on Audio | Video Baseline 61.2 | 58.4 4.8 Ours 72.4 | 70.1 3.2';
    const art = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99005v1', '2611.99005v1'),
        sourceText
    );
    const compiled = tables.compileReaderTableSelections(
        [{ kind: 'result', heading: '实验结果', body: '下表对比音视频指标：\n\n[[TABLE_1]]\n\n可见 Ours 明显领先。' }],
        [{ tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1, 2], sourceColumns: [0, 1, 2] } }],
        art
    );
    const bound = deep.bindApiReaderSourceEvidence(
        compiled.sections[0].body,
        compiled.tableBindings,
        [],
        { structuredArtifacts: art, sourceText, allowDeterministicQuoteRepair: true, selectionTableIndexes: compiled.selectionTableIndexes }
    );
    assert.equal(bound.tableBindings.length, 1);
    const b = bound.tableBindings[0];
    // Verify analysis-engine cell comparison logic accepts escaped pipe renderedText vs raw pipe sourceText
    const pipeCell = b.cellBindings.find(c => c.sourceText === '61.2 | 58.4');
    assert.ok(pipeCell);
    assert.equal(pipeCell.renderedText, '61.2 \\| 58.4');
    const unescaped = tables.unescapeMarkdownTableCell(pipeCell.renderedText);
    assert.equal(deep.normalizeReaderSourceCell(unescaped), deep.normalizeReaderSourceCell(pipeCell.sourceText));
    // Verify real end-to-end repairApiReaderArticleAndPlanBindings + analysisEngine.hasValidIntegratedApiReaderRecords
    const { fixture: createSignedReaderSample } = require('./reader-signed-draft-fixture.js');
    const sample = createSignedReaderSample({ noFigures: true });
    const tableMarkdown = compiled.sections[0].body.split('\n\n')[1];
    const existingTables = require('../scripts/analysis-contract.js').extractMarkdownTables(sample.paper.apiReaderArticle);
    assert.ok(existingTables.length >= 1, '已签名样本应包含至少一张表格');
    sample.paper.apiReaderArticle = sample.paper.apiReaderArticle.replace(existingTables[0].markdown, tableMarkdown);
    sample.paper.apiReaderPlan.tableBindings[0] = bound.tableBindings[0];
    sample.paper.apiReaderPlan.sourceBindingsSha256 = deep.stableFingerprint({
        tableBindings: sample.paper.apiReaderPlan.tableBindings,
        formulaBindings: sample.paper.apiReaderPlan.formulaBindings
    });
    const repaired = deep.repairApiReaderArticleAndPlanBindings(sample.paper, sample.paper.analysisManifest);
    assert.equal(repaired, true, 'repairApiReaderArticleAndPlanBindings 必须接受含转义管道符的绑定表并刷新签名');
    assert.equal(
        analysisEngine.hasValidIntegratedApiReaderRecords(sample.paper),
        true,
        'analysis-engine 整篇资格检查必须放行含 \\| 转义管道符的已绑定表格'
    );
    // Also verify Python split_markdown_table_row + _reader_cell_comparison parity via real python subprocess
    const { execFileSync } = require('node:child_process');
    const pyCheck = execFileSync('bash', [
        path.join(__dirname, '../scripts/python-runtime.sh'), '-c',
        "import importlib.util, sys; sys.path.insert(0,'scripts'); import publish_common as pc; cells = pc.split_markdown_table_row('| Baseline | 61.2 \\\\| 58.4 | 4.8 |'); assert cells == ['Baseline', '61.2 \\\\| 58.4', '4.8'], cells; s=importlib.util.spec_from_file_location('p','scripts/publish-to-blog.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert m._reader_cell_comparison(cells[1]) == m._reader_cell_comparison('61.2 | 58.4'); print('PY_OK')"
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.match(pyCheck, /PY_OK/);
});

test('历史 arxiv-html-dom-v4 表格空表头推理与冷重放兼容保持不变', () => {
    const v4Table = {
        ordinal: 1,
        label: 'Table 1:',
        caption: 'Table 1: Main evaluation results.',
        sourceDomSha256: crypto.createHash('sha256').update('v4-tbl').digest('hex'),
        headerRows: [],
        bodyRows: [0, 1, 2],
        cells: [
            { row: 0, column: 0, header: false, rowspan: 1, colspan: 1, text: 'Model', sourceDomSha256: crypto.createHash('sha256').update('00').digest('hex') },
            { row: 0, column: 1, header: false, rowspan: 1, colspan: 1, text: 'WER', sourceDomSha256: crypto.createHash('sha256').update('01').digest('hex') },
            { row: 1, column: 0, header: false, rowspan: 1, colspan: 1, text: 'Base', sourceDomSha256: crypto.createHash('sha256').update('10').digest('hex') },
            { row: 1, column: 1, header: false, rowspan: 1, colspan: 1, text: '5.2', sourceDomSha256: crypto.createHash('sha256').update('11').digest('hex') },
            { row: 2, column: 0, header: false, rowspan: 1, colspan: 1, text: 'Ours', sourceDomSha256: crypto.createHash('sha256').update('20').digest('hex') },
            { row: 2, column: 1, header: false, rowspan: 1, colspan: 1, text: '3.9', sourceDomSha256: crypto.createHash('sha256').update('21').digest('hex') }
        ],
        matrix: [['Model', 'WER'], ['Base', '5.2'], ['Ours', '3.9']],
        recoveryStatus: 'complete'
    };
    const eff = tables.effectiveReaderTableRows(v4Table);
    assert.equal(eff.inferred, true);
    assert.deepEqual(eff.headerRows, [0]);
    assert.deepEqual(eff.bodyRows, [1, 2]);
    assert.equal(tables.assessReaderTableSelectionEligibility(v4Table).eligible, true);
});

test('M1/M2: HTML→PDF 回退禁止跨图误绑（锚定图注开头并预占已完整图号）且 refresh 保留 >16 图论文的已绑定图', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { execFileSync } = require('node:child_process');
    const freshArxiv = require('../scripts/lib/fresh-arxiv-rewrite-source.js');

    // Build real 1-figure PDF containing Figure 1
    const pdfB64 = execFileSync('bash', [
        path.join(__dirname, '../scripts/python-runtime.sh'), '-c',
        "import base64, fitz; d=fitz.open(); p=d.new_page(width=595,height=842); p.draw_rect(fitz.Rect(72,90,520,260),color=(0.1,0.2,0.5),fill=(0.9,0.95,1.0),width=2); p.insert_text((80,282),'Figure 1: Pipeline diagram.',fontsize=10); b=d.tobytes(); d.close(); print(base64.b64encode(b).decode())"
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    const pdfBytes = Buffer.from(pdfB64, 'base64');

    const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-wave10-m1-'));
    t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    // Figure 1 is ALREADY complete in HTML; Figure 2 is unrecovered with empty label and cross-referencing caption mentioning "Figure 1".
    const html = `<article>
      <h1>Cross-ref Test</h1>
      <p>${'Detailed acoustic model evaluation text. '.repeat(80)}</p>
      <figure class="ltx_figure"><img src="fig1.png"/><figcaption class="ltx_caption"><span class="ltx_tag_figure">Figure 1:</span> Complete HTML pipeline.</figcaption></figure>
      <figure class="ltx_figure"><figcaption class="ltx_caption">Qualitative spectrograms for the pipeline in Figure 1.</figcaption></figure>
    </article>`;
    const bodyText = 'Cross-ref Test\n' + 'Detailed acoustic model evaluation text. '.repeat(80);
    const htmlArt = deep.bindStructuredArtifactsToText(
        deep.parseArxivStructuredArtifactsFromHtml(html, '2611.99222v1', '2611.99222v1'),
        bodyText
    );
    await freshArxiv.captureFreshArxivRewriteSource({
        rootDir: tmpRoot, arxivId: '2611.99222', generation: 1
    }, {
        fetchText: async () => ({
            source: 'html', sourceId: '2611.99222v1', url: 'https://arxiv.org/html/2611.99222v1',
            fetchedAt: '2026-11-23T09:00:00.000Z', title: 'Cross-ref Test', text: bodyText,
            imageInfos: [], structuredArtifacts: htmlArt, readerAuthors: null,
            htmlAvailability: 'available', htmlAttempts: 1, warnings: []
        }),
        fetchPdf: async () => ({
            sourceId: '2611.99222', url: 'https://arxiv.org/pdf/2611.99222.pdf',
            fetchedAt: '2026-11-23T09:00:00.000Z', bytes: pdfBytes
        })
    });
    const stored = freshArxiv.readFreshArxivRewriteSource({ rootDir: tmpRoot, arxivId: '2611.99222', generation: 1 });
    const figs = stored.runtimeDetails.structuredArtifacts.figures;
    assert.equal(figs[0].recoveryStatus, 'complete');
    assert.equal(figs[1].recoveryStatus, 'unrecovered', '交叉引用 Figure 1 的未恢复图绝不能盗绑 PDF 的 Figure 1');
    assert.equal(figs[1].images.length, 0);

    // M2: getApiReaderFigureInventory with { limit: Infinity } retains all 20 figures while default caps at 16
    const manyFigs = Array.from({ length: 20 }, (_, i) => ({
        ordinal: i + 1,
        label: `Figure ${i + 1}:`,
        caption: `Figure ${i + 1}: Case study ${i + 1}.`,
        sourceDomSha256: crypto.createHash('sha256').update(`m2-fig-${i + 1}`).digest('hex'),
        images: [{
            kind: 'external_url',
            url: `https://arxiv.org/html/2611.99222v1/fig${i + 1}.png`,
            sourceLocationUrl: `https://arxiv.org/html/2611.99222v1/fig${i + 1}.png`
        }],
        recoveryStatus: 'complete'
    }));
    assert.equal(deep.getApiReaderFigureInventory({ figures: manyFigs }, '2611.99222').length, 16);
    assert.equal(deep.getApiReaderFigureInventory({ figures: manyFigs }, '2611.99222', { limit: Infinity }).length, 20);
});

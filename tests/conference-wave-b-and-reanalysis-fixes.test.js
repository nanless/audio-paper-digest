'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const readerTables = require('../scripts/lib/reader-tables.js');
const postprocess = require('../scripts/lib/conference-postprocess.js');
const pdfEvidence = require('../scripts/lib/reader-table-pdf-evidence.js');
const editorial = require('../scripts/editorial-quality.js');
const processApi = require('../scripts/lib/conference-process.js');
const migrateCli = require('../scripts/migrate-conference-process.js');
const reviewReanalysis = require('../scripts/lib/conference-review-reanalysis.js');

const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');

test('shifted PDF table row with trailing decimal merged into col 0 and empty last col fails eligibility', () => {
    const sha = 'a'.repeat(64);
    const makeTable = matrix => ({
        ordinal: 1,
        recoveryStatus: 'complete',
        sourceDomSha256: sha,
        headerRows: [0],
        bodyRows: matrix.slice(1).map((_r, i) => i + 1),
        matrix,
        cells: matrix.flatMap((row, r) => row.map((text, c) => ({
            row: r, column: c, header: r === 0, rowspan: 1, colspan: 1, text, sourceDomSha256: sha
        })))
    });

    const shifted = makeTable([
        ['System', 'Dev ↑', 'Eval ↑'],
        ['Qwen2.5-Omni-7B (baseline) [11] 83.16', '56.42', ''],
        ['Qwen3-Omni-30B-A3B (zero-shot) [3]', '92.40', '77.36'],
        ['Ours (SEAR)', '96.02', '90.92']
    ]);
    const sel = readerTables.assessReaderTableSelectionEligibility(shifted);
    const comp = readerTables.assessReaderCompleteTableEligibility(shifted);
    assert.equal(sel.eligible, false);
    assert.ok(sel.reasonCodes.includes('source_display_cleanup_required'));
    assert.equal(comp.eligible, false);
    assert.ok(comp.reasonCodes.includes('source_display_cleanup_required'));

    // Negative control: normal 3-col table with clean rows must stay eligible.
    const clean = makeTable([
        ['System', 'Dev ↑', 'Eval ↑'],
        ['Qwen2.5-Omni-7B (baseline) [11]', '83.16', '56.42'],
        ['Qwen3-Omni-30B-A3B (zero-shot) [3]', '92.40', '77.36'],
        ['Ours (SEAR)', '96.02', '90.92']
    ]);
    assert.equal(readerTables.assessReaderTableSelectionEligibility(clean).eligible, true);
    assert.equal(readerTables.assessReaderCompleteTableEligibility(clean).eligible, true);

    // Negative control: legitimately sparse cell where col 0 has NO trailing decimal must stay eligible.
    const sparse = makeTable([
        ['System', 'Dev ↑', 'Eval ↑'],
        ['Qwen2.5-Omni-7B (baseline) [11]', '83.16', ''],
        ['Qwen3-Omni-30B-A3B (zero-shot) [3]', '92.40', '77.36'],
        ['Ours (SEAR)', '96.02', '90.92']
    ]);
    assert.equal(readerTables.assessReaderTableSelectionEligibility(sparse).eligible, true);
    assert.equal(readerTables.assessReaderCompleteTableEligibility(sparse).eligible, true);
});

test('conference-postprocess repairDollarMath converts inline $$...$$ before $...$ without leaving stray $', () => {
    const input = '向量 $x$ 与 $c$ 经 FiLM 层按 $$FiLM(x, c) = \\gamma(c) \\odot x + \\beta(c)$$ 调制。';
    const out = postprocess.repairAggregateMathForTest
        ? postprocess.repairAggregateMathForTest(input)
        : null;
    // Also verify directly through exported function if present or regex behavior via postprocess module source
    const src = fs.readFileSync(path.resolve(__dirname, '../scripts/lib/conference-postprocess.js'), 'utf8');
    const fnMatch = src.match(/function repairDollarMath\(markdown\)\s*\{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'repairDollarMath must exist');
    const repairDollarMath = new Function('markdown', fnMatch[0].replace(/^function repairDollarMath\(markdown\)\s*\{/, '').replace(/\}$/, ''));
    const fixed = repairDollarMath(input);
    assert.equal(fixed, '向量 \\(x\\) 与 \\(c\\) 经 FiLM 层按 \\[FiLM(x, c) = \\gamma(c) \\odot x + \\beta(c)\\] 调制。');
    assert.equal(fixed.includes('$'), false);
    if (out !== null) assert.equal(out, fixed);
});

test('assertSavedScientificDomBindings allows verbatim conference PDF x10 cells while keeping daily guard strict', () => {
    const tableMd = '| Layer | p-value |\n| --- | --- |\n| L1 | 1 × 10−13 |\n';
    const basePaper = {
        source: 'conference',
        analysisSource: 'conference_pdf_text',
        conferencePaperId: 'conference:aacl:2026:conference-paper-id:2026.aacl-long.172',
        apiReaderArticle: tableMd,
        apiReaderPlan: {
            tableBindings: [{
                tableIndex: 1,
                sourceType: 'artifact_table',
                sourceTableOrdinal: 5,
                cellBindings: [
                    { renderedRow: 0, renderedColumn: 0, sourceRow: 0, sourceColumn: 0, sourceText: 'Layer', renderedText: 'Layer' },
                    { renderedRow: 0, renderedColumn: 1, sourceRow: 0, sourceColumn: 1, sourceText: 'p-value', renderedText: 'p-value' },
                    { renderedRow: 1, renderedColumn: 0, sourceRow: 1, sourceColumn: 0, sourceText: 'L1', renderedText: 'L1' },
                    { renderedRow: 1, renderedColumn: 1, sourceRow: 1, sourceColumn: 1, sourceText: '1 × 10−13', renderedText: '1 × 10−13' }
                ]
            }]
        }
    };
    assert.doesNotThrow(() => pdfEvidence.withSavedPaper(basePaper, () => {}));

    // Negative control: daily arXiv paper without freshRewriteProvenance MUST still fail.
    const dailyPaper = { ...basePaper, source: 'arxiv', arxivId: '2611.00001v1', analysisSource: 'arxiv_html' };
    delete dailyPaper.conferencePaperId;
    assert.throws(() => pdfEvidence.withSavedPaper(dailyPaper, () => {}), /Scientific DOM display lacks the actual sealed source/);

    // Negative control: conference paper whose renderedText deviates from sourceText MUST still fail.
    const modifiedCell = structuredClone(basePaper);
    modifiedCell.apiReaderPlan.tableBindings[0].cellBindings[3].renderedText = '1×10⁻¹³';
    assert.throws(() => pdfEvidence.withSavedPaper(modifiedCell, () => {}), /Scientific DOM display lacks the actual sealed source/);
});

test('editorial comparison_unit_missing accepts shared trailing unit on ± lists and rejects unitless ± lists', () => {
    const valid = '语义冲突测试在推理时替换自然音频或视频，保持词输入不变，IEMOCAP 在错误音频、错误视频与联合冲突下准确率分别下降 16.9 ± 2.2、10.8 ± 1.4 与 30.5 ± 1.6 个百分点，而另两数据受影响较小，与门控依赖一致。';
    assert.deepEqual(editorial.findMissingComparisonUnits(valid, { editorialProfile: 'structured-pipeline' }), []);

    const validSingle = '在噪声测试集上准确率提升 4.2 ± 0.5 个百分点。';
    assert.deepEqual(editorial.findMissingComparisonUnits(validSingle, { editorialProfile: 'structured-pipeline' }), []);

    // Negative controls: missing unit MUST still be flagged.
    const missingListUnit = 'IEMOCAP 在错误音频、错误视频与联合冲突下准确率分别下降 16.9 ± 2.2、10.8 ± 1.4 与 30.5 ± 1.6，另两数据受影响较小（见 100% 干净语音对照）。';
    assert.ok(editorial.findMissingComparisonUnits(missingListUnit, { editorialProfile: 'structured-pipeline' }).length > 0);
});

test('migrate-conference-process CLI and reviewReanalysisAdoption state integrity enforce strict invariants', () => {
    const validArgs = migrateCli.parseArgs([
        '--apply', '--catalog', 'dc-2026.json', '--report', 'dc-2026-report.json',
        '--filter', '2a45c25b-e126-4777-93f3-de553e03f93f',
        '--from', '5e7c5afd-132c-4d22-8d05-4137b5891dc5',
        '--review-reanalysis-manifest', '/tmp/reanalysis.json'
    ]);
    assert.equal(validArgs.reviewReanalysisManifest, '/tmp/reanalysis.json');

    // Exclusive mode checks
    assert.throws(() => migrateCli.parseArgs([
        '--apply', '--catalog', 'dc-2026.json', '--report', 'dc-2026-report.json',
        '--filter', '2a45c25b-e126-4777-93f3-de553e03f93f',
        '--from', '5e7c5afd-132c-4d22-8d05-4137b5891dc5',
        '--review-reanalysis-manifest', '/tmp/reanalysis.json', '--retry-failed'
    ]));

    // Validate loadAndValidateManifest fails closed on tampered failure SHA
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
    try {
        const manifestFile = path.join(tmp, 'manifest.json');
        fs.writeFileSync(manifestFile, JSON.stringify({
            contract: reviewReanalysis.MANIFEST_CONTRACT,
            conferenceId: 'dc-2026',
            processId: '5e7c5afd-132c-4d22-8d05-4137b5891dc5',
            baseGenerationSha256: 'a'.repeat(64),
            members: []
        }));
        assert.throws(() => reviewReanalysis.loadAndValidateManifest({
            manifestPath: manifestFile,
            state: { processId: '5e7c5afd-132c-4d22-8d05-4137b5891dc5', authority: { conferenceId: 'dc-2026' }, items: {} },
            runtimeRoot: tmp,
            analysisRoot: tmp
        }), /members 必须为非空数组/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

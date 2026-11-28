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

test('conference-reader-review-maintenance traverses verified reviewReanalysisAdoption and rejects tampered receipts', () => {
    const evidence = require('../scripts/lib/conference-reader-review-maintenance-evidence.js');
    const src = fs.readFileSync(path.resolve(__dirname, '../scripts/lib/conference-reader-review-maintenance.js'), 'utf8');
    const fnStart = src.indexOf('function isCurrentOrVerifiedDescendant(');
    const fnEnd = src.indexOf('\nfunction assertCurrentBatch(');
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'isCurrentOrVerifiedDescendant must exist');
    const fnCode = src.slice(fnStart, fnEnd);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-maint-test-'));
    try {
        const procDir = path.join(tmp, 'proc');
        const aRoot = path.join(tmp, 'analyses');
        const oldExec = '11111111-1111-4111-8111-111111111111';
        const newExec = '22222222-2222-4222-8222-222222222222';
        const procId = '33333333-3333-4333-8333-333333333333';
        const paperId = 'conference:dc:2026:conference-paper-id:chandra26_dc';
        fs.mkdirSync(procDir, { recursive: true });
        fs.mkdirSync(path.join(aRoot, oldExec), { recursive: true });
        fs.mkdirSync(path.join(aRoot, newExec), { recursive: true });

        const oldAnalysisSha = 'a'.repeat(64);
        const newAnalysisSha = 'b'.repeat(64);
        const oldRunSha = 'c'.repeat(64);
        const newRunSha = 'd'.repeat(64);
        const sourceSha = 'e'.repeat(64);

        const receiptBody = {
            contract: 'conference-review-reanalysis-adoption-v1',
            processId: procId,
            paperId,
            newExecutionId: newExec,
            previousExecutionId: oldExec,
            previousAnalysisFileSha256: oldAnalysisSha,
            previousItem: { analysisRunId: oldExec },
            proof: { analysisProof: { analysisSha256: newAnalysisSha } }
        };
        const receipt = { ...receiptBody, receiptSha256: evidence.stable(receiptBody) };
        const receiptFile = 'review-reanalysis-adoption-test.json';
        fs.writeFileSync(path.join(procDir, receiptFile), JSON.stringify(receipt));

        const records = {
            [oldExec]: {
                directory: path.join(aRoot, oldExec),
                run: { executionId: oldExec, status: 'complete' },
                analysis: { status: 'complete' },
                analysisFileSha256: oldAnalysisSha,
                runFileSha256: oldRunSha,
                sourceFileSha256: sourceSha
            },
            [newExec]: {
                directory: path.join(aRoot, newExec),
                run: { executionId: newExec, status: 'complete' },
                analysis: { status: 'complete' },
                analysisFileSha256: newAnalysisSha,
                runFileSha256: newRunSha,
                sourceFileSha256: sourceSha
            }
        };

        const check = (v, msg) => { if (!v) throw new Error(`Text maintenance: ${msg}`); };
        const fail = msg => { throw new Error(`Text maintenance: ${msg}`); };
        const read = f => {
            const bytes = fs.readFileSync(f);
            return { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
        };
        const self = (value, field) => {
            const copy = { ...value };
            const expected = copy[field];
            delete copy[field];
            check(evidence.stable(copy) === expected, `${field} mismatch`);
        };
        const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
        const SHA = /^[a-f0-9]{64}$/u;
        const verifiedAdoptedChildIdentities = new WeakMap();
        const adapter = () => ({ loadConferenceAnalysis: ({ executionId }) => records[executionId] });

        const isCurrentOrVerifiedDescendant = new Function(
            'fs', 'path', 'UUID', 'SHA', 'check', 'fail', 'read', 'self', 'adapter', 'stable', 'verifiedAdoptedChildIdentities',
            `${fnCode}\nreturn isCurrentOrVerifiedDescendant;`
        )(fs, path, UUID, SHA, check, fail, read, self, adapter, evidence.stable, verifiedAdoptedChildIdentities);

        const batch = { processDirectory: procDir, analysisRoot: aRoot, m: { processId: procId } };
        const adopted = { executionId: oldExec, analysisFileSha256: oldAnalysisSha, runFileSha256: oldRunSha, sourceFileSha256: sourceSha };
        const item = {
            paperId,
            analysisRunId: newExec,
            analysisProof: { analysisSha256: newAnalysisSha },
            reviewReanalysisAdoption: {
                newExecutionId: newExec,
                previousExecutionId: oldExec,
                previousAnalysisFileSha256: oldAnalysisSha,
                receiptFile,
                receiptSha256: receipt.receiptSha256
            }
        };

        // Positive: valid review-reanalysis receipt bridges back to previously adopted maintenance execution
        assert.equal(isCurrentOrVerifiedDescendant(batch, item, adopted), true);

        // Negative 1: missing reviewReanalysisAdoption returns false (fails closed)
        const itemNoAdoption = { paperId, analysisRunId: newExec, analysisProof: { analysisSha256: newAnalysisSha } };
        assert.equal(isCurrentOrVerifiedDescendant(batch, itemNoAdoption, adopted), false);

        // Negative 2: path traversal in receiptFile throws integrity error
        const itemTraversal = structuredClone(item);
        itemTraversal.reviewReanalysisAdoption.receiptFile = '../evil.json';
        assert.throws(() => isCurrentOrVerifiedDescendant(batch, itemTraversal, adopted), /review reanalysis adoption locator/);

        // Negative 3: tampered receipt content fails self-hash
        fs.writeFileSync(path.join(procDir, receiptFile), JSON.stringify({ ...receipt, paperId: 'forged' }));
        assert.throws(() => isCurrentOrVerifiedDescendant(batch, item, adopted), /receiptSha256 mismatch/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('normalizeLiveModelNodePatchHeader repairs bounded schemaFingerprint copy typos only when contract and draftSha256 match', () => {
    const repair = require('../scripts/lib/reader-repair.js');
    const expected = repair.currentNodePatchHeader();
    const draftSha = 'a'.repeat(64);
    const validRepl = [{ path: '/sections/0/body', oldSha256: 'b'.repeat(64), value: 'updated' }];

    // Real typos observed from muse-spark-1.3-contributor on 117K-char aacl-2026 repair prompts (60-63 chars)
    const typos = [
        '76782f4343594e8a8ac6dbf812f2e113fbf78b5bcdf15f4ace33833d27cc',
        '76782f4343594e8a8ac26dbf812f2e113fbf78b5bcdf15f4ace33833dd27ca',
        '76782f4343594e8a8acb06dbf812f2e113fbf78b5dcbf15f4ace33db33dd7ca',
        '76782f4343594e8a8acb06dbf812f2f113fbf78b5bcdf15f4ace33833dd7ca0'
    ];
    for (const typo of typos) {
        const res = repair.normalizeLiveModelNodePatchHeader({
            contract: expected.contract,
            schemaFingerprint: typo,
            draftSha256: draftSha,
            replacements: validRepl
        }, draftSha);
        assert.equal(res.typoFixed, true, `expected typo to be repaired: ${typo}`);
        assert.equal(res.patch.schemaFingerprint, expected.schemaFingerprint);
    }

    // Negative 1: wrong draftSha256 must NOT be repaired
    const wrongDraft = repair.normalizeLiveModelNodePatchHeader({
        contract: expected.contract,
        schemaFingerprint: typos[0],
        draftSha256: 'f'.repeat(64),
        replacements: validRepl
    }, draftSha);
    assert.equal(wrongDraft.typoFixed, false);

    // Negative 2: unrelated prefix or huge distance must NOT be repaired
    const unrelated = repair.normalizeLiveModelNodePatchHeader({
        contract: expected.contract,
        schemaFingerprint: '0'.repeat(64),
        draftSha256: draftSha,
        replacements: validRepl
    }, draftSha);
    assert.equal(unrelated.typoFixed, false);

    // Negative 3: extra unknown key must NOT be repaired
    const extraKey = repair.normalizeLiveModelNodePatchHeader({
        contract: expected.contract,
        schemaFingerprint: typos[0],
        draftSha256: draftSha,
        replacements: validRepl,
        extra: 1
    }, draftSha);
    assert.equal(extraKey.typoFixed, false);
});

test('analysis-contract recognizes explicit CER/WER/MOS versus comparisons and benchmark 5.4x speedups', () => {
    const ac = require('../scripts/analysis-contract.js');
    const dcSource = 'Among reference-free models, TEMOTTS is both more intelligible and more emotionally faithful. '
        + 'It attains the lowest error rates (CER 4.08%, WER 13.11% versus 8.22/18.57 for VITS [14] and 6.88/18.34 for FastSpeech2, '
        + 'is chosen best in 80.95% of Best–Worst Scaling comparisons for emotion-faithfulness (worst in only 1.90%), and achieves the highest MOS (3.75 ± 0.06).';
    const smcSource = 'Table 1: FDN training benchmark on CPU. Values are mean ± standard deviation over 90 target RIRs with ten training runs per RIR.\n'
        + 'The TD method achieves approximately 5.4× faster training compared to FS, while maintaining comparable memory footprint and achieving similar final loss values.';
    const nonExpSource = 'This position paper outlines an open conceptual framework for acoustic design and discusses future directions without reporting empirical benchmarks.';
    const ungroundedSpeedup = 'In principle, the module runs 2x faster on GPU hardware.';

    assert.equal(ac.classifySourceQuantitativeEvidence(dcSource), true);
    assert.equal(ac.classifySourceQuantitativeEvidence(smcSource), true);
    assert.equal(ac.classifySourceQuantitativeEvidence(nonExpSource), false);
    assert.equal(ac.classifySourceQuantitativeEvidence(ungroundedSpeedup), false);
});

test('reader-tables strips Unicode significance markers (∗/†/‡) when counting result table measurements', () => {
    const rt = require('../scripts/lib/reader-tables.js');
    const sections = [{
        kind: 'result',
        heading: 'Zero-shot results',
        body: [
            '| Test Set | Macro-F1 | F1 Score (AD+) | F1 Score (Control+) |',
            '| --- | --- | --- | --- |',
            '| Pitt-origin | 0.6666∗ | 0.6726∗ | 0.6605∗ |',
            '| Pitt | 0.5924† | 0.7300‡ | 0.4548∗ |'
        ].join('\n')
    }];
    const artifacts = {
        tables: [{
            ordinal: 3,
            recoveryStatus: 'complete',
            sourceDomSha256: 'a'.repeat(64),
            caption: 'Table 3: Kimi-Audio zero-shot and two-shot performance.',
            matrix: [
                ['Test Set', 'Macro-F1', 'F1 Score (AD+)', 'F1 Score (Control+)'],
                ['Pitt-origin', '0.6666', '0.6726', '0.6605'],
                ['Pitt', '0.5924', '0.7300', '0.4548']
            ],
            cells: [
                { row: 0, column: 0, text: 'Test Set', header: true },
                { row: 0, column: 1, text: 'Macro-F1', header: true },
                { row: 0, column: 2, text: 'F1 Score (AD+)', header: true },
                { row: 0, column: 3, text: 'F1 Score (Control+)', header: true },
                { row: 1, column: 0, text: 'Pitt-origin', header: false },
                { row: 1, column: 1, text: '0.6666', header: false },
                { row: 1, column: 2, text: '0.6726', header: false },
                { row: 1, column: 3, text: '0.6605', header: false },
                { row: 2, column: 0, text: 'Pitt', header: false },
                { row: 2, column: 1, text: '0.5924', header: false },
                { row: 2, column: 2, text: '0.7300', header: false },
                { row: 2, column: 3, text: '0.4548', header: false }
            ]
        }]
    };
    const res = rt.validateReaderResultTableCoverage(sections, artifacts);
    assert.equal(res.numericResultTables, 1);

    // Negative: non-numeric text cells with ∗ must still NOT count as measurements
    const textOnlySections = [{
        kind: 'result',
        heading: 'Text table',
        body: [
            '| Test Set | Metric A | Metric B |',
            '| --- | --- | --- |',
            '| Pitt-origin | high∗ | better† |',
            '| Pitt | low‡ | worse∗ |'
        ].join('\n')
    }];
    assert.throws(() => rt.validateReaderResultTableCoverage(textOnlySections, artifacts), /主结果表覆盖不足/);
});

test('reader-source-display projects exact fontmath.ltx arrow delimiter codes and leaves unknown delimiters untouched', () => {
    const display = require('../scripts/lib/reader-source-display.js');
    assert.equal(display.projectReaderCellTexDisplay('FGD\\delimiter "3223379'), 'FGD↓');
    assert.equal(display.projectReaderCellTexDisplay('BC\\delimiter "3222378'), 'BC↑');
    assert.equal(display.projectReaderCellTexDisplay('Delta\\delimiter "326C33F'), 'Delta↕');
    // Negative: unknown delimiter hex code must stay untouched so bare-TeX gate still catches it
    assert.equal(display.projectReaderCellTexDisplay('X\\delimiter "9999999'), 'X\\delimiter "9999999');
});

test('analysis-contract recognizes newline-split PDF FAD result tables and standalone % table columns', () => {
    const ac = require('../scripts/analysis-contract.js');
    const newlineSplitFad = [
        'Results are presented in Table 1.',
        'Waves', 'Thunder', 'Rain', 'Avg',
        'FAD↓', 'FAD↓', 'FAD↓', 'FAD↓',
        'Single-Scale', '2.825', '3.2678', '4.623', '3.572',
        'Multi-Scale', '1.396', '1.5298', '1.364', '1.430',
        'Table 1. FAD results across sound categories for different model configurations (↓ lower is better).'
    ].join('\n');
    assert.equal(ac.classifySourceQuantitativeEvidence(newlineSplitFad), true);

    // Negative: prose mentioning Table 1 without numeric table rows must remain false
    const nonResultTable = 'Table 1 lists the recording equipment used during data collection.\nMicrophone A\nMicrophone B\n';
    assert.equal(ac.classifySourceQuantitativeEvidence(nonResultTable), false);

    // Standalone % column header in PDF table must allow % in core summary for table percentages
    const standalonePctSrc = 'Category\nSpeakers\nRecordings\n%\nTotal\n461\n1,844\n100\nMale\n310\n1,240\n67\nIstanbul\n381\n1,524\n83\n'
        + 'TO-HTER\nROCCH-EER\nResNet34-LM\n0.0055\n0.0107\nTitaNet-Large\n0.0812\n0.0591\n';
    const summaryWithPct = '在 TurkSV-Bench 上，ResNet34-LM 取得 0.0055% TO-HTER 与 0.0107% ROCCH-EER，TitaNet-Large 为 0.0812%，数据集中男性占 67%、伊斯坦布尔口音占 83%。';
    assert.equal(ac.validateCoreSummarySemanticContract.validateCoreSummarySourceGroundedClaims(summaryWithPct, standalonePctSrc), null);
    // Negative: invented % without any % table header or % token in source must still fail
    const noPctSrc = 'ResNet34-LM obtains 0.0055 and 0.0107 on the test set.';
    assert.match(String(ac.validateCoreSummarySemanticContract.validateCoreSummarySourceGroundedClaims(
        '模型取得 0.0055% 与 0.0107%。', noPctSrc
    )), /添加了原文不存在的百分号/);
});

test('conference-analysis-context scopes verified review reanalysis guidance strictly to matching paperId', () => {
    const ctx = require('../scripts/lib/conference-analysis-context.js');
    const pid = 'conference:sigdial:2026:conference-paper-id:2026.sigdial-1.33';
    const otherPid = 'conference:sigdial:2026:conference-paper-id:2026.sigdial-1.1';
    const sha = 'a'.repeat(64);
    assert.equal(ctx.formatReviewReanalysisPromptWarning({ id: pid }), '');
    ctx.withReviewReanalysisGuidance({
        paperId: pid,
        reviewFailureSha256: sha,
        stage: 'text',
        issues: [
            { severity: 'info', description: 'non-blocking note' },
            { severity: 'error', description: 'Table 4 延迟 0.45s 与 0.53s 对调', fix_instruction: '按原表顺序核正' }
        ]
    }, () => {
        const warning = ctx.formatReviewReanalysisPromptWarning({ id: pid });
        assert.match(warning, /Table 4 延迟 0\.45s 与 0\.53s 对调/);
        assert.match(warning, /按原表顺序核正/);
        assert.doesNotMatch(warning, /non-blocking note/);
        // Negative: different paperId must receive empty string
        assert.equal(ctx.formatReviewReanalysisPromptWarning({ id: otherPid }), '');
    });
    // Outside scope must return empty string again
    assert.equal(ctx.formatReviewReanalysisPromptWarning({ id: pid }), '');
});

test('conference-review-reanalysis accepts SHA-verified aggregate review failures and rejects mismatched SHAs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-reanalysis-agg-'));
    try {
        const runtimeRoot = path.join(tmp, 'runtime');
        const analysisRoot = path.join(runtimeRoot, 'conference-analysis-executions');
        const cid = 'impactspeech-2026';
        const processId = '484f6ba7-8746-469f-8409-eb7564fb12b1';
        const paperId = 'conference:impactspeech:2026:conference-paper-id:2026.impactspeech-1.6';
        const prevExec = '0ce0a91f-3c8e-4a67-a83b-fb7894421c4b';
        const prevAnalysisDir = path.join(analysisRoot, prevExec);
        fs.mkdirSync(prevAnalysisDir, { recursive: true });
        const analysisBytes = Buffer.from(JSON.stringify({ status: 'complete' }));
        fs.writeFileSync(path.join(prevAnalysisDir, 'analysis.json'), analysisBytes);
        const analysisSha = sha256(analysisBytes);

        const paperSha = '1'.repeat(64);
        const aggSha = '2'.repeat(64);
        const genBody = {
            conferenceId: cid,
            processId,
            files: [
                { kind: 'paper', paperId, path: 'content/posts/p6.md', sourceSha256: paperSha },
                { kind: 'aggregate', paperId: null, path: 'content/posts/conference-impactspeech-2026.md', sourceSha256: aggSha }
            ]
        };
        const genSha = processApi.stableHash(genBody);
        const pubDir = path.join(runtimeRoot, 'conference-publications', cid, processId);
        fs.mkdirSync(pubDir, { recursive: true });
        fs.writeFileSync(path.join(pubDir, 'generation.json'), JSON.stringify({ ...genBody, generationSha256: genSha }));

        const failDir = path.join(runtimeRoot, 'conference-publications', 'page-review-failures');
        fs.mkdirSync(failDir, { recursive: true });
        const aggFailBody = {
            path: 'content/posts/conference-impactspeech-2026.md',
            sha256: aggSha,
            paperId: null,
            passed: false,
            completed: true,
            failureKind: 'content',
            stage: 'text',
            issues: [{ severity: 'error', description: '第8篇评分说明量纲错误：说话人数733s' }]
        };
        const aggFailSha = processApi.stableHash(aggFailBody);
        fs.writeFileSync(path.join(failDir, `${aggFailSha}.json`), JSON.stringify({ ...aggFailBody, failureSha256: aggFailSha }));

        const manifestPath = path.join(tmp, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            contract: reviewReanalysis.MANIFEST_CONTRACT,
            conferenceId: cid,
            processId,
            baseGenerationSha256: genSha,
            members: [{
                paperId,
                previousExecutionId: prevExec,
                previousAnalysisFileSha256: analysisSha,
                reviewFailureSha256: aggFailSha,
                reason: 'Aggregate review flagged paper #8 unit mismatch'
            }]
        }));
        const state = {
            processId,
            authority: { conferenceId: cid },
            items: {
                [paperId]: {
                    status: 'complete',
                    analysisRunId: prevExec,
                    analysisProof: { analysisSha256: analysisSha }
                }
            }
        };
        const plan = reviewReanalysis.loadAndValidateManifest({ manifestPath, state, runtimeRoot, analysisRoot });
        assert.equal(plan.members.length, 1);
        assert.equal(plan.members[0].verifiedReviewFailure.issues.length, 1);

        // Negative: aggregate failure with wrong sha256 must be rejected
        const badFailBody = { ...aggFailBody, sha256: '3'.repeat(64) };
        const badFailSha = processApi.stableHash(badFailBody);
        fs.writeFileSync(path.join(failDir, `${badFailSha}.json`), JSON.stringify({ ...badFailBody, failureSha256: badFailSha }));
        const badManifestPath = path.join(tmp, 'bad-manifest.json');
        fs.writeFileSync(badManifestPath, JSON.stringify({
            contract: reviewReanalysis.MANIFEST_CONTRACT,
            conferenceId: cid,
            processId,
            baseGenerationSha256: genSha,
            members: [{
                paperId,
                previousExecutionId: prevExec,
                previousAnalysisFileSha256: analysisSha,
                reviewFailureSha256: badFailSha,
                reason: 'Mismatched aggregate SHA'
            }]
        }));
        assert.throws(() => reviewReanalysis.loadAndValidateManifest({
            manifestPath: badManifestPath, state, runtimeRoot, analysisRoot
        }), /审查失败记录与目标论文页面或汇总页面 SHA 不一致/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('utils buildRequestBody reasoningEffortOverride only steps strictly downward from stage ceiling', () => {
    const utils = require('../scripts/utils.js');
    const prev = process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
    const prevTiered = process.env.PD_TIERED_REASONING_EFFORT;
    process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = 'xhigh';
    delete process.env.PD_TIERED_REASONING_EFFORT;
    try {
        const msgs = [{ role: 'user', content: 'hello' }];
        const base = utils.buildRequestBody('openai_responses', 'muse-spark-1.3-contributor', msgs, 128000, 0.6, {
            usageContext: { stage: 'apiReaderArticle' }
        });
        assert.equal(base.reasoning?.effort, 'xhigh');

        // Downward step-down xhigh -> high is allowed
        const steppedDown = utils.buildRequestBody('openai_responses', 'muse-spark-1.3-contributor', msgs, 128000, 0.6, {
            usageContext: { stage: 'apiReaderArticle' },
            reasoningEffortOverride: 'high'
        });
        assert.equal(steppedDown.reasoning?.effort, 'high');

        // Upward override on a low stage is ignored (never exceeds stage ceiling)
        const lowAttempt = utils.buildRequestBody('openai_responses', 'muse-spark-1.3-contributor', msgs, 16000, 0.1, {
            usageContext: { stage: 'dailyFilter' },
            reasoningEffortOverride: 'xhigh'
        });
        assert.equal(lowAttempt.reasoning?.effort, 'low');
    } finally {
        if (prev === undefined) delete process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
        else process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT = prev;
        if (prevTiered === undefined) delete process.env.PD_TIERED_REASONING_EFFORT;
        else process.env.PD_TIERED_REASONING_EFFORT = prevTiered;
    }
});

test('reader-authenticated-pdf-table-evidence matches space-percent headers and bottom-caption tables without stray gap', () => {
    const api = require('../scripts/lib/reader-authenticated-pdf-table-evidence.js');
    const { extractMarkdownTables } = require('../scripts/analysis-contract.js');
    const raw = [
        'Style Accuracy',
        'Style Consistency',
        'Method',
        'Top-1 % ↑',
        'Top-3 % ↑',
        'Top-5 % ↑',
        'Mean CosSim ↑',
        'w/o ScAT',
        '38.26',
        '76.74',
        '91.21',
        '0.5882',
        'Full',
        '48.84',
        '79.07',
        '95.37',
        '0.7565',
        'Table 4: Ablation Study on ScAT Components for Style Consistency and Accuracy'
    ].join('\n');
    const doc = {
        contract: 'reader-sealed-pdf-quotes-v1',
        available: true,
        rawFullText: raw,
        normalizedFullText: raw.replace(/\s+/g, ' ').trim()
    };
    const rendered = extractMarkdownTables(
        '| Method | Top-1 % ↑ | Top-3 % ↑ | Top-5 % ↑ | Mean CosSim ↑ |\n'
        + '|---|---|---|---|---|\n'
        + '| w/o ScAT | 38.26 | 76.74 | 91.21 | 0.5882 |\n'
        + '| Full | 48.84 | 79.07 | 95.37 | 0.7565 |'
    )[0];
    const match = api.matchLiteralTable(rendered, [raw], doc, raw);
    assert.ok(match);
    assert.deepEqual(match.columns.map(c => [c.metric, c.unit]), [['Top-1', '%'], ['Top-3', '%'], ['Top-5', '%']]);
    assert.equal(match.rows.length, 2);

    // Negative: stray prose line between last data row and bottom caption must reject
    const withGap = raw.replace('Table 4:', 'Some intervening prose paragraph.\nTable 4:');
    const gapDoc = { ...doc, rawFullText: withGap, normalizedFullText: withGap.replace(/\s+/g, ' ').trim() };
    assert.equal(api.matchLiteralTable(rendered, [withGap], gapDoc, withGap), null);

    // Negative: missing % in source column must reject
    const noPct = raw.replace('Top-1 % ↑', 'Top-1 ↑');
    const noPctDoc = { ...doc, rawFullText: noPct, normalizedFullText: noPct.replace(/\s+/g, ' ').trim() };
    assert.equal(api.matchLiteralTable(rendered, [noPct], noPctDoc, noPct), null);
});


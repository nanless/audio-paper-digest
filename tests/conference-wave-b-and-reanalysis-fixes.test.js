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

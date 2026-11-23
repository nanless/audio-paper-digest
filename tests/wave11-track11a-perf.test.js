'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const { withPdfExtractionScope, runPdfExtractorJson } = require('../scripts/lib/reader-pdf-extraction-scope.js');
const quoteEvidence = require('../scripts/lib/reader-sealed-pdf-quote-evidence.js');
const {
    backupPapersJson,
    verifyPapersBackup,
    listValidManagedBackupGroups,
    savePapersDatabase
} = require('../scripts/digest-status.js');
const { deriveExactTableSourceQuotes } = require('../scripts/deep-analyzer.js');
const { findQuantitativeChineseNumerals } = require('../scripts/editorial-quality.js');
const { executeSyntaxStepsParallel } = require('../scripts/verify-project.js');
const { validateCurrentDataFiles } = require('../scripts/validate-data-files.js');

test('runPdfExtractorJson rejects mismatched SHA, non-Buffer pdf, and meta.pdfBase64', () => {
    const program = path.join(ROOT, 'scripts/reader_sealed_pdf_table_evidence.py');
    const buf = Buffer.from('%PDF-1.4\nfake-bytes\n');
    assert.throws(
        () => runPdfExtractorJson(program, { pdfBuffer: 'not-a-buffer', pdfSha256: sha256(buf), meta: {} }),
        /SHA mismatch/
    );
    assert.throws(
        () => runPdfExtractorJson(program, { pdfBuffer: buf, pdfSha256: '0'.repeat(64), meta: {} }),
        /SHA mismatch/
    );
    assert.throws(
        () => runPdfExtractorJson(program, { pdfBuffer: buf, pdfSha256: sha256(buf), meta: { pdfBase64: 'x' } }),
        /Invalid PDF extractor JSON metadata/
    );
    assert.throws(
        () => runPdfExtractorJson(program, { pdfBuffer: buf, pdfSha256: sha256(buf), meta: { toJSON: () => ({}) } }),
        /Invalid PDF extractor JSON metadata/
    );
});

test('runPdfExtractorJson caches inside withPdfExtractionScope without re-spawning and isolates copies', (t) => {
    const program = path.join(ROOT, 'scripts/reader_sealed_pdf_table_evidence.py');
    const pdfBuffer = Buffer.from('%PDF-1.4\nwave11-track11a-test\n');
    const pdfSha256 = sha256(pdfBuffer);
    let calls = 0;
    t.mock.method(child, 'execFileSync', () => {
        calls += 1;
        return Buffer.from(JSON.stringify({ ok: true, call: calls }));
    });

    const metaA = { pdfSha256, tables: [{ ordinal: 1 }] };
    const metaB = { pdfSha256, tables: [{ ordinal: 2 }] };

    withPdfExtractionScope(() => {
        const first = runPdfExtractorJson(program, { pdfBuffer, pdfSha256, meta: metaA });
        assert.equal(calls, 1);
        assert.deepEqual(JSON.parse(first.toString('utf8')), { ok: true, call: 1 });
        // Mutating the returned buffer must never corrupt cached bytes.
        first[0] = 0x58;

        const second = runPdfExtractorJson(program, { pdfBuffer, pdfSha256, meta: metaA });
        assert.equal(calls, 1);
        assert.deepEqual(JSON.parse(second.toString('utf8')), { ok: true, call: 1 });

        // Changing meta must miss the cache.
        const third = runPdfExtractorJson(program, { pdfBuffer, pdfSha256, meta: metaB });
        assert.equal(calls, 2);
        assert.deepEqual(JSON.parse(third.toString('utf8')), { ok: true, call: 2 });
    });

    // Outside scope, cache is cleared and must invoke subprocess normally.
    const outside = runPdfExtractorJson(program, { pdfBuffer, pdfSha256, meta: metaA });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(outside.toString('utf8')), { ok: true, call: 3 });
});

test('assertQuoteEvidences fails closed outside verified saved-paper scope and rejects malformed proofs', () => {
    assert.equal(quoteEvidence.assertQuoteEvidences([]), true);
    assert.throws(() => quoteEvidence.assertQuoteEvidences(null), /Expected array/i);
    assert.throws(() => quoteEvidence.assertQuoteEvidences({}), /Expected array/i);
    assert.throws(
        () => quoteEvidence.assertQuoteEvidences([{ contract: 'invalid', quote: 'x' }]),
        /unknown or mixed|not a sealed PDF quote|outside/i
    );
});

test('backupPapersJson uses compressedOnly listing yet verifies matching candidate before reuse and recovers from corrupt duplicate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave11-backup-test-'));
    try {
        const papersPath = path.join(tmpDir, 'papers.json');
        const backupDir = path.join(tmpDir, 'backups');
        savePapersDatabase({ papers: { '2611.00001': { arxivId: '2611.00001v1', title: 'Track 11A Backup Test' } } }, papersPath);

        const first = await backupPapersJson(papersPath, backupDir, { date: '2026-11-20', maxGroups: 7 });
        assert.equal(first.backedUp, true);
        const fastGroups = await listValidManagedBackupGroups(backupDir, { compressedOnly: true });
        assert.equal(fastGroups.length, 1);
        assert.equal(fastGroups[0].manifest.sourceSha256, first.sourceSha256);

        // Unmodified duplicate on a new date must reuse after full verification of the matching group.
        const second = await backupPapersJson(papersPath, backupDir, { date: '2026-11-21', maxGroups: 7 });
        assert.equal(second.backedUp, false);
        assert.equal(second.duplicateOf, first.backupPath);

        // Corrupt the gzip payload AND update manifest compressedSha256 so compressedOnly passes,
        // proving full decompression verification catches the corrupt duplicate and creates a fresh valid backup.
        const corrupted = Buffer.from('not-a-valid-gzip-stream');
        fs.writeFileSync(first.backupPath, corrupted);
        const badManifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
        badManifest.compressedBytes = corrupted.length;
        badManifest.compressedSha256 = sha256(corrupted);
        fs.writeFileSync(first.manifestPath, JSON.stringify(badManifest));

        const listedWithCorrupt = await listValidManagedBackupGroups(backupDir, { compressedOnly: true });
        assert.equal(listedWithCorrupt.length, 1, 'compressedOnly checks compressed bytes/SHA');
        await assert.rejects(
            () => verifyPapersBackup(first.backupPath, { manifestPath: first.manifestPath }),
            /解压|损坏|incorrect header|invalid/i
        );
        const third = await backupPapersJson(papersPath, backupDir, { date: '2026-11-22', maxGroups: 7 });
        assert.equal(third.backedUp, true);
        assert.notEqual(third.manifestPath, first.manifestPath);
        const verifiedThird = await verifyPapersBackup(third.backupPath, { manifestPath: third.manifestPath });
        assert.equal(verifiedThird.manifest.sourceSha256, first.sourceSha256);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('backupPapersJson retention full-verifies before pruning: corrupt newer backup never prunes valid older backup or gets auto-deleted', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave11-backup-retention-'));
    try {
        const papersPath = path.join(tmpDir, 'papers.json');
        const backupDir = path.join(tmpDir, 'backups');

        // Day 1: valid backup
        savePapersDatabase({ papers: { '2611.00001': { arxivId: '2611.00001v1', title: 'Day 1' } } }, papersPath);
        const day1 = await backupPapersJson(papersPath, backupDir, {
            date: '2026-11-20', createdAt: '2026-11-20T08:00:00+08:00', maxGroups: 2
        });
        assert.equal(day1.backedUp, true);

        // Day 2: different content, then corrupt its gzip stream while matching compressedSha256 in manifest
        savePapersDatabase({ papers: { '2611.00002': { arxivId: '2611.00002v1', title: 'Day 2' } } }, papersPath);
        const day2 = await backupPapersJson(papersPath, backupDir, {
            date: '2026-11-21', createdAt: '2026-11-21T08:00:00+08:00', maxGroups: 2
        });
        assert.equal(day2.backedUp, true);
        const corruptStream = Buffer.from('corrupt-gzip-payload-matching-compressed-sha');
        fs.writeFileSync(day2.backupPath, corruptStream);
        const day2Manifest = JSON.parse(fs.readFileSync(day2.manifestPath, 'utf8'));
        day2Manifest.compressedBytes = corruptStream.length;
        day2Manifest.compressedSha256 = sha256(corruptStream);
        fs.writeFileSync(day2.manifestPath, JSON.stringify(day2Manifest));

        // Day 3: maxGroups = 2. Only Day 1 and Day 3 are genuinely valid, so Day 1 must survive
        // AND corrupt Day 2 must NOT be auto-deleted or counted toward maxGroups.
        savePapersDatabase({ papers: { '2611.00003': { arxivId: '2611.00003v1', title: 'Day 3' } } }, papersPath);
        const day3 = await backupPapersJson(papersPath, backupDir, {
            date: '2026-11-22', createdAt: '2026-11-22T08:00:00+08:00', maxGroups: 2
        });
        assert.equal(day3.backedUp, true);
        assert.deepEqual(day3.removed, []);
        assert.equal(fs.existsSync(day1.backupPath), true, 'Valid Day 1 backup must NOT be prematurely pruned');
        assert.equal(fs.existsSync(day2.backupPath), true, 'Corrupt Day 2 backup must NOT be auto-deleted');
        assert.equal(fs.existsSync(day3.backupPath), true, 'Valid Day 3 backup must exist');

        // Day 4: now 3 genuinely valid backups (Day 1, Day 3, Day 4) exceed maxGroups = 2 -> only valid Day 1 pruned; corrupt Day 2 untouched.
        savePapersDatabase({ papers: { '2611.00004': { arxivId: '2611.00004v1', title: 'Day 4' } } }, papersPath);
        const day4 = await backupPapersJson(papersPath, backupDir, {
            date: '2026-11-23', createdAt: '2026-11-23T08:00:00+08:00', maxGroups: 2
        });
        assert.equal(day4.backedUp, true);
        assert.deepEqual(day4.removed, [day1.backupPath]);
        assert.equal(fs.existsSync(day1.backupPath), false);
        assert.equal(fs.existsSync(day2.backupPath), true, 'Corrupt Day 2 backup remains untouched');
        assert.equal(fs.existsSync(day3.backupPath), true);
        assert.equal(fs.existsSync(day4.backupPath), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('deriveExactTableSourceQuotes O(1) window matches document locators, versions, citations and runs linearly on large text', () => {
    const filler = 'Speech separation improves WER across noisy acoustic mixtures. '.repeat(2500);
    const sourceText = [
        filler,
        'See Table   1 and Fig.  2.1 and Equation 3.4 for details.',
        'Protocol version  :  v  2.1 is used in JSON-RPC  2.0 calls.',
        'Prior work ( 42 ) and [  19  ] reported baseline 91.5% accuracy and commit 123abc.',
        'Our model achieves 87.3% accuracy and 14.2 dB SI-SDR on the benchmark.'
    ].join('\n');

    const md = '| Metric | Score |\n| --- | --- |\n| Accuracy | 87.3% |\n| SI-SDR | 14.2 dB |';
    const t0 = performance.now();
    const quotes = deriveExactTableSourceQuotes(md, sourceText);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 1500, `Expected linear runtime (<1500ms), got ${elapsedMs.toFixed(1)}ms`);
    assert.ok(quotes.some(q => q.includes('87.3%')), 'Should extract real metric quote 87.3%');
    assert.ok(quotes.some(q => q.includes('14.2 dB')), 'Should extract real unit quote 14.2 dB');

    // Document locators, protocol versions, and bracketed citations must never be auto-selected as bare counts.
    const locatorMd = '| Item | Count |\n| --- | --- |\n| A | 42 |\n| B | 19 |\n| C | 2.1 |\n| D | 2.0 |';
    const locatorQuotes = deriveExactTableSourceQuotes(locatorMd, sourceText);
    assert.ok(!locatorQuotes.some(q => q.includes('( 42 )')), 'Parenthetical citation must be skipped');
    assert.ok(!locatorQuotes.some(q => q.includes('[  19  ]')), 'Bracketed citation must be skipped');
    assert.ok(!locatorQuotes.some(q => q.includes('v  2.1')), 'Version string must be skipped');
    assert.ok(!locatorQuotes.some(q => q.includes('JSON-RPC  2.0')), 'Protocol version string must be skipped');
});

test('findQuantitativeChineseNumerals with hoisted regexes returns deterministic results across repeated calls', () => {
    const sample = '实验在三种条件下测量，误码率下降百分之十二点五，耗时五毫秒。';
    const first = findQuantitativeChineseNumerals(sample, { editorialProfile: 'structured-pipeline-v5' });
    const second = findQuantitativeChineseNumerals(sample, { editorialProfile: 'structured-pipeline-v5' });
    assert.deepEqual(second, first);
    assert.ok(first.some(item => item.reason === 'percentage'));
    assert.ok(first.some(item => item.reason === 'measured_simple_integer' && item.match === '五毫秒'));
});

test('executeSyntaxStepsParallel runs valid steps in parallel and fails with exact message on syntax error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave11-syntax-test-'));
    try {
        const good1 = path.join(tmpDir, 'good1.js');
        const good2 = path.join(tmpDir, 'good2.js');
        const bad = path.join(tmpDir, 'bad.js');
        fs.writeFileSync(good1, 'const x = 1;\n');
        fs.writeFileSync(good2, 'function f() { return 2; }\n');
        fs.writeFileSync(bad, 'function broken( { return 3; }\n');

        await executeSyntaxStepsParallel([
            { group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', good1] },
            { group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', good2] }
        ], { root: tmpDir, concurrency: 2 });

        await assert.rejects(
            () => executeSyntaxStepsParallel([
                { group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', good1] },
                { group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', bad] }
            ], { root: tmpDir, concurrency: 2 }),
            /JavaScript 语法检查 失败/
        );
        // Invalid/NaN concurrency must fall back to default worker pool, never skip checks silently.
        await assert.rejects(
            () => executeSyntaxStepsParallel([
                { group: 'JavaScript 语法检查', command: process.execPath, args: ['--check', bad] }
            ], { root: tmpDir, concurrency: Number.NaN }),
            /JavaScript 语法检查 失败/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateCurrentDataFiles read-only cache never leaks between runs or hides file mutations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave11-validate-cache-'));
    try {
        const papersPath = path.join(tmpDir, 'papers.json');
        fs.writeFileSync(papersPath, JSON.stringify({ papers: {} }));
        const files = {
            papers: papersPath,
            fetchCheckpoint: path.join(tmpDir, 'missing-cp.json'),
            rawCandidates: path.join(tmpDir, 'missing-raw.json'),
            filterDecisions: path.join(tmpDir, 'missing-dec.json'),
            filteredPapers: path.join(tmpDir, 'missing-filt.json'),
            deepAnalysisResult: path.join(tmpDir, 'missing-deep.json')
        };
        assert.deepEqual(validateCurrentDataFiles(files), []);

        // Mutate papers.json to invalid schema on disk and re-run validateCurrentDataFiles:
        // the per-run cache must not bleed across invocations.
        fs.writeFileSync(papersPath, JSON.stringify({ papers: 'corrupted-not-object' }));
        const issues = validateCurrentDataFiles(files);
        assert.ok(issues.length > 0, 'Tampered papers.json must fail on next validateCurrentDataFiles call');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

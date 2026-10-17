'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAnalysisBatchRetryReporter, currentAnalysisBatchRetryDiagnostic,
    buildDigestRunReport } = require('../scripts/digest-run-report');
const Config = require('../scripts/config');

test('daily retry diagnostics bind source/date/scope and never grant completion or new API requests', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-batch-retry-report-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const date = '2026-10-15', id = '2610.90011', file = path.join(root, 'deep.json');
    const source = { runId: 'controlled-source', batchDate: date, sourceSetSha256: 'a'.repeat(64) };
    const paper = { arxivId: id, batchDate: date, title: 'Failed paper', analysis: null };
    fs.writeFileSync(file, JSON.stringify({ batchDate: date, dailyFreshSourceRun: source,
        papers: [paper], status: 'failed', stats: {} }), { mode: 0o600 });
    const observe = createAnalysisBatchRetryReporter(file, { workflow: 'daily', batchDate: date,
        sourceReference: source, papers: [paper] });
    for (let round = 1; round <= 3; round++) await observe({ round, maxRounds: 3,
        inputIds: [id], attemptedIds: [id], successIds: [], failedIds: [id],
        manualHandoff: { eligible: round === 3, eligibleIds: round === 3 ? [id] : [],
            status: round === 3 ? 'ready' : 'not_ready', newApiRequestsAuthorized: false } });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.status, 'failed'); assert.equal(saved.papers[0].analysis, null);
    const diagnostic = currentAnalysisBatchRetryDiagnostic(saved, date, [id]);
    assert.equal(diagnostic.roundsCompleted, 3); assert.equal(diagnostic.manualHandoff.eligible, true);
    assert.equal(diagnostic.newApiRequestsAuthorized, false);
    assert.equal(currentAnalysisBatchRetryDiagnostic(saved, '2026-10-14', [id]), null);
    const changed = structuredClone(saved); changed.dailyFreshSourceRun.runId = 'new-source';
    assert.equal(currentAnalysisBatchRetryDiagnostic(changed, date, [id]), null);
    const resolved = currentAnalysisBatchRetryDiagnostic(saved, date, []);
    assert.equal(resolved.manualHandoff.eligible, false);
    assert.equal(saved.stats.analysisBatchRetry.manualHandoff.eligible, true, 'read-only report never changes canonical diagnostics');

    // The report also inspects publication, visual and waiver state. Keep all
    // data roots private so this retry-only fixture cannot replay a real batch.
    const fileKeys = ['deepAnalysisResult', 'rawCandidates', 'filteredPapers', 'filterDecisions', 'papers'];
    const directoryKeys = ['visualSummaryManifestDir', 'digestCoverManifestDir',
        'visualSummaryAssetDir', 'digestCoverAssetDir', 'analysisWaiverDir',
        'postPublishVisualWaiverDir', 'dailyFreshSourceRunsDir'];
    const previous = Object.fromEntries([...fileKeys, ...directoryKeys].map(key => [key, Config.FILES[key]]));
    const previousCurrent = Config.CURRENT_DIR, previousArchive = Config.ARCHIVE_DIR;
    t.after(() => {
        Config.CURRENT_DIR = previousCurrent;
        Config.ARCHIVE_DIR = previousArchive;
        Object.assign(Config.FILES, previous);
    });
    Config.CURRENT_DIR = path.join(root, 'current');
    Config.ARCHIVE_DIR = path.join(root, 'archive');
    for (const key of fileKeys) Config.FILES[key] = path.join(Config.CURRENT_DIR, `${key}.json`);
    for (const key of directoryKeys) Config.FILES[key] = path.join(root, key);
    Config.FILES.deepAnalysisResult = file;
    const report = buildDigestRunReport(date, { today: date });
    assert.equal(report.analysis.batchRetry.manualHandoff.eligible, true);
    assert.equal(report.analysis.complete, false); assert.equal(report.overallStatus, 'incomplete');

    for (const damage of [
        value => { delete value.manualHandoff.eligibleIds; },
        value => { value.manualHandoff.eligibleIds = 'not-an-array'; },
        value => { value.manualHandoff = null; },
        value => { delete value.rounds.at(-1).failedIds; },
        value => { value.rounds.at(-1).failedIds = { paper: id }; }
    ]) {
        const malformed = structuredClone(saved);
        damage(malformed.stats.analysisBatchRetry);
        fs.writeFileSync(file, JSON.stringify(malformed));
        assert.equal(currentAnalysisBatchRetryDiagnostic(malformed, date, [id]), null);
        const readOnly = buildDigestRunReport(date, { today: date });
        assert.equal(readOnly.analysis.batchRetry, null);
        assert.equal(readOnly.analysis.complete, false);
        assert.equal(readOnly.overallStatus, 'incomplete', 'unsigned malformed diagnostics never change completion status');
    }

    fs.writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(observe({ round: 4, maxRounds: 4, manualHandoff: {} }), /日期、来源或论文范围已变化/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stats.analysisBatchRetry.roundsCompleted, 3);
});

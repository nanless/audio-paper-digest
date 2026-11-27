'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recordLlmUsage } = require('../scripts/lib/llm-usage.js');
const { usageEventHeader } = require('../scripts/lib/llm-usage-format.js');
const scorecard = require('../scripts/digest-scorecard.js');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

test('digest-scorecard: classifyEventWorkflow distinguishes daily, conference, and history events', () => {
    assert.equal(scorecard.classifyEventWorkflow({ stage: 'primaryAnalysis', paperId: '2611.00001' }), 'daily');
    assert.equal(scorecard.classifyEventWorkflow({ stage: 'dailyFilter', paperId: '2611.00002' }), 'daily');
    assert.equal(
        scorecard.classifyEventWorkflow({ stage: 'conference-filter', paperId: 'conference:icassp:2026:icassp-arnumber:100' }),
        'conference'
    );
    assert.equal(
        scorecard.classifyEventWorkflow({ stage: 'primaryAnalysis', paperId: 'conference:interspeech:2026:conference-paper-id:p1' }),
        'conference'
    );
    assert.equal(scorecard.classifyEventWorkflow({ stage: 'historical-rewrite', paperId: '2501.00001' }), 'history');
    assert.equal(scorecard.classifyEventWorkflow({ stage: 'history-review', paperId: '2501.00002' }), 'history');
    assert.equal(scorecard.classifyEventWorkflow({ workflow: 'conference', stage: 'revision', paperId: '2611.00003' }), 'conference');
    assert.equal(scorecard.classifyEventWorkflow({ workflow: 'history', stage: 'primaryAnalysis', paperId: '2611.00004' }), 'history');
});

test('digest-scorecard: parseArgs supports --workflow daily|conference|history and rejects invalid values', () => {
    assert.equal(scorecard.parseArgs(['--date', '2026-11-26', '--workflow', 'daily']).workflow, 'daily');
    assert.equal(scorecard.parseArgs(['--date', '2026-11-26', '--workflow=conference']).workflow, 'conference');
    assert.equal(scorecard.parseArgs(['--date', '2026-11-26', '--workflow', 'HISTORY']).workflow, 'history');
    assert.equal(scorecard.parseArgs(['--date', '2026-11-26']).workflow, undefined);
    assert.throws(() => scorecard.parseArgs(['--workflow', 'invalid']), /--workflow 必须是 daily\|conference\|history 之一/);
    assert.throws(() => scorecard.parseArgs(['--workflow=']), /--workflow 必须是 daily\|conference\|history 之一/);
});

test('digest-scorecard: --workflow filters usage events end-to-end across daily, conference, and history', t => {
    const dir = makeTempDir('pd-scorecard-workflow-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageDir = path.join(dir, 'llm-usage');
    const targetDate = '2026-11-26';

    recordLlmUsage({
        protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor',
        request: { input: 'daily-req' },
        response: { status: 'completed', output_text: 'ok', usage: { input_tokens: 1000, output_tokens: 200 } },
        statusCode: 200,
        durationMs: 1200,
        transportStarted: true,
        context: { stage: 'primaryAnalysis', paperId: '2611.10001' },
        at: `${targetDate}T09:00:00+08:00`
    }, { directory: usageDir });

    recordLlmUsage({
        protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor',
        request: { input: 'conf-filter-req' },
        response: { status: 'completed', output_text: 'ok', usage: { input_tokens: 500, output_tokens: 50 } },
        statusCode: 200,
        durationMs: 600,
        transportStarted: true,
        context: { stage: 'conference-filter', paperId: 'conference:icassp:2026:icassp-arnumber:100' },
        at: `${targetDate}T10:00:00+08:00`
    }, { directory: usageDir });

    recordLlmUsage({
        protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor',
        request: { input: 'conf-reader-req' },
        response: { status: 'completed', output_text: 'ok', usage: { input_tokens: 2000, output_tokens: 400 } },
        statusCode: 200,
        durationMs: 2400,
        transportStarted: true,
        context: { stage: 'apiReaderArticle', paperId: 'conference:icassp:2026:icassp-arnumber:100' },
        at: `${targetDate}T10:05:00+08:00`
    }, { directory: usageDir });

    recordLlmUsage({
        protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor',
        request: { input: 'history-req' },
        response: { status: 'completed', output_text: 'ok', usage: { input_tokens: 800, output_tokens: 100 } },
        statusCode: 200,
        durationMs: 900,
        transportStarted: true,
        context: { stage: 'historical-rewrite', paperId: '2408.00001' },
        at: `${targetDate}T11:00:00+08:00`
    }, { directory: usageDir });

    const allLoaded = scorecard.loadEventsForDates(usageDir, [targetDate], { fast: true });
    assert.equal(allLoaded.events.length, 4);

    const dailyLoaded = scorecard.loadEventsForDates(usageDir, [targetDate], { fast: true, workflow: 'daily' });
    assert.equal(dailyLoaded.events.length, 1);
    assert.equal(dailyLoaded.events[0].paperId, '2611.10001');

    const confLoaded = scorecard.loadEventsForDates(usageDir, [targetDate], { fast: true, workflow: 'conference' });
    assert.equal(confLoaded.events.length, 2);
    assert.ok(confLoaded.events.every(ev => ev.paperId.startsWith('conference:')));

    const histLoaded = scorecard.loadEventsForDates(usageDir, [targetDate], { fast: true, workflow: 'history' });
    assert.equal(histLoaded.events.length, 1);
    assert.equal(histLoaded.events[0].stage, 'historical-rewrite');

    const confCard = scorecard.buildScorecard(confLoaded.events, {
        dates: [targetDate],
        source: confLoaded.source,
        workflow: 'conference'
    });
    assert.equal(confCard.workflow, 'conference');
    assert.equal(confCard.totals.requests, 2);
    assert.equal(confCard.totals.inputTokens, 2500);
    const text = scorecard.formatTextScorecard(confCard);
    assert.match(text, /workflow=conference/);
});

function makeUsageEvent(overrides = {}) {
    const id = overrides.eventId || `ev-${Math.random().toString(16).slice(2)}-${Date.now()}`;
    return {
        ...usageEventHeader(),
        kind: 'request',
        eventId: id,
        at: '2026-11-26T09:00:00+08:00',
        protocol: 'openai_responses',
        model: 'muse-spark-1.3-contributor',
        stage: 'primaryAnalysis',
        paperId: '2611.20001',
        outcome: 'completed',
        statusCode: 200,
        durationMs: 1000,
        transportStarted: true,
        usage: {
            status: 'reported',
            inputTokens: 1000,
            cachedInputTokens: 500,
            outputTokens: 200,
            reasoningTokens: 80
        },
        ...overrides
    };
}

function writeDailyIndexLines(usageDir, date, lines) {
    const dailyDir = path.join(path.dirname(usageDir), `${path.basename(usageDir)}-daily`);
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(path.join(dailyDir, `${date}.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    return path.join(dailyDir, `${date}.jsonl`);
}

function writeUsageJsonFile(dir, name, obj, mtimeDate = null) {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
    if (mtimeDate) {
        fs.utimesSync(filePath, mtimeDate, mtimeDate);
    }
    return filePath;
}

test('digest-scorecard: --fast vs default vs --canonical loading, dedup, and old-mtime flat-root recovery', t => {
    const dir = makeTempDir('pd-scorecard-modes-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageDir = path.join(dir, 'llm-usage');
    const date = '2026-11-26';

    const evIndex = makeUsageEvent({ eventId: 'ev-index-1', paperId: '2611.30001', at: `${date}T09:00:00+08:00` });
    const evShard = makeUsageEvent({ eventId: 'ev-shard-1', paperId: '2611.30002', at: `${date}T10:00:00+08:00` });
    const evFlatRecent = makeUsageEvent({ eventId: 'ev-flat-recent', paperId: '2611.30003', at: `${date}T11:00:00+08:00` });
    const evFlatOldMtime = makeUsageEvent({ eventId: 'ev-flat-old-mtime', paperId: '2611.30004', at: `${date}T12:00:00+08:00` });

    // Daily index has evIndex (and a duplicate of evIndex); flat root has evIndex (dup), evFlatRecent (in-window mtime), evFlatOldMtime (stale mtime)
    writeDailyIndexLines(usageDir, date, [JSON.stringify(evIndex), JSON.stringify(evIndex)]);
    writeUsageJsonFile(usageDir, 'dup-index.json', evIndex, new Date(`${date}T09:05:00+08:00`));
    writeUsageJsonFile(usageDir, 'flat-recent.json', evFlatRecent, new Date(`${date}T11:05:00+08:00`));
    writeUsageJsonFile(usageDir, 'flat-old-mtime.json', evFlatOldMtime, new Date('2025-01-01T00:00:00Z'));

    // 1) --fast reads ONLY daily index (+ optional date shard), never scans flat root
    const fastOnlyIdx = scorecard.loadEventsForDates(usageDir, [date], { fast: true });
    assert.equal(fastOnlyIdx.source, 'daily-index-fast');
    assert.deepEqual(fastOnlyIdx.events.map(e => e.eventId), ['ev-index-1']);

    // 2) Default mode with small flat root (<= FLAT_SCAN_SKIP_THRESHOLD) merges daily index + mtime-filtered flat root
    const defaultMerged = scorecard.loadEventsForDates(usageDir, [date], {});
    assert.equal(defaultMerged.source, 'daily-index+usage-dir');
    assert.deepEqual(
        defaultMerged.events.map(e => e.eventId).sort(),
        ['ev-flat-recent', 'ev-index-1']
    );

    // 3) --canonical ignores daily index and ignores mtime filter on flat root, recovering stale-mtime files too
    const canonicalAll = scorecard.loadEventsForDates(usageDir, [date], { canonical: true });
    assert.equal(canonicalAll.source, 'canonical-usage-dir');
    assert.deepEqual(
        canonicalAll.events.map(e => e.eventId).sort(),
        ['ev-flat-old-mtime', 'ev-flat-recent', 'ev-index-1']
    );

    // 4) --canonical overrides --fast when both flags are passed
    const bothFlags = scorecard.loadEventsForDates(usageDir, [date], { fast: true, canonical: true });
    assert.equal(bothFlags.source, 'canonical-usage-dir');
    assert.equal(bothFlags.events.length, 3);

    // 5) Adding date shard subdir changes --fast source to daily-index+date-shard-fast and includes shard event
    writeUsageJsonFile(path.join(usageDir, date), 'shard-1.json', evShard);
    const fastWithShard = scorecard.loadEventsForDates(usageDir, [date], { fast: true });
    assert.equal(fastWithShard.source, 'daily-index+date-shard-fast');
    assert.deepEqual(
        fastWithShard.events.map(e => e.eventId).sort(),
        ['ev-index-1', 'ev-shard-1']
    );

    // 6) --canonical also scans date shard subdir alongside flat root
    const canonicalWithShard = scorecard.loadEventsForDates(usageDir, [date], { canonical: true });
    assert.equal(canonicalWithShard.source, 'canonical-usage-dir');
    assert.deepEqual(
        canonicalWithShard.events.map(e => e.eventId).sort(),
        ['ev-flat-old-mtime', 'ev-flat-recent', 'ev-index-1', 'ev-shard-1']
    );

    // 7) --fast on empty directory returns empty-fast
    const emptyUsageDir = path.join(dir, 'empty-usage');
    fs.mkdirSync(emptyUsageDir, { recursive: true });
    const fastEmpty = scorecard.loadEventsForDates(emptyUsageDir, [date], { fast: true });
    assert.equal(fastEmpty.source, 'empty-fast');
    assert.deepEqual(fastEmpty.events, []);
});

test('digest-scorecard: FLAT_SCAN_SKIP_THRESHOLD skips huge flat root when daily index covers date unless --canonical', t => {
    const dir = makeTempDir('pd-scorecard-threshold-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageDir = path.join(dir, 'llm-usage');
    const date = '2026-11-26';

    const evIndex = makeUsageEvent({ eventId: 'ev-indexed', at: `${date}T09:00:00+08:00` });
    const evFlatOnly = makeUsageEvent({ eventId: 'ev-flat-only', at: `${date}T10:00:00+08:00` });
    writeDailyIndexLines(usageDir, date, [JSON.stringify(evIndex)]);
    writeUsageJsonFile(usageDir, 'flat-only.json', evFlatOnly, new Date(`${date}T10:05:00+08:00`));

    // Simulate > 5000 entries in flat root via mocked fs.opendirSync (avoids creating 5001 files on disk)
    const realOpendirSync = fs.opendirSync;
    let closeCalls = 0;
    let simulatedCount = 5001;
    t.mock.method(fs, 'opendirSync', target => {
        if (path.resolve(String(target)) !== path.resolve(usageDir)) {
            return realOpendirSync.call(fs, target);
        }
        let emitted = 0;
        return {
            readSync() {
                if (emitted < simulatedCount) {
                    emitted += 1;
                    return { name: `entry-${emitted}.json` };
                }
                return null;
            },
            closeSync() {
                closeCalls += 1;
            }
        };
    });

    // Above threshold (5001 > 5000): default mode skips flat root scan and stops after 5001 reads
    const skipped = scorecard.loadEventsForDates(usageDir, [date], {});
    assert.equal(skipped.source, 'daily-index');
    assert.deepEqual(skipped.events.map(e => e.eventId), ['ev-indexed']);
    assert.equal(closeCalls, 1);

    // At threshold (5000 <= 5000): default mode still merges small flat root
    simulatedCount = 5000;
    const merged = scorecard.loadEventsForDates(usageDir, [date], {});
    assert.equal(merged.source, 'daily-index+usage-dir');
    assert.deepEqual(merged.events.map(e => e.eventId).sort(), ['ev-flat-only', 'ev-indexed']);
    assert.equal(closeCalls, 2);

    // Above threshold + --canonical: ignores daily index and forces full flat-root scan
    simulatedCount = 5001;
    const forcedCanonical = scorecard.loadEventsForDates(usageDir, [date], { canonical: true });
    assert.equal(forcedCanonical.source, 'canonical-usage-dir');
    assert.deepEqual(forcedCanonical.events.map(e => e.eventId), ['ev-flat-only']);
    assert.equal(closeCalls, 2);
});

test('digest-scorecard: --batch-date cross-day Beijing window filters explicit batchDate and legacy fallback', t => {
    const dir = makeTempDir('pd-scorecard-batch-date-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageDir = path.join(dir, 'llm-usage');

    // parseArgs + resolveTargetDates expands --batch-date to [D, D+1]
    const parsed = scorecard.parseArgs(['--batch-date', '2026-11-26']);
    assert.equal(parsed.batchDate, '2026-11-26');
    assert.equal(parsed.date, '2026-11-26');
    assert.deepEqual(scorecard.resolveTargetDates(parsed), ['2026-11-26', '2026-11-27']);
    assert.deepEqual(
        scorecard.resolveTargetDates({ batchDate: '2026-11-30' }),
        ['2026-11-30', '2026-12-01']
    );
    assert.throws(() => scorecard.parseArgs(['--batch-date', '2026-02-30']), /--batch-date 必须是有效的北京日期/);

    // Explicit --date outside [D, D+1] is also included in targetDates when --days is omitted
    assert.deepEqual(
        scorecard.resolveTargetDates({ batchDate: '2026-11-26', date: '2026-11-28' }),
        ['2026-11-26', '2026-11-27', '2026-11-28']
    );

    const evSameDay = makeUsageEvent({
        eventId: 'ev-b1', batchDate: '2026-11-26', at: '2026-11-26T23:45:00+08:00'
    });
    const evCrossMidnight = makeUsageEvent({
        eventId: 'ev-b2', batchDate: '2026-11-26', at: '2026-11-27T01:15:00+08:00'
    });
    const evNextDayBatch = makeUsageEvent({
        eventId: 'ev-b3', batchDate: '2026-11-27', at: '2026-11-27T02:00:00+08:00'
    });
    const evLegacySameDay = makeUsageEvent({
        eventId: 'ev-legacy-26', at: '2026-11-26T15:00:00+08:00'
    });
    const evLegacyNextDay = makeUsageEvent({
        eventId: 'ev-legacy-27', at: '2026-11-27T08:00:00+08:00'
    });

    writeDailyIndexLines(usageDir, '2026-11-26', [
        JSON.stringify(evSameDay),
        JSON.stringify(evLegacySameDay)
    ]);
    writeDailyIndexLines(usageDir, '2026-11-27', [
        JSON.stringify(evCrossMidnight),
        JSON.stringify(evNextDayBatch),
        JSON.stringify(evLegacyNextDay)
    ]);

    const dates = scorecard.resolveTargetDates(parsed);
    const loaded = scorecard.loadEventsForDates(usageDir, dates, { fast: true, batchDate: '2026-11-26' });
    assert.deepEqual(
        loaded.events.map(e => e.eventId).sort(),
        ['ev-b1', 'ev-b2', 'ev-legacy-26']
    );
});

test('digest-scorecard: --days resolves multi-day windows, rejects out-of-range values, and aggregates byDate', t => {
    const dir = makeTempDir('pd-scorecard-days-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageDir = path.join(dir, 'llm-usage');

    assert.deepEqual(
        scorecard.resolveTargetDates(scorecard.parseArgs(['--date', '2026-11-27', '--days', '3'])),
        ['2026-11-25', '2026-11-26', '2026-11-27']
    );
    assert.deepEqual(
        scorecard.resolveTargetDates({ date: '2026-03-02', days: 3 }),
        ['2026-02-28', '2026-03-01', '2026-03-02']
    );
    for (const badDays of [0, -1, 91, 1.5, Number.NaN]) {
        assert.throws(
            () => scorecard.resolveTargetDates({ date: '2026-11-27', days: badDays }),
            /--days 必须是 1–90 之间的整数/
        );
    }
    assert.throws(() => scorecard.resolveTargetDates({ date: '2026-02-30', days: 1 }), /--date 必须是有效的北京日期/);

    writeDailyIndexLines(usageDir, '2026-11-25', [
        JSON.stringify(makeUsageEvent({ eventId: 'd25-1', at: '2026-11-25T10:00:00+08:00', durationMs: 500 }))
    ]);
    writeDailyIndexLines(usageDir, '2026-11-26', []); // readable 0-line index
    writeDailyIndexLines(usageDir, '2026-11-27', [
        JSON.stringify(makeUsageEvent({ eventId: 'd27-1', at: '2026-11-27T10:00:00+08:00', durationMs: 1500 })),
        JSON.stringify(makeUsageEvent({ eventId: 'd27-2', at: '2026-11-27T11:00:00+08:00', durationMs: 2500 }))
    ]);

    const dates = ['2026-11-25', '2026-11-26', '2026-11-27'];
    const loaded = scorecard.loadEventsForDates(usageDir, dates, { fast: true });
    const card = scorecard.buildScorecard(loaded.events, { dates, source: loaded.source });
    assert.equal(card.totals.requests, 3);
    assert.deepEqual(Object.keys(card.byDate), ['2026-11-25', '2026-11-27']);
    assert.equal(card.byDate['2026-11-25'].requests, 1);
    assert.equal(card.byDate['2026-11-27'].requests, 2);
    const text = scorecard.formatTextScorecard(card);
    assert.match(text, /2026-11-25 ~ 2026-11-27/);
});

test('digest-scorecard: malformed JSONL lines, wrong-kind records, wrong-date entries, and duplicate IDs are safely skipped', t => {
    const dir = makeTempDir('pd-scorecard-malformed-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const usageDir = path.join(dir, 'llm-usage');
    const date = '2026-11-26';

    const valid1 = makeUsageEvent({ eventId: 'valid-1', at: `${date}T08:00:00+08:00` });
    const valid2 = makeUsageEvent({ eventId: 'valid-2', at: `${date}T09:00:00+08:00` });
    const wrongKind = makeUsageEvent({ eventId: 'started-only', kind: 'request_started', at: `${date}T08:30:00+08:00` });
    const wrongDate = makeUsageEvent({ eventId: 'other-day', at: '2026-11-25T23:59:59+08:00' });
    const wrongContract = { contract: 'unrelated-v1', kind: 'request', eventId: 'bad-contract', at: `${date}T08:00:00+08:00` };

    writeDailyIndexLines(usageDir, date, [
        '',
        '   ',
        '{truncated json line without closing brace',
        'null',
        '42',
        '"plain-string"',
        JSON.stringify(wrongKind),
        JSON.stringify(wrongDate),
        JSON.stringify(wrongContract),
        JSON.stringify(valid1),
        JSON.stringify(valid1), // duplicate eventId must be deduped
        '{corrupt trailing line',
        JSON.stringify(valid2)
    ]);

    const loaded = scorecard.loadEventsForDates(usageDir, [date], { fast: true });
    assert.equal(loaded.source, 'daily-index-fast');
    assert.deepEqual(loaded.events.map(e => e.eventId), ['valid-1', 'valid-2']);

    // Symlink usageDir must be rejected
    const realTarget = path.join(dir, 'real-usage');
    fs.mkdirSync(realTarget, { recursive: true });
    const symlinkUsage = path.join(dir, 'symlink-usage');
    fs.symlinkSync(realTarget, symlinkUsage);
    assert.throws(
        () => scorecard.loadEventsForDates(symlinkUsage, [date], {}),
        /用量目录必须是真实目录，不能是符号链接/
    );
});

test('digest-scorecard: acct#1..N anonymization hides raw accountId fingerprints and sorts descending by volume', () => {
    const acctHigh = 'a'.repeat(64);
    const acctMidLower = 'b'.repeat(64);
    const acctMidUpper = 'B'.repeat(64); // case-insensitive merge with acctMidLower
    const acctLow = 'c'.repeat(64);

    const events = [
        // acctHigh: 4 requests
        makeUsageEvent({ eventId: 'a1', accountId: acctHigh, outcome: 'completed', durationMs: 1000 }),
        makeUsageEvent({ eventId: 'a2', accountId: acctHigh, outcome: 'completed', durationMs: 2000 }),
        makeUsageEvent({ eventId: 'a3', accountId: acctHigh, outcome: 'transport_error', errorCode: 'ECONNRESET', durationMs: 3000 }),
        makeUsageEvent({ eventId: 'a4', accountId: acctHigh, outcome: 'transport_error', errorCode: 'ConnectionResetError', durationMs: 4000 }),
        // acctMid: 2 requests (mixed case hex -> same account)
        makeUsageEvent({ eventId: 'b1', accountId: acctMidLower, outcome: 'incomplete', durationMs: 5000 }),
        makeUsageEvent({ eventId: 'b2', accountId: acctMidUpper, outcome: 'http_error', statusCode: 429, durationMs: 6000 }),
        // acctLow: 1 request
        makeUsageEvent({ eventId: 'c1', accountId: acctLow, outcome: 'provider_error', durationMs: 7000 }),
        // non-64-hex / missing accountId must be ignored in observedAccountDistribution
        makeUsageEvent({
            eventId: 'x1',
            accountId: 'not-a-valid-sha256',
            transportStarted: false,
            outcome: 'blocked_before_transport',
            durationMs: 0
        }),
        makeUsageEvent({ eventId: 'x2', accountId: null, outcome: 'completed', durationMs: 8000 })
    ];

    const card = scorecard.buildScorecard(events, { dates: ['2026-11-26'], source: 'daily-index-fast' });
    assert.deepEqual(card.observedAccountDistribution, {
        'acct#1': 4,
        'acct#2': 2,
        'acct#3': 1
    });
    assert.equal(card.totals.requests, 9);
    assert.equal(card.totals.completed, 3);
    assert.equal(card.totals.incomplete, 1);
    assert.equal(card.totals.transportErrors, 2);
    assert.equal(card.totals.econnresetErrors, 2);
    assert.equal(card.totals.httpErrors, 1);
    assert.equal(card.totals.providerErrors, 1);
    assert.equal(card.totals.blockedBeforeTransport, 1);
    assert.equal(card.totals.cacheHitRatePct, 50);
    assert.equal(card.totals.reasoningSharePct, 40);
    assert.equal(card.totals.p50DurationMs, 4000);
    assert.equal(card.totals.p95DurationMs, 8000);

    const serialized = JSON.stringify(card);
    const formatted = scorecard.formatTextScorecard(card);
    for (const rawId of [acctHigh, acctMidLower, acctMidUpper, acctLow, 'not-a-valid-sha256']) {
        assert.equal(serialized.includes(rawId), false, `JSON scorecard leaked raw accountId ${rawId}`);
        assert.equal(formatted.includes(rawId), false, `Text scorecard leaked raw accountId ${rawId}`);
    }
    assert.match(formatted, /匿名账号分布: acct#1=4, acct#2=2, acct#3=1/);
});

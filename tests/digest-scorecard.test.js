'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recordLlmUsage } = require('../scripts/lib/llm-usage.js');
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

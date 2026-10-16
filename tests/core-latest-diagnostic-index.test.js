'use strict';
// Isolated diagnostic-file tests only. No entry below signs an analysis stage,
// declares an article successful, or calls a model/network service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const diagnostics = require('../scripts/lib/reader-request-diagnostics');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const inputAnalysis = 'diagnostic-index-only input, not an article';
const sourceText = 'diagnostic-index-only source, not publication evidence';
const evidenceText = 'diagnostic-index-only evidence';
const identity = { paperId: 'conference:unit:2026:conference-paper-id:one',
    sourceTextSha256: sha(sourceText), inputAnalysisSha256: sha(inputAnalysis),
    evidenceSha256: sha(evidenceText), stageFingerprint: 'a'.repeat(64) };
function isolated(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'latest-core-index-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function request(root, at, failed = false) {
    const OriginalDate = global.Date;
    let record;
    try {
        global.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [at])); } };
        record = diagnostics.beginCoreSummaryDiagnostic(root, { identity, prompt: 'diagnostic-only test prompt',
            inputAnalysis, sourceText, evidenceText });
    } finally { global.Date = OriginalDate; }
    if (failed) {
        diagnostics.saveCoreSummaryDisposition(record, { status: 'request_failed', error: 'isolated transport failure' });
    } else {
        const raw = 'diagnostic-only rejected response, never a qualified article';
        diagnostics.saveCoreSummaryResponse(record, raw);
        diagnostics.saveCoreSummaryDisposition(record, { status: 'rejected', outputTextSha256: sha(raw) });
    }
    return record;
}
test('early failed request does not block the unique latest real response chain', t => {
    const root = isolated(t);
    request(root, '2026-10-16T00:00:01.000Z', true);
    const latest = request(root, '2026-10-16T00:00:02.000Z');
    assert.equal(diagnostics.latestCoreSummaryDiagnosticId(root, identity), latest.id);
    assert.throws(() => diagnostics.latestCoreSummaryDiagnosticId(root, { ...identity, sourceTextSha256: 'b'.repeat(64) }));
});
test('latest failed or missing-response request cannot fall back to an earlier response', t => {
    const root = isolated(t);
    request(root, '2026-10-16T00:00:01.000Z');
    const latest = request(root, '2026-10-16T00:00:02.000Z', true);
    assert.throws(() => diagnostics.latestCoreSummaryDiagnosticId(root, identity));
    const response = path.join(latest.directory, latest.id + '.response.json');
    assert.equal(fs.existsSync(response), false);
});
test('same-millisecond latest request ambiguity is rejected before choosing any response', t => {
    const root = isolated(t);
    request(root, '2026-10-16T00:00:02.000Z'); request(root, '2026-10-16T00:00:02.000Z');
    assert.throws(() => diagnostics.latestCoreSummaryDiagnosticId(root, identity), /唯一最新/);
});
test('response tampering cannot be skipped by selecting an older valid response', t => {
    const root = isolated(t); request(root, '2026-10-16T00:00:01.000Z');
    const latest = request(root, '2026-10-16T00:00:02.000Z');
    const file = path.join(latest.directory, latest.id + '.response.json');
    const value = JSON.parse(fs.readFileSync(file)); value.rawResponse += ' changed'; fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => diagnostics.latestCoreSummaryDiagnosticId(root, identity));
});
test('request-set changes during selection are rejected', t => {
    const root = isolated(t), latest = request(root, '2026-10-16T00:00:02.000Z');
    const original = fs.readdirSync; let reads = 0;
    fs.readdirSync = function (filename, ...args) {
        if (filename === latest.directory && ++reads === 2) fs.copyFileSync(
            path.join(latest.directory, latest.id + '.request.json'),
            path.join(latest.directory, '00000000-0000-4000-8000-000000000001.request.json'));
        return original.call(fs, filename, ...args);
    };
    try { assert.throws(() => diagnostics.latestCoreSummaryDiagnosticId(root, identity), /集合/); }
    finally { fs.readdirSync = original; }
});
test('default daily/history repair never scans; the new conference flag refuses nonconference identities', async t => {
    const deep = require('../scripts/deep-analyzer');
    const baseline = require('./valid-analysis-fixture').validAnalysisText();
    const source = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    let scans = 0;
    t.mock.method(diagnostics, 'latestCoreSummaryDiagnosticId', () => { scans++; throw Error('must not scan'); });
    for (const paper of [{ arxivId: '2610.90009' }, { arxivId: '2610.90010', analysisSource: 'direct_rewrite' }]) {
        assert.equal(await deep.repairCoreSummarySection(paper, baseline, source, source, {
            callModelFn: () => assert.fail('default valid repair cannot call a model') }), baseline);
        await assert.rejects(deep.repairCoreSummarySection(paper, baseline, source, source, {
            replayLatestCoreSummaryDiagnostic: true, callModelFn: () => assert.fail('nonconference cannot call a model') }), /只允许当前会议认证来源/);
    }
    assert.equal(scans, 0);
});
test('missing original chain under explicit conference replay is nonretryable before any request', async t => {
    const deep = require('../scripts/deep-analyzer');
    const context = require('../scripts/lib/conference-analysis-context');
    const baseline = require('./valid-analysis-fixture').validAnalysisText();
    const source = 'Experiment results on the public test set report baseline WER 12.4% and our method WER 9.8%.';
    const executionId = '77777777-7777-4777-8777-777777777777';
    const executionDir = path.join(isolated(t), executionId); fs.mkdirSync(executionDir);
    const paperId = 'conference:unit:2026:conference-paper-id:one';
    let calls = 0;
    // Scope-shape negative fixture only; no PDF authority or qualification is issued.
    await assert.rejects(context.withConferenceAnalysisSource({ executionId, executionDir, paperId,
        sourceDetails: { source: 'conference_pdf_text', sourceId: paperId, text: source } }, () =>
        deep.repairCoreSummarySection({ id: paperId }, baseline, source, source, {
            replayLatestCoreSummaryDiagnostic: true,
            callModelFn: () => { calls++; throw Error('forbidden request'); }
        })), error => error.retryable === false);
    assert.equal(calls, 0);
});

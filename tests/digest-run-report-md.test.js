'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatMarkdownDailyReport, formatDigestRunSummary } = require('../scripts/digest-run-report');

test('Markdown 日报包含状态、OID、视觉与明细', () => {
    const text = formatMarkdownDailyReport('2026-10-21', {
        overallStatus: 'complete', issueCount: 0, remoteOidVerified: true,
        errors: [], blog: { remoteOidVerified: true },
        visuals: { status: 'waived', waived: true }
    }, '抓取 完成\n分析 34/34');
    assert.match(text, /音频研究日报 2026-10-21/);
    assert.match(text, /状态：complete/);
    assert.match(text, /远端 OID 已验证：是/);
    assert.match(text, /视觉：已豁免/);
    assert.match(text, /```json/);
});

test('Markdown 日报把未通过的视觉状态翻成人话，不直接暴露内部枚举', () => {
    const text = formatMarkdownDailyReport('2026-10-21', {
        overallStatus: 'incomplete', errors: ['视觉未完成'], blog: { remoteOidVerified: false },
        visuals: { status: 'incomplete' }
    }, '');
    assert.match(text, /视觉：未完成/);
    assert.doesNotMatch(text, /视觉：incomplete/);
});

test('状态摘要把已豁免的长图和封面显示为已豁免而不是未完成', () => {
    const report = {
        batchDate: '2026-10-21', overallStatus: 'complete', errors: [],
        fetch: { complete: true, rawCandidateCount: 10 },
        filter: { complete: true, selectedCount: 5, totalCandidates: 10, pendingDecisions: 0 },
        analysis: { complete: true, successful: 5, total: 5, failed: 0 },
        blog: { complete: true, strictReview: true, remoteOidVerified: true, publicationVerified: true },
        visuals: { waived: true, gateComplete: true, status: 'waived', complete: 0, total: 0, pending: 0, failed: 0 },
        cover: { waived: true, complete: true, status: 'waived' },
        readProblems: []
    };
    const text = formatDigestRunSummary(report);
    assert.match(text, /长图 已豁免/);
    assert.match(text, /封面 已豁免/);
    assert.doesNotMatch(text, /长图 未完成/);
    assert.doesNotMatch(text, /封面 未完成/);
    assert.match(text, /状态=已豁免/);
});

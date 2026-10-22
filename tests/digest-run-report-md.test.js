'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatMarkdownDailyReport } = require('../scripts/digest-run-report');

test('Markdown 日报包含状态、OID、视觉与明细', () => {
    const text = formatMarkdownDailyReport('2026-10-21', {
        overallStatus: 'complete', issueCount: 0, remoteOidVerified: true,
        visuals: { status: 'waived' }
    }, '抓取 完成\n分析 34/34');
    assert.match(text, /论文速递日报 2026-10-21/);
    assert.match(text, /状态：complete/);
    assert.match(text, /远端 OID 已验证：是/);
    assert.match(text, /视觉：waived/);
    assert.match(text, /```json/);
});

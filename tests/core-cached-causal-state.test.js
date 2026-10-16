'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const os = require('node:os');
const c = require('../scripts/analysis-contract');
const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/core-paid-causal-forecast.json'), 'utf8'));
for (const item of f.cases) test(item.id, () => {
    const check = item.kind === 'chain' ? c.hasCachedCausalStateHandoff : c.hasOfflineOperationalBoundary;
    assert.equal(check(item.text), item.expect);
});
test('实际已付摘要与封存来源通过完整公共检查，不补写原响应', () => {
    assert.equal(c.validateCoreSummarySemanticContract('## 核心摘要\n' + f.summary, { sourceText: f.sourceText }), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-causal-replay-'));
    const file = path.join(dir, 'input.json');
    fs.writeFileSync(file, JSON.stringify({ summary: f.summary, sourceText: f.sourceText }), { mode: 0o600 });
    const fd = fs.openSync(file, 'r');
    try {
        const out = cp.execFileSync(process.execPath,
            [path.join(__dirname, '../scripts/lib/core-summary-semantic-replay-cli.js'), '3'],
            { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' });
        assert.deepEqual(JSON.parse(out), { issue: null });
    } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
});

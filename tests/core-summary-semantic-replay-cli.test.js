'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const realAudit = process.env.PD_CORE_SUMMARY_REPLAY_REAL_AUDIT;
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..'), cli = path.join(project, 'scripts/lib/core-summary-semantic-replay-cli.js');
const contract = require('../scripts/analysis-contract');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function execute(input, options = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'core-summary-semantic-cli-'));
    try {
        const file = path.join(root, 'input.json');
        fs.writeFileSync(file, typeof input === 'string' ? input : JSON.stringify(input), { mode: options.mode || 0o600 });
        if (options.size) fs.truncateSync(file, options.size);
        if (options.hardlink) fs.linkSync(file, path.join(root, 'alias.json'));
        let args = [cli, '3'];
        if (options.networkProbe) {
            const preload = path.join(root, 'probe.js');
            fs.writeFileSync(preload, `require(${JSON.stringify(path.join(project, 'scripts/analysis-contract'))}).validateCoreSummarySemanticContract = () => { require('node:https').request('https://example.com/'); return null; };`);
            args = ['-r', preload, ...args];
        }
        const fd = fs.openSync(file, 'r');
        try { const result = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe', fd], env: { ...process.env, ...(options.env || {}), VERIFY_PROJECT_DISABLE_FILE_LOGS: '1' }, timeout: 10000 });
            assert.ifError(result.error); return { status: result.status, value: JSON.parse(result.stdout) };
        } finally { fs.closeSync(fd); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('私有FD桥逐字复用Node语义结果，合格摘要和明确缺陷均不修改规则', () => {
    const summary = contract.extractSection(require('./valid-analysis-fixture').validAnalysisText(), '核心摘要');
    for (const input of [{ summary, sourceText: '' }, { summary: '本文效果很好。', sourceText: '' },
        { summary: summary.replace('在公开测试集的相同协议下，词错误率从 12.4% 降至 9.8%，指标方向和比较对象都能由原文结果核对。', ''),
            sourceText: 'On the public evaluation test set, WER improved from 12.4% to 9.8% compared with the baseline.' }]) {
        const expected = contract.validateCoreSummarySemanticContract('## 核心摘要\n' + input.summary, { sourceText: input.sourceText });
        const result = execute(input); assert.equal(result.status, 0); assert.deepEqual(result.value, { issue: expected });
    }
    assert.equal(execute({ summary, sourceText: '' }).value.issue, null);
    assert.equal(typeof execute({ summary: '本文效果很好。', sourceText: '' }).value.issue, 'string');
});
test('桥拒公开文件、硬链、16MiB超限、字段篡改、沙箱及实际网络调用', () => {
    const input = { summary: '本文效果很好。', sourceText: '' };
    for (const [value, options] of [[input, { mode: 0o644 }], [input, { hardlink: true }],
        [input, { size: 16 * 1024 * 1024 + 1 }], [{ ...input, approved: true }, {}],
        [{ summary: [], sourceText: '' }, {}], ['not JSON', {}], [input, { env: { CODEX_SANDBOX: 'seatbelt' } }],
        [input, { networkProbe: true }]]) {
        const result = execute(value, options); assert.equal(result.status, 1); assert.equal(typeof result.value.issue, 'string');
    }
    assert.match(execute(input, { networkProbe: true }).value.issue, /forbids network access/);
});
test('真实11篇Python旧语义误拒摘要与当前Node source-bound规则完全一致，正式文件不改', { skip: !realAudit }, () => {
    const auditBytes = fs.readFileSync(realAudit), audit = JSON.parse(auditBytes);
    assert.equal(audit.length, 11);
    const file = path.join(project, 'data/current/deep-analysis-result.json'), before = fs.readFileSync(file);
    const formal = JSON.parse(before), sourceRoot = path.join(project, 'data/runtime/daily-fresh-source-runs', formal.dailyFreshSourceRun.runId, 'sources');
    for (const item of audit) {
        const sourceFile = path.join(sourceRoot, item.paperId.replace(/v\d+$/, ''), 'generation-000001/source.txt');
        const sourceBytes = fs.readFileSync(sourceFile), sourceText = sourceBytes.toString('utf8');
        const expected = contract.validateCoreSummarySemanticContract('## 核心摘要\n' + item.summary, { sourceText });
        const result = execute({ summary: item.summary, sourceText });
        assert.equal(result.status, 0, item.paperId); assert.deepEqual(result.value, { issue: expected }, item.paperId);
        assert.equal(expected, null, item.paperId);
        assert.equal(sha(fs.readFileSync(sourceFile)), sha(sourceBytes));
    }
    assert.equal(sha(fs.readFileSync(realAudit)), sha(auditBytes)); assert.equal(sha(fs.readFileSync(file)), sha(before));
});

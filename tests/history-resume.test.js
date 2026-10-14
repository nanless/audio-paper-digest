'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const resume = require('../scripts/history-resume.js');
const fresh = require('../scripts/lib/fresh-rewrite-run.js');

const RUN = '45b13a67-7797-406b-a73e-cafe7d91f669';

test('历史恢复只接受已存在运行的查询和分析，不开放创建或重新抓取来源', () => {
    for (const action of ['prepare', 'sources', 'promote', 'reset', 'patch', 'signed-patch']) {
        assert.throws(() => resume.parseArgs([action, '--run-id', RUN]), /用法/);
    }
    assert.throws(() => resume.parseArgs(['analyze', '--run-id', RUN, '--reset']), /Unknown/);
    assert.throws(() => resume.parseArgs(['analyze', '--run-id', RUN, '--date', '2026-10-15']), /不能更改日期/);
    assert.throws(() => resume.parseArgs(['status', '--run-id', RUN, '--ids', '2609.03586']), /Only analyze/);
    assert.deepEqual(resume.parseArgs(['analyze', '--run-id', RUN, '--ids', '2609.03586', '--concurrency', '2']), {
        action: 'analyze', runId: RUN, ids: ['2609.03586'], concurrency: 2
    });
});

test('现行计划继续恢复原控制协议，不能与旧运行参数混用', () => {
    const planFile = '/tmp/historical-direct-plan.json';
    const parsed = resume.parseArgs(['--plan', planFile, '--phase', 'analysis']);
    assert.equal(parsed.mode, 'direct');
    assert.equal(parsed.options.action, 'resume');
    assert.equal(parsed.options.planFile, planFile);
    assert.equal(parsed.options.phase, 'analysis');
    assert.throws(() => resume.parseArgs(['--plan', planFile, '--phase', 'analysis', '--run-id', RUN]), /用法/);
    assert.throws(() => resume.parseArgs(['--plan', planFile, '--phase', 'sources']), /用法/);
});

test('缺失运行在分析及写入前停止，不创建目录或清零失败候选', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-resume-missing-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const witness = path.join(root, 'preserved-failed-candidate.json');
    const bytes = Buffer.from('{"status":"failed","attempts":3,"transportFailures":2,"paid":true}\n');
    fs.writeFileSync(witness, bytes, { mode: 0o600 });
    let requests = 0;
    await assert.rejects(() => resume.main(['analyze', '--run-id', RUN], {
        config: { FILES: { freshRewriteRunsDir: root } },
        runner: { loadRun: fresh.loadRun, analyzeRewrite: () => { requests++; }, rewriteStatus: () => { requests++; } }
    }), /ENOENT/);
    assert.equal(requests, 0);
    assert.deepEqual(fs.readdirSync(root), ['preserved-failed-candidate.json']);
    assert.deepEqual(fs.readFileSync(witness), bytes);
});

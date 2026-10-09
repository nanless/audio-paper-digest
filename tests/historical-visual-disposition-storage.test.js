'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = require('../scripts/historical-direct-publication.js');
const api = require('../scripts/lib/historical-direct-publication.js');
const planner = require('../scripts/lib/historical-direct-rewrite-plan.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'visual-disposition-storage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const emptySha = planner.stableHash([]);
    const body = {
        contract: planner.CONTRACT, version: planner.VERSION,
        catalogFileSha256: 'a'.repeat(64),
        inventory: { ledgerSha256: 'b'.repeat(64), pageSetSha256: 'c'.repeat(64) },
        conferenceProjectionArtifactSha256: 'd'.repeat(64),
        queue: [], queueSha256: emptySha, projectedPages: [],
        dailyPrimaryArxivBindings: [], dailyPrimaryArxivBindingSetSha256: emptySha,
        dailyIcmlPosterBindings: [], dailyIcmlPosterBindingSetSha256: emptySha,
        dailyIcmlPosterRoutableBindings: [], dailyIcmlPosterRoutableBindingSetSha256: emptySha,
        icmlPosterAuthoritySha256: null,
        unprojectedCatalogEntries: [], unprojectedCatalogEntrySetSha256: emptySha,
        projectedPageSetSha256: emptySha,
        uncoveredFrozenPaperPages: [], uncoveredFrozenPaperPageSetSha256: emptySha,
        paperPageCoverage: {
            frozenPaperPages: 0, projectedPaperPages: 0, uncoveredFrozenPaperPages: 0,
            coverageComplete: true, byScope: [], uncoveredByIdentityHintStatus: []
        }
    };
    const plan = planner.normalizePlan({ ...body, planSha256: planner.stableHash(body) });
    const planFile = path.join(root, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
    const outputRoot = path.join(root, 'dispositions');
    const output = path.join(outputRoot, 'visual.json');
    const reason = '测试中用户明确限定为历史正文维护，视觉由独立流程处理。';
    const argv = ['visual-disposition', '--apply', '--plan-file', planFile,
        '--mode', 'excluded', '--reason', reason, '--output', output];
    const runtime = { config: { FILES: { historicalDirectVisualDispositionDir: outputRoot } } };
    return { root, plan, outputRoot, output, argv, runtime, reason,
        run: () => cli.main(argv, runtime) };
}
function storedValue(f, changes = {}) {
    return api.buildVisualDisposition({ plan: f.plan, mode: 'excluded', reason: f.reason,
        createdAt: '2026-09-01T00:00:00.000Z', ...changes });
}
function writeValue(filename, value) {
    fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

test('真实视觉处置入口短写失败不留下正式半文件，同命令可以重试', t => {
    const f = fixture(t);
    const original = fs.writeFileSync;
    const failure = Object.assign(new Error('模拟磁盘写入失败'), { code: 'EIO' });
    let injected = false;
    fs.writeFileSync = function (target, bytes, ...args) {
        if (typeof target === 'number' && !injected) {
            injected = true;
            fs.writeSync(target, Buffer.from(bytes).subarray(0, 7));
            throw failure;
        }
        return original.call(this, target, bytes, ...args);
    };
    try { assert.throws(f.run, error => error === failure); }
    finally { fs.writeFileSync = original; }
    assert.equal(injected, true);
    assert.equal(fs.existsSync(f.output), false);
    assert.deepEqual(fs.readdirSync(f.outputRoot), []);
    const saved = f.run();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')), saved);
});

test('真实视觉处置入口保留旧有效凭证的时间、字节和 inode，拒绝不同请求', t => {
    const f = fixture(t);
    fs.mkdirSync(f.outputRoot);
    const original = storedValue(f);
    writeValue(f.output, original);
    const before = fs.readFileSync(f.output);
    const identity = fs.statSync(f.output);
    assert.deepEqual(f.run(), original);
    assert.deepEqual(fs.readFileSync(f.output), before);
    assert.equal(fs.statSync(f.output).ino, identity.ino);
    assert.equal(fs.statSync(f.output).mtimeMs, identity.mtimeMs);
    for (const changed of [
        { plan: { planSha256: 'e'.repeat(64) } },
        { mode: 'waived' }, { scope: 'selected-sample-publication' },
        { reason: '另一项明确授权的范围声明，不能冒充本次请求。' }
    ]) {
        writeValue(f.output, storedValue(f, changed));
        const bytes = fs.readFileSync(f.output);
        assert.throws(f.run);
        assert.deepEqual(fs.readFileSync(f.output), bytes);
    }
});

test('真实视觉处置入口恢复已退出写者的双链接，不改变已保存凭证', t => {
    const f = fixture(t);
    const code = `
        const fs = require('node:fs');
        const cli = require(${JSON.stringify(require.resolve('../scripts/historical-direct-publication.js'))});
        const original = fs.linkSync;
        fs.linkSync = function (source, target) {
            original.call(this, source, target);
            if (target === ${JSON.stringify(f.output)}) process.kill(process.pid, 'SIGKILL');
        };
        cli.main(${JSON.stringify(f.argv)}, ${JSON.stringify(f.runtime)});
    `;
    const child = spawnSync(process.execPath, ['-e', code], { timeout: 10000, encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(fs.statSync(f.output).nlink, 2);
    const bytes = fs.readFileSync(f.output);
    const record = JSON.parse(bytes);
    const inode = fs.statSync(f.output).ino;
    assert.deepEqual(f.run(), record);
    assert.deepEqual(fs.readFileSync(f.output), bytes);
    assert.equal(fs.statSync(f.output).ino, inode);
    assert.equal(fs.statSync(f.output).nlink, 1);
    assert.deepEqual(fs.readdirSync(f.outputRoot), ['visual.json']);
});

test('视觉处置拒绝旧半文件及未知硬链接，不删除原文件', t => {
    const f = fixture(t);
    fs.mkdirSync(f.outputRoot);
    fs.writeFileSync(f.output, '{"contract":', { mode: 0o600 });
    assert.throws(f.run);
    assert.equal(fs.readFileSync(f.output, 'utf8'), '{"contract":');
    writeValue(f.output, storedValue(f));
    const unknown = path.join(f.outputRoot, 'unknown-link');
    fs.linkSync(f.output, unknown);
    const before = fs.readFileSync(f.output);
    assert.throws(f.run);
    assert.deepEqual(fs.readFileSync(f.output), before);
    assert.equal(fs.statSync(unknown).ino, fs.statSync(f.output).ino);
    assert.equal(fs.statSync(f.output).nlink, 2);
});

for (const sameRequest of [true, false]) {
    test(`真实视觉处置入口保留并发胜者，仅复用相同请求（${sameRequest}）`, t => {
        const f = fixture(t);
        const winner = storedValue(f, sameRequest ? {} : { mode: 'waived' });
        const original = fs.linkSync;
        let injected = false;
        fs.linkSync = function (source, target) {
            if (target === f.output && !injected) {
                injected = true;
                writeValue(target, winner);
            }
            return original.call(this, source, target);
        };
        try {
            if (sameRequest) assert.deepEqual(f.run(), winner);
            else assert.throws(f.run);
        } finally { fs.linkSync = original; }
        assert.equal(injected, true);
        assert.deepEqual(JSON.parse(fs.readFileSync(f.output, 'utf8')), winner);
        assert.deepEqual(fs.readdirSync(f.outputRoot), ['visual.json']);
    });
}

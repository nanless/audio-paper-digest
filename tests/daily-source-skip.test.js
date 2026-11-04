'use strict';
// 跳过的边界：只有“官方 PDF 全部候选地址 404”可以跳过，篇数受上限约束，
// 记录绑定本次来源运行且可重复读取；其他错误、超限、伪造证据都必须拒绝。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const skip = require('../scripts/lib/daily-source-skip.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-source-skip-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    return root;
}

function planFor(papers) {
    return daily.createDailyFreshSourcePlan({ batchDate: '2026-10-09', batchId: 'source-skip-test', papers });
}

function skipped(id) {
    return { arxivId: id, errorCode: 'ARXIV_PDF_NOT_FOUND', status: 404,
        message: `arXiv PDF ${id} download failed: HTTP 404` };
}

test('只识别官方 PDF 全部候选地址 404 的错误', () => {
    assert.equal(skip.isSkippableSourceError({ code: 'ARXIV_PDF_NOT_FOUND', status: 404 }), true);
    assert.equal(skip.isSkippableSourceError({ code: 'ARXIV_PDF_NOT_FOUND', status: 500 }), false);
    assert.equal(skip.isSkippableSourceError({ code: 'ECONNRESET', status: 404 }), false);
    assert.equal(skip.isSkippableSourceError(new Error('404')), false);
});

test('跳过上限默认两篇，并限制在 0 到 5 之间', () => {
    assert.equal(skip.resolveSkipLimit(undefined), 2);
    assert.equal(skip.resolveSkipLimit('0'), 0);
    assert.equal(skip.resolveSkipLimit('5'), 5);
    for (const value of ['6', '-1', '1.5', 'abc']) {
        assert.throws(() => skip.resolveSkipLimit(value), /0 到 5/);
    }
});

test('跳过记录绑定批次与运行，可重复读取且重写一致', t => {
    fixture(t);
    const plan = planFor([{ arxivId: '2610.82001' }, { arxivId: '2610.82002' }]);
    const record = skip.writeDailySourceSkips(plan, [skipped('2610.82001')]);
    assert.equal(record.count, 1);
    assert.equal(record.limit, 2);
    assert.equal(record.runId, plan.runId);
    const again = skip.writeDailySourceSkips(plan, [skipped('2610.82001')]);
    assert.deepEqual(again, record);
    assert.deepEqual(skip.readDailySourceSkips(plan), record);
    // 同一批次换一篇但内容不同，不能覆盖已保存的记录。
    assert.throws(() => skip.writeDailySourceSkips(plan, [skipped('2610.82002')]), /与本次结果不一致/);
});

test('拒绝非 404 证据、重复论文、超出上限和不在本次运行里的论文', t => {
    fixture(t);
    const plan = planFor([{ arxivId: '2610.82101' }, { arxivId: '2610.82102' },
        { arxivId: '2610.82103' }]);
    assert.throws(() => skip.writeDailySourceSkips(plan, [{ arxivId: '2610.82101',
        errorCode: 'ECONNRESET', status: 404, message: 'x' }]), /404/);
    assert.throws(() => skip.writeDailySourceSkips(plan,
        [skipped('2610.82101'), skipped('2610.82101')]), /重复/);
    assert.throws(() => skip.writeDailySourceSkips(plan,
        [skipped('2610.82101'), skipped('2610.82102'), skipped('2610.82103')]), /不能超过 2 篇/);
    assert.throws(() => skip.writeDailySourceSkips(plan, [skipped('2610.82999')]), /不在本次来源运行中/);
    assert.throws(() => skip.writeDailySourceSkips(plan, []), /至少需要一篇/);
});

test('读取时校验记录格式、上限和运行身份', t => {
    fixture(t);
    const plan = planFor([{ arxivId: '2610.82201' }]);
    const record = skip.writeDailySourceSkips(plan, [skipped('2610.82201')]);
    const file = path.join(plan.runDir, skip.FILENAME);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, count: 2 })}\n`);
    assert.throws(() => skip.readDailySourceSkips(plan), /篇数/);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, limit: 3 })}\n`);
    assert.throws(() => skip.readDailySourceSkips(plan), /上限/);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, runId: 'x' })}\n`);
    assert.throws(() => skip.readDailySourceSkips(plan), /运行 ID/);
    fs.writeFileSync(file, `${JSON.stringify({ ...record, extra: true })}\n`);
    assert.throws(() => skip.readDailySourceSkips(plan), /字段/);
    fs.writeFileSync(file, '{}\n');
    assert.throws(() => skip.readDailySourceSkips(plan), /格式声明无效/);
});

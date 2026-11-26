'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const operator = require('../scripts/lib/daily-reader-operator-correction');

test('大型人工收尾按完整原封存入选集计算十百分比，绝不超十五或接受虚增集合', async t => {
    // 批次级放宽只影响真实运行；这条测试断言默认公式，必须自己隔离环境变量。
    const savedLimit = process.env.PD_DAILY_CORRECTION_LIMIT;
    delete process.env.PD_DAILY_CORRECTION_LIMIT;
    t.after(() => {
        if (savedLimit === undefined) delete process.env.PD_DAILY_CORRECTION_LIMIT;
        else process.env.PD_DAILY_CORRECTION_LIMIT = savedLimit;
    });
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'operator-large-batch-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const fixture = size => {
        const papers = Array.from({ length: size }, (_, i) => ({ arxivId: `2610.${80000 + i}v1` }));
        const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-15',
            batchId: `synthetic-operator-quantity-${size}`, papers });
        return { plan, papers };
    };
    for (const [size, limit] of [[1, 10], [99, 10], [100, 10], [109, 10],
        [110, 11], [146, 14], [149, 14], [150, 15], [1000, 15]]) {
        const { plan, papers } = fixture(size);
        const original = fs.readFileSync(path.join(plan.runDir, 'run.json'));
        assert.equal(operator.largeBatchCorrectionLimit(plan, papers), limit);
        assert.equal(operator.largeBatchCorrectionLimit(plan, papers.slice().reverse()), limit);
        const filename = path.join(root, `oversized-${size}.json`);
        fs.writeFileSync(filename, JSON.stringify({ ...require('../scripts/lib/protocol-codec').recordHeader(operator.CONTRACT, operator.CONTRACT),
            runId: plan.runId, batchDate: plan.batchDate, authorization: 'Synthetic bound test.',
            correctionFiles: Array.from({ length: limit + 1 }, (_, i) => path.join(root, `absent-${i}.json`))
        }), { mode: 0o600 });
        await assert.rejects(operator.withCorrections(filename, plan, papers,
            () => assert.fail('Over-limit batch reached correction processing')), /bounded final failed-set limit/);
        assert.deepEqual(fs.readFileSync(path.join(plan.runDir, 'run.json')), original);
    }
    const { plan, papers } = fixture(146);
    for (const rows of [papers.slice(0, 110), [...papers, papers[0]],
        [...papers.slice(0, -1), papers[0]], [...papers.slice(0, -1), { arxivId: '2610.99999' }]])
        assert.throws(() => operator.largeBatchCorrectionLimit(plan, rows), /complete original sealed batch/);
    const inflated = structuredClone(plan);
    inflated.paperIds.push('2610.99999');
    assert.throws(() => operator.largeBatchCorrectionLimit(inflated,
        [...papers, { arxivId: '2610.99999' }]), /清单的内容已变化/);
    const manifest = path.join(plan.runDir, 'run.json'), bytes = fs.readFileSync(manifest);
    fs.writeFileSync(manifest, bytes.toString().replace('synthetic-operator-quantity-146', 'tampered-operator-quantity-146'));
    assert.throws(() => operator.largeBatchCorrectionLimit(plan, papers), /清单的内容已变化/);
    fs.writeFileSync(manifest, bytes);
});

test('用户明确授权的 PD_DAILY_CORRECTION_LIMIT 只能把名额抬高到硬上限 15', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'operator-limit-override-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        delete process.env.PD_DAILY_CORRECTION_LIMIT;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const papers = Array.from({ length: 43 }, (_, i) => ({ arxivId: `2610.${81000 + i}v1` }));
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-11-09',
        batchId: 'synthetic-operator-limit-override', papers });
    delete process.env.PD_DAILY_CORRECTION_LIMIT;
    assert.equal(operator.largeBatchCorrectionLimit(plan, papers), 10);
    process.env.PD_DAILY_CORRECTION_LIMIT = '15';
    assert.equal(operator.largeBatchCorrectionLimit(plan, papers), 15);
    process.env.PD_DAILY_CORRECTION_LIMIT = '12';
    assert.equal(operator.largeBatchCorrectionLimit(plan, papers), 12);
    for (const invalid of ['0', '16', '1.5', 'abc']) {
        process.env.PD_DAILY_CORRECTION_LIMIT = invalid;
        assert.throws(() => operator.largeBatchCorrectionLimit(plan, papers), /PD_DAILY_CORRECTION_LIMIT/);
    }
});

test('CP-P1-9: largeBatchCorrectionLimit 扣除 daily-source-skips.json 中的 PDF 404 跳过论文', t => {
    const savedLimit = process.env.PD_DAILY_CORRECTION_LIMIT;
    delete process.env.PD_DAILY_CORRECTION_LIMIT;
    t.after(() => {
        if (savedLimit === undefined) delete process.env.PD_DAILY_CORRECTION_LIMIT;
        else process.env.PD_DAILY_CORRECTION_LIMIT = savedLimit;
    });
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'operator-skip-batch-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const dailySourceSkip = require('../scripts/lib/daily-source-skip');
    const allPapers = Array.from({ length: 121 }, (_, i) => ({ arxivId: `2611.${70000 + i}v1` }));
    const plan = daily.createDailyFreshSourcePlan({
        batchDate: '2026-11-26',
        batchId: 'synthetic-operator-skip-121',
        papers: allPapers
    });
    dailySourceSkip.writeDailySourceSkips(plan, [{
        arxivId: '2611.70000',
        errorCode: 'ARXIV_PDF_NOT_FOUND',
        status: 404,
        message: 'arXiv PDF 2611.70000 download failed: HTTP 404'
    }], { limit: dailySourceSkip.MAX_LIMIT });

    const remainingPapers = allPapers.slice(1); // 120 papers
    assert.equal(operator.largeBatchCorrectionLimit(plan, remainingPapers), 12);
    // Passing the full 121 including the skipped paper must fail exact set equality.
    assert.throws(() => operator.largeBatchCorrectionLimit(plan, allPapers), /complete original sealed batch/);
});

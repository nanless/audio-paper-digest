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
        fs.writeFileSync(filename, JSON.stringify({ contract: operator.CONTRACT,
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

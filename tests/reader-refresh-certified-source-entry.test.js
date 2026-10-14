'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

async function createSourceSet(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'refresh-entry-source-'));
    const old = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = old; fs.rmSync(root, { recursive: true, force: true }); });
    const ids = ['2610.00001', '2610.00002'];
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'refresh-source-test', papers: ids.map(arxivId => ({ arxivId })) });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async id => {
                const text = `official source ${id} `.repeat(500);
                const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
                artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
                return { text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`, fetchedAt: '2026-10-11T00:00:00.000Z', imageInfos: [], structuredArtifacts: artifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async id => ({ bytes: Buffer.from(`%PDF-1.4\n${id}\n%%EOF\n`), url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: '2026-10-11T00:00:01.000Z' })
        }) });
    const payload = { batchId: plan.batchId, batchDate: plan.batchDate, dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: ids.map(arxivId => ({ arxivId, analysis: 'kept main', analysisManifest: { stages: {} } })) };
    return { payload, plan, ids, sourceFile: id => path.join(plan.sourcesDir, id, 'generation-000001', 'source.pdf') };
}

function loadRefresh(f, mutateAtLock = () => {}, saveError = null) {
    const counts = { reads: 0, fullEntry: 0, target: 0, fullFinal: 0, operations: 0 };
    const wrappedDaily = { ...daily,
        requireDailyFreshSourceRecoveryPlan(...args) { counts.fullEntry++; return daily.requireDailyFreshSourceRecoveryPlan(...args); },
        requireLockedDailyFreshSourceRecoveryPlan(...args) { counts.target++; return daily.requireLockedDailyFreshSourceRecoveryPlan(...args); },
        requireFinalDailyFreshSourceRecoveryPlan(...args) { counts.fullFinal++; return daily.requireFinalDailyFreshSourceRecoveryPlan(...args); },
        isPaperBoundToPlan: () => true,
        withDailyFreshAnalysisContext: (_, fn) => fn(),
        withDailyFreshPaperSource: (plan, paper, fn) => fn(daily.readDailyFreshSource(plan, paper))
    };
    const modules = {
        './config.js': { FILES: { deepAnalysisResult: 'no-file' } },
        './deep-analyzer.js': { stableFingerprint: value => JSON.stringify(value), hasReviewedCompletedPrimaryReaderSeed: () => false },
        './analysis-engine.js': {
            readJsonFileStrict: () => { counts.reads++; return structuredClone(f.payload); },
            isSuccessfulAnalysisRecord: () => true,
            updateJsonFileLocked: () => { throw saveError || new Error('unexpected save'); },
            withPaperAnalysisLock: (_, fn) => { mutateAtLock(); return fn(); }
        },
        './lib/daily-fresh-source-plan.js': wrappedDaily,
        './lib/reader-tables.js': {}, './digest-status.js': {},
        './lib/analysis-failure-rounds.js': require('../scripts/lib/analysis-failure-rounds'),
        './lib/analysis-batch-report.js': { writeAnalysisBatchReport: () => 'test-diagnostics' },
        './utils.js': { normalizedId: item => typeof item === 'string' ? item : item.arxivId },
        './lib/analysis-stop-control': { withAnalysisStopControl: fn => fn(), assertMayStartRequest() {}, requestAnalysisStop() {}, isAnalysisStopRequested: () => false }
    };
    const filename = path.resolve(__dirname, '../scripts/refresh-api-reader.js');
    const source = fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, '');
    const module = { exports: {} };
    new vm.Script(`(function(require,module,exports){${source}\n})`, { filename }).runInThisContext()(name => {
        if (Object.hasOwn(modules, name)) return modules[name];
        if (name.startsWith('node:')) return require(name);
        throw new Error(`未预期的依赖：${name}`);
    }, module, module.exports);
    const options = { concurrency: 10, operations: { article: async () => { counts.operations++; throw new Error('CONTROLLED_STOP_BEFORE_SAVE'); } } };
    return { refresh: module.exports, counts, options };
}

test('批入口仅一次全源核，两个最新读取检查每篇目标，失败结束仍完整核验', async t => {
    const f = await createSourceSet(t), r = loadRefresh(f);
    await assert.rejects(r.refresh.refreshApiReaders(f.ids, r.options), /批量刷新失败/);
    assert.deepEqual(r.counts, { reads: 6, fullEntry: 1, target: 4, fullFinal: 1, operations: 2 });
});

test('锁内目标文件变坏必须在操作前拒绝；结束检查也发现其他来源变坏', async t => {
    const f = await createSourceSet(t);
    const r = loadRefresh(f, () => fs.appendFileSync(f.sourceFile(f.ids[0]), 'DRIFT'));
    await assert.rejects(r.refresh.refreshApiReader(f.ids[0], r.options), /封存|来源|SHA|sha/);
    assert.equal(r.counts.operations, 0);
    assert.equal(r.counts.fullFinal, 1);
});

test('完整集合变化与被修改的来源运行不能借认证计划继续', async t => {
    const f = await createSourceSet(t);
    const r = loadRefresh(f, () => { f.payload.papers.pop(); });
    await assert.rejects(r.refresh.refreshApiReader(f.ids[0], r.options), /封存|来源|吻合/);
    assert.equal(r.counts.operations, 0);
});

test('只改未选来源时目标操作失败后最终全批核验仍阻断', async t => {
    const f = await createSourceSet(t), r = loadRefresh(f);
    r.options.operations.article = async () => { r.counts.operations++; fs.appendFileSync(f.sourceFile(f.ids[1]), 'DRIFT'); throw new Error('CONTROLLED_STOP_BEFORE_SAVE'); };
    await assert.rejects(r.refresh.refreshApiReader(f.ids[0], r.options), /封存|来源|SHA|sha/);
    assert.equal(r.counts.operations, 1);
    assert.equal(r.counts.fullEntry, 1);
    assert.equal(r.counts.fullFinal, 1);
});

test('来源运行引用变化不能沿用批入口；外部提供未认证计划不会获得认证', async t => {
    const f = await createSourceSet(t);
    const entry = daily.requireDailyFreshSourceRecoveryPlan(f.payload);
    assert.throws(() => daily.requireLockedDailyFreshSourceRecoveryPlan(f.payload, {
        entryPlan: structuredClone(entry), paper: f.payload.papers[0]
    }), /入口完整核验/);
    const r = loadRefresh(f, () => { f.payload.dailyFreshSourceRun = { ...f.payload.dailyFreshSourceRun, runId: crypto.randomUUID() }; });
    await assert.rejects(r.refresh.refreshApiReader(f.ids[0], r.options), /封存|来源|运行|ENOENT/);
    assert.equal(r.counts.operations, 0);
});


for (const code of [undefined, 'EMFILE', 'EDQUOT']) {
    test(`Reader 保存边界 ${code || '普通事务错误'} 原样停止后续派发`, async t => {
        const f = await createSourceSet(t);
        const failure = Object.assign(new Error('controlled canonical persistence failure'), { code });
        const r = loadRefresh(f, () => {}, failure), seen = [];
        r.options.concurrency = 1;
        r.options.operations.article = async paper => {
            seen.push(paper.arxivId);
            return { ...paper, apiReaderPlan: { sections: [] }, apiReaderFigures: [] };
        };
        await assert.rejects(r.refresh.refreshApiReaders(f.ids, r.options), error => error === failure);
        assert.deepEqual(seen, [f.ids[0]]);
        assert.equal(r.counts.fullFinal, 1);
        assert.equal(failure.failures.length, 1);
    });
}

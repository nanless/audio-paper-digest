'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');
const fresh = require('../scripts/lib/fresh-analysis-context.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

async function prepareControlledBatch(t) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'batch-reader-diagnostics-'));
    const previous = {};
    for (const key of ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers']) {
        previous[key] = Config.FILES[key];
        Config.FILES[key] = path.join(directory, key);
    }
    t.after(() => {
        Object.assign(Config.FILES, previous);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const paper = { arxivId: '2610.90037', title: '受控声音恢复', abstract: 'Speech task.' };
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-10-11', batchId: 'batch-reader-diagnostics', papers: [paper] });
    const text = 'Controlled official speech method and evaluation. '.repeat(250);
    const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
    await daily.captureDailyFreshSources(plan, {
        concurrency: 1,
        capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js').captureFreshArxivRewriteSource(options, {
            fetchText: async id => ({ text, source: 'html', sourceId: id, url: `https://arxiv.org/html/${id}`, structuredArtifacts: artifacts, readerAuthors: { authors: [] }, imageInfos: [] }),
            fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.7\ncontrolled\n%%EOF'), url: `https://arxiv.org/pdf/${id}.pdf` })
        })
    });
    const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
    write(Config.FILES.filteredPapers, { batchDate: plan.batchDate, batchId: plan.batchId, status: 'complete', papers: [paper] });
    write(Config.FILES.deepAnalysisResult, { batchDate: plan.batchDate, status: 'running', dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [paper] });
    write(Config.FILES.papers, { generation: 0, papers: {} });
    const batchPath = require.resolve('../scripts/batch-analyze.js');
    delete require.cache[batchPath];
    const batch = require(batchPath);
    return { batch, plan, paper };
}

test('正常 batch 入口默认不迁移，显式恢复向真实日更上下文传递许可且不退休旧文件', async t => {
    const { batch, plan } = await prepareControlledBatch(t);
    fs.mkdirSync(plan.readerAttemptsDir, { recursive: true, mode: 0o700 });
    const sentinel = path.join(plan.readerAttemptsDir, 'a'.repeat(64) + '.json');
    const original = JSON.stringify({ identity: { paperId: '2610.90037' }, payload: { attempts: 2 } });
    fs.writeFileSync(sentinel, original, { mode: 0o600 });
    const scopes = [];
    const analyzeBatch = async () => {
        scopes.push(fresh.getFreshAnalysisContext().refreshReaderDiagnostics);
        return { stats: { total: 1, success: 0, failed: 1, skipped: 0, durationTotal: 0, sourceCounts: {} } };
    };
    await batch.main({ analyzeBatch });
    await batch.main({ refreshReaderDiagnostics: true, analyzeBatch });
    assert.deepEqual(scopes, [false, true]);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(plan.readerAttemptsDir), [path.basename(sentinel)]);
});

test('非法恢复类型及与停用选项冲突在读取或改写正式结果前拒绝', async t => {
    const { batch } = await prepareControlledBatch(t);
    const paths = ['deepAnalysisResult', 'filteredPapers', 'papers'].map(key => Config.FILES[key]);
    const before = paths.map(filename => fs.readFileSync(filename));
    await assert.rejects(batch.main({ refreshReaderDiagnostics: 'true' }), /必须为 true 或 false/);
    const originalArgv = [...process.argv];
    process.argv.push('--retry-failed-readers', '--refresh-reader-diagnostics');
    const modulePath = require.resolve('../scripts/batch-analyze.js');
    delete require.cache[modulePath];
    const conflictingBatch = require(modulePath);
    t.after(() => { process.argv.splice(0, process.argv.length, ...originalArgv); delete require.cache[modulePath]; });
    await assert.rejects(conflictingBatch.main(), /不能.*同时使用/);
    for (let index = 0; index < paths.length; index++) assert.deepEqual(fs.readFileSync(paths[index]), before[index]);
});

test('日更公共上下文拒绝非布尔恢复许可，默认与显式许可分别可观察', async t => {
    const { plan } = await prepareControlledBatch(t);
    const seen = [];
    await daily.withDailyFreshAnalysisContext(plan, () => seen.push(fresh.getFreshAnalysisContext().refreshReaderDiagnostics));
    await daily.withDailyFreshAnalysisContext(plan, () => seen.push(fresh.getFreshAnalysisContext().refreshReaderDiagnostics), { refreshReaderDiagnostics: true });
    assert.deepEqual(seen, [false, true]);
    assert.throws(() => daily.withDailyFreshAnalysisContext(plan, () => assert.fail('不应进入回调'), { refreshReaderDiagnostics: 1 }), /必须为 true 或 false/);
});

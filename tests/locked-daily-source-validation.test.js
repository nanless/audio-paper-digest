'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Config = require('../scripts/config.js');
const daily = require('../scripts/lib/daily-fresh-source-plan.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

async function makeSourceSample(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'locked-source-validation-'));
    const previous = Config.FILES.dailyFreshSourceRunsDir;
    Config.FILES.dailyFreshSourceRunsDir = path.join(root, 'daily-runs');
    t.after(() => { Config.FILES.dailyFreshSourceRunsDir = previous; fs.rmSync(root, { recursive: true, force: true }); });
    const id = '2609.12348';
    const plan = daily.createDailyFreshSourcePlan({ batchDate: '2026-09-07', batchId: 'validation-batch', papers: [{ arxivId: id }, { arxivId: '2609.12349' }] });
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => require('../scripts/lib/fresh-arxiv-rewrite-source.js')
        .captureFreshArxivRewriteSource(options, {
            fetchText: async requested => {
                const text = `fresh official text ${requested} `.repeat(500);
                const artifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
                artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
                return { text, source: 'html', sourceId: requested, url: `https://arxiv.org/html/${requested}`,
                    fetchedAt: '2026-09-07T00:00:00.000Z', imageInfos: [], structuredArtifacts: artifacts,
                    htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async requested => ({ bytes: Buffer.from(`%PDF-1.4\n${requested}\n%%EOF\n`),
                url: `https://arxiv.org/pdf/${requested}.pdf`, fetchedAt: '2026-09-07T00:00:01.000Z' })
        }) });
    const data = { batchDate: plan.batchDate, batchId: plan.batchId,
        dailyFreshSourceRun: daily.dailyFreshSourceReference(plan),
        papers: plan.paperIds.map(arxivId => ({ arxivId })) };
    return { plan, data, folder: id => path.join(plan.sourcesDir, id, 'generation-000001') };
}
function countReads(fn) {
    const original = fs.readFileSync, open = fs.openSync, close = fs.closeSync;
    const files = [], descriptors = new Map();
    fs.openSync = function(file, ...args) { const fd = open.call(this,file,...args); descriptors.set(fd,String(file)); return fd; };
    fs.closeSync = function(fd) { descriptors.delete(fd); return close.call(this,fd); };
    fs.readFileSync = function(file, ...args) {
        const result = original.call(this,file,...args);
        const target = typeof file === 'number' ? descriptors.get(file) : String(file);
        if (/source\.(txt|pdf)$|source-(runtime|manifest)\.json$/.test(target || '')) files.push(target);
        return result;
    };
    try { return { result: fn(), files }; } finally { fs.readFileSync = original; fs.openSync = open; fs.closeSync = close; }
}
test('两论文封存来源：入口及结束全读，锁内只现读本篇四文件', async t => {
    const f = await makeSourceSample(t);
    const first = countReads(() => daily.requireDailyFreshSourceRecoveryPlan(f.data));
    assert.equal(first.files.length, 8);
    for (let i = 0; i < 2; i++) {
        const locked = countReads(() => daily.requireLockedDailyFreshSourceRecoveryPlan(f.data, { entryPlan: first.result, paper: f.data.papers[0] }));
        assert.equal(locked.files.length, 4);
        assert.ok(locked.files.every(file => file.includes(f.data.papers[0].arxivId)));
    }
    const final = countReads(() => daily.requireFinalDailyFreshSourceRecoveryPlan(f.data, { entryPlan: first.result }));
    assert.equal(final.files.length, 8);
});
test('别篇 PDF 中途变化：本篇仍独立核验，别篇及最终整批核验拒绝', async t => {
    const f = await makeSourceSample(t); const entryPlan = daily.requireDailyFreshSourceRecoveryPlan(f.data);
    fs.appendFileSync(path.join(f.folder(f.data.papers[1].arxivId), 'source.pdf'), 'changed');
    assert.doesNotThrow(() => daily.requireLockedDailyFreshSourceRecoveryPlan(f.data, { entryPlan, paper: f.data.papers[0] }));
    assert.throws(() => daily.requireLockedDailyFreshSourceRecoveryPlan(f.data, { entryPlan, paper: f.data.papers[1] }));
    assert.throws(() => daily.requireFinalDailyFreshSourceRecoveryPlan(f.data, { entryPlan }));
    assert.throws(() => daily.requireDailyFreshSourceRecoveryPlan(f.data));
});
test('锁内不接受克隆许可、改入口计划、日期、集合或运行引用', async t => {
    const f = await makeSourceSample(t); const entryPlan = daily.requireDailyFreshSourceRecoveryPlan(f.data);
    const check = (data, plan = entryPlan) => daily.requireLockedDailyFreshSourceRecoveryPlan(data, { entryPlan: plan, paper: f.data.papers[0] });
    assert.throws(() => check(f.data, structuredClone(entryPlan)));
    for (const changed of [ { ...f.data, batchDate: '2026-09-08' }, { ...f.data, batchId: 'other' },
        { ...f.data, papers: [f.data.papers[0]] }, { ...f.data, papers: [f.data.papers[0],f.data.papers[0]] },
        { ...f.data, dailyFreshSourceRun: { ...f.data.dailyFreshSourceRun, runId: 'other' } } ]) assert.throws(() => check(changed));
    entryPlan.batchDate = '2026-09-08'; assert.throws(() => check(f.data));
});
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
test('deep 公共入口先保存正文，别篇来源变坏后最终拒绝且批次仍运行中', async t => {
    const f = await makeSourceSample(t);
    const Config = require('../scripts/config');
    const previous = { deepAnalysisResult: Config.FILES.deepAnalysisResult, filteredPapers: Config.FILES.filteredPapers, papers: Config.FILES.papers };
    t.after(() => Object.assign(Config.FILES, previous));
    Config.FILES.deepAnalysisResult = path.join(f.plan.runDir, 'current/result.json');
    Config.FILES.filteredPapers = path.join(f.plan.runDir, 'current/filtered.json');
    Config.FILES.papers = path.join(f.plan.runDir, 'current/papers.json');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const { validAnalysisPaper } = require('./valid-analysis-fixture');
    f.data.papers = f.data.papers.map(({arxivId}) => validAnalysisPaper(arxivId));
    for (const paper of f.data.papers) {
        const source = daily.readDailyFreshSource(f.plan, paper);
        await daily.withDailyFreshAnalysisContext(f.plan, () => fresh.attachFreshSourceRecord(paper, paper.analysisManifest, source));
    }
    const expectedBody = f.data.papers[0].analysis;
    f.data.papers[0].error = '需要继续分析';
    save(Config.FILES.deepAnalysisResult, { ...f.data, status: 'running' });
    save(Config.FILES.filteredPapers, { batchDate: f.plan.batchDate, batchId: f.plan.batchId, status: 'complete', papers: f.data.papers });
    save(Config.FILES.papers, { generation: 0, papers: {} });
    let requests = 0;
    await assert.rejects(require('../scripts/deep-analysis-only').runDeepAnalysis({ date: f.plan.batchDate, id: f.data.papers[0].arxivId,
        analyzeBatch: async (papers, options) => {
            const read = countReads(() => options.preparePaperLocked(papers[0]));
            assert.equal(new Set(read.files).size, 4);
            assert.ok(read.files.every(file => file.includes(papers[0].arxivId)));
            const prepared = await read.result;
            assert.equal(prepared.paper.arxivId, papers[0].arxivId);
            requests++;
            const saved = { ...f.data.papers[0] }; delete saved.error;
            await options.onPaperResultLocked(saved, { success: true, result: saved });
            const stats = { success: 1, failed: 0, skipped: 0 };
            await options.onSave([saved], stats);
            const interim = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
            assert.equal(interim.status, 'running');
            assert.equal(interim.deepAnalysisCompletedAt, undefined);
            fs.appendFileSync(path.join(f.folder(f.data.papers[1].arxivId), 'source.pdf'), 'changed-after-save');
            return { results: [saved], stats };
        } }), error => /source|来源|SHA|封存/i.test(error.message));
    assert.equal(requests, 1);
    const final = JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult));
    assert.equal(final.status, 'running'); assert.equal(final.deepAnalysisCompletedAt, undefined);
    assert.equal(final.papers[0].analysis, expectedBody); assert.equal(final.papers[0].error, undefined);
});

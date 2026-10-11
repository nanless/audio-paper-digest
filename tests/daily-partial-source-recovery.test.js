'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const daily = require('../scripts/lib/daily-fresh-source-plan');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const date = '2026-10-11';

test('中断分析从完整筛选与本次封存来源恢复，错误身份或损坏文件在分析前拒绝', async t => {
    const folder = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-partial-recovery-'));
    const keys = ['dailyFreshSourceRunsDir', 'deepAnalysisResult', 'filteredPapers', 'papers', 'papersLegacy'];
    const old = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
    Config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'sources');
    for (const key of keys.slice(1)) Config.FILES[key] = path.join(folder, key + '.json');
    t.after(() => { Object.assign(Config.FILES, old); fs.rmSync(folder, { recursive: true, force: true }); });
    const papers = ['2610.90001', '2610.90002'].map(arxivId => ({ arxivId, title: '本地来源测试', abstract: '本地摘要' }));
    const plan = daily.createDailyFreshSourcePlan({ batchDate: date, batchId: 'partial-source-test', papers });
    let captures = 0;
    await daily.captureDailyFreshSources(plan, { concurrency: 1, capture: options => {
        captures += 1;
        return require('../scripts/lib/fresh-arxiv-rewrite-source').captureFreshArxivRewriteSource(options, {
            fetchText: async id => {
                const text = ('Official local method and result for ' + id + '. ').repeat(160);
                const structuredArtifacts = { version: 1, source: 'html', flattenedTextSha256: sha(text), tables: [], formulas: [], figures: [] };
                structuredArtifacts.payloadSha256 = sha(JSON.stringify(structuredArtifacts));
                return { text, source: 'html', sourceId: id + 'v1', url: 'https://arxiv.org/html/' + id + 'v1', fetchedAt: date + 'T00:00:00.000Z', imageInfos: [], structuredArtifacts, readerAuthors: { authors: [] }, htmlAvailability: 'available', htmlAttempts: 1, warnings: [] };
            },
            fetchPdf: async id => ({ bytes: Buffer.from('%PDF-1.7\n' + id + '\n%%EOF\n'), url: 'https://arxiv.org/pdf/' + id + '.pdf', fetchedAt: date + 'T00:00:00.000Z' })
        });
    }});
    const filtered = { status: 'complete', batchDate: date, batchId: plan.batchId, papers };
    const partial = { status: 'running', dailyFreshSourceRun: daily.dailyFreshSourceReference(plan), papers: [{ ...papers[0], title: '旧标题', latestAnalysisAttemptError: '保留原失败', analysisCheckpoint: { stage: 'saved-local-stage' } }] };
    const write = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
    const original = JSON.stringify(partial);
    const prepared = daily.prepareDailyFreshSourceRecoveryPayload(partial, filtered);
    assert.equal(JSON.stringify(partial), original, '公开准备函数不修改传入记录');
    assert.equal(prepared.batchDate, date);
    assert.equal(prepared.batchId, plan.batchId);
    assert.equal(prepared.papers.length, 2);
    assert.equal(prepared.papers[0].latestAnalysisAttemptError, '保留原失败');
    assert.equal(prepared.papers[0].title, papers[0].title, '当前筛选元数据覆盖陈旧标题');
    assert.deepEqual(prepared.papers[0].analysisCheckpoint, partial.papers[0].analysisCheckpoint, '保留已有阶段检查点');
    assert.equal(prepared.papers[1].analysis, undefined, '补齐元数据不能授予成功资格');
    assert.equal(daily.requireDailyFreshSourceRecoveryPlan(prepared).runId, plan.runId);
    const entry = require('../scripts/deep-analysis-only');
    let analysisCalls = 0;
    const options = { date, analyzeBatch: async recovered => {
        analysisCalls += 1;
        assert.deepEqual(recovered.map(p => p.arxivId).sort(), papers.map(p => p.arxivId));
        throw new Error('本地分析调用已到达');
    }};
    write(Config.FILES.filteredPapers, filtered);
    write(Config.FILES.deepAnalysisResult, partial);
    await assert.rejects(entry.runDeepAnalysis(options), /本地分析调用已到达/);
    assert.equal(analysisCalls, 1);
    assert.equal(captures, 2, '恢复不重新获取来源');
    assert.equal(JSON.parse(fs.readFileSync(Config.FILES.deepAnalysisResult)).papers.length, 2);
    const variants = [
        { name: '明确错误日期', payload: { ...partial, batchDate: '2026-10-10' } },
        { name: '统计日期冲突', payload: { ...partial, stats: { batchDate: '2026-10-10' } } },
        { name: '已有批号冲突', payload: { ...partial, batchId: 'wrong' } },
        { name: '已有重复论文', payload: { ...partial, papers: [papers[0], papers[0]] } },
        { name: '已有额外论文', payload: { ...partial, papers: [{ arxivId: '2610.90003' }] } },
        { name: '筛选集合缺项', selected: { ...filtered, papers: [papers[0]] } },
        { name: '筛选批号不同', selected: { ...filtered, batchId: 'wrong' } }
    ];
    for (const variant of variants) {
        write(Config.FILES.filteredPapers, variant.selected || filtered);
        write(Config.FILES.deepAnalysisResult, variant.payload || partial);
        const before = fs.readFileSync(Config.FILES.deepAnalysisResult);
        await assert.rejects(entry.runDeepAnalysis(options), undefined, variant.name);
        assert.equal(analysisCalls, 1, variant.name + '必须在分析前拒绝');
        assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), before, variant.name + '不改原记录');
    }
    write(Config.FILES.filteredPapers, filtered);
    const textPath = path.join(Config.FILES.dailyFreshSourceRunsDir, plan.runId, 'sources', papers[1].arxivId, 'generation-000001', 'source.txt');
    const originalText = fs.readFileSync(textPath);
    for (const missing of [false, true]) {
        write(Config.FILES.deepAnalysisResult, partial);
        const before = fs.readFileSync(Config.FILES.deepAnalysisResult);
        if (missing) fs.unlinkSync(textPath); else fs.appendFileSync(textPath, 'changed');
        await assert.rejects(entry.runDeepAnalysis(options));
        assert.equal(analysisCalls, 1, '未开始论文的来源也必须核验');
        assert.deepEqual(fs.readFileSync(Config.FILES.deepAnalysisResult), before);
        fs.writeFileSync(textPath, originalText, { mode: 0o600 });
    }
});

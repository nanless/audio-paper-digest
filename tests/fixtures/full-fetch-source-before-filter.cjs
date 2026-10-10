'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const scenario = process.argv[2];
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'source-before-filter-'));
const config = require('../../scripts/config');
config.CURRENT_DIR = path.join(folder, 'current');
config.ARCHIVE_DIR = path.join(folder, 'archive');
fs.mkdirSync(config.CURRENT_DIR); fs.mkdirSync(config.ARCHIVE_DIR);
config.PUBLISH_CONFIG.blogRepo = require('./local-published-blog.cjs').createLocalPublishedBlog(folder);
for (const key of ['rawCandidates', 'filteredPapers', 'filterDecisions', 'fetchCheckpoint', 'papers',
    'deepAnalysisResult', 'deepAnalysisResultLegacy', 'analyzed']) {
    config.FILES[key] = path.join(config.CURRENT_DIR, `${key}.json`);
}
config.ARXIV_CATEGORIES = [{ id: 'cs.SD', name: '声音', priority: 'core' }];
config.ARXIV_CONFIG.firstRequestDelayMs = 0;
config.FILTER_CONFIG.keywordPrefilterEnabled = false;
Math.random = () => 0;
let modelCalls = 0;
const utils = require('../../scripts/utils');
utils.requestLlmJson = async () => {
    modelCalls++;
    throw Object.assign(new Error('HTTP 401 本地筛选请求已到达，禁止真实模型'), { status: 401 });
};
const fetchApi = require('../../scripts/fetch-papers');
function sourcePaper(source, id) {
    return { arxivId: id, title: 'Speech recognition', abstract: 'Audio and speech recognition study',
        categories: ['cs.SD'], sources: [source] };
}
function health(boundary, hf) {
    return { ok: true, attempts: 1, successfulRequests: 1,
        provider: { boundaryIdentity: boundary.identitySha256,
            window: { since: boundary.since, until: boundary.until, covered: true },
            ...(hf ? { cutoffDate: boundary.lastDigestDate, dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } : {}) } };
}
fetchApi.fetchCategoryPapersSince = async (category, boundary) => {
    if (scenario === 'arxiv-failed') throw new Error('本地模拟 arXiv 后页失败');
    const papers = [sourcePaper('arxiv', '2610.09998')];
    papers._sourceHealth = health(boundary, false); return papers;
};
require('../../scripts/fetch-huggingface-papers').fetchHuggingFacePapers = async (ids, options) => {
    if (scenario === 'hf-failed') throw new Error('本地模拟 HuggingFace 后页失败');
    const papers = [sourcePaper('huggingface', '2610.09999')];
    papers._sourceHealth = health(options.boundary, true); return papers;
};
const engine = require('../../scripts/analysis-engine');
let analysisCalls = 0;
engine.analyzeBatch = async () => { analysisCalls++; throw new Error('本地测试不能分析'); };
const pipeline = require('../../scripts/full-fetch');
async function main() {
    try {
        if (scenario.startsWith('resume-')) {
            const boundary = require('../../scripts/lib/daily-fetch-boundary').resolveDailyFetchBoundary(
                config.PUBLISH_CONFIG.blogRepo, { until: new Date().toISOString() });
            const failed = scenario === 'resume-failed';
            const sourceHealth = { sourceContractVersion: 7, fetchBoundary: boundary,
                arxiv: { categories: [{ id: 'cs.SD', ok: !failed,
                    provider: health(boundary, false).provider }] },
                huggingface: health(boundary, true) };
            const paper = sourcePaper('huggingface', '2610.09999');
            const original = Buffer.from(JSON.stringify({ sourceContractVersion: 7,
                fetchBoundary: boundary, sourceHealth, papers: [paper] }));
            for (const key of ['rawCandidates', 'fetchCheckpoint', 'filterDecisions']) {
                fs.writeFileSync(config.FILES[key], original);
            }
            let error;
            try {
                await pipeline.resumeFilterStage({ allPapers: [paper], allPapersFiltered: [paper],
                    sourceHealth, baseFilterStats: { sourceContractVersion: 7 },
                    initialDecisions: {}, filterModel: 'local-test', filterPromptHash: 'a'.repeat(64),
                    today: utils.getBeijingDateString() });
            } catch (caught) { error = caught; }
            assert.ok(error instanceof Error);
            if (failed) {
                assert.equal(modelCalls, 0, '续筛选的来源未完整时，不得发起模型请求');
                assert.match(error.message, /缓存候选的抓取来源不完整，保留已有恢复记录，禁止调用筛选模型/);
            } else {
                assert.ok(modelCalls > 0);
                assert.match(error.message, /本地筛选请求已到达/);
            }
            for (const key of failed ? ['rawCandidates', 'fetchCheckpoint', 'filterDecisions'] : ['fetchCheckpoint']) {
                assert.deepEqual(fs.readFileSync(config.FILES[key]), original);
            }
            assert.equal(analysisCalls, 0);
            return;
        }
        let error;
        try { await pipeline.fullFetch({ lockTarget: path.join(folder, 'operation') }); }
        catch (caught) { error = caught; }
        assert.ok(error instanceof Error);
        const checkpoint = JSON.parse(fs.readFileSync(config.FILES.fetchCheckpoint));
        const raw = JSON.parse(fs.readFileSync(config.FILES.rawCandidates));
        assert.equal(raw.sourceContractVersion, 7);
        assert.equal(raw.fetchBoundary.identitySha256, checkpoint.fetchBoundary.identitySha256);
        assert.equal(raw.fetchSourcesSha256, pipeline.getFetchSourcesSha256(checkpoint));
        assert.equal(raw.rawPapersSha256, pipeline.stableContentSha256(raw.papers));
        assert.equal(analysisCalls, 0);
        if (scenario === 'complete') {
            assert.equal(pipeline.hasCompleteSourceHealth(raw.sourceHealth), true);
            assert.ok(modelCalls > 0);
            assert.equal(raw.papers.length, 2);
            assert.match(error.message, /本地筛选请求已到达/);
        } else {
            assert.equal(modelCalls, 0, '来源未完整时，不得发起筛选模型请求');
            assert.match(error.message, /抓取来源不完整，已保存原始候选和抓取检查点，禁止调用筛选模型/);
            assert.equal(raw.papers.length, 1);
            assert.equal(pipeline.hasCompleteSourceHealth(raw.sourceHealth), false);
            assert.equal(checkpoint.arxiv['cs.SD'].status, scenario === 'arxiv-failed' ? 'failed' : 'complete');
            assert.equal(checkpoint.huggingface.status, scenario === 'hf-failed' ? 'failed' : 'complete');
            assert.equal(fs.existsSync(config.FILES.filterDecisions), false);
        }
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

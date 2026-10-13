'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const { localLlmResponse } = require('./local-llm-response.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'full-fetch-final-sync-')));
const config = require('../../scripts/config');
const crypto = require('node:crypto');
// 两类来源目录也使用临时路径，测试不读取或写入正式来源。
config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'runtime/daily-fresh-source-runs');
config.FILES.freshArxivFetchedSourcesDir = path.join(folder, 'runtime/fresh-arxiv-fetched-sources');
config.DATA_DIR = folder;
config.CURRENT_DIR = path.join(folder, 'current');
config.ARCHIVE_DIR = path.join(folder, 'archive');
fs.mkdirSync(config.CURRENT_DIR);
fs.mkdirSync(config.ARCHIVE_DIR);
config.PUBLISH_CONFIG.blogRepo = require('./local-published-blog.cjs').createLocalPublishedBlog(folder);
for (const key of ['rawCandidates', 'filteredPapers', 'filterDecisions', 'fetchCheckpoint', 'papers', 'papersLegacy', 'deepAnalysisResult', 'deepAnalysisResultLegacy', 'analyzed', 'analyzedLegacy', 'llmAccountPoolState']) {
    config.FILES[key] = path.join(config.CURRENT_DIR, `${key}.json`);
}
config.ARXIV_CATEGORIES = [{ id: 'cs.SD', name: '声音', priority: 'core' }];
config.FILTER_CONFIG.keywordPrefilterEnabled = false;
config.FILTER_CONFIG.batchSize = 1;
config.ANALYSIS_CONFIG.concurrency = 10;
config.FILTER_CONFIG.delayBetweenBatchesMs = 0;
Math.random = () => 0;
const ids = ['2610.90011', '2610.90012', '2610.90013'];
const utils = require('../../scripts/utils');
const requests = [];
utils.requestLlmJson = async (url, endpoint, model, body) => {
    const prompt = JSON.stringify(body);
    const index = [0, 1, 2].find(value => prompt.includes(`本地声音论文${value}`));
    assert.notEqual(index, undefined, '请求必须对应本地论文');
    requests.push(ids[index]);
    const response = JSON.stringify({ related: index !== 0, reason: `本地筛选决定${index}` });
    return localLlmResponse(endpoint, model, response);
};
const papers = ids.map((arxivId, index) => ({ arxivId, title: `本地声音论文${index}`,
    abstract: 'Audio speech recognition', categories: ['cs.SD'], sources: ['arxiv'] }));
const health = (boundary, hf) => ({ ok: true, attempts: 1, successfulRequests: 1,
    provider: { boundaryIdentity: boundary.identitySha256,
        window: { since: boundary.since, until: boundary.until, covered: true },
        ...(hf ? { cutoffDate: boundary.lastDigestDate, dailyCovered: true,
            dailySelectedAtField: 'paper.submittedOnDailyAt' } : {}) } });
require('../../scripts/fetch-papers').fetchCategoryPapersSince = async (category, boundary) => {
    const result = papers.map(paper => ({ ...paper }));
    result._sourceHealth = health(boundary, false);
    return result;
};
require('../../scripts/fetch-huggingface-papers').fetchHuggingFacePapers = async (existing, options) => {
    const result = [];
    result._sourceHealth = health(options.boundary, true);
    return result;
};

const events = [];
const daily = require('../../scripts/lib/daily-fresh-source-plan');
const originalCapture = daily.captureDailyFreshSources;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
daily.captureDailyFreshSources = async (plan, options = {}) => {
    assert.equal(options.concurrency, undefined, '正常日更不得把模型并发10传入来源上限8');
    events.push('capture');
    return originalCapture(plan, {
        ...options,
        capture: sourceOptions => require('../../scripts/lib/fresh-arxiv-rewrite-source')
            .captureFreshArxivRewriteSource(sourceOptions, {
                fetchText: async id => {
                    const text = (`Official local method and result for ${id}. `).repeat(160);
                    const artifacts = {
                        version: 1, source: 'html', flattenedTextSha256: sha(text),
                        tables: [], formulas: [], figures: []
                    };
                    artifacts.payloadSha256 = sha(JSON.stringify(artifacts));
                    return {
                        text, source: 'html', sourceId: `${id}v1`,
                        url: `https://arxiv.org/html/${id}v1`, fetchedAt: new Date().toISOString(),
                        imageInfos: [], structuredArtifacts: artifacts, readerAuthors: { authors: [] },
                        htmlAvailability: 'available', htmlAttempts: 1, warnings: []
                    };
                },
                fetchPdf: async id => ({
                    bytes: Buffer.from(`%PDF-1.7\n${id}\n%%EOF\n`),
                    url: `https://arxiv.org/pdf/${id}.pdf`, fetchedAt: new Date().toISOString()
                })
            })
    });
};
const requirePlan = daily.requireDailyFreshSourceRecoveryPlan;
daily.requireDailyFreshSourceRecoveryPlan = (payload, options) => {
    events.push('register');
    return requirePlan(payload, options);
};
const engine = require('../../scripts/analysis-engine');
engine.analyzeBatch = async (selectedPapers, options) => {
    events.push('analyze');
    assert.equal(options.concurrency, 10);
    assert.equal(events.at(-2), 'register');
    assert.equal(selectedPapers.length, 2);
    assert.equal(typeof options.analyzeFn, 'function');
    return { stats: { success: 0, failed: 2 } };
};
const digest = require('../../scripts/digest-status');
const originalSync = digest.synchronizeCompletedAnalysisDigestStatuses;
digest.synchronizeCompletedAnalysisDigestStatuses = async (file, plan, options) => {
    events.push('sync');
    const payload = JSON.parse(fs.readFileSync(file));
    assert.equal(payload.papers.length, 2);
    const verified = daily.requireFinalDailyFreshSourceRecoveryPlan(payload, {
        entryPlan: plan, label: '本地末尾检查'
    });
    assert.equal(verified.runId, plan.runId);
    return originalSync(file, plan, options);
};
const pipeline = require('../../scripts/full-fetch');
async function main() {
    try {
        await pipeline.fullFetch({
            date: utils.getBeijingDateString(), lockTarget: path.join(folder, 'operation')
        });
        assert.deepEqual(events, ['capture', 'register', 'analyze', 'sync']);
        assert.equal(requests.length, 3);
        console.log('LOCAL_FULL_FETCH_CAPTURE_REGISTER_ANALYZE_SYNC_PASS ' + JSON.stringify(events));
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

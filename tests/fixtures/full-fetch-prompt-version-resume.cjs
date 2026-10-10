'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const scenario = process.argv[2];
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-version-resume-')));
const config = require('../../scripts/config');
const defaultSourceRuns = config.FILES.dailyFreshSourceRunsDir;
const defaultFetchedSources = config.FILES.freshArxivFetchedSourcesDir;
function directoryBytes(root) {
    if (!fs.existsSync(root)) return [];
    const output = [];
    function visit(directory) {
        for (const name of fs.readdirSync(directory).sort()) {
            const filename = path.join(directory, name);
            const stat = fs.lstatSync(filename);
            const relative = path.relative(root, filename);
            if (stat.isDirectory()) { output.push([relative, 'directory']); visit(filename); }
            else if (stat.isFile()) output.push([relative, crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]);
            else output.push([relative, 'other']);
        }
    }
    visit(root);
    return output;
}
const originalDefaultSourceRuns = directoryBytes(defaultSourceRuns);
const originalDefaultFetchedSources = directoryBytes(defaultFetchedSources);
config.DATA_DIR = folder;
config.CURRENT_DIR = path.join(folder, 'current');
config.ARCHIVE_DIR = path.join(folder, 'archive');
fs.mkdirSync(config.CURRENT_DIR);
fs.mkdirSync(config.ARCHIVE_DIR);
config.PUBLISH_CONFIG.blogRepo = require('./local-published-blog.cjs').createLocalPublishedBlog(folder);
for (const key of ['rawCandidates', 'filteredPapers', 'filterDecisions', 'fetchCheckpoint', 'papers', 'papersLegacy',
    'deepAnalysisResult', 'deepAnalysisResultLegacy', 'analyzed', 'analyzedLegacy', 'llmAccountPoolState']) {
    config.FILES[key] = path.join(config.CURRENT_DIR, `${key}.json`);
}
config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'runtime/daily-fresh-source-runs');
config.FILES.freshArxivFetchedSourcesDir = path.join(folder, 'runtime/fresh-arxiv-fetched-sources');
config.ARXIV_CONFIG.firstRequestDelayMs = 0;
config.FILTER_CONFIG.keywordPrefilterEnabled = true;
config.FILTER_CONFIG.batchSize = 5;
config.FILTER_CONFIG.delayBetweenBatchesMs = 0;
Math.random = () => 0;
// 来源已被本地回调替代，跳过类别间的真实网络等待；不改变操作锁的超时。
const originalSetTimeout = global.setTimeout;
global.setTimeout = (callback, milliseconds, ...args) => originalSetTimeout(callback,
    milliseconds >= 10000 ? 0 : milliseconds, ...args);
const versions = require('../../scripts/lib/prompt-text-versions');
const newPromptPath = versions.LLM_FILTER_PROMPT_PATH;
const oldPromptPath = 'prompts/filter-v2.md';
versions.LLM_FILTER_PROMPT_PATH = oldPromptPath;
const utils = require('../../scripts/utils');
const papers = Array.from({ length: 4171 }, (_, index) => ({ arxivId: `2610.${10000 + index}`,
    title: index < 425 ? `本地语音论文${index}` : `本地数学论文${index}`,
    abstract: index < 425 ? 'Speech recognition and audio processing.'
        : 'We study lattice symmetries and abstract algebraic structures. The proof establishes relations among groups and rings without empirical experiments.',
    categories: index < 425 ? ['cs.SD'] : ['math.RA'], sources: ['arxiv'] }));
let phase = 'old';
const requests = [];
utils.requestLlmJson = async (url, endpoint, model, body) => {
    const prompt = body.messages[0].content;
    const index = Number(prompt.match(/本地语音论文(\d+)/)?.[1]);
    assert.ok(Number.isInteger(index) && index < 425);
    const actualPath = phase === 'old' ? oldPromptPath : (scenario === 'changed' ? newPromptPath : oldPromptPath);
    assert.equal(prompt, utils.loadPrompt(actualPath, {
        title: papers[index].title, abstract: papers[index].abstract, categories: papers[index].categories
    }), '请求必须传递所选真实提示词首块及论文输入');
    requests.push(papers[index].arxivId);
    const content = JSON.stringify({ related: true, reason: `${phase === 'old' ? '原' : '新'}本地响应${index}` });
    return { statusCode: 200, body: { choices: [{ message: { content }, finish_reason: 'stop' }] }, raw: content, headers: {} };
};
let arxivCalls = 0;
let hfCalls = 0;
function health(boundary, hf) {
    return { ok: true, attempts: 1, successfulRequests: 1, provider: {
        boundaryIdentity: boundary.identitySha256,
        window: { since: boundary.since, until: boundary.until, covered: true },
        ...(hf ? { cutoffDate: boundary.lastDigestDate, dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } : {})
    } };
}
function installProviders() {
    const api = require('../../scripts/fetch-papers');
    api.fetchCategoryPapersSince = async (category, boundary) => {
        arxivCalls++;
        const result = category === 'cs.SD' ? papers.map(paper => ({ ...paper })) : [];
        result._sourceHealth = health(boundary, false);
        return result;
    };
}
installProviders();
require('../../scripts/fetch-huggingface-papers').fetchHuggingFacePapers = async (existing, options) => {
    hfCalls++;
    const result = [];
    result._sourceHealth = health(options.boundary, true);
    return result;
};
const stop = new Error('本地筛选已保存，测试不抓取来源或分析');
require('../../scripts/lib/daily-fresh-source-plan').captureDailyFreshSources = async () => { throw stop; };
let pipeline = require('../../scripts/full-fetch');
const options = { date: utils.getBeijingDateString(), lockTarget: path.join(folder, 'operation') };
async function main() {
    try {
        await assert.rejects(pipeline.fullFetch(options), error => error === stop);
        assert.equal(requests.length, 425);
        assert.equal(arxivCalls, 7);
        assert.equal(hfCalls, 1);
        const decisionFile = config.FILES.filterDecisions;
        const decision = JSON.parse(fs.readFileSync(decisionFile));
        const originalHash = decision.filterPromptHash;
        const retained = papers.slice(0, 259).map(paper => paper.arxivId);
        const missing = papers.slice(259, 425).map(paper => paper.arxivId);
        for (const id of missing) delete decision.decisions[id];
        decision.stats.complete = false;
        fs.writeFileSync(decisionFile, JSON.stringify(decision));
        fs.unlinkSync(config.FILES.filteredPapers);
        const preservedOldBytes = fs.readFileSync(decisionFile);
        const archiveFile = path.join(folder, 'old-paid-decisions.json');
        fs.writeFileSync(archiveFile, preservedOldBytes, { mode: 0o600 });
        const originalSources = new Map(['rawCandidates', 'fetchCheckpoint'].map(key => [key, fs.readFileSync(config.FILES[key])]));
        requests.length = 0;
        arxivCalls = 0;
        hfCalls = 0;
        phase = 'new';
        if (scenario === 'changed') {
            assert.notEqual(newPromptPath, oldPromptPath, '新请求须登记新的提示词路径，不能改写旧归档');
            versions.LLM_FILTER_PROMPT_PATH = newPromptPath;
            delete require.cache[require.resolve('../../scripts/fetch-papers')];
            installProviders();
            delete require.cache[require.resolve('../../scripts/full-fetch')];
            pipeline = require('../../scripts/full-fetch');
        }
        await assert.rejects(pipeline.fullFetch(options), error => error === stop);
        const final = JSON.parse(fs.readFileSync(decisionFile));
        assert.deepEqual([...requests].sort(), (scenario === 'changed' ? papers.slice(0, 425).map(paper => paper.arxivId) : missing).sort());
        assert.equal(arxivCalls, 0, '正常续筛选不得重新抓取七个分类');
        assert.equal(hfCalls, 0, '正常续筛选不得重新抓取精选来源');
        for (const [key, bytes] of originalSources) assert.deepEqual(fs.readFileSync(config.FILES[key]), bytes);
        assert.equal(Object.keys(final.decisions).length, 4171);
        assert.equal(Object.values(final.decisions).filter(item => item.parseSource === 'keyword_prefilter').length, 3746);
        assert.equal(final.stats.complete, true);
        assert.equal(JSON.parse(fs.readFileSync(config.FILES.filteredPapers)).papers.length, 425);
        assert.equal(final.filterPromptHash === originalHash, scenario !== 'changed');
        for (const id of retained) {
            if (scenario === 'changed') assert.match(final.decisions[id].reason, /新本地响应/);
            else assert.deepEqual(final.decisions[id], decision.decisions[id]);
        }
        assert.deepEqual(fs.readFileSync(archiveFile), preservedOldBytes, '旧全部响应备份保持原字节');
    } finally {
        try {
            assert.deepEqual(directoryBytes(defaultSourceRuns), originalDefaultSourceRuns,
                '默认封存来源目录及原文件字节必须保持');
            assert.deepEqual(directoryBytes(defaultFetchedSources), originalDefaultFetchedSources,
                '默认官方全文证据目录及原文件字节必须保持');
        } finally { fs.rmSync(folder, { recursive: true, force: true }); }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

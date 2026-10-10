'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const scenario = process.argv[2];
const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-refilter-')));
const config = require('../../scripts/config');
const crypto = require('node:crypto');
const defaultSourceRuns = config.FILES.dailyFreshSourceRunsDir;
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
config.FILES.dailyFreshSourceRunsDir = path.join(folder, 'runtime/daily-fresh-source-runs');
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
config.ARXIV_CONFIG.firstRequestDelayMs = 0;
config.FILTER_CONFIG.keywordPrefilterEnabled = false;
config.FILTER_CONFIG.batchSize = 1;
config.FILTER_CONFIG.delayBetweenBatchesMs = 0;
Math.random = () => 0;
const ids = ['2610.90011', '2610.90012', '2610.90013'];
const utils = require('../../scripts/utils');
let phase = 'initial';
let captureCalls = 0;
const requests = [];
utils.requestLlmJson = async (url, endpoint, model, body) => {
    const prompt = JSON.stringify(body);
    const index = prompt.includes('伪造的不同标题') ? 0
        : [0, 1, 2].find(value => prompt.includes(`本地声音论文${value}`));
    assert.notEqual(index, undefined, '请求必须对应本地论文');
    requests.push(ids[index]);
    if (phase !== 'initial' && index === 0) {
        const pending = JSON.parse(fs.readFileSync(config.FILES.filterDecisions));
        assert.equal(pending.decisions[ids[0]], undefined);
        assert.equal(pending.retryableDecisions[ids[0]].parseSource, 'explicit_recheck_pending');
        assert.equal(pending.stats.complete, false);
        assert.equal(pending.stats.decided, Object.keys(pending.decisions).length);
        assert.equal(pending.stats.related, Object.values(pending.decisions).filter(item => item.related).length);
        assert.equal(pending.stats.retryable, Object.keys(pending.retryableDecisions).length);
    }
    if (phase === 'failure') return { statusCode: 401, body: { error: { message: '本地认证失败' } }, raw: '', headers: {} };
    const response = JSON.stringify({ related: phase !== 'initial' || index !== 0,
        reason: phase === 'initial' ? `原决定${index}` : `重新核验${index}` });
    return { statusCode: 200, body: { choices: [{ message: { content: response }, finish_reason: 'stop' }] }, raw: response, headers: {} };
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
const stop = new Error('本地筛选已保存，禁止抓取论文或请求分析模型');
require('../../scripts/lib/daily-fresh-source-plan').captureDailyFreshSources = async () => {
    captureCalls++;
    if (phase !== 'initial') {
        const auditRoot = path.join(folder, 'runtime/filter-rechecks');
        const auditDir = path.join(auditRoot, fs.readdirSync(auditRoot)[0]);
        const saved = JSON.parse(fs.readFileSync(path.join(auditDir, 'recheck.json')));
        assert.equal(saved.newDecisions[ids[0]].related, true,
            '来源抓取开始前，重新筛选的真实响应必须已经保存到审计记录');
    }
    throw stop;
};
const pipeline = require('../../scripts/full-fetch');
const options = { date: utils.getBeijingDateString(), lockTarget: path.join(folder, 'operation') };
const read = key => JSON.parse(fs.readFileSync(config.FILES[key]));
async function main() {
    try {
        await assert.rejects(pipeline.fullFetch(options), error => error === stop);
        assert.deepEqual([...requests].sort(), ids);
        requests.length = 0;
        if (scenario === 'normal') {
            await assert.rejects(pipeline.fullFetch(options), error => error === stop);
            assert.equal(requests.length, 0, '普通完整缓存续跑不得额外筛选');
            return;
        }
        const original = read('filterDecisions');
        if (scenario === 'partial') {
            delete original.decisions[ids[2]];
            original.stats.complete = false;
            fs.writeFileSync(config.FILES.filterDecisions, JSON.stringify(original));
            fs.unlinkSync(config.FILES.filteredPapers);
        }
        if (scenario === 'raw-content-damaged') {
            const raw = read('rawCandidates');
            raw.papers[0].title = '伪造的不同标题';
            raw.papers[0].abstract = '伪造的不同摘要';
            raw.rawPapersSha256 = pipeline.stableContentSha256(raw.papers);
            original.rawPapersSha256 = raw.rawPapersSha256;
            original.decisions[ids[0]].inputSha256 = require('../../scripts/fetch-papers').buildFilterInputSha256(raw.papers[0]);
            fs.writeFileSync(config.FILES.rawCandidates, JSON.stringify(raw));
            fs.writeFileSync(config.FILES.filterDecisions, JSON.stringify(original));
        }
        if (scenario === 'keyword') {
            original.decisions[ids[0]].parseSource = 'keyword_prefilter';
            fs.writeFileSync(config.FILES.filterDecisions, JSON.stringify(original));
        }
        if (scenario === 'input-damaged') {
            original.decisions[ids[0]].inputSha256 = '0'.repeat(64);
            fs.writeFileSync(config.FILES.filterDecisions, JSON.stringify(original));
        }
        if (scenario === 'analysis-started') {
            const raw = read('rawCandidates');
            fs.writeFileSync(config.FILES.deepAnalysisResult, JSON.stringify({
                batchDate: options.date, batchId: raw.batchId, timestamp: utils.getBeijingISOString(),
                dailyFreshSourceRun: { runId: '本地已开始任务' }, papers: []
            }));
        }
        const originalBytes = fs.readFileSync(config.FILES.filterDecisions);
        const otherDecision = read('filterDecisions').decisions[ids[1]];
        phase = scenario === 'failure' ? 'failure' : 'recheck';
        if (scenario === 'cli') {
            assert.deepEqual(pipeline.parseFullFetchArgs(['--date', options.date, '--refilter', ids[0],
                '--refilter', ids[1], '--refilter-reason', '重新核验']), {
                date: options.date, refilterIds: [ids[0], ids[1]], refilterReason: '重新核验'
            });
            assert.throws(() => pipeline.parseFullFetchArgs(['--refilter', ids[0]]), /复核原因/);
            assert.equal(requests.length, 0);
            return;
        }
        const beforeCapture = captureCalls;
        let auditFailureInjected = false;
        const originalWrite = fs.writeFileSync;
        if (scenario === 'audit-write-failed') {
            fs.writeFileSync = function(filename, bytes, ...args) {
                if (!auditFailureInjected && String(filename).includes('recheck.json')
                    && String(bytes).includes('重新核验0')) {
                    auditFailureInjected = true;
                    throw Object.assign(new Error('本地审计保存失败'), { code: 'EIO' });
                }
                return originalWrite.call(this, filename, bytes, ...args);
            };
        }
        const requestOptions = { ...options, refilterIds: [ids[0]], refilterReason: '按当前规则重新核验' };
        if (scenario === 'missing-reason') delete requestOptions.refilterReason;
        if (scenario === 'unknown-id') requestOptions.refilterIds = ['2610.90099'];
        const rejected = ['raw-content-damaged', 'keyword', 'input-damaged', 'analysis-started', 'missing-reason', 'unknown-id'].includes(scenario);
        const protectedFiles = ['filterDecisions', 'rawCandidates', 'fetchCheckpoint'].map(key => [key, fs.readFileSync(config.FILES[key])]);
        const invocation = pipeline.fullFetch(requestOptions);
        if (rejected) {
            const expectedError = scenario === 'raw-content-damaged'
                ? /原始候选|来源|检查点/
                : scenario === 'missing-reason'
                ? /指定论文复筛须提供有效的 arXiv ID 数组和非空复核原因/
                : scenario === 'analysis-started'
                    ? /本批已进入封存来源分析，不能通过复筛改变论文集合；未请求模型/
                    : /必须是当前原始候选中已有有效模型决定的论文；此入口只复核模型决定，未请求模型/;
            await assert.rejects(invocation, expectedError);
            assert.equal(requests.length, 0, '无效重筛请求不得调用模型');
            for (const [key, bytes] of protectedFiles) assert.deepEqual(fs.readFileSync(config.FILES[key]), bytes);
            return;
        }
        if (scenario === 'audit-write-failed') {
            try {
                await assert.rejects(invocation, /本地审计保存失败/);
                assert.equal(auditFailureInjected, true);
                assert.equal(captureCalls, beforeCapture, '审计保存失败不能继续抓取来源');
                assert.deepEqual(requests, [ids[0]]);
            } finally { fs.writeFileSync = originalWrite; }
            return;
        }
        if (scenario === 'failure') await assert.rejects(invocation, /本地认证失败/);
        else await assert.rejects(invocation, error => error === stop);
        for (const [key, bytes] of protectedFiles.filter(([key]) => key !== 'filterDecisions')) {
            assert.deepEqual(fs.readFileSync(config.FILES[key]), bytes, '重新筛选不能改写来源和原始候选');
        }
        const final = read('filterDecisions');
        assert.deepEqual(final.decisions[ids[1]], otherDecision, '其他已付费决定必须保持');
        assert.deepEqual([...requests].sort(), scenario === 'partial' ? [ids[0], ids[2]] : [ids[0]]);
        const auditRoot = path.join(folder, 'runtime/filter-rechecks');
        const auditDir = path.join(auditRoot, fs.readdirSync(auditRoot)[0]);
        assert.deepEqual(fs.readFileSync(path.join(auditDir, 'original-filter-decisions.json')), originalBytes);
        const audit = JSON.parse(fs.readFileSync(path.join(auditDir, 'recheck.json')));
        assert.deepEqual(audit.targetedRefilterIds, [ids[0]]);
        assert.deepEqual(audit.remainingUndecidedIds, scenario === 'partial' ? [ids[2]] : []);
        if (scenario === 'failure') {
            assert.equal(final.decisions[ids[0]], undefined);
            assert.equal(audit.status, 'failed');
        } else {
            assert.equal(final.decisions[ids[0]].related, true);
            assert.match(final.decisions[ids[0]].reason, /重新核验/);
            assert.equal(read('filteredPapers').papers.length, 3);
        }
    } finally {
        try {
            assert.deepEqual(directoryBytes(defaultSourceRuns), originalDefaultSourceRuns,
                '默认封存来源运行目录及原文件字节必须保持');
        } finally { fs.rmSync(folder, { recursive: true, force: true }); }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const scenario = process.argv[2];
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-start-date-'));
const current = path.join(folder, 'current');
const archive = path.join(folder, 'archive');
fs.mkdirSync(current);
fs.mkdirSync(archive);
const blog = require('./local-published-blog.cjs').createLocalPublishedBlog(folder);
const config = require(`${root}/scripts/config.js`);
config.PUBLISH_CONFIG.blogRepo = blog;
config.CURRENT_DIR = current;
config.ARCHIVE_DIR = archive;
config.ARXIV_CATEGORIES = [];
for (const key of ['deepAnalysisResult', 'deepAnalysisResultLegacy', 'filteredPapers', 'papers',
    'analyzed', 'rawCandidates', 'filterDecisions', 'fetchCheckpoint']) {
    config.FILES[key] = path.join(current, `${key}.json`);
}
const original = Buffer.from(JSON.stringify({ batchDate: '2026-10-09',
    timestamp: '2026-10-09T12:00:00+08:00', papers: [] }));
fs.writeFileSync(config.FILES.rawCandidates, original);
let clock = scenario === 'wrong-day' ? '2026-10-11T00:00:01.000+08:00'
    : '2026-10-10T23:59:59.000+08:00';
const utils = require(`${root}/scripts/utils.js`);
utils.getBeijingISOString = () => clock;
utils.getBeijingDateString = () => clock.slice(0, 10);
const digest = require(`${root}/scripts/digest-status.js`);
digest.backupPapersJson = async () => ({ message: '本地合成备份' });
digest.loadPapersDatabase = () => ({ papers: {} });
const marker = new Error('本地来源调用已到达，禁止继续网络或模型');
let sourceCalls = 0;
require(`${root}/scripts/fetch-huggingface-papers.js`).fetchHuggingFacePapers = async () => {
    sourceCalls++;
    clock = '2026-10-11T00:00:02.000+08:00';
    const saved = JSON.parse(fs.readFileSync(config.FILES.fetchCheckpoint));
    assert.equal(saved.batchDate, '2026-10-10');
    assert.equal(saved.batchStartedAt, '2026-10-10T23:59:59.000+08:00');
    throw marker;
};
require(`${root}/scripts/fetch-papers.js`).fetchCategoryPapersSince = async () => {
    throw new Error('本地测试不能访问 arXiv');
};
const engine = require(`${root}/scripts/analysis-engine.js`);
engine.analyzeBatch = async () => { throw new Error('本地测试不能请求模型'); };
const api = require(`${root}/scripts/full-fetch.js`);
async function main() {
    try {
        if (scenario === 'invalid-date') {
            assert.throws(() => api.parseFullFetchArgs(['--date', '2026-02-30']), /有效/);
            assert.throws(() => api.parseFullFetchArgs(['--date', '0000-01-01']), /有效/);
            assert.throws(() => api.parseFullFetchArgs(['--unknown', '2026-10-10']), /用法/);
            assert.deepEqual(api.parseFullFetchArgs([]), {});
            return;
        }
        let options = scenario === 'no-date' ? {} : { date: '2026-10-10' };
        options.lockTarget = path.join(current, '.test-operation');
        options.lockOptions = { timeoutMs: 2000 };
        let pending;
        if (scenario === 'wait-midnight') {
            let releaseHolder;
            const holderGate = new Promise(resolve => { releaseHolder = resolve; });
            let acquired;
            const acquiredGate = new Promise(resolve => { acquired = resolve; });
            const holding = engine.withFileLock(options.lockTarget, async () => {
                acquired();
                await holderGate;
            });
            await acquiredGate;
            pending = api.fullFetch(options);
            await new Promise(resolve => setTimeout(resolve, 75));
            assert.equal(sourceCalls, 0);
            assert.deepEqual(fs.readFileSync(config.FILES.rawCandidates), original);
            clock = '2026-10-11T00:00:01.000+08:00';
            releaseHolder();
            await holding;
        } else pending = api.fullFetch(options);
        if (scenario === 'wrong-day' || scenario === 'wait-midnight') {
            await assert.rejects(pending, /抓取启动日期已变化：请求 2026-10-10，锁内启动时北京时间日期为 2026-10-11/);
            assert.equal(sourceCalls, 0);
            assert.deepEqual(fs.readFileSync(config.FILES.rawCandidates), original);
            assert.deepEqual(fs.readdirSync(archive), []);
            assert.equal(fs.existsSync(config.FILES.fetchCheckpoint), false);
        } else {
            // 零个合成 arXiv 类别及本地来源调用让流程停在来源不完整守卫，不调用模型。
            await assert.rejects(pending, /核心抓取来源无可用候选，且存在致命来源失败/);
            assert.equal(sourceCalls, 1);
            const saved = JSON.parse(fs.readFileSync(config.FILES.fetchCheckpoint));
            assert.equal(saved.batchDate, '2026-10-10');
            assert.equal(saved.batchStartedAt, '2026-10-10T23:59:59.000+08:00');
            assert.deepEqual(fs.readFileSync(path.join(archive, '2026-10-09',
                path.basename(config.FILES.rawCandidates))), original);
        }
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const config = require(`${root}/scripts/config.js`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-backup-failure-'));
const current = path.join(dir, 'current');
const archive = path.join(dir, 'archive');
fs.mkdirSync(current);
fs.mkdirSync(archive);
for (const key of ['deepAnalysisResult', 'deepAnalysisResultLegacy', 'filteredPapers', 'papers', 'analyzed', 'rawCandidates', 'filterDecisions', 'fetchCheckpoint']) {
    config.FILES[key] = path.join(current, `${key}.json`);
}
config.CURRENT_DIR = current;
config.ARCHIVE_DIR = archive;
config.ARXIV_CATEGORIES = [];
const today = require(`${root}/scripts/utils.js`).getBeijingDateString();
const original = JSON.stringify({ batchDate: today, timestamp: today + 'T12:00:00+08:00', status: 'filtering', papers: [{ arxivId: '2601.00001', title: 'old selected candidate', fetchedAt: '2026-01-01T12:00:00+08:00' }] });
fs.writeFileSync(config.FILES.filteredPapers, original);
const utils = require(`${root}/scripts/utils.js`);
config.PUBLISH_CONFIG.blogRepo = require('./local-published-blog.cjs').createLocalPublishedBlog(dir);
const digest = require(`${root}/scripts/digest-status.js`);
digest.backupPapersJson = async () => ({ message: 'test isolated backup' });
digest.loadPapersDatabase = () => ({ papers: {} });
const hf = require(`${root}/scripts/fetch-huggingface-papers.js`);
let fetchCalls = 0;
hf.fetchHuggingFacePapers = async () => { fetchCalls++; return []; };
const copyFile = fs.copyFileSync;
let failures = 0;
fs.copyFileSync = (from, to, ...rest) => {
    if (String(to).startsWith(path.join(archive, 'cleanup') + path.sep)) {
        failures++;
        throw Object.assign(new Error('模拟归档存储不可写'), { code: 'EIO' });
    }
    return copyFile(from, to, ...rest);
};
(async () => {
    try {
        await assert.rejects(require(`${root}/scripts/full-fetch.js`).runFullFetch(), error => {
            assert.match(error.message, /清理前备份失败/);
            assert.equal(error.cause.code, 'EIO');
            return true;
        });
        assert.equal(failures, 1);
        assert.equal(fetchCalls, 0);
        assert.equal(fs.readFileSync(config.FILES.filteredPapers, 'utf8'), original);
        assert.equal(fs.readdirSync(path.join(archive, 'cleanup')).length, 0);
        for (const key of ['rawCandidates', 'fetchCheckpoint', 'filterDecisions', 'deepAnalysisResult']) {
            assert.equal(fs.existsSync(config.FILES[key]), false, key);
        }
    } finally {
        fs.copyFileSync = copyFile;
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

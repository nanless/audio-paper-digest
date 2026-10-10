'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const scenario = process.argv[2];
const config = require(`${root}/scripts/config.js`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r16-archive-loss-'));
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
let fetchCalls = 0;
const archivedFile = path.join(archive, '2026-01-01', path.basename(config.FILES.rawCandidates));
if (scenario === 'conflict') fs.mkdirSync(archivedFile, { recursive: true });
const original = JSON.stringify({ batchDate: '2026-01-01', timestamp: '2026-01-01T12:00:00+08:00', papers: [{ arxivId: '2601.00001', title: 'old raw candidate' }] });
fs.writeFileSync(config.FILES.rawCandidates, original);
const utils = require(`${root}/scripts/utils.js`);
config.PUBLISH_CONFIG.blogRepo = require('./local-published-blog.cjs').createLocalPublishedBlog(dir);
const digest = require(`${root}/scripts/digest-status.js`);
digest.backupPapersJson = async () => ({ message: 'test isolated backup' });
digest.loadPapersDatabase = () => ({ papers: {} });
const hf = require(`${root}/scripts/fetch-huggingface-papers.js`);
hf.fetchHuggingFacePapers = async () => { fetchCalls++; return []; };
const copyFile = fs.copyFileSync;
let failures = 0;
fs.copyFileSync = (from, to, ...rest) => {
    if (scenario === 'copy' && String(to).startsWith(archive + path.sep)) {
        failures++;
        throw Object.assign(new Error('模拟归档存储不可写'), { code: 'EIO' });
    }
    return copyFile(from, to, ...rest);
};
const unlink = fs.unlinkSync;
fs.unlinkSync = filename => {
    if (scenario === 'unlink' && filename === config.FILES.rawCandidates) {
        throw Object.assign(new Error('当前文件无法移走'), { code: 'EACCES' });
    }
    return unlink(filename);
};
(async () => {
    try {
        await assert.rejects(require(`${root}/scripts/full-fetch.js`).runFullFetch(), error => {
            assert.ok(error.cause);
            assert.match(error.message, /归档/);
            if (scenario !== 'conflict') assert.equal(error.cause.code, scenario === 'copy' ? 'EIO' : 'EACCES');
            return true;
        });
        assert.equal(fetchCalls, 0);
        assert.equal(fs.readFileSync(config.FILES.rawCandidates, 'utf8'), original);
        for (const key of ['fetchCheckpoint', 'filterDecisions', 'filteredPapers', 'deepAnalysisResult']) {
            assert.equal(fs.existsSync(config.FILES[key]), false, key);
        }
        if (scenario === 'unlink') assert.equal(fs.readFileSync(archivedFile, 'utf8'), original);
    } finally {
        fs.copyFileSync = copyFile;
        fs.unlinkSync = unlink;
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });

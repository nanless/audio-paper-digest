'use strict';

// 保留爬虫记录供只读审计和恢复，但不能据此写入来源对照表。
// 历史直接重写须重新抓取 arXiv，或重新核验会议本地来源目录。

const fs = require('node:fs');
const path = require('node:path');
const crosswalkApi = require('./page-source-crosswalk.js');

const RECORD_CONTRACT = 'historical-local-crawl-batch-record-v1';
const VERSION = 1;

function eligiblePages(state) {
    return state.source.papers.flatMap(paper => {
        const assignment = state.assignments[paper.pageKey]; const hints = paper.identityHints;
        if (assignment?.status !== 'pending' || hints?.status !== 'single' || hints.candidates?.length !== 1) return [];
        const hint = hints.candidates[0];
        if (hint.scheme !== 'arxiv' || !/^\d{4}\.\d{4,5}$/.test(hint.value)
            || !Array.isArray(hint.sources) || !hint.sources.length
            || hint.sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))) return [];
        return [{ arxivId: hint.value, pageKey: paper.pageKey, cohortDate: paper.cohortDate }];
    }).sort((left, right) => left.arxivId.localeCompare(right.arxivId) || left.pageKey.localeCompare(right.pageKey));
}
function selectMatch(matches, cohortDate) {
    const preferred = matches.filter(match => match.sourceRelativePath === `archive/${cohortDate}/filtered-papers.json`);
    const current = matches.filter(match => match.sourceKind === 'current');
    const archived = matches.filter(match => match.sourceKind === 'archive');
    // 顺序是刻意的：先同一批次的归档，再是保留的当前爬虫库，最后是另一个归档。
    // 这里没有任何标题或正文输入。
    return preferred[0] || current[0] || archived[0] || null;
}
function attemptDirectory(root, crosswalkId) {
    const safeRoot = crosswalkApi.safeDirectory(root, { create: true }); const directory = path.join(safeRoot, crosswalkId);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('本地爬虫批次路径必须是真实目录，不能是符号链接');
    return directory;
}
function fail(message) { throw new Error(`历史归档爬虫批次无法执行：${message}`); }
function writeAttemptRecord(root, record) {
    const body = { contract: RECORD_CONTRACT, version: VERSION, ...record };
    const sealed = { ...body, recordSha256: crosswalkApi.stableHash(body) };
    const directory = attemptDirectory(root, record.crosswalkId);
    const name = `local-crawl-${record.arxivId.replace('.', '-')}-${record.pageKey.slice(5)}-${record.attemptId}.json`;
    const filename = path.join(directory, name); const bytes = crosswalkApi.prettyBytes(sealed); let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return { filename, record: sealed };
}
async function runLocalCrawlBatch({ crosswalkRoot, identityRoot, snapshotRoot, dataRoot, batchRoot, crosswalkId, owner,
    limit = null, apply = true, concurrency = 3, recoveryPolicy = null } = {}, overrides = {}) {
    void crosswalkRoot; void identityRoot; void snapshotRoot; void dataRoot; void batchRoot; void crosswalkId; void owner;
    void limit; void apply; void concurrency; void recoveryPolicy; void overrides;
    fail('已停用通过本地爬虫修改来源对照表的流程；请使用 history:direct-inputs 和 history:direct-plan');

}

module.exports = { RECORD_CONTRACT, VERSION, eligiblePages, selectMatch, attemptDirectory, writeAttemptRecord,
    runLocalCrawlBatch, runArchiveCrawlBatch: runLocalCrawlBatch };

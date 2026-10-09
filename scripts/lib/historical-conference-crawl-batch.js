'use strict';

// 会议元数据和 PDF 由历史直接重写的本地来源流程处理，旧对照表写入器已停用。
// 按标题恢复论文身份只能用于页面映射，不能据此修改来源对照表。

const fs = require('node:fs');
const path = require('node:path');
const conferenceApi = require('./historical-conference-crawl-authority.js');
const crosswalkApi = require('./page-source-crosswalk.js');

const RECORD_CONTRACT = 'historical-conference-crawl-batch-record-v1';
const VERSION = 1;
const keyFor = hint => `${hint.scheme}:${hint.value}`;
function explicitHintGroups(state, matches) {
    const groups = new Map();
    for (const paper of state.source.papers) {
        if (state.assignments[paper.pageKey]?.status !== 'pending' || paper.identityHints?.status !== 'single' || paper.identityHints.candidates?.length !== 1) continue;
        const hint = paper.identityHints.candidates[0];
        if (!['icassp-arnumber', 'openreview-forum-id'].includes(hint.scheme) || !Array.isArray(hint.sources) || !hint.sources.length || hint.sources.some(source => /(?:^|:)title(?:$|:)/iu.test(source))) continue;
        const options = matches.get(keyFor(hint)) || [];
        if (options.length !== 1) continue;
        const item = groups.get(keyFor(hint)) || { externalId: { scheme: hint.scheme, value: hint.value }, match: options[0], pageKeys: [] };
        item.pageKeys.push(paper.pageKey); groups.set(keyFor(hint), item);
    }
    return [...groups.values()].map(item => ({ ...item, pageKeys: item.pageKeys.sort(), titleBindings: [] }));
}
function eligibleGroups(state, matches, { blogRoot = null } = {}) {
    const groups = explicitHintGroups(state, matches);
    if (blogRoot !== null) groups.push(...conferenceApi.titleRecoveryGroups({ state, blogRoot, matches }));
    return groups.sort((a, b) => keyFor(a.externalId).localeCompare(keyFor(b.externalId))
        || a.pageKeys.join(',').localeCompare(b.pageKeys.join(',')));
}
function mergeMatches(...indexes) {
    const merged = new Map();
    for (const index of indexes) for (const [key, values] of index.entries()) merged.set(key, [...(merged.get(key) || []), ...values]);
    for (const values of merged.values()) values.sort((a, b) => a.metadataSourceKind.localeCompare(b.metadataSourceKind)
        || a.metadataRelativePath.localeCompare(b.metadataRelativePath) || a.recordIndex - b.recordIndex);
    return merged;
}
function missingIclrTitleFingerprints(state, blogRoot, regularMatches) {
    const covered = new Set(eligibleGroups(state, regularMatches, { blogRoot }).flatMap(group => group.pageKeys)); const fingerprints = new Set();
    for (const page of state.source.papers) {
        if (page.scope?.key !== 'iclr-2026' || state.assignments[page.pageKey]?.status !== 'pending' || covered.has(page.pageKey)
            || !['none', 'conflict'].includes(page.identityHints?.status)) continue;
        fingerprints.add(conferenceApi.pageTitleBinding({ blogRoot, pageKey: page.pageKey, pagePath: page.pagePath,
            pageContentSha256: page.pageContentSha256 }).titleFingerprintSha256);
    }
    return fingerprints;
}
function attemptDirectory(root, crosswalkId) { const safeRoot = crosswalkApi.safeDirectory(root, { create: true }); const directory = path.join(safeRoot, crosswalkId); try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } const info = fs.lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('会议爬虫批次路径必须是真实目录，不能是符号链接'); return directory; }
function writeAttemptRecord(root, record) { const body = { contract: RECORD_CONTRACT, version: VERSION, ...record }; const sealed = { ...body, recordSha256: crosswalkApi.stableHash(body) }; const name = `conference-${record.externalId.value}-${record.attemptId}.json`; const filename = path.join(attemptDirectory(root, record.crosswalkId), name); let fd; try { fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); fs.writeFileSync(fd, crosswalkApi.prettyBytes(sealed)); fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); } finally { if (fd !== undefined) fs.closeSync(fd); } return { filename, record: sealed }; }
async function runConferenceCrawlBatch({ crosswalkRoot, identityRoot, dataRoot, batchRoot, blogRoot = null, iclrAcceptedRoot = null, crosswalkId, owner, limit = null, apply = true, concurrency = 3, recoveryPolicy = null } = {}, overrides = {}) {
    void crosswalkRoot; void identityRoot; void dataRoot; void batchRoot; void blogRoot; void iclrAcceptedRoot;
    void crosswalkId; void owner; void limit; void apply; void concurrency; void recoveryPolicy; void overrides;
    throw new Error('已停用旧会议爬虫批次；请使用 history:conference-local-sources、history:conference-projections 和 history:direct-plan');

}
module.exports = { RECORD_CONTRACT, VERSION, keyFor, explicitHintGroups, eligibleGroups, mergeMatches, missingIclrTitleFingerprints, attemptDirectory, writeAttemptRecord, runConferenceCrawlBatch };

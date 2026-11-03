'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { strictJson, readRegular, writeExact } = require('./publication-file-primitives');
const announcement = require('./daily-arxiv-announcement-source');
const { assertSafeDirectory } = require('./fresh-rewrite-run');
const eastern = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' });

function validateAnnouncementRestartCutoff(cutoff, previousUntil) {
    const instant = Date.parse(cutoff), previous = Date.parse(previousUntil);
    if (typeof cutoff !== 'string' || !Number.isFinite(instant) || new Date(instant).toISOString() !== cutoff
            || !Number.isFinite(previous) || instant >= previous) {
        throw new Error('公告截止时间必须是早于原抓取截止的标准 UTC 时间');
    }
    const parts = value => Object.fromEntries(eastern.formatToParts(value).map(part => [part.type, part.value]));
    const start = parts(instant), old = parts(previous);
    if (instant % 1000 !== 0 || start.hour !== '00' || start.minute !== '00' || start.second !== '00'
            || ['year', 'month', 'day'].some(key => start[key] !== old[key])) {
        throw new Error('公告截止时间必须是原抓取截止所在纽约日期的当地午夜');
    }
}

function assertNoDownstreamArtifacts(files) {
    for (const filename of files) {
        if (!filename) continue;
        if (fs.lstatSync(filename, { throwIfNoEntry: false })) {
            throw new Error('当日已存在筛选或分析数据，禁止为公告时间另开抓取范围');
        }
    }
}

async function prepareAnnouncementRestart({
    cutoff, previous, boundary, checkpointPath, rawPath, downstreamPaths, archiveRoot, categories,
    validatePrevious, requestScheduler
}) {
    validateAnnouncementRestartCutoff(cutoff, previous.until);
    if (boundary.until !== cutoff || boundary.lastDigestDate !== previous.lastDigestDate
            || boundary.since !== previous.since
            || JSON.stringify(boundary.continuity) !== JSON.stringify(previous.continuity)
            || JSON.stringify(boundary.provenance) !== JSON.stringify(previous.provenance)) {
        throw new Error('公告恢复不能改变原发布基线、重叠起点或连续性证明');
    }
    assertNoDownstreamArtifacts(downstreamPaths);
    const checkpoint = readRegular(checkpointPath);
    const raw = fs.lstatSync(rawPath, { throwIfNoEntry: false }) ? readRegular(rawPath) : null;
    const originalSources = validatePrevious(strictJson(checkpoint.bytes, '原抓取检查点'),
        raw ? strictJson(raw.bytes, '原抓取候选') : null);

    // Only immutable copies are written here. The normal writer later replaces
    // current after checking the original bytes again under the fetch lock.
    const directory = path.join(archiveRoot, checkpoint.sha256, crypto.randomUUID());
    writeExact(path.join(directory, 'fetch-checkpoint.json'), checkpoint.bytes);
    if (raw) writeExact(path.join(directory, 'raw-candidates.json'), raw.bytes);
    const announcements = new Map();
    for (const category of categories) {
        const evidenceDir = path.join(directory, 'rss', category.id);
        assertSafeDirectory(evidenceDir, true);
        const evidence = await announcement.fetchDailyAnnouncement(category.id, boundary, { evidenceDir, requestScheduler });
        if (announcement.replayDailyAnnouncement(evidence, boundary, category.id).pubDate !== cutoff) {
            throw new Error(`官方公告 ${category.id} 的实际发布时间不等于指定截止时间`);
        }
        announcements.set(category.id, evidence);
    }
    const manifestFile = path.join(directory, 'restart.json');
    const manifestSha256 = writeExact(manifestFile, Buffer.from(JSON.stringify({
        originalBoundary: previous, newBoundary: boundary,
        originalCheckpointSha256: checkpoint.sha256, originalRawCandidatesSha256: raw?.sha256 ?? null,
        originalSources,
        announcements: Object.fromEntries(announcements)
    }, null, 2) + '\n'));
    const assertCurrent = () => {
        assertNoDownstreamArtifacts(downstreamPaths);
        const rawNow = fs.lstatSync(rawPath, { throwIfNoEntry: false }) ? readRegular(rawPath) : null;
        if (!readRegular(checkpointPath).bytes.equals(checkpoint.bytes)
                || Boolean(rawNow) !== Boolean(raw) || (raw && !rawNow.bytes.equals(raw.bytes))) {
            throw new Error('公告恢复前原抓取检查点或候选文件发生变化，停止切换');
        }
    };
    assertCurrent();
    return { announcements, assertCurrent, manifestFile, manifestSha256 };
}

module.exports = { prepareAnnouncementRestart, validateAnnouncementRestartCutoff };

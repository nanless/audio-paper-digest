'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareAnnouncementRestart, validateAnnouncementRestartCutoff } = require('../scripts/lib/daily-announcement-restart');
const announcement = require('../scripts/lib/daily-arxiv-announcement-source');

const cutoff = '2026-11-03T05:00:00.000Z';
const previous = { since: '2026-10-29T21:44:00.000Z', until: '2026-11-03T05:30:06.796Z',
    lastDigestDate: '2026-11-02', continuity: { required: true }, provenance: { original: true } };
const boundary = { ...previous, until: cutoff };
const categoryIds = ['eess.AS', 'cs.SD', 'eess.SP', 'cs.AI', 'cs.LG', 'cs.MM', 'cs.CL'];

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-announcement-restart-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const checkpointPath = path.join(root, 'fetch-checkpoint.json'), rawPath = path.join(root, 'raw-candidates.json');
    const archiveRoot = path.join(root, 'archive'), downstreamPaths = [path.join(root, 'filtered-papers.json')];
    const originalCheckpoint = Buffer.from('{ "status": "failed" }\n');
    const originalRaw = Buffer.from('{ "papers": [] }\n');
    fs.writeFileSync(checkpointPath, originalCheckpoint);
    fs.writeFileSync(rawPath, originalRaw);
    const options = { cutoff, previous, boundary, checkpointPath, rawPath, archiveRoot, downstreamPaths,
        categories: categoryIds.map(id => ({ id })),
        validatePrevious: (checkpoint, raw) => {
            assert.deepEqual(checkpoint, { status: 'failed' });
            assert.deepEqual(raw, { papers: [] });
            return { arxiv: { 'eess.AS': 'failed', 'cs.SD': 'absent' }, huggingface: 'absent' };
        } };
    return { options, originalCheckpoint, originalRaw };
}

test('replacement cutoff is exact same-date midnight in New York across DST', () => {
    validateAnnouncementRestartCutoff(cutoff, previous.until);
    validateAnnouncementRestartCutoff('2026-10-19T04:00:00.000Z', '2026-10-19T04:31:00.000Z');
    for (const value of ['2026-11-03T04:00:00.000Z', '2026-11-02T05:00:00.000Z',
        '2026-11-03T05:00:00.001Z', '2026-11-03T05:30:06.796Z']) {
        assert.throws(() => validateAnnouncementRestartCutoff(value, previous.until), /公告截止时间/);
    }
});

test('restart preserves exact failed artifacts, requires all categories, and detects later CAS change', async t => {
    const { options, originalCheckpoint, originalRaw } = fixture(t);
    const categories = [];
    t.mock.method(announcement, 'fetchDailyAnnouncement', async (category, actualBoundary, { evidenceDir }) => {
        assert.equal(actualBoundary, boundary);
        assert.equal(fs.statSync(evidenceDir).mode & 0o777, 0o700);
        categories.push(category);
        return { category };
    });
    t.mock.method(announcement, 'replayDailyAnnouncement', (evidence, actualBoundary, category) => {
        assert.equal(evidence.category, category);
        assert.equal(actualBoundary, boundary);
        return { pubDate: cutoff };
    });
    const result = await prepareAnnouncementRestart(options);
    assert.deepEqual(categories, categoryIds);
    assert.deepEqual([...result.announcements.keys()], categoryIds);
    const archive = path.dirname(result.manifestFile);
    const saved = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
    assert.equal(saved.originalSources.arxiv['cs.SD'], 'absent');
    assert.equal(saved.originalSources.huggingface, 'absent');
    assert.deepEqual(fs.readFileSync(path.join(archive, 'fetch-checkpoint.json')), originalCheckpoint);
    assert.deepEqual(fs.readFileSync(path.join(archive, 'raw-candidates.json')), originalRaw);
    assert.deepEqual(fs.readFileSync(options.checkpointPath), originalCheckpoint);
    assert.deepEqual(fs.readFileSync(options.rawPath), originalRaw);
    fs.appendFileSync(options.rawPath, '\n');
    assert.throws(() => result.assertCurrent(), /原抓取检查点或候选文件发生变化/);
});

test('restart refuses paid downstream artifacts and fails closed when any category date differs', async t => {
    const { options, originalCheckpoint } = fixture(t);
    let dispatched = 0;
    t.mock.method(announcement, 'fetchDailyAnnouncement', async category => {
        dispatched++; return { category };
    });
    t.mock.method(announcement, 'replayDailyAnnouncement', ({ category }) =>
        ({ pubDate: category === 'cs.SD' ? '2026-11-04T05:00:00.000Z' : cutoff }));
    fs.writeFileSync(options.downstreamPaths[0], '{}');
    await assert.rejects(prepareAnnouncementRestart(options), /已存在筛选或分析/);
    assert.equal(dispatched, 0);
    fs.unlinkSync(options.downstreamPaths[0]);
    await assert.rejects(prepareAnnouncementRestart(options), /cs\.SD.*实际发布时间/);
    assert.equal(dispatched, 2);
    assert.deepEqual(fs.readFileSync(options.checkpointPath), originalCheckpoint);
});

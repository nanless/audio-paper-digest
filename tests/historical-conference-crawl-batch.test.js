'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const batch = require('../scripts/lib/historical-conference-crawl-batch.js');
const cli = require('../scripts/historical-conference-crawl-batch.js');

const options = { crosswalkRoot: '/tmp/crosswalk', identityRoot: '/tmp/identity', dataRoot: '/tmp/data', batchRoot: '/tmp/batch',
    blogRoot: '/tmp/blog', iclrAcceptedRoot: '/tmp/iclr', crosswalkId: '11111111-1111-4111-8111-111111111111', owner: 'worker' };

test('已停用的会议抓取批次在读取元数据、标题或对照表状态之前就失败', async () => {
    let read = 0;
    await assert.rejects(batch.runConferenceCrawlBatch(options, { readCrosswalk: () => { read++; throw new Error('must not read'); } }), /retired/);
    assert.equal(read, 0);
});

test('旧版会议命令包装器是个会明确报错的兼容入口，直接失败', async () => {
    assert.throws(() => cli.parseArgs(['--dry-run']), /retired/);
    await assert.rejects(cli.main(['--apply']), /retired/);
});

test('显式的非标题分组仍只是纯函数辅助，不是执行入口', () => {
    const pageKey = `page:${'a'.repeat(64)}`;
    const state = { source: { papers: [{ pageKey, identityHints: { status: 'single', candidates: [
        { scheme: 'openreview-forum-id', value: 'AbCdef_12', sources: ['body:openreview-link'] }] } }] },
    assignments: { [pageKey]: { status: 'pending' } } };
    const matches = new Map([['openreview-forum-id:AbCdef_12', [{ conference: { slug: 'icml', year: 2026 },
        externalId: { scheme: 'openreview-forum-id', value: 'AbCdef_12' } }]]]);
    assert.equal(batch.explicitHintGroups(state, matches).length, 1);
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const batch = require('../scripts/lib/historical-archive-crawl-batch.js');
const cli = require('../scripts/historical-archive-crawl-batch.js');
const localCli = require('../scripts/historical-local-crawl-batch.js');

const options = { crosswalkRoot: '/tmp/crosswalk', identityRoot: '/tmp/identity', snapshotRoot: '/tmp/snapshots',
    dataRoot: '/tmp/data', batchRoot: '/tmp/batch', crosswalkId: '11111111-1111-4111-8111-111111111111', owner: 'worker' };

test('保留的本地爬虫批次在打开数据或对照表状态之前就失败', async () => {
    let read = 0;
    await assert.rejects(batch.runLocalCrawlBatch(options, { readCrosswalk: () => { read++; throw new Error('不应读取来源对照表'); } }), /已停用/);
    assert.equal(read, 0);
});

test('旧版归档和本地命令包装器是会明确报错的直接失败兼容入口', async () => {
    assert.throws(() => cli.parseArgs(['--dry-run']), /已停用/);
    await assert.rejects(cli.main(['--dry-run']), /已停用/);
    assert.throws(() => localCli.parseArgs(['--apply']), /已停用/);
    await assert.rejects(localCli.main(['--apply']), /已停用/);
});

test('只读的保留来源偏好辅助函数对审计工具保持确定性', () => {
    const matches = [{ sourceRelativePath: 'archive/2026-02-03/filtered-papers.json', sourceKind: 'archive' },
        { sourceRelativePath: 'current/papers.json', sourceKind: 'current' }];
    assert.equal(batch.selectMatch(matches, '2026-02-03').sourceRelativePath, 'archive/2026-02-03/filtered-papers.json');
});

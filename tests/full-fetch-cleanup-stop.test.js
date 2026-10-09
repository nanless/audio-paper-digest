'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('真实日更在旧论文清理备份失败后停止抓取，保留原入选文件', () => {
    const result = spawnSync(process.execPath, [
        path.join(__dirname, 'fixtures/full-fetch-cleanup-stop.cjs')
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

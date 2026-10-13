'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('正常日更分析并发10仍由来源默认上限封存，并登记同一计划完成收尾', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/full-fetch-capture-final-sync.cjs')], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOCAL_FULL_FETCH_CAPTURE_REGISTER_ANALYZE_SYNC_PASS/);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const scenario of ['copy', 'conflict', 'unlink']) {
    test(`真实日更主流程在归档${scenario}失败后停止，旧候选不会被新批次覆盖`, () => {
        const result = spawnSync(process.execPath, [
            path.join(__dirname, 'fixtures/full-fetch-archive-stop.cjs'), scenario
        ], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
}

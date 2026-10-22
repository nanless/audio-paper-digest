'use strict';
const test = require('node:test');
const assert = require('node:assert');
const locks = require('../scripts/locks');

test('scanLocks 读取锁文件并判断存活/陈旧', () => {
    const rows = locks.scanLocks(['data/runtime'], Date.now());
    assert.ok(Array.isArray(rows));
    for (const row of rows) assert.ok(typeof row.file === 'string');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const names = { 'same-day': '同日启动后跨日仍保留原批次', 'no-date': '不传日期时使用启动当天',
    'wrong-day': '错日请求在归档前拒绝', 'wait-midnight': '等待真实锁跨日后在归档前拒绝',
    'invalid-date': '参数要求有效日期或空参数' };
for (const scenario of Object.keys(names)) {
    test(`日更锁内日期检查：${names[scenario]}`, () => {
        const child = spawnSync(process.execPath,
            [path.join(__dirname, 'fixtures/full-fetch-start-date.cjs'), scenario],
            { encoding: 'utf8', timeout: 15000 });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stdout + child.stderr);
    });
}

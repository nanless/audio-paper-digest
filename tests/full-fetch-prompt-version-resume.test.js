'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const [scenario, title] of [
    ['unchanged', '相同提示词续筛选只请求未决定论文，保留已付费回答'],
    ['changed', '新提示词重新判断全部模型候选，复用完整来源并本地重建关键词决定']
]) {
    test(title, () => {
        const result = spawnSync(process.execPath,
            [path.join(__dirname, 'fixtures/full-fetch-prompt-version-resume.cjs'), scenario],
            { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
}

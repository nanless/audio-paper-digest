'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
for (const [scenario, description] of Object.entries({
    'arxiv-failed': 'arXiv 后页失败而其他来源有候选时，保留恢复依据并停止筛选请求',
    'hf-failed': 'HuggingFace 后页失败而其他来源有候选时，保留恢复依据并停止筛选请求',
    complete: '完整来源仍进入真实筛选请求封装',
    'resume-failed': '续筛选来源缺失时保留原记录且不请求模型',
    'resume-complete': '完整来源续筛选仍进入真实请求封装'
})) {
    test(description, () => {
        const result = childProcess.spawnSync(process.execPath,
            [path.join(__dirname, 'fixtures/full-fetch-source-before-filter.cjs'), scenario],
            { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
}

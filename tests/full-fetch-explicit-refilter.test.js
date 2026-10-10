'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cases = [
    ['normal', '普通完整筛选续跑继续复用全部有效决定'],
    ['raw-content-damaged', '候选正文与来源检查点不符时，即使重算自己的指纹也拒绝模型请求'],
    ['cli', '显式重筛参数支持多个论文并要求复核原因'],
    ['audit-write-failed', '真实新响应的审计保存失败时停止来源抓取'],
    ['complete', '完整筛选记录仍重新判断指定论文，并保留其他付费决定'],
    ['partial', '未完成筛选可重新判断指定论文并继续原来尚未判断的论文'],
    ['failure', '重新判断认证失败后保留原决定审计，不把旧结果重新记为成功'],
    ['keyword', '拒绝重筛关键词排除的论文'],
    ['input-damaged', '原决定输入指纹不符时在模型请求前拒绝'],
    ['analysis-started', '同批已开始封存分析时拒绝更改入选集合'],
    ['missing-reason', '程序调用缺少重筛原因时拒绝'],
    ['unknown-id', '指定论文不在当前候选中时拒绝']
];
for (const [scenario, title] of cases) {
    test(title, () => {
        const result = spawnSync(process.execPath,
            [path.join(__dirname, 'fixtures/full-fetch-explicit-refilter.cjs'), scenario],
            { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
}

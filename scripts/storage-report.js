#!/usr/bin/env node
'use strict';
// 存储保留建议：只读。显示 storage:status 概览，并按类别给出“必须保留/可压缩/可删”的建议。
const storage = require('./runtime-storage.js');
const { requireExternalRuntime } = require('./env-loader.js');

const ADVICE = Object.freeze([
    { kind: '必须保留', paths: '封存来源、data/current 正式 JSON、发布/审查/视觉清单、费用账本', reason: '可重新核验的运行证据，prune 不删' },
    { kind: '可压缩', paths: '旧日期生成清单、旧审查通过缓存、归档成品', reason: '保留内容身份即可，压缩前核对引用' },
    { kind: '可删', paths: 'logs/、image-cache/、api-reader-assets/、visual-reference-inputs/、旧调试目录', reason: '超过保留期且无正式 JSON 引用；先 dry-run 预览' }
]);

function adviceLines() {
    return ADVICE.map(item => `- ${item.kind}：${item.paths}（${item.reason}）`);
}

function main(argv = process.argv.slice(2)) {
    try { requireExternalRuntime('storage-report.js'); } catch (error) { console.error(`[storage-report] ${error.message}`); return 1; }
    if (argv.includes('--help')) {
        console.log('用法: node scripts/storage-report.js [--advice-only]');
        console.log('只读：默认运行 storage:status 概览并打印保留建议；--advice-only 只打印建议。');
        return 0;
    }
    let statusFailed = false;
    if (!argv.includes('--advice-only')) {
        try { storage.main(['status']); if (process.exitCode === 1) statusFailed = true; } catch (error) { console.error(`[storage-report] status 失败：${error.message}`); statusFailed = true; }
    }
    console.log('\n保留建议：');
    for (const line of adviceLines()) console.log(line);
    console.log('\n清理必须先预览：npm run storage:prune（不加 --apply 只打印清单）；真正删除前停止全部抓取/分析/发布/视觉任务。');
    return statusFailed ? 1 : 0;
}

module.exports = { ADVICE, adviceLines, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[storage-report] ${error.message}`); process.exitCode = 1; }
}

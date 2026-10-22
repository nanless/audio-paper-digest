#!/usr/bin/env node
'use strict';
// 只读核对审查误报记录：校验 schema、匹配失败页 SHA 与逐字 claim，报告可降级数量；不修改审查结果。
const fs = require('node:fs');
const path = require('node:path');
const { validateOverrides, applyOverrides } = require('./lib/review-overrides');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('review-overrides-cli.js'); } catch (error) { console.error(`[review-overrides] ${error.message}`); return 1; }
    let date = null; let file = null; let json = false; let failureFileOption = null;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') date = argv[++index] || null;
        else if (value === '--file') file = path.resolve(argv[++index] || '');
        else if (value === '--json') json = true;
        else if (value === '--failure-file') failureFileOption = path.resolve(argv[++index] || '');
        else if (value === '--help') { console.log('用法: node scripts/review-overrides-cli.js --date DATE --file OVERRIDES.json [--json]'); return 0; }
        else throw new Error(`未知参数：${value}`);
    }
    if (!date || !file) throw new Error('需要 --date 与 --file');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date 必须是 YYYY-MM-DD');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (payload.batchDate && date && payload.batchDate !== date) throw new Error(`overrides.batchDate=${payload.batchDate} 与 --date ${date} 不一致`);
    const overrides = validateOverrides(payload);
    const failureFile = failureFileOption || path.join(CURRENT, `blog-review-failure-${date}.json`);
    if (!fs.existsSync(failureFile)) throw new Error(`找不到审查失败文件：${failureFile}`);
    const failure = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
    const { matched } = applyOverrides(failure, overrides);
    const remaining = [
        ...(failure.files || []).flatMap(item => (item.issues || [])),
        ...(failure.issues || [])
    ].filter(issue => /error/i.test(String(issue.severity || issue.level || '')));
    const report = { date, overrides: overrides.length, matched, remainingErrors: remaining.length, wouldPass: remaining.length === 0 };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`误报记录：${overrides.length} 条，匹配 ${matched} 条，匹配后剩余 error ${remaining.length} 个。`);
        console.log(report.wouldPass ? '若人工复核这些记录成立，则该批审查失败项可全部解释为误报。' : '仍有真实 error 未覆盖，不能仅凭 overrides 放行。');
        console.log('本命令只读；不会修改失败文件或审查凭证。');
    }
    return 0;
}

module.exports = { main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[review-overrides] ${error.message}`); process.exitCode = 1; }
}

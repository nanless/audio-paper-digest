#!/usr/bin/env node
'use strict';
// 只读核对审查误报记录：校验 schema、匹配失败页 SHA 与逐字 claim，报告可降级数量；不修改审查结果。
const fs = require('node:fs');
const path = require('node:path');
const { validateOverrides, applyOverrides, assertReceiptBinding } = require('./lib/review-overrides');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');
const USAGE = 'node scripts/review-overrides-cli.js --date DATE --file OVERRIDES.json '
    + '[--receipt REVIEW_RECEIPT.json] [--failure-file PATH] [--json]';

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('review-overrides-cli.js'); } catch (error) { console.error(`[review-overrides] ${error.message}`); return 2; }
    // help 优先：后面跟未知参数也只看 help，不报未知参数错误。
    if (argv.includes('--help')) {
        const asJson = argv.includes('--json');
        console.log(asJson ? JSON.stringify({ usage: USAGE }) : `用法: ${USAGE}`);
        return 0;
    }
    let date = null; let file = null; let json = false; let failureFileOption = null; let receiptPath = null;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') date = argv[++index] || null;
        else if (value === '--file') file = path.resolve(argv[++index] || '');
        else if (value === '--json') json = true;
        else if (value === '--failure-file') failureFileOption = path.resolve(argv[++index] || '');
        else if (value === '--receipt') receiptPath = path.resolve(argv[++index] || '');
        else throw new Error(`未知参数：${value}`);
    }
    if (!date || !file) throw new Error('需要 --date 与 --file');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date 必须是 YYYY-MM-DD');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (payload.batchDate && date && payload.batchDate !== date) throw new Error(`overrides.batchDate=${payload.batchDate} 与 --date ${date} 不一致`);
    const overrides = validateOverrides(payload);
    if (receiptPath) {
        let receipt;
        try {
            receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        } catch (error) {
            console.error(`[review-overrides] 无法读取审查凭证：${receiptPath}: ${error.message}`);
            return 2;
        }
        let bound;
        try {
            bound = assertReceiptBinding(payload.publicationCommit, receipt);
        } catch (error) {
            console.error(`[review-overrides] ${error.message}`);
            return 2;
        }
        if (!bound) {
            console.warn('[review-overrides] 警告：审查凭证没有 publicationCommit/reviewedCommit/commit，'
                + '无法绑定发布提交；继续只按 batchDate 校验');
        } else {
            console.log(`[review-overrides] 审查凭证绑定通过：${bound.field}=${bound.commit}`);
        }
    }
    const failureFile = failureFileOption || path.join(CURRENT, `blog-review-failure-${date}.json`);
    if (!fs.existsSync(failureFile)) throw new Error(`找不到审查失败文件：${failureFile}`);
    const failure = JSON.parse(fs.readFileSync(failureFile, 'utf8'));
    const { matched } = applyOverrides(failure, overrides);
    const remaining = [
        ...(failure.files || []).flatMap(item => (item.issues || [])),
        ...(failure.issues || [])
    ].filter(issue => /error/i.test(String(issue.severity || issue.level || '')));
    // passed:false 的页面（pending/transient）也是真实阻断，override 不能把它们改成通过。
    const errorIssuesOf = file => (file.issues || []).filter(issue => /error/i.test(String(issue.severity || issue.level || '')));
    const failedFiles = (failure.files || []).filter(file => file.passed !== true);
    // 真正无法解释的 pending：失败但没有任何 error issue 可被 override。
    const everOverridden = file => (file.issues || []).some(issue => issue.overridden === true);
    const pendingBlockedFiles = failedFiles.filter(file => errorIssuesOf(file).length === 0 && !everOverridden(file)).length;
    // 曾失败但所有 error 均已由严格记录解释的页面，单独计数，供人工复核。
    const overriddenFailedPages = failedFiles.filter(file => everOverridden(file) && errorIssuesOf(file).length === 0).length;
    const report = { date, overrides: overrides.length, matched, remainingErrors: remaining.length, pendingBlockedFiles, overriddenFailedPages, wouldPass: remaining.length === 0 && pendingBlockedFiles === 0 };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`误报记录：${overrides.length} 条，匹配 ${matched} 条，匹配后剩余 error ${remaining.length} 个，未解释 pending 页 ${pendingBlockedFiles} 个，已被解释的失败页 ${overriddenFailedPages} 个。`);
        console.log(report.wouldPass ? '若人工复核这些记录成立，则该批审查失败项可全部解释为误报（不含 pending 页面）。' : '仍有真实 error 或 pending/未通过页未覆盖，不能仅凭 overrides 放行。');
        console.log('本命令只读；不会修改失败文件或审查凭证。');
    }
    // 仅在全部 error 都被严格记录覆盖时返回 0，可作为门禁的只读预检。
    return report.wouldPass ? 0 : 1;
}

module.exports = { main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[review-overrides] ${error.message}`); process.exitCode = 2; }
}

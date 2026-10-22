#!/usr/bin/env node
'use strict';
// 只读核对审查误报记录：校验 schema、匹配失败页 SHA 与逐字 claim，报告可降级数量；不修改审查结果。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
    const receiptCheck = { provided: Boolean(receiptPath), status: 'not_requested', field: null,
        commitFieldMatched: false, receiptContractVerified: false };
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
            receiptCheck.status = 'field_missing';
            console.warn('[review-overrides] 警告：审查凭证没有 publicationCommit/reviewedCommit/commit，'
                + '无法比较参考提交字段；未验证正式凭证合同');
        } else {
            receiptCheck.status = 'field_matched';
            receiptCheck.field = bound.field;
            receiptCheck.commitFieldMatched = true;
        }
    }
    const failureFile = failureFileOption || path.join(CURRENT, `blog-review-failure-${date}.json`);
    if (!fs.existsSync(failureFile)) throw new Error(`找不到审查失败文件：${failureFile}`);
    const sourceBytes = fs.readFileSync(failureFile);
    const failure = JSON.parse(sourceBytes.toString('utf8'));
    const hasFailureDate = Object.prototype.hasOwnProperty.call(failure, 'date');
    if (hasFailureDate && failure.date !== date) throw new Error('failure.date 与 --date 不一致');
    const failureDateCheck = { status: hasFailureDate ? 'field_matched' : 'not_present', formalScopeVerified: false };
    const files = failure.files || [];
    const inputDeclaredIssuesByPage = files.map(file => (file.issues || [])
        .flatMap((issue, index) => issue.overridden === true ? [index] : []));
    const inputDeclaredOverridden = {
        issueCount: [...files.flatMap(file => file.issues || []), ...(failure.issues || [])]
            .filter(issue => issue.overridden === true).length,
        failedPageCount: files.filter(file => file.passed !== true
            && (file.issues || []).some(issue => issue.overridden === true)).length
    };
    const { matched, matchedIssues, matches } = applyOverrides(failure, overrides);
    const remaining = [
        ...(failure.files || []).flatMap(item => (item.issues || [])),
        ...(failure.issues || [])
    ].filter(issue => /error/i.test(String(issue.severity || issue.level || '')));
    const errorIssuesOf = file => (file.issues || []).filter(issue => /error/i.test(String(issue.severity || issue.level || '')));
    const failedFiles = files.filter(file => file.passed !== true);
    // 保留旧投影，明确它包含输入自带标记，不作为 v2 退出依据。
    const everOverridden = file => (file.issues || []).some(issue => issue.overridden === true);
    const pendingBlockedFiles = failedFiles.filter(file => errorIssuesOf(file).length === 0 && !everOverridden(file)).length;
    const overriddenFailedPages = failedFiles.filter(file => everOverridden(file) && errorIssuesOf(file).length === 0).length;
    const legacyProjection = { pendingBlockedFiles, overriddenFailedPages,
        wouldPass: remaining.length === 0 && pendingBlockedFiles === 0 };
    const matchedPages = new Set(matches.filter(match => match.scope === 'page').map(match => match.fileIndex));
    const matchedIssueKeys = new Set(matches.filter(match => match.scope === 'page')
        .map(match => `${match.fileIndex}:${match.issueIndex}`));
    const explainedFailedPages = files.filter((file, index) => file.passed !== true
        && matchedPages.has(index) && errorIssuesOf(file).length === 0
        && inputDeclaredIssuesByPage[index].every(issueIndex => matchedIssueKeys.has(`${index}:${issueIndex}`))).length;
    const unexplainedFailedPages = failedFiles.length - explainedFailedPages;
    const currentMatchVerdict = { status: remaining.length === 0 && unexplainedFailedPages === 0 ? 'clear' : 'blocked',
        remainingErrors: remaining.length, unexplainedFailedPages, explainedFailedPages };
    const report = { diagnosticReportVersion: 2, scope: 'explanation-only', date,
        sourceFailureSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
        overrides: overrides.length, matched, matchedIssues, matches, inputDeclaredOverridden,
        remainingErrors: remaining.length, ...legacyProjection, legacyProjection, currentMatchVerdict, failureDateCheck, receiptCheck };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(`误报记录：${overrides.length} 条，本次匹配 ${matched} 条记录/${matchedIssues} 个问题，剩余 error ${remaining.length} 个，缺少本次完整解释的失败页 ${unexplainedFailedPages} 个。`);
        console.log(`输入旧 overridden 标记 ${inputDeclaredOverridden.issueCount} 个；legacy wouldPass=${legacyProjection.wouldPass} 仅保留旧投影，不决定退出码。`);
        if (!hasFailureDate) console.log('失败文件未声明 date；保留旧输入兼容，未核验正式日期范围。');
        if (receiptCheck.commitFieldMatched) console.log(`参考提交字段 ${receiptCheck.field} 相等；未验证正式凭证合同。`);
        console.log(currentMatchVerdict.status === 'clear' ? '本次解释诊断无剩余阻断；解释是否成立仍需人工核对，结果不授审查或发布资格。' : '本次解释仍有阻断；不能以输入旧标记替代本次匹配。');
        console.log('本命令只读；不会修改失败文件或审查凭证。诊断报告 v2 的严格退出依据为 currentMatchVerdict。');
    }
    return currentMatchVerdict.status === 'clear' ? 0 : 1;
}

module.exports = { main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[review-overrides] ${error.message}`); process.exitCode = 2; }
}

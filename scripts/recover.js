#!/usr/bin/env node
'use strict';
// 只读恢复决策：读当前失败集，按错误码给出唯一建议入口与可复制命令。
// 默认只打印计划；--execute --yes 才会调用既有入口（仍受原入口的全部门禁）。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const errorCodes = require('./lib/error-codes.js');
const { redactSensitive } = require('./lib/error-guidance.js');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

function beijingDate(now = new Date()) {
    const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function collectFailures(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('--date 必须是 YYYY-MM-DD');
    const failures = [];
    const analysis = readJson(path.join(CURRENT, 'deep-analysis-result.json'));
    const papers = analysis && Array.isArray(analysis.papers) ? analysis.papers : [];
    if (analysis && analysis.batchDate && analysis.batchDate !== date) {
        process.stderr.write(`[recover] 警告：分析结果 batchDate=${analysis.batchDate} 与请求日期 ${date} 不同，可能不是同一批次。\n`);
    }
    for (const paper of papers) {
        const message = paper.latestAnalysisAttemptError || paper.error || '';
        const code = paper.latestAnalysisAttemptErrorCode || '';
        const statusHint = String(paper.digestStatus?.latestAttemptStatus || paper.analysisStatus || '');
        if (!message && !code && statusHint !== 'analysis_failed' && !paper.analysisFactReviewObligation) continue;
        if (message || code || statusHint === 'analysis_failed') {
        const entry = errorCodes.classify(`${code} ${message}`);
        failures.push({
            source: 'analysis', paperId: (paper.arxivId || paper.paper_id || '').replace(/v\d+$/, ''),
            code: entry.id, label: entry.label, retryable: entry.retryable,
            command: entry.command.replace(/<DATE>/g, date), doc: entry.doc,
            message: redactSensitive(String(message)).slice(0, 200)
        });
        }
        if (paper.analysisFactReviewObligation) {
            failures.push({ source: 'analysis', paperId: (paper.arxivId || paper.paper_id || '').replace(/v\d+$/, ''),
                code: 'reader-repair-no-progress', label: '事实反馈义务未完成', retryable: false,
                command: `npm run recover -- --date ${date}`, doc: 'docs/reader-explicit-retry.md', message: '存在 analysisFactReviewObligation，须先完成当前事实反馈。' });
        }
    }
    const review = readJson(path.join(CURRENT, `blog-review-failure-${date}.json`));
    const files = review && Array.isArray(review.files) ? review.files : [];
    for (const file of files) {
        const issues = Array.isArray(file.issues) ? file.issues : [];
        for (const issue of issues) {
            if (!/error/i.test(String(issue.severity || issue.level || ''))) continue;
            const description = String(issue.description || issue.message || issue.issue || '');
            const entry = errorCodes.classify(description);
            failures.push({ source: 'review', page: String(file.path || '').split('/').pop(),
                code: entry.id, label: entry.label, retryable: entry.retryable,
                command: entry.command.replace(/<DATE>/g, date), doc: entry.doc, message: redactSensitive(description).slice(0, 200) });
        }
        if (file.passed !== true && !issues.some(issue => /error/i.test(String(issue.severity || issue.level || '')))) {
            failures.push({ source: 'review', page: String(file.path || '').split('/').pop(),
                code: 'blog-push-guard', label: '页面未通过审查或未完成', retryable: false,
                command: `npm run blog:review -- --date ${date}`, doc: 'docs/maintenance.md',
                message: String(file.failureKind || 'passed=false').slice(0, 200) });
        }
    }
    if (review && Array.isArray(review.issues) && !files.length) for (const issue of review.issues) {
        if (!/error/i.test(String(issue.severity || issue.level || ''))) continue;
        const description = String(issue.description || issue.message || issue.issue || '');
        const entry = errorCodes.classify(description);
        failures.push({
            source: 'review', page: String(issue.file || issue.path || '').split('/').pop(),
            code: entry.id, label: entry.label, retryable: entry.retryable,
            command: entry.command.replace(/<DATE>/g, date), doc: entry.doc,
            message: description.slice(0, 200)
        });
    }
    return failures;
}

function plan(failures) {
    const byCommand = new Map();
    for (const failure of failures) {
        const key = failure.command;
        if (!byCommand.has(key)) byCommand.set(key, { command: key, code: failure.code, label: failure.label, retryable: failure.retryable, items: [] });
        byCommand.get(key).items.push(failure);
    }
    return [...byCommand.values()].sort((left, right) => left.command.localeCompare(right.command));
}

function render(date, failures, groups) {
    const lines = [`恢复计划（${date}）：${failures.length} 个失败项，${groups.length} 个建议入口`];
    for (const group of groups) {
        lines.push(`\n建议入口：${group.command}`);
        lines.push(`  类型：${group.label}（${group.code}，${group.retryable ? '可重试' : '需检查后再试'}）`);
        for (const item of group.items.slice(0, 8)) {
            lines.push(`  - ${item.source === 'review' ? `页面 ${item.page || '?'}` : `论文 ${item.paperId || '?'}`}：${item.message}`);
        }
        if (group.items.length > 8) lines.push(`  …还有 ${group.items.length - 8} 项`);
    }
    if (!failures.length) lines.push('未发现失败项；可用 npm run digest:status -- --date <DATE> 查看完整状态。');
    lines.push('\n注意：recover 默认只读；--execute --yes 才会调用上面的入口，且入口自身门禁仍然生效。');
    return lines.join('\n');
}

function buildExecutionArgs(command, date) {
    const tokens = String(command || '').trim().split(/\s+/);
    if (tokens[0] !== 'npm' || tokens[1] !== 'run' || !tokens[2]) return null;
    if (tokens[2] === 'recover' || String(command).includes('<FILE>') || String(command).includes('SPEC.json')) return null;
    const extras = tokens.slice(3).filter(token => token !== '--').map(token => token === '<DATE>' ? date : token);
    if (extras.some(token => token.startsWith('<') && token.endsWith('>'))) return null;
    // 日期已由 collectFailures 把 <DATE> 替换；不要给不认 --date 的工具（config:check/validate:data）自动补参数。
    return ['run', tokens[2], '--', ...extras];
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('recover.js'); } catch (error) { console.error(`[recover] ${error.message}`); return 1; }

    const options = { date: null, json: false, execute: false, yes: false, strict: false };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') options.date = argv[++index] || null;
        else if (value === '--json') options.json = true;
        else if (value === '--execute') options.execute = true;
        else if (value === '--yes') options.yes = true;
        else if (value === '--strict') options.strict = true;
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    if (options.help) { console.log('用法: node scripts/recover.js --date YYYY-MM-DD [--json] [--execute --yes]'); return 0; }
    const date = options.date || beijingDate();
    const failures = collectFailures(date);
    const groups = plan(failures);
    if (options.json) console.log(JSON.stringify({ date, failures, plan: groups }, null, 2));
    else console.log(render(date, failures, groups));
    if (!options.execute) return options.strict && failures.length ? 1 : 0;
    if (!options.yes) throw new Error('--execute 需要同时传 --yes（确认会调用真实入口）');
    for (const group of groups) {
        if (!group.command.startsWith('npm run ')) { console.log(`\n跳过非 npm 命令（请手工执行）：${group.command}`); continue; }
        const args = buildExecutionArgs(group.command, date);
        if (!args) { console.log(`\n需手工执行（含占位符或自指）：${group.command}`); continue; }
        console.log(`\n执行：npm ${args.join(' ')}（来自 ${group.code}）`);
        const result = spawnSync('npm', args, { stdio: 'inherit', cwd: ROOT });
        if (result.status !== 0) return result.status || 1;
    }
    return 0;
}

module.exports = { beijingDate, buildExecutionArgs, collectFailures, plan, render, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[recover] ${error.message}`); process.exitCode = 1; }
}

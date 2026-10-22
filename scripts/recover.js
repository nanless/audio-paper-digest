#!/usr/bin/env node
'use strict';
// 只读恢复决策：读当前失败集，按错误码给出唯一建议入口与可复制命令。
// 默认只打印计划；--execute --yes 才会调用既有入口（仍受原入口的全部门禁）。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const errorCodes = require('./lib/error-codes.js');

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
    const failures = [];
    const analysis = readJson(path.join(CURRENT, 'deep-analysis-result.json'));
    const papers = analysis && Array.isArray(analysis.papers) ? analysis.papers : [];
    for (const paper of papers) {
        const message = paper.latestAnalysisAttemptError || paper.error || '';
        const code = paper.latestAnalysisAttemptErrorCode || '';
        if (!message && !code) continue;
        const entry = errorCodes.classify(`${code} ${message}`);
        failures.push({
            source: 'analysis', paperId: (paper.arxivId || paper.paper_id || '').replace(/v\d+$/, ''),
            code: entry.id, label: entry.label, retryable: entry.retryable,
            command: entry.command.replace(/<DATE>/g, date), doc: entry.doc,
            message: String(message).slice(0, 200)
        });
    }
    const review = readJson(path.join(CURRENT, `blog-review-failure-${date}.json`));
    const issues = review && Array.isArray(review.issues) ? review.issues : [];
    for (const issue of issues) {
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

function main(argv = process.argv.slice(2)) {
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
        if (!group.command.startsWith('npm run ')) continue;
        const script = group.command.slice('npm run '.length).split(/\s+/)[0];
        console.log(`\n执行：npm run ${script}（来自 ${group.code}）`);
        const result = spawnSync('npm', ['run', script], { stdio: 'inherit', cwd: ROOT });
        if (result.status !== 0) return result.status || 1;
    }
    return 0;
}

module.exports = { beijingDate, collectFailures, plan, render, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[recover] ${error.message}`); process.exitCode = 1; }
}

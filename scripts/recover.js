#!/usr/bin/env node
'use strict';
// 只读恢复决策：读当前失败集，按错误码给出唯一建议入口与可复制命令。
// 默认只打印计划；--execute --yes 才会调用既有入口（仍受原入口的全部门禁）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const errorCodes = require('./lib/error-codes.js');
const { redactSensitive } = require('./lib/error-guidance.js');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

function beijingDate(now = new Date()) {
    const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function parseRecoveryDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--date 必须是有效的 YYYY-MM-DD 日期');
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('--date 必须是真实有效的日历日期');
    return value;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = value => value === undefined || value === null || typeof value === 'string';
function savedPaperId(paper) {
    // 与 utils.normalizedId 的已保存标识优先级和规范化一致；不为廉价诊断导入分析器。
    return (paper.paper_id || paper.arxivId || paper.id || '').replace(/v\d+$/, '').trim().toLowerCase();
}
function issueShapeValid(issue) {
    return isObject(issue) && ['severity', 'level', 'description', 'message', 'issue', 'file', 'path']
        .every(field => optionalString(issue[field]));
}
function savedRecordShape(value, kind, date) {
    if (kind === 'analysis' && Array.isArray(value)) {
        return value.every(isObject) ? { state: 'unsupported_legacy', detail: '旧数组未验证目标日期；本入口不推断日期或迁移' }
            : { state: 'invalid_shape', detail: '旧数组包含无效记录' };
    }
    if (!isObject(value)) return { state: 'invalid_shape', detail: '顶层须为对象' };
    const dateField = kind === 'analysis' ? 'batchDate' : 'date';
    if (kind === 'analysis' && value[dateField] == null && Array.isArray(value.papers)) {
        return { state: 'unsupported_legacy', detail: '缺少顶层batchDate，无法确认目标范围；不使用今日日期回退' };
    }
    try { parseRecoveryDate(value[dateField]); }
    catch (_) { return { state: 'invalid_shape', detail: `${dateField}须为真实日历日期` }; }
    if (value[dateField] !== date) return { state: 'date_mismatch', detail: `${dateField}与目标日期不同` };
    if (kind === 'analysis') {
        if (!Array.isArray(value.papers)) return { state: 'invalid_shape', detail: 'papers须为数组' };
        for (const paper of value.papers) {
            if (!isObject(paper) || !['paper_id', 'arxivId', 'id'].every(field => optionalString(paper[field]))
                || !savedPaperId(paper)
                || !['error', 'latestAnalysisAttemptError', 'latestAnalysisAttemptErrorCode', 'analysisStatus']
                    .every(field => optionalString(paper[field]))
                || (paper.digestStatus != null && (!isObject(paper.digestStatus)
                    || !optionalString(paper.digestStatus.latestAttemptStatus)))) {
                return { state: 'invalid_shape', detail: 'papers成员的标识或诊断字段类型无效' };
            }
        }
    } else {
        if (!Object.hasOwn(value, 'files') && !Object.hasOwn(value, 'issues')) return { state: 'invalid_shape', detail: '缺少files与issues保存通道' };
        if ((Object.hasOwn(value, 'files') && !Array.isArray(value.files))
            || (Object.hasOwn(value, 'issues') && !Array.isArray(value.issues))) return { state: 'invalid_shape', detail: 'files与issues须为数组' };
        for (const file of value.files || []) {
            if (!isObject(file) || typeof file.path !== 'string' || !file.path.trim()
                || (file.passed != null && typeof file.passed !== 'boolean')
                || !optionalString(file.failureKind)
                || (file.issues !== undefined && !Array.isArray(file.issues))
                || !(file.issues || []).every(issueShapeValid)) return { state: 'invalid_shape', detail: 'files成员或issues类型无效' };
        }
        if (!(value.issues || []).every(issueShapeValid)) return { state: 'invalid_shape', detail: '批次issues成员类型无效' };
    }
    return { state: 'valid' };
}
function readSavedRecord(file, kind, date, readFile = fs.readFileSync) {
    let bytes;
    try { bytes = readFile(file); }
    catch (error) {
        return { kind, ref: file, state: error.code === 'ENOENT' ? 'missing' : 'unreadable',
            ...(error.code === 'ENOENT' ? {} : { ioCode: redactSensitive(String(error.code || 'UNKNOWN')).slice(0, 64) }) };
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch (_) { return { kind, ref: file, sha256, state: 'invalid_json' }; }
    return { kind, ref: file, sha256, ...savedRecordShape(value, kind, date), value };
}

function collectSavedRecoveryState(date, options = {}) {
    parseRecoveryDate(date);
    const currentDir = options.currentDir || CURRENT;
    const sources = [
        readSavedRecord(path.join(currentDir, 'deep-analysis-result.json'), 'analysis', date, options.readFile),
        readSavedRecord(path.join(currentDir, `blog-review-failure-${date}.json`), 'review', date, options.readFile)
    ];
    const failures = [];
    const analysis = sources[0].state === 'valid' ? sources[0].value : null;
    const papers = analysis?.papers || [];
    for (const paper of papers) {
        const message = paper.latestAnalysisAttemptError || paper.error || '';
        const code = paper.latestAnalysisAttemptErrorCode || '';
        const statusHint = String(paper.digestStatus?.latestAttemptStatus || paper.analysisStatus || '');
        if (!message && !code && statusHint !== 'analysis_failed' && !paper.analysisFactReviewObligation) continue;
        if (message || code || statusHint === 'analysis_failed') {
            const entry = errorCodes.classify(`${code} ${message}`);
            failures.push({
                source: 'analysis', paperId: savedPaperId(paper),
                code: entry.id, label: entry.label, retryable: entry.retryable,
                command: entry.command.replace(/<DATE>/g, date), doc: entry.doc,
                message: redactSensitive(String(message)).slice(0, 200)
            });
        }
        if (paper.analysisFactReviewObligation) {
            failures.push({ source: 'analysis', paperId: savedPaperId(paper),
                code: 'fact-review-obligation', label: '事实反馈义务未完成', retryable: false,
                command: 'npm run batch -- --fact-feedback-file <FILE>', doc: 'docs/reader-explicit-retry.md', message: '存在 analysisFactReviewObligation，须先完成当前事实反馈。' });
        }
    }
    const review = sources[1].state === 'valid' ? sources[1].value : null;
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
                message: redactSensitive(String(file.failureKind || 'passed=false')).slice(0, 200) });
        }
    }
    if (review && Array.isArray(review.issues)) for (const issue of review.issues) {
        if (!/error/i.test(String(issue.severity || issue.level || ''))) continue;
        const description = String(issue.description || issue.message || issue.issue || '');
        const entry = errorCodes.classify(description);
        failures.push({
            source: 'review', scope: 'batch', page: String(issue.file || issue.path || '').split('/').pop(),
            code: entry.id, label: entry.label, retryable: entry.retryable,
            command: entry.command.replace(/<DATE>/g, date), doc: entry.doc,
            message: redactSensitive(description).slice(0, 200)
        });
    }
    const blocked = sources.some(source => !['valid', 'missing'].includes(source.state));
    const status = blocked ? 'blocked' : sources.some(source => source.state === 'missing') ? 'partial' : 'collected';
    return { contract: 'recover-saved-records-v1', date, collectionMode: 'saved_records', semanticCoverage: 'not_checked', status,
        coverage: { analysisRecords: analysis ? papers.length : null, reviewFiles: review ? files.length : null,
            reviewBatchIssues: review ? (review.issues || []).length : null, scopeComplete: false,
            sources: sources.map(({ value, ...source }) => source) },
        blockers: sources.filter(source => source.state !== 'valid').map(({ kind, state, detail, ioCode }) => ({ kind, state,
            ...(detail ? { detail } : {}), ...(ioCode ? { ioCode } : {}) })), failures };
}

function collectFailures(date, options = {}) {
    const state = collectSavedRecoveryState(date, options);
    if (state.status === 'blocked') throw new Error(`恢复输入被阻断：${state.blockers.map(item => `${item.kind}:${item.state}`).join(', ')}`);
    return state.failures;
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

function render(date, failures, groups, snapshot = null) {
    const lines = [`恢复计划（${date}）：${failures.length} 个失败项，${groups.length} 个建议入口`];
    if (snapshot) {
        lines.push(`采集状态：${snapshot.status}；collectionMode=saved_records；semanticCoverage=not_checked；未核正式完整范围或资格。`);
        for (const blocker of snapshot.blockers) lines.push(`输入：${blocker.kind} ${blocker.state}${blocker.detail ? `（${blocker.detail}）` : ''}`);
    }
    for (const group of groups) {
        lines.push(`\n建议入口：${group.command}`);
        lines.push(`  类型：${group.label}（${group.code}，${group.retryable ? '可重试' : '需检查后再试'}）`);
        for (const item of group.items.slice(0, 8)) {
            lines.push(`  - ${item.source === 'review' ? `页面 ${item.page || '?'}` : `论文 ${item.paperId || '?'}`}：${item.message}`);
        }
        if (group.items.length > 8) lines.push(`  …还有 ${group.items.length - 8} 项`);
    }
    if (!failures.length) lines.push('未发现可采集的已保存失败项；这不表示正式资格通过。可用 npm run digest:status -- --date <DATE> 查看完整状态。');
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

function main(argv = process.argv.slice(2), dependencies = {}) {
    try { require('./env-loader').requireExternalRuntime('recover.js'); } catch (error) { console.error(`[recover] ${error.message}`); return 1; }

    const options = { date: null, json: false, execute: false, yes: false, strict: false };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--date') {
            const next = argv[++index];
            if (!next || next.startsWith('--')) throw new Error('--date 缺少 YYYY-MM-DD');
            options.date = next;
        }
        else if (value === '--json') options.json = true;
        else if (value === '--execute') options.execute = true;
        else if (value === '--yes') options.yes = true;
        else if (value === '--strict') options.strict = true;
        else if (value === '--help') options.help = true;
        else throw new Error(`未知参数：${value}`);
    }
    if (options.help) { console.log('用法: node scripts/recover.js --date YYYY-MM-DD [--json] [--execute --yes]'); return 0; }
    const date = parseRecoveryDate(options.date || beijingDate());
    const snapshot = collectSavedRecoveryState(date, dependencies);
    const { failures } = snapshot;
    const groups = plan(failures);
    if (options.json) console.log(JSON.stringify({ ...snapshot, plan: groups }, null, 2));
    else console.log(render(date, failures, groups, snapshot));
    if (snapshot.status === 'blocked' || (options.execute && snapshot.status === 'partial')) return 2;
    if (!options.execute) return options.strict && (failures.length || snapshot.status === 'partial') ? 1 : 0;
    if (!options.yes) throw new Error('--execute 需要同时传 --yes（确认会调用真实入口）');
    let skipped = 0;
    for (const group of groups) {
        if (!group.command.startsWith('npm run ')) { skipped += 1; console.log(`\n跳过非 npm 命令（请手工执行）：${group.command}`); continue; }
        const args = buildExecutionArgs(group.command, date);
        if (!args) { skipped += 1; console.log(`\n需手工执行（含占位符或自指）：${group.command}`); continue; }
        console.log(`\n执行：npm ${args.join(' ')}（来自 ${group.code}）`);
        const result = (dependencies.spawnSync || spawnSync)('npm', args, { stdio: 'inherit', cwd: ROOT });
        if (result.status !== 0) return result.status || 1;
    }
    if (skipped) { console.log(`\n共 ${skipped} 个入口需要手工执行，未视为已恢复。`); return options.strict ? 1 : 2; }
    return 0;
}

module.exports = { beijingDate, parseRecoveryDate, readSavedRecord, collectSavedRecoveryState, buildExecutionArgs, collectFailures, plan, render, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[recover] ${error.message}`); process.exitCode = 2; }
}

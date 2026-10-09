#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { writeImmutableFile } = require('./lib/immutable-file.js');
const { requireExternalRuntime } = require('./env-loader.js');
const api = require('./lib/historical-direct-publication.js');

const USAGE = [
    'visual-disposition --apply --plan-file ABS --mode excluded|waived --scope full-history-publication|selected-sample-publication --reason TEXT --output ABS.json',
    'plan --dry-run|--apply --publication-id UUID --plan-file ABS --registry-file ABS --projection-file ABS --visual-disposition ABS [--paper-ids ID,ID,...] [--blog-repo ABS]',
    'generate --dry-run|--apply --publication-id UUID --plan-file ABS --registry-file ABS --projection-file ABS --visual-disposition ABS [--paper-ids ID,ID,...] [--blog-repo ABS]',
    'review|activate|publish --dry-run|--apply --publication-id UUID [--message TEXT] [--blog-repo ABS]',
    'status --publication-id UUID [--live-remote true]'
].join(' | ');

function parsePairs(argv, allowed) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]; const value = argv[index + 1];
        if (!allowed.includes(flag) || value === undefined || Object.hasOwn(values, flag)) throw new Error(`命令写法不对，用法：${USAGE}`);
        values[flag] = value;
    }
    return values;
}
function parsePaperIds(value) {
    if (value === undefined) return [];
    const ids = String(value).split(',').map(item => item.trim()).filter(Boolean);
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error(`命令写法不对，用法：${USAGE}`);
    return ids;
}
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'); }
function parseArgs(argv) {
    const [action, mode, ...rest] = argv;
    if (action === 'status') {
        const values = parsePairs([mode, ...rest].filter(value => value !== undefined), ['--publication-id', '--live-remote']);
        if (!api.UUID_RE.test(values['--publication-id'] || '') || values['--live-remote'] !== undefined
            && !['true', 'false'].includes(values['--live-remote'])) throw new Error(`命令写法不对，用法：${USAGE}`);
        return { action, publicationId: values['--publication-id'],
            liveRemote: values['--live-remote'] === undefined ? true : values['--live-remote'] === 'true' };
    }
    if (action === 'visual-disposition') {
        if (mode !== '--apply') throw new Error(`命令写法不对，用法：${USAGE}`);
        const values = parsePairs(rest, ['--plan-file', '--mode', '--scope', '--reason', '--output']);
        if (!absolute(values['--plan-file']) || !absolute(values['--output']) || !['excluded', 'waived'].includes(values['--mode'])
            || !['full-history-publication', 'selected-sample-publication'].includes(values['--scope'] || 'full-history-publication')
            || String(values['--reason'] || '').trim().length < 10) throw new Error(`命令写法不对，用法：${USAGE}`);
        return { action, apply: true, planFile: values['--plan-file'], dispositionMode: values['--mode'],
            dispositionScope: values['--scope'] || 'full-history-publication', reason: values['--reason'], output: values['--output'] };
    }
    if (!['plan', 'generate', 'review', 'activate', 'publish'].includes(action)
        || !['--dry-run', '--apply'].includes(mode)) throw new Error(`命令写法不对，用法：${USAGE}`);
    const stageNeedsAuthority = ['plan', 'generate'].includes(action);
    const values = parsePairs(rest, stageNeedsAuthority
        ? ['--publication-id', '--plan-file', '--registry-file', '--projection-file', '--visual-disposition', '--paper-ids', '--blog-repo']
        : ['--publication-id', '--message', '--blog-repo']);
    if (!api.UUID_RE.test(values['--publication-id'] || '')) throw new Error(`命令写法不对，用法：${USAGE}`);
    if (stageNeedsAuthority && ['--plan-file', '--registry-file', '--projection-file', '--visual-disposition']
        .some(flag => !absolute(values[flag]))) throw new Error(`命令写法不对，用法：${USAGE}`);
    if (values['--blog-repo'] !== undefined && !absolute(values['--blog-repo'])) throw new Error(`命令写法不对，用法：${USAGE}`);
    return { action, apply: mode === '--apply', publicationId: values['--publication-id'], planFile: values['--plan-file'],
        registryFile: values['--registry-file'], projectionFile: values['--projection-file'],
        visualDispositionFile: values['--visual-disposition'],
        paperIds: parsePaperIds(values['--paper-ids']),
        blogRepo: values['--blog-repo'] || null,
        message: values['--message'] || null };
}
function roots(Config) {
    return { stagingRoot: Config.FILES.historicalDirectRewriteStagingDir,
        executionRoot: Config.FILES.historicalDirectRewriteExecutionDir,
        aggregateRoot: Config.FILES.historicalDirectAggregateDir,
        freshArxivSourceRoot: Config.FILES.freshArxivFetchedSourcesDir,
        publicationMetadataRoot: Config.FILES.historicalArxivPublicationMetadataDir };
}
function buildPublicationInputOptions(options, Config) {
    return { planFile: options.planFile, registryFile: options.registryFile, projectionFile: options.projectionFile,
        visualDispositionFile: options.visualDispositionFile,
        selectedPaperIds: options.paperIds || [],
        ...roots(Config) };
}
function rejectDisposition(message, details = {}) {
    throw Object.assign(new Error(message), details);
}
function writeArtifact(filename, value) {
    if (path.extname(filename) !== '.json') throw new Error('输出文件名必须以 .json 结尾');
    const parent = path.dirname(filename);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
        || fs.realpathSync(parent) !== path.resolve(parent)) throw new Error('视觉处置输出目录不安全');
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    writeImmutableFile(filename, bytes, rejectDisposition);
    return filename;
}
function existingDisposition(filename, expected) {
    const named = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!named) return null;
    // 双链接只供后续核验并恢复已退出写者；这里不删除任何文件。
    if (!named.isFile() || named.isSymbolicLink() || ![1, 2].includes(named.nlink)
        || named.size < 1 || named.size > 1024 * 1024) throw new Error('视觉处置文件类型、链接数或大小不符合要求');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
            || opened.nlink !== named.nlink) throw new Error('视觉处置文件在打开时发生变化');
        bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd); const current = fs.lstatSync(filename);
        if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
            || after.ctimeMs !== opened.ctimeMs || current.dev !== opened.dev || current.ino !== opened.ino
            || current.nlink !== opened.nlink || current.isSymbolicLink()) throw new Error('视觉处置文件在读取时发生变化');
    } finally { fs.closeSync(fd); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // 原入口只输出这种 JSON 字节；逐字重建同时拒绝重复键和额外尾部内容。
    if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))) {
        throw new Error('视觉处置文件不是原入口生成的完整 JSON 字节');
    }
    const stored = api.normalizeVisualDisposition(value, { planSha256: expected.planSha256 });
    for (const field of ['contract', 'version', 'planSha256', 'scope', 'mode', 'reason', 'requestedBy']) {
        if (stored[field] !== expected[field]) throw new Error(`已有视觉处置的 ${field} 与本次请求不同，不能覆盖`);
    }
    return stored;
}
function writeDisposition(filename, expected) {
    let value = existingDisposition(filename, expected) || expected;
    try { writeArtifact(filename, value); }
    catch (error) {
        if (error.code !== 'IMMUTABLE_FILE_CONTENT_CONFLICT') throw error;
        // 并发胜者只允许创建时间不同；必须重新核验完整凭证和本次显式范围。
        value = existingDisposition(filename, expected);
        if (!value) throw error;
        writeArtifact(filename, value);
    }
    return value;
}
function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('historical-direct-publication.js');
    const Config = runtime.config || require('./config.js'); const options = parseArgs(argv);
    if (options.action === 'visual-disposition') {
        const plan = require('./lib/historical-direct-rewrite-plan.js').normalizePlan(
            require('./lib/historical-conference-page-projections.js').readStableJson(options.planFile, 'publication visual plan').value);
        let value = api.buildVisualDisposition({ plan, mode: options.dispositionMode, scope: options.dispositionScope, reason: options.reason });
        const allowedRoot = path.resolve(Config.FILES.historicalDirectVisualDispositionDir);
        const parent = path.resolve(path.dirname(options.output));
        if (parent !== allowedRoot) throw new Error(`视觉处置输出必须直接放在 ${allowedRoot} 下，不能带子目录`);
        require('node:fs').mkdirSync(allowedRoot, { recursive: true, mode: 0o700 });
        const allowedStat = require('node:fs').lstatSync(allowedRoot);
        if (!allowedStat.isDirectory() || allowedStat.isSymbolicLink()
            || require('node:fs').realpathSync(allowedRoot) !== allowedRoot) throw new Error('configured visual disposition root is unsafe');
        value = writeDisposition(options.output, value); console.log(JSON.stringify({ status: 'written', output: options.output,
            dispositionSha256: value.dispositionSha256, mode: value.mode })); return value;
    }
    const common = { outputRoot: Config.FILES.historicalDirectPublicationDir, publicationId: options.publicationId,
        blogRepo: options.blogRepo || Config.PUBLISH_CONFIG.blogRepo, remoteName: Config.PUBLISH_CONFIG.githubRemote || 'origin' };
    if (options.action === 'status') {
        const result = api.status({ ...common, liveRemote: options.liveRemote });
        console.log(JSON.stringify(result)); if (!result.complete) process.exitCode = 1; return result;
    }
    const authority = ['plan', 'generate'].includes(options.action) ? buildPublicationInputOptions(options, Config) : null;
    if (options.action === 'plan') {
        let plan = api.buildPlan({ publicationId: options.publicationId, authorityOptions: authority,
            blogRepo: common.blogRepo, remoteName: common.remoteName }, runtime.dependencies || {});
        if (options.apply) plan = api.writePlan({ outputRoot: common.outputRoot, plan }).plan;
        const result = { status: options.apply ? 'planned' : 'dry-run', publicationId: options.publicationId,
            planSha256: plan.planSha256, files: plan.files.length, delta: plan.exactDelta.length,
            retainedPages: plan.retainedPages.length, visualDisposition: plan.visualDisposition.mode };
        console.log(JSON.stringify(result)); return result;
    }
    const args = { ...common, authorityOptions: authority, apply: options.apply, message: options.message };
    if (options.action === 'activate' && options.apply) {
        throw new Error('standalone activate --apply is disabled; use publish --apply so activation, commit, push and OID verification share one blog lock');
    }
    const operation = options.action === 'publish' ? api.activateAndPublish : api[options.action];
    const result = operation(args, runtime.dependencies || {}); console.log(JSON.stringify(result)); return result;
}
if (require.main === module) {
    try { main(); } catch (error) { console.error(`[historical-direct-publication] ${error.message}`); process.exitCode = 1; }
}
module.exports = { USAGE, parseArgs, roots, buildPublicationInputOptions, writeArtifact, main };

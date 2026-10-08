#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const api = require('./lib/conference-process.js');
const recovery = require('./lib/conference-process-recovery.js');

const USAGE = '--dry-run|--apply|--status|--source-upgrade-plan|--source-upgrade-apply|--source-upgrade-promote --catalog NAME.json --report NAME.json --filter UUID [--concurrency 1|2|3|4|5] [--retry-failed]; --status supports [--verify-files]; source upgrade: --from UUID; apply requires --plan-sha SHA --paper-ids ID,ID --authorize-new-analysis; promote requires --plan-sha SHA [--preserve-original-complete|--prefer-upgrade]; plan/promote support [--page-repair-mode caption-only]';
function parseArgs(argv) {
    if (argv[0] === '--legacy-disabled') throw new Error('New-conference execution/analyze/postprocess must use conference:new:process');
    const mode = argv[0]; if (!['--dry-run', '--apply', '--status', '--source-upgrade-plan', '--source-upgrade-apply', '--source-upgrade-promote'].includes(mode)) throw new Error(`Use ${USAGE}`);
    const upgrade = mode.startsWith('--source-upgrade-');
    const values = {};
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index], value = argv[index + 1];
        if (flag === '--retry-failed' || flag === '--verify-files' || flag === '--authorize-new-analysis'
            || flag === '--preserve-original-complete' || flag === '--prefer-upgrade') {
            if ((flag === '--retry-failed' && !['--apply', '--source-upgrade-apply'].includes(mode))
                || (flag === '--verify-files' && mode !== '--status')
                || (flag === '--authorize-new-analysis' && mode !== '--source-upgrade-apply')
                || ((flag === '--preserve-original-complete' || flag === '--prefer-upgrade') && mode !== '--source-upgrade-promote')
                || values[flag]) throw new Error(`Use ${USAGE}`);
            values[flag] = true; index -= 1; continue;
        }
        if (![ '--catalog', '--report', '--filter', '--concurrency', ...(upgrade ? ['--from', '--plan-sha', '--paper-ids'] : []),
            ...(['--source-upgrade-plan', '--source-upgrade-promote'].includes(mode) ? ['--page-repair-mode'] : []) ].includes(flag) || !value || Object.hasOwn(values, flag)) {
            throw new Error(`Use ${USAGE}`);
        }
        values[flag] = value;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--catalog'] || '')
        || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--report'] || '')
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['--filter'] || '')
        || (values['--concurrency'] && !/^[1-5]$/.test(values['--concurrency']))) throw new Error(`Use ${USAGE}`);
    if (upgrade && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(values['--from'] || '')) throw new Error(`Use ${USAGE}`);
    if (mode === '--source-upgrade-plan' && (values['--plan-sha'] || values['--paper-ids'])) throw new Error(`Use ${USAGE}`);
    if (values['--preserve-original-complete'] && values['--prefer-upgrade']) throw new Error(`Use ${USAGE}`);
    if (values['--page-repair-mode'] !== undefined && values['--page-repair-mode'] !== 'caption-only') throw new Error(`Use ${USAGE}`);
    if (mode === '--source-upgrade-promote' && (!/^[a-f0-9]{64}$/.test(values['--plan-sha'] || '') || values['--paper-ids'])) throw new Error(`Use ${USAGE}`);
    if (mode === '--source-upgrade-apply' && (!values['--authorize-new-analysis'] || !/^[a-f0-9]{64}$/.test(values['--plan-sha'] || '')
        || !values['--paper-ids'] || values['--paper-ids'].split(',').some(id => !/^conference:[a-z0-9:._-]+$/.test(id)))) throw new Error(`Use ${USAGE}`);
    return { apply: mode === '--apply', statusOnly: mode === '--status', catalogName: values['--catalog'],
        reportName: values['--report'], filterId: values['--filter'], concurrency: Number(values['--concurrency'] || 1),
        ...(values['--retry-failed'] ? { retryFailed: true } : {}),
        ...(values['--verify-files'] ? { verifyFiles: true } : {}),
        ...(upgrade ? { sourceUpgrade: mode === '--source-upgrade-plan' ? 'plan' : mode === '--source-upgrade-promote' ? 'promote' : 'apply', fromProcessId: values['--from'],
            ...(values['--page-repair-mode'] ? { pageRepairMode: values['--page-repair-mode'] } : {}),
            ...(mode === '--source-upgrade-promote' ? { planSha256: values['--plan-sha'] } : {}),
            ...(mode === '--source-upgrade-promote' && values['--preserve-original-complete'] ? { preserveOriginalComplete: true } : {}),
            ...(mode === '--source-upgrade-promote' && values['--prefer-upgrade'] ? { preferUpgrade: true } : {}),
            ...(mode === '--source-upgrade-apply' ? { planSha256: values['--plan-sha'], paperIds: values['--paper-ids'].split(','), authorizeNewAnalysis: true } : {}) } : {}) };
}
function readSafeJson(filename) {
    const named = fs.lstatSync(filename);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || (named.mode & 0o777) !== 0o600) {
        throw new Error(`会议进程状态文件不安全：不是单链接普通文件，或权限不是 0600：${filename}`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd); const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd); const finalNamed = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size
            || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || finalNamed.dev !== opened.dev || finalNamed.ino !== opened.ino
            || finalNamed.nlink !== 1 || finalNamed.size !== opened.size) {
            throw new Error(`读取会议进程状态时文件发生变化：${filename}`);
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
}
function lockStatus(engine, filename) {
    if (typeof engine?.inspectFileLockState !== 'function') return null;
    const snapshot = engine.inspectFileLockState(filename);
    if (!snapshot?.exists) return null;
    let ownerAlive = null;
    if (Number.isInteger(snapshot.owner?.pid) && snapshot.owner.pid > 0) {
        try { process.kill(snapshot.owner.pid, 0); ownerAlive = true; }
        catch (error) { ownerAlive = error.code === 'ESRCH' ? false : null; }
    }
    return { consistent: snapshot.consistent === true, ownerAlive,
        ownerPid: snapshot.owner?.pid || null, ownerHost: snapshot.owner?.hostname || null };
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
// --status 默认只读状态文件。--verify-files 才去碰磁盘上的分析结果、暂存页和汇总，
// 按 state 里的 proof 逐个复算 SHA。缺文件和 SHA 不符都算失败。
function readRegularBytes(filename, label) {
    let named;
    try { named = fs.lstatSync(filename); }
    catch (error) {
        if (error.code === 'ENOENT') throw new Error(`${label}不存在：${filename}`);
        throw new Error(`${label}无法读取：${filename}（${error.code || error.message}）`);
    }
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
        throw new Error(`${label}不是普通单链接文件：${filename}`);
    }
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(descriptor); const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.nlink !== 1 || bytes.length !== opened.size
            || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size) {
            throw new Error(`${label}读取期间发生变化：${filename}`);
        }
        return bytes;
    } finally { fs.closeSync(descriptor); }
}
function readRegularJson(filename, label) {
    const bytes = readRegularBytes(filename, label);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new Error(`${label}不是合法 JSON：${filename}（${error.message}）`); }
}
// 暂存目录是 stagingRoot/<analysisRunId>/<词表 SHA>/<实现 SHA>/，只用已知的
// analysisRunId 往下找三层，不扫整个暂存根目录，所以论文多也不会明显变慢。
function findStagedManifest(stagingRoot, executionId, expectedManifestSha256) {
    const runRoot = path.join(stagingRoot, executionId);
    const stack = [{ directory: runRoot, depth: 0 }];
    while (stack.length) {
        const { directory, depth } = stack.pop();
        let entries;
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
            throw new Error(`暂存目录无法读取：${directory}（${error.code || error.message}）`);
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) { if (depth < 3) stack.push({ directory: child, depth: depth + 1 }); continue; }
            if (entry.name !== 'manifest.json') continue;
            let manifest;
            try { manifest = readRegularJson(child, '暂存页面清单'); } catch { continue; }
            if (manifest?.manifestSha256 === expectedManifestSha256) return { directory, manifest };
        }
    }
    return null;
}
function verifyCompletedArtifacts(state, files) {
    const failures = [];
    const fail = (paperId, artifact, detail) => failures.push({ paperId, artifact, detail });
    const completed = Object.values(state.items).filter(item => item.status === 'complete')
        .sort((left, right) => left.paperId.localeCompare(right.paperId));
    for (const item of completed) {
        const analysisFile = path.join(files.conferenceAnalysisDir, item.analysisRunId, 'analysis.json');
        try {
            const analysisSha256 = sha256(readRegularBytes(analysisFile, '分析结果'));
            if (analysisSha256 !== item.analysisProof.analysisSha256) {
                fail(item.paperId, 'analysis', `analysis.json 的 SHA 与 analysisProof.analysisSha256 不符：`
                    + `实际 ${analysisSha256}，记录 ${item.analysisProof.analysisSha256}（${analysisFile}）`);
            }
        } catch (error) { fail(item.paperId, 'analysis', error.message); }
        try {
            const found = findStagedManifest(files.conferencePageStagingDir, item.analysisRunId, item.pageProof.manifestSha256);
            if (!found) {
                fail(item.paperId, 'page', `找不到 manifestSha256 为 ${item.pageProof.manifestSha256} 的暂存页清单：`
                    + `${path.join(files.conferencePageStagingDir, item.analysisRunId)}`);
            } else {
                const manifestBody = { ...found.manifest }; delete manifestBody.manifestSha256;
                const pageSha256 = sha256(readRegularBytes(path.join(found.directory, 'page.md'), '暂存页面'));
                if (found.manifest.paperId !== item.paperId
                    || found.manifest.analysisExecutionId !== item.analysisRunId
                    || found.manifest.pagePath !== item.pageProof.pagePath
                    || found.manifest.manifestSha256 !== api.stableHash(manifestBody)
                    || found.manifest.manifestSha256 !== item.pageProof.manifestSha256
                    || found.manifest.contentSha256 !== item.pageProof.contentSha256
                    || pageSha256 !== item.pageProof.contentSha256) {
                    fail(item.paperId, 'page', `暂存页清单或 page.md 与 pageProof 不符：${found.directory}`);
                }
            }
        } catch (error) { fail(item.paperId, 'page', error.message); }
    }
    if (state.status === 'complete' && state.aggregate) {
        const proof = state.aggregate;
        const aggregateDirectory = path.join(files.conferenceAggregateDir, state.authority.conferenceId, proof.aggregateId);
        try {
            const manifest = readRegularJson(path.join(aggregateDirectory, 'manifest.json'), '汇总清单');
            const manifestBody = { ...manifest }; delete manifestBody.manifestSha256;
            const markdownSha256 = sha256(readRegularBytes(path.join(aggregateDirectory, 'aggregate.md'), '汇总页面'));
            if (manifest.manifestSha256 !== proof.manifestSha256 || manifest.manifestSha256 !== api.stableHash(manifestBody)
                || manifest.aggregateId !== proof.aggregateId || manifest.pagePath !== proof.pagePath
                || manifest.markdownSha256 !== proof.markdownSha256 || markdownSha256 !== proof.markdownSha256) {
                fail(null, 'aggregate', `汇总暂存与 aggregate proof 不符：${aggregateDirectory}`);
            }
        } catch (error) { fail(null, 'aggregate', error.message); }
    }
    return { checkedPapers: completed.length, failures };
}
function processStatus(options, runtime = {}) {
    const deps = { ...api.defaultDependencies?.(), ...(runtime.dependencies || {}) };
    const context = (deps.loadAuthority || api.loadAuthority)(options, deps);
    const processId = recovery.resolveProcess(context, deps, api);
    const directory = (api.safeProcessDirectory || ((root, id) => path.join(root, id)))
        (deps.files.conferenceProcessDir, processId, false);
    const filename = path.join(directory, 'state.json');
    const state = api.assertState(readSafeJson(filename), {
        authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() });
    if (state.status === 'complete') api.validateCompletionReceipt(state,
        readSafeJson(path.join(directory, 'completion-receipt.json')));
    const counts = Object.values(state.items).reduce((result, item) => {
        result[item.status] = (result[item.status] || 0) + 1; return result;
    }, {});
    const review = api.buildTagReviewQueue(state);
    const result = { status: state.status, processId, conferenceId: state.authority.conferenceId,
        stateSha256: state.stateSha256, papers: counts, completionReceiptSha256: state.completionReceiptSha256,
        tagReview: review.tagReview, filesVerified: false };
    if (options.verifyFiles) {
        const verification = verifyCompletedArtifacts(state, deps.files);
        result.filesVerified = true;
        result.fileVerification = { status: verification.failures.length ? 'failed' : 'ok',
            checkedPapers: verification.checkedPapers, failures: verification.failures };
    }
    Object.assign(result, api.buildTagReviewQueueFields(review, directory));
    if (state.batchFailure) result.batchFailure = state.batchFailure;
    const operationLock = lockStatus(deps.engine, path.join(directory, '.operation'));
    if (operationLock) result.operationLock = operationLock;
    return result;
}
function statusExitCode(result) {
    return result?.fileVerification?.status === 'failed' ? 1 : 0;
}
async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('conference-process.js'); const options = parseArgs(argv);
    if (options.sourceUpgrade) {
        const upgrade = require('./lib/conference-source-upgrade.js');
        const result = options.sourceUpgrade === 'plan' ? upgrade.planSourceUpgrade(options, runtime.dependencies || {})
            : options.sourceUpgrade === 'promote' ? await upgrade.promoteSourceUpgrade(options, runtime.dependencies || {})
                : await upgrade.applySourceUpgrade(options, runtime.dependencies || {});
        console.log(JSON.stringify(result)); return result;
    }
    const result = options.statusOnly ? processStatus(options, runtime)
        : await (runtime.run || api.runConferenceProcess)(options, runtime.dependencies || {});
    console.log(JSON.stringify(result));
    if (statusExitCode(result)) process.exitCode = 1;
    return result;
}
if (require.main === module) main().catch(error => { console.error(`[conference-process] ${error.message}`); process.exitCode = 1; });
module.exports = { USAGE, parseArgs, readSafeJson, processStatus, statusExitCode, main };

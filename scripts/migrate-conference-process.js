#!/usr/bin/env node
'use strict';

// 会议流程的实现指纹变了以后，用它做一次显式迁移，过程留痕。已完成的论文先按当前
// 的后处理代码重跑一遍；只有没做完的论文才重新送回 LLM 流程。

const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const processApi = require('./lib/conference-process.js');
const cli = require('./conference-process.js');
const recovery = require('./lib/conference-process-recovery.js');

const USAGE = '--apply --catalog NAME.json --report NAME.json --filter UUID --from PROCESS_UUID [--concurrency 1|2|3|4|5] [--reuse-complete-pages] [--retry-failed]';
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function parseArgs(argv) {
    if (argv[0] !== '--apply') throw new Error(`Use ${USAGE}`);
    const values = {};
    for (let index = 1; index < argv.length;) {
        const flag = argv[index]; const value = argv[index + 1];
        if (flag === '--reuse-complete-pages' || flag === '--retry-failed') {
            if (Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
            values[flag] = true; index += 1; continue;
        }
        if (!['--catalog', '--report', '--filter', '--from', '--concurrency'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`Use ${USAGE}`);
        values[flag] = value; index += 2;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--catalog'] || '')
        || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--report'] || '')
        || !UUID_RE.test(values['--filter'] || '') || !UUID_RE.test(values['--from'] || '')
        || (values['--concurrency'] && !/^[1-5]$/.test(values['--concurrency']))) {
        throw new Error(`Use ${USAGE}`);
    }
    return { apply: true, statusOnly: false, catalogName: values['--catalog'],
        reportName: values['--report'], filterId: values['--filter'],
        fromProcessId: values['--from'], concurrency: Number(values['--concurrency'] || 3),
        reuseCompletePages: Boolean(values['--reuse-complete-pages']), retryFailed: Boolean(values['--retry-failed']) };
}

function withoutImplementation(authority, version = processApi.PROCESS_VERSION) {
    const value = processApi.authorityWithoutTagCatalog(authority, version);
    delete value.implementationSha256;
    return value;
}

function archiveStaleCompletionReceipt(directory, state) {
    if (state.status === 'complete' || state.completionReceiptSha256) return null;
    const filename = path.join(directory, 'completion-receipt.json');
    if (!fs.existsSync(filename)) return null;
    const bytes = fs.readFileSync(filename);
    const receipt = cli.readSafeJson(filename);
    const digest = processApi.stableHash(receipt).slice(0, 16);
    let archived = path.join(directory, `completion-receipt-${digest}.json`);
    if (fs.existsSync(archived)) {
        const existing = fs.readFileSync(archived);
        if (!existing.equals(bytes)) {
            throw new Error('stale completion receipt archive collides with different bytes');
        }
        archived = path.join(directory, `completion-receipt-${digest}-${state.generation}.json`);
        if (fs.existsSync(archived) && !fs.readFileSync(archived).equals(bytes)) {
            throw new Error('stale completion receipt archive generation collides with different bytes');
        }
    }
    fs.renameSync(filename, archived);
    return path.basename(archived);
}

function migrateAndRun(options, runtime = {}) {
    const deps = { ...processApi.defaultDependencies?.(), ...(runtime.dependencies || {}) };
    const context = (deps.loadAuthority || processApi.loadAuthority)(options, deps);
    const directory = processApi.safeProcessDirectory(deps.files.conferenceProcessDir,
        options.fromProcessId, false);
    const stateFile = path.join(directory, 'state.json');
    const operation = path.join(directory, '.operation');
    const expectedPaperIds = context.members.map(item => item.paperId).sort();

    const migrationFile = path.join(directory, 'implementation-migration.json');
    const runLocked = async () => {
        let state = processApi.assertState(cli.readSafeJson(stateFile));
        if (processApi.stableHash(withoutImplementation(state.authority, state.version))
            !== processApi.stableHash(withoutImplementation(context.authority))) {
            throw new Error('来源、筛选或其余配置与原进程不一致，不能迁移实现。');
        }
        if (processApi.stableHash(Object.keys(state.items).sort())
            !== processApi.stableHash(expectedPaperIds)) {
            throw new Error('selected member set differs; refusing implementation migration');
        }
        const currentImplementation = context.authority.implementationSha256;
        const migrationFiles = fs.readdirSync(directory).filter(name => (
            name === 'implementation-migration.json'
            || /^implementation-migration-[a-f0-9]{12}\.json$/.test(name)
        )).sort().map(name => path.join(directory, name));
        const migrationRecords = migrationFiles.map(filename => ({ filename,
            value: cli.readSafeJson(filename) }));
        const matchingMigration = migrationRecords.find(({ value }) => (
            value.toImplementationSha256 === state.authority.implementationSha256
        ));
        const interruptedMigration = (migrationRecords.length > 0 || Boolean(state.sourceImplementationSha256)) && !matchingMigration;
        const requiresMigration = state.authority.implementationSha256 !== currentImplementation
            || interruptedMigration;
        const oldImplementation = recovery.sourceImplementation(state, directory, processApi);
        let completionReceiptCurrent = true;
        if (state.status === 'complete') {
            const completion = cli.readSafeJson(path.join(directory, 'completion-receipt.json'));
            completionReceiptCurrent = completion.authority?.implementationSha256 === currentImplementation;
        }
        const lifecycleNeedsRefresh = state.status === 'complete' && !completionReceiptCurrent;
        const sharedContext = oldImplementation === currentImplementation
            ? context
            : { ...context, authority: { ...context.authority, implementationSha256: oldImplementation } };
        const shared = await (deps.prepareShared || processApi.prepareShared)(sharedContext, deps, state.createdAt);
        processApi.assertSourceContinuity(state, shared);
        // 只有实现或生命周期确实需要时，才重新处理已完成的论文。发布器或渲染器的提交
        // 会在 LLM 流程运行期间改变实现指纹，这时重跑只是把暂存页拉回与记录一致，
        // 不必把已完成的论文再送回 LLM。实现没变、只是普通重试时跳过这一步，
        // 直接处理未完成的论文。
        const complete = Object.values(state.items).filter(item => item.status === 'complete');
        const stagedProofs = new Map();
        if (requiresMigration || lifecycleNeedsRefresh) {
            for (const item of complete) {
                const staged = deps.postprocess.stagePaper({
                    analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId,
                    tagCatalogPath: deps.files.tagCatalogFile,
                    stagingRoot: deps.files.conferencePageStagingDir,
                    planHandle: shared.planHandle,
                    sourceRoot: shared.sourceCacheRoot,
                    apply: true
                });
                if (staged.status !== 'staged') {
                    throw new Error(`existing complete paper failed current postprocess: ${item.paperId}`);
                }
                if (options.reuseCompletePages && (staged.manifest.contentSha256 !== item.pageProof?.contentSha256
                    || staged.manifest.pagePath !== item.pageProof?.pagePath)) {
                    throw new Error(`existing complete page changed during authenticated replay: ${item.paperId}`);
                }
                stagedProofs.set(item.paperId, {
                    manifestSha256: staged.manifest.manifestSha256,
                    contentSha256: staged.manifest.contentSha256,
                    pagePath: staged.manifest.pagePath
                });
            }
        }
        if (requiresMigration || lifecycleNeedsRefresh) {
            const beforeStateSha256 = state.stateSha256;
            if (state.authority.implementationSha256 !== currentImplementation || lifecycleNeedsRefresh) {
                state = deps.engine.updateJsonFileLocked(stateFile, current => {
                    const checked = processApi.assertState(current);
                    if (processApi.stableHash(withoutImplementation(checked.authority, checked.version))
                        !== processApi.stableHash(withoutImplementation(context.authority))) {
                        throw new Error('checkpoint authority changed during implementation migration');
                    }
                    if (checked.stateSha256 !== beforeStateSha256) {
                        throw new Error('checkpoint changed during implementation migration');
                    }
                    const next = structuredClone(checked);
                    next.authority = processApi.authorityForExistingState(checked, context.authority);
                    // 经来源升级提升过的流程，已经通过 sourceUpgradePromotion 和来源
                    // 升级方案绑定了原始实现。这里再补上旧的 sourceImplementationSha256
                    // 字段，就等于宣称该流程的 UUID 直接由那份实现推导而来，而事实并非如此。
                    if (!next.sourceUpgradePromotion) next.sourceImplementationSha256 = oldImplementation;
                    next.status = 'running';
                    next.aggregate = null;
                    next.completionReceiptSha256 = null;
                    for (const [paperId, pageProof] of stagedProofs) {
                        if (next.items[paperId]?.status === 'complete') next.items[paperId].pageProof = pageProof;
                    }
                    next.updatedAt = deps.now(); next.generation = checked.generation + 1;
                    next.stateSha256 = processApi.stateDigest(next);
                    return processApi.assertState(next);
                });
            }
            const targetMigrationFile = fs.existsSync(migrationFile)
                ? path.join(directory, `implementation-migration-${currentImplementation.slice(0, 12)}.json`)
                : migrationFile;
            const receiptBody = {
                contract: 'conference-process-implementation-migration-v1', version: 1,
                processId: options.fromProcessId, conferenceId: context.authority.conferenceId,
                fromImplementationSha256: oldImplementation,
                toImplementationSha256: currentImplementation,
                previousStateSha256: beforeStateSha256,
                migratedStateSha256: state.stateSha256,
                reusedCompletePaperIds: complete.map(item => item.paperId).sort(),
                createdAt: state.updatedAt
            };
            processApi.exactFile(targetMigrationFile,
                Buffer.from(`${JSON.stringify({ ...receiptBody,
                    receiptSha256: processApi.stableHash(receiptBody) }, null, 2)}\n`));
        }
        processApi.assertState(state, { authority: context.authority, paperIds: expectedPaperIds });
        const migrationDeps = oldImplementation === currentImplementation
            ? deps
            : { ...deps, prepareShared: async () => shared };
        // 实现迁移会让旧的完成凭证失效。旧凭证保留下来以便恢复，但要把正式文件名让
        // 出来，流程完成时才能原子写入新凭证。
        archiveStaleCompletionReceipt(directory, state);
        return processApi.runConferenceProcessLocked(options, migrationDeps, context,
            options.fromProcessId, directory);
    };
    return deps.engine.withFileLock(operation, runLocked, {
        recoveryPolicy: deps.engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY
    });
}

async function main(argv = process.argv.slice(2), runtime = {}) {
    requireExternalRuntime('migrate-conference-process.js');
    const options = parseArgs(argv);
    const result = await migrateAndRun(options, runtime);
    console.log(JSON.stringify(result));
    return result;
}

if (require.main === module) {
    main().catch(error => { console.error(`[migrate-conference-process] ${error.message}`); process.exitCode = 1; });
}

module.exports = { USAGE, parseArgs, withoutImplementation, migrateAndRun, main };

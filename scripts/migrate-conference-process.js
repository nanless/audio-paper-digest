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
const retainedSourceReplay = require('./lib/conference-retained-source-replay.js');

const USAGE = '--apply --catalog NAME.json --report NAME.json --filter UUID --from PROCESS_UUID [--concurrency 1..60] [--reuse-complete-pages] [--retry-failed] [--recovery-manifest ABSOLUTE_PATH] [--reader-corrections ABSOLUTE_PATH]';
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function parseArgs(argv) {
    if (argv[0] !== '--apply') throw new Error(`命令写法不对，用法：${USAGE}`);
    const values = {};
    for (let index = 1; index < argv.length;) {
        const flag = argv[index]; const value = argv[index + 1];
        if (flag === '--reuse-complete-pages' || flag === '--retry-failed') {
            if (Object.hasOwn(values, flag)) throw new Error(`命令写法不对，用法：${USAGE}`);
            values[flag] = true; index += 1; continue;
        }
        if (!['--catalog', '--report', '--filter', '--from', '--concurrency', '--recovery-manifest', '--reader-corrections'].includes(flag)
            || !value || Object.hasOwn(values, flag)) throw new Error(`命令写法不对，用法：${USAGE}`);
        values[flag] = value; index += 2;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--catalog'] || '')
        || !/^[a-z0-9][a-z0-9._-]{0,159}\.json$/.test(values['--report'] || '')
        || !UUID_RE.test(values['--filter'] || '') || !UUID_RE.test(values['--from'] || '')
        || (values['--concurrency'] && !/^(?:[1-9]|[1-5][0-9]|60)$/.test(values['--concurrency']))
        || (values['--recovery-manifest'] && (!path.isAbsolute(values['--recovery-manifest']) || !values['--retry-failed']))
        || (values['--reader-corrections'] && (!path.isAbsolute(values['--reader-corrections']) || !values['--recovery-manifest']))) {
        throw new Error(`命令写法不对，用法：${USAGE}`);
    }
    return { apply: true, statusOnly: false, catalogName: values['--catalog'],
        reportName: values['--report'], filterId: values['--filter'],
        fromProcessId: values['--from'], concurrency: Number(values['--concurrency'] || 3),
        reuseCompletePages: Boolean(values['--reuse-complete-pages']), retryFailed: Boolean(values['--retry-failed']),
        ...(values['--recovery-manifest'] ? { recoveryManifest: values['--recovery-manifest'] } : {}),
        ...(values['--reader-corrections'] ? { readerCorrections: values['--reader-corrections'] } : {}) };
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
            throw new Error(`旧的完成凭证归档字节不同，不能覆盖：${archived}`);
        }
        archived = path.join(directory, `completion-receipt-${digest}-${state.generation}.json`);
        if (fs.existsSync(archived) && !fs.readFileSync(archived).equals(bytes)) {
            throw new Error(`旧的完成凭证归档（第 ${state.generation} 代）字节不同，不能覆盖：${archived}`);
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
        const grants = options.recoveryManifest ? require('./lib/conference-recovery-grant') : null;
        const grantHandle = grants ? grants.openRecoveryGrant({ manifestPath: options.recoveryManifest,
            processDirectory: directory, analysisRoot: deps.files.conferenceAnalysisDir, install: true }) : null;
        const grant = grantHandle ? grants.recoveryGrantSummary(grantHandle) : null;
        if (grant && (grant.processId !== options.fromProcessId
            || Object.values(state.items).some(item => item.status !== 'complete' && !grant.paperIds.includes(item.paperId)))) {
            throw new Error('追加许可只允许原完整失败集合，不能用于清单外未完成论文');
        }
        if (processApi.stableHash(withoutImplementation(state.authority, state.version))
            !== processApi.stableHash(withoutImplementation(context.authority))) {
            throw new Error('来源、筛选或其余配置与原进程不一致，不能迁移实现。');
        }
        if (processApi.stableHash(Object.keys(state.items).sort())
            !== processApi.stableHash(expectedPaperIds)) {
            throw new Error('选中的论文集合与检查点不一致，停止实现迁移');
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
        const retained = Boolean(state.sourceUpgradePromotion);
        const shared = retained
            ? retainedSourceReplay.replayCompletedPromotedShared({ context, state, directory }, deps)
            : await (deps.prepareShared || processApi.prepareShared)(sharedContext, deps, state.createdAt);
        processApi.assertSourceContinuity(state, shared);
        if (options.readerCorrections) {
            if (!grantHandle || requiresMigration || lifecycleNeedsRefresh) {
                throw new Error('人工 Reader 修正要求同一原许可及当前已完成的实现迁移；先完成普通只读后处理再绑定最终失败清单');
            }
            state = await require('./lib/conference-reader-operator-apply').applyAndStageBatch({
                manifestPath: options.readerCorrections, grantHandle, directory, state, shared }, deps);
        }
        // 只有实现或生命周期确实需要时，才重新处理已完成的论文。发布器或渲染器的提交
        // 会在 LLM 流程运行期间改变实现指纹，这时重跑只是把暂存页拉回与记录一致，
        // 不必把已完成的论文再送回 LLM。实现没变、只是普通重试时跳过这一步，
        // 直接处理未完成的论文。
        const complete = Object.values(state.items).filter(item => item.status === 'complete');
        const stagedProofs = new Map();
        const stageFailures = new Map();
        if (requiresMigration || lifecycleNeedsRefresh) {
            for (const [index, item] of complete.entries()) {
                // Rendering uses synchronous private workers. Yield between
                // papers so a stop signal can be handled before the next one.
                await new Promise(resolve => setImmediate(resolve));
                require('./lib/analysis-stop-control').assertMayStartRequest();
                const original = shared.retainedSources?.get(item.analysisRunId);
                let staged;
                try { staged = deps.postprocess.stagePaper({
                    analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId,
                    tagCatalogPath: deps.files.tagCatalogFile,
                    stagingRoot: deps.files.conferencePageStagingDir,
                    planHandle: original?.planHandle || shared.planHandle,
                    sourceRoot: original?.sourceRoot || shared.sourceCacheRoot,
                    apply: true
                });
                if (staged.status !== 'staged') {
                    throw new Error(`已完成的论文用当前后处理代码跑不过：${item.paperId}`);
                }
                if (options.reuseCompletePages && (staged.manifest.contentSha256 !== item.pageProof?.contentSha256
                    || staged.manifest.pagePath !== item.pageProof?.pagePath)) {
                    throw new Error(`按凭证重放时已完成的页面变了：${item.paperId}`);
                }
                stagedProofs.set(item.paperId, {
                    manifestSha256: staged.manifest.manifestSha256,
                    contentSha256: staged.manifest.contentSha256,
                    pagePath: staged.manifest.pagePath
                });
                } catch (error) {
                    const failure = recovery.classifyFailure(error, deps.now());
                    if (failure.systemic || options.reuseCompletePages) throw error;
                    stageFailures.set(item.paperId, failure);
                }
                if ((index + 1) % 100 === 0 || index + 1 === complete.length) {
                    process.stderr.write(`[会议统一后处理] 已检查 ${index + 1}/${complete.length}`
                        + `，通过 ${stagedProofs.size}，失败 ${stageFailures.size}\n`);
                }
            }
        }
        // Finish the complete normal postprocessing pass before granting any
        // paid retry. An ordinary migration reports the exact failed set.
        if (stageFailures.size && !options.retryFailed) return {
            status: 'partial', processId: options.fromProcessId,
            complete: complete.length - stageFailures.size, failed: stageFailures.size,
            retryFailedRequired: true, failures: [...stageFailures].map(([paperId, failure]) => ({ paperId, ...failure }))
        };
        if (grant && [...stageFailures.keys()].some(paperId => !grant.paperIds.includes(paperId))) {
            throw new Error('已完成论文出现新的后处理失败，不属于获准追加集合；保留失败并停止新派发');
        }
        if (requiresMigration || lifecycleNeedsRefresh) {
            const beforeStateSha256 = state.stateSha256;
            if (state.authority.implementationSha256 !== currentImplementation || lifecycleNeedsRefresh) {
                state = deps.engine.updateJsonFileLocked(stateFile, current => {
                    const checked = processApi.assertState(current);
                    if (processApi.stableHash(withoutImplementation(checked.authority, checked.version))
                        !== processApi.stableHash(withoutImplementation(context.authority))) {
                        throw new Error('实现迁移期间检查点的授权信息被改过');
                    }
                    if (checked.stateSha256 !== beforeStateSha256) {
                        throw new Error('实现迁移期间检查点被改过');
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
                    for (const [paperId, failure] of stageFailures) {
                        next.items[paperId] = { ...next.items[paperId], status: 'analysis_partial',
                            readerRefreshRequired: true, lastError: failure.message, lastFailure: failure,
                            retryNotBefore: null, updatedAt: deps.now() };
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
        const migrationDeps = oldImplementation === currentImplementation && !retained
            ? { ...deps }
            : { ...deps, prepareShared: async () => shared };
        const regularProcessPaper = deps.processPaper || processApi.processOne;
        migrationDeps.processPaper = async (currentContext, currentShared, item, actualDeps) => {
            if (!item.readerRefreshRequired) return regularProcessPaper(currentContext, currentShared, item, actualDeps);
            const original = currentShared.retainedSources?.get(item.analysisRunId);
            const planHandle = original?.planHandle || currentShared.planHandle;
            const sourceRoot = original?.sourceRoot || currentShared.sourceCacheRoot;
            const childId = require('./lib/conference-analysis-adapter').readerRevisionExecutionId(
                item.analysisRunId, item.analysisProof.analysisSha256);
            const childDirectory = path.join(deps.files.conferenceAnalysisDir, childId);
            let childAbsent = false;
            try { fs.lstatSync(childDirectory); }
            catch (error) { if (error.code !== 'ENOENT') throw error; childAbsent = true; }
            if (childAbsent) {
                const parent = deps.adapter.loadConferenceAnalysis({ analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId });
                if (parent.analysisFileSha256 !== item.analysisProof.analysisSha256) {
                    throw Object.assign(new Error('待恢复会议原父稿与进程分析 SHA 不一致'),
                        { code: 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY', scope: 'run', retryable: false });
                }
                // Source/permission failures precede the paper-only catch. A
                // repaired common validator may now accept an untouched parent.
                deps.adapter.verifyPlanAuthority(parent, planHandle, sourceRoot);
                let replayed;
                try { replayed = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId, tagCatalogPath: deps.files.tagCatalogFile,
                    stagingRoot: deps.files.conferencePageStagingDir, planHandle, sourceRoot, apply: true }); }
                catch (error) {
                    if (error.code !== 'CONFERENCE_POSTPROCESS_INTEGRITY'
                        || recovery.classifyFailure(error, deps.now()).systemic) throw error;
                }
                if (replayed?.status === 'staged') {
                    const manifest = replayed.manifest;
                    if (manifest.analysisSha256 !== item.analysisProof.analysisSha256
                        || manifest.completionReceiptSha256 !== item.analysisProof.completionReceiptSha256
                        || manifest.sourceSnapshotSha256 !== item.analysisProof.sourceSnapshotSha256) {
                        throw Object.assign(new Error('重验会议原父稿的分析、来源或完成凭证 SHA 改变'),
                            { code: 'CONFERENCE_SOURCE_CONTEXT_INTEGRITY', scope: 'run', retryable: false });
                    }
                    return { readerRefreshRequired: false, analysisProof: item.analysisProof,
                        pageProof: { manifestSha256: manifest.manifestSha256,
                            contentSha256: manifest.contentSha256, pagePath: manifest.pagePath } };
                }
            }
            const revised = grantHandle
                ? await deps.adapter.refreshConferenceGrantedRecovery({ analysisRoot: deps.files.conferenceAnalysisDir,
                    parentExecutionId: item.analysisRunId, planHandle, sourceRoot,
                    failedExecutionId: grants.readRecoveryGrantMember(grantHandle, item.paperId).failedExecutionId,
                    grantHandle, reusePaidCoreDiagnostics: true })
                : await deps.adapter.refreshConferenceReader({ analysisRoot: deps.files.conferenceAnalysisDir,
                    parentExecutionId: item.analysisRunId, planHandle, sourceRoot,
                    reusePaidCoreDiagnostics: options.retryFailed === true,
                    maxAttempts: Math.min(recovery.MAX_ATTEMPTS, deps.analysisConfig?.batchMaxRounds ?? 3) });
            let staged;
            try { staged = deps.postprocess.stagePaper({ analysisRoot: deps.files.conferenceAnalysisDir,
                executionId: revised.executionId, tagCatalogPath: deps.files.tagCatalogFile,
                stagingRoot: deps.files.conferencePageStagingDir, planHandle, sourceRoot, apply: true });
                if (staged.status !== 'staged') throw new Error(`恢复后的会议 Reader 后处理未通过：${item.paperId}`);
            } catch (cause) {
                // A completed replacement cannot silently receive another paid
                // budget merely because a later publication check rejects it.
                throw Object.assign(new Error(`新会议修订稿已保留，后处理仍失败：${cause.message}`, { cause }),
                    { code: 'CONFERENCE_READER_REVISION_POSTPROCESS_FAILED', retryable: false,
                        executionId: revised.executionId });
            }
            if (currentShared.retainedSources) {
                currentShared.retainedSources.delete(item.analysisRunId);
                currentShared.retainedSources.set(revised.executionId, { ...original, planHandle, sourceRoot });
            }
            return { analysisRunId: revised.executionId, readerRevision: revised.revision,
                readerRefreshRequired: false,
                analysisProof: { analysisSha256: revised.analysisSha256,
                    completionReceiptSha256: staged.manifest.completionReceiptSha256,
                    sourceSnapshotSha256: staged.manifest.sourceSnapshotSha256 },
                pageProof: { manifestSha256: staged.manifest.manifestSha256,
                    contentSha256: staged.manifest.contentSha256, pagePath: staged.manifest.pagePath } };
        };
        if (retained && !deps.aggregate) migrationDeps.aggregate = async (_context, currentShared, executionIds) =>
            deps.postprocess.aggregateConference({
                analysisRoot: deps.files.conferenceAnalysisDir, executionIds,
                tagCatalogPath: deps.files.tagCatalogFile, stagingRoot: deps.files.conferencePageStagingDir,
                aggregateRoot: deps.files.conferenceAggregateDir, planHandle: currentShared.planHandle,
                sourceRoot: currentShared.sourceCacheRoot,
                retainedSources: currentShared.retainedSources, apply: true
            });
        // 实现迁移会让旧的完成凭证失效。旧凭证保留下来以便恢复，但要把正式文件名让
        // 出来，流程完成时才能原子写入新凭证。
        archiveStaleCompletionReceipt(directory, state);
        return processApi.runConferenceProcessLocked(grant ? { ...options, recoveryGrantId: grant.grantId,
            recoveryGrantSha256: grant.grantSha256 } : options, migrationDeps, context,
            options.fromProcessId, directory);
    };
    return deps.engine.withFileLock(operation, () => require('./lib/analysis-stop-control')
        .withAnalysisStopControl(runLocked), {
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

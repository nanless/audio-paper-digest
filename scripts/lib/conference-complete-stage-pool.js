'use strict';

// Pure completed-paper staging only. The caller keeps the process operation
// lock and remains the sole state/receipt writer. Workers never dispatch LLMs.
const fs = require('node:fs'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const MAX_STAGE_WORKERS = 5;
const aggregateBatches = new WeakMap();
function integrity(message) {
    return Object.assign(new Error(`会议并行后处理：${message}`), {
        code: 'CONFERENCE_STAGE_WORKER_INTEGRITY', scope: 'run', retryable: false
    });
}
function serializeError(error) {
    const result = Object.fromEntries(['message', 'code', 'scope', 'retryable', 'category', 'status', 'modelRequestClassified']
        .filter(key => error?.[key] !== undefined).map(key => [key, error[key]]));
    const recovery = require('./conference-process-recovery');
    if (recovery.classifyFailure(error, new Date().toISOString()).systemic
        || error?.code === require('./analysis-stop-control').MODEL_REQUESTS_FORBIDDEN) result.scope = 'run';
    const storage = recovery.findStorageFailure(error);
    if (storage && storage !== error) result.cause = { code: storage.code, message: String(storage.message).slice(0, 2000) };
    return result;
}
function restoreError(value) {
    if (!value || typeof value.message !== 'string' || value.message.length > 128 * 1024) {
        return integrity('worker错误记录不完整');
    }
    return Object.assign(new Error(value.message), value);
}
function assertManifestItem(manifest, item) {
    if (manifest?.paperId !== item.paperId || manifest.analysisExecutionId !== item.analysisRunId
        || manifest.analysisSha256 !== item.analysisProof?.analysisSha256
        || manifest.completionReceiptSha256 !== item.analysisProof?.completionReceiptSha256
        || manifest.sourceSnapshotSha256 !== item.analysisProof?.sourceSnapshotSha256) {
        throw integrity('暂存页面没有绑定原完整成员的分析、完成凭证和来源');
    }
}
function loadedPins(loaded) {
    const publication = require('./publication-file-primitives');
    const extra = {};
    for (const name of ['reader-revision.json', 'reader-resource-preflight.json', 'recovery-seed.json', 'reader-grant-budget.json']) {
        const file = path.join(loaded.directory, name);
        if (fs.existsSync(file)) extra[name] = publication.readRegular(file).sha256;
    }
    return { analysis: loaded.analysisFileSha256, run: loaded.runFileSha256, source: loaded.sourceFileSha256, extra };
}

// The worker reconstructs its own opaque capabilities from real archived
// authority. No transferred JSON can serve as a plan/PDF/grant handle.
function createStageSession(init) {
    require('../env-loader').requireExternalRuntime('migrate-conference-process.js');
    const api = require('./conference-process'), adapter = require('./conference-analysis-adapter');
    const publication = require('./publication-file-primitives'), deps = api.defaultDependencies();
    if (!init || !path.isAbsolute(init.stagingRoot || '') || !/^[a-f0-9]{64}$/.test(init.stateFileSha256 || '')) {
        throw integrity('缺少固定暂存根或实际状态SHA');
    }
    if (init.operation !== undefined && init.operation !== 'read-stage') throw integrity('未知私有后处理操作');
    const options = require('../migrate-conference-process').parseArgs(['--apply', '--catalog', init.options?.catalogName,
        '--report', init.options?.reportName, '--filter', init.options?.filterId, '--from', init.options?.fromProcessId]);
    const directory = api.safeProcessDirectory(deps.files.conferenceProcessDir, options.fromProcessId, false);
    const stateFile = path.join(directory, 'state.json'), record = adapter.readJsonRecord(stateFile);
    const state = api.assertState(record.value);
    if (record.sha256 !== init.stateFileSha256 || state.processId !== options.fromProcessId
        || state.stateSha256 !== init.stateSha256) throw integrity('worker实际进程状态与停稳快照不一致');
    const context = api.loadAuthority(options, deps);
    if (api.stableHash(context.authority) !== init.authoritySha256) throw integrity('worker真实来源授权或实现已变化');
    const replay = require('./conference-retained-source-replay').createRetainedSourceReplay(context, deps);
    const projection = deps.postprocess.implementationFingerprint();
    if (projection.implementationSha256 !== init.projectionSha256) throw integrity('worker页面实现指纹不一致');
    if (init.operation === 'read-stage') assertOperationLock(directory, init.operationLock);
    const pins = new Map();
    function canonicalPins(item) {
        const loaded = adapter.loadConferenceAnalysis({ analysisRoot: deps.files.conferenceAnalysisDir, executionId: item.analysisRunId });
        if (loaded.analysis.status !== 'complete' || loaded.run.status !== 'complete'
            || loaded.run.paperId !== item.paperId || loaded.analysisFileSha256 !== item.analysisProof.analysisSha256
            || loaded.run.completionReceipt?.receiptSha256 !== item.analysisProof.completionReceiptSha256
            || loaded.run.sourceSnapshotSha256 !== item.analysisProof.sourceSnapshotSha256) throw integrity('完整成员的实际canonical已变化');
        return loadedPins(loaded);
    }
    async function stage(task) {
        const item = state.items[task?.paperId];
        if (!item || item.status !== 'complete' || item.analysisRunId !== task.executionId
            || api.stableHash(item) !== task.itemSha256) throw integrity('任务不是同一快照的完整成员');
        return deps.engine.withPaperAnalysisLock({ id: item.paperId }, () =>
            require('./analysis-stop-control').withModelRequestsForbidden(() => {
                if (init.operation === 'read-stage') assertOperationLock(directory, init.operationLock);
                const before = canonicalPins(item);
                let original;
                try { original = replay.forItem(item); }
                catch (cause) { throw Object.assign(integrity(`worker原来源重放失败：${cause.message}`), { cause }); }
                const request = { analysisRoot: deps.files.conferenceAnalysisDir,
                    executionId: item.analysisRunId, tagCatalogPath: deps.files.tagCatalogFile,
                    stagingRoot: init.stagingRoot, planHandle: original.planHandle, sourceRoot: original.sourceRoot, apply: true };
                const staged = init.operation === 'read-stage'
                    ? { status: 'loaded-stage', ...deps.postprocess.loadStageAndCompleted(request).staged }
                    : deps.postprocess.stagePaper(request);
                if (!['staged', 'loaded-stage'].includes(staged.status)) throw Object.assign(new Error(`已完成论文正常暂存仍为 ${staged.status}`),
                    { code: 'CONFERENCE_POSTPROCESS_INTEGRITY' });
                assertManifestItem(staged.manifest, item);
                if (api.stableHash(before) !== api.stableHash(canonicalPins(item))) throw integrity('资格核验期间原完整包改变');
                pins.set(item.paperId, before);
                return { status: staged.status, manifest: staged.manifest, pins: before };
            }));
    }
    function assertUnchanged() {
        if (init.operation === 'read-stage') assertOperationLock(directory, init.operationLock);
        if (publication.readRegular(stateFile).sha256 !== init.stateFileSha256
            || api.implementationSha256() !== context.authority.implementationSha256
            || deps.postprocess.implementationFingerprint().implementationSha256 !== init.projectionSha256) {
            throw integrity('并行阶段结束前实际状态或实现变化');
        }
        for (const [paperId, expected] of pins) if (api.stableHash(canonicalPins(state.items[paperId])) !== api.stableHash(expected)) {
            throw integrity('并行暂存后原完整包变化');
        }
    }
    return { stage, assertUnchanged };
}

// Verify the actual immutable hand-off bytes without repeating Reader/rendering.
function verifyStageResult(result, item, init, files) {
    const api = require('./conference-process'), publication = require('./publication-file-primitives');
    if (!['staged', 'loaded-stage'].includes(result?.status)) throw integrity('worker未返回真实暂存结果');
    const manifest = result.manifest; assertManifestItem(manifest, item);
    const { manifestSha256, ...body } = manifest;
    const registry = manifest.tagMetadata?.registrySha256;
    if (manifest.contract !== 'conference-paper-page-staging-v2' || manifest.version !== 2 || manifest.status !== 'complete'
        || manifestSha256 !== api.stableHash(body) || !/^[a-f0-9]{64}$/.test(registry || '')
        || registry !== init.registrySha256
        || manifest.implementation?.implementationSha256 !== init.projectionSha256) throw integrity('页面清单自校验或实现不一致');
    const directory = path.join(init.stagingRoot, item.analysisRunId, registry, init.projectionSha256);
    const read = (name, max) => publication.readRegular(path.join(directory, name), max);
    const actual = read('manifest.json', 16 * 1024 * 1024);
    // Page staging preserves insertion order; process-state canonicalBytes
    // sorts keys and is intentionally a different on-disk serialization.
    const expectedManifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (!actual.bytes.equals(expectedManifestBytes) || read('page.md', 32 * 1024 * 1024).sha256 !== manifest.contentSha256
        || read('assignment.json', 16 * 1024 * 1024).sha256 !== manifest.tagAssignmentFileSha256) throw integrity('暂存交接字节与worker清单不符');
    if (!Array.isArray(manifest.assets)) throw integrity('暂存资源集合缺失');
    for (const asset of manifest.assets) {
        if (typeof asset.path !== 'string' || !/^(?:static\/)[A-Za-z0-9_./-]+$/.test(asset.path)
            || asset.path.split('/').some(part => !part || part === '.' || part === '..')) throw integrity('暂存资源路径不安全');
        const record = read(path.join('assets', asset.path), 32 * 1024 * 1024);
        if (record.sha256 !== asset.sha256 || record.bytes.length !== asset.size) throw integrity('暂存资源交接SHA不一致');
    }
    assertStageCanonical(result, item, files);
    return manifest;
}
function assertStageCanonical(result, item, files) {
    const api = require('./conference-process'), adapter = require('./conference-analysis-adapter');
    const loaded = adapter.loadConferenceAnalysis({ analysisRoot: files.conferenceAnalysisDir, executionId: item.analysisRunId });
    const pins = loadedPins(loaded);
    if (api.stableHash(pins) !== api.stableHash(result.pins)) throw integrity('主线程交接时完整包已变化');
    return loaded;
}

function operationLockStamp(directory) {
    const os = require('node:os'), publication = require('./publication-file-primitives');
    const lock = path.join(directory, '.operation.lock');
    require('./fresh-rewrite-run').assertSafeDirectory(lock);
    const stat = fs.lstatSync(lock), ownerFile = path.join(lock, 'owner.json');
    const record = publication.readRegular(ownerFile, 64 * 1024), owner = JSON.parse(record.bytes);
    if ((stat.mode & 0o777) !== 0o700 || (fs.lstatSync(ownerFile).mode & 0o777) !== 0o600
        || owner.pid !== process.pid || owner.hostname !== os.hostname() || typeof owner.token !== 'string') {
        throw integrity('完整聚合必须持有本进程真实会议操作锁');
    }
    return { dev: stat.dev, ino: stat.ino, ownerFileSha256: record.sha256 };
}
function assertOperationLock(directory, expected) {
    const api = require('./conference-process');
    if (!expected || api.stableHash(operationLockStamp(directory)) !== api.stableHash(expected)) throw integrity('聚合操作锁换主或缺失');
}

// Only this fixed real worker path can mint a batch. There is intentionally no
// dependency/worker injection or JSON "qualified stages" parameter here.
async function collectAggregateStageBatch(input, operation, planProof) {
    const api = require('./conference-process'), adapter = require('./conference-analysis-adapter');
    const deps = api.defaultDependencies(), stop = require('./analysis-stop-control');
    if (!operation || !/^[a-f0-9]{64}$/.test(operation.authoritySha256 || '')
        || path.resolve(input.analysisRoot) !== path.resolve(deps.files.conferenceAnalysisDir)
        || path.resolve(input.tagCatalogPath) !== path.resolve(deps.files.tagCatalogFile)) throw integrity('聚合缺少实际配置与来源授权身份');
    const directory = api.safeProcessDirectory(deps.files.conferenceProcessDir, operation.processId, false);
    const lock = operationLockStamp(directory), stateFile = path.join(directory, 'state.json');
    const record = adapter.readJsonRecord(stateFile), state = api.assertState(record.value);
    const items = Object.values(state.items), ids = items.map(item => item.paperId).sort((a,b) => a.localeCompare(b));
    if (items.some(item => item.status !== 'complete')
        || api.stableHash(ids) !== api.stableHash(planProof.paperIds)
        || api.stableHash(items.map(item => item.analysisRunId).sort()) !== api.stableHash([...input.executionIds].sort())
        || ['conferenceId', 'filterPolicySha256', 'selectionReceiptSha256', 'selectedMemberSetSha256']
            .some(key => state.authority[key] !== planProof[key])) throw integrity('聚合必须覆盖实际状态与真实计划完整完成集合');
    const init = { options: { catalogName: state.authority.catalogName, reportName: state.authority.reportName,
        filterId: state.authority.filterId, fromProcessId: state.processId },
        operation: 'read-stage', operationLock: lock, stagingRoot: input.stagingRoot,
        stateFileSha256: record.sha256, stateSha256: state.stateSha256,
        authoritySha256: operation.authoritySha256, registrySha256: require('./tag-catalog').loadTagCatalog(input.tagCatalogPath).registrySha256,
        projectionSha256: require('./conference-postprocess').implementationFingerprint().implementationSha256 };
    const results = new Map(), stages = new Map();
    await runStagePool(items, { concurrency: operation.concurrency, init,
        shouldStop: () => stop.assertMayStartRequest(), onResult: (item, result, error) => {
            if (error) throw error; // aggregate cannot certify a partial set
            if (result.status !== 'loaded-stage') throw integrity('聚合worker没有运行只读正常loadStage');
            const manifest = verifyStageResult(result, item, init, deps.files);
            const loaded = assertStageCanonical(result, item, deps.files);
            const stageDirectory = path.join(input.stagingRoot, item.analysisRunId, init.registrySha256, init.projectionSha256);
            const read = name => require('./publication-file-primitives').readRegular(path.join(stageDirectory, name)).sha256;
            stages.set(item.paperId, { directory: stageDirectory, manifest, tagMetadata: manifest.tagMetadata,
                tagAssignmentFileSha256: manifest.tagAssignmentFileSha256, manifestFileSha256: read('manifest.json'),
                assignmentFileSha256: read('assignment.json'), pageFileSha256: read('page.md'), completed: loaded });
            results.set(item.paperId, result);
            if (results.size % 100 === 0 || results.size === items.length) {
                process.stderr.write(`[会议汇总来源及页面复核] 已检查 ${results.size}/${items.length}\n`);
            }
        } });
    const handle = Object.freeze(Object.create(null));
    aggregateBatches.set(handle, { input: { ...input, executionIds: [...input.executionIds],
        ...(input.retainedSources ? { retainedSources: new Map(input.retainedSources) } : {}) },
        planProof: api.stableHash(planProof), ids: [...planProof.paperIds],
        init, directory, stateFile, items, results, stages, files: deps.files });
    assertAggregateSnapshot(aggregateBatch(handle));
    return handle;
}
function aggregateBatch(handle) {
    const batch = aggregateBatches.get(handle);
    if (!batch) throw integrity('需要本次真实完整并行核验产生的私有聚合能力');
    return batch;
}
function readAggregateStageBatch(handle, executionIds, planProof) {
    const api = require('./conference-process'), batch = aggregateBatch(handle);
    if (api.stableHash(planProof) !== batch.planProof
        || api.stableHash([...executionIds].sort()) !== api.stableHash(batch.input.executionIds.slice().sort())) throw integrity('聚合能力离开原完整计划及成员集合');
    assertAggregateSnapshot(batch);
    return batch.ids.map(id => batch.stages.get(id));
}
function assertAggregateSnapshot(batch) {
    const publication = require('./publication-file-primitives');
    assertOperationLock(batch.directory, batch.init.operationLock);
    if (publication.readRegular(batch.stateFile).sha256 !== batch.init.stateFileSha256
        || require('./conference-postprocess').implementationFingerprint().implementationSha256 !== batch.init.projectionSha256
        || require('./tag-catalog').loadTagCatalog(batch.input.tagCatalogPath).registrySha256 !== batch.init.registrySha256) throw integrity('聚合期间状态、实现或词表变化');
}
function assertAggregateStageBatchUnchanged(handle) {
    const adapter = require('./conference-analysis-adapter'), batch = aggregateBatch(handle);
    assertAggregateSnapshot(batch);
    for (const item of batch.items) {
        verifyStageResult(batch.results.get(item.paperId), item, batch.init, batch.files);
        const loaded = assertStageCanonical(batch.results.get(item.paperId), item, batch.files);
        const original = batch.input.retainedSources?.get(item.analysisRunId);
        // Source-only recheck, not a second Reader qualification. Keep real
        // parent-isolate plan authority and exact PDF/source SHA through save.
        adapter.verifyPlanAuthority(loaded, original?.planHandle || batch.input.planHandle,
            original?.sourceRoot || batch.input.sourceRoot);
    }
}

async function runStagePool(items, { concurrency, init, shouldStop = () => {}, onResult = () => {} }, dependencies = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 60) throw integrity('并发必须在1–60之间');
    if (new Set(items.map(item => item.paperId)).size !== items.length
        || new Set(items.map(item => item.analysisRunId)).size !== items.length) throw integrity('并行暂存集合有重复论文或执行');
    const count = Math.min(MAX_STAGE_WORKERS, concurrency, items.length);
    if (!count) return;
    const spawn = dependencies.createWorker || (data => new Worker(path.join(__dirname, 'conference-complete-stage-worker.js'), { workerData: data }));
    let cursor = 0, failure = null;
    const fail = error => { failure ||= error; };
    async function lane() {
        let worker, requestId = 0, pending = null, exiting = false, exited = false, exitPromise;
        try {
            worker = spawn(init);
            exitPromise = new Promise(resolve => worker.once('exit', () => { exited = true; resolve(); }));
            const ask = message => new Promise((resolve, reject) => {
                if (exited) { reject(failure || integrity('worker已经退出')); return; }
                pending = { id: ++requestId, resolve, reject }; worker.postMessage({ ...message, id: requestId });
            });
            worker.on('message', message => {
                const current = pending;
                if (!current || message?.id !== current.id || !['result', 'error'].includes(message.type)) {
                    fail(integrity('worker回包顺序或类型错误')); current?.reject(failure); pending = null; return;
                }
                pending = null;
                if (message.type === 'error') current.reject(restoreError(message.error)); else current.resolve(message.result);
            });
            worker.on('error', error => { fail(integrity(`worker运行异常：${error.message}`)); pending?.reject(failure); pending = null; });
            worker.on('exit', code => {
                if (!exiting) { fail(integrity(`worker提前退出（${code}）`)); pending?.reject(failure); pending = null; }
            });
            await ask({ type: 'ready' });
            while (!failure && cursor < items.length) {
                shouldStop();
                const index = cursor++, item = items[index];
                let result, error;
                try { result = await ask({ type: 'stage', task: { paperId: item.paperId,
                    executionId: item.analysisRunId, itemSha256: require('./conference-process').stableHash(item) } }); }
                catch (caught) { error = caught; }
                // onResult classifies ordinary paper failures; a systemic error
                // throws, stops all new dispatch, and drains other active lanes.
                await onResult(item, result, error, index);
            }
            if (!exited) await ask({ type: 'finish' });
        } catch (error) { fail(error); }
        finally {
            if (worker) {
                // Every synchronous stage has returned before closing. Never
                // terminate a live stage or strand its same-process lock.
                exiting = true;
                if (!exited) worker.postMessage({ type: 'close' });
                await exitPromise;
            }
        }
    }
    await Promise.all(Array.from({ length: count }, lane));
    if (failure) throw failure;
    shouldStop();
}
module.exports = { MAX_STAGE_WORKERS, integrity, serializeError, createStageSession, verifyStageResult,
    assertStageCanonical, runStagePool, assertManifestItem, collectAggregateStageBatch,
    readAggregateStageBatch, assertAggregateStageBatchUnchanged };

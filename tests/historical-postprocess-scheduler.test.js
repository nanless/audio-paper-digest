'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('../scripts/lib/historical-postprocess-scheduler.js');
const cli = require('../scripts/historical-postprocess-scheduler.js');

const CROSSWALK = '11111111-1111-4111-8111-111111111111';
const REGISTRY = '9'.repeat(64); const DATE = '2026-04-19';
const RENDERER = '8'.repeat(64);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, secondStatus = 'complete') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'history-postprocess-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paperIds = ['arxiv:2604.00001', 'arxiv:2604.00002'];
    const runIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
    const pages = paperIds.map((paperId, index) => ({ pageKey: `page:${String(index + 1).repeat(64)}`,
        pagePath: `content/posts/paper-${index}.md`, primaryUrl: `https://example.test/posts/paper-${index}/`,
        pageContentSha256: String(index + 4).repeat(64), cohortDate: DATE, scope: { type: 'daily', key: DATE } }));
    const crosswalk = { crosswalkId: CROSSWALK, source: { papers: pages }, assignments: {}, identityGroups: [] };
    for (let index = 0; index < paperIds.length; index += 1) {
        crosswalk.assignments[pages[index].pageKey] = { status: 'verified', sourceAuthority: { paperId: paperIds[index] } };
        crosswalk.identityGroups.push({ paperId: paperIds[index], pageKeys: [pages[index].pageKey] });
    }
    const files = { historicalAnalysisSchedulerDir: path.join(root, 'analysis-scheduler'),
        historicalPostprocessSchedulerDir: path.join(root, 'postprocess'), tagCatalogFile: path.join(root, 'taxonomy.json'),
        pageSourceCrosswalkDir: path.join(root, 'crosswalk'), freshRewriteRunsDir: path.join(root, 'runs'),
        historicalTagAssignmentDir: path.join(root, 'assignments'), historicalPageStagingDir: path.join(root, 'staging'),
        historicalPageInventoryDir: path.join(root, 'inventory'), historicalDailyAggregateDir: path.join(root, 'aggregates') };
    fs.mkdirSync(files.historicalAnalysisSchedulerDir, { recursive: true });
    const items = Object.fromEntries(paperIds.map((paperId, index) => [paperId, { status: index ? secondStatus : 'complete',
        runId: runIds[index], analysisDate: DATE, cohortDates: [DATE], pageKeys: [pages[index].pageKey] }]));
    const scheduler = { contract: api.ANALYSIS_SCHEDULER_CONTRACT, version: 1, crosswalkId: CROSSWALK, items };
    fs.writeFileSync(path.join(files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`), JSON.stringify(scheduler));
    let tick = 0; let active = 0; let maximumActive = 0; let assignmentWrites = 0;
    const stageCalls = []; const aggregateCalls = [];
    const updateLocked = (filename, updater) => {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        const current = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null;
        const next = updater(current); if (next === undefined) return current;
        fs.writeFileSync(filename, `${JSON.stringify(next, null, 2)}\n`); return next;
    };
    const deps = { files, now: () => `2026-09-07T00:00:${String(tick++).padStart(2, '0')}.000Z`,
        rendererImplementationSha256: () => RENDERER,
        updateLocked, loadTagCatalog: () => ({ registrySha256: REGISTRY }), readCrosswalk: () => crosswalk,
        recoverRun: () => ({ storageSealed: true, currentContractComplete: true }), loadAnalysisRun: ({ runId }) => ({ runId }),
        buildAssignments: ({ runHandle, paperId }) => [{ paperId, analysisRunId: runHandle.runId,
            analysisFileSha256: sha(`analysis-file:${paperId}`),
            analysisRecordSha256: sha(`analysis-record:${paperId}`), analysisSha256: sha(`analysis:${paperId}`),
            registrySha256: REGISTRY, status: 'assigned', assignmentSha256: sha(paperId) }],
        writeAssignments: ({ assignments }) => { assignmentWrites += 1; return [{ paperId: assignments[0].paperId,
            fileSha256: sha(`file:${assignments[0].paperId}`) }]; },
        stagePages: async options => { active += 1; maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setImmediate(resolve)); active -= 1; stageCalls.push(options);
            const manifestSha256 = sha(`manifest:${options.stagingRunId}`);
            const expected = options.expectedAssignment;
            return { status: 'staged', manifestSha256, manifest: {
                contract: 'historical-paper-page-staging-v2', version: 2, stagingRunId: options.stagingRunId,
                rendererImplementationSha256: options.rendererImplementationSha256,
                manifestSha256,
                pages: [{ paperId: expected.paperId, analysisRunId: expected.analysisRunId,
                    analysisFileSha256: expected.analysisFileSha256,
                    analysisRecordSha256: expected.analysisRecordSha256,
                    analysisSha256: expected.analysisSha256,
                    tagAssignmentSha256: expected.assignmentSha256,
                    tagAssignmentFileSha256: expected.tagAssignmentFileSha256 }]
            } }; },
        loadAggregateInputs: options => ({ options }),
        buildAggregates: ({ inputs, date }) => [{ date, manifestSha256: sha(`aggregate:${date}`), inputs }],
        aggregateRunIdFor: () => '66666666-6666-4666-8666-666666666666',
        writeAggregates: options => { aggregateCalls.push(options); return [{ fileSha256: sha('aggregate-file') }]; } };
    return { root, files, deps, crosswalk, paperIds, runIds, stageCalls, aggregateCalls,
        maximumActive: () => maximumActive, assignmentWrites: () => assignmentWrites };
}

test('已保存并核验的单篇运行并发分配与暂存，两次运行汇总出一个完整日期', async t => {
    const f = fixture(t); const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 2 }, f.deps);
    assert.equal(result.status, 'complete'); assert.equal(result.processed.length, 2);
    assert.equal(f.stageCalls.length, 2); assert.equal(f.maximumActive(), 2);
    assert.equal(f.aggregateCalls.length, 1);
    assert.equal(f.aggregateCalls[0].aggregates[0].inputs.options.stagingRunIds.length, 2);
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpoint));
    assert.equal(checkpoint.contract, 'historical-postprocess-scheduler-v2');
    assert.equal(checkpoint.version, 2);
    assert.ok(Object.values(checkpoint.items).every(item => Object.hasOwn(item, 'tagAssignmentSha256')
        && Object.hasOwn(item, 'tagAssignmentFileSha256') && !Object.hasOwn(item, 'taxonomyAssignmentSha256')));
    assert.equal(checkpoint.checkpointSha256, api.withCheckpointHash({ ...checkpoint, checkpointSha256: undefined }).checkpointSha256);
    const firstSha = sha(fs.readFileSync(result.checkpoint));
    const repeated = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 3 }, f.deps);
    assert.equal(repeated.status, 'complete'); assert.equal(sha(fs.readFileSync(result.checkpoint)), firstSha);
    assert.equal(repeated.processed[0].stagingRunId, result.processed[0].stagingRunId);
    const changedOnlyVolatile = { ...JSON.parse(fs.readFileSync(path.join(f.files.historicalAnalysisSchedulerDir,
        `${CROSSWALK}.json`))).items[f.paperIds[0]], updatedAt: 'later', lastError: 'ignored while complete' };
    const rebound = { ...changedOnlyVolatile, paperId: f.paperIds[0],
        analysisSchedulerItemSha256: api.stableHash(api.analysisSchedulerItemBinding(f.paperIds[0], changedOnlyVolatile)) };
    assert.equal(api.deterministicStagingRunId(CROSSWALK, rebound, REGISTRY, RENDERER,
        result.processed[0].tagAssignmentSha256), result.processed[0].stagingRunId);
});

test('渲染器实现变化会新建暂存运行和检查点，不复用旧证明', async t => {
    const f = fixture(t); const options = { apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 };
    const first = await api.runHistoricalPostprocess(options, f.deps);
    const firstCheckpoint = JSON.parse(fs.readFileSync(first.checkpoint));
    const oldRunId = first.processed[0].stagingRunId;
    const replacementRenderer = '7'.repeat(64);
    f.deps.rendererImplementationSha256 = () => replacementRenderer;
    const second = await api.runHistoricalPostprocess(options, f.deps);
    const secondCheckpoint = JSON.parse(fs.readFileSync(second.checkpoint));
    assert.notEqual(second.checkpoint, first.checkpoint);
    assert.notEqual(second.processed[0].stagingRunId, oldRunId);
    assert.equal(fs.existsSync(first.checkpoint), true);
    assert.equal(firstCheckpoint.items[f.paperIds[0]].rendererImplementationSha256, RENDERER);
    assert.equal(secondCheckpoint.items[f.paperIds[0]].rendererImplementationSha256, replacementRenderer);
    assert.throws(() => api.validateCheckpoint(firstCheckpoint, CROSSWALK, REGISTRY,
        replacementRenderer), /历史后处理检查点的身份或结构与当前输入不一致/);
    assert.doesNotThrow(() => api.validateCheckpoint(secondCheckpoint, CROSSWALK, REGISTRY,
        replacementRenderer));
    assert.equal(f.stageCalls.at(-1).rendererImplementationSha256, replacementRenderer);
});

test('分析分配升级会新建暂存身份，同时保留旧检查点证明', async t => {
    const f = fixture(t); const options = { apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 };
    const first = await api.runHistoricalPostprocess(options, f.deps);
    const oldRunId = first.processed[0].stagingRunId;
    const originalBuild = f.deps.buildAssignments;
    f.deps.buildAssignments = args => originalBuild(args).map(assignment => ({ ...assignment,
        analysisFileSha256: 'a'.repeat(64), analysisRecordSha256: 'b'.repeat(64),
        analysisSha256: 'c'.repeat(64), assignmentSha256: 'd'.repeat(64) }));
    const second = await api.runHistoricalPostprocess(options, f.deps);
    assert.notEqual(second.processed[0].stagingRunId, oldRunId);
    assert.equal(second.processed[0].analysisFileSha256, 'a'.repeat(64));
    assert.equal(second.processed[0].analysisRecordSha256, 'b'.repeat(64));
    assert.equal(second.processed[0].tagAssignmentSha256, 'd'.repeat(64));
    assert.ok(f.aggregateCalls.at(-1).aggregates[0].inputs.options.stagingRunIds
        .includes(second.processed[0].stagingRunId));
    assert.ok(!f.aggregateCalls.at(-1).aggregates[0].inputs.options.stagingRunIds.includes(oldRunId));
});

test('试运行处理不会汇总同一日期下过时且未入选的兄弟记录', async t => {
    const f = fixture(t); const options = { apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 };
    await api.runHistoricalPostprocess(options, f.deps);
    const aggregateCount = f.aggregateCalls.length;
    const originalBuild = f.deps.buildAssignments;
    f.deps.buildAssignments = args => originalBuild(args).map(assignment => (
        assignment.paperId === f.paperIds[1]
            ? { ...assignment, analysisFileSha256: 'a'.repeat(64),
                analysisRecordSha256: 'b'.repeat(64), analysisSha256: 'c'.repeat(64),
                assignmentSha256: 'd'.repeat(64) }
            : assignment
    ));
    const result = await api.runHistoricalPostprocess({ ...options, limit: 'pilot' }, f.deps);
    assert.equal(result.processed.length, 1);
    assert.equal(result.daily[0].status, 'blocked');
    assert.equal(f.aggregateCalls.length, aggregateCount,
        'the old sibling staging proof must not reach the aggregate loader');
});

test('暂存期间分析与标签分配的 SHA 改变时，拒绝将原记录标为已暂存', async t => {
    const f = fixture(t); const originalBuild = f.deps.buildAssignments;
    const originalStage = f.deps.stagePages; let drifted = false;
    f.deps.buildAssignments = args => originalBuild(args).map(assignment => drifted
        ? { ...assignment, analysisFileSha256: 'a'.repeat(64),
            analysisRecordSha256: 'b'.repeat(64), analysisSha256: 'c'.repeat(64),
            assignmentSha256: 'd'.repeat(64) }
        : assignment);
    f.deps.stagePages = async options => {
        const staged = await originalStage(options);
        drifted = true;
        return staged;
    };
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: 'pilot', concurrency: 1 }, f.deps);
    assert.equal(result.processed[0].status, 'failed');
    assert.match(result.processed[0].lastError, /在页面暂存期间发生变化/);
    assert.equal(result.daily[0].status, 'blocked');
});

test('升级一篇跨多日期的论文会用新的暂存运行重建每个日期分组', async t => {
    const f = fixture(t); const extraDate = '2026-04-20';
    const extraKey = `page:${'f'.repeat(64)}`;
    f.crosswalk.source.papers.push({ ...f.crosswalk.source.papers[0], pageKey: extraKey,
        pagePath: 'content/posts/paper-extra.md', primaryUrl: 'https://example.test/posts/paper-extra/',
        cohortDate: extraDate, scope: { type: 'daily', key: extraDate } });
    f.crosswalk.assignments[extraKey] = { status: 'verified',
        sourceAuthority: { paperId: f.paperIds[0] } };
    f.crosswalk.identityGroups[0].pageKeys.push(extraKey);
    const schedulerPath = path.join(f.files.historicalAnalysisSchedulerDir, `${CROSSWALK}.json`);
    const scheduler = JSON.parse(fs.readFileSync(schedulerPath));
    scheduler.items[f.paperIds[0]].cohortDates.push(extraDate);
    scheduler.items[f.paperIds[0]].pageKeys.push(extraKey);
    fs.writeFileSync(schedulerPath, JSON.stringify(scheduler));

    const options = { apply: true, crosswalkId: CROSSWALK, date: DATE, limit: null, concurrency: 1 };
    const first = await api.runHistoricalPostprocess(options, f.deps);
    assert.deepEqual(first.daily.map(item => item.date), [DATE, extraDate]);
    const oldRunId = first.processed.find(item => item.paperId === f.paperIds[0]).stagingRunId;
    const originalBuild = f.deps.buildAssignments;
    f.deps.buildAssignments = args => originalBuild(args).map(assignment => (
        assignment.paperId === f.paperIds[0]
            ? { ...assignment, analysisFileSha256: 'a'.repeat(64),
                analysisRecordSha256: 'b'.repeat(64), analysisSha256: 'c'.repeat(64),
                assignmentSha256: 'd'.repeat(64) }
            : assignment
    ));
    const second = await api.runHistoricalPostprocess({ ...options, limit: 'pilot' }, f.deps);
    assert.deepEqual(second.daily.map(item => item.date), [DATE, extraDate]);
    const newRunId = second.processed[0].stagingRunId;
    assert.notEqual(newRunId, oldRunId);
    for (const call of f.aggregateCalls.slice(-2)) {
        assert.ok(call.aggregates[0].inputs.options.stagingRunIds.includes(newRunId));
        assert.ok(!call.aggregates[0].inputs.options.stagingRunIds.includes(oldRunId));
    }
});

test('检查点自校验 SHA 在正式 JSON 更新器的 generation 字段下仍然成立', async t => {
    const f = fixture(t, 'pending'); f.deps.updateLocked = require('../scripts/analysis-engine.js').updateJsonFileLocked;
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpoint));
    assert.doesNotThrow(() => api.validateCheckpoint(checkpoint, CROSSWALK, REGISTRY, RENDERER));
    assert.ok(checkpoint.generation >= 2);
});

test('旧版检查点仍可读取，但加锁的更新器无法重新签名', async t => {
    const f = fixture(t, 'pending');
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    const current = JSON.parse(fs.readFileSync(result.checkpoint));
    const old = structuredClone(current); old.contract = api.LEGACY_CONTRACT; old.version = 1;
    for (const item of Object.values(old.items)) {
        item.taxonomyAssignmentSha256 = item.tagAssignmentSha256; delete item.tagAssignmentSha256;
        item.taxonomyFileSha256 = item.tagAssignmentFileSha256; delete item.tagAssignmentFileSha256;
    }
    const legacy = api.withCheckpointHash(old);
    // 独立旧格式样本；当前生产写入器不会生成它，也不改写已有运行数据。
    fs.writeFileSync(result.checkpoint, JSON.stringify(legacy));
    const originalBytes = fs.readFileSync(result.checkpoint);
    assert.deepEqual(api.validateCheckpoint(legacy, CROSSWALK, REGISTRY, RENDERER), legacy);
    await assert.rejects(api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps), /旧版历史后处理检查点只能读取/);
    assert.deepEqual(fs.readFileSync(result.checkpoint), originalBytes);
    for (const value of [legacy.items[f.paperIds[0]].taxonomyAssignmentSha256, null]) {
        const mixed = structuredClone(legacy); mixed.items[f.paperIds[0]].tagAssignmentSha256 = value;
        assert.throws(() => api.validateCheckpoint(api.withCheckpointHash(mixed), CROSSWALK, REGISTRY, RENDERER), /混用了新旧字段/);
    }
    const badHash = { ...legacy, contract: api.CONTRACT, version: api.VERSION };
    assert.throws(() => api.validateCheckpoint(badHash, CROSSWALK, REGISTRY, RENDERER), /内容哈希/);
});

test('试运行不写盘，只报告已完成保存并核验的调度候选', async t => {
    const f = fixture(t, 'pending'); const result = await api.runHistoricalPostprocess({ apply: false,
        crosswalkId: CROSSWALK, date: null, limit: 'pilot', concurrency: 1 }, f.deps);
    assert.equal(result.status, 'dry-run'); assert.equal(result.completeAvailable, 1); assert.equal(result.selected.length, 1);
    assert.equal(fs.existsSync(f.files.historicalPostprocessSchedulerDir), false);
    assert.equal(f.stageCalls.length, 0); assert.equal(f.aggregateCalls.length, 0);
});

test('试运行绝不把检查点完成但未保存核验的分析列为候选', async t => {
    const f = fixture(t, 'pending'); f.deps.recoverRun = () => ({ storageSealed: true, currentContractComplete: false });
    const result = await api.runHistoricalPostprocess({ apply: false, crosswalkId: CROSSWALK,
        date: null, limit: null, concurrency: 1 }, f.deps);
    assert.equal(result.checkpointComplete, 1); assert.equal(result.completeAvailable, 0);
    assert.equal(result.unsealed, 1); assert.deepEqual(result.selected, []);
});

test('在所有历史论文完成单页暂存之前，该日期一直保持阻塞', async t => {
    const f = fixture(t, 'pending'); const result = await api.runHistoricalPostprocess({ apply: true,
        crosswalkId: CROSSWALK, date: DATE, limit: null, concurrency: 3 }, f.deps);
    assert.equal(result.status, 'partial'); assert.deepEqual(result.daily, [
        { date: DATE, status: 'blocked', rendererImplementationSha256: RENDERER,
            reason: 'not-all-date-papers-staged' }
    ]); assert.equal(f.aggregateCalls.length, 0);
});

test('未保存核验的分析运行记为失败，绝不进入暂存', async t => {
    const f = fixture(t, 'pending'); f.deps.recoverRun = () => ({ storageSealed: true, currentContractComplete: false });
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    assert.equal(result.processed[0].status, 'failed'); assert.equal(f.stageCalls.length, 0);
});

test('受阻的标签分配保存为复核记录，不生成暂存页面', async t => {
    const f = fixture(t, 'pending'); const build = f.deps.buildAssignments;
    f.deps.buildAssignments = options => build(options).map(item => ({ ...item, status: 'blocked',
        blockedReasons: ['primary-task:unknown:#不存在的主任务'] }));
    const result = await api.runHistoricalPostprocess({ apply: true, crosswalkId: CROSSWALK,
        date: DATE, limit: null, concurrency: 1 }, f.deps);
    assert.equal(result.processed[0].status, 'failed'); assert.equal(f.assignmentWrites(), 1);
    assert.equal(f.stageCalls.length, 0); assert.match(result.processed[0].lastError, /标签分配受阻/);
    // 待定分类会明确出现在审查队列里：
    // 它的原因同时跟着检查点条目和运行报告走。
    assert.equal(result.tagReview, 1);
    assert.deepEqual(result.tagReviewQueue, [{ paperId: f.paperIds[0],
        analysisRunId: f.runIds[0], status: 'needs_tag_review',
        blockedReasons: ['primary-task:unknown:#不存在的主任务'] }]);
    assert.equal(result.processed[0].reviewRequired.status, 'needs_tag_review');
    assert.equal(result.processed[0].reviewRequired.code, 'HISTORICAL_TAG_REVIEW_REQUIRED');
    assert.deepEqual(result.processed[0].reviewRequired.blockedReasons, ['primary-task:unknown:#不存在的主任务']);
    assert.match(result.processed[0].lastError, /primary-task:unknown:#不存在的主任务/);
    const checkpoint = JSON.parse(fs.readFileSync(result.checkpoint, 'utf8'));
    assert.equal(checkpoint.items[f.paperIds[0]].reviewRequired.status, 'needs_tag_review');
    assert.equal(checkpoint.items[f.paperIds[0]].reviewRequired.code, 'HISTORICAL_TAG_REVIEW_REQUIRED');
});

test('CLI 校验模式、日期、上限和并发，并透传试运行参数', async () => {
    assert.equal(cli.parseArgs(['--dry-run', '--crosswalk', CROSSWALK, '--concurrency', '3']).concurrency, 3);
    assert.throws(() => cli.parseArgs(['--apply', '--crosswalk', CROSSWALK, '--concurrency', '4']), /Use/);
    const result = await cli.main(['--dry-run', '--crosswalk', CROSSWALK], { run: async options => ({ options }) });
    assert.equal(result.options.apply, false);
});


test('后处理预演保留真实磁盘读取失败，不能报成来源未封存', async t => {
    const f = fixture(t, 'pending');
    const error = Object.assign(new Error('读取分析文件失败'), { code: 'EIO' });
    f.deps.recoverRun = () => { throw error; };
    await assert.rejects(api.runHistoricalPostprocess({apply:false,crosswalkId:CROSSWALK,
        date:DATE,limit:null,concurrency:1},f.deps), failure => failure === error);
    assert.equal(fs.existsSync(f.files.historicalPostprocessSchedulerDir), false);
});


test('后处理预演不能把损坏分析或权限错误当作普通未就绪', async t => {
    for (const code of ['EACCES', 'HISTORICAL_TAG_ASSIGNMENT_INTEGRITY']) {
        const f = fixture(t, 'pending');
        const error = Object.assign(new Error('无法核验已保存分析'), {code});
        f.deps.loadAnalysisRun = () => {throw error;};
        await assert.rejects(api.runHistoricalPostprocess({apply:false,crosswalkId:CROSSWALK,
            date:DATE,limit:null,concurrency:1},f.deps), failure => failure === error);
        assert.equal(fs.existsSync(f.files.historicalPostprocessSchedulerDir),false);
    }
});
test('暂存成功后的完成集合复查遇到EIO须外抛，已保存单篇成果仍保留', async t => {
    const f = fixture(t,'pending'); let reads=0;
    const error=Object.assign(new Error('复查分析时读取失败'),{code:'EIO'});
    f.deps.recoverRun=()=>{if(++reads===3) throw error;return {storageSealed:true,currentContractComplete:true};};
    await assert.rejects(api.runHistoricalPostprocess({apply:true,crosswalkId:CROSSWALK,
        date:DATE,limit:null,concurrency:1},f.deps),failure=>failure===error);
    const filename=api.checkpointPath(f.files.historicalPostprocessSchedulerDir,CROSSWALK,REGISTRY,RENDERER);
    const state=JSON.parse(fs.readFileSync(filename));
    assert.equal(state.items[f.paperIds[0]].status,'staged');
    assert.equal(f.stageCalls.length,1);assert.equal(f.aggregateCalls.length,0);
});

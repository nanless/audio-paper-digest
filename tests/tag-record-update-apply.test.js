'use strict';

// 这些集成测试检查标签记录更新工具的 --apply 写入流程。
// 每个用例都在系统临时目录中构造会议处理、来源、分析和运行记录，
// 包括 state.json 与完成凭证；内存中的记录核验另见 tag-record-update.test.js。
// 两类测试分别检查文件写入和记录规则，避免测试数据构造失败掩盖记录规则的错误。
// 可用 node --test tests/tag-record-update*.test.js 运行这两份测试。
// 临时词表快照仍以文件内容 SHA 命名。这里不写入真实运行目录，
// 也不修改 config/ 下的源文件。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const adapter = require('../scripts/lib/conference-analysis-adapter.js');
const processApi = require('../scripts/lib/conference-process.js');
const engine = require('../scripts/analysis-engine.js');
const contract = require('../scripts/analysis-contract.js');
const utilsApi = require('../scripts/utils.js');
const contextApi = require('../scripts/lib/conference-source-context.js');
const cli = require('../scripts/tag-record-update.js');
const { REGISTRY_FILE, REGISTRY_HISTORY_DIR, ADDITIVE_OLD_SHA, DESTRUCTIVE_OLD_SHA,
    runtime: tagRules, annotationFor, analysisRecord, textSha }
    = require('./helpers/tag-record-update-fixture.js');

const PROCESS_ID = '9dce2993-0000-4000-8000-000000000000';
const PAPER_ID = 'conference:icassp:2026:icassp-arnumber:100';
const EXECUTION_ID = processApi.deterministicUuid(PROCESS_ID, PAPER_ID, 'analysis');
const FIXED_NOW = '2026-09-10T00:00:00.000Z';
const SOURCE_TEXT = '会议 PDF 文字层证据段落，用于弱结构来源封存与逐字重放校验。'.repeat(40);
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function writeFile(filename, bytes, mode = 0o600) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, bytes, { mode });
    fs.chmodSync(filename, mode);
    return filename;
}

function executionIdentity() {
    const analysisConfig = Object.fromEntries(processApi.DEEP_EXECUTION_LIMIT_FIELDS
        .map(field => [field, /Temperature$/.test(field) ? 0.1 : 1000]));
    return processApi.deepExecutionConfigIdentity({
        env: {
            PAPER_ANALYZER_MODEL: 'muse-spark-1.3-contributor',
            PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
            PD_OPENAI_RESPONSES_REASONING_EFFORT: 'low',
            PD_OPENAI_RESPONSES_STREAM: '1'
        },
        analysisConfig,
        secondaryModelConfig: {},
        utilsApi
    });
}

// 在临时目录中按生产读取器要求构造意图、来源、分析和运行记录，
// 再调用 adapter.sealCompletedRun 生成完成记录，供真实写入流程核验。
function buildExecution({ analysisRoot, executionId, record }) {
    const directory = path.join(analysisRoot, executionId);
    const paperId = record.paperId;
    const details = adapter.sourceDetails({
        paperId,
        text: SOURCE_TEXT,
        sourceBinding: { pdfSha256: '1'.repeat(64) },
        structuredArtifacts: { profile: contextApi.WEAK_PROFILE, tables: [], formulas: [], figures: [] },
        tableAvailability: { available: false },
        formulaAvailability: { available: false },
        figureAvailability: { available: false }
    });
    const planAuthorityBinding = {
        contract: 'conference-plan-authority-binding-fixture-v1',
        planSha256: 'a'.repeat(64),
        selectionReceiptSha256: 'b'.repeat(64),
        taxonomyRegistrySha256: 'c'.repeat(64)
    };
    const sourceSnapshotBinding = {
        planAuthority: planAuthorityBinding,
        paperId,
        sourceBinding: { textSha256: sha256(SOURCE_TEXT), pdfSha256: '1'.repeat(64) }
    };
    const sourceSnapshotSha256 = adapter.stableHash(sourceSnapshotBinding);
    const observationBinding = { sourceSnapshotSha256, observationSha256: 'd'.repeat(64) };
    const observationBindingSha256 = adapter.stableHash(observationBinding);
    const sourceBody = {
        contract: adapter.SOURCE_CONTRACT, version: adapter.VERSION, paperId,
        sourceSnapshotSha256, observationBindingSha256, planAuthorityBinding,
        sourceSnapshotBinding, observationBinding, sourceDetails: details
    };
    const source = { ...sourceBody, recordSha256: adapter.stableHash(sourceBody) };
    const sourceBytes = jsonBytes(source);
    const analysisBytes = jsonBytes(record);
    const intentBody = {
        contract: adapter.PREPARE_INTENT_CONTRACT, version: adapter.VERSION,
        executionId, paperId, sourceSnapshotSha256, observationBindingSha256,
        planAuthorityBindingSha256: adapter.stableHash(planAuthorityBinding),
        sourceRecordSha256: source.recordSha256,
        sourceFileSha256: sha256(sourceBytes),
        initialAnalysisFileSha256: sha256(analysisBytes)
    };
    const intent = { ...intentBody, intentSha256: adapter.stableHash(intentBody) };
    const intentBytes = jsonBytes(intent);
    const runBody = {
        contract: adapter.RUN_CONTRACT, version: adapter.VERSION, executionId, paperId,
        conference: { id: 'icassp-2026', year: 2026 },
        createdAt: '2026-09-07T00:00:00.000Z',
        status: 'source_ready',
        sourceSnapshotSha256, observationBindingSha256,
        planAuthorityBindingSha256: adapter.stableHash(planAuthorityBinding),
        prepareIntentSha256: intent.intentSha256,
        prepareIntentFileSha256: sha256(intentBytes),
        sourceRecordSha256: source.recordSha256,
        sourceFileSha256: sha256(sourceBytes),
        capabilities: details.conferenceCapabilities
    };
    const run = { ...runBody, runSha256: adapter.stableHash(runBody) };
    writeFile(path.join(directory, 'intent.json'), intentBytes);
    writeFile(path.join(directory, 'source.json'), sourceBytes);
    writeFile(path.join(directory, 'analysis.json'), analysisBytes);
    writeFile(path.join(directory, 'run.json'), jsonBytes(run));
    adapter.sealCompletedRun(adapter.loadConferenceAnalysis({ analysisRoot, executionId }));
    const sealed = adapter.loadConferenceAnalysis({ analysisRoot, executionId });
    return { directory, sourceSnapshotSha256, observationBindingSha256,
        analysisSha256: sealed.analysisFileSha256, run: sealed.run };
}

function fixture(t, options = {}) {
    const oldRegistrySha256 = options.registrySha256 ?? ADDITIVE_OLD_SHA;
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tag-record-update-apply-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const files = {
        conferenceProcessDir: path.join(root, 'processes'),
        conferenceAnalysisDir: path.join(root, 'analysis'),
        tagRecordUpdateReportDir: path.join(root, 'reports')
    };
    for (const directory of Object.values(files)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

    // 假 registry 快照：逐字节复制到 tmp，文件名仍必须等于内容字节 SHA。
    const historyDir = path.join(root, 'registry-history');
    fs.mkdirSync(historyDir, { mode: 0o700 });
    for (const sha of [ADDITIVE_OLD_SHA, DESTRUCTIVE_OLD_SHA]) {
        const bytes = fs.readFileSync(path.join(REGISTRY_HISTORY_DIR, `${sha}.json`));
        assert.equal(sha256(bytes), sha, '快照文件名必须等于内容字节 SHA');
        writeFile(path.join(historyDir, `${sha}.json`), bytes, 0o600);
    }

    const annotation = options.annotation === false ? undefined : annotationFor(oldRegistrySha256);
    const record = analysisRecord({
        registrySha256: oldRegistrySha256,
        projectionSha256: 'e'.repeat(64),
        annotation,
        paperId: PAPER_ID,
        executionId: EXECUTION_ID,
        completedAt: '2026-09-07T00:10:00.000Z'
    });
    const execution = buildExecution({ analysisRoot: files.conferenceAnalysisDir,
        executionId: EXECUTION_ID, record });

    const processDir = path.join(files.conferenceProcessDir, PROCESS_ID);
    fs.mkdirSync(processDir, { recursive: true, mode: 0o700 });
    const sourceProof = {
        sourceSnapshotSha256: execution.sourceSnapshotSha256,
        observationBindingSha256: execution.observationBindingSha256,
        sealedAt: '2026-09-07T00:00:00.000Z'
    };
    const analysisProof = {
        analysisSha256: execution.analysisSha256,
        completionReceiptSha256: execution.run.completionReceipt.receiptSha256,
        sourceSnapshotSha256: execution.sourceSnapshotSha256
    };
    const pageProof = {
        manifestSha256: '6'.repeat(64),
        contentSha256: '7'.repeat(64),
        pagePath: 'content/posts/icassp-arnumber-100.md'
    };
    const authority = {
        conferenceId: 'icassp-2026',
        catalogName: 'catalog.json',
        reportName: 'report.json',
        filterId: '11111111-1111-4111-8111-111111111111',
        catalogSha256: '1'.repeat(64),
        reportSha256: '2'.repeat(64),
        filterPolicySha256: '3'.repeat(64),
        selectionReceiptSha256: '4'.repeat(64),
        selectedMemberSetSha256: '5'.repeat(64),
        tagCatalogVersion: tagRules().registryVersion,
        tagCatalogSha256: tagRules().registrySha256,
        implementationSha256: processApi.implementationSha256(),
        deepExecutionConfig: executionIdentity()
    };
    const aggregate = {
        aggregateId: '9'.repeat(32),
        manifestSha256: 'a'.repeat(64),
        markdownSha256: 'b'.repeat(64),
        pagePath: 'content/posts/index.md'
    };
    const receiptBody = {
        contract: processApi.COMPLETION_CONTRACT, version: processApi.VERSION,
        processId: PROCESS_ID, authority, planReceiptSha256: 'c'.repeat(64),
        items: [{ paperId: PAPER_ID, analysisRunId: EXECUTION_ID, sourceProof, analysisProof, pageProof }],
        aggregate
    };
    const receipt = { ...receiptBody, receiptSha256: processApi.stableHash(receiptBody) };
    const state = {
        contract: processApi.CONTRACT, version: processApi.VERSION, generation: 1,
        processId: PROCESS_ID, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:30:00.000Z',
        authority, status: 'complete',
        items: {
            [PAPER_ID]: {
                paperId: PAPER_ID, sourceIdentity: 'icassp-arnumber:100',
                analysisRunId: EXECUTION_ID, status: 'complete',
                sourceProof, analysisProof, pageProof,
                attempts: 1, lastError: null, updatedAt: '2026-09-07T00:30:00.000Z'
            }
        },
        aggregate,
        completionReceiptSha256: receipt.receiptSha256
    };
    state.stateSha256 = processApi.stateDigest(state);
    // 先检查测试数据：待保存的检查点必须满足整批会议处理完成的条件。
    processApi.assertState(state);
    processApi.validateCompletionReceipt(state, receipt);

    const stateFile = path.join(processDir, 'state.json');
    const receiptFile = path.join(processDir, 'completion-receipt.json');
    writeFile(stateFile, jsonBytes(state));
    writeFile(receiptFile, jsonBytes(receipt));

    return {
        root, files, historyDir, processDir, stateFile, receiptFile, state,
        originalReceiptBytes: jsonBytes(receipt),
        processId: PROCESS_ID, paperId: PAPER_ID, executionId: EXECUTION_ID,
        analysisFile: path.join(execution.directory, 'analysis.json'),
        runFile: path.join(execution.directory, 'run.json'),
        executionDir: execution.directory,
        oldBindingSha256: record.papers[0].analysisManifest.stages.taxonomySeal.bindingSha256
    };
}

function runtimeFor(fx) {
    return {
        files: fx.files,
        tagRules: tagRules(),
        snapshotOptions: { historyDir: fx.historyDir },
        now: () => FIXED_NOW
    };
}

async function runMain(argv, runtimeOverrides) {
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
        return { report: await cli.main(argv, runtimeOverrides), stdout: lines };
    } finally {
        console.log = originalLog;
    }
}

function planOf(fx) {
    const state = cli.readProcessJson(fx.stateFile);
    return { state, plan: cli.planProcessReseal({
        state,
        adapter,
        analysisRoot: fx.files.conferenceAnalysisDir,
        runtime: tagRules(),
        mode: 'reproject',
        // 这些默认测试数据用于验证更新能成功写入，因此明确确认允许这次破坏性变更。
        // 测试缺少确认时会被拒绝的情况时，直接调用命令入口，不通过这个辅助函数提供确认。
        acknowledgeDestructive: true,
        snapshotOptions: { historyDir: fx.historyDir }
    }) };
}

function applyOf(fx, plan, plannedStateSha256) {
    return cli.applyReseal({
        processDir: fx.processDir,
        stateFile: fx.stateFile,
        plannedStateSha256,
        writes: plan.writes,
        plans: plan.plans,
        runtime: tagRules(),
        adapter,
        engine,
        processApi,
        analysisRoot: fx.files.conferenceAnalysisDir,
        now: () => FIXED_NOW
    });
}

function coreSnapshot(fx) {
    const read = filename => (fs.existsSync(filename) ? fs.readFileSync(filename).toString('base64') : null);
    const entries = directory => fs.readdirSync(directory)
        .filter(name => !name.startsWith('.operation')).sort();
    return {
        state: read(fx.stateFile),
        analysis: read(fx.analysisFile),
        run: read(fx.runFile),
        receipt: read(fx.receiptFile),
        processEntries: entries(fx.processDir),
        executionEntries: entries(fx.executionDir)
    };
}

function currentStage(fx) {
    const analysis = JSON.parse(fs.readFileSync(fx.analysisFile, 'utf8'));
    return { analysis, paper: analysis.papers[0],
        stage: require('../scripts/lib/tag-stage-record.js').readTagStageRecord(
            analysis.papers[0].analysisManifest, analysis.papers[0].analysisStageCheckpoints).stage };
}

test('实际更新会保存分析、运行和进程记录，并归档原完成凭证', async t => {
    const fx = fixture(t);
    const runtime = runtimeFor(fx);
    assert.equal(fs.existsSync(fx.receiptFile), true);

    const { report } = await runMain(['--from', fx.processId, '--apply',
        '--acknowledge-destructive'], runtime);

    assert.equal(report.contract, 'paper-tag-record-update-report-v2');
    assert.equal(report.version, 2);
    assert.equal(report.command, 'update-records');
    assert.equal(report.updateMode, 'reproject');
    assert.equal(Object.hasOwn(report, 'resealMode'), false);
    assert.equal(report.mode, 'apply');
    assert.equal(report.written, true);
    assert.equal(report.summary.assigned, 1);
    assert.equal(report.summary.blocked, 0);
    assert.equal(report.summary.outcomes.resealed, 1);
    assert.equal(report.plannedWrites, 1);
    assert.equal(report.implementationDrift, false);
    assert.equal(report.writeResult.demoted, true);
    assert.equal(report.writeResult.executed.length, 1);
    assert.equal(report.writeResult.stateChanged, true);
    // 注意：main 用降级后的 running 状态调用 nextStepFor，因此 nextStep 恒为
    // null（既有行为，不在本任务改动范围内）。

    // analysis.json 中的标签阶段记录更新到当前词表，并重新核对十三字段内容哈希。
    const current = tagRules();
    const { paper, stage } = currentStage(fx);
    assert.equal(stage.registrySha256, current.registrySha256);
    assert.equal(stage.projectionSha256, current.projectionSha256);
    assert.equal(stage.registryVersion, current.registryVersion);
    assert.equal(stage.registryUpgradeFrom.changeLevel, 'destructive');
    assert.equal(stage.registryUpgradeFrom.destructiveAcknowledgement.acknowledged, true);
    assert.equal(stage.registryUpgradeFrom.fromRegistrySha256, ADDITIVE_OLD_SHA);
    assert.notEqual(stage.bindingSha256, fx.oldBindingSha256);
    assert.equal(stage.bindingSha256, contract.manualSha256({
        registryVersion: stage.registryVersion,
        registrySha256: stage.registrySha256,
        projectionContract: stage.projectionContract,
        projectionSha256: stage.projectionSha256,
        selectionContract: stage.selectionContract,
        inputAnalysisSha256: stage.inputAnalysisSha256,
        outputAnalysisSha256: stage.outputAnalysisSha256,
        inputProtectedProjectionSha256: stage.inputProtectedProjectionSha256,
        outputProtectedProjectionSha256: stage.outputProtectedProjectionSha256,
        tagSectionAndPrimaryTagsSha256: stage.tagSectionAndPrimaryTagsSha256,
        primaryTaskId: stage.primaryTaskId,
        primaryMethodId: stage.primaryMethodId,
        conceptIds: stage.conceptIds
    }));
    assert.strictEqual(contract.validateTagStageProof(paper, {
        parsed: utilsApi.parseAnalysis(paper.analysis, { tagRules: current }),
        tagRules: current
    }), null);
    assert.equal(paper.parsed.tagValidation.registrySha256, current.registrySha256);

    // run.json 及其完成凭证更新为对应新的分析文件字节，随后由真实读取器重新核验。
    const analysisBytes = fs.readFileSync(fx.analysisFile);
    const run = JSON.parse(fs.readFileSync(fx.runFile, 'utf8'));
    assert.equal(run.status, 'complete');
    assert.equal(run.analysisSha256, sha256(analysisBytes));
    const { runSha256: _runSha256, ...runBody } = run;
    assert.equal(run.runSha256, adapter.stableHash(runBody));
    const { receiptSha256: _receiptSha256, ...receiptBody } = run.completionReceipt;
    assert.equal(run.completionReceipt.receiptSha256, adapter.stableHash(receiptBody));
    assert.equal(run.completionReceipt.analysisSha256, sha256(analysisBytes));
    assert.equal(report.writeResult.executed[0].analysisSha256, sha256(analysisBytes));
    const verified = adapter.loadConferenceAnalysis({
        analysisRoot: fx.files.conferenceAnalysisDir, executionId: fx.executionId });
    assert.equal(verified.analysisFileSha256, sha256(analysisBytes));

    // 进程状态退回 running，清空汇总及完成凭证字段，并将 generation 增加一。
    const state = processApi.assertState(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')));
    assert.equal(state.status, 'running');
    assert.equal(state.aggregate, null);
    assert.equal(state.completionReceiptSha256, null);
    assert.equal(state.generation, fx.state.generation + 1);
    assert.equal(state.items[fx.paperId].analysisProof.analysisSha256, sha256(analysisBytes));
    assert.equal(state.items[fx.paperId].analysisProof.completionReceiptSha256,
        run.completionReceipt.receiptSha256);
    assert.equal(fs.statSync(fx.stateFile).mode & 0o777, 0o600);
    assert.equal(report.writeResult.stateSha256, state.stateSha256);

    // 旧 completion-receipt 被归档：新文件名、字节逐字保留、原文件消失。
    assert.equal(fs.existsSync(fx.receiptFile), false);
    const archived = fs.readdirSync(fx.processDir).filter(name => /^completion-receipt-.+\.json$/.test(name));
    assert.equal(archived.length, 1);
    assert.notEqual(archived[0], 'completion-receipt.json');
    assert.equal(report.archivedCompletionReceipt, archived[0]);
    const archivedBytes = fs.readFileSync(path.join(fx.processDir, archived[0]));
    assert.equal(archivedBytes.equals(fx.originalReceiptBytes), true,
        '归档文件必须逐字节保留旧 completion receipt');
    assert.equal(sha256(archivedBytes), sha256(fx.originalReceiptBytes));
});

test('进程检查点发生变化时，更新会停止，并保留原分析文件', async t => {
    const fx = fixture(t);
    const { state, plan } = planOf(fx);
    assert.equal(plan.writes.length, 1);
    const before = coreSnapshot(fx);

    // 写入前把 state 改成“自洽但与规划不同”的 checkpoint（CAS 必须拦下）。
    const tampered = { ...state, updatedAt: '2026-09-11T00:00:00.000Z' };
    tampered.stateSha256 = processApi.stateDigest(tampered);
    writeFile(fx.stateFile, jsonBytes(tampered));
    const tamperedBytes = fs.readFileSync(fx.stateFile);

    await assert.rejects(() => applyOf(fx, plan, state.stateSha256),
        /进程检查点在标签记录更新期间发生变化/);

    const after = coreSnapshot(fx);
    assert.deepEqual(after.analysis, before.analysis, 'analysis 不得被改写');
    assert.deepEqual(after.run, before.run, 'run 不得被改写');
    assert.deepEqual(after.receipt, before.receipt, 'completion receipt 不得被归档');
    assert.equal(fs.readFileSync(fx.stateFile).equals(tamperedBytes), true);
    assert.equal(processApi.assertState(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'))).status,
        'complete', '进程仍保持篡改后的完整状态，没有半个封口');
});

test('分析文件内容发生变化时，更新会在写入前停止', async t => {
    const fx = fixture(t);
    const { plan } = planOf(fx);
    assert.equal(plan.writes.length, 1);
    const before = coreSnapshot(fx);

    // 修改分析文件后，同时更新运行记录及其完成凭证，使对应关系仍然成立。
    // 写入检查仍须发现当前文件 SHA 与规划时不同，并拒绝覆盖。
    const record = JSON.parse(fs.readFileSync(fx.analysisFile, 'utf8'));
    const tamperedBytes = Buffer.from(`${JSON.stringify(record, null, 4)}\n`);
    writeFile(fx.analysisFile, tamperedBytes);
    const tamperedSha256 = sha256(tamperedBytes);
    const run = JSON.parse(fs.readFileSync(fx.runFile, 'utf8'));
    const receiptBody = {
        contract: 'conference-analysis-completion-receipt-v1',
        version: adapter.VERSION,
        executionId: fx.executionId,
        paperId: fx.paperId,
        sourceSnapshotSha256: run.sourceSnapshotSha256,
        analysisSha256: tamperedSha256,
        completedAt: record.completedAt
    };
    const { runSha256: _runSha256, ...runBody } = run;
    const nextRunBody = {
        ...runBody,
        analysisSha256: tamperedSha256,
        completionReceipt: { ...receiptBody, receiptSha256: adapter.stableHash(receiptBody) }
    };
    writeFile(fx.runFile, jsonBytes({ ...nextRunBody, runSha256: adapter.stableHash(nextRunBody) }));
    const tamperedRunBytes = fs.readFileSync(fx.runFile);
    // 篡改后执行链必须仍然自洽，否则测的就不是 CAS 而是解析失败。
    assert.equal(adapter.loadConferenceAnalysis({
        analysisRoot: fx.files.conferenceAnalysisDir, executionId: fx.executionId
    }).analysisFileSha256, tamperedSha256);

    await assert.rejects(() => applyOf(fx, plan, fx.state.stateSha256),
        /分析文件内容发生变化/);

    const after = coreSnapshot(fx);
    assert.equal(fs.readFileSync(fx.analysisFile).equals(tamperedBytes), true,
        '被篡改的 analysis 原样保留，绝不能被重封');
    assert.equal(fs.readFileSync(fx.runFile).equals(tamperedRunBytes), true, 'run 不得被改写');
    assert.deepEqual(after.state, before.state, 'state 不得被改写');
    assert.equal(after.receipt, before.receipt, 'completion receipt 不得被归档');
    assert.deepEqual(after.executionEntries, before.executionEntries);
});

test('有论文无法更新时，本次更新以退出码 1 结束', async t => {
    const fx = fixture(t, { registrySha256: DESTRUCTIVE_OLD_SHA, annotation: false });
    const runtime = runtimeFor(fx);
    const before = coreSnapshot(fx);
    const previousExitCode = process.exitCode;
    try {
        const { report } = await runMain(['--from', fx.processId, '--apply'], runtime);
        assert.equal(report.contract, 'paper-tag-record-update-report-v2');
        assert.equal(report.version, 2);
        assert.equal(report.command, 'update-records');
        assert.equal(report.updateMode, 'reproject');
        assert.equal(Object.hasOwn(report, 'resealMode'), false);
        assert.equal(process.exitCode, 1, '存在 blocked 论文时必须以退出码 1 结束');
        assert.equal(report.written, false);
        assert.equal(report.plannedWrites, 0);
        assert.equal(report.summary.blocked, 1);
        assert.equal(report.summary.assigned, 0);
        assert.equal(report.items[0].status, 'blocked');
        assert.equal(report.items[0].outcome, 'destructive-change');
        assert.equal(report.items[0].needsHuman, true);
        assert.equal(report.writeResult.executed.length, 0);
        assert.equal(report.writeResult.stateChanged, false);
        assert.equal(report.writeResult.demoted, false);
        assert.equal(report.archivedCompletionReceipt, undefined);
        assert.deepEqual(coreSnapshot(fx), before, 'blocked 时一个字节都不写');
    } finally {
        process.exitCode = previousExitCode;
    }
});

test('再次更新已使用当前词表的记录时，不写入文件', async t => {
    const fx = fixture(t);
    const runtime = runtimeFor(fx);

    const first = await runMain(['--from', fx.processId, '--apply',
        '--acknowledge-destructive'], runtime);
    assert.equal(first.report.written, true);
    assert.equal(first.report.writeResult.demoted, true);
    const afterFirst = coreSnapshot(fx);
    const generationAfterFirst = processApi.assertState(
        JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'))).generation;

    const second = await runMain(['--from', fx.processId, '--apply',
        '--acknowledge-destructive'], runtime);
    assert.equal(second.report.items[0].status, 'assigned');
    assert.equal(second.report.items[0].outcome, 'already-current');
    assert.equal(second.report.summary.assigned, 1);
    assert.equal(second.report.summary.blocked, 0);
    assert.equal(second.report.plannedWrites, 0);
    assert.equal(second.report.written, false);
    assert.equal(second.report.writeResult.executed.length, 0);
    assert.equal(second.report.writeResult.stateChanged, false);
    assert.equal(second.report.writeResult.demoted, false);
    assert.equal(second.report.archivedCompletionReceipt, undefined);
    assert.equal(second.report.nextStep, null);
    assert.deepEqual(coreSnapshot(fx), afterFirst, '幂等重跑不得改动任何字节');
    assert.equal(processApi.assertState(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'))).generation,
        generationAfterFirst, 'generation 不再递增');
});

function archiveFiles(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'taxonomy-archive-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'tag-catalog.json');
    const bytes = fs.readFileSync(REGISTRY_FILE);
    writeFile(source, bytes);
    const historyDir = path.join(root, 'tag-catalog-history');
    return { root, source, bytes, historyDir,
        files: { tagCatalogFile: source, tagCatalogHistoryDir: historyDir } };
}

test('--archive-snapshot 按内容哈希归档当前词表，重复执行不产生额外快照', async t => {
    const fx = archiveFiles(t);
    assert.equal(fs.existsSync(fx.historyDir), false);

    const first = await runMain(['--archive-snapshot'], { files: fx.files });
    const sha = sha256(fx.bytes);
    assert.equal(first.report.command, 'archive-snapshot');
    assert.equal(first.report.status, 'archived');
    assert.equal(first.report.written, true);
    assert.equal(first.report.registrySha256, sha);
    const target = path.join(fx.historyDir, `${sha}.json`);
    assert.equal(first.report.target, target);
    assert.equal(fs.readdirSync(fx.historyDir).length, 1);
    assert.equal(fs.readFileSync(target).equals(fx.bytes), true, '必须逐字节复制');
    assert.equal(sha256(fs.readFileSync(target)), sha, '文件名必须等于内容字节 SHA');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(fx.source).equals(fx.bytes), true, '源词表一字节都不能动');

    const second = await runMain(['--archive-snapshot'], { files: fx.files });
    assert.equal(second.report.status, 'already-archived');
    assert.equal(second.report.idempotent, true);
    assert.equal(second.report.written, false);
    assert.equal(fs.readdirSync(fx.historyDir).length, 1, '幂等重跑不新增文件');
    assert.equal(fs.readFileSync(target).equals(fx.bytes), true);
});

test('已有归档内容的哈希与文件名不符时，--archive-snapshot 拒绝继续', async t => {
    const fx = archiveFiles(t);
    await runMain(['--archive-snapshot'], { files: fx.files });
    const sha = sha256(fx.bytes);
    const target = path.join(fx.historyDir, `${sha}.json`);
    const tampered = Buffer.from('{"registry": "tampered"}\n');
    writeFile(target, tampered);

    // 目标文件名由原词表的内容 SHA 决定。已有文件的实际内容与该 SHA 不符时，
    // 归档操作必须拒绝继续，不能覆盖文件或给错误内容改名。
    assert.equal(sha256(fs.readFileSync(target)) !== sha, true, '被篡改文件的字节 SHA 已不等于文件名');
    await assert.rejects(() => runMain(['--archive-snapshot'], { files: fx.files }),
        /拒绝覆盖|不一致/);
    assert.equal(fs.readdirSync(fx.historyDir).length, 1);
    assert.equal(fs.readFileSync(target).equals(tampered), true, '篡改的归档不会被覆盖');
    assert.equal(fs.readFileSync(fx.source).equals(fx.bytes), true, '源词表一字节都不能动');

    // 清掉被篡改的快照后必须能重新归档（拒绝是无副作用的）。
    fs.unlinkSync(target);
    const third = await runMain(['--archive-snapshot'], { files: fx.files });
    assert.equal(third.report.status, 'archived');
    assert.equal(fs.readFileSync(target).equals(fx.bytes), true);
});

// 在系统临时目录中检查明确确认参数对真实文件写入流程的影响。
test('提供 --acknowledge-destructive 后，进程可以更新允许确认的破坏性变更', async t => {
    const fx = fixture(t, { registrySha256: DESTRUCTIVE_OLD_SHA, annotation: false });
    const runtime = runtimeFor(fx);
    const before = coreSnapshot(fx);
    const previousExitCode = process.exitCode;
    try {
        // 未提供确认参数时，工具返回 blocked、设置退出码 1，且不写入文件。
        const blocked = await runMain(['--from', fx.processId], runtime);
        assert.equal(blocked.report.items[0].status, 'blocked');
        assert.equal(blocked.report.items[0].outcome, 'destructive-change');
        assert.equal(blocked.report.items[0].needsHuman, true);
        assert.equal(blocked.report.written, false);
        assert.equal(blocked.report.destructiveAcknowledgement, undefined);
        assert.equal(process.exitCode, 1);
        assert.deepEqual(coreSnapshot(fx), before, 'blocked 时一个字节都不写');
        process.exitCode = previousExitCode;

        // 提供确认参数但未指定 --apply 时，只计算更新结果和确认说明；--report 另存报告，原输入保持。
        const planned = await runMain(['--from', fx.processId, '--acknowledge-destructive',
            '--acknowledge-note', '人工确认：仅删别名，conceptId 影响 none',
            '--report', 'planned.json'], runtime);
        assert.equal(planned.report.contract, 'paper-tag-record-update-report-v2');
        assert.equal(planned.report.version, 2);
        assert.equal(planned.report.command, 'update-records');
        assert.equal(planned.report.updateMode, 'reproject');
        assert.equal(Object.hasOwn(planned.report, 'resealMode'), false);
        assert.equal(planned.report.items[0].status, 'assigned');
        assert.equal(planned.report.items[0].outcome, 'resealed');
        assert.equal(planned.report.items[0].changeLevel, 'destructive');
        assert.equal(planned.report.items[0].needsHuman, false);
        assert.equal(planned.report.items[0].destructiveAcknowledgement.acknowledged, true);
        assert.equal(planned.report.items[0].destructiveAcknowledgement.conceptIdImpact, 'none');
        assert.equal(planned.report.plannedWrites, 1);
        assert.equal(planned.report.written, false);
        assert.equal(planned.report.destructiveAcknowledgement.requested, true);
        assert.equal(planned.report.destructiveAcknowledgement.note,
            '人工确认：仅删别名，conceptId 影响 none');
        assert.equal(process.exitCode, previousExitCode, '无 blocked 论文时不设失败退出码');
        assert.deepEqual(coreSnapshot(fx), before, 'dry-run 不改分析、运行或进程字节');
        const reportFile = path.join(fx.files.tagRecordUpdateReportDir, 'planned.json');
        assert.equal(planned.report.reportFile, reportFile);
        const reportBytes = fs.readFileSync(reportFile);
        const { reportFile: _reportFile, ...savedReport } = planned.report;
        assert.deepEqual(JSON.parse(reportBytes), savedReport);
        assert.equal(fs.statSync(reportFile).mode & 0o777, 0o600);
        assert.equal(fs.statSync(fx.files.tagRecordUpdateReportDir).mode & 0o777, 0o700);
        await assert.rejects(() => runMain(['--from', fx.processId, '--acknowledge-destructive',
            '--report', 'planned.json'], runtime), /报告文件已存在，拒绝覆盖/);
        assert.deepEqual(fs.readFileSync(reportFile), reportBytes);
        assert.deepEqual(coreSnapshot(fx), before, '同名报告拒绝覆盖时也不改原输入');

        // 指定 --apply 后，先核对规划时记录的 SHA，再更新分析、运行及进程文件；进程退回 running。
        const applied = await runMain(['--from', fx.processId, '--apply',
            '--acknowledge-destructive'], runtime);
        assert.equal(applied.report.written, true);
        assert.equal(applied.report.summary.blocked, 0);
        assert.equal(applied.report.writeResult.executed.length, 1);
        assert.equal(applied.report.writeResult.demoted, true);

        const current = tagRules();
        const { paper, stage } = currentStage(fx);
        assert.equal(stage.registrySha256, current.registrySha256);
        assert.equal(stage.registryUpgradeFrom.changeLevel, 'destructive');
        assert.equal(stage.registryUpgradeFrom.fromRegistrySha256, DESTRUCTIVE_OLD_SHA);
        assert.equal(stage.registryUpgradeFrom.destructiveAcknowledgement.acknowledged, true);
        assert.equal(stage.registryUpgradeFrom.destructiveAcknowledgement.conceptIdImpact, 'none');
        assert.match(stage.registryUpgradeFrom.destructiveAcknowledgement.note,
            /^已明确确认本次词表更新中的破坏性变更：[a-f0-9]{64} → [a-f0-9]{64}；所选概念 ID 保持不变。$/);
        // 写入后的标签阶段记录必须再次通过 Node 的内容及对应关系核验。
        assert.strictEqual(contract.validateTagStageProof(paper, {
            parsed: utilsApi.parseAnalysis(paper.analysis, { tagRules: current }),
            tagRules: current
        }), null);
        const state = processApi.assertState(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')));
        assert.equal(state.status, 'running');
        assert.equal(state.generation, fx.state.generation + 1);
        assert.equal(fs.existsSync(fx.receiptFile), false, '旧 completion receipt 已归档');
    } finally {
        process.exitCode = previousExitCode;
    }
});

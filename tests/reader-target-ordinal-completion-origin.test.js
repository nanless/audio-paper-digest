'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
// 2026-11-09 日更批次 2611.07361v1 在 sealCompletion() 因
// "normal in-memory completion origin missing" 以运行级错误中止整批。
// 根因：最后一笔被接受的修复是原子表格追加（非序号补丁），ordinalCapability
// 为空，结果仍带着更早的付费序号链却没有 origin。本测试用该篇真实保存稿、
// 封存四源与 request/response/compilation/seal 记录复现并锁定四类路径：
//   ① 终态链（origin 存在、快照与数组一致）能正常 seal；
//   ② 快照后数组被追加必须可判定拒绝，而不是误杀/整批中止；
//   ③ 有 compilations 无 origin 必须给出内容级可判定错误；
//   ④ 保存候选恢复路径只在链仍派生当前草稿时挂 origin。
// 真实材料缺失时（干净检出）跳过，纯逻辑用例始终执行。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stableSha = value => {
    const sorted = item => Array.isArray(item) ? item.map(sorted)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])]))
            : item;
    return sha(JSON.stringify(sorted(value)));
};
const RUN_ID = '3e4ef3f4-1c7a-491b-92d3-e17e98619c8f';
const PAPER_ID = '2611.07361v1';
const REAL_ROOT = path.join(ROOT, 'data/runtime/daily-fresh-source-runs');
const REAL_RUN = path.join(REAL_ROOT, RUN_ID);
const REAL_ATTEMPTS = path.join(REAL_RUN, 'reader-attempts');
const REAL_CANDIDATE = path.join(REAL_ATTEMPTS, 'ef4e4ef23ad439975487596be2f890378cb79333148765b3ca34e9fad8adf956.json');
const ordinal = require('../scripts/lib/reader-target-ordinal-patch');

test('superseded ordinal chain history is recorded without any completion marker', () => {
    const stage = { status: 'complete', articleSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64) };
    const records = [{
        contract: ordinal.COMPILATION_CONTRACT, identity: { paperId: PAPER_ID },
        requestId: '5ec2344f-e3e1-4f7c-8ab2-aa374781cc1c',
        pins: { requestSha256: '1'.repeat(64), responseSha256: '2'.repeat(64),
            compilationSha256: '3'.repeat(64), sealSha256: '4'.repeat(64) }
    }];
    assert.equal(ordinal.recordSupersededOrdinalChain(stage, records), true);
    assert.equal(stage.ordinalPatchHistory.reason, ordinal.SUPERSEDED_ORDINAL_CHAIN_REASON);
    assert.deepEqual(stage.ordinalPatchHistory.compilations, records);
    assert.equal(stage.ordinalPatchHistory.previousCompletionProof, null);
    assert.equal(stage.ordinalPatchContract, undefined);
    assert.equal(stage.ordinalPatchCompilations, undefined);
    assert.equal(stage.ordinalCompletionProof, undefined);
    assert.equal(ordinal.recordSupersededOrdinalChain(stage, []), false);
    assert.equal(ordinal.recordSupersededOrdinalChain(null, records), false);
});

test('a result with compilations but no completion origin is a determinate content failure', () => {
    const records = [{ contract: ordinal.COMPILATION_CONTRACT, requestId: '5ec2344f-e3e1-4f7c-8ab2-aa374781cc1c' }];
    const paper = { arxivId: PAPER_ID, analysisManifest: { stages: {} } };
    assert.throws(() => ordinal.sealCompletion(paper, { article: 'x', plan: {}, ordinalPatchCompilations: records }), error => {
        // 可判定：稳定错误码 + 内容级（不带 scope=run），论文按普通失败继续，不中止整批。
        assert.equal(error.code, 'READER_ORDINAL_ORIGIN_MISSING');
        assert.equal(error.scope, undefined);
        assert.equal(error.retryable, undefined);
        return /normal in-memory completion origin missing/.test(error.message);
    });
});

function realMaterialsAvailable() {
    if (!fs.existsSync(REAL_CANDIDATE) || !fs.existsSync(path.join(REAL_RUN, 'run.json'))) return false;
    const candidate = JSON.parse(fs.readFileSync(REAL_CANDIDATE, 'utf8'));
    const record = candidate.payload?.ordinalPatchCompilations?.[0];
    if (!record) return false;
    const diagnostics = path.join(REAL_ATTEMPTS, 'request-diagnostics');
    for (const suffix of ['.request.json', '.response.json', '.ordinal-compiled.json', '.ordinal-seal.json',
        '.ordinal-parent.json', '.ordinal-input-1.json']) {
        if (!fs.existsSync(path.join(diagnostics, record.requestId + suffix))) return false;
    }
    const seal = JSON.parse(fs.readFileSync(path.join(diagnostics, record.requestId + '.ordinal-seal.json'), 'utf8'));
    const usage = require('../scripts/config').FILES.llmUsageDir;
    return Array.isArray(seal.usageRecords) && seal.usageRecords.every(ref =>
        path.dirname(path.resolve(ref.file)) === path.resolve(usage) && fs.existsSync(ref.file));
}

test('2026-11-09 saved ordinal candidate: non-terminal chain is refused, terminal chain seals', {
    skip: !realMaterialsAvailable() && '2026-11-09 real saved candidate/source/diagnostics are not present'
}, (t) => {
    const testApi = require('node:test');
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinal-completion-origin-')));
    const Config = require('../scripts/config');
    const fresh = require('../scripts/lib/fresh-analysis-context');
    const engine = require('../scripts/analysis-engine');
    const repair = require('../scripts/lib/reader-repair');
    const deep = require('../scripts/deep-analyzer');
    const originalRoots = { dailyFreshSourceRunsDir: Config.FILES.dailyFreshSourceRunsDir, llmUsageDir: Config.FILES.llmUsageDir };
    t.after(() => {
        Config.FILES.dailyFreshSourceRunsDir = originalRoots.dailyFreshSourceRunsDir;
        Config.FILES.llmUsageDir = originalRoots.llmUsageDir;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    // 生产数据只读：把该篇封存运行复制到临时根，完成索引/候选改写都落在临时目录。
    const runDir = path.join(workspace, RUN_ID);
    const attempts = path.join(runDir, 'reader-attempts');
    const diagnostics = path.join(attempts, 'request-diagnostics');
    fs.mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(REAL_RUN, 'run.json'), path.join(runDir, 'run.json'));
    fs.cpSync(path.join(REAL_RUN, 'sources'), path.join(runDir, 'sources'), { recursive: true });
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    const candidate = JSON.parse(fs.readFileSync(REAL_CANDIDATE, 'utf8'));
    const record = candidate.payload.ordinalPatchCompilations[0];
    for (const name of fs.readdirSync(path.join(REAL_ATTEMPTS, 'request-diagnostics'))) {
        if (name.startsWith(record.requestId)) {
            fs.cpSync(path.join(REAL_ATTEMPTS, 'request-diagnostics', name), path.join(diagnostics, name));
        }
    }
    // seal 记录里的 witness 绝对路径随材料一起搬迁，字节 pin 同步重算；真实付费
    // 请求、响应、编译记录、witness 内容与费用账本本身不改写。
    const sealFile = path.join(diagnostics, record.requestId + '.ordinal-seal.json');
    const seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    for (const witness of seal.witnesses) witness.path = path.join(diagnostics, path.basename(witness.path));
    fs.writeFileSync(sealFile, JSON.stringify(seal, null, 2) + '\n', { mode: 0o600 });
    record.pins = { ...record.pins, sealSha256: sha(fs.readFileSync(sealFile)) };
    Config.FILES.dailyFreshSourceRunsDir = workspace;
    Config.FILES.llmUsageDir = originalRoots.llmUsageDir;
    // 真实分析锁会写生产目录；本用例只读重放，显式按已持锁处理。
    testApi.mock.method(engine, 'paperAnalysisLockHeld', () => true);
    const resultPaper = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/current/deep-analysis-result.json'), 'utf8'))
        .papers.find(paper => paper.arxivId === PAPER_ID);
    assert.ok(resultPaper?.freshRewriteProvenance, 'actual failing paper provenance must exist');
    const provenance = resultPaper.freshRewriteProvenance;
    const paper = { arxivId: PAPER_ID, freshRewriteProvenance: provenance,
        analysisManifest: { freshRewriteProvenance: provenance, contracts: {}, stages: {} } };
    fresh.withFreshAnalysisContext({ runDir, runId: RUN_ID, sourceExpectations: run.sourceExpectations }, () => {
        const source = fresh.readFreshSource(runDir, paper, { runId: RUN_ID, sourceExpectations: run.sourceExpectations });
        const pixelFigureOrdinals = (candidate.payload.imageEvidence || [])
            .filter(image => image?.kind === 'figure').map(image => image.ordinal);
        const compilation = JSON.parse(fs.readFileSync(
            path.join(diagnostics, record.requestId + '.ordinal-compiled.json'), 'utf8'));
        const normalized = {};
        deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(compilation.afterDraft), [], {
            paperId: PAPER_ID, sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
            pixelFigureOrdinals, draftOrderMappings: []
        }, normalized);
        // 真实失败稿的最后一笔编译不再派生当前草稿：原子表格追加改写了基线。
        assert.notDeepEqual(normalized.draft, candidate.payload.draft);
        // ④ 保存候选恢复：链已不派生当前草稿，必须可判定拒绝，不能挂 origin 伪造完成。
        repair.saveFailedCandidate(attempts, candidate.identity, structuredClone(candidate.payload));
        const nonTerminalResult = { article: '# 正文\n', plan: { sections: [] }, ordinalPatchCompilations: [record] };
        assert.throws(() => ordinal.attachSavedOrigin({
            paper, identity: candidate.identity, directory: attempts,
            draft: candidate.payload.draft, records: [record]
        }, nonTerminalResult, { issues: [], pixelFigureOrdinals }), error => {
            assert.equal(error.code, 'READER_ORDINAL_ORIGIN_MISMATCH');
            assert.equal(error.scope, undefined);
            return /does not derive the active draft/.test(error.message);
        });
        // ① 终态链：把候选恢复成最后一笔编译实际派生的草稿，origin 必须被认出并正常 seal。
        const terminalPayload = structuredClone(candidate.payload);
        terminalPayload.draft = normalized.draft;
        terminalPayload.rawDraft = JSON.stringify(normalized.draft);
        terminalPayload.ordinalPatchCompilations = [record];
        repair.saveFailedCandidate(attempts, candidate.identity, terminalPayload);
        const result = { article: '# 正文\n', plan: { sections: [] }, ordinalPatchCompilations: [record] };
        ordinal.attachSavedOrigin({
            paper, identity: candidate.identity, directory: attempts,
            draft: terminalPayload.draft, records: [record]
        }, result, { issues: [], pixelFigureOrdinals });
        const stage = { status: 'complete', articleSha256: sha(result.article), planSha256: stableSha(result.plan) };
        paper.analysisManifest.stages.apiReaderArticle = stage;
        paper.apiReaderArticle = result.article;
        paper.apiReaderPlan = result.plan;
        const ref = ordinal.sealCompletion(paper, result);
        assert.ok(fs.existsSync(ref.path));
        const completion = JSON.parse(fs.readFileSync(ref.path, 'utf8'));
        assert.deepEqual(completion.records, [record]);
        assert.equal(completion.articleSha256, sha(result.article));
        assert.equal(stage.ordinalPatchContract, ordinal.CONTRACT);
        assert.equal(paper.analysisManifest.contracts.readerTargetOrdinalPatch, ordinal.CONTRACT);
        // ② 快照后数组被追加：origin 不再等于最终数组，必须可判定拒绝（内容级，不是运行级）。
        const appended = [...result.ordinalPatchCompilations, {
            ...record, requestId: '00000000-0000-4000-8000-000000000000'
        }];
        result.ordinalPatchCompilations = appended;
        assert.throws(() => ordinal.sealCompletion(paper, result), error => {
            assert.equal(error.code, 'READER_ORDINAL_ORIGIN_MISMATCH');
            assert.equal(error.scope, undefined);
            return /completion origin no longer matches/.test(error.message);
        });
        // ③ 有 compilations 无 origin：内容级可判定错误（同一断言在纯逻辑用例里也有覆盖）。
        assert.throws(() => ordinal.sealCompletion(paper, {
            article: result.article, plan: result.plan, ordinalPatchCompilations: [record]
        }), error => {
            assert.equal(error.code, 'READER_ORDINAL_ORIGIN_MISSING');
            assert.equal(error.scope, undefined);
            return /origin missing/.test(error.message);
        });
    });
});

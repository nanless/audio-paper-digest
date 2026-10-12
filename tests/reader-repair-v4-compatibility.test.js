'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer.js');
const versions = require('../scripts/lib/prompt-text-versions.js');
const repair = require('../scripts/lib/reader-repair.js');
function createReaderTestArticle() {
    const kinds = ['background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation', 'reproduction', 'synthesis'];
    const draft = { version: 3, readerTitle: '从声音输入到执行输出的机制解释',
        oneSentenceThesis: '语音方法依次处理输入表征与条件约束，实验需保持对照设置一致，再解释指标变化支持的有限结论。',
        sections: kinds.map((kind, index) => ({ kind, heading: `声音处理中步骤 ${index + 1} 的输入输出如何衔接？`,
            body: `这一部分解释声音处理的${kind}环节，先限定输入信号，再描述信息如何沿组件传递。`.repeat(6) })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['声学表示', '语义条件'], sectionKind: 'method_overview',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`,
            explanation: '声学表示保存输入信号的发音结构，语义条件限定合理的内容范围，两者分工使预测既遵循声音证据也满足当前任务约束。'
        })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
    draft.sections[3].body += '\n\n' + draft.conceptBridges.map(item => item.marker).join('\n\n');
    return draft;
}


function patchFor(draft, replacements) {
    return { version: 1, draftSha256: repair.hashDraft(draft), replacements: replacements.map(([pointer, value]) => {
        let old = draft;
        for (const part of pointer.slice(1).split('/')) old = old[part];
        return { path: pointer, oldSha256: repair.hashDraft(old), value };
    }) };
}

test('旧完成 Reader 冻结局部修复 v3，待处理请求采用 v8', () => {
    const paper = { id: '2610.90037', title: '局部修复版本核验' };
    const oldStage = { status: 'complete', promptTextContract: 'analysis-prompt-text-v4',
        repairPromptTextContract: 'analysis-prompt-text-v3' };
    const before = JSON.stringify(oldStage);
    const fingerprint = stage => deep.buildRecoveryFingerprints(paper, '真实受控语音来源', paper.id,
        { stages: { apiReaderArticle: stage } }).apiReaderArticle;
    const oldFingerprint = fingerprint(oldStage);
    assert.equal(versions.promptFilePathForContract('apiReaderRepair', oldStage.repairPromptTextContract),
        'prompts/api-reader-repair-v3.md');
    assert.equal(versions.currentPromptTextContract('apiReaderRepair'), 'analysis-prompt-text-v10');
    assert.notEqual(fingerprint({ status: 'pending' }), oldFingerprint);
    assert.equal(fingerprint(oldStage), oldFingerprint);
    assert.equal(JSON.stringify(oldStage), before);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../prompts/api-reader-repair-v3.md'))).digest('hex'),
        '03baf3e0c54831c8e6e25d2fda2f223e908a54353d0a2b54c68aa7cbd41cac2a');
});

test('真实公开局部请求使用当前完整原表修复 v8，保存的付费尝试数未清零', async t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-repair-v4-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = createReaderTestArticle();
    draft.readerTitle = '短';
    const stages = [];
    const stop = Object.assign(new Error('本地捕获第三请求后停止'), { retryable: false, scope: 'run' });
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2610.90037', title: '逐表局部修复' }, '', '', {
        sourceText: '完整受控语音论文来源', readerAttemptsDir: directory, readerMaxAttempts: 3,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async (messages, budget, options) => {
            stages.push(options.usageContext.stage);
            if (stages.length === 1) return JSON.stringify(draft);
            const prompt = messages[0].content[0].text;
            assert.match(prompt, /本次只补这一张，剩余已声明的缺表在后续修复中逐项补齐/);
            assert.doesNotMatch(prompt, /新增.*1.*总数.*等于/);
            if (stages.length === 2) return JSON.stringify(patchFor(draft, [['/readerTitle', '声音表示如何与语义条件连接起来']]));
            throw stop;
        }
    }), /本地捕获第三请求后停止/);
    assert.deepEqual(stages, ['apiReaderArticle', 'apiReaderRepair', 'apiReaderRepair']);
    const active = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    assert.ok(active);
    const envelope = JSON.parse(fs.readFileSync(path.join(directory, active), 'utf8'));
    assert.equal(envelope.payload.attempts, 2);
    assert.equal(envelope.payload.fullAttempts, 1);
    assert.equal(envelope.identity.repairPromptSha256, deep.runtimePromptTemplateSha256(
        versions.promptFilePathForContract('apiReaderRepair', versions.currentPromptTextContract('apiReaderRepair'))));
});

// 历史迁移控制显式选冻结 v4 修复正文；不把当前 v5 当成固定 v3→v4 目标。
function frozenV4RepairControl() {
    const Module = require('node:module');
    const filename = require.resolve('../scripts/deep-analyzer.js');
    const controlled = new Module(filename, module);
    controlled.filename = filename;
    controlled.paths = Module._nodeModulePaths(path.dirname(filename));
    controlled.require = function (request) {
        const actual = Module.prototype.require.call(this, request);
        if (request !== './lib/prompt-text-versions.js') return actual;
        return { ...actual,
            currentPromptTextContract: stage => stage === 'apiReaderRepair'
                ? 'analysis-prompt-text-v4' : actual.currentPromptTextContract(stage),
            currentTextStagePromptPath: stage => stage === 'apiReaderRepair'
                ? actual.promptFilePathForContract(stage, 'analysis-prompt-text-v4')
                : actual.currentTextStagePromptPath(stage) };
    };
    controlled._compile(fs.readFileSync(filename, 'utf8'), filename);
    return controlled.exports;
}

async function withControlledRecoveryCandidate(t, callback) {
    const historicalDeep = frozenV4RepairControl();
    const Config = require('../scripts/config.js');
    const fresh = require('../scripts/lib/fresh-analysis-context.js');
    const revision = require('../scripts/lib/reader-recovery-revision.js');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-prompt-transfer-'));
    const previousRoot = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = root;
    t.after(() => { Config.FILES.freshRewriteRunsDir = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });
    const runId = crypto.randomUUID();
    const runDir = path.join(root, runId);
    fs.mkdirSync(runDir, { mode: 0o700 });
    const paperId = '2610.90038';
    const sourceText = 'Controlled acoustic source method, data and limitations. '.repeat(1000);
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    const artifactBody = { figures: [], formulas: [], tables: [], flattenedTextSha256: sha(sourceText), parserVersion: 'offline-empty-source-v1', version: 1 };
    const artifacts = { ...artifactBody, payloadSha256: sha(JSON.stringify(artifactBody)) };
    const sourceExpectations = { [paperId]: { sourceSha256: sha(sourceText), structuredArtifactsSha256: artifacts.payloadSha256 } };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1, contract: 'fresh-rewrite-run-v1', runId, paperIds: [paperId], sourceExpectations }), { mode: 0o600 });
    const directory = path.join(runDir, 'reader-attempts');
    await fresh.withFreshAnalysisContext({ runId, runDir, sourceExpectations, refreshReaderDiagnostics: true }, async () => {
        await fresh.fetchFreshSource(paperId, async () => ({ source: 'html', sourceId: paperId, text: sourceText, structuredArtifacts: artifacts }));
        const draft = createReaderTestArticle();
        draft.readerTitle = '短';
        let initialCalls = 0;
        const stop = Object.assign(new Error('受控原草稿保存后停止'), { retryable: false, scope: 'run' });
        const options = { sourceText, structuredArtifacts: artifacts, readerAttemptsDir: directory, readerMaxAttempts: 3,
            readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async () => { initialCalls++; if (initialCalls === 1) return JSON.stringify(draft); throw stop; } };
        const paper = { arxivId: paperId, title: '局部提示词许可转交' };
        await assert.rejects(historicalDeep.generateApiReaderArticleDetailed(paper, '', '', options), /受控原草稿保存后停止/);
        const originalName = fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
        const original = JSON.parse(fs.readFileSync(path.join(directory, originalName), 'utf8'));
        assert.equal(original.payload.attempts, 1);
        assert.equal(original.payload.fullAttempts, 1);
        await callback({ directory, original, originalName, revision, options, paper, historicalDeep });
    });
}

const FROZEN_REPAIR_V3_SHA = 'c63148bca8bed36a8c31b0327b87e2a1e9ddf51fd8641813827f5e8f1eb4a6ec';

test('仅固定旧修复提示词变化不发新许可、不清连续失败，重复加载也保持计数', async t => {
    await withControlledRecoveryCandidate(t, async ({ directory, original, originalName, revision }) => {
        // 这是显式构造的旧声明形状；真实旧模块生产者由独立 normal batch 控制验证。
        const oldIdentity = { ...original.identity, repairPromptSha256: FROZEN_REPAIR_V3_SHA };
        const payload = { ...original.payload, noProgress: 2, failureSignature: 'original-failure', transportFailures: 3 };
        repair.saveFailedCandidate(directory, oldIdentity, payload);
        fs.unlinkSync(path.join(directory, originalName));
        const migrated = revision.loadReaderRecoveryRevision(directory, original.identity);
        assert.equal(migrated.implementationRepairAllowanceProof, null);
        assert.equal(migrated.noProgress, 2);
        assert.equal(migrated.failureSignature, 'original-failure');
        for (const key of ['attempts', 'fullAttempts', 'transportFailures']) assert.equal(migrated[key], payload[key]);
        assert.deepEqual(revision.loadReaderRecoveryRevision(directory, original.identity), migrated);
    });
});

test('真实未用实现许可经固定提示词转交，网络失败保存后再次只修正文并保留同一许可', async t => {
    await withControlledRecoveryCandidate(t, async ({ directory, original, originalName, revision, options, paper, historicalDeep }) => {
        const oldCurrentIdentity = { ...original.identity, repairPromptSha256: FROZEN_REPAIR_V3_SHA };
        const oldImplementationIdentity = { ...oldCurrentIdentity, repairImplementationSha256: '0'.repeat(64) };
        repair.saveFailedCandidate(directory, oldImplementationIdentity, original.payload);
        fs.unlinkSync(path.join(directory, originalName));
        const withAllowance = revision.loadReaderRecoveryRevision(directory, oldCurrentIdentity);
        assert.equal(repair.validateImplementationAllowance(withAllowance, oldCurrentIdentity, directory), true);
        const originalProof = withAllowance.implementationRepairAllowanceProof;
        const migrated = revision.loadReaderRecoveryRevision(directory, original.identity);
        assert.equal(migrated.implementationRepairAllowanceProof.contract, 'reader-repair-prompt-unused-allowance-transfer-v1');
        assert.equal(migrated.implementationRepairAllowanceProof.originalAllowanceSha256, originalProof.allowanceSha256);
        assert.equal(repair.validateImplementationAllowance(migrated, original.identity, directory), true);
        assert.throws(() => repair.saveFailedCandidate(directory, original.identity, { ...migrated,
            implementationRepairAllowanceProof: { ...migrated.implementationRepairAllowanceProof, allowanceSha256: 'f'.repeat(64) }
        }), /allowance|许可|凭证/i);
        assert.throws(() => repair.saveFailedCandidate(directory, original.identity, { ...migrated,
            consumedImplementationAllowanceSha256: [...(migrated.consumedImplementationAllowanceSha256 || []), originalProof.allowanceSha256]
        }), /allowance|许可|凭证/i);
        assert.equal(revision.loadReaderRecoveryRevision(directory, oldCurrentIdentity), null);
        const stages = [];
        const transportError = Object.assign(new Error('受控网络异常'), { retryable: false, scope: 'run' });
        await assert.rejects(historicalDeep.generateApiReaderArticleDetailed(paper, '', '', { ...options,
            readerCallModel: async (messages, budget, requestOptions) => { stages.push(requestOptions.usageContext.stage); throw transportError; }
        }), /受控网络异常/);
        assert.deepEqual(stages, ['apiReaderRepair']);
        const saved = repair.loadFailedCandidate(directory, original.identity);
        assert.equal(saved.attempts, migrated.attempts);
        assert.equal(saved.fullAttempts, migrated.fullAttempts);
        assert.equal(saved.transportFailures, migrated.transportFailures + 1);
        assert.deepEqual(saved.implementationRepairAllowanceProof, migrated.implementationRepairAllowanceProof);
        assert.equal(repair.validateImplementationAllowance(saved, original.identity, directory), true);
        const restored = revision.loadReaderRecoveryRevision(directory, original.identity);
        assert.deepEqual(restored.implementationRepairAllowanceProof, saved.implementationRepairAllowanceProof);
        const resumedStages = [];
        await assert.rejects(historicalDeep.generateApiReaderArticleDetailed(paper, '', '', { ...options,
            readerCallModel: async (messages, budget, requestOptions) => {
                resumedStages.push(requestOptions.usageContext.stage);
                if (resumedStages.length > 1) throw transportError;
                return JSON.stringify(patchFor(saved.draft, [['/readerTitle', '声音表示如何与语义条件连接起来']]));
            }
        }), /受控网络异常/);
        assert.deepEqual(resumedStages, ['apiReaderRepair', 'apiReaderRepair']);
        const consumed = repair.loadFailedCandidate(directory, original.identity);
        assert.equal(consumed.draft.readerTitle, '声音表示如何与语义条件连接起来');
        assert.equal(consumed.attempts, saved.attempts + 1);
        assert.equal(consumed.fullAttempts, saved.fullAttempts);
        assert.equal(consumed.implementationRepairAllowanceProof, null);
        assert.ok(consumed.consumedImplementationAllowanceSha256.includes(saved.implementationRepairAllowanceProof.allowanceSha256));
    });
});

test('已耗尽的旧提示词候选不获新许可，未知提示词或来源身份变化不能迁移', async t => {
    await withControlledRecoveryCandidate(t, async ({ directory, original, originalName, revision, options, paper, historicalDeep }) => {
        const oldIdentity = { ...original.identity, repairPromptSha256: FROZEN_REPAIR_V3_SHA };
        const exhausted = { ...original.payload, attempts: 3, fullAttempts: 3 };
        repair.saveFailedCandidate(directory, oldIdentity, exhausted);
        fs.unlinkSync(path.join(directory, originalName));
        const migrated = revision.loadReaderRecoveryRevision(directory, original.identity);
        assert.equal(migrated.attempts, 3);
        assert.equal(migrated.fullAttempts, 3);
        assert.equal(migrated.implementationRepairAllowanceProof, null);
        let calls = 0;
        await assert.rejects(historicalDeep.generateApiReaderArticleDetailed(paper, '', '', { ...options,
            readerCallModel: async () => { calls++; throw new Error('不应新请求'); }
        }));
        assert.equal(calls, 0);
        assert.equal(revision.loadReaderRecoveryRevision(directory, { ...original.identity, repairPromptSha256: 'f'.repeat(64) }), null);
        assert.equal(revision.loadReaderRecoveryRevision(directory, { ...original.identity, paperId: '2610.90038v2' }), null);
        assert.throws(() => revision.loadReaderRecoveryRevision(directory, { ...original.identity, sourceSha256: 'f'.repeat(64) }), /source scope/);
        assert.throws(() => revision.loadReaderRecoveryRevision(directory, { ...original.identity,
            freshAnalysis: { ...original.identity.freshAnalysis, paperId: '2610.90039' } }), /source scope/);
    });
});

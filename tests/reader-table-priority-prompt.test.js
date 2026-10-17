'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Config = require('../scripts/config');
const deep = require('../scripts/deep-analyzer');
const versions = require('../scripts/lib/prompt-text-versions');
const repair = require('../scripts/lib/reader-repair');
const { loadPrompt } = require('../scripts/utils');
const fresh = require('../scripts/lib/fresh-analysis-context');
const { loadReaderRecoveryRevision } = require('../scripts/lib/reader-recovery-revision');
const articleSha = 'a41f67166a0f366a10bf23cc17aa51ca6105b246ce7964ec14c21d6b4018f380';
const repairV7Sha = 'cdbf91f9bb2fb48e085c72195000059bdb2ccc4eb6a0bd47a6f31bb9d4835965';
const repairV8Sha = '9a7e72d75fdd05f7004c132533425fa140d237c22bc98a3c6c64333e5d76e22e';
const repairV9Sha = '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65';

function createRecoverySample(t, oldRepairSha, attempts) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-table-priority-'));
    const originalRoot = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = root;
    t.after(() => {
        Config.FILES.freshRewriteRunsDir = originalRoot;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const runId = crypto.randomUUID();
    const runDir = path.join(root, runId);
    const paperId = '2610.99971';
    const sourceExpectations = { [paperId]: { sourceSha256: 'a'.repeat(64), structuredArtifactsSha256: 'b'.repeat(64) } };
    fs.mkdirSync(runDir, { mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ version: 1,
        contract: 'fresh-rewrite-run-v1', runId, paperIds: [paperId], sourceExpectations }), { mode: 0o600 });
    const identity = { paperId, freshAnalysis: { runId, paperId, ...sourceExpectations[paperId] },
        sourceSha256: 'a'.repeat(64), inputFingerprint: '同一来源输入', model: { model: '离线测试' },
        promptSha256: articleSha, repairPromptSha256: oldRepairSha, maxAttempts: 6 };
    const draft = { version: 3, readerTitle: '保留失败正文', oneSentenceThesis: '不改来源或次数。',
        sections: [{ kind: 'component', heading: '已有正文', body: '尚需正常修复的原正文。' }],
        conceptBridges: [], figurePlacements: [], tableBindings: [], formulaBindings: [] };
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft),
        issues: [{ path: null, message: '原失败保留' }], attempts, fullAttempts: 2,
        transportFailures: 0, noProgress: 2, failureSignature: '原失败签名', imageEvidence: [] };
    return { directory: path.join(runDir, 'reader-attempts'), identity, payload,
        enabled: callback => fresh.withFreshAnalysisContext({ runId, runDir, sourceExpectations,
            refreshReaderDiagnostics: true }, callback) };
}

test('新修复提示明确完整原表优先，来源证据字节和授权目标不变', () => {
    const sourceEvidence = 'TABLE_3_SELECTION: {"eligible":false,"action":"完整复制原始 matrix 为 Markdown，逐格绑定DOM，不用 TABLE marker"}';
    const draft = { version: 3, readerTitle: '原表', oneSentenceThesis: '保留证据。',
        sections: [{ kind: 'result', heading: '结果', body: '| 项目 | 数值 |\n| --- | --- |\n| 甲 | 75.3 |' }],
        conceptBridges: [], figurePlacements: [], tableBindings: [{ tableIndex: 1,
            sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: ['原文中的连续真实证据。'] }], formulaBindings: [] };
    const issues = [{ path: null, message: '读者文章 tableBindings[0] 列头单位缺少对应原文证据' }];
    const context = repair.buildRepairContext(draft, issues, sourceEvidence);
    assert.equal(context.evidence, sourceEvidence);
    assert.deepEqual(context.targets.map(target => target.path), ['/tableBindings/0', '/sections/0/body']);
    const values = { title: '原论文', arxivId: '2610.99971', mechanicalContract: '原检查不变',
        validationFeedback: context.targetGuidance, repairTargets: JSON.stringify(context), sourceEvidence,
        operationProtocol: repair.repairOperationProtocol(context) };
    const oldPrompt = loadPrompt('prompts/api-reader-repair-v8.md', values);
    const newPrompt = loadPrompt(versions.currentTextStagePromptPath('apiReaderRepair'), values);
    assert.doesNotMatch(oldPrompt, /表格输出方式以本提示词和本轮授权路径为准/);
    assert.match(newPrompt, /旧式 `artifact_table` 兼容方式，不会禁止这里的 `completeTable`/);
    assert.match(newPrompt, /没有这两个授权时不能转换模式/);
    assert.ok(newPrompt.includes(sourceEvidence));
    assert.equal(deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v8.md'), repairV8Sha);
    assert.equal(deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v9.md'), repairV9Sha);
    assert.equal(versions.promptFilePathForContract('apiReaderRepair', 'analysis-prompt-text-v8'), 'prompts/api-reader-repair-v8.md');
    assert.throws(() => versions.promptFilePathForContract('apiReaderRepair', 'analysis-prompt-text-v99'));
});

test('固定修复提示升级保留4或5次修复及2次全篇尝试，不发放新次数', async t => {
    // This is the original article-v6 + repair-v7/v8 -> v9 migration,
    // not permission to combine a historical repair with the current article.
    assert.equal(deep.runtimePromptTemplateSha256('prompts/api-reader-article-v6.md'), articleSha);
    for (const [version, expected] of [[7, repairV7Sha], [8, repairV8Sha], [9, repairV9Sha]]) {
        assert.equal(deep.runtimePromptTemplateSha256(`prompts/api-reader-repair-v${version}.md`), expected);
    }
    for (const [oldRepairSha, attempts] of [[repairV7Sha, 4], [repairV8Sha, 5]]) {
        await t.test(`${attempts}次修复保留`, tt => {
            const sample = createRecoverySample(tt, oldRepairSha, attempts);
            const filename = repair.saveFailedCandidate(sample.directory, sample.identity, sample.payload);
            const originalBytes = fs.readFileSync(filename);
            const nextIdentity = { ...sample.identity, repairPromptSha256: repairV9Sha };
            for (const invalidIdentity of [
                { ...nextIdentity, repairPromptSha256: 'f'.repeat(64) },
                { ...nextIdentity, promptSha256: 'e'.repeat(64) },
                { ...nextIdentity, promptSha256: deep.runtimePromptTemplateSha256(
                    versions.currentTextStagePromptPath('apiReaderArticle')) }
            ]) {
                assert.throws(() => sample.enabled(() => loadReaderRecoveryRevision(sample.directory, invalidIdentity)),
                    { code: 'READER_PROMPT_CHANGE_REQUIRES_CONTROLLED_RECOVERY' });
                assert.deepEqual(fs.readFileSync(filename), originalBytes);
                assert.deepEqual(fs.readdirSync(sample.directory), [path.basename(filename)]);
            }
            assert.equal(sample.enabled(() => loadReaderRecoveryRevision(sample.directory,
                { ...nextIdentity, inputFingerprint: '另一个来源输入' })), null);
            assert.deepEqual(fs.readFileSync(filename), originalBytes);
            const recovered = sample.enabled(() => loadReaderRecoveryRevision(sample.directory, nextIdentity));
            assert.equal(recovered.status, 'failed');
            assert.equal(recovered.attempts, attempts);
            assert.equal(recovered.fullAttempts, 2);
            assert.equal(recovered.rawDraft, sample.payload.rawDraft);
            assert.deepEqual(recovered.draft, sample.payload.draft);
            assert.equal(recovered.implementationRepairAllowanceProof, null);
            assert.deepEqual(recovered.readerRecoveryRevisions[0].changedFields, ['repairPromptSha256']);
            assert.deepEqual(fs.readFileSync(path.join(sample.directory,
                recovered.readerRecoveryRevisions[0].archivedName)), originalBytes);
        });
    }
});

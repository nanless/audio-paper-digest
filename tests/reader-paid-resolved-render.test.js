'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { stableHash } = require('../scripts/lib/fresh-rewrite-run');
const repair = require('../scripts/lib/reader-repair');
const entry = require('../scripts/lib/reader-paid-resolved-render');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function createSample() {
    const source = { text: '这是完整来源的替代测试文本，不作为真实全文通过声明。',
        structuredArtifacts: { payloadSha256: 'a'.repeat(64) } };
    const draft = { sections: [{ body: '原始付费正文' }] };
    const model = { model: 'muse-spark-1.3-contributor', protocol: 'openai_responses', endpoint: 'https://opencode.ai/zen/go/v1',
        temperature: 0.6, maxTokens: 48000, maxResponseBytes: 16777216 };
    const identity = { paperId: '2610.03602', contentMode: 'reader-source-only-v1', sourceSha256: sha(source.text),
        freshAnalysis: { sourceSha256: sha(source.text) }, model,
        promptSha256: 'b4f0b864fd338cc3a58a2e061ec952947a6faa4a09971167d6daa7add9ebbd9f',
        repairPromptSha256: 'd3fa5851973b36e0944a9abf13f719aa34b1782f784ee086e6e637deea8979c2', repairMaxTokens: 16000, repairTemperature: 0.1 };
    const payload = { status: 'failed', draft, rawDraft: JSON.stringify(draft), attempts: 1, fullAttempts: 1,
        noProgress: 0, transportFailures: 0, imageEvidence: [], ephemeralImageEvidence: { imageEvidence: [], directSupplementaryEvidence: [] } };
    const stage = { status: 'complete', sourceBindingsSourceTextSha256: identity.sourceSha256,
        structuredArtifactsSha256: source.structuredArtifacts.payloadSha256,
        ...model, promptTemplateSha256: identity.promptSha256, repairPromptTemplateSha256: identity.repairPromptSha256,
        repairMaxTokens: 16000, repairTemperature: 0.1, attempts: 1,
        promptTextContract: 'analysis-prompt-text-v7', repairPromptTextContract: 'analysis-prompt-text-v11',
        imageEvidenceSha256: stableHash([]), imageEvidenceCount: 0,
        modelImagePreflightEvidenceSha256: repair.hashDraft(payload.ephemeralImageEvidence) };
    const paper = { arxivId: '2610.03602v1', sourceSha256: identity.sourceSha256, apiReaderFigures: [],
        apiReaderArticleSha256: 'd'.repeat(64), apiReaderPlanSha256: 'e'.repeat(64),
        analysisManifest: { stages: { apiReaderArticle: stage } } };
    const envelope = { version: repair.REPAIR_VERSION, identity, payload, payloadSha256: repair.hashDraft(payload) };
    return { paper, source, checked: { envelope }, expectedPaperSha: stableHash(paper) };
}

test('单次原始付费档核验返回副本，不增加额度也不污染原响应', () => {
    const sample = createSample();
    const result = entry.validatePaidResolvedInput(sample.paper, sample.source, sample.checked, sample.expectedPaperSha);
    result.draft.sections[0].body = '调用者修改';
    assert.equal(sample.checked.envelope.payload.draft.sections[0].body, '原始付费正文');
    assert.equal(result.attempts, 1);
});

for (const [name, change] of [
    ['旧模型', sample => { sample.checked.envelope.identity.model.model = 'mimo-v2.6-flash'; }],
    ['变化的来源', sample => { sample.source.text += '新增'; }],
    ['已收费第二次', sample => { sample.checked.envelope.payload.attempts = 2; }],
    ['额外授权', sample => { sample.checked.envelope.payload.explicitReaderRetryRound = { roundId: '不能忽略' }; }],
    ['实现奖励', sample => { sample.checked.envelope.payload.implementationRepairAllowanceProof = { issued: true }; }],
    ['错误的像素证明', sample => { sample.paper.analysisManifest.stages.apiReaderArticle.imageEvidenceSha256 = '0'.repeat(64); sample.expectedPaperSha = stableHash(sample.paper); }],
    ['变化的提示词', sample => { sample.checked.envelope.identity.promptSha256 = '0'.repeat(64); }],
    ['修改响应正文', sample => { sample.checked.envelope.payload.draft.sections[0].body = '新正文'; }]
]) test(`${name}不能借重渲染建立新身份或清账`, () => {
    const sample = createSample(); change(sample);
    assert.throws(() => entry.validatePaidResolvedInput(sample.paper, sample.source, sample.checked, sample.expectedPaperSha));
});

test('独审两份SHA相同还须准确旧renderer关联，任一输出不同或发生模型请求都拒绝', () => {
    const { paper } = createSample();
    const good = { articleSha256: paper.apiReaderArticleSha256, planSha256: paper.apiReaderPlanSha256, modelRequests: 0 };
    entry.assertOriginalRendering(paper, good);
    for (const bad of [{ ...good, articleSha256: '0'.repeat(64) },
        { ...good, planSha256: '0'.repeat(64) }, { ...good, modelRequests: 1 }]) {
        assert.throws(() => entry.assertOriginalRendering(paper, bad));
    }
});

test('普通调用没有图像免下载授权，纯重渲染只复制完全相同的图而不改旧对象', () => {
    assert.equal(entry.reuseVerifiedPaidResolvedFigures([], {}), null);
    const old = [{ ordinal: 1, url: 'https://arxiv.org/a.png', sourceDomSha256: 'a'.repeat(64),
        targetKind: 'result', targetHeading: '真实结果', marker: '[[FIGURE_1]]', leadQuote: '原导读',
        explanationQuote: '原解释', focusPoints: ['原路径'], assetSha256: 'b'.repeat(64) }];
    const current = structuredClone(old); delete current[0].assetSha256;
    const copied = entry.copyUnchangedSignedFigures(current, old); copied[0].leadQuote = '改动副本';
    assert.equal(old[0].leadQuote, '原导读');
    for (const key of ['ordinal', 'url', 'sourceDomSha256', 'targetHeading', 'leadQuote', 'explanationQuote']) {
        const bad = structuredClone(current); bad[0][key] = '篡改';
        assert.throws(() => entry.copyUnchangedSignedFigures(bad, old));
    }
    assert.throws(() => entry.copyUnchangedSignedFigures([], old));
});

test('resolved原档必须名字、payload与字节SHA匹配，保存前同size改写也拒绝', t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paid-reader-sample-'))); fs.chmodSync(directory, 0o700);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { checked } = createSample();
    const filename = path.join(directory, `${repair.hashDraft(checked.envelope.identity)}.11111111-2222-4333-8444-555555555555.resolved.json`);
    const bytes = Buffer.from(JSON.stringify(checked.envelope)); fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const result = entry.readResolvedFile(directory, filename, sha(bytes)); result.assertUnchanged();
    assert.throws(() => entry.readResolvedFile(directory, filename, '0'.repeat(64)));
    const oldStat = fs.statSync(filename); const changed = Buffer.from(bytes); changed[changed.indexOf('原始付费正文')] ^= 1;
    fs.writeFileSync(filename, changed); fs.utimesSync(filename, oldStat.atime, oldStat.mtime);
    assert.throws(() => result.assertUnchanged());
});

test('普通刷新保存钩子不读取原付费档，不影响无重渲染范围的流程', () => {
    assert.doesNotThrow(() => entry.assertPaidResolvedRenderSnapshot());
});

test('原档被替换或变成链接时，保存前快照拒绝，不能覆盖原账', t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paid-reader-save-')));
    fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const sample = createSample();
    const filename = path.join(directory, `${repair.hashDraft(sample.checked.envelope.identity)}.11111111-2222-4333-8444-555555555555.resolved.json`);
    const bytes = Buffer.from(JSON.stringify(sample.checked.envelope)); fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const snapshot = entry.readResolvedFile(directory, filename, sha(bytes));
    const replacement = path.join(directory, 'replacement'); fs.writeFileSync(replacement, bytes, { mode: 0o600 });
    fs.renameSync(replacement, filename);
    assert.throws(() => snapshot.assertUnchanged(), /保存前原档案/);
    const second = entry.readResolvedFile(directory, filename, sha(bytes));
    fs.renameSync(filename, replacement); fs.symlinkSync(replacement, filename);
    assert.throws(() => second.assertUnchanged(), /保存前原档案/);
});

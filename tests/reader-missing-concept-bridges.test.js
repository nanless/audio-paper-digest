'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');
function createMissingBridgeSample() {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    sample.draft.conceptBridges = sample.draft.conceptBridges.slice(0, 2);
    for (const section of sample.draft.sections) section.body = section.body.replace(/\n\n\[\[CONCEPT_BRIDGE_[34]\]\]/g, '');
    return sample;
}
const issues = [{ message: '读者文章 conceptBridges 必须包含 4-10 个术语组合解释' }];
function createBridgePatch(draft, context) {
    const operation = context.atomicOperation;
    const additions = operation.missingMarkers.map((marker, index) => ({ terms: ['语义条件', '声学定位'],
        sectionKind: operation.sectionKind, marker,
        explanation: `语义条件负责限定候选的意义范围，声学定位负责核对发音与时序细节。两者搭配才能将语义排除与声学证据连成可以检验的决策链，第${index + 1}组解释仍限定于论文报告的测量条件。` }));
    const body = draft.sections[operation.sectionIndex].body + '\n\n' + operation.missingMarkers.join('\n\n');
    return { version: 1, draftSha256: repair.hashDraft(draft), replacements: context.targets.map(target => ({
        path: target.path, oldSha256: target.oldSha256,
        value: target.path === '/conceptBridges' ? [...draft.conceptBridges, ...additions] : body })) };
}
test('缺少术语组合时仅补到四组，旧记录正文与其他来源逐字保留且完整解析仍执行', () => {
    const sample = createMissingBridgeSample();
    const before = JSON.stringify(sample.draft);
    const context = repair.buildRepairContext(sample.draft, issues, '封存原文', sample.sourceDetails.text);
    assert.equal(context.atomicOperation.kind, 'complete_existing_concept_bridges_v1');
    assert.equal(context.targets.length, 2);
    assert.match(context.targetGuidance, /末尾补齐到4组/);
    const merged = repair.applyReaderPatch(sample.draft, createBridgePatch(sample.draft, context),
        context.targets.map(target => target.path), { atomicOperation: context.atomicOperation, availableFigureOrdinals: [] });
    assert.deepEqual(merged.conceptBridges.slice(0, 2), sample.draft.conceptBridges);
    const sectionIndex = context.atomicOperation.sectionIndex;
    assert.ok(merged.sections[sectionIndex].body.startsWith(sample.draft.sections[sectionIndex].body));
    assert.deepEqual(merged.sections.filter((_, index) => index !== sectionIndex), sample.draft.sections.filter((_, index) => index !== sectionIndex));
    for (const field of ['readerTitle','oneSentenceThesis','figurePlacements','tableBindings','formulaBindings']) assert.deepEqual(merged[field], sample.draft[field]);
    assert.equal(JSON.stringify(sample.draft), before);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(sample.draft), { requiredVersion: 3 }), /conceptBridges.*4-10/);
    const parsed = deep.parseApiReaderArticleResult(JSON.stringify(merged), { requiredVersion: 3,
        sourceText: sample.sourceDetails.text, structuredArtifacts: sample.sourceDetails.structuredArtifacts, availableFigureOrdinals: [] });
    assert.ok(parsed);
});
test('未授权、伪许可、改旧解释、删正文、换标记及额外记录仍拒绝', () => {
    const sample = createMissingBridgeSample();
    const context = repair.buildRepairContext(sample.draft, issues, '封存原文');
    const patch = createBridgePatch(sample.draft, context);
    const paths = context.targets.map(target => target.path);
    assert.throws(() => repair.applyReaderPatch(sample.draft, patch, paths), /明确补齐授权/);
    for (const change of [
        value => { value.replacements[0].value[0].explanation += '改旧解释'; },
        value => { value.replacements[0].value.push(value.replacements[0].value[3]); },
        value => { value.replacements[0].value[2].marker = '[[CONCEPT_BRIDGE_9]]'; },
        value => { value.replacements[1].value = '删除原文'; },
        value => { value.replacements[0].oldSha256 = '0'.repeat(64); }
    ]) {
        const bad = structuredClone(patch);
        change(bad);
        assert.throws(() => repair.applyReaderPatch(sample.draft, bad, paths, { atomicOperation: context.atomicOperation }));
    }
    assert.throws(() => repair.applyReaderPatch(sample.draft, patch, paths,
        { atomicOperation: { ...context.atomicOperation, expectedBridgeCount: 10 } }), /明确授权/);
});
test('合法四组、纯字数诊断、未知旧记录或不安全追加边界不增加权限', () => {
    const sample = createMissingBridgeSample();
    assert.notEqual(repair.buildRepairContext(sample.draft, [{ message: '篇幅不足' }], '原文').atomicOperation?.kind, 'complete_existing_concept_bridges_v1');
    for (const body of ['```\n未闭合代码', '> 引用内容', '<div>未知HTML']) {
        const draft = structuredClone(sample.draft);
        for (const section of draft.sections) if (['method_overview','component','training'].includes(section.kind)) section.body += '\n\n' + body;
        assert.notEqual(repair.buildRepairContext(draft, issues, '原文').atomicOperation?.kind, 'complete_existing_concept_bridges_v1');
    }
    const invalid = structuredClone(sample.draft);
    invalid.conceptBridges[0].unknown = '正文不可静默删除';
    assert.notEqual(repair.buildRepairContext(invalid, issues, '原文').atomicOperation?.kind, 'complete_existing_concept_bridges_v1');
});
test('已有唯一独占缺记录标记只补解释并保持正文，重复标记不能授权', () => {
    const sample = createMissingBridgeSample();
    sample.draft.conceptBridges.push({ ...sample.draft.conceptBridges[0], marker: '[[CONCEPT_BRIDGE_3]]' });
    const section = sample.draft.sections.find(section => section.kind === 'method_overview');
    section.body += '\n\n[[CONCEPT_BRIDGE_3]]\n\n[[CONCEPT_BRIDGE_4]]';
    const context = repair.buildRepairContext(sample.draft, issues, '原文');
    assert.equal(context.atomicOperation.reuseExistingMarkers, true);
    const patch = createBridgePatch(sample.draft, context);
    patch.replacements[1].value = section.body;
    const merged = repair.applyReaderPatch(sample.draft, patch, context.targets.map(target => target.path), { atomicOperation: context.atomicOperation });
    assert.deepEqual(merged.sections, sample.draft.sections);
    section.body += '\n\n[[CONCEPT_BRIDGE_4]]';
    assert.notEqual(repair.buildRepairContext(sample.draft, issues, '原文').atomicOperation?.kind, 'complete_existing_concept_bridges_v1');
});
test('正常生成第二次请求明确授权补到四组并保留完整封存证据', async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const sample = createMissingBridgeSample();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-concept-repair-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    const sourceEvidence = '封存原文全文证据逐字保留，不凭草稿推断新增解释。';
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99962', title: '受限术语组合补齐' }, '', sourceEvidence, {
        sourceText: sample.sourceDetails.text, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaxAttempts: 2, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async messages => {
            calls += 1;
            if (calls === 1) return JSON.stringify(sample.draft);
            const prompt = messages[0].content[0].text;
            assert.match(prompt, /complete_existing_concept_bridges_v1/);
            assert.match(prompt, /末尾补齐到4组/);
            assert.ok(prompt.includes(sourceEvidence));
            assert.match(prompt, /旧记录内容和顺序逐字保留/);
            throw new Error('离线术语请求检查完成');
        }
    }), /离线术语请求检查完成/);
    assert.equal(calls, 2);
});

test('不完整小节不能成为少术语组合恢复输入，也不能抛出类型错误', () => {
    for (const invalid of [null, 1, [], {}, { kind: 'component', heading: '标题' }, { kind: 'component', heading: '标题', body: 1 }]) {
        const sample = createMissingBridgeSample();
        sample.draft.sections[0] = invalid;
        assert.equal(repair.parseRepairableDraft(sample.draft), null);
        assert.equal(repair.buildMissingConceptBridgesOperation(sample.draft, issues), null);
    }
});
test('实际旧候选实现迁移仍请求受限术语补丁，不因少于四组强制全文或重置付费账', async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const crypto = require('crypto');
    const direct = require('../scripts/lib/direct-rewrite-analysis-context');
    const sample = createMissingBridgeSample();
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-concept-migration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'reader-attempts');
    const paperId = '2609.99963';
    const paper = { arxivId: paperId, title: '术语组合原付费稿迁移',
        apiReaderResources: structuredClone(sample.paper.apiReaderResources) };
    const sourceDetails = { ...sample.sourceDetails, paperId: `arxiv:${paperId}`, source: 'html', sourceId: paperId };
    const scope = { paperId: `arxiv:${paperId}`, runId: crypto.randomUUID(), route: 'arxiv-fresh-fetch', sourceDetails,
        sourceSha256: repair.shaText(sourceDetails.text), structuredArtifactsSha256: sourceDetails.structuredArtifacts.payloadSha256,
        sourceSnapshotSha256: 'c'.repeat(64), sourceGeneration: 1, sourceManifestSha256: 'd'.repeat(64), readerAttemptsDir: directory };
    const options = { sourceText: sourceDetails.text, structuredArtifacts: sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaxAttempts: 3, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {} };
    let initialCalls = 0;
    await assert.rejects(direct.withDirectRewriteAnalysisSource(scope, () => deep.generateApiReaderArticleDetailed(paper, '', '完整封存证据', {
        ...options, readerCallModel: async () => {
            if (++initialCalls === 1) return JSON.stringify(sample.draft);
            throw new Error('受控传输中断');
        }
    })), /受控传输中断/);
    const currentFile = path.join(directory, fs.readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name)));
    const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
    const oldIdentity = { ...current.identity, repairImplementationSha256: 'a'.repeat(64) };
    fs.renameSync(currentFile, path.join(root, '当前样例记录保留.json'));
    const oldFile = repair.saveFailedCandidate(directory, oldIdentity, current.payload);
    const oldBytes = fs.readFileSync(oldFile);
    let resumedCalls = 0;
    await assert.rejects(direct.withDirectRewriteAnalysisSource(scope, () => deep.generateApiReaderArticleDetailed(paper, '', '完整封存证据', {
        ...options, readerCallModel: async (messages, budget, requestOptions) => {
            resumedCalls += 1;
            assert.equal(requestOptions.usageContext.stage, 'apiReaderRepair');
            assert.match(messages[0].content[0].text, /complete_existing_concept_bridges_v1/);
            assert.ok(budget <= 16000);
            throw new Error('已核验迁移补丁请求');
        }
    })), /已核验迁移补丁请求/);
    assert.equal(resumedCalls, 1);
    const archive = fs.readdirSync(directory).find(name => name.startsWith(repair.hashDraft(oldIdentity) + '.migrated-'));
    assert.ok(archive);
    assert.deepEqual(fs.readFileSync(path.join(directory, archive)), oldBytes);
    const migrated = direct.withDirectRewriteAnalysisSource(scope, () => repair.loadFailedCandidate(directory, current.identity));
    assert.equal(migrated.attempts, current.payload.attempts);
    assert.equal(migrated.fullAttempts, current.payload.fullAttempts);
    assert.ok(migrated.implementationRepairAllowanceProof);
});

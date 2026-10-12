'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');
function createCompositeSample() {
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    sample.draft.conceptBridges = sample.draft.conceptBridges.slice(0, 3);
    for (const section of sample.draft.sections) section.body = section.body.replace(/\n\n\[\[CONCEPT_BRIDGE_4\]\]/g, '');
    for (let index = 12; index < 19; index += 1) sample.draft.sections.push({ kind: 'component', heading: `附加组件说明${index}`, body: `原有组件内容${index}必须保留，不代表新增的论文事实。`.repeat(8) });
    return sample;
}
test('超节数与少术语组合同时存在时先授权小节重排，其他数组仍精确保留', () => {
    const { draft } = createCompositeSample();
    assert.ok(repair.parseRepairableDraft(JSON.stringify(draft)));
    const context = repair.buildRepairContext(draft, [{ message: 'conceptBridges 必须包含 4-10 个术语组合解释' }], '原文');
    assert.equal(context.atomicOperation.kind, 'reorganize_existing_sections_v1');
    assert.deepEqual(context.targets.map(target => target.path), ['/sections']);
    const sections = structuredClone(draft.sections.slice(0, 18));
    sections[17].body += '\n\n### ' + draft.sections[18].heading + '\n\n' + draft.sections[18].body;
    const patch = { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{ path: '/sections', oldSha256: repair.hashDraft(draft.sections), value: sections }] };
    const merged = repair.applyReaderPatch(draft, patch, ['/sections'], { atomicOperation: context.atomicOperation });
    for (const field of ['conceptBridges','tableBindings','formulaBindings','figurePlacements','readerTitle','oneSentenceThesis']) assert.deepEqual(merged[field], draft[field]);
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(merged), { requiredVersion: 3 }), /conceptBridges.*4-10/);
    const next = repair.buildRepairContext(merged, [{ message: 'conceptBridges 必须包含 4-10 个术语组合解释' }], '原文');
    assert.equal(next.atomicOperation.kind, 'complete_existing_concept_bridges_v1');
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/sections']), /明确授权/);
    patch.replacements[0].value = draft.sections;
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/sections'], { atomicOperation: context.atomicOperation }), /12–18/);
});
test('正常生成的复合失败稿第二次仍为小节补丁，提示不要求同轮修未授权表和术语记录', async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const sample = createCompositeSample();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-composite-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0;
    await assert.rejects(deep.generateApiReaderArticleDetailed({ arxivId: '2609.99964', title: '复合失败恢复' }, '', '完整封存证据', {
        sourceText: sample.sourceDetails.text, structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory, readerMaxAttempts: 2, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async (messages, budget, options) => {
            if (++calls === 1) return JSON.stringify(sample.draft);
            assert.equal(options.usageContext.stage, 'apiReaderRepair');
            const prompt = messages[0].content[0].text;
            assert.match(prompt, /当前有 19 节/);
            assert.match(prompt, /不能为满足它们而原样返回超量小节/);
            assert.match(prompt, /replacements 只含一项，path 为 \/sections/);
            throw new Error('复合补丁请求已核验');
        }
    }), /复合补丁请求已核验/);
    assert.equal(calls, 2);
});
test('半稿、缺根、65节与类型破损不会获得小节重排许可', () => {
    for (const mutate of [draft => { delete draft.tableBindings; }, draft => { draft.sections[0] = null; }, draft => { draft.sections[0].body = 1; }, draft => { while (draft.sections.length < 65) draft.sections.push(draft.sections[0]); }]) {
        const sample = createCompositeSample();
        mutate(sample.draft);
        assert.equal(repair.parseRepairableDraft(sample.draft), null);
        assert.equal(repair.sectionReorganizationOperation(sample.draft), null);
    }
});

test('旧实现迁移的超节数少术语复合稿仍走受限重排，不退回全文或重置原账', async t => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const crypto = require('crypto');
    const direct = require('../scripts/lib/direct-rewrite-analysis-context');
    const sample = createCompositeSample();
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-concept-migration-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'reader-attempts');
    const paperId = '2609.99965';
    const paper = { arxivId: paperId, title: '复合原付费稿迁移' };
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
            assert.match(messages[0].content[0].text, /reorganize_existing_sections_v1/);
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

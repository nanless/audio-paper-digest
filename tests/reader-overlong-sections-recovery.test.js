'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const deep = require('../scripts/deep-analyzer');
const versions = require('../scripts/lib/prompt-text-versions');
function createReaderDraftSample(count) {
    return {
        version: 3,
        readerTitle: '完整来源约束下的小节恢复测试',
        oneSentenceThesis: '本次只重组已有文章的小节，全部正确事实、原始数字和其他来源记录保持不变，最后继续执行完整正文检查。',
        sections: Array.from({ length: count }, (_, index) => ({
            kind: 'component', heading: `方法组件${index + 1}`, body: `原始方法内容${index + 1}。`
        })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({
            terms: ['输入表示', '分类器'], sectionKind: 'component',
            marker: `[[CONCEPT_BRIDGE_${index + 1}]]`, explanation: '原始组合解释不得由结构恢复程序删除。'
        })),
        figurePlacements: [], tableBindings: [], formulaBindings: []
    };
}
function createSectionsPatch(draft, sections) {
    return { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{
        path: '/sections', oldSha256: repair.hashDraft(draft.sections), value: sections
    }] };
}
test('19至64节的完整失败稿可定位恢复，最终仍拒绝超过18节', () => {
    for (const count of [19, 37, 64]) {
        const draft = createReaderDraftSample(count);
        draft.sections[0].body_after = '额外说明必须保留给模型核对，不能自动删除。';
        const original = JSON.stringify(draft);
        const recovered = repair.parseRepairableDraft(original);
        assert.ok(recovered);
        assert.equal(JSON.stringify(recovered), original);
        const context = repair.buildRepairContext(recovered, [{ message: '小节数量错误' }], '完整原文证据');
        assert.deepEqual(context.targets.map(target => target.path), ['/sections']);
        assert.equal(context.atomicOperation.kind, 'reorganize_existing_sections_v1');
        assert.equal(context.targets[0].oldSha256, repair.hashDraft(draft.sections));
        assert.throws(() => deep.parseApiReaderArticleResult(original, { requiredVersion: 3 }), /12-18/);
    }
});
test('缺根、65节、异常对象和正文类型不完整仍不能作为恢复输入', () => {
    const tooMany = createReaderDraftSample(65);
    assert.equal(repair.parseRepairableDraft(tooMany), null);
    const missingRoot = createReaderDraftSample(19);
    delete missingRoot.formulaBindings;
    assert.equal(repair.parseRepairableDraft(missingRoot), null);
    for (const invalid of [null, [], { kind: 'component', heading: '标题', body: 1 }]) {
        const draft = createReaderDraftSample(19);
        draft.sections[0] = invalid;
        assert.equal(repair.parseRepairableDraft(draft), null);
    }
    assert.equal(repair.parseRepairableDraft('{"version":3'), null);
});
test('专用小节数组修复保护全部其他记录，缺授权与错误SHA不能修改', () => {
    const draft = createReaderDraftSample(19);
    const context = repair.buildRepairContext(draft, [{ message: '小节数量错误' }], '完整原文证据');
    const sections = structuredClone(draft.sections.slice(0, 18));
    sections[17].body += '\n\n#### ' + draft.sections[18].heading + '\n\n' + draft.sections[18].body;
    const patch = createSectionsPatch(draft, sections);
    const updated = repair.applyReaderPatch(draft, patch, ['/sections'], { atomicOperation: context.atomicOperation });
    assert.equal(updated.sections.length, 18);
    for (const field of ['readerTitle', 'oneSentenceThesis', 'conceptBridges', 'figurePlacements', 'tableBindings', 'formulaBindings']) {
        assert.deepEqual(updated[field], draft[field]);
    }
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/sections']), /明确授权/);
    assert.throws(() => repair.applyReaderPatch(draft, { ...patch, draftSha256: '0'.repeat(64) }, ['/sections'], { atomicOperation: context.atomicOperation }), /stale draft/);
    const wrongNode = structuredClone(patch);
    wrongNode.replacements[0].oldSha256 = '0'.repeat(64);
    assert.throws(() => repair.applyReaderPatch(draft, wrongNode, ['/sections'], { atomicOperation: context.atomicOperation }), /stale node/);
    for (const count of [11, 19, 65]) {
        assert.throws(() => repair.applyReaderPatch(draft, createSectionsPatch(draft, createReaderDraftSample(count).sections), ['/sections'], { atomicOperation: context.atomicOperation }), /12–18/);
    }
    const forged = { ...context.atomicOperation, maximumSections: 64 };
    assert.throws(() => repair.applyReaderPatch(draft, patch, ['/sections'], { atomicOperation: forged }), /本轮已授权/);
    const legalDraft = createReaderDraftSample(18);
    const legalContext = repair.buildRepairContext(legalDraft, [{ path: '/sections/0/body', message: '局部正文错误' }], '原文证据');
    assert.notEqual(legalContext.atomicOperation?.kind, 'reorganize_existing_sections_v1');
});
test('当前V12保留小节数组例外，旧V9正文与路径继续可复算', () => {
    assert.equal(versions.currentTextStagePromptPath('apiReaderRepair'), 'prompts/api-reader-repair-v13.md');
    assert.equal(versions.promptFilePathForContract('apiReaderRepair', 'analysis-prompt-text-v9'), 'prompts/api-reader-repair-v9.md');
    assert.equal(deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v9.md'), '5164ce17261a13a009c34bfcf8a71fc2c44f1ae2246f0651de5eda82a7645f65');
    assert.equal(deep.runtimePromptTemplateSha256('prompts/api-reader-repair-v10.md'), 'f50f85a04017de568f8225e97d7b4e230ae40b969d99266afcef045e011829a4');
});

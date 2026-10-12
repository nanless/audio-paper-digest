'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair.js');
function createSectionSample() {
    return { version: 3, readerTitle: '完整保留来源的小节重组', oneSentenceThesis: '保留全部来源事实。',
        sections: Array.from({ length: 21 }, (_, index) => ({ kind: 'component',
            heading: `模块说明 ${index}`, body: `依据原文说明模块 ${index} 的作用。` })),
        conceptBridges: Array.from({ length: 4 }, (_, index) => ({ terms: ['来源', '解释'], sectionKind: 'component', marker: `[[CONCEPT_BRIDGE_${index + 1}]]`, explanation: '按来源说明各部分分工。' })), figurePlacements: [], tableBindings: [], formulaBindings: [] };
}
function createPatch(sample, value) {
    return { version: 1, draftSha256: repair.hashDraft(sample), replacements: [{
        path: '/sections', oldSha256: repair.hashDraft(sample.sections), value }] };
}
test('重排专用请求给出实际节数与真实许可，不把其他诊断变成修改指令', () => {
    const sample = createSectionSample();
    const context = repair.buildRepairContext(sample, [{ path: '/tableBindings/0',
        message: '必须同步修改 tableBindings 并删除原表' }], '原文逐字证据：0.99。', '原文逐字证据：0.99。');
    const prompt = repair.buildSectionReorganizationPrompt({ context,
        mechanicalContract: '最终5000–18000中文字，12–18节', reviewFeedback: '原文结果0.99须保留。' });
    assert.match(prompt, /当前有 21 节，至少需要减少 3 节/);
    assert.match(prompt, /建议重组为 16 节/);
    assert.match(prompt, /kind、heading、body 三个字段/);
    assert.ok(prompt.includes(context.draftSha256));
    assert.ok(prompt.includes(context.targets[0].oldSha256));
    assert.ok(prompt.includes('原文逐字证据：0.99。'));
    assert.ok(prompt.includes('原文结果0.99须保留。'));
    assert.ok(!prompt.includes('必须同步修改 tableBindings 并删除原表'));
    assert.match(prompt, /其他已发现问题仅供后续检查/);
});
test('真实21节回复形状必须拒绝，16节仍只修改授权数组', () => {
    const sample = createSectionSample();
    const context = repair.buildRepairContext(sample, [], '', '');
    const options = { atomicOperation: context.atomicOperation };
    assert.throws(() => repair.applyReaderPatch(sample, createPatch(sample, sample.sections), ['/sections'], options), /返回 21 节/);
    const valid = sample.sections.slice(0, 16);
    const malformed = structuredClone(valid);
    malformed[0].table_note = '表格解释须放回正文。';
    assert.throws(() => repair.applyReaderPatch(sample, createPatch(sample, malformed), ['/sections'], options), /sections\[0\].*table_note/);
    const result = repair.applyReaderPatch(sample, createPatch(sample, valid), ['/sections'], options);
    assert.equal(result.sections.length, 16);
    for (const field of Object.keys(sample).filter(field => field !== 'sections')) {
        assert.deepEqual(result[field], sample[field]);
    }
    const unauthorized = createPatch(sample, valid);
    unauthorized.replacements.push({ path: '/readerTitle', oldSha256: repair.hashDraft(sample.readerTitle), value: '另改标题' });
    assert.throws(() => repair.applyReaderPatch(sample, unauthorized, ['/sections'], options), /未授权/);
});

test('真实生成入口在下一次请求使用专用重排指导而非其他记录修复命令', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const deep = require('../scripts/deep-analyzer.js');
    const sample = require('./reader-signed-draft-fixture.js').fixture();
    const overlong = structuredClone(sample.draft);
    // 本例只检查小节重排；无图清理的优先顺序由专门用例验证。
    overlong.figurePlacements = [];
    for (const section of overlong.sections) {
        section.body = section.body.split('\n\n').filter(paragraph =>
            !/\[\[FIGURE_\d+\]\]|看图|读图|图中|横轴|纵轴|颜色|热图|曲线|图注|图解|红色|蓝色|绿色/.test(paragraph)).join('\n\n');
    }
    overlong.sections.push(...Array.from({ length: 9 }, (_, index) => ({
        kind: 'component', heading: `补充机制 ${index}`, body: '按论文文字说明输入、组件分工和适用条件。'.repeat(8)
    })));
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-reorder-guidance-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const requests = [];
    await assert.rejects(deep.generateApiReaderArticleDetailed(sample.paper, '', '', {
        sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        reviewFeedback: '保留论文原文中已正确的比较条件。',
        readerAttemptsDir: directory, readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async messages => {
            requests.push(messages);
            return requests.length === 1 ? JSON.stringify(overlong) : '{}';
        }
    }));
    assert.equal(requests.length, 2);
    const text = requests[1][0].content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    assert.match(text, /当前有 21 节，至少需要减少 3 节/);
    assert.match(text, /本轮只重组小节，输出局部补丁 JSON/);
    assert.match(text, /kind 只能使用：background, related_work, problem, method_overview, component, training, experiment_setup, result, ablation, limitation, reproduction, synthesis/);
    assert.match(text, /必须覆盖：background, related_work, method_overview, training, experiment_setup, result, limitation, reproduction, synthesis/);
    assert.ok(text.includes('保留论文原文中已正确的比较条件。'));
    assert.ok(!text.includes('必须执行以下修复：先按正文顺序核对实际 Markdown 表'));
});

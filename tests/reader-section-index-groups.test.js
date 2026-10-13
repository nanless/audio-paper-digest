'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
function createSectionSample() {
    const draft = { version: 3, readerTitle: '同类教学段落重组', oneSentenceThesis: '保留全部事实。',
        sections: Array.from({ length: 20 }, (_, index) => ({ kind: 'component', heading: `原小节 ${index}`,
            body: `原段 ${index}：数值 ${index}.25 ms，不能修改。\n\n${index < 4 ? `[[TABLE_${index + 1}]]` : ''}` })),
        conceptBridges: [], figurePlacements: [], tableBindings: [{ tableIndex: 1, completeTable: { sourceTableOrdinal: 1 } }],
        formulaBindings: [{ formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }] };
    const context = repair.buildRepairContext(draft, [], '封存证据原字节', '封存证据原字节');
    const groups = [];
    for (let index = 0; index < 16; index += 2) groups.push({ sectionIndexes: [index, index + 1], heading: `合组 ${index}` });
    for (let index = 16; index < 20; index++) groups.push({ sectionIndexes: [index], heading: `原小节 ${index}` });
    const plan = { contract: repair.SECTION_GROUP_PLAN_CONTRACT, version: 1,
        draftSha256: context.draftSha256, sectionsSha256: context.targets[0].oldSha256, groups };
    return { draft, context, plan };
}
test('索引分组原样保留全部旧标题、正文、单位、标记及根级来源绑定', () => {
    const sample = createSectionSample(), frozen = JSON.stringify(sample.draft);
    assert.equal(sample.context.sectionGroupPlanContract, repair.SECTION_GROUP_PLAN_CONTRACT);
    const compiled = repair.compileSectionIndexGroupPlan(sample.draft, sample.plan, sample.context);
    const result = repair.applyReaderPatch(sample.draft, compiled.patch, ['/sections'], { atomicOperation: sample.context.atomicOperation });
    assert.equal(result.sections.length, 12);
    for (const [groupIndex, group] of sample.plan.groups.entries()) {
        for (const index of group.sectionIndexes) {
            assert.ok(result.sections[groupIndex].body.includes(sample.draft.sections[index].body));
            assert.ok(result.sections[groupIndex].heading === sample.draft.sections[index].heading
                || result.sections[groupIndex].body.includes(`#### ${sample.draft.sections[index].heading}\n\n`));
            assert.equal(result.sections[groupIndex].kind, sample.draft.sections[index].kind);
        }
    }
    for (const key of Object.keys(sample.draft).filter(key => key !== 'sections')) assert.deepEqual(result[key], sample.draft[key]);
    assert.equal(compiled.proof.inputDraftSha256, repair.hashDraft(sample.draft));
    assert.equal(compiled.proof.planSha256, repair.hashDraft(sample.plan));
    assert.equal(compiled.proof.outputSectionsSha256, repair.hashDraft(result.sections));
    assert.equal(JSON.stringify(sample.draft), frozen);
});
for (const [name, alter] of Object.entries({
    '旧根SHA': s => { s.plan.draftSha256 = 'a'.repeat(64); },
    '旧小节SHA': s => { s.plan.sectionsSha256 = 'a'.repeat(64); },
    '少组': s => { s.plan.groups.pop(); },
    '原样超量组': s => { s.plan.groups = s.draft.sections.map((_v, index) => ({ sectionIndexes: [index], heading: `原小节 ${index}` })); },
    '遗漏末节': s => { s.plan.groups.at(-1).sectionIndexes = [18]; },
    '重复索引': s => { s.plan.groups[0].sectionIndexes = [0, 0]; },
    '跳过索引': s => { s.plan.groups[0].sectionIndexes = [0, 2]; },
    '重排索引': s => { s.plan.groups[0].sectionIndexes = [1, 0]; },
    '越界': s => { s.plan.groups.at(-1).sectionIndexes = [20]; },
    '小数索引': s => { s.plan.groups[0].sectionIndexes = [0, 1.5]; },
    '跨类型合并': s => { s.draft.sections[1].kind = 'training'; s.context = repair.buildRepairContext(s.draft, [], '', ''); s.plan.draftSha256 = s.context.draftSha256; s.plan.sectionsSha256 = s.context.targets[0].oldSha256; },
    '新正文越权': s => { s.plan.groups[0].body = '修改原数字'; },
    '新类型越权': s => { s.plan.groups[0].kind = 'training'; },
    '标题插标记': s => { s.plan.groups[0].heading = '[[TABLE_9]]'; },
    '额外根字段': s => { s.plan.tableBindings = []; },
    '未授权协议': s => { delete s.context.sectionGroupPlanContract; },
    '额外原字段': s => { s.draft.sections[0].body2 = '位置不能推断'; },
    '原标题多行': s => { s.draft.sections[0].heading += '\n另一个标题'; }
})) test(`索引分组拒绝${name}`, () => {
    const sample = createSectionSample(); alter(sample);
    assert.throws(() => repair.compileSectionIndexGroupPlan(sample.draft, sample.plan, sample.context));
});
test('严格对象走小计划，未知字段仍走原完整重排且不改冻结提示文件', () => {
    const sample = createSectionSample();
    const prompt = repair.buildSectionReorganizationPrompt({ context: sample.context });
    assert.ok(prompt.includes(repair.SECTION_GROUP_PLAN_CONTRACT));
    assert.ok(prompt.includes('不能提交正文') || prompt.includes('不要回传body'));
    assert.ok(prompt.includes(sample.context.draftSha256));
    sample.draft.sections[0].body3 = '未知的续段';
    const fallback = repair.buildRepairContext(sample.draft, [], '', '');
    assert.equal(fallback.sectionGroupPlanContract, undefined);
    assert.ok(repair.buildSectionReorganizationPrompt({ context: fallback }).includes('value 为完整新数组'));
});

test('公开请求记录绑定索引协议与实现SHA，只用原两次额度并保存编译证明', async t => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const deep = require('../scripts/deep-analyzer');
    const sample = require('./reader-signed-draft-fixture').fixture({ noFigures: true });
    const overlong = structuredClone(sample.draft);
    overlong.sections.push(...Array.from({ length: 9 }, (_, index) => ({ kind: 'component',
        heading: `补充说明 ${index}`, body: '按原文保留组件分工、输入输出与适用条件。'.repeat(8) })));
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-index-plan-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0, requestRecord;
    const options = { sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts, readerAttemptsDir: directory,
        readerMaxAttempts: 2, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
        readerCallModel: async () => {
            calls += 1;
            if (calls === 1) return JSON.stringify(overlong);
            const requests = fs.readdirSync(path.join(directory, 'request-diagnostics')).filter(name => name.endsWith('.request.json'));
            requestRecord = JSON.parse(fs.readFileSync(path.join(directory, 'request-diagnostics', requests.at(-1))));
            const groups = [];
            requestRecord.draft.sections.forEach((section, index) => {
                if (index && section.kind === requestRecord.draft.sections[index - 1].kind) groups.at(-1).sectionIndexes.push(index);
                else groups.push({ sectionIndexes: [index], heading: section.heading });
            });
            while (groups.length < 13) {
                const index = groups.findIndex(group => group.sectionIndexes.length > 1);
                const group = groups[index];
                groups.splice(index, 1, { sectionIndexes: [group.sectionIndexes[0]], heading: group.heading },
                    { sectionIndexes: group.sectionIndexes.slice(1), heading: '补充组件说明' });
            }
            return JSON.stringify({ contract: repair.SECTION_GROUP_PLAN_CONTRACT, version: 1,
                draftSha256: requestRecord.draftSha256, sectionsSha256: requestRecord.repairTargets[0].oldSha256, groups });
        } };
    // 结构修复仍须经过后续完整校验；此测试不要求它替代其他论文质量修复。
    let caught, result;
    try { result = await deep.generateApiReaderArticleDetailed(sample.paper, '', '', options); } catch (error) { caught = error; }
    assert.equal(calls, 2);
    assert.equal(requestRecord.sectionGroupPlanContract, repair.SECTION_GROUP_PLAN_CONTRACT);
    assert.equal(requestRecord.identity.repairImplementationSha256,
        repair.shaText([
            '../scripts/lib/reader-repair.js',
            '../prompts/api-reader-concept-terms-v1.md',
            '../prompts/api-reader-repair-v11.md'
        ].map(file => fs.readFileSync(require.resolve(file), 'utf8')).join('\0')));
    const envelopes = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name =>
        JSON.parse(fs.readFileSync(path.join(directory, name)))).filter(item => item.payload?.draft);
    const proofs = result?.sectionGroupCompilations || [];
    assert.ok(proofs.some(proof => proof.contract === repair.SECTION_GROUP_PLAN_CONTRACT
        && proof.inputDraftSha256 === requestRecord.draftSha256), caught?.message);
    assert.ok(result?.plan?.sections?.length === 13 || envelopes.some(envelope => envelope.payload.draft.sections.length === 13));
    assert.ok(envelopes.every(envelope => envelope.payload.attempts <= 2));
});

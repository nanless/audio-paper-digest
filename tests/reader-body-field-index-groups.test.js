'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'),
    assert = require('node:assert/strict'),
    repair = require('../scripts/lib/reader-repair');
const real = require('./reader-body-field-real-06478.json');
function createBodyGroupSample() {
    const draft = structuredClone(real),
        context = repair.buildRepairContext(draft, [], '原封存证据');
    const groups = [];
    draft.sections.forEach((s, i) => {
        if (i && s.kind === draft.sections[i - 1].kind)
            groups.at(-1).sectionIndexes.push(i);
        else groups.push({ sectionIndexes: [i], heading: s.heading });
    });
    for (const g of groups)
        g.fieldOrders = g.sectionIndexes.map((i) => ({
            sectionIndex: i,
            fields: [
                'body',
                ...['body2', 'body_after'].filter((f) =>
                    Object.hasOwn(draft.sections[i], f),
                ),
            ],
        }));
    return {
        draft,
        context,
        plan: {
            contract: repair.SECTION_BODY_GROUP_PLAN_CONTRACT,
            version: 2,
            draftSha256: context.draftSha256,
            sectionsSha256: context.targets[0].oldSha256,
            groups,
        },
    };
}
test('真实06478十九节九续段显式引用合十三节，全部字段字节、marker、标题和来源数组保留', () => {
    const x = createBodyGroupSample(),
        before = repair.hashDraft(x.draft);
    assert.equal(
        x.context.sectionGroupPlanContract,
        repair.SECTION_BODY_GROUP_PLAN_CONTRACT,
    );
    assert.equal(repair.canUseSectionIndexGroups(x.draft), false);
    const compiled = repair.compileSectionIndexGroupPlan(
            x.draft,
            x.plan,
            x.context,
        ),
        out = repair.applyReaderPatch(x.draft, compiled.patch, ['/sections'], {
            atomicOperation: x.context.atomicOperation,
        });
    assert.equal(out.sections.length, 13);
    for (const [j, g] of x.plan.groups.entries())
        for (const i of g.sectionIndexes) {
            const original = x.draft.sections[i];
            for (const f of ['body', 'body2', 'body_after'])
                if (Object.hasOwn(original, f))
                    assert.ok(out.sections[j].body.includes(original[f]));
            assert.equal(out.sections[j].kind, original.kind);
            assert.ok(
                out.sections[j].heading === original.heading ||
                    out.sections[j].body.includes('#### ' + original.heading),
            );
        }
    for (const field of Object.keys(x.draft).filter((k) => k !== 'sections'))
        assert.deepEqual(out[field], x.draft[field]);
    assert.equal(repair.hashDraft(x.draft), before);
    assert.equal(compiled.proof.inputDraftSha256, before);
});
for (const [name, alter] of Object.entries({
    漏字段: (x) => x.plan.groups[3].fieldOrders[0].fields.pop(),
    重复字段: (x) =>
        (x.plan.groups[3].fieldOrders[0].fields = ['body', 'body']),
    新字段: (x) => (x.plan.groups[3].fieldOrders[0].fields = ['body', 'body3']),
    跨小节引用: (x) => (x.plan.groups[3].fieldOrders[0].sectionIndex = 4),
    漏组: (x) => x.plan.groups.pop(),
    跨kind: (x) => {
        x.plan.groups[0].sectionIndexes.push(1);
        x.plan.groups[0].fieldOrders.push(x.plan.groups[1].fieldOrders[0]);
        x.plan.groups.splice(1, 1);
    },
    旧SHA: (x) => (x.plan.draftSha256 = 'a'.repeat(64)),
    额外值: (x) => (x.plan.groups[0].fieldOrders[0].value = '新事实'),
}))
    test('原字段计划拒绝' + name, () => {
        const x = createBodyGroupSample();
        alter(x);
        assert.throws(() =>
            repair.compileSectionIndexGroupPlan(x.draft, x.plan, x.context),
        );
    });
test('空body2必须显式引用，未知字段/双续段/非字符串/倒序声明仍拒协议', () => {
    for (const mutate of [
        (d) => {
            d.sections[3].body3 = '未知';
        },
        (d) => {
            d.sections[3].body_after = '双续段';
        },
        (d) => {
            d.sections[3].body2 = 2;
        },
        (d) => {
            d.sections[3] = {
                kind: d.sections[3].kind,
                heading: d.sections[3].heading,
                body2: '先声明',
                body: d.sections[3].body,
            };
        },
    ]) {
        const d = structuredClone(real);
        mutate(d);
        assert.equal(repair.canUseBodyFieldIndexGroups(d), false);
    }
    const x = createBodyGroupSample();
    x.plan.groups[3].fieldOrders[0].fields = ['body'];
    assert.throws(() =>
        repair.compileSectionIndexGroupPlan(x.draft, x.plan, x.context),
    );
});
test('模型可显式选择同小节字段次序，不能改变任何内容', () => {
    const x = createBodyGroupSample();
    const g = x.plan.groups.find((g) => g.sectionIndexes.includes(4));
    g.fieldOrders.find((o) => o.sectionIndex === 4).fields.reverse();
    const out = repair.compileSectionIndexGroupPlan(x.draft, x.plan, x.context)
        .patch.replacements[0].value;
    const body = out[x.plan.groups.indexOf(g)].body;
    assert.ok(
        body.indexOf(x.draft.sections[4].body2) <
            body.indexOf(x.draft.sections[4].body),
    );
    const prompt = repair.buildSectionReorganizationPrompt({
        context: x.context,
    });
    assert.match(prompt, /不跨小节搬段|不能跨小节搬段/);
    assert.match(prompt, /本次真实图片/);
    assert.ok(prompt.includes(x.context.draftSha256));
});

test('公开生成器把续段计划绑定实际请求SHA和v2协议，不增加旧两次额度', async (t) => {
    const fs = require('node:fs'),
        path = require('node:path'),
        os = require('node:os');
    const deep = require('../scripts/deep-analyzer');
    const sample = require('./reader-signed-draft-fixture').fixture({
        noFigures: true,
    });
    const overlong = structuredClone(sample.draft);
    overlong.sections.push(
        ...Array.from({ length: 9 }, (_, index) => ({
            kind: 'component',
            heading: `补充说明 ${index}`,
            body: '按原文保留组件分工、输入输出与适用条件。'.repeat(8),
        })),
    );
    overlong.sections[0].body2 = ''; // 既有归一化拒绝空续段，仍须显式完整引用。
    const directory = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), 'reader-index-plan-'),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let calls = 0,
        requestRecord;
    const options = {
        sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerAttemptsDir: directory,
        readerMaxAttempts: 2,
        readerMaterializeFigures: async () => [],
        readerRecordDisposition: () => {},
        readerCallModel: async () => {
            calls += 1;
            if (calls === 1) return JSON.stringify(overlong);
            const requests = fs
                .readdirSync(path.join(directory, 'request-diagnostics'))
                .filter((name) => name.endsWith('.request.json'));
            requestRecord = JSON.parse(
                fs.readFileSync(
                    path.join(
                        directory,
                        'request-diagnostics',
                        requests.at(-1),
                    ),
                ),
            );
            const groups = [];
            requestRecord.draft.sections.forEach((section, index) => {
                if (
                    index &&
                    section.kind ===
                        requestRecord.draft.sections[index - 1].kind
                )
                    groups.at(-1).sectionIndexes.push(index);
                else
                    groups.push({
                        sectionIndexes: [index],
                        heading: section.heading,
                    });
            });
            while (groups.length < 13) {
                const index = groups.findIndex(
                    (group) => group.sectionIndexes.length > 1,
                );
                const group = groups[index];
                groups.splice(
                    index,
                    1,
                    {
                        sectionIndexes: [group.sectionIndexes[0]],
                        heading: group.heading,
                    },
                    {
                        sectionIndexes: group.sectionIndexes.slice(1),
                        heading: '补充组件说明',
                    },
                );
            }
            groups.forEach((group) => {
                group.fieldOrders = group.sectionIndexes.map(
                    (sectionIndex) => ({
                        sectionIndex,
                        fields: [
                            'body',
                            ...['body2', 'body_after'].filter((field) =>
                                Object.hasOwn(
                                    requestRecord.draft.sections[sectionIndex],
                                    field,
                                ),
                            ),
                        ],
                    }),
                );
            });
            return JSON.stringify({
                contract: repair.SECTION_BODY_GROUP_PLAN_CONTRACT,
                version: 2,
                draftSha256: requestRecord.draftSha256,
                sectionsSha256: requestRecord.repairTargets[0].oldSha256,
                groups,
            });
        },
    };
    // 结构修复仍须经过后续完整校验；此测试不要求它替代其他论文质量修复。
    let caught, result;
    try {
        result = await deep.generateApiReaderArticleDetailed(
            sample.paper,
            '',
            '',
            options,
        );
    } catch (error) {
        caught = error;
    }
    assert.equal(calls, 2);
    assert.equal(
        requestRecord.sectionGroupPlanContract,
        repair.SECTION_BODY_GROUP_PLAN_CONTRACT,
    );
    assert.equal(
        requestRecord.identity.repairImplementationSha256,
        repair.shaText(
            fs.readFileSync(
                require.resolve('../scripts/lib/reader-repair'),
                'utf8',
            ),
        ),
    );
    const envelopes = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name))))
        .filter((item) => item.payload?.draft);
    const proofs = result?.sectionGroupCompilations || [];
    assert.ok(
        proofs.some(
            (proof) =>
                proof.contract === repair.SECTION_BODY_GROUP_PLAN_CONTRACT &&
                proof.inputDraftSha256 === requestRecord.draftSha256,
        ),
        caught?.message,
    );
    assert.ok(
        result?.plan?.sections?.length === 13 ||
            envelopes.some(
                (envelope) => envelope.payload.draft.sections.length === 13,
            ),
    );
    assert.ok(envelopes.every((envelope) => envelope.payload.attempts <= 2));
});

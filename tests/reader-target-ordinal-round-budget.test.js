'use strict';
// 2026-11-09 日更两篇失败的回归固定：
//   2611.07485：反馈只列字段名不列类型，模型把 artifact_table 的 sourceTableOrdinal=1
//               照抄进 source_quotes 绑定，连续 6 次不改。
//   2611.06010：坏 JSON 稳定出现在 replacements 数组的闭合处（…3.466†"]}}}），
//               第一轮修复把上一轮的拒绝原因送进下一轮，本轮再把这一轮的目标数压到 1。
// 这里只固定「说明更具体」和「本轮目标更少」两件事：JSON 解析、合同头、令牌、
// 节点 SHA、条数与类型判定一条都没有放宽，也不自动修复坏 JSON。
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const ordinal = require('../scripts/lib/reader-target-ordinal-patch');
const deep = require('../scripts/deep-analyzer');
const { strictJson } = require('../scripts/lib/strict-json');

const guidance = '本轮只允许修改这些目标：["/tableBindings/2","/sections/11/body"]。'
    + '下面的诊断可能列出其他已发现问题，列出问题不代表授权修改。'
    + '只提交本轮允许目标，逐项使用请求给出的真实 oldSha256；其余问题留待下一轮重新核验并授权。';

test('a rejected JSON ACK shrinks the next round to one target', () => {
    assert.equal(ordinal.roundTargetLimit({ invalidAck: true }), 1);
    assert.equal(ordinal.roundTargetLimit({ invalidAck: false }), 8);
    assert.equal(ordinal.roundTargetLimit({}), 8);
    const context = {
        targets: [{ path: '/tableBindings/2' }, { path: '/sections/11/body' }],
        targetGuidance: guidance
    };
    const plan = ordinal.applyRoundTargetBudget(context, { limit: ordinal.roundTargetLimit({ invalidAck: true }) });
    assert.deepEqual(plan.kept, ['/tableBindings/2']);
    assert.deepEqual(plan.deferred, ['/sections/11/body']);
    // 只缩小本轮授权：清单换成真实子集，并明确其余目标顺延。
    assert.deepEqual(context.targets.map(target => target.path), ['/tableBindings/2']);
    assert.match(context.targetGuidance, /本轮只允许修改这些目标：\["\/tableBindings\/2"\]。/);
    assert.match(context.targetGuidance, /上一轮 ACK 不是有效 JSON，本轮只授权 1 个目标/);
    assert.match(context.targetGuidance, /其余 1 个目标留到下一轮重新核验后授权/);
    assert.ok(!context.targetGuidance.includes('/sections/11/body'));
});

test('without a rejected ACK the round keeps its full target list', () => {
    const context = {
        targets: [{ path: '/tableBindings/2' }, { path: '/sections/11/body' }],
        targetGuidance: guidance
    };
    const plan = ordinal.applyRoundTargetBudget(context, { limit: ordinal.roundTargetLimit({ invalidAck: false }) });
    assert.deepEqual(plan.deferred, []);
    assert.equal(context.targets.length, 2);
    assert.equal(context.targetGuidance, guidance);
});

test('the round planner always keeps at least one target and never exceeds the protocol cap', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ path: `/sections/${index}/body` }));
    assert.equal(ordinal.planRoundTargets(eight, { limit: 0 }).targets.length, 1);
    assert.equal(ordinal.planRoundTargets(eight, { limit: 99 }).targets.length, 8);
    assert.deepEqual(ordinal.planRoundTargets(eight, { limit: 3 }).kept,
        ['/sections/0/body', '/sections/1/body', '/sections/2/body']);
    assert.equal(ordinal.planRoundTargets([], { limit: 1 }).targets.length, 0);
    // 文案不在预期形态时不能丢信息：原样保留并追加本轮授权说明。
    const fallback = ordinal.roundTargetGuidance('自定义诊断', { targets: [{ path: '/a' }],
        kept: ['/a'], deferred: ['/b'] });
    assert.match(fallback, /^自定义诊断\n上一轮 ACK 不是有效 JSON/);
});

test('a broken ACK is still refused, now with the parser position and closing rule', () => {
    // 2611.06010 的原样形态：replacements 数组用 } 关闭。
    const broken = '{"contract":"reader-target-ordinal-patch","schemaFingerprint":"'
        + '334889bc92083a45f374ac667bbb4580aa703ae3a2ef7df1001e2df41e7cb84d","requestToken":"8b2aeb09b4bb1062",'
        + '"replacements":[{"targetOrdinal":1,"value":{"sourceQuotes":["3.466†"]}}},{"targetOrdinal":2,"value":"x"}]}';
    assert.throws(() => ordinal.parseAck(broken),
        /reader-target-ordinal-patch 的内容不是有效的 JSON（Expected ',' or ']' after array element in JSON at position \d+/);
    // 判定没有放宽：同一段文本不会因为多了位置说明而被接受，也没有任何自动修复。
    assert.throws(() => ordinal.parseAck(broken), Error);
    const tail = deep.readerPatchRejectionPromptTail('Reader patch rejected: reader-target-ordinal-patch 的内容不是有效的 JSON（…）',
        { ordinal: true });
    assert.match(tail, /replacements 数组只能以 \] 关闭/);
    assert.match(tail, /整段响应以 \]\} 结尾/);
    assert.match(tail, /未列出的目标留到下一轮/);
    // 非序号路径的文案必须逐字不变。
    assert.ok(!deep.readerPatchRejectionPromptTail('Reader patch rejected: x', { ordinal: false }).includes('replacements 数组'));
});

test('strictJson keeps refusing bad JSON and only adds the parser reason', () => {
    assert.throws(() => strictJson(Buffer.from('{"a":[1,2}'), 'reader-target-ordinal-patch'),
        /reader-target-ordinal-patch 的内容不是有效的 JSON（Expected ',' or ']' after array element in JSON at position 9/);
    assert.throws(() => strictJson(Buffer.from('{"a":1,"a":2}'), 'reader-target-ordinal-patch'),
        /JSON 中出现重复字段：a/);
    assert.deepEqual(strictJson(Buffer.from('{"a":1}'), 'reader-target-ordinal-patch'), { a: 1 });
});

test('the field-set feedback now carries a copyable source_quotes skeleton (2611.07485)', () => {
    // 这两条就是 07485 连续 6 次收到的诊断。
    const missing = new Error('读者文章 tableBindings[0] 缺少字段: sourceType, sourceTableOrdinal, cellBindings');
    const structure = new Error('读者文章 tableBindings[0] 正文 quote 绑定结构非法'
        + '（sourceTableOrdinal=1，source_quotes 必须为 null）');
    for (const error of [missing, structure]) {
        const feedback = deep.buildApiReaderValidationFeedback(error);
        assert.ok(feedback.includes(deep.SOURCE_QUOTES_BINDING_SKELETON), error.message);
    }
    const skeleton = deep.SOURCE_QUOTES_BINDING_SKELETON;
    // 只给字段名与类型，不给数据：四个字段形态必须逐字出现。
    assert.match(skeleton, /"sourceType":"source_quotes"/);
    assert.match(skeleton, /"sourceTableOrdinal":null/);
    assert.match(skeleton, /"cellBindings":\[\]/);
    assert.match(skeleton, /"sourceQuotes":\["全文逐字连续原句"\]/);
    assert.match(skeleton, /sourceTableOrdinal 只在 sourceType 为 "artifact_table" 时才是整数原表序号/);
    assert.match(skeleton, /不要照抄上一版 artifact_table 绑定里的 sourceTableOrdinal 或 cellBindings/);
    // 序号路径的提示词直接用 issue.message，骨架要单独注入且整轮只出现一次。
    const issues = [
        { message: 'tableBindings[0] 普通绑定必须且仅含 tableIndex/sourceType/sourceTableOrdinal/cellBindings/sourceQuotes' },
        { message: 'tableBindings[0] sourceType 只能为 source_quotes 或 artifact_table；selection 是独立互斥结构' }
    ];
    assert.equal(deep.readerSourceQuotesBindingSkeletonFeedback(issues), skeleton);
    assert.equal(deep.readerSourceQuotesBindingSkeletonFeedback([{ message: 'sections[3] 中文字数必须' }]), '');
    assert.equal(deep.readerSourceQuotesBindingSkeletonFeedback([]), '');
    assert.equal(deep.readerSourceQuotesBindingSkeletonFeedback(null), '');
});

test('the skeleton does not change any structural verdict', () => {
    // 骨架只出现在反馈里；真实校验仍然拒绝 sourceTableOrdinal=1 的 source_quotes 绑定。
    const repair = require('../scripts/lib/reader-repair');
    const draft = {
        contract: 'reader-draft', schemaFingerprint: 'x',
        sections: [{ kind: 'result', heading: '结果', body: '| a |\n|---|\n| 1 |' }],
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: 1,
            cellBindings: [], sourceQuotes: ['Table 1 shows 1'] }],
        conceptBridges: [], figurePlacements: [], formulaBindings: []
    };
    const issues = repair.collectDraftIssues(draft, { sourceText: 'Table 1 shows 1' });
    assert.ok(issues.some(issue => /source_quotes 结构非法：sourceTableOrdinal 必须为 null（当前为 1）/.test(issue.message)),
        JSON.stringify(issues));
});

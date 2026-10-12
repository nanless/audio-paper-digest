'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');

const claim = '此时端到端 Gemini 3.5 是开销可核算的起点。';
function createDraft(bodies) {
    return {
        sections: bodies.map((body) => ({
            kind: 'method_overview',
            heading: '方法',
            body,
        })),
    };
}
function targets(
    draft,
    issues = repair.verifiedReaderFactIssues(draft, [claim]),
) {
    return repair.buildRepairTargets(draft, issues, {
        readerFactLocalPaths: draft.sections.map(
            (_, index) => `/sections/${index}/body`,
        ),
    });
}

test('真实完整错误句只授权唯一正文，其他数字与标记留在原值中', () => {
    const draft = createDraft([
        `前文11.97 PFLOPs。${claim}\n[[TABLE_1]]`,
        '正常正文',
    ]);
    const before = JSON.stringify(draft);
    const result = targets(draft);
    assert.deepEqual(
        result.map((value) => value.path),
        ['/sections/0/body'],
    );
    assert.equal(result[0].value, draft.sections[0].body);
    assert.equal(JSON.stringify(draft), before);
});

test('同正文重复、跨正文重复及短关键词不能授权', () => {
    assert.deepEqual(targets(createDraft([claim + claim])), []);
    assert.deepEqual(targets(createDraft([claim, claim])), []);
    assert.deepEqual(
        repair.verifiedReaderFactIssues(createDraft(['Gemini']), ['Gemini']),
        [],
    );
});

test('来源引文、绑定元数据、引用和代码不授权正文纠错', () => {
    const draft = createDraft([`> ${claim}\n\n\`\`\`\n${claim}\n\`\`\``]);
    draft.tableBindings = [{ sourceQuotes: [claim] }];
    assert.deepEqual(targets(draft), []);
    for (const body of [
        `\`${claim}\``,
        `$${claim}$`,
        `\\[${claim}\\]`,
        `“${claim}”`,
        `| 原文 |\n|---|\n| ${claim} |`,
    ]) {
        assert.deepEqual(targets(createDraft([body])), []);
    }
    const parts = [claim.slice(0, 8), claim.slice(8)];
    assert.deepEqual(
        targets(createDraft([`${parts[0]}\`源引文\`${parts[1]}`])),
        [],
    );
});

test('错误索引、过时原句或混合单元格诊断必须停止而不扩大', () => {
    const draft = createDraft([claim, '正常正文']);
    const issue = repair.verifiedReaderFactIssues(draft, [claim])[0];
    assert.deepEqual(
        targets(draft, [{ ...issue, path: '/sections/1/body' }]),
        [],
    );
    assert.deepEqual(targets(createDraft(['已纠正', '正常正文']), [issue]), []);
    assert.deepEqual(
        targets(draft, [
            issue,
            { path: '/tableBindings/0', code: 'reader_table_cell' },
        ]),
        [],
    );
});

test('八个完整正文目标可修，九个不得截断漏掉事实', () => {
    for (const size of [8, 9]) {
        const claims = Array.from(
            { length: size },
            (_, index) => `${claim}错误条件编号${index}。`,
        );
        const draft = createDraft(claims);
        const issues = repair.verifiedReaderFactIssues(draft, claims);
        assert.equal(targets(draft, issues).length, size === 8 ? 8 : 0);
    }
});

test('补丁只能替换授权原句，句外数字、空白与标记逐字保持', () => {
    const draft = createDraft([
        `前文11.97 PFLOPs。\n\n${claim}\n\n[[TABLE_1]]\n后文条件不变。`,
    ]);
    const target = targets(draft)[0];
    const corrected = draft.sections[0].body.replace(
        claim,
        '论文未报告闭源模型的计算成本。',
    );
    const apply = (value) =>
        repair.applyReaderPatch(
            draft,
            {
                version: 1,
                draftSha256: repair.hashDraft(draft),
                replacements: [
                    { path: target.path, oldSha256: target.oldSha256, value },
                ],
            },
            [target.path],
            {
                readerFactLocalClaims: {
                    [target.path]: target.authorizedClaims,
                },
            },
        );
    assert.equal(apply(corrected).sections[0].body, corrected);
    for (const value of [
        corrected.replace('11.97', '12.0'),
        corrected.replace('[[TABLE_1]]', ''),
        corrected.replace('\n\n', '\n'),
        corrected + '\n新增结论',
        corrected.replace('论文未报告闭源模型的计算成本。', '[[TABLE_2]]'),
    ]) {
        assert.throws(() => apply(value), /错误原句以外|引入图表/);
    }
});


test('普通绝对值和伪表不遮掉真实完整原句，合法表块仍保护', () => {
    for (const prefix of ['bf16 的 |Δp| 噪声。', '普通 | 分隔符。', '| 非表头 |\n没有分隔行\n']) {
        assert.deepEqual(targets(createDraft([prefix + claim])).map(value => value.path), ['/sections/0/body']);
    }
    for (const body of [
        `| 原文 | 数值 |\n|---|---|\n| ${claim} | 1 |`,
        `列头 | 数值\n--- | ---\n${claim} | 1`,
    ]) assert.deepEqual(targets(createDraft([body])), []);
});

test('02638 两段完整原句均获唯一目标，原绝对值和表内容不改', () => {
    const claims = [
        '内容理解上，B 在 qa100 接近转录上界，但 ZJU-ML 低于已发布 Whisper 连接器，且四任务混合在 ZJU-ML 真实录音事实半部分掉 16–17 点，这一代价未被混合目标解决。',
        '还需要补的验证有 3 类：一是流式输入与固定时钟部署的实际延迟与误判率，论文明确未评测；二是 ZJU-ML 真实录音事实题在混合训练下 16–17 点下滑的缓解办法，混合目标未解决这一漂移。',
    ];
    const draft = createDraft(Array.from({ length: 15 }, () => '正常正文'));
    draft.sections[12].body = 'bf16 下有 0.01–0.02 的|Δp|噪声，不能声称逐 bit 相同。' + claims[0];
    draft.sections[14].body = claims[1];
    const before = JSON.stringify(draft);
    const issues = repair.verifiedReaderFactIssues(draft, claims);
    assert.deepEqual(issues.map(issue => issue.path), ['/sections/12/body', '/sections/14/body']);
    assert.equal(JSON.stringify(draft), before);
});

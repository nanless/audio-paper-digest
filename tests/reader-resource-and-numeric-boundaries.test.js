'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const resources = require('../scripts/lib/reader-resource-binding');
const editorial = require('../scripts/editorial-quality');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceText = 'This controlled fixture makes no author resource release claim.';
const identityBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
const identity = { ...identityBody, identitySha256: deep.stableFingerprint(identityBody) };
function issues(text) {
    const draft = { sections: [{ kind: 'reproduction', body: text }] };
    const before = JSON.stringify(draft);
    const result = deep.readerResourceClaimIssues(draft, identity, sourceText);
    assert.equal(JSON.stringify(draft), before, '只读校验不得修改正文');
    return result;
}

test('真实失败否定句不成为作者资源肯定声明', () => {
    for (const text of [
        '复现应从作者提供的第三方链接开始，本文证据显示该链接当前可达，但它在原文中是第三方资源记录，不能直接写成作者已开源或权重可下载，需要自己打开确认代码、权重与运行脚本是否齐全。',
        '来源方面，本次未能确认作者已公开代码、模型或数据，现有证据不足以说明资源当前可用；',
        '未能确认本文模型权重已公开。',
        '不能据此直接写成本文模型权重已开源。'
    ]) assert.deepEqual(issues(text), [], text);
});

test('否定作用域终止于转折，后面的真正资源肯定仍须拒绝', () => {
    for (const text of [
        '不能直接写成作者已开源或权重可下载，但事实上本文模型权重已经公开。',
        '未能确认本文模型权重已公开但事实上本文模型权重已经开源。',
        '未能确认本文代码已公开，不过本文模型权重现已公开并可下载。',
        '不能直接写成作者已开源，然而本文代码已经公开。',
        '未发现证据否定本文模型权重已经开源。',
        '不但本文模型权重已开源，而且当前可用。',
        '本文模型权重现已公开并可下载。'
    ]) assert.ok(issues(text).length > 0, text);
});

const url = 'https://github.com/CPJKU/explore_this';
const declaration = `We share our code and invite others to explore this.11\n 1\n ${url}`;
test('作者share代码句跨脚注绑定同一仓库，返回精确声明而非后续Related work', () => {
    const source = declaration + '\n2 Related work\nMultiple proposals follow framewise probabilities.';
    assert.deepEqual(resources.paperSourceResourceFacets(source, url), ['code']);
    assert.equal(resources.paperSourceResourceQuote(source, url), declaration);
    assert.equal(resources.resourceClassificationIsCurrent({ origin: 'paper_source', type: 'third_party', originalUrl: url }, source), false);
    for (const statement of ['We share our code.', 'We share our source code.',
        'We share our code and invite others to reproduce the method.']) {
        const source = `${statement}11\n 1\n ${url}`;
        assert.deepEqual(resources.paperSourceResourceFacets(source, url), ['code']);
    }
    const unrelatedDefinition = 'The technical definition describes a metric subdivision. ' + 'Unrelated method detail. '.repeat(20);
    assert.deepEqual(resources.paperSourceResourceFacets(unrelatedDefinition + declaration, url), ['code']);
});

test('share声明的引用、未来、否定、另属、双链接仍不授权作者代码身份', () => {
    for (const source of [
        `We quote this statement:\n\n${declaration}`,
        `This definition contains the statement:\n${declaration}`,
        `Other authors wrote the following:\n\n${declaration}`,
        `> ${declaration}`,
        `\`\`\`text\n${declaration}\n\`\`\``,
        declaration.replace('We share', 'We will share'),
        declaration.replace('We share', 'We do not share'),
        declaration.replace('our code', 'their code'),
        `${declaration}\nOur code is not released.`,
        `${declaration}\nOur code remains confidential.`,
        `${declaration}\nOur code belongs to another author.`,
        declaration.replace(url, `https://github.com/other/first and ${url}`),
        `We use the code shared by other authors at ${url}.`
    ]) assert.deepEqual(resources.paperSourceResourceFacets(source, url), ['third_party'], source);
});

test('两对零点是反共振术语，数字归一后也不误读为比分', () => {
    for (const text of [
        '该表显示两对零点在鼻音上都更深，第一对频率随部位后移而上升。',
        '该表显示 2 对零点在鼻音上都更深，第一对频率随部位后移而上升。',
        '滤波器使用 2 对零点产生反共振。'
    ]) assert.deepEqual(editorial.findMissingComparisonUnits(text), [], text);
    const original = '该表显示两对零点在鼻音上都更深，第一对频率随部位后移而上升。';
    const normalized = deep.normalizeReaderProseFormatting(original,
        [{ code: 'quantitative_chinese_numeral', match: '两对' }]);
    assert.deepEqual(editorial.findMissingComparisonUnits(normalized), []);
    for (const text of [
        '准确率 2 对零点。',
        '得分 2 对 0 点，滤波器的设置不影响这个比较。',
        '比分 2 对零点，鼻音实验仍采用相同协议。',
        '准确率 64 对 4 分',
        'WER 从 43 到 10,288 降低。'
    ]) assert.ok(editorial.findMissingComparisonUnits(text).length > 0, text);
});

test('mW排版契约与数学斜体诊断一致，只补已报告数值的单位边界', () => {
    assert.ok(editorial.findNumericTypographyDefects('1mW').some(issue => issue.match === '1mW'));
    assert.deepEqual(editorial.findNumericTypographyDefects('1 mW'), []);
    assert.deepEqual(editorial.findNumericTypographyDefects('光输入 1 mW 的紧凑型情形。'), []);
    const body = '| 情形 | 光功率 |\n| --- | --- |\n| 紧凑 | 𝐿0 = 1𝑚𝑊 |';
    const draft = { sections: [{ body }], tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes' }] };
    const reported = editorial.findNumericTypographyDefects(body);
    assert.ok(reported.some(issue => issue.match === '1mW'));
    assert.equal(deep.normalizeIssueBoundReaderNumericTypography(draft, reported.map(issue => ({ ...issue, code: 'numeric_typography' }))), true);
    assert.equal(draft.sections[0].body, body.replace('1𝑚𝑊', '1 𝑚𝑊'));
    assert.deepEqual(editorial.findNumericTypographyDefects(draft.sections[0].body), []);
    const otherValue = { sections: [{ body: '1𝑚𝑊；2𝑚𝑊；3e-7；3e-7mW' }] };
    deep.normalizeIssueBoundReaderNumericTypography(otherValue, [{ code: 'numeric_typography', match: '1mW' }]);
    assert.equal(otherValue.sections[0].body, '1 𝑚𝑊；2𝑚𝑊；3e-7；3e-7mW');
    const followedByHan = { sections: [{ body: '取 1𝑚𝑊功耗' }] };
    deep.normalizeIssueBoundReaderNumericTypography(followedByHan, [{ code: 'numeric_typography', match: '1mW' }]);
    assert.equal(followedByHan.sections[0].body, '取 1 𝑚𝑊功耗');
    for (const body of ['`1𝑚𝑊`', '$1𝑚𝑊$', '> 1𝑚𝑊', '<code>1𝑚𝑊</code>',
        '```text\n1𝑚𝑊\n```']) {
        const protectedDraft = { sections: [{ body }] };
        assert.equal(deep.normalizeIssueBoundReaderNumericTypography(protectedDraft,
            [{ code: 'numeric_typography', match: '1mW' }]), false, body);
        assert.equal(protectedDraft.sections[0].body, body);
    }
    const sourceTable = { sections: [{ body }], tableBindings: [{ tableIndex: 1, selection: { sourceTableOrdinal: 1 } }] };
    assert.equal(deep.normalizeIssueBoundReaderNumericTypography(sourceTable,
        [{ code: 'numeric_typography', match: '1mW' }]), false);
    assert.equal(sourceTable.sections[0].body, body);
});


test('不同主张的显式列表只豁免列表字节，不豁免前后真正肯定', () => {
    const distinction = '复现要先分清三件事：论文提到地址、权重可下载、系统可运行是不同的主张。';
    assert.deepEqual(issues(distinction), []);
    assert.deepEqual(issues('需要分清两件事：权重可下载、系统可运行是独立的主张。'), []);
    for (const text of [
        '本文模型权重已经公开。' + distinction,
        distinction + '本文模型权重已经公开。',
        distinction.replace('。', '，但事实上本文模型权重已经公开。'),
        '复现要先分清三件事：论文提到地址、本文权重可下载、系统可运行是不同的主张。',
        '复现要先分清三件事：论文提到地址、权重已公开、系统可运行是不同的主张。',
        '权重可下载、系统可运行；它们是不同的主张。'
    ]) assert.ok(issues(text).length > 0, text);
});

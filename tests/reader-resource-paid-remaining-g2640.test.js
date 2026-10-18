'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const fixture = require('./fixtures/reader-resource-paid-remaining-g2640.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function issues(text, sourceText = 'No release evidence.') {
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
    return deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] },
        { ...body, identitySha256: deep.stableFingerprint(body) }, sourceText);
}

test('八篇实际来源/原付费稿精确重验，七篇误报修复而Liu作者肯定仍拒绝', () => {
    for (const row of fixture.cases) {
        const before = JSON.stringify(row);
        assert.equal(sha(row.sourceText), row.resourceIdentity.sourceTextSha256);
        assert.equal(sha(JSON.stringify(row.draft)), row.provenance.draftSha256);
        const actual = deep.readerResourceClaimIssues(row.draft, row.resourceIdentity, row.sourceText);
        assert.deepEqual(actual.map(issue => /本文 (\w+) /.exec(issue.message)?.[1]), row.expectedResourceIssues, row.name);
        if (row.name === 'liu26m') assert.match(actual[0].conflictExcerpt, /作者已开源/);
        assert.equal(JSON.stringify(row), before);
    }
});

test('数据获取、模型下载与系统安装仍是有界无归属概念，不能隐藏所有权或真肯定', () => {
    const lists = ['代码可运行、权重可下载与数据可获取是三件不同的事',
        '代码可运行、模型可下载、系统可安装是三件不同的事'];
    for (const list of lists) {
        assert.deepEqual(issues(list + '，需要分别确认。'), []);
        for (const text of ['本文' + list + '。', list + '，三者均已公开可用。',
            '“' + list + '”这个说法是错误的。', list + '，上述区分已经被撤销。',
            list + '，但本文代码已开源。', list + '；它们均已公开可用。']) {
            assert.ok(issues(text).length, text);
        }
    }
    for (const text of ['模型可下载、权重可下载、数据可获取是三件不同的事。',
        '代码可运行、权重可下载、数据可获取是两件不同的事。',
        '代码可运行、权重可下载和作者已开源是三件不同的事。',
        '不能否认代码可运行、权重可下载、数据可获取。']) assert.ok(issues(text).length, text);
});

test('官方权重的有界否定与被动未确认不是当前发布，反驳/双否/转折不能免责', () => {
    const denied = '不能据此断定作者官方权重已公开或可一键运行。';
    const passive = '论文脚注中的仓库链接在本次证据中未被确认为可用。';
    assert.deepEqual(issues(denied), []);
    assert.deepEqual(issues(passive), []);
    for (const text of ['不能否认作者官方权重已公开。',
        denied + '但本文模型权重当前可下载。',
        '不能据此断定作者官方权重已公开这一说法是错误的。',
        '并非仓库链接在本次证据中未被确认为可用。',
        passive.replace('。', '这一说法是错误的。'),
        passive.replace('。', '，但本文代码已经公开。'),
        '“仓库链接在本次证据中未被确认为可用”是错误说法。']) assert.ok(issues(text).length, text);
});

test('样本时长与不可获取的public分类不是作者资源可下载声明', () => {
    const duration = '这是某一数据集中单性别可用数据的最大时长。';
    const classification = '原文还提到部分标为公开的数据集实际上通过所给链接无法获取或只部分发布。';
    assert.deepEqual(issues(duration), []);
    assert.deepEqual(issues(classification), []);
    for (const text of [duration + '本文数据集当前可下载。',
        classification + '但本文数据集已经公开。',
        '不能否认本文数据集当前可用。',
        '本文数据集当前可下载，' + duration,
        '本文代码已开源，' + classification]) assert.ok(issues(text).length, text);
});

test('既有语料复现输入绑定真实同名数据/预处理信号/录音，不能靠公开二字泛放行', () => {
    const row = fixture.cases.find(row => row.name === 'maghsoudi26');
    const input = '复现应从公开VocalMind数据集的已发布预处理信号和出声录音出发。';
    assert.deepEqual(issues(input, row.sourceText), []);
    for (const text of ['本文数据集当前可下载。' + input, input + '但本文数据集已公开。',
        '“' + input.slice(0, -1) + '”这一说法是错误的。',
        input.replace('VocalMind', 'OtherCorpus')]) assert.ok(issues(text, row.sourceText).length, text);
    for (const source of ['No release evidence.',
        row.sourceText.replace('We used the publicly available', 'We did not use the publicly available'),
        row.sourceText.replace('We used the publicly available', 'If approved, we used the publicly available'),
        row.sourceText.replace('We used the published preprocessed', 'We might use preprocessed'),
        row.sourceText.replace('provided vocalized', 'withheld vocalized'),
        row.sourceText.replace('VocalMind dataset [15]', 'OtherCorpus dataset [15]')]) {
        assert.ok(issues(input, source).length, 'missing or wrong original input must fail');
    }
});

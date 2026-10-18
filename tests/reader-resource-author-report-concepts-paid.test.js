'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const fixture = require('./fixtures/reader-resource-author-report-concepts-paid-20261018.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const report = '预训练权重在正文中称已提供，但本次没有收到可验证的下载地址，复现时应以论文附录和官方渠道为准。';
const concepts = '应把代码可下载、权重可下载和系统可运行分开看，缺一项就按缺失处理，不要从模型名称猜实现细节。';
const source = 'To facilitate reproducibility, we provide pretrained weights and a web-based demo.';
function issues(text, sourceText = source) {
    const identity = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
    identity.identitySha256 = deep.stableFingerprint(identity);
    return deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] }, identity, sourceText);
}
const modelIssue = text => issues(text).some(issue => /本文 model /.test(issue.message));

test('两份真实付费候选按实际完整来源与资源身份重验，无需改稿或增加请求', () => {
    for (const row of fixture.cases) {
        const before = JSON.stringify(row);
        assert.equal(sha(row.sourceText), row.resourceIdentity.sourceTextSha256);
        assert.equal(sha(JSON.stringify(row.draft)), row.provenance.candidateDraftSha256);
        assert.equal(row.provenance.attempts, 2);
        assert.equal(row.provenance.fullAttempts, 1);
        assert.deepEqual(deep.readerResourceClaimIssues(row.draft, row.resourceIdentity, row.sourceText), [], row.name);
        assert.equal(JSON.stringify(row), before);
    }
});

test('作者主动提供和资源前置的原文转述必须同时有本次不可核限定', () => {
    assert.deepEqual(issues(report), []);
    assert.deepEqual(issues(report, 'We release pretrained weights.'), []);
    assert.deepEqual(issues(report.replace('本次没有收到可验证的下载地址', '本次未收到可核验的下载链接')), []);
    for (const text of [report.split('，')[0] + '。',
        '预训练权重已提供，本次没有收到可验证的下载地址。',
        '本文预训练权重已经公开。' + report,
        report + '本文模型权重现已公开并可下载。',
        report.replace('复现时应以论文附录和官方渠道为准', '但本文权重现在可下载')]) {
        assert.ok(modelIssue(text), text);
    }
});

test('作者原文证据拒绝缺失、异类型、第三方、假设、将来、否定和转述', () => {
    for (const invalid of [
        'No author release statement is available.', 'We provide source code.',
        'The third-party authors provide pretrained weights.',
        'We provide pretrained weights from a third-party baseline.',
        'We use existing models and provide pretrained weights.',
        'If approved, we provide pretrained weights.',
        'We will provide pretrained weights.', 'We plan to provide pretrained weights.',
        'We do not provide pretrained weights.', 'We never provide pretrained weights.',
        'The authors claim that we provide pretrained weights.',
        'The paper quotes "We provide pretrained weights" as an unsupported claim.',
        'We provide pretrained weights. This claim is false.'
    ]) assert.ok(issues(report, invalid).some(issue => /本文 model /.test(issue.message)), invalid);
});

test('不可核限定被引用、双重否定、反驳或撤销时不豁免原发布声明', () => {
    for (const text of [
        report.replace('本次没有收到', '本次并非没有收到'),
        report.replace('本次没有收到', '本次所谓没有收到'),
        report.replace('复现时应以论文附录和官方渠道为准', '这一说法是错误的'),
        report.replace('复现时应以论文附录和官方渠道为准', '并不能否认权重当前可下载'),
        report.replace('本次没有收到可验证的下载地址', '本次“没有收到可验证的下载地址”')
    ]) assert.ok(modelIssue(text), text);
});

test('普通并列的无归属两三项资源概念只豁免列表字节', () => {
    for (const text of [concepts,
        '应把代码可下载和权重可下载分开看。',
        '复现时应把代码可下载、权重可下载和系统可运行分开核对。'
    ]) assert.deepEqual(issues(text), [], text);
    for (const text of [
        '本文' + concepts, concepts.replace('代码可下载', '本文代码可下载'),
        '作者拥有的' + concepts, '“' + concepts + '”这个说法是错误的。',
        '不应把代码可下载、权重可下载和系统可运行分开看。',
        concepts.replace('缺一项就按缺失处理', '但本文代码已经开源'),
        concepts + '本文模型权重已经公开。',
        concepts.replace('缺一项就按缺失处理', '三者均已公开可用'),
        concepts.replace('缺一项就按缺失处理', '上述区分已经被撤销'),
        '不能否认本文代码可下载、权重可下载和系统可运行。',
        '不能否认代码可下载、权重可下载和系统可运行。',
        '应把第三方代码可下载与本文权重可下载分开看。'
    ]) assert.ok(issues(text).length, text);
});

test('省略归属的明确双否仍检查资源证据，不误拦明确缺失与合法概念区分', () => {
    for (const text of ['不能否认代码可下载。', '无法否认权重可下载。',
        '不能否认代码可下载，但权重仍需核实。',
        concepts + '不能否认权重可下载。'
    ]) assert.ok(issues(text).length, text);
    for (const text of ['不能否认没有代码可下载。', '无法否认权重尚未公开。', concepts]) {
        assert.deepEqual(issues(text), [], text);
    }
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(source), resources: [{
        type: 'code', origin: 'validated_demo', originalUrl: 'https://example.org/source',
        finalUrl: 'https://example.org/source', redirects: [], status: 200, availability: 'available',
        sourceQuote: 'Code resource', sourceQuoteSha256: sha('Code resource')
    }] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    assert.deepEqual(deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction',
        body: '不能否认代码可下载。' }] }, identity, source), []);
});

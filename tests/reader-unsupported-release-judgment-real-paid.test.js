'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const fixture = require('./fixtures/reader-lee-g2694-real-paid.json');
const shin = require('./fixtures/reader-shin-g2694-real-paid.json');
const issues = text => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] },
    fixture.resourceIdentity, fixture.sourceText);
const denial = '不支持已提供完整训练代码的判断';
test('真实已付 Lee 全稿明确否定提供训练代码，实际仅演示页第三方可达', () => {
    assert.equal(crypto.createHash('sha256').update(fixture.sourceText).digest('hex'), fixture.sourceTextSha256);
    assert(fixture.sourceText.includes('Audio demos: https://ml-sp.github.io/DroFiT/'));
    assert.deepEqual(fixture.resourceIdentity.resources.map(x => [x.type, x.availability]), [['third_party', 'available']]);
    assert(fixture.draft.sections[13].body.includes(denial));
    assert.deepEqual(deep.readerResourceClaimIssues(fixture.draft, fixture.resourceIdentity, fixture.sourceText), []);
    assert.deepEqual(issues('本篇证据只支持演示页可访问，' + denial + '，复现时应按无现成仓库来规划。'), []);
    assert.deepEqual(issues('现有证据' + denial + '。'), []);
});
test('真实 Shin 完整付费稿只确认代码，待核实的权重/系统列表后可接闭合的不等同说明', () => {
    assert.equal(crypto.createHash('sha256').update(shin.sourceText).digest('hex'), shin.sourceTextSha256);
    assert(shin.sourceText.includes('https://github.com/argaaw/TRUST-TSE'));
    assert.deepEqual(shin.resourceIdentity.resources.map(x => [x.type, x.availability]), [['code', 'available']]);
    assert.deepEqual(deep.readerResourceClaimIssues(shin.draft, shin.resourceIdentity, shin.sourceText), []);
    const check = text => deep.readerResourceClaimIssues({ sections: [{ body: text }] }, shin.resourceIdentity, shin.sourceText);
    const pending = '权重可下载与系统可运行需要另行确认';
    const distinction = '不能把代码可用等同于开箱即用';
    assert.deepEqual(check(pending + '，' + distinction + '。'), []);
    for (const text of [pending + '，本文权重已公开。', pending + '，' + distinction + '，本文权重已公开。',
        pending + '，' + distinction + '。本文权重已公开。', pending + '，这一说法不成立。',
        pending + '，这一判断已被撤回。', '“' + pending + '”不成立，本文权重可下载。',
        '本文权重可下载与系统可运行需要另行确认，' + distinction + '。']) {
        assert(check(text).some(issue => issue.message.includes('model')), text);
    }
});
test('闭合否定不吞真实发布、相邻其它资源、引述、转折、双重否定或撤回', () => {
    for (const text of [
        '本文已提供完整训练代码。', '本文代码已开源。',
        denial + '，但本文代码已开源。', denial + '，本文权重可下载。',
        '并非' + denial + '。', '不能说' + denial + '。',
        '“' + denial + '”是错误的，本文代码已开源。',
        denial + '不成立。', denial + '已被撤回。',
        denial + '，这一判断已被推翻。',
        '不支持 Windows 但本文已提供完整训练代码。',
        '不支持作者已提供完整训练代码但本文代码已开源的判断。'
    ]) assert(issues(text).length > 0, text);
});

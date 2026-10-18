'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const saved = require('./fixtures/reader-resource-paid-tail-20261018.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const wrap = body => ({ sections: [{ kind: 'reproduction', body }] });
const check = (name, body, identity) => {
    const record = saved.cases.find(item => item.name === name);
    return deep.readerResourceClaimIssues(wrap(body), identity || record.resourceIdentity, record.sourceText);
};

test('three actual saved paid drafts retain original source/resource identities and exact paid section bytes', () => {
    for (const record of saved.cases) {
        const before = JSON.stringify(record);
        assert.equal(sha(record.sourceText), record.sealedSourceSha256);
        assert.equal(record.resourceIdentity.sourceTextSha256, record.sealedSourceSha256);
        assert.equal(record.draft.sections[record.sectionIndex].body, record.body);
        for (const response of record.paidResponses) assert.equal(sha(response.rawResponse), response.outputTextSha256);
        assert.ok(record.paidResponses.some(response => response.rawResponse.includes(JSON.stringify(record.body).slice(1, -1))), record.paperId);
        assert.deepEqual(deep.readerResourceClaimIssues(record.draft, record.resourceIdentity, record.sourceText), [], record.paperId);
        assert.deepEqual(check(record.name, record.body), [], record.paperId);
        assert.equal(JSON.stringify(record), before);
    }
    assert.ok(saved.cases.find(item => item.name === 'ryu').resourceIdentity.resources.length === 0);
    for (const name of ['bhosale', 'zhang']) assert.ok(saved.cases.find(item => item.name === name)
        .resourceIdentity.resources.every(resource => resource.type === 'third_party' && resource.availability === 'available'));
});

test('closed verification list covers only distinct unowned concepts, never real releases or revoked distinctions', () => {
    const concept = '复现时应把代码可达、权重可下载和系统可运行当作三件独立的事分别验证';
    assert.deepEqual(check('bhosale', concept + '。'), []);
    for (const text of [
        '本文' + concept + '。', '作者拥有的' + concept + '。',
        '作者否认“' + concept + '”。', '“' + concept + '”这个说法不成立。',
        concept + '，这个区分是错误的。', concept + '，上述区分已被撤回。',
        concept.replace('三件', '两件') + '。',
        concept + '；三者均已公开可用。', concept + '，但作者权重已经公开。',
        '本文模型权重可下载。' + concept + '。'
    ]) assert.ok(check('bhosale', text).some(issue => issue.message.includes('model')), text);
});

test('bounded missing author-release evidence is a denial; quotation, double negation and later affirmatives remain blocked', () => {
    const denial = '按本次证据没有可验证的作者代码模型数据资源可写为已公开';
    assert.deepEqual(check('ryu', denial + '。'), []);
    for (const text of [
        '不是' + denial + '。', '作者否认“' + denial + '”。',
        '“' + denial + '”这个说法不成立。', denial + '的说法是错误的。', denial + '，上述否定已被撤回。',
        denial + '，但本文代码已经开源。', denial + '；作者模型权重已经公开。',
        '本文代码已经开源。' + denial + '。', '不能否认作者已经公开权重。'
    ]) assert.ok(check('ryu', text).length, text);
});

test('postposed third-party attribution needs verified third-party availability and never excuses authors own code', () => {
    const link = '文末给出代码链接经核验为第三方可用';
    assert.deepEqual(check('zhang', link + '。'), []);
    const record = saved.cases.find(item => item.name === 'zhang');
    const emptyBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: record.sealedSourceSha256, resources: [] };
    const empty = { ...emptyBody, identitySha256: deep.stableFingerprint(emptyBody) };
    assert.ok(check('zhang', link + '。', empty).some(issue => issue.message.includes('code')));
    for (const text of [
        '本文代码链接经核验为第三方可用。', '文末给出作者代码链接经核验为第三方可用。',
        '作者否认“' + link + '”。', link + '，这个归属不成立。', link + '，该归属是错误的。', link + '，该归属已被撤回。',
        link + '，但作者代码也已开源。', link + '，且本文代码当前可用。',
        '本文代码已经开源。' + link + '。',
        '第三方代码链接经核验为可用，但本文代码已经开源。'
    ]) assert.ok(check('zhang', text).some(issue => issue.message.includes('code')), text);
});

test('no real paid paragraph is a blanket exemption for mixed or appended author-owned releases', () => {
    for (const record of saved.cases) for (const release of ['本文代码已经开源。', '作者模型权重已经公开。']) {
        assert.ok(check(record.name, record.body + release).length, record.paperId + ': appended ' + release);
        assert.ok(check(record.name, release + record.body).length, record.paperId + ': preceding ' + release);
    }
});

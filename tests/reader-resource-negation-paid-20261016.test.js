'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const fixture = require('./fixtures/reader-resource-negation-paid-20261016.json');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const wrap = body => ({ sections: [{ kind:'reproduction', body }] });
const empty = sourceText => {
    const body={contract:'api-reader-resource-identity-v1',sourceTextSha256:sha(sourceText),resources:[]};
    return {...body,identitySha256:deep.stableFingerprint(body)};
};

test('three actual final paid drafts retain sealed sources/resources and pass only resource claim validation', () => {
    for (const saved of fixture.cases) {
        const before=JSON.stringify(saved);
        assert.equal(sha(saved.sourceText),saved.sealedSourceSha256);
        assert.equal(saved.resourceIdentity.sourceTextSha256,saved.sealedSourceSha256);
        assert.equal(saved.draft.sections[saved.sectionIndex].body,saved.body);
        assert.deepEqual(deep.readerResourceClaimIssues(saved.draft,saved.resourceIdentity,saved.sourceText),[],saved.paperId);
        assert.deepEqual(deep.readerResourceClaimIssues(wrap(saved.body),saved.resourceIdentity,saved.sourceText),[],saved.paperId);
        assert.equal(JSON.stringify(saved),before);
    }
});

test('constructed bare concepts and exact non-equivalence are nonclaims, with full predicate scope only', () => {
    const saved=fixture.cases[0], identity=empty(saved.sourceText);
    const issues=text=>deep.readerResourceClaimIssues(wrap(text),identity,saved.sourceText);
    const concepts=['商用接口与可下载权重是两回事','开源、权重可下载、可运行需分开核实'];
    const denial='不能把代码可用当成权重已公开或系统可运行';
    for (const span of [...concepts,denial]) assert.deepEqual(issues(span+'。'),[],span);
    for (const span of concepts) for (const text of [
        '本文'+span+'。','作者拥有的'+span+'。',
        '作者否认“'+span+'”。','“'+span+'”这个说法不成立。',
        '并非'+span+'。',span+'，这个区分是错误的。',span+'，上述区分已被撤回。',
        span+'，但本文权重已经公开。',span+'；本方法权重可下载。',
        '本文权重已公开，'+span+'。'
    ]) assert.ok(issues(text).length,text);
    for (const text of [
        '作者否认“'+denial+'”。','“'+denial+'”这个否定不成立。',
        '并非'+denial+'。',denial+'，这个否定是错误的。',denial+'，这个说法已撤销。',
        denial+'，但本文权重已公开。','本文权重已公开，'+denial+'。',
        '不能否认作者已公开权重。','无法否认本文权重可下载。'
    ]) assert.ok(issues(text).length,text);
});

test('real entire paid clauses cannot excuse appended or preceding own-weight counterclaims', () => {
    for (const saved of fixture.cases) {
        const issues=body=>deep.readerResourceClaimIssues(wrap(body),saved.resourceIdentity,saved.sourceText);
        for (const body of [saved.body+'本文模型权重已经公开。',
            '本文模型权重已经公开。'+saved.body,
            saved.body.replace(/。(?=[^。]*$)/u,'，但本文权重可下载。')]) {
            assert.ok(issues(body).some(i=>i.message.includes('model')),saved.paperId+': '+body.slice(-100));
        }
    }
});

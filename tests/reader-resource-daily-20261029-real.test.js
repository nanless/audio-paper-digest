'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceText = 'Source fixture without verified author code or weights.';
const identityBody = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
const identity = { ...identityBody, identitySha256: deep.stableFingerprint(identityBody) };
const wrap = body => ({ sections: [{ kind: 'reproduction', body }] });
const issues = body => deep.readerResourceClaimIssues(wrap(body), identity, sourceText);
// Actual saved clauses, with constructed unavailable identity; not entire-page proof.
const concepts = '代码可下载、权重可下载、完整实验可运行是三件事';
const denial = '不是代码权重已公开的证明';

test('saved October 29 concept and closed proof denial clauses are nonclaims', () => {
    for (const text of [concepts + '。', '容易误解的是，' + concepts + '。',
        denial + '。', '这只是演示页，' + denial + '。']) assert.deepEqual(issues(text), [], text);
});

test('concepts retain owner, count, quote, retraction and adjacent-claim guards', () => {
    for (const text of ['本文' + concepts, '作者拥有的' + concepts,
        concepts.replace('三件', '两件'), '“' + concepts + '”这个说法是错误的',
        concepts + '，上述区分已撤回。', concepts + '，这个区分不成立。',
        concepts + '，三者均已公开。', concepts + '，但本文权重已公开。',
        '本文代码已开源，' + concepts]) assert.ok(issues(text).length, text);
});

test('closed evidence denial cannot hide double negatives, quotes or real releases', () => {
    for (const text of ['不是不能证明代码权重已公开。', '并非不是代码权重已公开的证明。',
        '不能否认作者代码已开源。', '“' + denial + '”这个否定是错误的。',
        denial + '，上述否定已撤回。', denial + '，这个说法不成立。',
        denial + '，但本文代码已开源。', '本文模型权重已公开，' + denial + '。']) {
        assert.ok(issues(text).length, text);
    }
});

test('scalar anchor weight trades privacy for usable speech, not resource availability', () => {
    const performance = '这正是报告系统把锚权重提到 1.0、用部分隐私换回可用语音的原因';
    assert.deepEqual(issues(performance + '。'), []);
    for (const text of [performance + '，但本文模型权重已公开。',
        performance + '，模型权重可下载。', '本文模型权重可用，' + performance + '。',
        '本文模型权重已公开。' + performance + '。',
        performance.replace('锚权重提到 1.0', '模型权重已公开'),
        performance.replace('锚权重提到 1.0', '模型权重可下载'),
        '模型权重可用。', '锚权重提到 1.0，模型权重可用。',
        performance.replace('可用语音的原因', '可用语音模型'),
        performance.replace('可用语音的原因', '可用语音权重'),
        performance + '、模型权重可下载。']) {
        assert.ok(issues(text).some(issue => issue.message.includes('model')), text);
    }
    assert.ok(issues(performance + '、代码已经公开。').some(issue => issue.message.includes('code')));
});

// Opt-in private replay: immutable diagnostic drafts + original current resource
// identity + sealed source bytes. It checks resource claims ONLY, not full Reader
// parsing, tables, authors, publication eligibility or candidate/request admission.
test('private full paid drafts replay resource gate against original sealed identities', {
    skip: process.env.READER_RESOURCE_OCT29_PRIVATE !== '1'
}, () => {
    const fs = require('node:fs'), path = require('node:path');
    const root = path.join(__dirname, '../data/runtime/daily-fresh-source-runs/e766a04a-0ede-45d1-a154-a02308586172');
    const papers = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/current/deep-analysis-result.json'))).papers;
    for (const row of [
        ['2610.36834', '41844395-a38f-498b-9ce8-a6d9894c58ea', 'e1c2f2deeec4fb59e8309b0ee89d3d2f7f026ba75187e922fa7f13cf2dc32e88', '86b5fdee1060ac882ce06c7d9d00cf0903ed56b0a40714c68eec9c9972c09d18'],
        ['2610.36892', '8bcff18b-17d8-4161-9574-2f09fe312238', '75526606cfce7f53f2e95ab7b0245e1f05be140c30867800d9d0e35e0a450608', '86f6a8e456da9017951c83f5307b9df6f81a7654e2f90c546896d35d8bf6ce5c'],
        ['2610.36768', 'dd19fe6d-31d8-40a6-9965-8f393083422d', '471a835e5d9c5372a514c681603d2aa8e19ea628c04011cb2969445b1d7c41b2', '456b6727915c9f4ead7777e1cbcaad920fe8294e45589c6ccfc8122eb8e34d45']
    ]) {
        const [id, diagnosticId, fileSha, resourceSha] = row;
        const bytes = fs.readFileSync(path.join(root, 'reader-attempts/request-diagnostics', diagnosticId + '.request.json'));
        assert.equal(sha(bytes), fileSha);
        const saved = JSON.parse(bytes), paper = papers.find(p => p.arxivId === id + 'v1');
        const source = fs.readFileSync(path.join(root, 'sources', id, 'generation-000001/source.txt'), 'utf8');
        const sourceDir = path.join(root, 'sources', id, 'generation-000001');
        const manifestBytes = fs.readFileSync(path.join(sourceDir, 'source-manifest.json'));
        const manifest = JSON.parse(manifestBytes);
        assert.equal(sha(manifestBytes), saved.identity.freshAnalysis.sourceManifestSha256);
        for (const entry of [manifest.text, manifest.pdf, manifest.runtimeMetadata]) {
            const sealed = fs.readFileSync(path.join(sourceDir, entry.filename));
            assert.equal(sha(sealed), entry.responseSha256);
            assert.equal(sealed.length, entry.responseBytes);
        }
        assert.equal(sha(source), manifest.text.responseSha256);
        assert.equal(sha(source), saved.identity.sourceSha256);
        assert.equal(sha(JSON.stringify(saved.draft)), saved.draftSha256);
        assert.equal(paper.apiReaderResources.identitySha256, resourceSha);
        const before = JSON.stringify(saved);
        assert.deepEqual(deep.readerResourceClaimIssues(saved.draft, paper.apiReaderResources, source), [], id);
        assert.equal(JSON.stringify(saved), before);
        for (const claim of ['本文代码已开源。', '本文模型权重已公开。']) {
            const changed = structuredClone(saved.draft);
            changed.sections.at(-1).body += claim;
            assert.ok(deep.readerResourceClaimIssues(changed, paper.apiReaderResources, source).length, id + claim);
        }
    }
});

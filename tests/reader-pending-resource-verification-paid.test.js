'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const deep = require('../scripts/deep-analyzer');
const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-pending-resource-verification-paid-20261023.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pending = '即使拿到代码，还要分别确认权重可下载、端到端可运行、算子口径与注意力历史是否与报告一致，再在目标设备上测延迟、内存和功耗。';
const options = () => ({ arxivId: saved.paperId, requiredVersion: 3,
    requireIntegratedTables: true, requireSourceBindings: true,
    availableFigureOrdinals: [1, 2, 3, 4], structuredArtifacts: saved.structuredArtifacts,
    sourceText: saved.sourceText, verifiedResourceIdentity: saved.resourceIdentity });
const issues = body => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body }] },
    saved.resourceIdentity, saved.sourceText);

test('HC-AINet真实完整付费失败稿按原封存来源正常解析，不将待核验条件冒当前权重公开', () => {
    assert.equal(sha(saved.sourceText), saved.provenance.sourceTextSha256);
    assert.equal(sha(JSON.stringify(saved.draft)), saved.provenance.candidateDraftSha256);
    assert.equal(saved.structuredArtifacts.payloadSha256, saved.provenance.structuredArtifactsSha256);
    assert.equal(saved.resourceIdentity.sourceTextSha256, saved.provenance.sourceTextSha256);
    assert.equal(saved.resourceIdentity.identitySha256, deep.stableFingerprint({
        contract: saved.resourceIdentity.contract, sourceTextSha256: saved.resourceIdentity.sourceTextSha256,
        resources: saved.resourceIdentity.resources }));
    assert.deepEqual(saved.resourceIdentity.resources, []);
    assert.equal(saved.provenance.attempts, 2); assert.equal(saved.provenance.fullAttempts, 1);
    assert.equal(saved.provenance.validationFailureStreak, 2);
    assert.match(saved.draft.sections[14].body, /本次未发现可用的作者资源绑定，不能写代码或权重已公开/);
    assert.ok(saved.draft.sections[14].body.includes(pending));
    assert.equal(saved.provenance.originalIssues[0].path, '/sections/14/body');
    assert.equal(saved.provenance.originalIssues[0].conflictExcerpt, pending);
    const before = JSON.stringify(saved);
    const result = deep.parseApiReaderArticleResult(JSON.stringify(saved.draft), options());
    assert.ok(result.article);
    assert.deepEqual(deep.readerResourceClaimIssues(saved.draft, saved.resourceIdentity, saved.sourceText), []);
    assert.equal(JSON.stringify(saved), before, '原全稿、来源、身份、失败和次数不得被校验改写');
});

test('待确认的资源能力是检查对象，否定和假设不授可用资格', () => {
    for (const text of [pending,
        '还要分别确认权重可下载、代码可运行和数据可获取。',
        '复现前需要逐项核实代码可用、模型权重可下载与系统可运行。',
        '如果拿到代码，仍需确认模型权重是否可下载。',
        '还要确认代码可用，仍需核实权重可下载。',
        '还要确认权重可下载，不能写它们已公开。',
        '还要确认权重可下载，若代码已开源再复现。',
        '需要确认权重可下载，尚未确认可达性。',
        '本次未发现可用的作者资源绑定，不能写代码或权重已公开。'
    ]) assert.deepEqual(issues(text), [], text);
});

test('检查要求只覆盖完整谓词，实际肯定、否定检查、引述和后续公开声明仍拒绝', () => {
    for (const text of [
        '需要确认权重可下载，尚未确认并且已经公开。',
        '需要确认权重可下载，虽然尚未确认同时已经公开。',
        '需要确认权重可下载，虽然尚未确认但它们已经公开。',
        '需要确认权重可下载，假设还未确认却已经公开。',
        '需要确认权重可下载，目前尚未确认然而它们已经公开。',
        pending + '本文模型权重已公开并可下载。',
        '本文模型权重可下载。' + pending,
        '还要分别确认权重可下载，但本文代码已经开源。',
        '还要分别确认权重可下载、本文代码已公开。',
        '不能否认权重可下载。',
        '所谓需要确认权重可下载。',
        '作者说“需要确认权重可下载”。',
        '需要确认权重可下载，这一说法已被撤回。',
        '需要确认权重可下载，当前可用。',
        '需要确认权重可下载的事实。',
        '需要确认权重可下载无疑。',
        '需要确认权重可下载，并且已经公开。',
        '需要确认权重可下载，它们可下载。',
        '需要确认代码可用、权重可下载，它们均已公开。',
        '需要确认代码可用、权重可下载，二者均已公开。',
        '需要确认代码可用、权重可下载，两项均已公开。',
        '需要确认代码可用、权重可下载，并已全部公开。',
        '需要确认权重可下载，同时已全部公开。',
        '需要确认代码可用、权重可下载，二者都可下载。',
        '已经确认本文模型权重可下载。'
    ]) assert.ok(issues(text).length, text);
    const draft = structuredClone(saved.draft);
    draft.sections[14].body += '\n\n本文模型权重已公开并可下载。';
    assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(draft), options()), error =>
        error.code === 'READER_RESOURCE_AVAILABILITY_CLAIM'
        && error.readerIssues.some(issue => issue.path === '/sections/14/body'));
});

test('真实完整稿追加待核验列表后的集体或转折公开声明仍被正常parser拒绝', () => {
    for (const claim of ['需要确认代码可用、权重可下载，二者均已公开。',
        '需要确认权重可下载，虽然尚未确认但它们已经公开。',
        '需要确认权重可下载，尚未确认并且已经公开。']) {
        const collective = structuredClone(saved.draft);
        collective.sections[14].body += '\n\n' + claim;
        const before = JSON.stringify(collective);
        assert.throws(() => deep.parseApiReaderArticleResult(before, options()), error =>
            error.code === 'READER_RESOURCE_AVAILABILITY_CLAIM'
            && error.readerIssues.some(issue => issue.path === '/sections/14/body'));
        assert.equal(JSON.stringify(collective), before);
    }
});

test('前置实际公开谓词也不能借后面的待确认要求消失', () => {
    for (const text of ['已经公开，需要确认权重可下载。', '已全部公开，需要确认权重可下载。']) {
        assert.ok(issues(text).length, text);
    }
});

test('第三方资源不能被检查词或另一项可用资源升级为本文权重', () => {
    const sourceText = 'We use the third-party baseline at https://example.test/baseline.';
    const quote = sourceText;
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [{
        type: 'third_party', origin: 'paper_source', sourceQuote: quote, sourceQuoteSha256: sha(quote),
        originalUrl: 'https://example.test/baseline', finalUrl: 'https://example.test/baseline',
        redirects: [], availability: 'available', status: 200, retryable: false }] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    const check = value => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: value }] }, identity, sourceText);
    assert.deepEqual(check('第三方基线链接可以访问；' + pending), []);
    assert.ok(check(pending + '本文权重可下载。').length);
    assert.ok(check('第三方基线链接可访问，所以本文权重可下载。').length);
    assert.equal(identity.resources[0].type, 'third_party');
});

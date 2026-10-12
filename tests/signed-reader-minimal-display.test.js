'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const helper = require('../scripts/lib/signed-reader-recovery-draft');
const repair = require('../scripts/lib/reader-repair');
const { fixture: createSignedReaderSample } = require('./reader-signed-draft-fixture');

function prepareSignedReaderSample() {
    const sample = createSignedReaderSample({ noFigures: true });
    const feedback = '只修当前事实。';
    const seed = deep.prepareApiReaderRevisionSeed(sample.paper, sample.sourceDetails.text, feedback);
    return { ...sample, seed, feedback };
}

function generationOptions(sample, directory) {
    return {
        readerAttemptsDir: directory,
        sourceText: sample.sourceDetails.text,
        structuredArtifacts: sample.sourceDetails.structuredArtifacts,
        readerResources: sample.paper.apiReaderResources,
        reviewFeedback: sample.feedback,
        initialDraft: sample.seed.initialDraft,
        revisionSeed: sample.seed
    };
}

function privateDirectory(t, prefix) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

// 请求显示只去掉重复的派生数据，所有原引文和原文章、来源摘要仍然保留。
test('精简输入保留全部原引文，不改原文章与来源摘要', () => {
    const sample = prepareSignedReaderSample();
    const before = JSON.stringify(sample.seed);
    const full = JSON.parse(sample.seed.initialDraft);
    const quote = 'A controlled source quote with 1.0.';
    full.plan.tableBindings[0].sourceQuotes = [{
        quote,
        sourceQuoteSha256: crypto.createHash('sha256').update(quote).digest('hex')
    }];
    const seed = { ...sample.seed, initialDraft: JSON.stringify(full) };
    const display = helper.minimalDisplay(seed);
    const draft = JSON.parse(display.text);

    assert.deepEqual(draft.tableBindings[0].sourceQuotes, [quote]);
    assert.equal(draft.structuredSourcePayload, undefined);
    assert.deepEqual(seed.metadata, sample.seed.metadata);
    assert.equal(JSON.stringify(sample.seed), before);
    assert.equal(display.fields.signedRevisionDisplaySha256, repair.shaText(display.text));
});

test('原引文摘要错误时拒绝精简，不删除坏引文来通过检查', () => {
    const sample = prepareSignedReaderSample();
    const full = JSON.parse(sample.seed.initialDraft);
    full.plan.tableBindings[0].sourceQuotes = [{ quote: '原句', sourceQuoteSha256: 'a'.repeat(64) }];
    assert.throws(() => helper.minimalDisplay({
        ...sample.seed, initialDraft: JSON.stringify(full)
    }), /原来源引文摘要不同/);
});

test('没有已核验原文章或处于资源局部模式时不能启用精简输入', () => {
    const sample = prepareSignedReaderSample();
    assert.throws(() => deep.buildApiReaderGenerationStart(sample.paper, {
        signedRevisionMinimalDisplay: true
    }), /精简输入/);
    assert.throws(() => deep.buildApiReaderGenerationStart(sample.paper, {
        ...generationOptions(sample), signedRevisionMinimalDisplay: true, resourceLocalRevision: true
    }), /精简输入/);
});

test('精简输入记录真实新指纹，默认请求和原文章摘要保持不变', async t => {
    const sample = prepareSignedReaderSample();
    const directory = privateDirectory(t, 'signed-display-input-');
    const options = generationOptions(sample, directory);
    const old = deep.buildApiReaderGenerationStart(sample.paper, options);
    const fresh = deep.buildApiReaderGenerationStart(sample.paper, {
        ...options, signedRevisionMinimalDisplay: true
    });
    assert.equal(old.previousDraft, sample.seed.initialDraft);
    assert.notEqual(fresh.previousDraft, sample.seed.initialDraft);
    assert.deepEqual(sample.seed.metadata, deep.prepareApiReaderRevisionSeed(
        sample.paper, sample.sourceDetails.text, sample.feedback
    ).metadata);

    const before = await deep.prepareApiReaderRetryIdentity(
        sample.paper, sample.paper.analysis, '独立完整封存证据', options
    );
    const after = await deep.prepareApiReaderRetryIdentity(
        sample.paper, sample.paper.analysis, '独立完整封存证据', {
            ...options, signedRevisionMinimalDisplay: true
        }
    );
    assert.notEqual(before.identity.inputFingerprint, after.identity.inputFingerprint);
    assert.equal(after.identity.signedRevisionDisplayContract, helper.DISPLAY_CONTRACT);
    assert.equal(after.identity.signedRevisionDisplaySha256, repair.shaText(fresh.previousDraft));
    assert.equal(before.identity.signedRevisionDisplayContract, undefined);
});

// 即使返回的原稿尚未通过内容检查，也不能通过换显示形式重置请求次数。
const existingRequests = [
    ['真实已付费', { attempts: 1, fullAttempts: 1 }],
    ['已发生传输', { attempts: 0, fullAttempts: 0, transportFailures: 1 }],
    ['已有原稿', { attempts: 0, fullAttempts: 0, rawDraft: '真实原响应' }]
];
for (const [label, payload] of existingRequests) {
    test(`${label}不能换输入显示来重置请求次数`, async t => {
        const sample = prepareSignedReaderSample();
        const directory = privateDirectory(t, 'signed-display-paid-');
        const options = generationOptions(sample, directory);
        const before = await deep.prepareApiReaderRetryIdentity(
            sample.paper, sample.paper.analysis, '独立证据', options
        );
        repair.saveFailedCandidate(directory, before.identity, {
            status: 'failed', attempts: 0, fullAttempts: 0, noProgress: 0,
            failureSignature: 'sample-failed', issues: [], ...payload
        });
        const filename = path.join(directory, repair.hashDraft(before.identity) + '.json');
        const bytes = fs.readFileSync(filename);
        await assert.rejects(deep.prepareApiReaderRetryIdentity(
            sample.paper, sample.paper.analysis, '独立证据', {
                ...options, signedRevisionMinimalDisplay: true
            }
        ), /不能更换输入显示来重置请求次数/);
        assert.deepEqual(fs.readFileSync(filename), bytes);
    });
}

test('外传参考正文被改且重新自填摘要，也不能冒充当前已核验文章', () => {
    const sample = prepareSignedReaderSample();
    const seed = structuredClone(sample.seed);
    const view = JSON.parse(seed.initialDraft);
    view.article = view.article.replace('###', '伪造参考事实。\n\n###');
    seed.initialDraft = JSON.stringify(view);
    seed.metadata.revisionSeedSha256 = repair.shaText(seed.initialDraft);
    assert.throws(() => deep.buildApiReaderGenerationStart(sample.paper, {
        ...generationOptions(sample), initialDraft: seed.initialDraft,
        revisionSeed: seed, signedRevisionMinimalDisplay: true
    }), /不能传入替换的参考正文/);
});

test('关闭诊断迁移且旧解析器摘要不同，已有付费记录仍阻止切换输入', async t => {
    const sample = prepareSignedReaderSample();
    const directory = privateDirectory(t, 'signed-display-old-parser-');
    const options = generationOptions(sample, directory);
    const original = await deep.prepareApiReaderRetryIdentity(
        sample.paper, sample.paper.analysis, '独立证据', options
    );
    const oldIdentity = { ...original.identity, parserImplementationSha256: '1'.repeat(64) };
    repair.saveFailedCandidate(directory, oldIdentity, {
        status: 'failed', attempts: 1, fullAttempts: 1, noProgress: 0,
        failureSignature: 'paid-old-parser', issues: []
    });
    const filename = path.join(directory, repair.hashDraft(oldIdentity) + '.json');
    const before = fs.readFileSync(filename);
    // 没有日更诊断上下文，旧实现的迁移入口原本会返回 null；这里只读查账仍须拒绝。
    assert.equal(require('../scripts/lib/reader-recovery-revision').loadReaderRecoveryRevision(
        directory, original.identity
    ), null);
    await assert.rejects(deep.prepareApiReaderRetryIdentity(
        sample.paper, sample.paper.analysis, '独立证据', {
            ...options, refreshReaderDiagnostics: false, signedRevisionMinimalDisplay: true
        }
    ), /不能更换输入显示来重置请求次数/);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.json')).length, 1);
});

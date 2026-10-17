'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
// These are actual saved prose fragments, exercised with an explicitly
// constructed unavailable-resource identity. This is not a full paid-page proof.
const sourceText = 'Source fixture without verified available author resources.';
const identityBody = { contract: 'api-reader-resource-identity-v1',
    sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'), resources: [] };
const identity = { ...identityBody, identitySha256: deep.stableFingerprint(identityBody) };
const issues = body => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body }] }, identity, sourceText);
const savedFragments = [
    { paper: 'gao26', text: '若按原文链接尝试，需自行确认本次是否可达，并把代码开源、权重下载和系统可运行三件事分开验证。' },
    { paper: 'kim26', text: '代码开源、权重下载和系统可运行是三件不同的事' },
    { paper: 'nguyen26i', text: '代码开源、权重下载与系统可运行是三件不同的事，论文未提供可直接运行的仓库承诺，复现应区分自己实现的训练脚本与原文系统。' },
    { paper: 'xu26j', text: '代码开源、权重下载与系统可运行是三件独立事项，论文引用 Whisper-large-v3、Dolphin、Qwen3-ASR、GPT-SoVITS 与 FireRedLID 等既有实现，但本次未验证其可达链接，复现者需自行确认版本与许可。' },
    { paper: 'wang26w', text: '代码可运行、权重可下载、系统可部署是三件事，要分别确认。' }
];

test('saved bare-download concepts and bounded verification instructions are nonclaims', () => {
    for (const { paper, text } of savedFragments) assert.deepEqual(issues(text), [], paper);
    for (const text of [
        '权重下载与系统可运行是两件不同的事。',
        '复现时应将代码开源、权重下载与系统可运行三件事分别核对。',
        '把代码开源和权重下载分别核实。',
        '代码开源、模型权重下载与系统可运行是三件独立事项。'
    ]) assert.deepEqual(issues(text), [], text);
});

test('deployment is a bounded distinct concept, never a release assertion', () => {
    const list = '代码可运行、权重可下载、系统可部署是三件事';
    for (const text of [
        '本文' + list + '，要分别确认。',
        list + '，但三者已公开可用。',
        list + '，这个区分不成立。',
        '“' + list + '”这句话是错误的。',
        '代码可运行、权重可下载、系统可部署是两件事。',
        '权重可下载与系统可部署是三件事。',
        '本文代码可运行、权重可下载、系统可部署。'
    ]) assert.ok(issues(text).length, text);
    for (const system of ['系统可部署', '系统可运行']) {
        const concepts = `代码可运行、权重可下载、${system}是三件事`;
        assert.ok(issues(concepts + '，上述区分已经被撤销。').length);
        assert.ok(issues(concepts + '，要分别确认；三者均已公开可用。').length);
        for (const qualification of [
            '三者可用与否仍待核验。', '三者当前可用性仍未确认。',
            '三者均已公开这一假设尚待验证。', '三者均已公开的说法是错误的。',
            '三者可用时仍须核验版本。'
        ]) assert.deepEqual(issues(concepts + '，要分别确认；' + qualification), []);
    }
});

test('concept spans cannot hide real ownership, extra claims, quoted or revoked distinctions', () => {
    const list = '代码开源、权重下载和系统可运行是三件不同的事';
    for (const text of [
        '本文' + list + '。', '作者拥有的' + list + '。',
        '作者否认“' + list + '”。', '“' + list + '”这个说法不成立。',
        list + '，这个区分是错误的。', list + '，上述区分已被撤回。',
        list + '，不过三者都已经公开。', list + '，然而三者当前均可用。',
        list + '，但这种区分不成立。', list + '，这一说法从未成立。',
        list + '，这种区分并不成立。',
        list + '，三者已经公开可用。',
        list + '，但本文代码已经开源。', list + '；本文权重可下载。',
        '本文代码已经开源。' + list + '。',
        '本文代码开源，权重下载和系统可运行。',
        '代码开源、权重下载和系统可运行是两件不同的事。',
        '代码开源和代码公开是两件不同的事。',
        '本文将代码开源、权重下载和系统可运行三件事分别核实。本文代码已公开。'
    ]) assert.ok(issues(text).length, text);
    for (const { text } of savedFragments) {
        assert.ok(issues(text + '本文代码已经开源。').length, text);
        assert.ok(issues('本文模型权重已经公开。' + text).length, text);
    }
});

test('the actual separate affirmative stays blocked despite a following concept distinction', () => {
    const text = '代码当前已公开，但需区分代码开源、权重下载和系统可运行是三件不同的事，复现前先确认权重和推理脚本是否与论文口径一致。';
    assert.ok(issues(text).some(issue => issue.message.includes('code')));
});

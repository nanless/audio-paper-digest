'use strict';
// Availability exemptions must be local and supported by the sealed source.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const editorial = require('../scripts/editorial-quality');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function claims(text, sourceText = 'This paper has not supplied a verified author resource.') {
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    const draft = { sections: [{ kind: 'reproduction', body: text }] };
    const before = JSON.stringify({ draft, identity });
    const issues = deep.readerResourceClaimIssues(draft, identity, sourceText);
    assert.equal(JSON.stringify({ draft, identity }), before, '校验不能把过去使用记录改为作者当前可用身份');
    return issues;
}
const pending = '关于资源，论文只提供了一个第三方演示网页且当前可访问，没有提供代码或权重的可验证信息，因此代码开源、权重可下载和系统可运行应视为三件未确认的事，不宜混为一谈。';
test('真实未确认列表只在列表范围免责，前后真正肯定仍拒绝', () => {
    assert.deepEqual(claims(pending), []);
    for (const text of [
        '本文模型权重已经公开；' + pending,
        pending + '本文模型权重已经公开。',
        pending.replace('，不宜混为一谈。', '，但事实上本文模型权重已经公开。'),
        '本文权重可下载，代码开源、权重可下载和系统可运行应视为三件未确认的事。',
        '本文代码开源、权重可下载和系统可运行应视为三件未确认的事。',
        '代码已开源、权重可下载和系统可运行应视为三件未确认的事。',
        '权重可下载；几种主张是未确认的。'
    ]) assert.ok(claims(text).length > 0, text);
});

// Exact source relations extracted from the sealed SemiCodec and MPASCNet source.txt files.
const baselineProtocolSource = 'Baselines. We compare SemiCodec with representative discrete and continuous speech representations. The discrete baselines include WavTokenizer, X-Codec2, and SAC. The continuous baselines include Semantic-VAE and the audio VAEs adopted by Ming-omni-tts and dots.tts. We use the released checkpoints and evaluate reconstructed waveforms with the same protocol whenever model outputs are available.';
const genericUse = '没有训练新基线也不等于结果不可比，论文用的是已发布检查点加统一评测协议。';
const namedSource = 'We compare MPASCNet against two baseline methods, Apollo and AEROMamba. For Apollo, we use the publicly released model weights. For AEROMamba, we adapt the setting and retrain it using the same training data.';
const namedUse = '限制是Apollo为公开权重直接评测，若其原始训练码率与本文不同，则差距中可能包含协议失配成分。';
test('封存原文支持的第三方基线使用不等于作者当前提供权重', () => {
    assert.deepEqual(claims(genericUse, baselineProtocolSource), []);
    assert.deepEqual(claims(namedUse, namedSource), []);
    assert.deepEqual(claims(namedUse.replaceAll('Apollo', 'Comet-V2'), namedSource.replaceAll('Apollo', 'Comet-V2')), []);
});

test('没有来源、错误名称、未来计划、作者归属与当前肯定不能借基线描述放行', () => {
    for (const [text, source] of [
        [genericUse, 'The paper reports a baseline evaluation.'],
        [genericUse, baselineProtocolSource.replace('We use the released checkpoints', 'We will use the released checkpoints')],
        [genericUse, baselineProtocolSource.replace('Baselines.', 'Our own model.')],
        [namedUse, 'Apollo is mentioned in related work.'],
        [namedUse, namedSource.replaceAll('Apollo', 'Comet')],
        [namedUse, namedSource.replace('we use the publicly released model weights', 'we will use the publicly released model weights')],
        ['本文模型Apollo为公开权重直接评测。', namedSource],
        [genericUse + '本文模型权重已公开并可下载。', baselineProtocolSource],
        ['本文模型权重可下载，' + genericUse, baselineProtocolSource],
        [namedUse + '不过本文模型权重现已开源。', namedSource]
    ]) assert.ok(claims(text, source).length > 0, text);
});

const axis = '读图说明：该图横轴是每类 1、10、20 3 个预算，纵轴是准确率，每组内三根柱从左到右依次是 DM、AVDD、X-AVDD，适合一眼看出本文方法在 VGGSound 上的领先幅度是否随预算变化。';
test('明确横轴预算整数枚举不当作准确率值，项数必须与计数吻合', () => {
    assert.deepEqual(editorial.findMissingComparisonUnits(axis), []);
    for (const text of [
        axis.replace('3 个预算', '4 个预算'),
        axis.replace('1、10、20', '1、10、10'),
        axis.replace('1、10、20', '1、10、20.5'),
        '横轴是每类 1、10、20 3 个预算，准确率从 91.3 降到 85.2。',
        '准确率从 91.3 降到 85.2，横轴是每类 1、10、20 3 个预算。',
        '工具准确率从 91.3 降到 85.2 到 86.9。'
    ]) assert.ok(editorial.findMissingComparisonUnits(text).length > 0, text);
});

// 同源第三方基线的两个普通系词；不能扩展为作者当前权重可用声明。
test('同源基线直接评测兼容为/是，名称归属未来及当前肯定仍严格核验', () => {
    for (const copula of ['为', '是']) {
        const usage = `限制是Apollo${copula}公开权重直接评测，原训练条件可能不同。`;
        assert.deepEqual(claims(usage, namedSource), []);
        assert.deepEqual(claims(usage.replaceAll('Apollo', 'Comet-V2'), namedSource.replaceAll('Apollo', 'Comet-V2')), []);
        for (const [text, source] of [
            [usage, 'Apollo is mentioned in related work.'],
            [usage, namedSource.replaceAll('Apollo', 'Comet')],
            [usage, namedSource.replace('we use the publicly released model weights', 'we will use the publicly released model weights')],
            [usage, namedSource.replace('we use the publicly released model weights', 'we plan to use the publicly released model weights')],
            [usage, namedSource.replace('baseline methods', 'our own methods')],
            [`本文模型Apollo${copula}公开权重直接评测。`, namedSource],
            [`作者团队Apollo${copula}公开权重直接评测。`, namedSource],
            ['本文模型权重已经公开。' + usage, namedSource],
            [usage + '本文模型权重已经公开。', namedSource],
            [usage + '但本文模型权重现在可下载。', namedSource],
            ['本文权重可下载，' + usage, namedSource]
        ]) assert.ok(claims(text, source).length > 0, text + '\n' + source);
    }
});

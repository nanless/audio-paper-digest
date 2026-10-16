'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const editorial = require('../scripts/editorial-quality');
const evidence = require('./fixtures/daily-reader-paid-20261016.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const actual = id => evidence.cases.find(item => item.paperId === id);
const draft = body => ({ sections: [{ kind: 'reproduction', body }] });
const emptyIdentity = sourceText => {
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources: [] };
    return { ...body, identitySha256: deep.stableFingerprint(body) };
};

test('真实付费资源片段绑定原完整封存来源，概念区别和明确否定不改资源身份', () => {
    for (const id of ['2610.21520', '2610.19476', '2610.19445', '2610.19726', '2610.20085']) {
        const saved = actual(id);
        assert.equal(sha(saved.sourceText), saved.sealedSourceSha256, id);
        assert.equal(saved.resourceIdentity.sourceTextSha256, saved.sealedSourceSha256, id);
        assert.match(saved.candidateFileSha256, /^[a-f0-9]{64}$/);
        assert.match(saved.candidatePayloadSha256, /^[a-f0-9]{64}$/);
        const before = JSON.stringify(saved);
        // These are real paid node bytes, not constructed positive prose. This
        // checks the resource gate only, never the paper's complete qualification.
        for (const section of saved.sections) {
            for (const body of [section.body, section.body.replace(/是3件/gu, '是 3 件')
                .replace(/先分清三件事/gu, '先分清 3 件事')]) {
                assert.deepEqual(deep.readerResourceClaimIssues(draft(body), saved.resourceIdentity, saved.sourceText), [], id);
            }
        }
        assert.equal(JSON.stringify(saved), before, '原身份、来源、片段及费用证据不得被读取改写');
    }
    // Point-and-Play remains third_party. Accepting its negative availability
    // span is not proof of the draft's unsupported “third-party mirror” label.
    assert.ok(actual('2610.19445').resourceIdentity.resources.every(item => item.type === 'third_party'));
});

test('构造反例：概念列表只限定自身完整范围，归属、数量错误、引述和撤销仍拒绝', () => {
    const saved = actual('2610.21520');
    const identity = emptyIdentity(saved.sourceText);
    const issues = text => deep.readerResourceClaimIssues(draft(text), identity, saved.sourceText);
    const counted = '代码可用、权重可下载、系统可一键运行是 3 件不同的事';
    const instruction = '先分清三件事，代码开源、权重可下载、系统可运行是独立的';
    for (const text of [counted + '。', instruction + '。']) assert.deepEqual(issues(text), [], text);
    for (const text of [
        counted + '，但本文代码已开源。',
        counted + '；本文权重已公开。',
        '本文代码已公开，' + counted + '。',
        counted + '，它们均已可下载。',
        counted + '，这三项都已由作者公开。',
        '作者拥有的' + counted + '。',
        '本文' + counted + '。',
        counted.replace('3 件', '2 件') + '。',
        counted.replace('代码可用、', '权重可下载、') + '。',
        '作者说“' + counted + '”。',
        '“' + instruction + '”这个说法不成立。',
        '并非' + instruction + '。',
        counted + '，这个区分是错误的。',
        instruction + '，三者均已发布。',
        instruction + '，但本文权重可下载。'
    ]) assert.ok(issues(text).length, text);
});

test('构造反例：否定发布的完整名词组和禁止表述不得吞掉后续真肯定或双重否定', () => {
    const saved = actual('2610.19476');
    const identity = emptyIdentity(saved.sourceText);
    const issues = text => deep.readerResourceClaimIssues(draft(text), identity, saved.sourceText);
    const negativeLinks = '论文未公开可用的代码、模型或数据链接';
    const forbidden = '不能把它写成作者已开源或权重可下载';
    for (const text of [negativeLinks + '。', forbidden + '。']) assert.deepEqual(issues(text), [], text);
    for (const text of [
        negativeLinks + '，但本文代码已公开。',
        negativeLinks + '；本文权重可下载。',
        '本文代码已公开，' + negativeLinks + '。',
        '并非' + negativeLinks + '。',
        '“' + negativeLinks + '”这个否定不成立。',
        negativeLinks + '，这个否定是错误的。',
        forbidden + '，但本文权重已经公开。',
        '本文代码已开源，' + forbidden + '。',
        '并非' + forbidden + '。',
        '“' + forbidden + '”的说法不成立。',
        forbidden + '，这个否定是错误的。',
        '不能否认作者已开源代码并提供可下载权重。'
    ]) assert.ok(issues(text).length, text);
});

test('真实Designing两项概念区分只豁免列表，Qwen外部路线及本方法声明分别核验', () => {
    const saved = actual('2610.20085');
    const before = JSON.stringify(saved.resourceIdentity);
    const issues = body => deep.readerResourceClaimIssues(draft(body), saved.resourceIdentity, saved.sourceText);
    const distinction = '权重可下载与系统可运行是两回事';
    const external = 'Qwen权重可从第三方页面获取，Gemini需经接口访问，GPT-4.1同样依赖外部服务。';
    assert.deepEqual(issues(distinction + '。'), []);
    assert.deepEqual(issues(external), []);
    assert.deepEqual(issues(distinction + '：' + external), []);
    assert.deepEqual(issues(distinction.replace('两', '2 ') + '：' + external), []);
    assert.ok(!saved.resourceIdentity.resources.some(item => item.type === 'model' && item.availability === 'available'));
    for (const body of [
        distinction + '：本方法权重当前可用。',
        distinction + '，但本文权重可下载。',
        '本方法权重已公开，' + distinction + '。',
        distinction + '，它们均已可下载。',
        '本文' + distinction + '。',
        '并非' + distinction + '。',
        '作者否认“' + distinction + '”。',
        distinction + '：这个区分是错误的。',
        distinction.replace('两回事', '三回事') + '。'
    ]) assert.ok(issues(body).length, body);
    assert.equal(JSON.stringify(saved.resourceIdentity), before);
});

test('真实二值化术语不被当阈值二，其他精确数词及诊断位置保留', () => {
    const saved = actual('2610.21691');
    assert.equal(sha(saved.sourceText), saved.sealedSourceSha256);
    assert.match(saved.sourceText, /thresholded at 0\.5 to obtain\s+binary state predictions/u);
    assert.ok(!editorial.findQuantitativeChineseNumerals(saved.sections[0].body).some(item => item.match === '阈值二'));
    const cases = require('./fixtures/binarization-numeral-boundary.json');
    for (const text of cases.accept) assert.deepEqual(editorial.findQuantitativeChineseNumerals(text), [], text);
    for (const text of cases.reject) assert.ok(editorial.findQuantitativeChineseNumerals(text).length, text);
    const value = '0.5 阈值二值化后，阈值为二。';
    const findings = editorial.findQuantitativeChineseNumerals(value);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].match, '阈值为二');
    assert.equal(findings[0].index, value.indexOf('阈值为二'));
});

test('真实模态计数不当百分尺度结果，跨任务accuracy与AUC各自绑定且不豁免裸比较值', () => {
    const saved = actual('2610.20906');
    assert.equal(sha(saved.sourceText), saved.sealedSourceSha256);
    assert.match(saved.sourceText, /accuracy = 0\.75, AUC = 0\.80/u);
    assert.match(saved.sourceText, /each task was treated as an independent data point/u);
    for (const section of saved.sections) {
        assert.deepEqual(editorial.findMissingComparisonUnits(section.body), []);
        assert.deepEqual(editorial.findMissingComparisonUnits(section.body.replace(/三模态/gu, '3 模态')), []);
    }
    for (const text of [
        '3 模态总体准确率从75提升到80，不能直接相减得到提升幅度。',
        '3 模态融合模型的准确率从75提升到80。',
        '3 模态总体准确率提升到80，末尾的0.75是另一项分数。',
        '3 模态总体准确率0.75，另一模型准确率提高到80，不能比较。',
        '3 模态总体准确率报告75对80%。'
    ]) assert.ok(editorial.findMissingComparisonUnits(text).length, text);
    // This real within-0..1 comparison must remain intact rather than being
    // globally masked because another clause rejects cross-task subtraction.
    const comparison = '3 模态总体准确率从0.75提升到0.80，不能把跨任务数直接相减。';
    assert.deepEqual(editorial.findMissingComparisonUnits(comparison), []);
});

test('真实混合时长横轴只屏蔽双端同单位范围，后续召回率裸值仍拒绝', () => {
    const saved = actual('2610.19445');
    const axis = require('./fixtures/reader-measured-axis-20261016.json');
    assert.equal(saved.candidateFileSha256, axis.candidateFileSha256);
    assert.equal(saved.sourcePdfSha256, axis.sourcePdfSha256);
    assert.ok(saved.styleSections[0].body.includes(axis.actualSentence));
    assert.ok(axis.sourcePdfPageText.startsWith('2\n4\n6\n8\nMixture Duration (s)\n'));
    for (const body of [axis.actualSentence, saved.styleSections[0].body, ...axis.constructedAccept]) {
        assert.deepEqual(editorial.findMissingComparisonUnits(body), [], body);
    }
    for (const body of axis.constructedReject) assert.ok(editorial.findMissingComparisonUnits(body).length, body);
});

test('真实十七八个百分点是模糊数量，不能猜成178或自动恢复为17/18', () => {
    const saved = actual('2610.19476');
    const body = saved.styleSections[0].body;
    assert.ok(body.includes('有十七八个百分点在静音下还在'));
    assert.match(saved.sourceText, /Silence Gains of 17\.217\.2 and 18\.418\.4 points/u);
    const findings = editorial.findQuantitativeChineseNumerals(body);
    assert.ok(findings.some(item => item.match === '十七八个'));
    assert.equal(editorial.normalizeIssueBoundReaderQuantitativeNumerals(body,
        [{ message: 'quantitative_chinese_numeral:十七八个' }]), body);
});

test('真实GPT-4.1型号不冒充准确率，邻近真裸值和普通英文数值仍阻断', () => {
    const saved = actual('2610.20085');
    const section = saved.styleSections[0].body;
    assert.ok(section.includes('用同样的Gemini描述，无论推理者是Gemini还是GPT-4.1，准确率都比直接推理低'));
    assert.match(saved.sourceText, /Using the same Gemini-generated captions, both Gemini and GPT-4\.1 reasoners/u);
    assert.deepEqual(editorial.findMissingComparisonUnits(section), []);
    const paragraph = section.split('\n\n')[0];
    assert.deepEqual(editorial.findMissingComparisonUnits(paragraph.replace(/GPT-4\.1/gu, 'GPT-4.1 ')), []);
    for (const body of [
        paragraph + '准确率从75提升到80。',
        'GPT-4.1 的准确率从75提升到80。',
        'GPT-4.1 的准确率提升到80。',
        'GPT-4.1 的准确率报告75对80%。',
        'Accuracy-75 的准确率高于80。',
        'Other-75 的准确率低于80。'
    ]) assert.ok(editorial.findMissingComparisonUnits(body).length, body);
});

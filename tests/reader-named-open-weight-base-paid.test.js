'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const saved = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-named-open-weight-base-paid-20261027.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sentence = '基座是开放权重的Audio Flamingo Next。';
const issues = (body, source = saved.sourceText) => {
    const syntheticIdentity = { contract: saved.resourceIdentity.contract, sourceTextSha256: sha(source), resources: [] };
    return deep.readerResourceClaimIssues({ sections: [{ kind: 'method', body }] }, source === saved.sourceText
        ? saved.resourceIdentity : { ...syntheticIdentity, identitySha256: deep.stableFingerprint(syntheticIdentity) }, source);
};
const modelIssue = (body, source) => issues(body, source).some(issue => /本文 model /.test(issue.message));

test('完整真实付费稿的具名开放权重基座归于原文明确使用的上游模型', () => {
    const before = JSON.stringify(saved);
    assert.equal(sha(saved.sourceText), saved.provenance.sourceTextSha256);
    assert.equal(sha(JSON.stringify(saved.draft)), saved.provenance.candidateDraftSha256);
    assert.ok(saved.sourceText.split('\n')[97].includes(saved.provenance.sourceSentence));
    assert.ok(saved.draft.sections[8].body.startsWith(sentence));
    assert.deepEqual(saved.provenance.counters,
        { attempts: 3, fullAttempts: 1, noProgress: 1, validationFailureStreak: 2, transportFailures: 0 });
    assert.deepEqual(saved.resourceIdentity.resources, []);
    assert.deepEqual(deep.readerResourceClaimIssues(saved.draft, saved.resourceIdentity, saved.sourceText), []);
    assert.equal(JSON.stringify(saved), before, '原稿、封存来源与历史次数不被纯检查改写');
});

test('基座归属只覆盖完整具名小句且须保留当前来源的明确使用与开放权重陈述', () => {
    for (const body of [sentence, '基座模型为开放权重的Audio Flamingo Next。',
        '本文使用的基座是开放权重的Audio Flamingo Next。']) {
        assert.deepEqual(issues(body), [], body);
    }
    for (const source of [
        saved.sourceText.replace(saved.provenance.sourceSentence, ''),
        saved.sourceText.replace('We implement our framework using the open-weight', 'We do not implement our framework using the open-weight'),
        saved.sourceText.replace('We implement our framework using the open-weight', 'We might implement our framework using the open-weight'),
        saved.sourceText.replace('We implement our framework using the open-weight', 'If we implement our framework using the open-weight'),
        saved.sourceText.replace('We implement our framework using the open-weight', 'We plan to implement our framework using the open-weight'),
        saved.sourceText.replace(saved.provenance.sourceSentence, '“' + saved.provenance.sourceSentence + '”'),
        saved.sourceText.replace(saved.provenance.sourceSentence, '“\n' + saved.provenance.sourceSentence + '\n”'),
        saved.sourceText.replace(saved.provenance.sourceSentence, '```\n' + saved.provenance.sourceSentence + '\n```'),
        saved.sourceText.replace(saved.provenance.sourceSentence, '> ' + saved.provenance.sourceSentence),
        saved.sourceText.replace(saved.provenance.sourceSentence, '<blockquote>\n' + saved.provenance.sourceSentence + '\n</blockquote>'),
        saved.sourceText.replace(saved.provenance.sourceSentence, 'Quotation:\n' + saved.provenance.sourceSentence),
        saved.sourceText.replace(saved.provenance.sourceSentence, 'Hypothetical example:\n' + saved.provenance.sourceSentence),
        saved.sourceText.replace(saved.provenance.sourceSentence, saved.provenance.sourceSentence + ' The preceding statement is false.'),
        saved.sourceText.replace(saved.provenance.sourceSentence, saved.provenance.sourceSentence + '\nThese weights are unavailable.'),
        saved.provenance.sourceSentence + ' We did not actually use this model.',
        saved.provenance.sourceSentence + ' This was only hypothetical.',
        saved.sourceText.replace('the open-weight audio-language model Audio Flamingo Next (Ghosh et\u00a0al., 2026)',
            'the closed-weight audio-language model Audio Flamingo Next (Ghosh et\u00a0al., 2026)'),
        saved.sourceText.replace('Audio Flamingo Next (Ghosh et\u00a0al., 2026). We freeze', 'Audio Flamingo Next. We freeze')
    ]) assert.ok(modelIssue(sentence, source), source.slice(0, 80));
});

test('上游基座身份不能覆盖作者发布、自研权重、派生模型或混合后句', () => {
    for (const body of [
        sentence + '本文权重现已公开并可下载。',
        sentence.replace('。', '且我们的权重已公开。'),
        sentence.replace('。', '，该论文微调后的模型权重可下载。'),
        '本文自研基座是开放权重的Audio Flamingo Next。',
        '我们发布的基座是开放权重的Audio Flamingo Next。',
        '本项目的基座是开放权重的Audio Flamingo Next。',
        '基座是开放权重的MusicTwins。',
        '基座是开放权重的UnknownDependency。',
        '基座是开放权重的Table 1。',
        '基座是开放权重的Figure 1。',
        '如果' + sentence + '本文权重已公开。',
        '不能声称' + sentence + '本文权重已公开。'
    ]) assert.ok(modelIssue(body), body);
    for (const ownership of ['We introduce Audio Flamingo Next.',
        'We release our model Audio Flamingo Next.', 'We release the weights of Audio Flamingo Next.',
        'We publicly release Audio Flamingo Next.', 'Our model Audio Flamingo Next is released.']) {
        assert.ok(modelIssue(sentence, saved.sourceText + '\n' + ownership), ownership);
    }
    assert.ok(issues(sentence + '本文代码已经公开。').some(issue => /本文 code /.test(issue.message)));
});

test('来源同名字符串或标题不能代替实际上游模型使用与引用', () => {
    for (const source of [
        'Audio Flamingo Next. We introduce MusicTwins.',
        'We "do not" use the open-weight audio-language model Audio Flamingo Next (Ghosh, 2026).',
        'We ```do not``` use the open-weight audio-language model Audio Flamingo Next (Ghosh, 2026).',
        'We <blockquote>do not</blockquote> use the open-weight audio-language model Audio Flamingo Next (Ghosh, 2026).',
        'We implement our framework “only hypothetically” using the open-weight audio-language model Audio Flamingo Next (Ghosh, 2026).',
        'We implement our framework\n> only hypothetically\nusing the open-weight audio-language model Audio Flamingo Next (Ghosh, 2026).',
        'We implement our framework using the open-weight audio-language model Table 1 (Smith, 2026).',
        'We implement our framework using the open-weight audio-language model MusicTwins (Smith, 2026). We introduce MusicTwins.',
        'We implement our framework using the open-weight audio-language model Audio Flamingo Next (Ghosh, 2026), but its weights are unavailable.'
    ]) assert.ok(modelIssue(sentence, source), source);
    for (const name of ['Table 1', 'Figure 1']) {
        assert.ok(modelIssue('基座是开放权重的' + name + '。',
            'We implement our framework using the open-weight audio-language model ' + name + ' (Smith, 2026).'), name);
    }
    assert.ok(modelIssue('基座是开放权重的MusicTwins。',
        'We implement our framework using the open-weight audio-language model MusicTwins (Smith, 2026). We introduce MusicTwins.'));
});

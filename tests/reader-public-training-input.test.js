'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Exact saved-source window, sourceTextSHA 930fdfd1… and assembled phrase:
// additional64-round2-shared-diagnosis/two-actual-cases.json (3fbfdf5a…).
const source = 'For model training, we used a subset of ∼120,000 hours\n'
    + 'of labeled English speech (with normalized transcripts) from            In the unified dual-mode training, we reduce the batch size\n'
    + 'the public Granary dataset [24]. For text tokenization, we used BPE tokenizer.';
const actual = '训练数据是公开 Granary 数据集的约 120,000 小时标注英文语音，转录为归一化文本。';
function identity(text) {
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(text), resources: [] };
    return { ...body, identitySha256: deep.stableFingerprint(body) };
}
function issues(text, evidence = source) {
    return deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] }, identity(evidence), evidence);
}
test('同名带引用公共训练输入可由真实混列原文支持，不授当前可用状态', () => {
    assert.deepEqual(issues(actual), []);
    assert.deepEqual(issues('训练数据是公开Granary数据集中约12万小时的英文标注语音。'), []);
    const other = 'We used speech from the public OpenCorpus dataset [7].';
    assert.deepEqual(issues('训练语料来自公开 OpenCorpus 数据集的标注语音。', other), []);
    assert.deepEqual(identity(source).resources, []);
});
test('错来源、引用、计划、否定与撤回不能支持原输入声明', () => {
    for (const evidence of [
        source.replace('public Granary', 'public AnotherCorpus'),
        'We do not use speech from the public Granary dataset [24].',
        'We used no speech from the public Granary dataset [24].',
        'We used speech other than from the public Granary dataset [24].',
        'We will use speech from the public Granary dataset [24].',
        'In the future, we use speech from the public Granary dataset [24].',
        'If funding is approved, we use speech from the public Granary dataset [24].',
        'A previous study reported: We used speech from the public Granary dataset [24].',
        'Smith et al. wrote: We used speech from the public Granary dataset [24].',
        'A previous study reports the following statement. We used speech from the public Granary dataset [24].',
        'The reviewer quotes: "We used speech from the public Granary dataset [24]."',
        'We used speech from the public Granary dataset [24] if funding is approved.',
        'We used speech from the public Granary dataset [24]. This claim is false.',
        'We used speech from the public Granary dataset [24]. This is false.',
        'We used speech from the public Granary dataset [24]. This description was withdrawn.'
    ]) assert.ok(issues(actual, evidence).length, evidence);
});
test('输入归属不掩盖作者自有发布或独立当前下载/可达声明', () => {
    for (const text of [
        '本文已公开自行采集的Granary数据集。',
        '我们新建的训练数据是公开Granary数据集。',
        '“训练数据是公开Granary数据集”是他人的说法。',
        actual + '本文新数据集当前已开放下载。',
        '训练数据是公开Granary数据集，当前可下载。',
        '训练数据是公开Granary数据集，该数据集链接经核验当前可达。',
        '训练数据是公开Granary数据集，当前可用。',
        '训练数据是公开Granary数据集，作者还已开源代码。'
    ]) assert.ok(issues(text).length, text);
});
test('Python资源展示沿同一私有FD桥使用训练输入归属规则', () => {
    const records = [[actual, source, true], [actual, source.replace('public Granary', 'public AnotherCorpus'), false],
        [actual + '本文新数据集当前已开放下载。', source, false]].map(([text, evidence, allowed]) => ({
        source: evidence, allowed, paper: {
            id: 'conference:interspeech:2026:conference-paper-id:training_input_fixture', source: 'conference',
            sourceSha256: sha(evidence), apiReaderResources: identity(evidence),
            apiReaderPlan: { sections: [{ kind: 'reproduction', heading: '实验与复现' }] },
            apiReaderArticle: '### 实验与复现\n\n' + text
        }
    }));
    const program = `import json,sys\nfrom paper_reader_presentation import replay_resource_presentation\nfor r in json.load(sys.stdin):\n try:\n  resources=replay_resource_presentation(r['paper'],r['source'])\n  assert r['allowed'] and resources == []\n except ValueError:\n  assert not r['allowed']\nprint('shared training-input bridge verified')\n`;
    const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', program], {
        input: JSON.stringify(records), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PYTHONPATH: path.resolve(__dirname, '../scripts') }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /shared training-input bridge verified/);
});

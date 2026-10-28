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
    'fixtures/reader-resource-semantic-current-20261027.json.gz'))));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const one = id => saved.cases.find(c => c.paperId === id);
const check = (c, body, source = c.sourceText) => {
    const resource = source === c.sourceText ? c.resourceIdentity : (() => {
        const identity = { contract: c.resourceIdentity.contract, sourceTextSha256: sha(source), resources: [] };
        return { ...identity, identitySha256: deep.stableFingerprint(identity) };
    })();
    return deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body }] }, resource, source);
};
const has = (issues, type) => issues.some(x => x.message.includes(`本文 ${type} `));

test('真实当前三稿保留原raw、节点、来源与历史计数，不把正常化空格当付费文本', () => {
    const before = JSON.stringify(saved);
    for (const c of saved.cases) {
        assert.equal(sha(c.sourceText), c.provenance.sourceTextSha256);
        assert.equal(sha(JSON.stringify(c.draft)), c.provenance.draftSha256);
        assert.equal(sha(c.rawDraft), c.provenance.rawDraftSha256);
        assert.equal(c.provenance.counters.transportFailures, 0);
        assert.equal(c.provenance.counters.fullAttempts, 1);
        assert.equal(c.provenance.counters.validationFailureStreak, 2);
        deep.readerResourceClaimIssues(c.draft, c.resourceIdentity, c.sourceText);
    }
    assert.equal(JSON.stringify(saved), before);
    const base = one('2610.32495');
    assert.ok(JSON.parse(base.rawDraft).sections[8].body.startsWith('基座是开放权重的Audio'));
    assert.equal(base.provenance.counters.attempts, 3);
    assert.equal(one('2610.34582').provenance.counters.attempts, 2);
    assert.equal(one('2610.33377').provenance.counters.attempts, 2);
});

test('真实开放权重基座的中文到ASCII空格正常化保留同一具名上游归属', () => {
    const c = one('2610.32495');
    assert.deepEqual(deep.readerResourceClaimIssues(c.draft, c.resourceIdentity, c.sourceText), []);
    const normalized = JSON.parse(c.rawDraft);
    normalized.sections[8].body = normalized.sections[8].body.replace('的Audio', '的 Audio');
    assert.deepEqual(deep.readerResourceClaimIssues(normalized, c.resourceIdentity, c.sourceText), []);
    assert.deepEqual(check(c, '基座是开放权重的\tAudio Flamingo Next。'), []);
    // Existing clause normalization joins prose line breaks before attribution.
    assert.deepEqual(check(c, '基座是开放权重的\nAudio Flamingo Next。'), []);
    assert.ok(has(check(c, '基座是开放权重的 Audio Flamingo Next。本文权重已公开。'), 'model'));
    assert.ok(has(check(c, '基座是开放权重的 Audio Flamingo Next。',
        c.sourceText.replace('We implement our framework using the open-weight', 'We did not implement our framework using the open-weight')), 'model'));
});

test('真实公开网页输入列表不承诺本文代码，完整稿仍保留作者1B权重实质阻断', () => {
    const c = one('2610.34582');
    for (const draft of [c.draft, JSON.parse(c.rawDraft)]) {
        const issues = deep.readerResourceClaimIssues(draft, c.resourceIdentity, c.sourceText);
        assert.equal(has(issues, 'code'), false);
        assert.equal(issues.length, 1);
        assert.equal(issues[0].path, '/sections/13/body');
        assert.ok(issues[0].conflictExcerpt.includes('复现只能靠已发布权重与文档'));
    }
});

test('输入语料豁免仅覆盖公开网页谓词，不能覆盖作者代码或后续可用声明', () => {
    const c = one('2610.34582');
    const input = '输入是公开网页、教育网页、代码、数学等文本词元';
    assert.deepEqual(check(c, input + '。'), []);
    for (const body of [input + '，本文代码已公开。', input + '。我们的代码可下载。',
        input + '，代码也已公开。', '本文代码' + input + '。',
        '本文代码是公开的，' + input + '。', '“' + input + '”的说法不成立，本文代码已公开。']) {
        assert.ok(has(check(c, body), 'code'), body);
    }
});

test('真实既有模型路线与本文1B作者权重逐谓词分离', () => {
    const c = one('2610.34582');
    const prior = '已有小模型路线多是蒸馏或微调已发布的大权重';
    assert.deepEqual(check(c, prior + '，或用2T到36T词元从零训练。'), []);
    for (const body of [prior + '，本文权重已公开。', prior + '。我们的权重可下载。',
        '本文' + prior + '。', '“' + prior + '”是错误说法。',
        '复现只能靠已发布权重与文档。']) assert.ok(has(check(c, body), 'model'), body);
});

test('真实三件事不同主张列表只说明概念差异，不把三条件断言为已满足', () => {
    const c = one('2610.33377');
    for (const draft of [c.draft, JSON.parse(c.rawDraft)]) {
        assert.deepEqual(deep.readerResourceClaimIssues(draft, c.resourceIdentity, c.sourceText), []);
    }
    assert.deepEqual(check(c, '需要分清三件事：代码开源、权重可下载、系统可运行是不同主张。'), []);
});

test('不同主张列表的作者前缀、引述、后置撤销、集体发布及混合后句仍拒绝', () => {
    const c = one('2610.33377');
    const list = '需要分清三件事：代码开源、权重可下载、系统可运行是不同主张';
    for (const body of ['本文的' + list + '。', '“' + list + '”的说法不成立。',
        list + '，上述区分已被撤回。', list + '，它们均已公开。',
        list + '，本文代码已公开。', list + '。我们的权重已公开。',
        list.replace('三件', '两件') + '。', list.replace('权重可下载', '代码公开') + '。']) {
        assert.ok(check(c, body).length, body);
    }
});

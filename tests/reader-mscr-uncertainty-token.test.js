'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const deep = require('../scripts/deep-analyzer');
const fixture = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,
    'fixtures/reader-mscr-real-paid-uncertainty.json.gz'))));
const table = body => body.split('\n').filter(line => line.startsWith('|')).join('\n');
function bind(f, body, index, prune = false) {
    return deep.bindApiReaderSourceEvidence(body, [{ ...f.draft.tableBindings[index], tableIndex: 1 }], [], {
        sourceText: f.sourceText, structuredArtifacts: f.structuredArtifacts,
        allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: prune
    });
}
test('真实MSCR付费稿的完整9条件和两方法及4消融条件不被重复±TeX裁掉', () => {
    const f = fixture();
    assert.equal(crypto.createHash('sha256').update(f.sourceText).digest('hex'), f.sourceFiles['source.txt']);
    assert.match(f.draft.tableBindings[0].sourceQuotes[2], /75\.7±\\pm1\.1/);
    for (const [section, binding] of [[9, 0], [12, 4]]) {
        const original = table(f.draft.sections[section].body);
        for (const prune of [false, true]) {
            const result = bind(f, original, binding, prune);
            assert.equal(table(result.article), original);
        }
    }
    assert.equal(table(f.draft.sections[9].body).split('\n')[0].split('|').length - 2, 10);
    assert.equal(table(f.draft.sections[9].body).split('\n').length, 4);
    assert.equal(table(f.draft.sections[12].body).split('\n').length, 7);
});
test('重复运算符只显露原完整不确定度，不改源字节、数字精度或命令边界', () => {
    assert.deepEqual(deep.readerNumericTokens('75.7±\\pm1.1 86.4±\\pm0.9'), ['75.7', '1.1', '86.4', '0.9']);
    assert.deepEqual(deep.readerNumericTokens('0.8±\\pm0.08'), ['0.8', '0.08']);
    assert.deepEqual(deep.readerNumericTokens('86.4±\\pm0.90'), ['86.4', '0.9']);
    for (const source of ['75.7±\\pmodel1.1', '75.7±\\pmvalue1.1', '75.7±\\pm1.1foo',
        '75.7±\\pm1.1.2', '75.7±\\mp1.1', '75.7\\pm1.1']) {
        assert.ok(!deep.readerNumericTokens(source).includes('1.1'), source);
    }
    assert.deepEqual(deep.readerNumericTokens('75.7±\\pm-1.1'),
        deep.readerNumericTokens('75.7±\\unknown-1.1'));
});
test('真实同稿错误均值、不确定度和单位仍缺来源；严格路径不删行冒充修复', () => {
    const f = fixture(), original = table(f.draft.sections[9].body);
    for (const changed of [original.replace('75.7 ± 1.1', '975.7123 ± 1.1'),
        original.replace('75.7 ± 1.1', '75.7 ± 91.1123'),
        original.replace('75.7 ± 1.1', '75.7 ms ± 1.1')]) {
        assert.throws(() => bind(f, changed, 0), /关键数字缺少 exact quote\/cell 证据/);
        assert.ok(changed.includes('| MSCR |'));
    }
    const changed = structuredClone(f);
    changed.draft.tableBindings[0].sourceQuotes[2] = changed.draft.tableBindings[0].sourceQuotes[2].replace('75.7', '975.7123');
    assert.throws(() => bind(changed, original.replace('75.7', '975.7123'), 0), /关键数字缺少 exact quote\/cell 证据/);
});

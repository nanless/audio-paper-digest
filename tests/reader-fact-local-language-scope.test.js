'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const claim = '下表比较两个方法，列数满足阅读需要，准确率为83.3%。';
const allowed = ['/sections/0/body'];

function sample(body = claim) {
    return { sections: [{ kind: 'result', heading: '实验结果', body }] };
}
function targets(draft, issues = repair.collectReaderLanguageIssues(draft), claims = [claim]) {
    return repair.buildRepairTargets(draft, issues, { readerFactLocalPaths: allowed, readerFactLocalClaims: claims });
}

test('完整授权原句内的真实语言诊断合并为同一正文目标，原诊断不修改', () => {
    const draft = sample('前文保持原样。\n' + claim + '\n后文保持原样。');
    const issues = repair.collectReaderLanguageIssues(draft);
    const original = structuredClone(issues);
    const actual = targets(draft, issues);
    assert.deepEqual(actual.map(item => item.path), allowed);
    assert.deepEqual(actual[0].authorizedClaims, [claim]);
    assert.deepEqual(issues, original);
});

test('同一正文内另一处相同语言问题不能借原句授权', () => {
    const draft = sample(claim + '\n另外一处列数满足阅读需要。');
    assert.deepEqual(targets(draft), []);
});

test('标题和其他正文的语言问题不能扩大到已授权小节', () => {
    const draft = sample();
    draft.sections[0].heading = '列数满足阅读需要';
    assert.deepEqual(targets(draft), []);
    draft.sections[0].heading = '实验结果';
    draft.sections.push({ kind: 'result', heading: '另一个结果', body: '另一处列数满足阅读需要。' });
    assert.deepEqual(targets(draft), []);
});

test('短词、重复原句和不存在的原句不授权正文改写', () => {
    assert.deepEqual(targets(sample(), undefined, ['列数满足阅读需要']), []);
    assert.deepEqual(targets(sample(claim + '\n' + claim)), []);
    assert.deepEqual(targets(sample(), undefined, ['另一篇文章的完整错误句，不存在于当前正文。']), []);
});

test('引用中的相同句不构成授权或干扰真实正文位置', () => {
    const draft = sample('> ' + claim + '\n\n' + claim);
    const actual = targets(draft);
    assert.deepEqual(actual.map(item => item.path), allowed);
    assert.equal(repair.verifiedReaderFactIssues(draft, [claim])[0].index, draft.sections[0].body.lastIndexOf(claim));
    assert.deepEqual(targets(sample('> ' + claim)), []);
});

test('未知问题及伪造的语言匹配不能绕过局部事实边界', () => {
    const draft = sample();
    assert.deepEqual(targets(draft, [{ code: 'source_binding_mismatch', path: allowed[0], message: '原来源不一致' }]), []);
    assert.deepEqual(targets(draft, [{ code: 'reader_workflow_leakage', path: allowed[0], match: '这句话不存在' }]), []);
});

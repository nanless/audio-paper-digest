'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../scripts/lib/tag-rules').createTagRules();
const deep = require('../scripts/deep-analyzer');
const { validAnalysisText } = require('./valid-analysis-fixture');

test('目录有子任务不能强制声源分类成为场景分类；已选父子仍拒绝', () => {
    const selection = { tags: ['#音频分类', '#CNN', '#低资源'], primaryTaskTag: '#音频分类', primaryMethodTag: '#CNN' };
    const validation = rules.validateTagSelection(selection);
    assert.equal(validation.valid, true);
    assert.equal(validation.specificityWarning, null);
    const child = rules.tagCatalog.concepts.find(item => item.broaderId === 'task.audio-classification' && item.status === 'active');
    assert.ok(child);
    const conflicting = rules.validateTagSelection({ ...selection, tags: [...selection.tags, `#${child.preferredLabel.zh}`] });
    assert.equal(conflicting.valid, false);
    assert.ok(conflicting.errors.some(error => error.includes('最具体')));
});

test('正常标签修复请求依据乐器分类原文保留父任务，其他正文逐字不变', async () => {
    const original = validAnalysisText();
    let calls = 0;
    const repaired = await deep.repairTagSelection({ arxivId: '2610.90088', title: 'Instrument classification' }, original,
        'The task classifies drums, acoustic guitar, classical guitar, saxophone and human voice. It is not acoustic scene recognition.',
        '纠正错误场景任务', { callModelFn: async messages => {
            calls++;
            assert.match(messages[0].content, /词表中存在下级概念/);
            assert.match(messages[0].content, /drums/);
            return JSON.stringify({ primaryTaskId: 'task.audio-classification', primaryMethodId: 'method.cnn', conceptIds: ['task.audio-classification', 'method.cnn', 'setting.low-resource'] });
        }});
    assert.equal(calls, 1);
    assert.equal(deep.parseAnalysis(repaired).tagValidation.primaryTaskId, 'task.audio-classification');
    assert.equal(deep.maskClassificationFields(repaired), deep.maskClassificationFields(original));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../scripts/manifest-new');

test('validateSpec 拒绝非法论文/路径/空值', () => {
    assert.throws(() => manifest.validateSpec({}), /paperId/);
    assert.throws(() => manifest.validateSpec({ paperId: '2610.12345' }), /replacements/);
    assert.throws(() => manifest.validateSpec({ paperId: '2610.12345', replacements: [{ path: '/sections/0/body', value: '' }] }), /value/);
    assert.throws(() => manifest.validateSpec({ paperId: '2610.12345', replacements: [{ path: '/bad', value: 'x' }] }), /path/);
});

test('nodeAt 支持节点路径并拒绝未知路径', () => {
    const draft = { sections: [{ body: 'a' }], tableBindings: [{ tableIndex: 1 }] };
    assert.strictEqual(manifest.nodeAt(draft, '/sections/0/body'), 'a');
    assert.strictEqual(manifest.nodeAt(draft, '/tableBindings/0'), draft.tableBindings[0]);
    assert.throws(() => manifest.nodeAt(draft, '/figurePlacements/0/explanation'), /节点/);
});

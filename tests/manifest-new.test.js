'use strict';
const test = require('node:test');
const assert = require('node:assert');
const manifest = require('../scripts/manifest-new');

test('findCandidate 用 exact ID + freshAnalysis.runId/sourceOnly 选择', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const repair = require('../scripts/lib/reader-repair.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-candidates-'));
    const old = repair.readFailedCandidateEnvelope;
    try {
        const files = ['a'.repeat(64) + '.json', 'b'.repeat(64) + '.json'];
        for (const name of files) fs.writeFileSync(path.join(dir, name), '{}');
        repair.readFailedCandidateEnvelope = (attemptsDir, _unused, file) => {
            const isOther = file.includes('a'.repeat(64));
            return {
                envelope: {
                    identity: {
                        paperId: isOther ? '2610.12345' : '2610.1234',
                        freshAnalysis: { runId: isOther ? 'run-other' : 'run-ok', sourceOnly: true }
                    },
                    payload: {}
                }
            };
        };
        const found = require('../scripts/manifest-new.js').findCandidate(dir, '2610.1234', 'run-ok');
        assert.ok(found);
        assert.ok(found.absolutePath.includes('b'.repeat(64)));
    } finally {
        repair.readFailedCandidateEnvelope = old;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files');

test('implementation closure includes shared Reader leaves and Python worker imports without executing them', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-closure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, text) => {
        const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    };
    write('scripts/entry.js', "throw new Error('must not execute'); require('./lib/reader'); const worker = 'worker.py';");
    write('scripts/lib/reader.js', "require('./table'); require('./reader');");
    write('scripts/lib/table.js', '// source unit evidence');
    write('scripts/worker.py', 'from source_binding import validate\n');
    write('scripts/source_binding.py', '# sealed source validation');
    assert.deepEqual(collectWorkflowImplementationFiles({ root, entryFiles: ['scripts/entry.js'] }), [
        'scripts/entry.js', 'scripts/lib/reader.js', 'scripts/lib/table.js', 'scripts/source_binding.py', 'scripts/worker.py'
    ]);
    write('scripts/lib/table.js', "require('./new-source-guard');");
    write('scripts/lib/new-source-guard.js', '// new correction must enter fingerprints');
    assert(collectWorkflowImplementationFiles({ root, entryFiles: ['scripts/entry.js'] }).includes('scripts/lib/new-source-guard.js'));
    assert.throws(() => collectWorkflowImplementationFiles({ root, entryFiles: ['../outside.js'] }), /leaves project/);
    assert.throws(() => collectWorkflowImplementationFiles({ root, entryFiles: ['scripts/missing.js'] }), /missing/);
    write('data/runtime/private.js', '// must never fingerprint run data');
    assert.throws(() => collectWorkflowImplementationFiles({ root, entryFiles: ['data/runtime/private.js'] }), /Runtime data/);
});

test('real conference dependency closure includes current daily Reader source guards', () => {
    const root = path.resolve(__dirname, '..');
    const files = collectWorkflowImplementationFiles({ root, entryFiles: ['scripts/analysis-engine.js', 'scripts/publish-to-blog.py'] });
    for (const file of ['scripts/lib/reader-sealed-pdf-column-units.js', 'scripts/reader_sealed_pdf_column_units.py',
        'scripts/lib/reader-source-display.js', 'scripts/lib/reader-resource-input-admission.js',
        'scripts/lib/prompt-evidence.js', 'scripts/prompt_evidence.py',
        'scripts/lib/git-prompt-evidence-index.json']) assert(files.includes(file), file);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files');

function dynamicRulesFixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workflow-data-dependency-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, bytes) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    };
    // The real collector source must itself be scanned, or owner literals in
    // a dependency declaration could silently promote the owner to a new root.
    write('scripts/lib/workflow-implementation-files.js', fs.readFileSync(require.resolve('../scripts/lib/workflow-implementation-files')));
    write('scripts/unrelated.js', "throw new Error('must not execute');");
    write('scripts/entry.js', "throw new Error('must not execute'); const worker = 'worker.py';");
    write('scripts/worker.py', 'from reader_grouped_vector_column_units import coverage\n');
    write('scripts/reader_grouped_vector_column_units.py', "raise Exception('must not execute')\n_RULES = json.loads((Path(__file__).with_name('lib') / 'validation-rules.json').read_text())\n");
    write('scripts/lib/validation-rules.json', '{"tableHeaderUnits":["%","kHz"]}\n');
    write('scripts/lib/unrelated-rules.json', '{"notUsed":true}\n');
    const collect = entry => collectWorkflowImplementationFiles({ root, entryFiles: [entry] });
    return { root, write, collect, rules: path.join(root, 'scripts/lib/validation-rules.json') };
}

test('dynamic rule dependency follows the actual Python owner, without self-scanning new roots', t => {
    const f = dynamicRulesFixture(t);
    for (const entry of ['scripts/entry.js', 'scripts/reader_grouped_vector_column_units.py']) {
        const files = f.collect(entry);
        assert(files.includes('scripts/reader_grouped_vector_column_units.py'));
        assert(files.includes('scripts/lib/validation-rules.json'));
        assert.equal(files.includes('scripts/lib/unrelated-rules.json'), false);
        assert.deepEqual(files, [...new Set(files)].sort());
    }
    const unrelated = f.collect('scripts/unrelated.js');
    assert.equal(unrelated.includes('scripts/reader_grouped_vector_column_units.py'), false);
    assert.equal(unrelated.includes('scripts/lib/validation-rules.json'), false);
    assert(unrelated.includes('scripts/lib/workflow-implementation-files.js'));
    fs.unlinkSync(f.rules);
    assert.deepEqual(f.collect('scripts/unrelated.js'), unrelated, 'unreachable owner cannot make its data globally required');
    assert.throws(() => f.collect('scripts/entry.js'), /Implementation file is missing/);
});

test('dynamic rule dependency refuses directories, leaf/parent symlinks and special files', t => {
    const f = dynamicRulesFixture(t);
    fs.unlinkSync(f.rules); fs.mkdirSync(f.rules);
    assert.throws(() => f.collect('scripts/entry.js'), /regular project file/);
    fs.rmdirSync(f.rules);
    const realRules = path.join(f.root, 'real-rules.json'); fs.writeFileSync(realRules, '{}');
    fs.symlinkSync(realRules, f.rules);
    assert.throws(() => f.collect('scripts/entry.js'), /regular project file/);
    fs.unlinkSync(f.rules);
    if (process.platform !== 'win32') {
        require('node:child_process').execFileSync('mkfifo', [f.rules]);
        assert.throws(() => f.collect('scripts/entry.js'), /regular project file/);
        fs.unlinkSync(f.rules);
    }
    fs.writeFileSync(f.rules, '{}');
    const library = path.join(f.root, 'scripts/lib'), relocated = path.join(f.root, 'relocated-library');
    fs.renameSync(library, relocated); fs.symlinkSync(relocated, library, 'dir');
    assert.throws(() => f.collect('scripts/entry.js'), /regular project file/);
});

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
        'scripts/lib/reader-source-display.js', 'scripts/lib/reader-scientific-quote-coverage.js',
        'scripts/lib/reader-resource-input-admission.js',
        'scripts/lib/prompt-evidence.js', 'scripts/prompt_evidence.py',
        'scripts/lib/git-prompt-evidence-index.json']) assert(files.includes(file), file);
});

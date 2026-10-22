'use strict';

// Build a conservative local dependency closure without executing any module.
// Fingerprints include the implementation that readers actually share, including
// Python workers and dynamically loaded local scripts, rather than a stale list.
const fs = require('node:fs');
const path = require('node:path');

const CODE = /\.(?:js|cjs|mjs|py|sh)$/;
// Prompt versions are selected explicitly by the caller. Scanning a registry's
// old .md paths would incorrectly make frozen, unused prompts invalidate current
// work. Only executable support files are inferred from literals.
const LOCAL_LITERAL = /['"]([^'"\n]+\.(?:js|cjs|mjs|py|sh))['"]/g;
const JS_IMPORT = /(?:require\s*\(\s*|(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?)(['"])(\.[^'"\n]+)\1/g;
const PY_IMPORT = /(?:^|\n)\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/g;

function collectWorkflowImplementationFiles({ root, entryFiles }) {
    if (!root || !Array.isArray(entryFiles) || !entryFiles.length) {
        throw new Error('Implementation closure requires a project root and entry files');
    }
    const base = fs.realpathSync(root);
    const seen = new Set();
    const pending = [];
    function local(candidate, required = false) {
        const absolute = path.resolve(base, candidate);
        const relative = path.relative(base, absolute).split(path.sep).join('/');
        if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
            if (required) throw new Error(`Implementation path leaves project: ${candidate}`);
            return null;
        }
        if (relative.split('/').some(part => ['data', 'logs', 'node_modules', '.venv', '.git', 'tmp', 'tests', 'fixtures'].includes(part))) {
            if (required) throw new Error(`Runtime data cannot be an implementation dependency: ${candidate}`);
            return null;
        }
        let stat;
        try { stat = fs.lstatSync(absolute); } catch (error) {
            if (required) throw new Error(`Implementation file is missing: ${relative}`, { cause: error });
            return null;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
            if (required) throw new Error(`Implementation file must be a regular project file: ${relative}`);
            return null;
        }
        return relative;
    }
    function add(candidate, required = false) {
        const relative = local(candidate, required);
        if (relative && !seen.has(relative)) { seen.add(relative); pending.push(relative); }
        return relative;
    }
    function resolveImport(specifier, filename) {
        const target = path.resolve(base, path.dirname(filename), specifier);
        for (const suffix of ['', '.js', '.cjs', '.mjs', '.json', '/index.js']) {
            const resolved = add(target + suffix);
            if (resolved) return;
        }
    }
    for (const entry of entryFiles) add(entry, true);
    // The collector itself controls the closure and is therefore fingerprinted.
    add('scripts/lib/workflow-implementation-files.js');
    while (pending.length) {
        const filename = pending.shift();
        // This Python matcher reads rule data through a dynamic Path expression.
        // Keep its stem separate from the extension: this collector scans its
        // own literals, and a full code filename here would create a new root.
        if (filename === 'scripts/reader_grouped_vector_column_units' + '.py') {
            add('scripts/lib/validation-rules.json', true);
        }
        if (['scripts/lib/prompt-evidence.js', 'scripts/prompt_evidence.py'].includes(filename)) {
            add('scripts/lib/git-prompt-evidence-index.json', true);
        }
        if (!CODE.test(filename)) continue;
        const text = fs.readFileSync(path.join(base, filename), 'utf8');
        for (const match of text.matchAll(JS_IMPORT)) resolveImport(match[2], filename);
        for (const match of text.matchAll(PY_IMPORT)) {
            const module = (match[1] || match[2]).replaceAll('.', '/');
            add(path.join(path.dirname(filename), module + '.py'));
            add('scripts/' + module + '.py');
        }
        for (const match of text.matchAll(LOCAL_LITERAL)) {
            const literal = match[1];
            for (const directory of [path.dirname(filename), '.', 'scripts', 'scripts/lib',
                'prompts', 'manual/scripts', 'manual/prompts', 'manual/docs']) {
                add(path.join(directory, literal));
            }
        }
    }
    return [...seen].sort();
}

module.exports = { collectWorkflowImplementationFiles };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../scripts/lib/prompt-text-versions');
const { readPromptEvidenceBytes } = require('../scripts/lib/prompt-evidence');

const root = path.resolve(__dirname, '..');

test('工作树只保留十八份当前Prompt与索引，退休全文不回流', () => {
    const current = registry.CURRENT_PROMPT_FILES;
    assert.ok(Object.isFrozen(current));
    assert.equal(current.length, 18);
    assert.equal(new Set(current).size, 18);
    const expected = [...Object.values(registry.PROMPT_FILE_VERSIONS).map(entry => entry.path),
        registry.LLM_FILTER_PROMPT_PATH, 'prompts/primary-fact-local-repair-v1.md',
        'prompts/api-reader-fact-local-v3.md', 'prompts/api-reader-concept-terms-v1.md'];
    assert.deepEqual([...current].sort(), expected.sort());
    assert.deepEqual(fs.readdirSync(path.join(root, 'prompts')).sort(),
        [...current.map(file => path.basename(file)), 'README.md'].sort());
    const retiredManual = path.join(root, 'manual/prompts');
    if (fs.existsSync(retiredManual)) {
        assert.deepEqual(fs.readdirSync(retiredManual).filter(file => /\.(?:md|txt)$/i.test(file)), []);
    }
    for (const file of current) {
        const stat = fs.lstatSync(path.join(root, file));
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), file);
        const bytes = readPromptEvidenceBytes(file);
        assert.deepEqual(bytes, fs.readFileSync(path.join(root, file)));
        assert.match(bytes.toString('utf8'), /^(`{3,}|~{3,})(?:text)?\r?\n[\s\S]*?\r?\n\1/m);
    }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('atomic JSON updates preserve a pre-existing private file mode and generation semantics', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-atomic-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'run.json');
    fs.writeFileSync(filename, JSON.stringify({ generation: 0, status: 'prepared' }), { mode: 0o600 });
    const { updateJsonFileLocked } = require('../scripts/analysis-engine.js');
    const result = updateJsonFileLocked(filename, current => ({ ...current, status: 'sources_ready' }));
    assert.equal(result.generation, 1);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    updateJsonFileLocked(filename, current => ({ ...current, status: 'analyzing' }));
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(filename, 'utf8')).generation, 2);
});

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const INDEX = fs.readFileSync(path.join(SCRIPTS, 'README.md'), 'utf8');

function runtimeFiles(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) return runtimeFiles(path.join(dir, entry.name), relative);
        return /\.(?:js|py)$/.test(entry.name) ? [relative.split(path.sep).join('/')] : [];
    });
}

test('scripts README 为每个受版本控制的运行时脚本提供职责索引', () => {
    const missing = runtimeFiles(SCRIPTS).filter(relative => !INDEX.includes(`\`${relative}\``));
    assert.deepEqual(missing, []);
    assert.match(INDEX, /manual\/scripts/);
    assert.match(INDEX, /默认 LLM\/API/);
    assert.match(INDEX, /共享兼容边界/);
});

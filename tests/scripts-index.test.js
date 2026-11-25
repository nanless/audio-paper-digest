const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIndexMarkdown } = require('../scripts/generate-scripts-index.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const GUIDE = fs.readFileSync(path.join(SCRIPTS, 'README.md'), 'utf8');
const INDEX = fs.readFileSync(path.join(SCRIPTS, 'INDEX.md'), 'utf8');

function runtimeFiles(dir, prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') return [];
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) return runtimeFiles(path.join(dir, entry.name), relative);
        return /\.(?:js|py)$/.test(entry.name) ? [relative.split(path.sep).join('/')] : [];
    });
}

test('scripts README 保留入口指南，自动生成的 INDEX.md 覆盖全部受控运行时脚本', () => {
    const missing = runtimeFiles(SCRIPTS).filter(relative => !INDEX.includes(`\`${relative}\``));
    assert.deepEqual(missing, []);
    assert.equal(INDEX, buildIndexMarkdown(), 'scripts/INDEX.md 与当前 scripts/ 目录不同步，请运行 node scripts/generate-scripts-index.js');
    assert.match(GUIDE, /INDEX\.md/);
    assert.match(GUIDE, /manual\/scripts/);
    assert.match(GUIDE, /默认 LLM\/API/);
    assert.match(GUIDE, /共享兼容边界/);
});

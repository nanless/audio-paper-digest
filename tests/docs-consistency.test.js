'use strict';
const test = require('node:test');
const assert = require('node:assert');
const docs = require('../scripts/docs-consistency');

test('checkDocs 报告不存在的 npm 命令', () => {
    const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'docs-consistency-'));
    const file = require('node:path').join(dir, 'x.md');
    require('node:fs').writeFileSync(file, '运行 npm run exists 与 npm run missing-command\n');
    const missing = docs.checkDocs([file], { exists: 'node x' });
    assert.deepStrictEqual(missing, [{ file, command: 'missing-command' }]);
    assert.throws(() => docs.checkDocs(['docs/does-not-exist.md'], {}), /文档不存在/);
    require('node:fs').rmSync(dir, { recursive: true, force: true });
});

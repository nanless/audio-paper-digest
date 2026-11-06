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

test('checkVersionClaims 认得出顿号、空格与只写构建号的写法', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-version-'));
    const file = path.join(dir, 'v.md');
    fs.writeFileSync(file, [
        '当前公开版本为 1.4.3、构建号 19',
        '客户端目前是 1.4.3 构建号 19',
        '当前构建号为 19',
        '当前版本 1.4.4（构建号 20）'
    ].join('\n'));
    const issues = docs.checkVersionClaims([file], { mac: { version: '1.4.4', build: '20' }, android: { version: '1.4.4', build: '20' } });
    assert.deepStrictEqual(issues.map(item => item.line), [1, 2, 3]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('checkLinks / checkForbidden / checkEnvNames 各自抓得住对应问题', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rules-'));
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(file, [
        '[缺失的目标](./nowhere.md)',
        '协议名写成 filter-v2 这种形式',
        '配置项 PD_NOT_A_REAL_FLAG 并不存在'
    ].join('\n'));
    assert.deepStrictEqual(docs.checkLinks([file]).map(item => item.line), [1]);
    assert.deepStrictEqual(docs.checkForbidden([file]).map(item => item.line), [2]);
    assert.deepStrictEqual(docs.checkEnvNames([file], undefined, new Set(['PD_REAL'])).map(item => item.line), [3]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('checkRegistration 递归扫子目录，漏登记的直接点名', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-registration-'));
    fs.mkdirSync(path.join(root, 'docs', 'images'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'listed.md'), '# 已登记\n');
    fs.writeFileSync(path.join(root, 'docs', 'images', 'README.md'), '# 子目录说明\n');
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '[已登记](listed.md)\n');
    fs.writeFileSync(path.join(root, 'docs', 'README.en.md'), '[listed](listed.md)\n');
    assert.deepStrictEqual(docs.checkRegistration(root).map(item => item.message), ['docs/images/README.md 未在文档索引中登记']);
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '[已登记](listed.md)\n[图说明](images/README.md)\n');
    assert.deepStrictEqual(docs.checkRegistration(root), []);
    fs.rmSync(root, { recursive: true, force: true });
});

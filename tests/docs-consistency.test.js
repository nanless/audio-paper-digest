'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const docs = require('../scripts/docs-consistency');

test('checkDocs 报告不存在的 npm 命令', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-consistency-'));
    const file = path.join(dir, 'x.md');
    fs.writeFileSync(file, '运行 npm run exists 与 npm run missing-command\n');
    const missing = docs.checkDocs([file], { exists: 'node x' });
    assert.deepStrictEqual(missing, [{ file, command: 'missing-command' }]);
    assert.throws(() => docs.checkDocs(['docs/does-not-exist.md'], {}), /文档不存在/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('checkVersionClaims 认得出中英文当前标记、顿号、空格与只写构建号的写法', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-version-'));
    const file = path.join(dir, 'v.md');
    fs.writeFileSync(file, [
        '当前公开版本为 1.4.3、构建号 19',
        '客户端目前是 1.4.3 构建号 19',
        '当前构建号为 19',
        'The current version is 1.4.3 (build 19).',
        '当前版本 1.4.4（构建号 20）'
    ].join('\n'));
    const issues = docs.checkVersionClaims([file], { mac: { version: '1.4.4', build: '20' }, android: { version: '1.4.4', build: '20' } });
    assert.deepStrictEqual(issues.map(item => item.line), [1, 2, 3, 4]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('checkLinks / checkForbidden / checkEnvNames 各自抓得住对应问题（含失效锚点）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-rules-'));
    const target = path.join(dir, 'target.md');
    fs.writeFileSync(target, '# 真实标题\n');
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(file, [
        '[缺失的目标](./nowhere.md)',
        '协议名写成 filter-v2 这种形式',
        '配置项 PD_NOT_A_REAL_FLAG 并不存在',
        '[有效锚点](./target.md#真实标题)',
        '[失效锚点](./target.md#不存在的锚点)'
    ].join('\n'));
    assert.deepStrictEqual(docs.checkLinks([file], dir).map(item => item.line), [1, 5]);
    assert.deepStrictEqual(docs.checkForbidden([file]).map(item => item.line), [2]);
    assert.deepStrictEqual(docs.checkEnvNames([file], undefined, new Set(['PD_REAL'])).map(item => item.line), [3]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('checkRegistration 递归扫子目录并要求中英文两份索引同时登记', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-registration-'));
    fs.mkdirSync(path.join(root, 'docs', 'images'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'listed.md'), '# 已登记\n');
    fs.writeFileSync(path.join(root, 'docs', 'images', 'README.md'), '# 子目录说明\n');
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '[已登记](listed.md)\n');
    fs.writeFileSync(path.join(root, 'docs', 'README.en.md'), '[listed](listed.md)\n');
    assert.deepStrictEqual(docs.checkRegistration(root).map(item => item.file), ['docs/README.md', 'docs/README.en.md']);
    fs.writeFileSync(path.join(root, 'docs', 'README.md'), '[已登记](listed.md)\n[图说明](images/README.md)\n');
    assert.deepStrictEqual(docs.checkRegistration(root).map(item => item.file), ['docs/README.en.md']);
    fs.writeFileSync(path.join(root, 'docs', 'README.en.md'), '[listed](listed.md)\n[diagrams](images/README.md)\n');
    assert.deepStrictEqual(docs.checkRegistration(root), []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('checkAgentsSize 与 checkEnvExampleSync 拦截超限 AGENTS.md 与未登记示例变量', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gates-'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(docs.MAX_AGENTS_BYTES + 1));
    fs.writeFileSync(path.join(root, 'env.example'), '# PD_TOTALLY_UNREGISTERED_KEY=1\n');
    assert.equal(docs.checkAgentsSize(root).length, 1);
    assert.equal(docs.checkEnvExampleSync(root).length, 1);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Compact\n');
    fs.writeFileSync(path.join(root, 'env.example'), '# PD_ANALYSIS_CONCURRENCY=3\n');
    assert.deepStrictEqual(docs.checkAgentsSize(root), []);
    assert.deepStrictEqual(docs.checkEnvExampleSync(root), []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('checkVersionClaims 拦截带分号/逗号括号的旧构建号与已发布版本的尚未公开发布矛盾', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-version-tight-'));
    const published = path.join(dir, 'published.md');
    const stale = path.join(dir, 'stale.md');
    fs.writeFileSync(published, '当前公开发行版本为 **1.5.0（构建号 24）**（2026-11-26 发布）。\n');
    fs.writeFileSync(stale, [
        '当前两端均为 1.4.6（构建号 22；Android versionCode 22）',
        '1.4.6 是当前公开发行版本（构建号 22）',
        '当前源码版本为 1.5.0（构建号 24）（尚未公开发布），最近公开发行版本为 1.4.7 / 构建号 23',
        '历史 1.3.7（未公开发行的源码中间版本）与当前公开发行版本 1.5.0（构建号 24）不冲突'
    ].join('\n'));
    const issues = docs.checkVersionClaims(
        [published, stale],
        { mac: { version: '1.5.0', build: '24' }, android: { version: '1.5.0', build: '24' } }
    );
    const lines = [...new Set(issues.map(item => item.line))].sort((a, b) => a - b);
    assert.deepStrictEqual(lines, [1, 2, 3]);
    fs.rmSync(dir, { recursive: true, force: true });
});

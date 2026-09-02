'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function markdownFiles() {
    const output = execFileSync('git', [
        'ls-files', '--cached', '--others', '--exclude-standard', '*.md'
    ], { cwd: ROOT, encoding: 'utf8' });
    return [...new Set(output.trim().split('\n'))]
        .filter(Boolean)
        .filter(relative => fs.existsSync(path.join(ROOT, relative)));
}

function relativeMarkdownLinks(source) {
    return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
        .map(match => match[1].trim().replace(/^<|>$/g, ''))
        .filter(target => target && !/^(?:https?:|mailto:|#|\/)/i.test(target));
}

test('所有文档的相对链接与 npm 命令都指向当前仓库权威入口', () => {
    const brokenLinks = [];
    const unknownCommands = [];
    for (const relative of markdownFiles()) {
        const filePath = path.join(ROOT, relative);
        const source = fs.readFileSync(filePath, 'utf8');
        for (const rawTarget of relativeMarkdownLinks(source)) {
            const targetWithoutAnchor = rawTarget.split('#')[0];
            if (!targetWithoutAnchor) continue;
            let decoded = targetWithoutAnchor;
            try { decoded = decodeURIComponent(targetWithoutAnchor); } catch {}
            if (!fs.existsSync(path.resolve(path.dirname(filePath), decoded))) {
                brokenLinks.push(`${relative} -> ${rawTarget}`);
            }
        }
        for (const match of source.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
            if (!PACKAGE.scripts[match[1]]) unknownCommands.push(`${relative} -> ${match[1]}`);
        }
    }
    assert.deepEqual(brokenLinks, []);
    assert.deepEqual(unknownCommands, []);
});

test('首页保持任务导向且默认流程与 Manual 边界清楚', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const lines = readme.split('\n').length;
    assert.ok(lines <= 200, `README.md 不应重新膨胀为内部协议手册: ${lines} 行`);
    for (const heading of [
        '## 你会得到什么', '## 默认行为', '## 5 分钟开始', '## 怎样才算完成',
        '## 核心命令', '## 失败后从哪里继续', '## 架构概览', '## 文档导航'
    ]) {
        assert.ok(readme.includes(heading), `README.md 缺少任务型章节: ${heading}`);
    }
    assert.ok(readme.indexOf('默认路线是 LLM/API') < readme.indexOf('Manual/人工高保障流程'));
    assert.doesNotMatch(readme, /node scripts\/manual-|prompts\/manual-|docs\/manual-v6/);
});

test('默认文档与 Manual 文档各有唯一导航入口', () => {
    const docsIndex = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
    const manualReadme = fs.readFileSync(path.join(ROOT, 'manual', 'README.md'), 'utf8');
    assert.match(docsIndex, /默认[^\n]*LLM\/API/);
    assert.match(docsIndex, /manual\/README\.md/);
    assert.match(manualReadme, /只有.*明确/);
    assert.match(manualReadme, /npm run digest:manual/);
});

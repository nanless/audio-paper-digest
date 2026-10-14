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
        // These two immutable protocol artifacts are hashed by the legacy
        // record verifier. Their historical links are provenance, not current
        // operation instructions; editing them would invalidate saved records.
        .filter(relative => !/^manual\/docs\/editorial-reference-contract(?:-v2)?\.md$/.test(relative))
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

test('首页保持任务导向且三流程与旧记录兼容边界清楚', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const lines = readme.split('\n').length;
    assert.ok(lines <= 200, `README.md 不应重新膨胀为内部协议手册: ${lines} 行`);
    for (const heading of [
        '## 你会得到什么', '## 默认行为', '## 5 分钟开始', '## 怎样才算完成',
        '## 核心命令', '## 失败后从哪里继续', '## 架构概览', '## 文档导航'
    ]) {
        assert.ok(readme.includes(heading), `README.md 缺少任务型章节: ${heading}`);
    }
    const defaultRouteIndex = readme.indexOf('默认路线是 LLM/API');
    const manualRouteIndex = readme.indexOf('Manual/人工流程');
    assert.ok(defaultRouteIndex >= 0, '首页应明确说明默认 API 路线');
    assert.ok(manualRouteIndex >= 0, '首页应说明显式人工流程');
    assert.ok(defaultRouteIndex < manualRouteIndex, '首页应先介绍默认路线，再介绍人工流程');
    assert.doesNotMatch(readme, /node scripts\/manual-|prompts\/manual-|docs\/manual-v6/);
});

test('现行三流程与旧记录核验各有唯一导航入口', () => {
    const docsIndex = fs.readFileSync(path.join(ROOT, 'docs', 'README.md'), 'utf8');
    const manualReadme = fs.readFileSync(path.join(ROOT, 'manual', 'README.md'), 'utf8');
    assert.match(docsIndex, /默认[^\n]*LLM\/API/);
    assert.match(docsIndex, /manual\/README\.md/);
    assert.match(manualReadme, /只有.*明确/);
    assert.match(manualReadme, /整批 Manual.*已退役/);
    assert.match(manualReadme, /npm run blog:manual-review/);
    assert.doesNotMatch(manualReadme, /npm run digest:manual/);
});

test('操作文档行内流程也不得使用已退休的历史公共别名', () => {
    const retired = /\bhistory:(?:direct-(?:inputs|plan|scheduler|run|aggregate|publication)|publication-metadata)\b/;
    for (const relative of markdownFiles()) {
        assert.doesNotMatch(fs.readFileSync(path.join(ROOT, relative), 'utf8'), retired,
            `${relative} 的行内流程含已退休入口；应使用 package.json 中的当前名称`);
    }
});

'use strict';

// 校验 tests/fixtures 顶层条目与 README 登记表一致。
// 只读取 README 文本和目录列表，不读取任何 fixture 内容，可离线快速运行。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixturesDir = path.join(__dirname, 'fixtures');
const readmePath = path.join(fixturesDir, 'README.md');

// __pycache__ 是 Python 运行缓存（已被 .gitignore 忽略），不是测试样本。
// .DS_Store 是 Finder 生成的目录元数据（同样被 .gitignore 忽略，但对 readdir 可见）。
const EXEMPT = new Set(['__pycache__', '.DS_Store']);

function isTableSeparator(line) {
    return /^\|[\s:|-]+\|$/.test(line);
}

function readmeTableEntryNames() {
    const text = fs.readFileSync(readmePath, 'utf8');
    const names = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('|') || isTableSeparator(line)) continue;
        // 只读取「登记文件 / 目录」列（第 2 列），避免把说明文字里的反引号当成登记项。
        const cell = line.split('|')[2] || '';
        for (const match of cell.matchAll(/`([^`]+)`/g)) names.push(match[1]);
    }
    return names;
}

function topLevelEntries() {
    return fs.readdirSync(fixturesDir).sort();
}

test('fixtures 顶层条目全部在 README 表格中登记', () => {
    const registered = new Set(readmeTableEntryNames());
    assert.ok(registered.size > 0, 'README 登记表为空或没有反引号登记条目');
    const missing = topLevelEntries().filter(name => !EXEMPT.has(name) && !registered.has(name));
    assert.deepEqual(missing, [], `README 表格缺少以下顶层条目的登记：${missing.join('、')}`);
});

test('README 表格登记的条目都实际存在于 fixtures 目录', () => {
    const existing = new Set(topLevelEntries());
    const unknown = [...new Set(readmeTableEntryNames())].filter(name => !existing.has(name));
    assert.deepEqual(unknown, [], `README 表格登记了磁盘上不存在的条目：${unknown.join('、')}`);
});

test('README 表格没有重复登记的条目', () => {
    const seen = new Set();
    const duplicates = new Set();
    for (const name of readmeTableEntryNames()) {
        if (seen.has(name)) duplicates.add(name);
        seen.add(name);
    }
    assert.deepEqual([...duplicates], [], `README 表格重复登记：${[...duplicates].join('、')}`);
});

#!/usr/bin/env node
'use strict';
// 检查文档里提到的 `npm run X` 是否都在 package.json scripts 里，防止文档漂移。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = ['README.md', 'AGENTS.md', 'docs/maintenance.md', 'scripts/README.md'];
const COMMAND = /npm run ([a-z][a-z0-9:_-]*)/g;

function checkDocs(files, scripts) {
    const known = new Set(Object.keys(scripts || {}));
    const missing = [];
    for (const file of files) {
        if (!fs.existsSync(path.resolve(ROOT, file))) continue;
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        for (const match of text.matchAll(COMMAND)) {
            if (!known.has(match[1])) missing.push({ file, command: match[1] });
        }
    }
    return missing;
}

function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json');
    const scripts = require('../package.json').scripts || {};
    const missing = checkDocs(DEFAULT_FILES, scripts);
    if (json) console.log(JSON.stringify({ missing }, null, 2));
    else if (!missing.length) console.log('文档命令一致性检查通过。');
    else for (const item of missing) console.log(`❌ ${item.file} 引用了不存在的命令：npm run ${item.command}`);
    return missing.length ? 1 : 0;
}

module.exports = { checkDocs, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[docs-consistency] ${error.message}`); process.exitCode = 2; }
}

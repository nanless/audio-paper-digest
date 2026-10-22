#!/usr/bin/env node
'use strict';
// 检查文档里提到的 `npm run X` 是否都在 package.json scripts 里，防止文档漂移。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOT_DOCS = ['README.md', 'AGENTS.md', 'scripts/README.md'];
const COMMAND = /npm run ([a-z][a-z0-9:_-]*)/g;

function markdownFiles(root = ROOT) {
    const files = ROOT_DOCS.slice();
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(target); }
            else if (entry.name.endsWith('.md')) files.push(path.relative(root, target));
        }
    };
    if (fs.existsSync(path.join(root, 'docs'))) walk(path.join(root, 'docs'));
    return files;
}

function checkDocs(files, scripts) {
    const known = new Set(Object.keys(scripts || {}));
    const missing = [];
    for (const file of files) {
        if (!fs.existsSync(path.resolve(ROOT, file))) throw new Error(`文档不存在：${file}`);
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        for (const match of text.matchAll(COMMAND)) {
            if (!known.has(match[1])) missing.push({ file, command: match[1] });
        }
    }
    return missing;
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('docs-consistency.js'); } catch (error) { console.error(`[docs-consistency] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const scripts = require('../package.json').scripts || {};
    const missing = checkDocs(markdownFiles(), scripts);
    if (json) console.log(JSON.stringify({ missing }, null, 2));
    else if (!missing.length) console.log('文档命令一致性检查通过。');
    else for (const item of missing) console.log(`❌ ${item.file} 引用了不存在的命令：npm run ${item.command}`);
    return missing.length ? 1 : 0;
}

module.exports = { checkDocs, main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[docs-consistency] ${error.message}`); process.exitCode = 2; }
}

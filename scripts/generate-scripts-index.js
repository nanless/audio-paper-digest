#!/usr/bin/env node
'use strict';

// 自动生成 scripts/INDEX.md，供维护者与 tests/scripts-index.test.js 查验脚本全集。
const fs = require('node:fs');
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const OUTPUT_FILE = path.join(SCRIPTS_DIR, 'INDEX.md');

function collectScriptFiles(dir = SCRIPTS_DIR, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out.push(...collectScriptFiles(path.join(dir, entry.name), relative));
        } else if (entry.isFile() && /\.(?:js|py)$/.test(entry.name)) {
            out.push(relative);
        }
    }
    return out.sort((a, b) => a.localeCompare(b, 'en'));
}

function extractSummary(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).slice(0, 35);
    const isPy = filePath.endsWith('.py');
    if (isPy) {
        const docMatch = raw.match(/^(?:#![^\n]*\n)?(?:#[^\n]*\n)*\s*(?:r?"""([\s\S]*?)"""|r?'''([\s\S]*?)''')/);
        if (docMatch) {
            const first = (docMatch[1] || docMatch[2] || '').trim().split(/\r?\n/)[0].trim();
            if (first) return cleanSummary(first);
        }
        for (const line of lines) {
            const t = line.trim();
            if (!t || t.startsWith('#!') || t.startsWith('# -*-')) continue;
            if (t.startsWith('#')) {
                const candidate = t.replace(/^#+\s*/, '').trim();
                if (candidate.length >= 4) return cleanSummary(candidate);
            } else if (/^(?:from|import|def|class)\b/.test(t)) {
                break;
            }
        }
    } else {
        let inBlock = false;
        for (const line of lines) {
            const t = line.trim();
            if (!t || t.startsWith('#!') || t === "'use strict';" || t === '"use strict";') continue;
            if (t.startsWith('/**') || t.startsWith('/*')) {
                inBlock = !t.includes('*/');
                const inner = t.replace(/^\/\*+\s*/, '').replace(/\*\/$/, '').trim();
                if (inner.length >= 4 && !inner.startsWith('@')) return cleanSummary(inner);
                continue;
            }
            if (inBlock) {
                if (t.includes('*/')) inBlock = false;
                const inner = t.replace(/^\*+\s*/, '').replace(/\*\/$/, '').trim();
                if (inner.length >= 4 && !inner.startsWith('@') && !/^[-=═─]+$/.test(inner)) return cleanSummary(inner);
                continue;
            }
            if (t.startsWith('//')) {
                const inner = t.replace(/^\/\/+\s*/, '').trim();
                if (inner.length >= 4 && !/^[-=═─]+$/.test(inner) && !/^eslint/i.test(inner)) return cleanSummary(inner);
                continue;
            }
            if (/^(?:const|let|var|function|class|module\.exports)\b/.test(t)) break;
        }
    }
    return defaultRoleDescription(filePath);
}

function cleanSummary(text) {
    return String(text || '')
        .replace(/\|/g, '／')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function defaultRoleDescription(filePath) {
    const rel = path.relative(SCRIPTS_DIR, filePath).split(path.sep).join('/');
    if (rel.startsWith('lib/')) return rel.endsWith('.py') ? 'Python 内部共享支撑模块' : 'Node 内部共享支撑模块';
    return rel.endsWith('.py') ? 'Python 流程脚本或共享模块' : 'Node 流程入口或共享模块';
}

function buildIndexMarkdown(files = collectScriptFiles()) {
    const topJs = files.filter(f => !f.includes('/') && f.endsWith('.js'));
    const topPy = files.filter(f => !f.includes('/') && f.endsWith('.py'));
    const libFiles = files.filter(f => f.startsWith('lib/'));
    const otherFiles = files.filter(f => f.includes('/') && !f.startsWith('lib/'));

    const renderSection = (title, items) => {
        if (!items.length) return [];
        const rows = [
            `## ${title}（${items.length}）`,
            '',
            '| 文件 | 职责摘要 |',
            '|---|---|'
        ];
        for (const rel of items) {
            const summary = extractSummary(path.join(SCRIPTS_DIR, rel));
            rows.push(`| \`${rel}\` | ${summary} |`);
        }
        rows.push('');
        return rows;
    };

    return [
        '# 脚本完整文件索引（自动生成）',
        '',
        '本文件由 `node scripts/generate-scripts-index.js` 根据 `scripts/` 目录自动生成，列出全部受版本控制的 `.js` 与 `.py` 运行时文件。',
        '架构分工与常用入口见 [脚本指南](README.md)（[English](README.en.md)）；旧记录兼容与独立人工审查位于 `manual/scripts/`。',
        '',
        `总计：**${files.length}** 个运行时文件（顶层 Node ${topJs.length} · 顶层 Python ${topPy.length} · \`lib/\` 内部库 ${libFiles.length}${otherFiles.length ? ` · 其余 ${otherFiles.length}` : ''}）。`,
        '',
        ...renderSection('顶层 Node 入口与共享模块', topJs),
        ...renderSection('顶层 Python 入口与共享模块', topPy),
        ...renderSection('内部支撑库（`scripts/lib/`）', libFiles),
        ...renderSection('其他子目录模块', otherFiles)
    ].join('\n');
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('generate-scripts-index.js');
    const checkOnly = argv.includes('--check');
    const content = buildIndexMarkdown();
    if (checkOnly) {
        const existing = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
        if (existing !== content) {
            console.error('[generate-scripts-index] scripts/INDEX.md 与当前 scripts/ 目录不一致，请运行 node scripts/generate-scripts-index.js 更新。');
            return 1;
        }
        console.log('[generate-scripts-index] scripts/INDEX.md 已与当前目录同步。');
        return 0;
    }
    fs.writeFileSync(OUTPUT_FILE, content, 'utf8');
    console.log(`[generate-scripts-index] 已更新 ${path.relative(ROOT, OUTPUT_FILE)}（${collectScriptFiles().length} 个文件）。`);
    return 0;
}

module.exports = { collectScriptFiles, extractSummary, buildIndexMarkdown, main };

if (require.main === module) {
    process.exitCode = main();
}

#!/usr/bin/env node
'use strict';
// 检查文档里的 npm 命令、客户端版本声明和工作台版本列表是否与仓库现状一致，防止文档漂移。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOT_DOCS = ['README.md', 'README.en.md', 'AGENTS.md', 'scripts/README.md'];
const MARKDOWN_DIRS = ['docs', 'skills'];
const COMMAND = /npm run ([a-z][a-z0-9:_-]*)/g;
const VERSION_CLAIMS = [
    /(\d+\.\d+\.\d+)（构建号\s*(\d+)）/g,
    /(\d+\.\d+\.\d+)[、,，]\s*构建号\s*(\d+)/g,
    /(\d+\.\d+\.\d+)\s+构建号\s*(\d+)/g,
    /(\d+\.\d+\.\d+)\s*\(build\s*(\d+)\)/gi,
    /(\d+\.\d+\.\d+),\s*build\s*(\d+)/gi
];
// 只写构建号、版本在同句省略的写法，例如「当前构建号为 19」。
const BUILD_ONLY = /构建号为\s*(\d+)/;
const CURRENT_MARKER = /当前|目前|现在/;
const VERSION_DOCS = ['docs/README.md', 'docs/README.en.md'];
const VERSION_LIST = /工作台版本|Workbench versions/;
const PLIST = 'apps/macos/Info.plist';
const GRADLE = 'apps/android/app/build.gradle.kts';

function markdownFiles(root = ROOT) {
    const files = ROOT_DOCS.slice();
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(target); }
            else if (entry.name.endsWith('.md')) files.push(path.relative(root, target));
        }
    };
    for (const directory of MARKDOWN_DIRS) {
        if (fs.existsSync(path.join(root, directory))) walk(path.join(root, directory));
    }
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

function readVersionSources() {
    const plist = fs.readFileSync(path.resolve(ROOT, PLIST), 'utf8');
    const gradle = fs.readFileSync(path.resolve(ROOT, GRADLE), 'utf8');
    const plistVersion = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    const plistBuild = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
    const gradleVersion = gradle.match(/versionName\s*=\s*"([^"]+)"/);
    const gradleBuild = gradle.match(/versionCode\s*=\s*(\d+)/);
    if (!plistVersion || !plistBuild || !gradleVersion || !gradleBuild) {
        throw new Error('无法从 Info.plist 或 build.gradle.kts 读取版本号与构建号');
    }
    return {
        mac: { version: plistVersion[1].trim(), build: plistBuild[1].trim() },
        android: { version: gradleVersion[1], build: gradleBuild[1] }
    };
}

// 历史评审记录保留当时的版本和结论，不参与核对。当前发行线内的“版本（构建号）”
// 写法，以及同一行明说“当前/目前/现在”的旧版本写法，按当前实际值核对。
function checkVersionClaims(files, versions) {
    const issues = [];
    const current = versions.mac;
    const line = current.version.split('.').slice(0, 2).join('.');
    if (current.version !== versions.android.version || current.build !== versions.android.build) {
        issues.push({
            file: `${PLIST} / ${GRADLE}`,
            message: `两端版本不一致：macOS ${current.version}（构建号 ${current.build}），Android ${versions.android.version}（构建号 ${versions.android.build}）`
        });
    }
    for (const file of files) {
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            const claims = VERSION_CLAIMS.flatMap(pattern => [...lines[index].matchAll(pattern)]);
            const currentState = CURRENT_MARKER.test(lines[index]);
            if (!claims.length) {
                // 「当前构建号为 19」这种只写构建号的写法，同样按当前值核对。
                const buildOnly = BUILD_ONLY.exec(lines[index]);
                if (buildOnly && currentState && buildOnly[1] !== current.build) {
                    issues.push({ file, line: index + 1, message: `写的是构建号 ${buildOnly[1]}，实际为 ${current.build}` });
                }
                continue;
            }
            for (const claim of claims) {
                const sameLine = claim[1].split('.').slice(0, 2).join('.') === line;
                if (!sameLine && !currentState) continue;
                if (claim[1] === current.version && claim[2] === current.build) continue;
                issues.push({
                    file,
                    line: index + 1,
                    message: `写的是 ${claim[1]}（构建号 ${claim[2]}），实际为 ${current.version}（构建号 ${current.build}）`
                });
            }
        }
    }
    return issues;
}

function checkVersionLists(versions) {
    const issues = [];
    for (const file of VERSION_DOCS) {
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        const list = text.split('\n').find(item => VERSION_LIST.test(item)) || '';
        if (!list.includes(`workbench-${versions.mac.version}-review.md`)) {
            issues.push({ file, message: `工作台版本列表缺少当前版本 ${versions.mac.version}` });
        }
    }
    return issues;
}

// 文档里的相对链接必须指向真实文件；安装副本（如 ~/.codex/skills）另由
// tests/documentation.test.js 按 skill 目录范围单独核验。
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(files, root = ROOT) {
    const issues = [];
    for (const file of files) {
        const text = fs.readFileSync(path.resolve(root, file), 'utf8');
        text.split('\n').forEach((line, index) => {
            for (const match of line.matchAll(LINK)) {
                const raw = match[1].replace(/^<|>$/g, '');
                const target = raw.split('#')[0].split('?')[0];
                if (!target || /^(https?:|mailto:|tel:|data:)/i.test(target)) continue;
                const resolved = target.startsWith('/') ? path.join(root, target) : path.resolve(root, path.dirname(file), target);
                if (!fs.existsSync(resolved)) issues.push({ file, line: index + 1, message: `链接目标不存在：${match[1]}` });
            }
        });
    }
    return issues;
}

// docs/ 下每篇文章都要在两份索引里至少出现一次，避免新增文档只有作者知道。
// 递归子目录：docs/images/README.md 这类说明同样要能被索引找到。
function checkRegistration(root = ROOT) {
    const docsDir = path.join(root, 'docs');
    if (!fs.existsSync(docsDir)) return [];
    const index = ['docs/README.md', 'docs/README.en.md']
        .filter(name => fs.existsSync(path.join(root, name)))
        .map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
    const entries = [];
    const walk = (directory, prefix) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(path.join(directory, entry.name), relative); continue; }
            if (entry.name.endsWith('.md')) entries.push(relative);
        }
    };
    walk(docsDir, '');
    const issues = [];
    for (const entry of entries) {
        if (entry === 'README.md' || entry === 'README.en.md') continue;
        if (!index.includes(entry)) issues.push({ file: 'docs/README.md', message: `docs/${entry} 未在文档索引中登记` });
    }
    return issues;
}

// 已废弃写法：带版本号后缀的协议名、旧工作区路径。
const FORBIDDEN = [
    { pattern: /协议[^\n]{0,12}?-[vV]\d+\b/, message: '协议名带 -vN 版本后缀，应改为稳定名称 + 结构指纹' },
    {
        pattern: /audio-paper-digest-rewrite-all/,
        message: '引用了已废弃的旧工作区，当前工作区是 audio-paper-digest',
        // 明确说明「已废弃」的句子本身是提醒，不是违规引用。
        unless: /废弃|不再|旧工作区/
    }
];

function checkForbidden(files, root = ROOT) {
    const issues = [];
    for (const file of files) {
        const text = fs.readFileSync(path.resolve(root, file), 'utf8');
        text.split('\n').forEach((line, index) => {
            for (const rule of FORBIDDEN) {
                if (!rule.pattern.test(line)) continue;
                if (rule.unless && rule.unless.test(line)) continue;
                issues.push({ file, line: index + 1, message: rule.message });
            }
        });
    }
    return issues;
}

// 文档提到的 PD_* 环境变量必须真的被代码读取。
const ENV_NAME = /\bPD_[A-Z0-9_]+\b/g;
const ENV_DIRS = ['scripts', 'apps/macos', 'apps/android', 'apps/src', 'tests'];

function collectEnvNames(root = ROOT) {
    const names = new Set();
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) { walk(target); continue; }
            if (!/\.(js|mjs|cjs|py|sh|ts|kt|swift)$/.test(entry.name)) continue;
            for (const match of fs.readFileSync(target, 'utf8').matchAll(ENV_NAME)) names.add(match[0]);
        }
    };
    for (const directory of ENV_DIRS) {
        const target = path.join(root, directory);
        if (fs.existsSync(target)) walk(target);
    }
    return names;
}

function checkEnvNames(files, root = ROOT, known = collectEnvNames(root)) {
    const issues = [];
    for (const file of files) {
        const text = fs.readFileSync(path.resolve(root, file), 'utf8');
        text.split('\n').forEach((line, index) => {
            for (const match of line.matchAll(ENV_NAME)) {
                // 表格里的通配写法（如 PD_API_READER_*_MAX_CHARS）只给出前缀，跳过。
                if (match[0].endsWith('_')) continue;
                if (!known.has(match[0])) issues.push({ file, line: index + 1, message: `环境变量 ${match[0]} 在代码里不存在` });
            }
        });
    }
    return issues;
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('docs-consistency.js'); } catch (error) { console.error(`[docs-consistency] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const scripts = require('../package.json').scripts || {};
    const files = markdownFiles();
    const missing = checkDocs(files, scripts);
    const versions = readVersionSources();
    const versionIssues = checkVersionClaims(files, versions).concat(checkVersionLists(versions));
    const linkIssues = checkLinks(files);
    const registrationIssues = checkRegistration();
    const forbiddenIssues = checkForbidden(files);
    const envIssues = checkEnvNames(files);
    const total = missing.length + versionIssues.length + linkIssues.length
        + registrationIssues.length + forbiddenIssues.length + envIssues.length;
    if (json) console.log(JSON.stringify({ missing, versionIssues, linkIssues, registrationIssues, forbiddenIssues, envIssues }, null, 2));
    else if (!total) console.log('文档命令、版本、链接、登记、废弃写法与环境变量检查通过。');
    else {
        for (const item of missing) console.log(`❌ ${item.file} 引用了不存在的命令：npm run ${item.command}`);
        for (const item of versionIssues) console.log(`❌ ${item.file}${item.line ? `:${item.line}` : ''} ${item.message}`);
        for (const item of linkIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
        for (const item of registrationIssues) console.log(`❌ ${item.file} ${item.message}`);
        for (const item of forbiddenIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
        for (const item of envIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
    }
    return total ? 1 : 0;
}

module.exports = {
    checkDocs, checkVersionClaims, checkVersionLists, main, markdownFiles, readVersionSources,
    checkLinks, checkRegistration, checkForbidden, checkEnvNames, collectEnvNames
};

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[docs-consistency] ${error.message}`); process.exitCode = 2; }
}

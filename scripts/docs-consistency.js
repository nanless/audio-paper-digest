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
    /(\d+\.\d+\.\d+)，构建号\s*(\d+)/g,
    /(\d+\.\d+\.\d+)\s*\(build\s*(\d+)\)/gi,
    /(\d+\.\d+\.\d+),\s*build\s*(\d+)/gi
];
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
            if (!claims.length) continue;
            const currentState = CURRENT_MARKER.test(lines[index]);
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

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('docs-consistency.js'); } catch (error) { console.error(`[docs-consistency] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const scripts = require('../package.json').scripts || {};
    const files = markdownFiles();
    const missing = checkDocs(files, scripts);
    const versions = readVersionSources();
    const versionIssues = checkVersionClaims(files, versions).concat(checkVersionLists(versions));
    if (json) console.log(JSON.stringify({ missing, versionIssues }, null, 2));
    else if (!missing.length && !versionIssues.length) console.log('文档命令与版本一致性检查通过。');
    else {
        for (const item of missing) console.log(`❌ ${item.file} 引用了不存在的命令：npm run ${item.command}`);
        for (const item of versionIssues) console.log(`❌ ${item.file}${item.line ? `:${item.line}` : ''} ${item.message}`);
    }
    return missing.length || versionIssues.length ? 1 : 0;
}

module.exports = { checkDocs, checkVersionClaims, checkVersionLists, main, markdownFiles, readVersionSources };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[docs-consistency] ${error.message}`); process.exitCode = 2; }
}

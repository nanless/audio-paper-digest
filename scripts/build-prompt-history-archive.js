#!/usr/bin/env node
'use strict';

// prompts/ 下的 v1 提示词本来设计成永久冻结，实际被多次就地改写，于是存量数据里
// 记录的提示词 SHA 大多指向只存在于 git 历史里的字节。这个脚本把那些被引用的历史
// 版本按原始字节抽到 prompts/history/<sha256>.md，供 prompt-history.js 在「声明的
// SHA 与当前文件不符」时取用。
//
// 默认只报告不落盘；加 --write 才写文件。重复运行不改变已有文件。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { requireExternalRuntime } = require('./env-loader.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(PROJECT_ROOT, 'prompts', 'history');
const PROMPTS_PREFIX = 'prompts/';

function git(args, options = {}) {
    return execFileSync('git', args, {
        cwd: PROJECT_ROOT,
        maxBuffer: 1 << 30,
        ...options
    });
}

function gitText(args) {
    return git(args).toString('utf8');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// prompts/ 下出现过的每个文件路径（不含 prompts/history/ 自己）。
function listPromptPaths() {
    const output = gitText([
        'log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A', '--', `${PROMPTS_PREFIX}**`
    ]);
    const paths = new Set();
    for (const line of output.split('\n')) {
        const value = line.trim();
        if (!value || !value.startsWith(PROMPTS_PREFIX)) continue;
        if (value.startsWith(`${PROMPTS_PREFIX}history/`)) continue;
        if (!/\.(md|txt)$/i.test(value)) continue;
        paths.add(value);
    }
    return [...paths].sort();
}

// 一个路径在历史上的全部 blob。逐个「改动过这个路径的提交」取该提交与它父提交的
// 版本，两者合起来就是沿这条路径出现过的所有内容。
function historicalBlobs(relativePath) {
    const commits = gitText(['log', '--all', '--format=%H', '--', relativePath])
        .split('\n').map(line => line.trim()).filter(Boolean);
    const oids = new Set();
    for (const commit of commits) {
        for (const revision of [commit, `${commit}^`]) {
            try {
                const oid = gitText(['rev-parse', '-q', '--verify', `${revision}:${relativePath}`]).trim();
                if (oid) oids.add(oid);
            } catch (_error) {
                // 该提交没有这个路径（新增文件时的父提交），跳过。
            }
        }
    }
    return [...oids];
}

function firstFencedBlock(text) {
    const match = text.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m);
    return match ? match[2] : null;
}

function templateSha256(text, contractVersion) {
    const block = firstFencedBlock(text);
    if (block === null) return null;
    return crypto.createHash('sha256')
        .update(JSON.stringify({ runtimePrompt: block, contractVersion: String(contractVersion || '') }))
        .digest('hex');
}

// 存量数据里出现过的候选 SHA。凡是 64 位十六进制字符串都收，不按字段名筛：
// 有些记录把提示词 SHA 存在不含 prompt 的字段里（例如 tag-taxonomy-audit 的
// `taxonomyReferenceSha256` 存的是 deep-analysis 提示词的身份），只看字段名会漏。
// 候选后面还要按「整文件字节」或「首块模板」去提示词历史里对，对不上就不是提示词版本。
function collectReferencedPromptSha256() {
    let listing = '';
    try {
        listing = execFileSync('rg', [
            '-l', '--no-messages',
            '"[0-9a-f]{64}"',
            'data', '--glob', '*.json'
        ], { cwd: PROJECT_ROOT, maxBuffer: 1 << 30 }).toString('utf8');
    } catch (error) {
        // 只有没有匹配项的退出码 1 表示空集合；工具或目录读取失败必须保留。
        if (error.status !== 1) throw error;
        listing = error.stdout ? error.stdout.toString('utf8') : '';
    }
    const files = listing.split('\n').map(line => line.trim()).filter(Boolean);
    const referenced = new Set();
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        for (const child of Object.values(value)) {
            if (typeof child === 'string' && /^[a-f0-9]{64}$/.test(child)) {
                referenced.add(child);
            } else if (child && typeof child === 'object') {
                visit(child);
            }
        }
    };
    for (const file of files) {
        const parsed = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8'));
        visit(parsed);
    }
    return { referenced, fileCount: files.length };
}

// 记录里声明的版本号会进首块模板哈希。归档不假设具体取值，把见过的版本都试一遍。
const TEMPLATE_CONTRACT_VERSIONS = [
    '', 'analysis-prompt-text-v1', 'analysis-prompt-text-v2',
    'v1', 'v2', 'scoring-audit-v1', 'api-reader-v1', 'api-reader-v2'
];

function collectArchiveEntries() {
    const referenced = collectReferencedPromptSha256();
    const entries = new Map();
    for (const relativePath of listPromptPaths()) {
        for (const oid of historicalBlobs(relativePath)) {
            const bytes = git(['cat-file', '-p', oid]);
            const whole = sha256(bytes);
            if (entries.has(whole)) continue;
            const text = bytes.toString('utf8');
            const templates = new Set();
            for (const contractVersion of TEMPLATE_CONTRACT_VERSIONS) {
                const value = templateSha256(text, contractVersion);
                if (value) templates.add(value);
            }
            const wholeReferenced = referenced.referenced.has(whole);
            const templateReferenced = [...templates].filter(value => referenced.referenced.has(value));
            if (!wholeReferenced && templateReferenced.length === 0) continue;
            entries.set(whole, {
                sha256: whole,
                oid,
                relativePath,
                bytes,
                wholeReferenced,
                templateReferenced
            });
        }
    }
    return { entries, referenced };
}

function readExisting(file) {
    try {
        return fs.readFileSync(file);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
    }
}

// 归档文件名就是内容 SHA，写到一半被中断会留下一个文件名与内容不符的 <sha>.md。
// 所以先写临时文件并 fsync，再 rename 到位；目录也 fsync 一次，让改名在断电后还在。
// 替换已有文件时保留它原来的权限位（归档现在是 0644），新文件用 0600。
function writeArchiveFile(file, bytes) {
    const directory = path.dirname(file);
    const temporary = path.join(directory,
        `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let mode = 0o600;
    try {
        const stat = fs.lstatSync(file);
        if (stat.isFile()) mode = stat.mode & 0o777;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    try {
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
            | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
        try {
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, file);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
    try {
        const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
            fs.fsyncSync(directoryFd);
        } finally {
            fs.closeSync(directoryFd);
        }
    } catch (error) {
        // 目录 fsync 在少数文件系统上不被支持，但文件已经 rename 到位了。
        if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    }
}

function writeArchive(entries, directory = HISTORY_DIR) {
    fs.mkdirSync(directory, { recursive: true });
    let written = 0;
    let unchanged = 0;
    for (const entry of entries) {
        const file = path.join(directory, `${entry.sha256}.md`);
        const existing = readExisting(file);
        if (existing && existing.equals(entry.bytes)) {
            unchanged += 1;
            continue;
        }
        writeArchiveFile(file, entry.bytes);
        written += 1;
    }
    return { written, unchanged };
}

function report(entries, referenced, extra = {}) {
    const sorted = [...entries.values()].sort((a, b) =>
        (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
        || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
    const totalBytes = sorted.reduce((sum, entry) => sum + entry.bytes.length, 0);
    const byPath = new Map();
    for (const entry of sorted) {
        const bucket = byPath.get(entry.relativePath) || { versions: 0, bytes: 0 };
        bucket.versions += 1;
        bucket.bytes += entry.bytes.length;
        byPath.set(entry.relativePath, bucket);
    }
    console.log(`候选数据文件（含提示词 SHA 字段）: ${referenced.fileCount}`);
    console.log(`数据里出现过的候选 SHA 值: ${referenced.referenced.size}`);
    console.log(`能对上 git 历史的版本: ${sorted.length}`);
    console.log(`  其中按整文件字节命中: ${sorted.filter(entry => entry.wholeReferenced).length}`);
    console.log(`  仅按首块模板哈希命中: ${sorted.filter(entry => !entry.wholeReferenced).length}`);
    console.log(`总字节: ${totalBytes}（${(totalBytes / 1024).toFixed(1)} KB）`);
    if (extra.written !== undefined) {
        console.log(`本次写入: ${extra.written} 个，未改动: ${extra.unchanged} 个`);
    }
    console.log('按文件分布:');
    for (const [relativePath, bucket] of [...byPath.entries()].sort((a, b) => b[1].versions - a[1].versions)) {
        console.log(`  ${relativePath}: ${bucket.versions} 个版本，${bucket.bytes} 字节`);
    }
    return { totalBytes, count: sorted.length, byPath };
}

function main() {
    requireExternalRuntime('build-prompt-history-archive.js');
    const write = process.argv.includes('--write');
    const { entries, referenced } = collectArchiveEntries();
    const stats = report(entries, referenced, write ? writeArchive([...entries.values()]) : {});
    if (!write) {
        console.log('（只报告，未落盘。加 --write 落盘到 prompts/history/）');
    }
    return stats;
}

if (require.main === module) {
    main();
}

module.exports = { main, collectArchiveEntries, writeArchive, writeArchiveFile, HISTORY_DIR };

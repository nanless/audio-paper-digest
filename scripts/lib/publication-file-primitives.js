'use strict';

// 共享的不可变文件与博客 Git 基线原语。新历史发布不再装载旧发布流程。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fresh = require('./fresh-rewrite-run.js');
const { writeImmutableFile } = require('./immutable-file.js');
const stableHash = fresh.stableHash;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(message) {
    const error = new Error(`发布文件核验未通过：${message}`);
    error.code = 'PUBLICATION_FILE_INTEGRITY'; throw error;
}
function directoryIdentity(directory) {
    // Node 可用 O_NOFOLLOW 拒绝末级符号链接，但没有可移植的逐级 openat(2) 接口。
    // 因此先检查父目录路径，再在文件读写前后比较父目录的设备号和 inode；
    // 检测到替换就拒绝继续。这不能发现特权进程在两次检查之间替换又恢复整条路径，
    // 该限制属于操作系统边界，不能据此声称本模块核验了这种变化。
    const absolute = fresh.assertSafeDirectory(directory); const stat = fs.lstatSync(absolute, { bigint: true });
    return { absolute, dev: stat.dev, ino: stat.ino };
}
function sameDirectory(left, right) { return left.absolute === right.absolute && left.dev === right.dev && left.ino === right.ino; }
function readRegular(filename, maximum = 128 * 1024 * 1024, dependencies = {}) {
    let fd; const parentBefore = directoryIdentity(path.dirname(filename));
    try { const before = fs.lstatSync(filename, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1n && !(dependencies.allowPendingLink && before.nlink === 2n)) || before.size > BigInt(maximum)) fail(`来源文件不安全：类型、链接数或大小不符合要求：${filename}`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== before.nlink || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > BigInt(maximum)) fail(`打开后来源文件不安全：类型、链接数、大小或身份不符合要求：${filename}`);
        dependencies.afterOpen?.(filename);
        const named = fs.lstatSync(filename, { bigint: true });
        if (!opened.isFile() || opened.nlink !== before.nlink || named.isSymbolicLink() || named.nlink !== before.nlink
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
            || opened.size > BigInt(maximum)) fail(`打开后来源文件不安全：类型、链接数、大小或身份不符合要求：${filename}`);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true }); const namedAfter = fs.lstatSync(filename, { bigint: true });
        if (BigInt(bytes.length) !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.nlink !== opened.nlink || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino || namedAfter.nlink !== opened.nlink || namedAfter.size !== opened.size
            || namedAfter.mtimeNs !== opened.mtimeNs || namedAfter.ctimeNs !== opened.ctimeNs
            || !sameDirectory(parentBefore, directoryIdentity(path.dirname(filename)))) fail(`读取时文件的身份、大小、修改时间或父目录发生变化，或读取字节数与记录不一致：${filename}`);
        return { bytes, sha256: sha256(bytes) }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeExact(filename, bytes) {
    const payload = Buffer.from(bytes);
    if (payload.length > 128 * 1024 * 1024) fail(`不可变发布文件超过大小限制：${filename}`);
    fresh.assertSafeDirectory(path.dirname(filename), true);
    writeImmutableFile(filename, payload, (message, details) => {
        if (details?.code === 'IMMUTABLE_FILE_CONTENT_CONFLICT') {
            const error = new Error(`历史发布检查未通过：${message}：${filename}`);
            error.code = details.code;
            throw error;
        }
        fail(`${message}：${filename}`);
    });
    const verified = readRegular(filename);
    if (!verified.bytes.equals(payload)) fail(`写入后的文件内容与待写入字节不一致：${filename}`);
    return verified.sha256;
}
function runGit(blogRepo, args, { text = true, maximum = 128 * 1024 * 1024 } = {}) {
    const result = spawnSync('git', ['-C', blogRepo, ...args], { encoding: text ? 'utf8' : null,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: maximum });
    if (result.error || result.signal || result.status !== 0) fail(`Git 命令 ${args[0]} 执行失败（${result.error?.message || result.signal || result.status}）。`);
    return text ? result.stdout.trim() : Buffer.from(result.stdout);
}
function defaultBlogState(blogRepo, remoteName = 'origin') {
    const repo = fresh.assertSafeDirectory(blogRepo);
    const run = (args, text = true) => runGit(repo, args, { text });
    const head = run(['rev-parse', '--verify', 'HEAD']); const treeOid = run(['rev-parse', '--verify', 'HEAD^{tree}']);
    const contentTreeOid = run(['rev-parse', '--verify', 'HEAD:content/posts']);
    const branch = run(['branch', '--show-current']); const clean = run(['status', '--porcelain=v1', '--untracked-files=all']) === '';
    const pushUrl = run(['remote', 'get-url', '--push', remoteName]); const remoteIdentitySha256 = stableHash({ remote: remoteName, pushUrl });
    const remoteLine = run(['ls-remote', '--exit-code', remoteName, 'refs/heads/main']).split(/\r?\n/)[0] || '';
    const remoteOid = remoteLine.split(/\s+/)[0].toLowerCase();
    const hugoPath = ['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].find(name => fs.existsSync(path.join(repo, name)));
    if (!hugoPath) fail('博客仓库中缺少 Hugo 配置文件。');
    const hugo = readRegular(path.join(repo, hugoPath), 4 * 1024 * 1024);
    return { head: head.toLowerCase(), treeOid: treeOid.toLowerCase(), contentTreeOid: contentTreeOid.toLowerCase(), branch, clean, remoteName,
        remoteIdentitySha256, remoteOid, hugoConfig: { path: hugoPath, sha256: hugo.sha256 } };
}
function defaultGitBlob(blogRepo, head, relative) {
    const listing = runGit(blogRepo, ['ls-tree', '-z', '--full-tree', head, '--', relative], { text: false });
    if (!listing.length) return null;
    const match = listing.toString('utf8').match(/^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/);
    if (!match || match[3] !== relative) fail(`Git 树中的目标不是唯一的普通文件记录，或路径不一致：${relative}`);
    return runGit(blogRepo, ['cat-file', 'blob', match[2]], { text: false });
}

function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} 必须使用有效的 UTF-8 编码。`); }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw new Error(`${label} 的 JSON 中出现重复字段：${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    try { return JSON.parse(source); } catch { throw new Error(`${label} 的内容不是有效的 JSON。`); }
}


module.exports = { strictJson, readRegular, writeExact, defaultBlogState, defaultGitBlob };

'use strict';

// prompts/history/<sha256>.md 是历史提示词字节的归档。v1 提示词本来设计成永久冻结，
// 实际被多次就地改写，存量记录里声明的 SHA 大多指向只存在于 git 历史里的字节。
// 这里按记录声明的 SHA 取回那份字节，让旧记录仍可复算。
//
// 这是纯加法：只有当声明的 SHA 与当前文件（含 -v2）都不符时才会查归档；查不到就返回
// null，调用方保持原行为。归档本身不进任何哈希清单，文件名就是整文件字节的 SHA-256。
//
// 文件名和内容必须对得上才认。写归档时被中断会留下内容不全、却仍顶着那个 SHA 名字的
// <sha>.md；只看文件名就会把半截内容当成历史提示词发出去。所以每次读取都重算一遍 SHA，
// 不符就当作没有这份归档，返回 null 让调用方走原来的兜底。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const HISTORY_DIR = path.join(PROJECT_ROOT, 'prompts', 'history');
const SHA256_RE = /^[a-f0-9]{64}$/;
const HISTORY_FILE_RE = /^([a-f0-9]{64})\.md$/;

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function firstFencedBlock(text) {
    const match = String(text).match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m);
    return match ? match[2] : null;
}

// 与 deep-analyzer.js 的 runtimePromptTemplateSha256 保持同一算法：首块正文 +
// 记录声明的版本号，JSON 序列化后再哈希。
function promptTemplateSha256(text, contractVersion = '') {
    const block = firstFencedBlock(text);
    if (block === null) return null;
    return crypto.createHash('sha256')
        .update(JSON.stringify({ runtimePrompt: block, contractVersion: String(contractVersion || '') }))
        .digest('hex');
}

const templateIndex = new Map();

// directory 默认是 prompts/history/。测试把它指到临时目录，就不用往真归档里塞坏文件。
function historyFileIndex(directory = HISTORY_DIR) {
    const index = new Map();
    let names = [];
    try {
        names = fs.readdirSync(directory);
    } catch (_error) {
        names = [];
    }
    for (const name of names) {
        const match = HISTORY_FILE_RE.exec(name);
        if (match) index.set(match[1], path.join(directory, name));
    }
    return index;
}

// 读一份归档并核对其整文件 SHA。文件名声明什么，内容就必须是什么。
function archivedBytes(file, expectedSha256) {
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    } catch (_error) {
        return null;
    }
    return sha256Buffer(bytes) === expectedSha256 ? bytes : null;
}

// 按整文件字节 SHA 取归档字节（文件名即该 SHA，且要复核）。
function historicalPromptBytesForSha256(sha256, directory = HISTORY_DIR) {
    const value = String(sha256 || '').toLowerCase();
    if (!SHA256_RE.test(value)) return null;
    return archivedBytes(path.join(directory, `${value}.md`), value);
}

// 按首块模板 SHA 取归档字节。模板哈希取决于记录声明的版本号，所以这里逐份归档文件
// 重算首块模板哈希；命中即返回那份原始字节。整文件 SHA 对不上的文件直接跳过——首块
// 模板哈希只覆盖第一个围栏块，文件被截掉尾巴时它照样能对上。
function historicalPromptTemplateBytesForSha256(sha256, contractVersion = '', directory = HISTORY_DIR) {
    const value = String(sha256 || '').toLowerCase();
    if (!SHA256_RE.test(value)) return null;
    const cacheKey = `${directory}:${value}:${String(contractVersion || '')}`;
    const cached = templateIndex.get(cacheKey);
    if (cached) {
        const bytes = archivedBytes(cached.file, cached.wholeSha256);
        if (bytes) return bytes;
        templateIndex.delete(cacheKey);
    }
    for (const [wholeSha256, file] of historyFileIndex(directory)) {
        const bytes = archivedBytes(file, wholeSha256);
        if (!bytes) continue;
        if (promptTemplateSha256(bytes.toString('utf8'), contractVersion) === value) {
            // 只缓存查找位置；字节始终从当前文件读取并核验，调用方也不会共享 Buffer。
            templateIndex.set(cacheKey, { file, wholeSha256 });
            return bytes;
        }
    }
    return null;
}

// 统一入口：先核验同阶段已发布的 v1、v2 和当前路径，再按声明 SHA 到
// 归档里取。stage 只用于解析当前路径，取不到就返回 null。
function promptBytesForSha256(stage, sha256, directory = HISTORY_DIR) {
    const value = String(sha256 || '').toLowerCase();
    if (!SHA256_RE.test(value)) return null;
    let promptFilePathForContract = null;
    let currentPromptTextContract = null;
    try {
        ({ promptFilePathForContract, currentPromptTextContract } =
            require('./prompt-text-versions.js'));
    } catch (_error) {
        promptFilePathForContract = null;
    }
    const candidates = [];
    if (promptFilePathForContract) {
        try {
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, 'analysis-prompt-text-v1')));
        } catch (_error) { /* 阶段没有 v1 路径 */ }
        try {
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, 'analysis-prompt-text-v2')));
        } catch (_error) { /* 阶段没有 v2 路径 */ }
        try {
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, currentPromptTextContract(stage))));
        } catch (_error) { /* 阶段没有登记版本 */ }
    }
    for (const candidate of candidates) {
        try {
            const bytes = fs.readFileSync(candidate);
            if (sha256Buffer(bytes) === value) return bytes;
        } catch (_error) { /* 路径不存在 */ }
    }
    // 归档里只有整文件 SHA 复核通过的文件才会返回；复核不过就是 null，
    // 调用方照原样判定「声明的字节已经不存在」。
    return historicalPromptBytesForSha256(value, directory);
}

function resetCache() {
    templateIndex.clear();
}

module.exports = {
    HISTORY_DIR,
    sha256Buffer,
    promptTemplateSha256,
    historicalPromptBytesForSha256,
    historicalPromptTemplateBytesForSha256,
    promptBytesForSha256,
    resetCache
};

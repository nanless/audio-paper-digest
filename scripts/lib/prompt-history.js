'use strict';

// prompts/history/<sha256>.md 是历史提示词字节的归档。v1 提示词本来设计成永久冻结，
// 实际被多次就地改写，存量记录里声明的 SHA 大多指向只存在于 git 历史里的字节。
// 这里按记录声明的 SHA 取回那份字节，让旧记录仍可复算。
//
// 这是纯加法：只有当声明的 SHA 与当前文件（含 -v2）都不符时才会查归档；查不到就返回
// null，调用方保持原行为。归档本身不进任何哈希清单，文件名就是整文件字节的 SHA-256。

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

let wholeFileIndex = null;
const templateIndex = new Map();

function historyFileIndex() {
    if (wholeFileIndex) return wholeFileIndex;
    const index = new Map();
    let names = [];
    try {
        names = fs.readdirSync(HISTORY_DIR);
    } catch (_error) {
        names = [];
    }
    for (const name of names) {
        const match = HISTORY_FILE_RE.exec(name);
        if (match) index.set(match[1], path.join(HISTORY_DIR, name));
    }
    wholeFileIndex = index;
    return index;
}

// 按整文件字节 SHA 取归档字节（文件名即该 SHA）。
function historicalPromptBytesForSha256(sha256) {
    const value = String(sha256 || '').toLowerCase();
    if (!SHA256_RE.test(value)) return null;
    const file = historyFileIndex().get(value);
    if (!file) return null;
    try {
        return fs.readFileSync(file);
    } catch (_error) {
        return null;
    }
}

// 按首块模板 SHA 取归档字节。模板哈希取决于记录声明的版本号，所以这里逐份归档文件
// 重算首块模板哈希；命中即返回那份原始字节。
function historicalPromptTemplateBytesForSha256(sha256, contractVersion = '') {
    const value = String(sha256 || '').toLowerCase();
    if (!SHA256_RE.test(value)) return null;
    const cacheKey = `${value}:${String(contractVersion || '')}`;
    if (templateIndex.has(cacheKey)) return templateIndex.get(cacheKey);
    let found = null;
    for (const file of historyFileIndex().values()) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (_error) {
            continue;
        }
        if (promptTemplateSha256(text, contractVersion) === value) {
            found = fs.readFileSync(file);
            break;
        }
    }
    templateIndex.set(cacheKey, found);
    return found;
}

// 统一的入口：先看当前路径与同阶段的 -v2 路径的字节是否就是声明的 SHA，都不是再到
// 归档里取。stage 只用于解析当前路径，取不到就返回 null。
function promptBytesForSha256(stage, sha256) {
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
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, currentPromptTextContract(stage))));
        } catch (_error) { /* 阶段没有登记版本 */ }
    }
    for (const candidate of candidates) {
        try {
            const bytes = fs.readFileSync(candidate);
            if (sha256Buffer(bytes) === value) return bytes;
        } catch (_error) { /* 路径不存在 */ }
    }
    return historicalPromptBytesForSha256(value);
}

function resetCache() {
    wholeFileIndex = null;
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

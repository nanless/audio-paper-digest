'use strict';

// 工作树只保留现行Prompt。历史原字节按已登记Git blob及整文件SHA读取，
// 用来核验旧检查点，不重新生成旧文件、不改变旧声明或把旧结果补签成新版本。
//
// 声明的 SHA 与当前文件不符时，按索引读取原 Git 对象并重算整文件 SHA。
// 未登记的 SHA 返回 null；已登记对象缺失或内容不符则停止核验。
// 显式传入的私有证据目录沿用旧只读协议，每次重新核对文件名声明的 SHA。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPromptEvidenceBytes, historicalPromptEvidenceBytesForSha256,
    listHistoricalPromptEvidence, promptEvidenceIndexFingerprint } = require('./prompt-evidence');

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
const gitTemplateIndexes = new Map();

// 默认逻辑目录使用Git；显式临时目录仅供旧私有证据和隔离读守卫测试。
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
    if (path.resolve(directory) === HISTORY_DIR) return historicalPromptEvidenceBytesForSha256(value);
    return archivedBytes(path.join(directory, `${value}.md`), value);
}

// 按首块模板 SHA 取归档字节。模板哈希取决于记录声明的版本号，所以这里逐份归档文件
// 重算首块模板哈希；命中即返回那份原始字节。整文件 SHA 对不上的文件直接跳过——首块
// 模板哈希只覆盖第一个围栏块，文件被截掉尾巴时它照样能对上。
function historicalPromptTemplateBytesForSha256(sha256, contractVersion = '', directory = HISTORY_DIR) {
    const value = String(sha256 || '').toLowerCase();
    if (!SHA256_RE.test(value)) return null;
    if (path.resolve(directory) === HISTORY_DIR) {
        const key = `${promptEvidenceIndexFingerprint()}:${String(contractVersion || '')}`;
        let lookup = gitTemplateIndexes.get(key);
        if (!lookup) {
            lookup = new Map();
            for (const entry of listHistoricalPromptEvidence()) {
                const bytes = historicalPromptEvidenceBytesForSha256(entry.sha256);
                const template = bytes && promptTemplateSha256(bytes.toString('utf8'), contractVersion);
                if (template && !lookup.has(template)) lookup.set(template, entry.sha256);
            }
            gitTemplateIndexes.set(key, lookup);
        }
        return lookup.has(value) ? historicalPromptEvidenceBytesForSha256(lookup.get(value)) : null;
    }
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

// 统一入口：先核验同阶段已发布的 v1、v2、v3、v4 和当前路径，再按声明 SHA 到
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
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, 'analysis-prompt-text-v3')));
        } catch (_error) { /* 阶段没有 v3 路径 */ }
        try {
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, 'analysis-prompt-text-v4')));
        } catch (_error) { /* 阶段没有 v4 路径 */ }
        for (const contract of ['analysis-prompt-text-v5', 'analysis-prompt-text-v6',
            'analysis-prompt-text-v7', 'analysis-prompt-text-v8', 'analysis-prompt-text-v9',
            'analysis-prompt-text-v10', 'analysis-prompt-text-v11']) {
            try { candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, contract))); }
            catch (_error) { /* 此阶段未登记该版本 */ }
        }
        try {
            candidates.push(path.join(PROJECT_ROOT, promptFilePathForContract(stage, currentPromptTextContract(stage))));
        } catch (_error) { /* 阶段没有登记版本 */ }
    }
    for (const candidate of candidates) {
        try {
            const bytes = readPromptEvidenceBytes(path.relative(PROJECT_ROOT, candidate).split(path.sep).join('/'));
            if (sha256Buffer(bytes) === value) return bytes;
        } catch (_error) { /* 路径不存在 */ }
    }
    // 归档里只有整文件 SHA 复核通过的文件才会返回；复核不过就是 null，
    // 调用方照原样判定「声明的字节已经不存在」。
    return historicalPromptBytesForSha256(value, directory);
}

function resetCache() {
    templateIndex.clear();
    gitTemplateIndexes.clear();
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

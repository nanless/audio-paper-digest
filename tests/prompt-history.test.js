'use strict';

// prompts/history/<sha256>.md 是按记录声明的 SHA 取历史提示词字节的归档。这里锁定
// 三件事：归档文件名就是内容 SHA、解析器只在当前文件不符时才回退、归档不进任何哈希清单。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT = path.join(__dirname, '..');
const history = require('../scripts/lib/prompt-history.js');
const {
    FROZEN_V1_PROMPT_FILES,
    PROMPT_FILE_VERSIONS,
    promptFilePathForContract
} = require('../scripts/lib/prompt-text-versions.js');
const { IMPLEMENTATION_FILES } = require('../scripts/lib/conference-process.js');
const { RENDERER_IMPLEMENTATION_FILES } = require('../scripts/lib/historical-page-staging.js');

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('归档文件名就是内容字节的 SHA-256', () => {
    assert.ok(fs.existsSync(history.HISTORY_DIR), 'prompts/history/ 不存在');
    const names = fs.readdirSync(history.HISTORY_DIR).filter(name => name.endsWith('.md'));
    assert.ok(names.length > 0, 'prompts/history/ 是空的');
    for (const name of names) {
        const bytes = fs.readFileSync(path.join(history.HISTORY_DIR, name));
        assert.equal(sha256(bytes), name.replace(/\.md$/, ''),
            `${name} 的文件名与内容 SHA 不符`);
    }
});

test('声明的 SHA 就是当前文件时，解析器返回当前字节', () => {
    for (const stage of Object.keys(FROZEN_V1_PROMPT_FILES)) {
        const current = path.join(PROJECT, promptFilePathForContract(
            stage, PROMPT_FILE_VERSIONS[stage].contract));
        const bytes = fs.readFileSync(current);
        const resolved = history.promptBytesForSha256(stage, sha256(bytes));
        assert.ok(resolved, `阶段 ${stage} 的当前字节没被解析出来`);
        assert.ok(resolved.equals(bytes), `阶段 ${stage} 解析出的字节与当前文件不同`);
    }
});

test('未知 SHA 返回 null，不伪造字节', () => {
    assert.equal(history.historicalPromptBytesForSha256('0'.repeat(64)), null);
    assert.equal(history.historicalPromptBytesForSha256('not-a-sha'), null);
    assert.equal(history.historicalPromptTemplateBytesForSha256('0'.repeat(64), ''), null);
});

test('归档里存的是原始字节，首块模板哈希可与 deep-analyzer 的算法对上', () => {
    const names = fs.readdirSync(history.HISTORY_DIR).filter(name => name.endsWith('.md'));
    let matched = 0;
    for (const name of names) {
        const text = fs.readFileSync(path.join(history.HISTORY_DIR, name), 'utf8');
        const template = history.promptTemplateSha256(text, '');
        if (!template) continue;
        const bytes = history.historicalPromptTemplateBytesForSha256(template, '');
        assert.ok(bytes, `${name} 的首块模板哈希查不回自己`);
        assert.equal(sha256(bytes), name.replace(/\.md$/, ''));
        matched += 1;
    }
    assert.ok(matched > 0, '没有一份归档文件能算首块模板哈希');
});

// 四种形态里最容易被漏掉的一种：清单在文件里，且清单含自己。归档目录绝不能出现在
// 这些清单里，否则「加一份历史字节」会改变别的身份指纹。
test('prompts/history/ 不进任何实现清单', () => {
    for (const name of IMPLEMENTATION_FILES) {
        assert.ok(!String(name).includes('history'), `IMPLEMENTATION_FILES 含 ${name}`);
    }
    for (const name of RENDERER_IMPLEMENTATION_FILES) {
        assert.ok(!String(name).includes('history'), `RENDERER_IMPLEMENTATION_FILES 含 ${name}`);
    }
    const scripts = path.join(PROJECT, 'scripts');
    const offenders = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) { walk(target); continue; }
            if (!/\.(js|py)$/.test(entry.name)) continue;
            const text = fs.readFileSync(target, 'utf8');
            // 目录级扫描（readdirSync/glob）指向 prompts 就会把归档卷进哈希。
            if (/readdirSync\([^)]*prompts|glob[^\n]*prompts/i.test(text)) {
                offenders.push(path.relative(PROJECT, target));
            }
        }
    };
    walk(scripts);
    assert.deepEqual(offenders, [], `有脚本在目录级扫描 prompts/：${offenders.join('、')}`);
});

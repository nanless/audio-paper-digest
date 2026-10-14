'use strict';

// 旧提示词只读原Git字节，保留原整文件和模板SHA；不在工作树重新生成旧文件。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT = path.join(__dirname, '..');
const history = require('../scripts/lib/prompt-history.js');
const evidence = require('../scripts/lib/prompt-evidence.js');
const {
    FROZEN_V1_PROMPT_FILES,
    PROMPT_FILE_VERSIONS,
    promptFilePathForContract
} = require('../scripts/lib/prompt-text-versions.js');
const { IMPLEMENTATION_FILES } = require('../scripts/lib/conference-process.js');
const RENDERER_IMPLEMENTATION_FILES = require('../scripts/lib/paper-page-staging.js').rendererImplementationFiles();

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('工作树无旧Prompt，Git原字节逐份按整文件SHA核验', () => {
    assert.equal(fs.existsSync(history.HISTORY_DIR), false);
    const entries = evidence.listHistoricalPromptEvidence();
    assert.ok(entries.length > 0);
    for (const entry of entries) {
        const bytes = history.historicalPromptBytesForSha256(entry.sha256);
        assert.equal(sha256(bytes), entry.sha256);
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

test('Git模板SHA与首围栏算法一致，不物化旧正文', () => {
    let matched = 0;
    for (const entry of evidence.listHistoricalPromptEvidence()) {
        const original = history.historicalPromptBytesForSha256(entry.sha256);
        const template = history.promptTemplateSha256(original.toString('utf8'), '');
        if (!template) continue;
        const bytes = history.historicalPromptTemplateBytesForSha256(template, '');
        assert.equal(history.promptTemplateSha256(bytes.toString('utf8'), ''), template);
        matched += 1;
    }
    assert.ok(matched > 0);
    assert.equal(fs.existsSync(history.HISTORY_DIR), false);
});

// 写归档被中断时，磁盘上会留下内容不全、却仍顶着完整字节 SHA 文件名的 <sha>.md。
// 下面这份临时归档就照着那个样子造：文件名是完整字节的 SHA，内容只剩到第一个围栏块
// 为止。首块模板哈希照样对得上，所以两条读取路径都必须复核整文件 SHA。
test('截断的归档不被接受，当作没有这份归档', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const full = Buffer.from('```text\n截断归档的正文\n```\n\n尾部说明文字。\n', 'utf8');
    const truncated = Buffer.from('```text\n截断归档的正文\n```\n', 'utf8');
    const declared = sha256(full);
    const file = path.join(directory, `${declared}.md`);
    fs.writeFileSync(file, truncated);
    assert.ok(truncated.length < full.length, '构造的截断内容没有变短');

    assert.equal(history.historicalPromptBytesForSha256(declared, directory), null,
        '按整文件 SHA 取回了截断内容');
    assert.equal(history.promptBytesForSha256('deepAnalysis', declared, directory), null,
        'promptBytesForSha256 在查找历史提示词时返回了截断内容');
    const template = history.promptTemplateSha256(full.toString('utf8'), '');
    assert.equal(history.historicalPromptTemplateBytesForSha256(template, '', directory), null,
        '首块完好的截断文件被模板索引命中');

    // 同一份文件名下换成完整内容，三条路径都要恢复正常。
    history.resetCache();
    fs.writeFileSync(file, full);
    assert.deepEqual(history.historicalPromptBytesForSha256(declared, directory), full);
    assert.deepEqual(history.promptBytesForSha256('deepAnalysis', declared, directory), full);
    assert.deepEqual(history.historicalPromptTemplateBytesForSha256(template, '', directory), full);
});

// 四种形态里最容易被漏掉的一种：清单在文件里，且清单含自己。归档目录绝不能出现在
// 这些清单里，否则「加一份历史字节」会改变别的身份指纹。
test('prompts/history/ 不进任何实现清单', () => {
    for (const name of IMPLEMENTATION_FILES) {
        assert.ok(!String(name).startsWith('prompts/history/'), `IMPLEMENTATION_FILES 含 ${name}`);
    }
    for (const name of RENDERER_IMPLEMENTATION_FILES) {
        assert.ok(!String(name).startsWith('prompts/history/'), `RENDERER_IMPLEMENTATION_FILES 含 ${name}`);
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

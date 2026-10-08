'use strict';

// prompts/history/<sha256>.md 是按记录声明的 SHA 取历史提示词字节的归档。这里锁定
// 五件事：归档文件名就是内容 SHA、解析器只在当前文件不符时才回退、内容被截断的归档
// 一律不认、写归档走临时文件加 rename、归档不进任何哈希清单。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT = path.join(__dirname, '..');
const history = require('../scripts/lib/prompt-history.js');
const archive = require('../scripts/build-prompt-history-archive.js');
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
        'promptBytesForSha256 的兜底把截断内容当成历史提示词返回了');
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

test('写归档：临时文件加 rename，fsync 失败时目标文件保持原样', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-write-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = Buffer.from('```text\n新归档\n```\n', 'utf8');
    const file = path.join(directory, `${sha256(bytes)}.md`);
    fs.writeFileSync(file, '旧的完整字节\n', { mode: 0o644 });

    const realFsyncSync = fs.fsyncSync;
    fs.fsyncSync = () => { throw Object.assign(new Error('模拟断电'), { code: 'EIO' }); };
    try {
        assert.throws(() => archive.writeArchiveFile(file, bytes), /模拟断电/);
    } finally {
        fs.fsyncSync = realFsyncSync;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '旧的完整字节\n', '写入失败后目标文件被改动了');
    assert.deepEqual(fs.readdirSync(directory), [path.basename(file)], '写入失败后留下了临时文件');
});

test('写归档：内容与文件名一致，不留临时文件，替换时保留原权限位', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-history-write-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const first = Buffer.from('```text\n第一版\n```\n', 'utf8');
    const second = Buffer.from('```text\n第二版\n```\n', 'utf8');
    const firstFile = path.join(directory, `${sha256(first)}.md`);

    assert.deepEqual(archive.writeArchive([{ sha256: sha256(first), bytes: first }], directory),
        { written: 1, unchanged: 0 });
    assert.deepEqual(fs.readFileSync(firstFile), first);
    assert.equal(fs.statSync(firstFile).mode & 0o777, 0o600, '新归档文件的权限不是 0600');
    assert.deepEqual(fs.readdirSync(directory), [path.basename(firstFile)], '留下了临时文件');

    fs.chmodSync(firstFile, 0o644);
    const secondFile = path.join(directory, `${sha256(second)}.md`);
    assert.deepEqual(archive.writeArchive([
        { sha256: sha256(second), bytes: second },
        { sha256: sha256(first), bytes: first }
    ], directory), { written: 1, unchanged: 1 });
    assert.equal(fs.statSync(firstFile).mode & 0o777, 0o644, '替换已有归档时改了权限位');
    assert.deepEqual(fs.readFileSync(secondFile), second);
    assert.deepEqual(fs.readdirSync(directory).sort(), [path.basename(firstFile), path.basename(secondFile)].sort());
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

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const versions = require('../scripts/lib/prompt-contracts');
const evidence = require('../scripts/lib/prompt-evidence'), history = require('../scripts/lib/prompt-history');
const { loadPrompt } = require('../scripts/utils');
const root = path.resolve(__dirname, '..'), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const first = text => text.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m)[2];
const variables = text => [...new Set([...text.matchAll(/\{([A-Za-z_]\w{1,})\}/g)].map(m => m[1]))].sort();
const originals = {
    primaryAnalysis: { path: 'prompts/deep-analysis-v6.md', contract: 'analysis-prompt-text-v6',
        sha256: 'b36705353d116b99cde778625f21b14334378dff54b83474de29f9a83e04f0ff', blob: 'cbc1b59126dc887f867adba388a83e6cae2dd746' },
    apiReaderArticle: { path: 'prompts/api-reader-article-v9.md', contract: 'analysis-prompt-text-v9',
        sha256: 'a2630453bfbd506619b7b3e80ece91ffc9f53951b80bab043cc6d889731d7ff8', blob: '2dc5d6d8348a960bd272415fb861aa48e88b7609' }
};
// This test preserves the earlier scope-clarity upgrade as a historical pair;
// later writing changes have their own current-version regression tests.
const scopePath = stage => versions.promptFilePathForContract(stage,
    stage === 'primaryAnalysis' ? 'analysis-prompt-text-v7' : 'analysis-prompt-text-v10');
const beforeTerminology = file => Object.entries(require('../scripts/lib/prompt-legacy-codec').compatibilityExports.FROZEN_PRE_OPTIONAL_ENGLISH_PROMPT_FILES)
    .find(([stage]) => versions.currentTextStagePromptPath(stage) === file)?.[1].path || require('../scripts/lib/prompt-legacy-codec').currentPathPredecessors[file];
test('the two scope-clarity versions preserve exact old paths, whole bytes and templates from Git', () => {
    assert.equal(scopePath('primaryAnalysis'), 'prompts/deep-analysis-v7.md');
    assert.equal(scopePath('apiReaderArticle'), 'prompts/api-reader-article-v10.md');
    assert.equal(versions.CURRENT_PROMPT_FILES.length, 16);
    assert.deepEqual(fs.readdirSync(path.join(root, 'prompts/current')).filter(n => n.endsWith('.md') && !/^README(?:\.en)?\.md$/.test(n)).sort(),
        versions.CURRENT_PROMPT_FILES.map(file => path.basename(file)).sort());
    for (const [stage, old] of Object.entries(originals)) {
        assert.equal(versions.promptFilePathForContract(stage, old.contract), old.path);
        assert.equal(fs.existsSync(path.join(root, old.path)), false);
        const bytes = evidence.readPromptEvidenceBytes(old.path, { expectedSha256: old.sha256 });
        assert.equal(sha(bytes), old.sha256);
        assert.deepEqual(bytes, execFileSync('git', ['cat-file', 'blob', old.blob], { cwd: root }));
        assert.deepEqual(history.promptBytesForSha256(stage, old.sha256), bytes);
        const templateSha256 = history.promptTemplateSha256(bytes.toString(), old.contract);
        assert.deepEqual(history.historicalPromptTemplateBytesForSha256(templateSha256, old.contract), bytes);
        const newer = evidence.readPromptEvidenceBytes(scopePath(stage));
        assert.notEqual(sha(newer), old.sha256);
        assert.deepEqual(variables(first(newer.toString())), variables(first(bytes.toString())));
        assert.throws(() => evidence.readPromptEvidenceBytes(old.path, { expectedSha256: '0'.repeat(64) }));
        assert.throws(() => versions.promptFilePathForContract(stage, 'analysis-prompt-text-v99'));
    }
    const changed = new Set(Object.keys(originals).map(scopePath));
    for (const file of versions.CURRENT_PROMPT_FILES.map(beforeTerminology).filter(file => !changed.has(file))) {
        assert.deepEqual(evidence.readPromptEvidenceBytes(file), execFileSync('git',
            ['show', `e8b6261475dfd4c61611e78d7fae3acedb9b241d:${file}`], { cwd: root }));
    }
});
test('summary result-group clarification preserves every other byte and the complete analysis schema', () => {
    const old = evidence.readPromptEvidenceBytes(originals.primaryAnalysis.path).toString();
    const current = evidence.readPromptEvidenceBytes(scopePath('primaryAnalysis')).toString();
    const before = '这里只提取最重要的 1–2 个结果数字，表格放在实验结果中，不重复整张表。';
    const after = '这里只选最重要的 1–2 组关键结果；一组比较须保留双方数值、单位、精度和条件，必要的成本数值也要保留，不能为限制数字个数删去比较对象或开销。表格放在实验结果中，不重复整张表。';
    assert.equal(current.split(after).length, 2);
    assert.equal(current.replace(after, before), old);
    assert.deepEqual([...first(current).matchAll(/^## (.+)$/gm)].map(m => m[1]),
        [...first(old).matchAll(/^## (.+)$/gm)].map(m => m[1]));
});
test('independent PDF quotes require actual supplied characters and explicit recovery scope; the ordinary schema stays intact', () => {
    const old = evidence.readPromptEvidenceBytes(originals.apiReaderArticle.path).toString();
    const current = evidence.readPromptEvidenceBytes(scopePath('apiReaderArticle')).toString();
    const sectionStart = '\n独立 PDF 引文只用于明确允许的恢复\n';
    const sectionEnd = '\n记录与正文的对应关系\n';
    assert.equal(current.split(sectionStart).length, 2);
    const added = sectionStart + current.split(sectionStart)[1].split(sectionEnd)[0];
    assert.match(added, /本次请求实际给出了独立的官方封存 PDF 原字符全文/);
    assert.match(added, /当前恢复操作明确允许 PDF 引文/);
    assert.match(added, /长度为 12–4000 字符，最多 64 条/);
    assert.match(added, /未提供原字符全文或没有本次操作授权时，不输出 `pdfSourceQuotes`/);
    assert.match(added, /不能输出程序专用的 `sealedPdfQuoteEvidence`/);
    assert.match(added, /不能新增授权节点、借引文删掉负结果/);
    const extra = '下文另有独立 PDF 引文的受控恢复规则；它只在本次实际提供相应材料并明确允许的范围内适用，不能把任意 DOM 数字改装成引文表。';
    const reverted = current.replace(added, '').replace(extra, '')
        .replace('默认记录恰好包含', '记录恰好包含');
    assert.equal(reverted, old);
    const args = Object.fromEntries(variables(first(current)).map(key => [key, '真实输入_' + key]));
    args.sourceEvidence = '原文中的 {title} 与 \\alpha 不接受二次替换。';
    const rendered = loadPrompt(scopePath('apiReaderArticle'), args);
    assert.ok(rendered.includes(args.sourceEvidence));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const registry = require('../scripts/lib/prompt-text-versions');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history');
const { loadPrompt } = require('../scripts/utils');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const block = text => text.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m)[2];
const variables = text => [...new Set([...text.matchAll(/\{([A-Za-z_][\w]+)\}/g)].map(item => item[1]))].sort();
const predecessors = {
    primaryAnalysis: { path: 'prompts/deep-analysis-v5.md', contract: 'analysis-prompt-text-v5',
        sha256: '9c2793d7a4b3139b1ccdba327eb3624bac0ae593ccc2abcc2164a7d79052ab94', blobOid: '9374bd87da4479e3f9c637a3afcb69f112b5e0be' },
    apiReaderArticle: { path: 'prompts/api-reader-article-v8.md', contract: 'analysis-prompt-text-v8',
        sha256: '755a393402a7f819a99e8c08073ea48efa6ad6d10ff945c7f195dbcf6177de15', blobOid: '5b4f4b8e4ecd65f40efa85e32caa07412c091132' },
    apiReaderRepair: { path: 'prompts/api-reader-repair-v12.md', contract: 'analysis-prompt-text-v12',
        sha256: '731604e38df21a46b536dfe00280504c7964e94f7a4fb43188945ead85a76971', blobOid: '07a2aee44e349afb81a581d9a10b16e09268ab08' }
};

test('写作升级仍恰18份当前模板，三份旧原路径及完整Git字节保持可核验', t => {
    const current = fs.readdirSync(path.join(root, 'prompts')).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
    assert.equal(current.length, 18);
    assert.deepEqual(current, registry.CURRENT_PROMPT_FILES.map(file => path.basename(file)).sort());
    const empty = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'writing-prompt-history-'));
    t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
    for (const [stage, old] of Object.entries(predecessors)) {
        assert.equal(registry.promptFilePathForContract(stage, old.contract), old.path);
        assert.equal(fs.existsSync(path.join(root, old.path)), false);
        const saved = evidence.readPromptEvidenceBytes(old.path, { expectedSha256: old.sha256 });
        assert.equal(sha(saved), old.sha256);
        assert.deepEqual(saved, execFileSync('git', ['cat-file', 'blob', old.blobOid], { cwd: root }));
        assert.deepEqual(history.promptBytesForSha256(stage, old.sha256, empty), saved);
        const template = history.promptTemplateSha256(saved.toString(), old.contract);
        assert.deepEqual(history.historicalPromptTemplateBytesForSha256(template, old.contract), saved);
        assert.throws(() => evidence.readPromptEvidenceBytes(old.path, { expectedSha256: '0'.repeat(64) }), /SHA256/);
        assert.throws(() => registry.promptFilePathForContract(stage, 'analysis-prompt-text-v99'), /没有登记/);
    }
});

test('首围栏的原占位符保持，来源文本中的花括号不被二次替换', () => {
    for (const [stage, old] of Object.entries(predecessors)) {
        const before = block(evidence.readPromptEvidenceBytes(old.path).toString());
        const currentPath = registry.currentTextStagePromptPath(stage);
        const after = block(fs.readFileSync(path.join(root, currentPath), 'utf8'));
        assert.deepEqual(variables(after), variables(before));
        assert.notEqual(sha(after), sha(before));
        const args = Object.fromEntries(variables(after).map(key => [key, `真实输入_${key}`]));
        args.title = '{validationFeedback} 原始标题';
        const rendered = loadPrompt(currentPath, args);
        assert.ok(rendered.includes('{validationFeedback} 原始标题'));
        assert.ok(rendered.includes('真实输入_validationFeedback') || !variables(after).includes('validationFeedback'));
        assert.equal(rendered.includes('{title}'), false);
    }
});

test('讲解增强保留机器章节、Reader来源声明及普通局部补丁协议', () => {
    const oldAnalysis = block(evidence.readPromptEvidenceBytes(predecessors.primaryAnalysis.path).toString());
    const analysis = loadPrompt(registry.currentTextStagePromptPath('primaryAnalysis'));
    const headings = text => [...text.matchAll(/^## (.+)$/gm)].map(item => item[1]);
    assert.deepEqual(headings(analysis), headings(oldAnalysis));
    const oldArticle = block(evidence.readPromptEvidenceBytes(predecessors.apiReaderArticle.path).toString());
    const article = loadPrompt(registry.currentTextStagePromptPath('apiReaderArticle'));
    // 完整表结构、坐标、标记与JSON schema示例后的协议逐字保留；新教学规则不重写它们。
    assert.equal(article.slice(article.indexOf('四种表格记录方式')), oldArticle.slice(oldArticle.indexOf('四种表格记录方式')));
    const repair = loadPrompt(registry.currentTextStagePromptPath('apiReaderRepair'));
    const oldRepair = block(evidence.readPromptEvidenceBytes(predecessors.apiReaderRepair.path).toString());
    assert.equal(repair.slice(repair.indexOf('没有明确的原子操作时')), oldRepair.slice(oldRepair.indexOf('没有明确的原子操作时')));
    for (const text of [article, repair]) {
        const slash = String.fromCharCode(92);
        const token = text.split(/\s+/).find(word => word.split(slash).join('') === 'nn');
        assert.equal(token, slash + 'n' + slash + 'n');
        const decoded = JSON.parse('{"body":"段一' + token + '段二"}').body;
        assert.equal(decoded, '段一\n\n段二');
        assert.deepEqual(decoded.split('\n\n'), ['段一', '段二']);
    }
    assert.equal(require('../scripts/lib/reader-contract').READER_LIMITS.maximumSections, 18);
    assert.equal(require('../scripts/lib/reader-contract').READER_LIMITS.minimumChineseChars, 5000);
});

test('两轮升级以外的14份运行Prompt及两份冻结Manual要求字节保持', () => {
    const base = '6753f5c098a3804af72e702eb93124ce91d86d3b';
    const changed = new Set(Object.keys(predecessors).map(stage => registry.currentTextStagePromptPath(stage)));
    changed.add(registry.currentTextStagePromptPath('coreSummaryRepair'));
    for (const file of registry.CURRENT_PROMPT_FILES.filter(file => !changed.has(file))) {
        assert.deepEqual(fs.readFileSync(path.join(root, file)), execFileSync('git', ['show', `${base}:${file}`], { cwd: root }));
    }
    for (const [file, expected] of [
        ['manual/docs/editorial-reference-contract.md', 'dc7d5c7c8bf0ed58b23ba7285d3d9b431e6542911c0717cf7e5472ad1c12edee'],
        ['manual/docs/editorial-reference-contract-v2.md', '0cb9bad4666ff756e573ca6cb762d2c63c2e932787be8b8c1e8c0a6c93b23746']
    ]) assert.equal(sha(fs.readFileSync(path.join(root, file))), expected);
});

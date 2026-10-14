'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const requestDirectory = process.env.PD_READER_FACT_LOCAL_REQUEST_DIR;
const feedbackDirectory = process.env.PD_READER_FACT_LOCAL_FEEDBACK_DIR;
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repair = require('../scripts/lib/reader-repair');
const prompts = require('../scripts/lib/prompt-text-versions');
const utils = require('../scripts/utils');
function sample() {
    const value = '已有比较条件。错误完整原句。\n\n[[TABLE_1]]\n\n正确的表后解释。';
    return { draftSha256: repair.shaText('whole draft'), atomicOperation: null,
        targets: [{ path: '/sections/2/body', value, oldSha256: repair.hashDraft(value),
            authorizedClaims: ['错误完整原句。'], repairInstruction: '仅替换原句' }] };
}
function build(context = sample(), quote = 'Original evidence.') {
    const variables = repair.factLocalPromptVariables(context, '纠正原句：候选来自标识器，不是校准器。', 'Original evidence.', [quote]);
    return utils.loadPrompt(prompts.promptFilePathForContract('apiReaderRepair', repair.FACT_LOCAL_PROMPT_CONTRACT),
        { title: '真实研究题目', arxivId: '2610.11272', ...variables });
}
test('事实局部提示只携带获准正文、错句与具体证据，不注入全稿表格协议', () => {
    const context = sample(); const before = JSON.stringify(context); const text = build(context);
    assert.ok(text.includes('候选来自标识器')); assert.ok(text.includes('Original evidence.'));
    assert.ok(text.includes('[[TABLE_1]]')); assert.ok(text.includes('错误完整原句。'));
    assert.ok(!text.includes('complete_existing_table_bindings_v1'));
    assert.ok(!text.includes('5000–18000')); assert.ok(!text.includes('TABLE_J_SELECTION'));
    assert.ok(!text.includes('FID')); assert.ok(!text.includes('critic'));
    assert.equal(JSON.stringify(context), before);
    assert.ok(!/\{(?:factFeedback|repairTargets|title|arxivId)\}/.test(text));
});
test('公共调用未代拼引文也显式携带原文，已有逐字引文不重复', () => {
    const c = sample();
    const raw = repair.factLocalPromptVariables(c, '纠正原句。', 'Original evidence.', ['Original evidence.', 'Original evidence.']);
    assert.equal(raw.factFeedback.split('Original evidence.').length - 1, 1);
    const supplied = repair.factLocalPromptVariables(c, raw.factFeedback, 'Original evidence.', ['Original evidence.']);
    assert.equal(supplied.factFeedback, raw.factFeedback);
});

test('独立合同登记不改变当前选择与历史原路径身份', () => {
    assert.equal(prompts.currentTextStagePromptPath('apiReaderRepair'), 'prompts/api-reader-repair-v12.md');
    assert.equal(prompts.promptFilePathForContract('apiReaderRepair', repair.FACT_LOCAL_PROMPT_CONTRACT), 'prompts/api-reader-fact-local-v3.md');
    assert.equal(prompts.promptFilePathForContract('apiReaderRepair', 'reader-fact-local-text-prompt-v2'), 'prompts/api-reader-fact-local-v2.md');
    assert.equal(prompts.promptFilePathForContract('apiReaderRepair', 'reader-fact-local-body-prompt-v1'), 'prompts/api-reader-fact-local-v1.md');
    assert.throws(() => prompts.promptFilePathForContract('primaryAnalysis', repair.FACT_LOCAL_PROMPT_CONTRACT));
});
test('非正文、原句歧义、错误SHA、非逐字证据与原子操作不能进入事实局部提示', () => {
    for (const mutate of [
        c => { c.targets[0].path = '/tableBindings/0'; },
        c => { c.targets[0].oldSha256 = '0'.repeat(64); },
        c => { c.targets[0].authorizedClaims = ['不存在的句子']; },
        c => { c.targets.push(structuredClone(c.targets[0])); },
        c => { c.atomicOperation = { kind: 'reorganize_existing_sections_v1' }; },
        c => { c.targets = Array.from({ length: 9 }, () => structuredClone(c.targets[0])); }
    ]) { const c = sample(); mutate(c); assert.throws(() => build(c)); }
    assert.throws(() => build(sample(), 'Invented evidence.'));
});
test('新合同使用真实首围栏SHA并能在保存后的身份重算，旧合同保持独立', () => {
    const saved = utils.loadEnvFile;
    const originalEnv = { ...process.env };
    utils.loadEnvFile = () => {
        process.env.PAPER_ANALYZER_ENDPOINT = 'https://example.invalid/v1';
        process.env.PAPER_ANALYZER_API_KEY = 'test-only';
        process.env.PAPER_ANALYZER_MODEL = 'test-model';
    };
    let deep;
    try {
        const Module = require('node:module');
        const filename = require.resolve('../scripts/deep-analyzer');
        const isolated = new Module(filename, module); isolated.filename = filename; isolated.paths = module.paths;
        isolated._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testConfigurationFingerprint = buildApiReaderBaseFingerprint;', filename);
        deep = isolated.exports;
    } finally {
        utils.loadEnvFile = saved;
        for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
        Object.assign(process.env, originalEnv);
    }
    const articleContract = prompts.currentPromptTextContract('apiReaderArticle');
    const localPath = prompts.promptFilePathForContract('apiReaderRepair', repair.FACT_LOCAL_PROMPT_CONTRACT);
    const localSha = deep.runtimePromptTemplateSha256(localPath);
    const current = deep.testConfigurationFingerprint(articleContract, repair.FACT_LOCAL_PROMPT_CONTRACT, '2610.11272');
    const replay = deep.testConfigurationFingerprint(articleContract, repair.FACT_LOCAL_PROMPT_CONTRACT, '2610.11272',
        { repairPromptTemplateSha256: localSha });
    assert.equal(current, replay);
    assert.notEqual(current, deep.testConfigurationFingerprint(articleContract,
        prompts.currentPromptTextContract('apiReaderRepair'), '2610.11272'));
});

test('四篇真实已付费局部请求改为短提示，全部获准正文和SHA逐字保留',
    { skip: !requestDirectory || !feedbackDirectory }, () => {
        const cases = ['ac992d2b-e046-4f59-bbdd-8d260f2f19c1', '3840035a-3fec-4425-943d-c387aad0bdc4',
            '7e236a44-5eee-47bd-b02c-4bef8d04b479', 'd052a6af-21a5-45e3-b84e-01ef82cc77f8'];
        for (const id of cases) {
            const request = JSON.parse(fs.readFileSync(path.join(requestDirectory, id + '.request.json')));
            const paperId = request.identity.paperId.replace(/v\d+$/, '');
            const feedback = JSON.parse(fs.readFileSync(path.join(feedbackDirectory, paperId + '.json')));
            const text = feedback.readerFeedback;
            const variables = repair.factLocalPromptVariables({ draftSha256: request.draftSha256,
                targets: request.repairTargets, atomicOperation: request.atomicOperation }, text,
                feedback.sourceQuotes.join('\n'), feedback.sourceQuotes);
            const prompt = utils.loadPrompt('prompts/api-reader-fact-local-v1.md',
                { title: paperId, arxivId: paperId, ...variables });
            assert.ok(prompt.length < request.prompt.length / 2, paperId);
            const parsed = JSON.parse(variables.repairTargets);
            assert.deepEqual(parsed.targets, request.repairTargets); assert.equal(parsed.draftSha256, request.draftSha256);
            assert.ok(prompt.includes(feedback.readerFeedback));
            for (const quote of feedback.sourceQuotes) assert.ok(prompt.includes(quote));
            assert.ok(!prompt.includes('complete_existing_table_bindings_v1'));
            console.log(JSON.stringify({ paperId, oldChars: request.prompt.length, newChars: prompt.length }));
        }
    });

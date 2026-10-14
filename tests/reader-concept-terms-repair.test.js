'use strict';
const sourceProject = process.env.PD_READER_CONCEPT_TERMS_SOURCE_PROJECT;
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const source = 'K denotes the number of retrieved candidates. The measured value is 1.0.';
function sample() {
    const draft = { conceptBridges: [{ terms: ['语义锚点', 'K'], sectionKind: 'method_overview',
        marker: '[[CONCEPT_BRIDGE_1]]', explanation: 'K表示检索候选数，语义条件用于定位候选，二者共同限定检索结果的范围。' }], sections: [{ body: '原始正文完全保留。' }] };
    const message = repair.conceptBridgeTermsDiagnostic(draft.conceptBridges[0].terms, 0);
    return { draft, issues: [{ message }, { path: '/conceptBridges/0', message }] };
}
test('唯一术语长度问题只授权单一叶值，原文证据逐字发送', () => {
    const { draft, issues } = sample();
    const context = repair.buildConceptTermsRepairContext(draft, issues, source);
    assert.deepEqual(context.targets.map(target => target.path), ['/conceptBridges/0/terms/1']);
    assert.equal(context.sourceQuotes[0], source);
    const target = context.targets[0];
    const patch = repair.compileConceptTermsPatch(draft, { version: 1, draftSha256: context.draftSha256,
        termReplacements: [{ path: target.path, oldSha256: target.oldSha256, value: '候选数 K' }] }, context);
    const after = repair.applyReaderPatch(draft, patch, ['/conceptBridges/0']);
    assert.deepEqual(after.sections, draft.sections);
    assert.equal(after.conceptBridges[0].terms[1], '候选数 K');
    assert.equal(after.conceptBridges[0].terms[0], draft.conceptBridges[0].terms[0]);
    for (const field of ['marker','sectionKind','explanation']) assert.equal(after.conceptBridges[0][field], draft.conceptBridges[0][field]);
});
test('语言来源或结构问题同时存在时不缩小真实修复范围', () => {
    const { draft, issues } = sample();
    for (const issue of [{ code: 'reader_workflow_leakage', message: '表后解释要说明' },
        { code: 'reader_invalid_source_quotes', message: '引文不匹配' }, { message: '概念标记位置错误' }]) {
        assert.equal(repair.buildConceptTermsRepairContext(draft, [...issues, issue], source), null);
    }
    assert.equal(repair.buildConceptTermsRepairContext(draft, issues, '没有此符号的原文'), null);
});
test('错误SHA、越权路径、重复、整正文、原值和丢符号全部拒绝', () => {
    const { draft, issues } = sample(), context = repair.buildConceptTermsRepairContext(draft, issues, source);
    const target = context.targets[0];
    const valid = { version: 1, draftSha256: context.draftSha256,
        termReplacements: [{ path: target.path, oldSha256: target.oldSha256, value: '候选数 K' }] };
    for (const edit of [value => { value.draftSha256 = '0'.repeat(64); },
        value => { value.termReplacements[0].oldSha256 = '0'.repeat(64); },
        value => { value.termReplacements[0].path = '/sections/0/body'; },
        value => { value.termReplacements.push(value.termReplacements[0]); },
        value => { value.replacements = []; }, value => { value.termReplacements[0].value = 'K'; },
        value => { value.termReplacements[0].value = '候选数量'; },
        value => { value.termReplacements[0].value = 'K\n新正文'; }]) {
        const response = structuredClone(valid); edit(response);
        assert.throws(() => repair.compileConceptTermsPatch(draft, response, context));
    }
});
test('正常生成器自动分流，只回术语叶值，仍经整篇解析并保原计数', async t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const deep = require('../scripts/deep-analyzer');
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-concept-terms-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: source });
    const draft = structuredClone(fixture.draft);
    draft.conceptBridges[0].terms[1] = 'K';
    draft.conceptBridges[0].explanation += '这里K表示检索候选数，用于限定需要比较的候选数量，不改变此前语义条件与声学证据的分工。';
    const original = JSON.stringify(draft);
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed({ arxivId: '2609.12345', title: '检索候选数的术语解释' }, '', '给定原文证据', {
        sourceText: source, structuredArtifacts: fixture.sourceDetails.structuredArtifacts,
        readerAttemptsDir: root, readerRecordDisposition: async () => {},
        readerCallModel: async (messages, _tokens, request) => {
            calls++;
            if (calls === 1) return original;
            assert.equal(calls, 2);
            assert.equal(request.usageContext.stage, 'apiReaderRepair');
            const prompt = messages[0].content.filter(item => item.type === 'text').map(item => item.text).join('\n');
            assert.ok(prompt.includes(source));
            assert.ok(!prompt.includes('sections'));
            assert.ok(!prompt.includes('mechanicalContract'));
            const line = prompt.split('\n').find(line => line.startsWith('{"draftSha256"'));
            const context = JSON.parse(line), target = context.targets[0];
            assert.equal(target.path, '/conceptBridges/0/terms/1');
            return JSON.stringify({ version: 1, draftSha256: context.draftSha256,
                termReplacements: [{ path: target.path, oldSha256: target.oldSha256, value: '检索候选数 K' }] });
        },
    });
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.fullAttempts, 1);
    assert.equal(JSON.stringify(draft), original);
    assert.ok(result.draftOrderMappings.some(mapping => mapping.contract === repair.CONCEPT_TERMS_PROMPT_CONTRACT));
});

test('真实11792两次付费原请求只需一项术语，正文表图及原档保留',
    { skip: !sourceProject }, () => {
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
        const run = path.join(sourceProject, 'data/runtime/daily-fresh-source-runs/132fc843-0afe-434c-b0b7-4d98e2235b3e');
        const sourceDir = path.join(run, 'sources/2610.11792/generation-000001');
        const sourceText = fs.readFileSync(path.join(sourceDir, 'source.txt'), 'utf8');
        const runtime = JSON.parse(fs.readFileSync(path.join(sourceDir, 'source-runtime.json')));
        const deep = require('../scripts/deep-analyzer');
        for (const requestId of ['0df12e8b-4906-448e-8057-744bf52dab2c', '5965cad0-0a95-4929-a22a-5a4dd96ffdf9']) {
            const file = path.join(run, 'reader-attempts/request-diagnostics', requestId + '.request.json');
            const bytes = fs.readFileSync(file), request = JSON.parse(bytes);
            assert.equal(request.identity.sourceSha256, sha(sourceText));
            assert.equal(request.identity.freshAnalysis.structuredArtifactsSha256, runtime.structuredArtifacts.payloadSha256);
            const payload = repair.loadFailedCandidate(path.join(run, 'reader-attempts'), request.identity);
            assert.ok(payload, '实际当前付费档须仍在；该可选重放不搜索其他稿件');
            const draft = request.draft;
            const options = { arxivId: '2610.11792', requiredVersion: 3, requireIntegratedTables: true,
                minimumIntegratedTables: 2, requireSourceBindings: true, sourceText,
                structuredArtifacts: runtime.structuredArtifacts,
                availableFigureOrdinals: (payload.imageEvidence || []).map(image => image.ordinal),
                allowDeterministicQuoteRepair: true, allowDeterministicUnsupportedClaimPruning: true };
            let error;
            try { deep.parseApiReaderArticleResult(JSON.stringify(draft), options); } catch (caught) { error = caught; }
            const issues = repair.collectDraftIssues(draft, error, options);
            const context = repair.buildConceptTermsRepairContext(draft, issues, sourceText);
            assert.deepEqual(context.targets.map(target => target.path), ['/conceptBridges/2/terms/1']);
            assert.ok(JSON.stringify(repair.conceptTermsPromptVariables(context)).length < 12000);
            assert.ok(request.prompt.length > 100000);
            const target = context.targets[0];
            const patch = repair.compileConceptTermsPatch(draft, { version: 1, draftSha256: context.draftSha256,
                termReplacements: [{ path: target.path, oldSha256: target.oldSha256, value: '检索序列条数 K' }] }, context);
            const after = repair.applyReaderPatch(draft, patch, ['/conceptBridges/2']);
            assert.deepEqual(after.sections, draft.sections);
            assert.deepEqual(after.tableBindings, draft.tableBindings);
            assert.deepEqual(after.figurePlacements, draft.figurePlacements);
            assert.equal(after.conceptBridges[2].explanation, draft.conceptBridges[2].explanation);
            assert.equal(after.conceptBridges[2].terms[1], '检索序列条数 K');
            assert.ok(deep.parseApiReaderArticleResult(JSON.stringify(after), options).article);
            assert.equal(sha(fs.readFileSync(file)), sha(bytes));
        }
    });

test('实际准备身份包含窄模板实现SHA，而普通v12模板声明不冒充窄请求', async () => {
    const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
    const deep = require('../scripts/deep-analyzer');
    const fixture = require('./reader-signed-draft-fixture').fixture({ noFigures: true, sourceText: source });
    const context = await deep.prepareApiReaderRetryIdentity({ arxivId: '2609.12345', title: '术语输入身份' }, '', '实际来源', {
        sourceText: source, structuredArtifacts: fixture.sourceDetails.structuredArtifacts });
    const expected = crypto.createHash('sha256').update([
        fs.readFileSync(path.join(__dirname, '../scripts/lib/reader-repair.js'), 'utf8'),
        require('../scripts/lib/prompt-evidence.js').readPromptEvidenceBytes(repair.CONCEPT_TERMS_PROMPT_PATH).toString('utf8'),
        require('../scripts/lib/prompt-evidence.js').readPromptEvidenceBytes('prompts/api-reader-repair-v11.md').toString('utf8')].join('\0')).digest('hex');
    assert.equal(context.identity.repairImplementationSha256, expected);
    assert.equal(context.identity.repairImplementationSha256, repair.readerRepairImplementationSha256());
});

test('术语中的括号和单符号美元字符按原字面检索证据，不作为正则语法', () => {
    const { draft } = sample();
    draft.conceptBridges[0].terms[0] = 'F1(score)';
    const text = 'F1(score) explains retrieval.\nK is the candidate count.';
    let message = repair.conceptBridgeTermsDiagnostic(draft.conceptBridges[0].terms, 0);
    let context = repair.buildConceptTermsRepairContext(draft, [{ message }], text);
    assert.deepEqual(context.sourceQuotes, text.split('\n'));
    draft.conceptBridges[0].terms = ['候选预算', '$'];
    message = repair.conceptBridgeTermsDiagnostic(draft.conceptBridges[0].terms, 0);
    context = repair.buildConceptTermsRepairContext(draft, [{ message }], 'The $ symbol means the budget.');
    assert.deepEqual(context.sourceQuotes, ['The $ symbol means the budget.']);
    assert.equal(repair.buildConceptTermsRepairContext(draft, [{ message }], 'The symbol means the budget.'), null);
});

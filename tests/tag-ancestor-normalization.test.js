'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const deep = require('../scripts/deep-analyzer');
const rules = require('../scripts/lib/tag-rules').getDefaultTagRules();
const { validAnalysisText } = require('./valid-analysis-fixture');
const { validateTagSectionContract } = require('../scripts/analysis-contract');
const byId = new Map(rules.tagCatalog.concepts.map(c => [c.id, c]));
const robust = rules.resolveCurrentTag('#鲁棒性').id;
const task = rules.resolveCurrentTag('#语音识别').id;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const label = id => '#' + byId.get(id).preferredLabel.zh;

function fixture(ids = [task, 'method.neural-codec', 'method.vector-quantization', robust],
    primaryTask = task, primaryMethod = 'method.neural-codec') {
    const tags = ids.map(label);
    const primary = [label(primaryTask), label(primaryMethod)];
    const block = ['## 标签', tags.join(' '), '主任务标签：' + primary[0], '主方法标签：' + primary[1],
        '补充标签：' + tags.filter(t => !primary.includes(t)).join(' ')].join('\n') + '\n';
    return validAnalysisText().replace(/## 标签\n[\s\S]*?(?=\n##|$)/u, block)
        .replace(/^primary_task_tag:.*$/mu, 'primary_task_tag: ' + primary[0])
        .replace(/^primary_method_tag:.*$/mu, 'primary_method_tag: ' + primary[1]);
}

test('只删除已选具体概念的补充祖先；输入输出和完整链可重算，主标签及其余正文不变', () => {
    const input = fixture();
    assert.deepEqual(deep.parseAnalysis(input).tagValidation.errors, ['标签不能同时包含上级概念及其下级概念。']);
    const result = deep.normalizeRedundantTagAncestors(input);
    assert.ok(result);
    assert.equal(validateTagSectionContract(result.analysis, deep.parseAnalysis(result.analysis)), null);
    assert.equal(deep.maskClassificationFields(result.analysis), deep.maskClassificationFields(input));
    assert.equal(result.proof.inputAnalysisSha256, sha(input));
    assert.equal(result.proof.outputAnalysisSha256, sha(result.analysis));
    assert.equal(result.proof.modelRequests, 0);
    assert.equal(result.proof.wrapperRemoved, false);
    assert.equal(result.proof.originalTagSectionSha256, sha(result.proof.originalTagSection));
    assert.deepEqual(result.proof.removed, [{ id: 'method.vector-quantization', descendantWitnesses: [
        { descendantId: 'method.neural-codec', ancestorChain: ['method.neural-codec', 'method.vector-quantization'] }
    ] }]);
    assert.deepEqual(result.proof.retainedConceptIds, [task, 'method.neural-codec', robust]);
    assert.equal(result.proof.primaryTaskId, task);
    assert.equal(result.proof.primaryMethodId, 'method.neural-codec');
    const { proofSha256, ...body } = result.proof;
    assert.equal(proofSha256, deep.stableFingerprint(body));
    assert.equal(deep.normalizeRedundantTagAncestors(result.analysis), null, 'an already valid selection needs no receipt');
});

test('只允许独占且完整的一对围栏包住严格四行，再检查唯一祖先错误', () => {
    const base = fixture();
    const fence = value => value.replace(/(## 标签\n)([\s\S]*?)(?=\n##|$)/u,
        (_all, heading, body) => heading + '```\n' + body.trim() + '\n```\n');
    const input = fence(base);
    const result = deep.normalizeRedundantTagAncestors(input);
    assert.ok(result);
    assert.equal(result.proof.wrapperRemoved, true);
    assert.match(result.proof.originalTagSection, /```/u);
    assert.equal(result.proof.originalTagSectionSha256, sha(result.proof.originalTagSection));
    assert.equal(result.proof.inputAnalysisSha256, sha(input));
    assert.equal(deep.maskClassificationFields(result.analysis), deep.maskClassificationFields(input));
    for (const invalid of [input.replace('```\n#', '```text\n#'), input.replace('```\n#', '````\n#'),
        input.replace('\n```\n', '\nextra\n```\n'), input.replace('\n主方法标签', '\n\n主方法标签'),
        input.replace('补充标签：#向量量化 #鲁棒性', '补充标签：#鲁棒性')]) {
        assert.equal(deep.normalizeRedundantTagAncestors(invalid), null);
    }
});

test('主标签祖先、剩余不足、兄弟概念及任何其它错误不能借机械路径改选', () => {
    const cases = [
        fixture(undefined, task, 'method.vector-quantization'),
        fixture([task, 'method.neural-codec', 'method.vector-quantization']),
        fixture([task, 'method.cnn', 'method.transformer', robust], task, 'method.cnn'),
        fixture().replace('补充标签：#向量量化 #鲁棒性', '补充标签：#鲁棒性'),
        fixture().replace('primary_method_tag: #神经编解码与离散单元', 'primary_method_tag: #向量量化'),
        fixture().replace('primary_method_tag: #神经编解码与离散单元', 'primary_method_tag: #神经编解码与离散单元\nprimary_method_tag: #神经编解码与离散单元'),
        fixture().replace('#向量量化', '#目录外方法'),
        fixture().replace('主方法标签：', '主方法说明：')
    ];
    const taskChild = rules.tagCatalog.concepts.find(c => c.facet === 'task' && c.status === 'active'
        && c.broaderId && byId.get(c.broaderId)?.status === 'active');
    assert.ok(taskChild);
    cases.push(fixture([taskChild.broaderId, taskChild.id, 'method.neural-codec', robust],
        taskChild.broaderId, 'method.neural-codec'));
    for (const input of cases) assert.equal(deep.normalizeRedundantTagAncestors(input), null);
});

test('不能把额外格式错误藏在父子错误后；机器摘要非主字段逐字保留', () => {
    const original = fixture();
    const before = deep.maskClassificationFields(original);
    for (const invalid of [original.replace('补充标签：#向量量化 #鲁棒性', '补充标签：#向量量化 #向量量化'),
        original.replace('主任务标签：#语音识别', '主任务标签：#语音识别 extra'),
        original.replace('补充标签：', '附加行\n补充标签：')]) {
        assert.equal(deep.normalizeRedundantTagAncestors(invalid), null);
    }
    const normalized = deep.normalizeRedundantTagAncestors(original);
    assert.equal(deep.maskClassificationFields(normalized.analysis), before);
    const machine = value => value.match(/## 机器摘要\n([\s\S]*?)(?=\n##|$)/u)?.[1]
        .split('\n').filter(line => !/^primary_(?:task|method)_tag:/u.test(line)).join('\n');
    assert.equal(machine(normalized.analysis), machine(original));
});

function productionTagPhase() {
    const filename = path.resolve(__dirname, '../scripts/deep-analyzer.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('    // 结构修复完成后，单独依据原文证据核验并修复标签。');
    const end = source.indexOf('    // 结构和标签修复完成后，再检查核心摘要。', start);
    assert.ok(start > 0 && end > start);
    // Execute the actual unchanged phase in its original module lexical scope.
    // Only the fixture caller is added; no validator, stage writer or repair
    // helper is replaced. This does not execute later core/scoring/Reader phases.
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    isolated._compile(source + '\nmodule.exports.testTagPhase = async function(paper, analysisManifest, analysis, rawTextForAnalysis) {'
        + 'const imageManifest = null; const arxivId = getPaperArxivId(paper);\n'
        + source.slice(start, end) + '\nreturn {paper, analysisManifest, analysis};};', filename);
    return isolated.exports;
}

test('生产原标签phase在真实来源及阶段禁令下零请求签出正常记录，旧失败和原checkpoint仍保留', async t => {
    let modelCalls = 0;
    t.mock.method(require('../scripts/utils'), 'requestLlmJson', async () => {
        modelCalls++;
        throw new Error('A tag-phase fixture must never send a model request');
    });
    const phase = productionTagPhase();
    const f = require('./helpers/conference-production-plan-fixture').productionPlanFixture(t);
    const sourceApi = require('../scripts/lib/conference-source-context');
    const handle = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    const source = require('../scripts/lib/conference-analysis-adapter').sourceDetails(handle);
    const sourceContext = require('../scripts/lib/conference-analysis-context');
    const guard = require('../scripts/lib/analysis-stage-request-guard');
    const input = fixture();
    const priorStage = { status: 'contract_rejected', error: '原父子标签修复两次内容失败',
        fingerprint: 'a'.repeat(64), contentAttempts: 2, updatedAt: '2026-10-17T20:00:00.000+08:00' };
    const manifest = { version: 1, contracts: { tagSelectionRecord: 'paper-tag-stage-record-v2' }, stages: {
        structureRepair: { status: 'complete', outputAnalysisSha256: sha(input) }, tagSelection: structuredClone(priorStage)
    } };
    const paper = { id: f.paperId, source: 'conference', sourceSha256: sha(source.text),
        title: 'Paper 100', analysisCheckpoint: input, analysisManifest: manifest,
        analysisStageCheckpoints: { structureRepair: input, tagSelection: input } };
    const initial = structuredClone(paper);
    let persisted = 0;
    paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')] = () => { persisted++; };
    const inSource = callback => sourceContext.withConferenceAnalysisSource({ executionId: '12345678-1234-4234-8234-123456789abc',
        executionDir: f.root, paperId: f.paperId, sourceDetails: source, readerPdfSourceHandle: handle }, callback);
    const result = await inSource(() => guard.withStageModelRequestsForbidden(['tagSelection'], () =>
        phase.testTagPhase(paper, manifest, input, source.text)));
    assert.equal(modelCalls, 0);
    assert.equal(persisted, 1);
    const stage = result.analysisManifest.stages.tagSelection;
    assert.equal(stage.status, 'complete');
    assert.equal(stage.registrySha256, rules.registrySha256);
    assert.equal(stage.inputAnalysisSha256, sha(input));
    assert.equal(stage.outputAnalysisSha256, sha(result.analysis));
    assert.equal(result.paper.analysisStageCheckpoints.structureRepair, input);
    assert.equal(result.paper.analysisStageCheckpoints.tagSelection, result.analysis);
    assert.equal(deep.maskClassificationFields(result.analysis), deep.maskClassificationFields(input));
    const receipt = stage.deterministicAncestorPruning;
    assert.deepEqual(receipt.previousTagAttempt.stage, priorStage);
    assert.equal(receipt.previousTagAttempt.checkpoint, input);
    assert.equal(receipt.previousTagAttemptSha256, deep.stableFingerprint(receipt.previousTagAttempt));
    assert.equal(receipt.inputAnalysisSha256, sha(input));
    assert.equal(receipt.outputAnalysisSha256, sha(result.analysis));
    const { receiptSha256, ...receiptBody } = receipt;
    assert.equal(receiptSha256, deep.stableFingerprint(receiptBody));
    const tagRecord = require('../scripts/lib/tag-stage-record').readTagStageRecord(result.analysisManifest, paper.analysisStageCheckpoints);
    assert.equal(stage.bindingSha256, deep.stableFingerprint(Object.fromEntries(tagRecord.bindingFields.map(key => [key, stage[key]]))));
    for (const key of ['coreSummaryRepair', 'scoringAudit', 'apiReaderArticle']) {
        assert.equal(result.analysisManifest.stages[key], undefined, 'the tag phase must not forge downstream completion');
    }
    // The normal tag verifier also binds the next consumer's input hash. Supply
    // that fixture-only pending consumer, without claiming core completion or
    // manufacturing a summary/score/Reader output. The tag stage and checkpoint
    // under test are exactly those signed by the actual production phase.
    const consumer = structuredClone(result.paper);
    consumer.analysis = result.analysis;
    consumer.analysisManifest.stages.coreSummaryRepair = {
        status: 'pending', inputAnalysisSha256: stage.outputAnalysisSha256
    };
    const contract = require('../scripts/analysis-contract');
    assert.equal(inSource(() => contract.validateTagStageProof(consumer, {
        parsed: deep.parseAnalysis(consumer.analysis), tagRules: rules
    })), null);
    assert.equal(consumer.analysisManifest.stages.coreSummaryRepair.status, 'pending');
    assert.equal(initial.analysisManifest.stages.tagSelection.contentAttempts, 2);
    guard.withStageModelRequestsForbidden(['tagSelection'], () =>
        assert.throws(() => guard.assertStageModelRequestAllowed('tagSelection'), { code: guard.CODE }));
    for (const invalid of [fixture(undefined, task, 'method.vector-quantization'),
        fixture().replace('补充标签：#向量量化 #鲁棒性', '补充标签：#鲁棒性')]) {
        const rejected = structuredClone(initial);
        rejected.analysisCheckpoint = invalid;
        rejected.analysisStageCheckpoints.structureRepair = invalid;
        rejected.analysisManifest.stages.structureRepair.outputAnalysisSha256 = sha(invalid);
        await assert.rejects(inSource(() => guard.withStageModelRequestsForbidden(['tagSelection'], () =>
            phase.testTagPhase(rejected, rejected.analysisManifest, invalid, source.text))), { code: guard.CODE });
        assert.notEqual(rejected.analysisManifest.stages.tagSelection.status, 'complete');
        assert.equal(rejected.analysisManifest.stages.tagSelection.deterministicAncestorPruning, undefined);
        assert.equal(rejected.analysisStageCheckpoints.structureRepair, invalid);
        for (const key of ['coreSummaryRepair', 'scoringAudit', 'apiReaderArticle'])
            assert.equal(rejected.analysisManifest.stages[key], undefined);
    }
    assert.equal(modelCalls, 0);
});

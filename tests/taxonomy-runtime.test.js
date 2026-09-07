'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseAnalysis } = require('../scripts/utils.js');
const contract = require('../scripts/analysis-contract.js');
const {
    createTaxonomyRuntime,
    TAXONOMY_PROJECTION_CONTRACT,
    TAXONOMY_SELECTION_CONTRACT,
    TAXONOMY_FLAT_COMPAT_CONTRACT
} = require('../scripts/lib/taxonomy-runtime.js');

const registryPath = path.resolve(__dirname, '../config/paper-taxonomy.json');

test('runtime derives all active preferred labels, roles and compact projection from registry', () => {
    const runtime = createTaxonomyRuntime({ registryPath });
    assert.equal(runtime.projectionContract, TAXONOMY_PROJECTION_CONTRACT);
    assert.equal(runtime.selectionContract, TAXONOMY_SELECTION_CONTRACT);
    assert.equal(runtime.flatCompatContract, TAXONOMY_FLAT_COMPAT_CONTRACT);
    assert.equal(runtime.flatCompatContract, 'paper-taxonomy-flat-tags-compat-v1');
    assert.match(runtime.projectionSha256, /^[a-f0-9]{64}$/);
    assert.ok(runtime.allowedTags.has('#众包评测'));
    assert.ok(runtime.methodTags.has('#众包评测'));
    assert.ok(!runtime.taskTags.has('#众包评测'));
    assert.ok(runtime.taskTags.has('#语音可懂度评估'));
    assert.match(runtime.projection, /method\.crowdsourced-evaluation\|#众包评测/);
    assert.match(runtime.projection, /\[scientific_topic\]/);
    assert.doesNotMatch(runtime.projection, /众包评估/);
});

test('current selection accepts only preferred Chinese labels and rejects hierarchy duplication', () => {
    const runtime = createTaxonomyRuntime({ registryPath });
    const valid = runtime.validateTagSelection({
        tags: ['#语音可懂度评估', '#众包评测', '#多语言', '#基准测试'],
        primaryTaskTag: '#语音可懂度评估',
        primaryMethodTag: '#众包评测'
    });
    assert.equal(valid.valid, true, valid.errors.join('; '));
    assert.equal(valid.primaryTaskId, 'task.intelligibility');
    assert.equal(valid.primaryMethodId, 'method.crowdsourced-evaluation');
    assert.deepEqual(valid.conceptIds, [
        'task.intelligibility', 'method.crowdsourced-evaluation',
        'setting.multilingual', 'artifact.benchmark'
    ]);

    assert.equal(runtime.resolveCurrentTag('#众包评估', 'method'), null);
    assert.equal(runtime.resolveLegacyTag('#众包评估', 'method').id,
        'method.crowdsourced-evaluation');
    const redundant = runtime.validateTagSelection({
        tags: ['#语音识别', '#音视频语音识别', '#Transformer'],
        primaryTaskTag: '#语音识别',
        primaryMethodTag: '#Transformer'
    });
    assert.equal(redundant.valid, false);
    assert.match(redundant.errors.join('\n'), /最具体|祖先/);
});

test('research-method coverage gives dataset, benchmark, subjective, review and theory papers a real method', () => {
    const runtime = createTaxonomyRuntime({ registryPath });
    const cases = [
        ['dataset', ['#语音识别', '#数据集构建', '#数据集'], '#语音识别', '#数据集构建'],
        ['benchmark', ['#语音识别', '#基准设计', '#基准测试'], '#语音识别', '#基准设计'],
        ['subjective', ['#语音可懂度评估', '#众包评测', '#多语言'], '#语音可懂度评估', '#众包评测'],
        ['review', ['#音频理解', '#系统综述', '#可解释性'], '#音频理解', '#系统综述'],
        ['theory', ['#语音识别', '#形式化分析', '#理论分析'], '#语音识别', '#形式化分析']
    ];
    for (const [name, tags, primaryTaskTag, primaryMethodTag] of cases) {
        const result = runtime.validateTagSelection({ tags, primaryTaskTag, primaryMethodTag });
        assert.equal(result.valid, true, `${name}: ${result.errors.join('; ')}`);
        assert.match(result.primaryMethodId, /^method\./);
    }
    for (const tag of ['#麦克风阵列', '#语音生物标志物', '#对抗鲁棒性']) {
        assert.ok(runtime.allowedTags.has(tag), tag);
    }
});

test('2403 crowdsourced intelligibility fixture cannot reuse end-to-end alias as method', () => {
    const analysis = `## 机器摘要
primary_task_tag: #语音可懂度评估
primary_method_tag: #众包评测

## 标签
#语音可懂度评估 #众包评测 #多语言 #基准测试
主任务标签：#语音可懂度评估
主方法标签：#众包评测
补充标签：#多语言 #基准测试`;
    const parsed = parseAnalysis(analysis);
    assert.equal(parsed.taxonomyValidation.valid, true,
        parsed.taxonomyValidation.errors.join('; '));
    assert.equal(parsed.taxonomyValidation.primaryTaskId, 'task.intelligibility');
    assert.equal(parsed.taxonomyValidation.primaryMethodId, 'method.crowdsourced-evaluation');

    const old = parseAnalysis(analysis.replaceAll('#众包评测', '#端到端'));
    assert.equal(old.primaryMethodTag, '');
    assert.equal(old.taxonomyValidation.valid, false);

    const reorderedSupplemental = analysis.replace(
        '补充标签：#多语言 #基准测试',
        '补充标签：#基准测试 #多语言'
    );
    assert.match(
        contract.validateTagSectionContract(
            reorderedSupplemental, parseAnalysis(reorderedSupplemental)
        ),
        /补充标签必须恰好列出/
    );
});

test('taxonomy stage binding replays registry, IDs, protected bytes and downstream input', () => {
    const analysis = `## 机器摘要
primary_task_tag: #语音可懂度评估
primary_method_tag: #众包评测

## 标签
#语音可懂度评估 #众包评测 #多语言 #基准测试
主任务标签：#语音可懂度评估
主方法标签：#众包评测
补充标签：#多语言 #基准测试`;
    const runtime = createTaxonomyRuntime({ registryPath });
    const parsed = parseAnalysis(analysis);
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    const protectedSha = textSha(require('../scripts/deep-analyzer.js')
        .taxonomyProtectedProjection(analysis));
    const binding = {
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: runtime.selectionContract,
        inputAnalysisSha256: textSha(analysis),
        outputAnalysisSha256: textSha(analysis),
        inputProtectedProjectionSha256: protectedSha,
        outputProtectedProjectionSha256: protectedSha,
        taxonomySurfaceSha256: contract.taxonomySurfaceSha256(analysis),
        primaryTaskId: parsed.taxonomyValidation.primaryTaskId,
        primaryMethodId: parsed.taxonomyValidation.primaryMethodId,
        conceptIds: parsed.taxonomyValidation.conceptIds
    };
    const paper = {
        analysis,
        analysisStageCheckpoints: { taxonomySeal: analysis },
        analysisManifest: {
            contracts: { taxonomy: runtime.selectionContract },
            stages: {
                structureRepair: { outputAnalysisSha256: binding.inputAnalysisSha256 },
                taxonomySeal: {
                    status: 'not_needed', ...binding,
                    bindingSha256: contract.manualSha256(binding)
                },
                coreSummaryRepair: { inputAnalysisSha256: binding.outputAnalysisSha256 }
            }
        }
    };
    assert.strictEqual(contract.validateTaxonomyStageBinding(paper, {
        parsed, taxonomyRuntime: runtime
    }), null);
    for (const [field, value] of [
        ['registrySha256', 'f'.repeat(64)],
        ['projectionSha256', 'e'.repeat(64)],
        ['outputAnalysisSha256', 'd'.repeat(64)],
        ['outputProtectedProjectionSha256', 'c'.repeat(64)],
        ['taxonomySurfaceSha256', 'b'.repeat(64)],
        ['primaryMethodId', 'method.transformer'],
        ['bindingSha256', 'a'.repeat(64)]
    ]) {
        const tampered = structuredClone(paper);
        tampered.analysisManifest.stages.taxonomySeal[field] = value;
        assert.ok(contract.validateTaxonomyStageBinding(tampered, {
            parsed, taxonomyRuntime: runtime
        }), field);
    }
});

test('taxonomy complete binding requires exact structure and taxonomy checkpoint bytes', () => {
    const outputAnalysis = `## 机器摘要
primary_task_tag: #语音可懂度评估
primary_method_tag: #众包评测

## 标签
#语音可懂度评估 #众包评测 #多语言 #基准测试
主任务标签：#语音可懂度评估
主方法标签：#众包评测
补充标签：#多语言 #基准测试`;
    const inputAnalysis = outputAnalysis.replaceAll('#众包评测', '#端到端');
    const runtime = createTaxonomyRuntime({ registryPath });
    const parsed = parseAnalysis(outputAnalysis);
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    const binding = {
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: runtime.selectionContract,
        inputAnalysisSha256: textSha(inputAnalysis),
        outputAnalysisSha256: textSha(outputAnalysis),
        inputProtectedProjectionSha256: textSha(contract.taxonomyProtectedProjection(inputAnalysis)),
        outputProtectedProjectionSha256: textSha(contract.taxonomyProtectedProjection(outputAnalysis)),
        taxonomySurfaceSha256: contract.taxonomySurfaceSha256(outputAnalysis),
        primaryTaskId: parsed.taxonomyValidation.primaryTaskId,
        primaryMethodId: parsed.taxonomyValidation.primaryMethodId,
        conceptIds: parsed.taxonomyValidation.conceptIds
    };
    const paper = {
        analysis: outputAnalysis,
        analysisStageCheckpoints: {
            structureRepair: inputAnalysis,
            taxonomySeal: outputAnalysis
        },
        analysisManifest: {
            contracts: { taxonomy: runtime.selectionContract },
            stages: {
                structureRepair: { outputAnalysisSha256: binding.inputAnalysisSha256 },
                taxonomySeal: {
                    status: 'complete', ...binding,
                    bindingSha256: contract.manualSha256(binding)
                },
                coreSummaryRepair: { inputAnalysisSha256: binding.outputAnalysisSha256 }
            }
        }
    };
    const validate = candidate => contract.validateTaxonomyStageBinding(candidate, {
        parsed, taxonomyRuntime: runtime
    });
    assert.strictEqual(validate(paper), null);

    for (const checkpoint of ['structureRepair', 'taxonomySeal']) {
        const tampered = structuredClone(paper);
        tampered.analysisStageCheckpoints[checkpoint] += '\nDRIFT';
        assert.ok(validate(tampered), checkpoint);
    }
    const missing = structuredClone(paper);
    delete missing.analysisStageCheckpoints;
    assert.match(validate(missing), /checkpoint/);
});

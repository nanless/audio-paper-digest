'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseAnalysis } = require('../scripts/utils.js');
const contract = require('../scripts/analysis-contract.js');
const {
    createTagRules,
    buildTagPromptText,
    TAG_PROMPT_TEXT_CONTRACT,
    LEGACY_TAG_PROMPT_TEXT_CONTRACT,
    TAG_SELECTION_CONTRACT,
    LEGACY_TAG_SELECTION_CONTRACT,
    isSupportedTagSelectionContract,
    TAG_FLAT_COMPAT_CONTRACT,
    LEGACY_TAG_FLAT_COMPAT_CONTRACT
} = require('../scripts/lib/tag-rules.js');

const registryPath = path.resolve(__dirname, '../config/tag-catalog.json');

test('运行时从词表推导出全部启用的首选标签、角色和紧凑投影', () => {
    const runtime = createTagRules({ registryPath });
    assert.equal(runtime.projectionContract, TAG_PROMPT_TEXT_CONTRACT);
    assert.equal(runtime.selectionContract, TAG_SELECTION_CONTRACT);
    assert.equal(runtime.selectionContract, 'paper-tag-selection-v2');
    assert.equal(LEGACY_TAG_SELECTION_CONTRACT, 'paper-taxonomy-selection-v1');
    assert.equal(isSupportedTagSelectionContract(runtime.selectionContract), true);
    assert.equal(isSupportedTagSelectionContract(LEGACY_TAG_SELECTION_CONTRACT), true);
    assert.equal(isSupportedTagSelectionContract('paper-tag-selection-v1'), false);
    assert.equal(isSupportedTagSelectionContract(null), false);
    assert.equal(runtime.flatCompatContract, TAG_FLAT_COMPAT_CONTRACT);
    assert.equal(runtime.flatCompatContract, 'paper-tag-flat-tags-v2');
    assert.equal(LEGACY_TAG_FLAT_COMPAT_CONTRACT, 'paper-taxonomy-flat-tags-compat-v1');
    assert.match(runtime.projectionSha256, /^[a-f0-9]{64}$/);
    assert.ok(runtime.allowedTags.has('#众包评测'));
    assert.ok(runtime.methodTags.has('#众包评测'));
    assert.ok(!runtime.taskTags.has('#众包评测'));
    assert.ok(runtime.taskTags.has('#语音可懂度评估'));
    assert.match(runtime.projection, /method\.crowdsourced-evaluation\|#众包评测/);
    assert.match(runtime.projection, /\[scientific_topic\]/);
    assert.doesNotMatch(runtime.projection, /众包评估/);
});

test('标签提示保留 v1 全文字节，默认 v2 只更换版本和说明', () => {
    const tagCatalog = {
        version: 'paper-taxonomy-v1', registrySha256: 'a'.repeat(64),
        facets: [{ id: 'task' }, { id: 'method' }],
        concepts: [
            { id: 'method.b', facet: 'method', status: 'active',
                preferredLabel: { zh: '方法乙' }, definition: '方法|说明', scopeNote: '范围\n说明' },
            { id: 'task.z', facet: 'task', status: 'deprecated',
                preferredLabel: { zh: '停用任务' }, definition: '停用', scopeNote: '不输出' },
            { id: 'task.a', facet: 'task', status: 'active',
                preferredLabel: { zh: '任务甲' }, definition: '  任务   说明 ', scopeNote: '任务范围' }
        ]
    };
    const expectedV1 = 'contract=paper-taxonomy-prompt-projection-v1\n'
        + 'registry_version=paper-taxonomy-v1\n'
        + `registry_sha256=${'a'.repeat(64)}\n`
        + '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。\n'
        + '[task]\ntask.a|#任务甲|任务 说明|任务范围\n'
        + '[method]\nmethod.b|#方法乙|方法 说明|范围 说明\n';
    assert.equal(buildTagPromptText(tagCatalog, LEGACY_TAG_PROMPT_TEXT_CONTRACT), expectedV1);
    assert.equal(crypto.createHash('sha256').update(expectedV1).digest('hex'),
        'e16ddf3cea3935f48d3fab11c299c075c2ffe5734d29ce8cf792ac51d2d17d09');
    const expectedV2 = expectedV1.replace('contract=paper-taxonomy-prompt-projection-v1',
        'contract=paper-tag-prompt-text-v2').replace(
        '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。',
        '只能选择以下已启用概念的中文首选标签。ID 用于区分概念；不要创建新标签，也不要改用同义词。');
    assert.equal(buildTagPromptText(tagCatalog), expectedV2);
    assert.equal(buildTagPromptText(tagCatalog, TAG_PROMPT_TEXT_CONTRACT), expectedV2);
    assert.equal(TAG_PROMPT_TEXT_CONTRACT, 'paper-tag-prompt-text-v2');
    for (const value of [null, '', false, 1, {}, [], 'paper-tag-prompt-text-v3']) {
        assert.throws(() => buildTagPromptText(tagCatalog, value), /标签提示版本必须为/);
    }
});

test('当前选择只接受首选中文标签，拒绝层级重复', () => {
    const runtime = createTagRules({ registryPath });
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
    assert.match(redundant.errors.join('\n'), /最具体|上级概念/);
});

test('选择约定把 task facet 限制为一个主任务加两个补充任务', () => {
    const runtime = createTagRules({ registryPath });
    const fourTasks = runtime.validateTagSelection({
        tags: ['#语音合成', '#语音克隆', '#音视频生成', '#音频理解', '#Transformer'],
        primaryTaskTag: '#语音合成',
        primaryMethodTag: '#Transformer'
    });
    assert.equal(fourTasks.valid, false);
    assert.deepEqual(fourTasks.errors, [
        '任务标签须有 1–3 个，其中主任务为 1 个，次任务不超过 2 个；'
        + '当前 4 个: #语音合成 #语音克隆 #音视频生成 #音频理解'
    ]);
    assert.deepEqual(fourTasks.conceptIds, []);

    const threeTasks = runtime.validateTagSelection({
        tags: ['#语音合成', '#语音克隆', '#语音转换', '#Transformer'],
        primaryTaskTag: '#语音合成',
        primaryMethodTag: '#Transformer'
    });
    assert.equal(threeTasks.valid, true, threeTasks.errors.join('; '));
    assert.deepEqual(threeTasks.conceptIds, [
        'task.speech-synthesis', 'task.voice-cloning',
        'task.voice-conversion', 'method.transformer'
    ]);

    const noTaskFacet = runtime.validateTagSelection({
        tags: ['#Transformer', '#低资源', '#基准测试'],
        primaryTaskTag: '#不是任务标签',
        primaryMethodTag: '#Transformer'
    });
    assert.equal(noTaskFacet.valid, false);
    assert.ok(noTaskFacet.errors.some(error => /任务标签须有 1–3 个.*当前 0 个$/.test(error)),
        noTaskFacet.errors.join('; '));
});

test('主任务是否过于宽泛按整个词表判断；该告警不使已有标签阶段记录失效', () => {
    const runtime = createTagRules({ registryPath });
    const analysis = [
        '## 机器摘要',
        'primary_task_tag: #语音识别',
        'primary_method_tag: #Transformer',
        '',
        '## 标签',
        '#语音识别 #低资源 #Transformer',
        '主任务标签：#语音识别',
        '主方法标签：#Transformer',
        '补充标签：#低资源',
        ''
    ].join('\n');

    // 非叶主任务：valid 保持 true，只给出结构化 specificityWarning。
    // v1.1 换表后 #语音识别 的 active 后代由 1 个增至 6 个（新词表扩充 ASR 族）。
    const parsed = parseAnalysis(analysis);
    assert.equal(parsed.tagValidation.valid, true,
        parsed.tagValidation.errors.join('; '));
    assert.equal(parsed.tagValidation.specificityWarning,
        '主任务标签过于宽泛：#语音识别 的下级概念中有未被选中的已启用概念（共 6 个）：'
        + '#音视频语音识别 #逆文本规范化 #唇读 #多说话人语音识别 #重叠语音识别 #标点恢复');

    // 叶节点主任务没有 active 后代 → 无告警。
    const leaf = runtime.validateTagSelection({
        tags: ['#标点恢复', '#低资源', '#Transformer'],
        primaryTaskTag: '#标点恢复',
        primaryMethodTag: '#Transformer'
    });
    assert.equal(leaf.valid, true, leaf.errors.join('; '));
    assert.equal(leaf.specificityWarning, null);

    // 告警不使标签节检查失败，也不使已完成 taxonomySeal 阶段的记录重新校验失败。
    assert.strictEqual(contract.validateTagSectionContract(analysis, parsed), null);
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    const binding = {
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: LEGACY_TAG_SELECTION_CONTRACT,
        inputAnalysisSha256: textSha(analysis),
        outputAnalysisSha256: textSha(analysis),
        inputProtectedProjectionSha256: textSha(
            require('../scripts/deep-analyzer.js').maskClassificationFields(analysis)),
        outputProtectedProjectionSha256: textSha(
            require('../scripts/deep-analyzer.js').maskClassificationFields(analysis)),
        taxonomySurfaceSha256: contract.hashTagSectionAndPrimaryTags(analysis),
        primaryTaskId: parsed.tagValidation.primaryTaskId,
        primaryMethodId: parsed.tagValidation.primaryMethodId,
        conceptIds: parsed.tagValidation.conceptIds
    };
    const paper = {
        analysis,
        analysisStageCheckpoints: { taxonomySeal: analysis },
        analysisManifest: {
            contracts: { taxonomy: LEGACY_TAG_SELECTION_CONTRACT },
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
    assert.strictEqual(contract.validateTagStageProof(paper, {
        parsed, tagRules: runtime
    }), null);
});

test('研究方法覆盖让数据集、基准、主观、综述和理论类论文都有真正的方法标签', () => {
    const runtime = createTagRules({ registryPath });
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

test('2403 众包可懂度测试样例不能把端到端别名当成方法', () => {
    const analysis = `## 机器摘要
primary_task_tag: #语音可懂度评估
primary_method_tag: #众包评测

## 标签
#语音可懂度评估 #众包评测 #多语言 #基准测试
主任务标签：#语音可懂度评估
主方法标签：#众包评测
补充标签：#多语言 #基准测试`;
    const parsed = parseAnalysis(analysis);
    assert.equal(parsed.tagValidation.valid, true,
        parsed.tagValidation.errors.join('; '));
    assert.equal(parsed.tagValidation.primaryTaskId, 'task.intelligibility');
    assert.equal(parsed.tagValidation.primaryMethodId, 'method.crowdsourced-evaluation');

    const old = parseAnalysis(analysis.replaceAll('#众包评测', '#端到端'));
    assert.equal(old.primaryMethodTag, '');
    assert.equal(old.tagValidation.valid, false);

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

test('标签阶段记录核对词表、概念 ID、受保护正文和后续阶段输入', () => {
    const analysis = `## 机器摘要
primary_task_tag: #语音可懂度评估
primary_method_tag: #众包评测

## 标签
#语音可懂度评估 #众包评测 #多语言 #基准测试
主任务标签：#语音可懂度评估
主方法标签：#众包评测
补充标签：#多语言 #基准测试`;
    const runtime = createTagRules({ registryPath });
    const parsed = parseAnalysis(analysis);
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    const protectedSha = textSha(require('../scripts/deep-analyzer.js')
        .maskClassificationFields(analysis));
    const binding = {
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: LEGACY_TAG_SELECTION_CONTRACT,
        inputAnalysisSha256: textSha(analysis),
        outputAnalysisSha256: textSha(analysis),
        inputProtectedProjectionSha256: protectedSha,
        outputProtectedProjectionSha256: protectedSha,
        taxonomySurfaceSha256: contract.hashTagSectionAndPrimaryTags(analysis),
        primaryTaskId: parsed.tagValidation.primaryTaskId,
        primaryMethodId: parsed.tagValidation.primaryMethodId,
        conceptIds: parsed.tagValidation.conceptIds
    };
    const paper = {
        analysis,
        analysisStageCheckpoints: { taxonomySeal: analysis },
        analysisManifest: {
            contracts: { taxonomy: LEGACY_TAG_SELECTION_CONTRACT },
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
    assert.strictEqual(contract.validateTagStageProof(paper, {
        parsed, tagRules: runtime
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
        assert.ok(contract.validateTagStageProof(tampered, {
            parsed, tagRules: runtime
        }), field);
    }
});

test('标签阶段标为 complete 时，必须保留匹配的结构修复和标签正文检查点', () => {
    const outputAnalysis = `## 机器摘要
primary_task_tag: #语音可懂度评估
primary_method_tag: #众包评测

## 标签
#语音可懂度评估 #众包评测 #多语言 #基准测试
主任务标签：#语音可懂度评估
主方法标签：#众包评测
补充标签：#多语言 #基准测试`;
    const inputAnalysis = outputAnalysis.replaceAll('#众包评测', '#端到端');
    const runtime = createTagRules({ registryPath });
    const parsed = parseAnalysis(outputAnalysis);
    const textSha = value => crypto.createHash('sha256').update(value).digest('hex');
    const binding = {
        registryVersion: runtime.registryVersion,
        registrySha256: runtime.registrySha256,
        projectionContract: runtime.projectionContract,
        projectionSha256: runtime.projectionSha256,
        selectionContract: LEGACY_TAG_SELECTION_CONTRACT,
        inputAnalysisSha256: textSha(inputAnalysis),
        outputAnalysisSha256: textSha(outputAnalysis),
        inputProtectedProjectionSha256: textSha(contract.maskClassificationFields(inputAnalysis)),
        outputProtectedProjectionSha256: textSha(contract.maskClassificationFields(outputAnalysis)),
        taxonomySurfaceSha256: contract.hashTagSectionAndPrimaryTags(outputAnalysis),
        primaryTaskId: parsed.tagValidation.primaryTaskId,
        primaryMethodId: parsed.tagValidation.primaryMethodId,
        conceptIds: parsed.tagValidation.conceptIds
    };
    const paper = {
        analysis: outputAnalysis,
        analysisStageCheckpoints: {
            structureRepair: inputAnalysis,
            taxonomySeal: outputAnalysis
        },
        analysisManifest: {
            contracts: { taxonomy: LEGACY_TAG_SELECTION_CONTRACT },
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
    const validate = candidate => contract.validateTagStageProof(candidate, {
        parsed, tagRules: runtime
    });
    assert.strictEqual(validate(paper), null);

    for (const checkpoint of ['structureRepair', 'taxonomySeal']) {
        const tampered = structuredClone(paper);
        tampered.analysisStageCheckpoints[checkpoint] += '\nDRIFT';
        assert.ok(validate(tampered), checkpoint);
    }
    const missing = structuredClone(paper);
    delete missing.analysisStageCheckpoints;
    assert.match(validate(missing), /正文检查点缺失/);
});

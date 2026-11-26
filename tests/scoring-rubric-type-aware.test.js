'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scoring = require('../scripts/lib/scoring-rubric.js');
const scoringContract = require('../scripts/lib/scoring-audit-contract.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const readerIdentityFormat = require('../scripts/lib/reader-identity-format.js');
const probe = require('../scripts/lib/public-resource-probe.js');
const utils = require('../scripts/utils.js');
const analysisContract = require('../scripts/analysis-contract.js');

const ROOT = path.resolve(__dirname, '..');

function makeV2Audit(overrides = {}) {
    const header = scoringFormat.currentEvidenceProfileHeader();
    const baseDims = {
        innovation: { score: 8.5, reason: '[A_METHOD] 提出了带清晰机制洞察的架构创新，相较现有基线有明确突破。' },
        technicalRigor: { score: 8.2, reason: '[A_METHOD] 核心推导与模块输入输出定义自洽，边界假设交代清楚。' },
        experimentalSufficiency: { score: 8.6, reason: '[A_RESULTS] 覆盖多项公开权威基准、强基线与完整消融实验。' },
        clarity: { score: 8.2, reason: '[A_SUMMARY] 章节组织紧凑，符号、公式与图表前后一致且易于核对。' },
        impact: { score: 8.8, reason: '[A_SUMMARY] 在核心音频基准上显著推进前沿，对后续研究具备直接价值。' },
        openSource: { score: 10.0, reason: '[A_OPEN] 代码仓库、模型权重与完整安装推理微调文档均已核验可用。' },
        reproducibility: { score: 7.5, reason: '[A_METHOD] 公开了训练配置、超参数与评测协议，仅个别硬件细节略简。' },
        engineering: { score: 8.5, reason: '[A_RESULTS] 给出了端到端延迟与吞吐实测数据及可复用推理管线。' }
    };
    const baseProfile = {
        ...header,
        multiComponentClaimed: true,
        ablationStatus: 'direct',
        targetEvaluation: 'public',
        sampleScaleReported: true,
        deploymentMeasured: true,
        publicGeneralizationEvaluated: true,
        engineeringEvidence: 'measured_deployment',
        evidenceBoundary: '[A_RESULTS] 主结论覆盖公开基准与直接消融，并包含推理延迟实测数据。',
        evidenceIds: ['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY'],
        primaryStrengths: [
            '[A_METHOD] 提出统一音视频联合建模架构并给出可核对的组件推导。',
            '[A_RESULTS] 在多项公开基准上超越强基线并附带组件消融与延迟实测。'
        ],
        primaryDefects: [
            '[A_METHOD] 极端噪声及低资源语种上的鲁棒性尚未系统验证。'
        ]
    };
    return {
        documentType: overrides.documentType || '模型报告',
        confidence: overrides.confidence || '高',
        evidenceProfile: { ...baseProfile, ...(overrides.evidenceProfile || {}) },
        dimensions: { ...baseDims, ...(overrides.dimensions || {}) }
    };
}

function makeResourceIdentity(sourceText, resources) {
    const body = {
        ...readerIdentityFormat.header('resources'),
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        resources
    };
    return { ...body, identitySha256: probe.stableFingerprint(body) };
}

test('type-aware-v2 权重和为 100%、精确整数千分位总分与 Python 逐位一致', () => {
    for (const [docType, policy] of Object.entries(scoring.SPEC.documentTypes)) {
        const sum = Object.values(policy.coreWeightPct).reduce((a, b) => a + b, 0);
        assert.equal(sum, 100, `${docType} 核心权重和必须精确等于 100%`);
        assert.ok(policy.openSourceMaxBonusTenths >= 2 && policy.openSourceMaxBonusTenths <= 8);
    }
    const vectors = [
        ['模型报告', { innovation: 8.5, technicalRigor: 8.2, experimentalSufficiency: 8.6, clarity: 8.2, impact: 8.8, reproducibility: 7.5, engineering: 8.5, openSource: 10.0 }, 9.1, '前10%'],
        ['模型报告', { innovation: 8.5, technicalRigor: 8.2, experimentalSufficiency: 8.6, clarity: 8.2, impact: 8.8, reproducibility: 7.5, engineering: 8.5, openSource: 0.0 }, 8.5, '前10%'],
        ['理论研究', { innovation: 8.0, technicalRigor: 8.5, experimentalSufficiency: 7.0, clarity: 8.0, impact: 7.5, reproducibility: 7.0, engineering: 0.0, openSource: 3.0 }, 8.0, '前25%'],
        ['数据集与基准', { innovation: 7.2, technicalRigor: 7.5, experimentalSufficiency: 7.8, clarity: 7.5, impact: 8.0, reproducibility: 8.0, engineering: 7.5, openSource: 10.0 }, 8.5, '前10%'],
        ['方法研究', { innovation: 6.0, technicalRigor: 6.2, experimentalSufficiency: 5.8, clarity: 6.0, impact: 5.5, reproducibility: 5.5, engineering: 5.5, openSource: 0.0 }, 5.9, '后50%']
    ];
    for (const [docType, scores, expectedTotal, expectedBucket] of vectors) {
        const jsRes = scoring.calculateWeightedTotal(docType, scores);
        assert.equal(jsRes.total, expectedTotal);
        assert.equal(jsRes.rankBucket, expectedBucket);
    }
    // Cross-language Python exact parity on all 5 vectors
    const pyOut = execFileSync('bash', [
        path.join(ROOT, 'scripts/python-runtime.sh'), '-c',
        `import json, sys; sys.path.insert(0, 'scripts'); import scoring_rubric as sr
vectors = json.loads(sys.stdin.read())
out = [sr.calculate_weighted_total(dt, sc) for dt, sc in vectors]
print(json.dumps(out, ensure_ascii=False))`
    ], { cwd: ROOT, input: JSON.stringify(vectors.map(([dt, sc]) => [dt, sc])), encoding: 'utf8' });
    const pyResults = JSON.parse(pyOut);
    vectors.forEach(([docType, scores], i) => {
        const jsRes = scoring.calculateWeightedTotal(docType, scores);
        assert.deepEqual(pyResults[i], jsRes, `Python/JS 计算在向量 ${i} (${docType}) 必须逐位一致`);
    });
});

test('真盲审 prepareScoringAuditAnalysis 彻底剥离旧总分、旧机器摘要分值/分档/置信度与旧评分理由', () => {
    const rawAnalysis = [
        '## 评分',
        '8.4/10',
        '',
        '## 机器摘要',
        'rubric_version: type-aware-v2',
        'document_type: 模型报告',
        'rank_bucket: 前25%',
        'innovation: 8.4',
        'technical_rigor: 8.1',
        'experimental_sufficiency: 8.3',
        'clarity: 8.0',
        'impact: 8.5',
        'open_source: 8.0',
        'reproducibility: 7.6',
        'engineering_score: 8.2',
        'confidence: 高',
        'primary_task_tag: #语音理解',
        'primary_method_tag: #多模态大语言模型',
        'sota_claim: 是',
        'has_code: 是',
        'has_model: 是',
        'has_dataset: 否',
        '',
        '## 核心摘要',
        '模型在多个音频基准上刷新基线。',
        '',
        '## 评分理由',
        '* 创新性 (8.4/10)：旧理由不应被审计模型看见。'
    ].join('\n');
    const blinded = scoringContract.prepareScoringAuditAnalysis(rawAnalysis);
    assert.doesNotMatch(blinded, /8\.4\/10/);
    assert.doesNotMatch(blinded, /旧理由不应被审计模型看见/);
    assert.doesNotMatch(blinded, /^rank_bucket\s*:/m);
    assert.doesNotMatch(blinded, /^innovation\s*:/m);
    assert.doesNotMatch(blinded, /^open_source\s*:/m);
    assert.doesNotMatch(blinded, /^confidence\s*:/m);
    assert.doesNotMatch(blinded, /^rubric_version\s*:/m);
    assert.match(blinded, /^document_type:\s*模型报告/m);
    assert.match(blinded, /^has_code:\s*是/m);
    assert.match(blinded, /模型在多个音频基准上刷新基线/);
});

test('v2 defectProfile 校验、有效证据上限裁剪与总分硬红线（8.4 / 7.2）', () => {
    const allowed = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);

    // Missing primaryStrengths / un-cited defect rejected
    const badStrength = makeV2Audit({ evidenceProfile: { primaryStrengths: [] } });
    assert.throws(() => scoringContract.parseScoringAuditResult(JSON.stringify(badStrength), allowed), /primaryStrengths/);
    const uncitedDefect = makeV2Audit({ evidenceProfile: { primaryDefects: ['缺少跨语种泛化验证但没有引用账本编号。'] } });
    assert.throws(() => scoringContract.parseScoringAuditResult(JSON.stringify(uncitedDefect), allowed), /缺少证据账本 ID/);

    // Effective v2 caps: multi-component no ablation -> exp <= 6.5; claim_only -> eng <= 5.5
    const uncapped = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '方法研究',
        evidenceProfile: {
            multiComponentClaimed: true,
            ablationStatus: 'none',
            deploymentMeasured: false,
            engineeringEvidence: 'claim_only'
        },
        dimensions: {
            ...makeV2Audit().dimensions,
            experimentalSufficiency: { score: 8.8, reason: '[A_RESULTS] 主基准表现强劲但缺少组件级直接消融验证。' },
            engineering: { score: 8.0, reason: '[A_RESULTS] 论文声称适合端侧部署但未给出实测延迟与吞吐。' }
        }
    })), allowed);
    const capped = scoringContract.applyScoringEvidenceCaps(uncapped);
    assert.equal(capped.dimensions.experimentalSufficiency.score, 6.5);
    assert.equal(capped.dimensions.engineering.score, 5.5);
    assert.equal(capped.capsApplied.length, 2);

    // Non-high confidence hard ceiling 8.4
    const medHigh = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({ confidence: '中' })), allowed);
    assert.throws(() => scoringContract.applyScoringEvidenceCaps(medHigh), /总分不得超过 8\.4/);

    // No ablation + internal eval hard ceiling 7.2
    const noAblInternal = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        evidenceProfile: {
            multiComponentClaimed: true,
            ablationStatus: 'none',
            targetEvaluation: 'internal'
        },
        dimensions: {
            ...makeV2Audit().dimensions,
            innovation: { score: 9.2, reason: '[A_METHOD] 提出全新端到端多阶段声学架构，设计极具原创性。' },
            technicalRigor: { score: 9.0, reason: '[A_METHOD] 推导完整严密，理论假设与目标函数前后闭合。' },
            impact: { score: 9.0, reason: '[A_SUMMARY] 针对核心实时音频交互瓶颈提出系统性解决方案。' },
            engineering: { score: 9.0, reason: '[A_RESULTS] 实测流式推理时延与吞吐，具备完整工程落地能力。' },
            openSource: { score: 10.0, reason: '[A_OPEN] 代码权重与完整文档均已核验公开可用。' }
        }
    })), allowed);
    assert.throws(() => scoringContract.applyScoringEvidenceCaps(noAblInternal), /总分不得超过 7\.2/);
});

test('v2 开源资源核验：数据集类按 dataset 给高分、理论研究禁止无产物白嫖、JS/Python 全链路解析闭环', () => {
    const allowed = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);
    const sourceText = 'We release our benchmark dataset and evaluation scripts publicly.';

    // 1. Dataset paper with verified dataset + code gets 8.0+ without requiring model weights
    const dsIdentity = makeResourceIdentity(sourceText, [
        { type: 'dataset', originalUrl: 'https://huggingface.co/datasets/org/audio-bench', availability: 'available' },
        { type: 'code', originalUrl: 'https://github.com/org/audio-bench', availability: 'available' }
    ]);
    const dsAudit = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '数据集与基准',
        dimensions: {
            ...makeV2Audit().dimensions,
            openSource: { score: 6.0, reason: '[A_OPEN] 数据集与评测代码已公开但未提供模型权重。' }
        }
    })), allowed);
    const dsNorm = scoringContract.validateScoringAuditAgainstAnalysis('## 机器摘要\nhas_dataset: 是\nhas_code: 是\nhas_model: 否\n## 开源详情\n数据集已公开', dsAudit, dsIdentity, sourceText);
    assert.equal(dsNorm.dimensions.openSource.score, 8.0);
    assert.equal(dsNorm.openSourceMaxBonus, 0.8);

    // 2. Theory paper without verified code/data artifact cannot get 10.0 freebie (capped to 3.0 & B_t=0.2)
    const theoryIdentity = makeResourceIdentity(sourceText, []);
    const theoryAudit = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '理论研究',
        evidenceProfile: {
            multiComponentClaimed: false,
            ablationStatus: 'not_applicable',
            targetEvaluation: 'not_applicable',
            deploymentMeasured: false,
            engineeringEvidence: 'not_applicable'
        },
        dimensions: {
            ...makeV2Audit().dimensions,
            engineering: { score: 0.0, reason: '[A_METHOD] 纯理论声学推导工作不涉及工程系统部署实现。' },
            openSource: { score: 10.0, reason: '[A_OPEN] 正文与附录给出了完整公式证明过程。' }
        }
    })), allowed);
    const theoryNorm = scoringContract.validateScoringAuditAgainstAnalysis('## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n未提及', theoryAudit, theoryIdentity, sourceText);
    assert.equal(theoryNorm.dimensions.openSource.score, 3.0);
    assert.equal(theoryNorm.openSourceMaxBonus, 0.2);
    assert.ok(theoryNorm.openSourceBonus <= 0.07);

    // 3. Full applyScoringAuditResult -> JS parseAnalysis -> validateMachineSummaryContract -> Python validate_publish_parsed & reader_score_line
    const baseAnalysis = [
        '## 评分', '7.0/10', '',
        '## 机器摘要',
        'document_type: 模型报告', 'rank_bucket: 前50%',
        'innovation: 1.0', 'technical_rigor: 1.0', 'experimental_sufficiency: 1.0',
        'clarity: 0.8', 'impact: 1.0', 'open_source: 0.0', 'reproducibility: 0.3', 'engineering_score: 1.0',
        'confidence: 中', 'primary_task_tag: #语音理解', 'primary_method_tag: #多模态大语言模型',
        'sota_claim: 是', 'has_code: 是', 'has_model: 是', 'has_dataset: 否', '',
        '## 评分理由', '* 创新性 (1.0/2)：旧理由'
    ].join('\n');
    const applied = scoringContract.applyScoringAuditResult(baseAnalysis, dsNorm);
    const jsParsed = utils.parseAnalysis(applied);
    assert.equal(jsParsed.scoringRubricVersion, 'type-aware');
    assert.equal(jsParsed.scoreValidation.valid, true);
    assert.equal(analysisContract.validateMachineSummaryContract(applied, jsParsed), null);
    assert.equal(Number(jsParsed.score), dsNorm.total);

    // Archived historical type-aware-v2 analysis stays 100% parseable & valid
    const v2Archived = applied.replace('rubric_version: type-aware', 'rubric_version: type-aware-v2');
    const jsParsedV2 = utils.parseAnalysis(v2Archived);
    assert.equal(jsParsedV2.scoringRubricVersion, 'type-aware-v2');
    assert.equal(jsParsedV2.scoreValidation.valid, true);
    assert.equal(analysisContract.validateMachineSummaryContract(v2Archived, jsParsedV2), null);
    assert.equal(Number(jsParsedV2.score), dsNorm.total);
    assert.equal(scoring.isUnifiedRubric('type-aware'), true);
    assert.equal(scoring.isUnifiedRubric('type-aware-v2'), true);
    assert.equal(scoring.isLegacyRubric('type-aware-v1'), true);

    const pyCheck = execFileSync('bash', [
        path.join(ROOT, 'scripts/python-runtime.sh'), '-c',
        `import json, sys; sys.path.insert(0, 'scripts')
import utils, publish_common as pc, paper_reader_presentation as prp
text = sys.stdin.read()
parsed = utils.parse_analysis(text)
validated = pc.validate_publish_parsed(parsed, 'test', require_reason_dimensions=True, validate_tags=False)
line = prp.reader_score_line(validated)
assert '/10' in line and '/1.5' not in line, line
print(json.dumps({'score': validated['score'], 'rankBucket': validated['rankBucket'], 'rubric': validated['scoringRubricVersion'], 'line': line}, ensure_ascii=False))`
    ], { cwd: ROOT, input: applied, encoding: 'utf8' });
    const pyParsed = JSON.parse(pyCheck);
    assert.equal(pyParsed.score, jsParsed.score);
    assert.equal(pyParsed.rankBucket, jsParsed.rankBucket);
    assert.equal(pyParsed.rubric, 'type-aware');
    assert.match(pyParsed.line, /创新 8\.5\/10/);
});

test('Track B R2 加固：gap-fill type-aware 同步、闭环指纹、三类盲审防漏、上界开源封顶、输入拒空与 P2/P3 分型上限', () => {
    const fs = require('node:fs');
    const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files.js');

    // C1 & H2: prompt alignment
    const gapFill = fs.readFileSync(path.join(ROOT, 'prompts/current/gap-fill.md'), 'utf8');
    assert.match(gapFill, /rubric_version:\s*type-aware\b/);
    assert.doesNotMatch(gapFill, /机器摘要的 17 个键/);
    assert.doesNotMatch(gapFill, /满分依次为 2、1\.5/);
    const auditPrompt = fs.readFileSync(path.join(ROOT, 'prompts/current/scoring-audit.md'), 'utf8');
    assert.doesNotMatch(auditPrompt, /\[A_LIMIT\](?!S)/);
    assert.match(auditPrompt, /\[A_LIMITS\]/);

    // H1: config/scoring-rubric.json inside workflow implementation closure for JS & Python
    for (const entry of ['scripts/deep-analyzer.js', 'scripts/publish-to-blog.py']) {
        const files = collectWorkflowImplementationFiles({ root: ROOT, entryFiles: [entry] });
        assert.ok(files.includes('config/scoring-rubric.json'), `${entry} 闭包必须包含 config/scoring-rubric.json`);
    }

    // H3 & H6: blind stripping closes ### subheading leak, backtick/Chinese alias leak, and ## 论文评价, while preserving legacyReasonOnly
    const leaky = [
        '## 评分', '8.9/10', '### 评分备注', '旧分极高 8.9', '',
        '## 机器摘要',
        'document_type: 方法研究',
        '`innovation`: 9.2',
        '分档: 前10%',
        'has_code: 否',
        '### 评分依据',
        '泄漏子标题 9.2', '',
        '## 论文评价',
        '这篇论文堪称突破性 9 分佳作。', '',
        '## 核心摘要',
        '真实方法与实验事实正文。', '',
        '## 评分理由',
        '* 创新性 (9.2/10)：旧理由', '### 补充说明', '旧理由子节'
    ].join('\n');
    const blinded = scoringContract.prepareScoringAuditAnalysis(leaky);
    assert.doesNotMatch(blinded, /8\.9|9\.2|前10%|泄漏子标题|堪称突破性|旧理由子节/);
    assert.match(blinded, /^document_type:\s*方法研究/m);
    assert.match(blinded, /^has_code:\s*否/m);
    assert.match(blinded, /真实方法与实验事实正文/);
    const legacy = scoringContract.prepareScoringAuditAnalysis(leaky, { legacyReasonOnly: true });
    assert.match(legacy, /8\.9\/10/);
    assert.match(legacy, /堪称突破性/);

    // H4: upper-bound openSource caps + theory null-identity + theory with verified code
    const allowed = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);
    const src = 'We release code on GitHub.';
    const codeOnly = makeResourceIdentity(src, [{ type: 'code', originalUrl: 'https://github.com/org/repo', availability: 'available' }]);
    const inflatedCodeOnly = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '方法研究',
        dimensions: { ...makeV2Audit().dimensions, openSource: { score: 10.0, reason: '[A_OPEN] 代码仓库已公开，误标为完整开放满分。' } }
    })), allowed);
    const cappedPartial = scoringContract.validateScoringAuditAgainstAnalysis('## 机器摘要\nhas_code: 是\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n代码已公开', inflatedCodeOnly, codeOnly, src);
    assert.equal(cappedPartial.dimensions.openSource.score, 6.0, '非数据集论文仅公开代码不含权重时，开源分最高计 6.0');

    const theoryNullId = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '理论研究',
        evidenceProfile: { multiComponentClaimed: false, ablationStatus: 'not_applicable', targetEvaluation: 'not_applicable', deploymentMeasured: false, engineeringEvidence: 'not_applicable' },
        dimensions: { ...makeV2Audit().dimensions, engineering: { score: 0.0, reason: '[A_METHOD] 纯理论推导工作不涉及工程部署。' }, openSource: { score: 8.0, reason: '[A_OPEN] 正文与附录给出了完整证明推导过程。' } }
    })), allowed);
    const theoryNullNorm = scoringContract.validateScoringAuditAgainstAnalysis('## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n未提及', theoryNullId, null, src);
    assert.equal(theoryNullNorm.dimensions.openSource.score, 3.0, '理论研究在 null 资源身份且无产物时也必须受 3.0 上限约束');

    // H5: normalizeTenths rejects null/empty/bool and matches Python Decimal on 8.449999999999999
    assert.ok(Number.isNaN(scoring.normalizeTenths(null)));
    assert.ok(Number.isNaN(scoring.normalizeTenths('')));
    assert.ok(Number.isNaN(scoring.normalizeTenths(false)));
    assert.ok(Number.isNaN(scoring.normalizeTenths(true)));
    assert.equal(scoring.normalizeTenths('8.449999999999999'), 84);
    assert.equal(scoring.normalizeTenths('0.14999999999999999'), 1);

    // P2 & P3: system report internal unmeasured cap (engineering <= 5.5) and flagship model report publicGen no-ablation cap (exp <= 7.5)
    const sysUnmeasured = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '系统技术报告',
        evidenceProfile: {
            multiComponentClaimed: false, ablationStatus: 'not_applicable',
            targetEvaluation: 'internal', sampleScaleReported: true,
            deploymentMeasured: false, publicGeneralizationEvaluated: false,
            engineeringEvidence: 'reusable_pipeline'
        },
        dimensions: { ...makeV2Audit().dimensions, engineering: { score: 7.2, reason: '[A_RESULTS] 给出商用组件物料清单但未实测功耗与端到端延迟。' } }
    })), allowed);
    const sysCapped = scoringContract.applyScoringEvidenceCaps(sysUnmeasured);
    assert.equal(sysCapped.dimensions.engineering.score, 5.5);

    const modelReportNoAbl = scoringContract.parseScoringAuditResult(JSON.stringify(makeV2Audit({
        documentType: '模型报告',
        evidenceProfile: {
            multiComponentClaimed: true, ablationStatus: 'none',
            targetEvaluation: 'public', publicGeneralizationEvaluated: true
        },
        dimensions: { ...makeV2Audit().dimensions, experimentalSufficiency: { score: 8.6, reason: '[A_RESULTS] 在33个公开音视频基准上系统对比强基线但后训练分阶段无消融。' } }
    })), allowed);
    const modelReportCapped = scoringContract.applyScoringEvidenceCaps(modelReportNoAbl);
    assert.equal(modelReportCapped.dimensions.experimentalSufficiency.score, 7.5, '公开泛化模型报告无分阶段消融时实验上限为 7.5 而非 6.5');
});

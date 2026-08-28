const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');

const { validAnalysisText } = require('./valid-analysis-fixture.js');
const {
    REQUIRED_RECOVERY_STAGES,
    manualSha256,
    manualTextSha256,
    validateFreshAuthoringCanonicalBinding,
    validateTutorialPayloadCanonicalBinding,
    validateManualTakeoverManifest,
    validateManualDepthContract,
    MANUAL_DEPTH_CONTRACT_VERSION_V2,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    findManualBoilerplate
} = require('../scripts/analysis-contract.js');
const { isSuccessfulAnalysisRecord } = require('../scripts/analysis-engine.js');
const {
    buildManualRecord,
    buildStagePromptBindings,
    conciseManualImageCaption,
    finalizeManualCanonicalState,
    manualCanonicalReuseFingerprint,
    manualCanonicalWriteDecision,
    normalizeDiscoveredHttpsLinks,
    normalizeManualV4ImageArtifacts,
    parseArgs,
    assertExplicitManualV6Mode,
    readCachedExternalResourceOutcome,
    resolveManualSpecPromptBindings,
    runFixedWorkers,
    shouldReuseCanonical,
    writeCachedExternalResourceOutcome
} = require('../scripts/manual-deep-analysis.js');
const {
    applyImageInsertionPlan,
    buildImageAnchorCatalog
} = require('../scripts/deep-analyzer.js');

function directSha(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function detailedAnalysis() {
    const text = validAnalysisText();
    const methodParagraphs = [
        '输入端把音频波形转换为声学特征，并由编码器提取局部信息；中间模块负责融合上下文和长程依赖，输出端通过任务头生成识别结果。',
        '训练阶段使用公开数据和噪声增强构造多种条件，优化过程包含监督目标、验证集选择和推理时的解码设置。论文没有报告的超参数不由人工补齐。',
        '推理流程先完成特征抽取，再进行上下文融合，最后输出识别序列；各阶段的输入、输出和评价指标保持对应，消融结果只归因于实际移除的模块。'
    ];
    const method = Array.from({ length: 4 }, () => methodParagraphs.join('\n\n')).join('\n\n');
    const summary = Array.from({ length: 3 }, () => '论文研究带噪语音识别中的上下文声学建模。输入音频先经过特征提取和编码器，再由上下文模块融合局部与长程信息，最后输出识别序列。实验覆盖多个公开基准、噪声条件和消融设置，并报告了模型在不同条件下的误差变化。方法的价值来自输入、训练目标和评价指标之间的对应关系；局限是部分超参数、数据划分和部署成本没有完整披露。').join('\n\n');
    const innovation = [
        '1. 既有带噪识别系统依赖固定上下文，本文通过可训练融合模块连接局部特征与长程信息；消融结果显示移除模块后错误率上升，但结论只覆盖受控噪声。该变化不是简单扩大网络，而是改变局部表征进入上下文模块的顺序，并用相同解码预算隔离组件作用；论文尚未证明这种收益能够延伸到完全不同的声学设备。',
        '2. 传统增强没有区分噪声条件，本文采用分条件数据构造与共享监督目标；实验相对同预算基线改善识别结果，不过跨设备迁移仍未验证。训练集、验证集与测试集的职责被分开，因而模型选择不会直接读取测试结果；但公开材料没有给出全部随机种子和置信区间，稳定性证据仍有限。',
        '3. 过去常只报告单次最好值，本文设计主实验与模块消融并保留指标方向；这些证据验证组件作用，却没有给出统计显著性与部署成本。结果按噪声条件和说话人划分解释，不把一个最有利数字外推为普遍改进；延迟、内存与功耗没有板端测量，工程结论只能保持在算法层。'
    ].join('\n\n');
    const results = `实验在多个带噪语音基准上比较主方法与基线，并报告识别错误、噪声鲁棒性和消融变化。实验同时交代训练集、验证集、测试集、噪声类型、说话人划分和评价指标方向，结果需要结合这些条件解读。结果段还应说明每个基线采用的训练数据、相同的预处理和相同的解码设置，避免把数据规模差异误认为模型收益。关键比较问题是完整方法相对同预算基线降低多少 WER，以及移除上下文模块会损失多少收益；表中保留主方法、强基线和关键消融。\n\n| 方法 / 设置 | 带噪 WER↓ | 干净 WER↓ |\n|---|---:|---:|\n| 同预算基线 | 12.4% | 7.2% |\n| 完整方法 | 10.8% | 6.8% |\n| 去掉上下文模块（消融） | 11.7% | 7.0% |\n\n完整方法相比基线在带噪条件下降低 1.6 个百分点，而移除上下文模块后只保留部分收益；但这些差异只覆盖当前数据划分，不能外推到所有说话人或设备。论文没有报告的统计显著性、跨域测试和失败案例不在此处补写。`;
    const details = Array.from({ length: 8 }, (_, index) => `- 细节${index + 1}：输入音频、声学特征、上下文编码、监督目标、验证集和解码设置之间的关系均需按正文保持一致；第${index + 1}项缺失信息不会由常见实现补写。`).join('\n\n');
    const scoringMaxima = ['2', '1.5', '1.5', '1', '1.5', '1.5', '0.5', '1.5'];
    const scoringValues = ['1.5', '1.2', '1.1', '0.8', '1.0', '0.0', '0.3', '1.0'];
    const scoringTags = ['A_METHOD', 'A_METHOD', 'A_RESULTS', 'A_CLARITY', 'A_IMPACT', 'A_OPEN', 'A_REPRO', 'A_ENGINEERING'];
    const scoreEvidence = [
        '可训练上下文融合改变了固定窗口基线的数据流，并由移除模块后的误差上升提供直接消融证据；跨设备条件尚未覆盖。',
        '输入、监督目标与解码输出有完整对应，主实验和消融使用相同评价方向；统计检验与随机种子没有披露。',
        '多个公开带噪基准、统一划分和模块消融支撑主要结论，但没有跨域失败案例和显著性区间。',
        '章节顺序能够从问题、模块、训练推进到结果，指标方向和表格含义清楚；少数实现参数仍只能标成未说明。',
        '鲁棒语音识别具有跨场景价值，多个噪声条件说明方法不是单一示例；尚无真实设备或长期线上证据。',
        '正文未给出本文代码、模型权重或数据产物的可访问地址，因此不把第三方公开基准计作本文开放。',
        '数据划分、监督目标和解码顺序可以重建，但优化器细节、硬件、随机种子和完整超参数仍未报告。',
        '推理链能够落到识别输出并讨论部署边界，不过延迟、内存、功耗和维护成本尚无板端测量。'
    ];
    const scoring = Array.from({ length: 8 }, (_, index) => `* ${['创新性','技术严谨性','实验充分性','清晰度','影响力','开源','可复现性','工程/实践价值'][index]} (${scoringValues[index]}/${scoringMaxima[index]})：[${scoringTags[index]}] ${scoreEvidence[index]}`).join('\n');
    const limits = '1. **论文证据直接支持的边界**\n\n论文没有完整披露部分训练超参数、硬件和随机种子；跨说话人、跨设备和长期部署仍缺少验证。带噪基准与公开数据可以支持方法比较，但不能代替真实场景的失败案例、统计显著性和成本测量。对于长尾噪声、数据分布变化和部署资源约束，现有实验也没有给出足够的稳定性证据。当前表格只覆盖论文选定的噪声强度和公开语料，不能据此宣称所有真实声场都能得到相同收益。\n\n2. **进一步审视**\n\n不同设备、不同说话人和不同噪声强度下的误差可能改变结论，因此需要更广泛的验证。模型在真实环境中的延迟、内存、功耗和维护成本也没有被充分量化，长期运行风险仍待评估。若数据分布持续漂移，固定验证集上的平均改善不一定能保持，后续还应报告失败样本、置信区间和维护成本。部署测试还需要明确流式缓存、峰值内存与端到端实时率，否则算法精度无法直接换算成产品可用性。';
    return text
        .replace(/#{2,3} 核心摘要\n[\s\S]*?(?=\n#{2,3} 方法概述和架构)/, `## 核心摘要\n${summary}\n`)
        .replace(/#{2,3} 方法概述和架构\n[\s\S]*?(?=\n#{2,3} 核心创新点)/, `## 方法概述和架构\n${method}\n`)
        .replace(/#{2,3} 核心创新点\n[\s\S]*?(?=\n#{2,3} 实验结果)/, `## 核心创新点\n${innovation}\n`)
        .replace(/#{2,3} 实验结果\n[\s\S]*?(?=\n#{2,3} 细节详述)/, `## 实验结果\n${results}\n`)
        .replace(/#{2,3} 细节详述\n[\s\S]*?(?=\n#{2,3} 评分理由)/, `## 细节详述\n${details}\n`)
        .replace(/#{2,3} 评分理由\n[\s\S]*?(?=\n#{2,3} 局限与问题)/, `## 评分理由\n${scoring}\n`)
        .replace(/#{2,3} 局限与问题\n[\s\S]*?(?=\n#{2,3} 开源详情)/, `## 局限与问题\n${limits}\n`);
}

function baseSpec() {
    const sourceText = [
        'This paper studies robust speech recognition with contextual acoustic modeling.',
        'The authors evaluate the method on several noisy speech benchmarks and report ablations.',
        'The paper states that missing hyperparameters are not fully specified.'
    ].join('\n');
    const evidenceLedger = [
        ['E01', '核心摘要', '论文研究了带上下文声学建模的鲁棒语音识别问题。', 'This paper studies robust speech recognition with contextual acoustic modeling.'],
        ['E02', '方法概述和架构', '方法明确使用上下文声学建模作为核心中间模块。', 'contextual acoustic modeling'],
        ['E03', '实验结果', '论文在多个带噪语音基准上进行系统评测并报告结果。', 'several noisy speech benchmarks'],
        ['E04', '实验结果', '论文明确报告了消融实验并将其作为因果证据。', 'report ablations'],
        ['E05', '局限与问题', '论文说明部分训练超参数并未被完整公开，影响复现。', 'missing hyperparameters are not fully specified'],
        ['E06', '开源详情', '论文的作者在实验段落中明确介绍了评测设置。', 'The authors evaluate the method']
    ].map(([id, section, claim, sourceQuote]) => ({ id, section, claim, sourceQuote }));
    const analysis = detailedAnalysis();
    const sourceSha256 = directSha(sourceText);
    const analysisSha256 = manualTextSha256(analysis);
    const audit = {
        version: 1,
        attempts: 2,
        passes: [
            { status: 'revise', issues: ['初审发现方法段需要补足三段边界说明'] },
            { status: 'pass', issues: [] }
        ],
        checks: {
            sourceCoverage: true,
            promptConformance: true,
            factualClaimsLedger: true,
            scoreRecomputed: true,
            methodContract: true,
            tableContract: true,
            boilerplateScan: true,
            finalContract: true
        }
    };
    const claimHints = {
        imageDownload: '图片图注下载', primaryAnalysis: '方法输入输出', openSourceScan: '开源代码权重数据集',
        demoLinkScan: '演示链接部署', revision: '正文事实修订', tableRepair: '实验表格指标基线',
        methodRepair: '方法架构训练推理', structureRepair: '章节结构摘要标签',
        scoringAudit: '评分维度总分', imageSupplement: '插图caption段落'
    };
    const reviewedClaimsByStage = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
        stage,
        [`${stage} 专项复核${claimHints[stage]}，已对照全文输入、输出和最终正文。`]
    ]));
    const auditSha256 = manualSha256(audit);
    const stageEvidence = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const claims = reviewedClaimsByStage[stage];
        const inputSha256 = manualSha256({ stage, sourceSha256, analysisSha256, claims });
        return [stage, {
            status: 'manual_complete',
            inputSha256,
            outputSha256: analysisSha256,
            auditSha256: manualSha256({ stage, claims, auditSha256, stageInputSha256: inputSha256 }),
            attempts: 2,
            reviewedClaims: claims
        }];
    }));
    const manifest = {
        version: 1,
        contracts: { experimentTables: 'bounded-v1', methodDetail: 'detailed-v1' },
        sourceAcquisition: { sourceSha256 },
        stages: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [stage, { status: 'manual_complete' }])),
        manualTakeover: {
            version: 2,
            mode: 'manual_complete',
            agent: 'Codex',
            basis: 'full_text',
            sourceSha256,
            promptSha256: 'a'.repeat(64),
            analysisSha256,
            completedAt: '2026-08-20T10:00:00.000+08:00',
            reason: '测试用完整全文人工审计与二次修订 provenance。',
            review: { sourceVerified: true, analysisContractVerified: true, scoringVerified: true, stageEvidenceVerified: true },
            evidenceLedger,
            evidenceLedgerSha256: manualSha256(evidenceLedger),
            audit,
            stageEvidence
        }
    };
    return { sourceText, sourceSha256, analysis, analysisSha256, manifest };
}

function buildReusableRecord(options = {}) {
    const fixture = baseSpec();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-reuse-'));
    const sourcePath = path.join(dir, 'paper.txt');
    const sourceText = fixture.sourceText.repeat(20) + (options.sourceSuffix || '');
    fs.writeFileSync(sourcePath, sourceText);
    const audit = JSON.parse(JSON.stringify(fixture.manifest.manualTakeover.audit));
    audit.attempts = 3;
    audit.passes = [
        audit.passes[0],
        { status: 'revise', issues: ['二审复核阶段专属证据'] },
        audit.passes[1]
    ];
    const spec = {
        analysis: fixture.analysis,
        fullTextPath: sourcePath,
        sourceSha256: directSha(fs.readFileSync(sourcePath)),
        evidenceLedger: JSON.parse(JSON.stringify(fixture.manifest.manualTakeover.evidenceLedger)),
        manualAudit: audit,
        reviewedClaimsByStage: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
            stage, fixture.manifest.manualTakeover.stageEvidence[stage].reviewedClaims
        ])),
        reason: fixture.manifest.manualTakeover.reason,
        agent: 'Codex'
    };
    spec.manualAuthoringPromptSha256 = directSha(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'manual-analysis-record.md')));
    if (options.mutateSpec) options.mutateSpec(spec);
    const promptBindings = buildStagePromptBindings();
    if (options.mutatePrompts) options.mutatePrompts(promptBindings);
    const paper = {
        arxivId: options.id || '2608.21000',
        title: 'Reusable fixture paper',
        authors: [],
        categories: []
    };
    const record = buildManualRecord(paper, spec, '2026-08-20', promptBindings, {
        manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3
    });
    return { dir, sourcePath, sourceText, spec, promptBindings, paper, record };
}

function promoteReusableRecordToV4(record) {
    const promoted = JSON.parse(JSON.stringify(record));
    const takeover = promoted.analysisManifest.manualTakeover;
    promoted.analysisManifest.contracts = {
        ...promoted.analysisManifest.contracts,
        experimentTables: 'evidence-rich-v2',
        manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V4,
        imageNarrative: 'context-bound-v1',
        editorialQuality: 'reader-facing-v1'
    };
    takeover.review.readerQualityVerified = true;
    takeover.documentType = '方法研究';
    takeover.resultClaims = [1, 2, 3].map(index => ({
        datasetOrSetting: `fixture-${index}`,
        splitOrCondition: `condition-${index}`,
        method: '完整方法',
        baseline: '同预算基线',
        metric: 'WER',
        value: `${10 + index}.0%`,
        unit: '%',
        direction: 'lower_is_better',
        sourceQuote: `fixture-${index} condition-${index} 完整方法与同预算基线的 WER 为 ${10 + index}.0%，越低越好。`,
        sourceBindings: {
            datasetOrSetting: `fixture-${index}`,
            splitOrCondition: `condition-${index}`,
            method: '完整方法',
            baseline: '同预算基线',
            metric: 'WER',
            value: `${10 + index}.0%`,
            unit: `${10 + index}.0%`,
            direction: '越低越好'
        },
        readerBindings: {
            datasetOrSetting: '带噪条件',
            splitOrCondition: '同预算',
            method: '完整方法',
            baseline: '同预算基线',
            metric: 'WER↓',
            value: `${10 + index}.0%`,
            unit: `${10 + index}.0%`,
            direction: 'WER↓'
        }
    }));
    takeover.resultClaimsSha256 = manualSha256({ claims: takeover.resultClaims, exception: null });
    const dimensions = [
        'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
        'factLocality', 'terminologyAndPerspective', 'sentenceRhythm', 'antiTemplateOriginality'
    ];
    takeover.readabilityRubric = {
        dimensions: Object.fromEntries(dimensions.map(name => [name, {
            score: 2,
            reason: `${name} 已逐项复核并绑定正文。`,
            evidence: [`${name}-evidence`]
        }]))
    };
    takeover.readabilityRubricSha256 = manualSha256(takeover.readabilityRubric);
    takeover.editorialQualityMetrics = { issueCount: 0, warningCount: 0 };
    return promoted;
}

describe('manual canonical runtime controls', () => {
    it('normalizes discovered bare public domains to HTTPS before caching provenance', () => {
        assert.deepStrictEqual(normalizeDiscoveredHttpsLinks([
            'github.com/example/project',
            'https://example.com/demo',
            'javascript:alert(1)',
            'github.com/example/project',
        ]), [
            'https://github.com/example/project',
            'https://example.com/demo',
        ]);
    });

    it('固定 worker 池最多并发处理 3 篇且不漏项', async () => {
        let active = 0;
        let maxActive = 0;
        const seen = [];
        await runFixedWorkers(Array.from({ length: 8 }, (_, index) => index), async item => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 10));
            seen.push(item);
            active--;
        });
        assert.equal(maxActive, 3);
        assert.deepStrictEqual(seen.sort((a, b) => a - b), Array.from({ length: 8 }, (_, index) => index));
    });

    it('外部资源成功结果在 24 小时内持久复用，过期后失效', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-resource-cache-'));
        const originalPath = Config.FILES.manualExternalResourceCache;
        Config.FILES.manualExternalResourceCache = path.join(tempDir, 'cache.json');
        const checkedAt = '2026-08-26T10:00:00+08:00';
        const url = 'https://example.com/project';
        try {
            writeCachedExternalResourceOutcome({
                url,
                status: 'reachable_public_https',
                finalUrl: `${url}/home`,
                httpStatus: 200,
                discoveredLinks: ['https://github.com/example/project']
            }, checkedAt);
            assert.deepStrictEqual(
                readCachedExternalResourceOutcome(url, Date.parse(checkedAt) + 60_000),
                {
                    url,
                    status: 'reachable_public_https',
                    finalUrl: `${url}/home`,
                    httpStatus: 200,
                    discoveredLinks: ['https://github.com/example/project'],
                    verifiedAt: checkedAt
                }
            );
            assert.equal(
                readCachedExternalResourceOutcome(url, Date.parse(checkedAt) + 24 * 60 * 60 * 1000 + 1),
                null
            );
        } finally {
            Config.FILES.manualExternalResourceCache = originalPath;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

describe('manual v5 fresh canonical compatibility', () => {
    it('历史 v5 无 fresh marker 时不追溯判坏', () => {
        const manifest = { contracts: { manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V5 } };
        assert.equal(validateFreshAuthoringCanonicalBinding(manifest, {}), null);
    });

    it('新 v5 fresh marker 存在但缺 receipt 时必须失败', () => {
        const manifest = { contracts: {
            manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V5,
            freshAuthoring: 'fresh-authoring-v1'
        } };
        assert.match(
            validateFreshAuthoringCanonicalBinding(manifest, {}),
            /manualTakeover\.freshAuthoring 缺失/
        );
    });

    it('历史 v5 无 tutorial marker 只读兼容，新 marker 缺 sealed payload 时失败', () => {
        const historical = { contracts: { manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V5 } };
        assert.equal(validateTutorialPayloadCanonicalBinding(historical, {}), null);
        const current = { contracts: {
            manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V5,
            tutorialPayload: 'manual-v5-tutorial-payload-v1'
        }, sourceAcquisition: { sourceId: '2608.12345' } };
        assert.match(
            validateTutorialPayloadCanonicalBinding(current, {}),
            /manualTakeover\.tutorialPayload 缺失/
        );
    });
});

describe('manual_complete v3 deep-analysis contract', () => {
    it('保留完整图注意义，不以字符数或分号制造半句截断', () => {
        const longSingleSentence = `Fig. 1: ${'Illustration of the considered active sonar scenario '.repeat(5).trim()} in a time-varying multipath channel.`;
        const normalized = conciseManualImageCaption(longSingleSentence, 80);
        assert.equal(normalized, '论文实验设置与数据关系示意图');

        const semicolonCaption = 'Fig. 2: First comparison branch; second comparison branch; final controlled conclusion.';
        assert.equal(
            conciseManualImageCaption(semicolonCaption, 45),
            '论文关键实验比较图'
        );

        const multiSentence = 'Fig. 3: The first complete sentence explains the method. The second sentence adds implementation detail that is not required in the concise alt.';
        assert.equal(
            conciseManualImageCaption(multiSentence, 80),
            'The first complete sentence explains the method.'
        );

        assert.equal(
            conciseManualImageCaption('Overview of WnW architecture where fixed heads discard the unsele', 45),
            '论文方法与系统结构总览图'
        );
        assert.equal(
            conciseManualImageCaption('Different settings for decoding where the model is trained on all subjects simultaneously', 45),
            '论文实验设置与数据关系示意图'
        );
        assert.equal(
            conciseManualImageCaption('The correlation is corr=0.66corr=0.66, p<0.001p<0.001.'),
            'The correlation is corr=0.66, p<0.001.'
        );
    });

    it('accepts explicit force takeover but rejects unknown or duplicate flags', () => {
        assert.deepEqual(
            parseArgs(['--date', '2026-08-20', '--spec', 'manual.json', '--force']),
            { force: true, v6Shadow: false, date: '2026-08-20', spec: 'manual.json' }
        );
        assert.deepEqual(
            parseArgs(['--v6-shadow', '--date', '2026-08-20', '--spec', 'manual.json']),
            { force: false, v6Shadow: true, date: '2026-08-20', spec: 'manual.json' }
        );
        assert.throws(
            () => parseArgs(['--date', '2026-08-20', '--spec', 'manual.json', '--unknown']),
            /未知参数/
        );
        assert.throws(
            () => parseArgs(['--date', '2026-08-20', '--spec', 'manual.json', '--force', '--force']),
            /参数重复/
        );
        assert.doesNotThrow(() => assertExplicitManualV6Mode({ version: 5 }, false));
        assert.doesNotThrow(() => assertExplicitManualV6Mode({ version: 6 }, true));
        assert.throws(() => assertExplicitManualV6Mode({ version: 6 }, false), /显式运行/);
        assert.throws(() => assertExplicitManualV6Mode({ version: 5 }, true), /显式运行/);
    });

    it('历史 v3 spec 保留自身 prompt SHA，v4 必须绑定当前 prompt', () => {
        const current = buildStagePromptBindings();
        const historicalStageSha = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map((stage, index) => [
            stage, String(index + 1).padStart(64, '0')
        ]));
        const historical = {
            version: 3,
            promptSha256: historicalStageSha.primaryAnalysis,
            manualAuthoringPromptPath: 'prompts/manual-analysis-record.md',
            manualAuthoringPromptSha256: 'f'.repeat(64),
            stagePromptSha256: historicalStageSha
        };
        const replay = resolveManualSpecPromptBindings(historical, current);
        assert.equal(replay.primaryAnalysis.sha256, historical.promptSha256);
        assert.equal(replay.scoringAudit.sha256, historicalStageSha.scoringAudit);
        assert.equal(replay.scoringAudit.source, current.scoringAudit.source);

        assert.throws(
            () => resolveManualSpecPromptBindings({ ...historical, version: 4 }, current),
            /与当前 deep-analysis prompt 不一致/
        );
        const currentV5 = {
            ...historical,
            version: 5,
            promptSha256: current.primaryAnalysis.sha256,
            manualAuthoringPromptSha256: directSha(fs.readFileSync(
                path.join(__dirname, '..', 'prompts', 'manual-analysis-record.md')
            )),
            stagePromptSha256: Object.fromEntries(
                Object.entries(current).map(([stage, binding]) => [stage, binding.sha256])
            )
        };
        assert.equal(
            resolveManualSpecPromptBindings(currentV5, current).scoringAudit.sha256,
            current.scoringAudit.sha256
        );
        const incomplete = { ...historical, stagePromptSha256: { ...historicalStageSha } };
        delete incomplete.stagePromptSha256.imageSupplement;
        assert.throws(
            () => resolveManualSpecPromptBindings(incomplete, current),
            /必须精确覆盖全部阶段/
        );
    });

    it('接受全文事实账本、二次审计和逐阶段证据', () => {
        const fixture = baseSpec();
        assert.equal(findManualBoilerplate(fixture.analysis).length, 0);
        assert.equal(validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, {
            analysis: fixture.analysis,
            sourceText: fixture.sourceText
        }), null);
        fixture.manifest.manualTakeover.completedAt = '2026-08-22T00:00:00.000+08:00';
        assert.match(validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, {
            analysis: fixture.analysis,
            sourceText: fixture.sourceText
        }), /逐阶段 prompt\/context 绑定/);
    });

    it('manual v4 必须绑定 evidence-rich-v2，历史记录不追溯升级', () => {
        const historical = baseSpec();
        assert.equal(validateManualTakeoverManifest(historical.manifest, historical.sourceSha256, {
            analysis: historical.analysis,
            sourceText: historical.sourceText
        }), null);

        const v4 = baseSpec();
        v4.manifest.contracts.manualDepth = MANUAL_DEPTH_CONTRACT_VERSION_V4;
        assert.match(validateManualTakeoverManifest(v4.manifest, v4.sourceSha256, {
            analysis: v4.analysis,
            sourceText: v4.sourceText
        }), /manual v4 必须绑定 experimentTables=evidence-rich-v2/);
    });

    function contextBoundPlan(imageNumber, anchor, label) {
        const context = anchor.text.slice(0, 48);
        return {
            imageNumber,
            section: anchor.section,
            paragraphId: anchor.id,
            conclusionParagraphId: anchor.id,
            lead: `承接“${context}”，下图用于观察${label}对应的信号流与比较位置。`,
            explanation: `图中箭头用于追踪${label}；该图仅覆盖“${context}”所述条件，不能外推到未报告设置。`
        };
    }

    function assertManualV4CanonicalImageOrder(configuredImageUrls, plans, expectedUrls) {
        const imageInfos = configuredImageUrls.map((url, index) => ({
            url,
            caption: `Figure ${index + 1} for ordering regression`,
            mime: 'image/png',
            sha256: String(index + 1).repeat(64),
            bytes: 1000 + index
        }));
        const insertion = applyImageInsertionPlan(detailedAnalysis(), plans, imageInfos, 4);
        assert.deepStrictEqual(insertion.selectedImageUrls, expectedUrls);
        const canonical = normalizeManualV4ImageArtifacts({
            configuredImageUrls,
            preparedImages: imageInfos,
            insertionPlan: plans,
            insertionDiagnostics: insertion.insertionDiagnostics,
            orderedSelectedImageUrls: insertion.selectedImageUrls
        });
        assert.deepStrictEqual(canonical.selectedImages.map(item => item.url), expectedUrls);
        assert.deepStrictEqual(canonical.insertionPlan.map(item => item.imageNumber), [1, 2]);
        assert.deepStrictEqual(canonical.insertionPlan.map(item => item.url), expectedUrls);
        assert.deepStrictEqual(canonical.insertionDiagnostics.map(item => item.imageNumber), [1, 2]);
        assert.deepStrictEqual(
            canonical.insertionPlan.map(item => item.paragraphId),
            expectedUrls.map(url => plans[configuredImageUrls.indexOf(url)].paragraphId)
        );
        const bodyOrder = [...insertion.analysis.matchAll(/!\[(?:\\.|[^\]\\])*\]\((https:\/\/[^)]+)\)/g)]
            .map(match => match[1]);
        assert.deepStrictEqual(bodyOrder, expectedUrls);
    }

    it('Manual v4 将跨章节逆序计划按最终正文图片顺序写入 canonical', () => {
        const analysis = detailedAnalysis();
        const anchors = buildImageAnchorCatalog(analysis);
        const methodAnchor = anchors.find(item => item.section === '方法概述和架构');
        const resultAnchor = anchors.find(item => item.section === '实验结果');
        const resultUrl = 'https://arxiv.org/html/2608.20001/result.png';
        const methodUrl = 'https://arxiv.org/html/2608.20001/method.png';
        assertManualV4CanonicalImageOrder(
            [resultUrl, methodUrl],
            [
                contextBoundPlan(1, resultAnchor, '带噪 WER 对照'),
                contextBoundPlan(2, methodAnchor, '上下文编码器')
            ],
            [methodUrl, resultUrl]
        );
    });

    it('Manual v4 将同节逆序计划按段落先后写入 canonical', () => {
        const methodAnchors = buildImageAnchorCatalog(detailedAnalysis())
            .filter(item => item.section === '方法概述和架构');
        const laterUrl = 'https://arxiv.org/html/2608.20002/later.png';
        const earlierUrl = 'https://arxiv.org/html/2608.20002/earlier.png';
        assertManualV4CanonicalImageOrder(
            [laterUrl, earlierUrl],
            [
                contextBoundPlan(1, methodAnchors[1], '训练阶段'),
                contextBoundPlan(2, methodAnchors[0], '输入编码阶段')
            ],
            [earlierUrl, laterUrl]
        );
    });

    it('显式空选图不会下载或回填任何候选', async () => {
        const { prepareManualImages } = require('../scripts/manual-deep-analysis.js');
        const prepared = await prepareManualImages({
            imageInfos: [{
                url: 'https://arxiv.org/html/2608.20000/figure1.png',
                caption: 'Architecture overview'
            }],
            selectedImageUrls: []
        });
        assert.deepStrictEqual(prepared, {
            preparedImages: [],
            imageDownloadOutcomes: [{
                url: 'https://arxiv.org/html/2608.20000/figure1.png',
                status: 'manual_rejected',
                reason: 'not_selected_by_manual_figure_review'
            }]
        });
    });

    it('拒绝通用提示词残留，即使结构和评分都完整', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace('推理流程先完成', '从复现角度，方法章节需要记录。推理流程先完成');
        fixture.manifest.manualTakeover.analysisSha256 = manualTextSha256(fixture.analysis);
        assert.match(
            validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, { analysis: fixture.analysis, sourceText: fixture.sourceText }),
            /提示词残留/
        );
    });

    it('拒绝证据块编号和审计过程泄漏到博客正文', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace('论文研究带噪语音识别中的上下文声学建模', '第 1 个证据块：论文明确写到，论文研究带噪语音识别中的上下文声学建模');
        fixture.manifest.manualTakeover.analysisSha256 = manualTextSha256(fixture.analysis);
        assert.match(
            validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, { analysis: fixture.analysis, sourceText: fixture.sourceText }),
            /提示词残留|正文包含流程\/审计元话语/
        );
    });

    it('拒绝“论文明确写到”式证据引导语', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace('论文研究带噪语音识别中的上下文声学建模', '论文明确写到，论文研究带噪语音识别中的上下文声学建模');
        fixture.manifest.manualTakeover.analysisSha256 = manualTextSha256(fixture.analysis);
        assert.match(
            validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, { analysis: fixture.analysis, sourceText: fixture.sourceText }),
            /提示词残留|正文包含流程\/审计元话语/
        );
    });

    it('拒绝只有一次审查或缺阶段声明的人工结果', () => {
        const fixture = baseSpec();
        fixture.manifest.manualTakeover.audit.attempts = 1;
        assert.match(validateManualTakeoverManifest(fixture.manifest, fixture.sourceSha256, {
            analysis: fixture.analysis,
            sourceText: fixture.sourceText
        }), /至少为 2/);
        const second = baseSpec();
        delete second.manifest.manualTakeover.stageEvidence.scoringAudit;
        assert.match(validateManualTakeoverManifest(second.manifest, second.sourceSha256, {
            analysis: second.analysis,
            sourceText: second.sourceText
        }), /stageEvidence\.scoringAudit/);
    });

    it('manual ingestion 绑定全文路径、来源 SHA 和当前 prompt', () => {
        const fixture = baseSpec();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-analysis-'));
        const sourcePath = path.join(dir, 'paper.txt');
        fs.writeFileSync(sourcePath, fixture.sourceText.repeat(20));
        const repeatSourceSha = directSha(fs.readFileSync(sourcePath));
        const repeatLedger = fixture.manifest.manualTakeover.evidenceLedger.map(item => ({
            ...item,
            sourceQuote: item.sourceQuote
        }));
        const spec = {
            analysis: fixture.analysis,
            fullTextPath: sourcePath,
            sourceSha256: repeatSourceSha,
            evidenceLedger: repeatLedger,
            manualAudit: fixture.manifest.manualTakeover.audit,
            reviewedClaimsByStage: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
                stage, fixture.manifest.manualTakeover.stageEvidence[stage].reviewedClaims
            ])),
            reason: fixture.manifest.manualTakeover.reason,
            agent: 'Codex'
        };
        spec.manualAuthoringPromptSha256 = directSha(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'manual-analysis-record.md')));
        spec.manualAudit = {
            ...spec.manualAudit,
            attempts: 3,
            passes: [
                spec.manualAudit.passes[0],
                { status: 'revise', issues: ['二审复核阶段专属证据'] },
                spec.manualAudit.passes[1]
            ]
        };
        spec.imageInfos = [{ url: 'https://arxiv.org/html/2608.20000/figure1.png', caption: 'Architecture overview' }];
        spec.selectedImageUrls = ['https://arxiv.org/html/2608.20000/figure1.png'];
        const methodAnchors = buildImageAnchorCatalog(spec.analysis)
            .filter(item => item.section === '方法概述和架构');
        spec.imageInsertions = [{
            url: spec.selectedImageUrls[0],
            section: '方法概述和架构',
            paragraphId: methodAnchors[0].id,
            conclusionParagraphId: methodAnchors[1].id,
            lead: '承接音频波形转换为声学特征的输入链，下图用于核对编码器与上下文融合模块的连接位置。',
            explanation: '图中箭头从声学特征编码器进入上下文融合模块；该结构只回扣训练阶段使用公开数据的流程，不能说明未披露超参数。'
        }];
        const paper = { arxivId: '2608.20000', title: 'Fixture paper', authors: [], categories: [] };
        // The fixture source is intentionally repeated so the bounded full-text gate passes;
        // source quotes remain exact substrings after normalization.
        const promptBindings = buildStagePromptBindings();
        const preparedImages = [{
            url: spec.imageInfos[0].url,
            caption: spec.imageInfos[0].caption,
            cachePath: path.join(dir, 'secure-image.bin'),
            mime: 'image/png',
            sha256: 'b'.repeat(64),
            bytes: 1234,
            cacheHit: true
        }];
        const record = buildManualRecord(
            paper,
            spec,
            '2026-08-20',
            promptBindings,
            {
                preparedImages,
                imageDownloadOutcomes: [{ url: spec.imageInfos[0].url, status: 'complete' }],
                manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3
            }
        );
        assert.equal(record.analysisSource, 'provided_full_text');
        assert.equal(shouldReuseCanonical(record, record, false), true);
        assert.equal(shouldReuseCanonical(record, record, true), false);
        assert.equal(record.analysisManifest.manualTakeover.version, 2);
        assert.equal(record.digestStatus.latestAttemptStatus, 'analyzed');
        assert.equal(record.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.attempts, 3);
        assert.equal(record.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.protocol, 'manual-offline-review-v1');
        assert.equal(record.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.executionKind, 'manual_attestation');
        assert.equal(record.analysisManifest.stages.primaryAnalysis.executionKind, 'manual_attestation');
        assert.notEqual(
            record.analysisManifest.stages.primaryAnalysis.promptSha256,
            record.analysisManifest.stages.scoringAudit.promptSha256
        );
        assert.equal(
            record.analysisManifest.manualTakeover.stageEvidence.imageDownload.contextSha256,
            record.imageManifest.downloadEvidenceSha256
        );
        assert.equal(
            record.analysisManifest.manualTakeover.stageEvidence.imageSupplement.contextSha256,
            record.imageManifest.selectionEvidenceSha256
        );
        assert.equal(record.imageManifest.selected[0].mime, 'image/png');
        assert.equal(record.imageManifest.selected[0].sha256, 'b'.repeat(64));
        assert.equal(record.imageManifest.selected[0].bytes, 1234);
        assert.match(record.analysis, /下图概括论文的系统结构或处理流程/);
        assert.equal(record.analysisManifest.contracts.imageNarrative, undefined);
        assert.doesNotMatch(record.analysis, /原始图注为/);

        const noSelectionSpec = { ...spec, selectedImageUrls: [], imageInsertions: [] };
        const noSelectionRecord = buildManualRecord(
            paper,
            noSelectionSpec,
            '2026-08-20',
            promptBindings,
            {
                preparedImages,
                imageDownloadOutcomes: [{ url: spec.imageInfos[0].url, status: 'complete' }],
                manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3
            }
        );
        assert.deepStrictEqual(noSelectionRecord.selectedImageUrls, []);
        assert.deepStrictEqual(noSelectionRecord.imageManifest.selected, []);

        const validateRecord = candidate => validateManualTakeoverManifest(
            candidate.analysisManifest,
            candidate.sourceSha256,
            {
                analysis: candidate.analysis,
                sourceText: fs.readFileSync(sourcePath, 'utf8'),
                imageManifest: candidate.imageManifest
            }
        );
        assert.equal(validateRecord(record), null);
        assert.equal(isSuccessfulAnalysisRecord(record), true);
        const tamperCases = [
            ['inputSha256', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.inputSha256 = 'c'.repeat(64);
            }, /inputSha256 闭环校验失败/],
            ['auditSha256', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.auditSha256 = 'c'.repeat(64);
            }, /auditSha256 闭环校验失败/],
            ['outputSha256', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.outputSha256 = 'c'.repeat(64);
            }, /outputSha256 与最终正文 SHA 不一致/],
            ['promptSource', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.promptSource = 'prompts/wrong.md';
            }, /promptSource 与阶段 manifest 不一致/],
            ['promptSha256', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.promptSha256 = 'c'.repeat(64);
            }, /promptSha256 与阶段 manifest 不一致/],
            ['protocol', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.protocol = 'manual-unknown';
            }, /protocol 与阶段协议不一致/],
            ['contextSha256', candidate => {
                candidate.analysisManifest.manualTakeover.stageEvidence.imageDownload.contextSha256 = 'c'.repeat(64);
            }, /contextSha256 与 imageManifest\.downloadEvidenceSha256 不一致/]
        ];
        for (const [label, mutate, expected] of tamperCases) {
            const candidate = JSON.parse(JSON.stringify(record));
            mutate(candidate);
            assert.match(validateRecord(candidate), expected, label);
        }
        const damagedImageManifest = JSON.parse(JSON.stringify(record));
        damagedImageManifest.imageManifest.downloadOutcomes.push({ url: 'https://example.com/tampered.png', status: 'complete' });
        assert.match(validateRecord(damagedImageManifest), /imageManifest\.downloadEvidenceSha256 闭环校验失败/);
        assert.equal(isSuccessfulAnalysisRecord(damagedImageManifest), false);

        const changedImageRecord = buildManualRecord(
            paper,
            spec,
            '2026-08-20',
            promptBindings,
            {
                preparedImages: [{ ...preparedImages[0], sha256: 'd'.repeat(64), bytes: 2345 }],
                imageDownloadOutcomes: [{ url: spec.imageInfos[0].url, status: 'complete' }],
                manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3
            }
        );
        assert.notEqual(
            manualCanonicalReuseFingerprint(record),
            manualCanonicalReuseFingerprint(changedImageRecord)
        );
        assert.equal(shouldReuseCanonical(record, changedImageRecord), false);

        spec.selectedImageUrls = ['https://example.com/unverified.png'];
        spec.imageSelectionMode = 'manual_explicit';
        assert.throws(
            () => buildManualRecord(paper, spec, '2026-08-20', promptBindings, {
                preparedImages,
                manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3
            }),
            /未通过安全下载校验/
        );
    });

    it('默认只复用 analysis、全文、证据、审计和逐阶段 prompt 均未过期的 canonical', () => {
        const canonical = buildReusableRecord().record;
        assert.equal(shouldReuseCanonical(canonical, canonical), true);

        const staleAnalysis = buildReusableRecord({
            mutateSpec: spec => {
                spec.analysis = spec.analysis.replace(
                    '论文研究带噪语音识别中的上下文声学建模',
                    '论文聚焦带噪语音识别中的上下文声学建模'
                );
            }
        }).record;
        const staleSource = buildReusableRecord({
            sourceSuffix: '\nThe revised source adds a deployment-cost discussion absent from the prior full text.'
        }).record;
        const staleEvidence = buildReusableRecord({
            mutateSpec: spec => {
                spec.evidenceLedger[0].claim += '该声明已由本轮人工审计重新表述。';
            }
        }).record;
        const staleAudit = buildReusableRecord({
            mutateSpec: spec => {
                spec.manualAudit.passes[1].issues = ['二审重新核对了方法输入、输出和训练边界'];
            }
        }).record;
        const stalePrompt = buildReusableRecord({
            mutatePrompts: bindings => {
                bindings.scoringAudit.sha256 = 'c'.repeat(64);
            }
        }).record;

        for (const [label, candidate] of [
            ['analysis', staleAnalysis],
            ['full-text source', staleSource],
            ['evidence ledger', staleEvidence],
            ['manual audit', staleAudit],
            ['stage prompt', stalePrompt]
        ]) {
            assert.notEqual(
                manualCanonicalReuseFingerprint(canonical),
                manualCanonicalReuseFingerprint(candidate),
                `${label} 必须进入复用指纹`
            );
            assert.equal(shouldReuseCanonical(canonical, candidate), false, `${label} 变化必须重建`);
        }
    });

    it('成功 canonical 只有同指纹默认复用，差异必须显式 --force 才能写入', () => {
        const canonical = buildReusableRecord().record;
        const changed = buildReusableRecord({ sourceSuffix: '\nchanged source evidence' }).record;
        assert.equal(manualCanonicalWriteDecision(canonical, canonical, false), 'reuse');
        assert.throws(
            () => manualCanonicalWriteDecision(canonical, changed, false),
            /拒绝无 --force 覆盖/
        );
        assert.equal(manualCanonicalWriteDecision(canonical, changed, true), 'write');
        assert.equal(manualCanonicalWriteDecision(null, changed, false), 'write');
    });

    it('resultClaims 只改逐字段 binding 也必须失效 canonical 复用指纹', () => {
        const canonical = promoteReusableRecordToV4(buildReusableRecord().record);
        const changed = JSON.parse(JSON.stringify(canonical));
        changed.analysisManifest.manualTakeover.resultClaims[0].sourceBindings.method = '完整方法与同预算基线';
        changed.analysisManifest.manualTakeover.resultClaimsSha256 = manualSha256({
            claims: changed.analysisManifest.manualTakeover.resultClaims,
            exception: null
        });
        assert.notEqual(
            manualCanonicalReuseFingerprint(canonical),
            manualCanonicalReuseFingerprint(changed)
        );
    });

    it('resultClaimsException 或 readabilityRubric 变化必须失效 canonical 复用指纹', () => {
        const canonical = promoteReusableRecordToV4(buildReusableRecord().record);
        const changedException = JSON.parse(JSON.stringify(canonical));
        changedException.analysisManifest.manualTakeover.resultClaimsException = {
            type: 'qualitative',
            reason: '仅用于确认例外字段确实进入复用指纹。',
            sourceQuote: 'fixture exception evidence'
        };
        changedException.analysisManifest.manualTakeover.resultClaimsSha256 = manualSha256({
            claims: changedException.analysisManifest.manualTakeover.resultClaims,
            exception: changedException.analysisManifest.manualTakeover.resultClaimsException
        });
        const changedRubric = JSON.parse(JSON.stringify(canonical));
        changedRubric.analysisManifest.manualTakeover.readabilityRubric
            .dimensions.paragraphLogic.reason += '本轮重新审核。';
        changedRubric.analysisManifest.manualTakeover.readabilityRubricSha256 = manualSha256(
            changedRubric.analysisManifest.manualTakeover.readabilityRubric
        );
        for (const candidate of [changedException, changedRubric]) {
            assert.notEqual(
                manualCanonicalReuseFingerprint(canonical),
                manualCanonicalReuseFingerprint(candidate)
            );
        }
    });

    it('v3 canonical 与 v4 expected 绝不共用复用指纹', () => {
        const historicalV3 = buildReusableRecord().record;
        const expectedV4 = promoteReusableRecordToV4(historicalV3);
        assert.notEqual(
            manualCanonicalReuseFingerprint(historicalV3),
            manualCanonicalReuseFingerprint(expectedV4)
        );
    });

    it('v6 顶层 ArtifactIndex/longform/provenance 任一变化都失效复用指纹', () => {
        const canonical = buildReusableRecord().record;
        canonical.manualArtifactIndex = { version: 1, outputSha256: 'a'.repeat(64) };
        canonical.manualReaderLongform = {
            version: 2, contract: 'reader-longform-v2', articleSha256: 'b'.repeat(64)
        };
        canonical.manualV6Provenance = { specVersion: 6, specRootSha256: 'c'.repeat(64) };
        canonical.analysisManifest.manualTakeover.v6Provenance = canonical.manualV6Provenance;
        for (const mutate of [
            value => { value.manualArtifactIndex.outputSha256 = 'd'.repeat(64); },
            value => { value.manualReaderLongform.articleSha256 = 'd'.repeat(64); },
            value => {
                value.manualV6Provenance = { ...value.manualV6Provenance, specRootSha256: 'd'.repeat(64) };
                value.analysisManifest.manualTakeover.v6Provenance = value.manualV6Provenance;
            }
        ]) {
            const changed = JSON.parse(JSON.stringify(canonical));
            mutate(changed);
            assert.notEqual(
                manualCanonicalReuseFingerprint(canonical),
                manualCanonicalReuseFingerprint(changed)
            );
        }
    });

    it('最终状态在文件锁内按最新 canonical expected IDs 重算，不接受本地旧 failures 计数', () => {
        const first = buildReusableRecord({ id: '2608.21001' }).record;
        const second = buildReusableRecord({ id: '2608.21002' }).record;
        const stalePriorBatch = buildReusableRecord({ id: '2608.19999' }).record;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-finalize-'));
        const resultPath = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultPath, JSON.stringify({
            generation: 3,
            batchDate: '2026-08-20',
            status: 'partial_failed',
            stats: {
                success: 0,
                failed: 2,
                totalAfterMerge: 0,
                expected: 0,
                successfulExpected: 0,
                remainingFailed: 2
            },
            papers: [stalePriorBatch, first, second]
        }));

        const completed = finalizeManualCanonicalState(resultPath, {
            date: '2026-08-20',
            expectedIds: ['2608.21001', '2608.21002'],
            stats: { success: 0, failed: 99, failedIds: ['stale-local-failure'] }
        });
        assert.equal(completed.status, 'complete');
        assert.equal(completed.stats.analysisStatus, 'complete');
        assert.equal(completed.stats.success, 2);
        assert.equal(completed.stats.failed, 0);
        assert.deepEqual(completed.stats.failedIds, []);
        assert.equal(completed.stats.totalAfterMerge, 2);
        assert.deepEqual(completed.papers.map(item => item.arxivId), ['2608.21001', '2608.21002']);
        assert.equal(completed.stats.expected, 2);
        assert.equal(completed.stats.successfulExpected, 2);
        assert.equal(completed.stats.remainingFailed, 0);
        assert.equal(completed.generation, 4);
        assert.ok(completed.deepAnalysisCompletedAt);

        const latestOnDisk = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        latestOnDisk.papers[1] = {
            ...latestOnDisk.papers[1],
            latestAnalysisAttemptError: '另一个进程刚写入的失败尝试',
            digestStatus: {
                ...latestOnDisk.papers[1].digestStatus,
                latestAttemptStatus: 'analysis_failed'
            },
            manualIngestionCheckpoint: { version: 1 }
        };
        fs.writeFileSync(resultPath, JSON.stringify(latestOnDisk));

        const partial = finalizeManualCanonicalState(resultPath, {
            date: '2026-08-20',
            expectedIds: ['2608.21001', '2608.21002'],
            stats: { success: 2, failed: 0 }
        });
        assert.equal(partial.status, 'partial_failed');
        assert.equal(partial.stats.analysisStatus, 'partial_failed');
        assert.equal(partial.stats.success, 1);
        assert.equal(partial.stats.failed, 1);
        assert.deepEqual(partial.stats.failedIds, ['2608.21002']);
        assert.equal(partial.stats.totalAfterMerge, 2);
        assert.equal(partial.stats.expected, 2);
        assert.equal(partial.stats.successfulExpected, 1);
        assert.equal(partial.stats.remainingFailed, 1);
        assert.equal(partial.stats.failedCheckpoints, 1);
        assert.equal(partial.deepAnalysisCompletedAt, undefined);
    });
});

describe('manual full-text-evidence-v2 quality gates', () => {
    const v2Options = sourceText => ({ sourceText, manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V2 });

    it('合规正文同时通过 v1 与 v2 契约', () => {
        const fixture = baseSpec();
        assert.equal(validateManualDepthContract(fixture.analysis, { sourceText: fixture.sourceText }), null);
        assert.equal(validateManualDepthContract(fixture.analysis, v2Options(fixture.sourceText)), null);
    });

    it('v2 拒绝跨章节自我复制', () => {
        const fixture = baseSpec();
        const duplicated = '这句话被人工复制到多个章节用于凑齐契约字数，属于典型的模板化素材复用行为。';
        fixture.analysis = fixture.analysis
            .replace(/(## 核心摘要\n)/, `$1${duplicated}\n`)
            .replace(/(## 实验结果\n)/, `$1${duplicated}\n`)
            .replace(/(## 细节详述\n)/, `$1${duplicated}\n`);
        assert.match(
            validateManualDepthContract(fixture.analysis, v2Options(fixture.sourceText)),
            /跨章节自我复制/
        );
    });

    it('v2 拒绝毒舌点评固定模板句式', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '这项工作整体尚可。亮点是一是结构清晰，二是实验完整，三是结果稳定；短板是作者自己承认的噪声鲁棒性不足。'
        );
        assert.match(
            validateManualDepthContract(fixture.analysis, v2Options(fixture.sourceText)),
            /固定模板句式/
        );
    });

    it('v2 拒绝缺少 [A_*] 证据锚点标签的评分理由', () => {
        const fixture = baseSpec();
        fixture.analysis = fixture.analysis.replace(/\[A_[A-Z_]+\]\s*/g, '');
        assert.match(
            validateManualDepthContract(fixture.analysis, v2Options(fixture.sourceText)),
            /\[A_\*\]/
        );
    });

    it('v2 要求全文含开源仓库链接时开源详情必须列出具体 URL', () => {
        const fixture = baseSpec();
        const sourceWithRepo = `${fixture.sourceText}\nCode is available at https://github.com/example/robust-asr and weights at https://huggingface.co/example/model.`;
        assert.match(
            validateManualDepthContract(fixture.analysis, v2Options(sourceWithRepo)),
            /开源详情未提取任何具体 URL/
        );
        fixture.analysis = fixture.analysis.replace(
            '未提及代码、模型或数据集开放地址。',
            '代码：https://github.com/example/robust-asr；模型权重：https://huggingface.co/example/model。'
        );
        assert.equal(validateManualDepthContract(fixture.analysis, v2Options(sourceWithRepo)), null);
    });
});

describe('manual full-text-evidence-v3 reader-visible quality gates', () => {
    const v3Options = sourceText => ({ sourceText, manualDepthContractVersion: MANUAL_DEPTH_CONTRACT_VERSION_V3 });

    it('接受具有论证推进、比较实验、复现信息和双层局限的正文', () => {
        const fixture = baseSpec();
        assert.equal(validateManualDepthContract(fixture.analysis, v3Options(fixture.sourceText)), null);
    });

    it('拒绝贡献名词列表、通用评分理由和未分层局限', () => {
        const fixture = baseSpec();
        const shallowInnovation = fixture.analysis.replace(
            /## 核心创新点\n[\s\S]*?(?=\n## 实验结果)/,
            '## 核心创新点\n\n1. 新编码器。\n\n2. 新损失。\n\n3. 新数据集。\n'
        );
        assert.match(validateManualDepthContract(shallowInnovation, v3Options(fixture.sourceText)), /核心创新点过短|创新点必须|创新论证/);

        const genericScoring = fixture.analysis.replace(
            /\[A_METHOD\] 可训练上下文融合改变了/,
            '[A_METHOD] 创新维度认可可训练上下文融合改变了'
        );
        assert.match(validateManualDepthContract(genericScoring, v3Options(fixture.sourceText)), /某维度认可/);

        const flatLimits = fixture.analysis.replace('论文证据直接支持的边界', '局限汇总');
        assert.match(validateManualDepthContract(flatLimits, v3Options(fixture.sourceText)), /局限必须分开标注/);
    });
});

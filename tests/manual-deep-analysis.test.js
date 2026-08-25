const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { validAnalysisText } = require('./valid-analysis-fixture.js');
const {
    REQUIRED_RECOVERY_STAGES,
    manualSha256,
    manualTextSha256,
    validateManualTakeoverManifest,
    validateManualDepthContract,
    MANUAL_DEPTH_CONTRACT_VERSION_V2,
    findManualBoilerplate
} = require('../scripts/analysis-contract.js');
const {
    buildManualRecord,
    buildStagePromptBindings,
    finalizeManualCanonicalState,
    manualCanonicalReuseFingerprint,
    parseArgs,
    shouldReuseCanonical
} = require('../scripts/manual-deep-analysis.js');

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
    const innovation = Array.from({ length: 7 }, (_, index) => `${index + 1}. 第${index + 1}项贡献对应可核对的模型结构、训练条件或评价设置；它明确说明了输入、模块、输出及其与基线的差异，并保留了实验条件和适用边界。`).join('\n\n');
    const results = `实验在多个带噪语音基准上比较主方法与基线，并报告识别错误、噪声鲁棒性和消融变化。实验同时交代训练集、验证集、测试集、噪声类型、说话人划分和评价指标方向，结果需要结合这些条件解读。结果段还应说明每个基线采用的训练数据、相同的预处理和相同的解码设置，避免把数据规模差异误认为模型收益。测试结果还需要区分平均值、单次最好值和不同噪声条件下的变化，不能只引用一个最有利的数字。统计口径、重复次数和误差范围也会影响读者对结果稳定性的判断。\n\n| 实验 | 结果与条件 |\n|---|---|\n| 主方法 | 多个公开基准、带噪条件、识别输出 |\n| 消融 | 移除上下文模块后误差上升 |\n\n结果同时记录数据划分、基线和评价口径，不能把单一条件的改善外推到所有说话人或设备。论文没有报告的统计显著性、跨域测试和失败案例不在此处补写。`;
    const details = Array.from({ length: 8 }, (_, index) => `- 细节${index + 1}：输入音频、声学特征、上下文编码、监督目标、验证集和解码设置之间的关系均需按正文保持一致；第${index + 1}项缺失信息不会由常见实现补写。`).join('\n\n');
    const scoringMaxima = ['2', '1.5', '1.5', '1', '1.5', '1.5', '0.5', '1.5'];
    const scoringValues = ['1.5', '1.2', '1.1', '0.8', '1.0', '0.0', '0.3', '1.0'];
    const scoringTags = ['A_METHOD', 'A_METHOD', 'A_RESULTS', 'A_CLARITY', 'A_IMPACT', 'A_OPEN', 'A_REPRO', 'A_ENGINEERING'];
    const scoring = Array.from({ length: 8 }, (_, index) => `* ${['创新性','技术严谨性','实验充分性','清晰度','影响力','开源','可复现性','工程/实践价值'][index]} (${scoringValues[index]}/${scoringMaxima[index]})：[${scoringTags[index]}] 该维度依据正文中可定位的方法、数据、基线、评价或资源信息单独判断，未报告部分明确保留边界。`).join('\n');
    const limits = '论文没有完整披露部分训练超参数、硬件和随机种子；跨说话人、跨设备和长期部署仍缺少验证。带噪基准与公开数据可以支持方法比较，但不能代替真实场景的失败案例、统计显著性和成本测量。对于长尾噪声、数据分布变化和部署资源约束，现有实验也没有给出足够的稳定性证据。不同设备、不同说话人和不同噪声强度下的误差可能改变结论，因此需要更广泛的验证。模型在真实环境中的延迟、内存、功耗和维护成本也没有被充分量化，长期运行风险仍待评估。';
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
    if (options.mutateSpec) options.mutateSpec(spec);
    const promptBindings = buildStagePromptBindings();
    if (options.mutatePrompts) options.mutatePrompts(promptBindings);
    const paper = {
        arxivId: options.id || '2608.21000',
        title: 'Reusable fixture paper',
        authors: [],
        categories: []
    };
    const record = buildManualRecord(paper, spec, '2026-08-20', promptBindings);
    return { dir, sourcePath, sourceText, spec, promptBindings, paper, record };
}

describe('manual_complete v2 deep-analysis contract', () => {
    it('accepts explicit force takeover but rejects unknown or duplicate flags', () => {
        assert.deepEqual(
            parseArgs(['--date', '2026-08-20', '--spec', 'manual.json', '--force']),
            { force: true, date: '2026-08-20', spec: 'manual.json' }
        );
        assert.throws(
            () => parseArgs(['--date', '2026-08-20', '--spec', 'manual.json', '--unknown']),
            /未知参数/
        );
        assert.throws(
            () => parseArgs(['--date', '2026-08-20', '--spec', 'manual.json', '--force', '--force']),
            /参数重复/
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
            { preparedImages, imageDownloadOutcomes: [{ url: spec.imageInfos[0].url, status: 'complete' }] }
        );
        assert.equal(record.analysisSource, 'provided_full_text');
        assert.equal(shouldReuseCanonical(record, record, false), true);
        assert.equal(shouldReuseCanonical(record, record, true), false);
        assert.equal(record.analysisManifest.manualTakeover.version, 2);
        assert.equal(record.digestStatus.latestAttemptStatus, 'analyzed');
        assert.equal(record.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.attempts, 3);
        assert.equal(record.analysisManifest.manualTakeover.stageEvidence.primaryAnalysis.protocol, 'manual-offline-review-v1');
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

        const changedImageRecord = buildManualRecord(
            paper,
            spec,
            '2026-08-20',
            promptBindings,
            {
                preparedImages: [{ ...preparedImages[0], sha256: 'd'.repeat(64), bytes: 2345 }],
                imageDownloadOutcomes: [{ url: spec.imageInfos[0].url, status: 'complete' }]
            }
        );
        assert.notEqual(
            manualCanonicalReuseFingerprint(record),
            manualCanonicalReuseFingerprint(changedImageRecord)
        );
        assert.equal(shouldReuseCanonical(record, changedImageRecord), false);

        spec.selectedImageUrls = ['https://example.com/unverified.png'];
        assert.throws(
            () => buildManualRecord(paper, spec, '2026-08-20', promptBindings, { preparedImages }),
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

    it('最终状态在文件锁内按最新 canonical expected IDs 重算，不接受本地旧 failures 计数', () => {
        const first = buildReusableRecord({ id: '2608.21001' }).record;
        const second = buildReusableRecord({ id: '2608.21002' }).record;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-finalize-'));
        const resultPath = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultPath, JSON.stringify({
            generation: 3,
            batchDate: '2026-08-20',
            status: 'partial_failed',
            stats: { success: 0, failed: 2 },
            papers: [first, second]
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

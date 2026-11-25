'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { installTmpOnlyWriteGuard } = require('./helpers/isolated-tmp-write-guard.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deep-analyzer-modularization-')));
installTmpOnlyWriteGuard(GUARD_ROOT);

process.on('exit', () => {
    try {
        fs.rmSync(GUARD_ROOT, { recursive: true, force: true });
    } catch (_) {
        // ignore cleanup errors at exit
    }
});

const deepAnalyzer = require('../scripts/deep-analyzer.js');
const scoringContract = require('../scripts/lib/scoring-audit-contract.js');
const publicProbe = require('../scripts/lib/public-resource-probe.js');
const policyModule = require('../scripts/lib/public-network-policy.js');
const scoringFormat = require('../scripts/lib/scoring-record-format.js');
const readerIdentityFormat = require('../scripts/lib/reader-identity-format.js');
const readerResourceClaims = require('../scripts/lib/reader-resource-claims.js');
const arxivHtmlStructuredArtifacts = require('../scripts/lib/arxiv-html-structured-artifacts.js');
const readerSourceEvidenceBinding = require('../scripts/lib/reader-source-evidence-binding.js');
const readerProseNormalization = require('../scripts/lib/reader-prose-normalization.js');
const manifestNew = require('../scripts/manifest-new.js');
const readerRepair = require('../scripts/lib/reader-repair.js');
const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files.js');

function buildValidRawScoringAudit(overrides = {}) {
    const header = {
        contract: 'scoring-evidence-profile',
        schemaFingerprint: 'cd86b88de878f041f2dab1c8153fdac9e98272cc1ff3ba90161a79f1349e6d9f'
    };
    const base = {
        documentType: '方法研究',
        confidence: '高',
        evidenceProfile: {
            ...header,
            multiComponentClaimed: true,
            ablationStatus: 'direct',
            targetEvaluation: 'public',
            sampleScaleReported: true,
            deploymentMeasured: true,
            publicGeneralizationEvaluated: true,
            engineeringEvidence: 'measured_deployment',
            evidenceBoundary: '[A_METHOD] 与 [A_RESULTS] 均给出公开基准实测与消融对照。',
            evidenceIds: ['A_METHOD', 'A_RESULTS', 'A_OPEN']
        },
        dimensions: {
            innovation: { score: 1.6, reason: '[A_METHOD] 提出了带因果验证的双通道声学表示解耦机制，结构新颖。' },
            technicalRigor: { score: 1.3, reason: '[A_METHOD] 目标函数与推导假设闭合，符号与模块输入输出定义严谨。' },
            experimentalSufficiency: { score: 1.4, reason: '[A_RESULTS] 在多个公开数据集上与代表性基线及消融变体完成了系统对比。' },
            clarity: { score: 0.9, reason: '[A_METHOD] 图表组织清晰，训练和推理流程衔接交代明确，易于阅读理解。' },
            impact: { score: 1.2, reason: '[A_RESULTS] 对低延迟语音生成任务提供了可验证的建模范式参考价值。' },
            openSource: { score: 1.0, reason: '[A_OPEN] 论文给出了官方代码仓库链接并通过可达性核验，核心代码已开放。' },
            reproducibility: { score: 0.4, reason: '[A_METHOD] 给出了主要超参数、优化器配置与训练数据规模说明。' },
            engineering: { score: 1.3, reason: '[A_RESULTS] 实测了端到端推理延迟与显存吞吐权衡，具备明确落地参考价值。' }
        }
    };
    return {
        ...base,
        ...overrides,
        evidenceProfile: overrides.evidenceProfile === null
            ? undefined
            : { ...base.evidenceProfile, ...(overrides.evidenceProfile || {}) },
        dimensions: {
            ...base.dimensions,
            ...(overrides.dimensions || {})
        }
    };
}

test('deep-analyzer.js 与解耦子模块的导出符号、引用一致性及依赖闭包 100% 等价', () => {
    const scoringSharedExports = [
        'getTypeAwareEvidenceGuide',
        'parseScoringAuditResult',
        'revalidateScoringAudit',
        'applyScoringAuditResult',
        'applyScoringEvidenceCaps',
        'validateScoringAuditAgainstAnalysis',
        'hasAffirmativeReleasePromise',
        'hasAffirmativeDemoEvidence',
        'reasonUsesForbiddenDeduction',
        'findForbiddenDeductionClauses',
        'prepareScoringAuditAnalysis'
    ];
    for (const symbol of scoringSharedExports) {
        assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer 缺少导出函数 ${symbol}`);
        assert.equal(deepAnalyzer[symbol], scoringContract[symbol], `导出符号 ${symbol} 必须与 scoring-audit-contract 完全同一引用`);
    }

    const probeSharedFunctions = [
        'fetchPublicImageResponse',
        'requestPinnedPublicHttps',
        'checkDemoPageForOpensource',
        'isTransientDemoHttpStatus',
        'isGloballyRoutableIpAddress',
        'isPrivateIpAddress',
        'validatePublicHttpUrl',
        'extractDemoUrls',
        'resolveDemoPageCandidates',
        'resolveMetadataResourceLinks',
        'isMetadataResourceDiscoveryLink',
        'extractSectionByTitle',
        'mergeSectionByTitle',
        'appendSectionByTitle',
        'syncResourceFieldsFromOpenSource',
        'inferResourceState',
        'updateOpensourceFromDemoLinks',
        'extractApiReaderResourceCandidates',
        'extractWeakConferenceSourceResourceCandidates',
        'verifyApiReaderResourceUrl',
        'inspectGitHubRepositoryDocumentation',
        'validRepositoryDocumentationEvidence',
        'buildApiReaderResourceIdentity',
        'applyApiReaderResourceAvailability'
    ];
    for (const symbol of probeSharedFunctions) {
        assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer 缺少导出函数 ${symbol}`);
        assert.equal(deepAnalyzer[symbol], publicProbe[symbol], `导出符号 ${symbol} 必须与 public-resource-probe 完全同一引用`);
    }
    assert.equal(
        deepAnalyzer.API_READER_RESOURCE_IDENTITY_CONTRACT,
        publicProbe.API_READER_RESOURCE_IDENTITY_CONTRACT
    );
    assert.equal(
        deepAnalyzer.REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
        publicProbe.REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT
    );

    const closure = collectWorkflowImplementationFiles({
        root: REPO_ROOT,
        entryFiles: ['scripts/deep-analyzer.js']
    });
    for (const requiredFile of [
        'scripts/lib/scoring-audit-contract.js',
        'scripts/lib/public-resource-probe.js',
        'scripts/lib/reader-repair-evidence-slice.js',
        'scripts/lib/public-network-policy.js',
        'config/public-network-policy.json'
    ]) {
        assert(closure.includes(requiredFile), `实现指纹传递闭包缺少 ${requiredFile}`);
    }
});

test('8 维评分审计契约：证据硬上限裁剪、置信度与内测总分闸门、防跨维度双重扣分等价', () => {
    const allowedIds = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN', 'A_SUMMARY']);

    // 正例：比较对象中的“优于闭源基线”与明确“不据此扣分”不触发跨维度扣分误报
    const validRaw = buildValidRawScoringAudit({
        dimensions: {
            ...buildValidRawScoringAudit().dimensions,
            experimentalSufficiency: {
                score: 1.5,
                reason: '[A_RESULTS] 在相同评测协议下优于主流闭源基线；代码未公开不能作为本项扣分依据。'
            },
            engineering: {
                score: 1.4,
                reason: '[A_RESULTS] 叙述了工程应用潜力但尚无实测部署数据。'
            }
        },
        evidenceProfile: {
            ...buildValidRawScoringAudit().evidenceProfile,
            multiComponentClaimed: true,
            ablationStatus: 'none',
            deploymentMeasured: false,
            engineeringEvidence: 'claim_only'
        }
    });
    const parsed = deepAnalyzer.parseScoringAuditResult(JSON.stringify(validRaw), allowedIds);
    const capped = deepAnalyzer.applyScoringEvidenceCaps(parsed);
    assert.equal(capped.dimensions.experimentalSufficiency.score, 1.2);
    assert.equal(capped.dimensions.engineering.score, 1.0);
    assert.deepEqual(
        capped.capsApplied.map(item => item.rule),
        [
            'multi_component_without_direct_ablation',
            'engineering_claim_without_measured_or_reusable_evidence'
        ]
    );

    // 反例 1：在技术严谨性/清晰度等非开源维度以不开源或缺少超参数扣分必须拒绝
    const doubleDeductOpenSource = buildValidRawScoringAudit({
        dimensions: {
            ...buildValidRawScoringAudit().dimensions,
            technicalRigor: {
                score: 1.0,
                reason: '[A_METHOD] 推导完整，但作者代码未公开导致难以直接运行验证。'
            }
        }
    });
    assert.throws(
        () => deepAnalyzer.parseScoringAuditResult(JSON.stringify(doubleDeductOpenSource), allowedIds),
        /使用了属于其他维度的扣分事实/
    );

    const doubleDeductReproInOpen = buildValidRawScoringAudit({
        dimensions: {
            ...buildValidRawScoringAudit().dimensions,
            openSource: {
                score: 1.0,
                reason: '[A_OPEN] 代码仓库已公开，但论文未披露超参数配置细节。'
            }
        }
    });
    assert.throws(
        () => deepAnalyzer.parseScoringAuditResult(JSON.stringify(doubleDeductReproInOpen), allowedIds),
        /使用了属于其他维度的扣分事实/
    );

    // 反例 2：引用账本外证据 ID 必须拒绝
    const badEvidenceId = buildValidRawScoringAudit({
        dimensions: {
            ...buildValidRawScoringAudit().dimensions,
            clarity: {
                score: 0.8,
                reason: '[HALLUCINATED_ID_99] 论文结构清晰但引用了不存在的证据锚点。'
            }
        }
    });
    assert.throws(
        () => deepAnalyzer.parseScoringAuditResult(JSON.stringify(badEvidenceId), allowedIds),
        /引用了账本外 ID: HALLUCINATED_ID_99/
    );

    // 反例 3：置信度非“高”但总分超过 9.0 必须拒绝
    const mediumHighScore = buildValidRawScoringAudit({
        confidence: '中',
        dimensions: {
            innovation: { score: 1.9, reason: '[A_METHOD] 提出了完整的端到端多阶段音频生成新范式。' },
            technicalRigor: { score: 1.4, reason: '[A_METHOD] 理论推导与边界条件给出了完整证明。' },
            experimentalSufficiency: { score: 1.4, reason: '[A_RESULTS] 跨多个公开测试集与消融实验均显著领先。' },
            clarity: { score: 0.9, reason: '[A_METHOD] 符号体系、结构图与算法伪代码一一对应。' },
            impact: { score: 1.4, reason: '[A_RESULTS] 为语音合成和编辑统一建模提供了高价值底座。' },
            openSource: { score: 1.5, reason: '[A_OPEN] 代码、权重与训练微调文档均已完整开放。' },
            reproducibility: { score: 0.5, reason: '[A_METHOD] 训练配置、随机种子与硬件环境完整公开。' },
            engineering: { score: 1.4, reason: '[A_RESULTS] 实测了流式部署延迟与吞吐表现，工程成熟度高。' }
        }
    });
    const parsedMedium = deepAnalyzer.parseScoringAuditResult(JSON.stringify(mediumHighScore), allowedIds);
    assert.throws(
        () => deepAnalyzer.applyScoringEvidenceCaps(parsedMedium),
        /评分置信度不是“高”时总分不得超过 9\.0/
    );
});

test('评分开源状态归一化与旧评分理由脱敏清洗保持一致', () => {
    const sampleAnalysis = [
        '## 评分',
        '8.5/10',
        '',
        '## 机器摘要',
        'document_type: 方法研究',
        'rank_bucket: 前25%',
        'confidence: 高',
        'innovation: 1.6',
        'technical_rigor: 1.3',
        'experimental_sufficiency: 1.4',
        'clarity: 0.9',
        'impact: 1.2',
        'open_source: 1.0',
        'reproducibility: 0.4',
        'engineering_score: 1.3',
        'has_code: 否',
        'has_model: 否',
        'has_dataset: 否',
        '',
        '## 评分理由',
        '旧理由包含历史偏差，不能直接继承。',
        '',
        '## 开源详情',
        '- 代码：未提及',
        '- Demo：在线演示已上线 https://demo.example.org/audio'
    ].join('\n');

    const prepared = deepAnalyzer.prepareScoringAuditAnalysis(sampleAnalysis);
    assert.match(prepared, /旧评分理由已由代码移除，禁止复用/);

    const allowedIds = new Set(['A_METHOD', 'A_RESULTS', 'A_OPEN']);
    const rawAudit = deepAnalyzer.parseScoringAuditResult(
        JSON.stringify(buildValidRawScoringAudit()),
        allowedIds
    );
    const sourceText = 'We evaluate our audio codec on LibriTTS.';
    const emptyResourceBody = {
        ...readerIdentityFormat.header('resources'),
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        resources: []
    };
    const emptyResourceIdentity = {
        ...emptyResourceBody,
        identitySha256: publicProbe.stableFingerprint(emptyResourceBody)
    };
    const normalized = deepAnalyzer.validateScoringAuditAgainstAnalysis(
        sampleAnalysis,
        rawAudit,
        emptyResourceIdentity,
        sourceText
    );
    assert.equal(normalized.dimensions.openSource.score, 0.2);
    assert.match(normalized.dimensions.openSource.reason, /按演示证据计分/);

    const applied = deepAnalyzer.applyScoringAuditResult(sampleAnalysis, normalized);
    assert.match(applied, /open_source: 0\.2/);
    assert.match(applied, /\*\s+开源 \(0\.2\/1\.5\)：\[A_OPEN\]/);
});

test('公网资源探测与 PUBLIC_NETWORK_POLICY_* Fail-Closed 异常透传在子模块与主入口完全一致', async () => {
    assert.equal(publicProbe.isPrivateIpAddress('127.0.0.1'), true);
    assert.equal(publicProbe.isPrivateIpAddress('198.18.0.5'), true);
    assert.equal(publicProbe.isGloballyRoutableIpAddress('8.8.8.8'), true);

    const policyFault = new policyModule.PublicNetworkPolicyError(
        '模拟公网策略配置损坏',
        'PUBLIC_NETWORK_POLICY_SCHEMA'
    );

    await assert.rejects(
        () => publicProbe.verifyApiReaderResourceUrl('https://github.com/example/repo', {
            validateUrlImpl: async () => { throw policyFault; }
        }),
        err => err === policyFault
    );

    await assert.rejects(
        () => publicProbe.checkDemoPageForOpensource('https://demo.example.org/audio', {
            detectProxyImpl: () => 'http://127.0.0.1:7897',
            validateUrlImpl: async () => { throw policyFault; }
        }),
        err => err === policyFault
    );

    const demoDeps = [];
    const found = await publicProbe.checkDemoPageForOpensource('https://demo.example.org/audio', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => 'http://127.0.0.1:7897',
        requestImpl: async (_url, _opts, deps) => {
            demoDeps.push(deps);
            return {
                status: 200,
                headers: { get: name => (name === 'content-type' ? 'text/html; charset=utf-8' : null) },
                arrayBuffer: async () => Buffer.from(
                    '<a href="https://github.com/audio-lab/codec">Code</a>'
                    + '<a href="https://huggingface.co/audio-lab/codec-ckpt">Weights</a>',
                    'utf8'
                )
            };
        }
    });
    assert.deepEqual(found, [
        'https://github.com/audio-lab/codec',
        'https://huggingface.co/audio-lab/codec-ckpt'
    ]);
    assert.equal(demoDeps.length, 1);
    assert.equal(typeof demoDeps[0].validateUrlImpl, 'function');
    assert.equal(typeof demoDeps[0].detectProxyImpl, 'function');
});

test('buildApiReaderResourceIdentity 命中 GitHub metadataRepository 时透传网络依赖完成全链路探测，且受两处 assertMayAccessNetwork 守卫阻断', async t => {
    const repoUrl = 'https://github.com/audio-lab/dualstream';
    const readmeUrl = 'https://raw.githubusercontent.com/audio-lab/dualstream/main/README.md';
    const readmeBody = [
        '# DualStreamAudio',
        '## Installation',
        'Run `pip install -e .` to install.',
        '## Quick Start',
        'Run `python inference.py --input sample.wav`.',
        '## Fine-Tuning',
        'Run `python train.py --config configs/base.yaml`.'
    ].join('\n');
    const sourceText = `Our official implementation and checkpoints are publicly available at ${repoUrl}.`;
    const sampleAnalysis = [
        '## 核心摘要',
        'DualStreamAudio 提出双流语音编解码器。',
        '',
        '## 机器摘要',
        'has_code: 是',
        'has_model: 否',
        'has_dataset: 否',
        '',
        '## 开源详情',
        `- 代码：${repoUrl}`
    ].join('\n');
    const paper = {
        arxivId: '2611.99009',
        sources: ['arxiv', 'huggingface'],
        hf_github_repo: repoUrl
    };

    const observedCalls = [];
    const customValidateUrl = async raw => {
        const parsed = new URL(raw);
        parsed.validatedHostname = parsed.hostname;
        parsed.validatedAddress = '8.8.8.8';
        return parsed;
    };
    const customDetectProxy = () => 'http://127.0.0.1:7897';
    const customRequestImpl = async (url, opts, deps) => {
        observedCalls.push({ url, opts, deps });
        if (url === repoUrl) {
            return {
                status: 200,
                ok: true,
                headers: { get: () => null },
                arrayBuffer: async () => Buffer.alloc(0)
            };
        }
        if (url === readmeUrl) {
            return {
                status: 200,
                ok: true,
                headers: { get: name => (name === 'content-type' ? 'text/markdown; charset=utf-8' : null) },
                arrayBuffer: async () => Buffer.from(readmeBody, 'utf8')
            };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    const identity = await publicProbe.buildApiReaderResourceIdentity(
        sampleAnalysis,
        sourceText,
        {},
        {
            paper,
            requestImpl: customRequestImpl,
            validateUrlImpl: customValidateUrl,
            detectProxyImpl: customDetectProxy
        }
    );

    assert.equal(observedCalls.length, 2);
    assert.equal(observedCalls[0].url, repoUrl);
    assert.equal(observedCalls[1].url, readmeUrl);
    assert.equal(observedCalls[1].deps.validateUrlImpl, customValidateUrl);
    assert.equal(observedCalls[1].deps.detectProxyImpl, customDetectProxy);
    assert.equal(identity.resources.length, 1);
    assert.equal(identity.resources[0].availability, 'available');
    assert.equal(identity.resources[0].documentationEvidence?.completeness, 'complete');

    // proxyEnabled === false 时透传给 README 探测的 detectProxyImpl 必须返回 null
    const disabledProxyCalls = [];
    await publicProbe.inspectGitHubRepositoryDocumentation(repoUrl, {
        proxyEnabled: false,
        validateUrlImpl: customValidateUrl,
        detectProxyImpl: customDetectProxy,
        requestImpl: async (_url, _opts, deps) => {
            disabledProxyCalls.push(deps);
            return {
                status: 200,
                headers: { get: () => 'text/plain' },
                arrayBuffer: async () => Buffer.from(readmeBody, 'utf8')
            };
        }
    });
    assert.equal(disabledProxyCalls.length, 1);
    assert.equal(disabledProxyCalls[0].detectProxyImpl(), null);

    // 验证两处 assertMayAccessNetwork 守卫在进入任何网络请求前严格阻断
    const operatorCorrection = require('../scripts/lib/conference-reader-operator-correction.js');
    const sourceCorrection = require('../scripts/lib/conference-source-resource-correction.js');
    let networkTouched = 0;
    const forbiddenRequest = async () => {
        networkTouched += 1;
        throw new Error('不应触发任何请求');
    };

    const opMock = t.mock.method(operatorCorrection, 'assertMayAccessNetwork', () => {
        throw new Error('人工修正禁止网络请求');
    });
    await assert.rejects(
        () => publicProbe.inspectGitHubRepositoryDocumentation(repoUrl, { requestImpl: forbiddenRequest }),
        /人工修正禁止网络请求/
    );
    opMock.mock.restore();

    const srcMock = t.mock.method(sourceCorrection, 'assertMayAccessNetwork', () => {
        throw new Error('来源纠正禁止任何网络请求');
    });
    await assert.rejects(
        () => publicProbe.inspectGitHubRepositoryDocumentation(repoUrl, { requestImpl: forbiddenRequest }),
        /来源纠正禁止任何网络请求/
    );
    srcMock.mock.restore();

    assert.equal(networkTouched, 0);
});

test('Wave 14.6B-JS: J1–J4 四个 Strangler-Fig 子模块导出符号引用一致性 (===)、依赖闭包与无循环依赖', () => {
    const resourceClaimExports = [
        'replayVerifiedReaderResourceIdentity',
        'readerResourcePublicationResources',
        'readerResourceClaimIssues',
        'enforceReaderResourceClaims',
        'conferenceReaderResourceClaimIssues',
        'enforceConferenceReaderResourceClaims',
        'readerResourceClaimDraftFromArticle'
    ];
    for (const symbol of resourceClaimExports) {
        assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer 缺少 J1 导出函数 ${symbol}`);
        assert.equal(deepAnalyzer[symbol], readerResourceClaims[symbol], `J1 导出符号 ${symbol} 必须与 reader-resource-claims 完全同一引用`);
    }
    assert.equal(typeof readerResourceClaims.buildApiReaderResourceEvidence, 'function');
    assert.equal(deepAnalyzer.conferenceReaderResourceClaimIssues, deepAnalyzer.readerResourceClaimIssues);
    assert.equal(deepAnalyzer.enforceConferenceReaderResourceClaims, deepAnalyzer.enforceReaderResourceClaims);

    const arxivHtmlExports = [
        'isSupportedImageUrl',
        'getArxivHtmlIds',
        'assessArxivHtmlFullText',
        'stripLatexPhantoms',
        'joinHierarchicalHeaderLayers',
        'wrapMultilineLatexAligned',
        'arxivCaptionText',
        'parseArxivStructuredArtifactsFromHtml',
        'buildUnstructuredTextArtifactSignals',
        'buildPdfStructuredArtifactsFromBytes',
        'bindStructuredArtifactsToText',
        'extractArxivHtmlText',
        'parseArxivImageInfosFromHtml'
    ];
    for (const symbol of arxivHtmlExports) {
        assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer 缺少 J2 导出函数 ${symbol}`);
        assert.equal(deepAnalyzer[symbol], arxivHtmlStructuredArtifacts[symbol], `J2 导出符号 ${symbol} 必须与 arxiv-html-structured-artifacts 完全同一引用`);
    }
    assert.equal(
        deepAnalyzer.ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION,
        arxivHtmlStructuredArtifacts.ARXIV_STRUCTURED_ARTIFACT_PARSER_VERSION
    );

    const sourceBindingExports = [
        'restoreReaderSelectedTableBytes',
        'normalizeReaderSourceCell',
        'readerNumericTokens',
        'readerScientificQuoteProjection',
        'readerSourceQuoteCoversNumericToken',
        'readerTableHeaderUnitEvidenceFailures',
        'deriveExactTableSourceQuotes',
        'normalizeReaderSourceQuoteWhitespace',
        'readerSourceQuotesCoverNumericToken',
        'readerFormulaNeedsSourcePayload',
        'readerStructuredSourcePayload',
        'readerSourcePayloadArtifacts',
        'readerFormulaSourcePayloadValid',
        'readerLegacyDatasetClaimsValid',
        'bindApiReaderSourceEvidence',
        'normalizeApiReaderTablePasteArtifacts',
        'validateApiReaderTablePasteDuplication',
        'normalizeConferenceMixedTableBindings',
        'normalizeReaderSourceQuoteTableMarkers',
        'normalizeReaderSourceQuotes',
        'readerPlaceholderResultTableIssues',
        'assertReaderResultTableSemantics'
    ];
    for (const symbol of sourceBindingExports) {
        assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer 缺少 J3 导出函数 ${symbol}`);
        assert.equal(deepAnalyzer[symbol], readerSourceEvidenceBinding[symbol], `J3 导出符号 ${symbol} 必须与 reader-source-evidence-binding 完全同一引用`);
    }

    const proseNormalizationExports = [
        'isAllowedReaderNarrativeNumeralIssue',
        'normalizeReaderConceptBridgeTerms',
        'coalesceExcessCohesiveReaderSections',
        'normalizeDuplicateReaderConceptBridgeMarkers',
        'normalizeShiftedReaderConceptBridgeMarkers',
        'inlineExcessCohesiveReaderConceptBridges',
        'repairReportedTextSpacing',
        'normalizeIssueBoundReaderNumericTypography',
        'normalizeReaderProsePreservingSelectedTables',
        'omitReaderSelectedTablesForProseCheck',
        'normalizeReaderWorkflowLeakageSurface',
        'normalizeReaderFigureMetricUnits',
        'isAllowedReaderDefensiveNegationIssue',
        'buildApiReaderQualityMetrics',
        'normalizeReaderBridgeTerm',
        'collapseRepeatedReaderBridgeHeadings',
        'findReaderBridgeParagraph',
        'demoteReaderBodySectionHeadings',
        'restoreReaderSectionHeadings',
        'makeReaderHeadingSpecific',
        'ensureApiReaderTableNarratives',
        'relocateExplicitReaderTableExplanations',
        'splitReaderLongParagraphs',
        'normalizeReaderProseFormatting',
        'separateApiReaderTableBlocks',
        'validateApiReaderTableNarratives',
        'rebindApiReaderFigurePlacementQuotes',
        'validateApiReaderTableExtrema',
        'validateReaderEditorialQuality',
        'normalizeReaderStructuralLineBreaks',
        'normalizeDeclaredReaderMarkerParagraphs',
        'mergeShortReaderFigureLead',
        'removeOrphanReaderTableMarkers',
        'removeDuplicateReaderLongSentences'
    ];
    for (const symbol of proseNormalizationExports) {
        assert.equal(typeof deepAnalyzer[symbol], 'function', `deep-analyzer 缺少 J4 导出函数 ${symbol}`);
        assert.equal(deepAnalyzer[symbol], readerProseNormalization[symbol], `J4 导出符号 ${symbol} 必须与 reader-prose-normalization 完全同一引用`);
    }

    const extractedFiles = [
        'scripts/lib/reader-resource-claims.js',
        'scripts/lib/arxiv-html-structured-artifacts.js',
        'scripts/lib/reader-source-evidence-binding.js',
        'scripts/lib/reader-prose-normalization.js'
    ];
    const closure = collectWorkflowImplementationFiles({
        root: REPO_ROOT,
        entryFiles: ['scripts/deep-analyzer.js']
    });
    const directRequires = rel => {
        const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        return [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    };
    for (const file of extractedFiles) {
        assert(closure.includes(file), `deep-analyzer 实现指纹传递闭包缺少 ${file}`);
        const reqs = directRequires(file);
        assert.equal(
            reqs.some(target => target.includes('deep-analyzer')),
            false,
            `${file} 不得直接反向 require scripts/deep-analyzer.js`
        );
    }
    // 验证纯库直接依赖 DAG 方向：J2/J3/J4 相互独立，J1 仅依赖 J4 + 叶子模块
    const siblingNames = extractedFiles.map(file => path.basename(file, '.js'));
    for (const leaf of [
        'scripts/lib/arxiv-html-structured-artifacts.js',
        'scripts/lib/reader-source-evidence-binding.js',
        'scripts/lib/reader-prose-normalization.js'
    ]) {
        const selfName = path.basename(leaf, '.js');
        const reqs = directRequires(leaf);
        for (const other of siblingNames) {
            if (other === selfName) continue;
            assert.equal(
                reqs.some(target => target.includes(other)),
                false,
                `${leaf} 应为纯叶模块，不得直接依赖 ${other}`
            );
        }
    }
    const j1Reqs = directRequires('scripts/lib/reader-resource-claims.js');
    assert.equal(j1Reqs.some(target => target.includes('arxiv-html-structured-artifacts')), false);
    assert.equal(j1Reqs.some(target => target.includes('reader-source-evidence-binding')), false);

    // 验证 Node 运行时 module.children 依赖图：四个子模块的真实加载闭包绝不反向包含 deep-analyzer.js
    const deepResolved = require.resolve('../scripts/deep-analyzer.js');
    for (const file of extractedFiles) {
        const entryResolved = require.resolve(path.join(REPO_ROOT, file));
        const visited = new Set();
        const queue = [require.cache[entryResolved]];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || visited.has(current.filename)) continue;
            visited.add(current.filename);
            for (const child of current.children || []) {
                queue.push(child);
            }
        }
        assert.equal(visited.has(deepResolved), false, `${file} 的运行时模块加载图不得反向包含 deep-analyzer.js`);
    }
});

test('Wave 14.6B-JS: deep-analyzer.js 与 manifest-new.js 共用单源 parserImplementationSha256 并按工作流隔离适配器且包含 J1–J4 四模块', t => {
    const scriptsDir = path.join(REPO_ROOT, 'scripts');
    const deepSource = fs.readFileSync(path.join(scriptsDir, 'deep-analyzer.js'), 'utf8');
    assert.match(deepSource, /require\('\.\/lib\/reader-implementation-fingerprint'\)\.currentReaderParserImplementationSha256\(/);
    const fingerprintMod = require('../scripts/lib/reader-implementation-fingerprint');

    const evaluateDailyParserSha = (mutateRelative = null) => {
        const observed = [];
        const sha = fingerprintMod.currentReaderParserImplementationSha256({
            workflow: 'daily',
            scriptsDir,
            fsImpl: {
                readFileSync: (filename, encoding) => {
                    const rel = path.relative(scriptsDir, filename).replace(/\\/g, '/');
                    observed.push(rel);
                    const raw = fs.readFileSync(filename, encoding);
                    return mutateRelative && rel === mutateRelative ? `${raw}\n// synthetic mutation\n` : raw;
                }
            }
        });
        return { sha, observed };
    };

    const baseline = evaluateDailyParserSha(null);
    const manifestSha = manifestNew.currentReaderParserImplementationSha256();
    assert.equal(baseline.sha, manifestSha, 'deep-analyzer.js 与 manifest-new.js 的 daily parserImplementationSha256 必须逐字节一致');
    assert.equal(baseline.observed.includes('lib/conference-reader-operator-correction.js'), false, 'daily 指纹不应被 conference 适配器污染');
    assert.equal(baseline.observed.includes('lib/historical-direct-rewrite-runner.js'), false, 'daily 指纹不应被 historical 适配器污染');

    const expectedNewFiles = [
        'lib/reader-resource-claims.js',
        'lib/arxiv-html-structured-artifacts.js',
        'lib/reader-source-evidence-binding.js',
        'lib/reader-prose-normalization.js'
    ];
    const indices = expectedNewFiles.map(rel => baseline.observed.indexOf(rel));
    for (let i = 0; i < expectedNewFiles.length; i++) {
        assert.ok(indices[i] >= 0, `parserImplementationSha256 缺少 ${expectedNewFiles[i]}`);
        if (i > 0) assert.ok(indices[i] > indices[i - 1], `parserImplementationSha256 中 ${expectedNewFiles[i]} 顺序错误`);
        const mutated = evaluateDailyParserSha(expectedNewFiles[i]);
        assert.notEqual(mutated.sha, baseline.sha, `改动 ${expectedNewFiles[i]} 必须改变 parserImplementationSha256`);
    }

    // 验证 buildApiReaderBaseFingerprint (经 buildRecoveryFingerprints.apiReaderArticle) 对 J1–J4 任一模块单字节改动均敏感
    // 注意：isolated-tmp-write-guard 会拦截子进程 execFileSync('git', ...)，因此仅桩化 readerRepairImplementationSha256
    // 以避免其读取历史 git blob，其余 buildApiReaderBaseFingerprint 与四处 promptTemplateSha256('scripts/lib/...') 全部走真实实现。
    const repairShaMock = t.mock.method(readerRepair, 'readerRepairImplementationSha256', () => 'a'.repeat(64));
    const currentContracts = {
        primaryAnalysis: deepAnalyzer.currentPromptTextContract('primaryAnalysis'),
        apiReaderArticle: deepAnalyzer.currentPromptTextContract('apiReaderArticle'),
        imageSupplement: deepAnalyzer.currentPromptTextContract('imageSupplement')
    };
    const dummyPaper = {
        arxivId: '2611.99001',
        title: 'Synthetic Fingerprint Paper',
        authors: [],
        categories: ['cs.SD'],
        analysisManifest: { contracts: currentContracts, stages: {} }
    };
    const dummySourceText = 'Synthetic source text for base fingerprint check.';
    const baselineBaseFp = deepAnalyzer.buildRecoveryFingerprints(
        dummyPaper, dummySourceText, dummyPaper.arxivId, dummyPaper.analysisManifest
    ).apiReaderArticle;
    assert.match(baselineBaseFp, /^[0-9a-f]{64}$/);
    const origReadFileSync = fs.readFileSync;
    try {
        for (const rel of expectedNewFiles) {
            const targetAbs = path.join(scriptsDir, rel);
            let targetHit = false;
            const mockRead = t.mock.method(fs, 'readFileSync', (filename, ...rest) => {
                const raw = origReadFileSync(filename, ...rest);
                if (path.resolve(String(filename)) === targetAbs) {
                    targetHit = true;
                    return Buffer.isBuffer(raw)
                        ? Buffer.concat([raw, Buffer.from('\n// synthetic fingerprint mutation\n')])
                        : `${raw}\n// synthetic fingerprint mutation\n`;
                }
                return raw;
            });
            try {
                const mutatedBaseFp = deepAnalyzer.buildRecoveryFingerprints(
                    dummyPaper, dummySourceText, dummyPaper.arxivId, dummyPaper.analysisManifest
                ).apiReaderArticle;
                assert.equal(targetHit, true, `buildApiReaderBaseFingerprint 未读取 ${rel}`);
                assert.notEqual(mutatedBaseFp, baselineBaseFp, `改动 ${rel} 必须改变 buildApiReaderBaseFingerprint`);
            } finally {
                mockRead.mock.restore();
            }
        }
    } finally {
        repairShaMock.mock.restore();
    }
});

test('Wave 14.6B-JS: J1–J4 四模块核心行为等价性核验（纯离线确定性）', () => {
    // J1: reader-resource-claims — 资源证据渲染、身份篡改拦截与未公开声明校验
    const sourceText = 'We evaluate our codec on LibriTTS and achieve 1.2% WER at 16 kHz. No code or weights are released.';
    const emptyBody = {
        ...readerIdentityFormat.header('resources'),
        sourceTextSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        resources: []
    };
    const validIdentity = { ...emptyBody, identitySha256: publicProbe.stableFingerprint(emptyBody) };
    const evidenceText = readerResourceClaims.buildApiReaderResourceEvidence(validIdentity);
    assert.match(evidenceText, /\[READER_VERIFIED_RESOURCES\]/);
    assert.match(evidenceText, /NONE:/);
    assert.throws(
        () => readerResourceClaims.buildApiReaderResourceEvidence({ ...validIdentity, identitySha256: '0'.repeat(64) }),
        /资源身份记录必须包含正确的协议/
    );
    const cleanDraft = {
        readerTitle: '低比特率语音编解码器分析',
        oneSentenceThesis: '本文在 LibriTTS 上达到 1.2% WER，目前未公开代码与权重。',
        sections: [{ kind: 'reproduction', heading: '复现边界', body: '本文目前未公开代码仓库与模型权重。' }]
    };
    assert.deepEqual(readerResourceClaims.readerResourceClaimIssues(cleanDraft, validIdentity, sourceText), []);
    const falseClaimDraft = {
        ...cleanDraft,
        sections: [{ kind: 'reproduction', heading: '复现边界', body: '本文代码仓库已经开源并可直接下载运行。' }]
    };
    assert.throws(
        () => readerResourceClaims.enforceReaderResourceClaims(falseClaimDraft, validIdentity, sourceText),
        err => err?.code === 'READER_RESOURCE_AVAILABILITY_CLAIM'
    );
    const extractedDraft = readerResourceClaims.readerResourceClaimDraftFromArticle(
        { readerTitle: cleanDraft.readerTitle, oneSentenceThesis: cleanDraft.oneSentenceThesis, sections: [{ kind: 'reproduction', heading: '复现边界' }] },
        '### 复现边界\n\n本文目前未公开代码仓库与模型权重。'
    );
    assert.equal(extractedDraft.sections.length, 1);
    assert.equal(extractedDraft.sections[0].body, '本文目前未公开代码仓库与模型权重。');

    // J1 非空 documentationEvidence + naturalResourceProse: true 路径（验证懒加载 validRepositoryDocumentationEvidence 与自然语言证据投影）
    const repoUrl = 'https://github.com/audio-lab/dualstream-codec';
    const docSourceUrl = 'https://raw.githubusercontent.com/audio-lab/dualstream-codec/main/README.md';
    const repoQuote = `Our official source code is publicly available at ${repoUrl}.`;
    const repoSourceText = `We propose DualStreamCodec for 16 kHz audio. ${repoQuote}`;
    const validDocEvidence = {
        contract: publicProbe.REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
        repositoryUrl: repoUrl,
        sourceUrl: docSourceUrl,
        status: 200,
        sourceSha256: crypto.createHash('sha256').update('# DualStreamCodec\nInstall & inference & fine-tuning.').digest('hex'),
        capabilities: { installation: true, inference: true, fineTuning: true },
        completeness: 'complete'
    };
    const docResource = {
        type: 'code',
        origin: 'paper_source',
        originalUrl: repoUrl,
        finalUrl: repoUrl,
        redirects: [],
        availability: 'available',
        status: 200,
        sourceQuote: repoQuote,
        sourceQuoteSha256: crypto.createHash('sha256').update(repoQuote).digest('hex'),
        documentationEvidence: validDocEvidence
    };
    const docIdentityBody = {
        ...readerIdentityFormat.header('resources'),
        sourceTextSha256: crypto.createHash('sha256').update(repoSourceText).digest('hex'),
        resources: [docResource]
    };
    const validDocIdentity = { ...docIdentityBody, identitySha256: publicProbe.stableFingerprint(docIdentityBody) };
    const replayedDocIdentity = readerResourceClaims.replayVerifiedReaderResourceIdentity(validDocIdentity, repoSourceText);
    assert.equal(replayedDocIdentity, validDocIdentity);
    const rawDocEvidenceText = readerResourceClaims.buildApiReaderResourceEvidence(validDocIdentity, false);
    assert.match(rawDocEvidenceText, /RESOURCE_1_DOCUMENTATION: completeness=complete; capabilities=installation,inference,fineTuning/);
    const naturalDocEvidenceText = readerResourceClaims.buildApiReaderResourceEvidence(validDocIdentity, true);
    assert.match(naturalDocEvidenceText, /\[READER_VERIFIED_RESOURCES\]/);
    assert.match(naturalDocEvidenceText, /RESOURCE_1_DOCUMENTATION/);
    assert.notEqual(naturalDocEvidenceText, rawDocEvidenceText);
    // 反例：篡改 documentationEvidence.sourceUrl 为非官方路径必须被懒加载校验拒绝
    const badDocResource = {
        ...docResource,
        documentationEvidence: { ...validDocEvidence, sourceUrl: 'https://evil.invalid/README.md' }
    };
    const badDocBody = { ...docIdentityBody, resources: [badDocResource] };
    const badDocIdentity = { ...badDocBody, identitySha256: publicProbe.stableFingerprint(badDocBody) };
    assert.throws(
        () => readerResourceClaims.buildApiReaderResourceEvidence(badDocIdentity, true),
        /资源证据第 1 项的可达状态、引文哈希或来源记录不符合要求/
    );
    assert.throws(
        () => readerResourceClaims.replayVerifiedReaderResourceIdentity(badDocIdentity, repoSourceText),
        err => err?.code === 'READER_RESOURCE_IDENTITY_INVALID'
    );

    // J2: arxiv-html-structured-artifacts — LaTeXML HTML 图表公式解析、文本提取与哈希绑定
    const sampleHtml = `<!doctype html><html><body><main class="ltx_page_content"><article class="ltx_document">
      <section class="ltx_section"><h2 class="ltx_title">1 Introduction</h2>
        <div class="ltx_para"><p>Our audio codec achieves 1.2% WER at 16 kHz on LibriTTS test-clean.</p></div>
      </section>
      <section class="ltx_section"><h2 class="ltx_title">2 Results</h2>
        <figure class="ltx_figure" id="S2.F1">
          <img src="x1.png" alt="Architecture diagram">
          <figcaption class="ltx_caption"><span class="ltx_tag_figure">Figure 1:</span> Encoder-decoder overview.</figcaption>
        </figure>
        <figure class="ltx_table" id="S2.T1">
          <figcaption class="ltx_caption"><span class="ltx_tag_table">Table 1:</span> LibriTTS evaluation.</figcaption>
          <table class="ltx_tabular">
            <thead><tr><th>Model</th><th>WER (%)</th></tr></thead>
            <tbody><tr><td>Proposed</td><td>1.2</td></tr></tbody>
          </table>
        </figure>
        <table class="ltx_equation ltx_eqn_table"><tbody><tr>
          <td><math display="block" alttext="L = L_{rec} + \\lambda L_{adv}"><mrow><mi>L</mi><mo>=</mo><msub><mi>L</mi><mrow><mi>r</mi><mi>e</mi><mi>c</mi></mrow></msub></mrow></math></td>
          <td><span class="ltx_tag_equation">(1)</span></td>
        </tr></tbody></table>
      </section>
    </article></main></body></html>`;
    const htmlText = arxivHtmlStructuredArtifacts.extractArxivHtmlText(sampleHtml);
    assert.match(htmlText, /1\.2% WER at 16 kHz/);
    const artifacts = arxivHtmlStructuredArtifacts.bindStructuredArtifactsToText(
        arxivHtmlStructuredArtifacts.parseArxivStructuredArtifactsFromHtml(sampleHtml, '2611.99001v1', '2611.99001'),
        htmlText
    );
    assert.equal(artifacts.health.status, 'complete');
    assert.equal(artifacts.figures.length, 1);
    assert.equal(artifacts.tables.length, 1);
    assert.deepEqual(artifacts.tables[0].matrix, [['Model', 'WER (%)'], ['Proposed', '1.2']]);
    assert.equal(artifacts.formulas.length, 1);
    assert.equal(artifacts.flattenedTextSha256, crypto.createHash('sha256').update(htmlText).digest('hex'));
    assert.equal(arxivHtmlStructuredArtifacts.stripLatexPhantoms('\\phantom{-}1.20'), '1.20');
    assert.deepEqual(arxivHtmlStructuredArtifacts.getArxivHtmlIds('2611.99001'), ['2611.99001', '2611.99001v2', '2611.99001v1']);
    assert.equal(arxivHtmlStructuredArtifacts.isSupportedImageUrl('https://arxiv.org/html/2611.99001v1/x1.png'), true);
    assert.equal(arxivHtmlStructuredArtifacts.isSupportedImageUrl('https://arxiv.org/html/2611.99001v1/x1.svg'), false);

    // J3: reader-source-evidence-binding — 数值归一化、引文绑定与占位结果表拦截
    assert.equal(readerSourceEvidenceBinding.normalizeReaderSourceCell('**1.2％**'), '1.2%');
    assert.deepEqual(readerSourceEvidenceBinding.readerNumericTokens('WER 1.2% at 16 kHz'), ['1.2%', '16khz']);
    const tableArticle = [
        '### 实验结果',
        '',
        '下表汇总核心指标：',
        '',
        '| 模型 | WER |',
        '| --- | --- |',
        '| Proposed | 1.2% |',
        '',
        '结果显示在 16 kHz 条件下词错率保持在 1.2%。'
    ].join('\n');
    const bindingSource = 'In Table 1, Proposed achieves 1.2% WER on LibriTTS at 16 kHz.';
    const bindingArtifacts = arxivHtmlStructuredArtifacts.bindStructuredArtifactsToText(
        arxivHtmlStructuredArtifacts.buildUnstructuredTextArtifactSignals(bindingSource, 'pdf_text'),
        bindingSource
    );
    const bound = readerSourceEvidenceBinding.bindApiReaderSourceEvidence(
        tableArticle,
        [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [bindingSource] }],
        [],
        { sourceText: bindingSource, structuredArtifacts: bindingArtifacts }
    );
    assert.equal(bound.tableBindings.length, 1);
    assert.match(bound.sourceBindingsSha256, /^[0-9a-f]{64}$/);
    // 反例：丢失原文百分号单位（1.2 vs 1.2%）必须被严格拦截
    assert.throws(
        () => readerSourceEvidenceBinding.bindApiReaderSourceEvidence(
            tableArticle.replace('| Proposed | 1.2% |', '| Proposed | 1.2 |'),
            [{ tableIndex: 1, sourceType: 'source_quotes', sourceTableOrdinal: null, cellBindings: [], sourceQuotes: [bindingSource] }],
            [],
            { sourceText: bindingSource, structuredArtifacts: bindingArtifacts }
        ),
        /缺少 exact quote\/cell 证据/
    );
    const placeholderDraft = {
        sections: [{ kind: 'result', body: '| 来源证据 | 量化值一 |\n| --- | --- |\n| 来源句一 | 1.2 |' }],
        tableBindings: [{ tableIndex: 1, sourceType: 'source_quotes', sourceQuotes: [bindingSource] }]
    };
    assert.throws(
        () => readerSourceEvidenceBinding.assertReaderResultTableSemantics(placeholderDraft),
        err => err?.code === 'reader_placeholder_result_table'
    );

    // J4: reader-prose-normalization — 中英排版、术语桥归一、表格隔离、孤儿标记清理与质量统计
    assert.equal(readerProseNormalization.normalizeReaderProseFormatting('达到1.2%的WER表现'), '达到 1.2% 的 WER 表现');
    assert.equal(
        readerProseNormalization.normalizeReaderBridgeTerm('客观评测指标'),
        readerProseNormalization.normalizeReaderBridgeTerm('客观评估指标')
    );
    const separated = readerProseNormalization.separateApiReaderTableBlocks('表前说明。\n| A | B |\n| --- | --- |\n| 1 | 2 |\n表后解释。');
    assert.match(separated, /表前说明。\n\n\| A \| B \|/);
    assert.match(separated, /\| 1 \| 2 \|\n\n表后解释。/);
    const draftWithOrphan = {
        sections: [{ kind: 'result', body: '前文。\n\n[[TABLE_1]]\n\n[[TABLE_9]]\n\n后文。' }],
        tableBindings: [{ tableIndex: 1, selection: { sourceTableOrdinal: 1, sourceRows: [0, 1], sourceColumns: [0, 1] } }]
    };
    assert.equal(readerProseNormalization.removeOrphanReaderTableMarkers(draftWithOrphan), 1);
    assert.ok(draftWithOrphan.sections[0].body.includes('[[TABLE_1]]'));
    assert.ok(!draftWithOrphan.sections[0].body.includes('[[TABLE_9]]'));
    const metrics = readerProseNormalization.buildApiReaderQualityMetrics(
        { issues: [], warnings: [] },
        '### 问题背景\n\n正文内容。'
    );
    assert.equal(metrics.rawIssueCount, 0);
    assert.equal(metrics.blockingIssueCount, 0);
});

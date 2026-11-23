'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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

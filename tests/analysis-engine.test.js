const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const {
    mergeAndSaveResults,
    analyzeBatch,
    analyzePaperWithRetry,
    getInvalidAnalysisReason,
    readJsonFileStrict,
    updateJsonFileLocked,
    initializeJsonFileLocked,
    acquireFileLockSync,
    canReclaimFileLock,
    withFileLock,
    mergeCanonicalAnalysisState,
    isSuccessfulAnalysisRecord,
    scoringStabilityIsResolved,
    apiReaderV3BindsCanonical,
    getAnalysisRunStatus,
    getCanonicalAnalysisRunSummary,
    getReadOnlyValidationAnalysisRunSummary,
    isLegacyApiAnalysisSuccessForReadOnlyValidation,
    getAnalysisExitCode
} = require('../scripts/analysis-engine.js');
const {
    getMissingRequiredSections,
    findAnalysisEditorialLeakages,
    validateAnalysisEditorialLeakageContract,
    validateExperimentTableContract,
    extractMarkdownTables,
    normalizeExperimentTableNumericFormatting,
    capExperimentTableMetricColumns,
    repairMissingMarkdownTableSeparators,
    validateMethodDetailContract,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION
} = require('../scripts/analysis-contract.js');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture.js');

function validAnalyzedResult(extra = {}) {
    return {
        analysis: validAnalysisText(),
        analysisManifest: validAnalysisPaper('fixture').analysisManifest,
        ...extra
    };
}

function bindValidApiReaderV3(paper) {
    const stable = value => Array.isArray(value) ? value.map(stable)
        : (value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
            : value);
    const stableSha256 = value => crypto.createHash('sha256')
        .update(JSON.stringify(stable(value))).digest('hex');
    const textSha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
    paper.apiReaderArticle = '### 初学者读者文章\n\n完整解释。';
    paper.apiReaderPlan = {
        version: 3,
        contract: 'beginner-researcher-v3',
        figurePlacements: [],
        tableBindings: [],
        formulaBindings: [],
        sourceBindingsContract: 'api-reader-source-bindings-v4'
    };
    paper.apiReaderPlan.sourceBindingsSha256 = stableSha256({
        tableBindings: paper.apiReaderPlan.tableBindings,
        formulaBindings: paper.apiReaderPlan.formulaBindings
    });
    paper.apiReaderFigures = [];
    const authorIdentity = {
        contract: 'api-reader-author-identity-v1',
        sourceDomSha256: '',
        sourceTextSha256: '1'.repeat(64),
        metadataSha256: stableSha256(paper.authors || []),
        authors: [{
            name: 'Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'],
            nameBinding: {
                sourceKind: 'paper_metadata', sourceValue: 'Author',
                metadataSha256: stableSha256(paper.authors || [])
            },
            affiliationBindings: [{
                sourceKind: 'explicit_unavailable',
                sourceValue: '机构信息未在 arXiv HTML 中可靠披露',
                sourceTextSha256: '1'.repeat(64)
            }]
        }]
    };
    paper.apiReaderAuthors = {
        authors: [{ name: 'Author', affiliations: ['机构信息未在 arXiv HTML 中可靠披露'] }],
        sourceDomSha256: '1'.repeat(64),
        identity: authorIdentity,
        identitySha256: stableSha256(authorIdentity)
    };
    const resourceIdentity = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: '1'.repeat(64),
        resources: []
    };
    paper.apiReaderResources = {
        ...resourceIdentity,
        identitySha256: stableSha256(resourceIdentity)
    };
    paper.apiReaderArticleSha256 = textSha256(paper.apiReaderArticle);
    paper.apiReaderPlanSha256 = stableSha256(paper.apiReaderPlan);
    paper.analysisManifest.contracts = {
        ...(paper.analysisManifest.contracts || {}),
        apiReaderArticle: 'beginner-researcher-v3',
        apiReaderSourceBindings: 'api-reader-source-bindings-v4',
        apiReaderAuthorIdentity: 'api-reader-author-identity-v1',
        apiReaderResourceIdentity: 'api-reader-resource-identity-v1'
    };
    paper.sourceSha256 = '1'.repeat(64);
    paper.analysisManifest.sourceAcquisition = {
        ...(paper.analysisManifest.sourceAcquisition || {}),
        sourceSha256: paper.sourceSha256,
        structuredArtifactsSha256: '2'.repeat(64)
    };
    paper.analysisManifest.stages.openSourceScan = {
        ...(paper.analysisManifest.stages.openSourceScan || {}),
        resourceEvidenceContract: 'api-reader-resource-identity-v1',
        resourceEvidenceSha256: paper.apiReaderResources.identitySha256
    };
    paper.analysisManifest.stages.apiReaderArticle = {
        status: 'complete',
        model: 'muse-spark-1.2-contributor',
        protocol: 'openai_responses',
        articleSha256: paper.apiReaderArticleSha256,
        planSha256: paper.apiReaderPlanSha256,
        figureCount: 0,
        figuresSha256: stableSha256(paper.apiReaderFigures),
        readerAuthorsSha256: stableSha256(paper.apiReaderAuthors),
        readerAuthorIdentityContractVersion: 'api-reader-author-identity-v1',
        readerAuthorIdentitySha256: paper.apiReaderAuthors.identitySha256,
        resourceIdentityContractVersion: 'api-reader-resource-identity-v1',
        resourceIdentitySha256: paper.apiReaderResources.identitySha256,
        resourceCount: 0,
        parserVersion: 'api-reader-parser-v3',
        assemblerVersion: 'api-reader-assembler-v3',
        tableContractVersion: 'api-reader-tables-v3',
        figureContractVersion: 'api-reader-figures-v3',
        qualityMetricsContractVersion: 'api-reader-quality-metrics-v2',
        qualityMetrics: {
            contract: 'api-reader-quality-metrics-v2',
            rawIssueCount: 0,
            waivedIssueCount: 0,
            blockingIssueCount: 0,
            warningCount: 0
        },
        sourceBindingsContractVersion: 'api-reader-source-bindings-v4',
        sourceBindingsSha256: paper.apiReaderPlan.sourceBindingsSha256,
        sourceBindingsSourceTextSha256: paper.sourceSha256,
        tableBindingCount: 0,
        formulaBindingCount: 0,
        structuredArtifactsSha256: '2'.repeat(64)
    };
    return paper;
}

function legacyValidAnalysisText() {
    return `## 评分
7.7/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前25%
innovation: 1.5
technical_rigor: 1.2
experimental_sufficiency: 1.1
clarity: 0.8
impact: 1.0
open_source: 0
reproducibility: 0.3
engineering_score: 1.0
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #Transformer #鲁棒性
主任务标签: #语音识别
主方法标签: #Transformer
补充标签: #鲁棒性

## 作者与机构
作者信息未说明。

## 毒舌点评
这项工作有明确问题设定，但亮点不算夸张。

## 核心摘要
这篇论文围绕语音识别场景提出改进方法，核心目标是提升复杂声学条件下的稳定性。方法通过编码器、上下文建模和解码模块协同工作，并用多个基准验证效果。论文还讨论了低信噪比、跨说话人和不同录音条件下的表现，说明方法主要改善鲁棒性而不是单纯扩大模型规模。

## 方法概述和架构
方法包含输入特征提取、声学编码、上下文融合和输出解码四个阶段。音频首先被转换为声学特征，再送入 Transformer 编码器建模长程依赖，随后通过任务头输出识别结果。上下文模块把局部帧级信息与更长时间跨度的语义提示结合，用于减少噪声片段对解码路径的干扰，整体结构清楚且和常见 ASR pipeline 兼容。

## 核心创新点
第一，论文把上下文建模显式加入声学编码流程。第二，实验设计覆盖了主要噪声条件。第三，方法结构相对清晰，便于后续复现。

## 实验结果
实验在多个语音识别数据集上比较 WER，结果显示该方法在低信噪比场景下优于基线。论文给出了关键指标，并报告了消融实验。消融部分比较了去掉上下文模块、只保留声学编码器和完整模型三种设置，说明主要收益来自上下文融合设计。

## 细节详述
训练细节包括数据处理、模型训练策略和推理设置。部分超参数在论文中未完整说明。

## 评分理由
创新性：1.5/2，有明确方法增量，虽然不是全新范式，但把上下文信息显式并入声学编码流程，针对噪声鲁棒性给出清楚设计。
技术严谨性：1.2/1.5，公开的方法逻辑基本合理，核心假设没有明显漏洞，但边界条件仍可讨论得更完整。
实验充分性：1.1/1.5，覆盖主要基准并提供消融实验，但跨域数据和真实远场场景还可以进一步扩展。
清晰度：0.8/1，结构描述清楚，模块关系和指标解释都比较直接，读者可以较快理解方法作用。
影响力：1.0/1.5，对语音识别读者有参考价值，尤其适合关注噪声鲁棒和上下文建模的研究者。
开源：0/1.5，未说明开源资源，因此代码、模型和数据可得性都不能确认。
可复现性：0.3/0.5，部分细节缺失，但主体 pipeline、评测任务和指标足以支撑粗粒度复现。
工程/实践价值：1.0/1.5，有一定部署参考价值，结构能接入常见 ASR 系统，但论文没有充分讨论延迟、吞吐和资源开销。

## 局限与问题
论文对极端噪声和跨域数据的讨论不足。

## 开源详情
未提及。`;
}

describe('mergeAndSaveResults', () => {
    it('不会用无 analysis 的失败结果覆盖已有成功结果', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-test-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-01-01T00:00:00.000+08:00',
            papers: [{
                arxivId: '2604.12345v1',
                title: 'Existing success',
                analysis: validAnalysisText(),
                parsed: { score: '8.0' }
            }]
        }, null, 2));

        await mergeAndSaveResults([{
            arxivId: '2604.12345v2',
            title: 'Failed retry',
            analysis: null,
            parsed: null,
            error: 'failed'
        }], file);

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.papers.length, 1);
        assert.strictEqual(saved.papers[0].title, 'Existing success');
        assert.strictEqual(saved.papers[0].analysis, validAnalysisText());
        assert.deepStrictEqual(saved.papers[0].parsed, { score: '8.0' });
    });

    it('损坏的当前 JSON 会阻断覆盖', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-corrupt-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, '{broken');

        await assert.rejects(
            mergeAndSaveResults([{ arxivId: '2604.99999', analysis: 'new' }], file),
            /JSON 文件损坏或不可读，已阻止覆盖/
        );
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    });

    it('结构非法的 current JSON 不会被当作缺失文件覆盖', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-null-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, 'null');
        assert.throws(() => updateJsonFileLocked(file, () => ({ papers: [] })), /顶层必须是对象或数组/);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'null');
    });

    it('多个进程并发锁内合并不会丢更新', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-lock-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({ papers: [] }));
        const enginePath = path.resolve(__dirname, '../scripts/analysis-engine.js');
        const worker = `
            const { updateJsonFileLocked } = require(process.argv[1]);
            const file = process.argv[2];
            const prefix = process.argv[3];
            for (let i = 0; i < 12; i++) {
                updateJsonFileLocked(file, current => ({
                    ...current,
                    papers: [...(current.papers || []), { arxivId: prefix + '.' + i }]
                }));
            }
        `;

        await Promise.all(['a', 'b', 'c', 'd'].map(prefix =>
            execFileAsync(process.execPath, ['-e', worker, enginePath, file, prefix])
        ));

        const saved = readJsonFileStrict(file);
        assert.strictEqual(saved.papers.length, 48);
        assert.strictEqual(new Set(saved.papers.map(p => p.arxivId)).size, 48);
        assert.strictEqual(saved.generation, 48);
    });

    it('进程崩溃遗留的锁可由后续写入立即回收', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-dead-lock-'));
        const file = path.join(dir, 'result.json');
        const lockDir = `${file}.lock`;
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
            pid: 2147483647,
            hostname: os.hostname()
        }));
        updateJsonFileLocked(file, () => ({ papers: [] }), { timeoutMs: 100 });
        assert.strictEqual(readJsonFileStrict(file).generation, 1);
        assert.strictEqual(fs.existsSync(lockDir), false);
    });

    it('增量写入 running 状态时同步分析状态并清除旧完成时间', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-running-state-'));
        const file = path.join(dir, 'result.json');
        fs.writeFileSync(file, JSON.stringify({
            status: 'complete',
            deepAnalysisCompletedAt: '2026-08-01T10:00:00.000+08:00',
            stats: { analysisStatus: 'complete', preserved: 1 },
            papers: []
        }));

        await mergeAndSaveResults([], file, { status: 'running' });

        const saved = readJsonFileStrict(file);
        assert.strictEqual(saved.status, 'running');
        assert.strictEqual(saved.stats.analysisStatus, 'running');
        assert.strictEqual(saved.stats.preserved, 1);
        assert.strictEqual(saved.deepAnalysisCompletedAt, undefined);
    });
});

describe('analyzePaperWithRetry', () => {
    it('深度请求明确标记 retryable=false 时整篇层不再用同预算盲目重试', async () => {
        let calls = 0;
        let retries = 0;
        const result = await analyzePaperWithRetry({ arxivId: '2609.00001' }, {
            maxRetries: 3,
            retryDelayMs: 0,
            analyzeFn: async () => {
                calls += 1;
                const error = new Error('max_output_tokens truncated');
                error.code = 'MODEL_OUTPUT_TRUNCATED';
                error.retryable = false;
                throw error;
            },
            onRetry: () => { retries += 1; }
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(calls, 1);
        assert.strictEqual(retries, 0);
        assert.match(result.error, /max_output_tokens/);
        assert.strictEqual(result.result.latestAnalysisAttemptErrorCode, 'MODEL_OUTPUT_TRUNCATED');
        assert.strictEqual(result.result.latestAnalysisAttemptRetryable, false);
    });

    it('主分析以失败结果返回非重试标记时也立即停止整篇重试', async () => {
        let calls = 0;
        const result = await analyzePaperWithRetry({ arxivId: '2609.00002' }, {
            maxRetries: 3,
            retryDelayMs: 0,
            analyzeFn: async () => {
                calls += 1;
                return {
                    analysis: null,
                    error: 'truncated primary response',
                    errorCode: 'MODEL_OUTPUT_TRUNCATED',
                    errorRetryable: false
                };
            }
        });
        assert.strictEqual(result.success, false);
        assert.strictEqual(calls, 1);
        assert.match(result.error, /truncated primary/);
        assert.strictEqual(result.result.latestAnalysisAttemptErrorCode, 'MODEL_OUTPUT_TRUNCATED');
        assert.strictEqual(result.result.latestAnalysisAttemptRetryable, false);
    });

    it('完整分析通过校验并返回 parsed', async () => {
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00001', title: 'Valid' },
            {
                maxRetries: 0,
                analyzeFn: async () => validAnalyzedResult()
            }
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.error, null);
        assert.ok(result.result.parsed.score);
        assert.strictEqual(result.result.parsed.documentType, '方法研究');
        assert.strictEqual(result.result.parsed.scoringRubricVersion, 'type-aware-v1');
        assert.strictEqual(result.result.scoringRubricVersion, 'type-aware-v1');
    });

    it('保留深度分析返回的 imageManifest', async () => {
        const imageManifest = {
            totalFound: 3,
            candidates: [{ url: 'https://example.com/architecture.png', score: 10 }],
            downloaded: [{ url: 'https://example.com/architecture.png', mime: 'image/png' }],
            selected: ['https://example.com/architecture.png']
        };
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00010', title: 'Valid with images' },
            {
                maxRetries: 0,
                analyzeFn: async () => validAnalyzedResult({
                    selectedImageUrls: imageManifest.selected,
                    allImageUrls: imageManifest.candidates.map(x => x.url),
                    imageManifest
                })
            }
        );

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.result.imageManifest, imageManifest);
    });

    it('显式保留深度分析的来源与恢复 manifest，不依赖输入对象被修改', async () => {
        const sourceSha256 = 'a'.repeat(64);
        const analysisManifest = {
            ...validAnalysisPaper('fixture').analysisManifest,
            sourceAcquisition: { analysisSource: 'abstract', sourceSha256 }
        };
        const result = await analyzePaperWithRetry({ arxivId: '2607.12345' }, {
            maxRetries: 0,
            analyzeFn: async () => validAnalyzedResult({
                analysisSource: 'abstract',
                sourceTextChars: 800,
                usedTextChars: 800,
                fullTextChars: 0,
                fullTextAvailable: false,
                truncated: false,
                sourceSha256,
                analysisConfidence: 'degraded_abstract',
                sourceWarnings: ['全文不可用'],
                analysisManifest
            })
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.analysisSource, 'abstract');
        assert.strictEqual(result.result.sourceSha256, sourceSha256);
        assert.deepStrictEqual(result.result.analysisManifest, analysisManifest);
    });

    it('缺少必要章节会重试后失败', async () => {
        let calls = 0;
        let retries = 0;
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00002', title: 'Invalid' },
            {
                maxRetries: 1,
                retryDelayMs: 0,
                analyzeFn: async () => {
                    calls++;
                    return { analysis: '## 评分\n8.0/10\n\n## 实验结果\n结果' };
                },
                onRetry: () => { retries++; }
            }
        );

        assert.strictEqual(calls, 2);
        assert.strictEqual(retries, 1);
        assert.strictEqual(result.success, false);
        assert.match(result.error, /缺少必要章节/);
    });

    it('校验会拒绝缺少核心字段的分析', () => {
        assert.strictEqual(getInvalidAnalysisReason(validAnalysisText(), require('../scripts/utils.js').parseAnalysis(validAnalysisText())), null);
        assert.match(getInvalidAnalysisReason('## 评分\n8.0/10', {}), /缺少必要章节/);
    });

    it('终态契约拒绝高置信度模型编辑和自检批注泄漏', () => {
        const leakages = [
            '这里保持原样。注意原文只有一个作者，已有分析去掉括号但可接受。',
            '注意修正拼写。',
            '这里我补充了协议不一致，并加入了严格限定。',
            '以上方法概述已超过600字。我加入了公式格式正确。',
            '这里第4点加括号说明协议差异，避免过度声明。其余保留。',
            '现在需要生成最终文本。但直接输出所有章节，可能比较长。',
            '实验结论与原文证据一致。现在需要生成最终文本。',
            '实验结论与原文证据一致。**现在需要生成最终文本。**',
            '开源资源状态已经核对。需要检查细节：原分析中仓库链接正确。',
            '注意：用户可能期望在机器摘要中不要用中文逗号分隔。',
            '**注意：** 用户可能期望在机器摘要中不要用中文逗号分隔。',
            '这里补充了 MLAAD bonafide zero-shot。注意训练数据条目中“MLAAD”可能指 MLAAD-EN，但原文中用 MLAAD。可以。',
            '- 原文标题：测试标题，已有分析没提，但无需在分析中重复。'
        ];

        for (const leakage of leakages) {
            const contaminated = validAnalysisText().replace(
                '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
                `工作的问题定义清楚，但方法增量和工程证据仍有提升空间。\n\n${leakage}`
            );
            assert.ok(findAnalysisEditorialLeakages(contaminated).length > 0, leakage);
            assert.match(validateAnalysisEditorialLeakageContract(contaminated), /编辑\/自检批注泄漏/);
            assert.match(
                getInvalidAnalysisReason(contaminated, require('../scripts/utils.js').parseAnalysis(contaminated)),
                /叙事契约无效.*编辑\/自检批注泄漏/
            );
        }

        assert.deepStrictEqual(
            findAnalysisEditorialLeakages('实验结论与原文证据一致。**现在需要生成最终文本。**'),
            ['现在需要生成最终文本']
        );
        const normalizedBoldLabel = findAnalysisEditorialLeakages(
            '**注意：** 用户可能期望在机器摘要中不要用中文逗号分隔。'
        );
        assert.deepStrictEqual(normalizedBoldLabel, [
            '注意： 用户可能期望在机器摘要中不要用中文逗号分隔。'
        ]);
        assert.doesNotMatch(normalizedBoldLabel[0], /[：:]\s*[：:]/);
    });

    it('编辑泄漏检测不误伤正常论文论述、引用和围栏示例', () => {
        const legitimate = validAnalysisText().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            `工作的问题定义清楚，但方法增量和工程证据仍有提升空间。

这里的 score 不是对单一帧质量的判断，而是衡量完整序列的一致性。需注意 one-class 严格限于封闭集合设定。作者在附录中修正了拼写错误并补充实验。已有分析方法通常依赖静态特征，本文则建模动态轨迹。

需要检查细节变化对跨域性能的影响。在 HCI 研究中，用户可能期望输出格式与辅助技术保持一致。注意：用户可能期望输出格式支持屏幕阅读器。

这里调整隐藏状态维度并补充跨模态投影层，以获得统一文本表示。这里补充输入声学特征，随后由门控网络完成融合。这里补充了对齐损失的温度消融，这一点尤其需要注意。现在需要生成最终文本表示，再由自回归解码器还原字符序列。Now I need to produce the final text representation before decoding.

> 注意：用户可能期望模型直接输出最终文本。

\`\`\`text
现在需要生成最终文本。
\`\`\``
        );

        assert.deepStrictEqual(findAnalysisEditorialLeakages(legitimate), []);
        assert.strictEqual(validateAnalysisEditorialLeakageContract(legitimate), null);
        assert.strictEqual(
            getInvalidAnalysisReason(legitimate, require('../scripts/utils.js').parseAnalysis(legitimate)),
            null
        );
    });

    it('模型批注泄漏会进入标准重试并在持续泄漏时失败', async () => {
        let calls = 0;
        const contaminated = validAnalysisText().replace(
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。',
            '工作的问题定义清楚，但方法增量和工程证据仍有提升空间。\n\n现在需要生成最终文本。'
        );
        const result = await analyzePaperWithRetry({ arxivId: '2608.13817', title: 'Leaked' }, {
            maxRetries: 1,
            retryDelayMs: 0,
            analyzeFn: async () => {
                calls += 1;
                return validAnalyzedResult({ analysis: contaminated });
            }
        });

        assert.strictEqual(calls, 2);
        assert.strictEqual(result.success, false);
        assert.match(result.error, /叙事契约无效.*编辑\/自检批注泄漏/);
    });

    it('bounded-v1 硬契约限制实验表格数量、数据行和指标列', () => {
        const table = (rows = 12, metrics = 8, label = 'A') => {
            const headers = ['方法', '数据集', ...Array.from({ length: metrics }, (_, i) => `M${i + 1}`)];
            const separator = headers.map(() => '---');
            const data = Array.from({ length: rows }, (_, i) => [
                `${label}${i + 1}`,
                i % 2 ? 'dev' : 'test',
                ...Array.from({ length: metrics }, (_value, j) => `${i + j}`)
            ]);
            return [headers, separator, ...data].map(row => `| ${row.join(' | ')} |`).join('\n');
        };
        const withTables = (...tables) => validAnalysisText().replace(
            '\n## 细节详述',
            `\n\n${tables.join('\n\n')}\n\n## 细节详述`
        );

        assert.strictEqual(validateExperimentTableContract(withTables(table(), table(2, 8, 'B'))), null);
        assert.match(validateExperimentTableContract(withTables(table(), table(), table())), /3 张/);
        assert.match(validateExperimentTableContract(withTables(table(13))), /13 个数据行/);
        assert.match(validateExperimentTableContract(withTables(table(2, 9))), /9 个指标列/);
        const capped = capExperimentTableMetricColumns(withTables(table(2, 9)));
        const cappedTable = extractMarkdownTables(capped)[0];
        assert.strictEqual(cappedTable.identifierColumns, 2);
        assert.strictEqual(cappedTable.metricColumns, 8);
        assert.strictEqual(cappedTable.header.length, 10);
        assert.strictEqual(cappedTable.separatorColumns, 10);
        assert.deepStrictEqual(cappedTable.rows.map(row => row.length), [10, 10]);
        assert.strictEqual(validateExperimentTableContract(capped), null);
        assert.match(
            validateExperimentTableContract(withTables('| 方法 | 指标 |\n| --- | --- |\n| A | 1 | 多余 |')),
            /数据行有 3 列，表头有 2 列/
        );
        assert.match(
            validateExperimentTableContract(withTables('| 方法 | 指标 |\n| --- | --- |\n| only |')),
            /数据行有 1 列，表头有 2 列/
        );
        assert.match(
            validateExperimentTableContract(withTables('| 方法 | 数据集 | 指标 |\n| --- | --- |\n| A | test | 1 |')),
            /分隔行有 2 列，表头有 3 列/
        );
        assert.strictEqual(
            validateExperimentTableContract(withTables(`\`\`\`markdown\n${table(13)}\n\`\`\``)),
            null,
            'fenced examples are not rendered Markdown tables'
        );

        const oversized = withTables(table(13));
        const parsed = require('../scripts/utils.js').parseAnalysis(oversized);
        assert.strictEqual(getInvalidAnalysisReason(oversized, parsed), null, 'legacy records stay compatible');
        assert.match(getInvalidAnalysisReason(oversized, parsed, {
            enforceExperimentTableContract: true
        }), /表格契约无效/);

        const versioned = validAnalysisPaper('2604.00999', {
            analysis: oversized
        });
        versioned.analysisManifest.contracts = {
            experimentTables: EXPERIMENT_TABLE_CONTRACT_VERSION
        };
        assert.strictEqual(isSuccessfulAnalysisRecord(versioned), false);
    });

    it('evidence-rich-v2 拒绝结论卡并要求表前问题、指标方向、数字与表后边界', () => {
        const withResults = body => validAnalysisText().replace(
            /## 实验结果\n[\s\S]*?\n\n## 细节详述/,
            `## 实验结果\n${body}\n\n## 细节详述`
        );
        const valid = withResults([
            '关键比较问题是完整方法相对强基线能降低多少识别错误，以及该收益是否伴随效率代价。表中保留主方法、最强基线和关键消融。',
            '',
            '| 方法 / 设置 | LibriSpeech WER↓ | RTF↓ |',
            '|---|---:|---:|',
            '| 强基线 | 8.4% | 0.72 |',
            '| 完整方法 | 7.1% | 0.81 |',
            '| 去掉对齐损失（消融） | 7.9% | 0.79 |',
            '',
            '完整方法相比强基线把 WER 降低 1.3 个百分点，但 RTF 上升 0.09；消融只恢复部分收益，且这些差异仅适用于该测试划分，不能外推到未测语言。'
        ].join('\n'));
        assert.strictEqual(validateExperimentTableContract(valid, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究',
            sourceText: 'Experiments\nWe compare a baseline and include an ablation without the alignment loss.'
        }), null);
        const stageIdentifier = valid.replace('方法 / 设置', '训练阶段');
        assert.strictEqual(validateExperimentTableContract(stageIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '训练阶段是可核对的设置识别列，不应误判为纯指标表');
        const modalityOrderIdentifier = valid.replace('方法 / 设置', '阶数');
        assert.strictEqual(validateExperimentTableContract(modalityOrderIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '阶数是多模态实验的设置分层，不应误判为纯指标表');
        const representationIdentifier = valid.replace('方法 / 设置', '表征');
        assert.strictEqual(validateExperimentTableContract(representationIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '表征是模型比较对象，不应误判为纯指标表');
        const evaluationIdentifier = valid.replace('方法 / 设置', '检验项');
        assert.strictEqual(validateExperimentTableContract(evaluationIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '检验项是实验身份列，不应误判为纯指标表');
        const backboneIdentifier = valid.replace('方法 / 设置', '骨干/前端');
        assert.strictEqual(validateExperimentTableContract(backboneIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '骨干/前端是系统比较对象，不应误判为纯指标表');
        const embeddingIdentifier = valid.replace('方法 / 设置', '嵌入 / 基线');
        assert.strictEqual(validateExperimentTableContract(embeddingIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '嵌入/基线是表示比较对象，不应误判为纯指标表');
        const subsetIdentifier = valid.replace('方法 / 设置', '子集 / 输入');
        assert.strictEqual(validateExperimentTableContract(subsetIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '子集/输入是评测条件，不应误判为纯指标表');
        const lossMethodIdentifier = valid.replace('方法 / 设置', '方法（损失函数）');
        assert.strictEqual(validateExperimentTableContract(lossMethodIdentifier, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null, '损失方法是身份列，其中“损失”不应触发指标方向要求');

        const neutralComparison = withResults([
            '关键比较问题是三种配置在固定测试集上的 WER 差异多大，并核验配置改变是否影响结果方向。',
            '',
            '| 配置 | WER↓ |',
            '|---|---:|',
            '| A | 12.4% |',
            '| B | 10.8% |',
            '| C | 9.7% |',
            '',
            '配置 C 的报告值为 9.7%，其余条件保持一致；同时，这组数字只适用于固定测试划分和相同解码预算，跨语言结论仍需额外验证，论文也没有报告在线吞吐、长期稳定性或跨域置信区间。'
        ].join('\n'));
        assert.match(validateExperimentTableContract(neutralComparison, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究',
            sourceText: 'The paper compared with Naive RAG.'
        }), /没有保留比较对象/, '“关键比较问题”中的“比”不能冒充真实结果比较');

        const vague = withResults([
            '关键比较问题是不同实验条件是否改善最终任务，表中保留论文列出的四项观察。',
            '',
            '| 条件 | 结果 | 含义 |',
            '|---|---|---|',
            '| A | 更好 | 有收益 |',
            '| B | 更稳 | 可部署 |',
            '| C | 退化 | 有边界 |',
            '',
            '不同条件相比默认方案方向不一，但当前证据仍只覆盖作者测试，不能外推。'
        ].join('\n'));
        assert.match(validateExperimentTableContract(vague, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), /叙述型伪指标列/);

        const missingDirection = valid.replace('LibriSpeech WER↓', 'LibriSpeech WER');
        assert.match(validateExperimentTableContract(missingDirection, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), /缺少 ↑\/↓ 方向/);

        const latexDirection = valid.replace('LibriSpeech WER↓', 'Macro-F1 $\\uparrow$');
        assert.strictEqual(validateExperimentTableContract(latexDirection, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null);

        const dirty = valid.replace('8.4%', '8.4 %').replace('7.1%', '−.71%');
        const normalized = normalizeExperimentTableNumericFormatting(dirty);
        assert.match(normalized, /8\.4%/);
        assert.match(normalized, /-0\.71%/);
        assert.strictEqual(validateExperimentTableContract(normalized, {
            contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
            documentType: '方法研究'
        }), null);
        assert.strictEqual(validateExperimentTableContract(vague, {
            contractVersion: EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION
        }), null, '旧 bounded-v1 只保留历史上限兼容，不追溯判坏');

        for (const negative of ['失效', '崩溃', '接近随机', '低于随机']) {
            const retainedNegative = valid.replace(
                '完整方法相比强基线把 WER 降低 1.3 个百分点',
                `最难子集出现${negative}；完整方法相比强基线把 WER 降低 1.3 个百分点`
            );
            assert.strictEqual(validateExperimentTableContract(retainedNegative, {
                contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                documentType: '方法研究',
                sourceText: 'The method fails on the hardest generator.'
            }), null, `“${negative}”应被识别为负面实验结果`);
        }
        for (const negative of ['轻微回退', '呈不单调性', '不保证单调改进']) {
            const retainedNegative = valid.replace(
                '完整方法相比强基线把 WER 降低 1.3 个百分点',
                `最难子集${negative}；完整方法相比强基线把 WER 降低 1.3 个百分点`
            );
            assert.strictEqual(validateExperimentTableContract(retainedNegative, {
                contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                documentType: '方法研究',
                sourceText: 'The method fails on the hardest generator.'
            }), null, `“${negative}”应被识别为负面实验结果`);
        }
        assert.match(validateExperimentTableContract(
            neutralComparison.replace(
                '配置 C 的报告值为 9.7%',
                '配置 C 的准确率从 0.90 微升至 0.91，WER 报告值为 9.7%'
            ),
            {
                contractVersion: EXPERIMENT_TABLE_CONTRACT_VERSION,
                documentType: '方法研究',
                sourceText: 'The method fails on the hardest generator.'
            }
        ), /没有保留负面证据/, '裸“微升”不能被方向盲地当作负面证据');
    });

    it('确定性补回 Muse 遗漏的 Markdown 表格分隔行', () => {
        const malformed = [
            '| 骨干/前端 | 支撑准确率 ↑ | 无支撑拒绝率 ↑ |',
            '| Qwen2-Audio 原始 | 0.930 | 0.074 |',
            '| Qwen2-Audio + Energy+Score | 0.930 | 0.961 |'
        ].join('\n');
        const repaired = repairMissingMarkdownTableSeparators(malformed);
        assert.match(repaired, /\| --- \| --- \| --- \|/);
        const tables = extractMarkdownTables(repaired);
        assert.strictEqual(tables.length, 1);
        assert.strictEqual(tables[0].dataRows, 2);
        assert.strictEqual(
            repairMissingMarkdownTableSeparators(repaired), repaired,
            '重复规范化必须保持字节稳定'
        );
    });

    it('detailed-v1 方法硬契约要求 600 中文字符、结构词和三个段落', () => {
        const short = validAnalysisText();
        assert.match(validateMethodDetailContract(short), /中文字符不足/);
        const paragraph = `输入首先经过模型模块与网络结构处理，随后沿流程进入多个阶段并产生输出。${'方法细节用于说明组件连接关系。'.repeat(12)}`;
        const detailed = short.replace(
            /## 方法概述和架构\n[\s\S]*?\n\n## 核心创新点/,
            `## 方法概述和架构\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n## 核心创新点`
        );
        assert.strictEqual(validateMethodDetailContract(detailed), null);
        const versioned = validAnalysisPaper('2604.00888', { analysis: detailed });
        versioned.analysisManifest.contracts = {
            ...versioned.analysisManifest.contracts,
            methodDetail: METHOD_DETAIL_CONTRACT_VERSION
        };
        assert.strictEqual(isSuccessfulAnalysisRecord(versioned), true);
    });

    it('结构契约会返回精确缺失章节供局部修复', () => {
        const text = validAnalysisText().replace(/## 细节详述[\s\S]*?(?=\n## 评分理由)/, '');
        assert.deepStrictEqual(getMissingRequiredSections(text), ['细节详述']);
        assert.match(getInvalidAnalysisReason(text, require('../scripts/utils.js').parseAnalysis(text)), /细节详述/);
    });

    it('校验会拒绝缺少文档类型的新分析', () => {
        const text = validAnalysisText().replace('document_type: 方法研究\n', '');
        const parsed = require('../scripts/utils.js').parseAnalysis(text);
        assert.match(getInvalidAnalysisReason(text, parsed), /document_type|文档类型/);
    });

    it('校验不会把 0 分误判为缺少评分', () => {
        let text = validAnalysisText()
            .replace('6.9/10', '0.0/10')
            .replace('rank_bucket: 前50%', 'rank_bucket: 后50%');
        for (const key of [
            'innovation', 'technical_rigor', 'experimental_sufficiency', 'clarity',
            'impact', 'open_source', 'reproducibility', 'engineering_score'
        ]) {
            text = text.replace(new RegExp(`^${key}: [^\\n]+`, 'm'), `${key}: 0.0`);
        }
        for (const label of [
            '创新性', '技术严谨性', '实验充分性', '清晰度',
            '影响力', '开源', '可复现性', '工程/实践价值'
        ]) {
            text = text.replace(new RegExp(`^${label}：[^/]+/`, 'm'), `${label}：0.0/`);
        }
        const parsed = require('../scripts/utils.js').parseAnalysis(text);
        assert.strictEqual(parsed.score, '0.0');
        assert.strictEqual(getInvalidAnalysisReason(text, parsed), null);
    });

    it('理论研究允许用明确的非实验证据说明替代实验结果', () => {
        const text = validAnalysisText()
            .replace('document_type: 方法研究', 'document_type: 理论研究')
            .replace('实验内容'.repeat(20), '理论论文未提供实验，验证依据为正文中的证明、假设与边界条件。');
        const parsed = require('../scripts/utils.js').parseAnalysis(text);
        assert.strictEqual(parsed.documentType, '理论研究');
        assert.strictEqual(getInvalidAnalysisReason(text, parsed), null);
    });

    it('成功判断会重解析正文，不信任陈旧 parsed 缓存', () => {
        assert.strictEqual(isSuccessfulAnalysisRecord({
            arxivId: '2604.00020',
            analysis: 'truncated',
            parsed: require('../scripts/utils.js').parseAnalysis(validAnalysisText())
        }), false);
        assert.strictEqual(isSuccessfulAnalysisRecord({
            arxivId: '2604.00021',
            analysis: validAnalysisText(),
            parsed: null
        }), false);
        assert.strictEqual(isSuccessfulAnalysisRecord(validAnalysisPaper('2604.00021v2', {
            parsed: null
        })), true);
    });

    it('评分审计绑定评分 checkpoint，允许受控插图阶段只改最终正文', () => {
        const scoringOutput = validAnalysisText();
        const finalAnalysis = scoringOutput.replace(
            '\n## 核心创新点',
            '\n![原论文方法图](https://arxiv.org/html/2604.00021v3/figure.png)\n\n## 核心创新点'
        );
        const paper = validAnalysisPaper('2604.00021v3', {
            analysis: finalAnalysis
        });
        const scoringOutputSha256 = crypto.createHash('sha256').update(scoringOutput).digest('hex');
        const finalAnalysisSha256 = crypto.createHash('sha256').update(finalAnalysis).digest('hex');
        paper.analysisManifest.stages.scoringAudit = {
            ...paper.analysisManifest.stages.scoringAudit,
            status: 'complete',
            scoringContract: 'api-scoring-audit-v2',
            outputAnalysisSha256: scoringOutputSha256
        };
        paper.analysisManifest.stages.imageSupplement = {
            status: 'complete',
            inputAnalysisSha256: scoringOutputSha256,
            outputAnalysisSha256: finalAnalysisSha256
        };
        bindValidApiReaderV3(paper);
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), true);

        paper.analysisManifest.stages.imageSupplement.outputAnalysisSha256 = '0'.repeat(64);
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), false);
    });

    it('自动 API production 必须绑定 Reader v3，且不误伤非 API canonical', () => {
        const automatic = validAnalysisPaper('2604.00021v4');
        automatic.analysisManifest.stages.scoringAudit = {
            ...automatic.analysisManifest.stages.scoringAudit,
            status: 'complete',
            scoringContract: 'api-scoring-audit-v2',
            outputAnalysisSha256: crypto.createHash('sha256').update(automatic.analysis).digest('hex'),
            stabilityWarning: false
        };
        assert.strictEqual(isSuccessfulAnalysisRecord(automatic), false);
        bindValidApiReaderV3(automatic);
        assert.strictEqual(apiReaderV3BindsCanonical(automatic), true);
        const deep = require('../scripts/deep-analyzer.js');
        const readerBytesBefore = JSON.stringify({
            article: automatic.apiReaderArticle,
            plan: automatic.apiReaderPlan,
            figures: automatic.apiReaderFigures,
            authors: automatic.apiReaderAuthors,
            resources: automatic.apiReaderResources,
            articleSha256: automatic.apiReaderArticleSha256,
            planSha256: automatic.apiReaderPlanSha256
        });
        const legacyFingerprint = 'a'.repeat(64);
        const currentFingerprint = 'b'.repeat(64);
        automatic.analysisManifest.stages.apiReaderArticle.fingerprint = legacyFingerprint;
        assert.strictEqual(deep.migrateSourceOnlyApiReaderFingerprint(
            automatic,
            automatic.analysisManifest,
            currentFingerprint,
            legacyFingerprint
        ), true);
        assert.strictEqual(
            automatic.analysisManifest.stages.apiReaderArticle.fingerprint,
            currentFingerprint
        );
        assert.strictEqual(JSON.stringify({
            article: automatic.apiReaderArticle,
            plan: automatic.apiReaderPlan,
            figures: automatic.apiReaderFigures,
            authors: automatic.apiReaderAuthors,
            resources: automatic.apiReaderResources,
            articleSha256: automatic.apiReaderArticleSha256,
            planSha256: automatic.apiReaderPlanSha256
        }), readerBytesBefore);
        assert.strictEqual(isSuccessfulAnalysisRecord(automatic), true);
        const sourceBindingsSha256 = automatic.apiReaderPlan.sourceBindingsSha256;
        automatic.apiReaderPlan.sourceBindingsSha256 = '0'.repeat(64);
        assert.strictEqual(isSuccessfulAnalysisRecord(automatic), false);
        automatic.apiReaderPlan.sourceBindingsSha256 = sourceBindingsSha256;
        automatic.analysisManifest.stages.apiReaderArticle.structuredArtifactsSha256 = '9'.repeat(64);
        assert.strictEqual(isSuccessfulAnalysisRecord(automatic), false);
        automatic.analysisManifest.stages.apiReaderArticle.structuredArtifactsSha256 = '2'.repeat(64);
        assert.strictEqual(isSuccessfulAnalysisRecord(automatic), true);

        const resealArticle = () => {
            const articleSha256 = crypto.createHash('sha256')
                .update(automatic.apiReaderArticle).digest('hex');
            automatic.apiReaderArticleSha256 = articleSha256;
            automatic.analysisManifest.stages.apiReaderArticle.articleSha256 = articleSha256;
        };
        automatic.apiReaderArticle += '\n\n![Figure under laboratory \\[28\\]](https://arxiv.org/html/2403.14817v1/figure.png)';
        resealArticle();
        assert.strictEqual(apiReaderV3BindsCanonical(automatic), true);
        automatic.apiReaderArticle += '\n\n\\[x=1\\]';
        resealArticle();
        assert.strictEqual(apiReaderV3BindsCanonical(automatic), false);

        const nonApi = validAnalysisPaper('2604.00021v5');
        assert.strictEqual(isSuccessfulAnalysisRecord(nonApi), true);
        const manual = validAnalysisPaper('2604.00021v6');
        manual.manualV6Provenance = { runtimeMode: 'production' };
        assert.strictEqual(isSuccessfulAnalysisRecord(manual), true);
    });

    it('评分偏移超过 0.5 时必须有二次审计共识 resolution', () => {
        const paper = bindValidApiReaderV3(validAnalysisPaper('2604.00021v7'));
        paper.analysisManifest.stages.scoringAudit = {
            ...paper.analysisManifest.stages.scoringAudit,
            status: 'complete',
            scoringContract: 'api-scoring-audit-v2',
            outputAnalysisSha256: crypto.createHash('sha256').update(paper.analysis).digest('hex'),
            stabilityWarning: true
        };
        assert.strictEqual(scoringStabilityIsResolved(paper.analysisManifest.stages.scoringAudit), false);
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), false);
        paper.analysisManifest.stages.scoringAudit.stabilityResolution = {
            contract: 'api-scoring-stability-resolution-v1',
            status: 'resolved',
            method: 'second_pass_consensus',
            firstAuditScore: 7.4,
            secondAuditScore: 7.2,
            scoreDifference: 0.2,
            secondAuditSha256: 'a'.repeat(64)
        };
        assert.strictEqual(scoringStabilityIsResolved(paper.analysisManifest.stages.scoringAudit), true);
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), true);
        paper.analysisManifest.stages.scoringAudit.stabilityResolution.scoreDifference = 0.31;
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), false);
    });

    it('恢复 manifest 未完成时不视为成功，失败尝试会保留 checkpoint', async () => {
        const manifest = {
            version: 1,
            stages: {
                imageDownload: { status: 'no_candidates' },
                primaryAnalysis: { status: 'complete' },
                openSourceScan: { status: 'transient_failure' }
            }
        };
        assert.strictEqual(isSuccessfulAnalysisRecord({
            arxivId: '2604.00022',
            analysis: validAnalysisText(),
            analysisManifest: manifest
        }), false);

        const wrongStage = validAnalysisPaper('2604.00022v2');
        wrongStage.analysisManifest.stages.primaryAnalysis.status = 'skipped';
        assert.strictEqual(isSuccessfulAnalysisRecord(wrongStage), false);
        const rejected = await analyzePaperWithRetry({ arxivId: '2604.00022v2' }, {
            maxRetries: 0,
            analyzeFn: async () => wrongStage
        });
        assert.strictEqual(rejected.success, false);
        assert.match(rejected.error, /恢复阶段未全部进入/);

        const paper = { arxivId: '2604.00023', title: 'Recoverable' };
        const attempt = await analyzePaperWithRetry(paper, {
            maxRetries: 0,
            analyzeFn: async () => ({
                analysis: null,
                parsed: null,
                analysisManifest: manifest,
                analysisCheckpoint: validAnalysisText(),
                error: 'stage timeout'
            })
        });
        assert.strictEqual(attempt.success, false);
        assert.strictEqual(attempt.result.analysisCheckpoint, validAnalysisText());
        assert.strictEqual(attempt.result.analysisManifest, manifest);
        assert.strictEqual(attempt.result.latestAnalysisAttemptError, 'stage timeout');
        assert.match(attempt.result.latestAnalysisAttemptAt, /\+08:00$/);
    });

    it('完成态必须绑定 current v3 核心摘要阶段、合同、fingerprint 与正文 SHA', () => {
        const paper = validAnalysisPaper('2604.00022');
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), true);
        for (const mutate of [
            item => { delete item.analysisManifest.stages.coreSummaryRepair; },
            item => { delete item.analysisManifest.contracts.coreSummary; },
            item => { item.analysisManifest.stages.coreSummaryRepair.fingerprint = 'old'; },
            item => { item.analysisManifest.stages.coreSummaryRepair.summarySha256 = '0'.repeat(64); },
            item => { item.analysisManifest.stages.structureRepair.outputAnalysisSha256 = '0'.repeat(64); },
            item => { item.analysisManifest.stages.coreSummaryRepair.inputStructureProjectionSha256 = '0'.repeat(64); },
            item => { item.analysisManifest.stages.coreSummaryRepair.bindingSha256 = '0'.repeat(64); },
            item => { item.analysisManifest.stages.scoringAudit.inputCoreSummarySha256 = '0'.repeat(64); },
            item => { item.analysisManifest.stages.scoringAudit.outputCoreSummarySha256 = '0'.repeat(64); }
        ]) {
            const changed = structuredClone(paper); mutate(changed);
            assert.strictEqual(isSuccessfulAnalysisRecord(changed), false);
        }
    });

    it('只读校验可识别无摘要声明的旧 API 成功，但生产完成态仍要求 current v3', () => {
        const legacy = bindValidApiReaderV3(validAnalysisPaper('2604.00022v1'));
        legacy.analysisManifest.stages.scoringAudit = {
            ...legacy.analysisManifest.stages.scoringAudit,
            scoringContract: 'api-scoring-audit-v2',
            outputAnalysisSha256: crypto.createHash('sha256').update(legacy.analysis).digest('hex'),
            stabilityWarning: false
        };
        delete legacy.analysisManifest.stages.coreSummaryRepair;
        delete legacy.analysisManifest.contracts.coreSummary;
        for (const stage of Object.values(legacy.analysisManifest.stages)) {
            stage.updatedAt = '2026-09-06T23:59:59.000+08:00';
        }
        assert.strictEqual(isSuccessfulAnalysisRecord(legacy), false);
        assert.strictEqual(isLegacyApiAnalysisSuccessForReadOnlyValidation(legacy), true);
        assert.deepStrictEqual(getCanonicalAnalysisRunSummary([legacy]), {
            success: 0, remaining: 1, status: 'failed'
        });
        assert.deepStrictEqual(getReadOnlyValidationAnalysisRunSummary([legacy]), {
            success: 1, remaining: 0, status: 'complete'
        });

        for (const mutate of [
            paper => { paper.analysisManifest.contracts.coreSummary = 'core-summary-detailed-v3'; },
            paper => { paper.analysisManifest.stages.coreSummaryRepair = { status: 'complete' }; },
            paper => { paper.analysisManifest.stages.scoringAudit.outputAnalysisSha256 = '0'.repeat(64); },
            paper => { paper.apiReaderPlan.sourceBindingsSha256 = '0'.repeat(64); },
            paper => { paper.analysisManifest.stages.primaryAnalysis.updatedAt = '2026-09-07T00:00:00.000+08:00'; },
            paper => { paper.latestAnalysisAttemptError = 'new failure'; }
        ]) {
            const changed = structuredClone(legacy); mutate(changed);
            assert.strictEqual(isLegacyApiAnalysisSuccessForReadOnlyValidation(changed), false);
        }
    });

    it('浅核心摘要即使自重签全部 SHA 仍不能成为成功记录', () => {
        const contract = require('../scripts/analysis-contract.js');
        const paper = validAnalysisPaper('2604.00022');
        paper.analysis = paper.analysis.replace(
            /## 核心摘要\n[\s\S]*?(?=\n## 方法概述和架构)/,
            '## 核心摘要\n本文解决语音问题，方法先编码再输出，结果很好但仍有局限与部署成本。\n'
        );
        const stage = paper.analysisManifest.stages.coreSummaryRepair;
        const analysisSha = crypto.createHash('sha256').update(paper.analysis).digest('hex');
        const summary = contract.extractSection(paper.analysis, '核心摘要');
        const summarySha = crypto.createHash('sha256').update(summary).digest('hex');
        const projectionSha = contract.coreSummaryProjectionSha256(paper.analysis);
        paper.analysisManifest.stages.structureRepair.outputAnalysisSha256 = analysisSha;
        Object.assign(stage, {
            inputAnalysisSha256: analysisSha,
            outputAnalysisSha256: analysisSha,
            inputSummarySha256: summarySha,
            summarySha256: summarySha,
            inputStructureProjectionSha256: projectionSha,
            outputStructureProjectionSha256: projectionSha
        });
        stage.bindingSha256 = contract.manualSha256({
            contractVersion: stage.contractVersion,
            inputAnalysisSha256: stage.inputAnalysisSha256,
            outputAnalysisSha256: stage.outputAnalysisSha256,
            inputSummarySha256: stage.inputSummarySha256,
            summarySha256: stage.summarySha256,
            inputStructureProjectionSha256: stage.inputStructureProjectionSha256,
            outputStructureProjectionSha256: stage.outputStructureProjectionSha256
        });
        Object.assign(paper.analysisManifest.stages.scoringAudit, {
            coreSummaryInputAnalysisSha256: analysisSha,
            inputCoreSummarySha256: summarySha,
            outputCoreSummarySha256: summarySha
        });
        assert.strictEqual(isSuccessfulAnalysisRecord(paper), false);
        assert.match(contract.validateCoreSummaryStageBinding(paper), /中文字符不足/);
    });

    it('失败重试不覆盖旧成功正文，但合并恢复元数据供下次续跑', () => {
        const complete = {
            arxivId: '2604.00024', title: 'Existing', analysis: validAnalysisText(),
            imageManifest: { selected: ['old-image'] }
        };
        const failed = {
            arxivId: '2604.00024',
            title: 'Existing',
            analysis: null,
            error: 'secondary timeout',
            imageManifest: { selected: [], downloaded: [] },
            analysisCheckpoint: validAnalysisText(),
            analysisStaleSnapshots: [{ contract: 'stale-analysis-snapshot-v1',
                payloadSha256: 'a'.repeat(64), payload: { retained: true } }],
            manualIngestionCheckpoint: { version: 1, mode: 'manual_complete', analysisSha256: 'a'.repeat(64) },
            analysisManifest: { version: 1, stages: { imageDownload: { status: 'transient_failure' } } }
        };
        const { mergePapersById } = require('../scripts/analysis-engine.js');
        const [merged] = mergePapersById([complete], [failed], { preserveSuccessfulAnalysis: true });
        assert.strictEqual(merged.analysis, complete.analysis);
        assert.strictEqual(merged.analysisCheckpoint, failed.analysisCheckpoint);
        assert.deepStrictEqual(merged.analysisStaleSnapshots, failed.analysisStaleSnapshots);
        assert.deepStrictEqual(merged.imageManifest, complete.imageManifest);

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-stale-snapshot-persist-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({ papers: [complete] }));
        const { persistAnalysisCheckpoint } = require('../scripts/analysis-engine.js');
        persistAnalysisCheckpoint(file, failed);
        const reloaded = readJsonFileStrict(file).papers[0];
        assert.deepStrictEqual(reloaded.analysisStaleSnapshots, failed.analysisStaleSnapshots);
        assert.strictEqual(reloaded.analysis, complete.analysis);
        assert.deepStrictEqual(merged.analysisRecoveryImageManifest, failed.imageManifest);
        assert.deepStrictEqual(merged.manualIngestionCheckpoint, failed.manualIngestionCheckpoint);
        assert.strictEqual(merged.latestAnalysisAttemptError, 'secondary timeout');
        assert.strictEqual(isSuccessfulAnalysisRecord(merged), false);

        const [mergedAgain] = mergePapersById([merged], [{
            ...failed,
            error: 'secondary timeout again',
            analysisCheckpoint: null
        }], { preserveSuccessfulAnalysis: true });
        assert.strictEqual(mergedAgain.analysis, complete.analysis);
        assert.strictEqual(mergedAgain.latestAnalysisAttemptError, 'secondary timeout again');
    });

    it('新鲜论文元数据优先，canonical 只恢复分析状态字段', () => {
        const merged = mergeCanonicalAnalysisState(
            { arxivId: '2604.00025v2', title: 'Fresh title', abstract: 'Fresh abstract', authors: ['New'] },
            {
                arxivId: '2604.00025',
                title: 'Stale title',
                abstract: 'Stale abstract',
                authors: ['Old'],
                analysis: validAnalysisText(),
                analysisCheckpoint: 'checkpoint'
            }
        );
        assert.strictEqual(merged.title, 'Fresh title');
        assert.strictEqual(merged.abstract, 'Fresh abstract');
        assert.deepStrictEqual(merged.authors, ['New']);
        assert.strictEqual(merged.analysis, validAnalysisText());
        assert.strictEqual(merged.analysisCheckpoint, 'checkpoint');
    });

    it('原子初始化不会覆盖并发进程已创建的 current 文件', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-init-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        updateJsonFileLocked(file, () => ({ papers: [{ arxivId: '2604.00026', title: 'current' }] }));
        const result = initializeJsonFileLocked(file, {
            papers: [{ arxivId: '2604.00027', title: 'legacy' }]
        });
        assert.strictEqual(result.papers[0].title, 'current');
        assert.strictEqual(readJsonFileStrict(file).papers[0].title, 'current');
    });

    it('成功重试会清理最新失败标记', async () => {
        const result = await analyzePaperWithRetry({
            arxivId: '2604.00028',
            latestAnalysisAttemptError: 'old timeout',
            latestAnalysisAttemptAt: '2026-07-31T10:00:00.000+08:00',
            digestStatus: { latestAttemptStatus: 'analysis_failed', error: 'old timeout' }
        }, {
            maxRetries: 0,
            analyzeFn: async () => validAnalyzedResult()
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.latestAnalysisAttemptError, undefined);
        assert.strictEqual(result.result.latestAnalysisAttemptAt, undefined);
        assert.strictEqual(result.result.digestStatus.latestAttemptStatus, 'analyzed');
        assert.strictEqual(result.result.digestStatus.error, null);
    });

    it('最终契约拒绝展示总分或分档与八维重算结果不一致', () => {
        const wrongScore = validAnalysisText().replace('6.9/10', '6.0/10');
        assert.match(getInvalidAnalysisReason(wrongScore, require('../scripts/utils.js').parseAnalysis(wrongScore)), /总分.*不一致/);
        const wrongRank = validAnalysisText().replace('rank_bucket: 前50%', 'rank_bucket: 后50%');
        assert.match(getInvalidAnalysisReason(wrongRank, require('../scripts/utils.js').parseAnalysis(wrongRank)), /rank_bucket.*不一致/);
    });
});

describe('analyzeBatch', () => {
    it('同篇论文的锁覆盖最新状态重读、分析和写回，排队请求不会覆盖新结果', async () => {
        let canonical = null;
        let analyzeCalls = 0;
        const suffix = String(10000 + Math.floor(Math.random() * 89999));
        const paperId = `2607.${suffix}`;
        const papers = [
            { arxivId: paperId, title: 'same paper' },
            { arxivId: `${paperId}v2`, title: 'same paper queued' }
        ];
        const { stats } = await analyzeBatch(papers, {
            concurrency: 2,
            maxRetries: 0,
            preparePaperLocked: paper => canonical && isSuccessfulAnalysisRecord(canonical)
                ? { paper: canonical, skip: true }
                : { paper, skip: false },
            analyzeFn: async () => {
                analyzeCalls++;
                return {
                    analysis: validAnalysisText(),
                    analysisManifest: validAnalysisPaper('fixture').analysisManifest
                };
            },
            onPaperResultLocked: async (_paper, result) => {
                canonical = result.result;
            }
        });
        assert.strictEqual(analyzeCalls, 1);
        assert.strictEqual(stats.success, 1);
        assert.strictEqual(stats.skipped, 1);
        assert.strictEqual(isSuccessfulAnalysisRecord(canonical), true);
    });

    it('拒绝零、负数和非整数并发，避免循环无法推进', async () => {
        for (const concurrency of [0, -1, 1.5, Number.NaN]) {
            await assert.rejects(analyzeBatch([], { concurrency }), /concurrency 必须是正整数/);
        }
    });

    it('透传自定义 analyzeFn 到每篇论文分析', async () => {
        const calls = [];
        const { results, stats } = await analyzeBatch(
            [{ arxivId: '2604.00003', title: 'Custom analyzer' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async (paper) => {
                    calls.push(paper.arxivId);
                    return validAnalyzedResult();
                }
            }
        );

        assert.deepStrictEqual(calls, ['2604.00003']);
        assert.strictEqual(stats.success, 1);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].error, null);
    });

    it('滚动并发会持续补位，同时保持结果与逻辑批次的输入顺序', async () => {
        const papers = Array.from({ length: 4 }, (_, index) => ({
            arxivId: `2604.${String(index + 101).padStart(5, '0')}`,
            title: `Rolling ${index + 1}`
        }));
        const started = [];
        const doneIndexes = [];
        const resolvers = new Map();
        const completedBatches = [];
        const waitFor = async predicate => {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (predicate()) return;
                await new Promise(resolve => setImmediate(resolve));
            }
            assert.fail('等待滚动并发状态超时');
        };

        const running = analyzeBatch(papers, {
            concurrency: 2,
            maxRetries: 0,
            analyzeFn: paper => new Promise(resolve => {
                started.push(paper.arxivId);
                resolvers.set(paper.arxivId, () => resolve(validAnalyzedResult()));
            }),
            onPaperDone: index => { doneIndexes.push(index); },
            onBatchDone: (batchNum, batchResults) => {
                completedBatches.push({
                    batchNum,
                    ids: batchResults.map(item => item.result?.arxivId || item.paper?.arxivId)
                });
            }
        });

        await waitFor(() => started.length === 2);
        resolvers.get(papers[1].arxivId)();
        await waitFor(() => started.length === 3);
        assert.deepStrictEqual(started, papers.slice(0, 3).map(paper => paper.arxivId));

        resolvers.get(papers[2].arxivId)();
        await waitFor(() => started.length === 4);
        resolvers.get(papers[3].arxivId)();
        await waitFor(() => doneIndexes.length === 3);
        assert.deepStrictEqual(completedBatches, [], '后一逻辑批次不能越过未完成的第一批回调');

        resolvers.get(papers[0].arxivId)();
        const { results, stats } = await running;
        assert.deepStrictEqual(doneIndexes, [1, 2, 3, 0]);
        assert.deepStrictEqual(results.map(item => item.arxivId), papers.map(item => item.arxivId));
        assert.deepStrictEqual(completedBatches, [
            { batchNum: 1, ids: papers.slice(0, 2).map(item => item.arxivId) },
            { batchNum: 2, ids: papers.slice(2, 4).map(item => item.arxivId) }
        ]);
        assert.strictEqual(stats.success, 4);
    });

    it('阶段 checkpoint 在单篇运行锁内立即原子写入 canonical 结果', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-stage-checkpoint-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        updateJsonFileLocked(file, () => ({ papers: [{ arxivId: '2604.00033', title: 'Checkpoint' }] }));

        await analyzeBatch([{ arxivId: '2604.00033', title: 'Checkpoint' }], {
            concurrency: 1,
            maxRetries: 0,
            checkpointFilePath: file,
            analyzeFn: async paper => {
                paper.analysisCheckpoint = validAnalysisText();
                paper.analysisManifest = {
                    version: 1,
                    stages: { primaryAnalysis: { status: 'complete' } }
                };
                paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')](paper);
                throw new Error('simulated crash after primary analysis');
            }
        });

        const saved = readJsonFileStrict(file).papers[0];
        assert.strictEqual(saved.analysisCheckpoint, validAnalysisText());
        assert.strictEqual(saved.analysisManifest.stages.primaryAnalysis.status, 'complete');
        assert.strictEqual(saved.analysis, null);
    });

    it('shouldSkip 决策只对每篇论文计算一次', async () => {
        const calls = new Map();
        const papers = [
            { arxivId: '2604.00001v1', title: 'A' },
            { arxivId: '2604.00002v1', title: 'B' }
        ];

        const { stats } = await analyzeBatch(papers, {
            concurrency: 2,
            shouldSkip: (paper) => {
                calls.set(paper.arxivId, (calls.get(paper.arxivId) || 0) + 1);
                return true;
            }
        });

        assert.strictEqual(stats.skipped, 2);
        assert.strictEqual(calls.get('2604.00001v1'), 1);
        assert.strictEqual(calls.get('2604.00002v1'), 1);
    });

    it('onPaperDone 异常会终止批次并向入口传播', async () => {
        await assert.rejects(analyzeBatch(
            [{ arxivId: '2604.00011', title: 'Callback failure' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async () => ({ analysis: validAnalysisText() }),
                onPaperDone: () => { throw new Error('paper save failed'); }
            }
        ), /paper save failed/);
    });

    it('异步 onBatchDone 异常会终止批次并向入口传播', async () => {
        await assert.rejects(analyzeBatch(
            [{ arxivId: '2604.00012', title: 'Batch callback failure' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async () => ({ analysis: validAnalysisText() }),
                onBatchDone: async () => { throw new Error('batch save failed'); }
            }
        ), /batch save failed/);
    });
});

describe('analysis run status', () => {
    it('区分 complete、partial_failed 和 failed 并映射非零退出码', () => {
        assert.strictEqual(getAnalysisRunStatus({ success: 2, failed: 0 }), 'complete');
        assert.strictEqual(getAnalysisRunStatus({ success: 2, failed: 1 }), 'partial_failed');
        assert.strictEqual(getAnalysisRunStatus({ success: 0, failed: 2 }), 'failed');
        assert.strictEqual(getAnalysisExitCode('complete'), 0);
        assert.strictEqual(getAnalysisExitCode('partial_failed'), 2);
        assert.strictEqual(getAnalysisExitCode('failed'), 1);
    });

    it('续跑状态按 canonical 全量成功数计算，不把已有成功漏算为 failed', () => {
        const papers = Array.from({ length: 9 }, (_, index) => validAnalysisPaper(`2604.${String(index + 1).padStart(5, '0')}`));
        papers.push({ arxivId: '2604.99999', error: 'latest attempt failed' });
        assert.deepStrictEqual(getCanonicalAnalysisRunSummary(papers), {
            success: 9,
            remaining: 1,
            status: 'partial_failed'
        });
    });

    it('锁内更新为对象结果自动递增 generation', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-generation-'));
        const file = path.join(dir, 'result.json');
        updateJsonFileLocked(file, () => ({ papers: [] }));
        updateJsonFileLocked(file, current => ({ ...current, marker: true }));
        const saved = readJsonFileStrict(file);
        assert.strictEqual(saved.generation, 2);
        assert.strictEqual(saved.marker, true);
    });

    it('活着的本机 PID 不会仅因锁超龄而被回收', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-live-'));
        const lockPath = path.join(dir, 'result.json.lock');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            token: 'live-owner'
        }));
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
        fs.utimesSync(lockPath, old, old);

        assert.strictEqual(canReclaimFileLock(lockPath, 1), false);
    });

    it('远端主机锁只有租约超龄后才可回收', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-remote-'));
        const lockPath = path.join(dir, 'result.json.lock');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 12345,
            hostname: `${os.hostname()}-remote`,
            token: 'remote-owner'
        }));
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
        fs.utimesSync(lockPath, old, old);

        assert.strictEqual(canReclaimFileLock(lockPath, 1), true);
    });

    it('旧 owner 的 release 不会删除同路径的新锁', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-aba-'));
        const target = path.join(dir, 'result.json');
        const releaseOld = acquireFileLockSync(target);
        fs.rmSync(`${target}.lock`, { recursive: true, force: true });
        const releaseNew = acquireFileLockSync(target);

        assert.strictEqual(releaseOld(), false);
        assert.strictEqual(fs.existsSync(`${target}.lock`), true);
        assert.strictEqual(releaseNew(), true);
    });

    it('异步锁在 callback 完成前保持持有', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-async-'));
        const target = path.join(dir, 'run');
        await withFileLock(target, async () => {
            assert.strictEqual(fs.existsSync(`${target}.lock`), true);
            await new Promise(resolve => setTimeout(resolve, 5));
            assert.strictEqual(fs.existsSync(`${target}.lock`), true);
        });
        assert.strictEqual(fs.existsSync(`${target}.lock`), false);
    });
});

describe('selected reanalysis stats', () => {
    it('只把旧评分契约恢复为当前契约的论文计入恢复数', () => {
        const { updateReanalysisStats } = require('../scripts/reanalyze-selected.js');
        const data = {
            papers: [{ arxivId: 'a' }, { arxivId: 'b' }, { arxivId: 'c' }],
            stats: { reanalyzed: 1, reanalyzeFailed: 2 }
        };
        const results = [
            { arxivId: 'a', parsed: { scoringRubricVersion: 'type-aware-v1' } },
            { arxivId: 'b', parsed: { scoringRubricVersion: 'type-aware-v1' } }
        ];
        const recovered = updateReanalysisStats(data, results, new Set(['a']), { success: 2, failed: 0 }, '2026-07-10T18:00:00+08:00');

        assert.strictEqual(recovered, 1);
        assert.strictEqual(data.stats.reanalyzed, 2);
        assert.strictEqual(data.stats.reanalyzeFailed, 1);
        assert.strictEqual(data.stats.selectedReanalyzed, 2);
        assert.strictEqual(data.stats.selectedReanalyzeFailed, 0);
    });
});

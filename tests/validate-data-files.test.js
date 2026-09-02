const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');
const { buildFilterInputSha256 } = require('../scripts/lib/filter-input-contract.js');
const { parseAnalysis } = require('../scripts/utils.js');
const {
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION,
    MANUAL_AUDIT_CHECKS,
    MANUAL_COMPLETE_STATUS,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    manualSha256,
    manualTextSha256
} = require('../scripts/analysis-contract.js');
const { validAnalysisText, validAnalysisPaper } = require('./valid-analysis-fixture.js');

const {
    validatePapersDatabase,
    validateFetchCheckpointFile,
    validatePaperListFile,
    validateFilterDecisionsFile,
    validateCurrentDataFiles,
    validateFilteredDeepPapersConsistency,
    resolveManualPaperIdentityMode
} = require('../scripts/validate-data-files.js');

const TIMESTAMP = '2026-07-13T10:00:00.000+08:00';
const CANDIDATE_FP = 'a'.repeat(16);
const SOURCE_FP = 'b'.repeat(16);
const BLOG_FP = 'c'.repeat(16);
const FILTER_FP = 'd'.repeat(16);
const BATCH_ID = 'e'.repeat(16);

function papersSha256(papers) {
    const normalize = value => Array.isArray(value) ? value.map(normalize)
        : (value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
            : value);
    return crypto.createHash('sha256').update(JSON.stringify(normalize(papers))).digest('hex');
}

function filterInputSha256(paper) {
    return buildFilterInputSha256(paper);
}

function completeAnalysisPaper(id, extra = {}) {
    const analysis = validAnalysisText();
    return {
        ...validAnalysisPaper(id),
        parsed: parseAnalysis(analysis),
        scoringRubricVersion: 'type-aware-v1',
        ...extra
    };
}

function writeManualV4BindingFixture(dir, { invalidClaimQuote = true } = {}) {
    const batchDate = '2026-07-13';
    const paperId = '2607.77777';
    const resultFile = path.join(dir, 'deep-analysis-result.json');
    const sourceDir = path.join(dir, 'manual-full-text', batchDate);
    const sourcePath = path.join(sourceDir, `${paperId}-fixture.txt`);
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourceText = [
        'Controlled full text evidence states that the proposed method improves recognition under matched conditions. Fixture setting 1 under condition 1: fixture method versus fixture baseline reports qualitative outcome 41.0 score, higher-is-better.',
        'Additional evidence documents the evaluation setting and limitation boundary. Fixture setting 2 under condition 2: fixture method versus fixture baseline reports qualitative outcome 42.0 score, higher-is-better.',
        'Open-source materials are released for reproducibility. Fixture setting 3 under condition 3: fixture method versus fixture baseline reports qualitative outcome 43.0 score, higher-is-better.'
    ].join('\n');
    fs.writeFileSync(sourcePath, sourceText);
    const sourceSha256 = crypto.createHash('sha256').update(sourceText).digest('hex');
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
        version: 2,
        mode: 'manual_full_text_fetch',
        date: batchDate,
        papers: {
            [paperId]: {
                status: 'complete',
                path: sourcePath,
                sourceSha256
            }
        }
    }));

    const analysis = validAnalysisText().replace(
        '## 实验结果\n',
        `## 实验结果\n${sourceText}\n\n`
    );
    const ledgerSections = [
        '核心摘要', '方法概述和架构', '实验结果',
        '局限与问题', '开源详情', '细节详述'
    ];
    const ledger = ledgerSections.map((section, index) => ({
        id: `E${String(index + 1).padStart(2, '0')}`,
        section,
        claim: `这是第 ${index + 1} 条长度足够且对应论文事实章节的人工证据声明。`,
        sourceQuote: index === 4
            ? 'Open-source materials are released for reproducibility.'
            : 'Controlled full text evidence states that the proposed method improves recognition under matched conditions.'
    }));
    const validClaimQuotes = [
        'Controlled full text evidence states that the proposed method improves recognition under matched conditions.',
        'Additional evidence documents the evaluation setting and limitation boundary.',
        'Open-source materials are released for reproducibility.'
    ];
    const claims = validClaimQuotes.map((_sourceQuote, index) => {
        const value = `${41 + index}.0`;
        const sourceQuote = sourceText.split('\n')[index];
        return {
        datasetOrSetting: `Fixture setting ${index + 1}`,
        splitOrCondition: `condition ${index + 1}`,
        method: 'fixture method',
        baseline: 'fixture baseline',
        metric: 'qualitative outcome',
        value,
        unit: 'score',
        direction: 'higher_is_better',
        sourceQuote: invalidClaimQuote && index === 1
            ? 'This fabricated quote is not a continuous excerpt of the full text.'
            : sourceQuote,
        sourceBindings: {
            datasetOrSetting: `Fixture setting ${index + 1}`,
            splitOrCondition: `condition ${index + 1}`,
            method: 'fixture method', baseline: 'fixture baseline',
            metric: 'qualitative outcome', value: `${value} score`,
            unit: 'score', direction: 'higher-is-better'
        },
        readerBindings: {
            datasetOrSetting: `Fixture setting ${index + 1}`,
            splitOrCondition: `condition ${index + 1}`,
            method: 'fixture method', baseline: 'fixture baseline',
            metric: 'qualitative outcome', value: `${value} score`,
            unit: 'score', direction: 'higher-is-better'
        }
    };
    });
    const audit = {
        version: 1,
        attempts: 2,
        passes: [{ status: 'revise', issues: ['补充连续全文证据绑定'] }, { status: 'pass', issues: [] }],
        checks: Object.fromEntries(MANUAL_AUDIT_CHECKS.map(key => [key, true]))
    };
    const takeover = {
        version: 2,
        mode: MANUAL_COMPLETE_STATUS,
        agent: 'fixture-agent',
        basis: 'full_text',
        sourceSha256,
        promptSha256: 'a'.repeat(64),
        manualAuthoringPromptSha256: 'b'.repeat(64),
        analysisSha256: manualTextSha256(analysis),
        completedAt: TIMESTAMP,
        reason: '测试 validate:data 是否从受控全文执行连续原句绑定。',
        review: {
            sourceVerified: true,
            analysisContractVerified: true,
            scoringVerified: true,
            stageEvidenceVerified: true,
            readerQualityVerified: true
        },
        audit,
        evidenceLedger: ledger,
        evidenceLedgerSha256: manualSha256(ledger),
        documentType: '方法研究',
        resultClaims: claims,
        resultClaimsSha256: manualSha256({ claims, exception: null })
    };
    const stages = Object.fromEntries([
        'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
        'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
    ].map(stage => [stage, { status: MANUAL_COMPLETE_STATUS }]));
    const paper = completeAnalysisPaper(paperId, {
        analysis,
        analysisManifest: {
            version: 1,
            contracts: {
                experimentTables: EXPERIMENT_TABLE_CONTRACT_VERSION,
                manualDepth: MANUAL_DEPTH_CONTRACT_VERSION_V4,
                imageNarrative: 'context-bound-v1',
                editorialQuality: 'reader-facing-v1'
            },
            sourceAcquisition: {
                analysisSource: 'provided_full_text',
                sourceId: paperId,
                sourceSha256
            },
            stages,
            manualTakeover: takeover
        }
    });
    fs.writeFileSync(resultFile, JSON.stringify({ batchDate, papers: [paper] }));
    return { resultFile, sourcePath, sourceText };
}

function hardenManualImageEvidence(paper) {
    const takeover = paper.analysisManifest.manualTakeover;
    takeover.completedAt = '2026-08-22T10:00:00.000+08:00';
    const rubricDimensions = [
        'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
        'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
        'antiTemplateOriginality'
    ];
    takeover.readabilityRubric = {
        dimensions: Object.fromEntries(rubricDimensions.map(name => [name, {
            score: 2,
            reason: `${name} 已完成逐项复核并绑定当前正文证据。`,
            evidence: [`${name}-fixture-evidence`]
        }]))
    };
    takeover.readabilityRubricSha256 = manualSha256(takeover.readabilityRubric);
    const imageManifest = {
        version: 2,
        candidates: [],
        downloaded: [],
        downloadOutcomes: [],
        selected: [],
        insertionPlan: [],
        insertionDiagnostics: []
    };
    imageManifest.downloadEvidenceSha256 = manualSha256({ candidates: [], outcomes: [] });
    imageManifest.selectionEvidenceSha256 = manualSha256({
        selected: [], insertionPlan: [], insertionDiagnostics: []
    });
    paper.imageManifest = imageManifest;
    const promptByStage = Object.fromEntries([
        'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
        'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
    ].map(stage => [stage, {
        source: `manual-stage-contract:${stage}:test`,
        sha256: manualSha256({ stage, contract: 'test' })
    }]));
    const claimsByStage = {
        imageDownload: '图片下载与图注证据已核对。',
        primaryAnalysis: '主分析方法架构与输入输出已核对。',
        openSourceScan: '开源代码与复现链接已核对。',
        demoLinkScan: 'Demo 演示链接状态已核对。',
        revision: '正文事实修订与局限一致性已核对。',
        tableRepair: '实验表格、指标数值与基线已核对。',
        methodRepair: '方法模块、训练和推理数据流已核对。',
        structureRepair: '章节结构、标题与摘要格式已核对。',
        scoringAudit: '评分维度、严谨性与实验充分性已核对。',
        imageSupplement: '插图 caption 与段落视觉关系已核对。'
    };
    const auditSha256 = manualSha256(takeover.audit);
    takeover.promptSha256 = promptByStage.primaryAnalysis.sha256;
    takeover.stageEvidence = {};
    for (const stage of Object.keys(promptByStage)) {
        const claims = [claimsByStage[stage]];
        const contextSha256 = stage === 'imageDownload'
            ? imageManifest.downloadEvidenceSha256
            : (stage === 'imageSupplement' ? imageManifest.selectionEvidenceSha256 : undefined);
        const inputSha256 = manualSha256({
            stage,
            executionKind: 'manual_attestation',
            sourceSha256: takeover.sourceSha256,
            analysisSha256: takeover.analysisSha256,
            claims,
            stagePromptSha256: promptByStage[stage].sha256,
            stageContextSha256: contextSha256 || null
        });
        const common = {
            status: MANUAL_COMPLETE_STATUS,
            executionKind: 'manual_attestation',
            protocol: 'manual-offline-review-v1',
            promptSource: promptByStage[stage].source,
            promptSha256: promptByStage[stage].sha256
        };
        paper.analysisManifest.stages[stage] = { ...common };
        takeover.stageEvidence[stage] = {
            ...common,
            attempts: 2,
            inputSha256,
            outputSha256: takeover.analysisSha256,
            auditSha256: manualSha256({
                stage, claims, auditSha256, stageInputSha256: inputSha256
            }),
            reviewedClaims: claims,
            ...(contextSha256 ? { contextSha256 } : {})
        };
    }
    return paper;
}

function fetchSourcesSha256(checkpoint) {
    const value = {
        arxiv: Object.fromEntries(Object.entries(checkpoint.arxiv || {}).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, entry]) => [id, { status: entry.status, papersCount: entry.papersCount, papersSha256: entry.papersSha256 }])),
        huggingface: checkpoint.huggingface ? { status: checkpoint.huggingface.status, papersCount: checkpoint.huggingface.papersCount, papersSha256: checkpoint.huggingface.papersSha256 } : null
    };
    return papersSha256(value);
}

function checkpointEntry(papers, health, status = 'complete') {
    return { status, papers, papersCount: papers.length, papersSha256: papersSha256(papers), health };
}

function writeCompleteCheckpoint(filePath) {
    const categoryOrder = Config.ARXIV_CATEGORIES.map(category => category.id);
    const checkpoint = {
        timestamp: TIMESTAMP,
        batchDate: '2026-07-13',
        batchId: BATCH_ID,
        candidateFingerprint: CANDIDATE_FP,
        sourceConfigFingerprint: SOURCE_FP,
        blogDedupFingerprint: BLOG_FP,
        historicalDedupIds: [],
        categoryOrder,
        arxiv: Object.fromEntries(categoryOrder.map((id, index) => [id, checkpointEntry(
            [{ arxivId: `2607.${String(91000 + index)}` }],
            { id, ok: true }
        )])),
        huggingface: checkpointEntry([], { ok: true })
    };
    checkpoint.fetchSourcesSha256 = fetchSourcesSha256(checkpoint);
    fs.writeFileSync(filePath, JSON.stringify(checkpoint));
}

function writeMinimalCurrentBatch(dir) {
    const fetchCheckpoint = path.join(dir, 'fetch-checkpoint.json');
    const rawCandidates = path.join(dir, 'raw-candidates.json');
    const filterDecisions = path.join(dir, 'filter-decisions.json');
    const filteredPapers = path.join(dir, 'filtered-papers.json');
    writeCompleteCheckpoint(fetchCheckpoint);
    const checkpoint = JSON.parse(fs.readFileSync(fetchCheckpoint));
    const rawPapers = [{ arxivId: '2607.00001' }];
    const integrity = {
        batchDate: '2026-07-13', batchId: BATCH_ID,
        rawPapersSha256: papersSha256(rawPapers), fetchSourcesSha256: checkpoint.fetchSourcesSha256
    };
    const fingerprints = {
        candidateFingerprint: CANDIDATE_FP,
        sourceConfigFingerprint: SOURCE_FP,
        blogDedupFingerprint: BLOG_FP
    };
    fs.writeFileSync(rawCandidates, JSON.stringify({
        timestamp: TIMESTAMP, ...fingerprints, ...integrity,
        stats: { beforeBlogSkip: 1, afterBlogSkip: 1, skippedFromBlog: 0, arxivOnly: 1, hfOnly: 0, both: 0 },
        sourceHealth: {
            arxiv: { categories: Config.ARXIV_CATEGORIES.map(({ id }) => ({ id, ok: true })) },
            huggingface: { ok: true }
        },
        papers: rawPapers
    }));
    fs.writeFileSync(filterDecisions, JSON.stringify({
        timestamp: TIMESTAMP, ...fingerprints, ...integrity, filterModel: 'model-a', filterPromptHash: 'hash-a',
        filterConfigFingerprint: FILTER_FP,
        stats: { totalCandidates: 1, decided: 1, related: 1, complete: true },
        decisions: { '2607.00001': { related: true, inputSha256: filterInputSha256(rawPapers[0]) } }
    }));
    fs.writeFileSync(filteredPapers, JSON.stringify({
        timestamp: TIMESTAMP, ...fingerprints, ...integrity, filterModel: 'model-a', filterPromptHash: 'hash-a',
        filterConfigFingerprint: FILTER_FP, status: 'complete',
        stats: { afterBlogSkip: 1, afterFilter: 1, afterArchiveSkip: 1, decisionCount: 1 },
        papers: [{ arxivId: '2607.00001' }]
    }));
    return { fetchCheckpoint, rawCandidates, filterDecisions, filteredPapers };
}

describe('validate-data-files', () => {
    it('历史 v5 只兼容无 fresh/tutorial marker；带新鲜正文标记时不得绕过逐论文身份', () => {
        assert.equal(resolveManualPaperIdentityMode({
            contracts: { manualDepth: 'full-text-evidence-v5' }
        }), 'historical_per_entry');
        assert.throws(() => resolveManualPaperIdentityMode({
            contracts: {
                manualDepth: 'full-text-evidence-v5',
                freshAuthoring: 'fresh-authoring-v1'
            }
        }), /fresh\/tutorial canonical 缺少逐论文来源身份/);
        assert.throws(() => resolveManualPaperIdentityMode({
            contracts: {
                manualDepth: 'full-text-evidence-v5',
                tutorialPayload: 'manual-v5-tutorial-payload-v1'
            }
        }), /fresh\/tutorial canonical 缺少逐论文来源身份/);
        assert.equal(resolveManualPaperIdentityMode({
            contracts: {
                manualDepth: 'full-text-evidence-v5',
                freshAuthoring: 'fresh-authoring-v1',
                tutorialPayload: 'manual-v5-tutorial-payload-v1',
                paperSourceIdentity: 'manual-paper-source-identity-v1'
            }
        }), 'per_paper_v1');
    });
    it('校验抓取 checkpoint 的来源状态和同批次指纹', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const checkpointFile = path.join(dir, 'fetch-checkpoint.json');
        fs.writeFileSync(checkpointFile, JSON.stringify({
            timestamp: '2026-07-13T10:00:00+08:00',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            arxiv: {
                'cs.SD': {
                    status: 'complete',
                    papers: [],
                    health: { id: 'cs.SD', ok: false }
                }
            },
            huggingface: {
                status: 'failed',
                papers: [],
                health: { ok: true }
            }
        }));
        const issues = validateFetchCheckpointFile(checkpointFile).join('\n');
        assert.match(issues, /complete 时 health\.ok 必须为 true/);
        assert.match(issues, /failed 时 health\.ok 必须为 false/);
    });

    it('校验 checkpoint 论文数量和稳定内容 SHA，识别内容篡改与缺字段', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-tamper-'));
        const checkpointFile = path.join(dir, 'fetch-checkpoint.json');
        writeCompleteCheckpoint(checkpointFile);
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile));
        const categoryId = Config.ARXIV_CATEGORIES[0].id;
        checkpoint.arxiv[categoryId].papers.push({ arxivId: '2607.00001' });
        delete checkpoint.huggingface.papersCount;
        fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint));

        const issues = validateFetchCheckpointFile(checkpointFile).join('\n');
        assert.match(issues, new RegExp(`arxiv\\.${categoryId}\\.papersCount`));
        assert.match(issues, new RegExp(`arxiv\\.${categoryId}\\.papersSha256 与 papers 内容不一致`));
        assert.match(issues, /huggingface\.papersCount/);
    });

    it('当前抓取筛选产物强制完整合法指纹并与 checkpoint 对齐', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-fingerprint-'));
        const files = writeMinimalCurrentBatch(dir);
        const raw = JSON.parse(fs.readFileSync(files.rawCandidates));
        delete raw.candidateFingerprint;
        fs.writeFileSync(files.rawCandidates, JSON.stringify(raw));
        const decisions = JSON.parse(fs.readFileSync(files.filterDecisions));
        decisions.sourceConfigFingerprint = 'not-a-fingerprint';
        delete decisions.filterConfigFingerprint;
        fs.writeFileSync(files.filterDecisions, JSON.stringify(decisions));
        const filtered = JSON.parse(fs.readFileSync(files.filteredPapers));
        filtered.blogDedupFingerprint = 'e'.repeat(16);
        fs.writeFileSync(files.filteredPapers, JSON.stringify(filtered));

        const issues = validateCurrentDataFiles({
            ...files, papers: path.join(dir, 'missing-papers.json'), deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }).join('\n');
        assert.match(issues, /candidateFingerprint 必须是 16 位/);
        assert.match(issues, /sourceConfigFingerprint 必须是 16 位/);
        assert.match(issues, /filterConfigFingerprint 必须是 16 位/);
        assert.match(issues, /blogDedupFingerprint 必须与 fetch-checkpoint\.json 一致/);
    });

    it('当前抓取筛选产物必须使用北京时间 ISO 且同批日期一致', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-date-'));
        const files = writeMinimalCurrentBatch(dir);
        const raw = JSON.parse(fs.readFileSync(files.rawCandidates));
        raw.timestamp = '2026-07-13T02:00:00.000Z';
        fs.writeFileSync(files.rawCandidates, JSON.stringify(raw));
        const filtered = JSON.parse(fs.readFileSync(files.filteredPapers));
        filtered.timestamp = '2026-07-14T10:00:00.000+08:00';
        fs.writeFileSync(files.filteredPapers, JSON.stringify(filtered));

        const issues = validateCurrentDataFiles({
            ...files, papers: path.join(dir, 'missing-papers.json'), deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }).join('\n');
        assert.match(issues, /raw-candidates\.json: timestamp 必须是合法的北京时间 ISO/);
        assert.match(issues, /filtered-papers\.json: timestamp 日期必须与同批次 fetch-checkpoint\.json 一致/);
    });

    it('接受合法 papers.json 和 deep-analysis-result.json', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const papersFile = path.join(dir, 'papers.json');
        const resultFile = path.join(dir, 'deep-analysis-result.json');

        fs.writeFileSync(papersFile, JSON.stringify({
            papers: {
                '2607.00001': {
                    arxivId: '2607.00001',
                    digestStatus: { status: 'analyzed' }
                }
            }
        }));
        const analysis = validAnalysisText();
        const terminalStages = Object.fromEntries([
            'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
            'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
        ].map(stage => [stage, { status: stage === 'imageSupplement' ? 'no_candidates' : 'complete' }]));
        fs.writeFileSync(resultFile, JSON.stringify({
            stats: {
                totalAfterMerge: 1
            },
            sourceHealth: {
                arxiv: { categories: [{ id: 'cs.SD', ok: true }] },
                huggingface: { ok: true }
            },
            papers: [{
                arxivId: '2607.00001',
                analysis,
                scoringRubricVersion: 'type-aware-v1',
                parsed: parseAnalysis(analysis),
                selectedImageUrls: [],
                imageManifest: { selected: [] },
                analysisManifest: { version: 1, stages: terminalStages }
            }]
        }));

        assert.deepStrictEqual(validatePapersDatabase(papersFile), []);
        assert.deepStrictEqual(validatePaperListFile(resultFile, { deepAnalysis: true }), []);
    });

    it('自动 API canonical 报告未解决评分稳定性与 Reader v3 缺口', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-api-gates-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        const paper = completeAnalysisPaper('2607.00002');
        paper.analysisManifest.stages.scoringAudit = {
            status: 'complete',
            scoringContract: 'api-scoring-audit-v2',
            outputAnalysisSha256: crypto.createHash('sha256').update(paper.analysis).digest('hex'),
            stabilityWarning: true
        };
        fs.writeFileSync(resultFile, JSON.stringify({ papers: [paper] }));
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /评分稳定性告警尚未形成有效二次审计 resolution/);
        assert.match(issues, /自动 API production 缺少 Reader v3 完整绑定/);
    });

    it('Manual v4 canonical 从同批受控全文加载原文并拒绝非连续 resultClaims 引用', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-manual-v4-source-'));
        const { resultFile } = writeManualV4BindingFixture(dir);
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(
            issues,
            /resultClaims\[1\]\.sourceQuote.*连续摘录存在于全文/
        );
        assert.doesNotMatch(issues, /缺少同批次受控全文 manifest|全文内容 SHA 不一致/);
    });

    it('Manual v4 canonical 拒绝受控全文内容与 sourceAcquisition SHA 脱钩', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-manual-v4-sha-'));
        const { resultFile, sourcePath } = writeManualV4BindingFixture(dir, {
            invalidClaimQuote: false
        });
        fs.appendFileSync(sourcePath, '\ntampered after manifest binding');
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /analysisManifest\.sourceAcquisition 的受控全文内容 SHA 不一致/);
    });

    it('validate:data 按 manualDepth 版本重跑 Manual v4 正文门禁', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-manual-v4-depth-'));
        const { resultFile } = writeManualV4BindingFixture(dir, { invalidClaimQuote: false });
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /manual 深度契约无效/);
    });

    it('validate:data 重算顶层 Manual imageManifest 证据哈希并拒绝篡改', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-manual-image-sha-'));
        const { resultFile } = writeManualV4BindingFixture(dir, { invalidClaimQuote: false });
        const payload = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        hardenManualImageEvidence(payload.papers[0]);
        payload.papers[0].imageManifest.insertionPlan.push({
            imageNumber: 1,
            lead: '被篡改的图前说明',
            explanation: '被篡改的图后说明'
        });
        fs.writeFileSync(resultFile, JSON.stringify(payload));
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /imageManifest\.selectionEvidenceSha256 闭环校验失败/);
    });

    it('papers.json 拒绝 key-ID 冲突和规范化重复映射', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-paper-map-'));
        const papersFile = path.join(dir, 'papers.json');
        fs.writeFileSync(papersFile, JSON.stringify({
            papers: {
                '2607.10001': { arxivId: '2607.10002' },
                '2607.20001v1': { arxivId: '2607.20001v1' },
                '2607.20001v2': { arxivId: '2607.20001v2' }
            }
        }));

        const issues = validatePapersDatabase(papersFile).join('\n');
        assert.match(issues, /对象 key 与论文 ID 冲突/);
        assert.match(issues, /归一化为重复 ID: 2607\.20001/);
    });

    it('论文列表拒绝版本号差异造成的规范化重复 ID', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-paper-list-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [
                completeAnalysisPaper('2607.30001v1'),
                completeAnalysisPaper('2607.30001v2')
            ]
        }));

        assert.match(
            validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n'),
            /归一化为重复 ID: 2607\.30001/
        );
    });

    it('无 stats 的深度分析对象仍校验 terminal 状态与完成时间', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-deep-metadata-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultFile, JSON.stringify({
            status: 'complete',
            deepAnalysisCompletedAt: '2026-07-13T10:00:00.000+08:00',
            papers: [{ arxivId: '2607.31001', analysis: null, error: 'failed' }]
        }));

        assert.match(
            validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n'),
            /status \(complete\) 与 canonical 论文状态 \(failed\) 不一致/
        );
    });

    it('跨文件校验 complete filtered 与 deep 的批次和 ID 精确一致', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-cross-ids-'));
        const filteredPapers = path.join(dir, 'filtered-papers.json');
        const deepAnalysisResult = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(filteredPapers, JSON.stringify({
            batchDate: '2026-07-13',
            status: 'complete',
            papers: [{ arxivId: '2607.32001' }, { arxivId: '2607.32002' }]
        }));
        fs.writeFileSync(deepAnalysisResult, JSON.stringify({
            batchDate: '2026-07-12',
            papers: [completeAnalysisPaper('2607.32001'), completeAnalysisPaper('2607.32999')]
        }));

        const issues = validateFilteredDeepPapersConsistency({
            filteredPapers,
            deepAnalysisResult,
            papers: path.join(dir, 'missing-papers.json')
        }).join('\n');
        assert.match(issues, /batchDate \(2026-07-12\).*2026-07-13/);
        assert.match(issues, /缺少 2607\.32002；多出 2607\.32999/);
    });

    it('跨文件校验 papers 数据库批次和深度分析最新状态，并兼容旧成功正文', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-cross-status-'));
        const filteredPapers = path.join(dir, 'filtered-papers.json');
        const deepAnalysisResult = path.join(dir, 'deep-analysis-result.json');
        const papers = path.join(dir, 'papers.json');
        fs.writeFileSync(filteredPapers, JSON.stringify({
            batchDate: '2026-07-13',
            status: 'complete',
            papers: [{ arxivId: '2607.33001' }, { arxivId: '2607.33002' }]
        }));
        fs.writeFileSync(deepAnalysisResult, JSON.stringify({
            batchDate: '2026-07-13',
            papers: [
                completeAnalysisPaper('2607.33001'),
                { arxivId: '2607.33002', analysis: null, error: 'temporary failure' }
            ]
        }));
        fs.writeFileSync(papers, JSON.stringify({
            papers: {
                '2607.33001': {
                    arxivId: '2607.33001',
                    digestStatus: { status: 'analysis_failed', batchDate: '2026-07-12' }
                },
                '2607.33002': {
                    arxivId: '2607.33002',
                    digestStatus: {
                        status: 'analyzed',
                        latestAttemptStatus: 'analysis_failed',
                        batchDate: '2026-07-13'
                    }
                }
            }
        }));

        const issues = validateFilteredDeepPapersConsistency({
            filteredPapers,
            deepAnalysisResult,
            papers
        }).join('\n');
        assert.match(issues, /2607\.33001 的批次日期 \(2026-07-12\)/);
        assert.match(issues, /2607\.33001 深度分析成功，但 digestStatus\.status 不是 analyzed/);
        assert.doesNotMatch(issues, /2607\.33002/);
    });

    it('跨文件校验 papers 数据库不能缺少 filtered 论文', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-cross-missing-'));
        const filteredPapers = path.join(dir, 'filtered-papers.json');
        const deepAnalysisResult = path.join(dir, 'deep-analysis-result.json');
        const papers = path.join(dir, 'papers.json');
        fs.writeFileSync(filteredPapers, JSON.stringify({
            batchDate: '2026-07-13',
            status: 'complete',
            papers: [{ arxivId: '2607.34001' }]
        }));
        fs.writeFileSync(deepAnalysisResult, JSON.stringify({
            batchDate: '2026-07-13',
            papers: [completeAnalysisPaper('2607.34001')]
        }));
        fs.writeFileSync(papers, JSON.stringify({ papers: {} }));

        assert.match(
            validateFilteredDeepPapersConsistency({ filteredPapers, deepAnalysisResult, papers }).join('\n'),
            /缺少 filtered-papers\.json 论文 ID: 2607\.34001/
        );
    });

    it('报告非法 digestStatus 和图片字段', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const papersFile = path.join(dir, 'papers.json');
        const resultFile = path.join(dir, 'deep-analysis-result.json');

        fs.writeFileSync(papersFile, JSON.stringify({
            papers: {
                bad: {
                    arxivId: '2607.00001',
                    digestStatus: {
                        status: 'done',
                        latestAttemptStatus: 'pending_analysis',
                        error: { message: 'timeout' }
                    }
                }
            }
        }));
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00001',
                parsed: { score: 11 },
                selectedImageUrls: 'not-array'
            }]
        }));

        const paperIssues = validatePapersDatabase(papersFile).join('\n');
        assert.match(paperIssues, /digestStatus\.status/);
        assert.match(paperIssues, /digestStatus\.latestAttemptStatus/);
        assert.match(paperIssues, /digestStatus\.error/);
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /parsed\.score/);
        assert.match(issues, /selectedImageUrls/);
    });

    it('报告非法文档类型、评分版本、分项越界和总分不一致', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00001',
                scoringRubricVersion: 'future-v9',
                parsed: {
                    score: 9.9,
                    documentType: '宣传稿',
                    scoringRubricVersion: 'future-v9',
                    innovationScore: 3,
                    technicalRigorScore: 1.2,
                    experimentalSufficiencyScore: 1.1,
                    clarityScore: 0.8,
                    impactScore: 1.0,
                    openSourceScore: 1.2,
                    reproducibilityScore: 0.3,
                    engineeringScore: 1.4
                }
            }, {
                arxivId: '2607.00002',
                scoringRubricVersion: 'type-aware-v1',
                parsed: {
                    score: 9.9,
                    documentType: '方法研究',
                    scoringRubricVersion: 'type-aware-v1',
                    innovationScore: 1.5,
                    technicalRigorScore: 1.2,
                    experimentalSufficiencyScore: 1.1,
                    clarityScore: 0.8,
                    impactScore: 1.0,
                    openSourceScore: 1.2,
                    reproducibilityScore: 0.3,
                    engineeringScore: 1.4
                }
            }]
        }));

        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /documentType 非法/);
        assert.match(issues, /scoringRubricVersion 非法/);
        assert.match(issues, /innovationScore 非法/);
        assert.match(issues, /八项合计封顶结果/);
    });

    it('报告评分缓存缺项、非有限数、负数和开源矛盾', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00001',
                parsed: {
                    score: 'NaN',
                    innovationScore: -0.1,
                    technicalRigorScore: 1.2,
                    experimentalSufficiencyScore: 1.1,
                    clarityScore: 0.8,
                    impactScore: 1.0,
                    openSourceScore: 1.2,
                    reproducibilityScore: 0.3,
                    engineeringScore: null,
                    hasCode: '否',
                    hasModel: '否',
                    hasDataset: '否'
                }
            }]
        }));

        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /parsed\.score 非法/);
        assert.match(issues, /innovationScore 非法/);
        assert.match(issues, /engineeringScore 非法/);
        assert.match(issues, /但无代码、模型或数据资源/);
    });

    it('校验可恢复分析 manifest 的阶段状态', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-manifest-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00002',
                parsed: {
                    score: '0.0',
                    innovationScore: '0.0',
                    technicalRigorScore: '0.0',
                    experimentalSufficiencyScore: '0.0',
                    clarityScore: '0.0',
                    impactScore: '0.0',
                    openSourceScore: '0.0',
                    reproducibilityScore: '0.0',
                    engineeringScore: '0.0',
                    hasCode: '否', hasModel: '否', hasDataset: '否'
                },
                analysisManifest: {
                    version: 1,
                    stages: {
                        revision: { status: 'transient_failure', error: 'timeout', updatedAt: 123 },
                        imageSupplement: { status: 'empty_plan' }
                    }
                }
            }]
        }));
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /updatedAt 必须是字符串/);
        assert.match(issues, /status 非法: empty_plan/);
    });

    it('重解析分析正文并拒绝陈旧缓存、未完成阶段和最新失败标记', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-analysis-contract-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        const analysis = validAnalysisText();
        const staleParsed = { ...parseAnalysis(analysis), score: '9.9' };
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00003',
                analysis,
                parsed: staleParsed,
                latestAnalysisAttemptError: 'latest retry timed out',
                analysisManifest: {
                    version: 1,
                    stages: {
                        imageDownload: { status: 'complete' },
                        primaryAnalysis: { status: 'complete' }
                    }
                }
            }]
        }));

        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /parsed 缓存与 analysis 重解析不一致: score/);
        assert.match(issues, /缺少完成态阶段 openSourceScan/);
        assert.match(issues, /最新分析尝试仍为失败/);
    });

    it('只对带 bounded-v1 标记的新结果强制实验表格硬契约', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-table-contract-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        const rows = Array.from({ length: 13 }, (_, index) => `| Model ${index + 1} | ${index} |`).join('\n');
        const analysis = validAnalysisText().replace(
            '\n## 细节详述',
            `\n\n| 方法 | WER |\n| --- | --- |\n${rows}\n\n## 细节详述`
        );
        const stages = Object.fromEntries([
            'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
            'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
        ].map(stage => [stage, {
            status: stage === 'imageSupplement' ? 'no_candidates' : 'complete'
        }]));
        const paper = {
            arxivId: '2607.00004',
            analysis,
            parsed: parseAnalysis(analysis),
            scoringRubricVersion: 'type-aware-v1',
            analysisManifest: {
                version: 1,
                contracts: { experimentTables: EXPERIMENT_TABLE_CONTRACT_VERSION },
                stages
            }
        };
        fs.writeFileSync(resultFile, JSON.stringify({ papers: [paper] }));
        assert.match(
            validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n'),
            /表格契约无效.*13 个数据行/
        );

        delete paper.analysisManifest.contracts;
        fs.writeFileSync(resultFile, JSON.stringify({ papers: [paper] }));
        assert.deepStrictEqual(validatePaperListFile(resultFile, { deepAnalysis: true }), []);
    });

    it('校验阶段专属终态、detailed-v1 方法契约和顶层状态一致性', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-method-status-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        const analysis = validAnalysisText();
        const stages = Object.fromEntries([
            'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
            'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
        ].map(stage => [stage, { status: 'complete' }]));
        stages.primaryAnalysis.status = 'skipped';
        fs.writeFileSync(resultFile, JSON.stringify({
            status: 'partial_failed',
            deepAnalysisCompletedAt: TIMESTAMP,
            stats: { analysisStatus: 'complete' },
            papers: [{
                arxivId: '2607.00005', analysis, parsed: parseAnalysis(analysis),
                scoringRubricVersion: 'type-aware-v1',
                analysisManifest: {
                    version: 1,
                    contracts: { methodDetail: METHOD_DETAIL_CONTRACT_VERSION },
                    stages
                }
            }]
        }));
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /primaryAnalysis 尚未完成: skipped/);
        assert.match(issues, /方法契约无效.*中文字符不足/);
        assert.match(issues, /status \(partial_failed\) 与 stats\.analysisStatus \(complete\) 不一致/);
        assert.match(issues, /非 complete 状态不得保留 deepAnalysisCompletedAt/);
        assert.match(issues, /status \(partial_failed\) 与 canonical 论文状态 \(failed\) 不一致/);

        stages.primaryAnalysis.status = 'complete';
        fs.writeFileSync(resultFile, JSON.stringify({
            status: 'complete',
            stats: { analysisStatus: 'complete', remainingFailed: 1 },
            papers: [{
                arxivId: '2607.00005', analysis, parsed: parseAnalysis(analysis),
                scoringRubricVersion: 'type-aware-v1',
                analysisManifest: { version: 1, stages }
            }]
        }));
        const remainingIssues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(
            remainingIssues,
            /stats\.remainingFailed \(1\) 与 canonical 未完成数 \(0\) 不一致/
        );
    });

    it('接受字段集合精确匹配且来源完整的人工 parsed 覆盖', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-manual-override-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        const analysis = validAnalysisText();
        const parsed = {
            ...parseAnalysis(analysis),
            innovationScore: '1.4',
            score: '6.8'
        };
        const stages = Object.fromEntries([
            'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
            'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement'
        ].map(stage => [stage, { status: 'complete' }]));
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00004',
                analysis,
                parsed,
                scoringRubricVersion: 'type-aware-v1',
                parsedOverride: {
                    type: 'manual',
                    source: 'editor:review-2026-07-31',
                    reason: '人工复核创新性证据后调整',
                    fields: ['innovationScore', 'score']
                },
                analysisManifest: { version: 1, stages }
            }]
        }));

        assert.deepStrictEqual(validatePaperListFile(resultFile, { deepAnalysis: true }), []);
    });

    it('理论研究公开证明材料不会被资源字段矛盾检查误报', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-theory-'));
        const resultFile = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00002',
                parsed: {
                    score: 7.2,
                    documentType: '理论研究',
                    scoringRubricVersion: 'type-aware-v1',
                    innovationScore: 1.5,
                    technicalRigorScore: 1.2,
                    experimentalSufficiencyScore: 1.1,
                    clarityScore: 0.8,
                    impactScore: 1.0,
                    openSourceScore: 1.2,
                    reproducibilityScore: 0.4,
                    engineeringScore: 0,
                    hasCode: '否', hasModel: '否', hasDataset: '否'
                }
            }]
        }));

        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.doesNotMatch(issues, /但无代码、模型或数据资源/);
    });

    it('接受合法筛选结果和逐篇筛选决策缓存', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const rawCandidatesFile = path.join(dir, 'raw-candidates.json');
        const filteredFile = path.join(dir, 'filtered-papers.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');
        const checkpointFile = path.join(dir, 'fetch-checkpoint.json');
        writeCompleteCheckpoint(checkpointFile);
        const checkpoint = JSON.parse(fs.readFileSync(checkpointFile));
        const rawPapers = [
            { arxivId: '2607.00001', sources: ['arxiv'] },
            { arxivId: '2607.00002', sources: ['huggingface'] },
            { arxivId: '2607.00003', sources: ['arxiv'] }
        ];
        const integrity = {
            batchDate: '2026-07-13', batchId: BATCH_ID,
            rawPapersSha256: papersSha256(rawPapers), fetchSourcesSha256: checkpoint.fetchSourcesSha256
        };

        fs.writeFileSync(rawCandidatesFile, JSON.stringify({
            timestamp: TIMESTAMP,
            ...integrity,
            candidateFingerprint: CANDIDATE_FP,
            sourceConfigFingerprint: SOURCE_FP,
            blogDedupFingerprint: BLOG_FP,
            stats: {
                beforeBlogSkip: 3,
                afterBlogSkip: 3,
                skippedFromBlog: 0,
                arxivOnly: 1,
                hfOnly: 1,
                both: 1
            },
            sourceHealth: {
                arxiv: { categories: Config.ARXIV_CATEGORIES.map(({ id }) => ({ id, ok: true })) },
                huggingface: { ok: true }
            },
            papers: rawPapers
        }));
        fs.writeFileSync(filteredFile, JSON.stringify({
            timestamp: TIMESTAMP,
            ...integrity,
            candidateFingerprint: CANDIDATE_FP,
            sourceConfigFingerprint: SOURCE_FP,
            blogDedupFingerprint: BLOG_FP,
            status: 'complete',
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            filterConfigFingerprint: FILTER_FP,
            stats: {
                afterBlogSkip: 3,
                afterFilter: 2,
                afterArchiveSkip: 1,
                skippedFromArchive: 1,
                decisionCount: 3
            },
            excludedRelatedIds: ['2607.00002'],
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            timestamp: TIMESTAMP,
            ...integrity,
            candidateFingerprint: CANDIDATE_FP,
            sourceConfigFingerprint: SOURCE_FP,
            blogDedupFingerprint: BLOG_FP,
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            filterConfigFingerprint: FILTER_FP,
            stats: {
                totalCandidates: 3,
                decided: 3,
                related: 2,
                complete: true
            },
            decisions: {
                '2607.00001': { id: '2607.00001', related: true, reason: 'audio', parseSource: 'conclusion_line', inputSha256: filterInputSha256(rawPapers[0]) },
                '2607.00002': { id: '2607.00002', related: true, reason: 'audio', parseSource: 'conclusion_line', inputSha256: filterInputSha256(rawPapers[1]) },
                '2607.00003': { id: '2607.00003', related: false, reason: 'irrelevant', parseSource: 'conclusion_line', inputSha256: filterInputSha256(rawPapers[2]) }
            }
        }));

        assert.deepStrictEqual(validatePaperListFile(rawCandidatesFile, { rawCandidates: true }), []);
        assert.deepStrictEqual(validatePaperListFile(filteredFile, { filtered: true }), []);
        assert.deepStrictEqual(validateFilterDecisionsFile(decisionsFile), []);
        assert.deepStrictEqual(validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            rawCandidates: rawCandidatesFile,
            filteredPapers: filteredFile,
            filterDecisions: decisionsFile,
            fetchCheckpoint: checkpointFile,
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }), []);
    });

    it('filtered 标记 complete 时来源不完整仍会被四件套门禁拒绝', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-incomplete-source-'));
        const files = writeMinimalCurrentBatch(dir);
        const raw = JSON.parse(fs.readFileSync(files.rawCandidates));
        raw.sourceHealth.arxiv.categories = raw.sourceHealth.arxiv.categories.slice(0, -1);
        raw.sourceHealth.huggingface.ok = false;
        fs.writeFileSync(files.rawCandidates, JSON.stringify(raw));

        const issues = validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            rawCandidates: files.rawCandidates,
            filteredPapers: files.filteredPapers,
            filterDecisions: files.filterDecisions,
            fetchCheckpoint: files.fetchCheckpoint,
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }).join('\n');

        assert.match(issues, /七个 arXiv 类别和 HuggingFace sourceHealth 全部 ok=true/);
    });

    it('健康空 arXiv checkpoint 可满足 complete 产物契约但不承诺跨进程复用', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-empty-source-'));
        const files = writeMinimalCurrentBatch(dir);
        const checkpoint = JSON.parse(fs.readFileSync(files.fetchCheckpoint));
        const emptyCategory = Config.ARXIV_CATEGORIES[0].id;
        checkpoint.arxiv[emptyCategory] = checkpointEntry([], { id: emptyCategory, ok: true });
        checkpoint.fetchSourcesSha256 = fetchSourcesSha256(checkpoint);
        fs.writeFileSync(files.fetchCheckpoint, JSON.stringify(checkpoint));
        for (const artifactPath of [files.rawCandidates, files.filterDecisions, files.filteredPapers]) {
            const artifact = JSON.parse(fs.readFileSync(artifactPath));
            artifact.fetchSourcesSha256 = checkpoint.fetchSourcesSha256;
            fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        }

        assert.deepStrictEqual(validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            rawCandidates: files.rawCandidates,
            filteredPapers: files.filteredPapers,
            filterDecisions: files.filterDecisions,
            fetchCheckpoint: files.fetchCheckpoint,
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }), []);
    });

    it('filtered 标记 complete 时缺少 raw/decisions companion 会失败', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-missing-companion-'));
        const files = writeMinimalCurrentBatch(dir);
        fs.unlinkSync(files.rawCandidates);
        fs.unlinkSync(files.filterDecisions);

        const issues = validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            rawCandidates: files.rawCandidates,
            filteredPapers: files.filteredPapers,
            filterDecisions: files.filterDecisions,
            fetchCheckpoint: files.fetchCheckpoint,
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }).join('\n');

        assert.match(issues, /complete filtered-papers\.json 必须有同批次 raw-candidates\.json/);
        assert.match(issues, /complete filtered-papers\.json 必须有同批次 filter-decisions\.json/);
    });

    it('报告候选输入统计和来源健康问题', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const rawCandidatesFile = path.join(dir, 'raw-candidates.json');
        const rawCandidatesArrayFile = path.join(dir, 'raw-candidates-array.json');

        fs.writeFileSync(rawCandidatesFile, JSON.stringify({
            stats: {
                beforeBlogSkip: 1,
                afterBlogSkip: 2,
                skippedFromBlog: 4,
                arxivOnly: 1,
                hfOnly: 1,
                both: 0
            },
            sourceHealth: {
                arxiv: { categories: 'bad' },
                huggingface: { ok: 'yes' }
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(rawCandidatesArrayFile, JSON.stringify([{ arxivId: '2607.00002' }]));

        const issues = validatePaperListFile(rawCandidatesFile, { rawCandidates: true }).join('\n');
        assert.match(issues, /sourceHealth\.arxiv\.categories/);
        assert.match(issues, /sourceHealth\.huggingface\.ok/);
        assert.match(issues, /stats\.afterBlogSkip/);
        assert.match(issues, /stats\.beforeBlogSkip 不能小于/);
        assert.match(issues, /stats\.skippedFromBlog/);
        assert.match(issues, /stats\.arxivOnly\+hfOnly\+both/);

        const arrayIssues = validatePaperListFile(rawCandidatesArrayFile, { rawCandidates: true }).join('\n');
        assert.match(arrayIssues, /raw-candidates 根对象/);
    });

    it('报告筛选状态、决策缓存和交叉计数问题', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const filteredFile = path.join(dir, 'filtered-papers.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');

        fs.writeFileSync(filteredFile, JSON.stringify({
            status: 'done',
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            stats: {
                afterBlogSkip: 3,
                afterFilter: 2,
                afterArchiveSkip: 2,
                decisionCount: 2
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            stats: {
                totalCandidates: 4,
                decided: 2,
                related: 2,
                complete: 'yes'
            },
            filterModel: 'model-b',
            filterPromptHash: 'hash-b',
            decisions: {
                '2607.00001': { id: '2607.00001', related: true, reason: 'audio' }
            }
        }));

        const filteredIssues = validatePaperListFile(filteredFile, { filtered: true }).join('\n');
        assert.match(filteredIssues, /status 非法/);

        const decisionIssues = validateFilterDecisionsFile(decisionsFile).join('\n');
        assert.match(decisionIssues, /stats\.complete/);
        assert.match(decisionIssues, /stats\.decided/);
        assert.match(decisionIssues, /stats\.related/);

        const allIssues = validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            filteredPapers: filteredFile,
            filterDecisions: decisionsFile,
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }).join('\n');
        assert.match(allIssues, /filterModel/);
        assert.match(allIssues, /filterPromptHash/);
        assert.match(allIssues, /stats\.afterBlogSkip/);
        assert.match(allIssues, /stats\.decisionCount/);
        assert.match(allIssues, /stats\.afterFilter/);
        assert.match(allIssues, /raw-candidates\.json 缺失/);
    });

    it('报告 raw-candidates 与 filter-decisions 覆盖不一致', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const rawCandidatesFile = path.join(dir, 'raw-candidates.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');

        fs.writeFileSync(rawCandidatesFile, JSON.stringify({
            stats: {
                beforeBlogSkip: 2,
                afterBlogSkip: 2,
                skippedFromBlog: 0,
                arxivOnly: 2,
                hfOnly: 0,
                both: 0
            },
            papers: [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            stats: {
                totalCandidates: 3,
                decided: 1,
                related: 1,
                complete: true
            },
            decisions: {
                '2607.00001': { id: '2607.00001', related: true, reason: 'audio' }
            }
        }));

        const issues = validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            rawCandidates: rawCandidatesFile,
            filterDecisions: decisionsFile,
            filteredPapers: path.join(dir, 'missing-filtered.json'),
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }).join('\n');

        assert.match(issues, /stats\.afterBlogSkip/);
        assert.match(issues, /complete=true 时 decisions 数量/);
        assert.match(issues, /缺少 raw-candidates\.json papers\[1\]/);
    });

    it('报告缺少筛选复用元数据、决策缓存和深度分析统计问题', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const filteredFile = path.join(dir, 'filtered-papers.json');
        const resultFile = path.join(dir, 'deep-analysis-result.json');

        fs.writeFileSync(filteredFile, JSON.stringify({
            status: 'complete',
            stats: {
                afterFilter: 1,
                afterArchiveSkip: 1,
                decisionCount: 1
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(resultFile, JSON.stringify({
            stats: {
                totalAfterMerge: 2
            },
            papers: [{ arxivId: '2607.00001' }]
        }));

        const filteredIssues = validatePaperListFile(filteredFile, { filtered: true }).join('\n');
        assert.match(filteredIssues, /filterModel/);
        assert.match(filteredIssues, /filterPromptHash/);

        const resultIssues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(resultIssues, /stats\.totalAfterMerge/);

        const allIssues = validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            filteredPapers: filteredFile,
            filterDecisions: path.join(dir, 'missing-filter-decisions.json'),
            deepAnalysisResult: resultFile
        }).join('\n');
        assert.match(allIssues, /filter-decisions\.json 缺失/);
    });
});

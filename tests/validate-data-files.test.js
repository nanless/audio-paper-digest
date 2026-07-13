const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Config = require('../scripts/config.js');

const {
    validatePapersDatabase,
    validateFetchCheckpointFile,
    validatePaperListFile,
    validateFilterDecisionsFile,
    validateCurrentDataFiles
} = require('../scripts/validate-data-files.js');

const TIMESTAMP = '2026-07-13T10:00:00.000+08:00';
const CANDIDATE_FP = 'a'.repeat(16);
const SOURCE_FP = 'b'.repeat(16);
const BLOG_FP = 'c'.repeat(16);
const FILTER_FP = 'd'.repeat(16);

function papersSha256(papers) {
    return crypto.createHash('sha256').update(JSON.stringify(papers)).digest('hex');
}

function checkpointEntry(papers, health, status = 'complete') {
    return { status, papers, papersCount: papers.length, papersSha256: papersSha256(papers), health };
}

function writeCompleteCheckpoint(filePath) {
    const categoryOrder = Config.ARXIV_CATEGORIES.map(category => category.id);
    fs.writeFileSync(filePath, JSON.stringify({
        timestamp: TIMESTAMP,
        candidateFingerprint: CANDIDATE_FP,
        sourceConfigFingerprint: SOURCE_FP,
        blogDedupFingerprint: BLOG_FP,
        historicalDedupIds: [],
        categoryOrder,
        arxiv: Object.fromEntries(categoryOrder.map(id => [id, checkpointEntry([], { id, ok: true })])),
        huggingface: checkpointEntry([], { ok: true })
    }));
}

function writeMinimalCurrentBatch(dir) {
    const fetchCheckpoint = path.join(dir, 'fetch-checkpoint.json');
    const rawCandidates = path.join(dir, 'raw-candidates.json');
    const filterDecisions = path.join(dir, 'filter-decisions.json');
    const filteredPapers = path.join(dir, 'filtered-papers.json');
    writeCompleteCheckpoint(fetchCheckpoint);
    const fingerprints = {
        candidateFingerprint: CANDIDATE_FP,
        sourceConfigFingerprint: SOURCE_FP,
        blogDedupFingerprint: BLOG_FP
    };
    fs.writeFileSync(rawCandidates, JSON.stringify({
        timestamp: TIMESTAMP, ...fingerprints,
        stats: { beforeBlogSkip: 1, afterBlogSkip: 1, skippedFromBlog: 0, arxivOnly: 1, hfOnly: 0, both: 0 },
        sourceHealth: {
            arxiv: { categories: Config.ARXIV_CATEGORIES.map(({ id }) => ({ id, ok: true })) },
            huggingface: { ok: true }
        },
        papers: [{ arxivId: '2607.00001' }]
    }));
    fs.writeFileSync(filterDecisions, JSON.stringify({
        timestamp: TIMESTAMP, ...fingerprints, filterModel: 'model-a', filterPromptHash: 'hash-a',
        filterConfigFingerprint: FILTER_FP,
        stats: { totalCandidates: 1, decided: 1, related: 1, complete: true },
        decisions: { '2607.00001': { related: true } }
    }));
    fs.writeFileSync(filteredPapers, JSON.stringify({
        timestamp: TIMESTAMP, ...fingerprints, filterModel: 'model-a', filterPromptHash: 'hash-a',
        filterConfigFingerprint: FILTER_FP, status: 'complete',
        stats: { afterBlogSkip: 1, afterFilter: 1, afterArchiveSkip: 1, decisionCount: 1 },
        papers: [{ arxivId: '2607.00001' }]
    }));
    return { fetchCheckpoint, rawCandidates, filterDecisions, filteredPapers };
}

describe('validate-data-files', () => {
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
                analysis: 'ok',
                scoringRubricVersion: 'type-aware-v1',
                parsed: {
                    score: 8.5,
                    documentType: '系统技术报告',
                    scoringRubricVersion: 'type-aware-v1',
                    innovationScore: 1.5,
                    technicalRigorScore: 1.2,
                    experimentalSufficiencyScore: 1.1,
                    clarityScore: 0.8,
                    impactScore: 1.0,
                    openSourceScore: 1.2,
                    reproducibilityScore: 0.3,
                    engineeringScore: 1.4,
                    hasCode: '是',
                    hasModel: '否',
                    hasDataset: '否'
                },
                selectedImageUrls: [],
                imageManifest: { selected: [] }
            }]
        }));

        assert.deepStrictEqual(validatePapersDatabase(papersFile), []);
        assert.deepStrictEqual(validatePaperListFile(resultFile, { deepAnalysis: true }), []);
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

        fs.writeFileSync(rawCandidatesFile, JSON.stringify({
            timestamp: TIMESTAMP,
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
            papers: [
                { arxivId: '2607.00001' },
                { arxivId: '2607.00002' },
                { arxivId: '2607.00003' }
            ]
        }));
        fs.writeFileSync(filteredFile, JSON.stringify({
            timestamp: TIMESTAMP,
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
                decisionCount: 3
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            timestamp: TIMESTAMP,
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
                '2607.00001': { id: '2607.00001', related: true, reason: 'audio', parseSource: 'conclusion_line' },
                '2607.00002': { id: '2607.00002', related: true, reason: 'audio', parseSource: 'conclusion_line' },
                '2607.00003': { id: '2607.00003', related: false, reason: 'irrelevant', parseSource: 'conclusion_line' }
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

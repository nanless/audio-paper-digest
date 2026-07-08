const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    validatePapersDatabase,
    validatePaperListFile,
    validateFilterDecisionsFile,
    validateCurrentDataFiles
} = require('../scripts/validate-data-files.js');

describe('validate-data-files', () => {
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
                parsed: { score: 8.5 },
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
                bad: { arxivId: '2607.00001', digestStatus: { status: 'done' } }
            }
        }));
        fs.writeFileSync(resultFile, JSON.stringify({
            papers: [{
                arxivId: '2607.00001',
                parsed: { score: 11 },
                selectedImageUrls: 'not-array'
            }]
        }));

        assert.match(validatePapersDatabase(papersFile).join('\n'), /digestStatus\.status/);
        const issues = validatePaperListFile(resultFile, { deepAnalysis: true }).join('\n');
        assert.match(issues, /parsed\.score/);
        assert.match(issues, /selectedImageUrls/);
    });

    it('接受合法筛选结果和逐篇筛选决策缓存', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const rawCandidatesFile = path.join(dir, 'raw-candidates.json');
        const filteredFile = path.join(dir, 'filtered-papers.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');

        fs.writeFileSync(rawCandidatesFile, JSON.stringify({
            stats: {
                beforeBlogSkip: 3,
                afterBlogSkip: 1,
                skippedFromBlog: 2,
                arxivOnly: 1,
                hfOnly: 1,
                both: 1
            },
            sourceHealth: {
                arxiv: { categories: [{ id: 'cs.SD', ok: true }] },
                huggingface: { ok: true }
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(filteredFile, JSON.stringify({
            status: 'complete',
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            stats: {
                afterFilter: 2,
                afterArchiveSkip: 1,
                decisionCount: 3
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
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
                afterFilter: 2,
                afterArchiveSkip: 2,
                decisionCount: 2
            },
            papers: [{ arxivId: '2607.00001' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            stats: {
                decided: 2,
                related: 2,
                complete: 'yes'
            },
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
        assert.match(allIssues, /stats\.decisionCount/);
        assert.match(allIssues, /stats\.afterFilter/);
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

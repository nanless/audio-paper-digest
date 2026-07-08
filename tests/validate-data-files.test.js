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
        const filteredFile = path.join(dir, 'filtered-papers.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');

        fs.writeFileSync(filteredFile, JSON.stringify({
            status: 'complete',
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

        assert.deepStrictEqual(validatePaperListFile(filteredFile, { filtered: true }), []);
        assert.deepStrictEqual(validateFilterDecisionsFile(decisionsFile), []);
        assert.deepStrictEqual(validateCurrentDataFiles({
            papers: path.join(dir, 'missing-papers.json'),
            filteredPapers: filteredFile,
            filterDecisions: decisionsFile,
            deepAnalysisResult: path.join(dir, 'missing-analysis.json')
        }), []);
    });

    it('报告筛选状态、决策缓存和交叉计数问题', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-validate-'));
        const filteredFile = path.join(dir, 'filtered-papers.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');

        fs.writeFileSync(filteredFile, JSON.stringify({
            status: 'done',
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
});

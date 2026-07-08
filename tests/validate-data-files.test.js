const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    validatePapersDatabase,
    validatePaperListFile
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
});

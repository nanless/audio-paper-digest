const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mergeAndSaveResults } = require('../scripts/analysis-engine.js');

describe('mergeAndSaveResults', () => {
    it('不会用无 analysis 的失败结果覆盖已有成功结果', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-test-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-01-01T00:00:00.000+08:00',
            papers: [{
                arxivId: '2604.12345v1',
                title: 'Existing success',
                analysis: 'successful analysis',
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
        assert.strictEqual(saved.papers[0].analysis, 'successful analysis');
        assert.deepStrictEqual(saved.papers[0].parsed, { score: '8.0' });
    });
});

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    updateAnalysisDigestStatuses
} = require('../scripts/digest-status.js');

describe('digest status helpers', () => {
    it('将深度分析成功和失败状态回写到 papers.json', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-status-'));
        const file = path.join(dir, 'papers.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: {
                '2607.00001': {
                    arxivId: '2607.00001',
                    title: 'Old title',
                    digestStatus: { status: 'pending_analysis' }
                }
            },
            lastUpdated: '2026-07-08T00:00:00+08:00'
        }, null, 2));

        const result = updateAnalysisDigestStatuses([
            { arxivId: '2607.00001v2', title: 'Analyzed paper', analysis: 'ok' },
            { arxivId: '2607.00002', title: 'Failed paper', analysis: null, error: 'timeout' }
        ], {
            filePath: file,
            legacyPath: path.join(dir, 'missing.json'),
            batchDate: '2026-07-08',
            updatedAt: '2026-07-08T12:00:00+08:00'
        });

        assert.strictEqual(result.updated, 2);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.papers['2607.00001'].digestStatus.status, 'analyzed');
        assert.strictEqual(saved.papers['2607.00001'].digestStatus.batchDate, '2026-07-08');
        assert.strictEqual(saved.papers['2607.00002'].digestStatus.status, 'analysis_failed');
        assert.strictEqual(saved.papers['2607.00002'].digestStatus.error, 'timeout');
    });
});

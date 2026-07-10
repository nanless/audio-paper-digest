const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    validAnalysisText,
    validAnalysisPaper: validAnalysisRecord
} = require('./valid-analysis-fixture.js');

const {
    markPaperDigestStatus,
    mergePapersDatabases,
    mergeAnalysisDigestPaper,
    applyAnalysisDigestStatuses,
    updateAnalysisDigestStatuses
} = require('../scripts/digest-status.js');

describe('digest status helpers', () => {
    it('统一生成 digestStatus 元数据', () => {
        const paper = markPaperDigestStatus(
            { arxivId: '2607.00001', digestStatus: { filterModel: 'm1' } },
            'pending_analysis',
            { batchDate: '2026-07-08', updatedAt: '2026-07-08T12:00:00+08:00' }
        );

        assert.strictEqual(paper.digestStatus.status, 'pending_analysis');
        assert.strictEqual(paper.digestStatus.filterModel, 'm1');
        assert.strictEqual(paper.digestStatus.batchDate, '2026-07-08');
        assert.strictEqual(paper.digestStatus.updatedAt, '2026-07-08T12:00:00+08:00');
    });

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
            validAnalysisRecord('2607.00001v2', { title: 'Analyzed paper' }),
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
        assert.strictEqual(saved.papers['2607.00001'].digestStatus.latestAttemptStatus, 'analyzed');
        assert.strictEqual(saved.papers['2607.00001'].digestStatus.batchDate, '2026-07-08');
        assert.strictEqual(saved.papers['2607.00002'].digestStatus.status, 'analysis_failed');
        assert.strictEqual(saved.papers['2607.00002'].digestStatus.latestAttemptStatus, 'analysis_failed');
        assert.strictEqual(saved.papers['2607.00002'].digestStatus.error, 'timeout');
    });

    it('失败状态回写不会抹掉已有成功分析内容', () => {
        const merged = mergeAnalysisDigestPaper(
            {
                arxivId: '2607.00001',
                analysis: validAnalysisText(),
                parsed: { score: 8.2 },
                selectedImageUrls: ['https://example.com/fig.png'],
                imageManifest: { selected: ['fig'] }
            },
            {
                arxivId: '2607.00001',
                analysis: null,
                parsed: null,
                selectedImageUrls: [],
                imageManifest: null,
                error: 'timeout'
            }
        );

        assert.strictEqual(merged.analysis, validAnalysisText());
        assert.deepStrictEqual(merged.parsed, { score: 8.2 });
        assert.deepStrictEqual(merged.selectedImageUrls, ['https://example.com/fig.png']);
        assert.deepStrictEqual(merged.imageManifest, { selected: ['fig'] });
        assert.strictEqual(merged.error, 'timeout');
    });

    it('新一次分析失败但旧分析仍可用时主状态保持 analyzed', () => {
        const papersData = {
            papers: {
                '2607.00001': {
                    arxivId: '2607.00001',
                    analysis: validAnalysisText(),
                    parsed: { score: 8.0 },
                    digestStatus: { status: 'analyzed' }
                }
            }
        };

        const updated = applyAnalysisDigestStatuses(papersData, [
            { arxivId: '2607.00001', analysis: null, error: 'timeout' }
        ], {
            batchDate: '2026-07-08',
            updatedAt: '2026-07-08T12:00:00+08:00'
        });

        assert.strictEqual(updated, 1);
        assert.strictEqual(papersData.papers['2607.00001'].analysis, validAnalysisText());
        assert.strictEqual(papersData.papers['2607.00001'].digestStatus.status, 'analyzed');
        assert.strictEqual(papersData.papers['2607.00001'].digestStatus.latestAttemptStatus, 'analysis_failed');
        assert.strictEqual(papersData.papers['2607.00001'].digestStatus.error, 'timeout');
    });

    it('旧的损坏 analysis 不会让失败尝试被标记 analyzed', () => {
        const papersData = {
            papers: {
                '2607.00003': {
                    arxivId: '2607.00003',
                    analysis: 'old truncated body',
                    parsed: { score: 9.9 },
                    digestStatus: { status: 'analyzed' }
                }
            }
        };
        applyAnalysisDigestStatuses(papersData, [
            { arxivId: '2607.00003', analysis: null, error: 'retry failed' }
        ], { batchDate: '2026-07-08', updatedAt: '2026-07-08T12:00:00+08:00' });

        assert.strictEqual(papersData.papers['2607.00003'].analysis, null);
        assert.strictEqual(papersData.papers['2607.00003'].digestStatus.status, 'analysis_failed');
        assert.strictEqual(papersData.papers['2607.00003'].digestStatus.latestAttemptStatus, 'analysis_failed');
    });

    it('陈旧 pending/seen 快照不会把并发 analyzed 状态降级', () => {
        for (const staleStatus of ['pending_analysis', 'seen']) {
            const merged = mergePapersDatabases({
                generation: 9,
                papers: {
                    '2607.00004': {
                        arxivId: '2607.00004',
                        analysis: validAnalysisText(),
                        digestStatus: {
                            status: 'analyzed',
                            updatedAt: '2026-07-08T12:00:00+08:00'
                        }
                    }
                }
            }, {
                generation: 3,
                papers: {
                    '2607.00004': {
                        arxivId: '2607.00004',
                        digestStatus: {
                            status: staleStatus,
                            updatedAt: '2026-07-08T13:00:00+08:00'
                        }
                    }
                }
            });

            assert.strictEqual(merged.generation, 9);
            assert.strictEqual(merged.papers['2607.00004'].digestStatus.status, 'analyzed');
            assert.strictEqual(merged.papers['2607.00004'].analysis, validAnalysisText());
        }
    });
});

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const {
    parseRefreshCliArgs,
    resolveBatchRefreshIds,
    resolveSavedAnalysisBatchDate,
    hasCurrentReaderV3,
    canRepairScoringBinding,
    MAX_REFRESH_CONCURRENCY
} = require('../scripts/refresh-api-reader.js');

describe('refresh-api-reader 批量命令行', () => {
    it('解析显式的、按日期绑定的五路刷新', () => {
        const parsed = parseRefreshCliArgs([
            '--all', '--date', '2026-09-01', '--concurrency', '5',
            '--scoring-and-reader'
        ]);
        assert.strictEqual(parsed.all, true);
        assert.strictEqual(parsed.date, '2026-09-01');
        assert.strictEqual(parsed.concurrency, MAX_REFRESH_CONCURRENCY);
        assert.strictEqual(parsed.scoringAndReader, true);
        assert.deepStrictEqual(parsed.ids, []);
        const bindings = parseRefreshCliArgs([
            '--all', '--date', '2026-09-01', '--surface-bindings-only'
        ]);
        assert.strictEqual(bindings.surfaceBindingsOnly, true);
        const feedback = parseRefreshCliArgs([
            '--feedback', '图 4 的蓝黄柱数值对应错误', '2608.28630'
        ]);
        assert.strictEqual(feedback.reviewFeedback, '图 4 的蓝黄柱数值对应错误');
    });

    it('拒绝有歧义、没有上界和未知的参数', () => {
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--date', '2026-09-01', '2608.1']),
            /--all 不能/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '6'
            ]),
            /1-5/
        );
        assert.throws(() => parseRefreshCliArgs(['--unknown']), /无法识别参数/);
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '2.5'
            ]),
            /的值必须是整数/
        );
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--date', '2026-02-30']),
            /必须同时提供/
        );
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--all', '--date', '2026-09-01']),
            /不能重复使用/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--surface-bindings-only', '--scoring-and-reader', '2608.1'
            ]),
            /同一次刷新只能选择一种模式/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--feedback', '错误'
            ]),
            /只能指定一个论文 ID/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--figures-only', '--feedback', '错误', '2608.1'
            ]),
            /只能用于刷新完整读者文章/
        );
    });

    it('只挑出不符合当前生产绑定的记录', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-refresh-batch-'));
        const file = path.join(root, 'deep.json');
        const previous = Config.FILES.deepAnalysisResult;
        try {
            fs.writeFileSync(file, JSON.stringify({
                batchDate: '2026-09-01',
                papers: [
                    {
                        arxivId: '2608.00001',
                        apiReaderPlan: { version: 3 },
                        apiReaderArticle: '完整的 v3 正文',
                        analysisManifest: {
                            contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                            stages: { apiReaderArticle: { status: 'complete' } }
                        }
                    },
                    {
                        arxivId: '2608.00002',
                        apiReaderPlan: { version: 2 },
                        analysisManifest: {
                            contracts: { apiReaderArticle: 'beginner-researcher-v2' },
                            stages: { apiReaderArticle: { status: 'complete' } }
                        }
                    }
                ]
            }), 'utf8');
            const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
            const current = payload.papers[0];
            current.apiReaderArticleSha256 = require('crypto').createHash('sha256')
                .update(current.apiReaderArticle).digest('hex');
            current.apiReaderPlanSha256 = require('../scripts/deep-analyzer.js')
                .stableFingerprint(current.apiReaderPlan);
            current.analysisManifest.stages.apiReaderArticle.articleSha256 =
                current.apiReaderArticleSha256;
            current.analysisManifest.stages.apiReaderArticle.planSha256 =
                current.apiReaderPlanSha256;
            fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
            Config.FILES.deepAnalysisResult = file;
            const options = parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '5'
            ]);
            assert.deepStrictEqual(resolveBatchRefreshIds({
                ...options,
                isCurrentReaderFn: paper => paper.apiReaderPlan?.version === 3
            }), ['2608.00002']);
            assert.strictEqual(hasCurrentReaderV3(JSON.parse(
                fs.readFileSync(file, 'utf8')
            ).papers[0]), false);
            assert.strictEqual(hasCurrentReaderV3({ arxivId: 'missing-plan' }), false);
            assert.throws(
                () => resolveBatchRefreshIds({ ...options, date: '2026-08-31' }),
                /不能按 2026-08-31 全量刷新/
            );
        } finally {
            Config.FILES.deepAnalysisResult = previous;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('接受历史外层对象的时间戳，不凭它编出一个实际批次日期', () => {
        assert.strictEqual(resolveSavedAnalysisBatchDate({
            timestamp: '2026-09-02T13:46:46.159+08:00',
            lastUpdated: '2026-09-02T17:07:45.682+08:00'
        }), '2026-09-02');
        assert.strictEqual(resolveSavedAnalysisBatchDate({
            batchDate: '2026-09-01',
            timestamp: '2026-09-02T00:01:00+08:00'
        }), '2026-09-01');
        assert.strictEqual(resolveSavedAnalysisBatchDate({}), '');
    });

    it('Reader 短暂失败后，从已签名的 v3 修订种子修复评分', () => {
        const article = '仍可复用的完整 Reader 正文';
        const plan = { version: 3, sections: [] };
        const crypto = require('node:crypto');
        const stableFingerprint = require('../scripts/deep-analyzer.js').stableFingerprint;
        const paper = {
            analysis: '## 核心摘要\n完整 canonical 分析',
            apiReaderArticle: article,
            apiReaderArticleSha256: crypto.createHash('sha256').update(article).digest('hex'),
            apiReaderPlan: plan,
            apiReaderPlanSha256: stableFingerprint(plan),
            latestAnalysisAttemptError: 'temporary TLS failure',
            analysisManifest: {
                version: 1,
                contracts: { apiReaderArticle: 'beginner-researcher-v3' },
                stages: {
                    scoringAudit: {
                        status: 'complete', scoringContract: 'api-scoring-audit-v2'
                    },
                    apiReaderArticle: { status: 'invalid_output' }
                }
            }
        };
        assert.strictEqual(canRepairScoringBinding(paper), true);
        paper.apiReaderArticleSha256 = '0'.repeat(64);
        assert.strictEqual(canRepairScoringBinding(paper), false);
    });
});

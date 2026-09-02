const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const {
    parseRefreshCliArgs,
    resolveBatchRefreshIds,
    resolvePersistedCanonicalBatchDate,
    hasCurrentReaderV3,
    MAX_REFRESH_CONCURRENCY
} = require('../scripts/refresh-api-reader.js');

describe('refresh-api-reader batch CLI', () => {
    it('parses an explicit date-bound five-way refresh', () => {
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

    it('rejects ambiguous, unbounded, and unknown arguments', () => {
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
        assert.throws(() => parseRefreshCliArgs(['--unknown']), /未知参数/);
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--concurrency', '2.5'
            ]),
            /必须为整数/
        );
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--date', '2026-02-30']),
            /必须同时提供/
        );
        assert.throws(
            () => parseRefreshCliArgs(['--all', '--all', '--date', '2026-09-01']),
            /参数重复/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--surface-bindings-only', '--scoring-and-reader', '2608.1'
            ]),
            /刷新模式参数不能同时使用/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--all', '--date', '2026-09-01', '--feedback', '错误'
            ]),
            /一个显式论文 ID/
        );
        assert.throws(
            () => parseRefreshCliArgs([
                '--figures-only', '--feedback', '错误', '2608.1'
            ]),
            /只能用于完整读者文章刷新/
        );
    });

    it('selects only records that fail the current production binding', () => {
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
                /拒绝按 2026-08-31/
            );
        } finally {
            Config.FILES.deepAnalysisResult = previous;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('accepts a historical envelope timestamp without inventing a wall-clock batch', () => {
        assert.strictEqual(resolvePersistedCanonicalBatchDate({
            timestamp: '2026-09-02T13:46:46.159+08:00',
            lastUpdated: '2026-09-02T17:07:45.682+08:00'
        }), '2026-09-02');
        assert.strictEqual(resolvePersistedCanonicalBatchDate({
            batchDate: '2026-09-01',
            timestamp: '2026-09-02T00:01:00+08:00'
        }), '2026-09-01');
        assert.strictEqual(resolvePersistedCanonicalBatchDate({}), '');
    });
});

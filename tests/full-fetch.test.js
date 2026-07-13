const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validAnalysisPaper: validAnalysisRecord } = require('./valid-analysis-fixture.js');

const execFileAsync = promisify(execFile);
const EXPECTED_CATEGORIES = ['eess.AS', 'cs.SD', 'eess.SP', 'cs.CL', 'cs.LG', 'cs.AI', 'cs.MM'];
const completeSourceHealth = () => ({
    arxiv: { categories: EXPECTED_CATEGORIES.map(id => ({ id, ok: true })) },
    huggingface: { ok: true }
});

describe('full-fetch helpers', () => {
    it('模块可安全导入且不会自动启动长流程', () => {
        const mod = require('../scripts/full-fetch.js');
        assert.strictEqual(typeof mod.fullFetch, 'function');
        assert.strictEqual(typeof mod.loadCompleteFilteredForToday, 'function');
    });

    it('sourceHealth 汇总保留来源状态', () => {
        const { buildSourceHealth } = require('../scripts/full-fetch.js');
        const health = buildSourceHealth(
            {
                arxiv: { categories: [{ id: 'cs.SD', fetched: 2, ok: true }] },
                huggingface: { ok: true, fetched: 1 }
            },
            [{ arxivId: '1' }, { arxivId: '2' }],
            [{ arxivId: '3' }]
        );

        assert.strictEqual(health.arxiv.totalFetched, 2);
        assert.strictEqual(health.huggingface.totalFetched, 1);
        assert.strictEqual(health.arxiv.categories[0].id, 'cs.SD');
        assert.match(health.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it('续跑统计可从 sourceHealth 恢复抓取数量', () => {
        const { getSourceFetchedCount } = require('../scripts/full-fetch.js');
        assert.strictEqual(getSourceFetchedCount({ arxiv: { totalFetched: 12 } }, 'arxiv', 0), 12);
        assert.strictEqual(getSourceFetchedCount({ huggingface: { fetched: 3 } }, 'huggingface', 0), 3);
        assert.strictEqual(getSourceFetchedCount({}, 'arxiv', 7), 7);
    });

    it('sourceHealth 可提取抓取失败原因', () => {
        const { getSourceFailures } = require('../scripts/full-fetch.js');
        const failures = getSourceFailures({
            arxiv: {
                categories: [
                    { id: 'cs.SD', ok: true },
                    { id: 'eess.AS', ok: false, error: 'HTTP 429' }
                ]
            },
            huggingface: { ok: false, error: 'timeout' }
        });

        assert.deepStrictEqual(failures, ['arxiv:eess.AS:HTTP 429', 'huggingface:timeout']);
    });

    it('任一必需抓取来源失败时禁止将筛选缓存视为完整', () => {
        const { hasRequiredSourceFailure } = require('../scripts/full-fetch.js');
        assert.strictEqual(hasRequiredSourceFailure({
            arxiv: { categories: [{ id: 'cs.SD', ok: true }, { id: 'eess.AS', ok: false }] },
            huggingface: { ok: true }
        }), true);
        assert.strictEqual(hasRequiredSourceFailure({
            arxiv: { categories: EXPECTED_CATEGORIES.map(id => ({ id, ok: true })) },
            huggingface: { ok: true }
        }), false);
        assert.strictEqual(hasRequiredSourceFailure({
            arxiv: { categories: [{ id: 'cs.SD', ok: true }] },
            huggingface: { ok: true }
        }), true);
    });

    it('筛选覆盖只接受每个候选都有明确且不可重试的决定', () => {
        const { validateFilterDecisionCoverage } = require('../scripts/full-fetch.js');
        const papers = [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }];

        const complete = validateFilterDecisionCoverage(papers, {
            '2607.00001': { related: true },
            '2607.00002': { related: false }
        });
        assert.strictEqual(complete.complete, true);
        assert.strictEqual(complete.decided, 2);

        const incomplete = validateFilterDecisionCoverage(papers, {
            '2607.00001': { related: true },
            '2607.00002': { related: null, retryable: true, fallback: true }
        });
        assert.strictEqual(incomplete.complete, false);
        assert.deepStrictEqual(incomplete.missingIds, ['2607.00002']);
        assert.deepStrictEqual(incomplete.retryableIds, ['2607.00002']);
    });

    it('筛选产物一致性同时校验 stats.complete、候选覆盖和相关结果', () => {
        const { validateFilterArtifacts } = require('../scripts/full-fetch.js');
        const decisions = {
            timestamp: '2026-07-10T10:00:00+08:00',
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            filterConfigFingerprint: 'filter-config-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            stats: { complete: true, totalCandidates: 2, decided: 2 },
            decisions: {
                '2607.00001': { related: true },
                '2607.00002': { related: false }
            }
        };
        const filtered = {
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            filterConfigFingerprint: 'filter-config-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            stats: { decisionCount: 2, skippedFromArchive: 0 },
            papers: [{ arxivId: '2607.00001' }]
        };
        const raw = {
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            sourceHealth: completeSourceHealth(),
            papers: [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }]
        };

        assert.strictEqual(validateFilterArtifacts(filtered, decisions, raw), true);
        assert.strictEqual(validateFilterArtifacts(filtered, {
            ...decisions,
            stats: { ...decisions.stats, complete: false }
        }, raw), false);
        assert.strictEqual(validateFilterArtifacts({ ...filtered, papers: [] }, decisions, raw), false);
        assert.strictEqual(validateFilterArtifacts(filtered, decisions, null), false);
        assert.strictEqual(validateFilterArtifacts({
            ...filtered,
            papers: [{ arxivId: '2607.00002' }]
        }, decisions, raw), false);
        assert.strictEqual(validateFilterArtifacts(filtered, {
            ...decisions,
            decisions: { '2607.00001': { related: true } }
        }, raw), false);
    });

    it('空候选只在核心来源致命失败时阻断', () => {
        const { getFatalEmptyCandidateSourceFailures } = require('../scripts/full-fetch.js');

        assert.deepStrictEqual(
            getFatalEmptyCandidateSourceFailures({
                arxiv: {
                    categories: [
                        { id: 'cs.SD', ok: true, fetched: 0 },
                        { id: 'eess.AS', ok: false, error: 'HTTP 429' }
                    ]
                },
                huggingface: { ok: false, error: 'timeout' }
            }),
            []
        );

        assert.deepStrictEqual(
            getFatalEmptyCandidateSourceFailures({
                arxiv: {
                    categories: [
                        { id: 'cs.SD', ok: false, error: 'HTTP 429' },
                        { id: 'eess.AS', ok: false, error: 'HTTP 500' }
                    ]
                },
                huggingface: { ok: true, fetched: 0 }
            }),
            ['arxiv:cs.SD:HTTP 429', 'arxiv:eess.AS:HTTP 500']
        );
    });

    it('只复用今日 complete 的 filtered-papers 文件', () => {
        const { loadCompleteFilteredForToday } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-filtered-'));
        const file = path.join(dir, 'filtered-papers.json');

        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-08T10:00:00+08:00',
            status: 'complete',
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            papers: [{ arxivId: '2607.00001' }]
        }));
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file).papers.length, 1);
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file, {
            filterModel: 'model-a',
            filterPromptHash: 'hash-a'
        }).papers.length, 1);
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file, {
            filterModel: 'model-b',
            filterPromptHash: 'hash-a'
        }), null);
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file, {
            filterModel: 'model-a',
            filterPromptHash: 'hash-b'
        }), null);

        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-08T10:00:00+08:00',
            status: 'filtering',
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            papers: [{ arxivId: '2607.00001' }]
        }));
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-08', file), null);
        assert.strictEqual(loadCompleteFilteredForToday('2026-07-09', file), null);
    });

    it('来源健康的当日未完成筛选会直接续跑，不重新抓取候选', () => {
        const { loadResumableFilterForToday } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-resume-filter-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');
        const timestamp = '2026-07-13T10:00:00+08:00';
        fs.writeFileSync(rawFile, JSON.stringify({
            timestamp,
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            sourceHealth: completeSourceHealth(),
            papers: [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }]
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            timestamp,
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            decisions: {
                '2607.00001': { related: true },
                '2607.00002': { related: null, retryable: true, fallback: true }
            }
        }));
        const resumed = loadResumableFilterForToday('2026-07-13', {
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        }, { rawCandidates: rawFile, filterDecisions: decisionsFile });
        assert.ok(resumed);
        assert.deepStrictEqual(resumed.coverage.missingIds, ['2607.00002']);
    });

    it('raw 已原子写入但 decisions 尚未创建时，从空决定继续筛选而不重新抓取', () => {
        const { loadResumableFilterForToday } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-raw-only-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        fs.writeFileSync(rawFile, JSON.stringify({
            timestamp: '2026-07-13T10:00:00+08:00',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a',
            sourceHealth: completeSourceHealth(),
            papers: [{ arxivId: '2607.00001' }]
        }));
        const resumed = loadResumableFilterForToday('2026-07-13', {
            filterModel: 'new-model',
            filterPromptHash: 'new-prompt',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        }, { rawCandidates: rawFile, filterDecisions: path.join(dir, 'missing.json') });
        assert.ok(resumed);
        assert.deepStrictEqual(resumed.decisionsData.decisions, {});
        assert.deepStrictEqual(resumed.coverage.missingIds, ['2607.00001']);
    });

    it('模型或 prompt 变化只清空筛选决定，健康 raw 候选仍可复用', () => {
        const { loadResumableFilterForToday } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-new-filter-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');
        const common = {
            timestamp: '2026-07-13T10:00:00+08:00',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        };
        fs.writeFileSync(rawFile, JSON.stringify({ ...common, sourceHealth: completeSourceHealth(), papers: [{ arxivId: '2607.00001' }] }));
        fs.writeFileSync(decisionsFile, JSON.stringify({ ...common, filterModel: 'old', filterPromptHash: 'old', decisions: { '2607.00001': { related: true } } }));
        const resumed = loadResumableFilterForToday('2026-07-13', {
            filterModel: 'new', filterPromptHash: 'new',
            candidateFingerprint: 'candidate-a', sourceConfigFingerprint: 'source-a', blogDedupFingerprint: 'blog-a'
        }, { rawCandidates: rawFile, filterDecisions: decisionsFile });
        assert.ok(resumed);
        assert.deepStrictEqual(resumed.decisionsData.decisions, {});
    });

    it('抓取 checkpoint 只复用同日且候选指纹一致的来源结果', () => {
        const { loadFetchCheckpoint, saveFetchCheckpoint } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-fetch-checkpoint-'));
        const file = path.join(dir, 'fetch-checkpoint.json');
        saveFetchCheckpoint({
            candidateFingerprint: 'candidate-a',
            historicalDedupIds: ['old'],
            categoryOrder: EXPECTED_CATEGORIES,
            arxiv: { 'cs.SD': { status: 'complete', papers: [{ arxivId: '2607.1' }], health: { ok: true } } },
            huggingface: null
        }, file);
        const today = JSON.parse(fs.readFileSync(file)).timestamp.slice(0, 10);
        assert.ok(loadFetchCheckpoint(today, 'candidate-a', file));
        assert.strictEqual(loadFetchCheckpoint(today, 'candidate-b', file), null);
        assert.deepStrictEqual(loadFetchCheckpoint(today, 'candidate-a', file).categoryOrder, EXPECTED_CATEGORIES);
    });

    it('抓取 checkpoint 内容被篡改时只丢弃损坏来源', () => {
        const { loadFetchCheckpoint, saveFetchCheckpoint } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-fetch-tamper-'));
        const file = path.join(dir, 'fetch-checkpoint.json');
        saveFetchCheckpoint({
            candidateFingerprint: 'candidate-a',
            historicalDedupIds: ['old'],
            categoryOrder: EXPECTED_CATEGORIES,
            arxiv: {
                'cs.SD': { status: 'complete', papers: [{ arxivId: '2607.1' }], health: { id: 'cs.SD', ok: true } },
                'eess.AS': { status: 'complete', papers: [{ arxivId: '2607.2' }], health: { id: 'eess.AS', ok: true } }
            },
            huggingface: { status: 'complete', papers: [{ arxivId: '2607.3' }], health: { ok: true } }
        }, file);
        const stored = JSON.parse(fs.readFileSync(file));
        stored.arxiv['cs.SD'].papers[0].title = 'tampered';
        fs.writeFileSync(file, JSON.stringify(stored));

        const loaded = loadFetchCheckpoint(stored.timestamp.slice(0, 10), 'candidate-a', file);
        assert.ok(loaded);
        assert.strictEqual(loaded.arxiv['cs.SD'], undefined);
        assert.strictEqual(loaded.arxiv['eess.AS'].papers.length, 1);
        assert.strictEqual(loaded.huggingface.papers.length, 1);
    });

    it('抓取 checkpoint 来源缺少 count/hash 时仅使该来源失效', () => {
        const { loadFetchCheckpoint, saveFetchCheckpoint } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-fetch-missing-integrity-'));
        const file = path.join(dir, 'fetch-checkpoint.json');
        saveFetchCheckpoint({
            candidateFingerprint: 'candidate-a', historicalDedupIds: [], categoryOrder: EXPECTED_CATEGORIES,
            arxiv: { 'cs.SD': { status: 'complete', papers: [], health: { id: 'cs.SD', ok: true } } },
            huggingface: { status: 'complete', papers: [], health: { ok: true } }
        }, file);
        const stored = JSON.parse(fs.readFileSync(file));
        delete stored.huggingface.papersSha256;
        fs.writeFileSync(file, JSON.stringify(stored));

        const loaded = loadFetchCheckpoint(stored.timestamp.slice(0, 10), 'candidate-a', file);
        assert.ok(loaded.arxiv['cs.SD']);
        assert.strictEqual(loaded.huggingface, null);
    });

    it('同日历史去重基线排除本批次自写状态并保留真正历史与博客 ID', () => {
        const { buildHistoricalDedupBaseline } = require('../scripts/full-fetch.js');
        const baseline = buildHistoricalDedupBaseline({ papers: {
            old: { digestStatus: { status: 'analyzed', batchDate: '2026-07-12' } },
            today: { digestStatus: { status: 'analyzed', batchDate: '2026-07-13' } },
            historicalReanalyzedToday: {
                fetchedAt: '2026-07-10T09:00:00+08:00',
                digestStatus: { status: 'analyzed', batchDate: '2026-07-13' }
            },
            fetchedTodayWithOldAnalysisDate: {
                fetchedAt: '2026-07-13T09:00:00+08:00',
                digestStatus: { status: 'analyzed', batchDate: '2026-07-12' }
            },
            retry: { digestStatus: { status: 'analysis_failed', batchDate: '2026-07-12' } }
        } }, '2026-07-13', new Set(['blog']));
        assert.deepStrictEqual(baseline, ['blog', 'historicalreanalyzedtoday', 'old']);
    });

    it('筛选配置指纹绑定 endpoint/protocol/温度/token 与解析契约', () => {
        const { getFilterConfigFingerprint } = require('../scripts/full-fetch.js');
        const oldEndpoint = process.env.PAPER_ANALYZER_ENDPOINT;
        const oldModel = process.env.PAPER_ANALYZER_MODEL;
        try {
            process.env.PAPER_ANALYZER_MODEL = 'model-a';
            process.env.PAPER_ANALYZER_ENDPOINT = 'https://one.example/v1';
            const first = getFilterConfigFingerprint('prompt-a');
            process.env.PAPER_ANALYZER_ENDPOINT = 'https://two.example/anthropic';
            const second = getFilterConfigFingerprint('prompt-a');
            assert.notStrictEqual(first, second);
            assert.notStrictEqual(second, getFilterConfigFingerprint('prompt-b'));
        } finally {
            if (oldEndpoint === undefined) delete process.env.PAPER_ANALYZER_ENDPOINT;
            else process.env.PAPER_ANALYZER_ENDPOINT = oldEndpoint;
            if (oldModel === undefined) delete process.env.PAPER_ANALYZER_MODEL;
            else process.env.PAPER_ANALYZER_MODEL = oldModel;
        }
    });

    it('从当前分析结果识别今日已有成功分析论文', () => {
        const { loadCurrentSuccessfulAnalysisIds } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-analysis-ids-'));
        const file = path.join(dir, 'deep-analysis-result.json');

        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-08T10:00:00+08:00',
            papers: [
                validAnalysisRecord('2607.00001v2', { fetchedAt: '2026-07-08T09:00:00+08:00' }),
                validAnalysisRecord('2607.00009'),
                { arxivId: '2607.00002', fetchedAt: '2026-07-08T09:00:00+08:00', error: 'failed' },
                { arxivId: '2607.00003', fetchedAt: '2026-07-07T09:00:00+08:00', analysis: 'old' }
            ]
        }));

        assert.deepStrictEqual(
            Array.from(loadCurrentSuccessfulAnalysisIds(file, '2026-07-08')),
            ['2607.00001']
        );
    });

    it('短 analysis 和陈旧 parsed 不会被当作可续跑成功结果', () => {
        const { loadCurrentSuccessfulAnalysisIds } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-invalid-analysis-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [{ arxivId: '2607.00004', analysis: 'ok', parsed: { score: 9.9 } }]
        }));
        assert.deepStrictEqual(Array.from(loadCurrentSuccessfulAnalysisIds(file)), []);
    });

    it('最终保存锁内重读合并并递增 generation，部分失败写入 partial_failed', () => {
        const { saveFinalAnalysisResults } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-final-save-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            generation: 7,
            timestamp: '2026-07-10T08:00:00+08:00',
            papers: [validAnalysisRecord('2607.10001'), { arxivId: 'concurrent', title: 'keep' }]
        }));

        const saved = saveFinalAnalysisResults(file, [
            { arxivId: '2607.10002', analysis: null, error: 'timeout' }
        ], [{ arxivId: '2607.10001' }, { arxivId: '2607.10002' }], { newlyAnalyzed: 0 });

        assert.strictEqual(saved.generation, 8);
        assert.strictEqual(saved.status, 'partial_failed');
        assert.strictEqual(saved.stats.analysisStatus, 'partial_failed');
        assert.strictEqual(saved.stats.remainingFailed, 1);
        assert.ok(saved.papers.some(paper => paper.arxivId === 'concurrent'));
        assert.strictEqual(saved.deepAnalysisCompletedAt, undefined);
    });

    it('最终保存遇到损坏文件时阻断且不覆盖', () => {
        const { saveFinalAnalysisResults } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-final-corrupt-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, '{broken');
        assert.throws(() => saveFinalAnalysisResults(file, [], []), /JSON 文件损坏或不可读/);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    });

    it('最终保存全失败时写 failed', () => {
        const { saveFinalAnalysisResults } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-final-failed-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        const saved = saveFinalAnalysisResults(file, [
            { arxivId: '2607.20001', analysis: null, error: 'timeout' }
        ], [{ arxivId: '2607.20001' }]);
        assert.strictEqual(saved.status, 'failed');
        assert.strictEqual(saved.stats.analysisStatus, 'failed');
        assert.strictEqual(saved.stats.remainingFailed, 1);
    });

    it('最终状态忽略锁外尝试统计，按锁内 expected ID 全集重算', () => {
        const { saveFinalAnalysisResults } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-final-expected-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [validAnalysisRecord('2607.21001'), validAnalysisRecord('unrelated')]
        }));

        const saved = saveFinalAnalysisResults(file, [], [{ arxivId: '2607.21001' }], {
            analysisStatus: 'failed'
        });
        assert.strictEqual(saved.status, 'complete');
        assert.strictEqual(saved.stats.analysisStatus, 'complete');
        assert.strictEqual(saved.stats.successfulExpected, 1);
        assert.strictEqual(saved.stats.remainingFailed, 0);
    });

    it('full-fetch 收尾只更新统计，不会把旧累计正文覆盖 canonical 新结果', () => {
        const { finalizeAnalysisResults } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-finalize-metadata-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [validAnalysisRecord('2607.22001v2', { title: 'newer canonical' })]
        }));

        const saved = finalizeAnalysisResults(file, [{ arxivId: '2607.22001' }], {
            newlyAnalyzed: 1
        });
        assert.strictEqual(saved.papers.length, 1);
        assert.strictEqual(saved.papers[0].title, 'newer canonical');
        assert.strictEqual(saved.papers[0].arxivId, '2607.22001v2');
        assert.strictEqual(saved.status, 'complete');
    });

    it('多个 full-fetch 最终保存进程并发时保留全部更新', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-full-final-lock-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({ generation: 4, papers: [{ arxivId: 'seed' }] }));
        const fullFetchPath = path.resolve(__dirname, '../scripts/full-fetch.js');
        const fixturePath = path.resolve(__dirname, './valid-analysis-fixture.js');
        const worker = `
            const { saveFinalAnalysisResults } = require(process.argv[1]);
            const { validAnalysisPaper } = require(process.argv[2]);
            const file = process.argv[3];
            const id = process.argv[4];
            saveFinalAnalysisResults(file, [validAnalysisPaper(id)], [{ arxivId: id }]);
        `;

        await Promise.all(['2607.30001', '2607.30002'].map(id => execFileAsync(
            process.execPath,
            ['-e', worker, fullFetchPath, fixturePath, file, id]
        )));

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.generation, 6);
        assert.deepStrictEqual(
            new Set(saved.papers.map(paper => paper.arxivId)),
            new Set(['seed', '2607.30001', '2607.30002'])
        );
    });

    it('从 papers.json 恢复当天候选论文', () => {
        const { loadTodayPapersFromDatabase } = require('../scripts/full-fetch.js');
        const papers = loadTodayPapersFromDatabase({
            papers: {
                a: { arxivId: '2607.00001', fetchedAt: '2026-07-08T09:00:00+08:00' },
                b: { arxivId: '2607.00002', lastUpdated: '2026-07-07T09:00:00+08:00', digestStatus: { batchDate: '2026-07-08' } },
                c: { arxivId: '2607.00003', fetchedAt: '2026-07-07T09:00:00+08:00' }
            }
        }, '2026-07-08');

        assert.deepStrictEqual(papers.map(p => p.arxivId), ['2607.00001', '2607.00002']);
    });

    it('full-fetch 续跑会把 canonical 失败记录的阶段 checkpoint 合并回筛选输入', () => {
        const { mergeCanonicalAnalysisState } = require('../scripts/full-fetch.js');
        const filtered = {
            arxivId: '2607.40001v2',
            title: 'fresh metadata',
            abstract: 'fresh abstract'
        };
        const canonical = {
            arxivId: '2607.40001v1',
            title: 'old metadata',
            analysis: null,
            analysisCheckpoint: 'body after revision',
            analysisStageCheckpoints: { revision: 'body after revision' },
            analysisManifest: {
                version: 1,
                stages: { scoringAudit: { status: 'transient_failure' } }
            },
            analysisRecoveryImageManifest: { candidates: [{ url: 'https://example.com/a.png' }] }
        };
        const merged = mergeCanonicalAnalysisState(filtered, canonical);
        assert.strictEqual(merged.title, 'fresh metadata');
        assert.strictEqual(merged.abstract, 'fresh abstract');
        assert.strictEqual(merged.analysisCheckpoint, 'body after revision');
        assert.deepStrictEqual(merged.analysisStageCheckpoints, canonical.analysisStageCheckpoints);
        assert.deepStrictEqual(merged.analysisManifest, canonical.analysisManifest);
        assert.deepStrictEqual(merged.analysisRecoveryImageManifest, canonical.analysisRecoveryImageManifest);
    });
});

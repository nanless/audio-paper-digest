const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validAnalysisPaper: validAnalysisRecord } = require('./valid-analysis-fixture.js');
const { buildFilterInputSha256 } = require('../scripts/fetch-papers.js');

const execFileAsync = promisify(execFile);
const EXPECTED_CATEGORIES = ['eess.AS', 'cs.SD', 'eess.SP', 'cs.CL', 'cs.LG', 'cs.AI', 'cs.MM'];
const completeSourceHealth = () => ({
    arxiv: { categories: EXPECTED_CATEGORIES.map(id => ({ id, ok: true })) },
    huggingface: { ok: true }
});

function writeResumeCheckpoint(dir, common, options = {}) {
    const { saveFetchCheckpoint } = require('../scripts/full-fetch.js');
    const file = path.join(dir, 'fetch-checkpoint.json');
    saveFetchCheckpoint({
        timestamp: common.timestamp,
        batchStartedAt: common.timestamp,
        batchDate: common.timestamp.slice(0, 10),
        batchId: common.batchId,
        candidateFingerprint: common.candidateFingerprint,
        sourceConfigFingerprint: common.sourceConfigFingerprint,
        blogDedupFingerprint: common.blogDedupFingerprint,
        historicalDedupIds: [],
        categoryOrder: EXPECTED_CATEGORIES,
        arxiv: Object.fromEntries(EXPECTED_CATEGORIES.map((id, index) => [id, {
            status: 'complete',
            papers: id === options.emptyCategoryId ? [] : [{ arxivId: `2607.${String(90000 + index)}` }],
            health: { id, ok: true }
        }])),
        huggingface: { status: 'complete', papers: [], health: { ok: true } }
    }, file);
    return { file, checkpoint: JSON.parse(fs.readFileSync(file)) };
}

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

    it('同批次跨 arXiv 类别重复论文会合并全部 categories', () => {
        const { mergePaperCategories } = require('../scripts/full-fetch.js');
        const target = { arxivId: '2607.1', categories: ['cs.SD'] };
        mergePaperCategories(target, { arxivId: '2607.1', categories: ['eess.AS', 'cs.SD'] });
        assert.deepStrictEqual(target.categories, ['cs.SD', 'eess.AS']);
    });

    it('跨午夜运行仍把所有候选固定到启动时批次时间', () => {
        const { pinPapersToBatch } = require('../scripts/full-fetch.js');
        const papers = [{ fetchedAt: '2026-07-14T00:01:00+08:00' }, {}];
        pinPapersToBatch(papers, '2026-07-13T23:59:00.000+08:00');
        assert.deepStrictEqual(papers.map(paper => paper.fetchedAt), [
            '2026-07-13T23:59:00.000+08:00',
            '2026-07-13T23:59:00.000+08:00'
        ]);
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
            '2607.00001': { related: true, inputSha256: buildFilterInputSha256(papers[0]) },
            '2607.00002': { related: false, inputSha256: buildFilterInputSha256(papers[1]) }
        });
        assert.strictEqual(complete.complete, true);
        assert.strictEqual(complete.decided, 2);

        const incomplete = validateFilterDecisionCoverage(papers, {
            '2607.00001': { related: true, inputSha256: buildFilterInputSha256(papers[0]) },
            '2607.00002': { related: null, retryable: true, fallback: true }
        });
        assert.strictEqual(incomplete.complete, false);
        assert.deepStrictEqual(incomplete.missingIds, ['2607.00002']);
        assert.deepStrictEqual(incomplete.retryableIds, ['2607.00002']);
    });

    it('筛选产物一致性同时校验 stats.complete、候选覆盖和相关结果', () => {
        const { validateFilterArtifacts, stableContentSha256 } = require('../scripts/full-fetch.js');
        const rawPapers = [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }];
        const rawPapersSha256 = stableContentSha256(rawPapers);
        const common = {
            timestamp: '2026-07-10T10:00:00+08:00',
            batchDate: '2026-07-10',
            batchId: 'batch-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        };
        const checkpointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-filter-consistency-'));
        const { checkpoint } = writeResumeCheckpoint(checkpointDir, common);
        const decisions = {
            ...common,
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            filterConfigFingerprint: 'filter-config-a',
            rawPapersSha256,
            fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            stats: { complete: true, totalCandidates: 2, decided: 2 },
            decisions: {
                '2607.00001': { related: true, inputSha256: buildFilterInputSha256(rawPapers[0]) },
                '2607.00002': { related: false, inputSha256: buildFilterInputSha256(rawPapers[1]) }
            }
        };
        const filtered = {
            ...common,
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            filterConfigFingerprint: 'filter-config-a',
            rawPapersSha256,
            fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            stats: { decisionCount: 2, skippedFromArchive: 0 },
            papers: [{ arxivId: '2607.00001' }]
        };
        const raw = {
            ...common,
            rawPapersSha256,
            fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            sourceHealth: completeSourceHealth(),
            papers: rawPapers
        };

        assert.strictEqual(validateFilterArtifacts(filtered, decisions, raw, checkpoint), true);
        assert.strictEqual(validateFilterArtifacts(filtered, {
            ...decisions,
            stats: { ...decisions.stats, complete: false }
        }, raw, checkpoint), false);
        assert.strictEqual(validateFilterArtifacts({ ...filtered, papers: [] }, decisions, raw, checkpoint), false);
        assert.strictEqual(validateFilterArtifacts(filtered, decisions, null), false);
        assert.strictEqual(validateFilterArtifacts({
            ...filtered,
            papers: [{ arxivId: '2607.00002' }]
        }, decisions, raw, checkpoint), false);
        assert.strictEqual(validateFilterArtifacts(filtered, {
            ...decisions,
            decisions: { '2607.00001': { related: true } }
        }, raw, checkpoint), false);
        const { checkpoint: emptyCheckpoint } = writeResumeCheckpoint(checkpointDir, common, {
            emptyCategoryId: 'eess.AS'
        });
        const emptyIntegrityRaw = { ...raw, fetchSourcesSha256: emptyCheckpoint.fetchSourcesSha256 };
        const emptyIntegrityDecisions = { ...decisions, fetchSourcesSha256: emptyCheckpoint.fetchSourcesSha256 };
        const emptyIntegrityFiltered = { ...filtered, fetchSourcesSha256: emptyCheckpoint.fetchSourcesSha256 };
        assert.strictEqual(validateFilterArtifacts(
            emptyIntegrityFiltered,
            emptyIntegrityDecisions,
            emptyIntegrityRaw,
            emptyCheckpoint
        ), false);
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
        const { loadResumableFilterForToday, stableContentSha256 } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-resume-filter-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');
        const timestamp = '2026-07-13T10:00:00+08:00';
        const papers = [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }];
        const common = { timestamp, batchId: 'batch-a', candidateFingerprint: 'candidate-a', sourceConfigFingerprint: 'source-a', blogDedupFingerprint: 'blog-a' };
        const { file: fetchCheckpoint, checkpoint } = writeResumeCheckpoint(dir, common);
        const rawPapersSha256 = stableContentSha256(papers);
        fs.writeFileSync(rawFile, JSON.stringify({
            ...common, batchDate: '2026-07-13', rawPapersSha256, fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            sourceHealth: completeSourceHealth(),
            papers
        }));
        fs.writeFileSync(decisionsFile, JSON.stringify({
            ...common, batchDate: '2026-07-13', rawPapersSha256, fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            decisions: {
                '2607.00001': { related: true, inputSha256: buildFilterInputSha256(papers[0]) },
                '2607.00002': { related: null, retryable: true, fallback: true }
            }
        }));
        const resumed = loadResumableFilterForToday('2026-07-13', {
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        }, { rawCandidates: rawFile, filterDecisions: decisionsFile, fetchCheckpoint });
        assert.ok(resumed);
        assert.deepStrictEqual(resumed.coverage.missingIds, ['2607.00002']);
    });

    it('raw 已原子写入但 decisions 尚未创建时，从空决定继续筛选而不重新抓取', () => {
        const { loadResumableFilterForToday, stableContentSha256 } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-raw-only-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        const papers = [{ arxivId: '2607.00001' }];
        const common = { timestamp: '2026-07-13T10:00:00+08:00', batchId: 'batch-a', candidateFingerprint: 'candidate-a', sourceConfigFingerprint: 'source-a', blogDedupFingerprint: 'blog-a' };
        const { file: fetchCheckpoint, checkpoint } = writeResumeCheckpoint(dir, common);
        fs.writeFileSync(rawFile, JSON.stringify({
            ...common, batchDate: '2026-07-13', rawPapersSha256: stableContentSha256(papers), fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            sourceHealth: completeSourceHealth(),
            papers
        }));
        const resumed = loadResumableFilterForToday('2026-07-13', {
            filterModel: 'new-model',
            filterPromptHash: 'new-prompt',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        }, { rawCandidates: rawFile, filterDecisions: path.join(dir, 'missing.json'), fetchCheckpoint });
        assert.ok(resumed);
        assert.deepStrictEqual(resumed.decisionsData.decisions, {});
        assert.deepStrictEqual(resumed.coverage.missingIds, ['2607.00001']);
    });

    it('模型或 prompt 变化只清空筛选决定，健康 raw 候选仍可复用', () => {
        const { loadResumableFilterForToday, stableContentSha256 } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-new-filter-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        const decisionsFile = path.join(dir, 'filter-decisions.json');
        const common = {
            timestamp: '2026-07-13T10:00:00+08:00',
            batchId: 'batch-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        };
        const papers = [{ arxivId: '2607.00001' }];
        const { file: fetchCheckpoint, checkpoint } = writeResumeCheckpoint(dir, common);
        const integrity = { batchDate: '2026-07-13', rawPapersSha256: stableContentSha256(papers), fetchSourcesSha256: checkpoint.fetchSourcesSha256 };
        fs.writeFileSync(rawFile, JSON.stringify({ ...common, ...integrity, sourceHealth: completeSourceHealth(), papers }));
        fs.writeFileSync(decisionsFile, JSON.stringify({ ...common, ...integrity, filterModel: 'old', filterPromptHash: 'old', decisions: { '2607.00001': { related: true, inputSha256: buildFilterInputSha256(papers[0]) } } }));
        const resumed = loadResumableFilterForToday('2026-07-13', {
            filterModel: 'new', filterPromptHash: 'new',
            candidateFingerprint: 'candidate-a', sourceConfigFingerprint: 'source-a', blogDedupFingerprint: 'blog-a'
        }, { rawCandidates: rawFile, filterDecisions: decisionsFile, fetchCheckpoint });
        assert.ok(resumed);
        assert.deepStrictEqual(resumed.decisionsData.decisions, {});
    });

    it('筛选恢复路径遇到任一空 arXiv 来源时拒绝跨进程复用', () => {
        const { loadResumableFilterForToday, stableContentSha256 } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-empty-source-resume-'));
        const rawFile = path.join(dir, 'raw-candidates.json');
        const common = {
            timestamp: '2026-07-13T10:00:00+08:00',
            batchId: 'batch-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        };
        const papers = [{ arxivId: '2607.00001' }];
        const { file: fetchCheckpoint, checkpoint } = writeResumeCheckpoint(dir, common, {
            emptyCategoryId: 'cs.SD'
        });
        fs.writeFileSync(rawFile, JSON.stringify({
            ...common,
            batchDate: '2026-07-13',
            rawPapersSha256: stableContentSha256(papers),
            fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            sourceHealth: completeSourceHealth(),
            papers
        }));

        assert.strictEqual(loadResumableFilterForToday('2026-07-13', {
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            candidateFingerprint: 'candidate-a',
            sourceConfigFingerprint: 'source-a',
            blogDedupFingerprint: 'blog-a'
        }, {
            rawCandidates: rawFile,
            filterDecisions: path.join(dir, 'missing-decisions.json'),
            fetchCheckpoint
        }), null);
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

    it('跨进程续跑不复用 arXiv 空结果，避免新批次分阶段上线后永久漏抓', () => {
        const { isReusableArxivCheckpoint } = require('../scripts/full-fetch.js');
        assert.strictEqual(isReusableArxivCheckpoint({
            status: 'complete', papers: [], health: { ok: true }
        }), false);
        assert.strictEqual(isReusableArxivCheckpoint({
            status: 'complete', papers: [{ arxivId: '2607.10001' }], health: { ok: true }
        }), true);
        assert.strictEqual(isReusableArxivCheckpoint({
            status: 'failed', papers: [{ arxivId: '2607.10001' }], health: { ok: false }
        }), false);
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

    it('最终保存锁内按 expected 集合收敛并递增 generation，部分失败写入 partial_failed', () => {
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
        assert.deepStrictEqual(saved.papers.map(paper => paper.arxivId), ['2607.10001', '2607.10002']);
        assert.strictEqual(saved.stats.removedUnexpected, 1);
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

    it('分析流水线状态在锁内写回结果文件且不改写论文正文', () => {
        const { persistPipelineStats } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-pipeline-stats-'));
        const file = path.join(dir, 'result.json');
        const originalPaper = validAnalysisRecord('2607.29999');
        fs.writeFileSync(file, JSON.stringify({
            generation: 3,
            status: 'complete',
            stats: { analysisStatus: 'complete' },
            papers: [originalPaper]
        }));

        const saved = persistPipelineStats(file, {
            visualSummaryStatus: 'pending',
            digestCoverStatus: 'pending',
            pipelineStatus: 'analysis_complete'
        });
        assert.strictEqual(saved.generation, 4);
        assert.strictEqual(saved.stats.pipelineStatus, 'analysis_complete');
        assert.deepStrictEqual(saved.papers, [originalPaper]);
        fs.rmSync(dir, { recursive: true, force: true });
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
        assert.deepStrictEqual(saved.papers.map(paper => paper.arxivId), ['2607.21001']);
        assert.strictEqual(saved.stats.removedUnexpected, 1);
    });

    it('最终保存优先采用 expected 批次并清除旧批次完成态', () => {
        const { saveFinalAnalysisResults } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-final-batch-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            batchDate: '2026-07-12',
            status: 'complete',
            deepAnalysisCompletedAt: '2026-07-12T18:00:00+08:00',
            stats: { analysisStatus: 'complete', expected: 1, totalAfterMerge: 1 },
            papers: [validAnalysisRecord('2607.21999')]
        }));

        const saved = saveFinalAnalysisResults(file, [
            { arxivId: '2607.22000', batchDate: '2026-07-13', analysis: null, error: 'timeout' }
        ], [{ arxivId: '2607.22000', batchDate: '2026-07-13' }]);
        assert.strictEqual(saved.batchDate, '2026-07-13');
        assert.strictEqual(saved.status, 'failed');
        assert.strictEqual(saved.deepAnalysisCompletedAt, undefined);
        assert.deepStrictEqual(saved.papers.map(paper => paper.arxivId), ['2607.22000']);
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
            saveFinalAnalysisResults(file, [validAnalysisPaper(id)], [
                { arxivId: '2607.30001' },
                { arxivId: '2607.30002' }
            ]);
        `;

        await Promise.all(['2607.30001', '2607.30002'].map(id => execFileAsync(
            process.execPath,
            ['-e', worker, fullFetchPath, fixturePath, file, id]
        )));

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.generation, 6);
        assert.deepStrictEqual(
            new Set(saved.papers.map(paper => paper.arxivId)),
            new Set(['2607.30001', '2607.30002'])
        );
    });

    it('归档冲突时 current 成为固定 canonical，旧 canonical 留作冲突备份', () => {
        const { autoArchiveCurrentData } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-archive-conflict-'));
        const current = path.join(dir, 'current', 'deep-analysis-result.json');
        const archiveDir = path.join(dir, 'archive');
        const archiveDay = path.join(archiveDir, '2026-07-12');
        const canonical = path.join(archiveDay, 'deep-analysis-result.json');
        fs.mkdirSync(path.dirname(current), { recursive: true });
        fs.mkdirSync(archiveDay, { recursive: true });
        fs.writeFileSync(current, JSON.stringify({
            timestamp: '2026-07-12T18:00:00+08:00',
            papers: [{ arxivId: '2607.70002', title: 'latest current' }]
        }));
        fs.writeFileSync(canonical, JSON.stringify({
            timestamp: '2026-07-12T09:00:00+08:00',
            papers: [{ arxivId: '2607.70001', title: 'old canonical' }]
        }));

        autoArchiveCurrentData('2026-07-13', { targets: [current], archiveDir });

        assert.strictEqual(fs.existsSync(current), false);
        assert.strictEqual(JSON.parse(fs.readFileSync(canonical, 'utf8')).papers[0].title, 'latest current');
        const conflicts = fs.readdirSync(archiveDay).filter(name => name.includes('-conflict-'));
        assert.strictEqual(conflicts.length, 1);
        assert.strictEqual(
            JSON.parse(fs.readFileSync(path.join(archiveDay, conflicts[0]), 'utf8')).papers[0].title,
            'old canonical'
        );
    });

    it('归档 canonical 替换或校验失败时保留 current', () => {
        const { autoArchiveCurrentData } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-archive-failure-'));
        const current = path.join(dir, 'current', 'deep-analysis-result.json');
        const archiveDir = path.join(dir, 'archive');
        const canonical = path.join(archiveDir, '2026-07-12', 'deep-analysis-result.json');
        fs.mkdirSync(path.dirname(current), { recursive: true });
        fs.mkdirSync(canonical, { recursive: true });
        fs.writeFileSync(current, JSON.stringify({
            timestamp: '2026-07-12T18:00:00+08:00',
            papers: [{ arxivId: '2607.70003' }]
        }));

        autoArchiveCurrentData('2026-07-13', { targets: [current], archiveDir });

        assert.strictEqual(fs.existsSync(current), true);
        assert.strictEqual(fs.statSync(canonical).isDirectory(), true);
    });

    it('清理旧分析记录后锁内重算 canonical 聚合状态和批次', () => {
        const { cleanOldData } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-clean-canonical-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-13T08:00:00+08:00',
            status: 'complete',
            deepAnalysisCompletedAt: '2026-07-13T08:00:00+08:00',
            stats: { analysisStatus: 'complete', remainingFailed: 0, totalAfterMerge: 2 },
            papers: [
                validAnalysisRecord('2607.71001', { batchDate: '2026-07-13' }),
                { arxivId: '2607.71002', batchDate: '2026-07-12', analysis: null, error: 'old failure' }
            ]
        }));

        cleanOldData(file, 'deep-analysis-result', '2026-07-13', { archiveDir: path.join(dir, 'archive') });
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepStrictEqual(saved.papers.map(paper => paper.arxivId), ['2607.71001']);
        assert.strictEqual(saved.batchDate, '2026-07-13');
        assert.strictEqual(saved.status, 'complete');
        assert.strictEqual(saved.stats.analysisStatus, 'complete');
        assert.strictEqual(saved.stats.remainingFailed, 0);
        assert.strictEqual(saved.stats.totalAfterMerge, 1);
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

    it('legacy 分析结果只迁移一次到 current，校验成功后移除旧文件', () => {
        const { migrateLegacyAnalysisResultToCurrent } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-legacy-migrate-'));
        const current = path.join(dir, 'current', 'deep-analysis-result.json');
        const legacy = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(legacy, JSON.stringify({
            timestamp: '2026-07-30T09:00:00+08:00',
            papers: [{ arxivId: '2607.99999' }]
        }));

        assert.strictEqual(migrateLegacyAnalysisResultToCurrent(current, legacy), true);
        assert.strictEqual(fs.existsSync(legacy), false);
        assert.strictEqual(JSON.parse(fs.readFileSync(current, 'utf8')).papers[0].arxivId, '2607.99999');
        assert.strictEqual(migrateLegacyAnalysisResultToCurrent(current, legacy), false);
    });

    it('legacy 顶层数组从论文时间推断北京时间批次，不会伪装成迁移当天', () => {
        const {
            inferLegacyAnalysisArrayBatchDate,
            migrateLegacyAnalysisResultToCurrent
        } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-legacy-array-'));
        const current = path.join(dir, 'current', 'deep-analysis-result.json');
        const legacy = path.join(dir, 'deep-analysis-result.json');
        const papers = [
            { arxivId: '2607.80001', fetchedAt: '2026-07-29T16:30:00.000Z' },
            { arxivId: '2607.80002', digestStatus: { batchDate: '2026-07-30' } }
        ];
        fs.writeFileSync(legacy, JSON.stringify(papers));

        assert.strictEqual(inferLegacyAnalysisArrayBatchDate(papers), '2026-07-30');
        assert.strictEqual(migrateLegacyAnalysisResultToCurrent(current, legacy), true);
        const migrated = JSON.parse(fs.readFileSync(current, 'utf8'));
        assert.strictEqual(migrated.batchDate, '2026-07-30');
        assert.match(migrated.timestamp, /^2026-07-30T/);
        assert.strictEqual(fs.existsSync(legacy), false);
    });

    it('legacy 顶层数组无法可靠推断单一批次时 fail-closed 且不删除原文件', () => {
        const { migrateLegacyAnalysisResultToCurrent } = require('../scripts/full-fetch.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-legacy-array-invalid-'));
        const current = path.join(dir, 'current', 'deep-analysis-result.json');
        const legacy = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(legacy, JSON.stringify([
            { arxivId: '2607.81001', fetchedAt: '2026-07-29T09:00:00+08:00' },
            { arxivId: '2607.81002' }
        ]));

        assert.throws(
            () => migrateLegacyAnalysisResultToCurrent(current, legacy),
            /缺少可验证的批次日期/
        );
        assert.strictEqual(fs.existsSync(current), false);
        assert.strictEqual(fs.existsSync(legacy), true);
    });

    it('legacy 迁移同时持有源和目标锁，不会误删并发写入的新源结果', async () => {
        const { acquireFileLockSync } = require('../scripts/analysis-engine.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-legacy-lock-'));
        const current = path.join(dir, 'current', 'deep-analysis-result.json');
        const legacy = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(legacy, JSON.stringify({
            timestamp: '2026-07-29T09:00:00+08:00',
            papers: [{ arxivId: '2607.82001', title: 'old source' }]
        }));
        const releaseLegacy = acquireFileLockSync(legacy);
        const worker = `
            const { migrateLegacyAnalysisResultToCurrent } = require(process.argv[1]);
            migrateLegacyAnalysisResultToCurrent(process.argv[2], process.argv[3]);
        `;
        const migration = execFileAsync(process.execPath, [
            '-e',
            worker,
            path.resolve(__dirname, '../scripts/full-fetch.js'),
            current,
            legacy
        ]);
        try {
            const currentLock = `${current}.lock`;
            const startedAt = Date.now();
            while (!fs.existsSync(currentLock) && Date.now() - startedAt < 3000) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.strictEqual(fs.existsSync(currentLock), true, '迁移进程应先取得目标锁并等待 legacy 锁');
            const replacement = `${legacy}.replacement`;
            fs.writeFileSync(replacement, JSON.stringify({
                timestamp: '2026-07-30T09:00:00+08:00',
                papers: [{ arxivId: '2607.82002', title: 'new source' }]
            }));
            fs.renameSync(replacement, legacy);
        } finally {
            releaseLegacy();
        }

        await migration;
        const migrated = JSON.parse(fs.readFileSync(current, 'utf8'));
        assert.strictEqual(migrated.papers[0].arxivId, '2607.82002');
        assert.strictEqual(fs.existsSync(legacy), false);
    });
});

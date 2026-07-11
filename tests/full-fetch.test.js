const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validAnalysisPaper: validAnalysisRecord } = require('./valid-analysis-fixture.js');

const execFileAsync = promisify(execFile);

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
            arxiv: { categories: [{ id: 'cs.SD', ok: true }] },
            huggingface: { ok: true }
        }), false);
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
            stats: { complete: true, totalCandidates: 2, decided: 2 },
            decisions: {
                '2607.00001': { related: true },
                '2607.00002': { related: false }
            }
        };
        const filtered = {
            filterModel: 'model-a',
            filterPromptHash: 'hash-a',
            stats: { decisionCount: 2 },
            papers: [{ arxivId: '2607.00001' }]
        };
        const raw = { papers: [{ arxivId: '2607.00001' }, { arxivId: '2607.00002' }] };

        assert.strictEqual(validateFilterArtifacts(filtered, decisions, raw), true);
        assert.strictEqual(validateFilterArtifacts(filtered, {
            ...decisions,
            stats: { ...decisions.stats, complete: false }
        }, raw), false);
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
});

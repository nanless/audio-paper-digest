const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
    validAnalysisText,
    validAnalysisPaper: validAnalysisRecord
} = require('./valid-analysis-fixture.js');

const {
    loadPapersDatabase,
    savePapersDatabase,
    updateAnalysisDigestStatuses
} = require('../scripts/digest-status.js');
const {
    main: refilterMain,
    saveSuccessfulResultsById,
    resolveResultFileForTargetDate,
    validateTargetDate,
    loadRefilterDecisions,
    saveRefilterDecisions
} = require('../scripts/refilter-reanalyze-by-date.js');
const { validateCompleteFilteredForToday, validateDeepAnalysisInput } = require('../scripts/deep-analysis-only.js');
const { isSuccessfulAnalysisRecord } = require('../scripts/analysis-engine.js');

const execFileAsync = promisify(execFile);

describe('papers database recovery safety', () => {
    it('current JSON 损坏时不会静默回退 legacy', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-corrupt-'));
        const current = path.join(dir, 'current.json');
        const legacy = path.join(dir, 'legacy.json');
        fs.writeFileSync(current, '{broken');
        fs.writeFileSync(legacy, JSON.stringify({ papers: { old: { arxivId: 'old' } } }));

        assert.throws(() => loadPapersDatabase(current, legacy), /JSON 文件损坏或不可读/);
        assert.strictEqual(fs.readFileSync(current, 'utf8'), '{broken');
    });

    it('current JSON 的 papers 结构非法时阻断状态写入', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-schema-'));
        const file = path.join(dir, 'papers.json');
        fs.writeFileSync(file, JSON.stringify({ papers: 'broken' }));
        assert.throws(() => updateAnalysisDigestStatuses([
            { arxivId: '2607.1', analysis: 'ok' }
        ], { filePath: file }), /papers 必须是对象或数组/);
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).papers, 'broken');
    });

    it('仅 current 不存在时才允许读取 legacy', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-legacy-'));
        const current = path.join(dir, 'missing.json');
        const legacy = path.join(dir, 'legacy.json');
        fs.writeFileSync(legacy, JSON.stringify({ papers: { '2607.1v1': { arxivId: '2607.1v1' } } }));

        const data = loadPapersDatabase(current, legacy);
        assert.ok(data.papers['2607.1']);
    });

    it('规范化对象 key 并合并同一论文的不同版本', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-conflict-'));
        const file = path.join(dir, 'papers.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: {
                '2607.12345v1': { arxivId: '2607.12345v1', title: 'v1', sources: ['arxiv'] },
                '2607.12345v2': { arxivId: '2607.12345v2', title: 'v2', sources: ['huggingface'] }
            }
        }));

        const loaded = loadPapersDatabase(file);
        assert.deepStrictEqual(Object.keys(loaded.papers), ['2607.12345']);
        assert.strictEqual(loaded.papers['2607.12345'].arxivId, '2607.12345v2');
        assert.strictEqual(loaded.papers['2607.12345'].title, 'v2');
        assert.deepStrictEqual(loaded.papers['2607.12345'].sources.sort(), ['arxiv', 'huggingface']);
    });

    it('拒绝对象 key 与论文自身 ID 指向不同论文', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-key-mismatch-'));
        const file = path.join(dir, 'papers.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: { '2607.11111': { arxivId: '2607.22222' } }
        }));
        assert.throws(() => loadPapersDatabase(file), /key 与论文版本 ID 冲突/);
    });

    it('generation 变化后锁内合并陈旧快照且不丢并发更新', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-generation-'));
        const file = path.join(dir, 'papers.json');
        fs.writeFileSync(file, JSON.stringify({ generation: 0, papers: { a: { arxivId: 'a' } } }));
        const stale = loadPapersDatabase(file);

        updateAnalysisDigestStatuses([{ arxivId: 'b', analysis: 'ok' }], { filePath: file });
        stale.papers.c = { arxivId: 'c' };
        savePapersDatabase(stale, file);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(saved.papers.b);
        assert.ok(saved.papers.c);
        assert.strictEqual(saved.generation, 2);
    });

    it('多个进程并发保存 papers.json 不丢论文且逐次递增 generation', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-concurrent-'));
        const file = path.join(dir, 'papers.json');
        fs.writeFileSync(file, JSON.stringify({ generation: 0, papers: {} }));
        const digestStatusPath = path.resolve(__dirname, '../scripts/digest-status.js');
        const worker = `
            const { loadPapersDatabase, savePapersDatabase } = require(process.argv[1]);
            const file = process.argv[2];
            const prefix = process.argv[3];
            for (let i = 0; i < 8; i++) {
                const snapshot = loadPapersDatabase(file, null);
                const id = prefix + '.' + i;
                snapshot.papers[id] = { arxivId: id };
                savePapersDatabase(snapshot, file);
            }
        `;

        await Promise.all(['a', 'b', 'c', 'd'].map(prefix =>
            execFileAsync(process.execPath, ['-e', worker, digestStatusPath, file, prefix])
        ));

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(Object.keys(saved.papers).length, 32);
        assert.strictEqual(saved.generation, 32);
    });
});

describe('entry recovery contracts', () => {
    it('refilter 按篇保存决定，并仅在日期和筛选配置指纹一致时复用', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-decisions-'));
        const checkpoint = path.join(dir, 'refilter-filter-decisions.json');
        const definitive = {
            related: true,
            inputSha256: 'a'.repeat(64),
            retryable: false,
            fallback: false
        };
        saveRefilterDecisions(checkpoint, '2026-07-08', 'config-a', {
            decisions: { '2607.1': definitive },
            retryableDecisions: {
                '2607.2': { related: null, retryable: true, inputSha256: 'b'.repeat(64) }
            },
            stats: { complete: false, decided: 1, retryable: 1 }
        });

        const reused = loadRefilterDecisions(checkpoint, '2026-07-08', 'config-a');
        assert.deepStrictEqual(reused['2607.1'], definitive);
        assert.strictEqual(reused['2607.2'].retryable, true);
        assert.deepStrictEqual(loadRefilterDecisions(checkpoint, '2026-07-09', 'config-a'), {});
        assert.deepStrictEqual(loadRefilterDecisions(checkpoint, '2026-07-08', 'config-b'), {});
    });

    it('按日期重筛只替换成功 ID，失败不会删除旧成功', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-save-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            deepAnalysisCompletedAt: '2026-07-10T08:00:00+08:00',
            papers: [
                validAnalysisRecord('2607.1', { title: 'old' }),
                validAnalysisRecord('2607.2', { title: 'stable' })
            ]
        }));

        saveSuccessfulResultsById(file, [
            validAnalysisRecord('2607.1v2', { title: 'new' })
        ], { refilterStatus: 'partial_failed' });

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.papers.length, 2);
        assert.strictEqual(saved.papers.find(p => p.arxivId === '2607.1v2').analysis, validAnalysisText());
        assert.strictEqual(saved.papers.find(p => p.arxivId === '2607.2').analysis, validAnalysisText());
        assert.strictEqual(saved.stats.refilterStatus, 'partial_failed');
        assert.strictEqual(saved.stats.analysisStatus, 'partial_failed');
        assert.strictEqual(saved.status, 'partial_failed');
        assert.strictEqual(saved.deepAnalysisCompletedAt, undefined);
    });

    it('按日期重筛会保存失败 checkpoint，同时保留旧成功正文', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-checkpoint-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [validAnalysisRecord('2607.9', {
                imageManifest: { selected: ['old-image'] }
            })]
        }));
        const checkpoint = validAnalysisText().replace('作者与机构信息未在测试夹具中展开。', '恢复中的新文本。');
        saveSuccessfulResultsById(file, [{
            arxivId: '2607.9',
            analysis: null,
            error: 'image timeout',
            analysisCheckpoint: checkpoint,
            analysisManifest: { version: 1, stages: { imageDownload: { status: 'transient_failure' } } },
            imageManifest: { selected: [], downloaded: [] }
        }], { refilterStatus: 'partial_failed' });

        const [saved] = JSON.parse(fs.readFileSync(file, 'utf8')).papers;
        assert.strictEqual(saved.analysis, validAnalysisText());
        assert.strictEqual(saved.analysisCheckpoint, checkpoint);
        assert.deepStrictEqual(saved.imageManifest, { selected: ['old-image'] });
        assert.deepStrictEqual(saved.analysisRecoveryImageManifest, { selected: [], downloaded: [] });
        assert.strictEqual(isSuccessfulAnalysisRecord(saved), false);
    });

    it('历史 targetDate 默认写对应 archive，且拒绝显式写 current', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-history-path-'));
        const currentDir = path.join(dir, 'current');
        const currentFile = path.join(currentDir, 'deep-analysis-result.json');
        const legacyCurrentFile = path.join(dir, 'deep-analysis-result.json');
        const archiveDir = path.join(dir, 'archive');
        const options = {
            today: '2026-07-10',
            currentDir,
            currentFile,
            legacyCurrentFile,
            archiveDir
        };

        assert.strictEqual(
            resolveResultFileForTargetDate('2026-07-08', options),
            path.join(archiveDir, '2026-07-08', 'deep-analysis-result.json')
        );
        assert.throws(() => resolveResultFileForTargetDate('2026-07-08', {
            ...options,
            resultFile: currentFile
        }), /对应 archive 日期目录/);
        assert.strictEqual(resolveResultFileForTargetDate('2026-07-10', options), currentFile);
        assert.throws(() => resolveResultFileForTargetDate('2026-07-10', {
            ...options,
            resultFile: path.join(archiveDir, '2026-07-10', 'deep-analysis-result.json')
        }), /必须位于 current/);
        assert.throws(() => resolveResultFileForTargetDate('2026-07-08', {
            ...options,
            resultFile: path.join(archiveDir, '2026-07-09', 'deep-analysis-result.json')
        }), /对应 archive 日期目录/);
        assert.throws(() => validateTargetDate('2026-02-30'), /无效目标日期/);
    });

    it('新建历史分析文件保留批次日期而不是当前日期', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-batch-date-'));
        const file = path.join(dir, '2026-07-08', 'deep-analysis-result.json');
        const saved = saveSuccessfulResultsById(file, [validAnalysisRecord('2607.3')], {
            date: '2026-07-08',
            refilterStatus: 'complete'
        });

        assert.strictEqual(saved.batchDate, '2026-07-08');
        assert.strictEqual(saved.status, 'complete');
        assert.strictEqual(saved.stats.analysisStatus, 'complete');
        assert.match(saved.timestamp, /^2026-07-08T/);
        assert.ok(saved.lastUpdated >= '2026-07-10');
        assert.strictEqual(saved.deepAnalysisCompletedAt !== undefined, true);
    });

    it('refilter 最终状态只按锁内 expected ID 计算', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-expected-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [
                validAnalysisRecord('2607.31'),
                { arxivId: 'unrelated', analysis: null, error: 'old failure' }
            ]
        }));

        const saved = saveSuccessfulResultsById(file, [], {
            date: '2026-07-08',
            expectedIds: ['2607.31'],
            finalize: true,
            failed: 1
        });
        assert.strictEqual(saved.status, 'complete');
        assert.strictEqual(saved.stats.successfulExpected, 1);
        assert.strictEqual(saved.stats.remainingFailed, 0);
        assert.strictEqual(saved.stats.removedByRefilter, 1);
        assert.deepStrictEqual(saved.papers.map(paper => paper.arxivId), ['2607.31']);
    });

    it('refilter 完成态移除明确落选项，同时保留入选失败项的恢复状态', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-prune-failed-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [
                validAnalysisRecord('2607.61', { title: 'still selected' }),
                validAnalysisRecord('2607.62', { title: 'now rejected' })
            ]
        }));
        saveSuccessfulResultsById(file, [{
            arxivId: '2607.61',
            analysis: null,
            parsed: null,
            error: 'temporary failure',
            latestAnalysisAttemptError: 'temporary failure',
            analysisCheckpoint: 'recoverable body',
            analysisManifest: {
                version: 1,
                stages: { scoringAudit: { status: 'transient_failure' } }
            }
        }], {
            date: '2026-07-08',
            expectedIds: ['2607.61'],
            refilterStatus: 'running'
        });

        const finalized = saveSuccessfulResultsById(file, [], {
            date: '2026-07-08',
            expectedIds: ['2607.61'],
            finalize: true
        });
        assert.strictEqual(finalized.status, 'failed');
        assert.strictEqual(finalized.papers.length, 1);
        assert.strictEqual(finalized.papers[0].arxivId, '2607.61');
        assert.strictEqual(finalized.papers[0].analysis, validAnalysisText());
        assert.strictEqual(finalized.papers[0].analysisCheckpoint, 'recoverable body');
        assert.strictEqual(finalized.papers[0].latestAnalysisAttemptError, 'temporary failure');
        assert.strictEqual(finalized.stats.removedByRefilter, 1);
    });

    it('refilter 空入选集会清空旧 canonical 论文', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-prune-empty-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            papers: [validAnalysisRecord('2607.71')]
        }));

        const finalized = saveSuccessfulResultsById(file, [], {
            date: '2026-07-08',
            expectedIds: [],
            finalize: true
        });
        assert.strictEqual(finalized.status, 'complete');
        assert.deepStrictEqual(finalized.papers, []);
        assert.strictEqual(finalized.stats.removedByRefilter, 1);
    });

    it('refilter 批次与收尾不会用陈旧累计结果覆盖另一运行的较新锁内写入', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-stale-finalize-'));
        const papersPath = path.join(dir, 'papers.json');
        const archiveDir = path.join(dir, 'archive');
        const resultFile = path.join(archiveDir, '2026-07-08', 'deep-analysis-result.json');
        fs.writeFileSync(papersPath, JSON.stringify({
            generation: 1,
            papers: {
                '2607.32': {
                    arxivId: '2607.32',
                    title: 'Concurrent paper',
                    abstract: 'audio',
                    fetchedAt: '2026-07-08T09:00:00+08:00'
                }
            }
        }));
        const filterFn = async papers => {
            const filtered = papers.slice();
            Object.defineProperty(filtered, '_filterStats', {
                value: { complete: true, totalCandidates: 1, decided: 1, retryable: 0 }
            });
            return filtered;
        };
        const stale = validAnalysisRecord('2607.32', { title: 'run A stale result' });
        const newer = validAnalysisRecord('2607.32v2', { title: 'run B newer result' });
        const analyzeBatchFn = async (papers, callbacks) => {
            await callbacks.onPaperResultLocked(papers[0], { success: true, result: stale });
            saveSuccessfulResultsById(resultFile, [newer], {
                date: '2026-07-08',
                expectedIds: ['2607.32'],
                refilterStatus: 'running'
            });
            callbacks.onBatchDone(1, [{ success: true, result: stale }]);
            return {
                results: [stale],
                stats: { success: 1, failed: 0, skipped: 0, sourceCounts: {} }
            };
        };

        const result = await refilterMain('2026-07-08', {
            today: '2026-07-10',
            papersPath,
            archiveDir,
            currentDir: path.join(dir, 'current'),
            currentFile: path.join(dir, 'current', 'deep-analysis-result.json'),
            legacyCurrentFile: path.join(dir, 'deep-analysis-result.json'),
            filterFn,
            analyzeBatchFn,
            digestStatusUpdater: () => ({ updated: 0 })
        });

        const saved = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.strictEqual(result.status, 'complete');
        assert.strictEqual(saved.papers.length, 1);
        assert.strictEqual(saved.papers[0].title, 'run B newer result');
        assert.strictEqual(saved.papers[0].arxivId, '2607.32v2');
    });

    it('refilter 筛选不完整时写 filter_failed 并返回非零', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-filter-failed-'));
        const papersPath = path.join(dir, 'papers.json');
        const archiveDir = path.join(dir, 'archive');
        fs.writeFileSync(papersPath, JSON.stringify({
            generation: 1,
            papers: {
                '2607.41': {
                    arxivId: '2607.41',
                    title: 'Retry filter',
                    fetchedAt: '2026-07-08T09:00:00+08:00'
                }
            }
        }));
        const filterFn = async () => {
            const filtered = [];
            Object.defineProperty(filtered, '_filterStats', {
                value: { complete: false, totalCandidates: 1, decided: 0, retryable: 1 }
            });
            return filtered;
        };

        const result = await refilterMain('2026-07-08', {
            today: '2026-07-10',
            papersPath,
            archiveDir,
            currentDir: path.join(dir, 'current'),
            currentFile: path.join(dir, 'current', 'deep-analysis-result.json'),
            legacyCurrentFile: path.join(dir, 'deep-analysis-result.json'),
            filterFn
        });
        const output = path.join(archiveDir, '2026-07-08', 'deep-analysis-result.json');
        const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.strictEqual(result.exitCode, 1);
        assert.strictEqual(result.status, 'filter_failed');
        assert.strictEqual(saved.status, 'filter_failed');
        assert.strictEqual(saved.stats.filterStats.complete, false);
    });

    it('refilter 拒绝 legacy 顶层 map 等非标准 papers schema', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-schema-'));
        const papersPath = path.join(dir, 'papers.json');
        fs.writeFileSync(papersPath, JSON.stringify({
            '2607.51': { arxivId: '2607.51', fetchedAt: '2026-07-08T09:00:00+08:00' }
        }));

        await assert.rejects(() => refilterMain('2026-07-08', {
            today: '2026-07-10',
            papersPath,
            archiveDir: path.join(dir, 'archive'),
            currentDir: path.join(dir, 'current'),
            currentFile: path.join(dir, 'current', 'deep-analysis-result.json'),
            legacyCurrentFile: path.join(dir, 'deep-analysis-result.json')
        }), /顶层缺少 papers 字段/);
    });

    it('deep-only 只接受当日 complete 筛选结果', () => {
        const today = '2026-07-10';
        assert.doesNotThrow(() => validateCompleteFilteredForToday({
            timestamp: `${today}T09:00:00+08:00`,
            status: 'complete',
            papers: []
        }, today));
        assert.throws(() => validateCompleteFilteredForToday({
            timestamp: '2026-07-09T09:00:00+08:00',
            status: 'complete',
            papers: []
        }, today), /不是当日批次/);
        assert.throws(() => validateCompleteFilteredForToday({
            timestamp: `${today}T09:00:00+08:00`,
            status: 'filtering',
            papers: []
        }, today), /筛选结果未完成/);
    });

    it('deep-only 拒绝过期或与筛选论文集合不一致的分析结果', () => {
        const today = '2026-07-10';
        const filtered = {
            timestamp: `${today}T09:00:00+08:00`,
            status: 'complete',
            papers: [{ arxivId: '2607.1' }, { arxivId: '2607.2v1' }]
        };
        assert.doesNotThrow(() => validateDeepAnalysisInput({
            timestamp: `${today}T10:00:00+08:00`,
            papers: [{ arxivId: '2607.2v2' }, { arxivId: '2607.1' }]
        }, filtered, today));
        assert.throws(() => validateDeepAnalysisInput({
            timestamp: '2026-07-09T10:00:00+08:00',
            papers: filtered.papers
        }, filtered, today), /分析结果不是当日批次/);
        assert.throws(() => validateDeepAnalysisInput({
            timestamp: `${today}T10:00:00+08:00`,
            papers: [{ arxivId: '2607.1' }]
        }, filtered, today), /与当日筛选结果不一致/);
    });
});

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
    updateAnalysisDigestStatuses,
    normalizeCompatibleBatchDate,
    inferAnalysisBatchDate,
    serializePapersDatabase,
    backupPapersJson,
    verifyPapersBackup,
    listValidManagedBackupGroups
} = require('../scripts/digest-status.js');
const {
    main: refilterMain,
    saveSuccessfulResultsById,
    resolveResultFileForTargetDate,
    validateTargetDate,
    loadRefilterDecisions,
    saveRefilterDecisions,
    promoteRefilterArtifacts
} = require('../scripts/refilter-reanalyze-by-date.js');
const {
    parseTargetDate,
    validateCompleteFilteredForToday,
    validateDeepAnalysisInput,
    finalizeDeepZeroWorkState
} = require('../scripts/deep-analysis-only.js');
const { finalizeBatchZeroWorkState } = require('../scripts/batch-analyze.js');
const { isSuccessfulAnalysisRecord } = require('../scripts/analysis-engine.js');

const execFileAsync = promisify(execFile);

describe('papers database recovery safety', () => {
    it('papers writer 使用紧凑 JSON 且不改变字段语义', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-db-compact-'));
        const file = path.join(dir, 'papers.json');
        const data = {
            generation: 0,
            papers: {
                '2609.00001': {
                    arxivId: '2609.00001',
                    title: 'Compact',
                    analysis: 'analysis body',
                    analysisCheckpoint: 'checkpoint body',
                    analysisManifest: { version: 1, stages: { primaryAnalysis: { status: 'complete' } } }
                }
            }
        };
        try {
            savePapersDatabase(data, file);
            const raw = fs.readFileSync(file, 'utf8');
            assert.strictEqual(raw, serializePapersDatabase(JSON.parse(raw)));
            const restored = loadPapersDatabase(file, null);
            assert.strictEqual(restored.papers['2609.00001'].analysis, 'analysis body');
            assert.strictEqual(restored.papers['2609.00001'].analysisCheckpoint, 'checkpoint body');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('压缩备份组可重放 SHA、字节数和 papers schema', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backup-valid-'));
        const source = path.join(dir, 'current', 'papers.json');
        const archive = path.join(dir, 'archive');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        const database = { generation: 3, papers: { '2609.00001': { arxivId: '2609.00001', analysis: 'x'.repeat(10000) } } };
        fs.writeFileSync(source, JSON.stringify(database));
        try {
            const result = await backupPapersJson(source, archive, {
                date: '2026-09-02', createdAt: '2026-09-02T12:00:00+08:00'
            });
            assert.strictEqual(result.backedUp, true);
            assert.ok(result.compressedBytes < fs.statSync(source).size);
            const verified = await verifyPapersBackup(result.backupPath);
            assert.deepStrictEqual(verified.data, database);
            assert.strictEqual(verified.manifest.sourceSha256, result.sourceSha256);
            assert.strictEqual(verified.manifest.contract, 'papers-backup-v1');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('历史 .json 备份仍可验证，但不进入新 writer retention', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backup-legacy-'));
        const legacy = path.join(dir, 'papers-2026-08-01.json');
        const database = { generation: 1, papers: { '2608.00001': { arxivId: '2608.00001' } } };
        fs.writeFileSync(legacy, JSON.stringify(database, null, 2));
        try {
            const verified = await verifyPapersBackup(legacy);
            assert.deepStrictEqual(verified.data, database);
            assert.strictEqual(verified.manifest, null);
            assert.strictEqual((await listValidManagedBackupGroups(dir)).length, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('相同 source SHA 跨日去重，同日并发也只发布一个完整组', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backup-dedup-'));
        const source = path.join(dir, 'current', 'papers.json');
        const archive = path.join(dir, 'archive');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, JSON.stringify({ generation: 1, papers: { '2609.1': { arxivId: '2609.1' } } }));
        try {
            const concurrent = await Promise.all([
                backupPapersJson(source, archive, { date: '2026-09-01' }),
                backupPapersJson(source, archive, { date: '2026-09-01' })
            ]);
            assert.strictEqual(concurrent.filter(item => item.backedUp).length, 1);
            assert.strictEqual((await listValidManagedBackupGroups(archive)).length, 1);
            const duplicate = await backupPapersJson(source, archive, { date: '2026-09-02' });
            assert.strictEqual(duplicate.backedUp, false);
            assert.ok(duplicate.duplicateOf);
            assert.strictEqual((await listValidManagedBackupGroups(archive)).length, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('retention 只删新 writer 的已验证超额组，不删旧 .json', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backup-retention-'));
        const source = path.join(dir, 'current', 'papers.json');
        const archive = path.join(dir, 'archive');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.mkdirSync(archive, { recursive: true });
        const legacy = path.join(archive, 'papers-2026-08-01.json');
        fs.writeFileSync(legacy, JSON.stringify({ generation: 0, papers: {} }));
        try {
            for (const [index, date] of ['2026-08-30', '2026-08-31', '2026-09-01'].entries()) {
                fs.writeFileSync(source, JSON.stringify({
                    generation: index,
                    papers: { [`2609.${index}`]: { arxivId: `2609.${index}`, title: 'x'.repeat(index + 1) } }
                }));
                await backupPapersJson(source, archive, {
                    date,
                    createdAt: `${date}T12:00:00+08:00`,
                    maxGroups: 2
                });
            }
            const groups = await listValidManagedBackupGroups(archive);
            assert.strictEqual(groups.length, 2);
            assert.strictEqual(fs.existsSync(legacy), true);
            assert.strictEqual(fs.existsSync(path.join(archive, 'papers-2026-08-30.json.gz')), false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('损坏 source 在压缩前阻断，manifest commit 崩溃也不留可见半组或影响 current', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-backup-crash-'));
        const source = path.join(dir, 'current', 'papers.json');
        const archive = path.join(dir, 'archive');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, '{broken');
        try {
            await assert.rejects(backupPapersJson(source, archive, { date: '2026-09-01' }));
            assert.deepStrictEqual(fs.existsSync(archive) ? fs.readdirSync(archive) : [], []);

            const validRaw = JSON.stringify({ generation: 1, papers: { '2609.1': { arxivId: '2609.1' } } });
            fs.writeFileSync(source, validRaw);
            await assert.rejects(backupPapersJson(source, archive, {
                date: '2026-09-02',
                hooks: { beforeManifestCommit: async () => { throw new Error('simulated crash'); } }
            }), /simulated crash/);
            assert.strictEqual(fs.readFileSync(source, 'utf8'), validRaw);
            assert.deepStrictEqual(fs.readdirSync(archive), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    it('deep-only 支持严格显式日期以安全续跑跨日批次', () => {
        assert.strictEqual(parseTargetDate(['--date', '2026-08-31']), '2026-08-31');
        assert.throws(() => parseTargetDate(['--date', '2026-02-30']), /有效日期/);
        assert.throws(() => parseTargetDate(['--date']), /用法/);
        assert.throws(() => parseTargetDate(['--unknown', '2026-08-31']), /用法/);
    });

    it('单篇历史重分析优先保留论文批次日期并兼容旧 fetchedAt', () => {
        assert.strictEqual(inferAnalysisBatchDate([{
            fetchBatchDate: '2026-07-08',
            digestStatus: { batchDate: '2026-08-17' },
            fetchedAt: '2026-07-07T23:30:00+08:00'
        }], { batchDate: '2026-08-17' }, '2026-08-17T12:00:00+08:00'), '2026-07-08');

        assert.strictEqual(inferAnalysisBatchDate([{
            fetchedAt: '2026-07-09 09:00:00+08:00'
        }], {}, '2026-08-17T12:00:00+08:00'), '2026-07-09');
    });

    it('单篇重分析忽略非法兼容日期并回退结果文件批次', () => {
        assert.strictEqual(inferAnalysisBatchDate([{
            batchDate: '2026-02-30',
            digestStatus: { batchDate: 'not-a-date' }
        }], { batchDate: '2026-07-10' }, '2026-08-17T12:00:00+08:00'), '2026-07-10');
    });

    it('带时区批次时间戳按真实瞬时转换到北京时间日期', () => {
        assert.strictEqual(normalizeCompatibleBatchDate('2026-07-08T16:30:00Z'), '2026-07-09');
        assert.strictEqual(normalizeCompatibleBatchDate('2026-07-09T00:30:00+09:00'), '2026-07-08');
        assert.strictEqual(normalizeCompatibleBatchDate('2026-07-09 00:30:00-0400'), '2026-07-09');
        assert.strictEqual(inferAnalysisBatchDate([{
            fetchedAt: '2026-07-08T16:30:00Z'
        }], {}, '2026-08-17T12:00:00+08:00'), '2026-07-09');
    });

    it('batch/reanalyze 入口统一接线北京时间批次日期 helper', () => {
        for (const fileName of ['batch-analyze.js', 'reanalyze.js', 'reanalyze-selected.js']) {
            const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', fileName), 'utf8');
            assert.match(source, /inferAnalysisBatchDate\s*\(/, `${fileName} 未调用统一日期 helper`);
            assert.doesNotMatch(source, /function\s+inferBatchDate\s*\(/, `${fileName} 仍保留重复日期实现`);
        }
    });

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

    it('refilter 完成后从 raw 与确定性决定原子同步正式筛选快照', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refilter-promote-'));
        const resultFile = path.join(root, 'deep-analysis-result.json');
        const papers = [
            { arxivId: '2608.10001', title: 'Related A' },
            { arxivId: '2608.10002', title: 'Rejected B' },
            { arxivId: '2608.10003', title: 'Related C' }
        ];
        fs.writeFileSync(path.join(root, 'raw-candidates.json'), JSON.stringify({
            batchDate: '2026-08-29',
            stats: { totalCandidates: 3 },
            papers
        }));
        fs.writeFileSync(path.join(root, 'refilter-filter-decisions.json'), JSON.stringify({
            batchDate: '2026-08-29',
            complete: true,
            filterConfigFingerprint: 'filter-v2',
            decisions: {
                '2608.10001': { related: true },
                '2608.10002': { related: false },
                '2608.10003': { related: true }
            }
        }));
        fs.writeFileSync(path.join(root, 'filter-decisions.json'), JSON.stringify({ batchDate: '2026-08-29' }));
        fs.writeFileSync(path.join(root, 'filtered-papers.json'), JSON.stringify({ batchDate: '2026-08-29', papers: [] }));

        const promoted = promoteRefilterArtifacts(resultFile, '2026-08-29', 'filter-v2', {
            keywordRejected: 1,
            llmCandidates: 2
        });
        assert.strictEqual(promoted.paperCount, 2);
        const decisions = JSON.parse(fs.readFileSync(promoted.decisionsPath, 'utf8'));
        const filtered = JSON.parse(fs.readFileSync(promoted.filteredPath, 'utf8'));
        assert.strictEqual(decisions.stats.decided, 3);
        assert.strictEqual(decisions.stats.related, 2);
        assert.strictEqual(filtered.status, 'complete');
        assert.deepStrictEqual(filtered.papers.map(paper => paper.arxivId), ['2608.10001', '2608.10003']);
        assert.strictEqual(filtered.filterConfigFingerprint, 'filter-v2');
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
            promoteArtifacts: false,
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

    it('batch zero-work 收尾锁内重读 canonical，不会把新失败硬写成 complete', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-zero-work-reread-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            batchDate: '2026-07-10',
            status: 'complete',
            deepAnalysisCompletedAt: '2026-07-10T09:00:00+08:00',
            papers: [
                validAnalysisRecord('2607.81'),
                { arxivId: '2607.82', analysis: null, error: 'concurrent failure' }
            ]
        }));

        const saved = finalizeBatchZeroWorkState(file, '2026-07-10');
        assert.strictEqual(saved.status, 'partial_failed');
        assert.strictEqual(saved.stats.analysisStatus, 'partial_failed');
        assert.strictEqual(saved.stats.remainingFailed, 1);
        assert.strictEqual(saved.stats.totalAfterMerge, 2);
        assert.strictEqual(saved.deepAnalysisCompletedAt, undefined);
    });

    it('batch zero-work 收尾把 UTC 跨日时间戳归入北京时间批次', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-zero-work-timezone-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-07-08T16:30:00Z',
            papers: [validAnalysisRecord('2607.83')]
        }));

        const saved = finalizeBatchZeroWorkState(file, '2026-08-17');
        assert.strictEqual(saved.batchDate, '2026-07-09');
        assert.strictEqual(saved.status, 'complete');
    });

    it('deep-only zero-work 收尾在同一锁内重验 expected 集合和 canonical 状态', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-zero-work-reread-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        const today = '2026-07-10';
        const filtered = {
            batchDate: today,
            status: 'complete',
            papers: [{ arxivId: '2607.91' }, { arxivId: '2607.92' }]
        };
        fs.writeFileSync(file, JSON.stringify({
            batchDate: today,
            status: 'complete',
            deepAnalysisCompletedAt: `${today}T09:00:00+08:00`,
            papers: [
                validAnalysisRecord('2607.91'),
                { arxivId: '2607.92', analysis: null, error: 'concurrent failure' }
            ]
        }));

        const saved = finalizeDeepZeroWorkState(file, filtered, today);
        assert.strictEqual(saved.status, 'partial_failed');
        assert.strictEqual(saved.stats.remainingFailed, 1);
        assert.strictEqual(saved.deepAnalysisCompletedAt, undefined);

        fs.writeFileSync(file, JSON.stringify({
            batchDate: today,
            papers: [validAnalysisRecord('2607.91'), validAnalysisRecord('2607.99')]
        }));
        assert.throws(
            () => finalizeDeepZeroWorkState(file, filtered, today),
            /与当日筛选结果不一致/
        );
    });
});

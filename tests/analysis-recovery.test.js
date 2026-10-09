const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
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
    parseTargetDate,
    validateCompleteFilteredForToday,
    validateDeepAnalysisInput,
    finalizeDeepZeroWorkState
} = require('../scripts/deep-analysis-only.js');
const { finalizeBatchZeroWorkState } = require('../scripts/batch-analyze.js');

const execFileAsync = promisify(execFile);

describe('论文库恢复的安全性', () => {
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

    it('压缩论文库备份可还原原数据，并核对来源 SHA 和备份格式', async () => {
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

    it('旧 JSON 备份仍可读取核验，但不列入新的受管理备份集合', async () => {
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

        assert.throws(() => loadPapersDatabase(current, legacy), /JSON 文件内容无效或无法读取/);
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

describe('入口恢复约定', () => {
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
        }, today), /筛选结果的日期与目标批次不一致/);
        assert.throws(() => validateCompleteFilteredForToday({
            timestamp: `${today}T09:00:00+08:00`,
            status: 'filtering',
            papers: []
        }, today), /筛选尚未完成，或论文列表 papers 不是数组/);
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
        }, filtered, today), /分析结果的日期与目标批次不一致/);
        assert.throws(() => validateDeepAnalysisInput({
            timestamp: `${today}T10:00:00+08:00`,
            papers: [{ arxivId: '2607.1' }]
        }, filtered, today), /与目标日期的筛选集合不一致/);
    });

    it('batch 没有待处理论文时仍在锁内重读结果，不会把新失败记录误记为完成', () => {
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

    it('仅续分析没有待处理论文时，仍在同一锁内核对目标论文集合和已保存状态', () => {
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
            /与目标日期的筛选集合不一致/
        );
    });
});

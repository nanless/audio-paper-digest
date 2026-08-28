const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');

const {
    sourceStats,
    initialCategoryOrder,
    validateManualRawCheckpoint,
    applyManualArchiveExclusion,
    applyManualFilterStatuses,
    assertUniqueNormalizedDecisionKeys,
    acquireManualRunLock
} = require('../scripts/manual-fetch.js');
const {
    buildManifestContext,
    buildCompleteEntry,
    fetchFullTextForInput,
    getRequestedArxivId,
    isReusableFullTextCheckpoint,
    initializeManifestLocked
} = require('../scripts/manual-fetch-fulltext.js');
const { applyFetchSourceIntegrity, getFetchSourcesSha256 } = require('../scripts/full-fetch.js');

describe('manual fetch data consistency helpers', () => {
    it('日期级跨进程锁让重复阶段快速失败并报告 owner', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-run-lock-'));
        const lockTarget = path.join(dir, '2026-08-25');
        const modulePath = path.join(__dirname, '..', 'scripts', 'manual-fetch.js');
        const childSource = `
            const { acquireManualRunLock } = require(process.argv[1]);
            (async () => {
                const release = await acquireManualRunLock('2026-08-25', 'raw', { lockTarget: process.argv[2] });
                const stop = () => { release(); process.exit(0); };
                process.on('SIGTERM', stop);
                process.stdout.write('READY\\n');
                setInterval(() => {}, 1000);
            })().catch(error => { console.error(error); process.exit(1); });
        `;
        const child = spawn(process.execPath, ['-e', childSource, modulePath, lockTarget], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        try {
            await new Promise((resolve, reject) => {
                let output = '';
                const timer = setTimeout(() => reject(new Error('child lock setup timeout')), 5000);
                child.stdout.on('data', chunk => {
                    output += chunk;
                    if (output.includes('READY')) {
                        clearTimeout(timer);
                        resolve();
                    }
                });
                child.once('error', reject);
                child.once('exit', code => {
                    if (!output.includes('READY')) reject(new Error(`child exited ${code}`));
                });
            });
            const started = Date.now();
            await assert.rejects(
                acquireManualRunLock('2026-08-25', 'fulltext', { lockTarget, timeoutMs: 0 }),
                error => error.code === 'MANUAL_RUN_LOCKED'
                    && error.owner?.stage === 'raw'
                    && Number.isInteger(error.owner?.pid)
            );
            assert.ok(Date.now() - started < 1000);
        } finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
                await new Promise(resolve => child.once('exit', resolve));
            }
        }
    });

    it('rejects manual decision keys that collapse to the same normalized arXiv ID', () => {
        assert.throws(() => assertUniqueNormalizedDecisionKeys({
            '2608.00001': { related: true },
            '2608.00001v2': { related: false }
        }), /规范化重复 key/);
        assert.doesNotThrow(() => assertUniqueNormalizedDecisionKeys({
            '2608.00001': { related: true },
            '2608.00002v1': { related: false }
        }));
    });

    it('records actual blog skip counts and keeps source totals from the pre-skip set', () => {
        const before = [
            { arxivId: '2608.00001', sources: ['arxiv'] },
            { arxivId: '2608.00002', sources: ['huggingface'] },
            { arxivId: '2608.00003', sources: ['arxiv', 'huggingface'] }
        ];
        const stats = sourceStats(before, before.slice(1));
        assert.equal(stats.beforeBlogSkip, 3);
        assert.equal(stats.afterBlogSkip, 2);
        assert.equal(stats.skippedFromBlog, 1);
        assert.equal(stats.arxivOnly, 1);
        assert.equal(stats.hfOnly, 1);
        assert.equal(stats.both, 1);
    });

    it('keeps core categories first and excludes only archived HuggingFace-related papers', () => {
        const order = initialCategoryOrder();
        assert.deepEqual(order.slice(0, 3), ['eess.AS', 'cs.SD', 'eess.SP']);
        assert.equal(new Set(order).size, order.length);

        const related = [
            { arxivId: '2608.00001', sources: ['arxiv'] },
            { arxivId: '2608.00002', sources: ['arxiv', 'huggingface'] },
            { arxivId: '2608.00003', sources: ['huggingface'] }
        ];
        const result = applyManualArchiveExclusion(related, new Set(['2608.00001', '2608.00002']));
        assert.deepEqual(result.excludedRelatedIds, ['2608.00002']);
        assert.deepEqual(result.filteredRelated.map(paper => paper.arxivId), ['2608.00001', '2608.00003']);
    });

    it('exposes the resumable full-text entry in package scripts', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        assert.equal(pkg.scripts['manual:fulltext'], 'node scripts/manual-fetch-fulltext.js');
    });

    it('binds manual selection input to the complete per-source fetch checkpoint', () => {
        const categoryIds = initialCategoryOrder();
        const checkpoint = {
            batchDate: '2026-08-25',
            batchId: 'manual-batch',
            candidateFingerprint: 'candidate-fingerprint',
            arxiv: Object.fromEntries(categoryIds.map(id => [id, applyFetchSourceIntegrity({
                status: 'complete',
                papers: [],
                health: { id, ok: true }
            })])),
            huggingface: applyFetchSourceIntegrity({
                status: 'complete',
                papers: [],
                health: { ok: true }
            })
        };
        checkpoint.fetchSourcesSha256 = getFetchSourcesSha256(checkpoint);
        const raw = {
            batchDate: checkpoint.batchDate,
            batchId: checkpoint.batchId,
            candidateFingerprint: checkpoint.candidateFingerprint,
            fetchSourcesSha256: checkpoint.fetchSourcesSha256,
            sourceHealth: {
                arxiv: { categories: categoryIds.map(id => ({ id, ok: true })) },
                huggingface: { ok: true }
            }
        };
        assert.doesNotThrow(() => validateManualRawCheckpoint(raw, checkpoint));
        assert.throws(
            () => validateManualRawCheckpoint({ ...raw, fetchSourcesSha256: 'tampered' }, checkpoint),
            /来源内容 SHA 不一致/
        );
    });

    it('persists positive, negative, and archive-excluded manual decisions with safe statuses', () => {
        const papersData = { papers: {} };
        const raw = [
            { arxivId: '2608.00001', title: 'negative' },
            { arxivId: '2608.00002', title: 'pending' },
            { arxivId: '2608.00003', title: 'archived' }
        ];
        const decisions = Object.fromEntries(raw.map((paper, index) => [paper.arxivId, {
            related: index > 0,
            reason: `人工决定 ${index}`,
            parseSource: 'manual-offline-v1',
            decidedAt: '2026-08-25T10:00:00.000+08:00'
        }]));
        applyManualFilterStatuses(
            papersData,
            raw,
            decisions,
            new Set(['2608.00002']),
            new Set(['2608.00003']),
            new Set(),
            '2026-08-25'
        );
        assert.equal(papersData.papers['2608.00001'].digestStatus.status, 'seen');
        assert.equal(papersData.papers['2608.00002'].digestStatus.status, 'pending_analysis');
        assert.equal(papersData.papers['2608.00003'].digestStatus.status, 'analyzed');
        assert.equal(papersData.papers['2608.00001'].digestStatus.filterDecision, false);
    });

    it('binds full-text reuse to batch, metadata, exact version, source identity, and saved bytes', async () => {
        assert.equal(getRequestedArxivId({ arxivId: '2608.00001', paper_id: '2608.00001v3' }), '2608.00001v3');
        assert.throws(
            () => getRequestedArxivId({ arxivId: '2608.00001v1', paper_id: '2608.00001v2' }),
            /冲突 arXiv 版本/
        );
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-fulltext-checkpoint-'));
        const filteredV1 = {
            status: 'complete',
            batchDate: '2026-08-25',
            batchId: 'batch-a',
            papers: [{ arxivId: '2608.00001v1', title: 'Version one', authors: ['A'] }]
        };
        const contextV1 = buildManifestContext(filteredV1, filteredV1.batchDate, dir);
        const inputV1 = contextV1.inputs[0];
        let fetchedId = '';
        await fetchFullTextForInput(
            { ...inputV1, requestedArxivId: '2608.00001v3' },
            async requestedId => {
                fetchedId = requestedId;
                return { text: '' };
            }
        );
        assert.equal(fetchedId, '2608.00001v3');
        const file = inputV1.filePath;
        const body = Buffer.from('full text evidence '.repeat(100));
        fs.writeFileSync(file, body);
        const entry = buildCompleteEntry(inputV1, {
            source: 'html',
            sourceId: '2608.00001v1',
            text: body.toString('utf8'),
            warnings: [],
            imageInfos: []
        }, body);
        assert.equal(isReusableFullTextCheckpoint(entry, file, inputV1), true);

        const contextV2 = buildManifestContext({
            ...filteredV1,
            papers: [{ ...filteredV1.papers[0], arxivId: '2608.00001v2' }]
        }, filteredV1.batchDate, dir);
        assert.notEqual(contextV2.inputs[0].paperInputSha256, inputV1.paperInputSha256);
        assert.equal(isReusableFullTextCheckpoint(entry, file, contextV2.inputs[0]), false);
        assert.throws(() => buildCompleteEntry(contextV2.inputs[0], {
            source: 'html', sourceId: '2608.00001v1', text: body.toString('utf8')
        }, body), /指定版本不一致/);

        const metadataChanged = buildManifestContext({
            ...filteredV1,
            papers: [{ ...filteredV1.papers[0], title: 'Corrected title' }]
        }, filteredV1.batchDate, dir);
        assert.notEqual(metadataChanged.inputs[0].paperInputSha256, inputV1.paperInputSha256);

        const batchChanged = buildManifestContext({ ...filteredV1, batchId: 'batch-b' }, filteredV1.batchDate, dir);
        assert.notEqual(batchChanged.filteredBatchSha256, contextV1.filteredBatchSha256);
        assert.equal(isReusableFullTextCheckpoint(entry, file, batchChanged.inputs[0]), false);
        const manifestPath = path.join(dir, 'manifest.json');
        initializeManifestLocked(manifestPath, contextV1);
        assert.throws(
            () => initializeManifestLocked(manifestPath, batchChanged),
            /另一 filtered 批次在运行/
        );

        entry.sourceId = '2608.00001v2';
        assert.equal(isReusableFullTextCheckpoint(entry, file, inputV1), false);
        fs.appendFileSync(file, 'tampered');
        assert.equal(isReusableFullTextCheckpoint(entry, file, inputV1), false);
    });

    it('merges concurrent manifest writers under the project file lock', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-fulltext-concurrent-'));
        const manifestPath = path.join(dir, 'manifest.json');
        const filtered = {
            status: 'complete',
            batchDate: '2026-08-25',
            batchId: 'concurrent-batch',
            papers: [
                { arxivId: '2608.00011v1', title: 'A' },
                { arxivId: '2608.00012v2', title: 'B' }
            ]
        };
        const context = buildManifestContext(filtered, filtered.batchDate, dir);
        initializeManifestLocked(manifestPath, context);
        const modulePath = path.join(__dirname, '..', 'scripts', 'manual-fetch-fulltext.js');
        const workerSource = `
            const { parentPort, workerData } = require('node:worker_threads');
            const { upsertManifestPaperLocked } = require(workerData.modulePath);
            const inputs = workerData.context.inputs;
            const context = {
                ...workerData.context,
                inputs,
                byId: new Map(inputs.map(input => [input.id, input]))
            };
            upsertManifestPaperLocked(workerData.manifestPath, context, workerData.id, workerData.entry);
            parentPort.postMessage('done');
        `;
        const runWorker = (input, delayLabel) => new Promise((resolve, reject) => {
            const worker = new Worker(workerSource, {
                eval: true,
                workerData: {
                    modulePath,
                    manifestPath,
                    context: {
                        date: context.date,
                        filteredBatchSha256: context.filteredBatchSha256,
                        expectedPaperInputs: context.expectedPaperInputs,
                        inputs: context.inputs
                    },
                    id: input.id,
                    entry: {
                        status: 'failed',
                        requestedArxivId: input.requestedArxivId,
                        paperInputSha256: input.paperInputSha256,
                        error: delayLabel
                    }
                }
            });
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => {
                if (code !== 0) reject(new Error(`worker exited ${code}`));
            });
        });
        await Promise.all(context.inputs.map((input, index) => runWorker(input, `writer-${index}`)));
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assert.deepEqual(Object.keys(manifest.papers).sort(), ['2608.00011', '2608.00012']);
        assert.equal(manifest.papers['2608.00011'].error, 'writer-0');
        assert.equal(manifest.papers['2608.00012'].error, 'writer-1');
    });
});

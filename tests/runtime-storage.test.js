const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    getLayout,
    getStorageStatus,
    getPdfDuplicateReport,
    buildPdfDedupePlan,
    dedupeRuntimePdfs,
    defaultCloneFileSync,
    printPdfDedupeResult,
    buildPrunePlan,
    pruneStorage,
    main
} = require('../scripts/runtime-storage.js');

const CONFERENCE_PROTECTED_KEYS = [
    'official-conference-acquisitions',
    'conference-discovery-catalogs',
    'conference-discovery-reports',
    'conference-filter-specs',
    'conference-filters',
    'conference-filter-evidence-runs',
    'conference-staging-specs',
    'conference-staging-sources',
    'conference-staging',
    'conference-ledgers',
    'conference-sources',
    'conference-runs',
    'conference-executions',
    'conference-analysis-executions',
    'conference-page-staging',
    'conference-aggregates',
    'conference-processes',
    'conference-queues',
    'conference-publications',
    'conference-source-recovery'
];
const HISTORY_PROTECTED_KEYS = ['historical-page-inventories', 'page-source-crosswalks',
    'historical-arxiv-batches', 'historical-analysis-schedulers', 'historical-postprocess-schedulers', 'historical-taxonomy-assignments', 'historical-tag-assignments',
    'historical-page-staging', 'historical-daily-aggregates', 'historical-publications', 'paper-source-authorities',
    'daily-fresh-source-runs', 'fetched-arxiv-sources', 'historical-arxiv-fresh-failure-handoffs',
    'historical-arxiv-publication-metadata', 'blog-republication-archives', 'canonical-maintenance',
    'daily-fetch-refresh-backups', 'fresh-rewrites', 'fresh-source-diagnostics', 'llm-usage', 'llm-response-recovery',
    'publication-amendments', 'reader-attempts', 'reader-efficiency-evaluations', 'stale-locks',
    'tag-taxonomy-audit', 'taxonomy-preview', 'tag-preview', 'taxonomy-reseal-reports', 'tag-record-update-reports',
    'direct-local-inputs', 'historical-conference-local-sources', 'historical-conference-page-projections',
    'historical-direct-rewrite-plans', 'historical-direct-rewrite-unprojected-reports',
    'historical-direct-rewrite-registries', 'historical-direct-rewrite-executions', 'historical-direct-rewrite-staging',
    'historical-direct-aggregate-projections', 'historical-direct-aggregates',
    'historical-direct-tag-supplements', 'historical-direct-taxonomy-supplements',
    'historical-source-tag-classifications', 'historical-source-taxonomy-classifications', 'historical-local-crawl-identities',
    'historical-icml-pdf-sources', 'historical-openreview-pdf-sources', 'historical-icml-alternate-pdf-sources',
    'historical-local-crawl-identity-snapshots', 'historical-local-crawl-batches', 'historical-archive-crawl-identities',
    'historical-archive-crawl-batches', 'historical-conference-crawl-identities', 'historical-conference-crawl-batches'];

const NOW_MS = Date.parse('2026-09-02T00:00:00.000Z');
const OLD_MS = NOW_MS - 40 * 24 * 60 * 60 * 1000;

function makeProject() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-storage-test-'));
    for (const relative of [
        'data/current/image-cache',
        'data/current/api-reader-assets',
        'data/current/visual-reference-inputs',
        'data/current/deep_analyzer_input_output',
        'data/current/filter_input_output',
        'data/current/iclr_filter_input_output',
        'data/runtime/official-conference-acquisitions',
        'data/runtime/conference-filter-evidence-runs',
        'data/runtime/conference-ledgers',
        'data/runtime/conference-sources',
        'data/runtime/conference-discovery-catalogs',
        'data/runtime/conference-discovery-reports',
        'data/runtime/conference-filter-specs',
        'data/runtime/conference-filters',
        'data/runtime/conference-staging-specs',
        'data/runtime/conference-staging-sources',
        'data/runtime/conference-staging',
        'data/runtime/conference-runs',
        'data/runtime/conference-executions',
        'data/runtime/conference-analysis-executions',
        'data/runtime/conference-page-staging',
        'data/runtime/conference-aggregates',
        'data/runtime/conference-processes',
        'data/runtime/conference-queues',
        'data/runtime/conference-publications',
        'data/runtime/conference-source-recovery',
        'data/runtime/historical-page-inventories',
        'data/runtime/page-source-crosswalks',
        'data/runtime/historical-arxiv-batches',
        'data/runtime/historical-analysis-schedulers',
        'data/runtime/historical-postprocess-schedulers',
        'data/runtime/historical-taxonomy-assignments',
        'data/runtime/historical-tag-assignments',
        'data/runtime/historical-page-staging',
        'data/runtime/historical-daily-aggregates',
        'data/runtime/paper-source-authorities',
        'data/archive',
        'logs'
    ]) fs.mkdirSync(path.join(projectRoot, relative), { recursive: true });
    return projectRoot;
}

function writeFile(projectRoot, relative, content = 'x', mtimeMs = OLD_MS) {
    const filePath = path.join(projectRoot, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    const date = new Date(mtimeMs);
    fs.utimesSync(filePath, date, date);
    return filePath;
}

describe('运行时存储状态', () => {
    it('真实状态命令在目录无法读取时保留诊断并以失败状态退出', () => {
        const root = makeProject();
        const locked = path.join(root, 'logs');
        const scripts = path.join(root, 'scripts');
        fs.mkdirSync(scripts);
        const sourceRoot = path.resolve(__dirname, '..', 'scripts');
        fs.copyFileSync(path.join(sourceRoot, 'runtime-storage.js'), path.join(scripts, 'runtime-storage.js'));
        fs.symlinkSync(path.join(sourceRoot, 'env-loader.js'), path.join(scripts, 'env-loader.js'));
        fs.chmodSync(locked, 0o000);
        try {
            const result = require('node:child_process').spawnSync(process.execPath,
                [path.join(scripts, 'runtime-storage.js'), 'status'], { encoding: 'utf8', timeout: 10000 });
            assert.strictEqual(result.status, 1, result.stderr);
            assert.ok(result.stderr.includes(locked));
            assert.match(result.stderr, /EACCES|permission denied/i);
            assert.match(result.stdout, /data\/current/);
        } finally {
            fs.chmodSync(locked, 0o700);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('状态与删除命令拒绝不支持或重复的参数', () => {
        assert.throws(() => main(['prune', '--apply', '--force']), /未知参数/);
        assert.throws(() => main(['prune', '--apply', '--apply']), /重复参数/);
        assert.throws(() => main(['status', '--verbose']), /不接受参数/);
    });
    it('只读统计 current、archive、logs 和重点目录', () => {
        const projectRoot = makeProject();
        try {
            writeFile(projectRoot, 'data/current/image-cache/a.bin', '1234');
            writeFile(projectRoot, 'logs/a.log', '12');
            const status = getStorageStatus({ projectRoot, nowMs: NOW_MS });
            assert.ok(status.targets.some(item => item.key === 'data/current' && item.files === 1 && item.bytes === 4));
            assert.ok(status.targets.some(item => item.key === 'logs' && item.files === 1 && item.bytes === 2));
            assert.ok(status.targets.some(item => item.key === 'data/runtime'));
            assert.strictEqual(fs.existsSync(path.join(projectRoot, 'data/current/image-cache/a.bin')), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('只按官方获取凭证和筛选来源凭证报告重复 PDF，并注明未核验文件字节', () => {
        const projectRoot = makeProject();
        try {
            const pdfBytes = '%PDF-declared-only';
            const declaredHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
            const officialPdf = path.join(projectRoot, 'data/runtime/official-conference-acquisitions/demo-2026/pdfs/1.pdf');
            const officialReceipt = path.join(projectRoot, 'data/runtime/official-conference-acquisitions/demo-2026/receipts/1.json');
            const evidencePdf = path.join(projectRoot, 'data/runtime/conference-filter-evidence-runs/run/items/paper/paper.pdf');
            const evidenceReceipt = path.join(projectRoot, 'data/runtime/conference-filter-evidence-runs/run/items/paper/evidence-receipt.json');
            fs.mkdirSync(path.dirname(officialPdf), { recursive: true });
            fs.mkdirSync(path.dirname(officialReceipt), { recursive: true });
            fs.mkdirSync(path.dirname(evidencePdf), { recursive: true });
            fs.writeFileSync(officialPdf, pdfBytes);
            fs.writeFileSync(evidencePdf, pdfBytes);
            fs.writeFileSync(officialReceipt, JSON.stringify({ pdf: { relativePath: 'pdfs/1.pdf', sha256: declaredHash } }));
            fs.writeFileSync(evidenceReceipt, JSON.stringify({ discovery: { pdfSha256: declaredHash } }));

            const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
            assert.equal(report.hashMode, 'receipt-declared');
            assert.equal(report.byteVerification, false);
            assert.match(report.byteVerificationNote, /未读取 PDF 字节/);
            assert.equal(report.duplicateGroups.length, 1);
            assert.equal(report.duplicateGroups[0].byteVerified, false);
            assert.equal(report.duplicateGroups[0].occurrenceCount, 2);
            assert.equal(fs.readFileSync(officialPdf, 'utf8'), pdfBytes);
            assert.equal(fs.readFileSync(evidencePdf, 'utf8'), pdfBytes);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('--hash-bytes 是显式昂贵模式，并报告 receipt 与实际字节不一致', () => {
        const projectRoot = makeProject();
        try {
            const pdf = writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo-2026/pdfs/1.pdf', '%PDF-real');
            const receipt = path.join(projectRoot, 'data/runtime/official-conference-acquisitions/demo-2026/receipts/1.json');
            fs.mkdirSync(path.dirname(receipt), { recursive: true });
            fs.writeFileSync(receipt, JSON.stringify({ pdf: { relativePath: 'pdfs/1.pdf', sha256: '0'.repeat(64) } }));
            const report = getPdfDuplicateReport({ projectRoot, hashBytes: true, nowMs: NOW_MS });
            const record = report.pdfFiles.find(item => item.path === pdf);
            assert.equal(report.hashMode, 'bytes');
            assert.equal(record.byteVerified, true);
            assert.equal(record.hashSource, 'bytes');
            assert.equal(record.declaredHashMismatch, true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('会议与历史来源账本对状态可见但永不进入自动清理候选', () => {
        const projectRoot = makeProject();
        try {
            const layout = getLayout(projectRoot);
            const protectedKeys = [...CONFERENCE_PROTECTED_KEYS, ...HISTORY_PROTECTED_KEYS];
            assert.deepEqual(layout.protectedRuntime.map(item => item.key).sort(), protectedKeys.slice().sort());
            assert.ok(layout.protectedRuntime.some(item => item.key === 'direct-local-inputs'));
            assert.ok(!layout.protectedRuntime.some(item => item.key === 'historical-direct-rewrite-input-catalogs'));
            const oldFiles = protectedKeys.map(key => writeFile(projectRoot,
                `data/runtime/${key}/old-fixture.bin`, key, NOW_MS - 90 * 24 * 60 * 60 * 1000));
            const status = getStorageStatus({ projectRoot, nowMs: NOW_MS });
            assert.deepEqual(status.targets.filter(item => item.key.startsWith('conference-')).map(item => item.key),
                CONFERENCE_PROTECTED_KEYS.filter(key => key.startsWith('conference-')));
            assert.ok(status.targets.some(item => item.key === 'official-conference-acquisitions'));
            for (const key of protectedKeys) {
                assert.ok(status.targets.some(item => item.key === key && item.files === 1));
            }
            const plan = buildPrunePlan({ projectRoot, nowMs: NOW_MS, retentionDays: 30 });
            for (const oldFile of oldFiles) assert.ok(!plan.candidates.some(item => item.path === oldFile));
            const applied = pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30, apply: true });
            assert.equal(applied.deletedCount, 0);
            for (const [index, oldFile] of oldFiles.entries()) {
                assert.equal(fs.readFileSync(oldFile, 'utf8'), protectedKeys[index]);
            }
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

describe('运行时存储的引用感知清理', () => {
    it('dry-run 列出候选但不删除', () => {
        const projectRoot = makeProject();
        try {
            const oldLog = writeFile(projectRoot, 'logs/old.log', 'old');
            const plan = pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30 });
            assert.strictEqual(plan.mode, 'dry-run');
            assert.ok(plan.candidates.some(item => item.path === oldLog));
            assert.strictEqual(fs.existsSync(oldLog), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('绝对/相对路径和 URL hash 引用都保留旧缓存', () => {
        const projectRoot = makeProject();
        try {
            const relativeCache = writeFile(projectRoot, 'data/current/image-cache/relative.bin');
            const absoluteAsset = writeFile(projectRoot, 'data/current/api-reader-assets/paper/figure.png');
            const url = 'https://arxiv.org/html/2608.00001/figure.png';
            const hash = crypto.createHash('sha256').update(url).digest('hex');
            const hashedCache = writeFile(projectRoot, `data/current/image-cache/${hash}.bin`);
            writeFile(projectRoot, 'data/current/state.json', JSON.stringify({
                cachePath: 'data/current/image-cache/relative.bin',
                assetPath: absoluteAsset,
                sourceUrl: url
            }));

            const plan = buildPrunePlan({ projectRoot, nowMs: NOW_MS, retentionDays: 30 });
            const paths = new Set(plan.candidates.map(item => item.path));
            assert.strictEqual(paths.has(relativeCache), false);
            assert.strictEqual(paths.has(absoluteAsset), false);
            assert.strictEqual(paths.has(hashedCache), false);
            assert.strictEqual(plan.retained.referenced, 3);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('--apply 删除未引用旧缓存、旧日志和 legacy debug，但保留近 30 天文件', () => {
        const projectRoot = makeProject();
        try {
            const oldCache = writeFile(projectRoot, 'data/current/image-cache/old.bin', '1234');
            const oldAsset = writeFile(projectRoot, 'data/current/api-reader-assets/paper/old.png', '12');
            const oldVisual = writeFile(projectRoot, 'data/current/visual-reference-inputs/day/old.png', '1');
            const oldLog = writeFile(projectRoot, 'logs/old.log', '123');
            const manual = writeFile(projectRoot, 'logs/RESUME-PLAYBOOK.md', '# 续跑手册');
            const oldDebug = writeFile(projectRoot, 'data/current/deep_analyzer_input_output/old.json', '{}');
            const recent = writeFile(projectRoot, 'data/current/image-cache/recent.bin', 'recent', NOW_MS - 5 * 24 * 60 * 60 * 1000);
            writeFile(projectRoot, 'data/current/state.json', '{}');

            const result = pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30, apply: true });
            assert.strictEqual(result.mode, 'apply');
            assert.strictEqual(result.deletedCount, 5);
            assert.strictEqual(result.reclaimedBytes, 12);
            for (const filePath of [oldCache, oldAsset, oldVisual, oldLog, oldDebug]) {
                assert.strictEqual(fs.existsSync(filePath), false);
            }
            // logs 根只清理 .log；手册、脚本和证据文件即使过期也必须保留。
            assert.strictEqual(fs.existsSync(manual), true);
            assert.strictEqual(fs.existsSync(recent), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('正式 JSON 数据损坏时，apply 在删除任何文件前停止', () => {
        const projectRoot = makeProject();
        try {
            const oldCache = writeFile(projectRoot, 'data/current/image-cache/old.bin');
            writeFile(projectRoot, 'data/archive/broken.json', '{broken');
            assert.throws(
                () => pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30, apply: true }),
                error => error.code === 'STORAGE_PRUNE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'invalid_json')
            );
            assert.strictEqual(fs.existsSync(oldCache), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('抓取、分析或发布锁的持有进程仍存活时，apply 停止并保留锁', () => {
        const projectRoot = makeProject();
        try {
            const oldCache = writeFile(projectRoot, 'data/current/image-cache/old.bin');
            const lockPath = path.join(projectRoot, 'data/current/.full-fetch-run.lock');
            fs.mkdirSync(lockPath);
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                token: 'fixture'
            }));
            assert.throws(
                () => pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30, apply: true }),
                error => error.code === 'STORAGE_PRUNE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'active_lock')
            );
            assert.strictEqual(fs.existsSync(oldCache), true);
            assert.strictEqual(fs.existsSync(lockPath), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('受控根或引用扫描树中出现 symlink 时 apply 阻断', { skip: process.platform === 'win32' }, () => {
        const projectRoot = makeProject();
        try {
            const oldCache = writeFile(projectRoot, 'data/current/image-cache/old.bin');
            const outside = writeFile(projectRoot, 'outside.txt');
            fs.symlinkSync(outside, path.join(projectRoot, 'data/current/image-cache/link.bin'));
            assert.throws(
                () => pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30, apply: true }),
                error => error.code === 'STORAGE_PRUNE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'symlink')
            );
            assert.strictEqual(fs.existsSync(oldCache), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('缓存引用路径逃逸时 apply 阻断', () => {
        const projectRoot = makeProject();
        try {
            const oldCache = writeFile(projectRoot, 'data/current/image-cache/old.bin');
            writeFile(projectRoot, 'data/current/state.json', JSON.stringify({
                cachePath: '../../outside/image-cache/file.bin'
            }));
            assert.throws(
                () => pruneStorage({ projectRoot, nowMs: NOW_MS, retentionDays: 30, apply: true }),
                error => error.code === 'STORAGE_PRUNE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'path_escape')
            );
            assert.strictEqual(fs.existsSync(oldCache), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

describe('存储保留天数的来源与读取问题', () => {
    function withEnvUnset(run) {
        const saved = process.env.PD_STORAGE_RETENTION_DAYS;
        delete process.env.PD_STORAGE_RETENTION_DAYS;
        try { return run(); } finally {
            if (saved === undefined) delete process.env.PD_STORAGE_RETENTION_DAYS;
            else process.env.PD_STORAGE_RETENTION_DAYS = saved;
        }
    }

    it('.env 里没写这一项时按默认天数，不算读取问题', () => {
        withEnvUnset(() => {
            const projectRoot = makeProject();
            try {
                const plan = buildPrunePlan({ projectRoot, nowMs: NOW_MS,
                    envFile: path.join(projectRoot, 'missing.env') });
                assert.strictEqual(plan.retentionDays, 30);
                assert.strictEqual(plan.retentionSource, 'default');
                assert.strictEqual(plan.retentionReadError, null);
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        });
    });

    it('.env 读得出这一项时照旧用配置值', () => {
        withEnvUnset(() => {
            const projectRoot = makeProject();
            try {
                const envFile = path.join(projectRoot, 'custom.env');
                fs.writeFileSync(envFile, 'PD_STORAGE_RETENTION_DAYS=365\n');
                const plan = buildPrunePlan({ projectRoot, nowMs: NOW_MS, envFile });
                assert.strictEqual(plan.retentionDays, 365);
                assert.strictEqual(plan.retentionSource, 'env');
                assert.strictEqual(plan.retentionReadError, null);
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        });
    });

    it('.env 存在但读不出时，报告读取问题并告警，不和「没配」混在一起', () => {
        withEnvUnset(() => {
            const projectRoot = makeProject();
            const envFile = path.join(projectRoot, 'locked.env');
            fs.writeFileSync(envFile, 'PD_STORAGE_RETENTION_DAYS=365\n');
            fs.chmodSync(envFile, 0o000);
            const warnings = [];
            const originalWarn = console.warn;
            console.warn = message => warnings.push(String(message));
            try {
                const plan = buildPrunePlan({ projectRoot, nowMs: NOW_MS, envFile });
                assert.strictEqual(plan.retentionDays, 30);
                assert.strictEqual(plan.retentionSource, 'default');
                assert.strictEqual(plan.retentionReadError.code, 'EACCES');
                assert.strictEqual(plan.retentionReadError.path, envFile);
                assert.strictEqual(warnings.length, 1);
                assert.match(warnings[0], /读不出/);
                assert.match(warnings[0], /EACCES/);
            } finally {
                console.warn = originalWarn;
                fs.chmodSync(envFile, 0o600);
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        });
    });
});


for (const badIndex of [null, 0, 2]) {
    it(`逐字节核验同一 PDF 的全部来源声明：冲突位置 ${badIndex ?? '无'}`, () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-multiple-receipts';
            const actual = crypto.createHash('sha256').update(bytes).digest('hex');
            const pdf = writeFile(projectRoot, 'data/runtime/multiple-sources/paper.pdf', bytes);
            for (let index = 0; index < 3; index++) {
                fs.writeFileSync(path.join(path.dirname(pdf), `${index}-extraction-receipt.json`),
                    JSON.stringify({ source: { pdf: { file: 'paper.pdf', sha256: index === badIndex ? '0'.repeat(64) : actual } } }));
            }
            const record = getPdfDuplicateReport({ projectRoot, hashBytes: true, nowMs: NOW_MS })
                .pdfFiles.find(item => item.path === pdf);
            assert.equal(record.receiptClaims.length, 3);
            assert.equal(record.hash, actual);
            assert.equal(record.byteVerified, true);
            assert.equal(record.declaredHashMismatch, badIndex !== null);
            assert.equal(fs.readFileSync(pdf, 'utf8'), bytes);
        } finally { fs.rmSync(projectRoot, { recursive: true, force: true }); }
    });
}

describe('运行时重复 PDF 写时复制克隆去重 (pdf-dedupe)', () => {
    it('dry-run 逐字节统计重复组与 logicalDuplicateBytes，且不改变任何文件 inode 或时间戳', () => {
        const projectRoot = makeProject();
        try {
            const bytesA = '%PDF-1.5-duplicate-group-A-content-blocks';
            const bytesB = '%PDF-1.5-duplicate-group-B-content';
            const bytesUnique = '%PDF-1.5-unique-single-file';
            const shaA = crypto.createHash('sha256').update(bytesA).digest('hex');

            const a1 = writeFile(projectRoot, 'data/runtime/conference-filter-evidence-runs/r1/items/p1/paper.pdf', bytesA, OLD_MS);
            const a2 = writeFile(projectRoot, 'data/runtime/conference-sources/s1/paper.pdf', bytesA, OLD_MS + 1000);
            const a3 = writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo/pdfs/1.pdf', bytesA, OLD_MS + 2000);
            writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo/receipts/1.json',
                JSON.stringify({ pdf: { relativePath: 'pdfs/1.pdf', sha256: shaA } }));

            const b1 = writeFile(projectRoot, 'data/runtime/daily-fresh-source-runs/run-1/sources/2601.00001/generation-000001/source.pdf', bytesB, OLD_MS);
            const b2 = writeFile(projectRoot, 'data/runtime/fetched-arxiv-sources/2601.00001/source.pdf', bytesB, OLD_MS + 5000);
            const u1 = writeFile(projectRoot, 'data/runtime/paper-source-authorities/2601.00002/source.pdf', bytesUnique, OLD_MS);

            const beforeStats = [a1, a2, a3, b1, b2, u1].map(file => fs.lstatSync(file));
            const preview = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS });

            assert.strictEqual(preview.mode, 'dry-run');
            assert.strictEqual(preview.hashMode, 'bytes');
            assert.strictEqual(preview.byteVerification, true);
            assert.strictEqual(preview.scannedPdfCount, 6);
            assert.strictEqual(preview.duplicateGroupCount, 2);
            assert.strictEqual(preview.candidateCount, 3);
            assert.strictEqual(preview.dedupedFiles, 0);
            assert.strictEqual(preview.logicalDuplicateBytes, 2 * Buffer.byteLength(bytesA) + 1 * Buffer.byteLength(bytesB));
            assert.deepStrictEqual(preview.blockers, []);

            const afterStats = [a1, a2, a3, b1, b2, u1].map(file => fs.lstatSync(file));
            for (let i = 0; i < beforeStats.length; i += 1) {
                assert.strictEqual(afterStats[i].ino, beforeStats[i].ino);
                assert.strictEqual(afterStats[i].mtimeMs, beforeStats[i].mtimeMs);
                assert.strictEqual(afterStats[i].nlink, 1);
            }
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('--apply 使用 COPYFILE_FICLONE_FORCE / clonefile(2) 克隆替换重复块，保持原字节、SHA-256、size、mode、mtimeMs 与 nlink===1，且重复执行幂等', { skip: process.platform !== 'darwin' }, () => {
        const projectRoot = makeProject();
        try {
            const pdfBytes = Buffer.from('%PDF-1.7-apfs-cow-clone-verification-payload\n'.repeat(64));
            const expectedSha = crypto.createHash('sha256').update(pdfBytes).digest('hex');

            const donor = writeFile(projectRoot, 'data/runtime/conference-filter-evidence-runs/r1/items/p1/paper.pdf', pdfBytes, OLD_MS);
            const targetReadonly = path.join(projectRoot, 'data/runtime/official-conference-acquisitions/demo/pdfs/1.pdf');
            const targetSubMs = path.join(projectRoot, 'data/runtime/daily-fresh-source-runs/d1/sources/1/source.pdf');
            fs.mkdirSync(path.dirname(targetReadonly), { recursive: true });
            fs.mkdirSync(path.dirname(targetSubMs), { recursive: true });
            fs.writeFileSync(targetReadonly, pdfBytes, { mode: 0o444 });
            const customDate = new Date('2026-06-15T08:30:45.678Z');
            fs.utimesSync(targetReadonly, customDate, customDate);
            // targetSubMs 不调 utimesSync，保留 APFS 原生亚毫秒时间戳与 0o640 权限
            fs.writeFileSync(targetSubMs, pdfBytes, { mode: 0o640 });
            fs.chmodSync(targetSubMs, 0o640);

            writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo/receipts/1.json',
                JSON.stringify({ pdf: { relativePath: 'pdfs/1.pdf', sha256: expectedSha } }));
            writeFile(projectRoot, 'data/runtime/conference-filter-evidence-runs/r1/items/p1/evidence-receipt.json',
                JSON.stringify({ discovery: { pdfSha256: expectedSha } }));

            const donorBefore = fs.lstatSync(donor);
            const roBefore = fs.lstatSync(targetReadonly);
            const subMsBefore = fs.lstatSync(targetSubMs);

            const applied = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true });
            assert.strictEqual(applied.mode, 'apply');
            assert.strictEqual(applied.duplicateGroupCount, 1);
            assert.strictEqual(applied.dedupedFiles, 2);
            assert.strictEqual(applied.logicalDuplicateBytes, 2 * pdfBytes.length);
            assert.deepStrictEqual(applied.blockers, []);

            const donorAfter = fs.lstatSync(donor);
            const roAfter = fs.lstatSync(targetReadonly);
            const subMsAfter = fs.lstatSync(targetSubMs);

            // 基准文件完全未改；两个目标文件均换上新独立 CoW inode（非硬链接，nlink === 1）
            assert.strictEqual(donorAfter.ino, donorBefore.ino);
            assert.notStrictEqual(roAfter.ino, roBefore.ino);
            assert.notStrictEqual(subMsAfter.ino, subMsBefore.ino);
            assert.notStrictEqual(roAfter.ino, donorAfter.ino);
            assert.notStrictEqual(subMsAfter.ino, donorAfter.ino);
            assert.notStrictEqual(roAfter.ino, subMsAfter.ino);

            for (const [before, after, filePath, expectedMode] of [
                [donorBefore, donorAfter, donor, donorBefore.mode & 0o777],
                [roBefore, roAfter, targetReadonly, 0o444],
                [subMsBefore, subMsAfter, targetSubMs, 0o640]
            ]) {
                assert.strictEqual(after.nlink, 1);
                assert.strictEqual(after.size, pdfBytes.length);
                assert.strictEqual(after.mode & 0o777, expectedMode);
                assert.strictEqual(after.mtimeMs, before.mtimeMs);
                const actualBytes = fs.readFileSync(filePath);
                assert.strictEqual(actualBytes.equals(pdfBytes), true);
                assert.strictEqual(crypto.createHash('sha256').update(actualBytes).digest('hex'), expectedSha);
            }

            // 确认目录中未遗留任何临时文件
            for (const dir of [path.dirname(donor), path.dirname(targetReadonly), path.dirname(targetSubMs)]) {
                assert.strictEqual(fs.readdirSync(dir).some(name => name.startsWith('.pdf-dedupe-')), false);
            }

            // 再次运行 --apply 保持安全幂等
            const secondRun = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true });
            assert.strictEqual(secondRun.mode, 'apply');
            assert.strictEqual(secondRun.duplicateGroupCount, 1);
            assert.strictEqual(secondRun.dedupedFiles, 2);
            assert.strictEqual(secondRun.logicalDuplicateBytes, 2 * pdfBytes.length);
            assert.strictEqual(fs.lstatSync(targetReadonly).nlink, 1);
            assert.strictEqual(fs.lstatSync(targetSubMs).nlink, 1);
        } finally {
            for (const rel of [
                'data/runtime/official-conference-acquisitions/demo/pdfs/1.pdf',
                'data/runtime/daily-fresh-source-runs/d1/sources/1/source.pdf'
            ]) {
                const full = path.join(projectRoot, rel);
                if (fs.existsSync(full)) fs.chmodSync(full, 0o600);
            }
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('data/runtime 存在符号链接时 --apply 阻断且不修改任何文件', { skip: process.platform === 'win32' }, () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-symlink-blocker';
            const donor = writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target = writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            const outside = writeFile(projectRoot, 'outside.pdf', bytes);
            fs.symlinkSync(outside, path.join(projectRoot, 'data/runtime/link.txt'));

            const targetBefore = fs.lstatSync(target);
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                error => error.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'symlink')
            );
            assert.strictEqual(fs.lstatSync(donor).nlink, 1);
            assert.strictEqual(fs.lstatSync(target).ino, targetBefore.ino);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('来源凭证声明的 SHA 与 PDF 实际字节不符时 --apply 阻断', () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-mismatch-blocker';
            const donor = writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target = writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo/pdfs/1.pdf', bytes);
            writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo/receipts/1.json',
                JSON.stringify({ pdf: { relativePath: 'pdfs/1.pdf', sha256: 'f'.repeat(64) } }));

            const donorBefore = fs.lstatSync(donor);
            const targetBefore = fs.lstatSync(target);
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                error => error.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'declared_hash_mismatch')
            );
            assert.strictEqual(fs.lstatSync(donor).ino, donorBefore.ino);
            assert.strictEqual(fs.lstatSync(target).ino, targetBefore.ino);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('存在存活运行锁时 --apply 阻断且保留锁与原文件', () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-lock-blocker';
            const donor = writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target = writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            const lockPath = path.join(projectRoot, 'data/current/.full-fetch-run.lock');
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                token: 'live-lock'
            }));

            const targetBefore = fs.lstatSync(target);
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                error => error.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'active_lock')
            );
            assert.strictEqual(fs.lstatSync(donor).nlink, 1);
            assert.strictEqual(fs.lstatSync(target).ino, targetBefore.ino);
            assert.strictEqual(fs.existsSync(lockPath), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('扫描后或克隆期间目标文件发生变化时 --apply 阻断并清理临时文件', () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-race-check';
            writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target = writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);

            // 场景 A：初始扫描后、真正克隆前目标文件被修改
            assert.throws(
                () => dedupeRuntimePdfs({
                    projectRoot,
                    nowMs: NOW_MS,
                    apply: true,
                    beforeApply: () => {
                        fs.writeFileSync(target, '%PDF-mutated-before-apply');
                    }
                }),
                error => error.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'changed')
            );
            assert.strictEqual(fs.readFileSync(target, 'utf8'), '%PDF-mutated-before-apply');

            // 场景 B：恢复相同字节后，在 cloneFileSync 执行期间目标文件并发变化，拒绝原子重命名并清理临时文件
            writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            assert.throws(
                () => dedupeRuntimePdfs({
                    projectRoot,
                    nowMs: NOW_MS,
                    apply: true,
                    cloneFileSync: (src, dst) => {
                        fs.copyFileSync(src, dst);
                        fs.appendFileSync(target, '\n%concurrent-mutation');
                    }
                }),
                error => error.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && error.plan.blockers.some(item => item.type === 'changed')
            );
            assert.strictEqual(fs.readFileSync(target, 'utf8'), `${bytes}\n%concurrent-mutation`);
            assert.strictEqual(fs.readdirSync(path.dirname(target)).some(name => name.startsWith('.pdf-dedupe-')), false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('cloneFileSync 抛出 ENOTSUP 时 fail-closed 停止，保留原文件完整并清理残留临时文件', () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-enotsup-check';
            const donor = writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target = writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            const donorBefore = fs.lstatSync(donor);
            const targetBefore = fs.lstatSync(target);

            assert.throws(
                () => dedupeRuntimePdfs({
                    projectRoot,
                    nowMs: NOW_MS,
                    apply: true,
                    cloneFileSync: (_src, dst) => {
                        // 模拟先留下半截临时文件再报 ENOTSUP，验证 finally 必清理临时文件
                        fs.writeFileSync(dst, 'partial');
                        const err = new Error('operation not supported on filesystem');
                        err.code = 'ENOTSUP';
                        throw err;
                    }
                }),
                error => error.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && error.causeCode === 'ENOTSUP'
                    && error.plan.blockers.some(item => item.type === 'clone_failed' && item.code === 'ENOTSUP')
            );

            const targetAfter = fs.lstatSync(target);
            assert.strictEqual(fs.lstatSync(donor).ino, donorBefore.ino);
            assert.strictEqual(targetAfter.ino, targetBefore.ino);
            assert.strictEqual(targetAfter.mtimeMs, targetBefore.mtimeMs);
            assert.strictEqual(fs.readFileSync(target, 'utf8'), bytes);
            assert.strictEqual(fs.readdirSync(path.dirname(target)).some(name => name.startsWith('.pdf-dedupe-')), false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('CLI 校验 pdf-dedupe 未知/重复参数，并支持 --json 输出', () => {
        assert.throws(() => main(['pdf-dedupe', '--unknown']), /pdf-dedupe 未知参数/);
        assert.throws(() => main(['pdf-dedupe', '--hash-bytes']), /pdf-dedupe 未知参数/);
        assert.throws(() => main(['pdf-dedupe', '--apply', '--apply']), /pdf-dedupe 重复参数/);
        assert.throws(() => main(['pdf-dedupe', '--json', '--json']), /pdf-dedupe 重复参数/);
        assert.throws(() => main(['unknown-subcommand']), /pdf-dedupe/);

        const projectRoot = makeProject();
        const logs = [];
        const originalLog = console.log;
        console.log = message => logs.push(String(message));
        try {
            const bytes = '%PDF-cli-json-check';
            writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            const plan = buildPdfDedupePlan({ projectRoot, nowMs: NOW_MS });
            const returned = main(['pdf-dedupe', '--json'], { projectRoot, nowMs: NOW_MS });
            assert.strictEqual(logs.length, 1);
            const parsed = JSON.parse(logs[0]);
            assert.strictEqual(parsed.contract, 'runtime-storage-pdf-dedupe-v1');
            assert.strictEqual(parsed.mode, 'dry-run');
            assert.strictEqual(parsed.duplicateGroupCount, 1);
            assert.strictEqual(parsed.logicalDuplicateBytes, Buffer.byteLength(bytes));
            assert.strictEqual(returned.logicalDuplicateBytes, plan.logicalDuplicateBytes);
        } finally {
            console.log = originalLog;
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('defaultCloneFileSync 强制要求 COPYFILE_FICLONE_FORCE | COPYFILE_EXCL 且拒绝符号链接源与任何已存在目标（目录/悬空链接/普通文件）', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ficlone-excl-test-'));
        try {
            const src = path.join(dir, 'src.pdf');
            const dstMock = path.join(dir, 'dst-mock.pdf');
            fs.writeFileSync(src, '%PDF-1.4 donor');

            const calls = [];
            defaultCloneFileSync(src, dstMock, {
                constants: { COPYFILE_FICLONE_FORCE: 4, COPYFILE_EXCL: 1 },
                copyFileSync: (s, d, flags) => calls.push({ src: s, dst: d, flags })
            });
            assert.deepStrictEqual(calls, [{ src, dst: dstMock, flags: 4 | 1 }]);

            assert.throws(
                () => defaultCloneFileSync(src, dstMock, {
                    constants: { COPYFILE_FICLONE_FORCE: 0, COPYFILE_EXCL: 1 },
                    copyFileSync: () => assert.fail('missing FICLONE_FORCE must fail closed')
                }),
                err => err.code === 'ENOTSUP'
            );
            assert.throws(
                () => defaultCloneFileSync(src, dstMock, {
                    constants: { COPYFILE_FICLONE_FORCE: 4, COPYFILE_EXCL: 0 },
                    copyFileSync: () => assert.fail('missing COPYFILE_EXCL must fail closed')
                }),
                err => err.code === 'ENOTSUP'
            );

            // 1) dst 为已存在目录：抛 EEXIST 且目录保持为空（绝不写入 existingDir/src.pdf）
            const existingDir = path.join(dir, 'existing-dir');
            fs.mkdirSync(existingDir);
            assert.throws(() => defaultCloneFileSync(src, existingDir), err => err.code === 'EEXIST');
            assert.deepStrictEqual(fs.readdirSync(existingDir), []);

            // 2) dst 为已存在普通文件：抛 EEXIST 且原字节不变
            const existingFile = path.join(dir, 'existing-file.pdf');
            fs.writeFileSync(existingFile, 'original-target-bytes');
            assert.throws(() => defaultCloneFileSync(src, existingFile), err => err.code === 'EEXIST');
            assert.strictEqual(fs.readFileSync(existingFile, 'utf8'), 'original-target-bytes');

            if (process.platform !== 'win32') {
                // 3) dst 为指向真实文件的符号链接：抛 EEXIST 且被指向文件未受影响
                const victim = path.join(dir, 'victim.txt');
                const symDst = path.join(dir, 'dst-sym.tmp');
                fs.writeFileSync(victim, 'victim-intact');
                fs.symlinkSync(victim, symDst);
                assert.throws(() => defaultCloneFileSync(src, symDst), err => err.code === 'EEXIST');
                assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'victim-intact');

                // 4) dst 为悬空符号链接：抛 EEXIST 且不会顺着悬空目标创建文件
                const missingTarget = path.join(dir, 'dangling-target.pdf');
                const danglingSym = path.join(dir, 'dst-dangling.tmp');
                fs.symlinkSync(missingTarget, danglingSym);
                assert.throws(() => defaultCloneFileSync(src, danglingSym), err => err.code === 'EEXIST');
                assert.strictEqual(fs.existsSync(missingTarget), false);

                // 5) src 为符号链接：抛 ELOOP 且不创建 dst
                const symSrc = path.join(dir, 'src-sym.pdf');
                const freshDst = path.join(dir, 'fresh-dst.pdf');
                fs.symlinkSync(src, symSrc);
                assert.throws(() => defaultCloneFileSync(symSrc, freshDst), err => err.code === 'ELOOP');
                assert.strictEqual(fs.lstatSync(freshDst, { throwIfNoEntry: false }), undefined);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('凭证或清单声明的 PDF 文件缺失（missingDeclaredPdfCount > 0）时 --apply 阻断', () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-missing-declared-check';
            const sha = crypto.createHash('sha256').update(bytes).digest('hex');
            writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/demo/receipts/missing.json',
                JSON.stringify({ pdf: { relativePath: 'pdfs/missing.pdf', sha256: sha } }));

            const preview = buildPdfDedupePlan({ projectRoot, nowMs: NOW_MS });
            assert.strictEqual(preview.missingDeclaredPdfCount, 1);
            assert.strictEqual(preview.blockers.some(item => item.type === 'missing_declared_pdf'), true);

            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.mode === 'apply'
                    && err.plan.blockers.some(item => item.type === 'missing_declared_pdf')
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('source-manifest.json、conference-ledgers 与历史 OpenReview 凭证 SHA 失配均触发阻断', () => {
        // 1) daily-fresh-source-runs / fetched-arxiv-sources 的 source-manifest.json
        for (const rootKey of ['daily-fresh-source-runs/run1/sources/2601.00001/generation-000001', 'fetched-arxiv-sources/2601.00001/generation-000001']) {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-manifest-mismatch';
                writeFile(projectRoot, 'data/runtime/other/donor.pdf', bytes);
                writeFile(projectRoot, `data/runtime/${rootKey}/source.pdf`, bytes);
                writeFile(projectRoot, `data/runtime/${rootKey}/source-manifest.json`, JSON.stringify({
                    pdf: { filename: 'source.pdf', responseSha256: 'a'.repeat(64) }
                }));
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'declared_hash_mismatch')
                );

                // pdf: null 或缺失 pdf 字段的损坏 source-manifest.json 同样报 invalid_receipt 阻断
                writeFile(projectRoot, `data/runtime/${rootKey}/source-manifest.json`, JSON.stringify({
                    pdf: null
                }));
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'invalid_receipt')
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 2) conference-ledgers/*.json 指向 conference-sources
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-ledger-mismatch';
                writeFile(projectRoot, 'data/runtime/other/donor.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/conference-sources/iclr-2026/p1/pdf.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/conference-ledgers/iclr-2026.json', JSON.stringify({
                    members: [{
                        availability: { pdf: 'present' },
                        pdfFile: 'iclr-2026/p1/pdf.pdf',
                        pdfSha256: 'b'.repeat(64)
                    }]
                }));
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'declared_hash_mismatch')
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 3) historical-openreview-pdf-sources 指向 historical-icml-pdf-sources（含 realpath 形式绝对路径）
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-openreview-mismatch';
                writeFile(projectRoot, 'data/runtime/other/donor.pdf', bytes);
                const icmlPdf = writeFile(projectRoot, 'data/runtime/historical-icml-pdf-sources/forum123.pdf', bytes);
                const realIcmlPdf = fs.realpathSync(icmlPdf);
                writeFile(projectRoot, 'data/runtime/historical-openreview-pdf-sources/forum123.json', JSON.stringify({
                    pdf: { absolutePath: realIcmlPdf, bytes: Buffer.byteLength(bytes), sha256: 'c'.repeat(64) }
                }));
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'declared_hash_mismatch')
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }
    });

    it('非 %PDF- 头部、过短 .pdf 文件及残留 .pdf-dedupe-*.tmp 均在扫描阶段阻断 --apply', () => {
        const projectRoot = makeProject();
        try {
            writeFile(projectRoot, 'data/runtime/a/bad1.pdf', 'HTML-not-a-pdf-content');
            writeFile(projectRoot, 'data/runtime/b/bad2.pdf', 'HTML-not-a-pdf-content');
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => item.type === 'unsafe_pdf')
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }

        const projectRoot2 = makeProject();
        try {
            const validBytes = '%PDF-valid-header';
            writeFile(projectRoot2, 'data/runtime/a/1.pdf', validBytes);
            writeFile(projectRoot2, 'data/runtime/b/2.pdf', validBytes);
            writeFile(projectRoot2, 'data/runtime/b/.pdf-dedupe-99999-stale.tmp', validBytes);
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot: projectRoot2, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => item.type === 'leftover_temp')
            );
        } finally {
            fs.rmSync(projectRoot2, { recursive: true, force: true });
        }
    });

    it('祖先目录 <projectRoot>/data 为符号链接时 --apply 阻断', { skip: process.platform === 'win32' }, () => {
        const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestor-symlink-test-'));
        try {
            const realData = path.join(outer, 'real-data');
            const projectRoot = path.join(outer, 'workspace');
            fs.mkdirSync(path.join(realData, 'current'), { recursive: true });
            fs.mkdirSync(path.join(realData, 'runtime', 'a'), { recursive: true });
            fs.mkdirSync(path.join(realData, 'runtime', 'b'), { recursive: true });
            fs.writeFileSync(path.join(realData, 'runtime', 'a', '1.pdf'), '%PDF-ancestor-check');
            fs.writeFileSync(path.join(realData, 'runtime', 'b', '2.pdf'), '%PDF-ancestor-check');
            fs.mkdirSync(projectRoot, { recursive: true });
            fs.symlinkSync(realData, path.join(projectRoot, 'data'));

            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => item.type === 'symlink')
            );
        } finally {
            fs.rmSync(outer, { recursive: true, force: true });
        }
    });

    it('硬链接重复 PDF（nlink > 1）与跨设备（dev 不一致）重复项均阻断 --apply', { skip: process.platform === 'win32' }, () => {
        // 1) nlink > 1
        const projectRoot = makeProject();
        try {
            const p1 = writeFile(projectRoot, 'data/runtime/a/1.pdf', '%PDF-hardlink-test');
            const p2 = path.join(projectRoot, 'data/runtime/b/2.pdf');
            fs.mkdirSync(path.dirname(p2), { recursive: true });
            fs.linkSync(p1, p2);
            assert.strictEqual(fs.lstatSync(p1).nlink, 2);

            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => item.type === 'unsafe_pdf')
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }

        // 2) 跨设备 dev 不一致
        const projectRoot2 = makeProject();
        const origLstat = fs.lstatSync;
        const origFstat = fs.fstatSync;
        try {
            writeFile(projectRoot2, 'data/runtime/a/1.pdf', '%PDF-cross-dev-test');
            const target = writeFile(projectRoot2, 'data/runtime/b/2.pdf', '%PDF-cross-dev-test');
            const realTargetIno = origLstat(target).ino;
            fs.lstatSync = function (p, ...rest) {
                const st = origLstat.call(fs, p, ...rest);
                if (path.resolve(String(p)) === path.resolve(target)) {
                    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 999 });
                }
                return st;
            };
            fs.fstatSync = function (fd, ...rest) {
                const st = origFstat.call(fs, fd, ...rest);
                if (st.ino === realTargetIno) {
                    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 999 });
                }
                return st;
            };

            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot: projectRoot2, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => item.type === 'cross_device')
            );
        } finally {
            fs.lstatSync = origLstat;
            fs.fstatSync = origFstat;
            fs.rmSync(projectRoot2, { recursive: true, force: true });
        }
    });

    it('文件型 .lock、.lock.reclaim、共享博客锁及不可读 0o000 data/current 均阻断 --apply', { skip: process.platform === 'win32' }, () => {
        // 1) data/runtime 中的普通文件 .lock、.lock.reclaim 及目录锁内的 .reclaiming.json
        for (const lockRel of [
            'data/runtime/llm-usage/pool.lock',
            'data/current/state.json.lock.reclaim',
            'data/current/.analysis-runs/p1.lock/.reclaiming.json'
        ]) {
            const projectRoot = makeProject();
            try {
                writeFile(projectRoot, 'data/runtime/a/1.pdf', '%PDF-file-lock-check');
                writeFile(projectRoot, 'data/runtime/b/2.pdf', '%PDF-file-lock-check');
                writeFile(projectRoot, lockRel, '');
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'active_lock')
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 2) 共享博客锁 blog-publication.lock
        {
            const projectRoot = makeProject();
            const fakeBlogRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-blog-repo-'));
            try {
                writeFile(projectRoot, 'data/runtime/a/1.pdf', '%PDF-shared-blog-lock');
                writeFile(projectRoot, 'data/runtime/b/2.pdf', '%PDF-shared-blog-lock');
                const commonGit = path.join(fs.realpathSync(fakeBlogRepo), '.git');
                const sharedLockDir = path.join(commonGit, '.paper-digest-locks', 'blog-publication.lock');
                fs.mkdirSync(sharedLockDir, { recursive: true });
                fs.writeFileSync(path.join(sharedLockDir, 'owner.json'), JSON.stringify({
                    pid: process.pid,
                    hostname: os.hostname()
                }));
                const envFile = path.join(projectRoot, '.env');
                fs.writeFileSync(envFile, `PAPER_DIGEST_BLOG_REPO=${fakeBlogRepo}\n`, { mode: 0o600 });

                assert.throws(
                    () => dedupeRuntimePdfs({
                        projectRoot,
                        nowMs: NOW_MS,
                        envFile,
                        spawnSync: () => ({ status: 0, stdout: `${commonGit}\n`, stderr: '' }),
                        apply: true
                    }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'active_lock')
                );
                assert.strictEqual(fs.statSync(envFile).mode & 0o777, 0o600);
            } finally {
                fs.rmSync(fakeBlogRepo, { recursive: true, force: true });
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 3) data/current 权限 0o000 不可读
        {
            const projectRoot = makeProject();
            const currentDir = path.join(projectRoot, 'data/current');
            try {
                writeFile(projectRoot, 'data/runtime/a/1.pdf', '%PDF-unreadable-current');
                writeFile(projectRoot, 'data/runtime/b/2.pdf', '%PDF-unreadable-current');
                fs.chmodSync(currentDir, 0o000);
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'active_lock_unknown')
                );
            } finally {
                fs.chmodSync(currentDir, 0o700);
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }
    });

    it('apply 中途第 k 个文件失败时，error.plan 准确记录 mode=apply 与已完成的 k-1 个 dedupedFiles，且打印不含预览文案', () => {
        const projectRoot = makeProject();
        const logs = [];
        const origLog = console.log;
        try {
            const bytes = '%PDF-partial-apply-progress';
            const donor = writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target1 = writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            const target2 = writeFile(projectRoot, 'data/runtime/c/3.pdf', bytes);
            const target1Before = fs.lstatSync(target1);
            const target2Before = fs.lstatSync(target2);

            let calls = 0;
            let capturedError = null;
            try {
                dedupeRuntimePdfs({
                    projectRoot,
                    nowMs: NOW_MS,
                    apply: true,
                    cloneFileSync: (src, dst) => {
                        calls += 1;
                        if (calls === 1) {
                            fs.copyFileSync(src, dst);
                            return;
                        }
                        const err = new Error('second clone failed');
                        err.code = 'ENOTSUP';
                        throw err;
                    }
                });
            } catch (error) {
                capturedError = error;
            }

            assert.ok(capturedError);
            assert.strictEqual(capturedError.code, 'STORAGE_PDF_DEDUPE_BLOCKED');
            assert.strictEqual(capturedError.plan.mode, 'apply');
            assert.strictEqual(capturedError.plan.dedupedFiles, 1);
            assert.strictEqual(capturedError.plan.dedupedItems.length, 1);
            assert.strictEqual(capturedError.plan.dedupedItems[0].donorPath, donor);
            assert.strictEqual(capturedError.plan.dedupedItems[0].targetPath, target1);

            // 第 1 个目标已完成替换，第 2 个目标保持原 inode 未改动，且无残留临时文件
            assert.notStrictEqual(fs.lstatSync(target1).ino, target1Before.ino);
            assert.strictEqual(fs.lstatSync(target2).ino, target2Before.ino);
            assert.strictEqual(fs.readdirSync(path.dirname(target2)).some(name => name.startsWith('.pdf-dedupe-')), false);

            console.log = message => logs.push(String(message));
            printPdfDedupeResult(capturedError.plan, { verbose: true });
            const combined = logs.join('\n');
            assert.match(combined, /PDF 克隆去重（执行）/);
            assert.match(combined, /已完成写时复制克隆替换 1 个重复 PDF/);
            assert.doesNotMatch(combined, /预览/);
        } finally {
            console.log = origLog;
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('新版 -<impl12>-ledger.json 解析 generation-<impl64> 下 PDF（含重复报告、dry-run、--apply、SHA 失配及 0/2 候选阻断）', () => {
        // 1) 正常唯一匹配 generation-<impl64>（同时存在 *-plan.json、*.import-receipt.json 与旧版 v1 文本提取账本）
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-modern-conference-ledger-payload';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                const impl12 = '692ff151eb4e';
                const impl64 = `${impl12}31d6277b1d19f26696bca9e34b2eecec14cbdd68b8d953084a8a`;
                const officialPdf = writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/aaai-2026/pdfs/36960.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/official-conference-acquisitions/aaai-2026/receipts/36960.json',
                    JSON.stringify({ pdf: { relativePath: 'pdfs/36960.pdf', sha256: sha } }));
                const genPdf = writeFile(
                    projectRoot,
                    `data/runtime/conference-sources/generation-${impl64}/aaai-2026-2026/conference-paper-id--36960/pdf.pdf`,
                    bytes
                );
                const legacyPdf = writeFile(
                    projectRoot,
                    'data/runtime/conference-sources/aistats-2026-2026/conference-paper-id--naderi26a/pdf.pdf',
                    bytes
                );
                writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/aaai-2026-24d8bedc0805fbb0-${impl12}-ledger.json`,
                    JSON.stringify({
                        version: 'conference-source-ledger-v1',
                        conference: { id: 'aaai-2026', year: 2026 },
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'aaai-2026-2026/conference-paper-id--36960/pdf.pdf',
                            pdfSha256: sha,
                            provenance: {
                                text: { extractor: 'audio-paper-digest-conference-structured' },
                                artifacts: { extractor: 'audio-paper-digest-conference-structured' }
                            }
                        }]
                    })
                );
                writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/aaai-2026-24d8bedc0805fbb0-${impl12}-ledger.import-receipt.json`,
                    JSON.stringify({ contract: 'conference-import-receipt-v2' })
                );
                writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/aaai-2026-24d8bedc0805fbb0-${impl12}-plan.json`,
                    JSON.stringify({ contract: 'conference-run-plan-v2', shards: [] })
                );
                writeFile(
                    projectRoot,
                    'data/runtime/conference-ledgers/aistats-2026-4b721395564a9444-087f1b43b1ad-ledger.json',
                    JSON.stringify({
                        version: 'conference-source-ledger-v1',
                        conference: { id: 'aistats-2026', year: 2026 },
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'aistats-2026-2026/conference-paper-id--naderi26a/pdf.pdf',
                            pdfSha256: sha,
                            provenance: {
                                text: { extractor: 'audio-paper-digest-conference-text' },
                                artifacts: { extractor: 'audio-paper-digest-conference-text' }
                            }
                        }]
                    })
                );

                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.deepStrictEqual(report.blockers, []);
                assert.strictEqual(report.missingDeclaredPdfCount, 0);
                assert.strictEqual(report.unboundPdfCount, 0);
                assert.strictEqual(report.declaredPdfCount, 3);
                assert.strictEqual(report.duplicateGroups.length, 1);
                assert.strictEqual(report.duplicateGroups[0].occurrenceCount, 3);

                const dryRun = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(dryRun.mode, 'dry-run');
                assert.deepStrictEqual(dryRun.blockers, []);
                assert.strictEqual(dryRun.missingDeclaredPdfCount, 0);
                assert.strictEqual(dryRun.duplicateGroupCount, 1);
                assert.strictEqual(dryRun.candidateCount, 2);

                if (process.platform === 'darwin') {
                    const applied = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true });
                    assert.strictEqual(applied.mode, 'apply');
                    assert.deepStrictEqual(applied.blockers, []);
                    assert.strictEqual(applied.dedupedFiles, 2);
                    for (const p of [officialPdf, genPdf, legacyPdf]) {
                        assert.strictEqual(fs.lstatSync(p).nlink, 1);
                        assert.strictEqual(fs.readFileSync(p, 'utf8'), bytes);
                    }
                }
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 2) generation-<impl64> 下 PDF 字节与账本声明 SHA-256 不符时触发 declared_hash_mismatch 阻断
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-modern-ledger-sha-mismatch';
                const impl12 = '815baba0ef85';
                const impl64 = `${impl12}cbe1c75149e307315ef7697335dfd92a97a8b8fcebbdedf8117a`;
                writeFile(projectRoot, 'data/runtime/other/donor.pdf', bytes);
                writeFile(
                    projectRoot,
                    `data/runtime/conference-sources/generation-${impl64}/cvpr-2026-2026/p1/pdf.pdf`,
                    bytes
                );
                writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/cvpr-2026-ecf63e8e1b1018bf-${impl12}-ledger.json`,
                    JSON.stringify({
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'cvpr-2026-2026/p1/pdf.pdf',
                            pdfSha256: 'd'.repeat(64)
                        }]
                    })
                );
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'declared_hash_mismatch')
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 3) 0 个匹配 generation-* 目录时触发 invalid_receipt 阻断（不静默跳过核验）
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-modern-ledger-zero-gen';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                const impl12 = 'abcdef012345';
                writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
                const ledgerPath = writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/icml-2026-1111222233334444-${impl12}-ledger.json`,
                    JSON.stringify({
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'icml-2026-2026/p1/pdf.pdf',
                            pdfSha256: sha
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'invalid_receipt' && item.path === ledgerPath), true);
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'invalid_receipt' && item.path === ledgerPath)
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 4) 2 个匹配 generation-* 目录时触发 invalid_receipt 阻断
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-modern-ledger-two-gens';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                const impl12 = 'fedcba987654';
                const genA = `generation-${impl12}${'a'.repeat(52)}`;
                const genB = `generation-${impl12}${'b'.repeat(52)}`;
                writeFile(projectRoot, `data/runtime/conference-sources/${genA}/neurips-2026-2026/p1/pdf.pdf`, bytes);
                writeFile(projectRoot, `data/runtime/conference-sources/${genB}/neurips-2026-2026/p1/pdf.pdf`, bytes);
                const ledgerPath = writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/neurips-2026-5555666677778888-${impl12}-ledger.json`,
                    JSON.stringify({
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'neurips-2026-2026/p1/pdf.pdf',
                            pdfSha256: sha
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'invalid_receipt' && item.path === ledgerPath), true);
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'invalid_receipt' && item.path === ledgerPath)
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 5) 匹配的 generation-* 为符号链接时触发 symlink 阻断
        if (process.platform !== 'win32') {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-modern-ledger-symlink-gen';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                const impl12 = '012345abcdef';
                const genSym = `generation-${impl12}${'c'.repeat(52)}`;
                const realDir = path.join(projectRoot, 'outside-gen');
                fs.mkdirSync(path.join(realDir, 'iclr-2026-2026/p1'), { recursive: true });
                fs.writeFileSync(path.join(realDir, 'iclr-2026-2026/p1/pdf.pdf'), bytes);
                fs.symlinkSync(realDir, path.join(projectRoot, `data/runtime/conference-sources/${genSym}`));
                const ledgerPath = writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/iclr-2026-9999aaaabbbbcccc-${impl12}-ledger.json`,
                    JSON.stringify({
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'iclr-2026-2026/p1/pdf.pdf',
                            pdfSha256: sha
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'symlink' && item.path === ledgerPath), true);
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 6) pdfFile 含 .. 路径逃逸段（'aistats-2026-2026/../other/pdf.pdf' 与 '../../outside.pdf'）均产生 path_escape 并阻断 --apply
        for (const badPdfFile of ['aistats-2026-2026/../other/pdf.pdf', '../../outside.pdf']) {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-traversal-blocker';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/conference-sources/aistats-2026-2026/p1/pdf.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/conference-sources/other/pdf.pdf', bytes);
                const ledgerPath = writeFile(
                    projectRoot,
                    'data/runtime/conference-ledgers/aistats-2026-4b721395564a9444-087f1b43b1ad-ledger.json',
                    JSON.stringify({
                        version: 'conference-source-ledger-v1',
                        conference: { id: 'aistats-2026', year: 2026 },
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: badPdfFile,
                            pdfSha256: sha,
                            provenance: {
                                text: { extractor: 'audio-paper-digest-conference-text' },
                                artifacts: { extractor: 'audio-paper-digest-conference-text' }
                            }
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'path_escape' && item.path === ledgerPath), true);
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'path_escape' && item.path === ledgerPath)
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 7) 伪造混合头（version: 'conference-source-ledger-v1' + contract: 'conference-source-ledger'）且 0 个 generation-* 时以 invalid_receipt 阻断
        {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-hybrid-header-blocker';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
                writeFile(projectRoot, 'data/runtime/conference-sources/aistats-2026-2026/p1/pdf.pdf', bytes);
                const ledgerPath = writeFile(
                    projectRoot,
                    'data/runtime/conference-ledgers/aistats-2026-4b721395564a9444-087f1b43b1ad-ledger.json',
                    JSON.stringify({
                        version: 'conference-source-ledger-v1',
                        contract: 'conference-source-ledger',
                        conference: { id: 'aistats-2026', year: 2026 },
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'aistats-2026-2026/p1/pdf.pdf',
                            pdfSha256: sha,
                            provenance: {
                                text: { extractor: 'audio-paper-digest-conference-text' },
                                artifacts: { extractor: 'audio-paper-digest-conference-text' }
                            }
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'invalid_receipt' && item.path === ledgerPath), true);
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'invalid_receipt' && item.path === ledgerPath)
                );
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }
        }

        // 8) generation-<impl64> 下中间目录为符号链接，或旧版非 -<impl12>-ledger.json 遇到符号链接 conference-sources 时均触发 symlink 阻断
        if (process.platform !== 'win32') {
            const projectRoot = makeProject();
            try {
                const bytes = '%PDF-1.6-intermediate-symlink-blocker';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                const impl12 = '112233445566';
                const genDir = `generation-${impl12}${'d'.repeat(52)}`;
                const outsideSubdir = path.join(projectRoot, 'outside-sub');
                fs.mkdirSync(outsideSubdir, { recursive: true });
                fs.writeFileSync(path.join(outsideSubdir, 'pdf.pdf'), bytes);
                const genConfRoot = path.join(projectRoot, `data/runtime/conference-sources/${genDir}/iclr-2026-2026`);
                fs.mkdirSync(genConfRoot, { recursive: true });
                fs.symlinkSync(outsideSubdir, path.join(genConfRoot, 'p1'));
                const ledgerPath = writeFile(
                    projectRoot,
                    `data/runtime/conference-ledgers/iclr-2026-aaaa1111bbbb2222-${impl12}-ledger.json`,
                    JSON.stringify({
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'iclr-2026-2026/p1/pdf.pdf',
                            pdfSha256: sha
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'symlink' && item.path === ledgerPath), true);
            } finally {
                fs.rmSync(projectRoot, { recursive: true, force: true });
            }

            const projectRoot2 = makeProject();
            try {
                const bytes = '%PDF-1.6-legacy-cache-root-symlink';
                const sha = crypto.createHash('sha256').update(bytes).digest('hex');
                const outsideCache = path.join(projectRoot2, 'outside-cache');
                fs.mkdirSync(path.join(outsideCache, 'iclr-2026/p1'), { recursive: true });
                fs.writeFileSync(path.join(outsideCache, 'iclr-2026/p1/pdf.pdf'), bytes);
                const cacheDir = path.join(projectRoot2, 'data/runtime/conference-sources');
                fs.rmSync(cacheDir, { recursive: true, force: true });
                fs.symlinkSync(outsideCache, cacheDir);
                const ledgerPath = writeFile(
                    projectRoot2,
                    'data/runtime/conference-ledgers/iclr-2026.json',
                    JSON.stringify({
                        members: [{
                            availability: { pdf: 'present' },
                            pdfFile: 'iclr-2026/p1/pdf.pdf',
                            pdfSha256: sha
                        }]
                    })
                );
                const report = getPdfDuplicateReport({ projectRoot: projectRoot2, nowMs: NOW_MS });
                assert.strictEqual(report.blockers.some(item => item.type === 'symlink' && item.path === ledgerPath), true);
            } finally {
                fs.rmSync(projectRoot2, { recursive: true, force: true });
            }
        }
    });

    it('data/runtime 内普通文件 .hugo_build.lock 不阻断 pdf-dedupe，而其他 foo.lock 普通文件及目录型 .hugo_build.lock 仍阻断', () => {
        const projectRoot = makeProject();
        try {
            const bytes = '%PDF-1.6-hugo-build-lock-marker-check';
            const donor = writeFile(projectRoot, 'data/runtime/a/1.pdf', bytes);
            const target = writeFile(projectRoot, 'data/runtime/b/2.pdf', bytes);
            const hugoLock = writeFile(projectRoot, 'data/runtime/preview-blog/.hugo_build.lock', '');

            const dryRun = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS });
            assert.deepStrictEqual(dryRun.blockers, []);
            assert.strictEqual(dryRun.duplicateGroupCount, 1);

            if (process.platform === 'darwin') {
                const applied = dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true });
                assert.strictEqual(applied.mode, 'apply');
                assert.deepStrictEqual(applied.blockers, []);
                assert.strictEqual(applied.dedupedFiles, 1);
                assert.strictEqual(fs.existsSync(hugoLock), true);
                assert.strictEqual(fs.lstatSync(donor).nlink, 1);
                assert.strictEqual(fs.lstatSync(target).nlink, 1);
            }

            const otherLock = writeFile(projectRoot, 'data/runtime/preview-blog/foo.lock', '');
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => item.type === 'active_lock' && item.path === otherLock)
            );

            fs.unlinkSync(otherLock);
            // 目录型 .hugo_build.lock 仍进入 inspectLockEntry 检查并阻断 --apply
            fs.unlinkSync(hugoLock);
            fs.mkdirSync(hugoLock);
            assert.throws(
                () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                    && err.plan.blockers.some(item => (item.type === 'active_lock_unknown' || item.type === 'active_lock')
                        && item.path === hugoLock)
            );
            fs.rmdirSync(hugoLock);

            if (process.platform !== 'win32') {
                fs.symlinkSync(donor, hugoLock);
                assert.throws(
                    () => dedupeRuntimePdfs({ projectRoot, nowMs: NOW_MS, apply: true }),
                    err => err.code === 'STORAGE_PDF_DEDUPE_BLOCKED'
                        && err.plan.blockers.some(item => item.type === 'symlink')
                );
            }
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

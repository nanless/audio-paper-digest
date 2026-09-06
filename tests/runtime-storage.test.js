const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    getLayout,
    getStorageStatus,
    buildPrunePlan,
    pruneStorage,
    main
} = require('../scripts/runtime-storage.js');

const CONFERENCE_PROTECTED_KEYS = [
    'conference-discovery-catalogs',
    'conference-discovery-reports',
    'conference-filter-specs',
    'conference-filters',
    'conference-staging-specs',
    'conference-staging-sources',
    'conference-staging',
    'conference-ledgers',
    'conference-sources',
    'conference-runs',
    'conference-executions',
    'conference-analysis-executions'
];
const HISTORY_PROTECTED_KEYS = ['historical-page-inventories', 'page-source-crosswalks',
    'historical-arxiv-batches', 'historical-analysis-schedulers', 'historical-postprocess-schedulers', 'historical-taxonomy-assignments',
    'historical-page-staging', 'historical-daily-aggregates', 'paper-source-authorities'];

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
        'data/runtime/historical-page-inventories',
        'data/runtime/page-source-crosswalks',
        'data/runtime/historical-arxiv-batches',
        'data/runtime/historical-analysis-schedulers',
        'data/runtime/historical-postprocess-schedulers',
        'data/runtime/historical-taxonomy-assignments',
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

describe('runtime storage status', () => {
    it('拒绝未知或重复 CLI 参数，避免 destructive apply 吞掉拼写错误', () => {
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
            assert.strictEqual(fs.existsSync(path.join(projectRoot, 'data/current/image-cache/a.bin')), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('会议与历史来源账本对状态可见但永不进入自动清理候选', () => {
        const projectRoot = makeProject();
        try {
            const layout = getLayout(projectRoot);
            const protectedKeys = [...CONFERENCE_PROTECTED_KEYS, ...HISTORY_PROTECTED_KEYS];
            assert.deepEqual(layout.protectedRuntime.map(item => item.key), protectedKeys);
            const oldFiles = protectedKeys.map(key => writeFile(projectRoot,
                `data/runtime/${key}/old-fixture.bin`, key, NOW_MS - 90 * 24 * 60 * 60 * 1000));
            const status = getStorageStatus({ projectRoot, nowMs: NOW_MS });
            assert.deepEqual(status.targets.filter(item => item.key.startsWith('conference-')).map(item => item.key),
                CONFERENCE_PROTECTED_KEYS);
            for (const key of protectedKeys) {
                assert.ok(status.targets.some(item => item.key === key && item.files === 1));
            }
            const plan = buildPrunePlan({ projectRoot, nowMs: NOW_MS, retentionDays: 30 });
            for (const oldFile of oldFiles) assert.ok(!plan.candidates.some(item => item.path === oldFile));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

describe('runtime storage reference-aware prune', () => {
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
            assert.strictEqual(fs.existsSync(recent), true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('权威 JSON 损坏时 apply 在任何删除前 fail closed', () => {
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

    it('常见抓取/分析/发布锁 owner 仍存活时 apply fail closed 且不猜删锁', () => {
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

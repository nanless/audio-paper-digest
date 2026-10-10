'use strict';

// blog:activate-fresh 让新晋升的批次接替旧发布。它出错会改已发布状态，所以这里
// 卡三件事：参数形状、只有 promoted 才能通过、以及交给 Python 的命令行是固定的。
// 子进程用假的 spawn 观察，不真的启动 Python，也不碰 data/。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Config = require('../scripts/config.js');
const runner = require('../scripts/lib/fresh-rewrite-run.js');
const activate = require('../scripts/activate-fresh-publication.js');

const RUN_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const USAGE = /用法：--run-id UUID \[--dry-run\]/;

// 照 tests/fresh-rewrite-run.test.js 的接缝搭一份能通过 loadRun 的真实运行目录。
function fixture(t, { omitSourceText = false } = {}) {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'activate-fresh-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const originals = ['2609.00001', '2609.00002'].map(id => ({
        arxivId: id, paper_id: id, title: `Original paper ${id}`,
        abstract: `ORIGINAL_ABSTRACT_${id}`, authors: ['Original Author'],
        categories: ['cs.SD'], source: 'arxiv', sources: ['arxiv'],
        fetchedAt: '2026-09-04T00:00:00Z'
    }));
    const files = {
        rawCandidates: path.join(directory, 'raw.json'),
        filteredPapers: path.join(directory, 'filtered.json'),
        deepAnalysisResult: path.join(directory, 'canonical.json')
    };
    runner.writeImmutableJson(files.rawCandidates, { batchDate: '2026-09-04',
        papers: originals.map(paper => ({ ...paper, ignored: 'NEVER_USE' })) });
    runner.writeImmutableJson(files.filteredPapers, { batchDate: '2026-09-04',
        status: 'complete', papers: originals.map(paper => ({ ...paper })) });
    runner.writeImmutableJson(files.deepAnalysisResult, { batchDate: '2026-09-04',
        generation: 7, papers: originals.map(paper => ({ ...paper })) });

    const sourceExpectations = Object.fromEntries(originals.map(paper => [paper.arxivId, {
        sourceSha256: runner.sha256(`source ${paper.arxivId}`),
        structuredArtifactsSha256: runner.sha256(`artifacts ${paper.arxivId}`)
    }]));
    const cache = new Map();
    const descriptor = id => ({ version: 1, contract: 'fresh-source-cache-v1', runId: RUN_ID,
        paperId: id, ...sourceExpectations[id], sourceSnapshotSha256: runner.sha256(`snapshot ${id}`) });
    const freshPaper = paper => {
        const provenance = { contract: runner.FRESHNESS_CONTRACT, runId: RUN_ID,
            ...sourceExpectations[paper.arxivId],
            sourceSnapshotSha256: descriptor(paper.arxivId).sourceSnapshotSha256,
            sourceOnly: true, oldGeneratedTextIncluded: false };
        return { ...paper, analysis: 'NEW_RUN_ONLY_ANALYSIS', freshRewriteProvenance: provenance,
            analysisManifest: { freshRewriteProvenance: { ...provenance } } };
    };
    const deps = {
        rootDir: path.join(directory, 'fresh'),
        files,
        validateData: () => [],
        uuid: () => RUN_ID,
        now: () => '2026-09-06T00:00:00Z',
        prepareBaseline: async ({ paperIds }) => ({
            contract: 'fresh-rewrite-baseline-v1', sha256: 'b'.repeat(64), path: 'baseline.json',
            canonicalGeneration: 7,
            canonicalSha256: runner.readRegularJson(files.deepAnalysisResult).sha256,
            sourceExpectations
        }),
        readFreshSource: (_runDir, paper) => cache.get(runner.paperId(paper)) || null,
        resolveFreshSource: async (_runDir, paper) => {
            const result = {
                freshSourceDescriptor: descriptor(runner.paperId(paper)),
                ...(!omitSourceText ? { text: `source ${runner.paperId(paper)}` } : {})
            };
            cache.set(runner.paperId(paper), result);
            return result;
        },
        withFreshAnalysisContext: async (_identity, callback) => callback(),
        isSuccessfulAnalysisRecord: paper => paper.analysis === 'NEW_RUN_ONLY_ANALYSIS',
        analyzeBatch: async (papers, options) => {
            for (const paper of papers) {
                const prepared = options.preparePaperLocked(paper);
                if (prepared.skip) continue;
                options.onAttempt(0, options.maxRetries, prepared.paper);
                await options.onPaperResultLocked(prepared.paper,
                    { success: true, result: freshPaper(prepared.paper) });
            }
            return { stats: {} };
        },
        promoteRun: async () => ({ status: 'promoted', canonicalGeneration: 8,
            canonicalSha256: 'd'.repeat(64) })
    };
    return { directory, deps, files };
}

function pointAtRunsDir(t, rootDir) {
    const original = Config.FILES.freshRewriteRunsDir;
    Config.FILES.freshRewriteRunsDir = rootDir;
    t.after(() => { Config.FILES.freshRewriteRunsDir = original; });
}

function stubSpawn(t, behaviour) {
    const calls = [];
    const original = childProcess.spawn;
    childProcess.spawn = (command, argv, options) => {
        calls.push({ command, argv, options });
        const child = new EventEmitter();
        setImmediate(() => behaviour(child));
        return child;
    };
    t.after(() => { childProcess.spawn = original; });
    return calls;
}

async function promotedRun(f) {
    await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
    await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
    await runner.analyzeRewrite({ runId: RUN_ID }, f.deps);
    const promoted = await runner.promoteRewrite({ runId: RUN_ID }, f.deps);
    assert.equal(promoted.status, 'promoted');
    return runner.loadRun(RUN_ID, { rootDir: f.deps.rootDir });
}

describe('blog:activate-fresh', () => {
    it('只接受 --run-id UUID，后面最多再跟一个 --dry-run', async () => {
        for (const args of [[], ['--run-id'], ['--run-id', 'not-a-uuid'],
            ['--run-id', RUN_ID, '--extra'], ['--run-id', RUN_ID, '--dry-run', '--dry-run'],
            ['--dry-run', RUN_ID], ['--run-id', 'AAAAAAAA-2222-4333-8444-555555555555']]) {
            await assert.rejects(() => activate.main(args), USAGE,
                `这组参数本该被拒绝：${JSON.stringify(args)}`);
        }
    });

    it('状态不是 promoted 的运行不能接替旧发布', async t => {
        const f = fixture(t);
        const prepared = await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
        assert.equal(prepared.status, 'prepared');
        pointAtRunsDir(t, f.deps.rootDir);
        const calls = stubSpawn(t, child => child.emit('exit', 0, null));

        await assert.rejects(() => activate.main(['--run-id', RUN_ID]),
            /只有状态为 promoted 的 fresh 运行才能接替旧发布/);
        assert.deepEqual(calls, [], '被拒绝的运行不该启动 Python');
    });

    it('旧完成记录缺少可核对的来源正文时，不能转为可发布状态或启动发布进程', async t => {
        const f = fixture(t, { omitSourceText: true });
        await runner.prepareRewrite({ date: '2026-09-04' }, f.deps);
        await runner.collectRewriteSources({ runId: RUN_ID }, f.deps);
        await runner.analyzeRewrite({ runId: RUN_ID }, f.deps);
        const calls = stubSpawn(t, child => child.emit('exit', 0, null));
        await assert.rejects(() => runner.promoteRewrite({ runId: RUN_ID }, f.deps),
            /requires all sources and analysis to be complete/);
        assert.notEqual(runner.loadRun(RUN_ID, { rootDir: f.deps.rootDir }).run.status, 'promoted');
        assert.deepEqual(calls, []);
    });

    it('promoted 运行按固定命令行接替旧发布，--dry-run 原样透传', async t => {
        const f = fixture(t);
        const loaded = await promotedRun(f);
        assert.equal(loaded.run.status, 'promoted');
        pointAtRunsDir(t, f.deps.rootDir);
        const calls = stubSpawn(t, child => child.emit('exit', 0, null));

        assert.equal(await activate.main(['--run-id', RUN_ID]), 0);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, 'bash');
        assert.deepEqual(calls[0].argv, ['scripts/python-runtime.sh',
            'scripts/publication_activation.py', '--run-id', RUN_ID]);
        assert.equal(calls[0].options.cwd, PROJECT_ROOT);
        assert.equal(calls[0].options.stdio, 'inherit');

        assert.equal(await activate.main(['--run-id', RUN_ID, '--dry-run']), 0);
        assert.deepEqual(calls[1].argv, ['scripts/python-runtime.sh',
            'scripts/publication_activation.py', '--run-id', RUN_ID, '--dry-run']);
    });

    it('子进程被信号中断时拒绝并带上信号名', async t => {
        const f = fixture(t);
        await promotedRun(f);
        pointAtRunsDir(t, f.deps.rootDir);
        stubSpawn(t, child => child.emit('exit', null, 'SIGTERM'));

        await assert.rejects(() => activate.main(['--run-id', RUN_ID]),
            /接替旧发布的过程被信号 SIGTERM 中断/);
    });

    it('子进程启动失败时拒绝', async t => {
        const f = fixture(t);
        await promotedRun(f);
        pointAtRunsDir(t, f.deps.rootDir);
        stubSpawn(t, child => child.emit('error', new Error('spawn bash ENOENT')));

        await assert.rejects(() => activate.main(['--run-id', RUN_ID]), /ENOENT/);
    });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { prepareBaseline, promoteRun } = require('../scripts/lib/fresh-rewrite-publication.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); };

function fixture(t, { sourceId } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fresh-publication-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const rootDir = path.join(root, 'runs'); const runDir = path.join(rootDir, 'run-one');
    const blogRepo = path.join(root, 'blog'); const currentDir = path.join(root, 'current');
    const canonicalPath = path.join(currentDir, 'deep-analysis-result.json');
    fs.mkdirSync(runDir, { recursive: true }); fs.mkdirSync(blogRepo);
    const date = '2026-09-04';
    const paperIds = Array.from({ length: 30 }, (_, i) => `2609.${String(i + 1).padStart(5, '0')}`);
    const papers = paperIds.map((arxivId, index) => ({ arxivId, fetchBatchDate: date, analysis: `old analysis ${arxivId}`,
        apiReaderArticle: `old reader ${arxivId}`, sourceSha256: sha(`source ${arxivId}`),
        structuredArtifactsSha256: sha(`artifacts ${arxivId}`),
        analysisManifest: { sourceAcquisition: { sourceSha256: sha(`source ${arxivId}`),
            structuredArtifactsSha256: sha(`artifacts ${arxivId}`),
            ...(sourceId !== undefined && index === 0 ? { sourceId } : {}) } } }));
    const outside = { arxivId: '2608.99999', fetchBatchDate: '2026-08-31', note: 'unchanged outside date' };
    write(canonicalPath, { batchDate: date, generation: 7, status: 'complete', papers: [...papers, outside] });
    for (const filename of ['filtered-papers.json', 'raw-candidates.json', 'filter-decisions.json', 'fetch-checkpoint.json', 'papers.json']) {
        write(path.join(currentDir, filename), { batchDate: date, papers: papers.map(p => ({ arxivId: p.arxivId })) });
    }
    const page = (id, body) => `---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_arxiv_id: "${id}"\n---\n${body}\n`;
    const entries = papers.map(p => {
        const relative = `content/posts/${date}-paper-${p.arxivId.replace('.', '-')}.md`;
        write(path.join(blogRepo, relative), page(p.arxivId, `old page ${p.arxivId}`));
        return { path: relative, sha256: sha(fs.readFileSync(path.join(blogRepo, relative))), deleted: false };
    });
    const summary = `content/posts/${date}.md`;
    const outsidePage = 'content/posts/2026-08-31-unrelated.md';
    write(path.join(blogRepo, outsidePage), 'outside-date page remains unchanged');
    write(path.join(blogRepo, summary), '---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: index\n---\nold summary\n');
    entries.push({ path: summary, sha256: sha(fs.readFileSync(path.join(blogRepo, summary))), deleted: false });
    const asset = `static/images/papers/${paperIds[0]}/figure-1.png`;
    const sidecar = `static/data/papers/${date}/${paperIds[0].replace('.', '-')}/citation.json`;
    write(path.join(blogRepo, asset), 'pixels'); write(path.join(blogRepo, sidecar), '{}');
    write(path.join(currentDir, `blog-generation-manifest-${date}.json`), { files: [...entries,
        { path: asset, sha256: sha('pixels'), deleted: false }], publishedPapers: papers });
    write(path.join(currentDir, `blog-review-receipt-${date}.json`), { files: entries, publicationCommit: 'a'.repeat(40) });
    // 真实基线里有一篇单篇发布比批次凭证更新。
    write(path.join(blogRepo, entries[0].path), page(paperIds[0], 'newer single-paper body'));
    write(path.join(currentDir, `blog-generation-manifest-${date}-single-${paperIds[0].replace('.', '-')}.json`), {
        files: [{ path: entries[0].path, sha256: sha(fs.readFileSync(path.join(blogRepo, entries[0].path))), deleted: false },
            { path: sidecar, sha256: sha('{}'), deleted: false }], publishedPapers: [papers[0]] });
    write(path.join(currentDir, `blog-review-receipt-${date}-single-${paperIds[0].replace('.', '-')}.json`), { publicationCommit: 'b'.repeat(40) });
    for (const dir of ['visual-summary-manifests', 'digest-cover-manifests']) write(path.join(currentDir, dir, `${date}.json`), { batchDate: date });
    execFileSync('git', ['init', '-b', 'main', blogRepo], { stdio: 'ignore' });
    execFileSync('git', ['-C', blogRepo, 'add', '.']);
    execFileSync('git', ['-C', blogRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline'], { stdio: 'ignore' });
    write(path.join(currentDir, 'papers.json'), { generation: 4,
        papers: Object.fromEntries([...papers, outside].map(p => [p.arxivId, p])) });
    const paperLockRoot = path.join(root, 'paper-locks');
    const options = { runDir, rootDir, date, paperIds, blogRepo, canonicalPath, currentDir, paperLockRoot };
    const baseline = prepareBaseline(options);
    const sourceRecords = Object.fromEntries(papers.map(p => [p.arxivId, { version: 2,
        contract: 'fresh-source-bundle-v2', runId: 'run-one', paperId: p.arxivId,
        sourceGeneration: 1, sourceManifestSha256: sha(`fresh manifest ${p.arxivId}`),
        sourceSha256: sha(`fresh source ${p.arxivId}`), structuredArtifactsSha256: sha(`fresh artifacts ${p.arxivId}`),
        sourceSnapshotSha256: sha(`fresh snapshot ${p.arxivId}`) }]));
    const run = { version: 1, contract: 'fresh-rewrite-run-v1', runId: 'run-one', date,
        paperIds, baseline, sourceExpectations: baseline.sourceExpectations, sourceRecords, status: 'complete' };
    const rewritten = papers.map(p => {
        const sourceRecord = sourceRecords[p.arxivId];
        const provenance = { contract: 'fresh-source-analysis-v1', runId: run.runId, sourceOnly: true,
            oldGeneratedTextIncluded: false, sourceSha256: sourceRecord.sourceSha256,
            structuredArtifactsSha256: sourceRecord.structuredArtifactsSha256,
            sourceSnapshotSha256: sourceRecord.sourceSnapshotSha256, sourceGeneration: sourceRecord.sourceGeneration,
            sourceManifestSha256: sourceRecord.sourceManifestSha256 };
        return { ...p, complete: true, analysis: `new analysis ${p.arxivId}`, apiReaderArticle: `new reader ${p.arxivId}`,
            sourceSha256: sourceRecord.sourceSha256, freshRewriteProvenance: provenance,
            analysisManifest: { ...p.analysisManifest, sourceAcquisition: { sourceSha256: sourceRecord.sourceSha256,
                structuredArtifactsSha256: sourceRecord.structuredArtifactsSha256 }, freshRewriteProvenance: provenance } };
    });
    const analysis = { status: 'complete', papers: rewritten };
    const hooks = { applyDigestStatuses: (database, incoming, opts) => {
        assert.ok(fs.existsSync(`${canonicalPath}.lock`));
        for (const id of paperIds) assert.ok(fs.existsSync(path.join(paperLockRoot, `${id}.lock`)));
        for (const paper of incoming) database.papers[paper.arxivId] = { ...database.papers[paper.arxivId], ...paper,
            digestStatus: { status: 'analyzed', latestAttemptStatus: 'analyzed', batchDate: opts.batchDate } };
        return incoming.length;
    } };
    const promote = () => promoteRun({ ...options, run, analysis, ...hooks,
        validatePaper: p => p.complete === true,
        readSource: (_dir, p) => ({ text: `source ${p.arxivId}`, freshSourceDescriptor: { ...p.freshRewriteProvenance, paperId: p.arxivId } }) });
    return { ...options, baseline, run, analysis, promote, outside, entries, asset, sidecar, hooks, outsidePage };
}

test('准备阶段备份实际的 31 个页面，含较新的单篇发布、素材、数据和私有不可变恢复文件', t => {
    const f = fixture(t);
    const baseline = JSON.parse(fs.readFileSync(path.join(f.runDir, 'baseline.json')));
    assert.equal(baseline.pages.length, 31);
    assert.equal(baseline.pages.find(p => p.paperId === f.paperIds[0]).sha256,
        sha(fs.readFileSync(path.join(f.blogRepo, f.entries[0].path))));
    assert.notEqual(baseline.pages.find(p => p.paperId === f.paperIds[0]).sha256, f.entries[0].sha256);
    for (const relative of [f.asset, f.sidecar]) assert.ok(baseline.files.some(r => r.category === 'blog' && r.relativePath === relative));
    assert.ok(!baseline.files.some(r => r.category === 'blog' && r.relativePath === f.outsidePage));
    for (const record of baseline.files) {
        const backup = path.join(f.runDir, record.backupPath);
        assert.equal(sha(fs.readFileSync(backup)), record.sha256);
        assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    }
    assert.deepEqual(prepareBaseline(f), f.baseline);
    const record = baseline.files[0]; fs.writeFileSync(path.join(f.runDir, record.backupPath), 'damaged');
    assert.throws(() => prepareBaseline(f), /backup|baseline/i);
});

test('新基线审查原始 arXiv 版本，同时要求有新的已保存来源代次', t => {
    const f = fixture(t, { sourceId: '2609.00001v1' });
    assert.deepEqual(f.baseline.sourceExpectations['2609.00001'], {
        sourceMode: 'sealed-arxiv-bundle-v1', sourceGeneration: 1
    });
    assert.equal(f.baseline.sourceExpectations['2609.00002'].sourceId, undefined);
    assert.deepEqual(prepareBaseline(f), f.baseline);
});

test('基线拒绝格式错误或跨论文的原始来源 ID', t => {
    for (const sourceId of ['2609.99999v1', 'https://arxiv.org/abs/2609.00001v1', '2609.00001v0', '2609.00001v1/other']) {
        assert.throws(() => fixture(t, { sourceId }), /source ID does not identify/);
    }
});

test('promote 原子替换全部 30 篇当日论文，递增代次，保留日期之外的数据，并能精确续跑', t => {
    const f = fixture(t); const result = f.promote();
    const current = JSON.parse(fs.readFileSync(f.canonicalPath));
    assert.equal(current.generation, 8);
    assert.equal(result.canonicalSha256, sha(fs.readFileSync(f.canonicalPath)));
    assert.deepEqual(current.papers.at(-1), f.outside);
    assert.equal(current.papers.filter(p => p.freshRewriteProvenance?.runId === f.run.runId).length, 30);
    const before = fs.readFileSync(f.canonicalPath);
    assert.equal(f.promote().alreadyPromoted, true);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    const database = JSON.parse(fs.readFileSync(path.join(f.currentDir, 'papers.json')));
    assert.equal(database.generation, 5);
    assert.deepEqual(database.papers[f.outside.arxivId], f.outside);
    assert.equal(fs.readFileSync(path.join(f.blogRepo, f.outsidePage), 'utf8'), 'outside-date page remains unchanged');
});

test('基线 CAS 漂移时 promote 拒绝，且不碰已被改动的正式记录', t => {
    const f = fixture(t); const current = JSON.parse(fs.readFileSync(f.canonicalPath)); current.generation++;
    write(f.canonicalPath, current); const before = fs.readFileSync(f.canonicalPath);
    assert.throws(() => f.promote(), /baseline|CAS/i);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
});

test('正式替换之前，批次输入或来源快照证据一变，promote 就拒绝', t => {
    const f = fixture(t); const before = fs.readFileSync(f.canonicalPath);
    const filtered = path.join(f.currentDir, 'filtered-papers.json'); const original = fs.readFileSync(filtered);
    write(filtered, { batchDate: '2026-09-05', papers: [] });
    assert.throws(() => f.promote(), /Batch input baseline drifted/);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    fs.writeFileSync(filtered, original);
    assert.throws(() => promoteRun({ ...f, run: f.run, analysis: f.analysis,
        validatePaper: () => true, readSource: () => null }), /source snapshot/i);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
});

test('规范文件已安装但论文库同步失败后，提升流程可以续跑', t => {
    const f = fixture(t); const apply = f.hooks.applyDigestStatuses;
    f.hooks.applyDigestStatuses = () => { throw new Error('simulated database failure'); };
    assert.throws(() => f.promote(), /simulated database failure/);
    const before = fs.readFileSync(f.canonicalPath);
    assert.equal(JSON.parse(before).generation, 8);
    f.hooks.applyDigestStatuses = apply;
    assert.equal(f.promote().alreadyPromoted, true);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.currentDir, 'papers.json'))).generation, 5);
});

test('原始或筛选批次漂移后，已安装的规范文件不能续跑数据库同步', t => {
    const f = fixture(t); const apply = f.hooks.applyDigestStatuses;
    f.hooks.applyDigestStatuses = () => { throw new Error('simulated database failure'); };
    assert.throws(() => f.promote(), /simulated database failure/);
    const canonicalBefore = fs.readFileSync(f.canonicalPath);
    const databasePath = path.join(f.currentDir, 'papers.json');
    const databaseBefore = fs.readFileSync(databasePath);
    f.hooks.applyDigestStatuses = apply;
    for (const name of ['raw-candidates.json', 'filtered-papers.json']) {
        const filename = path.join(f.currentDir, name); const original = fs.readFileSync(filename);
        write(filename, { batchDate: '2026-09-05', papers: [] });
        assert.throws(() => f.promote(), /Batch input baseline drifted/);
        assert.deepEqual(fs.readFileSync(f.canonicalPath), canonicalBefore);
        assert.deepEqual(fs.readFileSync(databasePath), databaseBefore);
        assert.equal(JSON.parse(fs.readFileSync(f.canonicalPath)).generation, 8);
        assert.equal(JSON.parse(fs.readFileSync(databasePath)).generation, 4);
        fs.writeFileSync(filename, original);
    }
});

test('意图安装之前崩溃时，提升流程复用精确的已准备规范文件', t => {
    const f = fixture(t); f.promote();
    const baseline = JSON.parse(fs.readFileSync(path.join(f.runDir, 'baseline.json')));
    for (const name of ['deep-analysis-result.json', 'papers.json']) {
        const saved = baseline.files.find(record => record.category === 'data' && record.relativePath === name);
        fs.writeFileSync(path.join(f.currentDir, name), fs.readFileSync(path.join(f.runDir, saved.backupPath)));
    }
    fs.unlinkSync(path.join(f.runDir, 'promotion.json'));
    const staged = fs.readFileSync(path.join(f.runDir, 'promoted-canonical.json'));
    assert.equal(f.promote().alreadyPromoted, false);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), staged);
});

test('提升流程在规范 CAS 之前尊重每一个已存在的归一化论文锁', t => {
    const f = fixture(t);
    const { acquireFileLockSync } = require('../scripts/analysis-engine.js');
    const release = acquireFileLockSync(path.join(f.paperLockRoot, f.paperIds[14]));
    const before = fs.readFileSync(f.canonicalPath);
    try {
        assert.throws(() => promoteRun({ ...f, paperLockTimeoutMs: 5, run: f.run, analysis: f.analysis,
            validatePaper: () => true,
            readSource: (_dir, p) => ({ text: `source ${p.arxivId}`, freshSourceDescriptor: { ...p.freshRewriteProvenance, paperId: p.arxivId } }) }), /锁|lock/i);
        assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    } finally { release(); }
});

test('Reader 未变化、生产不完整、证明缺失、运行不符或来源漂移时，promote 一律拒绝', t => {
    const f = fixture(t); const original = structuredClone(f.analysis.papers[29]); const before = fs.readFileSync(f.canonicalPath);
    for (const mutate of [p => { p.apiReaderArticle = `old reader ${p.arxivId}`; }, p => { p.complete = false; },
        p => { delete p.freshRewriteProvenance; }, p => { p.freshRewriteProvenance.runId = 'different'; },
        p => { p.sourceSha256 = '0'.repeat(64); }]) {
        f.analysis.papers[29] = structuredClone(original); mutate(f.analysis.papers[29]);
        assert.throws(() => f.promote()); assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    }
    f.analysis.papers.pop(); assert.throws(() => f.promote(), /paper|ID|coverage/i);
});

test('博客目录不干净、运行目录逃逸、备份是符号链接或清单路径穿越时，prepare 一律拒绝', t => {
    const f = fixture(t);
    assert.throws(() => prepareBaseline({ ...f, runDir: path.dirname(f.rootDir) }), /run|root/i);
    fs.writeFileSync(path.join(f.blogRepo, 'manual-change.txt'), 'user change');
    assert.throws(() => prepareBaseline(f), /dirty|clean/i);
    fs.unlinkSync(path.join(f.blogRepo, 'manual-change.txt'));
    const runDir = path.join(f.rootDir, 'run-two'); fs.mkdirSync(runDir);
    const manifest = path.join(f.currentDir, `blog-generation-manifest-${f.date}.json`);
    write(manifest, { files: [{ path: '../../outside', deleted: false }] });
    assert.throws(() => prepareBaseline({ ...f, runDir }), /path|scope|traversal/i);
    const baseline = JSON.parse(fs.readFileSync(path.join(f.runDir, 'baseline.json')));
    const savedManifest = baseline.files.find(record => record.relativePath === path.basename(manifest));
    fs.writeFileSync(manifest, fs.readFileSync(path.join(f.runDir, savedManifest.backupPath)));
    const runThree = path.join(f.rootDir, 'run-three'); fs.mkdirSync(runThree);
    const outside = path.join(path.dirname(f.rootDir), 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(runThree, 'baseline-files'));
    assert.throws(() => prepareBaseline({ ...f, runDir: runThree }), /Unsafe directory/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

function crashFreshWrite(f, target, operation) {
    const options = Object.fromEntries(['runDir', 'rootDir', 'date', 'paperIds', 'blogRepo',
        'canonicalPath', 'currentDir', 'paperLockRoot'].map(key => [key, f[key]]));
    const child = `
        const fs = require('node:fs');
        const api = require(${JSON.stringify(require.resolve('../scripts/lib/fresh-rewrite-publication.js'))});
        const original = fs.linkSync;
        fs.linkSync = function(source, destination) {
            original.call(this, source, destination);
            if (destination === ${JSON.stringify(target)}) process.kill(process.pid, 'SIGKILL');
        };
        const options = ${JSON.stringify(options)};
        if (${JSON.stringify(operation)} === 'prepare') api.prepareBaseline(options);
        else api.promoteRun({ ...options, run: ${JSON.stringify(f.run)}, analysis: ${JSON.stringify(f.analysis)},
            validatePaper: paper => paper.complete === true,
            readSource: (_directory, paper) => ({ text: 'source ' + paper.arxivId,
                freshSourceDescriptor: { ...paper.freshRewriteProvenance, paperId: paper.arxivId } }) });
    `;
    const result = require('node:child_process').spawnSync(process.execPath, ['-e', child], {
        encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert.equal(fs.statSync(target).nlink, 2);
    // 原锁协议仍等待租约；只在测试中推进已退出子进程的 owner 时间，不改变生产回收策略。
    for (const root of [f.runDir, f.currentDir, f.paperLockRoot]) {
        if (!fs.existsSync(root)) continue;
        for (const item of fs.readdirSync(root)) {
            const owner = path.join(root, item, 'owner.json');
            if (item.endsWith('.lock') && fs.existsSync(owner)) {
                assert.equal(JSON.parse(fs.readFileSync(owner)).pid, result.pid);
                fs.utimesSync(owner, new Date(0), new Date(0));
            }
        }
    }
}

for (const stage of ['backup', 'baseline', 'payload', 'intent']) {
    test(`fresh ${stage} 链接后真实崩溃，只在重核原输入后恢复已退出写者`, t => {
        const f = fixture(t);
        let target;
        const preparing = stage === 'backup' || stage === 'baseline';
        if (preparing) {
            fs.rmSync(f.runDir, { recursive: true });
            fs.mkdirSync(f.runDir);
            target = stage === 'backup'
                ? path.join(f.runDir, 'baseline-files/data/deep-analysis-result.json')
                : path.join(f.runDir, 'baseline.json');
        } else {
            target = path.join(f.runDir, stage === 'payload' ? 'promoted-canonical.json' : 'promotion.json');
        }
        crashFreshWrite(f, target, preparing ? 'prepare' : 'promote');
        const bytes = fs.readFileSync(target);
        const inode = fs.statSync(target).ino;
        if (preparing) prepareBaseline(f);
        else assert.equal(f.promote().status, 'promoted');
        assert.deepEqual(fs.readFileSync(target), bytes);
        assert.equal(fs.statSync(target).ino, inode);
        assert.equal(fs.statSync(target).nlink, 1);
    });
}

test('fresh 基线恢复先核全部原文件，变动时保留已知残留链接', t => {
    const f = fixture(t);
    fs.rmSync(f.runDir, { recursive: true });
    fs.mkdirSync(f.runDir);
    const target = path.join(f.runDir, 'baseline.json');
    crashFreshWrite(f, target, 'prepare');
    const original = fs.readFileSync(path.join(f.currentDir, 'papers.json'));
    fs.writeFileSync(path.join(f.currentDir, 'papers.json'), '{}');
    const before = fs.readFileSync(target);
    assert.throws(() => prepareBaseline(f), /原输入已变化/);
    assert.equal(fs.statSync(target).nlink, 2);
    assert.deepEqual(fs.readFileSync(target), before);
    fs.writeFileSync(path.join(f.currentDir, 'papers.json'), original);
    prepareBaseline(f);
    assert.equal(fs.statSync(target).nlink, 1);
});

test('fresh 提升恢复在核验来源和批次输入前不清理既有意图', t => {
    const f = fixture(t);
    const target = path.join(f.runDir, 'promotion.json');
    crashFreshWrite(f, target, 'promote');
    const original = f.analysis.papers[0].sourceSha256;
    f.analysis.papers[0].sourceSha256 = '0'.repeat(64);
    assert.throws(() => f.promote(), /来源凭证/);
    assert.equal(fs.statSync(target).nlink, 2);
    f.analysis.papers[0].sourceSha256 = original;
    const filtered = path.join(f.currentDir, 'filtered-papers.json');
    const before = fs.readFileSync(filtered);
    fs.writeFileSync(filtered, '{}');
    assert.throws(() => f.promote(), /Batch input baseline/);
    assert.equal(fs.statSync(target).nlink, 2);
    fs.writeFileSync(filtered, before);
    f.promote();
    assert.equal(fs.statSync(target).nlink, 1);
});

test('fresh 备份短写不留下正式半文件，同一请求可以重试', t => {
    const f = fixture(t);
    fs.rmSync(f.runDir, { recursive: true });
    fs.mkdirSync(f.runDir);
    const target = path.join(f.runDir, 'baseline-files/data/deep-analysis-result.json');
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    const failure = Object.assign(new Error('模拟备份短写'), { code: 'EIO' });
    let fd;
    fs.openSync = function(filename, ...args) {
        const opened = originalOpen.call(this, filename, ...args);
        if (String(filename) === target || String(filename).startsWith(path.join(path.dirname(target), '.deep-analysis-result.json.'))) fd = opened;
        return opened;
    };
    fs.writeFileSync = function(destination, bytes, ...args) {
        if (fd !== undefined && destination === fd) {
            fs.writeSync(destination, Buffer.from(bytes).subarray(0, 7));
            throw failure;
        }
        return originalWrite.call(this, destination, bytes, ...args);
    };
    try { assert.throws(() => prepareBaseline(f), error => error === failure); }
    finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; }
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.tmp')), []);
    prepareBaseline(f);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(f.canonicalPath));
});

test('fresh 基线拒绝旧未知双链接和半截清单，不清理原文件', t => {
    const f = fixture(t);
    const target = path.join(f.runDir, 'baseline.json');
    const bytes = fs.readFileSync(target);
    const unknown = path.join(f.runDir, '.baseline.json.unknown.tmp');
    fs.linkSync(target, unknown);
    assert.throws(() => prepareBaseline(f));
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.equal(fs.statSync(target).nlink, 2);
    fs.unlinkSync(unknown);
    fs.writeFileSync(target, '{"contract":');
    assert.throws(() => prepareBaseline(f));
    assert.equal(fs.readFileSync(target, 'utf8'), '{"contract":');
});


test('fresh 基线不抢占仍存活写者的已知临时链接', t => {
    const f = fixture(t);
    const target = path.join(f.runDir, 'baseline.json');
    const host = sha(os.hostname()).slice(0, 16);
    const temporary = path.join(f.runDir, `.baseline.json.${host}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.linkSync(target, temporary);
    const bytes = fs.readFileSync(target);
    const inode = fs.statSync(target).ino;
    assert.throws(() => prepareBaseline(f));
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.equal(fs.statSync(target).ino, inode);
    assert.equal(fs.statSync(target).nlink, 2);
    assert.equal(fs.statSync(temporary).ino, inode);
});

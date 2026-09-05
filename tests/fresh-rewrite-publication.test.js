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
    // The real baseline has a newer single-paper publication than the batch receipt.
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
    const run = { version: 1, contract: 'fresh-rewrite-run-v1', runId: 'run-one', date,
        paperIds, baseline, sourceExpectations: baseline.sourceExpectations, status: 'complete' };
    const rewritten = papers.map(p => {
        const provenance = { contract: 'fresh-source-analysis-v1', runId: run.runId, sourceOnly: true,
            oldGeneratedTextIncluded: false, sourceSha256: p.sourceSha256,
            structuredArtifactsSha256: p.structuredArtifactsSha256, sourceSnapshotSha256: sha(`snapshot ${p.arxivId}`) };
        return { ...p, complete: true, analysis: `new analysis ${p.arxivId}`, apiReaderArticle: `new reader ${p.arxivId}`,
            freshRewriteProvenance: provenance, analysisManifest: { ...p.analysisManifest, freshRewriteProvenance: provenance } };
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
        readSource: (_dir, p) => ({ freshSourceDescriptor: { ...p.freshRewriteProvenance, paperId: p.arxivId } }) });
    return { ...options, baseline, run, analysis, promote, outside, entries, asset, sidecar, hooks, outsidePage };
}

test('prepare backs actual 31 pages including newer single release, assets, data and private immutable recovery files', t => {
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

test('new baseline optionally pins the original arXiv version without weakening source hashes', t => {
    const f = fixture(t, { sourceId: '2609.00001v1' });
    assert.deepEqual(f.baseline.sourceExpectations['2609.00001'], {
        sourceSha256: sha('source 2609.00001'), structuredArtifactsSha256: sha('artifacts 2609.00001'),
        sourceId: '2609.00001v1'
    });
    assert.equal(f.baseline.sourceExpectations['2609.00002'].sourceId, undefined);
    assert.deepEqual(prepareBaseline(f), f.baseline);
});

test('baseline refuses malformed or cross-paper original source IDs', t => {
    for (const sourceId of ['2609.99999v1', 'https://arxiv.org/abs/2609.00001v1', '2609.00001v0', '2609.00001v1/other']) {
        assert.throws(() => fixture(t, { sourceId }), /source ID does not identify/);
    }
});

test('promote atomically replaces all 30 fresh papers, increments generation, preserves date-external data and resumes exactly', t => {
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

test('promote refuses baseline CAS drift without touching changed canonical', t => {
    const f = fixture(t); const current = JSON.parse(fs.readFileSync(f.canonicalPath)); current.generation++;
    write(f.canonicalPath, current); const before = fs.readFileSync(f.canonicalPath);
    assert.throws(() => f.promote(), /baseline|CAS/i);
    assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
});

test('promote refuses changed batch inputs and source snapshot evidence before canonical replacement', t => {
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

test('promotion resumes after canonical was installed but papers database synchronization failed', t => {
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

test('installed canonical cannot resume database sync after raw or filtered batch drift', t => {
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

test('promotion reuses exact prepared canonical after a crash before intent installation', t => {
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

test('promotion respects every existing normalized paper lock before canonical CAS', t => {
    const f = fixture(t);
    const { acquireFileLockSync } = require('../scripts/analysis-engine.js');
    const release = acquireFileLockSync(path.join(f.paperLockRoot, f.paperIds[14]));
    const before = fs.readFileSync(f.canonicalPath);
    try {
        assert.throws(() => promoteRun({ ...f, paperLockTimeoutMs: 5, run: f.run, analysis: f.analysis,
            validatePaper: () => true,
            readSource: (_dir, p) => ({ freshSourceDescriptor: { ...p.freshRewriteProvenance, paperId: p.arxivId } }) }), /锁|lock/i);
        assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    } finally { release(); }
});

test('promote refuses any unchanged Reader, incomplete production, missing proof, wrong run or source drift', t => {
    const f = fixture(t); const original = structuredClone(f.analysis.papers[29]); const before = fs.readFileSync(f.canonicalPath);
    for (const mutate of [p => { p.apiReaderArticle = `old reader ${p.arxivId}`; }, p => { p.complete = false; },
        p => { delete p.freshRewriteProvenance; }, p => { p.freshRewriteProvenance.runId = 'different'; },
        p => { p.sourceSha256 = '0'.repeat(64); }]) {
        f.analysis.papers[29] = structuredClone(original); mutate(f.analysis.papers[29]);
        assert.throws(() => f.promote()); assert.deepEqual(fs.readFileSync(f.canonicalPath), before);
    }
    f.analysis.papers.pop(); assert.throws(() => f.promote(), /paper|ID|coverage/i);
});

test('prepare refuses dirty blog, escaped run directory, symlink backups and manifest traversal', t => {
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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const boundary = require('../scripts/lib/daily-fetch-boundary');
const recovery = require('../scripts/lib/daily-fetch-witness-recovery');
const pipeline = require('../scripts/full-fetch');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const stable = boundary.stableSha;
function portable(v) {
    if (v === null) return ['null'];
    if (typeof v === 'string') return ['string', v];
    if (typeof v === 'boolean') return ['boolean', v];
    if (typeof v === 'number') { const b = Buffer.alloc(8); b.writeDoubleBE(v); return ['number-f64', b.toString('hex')]; }
    if (Array.isArray(v)) return ['array', v.map(portable)];
    return ['object', Object.keys(v).sort().map(k => [k, portable(v[k])])];
}
function fixture(t, { hfSelected = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'witness-recovery-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    const repo = path.join(root, 'blog'), dataRoot = path.join(root, 'data'); fs.mkdirSync(repo); fs.mkdirSync(dataRoot);
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim();
    const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)); return file; };
    git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
    git('config', 'maintenance.auto', 'false'); git('config', 'gc.auto', '0'); git('remote', 'add', 'origin', 'https://example.invalid/blog.git');
    put(path.join(repo, 'README'), 'test'); git('add', '.'); git('commit', '-m', 'base');
    function publish(date, id, snapshot, reference) {
        const baseHead = git('rev-parse', 'HEAD'), name = `content/posts/${date}-paper.md`;
        const citationPath = `static/data/papers/${date}/${id.replace('.', '-')}/citation.json`;
        const citation = JSON.stringify({ arxivId: id });
        const page = `---\ndate: ${date}\ndraft: false\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_arxiv_id: "${id}"\npaper_digest_sidecars: {"citation.json":{"sha256":"${sha(citation)}"}}\n---\n`;
        const indexPath = `content/posts/${date}.md`, index = `---\ndate: ${date}\ndraft: false\npaper_digest_pipeline_owned: true\npaper_digest_page_type: index\n---\n共分析 **1** 篇论文\n[x](/posts/${date}-paper)\n`;
        put(path.join(repo, name), page); put(path.join(repo, indexPath), index); put(path.join(repo, citationPath), citation);
        git('add', '.'); git('commit', '-m', date); const commit = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', commit);
        if (!snapshot) return;
        const files = [{ path: name, deleted: false, sha256: sha(page) }, { path: indexPath, deleted: false, sha256: sha(index) },
            { path: citationPath, deleted: false, sha256: sha(citation) }];
        const m = { schemaVersion: 3, date, baseHead, files, publishedPapers: snapshot,
            publishedPapersFingerprintContract: 'typed-json-f64-utf16-v1', publishedPapersFingerprint: sha(JSON.stringify(portable(snapshot))),
            inputFingerprint: '1'.repeat(64), inputSourceReference: reference };
        const mb = JSON.stringify(m);
        const r = { schemaVersion: 3, date, strictReview: true, hugoGate: 'hugo', baseHead, files,
            generationManifestSha256: sha(mb), reviewProtocolFingerprint: '2'.repeat(64),
            generationInputIntegrity: 'typed-json-f64-utf16-v1', generationInputFingerprint: m.inputFingerprint,
            publishedPapersFingerprint: m.publishedPapersFingerprint, generationInputSourceReference: reference,
            publicationCommit: commit, remoteVerifiedOid: commit, remoteVerifiedAt: '2026-10-04T12:00:00+08:00', remoteName: 'origin',
            remoteIdentitySha256: stable({ remote: 'origin', pushUrl: 'https://example.invalid/blog.git' }) };
        put(path.join(dataRoot, 'current', `blog-generation-manifest-${date}.json`), mb);
        put(path.join(dataRoot, 'current', `blog-review-receipt-${date}.json`), r);
    }
    publish('2026-10-02', '2610.00001');
    const old = boundary.resolveDailyFetchBoundary(repo, { dataRoot, until: '2026-10-03T04:00:00.000Z' });
    const p = { arxivId: '2610.00026', title: 'speech', abstract: 'speech', published: '2026-10-02T03:00:00Z',
        ...(hfSelected ? { hfSelectedAt: '2026-10-03T00:00:00Z' } : {}) };
    const provider = { boundaryIdentity: old.identitySha256, window: { since: old.since, until: old.until, covered: true } };
    const entry = { status: 'complete', papers: [p], papersCount: 1, papersSha256: stable([p]), health: { ok: true, provider } };
    const cp = { sourceContractVersion: 7, batchDate: '2026-10-03', batchStartedAt: old.until,
        ...pipeline.buildCandidateFingerprints(new Set(), new Set(), old), historicalDedupIds: [],
        arxiv: Object.fromEntries(['eess.AS','cs.SD','eess.SP','cs.CL','cs.LG','cs.AI','cs.MM'].map(id => [id, entry])),
        huggingface: { ...entry, health: { ok: true, provider: { ...provider, cutoffDate: old.lastDigestDate,
            dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } } } };
    cp.fetchSourcesSha256 = pipeline.getFetchSourcesSha256(cp);
    const raw = { ...pipeline.buildCandidateFingerprints(new Set(), new Set(), old), sourceContractVersion: 7,
        batchDate: '2026-10-03', fetchBoundary: old, papers: [p], rawPapersSha256: stable([p]), fetchSourcesSha256: cp.fetchSourcesSha256 };
    const deep = { batchDate: '2026-10-03', papers: [p] }, archive = path.join(dataRoot, 'archive', '2026-10-03');
    put(path.join(archive, 'fetch-checkpoint.json'), cp); put(path.join(archive, 'raw-candidates.json'), raw);
    put(path.join(archive, 'filtered-papers.json'), { ...raw, status: 'complete' }); put(path.join(archive, 'deep-analysis-result.json'), deep);
    publish('2026-10-03', p.arxivId, [p], { sha256: sha(JSON.stringify(deep)) });
    const currentPath = path.join(dataRoot, 'current', 'deep-analysis-result.json');
    const latestPaper = { arxivId: '2610.00027', analysis: 'original text', parsed: { score: 1 } };
    const original = JSON.stringify({ batchDate: '2026-10-04', papers: [latestPaper] });
    publish('2026-10-04', latestPaper.arxivId, [{ ...latestPaper, normalizedArxivId: latestPaper.arxivId }],
        { contract: 'generation-input-source-reference-v1', version: 1, path: currentPath, sha256: sha(original), bytes: Buffer.byteLength(original) });
    put(currentPath, { batchDate: '2026-10-04', papers: [{ ...latestPaper, parsed: { score: 2 } }] });
    return { root, repo, dataRoot, git, put, cp, archive, currentPath, publish, sourcePaper: p, prepare: () => recovery.prepare({
        date: '2026-10-05', sourceCheckpointDate: '2026-10-03', blogRepo: repo, dataRoot }) };
}
test('独立恢复保留latest发布身份，真实较早五文件派生见证，激活后冷核不依赖current/archive', async t => {
    const f = fixture(t), prepared = await f.prepare();
    const b = boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot, until: '2026-10-05T04:00:00.000Z',
        requirePreviouslyFetched: true, fetchWitnessRecoveryManifest: prepared.manifestPath });
    assert.equal(b.lastDigestDate, '2026-10-04'); assert.equal(b.continuity.sourceCheckpointDate, '2026-10-03');
    assert.equal(b.continuity.originalSince, '2026-10-03T04:00:00.000Z');
    assert.equal(b.continuity.witnesses.arxiv[0].arxivId, '2610.00026');
    assert.throws(() => recovery.verifyActivation(b), /ENOENT/);
    recovery.activateBoundary(b, { blogRepo: f.repo, dataRoot: f.dataRoot });
    const original = recovery.verifyBoundary(b).checkpointBytes;
    assert.equal(boundary.validateDailyFetchContinuityCheckpoint(b, original), true);
    assert.throws(() => boundary.validateDailyFetchContinuityCheckpoint(b, Buffer.from('{}')), /原字节/);
    fs.rmSync(path.join(f.dataRoot, 'current'), { recursive: true }); fs.rmSync(path.join(f.dataRoot, 'archive'), { recursive: true });
    assert.equal(boundary.validateDailyFetchBoundary(b), true); recovery.verifyActivation(b);
    const source = path.join(path.dirname(prepared.manifestPath), 'source/archive/2026-10-03/raw-candidates.json');
    const bytes = fs.readFileSync(source); fs.writeFileSync(source, '{}');
    assert.throws(() => boundary.validateDailyFetchBoundary(b), /封存恢复材料/); fs.writeFileSync(source, bytes);
    fs.unlinkSync(source); fs.symlinkSync(f.currentPath, source);
    assert.throws(() => boundary.validateDailyFetchBoundary(b), /不安全/);
});
test('原current材料CAS漂移和科学正文变化不能激活；无精选截止日按source date', async t => {
    const f = fixture(t, { hfSelected: false }), p = await f.prepare();
    const b = boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot, until: '2026-10-05T04:00:00.000Z',
        requirePreviouslyFetched: true, fetchWitnessRecoveryManifest: p.manifestPath });
    assert.equal(b.continuity.overlapCutoffDate, '2026-10-03');
    fs.appendFileSync(f.currentPath, ' ');
    assert.throws(() => recovery.activateBoundary(b), /CAS/);
    const current = JSON.parse(fs.readFileSync(f.currentPath)); current.papers[0].analysis = 'changed'; f.put(f.currentPath, current);
    await assert.rejects(f.prepare(), /parsed/);
});
test('旧v1不能携带独立恢复字段，显式恢复不能掩盖已有损坏归档或更换目标日', async t => {
    const f = fixture(t), p = await f.prepare();
    assert.throws(() => boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot, until: '2026-10-06T04:00:00.000Z',
        requirePreviouslyFetched: true, fetchWitnessRecoveryManifest: p.manifestPath }), /目标日期/);
    await assert.rejects(recovery.prepare({ date: '2026-10-05', sourceCheckpointDate: '2026-10-04', blogRepo: f.repo, dataRoot: f.dataRoot }), /早于/);
    f.put(path.join(f.dataRoot, 'archive/2026-10-04/fetch-checkpoint.json'), '{}');
    await assert.rejects(f.prepare(), /归档/);
    const old = f.cp.fetchBoundary;
    const bad = { ...old, continuity: { contract: 'daily-fetch-continuity-v1', sourceCheckpointDate: '2026-10-03' } };
    const { identitySha256, ...body } = bad; bad.identitySha256 = stable(body);
    assert.throws(() => boundary.validateDailyFetchBoundary(bad), /不一致/);
});
test('下一日正常v1从已发布恢复批次继续，完整冷重放其原恢复链', async t => {
    const f = fixture(t), prepared = await f.prepare();
    const b = boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot, until: '2026-10-05T04:00:00.000Z',
        requirePreviouslyFetched: true, fetchWitnessRecoveryManifest: prepared.manifestPath });
    recovery.activateBoundary(b);
    const newPaper = { arxivId: '2610.00028', title: 'speech new', published: '2026-10-04T03:00:00Z', hfSelectedAt: '2026-10-05T00:00:00Z' };
    const sourcePapers = [f.sourcePaper, newPaper], historical = new Set(['2610.00001','2610.00026','2610.00027']);
    const fingerprints = pipeline.buildCandidateFingerprints(historical, historical, b);
    function entry(w, hf) {
        const field = hf ? 'selectedAt' : 'published', proofField = hf ? 'witnessSelectedAt' : 'witnessPublished';
        return { status: 'complete', papers: sourcePapers, papersCount: 2, papersSha256: stable(sourcePapers),
            health: { ok: true, ...(hf ? {} : { categoryId: w.categoryId }), provider: { boundaryIdentity: b.identitySha256, window: { since: b.since, until: b.until, covered: true },
                ...(hf ? { cutoffDate: b.continuity.overlapCutoffDate, dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } : {}),
                continuity: { required: true, status: 'verified', expectedId: w.arxivId, [proofField]: w[field],
                    matchedIds: [w.arxivId], encounterVerified: true } },
            continuity: { encounters: [{ arxivId: w.arxivId, [field]: w[field] }] } } };
    }
    const cp = { sourceContractVersion: 7, batchDate: '2026-10-05', batchStartedAt: b.until, ...fingerprints,
        historicalDedupIds: [...historical].sort(), arxiv: Object.fromEntries(b.continuity.witnesses.arxiv.map(w => [w.categoryId, entry(w, false)])),
        huggingface: entry(b.continuity.witnesses.huggingface, true) };
    cp.fetchSourcesSha256 = pipeline.getFetchSourcesSha256(cp);
    const raw = { ...fingerprints, sourceContractVersion: 7, batchDate: '2026-10-05', fetchBoundary: b,
        papers: [newPaper], rawPapersSha256: stable([newPaper]), fetchSourcesSha256: cp.fetchSourcesSha256 };
    const archive = path.join(f.dataRoot, 'archive/2026-10-05'), deep = { batchDate: '2026-10-05', papers: [newPaper] };
    f.put(path.join(archive, 'fetch-checkpoint.json'), cp); f.put(path.join(archive, 'raw-candidates.json'), raw);
    f.put(path.join(archive, 'filtered-papers.json'), { ...raw, status: 'complete' }); f.put(path.join(archive, 'deep-analysis-result.json'), deep);
    f.publish('2026-10-05', newPaper.arxivId, [newPaper], { sha256: sha(JSON.stringify(deep)) });
    fs.rmSync(f.archive, { recursive: true }); fs.unlinkSync(f.currentPath);
    fs.unlinkSync(path.join(f.dataRoot, 'current/blog-generation-manifest-2026-10-03.json'));
    assert.equal(boundary.validateDailyFetchBoundary(b), true);
    for (const [id, e] of Object.entries(cp.arxiv)) assert.equal(boundary.hasVerifiedFetchContinuity(e.health, b), true, id);
    assert.equal(boundary.hasVerifiedFetchContinuity(cp.huggingface.health, b, true), true, 'HF');
    const next = boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot, until: '2026-10-06T04:00:00.000Z', requirePreviouslyFetched: true });
    assert.equal(next.lastDigestDate, '2026-10-05'); assert.equal(next.continuity.contract, boundary.CONTINUITY_CONTRACT);
    assert.equal(next.continuity.originalSince, b.until);
    const sealed = path.join(path.dirname(prepared.manifestPath), 'source/archive/2026-10-03/filtered-papers.json');
    fs.writeFileSync(sealed, '{}');
    assert.throws(() => boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot,
        until: '2026-10-06T04:00:00.000Z', requirePreviouslyFetched: true }), /拒绝缩短/);
});
test('归档后增量、伪outer身份和私有权限漂移拒绝，CLI首先执行环境守卫', async t => {
    const f = fixture(t), prepared = await f.prepare();
    const b = boundary.resolveDailyFetchBoundary(f.repo, { dataRoot: f.dataRoot, until: '2026-10-05T04:00:00.000Z',
        requirePreviouslyFetched: true, fetchWitnessRecoveryManifest: prepared.manifestPath });
    assert.throws(() => recovery.verifyBoundary({ ...b, identitySha256: '../escape' }), /外层/);
    assert.throws(() => recovery.verifyBoundary({ ...b, identitySha256: '0'.repeat(64) }), /外层/);
    assert.throws(() => recovery.verifyBoundary({ ...b, unexpected: true }), /外层/);
    const latestArchive = path.join(f.dataRoot, 'archive/2026-10-04/fetch-checkpoint.json'); f.put(latestArchive, '{}');
    assert.throws(() => recovery.activateBoundary(b), /首次激活/); fs.unlinkSync(latestArchive);
    recovery.activateBoundary(b);
    const activation = path.join(path.dirname(prepared.manifestPath), 'activations', `${b.identitySha256}.json`);
    fs.chmodSync(activation, 0o644); assert.throws(() => recovery.activateBoundary(b), /私有/); fs.chmodSync(activation, 0o600);
    for (const file of ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json', 'deep-analysis-result.json']) {
        const target = path.join(path.dirname(prepared.manifestPath), 'source/archive/2026-10-03', file), bytes = fs.readFileSync(target);
        fs.writeFileSync(target, '{}'); assert.throws(() => recovery.verifyBoundary(b), /封存恢复材料/); fs.writeFileSync(target, bytes);
    }
    const sourceManifest = path.join(path.dirname(prepared.manifestPath), 'source/current/blog-generation-manifest-2026-10-03.json');
    fs.chmodSync(sourceManifest, 0o644); assert.throws(() => recovery.verifyBoundary(b), /私有/);
    assert.throws(() => execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/prepare-daily-fetch-witness-recovery.js'),
        '--date', '2026-10-05', '--source-date', '2026-10-03'], { env: { ...process.env, CODEX_SANDBOX: 'test' }, stdio: 'pipe' }),
    error => error.status !== 0 && error.stderr.toString().includes('必须在沙箱外运行'));
});

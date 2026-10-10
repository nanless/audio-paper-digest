'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { resolveDailyFetchBoundary, validateDailyFetchBoundary, readCommittedPublishedPaperIds } = require('../scripts/lib/daily-fetch-boundary.js');
const until = '2026-10-10T07:00:00.000Z';
function createPublishedBlogRepo(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-boundary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
    const put = (name, value) => { const f = path.join(root, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, value); };
    const citation = JSON.stringify({ arxivId: '2610.00026' });
    const digest = crypto.createHash('sha256').update(citation).digest('hex');
    put('static/data/papers/2026-10-03/2610-00026/citation.json', citation);
    put('content/posts/2026-10-03-paper.md', `---
date: 2026-10-03
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
draft: false
paper_digest_arxiv_id: "2610.00026"
paper_digest_sidecars: {"citation.json":{"sha256":"${digest}"}}
---
`);
    put('content/posts/2026-10-03.md', `---
date: 2026-10-03
draft: false
paper_digest_pipeline_owned: true
paper_digest_page_type: index
---
共分析 **1** 篇论文
[x](/posts/2026-10-03-paper)
`);
    git('add', '.'); git('commit', '-m', 'test'); git('update-ref', 'refs/remotes/origin/main', 'HEAD'); return { root, git, put };
}
test('只用已提交页面并按提交月份保守重叠，固定结束时间身份可复算', t => {
    const f = createPublishedBlogRepo(t); const a = resolveDailyFetchBoundary(f.root, { until });
    f.put('content/posts/2026-10-05.md', '未发布'); f.git('add', '.'); f.git('commit', '-m', 'local-only'); f.put('content/posts/2026-10-03-paper.md', '无关工作区修改');
    assert.deepEqual(resolveDailyFetchBoundary(f.root, { until }), a);
    const dataRoot = path.join(f.root, 'pending-data');
    const noCheckpoint = resolveDailyFetchBoundary(f.root, { until, dataRoot });
    fs.mkdirSync(path.join(dataRoot, 'current'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'current/fetch-checkpoint.json'), JSON.stringify({ sourceContractVersion: 7, batchDate: '2026-10-10', status: 'partial' }));
    const afterSave = resolveDailyFetchBoundary(f.root, { until, dataRoot });
    assert.equal(JSON.stringify(afterSave), JSON.stringify(noCheckpoint));
    assert.equal(afterSave.identitySha256, noCheckpoint.identitySha256);
    assert.ok(afterSave.diagnostics.unpublishedCurrentReason);
    assert.equal(validateDailyFetchBoundary(JSON.parse(JSON.stringify(afterSave))), true);
    assert.equal(a.since, '2026-10-01T00:00:00.000Z'); assert.equal(a.lastDigestDate, '2026-10-03');
    assert.equal(validateDailyFetchBoundary(JSON.parse(JSON.stringify(a))), true);
    assert.equal(validateDailyFetchBoundary(Object.fromEntries(Object.entries(a).reverse())), true);
    assert.throws(() => validateDailyFetchBoundary({ ...a, until: '2026-10-11T07:00:00.000Z' }), /SHA/);
});
test('拒绝无已发布日更、引用SHA损坏和错误时间', t => {
    const f = createPublishedBlogRepo(t); assert.throws(() => resolveDailyFetchBoundary(f.root, { until: '2026-02-30T00:00:00Z' }), /ISO/);
    f.put('static/data/papers/2026-10-03/2610-00026/citation.json', '{}'); f.git('add', '.'); f.git('commit', '-m', 'bad'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until }), /元数据/);
    f.git('rm', 'content/posts/2026-10-03.md'); f.git('commit', '-m', 'remove'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until }), /初次抓取/);
});

test('已发布ID只读远端正式页字段，不读正文链接或未推送页', t => {
    const f = createPublishedBlogRepo(t);
    assert.deepEqual([...readCommittedPublishedPaperIds(f.root)], ['2610.00026']);
    f.put('content/posts/local.md', '---\ndraft: false\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_arxiv_id: "2610.99999"\n---\nhttps://arxiv.org/abs/2510.00001');
    f.git('add', '.'); f.git('commit', '-m', 'not pushed');
    assert.deepEqual([...readCommittedPublishedPaperIds(f.root)], ['2610.00026']);
    f.git('update-ref', '-d', 'refs/remotes/origin/main');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until }), /发布基线/);
});

test('合法v7发布窗口继续上次结束时间，损坏来源证明不退回月首', t => {
    const f = createPublishedBlogRepo(t); const dataRoot = path.join(f.root, 'proofs');
    const old = resolveDailyFetchBoundary(f.root, { until: '2026-10-03T01:00:00.000Z', dataRoot });
    const pipeline = require('../scripts/full-fetch.js');
    const { mergeAndDeduplicate } = require('../scripts/fetch-huggingface-papers.js');
    const stable = pipeline.stableContentSha256;
    const provider = { boundaryIdentity: old.identitySha256, window: { since: old.since, until: old.until, covered: true } };
    const sourcePapers = [{ arxivId: '2610.00026v1', title: 'selected', abstract: 'speech', categories: ['cs.SD'] },
        { arxivId: '2610.09999v1', title: 'unselected', abstract: 'speech', categories: ['cs.SD'] }];
    const entry = { status: 'complete', papers: sourcePapers, papersCount: sourcePapers.length, papersSha256: stable(sourcePapers), health: { ok: true, provider } };
    const cp = { sourceContractVersion: 7, batchDate: '2026-10-03', batchStartedAt: old.until,
        ...pipeline.buildCandidateFingerprints(new Set(), new Set(), old), historicalDedupIds: [],
        arxiv: Object.fromEntries(['eess.AS','cs.SD','eess.SP','cs.CL','cs.LG','cs.AI','cs.MM'].map(id => [id, entry])),
        huggingface: { ...entry, health: { ok: true, provider: { ...provider, cutoffDate: old.lastDigestDate, dailyCovered: true, dailySelectedAtField: 'paper.submittedOnDailyAt' } } } };
    cp.fetchSourcesSha256 = pipeline.getFetchSourcesSha256(cp);
    const papers = mergeAndDeduplicate(sourcePapers, []);
    const raw = { ...pipeline.buildCandidateFingerprints(new Set(), new Set(), old), sourceContractVersion: 7, batchDate: '2026-10-03', fetchBoundary: old, papers, rawPapersSha256: stable(papers), fetchSourcesSha256: cp.fetchSourcesSha256 };
    const selected = papers.filter(p => String(p.arxivId).replace(/v\d+$/, '') === '2610.00026');
    const filtered = { ...raw, papers: selected, status: 'complete' }; const deep = { batchDate: '2026-10-03', papers: selected };
    const put = (relative, value) => { const file = path.join(dataRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    put('archive/2026-10-03/fetch-checkpoint.json', cp); put('archive/2026-10-03/raw-candidates.json', raw);
    put('archive/2026-10-03/filtered-papers.json', filtered); put('archive/2026-10-03/deep-analysis-result.json', deep);
    const deepSha = crypto.createHash('sha256').update(JSON.stringify(deep)).digest('hex');
    put('current/blog-generation-manifest-2026-10-03.json', { schemaVersion: 3, date: '2026-10-03', inputSourceReference: { sha256: deepSha },
        files: [{ path: old.provenance.indexPath, sha256: old.provenance.indexSha256 }, ...old.provenance.papers.map(p => ({ path: p.path, sha256: p.sha256 }))] });
    const result = resolveDailyFetchBoundary(f.root, { until, dataRoot });
    assert.equal(result.since, old.until); assert.equal(result.provenance.boundaryBasis, 'verified-previous-fetch-until');
    const missingSelectedField = structuredClone(cp);
    delete missingSelectedField.huggingface.health.provider.dailySelectedAtField;
    missingSelectedField.fetchSourcesSha256 = pipeline.getFetchSourcesSha256(missingSelectedField);
    put('archive/2026-10-03/fetch-checkpoint.json', missingSelectedField);
    put('archive/2026-10-03/raw-candidates.json', { ...raw, fetchSourcesSha256: missingSelectedField.fetchSourcesSha256 });
    put('archive/2026-10-03/filtered-papers.json', { ...filtered, fetchSourcesSha256: missingSelectedField.fetchSourcesSha256 });
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until, dataRoot }), /拒绝缩短/);
    put('archive/2026-10-03/fetch-checkpoint.json', cp);
    put('archive/2026-10-03/raw-candidates.json', raw);
    put('archive/2026-10-03/filtered-papers.json', filtered);
    const dropped = { ...raw, papers: selected, rawPapersSha256: stable(selected) };
    put('archive/2026-10-03/raw-candidates.json', dropped);
    put('archive/2026-10-03/filtered-papers.json', { ...filtered, rawPapersSha256: dropped.rawPapersSha256 });
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until, dataRoot }), /拒绝缩短/);
    put('archive/2026-10-03/raw-candidates.json', raw);
    put('archive/2026-10-03/filtered-papers.json', filtered);
    const archive = path.join(dataRoot, 'archive/2026-10-03');
    for (const name of ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json', 'deep-analysis-result.json']) {
        fs.copyFileSync(path.join(archive, name), path.join(dataRoot, 'current', name));
    }
    fs.rmSync(archive, { recursive: true });
    const inCurrent = resolveDailyFetchBoundary(f.root, { until, dataRoot });
    assert.equal(inCurrent.since, old.until);
    assert.equal(JSON.stringify(inCurrent), JSON.stringify(result));
    assert.equal(inCurrent.identitySha256, result.identitySha256);
    put('current/fetch-checkpoint.json', { ...cp, arxiv: { ...cp.arxiv, 'cs.SD': { ...entry, papersSha256: '0'.repeat(64) } } });
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until, dataRoot }), /拒绝缩短/);
    put('current/fetch-checkpoint.json', cp);
    put('current/deep-analysis-result.json', { ...deep, status: 'partial' });
    const unpublished = resolveDailyFetchBoundary(f.root, { until, dataRoot });
    assert.equal(unpublished.since, '2026-10-01T00:00:00.000Z');
    assert.match(unpublished.diagnostics.unpublishedCurrentReason, /未关联/);
    fs.writeFileSync(path.join(dataRoot, 'current/fetch-checkpoint.json'), '{bad');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until, dataRoot }), SyntaxError);
    for (const [name, value] of [['fetch-checkpoint.json', cp], ['raw-candidates.json', raw], ['filtered-papers.json', filtered], ['deep-analysis-result.json', deep]]) put('archive/2026-10-03/' + name, value);
    cp.arxiv['cs.SD'] = { ...entry, papersSha256: '0'.repeat(64) }; put('archive/2026-10-03/fetch-checkpoint.json', cp);
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until, dataRoot }), /拒绝缩短/);
});

test('正文伪字段、未确认发布的独立页和重复YAML键不能成为边界', t => {
    const f = createPublishedBlogRepo(t); const original = fs.readFileSync(path.join(f.root, 'content/posts/2026-10-03-paper.md'), 'utf8');
    f.put('content/posts/2026-10-03-paper.md', original.replace('draft: false\n', ''));
    f.git('add', '.'); f.git('commit', '-m', 'missing draft'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until }), /身份不完整/);
    f.put('content/posts/2026-10-03-paper.md', original);
    f.put('content/posts/2026-10-03.md', '---\ndate: 2026-10-03\ndraft: true\n---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: index\ndraft: false');
    f.git('add', '.'); f.git('commit', '-m', 'fake body'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until }), /初次抓取/);
    f.put('content/posts/2026-10-03.md', '---\ndraft: false\ndraft: true\n---\n');
    f.git('add', '.'); f.git('commit', '-m', 'duplicate'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => resolveDailyFetchBoundary(f.root, { until }), /键重复/);
});

test('旧非流水线损坏页面跳过，声称正式页的损坏YAML仍拒绝', t => {
    const f = createPublishedBlogRepo(t);
    f.put('content/posts/legacy.md', '---\ndescription: "broken\n---\n'); f.git('add', '.'); f.git('commit', '-m', 'legacy'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const ids = readCommittedPublishedPaperIds(f.root); assert.deepEqual([...ids], ['2610.00026']); assert.ok(ids.skippedLegacyPages >= 1);
    f.put('content/posts/legacy.md', '---\npaper_digest_pipeline_owned: true\npaper_digest_page_type: paper\npaper_digest_arxiv_id: "2610.09999"\ndraft: false\ndescription: "broken\n---\n');
    f.git('add', '.'); f.git('commit', '-m', 'bad owned'); f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.throws(() => readCommittedPublishedPaperIds(f.root), /开头的元数据/);
});

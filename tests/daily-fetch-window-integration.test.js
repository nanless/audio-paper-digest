const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchHuggingFacePapers } = require('../scripts/fetch-huggingface-papers');
const crypto = require('node:crypto');
const boundary = { contract: 'daily-fetch-boundary-v1', lastDigestDate: '2026-10-05',
    since: '2026-10-04T16:00:00.000Z', until: '2026-10-10T14:00:00.000Z' };
boundary.identitySha256 = crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(boundary).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
function item(index, selectedAt = '2026-10-09T00:00:00Z') {
    return { publishedAt: selectedAt, paper: { id: `2610.${String(index).padStart(5, '0')}`,
        title: 'Audio paper', summary: 'Audio study.', authors: [], publishedAt: '2020-01-01T00:00:00Z' } };
}
function options(fetchFn) {
    return { cutoffDate: boundary.lastDigestDate, boundary, minUpvotes: 0,
        fetchedAt: '2026-10-10T22:00:00+08:00', sleepFn: async () => {}, fetchFn };
}
test('HuggingFace 补更超过二十满页，仍读取截止日同日的旧论文精选', async () => {
    const requests = [];
    const papers = await fetchHuggingFacePapers(new Set(), options(url => {
        requests.push(url);
        if (!url.includes('daily_papers')) return [];
        const page = Number(new URL(url).searchParams.get('p'));
        if (page < 21) return Array.from({ length: 100 }, (_, index) => item(page * 100 + index));
        return [item(2200, '2026-10-05T00:00:00Z')];
    }));
    assert.equal(papers.length, 2101);
    assert.ok(requests.some(url => url.includes('p=21')));
    assert.equal(papers._sourceHealth.provider.dailyCovered, true);
    assert.equal(papers._sourceHealth.provider.boundaryIdentity, boundary.identitySha256);
});
test('每日精选重复满页不能由补充接口假装覆盖完成', async () => {
    const page = Array.from({ length: 100 }, (_, index) => item(index));
    await assert.rejects(fetchHuggingFacePapers(new Set(), options(url =>
        url.includes('daily_papers') ? page : [])), error =>
        error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.provider.window.covered === false
        && error.sourceHealth.provider.dailyCovered === false);
});
test('HuggingFace 后页失败时保留未完成范围，补充接口成功仍不得通过', async () => {
    await assert.rejects(fetchHuggingFacePapers(new Set(), options(url => {
        if (!url.includes('daily_papers')) return [];
        return url.includes('p=0') ? Array.from({ length: 100 }, (_, index) => item(index))
            : { ok: false, error: '本地模拟第二页失败' };
    })), error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.ok === false
        && error.sourceHealth.provider.window.covered === false);
});
test('补更截止日之后还有更早的精选时，仅保存截止日及之后的记录', async () => {
    const papers = await fetchHuggingFacePapers(new Set(), options(url => url.includes('daily_papers')
        ? [item(1, '2026-10-05T00:00:00Z'), item(2, '2026-10-04T00:00:00Z')] : []));
    assert.deepEqual(papers.map(paper => paper.arxivId), ['2610.00001']);
    assert.equal(papers._sourceHealth.coverage.reachedCutoff, true);
});

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const pipeline = require('../scripts/full-fetch');
const validator = require('../scripts/validate-data-files');
const { resolveDailyFetchBoundary, readCommittedPublishedPaperIds } = require('../scripts/lib/daily-fetch-boundary');
function blogFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-window-blog-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
    const put = (name, value) => {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, value);
    };
    const citation = JSON.stringify({ arxivId: '2610.00026' });
    const sha = crypto.createHash('sha256').update(citation).digest('hex');
    put('static/data/papers/2026-10-03/2610-00026/citation.json', citation);
    put('content/posts/2026-10-03-paper.md', `---
date: 2026-10-03
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
draft: false
paper_digest_arxiv_id: "2610.00026"
paper_digest_sidecars: {"citation.json":{"sha256":"${sha}"}}
---
参考文献 https://arxiv.org/abs/2610.00999
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
    git('add', '.'); git('commit', '-m', '本地已发布样例'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return { root, put, git };
}
function completeCheckpoint(boundary, count = 0) {
    const provider = { boundaryIdentity: boundary.identitySha256,
        window: { since: boundary.since, until: boundary.until, covered: true } };
    const published = new Set(boundary.provenance?.papers?.map(paper => paper.arxivId) || []);
    const common = pipeline.buildCandidateFingerprints(published, published, boundary);
    return { timestamp: require('../scripts/utils').normalizeToBeijingISOString(boundary.until), batchStartedAt: require('../scripts/utils').normalizeToBeijingISOString(boundary.until), batchDate: '2026-10-10', batchId: 'b'.repeat(16),
        ...common, historicalDedupIds: [...published].sort(), categoryOrder: require('../scripts/config').ARXIV_CATEGORIES.map(category => category.id),
        arxiv: Object.fromEntries(require('../scripts/config').ARXIV_CATEGORIES.map(category => [category.id, {
            status: 'complete', papers: Array.from({ length: count }, (_, index) => ({ arxivId: `2610.${String(index).padStart(5, '0')}` })),
            health: { id: category.id, ok: true, provider: structuredClone(provider) }
        }])), huggingface: { status: 'complete', papers: [], health: { ok: true,
            provider: { ...provider, cutoffDate: boundary.lastDigestDate, dailyCovered: true } } } };
}
test('合法同日 v7 检查点固定原抓取终点；后续时钟变化不重算候选范围', t => {
    const blog = blogFixture(t);
    const original = resolveDailyFetchBoundary(blog.root, { until: boundary.until });
    const checkpoint = completeCheckpoint(original);
    assert.deepEqual(pipeline.resolvePinnedFetchBoundary(blog.root, '2026-10-10T15:00:00Z', checkpoint), original);
    const changed = structuredClone(checkpoint);
    changed.fetchBoundary.identitySha256 = 'f'.repeat(64);
    assert.notEqual(pipeline.resolvePinnedFetchBoundary(blog.root, '2026-10-10T15:00:00Z', changed).until, original.until);
    checkpoint.fetchBoundary.until = '2026-10-11T15:00:00Z';
    assert.equal(pipeline.resolvePinnedFetchBoundary(blog.root, '2026-10-10T15:00:00Z', checkpoint).until, '2026-10-10T15:00:00.000Z');
});
test('新范围指纹拒绝旧数量上限检查点，旧文件字节仍保留', t => {
    const blog = blogFixture(t);
    const actual = resolveDailyFetchBoundary(blog.root, { until: boundary.until });
    const checkpoint = completeCheckpoint(actual);
    const filename = path.join(blog.root, 'checkpoint.json');
    checkpoint.sourceContractVersion = 6;
    checkpoint.candidateFingerprint = '0'.repeat(16);
    pipeline.saveFetchCheckpoint(checkpoint, filename);
    const original = fs.readFileSync(filename);
    assert.equal(pipeline.loadFetchCheckpoint('2026-10-10', pipeline.buildCandidateFingerprints(new Set(), new Set(), actual).candidateFingerprint, filename), null);
    assert.deepEqual(fs.readFileSync(filename), original);
    const replacement = completeCheckpoint(actual);
    pipeline.saveFetchCheckpoint(replacement, filename);
    const preserved = path.join(blog.root, `checkpoint-before-v7-${crypto.createHash('sha256').update(original).digest('hex')}.json`);
    assert.deepEqual(fs.readFileSync(preserved), original);
    assert.equal(JSON.parse(fs.readFileSync(filename)).sourceContractVersion, 7);
});
test('超过100条且七来源完整的检查点通过；覆盖标记伪造或错范围不能通过', t => {
    const blog = blogFixture(t);
    const actual = resolveDailyFetchBoundary(blog.root, { until: boundary.until });
    const checkpoint = completeCheckpoint(actual, 150);
    const filename = path.join(blog.root, 'checkpoint.json');
    pipeline.saveFetchCheckpoint(checkpoint, filename);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(checkpoint), true);
    assert.deepEqual(validator.validateFetchCheckpointFile(filename), []);
    checkpoint.arxiv['cs.SD'].health.provider.window.covered = false;
    pipeline.saveFetchCheckpoint(checkpoint, filename);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(checkpoint), false);
    assert.ok(validator.validateFetchCheckpointFile(filename).some(issue => JSON.stringify(issue).includes('未证明完整补更范围')));
    checkpoint.arxiv['cs.SD'].health.provider.window.covered = true;
    checkpoint.arxiv['cs.SD'].health.provider.boundaryIdentity = 'f'.repeat(64);
    assert.equal(pipeline.hasCompleteFetchCheckpoint(checkpoint), false);
});
test('合法空范围可复用，但 HuggingFace 只有补充接口成功不能算完整', t => {
    const blog = blogFixture(t);
    const actual = resolveDailyFetchBoundary(blog.root, { until: boundary.until });
    const checkpoint = completeCheckpoint(actual);
    pipeline.saveFetchCheckpoint(checkpoint, path.join(blog.root, 'checkpoint.json'));
    assert.equal(pipeline.hasCrossProcessReusableFetchCheckpoint(checkpoint), true);
    checkpoint.huggingface.health.provider.dailyCovered = false;
    assert.equal(pipeline.hasCompleteFetchCheckpoint(checkpoint), false);
});
test('正式论文页身份可去重，正文引用和未推送页面不能抹掉待补抓论文', t => {
    const blog = blogFixture(t);
    blog.put('content/posts/2026-10-09-unpushed.md', `---
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
draft: false
paper_digest_arxiv_id: "2610.00100"
---
`);
    blog.git('add', '.'); blog.git('commit', '-m', '未推送的本地页面');
    assert.deepEqual([...readCommittedPublishedPaperIds(blog.root)], ['2610.00026']);
});

test('真实入口更新本地 Git 远端后采用新发布批次，未推送第三批不作边界', t => {
    const blog = blogFixture(t);
    const origin = path.join(blog.root, 'origin.git');
    execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
    blog.git('remote', 'add', 'origin', origin);
    blog.git('push', 'origin', 'HEAD:main');
    const first = blog.git('rev-parse', 'HEAD').toString().trim();
    const addDaily = date => {
        for (const name of ['content/posts/2026-10-03-paper.md', 'content/posts/2026-10-03.md',
            'static/data/papers/2026-10-03/2610-00026/citation.json']) {
            blog.put(name.replaceAll('2026-10-03', date), fs.readFileSync(path.join(blog.root, name), 'utf8').replaceAll('2026-10-03', date));
        }
        blog.git('add', '.'); blog.git('commit', '-m', `本地批次 ${date}`);
    };
    addDaily('2026-10-04');
    blog.git('push', 'origin', 'HEAD:main');
    blog.git('update-ref', 'refs/remotes/origin/main', first);
    addDaily('2026-10-05');
    assert.equal(resolveDailyFetchBoundary(blog.root, { until: boundary.until }).lastDigestDate, '2026-10-03');
    assert.deepEqual([...pipeline.refreshCommittedPublishedPaperIds(blog.root)], ['2610.00026']);
    assert.equal(resolveDailyFetchBoundary(blog.root, { until: boundary.until }).lastDigestDate, '2026-10-04');
});

test('上一已发布 v7 批次使用实际合并和来源 SHA 产物续界，坏来源证明不降级', t => {
    const blog = blogFixture(t);
    const dataRoot = path.join(blog.root, 'run-data');
    const previous = { contract: 'daily-fetch-boundary-v1', lastDigestDate: '2026-10-02',
        since: '2026-10-01T00:00:00.000Z', until: '2026-10-03T14:00:00.000Z' };
    previous.identitySha256 = pipeline.stableContentSha256(previous);
    const checkpoint = completeCheckpoint(previous);
    checkpoint.batchDate = '2026-10-03';
    const paper = { arxivId: '2610.00026', paper_id: '2610.00026', title: 'Audio study',
        published: '2026-10-02T10:00:00Z', sources: ['arxiv'] };
    const unselected = { ...paper, arxivId: '2610.00999', paper_id: '2610.00999' };
    checkpoint.arxiv['eess.AS'].papers = [paper, unselected];
    for (const entry of [...Object.values(checkpoint.arxiv), checkpoint.huggingface]) pipeline.applyFetchSourceIntegrity(entry);
    checkpoint.fetchSourcesSha256 = pipeline.getFetchSourcesSha256(checkpoint);
    const merged = require('../scripts/fetch-huggingface-papers').mergeAndDeduplicate([paper, unselected], []);
    assert.equal(merged[0].published, paper.published);
    const common = { ...pipeline.buildCandidateFingerprints(new Set(checkpoint.historicalDedupIds), new Set(checkpoint.historicalDedupIds), previous),
        fetchBoundary: previous, batchDate: '2026-10-03', fetchSourcesSha256: checkpoint.fetchSourcesSha256,
        rawPapersSha256: pipeline.stableContentSha256(merged), papers: merged };
    const deepBytes = Buffer.from(JSON.stringify({ batchDate: '2026-10-03', papers: [merged[0]] }));
    const directory = path.join(dataRoot, 'archive', '2026-10-03');
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'current'));
    fs.writeFileSync(path.join(directory, 'fetch-checkpoint.json'), JSON.stringify(checkpoint));
    fs.writeFileSync(path.join(directory, 'raw-candidates.json'), JSON.stringify(common));
    fs.writeFileSync(path.join(directory, 'filtered-papers.json'), JSON.stringify({ ...common, papers: [merged[0]], status: 'complete' }));
    fs.writeFileSync(path.join(directory, 'deep-analysis-result.json'), deepBytes);
    const baseline = resolveDailyFetchBoundary(blog.root, { until: boundary.until });
    fs.writeFileSync(path.join(dataRoot, 'current', 'blog-generation-manifest-2026-10-03.json'), JSON.stringify({
        date: '2026-10-03', schemaVersion: 3,
        inputSourceReference: { sha256: crypto.createHash('sha256').update(deepBytes).digest('hex') },
        files: [{ path: baseline.provenance.indexPath, sha256: baseline.provenance.indexSha256 },
            ...baseline.provenance.papers.map(paper => ({ path: paper.path, sha256: paper.sha256 }))]
    }));
    const next = resolveDailyFetchBoundary(blog.root, { until: boundary.until, dataRoot });
    assert.equal(next.since, previous.until);
    assert.equal(next.provenance.boundaryBasis, 'verified-previous-fetch-until');
    const rawFilename = path.join(directory, 'raw-candidates.json');
    const originalRaw = fs.readFileSync(rawFilename);
    fs.writeFileSync(rawFilename, JSON.stringify({ ...common, papers: [merged[0]], rawPapersSha256: pipeline.stableContentSha256([merged[0]]) }));
    assert.throws(() => resolveDailyFetchBoundary(blog.root, { until: boundary.until, dataRoot }), /拒绝缩短补抓范围/);
    fs.writeFileSync(rawFilename, originalRaw);
    for (const name of ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json', 'deep-analysis-result.json']) {
        fs.renameSync(path.join(directory, name), path.join(dataRoot, 'current', name));
    }
    const moved = resolveDailyFetchBoundary(blog.root, { until: boundary.until, dataRoot });
    assert.equal(moved.identitySha256, next.identitySha256);
    checkpoint.arxiv['eess.AS'].health.provider.window.covered = false;
    fs.writeFileSync(path.join(dataRoot, 'current', 'fetch-checkpoint.json'), JSON.stringify(checkpoint));
    assert.throws(() => resolveDailyFetchBoundary(blog.root, { until: boundary.until, dataRoot }), /拒绝缩短补抓范围/);
});

test('旧批分析成功但没有正式发布的 HuggingFace 论文仍保留入选', () => {
    const child = require('node:child_process').spawnSync(process.execPath,
        [path.join(__dirname, 'fixtures/daily-fetch-unpublished-hf.cjs')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
});

test('首次保存未发布的本日检查点后，继续固定原终点和候选指纹', t => {
    const blog = blogFixture(t);
    const dataRoot = path.join(blog.root, 'local-data');
    fs.mkdirSync(path.join(dataRoot, 'current'), { recursive: true });
    const initial = resolveDailyFetchBoundary(blog.root, { until: boundary.until, dataRoot });
    const checkpoint = completeCheckpoint(initial);
    fs.writeFileSync(path.join(dataRoot, 'current', 'fetch-checkpoint.json'), JSON.stringify(checkpoint));
    const pinned = pipeline.resolvePinnedFetchBoundary(blog.root, '2026-10-10T15:00:00Z', checkpoint, null, { dataRoot });
    assert.equal(pinned.until, initial.until);
    assert.equal(pinned.identitySha256, initial.identitySha256);
    assert.deepEqual(JSON.parse(JSON.stringify(pinned)), JSON.parse(JSON.stringify(initial)));
});

test('每日精选没有入选时间时，不能拿论文原始日期证明分页覆盖', async () => {
    const invalid = item(1);
    delete invalid.publishedAt;
    await assert.rejects(fetchHuggingFacePapers(new Set(), options(url => url.includes('daily_papers') ? [invalid] : [])),
        error => error.code === 'SOURCE_FETCH_FAILED' && error.sourceHealth.provider.dailyCovered === false);
});

test('v7 类别集合不是数组时，公开数据检查返回问题而非抛类型错误', t => {
    const blog = blogFixture(t);
    const actual = resolveDailyFetchBoundary(blog.root, { until: boundary.until });
    const checkpoint = completeCheckpoint(actual);
    const files = Object.fromEntries(['rawCandidates', 'filterDecisions', 'filteredPapers', 'deepAnalysisResult', 'fetchCheckpoint', 'papers']
        .map(key => [key, path.join(blog.root, `${key}.json`)]));
    pipeline.saveFetchCheckpoint(checkpoint, files.fetchCheckpoint);
    const common = { timestamp: checkpoint.timestamp, batchDate: checkpoint.batchDate, batchId: checkpoint.batchId,
        ...pipeline.buildCandidateFingerprints(new Set(), new Set(), actual), status: 'complete', papers: [],
        rawPapersSha256: pipeline.stableContentSha256([]), fetchSourcesSha256: checkpoint.fetchSourcesSha256,
        sourceHealth: { sourceContractVersion: 7, fetchBoundary: actual, arxiv: { categories: {} }, huggingface: { ok: true } } };
    fs.writeFileSync(files.rawCandidates, JSON.stringify(common));
    fs.writeFileSync(files.filteredPapers, JSON.stringify(common));
    fs.writeFileSync(files.filterDecisions, JSON.stringify({ ...common, decisions: {}, stats: { complete: true } }));
    const issues = validator.validateCurrentDataFiles(files);
    assert.ok(issues.some(issue => issue.includes('categories 必须是数组')));
});

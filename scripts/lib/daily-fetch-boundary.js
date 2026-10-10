'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const CONTRACT = 'daily-fetch-boundary-v1';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function strictInstant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
        throw new Error('日更抓取边界必须使用有效的 UTC ISO 时间');
    }
    return value;
}
function identity(body) { return stableSha(body); }
function frontmatter(bytes) {
    const match = bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error('页面缺少完整的开头元数据');
    const doc = YAML.parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length) throw new Error('页面开头的元数据无效或键重复');
    const value = doc.toJSON();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('页面开头的元数据必须是对象');
    return value;
}
function normalizedId(paper) {
    const id = typeof paper === 'string' ? paper : paper?.paper_id || paper?.arxivId || paper?.id || '';
    return String(id).replace(/v\d+$/, '').trim().toLowerCase();
}
function validDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date + 'T00:00:00Z'))
    && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date; }
function validateDailyFetchBoundary(boundary) {
    if (!boundary || boundary.contract !== CONTRACT || !validDate(boundary.lastDigestDate || '')) {
        throw new Error('日更抓取边界缺少有效的上一已发布批次');
    }
    strictInstant(boundary.since); strictInstant(boundary.until);
    if (Date.parse(boundary.since) >= Date.parse(boundary.until)) throw new Error('日更抓取起始时间必须早于结束时间');
    const { identitySha256, ...body } = boundary;
    if (!/^[a-f0-9]{64}$/.test(identitySha256 || '') || identity(body) !== identitySha256) {
        throw new Error('日更抓取边界身份 SHA 不一致');
    }
    return true;
}
function stableSha(value) {
    const normalize = x => Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map(k => [k, normalize(x[k])])) : x;
    return hash(JSON.stringify(normalize(value)));
}
function verifiedPreviousWindow(dataRoot, date, papers, indexPath, indexSha256) {
    let directory = path.join(dataRoot, 'archive', date);
    let cpPath = path.join(directory, 'fetch-checkpoint.json');
    const notPublished = reason => ({ unpublishedCurrentReason: reason });
    if (!fs.existsSync(cpPath)) {
        directory = path.join(dataRoot, 'current'); cpPath = path.join(directory, 'fetch-checkpoint.json');
        if (!fs.existsSync(cpPath)) return null;
        const current = JSON.parse(fs.readFileSync(cpPath));
        if (current.batchDate !== date || current.sourceContractVersion !== 7) return notPublished('当前检查点不是上一已发布日期的 v7 批次');
        const deepPath = path.join(directory, 'deep-analysis-result.json');
        const manifestPath = path.join(directory, `blog-generation-manifest-${date}.json`);
        if (!fs.existsSync(deepPath) || !fs.existsSync(manifestPath)) return notPublished('当前批次没有关联上一已发布页面的分析结果和生成清单');
        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        const deepBytes = fs.readFileSync(deepPath);
        JSON.parse(deepBytes);
        if (manifest.inputSourceReference?.sha256 !== hash(deepBytes)
            || manifest.date !== date || manifest.schemaVersion !== 3
            || !manifest.files?.some(f => f.path === indexPath && f.sha256 === indexSha256 && !f.deleted)
            || !papers.every(p => manifest.files.some(f => f.path === p.path && f.sha256 === p.sha256 && !f.deleted))) {
            return notPublished('当前批次的分析结果或生成清单未关联上一已发布页面');
        }
    }
    const cp = JSON.parse(fs.readFileSync(cpPath));
    if (cp.sourceContractVersion !== 7) return null;
    const read = name => { const filename = path.join(directory, name); return { filename, bytes: fs.readFileSync(filename) }; };
    const records = ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json', 'deep-analysis-result.json'].map(read);
    const [checkpoint, raw, filtered, deep] = records.map(r => JSON.parse(r.bytes));
    const fail = () => { throw new Error('上一已发布 v7 抓取窗口的来源或发布证明不完整，拒绝缩短补抓范围'); };
    try { validateDailyFetchBoundary(checkpoint.fetchBoundary); } catch { fail(); }
    const boundary = checkpoint.fetchBoundary;
    const categories = ['eess.AS', 'cs.SD', 'eess.SP', 'cs.CL', 'cs.LG', 'cs.AI', 'cs.MM'];
    const covered = (entry, hf = false) => {
        const provider = entry?.health?.provider;
        return entry?.status === 'complete' && entry.health?.ok === true && Array.isArray(entry.papers)
            && entry.papersCount === entry.papers.length && entry.papersSha256 === stableSha(entry.papers)
            && provider?.boundaryIdentity === boundary.identitySha256 && provider.window?.since === boundary.since
            && provider.window?.until === boundary.until && provider.window?.covered === true
            && (!hf || (provider.cutoffDate === boundary.lastDigestDate && provider.dailyCovered === true
                && provider.dailySelectedAtField === 'paper.submittedOnDailyAt'));
    };
    if (checkpoint.batchDate !== date || checkpoint.coverageStrategy !== 'previous-digest-window-v1'
        || !categories.every(id => covered(checkpoint.arxiv?.[id])) || !covered(checkpoint.huggingface, true)
        || Date.parse(checkpoint.batchStartedAt) !== Date.parse(boundary.until)) fail();
    const sources = stableSha({ fetchBoundary: boundary,
        providers: Object.fromEntries(Object.entries(checkpoint.arxiv || {}).map(([id, e]) => [id, e.health.provider])),
        huggingfaceProvider: checkpoint.huggingface.health.provider,
        arxiv: Object.fromEntries(Object.entries(checkpoint.arxiv).sort(([a], [b]) => a.localeCompare(b))
            .map(([id, e]) => [id, { status: e.status, papersCount: e.papersCount, papersSha256: e.papersSha256 }])),
        huggingface: { status: checkpoint.huggingface.status, papersCount: checkpoint.huggingface.papersCount, papersSha256: checkpoint.huggingface.papersSha256 } });
    if (checkpoint.fetchSourcesSha256 !== sources || raw.fetchSourcesSha256 !== sources
        || raw.sourceContractVersion !== 7 || filtered.sourceContractVersion !== 7 || filtered.status !== 'complete'
        || raw.batchDate !== date || filtered.batchDate !== date || deep.batchDate !== date
        || stableSha(raw.fetchBoundary) !== stableSha(boundary) || stableSha(filtered.fetchBoundary) !== stableSha(boundary)
        || !Array.isArray(raw.papers) || raw.rawPapersSha256 !== stableSha(raw.papers)
        || filtered.rawPapersSha256 !== raw.rawPapersSha256 || filtered.fetchSourcesSha256 !== sources) fail();
    const fetchedIds = new Set([...Object.values(checkpoint.arxiv).flatMap(e => e.papers), ...checkpoint.huggingface.papers].map(normalizedId));
    const historicalIds = checkpoint.historicalDedupIds;
    if (!Array.isArray(historicalIds) || historicalIds.some(id => typeof id !== 'string' || !/^\d{4}\.\d{4,5}$/.test(id))
        || new Set(historicalIds).size !== historicalIds.length
        || JSON.stringify(historicalIds) !== JSON.stringify([...historicalIds].sort())) fail();
    const historyFingerprint = stableSha(historicalIds).slice(0, 16);
    if (!/^[a-f0-9]{16}$/.test(checkpoint.sourceConfigFingerprint || '')
        || checkpoint.blogDedupFingerprint !== historyFingerprint
        || checkpoint.candidateFingerprint !== stableSha({ sourceConfigFingerprint: checkpoint.sourceConfigFingerprint,
            blogDedupFingerprint: historyFingerprint, historyFingerprint }).slice(0, 16)) fail();
    for (const record of [raw, filtered]) {
        if (record.candidateFingerprint !== checkpoint.candidateFingerprint
            || record.sourceConfigFingerprint !== checkpoint.sourceConfigFingerprint
            || record.blogDedupFingerprint !== checkpoint.blogDedupFingerprint) fail();
    }
    const historical = new Set(historicalIds);
    const expectedCandidates = [...fetchedIds].filter(id => !historical.has(id)).sort();
    const rawIds = raw.papers.map(normalizedId).sort();
    if (new Set(rawIds).size !== rawIds.length || JSON.stringify(rawIds) !== JSON.stringify(expectedCandidates)
        || !Array.isArray(filtered.papers) || !filtered.papers.every(p => rawIds.includes(normalizedId(p)))) fail();
    const ids = rows => (rows || []).map(normalizedId).sort();
    const expected = papers.map(p => p.arxivId).sort();
    if (JSON.stringify(ids(filtered.papers)) !== JSON.stringify(expected)
        || JSON.stringify(ids(deep.papers)) !== JSON.stringify(expected)) fail();
    const manifestPath = path.join(dataRoot, 'current', `blog-generation-manifest-${date}.json`);
    const manifestBytes = fs.readFileSync(manifestPath); const manifest = JSON.parse(manifestBytes);
    if (manifest.date !== date || manifest.schemaVersion !== 3
        || manifest.inputSourceReference?.sha256 !== hash(records[3].bytes)
        || !manifest.files?.some(f => f.path === indexPath && f.sha256 === indexSha256 && !f.deleted)
        || !papers.every(p => manifest.files.some(f => f.path === p.path && f.sha256 === p.sha256 && !f.deleted))) fail();
    records.push({ filename: manifestPath, bytes: manifestBytes });
    return { until: boundary.until, archiveProofs: records.map(r => ({ file: path.basename(r.filename), sha256: hash(r.bytes) })) };
}
function resolveDailyFetchBoundary(blogRepo, { until, dataRoot = path.resolve(__dirname, '../../data') } = {}) {
    strictInstant(until);
    const git = (...args) => execFileSync('git', ['-C', blogRepo, ...args], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    let head;
    try { head = git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}').toString().trim();
        git('merge-base', '--is-ancestor', head, 'HEAD');
    } catch { throw new Error('缺少可验证的 origin/main 发布基线，或本地 HEAD 不包含该基线'); }
    const paths = git('ls-tree', '-r', '--name-only', head).toString().trim().split('\n');
    const indices = paths.filter(name => /^content\/posts\/\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().reverse();
    let indexPath; let indexBytes;
    for (const name of indices) {
        const bytes = git('show', `${head}:${name}`); const metadata = frontmatter(bytes);
        if (metadata.paper_digest_pipeline_owned === true && metadata.paper_digest_page_type === 'index'
            && metadata.draft === false) { indexPath = name; indexBytes = bytes; break; }
    }
    if (!indexPath) throw new Error('没有合法已提交日更汇总；请先明确初次抓取起始时间，不能自动默认七天');
    const date = indexPath.match(/(\d{4}-\d{2}-\d{2})\.md$/)[1];
    const linked = [...indexBytes.toString().matchAll(/\]\([^\n)]*\/posts\/([^/)]+)\)/g)].map(m => `content/posts/${m[1]}.md`);
    const pagePaths = [...new Set(linked)].filter(name => name.startsWith(`content/posts/${date}-`)).sort();
    const declaredCount = Number(indexBytes.toString().match(/共分析 \*\*(\d+)\*\* 篇论文/)?.[1]);
    if (!pagePaths.length || declaredCount !== pagePaths.length) throw new Error('上一日更汇总与独立页面数量不符');
    const digestDateLimit = new Date(Date.parse(until) + 8 * 3600000).toISOString().slice(0, 10);
    if (!validDate(date) || frontmatter(indexBytes).date !== date || date > digestDateLimit) throw new Error('日更汇总日期无效或晚于抓取结束日期');
    const papers = pagePaths.map(name => {
        const bytes = git('show', `${head}:${name}`); const text = bytes.toString();
        const metadata = frontmatter(bytes);
        const id = normalizedId(metadata.paper_digest_arxiv_id);
        if (!/^\d{4}\.\d{4,5}$/.test(id) || metadata.paper_digest_pipeline_owned !== true || metadata.paper_digest_page_type !== 'paper'
            || metadata.draft !== false || metadata.date !== date) throw new Error(`日更独立页身份不完整：${name}`);
        const sidecars = metadata.paper_digest_sidecars || {};
        const citationPath = `static/data/papers/${date}/${id.replace('.', '-')}/citation.json`;
        const citationBytes = git('show', `${head}:${citationPath}`); const citation = JSON.parse(citationBytes);
        if (normalizedId(citation.arxivId) !== id || sidecars['citation.json']?.sha256 !== hash(citationBytes)) throw new Error(`日更引用元数据不符：${name}`);
        const month = Number(id.slice(2, 4)); if (month < 1 || month > 12) throw new Error('论文编号月份无效');
        return { arxivId: id, path: name, sha256: hash(bytes), citationPath, citationSha256: hash(citationBytes),
            conservativeSubmissionMonthStart: `20${id.slice(0, 2)}-${id.slice(2, 4)}-01T00:00:00.000Z` };
    });
    if (new Set(papers.map(p => p.arxivId)).size !== papers.length) throw new Error('上一日更论文身份重复');
    const previous = verifiedPreviousWindow(dataRoot, date, papers, indexPath, hash(indexBytes));
    const prior = previous?.until ? previous : null;
    const since = prior ? prior.until : papers.map(p => p.conservativeSubmissionMonthStart).sort()[0];
    const body = { contract: CONTRACT, lastDigestDate: date, since, until,
        provenance: { blogHead: head, indexPath, indexSha256: hash(indexBytes), papers,
            boundaryBasis: prior ? 'verified-previous-fetch-until' : 'month-derived-lower-bound',
            ...(prior ? { archiveProofs: prior.archiveProofs } : {}),
            limitation: prior ? '已核验上一已发布批次的完整 v7 窗口与页面关联，使用该窗口结束时间。' : '原批次没有完整提交时间或抓取检查点；按全部已发布编号的最早提交月月首保守重叠，不宣称旧抓取完整。' } };
    const result = { ...body, identitySha256: identity(body) };
    if (previous?.unpublishedCurrentReason) Object.defineProperty(result, 'diagnostics', { value: { unpublishedCurrentReason: previous.unpublishedCurrentReason }, enumerable: false });
    validateDailyFetchBoundary(result); return result;
}
function readCommittedPublishedPaperIds(blogRepo) {
    const git = (...args) => execFileSync('git', ['-C', blogRepo, ...args], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const head = git('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}').toString().trim();
    git('merge-base', '--is-ancestor', head, 'HEAD');
    const ids = new Set(); let skippedLegacyPages = 0;
    for (const name of git('ls-tree', '-r', '--name-only', head).toString().split('\n').filter(p => /^content\/posts\/.*\.md$/.test(p))) {
        const bytes = git('show', `${head}:${name}`);
        const block = bytes.toString().match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
        if (!/^paper_digest_pipeline_owned:\s*true(?:\s*#.*)?$/m.test(block)
            || !/^paper_digest_page_type:\s*(?:paper|"paper"|'paper')(?:\s*#.*)?$/m.test(block)
            || !/^paper_digest_arxiv_id:/m.test(block)) { skippedLegacyPages++; continue; }
        const metadata = frontmatter(bytes);
        if (metadata.paper_digest_pipeline_owned === true && metadata.paper_digest_page_type === 'paper' && metadata.draft === false) {
            const id = normalizedId(metadata.paper_digest_arxiv_id); if (/^\d{4}\.\d{4,5}$/.test(id)) ids.add(id);
        }
    }
    Object.defineProperty(ids, 'skippedLegacyPages', { value: skippedLegacyPages });
    return ids;
}
module.exports = { CONTRACT, resolveDailyFetchBoundary, validateDailyFetchBoundary, readCommittedPublishedPaperIds };

'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const CONTRACT = 'daily-fetch-boundary-v1';
const CONTINUITY_CONTRACT = 'daily-fetch-continuity-v1';
const CATEGORIES = ['eess.AS', 'cs.SD', 'eess.SP', 'cs.CL', 'cs.LG', 'cs.AI', 'cs.MM'];
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
function beijingDate(instant) { return new Date(Date.parse(instant) + 8 * 3600000).toISOString().slice(0, 10); }
function overlapStart(continuity) {
    const starts = [Date.parse(continuity.originalSince), ...continuity.witnesses.arxiv
        .filter(w => w.status === 'expected').map(w => Math.floor(Date.parse(w.published) / 60000) * 60000)];
    if (continuity.witnesses.huggingface.status === 'expected') {
        starts.push(Date.parse(`${continuity.overlapCutoffDate}T00:00:00+08:00`));
    }
    return new Date(Math.min(...starts)).toISOString();
}
function validateContinuity(boundary) {
    const c = boundary.continuity;
    const fail = () => { throw new Error('日更旧获取见证与受控重叠边界不一致'); };
    if (!c || c.contract !== CONTINUITY_CONTRACT || c.required !== true
        || !/^[a-f0-9]{64}$/.test(c.archiveCheckpointSha256 || '')
        || !validDate(c.overlapCutoffDate || '') || c.overlapCutoffDate > boundary.lastDigestDate) fail();
    strictInstant(c.originalSince);
    if (Date.parse(c.originalSince) >= Date.parse(boundary.until)) fail();
    const proofs = boundary.provenance?.archiveProofs;
    const proofNames = ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json',
        'deep-analysis-result.json', `blog-generation-manifest-${boundary.lastDigestDate}.json`];
    if (!Array.isArray(proofs) || proofs.length !== proofNames.length
        || !proofNames.every(name => proofs.filter(p => p.file === name && /^[a-f0-9]{64}$/.test(p.sha256 || '')).length === 1)
        || proofs.find(p => p.file === 'fetch-checkpoint.json').sha256 !== c.archiveCheckpointSha256) fail();
    const arxiv = c.witnesses?.arxiv;
    if (!Array.isArray(arxiv) || arxiv.length !== CATEGORIES.length
        || !CATEGORIES.every(id => arxiv.filter(w => w?.categoryId === id).length === 1)) fail();
    const expected = (w, field) => {
        if (!/^\d{4}\.\d{4,5}$/.test(w.arxivId || '')) fail();
        strictInstant(w[field]);
        if (Date.parse(w[field]) > Date.parse(c.originalSince)) fail();
    };
    for (const w of arxiv) {
        if (w.status === 'expected') expected(w, 'published');
        else if (w.status !== 'not-applicable' || w.reason !== 'no-previous-records'
            || w.arxivId !== undefined || w.published !== undefined) fail();
    }
    const hf = c.witnesses?.huggingface;
    if (hf?.status === 'expected') {
        expected(hf, 'selectedAt');
        if (hf.cutoffDate !== beijingDate(hf.selectedAt) || c.overlapCutoffDate !== hf.cutoffDate) fail();
    } else if (hf?.status !== 'not-applicable'
        || !['no-previous-records', 'no-previous-daily-selection'].includes(hf.reason)
        || hf.arxivId !== undefined || hf.selectedAt !== undefined || hf.cutoffDate !== undefined
        || c.overlapCutoffDate !== boundary.lastDigestDate) fail();
    if (boundary.since !== overlapStart(c)) fail();
}
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
    if (Object.hasOwn(boundary, 'continuity')) validateContinuity(boundary);
    return true;
}
function stableSha(value) {
    const normalize = x => Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x).sort().map(k => [k, normalize(x[k])])) : x;
    return hash(JSON.stringify(normalize(value)));
}
function hasVerifiedFetchContinuity(health, boundary, huggingface = false) {
    if (!Object.hasOwn(boundary || {}, 'continuity')) return true;
    try { validateDailyFetchBoundary(boundary); } catch { return false; }
    if (!huggingface && health?.categoryId !== undefined && health?.id !== undefined
        && health.categoryId !== health.id) return false;
    const witness = huggingface ? boundary.continuity.witnesses.huggingface
        : boundary.continuity.witnesses.arxiv.find(w => w.categoryId === (health?.categoryId ?? health?.id));
    const proof = health?.provider?.continuity;
    const encounters = health?.continuity?.encounters;
    if (!witness || proof?.required !== true || !Array.isArray(proof.matchedIds)
        || !Array.isArray(encounters)) return false;
    if (witness.status === 'not-applicable') return proof.status === 'not-applicable'
        && proof.reason === witness.reason && proof.encounterVerified === false
        && proof.matchedIds.length === 0 && encounters.length === 0
        && proof.expectedId === undefined && proof.witnessPublished === undefined
        && proof.witnessSelectedAt === undefined;
    const field = huggingface ? 'selectedAt' : 'published';
    const proofField = huggingface ? 'witnessSelectedAt' : 'witnessPublished';
    const timestamp = witness[field];
    return proof.status === 'verified' && proof.encounterVerified === true
        && proof.expectedId === witness.arxivId && proof[proofField] === timestamp
        && proof.matchedIds.includes(witness.arxivId)
        && proof.matchedIds.every(id => typeof id === 'string' && id === normalizedId(id)
            && /^\d{4}\.\d{4,5}$/.test(id))
        && new Set(proof.matchedIds).size === proof.matchedIds.length
        && encounters.some(record => record && typeof record === 'object'
            && normalizedId(record) === witness.arxivId
            && typeof record[field] === 'string' && Number.isFinite(Date.parse(record[field]))
            && Date.parse(record[field]) === Date.parse(timestamp));
}
function archivedAnalysisFile(dataRoot, directory, date) {
    const expected = path.join(directory, 'deep-analysis-result.json');
    try {
        const stat = fs.lstatSync(expected);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('上一发布分析证明不是普通文件');
        // An existing target, including one with damaged bytes, is authoritative.
        // Never hide its corruption by selecting a copy from another directory.
        return expected;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const archiveRoot = path.join(dataRoot, 'archive');
    if (directory !== path.join(archiveRoot, date)) return expected;
    const manifestPath = path.join(dataRoot, 'current', `blog-generation-manifest-${date}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const expectedSha = manifest.inputSourceReference?.sha256;
    if (manifest.date !== date || manifest.schemaVersion !== 3 || !/^[a-f0-9]{64}$/.test(expectedSha || '')) {
        throw new Error('上一已发布生成清单不能证明异日归档的分析结果');
    }
    // Earlier archives used the last refresh timestamp rather than batchDate.
    // Only the exact reviewed input bytes from this project's date archives can
    // recover that layout; no files or paid records are moved or merged here.
    const days = fs.readdirSync(archiveRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && validDate(entry.name)).map(entry => entry.name).sort();
    for (const day of days) {
        if (day === date) continue;
        const filename = path.join(archiveRoot, day, 'deep-analysis-result.json');
        let stat;
        try { stat = fs.lstatSync(filename); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const bytes = fs.readFileSync(filename);
        if (hash(bytes) !== expectedSha) continue;
        const payload = JSON.parse(bytes);
        if (payload.batchDate === date) return filename;
    }
    throw new Error('上一已发布分析证明缺失，其他日期归档没有与已审清单 SHA 和批次日期精确对应的普通文件');
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
    const read = name => { const filename = name === 'deep-analysis-result.json'
        ? archivedAnalysisFile(dataRoot, directory, date) : path.join(directory, name);
        return { filename, bytes: fs.readFileSync(filename) }; };
    const records = ['fetch-checkpoint.json', 'raw-candidates.json', 'filtered-papers.json', 'deep-analysis-result.json'].map(read);
    const [checkpoint, raw, filtered, deep] = records.map(r => JSON.parse(r.bytes));
    const fail = () => { throw new Error('上一已发布 v7 抓取窗口的来源或发布证明不完整，拒绝缩短补抓范围'); };
    try { validateDailyFetchBoundary(checkpoint.fetchBoundary); } catch { fail(); }
    const boundary = checkpoint.fetchBoundary;
    const categories = CATEGORIES;
    const covered = (entry, hf = false) => {
        const provider = entry?.health?.provider;
        return entry?.status === 'complete' && entry.health?.ok === true && Array.isArray(entry.papers)
            && entry.papersCount === entry.papers.length && entry.papersSha256 === stableSha(entry.papers)
            && provider?.boundaryIdentity === boundary.identitySha256 && provider.window?.since === boundary.since
            && provider.window?.until === boundary.until && provider.window?.covered === true
            && hasVerifiedFetchContinuity(entry.health, boundary, hf)
            && (!hf || (provider.cutoffDate === (boundary.continuity?.overlapCutoffDate || boundary.lastDigestDate) && provider.dailyCovered === true
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
    return { until: boundary.until, checkpoint,
        archiveProofs: records.map(r => ({ file: path.basename(r.filename), sha256: hash(r.bytes) })) };
}
function deriveContinuity(prior, lastDigestDate) {
    const cp = prior.checkpoint;
    const latest = (rows, field) => rows.map(p => {
        const arxivId = normalizedId(p), timestamp = p[field];
        if (!/^\d{4}\.\d{4,5}$/.test(arxivId) || typeof timestamp !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(timestamp)
            || !validDate(timestamp.slice(0, 10))
            || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) > Date.parse(prior.until)) {
            throw new Error(`旧抓取 ${field} 不能作为已获取论文见证`);
        }
        return { arxivId, timestamp: new Date(timestamp).toISOString() };
    }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.arxivId.localeCompare(b.arxivId))[0];
    const arxiv = CATEGORIES.map(categoryId => {
        const rows = cp.arxiv[categoryId].papers;
        if (!rows.length) return { categoryId, status: 'not-applicable', reason: 'no-previous-records' };
        const witness = latest(rows, 'published');
        return { categoryId, status: 'expected', arxivId: witness.arxivId, published: witness.timestamp };
    });
    const hfRows = cp.huggingface.papers;
    const selected = hfRows.filter(p => p.hfSelectedAt !== undefined && p.hfSelectedAt !== '');
    let huggingface;
    if (!selected.length) huggingface = { status: 'not-applicable',
        reason: hfRows.length ? 'no-previous-daily-selection' : 'no-previous-records' };
    else {
        const witness = latest(selected, 'hfSelectedAt');
        huggingface = { status: 'expected', arxivId: witness.arxivId, selectedAt: witness.timestamp,
            cutoffDate: beijingDate(witness.timestamp) };
    }
    return { contract: CONTINUITY_CONTRACT, required: true, originalSince: prior.until,
        archiveCheckpointSha256: prior.archiveProofs.find(p => p.file === 'fetch-checkpoint.json').sha256,
        witnesses: { arxiv, huggingface }, overlapCutoffDate: huggingface.cutoffDate || lastDigestDate };
}
function validateDailyFetchContinuityCheckpoint(boundary, checkpointBytes) {
    validateDailyFetchBoundary(boundary);
    if (!boundary.continuity) return true;
    if (!Buffer.isBuffer(checkpointBytes) || hash(checkpointBytes) !== boundary.continuity.archiveCheckpointSha256) {
        throw new Error('旧获取见证所绑定的抓取检查点字节 SHA 不一致');
    }
    const checkpoint = JSON.parse(checkpointBytes.toString('utf8'));
    if (checkpoint.batchDate !== boundary.lastDigestDate
        || checkpoint.sourceContractVersion !== 7 || checkpoint.fetchBoundary?.until !== boundary.continuity.originalSince) {
        throw new Error('旧获取见证绑定了其他批次或结束时间');
    }
    const derived = deriveContinuity({ until: boundary.continuity.originalSince, checkpoint,
        archiveProofs: boundary.provenance.archiveProofs }, boundary.lastDigestDate);
    if (stableSha(derived) !== stableSha(boundary.continuity)) {
        throw new Error('旧获取见证与原抓取检查点中的最新论文不一致');
    }
    return true;
}
function resolveDailyFetchBoundary(blogRepo, { until, dataRoot = path.resolve(__dirname, '../../data'),
    requirePreviouslyFetched = false } = {}) {
    if (typeof requirePreviouslyFetched !== 'boolean') throw new TypeError('requirePreviouslyFetched 必须是布尔值');
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
    if (requirePreviouslyFetched && !prior) throw new Error('要求旧获取见证时必须有完整已发布 v7 抓取证明，不能从月首推测旧获取状态');
    const continuity = requirePreviouslyFetched ? deriveContinuity(prior, date) : null;
    const since = continuity ? overlapStart(continuity) : prior ? prior.until : papers.map(p => p.conservativeSubmissionMonthStart).sort()[0];
    const body = { contract: CONTRACT, lastDigestDate: date, since, until,
        ...(continuity ? { continuity } : {}),
        provenance: { blogHead: head, indexPath, indexSha256: hash(indexBytes), papers,
            boundaryBasis: prior ? 'verified-previous-fetch-until' : 'month-derived-lower-bound',
            ...(prior ? { archiveProofs: prior.archiveProofs } : {}),
            limitation: continuity ? '已核验上一已发布批次的完整 v7 窗口与页面关联；原精确起点保留为 continuity.originalSince，实际起点向前覆盖旧获取见证。' : prior ? '已核验上一已发布批次的完整 v7 窗口与页面关联，使用该窗口结束时间。' : '原批次没有完整提交时间或抓取检查点；按全部已发布编号的最早提交月月首保守重叠，不宣称旧抓取完整。' } };
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
module.exports = { CONTRACT, CONTINUITY_CONTRACT, resolveDailyFetchBoundary, validateDailyFetchBoundary,
    validateDailyFetchContinuityCheckpoint, hasVerifiedFetchContinuity, readCommittedPublishedPaperIds };

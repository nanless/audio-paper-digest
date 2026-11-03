'use strict';

// This grants only a wider fetch overlap. The lost latest input remains lost;
// no analysis, Reader, review, publication or model authority is reconstructed.
const { sourceBoundGeneration, strictReceipt, matchesSnapshotReceipt } = require('./blog-record-format');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readRegular, writeExact, strictJson } = require('./publication-file-primitives');
const CONTRACT = 'daily-fetch-witness-recovery';
const REFERENCE = 'daily-fetch-witness-recovery-reference';
const codec = require('./protocol-codec');
const { BOUNDARY, RECOVERY_CONTINUITY: CONTINUITY, readHeader, isRecoveryContinuity,
    hasBoundedFetchSource } = require('./daily-fetch-format');
const ACTIVATION = 'daily-fetch-witness-recovery-activation';
const SHA = /^[a-f0-9]{64}$/, OID = /^[a-f0-9]{40}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stable = value => require('./daily-fetch-boundary').stableSha(value);
const equal = (a, b) => stable(a) === stable(b);
const fail = message => { throw new Error(`旧获取见证显式恢复拒绝：${message}`); };
function dateValid(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
function dateOf(s) { return new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 10); }
function keys(value, names) { return value && typeof value === 'object' && !Array.isArray(value)
    && equal(Object.keys(value).sort(), [...names].sort()); }
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
function json(bytes) { return strictJson(bytes, '旧获取见证恢复材料'); }
function read(filename) { const r = readRegular(filename); return { ...r, value: json(r.bytes) }; }
function encoded(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function relativeSafe(s) { return typeof s === 'string' && !path.isAbsolute(s)
    && !/[\x00-\x1f\x7f]/.test(s) && s.split('/').every(p => p && p !== '.' && p !== '..' && !p.includes('\\')); }
function privateFile(filename, dataRoot) {
    const root = rootFor(dataRoot), relative = path.relative(root, filename);
    if (!relativeSafe(relative)) fail('私有材料越出恢复目录');
    let cursor = root;
    for (const part of ['', ...relative.split('/')]) {
        if (part) cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor), file = cursor === filename;
        if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
            || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
            fail('恢复材料必须保持当前用户独有的普通私有文件和目录');
        }
    }
}
function rootFor(dataRoot) { return path.join(dataRoot, 'runtime', 'daily-fetch-witness-recoveries'); }
function materialLayout(date) { return {
    latestManifest: 'latest/manifest.json', latestReceipt: 'latest/receipt.json', canonical: 'latest/canonical.json',
    sourceCheckpoint: `source/archive/${date}/fetch-checkpoint.json`,
    sourceRaw: `source/archive/${date}/raw-candidates.json`,
    sourceFiltered: `source/archive/${date}/filtered-papers.json`,
    sourceDeep: `source/archive/${date}/deep-analysis-result.json`,
    sourceManifest: `source/current/blog-generation-manifest-${date}.json`, sourceReceipt: 'source/receipt.json'
}; }
function canonicalId(p) { return String(p?.arxivId || p?.paper_id || p?.id || '').replace(/v\d+$/, '').toLowerCase(); }
function portable(v) {
    if (v === null) return ['null'];
    if (typeof v === 'boolean') return ['boolean', v];
    if (typeof v === 'string') return ['string', v];
    if (typeof v === 'number' && Number.isFinite(v)) {
        const b = Buffer.alloc(8); b.writeDoubleBE(v); return ['number-f64', b.toString('hex')];
    }
    if (Array.isArray(v)) return ['array', v.map(portable)];
    if (v && typeof v === 'object') return ['object', Object.keys(v).sort().map(k => [k, portable(v[k])])];
    fail('论文快照含非 JSON 值');
}
function recordFiles(value) {
    if (!Array.isArray(value) || !value.length) fail('发布文件集合缺失');
    const out = new Map();
    for (const r of value) {
        if (!r || !relativeSafe(r.path) || out.has(r.path) || typeof r.deleted !== 'boolean'
            || (r.deleted ? r.sha256 !== null : !SHA.test(r.sha256 || ''))) fail('发布文件路径、SHA或删除标记非法');
        out.set(r.path, { path: r.path, deleted: r.deleted, sha256: r.sha256 });
    }
    return out;
}
function blob(repo, commit, file) {
    try { return git(repo, 'show', `${commit}:${file}`); }
    catch (e) { if (e.status === 128) return null; throw e; }
}
function blobs(repo, commit, names) {
    const output = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
        input: names.map(n => `${commit}:${n}\n`).join(''), maxBuffer: 512 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'] });
    let offset = 0; const result = new Map();
    for (const name of names) {
        const end = output.indexOf(10, offset);
        if (end < 0) fail('Git 批量对象输出截断');
        const header = output.subarray(offset, end).toString(); offset = end + 1;
        if (header.endsWith(' missing')) { result.set(name, null); continue; }
        const match = /^[a-f0-9]{40} blob (\d+)$/.exec(header);
        if (!match || !Number.isSafeInteger(Number(match[1]))) fail('Git 批量对象身份非法');
        const size = Number(match[1]), bytes = output.subarray(offset, offset + size); offset += size;
        if (bytes.length !== size || output[offset++] !== 10) fail('Git 批量对象字节截断');
        result.set(name, bytes);
    }
    if (offset !== output.length) fail('Git 批量对象输出有额外成员');
    return result;
}
function remoteIdentity(repo, name) {
    const pushUrl = git(repo, 'remote', 'get-url', '--push', name).toString().trim();
    return stable({ remote: name, pushUrl });
}
function verifyPublication(repo, observed, manifestRecord, receiptRecord) {
    const m = manifestRecord.value, r = receiptRecord.value, date = observed.date;
    if (!sourceBoundGeneration(m) || !strictReceipt(r) || [m, r].some(v => v.date !== date || v.publicationScope)
        || r.strictReview !== true || r.hugoGate !== 'hugo' || r.baseHead !== m.baseHead
        || r.generationManifestSha256 !== manifestRecord.sha256 || !SHA.test(r.reviewProtocolFingerprint || '')
        || !matchesSnapshotReceipt(m, r)
        || !OID.test(r.publicationCommit || '') || r.remoteVerifiedOid !== r.publicationCommit
        || r.remoteName !== 'origin' || !r.remoteVerifiedAt
        || r.remoteIdentitySha256 !== remoteIdentity(repo, 'origin')) fail('原生成/审查/远端发布身份不一致');
    const bindings = { generationInputFingerprint: 'inputFingerprint', publishedPapersFingerprint: 'publishedPapersFingerprint',
        generationInputSourceReference: 'inputSourceReference', publicationMode: 'publicationMode',
        llmApiProductionFingerprint: 'llmApiProductionFingerprint', manualV6ProductionFingerprint: 'manualV6ProductionFingerprint' };
    for (const [rk, mk] of Object.entries(bindings)) {
        if (!equal(r[rk] ?? null, m[mk] ?? null)) fail('原审查凭证与生成输入绑定不符');
    }
    if (!Array.isArray(m.publishedPapers) || !m.publishedPapers.length
        || hash(JSON.stringify(portable(m.publishedPapers))) !== m.publishedPapersFingerprint
        || !SHA.test(m.inputFingerprint || '')) fail('原论文快照完整性不符');
    const files = recordFiles(m.files), reviewed = recordFiles(r.files);
    if (!equal([...files].sort(), [...reviewed].sort())) fail('原生成/审查完整文件集合不同');
    const parents = git(repo, 'rev-list', '--parents', '-n', '1', r.publicationCommit).toString().trim().split(/\s+/);
    if (parents.length !== 2 || parents[1] !== r.baseHead) fail('原发布不是原审查基线的单父提交');
    git(repo, 'merge-base', '--is-ancestor', r.publicationCommit, observed.head);
    const expectedDelta = [];
    const publishedFiles = blobs(repo, r.publicationCommit, [...files.keys()]);
    const baseFiles = blobs(repo, r.baseHead, [...files.keys()]);
    for (const [name, f] of files) {
        const published = publishedFiles.get(name), before = baseFiles.get(name);
        if (f.deleted ? published !== null : published === null || hash(published) !== f.sha256) fail('原发布提交文件与凭证不符');
        if (f.deleted ? before !== null : before === null || hash(before) !== f.sha256) expectedDelta.push(name);
    }
    const actualDelta = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '-z', '-r', r.publicationCommit)
        .toString().split('\0').filter(Boolean).sort();
    if (!equal(actualDelta, expectedDelta.sort())) fail('原发布完整 Git 差异与凭证不符');
    for (const p of [{ path: observed.indexPath, sha256: observed.indexSha256 },
        ...observed.papers.flatMap(p => [{ path: p.path, sha256: p.sha256 }, { path: p.citationPath, sha256: p.citationSha256 }])]) {
        if (files.get(p.path)?.deleted !== false || files.get(p.path)?.sha256 !== p.sha256) fail('原凭证未覆盖实际远端页面及引用');
    }
    const ids = m.publishedPapers.map(canonicalId).sort();
    if (!equal(ids, observed.papers.map(p => p.arxivId).sort()) || new Set(ids).size !== ids.length) fail('原论文快照与远端完整成员不同');
    return m;
}
function verifyLostInput(manifest, canonicalRecord, dataRoot, latestDate) {
    const ref = manifest.inputSourceReference;
    if (!keys(ref, ['contract', 'version', 'path', 'sha256', 'bytes'])
        || ref.contract !== 'generation-input-source-reference-v1' || ref.version !== 1
        || ref.path !== path.join(dataRoot, 'current', 'deep-analysis-result.json')
        || !SHA.test(ref.sha256 || '') || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1
        || (ref.sha256 === canonicalRecord.sha256 && ref.bytes === canonicalRecord.bytes.length)) fail('不属于原完整输入字节失配');
    const d = canonicalRecord.value;
    if (d.batchDate !== latestDate || !Array.isArray(d.papers) || d.papers.length !== manifest.publishedPapers.length) fail('当前正式稿批次或完整成员不同');
    const old = new Map(manifest.publishedPapers.map(p => [canonicalId(p), p]));
    if (new Set(d.papers.map(canonicalId)).size !== d.papers.length) fail('当前正式稿成员重复');
    for (const p of d.papers) {
        const q = old.get(canonicalId(p)); if (!q) fail('当前正式稿成员不是原完整集合');
        const left = { ...p }, right = { ...q }; delete left.parsed; delete right.parsed;
        delete right.normalizedArxivId;
        if (!equal(left, right)) fail('当前正式稿除派生 parsed 之外发生变化');
    }
}
function readManifest(reference) {
    const referenceHeader = readHeader(reference, REFERENCE);
    if (!keys(reference, [...Object.keys(referenceHeader), 'manifestPath', 'manifestSha256', 'manifestBytes'])
        || !path.isAbsolute(reference.manifestPath || '') || /[\x00-\x1f\x7f]/.test(reference.manifestPath || '') || !SHA.test(reference.manifestSha256 || '')
        || !Number.isSafeInteger(reference.manifestBytes) || reference.manifestBytes < 1) fail('恢复引用非法');
    const original = read(reference.manifestPath), m = original.value;
    if (original.sha256 !== reference.manifestSha256 || original.bytes.length !== reference.manifestBytes) fail('恢复清单原字节变化');
    const manifestHeader = readHeader(m, CONTRACT);
    if (!keys(m, [...Object.keys(manifestHeader), 'runId', 'date', 'sourceCheckpointDate', 'latestDate', 'preparedAt',
        'dataRoot', 'blogRepo', 'blogHead', 'latest', 'source', 'records', 'originalInputReplay'])
        || Boolean(manifestHeader.schemaFingerprint) !== Boolean(referenceHeader.schemaFingerprint)
        || !/^[a-f0-9-]{36}$/.test(m.runId || '')
        || !dateValid(m.date) || !dateValid(m.latestDate) || !dateValid(m.sourceCheckpointDate)
        || !(m.sourceCheckpointDate < m.latestDate && m.latestDate < m.date)
        || !path.isAbsolute(m.dataRoot || '') || !path.isAbsolute(m.blogRepo || '')
        || /[\x00-\x1f\x7f]/.test(m.dataRoot + m.blogRepo) || !OID.test(m.blogHead || '')
        || reference.manifestPath !== path.join(rootFor(m.dataRoot), m.runId, 'manifest.json')
        || m.originalInputReplay !== 'unavailable-original-bytes-not-restored') fail('恢复清单身份、日期或范围非法');
    privateFile(reference.manifestPath, m.dataRoot);
    const layout = materialLayout(m.sourceCheckpointDate), records = {};
    const originalPaths = { latestManifest: path.join(m.dataRoot, 'current', `blog-generation-manifest-${m.latestDate}.json`),
        latestReceipt: path.join(m.dataRoot, 'current', `blog-review-receipt-${m.latestDate}.json`),
        canonical: path.join(m.dataRoot, 'current', 'deep-analysis-result.json'),
        sourceCheckpoint: path.join(m.dataRoot, 'archive', m.sourceCheckpointDate, 'fetch-checkpoint.json'),
        sourceRaw: path.join(m.dataRoot, 'archive', m.sourceCheckpointDate, 'raw-candidates.json'),
        sourceFiltered: path.join(m.dataRoot, 'archive', m.sourceCheckpointDate, 'filtered-papers.json'),
        sourceDeep: path.join(m.dataRoot, 'archive', m.sourceCheckpointDate, 'deep-analysis-result.json'),
        sourceManifest: path.join(m.dataRoot, 'current', `blog-generation-manifest-${m.sourceCheckpointDate}.json`),
        sourceReceipt: path.join(m.dataRoot, 'current', `blog-review-receipt-${m.sourceCheckpointDate}.json`) };
    if (!keys(m.records, Object.keys(layout))) fail('恢复材料缺少或增加成员');
    for (const [key, relative] of Object.entries(layout)) {
        const r = m.records[key];
        if (!keys(r, ['file', 'originalPath', 'sha256', 'bytes']) || r.file !== relative || r.originalPath !== originalPaths[key]
            || !SHA.test(r.sha256 || '') || !Number.isSafeInteger(r.bytes) || r.bytes < 1) fail('恢复材料记录非法');
        const record = read(path.join(path.dirname(reference.manifestPath), relative));
        privateFile(path.join(path.dirname(reference.manifestPath), relative), m.dataRoot);
        if (record.sha256 !== r.sha256 || record.bytes.length !== r.bytes) fail('封存恢复材料字节不符');
        records[key] = record;
    }
    return { reference, manifest: m, records, directory: path.dirname(reference.manifestPath) };
}
function replay(reference) {
    const state = readManifest(reference), { manifest: m, records: r, directory } = state;
    const boundary = require('./daily-fetch-boundary');
    const latest = boundary.readPublishedDigest(m.blogRepo, m.latestDate, m.blogHead);
    const source = boundary.readPublishedDigest(m.blogRepo, m.sourceCheckpointDate, m.blogHead);
    if (!equal(latest, m.latest) || !equal(source, m.source)) fail('封存发布页面观察与原 Git 对象不符');
    verifyPublication(m.blogRepo, latest, r.latestManifest, r.latestReceipt);
    verifyPublication(m.blogRepo, source, r.sourceManifest, r.sourceReceipt);
    verifyLostInput(r.latestManifest.value, r.canonical, m.dataRoot, m.latestDate);
    const prior = boundary.verifiedPreviousWindow(path.join(directory, 'source'), m.sourceCheckpointDate,
        source.papers, source.indexPath, source.indexSha256);
    if (!prior?.until) fail('封存较早窗口未通过原五文件资格');
    return { ...state, prior, checkpointBytes: r.sourceCheckpoint.bytes };
}
function referenceFor(filename) {
    const r = read(filename), manifestHeader = readHeader(r.value, CONTRACT);
    const referenceHeader = manifestHeader.schemaFingerprint ? codec.recordHeader(REFERENCE, REFERENCE)
        : codec.historicalHeader(REFERENCE, 'original-sealed-recovery-reference', null);
    return { ...referenceHeader, manifestPath: filename, manifestSha256: r.sha256, manifestBytes: r.bytes.length };
}
function buildContinuity(state, header = codec.recordHeader(CONTINUITY, CONTINUITY)) {
    const { manifest: m, prior, reference } = state;
    return { ...require('./daily-fetch-boundary').deriveContinuity(prior, m.sourceCheckpointDate, header),
        sourceCheckpointDate: m.sourceCheckpointDate, recovery: reference };
}
function verifyBoundary(boundary) {
    const boundaryHeader = readHeader(boundary, BOUNDARY);
    if (!keys(boundary, [...Object.keys(boundaryHeader), 'lastDigestDate', 'since', 'until', 'continuity', 'provenance', 'identitySha256'])
        || !SHA.test(boundary.identitySha256 || '')) fail('外层生产边界身份非法');
    const { identitySha256, ...body } = boundary;
    const instant = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)
        && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z', 'Z') === v.replace('.000Z', 'Z');
    if (stable(body) !== identitySha256 || !instant(boundary.since) || !instant(boundary.until)
        || Date.parse(boundary.since) >= Date.parse(boundary.until)) fail('外层生产边界字节身份或时间非法');
    const c = boundary?.continuity;
    const continuityHeader = readHeader(c, CONTINUITY);
    if (!keys(c, [...Object.keys(continuityHeader), 'required', 'originalSince', 'archiveCheckpointSha256', 'witnesses', 'overlapCutoffDate',
        'sourceCheckpointDate', 'recovery']) || Boolean(continuityHeader.schemaFingerprint) !== Boolean(boundaryHeader.schemaFingerprint)) fail('独立连续性合同非法');
    const state = replay(c.recovery), m = state.manifest;
    if (boundary.lastDigestDate !== m.latestDate || dateOf(boundary.until) !== m.date
        || c.sourceCheckpointDate !== m.sourceCheckpointDate || !equal(c, buildContinuity(state, continuityHeader))
        || boundary.since !== require('./daily-fetch-boundary').overlapStart(c)
        || !equal(boundary.provenance, { blogHead: m.blogHead, indexPath: m.latest.indexPath,
            indexSha256: m.latest.indexSha256, papers: m.latest.papers,
            boundaryBasis: 'explicit-earlier-verified-fetch-overlap', recovery: c.recovery,
            archiveProofs: state.prior.archiveProofs,
            limitation: '上一已发布批次原输入字节已失配；不恢复原输入资格。仅按独立封存的较早完整已发布窗口扩大补抓，并实际核对旧获取见证。' })) {
        fail('恢复证据未绑定本次生产边界、真实来源日期或发布基线');
    }
    return state;
}
function resolveBoundary({ blogRepo, dataRoot, until, manifestPath, latest, replayBoundary = null }) {
    const reference = referenceFor(manifestPath), state = replay(reference), m = state.manifest;
    if (path.resolve(blogRepo) !== m.blogRepo || path.resolve(dataRoot) !== m.dataRoot || !equal(latest, m.latest)
        || dateOf(until) !== m.date) fail('恢复清单不属于当前实际远端、目录或目标日期');
    const header = replayBoundary ? readHeader(replayBoundary, BOUNDARY) : codec.recordHeader(BOUNDARY, BOUNDARY);
    const c = buildContinuity(state, replayBoundary?.continuity ? readHeader(replayBoundary.continuity, CONTINUITY) : undefined);
    const body = { ...header,
        lastDigestDate: m.latestDate, since: require('./daily-fetch-boundary').overlapStart(c), until, continuity: c,
        provenance: { blogHead: m.blogHead, indexPath: m.latest.indexPath, indexSha256: m.latest.indexSha256,
            papers: m.latest.papers, boundaryBasis: 'explicit-earlier-verified-fetch-overlap', recovery: reference,
            archiveProofs: state.prior.archiveProofs,
            limitation: '上一已发布批次原输入字节已失配；不恢复原输入资格。仅按独立封存的较早完整已发布窗口扩大补抓，并实际核对旧获取见证。' } };
    const result = { ...body, identitySha256: stable(body) };
    require('./daily-fetch-boundary').validateDailyFetchBoundary(result); return result;
}
function activationPath(state, boundary) { return path.join(state.directory, 'activations', `${boundary.identitySha256}.json`); }
function activationValue(state, boundary) {
    const header = readHeader(boundary, BOUNDARY).schemaFingerprint
        ? codec.recordHeader(ACTIVATION, ACTIVATION) : codec.historicalHeader(ACTIVATION, 'original-verified-recovery-activation', null);
    return { ...header, recoverySha256: state.reference.manifestSha256, boundarySha256: boundary.identitySha256, date: state.manifest.date };
}
function verifyActivation(boundary) {
    const state = verifyBoundary(boundary), expected = activationValue(state, boundary);
    privateFile(activationPath(state, boundary), state.manifest.dataRoot);
    if (!equal(read(activationPath(state, boundary)).value, expected)) fail('生产边界尚未按原材料 CAS 激活');
    return state;
}
function activateBoundary(boundary, { blogRepo, dataRoot } = {}) {
    if (!isRecoveryContinuity(boundary?.continuity)) return true;
    const state = verifyBoundary(boundary), m = state.manifest;
    if (path.resolve(blogRepo || m.blogRepo) !== m.blogRepo || path.resolve(dataRoot || m.dataRoot) !== m.dataRoot) fail('激活目录漂移');
    if (git(m.blogRepo, 'rev-parse', 'refs/remotes/origin/main').toString().trim() !== m.blogHead) fail('登记后的实际远端基线变化');
    const target = activationPath(state, boundary), expected = activationValue(state, boundary);
    if (!expected.schemaFingerprint && !fs.existsSync(target)) fail('原格式边界必须保留既有激活记录，不能补签');
    if (!fs.existsSync(target) && fs.existsSync(path.join(m.dataRoot, 'archive', m.latestDate, 'fetch-checkpoint.json'))) {
        fail('首次激活前最新发布归档已经出现，不能以较早窗口掩盖');
    }
    if (fs.existsSync(target)) {
        privateFile(target, m.dataRoot);
        if (!equal(read(target).value, expected)) fail('恢复激活原记录变化');
        const cp = path.join(m.dataRoot, 'current', 'fetch-checkpoint.json');
        if (fs.existsSync(cp)) {
            const value = read(cp).value;
            if (value.batchDate === m.date && hasBoundedFetchSource(value)
                && equal(value.fetchBoundary, boundary)) return true;
        }
        const current = path.join(m.dataRoot, 'current', 'deep-analysis-result.json');
        if (!fs.existsSync(current)) {
            const archived = read(path.join(m.dataRoot, 'archive', m.latestDate, 'deep-analysis-result.json'));
            if (archived.sha256 === m.records.canonical.sha256) return true;
        }
    }
    for (const r of Object.values(m.records)) {
        const observed = read(r.originalPath);
        if (observed.sha256 !== r.sha256 || observed.bytes.length !== r.bytes) fail('启动归档前原登记材料 CAS 已变化');
    }
    writeExact(target, encoded(expected)); privateFile(target, m.dataRoot); return true;
}
async function prepare({ date, sourceCheckpointDate, blogRepo, dataRoot }) {
    if (!dateValid(date) || !dateValid(sourceCheckpointDate)) fail('准备日期非法');
    blogRepo = fs.realpathSync(blogRepo); dataRoot = fs.realpathSync(dataRoot);
    const boundary = require('./daily-fetch-boundary');
    // Normal resolution without requirePreviouslyFetched observes the latest committed publication,
    // but its current-input diagnostic cannot authorize any fetch in this mode.
    const ordinary = boundary.resolveDailyFetchBoundary(blogRepo, { dataRoot,
        until: new Date(`${date}T12:00:00+08:00`).toISOString() });
    const latestDate = ordinary.lastDigestDate;
    if (!(sourceCheckpointDate < latestDate && latestDate < date)) fail('来源日期必须早于最新发布，最新发布必须早于目标日');
    if (fs.existsSync(path.join(dataRoot, 'archive', latestDate, 'fetch-checkpoint.json'))) fail('最新发布已有归档；不能用较早窗口掩盖其损坏');
    const head = ordinary.provenance.blogHead;
    const latest = boundary.readPublishedDigest(blogRepo, latestDate, head);
    const source = boundary.readPublishedDigest(blogRepo, sourceCheckpointDate, head);
    const current = path.join(dataRoot, 'current'), archive = path.join(dataRoot, 'archive', sourceCheckpointDate);
    const originals = { latestManifest: path.join(current, `blog-generation-manifest-${latestDate}.json`),
        latestReceipt: path.join(current, `blog-review-receipt-${latestDate}.json`), canonical: path.join(current, 'deep-analysis-result.json'),
        sourceCheckpoint: path.join(archive, 'fetch-checkpoint.json'), sourceRaw: path.join(archive, 'raw-candidates.json'),
        sourceFiltered: path.join(archive, 'filtered-papers.json'), sourceDeep: path.join(archive, 'deep-analysis-result.json'),
        sourceManifest: path.join(current, `blog-generation-manifest-${sourceCheckpointDate}.json`),
        sourceReceipt: path.join(current, `blog-review-receipt-${sourceCheckpointDate}.json`) };
    const loaded = Object.fromEntries(Object.entries(originals).map(([k, file]) => [k, read(file)]));
    verifyPublication(blogRepo, latest, loaded.latestManifest, loaded.latestReceipt);
    verifyPublication(blogRepo, source, loaded.sourceManifest, loaded.sourceReceipt);
    verifyLostInput(loaded.latestManifest.value, loaded.canonical, dataRoot, latestDate);
    const prior = boundary.verifiedPreviousWindow(dataRoot, sourceCheckpointDate, source.papers, source.indexPath, source.indexSha256);
    if (!prior?.until) fail('较早已发布窗口没有完整原五文件资格');
    const runId = crypto.randomUUID(), directory = path.join(rootFor(dataRoot), runId), records = {};
    const layout = materialLayout(sourceCheckpointDate);
    for (const [k, file] of Object.entries(layout)) {
        writeExact(path.join(directory, file), loaded[k].bytes);
        records[k] = { file, originalPath: originals[k], sha256: loaded[k].sha256, bytes: loaded[k].bytes.length };
    }
    for (const [k, file] of Object.entries(originals)) {
        const now = read(file); if (now.sha256 !== loaded[k].sha256 || now.bytes.length !== loaded[k].bytes.length) fail('封存期间原材料变化');
    }
    if (git(blogRepo, 'rev-parse', 'refs/remotes/origin/main').toString().trim() !== head) fail('封存期间远端引用变化');
    const manifest = { ...codec.recordHeader(CONTRACT, CONTRACT), runId, date, sourceCheckpointDate, latestDate,
        preparedAt: new Date().toISOString(), dataRoot, blogRepo, blogHead: head, latest, source, records,
        originalInputReplay: 'unavailable-original-bytes-not-restored' };
    const manifestPath = path.join(directory, 'manifest.json'); writeExact(manifestPath, encoded(manifest));
    const reference = referenceFor(manifestPath); replay(reference);
    return { manifestPath, reference, date, latestDate, sourceCheckpointDate, originalInputReplay: manifest.originalInputReplay };
}
module.exports = { CONTRACT, CONTINUITY, prepare, resolveBoundary, verifyBoundary, verifyActivation, activateBoundary };

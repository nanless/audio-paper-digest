'use strict';
if (require.main === module) require('../env-loader.js').requireExternalRuntime('fresh-rewrite-publication');

// 本模块不生成正文、不调用模型，也不改博客。旧的生成字节只是恢复用的备份，不是
// 写作输入。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Config = require('../config.js');
const { writeImmutableFile } = require('./immutable-file.js');
const { withFileLockSync, isSuccessfulAnalysisRecord, getPaperAnalysisLockPath } = require('../analysis-engine.js');
const { normalizedId, getBeijingISOString } = require('../utils.js');

const BASELINE_CONTRACT = 'fresh-rewrite-baseline-v1';
const PROMOTION_CONTRACT = 'fresh-rewrite-promotion-v1';
const SOURCE_CONTRACT = 'fresh-source-analysis-v1';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => hash(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'undefined');
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const idOf = paper => normalizedId(paper);

function checkedDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('fresh rewrite 日期不合法：必须是真实的 YYYY-MM-DD');
    return value;
}

function checkedIds(values) {
    if (!Array.isArray(values) || !values.length) throw new Error('缺少 fresh rewrite 的论文 ID 列表');
    const ids = values.map(value => idOf({ arxivId: value }));
    if (ids.some((id, index) => !/^\d{4}\.\d{4,5}$/.test(id || '') || values[index] !== id)
        || new Set(ids).size !== ids.length) throw new Error('fresh rewrite 的论文 ID 必须是规范且不重复的 arXiv ID');
    return ids.sort();
}

function safeDirectory(directory, create = false) {
    const absolute = path.resolve(directory);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { if (create) fs.mkdirSync(current, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
    }
    return absolute;
}

function under(root, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
        || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
        throw new Error('Unsafe relative path or traversal');
    }
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('解析后的路径超出了允许的根目录范围');
    return target;
}

function readBytes(filename, { allowPendingLink = false } = {}) {
    safeDirectory(path.dirname(filename));
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.nlink !== 1 && !(allowPendingLink && stat.nlink === 2))
            || stat.size > 256 * 1024 * 1024) throw new Error('Unsafe or oversized backup input');
        const raw = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (raw.length !== stat.size || [after, named].some(item =>
            !item.isFile() || item.dev !== stat.dev || item.ino !== stat.ino || item.nlink !== stat.nlink
            || item.size !== stat.size || item.mtimeMs !== stat.mtimeMs || item.ctimeMs !== stat.ctimeMs)) {
            throw new Error(`读取期间基线文件发生变化：${filename}`);
        }
        return raw;
    } finally { fs.closeSync(fd); }
}

function readJson(filename) { return JSON.parse(readBytes(filename).toString('utf8')); }

function immutableWrite(filename, bytes) {
    safeDirectory(path.dirname(filename), true);
    const existing = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (existing && (existing.mode & 0o777) !== 0o600) {
        throw new Error(`不可变基线文件权限必须为 0600：${filename}`);
    }
    writeImmutableFile(filename, bytes, (message, details = {}) => {
        throw Object.assign(new Error(`不可变基线文件写入失败：${message}：${filename}`), details);
    });
}

function replacePrivate(filename, raw) {
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, filename); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function context(options) {
    const rootDir = safeDirectory(options.rootDir || Config.FILES.freshRewriteRunsDir);
    const runDir = safeDirectory(options.runDir);
    if (path.dirname(runDir) !== rootDir) throw new Error('Fresh rewrite run must be a direct child of the configured root');
    const canonicalPath = path.resolve(options.canonicalPath || Config.FILES.deepAnalysisResult);
    const currentDir = safeDirectory(options.currentDir || path.dirname(canonicalPath));
    if (path.dirname(canonicalPath) !== currentDir) throw new Error('正式分析结果路径不在当前批次目录下');
    return { rootDir, runDir, canonicalPath, currentDir,
        blogRepo: safeDirectory(options.blogRepo || Config.PUBLISH_CONFIG.blogRepo),
        date: checkedDate(options.date || options.run?.date),
        paperIds: checkedIds(options.paperIds || options.run?.paperIds) };
}

function gitState(blogRepo) {
    const git = args => execFileSync('git', ['-C', blogRepo, ...args], { encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024, timeout: 30000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }).trim();
    const state = { head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']),
        clean: git(['status', '--porcelain=v1', '--untracked-files=all']) === '' };
    if (!state.clean || state.branch !== 'main') throw new Error('Blog must be clean on main; dirty changes are never backed over');
    return state;
}

function getSavedAnalysisPapers(payload) {
    if (!payload || Array.isArray(payload) || !Array.isArray(payload.papers)
        || !Number.isSafeInteger(payload.generation) || payload.generation < 0) throw new Error('正式分析结果缺少 papers 数组，或 generation 不是非负安全整数');
    const ids = payload.papers.map(idOf);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('正式分析结果里的论文 ID 有非法值或重复项');
    return payload.papers;
}

function paperDate(paper, fallback) { return paper.fetchBatchDate || paper.batchDate || String(paper.fetchedAt || '').slice(0, 10) || fallback; }

function targetCoverage(payload, ctx) {
    const papers = getSavedAnalysisPapers(payload);
    if (payload.batchDate !== ctx.date) throw new Error('正式分析结果的 batchDate 与本次 rewrite 基线不一致');
    const selected = papers.filter(paper => ctx.paperIds.includes(idOf(paper)));
    const dateIds = papers.filter(paper => paperDate(paper, payload.batchDate) === ctx.date).map(idOf).sort();
    if (jsonHash(selected.map(idOf).sort()) !== jsonHash(ctx.paperIds) || jsonHash(dateIds) !== jsonHash(ctx.paperIds)) {
        throw new Error('正式分析结果按日期和论文 ID 取出的集合，与本次完整 rewrite 批次不一致');
    }
    return selected;
}

function validateBlogPath(relative, ctx) {
    under(ctx.blogRepo, relative);
    if (relative === `content/posts/${ctx.date}.md`
        || (relative.startsWith(`content/posts/${ctx.date}-`) && relative.endsWith('.md'))) return relative;
    for (const id of ctx.paperIds) {
        if (relative.startsWith(`static/images/papers/${id}/`)
            || relative.startsWith(`static/data/papers/${ctx.date}/${id.replace('.', '-')}/`)) return relative;
    }
    throw new Error(`清单路径不在 fresh rewrite 的允许范围内：${relative}`);
}

function relatedDataFiles(ctx) {
    const names = new Set([path.basename(ctx.canonicalPath), 'filtered-papers.json', 'raw-candidates.json',
        'filter-decisions.json', 'fetch-checkpoint.json', 'papers.json']);
    for (const name of fs.readdirSync(ctx.currentDir)) {
        if (name.startsWith(`blog-generation-manifest-${ctx.date}`) || name.startsWith(`blog-review-receipt-${ctx.date}`)) {
            if (name === `blog-generation-manifest-${ctx.date}.json` || name === `blog-review-receipt-${ctx.date}.json`
                || /^blog-(?:generation-manifest|review-receipt)-\d{4}-\d{2}-\d{2}-single-[\w-]+\.json$/.test(name)) names.add(name);
        }
    }
    for (const dir of ['visual-summary-manifests', 'digest-cover-manifests', 'post-publish-visual-waivers']) {
        const relative = `${dir}/${ctx.date}.json`;
        if (fs.existsSync(under(ctx.currentDir, relative))) names.add(relative);
    }
    return [...names].sort();
}

function addControlledAssets(ctx, blogFiles, relative) {
    const directory = under(ctx.blogRepo, relative);
    try {
        if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe symlink in target blog assets');
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    safeDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
        const child = `${relative}/${name}`; const filename = under(ctx.blogRepo, child);
        const stat = fs.lstatSync(filename);
        if (stat.isSymbolicLink()) throw new Error('Unsafe symlink in target blog assets');
        if (stat.isDirectory()) addControlledAssets(ctx, blogFiles, child);
        else if (stat.isFile()) blogFiles.add(validateBlogPath(child, ctx));
        else throw new Error('Unsafe nonregular target blog asset');
    }
}

function verifyBatchInputBaseline(ctx, baseline) {
    const batchInputs = new Set(['filtered-papers.json', 'raw-candidates.json', 'filter-decisions.json', 'fetch-checkpoint.json']);
    for (const record of baseline.files) {
        if (record.category === 'data' && batchInputs.has(record.relativePath)
            && hash(readBytes(under(ctx.currentDir, record.relativePath))) !== record.sha256) {
            throw new Error(`Batch input baseline drifted: ${record.relativePath}`);
        }
    }
}

function baselineDescriptor(baseline, raw) {
    return { version: 1, contract: BASELINE_CONTRACT, path: 'baseline.json', sha256: hash(raw),
        canonicalSha256: baseline.canonical.sha256, canonicalGeneration: baseline.canonical.generation,
        blogHead: baseline.blog.head, paperIds: baseline.paperIds, pageCount: baseline.pages.length,
        sourceExpectations: baseline.sourceExpectations };
}

function loadBaseline(ctx, descriptor, { allowPendingLink = false } = {}) {
    const raw = readBytes(path.join(ctx.runDir, 'baseline.json'), { allowPendingLink });
    const baseline = JSON.parse(raw);
    if (baseline.contract !== BASELINE_CONTRACT || baseline.date !== ctx.date
        || baseline.blog.repo !== ctx.blogRepo || baseline.canonical.path !== ctx.canonicalPath
        || jsonHash(baseline.paperIds) !== jsonHash(ctx.paperIds)
        || (descriptor && descriptor.sha256 !== hash(raw))) throw new Error('Fresh baseline identity or SHA mismatch');
    for (const record of baseline.files) {
        const backup = under(ctx.runDir, record.backupPath);
        if (!record.backupPath.startsWith('baseline-files/') || hash(readBytes(backup, { allowPendingLink })) !== record.sha256
            || (fs.lstatSync(backup).mode & 0o777) !== 0o600) throw new Error('Fresh baseline backup is corrupt');
    }
    return { baseline, raw };
}

function withBatchPaperLocks(ctx, options, callback, index = 0) {
    if (index === ctx.paperIds.length) return callback();
    const id = ctx.paperIds[index];
    const lockPath = options.paperLockRoot
        ? path.join(safeDirectory(options.paperLockRoot, true), id)
        : getPaperAnalysisLockPath({ arxivId: id });
    safeDirectory(path.dirname(lockPath), true);
    return withFileLockSync(lockPath, () => withBatchPaperLocks(ctx, options, callback, index + 1),
        { timeoutMs: options.paperLockTimeoutMs ?? 30000, staleMs: 6 * 60 * 60 * 1000 });
}

function synchronizePapersDatabase(ctx, run, analysis, options) {
    const databasePath = path.join(ctx.currentDir, 'papers.json');
    const { normalizePapersDatabase, applyAnalysisDigestStatuses } = require('../digest-status.js');
    return withFileLockSync(databasePath, () => {
        const database = normalizePapersDatabase(readJson(databasePath));
        const current = analysis.papers.every(paper => {
            const saved = database.papers[idOf(paper)];
            return saved?.digestStatus?.status === 'analyzed'
                && saved.digestStatus.latestAttemptStatus === 'analyzed'
                && saved.digestStatus.batchDate === ctx.date
                && ['analysis', 'apiReaderArticle', 'parsed', 'analysisManifest', 'freshRewriteProvenance']
                    .every(key => jsonHash(saved[key]) === jsonHash(paper[key]));
        });
        if (current) return { updated: 0, generation: database.generation };
        const apply = options.applyDigestStatuses || applyAnalysisDigestStatuses;
        const updatedAt = getBeijingISOString();
        const updated = apply(database, analysis.papers, { batchDate: ctx.date, updatedAt });
        if (updated !== ctx.paperIds.length) throw new Error('论文库没有同步全部 fresh 论文：更新条数与论文数不符');
        for (const paper of analysis.papers) {
            const saved = database.papers[idOf(paper)];
            if (saved?.digestStatus?.latestAttemptStatus !== 'analyzed'
                || saved?.freshRewriteProvenance?.runId !== run.runId
                || saved.analysis !== paper.analysis || saved.apiReaderArticle !== paper.apiReaderArticle) {
                throw new Error('论文库没有写入预期的 analyzed 状态或 freshRewriteProvenance');
            }
        }
        database.generation = (database.generation || 0) + 1;
        if (!Number.isSafeInteger(database.generation)) throw new Error('论文库 generation 自增后超出安全整数范围');
        database.lastUpdated = updatedAt;
        replacePrivate(databasePath, Buffer.from(JSON.stringify(database)));
        return { updated, generation: database.generation };
    });
}

function prepareBaseline(options) {
    const ctx = context(options);
    return withFileLockSync(path.join(ctx.runDir, 'baseline.json'), () => {
        const blog = gitState(ctx.blogRepo);
        if (fs.existsSync(path.join(ctx.runDir, 'baseline.json'))) {
            const { baseline, raw } = loadBaseline(ctx, undefined, { allowPendingLink: true });
            if (blog.head !== baseline.blog.head || hash(readBytes(ctx.canonicalPath)) !== baseline.canonical.sha256) {
                throw new Error('准备之后 fresh 基线发生变化：博客 HEAD 或正式分析结果字节已不同');
            }
            const baselinePath = path.join(ctx.runDir, 'baseline.json');
            const pending = baseline.files.filter(record =>
                fs.lstatSync(under(ctx.runDir, record.backupPath)).nlink === 2);
            if (pending.length || fs.lstatSync(baselinePath).nlink === 2) {
                // 先核验全部原输入，任何变化都不得借恢复操作清理现有链接。
                for (const record of baseline.files) {
                    if (!['blog', 'data'].includes(record.category)) throw new Error('基线备份类别无效');
                    const source = under(record.category === 'blog' ? ctx.blogRepo : ctx.currentDir, record.relativePath);
                    if (hash(readBytes(source)) !== record.sha256) throw new Error(`基线恢复前原输入已变化：${record.relativePath}`);
                }
                for (const record of pending) {
                    const filename = under(ctx.runDir, record.backupPath);
                    const bytes = readBytes(filename, { allowPendingLink: true });
                    if (hash(bytes) !== record.sha256) throw new Error('基线备份在恢复前发生变化');
                    immutableWrite(filename, bytes);
                }
                immutableWrite(baselinePath, raw);
                loadBaseline(ctx, baselineDescriptor(baseline, raw));
            }
            return baselineDescriptor(baseline, raw);
        }
        const canonicalRaw = readBytes(ctx.canonicalPath); const canonical = JSON.parse(canonicalRaw);
        const papers = targetCoverage(canonical, ctx); const sourceExpectations = {}; const oldPaperHashes = {};
        for (const paper of papers) {
            const id = idOf(paper); const source = paper.analysisManifest?.sourceAcquisition;
            // fresh rewrite 从不把原有的来源哈希当作自己的写作证据。它们只在下面那段
            // 旧文本差异审计里还有用。sources 阶段会在 generation 1 封存一份新的官方
            // HTML/PDF 包，并在分析开始前记录它的清单、文本、PDF 和运行时身份。
            const structuredSha = source?.structuredArtifactsSha256;
            if (!validSha(paper.sourceSha256) || paper.sourceSha256 !== source?.sourceSha256 || !validSha(structuredSha)
                || typeof paper.analysis !== 'string' || typeof paper.apiReaderArticle !== 'string') {
                throw new Error(`基线论文缺少用于差异审计的旧生成文本：${id}`);
            }
            if (source.sourceId !== undefined && (typeof source.sourceId !== 'string'
                || !/^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/.test(source.sourceId)
                || idOf({ arxivId: source.sourceId }) !== id)) {
                throw new Error(`Baseline original source ID does not identify its paper: ${id}`);
            }
            sourceExpectations[id] = { sourceMode: 'sealed-arxiv-bundle-v1', sourceGeneration: 1 };
            oldPaperHashes[id] = { analysisSha256: hash(paper.analysis), readerArticleSha256: hash(paper.apiReaderArticle) };
        }
        const dataFiles = relatedDataFiles(ctx); const blogFiles = new Set();
        const postDir = path.join(ctx.blogRepo, 'content', 'posts');
        for (const name of fs.readdirSync(postDir)) {
            if (name === `${ctx.date}.md` || (name.startsWith(`${ctx.date}-`) && name.endsWith('.md'))) blogFiles.add(`content/posts/${name}`);
        }
        for (const relative of dataFiles.filter(name => path.basename(name).startsWith('blog-generation-manifest-'))) {
            const manifest = readJson(under(ctx.currentDir, relative));
            if (!Array.isArray(manifest.files)) throw new Error('已有的生成清单里没有 files 数组');
            for (const record of manifest.files) {
                validateBlogPath(record.path, ctx);
                if (!record.deleted && fs.existsSync(under(ctx.blogRepo, record.path))) blogFiles.add(record.path);
            }
        }
        for (const id of ctx.paperIds) {
            addControlledAssets(ctx, blogFiles, `static/images/papers/${id}`);
            addControlledAssets(ctx, blogFiles, `static/data/papers/${ctx.date}/${id.replace('.', '-')}`);
        }
        const pages = [];
        for (const relative of [...blogFiles].filter(name => name.endsWith('.md'))) {
            const raw = readBytes(under(ctx.blogRepo, relative)); const content = raw.toString('utf8');
            if (!/^paper_digest_pipeline_owned:\s*true\s*$/m.test(content)) throw new Error(`博客页面没有 paper_digest_pipeline_owned 标记：${relative}`);
            const id = relative === `content/posts/${ctx.date}.md` ? null
                : content.match(/^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$/m)?.[1];
            if (id !== null && !ctx.paperIds.includes(id)) throw new Error('博客页面里的 arXiv ID 与本次入选批次不一致');
            const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
            pages.push({ paperId: id, path: relative, sha256: hash(raw), bodySha256: hash(body) });
        }
        if (pages.length !== ctx.paperIds.length + 1
            || jsonHash(pages.filter(p => p.paperId).map(p => p.paperId).sort()) !== jsonHash(ctx.paperIds)) throw new Error('博客必须为每篇论文各有一页，且汇总页恰好一页');
        const files = [];
        for (const [category, root, relatives] of [['data', ctx.currentDir, dataFiles], ['blog', ctx.blogRepo, [...blogFiles].sort()]]) {
            for (const relativePath of relatives) {
                const raw = readBytes(under(root, relativePath));
                const backupPath = `baseline-files/${category}/${relativePath}`;
                immutableWrite(under(ctx.runDir, backupPath), raw);
                files.push({ category, relativePath, backupPath, sha256: hash(raw), size: raw.length });
            }
        }
        if (gitState(ctx.blogRepo).head !== blog.head || hash(readBytes(ctx.canonicalPath)) !== hash(canonicalRaw)
            || files.some(record => hash(readBytes(under(record.category === 'blog' ? ctx.blogRepo : ctx.currentDir, record.relativePath))) !== record.sha256)) {
            throw new Error('备份期间基线输入又变了，因此拒绝为这份快照出凭证');
        }
        const baseline = { version: 1, contract: BASELINE_CONTRACT, date: ctx.date, createdAt: getBeijingISOString(),
            paperIds: ctx.paperIds, blog: { repo: ctx.blogRepo, ...blog },
            canonical: { path: ctx.canonicalPath, sha256: hash(canonicalRaw), generation: canonical.generation },
            pages: pages.sort((a, b) => a.path.localeCompare(b.path)), sourceExpectations, oldPaperHashes, files };
        const raw = Buffer.from(JSON.stringify(baseline, null, 2));
        immutableWrite(path.join(ctx.runDir, 'baseline.json'), raw);
        return baselineDescriptor(baseline, raw);
    });
}

function promoteRun(options) {
    const ctx = context(options); const { run, analysis } = options;
    const { baseline } = loadBaseline(ctx, run?.baseline);
    if (run?.contract !== 'fresh-rewrite-run-v1' || run.version !== 1 || run.runId !== path.basename(ctx.runDir)
        || !['complete', 'promoted'].includes(run.status) || analysis?.status !== 'complete'
        || jsonHash(run.sourceExpectations) !== jsonHash(baseline.sourceExpectations)
        || !Array.isArray(analysis.papers) || jsonHash(analysis.papers.map(idOf).sort()) !== jsonHash(ctx.paperIds)) {
        throw new Error('Fresh rewrite run/analysis paper coverage is incomplete');
    }
    const validatePaper = options.validatePaper || isSuccessfulAnalysisRecord;
    const readSource = options.readSource || require('./fresh-analysis-context.js').readFreshSource;
    const validateNewBatch = () => analysis.papers.forEach(paper => {
        const id = idOf(paper); const provenance = paper.freshRewriteProvenance;
        const expected = run.sourceRecords?.[id]; const sourcePlan = baseline.sourceExpectations[id];
        if (!provenance || provenance.contract !== SOURCE_CONTRACT || provenance.runId !== run.runId
            || provenance.sourceOnly !== true || provenance.oldGeneratedTextIncluded !== false
            || jsonHash(provenance) !== jsonHash(paper.analysisManifest?.freshRewriteProvenance)
            || !expected || provenance.sourceSha256 !== expected.sourceSha256 || paper.sourceSha256 !== expected.sourceSha256
            || paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== expected.sourceSha256
            || paper.analysisManifest?.sourceAcquisition?.structuredArtifactsSha256 !== expected.structuredArtifactsSha256
            || provenance.structuredArtifactsSha256 !== expected.structuredArtifactsSha256
            || !validSha(provenance.sourceSnapshotSha256) || paperDate(paper, analysis.batchDate) !== ctx.date
            || (sourcePlan?.sourceMode === 'sealed-arxiv-bundle-v1' && (provenance.sourceGeneration !== expected.sourceGeneration
                || provenance.sourceManifestSha256 !== expected.sourceManifestSha256
                || !validSha(provenance.sourceManifestSha256)))
            || !validatePaper(paper)) throw new Error(`fresh 生产来源凭证不完整：${id}`);
        if (typeof paper.analysis !== 'string' || !paper.analysis.trim()
            || typeof paper.apiReaderArticle !== 'string' || !paper.apiReaderArticle.trim()
            || hash(paper.analysis) === baseline.oldPaperHashes[id].analysisSha256
            || hash(paper.apiReaderArticle) === baseline.oldPaperHashes[id].readerArticleSha256) {
            throw new Error(`每篇论文都要有新写的分析正文和 Reader 正文，${id} 仍为空或与旧字节相同`);
        }
        const sourceDetails = readSource(ctx.runDir, paper, { runId: run.runId, sourceExpectations: run.sourceExpectations });
        const descriptor = sourceDetails?.freshSourceDescriptor;
        if (!descriptor || descriptor.runId !== run.runId || descriptor.paperId !== id
            || ['sourceSha256', 'structuredArtifactsSha256', 'sourceSnapshotSha256'].some(key => descriptor[key] !== provenance[key])
            || (sourcePlan?.sourceMode === 'sealed-arxiv-bundle-v1'
                && ['sourceGeneration', 'sourceManifestSha256'].some(key => descriptor[key] !== provenance[key]))) {
            throw new Error(`Fresh source snapshot drift or missing original evidence: ${id}`);
        }
        if (!require('./model-text-sanitization.js').canReuseModelTextInputs(paper, sourceDetails)) {
            throw new Error(`旧 Unicode 模型输入需重新分析，不能提升正式记录：${id}`);
        }
    });
    const inputSha256 = jsonHash(analysis);
    return withBatchPaperLocks(ctx, options, () => withFileLockSync(ctx.canonicalPath, () => {
        const canonicalRaw = readBytes(ctx.canonicalPath); const canonical = JSON.parse(canonicalRaw);
        getSavedAnalysisPapers(canonical);
        validateNewBatch();
        const intentPath = path.join(ctx.runDir, 'promotion.json');
        const priorIntentRaw = fs.existsSync(intentPath) ? readBytes(intentPath, { allowPendingLink: true }) : null;
        const priorIntent = priorIntentRaw ? JSON.parse(priorIntentRaw) : null;
        if (priorIntent && (priorIntent.contract !== PROMOTION_CONTRACT || priorIntent.runId !== run.runId
            || priorIntent.baselineSha256 !== run.baseline.sha256 || priorIntent.inputSha256 !== inputSha256)) {
            throw new Error('已保存的不可变晋升意图与本次运行不符');
        }
        if (priorIntent && hash(canonicalRaw) === priorIntent.canonicalSha256
            && canonical.generation === priorIntent.canonicalGeneration) {
            verifyBatchInputBaseline(ctx, baseline);
            immutableWrite(intentPath, priorIntentRaw);
            const database = synchronizePapersDatabase(ctx, run, analysis, options);
            return { ...priorIntent, status: 'promoted', papersDatabase: database, alreadyPromoted: true };
        }
        if (hash(canonicalRaw) !== baseline.canonical.sha256 || canonical.generation !== baseline.canonical.generation) {
            throw new Error('Canonical CAS baseline SHA/generation drifted; nothing was promoted');
        }
        targetCoverage(canonical, ctx);
        verifyBatchInputBaseline(ctx, baseline);
        if (gitState(ctx.blogRepo).head !== baseline.blog.head) throw new Error('博客 HEAD 相对 fresh 基线已变化');
        let nextRaw; let intent = priorIntent;
        if (intent) {
            const stagedPath = path.join(ctx.runDir, 'promoted-canonical.json');
            nextRaw = readBytes(stagedPath, { allowPendingLink: true });
            if (hash(nextRaw) !== intent.canonicalSha256) throw new Error('晋升恢复载荷已损坏：字节与记录的 canonicalSha256 不符');
            immutableWrite(stagedPath, nextRaw);
            immutableWrite(intentPath, priorIntentRaw);
        } else {
            const replacements = new Map(analysis.papers.map(paper => [idOf(paper), structuredClone(paper)]));
            const stagedPath = path.join(ctx.runDir, 'promoted-canonical.json');
            const stagedRaw = fs.existsSync(stagedPath) ? readBytes(stagedPath, { allowPendingLink: true }) : null;
            const staged = stagedRaw ? JSON.parse(stagedRaw) : null;
            const promotedAt = staged?.lastUpdated || getBeijingISOString();
            const next = { ...canonical, generation: canonical.generation + 1,
                papers: canonical.papers.map(paper => replacements.get(idOf(paper)) || paper),
                status: 'complete', lastUpdated: promotedAt, deepAnalysisCompletedAt: promotedAt,
                stats: { ...canonical.stats, analysisStatus: 'complete', pipelineStatus: 'analysis_complete',
                    newlyAnalyzed: ctx.paperIds.length, preservedExisting: canonical.papers.length - ctx.paperIds.length,
                    successfulExpected: ctx.paperIds.length, remainingFailed: 0, analyzedSuccess: ctx.paperIds.length,
                    analyzedFailed: 0, total: ctx.paperIds.length, success: ctx.paperIds.length, failed: 0, savedAt: promotedAt },
                freshRewritePromotion: { contract: PROMOTION_CONTRACT, runId: run.runId, baselineSha256: run.baseline.sha256 } };
            if (!Number.isSafeInteger(next.generation)) throw new Error('正式分析结果的 generation 自增后超出安全整数范围');
            if (staged && jsonHash(staged) !== jsonHash(next)) throw new Error('晋升恢复载荷与本次 fresh 批次不一致');
            nextRaw = stagedRaw || Buffer.from(JSON.stringify(next, null, 2));
            immutableWrite(stagedPath, nextRaw);
            intent = { version: 1, contract: PROMOTION_CONTRACT, status: 'prepared', runId: run.runId,
                baselineSha256: run.baseline.sha256, inputSha256, promotedAt,
                canonicalSha256: hash(nextRaw), canonicalGeneration: next.generation };
            immutableWrite(intentPath, JSON.stringify(intent, null, 2));
        }
        // 规范锁还持着；原子替换前立刻重读一次。
        if (hash(readBytes(ctx.canonicalPath)) !== baseline.canonical.sha256) throw new Error('原子替换前正式分析结果的字节又变了');
        verifyBatchInputBaseline(ctx, baseline);
        replacePrivate(ctx.canonicalPath, nextRaw);
        if (hash(readBytes(ctx.canonicalPath)) !== intent.canonicalSha256) throw new Error('写回后校验失败：正式分析结果的字节与晋升意图记录不符');
        const database = synchronizePapersDatabase(ctx, run, analysis, options);
        return { ...intent, status: 'promoted', papersDatabase: database, alreadyPromoted: false };
    }));
}

module.exports = { BASELINE_CONTRACT, PROMOTION_CONTRACT, prepareBaseline, promoteRun };

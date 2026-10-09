'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scope = new AsyncLocalStorage();
const CONTRACT = 'fresh-source-analysis-v1';
const CACHE_CONTRACT = 'fresh-source-cache-v1';
const BUNDLE_CACHE_CONTRACT = 'fresh-source-bundle-v2';
const BUNDLE_SOURCE_MODE = 'sealed-arxiv-bundle-v1';
const DAILY_SOURCE_RUN_CONTRACT = 'daily-fresh-source-run-v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item;
    return sha(JSON.stringify(normalize(value)) ?? 'null');
};
const validSha = value => /^[a-f0-9]{64}$/.test(String(value || ''));

function isBundleExpectation(value) {
    return Boolean(value) && value.sourceMode === BUNDLE_SOURCE_MODE
        && Number.isSafeInteger(value.sourceGeneration) && value.sourceGeneration >= 1;
}

function fail(message) {
    const error = new Error(message);
    error.code = 'FRESH_ANALYSIS_INTEGRITY'; error.retryable = false;
    return error;
}

function paperId(paper) {
    const raw = typeof paper === 'string' ? paper : paper?.arxivId || paper?.paper_id || paper?.id;
    if (!/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(String(raw || ''))) throw fail('fresh 来源需要规范化的 arXiv 身份');
    return raw.replace(/v\d+$/, '');
}

function safeDirectory(directory, create = false) {
    const absolute = path.resolve(directory);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(`Unsafe fresh directory: ${cursor}`);
    }
    return absolute;
}

function readBytes(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw fail('Unsafe or oversized fresh cache file');
        return fs.readFileSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readJson(filename) {
    try { return JSON.parse(readBytes(filename).toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw error; throw fail(`fresh JSON 被拒绝：${error.message}`); }
}

function validateRun(runDir, identity) {
    const Config = require('../config.js');
    const runId = identity?.runId;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(runId || ''))) {
        throw fail('fresh runId 必须是 UUID');
    }
    const rewriteRoot = path.resolve(Config.FILES.freshRewriteRunsDir);
    const dailyRoot = path.resolve(Config.FILES.dailyFreshSourceRunsDir || '');
    const resolvedRunDir = path.resolve(runDir);
    const roots = [
        { root: rewriteRoot, contract: 'fresh-rewrite-run-v1' },
        { root: dailyRoot, contract: DAILY_SOURCE_RUN_CONTRACT }
    ].filter(item => item.root && item.root !== path.resolve('.'));
    const matchedRoot = roots.find(item => resolvedRunDir === path.join(item.root, runId));
    if (!matchedRoot) throw fail('Fresh runDir must be the configured root/runId directory');
    safeDirectory(resolvedRunDir);
    const run = readJson(path.join(resolvedRunDir, 'run.json'));
    if (run.runId !== runId || run.contract !== matchedRoot.contract || run.version !== 1) throw fail('来源运行清单格式无效，或与请求的运行不匹配。');
    const expectations = identity?.sourceExpectations;
    if (!expectations || typeof expectations !== 'object' || Array.isArray(expectations)
        || stable(expectations) !== stable(run.sourceExpectations)) throw fail('Fresh source expectations differ from the run manifest');
    const ids = Object.keys(expectations);
    if (!ids.length || !Array.isArray(run.paperIds) || stable(ids.slice().sort()) !== stable(run.paperIds.slice().sort())) {
        throw fail('fresh 来源预期未覆盖确切的运行输入集合');
    }
    for (const id of ids) {
        const expectation = expectations[id];
        if (paperId(id) !== id || (!isBundleExpectation(expectation)
            && (!validSha(expectation?.sourceSha256) || !validSha(expectation?.structuredArtifactsSha256)))) {
            throw fail(`${id} 的预期来源记录未提供有效的论文 ID，以及所需的来源哈希或包代次。`);
        }
        if (expectations[id].sourceId !== undefined && paperId(expectations[id].sourceId) !== id) {
            throw fail(`Fresh sourceId belongs to another paper: ${id}`);
        }
    }
    return { runId, runDir: resolvedRunDir, runContract: matchedRoot.contract, sourceExpectations: structuredClone(expectations),
        inputSetSha256: stable(ids.slice().sort()) };
}

function withFreshAnalysisContext(identity, callback) {
    const checked = validateRun(identity?.runDir, identity);
    if (identity.refreshReaderDiagnostics !== undefined && typeof identity.refreshReaderDiagnostics !== 'boolean') {
        throw fail('refreshReaderDiagnostics must be an explicit boolean');
    }
    for (const expectation of Object.values(checked.sourceExpectations)) Object.freeze(expectation);
    Object.freeze(checked.sourceExpectations);
    const recoveryPermissions = identity.savedAnalysisRecoveryPermissions === undefined
        ? new Map() : identity.savedAnalysisRecoveryPermissions;
    if (!(recoveryPermissions instanceof Map)
        || [...recoveryPermissions.entries()].some(([id, handle]) => {
            const snapshot = require('./fresh-rewrite-run.js')
                .getSavedAnalysisRecoveryPermissionDetails(handle);
            const expected = checked.sourceExpectations[id];
            return !expected || snapshot?.runId !== checked.runId
                || snapshot.paperId !== id
                || (!isBundleExpectation(expected) && (snapshot.sourceSha256 !== expected.sourceSha256
                    || snapshot.structuredArtifactsSha256 !== expected.structuredArtifactsSha256))
                || (isBundleExpectation(expected) && (snapshot.sourceGeneration !== expected.sourceGeneration
                    || !validSha(snapshot.sourceManifestSha256)));
        })) throw fail('已保存分析的恢复权限格式无效，或与本次运行及其预期来源不匹配。');
    const { withLlmUsageContext } = require('./llm-usage.js');
    const context = Object.freeze({ ...checked,
        refreshReaderDiagnostics: identity.refreshReaderDiagnostics === true,
        savedAnalysisRecoveryPermissions: new Map(recoveryPermissions),
        pendingSources: new Map() });
    return scope.run(context,
        () => withLlmUsageContext({ runId: checked.runId }, callback));
}

function getFreshAnalysisContext() { return scope.getStore() || null; }

// 日更来源运行会封存 source.txt、source.pdf、source-runtime.json 和
// source-manifest.json。图片字节按设计只为当前请求临时生成，所以失败的 Reader 候选
// 需要单独的一份临时像素绑定。更早的 fresh rewrite 运行沿用它们已有的候选语义。
function isDailyFreshSourceScope() {
    return getFreshAnalysisContext()?.runContract === DAILY_SOURCE_RUN_CONTRACT;
}

function getSavedAnalysisRecoveryPermission(id = getFreshAnalysisContext()?.paperId) {
    const context = getFreshAnalysisContext();
    if (!context || !id) return null;
    return context.savedAnalysisRecoveryPermissions.get(paperId(id)) || null;
}

function validateSource(details, id, expectation) {
    if (!details || typeof details !== 'object' || Array.isArray(details)
        || Object.keys(details).some(key => /^(?:analysis|parsed$|apiReader|freshRewrite|freshSource)/.test(key))) {
        throw fail('来源详情缺失、格式无效，或含生成的分析、Reader、检查点或来源记录字段。');
    }
    const minimum = require('../config.js').ANALYSIS_CONFIG.fullTextMinCharsForFull;
    if (!['html', 'pdf'].includes(details.source) || typeof details.text !== 'string'
        || details.text.length <= minimum || paperId(details.sourceId) !== id
        || sha(details.text) !== expectation.sourceSha256) throw fail(`${id} 的来源文本格式无效、过短，或与预期的论文和内容哈希不匹配。`);
    const artifacts = details.structuredArtifacts;
    if (!artifacts || typeof artifacts !== 'object' || !Array.isArray(artifacts.tables) || !Array.isArray(artifacts.formulas)) {
        throw fail('来源详情必须包含带 table 与 formula 数组的 structuredArtifacts 对象。');
    }
    const { payloadSha256, ...body } = artifacts;
    if (!validSha(payloadSha256) || sha(JSON.stringify(body)) !== payloadSha256
        || payloadSha256 !== expectation.structuredArtifactsSha256
        || artifacts.flattenedTextSha256 !== expectation.sourceSha256) {
        throw fail(`${id} 的结构化产物内容哈希无效，或与预期产物和来源文本不匹配。`);
    }
    return details;
}

function sourceDirectory(context, id) { return path.join(context.runDir, 'sources', id); }

function bundleRoot(context) { return path.join(context.runDir, 'sources'); }

function buildSourceDetailsFromBundle(stored) {
    // 已封存的来源包已经用持久化的 PDF/TXT 清单校验过非像素的运行元数据。复算这份
    // 包能保住日更 Reader 运行所需的表格、公式绑定和图片发现结果；它从不包含图片
    // 字节，也不含旧的 data/current 缓存路径。
    const runtime = stored.runtimeDetails;
    if (!runtime || runtime.paperId !== stored.manifest.paperId
        || runtime.text !== stored.text || runtime.source !== stored.manifest.text.source
        || runtime.sourceId !== stored.manifest.text.sourceId) {
        throw fail('来源包运行时元数据缺失，或与其清单和文本不匹配。');
    }
    const details = { text: runtime.text, source: runtime.source, sourceId: runtime.sourceId,
        imageInfos: structuredClone(runtime.imageInfos), structuredArtifacts: structuredClone(runtime.structuredArtifacts),
        readerAuthors: runtime.readerAuthors === null ? { authors: [] } : structuredClone(runtime.readerAuthors),
        htmlAvailability: runtime.htmlAvailability, htmlAttempts: runtime.htmlAttempts,
        warnings: runtime.warnings.map(String) };
    const sourceSnapshot = { sourceManifestSha256: stored.sourceManifestSha256,
        sourceGeneration: stored.generation, details };
    const descriptor = { version: 2, contract: BUNDLE_CACHE_CONTRACT, runId: null, paperId: stored.manifest.paperId.slice(6),
        sourceGeneration: stored.generation, sourceManifestSha256: stored.sourceManifestSha256,
        sourceSha256: stored.manifest.text.responseSha256,
        structuredArtifactsSha256: details.structuredArtifacts.payloadSha256 || '',
        sourceSnapshotSha256: sha(JSON.stringify(sourceSnapshot)),
        ...(runtime.sourceVersion ? { sourceVersionIdentitySha256: runtime.sourceVersion.identitySha256 } : {}) };
    // 保持已有的快照字段不变。来源清单已经通过精确文件哈希绑定了运行时的标题和版本
    // 元数据。
    return { ...details, title: runtime.title,
        ...(runtime.sourceVersion ? { sourceVersion: structuredClone(runtime.sourceVersion) } : {}),
        freshSourceDescriptor: descriptor };
}

// 这一篇的来源目录是不是真的不存在。fs.existsSync 会把权限不足、父目录读不了
// 也报成 false；用它判断，读取失败就会被当成来源换新，所以要自己只认 ENOENT。
function sourceGenerationAbsent(sourceApi, root, id, generation) {
    try {
        fs.lstatSync(sourceApi.sourceDirectory(root, id, generation));
        return false;
    } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
    }
}

function readBundleFreshSource(checked, id, expectation) {
    const sourceApi = require('./fresh-arxiv-rewrite-source.js');
    const root = bundleRoot(checked);
    if (sourceGenerationAbsent(sourceApi, root, id, expectation.sourceGeneration)) return null;
    const stored = sourceApi.readFreshArxivRewriteSource({ rootDir: root, arxivId: id,
        generation: expectation.sourceGeneration });
    const source = buildSourceDetailsFromBundle(stored);
    source.freshSourceDescriptor.runId = checked.runId;
    if (source.freshSourceDescriptor.paperId !== id
        || source.freshSourceDescriptor.sourceGeneration !== expectation.sourceGeneration
        || !validSha(source.freshSourceDescriptor.sourceManifestSha256)) {
        throw fail('来源包的清单哈希无效，或与预期的论文和代次不匹配。');
    }
    return source;
}

function readFreshSource(runDir, paper, identity) {
    const checked = validateRun(runDir, identity);
    const id = paperId(paper);
    const expectation = checked.sourceExpectations[id];
    if (!expectation) throw fail(`论文不在该 fresh 运行内：${id}`);
    if (isBundleExpectation(expectation)) return readBundleFreshSource(checked, id, expectation);
    const directory = sourceDirectory(checked, id);
    try { safeDirectory(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let descriptor;
    try { descriptor = readJson(path.join(directory, 'source.json')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (descriptor.contract !== CACHE_CONTRACT || descriptor.version !== 1 || descriptor.runId !== checked.runId
        || descriptor.paperId !== id || descriptor.sourceSha256 !== expectation.sourceSha256
        || descriptor.structuredArtifactsSha256 !== expectation.structuredArtifactsSha256
        || !validSha(descriptor.sourceSnapshotSha256)) throw fail('来源描述符格式无效，或与本次运行、论文及预期来源哈希不匹配。');
    const bytes = readBytes(path.join(directory, 'source-details.json'));
    if (sha(bytes) !== descriptor.sourceSnapshotSha256) throw fail('fresh 来源快照字节已变化');
    const details = validateSource(JSON.parse(bytes.toString('utf8')), id, expectation);
    if (sha(readBytes(path.join(directory, 'source.txt'))) !== expectation.sourceSha256
        || readBytes(path.join(directory, 'artifacts.json')).toString('utf8') !== JSON.stringify(details.structuredArtifacts)) {
        throw fail('The source text or artifact files do not match the saved source details.');
    }
    return { ...details, freshSourceDescriptor: descriptor };
}

function writeExact(directory, filename, bytes) {
    safeDirectory(directory, true);
    const target = path.join(directory, filename);
    try {
        const existing = readBytes(target);
        if (existing.equals(Buffer.from(bytes))) return;
        throw fail(`fresh 缓存拒绝覆盖不同的字节：${filename}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        safeDirectory(directory);
        // 用排他链接提交，不会覆盖并发创建的文件。
        try { fs.linkSync(temporary, target); }
        catch (error) {
            if (error.code !== 'EEXIST' || !readBytes(target).equals(Buffer.from(bytes))) throw error;
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

async function fetchFreshSource(arxivId, fetchOriginal) {
    const context = getFreshAnalysisContext();
    if (!context) return fetchOriginal(arxivId);
    const id = paperId(arxivId);
    const cached = readFreshSource(context.runDir, id, context);
    if (cached) return cached;
    if (context.pendingSources.has(id)) return structuredClone(await context.pendingSources.get(id));
    const pending = (async () => {
        const expectation = context.sourceExpectations[id];
        if (isBundleExpectation(expectation)) {
            const sourceApi = require('./fresh-arxiv-rewrite-source.js');
            await sourceApi.captureFreshArxivRewriteSource({ rootDir: bundleRoot(context), arxivId: id,
                generation: expectation.sourceGeneration });
            const sourceDetails = readFreshSource(context.runDir, id, context);
            if (!sourceDetails) throw fail('无法把已捕获的来源文件回读为完整的来源包。');
            return sourceDetails;
        }
        const directory = sourceDirectory(context, id);
        let details;
        try {
            // 写完 source-details、还没写提交标记时崩溃，可以在本地补齐：重新逐字节
            // 核对原始数据即可。
            safeDirectory(directory);
            details = readJson(path.join(directory, 'source-details.json'));
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!details) details = await fetchOriginal(arxivId);
        validateSource(details, id, expectation);
        validateRun(context.runDir, context);
        const sourceSnapshot = JSON.stringify(details);
        const descriptor = { version: 1, contract: CACHE_CONTRACT, runId: context.runId, paperId: id,
            sourceSha256: expectation.sourceSha256, structuredArtifactsSha256: expectation.structuredArtifactsSha256,
            sourceSnapshotSha256: sha(sourceSnapshot) };
        writeExact(directory, 'source.txt', details.text);
        writeExact(directory, 'artifacts.json', JSON.stringify(details.structuredArtifacts));
        writeExact(directory, 'source-details.json', sourceSnapshot);
        writeExact(directory, 'source.json', JSON.stringify(descriptor));
        return readFreshSource(context.runDir, id, context);
    })();
    context.pendingSources.set(id, pending);
    try { return structuredClone(await pending); } finally { context.pendingSources.delete(id); }
}

function resolveFreshSource(runDir, paper, identity) {
    const id = paperId(paper);
    const requestedId = isBundleExpectation(identity?.sourceExpectations?.[id]) ? id : identity?.sourceExpectations?.[id]?.sourceId
        ?? (typeof paper === 'string' ? paper : paper.arxivId || paper.paper_id || paper.id);
    if (paperId(requestedId) !== id) throw fail(`Fresh sourceId belongs to another paper: ${id}`);
    return withFreshAnalysisContext({ ...identity, runDir }, () => require('../deep-analyzer.js').fetchArxivTextDetailed(requestedId));
}

function freshAnalysisIdentity(id = getFreshAnalysisContext()?.paperId) {
    const context = getFreshAnalysisContext();
    if (!context) return null;
    const base = { contract: CONTRACT, runId: context.runId, inputSetSha256: context.inputSetSha256 };
    if (!id) return base;
    const source = readFreshSource(context.runDir, id, context);
    if (!source) throw fail('分析阶段开始前，本次运行的来源文件必须完整。');
    return { ...base, paperId: paperId(id), ...buildFreshSourceRecord(source) };
}

function buildFreshSourceRecord(source) {
    const context = getFreshAnalysisContext();
    const descriptor = source?.freshSourceDescriptor;
    if (!context || descriptor?.runId !== context.runId) throw fail('来源记录需要当前运行上下文及其对应的来源描述符。');
    return { contract: CONTRACT, runId: context.runId, sourceSha256: descriptor.sourceSha256,
        structuredArtifactsSha256: descriptor.structuredArtifactsSha256, sourceSnapshotSha256: descriptor.sourceSnapshotSha256,
        ...(descriptor.contract === BUNDLE_CACHE_CONTRACT ? { sourceGeneration: descriptor.sourceGeneration,
            sourceManifestSha256: descriptor.sourceManifestSha256,
            ...(descriptor.sourceVersionIdentitySha256 ? {
                sourceVersionIdentitySha256: descriptor.sourceVersionIdentitySha256
            } : {}) } : {}),
        sourceOnly: true, oldGeneratedTextIncluded: false };
}

function assertFreshPaper(paper) {
    const context = getFreshAnalysisContext();
    if (!context) return;
    const id = paperId(paper);
    if (!context.sourceExpectations[id]) throw fail(`论文不在该 fresh 运行内：${id}`);
    if (paper.fullText || paper.pdfText) throw fail('Fresh analysis must use this run source cache, not caller-provided text');
    const generated = Object.keys(paper).filter(key => /^(?:analysis(?:$|Checkpoint|Manifest|Stage|Recovery)|parsed$|apiReader|imageManifest$)/.test(key)
        && paper[key] !== undefined && paper[key] !== null && paper[key] !== '');
    if (!generated.length && !paper.freshRewriteProvenance) return;
    const source = readFreshSource(context.runDir, id, context);
    if (!source) throw fail('Generated analysis has no corresponding source files in this run.');
    const expected = buildFreshSourceRecord(source);
    if (stable(paper.freshRewriteProvenance) !== stable(expected)
        || (paper.analysisManifest && stable(paper.analysisManifest.freshRewriteProvenance) !== stable(expected))) {
        throw fail('The analysis or its stage manifest has a missing or inconsistent source record for this run.');
    }
}

function withFreshPaperContext(paper, callback) {
    const context = getFreshAnalysisContext();
    if (!context) return callback();
    assertFreshPaper(paper);
    return scope.run(Object.freeze({ ...context, paperId: paperId(paper) }), callback);
}

function attachFreshSourceRecord(paper, manifest, source) {
    if (!getFreshAnalysisContext()) return;
    const sourceRecord = buildFreshSourceRecord(source);
    paper.freshRewriteProvenance = sourceRecord;
    manifest.freshRewriteProvenance = structuredClone(sourceRecord);
}

function freshReaderAttemptsDirectory(requestedDirectory) {
    const context = getFreshAnalysisContext();
    if (!context) return requestedDirectory;
    const expected = path.join(context.runDir, 'reader-attempts');
    if (requestedDirectory && path.resolve(requestedDirectory) !== expected) throw fail('Fresh Reader candidates must stay inside the current run');
    return expected;
}

module.exports = { CONTRACT, CACHE_CONTRACT, BUNDLE_CACHE_CONTRACT, BUNDLE_SOURCE_MODE, DAILY_SOURCE_RUN_CONTRACT, isBundleExpectation,
    withFreshAnalysisContext, getFreshAnalysisContext, isDailyFreshSourceScope,
    getSavedAnalysisRecoveryPermission,
    readFreshSource, resolveFreshSource, fetchFreshSource, freshAnalysisIdentity, assertFreshPaper,
    withFreshPaperContext, attachFreshSourceRecord, freshReaderAttemptsDirectory };

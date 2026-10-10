'use strict';

// 给每份历史 arXiv 来源配的独立发布元数据附件，只和发布有关。
// 这些文件不改动任何来源 generation，
// 也不进入分析/模型输入。
// 每次读取都从原始官方 Atom 响应重新提取元数据，并核对它对应的那组四份来源文件。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const freshSource = require('./fresh-arxiv-rewrite-source.js');
const freshRun = require('./fresh-rewrite-run.js');
const metadataApi = require('./arxiv-metadata-source.js');

const CONTRACT = 'historical-arxiv-publication-metadata-v1';
const VERSION = 1;
const MANIFEST_NAME = 'metadata-manifest.json';
const METADATA_NAME = 'metadata.json';
const ATOM_NAME = 'metadata.atom.xml';
const FILES = Object.freeze([ATOM_NAME, MANIFEST_NAME, METADATA_NAME]);
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^\d{4}\.\d{4,5}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_ATOM_BYTES = metadataApi.MAX_BYTES;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

class HistoricalArxivPublicationMetadataError extends Error {
    constructor(message) {
        super(`历史 arXiv 发布元数据被拒绝：${message}`);
        this.name = 'HistoricalArxivPublicationMetadataError';
        this.code = 'HISTORICAL_ARXIV_PUBLICATION_METADATA_INTEGRITY';
        this.retryable = false;
    }
}
const fail = message => { throw new HistoricalArxivPublicationMetadataError(message); };

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}
const canonicalJson = value => `${JSON.stringify(canonical(value), null, 2)}\n`;
const exactKeys = (value, keys, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail(`${label} 的字段结构无效`);
};
function arxivId(value) {
    const id = String(value || '').trim().replace(/v\d+$/i, '');
    if (!ID_RE.test(id)) fail('arXiv ID 无效：移除版本号后，点号前须为四位数字，点号后须为四位或五位数字');
    return id;
}
function generationName(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 999999999) fail('获取序号 generation 必须是大于零且不超过 999999999 的安全整数');
    return `generation-${String(value).padStart(6, '0')}`;
}
function safeDirectory(directory, create = false, label = '目录') {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} 必须是绝对路径`);
    const absolute = path.resolve(directory); let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part); let stat;
        try { stat = fs.lstatSync(cursor); }
        catch (error) {
            if (error.code !== 'ENOENT' || !create) throw error;
            fs.mkdirSync(cursor, { mode: 0o700 }); stat = fs.lstatSync(cursor);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 不安全：必须是普通目录，不能是符号链接：${cursor}`);
    }
    return absolute;
}
function readPrivateFile(filename, maximum, label) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) fail(`${label} 不安全：必须是只有一个硬链接的普通文件，且字节数须在允许范围内`);
        if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fail(`${label} 权限必须为 0600`);
        return fs.readFileSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writePrivateFile(directory, name, bytes) {
    const target = path.join(directory, name); let fd;
    try {
        fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function fsyncDirectory(directory) {
    let fd;
    try { fd = fs.openSync(directory, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
    catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function sidecarDirectory(rootDir, id, generation) {
    return path.join(path.resolve(rootDir), arxivId(id), generationName(generation));
}
function sourceSnapshotSha(details) {
    return freshRun.stableHash({ paperId: details.paperId, source: details.source, sourceId: details.sourceId,
        textSha256: sha256(Buffer.from(details.text, 'utf8')), structuredArtifacts: details.structuredArtifacts,
        ...(details.sourceVersion ? { sourceVersion: details.sourceVersion } : {}) });
}
function normalizedOfficialResult(id, result) {
    if (!result || typeof result !== 'object' || !Buffer.isBuffer(result.rawBytes)
        && !(result.rawBytes instanceof Uint8Array)) fail('必须提供官方 Atom 提取结果及原始字节');
    const rawBytes = Buffer.from(result.rawBytes);
    if (rawBytes.length < 1 || rawBytes.length > MAX_ATOM_BYTES) fail('官方 Atom 响应为空或超过允许的字节数');
    const proof = result.proof;
    const querySourceId = proof?.querySourceId;
    const replayed = metadataApi.parseOfficialArxivMetadataResponse(id, rawBytes.toString('utf8'), { querySourceId });
    const observedAt = proof?.observedAt;
    if (!proof || proof.contract !== metadataApi.CONTRACT || proof.paperId !== `arxiv:${id}`
        || proof.sourceName !== replayed.proof.sourceName || proof.querySourceId !== replayed.proof.querySourceId
        || proof.fileSha256 !== sha256(rawBytes)
        || proof.recordSha256 !== freshRun.stableHash(replayed.metadata)
        || proof.entryVersion !== replayed.proof.entryVersion
        || proof.entryUpdatedAt !== replayed.proof.entryUpdatedAt
        || proof.publishedAt !== replayed.proof.publishedAt
        || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))
        || new Date(observedAt).toISOString() !== observedAt
        || freshRun.stableHash(result.metadata) !== freshRun.stableHash(replayed.metadata)) {
        fail('官方 Atom 提取结果或获取记录无法根据原始响应重新核对');
    }
    return { ...replayed, proof: { ...replayed.proof, observedAt } };
}
function sourceBinding(sourceRoot, id, generation) {
    const source = freshSource.readFreshArxivRewriteSource({ rootDir: sourceRoot, arxivId: id, generation });
    const timestamps = [source.manifest.capturedAt, source.manifest.text.fetchedAt, source.manifest.pdf.fetchedAt];
    const milliseconds = timestamps.map(value => new Date(value).getTime());
    if (milliseconds.some(value => !Number.isFinite(value))) fail('已封存来源的获取时间无效');
    const sourceVersionIdentitySha256 = source.runtimeDetails.sourceVersion?.identitySha256 || null;
    return { source,
        value: { contract: source.manifest.contract, version: source.manifest.version,
            generation, sourceManifestSha256: source.sourceManifestSha256,
            sourceSnapshotSha256: sourceSnapshotSha(source.runtimeDetails),
            sourceTextSha256: source.manifest.text.responseSha256, sourceId: source.manifest.text.sourceId,
            sourceCapturedAt: source.manifest.capturedAt, textFetchedAt: source.manifest.text.fetchedAt,
            pdfFetchedAt: source.manifest.pdf.fetchedAt,
            sourceEarliestCapturedAt: new Date(Math.min(...milliseconds)).toISOString(),
            sourceLatestCapturedAt: new Date(Math.max(...milliseconds)).toISOString(),
            ...(sourceVersionIdentitySha256 ? { sourceVersionIdentitySha256 } : {}) } };
}
function validateOfficialCompatibility({ sourceRoot, arxivId: value, generation, officialResult } = {}) {
    const id = arxivId(value);
    const source = sourceBinding(sourceRoot, id, generation).value;
    const official = normalizedOfficialResult(id, officialResult);
    if (Date.parse(official.proof.publishedAt) > Date.parse(official.proof.entryUpdatedAt)) {
        fail('官方 Atom 的发表时间晚于更新时间');
    }
    if (Date.parse(official.proof.entryUpdatedAt) > Date.parse(official.proof.observedAt)) {
        fail('官方 Atom 的更新时间晚于记录的获取时间');
    }
    if (Date.parse(official.proof.entryUpdatedAt) > Date.parse(source.sourceEarliestCapturedAt)) {
        fail('官方 Atom 条目比本组已封存来源更新；须重新抓取并封存下一获取序号的来源');
    }
    const sourceVersion = source.sourceId.match(/v([1-9]\d*)$/i);
    if (sourceVersion && Number(sourceVersion[1]) !== official.proof.entryVersion) {
        fail('官方 Atom 条目的版本与已封存来源指定的版本不同');
    }
    if (!sourceVersion && Date.parse(official.proof.observedAt) < Date.parse(source.sourceLatestCapturedAt)) {
        fail('官方 Atom 响应的获取时间早于不带版本号的已封存来源；须重新抓取官方元数据');
    }
    if (official.proof.querySourceId !== source.sourceId) {
        fail('官方 Atom 查询未对应已封存来源的确切来源 ID');
    }
    return { source, official };
}
function querySourceIdForSource({ sourceRoot, arxivId: value, generation } = {}) {
    const id = arxivId(value);
    return sourceBinding(sourceRoot, id, generation).value.sourceId;
}
function manifestFor({ id, generation, capturedAt, source, official, metadataBytes }) {
    const abstract = official.metadata.abstract;
    return { contract: CONTRACT, version: VERSION, paperId: `arxiv:${id}`, arxivId: id, generation,
        capturedAt: new Date(capturedAt).toISOString(), source,
        atom: { contract: metadataApi.CONTRACT, filename: ATOM_NAME, sourceName: official.proof.sourceName,
            querySourceId: official.proof.querySourceId,
            responseBytes: official.rawBytes.length, responseSha256: official.proof.fileSha256,
            entryVersion: official.proof.entryVersion, entryUpdatedAt: official.proof.entryUpdatedAt,
            publishedAt: official.proof.publishedAt, observedAt: official.proof.observedAt },
        metadata: { filename: METADATA_NAME, responseBytes: metadataBytes.length,
            responseSha256: sha256(metadataBytes), recordSha256: official.proof.recordSha256,
            abstractSha256: sha256(Buffer.from(abstract, 'utf8')) } };
}

function readPublicationMetadata({ rootDir, sourceRoot, arxivId: value, generation } = {}) {
    const id = arxivId(value); const directory = sidecarDirectory(safeDirectory(rootDir), id, generation);
    safeDirectory(path.join(path.resolve(rootDir), id), false, '发布元数据的论文目录');
    safeDirectory(directory, false, '发布元数据的获取序号目录');
    if (fs.readdirSync(directory).sort().join('\0') !== FILES.slice().sort().join('\0')) {
        fail('本获取序号的发布元数据目录中含额外文件');
    }
    const manifestBytes = readPrivateFile(path.join(directory, MANIFEST_NAME), MAX_JSON_BYTES, '发布元数据清单');
    const metadataBytes = readPrivateFile(path.join(directory, METADATA_NAME), MAX_JSON_BYTES, '发布元数据记录');
    const atomBytes = readPrivateFile(path.join(directory, ATOM_NAME), MAX_ATOM_BYTES, '发布元数据 Atom 响应');
    let manifest; let metadata;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); metadata = JSON.parse(metadataBytes.toString('utf8')); }
    catch (error) { fail(`发布元数据不是有效 JSON：${error.message}`); }
    if (!manifestBytes.equals(Buffer.from(canonicalJson(manifest)))
        || !metadataBytes.equals(Buffer.from(canonicalJson(metadata)))) fail('发布元数据 JSON 必须按固定的字段顺序和保存格式写入');
    exactKeys(manifest, ['contract', 'version', 'paperId', 'arxivId', 'generation', 'capturedAt', 'source', 'atom', 'metadata'], '元数据清单');
    const hasSourceVersion = Object.hasOwn(manifest.source || {}, 'sourceVersionIdentitySha256');
    exactKeys(manifest.source, ['contract', 'version', 'generation', 'sourceManifestSha256', 'sourceSnapshotSha256',
        'sourceTextSha256', 'sourceId', 'sourceCapturedAt', 'textFetchedAt', 'pdfFetchedAt',
        'sourceEarliestCapturedAt', 'sourceLatestCapturedAt',
        ...(hasSourceVersion ? ['sourceVersionIdentitySha256'] : [])], '来源对应记录');
    exactKeys(manifest.atom, ['contract', 'filename', 'sourceName', 'querySourceId', 'responseBytes', 'responseSha256',
        'entryVersion', 'entryUpdatedAt', 'publishedAt', 'observedAt'], 'Atom 对应记录');
    exactKeys(manifest.metadata, ['filename', 'responseBytes', 'responseSha256', 'recordSha256', 'abstractSha256'], '元数据对应记录');
    if (manifest.contract !== CONTRACT || manifest.version !== VERSION || manifest.paperId !== `arxiv:${id}`
        || manifest.arxivId !== id || manifest.generation !== generation
        || !Number.isFinite(Date.parse(manifest.capturedAt)) || new Date(manifest.capturedAt).toISOString() !== manifest.capturedAt
        || manifest.atom.contract !== metadataApi.CONTRACT || manifest.atom.filename !== ATOM_NAME
        || !Number.isSafeInteger(manifest.atom.entryVersion) || manifest.atom.entryVersion < 1
        || ![manifest.atom.entryUpdatedAt, manifest.atom.publishedAt, manifest.atom.observedAt,
            manifest.source.sourceCapturedAt, manifest.source.textFetchedAt, manifest.source.pdfFetchedAt,
            manifest.source.sourceEarliestCapturedAt, manifest.source.sourceLatestCapturedAt]
            .every(item => typeof item === 'string' && Number.isFinite(Date.parse(item))
                && new Date(item).toISOString() === item)
        || manifest.metadata.filename !== METADATA_NAME
        || ![manifest.source.sourceManifestSha256, manifest.source.sourceSnapshotSha256,
            manifest.source.sourceTextSha256, manifest.atom.responseSha256, manifest.metadata.responseSha256,
            manifest.metadata.recordSha256, manifest.metadata.abstractSha256].every(item => SHA_RE.test(String(item || '')))
        || manifest.atom.responseBytes !== atomBytes.length || manifest.atom.responseSha256 !== sha256(atomBytes)
        || manifest.metadata.responseBytes !== metadataBytes.length || manifest.metadata.responseSha256 !== sha256(metadataBytes)) {
        fail('发布元数据清单的字段、论文身份、字节数或 SHA 与记录不同');
    }
    if (Date.parse(manifest.capturedAt) < Date.parse(manifest.atom.observedAt)) {
        fail('发布元数据的封存时间早于官方 Atom 响应的获取时间');
    }
    const official = metadataApi.parseOfficialArxivMetadataResponse(id, atomBytes.toString('utf8'), {
        querySourceId: manifest.atom.querySourceId
    });
    if (official.proof.sourceName !== manifest.atom.sourceName
        || official.proof.querySourceId !== manifest.atom.querySourceId
        || official.proof.fileSha256 !== manifest.atom.responseSha256
        || official.proof.recordSha256 !== manifest.metadata.recordSha256
        || official.proof.entryVersion !== manifest.atom.entryVersion
        || official.proof.entryUpdatedAt !== manifest.atom.entryUpdatedAt
        || official.proof.publishedAt !== manifest.atom.publishedAt
        || freshRun.stableHash(metadata) !== freshRun.stableHash(official.metadata)
        || sha256(Buffer.from(metadata.abstract, 'utf8')) !== manifest.metadata.abstractSha256) {
        fail('发布元数据记录无法根据原始官方 Atom 响应重新核对');
    }
    const bound = sourceBinding(sourceRoot, id, generation).value;
    if (freshRun.stableHash(bound) !== freshRun.stableHash(manifest.source)) {
        fail('发布元数据不再对应这组已封存的来源文件');
    }
    if (Date.parse(manifest.atom.entryUpdatedAt) > Date.parse(bound.sourceEarliestCapturedAt)) {
        fail('官方 Atom 条目比本组已封存来源更新；须重新抓取并封存下一获取序号的来源');
    }
    if (Date.parse(manifest.atom.publishedAt) > Date.parse(manifest.atom.entryUpdatedAt)) {
        fail('官方 Atom 的发表时间晚于更新时间');
    }
    if (Date.parse(manifest.atom.entryUpdatedAt) > Date.parse(manifest.atom.observedAt)) {
        fail('官方 Atom 的更新时间晚于记录的获取时间');
    }
    const sourceVersion = bound.sourceId.match(/v([1-9]\d*)$/i);
    if (sourceVersion && Number(sourceVersion[1]) !== manifest.atom.entryVersion) {
        fail('官方 Atom 条目的版本与已封存来源指定的版本不同');
    }
    if (!sourceVersion && Date.parse(manifest.atom.observedAt) < Date.parse(bound.sourceLatestCapturedAt)) {
        fail('官方 Atom 响应的获取时间早于不带版本号的已封存来源；须重新抓取官方元数据');
    }
    if (manifest.atom.querySourceId !== bound.sourceId) {
        fail('官方 Atom 查询未对应已封存来源的确切来源 ID');
    }
    if (!Array.isArray(metadata.authors) || metadata.authors.length === 0
        || metadata.authors.some(author => typeof author !== 'string' || !author.trim())) {
        fail('发布元数据中的作者列表为空或含无效姓名');
    }
    // 前面已核对原始 Atom 响应、按固定格式保存的元数据、清单及已保存来源。
    // 旧官方 Atom 条目的 <name> 里可能留有首尾空白；
    // 只整理返回的作者视图，
    // 不改已保存的附带文件及其 SHA。
    const authors = metadata.authors.map(author => author.trim());
    return { directory, sourceManifestSha256: manifest.source.sourceManifestSha256,
        sourceSnapshotSha256: manifest.source.sourceSnapshotSha256,
        sourceTextSha256: manifest.source.sourceTextSha256, abstract: metadata.abstract,
        authors,
        proof: { contract: CONTRACT, paperId: `arxiv:${id}`, manifestSha256: sha256(manifestBytes),
            atomResponseSha256: manifest.atom.responseSha256,
            metadataRecordSha256: manifest.metadata.recordSha256, abstractSha256: manifest.metadata.abstractSha256,
            entryVersion: manifest.atom.entryVersion, entryUpdatedAt: manifest.atom.entryUpdatedAt,
            publishedAt: manifest.atom.publishedAt, observedAt: manifest.atom.observedAt,
            sourceName: manifest.atom.sourceName, querySourceId: manifest.atom.querySourceId,
            sourceManifestSha256: manifest.source.sourceManifestSha256,
            sourceSnapshotSha256: manifest.source.sourceSnapshotSha256,
            sourceTextSha256: manifest.source.sourceTextSha256, sourceId: manifest.source.sourceId,
            sourceCapturedAt: manifest.source.sourceCapturedAt,
            sourceEarliestCapturedAt: manifest.source.sourceEarliestCapturedAt,
            sourceLatestCapturedAt: manifest.source.sourceLatestCapturedAt,
            generation }, manifest, metadata };
}

function sealPublicationMetadata({ rootDir, sourceRoot, arxivId: value, generation,
    officialResult, now = new Date().toISOString() } = {}) {
    const id = arxivId(value); const root = safeDirectory(rootDir, true, '发布元数据根目录');
    const target = sidecarDirectory(root, id, generation);
    if (fs.existsSync(target)) return { ...readPublicationMetadata({ rootDir: root, sourceRoot, arxivId: id, generation }),
        status: 'recovered', fetched: false };
    const { source, official } = validateOfficialCompatibility({ sourceRoot, arxivId: id, generation, officialResult });
    const capturedAt = new Date(now).toISOString();
    if (capturedAt !== now || Date.parse(capturedAt) < Date.parse(official.proof.observedAt)) {
        fail('发布元数据的封存时间无效，或早于官方 Atom 响应的获取时间');
    }
    const paperDirectory = safeDirectory(path.join(root, id), true, '发布元数据的论文目录');
    const temporary = path.join(paperDirectory, `.${generationName(generation)}.${crypto.randomUUID()}.tmp`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    try {
        const metadataBytes = Buffer.from(canonicalJson(official.metadata));
        const manifest = manifestFor({ id, generation, capturedAt, source, official, metadataBytes });
        writePrivateFile(temporary, ATOM_NAME, official.rawBytes);
        writePrivateFile(temporary, METADATA_NAME, metadataBytes);
        writePrivateFile(temporary, MANIFEST_NAME, Buffer.from(canonicalJson(manifest)));
        fsyncDirectory(temporary);
        try { fs.renameSync(temporary, target); }
        catch (error) {
            if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        }
        fsyncDirectory(paperDirectory);
    } finally {
        if (fs.existsSync(temporary) && path.dirname(temporary) === paperDirectory
            && path.basename(temporary).startsWith(`.${generationName(generation)}.`)
            && path.basename(temporary).endsWith('.tmp')) fs.rmSync(temporary, { recursive: true, force: true });
    }
    return { ...readPublicationMetadata({ rootDir: root, sourceRoot, arxivId: id, generation }),
        status: 'sealed', fetched: true };
}

function reusableOfficialAtomIndex({ freshRewriteRoot, paperIds } = {}) {
    if (!Array.isArray(paperIds) || !paperIds.length || new Set(paperIds).size !== paperIds.length) {
        fail('待复用 Atom 响应的论文集合不能为空，且不能有重复项');
    }
    const selected = new Set(paperIds.map(arxivId));
    const root = safeDirectory(freshRewriteRoot, false, '重新分析运行目录');
    const candidates = new Map([...selected].map(id => [id, []]));
    for (const name of fs.readdirSync(root).filter(item => UUID_RE.test(item)).sort()) {
        const directory = path.join(root, name); const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const atomNames = fs.readdirSync(directory).filter(file => /^metadata-\d{4}\.\d{4,5}\.atom\.xml$/.test(file));
        for (const atomName of atomNames) {
            const id = atomName.slice('metadata-'.length, -'.atom.xml'.length);
            if (!selected.has(id)) continue;
            const atomFile = path.join(directory, atomName);
            try {
                const run = freshRun.readRegularJson(path.join(directory, 'run.json')).value;
                const inputs = freshRun.readRegularJson(path.join(directory, 'inputs.json')).value;
                const atom = readPrivateFile(atomFile, MAX_ATOM_BYTES, '可复用的官方 Atom 响应');
                const proof = run?.metadataSources?.historicalRawMetadata;
                const queryMatch = String(proof?.sourceName || '').match(/[?&]id_list=([^&]+)&max_results=1$/);
                if (!queryMatch) continue;
                const querySourceId = decodeURIComponent(queryMatch[1]);
                const parsed = metadataApi.parseOfficialArxivMetadataResponse(id, atom.toString('utf8'), { querySourceId });
                const paper = inputs?.papers?.find(item => String(item?.arxivId || item?.paper_id || '').replace(/v\d+$/i, '') === id);
                if (!proof || proof.contract !== metadataApi.CONTRACT || proof.paperId !== `arxiv:${id}`
                    || proof.sourceName !== parsed.proof.sourceName || proof.fileSha256 !== parsed.proof.fileSha256
                    || proof.recordSha256 !== parsed.proof.recordSha256
                    || freshRun.stableHash(paper) !== freshRun.stableHash(parsed.metadata)) continue;
                // 旧运行的 createdAt 不算新运行身份的一部分。
                // 仅查询指定的固定版本 vN 时，才可用它记录获取时间；不带版本号的候选须使用
                // 获取记录中保存的观察时间。
                const exactVersionQuery = /v[1-9]\d*$/i.test(querySourceId);
                const observedValue = proof.observedAt || (exactVersionQuery ? run?.createdAt : null);
                const observed = new Date(observedValue);
                if (!Number.isFinite(observed.getTime()) || observed.toISOString() !== observedValue) continue;
                const official = { ...parsed, proof: { ...parsed.proof, observedAt: observedValue } };
                candidates.get(id).push({ runId: name, official });
            } catch { /* 无效的保留运行不拿来复用 */ }
        }
    }
    const result = new Map();
    for (const [id, values] of candidates) {
        if (!values.length) continue;
        const identities = new Set(values.map(item => `${item.official.proof.recordSha256}\0${sha256(Buffer.from(item.official.metadata.abstract, 'utf8'))}`));
        if (identities.size !== 1) fail(`${id} 的可复用官方 Atom 响应对应不同的元数据或摘要`);
        result.set(id, { ...values[0].official, reusedFromRunId: values[0].runId });
    }
    return result;
}
function findReusableOfficialAtom({ freshRewriteRoot, arxivId: value } = {}) {
    const id = arxivId(value);
    return reusableOfficialAtomIndex({ freshRewriteRoot, paperIds: [id] }).get(id) || null;
}

module.exports = { CONTRACT, VERSION, MANIFEST_NAME, METADATA_NAME, ATOM_NAME,
    HistoricalArxivPublicationMetadataError, sidecarDirectory, sourceSnapshotSha,
    readPublicationMetadata, sealPublicationMetadata, validateOfficialCompatibility, querySourceIdForSource,
    reusableOfficialAtomIndex,
    findReusableOfficialAtom };

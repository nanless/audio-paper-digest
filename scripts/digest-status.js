const Config = require('./config.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Writable } = require('node:stream');
const {
    getBeijingISOString,
    normalizeToBeijingISOString,
    writeFileAtomic,
    normalizedId
} = require('./utils.js');
const {
    readJsonFileStrict,
    withFileLock,
    withFileLockSync,
    LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY,
    isSuccessfulAnalysisRecord,
    hasValidAnalysisBody
} = require('./analysis-engine.js');

const ANALYSIS_FIELDS = Object.freeze([
    'analysis',
    'parsed',
    'scoringRubricVersion',
    'selectedImageUrls',
    'imageUrls',
    'allImageUrls',
    'imageManifest',
    'analysisManifest',
    'analysisFactReviewObligation',
    'analysisSource',
    'sourceId',
    'sourceTextChars',
    'usedTextChars',
    'fullTextChars',
    'fullTextAvailable',
    'truncated',
    'sourceSha256',
    'usedTextSha256',
    'analysisConfidence',
    'htmlAvailability',
    'htmlAttempts',
    'sourceWarnings'
]);
const PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS = Object.freeze([
    'apiReaderPlan',
    'apiReaderFailedBundleHistory',
    'analysisStaleSnapshots',
    'apiReaderFigures',
    'apiReaderAuthors',
    'apiReaderResources',
    'readerRevisionHistory',
    'dailyScoringRefreshHistory',
    'fullStageReanalysis',
    'apiReaderSourceBindingEvidence',
    'apiReaderTableEvidence',
    'apiReaderFormulaEvidence',
    'manualArtifactIndex',
    'manualReaderLongform',
    'manualResultClaims',
    'manualReadabilityRubric',
    'manualIngestionCheckpoint'
]);
const PAPERS_BACKUP_CONTRACT = 'papers-backup-v1';
const PAPERS_BACKUP_MAX_GROUPS = 7;
const PAPERS_BACKUP_MAX_RAW_BYTES = 512 * 1024 * 1024;
const FAILURE_RECOVERY_FIELDS = Object.freeze([
    'analysisFactReviewObligation',
    'analysisRecoveryImageManifest',
    'analysisCheckpoint',
    'analysisStageCheckpoints',
    'latestAnalysisAttemptError',
    'latestAnalysisAttemptAt'
]);

function mergeSourcesField(target, first, second) {
    if (Array.isArray(first?.sources) || Array.isArray(second?.sources)) {
        target.sources = [...new Set([...(first?.sources || []), ...(second?.sources || [])])];
    }
    return target;
}

function clearFailureRecoveryFields(paper) {
    for (const field of FAILURE_RECOVERY_FIELDS) {
        delete paper[field];
    }
    return paper;
}

function isAnalysisFailureRecord(paper) {
    if (!paper || typeof paper !== 'object') return false;
    if (paper.digestStatus?.status === 'analysis_failed'
        || paper.digestStatus?.latestAttemptStatus === 'analysis_failed') {
        return true;
    }
    return Boolean(paper.error)
        && (paper.digestStatus?.latestAttemptStatus !== 'analyzed'
            || Boolean(paper.digestStatus?.error));
}

function stableJsonEqual(a, b) {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

function stripPapersLedgerEphemeralFields(paper) {
    if (!paper || typeof paper !== 'object' || Array.isArray(paper)) return paper;
    const cleaned = { ...paper };
    for (const field of PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(cleaned, field)) {
            delete cleaned[field];
        }
    }
    if (typeof cleaned.summary === 'string' && cleaned.summary === cleaned.abstract) {
        delete cleaned.summary;
    }
    return cleaned;
}

function serializePapersDatabase(data) {
    return JSON.stringify(data);
}

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function readGzipPayloadBounded(filePath, maxBytes) {
    const chunks = [];
    let bytes = 0;
    await pipeline(fs.createReadStream(filePath), zlib.createGunzip(), new Writable({
        write(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                const error = new Error(`论文库备份解压超过 ${maxBytes} 字节上限`);
                error.code = 'PAPERS_BACKUP_TOO_LARGE';
                callback(error);
                return;
            }
            chunks.push(chunk);
            callback();
        }
    }));
    return Buffer.concat(chunks, bytes);
}

async function fsyncDirectory(directory) {
    let handle;
    try {
        handle = await fs.promises.open(directory, 'r');
        await handle.sync();
    } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    } finally {
        await handle?.close();
    }
}

async function verifyPapersBackup(backupPath, options = {}) {
    const resolved = path.resolve(backupPath);
    if (resolved.endsWith('.json.gz')) {
        const manifestPath = options.manifestPath || `${resolved}.manifest.json`;
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        if (manifest.contract !== PAPERS_BACKUP_CONTRACT
            || manifest.backupFile !== path.basename(resolved)
            || !/^[a-f0-9]{64}$/.test(String(manifest.sourceSha256 || ''))
            || !/^[a-f0-9]{64}$/.test(String(manifest.compressedSha256 || ''))
            || !Number.isInteger(manifest.sourceBytes)
            || manifest.sourceBytes < 0
            || !Number.isInteger(manifest.compressedBytes)
            || manifest.compressedBytes < 0) {
            throw new Error(`论文库备份清单无效: ${manifestPath}`);
        }
        const compressed = await fs.promises.readFile(resolved);
        if (compressed.length !== manifest.compressedBytes
            || sha256Buffer(compressed) !== manifest.compressedSha256) {
            throw new Error(`论文库备份的压缩字节与清单不一致: ${resolved}`);
        }
        if (options.compressedOnly === true) {
            return { backupPath: resolved, manifestPath, manifest, data: null, sourceSha256: manifest.sourceSha256 };
        }
        const maxRawBytes = Math.min(
            Number.isInteger(options.maxRawBytes) ? options.maxRawBytes : PAPERS_BACKUP_MAX_RAW_BYTES,
            manifest.sourceBytes + 1
        );
        const raw = await readGzipPayloadBounded(resolved, maxRawBytes);
        if (raw.length !== manifest.sourceBytes || sha256Buffer(raw) !== manifest.sourceSha256) {
            throw new Error(`论文库备份的解压字节与清单不一致: ${resolved}`);
        }
        const parsed = JSON.parse(raw.toString('utf8'));
        validatePapersDatabaseSchema(parsed);
        return { backupPath: resolved, manifestPath, manifest, data: parsed, sourceSha256: manifest.sourceSha256 };
    }

    if (!resolved.endsWith('.json')) throw new Error(`不支持的论文库备份格式: ${resolved}`);
    const raw = await fs.promises.readFile(resolved);
    if (raw.length > (options.maxRawBytes || PAPERS_BACKUP_MAX_RAW_BYTES)) {
        throw new Error(`旧版论文库备份超过字节上限: ${resolved}`);
    }
    const parsed = JSON.parse(raw.toString('utf8'));
    validatePapersDatabaseSchema(parsed);
    return {
        backupPath: resolved,
        manifestPath: null,
        manifest: null,
        data: parsed,
        sourceSha256: sha256Buffer(raw)
    };
}

async function listValidManagedBackupGroups(archiveDir, options = {}) {
    let names = [];
    try {
        names = await fs.promises.readdir(archiveDir);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const preVerified = options.preVerified instanceof Map ? options.preVerified : null;
    const groups = [];
    for (const manifestName of names.filter(name => /^papers-\d{4}-\d{2}-\d{2}\.json\.gz\.manifest\.json$/.test(name))) {
        const manifestPath = path.join(archiveDir, manifestName);
        const backupPath = manifestPath.slice(0, -'.manifest.json'.length);
        const reused = preVerified?.get(backupPath);
        if (reused && reused.manifestPath === manifestPath) {
            groups.push(reused);
            continue;
        }
        try {
            const verified = await verifyPapersBackup(backupPath, {
                manifestPath,
                compressedOnly: options.compressedOnly === true
            });
            groups.push({
                backupPath,
                manifestPath,
                manifest: verified.manifest,
                createdAt: Date.parse(verified.manifest.createdAt) || 0
            });
        } catch (_) {
            // 损坏或不完整的备份组不参与去重和保留数量统计，也不会被自动删除。
        }
    }
    return groups.sort((a, b) => b.createdAt - a.createdAt || b.backupPath.localeCompare(a.backupPath));
}

async function pruneManagedBackupGroups(archiveDir, maxGroups = PAPERS_BACKUP_MAX_GROUPS, options = {}) {
    const groups = await listValidManagedBackupGroups(archiveDir, {
        preVerified: options.preVerified instanceof Map ? options.preVerified : undefined
    });
    const removed = [];
    for (const group of groups.slice(maxGroups)) {
        await fs.promises.unlink(group.manifestPath);
        await fs.promises.unlink(group.backupPath);
        removed.push(group.backupPath);
    }
    return removed;
}

async function backupPapersJson(papersFilePath, archiveDir, options = {}) {
    const sourcePath = path.resolve(papersFilePath);
    const targetDir = path.resolve(archiveDir);
    const date = options.date || getBeijingISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`论文库备份日期无效: ${date}`);
    if (!fs.existsSync(sourcePath)) return { backedUp: false, message: 'papers.json 不存在，无需备份' };

    return withFileLock(sourcePath, async () => {
        const sourceStat = await fs.promises.lstat(sourcePath);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
            throw new Error(`论文库备份源必须是普通文件: ${sourcePath}`);
        }
        const sourceRaw = await fs.promises.readFile(sourcePath);
        const sourceData = JSON.parse(sourceRaw.toString('utf8'));
        validatePapersDatabaseSchema(sourceData);
        const sourceSha256 = sha256Buffer(sourceRaw);
        const backupName = `papers-${date}.json.gz`;
        const backupPath = path.join(targetDir, backupName);
        const manifestPath = `${backupPath}.manifest.json`;
        await fs.promises.mkdir(targetDir, { recursive: true });

        const existingGroups = await listValidManagedBackupGroups(targetDir, { compressedOnly: true });
        const invalidBackupPaths = new Set();
        const sameDay = existingGroups.find(group => group.backupPath === backupPath);
        if (sameDay) {
            try {
                await verifyPapersBackup(sameDay.backupPath, { manifestPath: sameDay.manifestPath });
                return { backedUp: false, backupPath, manifestPath, message: `今日可验证备份已存在: ${backupName}` };
            } catch (_) {
                // 当日同名备份解压损坏时，不信任该条并继续创建/核验有效备份。
                invalidBackupPaths.add(sameDay.backupPath);
            }
        }
        for (const duplicate of existingGroups) {
            if (invalidBackupPaths.has(duplicate.backupPath) || duplicate.manifest.sourceSha256 !== sourceSha256) {
                continue;
            }
            try {
                await verifyPapersBackup(duplicate.backupPath, { manifestPath: duplicate.manifestPath });
                return {
                    backedUp: false,
                    duplicateOf: duplicate.backupPath,
                    sourceSha256,
                    message: `papers.json 与已验证备份相同，跳过重复压缩: ${path.basename(duplicate.backupPath)}`
                };
            } catch (_) {
                // 候选重复备份解压校验失败时，不信任该条也不将其计入有效保留组。
                invalidBackupPaths.add(duplicate.backupPath);
            }
        }

        const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
        const tempBackupPath = path.join(targetDir, `.${backupName}.${suffix}.tmp`);
        const tempManifestPath = path.join(targetDir, `.${path.basename(manifestPath)}.${suffix}.tmp`);
        let backupPublished = false;
        let manifestPublished = false;
        try {
            await pipeline(
                fs.createReadStream(sourcePath),
                zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED }),
                fs.createWriteStream(tempBackupPath, { mode: 0o600, flags: 'wx' })
            );
            const tempHandle = await fs.promises.open(tempBackupPath, 'r');
            try { await tempHandle.sync(); } finally { await tempHandle.close(); }
            const compressed = await fs.promises.readFile(tempBackupPath);
            const recovered = await readGzipPayloadBounded(tempBackupPath, sourceRaw.length + 1);
            if (recovered.length !== sourceRaw.length || sha256Buffer(recovered) !== sourceSha256) {
                throw new Error('论文库备份写入后解压所得内容的 SHA 与源文件不一致');
            }
            const manifest = {
                contract: PAPERS_BACKUP_CONTRACT,
                createdAt: options.createdAt || getBeijingISOString(),
                sourceFile: path.basename(sourcePath),
                backupFile: backupName,
                sourceBytes: sourceRaw.length,
                sourceSha256,
                compressedBytes: compressed.length,
                compressedSha256: sha256Buffer(compressed),
                compression: 'gzip'
            };
            await fs.promises.writeFile(tempManifestPath, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            const manifestHandle = await fs.promises.open(tempManifestPath, 'r');
            try { await manifestHandle.sync(); } finally { await manifestHandle.close(); }
            await fs.promises.rename(tempBackupPath, backupPath);
            backupPublished = true;
            await fsyncDirectory(targetDir);
            await options.hooks?.beforeManifestCommit?.({ backupPath, manifestPath });
            await fs.promises.rename(tempManifestPath, manifestPath);
            manifestPublished = true;
            await fsyncDirectory(targetDir);
            await verifyPapersBackup(backupPath, { manifestPath });
            const effectiveMaxGroups = Number.isInteger(options.maxGroups) && options.maxGroups > 0
                ? options.maxGroups
                : PAPERS_BACKUP_MAX_GROUPS;
            const candidateCount = existingGroups.filter(
                group => group.backupPath !== backupPath && !invalidBackupPaths.has(group.backupPath)
            ).length + 1;
            // 未超过保留上限时无需解压旧组；一旦超过上限，严格走完整解压校验后再统计与清理超额有效组。
            const removed = candidateCount > effectiveMaxGroups
                ? await pruneManagedBackupGroups(targetDir, effectiveMaxGroups, {
                    preVerified: new Map([[backupPath, {
                        backupPath,
                        manifestPath,
                        manifest,
                        createdAt: Date.parse(manifest.createdAt) || 0
                    }]])
                })
                : [];
            return {
                backedUp: true,
                backupPath,
                manifestPath,
                sourceSha256,
                compressedBytes: compressed.length,
                removed,
                message: `已创建并验证压缩备份: ${backupName}`
            };
        } catch (error) {
            await fs.promises.rm(tempBackupPath, { force: true });
            await fs.promises.rm(tempManifestPath, { force: true });
            if (backupPublished && !manifestPublished) await fs.promises.rm(backupPath, { force: true });
            if (manifestPublished) await fs.promises.rm(manifestPath, { force: true });
            if (manifestPublished) await fs.promises.rm(backupPath, { force: true });
            throw error;
        }
    });
}

function normalizeCompatibleBatchDate(value) {
    const rawValue = String(value || '').trim();
    const match = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|T|\s)/);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() !== year
        || candidate.getUTCMonth() !== month - 1
        || candidate.getUTCDate() !== day) return '';
    const datePrefix = match[0].slice(0, 10);
    if (rawValue === datePrefix) return datePrefix;

    // 旧数据中既有 ISO `T`，也有空格分隔的时间戳。只要末尾明确带时区，
    // 就必须先按真实瞬时时间换算到北京时间，不能直接截取原始日期前缀。
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawValue)) {
        const timestamp = rawValue.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
        const parsed = new Date(timestamp);
        if (Number.isNaN(parsed.getTime())) return '';
        return normalizeToBeijingISOString(parsed.toISOString()).slice(0, 10);
    }

    // 无显式时区的旧时间戳按历史本地（北京时间）语义兼容。
    return datePrefix;
}

function inferAnalysisBatchDate(papers, envelope = {}, fallbackTimestamp = getBeijingISOString()) {
    const records = (Array.isArray(papers) ? papers : [papers]).filter(Boolean);
    const candidateGroups = [
        records.map(paper => paper.fetchBatchDate),
        records.map(paper => paper.batchDate),
        records.map(paper => paper.digestStatus?.batchDate),
        [envelope?.batchDate],
        records.map(paper => paper.fetchedAt),
        [envelope?.timestamp, envelope?.lastUpdated, fallbackTimestamp]
    ];
    for (const candidates of candidateGroups) {
        for (const candidate of candidates) {
            const normalized = normalizeCompatibleBatchDate(candidate);
            if (normalized) return normalized;
        }
    }
    return normalizeCompatibleBatchDate(fallbackTimestamp) || getBeijingISOString().slice(0, 10);
}

function paperVersion(record, rawKey = '') {
    const rawId = record?.arxivId || record?.paper_id || rawKey;
    const match = String(rawId || '').match(/v(\d+)$/i);
    return match ? Number(match[1]) : 0;
}

function mergeVersionedPaperRecords(existing, incoming, existingRawKey, incomingRawKey) {
    const incomingIsNewer = paperVersion(incoming, incomingRawKey) >= paperVersion(existing, existingRawKey);
    const older = incomingIsNewer ? existing : incoming;
    const newer = incomingIsNewer ? incoming : existing;
    const newerIsFailure = isAnalysisFailureRecord(newer);
    const newerSucceeded = isSuccessfulAnalysisRecord(newer)
        || (!newerIsFailure && newer.digestStatus?.status === 'analyzed' && hasValidAnalysisBody(newer));

    let merged;
    if (newerIsFailure) {
        merged = mergeAnalysisDigestPaper(older, newer);
    } else if (newerSucceeded) {
        merged = { ...older, ...newer };
        clearFailureRecoveryFields(merged);
        delete merged.error;
    } else {
        // Non-failure version update (e.g. v2 metadata fetched while v1 is already analyzed):
        // preserve older valid analysis cleanly without synthesizing failure-recovery fields.
        merged = { ...older, ...newer };
        if (hasValidAnalysisBody(older)) {
            preserveAnalysisFields(merged, older);
            if (older.apiReaderArticle !== undefined && newer.apiReaderArticle === undefined) {
                merged.apiReaderArticle = older.apiReaderArticle;
            }
            if (older.freshRewriteProvenance !== undefined && newer.freshRewriteProvenance === undefined) {
                merged.freshRewriteProvenance = older.freshRewriteProvenance;
            }
        }
        if (older.digestStatus?.status === 'analyzed'
            && (!newer.digestStatus?.status || ['pending_analysis', 'seen'].includes(newer.digestStatus?.status))) {
            merged.digestStatus = older.digestStatus;
        }
    }
    if ((older.digestStatus?.updatedAt || '') > (newer.digestStatus?.updatedAt || '')) {
        merged.digestStatus = older.digestStatus;
    }
    mergeSourcesField(merged, older, newer);
    return stripPapersLedgerEphemeralFields(merged);
}

function normalizePapersMap(rawPapers, options = {}) {
    const strict = options.strict === true;
    if (rawPapers != null && !Array.isArray(rawPapers) && (typeof rawPapers !== 'object')) {
        throw new Error('papers.json 的 papers 必须是对象或数组');
    }
    if (strict && (Array.isArray(rawPapers) || rawPapers === null || typeof rawPapers !== 'object')) {
        throw new Error('papers.json 的 papers 必须是对象');
    }
    const papers = {};
    const rawKeys = {};
    const entries = Array.isArray(rawPapers)
        ? rawPapers.map(paper => [normalizedId(paper), paper])
        : Object.entries(rawPapers || {});
    for (const [rawKey, paper] of entries) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            if (strict) throw new Error(`papers.json 论文条目必须是对象: ${rawKey || '(空 key)'}`);
            continue;
        }
        const paperKey = normalizedId(paper);
        const objectKey = normalizedId(rawKey);
        if (paperKey && objectKey && paperKey !== objectKey) {
            throw new Error(`papers.json key 与论文版本 ID 冲突: ${rawKey} -> ${paperKey}`);
        }
        const key = paperKey || objectKey;
        if (!key) {
            if (strict) throw new Error(`papers.json 论文条目缺少有效 ID: ${rawKey || '(空 key)'}`);
            continue;
        }
        if (papers[key]) {
            papers[key] = mergeVersionedPaperRecords(papers[key], paper, rawKeys[key], rawKey);
            rawKeys[key] = paperVersion(paper, rawKey) >= paperVersion(papers[key], rawKeys[key])
                ? rawKey
                : rawKeys[key];
            continue;
        }
        papers[key] = paper;
        rawKeys[key] = rawKey;
    }
    return papers;
}

function normalizePapersDatabase(data) {
    if (Array.isArray(data)) return { papers: normalizePapersMap(data), lastUpdated: null, generation: 0 };
    const normalized = data && typeof data === 'object' ? { ...data } : { papers: {}, lastUpdated: null };
    normalized.papers = normalizePapersMap(normalized.papers);
    normalized.generation = Number.isInteger(normalized.generation) ? normalized.generation : 0;
    return normalized;
}

function validatePapersDatabaseSchema(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('papers.json 顶层必须是对象');
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'papers')) {
        throw new Error('papers.json 顶层缺少 papers 字段');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'generation')
        && (!Number.isInteger(data.generation) || data.generation < 0)) {
        throw new Error('papers.json generation 必须是非负整数');
    }
    return {
        ...data,
        papers: normalizePapersMap(data.papers, { strict: true }),
        generation: data.generation || 0
    };
}

function loadPapersDatabase(filePath = Config.FILES.papers, legacyPath = Config.FILES.papersLegacy) {
    let data = readJsonFileStrict(filePath, { allowMissing: true });
    if (data === null && legacyPath && fs.existsSync(legacyPath)) {
        data = readJsonFileStrict(legacyPath);
    }
    return normalizePapersDatabase(data || { papers: {}, lastUpdated: null });
}

function preserveAnalysisFields(target, source) {
    for (const field of ANALYSIS_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = source[field];
        else delete target[field];
    }
}

function mergePapersDatabases(currentData, incomingData) {
    const current = normalizePapersDatabase(currentData || { papers: {} });
    const incoming = normalizePapersDatabase(incomingData || { papers: {} });
    const merged = {
        ...current,
        ...incoming,
        generation: Math.max(current.generation, incoming.generation),
        papers: {}
    };

    for (const [key, currentPaper] of Object.entries(current.papers)) {
        merged.papers[key] = stripPapersLedgerEphemeralFields(currentPaper);
    }

    for (const [key, incomingPaper] of Object.entries(incoming.papers)) {
        const currentPaper = current.papers[key];
        if (!currentPaper) {
            merged.papers[key] = stripPapersLedgerEphemeralFields(incomingPaper);
            continue;
        }

        const currentStatus = currentPaper.digestStatus?.status;
        const incomingStatus = incomingPaper.digestStatus?.status;
        const currentUpdatedAt = currentPaper.digestStatus?.updatedAt || '';
        const incomingUpdatedAt = incomingPaper.digestStatus?.updatedAt || '';

        const isUnchangedRecord = currentUpdatedAt === incomingUpdatedAt
            && currentStatus === incomingStatus
            && currentPaper.digestStatus?.latestAttemptStatus === incomingPaper.digestStatus?.latestAttemptStatus
            && currentPaper.error === incomingPaper.error
            && currentPaper.analysis === incomingPaper.analysis
            && currentPaper.apiReaderArticle === incomingPaper.apiReaderArticle;
        const wouldDowngradeAnalyzed = currentStatus === 'analyzed'
            && (!incomingStatus || ['pending_analysis', 'seen'].includes(incomingStatus));

        if (isUnchangedRecord || wouldDowngradeAnalyzed || currentUpdatedAt > incomingUpdatedAt) {
            const preserved = mergeSourcesField({ ...currentPaper }, currentPaper, incomingPaper);
            merged.papers[key] = stripPapersLedgerEphemeralFields(preserved);
            continue;
        }

        const incomingIsFailure = isAnalysisFailureRecord(incomingPaper);
        const failureStateChanged = incomingStatus !== currentStatus
            || incomingPaper.digestStatus?.latestAttemptStatus !== currentPaper.digestStatus?.latestAttemptStatus
            || incomingPaper.error !== currentPaper.error
            || incomingPaper.digestStatus?.error !== currentPaper.digestStatus?.error;
        const isRealFailureUpdate = incomingIsFailure
            && (incomingUpdatedAt > currentUpdatedAt || failureStateChanged);

        if (isRealFailureUpdate) {
            const nextPaper = mergeAnalysisDigestPaper(currentPaper, incomingPaper);
            mergeSourcesField(nextPaper, currentPaper, incomingPaper);
            merged.papers[key] = stripPapersLedgerEphemeralFields(nextPaper);
            continue;
        }

        if (incomingStatus === 'analyzed' && !incomingIsFailure) {
            const hasUpdatedValidAnalysis = hasValidAnalysisBody(incomingPaper)
                && (incomingPaper.analysis !== currentPaper.analysis
                    || incomingPaper.apiReaderArticle !== currentPaper.apiReaderArticle
                    || !stableJsonEqual(incomingPaper.analysisManifest, currentPaper.analysisManifest)
                    || isSuccessfulAnalysisRecord(incomingPaper)
                    || (currentPaper.digestStatus?.latestAttemptStatus === 'analysis_failed'
                        && incomingPaper.digestStatus?.latestAttemptStatus === 'analyzed'));
            if (hasUpdatedValidAnalysis) {
                const updated = mergeSourcesField({ ...currentPaper, ...incomingPaper }, currentPaper, incomingPaper);
                clearFailureRecoveryFields(updated);
                delete updated.error;
                merged.papers[key] = stripPapersLedgerEphemeralFields(updated);
                continue;
            }
            if (currentStatus === 'analyzed') {
                const preserved = mergeSourcesField(
                    { ...currentPaper, digestStatus: incomingPaper.digestStatus },
                    currentPaper,
                    incomingPaper
                );
                if (hasValidAnalysisBody(currentPaper)) preserveAnalysisFields(preserved, currentPaper);
                merged.papers[key] = stripPapersLedgerEphemeralFields(preserved);
                continue;
            }
        }

        const nextPaper = mergeAnalysisDigestPaper(currentPaper, incomingPaper);
        mergeSourcesField(nextPaper, currentPaper, incomingPaper);
        merged.papers[key] = stripPapersLedgerEphemeralFields(nextPaper);
    }
    return merged;
}

function savePapersDatabase(data, filePath = Config.FILES.papers) {
    return withFileLockSync(filePath, () => {
        const currentRaw = readJsonFileStrict(filePath, { allowMissing: true });
        const current = currentRaw === null ? normalizePapersDatabase({ papers: {} }) : normalizePapersDatabase(currentRaw);
        const saved = mergePapersDatabases(current, data);
        saved.lastUpdated = getBeijingISOString();
        saved.generation = current.generation + 1;
        writeFileAtomic(filePath, serializePapersDatabase(saved), { mode: 0o600 });
        Object.assign(data, saved);
        return saved;
    });
}

function markPaperDigestStatus(paper, status, extra = {}) {
    const updatedAt = extra.updatedAt || getBeijingISOString();
    return {
        ...paper,
        digestStatus: {
            ...(paper.digestStatus || {}),
            status,
            updatedAt,
            ...extra
        }
    };
}

function mergeAnalysisDigestPaper(existing, paper) {
    const successful = isSuccessfulAnalysisRecord(paper);
    return mergeQualifiedAnalysisDigestPaper(existing, paper, successful,
        !successful && hasValidAnalysisBody(existing));
}

// Reuse this element's actual qualification within one synchronous update.
// This helper stays private: callers cannot supply a claimed success result.
function mergeQualifiedAnalysisDigestPaper(existing, paper, successful, hadUsableAnalysis) {
    const merged = { ...existing, ...paper };
    if (hadUsableAnalysis && !successful) {
        preserveAnalysisFields(merged, existing);
        if (paper.analysisManifest) merged.analysisManifest = paper.analysisManifest;
        if (typeof paper.analysisCheckpoint === 'string') merged.analysisCheckpoint = paper.analysisCheckpoint;
        if (paper.analysisStageCheckpoints) merged.analysisStageCheckpoints = paper.analysisStageCheckpoints;
        if (paper.analysisFactReviewObligation) merged.analysisFactReviewObligation = paper.analysisFactReviewObligation;
        if (paper.imageManifest) merged.analysisRecoveryImageManifest = paper.imageManifest;
        merged.latestAnalysisAttemptError = paper.error || '分析未完成';
        merged.latestAnalysisAttemptAt = getBeijingISOString();
    } else if (successful) {
        delete merged.analysisFactReviewObligation;
        delete merged.analysisRecoveryImageManifest;
        delete merged.analysisCheckpoint;
        delete merged.analysisStageCheckpoints;
        delete merged.latestAnalysisAttemptError;
        delete merged.latestAnalysisAttemptAt;
    }
    return stripPapersLedgerEphemeralFields(merged);
}

function applyAnalysisDigestStatuses(papersData, analyzedPapers, options = {}) {
    const now = options.updatedAt || getBeijingISOString();
    const batchDate = normalizeCompatibleBatchDate(options.batchDate)
        || normalizeCompatibleBatchDate(now)
        || getBeijingISOString().slice(0, 10);
    let updated = 0;

    for (const paper of analyzedPapers || []) {
        const key = normalizedId(paper);
        if (!key) continue;
        const existing = papersData.papers[key] || {};
        const successful = isSuccessfulAnalysisRecord(paper);
        const hadUsableAnalysis = !successful && hasValidAnalysisBody(existing);
        const mergedPaper = mergeQualifiedAnalysisDigestPaper(existing, paper, successful, hadUsableAnalysis);
        const latestAttemptStatus = successful ? 'analyzed' : 'analysis_failed';
        const status = (successful || hadUsableAnalysis) ? 'analyzed' : 'analysis_failed';
        papersData.papers[key] = markPaperDigestStatus(
            mergedPaper,
            status,
            {
                batchDate,
                updatedAt: now,
                latestAttemptStatus,
                error: paper.error || null
            }
        );
        updated++;
    }

    return updated;
}

function updateAnalysisDigestStatuses(analyzedPapers, options = {}) {
    const filePath = options.filePath || Config.FILES.papers;
    return withFileLockSync(filePath, () => {
        let raw = readJsonFileStrict(filePath, { allowMissing: true });
        if (raw === null && options.legacyPath && fs.existsSync(options.legacyPath)) {
            raw = readJsonFileStrict(options.legacyPath);
        } else if (raw === null && !options.filePath && fs.existsSync(Config.FILES.papersLegacy)) {
            raw = readJsonFileStrict(Config.FILES.papersLegacy);
        }
        const papersData = normalizePapersDatabase(raw || { papers: {}, lastUpdated: null });
        const updated = applyAnalysisDigestStatuses(papersData, analyzedPapers, options);
        if (updated > 0) {
            papersData.lastUpdated = options.updatedAt || getBeijingISOString();
            papersData.generation = (papersData.generation || 0) + 1;
            writeFileAtomic(filePath, serializePapersDatabase(papersData), { mode: 0o600 });
        }
        return { updated, papersData };
    }, { recoveryPolicy: LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}

// 只补论文库中未同步的成功状态；先锁规范论文ID，再读取正式结果，避免陈旧成功覆盖新失败。
async function synchronizeCompletedAnalysisDigestStatuses(resultPath, entryPlan, options = {}) {
    const engine = require('./analysis-engine');
    const daily = require('./lib/daily-fresh-source-plan');
    const filePath = options.filePath || Config.FILES.papers;
    const needsSync = (database, id) => {
        const status = database.papers[id]?.digestStatus;
        return status?.status !== 'analyzed'
            || status?.latestAttemptStatus !== undefined && status.latestAttemptStatus !== 'analyzed';
    };
    const collectIds = () => {
        const initial = readJsonFileStrict(resultPath);
        const database = loadPapersDatabase(filePath, options.legacyPath || Config.FILES.papersLegacy);
        const initialPapers = Array.isArray(initial) ? initial : initial.papers || [];
        return [...new Set(initialPapers.filter(paper => needsSync(database, normalizedId(paper))
            && isSuccessfulAnalysisRecord(paper)).map(normalizedId))].sort();
    };
    // 等待论文锁时只保留ID，不让完整论文库与锁内的新读副本同时存活。
    const ids = collectIds();
    if (!ids.length) return { updated: 0 };
    const synchronizeLocked = () => withFileLockSync(filePath, () => {
        const latest = readJsonFileStrict(resultPath);
        const plan = daily.requireFinalDailyFreshSourceRecoveryPlan(latest, { entryPlan,
            label: '成功分析状态同步' });
        const currentDatabase = loadPapersDatabase(filePath, options.legacyPath || Config.FILES.papersLegacy);
        const targets = new Set(ids);
        const currentPapers = Array.isArray(latest) ? latest : latest.papers || [];
        const completed = currentPapers.filter(paper => targets.has(normalizedId(paper))
            && needsSync(currentDatabase, normalizedId(paper))
            && isSuccessfulAnalysisRecord(paper)
            && daily.isPaperReusableForAnalysis(paper, plan));
        const updated = applyAnalysisDigestStatuses(currentDatabase, completed, {
            ...options, batchDate: options.batchDate || plan.batchDate
        });
        if (updated) {
            currentDatabase.lastUpdated = options.updatedAt || getBeijingISOString();
            currentDatabase.generation = (currentDatabase.generation || 0) + 1;
            writeFileAtomic(filePath, serializePapersDatabase(currentDatabase), { mode: 0o600 });
        }
        return { updated };
    }, { recoveryPolicy: LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
    const lockNext = index => index === ids.length ? synchronizeLocked()
        : engine.withPaperAnalysisLock({ arxivId: ids[index] }, () => lockNext(index + 1));
    return lockNext(0);
}

module.exports = {
    PAPERS_LEDGER_STRIP_ON_WRITE_FIELDS,
    stripPapersLedgerEphemeralFields,
    normalizeCompatibleBatchDate,
    inferAnalysisBatchDate,
    loadPapersDatabase,
    normalizePapersMap,
    normalizePapersDatabase,
    validatePapersDatabaseSchema,
    mergePapersDatabases,
    savePapersDatabase,
    markPaperDigestStatus,
    mergeAnalysisDigestPaper,
    applyAnalysisDigestStatuses,
    updateAnalysisDigestStatuses,
    synchronizeCompletedAnalysisDigestStatuses,
    serializePapersDatabase,
    backupPapersJson,
    verifyPapersBackup,
    listValidManagedBackupGroups,
    pruneManagedBackupGroups,
    PAPERS_BACKUP_CONTRACT,
    PAPERS_BACKUP_MAX_RAW_BYTES
};

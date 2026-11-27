'use strict';

// Leaf module for atomic, gzip-verified papers.json backups.
// Depends only on the zero-dep leaf ./file-lock.js: breaks the utils.js <-> digest-status.js
// cycle while sharing 100% identical hardened directory locks (${path}.lock) with analysis-engine.js.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
const { withFileLock } = require('./file-lock.js');

const PAPERS_BACKUP_CONTRACT = 'papers-backup-v1';
const PAPERS_BACKUP_MAX_GROUPS = 7;
const PAPERS_BACKUP_MAX_RAW_BYTES = 512 * 1024 * 1024;

function getBeijingISOString(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        fractionalSecondDigits: 3
    });
    const parts = formatter.formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${get('fractionalSecond') || '000'}+08:00`;
}

function normalizedPaperId(paperOrId) {
    if (paperOrId == null) return '';
    if (typeof paperOrId === 'string') {
        return paperOrId.replace(/v\d+$/, '').trim().toLowerCase();
    }
    const id = paperOrId.paper_id || paperOrId.arxivId || paperOrId.id || '';
    return String(id).replace(/v\d+$/, '').trim().toLowerCase();
}

function validatePapersBackupSchema(data) {
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
    const rawPapers = data.papers;
    if (Array.isArray(rawPapers) || rawPapers === null || typeof rawPapers !== 'object') {
        throw new Error('papers.json 的 papers 必须是对象');
    }
    for (const [rawKey, paper] of Object.entries(rawPapers)) {
        if (!paper || typeof paper !== 'object' || Array.isArray(paper)) {
            throw new Error(`papers.json 论文条目必须是对象: ${rawKey || '(空 key)'}`);
        }
        const paperKey = normalizedPaperId(paper);
        const objectKey = normalizedPaperId(rawKey);
        if (paperKey && objectKey && paperKey !== objectKey) {
            throw new Error(`papers.json key 与论文版本 ID 冲突: ${rawKey} -> ${paperKey}`);
        }
        if (!(paperKey || objectKey)) {
            throw new Error(`papers.json 论文条目缺少有效 ID: ${rawKey || '(空 key)'}`);
        }
    }
    return data;
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
        validatePapersBackupSchema(parsed);
        return { backupPath: resolved, manifestPath, manifest, data: parsed, sourceSha256: manifest.sourceSha256 };
    }

    if (!resolved.endsWith('.json')) throw new Error(`不支持的论文库备份格式: ${resolved}`);
    const raw = await fs.promises.readFile(resolved);
    if (raw.length > (options.maxRawBytes || PAPERS_BACKUP_MAX_RAW_BYTES)) {
        throw new Error(`旧版论文库备份超过字节上限: ${resolved}`);
    }
    const parsed = JSON.parse(raw.toString('utf8'));
    validatePapersBackupSchema(parsed);
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

    const lockRunner = typeof options.lockFn === 'function'
        ? options.lockFn
        : (filePath, fn) => withFileLock(filePath, fn, options.lockOptions);
    return lockRunner(sourcePath, async () => {
        const sourceStat = await fs.promises.lstat(sourcePath);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
            throw new Error(`论文库备份源必须是普通文件: ${sourcePath}`);
        }
        const sourceRaw = await fs.promises.readFile(sourcePath);
        const sourceData = JSON.parse(sourceRaw.toString('utf8'));
        validatePapersBackupSchema(sourceData);
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

module.exports = {
    PAPERS_BACKUP_CONTRACT,
    PAPERS_BACKUP_MAX_GROUPS,
    PAPERS_BACKUP_MAX_RAW_BYTES,
    validatePapersBackupSchema,
    verifyPapersBackup,
    listValidManagedBackupGroups,
    pruneManagedBackupGroups,
    backupPapersJson
};

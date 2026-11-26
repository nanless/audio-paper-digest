'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { relocatePathWithinRoot } = require('./repo-rename-path');

const UUID_FILE_RE = /^[a-f0-9-]{36}\.json$/;
const SHARD_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

function hasUnsafePathSegments(value) {
    return typeof value !== 'string' || !value || value.includes('\0')
        || value.split(/[\\/]/).includes('..');
}

function lstatIfPresent(target) {
    try {
        return fs.lstatSync(target);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function resolveCandidateInsideUsageDir(filePath, usageDir) {
    if (hasUnsafePathSegments(filePath) || hasUnsafePathSegments(usageDir)) return null;
    const root = path.resolve(usageDir);
    const resolved = path.isAbsolute(filePath)
        ? (relocatePathWithinRoot(filePath, root) || path.resolve(filePath))
        : path.resolve(filePath);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    if (parts.length === 1) {
        if (!UUID_FILE_RE.test(parts[0])) return null;
    } else if (parts.length === 2) {
        if (!SHARD_DIR_RE.test(parts[0]) || !UUID_FILE_RE.test(parts[1])) return null;
    } else {
        return null;
    }
    return { root, resolved, parts };
}

/**
 * Returns true iff filePath is `<usageDir>/<uuid>.json` or
 * `<usageDir>/YYYY-MM-DD/<uuid>.json`, with no `..`/symlinks and
 * resolved inside `usageDir` (supporting pre-rename repo relocation).
 */
function isUsageLedgerFile(filePath, usageDir) {
    const parsed = resolveCandidateInsideUsageDir(filePath, usageDir);
    if (!parsed) return false;
    const { root, resolved, parts } = parsed;
    try {
        const rootStat = lstatIfPresent(root);
        if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) return false;
        if (parts.length === 2) {
            const shardStat = lstatIfPresent(path.join(root, parts[0]));
            if (shardStat && (shardStat.isSymbolicLink() || !shardStat.isDirectory())) return false;
        }
        const fileStat = lstatIfPresent(resolved);
        if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) return false;
    } catch {
        return false;
    }
    return true;
}

/**
 * Lists all valid usage ledger files under `usageDir`, covering both flat
 * `<usageDir>/<uuid>.json` and sharded `<usageDir>/YYYY-MM-DD/<uuid>.json`.
 * Rejects symlinks or non-regular entries matching ledger/shard names.
 */
function listUsageLedgerFiles(usageDir) {
    if (hasUnsafePathSegments(usageDir)) {
        throw new Error('用量目录路径无效');
    }
    const root = path.resolve(usageDir);
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error('用量目录必须是真实目录，不能是符号链接');
    }
    const results = [];
    const rootEntries = fs.readdirSync(root, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of rootEntries) {
        if (UUID_FILE_RE.test(entry.name)) {
            const fullPath = path.join(root, entry.name);
            const stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new Error('正常费用记录必须是普通文件，不能是符号链接或目录');
            }
            results.push({ file: fullPath, name: entry.name, relativePath: entry.name });
            continue;
        }
        if (SHARD_DIR_RE.test(entry.name)) {
            const shardPath = path.join(root, entry.name);
            const shardStat = fs.lstatSync(shardPath);
            if (shardStat.isSymbolicLink() || !shardStat.isDirectory()) {
                throw new Error('用量日期分片目录必须是真实目录，不能是符号链接');
            }
            const shardEntries = fs.readdirSync(shardPath, { withFileTypes: true })
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const subEntry of shardEntries) {
                if (!UUID_FILE_RE.test(subEntry.name)) continue;
                const subPath = path.join(shardPath, subEntry.name);
                const subStat = fs.lstatSync(subPath);
                if (subStat.isSymbolicLink() || !subStat.isFile()) {
                    throw new Error('正常费用记录必须是普通文件，不能是符号链接或目录');
                }
                results.push({
                    file: subPath,
                    name: subEntry.name,
                    relativePath: `${entry.name}/${subEntry.name}`
                });
            }
        }
    }
    return results;
}

function findUniqueShardFileByBasename(root, uuidName) {
    const rootStat = lstatIfPresent(root);
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const matches = [];
    const entries = fs.readdirSync(root, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
        if (!SHARD_DIR_RE.test(entry.name)) continue;
        const shardPath = path.join(root, entry.name);
        const shardStat = lstatIfPresent(shardPath);
        if (!shardStat || shardStat.isSymbolicLink() || !shardStat.isDirectory()) return null;
        const candidate = path.join(shardPath, uuidName);
        const fileStat = lstatIfPresent(candidate);
        if (!fileStat) continue;
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
        matches.push(candidate);
    }
    return matches.length === 1 ? matches[0] : null;
}

/**
 * Resolves a usage ledger reference (`<uuid>.json`, `YYYY-MM-DD/<uuid>.json`,
 * or an absolute path inside `usageDir` / relocated pre-rename repo root).
 * When a flat `<uuid>.json` does not exist at root, searches `YYYY-MM-DD/`
 * subdirectories for a unique exact filename match.
 * Returns the resolved real regular file path or `null` if invalid/missing/ambiguous.
 */
function resolveUsageLedgerFile(usageDir, refNameOrPath) {
    if (hasUnsafePathSegments(usageDir) || hasUnsafePathSegments(refNameOrPath)) return null;
    const root = path.resolve(usageDir);
    let rootStat;
    try {
        rootStat = lstatIfPresent(root);
    } catch {
        return null;
    }
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;

    if (path.isAbsolute(refNameOrPath)) {
        const parsed = resolveCandidateInsideUsageDir(refNameOrPath, root);
        if (!parsed) return null;
        const { resolved, parts } = parsed;
        if (parts.length === 2) {
            try {
                const shardStat = lstatIfPresent(path.join(root, parts[0]));
                if (!shardStat || shardStat.isSymbolicLink() || !shardStat.isDirectory()) return null;
                const fileStat = lstatIfPresent(resolved);
                if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
                return resolved;
            } catch {
                return null;
            }
        }
        // Flat absolute path `<usageDir>/<uuid>.json`: check root first, then shard fallback.
        try {
            const directStat = lstatIfPresent(resolved);
            if (directStat) {
                return (!directStat.isSymbolicLink() && directStat.isFile()) ? resolved : null;
            }
            return findUniqueShardFileByBasename(root, parts[0]);
        } catch {
            return null;
        }
    }

    if (refNameOrPath.includes('\\')) return null;
    const parts = refNameOrPath.split('/');
    if (parts.length === 1 && UUID_FILE_RE.test(parts[0])) {
        const direct = path.join(root, parts[0]);
        try {
            const directStat = lstatIfPresent(direct);
            if (directStat) {
                return (!directStat.isSymbolicLink() && directStat.isFile()) ? direct : null;
            }
            return findUniqueShardFileByBasename(root, parts[0]);
        } catch {
            return null;
        }
    }
    if (parts.length === 2 && SHARD_DIR_RE.test(parts[0]) && UUID_FILE_RE.test(parts[1])) {
        const shardPath = path.join(root, parts[0]);
        const candidate = path.join(shardPath, parts[1]);
        try {
            const shardStat = lstatIfPresent(shardPath);
            if (!shardStat || shardStat.isSymbolicLink() || !shardStat.isDirectory()) return null;
            const fileStat = lstatIfPresent(candidate);
            if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
            return candidate;
        } catch {
            return null;
        }
    }
    return null;
}

module.exports = {
    UUID_FILE_RE,
    SHARD_DIR_RE,
    isUsageLedgerFile,
    listUsageLedgerFiles,
    resolveUsageLedgerFile
};

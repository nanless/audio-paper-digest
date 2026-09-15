#!/usr/bin/env node
'use strict';

/**
 * Read-only maintenance diagnostics for the daily conference workspace.
 *
 * This file deliberately does not load the project environment through
 * env-loader: that compatibility path chmods .env. It reads only the two
 * repository path values needed for display, and never emits their values.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireExternalRuntime } = require('./env-loader.js');
const { treeStats } = require('./runtime-storage.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_ENV_BYTES = 4 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const PROCESS_STATES = new Set(['pending', 'running', 'partial', 'complete']);
const ITEM_STATES = new Set(['pending', 'source_sealed', 'analyzing', 'analysis_partial', 'complete']);
const PROCESS_CONTRACT = 'conference-process-v1';
const PROCESS_VERSION = 1;
const UUID_RE = /^[a-f0-9-]{36}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function expandHome(value) {
    const text = String(value || '').trim();
    if (text === '~') return os.homedir();
    if (text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
    return text;
}

function readTextFile(filename, maxBytes, label) {
    let named;
    try { named = fs.lstatSync(filename); }
    catch (error) {
        if (error.code === 'ENOENT') return { missing: true };
        return { error: `${label}_unreadable` };
    }
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > maxBytes) {
        return { error: `${label}_unsafe` };
    }
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | NOFOLLOW);
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino) {
            return { error: `${label}_changed` };
        }
        const text = fs.readFileSync(fd, 'utf8');
        const after = fs.fstatSync(fd);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
            return { error: `${label}_changed` };
        }
        return { text };
    } catch (_) {
        return { error: `${label}_unreadable` };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function parseEnvDefinitions(envFile) {
    const loaded = readTextFile(envFile, MAX_ENV_BYTES, 'env');
    if (loaded.missing) return { exists: false, definitions: new Map(), error: null };
    if (loaded.error) return { exists: true, definitions: new Map(), error: loaded.error };
    const definitions = new Map();
    loaded.text.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) return;
        const key = match[1];
        const entry = definitions.get(key) || { key, lines: [], rawValue: match[2].trim() };
        entry.lines.push(index + 1);
        entry.rawValue = match[2].trim();
        definitions.set(key, entry);
    });
    return { exists: true, definitions, error: null };
}

function envValue(envFile, key) {
    const parsed = parseEnvDefinitions(envFile);
    return parsed.definitions.get(key)?.rawValue?.replace(/^(["'])([\s\S]*)\1$/, '$2');
}

function inspectEnvDuplicates(envFile = path.join(PROJECT_ROOT, '.env')) {
    const parsed = parseEnvDefinitions(envFile);
    const duplicates = [...parsed.definitions.values()]
        .filter(item => item.lines.length > 1)
        .map(item => ({ key: item.key, lines: item.lines.slice() }))
        .sort((a, b) => a.key.localeCompare(b.key));
    return {
        path: path.resolve(envFile),
        exists: parsed.exists,
        duplicateCount: duplicates.length,
        duplicates,
        error: parsed.error
    };
}

function defaultWorkspacePaths(projectRoot = PROJECT_ROOT) {
    const root = path.resolve(projectRoot);
    const envFile = path.join(root, '.env');
    const blog = envValue(envFile, 'PAPER_DIGEST_BLOG_REPO')
        || process.env.PAPER_DIGEST_BLOG_REPO
        || path.join(os.homedir(), 'code', 'github_repos', 'audio-paper-digest-blog');
    const image = envValue(envFile, 'PAPER_DIGEST_IMAGE_REPO')
        || process.env.PAPER_DIGEST_IMAGE_REPO
        || path.join(os.homedir(), 'code', 'github_repos', 'audio-paper-digest-images');
    return {
        codeRepo: root,
        blogRepo: path.resolve(expandHome(blog)),
        imageRepo: path.resolve(expandHome(image)),
        dataRoot: path.join(root, 'data'),
        processRoot: path.join(root, 'data', 'runtime', 'conference-processes')
    };
}

function parseGitStatus(output) {
    const branchLine = output.split('\n').find(line => line.startsWith('## ')) || null;
    const branch = branchLine ? branchLine.slice(3) : null;
    const files = [];
    for (const line of output.split('\n')) {
        if (!line || line.startsWith('## ') || line.length < 3) continue;
        const indexStatus = line[0];
        const worktreeStatus = line[1];
        if (line[2] !== ' ') continue;
        const rawPath = line.slice(3);
        const renameParts = rawPath.split(' -> ');
        const record = {
            status: `${indexStatus}${worktreeStatus}`,
            path: renameParts.at(-1),
            staged: indexStatus !== ' ' && indexStatus !== '?',
            worktree: worktreeStatus !== ' ' && worktreeStatus !== '?',
            untracked: indexStatus === '?' && worktreeStatus === '?'
        };
        if (renameParts.length === 2) record.previousPath = renameParts[0];
        files.push(record);
    }
    return { branch, files };
}

function runGit(repo, args) {
    const result = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 2 * 1024 * 1024
    });
    return { status: result.status, stdout: result.stdout || '', error: result.error || null };
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function stableHash(value) {
    return require('node:crypto').createHash('sha256')
        .update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function deterministicUuid(...parts) {
    const bytes = require('node:crypto').createHash('sha256')
        .update(parts.join('\0'), 'utf8').digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stateDigest(state) {
    const body = JSON.parse(JSON.stringify(state));
    delete body.stateSha256;
    return stableHash(body);
}

function inspectGitRepository(label, repoPath, options = {}) {
    const resolved = path.resolve(repoPath);
    const result = { label, path: resolved, state: 'missing', branch: null, head: null, dirty: null, files: [] };
    let stat;
    try { stat = fs.lstatSync(resolved); }
    catch (error) {
        if (error.code !== 'ENOENT') result.state = 'unreadable';
        return result;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.state = 'unsafe';
        return result;
    }
    const git = options.runGit || runGit;
    const status = git(resolved, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
    if (!status || status.error || status.status !== 0) {
        result.state = 'not-a-git-worktree';
        return result;
    }
    const parsed = parseGitStatus(status.stdout);
    result.state = 'ok';
    result.branch = parsed.branch;
    result.files = parsed.files;
    result.dirty = parsed.files.length > 0;
    const head = git(resolved, ['rev-parse', 'HEAD']);
    if (head && !head.error && head.status === 0) result.head = head.stdout.trim() || null;
    return result;
}

function probePid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        return null;
    }
}

function inspectProcessLock(processDir, options = {}) {
    const hostname = options.hostname || os.hostname();
    const pidProbe = options.pidProbe || probePid;
    const candidates = [path.join(processDir, '.operation.lock'), path.join(processDir, '.operation')];
    let found = null;
    for (const lockPath of candidates) {
        let stat;
        try { stat = fs.lstatSync(lockPath); }
        catch (error) {
            if (error.code === 'ENOENT') continue;
            return { path: lockPath, exists: true, active: false, valid: false, reason: 'lock_unreadable' };
        }
        found = lockPath;
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return { path: lockPath, exists: true, active: false, valid: false, reason: 'unsafe_lock' };
        }
        const ownerFile = path.join(lockPath, 'owner.json');
        const loaded = readTextFile(ownerFile, 64 * 1024, 'owner');
        if (!loaded.text) return { path: lockPath, exists: true, active: false, valid: false, reason: loaded.error || 'missing_owner' };
        let owner;
        try { owner = JSON.parse(loaded.text); } catch (_) {
            return { path: lockPath, exists: true, active: false, valid: false, reason: 'invalid_owner_json' };
        }
        const validOwner = owner && typeof owner === 'object' && !Array.isArray(owner)
            && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string';
        if (!validOwner) return { path: lockPath, exists: true, active: false, valid: false, reason: 'invalid_owner_schema' };
        const localHost = owner.hostname === hostname;
        const pidAlive = localHost ? pidProbe(owner.pid) : null;
        const active = localHost && pidAlive === true;
        return {
            path: lockPath,
            exists: true,
            active,
            valid: true,
            ownerPid: owner.pid,
            ownerHost: owner.hostname,
            localHost,
            pidAlive,
            reason: active ? 'live_local_owner'
                : localHost && pidAlive === false ? 'stale_local_owner'
                    : localHost ? 'local_owner_unconfirmed' : 'owner_not_local'
        };
    }
    return { path: found || candidates[0], exists: false, active: false, valid: true, reason: 'missing' };
}

function itemStatusCounts(items) {
    const counts = {};
    if (!items || typeof items !== 'object' || Array.isArray(items)) return counts;
    for (const item of Object.values(items)) {
        const status = item && typeof item === 'object' ? item.status : null;
        if (typeof status === 'string') counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
}

function validateItems(items, processId) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) return false;
    return Object.entries(items).every(([paperId, item]) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)
            || item.paperId !== paperId || !ITEM_STATES.has(item.status)
            || item.analysisRunId !== deterministicUuid(processId, paperId, 'analysis')
            || !Number.isSafeInteger(item.attempts) || item.attempts < 0
            || (item.retryBudgetStart !== undefined
                && (!Number.isSafeInteger(item.retryBudgetStart)
                    || item.retryBudgetStart < 0 || item.retryBudgetStart > item.attempts))
            || (item.retryNotBefore != null && !Number.isFinite(Date.parse(item.retryNotBefore)))) return false;
        return item.status !== 'complete' || Boolean(item.sourceProof && item.analysisProof && item.pageProof);
    });
}

function validateProcessStateShape(state, processId) {
    if (!state || typeof state !== 'object' || Array.isArray(state)
        || state.contract !== PROCESS_CONTRACT || state.version !== PROCESS_VERSION
        || state.processId !== processId || !UUID_RE.test(state.processId || '')
        || !PROCESS_STATES.has(state.status)
        || !state.authority || typeof state.authority !== 'object' || Array.isArray(state.authority)
        || !SHA256_RE.test(state.authority.implementationSha256 || '')
        || !validateItems(state.items, state.processId)) return false;
    if (state.sourceImplementationSha256 !== undefined
        && !SHA256_RE.test(state.sourceImplementationSha256 || '')) return false;
    const incomplete = Object.values(state.items).filter(item => item.status !== 'complete');
    if (state.status === 'complete') {
        return incomplete.length === 0 && Boolean(state.aggregate)
            && SHA256_RE.test(state.completionReceiptSha256 || '');
    }
    if (state.aggregate !== null || state.completionReceiptSha256 !== null) return false;
    return state.status !== 'partial' || incomplete.length > 0;
}

function validateCompletionReceipt(state, processDir) {
    const receiptPath = path.join(processDir, 'completion-receipt.json');
    const loaded = readTextFile(receiptPath, MAX_STATE_BYTES, 'completion_receipt');
    if (!loaded.text) return { path: receiptPath, valid: false, reason: loaded.error || 'missing' };
    let receipt;
    try { receipt = JSON.parse(loaded.text); } catch (_) {
        return { path: receiptPath, valid: false, reason: 'invalid_json' };
    }
    const body = receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? { ...receipt } : null;
    if (!body) return { path: receiptPath, valid: false, reason: 'invalid_schema' };
    delete body.receiptSha256;
    const expectedItems = Object.values(state.items).sort((a, b) => a.paperId.localeCompare(b.paperId))
        .map(item => ({ paperId: item.paperId, analysisRunId: item.analysisRunId,
            sourceProof: item.sourceProof, analysisProof: item.analysisProof, pageProof: item.pageProof }));
    const valid = receipt.contract === 'conference-process-completion-receipt-v1'
        && receipt.version === PROCESS_VERSION
        && receipt.processId === state.processId
        && SHA256_RE.test(receipt.planReceiptSha256 || '')
        && receipt.receiptSha256 === stableHash(body)
        && receipt.receiptSha256 === state.completionReceiptSha256
        && stableHash(receipt.authority) === stableHash(state.authority)
        && stableHash(receipt.aggregate) === stableHash(state.aggregate)
        && stableHash(receipt.items) === stableHash(expectedItems);
    return { path: receiptPath, valid, reason: valid ? 'validated' : 'lifecycle_mismatch' };
}

function inspectProcessStates(options = {}) {
    const processRoot = path.resolve(options.processRoot);
    const result = { root: processRoot, exists: false, publicationStatus: 'not_checked', processes: [], counts: {
        active: 0, stale: 0, reported_complete: 0, validated_complete: 0, invalid: 0
    } };
    let rootStat;
    try { rootStat = fs.lstatSync(processRoot); }
    catch (error) {
        if (error.code === 'ENOENT') return result;
        result.error = 'process_root_unreadable';
        return result;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        result.error = 'process_root_unsafe';
        return result;
    }
    result.exists = true;
    let entries;
    try { entries = fs.readdirSync(processRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (_) { result.error = 'process_root_unreadable'; return result; }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const processDir = path.join(processRoot, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            result.processes.push({ processId: entry.name, path: processDir, classification: 'invalid', reason: 'unsafe_process_directory' });
            result.counts.invalid += 1;
            continue;
        }
        const statePath = path.join(processDir, 'state.json');
        const loaded = readTextFile(statePath, MAX_STATE_BYTES, 'state');
        if (!loaded.text) {
            result.processes.push({ processId: entry.name, path: processDir, statePath, classification: 'invalid', reason: loaded.error || 'missing_state' });
            result.counts.invalid += 1;
            continue;
        }
        let state;
        try { state = JSON.parse(loaded.text); } catch (_) {
            result.processes.push({ processId: entry.name, path: processDir, statePath, classification: 'invalid', reason: 'invalid_state_json' });
            result.counts.invalid += 1;
            continue;
        }
        const stateStatus = state && typeof state.status === 'string' ? state.status : null;
        const lock = inspectProcessLock(processDir, options);
        let classification;
        let reason;
        const stateIntegrity = {
            declared: typeof state?.stateSha256 === 'string' ? state.stateSha256 : null,
            computed: null,
            valid: false
        };
        if (state && typeof state === 'object' && !Array.isArray(state)) {
            try {
                stateIntegrity.computed = stateDigest(state);
                stateIntegrity.valid = stateIntegrity.declared === stateIntegrity.computed;
            } catch (_) { /* classified below */ }
        }
        const stateShapeValid = validateProcessStateShape(state, entry.name);
        const schemaValid = stateShapeValid && stateIntegrity.valid;
        let completion = null;
        if (schemaValid && stateStatus === 'complete') completion = validateCompletionReceipt(state, processDir);
        if (!stateShapeValid) {
            classification = 'invalid'; reason = 'invalid_state_schema';
        } else if (!stateIntegrity.valid) {
            classification = 'invalid'; reason = 'state_sha_mismatch';
        } else if (!lock.valid) {
            classification = 'invalid'; reason = lock.reason;
        } else if (lock.active) {
            classification = 'active'; reason = lock.reason;
        } else if (stateStatus === 'complete') {
            classification = completion?.valid ? 'validated_complete' : 'reported_complete';
            reason = completion?.valid ? 'completion_receipt_validated' : 'completion_receipt_not_validated';
        } else {
            classification = 'stale'; reason = lock.reason;
        }
        result.processes.push({
            processId: entry.name,
            path: processDir,
            statePath,
            stateStatus,
            generation: Number.isSafeInteger(state?.generation) ? state.generation : null,
            updatedAt: typeof state?.updatedAt === 'string' ? state.updatedAt : null,
            itemCounts: itemStatusCounts(state?.items),
            stateIntegrity,
            completion,
            // A valid conference-process completion receipt proves the process
            // lifecycle only. Publication is a separate, intentionally
            // unverified surface in this read-only diagnostic.
            publicationStatus: 'not_checked',
            classification,
            reason,
            lock
        });
        result.counts[classification] = (result.counts[classification] || 0) + 1;
    }
    return result;
}

function filesystemCapacity(dataRoot) {
    try {
        const stat = fs.statfsSync(dataRoot);
        const blockSize = Number(stat.bsize || stat.frsize || 0);
        const totalBytes = blockSize * Number(stat.blocks || 0);
        const freeBytes = blockSize * Number(stat.bfree || 0);
        const availableBytes = blockSize * Number(stat.bavail || 0);
        return {
            path: path.resolve(dataRoot),
            blockSize,
            totalBytes,
            freeBytes,
            availableBytes,
            usedBytes: Math.max(0, totalBytes - freeBytes)
        };
    } catch (_) {
        return { path: path.resolve(dataRoot), error: 'filesystem_capacity_unavailable' };
    }
}

function inspectDataCapacity(projectRoot, options = {}) {
    const root = path.resolve(projectRoot);
    const dataRoot = path.join(root, 'data');
    const roots = ['current', 'archive', 'runtime'].map(name => treeStats(path.join(dataRoot, name)));
    return { filesystem: filesystemCapacity(dataRoot), roots };
}

function diagnose(options = {}) {
    const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    const paths = options.paths || defaultWorkspacePaths(projectRoot);
    return {
        contract: 'conference-workspace-diagnostic-v1',
        generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        readOnly: true,
        projectRoot,
        repositories: [
            inspectGitRepository('code', paths.codeRepo || projectRoot, { runGit: options.runGit }),
            inspectGitRepository('blog', paths.blogRepo, { runGit: options.runGit }),
            inspectGitRepository('image', paths.imageRepo, { runGit: options.runGit })
        ],
        processes: inspectProcessStates({
            processRoot: paths.processRoot || path.join(projectRoot, 'data/runtime/conference-processes'),
            hostname: options.hostname,
            pidProbe: options.pidProbe
        }),
        env: inspectEnvDuplicates(options.envFile || path.join(projectRoot, '.env')),
        capacity: inspectDataCapacity(projectRoot, options)
    };
}

function parseArgs(argv = process.argv.slice(2)) {
    if (argv.length === 0 || argv.length === 1 && argv[0] === '--json') return { json: true };
    throw new Error('Use: conference-workspace.js [--json]（只读诊断）');
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('conference-workspace.js');
    parseArgs(argv);
    const result = diagnose();
    console.log(JSON.stringify(result, null, 2));
    return result;
}

module.exports = {
    PROJECT_ROOT,
    parseEnvDefinitions,
    stableHash,
    deterministicUuid,
    stateDigest,
    inspectEnvDuplicates,
    defaultWorkspacePaths,
    parseGitStatus,
    inspectGitRepository,
    inspectProcessLock,
    inspectProcessStates,
    filesystemCapacity,
    inspectDataCapacity,
    diagnose,
    parseArgs,
    main
};

if (require.main === module) {
    try { main(); }
    catch (error) { console.error(`[conference-workspace] ${error.message}`); process.exitCode = 1; }
}

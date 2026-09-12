#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Config = require('./config.js');
const engine = require('./analysis-engine.js');
const { requireExternalRuntime } = require('./env-loader.js');

function processDirectories(root) {
    if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) {
        throw new Error('conferenceProcessDir must be a normalized absolute non-root directory');
    }
    if (!fs.existsSync(root)) return [];
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
        throw new Error('conferenceProcessDir is not a private directory');
    }
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()
            && /^[a-f0-9-]{36}$/.test(entry.name))
        .map(entry => path.join(root, entry.name));
}

function pidIsDead(pid) {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; return false; }
}

function recoverLocks(root = Config.FILES.conferenceProcessDir) {
    const recovered = []; const skipped = [];
    for (const directory of processDirectories(root)) {
        const lock = path.join(directory, '.operation');
        const snapshot = engine.inspectFileLockState(lock);
        if (!snapshot.exists) continue;
        const ownerFile = path.join(`${lock}.lock`, 'owner.json');
        let owner = null;
        try {
            const stat = fs.lstatSync(ownerFile);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error('unsafe owner file');
            owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        } catch (_error) { /* reported as an unsafe/unrecoverable lock below */ }
        if (!snapshot.reclaimable || snapshot.active || !owner || !pidIsDead(owner.pid)) {
            skipped.push({ processId: path.basename(directory), reason: 'lock is malformed or owner is alive/unknown' });
            continue;
        }
        engine.withFileLockSync(lock, () => {}, {
            recoveryPolicy: engine.OPERATOR_CONFIRMED_DEAD_OPERATION_LOCK_RECOVERY
        });
        recovered.push({ processId: path.basename(directory), pid: owner.pid, host: owner.hostname });
    }
    return { recovered, skipped };
}

function main() {
    requireExternalRuntime('recover-conference-process-locks.js');
    const result = recoverLocks();
    console.log(JSON.stringify(result));
    return result;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[recover-conference-process-locks] ${error.message}`); process.exitCode = 1; }
}

module.exports = { processDirectories, pidIsDead, recoverLocks, main };

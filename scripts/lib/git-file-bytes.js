'use strict';
// Byte readers only. Catalog/path membership and workflow authority remain with
// each caller; an original blob is never executed or treated as completion.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const LIMIT = 8 * 1024 * 1024;
function readRegularBytes(filename) {
    if (fs.realpathSync(filename) !== filename) throw new Error('Evidence forbids symlink paths');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) throw new Error('Evidence requires a bounded single-link regular file');
        const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(filename);
        if (['dev', 'ino', 'size', 'nlink', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])
            || named.dev !== after.dev || named.ino !== after.ino || named.isSymbolicLink()
            || fs.realpathSync(filename) !== filename || bytes.length !== before.size) throw new Error('Evidence changed during reading');
        return bytes;
    } finally { fs.closeSync(fd); }
}
function readGitBlob(root, blobOid, sha256) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blobOid || '') || !/^[a-f0-9]{64}$/.test(sha256 || ''))
        throw new Error('Invalid original Git blob identity');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    let bytes;
    try {
        bytes = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', '-C', root,
            'cat-file', 'blob', blobOid], { env, timeout: 10000, maxBuffer: LIMIT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw new Error('Original Git object is unavailable; restore repository history before validating old records'); }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256)
        throw new Error('Original Git bytes do not match the original SHA256');
    return bytes;
}
module.exports = { readRegularBytes, readGitBlob };

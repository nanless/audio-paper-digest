'use strict';
// Publication supplies a full source/PDF grid that it has just authenticated.
// Reuse the normal selection compiler; this process returns no source or write capability.
const fs = require('node:fs');
const path = require('node:path');
const { strictJson, readBoundedFd } = require('./publication-file-primitives');
function denyNetwork() {
    const deny = () => { throw new Error('PDF selection replay forbids network access'); };
    require('node:net').Socket.prototype.connect = deny;
    require('node:tls').connect = deny;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = deny; require(name).get = deny;
    }
    require('node:http2').connect = deny;
    globalThis.fetch = deny;
}
function main(argv = process.argv.slice(2)) {
    require('../env-loader').requireExternalRuntime('reader-pdf-selection-replay-cli.js');
    require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
    denyNetwork();
    if (argv.length !== 1 || !/^(?:[3-9]|[1-9]\d+)$/.test(argv[0])) throw new Error('Expected one private read-only input descriptor');
    const fd = Number(argv[0]), stat = fs.fstatSync(fd);
    const uidOk = typeof process.getuid === 'function' ? stat.uid === process.getuid() : true;
    if (!stat.isFile() || stat.nlink !== 1 || !uidOk || stat.size < 2 || stat.size > 16 * 1024 * 1024
        || (stat.mode & 0o777) !== 0o600) throw new Error('Unsafe selection replay input');
    const input = strictJson(readBoundedFd(fd, stat.size, 16 * 1024 * 1024), 'PDF selection replay');
    if (!input || Object.keys(input).sort().join(',') !== 'artifacts,binding,proof') throw new Error('Unexpected selection replay fields');
    require('./reader-table-pdf-evidence').validateSavedSelectionBinding(input.binding, input.artifacts, input.proof);
    return require('./protocol-codec').record('reader-pdf-selection-replay-result', { valid: true });
}
function formatReplayError(error) {
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    process.stderr.write(message + '\n');
    return { exitCode: 1, stdout: '' };
}
function runReplayFd(fd) {
    try {
        return { exitCode: 0, stdout: JSON.stringify(main([String(fd)])) + '\n' };
    } catch (error) {
        return formatReplayError(error);
    }
}
if (require.main === module) {
    try { process.stdout.write(JSON.stringify(main()) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { main, runReplayFd, formatReplayError };

'use strict';

// Publication only asks the same recovery helper whether work is pending.
// This bridge neither adopts a score nor grants source or request authority.
const fs = require('node:fs');
const path = require('node:path');

function denyNetwork() {
    const deny = () => { throw new Error('Scoring checkpoint publication replay forbids network'); };
    const net = require('node:net');
    net.Socket.prototype.connect = deny;
    net.connect = deny;
    net.createConnection = deny;
    require('node:tls').connect = deny;
    require('node:http2').connect = deny;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = deny;
        require(name).get = deny;
    }
    globalThis.fetch = deny;
}

function formatReplayError() {
    return { exitCode: 1, stdout: JSON.stringify({ verified: false }) };
}

function runReplayFd(fd) {
    try {
        require('../env-loader').requireExternalRuntime('daily-scoring-refresh-checkpoint-cli.js');
        require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
        if (!Number.isSafeInteger(fd) || fd < 3) throw new Error('Private descriptor required');
        const stat = fs.fstatSync(fd);
        const uidOk = typeof process.getuid === 'function' ? stat.uid === process.getuid() : true;
        if (!stat.isFile() || ![0, 1].includes(stat.nlink) || !uidOk || (stat.mode & 0o777) !== 0o600
            || stat.size < 2 || stat.size > 128 * 1024 * 1024) throw new Error('Unsafe private input');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== stat.size) throw new Error('Private input changed');
        const input = JSON.parse(bytes.toString('utf8'));
        const codec = require('./protocol-codec');
        const family = 'daily-scoring-refresh-publication-check';
        if (!codec.hasValidHeader(input, family)) throw new Error('Invalid publication checkpoint format');
        const header = codec.recordHeader(input.contract, family, input.schemaFingerprint);
        if (Object.keys(input).sort().join(',') !== [...Object.keys(header), 'papers'].sort().join(',')
            || !Array.isArray(input.papers) || !input.papers.length || input.papers.length > 10000
            || input.papers.some(paper => !paper || typeof paper !== 'object' || Array.isArray(paper))) {
            throw new Error('Invalid publication checkpoint check');
        }
        const helper = require('./daily-scoring-refresh-checkpoint');
        for (const paper of input.papers) helper.assertDailyOwnerNoPending(paper);
        return { exitCode: 0, stdout: JSON.stringify({ verified: true }) };
    } catch (_) {
        return formatReplayError();
    }
}

module.exports = { runReplayFd, formatReplayError };

if (require.main === module || path.basename(process.argv[1] || '') === 'daily-scoring-refresh-checkpoint-cli.js') {
    process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
    process.stdout.write = process.stderr.write.bind(process.stderr);
    const writeResult = text => fs.writeSync(1, text);
    try {
        require('../env-loader').requireExternalRuntime('daily-scoring-refresh-checkpoint-cli.js');
        require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
        denyNetwork();
        const fd = Number(process.argv[2]);
        if (process.argv.length !== 3 || !/^\d+$/.test(process.argv[2] || '')
            || !Number.isSafeInteger(fd) || fd < 3) throw new Error('Private descriptor required');
        const outcome = runReplayFd(fd);
        writeResult(outcome.stdout);
        if (outcome.exitCode) process.exitCode = outcome.exitCode;
    } catch (_) {
        const outcome = formatReplayError();
        writeResult(outcome.stdout);
        process.exitCode = outcome.exitCode;
    }
}

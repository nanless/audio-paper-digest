'use strict';

// Publication only asks the same recovery helper whether work is pending.
// This bridge neither adopts a score nor grants source or request authority.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs'), path = require('node:path');
process.stdout.write = process.stderr.write.bind(process.stderr);
const result = verified => fs.writeSync(1, JSON.stringify({ verified }));
try {
    require('../env-loader').requireExternalRuntime('daily-scoring-refresh-checkpoint-cli.js');
    require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
    const deny = () => { throw new Error('Scoring checkpoint publication replay forbids network'); };
    require('node:net').Socket.prototype.connect = deny;
    require('node:tls').connect = deny;
    require('node:http2').connect = deny;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = deny; require(name).get = deny;
    }
    globalThis.fetch = deny;
    const fd = Number(process.argv[2]);
    if (process.argv.length !== 3 || !/^\d+$/.test(process.argv[2] || '')
        || !Number.isSafeInteger(fd) || fd < 3) throw new Error('Private descriptor required');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || ![0, 1].includes(stat.nlink) || (stat.mode & 0o777) !== 0o600
        || stat.size < 2 || stat.size > 128 * 1024 * 1024) throw new Error('Unsafe private input');
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== stat.size) throw new Error('Private input changed');
    const input = JSON.parse(bytes.toString('utf8'));
    if (!input || Object.keys(input).sort().join(',') !== 'contract,papers'
        || input.contract !== 'daily-scoring-refresh-publication-check-v1'
        || !Array.isArray(input.papers) || !input.papers.length || input.papers.length > 10000
        || input.papers.some(paper => !paper || typeof paper !== 'object' || Array.isArray(paper)))
        throw new Error('Invalid publication checkpoint check');
    const helper = require('./daily-scoring-refresh-checkpoint');
    for (const paper of input.papers) helper.assertDailyOwnerNoPending(paper);
    result(true);
} catch (_) {
    result(false);
    process.exitCode = 1;
}

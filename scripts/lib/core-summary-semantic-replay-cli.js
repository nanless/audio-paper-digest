'use strict';
// Local publisher replay of the same semantic contract used during analysis.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const fs = require('node:fs'), path = require('node:path');
function denyNetwork() {
    const deny = () => { throw new Error('Core summary semantic replay forbids network access'); };
    require('node:net').Socket.prototype.connect = deny;
    require('node:tls').connect = deny;
    for (const name of ['node:http', 'node:https']) {
        require(name).request = deny; require(name).get = deny;
    }
    require('node:http2').connect = deny;
    globalThis.fetch = deny;
}
try {
    require('../env-loader').requireExternalRuntime('core-summary-semantic-replay-cli.js');
    require('../workspace-role').requireWorkspaceRole('daily', path.resolve(__dirname, '../..'));
    denyNetwork();
    const descriptor = process.argv[2], fd = Number(descriptor);
    if (process.argv.length !== 3 || !/^\d+$/.test(descriptor || '') || !Number.isSafeInteger(fd) || fd < 3) {
        throw new Error('A private input descriptor is required');
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
        || stat.size < 2 || stat.size > 16 * 1024 * 1024) {
        throw new Error('Input must be a bounded private regular file');
    }
    const input = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!input || Array.isArray(input) || typeof input !== 'object'
        || Object.keys(input).sort().join(',') !== 'sourceText,summary'
        || typeof input.summary !== 'string' || typeof input.sourceText !== 'string') {
        throw new Error('Input must contain only summary and sourceText strings');
    }
    const issue = require('../analysis-contract').validateCoreSummarySemanticContract(
        '## 核心摘要\n' + input.summary, { sourceText: input.sourceText });
    if (issue !== null && typeof issue !== 'string') throw new Error('Semantic contract returned an invalid result');
    process.stdout.write(JSON.stringify({ issue }));
} catch (error) {
    process.stdout.write(JSON.stringify({ issue: 'Core summary semantic replay failed: ' + error.message }));
    process.exitCode = 1;
}

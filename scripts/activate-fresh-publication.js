#!/usr/bin/env node
'use strict';
const { requireExternalRuntime } = require('./env-loader.js');

async function main(args = process.argv.slice(2)) {
    requireExternalRuntime('activate-fresh-publication.js');
    if (args.length < 2 || args[0] !== '--run-id'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args[1])
        || (args.length !== 2 && !(args.length === 3 && args[2] === '--dry-run'))) {
        throw new Error('Usage: --run-id UUID [--dry-run]');
    }
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const Config = require('./config.js');
    const runner = require('./lib/fresh-rewrite-run.js');
    const { withFileLock } = require('./analysis-engine.js');
    const deps = { rootDir: Config.FILES.freshRewriteRunsDir };
    const initial = runner.loadRun(args[1], deps);
    return withFileLock(path.join(initial.runDir, '.operation'), async () => {
        const loaded = runner.loadRun(args[1], deps);
        if (loaded.run.status !== 'promoted') throw new Error('Only promoted fresh runs can activate republication');
        return new Promise((resolve, reject) => {
            const child = spawn('bash', ['scripts/python-runtime.sh', 'scripts/publication_activation.py', ...args],
                { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
            child.once('error', reject);
            child.once('exit', (code, signal) => signal ? reject(new Error(`Activation terminated: ${signal}`)) : resolve(code));
        });
    });
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`[publication-activation] ${error.message}`); process.exitCode = 1;
});
module.exports = { main };

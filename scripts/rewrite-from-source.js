#!/usr/bin/env node
'use strict';

const { requireExternalRuntime } = require('./env-loader.js');

async function main(args = process.argv.slice(2)) {
    requireExternalRuntime('rewrite-from-source.js');
    const runner = require('./lib/fresh-rewrite-run.js');
    const options = runner.parseRewriteArgs(args);
    const actions = { prepare: runner.prepareRewrite, sources: runner.collectRewriteSources,
        analyze: runner.analyzeRewrite, status: runner.rewriteStatus, promote: runner.promoteRewrite };
    const result = await actions[options.action](options);
    console.log(JSON.stringify(result, null, 2));
    return result.exitCode || 0;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(`[fresh-rewrite] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };

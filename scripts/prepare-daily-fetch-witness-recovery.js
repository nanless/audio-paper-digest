#!/usr/bin/env node
'use strict';
function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = { '--date': 'date', '--source-date': 'sourceCheckpointDate' }[argv[i]];
        if (!key || o[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('用法：--date YYYY-MM-DD --source-date YYYY-MM-DD');
        o[key] = argv[i + 1];
    }
    if (!o.date || !o.sourceCheckpointDate) throw new Error('必须显式指定目标日和原检查点日期');
    return o;
}
async function main(argv = process.argv.slice(2)) {
    require('./env-loader').requireExternalRuntime('prepare-daily-fetch-witness-recovery.js');
    require('./workspace-role').requireWorkspaceRole('daily');
    const Config = require('./config'), engine = require('./analysis-engine');
    const options = parseArgs(argv);
    return engine.withFileLock(require('node:path').join(Config.CURRENT_DIR, '.full-fetch-run'),
        () => require('./lib/daily-fetch-witness-recovery').prepare({ ...options,
            blogRepo: Config.PUBLISH_CONFIG.blogRepo, dataRoot: Config.DATA_DIR }),
        { recoveryPolicy: engine.LOCAL_DEAD_PROCESS_OPERATION_LOCK_RECOVERY });
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
    console.error(e.message); process.exitCode = 1;
});
module.exports = { main, parseArgs };

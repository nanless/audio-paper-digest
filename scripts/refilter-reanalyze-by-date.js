#!/usr/bin/env node
// CLI 薄包装：实现已迁移至 `./lib/reanalysis-helpers.js`，行为保持一致。
// 用法: node scripts/refilter-reanalyze-by-date.js <YYYY-MM-DD> [--output <安全路径>]
const { setupScriptLogging } = require('./log-setup');
setupScriptLogging(__filename);

const { loadEnvFile } = require('./utils.js');
loadEnvFile();

const {
    main,
    saveSuccessfulResultsById,
    validateTargetDate,
    resolveResultFileForTargetDate,
    parseCliArgs,
    getRefilterFilterFingerprint,
    resolveRefilterCheckpointFile,
    loadRefilterDecisions,
    saveRefilterDecisions,
    promoteRefilterArtifacts
} = require('./lib/reanalysis-helpers.js');

if (require.main === module) {
    let cli;
    try {
        cli = parseCliArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
    if (cli && !cli.targetDate) {
        console.error('用法: node scripts/refilter-reanalyze-by-date.js <YYYY-MM-DD> [--output <安全路径>]');
        process.exitCode = 1;
    } else if (cli) {
        main(cli.targetDate, { resultFile: cli.resultFile }).then(result => {
            process.exitCode = result.exitCode;
        }).catch(err => {
            console.error('脚本执行失败:', err);
            process.exitCode = 1;
        });
    }
}

module.exports = {
    main,
    saveSuccessfulResultsById,
    validateTargetDate,
    resolveResultFileForTargetDate,
    parseCliArgs,
    getRefilterFilterFingerprint,
    resolveRefilterCheckpointFile,
    loadRefilterDecisions,
    saveRefilterDecisions,
    promoteRefilterArtifacts
};

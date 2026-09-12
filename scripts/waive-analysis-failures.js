#!/usr/bin/env node
'use strict';

const { requireExternalRuntime } = require('./env-loader.js');
const Config = require('./config.js');
const { createAnalysisWaiver } = require('./analysis-waiver.js');

function parseArgs(argv) {
    const values = { paperIds: [] };
    for (let index = 0; index < argv.length;) {
        const flag = argv[index];
        if (flag === '--paper-id') {
            const value = argv[index + 1];
            if (!value) throw new Error('--paper-id requires a value');
            values.paperIds.push(value); index += 2; continue;
        }
        const value = argv[index + 1];
        if (!value || (flag !== '--date' && flag !== '--reason') || values[flag.slice(2)] !== undefined) {
            throw new Error('用法: --date YYYY-MM-DD --paper-id ID [--paper-id ID ...] --reason TEXT');
        }
        values[flag.slice(2)] = value; index += 2;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date || '') || values.paperIds.length === 0
        || String(values.reason || '').trim().length < 10) {
        throw new Error('用法: --date YYYY-MM-DD --paper-id ID [--paper-id ID ...] --reason TEXT');
    }
    return values;
}

function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('waive-analysis-failures.js');
    const args = parseArgs(argv);
    const result = createAnalysisWaiver({ date: args.date, paperIds: args.paperIds,
        reason: args.reason, files: Config.FILES });
    console.log(`已记录日更分析 waiver: ${result.output}`);
    return result.payload;
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`[waive-analysis-failures] ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, main };

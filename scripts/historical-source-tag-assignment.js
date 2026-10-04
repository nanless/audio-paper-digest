#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { requireExternalRuntime } = require('./env-loader.js');
const { requireWorkspaceRole } = require('./workspace-role.js');
const { parseArgs } = require('./historical-direct-tag-supplement.js');
async function main(argv = process.argv.slice(2)) {
    requireExternalRuntime('historical-source-tag-assignment'); requireWorkspaceRole('history');
    const args=[...argv]; let includePaperIds=[],onlyPaperIds=null,resumeCheckpointFile=null,resumeExportFile=null,concurrency=1;
    const concurrencyIndex=args.indexOf('--concurrency');
    if(concurrencyIndex!==-1) {
        if(!/^[123]$/.test(args[concurrencyIndex+1]||''))throw new Error('Concurrency must be 1–3');
        concurrency=Number(args[concurrencyIndex+1]);args.splice(concurrencyIndex,2);
    }
    const exportIndex=args.indexOf('--resume-after-export');
    if(exportIndex!==-1) {
        resumeExportFile=args[exportIndex+1]||'';
        if(!path.isAbsolute(resumeExportFile)||resumeExportFile.includes('\0'))throw new Error('Invalid resume-after-export');
        args.splice(exportIndex,2);
    }
    const resumeIndex=args.indexOf('--resume-after-checkpoint');
    if(resumeIndex!==-1) {
        resumeCheckpointFile=args[resumeIndex+1]||'';
        if(!path.isAbsolute(resumeCheckpointFile)||resumeCheckpointFile.includes('\0'))throw new Error('Invalid resume-after-checkpoint');
        args.splice(resumeIndex,2);
    }
    const onlyIndex=args.indexOf('--only-paper-ids');
    if(onlyIndex!==-1) {
        onlyPaperIds=(args[onlyIndex+1]||'').split(',');
        if(onlyPaperIds.some(id=>!/^arxiv:\d{4}\.\d{4,5}$/.test(id))||new Set(onlyPaperIds).size!==onlyPaperIds.length)throw new Error('Invalid only-paper-ids');
        args.splice(onlyIndex,2);
    }
    const includeIndex=args.indexOf('--include-paper-ids');
    if(includeIndex!==-1) {
        const raw=args[includeIndex+1]||'';
        includePaperIds=raw.split(',');
        if(!includePaperIds.length || includePaperIds.some(id=>!/^arxiv:\d{4}\.\d{4,5}$/.test(id)) || new Set(includePaperIds).size!==includePaperIds.length) throw new Error('Invalid include-paper-ids');
        args.splice(includeIndex,2);
    }
    if(resumeExportFile&&!resumeCheckpointFile)throw new Error('Export resume requires original immutable checkpoint');
    if(resumeCheckpointFile&&onlyPaperIds)throw new Error('Resume remaining cohort and explicit paper retry require separate immutable runs');
    const options = {...parseArgs(args),includePaperIds,onlyPaperIds,resumeCheckpointFile,resumeExportFile,concurrency}, config = require('./config.js');
    if (options.offset) throw new Error('source-only classification does not accept offset; use immutable run decision checkpoints');
    const root = config.FILES.historicalSourceTagAssignmentDir;
    if(!root || !path.isAbsolute(root)) throw new Error('Central config historicalSourceTaxonomyClassificationDir is required');
    const api = require('./lib/historical-source-tag-assignment.js');
    const controller=new AbortController(),stop=()=>controller.abort();
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
    let report;
    try {
        ({report}=await api.classifyRun({ ...options,signal:controller.signal,outputDirectory: path.join(root, options.runId),
            onProgress: progress => console.log(JSON.stringify({ progress })) }));
    } finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
    console.log(JSON.stringify(report));
    if(report.state==='partial') process.exitCode=2;
    return report;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

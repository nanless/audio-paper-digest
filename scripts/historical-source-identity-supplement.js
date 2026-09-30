#!/usr/bin/env node
'use strict';
const path = require('node:path');
const {requireExternalRuntime}=require('./env-loader.js');
const {requireWorkspaceRole}=require('./workspace-role.js');
const {parseArgs}=require('./historical-direct-taxonomy-supplement.js');
async function main(argv=process.argv.slice(2)) {
    requireExternalRuntime('historical-source-identity-supplement'); requireWorkspaceRole('history');
    const options=parseArgs(argv), config=require('./config.js');
    if(options.offset) throw new Error('Identity supplement does not accept offset');
    const api=require('./lib/historical-source-identity-supplement.js');
    const writer=require('./lib/historical-direct-taxonomy-supplement.js');
    const outputRoot=config.FILES.historicalSourceIdentitySupplementDir;
    if(!outputRoot || !path.isAbsolute(outputRoot)) throw new Error('Central config historicalSourceIdentitySupplementDir is required');
    const directory=path.join(outputRoot,options.runId);
    const result=await api.buildIdentitySupplement({...options,onProgress:(progress,checkpoint)=>{
        writer.writeImmutable(directory,`checkpoint-${String(progress.attempted).padStart(6,'0')}.json`,checkpoint);
        console.log(JSON.stringify({progress}));
    }});
    const outputs=[writer.writeImmutable(directory,'identity-history.json',result.supplement),writer.writeImmutable(directory,'report.json',result.report)];
    console.log(JSON.stringify({selected:result.report.selected,paperCount:result.report.paperCount,pageCount:result.report.pageCount,failures:result.report.failures,outputs}));
    return {...result,outputs};
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};

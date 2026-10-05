#!/usr/bin/env node
'use strict';
const path = require('node:path');
const {requireExternalRuntime}=require('./env-loader.js');
const {requireWorkspaceRole}=require('./workspace-role.js');
const {parseArgs}=require('./historical-direct-tag-supplement.js');
async function main(argv=process.argv.slice(2)) {
    requireExternalRuntime('historical-source-identity-supplement'); requireWorkspaceRole('history');
    const options=parseArgs(argv), config=require('./config.js');
    if(options.offset) throw new Error('来源身份补充不接受偏移量参数。');
    const api=require('./lib/historical-source-identity-supplement.js');
    const writer=require('./lib/historical-direct-tag-supplement.js');
    const outputRoot=config.FILES.historicalSourceIdentitySupplementDir;
    if(!outputRoot || !path.isAbsolute(outputRoot)) throw new Error('集中配置必须提供来源身份补充的绝对输出目录。');
    const directory=path.join(outputRoot,options.runId);
    const result=await api.buildIdentitySupplement({...options,onProgress:(progress,checkpoint)=>{
        writer.writeImmutable(directory,`checkpoint-${String(progress.attempted).padStart(6,'0')}.json`,checkpoint);
        console.log(JSON.stringify({progress}));
    }});
    const outputs=result.reusedOutputs || [writer.writeImmutable(directory,'identity-history.json',result.supplement),writer.writeImmutable(directory,'report.json',result.report)];
    console.log(JSON.stringify({selected:result.report.selected,paperCount:result.report.paperCount,pageCount:result.report.pageCount,failures:result.report.failures,outputs}));
    return {...result,outputs};
}
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};

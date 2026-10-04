#!/usr/bin/env node
'use strict';
const path=require('node:path'),{parseArgs}=require('./historical-direct-tag-supplement.js');
function parsePaperIds(raw) {
 const ids=String(raw).split(',');
 const valid=id=>{
  if(/^arxiv:\d{4}\.\d{4,5}$/.test(id))return true;
  const match=/^conference:([^:]+):(\d{4}):([^:]+):([^:]+)$/.exec(id);
  if(!match)return false;
  try{return require('./lib/paper-identity.js').canonicalConferencePaperId({id:match[1]+'-'+match[2],year:Number(match[2])},{type:match[3],value:match[4]})===id;}catch{return false;}
 };
 if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!valid(id)))throw new Error('Invalid exclude-paper-ids');
 return ids;
}
async function main(argv=process.argv.slice(2)) {
 require('./env-loader.js').requireExternalRuntime('historical-tag-checkpoint-export');require('./workspace-role.js').requireWorkspaceRole('history');
 const args=[...argv],i=args.indexOf('--checkpoint');if(i<0||!path.isAbsolute(args[i+1]||''))throw new Error('--checkpoint ABS required');const checkpointFile=args[i+1];args.splice(i,2);
 const j=args.indexOf('--exclude-paper-ids');let excludePaperIds=[];if(j>=0){excludePaperIds=parsePaperIds(args[j+1]||'');args.splice(j,2);}
 const options={...parseArgs(args),checkpointFile,excludePaperIds},config=require('./config.js');
 if(!config.FILES.historicalSourceTagAssignmentDir)throw new Error('Central classifier directory required');
 const result=await require('./lib/historical-tag-checkpoint-export.js').exportCheckpoint(options);
 const writer=require('./lib/historical-direct-tag-supplement.js'),dir=path.join(config.FILES.historicalSourceTagAssignmentDir,'checkpoint-exports',options.runId);
 const outputs=[writer.writeImmutable(dir,'taxonomy-history.json',result.supplement),writer.writeImmutable(dir,'report.json',result.report)];
 console.log(JSON.stringify({...result.report,processedPaperIds:undefined,remainingPaperIds:undefined,failures:undefined,outputs}));return result;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={main,parsePaperIds};

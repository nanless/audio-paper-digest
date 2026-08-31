const fs=require('fs'), path=require('path');
const {validateManualLongformBundle}=require('./scripts/manual-longform-contract.js');
const bundle=JSON.parse(fs.readFileSync('data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925/draft/revision-record-payload.json','utf8')).editorial.longformBundle;
const article=JSON.parse(fs.readFileSync('data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925/draft/revision-record-payload.json','utf8')).editorial.readerArticle;
const artifactIndex=JSON.parse(fs.readFileSync('data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925/evidence/artifact-index.json','utf8'));
try{
  const res=validateManualLongformBundle(bundle, article, artifactIndex, {paperId:'2608.26925', runtimeMode:'production', unsealedRevision:true, label:'test'});
  console.log('pass',res);
}catch(e){console.log('fail',e.message, e.stack.split('\n')[0])}

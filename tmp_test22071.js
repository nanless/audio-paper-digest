const fs=require('fs');
const {validateManualLongformBundle}=require('./scripts/manual-longform-contract.js');
const payload=JSON.parse(fs.readFileSync('data/current/manual-v6/2026-08-29/task-runner/tasks/2608.22071/draft/revision-record-payload.json','utf8'));
const bundle=payload.editorial.longformBundle;
const article=payload.editorial.readerArticle;
const artifactIndex=JSON.parse(fs.readFileSync('data/current/manual-v6/2026-08-29/task-runner/tasks/2608.22071/evidence/artifact-index.json','utf8'));
try{
  const res=validateManualLongformBundle(bundle, article, artifactIndex, {paperId:'2608.22071', runtimeMode:'production', unsealedRevision:true, label:'test22071'});
  console.log('pass',res);
}catch(e){console.log('fail',e.message)}

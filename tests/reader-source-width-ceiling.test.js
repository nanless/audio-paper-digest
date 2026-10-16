'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer'),contract=require('../scripts/lib/reader-contract');
const sourceApi=require('../scripts/lib/model-text-sanitization');
function sample(widths=[5,4,4]) {
 const html='<html><body><p>Complete source test fixture.</p>'+widths.map((width,i)=>'<figure class="ltx_table"><figcaption>Table '+(i+1)+': Fixture</figcaption><table><tr>'+Array.from({length:width},(_,c)=>'<th>Header '+c+'</th>').join('')+'</tr><tr>'+Array.from({length:width},(_,c)=>'<td>Value '+i+' '+c+'</td>').join('')+'</tr></table></figure>').join('')+'</body></html>';
 const artifacts=deep.parseArxivStructuredArtifactsFromHtml(html,'2610.99999');
 const sourceText='Complete authenticated source fixture text for table widths.';
 const bound=deep.bindStructuredArtifactsToText(artifacts,sourceText);
 const source={text:sourceText,structuredArtifacts:bound};
 const article=bound.tables.map(t=>[t.matrix[0].map(c=>c).join(' | '),t.matrix[0].map(()=> '---').join(' | '),...t.matrix.slice(1).map(row=>row.join(' | '))].map(row=>'| '+row+' |').join('\n')).join('\n\n');
 const declared=bound.tables.map((t,i)=>({tableIndex:i+1,sourceType:'artifact_table',sourceTableOrdinal:t.ordinal,sourceQuotes:[],cellBindings:t.matrix.flatMap((row,r)=>row.map((_c,c)=>({renderedRow:r,renderedColumn:c,sourceRow:r,sourceColumn:c})))}));
 const bindings=deep.bindApiReaderSourceEvidence(article,declared,[],{structuredArtifacts:bound,sourceText}).tableBindings;
 return {source,bindings};
}
function authenticated(t,source,callback){
 // Constructed unit-only source adapter. Actual sealed-source integration is separately replayed.
 const original=sourceApi.currentModelInputSourceForPaperId;
 sourceApi.currentModelInputSourceForPaperId=()=>source;
 try{return callback();}finally{sourceApi.currentModelInputSourceForPaperId=original;}
}
test('authenticated complete DOM widths only cap the final requirement after every original table/cell is fully bound',t=>{
 const {source,bindings}=sample();
 authenticated(t,source,()=>{
  const capability=contract.readerAuthenticatedTableWidthCapability('2610.99999',source.structuredArtifacts,source.text);
  assert.ok(capability);
  const options={minimumIntegratedTables:3,sourceTableWidthCapability:capability,boundTables:bindings};
  assert.equal(contract.readerRequirements(options).minimumWideTables,1);
  assert.equal(contract.readerRequirements({...options,boundTables:undefined}).minimumWideTables,2);
  const notice=contract.buildReaderContractNotice(options);
  assert.match(notice,/至少 1 张的列数应不少于 5 列/);assert.match(notice,/全部原表一一完整展示/);
  for(const mutate of [b=>b.pop(),b=>{b[1]=structuredClone(b[0]);},b=>{b[0].cellBindings.pop();},b=>{b[0].sourceType='source_quotes';},b=>{b[0].cellBindings[0].sourceDomSha256='a'.repeat(64);},b=>{b[0].cellBindings[0].sourceText='different';},b=>{b[0].cellBindings[0].renderedColumn=1;}]){
   const changed=structuredClone(bindings);mutate(changed);assert.equal(contract.readerRequirements({...options,boundTables:changed}).minimumWideTables,2);
  }
  assert.equal(contract.readerRequirements({...options,sourceTableWidthCapability:{wideTables:0}}).minimumWideTables,2);
 });
});
test('no authenticated context, mismatched source, partial/truncated artifacts or missing tables cannot lower ordinary two-wide rule',t=>{
 const {source}=sample();
 assert.equal(contract.readerAuthenticatedTableWidthCapability('2610.99999',source.structuredArtifacts,source.text),null);
 for(const mutate of [a=>{a.health.status='incomplete';},a=>{a.health.truncated=true;},a=>{a.tables[0].recoveryStatus='partial';},a=>{a.tables.pop();},a=>{a.tables[0].cells.pop();},a=>{a.health.detected.tables++;}]){
  const current=structuredClone(source);mutate(current.structuredArtifacts);
  authenticated(t,current,()=>assert.equal(contract.readerAuthenticatedTableWidthCapability('2610.99999',current.structuredArtifacts,current.text),null));
 }
 authenticated(t,source,()=>assert.equal(contract.readerAuthenticatedTableWidthCapability('2610.99999',source.structuredArtifacts,source.text+'changed'),null));
 const original=sourceApi.currentModelInputSourceForPaperId;
 sourceApi.currentModelInputSourceForPaperId=()=>{throw Error('Reader recovery refuses ambiguous mixed active source workflows');};
 try {assert.equal(contract.readerAuthenticatedTableWidthCapability('2610.99999',source.structuredArtifacts,source.text),null);}
 finally {sourceApi.currentModelInputSourceForPaperId=original;}
 assert.equal(contract.readerRequirements({availableTableCount:3,sourceWideTables:0,minimumWideTables:0}).minimumWideTables,2);
});
test('a source with at least two wide tables retains the ordinary wide requirement',t=>{
 const {source,bindings}=sample([5,6,4]);authenticated(t,source,()=>{
  const sourceTableWidthCapability=contract.readerAuthenticatedTableWidthCapability('2610.99999',source.structuredArtifacts,source.text);
  assert.equal(contract.readerRequirements({minimumIntegratedTables:3,sourceTableWidthCapability,boundTables:bindings}).minimumWideTables,2);
 });
});

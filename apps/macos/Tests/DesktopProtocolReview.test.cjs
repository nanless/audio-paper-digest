'use strict';
// Independent protocol-boundary review: injected transport only; no credentials or network.
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../../../scripts/utils');
test('declared Responses failure receipt retains declared protocol even when automatic model detection differs',async()=>{
 const events=[],endpoint='https://fixture.invalid/v1';let requests=0;
 await assert.rejects(api.requestLlmJson(api.buildApiUrl('openai_responses',endpoint),endpoint,'deepseek-fixture',{}, {},{
  declaredProtocol:'openai_responses',recordUsage:false,timeoutMs:1000,usageSink:event=>events.push(event),
  transportRequestFn:async()=>{requests++;throw Object.assign(Error('isolated network fixture failure'),{code:'ECONNRESET'});}
 }),/isolated network fixture failure/);
 assert.equal(requests,1);assert.equal(events.length,1);assert.equal(events[0].protocol,'openai_responses');
 assert.equal(events[0].transportStarted,true);assert.equal(events[0].errorCode,'ECONNRESET');
});
test('explicit protocol cannot relax endpoint credential or actual URL boundary',async()=>{
 let requests=0,events=0;
 const options={declaredProtocol:'openai_responses',recordUsage:false,transportRequestFn:async()=>{requests++;return {};},usageSink:()=>events++};
 for(const [actual,endpoint] of [
  ['http://example.invalid/v1/responses','http://example.invalid/v1'],
  ['https://user:secret@fixture.invalid/v1/responses','https://user:secret@fixture.invalid/v1'],
  ['https://other.invalid/v1/responses','https://fixture.invalid/v1']
 ])await assert.rejects(api.requestLlmJson(actual,endpoint,'fixture',{}, {},options),{code:'LLM_ACCOUNT_POOL_CONFIG_ERROR'});
 assert.equal(requests,0);assert.equal(events,0);
});
test('all invalid declarations and case-insensitive Muse override fail before transport and usage',async()=>{
 let requests=0,events=0;const options={recordUsage:false,transportRequestFn:async()=>{requests++;return {};},usageSink:()=>events++};
 for(const declaredProtocol of [null,'auto','responses','chat','OPENAI',{},1])
  await assert.rejects(api.requestLlmJson('https://fixture.invalid/v1/responses','https://fixture.invalid/v1','fixture',{}, {},{...options,declaredProtocol}),{code:'LLM_ACCOUNT_POOL_CONFIG_ERROR'});
 for(const declaredProtocol of ['openai','anthropic'])
  await assert.rejects(api.requestLlmJson('https://fixture.invalid/v1/responses','https://fixture.invalid/v1','MuSe-SpArK-fixture',{}, {},{...options,declaredProtocol}),{code:'LLM_ACCOUNT_POOL_CONFIG_ERROR'});
 assert.equal(requests,0);assert.equal(events,0);
});

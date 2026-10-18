'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),test=require('node:test'),assert=require('node:assert/strict');
const ROOT=process.cwd(),target=path.join(ROOT,'scripts/deep-analyzer.js'),file=target;
const source=fs.readFileSync(file,'utf8');
const instance=new Module(target,module);instance.filename=target;instance.paths=Module._nodeModulePaths(path.dirname(target));
instance._compile(source+'\nmodule.exports.__proofTest={buildConfiguredModelRequestBody,buildReaderRequestMessages};',target);
const deep=instance.exports,utils=require(path.join(ROOT,'scripts/utils')),body=deep.__proofTest.buildConfiguredModelRequestBody;
test('shared request messages preserve native full request byte structure',()=>{
 const messages=deep.__proofTest.buildReaderRequestMessages('原Prompt','无图片',[]);
 assert.deepEqual(messages,[{role:'user',content:[{type:'text',text:'原Prompt'},{type:'text',text:'无图片'}]}]);
 const cfg={model:'muse-spark-1.3-contributor',temperature:.1,usageContext:{stage:'apiReaderArticle'}};
 assert.equal(JSON.stringify(body(deep.sanitizeModelMessages(messages),48000,cfg,'openai_responses')),JSON.stringify(utils.buildRequestBody('openai_responses',cfg.model,deep.sanitizeModelMessages(messages),48000,.1,{usageContext:cfg.usageContext})));
});
test('shared body preserves native chat reader format/thinking policy',()=>{
 const messages=[{role:'user',content:'示例'}],cfg={model:'mimo-v2.6-flash',temperature:.1,usageContext:{stage:'apiReaderArticle'},readerThinkingMode:'disabled',readerResponseFormat:'json_object'};
 assert.deepEqual(body(messages,48000,cfg,'openai'),utils.buildRequestBody('openai',cfg.model,messages,48000,.1,{usageContext:cfg.usageContext,readerThinkingMode:'disabled',readerResponseFormat:'json_object'}));
});
test('public input proof rejects missing authentic source/parent seed before dispatch',async()=>{
 await assert.rejects(deep.prepareConferenceReaderSavedRequestInput({},{}),/真实会议来源及原父稿 seed 能力/);
 await assert.rejects(deep.prepareConferenceReaderSavedRequestInput({}, {},{readerReviewParentSeedHandle:{},revisionSeed:{}}),/真实会议来源及原父稿 seed 能力/);
});
test('only private symbol enters proof branch; normal transport still shares native body',()=>{
 assert.match(source,/const READER_SAVED_REQUEST_INPUT_PROOF = Symbol/);
 const once=source.slice(source.indexOf('async function _callModelOnce('),source.indexOf('async function callSecondaryModel',source.indexOf('async function _callModelOnce(')));
 assert.match(once,/const bodyObj = buildConfiguredModelRequestBody\(messages, maxTokens, config, apiType\)/);
 assert.ok(source.indexOf('if (inputProofOnly) {\n            if (attempt !== 1')<source.indexOf('const grantedResponseLease = grantedReaderBudget.reserveReaderResponse'));
 assert.match(source,/if \(!inputProofOnly && !operatorCorrection\) recovered/);
 assert.match(source,/const newRound = inputProofOnly \? null/);
});

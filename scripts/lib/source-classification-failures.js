'use strict';
const runner=require('./historical-direct-rewrite-runner.js');
const STORAGE_FAILURE_CODES=new Set(['EIO','ENOSPC','EDQUOT','EROFS','EMFILE','ENFILE','EACCES','EPERM']);
const PAPER_OUTPUT_CODES=new Set(['MODEL_OUTPUT_TRUNCATED','MODEL_OUTPUT_INCOMPLETE','MODEL_RESPONSE_TOO_LARGE','RESPONSE_TOO_LARGE']);
function isPaperOutputFailure(error) {
 return Boolean(error&&PAPER_OUTPUT_CODES.has(error.code));
}
function classifyRunFailure(error) {
 if(isPaperOutputFailure(error))return null;
 const account=runner.globalAccountFailure(error);if(account)return account;
 const seen=new Set();
 const inspect=value=>{
  if(!value||typeof value!=='object'||seen.has(value))return null;
  seen.add(value);
  if(isPaperOutputFailure(value))return null;
  const code=value.code;
  if(STORAGE_FAILURE_CODES.has(code))return 'local-storage-unavailable';
  if(code==='MODEL_OVERALL_TIMEOUT')return 'model-service-timeout';
  if(Object.hasOwn(value,'modelRequestClassified')&&value.modelRequestClassified===true) {
   if(value.category==='network')return 'model-service-network-unavailable';
   if(code==='MODEL_HTTP_TRANSIENT'&&value.category==='http_transient'&&Number.isInteger(value.status)
      &&([408,425,429].includes(value.status)||value.status>=500&&value.status<=599))return 'model-service-http-unavailable';
   if(code==='MODEL_ENDPOINT_CONFIG_ERROR'&&value.category==='endpoint_config')return 'model-service-configuration-unavailable';
   if(code==='LLM_ACCOUNT_POOL_LOCK_TIMEOUT'&&value.category==='state_contention')return 'model-account-state-unavailable';
   if(['request','api_error','response_parse','response_terminal','stream_terminal'].includes(value.category))return 'model-service-response-unavailable';
  }
  if(value instanceof AggregateError)for(const error of value.errors){const found=inspect(error);if(found)return found;}
  for(const key of ['cause','errorDetails','error']) {const found=inspect(value[key]);if(found)return found;}
  return null;
 };
 return inspect(error);
}
module.exports={classifyRunFailure,isPaperOutputFailure};

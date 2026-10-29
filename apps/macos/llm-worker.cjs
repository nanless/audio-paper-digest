'use strict';
// The desktop client uses the exact shared route/transport/usage implementation.
// Credentials arrive over a private pipe, never via argv or a persistent config file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharedRoot = path.join(__dirname, 'Shared');
const api = require(path.join(sharedRoot, 'scripts/utils.js'));
// Only fixed, application-owned diagnostics cross the worker error boundary.
// Exact-key replacement cannot cover proxy credentials, encoded echoes or private text.
const diagnosticGroups = [
  ['transport', '连接或传输未完成；请核对端点、代理和网络，不会自动重发', ['ECONNREFUSED','ECONNRESET','ECONNABORTED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','PROXY_CONNECT_REJECTED','PROXY_CONNECT_TIMEOUT','REQUEST_DEADLINE_EXCEEDED','REQUEST_SOCKET_TIMEOUT']],
  ['config', '模型或请求配置无效；未自动重发', ['ERR_INVALID_URL','REQUEST_THINKING_POLICY_CONFLICT','LLM_ACCOUNT_POOL_CONFIG_ERROR']],
  ['authentication', '认证或权限失败；请检查本机凭据，不会自动重发', ['LLM_ACCOUNT_AUTH_ERROR']],
  ['quota_exhausted', '额度或余额不足；实际请求记录保留，不会自动重发', ['LLM_ACCOUNT_POOL_EXHAUSTED']],
  ['state', '账号状态保存或读取失败；已停止请求，请保留本机记录', ['LLM_ACCOUNT_POOL_STATE_ERROR']],
  ['state_contention', '账号状态正在使用；已停止本次请求', ['LLM_ACCOUNT_POOL_LOCK_TIMEOUT']],
  ['persistence', '请求或用量记录保存失败；已停止请求，请保留本机恢复材料', ['LLM_REQUEST_START_NOT_PERSISTED','LLM_USAGE_NOT_PERSISTED']],
  ['response', '服务响应格式或大小无效；原始响应与实际请求记录保留，不会自动重发', ['LLM_RESPONSE_PARSE_ERROR','RESPONSE_TOO_LARGE']],
  ['truncation', '模型输出被截断；已返回内容与实际用量保留，不会自动重发', ['MODEL_OUTPUT_TRUNCATED']],
  ['incomplete', '服务响应未完成；已返回内容与实际用量保留，不会自动重发', ['MODEL_RESPONSE_INCOMPLETE','SSE_TERMINAL_EVENT_MISSING']],
  ['empty_output', '服务未返回可读正文；实际用量保留，不会自动重发', ['MODEL_EMPTY_OUTPUT']]
];
const diagnosticCodes = new Map(diagnosticGroups.flatMap(([category,message,codes]) => codes.map(code=>[code,{category,message}])));
const validationMessages = new Set(['模型配置或输入无效','模型名称不能为空','Responses 流式设置必须为布尔值','推理强度设置无效','代理必须是 HTTP CONNECT 地址','此模型或完整端点要求 Responses；未发送不兼容的 Chat 请求',
  'OpenCode Go muse-spark-* 必须在项目 .env 配置 HTTPS_PROXY 或 HTTP_PROXY（HTTP CONNECT），禁止静默直连']);
const providerCodes = new Set(['insufficient_balance','insufficient_quota','quota_exceeded','credit_exhausted','credits_exhausted','invalid_api_key','authentication_error','permission_denied','rate_limit_exceeded','server_error','service_unavailable','GoUsageLimitError']);
const categoryNames = {quota:'额度或余额不足',authentication:'认证或权限失败',rate_limit:'请求频率受限',service:'服务暂时不可用',request:'请求被服务拒绝'};
function safeDiagnostic(error) {
  const candidate = typeof error?.code==='string' ? error.code : '';
  const http = /^HTTP_([1-5]\d{2})$/.exec(candidate);
  if(http) {
    const status=Number(http[1]),category=Object.hasOwn(categoryNames,error.category)?error.category:status===401||status===403?'authentication':status===429?'rate_limit':status>=500?'service':'request';
    return {code:candidate,category,providerCode:providerCodes.has(error.providerCode)?error.providerCode:'',message:`${categoryNames[category]}（HTTP ${status}）；实际请求记录保留，不会自动重发`};
  }
  const known=diagnosticCodes.get(candidate);
  if(known)return {code:candidate,...known};
  if(validationMessages.has(error?.message))return {code:'MODEL_CONFIGURATION_INVALID',category:'config',message:error.message};
  return {code:'MODEL_REQUEST_FAILED',category:'unknown',message:'模型请求未完成；请核对本机请求与费用记录，不会自动重发'};
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 4 * 1024 * 1024) process.exit(2);
});
process.stdin.on('end', async () => {
  let request, observed={model:null,usage:null,protocol:'unknown',finishStatus:'unknown'};
  try {
    request = JSON.parse(input); input = '';
    const { config, messages, usageDirectory, runID, paperID } = request;
    if (!Array.isArray(messages) || !messages.length || typeof config?.key !== 'string') throw new Error('模型配置或输入无效');
    const endpoint = String(config.endpoint || '').trim(); api.validateApiEndpointUrl(endpoint);
    const model = String(config.model || '').trim(); if (!model) throw new Error('模型名称不能为空');
    if(config.responsesStream!==undefined&&typeof config.responsesStream!=='boolean')throw new Error('Responses 流式设置必须为布尔值');
    const effort=config.reasoningEffort??'default';
    if(!['default','low','medium','high'].includes(effort))throw new Error('推理强度设置无效');
    // Only this app's explicit configuration governs Responses parameters. Clear
    // inherited variables even when the worker is invoked outside the native app.
    process.env.PD_OPENAI_RESPONSES_STREAM=config.responsesStream===true?'1':'0';
    if(effort==='default')delete process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT;
    else process.env.PD_OPENAI_RESPONSES_REASONING_EFFORT=effort;
    // An explicit Responses selection is represented as the full declared route.
    const declared = config.protocol === 'responses' && !endpoint.endsWith('/responses')
      ? endpoint.replace(/\/+$/, '') + '/responses' : endpoint;
    if (config.httpProxy) {
      const proxy = new URL(config.httpProxy);
      if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('代理必须是 HTTP CONNECT 地址');
      process.env.HTTPS_PROXY = config.httpProxy; process.env.HTTP_PROXY = config.httpProxy;
    }
    if(config.protocol==='chat' && (model.toLowerCase().startsWith('muse-spark-') || endpoint.replace(/\/+$/,'').endsWith('/responses')))throw new Error('此模型或完整端点要求 Responses；未发送不兼容的 Chat 请求');
    const protocol = config.protocol==='chat' ? 'openai' : config.protocol==='responses' ? 'openai_responses' : api.detectApiType(declared, model);
    observed.protocol=protocol;
    const maxTokens = Math.max(256, Math.min(32768, Number(config.maxTokens) || 8192));
    const context = {runId:(runID || crypto.randomUUID()).toLowerCase(),paperId:paperID || null,stage:'desktopStudy',unitId:crypto.createHash('sha256').update(String(paperID||'connection-check')).digest('hex'),inputSha256:crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex')};
    const body = api.buildRequestBody(protocol, model, messages, maxTokens, undefined, {usageContext:context});
    if (protocol === 'openai_responses') body.store = false;
    const response = await api.requestLlmJson(api.buildApiUrl(protocol, declared), declared, model, body,
      api.buildHeaders(protocol, config.key, JSON.stringify(body)),
      {timeoutMs:Math.max(10000,Math.min(600000,Number(config.timeoutMs)||180000)),maxResponseBytes:16*1024*1024,
       recordUsage:true,usageDirectory,usageContext:context,apiKeys:[config.key],...(config.protocol==='auto'||!config.protocol?{}:{declaredProtocol:protocol})});
    observed={protocol,model:typeof response.body?.model==='string'&&response.body.model.trim()?response.body.model:null,
      usage:response.body?.usage||null,finishStatus:response.body?.status||response.body?.choices?.[0]?.finish_reason||'unknown'};
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail=response.body?.error;
      // Inspect text only in memory for the existing failure category; never echo it.
      const rawCode=typeof detail?.code==='string'?detail.code:typeof detail?.type==='string'?detail.type:'';
      const providerCode=providerCodes.has(rawCode)?rawCode:'';
      const hint=(rawCode+' '+(typeof detail?.message==='string'?detail.message:typeof detail==='string'?detail:'')).toLowerCase();
      const category=/insufficient[_ -]?(?:balance|quota)|(?:quota|credits?)[_ -]?(?:exceeded|exhausted)|balance/.test(hint)?'quota':response.statusCode===401||response.statusCode===403?'authentication':response.statusCode===429?'rate_limit':response.statusCode>=500?'service':'request';
      const error = new Error(categoryNames[category]);
      error.code=`HTTP_${response.statusCode}`;error.category=category;error.providerCode=providerCode;throw error;
    }
    const text = api.parseResponseText(protocol,response.body);
    const truncated = api.getResponsesOutputTruncationError(response.body,maxTokens)
      || (['length','max_tokens'].includes(response.body?.choices?.[0]?.finish_reason) ? Object.assign(new Error('模型输出被截断'),{code:'MODEL_OUTPUT_TRUNCATED'}) : null);
    const unfinished=['incomplete','failed'].includes(response.body?.status)?Object.assign(new Error('服务响应未完成（'+response.body.status+'）；实际用量与已返回内容已保留，不自动重发'),{code:'MODEL_RESPONSE_INCOMPLETE'}):null;
    const failure=truncated||unfinished||(!text?.trim()?Object.assign(new Error('服务未返回可读正文；实际用量已保留，不自动重发'),{code:'MODEL_EMPTY_OUTPUT'}):null);
    process.stdout.write(JSON.stringify({...observed,okay:!failure,text:text||'',
      error:failure?safeDiagnostic(failure):null})+'\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({...observed,okay:false,error:safeDiagnostic(error)})+'\n');
  }
});

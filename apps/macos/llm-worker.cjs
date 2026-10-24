'use strict';
// The desktop client uses the exact shared route/transport/usage implementation.
// Credentials arrive over a private pipe, never via argv or a persistent config file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharedRoot = path.join(__dirname, 'Shared');
const api = require(path.join(sharedRoot, 'scripts/utils.js'));
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
      const redact=value=>String(value||'').split(config.key).join('[redacted]');
      const detail=response.body?.error,providerCode=redact(detail?.code||detail?.type).slice(0,120),providerMessage=redact(detail?.message|| (typeof detail==='string'?detail:'')).slice(0,1200);
      const hint=(providerCode+' '+providerMessage).toLowerCase();
      const category=/insufficient[_ -]?(?:balance|quota)|(?:quota|credits?)[_ -]?(?:exceeded|exhausted)|balance/.test(hint)?'quota':response.statusCode===401||response.statusCode===403?'authentication':response.statusCode===429?'rate_limit':response.statusCode>=500?'service':'request';
      const names={quota:'额度或余额不足',authentication:'认证或权限失败',rate_limit:'请求频率受限',service:'服务暂时不可用',request:'请求被服务拒绝'};
      const error = new Error(`${names[category]}（HTTP ${response.statusCode}）${providerMessage?'：'+providerMessage:''}`);
      error.code=`HTTP_${response.statusCode}`;error.category=category;error.providerCode=providerCode;throw error;
    }
    const text = api.parseResponseText(protocol,response.body);
    const truncated = api.getResponsesOutputTruncationError(response.body,maxTokens)
      || (['length','max_tokens'].includes(response.body?.choices?.[0]?.finish_reason) ? Object.assign(new Error('模型输出被截断'),{code:'MODEL_OUTPUT_TRUNCATED'}) : null);
    const unfinished=['incomplete','failed'].includes(response.body?.status)?Object.assign(new Error('服务响应未完成（'+response.body.status+'）；实际用量与已返回内容已保留，不自动重发'),{code:'MODEL_RESPONSE_INCOMPLETE'}):null;
    const failure=truncated||unfinished||(!text?.trim()?Object.assign(new Error('服务未返回可读正文；实际用量已保留，不自动重发'),{code:'MODEL_EMPTY_OUTPUT'}):null);
    process.stdout.write(JSON.stringify({...observed,okay:!failure,text:text||'',
      error:failure?{message:failure.message,code:failure.code,category:truncated?'truncation':unfinished?'incomplete':'empty_output'}:null})+'\n');
  } catch (error) {
    const secret = request?.config?.key;
    let message = String(error.message||'模型请求失败'); if (secret) message = message.split(secret).join('[redacted]');message=message.slice(0,1500);
    const clean=value=>{let text=String(value||'');if(secret)text=text.split(secret).join('[redacted]');return text.slice(0,1500);};
    process.stdout.write(JSON.stringify({...observed,okay:false,error:{code:clean(error.code||'MODEL_REQUEST_FAILED'),category:clean(error.category||(/ECONN|TIMEOUT|ETIMEDOUT|NETWORK/.test(error.code||'')?'transport':'unknown')),providerCode:clean(error.providerCode),message}})+'\n');
  }
});

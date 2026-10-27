'use strict';
// Ordinary existing-node request/response protocol. This module grants no
// attempts, full responses, source authority, or final Reader qualification.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const repair = require('./reader-repair');
const { strictJson } = require('./publication-file-primitives');
const CONTRACT = 'reader-target-ordinal-patch-v1';
const COMPILATION_CONTRACT = 'reader-target-ordinal-compilation-v1';
const TEMPLATE = `只修当前已存在且明确列出的普通节点。只输出完整、严格的单个JSON对象：\n{"contract":"reader-target-ordinal-patch-v1","version":1,"requestToken":"{{requestToken}}","replacements":[{"targetOrdinal":1,"value":"完整替换值"}]}\nrequestToken必须逐字使用本次值。targetOrdinal只能是清单中1到N的整数，最多8个，不能重复。不要返回path、SHA、解释、Markdown围栏或其他字段。value必须与原节点同类型；对象节点须给完整对象。保留一切不需修改的正确事实、数字、单位、图表、公式及引用。修改后仍要通过正常完整Reader检查。\n本次请求：{{requestToken}}\n当前授权目标：\n{{targets}}\n核验反馈：\n{{feedback}}\n来源证据：\n{{evidence}}\n整篇机械约束（不扩大本次目标）：\n{{mechanicalContract}}`;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const TEMPLATE_SHA = sha(TEMPLATE);
const stableSha=value=>{const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;return sha(JSON.stringify(sorted(value)));};
const SHA = /^[a-f0-9]{64}$/, TOKEN = /^[a-f0-9]{16}$/, ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const caps = new WeakMap();
const originSymbol=Symbol('ordinary-reader-ordinal-origin');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (message, scope = 'content') => { const e = new Error('Reader ordinal patch refused: ' + message);
    e.code = 'READER_TARGET_ORDINAL_REJECTED'; if(scope==='run'){e.scope='run';e.retryable=false;} throw e; };
function io(action){try{return action();}catch(cause){const e=new Error('Reader ordinal diagnostic failed: '+cause.message,{cause});e.code='READER_DIAGNOSTIC_FAILED';e.scope='run';e.retryable=false;throw e;}}
function safe(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || seen.has(value)
        || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
        || Object.getOwnPropertySymbols(value).length) fail('unsafe JSON value');
    seen.add(value);
    if (Array.isArray(value) && (Object.keys(value).length !== value.length
        || Array.from({length: value.length}, (_, i) => !own(value, i)).some(Boolean))) fail('sparse or extended array');
    for (const key of Object.keys(value)) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (['__proto__', 'prototype', 'constructor'].includes(key) || !d || !own(d, 'value')) fail('unsafe JSON key or accessor');
        safe(d.value, seen);
    }
    seen.delete(value);
}
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function exact(value, keys) {
    safe(value);
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('unexpected object fields');
}
// strictJson rejects duplicate keys at every depth and requires complete JSON.
// A token walk additionally preserves integer *lexemes* (1.0/1e0 are not an
// ordinal), including escaped spellings of the targetOrdinal key.
function parseAck(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024 * 1024) fail('response must be bounded raw JSON');
    const result = strictJson(Buffer.from(raw), CONTRACT); safe(result);
    const tokens = [...raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g)].map(m => m[0]);
    let at = 0;
    function walk(route) {
        const token = tokens[at++];
        if (token === '{') {
            if (tokens[at] === '}') { at++; return; }
            for (;;) {
                const key = JSON.parse(tokens[at++]); if (tokens[at++] !== ':') fail('invalid JSON object');
                walk([...route, key]); const end = tokens[at++]; if (end === '}') break;
                if (end !== ',') fail('invalid JSON object terminator');
            }
        } else if (token === '[') {
            if (tokens[at] === ']') { at++; return; }
            let index = 0;
            for (;;) { walk([...route, index++]); const end = tokens[at++]; if (end === ']') break;
                if (end !== ',') fail('invalid JSON array terminator'); }
        } else if (route.length === 3 && route[0] === 'replacements' && route[2] === 'targetOrdinal') {
            if (!/^[1-8]$/.test(token)) fail('ordinal must be a literal integer 1..8');
        } else if (route.length === 1 && route[0] === 'version' && token !== '1') fail('version must be literal 1');
    }
    walk([]); if (at !== tokens.length) fail('trailing JSON');
    exact(result, ['contract','version','requestToken','replacements']);
    if (result.contract !== CONTRACT || result.version !== 1 || !TOKEN.test(result.requestToken)
        || !Array.isArray(result.replacements) || result.replacements.length < 1 || result.replacements.length > 8) fail('invalid ACK contract');
    for (const item of result.replacements) exact(item, ['targetOrdinal','value']);
    return result;
}
function node(draft, pointer) {
    if (['/readerTitle','/oneSentenceThesis'].includes(pointer)) {
        if (!own(draft, pointer.slice(1))) fail('missing text node'); return draft[pointer.slice(1)];
    }
    const m = /^\/(sections|conceptBridges|figurePlacements|tableBindings|formulaBindings)\/(0|[1-9]\d*)(\/(body|explanation))?$/.exec(pointer);
    if (!m || (m[3] && !((m[1] === 'sections' && m[4] === 'body')
        || (m[1] === 'conceptBridges' && m[4] === 'explanation')))) fail('not an ordinary existing node');
    const values = draft[m[1]], index = Number(m[2]);
    if (!Array.isArray(values) || !own(values, index)) fail('node does not exist');
    if (!m[3]) return values[index];
    if (!values[index] || !own(values[index], m[4])) fail('node field does not exist');
    return values[index][m[4]];
}
function eligible(context, options = {}) {
    return Boolean(context && Array.isArray(context.targets) && context.targets.length >= 1 && context.targets.length <= 8
        && context.atomicOperation == null && !context.sectionGroupPlanContract && !context.conceptTermsContext
        && !options.metadataOperation && !options.conceptTermsContext && !options.readerFactLocalRevision
        && !options.resourceLocalRevision && !options.atomicOperation);
}
function targetsFor(draft, context) {
    safe(draft); safe(context.targets);
    const seen = [];
    return context.targets.map((target, index) => {
        if (!target || typeof target.path !== 'string' || !SHA.test(target.oldSha256)) fail('invalid target descriptor');
        if (seen.some(p => p === target.path || p.startsWith(target.path + '/') || target.path.startsWith(p + '/'))) fail('duplicate or overlapping paths');
        seen.push(target.path);
        const value = node(draft, target.path);
        if (repair.hashDraft(value) !== target.oldSha256 || !own(target,'value') || !isDeepStrictEqual(target.value,value)) fail('stale target');
        return { targetOrdinal: index + 1, path: target.path, oldSha256: target.oldSha256, valueType: kind(value) };
    });
}
function sourceScope(paper, identity, directory) {
    const fresh = require('./fresh-analysis-context'), engine = require('../analysis-engine');
    const context = fresh.getFreshAnalysisContext();
    if (!context || !fresh.isDailyFreshSourceScope() || !engine.paperAnalysisLockHeld(paper)
        || String(paper?.arxivId || '').replace(/v\d+$/,'') !== String(identity?.paperId || '').replace(/v\d+$/,'')
        || !isDeepStrictEqual(fresh.freshAnalysisIdentity(identity.paperId), identity.freshAnalysis)
        || identity.contentMode !== 'reader-source-only-v1' || identity.resourceLocalRevisionContract
        || identity.readerFactLocalRevisionContract
        || identity.sourceSha256 !== identity.freshAnalysis.sourceSha256
        || path.resolve(fresh.freshReaderAttemptsDirectory(directory)) !== path.resolve(directory)) fail('paper lock/source/identity scope mismatch','run');
    fresh.assertFreshPaper(paper);
    return { context, scopeIdentity: repair.hashDraft(identity) };
}
function currentCandidate(state) {
    sourceScope(state.paper,state.identity,state.directory);
    const checked = repair.readFailedCandidateEnvelope(state.directory,state.identity);
    if (!checked || checked.envelopeSha256 !== state.candidateSha256
        || repair.hashDraft(checked.envelope.payload.draft) !== state.request.draftSha256) fail('active candidate changed','run');
    return checked;
}
function committedToken(request){
    return sha(JSON.stringify({domain:CONTRACT,requestSalt:request.requestSalt,
        identitySha256:request.identitySha256,candidateEnvelopeSha256:request.candidateEnvelopeSha256,
        draftSha256:request.draftSha256,orderedTargetsSha256:repair.hashDraft(request.targets)})).slice(0,16);
}
function requestFor(draft, targets, identity, candidateEnvelopeSha256) {
    const request={contract:CONTRACT,version:1,templateSha256:TEMPLATE_SHA,
        requestSalt:crypto.randomBytes(16).toString('hex'),identitySha256:repair.hashDraft(identity),
        candidateEnvelopeSha256,draftSha256:repair.hashDraft(draft),targets};
    request.requestToken=committedToken(request);return request;
}

function prepare({paper,identity,directory,draft,repairContext,options = {}}) {
    if (!eligible(repairContext,options)) fail('special/local/atomic repair is excluded');
    if(identity?.model?.protocol!=='openai_responses')fail('ordinary ordinal protocol is Responses-only');
    sourceScope(paper,identity,directory);
    if (repairContext.draftSha256 !== repair.hashDraft(draft)) fail('stale repair context');
    const checked=repair.readFailedCandidateEnvelope(directory,identity);
    if (!checked || !isDeepStrictEqual(checked.envelope.payload.draft,draft)) fail('request must use exact active failed draft');
    const request=requestFor(draft,targetsFor(draft,repairContext),identity,checked.envelopeSha256);
    const candidateBytes=fs.readFileSync(path.join(directory,repair.hashDraft(identity)+'.json'));
    if(sha(candidateBytes)!==checked.envelopeSha256)fail('actual parent envelope changed','run');
    const capability=Object.freeze({});
    caps.set(capability,{paper,identity:structuredClone(identity),directory:path.resolve(directory),draft:structuredClone(draft),
        candidateSha256:checked.envelopeSha256,candidateRawBase64:candidateBytes.toString('base64'),request,diagnostic:null});
    return capability;
}
function stateOf(capability) { const state=caps.get(capability); if(!state) fail('private request capability required');currentCandidate(state);return state; }
function requestContract(capability) { return structuredClone(stateOf(capability).request); }
function renderPrompt(capability,{feedback,evidence,mechanicalContract,naturalResourceProse=false}) {
    const s=stateOf(capability);
    const values={requestToken:s.request.requestToken,targets:JSON.stringify(s.request.targets.map(t=>({targetOrdinal:t.targetOrdinal,
        valueType:t.valueType,currentValue:node(s.draft,t.path)}))),feedback:String(feedback||''),evidence:String(evidence||''),mechanicalContract:String(mechanicalContract||'')};
    const rendered=require('./reader-resource-prose').renderPrompt(
        TEMPLATE.replace(/\{\{(requestToken|targets|feedback|evidence|mechanicalContract)\}\}/g,(_,key)=>values[key]),naturalResourceProse);
    (s.prompts||=new Set()).add(rendered);return rendered;
}
function readRecord(filename,expectedSha) {
    if (fs.realpathSync(filename)!==path.resolve(filename)) fail('symlink record path');
    const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try {const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||(st.mode&0o777)!==0o600||st.size>64*1024*1024)fail('unsafe record');
        const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(filename);
        if(['dev','ino','size','mtimeMs','ctimeMs','mode','nlink'].some(k=>st[k]!==after[k]||st[k]!==named[k])||expectedSha&&sha(bytes)!==expectedSha)fail('record changed');
        const value=strictJson(bytes,'ordinal record');safe(value);return {value,sha256:sha(bytes)};
    }finally{fs.closeSync(fd);}
}
function storeRecord(directory,name,value) {
    if(fs.realpathSync(directory)!==path.resolve(directory)||!fs.lstatSync(directory).isDirectory())fail('unsafe diagnostic directory');
    const filename=path.join(directory,name),bytes=JSON.stringify(value,null,2)+'\n';
    const fd=fs.openSync(filename,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    return {path:filename,sha256:sha(bytes)};
}
function messageImages(messages) {
    const out=[];
    function visit(value) {
        if(!value||typeof value!=='object')return;
        const url=value.type==='image_url'?value.image_url?.url:value.type==='input_image'?value.image_url:null;
        if(url){const m=/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
            if(!m)fail('ordinal images must be transient data URLs');
            out.push({mime:m[1],base64Sha256:sha(m[2])});}
        for(const child of Object.values(value))visit(child);
    }
    visit(messages);return out;
}
const read=(...args)=>io(()=>readRecord(...args));
const store=(...args)=>io(()=>storeRecord(...args));
function bindDiagnostic(capability,diagnostic,messages) {
    const s=stateOf(capability);
    if(!ID.test(diagnostic?.id)||path.resolve(diagnostic.directory)!==path.join(s.directory,'request-diagnostics'))fail('diagnostic scope');
    const filename=path.join(diagnostic.directory,diagnostic.id+'.request.json'),r=read(filename,diagnostic.requestSha256),q=r.value;
    if(q.contract!=='reader-repair-request-diagnostics-v1'||q.id!==diagnostic.id
        ||!isDeepStrictEqual(q.identity,s.identity)||!isDeepStrictEqual(q.draft,s.draft)
        ||q.draftSha256!==s.request.draftSha256||q.promptSha256!==sha(q.prompt)||!s.prompts?.has(q.prompt)
        ||!isDeepStrictEqual(q.readerTargetOrdinalRequest,s.request)
        ||q.actualRepairPromptTemplateSha256!==TEMPLATE_SHA||q.actualRepairPromptContract!==CONTRACT
        ||q.inputMessagesSha256!==sha(JSON.stringify(messages))
        ||!isDeepStrictEqual(messageImages(messages),q.images.map(i=>({mime:i.mime,base64Sha256:i.base64Sha256})))
        ||q.atomicOperation||q.sectionGroupPlanContract||q.termTargets
        ||!isDeepStrictEqual(targetsFor(q.draft,{targets:q.repairTargets}),s.request.targets))fail('request diagnostic does not bind capability');
    store(diagnostic.directory,diagnostic.id+'.ordinal-parent.json',{contract:CONTRACT,id:diagnostic.id,
        identitySha256:repair.hashDraft(s.identity),candidateEnvelopeSha256:s.candidateSha256,candidateRawBase64:s.candidateRawBase64});
    s.diagnostic={...diagnostic,requestFile:filename};s.messages=structuredClone(messages);s.witnessNumber=0;s.witnesses=[];return true;
}
// No image pixels are persisted. The real request body stays in memory; its
// exact serialization SHA is later matched to the normal fee inputSha256.
function recordRequestWitness(capability,body,usageContext) {
    const s=stateOf(capability),d=s.diagnostic;
    if(!d||usageContext?.stage!=='apiReaderRepair'||usageContext.unitId!==sha(d.id)
        ||usageContext.paperId!==s.identity.paperId)fail('dispatch must be the bound ordinary request');
    const q=read(d.requestFile,d.requestSha256).value,serialized=JSON.stringify(body);
    if(s.identity.model.protocol!=='openai_responses'||body.model!==s.identity.model.model)fail('unsupported/mismatched provider model');
    const safeMessages=require('../deep-analyzer').sanitizeModelMessages(s.messages);
    const expected=require('../utils').buildRequestBody('openai_responses',s.identity.model.model,safeMessages,body.max_output_tokens,s.identity.repairTemperature);
    if(!isDeepStrictEqual(body.input,expected.input))fail('wire input differs from exact diagnostic messages');
    if(!serialized.includes(s.request.requestToken)||!serialized.includes(CONTRACT))fail('wire request missing current contract');
    const data={contract:CONTRACT,version:1,id:d.id,requestSha256:d.requestSha256,
        providerInputSha256:sha(serialized),inputMessagesSha256:q.inputMessagesSha256,promptSha256:q.promptSha256,
        requestToken:s.request.requestToken,images:q.images,containsImagePixels:false};
    const number=(s.witnessNumber||0)+1;s.witnessNumber=number;
    const ref=store(d.directory,`${d.id}.ordinal-input-${number}.json`,data);
    (s.witnesses||=[]).push(ref);return ref;
}
function compileAgainst(draft,request,raw,applyOptions) {
    exact(request,['contract','version','requestToken','requestSalt','identitySha256','candidateEnvelopeSha256','templateSha256','draftSha256','targets']);
    if(request.contract!==CONTRACT||request.version!==1||!TOKEN.test(request.requestToken)||!/^([a-f0-9]{32})$/.test(request.requestSalt)
        ||!SHA.test(request.identitySha256)||!SHA.test(request.candidateEnvelopeSha256)
        ||request.requestToken!==committedToken(request)||request.templateSha256!==TEMPLATE_SHA
        ||request.draftSha256!==repair.hashDraft(draft)||!Array.isArray(request.targets)||!request.targets.length||request.targets.length>8)fail('invalid original request');
    const descriptors=targetsFor(draft,{targets:request.targets.map(t=>({path:t.path,oldSha256:t.oldSha256,value:node(draft,t.path)}))});
    if(!isDeepStrictEqual(descriptors,request.targets))fail('original ordered target mapping changed');
    if(applyOptions?.atomicOperation||applyOptions?.readerFactLocalClaims)fail('special apply options excluded');
    const ack=parseAck(raw);if(ack.requestToken!==request.requestToken)fail('wrong request nonce');
    const seen=new Set(),mapping=[];
    const replacements=ack.replacements.map(item=>{
        const n=item.targetOrdinal;if(!Number.isSafeInteger(n)||n<1||n>request.targets.length||seen.has(n))fail('unknown/repeated ordinal');seen.add(n);
        const target=request.targets[n-1],old=node(draft,target.path);
        if(repair.hashDraft(old)!==target.oldSha256||kind(item.value)!==target.valueType)fail('stale node or replacement type mismatch');
        mapping.push({...target,newSha256:repair.hashDraft(item.value)});
        return {path:target.path,oldSha256:target.oldSha256,value:item.value};
    });
    const patch={version:1,draftSha256:request.draftSha256,replacements};
    const after=repair.applyReaderPatch(draft,patch,request.targets.map(t=>t.path),applyOptions);
    return {patch,after,proof:{contract:COMPILATION_CONTRACT,requestContract:CONTRACT,requestToken:request.requestToken,
        templateSha256:TEMPLATE_SHA,beforeDraftSha256:request.draftSha256,afterDraftSha256:repair.hashDraft(after),
        responseSha256:sha(raw),standardPatchSha256:repair.hashDraft(patch),mapping}};
}
function compile(capability,raw,applyOptions={}) {
    const s=stateOf(capability),d=s.diagnostic;if(!d)fail('unrecorded ordinal request');
    const responseFile=path.join(d.directory,d.id+'.response.json'),response=read(responseFile);
    if(response.value.requestSha256!==d.requestSha256||response.value.rawResponse!==raw||response.value.outputTextSha256!==sha(raw))fail('response not saved against actual request');
    const result=compileAgainst(s.draft,s.request,raw,applyOptions);currentCandidate(s);
    const ref=store(d.directory,d.id+'.ordinal-compiled.json',{contract:COMPILATION_CONTRACT,id:d.id,identity:s.identity,
        requestSha256:d.requestSha256,responseSha256:response.sha256,beforeDraft:s.draft,afterDraft:result.after,
        standardPatch:result.patch,proof:result.proof,inputWitnesses:s.witnesses||[],normalParserRequired:true});
    s.compilation={...ref,id:d.id,responseFile,responseSha256:response.sha256};return {...result,compilation:s.compilation};
}
// Cold replay is explicitly supplied byte pins from the saved candidate/stage.
// The saved mapping/proof is never an instruction: recompute it from the
// original request and response, then use the same strict SHA patch applier.
function replay({paper,identity,directory,requestId,pins,applyOptions={}}) {
    savedSourceScope(paper,identity,directory);
    exact(pins,['requestSha256','responseSha256','compilationSha256','sealSha256']);
    if(!ID.test(requestId)||Object.values(pins).some(v=>!SHA.test(v)))fail('replay requires original byte pins');
    const dir=path.join(path.resolve(directory),'request-diagnostics');
    const q=read(path.join(dir,requestId+'.request.json'),pins.requestSha256),r=read(path.join(dir,requestId+'.response.json'),pins.responseSha256),
        c=read(path.join(dir,requestId+'.ordinal-compiled.json'),pins.compilationSha256),seal=read(path.join(dir,requestId+'.ordinal-seal.json'),pins.sealSha256);
    if(q.value.contract!=='reader-repair-request-diagnostics-v1'||q.value.id!==requestId||r.value.id!==requestId
        ||q.value.promptSha256!==sha(q.value.prompt)||r.value.requestSha256!==q.sha256||r.value.outputTextSha256!==sha(r.value.rawResponse)
        ||!isDeepStrictEqual(q.value.identity,identity)||q.value.atomicOperation||q.value.termTargets||q.value.sectionGroupPlanContract
        ||q.value.actualRepairPromptContract!==CONTRACT||q.value.actualRepairPromptTemplateSha256!==TEMPLATE_SHA
        ||!isDeepStrictEqual(q.value.draft,c.value.beforeDraft)||!isDeepStrictEqual(c.value.identity,identity)
        ||c.value.requestSha256!==q.sha256||c.value.responseSha256!==r.sha256)fail('cold request/response linkage changed');
    const request=q.value.readerTargetOrdinalRequest;
    const parent=read(path.join(dir,requestId+'.ordinal-parent.json')).value;
    const parentBytes=Buffer.from(parent.candidateRawBase64||'','base64'),envelope=strictJson(parentBytes,'original ordinal parent');
    if(parent.contract!==CONTRACT||parent.id!==requestId||parent.identitySha256!==repair.hashDraft(identity)
        ||parent.candidateEnvelopeSha256!==request?.candidateEnvelopeSha256||sha(parentBytes)!==request?.candidateEnvelopeSha256
        ||envelope.version!==repair.REPAIR_VERSION||!isDeepStrictEqual(envelope.identity,identity)
        ||envelope.payloadSha256!==repair.hashDraft(envelope.payload)||!isDeepStrictEqual(envelope.payload?.draft,q.value.draft)
        ||envelope.payload.attempts+1!==q.value.contentAttempt)fail('cold original active parent envelope differs');

    if(!request||request.identitySha256!==repair.hashDraft(identity)||!isDeepStrictEqual(targetsFor(q.value.draft,{targets:q.value.repairTargets}),request.targets))fail('cold request targets changed');
    const result=compileAgainst(q.value.draft,request,r.value.rawResponse,applyOptions);
    if(!isDeepStrictEqual(result.patch,c.value.standardPatch)||!isDeepStrictEqual(result.after,c.value.afterDraft)
        ||!isDeepStrictEqual(result.proof,c.value.proof))fail('saved compilation differs from strict replay');
    validateSeal(seal.value,{identity,requestId,requestSha256:q.sha256,responseSha256:r.sha256,compilationSha256:c.sha256,raw:r.value.rawResponse,request:q.value,directory:dir});
    return {...result,verifiedOriginalRequestResponse:true,normalParserRequired:true};
}
function validateSealRecords(seal,expected) {
    if(seal.contract!==CONTRACT||seal.id!==expected.requestId||seal.identitySha256!==repair.hashDraft(expected.identity)
        ||seal.requestSha256!==expected.requestSha256||seal.responseSha256!==expected.responseSha256||seal.compilationSha256!==expected.compilationSha256
        ||!Array.isArray(seal.usageRecords)||!Array.isArray(seal.witnesses))fail('seal identity mismatch');
    const usageDir=path.resolve(require('../config').FILES.llmUsageDir),events=[];
    for(const ref of seal.usageRecords){
        if(path.dirname(path.resolve(ref.file))!==usageDir||!/^[a-f0-9-]{36}\.json$/.test(path.basename(ref.file)))fail('usage outside normal ledger');
        const event=read(ref.file,ref.sha256).value;
        if(event.eventId!==ref.eventId||event.kind!==ref.kind||event.paperId!==expected.identity.paperId||!['apiReaderRepair','apiReaderImageProbe'].includes(event.stage))fail('normal usage identity mismatch');
        events.push(event);
    }
    const inputs=[];
    for(const ref of seal.witnesses){
        if(path.dirname(path.resolve(ref.path))!==path.resolve(expected.directory))fail('witness outside diagnostic directory');
        const w=read(ref.path,ref.sha256).value;
        if(w.id!==expected.requestId||w.requestSha256!==expected.requestSha256||w.requestToken!==expected.request.readerTargetOrdinalRequest.requestToken
            ||w.promptSha256!==expected.request.promptSha256||w.inputMessagesSha256!==expected.request.inputMessagesSha256
            ||!isDeepStrictEqual(w.images,expected.request.images)||w.containsImagePixels!==false)fail('input witness changed');
        inputs.push(w.providerInputSha256);
    }
    const starts=events.filter(e=>e.kind==='request_started'),ends=events.filter(e=>e.kind==='request'),dispositions=events.filter(e=>e.kind==='disposition');
    if(events.length!==starts.length+ends.length+dispositions.length||starts.length<1||starts.length>2
        ||ends.length!==starts.length||dispositions.length!==1
        ||new Set(seal.usageRecords.map(r=>r.file)).size!==events.length
        ||events.some(e=>e.version!=='llm-usage-v1'||e.runId!==expected.identity.freshAnalysis.runId
            ||e.paperId!==expected.identity.paperId||e.stage!=='apiReaderRepair'||e.unitId!==sha(expected.requestId)
            ||e.contentAttempt!==expected.request.contentAttempt))fail('normal fee run/stage/attempt chain differs');
    const labels=['runId','paperId','stage','unitId','contentAttempt','transportAttempt','protocol','model','inputSha256'];
    if(new Set(starts.map(e=>e.eventId)).size!==starts.length)fail('ambiguous request start');
    for(const start of starts){
        const matches=ends.filter(e=>e.eventId===start.eventId);
        if(matches.length!==1||labels.some(k=>(start[k]??null)!==(matches[0][k]??null))
            ||!Number.isFinite(Date.parse(start.at))||!Number.isFinite(Date.parse(matches[0].at))||Date.parse(matches[0].at)<Date.parse(start.at)
            ||start.model!==expected.identity.model.model||start.protocol!==expected.identity.model.protocol
            ||!inputs.includes(start.inputSha256))fail('normal start/terminal model/input/time pairing differs');
    }
    const terminals=ends.filter(e=>e.outcome==='completed'&&e.statusCode===200&&e.outputTextSha256===sha(expected.raw));
    if(terminals.length!==1||ends.some(e=>e!==terminals[0]&&(e.outcome!=='transport_error'||e.outputTextSha256!==null))
        ||dispositions[0].outputTextSha256!==sha(expected.raw)||!['accepted','rejected'].includes(dispositions[0].disposition)
        ||!Number.isFinite(Date.parse(dispositions[0].at))||Date.parse(dispositions[0].at)<Date.parse(terminals[0].at)
        ||starts.some(e=>e.eventId===dispositions[0].eventId))fail('normal completed response/disposition chain differs');
}
const validateSeal=(...args)=>io(()=>validateSealRecords(...args));
function seal(capability,usageRecords) {
    const s=stateOf(capability),d=s.diagnostic,c=s.compilation;if(!c||!d)fail('no completed strict compilation');
    const q=read(d.requestFile,d.requestSha256).value,r=read(c.responseFile,c.responseSha256).value;
    const value={contract:CONTRACT,id:d.id,identitySha256:repair.hashDraft(s.identity),requestSha256:d.requestSha256,
        responseSha256:c.responseSha256,compilationSha256:c.sha256,requestDirectory:d.directory,
        witnesses:s.witnesses||[],usageRecords:structuredClone(usageRecords).filter(ref=>read(ref.file,ref.sha256).value.unitId===sha(d.id))};
    validateSeal(value,{identity:s.identity,requestId:d.id,requestSha256:d.requestSha256,responseSha256:c.responseSha256,
        compilationSha256:c.sha256,raw:r.rawResponse,request:q,directory:d.directory});
    s.seal=store(d.directory,d.id+'.ordinal-seal.json',value);return s.seal;
}

function savedSourceScope(paper,identity,directory){
    const fresh=require('./fresh-analysis-context'),prov=paper?.freshRewriteProvenance;
    if(!prov||prov.contract!=='fresh-source-analysis-v1'||!isDeepStrictEqual(prov,paper.analysisManifest?.freshRewriteProvenance)
        ||String(paper.arxivId||'').replace(/v\d+$/,'')!==String(identity.paperId||'').replace(/v\d+$/,''))fail('saved paper/source identity differs','run');
    const runDir=path.join(require('../config').FILES.dailyFreshSourceRunsDir,prov.runId),run=read(path.join(runDir,'run.json')).value;
    if(run.contract!==fresh.DAILY_SOURCE_RUN_CONTRACT||path.resolve(directory)!==path.join(runDir,'reader-attempts'))fail('saved run scope differs','run');
    const source=fresh.readFreshSource(runDir,paper,{runId:run.runId,sourceExpectations:run.sourceExpectations}),d=source.freshSourceDescriptor;
    if(['runId','sourceSha256','structuredArtifactsSha256','sourceSnapshotSha256','sourceGeneration','sourceManifestSha256'].some(k=>prov[k]!==d[k]
        ||identity.freshAnalysis?.[k]!==d[k])||identity.sourceSha256!==d.sourceSha256)fail('saved four-source bytes differ','run');
    return source;
}
function attachOrigin(capability,result,normalization){
    const state=caps.get(capability);if(!state||!state.seal||!state.compilation)fail('actual compiled/sealed request required','run');
    sourceScope(state.paper,state.identity,state.directory);
    if(!result||typeof result.article!=='string'||!result.plan||!Array.isArray(result.ordinalPatchCompilations)
        ||!result.ordinalPatchCompilations.length)fail('normal parsed result required','run');
    const last=result.ordinalPatchCompilations.at(-1);
    if(last.requestId!==state.diagnostic.id||last.pins.compilationSha256!==state.compilation.sha256||last.pins.sealSha256!==state.seal.sha256)fail('normal result has another compilation','run');
    Object.defineProperty(result,originSymbol,{enumerable:true,value:{capability,records:structuredClone(result.ordinalPatchCompilations),normalization:structuredClone(normalization)}});
    return result;
}
function attachSavedOrigin({paper,identity,directory,draft,records},result,normalization){
    sourceScope(paper,identity,directory);
    const current=repair.readFailedCandidateEnvelope(directory,identity);
    if(!current||!isDeepStrictEqual(current.envelope.payload.draft,draft)
        ||!isDeepStrictEqual(current.envelope.payload.ordinalPatchCompilations,records)||!records.length)fail('saved origin is not active candidate','run');
    for(const record of records)replay({paper,identity:record.identity,directory,requestId:record.requestId,pins:record.pins});
    const capability=Object.freeze({});caps.set(capability,{paper,identity:structuredClone(identity),directory,completionOnly:true});
    Object.defineProperty(result,originSymbol,{enumerable:true,value:{capability,records:structuredClone(records),normalization:structuredClone(normalization)}});return result;
}
function completionDirectory(directory,create=false){
    const dir=path.join(directory,'ordinal-completions');
    if(create)try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    let stat;try{stat=fs.lstatSync(dir);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(stat&&(stat.isSymbolicLink()||fs.realpathSync(dir)!==path.resolve(dir)||!stat.isDirectory()))fail('unsafe completion index','run');
    return dir;
}
const canonical=paper=>String(paper?.arxivId||'').replace(/v\d+$/,'');
function completionFiles(dir,paper){
    const id=canonical(paper);if(!/^\d{4}\.\d{4,5}$/.test(id))fail('invalid completion paper','run');
    if(!fs.existsSync(dir))return[];
    return fs.readdirSync(dir).filter(name=>name.startsWith(id+'-')&&/^\d{4}\.\d{4,5}-\d{8}\.json$/.test(name)).sort();
}
function stageCore(stage){return Object.fromEntries(Object.entries(stage||{}).filter(([key])=>key!=='ordinalCompletionProof'));}
function sealCompletion(paper,result){
    const origin=result?.[originSymbol],state=origin&&caps.get(origin.capability);
    if(!state||!isDeepStrictEqual(origin.records,result.ordinalPatchCompilations))fail('normal in-memory completion origin missing','run');
    sourceScope(paper,state.identity,state.directory);
    const stage=paper.analysisManifest?.stages?.apiReaderArticle;
    if(stage?.status!=='complete'||paper.apiReaderArticle!==result.article||!isDeepStrictEqual(paper.apiReaderPlan,result.plan)
        ||stage.articleSha256!==sha(result.article)||stage.planSha256!==stableSha(result.plan))fail('final article/plan stage not ready','run');
    for(const record of origin.records)replay({paper,identity:record.identity,directory:state.directory,requestId:record.requestId,pins:record.pins});
    const dir=completionDirectory(state.directory,false);if(!fs.existsSync(dir))completionDirectory(state.directory,true);
    const files=completionFiles(dir,paper),sequence=files.length+1;
    if(files.some((name,index)=>Number(name.slice(-13,-5))!==index+1))fail('completion history has gaps','run');
    stage.ordinalPatchContract=CONTRACT;stage.ordinalPatchCompilations=structuredClone(origin.records);
    paper.analysisManifest.contracts.readerTargetOrdinalPatch=CONTRACT;
    const value={contract:COMPILATION_CONTRACT,kind:'normal-final-completion',paperId:canonical(paper),sequence,
        freshRewriteProvenance:structuredClone(paper.freshRewriteProvenance),identity:state.identity,
        articleSha256:sha(result.article),planSha256:stableSha(result.plan),stage:stageCore(stage),records:origin.records,normalization:origin.normalization};
    const ref=store(dir,`${canonical(paper)}-${String(sequence).padStart(8,'0')}.json`,value);
    // Include marker fields in the immutable stage snapshot, rather than
    // changing the snapshot after it was written.
    return ref;
}
function validateCompletion(paper){
    const checked=readVerifiedCompletion(paper);if(!checked)return true;
    return require('./reader-dom-span-projection').withSavedPaper(paper,()=>
        require('./reader-table-pdf-evidence').withSavedPaper(paper,()=>
        require('./reader-sealed-pdf-quote-evidence').withSavedPaper(paper,()=>
        require('./reader-source-table-column-units').withSavedPaper(paper,()=>
        require('./reader-authenticated-pdf-table-evidence').withSavedPaper(paper,()=>replayNormalCompletion(paper,checked))))));
}
function readVerifiedCompletion(paper){
    const stage=paper?.analysisManifest?.stages?.apiReaderArticle,prov=paper?.freshRewriteProvenance;
    const marked=paper?.analysisManifest?.contracts?.readerTargetOrdinalPatch!==undefined||stage?.ordinalPatchContract!==undefined||stage?.ordinalPatchCompilations!==undefined||stage?.ordinalCompletionProof!==undefined;
    if(!prov){if(marked)fail('completion marker lacks daily source','run');return null;}
    if(prov.contract!=='fresh-source-analysis-v1'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(prov.runId||'')){
        if(marked)fail('ordinary completion cannot leave canonical daily source','run');return null;
    }
    const runFile=path.join(require('../config').FILES.dailyFreshSourceRunsDir,prov.runId,'run.json');
    const actualDaily=fs.existsSync(runFile)&&read(runFile).value.contract===require('./fresh-analysis-context').DAILY_SOURCE_RUN_CONTRACT;
    if(!actualDaily){if(marked)fail('ordinary completion cannot leave canonical daily source','run');return null;}
    if(!/^\d{4}\.\d{4,5}$/.test(canonical(paper)))fail('actual daily source lacks canonical paper ID','run');
    const attempts=path.join(require('../config').FILES.dailyFreshSourceRunsDir,prov.runId,'reader-attempts'),dir=completionDirectory(attempts),files=completionFiles(dir,paper);
    if(!files.length){if(marked)fail('completion marker lacks stable source index','run');return null;}
    // Lookup is canonical paper in the actual source run, never current article
    // SHA. Removing both marker/proof and changing the article cannot bypass it.
    if(files.some((name,index)=>Number(name.slice(-13,-5))!==index+1)||!marked)fail('completion index/marker removed','run');
    const ref=stage.ordinalCompletionProof;if(!ref||path.resolve(ref.path)!==path.join(dir,files.at(-1)))fail('latest completion not selected','run');
    const saved=read(ref.path,ref.sha256).value;
    savedSourceScope(paper,saved.identity,attempts);
    if(saved.contract!==COMPILATION_CONTRACT||saved.kind!=='normal-final-completion'||saved.paperId!==canonical(paper)
        ||saved.sequence!==files.length||!isDeepStrictEqual(saved.freshRewriteProvenance,prov)
        ||paper.analysisManifest.contracts.readerTargetOrdinalPatch!==CONTRACT||stage.ordinalPatchContract!==CONTRACT||!isDeepStrictEqual(saved.records,stage.ordinalPatchCompilations)
        ||saved.articleSha256!==sha(paper.apiReaderArticle)||saved.planSha256!==stableSha(paper.apiReaderPlan)
        ||!isDeepStrictEqual(saved.stage,stageCore(stage)))fail('normal final completion/source/stage differs','run');
    let last;
    for(const record of saved.records)last=replay({paper,identity:record.identity,directory:attempts,requestId:record.requestId,pins:record.pins});
    const source=savedSourceScope(paper,saved.identity,attempts);return{source,last,saved};
}
function replayNormalCompletion(paper,{source,last,saved}){
    const deep=require('../deep-analyzer');
    if(!saved.normalization||!Array.isArray(saved.normalization.issues)||!Array.isArray(saved.normalization.pixelFigureOrdinals))fail('normalizer snapshot missing','run');
    const normalized={};
    deep.normalizeApiReaderRecoveryDraftForSource(structuredClone(last.after),saved.normalization.issues,{
        paperId:paper.arxivId,sourceText:source.text,structuredArtifacts:source.structuredArtifacts,
        pixelFigureOrdinals:saved.normalization.pixelFigureOrdinals,draftOrderMappings:[]},normalized);
    const evidence=deep.buildApiReaderEvidenceContext('',source.text,source.structuredArtifacts,paper.arxivId);
    const parsed=deep.parseApiReaderArticleResult(JSON.stringify(normalized.draft),{arxivId:paper.arxivId,
        availableFigureOrdinals:saved.normalization.pixelFigureOrdinals,requireIntegratedTables:true,
        minimumIntegratedTables:require('./reader-contract').readerRequirements({version:3,
            availableTableCount:[...evidence.matchAll(/^TABLE_(\d+):/gm)].length}).minimumTables,
        requiredVersion:3,requireSourceBindings:true,allowDeterministicQuoteRepair:true,
        allowDeterministicUnsupportedClaimPruning:true,enforceResourceAvailabilityClaims:true,
        verifiedResourceIdentity:deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources,source.text),
        sourceText:source.text,structuredArtifacts:source.structuredArtifacts});
    const final=deep.replayApiReaderFinalDisplay(parsed,source,paper.apiReaderFigures,paper.arxivId);
    if(final.article!==paper.apiReaderArticle||!isDeepStrictEqual(final.plan,paper.apiReaderPlan))fail('cold compiler/parser/final display differs','run');
    return true;
}

module.exports={CONTRACT,COMPILATION_CONTRACT,TEMPLATE_SHA,eligible,prepare,requestContract,renderPrompt,bindDiagnostic,
    recordRequestWitness,parseAck,compileReaderTargetOrdinalPatch:compileAgainst,hasActiveCompletion:paper=>Boolean(readVerifiedCompletion(paper)),compile,seal,replay,attachOrigin,attachSavedOrigin,sealCompletion,validateCompletion};

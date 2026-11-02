'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),crypto=require('node:crypto');
const ROOT=process.env.MALFORMED_VIEW_ROOT||process.cwd(),workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'malformed-reader-view-tests-')));
const fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(process.env.MALFORMED_VIEW_FIXTURE||path.join(ROOT,'tests/fixtures/reader-malformed-previous-draft-view-real.json.gz'))));
// The recorded full prompt belongs to this exact v9 template, not whatever
// template new requests currently select. Authenticate its immutable original
// bytes before installing the child-process/write guard; no product is loaded.
const historicalPromptPath='prompts/api-reader-article-v9.md',historicalPromptSha256='a2630453bfbd506619b7b3e80ece91ffc9f53951b80bab043cc6d889731d7ff8';
const promptIndex=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/lib/git-prompt-evidence-index.json'),'utf8'));
assert.equal(promptIndex.retiredPaths[historicalPromptPath],historicalPromptSha256);
const historicalPromptEntry=promptIndex.blobs[historicalPromptSha256];assert.ok(historicalPromptEntry.paths.includes(historicalPromptPath));
const gitEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
Object.assign(gitEnv,{GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});
const historicalPromptBytes=require('node:child_process').execFileSync('git',['--no-lazy-fetch','--no-replace-objects','-C',ROOT,'cat-file','blob',historicalPromptEntry.blobOid],{env:gitEnv,timeout:10000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
assert.equal(crypto.createHash('sha256').update(historicalPromptBytes).digest('hex'),historicalPromptSha256);
require(path.join(ROOT,'tests/helpers/isolated-tmp-write-guard.cjs')).installTmpOnlyWriteGuard(workspace);
const api=require(process.env.MALFORMED_VIEW_MODULE||path.join(ROOT,'scripts/lib/reader-malformed-previous-draft-view'));
const raw=fixture.rawDraft,sha=x=>crypto.createHash('sha256').update(x).digest('hex'),before=JSON.stringify(fixture);
// Use the existing canonical extraction function verbatim without loading any
// production analyzer or triggering its logger, environment, network or models.
const original=fs.readFileSync(path.join(ROOT,'scripts/deep-analyzer.js'),'utf8');const start=original.indexOf('function extractJsonObjectText(raw) {'),end=original.indexOf('\nfunction parseImageInsertionPlanDetailed',start);
assert.ok(start>=0&&end>start);const extract=new Function('return ('+original.slice(start,end).trim()+');')();
const invoke=(changes={})=>{const opts={raw,jsonText:extract(raw),candidate:null,repairContext:null,originalPromptChars:fixture.observedOriginalPromptChars,contextMaxChars:fixture.contextMaxChars,...changes};return api.malformedPreviousDraftDiagnostic(opts);};
const decode=text=>JSON.parse(text.slice(text.indexOf('\n')+1));
const nativeParseError=value=>{try{JSON.parse(value);assert.fail('fixture must remain malformed');}catch(error){assert.ok(error instanceof SyntaxError);return error.message;}};
const observedNode22ParseError=fixture.issues[0].message.slice('读者文章 JSON 无法解析: '.length);
test('real bad Unicode response yields diagnostic only with full raw identity',()=>{const view=invoke(),d=decode(view);assert.equal(d.contract,api.CONTRACT);assert.equal(d.diagnosticOnly,true);assert.equal(d.rawSha256,sha(raw));assert.equal(d.rawUtf16Length,raw.length);assert.equal(d.rawUtf8Bytes,Buffer.byteLength(raw));assert.equal(d.parsedSliceSha256,sha(extract(raw)));assert.equal(d.errorPositionUtf16,12022);assert.ok(view.includes('不是完整 JSON 草稿'));});
test('real native parse error is preserved verbatim',()=>{let error;try{JSON.parse(extract(raw));}catch(e){error=e;}assert.ok(error instanceof SyntaxError);assert.equal(decode(invoke()).nativeParseError,error.message);assert.equal(fixture.issues[0].message,'读者文章 JSON 无法解析: '+observedNode22ParseError);assert.equal(observedNode22ParseError,'Bad Unicode escape in JSON at position 12022 (line 1 column 12023)');assert.match(error.message,/Bad Unicode escape in JSON at position 12022/);});
test('head tail and error excerpts are exact UTF16 raw slices',()=>{const d=decode(invoke());assert.deepEqual(d.excerpts.map(x=>x.kind),['head','tail','parse_error']);for(const e of d.excerpts)assert.equal(e.text,raw.slice(e.startUtf16,e.endUtf16));assert.equal(d.excerpts[0].startUtf16,0);assert.equal(d.excerpts[1].endUtf16,raw.length);const e=d.excerpts[2];assert.ok(e.startUtf16<=12022&&e.endUtf16>12022);});
test('real diagnostic is bounded and only send-view material shrinks',()=>{const view=invoke();assert.ok(view.length<=api.MAX_DIAGNOSTIC_CHARS&&view.length<raw.length);const projected=fixture.observedOriginalPromptChars-raw.length+view.length;assert.ok(projected<=240000);assert.equal(fixture.originalPromptNotReconstructed,true);});
test('helper cannot repair or consume the failed response or its counters',()=>{invoke();assert.throws(()=>JSON.parse(raw),SyntaxError);assert.equal(JSON.stringify(fixture),before);assert.deepEqual(fixture.counters,{attempts:1,fullAttempts:1,noProgress:0,transportFailures:0,validationFailureStreak:1});});
for(const[name,changes]of [['non-null candidate',{candidate:{}}],['real repairable candidate',{candidate:fixture.validRepairableDraft}],['patch context',{repairContext:{draftSha256:'a'.repeat(64),targets:[]}}],['undefined candidate',{candidate:undefined}],['undefined context',{repairContext:undefined}],['false candidate',{candidate:false}],['at existing cap',{originalPromptChars:240000}],['below existing cap',{originalPromptChars:239999}],['string prompt size',{originalPromptChars:'247488'}],['invalid cap',{contextMaxChars:0}],['empty old response',{raw:'',jsonText:''}],['unrelated extracted JSON bytes',{jsonText:'{"x":"\\uZZZZ"}'}]])test(name+' does not use diagnostic projection',()=>assert.equal(invoke(changes),null));
for(const[name,value]of [['complete real Reader JSON',JSON.stringify(fixture.validRepairableDraft)],['large valid string',JSON.stringify('x'.repeat(100000))],['JSON null','null'],['JSON primitive','42'],['valid but incomplete object','{}'],['valid repair patch JSON',JSON.stringify({version:1,draftSha256:'b'.repeat(64),replacements:[]})]])test(name+' stays complete even without candidate',()=>assert.equal(invoke({raw:value,jsonText:extract(value)}),null));
test('valid real JSON wrapped in markdown remains intact',()=>{const value='```json\n'+JSON.stringify(fixture.validRepairableDraft)+'\n```';assert.equal(invoke({raw:value,jsonText:extract(value)}),null);});
test('ambiguous extracted slice location remains blocked',()=>assert.equal(invoke({raw:raw+'\n'+raw,jsonText:raw}),null));
test('EOF-only syntax error keeps tail and a truthful end offset',()=>{const value='{"body":"'+'x'.repeat(30000);const d=decode(invoke({raw:value,jsonText:value}));assert.equal(d.nativeParseError,nativeParseError(value));assert.equal(d.errorPositionUtf16,value.length);assert.equal(d.excerpts[2].endUtf16,value.length);});
test('control-character-heavy diagnostic remains bounded after JSON escaping',()=>{const value='{"body":"'+'\u0000'.repeat(30000)+'"}';const text=invoke({raw:value,jsonText:value});assert.ok(text&&text.length<=api.MAX_DIAGNOSTIC_CHARS);const d=decode(text);for(const e of d.excerpts)assert.equal(e.text,value.slice(e.startUtf16,e.endUtf16));});
test('supplementary Unicode boundaries preserve complete scalar pairs',()=>{const value='{"body":"'+'😀'.repeat(16000)+'\\uZZZZ"}';const d=decode(invoke({raw:value,jsonText:value}));for(const e of d.excerpts){assert.equal(e.text,value.slice(e.startUtf16,e.endUtf16));assert.ok(!/^[\uDC00-\uDFFF]/.test(e.text));assert.ok(!/[\uD800-\uDBFF]$/.test(e.text));}});
test('one real raw character change changes the full raw SHA',()=>{const changed=raw.slice(0,-1)+' ';const d=decode(invoke({raw:changed,jsonText:extract(changed)}));assert.notEqual(d.rawSha256,decode(invoke()).rawSha256);});
test('unknown native error location remains blocked instead of guessing',()=>{const value='garbage'.repeat(5000);assert.equal(invoke({raw:value,jsonText:value}),null);});

function nativeFullPrompt(changes={},historical=false) {
    const deep=require(path.join(ROOT,'scripts/deep-analyzer')),utils=require(path.join(ROOT,'scripts/utils'));
    const versions=require(path.join(ROOT,'scripts/lib/prompt-text-versions'));
    // Run the canonical loader body unchanged. Only its historical byte reader
    // is supplied from the already authenticated Git object; this is a render
    // fixture, not a source/declaration capability or a production override.
    const loadHistoricalPrompt=new Function('require','path','fs','__dirname','return ('+utils.loadPrompt.toString()+');')(id=>{
        assert.equal(id,'./lib/prompt-evidence.js');return {readPromptEvidenceBytes:relative=>{assert.equal(relative,historicalPromptPath);return Buffer.from(historicalPromptBytes);}};
    },path,fs,path.join(workspace,'scripts'));
    const promptPathForStage=historical ? stage=>{assert.equal(stage,'apiReaderArticle');return versions.promptFilePathForContract(stage,'analysis-prompt-text-v9');} : deep.currentTextStagePromptPath;
    const code=fs.readFileSync(path.join(ROOT,'scripts/deep-analyzer.js'),'utf8'),a=code.indexOf('        let previousDraftPromptView = previousDraft;'),z=code.indexOf('        const selectedInputs = repairContext',a);
    assert.ok(a>=0&&z>a);const snippet=code.slice(a,z).replace("        let prompt = buildReaderPrompt('');","        let prompt = buildReaderPrompt('');\n        const originalPrompt = prompt;");
    const vars={...fixture.nativeFullPromptVariables,...changes},issues=fixture.nativeCurrentIssues;
    const names=['require','conceptTermsContext','repairContext','options','paper','mechanicalContract','repair','numericSpellingGuidance','repairReviewFeedbackPrefix','savedInputContinuity','currentIssues','ordinalCapability','ordinaryOrdinal','fullRegenerationEvidence','validationFeedback','fullRegenerationTableFeedback','previousDraft','naturalResourceProse','patchRejectionFeedback','loadPrompt','currentTextStagePromptPath','API_READER_CONTEXT_MAX_CHARS','extractJsonObjectText','candidate','getPaperArxivId','readerVerifiedTableIndexExamples','sourceEvidence','issueFeedback'];
    const values=[id=>require(id.startsWith('./')?path.join(ROOT,'scripts',id):id),null,null,{structuredArtifacts:{}},{title:vars.title,arxivId:vars.arxivId},vars.mechanicalContract,require(path.join(ROOT,'scripts/lib/reader-repair')),'','',null,issues,null,null,vars.sourceEvidence,vars.validationFeedback,'',vars.previousDraft,fixture.nativeNaturalResourceProse,'',historical?loadHistoricalPrompt:utils.loadPrompt,promptPathForStage,fixture.contextMaxChars,extract,null,deep.getPaperArxivId,deep.readerVerifiedTableIndexExamples,vars.sourceEvidence,issue=>issue.message];
    return new Function(...names,snippet+'\nreturn {prompt,originalPrompt,previousDraftPromptView,previousDraft};')(...values);
}
test('original v9 full canonical prompt renderer preserves the exact recorded prompt and real source evidence',()=>{
    const result=nativeFullPrompt({},true);assert.equal(result.originalPrompt,fixture.nativeOriginalPrompt);assert.equal(result.originalPrompt.length,247157);assert.equal(decode(result.previousDraftPromptView).nativeParseError,nativeParseError(extract(raw)));assert.equal(result.prompt.length,result.originalPrompt.length-raw.length+result.previousDraftPromptView.length);assert.ok(result.prompt.length<=240000);
    // Preserve the recorded Node22 observation; different V8 native error suffixes
    // legitimately change the current diagnostic and therefore its actual hash.
    const observedView=result.previousDraftPromptView.replace(JSON.stringify(nativeParseError(extract(raw))),JSON.stringify(observedNode22ParseError));
    const marker='上一版完整 JSON 草稿（首次生成时为“无”）：\n\n';const offset=result.originalPrompt.indexOf(marker)+marker.length;assert.ok(offset>=marker.length);const observedPrompt=result.originalPrompt.slice(0,offset)+observedView+result.originalPrompt.slice(offset+raw.length);assert.equal(observedPrompt.length,192959);assert.equal(sha(observedPrompt),fixture.nativeSendPromptSha256);
    const vars=fixture.nativeFullPromptVariables;assert.equal(vars.sourceEvidence.length,174837);assert.equal(sha(vars.sourceEvidence),fixture.nativeSourceEvidenceSha256);assert.ok(result.originalPrompt.includes(vars.sourceEvidence)&&result.prompt.includes(vars.sourceEvidence));assert.equal(result.previousDraft,raw);assert.equal(fixture.nativePromptReconstruction.originalSignedDisplayMatchesActiveIdentity,true);
});
test('current registered v11 full renderer preserves real evidence and the diagnostic-only context limit',()=>{
    assert.equal(require(path.join(ROOT,'scripts/lib/prompt-text-versions')).currentTextStagePromptPath('apiReaderArticle'),'prompts/api-reader-article-v11.md');
    const result=nativeFullPrompt();assert.notEqual(result.originalPrompt,fixture.nativeOriginalPrompt);
    assert.ok(result.originalPrompt.includes('独立 PDF 引文只用于明确允许的恢复'));
    assert.ok(result.originalPrompt.includes(fixture.nativeFullPromptVariables.sourceEvidence)&&result.prompt.includes(fixture.nativeFullPromptVariables.sourceEvidence));
    assert.equal(result.previousDraft,raw);assert.equal(decode(result.previousDraftPromptView).rawSha256,sha(raw));
    assert.equal(result.prompt.length,result.originalPrompt.length-raw.length+result.previousDraftPromptView.length);assert.ok(result.prompt.length<=240000);
});
test('only previousDraft render variable changes in the actual full prompt',()=>{
    const result=nativeFullPrompt(),vars=fixture.nativeFullPromptVariables;const marker='上一版完整 JSON 草稿（首次生成时为“无”）：\n\n';const start=result.originalPrompt.indexOf(marker)+marker.length;assert.ok(start>=marker.length);const end=start+raw.length;assert.equal(result.originalPrompt.slice(start,end),raw);assert.equal(result.prompt,result.originalPrompt.slice(0,start)+result.previousDraftPromptView+result.originalPrompt.slice(end));
});
test('full canonical caller retains its hard cap when source evidence alone is too large',()=>{
    const source=fixture.nativeFullPromptVariables.sourceEvidence.repeat(2);assert.throws(()=>nativeFullPrompt({sourceEvidence:source}),/完整请求上下文超限/);assert.equal(fixture.nativeFullPromptVariables.sourceEvidence.length,174837);
});
test('full canonical caller never shortens valid JSON to evade its cap',()=>{
    const previousDraft=JSON.stringify(fixture.validRepairableDraft);const source=fixture.nativeFullPromptVariables.sourceEvidence.repeat(2);assert.throws(()=>nativeFullPrompt({sourceEvidence:source,previousDraft}),/完整请求上下文超限/);assert.doesNotThrow(()=>JSON.parse(previousDraft));
});

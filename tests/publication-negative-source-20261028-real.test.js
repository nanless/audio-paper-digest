'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib'),Module=require('node:module');
const ROOT=process.env.NEGATIVE_REAL_TEST_ROOT||path.resolve(__dirname,'..');
const fixturePath=process.env.NEGATIVE_REAL_FIXTURE||path.join(__dirname,'fixtures/publication-negative-source-20261028-real.json.gz');
const fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(fixturePath)));
const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'negative-real-portable-'))),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const python=require('node:child_process').execFileSync('bash',[path.join(ROOT,'scripts/python-runtime.sh'),'-c','import sys; print(sys.executable)'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim();
for(const dir of ['scripts','manual/scripts','config','prompts'])fs.cpSync(path.join(ROOT,dir),path.join(workspace,dir),{recursive:true,filter:p=>!p.includes('__pycache__')});
fs.mkdirSync(path.join(workspace,'.venv/bin'),{recursive:true});fs.writeFileSync(path.join(workspace,'.venv/bin/python'),'#!/bin/sh\nexec '+"'"+python.replaceAll("'","'\"'\"'")+"'"+' "$@"\n',{mode:0o700});
const probe=path.join(workspace,'scripts/negative_real_probe.py');
fs.writeFileSync(probe,String.raw`import os,sys,json
root=os.path.realpath(os.path.join(os.path.dirname(__file__),'..'))
def audit(event,args):
    if event=='open':
        name,mode,flags=args
        if isinstance(name,(str,bytes)) and ((isinstance(mode,str) and any(c in mode for c in 'wa+')) or flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)):
            if not os.path.realpath(name).startswith(root+os.sep): raise RuntimeError('TEST_PY_WRITE_OUTSIDE_TMP')
    if event in {'os.remove','os.rename','os.mkdir','os.rmdir','os.chmod','os.chown','os.truncate','os.utime','os.link','os.symlink'}: raise RuntimeError('TEST_PY_MUTATION_FORBIDDEN')
    if event.startswith('socket.') or event in {'subprocess.Popen','os.system','os.posix_spawn','os.exec'}: raise RuntimeError('TEST_PY_NETWORK_CHILD_FORBIDDEN')
sys.addaudithook(audit)
import publish_common as p
packet=json.load(os.fdopen(3))
helpers={'folded':p._source_bound_folded_objective_regression,'deadline':p._source_bound_deadline_f1_comparison,'acoustic':p._source_bound_matched_acoustic_gap,'notation':lambda r,t,s:p._source_bound_notation_roundtrip_regression(r,s)}
out=[]
for c in packet['helperCases']:
    tables=p.extract_markdown_tables(c['results'])
    out.append({'label':c['label'],'actual':helpers[c['kind']](c['results'],tables,c['source'])})
import ast,inspect
tree=ast.parse(inspect.getsource(p._validate_experiment_table_evidence_depth))
replacements=0
for statement in ast.walk(tree):
    if isinstance(statement,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='result_has_negative' for target in statement.targets):
        statement.value=ast.parse('_source_bound_folded_objective_regression(results,tables,complete_source_text) or _source_bound_deadline_f1_comparison(results,tables,complete_source_text) or _source_bound_matched_acoustic_gap(results,tables,complete_source_text) or _source_bound_notation_roundtrip_regression(results,complete_source_text)',mode='eval').body
        replacements+=1
assert replacements==1
ast.fix_missing_locations(tree)
scope=dict(p.__dict__)
exec(compile(tree,'<test-only-isolated-adverse-predicates>','exec'),scope)
integration=[{'label':c['label'],'issue':scope['_validate_experiment_table_evidence_depth'](c['analysis'],source_text=c['source'])} for c in packet['integrationCases']]
print(json.dumps({'helpers':out,'integration':integration}))
`);
require(path.join(ROOT,'tests/helpers/isolated-tmp-write-guard.cjs')).installTmpOnlyWriteGuard(workspace,{readOnlyPythonScripts:[probe]});
Object.assign(process.env,{PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(workspace,'pycache'),TMPDIR:workspace,TMP:workspace,TEMP:workspace});
const noNetwork=()=>{throw Error('TEST_NETWORK_FORBIDDEN');};
for(const [name,methods]of [['http',['request','get']],['https',['request','get']],['net',['connect','createConnection']],['tls',['connect']]])for(const method of methods)test.mock.method(require('node:'+name),method,noNetwork);global.fetch=noNetwork;
const file=path.join(workspace,'scripts/analysis-contract.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.negativeTestHelpers={folded:sourceBoundFoldedObjectiveRegression,deadline:sourceBoundDeadlineF1Comparison,acoustic:sourceBoundMatchedAcousticGap,notation:(r,t,s)=>sourceBoundNotationRoundtripRegression(r,s)};',file);
const api=m.exports,cases=[];
// Test-only isolate the four actual source-bound predicates at the existing
// negative-obligation seam; do not change source selection or other validators.
const original=fs.readFileSync(file,'utf8'),begin=original.indexOf('    const resultHasNegative = '),finish=original.indexOf('    if (empirical && sourceHasNegative && !resultHasNegative)',begin);
assert.ok(begin>0&&finish>begin);
const seam='    const resultHasNegative = sourceBoundFoldedObjectiveRegression(results,tables,options.sourceText) || sourceBoundDeadlineF1Comparison(results,tables,options.sourceText) || sourceBoundMatchedAcousticGap(results,tables,options.sourceText) || sourceBoundNotationRoundtripRegression(results,options.sourceText);\n';
const isolated=new Module(file,module);isolated.filename=file;isolated.paths=m.paths;isolated._compile(original.slice(0,begin)+seam+original.slice(finish),file);
function add(kind,label,base,mutate={},expected=false){cases.push({kind,label:kind+': '+label,results:mutate.results??base.results,source:mutate.source??base.source,expected});}
const byId=id=>fixture.cases.find(c=>c.id===id),folded=byId('2610.35144'),deadline=byId('2610.33113'),acoustic=byId('2610.33974');
for(const[kind,base,needle]of [['folded',folded,'普通组稀疏在三个实测结果上都优于按通道周期加权的组稀疏'],['deadline',deadline,'JIT-MPE 50 ms 相对自身整曲'],['acoustic',acoustic,'17 个孤立生成片段在 6 种固定声学描述中有 5 种仍可与自然 coda 区分']]){
    assert.ok(base.results.includes(needle),'actual saved claim '+kind);
    add(kind,'actual saved complete result',base,{},true);
    for(const prefix of ['假设','如果','未来实验','其他模型','并非','未观察到','引用','“'])add(kind,'result denies ownership '+prefix,base,{results:base.results.replace(needle,prefix+needle)});
    for(const heading of ['Previous work.','Future work.','Planned experiment.','Hypothetical experiment.','第三方：','相关工作：'])add(kind,'preceding local foreign/future heading '+heading,base,{results:base.results.replace(needle,'\n'+heading+'\n'+needle)});
    add(kind,'no source',base,{source:''});
    add(kind,'quoted result block',base,{results:'```\n'+base.results+'\n```'});
    add(kind,'HTML result quote',base,{results:'<blockquote>\n'+base.results+'\n</blockquote>'});
    add(kind,'claim omitted',base,{results:base.results.replace(needle,'该项比较的具体结论在此省略')});
    add(kind,'source wholly quoted',base,{source:'“'+base.source+'”'});
    add(kind,'source fenced',base,{source:'```\n'+base.source+'\n```'});
}
add('folded','wrong explicit source objective identity',folded,{source:folded.source.replace('Skip learns per-channel widths','Other learns per-channel widths')});
add('folded','source no longer reports adverse result',folded,{source:folded.source.replace('plain lasso performs better on all three measured outcomes','plain lasso performs worse on all three measured outcomes')});
add('folded','source hypothetical local measured paragraph',folded,{source:folded.source.replace('Table\u00a0I compares eight models','Hypothetical experiment.\nTable\u00a0I compares eight models')});
add('folded','wrong output method identity',folded,{results:folded.results.replace('| Skip-Plain |','| Other-Plain |')});
add('folded','wrong output training objective',folded,{results:folded.results.replace('存储加普通组稀疏','存储加其他组稀疏')});
add('folded','wrong metric direction',folded,{results:folded.results.replace('动态能耗 μJ/帧 ↓','动态能耗 μJ/帧 ↑')});
add('folded','wrong adverse quality direction',folded,{results:folded.results.replace('| 1.03 | 33.4 | 2.78 |','| 1.03 | 33.4 | 2.60 |')});
add('folded','three directions are semantic corroboration, not numerical authentication',folded,{results:folded.results.replace('| 1.03 | 33.4 | 2.78 |','| 1.00 | 30.0 | 2.80 |')},true);
add('folded','standalone result withdrawal',folded,{results:folded.results.replace('普通组稀疏在三个实测结果上都优于按通道周期加权的组稀疏，后者跳过 44.1% 乘累而前者跳过 47.3% 乘累。','普通组稀疏在三个实测结果上都优于按通道周期加权的组稀疏，后者跳过 44.1% 乘累而前者跳过 47.3% 乘累。\n\n上述比较结果已撤回。')});
add('folded','standalone source withdrawal',folded,{source:folded.source.replace('so the plain lasso performs better on all three measured outcomes in these runs.','so the plain lasso performs better on all three measured outcomes in these runs.\n\nThis comparison was withdrawn.')});
add('folded','standalone source experiment withdrawal',folded,{source:folded.source.replace('so the plain lasso performs better on all three measured outcomes in these runs.','so the plain lasso performs better on all three measured outcomes in these runs.\n\nThis experiment was withdrawn.')});
add('deadline','wrong method identity',deadline,{results:deadline.results.replaceAll('JIT-MPE 50 ms','Other-MPE 50 ms')});
add('deadline','wrong dataset column',deadline,{results:deadline.results.replace('AAM 留出 ↑','Other 留出 ↑')});
add('deadline','wrong metric direction',deadline,{results:deadline.results.replace('AAM 留出 ↑','AAM 留出 ↓')});
add('deadline','wrong deadline',deadline,{results:deadline.results.replaceAll('JIT-MPE 50 ms','JIT-MPE 60 ms')});
add('deadline','same delta shifted output absolute values',deadline,{results:deadline.results.replace('82.58%','83.58%').replace('83.85%','84.85%')});
add('deadline','same delta shifted source absolute values',deadline,{source:deadline.source.replace('\n82.58\n','\n83.58\n').replace('\n83.85\n','\n84.85\n')});
add('deadline','source caption wrong metric',deadline,{source:deadline.source.replace('Table 2: Accuracy at the deadline, on the primary truth of each set; all rows are our models. Each cell gives the recording-level macro F1 (%)','Table 2: Accuracy at the deadline, on the primary truth of each set; all rows are our models. Each cell gives the recording-level macro F2 (%)')});
add('deadline','source dataset swapped',deadline,{source:deadline.source.replace('\nAAM\nChoraleBricks\n','\nOther\nChoraleBricks\n')});
add('deadline','source table boundary injected',deadline,{source:deadline.source.replace('\n83.85\n','\nTable 99: unrelated table\n83.85\n')});
add('deadline','wrong reported adverse delta',deadline,{results:deadline.results.replace('AAM -1.27','AAM -1.28')});
add('deadline','source reversed costs',deadline,{source:deadline.source.replace('lookahead costs 1.27 points on AAM','lookahead gains 1.27 points on AAM')});
add('acoustic','wrong source method name',acoustic,{source:acoustic.source.replaceAll('WhAM produces recognizable','Other produces recognizable')});
add('acoustic','wrong output denominator',acoustic,{results:acoustic.results.replace('17 个孤立生成片段在 6 种','17 个孤立生成片段在 7 种')});
add('acoustic','wrong source count',acoustic,{source:acoustic.source.replace('uses 17 generated clips','uses 18 generated clips')});
add('acoustic','standalone result withdrawal',acoustic,{results:acoustic.results.replace('17 个孤立生成片段在 6 种固定声学描述中有 5 种仍可与自然 coda 区分','17 个孤立生成片段在 6 种固定声学描述中有 5 种仍可与自然 coda 区分。\n\n上述比较结果已撤回')});
add('acoustic','standalone source withdrawal',acoustic,{source:acoustic.source.replaceAll('independent natural reference groups.','independent natural reference groups.\n\nThis comparison was withdrawn.')});
add('acoustic','standalone result experiment withdrawal',acoustic,{results:acoustic.results.replace('17 个孤立生成片段在 6 种固定声学描述中有 5 种仍可与自然 coda 区分','17 个孤立生成片段在 6 种固定声学描述中有 5 种仍可与自然 coda 区分。\n\nThis experiment was withdrawn.')});
for(const c of fixture.notationCases)add('notation',c.name,byId('2610.34247'),{results:c.results,source:c.source},c.expected);
const notation=byId('2610.34247');for(const heading of ['Previous work.','Future work.','Planned experiment.','Hypothetical experiment.'])add('notation','source preceding framework '+heading,notation,{source:notation.source.replace('The ablation confirms that notation matters:',heading+'\nThe ablation confirms that notation matters:')});
add('deadline','lexically changed source-backed F1 value',deadline,{results:deadline.results.replace('82.58%','82.580%')});
const integrationCases=[];
const claims={
 '2610.35144':'普通组稀疏在三个实测结果上都优于按通道周期加权的组稀疏',
 '2610.33113':'JIT-MPE 50 ms 相对自身整曲',
 '2610.33974':'17 个孤立生成片段在 6 种固定声学描述中有 5 种仍可与自然 coda 区分',
 '2610.34247':'消融将同一乐谱先转 MIDI 再转回 MusicXML 后，MxlTok 性能回落到 MIDI 水平，支持优势来自记谱内容而非分词技巧本身'};
for(const c of fixture.cases){
 assert.ok(c.analysis.includes(claims[c.id]),'actual analysis claim '+c.id);
 integrationCases.push({label:c.id+' real full-depth isolated predicates',analysis:c.analysis,source:c.source,expected:null});
 integrationCases.push({label:c.id+' omitted adverse claim with other generic words retained',analysis:c.analysis.replace(claims[c.id],c.id==='2610.34247'?'本次消融比较的结论在此省略':'本次关键比较的结论在此省略'),source:c.source,expected:'全文包含退化、不显著或失败结果，但实验结果没有保留负面证据'});
}
const packetFile=path.join(workspace,'packet.json');fs.writeFileSync(packetFile,JSON.stringify({helperCases:cases,integrationCases}));const fd=fs.openSync(packetFile,'r');
let pythonResults;try{pythonResults=JSON.parse(require('node:child_process').execFileSync('bash',[path.join(workspace,'scripts/python-runtime.sh'),probe,'3'],{cwd:workspace,encoding:'utf8',stdio:['pipe','pipe','pipe',fd],maxBuffer:4*1024*1024}));}finally{fs.closeSync(fd);}
test.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
test('actual saved fixture hashes and scope exclude credentials and canonical writes',()=>{for(const c of fixture.cases){assert.equal(hash(c.source),c.sourceSha256);assert.equal(hash(c.analysis),c.analysisSha256);assert.doesNotMatch(JSON.stringify(c),/Bearer\s+[A-Za-z0-9._-]{16,}|\bsk-[A-Za-z0-9_-]{20,}/);}});
for(const[cIndex,c]of cases.entries())test(c.label,()=>{const actual=api.negativeTestHelpers[c.kind](c.results,api.extractMarkdownTables(c.results),c.source);assert.equal(actual,c.expected,'Node');assert.equal(pythonResults.helpers[cIndex].actual,c.expected,'Python');assert.equal(pythonResults.helpers[cIndex].label,c.label);});
for(const[i,c]of integrationCases.entries())test(c.label,()=>{assert.equal(isolated.exports.validateExperimentTableEvidenceDepth(c.analysis,{sourceText:c.source}),c.expected,'Node isolated negative seam');assert.equal(pythonResults.integration[i].issue,c.expected,'Python isolated negative seam');});
test('all four actual saved full table-depth contracts pass normal Node pure API',()=>{for(const c of fixture.cases)assert.equal(api.validateExperimentTableEvidenceDepth(c.analysis,{sourceText:c.source}),null,c.id);});

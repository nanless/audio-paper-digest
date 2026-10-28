'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib');
const ROOT=process.env.STAR_VIEW_TEST_ROOT||path.resolve(__dirname,'..');
const fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(process.env.STAR_VIEW_FIXTURE||path.join(__dirname,'fixtures/reader-technical-star-publication-view-real.json.gz'))));
const workspace=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'technical-star-portable-')));
const python=require('node:child_process').execFileSync('bash',[path.join(ROOT,'scripts/python-runtime.sh'),'-c','import sys; print(sys.executable)'],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}).trim();
for(const dir of ['scripts','manual/scripts','config','prompts'])fs.cpSync(path.join(ROOT,dir),path.join(workspace,dir),{recursive:true,filter:p=>!p.includes('__pycache__')});
fs.mkdirSync(path.join(workspace,'.venv/bin'),{recursive:true});fs.writeFileSync(path.join(workspace,'.venv/bin/python'),'#!/bin/sh\nexec '+"'"+python.replaceAll("'","'\"'\"'")+"'"+' "$@"\n',{mode:0o700});
const probe=path.join(workspace,'scripts/technical_star_view_probe.py');fs.writeFileSync(probe,String.raw`import os,sys,json
root=os.path.realpath(os.path.join(os.path.dirname(__file__),'..'))
def audit(event,args):
    if event=='open':
        name,mode,flags=args
        if isinstance(name,(str,bytes)) and ((isinstance(mode,str) and any(c in mode for c in 'wa+')) or flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)):
            if os.path.realpath(name)!=root and not os.path.realpath(name).startswith(root+os.sep): raise RuntimeError('TEST_STAR_OUTSIDE_WRITE')
    if event.startswith('socket.') or event in {'subprocess.Popen','os.system','os.posix_spawn','os.remove','os.rename','os.rmdir','os.mkdir','os.chmod','os.chown','os.truncate','os.link','os.symlink'}: raise RuntimeError('TEST_STAR_SIDE_EFFECT_FORBIDDEN')
sys.addaudithook(audit)
from publish_common import is_publication_technical_asterisk_cell_view,escape_technical_notation_asterisks
cases=json.load(os.fdopen(3))
print(json.dumps([{'actual':is_publication_technical_asterisk_cell_view(c['canonical'],c['displayed'],c['source']),'sanitizer':escape_technical_notation_asterisks(c['canonical'])} for c in cases]))
`);
require(path.join(ROOT,'tests/helpers/isolated-tmp-write-guard.cjs')).installTmpOnlyWriteGuard(workspace,{readOnlyPythonScripts:[probe]});
Object.assign(process.env,{PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(workspace,'pycache'),TMPDIR:workspace,TMP:workspace,TEMP:workspace});
const forbidden=()=>{throw Error('TEST_STAR_NETWORK_FORBIDDEN');};for(const[n,methods]of [['http',['request','get']],['https',['request','get']],['net',['connect','createConnection']],['tls',['connect']]])for(const method of methods)test.mock.method(require('node:'+n),method,forbidden);global.fetch=forbidden;
const span=require(path.join(workspace,'scripts/lib/reader-dom-span-projection'));
const cases=[];function add(label,canonical,displayed,expected,source=canonical){cases.push({label,canonical,displayed,source,expected});}
const trueCell=fixture.binding.cellBindings.find(c=>c.renderedRow===1&&c.renderedColumn===7);assert.equal(trueCell.renderedText,'T5* Time');assert.equal(trueCell.sourceText,'T5* Time');
add('actual bound technical heading','T5* Time','T5\\* Time',true);
add('same existing plain technical-token rule','H1*-H2*','H1\\*-H2\\*',true);
add('two exact technical tokens','T1* and T2*','T1\\* and T2\\*',true);
add('unchanged canonical is not a new display projection','T5* Time','T5* Time',false);
add('missing source star cannot borrow stripped-star normalization','T5* Time','T5\\* Time',false,'T5 Time');
add('wrong source technical token','T5* Time','T5\\* Time',false,'T6* Time');
add('source extra star','T5* Time','T5\\* Time',false,'T5** Time');
add('different source cell text','T5* Time','T5\\* Time',false,'T5* Other');
add('changed displayed token','T5* Time','T6\\* Time',false);
add('extra backslash','T5* Time','T5\\\\* Time',false);
add('unrelated backslash','T5* Time','T5\\* Time\\',false);
add('unrelated changed number','T5* Time 10','T5\\* Time 11',false);
add('deleted text','T5* Time','T5\\*',false);
add('already escaped canonical','T5\\* Time','T5\\\\* Time',false);
add('bare arbitrary star','value*','value\\*',false);
add('emphasis is not a technical token','*T5*','\\*T5\\*',false);
add('strong emphasis is outside the plain-cell subset','**T5* Time**','**T5\\* Time**',false);
add('code is outside the plain-cell subset','`T5*`','`T5\\*`',false);
add('math is outside the plain-cell subset','$T5*$','$T5\\*$',false);
add('link is outside the plain-cell subset','[T5*](https://example.com)','[T5\\*](https://example.com)',false);
add('HTML is outside the plain-cell subset','<b>T5*</b>','<b>T5\\*</b>',false);
add('nontechnical extra star','T5* Time *','T5\\* Time \\*',false);
add('Unicode letter does not create a Python word boundary','αT5*','αT5\\*',false);
add('foreign Unicode numeric token stays outside the ASCII subset','T٥*','T٥\\*',false);
const input=path.join(workspace,'input.json');fs.writeFileSync(input,JSON.stringify(cases));const fd=fs.openSync(input,'r');let py;try{py=JSON.parse(require('node:child_process').execFileSync('bash',[path.join(workspace,'scripts/python-runtime.sh'),probe,'3'],{cwd:workspace,encoding:'utf8',stdio:['pipe','pipe','pipe',fd],maxBuffer:1024*1024}));}finally{fs.closeSync(fd);}
test.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
for(const[i,c]of cases.entries())test(c.label,()=>{assert.equal(span.isPublicationTechnicalAsteriskCellView(c.canonical,c.displayed,c.source),c.expected,'Node exact view');assert.equal(py[i].actual,c.expected,'Python exact view');if(c.expected)assert.equal(py[i].sanitizer,c.displayed,'actual publisher sanitizer');});
function accepted(table,binding,rendered){return binding.cellBindings.filter(cell=>{const rows=[rendered.header,...rendered.rows];return span.fullWidthLabelBlankMatches(table,binding,cell,rows[cell.renderedRow]?.[cell.renderedColumn],rendered);}).map(c=>[c.renderedRow,c.renderedColumn]);}
test('real saved and final table retain exactly the same 30 full-DOM blank-span cells',()=>{const before=JSON.stringify(fixture),saved=accepted(fixture.sourceTable,fixture.binding,fixture.savedTable),final=accepted(fixture.sourceTable,fixture.binding,fixture.finalTable);assert.equal(saved.length,30);assert.deepEqual(final,saved);assert.equal(JSON.stringify(fixture),before);});
test('whole-table source projection still rejects changed numeric and erased data cells',()=>{for(const value of ['99.9','']){const rendered=structuredClone(fixture.finalTable);assert.equal(rendered.rows[3][3],'22.5');rendered.rows[3][3]=value;assert.deepEqual(accepted(fixture.sourceTable,fixture.binding,rendered),[]);}});
test('whole-table projection rejects double escape and wrong technical token',()=>{for(const value of ['T5\\\\* Time','T6\\* Time']){const rendered=structuredClone(fixture.finalTable);rendered.rows[0][7]=value;assert.deepEqual(accepted(fixture.sourceTable,fixture.binding,rendered),[]);}});
test('whole-table projection retains raw source DOM and unique cell identity checks',()=>{for(const field of ['sourceText','sourceDomSha256']){const binding=structuredClone(fixture.binding),cell=binding.cellBindings.find(c=>c.renderedRow===1&&c.renderedColumn===7);cell[field]=field==='sourceText'?'T5 Time':'0'.repeat(64);assert.deepEqual(accepted(fixture.sourceTable,binding,fixture.finalTable),[]);}const duplicate=structuredClone(fixture.binding);duplicate.cellBindings.push(structuredClone(duplicate.cellBindings[0]));assert.deepEqual(accepted(fixture.sourceTable,duplicate,fixture.finalTable),[]);});

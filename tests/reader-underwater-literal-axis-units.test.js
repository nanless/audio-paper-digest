'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const scripts=path.join(root,'scripts');
const fixtureFile=path.join(__dirname,'fixtures/reader-underwater-2610.31346-page12.json');
const pdfFile=path.join(__dirname,'fixtures/reader-underwater-2610.31346-page12.pdf');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const python=String.raw`
import sys,json,hashlib,importlib.util,copy,fitz
from pathlib import Path
scripts,helpers,fixture_file,pdf_file=sys.argv[1:]
sys.path.insert(0,helpers)
spec=importlib.util.spec_from_file_location('literal_under_test',Path(scripts)/'reader_sealed_pdf_literal_column_units.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
f=json.loads(Path(fixture_file).read_text());raw=Path(pdf_file).read_bytes()
assert hashlib.sha256(raw).hexdigest()==f['excerptPdfSha256']
assert f['notAuthorization'] is True
positive=[];negative=0
for table in f['papers']:
 p=m.prove_pdf_bytes(raw,table['view'],[table['quote']]);positive.append({'table':table['tableNumber'],'profile':p['axisProfile'],'columns':[[v['column'],v['unit']] for v in p['units']]})
 assert p['viewSha256']==m.stable(table['view']) and p['valueOrigin']=='sealed_pdf'
 assert p['rowIdentities']==[[r[0]] for r in table['view'][1:]]
 def denied(view=None,quotes=None,data=None):
  global negative
  try:m.prove_pdf_bytes(raw if data is None else data,table['view'] if view is None else view,[table['quote']] if quotes is None else quotes)
  except ValueError:negative+=1
  else:raise AssertionError('wrong table/row/value/unit/source was accepted')
 bad=copy.deepcopy(table['view']);bad[1][1]='99.99';denied(bad)
 bad=copy.deepcopy(table['view']);bad[1],bad[2]=bad[2],bad[1];denied(bad)
 bad=copy.deepcopy(table['view']);bad.pop();denied(bad)
 bad=copy.deepcopy(table['view']);bad[0][1]='Pd (dB)';denied(bad)
 bad=copy.deepcopy(table['view']);bad[0][1]='Pd';denied(bad)
 bad=copy.deepcopy(table['view']);bad[1][1]+='%';denied(bad)
 denied(quotes=[f['papers'][1 if table['tableNumber']==5 else 0]['quote']])
 denied(quotes=[table['quote'].split('White noise')[0] if table['tableNumber']==5 else table['quote'].split('Overall')[0]])
 # Duplicate the exact same original page: quotes and complete source grid
 # must remain unique; no selection by candidate result values is permitted.
 original=fitz.open(stream=raw,filetype='pdf');duplicate=fitz.open();duplicate.insert_pdf(original);duplicate.insert_pdf(original)
 denied(data=duplicate.tobytes(garbage=4,deflate=True))
 # Remove the original Pd unit from the observed physical PDF header. The
 # same candidate/quote cannot borrow it from the other table or body text.
 changed=fitz.open(stream=raw,filetype='pdf');page=changed[0]
 proof=m.prove_pdf_bytes(raw,table['view'],[table['quote']]);unit_words=proof['cells'][1]['words']
 percent=[w for w in unit_words if '%' in w[4]];assert percent
 for word in percent:page.add_redact_annot(fitz.Rect(word[:4]),fill=(1,1,1))
 page.apply_redactions(images=0,graphics=0);denied(data=changed.tobytes(garbage=4,deflate=True))
 if table['tableNumber']==6:
  assert [0,'db'] in positive[-1]['columns']
  bad=copy.deepcopy(table['view']);bad[2][0]='−15';denied(bad)
  bad=copy.deepcopy(table['view']);bad[1][0]='Other condition';denied(bad)
  bad=copy.deepcopy(table['view']);bad[1][4],bad[1][5]=bad[1][5],bad[1][4];denied(bad)
  bad=copy.deepcopy(table['view']);bad[0][7]='SNR MAE (%)';denied(bad)
print(json.dumps({'realPositiveTables':positive,'negativeCasesRejected':negative,'notAuthorization':True}))
`;
test('真实PDF页12的Background/SNR完整网格证明原单位，错表错行错值错单位与重复原表均拒绝',()=>{
 require('../scripts/env-loader').requireExternalRuntime('reader-real-underwater-axis-unit-test');
 const fixture=JSON.parse(fs.readFileSync(fixtureFile));assert.equal(sha(fs.readFileSync(pdfFile)),fixture.excerptPdfSha256);
 assert.equal(fixture.originalFullPdfSha256,'979fea11022e418b10b92cab6ac11f84de78e6e85f8dd2e66d8e4155270a14da');
 const result=JSON.parse(execFileSync('bash',[path.join(root,'scripts/python-runtime.sh'),'-c',python,scripts,path.join(root,'scripts'),fixtureFile,pdfFile],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}));
 assert.equal(result.notAuthorization,true);assert.equal(result.realPositiveTables.length,2);assert(result.negativeCasesRejected>=24);
 assert.deepEqual(result.realPositiveTables[0].columns,[[1,'%']]);
 assert.deepEqual(result.realPositiveTables[1].columns,[[0,'db'],[1,'%'],[2,'%'],[4,'%'],[5,'%'],[6,'%'],[7,'db']]);
});
test('JS来源边界仅接受真实SNR完整首轴的列0 dB，不扩给Background/别轴/别单位',()=>{
 const file=path.join(scripts,'lib/reader-sealed-pdf-column-units.js');
 const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));
 compiled._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.allowedLiteralColumn=literalUnitColumnAllowed;',file);
 const allow=compiled.exports.allowedLiteralColumn,proof={axisProfile:'complete-literal-snr-axis-v1',identityColumns:[0]};
 assert.equal(allow(proof,[['SNR (dB)','Pd (%)']],{column:0,unit:'db'}),true);
 for(const p of [{...proof,axisProfile:'complete-literal-background-axis-v1'},{...proof,identityColumns:[1]},{}])assert.equal(allow(p,[['SNR (dB)','Pd (%)']],{column:0,unit:'db'}),false);
 assert.equal(allow(proof,[['Background','Pd (%)']],{column:0,unit:'db'}),false);
 assert.equal(allow(proof,[['SNR (dB)','Pd (%)']],{column:0,unit:'%'}),false);
 assert.equal(allow(proof,[['SNR (dB)','Pd (%)']],{column:-1,unit:'db'}),false);
});

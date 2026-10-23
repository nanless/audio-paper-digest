'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),scripts=path.join(root,'scripts');
const fixture=path.join(__dirname,'fixtures/reader-perch-2610.29572-page6.json');
const pdf=path.join(__dirname,'fixtures/reader-perch-2610.29572-page6.pdf');
const python=String.raw`
import sys,json,copy,hashlib,importlib.util,fitz
from pathlib import Path
scripts,helpers,fixture,pdf=sys.argv[1:];sys.path.insert(0,helpers)
s=importlib.util.spec_from_file_location('literal_under_test',Path(scripts)/'reader_sealed_pdf_literal_column_units.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
f=json.loads(Path(fixture).read_text());raw=Path(pdf).read_bytes();view=f['view'];quote=f['quote'];assert hashlib.sha256(raw).hexdigest()==f['excerptPdfSha256']
p=m.prove_pdf_bytes(raw,view,[quote]);assert p['headerProfile']=='complete-frame-frequency-parent-leaf-v1'
assert p['identityColumns']==[0,1,2] and p['rowIdentities']==[row[:3] for row in view[1:]]
assert p['daggerFootnote']==['† Default input representation of Perch.']
assert [[v['column'],v['unit']]for v in p['units']]==[[1,'hz'],[2,'hz']]
assert p['rowIdentities'][1][0]==p['rowIdentities'][8][0]=='640' and p['rowIdentities'][1]!=p['rowIdentities'][8]
rejected=0
def denied(v=None,q=None,data=None):
 global rejected
 try:m.prove_pdf_bytes(raw if data is None else data,view if v is None else v,[quote] if q is None else q)
 except ValueError:rejected+=1
 else:raise AssertionError('wrong parent, child, unit, condition, value or quote accepted')
for c,to in [(1,'Frequency Min (kHz)'),(2,'Frequency Max (s)'),(1,'Frequency (Hz)'),(1,'Other Min (Hz)'),(0,'Frame')]:
 v=copy.deepcopy(view);v[0][c]=to;denied(v)
v=copy.deepcopy(view);v[0][1],v[0][2]=v[0][2],v[0][1];denied(v)
v=copy.deepcopy(view);v[1][1],v[1][2]=v[1][2],v[1][1];denied(v)
v=copy.deepcopy(view);v[1][0]='640';denied(v) # exact dagger cannot disappear
v=copy.deepcopy(view);v[2][:3]=v[9][:3];denied(v) # same frame, wrong frequency group
v=copy.deepcopy(view);v[2][3],v[9][3]=v[9][3],v[2][3];denied(v) # results never choose rows
v=copy.deepcopy(view);v[2],v[9]=v[9],v[2];denied(v)
v=copy.deepcopy(view);v.pop();denied(v)
v=copy.deepcopy(view);[row.pop()for row in v];denied(v)
v=copy.deepcopy(view);v[13][4]='0.999';denied(v)
v=copy.deepcopy(view);v[1][1]='0.060';v[1][2]='16';denied(v) # no rescaling units
v=copy.deepcopy(view);v[1][1]+=' Hz';denied(v) # no invented per-cell units
denied(q=[])
denied(q=[quote.split('† Default')[0]]) # footer is part of complete bound original
denied(q=[quote.split('32768 0 1000')[0]])
denied(q=['TABLE IV: A different experiment has Frequency (Hz), Min and Max.'])
doc=fitz.open(stream=raw,filetype='pdf');double=fitz.open();double.insert_pdf(doc);double.insert_pdf(doc);denied(data=double.tobytes(garbage=4,deflate=True))
# Keep Hz available in the page prose, but remove it from the true parent
# header and bind the resulting actual continuous table quote. Caption/prose
# units cannot grant either Min or Max a unit without the parent declaration.
for token in ['(Hz)','Min']:
 changed=fitz.open(stream=raw,filetype='pdf');page=changed[0]
 header=[w for w in p['words']if w[4]==token and w[1]<p['rowBoundaries'][0]];assert len(header)==1
 page.add_redact_annot(fitz.Rect(header[0][:4]),fill=(1,1,1));page.apply_redactions(images=0,graphics=0)
 data=changed.tobytes(garbage=4,deflate=True);raw_text=m.extract_pdf_quote_document(data)['normalizedFullText']
 start=raw_text.index('TABLE III:');end=raw_text.index('† Default input representation of Perch.',start)+len('† Default input representation of Perch.')
 denied(data=data,q=[raw_text[start:end]])
print(json.dumps({'notAuthorization':True,'positiveRows':len(p['rows']),'unitCells':sum(len(v['values'])for v in p['units']),'negativeCasesRejected':rejected}))
`;
test('真实Perch完整Frame/Frequency父子表头证明30个Hz值，23种错父子/组/单位/值/引文均拒',()=>{
 require('../scripts/env-loader').requireExternalRuntime('real-perch-frequency-parent-unit-test');
 const f=JSON.parse(fs.readFileSync(fixture));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(pdf)).digest('hex'),f.excerptPdfSha256);
 assert.equal(f.originalFullPdfSha256,'ee53e01488455ffa87fdbda5f08fa20aeaf3b5746e77a8cdcb4b2e5148025b44');
 const r=JSON.parse(execFileSync('bash',[path.join(root,'scripts/python-runtime.sh'),'-c',python,scripts,path.join(root,'scripts'),fixture,pdf],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}));
 assert.equal(r.notAuthorization,true);assert.equal(r.positiveRows,15);assert.equal(r.unitCells,30);assert(r.negativeCasesRejected>=23);
});

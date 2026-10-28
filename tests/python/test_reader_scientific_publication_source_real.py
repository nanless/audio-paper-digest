"""Real paid draft/PDF publication source subgate; never production completion.
The original six ACKs and source bundle live in the shared glyph fixture. Only
TemporaryDirectory copies are written; no model, fee or budget writer is used.
"""
import base64
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
sys.path.insert(0,str(ROOT/'scripts'))
BASE=Path(__file__).resolve().parents[1]/'fixtures'
def sha(raw):return hashlib.sha256(raw).hexdigest()
def deny(*args,**kwargs):raise RuntimeError('publication source fixture forbids network/model/subprocess')
source_raw=(BASE/'reader-scientific-glyph-35042-real.json.gz').read_bytes()
assert sha(source_raw)=='dfd94d0b1b125f80242c1b48ec80e461f55cbd60cba0b461339519207a7f5ce7'
fixture=json.loads(gzip.decompress(source_raw))
normal_raw=(BASE/'reader-scientific-publication-35042-normal.json.gz').read_bytes()
assert sha(normal_raw)=='cc6cb9ca333bf77c4681811fe147dd75b2b61b9af1c4431bfbd4e394f43ebaaa'
normal=json.loads(gzip.decompress(normal_raw))
assert normal['notOfficialCompletion'] and normal['notNewPaid']
# Read the real module without touching credentials, the canonical .env mode,
# or a logging/fee path. All validators below remain their actual implementation.
import project_env
pub=types.ModuleType('scientific_publication_source_subgate')
pub.__file__=str(ROOT/'scripts/publish-to-blog.py')
with mock.patch.object(project_env,'load_project_env',lambda *a,**k:{}),mock.patch.object(socket.socket,'connect',deny),mock.patch.object(subprocess,'Popen',deny):
 exec(compile(Path(pub.__file__).read_bytes(),pub.__file__,'exec'),pub.__dict__)
pub.call_publish_llm_api=deny
import reader_sealed_pdf_quote_evidence as glyph

class ScientificPublication(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  global paper,stage,plan,original_status
  cls.temporary=tempfile.TemporaryDirectory(prefix='reader-scientific-publication-')
  cls.addClassCleanup(cls.temporary.cleanup)
  runs=Path(cls.temporary.name)/'runs';run_id=fixture['paper']['freshRewriteProvenance']['runId']
  source_dir=runs/run_id/'sources/2610.35042/generation-000001'
  source_dir.mkdir(parents=True,mode=0o700)
  for name,record in fixture['sourceFiles'].items():
   assert name in ('source.pdf','source.txt','source-runtime.json','source-manifest.json')
   raw=base64.b64decode(record['base64'],validate=True)
   assert sha(raw)==record['sha256']
   target=source_dir/name;target.write_bytes(raw);target.chmod(0o600)
  run_bytes=base64.b64decode(fixture['sourceRun']['base64'],validate=True)
  assert sha(run_bytes)==fixture['sourceRun']['sha256']
  run_file=runs/run_id/'run.json';run_file.write_bytes(run_bytes);run_file.chmod(0o600)
  cls.pdf_bytes=(source_dir/'source.pdf').read_bytes()
  cls.source_patch=mock.patch.object(pub,'DAILY_FRESH_SOURCE_RUNS_DIR',runs);cls.source_patch.start();cls.addClassCleanup(cls.source_patch.stop)
  cls.net_patch=mock.patch.object(socket.socket,'connect',deny);cls.net_patch.start();cls.addClassCleanup(cls.net_patch.stop)
  cls.child_patch=mock.patch.object(subprocess,'Popen',deny);cls.child_patch.start();cls.addClassCleanup(cls.child_patch.stop)
  paper=copy.deepcopy(fixture['paper']);original_status=paper['analysisManifest']['stages']['apiReaderArticle']['status']
  assert original_status==normal['originalStageStatus']=='invalid_output'
  paper['apiReaderArticle']=normal['article'];paper['apiReaderPlan']=copy.deepcopy(normal['plan']);plan=paper['apiReaderPlan']
  paper['analysisManifest']['contracts']['apiReaderSourceBindings']=plan['sourceBindingsContract']
  stage=paper['analysisManifest']['stages']['apiReaderArticle']
  # Derived source-binding test fields only: no complete status, new grant or fee.
  stage.update(sourceBindingsContractVersion=plan['sourceBindingsContract'],sourceBindingsSha256=plan['sourceBindingsSha256'],
   sourceBindingsSourceTextSha256=paper['sourceSha256'],structuredArtifactsSha256=paper['structuredArtifactsSha256'],
   tableBindingCount=len(plan['tableBindings']),formulaBindingCount=len(plan['formulaBindings']))
  cls.caps={};cls.old_quotes=pub._verify_reader_sealed_pdf_quote_bindings(paper)
  cls.quotes=pub._verify_reader_sealed_pdf_quote_bindings(paper,scientific_capabilities=cls.caps)
  cls.binding=plan['tableBindings'][0];cls.table=copy.deepcopy(fixture['table'])
  cls.corpus=[q['quote'] for q in cls.binding['sourceQuotes']]+cls.quotes[1]
  assert cls.old_quotes==cls.quotes and cls.caps

 def project(self,table=None,cap=None,binding=None,quotes=None):
  return pub._api_reader_scientific_quote_projection(table or self.table,quotes or self.corpus,
   scientific_pdf_capability=self.caps[1] if cap is None else cap,source_binding=self.binding if binding is None else binding)

 def test_actual_three_role_schedule_and_old_document_proof_bytes(self):
  paid=normal['paidParseOutcomes']
  self.assertEqual([item['requestId']for item in paid],[item['requestId']for item in fixture['allPaid']])
  self.assertEqual([item['passed']for item in paid],[False,False,False,False,False,True])
  self.assertTrue(all(item.get('message')for item in paid[:-1]))
  result=self.project();self.assertFalse(result['failures'])
  self.assertEqual([(p['row'],p['column'],p['role'],p['signedExponent'])for p in result['proofs']],[(1,1,'SFT','-4'),(2,1,'RL-Stage I','-6'),(3,1,'RL-Stage II','-6')])
  self.assertTrue(all(p['origin']=='verified_pdf_glyph' for p in result['proofs']))
  pdf=self.pdf_bytes;old_doc=glyph.extract_pdf_quote_document(pdf);new_doc=glyph.extract_pdf_quote_document(pdf)
  self.assertEqual(glyph.stable(old_doc),fixture['legacyDocumentCanonicalSha256'])
  for index,q in enumerate([proof['quote']for proof in self.binding['sealedPdfQuoteEvidence']]):
   self.assertEqual(glyph.stable(glyph.quote_evidence(new_doc,q)),fixture['legacyQuoteEvidenceCanonicalSha256'][index])
  self.assertEqual(json.loads(json.dumps(self.binding['sealedPdfQuoteEvidence'])),[glyph.quote_evidence(new_doc,q)for q in [proof['quote'] for proof in self.binding['sealedPdfQuoteEvidence']]])

 def test_plain_html_or_copied_json_or_bare_boolean_cannot_grant(self):
  without=pub._api_reader_scientific_quote_projection(self.table,self.corpus)
  self.assertEqual(len(without['failures']),3)
  for bad in [True,False,{},self.binding['sealedPdfQuoteEvidence'],glyph.extract_pdf_scientific_quantities(self.pdf_bytes,[proof['quote'] for proof in self.binding['sealedPdfQuoteEvidence']]),pub._ReaderScientificPdfQuoteCapability()]:
   with self.assertRaises(pub.PublishDataValidationError):self.project(cap=bad)
  with self.assertRaises(pub.PublishDataValidationError):self.project(binding=copy.deepcopy(self.binding))
  with self.assertRaises(pub.PublishDataValidationError):self.project(quotes=['We use other rates, none of the complete original quotation.'])

 def test_wrong_role_quantity_unit_precision_or_incomplete_table_fails_closed(self):
  variants=[]
  for value in ['1×10−6','-1×10−4','1.0×10−4','1×10−4 ms','1×10−4†']:
   t=copy.deepcopy(self.table);t['rows'][0][1]=value;variants.append(t)
  t=copy.deepcopy(self.table);t['rows'][0],t['rows'][1]=t['rows'][1],t['rows'][0];variants.append(t)
  t=copy.deepcopy(self.table);t['rows']=t['rows'][:2];variants.append(t)
  t=copy.deepcopy(self.table);t['header'][1]='Learning rate';variants.append(t)
  for t in variants:
   t['markdown']='\n'.join(['| '+' | '.join(t['header'])+' |','| --- | --- | --- | --- |']+['| '+' | '.join(r)+' |'for r in t['rows']])
   with self.subTest(rows=t['rows']):
    result=self.project(t);self.assertTrue(result['failures']);self.assertFalse(any(p.get('origin')=='verified_pdf_glyph'for p in result['proofs']))

 def test_other_numeric_columns_remain_strict_and_full_publication_source_binding_subgate(self):
  original=self.project();other_tokens={t for row in self.table['rows']for col in [0,2,3]for t in pub._api_reader_numeric_tokens(row[col])}
  self.assertTrue(other_tokens.issubset(original['tokens']))
  pub._validate_api_reader_source_bindings(paper)
  self.assertEqual(stage['status'],original_status)
  self.assertNotEqual(stage['status'],'complete')

 def test_cross_paper_binding_and_source_mutation_rejected(self):
  old=paper['arxivId'];paper['arxivId']='2610.99999'
  try:
   with self.assertRaises(pub.PublishDataValidationError):self.project()
  finally:paper['arxivId']=old
  pdf=pub.DAILY_FRESH_SOURCE_RUNS_DIR/paper['freshRewriteProvenance']['runId']/'sources'/'2610.35042'/'generation-000001'/'source.pdf';raw=pdf.read_bytes()
  try:
   pdf.write_bytes(raw+b'\n')
   with self.assertRaises(pub.PublishDataValidationError):self.project()
  finally:pdf.write_bytes(raw)

if __name__=='__main__':
 unittest.main(verbosity=2)

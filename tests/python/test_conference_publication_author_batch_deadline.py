import ast, pathlib, unittest, types, tempfile, json, os, shutil
ROOT=pathlib.Path(__file__).resolve().parents[2]
CANDIDATE=ROOT/'scripts/publish-conference.py'
class PublicationError(Exception): pass
class BatchDeadlineTests(unittest.TestCase):
 def setUp(self):
  tree=ast.parse(CANDIDATE.read_text()); node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='verify_process_author_sources')
  self.calls=[];self.reply=types.SimpleNamespace(returncode=0,timed_out=False,output_truncated=False,stdout=json.dumps({'verified':True,'papers':[{'paperId':'p'}]}),stderr='')
  def bounded(command,**kw):
   self.calls.append((command,kw)); fd=kw['pass_fds'][0]
   self.assertTrue(os.fstat(fd).st_size>0); self.assertEqual(len(kw['pass_fds']),1)
   with os.fdopen(os.dup(fd)) as captured:
    self.assertEqual(json.load(captured),{'runtimeRoot':'/fixture/runtime','state':{'items':{'p':{}}},'completion':{'receipt':'fixture'}})
   return self.reply
  self.scope={'json':json,'tempfile':tempfile,'shutil':types.SimpleNamespace(which=lambda s:'/fixture/node'),'ROOT':pathlib.Path('/fixture/root'),'RUNTIME':pathlib.Path('/fixture/runtime'),'os':os,'ConferencePublicationError':PublicationError,'load_publish_to_blog':lambda:types.SimpleNamespace(_run_bounded_subprocess=bounded)}
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(CANDIDATE),'exec'),self.scope)
 def run_batch(self):return self.scope['verify_process_author_sources']({'items':{'p':{}}},{'receipt':'fixture'})
 def test_complete_batch_one_native_node_fixed_deadline_and_output_cap(self):
  self.assertEqual(self.run_batch(),{'p':{'paperId':'p'}}); self.assertEqual(len(self.calls),1)
  command,kw=self.calls[0]
  self.assertEqual(command[:2],['/fixture/node','/fixture/root/scripts/lib/conference-publication-author-replay-cli.js'])
  self.assertEqual(kw['timeout_seconds'],3600);self.assertEqual(kw['max_output_bytes'],2*1024*1024)
 def test_real_timeout_is_still_failure(self):
  self.reply.timed_out=True
  with self.assertRaisesRegex(PublicationError,'timed_out=True'):self.run_batch()
 def test_truncation_is_still_failure(self):
  self.reply.output_truncated=True
  with self.assertRaisesRegex(PublicationError,'output_truncated=True'):self.run_batch()
 def test_nonzero_source_failure_is_still_failure(self):
  self.reply.returncode=1
  with self.assertRaisesRegex(PublicationError,'returncode=1'):self.run_batch()
 def test_incomplete_batch_coverage_is_still_failure(self):
  self.reply.stdout=json.dumps({'verified':True,'papers':[]})
  with self.assertRaisesRegex(PublicationError,'完整覆盖'):self.run_batch()
 def test_invalid_author_output_is_still_failure(self):
  self.reply.stdout='not-json'
  with self.assertRaisesRegex(PublicationError,'响应无效'):self.run_batch()
if __name__=='__main__':unittest.main()

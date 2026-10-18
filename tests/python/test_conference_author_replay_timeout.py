"""Mock author transport only; never supplies author/source authority."""
import json,sys,types,unittest
from pathlib import Path
from unittest import mock
ROOT=Path.cwd();sys.path.insert(0,str(ROOT/'scripts'))
formal=ROOT/'scripts/publish-conference.py'
publisher=types.ModuleType('publication_author_timeout_draft');publisher.__file__=str(formal)
exec(compile(formal.read_text(),str(formal),'exec'),publisher.__dict__)

class AuthorTimeoutTests(unittest.TestCase):
 def call(self,result,papers=None):
  seen={}
  def replay(command,**kwargs):
   seen.update(kwargs);self.assertTrue(command[1].endswith('conference-publication-author-replay-cli.js'));self.assertEqual(kwargs['timeout_seconds'],600);self.assertEqual(kwargs['max_output_bytes'],2*1024*1024);self.assertGreaterEqual(kwargs['pass_fds'][0],3)
   self.assertNotIn('NODE_OPTIONS',kwargs['env']);self.assertNotIn('NODE_PATH',kwargs['env']);return result
  runner=types.SimpleNamespace(_run_bounded_subprocess=replay)
  with mock.patch.object(publisher,'load_publish_to_blog',return_value=runner):return publisher.verify_process_author_sources({'items':papers or {'p':{}}},{})
 def result(self,**changes):
  fields=dict(returncode=0,timed_out=False,output_truncated=False,stdout=json.dumps({'verified':True,'papers':[{'paperId':'p'}]}),stderr='');fields.update(changes);return types.SimpleNamespace(**fields)
 def test_success_keeps_normal_exact_proof_and_set_validation(self):
  self.assertEqual(set(self.call(self.result())),{'p'})
  for payload in [{'verified':False,'papers':[{'paperId':'p'}]},{'verified':True,'papers':[]},{'verified':True,'papers':[{'paperId':'other'}]},{'verified':True,'papers':[{'paperId':'p'},{'paperId':'p'}]}]:
   with self.subTest(payload=payload),self.assertRaises(publisher.ConferencePublicationError):self.call(self.result(stdout=json.dumps(payload)))
 def test_failure_flags_lengths_tail_are_real_and_never_suggest_reader_refresh(self):
  for change,expected in [({'returncode':2},'returncode=2'),({'timed_out':True},'timed_out=True'),({'output_truncated':True},'output_truncated=True')]:
   with self.subTest(change=change),self.assertRaises(publisher.ConferencePublicationError) as error:self.call(self.result(**change,stdout='',stderr='头'*2300+'actual-tail'))
   text=str(error.exception);self.assertIn(expected,text);self.assertIn('stdout_utf8_bytes=0',text);self.assertIn('stderr_utf8_bytes=6911',text);self.assertTrue(text.endswith('actual-tail'));self.assertNotIn('刷新',text);self.assertLess(text.count('头'),2300)
 def test_malformed_json_still_refuses_with_actual_transport_flags(self):
  with self.assertRaises(publisher.ConferencePublicationError) as error:self.call(self.result(stdout='{'))
  self.assertIn('响应无效',str(error.exception));self.assertIn('timed_out=False',str(error.exception));self.assertIn('stdout_utf8_bytes=1',str(error.exception))
 def test_ordinary_resource_bridge_keeps_its_thirty_second_bound(self):
  import hashlib
  import paper_reader_presentation as presentation
  source='synthetic source only';paper={'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'apiReaderPlan':{'tableBindings':[]},'apiReaderResources':{'resources':[]}}
  def resource_replay(command,**kwargs):
   self.assertTrue(command[1].endswith('reader-resource-claims-replay-cli.js'));self.assertEqual(kwargs['timeout_seconds'],30)
   return types.SimpleNamespace(returncode=0,timed_out=False,output_truncated=False,stdout='{"verified":true,"resources":[]}',stderr='')
  self.assertEqual(presentation.replay_resource_presentation(paper,source,publisher=types.SimpleNamespace(_run_bounded_subprocess=resource_replay)),[])

if __name__=='__main__':unittest.main()

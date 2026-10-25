import importlib.util,json,os,pathlib,tempfile,types,unittest,zipfile
from unittest.mock import patch
P=pathlib.Path;ROOT=P(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('finalize_release',ROOT/'release_tools.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
PIN='0'*64
class Finalize(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=P(self.temp.name).resolve();self.repo=self.root/'repo';self.repo.mkdir();self.prepared=self.root/'prepared';self.prepared.mkdir()
  self.unsigned=self.prepared/'unsigned.apk';self.provided=self.root/'already-signed.apk';self.zip(self.unsigned);self.zip(self.provided,comment=b'synthetic-signature-stand-in')
  self.original=self.provided.read_bytes();self.inputs={'sourceCommit':'0'*40,'files':[]};m.write(self.prepared/'android-source-inputs.json',self.inputs);m.write(self.prepared/'android-runtime-materials.json',{'artifacts':[]})
  self.audit={'sha256':m.file_sha(self.unsigned),'synthetic':'unsigned'};self.info={'contract':'paperdigest-android-unsigned-v1','sourceCommit':'0'*40,'versionName':'1.0.0','versionCode':1,'sourceInputsSHA256':m.file_sha(self.prepared/'android-source-inputs.json'),'runtimeMaterialsSHA256':m.file_sha(self.prepared/'android-runtime-materials.json'),'unsigned':self.audit};m.write(self.prepared/'android-build-info.json',self.info)
  self.args=types.SimpleNamespace(repo=self.repo,prepared=self.prepared,signed_apk=self.provided,output=self.root/'fresh',certificate=PIN,sdk=self.root/'sdk')
  self.sdk=types.SimpleNamespace(identities=lambda:{'synthetic-verification':True})
  self.patches=[patch.object(m,'SDK',return_value=self.sdk),patch.object(m,'check_source'),patch.object(m,'inspect',side_effect=self.inspect),patch.object(m.getpass,'getpass',side_effect=AssertionError('no passwords')),patch.object(m,'private_keystore',side_effect=AssertionError('no keystore'))]
  for p in self.patches:p.start();self.addCleanup(p.stop)
 def zip(self,path,payload=b'original-bytecode',comment=b''):
  with zipfile.ZipFile(path,'w') as z:
   z.writestr('AndroidManifest.xml',b'synthetic-manifest');z.writestr('resources.arsc',b'synthetic-resources');z.writestr('classes.dex',payload);z.comment=comment
 def inspect(self,path,*args):return self.audit if path==self.unsigned else {'sha256':m.file_sha(path),'synthetic':'signed'}
 def fails(self,code):
  with self.assertRaises(m.ReleaseError) as e:m.finalize_signed(self.args)
  self.assertEqual(code,str(e.exception));self.assertFalse((self.args.output/'android-release-manifest.json').exists())
 def test_actual_copy_and_normal_records_verify_without_any_signing_operation(self):
  result=m.finalize_signed(self.args);self.assertTrue(result['verified']);self.assertEqual(self.original,self.provided.read_bytes());out=self.args.output
  info=m.load(out/'android-build-info.json');self.assertEqual('provided-signed-apk',info['signingOrigin']['kind']);self.assertFalse(info['signingOrigin']['signerInvokedByThisCommand']);self.assertNotIn('signingTools',info);self.assertEqual({'synthetic-verification':True},info['verificationTools'])
  self.assertEqual(m.file_sha(self.provided),m.file_sha(out/result['apk']));self.assertEqual(m.load(out/'android-source-inputs.json'),self.inputs);self.assertTrue((out/'ANDROID-SHA256SUMS').is_file());self.assertFalse(result['publicationEligible'])
 def test_existing_output_is_never_reused_or_overwritten(self):
  self.args.output.mkdir();sentinel=self.args.output/'sentinel';sentinel.write_bytes(b'keep');self.fails('output_exists');self.assertEqual(b'keep',sentinel.read_bytes())
 def test_provided_cannot_be_unsigned_or_a_hardlink_to_it(self):
  self.args.signed_apk=self.unsigned;self.fails('provided_is_unsigned')
  link=self.root/'same-inode.apk';os.link(self.unsigned,link);self.args.signed_apk=link;self.fails('provided_is_unsigned')
 def test_invalid_certificate_is_rejected_before_inspection(self):
  self.args.certificate='invalid';self.fails('certificate_pin_format');m.inspect.assert_not_called()
 def test_provided_link_is_rejected_before_reading_its_payload(self):
  link=self.root/'alias.apk';link.symlink_to(self.provided);self.args.signed_apk=link;self.fails('symlink_path');m.inspect.assert_not_called()
 def test_output_parent_link_is_not_followed(self):
  parent=self.root/'outside';parent.mkdir();alias=self.root/'linked-parent';alias.symlink_to(parent,target_is_directory=True);self.args.output=alias/'fresh';self.fails('symlink_path');self.assertEqual([],list(parent.iterdir()))
 def test_wrong_signed_payload_fails_before_creating_output(self):
  self.zip(self.provided,payload=b'changed-bytecode',comment=b'synthetic');self.fails('signer_payload_changed');self.assertFalse(self.args.output.exists())
 def test_unsigned_bytes_changed_fails_before_creating_output(self):
  self.unsigned.write_bytes(self.unsigned.read_bytes()+b'changed');self.fails('unsigned_changed');self.assertFalse(self.args.output.exists())
 def test_source_change_prevents_finalization(self):
  m.check_source.side_effect=m.ReleaseError('source_changed');self.fails('source_changed');self.assertFalse(self.args.output.exists())
 def test_stale_unsigned_audit_is_not_authority(self):
  m.inspect.side_effect=lambda *args:{'sha256':'0'*64};self.fails('unsigned_audit_changed');self.assertFalse(self.args.output.exists())
 def test_failed_signature_does_not_create_output_or_records(self):
  def inspect(path,*args):
   if path==self.unsigned:return self.audit
   raise m.ReleaseError('signature_schemes')
  m.inspect.side_effect=inspect;self.fails('signature_schemes');self.assertFalse(self.args.output.exists())
 def test_provided_changed_during_preflight_is_not_copied(self):
  def inspect(path,*args):
   if path==self.unsigned:return self.audit
   self.provided.write_bytes(self.provided.read_bytes()+b'changed');return {'sha256':m.file_sha(path)}
  m.inspect.side_effect=inspect;self.fails('provided_apk_changed');self.assertFalse(self.args.output.exists())
 def test_partial_copy_failure_leaves_no_completed_metadata(self):
  def fail(reader,writer,*args):writer.write(b'partial');raise OSError('synthetic copy failure')
  with patch.object(m.shutil,'copyfileobj',side_effect=fail),self.assertRaises(OSError):m.finalize_signed(self.args)
  self.assertFalse((self.args.output/'android-build-info.json').exists());self.assertFalse((self.args.output/'android-release-manifest.json').exists());self.assertEqual(self.original,self.provided.read_bytes())
 def test_completed_but_different_copy_is_rejected_by_full_sha(self):
  original=m.shutil.copyfileobj
  def change(reader,writer,*args):original(reader,writer,*args);writer.write(b'changed-copy')
  with patch.object(m.shutil,'copyfileobj',side_effect=change):self.fails('provided_apk_changed')
  self.assertFalse((self.args.output/'android-build-info.json').exists());self.assertEqual(self.original,self.provided.read_bytes())
 def test_provided_changed_during_copy_is_rejected(self):
  original=m.shutil.copyfileobj
  def change(reader,writer,*args):original(reader,writer,*args);self.provided.write_bytes(self.provided.read_bytes()+b'changed-original')
  with patch.object(m.shutil,'copyfileobj',side_effect=change):self.fails('provided_apk_changed')
  self.assertFalse((self.args.output/'android-build-info.json').exists())
 def test_late_copy_digest_change_is_rejected_before_metadata(self):
  def inspect(path,*args):
   if path==self.unsigned:return self.audit
   if path.parent==self.args.output:path.write_bytes(path.read_bytes()+b'changed-copy')
   return {'sha256':m.file_sha(path),'synthetic':'signed'}
  m.inspect.side_effect=inspect;self.fails('provided_apk_changed');self.assertFalse((self.args.output/'android-build-info.json').exists())
 def test_metadata_write_failure_leaves_no_release_manifest(self):
  original=m.write
  def fail(path,value):
   if path==self.args.output/'android-build-info.json':raise OSError('synthetic write failure')
   return original(path,value)
  with patch.object(m,'write',side_effect=fail),self.assertRaises(OSError):m.finalize_signed(self.args)
  self.assertFalse((self.args.output/'android-release-manifest.json').exists());self.assertEqual(self.original,self.provided.read_bytes())
 def test_source_changed_after_copy_blocks_all_metadata(self):
  m.check_source.side_effect=[None,None,m.ReleaseError('source_changed')];self.fails('source_changed');self.assertFalse((self.args.output/'android-build-info.json').exists());self.assertEqual(self.original,self.provided.read_bytes())
if __name__=='__main__':unittest.main(verbosity=2)

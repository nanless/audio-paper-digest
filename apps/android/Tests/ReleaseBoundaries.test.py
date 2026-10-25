import pathlib,importlib.util,json,os,subprocess,tempfile,types,unittest,zipfile
from unittest.mock import patch
P=pathlib.Path;app_root=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release_boundary_tool',app_root/'release_tools.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class IndependentBoundaries(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.p=P(self.temp.name).resolve()
 def xml(self,extraRoot='',mainIcon=None):
  icon=''if mainIcon is None else f' android:icon="{mainIcon}"'
  permissions=''.join(f'<uses-permission android:name="{x}"/>'for x in sorted(m.PERMISSIONS))
  return f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{m.APP}" android:versionName="1.0.0" android:versionCode="1">{permissions}{extraRoot}<uses-sdk android:minSdkVersion="28" android:targetSdkVersion="37"/><application android:name="{m.APP}.PaperDigestApplication" android:allowBackup="false" android:usesCleartextTraffic="false" android:icon="@ref/0x4" android:roundIcon="@ref/0x4"><activity android:name="{m.APP}.MainActivity" android:exported="true"{icon}><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>'
 def test_ordinary_expected_manifest_is_still_accepted(self):self.assertEqual(m.APP,m.manifest_facts(self.xml(),'1.0.0',1)['applicationId'])
 def tracked(self,name):
  repo=self.p/'repo';p=repo/'apps/android'/name;p.parent.mkdir(parents=True);p.write_text('SYNTHETIC_NOT_CREDENTIAL')
  for args in [['init','-q'],['add','-f','.'],['-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','owned fixture']]:subprocess.run(['git','-C',str(repo),*args],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  return repo
 def test_known_env_name_is_rejected_before_hash_positive(self):
  repo=self.tracked('.env')
  with patch.object(m,'file_sha',side_effect=AssertionError('no private bytes read')):
   with self.assertRaises(m.ReleaseError):m.source_state(repo)
 def test_dotenv_variant_is_rejected_before_hash(self):
  repo=self.tracked('.env.local');seen=[]
  def watched(p):seen.append(str(p));return '0'*64
  with patch.object(m,'file_sha',side_effect=watched):
   try:m.source_state(repo);rejected=False
   except m.ReleaseError:rejected=True
  (self.p/'dotenv-observed.json').write_text(json.dumps({'rejected':rejected,'hashCalls':len(seen),'syntheticOnly':True}))
  self.assertTrue(rejected and not seen,'Known private dotenv variant must be rejected before file hashing')
 def test_uses_permission_sdk23_cannot_bypass_exact_permission_set(self):
  with self.assertRaises(m.ReleaseError,msg='Actual SDK23 permission declaration must not bypass exact permission audit'):
   m.manifest_facts(self.xml(extraRoot='<uses-permission-sdk-23 android:name="android.permission.READ_CONTACTS"/>'),'1.0.0',1)
 def test_launcher_activity_icon_override_cannot_bypass_original_c_icon(self):
  with self.assertRaises(m.ReleaseError,msg='Effective launcher icon differs from audited application icon'):
   m.manifest_facts(self.xml(mainIcon='@ref/0x999'),'1.0.0',1)
 def test_signer_output_must_preserve_exact_unsigned_payload(self):
  # Controlled signing adapter only, no cryptographic signature/key/tool/network.
  repo=self.p/'repo';repo.mkdir();private=self.p/'private';private.mkdir(mode=0o700);key=private/'dummy.jks';key.write_bytes(b'NOT A KEY');key.chmod(0o600)
  source=self.p/'prepared';source.mkdir();unsigned=source/'unsigned.apk'
  with zipfile.ZipFile(unsigned,'w')as z:z.writestr('classes.dex',b'original-bytecode')
  m.write(source/'android-source-inputs.json',{'sourceCommit':'0'*40,'files':[]});m.write(source/'android-runtime-materials.json',{'artifacts':[]})
  def audit(p,*args,**kwargs):return {'sha256':m.file_sha(p),'bytes':p.stat().st_size,'manifest':{'sameExpectedFields':True},'assets':{'same':True},'signature':None if p==unsigned else {'samePinnedSigner':True}}
  info={'contract':'paperdigest-android-unsigned-v1','unsigned':audit(unsigned),'sourceInputsSHA256':m.file_sha(source/'android-source-inputs.json'),'runtimeMaterialsSHA256':m.file_sha(source/'android-runtime-materials.json'),'sourceCommit':'0'*40,'versionName':'1.0.0','versionCode':1};m.write(source/'android-build-info.json',info)
  args=types.SimpleNamespace(repo=repo,prepared=source,output=self.p/'signed',keystore=key,alias='dummy',certificate='0'*64,sdk=self.p/'sdk');sdk=types.SimpleNamespace(env={},bin=self.p/'sdk',identities=lambda:{})
  def changed_signer(argv,*args):
   output=P(argv[argv.index('--out')+1])
   with zipfile.ZipFile(output,'w')as z:z.writestr('classes.dex',b'different-bytecode')
   return ''
  with patch.object(m,'SDK',return_value=sdk),patch.object(m,'check_source'),patch.object(m.sys.stdin,'isatty',return_value=True),patch.object(m.getpass,'getpass',side_effect=['synthetic','synthetic']),patch.object(m,'inspect',side_effect=audit),patch.object(m,'run',side_effect=changed_signer),patch.object(m,'verify',return_value={'verified':True}):
   with self.assertRaises(m.ReleaseError,msg='Correctly-shaped signed report cannot replace unsigned payload binding'):m.sign(args)
if __name__=='__main__':unittest.main(verbosity=2)

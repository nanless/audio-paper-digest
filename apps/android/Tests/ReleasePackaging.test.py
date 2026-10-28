import importlib.util,json,os,pathlib,stat,struct,subprocess,tempfile,unittest,zipfile,types
from unittest.mock import patch
P=pathlib.Path
q=P(__file__).resolve().parents[1];TOOL=q/'release_tools.py' if(q/'release_tools.py').is_file() else q/'draft/release_tools.py';spec=importlib.util.spec_from_file_location('android_release',TOOL);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
REPO=next(a for a in P(__file__).resolve().parents if (a/'apps/android/prepare-assets.mjs').is_file() and (a/'package.json').is_file())
class ReleaseTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.p=P(self.tmp.name).resolve();self.addCleanup(self.tmp.cleanup)
 def failcode(self,code,fn):
  with self.assertRaises(m.ReleaseError) as e:fn()
  self.assertEqual(code,str(e.exception))
 def xml(self,**changes):
  attrs={'name':m.APP+'.PaperDigestApplication','allowBackup':'false','usesCleartextTraffic':'false','icon':'@ref/0x4','roundIcon':'@ref/0x4'};attrs.update(changes)
  permissions=''.join(f'<uses-permission android:name="{n}"/>' for n in sorted(m.PERMISSIONS))
  app=' '.join('android:'+k+'="'+v+'"' for k,v in attrs.items())
  return f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{m.APP}" android:versionName="1.0.0" android:versionCode="1">{permissions}<uses-sdk android:minSdkVersion="28" android:targetSdkVersion="37"/><application {app}><activity android:name="{m.APP}.MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>'
 def apk(self,entries):
  p=self.p/'candidate.apk'
  with zipfile.ZipFile(p,'w') as z:
   z.writestr('AndroidManifest.xml',b'compiled');z.writestr('resources.arsc',b'table')
   for n,b in entries:z.writestr(n,b)
  return p
 def test_manifest_matches_expected_version_sdk_security(self):
  facts=m.manifest_facts(self.xml(),'1.0.0',1);self.assertEqual(28,facts['minSdk']);self.assertFalse(facts['debuggable']);self.assertEqual(8,len(facts['permissions']))
 def test_debug_test_flags_never_formal(self):
  for key in ['debuggable','testOnly']:self.failcode('debug_or_test_apk',lambda:m.manifest_facts(self.xml(**{key:'true'}),'1.0.0',1))
 def test_wrong_version_does_not_become_formal_by_filename(self):self.failcode('apk_identity',lambda:m.manifest_facts(self.xml(),'2.0.0',2))
 def test_cleartext_or_backup_flag_is_not_silently_accepted(self):
  for key in ['allowBackup','usesCleartextTraffic']:self.failcode('application_security',lambda:m.manifest_facts(self.xml(**{key:'true'}),'1.0.0',1))
 def test_debug_harness_and_unprotected_receiver_rejected(self):
  xml=self.xml().replace('</application>',f'<activity android:name="{m.APP}.pdf.PdfHarnessActivity"/></application>');self.failcode('unexpected_component',lambda:m.manifest_facts(xml,'1.0.0',1))
  xml=self.xml().replace('</application>','<receiver android:name="androidx.profileinstaller.ProfileInstallReceiver" android:exported="true"/></application>');self.failcode('unprotected_exported_component',lambda:m.manifest_facts(xml,'1.0.0',1))
 def test_extra_permission_is_not_inherited_from_debug_receipt(self):
  xml=self.xml().replace('<application','<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"/><application');self.failcode('permission_set_changed',lambda:m.manifest_facts(xml,'1.0.0',1))
 def test_zip_paths_duplicate_and_links_refused(self):
  for name in ['../outside','/absolute','a/../b','a\\b','a//b','a//']:
   p=self.apk([(name,b'x')]);
   with zipfile.ZipFile(p) as z:self.failcode('unsafe_zip_path',lambda:m.safe_members(z))
  p=self.apk([('assets/a',b'x'),('assets/a',b'y')]);
  with zipfile.ZipFile(p) as z:self.failcode('duplicate_zip_entry',lambda:m.safe_members(z))
  p=self.apk([])
  with zipfile.ZipFile(p,'a') as z:i=zipfile.ZipInfo('assets/link');i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,b'/tmp/other')
  with zipfile.ZipFile(p) as z:self.failcode('zip_link_or_encryption',lambda:m.safe_members(z))
 def test_private_paths_rejected_without_reading_payload(self):
  for name in ['assets/.env','assets/ModelUsage/receipt.json','assets/PaperDigest/personal.json','assets/.qa/log','assets/signing.jks','assets/api.key']:
   p=self.apk([(name,b'synthetic')]);
   with zipfile.ZipFile(p) as z:self.failcode('private_payload_path',lambda:m.safe_members(z))
 def test_ordinary_packaged_entries_do_not_get_false_private_hits(self):
  p=self.apk([('META-INF/LICENSE.txt',b'public'),('assets/licenses/texts/key-description.txt',b'public'),('classes.dex',b'dex')])
  with zipfile.ZipFile(p) as z:self.assertEqual(5,len(m.safe_members(z)))
 def test_elf_machine_is_actual_not_folder_name(self):
  b=bytearray(120);b[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',b,18,183);struct.pack_into('<Q',b,32,64);struct.pack_into('<HH',b,54,56,1);struct.pack_into('<I',b,64,1);struct.pack_into('<Q',b,112,16384)
  self.assertTrue(m.elf_facts(b,'arm64-v8a')['loadAlignmentAtLeast16KiB']);self.failcode('elf_abi_mismatch',lambda:m.elf_facts(b,'x86_64'))
  struct.pack_into('<Q',b,112,4096);self.assertFalse(m.elf_facts(b,'arm64-v8a')['loadAlignmentAtLeast16KiB'])
 def test_truncated_elf_fails_instead_of_claiming_abi(self):self.failcode('elf_header',lambda:m.elf_facts(b'ELF','x86'))
 def test_source_snapshot_is_clean_and_changes_are_detected(self):
  repo=self.p/'repo';(repo/'apps/android').mkdir(parents=True);f=repo/'apps/android/source.kt';f.write_text('original')
  for args in [['init','-q'],['add','.'],['-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','fixture']]:subprocess.run(['git','-C',str(repo),*args],check=True,stdout=subprocess.DEVNULL)
  before=m.source_state(repo);self.assertEqual(1,len(before['files']));f.write_text('changed');self.failcode('source_dirty',lambda:m.check_source(repo,before))
 def test_force_tracked_private_material_is_refused_before_hashing_it(self):
  repo=self.p/'repo';(repo/'apps/android').mkdir(parents=True);key=repo/'apps/android/accidental.jks';key.write_bytes(b'NOT A KEY')
  for args in [['init','-q'],['add','.'],['-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','fixture']]:subprocess.run(['git','-C',str(repo),*args],check=True,stdout=subprocess.DEVNULL)
  with patch.object(m,'file_sha',side_effect=AssertionError('must not hash private material')):self.failcode('private_source_input',lambda:m.source_state(repo))
 def test_keystore_guard_only_stats_synthetic_no_content_hash(self):
  repo=self.p/'repo';repo.mkdir();private=self.p/'private';private.mkdir(mode=0o700);key=private/'synthetic.jks';key.write_bytes(b'NOT A KEY');key.chmod(0o600)
  with patch.object(m,'file_sha',side_effect=AssertionError('must not hash a key')):self.assertEqual(key,m.private_keystore(key,repo))
  key.chmod(0o644);self.failcode('keystore_permissions',lambda:m.private_keystore(key,repo));key.chmod(0o600)
  link=private/'link';link.symlink_to(key);self.failcode('symlink_path',lambda:m.private_keystore(link,repo))
 def test_project_internal_key_is_refused_even_ignored(self):
  repo=self.p/'repo';repo.mkdir(mode=0o700);key=repo/'synthetic.jks';key.write_bytes(b'NOT A KEY');key.chmod(0o600);self.failcode('keystore_inside_repository',lambda:m.private_keystore(key,repo))
 def test_android_all86_requires_exact_pass_and_ids(self):
  mac=m.mac_module(REPO);ids={'A-'+n for n in mac.IDS|mac.CLOUD_IDS};self.assertEqual(86,len(ids));p=self.p/'acceptance.md';rows=[f'| {n} | original | condition | 通过 |\n' for n in sorted(ids)];p.write_text(''.join(rows));m.android_acceptance(p,ids)
  p.write_text(''.join(rows).replace('通过','部分验证：通过',1));self.failcode('android_acceptance_incomplete',lambda:m.android_acceptance(p,ids))
  p.write_text(''.join(rows)+rows[0]);self.failcode('android_acceptance_incomplete',lambda:m.android_acceptance(p,ids))
  p.write_text(''.join(rows)+'| A-UNKNOWN-01 | original | condition | 通过 |\n');self.failcode('android_acceptance_incomplete',lambda:m.android_acceptance(p,ids))
 def test_unknown_current_partial_acceptance_not_release_qualified(self):
  mac=m.mac_module(REPO);self.failcode('android_acceptance_incomplete',lambda:m.android_acceptance(REPO/'docs/android-feature-parity.md',{'A-'+n for n in mac.IDS|mac.CLOUD_IDS}))
 def test_external_command_failure_never_echoes_raw_bait(self):
  with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1,b'',b'synthetic-secret-bait')):
   self.failcode('safe_failure',lambda:m.run(['synthetic-tool'],'safe_failure'))
 def fake_sdk(self,signature=None):
  outer=self
  class FakeSDK:
   def call(self,name,*args):
    if name=='apkanalyzer':return outer.xml()
    if name=='zipalign':return ''
    if name=='apksigner':return signature or ('Signer #1 certificate SHA-256 digest: '+'0'*64+'\nVerified using v2 scheme (APK Signature Scheme v2): true\nVerified using v3 scheme (APK Signature Scheme v3): true\n')
    raise AssertionError(name)
  return FakeSDK()
 def tiny_elf(self,abi):
  cls,machine=m.ABI[abi];b=bytearray(128);b[:6]=b'\x7fELF'+bytes([cls,1]);struct.pack_into('<H',b,18,machine)
  if cls==2:struct.pack_into('<Q',b,32,64);struct.pack_into('<HH',b,54,56,1);at=64;struct.pack_into('<Q',b,at+48,16384)
  else:struct.pack_into('<I',b,28,52);struct.pack_into('<HH',b,42,32,1);at=52;struct.pack_into('<I',b,at+28,16384)
  struct.pack_into('<I',b,at,1);return b
 def fake_inspect(self,signature=None,extra=()):
  png=(REPO/'apps/android/app/src/main/res/drawable-nodpi/pd_icon.png').read_bytes();p=self.apk([('res/drawable-nodpi/pd_icon.png',png),*[(f'lib/{abi}/sample.so',self.tiny_elf(abi)) for abi in m.ABI],*extra])
  return p,self.fake_sdk(signature)
 def inspect_patches(self):
  return patch.object(m,'compiled_icon',return_value={'pngPath':'res/drawable-nodpi/pd_icon.png','adaptiveReferenceVerified':True}),patch.object(m,'run',return_value=json.dumps({'runtime':{'records':123},'resources':{'channel':'release'},'licenseFiles':632}))
 def test_inspect_fake_sdk_keeps_apk_exact_and_requires_single_pinned_signer(self):
  p,sdk=self.fake_inspect();before=m.file_sha(p);a,b=self.inspect_patches()
  with a,b:result=m.inspect(p,REPO,sdk,'1.0.0',1,self.p/'synthetic.json','0'*64)
  self.assertEqual(before,m.file_sha(p));self.assertFalse(result['publicationEligible']);self.assertFalse(result['formalDeviceTested']);self.assertEqual(set(m.ABI),{n['abi'] for n in result['nativeLibraries']})
  a,b=self.inspect_patches()
  with a,b:self.failcode('release_certificate_mismatch',lambda:m.inspect(p,REPO,sdk,'1.0.0',1,self.p/'synthetic.json','1'*64))
 def test_debug_certificate_or_v1_only_cannot_pass_even_with_matching_pin(self):
  signature='Signer #1 certificate SHA-256 digest: '+'0'*64+'\nSigner #1 certificate DN: CN=Android Debug\nVerified using v2 scheme (APK Signature Scheme v2): true\nVerified using v3 scheme (APK Signature Scheme v3): true\n'
  p,sdk=self.fake_inspect(signature);a,b=self.inspect_patches()
  with a,b:self.failcode('release_certificate_mismatch',lambda:m.inspect(p,REPO,sdk,'1.0.0',1,self.p/'synthetic.json','0'*64))
  p,sdk=self.fake_inspect('Signer #1 certificate SHA-256 digest: '+'0'*64+'\nVerified using v2 scheme (APK Signature Scheme v2): false\n');a,b=self.inspect_patches()
  with a,b:self.failcode('signature_schemes',lambda:m.inspect(p,REPO,sdk,'1.0.0',1,self.p/'synthetic.json','0'*64))
 def test_public_scientific_pdf_renamed_outside_assets_is_rejected(self):
  original=REPO/'prototypes/macos-research/assets/micla-2610.27491v1.pdf';before=m.file_sha(original);p,sdk=self.fake_inspect(extra=[('res/raw/renamed.bin',original.read_bytes())]);a,b=self.inspect_patches()
  with a,b:self.failcode('embedded_pdf_in_apk',lambda:m.inspect(p,REPO,sdk,'1.0.0',1,self.p/'synthetic.json','0'*64))
  self.assertEqual(before,m.file_sha(original))
 def test_bad_utf8_duplicate_json_and_oversized_record_are_rejected(self):
  p=self.p/'record.json';p.write_bytes(b'{"x":"\xff"}')
  with self.assertRaises(UnicodeDecodeError):m.load(p)
  p.write_bytes(b'{"same":1,"same":2}');self.failcode('duplicate_json_key',lambda:m.load(p));p.write_bytes(b'{"x":NaN}');self.failcode('nonfinite_json',lambda:m.load(p));p.write_bytes(b' '*((8*1024*1024)+1));self.failcode('record_size_limit',lambda:m.load(p))
 def test_node_import_uses_sentinel_so_helper_cli_cannot_autorun(self):
  # The existing helper guards CLI by argv[1]; the sentinel is a necessary import boundary.
  source=TOOL.read_text();self.assertIn("NODE_AUDIT,'paperdigest-release-audit'",source);self.assertIn('process.argv.slice(2)',m.NODE_AUDIT)
 def signing_simulation(self,fail,mutation=None):
  repo=self.p/'repo';repo.mkdir();private=self.p/'private';private.mkdir(mode=0o700);key=private/'synthetic.jks';key.write_bytes(b'NOT A KEY');key.chmod(0o600)
  prepared=self.p/'prepared';prepared.mkdir();unsigned=prepared/'unsigned.apk'
  with zipfile.ZipFile(unsigned,'w') as z:z.writestr('AndroidManifest.xml',b'compiled-manifest');z.writestr('resources.arsc',b'compiled-resources');z.writestr('classes.dex',b'original-bytecode')
  before=m.file_sha(unsigned)
  m.write(prepared/'android-source-inputs.json',{'sourceCommit':'0'*40,'files':[]});m.write(prepared/'android-runtime-materials.json',{'artifacts':[]})
  unsigned_audit={'synthetic':'unsigned','sha256':before};info={'contract':'paperdigest-android-unsigned-v1','sourceInputsSHA256':m.file_sha(prepared/'android-source-inputs.json'),'runtimeMaterialsSHA256':m.file_sha(prepared/'android-runtime-materials.json'),'sourceCommit':'0'*40,'unsigned':unsigned_audit,'versionName':'1.0.0','versionCode':1};m.write(prepared/'android-build-info.json',info)
  args=types.SimpleNamespace(repo=repo,prepared=prepared,output=self.p/'signed',keystore=key,alias='synthetic-alias',certificate='0'*64,sdk=self.p/'sdk')
  sdk=types.SimpleNamespace(env={},bin=self.p/'sdk',identities=lambda:{'synthetic':True});observed={}
  def command(argv,code,env):
   observed['argv']=[str(x) for x in argv];observed['env']=env
   self.assertEqual('synthetic-store-password',env['PD_RELEASE_STORE_PASSWORD']);self.assertEqual('synthetic-key-password',env['PD_RELEASE_KEY_PASSWORD'])
   self.assertFalse(any('synthetic-store-password' in str(a) or 'synthetic-key-password' in str(a) for a in argv));self.assertIn('env:PD_RELEASE_STORE_PASSWORD',argv);self.assertIn('env:PD_RELEASE_KEY_PASSWORD',argv)
   self.assertEqual('true',argv[argv.index('--alignment-preserved')+1]);self.assertEqual('false',argv[argv.index('--v4-signing-enabled')+1]);self.assertEqual('false',argv[argv.index('--debuggable-apk-permitted')+1])
   target=P(argv[argv.index('--out')+1]);self.assertNotEqual(unsigned,target);observed['calls']=observed.get('calls',0)+1
   if fail:target.write_bytes(b'synthetic-partial');raise m.ReleaseError('signing_failed')
   with zipfile.ZipFile(unsigned) as original,zipfile.ZipFile(target,'w') as signed:
    for entry in original.infolist():
     data=original.read(entry)
     if mutation=='payload' and entry.filename=='classes.dex':data=b'changed-bytecode'
     if mutation=='metadata':entry.comment=b'allowed ZIP metadata change'
     if mutation=='type' and entry.filename=='classes.dex':entry.external_attr=(stat.S_IFDIR|0o700)<<16
     signed.writestr(entry,data)
   return ''
  with patch.object(m,'SDK',return_value=sdk),patch.object(m,'check_source'),patch.object(m.sys.stdin,'isatty',return_value=True),patch.object(m.getpass,'getpass',side_effect=['synthetic-store-password','synthetic-key-password']),patch.object(m,'inspect',side_effect=[unsigned_audit,{'synthetic':'signed'}]),patch.object(m,'run',side_effect=command),patch.object(m,'verify',return_value={'verified':True}) as verify:
   if fail:self.failcode('signing_failed',lambda:m.sign(args));verify.assert_not_called();self.assertFalse((args.output/'android-release-manifest.json').exists())
   elif mutation in ('payload','type'):
    self.failcode('signer_payload_changed' if mutation=='payload' else 'zip_type_mismatch',lambda:m.sign(args));verify.assert_not_called();self.assertFalse((args.output/'android-release-manifest.json').exists())
   else:
    self.assertTrue(m.sign(args)['verified']);verify.assert_called_once();self.assertEqual('0'*64,verify.call_args.args[-1]);self.assertTrue((args.output/'android-release-manifest.json').is_file())
  self.assertEqual(1,observed['calls']);self.assertEqual(before,m.file_sha(unsigned));self.assertNotIn('PD_RELEASE_STORE_PASSWORD',observed['env']);self.assertNotIn('PD_RELEASE_KEY_PASSWORD',observed['env'])
  for item in args.output.iterdir():
   if item.is_file():self.assertNotIn(b'synthetic-store-password',item.read_bytes());self.assertNotIn(b'synthetic-key-password',item.read_bytes());self.assertNotIn(str(key).encode(),item.read_bytes())
 def test_signing_adapter_uses_only_named_memory_inputs_and_preserves_unsigned(self):self.signing_simulation(False)
 def test_signing_failure_keeps_partial_unqualified_without_raw_error_or_secret(self):self.signing_simulation(True)
 def test_changed_payload_rejected_after_real_controlled_signer_call(self):self.signing_simulation(False,'payload')
 def test_changed_member_type_rejected_after_real_controlled_signer_call(self):self.signing_simulation(False,'type')
 def test_same_payload_with_zip_metadata_changes_remains_acceptable(self):self.signing_simulation(False,'metadata')
 def test_effective_launcher_cannot_use_an_alias_or_be_disabled(self):
  xml=self.xml().replace('</application>','<activity-alias android:name="synthetic.Alias" android:targetActivity="com.nanless.paperdigest.MainActivity" android:exported="true"/></application>');self.failcode('unexpected_component',lambda:m.manifest_facts(xml,'1.0.0',1))
  self.failcode('launcher_disabled',lambda:m.manifest_facts(self.xml(enabled='false'),'1.0.0',1))
 def test_dotenv_variants_are_rejected_in_apk_paths_too(self):
  for name in ['assets/.env.local','res/raw/.env.production','META-INF/signing.properties']:
   p=self.apk([(name,b'SYNTHETIC_NOT_CREDENTIAL')]);
   with zipfile.ZipFile(p) as z:self.failcode('private_payload_path',lambda:m.safe_members(z))

class JointReleaseStages(unittest.TestCase):
 """Controlled GitHub replies and real downloaded-byte comparison; no SDK or remote calls."""
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=P(self.tmp.name).resolve();self.head='1'*40;self.commands=[]
  spec=importlib.util.spec_from_file_location('joint_stage_mac',P(m.__file__).resolve().parents[1]/'macos/release_tools.py');self.mac=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.mac)
  self.a=self.p/'android';self.b=self.p/'mac';self.a.mkdir();self.b.mkdir()
  self.astatus=self.p/'android.md';self.mstatus=self.p/'mac.md';self.cloud=self.p/'cloud.md'
  self.astatus.write_text('\n'.join('| A-'+n+' | original | condition | 通过 |' for n in sorted(self.mac.IDS|self.mac.CLOUD_IDS)))
  self.mstatus.write_text('\n'.join('| '+n+' | 通过 | fixture |' for n in sorted(self.mac.IDS)))
  self.cloud.write_text('\n'.join('| '+n+' | 通过 | fixture |' for n in sorted(self.mac.CLOUD_IDS)))
  (self.a/'app.apk').write_bytes(b'explicit controlled APK bytes');(self.b/'package.zip').write_bytes(b'explicit controlled Mac ZIP bytes');(self.b/'RELEASE_NOTES.md').write_text('Fixed reviewed scope\n')
  (self.b/'build-info.json').write_text(json.dumps({'distributionChannel':'release','sourceCommit':self.head,'releaseHead':self.head,'version':'1.0.0'}))
  for folder,manifest,assets,checksums in [(self.a,'android-release-manifest.json',['app.apk'],'ANDROID-SHA256SUMS'),(self.b,'release-manifest.json',['package.zip','build-info.json','RELEASE_NOTES.md'],'SHA256SUMS')]:
   (folder/manifest).write_text(json.dumps({'assets':{name:{'bytes':(folder/name).stat().st_size,'sha256':m.file_sha(folder/name)} for name in assets}}));(folder/checksums).write_text('explicit fixture checksums')
  self.expected={p.name:p for folder in [self.a,self.b] for p in folder.iterdir()}
  self.record={'id':77,'tag_name':'v1.0.0','draft':True,'published_at':None,'body':'Fixed reviewed scope\n','name':'reviewed title','prerelease':False,'updated_at':'fixed','assets':[{'id':i+1,'name':n,'size':p.stat().st_size,'state':'uploaded','download_count':0} for i,(n,p) in enumerate(sorted(self.expected.items()))]}
  self.args=types.SimpleNamespace(prepared=self.a,mac=self.b,repo=REPO,sdk=self.p/'unused-sdk',certificate='0'*64,android_acceptance=self.astatus,mac_acceptance=self.mstatus,mac_cloud=self.cloud,draft_id=77)
  self.remote=(self.head+'\trefs/tags/v1.0.0\n').encode();self.api_reads=0;self.after=None;self.corrupt=None;self.omit=None
  def macrun(argv):self.commands.append(argv);return self.remote
  def androidrun(argv,code,env=None):
   self.commands.append(argv)
   if argv[:2]==['gh','api']:
    self.assertEqual(['gh','api','--hostname','github.com','repos/nanless/audio-paper-digest/releases/77'],argv)
    self.api_reads+=1
    record=json.loads(json.dumps(self.record))
    if self.api_reads>1:
     for a in record['assets']:a['download_count']+=1 # Download counters are not asset mutations.
     if self.after:self.after(record)
    return json.dumps(record)
   if argv[:3]==['gh','release','download']:
    out=P(argv[argv.index('--dir')+1])
    for name,p in self.expected.items():(out/name).write_bytes(p.read_bytes())
    return '' # Another same-tag release can supply good bytes; not proof of this ID.
   raise AssertionError(argv)
  def assetrun(argv,stdout,stderr,timeout):
   self.commands.append(argv)
   self.assertEqual(['gh','api','--hostname','github.com','-H','Accept: application/octet-stream'],argv[:6]);self.assertEqual(1200,timeout)
   asset=next(a for a in self.record['assets'] if argv[6]=='repos/nanless/audio-paper-digest/releases/assets/'+str(a['id']))
   name=asset['name'];p=self.expected[name]
   if name==self.omit:return subprocess.CompletedProcess(argv,1,b'',b'controlled missing asset')
   stdout.write(b'X'*p.stat().st_size if name==self.corrupt else p.read_bytes())
   return subprocess.CompletedProcess(argv,0,b'',b'')
  patches=[patch.object(m,'mac_module',return_value=self.mac),patch.object(m,'SDK',return_value=object()),patch.object(m,'verify',return_value={'sourceCommit':self.head,'version':'1.0.0','apkSHA256':'a'*64}),patch.object(self.mac,'verify',return_value={'verified':True}),patch.object(self.mac,'source_state',return_value=(self.head,[])),patch.object(self.mac,'run',side_effect=macrun),patch.object(m,'run',side_effect=androidrun),patch.object(m.subprocess,'run',side_effect=assetrun)]
  for p in patches:p.start();self.addCleanup(p.stop)
 def reject(self,fn):
  with self.assertRaises((m.ReleaseError,self.mac.Rejected)):fn()
 def test_joint_private_draft_keeps_both_union_assets_and_two_pending_only(self):
  self.astatus.write_text(self.astatus.read_text().replace('| A-REL-03 | original | condition | 通过 |','| A-REL-03 | original | condition | 待验 |').replace('| A-REL-04 | original | condition | 通过 |','| A-REL-04 | original | condition | 待验 |'))
  self.cloud.write_text(self.cloud.read_text().replace('| REL-03 | 通过 |','| REL-03 | 待验 |').replace('| REL-04 | 通过 |','| REL-04 | 待验 |'))
  result=m.joint_plan(self.args,private_draft=True);self.assertTrue(result['remoteTagOIDChecked']);self.assertIn('--draft',result['argv']);self.assertIn('--verify-tag',result['argv'])
  for name in self.expected:self.assertIn(str(self.expected[name]),result['argv'])
  self.assertFalse(result['executed']);self.assertFalse(result['publicPublication'])
 def test_android_private_pending_business_and_late_failures_never_qualify(self):
  original=self.astatus.read_text()
  for name,state in [('A-APP-01','待验'),('A-REL-03','失败'),('A-REL-04','受阻'),('A-CLOUD-01','不适用')]:
   self.astatus.write_text(original.replace('| '+name+' | original | condition | 通过 |','| '+name+' | original | condition | '+state+' |'));self.reject(lambda:m.joint_plan(self.args,True))
 def test_android_duplicate_missing_or_foreign_ids_never_qualify(self):
  original=self.astatus.read_text()
  for text in [original.replace('A-REL-05','A-REL-04'),original+'\n| A-REL-03 | original | condition | 通过 |',original.replace('A-APP-01','A-UNKNOWN-01')]:
   self.astatus.write_text(text);self.reject(lambda:m.joint_plan(self.args,True))
 def test_public_plan_all_pass_rechecks_same_id_tag_downloaded_exact_bytes(self):
  result=m.joint_public_plan(self.args)
  self.assertEqual(['gh','api','--hostname','github.com','--method','PATCH','repos/nanless/audio-paper-digest/releases/77','-F','draft=false'],result['argv'])
  self.assertTrue(result['downloadVerification']['downloadedAssetsSHAExact']);self.assertEqual(len(self.expected),result['downloadVerification']['assets']);self.assertFalse(result['executed']);self.assertFalse(result['publicPublication']);self.assertEqual(2,self.api_reads)
  self.assertFalse(any(c[:2]==['gh','release'] for c in self.commands));self.assertEqual(2,sum(c[:2]==['git','ls-remote'] for c in self.commands))
  self.assertEqual({'repos/nanless/audio-paper-digest/releases/assets/'+str(a['id']) for a in self.record['assets']},{c[6] for c in self.commands if c[:6]==['gh','api','--hostname','github.com','-H','Accept: application/octet-stream']})
 def test_public_pending_either_platform_cannot_read_or_publish_draft(self):
  for p in [self.astatus,self.cloud]:
   original=p.read_text();p.write_text(original.replace('通过','待验',1));self.reject(lambda:m.joint_public_plan(self.args));p.write_text(original)
  self.assertEqual(0,self.api_reads)
 def test_wrong_draft_id_tag_or_published_state_is_rejected(self):
  original=dict(self.record)
  for change in [{'id':78},{'tag_name':'v2.0.0'},{'draft':False},{'published_at':'already public'}]:
   self.record={**original,**change};self.reject(lambda:m.joint_public_plan(self.args))
 def test_missing_duplicate_wrongsize_or_unuploaded_asset_is_rejected(self):
  original=json.loads(json.dumps(self.record))
  for change in ['missing','duplicate','size','state']:
   self.record=json.loads(json.dumps(original))
   if change=='missing':self.record['assets'].pop()
   elif change=='duplicate':self.record['assets'][-1]=self.record['assets'][0]
   elif change=='size':self.record['assets'][0]['size']+=1
   else:self.record['assets'][0]['state']='new'
   self.reject(lambda:m.joint_public_plan(self.args))
 def test_changed_notes_and_bad_remote_tag_are_rejected(self):
  self.record['body']='unreviewed note';self.reject(lambda:m.joint_public_plan(self.args));self.record['body']='Fixed reviewed scope\n';self.remote=('2'*40+'\trefs/tags/v1.0.0\n').encode();self.reject(lambda:m.joint_public_plan(self.args))
 def test_actual_download_mismatch_and_missing_asset_are_rejected(self):
  self.corrupt='app.apk';self.reject(lambda:m.joint_public_plan(self.args));self.corrupt=None;self.omit='package.zip';self.reject(lambda:m.joint_public_plan(self.args))
 def test_same_tag_other_release_good_bytes_cannot_qualify_bad_bound_asset(self):
  # A tag-only download could return another release's good same-named bytes.
  # The bound release's actual asset has the same name and size, but different bytes.
  self.corrupt='app.apk';self.reject(lambda:m.joint_public_plan(self.args))
  self.assertTrue(any(c[:6]==['gh','api','--hostname','github.com','-H','Accept: application/octet-stream'] for c in self.commands))
  self.assertFalse(any(c[:2]==['gh','release'] for c in self.commands))
 def test_draft_mutation_during_download_is_rejected(self):
  self.after=lambda record:record.update(name='changed title');self.reject(lambda:m.joint_public_plan(self.args))
 def test_current_head_change_retains_original_source_gate(self):
  with patch.object(self.mac,'source_state',return_value=('2'*40,[])):self.reject(lambda:m.joint_public_plan(self.args))
 def test_final_negative_draft_id_is_not_a_free_form_api_target(self):
  self.args.draft_id=-1;self.reject(lambda:m.joint_public_plan(self.args));self.assertEqual([],self.commands)

if __name__=='__main__':unittest.main(verbosity=2)

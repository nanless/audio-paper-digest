"""TEST ONLY: isolated six-asset Android stages; no network, SDK, key or real release."""
import copy,importlib.util,json,pathlib,subprocess,tempfile,types,unittest,zipfile
from unittest.mock import patch
P=pathlib.Path
REPO=P(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('android_only_release',REPO/'apps/android/release_tools.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class AndroidReleaseStages(unittest.TestCase):
 def setUp(self):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.p=P(tmp.name).resolve()
  self.folder=self.p/'prepared';self.folder.mkdir();self.download=self.p/'downloaded';self.download.mkdir()
  self.head='1'*40;self.source={'sourceCommit':self.head,'files':[{'path':'apps/android/test-only','bytes':1,'sha256':'2'*64}]}
  self.apk='paperdigest-android-1.3.1-9-universal.apk';self.certificate='3'*64
  with zipfile.ZipFile(self.folder/self.apk,'w') as z:z.writestr('AndroidManifest.xml',b'controlled test-only manifest');z.writestr('resources.arsc',b'controlled test-only resources')
  self.dump('android-source-inputs.json',self.source);self.dump('android-runtime-materials.json',{'testOnly':True})
  inventory=m.payload_inventory(self.folder/self.apk)
  self.inspection={'sha256':m.file_sha(self.folder/self.apk),'testOnly':True}
  self.info={'contract':'paperdigest-android-signed-v1','sourceCommit':self.head,'versionName':'1.3.1','versionCode':9,
   'sourceInputsSHA256':m.file_sha(self.folder/'android-source-inputs.json'),'runtimeMaterialsSHA256':m.file_sha(self.folder/'android-runtime-materials.json'),
   'unsignedPayload':inventory,'unsignedPayloadInventorySHA256':m.sha(m.canonical(inventory)),'signed':self.inspection}
  self.dump('android-build-info.json',self.info);self.reseal()
  self.mac=m.mac_module(REPO);self.status=self.p/'android.md';self.notes=self.p/'ANDROID-NOTES.md'
  self.status.write_text('\n'.join('| A-'+n+' | original requirement | 本版证据 | 通过 |' for n in sorted(self.mac.IDS|self.mac.CLOUD_IDS)),encoding='utf-8')
  self.notes.write_text('Android 1.3.1 独立修复版\n手机阅读与启动修复；Mac 仍为 1.3.0。\n',encoding='utf-8')
  self.args=types.SimpleNamespace(prepared=self.folder,repo=REPO,sdk=self.p/'no-sdk',certificate=self.certificate,
   android_acceptance=self.status,notes_file=self.notes,draft_id=91,downloaded=self.download)
  self.tag={'tag':'v1.3.1','commitOID':self.head,'annotated':True};self.tag_oid='a'*40;self.reads=0;self.after=None;self.local_mutation=None;self.corrupt=None;self.omit=None;self.commands=[];self.inspected=[]
  self.record={'id':91,'tag_name':'v1.3.1','target_commitish':self.head,'draft':True,'published_at':None,'prerelease':False,
   'name':'论文速递工作台 Android 1.3.1','body':self.notes.read_text(encoding='utf-8'),'updated_at':'fixed',
   'assets':[{'id':101+i,'name':p.name,'size':p.stat().st_size,'state':'uploaded','digest':'sha256:'+m.file_sha(p),'download_count':0} for i,p in enumerate(sorted(self.folder.iterdir()))]}
  def inspect(apk,repo,sdk,version,code,runtime,certificate):
   self.inspected.append((apk,certificate));m.require(certificate==self.certificate,'certificate_mismatch')
   return {**self.inspection,'sha256':m.file_sha(apk)}
  def api(argv,code,env=None):
   self.assertEqual(['gh','api','--hostname','github.com','repos/nanless/audio-paper-digest/releases/91'],argv)
   self.commands.append(argv);self.reads+=1;record=copy.deepcopy(self.record)
   if self.reads%2==0:
    for asset in record['assets']:asset['download_count']+=1
    if self.after:self.after(record)
   return json.dumps(record,ensure_ascii=False)
  def asset(argv,stdout,stderr,timeout):
   self.assertEqual(['gh','api','--hostname','github.com','-H','Accept: application/octet-stream'],argv[:6]);self.assertEqual(1200,timeout)
   self.commands.append(argv);a=next(a for a in self.record['assets'] if argv[6]=='repos/nanless/audio-paper-digest/releases/assets/'+str(a['id']))
   if self.local_mutation:self.local_mutation();self.local_mutation=None
   if a['name']==self.omit:return subprocess.CompletedProcess(argv,1)
   data=(self.folder/a['name']).read_bytes();stdout.write(b'X'*len(data) if a['name']==self.corrupt else data)
   return subprocess.CompletedProcess(argv,0)
  def tag_read(argv):
   self.assertEqual(['git','ls-remote','--tags','https://github.com/nanless/audio-paper-digest.git','refs/tags/v1.3.1','refs/tags/v1.3.1^{}'],argv)
   return (self.tag_oid+'\trefs/tags/v1.3.1\n'+self.head+'\trefs/tags/v1.3.1^{}\n').encode('ascii')
  for p in [patch.object(m,'SDK',return_value=object()),patch.object(m,'source_state',side_effect=lambda repo:copy.deepcopy(self.source)),
   patch.object(m,'inspect',side_effect=inspect),patch.object(m,'mac_module',return_value=self.mac),
   patch.object(self.mac,'run',side_effect=tag_read),
   patch.object(self.mac,'verified_remote_tag',side_effect=lambda tag,head:copy.deepcopy(self.tag)),
   patch.object(m,'run',side_effect=api),patch.object(m.subprocess,'run',side_effect=asset)]:p.start();self.addCleanup(p.stop)
 def dump(self,name,obj): (self.folder/name).write_bytes(m.canonical(obj)+b'\n')
 def reseal(self):
  names=[self.apk,'android-build-info.json','android-source-inputs.json','android-runtime-materials.json']
  assets={n:{'bytes':(self.folder/n).stat().st_size,'sha256':m.file_sha(self.folder/n)} for n in names}
  self.dump('android-release-manifest.json',{'contract':'paperdigest-android-release-v1','assets':assets})
  (self.folder/'ANDROID-SHA256SUMS').write_text(''.join(f"{a['sha256']}  {n}\n" for n,a in sorted(assets.items())))
 def reject(self,fn,code=None):
  with self.assertRaises(m.ReleaseError) as caught:fn()
  if code:self.assertEqual(code,str(caught.exception))
 def pending(self,name='A-REL-03'):
  self.status.write_text(self.status.read_text().replace('| '+name+' | original requirement | 本版证据 | 通过 |','| '+name+' | original requirement | 本版证据 | 待验 |'))
 def copy_download(self):
  for p in self.folder.iterdir():(self.download/p.name).write_bytes(p.read_bytes())
 def test_private_android_only_six_assets_annotated_tag_notes_and_two_pending(self):
  self.pending();self.pending('A-REL-04');result=m.android_private_draft_plan(self.args)
  self.assertEqual(6,result['assets']);self.assertFalse(result['executed']);self.assertFalse(result['publicPublication'])
  argv=result['argv'];self.assertIn('--draft',argv);self.assertIn('--verify-tag',argv);self.assertEqual(self.head,argv[argv.index('--target')+1])
  self.assertEqual(str(self.notes),argv[argv.index('--notes-file')+1]);self.assertEqual(m.file_sha(self.notes),result['notes']['sha256'])
  self.assertEqual({str(p) for p in self.folder.iterdir()},set(argv[4:argv.index('--repo')]))
  self.assertEqual([],self.commands);self.assertEqual(1,len(self.inspected))
 def test_private_never_accepts_business_pending_bad_status_duplicate_or_missing_id(self):
  original=self.status.read_text()
  for text in [original.replace('| A-APP-01 | original requirement | 本版证据 | 通过 |','| A-APP-01 | original requirement | 本版证据 | 待验 |'),original.replace('A-REL-04','A-REL-03'),original.replace('A-REL-04','A-UNKNOWN-04'),original.replace('通过','失败',1)]:
   with self.subTest(text=text[:30]):self.status.write_text(text);self.reject(lambda:m.android_private_draft_plan(self.args),'android_acceptance_incomplete')
 def test_private_rejects_lightweight_wrong_tag_and_wrong_source(self):
  original=copy.deepcopy(self.tag)
  for changes in [{'annotated':False},{'tag':'v1.3.0'},{'commitOID':'2'*40}]:
   self.tag={**original,**changes};self.reject(lambda:m.android_private_draft_plan(self.args),'annotated_remote_tag_required')
 def test_source_must_equal_native_current_source(self):
  self.source['sourceCommit']='2'*40;self.reject(lambda:m.android_private_draft_plan(self.args),'source_changed')
 def test_local_missing_extra_and_manifest_extra_assets_rejected(self):
  p=self.folder/'unexpected.txt';p.write_bytes(b'extra');self.reject(lambda:m.android_private_draft_plan(self.args),'android_asset_set');p.unlink()
  manifest=m.load(self.folder/'android-release-manifest.json');manifest['assets']['unexpected.txt']={'bytes':0,'sha256':'0'*64};self.dump('android-release-manifest.json',manifest)
  self.reject(lambda:m.android_private_draft_plan(self.args),'android_asset_set');self.reseal()
  (self.folder/'android-runtime-materials.json').unlink();self.reject(lambda:m.android_private_draft_plan(self.args),'android_asset_set')
 def test_notes_must_be_explicit_regular_utf8_chinese(self):
  self.notes.write_text('English-only notes\n');self.reject(lambda:m.android_private_draft_plan(self.args),'android_chinese_notes_required')
  self.notes.unlink();self.notes.symlink_to(self.status);self.reject(lambda:m.android_private_draft_plan(self.args),'symlink_path')
 def test_selected_prepared_symlink_is_rejected_before_resolution(self):
  alias=self.p/'alias';alias.symlink_to(self.folder,target_is_directory=True);self.args.prepared=alias
  self.reject(lambda:m.android_private_draft_plan(self.args),'symlink_path')
 def test_real_verifier_signature_failure_not_replaced_by_plan_metadata(self):
  self.args.certificate='4'*64;self.reject(lambda:m.android_private_draft_plan(self.args),'certificate_mismatch')
 def test_local_payload_replacement_even_resealed_manifest_fails_normal_verifier(self):
  with zipfile.ZipFile(self.folder/self.apk,'a') as z:z.writestr('classes.dex',b'unreviewed new payload')
  self.reseal();self.reject(lambda:m.android_private_draft_plan(self.args),'signed_payload_changed')
 def test_public_all86_exact_id_download_and_normal_verifier_without_mutation(self):
  result=m.android_public_plan(self.args)
  self.assertEqual(['gh','api','--hostname','github.com','--method','PATCH','repos/nanless/audio-paper-digest/releases/91','-F','draft=false'],result['argv'])
  self.assertFalse(result['executed']);self.assertFalse(result['publicPublication']);self.assertEqual(6,result['downloadVerification']['assets']);self.assertTrue(result['downloadVerification']['androidAPKReverified'])
  self.assertEqual(2,len(self.inspected));self.assertEqual(2,self.reads)
  self.assertEqual({'repos/nanless/audio-paper-digest/releases/assets/'+str(a['id']) for a in self.record['assets']},{c[6] for c in self.commands if len(c)>6})
  self.assertFalse(any('--method' in c or 'release' in c for c in self.commands))
 def test_public_pending_rejected_before_api_read(self):
  self.pending();self.reject(lambda:m.android_public_plan(self.args),'android_acceptance_incomplete');self.assertEqual(0,self.reads)
 def test_public_id_tag_source_and_state_are_exact(self):
  original=copy.deepcopy(self.record)
  for changes in [{'id':92},{'tag_name':'v1.3.0'},{'target_commitish':'main'},{'target_commitish':'2'*40},{'draft':False},{'published_at':'already public'},{'prerelease':True}]:
   self.record={**original,**changes};self.reject(lambda:m.android_public_plan(self.args),'existing_private_draft_required')
 def test_public_notes_are_exact_including_newline(self):
  self.record['body']=self.record['body'].rstrip('\n');self.reject(lambda:m.android_public_plan(self.args),'draft_notes_changed')
 def test_remote_missing_extra_duplicate_and_wrong_metadata(self):
  original=copy.deepcopy(self.record)
  for kind in ['missing','extra','duplicate-id','duplicate-name','size','state','digest']:
   self.record=copy.deepcopy(original);assets=self.record['assets']
   if kind=='missing':assets.pop()
   elif kind=='extra':assets.append({**assets[0],'name':'extra'})
   elif kind=='duplicate-id':assets[1]['id']=assets[0]['id']
   elif kind=='duplicate-name':assets[1]=copy.deepcopy(assets[0])
   elif kind=='size':assets[0]['size']+=1
   elif kind=='state':assets[0]['state']='new'
   else:assets[0]['digest']='sha256:'+'0'*64
   self.reject(lambda:m.android_public_plan(self.args))
 def test_download_bytes_bound_to_asset_id_and_missing_download_rejected(self):
  self.corrupt=self.apk;self.reject(lambda:m.android_public_plan(self.args),'download_sha_mismatch');self.corrupt=None
  self.omit=self.apk;self.reject(lambda:m.android_public_plan(self.args),'draft_download_failed')
 def test_download_normal_verifier_runs_even_when_all_hashes_match(self):
  original=m.verify
  def fail_download(folder,*args):
   if P(folder)!=self.folder:raise m.ReleaseError('controlled_signature_failure')
   return original(folder,*args)
  with patch.object(m,'verify',side_effect=fail_download):self.reject(lambda:m.android_public_plan(self.args),'controlled_signature_failure')
 def test_public_cas_draft_title_asset_and_notes_changes_rejected(self):
  for kind in ['title','notes','asset']:
   def change(record):
    if kind=='asset':record['assets'][0]['updated_at']='changed'
    else:record['name' if kind=='title' else 'body']+=' changed'
   self.after=change;self.reads=0;self.reject(lambda:m.android_public_plan(self.args))
 def test_public_cas_local_notes_and_acceptance_changes_rejected(self):
  for path in [self.notes,self.status]:
   original=path.read_bytes();self.local_mutation=lambda:path.write_bytes(original+b'\n')
   self.reject(lambda:m.android_public_plan(self.args),'qualification_changed');path.write_bytes(original);self.reads=0
 def test_public_cas_source_changes_rejected(self):
  self.local_mutation=lambda:self.source.update(sourceCommit='2'*40)
  self.reject(lambda:m.android_public_plan(self.args),'source_changed')
 def test_public_cas_remote_tag_object_changes_rejected(self):
  self.local_mutation=lambda:setattr(self,'tag_oid','b'*40)
  self.reject(lambda:m.android_public_plan(self.args),'remote_tag_changed')
 def test_real_shared_tag_helper_and_annotation_object_guard(self):
  # Other tests isolate the shared helper; this one executes its actual parser.
  spec=importlib.util.spec_from_file_location('android_only_real_tag',REPO/'apps/macos/release_tools.py')
  mac=importlib.util.module_from_spec(spec);spec.loader.exec_module(mac)
  raw=(self.tag_oid+'\trefs/tags/v1.3.1\n'+self.head+'\trefs/tags/v1.3.1^{}\n').encode('ascii')
  with patch.object(mac,'run',return_value=raw),patch.object(m,'mac_module',return_value=mac):
   result=m.android_private_draft_plan(self.args);self.assertEqual(self.tag_oid,result['remoteTag']['tagObjectOID'])
  with patch.object(mac,'run',return_value=(self.head+'\trefs/tags/v1.3.1\n').encode('ascii')),patch.object(m,'mac_module',return_value=mac):
   self.reject(lambda:m.android_private_draft_plan(self.args),'annotated_remote_tag_required')
 def test_private_cas_notes_and_acceptance_changed_during_tag_read(self):
  for path in [self.notes,self.status]:
   original=path.read_bytes()
   def tag_read(tag,head):path.write_bytes(original+b'\n');return copy.deepcopy(self.tag)
   with patch.object(self.mac,'verified_remote_tag',side_effect=tag_read):
    self.reject(lambda:m.android_private_draft_plan(self.args),'qualification_changed')
   path.write_bytes(original)
 def test_public_cas_original_release_bytes_changed_during_download(self):
  self.local_mutation=lambda:(self.folder/'ANDROID-SHA256SUMS').write_bytes(b'unreviewed checksums')
  self.reject(lambda:m.android_public_plan(self.args))
 def test_public_invalid_id_never_reads_remote(self):
  for value in [0,-1,True,'91']:
   self.args.draft_id=value;self.reject(lambda:m.android_public_plan(self.args),'draft_id_required')
  self.assertEqual([],self.commands)
 def test_verify_android_downloaded_is_offline_six_exact_and_real_verify(self):
  self.copy_download();result=m.verify_android_downloaded(self.args)
  self.assertTrue(result['downloadedAssetsSHAExact']);self.assertEqual(6,result['assets']);self.assertEqual(1,len(self.inspected));self.assertEqual([],self.commands)
 def test_verified_download_cannot_change_between_comparison_and_copy(self):
  self.copy_download();original=m.shutil.copyfile
  def changed(source,target):
   result=original(source,target)
   if P(source).name==self.apk:P(target).write_bytes(b'X'*P(target).stat().st_size)
   return result
  with patch.object(m.shutil,'copyfile',side_effect=changed):
   self.reject(lambda:m.verify_android_downloaded(self.args),'download_sha_mismatch')
 def test_offline_missing_extra_same_size_replaced_bytes_and_symlink_rejected(self):
  self.copy_download();extra=self.download/'extra';extra.write_bytes(b'bad');self.reject(lambda:m.verify_android_downloaded(self.args),'download_asset_set');extra.unlink()
  apk=self.download/self.apk;original=apk.read_bytes();apk.write_bytes(b'X'*len(original));self.reject(lambda:m.verify_android_downloaded(self.args),'download_sha_mismatch')
  apk.unlink();apk.symlink_to(self.folder/self.apk);self.reject(lambda:m.verify_android_downloaded(self.args),'symlink_path');apk.unlink()
  self.reject(lambda:m.verify_android_downloaded(self.args),'download_asset_set')
 def test_cli_android_entries_have_no_mac_requirement_and_never_fall_into_joint(self):
  for name,fn in [('android-private-draft-plan','android_private_draft_plan'),('android-public-plan','android_public_plan'),('verify-android-downloaded','verify_android_downloaded')]:
   argv=['release_tools.py','--repo',str(REPO),name,'--prepared',str(self.folder),'--certificate',self.certificate]
   argv+=['--downloaded',str(self.download)] if name=='verify-android-downloaded' else ['--android-acceptance',str(self.status),'--notes-file',str(self.notes)]
   if name=='android-public-plan':argv+=['--draft-id','91']
   with patch.object(m.sys,'argv',argv),patch.object(m,fn,return_value={'testOnly':True}) as called,patch('builtins.print'):
    m.main();called.assert_called_once();self.assertFalse(hasattr(called.call_args.args[0],'mac'))

if __name__=='__main__':unittest.main(verbosity=2)

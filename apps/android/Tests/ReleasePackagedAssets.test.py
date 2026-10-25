import importlib.util,json,os,pathlib,tempfile,unittest,zipfile
from unittest.mock import patch
P=pathlib.Path
ROOT=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('asset_release',ROOT/'release_tools.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class PackagedAssets(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=P(self.temp.name).resolve()
  self.repo=self.root/'repo';self.assets=self.root/'extracted';self.assets.mkdir();self.cache=self.root/'gradle'
  self.archive=self.cache/'caches/modules-2/files-2.1/com.tom-roush/pdfbox-android/2.0.27.0/synthetic/pdfbox-android-2.0.27.0.aar';self.archive.parent.mkdir(parents=True)
  self.library={f'com/tom_roush/resource-{i}.txt':f'synthetic-public-{i}'.encode() for i in range(112)}
  with zipfile.ZipFile(self.archive,'w') as z:
   for name,data in self.library.items():z.writestr('assets/'+name,data)
  self.pin={**m.PDFBOX_ASSET_SOURCE,'bytes':self.archive.stat().st_size,'sha256':m.file_sha(self.archive)}
  self.materials=self.root/'materials.json';self.materials.write_text(json.dumps({'artifacts':[self.pin]}))
  self.profiles={}
  for name,relative in m.RELEASE_PROFILE_OUTPUTS.items():
   p=self.repo/'apps/android/app/build/intermediates'/relative;p.parent.mkdir(parents=True,exist_ok=True);data=('synthetic-'+name).encode();p.write_bytes(data);self.profiles[name]=p
  for name,data in {**self.library,**{n:p.read_bytes() for n,p in self.profiles.items()}}.items():
   target=self.assets/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
  self.env=patch.dict(os.environ,{'GRADLE_USER_HOME':str(self.cache)});self.env.start();self.addCleanup(self.env.stop)
  self.constant=patch.object(m,'PDFBOX_ASSET_SOURCE',self.pin);self.constant.start();self.addCleanup(self.constant.stop)
 def audit(self):return m.audit_packaged_asset_sources(self.assets,self.repo,self.materials)
 def fails(self,code):
  with self.assertRaises(m.ReleaseError) as e:self.audit()
  self.assertEqual(code,str(e.exception))
 def test_exact_sources_derive_every_member_and_keep_generated_tree(self):
  generated=self.assets/'licenses/public.txt';generated.parent.mkdir();generated.write_bytes(b'generated-public')
  record=self.audit();self.assertEqual(112,record['libraryFiles']);self.assertEqual(2,record['profileFiles']);self.assertEqual(114,len(record['files']))
  self.assertEqual(b'generated-public',generated.read_bytes());self.assertFalse(any((self.assets/n).exists() for n in record['files']))
  self.assertNotIn(str(self.root),json.dumps(record));self.assertEqual(self.pin,record['libraryArtifact'])
 def test_missing_library_member_is_not_hidden_by_projection(self):
  (self.assets/next(iter(self.library))).unlink();self.fails('missing_regular_file');self.assertTrue((self.assets/'dexopt/baseline.prof').exists())
 def test_changed_library_member_rejected_before_projection(self):
  (self.assets/next(iter(self.library))).write_bytes(b'changed');self.fails('packaged_source_asset_changed');self.assertTrue((self.assets/'dexopt/baseline.prof').exists())
 def test_unknown_extra_is_left_for_original_generated_audit_to_reject(self):
  unknown=self.assets/'com/tom_roush/unreviewed.txt';unknown.write_bytes(b'unknown');self.audit();self.assertEqual(b'unknown',unknown.read_bytes())
  self.assertIn("m.auditGeneratedAssets(assets,'release')",m.NODE_AUDIT)
 def test_wrong_materials_cannot_grant_an_archive_or_caller_path(self):
  self.materials.write_text(json.dumps({'artifacts':[{**self.pin,'sha256':'0'*64,'localArtifact':str(self.archive)}]}));self.fails('packaged_library_source_changed')
 def test_changed_whole_archive_cannot_borrow_original_member_inventory(self):
  self.archive.write_bytes(self.archive.read_bytes()+b'changed');self.fails('packaged_library_archive_changed')
 def test_multiple_archive_matches_fail_closed_even_when_identical(self):
  other=self.archive.parent.parent/'other'/self.archive.name;other.parent.mkdir();other.write_bytes(self.archive.read_bytes());self.fails('packaged_library_archive_missing_or_ambiguous')
 def test_archive_symlink_is_refused_before_hash(self):
  original=self.root/'original.aar';self.archive.rename(original);self.archive.symlink_to(original)
  with patch.object(m,'file_sha',side_effect=AssertionError('must check link before hash')):self.fails('symlink_path')
 def test_profile_must_match_actual_fixed_build_output(self):
  self.profiles['dexopt/baseline.prof'].write_bytes(b'new-build');self.fails('packaged_source_asset_changed')
 def test_missing_profile_original_is_not_authorized_by_apk_bytes(self):
  self.profiles['dexopt/baseline.profm'].unlink();self.fails('missing_regular_file')
 def test_profile_symlink_is_not_a_caller_read_capability(self):
  p=self.profiles['dexopt/baseline.prof'];original=self.root/'profile-original';p.rename(original);p.symlink_to(original);self.fails('symlink_path')
 def test_new_profile_build_cannot_equal_prior_prepared_audit(self):
  original=self.audit()
  self.profiles['dexopt/baseline.prof'].write_bytes(b'new-compiled-profile')
  for name,data in {**self.library,**{n:p.read_bytes() for n,p in self.profiles.items()}}.items():(self.assets/name).write_bytes(data)
  current=self.audit();self.assertNotEqual(original,current)
  self.assertNotEqual(original['files']['dexopt/baseline.prof']['sha256'],current['files']['dexopt/baseline.prof']['sha256'])

if __name__=='__main__':unittest.main(verbosity=2)

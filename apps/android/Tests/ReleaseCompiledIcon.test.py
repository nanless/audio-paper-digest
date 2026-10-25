import importlib.util,pathlib,unittest,zipfile,hashlib
from unittest.mock import patch
P=pathlib.Path;app_root=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release_original_regression_helpers',app_root/'Tests/ReleasePackaging.test.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base);m=base.m
class CompiledIconBinding(unittest.TestCase):
 def setUp(self):
  self.helper=base.ReleaseTests('test_manifest_matches_expected_version_sdk_security');self.helper.setUp();self.addCleanup(self.helper.doCleanups)
 def packed(self,payload=None,decoy=False):
  original,sdk=self.helper.fake_inspect();target=self.helper.p/'optimized.apk'
  with zipfile.ZipFile(original)as source,zipfile.ZipFile(target,'w')as output:
   for entry in source.infolist():
    data=source.read(entry)
    if entry.filename=='res/drawable-nodpi/pd_icon.png':
     if decoy:output.writestr(entry,data)
     output.writestr('res/Zg.png',data if payload is None else payload)
    else:output.writestr(entry,data)
  return target,sdk
 def audit(self,apk,sdk):
  binding={'pngPath':'res/Zg.png','adaptiveReferenceVerified':True,'insetPercent':16,'background':'#ff24282d'}
  with patch.object(m,'compiled_icon',return_value=binding),patch.object(m,'run',return_value='{"runtime":{"records":123},"resources":{"channel":"release"},"licenseFiles":632}'):
   return m.inspect(apk,base.REPO,sdk,'1.0.0',1,self.helper.p/'synthetic.json')
 def test_optimized_path_uses_exact_compiled_resource_reference(self):
  apk,sdk=self.packed();before=m.file_sha(apk);value=self.audit(apk,sdk)
  self.assertEqual('res/Zg.png',value['icon']['pngPath']);self.assertEqual(m.ICON_SHA,value['icon']['sha256']);self.assertEqual(m.ICON_SHA,value['icon']['originalSourceSHA256']);self.assertEqual(before,m.file_sha(apk))
 def test_only_exact_two_independently_reviewed_encodings_are_allowed(self):
  self.assertEqual({'18b7f280a530e6a881bc7017a1f78d6ba2c1a65741dea6a04116782433e3fbfb','60456a5becd90786a1aac02afdeb5fa1b2f82a4aab7bdb265a13bf80efb6d4be'},m.ICON_PACKAGED_SHAS)
 def test_named_original_decoy_cannot_replace_wrong_bound_resource(self):
  apk,sdk=self.packed(b'synthetic-wrong-bound-icon',decoy=True)
  with self.assertRaises(m.ReleaseError)as error:self.audit(apk,sdk)
  self.assertEqual('c_icon_changed',str(error.exception))
 def test_unreviewed_encoding_is_refused_even_with_original_png_prefix(self):
  original=(base.REPO/'apps/android/app/src/main/res/drawable-nodpi/pd_icon.png').read_bytes();apk,sdk=self.packed(original+b'synthetic-unreviewed-extra-bytes')
  with self.assertRaises(m.ReleaseError)as error:self.audit(apk,sdk)
  self.assertEqual('c_icon_changed',str(error.exception))
 def test_changed_source_cannot_borrow_approved_packaged_icon(self):
  apk,sdk=self.packed();source=(base.REPO/'apps/android/app/src/main/res/drawable-nodpi/pd_icon.png').resolve();real=m.file_sha
  def observed(path):return '0'*64 if P(path).resolve()==source else real(path)
  with patch.object(m,'file_sha',side_effect=observed):
   with self.assertRaises(m.ReleaseError)as error:self.audit(apk,sdk)
  self.assertEqual('c_icon_source_changed',str(error.exception))
if __name__=='__main__':unittest.main(verbosity=2)

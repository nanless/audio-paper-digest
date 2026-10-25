import pathlib,importlib.util,tempfile,unittest
P=pathlib.Path;app_root=P(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('release_canonical_tool',app_root/'release_tools.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class CanonicalKeyLocation(unittest.TestCase):
 def test_dotdot_spelling_cannot_make_repository_internal_key_appear_external(self):
  with tempfile.TemporaryDirectory()as tmp:
   p=P(tmp).resolve();repo=p/'repo';repo.mkdir();private=repo/'private';private.mkdir(mode=0o700);key=private/'dummy.jks';key.write_bytes(b'NOT A KEY');key.chmod(0o600);(p/'walk').mkdir()
   spelling=p/'walk/../repo/private/dummy.jks'
   self.assertEqual(key,spelling.resolve())
   with self.assertRaises(m.ReleaseError,msg='Real canonical keystore lies inside repository despite alternate lexical spelling'):m.private_keystore(spelling,repo)
if __name__=='__main__':unittest.main(verbosity=2)

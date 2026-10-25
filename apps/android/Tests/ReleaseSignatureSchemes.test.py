import importlib.util,pathlib,unittest
P=pathlib.Path;ROOT=P(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('signature_release',ROOT/'release_tools.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
PIN='0'*64
# The real apksigner36 output pattern: only the scheme used in each SDK range is true.
APP_OUTPUT='Verifies\nVerified using v2 scheme (APK Signature Scheme v2): false\nVerified using v3 scheme (APK Signature Scheme v3): true\nNumber of signers: 1\nSigner #1 certificate DN: CN=PaperDigest\nSigner #1 certificate SHA-256 digest: '+PIN+'\n'
BLOCK_OUTPUT='Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nVerified using v3 scheme (APK Signature Scheme v3): false\nNumber of signers: 1\nSigner #1 certificate DN: CN=PaperDigest\nSigner #1 certificate SHA-256 digest: '+PIN+'\n'
class SDK:
 def __init__(self,app=APP_OUTPUT,block=BLOCK_OUTPUT):self.outputs=[app,block];self.calls=[]
 def call(self,name,*args):self.calls.append((name,args));return self.outputs.pop(0)
class Schemes(unittest.TestCase):
 def fails(self,code,sdk,pin=PIN):
  with self.assertRaises(m.ReleaseError) as e:m.signature_facts(P('synthetic.apk'),sdk,pin)
  self.assertEqual(code,str(e.exception))
 def test_real_range_pattern_accepts_v3_app_and_independent_v2_block(self):
  sdk=SDK();facts=m.signature_facts(P('synthetic.apk'),sdk,PIN)
  self.assertEqual([(28,37),(24,27)],[(int(args[args.index('--min-sdk-version')+1]),int(args[args.index('--max-sdk-version')+1])) for _,args in sdk.calls])
  self.assertEqual(28,facts['applicationMinSDK']);self.assertEqual(28,facts['verifiedMinSDK']);self.assertEqual(37,facts['verifiedMaxSDK']);self.assertEqual(24,facts['v2BlockProofMinSDK']);self.assertEqual(27,facts['v2BlockProofMaxSDK']);self.assertTrue(facts['v2'] and facts['v3'])
 def test_v3_missing_at_app_range_fails_even_when_v2_exists(self):self.fails('signature_schemes',SDK(APP_OUTPUT.replace('v3): true','v3): false')))
 def test_v2_missing_at_block_range_fails_even_when_v3_app_passes(self):self.fails('signature_schemes',SDK(block=BLOCK_OUTPUT.replace('v2): true','v2): false')))
 def test_second_range_must_match_the_same_pinned_certificate(self):self.fails('release_certificate_mismatch',SDK(block=BLOCK_OUTPUT.replace(PIN,'1'*64)))
 def test_first_range_wrong_certificate_is_not_repaired_by_second(self):self.fails('release_certificate_mismatch',SDK(app=APP_OUTPUT.replace(PIN,'1'*64)))
 def test_duplicate_signer_is_refused_in_either_range(self):
  for first in [True,False]:
   extra='Signer #2 certificate SHA-256 digest: '+PIN+'\n';self.fails('release_certificate_mismatch',SDK(APP_OUTPUT+extra if first else APP_OUTPUT,BLOCK_OUTPUT if first else BLOCK_OUTPUT+extra))
 def test_debug_certificate_is_refused_in_either_range(self):
  for first in [True,False]:self.fails('release_certificate_mismatch',SDK(APP_OUTPUT.replace('CN=PaperDigest','CN=Android Debug') if first else APP_OUTPUT,BLOCK_OUTPUT if first else BLOCK_OUTPUT.replace('CN=PaperDigest','CN=Android Debug')))
 def test_invalid_pin_is_rejected_before_official_tool_calls(self):
  sdk=SDK();self.fails('certificate_pin_format',sdk,'not-a-pin');self.assertEqual([],sdk.calls)
if __name__=='__main__':unittest.main(verbosity=2)

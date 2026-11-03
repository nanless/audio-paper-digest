import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from protocol_codec import Codec

SPEC = importlib.util.spec_from_file_location('client_protocol_generator', ROOT / 'apps/generate-client-protocols.py')
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)
FIXTURE = json.loads((ROOT / 'tests/fixtures/workbench/client-protocol-history.json').read_text())


class ClientProtocolGenerationTest(unittest.TestCase):
    def test_complete_historical_schema_is_required_and_sha_bound(self):
        codec = Codec([FIXTURE['catalog']])
        expected = FIXTURE['expected']
        name = expected['name']
        self.assertEqual(codec.schema_fingerprint(name), expected['currentFingerprint'])
        self.assertEqual(codec.record_header(name, name, expected['historicalFingerprint']),
                         FIXTURE['catalog']['protocols'][0]['historical'][0]['header'])
        for mutation in ('schema', 'fingerprint', 'missing-schema'):
            bad = copy.deepcopy(FIXTURE['catalog'])
            old = bad['protocols'][0]['historical'][0]
            if mutation == 'schema':
                old['schema']['algorithm'] = 'different-algorithm'
            elif mutation == 'fingerprint':
                old['header']['schemaFingerprint'] = '0' * 64
            else:
                del old['schema']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                Codec([bad])

    def test_current_generated_files_are_exact(self):
        for path, expected in generator.rendered_sources().items():
            self.assertEqual(path.read_text(), expected, str(path))

    def test_private_native_catalog_changes_do_not_rewrite_frozen_public_registry(self):
        with tempfile.TemporaryDirectory(prefix='client-public-private-formats-') as temporary:
            root=Path(temporary);(root/'config/protocols').mkdir(parents=True);(root/'apps').mkdir()
            shutil.copyfile(ROOT/'config/protocols/clients.json',root/'config/protocols/clients.json')
            shutil.copyfile(ROOT/'apps/public-protocol-api.js',root/'apps/public-protocol-api.js')
            blog=root/'blog';prior_root=generator.ROOT
            try:
                generator.ROOT=root;before=generator.rendered_sources(blog)
                (root/'config/protocols/clients-private-fixture.json').write_text(json.dumps({'protocols':[{
                    'name':'client-private-fixture','currentVariant':'native-only-test-payload',
                    'currentSchema':{'fields':['payload'],'scope':'synthetic-private-format-only'},'historical':[]}]}))
                after=generator.rendered_sources(blog)
            finally:
                generator.ROOT=prior_root
            for target in (blog/'assets/js/protocol-registry.js',blog/'data/paperdigest-protocols.json'):
                self.assertEqual(before[target],after[target],str(target))
            self.assertNotEqual(before[root/'apps/macos/Sources/ClientProtocolRegistry.generated.swift'],
                                after[root/'apps/macos/Sources/ClientProtocolRegistry.generated.swift'])
            value=json.loads(after[blog/'data/paperdigest-protocols.json'])
            import hashlib
            from protocol_codec import canonical
            self.assertEqual(value['catalogSHA256'],hashlib.sha256(canonical(value['families']).encode('utf-8')).hexdigest())

    def test_actual_swift_reader_selects_both_complete_schemas_without_changing_old_header(self):
        with tempfile.TemporaryDirectory(prefix='client-protocol-history-') as temporary:
            root = Path(temporary)
            (root / 'config/protocols').mkdir(parents=True)
            (root / 'apps').mkdir()
            actual = json.loads((ROOT / 'config/protocols/clients.json').read_text())
            actual['protocols'].extend(FIXTURE['catalog']['protocols'])
            (root / 'config/protocols/clients.json').write_text(json.dumps(actual))
            shutil.copyfile(ROOT / 'apps/public-protocol-api.js', root / 'apps/public-protocol-api.js')
            prior_root = generator.ROOT
            try:
                generator.ROOT = root
                outputs = generator.rendered_sources()
            finally:
                generator.ROOT = prior_root
            source = root / 'Registry.swift'
            source.write_text(outputs[root / 'apps/macos/Sources/ClientProtocolRegistry.generated.swift'])
            current = FIXTURE['expected']['currentFingerprint']
            old = FIXTURE['expected']['historicalFingerprint']
            main = root / 'Checks.swift'
            swift = '''import Foundation
@main struct Checks {
 static func main() throws {
  let name="client-protocol-test",old="OLD_FP",current="CURRENT_FP"
  let before=try ClientProtocols.recordHeader(name,name,old)
  precondition(before["schemaFingerprint"] as? String == old)
  precondition(ClientProtocols.hasValidHeader(before,name))
  precondition(!ClientProtocols.isCurrentHeader(before,name))
  precondition(try ClientProtocols.format(name,name,old)=="original-payload")
  precondition(try ClientProtocols.format(name,name,current)=="source-bound-payload")
  precondition(try ClientProtocols.recordHeader(name,name)["schemaFingerprint"] as? String == current)
  do { _=try ClientProtocols.format(name,name);fatalError("ambiguous format accepted") } catch {}
  do { _=try ClientProtocols.historicalContract(name,variant:"original-payload");fatalError("fingerprint dropped") } catch {}
  var forged=before;forged["schemaFingerprint"]=String(repeating:"0",count:64)
  precondition(!ClientProtocols.hasValidHeader(forged,name))
  var schema=try ClientProtocols.declaredSchema(name,name,old);schema["algorithm"]="changed"
  precondition(try ClientProtocols.declaredSchema(name,name,old)["algorithm"] as? String == "original-bytes")
  precondition(ClientProtocols.hasValidHeader(["version":1],name,field:"version"))
  precondition(!ClientProtocols.hasValidHeader(["version":true],name,field:"version"))
  precondition(ClientProtocols.hasValidHeader(["contract":"client-protocol-test-kind","kind":"original-mode"],name))
  precondition(!ClientProtocols.hasValidHeader(["contract":"client-protocol-test-kind","kind":"other"],name))
  precondition(!ClientProtocols.hasValidHeader(["contract":"client-protocol-test-kind"],name))
  print("actual Swift historical/current schema reader passed")
 }
}
'''.replace('OLD_FP', old).replace('CURRENT_FP', current)
            swift = swift.replace('precondition(', 'check(').replace(' static func main() throws {', ' static func main() throws {\n  func check(_ result:Bool){precondition(result)}', 1)
            main.write_text(swift)
            binary = root / 'checks'
            result = subprocess.run(['xcrun', 'swiftc', '-parse-as-library',
                                     str(ROOT / 'apps/macos/Sources/ClientProtocols.swift'),
                                     str(source), str(main), '-o', str(binary)],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            run = subprocess.run([str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn('actual Swift', run.stdout)


if __name__ == '__main__':
    unittest.main()

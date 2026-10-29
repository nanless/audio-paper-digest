"""Offline tests of final-APK security resource binding; no SDK/build/network."""
import contextlib
import importlib.util
import io
import json
import pathlib
import shutil
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compiled_security_packaging', ROOT / 'Tests/ReleasePackaging.test.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
m = base.m

# Actual AAPT2 default-config schema and optimized paths observed read-only in an
# existing APK. Policy fixtures are independent of production SECURITY_XML.
TABLE = '''Package name=com.nanless.paperdigest id=7f
  type xml id=13 entryCount=8
    resource 0x7f130000 xml/backup_rules
      () (file) res/Qq.xml type=XML
    resource 0x7f130001 xml/data_extraction_rules
      () (file) res/4j.xml type=XML
    resource 0x7f130007 xml/network_security_config
      () (file) res/8G.xml type=XML
'''
REFS = {'networkSecurityConfig': '@ref/0x7f130007', 'fullBackupContent': '@ref/0x7f130000', 'dataExtractionRules': '@ref/0x7f130001'}
NET = '<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">localhost</domain><domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">::1</domain></domain-config></network-security-config>'
EXCLUDES = '<exclude domain="root" path="."/><exclude domain="file" path="."/><exclude domain="database" path="."/><exclude domain="sharedpref" path="."/><exclude domain="external" path="."/><exclude domain="device_root" path="."/><exclude domain="device_file" path="."/><exclude domain="device_database" path="."/><exclude domain="device_sharedpref" path="."/>'
BACKUP = '<full-backup-content>' + EXCLUDES + '</full-backup-content>'
EXTRACTION = '<data-extraction-rules><cloud-backup disableIfNoEncryptionCapabilities="true">' + EXCLUDES + '</cloud-backup><device-transfer>' + EXCLUDES + '</device-transfer></data-extraction-rules>'


class SecurityResources(unittest.TestCase):
    def setUp(self):
        self.helper = base.ReleaseTests('test_manifest_matches_expected_version_sdk_security')
        self.helper.setUp()
        self.addCleanup(self.helper.doCleanups)
        self.calls = []
        self.table = TABLE
        self.xml = {'/res/8G.xml': NET, '/res/Qq.xml': BACKUP, '/res/4j.xml': EXTRACTION}
        self.refs = dict(REFS)
        self.manifest = self.helper.xml(label='论文速递工作台', **REFS).replace('android:versionName="1.0.0" android:versionCode="1"', 'android:versionName="1.0.1" android:versionCode="4"')
        self.sdk = types.SimpleNamespace(call=self.call)

    def call(self, tool, *args):
        self.calls.append((tool, *args))
        if (tool, *args[:2]) == ('aapt2', 'dump', 'resources'):
            return self.table
        if (tool, *args[:2]) == ('apkanalyzer', 'manifest', 'print'):
            return self.manifest
        if (tool, *args[:2]) == ('apkanalyzer', 'resources', 'xml'):
            self.assertEqual('--file', args[2])
            return self.xml[args[3]]
        if tool == 'zipalign':
            return ''
        raise AssertionError('unexpected_synthetic_sdk_operation')

    def audit(self):
        return m.compiled_security_resources(self.helper.p / 'synthetic.apk', self.sdk, {'securityResourceRefs': self.refs})

    def reject(self, code, fn=None):
        with self.assertRaises(m.ReleaseError) as caught:
            (fn or self.audit)()
        self.assertEqual(code, str(caught.exception))

    def test_binds_all_three_actual_optimized_apk_members(self):
        result = self.audit()
        self.assertEqual('android-compiled-security-resources-v1', result['contract'])
        self.assertEqual(set(REFS), set(result['resources']))
        for key in REFS:
            self.assertEqual(REFS[key], result['resources'][key]['reference'])
            self.assertTrue(result['resources'][key]['policyVerified'])
        decoded = [c[4] for c in self.calls if c[:3] == ('apkanalyzer', 'resources', 'xml')]
        self.assertEqual({'/res/8G.xml', '/res/Qq.xml', '/res/4j.xml'}, set(decoded))

    def test_semantic_whitespace_and_child_order_do_not_change_policy(self):
        self.xml['/res/8G.xml'] = NET.replace('>localhost<', '>\n  localhost\n<')
        tree = m.ET.fromstring(BACKUP)
        tree[:] = list(reversed(list(tree)))
        self.xml['/res/Qq.xml'] = m.ET.tostring(tree, encoding='unicode')
        self.audit()

    def test_manifest_resource_rebinding_and_unresolved_refs_are_rejected(self):
        for value in (None, 'false', '@xml/network_security_config', '@ref/0x7f130000', '@ref/0x999'):
            self.refs['networkSecurityConfig'] = value
            self.reject('compiled_security_reference')

    def test_missing_duplicate_and_id_colliding_table_entries_are_rejected(self):
        for changed in (TABLE.replace('xml/backup_rules', 'xml/not_the_expected_resource'), TABLE + TABLE):
            self.table = changed
            self.reject('compiled_security_resource_missing_or_duplicate')
        self.table = TABLE.replace('0x7f130000 xml/backup_rules', '0x7f130007 xml/backup_rules')
        self.reject('compiled_security_reference')

    def test_no_alias_qualifier_or_additional_value_can_override_default_xml(self):
        for value in ('(v28) (file) res/Qq.xml type=XML',
                      '() @ref/0x123', '() (file) res/Qq.xml type=STRING',
                      '() (file) res/Qq.xml type=XML\n      (v31) (file) res/evil.xml type=XML',
                      '() (file) res/Qq.xml type=XML\n      () (file) res/Qq.xml type=XML'):
            self.table = TABLE.replace('() (file) res/Qq.xml type=XML', value)
            self.reject('compiled_security_config_override')

    def test_traversal_and_shared_members_are_rejected(self):
        for member in ('res/../outside.xml', 'res//Qq.xml', 'res/8G.xml'):
            self.table = TABLE.replace('res/Qq.xml', member)
            self.reject('compiled_security_resource_path')

    def test_network_rejects_cleartext_expansion_trust_and_unknown_schema(self):
        cases = [NET.replace('cleartextTrafficPermitted="false"', 'cleartextTrafficPermitted="true"'),
                 NET.replace('localhost', 'public.example.invalid'),
                 NET.replace('includeSubdomains="false"', 'includeSubdomains="true"'),
                 NET.replace('</domain-config>', '<domain includeSubdomains="false">extra.example.invalid</domain></domain-config>'),
                 NET.replace('</network-security-config>', '<debug-overrides><trust-anchors><certificates src="user"/></trust-anchors></debug-overrides></network-security-config>'),
                 NET.replace('<base-config cleartextTrafficPermitted="false"/>', '<base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="user"/></trust-anchors></base-config>'),
                 NET.replace('includeSubdomains="false"', 'includeSubdomains="false" unknown="true"'),
                 NET.replace('</domain-config>', '<domain-config cleartextTrafficPermitted="true"/></domain-config>'),
                 NET.replace('<base-config cleartextTrafficPermitted="false"/>', '')]
        for text in cases:
            with self.subTest(case=cases.index(text)):
                self.xml['/res/8G.xml'] = text
                self.reject('compiled_security_policy')

    def test_backup_rejects_include_missing_duplicate_and_changed_domains(self):
        for text in (BACKUP.replace('<exclude domain="file" path="."/>', ''),
                     BACKUP.replace('domain="file"', 'domain="external"'),
                     BACKUP.replace('path="."', 'path="only-some-data"', 1),
                     BACKUP.replace('</full-backup-content>', '<include domain="file" path="."/></full-backup-content>'),
                     BACKUP.replace('</full-backup-content>', '<exclude domain="file" path="."/></full-backup-content>')):
            self.xml['/res/Qq.xml'] = text
            self.reject('compiled_security_policy')

    def test_both_cloud_and_device_transfer_must_exclude_every_domain(self):
        for text in (EXTRACTION.replace('disableIfNoEncryptionCapabilities="true"', 'disableIfNoEncryptionCapabilities="false"'),
                     EXTRACTION.replace('<cloud-backup disableIfNoEncryptionCapabilities="true">', '<cloud-backup>'),
                     EXTRACTION.replace('<device-transfer>' + EXCLUDES + '</device-transfer>', '<device-transfer/>'),
                     EXTRACTION.replace('</device-transfer>', '<include domain="file" path="."/></device-transfer>'),
                     EXTRACTION.replace('<exclude domain="device_sharedpref" path="."/>', '', 1),
                     EXTRACTION.replace('</data-extraction-rules>', '<unknown/></data-extraction-rules>')):
            self.xml['/res/4j.xml'] = text
            self.reject('compiled_security_policy')

    def test_xml_errors_and_mixed_text_use_fixed_safe_codes(self):
        for text in ('<broken synthetic-secret-bait', '<!DOCTYPE x [<!ENTITY x "bait">]><x/>',
                     'x' * (128 * 1024 + 1)):
            self.xml['/res/8G.xml'] = text
            self.reject('compiled_security_xml_invalid')
        self.xml['/res/8G.xml'] = NET.replace('/><domain-config', '/>unexpected<domain-config')
        self.reject('compiled_security_xml_invalid')
        self.reject('manifest_xml_invalid', lambda: m.manifest_facts('<bad synthetic-secret-bait', '1.0.1', 4))

    def test_tool_errors_never_echo_stdout_stderr_or_exception_message(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        for stage in ('aapt2', 'apkanalyzer'):
            def fail(*args):
                if args[0] == stage:
                    raise RuntimeError('synthetic-secret-bait XML and stderr')
                return self.call(*args)
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                with patch.object(self.sdk, 'call', side_effect=fail):
                    self.reject('compiled_security_tool_failed')
        self.assertEqual('', stdout.getvalue() + stderr.getvalue())
        with patch.object(m.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1, stdout=b'synthetic-bait', stderr=b'synthetic-bait')):
            self.reject('safe_sdk_failure', lambda: m.run(['synthetic'], 'safe_sdk_failure'))

    def inspect(self, apk):
        # Only unrelated icon and Node assets are isolated; security gate is real.
        a, b = self.helper.inspect_patches()
        with a, b:
            return m.inspect(apk, base.REPO, self.sdk, '1.0.1', 4, self.helper.p / 'unused.json')

    def test_inspect_runs_compiled_gate_even_with_valid_source_files(self):
        apk, _ = self.helper.fake_inspect()
        result = self.inspect(apk)
        self.assertIn('compiledSecurityResources', result)
        self.assertEqual(REFS, result['manifest']['securityResourceRefs'])
        self.xml['/res/8G.xml'] = NET.replace('localhost', 'extra.example.invalid')
        self.reject('compiled_security_policy', lambda: self.inspect(apk))

    def test_verify_does_not_trust_valid_signed_sidecar_over_changed_compiled_xml(self):
        apk, _ = self.helper.fake_inspect()
        signed = self.inspect(apk)
        folder = self.helper.p / 'release'
        folder.mkdir()
        target = folder / 'paperdigest-android-1.0.1-4-universal.apk'
        shutil.copyfile(apk, target)
        m.write(folder / 'android-source-inputs.json', {'sourceCommit': '0' * 40, 'files': []})
        m.write(folder / 'android-runtime-materials.json', {'artifacts': []})
        payload = m.payload_inventory(target)
        info = {'contract': 'paperdigest-android-signed-v1', 'versionName': '1.0.1', 'versionCode': 4,
                'sourceCommit': '0' * 40, 'sourceInputsSHA256': m.file_sha(folder / 'android-source-inputs.json'),
                'runtimeMaterialsSHA256': m.file_sha(folder / 'android-runtime-materials.json'),
                'unsignedPayload': payload, 'unsignedPayloadInventorySHA256': m.sha(m.canonical(payload)), 'signed': signed}
        m.write(folder / 'android-build-info.json', info)
        assets = {p.name: {'bytes': p.stat().st_size, 'sha256': m.file_sha(p)} for p in folder.iterdir()}
        m.write(folder / 'android-release-manifest.json', {'contract': 'paperdigest-android-release-v1', 'assets': assets})
        (folder / 'ANDROID-SHA256SUMS').write_text(''.join(f"{item['sha256']}  {name}\n" for name, item in sorted(assets.items())))
        self.xml['/res/4j.xml'] = EXTRACTION.replace('<device-transfer>' + EXCLUDES, '<device-transfer>')
        with patch.object(m, 'check_source'):
            self.reject('compiled_security_policy', lambda: m.verify(folder, base.REPO, self.sdk, '0' * 64))

    def test_legacy_has_original_shape_and_does_not_decode_security_resources(self):
        apk, sdk = self.helper.fake_inspect()
        a, b = self.helper.inspect_patches()
        with a, b, patch.object(m, 'compiled_security_resources', side_effect=AssertionError('legacy gate must retain original behavior')):
            result = m.inspect(apk, base.REPO, sdk, '1.0.0', 1, self.helper.p / 'unused.json')
        self.assertNotIn('compiledSecurityResources', result)
        self.assertNotIn('securityResourceRefs', result['manifest'])


if __name__ == '__main__':
    unittest.main(verbosity=2)

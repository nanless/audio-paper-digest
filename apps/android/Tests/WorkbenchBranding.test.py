"""Offline branding checks; synthetic decoded manifests, no build/device/signing."""
import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
spec = importlib.util.spec_from_file_location('workbench_release', ROOT / 'release_tools.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def manifest(label=m.LABEL, activity_label=None, filter_label=None, version='1.0.1', code=4):
    permissions = ''.join(f'<uses-permission android:name="{p}"/>' for p in sorted(m.PERMISSIONS))
    def attr(value):
        return '' if value is None else f' android:label="{value}"'
    return (f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{m.APP}" '
            f'android:versionName="{version}" android:versionCode="{code}">{permissions}'
            '<uses-sdk android:minSdkVersion="28" android:targetSdkVersion="37"/>'
            f'<application android:name="{m.APP}.PaperDigestApplication" android:allowBackup="false" '
            f'android:usesCleartextTraffic="false"{attr(label)}>'
            f'<activity android:name="{m.APP}.MainActivity" android:exported="true"{attr(activity_label)}>'
            f'<intent-filter{attr(filter_label)}><action android:name="android.intent.action.MAIN"/>'
            '<category android:name="android.intent.category.LAUNCHER"/></intent-filter>'
            '</activity></application></manifest>')


class WorkbenchBranding(unittest.TestCase):
    def reject(self, error, fn):
        with self.assertRaises(m.ReleaseError) as caught:
            fn()
        self.assertEqual(error, str(caught.exception))

    def test_patch_records_actual_application_and_effective_launcher_label(self):
        facts = m.manifest_facts(manifest(), '1.0.1', 4)
        self.assertEqual('论文速递工作台', facts['applicationLabel'])
        self.assertEqual('论文速递工作台', facts['launcherLabel'])
        self.assertEqual(m.APP, facts['applicationId'])

    def test_old_missing_or_unresolved_application_labels_fail_new_patch(self):
        for label in ('论文速递', None, '@string/app_name', '@ref/0x7'):
            with self.subTest(label=label):
                self.reject('application_label', lambda: m.manifest_facts(manifest(label), '1.0.1', 4))

    def test_activity_and_intent_filter_overrides_cannot_hide_old_launcher_name(self):
        for kwargs in ({'activity_label': '论文速递'}, {'filter_label': '论文速递'},
                       {'activity_label': '@ref/0x7'}, {'filter_label': '@string/app_name'}):
            with self.subTest(kwargs=kwargs):
                self.reject('launcher_label', lambda: m.manifest_facts(manifest(**kwargs), '1.0.1', 4))
        self.assertEqual(m.LABEL, m.manifest_facts(manifest(activity_label=m.LABEL, filter_label=m.LABEL), '1.0.1', 4)['launcherLabel'])

    def test_legacy_receipt_shape_only_preserved_for_three_positive_codes(self):
        for code in (1, 2, 3):
            facts = m.manifest_facts(manifest(label=None, version='1.0.0', code=code), '1.0.0', code)
            self.assertNotIn('applicationLabel', facts)
            self.assertNotIn('launcherLabel', facts)
        for version, code in (('1.0.0', -1), ('1.0.0', 0), ('1.0.0', 4), ('1.0.2', 1)):
            self.reject('application_label', lambda: m.manifest_facts(manifest(label=None, version=version, code=code), version, code))

    def test_inspect_checks_decoded_candidate_apk_not_only_source_manifest(self):
        # Current source has the new label, but the independent candidate APK's
        # analyzer output has the old label. Fail before any further APK work.
        self.assertEqual(m.LABEL, m.ET.parse(ROOT / 'app/src/main/AndroidManifest.xml').find('application').get(m.ANDROID + 'label'))
        calls = []
        def call(*args):
            calls.append(args)
            self.assertEqual(('apkanalyzer', 'manifest', 'print'), args[:3])
            return manifest(label='论文速递')
        with tempfile.TemporaryDirectory() as temporary:
            apk = pathlib.Path(temporary).resolve() / 'candidate.apk'
            apk.write_bytes(b'SYNTHETIC_NOT_AN_APK')
            self.reject('application_label', lambda: m.inspect(apk, REPO, types.SimpleNamespace(call=call), '1.0.1', 4, pathlib.Path(temporary) / 'unused.json'))
        self.assertEqual(1, len(calls))

    def test_verify_rechecks_final_apk_label_instead_of_trusting_signed_sidecar(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = pathlib.Path(temporary).resolve()
            apk = folder / 'paperdigest-android-1.0.1-4-universal.apk'
            import zipfile
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('classes.dex', b'SYNTHETIC_PUBLIC_FIXTURE')
            m.write(folder / 'android-source-inputs.json', {'sourceCommit': '0' * 40, 'files': []})
            m.write(folder / 'android-runtime-materials.json', {'artifacts': []})
            payload = m.payload_inventory(apk)
            info = {'contract': 'paperdigest-android-signed-v1', 'versionName': '1.0.1', 'versionCode': 4,
                    'sourceCommit': '0' * 40, 'sourceInputsSHA256': m.file_sha(folder / 'android-source-inputs.json'),
                    'runtimeMaterialsSHA256': m.file_sha(folder / 'android-runtime-materials.json'),
                    'unsignedPayload': payload, 'unsignedPayloadInventorySHA256': m.sha(m.canonical(payload)),
                    'signed': {'manifest': {'applicationLabel': m.LABEL, 'launcherLabel': m.LABEL}}}
            m.write(folder / 'android-build-info.json', info)
            assets = {p.name: {'bytes': p.stat().st_size, 'sha256': m.file_sha(p)} for p in folder.iterdir()}
            m.write(folder / 'android-release-manifest.json', {'contract': 'paperdigest-android-release-v1', 'assets': assets})
            (folder / 'ANDROID-SHA256SUMS').write_text(''.join(f"{item['sha256']}  {name}\n" for name, item in sorted(assets.items())))
            sdk = types.SimpleNamespace(call=lambda *args: manifest(label='论文速递'))
            with patch.object(m, 'check_source'):
                self.reject('application_label', lambda: m.verify(folder, REPO, sdk, '0' * 64))

    def test_source_identity_version_and_provider_authorities_are_unchanged(self):
        config = (ROOT / 'app/build.gradle.kts').read_text()
        self.assertIn('versionCode = 4; versionName = "1.0.1"', config)
        self.assertIn('applicationId = "com.nanless.paperdigest"', config)
        self.assertIn('namespace = "com.nanless.paperdigest"', config)
        app = m.ET.parse(ROOT / 'app/src/main/AndroidManifest.xml').find('application')
        self.assertEqual({'${applicationId}.files', '${applicationId}.pdf-originals'},
                         {p.get(m.ANDROID + 'authorities') for p in app.findall('provider')})


if __name__ == '__main__':
    unittest.main()

"""Offline branding regression checks; never builds/signs/starts an app."""
import copy
import os
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
from build_resources import check_licenses
from refresh_licenses import refresh
from release_tools import Rejected, check_app_branding


class Branding(unittest.TestCase):
    def test_current_plist_identity_and_version(self):
        info = plistlib.loads((APP / 'Info.plist').read_bytes())
        check_app_branding(info, '论文速递工作台.app')
        self.assertEqual(info['CFBundleIdentifier'], 'com.nanless.PaperDigest')
        self.assertEqual(info['CFBundleExecutable'], 'PaperDigest')
        self.assertEqual(info['CFBundleShortVersionString'], '1.0.1')
        self.assertEqual(info['CFBundleVersion'], '1')

    def test_actual_plist_missing_or_old_branding_is_rejected(self):
        original = plistlib.loads((APP / 'Info.plist').read_bytes())
        for key in ['CFBundleName', 'CFBundleDisplayName']:
            for value in [None, '论文速递']:
                info = copy.deepcopy(original)
                if value is None:
                    del info[key]
                else:
                    info[key] = value
                # Roundtrip actual plist bytes rather than substituting source text.
                with self.assertRaises(Rejected):
                    check_app_branding(plistlib.loads(plistlib.dumps(info)), '论文速递工作台.app')
        with self.assertRaises(Rejected):
            check_app_branding(original, '论文速递.app')

    def test_exact_shipped_plist_requires_all_original_branding(self):
        info = plistlib.loads((APP / 'Info.plist').read_bytes())
        info.update(CFBundleShortVersionString='1.0.0', CFBundleVersion='1',
                    CFBundleName='论文速递', CFBundleDisplayName='论文速递')
        check_app_branding(plistlib.loads(plistlib.dumps(info)), '论文速递.app')
        for field in ['CFBundleName', 'CFBundleDisplayName']:
            for wrong in [None, '论文速递工作台', 'unknown']:
                changed = copy.deepcopy(info)
                if wrong is None:
                    del changed[field]
                else:
                    changed[field] = wrong
                with self.assertRaises(Rejected):
                    check_app_branding(plistlib.loads(plistlib.dumps(changed)), '论文速递.app')
        for filename in ['论文速递工作台.app', 'unknown.app']:
            with self.assertRaises(Rejected):
                check_app_branding(info, filename)
        info.update(CFBundleName='论文速递工作台', CFBundleDisplayName='论文速递工作台')
        with self.assertRaises(Rejected):
            check_app_branding(info, '论文速递工作台.app')

    def test_nonlegacy_versions_and_unknown_pairs_require_new_branding(self):
        original = plistlib.loads((APP / 'Info.plist').read_bytes())
        pairs = [('1.0.1', '1'), ('1.0.2', '2'), ('2.0.0', '1'),
                 ('1.0.0', '2'), ('1.0.0', '1.0'), ('1.0.0', 1),
                 ('1.0.0 ', '1'), ('01.0.0', '1'), ('0.9.0', '1'),
                 ('unknown', '1'), (None, '1'), ('1.0.0', None)]
        for version, build in pairs:
            with self.subTest(version=version, build=build):
                info = copy.deepcopy(original)
                info.update(CFBundleShortVersionString=version, CFBundleVersion=build)
                # Branding selection is strict even for unknown pairs; audit_app
                # separately retains its existing version/build validity checks.
                check_app_branding(info, '论文速递工作台.app')
                info.update(CFBundleName='论文速递', CFBundleDisplayName='论文速递')
                with self.assertRaises(Rejected):
                    check_app_branding(info, '论文速递.app')

    def test_legacy_assertions_cannot_override_actual_new_plist(self):
        info = plistlib.loads((APP / 'Info.plist').read_bytes())
        info.update(legacy=True, distributionChannel='legacy-private-qa',
                    version='1.0.0', bundleVersion='1',
                    CFBundleName='论文速递', CFBundleDisplayName='论文速递')
        with self.assertRaises(Rejected):
            check_app_branding(info, '论文速递.app')

    def test_notice_generator_is_idempotent_and_preserves_license_contract(self):
        with tempfile.TemporaryDirectory(prefix='paperdigest-branding-') as directory:
            app = Path(directory)
            shutil.copy2(APP / 'Info.plist', app / 'Info.plist')
            web = app / 'Resources'
            web.mkdir()
            shutil.copytree(APP / 'Resources/licenses', web / 'licenses')
            shutil.copy2(APP / 'Resources/third-party-notices.html', web / 'third-party-notices.html')
            before = check_licenses(web)
            originals = {row['path']: (web / 'licenses' / row['path']).read_bytes() for row in before['components']}
            refresh(app)
            after = check_licenses(web)
            expected = copy.deepcopy(before)
            own = next(row for row in expected['components'] if row['id'] == 'paper-digest')
            own.update(title='论文速递工作台', version='1.0.1')
            self.assertEqual(after, expected)
            for path, raw in originals.items():
                self.assertEqual((web / 'licenses' / path).read_bytes(), raw)
            snapshot = [(web / name).read_bytes() for name in ['licenses/manifest.json', 'third-party-notices.html']]
            refresh(app)
            self.assertEqual(snapshot, [(web / name).read_bytes() for name in ['licenses/manifest.json', 'third-party-notices.html']])

    def test_changed_license_is_not_silently_rehashed(self):
        with tempfile.TemporaryDirectory(prefix='paperdigest-branding-') as directory:
            app = Path(directory)
            shutil.copy2(APP / 'Info.plist', app / 'Info.plist')
            web = app / 'Resources'
            web.mkdir()
            shutil.copytree(APP / 'Resources/licenses', web / 'licenses')
            shutil.copy2(APP / 'Resources/third-party-notices.html', web / 'third-party-notices.html')
            manifest = (web / 'licenses/manifest.json').read_bytes()
            (web / 'licenses/PaperDigest-MIT.txt').write_bytes(b'Explicit altered license fixture')
            with self.assertRaises(ValueError):
                refresh(app)
            self.assertEqual(manifest, (web / 'licenses/manifest.json').read_bytes())


if __name__ == '__main__':
    if os.environ.get('CODEX_SANDBOX'):
        raise RuntimeError('请在本机正常开发环境执行测试')
    unittest.main()

"""Isolated tests for local build replacement and installation rollback."""
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import finalize_build as build


class FinalizeBuild(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.history = self.root / 'history'

    def candidate(self, name):
        work = self.root / name
        bundle = work / build.APP_NAME
        bundle.mkdir(parents=True)
        (bundle / 'version').write_text(name)
        return work

    def test_concurrent_build_waits_until_first_bundle_and_receipt_finish(self):
        first, second = self.candidate('first'), self.candidate('second')
        target = self.root / build.APP_NAME
        entered, release, started = threading.Event(), threading.Event(), threading.Event()
        recorded = []

        def write_history(bundle, _):
            name = (bundle / 'version').read_text()
            if name == 'first':
                entered.set()
                self.assertTrue(release.wait(5))
                self.assertEqual('first', (bundle / 'version').read_text())
            recorded.append(name)

        def run_second():
            started.set()
            build.finalize(second, self.history)

        with patch.object(build, 'require_closed'), patch.object(build, 'write_history', side_effect=write_history):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first_job = pool.submit(build.finalize, first, self.history)
                try:
                    self.assertTrue(entered.wait(5))
                    second_job = pool.submit(run_second)
                    self.assertTrue(started.wait(5))
                    self.assertEqual('first', (target / 'version').read_text())
                    self.assertTrue((second / build.APP_NAME).exists())
                    with (self.root / '.paperdigest-build.lock').open('r+b') as probe:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    release.set()
                first_job.result(timeout=5)
                second_job.result(timeout=5)
        self.assertEqual(['first', 'second'], recorded)
        self.assertEqual(['version'], sorted(path.name for path in target.iterdir()))
        self.assertEqual('second', (target / 'version').read_text())

    def test_failed_validation_restores_previous_bundle_and_candidate(self):
        old = self.candidate('old') / build.APP_NAME
        current = self.candidate('new') / build.APP_NAME
        previous = current.parent / 'previous.app'

        def registration_fails(_):
            raise subprocess.CalledProcessError(1, [build.REGISTER])

        with self.assertRaises(subprocess.CalledProcessError):
            build.replace_bundle(current, old, previous, registration_fails)
        self.assertEqual('old', (old / 'version').read_text())
        self.assertEqual('new', (current / 'version').read_text())
        self.assertFalse(previous.exists())

    def test_direct_helper_cannot_install_private_qa(self):
        work = self.candidate('private-qa')
        metadata = work / build.APP_NAME / 'Contents/Resources/build-metadata.json'
        metadata.parent.mkdir(parents=True)
        metadata.write_text(json.dumps({'distributionChannel': 'private-qa'}))
        applications = self.root / 'Applications'
        result = subprocess.run([sys.executable, build.__file__, work, self.history, '--applications', applications],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(1, result.returncode)
        self.assertIn('只允许安装正式通道', result.stderr)
        self.assertFalse(applications.exists())
        self.assertTrue(metadata.is_file())

    def test_private_qa_install_rejected_before_build(self):
        script = Path(build.__file__).with_name('build.sh')
        result = subprocess.run(['/bin/bash', script, '--install', '--channel', 'private-qa'],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(2, result.returncode)
        self.assertIn('--install 只安装正式通道', result.stderr)


if __name__ == '__main__':
    unittest.main()

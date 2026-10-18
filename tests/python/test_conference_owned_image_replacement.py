"""Controlled byte replacement only; no real paper qualification is asserted."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('owned_image_publisher', ROOT / 'scripts/publish-conference.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
sha = lambda data: hashlib.sha256(data).hexdigest()


class ControlledGenerationImageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='owned-generation-image-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.images = self.root / 'images'; self.images.mkdir()
        self.archive = self.root / 'publication'; self.archive.mkdir()
        self.relative = 'test-2026/aaaaaaaaaaaa/figure-1.png'
        self.target = self.images / self.relative
        self.target.parent.mkdir(parents=True)
        self.old = b'synthetic old image byte fixture'
        self.new = b'synthetic new image byte fixture with different size'
        self.target.write_bytes(self.old); self.target.chmod(0o644)
        self.source = self.root / 'new-stage.png'; self.source.write_bytes(self.new)
        self.record = {'path': self.relative, 'kind': 'asset', 'paperId': 'conference:test:2026:paper-id:one',
                       'sourcePath': str(self.source), 'sourceSha256': sha(self.new), 'size': len(self.new)}
        self.previous = {**self.record, 'sourceSha256': sha(self.old), 'size': len(self.old)}
        self.generation_sha = 'a' * 64
        self.backup = self.archive / 'image-byte-history' / self.generation_sha / (sha(self.old) + '.png')
        self.unrelated = self.images / 'unrelated.png'; self.unrelated.write_bytes(b'preserve unrelated work')

    def apply(self, **overrides):
        options = {'previous_record': self.previous, 'previous_generation_sha': self.generation_sha,
                   'archive_root': self.archive, **overrides}
        return publisher.write_generation_image(self.images, self.record, **options)

    def test_replace_archives_exact_original_and_same_new_bytes_are_idempotent(self):
        self.assertTrue(self.apply())
        self.assertEqual(self.target.read_bytes(), self.new)
        self.assertEqual(self.backup.read_bytes(), self.old)
        backup_stat = self.backup.stat()
        self.assertFalse(self.apply())
        self.assertEqual(self.backup.stat().st_ino, backup_stat.st_ino)
        self.assertEqual(self.unrelated.read_bytes(), b'preserve unrelated work')
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o644)

    def test_crash_after_backup_retains_old_target_then_resumes_exact_same_backup(self):
        with mock.patch.object(publisher, 'replace_exact', side_effect=RuntimeError('stop after backup')):
            with self.assertRaisesRegex(RuntimeError, 'stop after backup'):
                self.apply()
        self.assertEqual(self.backup.read_bytes(), self.old)
        self.assertEqual(self.target.read_bytes(), self.old)
        backup_bytes = self.backup.read_bytes()
        self.assertTrue(self.apply())
        self.assertEqual(self.target.read_bytes(), self.new)
        self.assertEqual(self.backup.read_bytes(), backup_bytes)
        self.assertFalse(self.apply())

    def test_unknown_owner_kind_path_or_original_sha_cannot_overwrite(self):
        for change in ({'paperId': 'other-paper'}, {'kind': 'paper'}, {'path': 'test-2026/bbbbbbbbbbbb/figure-1.png'},
                       {'sourceSha256': '0' * 64}, {'size': 999}):
            with self.subTest(change=change), self.assertRaises(publisher.ConferencePublicationError):
                self.apply(previous_record={**self.previous, **change})
            self.assertEqual(self.target.read_bytes(), self.old)
            self.assertFalse(self.backup.exists())
        with self.assertRaises(publisher.ConferencePublicationError):
            self.apply(previous_record=None)
        self.assertEqual(self.target.read_bytes(), self.old)

    def test_target_or_stage_manual_changes_and_corrupt_backup_stay_rejected(self):
        self.target.write_bytes(b'manual target edit')
        with self.assertRaises(publisher.ConferencePublicationError): self.apply()
        self.assertEqual(self.target.read_bytes(), b'manual target edit')
        self.target.write_bytes(self.old); self.source.write_bytes(b'stage changed')
        with self.assertRaises(publisher.ConferencePublicationError): self.apply()
        self.assertEqual(self.target.read_bytes(), self.old)
        self.source.write_bytes(self.new)
        self.backup.parent.mkdir(parents=True); self.backup.write_bytes(b'different preserved bytes')
        with self.assertRaises(publisher.ConferencePublicationError): self.apply()
        self.assertEqual(self.target.read_bytes(), self.old)
        self.assertEqual(self.backup.read_bytes(), b'different preserved bytes')

    def test_cas_rechecks_after_temp_fsync_and_preserves_concurrent_manual_bytes(self):
        actual_fsync = publisher.os.fsync
        def drift(fd):
            actual_fsync(fd)
            if os.fstat(fd).st_size == len(self.new): self.target.write_bytes(b'concurrent manual edit')
        with mock.patch.object(publisher.os, 'fsync', side_effect=drift):
            with self.assertRaisesRegex(publisher.ConferencePublicationError, '原子替换目标身份或原SHA漂移'):
                self.apply()
        self.assertEqual(self.target.read_bytes(), b'concurrent manual edit')
        self.assertEqual(self.backup.read_bytes(), self.old)
        self.assertEqual(list(self.target.parent.glob('.*.conference.tmp')), [])


if __name__ == '__main__':
    unittest.main()

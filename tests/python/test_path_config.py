import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import json
import shutil
import socket

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from path_config import (  # noqa: E402
    CURRENT_DIR,
    ARCHIVE_DIR,
    DIGEST_COVER_ASSET_DIR,
    DIGEST_COVER_MANIFEST_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    FILTER_DECISIONS_FILE,
    PAPERS_FILE,
    PROJECT_ROOT,
    VISUAL_SUMMARY_ASSET_DIR,
    VISUAL_SUMMARY_MANIFEST_DIR,
    atomic_write_json,
    atomic_write_text,
    backfill_result_path,
    file_lock,
    resolve_deep_analysis_result_for_date,
    resolve_deep_analysis_result_path,
    update_json_file_locked,
    wechat_preview_path,
    xiaohongshu_markdown_path,
    xiaohongshu_oneliner_cache_path,
    validate_date_component,
    _lock_reclaimable,
)


class PathConfigTest(unittest.TestCase):
    def test_xiaohongshu_paths_reject_invalid_or_escaping_date(self):
        for value in ['2026-02-30', '../2026-07-08', '/../../escape', '20260708']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_date_component(value)
            with self.subTest(path=value), self.assertRaises(ValueError):
                xiaohongshu_oneliner_cache_path(value)

    def test_runtime_json_paths_match_expected_names(self):
        self.assertEqual(str(PROJECT_ROOT), os.path.abspath(ROOT))
        self.assertEqual(PAPERS_FILE.name, 'papers.json')
        self.assertEqual(FILTER_DECISIONS_FILE.name, 'filter-decisions.json')
        self.assertEqual(DEEP_ANALYSIS_RESULT_FILE.name, 'deep-analysis-result.json')
        self.assertEqual(PAPERS_FILE.parent, CURRENT_DIR)
        self.assertEqual(DEEP_ANALYSIS_RESULT_FILE.parent, CURRENT_DIR)
        self.assertEqual(VISUAL_SUMMARY_MANIFEST_DIR, CURRENT_DIR / 'visual-summary-manifests')
        self.assertEqual(VISUAL_SUMMARY_ASSET_DIR, ARCHIVE_DIR)
        self.assertEqual(DIGEST_COVER_MANIFEST_DIR, CURRENT_DIR / 'digest-cover-manifests')
        self.assertEqual(DIGEST_COVER_ASSET_DIR, ARCHIVE_DIR)

    def test_publish_output_helpers(self):
        self.assertEqual(
            xiaohongshu_markdown_path('2026-07-08', 'top5'),
            CURRENT_DIR / 'xiaohongshu-2026-07-08-top5.md'
        )
        self.assertEqual(
            xiaohongshu_oneliner_cache_path('2026-07-08'),
            CURRENT_DIR / 'xiaohongshu-oneliners-2026-07-08.json'
        )
        self.assertEqual(
            wechat_preview_path('2026-07-08'),
            CURRENT_DIR / 'wechat-preview-2026-07-08.html'
        )
        self.assertEqual(backfill_result_path().name, 'backfill-result.json')

    def test_resolve_deep_analysis_result_prefers_current_then_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current.json'
            legacy = Path(tmp) / 'legacy.json'

            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), current)

            legacy.write_text('[]', encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), legacy)

            current.write_text('[]', encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_path(current, legacy), current)

    def test_resolve_publish_input_uses_controlled_archive_after_current_rolls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current.json'
            legacy = root / 'legacy.json'
            archive = root / 'archive'
            archived = archive / '2026-07-13' / 'deep-analysis-result.json'
            current.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00002', 'fetchBatchDate': '2026-07-14',
            }]}), encoding='utf-8')
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({'papers': [{
                'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-13',
            }]}), encoding='utf-8')
            self.assertEqual(resolve_deep_analysis_result_for_date(
                '2026-07-13', current, legacy, archive,
            ), archived)
            self.assertEqual(resolve_deep_analysis_result_for_date(
                '2026-07-14', current, legacy, archive,
            ), current)

    def test_atomic_write_replaces_content_and_preserves_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'config.env'
            target.write_text('OLD=1\n', encoding='utf-8')
            target.chmod(0o640)
            atomic_write_text(target, 'NEW=2\n')
            self.assertEqual(target.read_text(encoding='utf-8'), 'NEW=2\n')
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            self.assertEqual(list(Path(tmp).glob('.config.env.*.tmp')), [])

    def test_atomic_write_failure_keeps_original_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'result.json'
            target.write_text('{"old": true}\n', encoding='utf-8')
            with mock.patch('path_config.os.replace', side_effect=OSError('replace failed')):
                with self.assertRaises(OSError):
                    atomic_write_json(target, {'new': True})
            self.assertEqual(target.read_text(encoding='utf-8'), '{"old": true}\n')
            self.assertEqual(list(Path(tmp).glob('.result.json.*.tmp')), [])

    def test_locked_update_increments_generation_and_blocks_corrupt_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'papers.json'
            atomic_write_json(target, {'generation': 3, 'papers': {'a': {}}})
            updated = update_json_file_locked(
                target,
                lambda current: {**current, 'papers': {**current['papers'], 'b': {}}},
                allow_missing=False,
            )
            self.assertEqual(updated['generation'], 4)
            self.assertEqual(set(updated['papers']), {'a', 'b'})
            self.assertFalse(Path(f'{target}.lock').exists())

            target.write_text('{broken', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                update_json_file_locked(target, lambda _current: {'papers': {}}, allow_missing=False)
            self.assertEqual(target.read_text(encoding='utf-8'), '{broken')

    def test_locked_update_rejects_stale_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'papers.json'
            atomic_write_json(target, {'generation': 4, 'papers': {}})
            with self.assertRaisesRegex(RuntimeError, 'generation 冲突'):
                update_json_file_locked(
                    target,
                    lambda current: {**current, 'papers': {'stale': {}}},
                    expected_generation=3,
                )
            self.assertEqual(read_json_strict_for_test(target)['generation'], 4)

    def test_old_lock_owner_cannot_release_replacement_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'result.json'
            context = file_lock(target)
            context.__enter__()
            lock_path = Path(f'{target}.lock')
            shutil.rmtree(lock_path)
            lock_path.mkdir()
            (lock_path / 'owner.json').write_text(json.dumps({
                'pid': os.getpid(),
                'hostname': socket.gethostname(),
                'token': 'replacement-owner',
            }), encoding='utf-8')
            context.__exit__(None, None, None)
            self.assertTrue(lock_path.exists())
            shutil.rmtree(lock_path)

    def test_stale_remote_lock_is_reclaimed(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'remote.json'
            lock_path = Path(f'{target}.lock')
            lock_path.mkdir()
            owner = lock_path / 'owner.json'
            owner.write_text(json.dumps({
                'pid': 12345, 'hostname': 'remote-host', 'token': 'abandoned',
            }), encoding='utf-8')
            old = __import__('time').time() - 10
            os.utime(owner, (old, old))
            os.utime(lock_path, (old, old))
            with file_lock(target, timeout_seconds=1, stale_seconds=0.1):
                current = json.loads((lock_path / 'owner.json').read_text(encoding='utf-8'))
                self.assertNotEqual(current['token'], 'abandoned')
            self.assertFalse(lock_path.exists())

    def test_heartbeat_keeps_remote_lease_fresh(self):
        import time
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'active.json'
            with mock.patch('path_config.socket.gethostname', return_value='owner-host'):
                with file_lock(target, timeout_seconds=1, stale_seconds=0.15):
                    lock_path = Path(f'{target}.lock')
                    first = json.loads((lock_path / 'owner.json').read_text(encoding='utf-8'))
                    time.sleep(0.35)
                    second = json.loads((lock_path / 'owner.json').read_text(encoding='utf-8'))
                    self.assertNotEqual(first['heartbeatAt'], second['heartbeatAt'])
                    with mock.patch('path_config.socket.gethostname', return_value='observer-host'):
                        self.assertFalse(_lock_reclaimable(lock_path, 0.15))


def read_json_strict_for_test(path):
    with Path(path).open('r', encoding='utf-8') as handle:
        return json.load(handle)


if __name__ == '__main__':
    unittest.main()

import importlib.util
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load_script_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


xhs_publisher = load_script_module('xiaohongshu_publisher_test', 'xiaohongshu-publisher.py')
backfill_papers = load_script_module('backfill_papers_test', 'backfill_papers.py')


class AtomicPublishWritesTest(unittest.TestCase):
    def test_cookie_env_update_preserves_other_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / '.env'
            env_file.write_text(
                '# project config\n'
                'PAPER_ANALYZER_API_KEY="secret"\n'
                'XIAOHONGSHU_COOKIES="old"\n'
                'PD_CONCURRENCY=8\n',
                encoding='utf-8',
            )
            with mock.patch.object(xhs_publisher, 'ENV_FILE', env_file):
                xhs_publisher._update_env_key('XIAOHONGSHU_COOKIES', 'new-cookie')
            content = env_file.read_text(encoding='utf-8')
            self.assertIn('PAPER_ANALYZER_API_KEY="secret"', content)
            self.assertIn('PD_CONCURRENCY=8', content)
            self.assertIn('XIAOHONGSHU_COOKIES="new-cookie"', content)
            self.assertNotIn('XIAOHONGSHU_COOKIES="old"', content)
            self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(tmp).glob('..env.*.tmp')), [])

    def test_cookie_env_update_rejects_injection(self):
        with self.assertRaises(ValueError):
            xhs_publisher._update_env_key('BAD-NAME', 'value')
        with self.assertRaises(ValueError):
            xhs_publisher._update_env_key('VALID_NAME', 'value\nINJECTED=1')
        with self.assertRaises(ValueError):
            xhs_publisher._update_env_key('VALID_NAME', 'value"broken')

    def test_custom_text_mode_initializes_date_before_image_lookup(self):
        async def fake_publish(*_args, **_kwargs):
            return True

        with mock.patch.object(sys, 'argv', ['xiaohongshu-publisher.py', '--text', '自定义文案']), \
                mock.patch.object(xhs_publisher, 'today_bj', return_value='2026-07-13'), \
                mock.patch.object(xhs_publisher, 'find_screenshot_images', return_value=[]) as find_images, \
                mock.patch.object(xhs_publisher, 'publish_note', side_effect=fake_publish), \
                self.assertRaises(SystemExit) as raised:
            xhs_publisher.main()

        self.assertEqual(raised.exception.code, 0)
        find_images.assert_called_once_with('2026-07-13')

    def test_publish_rejects_oversized_body_without_starting_browser(self):
        with mock.patch.object(xhs_publisher, 'async_playwright') as playwright:
            result = asyncio.run(xhs_publisher.publish_note('标题', '长' * 1001))
        self.assertFalse(result)
        playwright.assert_not_called()

    def test_backfill_outputs_use_shared_atomic_json_writer(self):
        with tempfile.TemporaryDirectory() as tmp:
            papers_file = Path(tmp) / 'papers.json'
            result_file = Path(tmp) / 'backfill-result.json'
            data = {'papers': {'2607.00001': {'title': 'Paper'}}}
            with mock.patch.object(backfill_papers, 'PAPERS_FILE', papers_file):
                backfill_papers.save_papers(data)
            saved = json.loads(papers_file.read_text(encoding='utf-8'))
            self.assertIn('lastUpdated', saved)
            self.assertIn('2607.00001', saved['papers'])

            target = backfill_papers.save_backfill_result({'added': 1}, result_file)
            self.assertEqual(target, result_file)
            self.assertEqual(
                json.loads(result_file.read_text(encoding='utf-8')),
                {'added': 1},
            )

    def test_backfill_merge_preserves_records_added_after_initial_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            papers_file = Path(tmp) / 'papers.json'
            papers_file.write_text(json.dumps({
                'generation': 7,
                'papers': {'concurrent': {'title': 'Concurrent'}},
            }), encoding='utf-8')
            with mock.patch.object(backfill_papers, 'PAPERS_FILE', papers_file):
                saved, counts = backfill_papers.merge_and_save_papers({
                    'new': {'title': 'New'},
                    'concurrent': {'title': 'Must not overwrite'},
                })
            self.assertEqual(saved['generation'], 8)
            self.assertEqual(saved['papers']['concurrent']['title'], 'Concurrent')
            self.assertIn('new', saved['papers'])
            self.assertEqual(counts, {'added': 1, 'skipped': 1})


if __name__ == '__main__':
    unittest.main()

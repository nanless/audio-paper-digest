import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope

with project_env_scope():
    spec = importlib.util.spec_from_file_location('backfill_failures', ROOT / 'scripts/backfill_papers.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


def response(*, content=b'', payload=None, status=200):
    value = mock.Mock(status_code=status, content=content)
    value.json.return_value = payload
    return value


class BackfillFailureTests(unittest.TestCase):
    def setUp(self):
        for patch in [mock.patch.object(module, 'fetch_proxies', return_value={}),
                      mock.patch.object(module.time, 'sleep'), mock.patch.object(module, 'log')]:
            patch.start()
            self.addCleanup(patch.stop)

    def test_arxiv_timeout_and_rate_limit_are_failures_after_bounded_attempts(self):
        for result in [module.requests.exceptions.Timeout('读取超时'), response(status=429)]:
            with self.subTest(result=result), mock.patch.object(module.requests, 'get') as get:
                if isinstance(result, Exception):
                    get.side_effect = result
                else:
                    get.return_value = result
                with self.assertRaisesRegex(RuntimeError, '抓取失败') as caught:
                    module.fetch_arxiv_category('eess.AS')
                self.assertIsNotNone(caught.exception.__cause__)
                self.assertEqual(get.call_count, 5)

    def test_arxiv_invalid_xml_or_unexpected_document_is_not_an_empty_feed(self):
        for content in [b'<feed', b'<html>upstream unavailable</html>']:
            with self.subTest(content=content), mock.patch.object(module.requests, 'get',
                    return_value=response(content=content)):
                with self.assertRaisesRegex(RuntimeError, 'XML'):
                    module.fetch_arxiv_category('eess.AS')

    def test_empty_atom_feed_is_a_valid_success(self):
        with mock.patch.object(module.requests, 'get', return_value=response(
                content=b'<feed xmlns="http://www.w3.org/2005/Atom"/>')):
            self.assertEqual(module.fetch_arxiv_category('eess.AS'), [])

    def test_atom_error_entry_or_missing_id_is_not_a_paper(self):
        for entry in ['<entry><id>http://arxiv.org/api/errors#incorrect_id_format</id></entry>',
                      '<entry><id/></entry>', '<entry/>']:
            content = f'<feed xmlns="http://www.w3.org/2005/Atom">{entry}</feed>'.encode()
            with self.subTest(entry=entry), mock.patch.object(module.requests, 'get',
                    return_value=response(content=content)):
                with self.assertRaisesRegex(RuntimeError, '错误记录|缺少论文 ID'):
                    module.fetch_arxiv_category('eess.AS')

    def test_missing_proxy_fails_before_network_or_sleep(self):
        with mock.patch.object(module, 'fetch_proxies', side_effect=RuntimeError('缺少项目代理')), \
                mock.patch.object(module.requests, 'get') as get:
            with self.assertRaisesRegex(RuntimeError, '缺少项目代理'):
                module.fetch_arxiv_category('eess.AS')
            get.assert_not_called()
            module.time.sleep.assert_not_called()

    def test_hf_daily_failure_does_not_fall_back_and_claim_success(self):
        for effect in [module.requests.exceptions.Timeout('读取超时'), response(payload={'error': 'bad'})]:
            with self.subTest(effect=effect), mock.patch.object(module.requests, 'get') as get:
                if isinstance(effect, Exception):
                    get.side_effect = effect
                else:
                    get.return_value = effect
                with self.assertRaisesRegex(RuntimeError, 'daily_papers'):
                    module.fetch_hf_papers(set())
                self.assertEqual(get.call_count, 1)

    def test_hf_secondary_failure_is_reported(self):
        for effect in [module.requests.exceptions.Timeout('读取超时'), response(payload={'error': 'bad'})]:
            with self.subTest(effect=effect), mock.patch.object(module.requests, 'get',
                    side_effect=[response(payload=[]), effect]):
                with self.assertRaisesRegex(RuntimeError, 'HuggingFace papers 抓取失败'):
                    module.fetch_hf_papers(set())

    def test_empty_hf_lists_are_a_valid_success(self):
        with mock.patch.object(module.requests, 'get', side_effect=[response(payload=[]), response(payload=[])]):
            self.assertEqual(module.fetch_hf_papers(set()), [])

    def test_main_does_not_write_a_success_report_after_source_failure(self):
        with mock.patch.object(module, 'load_papers', return_value={'papers': {}}), \
                mock.patch.object(module.requests, 'get', side_effect=module.requests.exceptions.Timeout('读取超时')), \
                mock.patch.object(module, 'merge_and_save_papers') as save, \
                mock.patch.object(module, 'save_backfill_result') as report:
            with self.assertRaisesRegex(RuntimeError, '抓取失败'):
                module.main()
            save.assert_not_called()
            report.assert_not_called()

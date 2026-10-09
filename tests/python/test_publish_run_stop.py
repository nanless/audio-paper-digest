import contextvars
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with project_env_scope():
    import publish_common as common
    from blog_entry_loader import load_publish_to_blog
    blog = load_publish_to_blog()
    conference = load('conference_run_stop', 'publish-conference.py')
    xhs = load('xhs_run_stop', 'publish-xiaohongshu.py')


class RunStopTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.enterContext(redirect_stdout(self.output))

    def test_bounded_preserves_context_settles_started_and_keeps_original_error(self):
        context = contextvars.ContextVar('run-stop-context', default=None)
        token = context.set('source-context')
        self.addCleanup(context.reset, token)
        second = threading.Event()
        failure = common.LlmAccountAuthError()
        seen = []
        saved = []

        def worker(item):
            self.assertEqual(context.get(), 'source-context')
            seen.append(item)
            if item == 0:
                self.assertTrue(second.wait(2))
                raise failure
            second.set()
            time.sleep(0.03)
            return item

        def record(item, future):
            try:
                saved.append(future.result())
            except common.LlmAccountAuthError:
                saved.append('failed')

        with self.assertRaises(common.LlmAccountAuthError) as caught:
            common.run_bounded_llm_tasks(range(4), worker, 2, on_result=record)
        self.assertIs(caught.exception, failure)
        self.assertCountEqual(seen, [0, 1])
        self.assertCountEqual(saved, ['failed', 1])

    def test_run_error_preserves_simultaneous_result_save_failure(self):
        second = threading.Event()
        failure = common.LlmAccountAuthError()
        save_failure = OSError('磁盘写入失败')
        finished = []
        seen = []
        def worker(item):
            seen.append(item)
            if item == 0:
                self.assertTrue(second.wait(2))
                raise failure
            second.set()
            time.sleep(0.03)
            finished.append(item)
            return item
        def save(item, future):
            try:
                future.result()
            except common.LlmAccountAuthError:
                return
            raise save_failure
        with self.assertRaises(common.LlmAccountAuthError) as caught:
            common.run_bounded_llm_tasks(range(4), worker, 2, on_result=save)
        self.assertIs(caught.exception, failure)
        self.assertIs(caught.exception.__cause__, save_failure)
        self.assertCountEqual(seen, [0, 1])
        self.assertEqual(finished, [1])

    def test_normal_save_failure_stops_new_tasks_and_waits_for_inflight(self):
        second = threading.Event()
        failure = OSError('保存结果失败')
        seen = []
        finished = []
        def worker(item):
            seen.append(item)
            if item == 0:
                self.assertTrue(second.wait(2))
            else:
                second.set()
                time.sleep(0.03)
            finished.append(item)
            return item
        def save(item, future):
            future.result()
            if item == 0:
                raise failure
        with self.assertRaises(OSError) as caught:
            common.run_bounded_llm_tasks(range(4), worker, 2, on_result=save)
        self.assertIs(caught.exception, failure)
        self.assertCountEqual(seen, [0, 1])
        self.assertCountEqual(finished, [0, 1])

    def test_bounded_normal_failures_may_be_recorded_and_continue(self):
        seen = []
        def worker(item):
            seen.append(item)
            if item == 0:
                raise ValueError('单篇正文错误')
            return item
        results = []
        def record(item, future):
            try:
                results.append(future.result())
            except ValueError:
                results.append('failed')
        common.run_bounded_llm_tasks(range(3), worker, 1, on_result=record)
        self.assertEqual(seen, [0, 1, 2])
        self.assertEqual(results, ['failed', 1, 2])
        self.assertEqual(common.run_bounded_llm_tasks([2, 1, 0], lambda x: x, 2), [2, 1, 0])

    def test_repair_config_failure_escapes_all_three_value_error_catches(self):
        for raw, responses, expected_calls in [
            ('short', None, 1),
            ('x' * 64, None, 1),
            ('x' * 64, [ValueError('响应JSON不合法')], 2),
        ]:
            with self.subTest(raw=raw, retry=responses is not None):
                failure = common.LlmAccountPoolConfigError('配置错误')
                calls = (responses or []) + [failure]
                with mock.patch.object(blog, 'call_llm_api', side_effect=calls) as request:
                    with self.assertRaises(common.LlmAccountPoolConfigError) as caught:
                        blog.repair_review_payload(raw, '测试审查', retry_prompt='重新审查')
                self.assertIs(caught.exception, failure)
                self.assertEqual(request.call_count, expected_calls)

    def test_repair_ordinary_invalid_json_still_retries(self):
        with mock.patch.object(blog, 'call_llm_api', side_effect=[ValueError('格式错误'), '{"passed":true,"issues":[]}']) as request:
            self.assertEqual(blog.repair_review_payload('x' * 64, '测试', retry_prompt='重新审查'), (True, []))
        self.assertEqual(request.call_count, 2)

    def test_summary_chunk_stops_after_real_review_request_failure(self):
        failure = common.LlmAccountAuthError()
        with mock.patch.object(blog, 'split_review_content', return_value=['一', '二', '三']), \
                mock.patch.object(blog, 'get_blog_review_concurrency', return_value=1), \
                mock.patch.object(blog, 'review_cached_unit', side_effect=lambda _kind, _data, operation: operation()), \
                mock.patch.object(blog, 'call_llm_api', side_effect=failure) as request:
            with self.assertRaises(common.LlmAccountAuthError) as caught:
                blog.llm_review_post('原文', '汇总页', required=True)
        self.assertIs(caught.exception, failure)
        self.assertEqual(request.call_count, 1)

    def test_paper_review_keeps_failure_callback_then_stops_original_error(self):
        failure = common.LlmAccountAuthError()
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'hugo.toml').write_text('title = "独立审查测试"\n')
            slugs = {f'2609.1000{i}': str(i) for i in range(3)}
            for slug in slugs.values():
                Path(tmp, f'2026-09-07-{slug}.md').write_text('---\ntitle: 测试\n---\n正文\n')
            seen = []
            with mock.patch.object(blog, 'BLOG_REPO', tmp), \
                    mock.patch.object(blog, 'CURRENT_DIR', Path(tmp) / 'current'), \
                    mock.patch.object(blog, 'get_blog_review_concurrency', return_value=1), \
                    mock.patch.object(blog, 'review_and_fix_post', return_value=(False, [])), \
                    mock.patch.object(blog, 'review_cached_unit', side_effect=lambda _kind, _data, operation: operation()), \
                    mock.patch.object(blog, 'call_llm_api', side_effect=failure) as request:
                with self.assertRaises(common.LlmAccountAuthError) as caught:
                    blog.review_all_posts('2026-09-07', slugs, [], require_llm=True,
                        content_dir=tmp, result_callback=lambda p, result: seen.append((p, result)))
            self.assertIs(caught.exception, failure)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(len(seen), 1)
            self.assertFalse(seen[0][1]['passed'])

    def test_paper_normal_worker_error_keeps_existing_record_and_continues(self):
        with tempfile.TemporaryDirectory() as tmp:
            slugs = {f'2609.1000{i}': str(i) for i in range(3)}
            for slug in slugs.values():
                Path(tmp, f'2026-09-07-{slug}.md').write_text('正文')
            with mock.patch.object(blog, 'get_blog_review_concurrency', return_value=1), \
                    mock.patch.object(blog, '_review_single_paper', side_effect=ValueError('坏正文')) as review:
                _, blocking, details = blog.review_all_posts('2026-09-07', slugs, [],
                    content_dir=tmp, return_details=True)
            self.assertEqual(review.call_count, 3)
            self.assertEqual(blocking, 3)
            self.assertEqual(len(details), 3)

    def test_conference_stops_new_pages_but_saves_inflight_pass(self):
        second = threading.Event()
        failure = common.LlmAccountPoolStateError('账号状态损坏')
        seen = []
        def review(content, title, **kwargs):
            seen.append(title)
            if title == '第一页':
                self.assertTrue(second.wait(2))
                raise failure
            second.set()
            time.sleep(0.03)
            return True, [], content
        module = SimpleNamespace(review_protocol_fingerprint=lambda: 'offline',
            split_review_content=lambda text, limit: [text], get_blog_review_chunk_chars=lambda: 10000,
            _llm_review_post_chunk=review, parse_markdown_images=lambda text: [],
            count_blocking_review_issues=lambda items: 0)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); records = []
            for i, title in enumerate(['第一页', '第二页', '第三页']):
                path = root / 'content' / 'posts' / f'{i}.md'; path.parent.mkdir(parents=True, exist_ok=True); raw = f'---\ntitle: {title}\n---\n正文\n'.encode()
                path.write_bytes(raw)
                records.append({'path': path.relative_to(root).as_posix(), 'sourceSha256': conference.sha_bytes(raw), 'kind': 'paper'})
            with mock.patch.object(conference, 'PUBLICATION_ROOT', root / 'receipts'), \
                    mock.patch.object(conference, 'load_publish_to_blog', return_value=module), \
                    mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-test'}):
                with self.assertRaises(common.LlmAccountPoolStateError) as caught:
                    conference.review_pages(root, records, workers=2)
            self.assertIs(caught.exception, failure)
            self.assertCountEqual(seen, ['第一页', '第二页'])
            passes = list((root / 'receipts' / 'page-review-passes').glob('*.json'))
            self.assertEqual(len(passes), 1)
            self.assertEqual(json.loads(passes[0].read_text())['path'], 'content/posts/1.md')

    def test_xhs_run_failure_is_not_local_fallback_and_does_not_dispatch_more(self):
        papers = [(9.0, {'title': title, 'abstract': '原文'}, {}) for title in ['甲', '乙', '丙']]
        for cls in [common.LlmAccountAuthError, common.LlmAccountPoolConfigError,
                    common.LlmAccountPoolStateError, common.LlmAccountPoolExhaustedError]:
            with self.subTest(error=cls.__name__):
                failure = cls() if cls is common.LlmAccountAuthError else cls('账号不可用')
                with mock.patch.object(xhs, 'get_oneliner_concurrency', return_value=1), \
                        mock.patch.object(xhs, 'call_publish_llm_api', side_effect=failure) as request:
                    with self.assertRaises(cls) as caught:
                        xhs.generate_llm_oneliners(papers)
                self.assertIs(caught.exception, failure)
                self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""R1-W2 综合单元测试：Python 固定 IP 传输门禁、博客审查引擎优化、检查点清理、推送去重、传输超时与双端核验一致性。"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import http.client
import importlib.util
import io
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
LIB_SCRIPTS = SCRIPTS / 'lib'
TESTS_PY = Path(__file__).resolve().parent
for _p in (str(SCRIPTS), str(LIB_SCRIPTS), str(TESTS_PY)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import blog_formula_tex_display as formula_display  # noqa: E402
import blog_git_publication  # noqa: E402
import blog_reader_binding_verifier as verifier  # noqa: E402
import blog_review_image_loader as img_loader  # noqa: E402
import blog_review_state  # noqa: E402
import conference_publication_gate as conf_gate  # noqa: E402
import error_guidance  # noqa: E402
import llm_usage  # noqa: E402
import pinned_http_transport as transport  # noqa: E402
import publish_common  # noqa: E402
from project_env_isolation import isolate_module_environment  # noqa: E402
from test_publish_to_blog import (  # noqa: E402
    git as git_cmd,
    init_blog_repo,
    llm_api_publication_fixture,
    publish_to_blog as pub,
    reseal_llm_api_reader_fixture,
    save_bound_review_receipt,
)

setUpModule, tearDownModule = isolate_module_environment()

_PUSH_SPEC = importlib.util.spec_from_file_location('push_blog_r1_w2_test', SCRIPTS / 'push-blog.py')
push_blog = importlib.util.module_from_spec(_PUSH_SPEC)
_PUSH_SPEC.loader.exec_module(push_blog)


def _valid_png_bytes(color=(255, 255, 255)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (4, 4), color).save(buf, format='PNG')
    return buf.getvalue()


def _table_fixture(quote: str, header: str, cell: str) -> dict:
    paper = llm_api_publication_fixture()
    table = f'| Method | {header} |\n|---|---|\n| A | {cell} |'
    old = pub._api_reader_markdown_tables(paper['apiReaderArticle'])[0]['markdown']
    paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old, table)
    paper['apiReaderPlan']['tableBindings'][0] = {
        'tableIndex': 1,
        'sourceType': 'source_quotes',
        'sourceTableOrdinal': None,
        'renderedTableSha256': hashlib.sha256(table.encode()).hexdigest(),
        'cellBindings': [],
        'sourceQuotes': [{'quote': quote, 'sourceQuoteSha256': hashlib.sha256(quote.encode()).hexdigest()}],
    }
    reseal_llm_api_reader_fixture(paper)
    return paper


class PinnedHttpTransportAndImageLoaderTests(unittest.TestCase):
    def setUp(self):
        transport.reset_origin_gates_for_tests()
        img_loader.clear_review_image_cache()

    def tearDown(self):
        transport.reset_origin_gates_for_tests()
        img_loader.clear_review_image_cache()

    def test_pure_module_runtime_guard_for_pinned_http_transport(self):
        sandbox_env = dict(os.environ, CODEX_SANDBOX='test-seatbelt')
        res = subprocess.run(
            [sys.executable, '-S', str(SCRIPTS / 'pinned_http_transport.py')],
            cwd=ROOT, env=sandbox_env, capture_output=True, text=True, timeout=5,
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertIn('必须在沙箱外运行', res.stdout + res.stderr)

    def test_origin_gate_semaphore_caps_arxiv_and_other_hosts(self):
        with mock.patch.dict(os.environ, {'PD_ARXIV_MAX_CONCURRENCY': '2'}, clear=False):
            gate_main = transport.get_origin_gate('https://arxiv.org/html/2611.00001v1/fig.png')
            gate_export = transport.get_origin_gate('https://export.arxiv.org/pdf/2611.00001v1')
            self.assertIs(gate_main, gate_export)
            self.assertEqual(gate_main.max_concurrency, 2)

            active = 0
            peak = 0
            lock = threading.Lock()
            errors = []

            def worker():
                nonlocal active, peak
                try:
                    with gate_main.slot():
                        with lock:
                            active += 1
                            peak = max(peak, active)
                        time.sleep(0.03)
                        with lock:
                            active -= 1
                except Exception as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=worker) for _ in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=5)
            self.assertEqual(errors, [])
            self.assertLessEqual(peak, 2)
            self.assertEqual(peak, 2)

        with mock.patch.dict(os.environ, {'PD_ARXIV_MAX_CONCURRENCY': '99'}, clear=False):
            self.assertEqual(transport.resolve_arxiv_max_concurrency(), 6)
        with mock.patch.dict(os.environ, {'PD_ARXIV_MAX_CONCURRENCY': '0'}, clear=False):
            self.assertEqual(transport.resolve_arxiv_max_concurrency(), 1)
        other_gate = transport.get_origin_gate('https://example.org/fig.png')
        self.assertEqual(other_gate.max_concurrency, 4)

    def test_read_pinned_raises_retryable_transient_error_for_429_and_5xx(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('127.0.0.1', 7897)
        for status in (429, 500, 502, 503, 504):
            with self.subTest(status=status):
                resp = mock.Mock()
                resp.connection.sock = sock
                resp.status = status
                resp.headers = {'Retry-After': '7'} if status == 429 else {}
                mgr = mock.Mock()
                mgr.request.return_value = resp
                with mock.patch('urllib3.ProxyManager', return_value=mgr):
                    with self.assertRaises(img_loader.TransientImageFetchError) as raised:
                        img_loader.read_pinned_review_image(
                            'https://arxiv.org/html/2611.00001v1/x.png',
                            {'93.184.216.34'}, 'http://127.0.0.1:7897', {'127.0.0.1'},
                            time.monotonic() + 30,
                        )
                self.assertEqual(raised.exception.status, status)
                self.assertEqual(raised.exception.retry_after, '7' if status == 429 else None)

        # 404 stays non-retryable PublishDataValidationError
        resp404 = mock.Mock()
        resp404.connection.sock = sock
        resp404.status = 404
        resp404.headers = {}
        mgr404 = mock.Mock()
        mgr404.request.return_value = resp404
        with mock.patch('urllib3.ProxyManager', return_value=mgr404):
            with self.assertRaises(publish_common.PublishDataValidationError):
                img_loader.read_pinned_review_image(
                    'https://arxiv.org/html/2611.00001v1/missing.png',
                    {'93.184.216.34'}, 'http://127.0.0.1:7897', {'127.0.0.1'},
                    time.monotonic() + 30,
                )

    def test_download_retries_ssl_eof_and_429_with_retry_after_and_origin_cooldown(self):
        png = _valid_png_bytes()
        slept = []
        ok_resp = {
            'status': 200, 'location': None, 'media_type': 'image/png',
            'raw': png, 'pinned_address': '93.184.216.34',
        }
        attempts = [
            ssl.SSLEOFError('unexpected EOF'),
            img_loader.TransientImageFetchError(429, retry_after='5'),
            img_loader.TransientImageFetchError(503),
            ok_resp,
        ]
        fake_time = SimpleNamespace(monotonic=time.monotonic, sleep=slept.append)
        hooks = {
            'get_required_fetch_proxy': lambda: 'http://127.0.0.1:7897',
            '_resolve_proxy_addresses': lambda _p: {'127.0.0.1'},
            '_validate_public_image_url': lambda _u: {'93.184.216.34'},
            '_read_pinned_review_image': mock.Mock(side_effect=attempts),
            'time': fake_time,
        }
        result = img_loader.download_review_image('https://arxiv.org/html/2611.00001v1/fig.png', hooks=hooks)
        self.assertEqual(result['media_type'], 'image/png')
        self.assertEqual(hooks['_read_pinned_review_image'].call_count, 4)
        # Retry-After=5s must be honored on the 429 retry, and origin cooldown recorded
        self.assertTrue(any(delay >= 5.0 for delay in slept), f'expected Retry-After>=5s sleep, got {slept}')
        gate = transport.get_origin_gate('https://arxiv.org/html/2611.00001v1/fig.png')
        self.assertGreater(gate.remaining_cooldown_seconds(), 0.0)

    def test_verified_url_byte_cache_is_scoped_and_proxy_keyed(self):
        png = _valid_png_bytes((10, 20, 30))
        ok_resp = {
            'status': 200, 'location': None, 'media_type': 'image/png',
            'raw': png, 'pinned_address': '93.184.216.34',
        }
        reader = mock.Mock(return_value=ok_resp)
        proxy_box = ['http://127.0.0.1:7897']
        hooks = {
            'get_required_fetch_proxy': lambda: proxy_box[0],
            '_resolve_proxy_addresses': lambda _p: {'127.0.0.1'},
            '_validate_public_image_url': lambda _u: {'93.184.216.34'},
            '_read_pinned_review_image': reader,
        }
        url = 'https://arxiv.org/html/2611.00001v1/cached.png'
        with img_loader.review_image_cache_scope():
            first = img_loader.download_review_image(url, hooks=hooks)
            second = img_loader.download_review_image(url, hooks=hooks)
            self.assertEqual(first, second)
            self.assertEqual(reader.call_count, 1)
            # Switching proxy mode misses the cache key
            proxy_box[0] = 'http://127.0.0.1:7898'
            img_loader.download_review_image(url, hooks=hooks)
            self.assertEqual(reader.call_count, 2)
            # Explicit clear invalidates active run cache
            img_loader.clear_review_image_cache()
            img_loader.download_review_image(url, hooks=hooks)
            self.assertEqual(reader.call_count, 3)
        # Outside scope, subsequent runs stay isolated
        with img_loader.review_image_cache_scope():
            img_loader.download_review_image(url, hooks=hooks)
            self.assertEqual(reader.call_count, 4)

    def test_self_link_image_fallback_skips_duplicate_url_retry(self):
        url = 'https://arxiv.org/html/2611.00001v1/broken.png'
        content = f'说明。\n[![图1]({url})]({url})\n结论。'
        loader_mock = mock.Mock(side_effect=pub.PublishDataValidationError('图片下载失败: HTTP 503'))
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor'}), \
                mock.patch.object(pub, '_load_review_image', loader_mock):
            passed, issues = pub.multimodal_review_images(content, 'Paper', required=True)
        self.assertFalse(passed)
        self.assertEqual(len(issues), 1)
        self.assertEqual(loader_mock.call_count, 1)

        # Distinct outer link fallback still works
        local_url = '/audio-research-portal/images/papers/2611.00001/figure-1-0123456789abcdef.png'
        distinct_content = f'说明。\n[![图1]({local_url})]({url})\n结论。'
        distinct_calls = []
        def distinct_loader(target_url, **_kw):
            distinct_calls.append(target_url)
            if target_url == local_url:
                raise pub.PublishDataValidationError('本地受控图片不可读')
            return {'media_type': 'image/png', 'data': base64.b64encode(_valid_png_bytes()).decode('ascii')}
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor'}), \
                mock.patch.object(pub, '_load_review_image', side_effect=distinct_loader), \
                mock.patch.object(pub, 'call_llm_api', return_value='{"passed":true,"issues":[]}'):
            passed_ok, issues_ok = pub.multimodal_review_images(distinct_content, 'Paper', required=True)
        self.assertTrue(passed_ok)
        self.assertEqual(issues_ok, [])
        self.assertEqual(distinct_calls, [local_url, url])

    def test_conference_fetch_public_retries_429_503_with_retry_after_and_rotates_addresses(self):
        shared = mock.Mock()
        shared._resolve_proxy_addresses.return_value = {'127.0.0.1'}
        shared._remaining_deadline_seconds.return_value = 30.0
        shared._validate_public_image_url.return_value = {'1.1.1.1', '8.8.8.8'}
        pinned_seen = []

        def fake_pinned(parsed, addr):
            pinned_seen.append(addr)
            return f'https://{addr}{parsed.path}'

        shared._pinned_https_url.side_effect = fake_pinned
        r429 = mock.Mock(status=429, headers={'Retry-After': '4'})
        r503 = mock.Mock(status=503, headers={})
        r200 = mock.Mock(status=200, headers={'Content-Type': 'image/png'})
        r200.read.side_effect = [b'pngdata', b'']
        mgr = mock.Mock()
        mgr.request.side_effect = [r429, r503, r200]
        slept = []
        with mock.patch.object(conf_gate, 'safe_transport', return_value=shared), \
                mock.patch('project_env.get_required_fetch_proxy', return_value='http://127.0.0.1:7897'), \
                mock.patch('urllib3.ProxyManager', return_value=mgr), \
                mock.patch.object(conf_gate.time, 'sleep', side_effect=slept.append):
            out = conf_gate.fetch_public('https://example.com/fig.png')
        self.assertEqual(out['body'], b'pngdata')
        self.assertEqual(pinned_seen, ['1.1.1.1', '8.8.8.8', '1.1.1.1'])
        self.assertTrue(any(delay >= 4.0 for delay in slept), f'expected Retry-After>=4s, got {slept}')


class ReviewEngineAndCheckpointTests(unittest.TestCase):
    def test_clear_review_page_checkpoints_cleans_units_and_refuses_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp).resolve() / 'current'
            cp_dir = current / 'blog-review-checkpoints' / '2026-11-27'
            units_sub = cp_dir / 'units' / ('a' * 64)
            units_sub.mkdir(parents=True)
            (cp_dir / ('b' * 64 + '.json')).write_text('{}', encoding='utf-8')
            (cp_dir / 'units' / 'direct.json').write_text('{}', encoding='utf-8')
            (units_sub / ('c' * 64 + '.json')).write_text('{}', encoding='utf-8')

            with mock.patch.object(pub, 'CURRENT_DIR', current):
                pub.clear_review_page_checkpoints('2026-11-27')
            self.assertFalse(cp_dir.exists())

            outside = Path(tmp).resolve() / 'outside-dir'
            outside.mkdir()
            (outside / 'keep.json').write_text('{}', encoding='utf-8')
            with mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'review_page_checkpoint_dir', return_value=outside):
                with self.assertRaises(pub.PublishDataValidationError):
                    pub.clear_review_page_checkpoints('2026-11-27')
            self.assertTrue((outside / 'keep.json').is_file())

    def test_chunk_zero_cache_ignores_volatile_paper_digest_frontmatter(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp).resolve() / 'current'
            page = Path(tmp).resolve() / '2026-11-27-paper.md'
            chunk_v1 = (
                '---\n'
                'title: "Test Paper"\n'
                'paper_digest_page_type: paper\n'
                'paper_digest_source_sha256: "' + ('a' * 64) + '"\n'
                '---\n\n正文内容。\n'
            )
            chunk_v2 = chunk_v1.replace('a' * 64, 'b' * 64)
            llm_calls = mock.Mock(return_value='{"passed":true,"issues":[]}')
            with mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'review_protocol_fingerprint', return_value='d' * 64), \
                    mock.patch.object(pub, 'call_llm_api', llm_calls):
                with pub.review_unit_cache('2026-11-27', page, required=True, paper_id='2611.00001'):
                    p1, i1, _ = pub.llm_review_post(chunk_v1, 'Test Paper', required=True)
                with pub.review_unit_cache('2026-11-27', page, required=True, paper_id='2611.00001'):
                    p2, i2, _ = pub.llm_review_post(chunk_v2, 'Test Paper', required=True)
            self.assertTrue(p1 and p2)
            self.assertEqual(i1, [])
            self.assertEqual(i2, [])
            self.assertEqual(llm_calls.call_count, 1)

    def test_zero_warning_paper_images_persisted_in_pass_cache_and_hydrated_on_pass2(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve() / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current = Path(tmp).resolve() / 'current'
            current.mkdir(parents=True)

            img_url = 'https://arxiv.org/html/2611.00001v1/fig1.png'
            png = _valid_png_bytes((12, 34, 56))
            b64 = base64.b64encode(png).decode('ascii')
            expected_payload_sha = hashlib.sha256(b64.encode('ascii')).hexdigest()

            paper_file = posts / '2026-11-27-paper-one.md'
            paper_file.write_text(f'---\ntitle: "Paper One"\n---\n![图1]({img_url})\n', encoding='utf-8')
            index_file = posts / '2026-11-27.md'
            index_file.write_text(f'---\ntitle: "汇总页"\n---\n![图1]({img_url})\n', encoding='utf-8')

            paper_sha = pub._sha256_file(paper_file)
            pass_results = {
                str(paper_file.resolve()): {
                    'passed': True,
                    'completed': True,
                    'reviewedSha256': paper_sha,
                    'reviewProtocolFingerprint': 'e' * 64,
                    'imageReviewMode': 'multimodal',
                    'cleanPassedImages': {img_url: expected_payload_sha},
                }
            }
            with mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'review_protocol_fingerprint', return_value='e' * 64), \
                    mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor'}), \
                    mock.patch.object(pub, 'review_and_fix_post', return_value=(False, [])), \
                    mock.patch.object(pub, 'llm_review_post', return_value=(True, [], index_file.read_text(encoding='utf-8'))), \
                    mock.patch.object(pub, '_load_review_image', return_value={'media_type': 'image/png', 'data': b64}), \
                    mock.patch.object(pub, 'call_llm_api', side_effect=AssertionError('summary thumbnail must be skipped')) as llm_mock:
                cache_path = pub.save_review_pass_cache('2026-11-27', [paper_file], pass_results)
                saved = json.loads(cache_path.read_text(encoding='utf-8'))
                self.assertEqual(saved['files'][0]['cleanPassedImages'], {img_url: expected_payload_sha})

                # Pass 2: only index_file is in review_paths; paper_file is SHA-reused!
                _fixed, blocking, details = pub.review_all_posts(
                    '2026-11-27',
                    {'2611.00001': 'paper-one'},
                    [(9.0, {'arxivId': '2611.00001', 'title': 'Paper One'}, {})],
                    require_llm=True,
                    content_dir=str(posts),
                    review_paths=[index_file],
                    return_details=True,
                )
            self.assertEqual(blocking, 0)
            self.assertTrue(details[os.path.realpath(index_file)]['passed'])
            llm_mock.assert_not_called()

    def test_global_llm_inflight_semaphore_caps_concurrency(self):
        active = 0
        peak = 0
        lock = threading.Lock()

        def fake_publish_api(*_args, **_kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.03)
            with lock:
                active -= 1
            return '{"passed":true,"issues":[]}'

        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_LLM_MAX_INFLIGHT': '3'}, clear=False), \
                mock.patch.object(pub, 'call_publish_llm_api', side_effect=fake_publish_api):
            threads = [
                threading.Thread(target=pub.call_llm_api, args=('prompt',))
                for _ in range(9)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=5)
        self.assertEqual(peak, 3)

    def test_blog_runtime_fingerprint_os_walk_prunes_generated_prefixes_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            (repo / 'layouts').mkdir()
            (repo / 'hugo.yaml').write_text('baseURL: https://example.test/\n', encoding='utf-8')
            (repo / 'layouts' / 'single.html').write_text('{{ .Content }}', encoding='utf-8')
            (repo / 'static' / 'js').mkdir(parents=True)
            (repo / 'static' / 'js' / 'app.js').write_text('console.log(1);\n', encoding='utf-8')
            gen_dir = repo / 'static' / 'data' / 'papers' / '2026-11-27' / '2611-00001'
            gen_dir.mkdir(parents=True)
            (gen_dir / 'meta.json').write_text('{"a":1}\n', encoding='utf-8')

            fp1 = pub.blog_runtime_fingerprint(repo)
            (gen_dir / 'meta.json').write_text('{"a":2}\n', encoding='utf-8')
            self.assertEqual(fp1, pub.blog_runtime_fingerprint(repo))

            # Symlink at pruned dir boundary must still be rejected
            link_dir = repo / 'static' / 'images' / 'papers'
            link_dir.parent.mkdir(parents=True, exist_ok=True)
            link_dir.symlink_to(gen_dir, target_is_directory=True)
            with self.assertRaisesRegex(pub.PublishDataValidationError, '符号链接'):
                pub.blog_runtime_fingerprint(repo)


class PushDeduplicationTests(unittest.TestCase):
    def test_load_verified_review_receipt_hashes_v3_files_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp).resolve() / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            paper = llm_api_publication_fixture()
            with mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current):
                paper_page = posts / '2026-07-10-paper.md'
                paper_page.write_text(
                    '---\npaper_digest_page_type: paper\npaper_digest_arxiv_id: "'
                    + paper['arxivId'] + '"\n---\nreviewed\n',
                    encoding='utf-8',
                )
                publish_paths = [page, paper_page]
                fp = pub.generation_input_fingerprint([paper], '2026-07-10', '论文速递', False)
                manifest = pub.save_generation_manifest(
                    '2026-07-10', publish_paths,
                    input_fingerprint=fp,
                    template_fingerprint=pub.generation_template_fingerprint(),
                    base_head=git_cmd(repo, 'rev-parse', 'HEAD').stdout.strip(),
                    published_papers=[paper],
                    publication_mode=pub.LLM_API_PRODUCTION_MODE,
                )
                results = {
                    str(p.resolve()): {'passed': True, 'reviewedSha256': pub._sha256_file(p)}
                    for p in publish_paths
                }
                pub.save_review_receipt(
                    '2026-07-10', publish_paths, 'hugo',
                    generation_manifest=manifest, reviewed_results=results,
                )
                real_sha = pub._sha256_file
                hashed_targets = []

                def counting_sha(p):
                    hashed_targets.append(str(Path(p).resolve()))
                    return real_sha(p)

                with mock.patch.object(pub, '_sha256_file', side_effect=counting_sha):
                    pub.load_verified_review_receipt('2026-07-10')
                # Each publish target should be hashed only once inside load_verified_review_receipt
                self.assertEqual(hashed_targets.count(str(page.resolve())), 1)
                self.assertEqual(hashed_targets.count(str(paper_page.resolve())), 1)

    def test_push_token_skips_second_receipt_and_fresh_replay_while_standalone_stays_self_verifying(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp, with_remote=True)
            current = Path(tmp).resolve() / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'GITHUB_REMOTE', 'origin'):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                with pub.blog_publication_lock('2026-07-10'), pub._daily_publication_replay_scope():
                    paths, receipt_path = pub.load_verified_review_receipt('2026-07-10')
                    token = pub._issue_verified_push_receipt_token('2026-07-10', paths, receipt_path)
                    self.assertIsNotNone(token)
                    with mock.patch.object(pub, 'load_verified_review_receipt',
                                           side_effect=AssertionError('should not re-verify receipt')) as load_mock, \
                            mock.patch.object(pub, '_validate_push_generation_input_integrity',
                                              side_effect=AssertionError('should not re-run fresh replay')) as fresh_mock:
                        ok = pub.git_push('2026-07-10', paths, verified_receipt_token=token)
                    self.assertTrue(ok)
                    load_mock.assert_not_called()
                    fresh_mock.assert_not_called()

        # Standalone execute_git_push without token MUST still self-verify!
        with tempfile.TemporaryDirectory() as tmp2:
            repo2, posts2, _remote2 = init_blog_repo(tmp2, with_remote=True)
            current2 = Path(tmp2).resolve() / 'current'
            page2 = posts2 / '2026-07-11.md'
            page2.write_text('reviewed standalone\n', encoding='utf-8')
            with mock.patch.object(pub, 'BLOG_REPO', str(repo2)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current2), \
                    mock.patch.object(pub, 'GITHUB_REMOTE', 'origin'):
                publish_paths2 = [page2]
                save_bound_review_receipt('2026-07-11', publish_paths2)
                with mock.patch.object(pub, 'load_verified_review_receipt', wraps=pub.load_verified_review_receipt) as load_spy, \
                        mock.patch.object(pub, '_validate_push_generation_input_integrity', wraps=pub._validate_push_generation_input_integrity) as fresh_spy:
                    ok2 = pub.git_push('2026-07-11', publish_paths2)
                self.assertTrue(ok2)
                load_spy.assert_called_once_with('2026-07-11')
                fresh_spy.assert_called_once_with('2026-07-11')

    def test_validate_generation_input_integrity_fresh_clears_api_reader_payload_cache(self):
        paper = llm_api_publication_fixture()
        bindings = pub.llm_api_publication_bindings([paper])
        proof = pub.llm_api_production_proof([paper])
        manifest = {
            'schemaVersion': 3, 'category': '论文速递', 'publishAll': False,
            'publishedPapers': [paper],
            'publishedPapersFingerprintContract': pub.PUBLISHED_PAPERS_FINGERPRINT_CONTRACT,
            'publishedPapersFingerprint': pub.published_papers_fingerprint([paper]),
            'publicationMode': pub.LLM_API_PRODUCTION_MODE,
            'manualV6Bindings': [], 'manualV6BindingsFingerprint': pub._stable_json_sha256([]),
            'llmApiBindings': bindings, 'llmApiBindingsFingerprint': pub._stable_json_sha256(bindings),
            'llmApiProduction': proof, 'llmApiProductionFingerprint': pub._stable_json_sha256(proof),
            'inputFingerprint': pub.generation_input_fingerprint(
                [paper], '2026-08-31', '论文速递', False, _include_pdf_page_derivations=False,
            ),
        }
        pub._API_READER_PAYLOAD_CACHE[('sentinel',)] = {'stale': True}
        pub._validate_generation_input_integrity(manifest, '2026-08-31', fresh=True)
        self.assertNotIn(('sentinel',), pub._API_READER_PAYLOAD_CACHE)

    def test_push_receipt_token_is_single_use_and_invalidated_by_sealed_source_tamper(self):
        # 1) Single-use token: second consume MUST return None!
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp, with_remote=True)
            current = Path(tmp).resolve() / 'current'
            page = posts / '2026-07-12.md'
            page.write_text('reviewed single-use\n', encoding='utf-8')
            with mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-12', publish_paths)
                with pub.blog_publication_lock('2026-07-12'), pub._daily_publication_replay_scope():
                    paths, receipt_path = pub.load_verified_review_receipt('2026-07-12')
                    manifest_rel = pub._git_relative_manifest(paths)
                    token = pub._issue_verified_push_receipt_token('2026-07-12', paths, receipt_path)
                    self.assertIsNotNone(token)
                    first = pub._consume_verified_push_receipt_token(token, '2026-07-12', manifest_rel)
                    self.assertIsNotNone(first)
                    second = pub._consume_verified_push_receipt_token(token, '2026-07-12', manifest_rel)
                    self.assertIsNone(second, 'verified push receipt token must be strictly single-use')

        # 2) Sealed source tamper (modified source.txt or symlinked source.pdf) MUST invalidate snapshot & token!
        with tempfile.TemporaryDirectory() as tmp2:
            base = Path(tmp2).resolve()
            runs_dir = base / 'daily-fresh-source-runs'
            run_id = '11111111-2222-4333-8444-555555555555'
            paper_id = '2611.00001'
            sealed_dir = runs_dir / run_id / 'sources' / paper_id / 'generation-000001'
            sealed_dir.mkdir(parents=True)
            (runs_dir / run_id / 'run.json').write_text('{"runId":"' + run_id + '"}', encoding='utf-8')
            for fname, body in (
                ('source-manifest.json', '{"version":1}'),
                ('source-runtime.json', '{"paperId":"arxiv:2611.00001"}'),
                ('source.txt', 'original sealed paper text\n'),
                ('source.pdf', '%PDF-1.7\noriginal\n%%EOF\n'),
            ):
                (sealed_dir / fname).write_text(body, encoding='utf-8')

            current2 = base / 'current'
            current2.mkdir(parents=True)
            manifest_path = current2 / 'blog-generation-manifest-2026-11-27.json'
            receipt_path2 = current2 / 'blog-review-receipt-2026-11-27.json'
            gen_manifest = {
                'schemaVersion': 3,
                'publicationMode': pub.LLM_API_PRODUCTION_MODE,
                'publishedPapers': [{
                    'arxivId': f'{paper_id}v1',
                    'freshRewriteProvenance': {
                        'runId': run_id,
                        'sourceGeneration': 1,
                    },
                }],
            }
            manifest_path.write_text(json.dumps(gen_manifest), encoding='utf-8')
            receipt_path2.write_text('{"strictReview":true}', encoding='utf-8')
            posts_dir2 = base / 'content' / 'posts'
            posts_dir2.mkdir(parents=True)
            page2 = posts_dir2 / '2026-11-27.md'
            page2.write_text('reviewed\n', encoding='utf-8')

            with mock.patch.object(pub, 'DAILY_FRESH_SOURCE_RUNS_DIR', runs_dir), \
                    mock.patch.object(pub, 'CURRENT_DIR', current2), \
                    mock.patch.object(pub, 'BLOG_REPO', str(base)), \
                    mock.patch.object(pub.blog_formats, 'source_bound_generation', return_value=True):
                snap_before = pub._stat_and_sha_for_input_manifest(gen_manifest, '2026-11-27')
                self.assertIsNotNone(snap_before)
                snap_paths = {entry[0] for entry in snap_before}
                self.assertIn(str(runs_dir / run_id / 'run.json'), snap_paths)
                for fname in ('source-manifest.json', 'source-runtime.json', 'source.txt', 'source.pdf'):
                    self.assertIn(str(sealed_dir / fname), snap_paths)

                with pub._daily_publication_replay_scope():
                    pub._record_verified_push_receipt(
                        date_str='2026-11-27',
                        paths=[page2],
                        receipt_path=receipt_path2,
                        manifest_path=manifest_path,
                        generation_manifest=gen_manifest,
                        verified_target_states={},
                    )
                    tok = pub._issue_verified_push_receipt_token('2026-11-27', [page2], receipt_path2)
                    self.assertIsNotNone(tok)
                    # Tamper sealed source.txt BEFORE consuming token!
                    (sealed_dir / 'source.txt').write_text('tampered sealed paper text!\n', encoding='utf-8')
                    consumed = pub._consume_verified_push_receipt_token(
                        tok, '2026-11-27', pub._git_relative_manifest([page2]),
                    )
                    self.assertIsNone(consumed, 'tampering sealed source.txt must invalidate push receipt token')

                # Replacing a sealed file with a symlink MUST fail closed (return None)
                decoy = base / 'decoy.pdf'
                decoy.write_text('%PDF-1.7\ndecoy\n', encoding='utf-8')
                (sealed_dir / 'source.pdf').unlink()
                (sealed_dir / 'source.pdf').symlink_to(decoy)
                self.assertIsNone(pub._stat_and_sha_for_input_manifest(gen_manifest, '2026-11-27'))


class TransportUsageAndVerifierParityTests(unittest.TestCase):
    def test_publish_common_enforces_60s_connect_timeout_and_180s_sse_idle_timeout(self):
        # 1) Connect/TLS handshake uses min(timeout, 60.0) and switches to read_timeout after connect
        observed = []

        class _FakeSocket:
            def __init__(self):
                self.timeouts = []

            def settimeout(self, val):
                self.timeouts.append(val)

            def setsockopt(self, *_args):
                pass

        fake_sock = _FakeSocket()

        def fake_super_connect(conn_self):
            observed.append(('connect_timeout', conn_self.timeout))
            conn_self.sock = fake_sock

        conn = publish_common._KeepAliveHTTPSConnection(
            'example.invalid', timeout=300.0,
            connect_timeout=publish_common.PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS,
            read_timeout=publish_common.PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS,
        )
        with mock.patch.object(http.client.HTTPSConnection, 'connect', fake_super_connect):
            conn.connect()
        self.assertEqual(observed, [('connect_timeout', 60.0)])
        self.assertEqual(conn.timeout, 300.0)
        self.assertIn(180.0, fake_sock.timeouts)

        # 2) SSE read loop sets socket timeout to min(remaining, 180.0) and labels idle timeouts
        sse_sock = _FakeSocket()

        class _FakeHTTPResponse(http.client.HTTPResponse):
            def __init__(self):
                self.status = 200
                self.fp = SimpleNamespace(raw=SimpleNamespace(_sock=sse_sock))

            def read1(self, _n):
                raise TimeoutError('timed out')

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        opener = mock.Mock()
        opener.open.return_value = _FakeHTTPResponse()
        events = []
        with self.assertRaises(TimeoutError) as raised:
            publish_common._open_publish_json_with_account_pool(
                api_url='https://example.invalid/v1/responses',
                endpoint='https://example.invalid/v1',
                model='muse-spark-1.3-contributor',
                api_type='openai_responses',
                api_keys=['sk-test'],
                payload={'model': 'muse-spark-1.3-contributor', 'stream': True, 'input': []},
                opener=opener,
                timeout=400,
                usage_sink=events.append,
            )
        self.assertEqual(getattr(raised.exception, 'code', None), 'REQUEST_STREAM_IDLE_TIMEOUT')
        self.assertTrue(any(abs(t - 180.0) < 1.0 for t in sse_sock.timeouts), sse_sock.timeouts)
        self.assertEqual(events[0]['errorCode'], 'REQUEST_STREAM_IDLE_TIMEOUT')

    def test_llm_usage_index_paper_id_and_pending_request_fields(self):
        self.assertEqual(llm_usage.normalize_usage_paper_id('index:2026-11-27'), 'index:2026-11-27')
        self.assertIsNone(llm_usage.normalize_usage_paper_id('index:2026-02-30'))
        self.assertIsNone(llm_usage.normalize_usage_paper_id('index:bad'))

        acct_id = 'a' * 64
        with tempfile.TemporaryDirectory() as tmp, llm_usage.with_llm_usage_context({
            'paperId': 'index:2026-11-27',
            'batchDate': '2026-11-27',
            'workflow': 'daily',
            'stage': 'publish.text',
        }):
            pending = llm_usage.begin_pending_llm_request(
                directory=Path(tmp) / 'usage',
                protocol='openai_responses',
                model='muse-spark-1.3-contributor',
                request={'input': 'hi'},
                account_id=acct_id,
            )
        self.assertEqual(pending['kind'], 'request_started')
        self.assertEqual(pending['paperId'], 'index:2026-11-27')
        self.assertEqual(pending['batchDate'], '2026-11-27')
        self.assertEqual(pending['workflow'], 'daily')
        self.assertEqual(pending['accountId'], acct_id)

    def test_reader_binding_verifier_small_floats_negation_and_superscripts(self):
        # Fixed-decimal formatting down to <1e-6 matches Node
        self.assertEqual(pub._normalize_api_reader_numeric_token('0.00005'), '0.00005')
        self.assertEqual(pub._normalize_api_reader_numeric_token('0.000001'), '0.000001')
        self.assertEqual(pub._normalize_api_reader_numeric_token('0.0000005'), '0.0000005')
        self.assertEqual(pub._normalize_api_reader_numeric_token('-0.0'), '0')

        # Header-unit enforcement NEVER silently skips 0.00005 or 0.0000005 (5e-7)
        for val in ('0.00005', '0.0000005'):
            with self.subTest(missing_unit=val):
                bad = _table_fixture(f'Method A achieves Loss = {val}.', 'Loss (ms)', val)
                with self.assertRaisesRegex(pub.PublishDataValidationError, '列头单位'):
                    pub._validate_api_reader_source_bindings(bad)
            with self.subTest(valid_unit=val):
                good = _table_fixture(f'Method A achieves Loss (ms) = {val}.', 'Loss (ms)', val)
                self.assertEqual(pub._validate_api_reader_source_bindings(good)['tableCount'], 1)

        # Scientific-notation token passed directly into header-unit checker still fails closed
        sci_failures = verifier._reader_table_header_unit_evidence_failures(
            {'header': ['Method', 'Loss (ms)'], 'rows': [['A', '0.0000005']]},
            ['Method A achieves Loss = 0.0000005.'],
            hooks={'_api_reader_numeric_tokens': lambda _s: ['5e-7'], '_normalize_api_reader_numeric_token': pub._normalize_api_reader_numeric_token, '_reader_adjacent_metric_unit_evidence': pub._reader_adjacent_metric_unit_evidence},
        )
        self.assertEqual(sci_failures, [(1, 1, '5e-7', 'ms')])

        # Aligned negation regex at directly_declared rejects 并非/不是/未达到/不等于/不超过
        for neg_quote in (
            '该方法 WER (%) 并非 1.2。',
            '该方法 WER (%) 不是 1.2。',
            '该方法 WER (%) 未达到 1.2。',
            '该方法 WER (%) 不等于 1.2。',
            '该方法 WER (%) 不超过 1.2。',
        ):
            with self.subTest(neg_quote=neg_quote):
                bad_neg = _table_fixture(neg_quote, 'WER (%)', '1.2')
                with self.assertRaisesRegex(pub.PublishDataValidationError, '列头单位'):
                    pub._validate_api_reader_source_bindings(bad_neg)

        # Superscripts must NOT leak bare scalar digits before matching
        self.assertEqual(pub._api_reader_numeric_tokens('10⁻⁴'), ['10'])
        self.assertEqual(pub._api_reader_numeric_tokens('x² + y³'), [])
        self.assertEqual(pub._api_reader_numeric_tokens('① Method'), [])

    def test_scientific_notation_numeric_token_parity_with_js(self):
        self.assertEqual(pub._normalize_api_reader_numeric_token('5e-7'), '0.0000005')
        self.assertEqual(pub._normalize_api_reader_numeric_token('1e-5'), '0.00001')
        self.assertEqual(pub._normalize_api_reader_numeric_token('-5e-7'), '-0.0000005')
        self.assertEqual(pub._normalize_api_reader_numeric_token('1.25e-5ms'), '0.0000125ms')
        self.assertEqual(pub._normalize_api_reader_numeric_token('1e+3s'), '1000s')
        samples = [
            '5e-7', '1e-5', '-5e-7', '1.25e-5ms', '1e+3s',
            '0.0000005', '0.00001', '2.50%', '1e21', '1e-7%', '10e',
        ]
        env = {k: v for k, v in os.environ.items() if k != 'CODEX_SANDBOX'}
        env['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'
        proc = subprocess.run(
            [
                'node', '-e',
                "const fs=require('node:fs');"
                "const b=require('./scripts/lib/reader-source-evidence-binding.js');"
                "const s=JSON.parse(fs.readFileSync(0,'utf8'));"
                "process.stdout.write(JSON.stringify(s.map(x=>b.normalizeReaderNumericToken(x))));",
            ],
            cwd=str(ROOT), input=json.dumps(samples, ensure_ascii=False),
            capture_output=True, text=True, timeout=30, env=env, check=True,
        )
        js_results = json.loads(proc.stdout)
        for sample, js_out in zip(samples, js_results):
            with self.subTest(sample=sample):
                self.assertEqual(pub._normalize_api_reader_numeric_token(sample), js_out)

    def test_fold_reader_tex_cell_duplicate_parity_and_falsy_zero_preservation(self):
        # Falsy 0 must be preserved as '0', not collapsed to ''
        self.assertEqual(formula_display._reader_tex_cell_canonical(0), '0')
        self.assertEqual(formula_display._reader_tex_plain(0), '0')
        self.assertEqual(formula_display._fold_reader_tex_cell_duplicate(0), '0')
        self.assertEqual(formula_display._project_reader_cell_tex_display(0), '0')
        self.assertEqual(formula_display._project_reader_cell_tex_display(None), '')

        # Branch order parity with JS reader-source-display.js:187-229
        samples = [
            r'+ n∼𝒰0,1n\sim\mathcal{U}_{0,1}',
            r'+ ab\mathrm{ab} (ms)',
            r'Δ\DeltaIC',
            r'Aligned (†:f×8{}^{\dagger}\!:{f}\times 8)',
            r'(−1.4)(-1.4)',
            r'x](−1.4)(-1.4)',
            r'x\(−1.4)(-1.4)',
        ]
        env = {k: v for k, v in os.environ.items() if k != 'CODEX_SANDBOX'}
        env['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'
        proc = subprocess.run(
            [
                'node', '-e',
                "const fs=require('node:fs');"
                "const d=require('./scripts/lib/reader-source-display.js');"
                "const s=JSON.parse(fs.readFileSync(0,'utf8'));"
                "process.stdout.write(JSON.stringify(s.map(x=>d.projectReaderCellTexDisplay(x))));",
            ],
            cwd=str(ROOT), input=json.dumps(samples, ensure_ascii=False),
            capture_output=True, text=True, timeout=30, env=env, check=True,
        )
        js_results = json.loads(proc.stdout)
        for sample, js_out in zip(samples, js_results):
            with self.subTest(sample=sample):
                self.assertEqual(formula_display._project_reader_cell_tex_display(sample), js_out)

    def test_error_guidance_classifies_blocking_review_failures(self):
        for msg in (
            '审查仍有 2 个页面阻断',
            '审查仍有 4 个未解决阻断问题',
            '审查仍有 2 个页面阻断与 1 个关联资产阻断（共 3 个）',
            '审查仍有 1 个关联资产阻断',
        ):
            with self.subTest(msg=msg):
                self.assertEqual(error_guidance.rule_id_for({'message': msg}, 'blog-review'), 'blog-review-blocking-issues')
                g = error_guidance.guidance_for({'message': msg}, 'blog-review')
                self.assertNotIn('没有匹配到已知错误类型', g['cause'])
                self.assertIn('阻断', g['cause'])


if __name__ == '__main__':
    unittest.main()

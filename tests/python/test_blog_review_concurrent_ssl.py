#!/usr/bin/env python3
"""Concurrent review_all_posts transient SSL/HTTP recovery & shared arXiv OriginGate tests."""

from __future__ import annotations

import io
import os
import ssl
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
TESTS_PY = Path(__file__).resolve().parent
for _p in (str(SCRIPTS), str(TESTS_PY)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import blog_review_image_loader as img_loader  # noqa: E402
import pinned_http_transport as transport  # noqa: E402
from project_env_isolation import isolate_module_environment  # noqa: E402
from test_publish_to_blog import publish_to_blog as pub  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()


def _valid_png_bytes(color=(240, 244, 248)) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (8, 8), color).save(buf, format='PNG')
    return buf.getvalue()


def _ok_pinned_response(png_bytes: bytes, addr: str = '93.184.216.34') -> dict:
    return {
        'status': 200,
        'location': None,
        'media_type': 'image/png',
        'raw': png_bytes,
        'pinned_address': addr,
    }


class ConcurrentBlogReviewSslRecoveryTests(unittest.TestCase):
    def setUp(self):
        transport.reset_origin_gates_for_tests()
        img_loader.clear_review_image_cache()

    def tearDown(self):
        transport.reset_origin_gates_for_tests()
        img_loader.clear_review_image_cache()

    def test_concurrent_review_all_posts_recovers_from_ssl_eof_and_transient_http_with_shared_arxiv_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve() / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current = Path(tmp).resolve() / 'current'
            current.mkdir(parents=True)

            date_str = '2026-11-27'
            paper_slugs = {}
            scored_papers = []
            paper_paths = []

            for idx in range(1, 7):
                arxiv_id = f'2611.0000{idx}'
                slug = f'paper-{idx}'
                paper_slugs[arxiv_id] = slug
                scored_papers.append((
                    9.0 - idx * 0.1,
                    {'arxivId': arxiv_id, 'title': f'Concurrent SSL Paper {idx}'},
                    {},
                ))
                fig1 = f'https://arxiv.org/html/{arxiv_id}v1/fig1.png'
                fig2 = f'https://arxiv.org/html/{arxiv_id}v1/fig2.png'
                md = (
                    f'---\ntitle: "Concurrent SSL Paper {idx}"\n---\n\n'
                    f'图示说明 1。\n![图1]({fig1})\n\n'
                    f'图示说明 2。\n![图2]({fig2})\n'
                )
                page_path = posts / f'{date_str}-{slug}.md'
                page_path.write_text(md, encoding='utf-8')
                paper_paths.append(page_path)

            # Summary index reuses paper 1's recovered fig1 URL
            index_fig = 'https://arxiv.org/html/2611.00001v1/fig1.png'
            index_file = posts / f'{date_str}.md'
            index_file.write_text(
                f'---\ntitle: "每日汇总 {date_str}"\n---\n\n![精选图]({index_fig})\n',
                encoding='utf-8',
            )

            # Distinct valid PNGs per URL so each figure has a distinct payload hash
            png_map = {}
            for idx in range(1, 7):
                arxiv_id = f'2611.0000{idx}'
                png_map[f'https://arxiv.org/html/{arxiv_id}v1/fig1.png'] = _valid_png_bytes((idx * 30, 50, 100))
                png_map[f'https://arxiv.org/html/{arxiv_id}v1/fig2.png'] = _valid_png_bytes((idx * 30, 120, 200))

            # Scripted transient transport faults across concurrent papers
            fault_plans = {
                'https://arxiv.org/html/2611.00001v1/fig1.png': [
                    ssl.SSLEOFError('EOF occurred in violation of protocol'),
                ],
                'https://arxiv.org/html/2611.00002v1/fig1.png': [
                    img_loader.TransientImageFetchError(429, retry_after='3'),
                ],
                'https://arxiv.org/html/2611.00003v1/fig1.png': [
                    ssl.SSLEOFError('unexpected EOF while reading'),
                    img_loader.TransientImageFetchError(503),
                ],
                'https://arxiv.org/html/2611.00004v1/fig1.png': [
                    ConnectionResetError(54, 'Connection reset by peer'),
                ],
            }

            state_lock = threading.Lock()
            attempts_by_url: dict[str, int] = {}
            active_in_flight = 0
            peak_in_flight = 0
            slept_durations: list[float] = []
            recorded_cooldown_waits: list[float] = []
            real_sleep = time.sleep
            fixed_now = 10000.0

            def fake_sleep(seconds: float) -> None:
                with state_lock:
                    slept_durations.append(float(seconds))

            orig_record = transport.OriginGate.record_transient_failure

            def spy_record(gate_self, *args, **kwargs):
                wait = orig_record(gate_self, *args, **kwargs)
                with state_lock:
                    recorded_cooldown_waits.append(float(wait))
                return wait

            def fake_read_pinned(current_url, resolved_addresses, proxy, proxy_addresses, deadline, target_address=None):
                nonlocal active_in_flight, peak_in_flight
                with state_lock:
                    active_in_flight += 1
                    peak_in_flight = max(peak_in_flight, active_in_flight)
                    attempt_idx = attempts_by_url.get(current_url, 0)
                    attempts_by_url[current_url] = attempt_idx + 1
                    planned = fault_plans.get(current_url, [])
                    exc = planned[attempt_idx] if attempt_idx < len(planned) else None
                try:
                    # Brief real yield inside slot so concurrent workers genuinely contend on the arXiv OriginGate
                    real_sleep(0.005)
                    if exc is not None:
                        raise exc
                    return _ok_pinned_response(png_map[current_url], addr=target_address or '93.184.216.34')
                finally:
                    with state_lock:
                        active_in_flight -= 1

            fake_time = SimpleNamespace(monotonic=lambda: fixed_now, sleep=fake_sleep)
            llm_calls = mock.Mock(return_value='{"passed":true,"issues":[]}')

            with mock.patch.dict(os.environ, {
                'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor',
                'PD_BLOG_REVIEW_CONCURRENCY': '6',
                'PD_ARXIV_MAX_CONCURRENCY': '2',
            }, clear=False), \
                    mock.patch.object(transport.OriginGate, 'record_transient_failure', spy_record), \
                    mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'review_protocol_fingerprint', return_value='a' * 64), \
                    mock.patch.object(pub, 'review_and_fix_post', return_value=(False, [])), \
                    mock.patch.object(pub, 'llm_review_post', side_effect=lambda c, *_a, **_kw: (True, [], c)), \
                    mock.patch.object(pub, 'get_required_fetch_proxy', return_value='http://127.0.0.1:7897'), \
                    mock.patch.object(pub, '_resolve_proxy_addresses', return_value={'127.0.0.1'}), \
                    mock.patch.object(pub, '_validate_public_image_url', return_value={'93.184.216.34'}), \
                    mock.patch.object(pub, '_read_pinned_review_image', side_effect=fake_read_pinned), \
                    mock.patch.object(pub, 'time', fake_time), \
                    mock.patch.object(pub, 'call_llm_api', llm_calls):
                _fixed, blocking, details = pub.review_all_posts(
                    date_str,
                    paper_slugs,
                    scored_papers,
                    require_llm=True,
                    content_dir=str(posts),
                    return_details=True,
                )
                gate = transport.get_origin_gate('https://arxiv.org/html/2611.00001v1/fig1.png')
                gate_max_concurrency = gate.max_concurrency
                gate_cooldown_delta = gate.remaining_cooldown_seconds(now_monotonic=fixed_now)

            # Zero false blocking across all 6 paper pages + summary index page
            self.assertEqual(blocking, 0, f'unexpected blocking issues: {details}')
            for p in [*paper_paths, index_file]:
                key = os.path.realpath(p)
                self.assertIn(key, details)
                self.assertTrue(details[key]['passed'], f'{p.name} should pass: {details[key]}')
                self.assertEqual(details[key]['blockingCount'], 0)
                self.assertEqual(details[key]['issues'], [])

            # Verify every injected transient error actually triggered retries and succeeded
            self.assertEqual(attempts_by_url['https://arxiv.org/html/2611.00001v1/fig1.png'], 2)
            self.assertEqual(attempts_by_url['https://arxiv.org/html/2611.00002v1/fig1.png'], 2)
            self.assertEqual(attempts_by_url['https://arxiv.org/html/2611.00003v1/fig1.png'], 3)
            self.assertEqual(attempts_by_url['https://arxiv.org/html/2611.00004v1/fig1.png'], 2)

            # Shared arXiv OriginGate strictly capped concurrency at PD_ARXIV_MAX_CONCURRENCY=2
            self.assertGreaterEqual(peak_in_flight, 2, 'workers should execute concurrently up to gate limit')
            self.assertLessEqual(peak_in_flight, 2, f'arXiv OriginGate breached concurrency cap: {peak_in_flight}')

            # Shared arXiv OriginGate recorded deterministic cooldown deadline & Retry-After>=3s was honored
            self.assertEqual(gate_max_concurrency, 2)
            self.assertGreaterEqual(gate_cooldown_delta, 3.0)
            self.assertTrue(
                any(wait >= 3.0 for wait in recorded_cooldown_waits),
                f'expected recorded OriginGate cooldown>=3s, got {recorded_cooldown_waits}',
            )
            self.assertTrue(
                any(delay >= 3.0 for delay in slept_durations),
                f'expected Retry-After>=3s or shared cooldown sleep, got {slept_durations}',
            )
            # Summary index reused cached/clean-passed paper 1 image (12 paper images reviewed, not 13)
            self.assertEqual(llm_calls.call_count, 12)

    def test_shared_arxiv_origin_gate_cooldown_propagates_across_main_and_export_subdomains(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve() / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current = Path(tmp).resolve() / 'current'
            current.mkdir(parents=True)

            date_str = '2026-11-27'
            url_main = 'https://arxiv.org/html/2611.00010v1/fig1.png'
            url_export = 'https://export.arxiv.org/html/2611.00011v1/fig1.png'
            (posts / f'{date_str}-main.md').write_text(
                f'---\ntitle: "Main Arxiv"\n---\n![图1]({url_main})\n', encoding='utf-8',
            )
            (posts / f'{date_str}-export.md').write_text(
                f'---\ntitle: "Export Arxiv"\n---\n![图1]({url_export})\n', encoding='utf-8',
            )

            both_workers_active = threading.Barrier(2, timeout=5.0)
            ssl_fault_recorded = threading.Event()
            worker_local = threading.local()
            sleeps_by_url: dict[str, list[float]] = {}
            main_thread_ids: list[int] = []
            export_thread_ids: list[int] = []
            export_saw_signal = False
            lock = threading.Lock()
            main_calls = 0
            export_calls = 0
            fixed_now = 20000.0
            png = _valid_png_bytes((20, 80, 140))

            def fake_sleep(seconds: float) -> None:
                active_url = getattr(worker_local, 'active_url', 'unknown')
                with lock:
                    sleeps_by_url.setdefault(active_url, []).append(float(seconds))

            def fake_validate_url(url: str) -> set[str]:
                nonlocal export_saw_signal
                worker_local.active_url = url
                tid = threading.get_ident()
                with lock:
                    if url == url_main:
                        main_thread_ids.append(tid)
                    elif url == url_export:
                        export_thread_ids.append(tid)
                # Synchronize both workers so main and export are guaranteed to run concurrently on distinct threads
                both_workers_active.wait()
                if url == url_export:
                    # Wait until main worker has raised SSLEOFError and armed shared arxiv.org cooldown
                    signaled = ssl_fault_recorded.wait(timeout=5.0)
                    with lock:
                        export_saw_signal = signaled
                return {'93.184.216.34'}

            def fake_read_pinned(current_url, *_args, **_kwargs):
                nonlocal main_calls, export_calls
                if current_url == url_main:
                    with lock:
                        main_calls += 1
                        call_num = main_calls
                    if call_num == 1:
                        # Schedule signaling right after download_review_image records cooldown on gate
                        raise ssl.SSLEOFError('shared cooldown trigger')
                elif current_url == url_export:
                    with lock:
                        export_calls += 1
                return _ok_pinned_response(png)

            orig_record = transport.OriginGate.record_transient_failure

            def spy_record(gate_self, *args, **kwargs):
                wait = orig_record(gate_self, *args, **kwargs)
                if wait > 0:
                    ssl_fault_recorded.set()
                return wait

            fake_time = SimpleNamespace(monotonic=lambda: fixed_now, sleep=fake_sleep)
            with mock.patch.dict(os.environ, {
                'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor',
                'PD_BLOG_REVIEW_CONCURRENCY': '2',
                'PD_ARXIV_MAX_CONCURRENCY': '2',
            }, clear=False), \
                    mock.patch.object(transport.OriginGate, 'record_transient_failure', spy_record), \
                    mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'review_protocol_fingerprint', return_value='b' * 64), \
                    mock.patch.object(pub, 'review_and_fix_post', return_value=(False, [])), \
                    mock.patch.object(pub, 'llm_review_post', side_effect=lambda c, *_a, **_kw: (True, [], c)), \
                    mock.patch.object(pub, 'get_required_fetch_proxy', return_value='http://127.0.0.1:7897'), \
                    mock.patch.object(pub, '_resolve_proxy_addresses', return_value={'127.0.0.1'}), \
                    mock.patch.object(pub, '_validate_public_image_url', side_effect=fake_validate_url), \
                    mock.patch.object(pub, '_read_pinned_review_image', side_effect=fake_read_pinned), \
                    mock.patch.object(pub, 'time', fake_time), \
                    mock.patch.object(pub, 'call_llm_api', return_value='{"passed":true,"issues":[]}'):
                _fixed, blocking, details = pub.review_all_posts(
                    date_str,
                    {'2611.00010': 'main', '2611.00011': 'export'},
                    [
                        (8.5, {'arxivId': '2611.00010', 'title': 'Main Arxiv'}, {}),
                        (8.4, {'arxivId': '2611.00011', 'title': 'Export Arxiv'}, {}),
                    ],
                    require_llm=True,
                    content_dir=str(posts),
                    return_details=True,
                )

            self.assertEqual(blocking, 0, details)
            self.assertTrue(ssl_fault_recorded.is_set())
            self.assertTrue(export_saw_signal)
            self.assertEqual(len(main_thread_ids), 1)
            self.assertEqual(len(export_thread_ids), 1)
            self.assertNotEqual(
                main_thread_ids[0], export_thread_ids[0],
                'main and export workers must execute on distinct threads',
            )
            self.assertEqual(export_calls, 1)
            # Even though export.arxiv.org succeeded on its very first HTTP call on a distinct thread,
            # it observed the shared arxiv.org cooldown armed by arxiv.org!
            export_waits = sleeps_by_url.get(url_export, [])
            self.assertTrue(
                any(w >= transport.DEFAULT_TRANSIENT_COOLDOWN_SECONDS for w in export_waits),
                f'export.arxiv.org worker should wait on shared arxiv.org cooldown, got {export_waits}',
            )
            self.assertIs(
                transport.get_origin_gate(url_main),
                transport.get_origin_gate(url_export),
            )

    def test_exhausted_ssl_failure_marks_only_failing_page_transient_without_blocking_healthy_peers(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve() / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current = Path(tmp).resolve() / 'current'
            current.mkdir(parents=True)

            date_str = '2026-11-27'
            url_fail = 'https://arxiv.org/html/2611.00021v1/broken.png'
            url_recover = 'https://arxiv.org/html/2611.00022v1/flaky.png'
            url_ok = 'https://arxiv.org/html/2611.00023v1/ok.png'

            p_fail = posts / f'{date_str}-fail.md'
            p_recover = posts / f'{date_str}-recover.md'
            p_ok = posts / f'{date_str}-ok.md'
            p_fail.write_text(f'---\ntitle: "Fail"\n---\n![图1]({url_fail})\n', encoding='utf-8')
            p_recover.write_text(f'---\ntitle: "Recover"\n---\n![图1]({url_recover})\n', encoding='utf-8')
            p_ok.write_text(f'---\ntitle: "OK"\n---\n![图1]({url_ok})\n', encoding='utf-8')

            png = _valid_png_bytes((40, 160, 80))
            counts = {url_fail: 0, url_recover: 0, url_ok: 0}
            lock = threading.Lock()

            def fake_read_pinned(current_url, *_args, **_kwargs):
                with lock:
                    counts[current_url] += 1
                    n = counts[current_url]
                if current_url == url_fail:
                    raise ssl.SSLEOFError('persistent unexpected EOF')
                if current_url == url_recover and n == 1:
                    raise img_loader.TransientImageFetchError(503)
                return _ok_pinned_response(png)

            fake_time = SimpleNamespace(monotonic=time.monotonic, sleep=lambda _s: None)
            with mock.patch.dict(os.environ, {
                'PAPER_ANALYZER_MODEL': 'muse-spark-1.3-contributor',
                'PD_BLOG_REVIEW_CONCURRENCY': '3',
                'PD_ARXIV_MAX_CONCURRENCY': '3',
            }, clear=False), \
                    mock.patch.object(pub, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(pub, 'CURRENT_DIR', current), \
                    mock.patch.object(pub, 'review_protocol_fingerprint', return_value='c' * 64), \
                    mock.patch.object(pub, 'review_and_fix_post', return_value=(False, [])), \
                    mock.patch.object(pub, 'llm_review_post', side_effect=lambda c, *_a, **_kw: (True, [], c)), \
                    mock.patch.object(pub, 'get_required_fetch_proxy', return_value='http://127.0.0.1:7897'), \
                    mock.patch.object(pub, '_resolve_proxy_addresses', return_value={'127.0.0.1'}), \
                    mock.patch.object(pub, '_validate_public_image_url', return_value={'93.184.216.34'}), \
                    mock.patch.object(pub, '_read_pinned_review_image', side_effect=fake_read_pinned), \
                    mock.patch.object(pub, 'time', fake_time), \
                    mock.patch.object(pub, 'call_llm_api', return_value='{"passed":true,"issues":[]}'):
                _fixed, blocking, details = pub.review_all_posts(
                    date_str,
                    {'2611.00021': 'fail', '2611.00022': 'recover', '2611.00023': 'ok'},
                    [
                        (8.0, {'arxivId': '2611.00021', 'title': 'Fail'}, {}),
                        (8.0, {'arxivId': '2611.00022', 'title': 'Recover'}, {}),
                        (8.0, {'arxivId': '2611.00023', 'title': 'OK'}, {}),
                    ],
                    require_llm=True,
                    content_dir=str(posts),
                    return_details=True,
                )

            # Failing page exhausted all 4 attempts and reported transient failure; peers unaffected
            self.assertEqual(counts[url_fail], 4)
            self.assertEqual(counts[url_recover], 2)
            self.assertEqual(counts[url_ok], 1)
            self.assertGreaterEqual(blocking, 1)

            fail_entry = details[os.path.realpath(p_fail)]
            self.assertFalse(fail_entry['passed'])
            self.assertEqual(fail_entry['failureKind'], 'transient')
            self.assertTrue(fail_entry['completed'])

            for peer in (p_recover, p_ok):
                peer_entry = details[os.path.realpath(peer)]
                self.assertTrue(peer_entry['passed'], f'{peer.name} must stay healthy: {peer_entry}')
                self.assertEqual(peer_entry['blockingCount'], 0)


if __name__ == '__main__':
    unittest.main()

"""Bounded index image review keeps the existing per-image proof and recovery."""
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from test_publish_to_blog import publish_to_blog as blog
import llm_usage


def content(count=7):
    return '\n\n'.join(f'上下文 {i}\n![alt-{i}](https://example.test/image-{i}.png)' for i in range(1,count+1))


def pixels(url):
    number = re.search(r'image-(\d+)', url).group(1)
    return {'media_type': 'image/png', 'data': base64.b64encode(number.encode()).decode()}


class IndexImageReviewConcurrencyTests(unittest.TestCase):
    def patches(self):
        return mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'test-model'}), mock.patch.object(blog, '_load_review_image', side_effect=pixels)

    def test_bounded_parallel_requests_cover_all_pixels_and_keep_issue_order(self):
        lock=threading.Lock(); active=0; peak=0; seen=[]
        def request(prompt, **kwargs):
            nonlocal active,peak
            self.assertEqual(len(kwargs['images']),1)
            number=int(base64.b64decode(kwargs['images'][0]['data']))
            self.assertIn(f'- 图片 {number} | alt: `alt-{number}` | 来源: https://example.test/image-{number}.png',prompt)
            self.assertIn(f'[图 {number}/7]',kwargs['context'])
            with lock:active+=1;peak=max(peak,active);seen.append(number)
            time.sleep((8-number)*.012)
            with lock:active-=1
            return json.dumps({'passed':number!=4,'issues':[{'severity':'error' if number==4 else 'info','description':f'image-{number}'}]})
        env,images=self.patches()
        with env,images,mock.patch.object(blog,'call_llm_api',side_effect=request):
            passed,issues=blog.multimodal_review_images(content(),'汇总页面',required=True,image_concurrency=5)
        self.assertFalse(passed);self.assertEqual(peak,5);self.assertEqual(sorted(seen),list(range(1,8)))
        self.assertEqual([i['description'] for i in issues],[f'image-{n}' for n in range(1,8)])

    def test_paper_images_remain_serial_without_nested_page_concurrency(self):
        seen=[]
        def request(prompt,**kwargs):
            seen.append(int(base64.b64decode(kwargs['images'][0]['data'])))
            return '{"passed":true,"issues":[]}'
        env,images=self.patches()
        with env,images,mock.patch.object(blog,'call_llm_api',side_effect=request),mock.patch.object(blog,'run_bounded_llm_tasks') as parallel:
            self.assertEqual(blog.multimodal_review_images(content(),'Paper',required=True),(True,[]))
            parallel.assert_not_called()
        self.assertEqual(seen,list(range(1,8)))

    def test_parallel_context_and_real_unit_cache_survive_repeat_and_reject_changed_context(self):
        scopes=[];lock=threading.Lock()
        def request(prompt,**kwargs):
            cache=blog._REVIEW_UNIT_CONTEXT.get();usage=dict(llm_usage._SCOPE.get())
            with lock:scopes.append((cache,usage))
            return '{"passed":true,"issues":[]}'
        env,images=self.patches()
        with tempfile.TemporaryDirectory() as td,env,images,mock.patch.object(blog,'CURRENT_DIR',Path(td)/'current'),mock.patch.object(blog,'review_protocol_fingerprint',return_value='a'*64),mock.patch.object(blog,'call_llm_api',side_effect=request) as api:
            page=Path(td)/'index.md'
            for _ in range(2):
                with blog.review_unit_cache('2026-10-11',page,required=True,run_id='f'*8):
                    self.assertEqual(blog.multimodal_review_images(content(3),'汇总页面',required=True,image_concurrency=3),(True,[]))
            self.assertEqual(api.call_count,3)
            self.assertEqual(len(list((Path(td)/'current').rglob('units/*/*.json'))),3)
            for cache,usage in scopes:
                self.assertEqual(cache['runId'],'f'*8);self.assertEqual(usage['runId'],'f'*8)
                self.assertEqual(usage['stage'],'publish.figure');self.assertRegex(usage['unitId'],r'^[0-9a-f]{64}$')
            self.assertEqual(len({usage['unitId'] for _,usage in scopes}),3)
            with blog.review_unit_cache('2026-10-11',page,required=True,run_id='f'*8):
                blog.multimodal_review_images(content(3).replace('上下文 1','全新上下文 1'),'汇总页面',required=True,image_concurrency=3)
            self.assertEqual(api.call_count,4)  # Only the first image's nearby context changed.
            self.assertIsNone(blog._REVIEW_UNIT_CONTEXT.get())

    def test_run_failure_stops_replenishment_and_keeps_completed_unit_checkpoints(self):
        ready = threading.Barrier(5)
        failure_observed = threading.Event()
        seen = []
        completed = []
        lock = threading.Lock()
        real_wait = concurrent.futures.wait

        def observe_failed_future(*args, **kwargs):
            done, pending = real_wait(*args, **kwargs)
            if any(getattr(future.exception(), 'scope', None) == 'run' for future in done):
                # The real worker has saved its failed unit and the scheduler's
                # invoke wrapper has observed the error before the Future ends.
                failure_observed.set()
            return done, pending

        def request(prompt, **kwargs):
            number = int(base64.b64decode(kwargs['images'][0]['data']))
            with lock:
                seen.append(number)
            ready.wait(timeout=10)
            if number == 1:
                error = RuntimeError('run-level refusal')
                error.scope = 'run'
                raise error
            # Do not assume the failure checkpoint reaches the scheduler within
            # a fixed sleep. Keep the other real in-flight calls pending until
            # its completed Future proves that the run error was observed.
            self.assertTrue(failure_observed.wait(timeout=10))
            with lock:
                completed.append(number)
            return '{"passed":true,"issues":[]}'
        env, images = self.patches()
        with (
            tempfile.TemporaryDirectory() as td,
            env,
            images,
            mock.patch.object(blog, 'CURRENT_DIR', Path(td) / 'current'),
            mock.patch.object(blog, 'review_protocol_fingerprint', return_value='a' * 64),
            mock.patch.object(blog, 'call_llm_api', side_effect=request),
            mock.patch('publish_common.concurrent.futures.wait', side_effect=observe_failed_future),
        ):
            with blog.review_unit_cache('2026-10-11',Path(td)/'index.md',required=True):
                with self.assertRaisesRegex(RuntimeError,'run-level refusal'):
                    blog.multimodal_review_images(content(12),'汇总页面',required=True,image_concurrency=5)
            self.assertTrue(failure_observed.is_set())
            self.assertEqual(sorted(seen),[1,2,3,4,5])
            self.assertEqual(sorted(completed),[2,3,4,5])
            records=[json.loads(f.read_text()) for f in (Path(td)/'current').rglob('units/*/*.json')]
            self.assertEqual(len(records),5);self.assertEqual(sum(r['passed'] for r in records),4)

    def test_index_call_site_uses_configured_concurrency(self):
        with tempfile.TemporaryDirectory() as td:
            f=Path(td)/'2026-10-11.md';text='合法汇总页面。';f.write_text(text)
            with mock.patch.object(blog,'review_and_fix_post',return_value=(0,[])),mock.patch.object(blog,'llm_review_post',return_value=(True,[],text)),mock.patch.object(blog,'multimodal_review_images',return_value=(True,[])) as image_review,mock.patch.object(blog,'get_blog_review_concurrency',return_value=3):
                blog.review_all_posts('2026-10-11', {}, [], content_dir=td,review_paths=[f],require_llm=False)
            image_review.assert_called_once_with(text,'汇总页面',required=False,image_concurrency=3)

    def test_invalid_parallel_limits_are_rejected(self):
        for value in [0,6,True,'5']:
            with self.subTest(value=value),self.assertRaises(ValueError):
                blog.multimodal_review_images(content(),image_concurrency=value)

if __name__=='__main__':unittest.main()

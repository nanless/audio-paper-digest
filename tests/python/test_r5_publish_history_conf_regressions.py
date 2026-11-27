import copy
import hashlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
TESTS_PY = Path(__file__).resolve().parent
for p in (str(SCRIPTS), str(TESTS_PY)):
    if p not in sys.path:
        sys.path.insert(0, p)

from project_env_isolation import isolate_module_environment, restore_environment_after  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()


def _load_script_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, str(SCRIPTS / filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


import conference_publication_gate as conf_gate  # noqa: E402
import llm_usage  # noqa: E402
import markdown_hugo_gate as hugo_gate  # noqa: E402
import pdf_author_extract as pae  # noqa: E402
import publish_common  # noqa: E402
import reader_inline_svg  # noqa: E402
import reader_inline_svg_pixel_replay  # noqa: E402

historical_page_render = _load_script_module('r5_historical_page_render', 'historical-page-render.py')
historical_direct_review = _load_script_module('r5_historical_direct_review', 'historical-direct-review.py')
publish_conference = _load_script_module('r5_publish_conference', 'publish-conference.py')


class R5PublishHistoryConfRegressions(unittest.TestCase):
    # =========================================================================
    # Bug #5: historical-page-render.py reads renderedArticle & avoids double ephemeral figure render
    # =========================================================================
    def test_r5_5_historical_page_render_uses_rendered_article_and_skips_double_figure_render(self):
        restore_environment_after(self)
        from test_publish_to_blog import llm_api_publication_fixture
        paper = llm_api_publication_fixture()
        paper.pop('arxivId', None)
        paper['directPaperId'] = 'conference:icassp:2026:icassp-arnumber:505'
        paper['analysis'] += (
            '\n\n## 标签\n#语音识别 #Transformer #低资源\n'
            '主任务标签: #语音识别\n主方法标签: #Transformer\n补充标签: #低资源'
        )
        paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = (
            hashlib.sha256(paper['analysis'].encode()).hexdigest()
        )
        publisher = historical_page_render.load_publish_to_blog()
        real_payload_fn = publisher._api_reader_payload

        def fake_payload(view):
            payload = real_payload_fn(view)
            payload = copy.deepcopy(payload)
            payload['renderedArticle'] = payload['renderedArticle'] + '\n\nRENDERED_ARTICLE_MARKER_R5_5\n'
            payload['figurePersistence'] = publisher.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT
            return payload

        with mock.patch.object(publisher, '_api_reader_payload', side_effect=fake_payload), \
                mock.patch.object(publisher, 'render_ephemeral_api_reader_figures',
                                  wraps=publisher.render_ephemeral_api_reader_figures) as mock_ephemeral, \
                mock.patch.object(historical_page_render, 'load_publish_to_blog', return_value=publisher):
            result = historical_page_render.render_packet({
                'directStaging': True,
                'paper': paper,
                'cohortDate': '2026-09-04',
            })
        self.assertIn('RENDERED_ARTICLE_MARKER_R5_5', result['markdown'])
        mock_ephemeral.assert_not_called()

    # =========================================================================
    # Bug #8: llm_usage.py & historical-direct-review.py workflow attribution
    # =========================================================================
    def test_r5_8_llm_usage_workflow_validation_and_historical_direct_review_context(self):
        for wf in ('daily', 'conference', 'history'):
            with llm_usage.with_llm_usage_context({'workflow': wf, 'stage': 'publish.text'}):
                ev = llm_usage.build_llm_usage_event(protocol='openai', model='test', request={}, status_code=200)
            self.assertEqual(ev.get('workflow'), wf)
        for bad in ('invalid', '', None, 123, 'DAILY'):
            ev = llm_usage.build_llm_usage_event(
                protocol='openai', model='test', request={}, status_code=200,
                context={'workflow': bad},
            )
            self.assertNotIn('workflow', ev)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            page_path = root / 'content' / 'posts' / 'p.md'
            page_path.parent.mkdir(parents=True)
            content = '---\ntitle: "Hist"\n---\n\n正文。\n\n![图1](https://example.org/fig1.png)\n'
            page_path.write_text(content, encoding='utf-8')
            sha = hashlib.sha256(content.encode('utf-8')).hexdigest()
            seen_contexts = []

            class FakeModule:
                @staticmethod
                def get_blog_review_chunk_chars():
                    return 20000

                @staticmethod
                def split_review_content(text, _limit):
                    return [text]

                @staticmethod
                def _llm_review_post_chunk(chunk, _title, **_kw):
                    seen_contexts.append(('text', dict(llm_usage._SCOPE.get())))
                    return True, [], chunk

                @staticmethod
                def parse_markdown_images(_text):
                    return [{'alt': '图1', 'url': 'https://example.org/fig1.png'}]

                @staticmethod
                def multimodal_review_images(_text, _title, **_kw):
                    seen_contexts.append(('image', dict(llm_usage._SCOPE.get())))
                    return True, []

            protocol = {'budgets': {'chunkChars': 20000}}
            res = historical_direct_review.review_page(
                FakeModule,
                {'path': 'content/posts/p.md', 'sha256': sha, 'paperId': 'arxiv:2601.00001'},
                root,
                root / 'checkpoints',
                protocol,
            )
            self.assertTrue(res['passed'])
            self.assertEqual(len(seen_contexts), 2)
            self.assertEqual(seen_contexts[0][1].get('workflow'), 'history')
            self.assertEqual(seen_contexts[0][1].get('stage'), 'publish.text')
            self.assertEqual(seen_contexts[1][1].get('workflow'), 'history')
            self.assertEqual(seen_contexts[1][1].get('stage'), 'publish.figure')

    # =========================================================================
    # Bug #9: markdown_hugo_gate.py rendered_html fence strip & unclosed <a> in <h2>
    # =========================================================================
    def test_r5_9_hugo_gate_rendered_html_does_not_strip_backticks_and_handles_unclosed_anchor(self):
        # 1) rendered_html=True must NOT treat triple-backticks in HTML prose as Markdown fences
        html_with_fences = '<p>```</p><p>Leaked math $x + y$ inside HTML</p><p>```</p>'
        issues = hugo_gate.math_and_emphasis_issues(html_with_fences, 'page.html', rendered_html=True)
        self.assertTrue(any('裸 $' in item for item in issues), f'Expected bare $ issue, got: {issues}')

        # 2) Unclosed <a> inside <h2> must NOT raise TypeError in mask_source_bound_author_dollars
        artifact = {
            'body': '## 👥 作者与机构\n\n- Alice：Lab \\$A\n',
        }
        malformed_html = (
            '<h2 id="-作者与机构">👥 作者与机构'
            '<a hidden class="anchor" aria-hidden="true" href="#-作者与机构">#</h2>'
            '<p>trailing</p></a>'
            '<ul><li>Alice：Lab $A</li></ul>'
        )
        masked = hugo_gate.mask_source_bound_author_dollars(malformed_html, artifact)
        self.assertIsInstance(masked, str)

    # =========================================================================
    # Bug #12: publish-conference.py wraps review calls in with_llm_usage_context
    # =========================================================================
    def test_r5_12_publish_conference_sets_llm_usage_context_for_text_and_figure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repo = root / 'blog'
            (repo / 'content' / 'posts').mkdir(parents=True)
            pub_root = root / 'pub'
            pub_root.mkdir()
            img_url = 'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/icassp-2026/a1b2c3d4e5f6/figure-1.png'
            rel = 'content/posts/p1.md'
            body = f'---\ntitle: "Conf Paper"\ndate: 2026-09-07\ndraft: false\n---\n\n正文。\n\n![图1]({img_url})\n'
            (repo / rel).write_text(body, encoding='utf-8')
            records = [{
                'path': rel,
                'kind': 'paper',
                'paperId': 'conference:icassp:2026:icassp-arnumber:42',
                'sourceSha256': hashlib.sha256(body.encode('utf-8')).hexdigest(),
            }]
            captured = []

            class FakePub:
                BLOG_REPO = str(repo)
                CONTENT_DIR = str(repo / 'content' / 'posts')

                @staticmethod
                def split_review_content(content, _chars):
                    return [content]

                @staticmethod
                def get_blog_review_chunk_chars():
                    return 20000

                @staticmethod
                def _llm_review_post_chunk(chunk, _title='', required=False, chunk_label='1/1', *, source_figure_note=''):
                    captured.append(('text', dict(llm_usage._SCOPE.get())))
                    return True, [], chunk

                @staticmethod
                def parse_markdown_images(content):
                    return [img_url] if img_url in content else []

                @staticmethod
                def multimodal_review_images(_content, _title='', required=False,
                                             publication_figure_contexts=None,
                                             passed_image_registry=None,
                                             verified_paper_images=None):
                    captured.append(('figure', dict(llm_usage._SCOPE.get())))
                    return True, []

                @staticmethod
                def count_blocking_review_issues(issues):
                    return 0

            with mock.patch.object(publish_conference, 'PUBLICATION_ROOT', pub_root), \
                    mock.patch.object(publish_conference, 'load_publish_to_blog', return_value=FakePub), \
                    mock.patch.object(publish_conference, 'content_review_protocol',
                                      return_value={'contract': 'test', 'protocolSha256': 'a' * 64}):
                res = publish_conference.review_pages(repo, records, workers=1)
            self.assertEqual(res['status'], 'passed')
            self.assertEqual(len(captured), 2)
            self.assertEqual(captured[0][1]['stage'], 'publish.text')
            self.assertEqual(captured[0][1]['workflow'], 'conference')
            self.assertEqual(captured[0][1]['paperId'], 'conference:icassp:2026:icassp-arnumber:42')
            self.assertEqual(captured[1][1]['stage'], 'publish.figure')
            self.assertEqual(captured[1][1]['workflow'], 'conference')
            self.assertEqual(captured[1][1]['paperId'], 'conference:icassp:2026:icassp-arnumber:42')

    # =========================================================================
    # Bug #13: publish-conference.py lock release, 20s default poll, non-transient abort
    # =========================================================================
    def test_r5_13_wait_for_pages_deploy_poll_default_early_abort_and_lock_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repo = root / 'blog'
            images = root / 'images'
            pub_dir = root / 'pub'
            repo.mkdir(); images.mkdir(); pub_dir.mkdir()

            # 1) Default poll interval is 20s (when env unset)
            sleeps = []
            seq = [
                {'status': 'pending', 'metadataOutcome': 'pending'},
                {'status': 'metadata_observed', 'metadataOutcome': 'success'},
            ]
            with mock.patch.dict(os.environ, {}, clear=False), \
                    mock.patch.object(publish_conference, '_is_github_pages_portal_remote', return_value=True), \
                    mock.patch.object(publish_conference.time, 'sleep', side_effect=sleeps.append):
                os.environ.pop('PD_PAGES_DEPLOY_POLL_SECONDS', None)
                out = publish_conference.wait_for_pages_deploy(
                    repo, 'a' * 40, timeout_seconds=100, collect_metadata=lambda _oid: seq.pop(0),
                )
            self.assertEqual(out['status'], 'deployed')
            self.assertEqual(len(sleeps), 1)
            self.assertGreaterEqual(sleeps[0], 19)
            self.assertLessEqual(sleeps[0], 20)

            # 2) Non-transient unknown errors abort immediately without sleeping and include verify hint
            for sample in (
                {'status': 'unknown', 'metadataOutcome': 'unknown', 'issues': [{'domain': 'network', 'code': 'unavailable', 'reason': 'http_status'}], 'requests': [{'httpStatus': 403}]},
                {'status': 'unknown', 'metadataOutcome': 'unknown', 'issues': [{'domain': 'network', 'code': 'unavailable', 'reason': 'http_status'}], 'requests': [{'httpStatus': 429}]},
                {'status': 'unknown', 'metadataOutcome': 'unknown', 'issues': [{'domain': 'workflow', 'code': 'unavailable', 'reason': 'workflow_missing'}]},
                {'status': 'unknown', 'metadataOutcome': 'unknown', 'issues': [{'domain': 'workflow', 'code': 'invalid', 'reason': 'source_identity'}]},
                {'status': 'unknown', 'metadataOutcome': 'unknown', 'issues': [{'domain': 'network', 'code': 'unavailable', 'reason': 'connect_failed'}]},
                {'status': 'unknown', 'metadataOutcome': 'unknown', 'issues': [{'domain': 'network', 'code': 'unavailable', 'reason': 'tls_failed'}]},
            ):
                calls = 0

                def _collect(_oid, payload=sample):
                    nonlocal calls
                    calls += 1
                    return payload

                with mock.patch.object(publish_conference, '_is_github_pages_portal_remote', return_value=True), \
                        mock.patch.object(publish_conference.time, 'sleep', side_effect=AssertionError('should abort before sleeping')):
                    with self.assertRaisesRegex(publish_conference.ConferencePublicationError, 'conference:publish:verify'):
                        publish_conference.wait_for_pages_deploy(
                            repo, 'b' * 40, timeout_seconds=60, poll_interval_seconds=1,
                            collect_metadata=_collect,
                            conference_id='icassp-2026',
                            process_id='11111111-1111-4111-8111-111111111111',
                        )
                self.assertEqual(calls, 1)

            # 3) push() releases shared_publication_repository_locks BEFORE wait_for_pages_deploy
            lock_state = {'held': False}

            @contextmanager
            def tracked_locks(*_args, **_kwargs):
                lock_state['held'] = True
                try:
                    yield
                finally:
                    lock_state['held'] = False

            wait_saw_lock_held = []

            def fake_wait(*_args, **_kwargs):
                wait_saw_lock_held.append(lock_state['held'])
                return {'status': 'deployed'}

            generation = {
                'conferenceId': 'icassp-2026',
                'processId': '11111111-1111-4111-8111-111111111111',
                'generationSha256': 'a' * 64,
                'baseHead': 'b' * 40,
                'imageBaseHead': 'c' * 40,
                'remoteIdentitySha256': 'd' * 64,
                'imageRemoteIdentitySha256': 'e' * 64,
                'files': [{'path': 'content/posts/conference-icassp-2026.md'}],
                'imageFiles': [{'path': 'icassp-2026/abc/figure-1.png'}],
            }
            buf = io.StringIO()
            with mock.patch.object(publish_conference, 'blog_repo', return_value=repo), \
                    mock.patch.object(publish_conference, 'image_repo', return_value=images), \
                    mock.patch.object(publish_conference, 'publication_dir', return_value=pub_dir), \
                    mock.patch.object(publish_conference, 'shared_publication_repository_locks', side_effect=tracked_locks), \
                    mock.patch.object(publish_conference, 'validate_generation', return_value=(generation, {}, {})), \
                    mock.patch.object(publish_conference, 'require_publication_figure_view_ready'), \
                    mock.patch.object(publish_conference, 'load_review', return_value={'reviewSha256': 'f' * 64}), \
                    mock.patch.object(publish_conference, 'validate_review'), \
                    mock.patch.object(publish_conference, 'external_image_generation', return_value=True), \
                    mock.patch.object(publish_conference, 'verify_index'), \
                    mock.patch.object(publish_conference, 'commit_delta', return_value='1' * 40), \
                    mock.patch.object(publish_conference, 'push_delta', return_value={'remoteMain': '1' * 40, 'remoteIdentitySha256': 'd' * 64}), \
                    mock.patch.object(publish_conference, 'wait_for_pages_deploy', side_effect=fake_wait), \
                    mock.patch.object(publish_conference, 'accept_publication'), \
                    mock.patch('sys.stdout', buf):
                publish_conference.push('icassp-2026', '11111111-1111-4111-8111-111111111111', wait_deploy=True)
            self.assertEqual(wait_saw_lock_held, [False], 'wait_for_pages_deploy 必须在释放仓库锁后执行')

    # =========================================================================
    # Bug #14: conference_publication_gate.py markdown_tables skips fences & accepts 1-2 hyphens
    # =========================================================================
    def test_r5_14_conference_gate_markdown_tables_skips_fences_and_accepts_short_separators(self):
        md = '\n'.join([
            '```markdown',
            '| Fake | Col |',
            '|---|---|',
            '| 1 | 2 |',
            '```',
            '',
            '~~~',
            '| Fake2 | Col2 |',
            '| - | -- |',
            '| 3 | 4 |',
            '~~~',
            '',
            '| Real | Val |',
            '| - | -- |',
            '| A | 9.5 |',
            '',
            '| Real2 | Val2 |',
            '| :- | -: |',
            '| B | 8.0 |',
        ])
        tables = conf_gate.markdown_tables(md)
        self.assertEqual(len(tables), 2)
        self.assertEqual(tables[0], ['Real', 'Val', 'A', '9.5'])
        self.assertEqual(tables[1], ['Real2', 'Val2', 'B', '8.0'])

    # =========================================================================
    # Bug #16: publish_common.py 3 parity fixes
    # =========================================================================
    def test_r5_16_publish_common_parity_fixes(self):
        # 1) (?<!加) lookbehind allows "加上 1 个" / "加上 1 层" while flagging "下 1 步"
        good_analysis = '## 论文评价\n\n稳定有效。\n\n## 核心摘要\n\n每轮迭代在特征图上加上 1 个残差连接即可稳定收敛。\n'
        bad_analysis = '## 论文评价\n\n稳定有效。\n\n## 核心摘要\n\n我们在下 1 步中对比了基线模型。\n'
        good_issue = publish_common.validate_manual_reader_quality(good_analysis)
        bad_issue = publish_common.validate_manual_reader_quality(bad_analysis)
        self.assertFalse(good_issue and '数值排版或固定词损坏' in good_issue,
                         f'Unexpected typography issue for 加上 1 个: {good_issue}')
        self.assertIsNotNone(bad_issue)
        self.assertIn('数值排版或固定词损坏: 下 1 步', bad_issue)

        # 2) CommonMark backtick info-string rule: ```foo`bar is NOT a fenced code block
        md = '```foo`bar\n| Model | WER |\n|---|---|\n| Ours | 2.1 |\n'
        tables = publish_common.extract_markdown_tables(md)
        self.assertEqual(len(tables), 1, '反引号 info-string 不是合法围栏，不应隐藏后续表格')

        # 3) parse_publish_sse_response raises when response.* event seen without terminal event
        truncated_sse = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n\n'
        with self.assertRaises(publish_common.PublishSseTerminalEventMissingError):
            publish_common.parse_publish_sse_response(truncated_sse)
        self.assertIsNone(publish_common.parse_publish_sse_response('data: {"type":"ping"}\n\n'))

    # =========================================================================
    # Bug #17: non-frozen internal v2/v3 cleanup
    # =========================================================================
    def test_r5_17_internal_v2_v3_cleanup_keeps_frozen_contracts_intact(self):
        conf_render_src = (SCRIPTS / 'conference-page-render.py').read_text(encoding='utf-8')
        self.assertIn('（布局增强抽取）', conf_render_src)
        self.assertNotIn('（v2 增强抽取）', conf_render_src)

        self.assertTrue(hasattr(pae, '_GEOMETRIC_GUARDS_ENABLED'))
        self.assertFalse(pae._GEOMETRIC_GUARDS_ENABLED)

        self.assertTrue(hasattr(reader_inline_svg, '_DETERMINISTIC_CHROMIUM_ARGS'))
        self.assertEqual(reader_inline_svg.CONTRACT, 'reader-official-inline-svg-pixels-v2')
        replay_src = (SCRIPTS / 'reader_inline_svg_pixel_replay.py').read_text(encoding='utf-8')
        self.assertIn('PIXEL_REPLAY_CONTRACT', replay_src)
        self.assertNotIn('V2_CONTRACT', replay_src)

        pub_blog_src = (SCRIPTS / 'publish-to-blog.py').read_text(encoding='utf-8')
        self.assertNotIn('API Reader v3 的论文图未按', pub_blog_src)
        self.assertIn('API Reader 的论文图未按', pub_blog_src)


if __name__ == '__main__':
    unittest.main()

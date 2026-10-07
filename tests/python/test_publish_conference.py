import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'publish-conference.py'
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location('publish_conference_tested', SCRIPT)
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class FakeReviewer:
    def __init__(self):
        self.calls = self.image_calls = 0
        self.passed = self.image_passed = True
        self.protocol = 'protocol-1'

    def review_protocol_fingerprint(self):
        return self.protocol

    def split_review_content(self, content, limit):
        return [content]

    def get_blog_review_chunk_chars(self):
        return 12000

    def _llm_review_post_chunk(self, content, *args, **kwargs):
        assert kwargs['required'] is True
        self.calls += 1
        return self.passed, [], content

    def parse_markdown_images(self, content):
        return M.CONFERENCE_IMAGE_RE.findall(content)

    def multimodal_review_images(self, *args, **kwargs):
        assert kwargs['required'] is True
        self.image_calls += 1
        return self.image_passed, []

    def count_blocking_review_issues(self, issues):
        return sum(i.get('severity') == 'error' for i in issues)


class ConferencePublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.patch = mock.patch.object(M, 'PUBLICATION_ROOT', self.root / 'receipts')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.repo = self.make_repo('blog')
        self.base = M.remote_snapshot(self.repo)

    def command(self, *args):
        return subprocess.run(['git', *map(str, args)], check=True,
                              capture_output=True, text=True).stdout.strip()

    def make_repo(self, name):
        remote = self.root / f'{name}.git'
        repo = self.root / name
        self.command('init', '--bare', remote)
        self.command('init', '-b', 'main', repo)
        self.command('-C', repo, 'config', 'user.email', 'test@example.invalid')
        self.command('-C', repo, 'config', 'user.name', 'Offline Test')
        self.command('-C', repo, 'config', 'commit.gpgsign', 'false')
        (repo / 'README').write_text('base')
        self.command('-C', repo, 'add', 'README')
        self.command('-C', repo, 'commit', '-m', 'base')
        self.command('-C', repo, 'remote', 'add', 'origin', remote)
        self.command('-C', repo, 'push', 'origin', 'HEAD:main')
        return repo

    def record(self, path='content/posts/test.md', data='---\ntitle: test\n---\n正文\n'.encode(), repo=None):
        repo = repo or self.repo
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {'path': path, 'sourceSha256': M.sha_bytes(data), 'kind': 'paper'}

    def publish(self, records):
        return M.commit_exact_delta(self.repo, records, self.base['head'], self.base['remoteMain'],
                                    self.base['remoteIdentitySha256'], '离线会议发布测试')

    def test_stale_index_new_worktree_rejected(self):
        r = self.record(data=b'old staged bytes')
        self.command('-C', self.repo, 'add', r['path'])
        r = self.record(data=b'new reviewed bytes')
        with self.assertRaisesRegex(M.ConferencePublicationError, 'blob SHA'):
            self.publish([r])
        self.assertEqual(M.remote_snapshot(self.repo)['head'], self.base['head'])

    def test_split_fetch_push_remote_resume_checks_actual_destination(self):
        fetch_remote = self.root / 'blog.git'
        push_remote = self.root / 'destination.git'
        self.command('clone', '--bare', fetch_remote, push_remote)
        self.command('-C', self.repo, 'remote', 'set-url', '--push', 'origin', push_remote)
        self.base = M.remote_snapshot(self.repo)
        self.assertEqual(self.base['remoteUrl'], str(push_remote))
        self.assertEqual(self.base['remoteIdentitySha256'], M.sha_bytes(str(push_remote).encode()))
        record = self.record()
        self.command('-C', self.repo, 'add', record['path'])
        self.command('-C', self.repo, 'commit', '-m', 'offline candidate')
        candidate = self.command('-C', self.repo, 'rev-parse', 'HEAD')
        # 抓取侧已经有候选提交，但真正的推送目标
        # 还停在保存的基线：恢复流程不能因此误以为不用推。
        self.command('-C', self.repo, 'push', fetch_remote, 'HEAD:main')
        snapshot = M.remote_snapshot(self.repo)
        self.assertEqual(snapshot['remoteMain'], self.base['head'])
        result = self.publish([record])
        self.assertEqual(result['commit'], candidate)
        self.assertEqual(self.command('--git-dir', push_remote, 'rev-parse', 'main'), candidate)
        self.assertEqual(result['snapshot']['remoteMain'], candidate)
        self.assertEqual(self.publish([record])['commit'], candidate)

    def test_multiple_push_urls_rejected_before_remote_query_or_write(self):
        second = self.root / 'second.git'
        self.command('clone', '--bare', self.root / 'blog.git', second)
        for target in (self.root / 'blog.git', second):
            self.command('-C', self.repo, 'config', '--add', 'remote.origin.pushurl', target)
        record = self.record()
        with mock.patch.object(M, 'git', wraps=M.git) as calls:
            with self.assertRaisesRegex(M.ConferencePublicationError, '只有一个 push URL'):
                self.publish([record])
        self.assertFalse(any(call.args[1] in ('ls-remote', 'add', 'commit', 'push')
                             for call in calls.call_args_list))
        self.assertEqual(self.command('-C', self.repo, 'rev-parse', 'HEAD'), self.base['head'])
        for target in (self.root / 'blog.git', second):
            self.assertEqual(self.command('--git-dir', target, 'rev-parse', 'main'), self.base['head'])

    def test_commit_then_push_failure_resume_and_repeat(self):
        r = self.record()
        original = M.git

        def fail_push(repo, *args, **kwargs):
            if args[0] == 'push':
                raise M.ConferencePublicationError('offline push failure')
            return original(repo, *args, **kwargs)

        with mock.patch.object(M, 'git', side_effect=fail_push):
            with self.assertRaisesRegex(M.ConferencePublicationError, 'offline push'):
                self.publish([r])
        committed = M.remote_snapshot(self.repo)['head']
        self.assertNotEqual(committed, self.base['head'])
        self.assertEqual(M.remote_snapshot(self.repo)['remoteMain'], self.base['head'])
        result = self.publish([r])
        self.assertEqual(result['commit'], committed)
        self.assertEqual(self.publish([r])['commit'], committed)

    def test_commit_blob_corruption_is_rejected(self):
        r = self.record()
        self.command('-C', self.repo, 'add', r['path'])
        self.command('-C', self.repo, 'commit', '-m', 'candidate')
        self.record(data=b'wrong committed bytes')
        self.command('-C', self.repo, 'add', r['path'])
        self.command('-C', self.repo, 'commit', '--amend', '--no-edit')
        self.record(data='---\ntitle: test\n---\n正文\n'.encode())
        with self.assertRaisesRegex(M.ConferencePublicationError, 'blob SHA'):
            self.publish([r])

    def test_unrelated_commit_or_parent_rejected(self):
        r = self.record()
        self.command('-C', self.repo, 'add', r['path'])
        self.command('-C', self.repo, 'commit', '-m', 'first')
        self.command('-C', self.repo, 'commit', '--allow-empty', '-m', 'unrelated')
        with self.assertRaisesRegex(M.ConferencePublicationError, 'parent'):
            self.publish([r])

    def test_final_commit_checked_after_commit_hook_changes_bytes(self):
        r = self.record()
        original = M.git

        def corrupt_commit(repo, *args, **kwargs):
            result = original(repo, *args, **kwargs)
            if args[0] == 'commit':
                (repo / r['path']).write_bytes(b'changed by hook')
                original(repo, 'add', r['path'])
                original(repo, 'commit', '--amend', '--no-edit')
            return result

        with mock.patch.object(M, 'git', side_effect=corrupt_commit):
            with self.assertRaisesRegex(M.ConferencePublicationError, 'blob SHA'):
                self.publish([r])
        self.assertEqual(M.remote_snapshot(self.repo)['remoteMain'], self.base['head'])

    def test_images_binary_index_and_zero_delta(self):
        path = 'icassp-2026/abcdef123456/figure-1.png'
        self.record(path, b'\x89PNG\r\n\xffold')
        self.command('-C', self.repo, 'add', path)
        r = self.record(path, b'\x89PNG\r\n\xffnew')
        with self.assertRaisesRegex(M.ConferencePublicationError, 'blob SHA'):
            M.publish_image_delta(self.repo, [r], 'icassp-2026')
        self.command('-C', self.repo, 'add', path)
        result = M.publish_image_delta(self.repo, [r], 'icassp-2026')
        again = M.publish_image_delta(self.repo, [r], 'icassp-2026')
        self.assertEqual(result['commit'], again['commit'])
        self.assertEqual(again['deltaPaths'], [])
        r2 = self.record('icassp-2026/abcdef123456/figure-2.png', b'\x89PNG\xff2')
        added = M.publish_image_delta(self.repo, [r, r2], 'icassp-2026')
        self.assertEqual(added['deltaPaths'], [r2['path']])

    def test_image_commit_failure_recovers_journal(self):
        r = self.record('icassp-2026/abcdef123456/figure-1.png', b'\x89PNG\xff')
        original = M.git
        def fail(repo, *args, **kwargs):
            if args[0] == 'push':
                raise M.ConferencePublicationError('offline')
            return original(repo, *args, **kwargs)
        with mock.patch.object(M, 'git', side_effect=fail):
            with self.assertRaisesRegex(M.ConferencePublicationError, 'offline'):
                M.publish_image_delta(self.repo, [r], 'icassp-2026')
        commit = M.remote_snapshot(self.repo)['head']
        self.assertEqual(M.publish_image_delta(self.repo, [r], 'icassp-2026')['commit'], commit)

    def test_review_semantic_failure_never_becomes_hugo_only_pass(self):
        r = self.record()
        reviewer = FakeReviewer()
        reviewer.passed = False
        generation = {'files': [r]}
        with mock.patch.object(M, 'blog_repo', return_value=self.repo), \
                mock.patch.object(M, 'image_repo', return_value=self.repo), \
                mock.patch.object(M, 'validate_generation', return_value=(generation, {}, {})), \
                mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.object(M, 'run_hugo', return_value={'status': 'passed'}) as hugo, \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            with self.assertRaisesRegex(M.ConferencePublicationError, '语义 review'):
                M.review('icassp-2026', 'f4e4a4e4-a4e4-44e4-a4e4-a4e4a4e4a4e4')
            hugo.assert_not_called()
        self.assertFalse(list((self.root / 'receipts').rglob('review.json')))

    def test_review_path_byte_cache_survives_protocol_change(self):
        r = self.record(data='---\ntitle: test\n---\n正文\n![图](https://example.invalid/a.png)\n'.encode())
        reviewer = FakeReviewer()
        with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            M.review_pages(self.repo, [r])
            reviewer.protocol = 'protocol-2'
            result = M.review_pages(self.repo, [r])
            self.assertEqual(result['protocol'], M.content_review_protocol(reviewer))
            self.assertEqual((reviewer.calls, reviewer.image_calls), (1, 1))
            r = self.record(data='---\ntitle: changed\n---\n新正文\n'.encode())
            M.review_pages(self.repo, [r])
            self.assertEqual(reviewer.calls, 2)

    def test_multimodal_failure_no_pass_cached(self):
        r = self.record(data=b'---\ntitle: test\n---\n![figure](https://example.invalid/a.png)\n')
        reviewer = FakeReviewer()
        reviewer.image_passed = False
        with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            with self.assertRaisesRegex(M.ConferencePublicationError, '多模态'):
                M.review_pages(self.repo, [r])
            reviewer.image_passed = True
            M.review_pages(self.repo, [r])
            self.assertEqual(reviewer.image_calls, 2)

    def test_failed_image_findings_persist_exactly_without_editing_or_pass_cache(self):
        r = self.record(data=b'---\ntitle: test\n---\n![figure](https://example.invalid/a.png)\n')
        original = (self.repo / r['path']).read_bytes()
        findings = [{'severity': 'error', 'description': 'Figure 5 crop includes Figure 6',
                     'figureIndex': 1}, {'severity': 'warning', 'description': 'Small labels'}]
        reviewer = FakeReviewer()
        with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.object(reviewer, 'multimodal_review_images', return_value=(False, findings)), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            for _ in range(2):
                with self.assertRaisesRegex(M.ConferencePublicationError, '失败原因记录'):
                    M.review_pages(self.repo, [r])
        files = list((M.PUBLICATION_ROOT / 'page-review-failures').glob('*.json'))
        self.assertEqual(len(files), 1)
        failure = json.loads(files[0].read_text())
        signature = failure.pop('failureSha256')
        self.assertEqual(signature, M.stable(failure))
        self.assertEqual(files[0].name, f'{signature}.json')
        self.assertEqual(failure['issues'], findings)
        self.assertEqual((failure['path'], failure['sha256'], failure['stage'],
                          failure['imageCount'], failure['passed']),
                         (r['path'], r['sourceSha256'], 'image', 1, False))
        self.assertEqual((self.repo / r['path']).read_bytes(), original)
        self.assertFalse(list((M.PUBLICATION_ROOT / 'page-review-passes').glob('*.json')))
        self.assertEqual(self.command('-C', self.repo, 'status', '--porcelain'), '?? content/')

    def test_text_suggested_change_records_identity_not_replacement_or_next_page(self):
        r = self.record()
        next_page = self.record('content/posts/next.md')
        reviewer = FakeReviewer()
        findings = [{'severity': 'warning', 'description': 'Correct the quoted number'}]
        proposed = 'PRIVATE-PROPOSED-REPLACEMENT'
        with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.object(reviewer, '_llm_review_post_chunk',
                                  return_value=(True, findings, proposed)) as text, \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            with self.assertRaisesRegex(M.ConferencePublicationError, '正文语义'):
                M.review_pages(self.repo, [r, next_page], workers=1)
        self.assertEqual(text.call_count, 1)
        failure_file, = (M.PUBLICATION_ROOT / 'page-review-failures').glob('*.json')
        failure = json.loads(failure_file.read_text())
        self.assertEqual(failure['issues'], findings)
        self.assertEqual((failure['stage'], failure['chunkIndex'], failure['chunkCount'],
                          failure['proposedChanged']), ('text', 1, 1, True))
        self.assertNotIn(proposed, failure_file.read_text())
        self.assertEqual(reviewer.image_calls, 0)
        self.assertFalse(list((M.PUBLICATION_ROOT / 'page-review-passes').glob('*.json')))

    def test_failed_findings_never_reused_as_success_or_erased_after_pass(self):
        r = self.record()
        reviewer = FakeReviewer()
        reviewer.passed = False
        with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            with self.assertRaises(M.ConferencePublicationError):
                M.review_pages(self.repo, [r])
            failure_file, = (M.PUBLICATION_ROOT / 'page-review-failures').glob('*.json')
            failed_bytes = failure_file.read_bytes()
            reviewer.passed = True
            self.assertEqual(M.review_pages(self.repo, [r])['status'], 'passed')
            self.assertEqual(reviewer.calls, 2)
            self.assertEqual(failure_file.read_bytes(), failed_bytes)

    def test_run_error_identity_propagates_without_fake_content_failure(self):
        r = self.record()
        reviewer = FakeReviewer()
        error = RuntimeError('offline transport failure')
        with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.object(reviewer, '_llm_review_post_chunk', side_effect=error), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            with self.assertRaises(RuntimeError) as caught:
                M.review_pages(self.repo, [r])
        self.assertIs(caught.exception, error)
        self.assertFalse((M.PUBLICATION_ROOT / 'page-review-failures').exists())

    def test_real_reviewers_propagate_run_account_errors_without_next_page_or_fallback(self):
        from llm_account_pool import LlmAccountAuthError, LlmAccountPoolExhaustedError
        # 本用例断言严格的逐页时序（text 错误→零 image 调用 / image 错误→恰一次）——
        # 固定顺序执行；生产默认 PD_BLOG_REVIEW_CONCURRENCY=5 并行（顺序语义不变，
        # 只是页间并发），其余用例不受影响。
        os.environ['PD_BLOG_REVIEW_CONCURRENCY'] = '1'
        # 跑真实的共用文本/图片审查器，只模拟 API
        # 边界和图片字节。即使配了备用账号，这里也不该尝试切换。
        reviewer = M.load_publish_to_blog()
        for stage in ('text', 'image'):
            for error_type in (LlmAccountAuthError, LlmAccountPoolExhaustedError):
                with self.subTest(stage=stage, error=error_type.__name__):
                    error = (error_type() if error_type is LlmAccountAuthError
                             else error_type('all test accounts unavailable'))
                    name = f'{stage}-{error.code}'
                    first = self.record(f'content/posts/{name}-first.md',
                        b'---\ntitle: first\n---\n![figure](https://example.invalid/a.png)\n')
                    second = self.record(f'content/posts/{name}-second.md')
                    responses = [error] if stage == 'text' else ['{"passed":true,"issues":[]}', error]
                    with mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                            mock.patch.object(M, 'content_review_protocol', return_value='offline'), \
                            mock.patch.object(reviewer, 'call_publish_llm_api', side_effect=responses) as api, \
                            mock.patch.object(reviewer, '_load_review_image', return_value={'media_type': 'image/png', 'data': 'offline'}) as pixels, \
                            mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock',
                                                       'PAPER_ANALYZER_SECONDARY_MODEL': 'must-not-fallback'}):
                        with self.assertRaises(error_type) as raised:
                            M.review_pages(self.repo, [first, second], workers=1)
                        self.assertIs(raised.exception, error)
                        self.assertEqual(raised.exception.scope, 'run')
                        self.assertEqual(api.call_count, 1 if stage == 'text' else 2)
                        self.assertTrue(all(not call.kwargs['use_secondary'] for call in api.call_args_list))
                        self.assertEqual(pixels.call_count, 0 if stage == 'text' else 1)
                    for record in (first, second):
                        key = M.stable({'path': record['path'], 'sha256': record['sourceSha256']})
                        self.assertFalse((M.PUBLICATION_ROOT / 'page-review-passes' / f'{key}.json').exists())

    def test_full_review_push_resume_repeat_and_generate_after_publication(self):
        r = self.record()
        images = self.make_repo('images')
        image_snapshot = M.remote_snapshot(images)
        process_id = 'f4e4a4e4-a4e4-44e4-a4e4-a4e4a4e4a4e4'
        conference_id = 'icassp-2026'
        body = {'contract': 'conference-blog-generation-v1', 'version': 1,
                'conferenceId': conference_id, 'processId': process_id,
                'baseHead': self.base['head'], 'remoteMainBefore': self.base['remoteMain'],
                'remoteIdentitySha256': self.base['remoteIdentitySha256'],
                'files': [r], 'imageFiles': [],
                'imageBaseHead': image_snapshot['head'],
                'imageRemoteMainBefore': image_snapshot['remoteMain'],
                'imageRemoteIdentitySha256': image_snapshot['remoteIdentitySha256'],
                'imagePublicationCommit': image_snapshot['head']}
        generation = {**body, 'generationSha256': M.stable(body)}
        directory = M.publication_dir(conference_id, process_id)
        M.write_exact(directory / 'generation.json', M.json_bytes(generation))
        reviewer = FakeReviewer()
        original = M.git
        def fail_push(repo, *args, **kwargs):
            if args[0] == 'push':
                raise M.ConferencePublicationError('offline')
            return original(repo, *args, **kwargs)
        with mock.patch.object(M, 'blog_repo', return_value=self.repo), \
                mock.patch.object(M, 'image_repo', return_value=images), \
                mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.object(M, 'run_hugo', return_value={'status': 'passed'}) as hugo, \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            M.review(conference_id, process_id)
            reviewer.protocol = 'new-gate'
            M.review(conference_id, process_id)
            self.assertEqual(reviewer.calls, 1)
            self.assertEqual(hugo.call_count, 2)
            with mock.patch.object(M, 'git', side_effect=fail_push):
                with self.assertRaisesRegex(M.ConferencePublicationError, 'offline'):
                    M.push(conference_id, process_id)
            committed = M.remote_snapshot(self.repo)['head']
            M.push(conference_id, process_id)
            M.push(conference_id, process_id)
            self.assertEqual(M.remote_snapshot(self.repo)['remoteMain'], committed)
            with mock.patch.object(M, 'process_bundle', return_value={'files': [r], 'imageFiles': []}):
                M.generate(conference_id, process_id)
            self.assertEqual(M.load_generation(conference_id, process_id), generation)

    def rebase_fixture(self, existing=False):
        images = self.make_repo('rebase-images')
        if existing:
            old = self.record(data=b'old conference bytes')
            self.command('-C', self.repo, 'add', old['path'])
            self.command('-C', self.repo, 'commit', '-m', 'previous conference page')
            self.command('-C', self.repo, 'push', 'origin', 'HEAD:main')
        base = M.remote_snapshot(self.repo)
        image_base = M.remote_snapshot(images)
        record = self.record()
        image = self.record('icassp-2026/abcdef123456/figure-1.png', b'PNG sealed bytes', images)
        image['kind'] = 'asset'
        previous = {'baseHead': base['head'], 'remoteMainBefore': base['remoteMain'],
                    'remoteIdentitySha256': base['remoteIdentitySha256'], 'files': [record],
                    'imageBaseHead': image_base['head'], 'imageRemoteMainBefore': image_base['remoteMain'],
                    'imageRemoteIdentitySha256': image_base['remoteIdentitySha256'], 'imageFiles': [image]}
        return images, previous

    def advance_main(self, repo, path='assets/js/ui.js', data=b'new UI'):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.command('-C', repo, 'add', '--', path)
        self.command('-C', repo, 'commit', '-m', 'unrelated main advance')
        self.command('-C', repo, 'push', 'origin', 'HEAD:main')

    def check_rebase(self, images, previous):
        return M.validate_unpublished_rebase(self.repo, images, previous,
                                            M.remote_snapshot(self.repo), M.remote_snapshot(images))

    def test_unpublished_targets_survive_ui_and_daily_main_advances(self):
        images, previous = self.rebase_fixture(existing=True)
        self.advance_main(self.repo)
        self.advance_main(self.repo, 'content/posts/daily.md', b'other daily content')
        self.advance_main(images, 'other-conference/other.png', b'unrelated image')
        self.check_rebase(images, previous)
        self.assertFalse(M.blob_matches(self.repo, 'HEAD', previous['files'][0]))
        # 恢复检查通过，并不代表旧的基线就可以用来推送。
        with self.assertRaises(M.ConferencePublicationError):
            M.transaction_snapshot(self.repo, previous['baseHead'],
                                   previous['remoteIdentitySha256'], previous['files'])

    def test_already_published_targets_survive_unrelated_main_advance(self):
        images, previous = self.rebase_fixture()
        for repo, records in ((self.repo, previous['files']), (images, previous['imageFiles'])):
            self.command('-C', repo, 'add', records[0]['path'])
            self.command('-C', repo, 'commit', '-m', 'publish exact conference target')
            self.command('-C', repo, 'push', 'origin', 'HEAD:main')
            self.advance_main(repo)
        self.check_rebase(images, previous)

    def test_new_rebase_requires_generate_then_current_hugo_review_and_exact_delta(self):
        images, previous = self.rebase_fixture()
        (self.repo / 'hugo.toml').write_text('title = "Offline Hugo inputs"\n')
        (self.repo / 'layouts').mkdir()
        conference_id = 'icassp-2026'
        process_id = 'f4e4a4e4-a4e4-44e4-a4e4-a4e4a4e4a4e4'
        for record in previous['files'] + previous['imageFiles']:
            source = self.root / ('page-stage.md' if record['kind'] == 'paper' else 'image-stage.png')
            source.write_bytes(M.target_bytes(self.repo if record['kind'] == 'paper' else images, record))
            record['sourcePath'] = str(source)
        body = {**previous, 'contract': 'conference-blog-generation-v1', 'version': 2,
                'conferenceId': conference_id, 'processId': process_id, 'remoteName': 'origin',
                'implementationSha256': M.gate_fingerprint(), 'completionReceiptSha256': 'a' * 64}
        old = {**body, 'generationSha256': M.stable(body)}
        directory = M.publication_dir(conference_id, process_id)
        M.write_exact(directory / 'generation.json', M.json_bytes(old))
        reviewer = FakeReviewer()
        gate = {'status': 'passed', 'contract': M.GATE_CONTRACT,
                'implementationSha256': M.gate_fingerprint()}
        with mock.patch.object(M, 'blog_repo', return_value=self.repo), \
                mock.patch.object(M, 'image_repo', return_value=images), \
                mock.patch.object(M, 'process_bundle', return_value={
                    'files': previous['files'], 'imageFiles': previous['imageFiles'],
                    'completion': {'receiptSha256': 'a' * 64}}), \
                mock.patch.object(M, 'load_publish_to_blog', return_value=reviewer), \
                mock.patch.object(M, 'run_hugo', return_value=gate) as hugo, \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-mock'}):
            M.review(conference_id, process_id)
            old_review = M.load_review(conference_id, process_id)
            self.advance_main(self.repo)
            with self.assertRaises(M.ConferencePublicationError):
                M.validate_generation(conference_id, process_id, self.repo, images)
            M.generate(conference_id, process_id)
            new = M.load_generation(conference_id, process_id)
            self.assertEqual(new['baseHead'], M.remote_snapshot(self.repo)['head'])
            self.assertNotEqual(new['generationSha256'], old['generationSha256'])
            self.assertEqual(M.load_review(conference_id, process_id), old_review)
            with self.assertRaises(M.ConferencePublicationError):
                M.validate_review(new, old_review)
            M.review(conference_id, process_id)
            self.assertEqual(hugo.call_count, 2)
            self.assertEqual(reviewer.calls, 1)  # 页面 SHA 没变，沿用上一次的语义证据，所以只调用一次
            self.assertEqual(hugo.call_args.args[1]['baseHead'], new['baseHead'])
            M.validate_review(new, M.load_review(conference_id, process_id))
            commit = M.commit_delta(self.repo, new['files'], new['baseHead'],
                                    new['remoteIdentitySha256'], '正常重签后发布')
            M.push_delta(self.repo, new['files'], new['baseHead'], new['remoteIdentitySha256'], commit)
            self.assertEqual(M.changed_paths(self.repo, new['baseHead'], commit), {'content/posts/test.md'})

    def test_target_conflict_and_worktree_drift_are_rejected(self):
        images, previous = self.rebase_fixture()
        self.advance_main(self.repo, previous['files'][0]['path'], b'other published content')
        (self.repo / previous['files'][0]['path']).write_bytes(b'---\ntitle: test\n---\n\xe6\xad\xa3\xe6\x96\x87\n')
        with self.assertRaisesRegex(M.ConferencePublicationError, '迁移期间发生字节变化'):
            self.check_rebase(images, previous)

    def test_untouched_target_worktree_drift_and_mode_are_rejected(self):
        images, previous = self.rebase_fixture()
        self.advance_main(self.repo)
        path = self.repo / previous['files'][0]['path']
        saved = path.read_bytes()
        path.write_bytes(b'local drift')
        with self.assertRaisesRegex(M.ConferencePublicationError, '工作区目标字节漂移'):
            self.check_rebase(images, previous)
        path.write_bytes(saved)
        path.chmod(0o755)
        with self.assertRaisesRegex(M.ConferencePublicationError, '工作区目标模式漂移'):
            self.check_rebase(images, previous)

    def test_changed_then_restored_old_target_is_not_untouched(self):
        images, previous = self.rebase_fixture(existing=True)
        self.advance_main(self.repo, previous['files'][0]['path'], b'conflict')
        self.advance_main(self.repo, previous['files'][0]['path'], b'old conference bytes')
        (self.repo / previous['files'][0]['path']).write_bytes(b'---\ntitle: test\n---\n\xe6\xad\xa3\xe6\x96\x87\n')
        self.assertNotIn(previous['files'][0]['path'], M.changed_paths(self.repo, previous['baseHead'], 'HEAD'))
        with self.assertRaisesRegex(M.ConferencePublicationError, '迁移期间发生字节变化'):
            self.check_rebase(images, previous)

    def test_intervening_executable_mode_even_if_restored_is_rejected(self):
        images, previous = self.rebase_fixture()
        path = self.repo / previous['files'][0]['path']
        for mode in (0o755, 0o644):
            path.chmod(mode)
            self.command('-C', self.repo, 'add', previous['files'][0]['path'])
            self.command('-C', self.repo, 'commit', '-m', 'mode transition')
            self.command('-C', self.repo, 'push', 'origin', 'HEAD:main')
        with self.assertRaisesRegex(M.ConferencePublicationError, '迁移期间发生模式变化'):
            self.check_rebase(images, previous)

    def test_remote_identity_unknown_base_forcepush_and_unsynced_head_rejected(self):
        images, previous = self.rebase_fixture()
        self.advance_main(self.repo)
        for override, message in (({'remoteIdentitySha256': 'b' * 64}, 'identity'),
                                  ({'baseHead': 'b' * 40, 'remoteMainBefore': 'b' * 40}, '不存在'),
                                  ({'baseHead': 'not-an-oid'}, '非法'),
                                  ({'remoteMainBefore': 'b' * 40}, '原远端闭合')):
            with self.assertRaisesRegex(M.ConferencePublicationError, message):
                self.check_rebase(images, {**previous, **override})
        self.command('-C', self.repo, 'commit', '--allow-empty', '-m', 'local only')
        with self.assertRaisesRegex(M.ConferencePublicationError, '未同步'):
            self.check_rebase(images, previous)
        # 隔离的裸远端里如果真有替换过的历史，必须拒绝。
        self.command('-C', self.repo, 'checkout', '--orphan', 'replacement')
        self.command('-C', self.repo, 'commit', '-m', 'unrelated root')
        self.command('-C', self.repo, 'branch', '-M', 'main')
        self.command('-C', self.repo, 'push', '--force', 'origin', 'HEAD:main')
        with self.assertRaisesRegex(M.ConferencePublicationError, '不是当前 HEAD 祖先'):
            self.check_rebase(images, previous)

    def test_duplicate_or_unsafe_paths_and_nonregular_targets_rejected(self):
        images, previous = self.rebase_fixture()
        self.advance_main(self.repo)
        with self.assertRaisesRegex(M.ConferencePublicationError, '重复'):
            self.check_rebase(images, {**previous, 'files': previous['files'] * 2})
        with self.assertRaisesRegex(M.ConferencePublicationError, '安全'):
            self.check_rebase(images, {**previous, 'files': [{**previous['files'][0], 'path': '../escape.md'}]})
        path = self.repo / previous['files'][0]['path']
        saved = self.root / 'saved.md'
        path.rename(saved)
        path.symlink_to(saved)
        with self.assertRaisesRegex(M.ConferencePublicationError, '符号链接'):
            self.check_rebase(images, previous)
        path.unlink()
        os.link(saved, path)
        with self.assertRaisesRegex(M.ConferencePublicationError, '单链接'):
            self.check_rebase(images, previous)

    def test_image_target_worktree_drift_and_published_conflict_rejected(self):
        images, previous = self.rebase_fixture()
        self.advance_main(self.repo)
        target = images / previous['imageFiles'][0]['path']
        saved = target.read_bytes()
        target.write_bytes(b'wrong image working bytes')
        with self.assertRaisesRegex(M.ConferencePublicationError, '图片工作区目标字节漂移'):
            self.check_rebase(images, previous)
        self.advance_main(images, previous['imageFiles'][0]['path'], b'wrong published image')
        target.write_bytes(saved)
        with self.assertRaisesRegex(M.ConferencePublicationError, '图片目标在基线迁移期间发生字节变化'):
            self.check_rebase(images, previous)

    def test_merge_commit_target_conflict_is_rejected(self):
        images, previous = self.rebase_fixture(existing=True)
        self.command('-C', self.repo, 'checkout', '-b', 'other-author')
        (self.repo / previous['files'][0]['path']).write_bytes(b'conflicting branch page')
        self.command('-C', self.repo, 'add', previous['files'][0]['path'])
        self.command('-C', self.repo, 'commit', '-m', 'other branch changes target')
        self.command('-C', self.repo, 'checkout', 'main')
        self.advance_main(self.repo)
        self.command('-C', self.repo, 'merge', '--no-ff', 'other-author', '-m', 'merge other branch')
        self.command('-C', self.repo, 'push', 'origin', 'HEAD:main')
        self.record()
        with self.assertRaisesRegex(M.ConferencePublicationError, '迁移期间发生字节变化'):
            self.check_rebase(images, previous)


class FindManifestIndexTest(unittest.TestCase):
    """find_manifest 的进程内索引：唯一命中、未命中、重复命中、非法 SHA。"""

    SHA_A = 'a' * 64
    SHA_B = 'b' * 64

    def _root(self):
        root = Path(tempfile.mkdtemp(prefix='find-manifest-'))
        (root / 'one').mkdir()
        (root / 'two').mkdir()
        (root / 'one' / 'manifest.json').write_text(
            json.dumps({'manifestSha256': self.SHA_A}), encoding='utf-8')
        (root / 'two' / 'manifest.json').write_text(
            json.dumps({'manifestSha256': self.SHA_B}), encoding='utf-8')
        return root

    def test_unique_match_returns_path_and_repeat_is_stable(self):
        root = self._root()
        first = M.find_manifest(root, self.SHA_A, 'probe')
        self.assertTrue(str(first).endswith(str(Path('one') / 'manifest.json')))
        second = M.find_manifest(root, self.SHA_B, 'probe')
        self.assertTrue(str(second).endswith(str(Path('two') / 'manifest.json')))
        # 索引建立后重复查询结果一致（O(1) 命中，不因重扫改写结论）
        self.assertEqual(M.find_manifest(root, self.SHA_A, 'probe'), first)

    def test_miss_raises_with_zero_matches(self):
        root = self._root()
        with self.assertRaises(Exception) as ctx:
            M.find_manifest(root, 'c' * 64, 'probe')
        self.assertIn('matches=0', str(ctx.exception))

    def test_duplicate_sha_raises_with_two_matches(self):
        root = self._root()
        (root / 'three').mkdir()
        (root / 'three' / 'manifest.json').write_text(
            json.dumps({'manifestSha256': self.SHA_A}), encoding='utf-8')
        with self.assertRaises(Exception) as ctx:
            M.find_manifest(root, self.SHA_A, 'probe')
        self.assertIn('matches=2', str(ctx.exception))

    def test_illegal_sha_rejected(self):
        root = self._root()
        with self.assertRaises(Exception):
            M.find_manifest(root, 'not-a-sha', 'probe')


if __name__ == '__main__':
    unittest.main()

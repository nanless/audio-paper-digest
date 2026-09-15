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
        # Fetch side already has the candidate, but the actual push destination
        # is still at the saved base: recovery must not falsely skip its push.
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

    def test_real_reviewers_propagate_run_account_errors_without_next_page_or_fallback(self):
        from llm_account_pool import LlmAccountAuthError, LlmAccountPoolExhaustedError
        # Exercise the real shared text/image reviewers, mocking only the API
        # boundary and image bytes. A configured secondary must not be tried.
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
                            M.review_pages(self.repo, [first, second])
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


if __name__ == '__main__':
    unittest.main()

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import conference_publication_gate as gate

spec = importlib.util.spec_from_file_location('conference_publisher_test', ROOT / 'scripts/publish-conference.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class GitPublicationTest(unittest.TestCase):
    def test_conference_html_gate_masks_only_literal_numeric_currency(self):
        self.assertEqual(
            gate.mask_rendered_currency_dollars('$32,000,000，高于$2,000。'),
            'CURRENCY_DOLLAR32,000,000，高于CURRENCY_DOLLAR2,000。',
        )
        for value in ('$5+2$', '$5x', '$5 + 2'):
            with self.subTest(value=value):
                self.assertIn('$', gate.mask_rendered_currency_dollars(value))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='conference-publication-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
                    'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
        self.blog = self.repository('blog')
        self.images = self.repository('images')
        self.base = self.git(self.blog, 'rev-parse', 'HEAD').strip()
        self.identity = publisher.remote_snapshot(self.blog)['remoteIdentitySha256']
        self.record = self.record_file(self.blog, 'content/posts/conference-test-paper.md', b'approved')

    def git(self, repo, *args):
        return subprocess.run(['git', '-C', str(repo), *args], env=self.env,
                              capture_output=True, text=True, check=True).stdout

    def repository(self, name):
        repo, remote = self.root / name, self.root / f'{name}.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], env=self.env, check=True, capture_output=True)
        subprocess.run(['git', 'init', '-b', 'main', str(repo)], env=self.env, check=True, capture_output=True)
        self.git(repo, 'config', 'user.name', 'Fixture')
        self.git(repo, 'config', 'user.email', 'fixture@example.invalid')
        (repo / 'README.md').write_text('baseline')
        self.git(repo, 'add', 'README.md')
        self.git(repo, 'commit', '-m', 'fixture baseline')
        self.git(repo, 'remote', 'add', 'origin', str(remote))
        self.git(repo, 'push', 'origin', 'HEAD:main')
        return repo

    def record_file(self, repo, path, data):
        file = repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        return {'path': path, 'sourceSha256': sha(data), 'size': len(data)}

    def commit(self, records=None):
        return publisher.commit_delta(self.blog, records or [self.record], self.base, self.identity, 'fixture publication')

    def test_index_old_bytes_are_rejected_even_when_worktree_is_approved(self):
        target = self.blog / self.record['path']
        target.write_bytes(b'unreviewed')
        self.git(self.blog, 'add', self.record['path'])
        target.write_bytes(b'approved')
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '实际 blob'):
            self.commit()
        self.assertEqual(self.git(self.blog, 'rev-parse', 'HEAD').strip(), self.base)

    def test_index_mode_and_unrelated_staged_file_rejected(self):
        self.git(self.blog, 'add', self.record['path'])
        self.git(self.blog, 'update-index', '--chmod=+x', self.record['path'])
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '实际 blob'):
            self.commit()
        self.git(self.blog, 'update-index', '--chmod=-x', self.record['path'])
        (self.blog / 'README.md').write_text('unrelated')
        self.git(self.blog, 'add', 'README.md')
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '非会议'):
            self.commit()

    def test_unrelated_ancestor_and_wrong_commit_bytes_are_rejected(self):
        (self.blog / 'README.md').write_text('unrelated')
        self.git(self.blog, 'add', 'README.md')
        self.git(self.blog, 'commit', '-m', 'unrelated')
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '精确 delta'):
            self.commit()
        self.assertEqual(publisher.remote_snapshot(self.blog)['remoteMain'], self.base)

    def test_same_path_wrong_commit_is_not_recovered(self):
        target = self.blog / self.record['path']
        target.write_bytes(b'wrong committed')
        self.git(self.blog, 'add', self.record['path'])
        self.git(self.blog, 'commit', '-m', 'wrong')
        target.write_bytes(b'approved')
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '实际 blob'):
            self.commit()

    def test_commit_and_push_are_idempotent_across_both_breakpoints(self):
        commit = self.commit()
        self.assertEqual(self.commit(), commit)  # crash after commit, before push
        publisher.push_delta(self.blog, [self.record], self.base, self.identity, commit)
        self.assertEqual(self.commit(), commit)  # crash after remote push
        publisher.push_delta(self.blog, [self.record], self.base, self.identity, commit)
        self.assertEqual(self.git(self.blog, 'rev-list', '--count', 'HEAD').strip(), '2')

    def test_remote_advance_is_rejected(self):
        commit = self.commit()
        self.git(self.blog, 'push', 'origin', 'HEAD:main')
        # A remote-only advancement cannot be mistaken for a publication retry.
        other = self.root / 'other'
        subprocess.run(['git', 'clone', '-b', 'main', str(self.root / 'blog.git'), str(other)],
                       env=self.env, capture_output=True, check=True)
        (other / 'outside.md').write_text('outside')
        self.git(other, 'add', 'outside.md')
        self.git(other, 'commit', '-m', 'other writer')
        self.git(other, 'push', 'origin', 'HEAD:main')
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '远端'):
            publisher.push_delta(self.blog, [self.record], self.base, self.identity, commit)

    def test_images_partial_existing_and_noop(self):
        old = self.record_file(self.images, 'test/aaaaaaaaaaaa/figure-1.png', b'existing')
        self.git(self.images, 'add', old['path'])
        self.git(self.images, 'commit', '-m', 'existing asset')
        self.git(self.images, 'push', 'origin', 'HEAD:main')
        snapshot = publisher.remote_snapshot(self.images)
        new = self.record_file(self.images, 'test/bbbbbbbbbbbb/figure-1.png', b'new')
        records = [old, new]
        args = (self.images, records, snapshot['head'], snapshot['remoteIdentitySha256'], 'images')
        commit = publisher.commit_delta(*args)
        self.assertEqual(publisher.changed_paths(self.images, snapshot['head'], commit), {new['path']})
        publisher.push_delta(self.images, records, snapshot['head'], snapshot['remoteIdentitySha256'], commit)
        self.assertEqual(publisher.commit_delta(*args), commit)
        # Fresh transaction with all files already published is a no-op.
        self.assertEqual(publisher.commit_delta(self.images, records, commit,
                         snapshot['remoteIdentitySha256'], 'noop'), commit)

    def test_export_ignores_dirty_and_untracked_files(self):
        (self.blog / 'README.md').write_text('dirty')
        self.record_file(self.blog, 'static/untracked.png', b'untracked')
        output = self.root / 'export'
        output.mkdir()
        publisher.export_baseline(self.blog, self.base, output)
        self.assertEqual((output / 'README.md').read_text(), 'baseline')
        self.assertFalse((output / 'static/untracked.png').exists())
        self.assertFalse((output / self.record['path']).exists())

    @unittest.skipUnless(shutil.which('hugo'), 'Hugo unavailable')
    def test_real_hugo_uses_frozen_template_and_checks_nested_content(self):
        config = self.blog / 'hugo.toml'
        config.write_text('baseURL = "https://example.com/"\n[markup.goldmark.renderer]\nunsafe = true\n')
        template = self.blog / 'layouts/_default/single.html'
        template.parent.mkdir(parents=True)
        template.write_text('<!DOCTYPE html><html><head><link rel="canonical" href="{{ .Permalink }}">'
                            '</head><body><div class="post-content">{{ .Content }}</div></body></html>')
        self.git(self.blog, 'add', 'hugo.toml', 'layouts')
        self.git(self.blog, 'commit', '-m', 'fixture Hugo')
        baseline = self.git(self.blog, 'rev-parse', 'HEAD').strip()
        # These uncommitted edits must never influence the rendered proof.
        template.write_text('{{ invalid_template_call }}')
        self.record_file(self.blog, 'content/unrelated.md', b'---\ninvalid: [\n---')
        body = b'---\ntitle: Test\ndate: 2020-01-01\n---\n<div><p>Nested intro</p></div>\n\n| A | B |\n| --- | --- |\n| 5ms | 8% |\n'
        record = self.record_file(self.blog, self.record['path'], body)
        result = publisher.run_hugo(self.blog, {'baseHead': baseline, 'files': [record], 'imageFiles': []})
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['pages'][0]['tableCount'], 1)
        self.assertEqual(result['pages'][0]['url'],
                         'https://example.com/posts/conference-test-paper/')
        self.assertEqual(template.read_text(), '{{ invalid_template_call }}')

    def test_receipt_atomic_write_failure_leaves_no_partial_final(self):
        filename = self.root / 'receipt.json'
        with mock.patch.object(publisher.os, 'fsync', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                publisher.write_exact(filename, b'{"complete":true}')
        self.assertFalse(filename.exists())
        publisher.write_exact(filename, b'{"complete":true}')
        self.assertEqual(filename.read_bytes(), b'{"complete":true}')
        self.assertFalse(publisher.write_exact(filename, b'{"complete":true}'))

    @unittest.skipUnless(shutil.which('hugo'), 'Hugo unavailable')
    def test_real_gitlink_theme_uses_parent_oid_not_dirty_submodule_head(self):
        theme = self.repository('theme')
        layout = theme / 'layouts/_default/single.html'
        layout.parent.mkdir(parents=True)
        layout.write_text('<html><head><link rel="canonical" href="{{ .Permalink }}"></head>'
                          '<body><div class="post-content">{{ .Content }}</div></body></html>')
        self.git(theme, 'add', 'layouts')
        self.git(theme, 'commit', '-m', 'fixed theme template')
        self.git(self.blog, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', 'main',
                 str(theme), 'themes/Fixture')
        (self.blog / 'hugo.toml').write_text('baseURL = "https://example.com/"\ntheme = "Fixture"\nenableGitInfo = true\n')
        self.git(self.blog, 'add', 'hugo.toml', '.gitmodules', 'themes/Fixture')
        self.git(self.blog, 'commit', '-m', 'pin theme gitlink')
        baseline = self.git(self.blog, 'rev-parse', 'HEAD').strip()
        submodule = self.blog / 'themes/Fixture'
        fixed_oid = self.git(submodule, 'rev-parse', 'HEAD').strip()
        theme_layout = submodule / 'layouts/_default/single.html'
        theme_layout.write_text('{{ broken_head_template }}')
        self.git(submodule, 'add', 'layouts')
        self.git(submodule, 'commit', '-m', 'local unpinned theme commit')
        theme_layout.write_text('{{ broken_dirty_template }}')
        record = self.record_file(self.blog, self.record['path'], b'---\ntitle: Test\ndate: 2020-01-01\n---\nApproved body')
        with mock.patch.object(publisher, 'git', wraps=publisher.git) as commands:
            result = publisher.run_hugo(self.blog, {'baseHead': baseline, 'files': [record], 'imageFiles': []})
        self.assertEqual(result['status'], 'passed')
        self.assertTrue(any(call.args[1:] == ('archive', '--format=tar', fixed_oid)
                            for call in commands.call_args_list))
        self.assertFalse(any(call.args[1] in {'fetch', 'checkout', 'submodule', 'pull'}
                             for call in commands.call_args_list))
        self.assertEqual(theme_layout.read_text(), '{{ broken_dirty_template }}')
        # A gitlink whose OID is absent locally must fail without auto-fetch.
        self.git(self.blog, 'update-index', '--cacheinfo', '160000,' + 'f' * 40 + ',themes/Fixture')
        self.git(self.blog, 'commit', '-m', 'unavailable gitlink fixture')
        missing_base = self.git(self.blog, 'rev-parse', 'HEAD').strip()
        output = self.root / 'missing-export'
        output.mkdir()
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '本地缺少固定提交'):
            publisher.export_baseline(self.blog, missing_base, output)

    def prepare_flow(self):
        self.cid, self.pid = 'test-2026', '11111111-1111-4111-8111-111111111111'
        source = self.root / 'source.md'
        source.write_bytes(b'approved')
        record = {**self.record, 'kind': 'paper', 'sourcePath': str(source)}
        image_source = self.root / 'figure.png'
        image_source.write_bytes(b'image bytes')
        asset = {'path': 'test-2026/aaaaaaaaaaaa/figure-1.png', 'sourceSha256': sha(b'image bytes'),
                 'sourcePath': str(image_source), 'size': 11}
        bundle = {'files': [record], 'imageFiles': [asset], 'completion': {'receiptSha256': 'a' * 64}}
        patches = [mock.patch.object(publisher, 'blog_repo', return_value=self.blog),
                   mock.patch.object(publisher, 'image_repo', return_value=self.images),
                   mock.patch.object(publisher, 'process_bundle', return_value=bundle),
                   mock.patch.object(publisher, 'PUBLICATION_ROOT', self.root / 'publications')]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        page = {'path': record['path'], 'sourceSha256': record['sourceSha256'],
                'url': 'https://example.com/posts/test/', 'formulaCount': 0, 'projectionSha256': 'p'}
        self.acceptance = {'status': 'passed', 'contract': gate.GATE_CONTRACT,
                           'checks': [{'url': page['url']}, {'url': publisher.IMAGE_BASE_URL + '/' + asset['path']}]}
        self.gate = {'status': 'passed', 'contract': gate.GATE_CONTRACT, 'pages': [page],
                     'implementationSha256': publisher.gate_fingerprint()}
        return record, asset

    def test_generate_repeated_never_pushes_then_failed_urls_remain_pending(self):
        self.prepare_flow()
        image_base = publisher.remote_snapshot(self.images)['head']
        with contextlib.redirect_stdout(io.StringIO()):
            publisher.generate(self.cid, self.pid)
            publisher.generate(self.cid, self.pid)
            self.assertEqual(publisher.remote_snapshot(self.images)['head'], image_base)
            with mock.patch.object(publisher, 'run_hugo', return_value=self.gate):
                publisher.review(self.cid, self.pid)
            with mock.patch.object(publisher, 'verify_publication_urls', side_effect=ValueError('not deployed')):
                with self.assertRaisesRegex(publisher.ConferencePublicationError, '实际 URL'):
                    publisher.push(self.cid, self.pid)
            state = publisher.status(self.cid, self.pid)
            self.assertFalse(state['complete'])
            self.assertEqual(state['layers']['remoteOid'], 'passed')
            self.assertEqual(state['layers']['onlineUrls'], 'pending')
            blog_commit = self.git(self.blog, 'rev-parse', 'HEAD')
            with mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance), \
                    mock.patch.object(publisher, 'commit_delta', side_effect=AssertionError('verify committed')), \
                    mock.patch.object(publisher, 'push_delta', side_effect=AssertionError('verify pushed')):
                state = publisher.verify(self.cid, self.pid)
            self.assertTrue(state['complete'])
            self.assertEqual(state['layers']['visualInspection'], 'not_performed')
            self.assertEqual(self.git(self.blog, 'rev-parse', 'HEAD'), blog_commit)
            publisher.push(self.cid, self.pid)
            self.assertTrue(publisher.status(self.cid, self.pid)['complete'])

    def test_unpublished_generation_rebases_over_unrelated_blog_commit(self):
        self.prepare_flow()
        with contextlib.redirect_stdout(io.StringIO()):
            publisher.generate(self.cid, self.pid)
        old = json.loads((publisher.publication_dir(self.cid, self.pid) / 'generation.json').read_text())
        self.git(self.blog, 'add', self.record['path'])
        self.git(self.blog, 'commit', '-m', 'conference publication already committed')
        self.git(self.blog, 'push', 'origin', 'HEAD:main')
        (self.blog / 'README.md').write_text('daily publish')
        self.git(self.blog, 'add', 'README.md')
        self.git(self.blog, 'commit', '-m', 'unrelated daily publish')
        self.git(self.blog, 'push', 'origin', 'HEAD:main')
        new_head = self.git(self.blog, 'rev-parse', 'HEAD').strip()
        with contextlib.redirect_stdout(io.StringIO()):
            publisher.generate(self.cid, self.pid)
        current = json.loads((publisher.publication_dir(self.cid, self.pid) / 'generation.json').read_text())
        self.assertEqual(current['baseHead'], new_head)
        self.assertNotEqual(current['generationSha256'], old['generationSha256'])
        self.assertTrue(list((publisher.publication_dir(self.cid, self.pid)).glob(
            'generation.superseded-*.json')))

    def test_flow_recovery_after_image_push_and_after_blog_commit(self):
        self.prepare_flow()
        original_push = publisher.push_delta
        with contextlib.redirect_stdout(io.StringIO()):
            publisher.generate(self.cid, self.pid)
            with mock.patch.object(publisher, 'run_hugo', return_value=self.gate):
                publisher.review(self.cid, self.pid)
            def crash_after_images(repo, *args):
                result = original_push(repo, *args)
                if repo == self.images:
                    raise RuntimeError('crash after image push')
                return result
            with mock.patch.object(publisher, 'push_delta', side_effect=crash_after_images):
                with self.assertRaisesRegex(RuntimeError, 'crash after image'):
                    publisher.push(self.cid, self.pid)
            publisher.generate(self.cid, self.pid)
            def crash_before_blog_push(repo, *args):
                if repo == self.blog:
                    raise RuntimeError('crash after blog commit')
                return original_push(repo, *args)
            with mock.patch.object(publisher, 'push_delta', side_effect=crash_before_blog_push):
                with self.assertRaisesRegex(RuntimeError, 'crash after blog'):
                    publisher.push(self.cid, self.pid)
            with mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance):
                publisher.push(self.cid, self.pid)
            self.assertTrue(publisher.status(self.cid, self.pid)['complete'])
            self.assertEqual(self.git(self.blog, 'rev-list', '--count', 'HEAD').strip(), '2')

    def test_resume_after_acceptance_before_publish_receipt_write(self):
        self.prepare_flow()
        original_write = publisher.write_exact
        def fail_receipt(filename, *args, **kwargs):
            if Path(filename).name == 'publish.json':
                raise OSError('receipt disk failure')
            return original_write(filename, *args, **kwargs)
        with contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(publisher, 'run_hugo', return_value=self.gate), \
                mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance):
            publisher.generate(self.cid, self.pid)
            publisher.review(self.cid, self.pid)
            with mock.patch.object(publisher, 'write_exact', side_effect=fail_receipt):
                with self.assertRaises(OSError):
                    publisher.push(self.cid, self.pid)
            self.assertEqual(publisher.status(self.cid, self.pid)['layers']['onlineUrls'], 'pending')
            self.assertTrue(publisher.verify(self.cid, self.pid)['complete'])
            self.assertEqual(self.git(self.blog, 'rev-list', '--count', 'HEAD').strip(), '2')

    def finish_flow(self):
        self.prepare_flow()
        with contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(publisher, 'run_hugo', return_value=self.gate), \
                mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance):
            publisher.generate(self.cid, self.pid)
            publisher.review(self.cid, self.pid)
            publisher.push(self.cid, self.pid)

    def test_v2_explicit_verify_regets_and_records_failure_then_recovery(self):
        self.finish_flow()
        directory = publisher.publication_dir(self.cid, self.pid)
        original = {name: (directory / name).read_bytes() for name in
                    ('generation.json', 'review.json', 'publish.json')}
        with contextlib.redirect_stdout(io.StringIO()):
            with mock.patch.object(gate, 'fetch_public', side_effect=AssertionError('status must not GET')):
                state = publisher.status(self.cid, self.pid)
                self.assertTrue(state['complete'])
                self.assertEqual(state['onlineUrlEvidence']['mode'], 'historical_snapshot')
            # Even with a valid v2 publication, explicit verify must GET again.
            with mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance) as request:
                state = publisher.verify(self.cid, self.pid)
                request.assert_called_once()
                self.assertEqual(state['onlineUrlEvidence']['mode'], 'fresh_get')
            first_result = directory / 'url-acceptances/attempt-00000001.result.json'
            first_bytes = first_result.read_bytes()
            for response in (ValueError('HTTP 404'),
                             {'url': self.gate['pages'][0]['url'], 'contentType': 'text/html',
                              'body': b'<html><head><link rel="canonical" href="https://example.com/posts/test/">'
                                      b'</head><body><div class="post-content">changed online</div></body></html>'}):
                with self.subTest(response=response):
                    kwargs = {'side_effect': response} if isinstance(response, Exception) else {'return_value': response}
                    with mock.patch.object(gate, 'fetch_public', **kwargs) as request:
                        with self.assertRaisesRegex(publisher.ConferencePublicationError, '最新在线 GET 验收失败'):
                            publisher.verify(self.cid, self.pid)
                        request.assert_called_once_with(self.gate['pages'][0]['url'])
                    with mock.patch.object(gate, 'fetch_public', side_effect=AssertionError('status must not GET')):
                        state = publisher.status(self.cid, self.pid)
                    self.assertFalse(state['complete'])
                    self.assertEqual(state['status'], 'verification_failed')
                    self.assertEqual(state['layers']['onlineUrls'], 'failed')
                    self.assertEqual(state['onlineUrlEvidence']['mode'], 'historical_snapshot')
                    self.assertEqual(state['nextAction'], 'verify')
                    self.assertFalse(state['processingRequired'])
            with mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance) as request:
                self.assertTrue(publisher.verify(self.cid, self.pid)['complete'])
                request.assert_called_once()
            self.assertEqual(len(publisher.online_attempts(directory)), 4)
            self.assertEqual(first_result.read_bytes(), first_bytes)
            self.assertTrue(publisher.status(self.cid, self.pid)['complete'])
        for name, data in original.items():
            self.assertEqual((directory / name).read_bytes(), data)

    def test_interrupted_explicit_verify_does_not_reuse_older_pass(self):
        self.finish_flow()
        with contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(publisher, 'verify_publication_urls', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                publisher.verify(self.cid, self.pid)
            state = publisher.status(self.cid, self.pid)
        self.assertFalse(state['complete'])
        self.assertEqual(state['status'], 'verification_pending')
        self.assertEqual(state['layers']['onlineUrls'], 'pending')

    def publish_second_conference(self):
        # Both remotes advance exactly as they do when a queue publishes B after A.
        for repo, path in ((self.blog, 'content/posts/conference-b.md'),
                           (self.images, 'b-2026/bbbbbbbbbbbb/figure-1.png')):
            snapshot = publisher.remote_snapshot(repo)
            record = self.record_file(repo, path, b'conference B bytes')
            commit = publisher.commit_delta(repo, [record], snapshot['head'],
                                            snapshot['remoteIdentitySha256'], 'conference B')
            publisher.push_delta(repo, [record], snapshot['head'], snapshot['remoteIdentitySha256'], commit)

    def test_published_a_remains_complete_after_b_advances_both_remotes(self):
        self.finish_flow()
        publication = publisher.read_json(publisher.publication_dir(self.cid, self.pid) / 'publish.json')
        self.publish_second_conference()
        with contextlib.redirect_stdout(io.StringIO()):
            result = publisher.status(self.cid, self.pid)
            self.assertTrue(result['complete'])
            self.assertEqual(result['publicationCommit'], publication['publicationCommit'])
            self.assertNotEqual(result['publicationCommit'], publisher.remote_snapshot(self.blog)['remoteMain'])
            with mock.patch.object(publisher, 'commit_delta', side_effect=AssertionError('republished A')):
                self.assertTrue(publisher.push(self.cid, self.pid)['complete'])
        target = self.blog / self.record['path']
        target.write_bytes(b'changed A remotely')
        self.git(self.blog, 'add', self.record['path'])
        self.git(self.blog, 'commit', '-m', 'change A')
        self.git(self.blog, 'push', 'origin', 'HEAD:main')
        with self.assertRaisesRegex(publisher.ConferencePublicationError, '字节变化'):
            publisher.status(self.cid, self.pid)

    def test_legacy_receipts_are_not_overwritten_or_reprocessed(self):
        self.finish_flow()
        directory = publisher.publication_dir(self.cid, self.pid)
        generation = publisher.read_json(directory / 'generation.json')
        review = publisher.read_json(directory / 'review.json')
        published = publisher.read_json(directory / 'publish.json')
        generation.update(version=1, imagePublicationCommit=published['imagePublicationCommit'])
        def resign(value, key):
            value.pop(key, None)
            value[key] = publisher.stable(value)
            return value
        resign(generation, 'generationSha256')
        review.update(version=1, generationSha256=generation['generationSha256'],
                      imagePublicationCommit=published['imagePublicationCommit'], hugo={'status': 'passed'})
        resign(review, 'reviewSha256')
        published.update(version=1, generationSha256=generation['generationSha256'], reviewSha256=review['reviewSha256'])
        published.pop('imagePublicationCommit')
        published.pop('urlAcceptance')
        resign(published, 'publishSha256')
        for filename, value in (('generation.json', generation), ('review.json', review), ('publish.json', published)):
            (directory / filename).write_bytes(publisher.json_bytes(value))
        original = {name: (directory / name).read_bytes() for name in ('generation.json', 'review.json', 'publish.json')}
        self.publish_second_conference()
        with contextlib.redirect_stdout(io.StringIO()):
            result = publisher.status(self.cid, self.pid)
            self.assertEqual(result['status'], 'legacy_unverified')
            self.assertFalse(result['complete'])
            self.assertFalse(result['processingRequired'])
            self.assertEqual(result['nextAction'], 'verify')
            with mock.patch.object(publisher, 'process_bundle', side_effect=AssertionError('legacy reprocessed')):
                self.assertEqual(publisher.generate(self.cid, self.pid)['status'], 'legacy_unverified')
            with mock.patch.object(publisher, 'run_hugo', return_value=self.gate), \
                    mock.patch.object(publisher, 'verify_publication_urls', side_effect=ValueError('not online')):
                with self.assertRaisesRegex(publisher.ConferencePublicationError, '旧发布凭证'):
                    publisher.verify(self.cid, self.pid)
            self.assertFalse((directory / 'verification-v2.json').exists())
            with mock.patch.object(publisher, 'run_hugo', return_value=self.gate) as hugo, \
                    mock.patch.object(publisher, 'verify_publication_urls', return_value=self.acceptance), \
                    mock.patch.object(publisher, 'commit_delta', side_effect=AssertionError('legacy commit')):
                result = publisher.verify(self.cid, self.pid)
                self.assertTrue(result['complete'])
                self.assertTrue(result['legacyReverified'])
                self.assertEqual(hugo.call_args.args[1]['renderTree'], published['publicationCommit'])
            self.assertTrue(publisher.status(self.cid, self.pid)['complete'])
        for name, data in original.items():
            self.assertEqual((directory / name).read_bytes(), data)


class HtmlGateTest(unittest.TestCase):
    def rendered(self, body, script=''):
        return '<html><head><link rel="canonical" href="https://example.com/posts/test/">' + script + \
            '</head><body><div class="post-content">' + body + '</div></body></html>'

    def test_nested_body_and_table_cells(self):
        markdown = '| A | B |\n| --- | --- |\n| 5ms | 8% |'
        body = '<div><p>Intro</p></div><table><tr><th>A</th><th>B</th></tr>' \
               '<tr><td>5ms</td><td>8%</td></tr></table>'
        result = gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')
        self.assertEqual(result['tableCount'], 1)
        self.assertEqual(result['layers']['visualInspection'], 'not_performed')
        for broken in (body.replace('<td>5ms</td>', '<td>6ms</td>'), '<p>table lost</p>'):
            with self.assertRaisesRegex(ValueError, '表格'):
                gate.inspect_html(markdown, self.rendered(broken), [], 'https://example.com/images')

    def test_numeric_prefix_of_paper_identifier_is_not_a_measurement(self):
        markdown = '| 音频编号 | 错误率 |\n| --- | --- |\n| 2023.acl-long.23 | 5.00 |'
        body = '<table><tr><th>音频编号</th><th>错误率</th></tr>' \
               '<tr><td>2023.acl-long.23</td><td>5.00</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_escaped_decimal_point_is_compared_as_rendered_punctuation(self):
        markdown = '| 频道 | 版本 |\n| --- | --- |\n| 5\\.1 环绕声 | 2\\.0 |'
        body = '<table><tr><th>频道</th><th>版本</th></tr>' \
               '<tr><td>5.1 环绕声</td><td>2.0</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_html_entities_in_aggregate_labels_are_not_numeric_measurements(self):
        markdown = '| 标题 | 数值 |\n| --- | --- |\n| DYE &#40;Design Your Experiment&#41; | 5.9 |'
        body = '<table><tr><th>标题</th><th>数值</th></tr>' \
               '<tr><td>DYE (Design Your Experiment)</td><td>5.9</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_escaped_hyphen_range_is_not_a_negative_measurement(self):
        markdown = '| 标题 | 数值 |\n| --- | --- |\n| 儿童 VOT：8\\-10 岁 | 5.9 |'
        body = '<table><tr><th>标题</th><th>数值</th></tr>' \
               '<tr><td>儿童 VOT：8-10 岁</td><td>5.9</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_time_range_double_hyphen_matches_rendered_en_dash(self):
        markdown = '| 时间窗 | 准确率 |\n| --- | --- |\n| 00:06--00:24 | 93% |'
        body = '<table><tr><th>时间窗</th><th>准确率</th></tr>' \
               '<tr><td>00:06–00:24</td><td>93%</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_unicode_letter_prefix_is_not_a_numeric_token(self):
        markdown = '| 损失项 | 作用 |\n| --- | --- |\n| λ1*Lalign + β1*Lstr | 对齐与结构约束 |'
        body = '<table><tr><th>损失项</th><th>作用</th></tr>' \
               '<tr><td>λ1Lalign + β1Lstr</td><td>对齐与结构约束</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_literal_dash_row_after_separator_is_one_table(self):
        markdown = '| A | B |\n| --- | --- |\n| --- | --- |'
        body = '<table><tr><th>A</th><th>B</th></tr>' \
               '<tr><td>---</td><td>---</td></tr></table>'
        gate.inspect_html(markdown, self.rendered(body), [], 'https://example.com/images')

    def test_real_legacy_raw_tag_failures_are_not_silently_accepted(self):
        for body in ('<p>formula <t, value</p>', '<p>formula <l, value</p>',
                     '<think>hidden reasoning<answer>unfinished'):
            with self.assertRaisesRegex(ValueError, '标签嵌套'):
                gate.Page(self.rendered(body))

    def test_formula_requires_preserved_tex_and_runtime(self):
        markdown = r'\[x_i = 2\]'
        script = '<script src="https://example.com/mathjax.js"></script>'
        gate.inspect_html(markdown, self.rendered('<p>' + markdown + '</p>', script), [], 'https://example.com')
        for text, runtime in ((r'\[xi = 2\]', script), (markdown, '')):
            with self.assertRaisesRegex(ValueError, '公式'):
                gate.inspect_html(markdown, self.rendered('<p>' + text + '</p>', runtime), [], 'https://example.com')

    def test_missing_and_swapped_image_urls_fail(self):
        base = 'https://example.com/images'
        record = {'path': 'test/aaaaaaaaaaaa/figure-1.png', 'sourceSha256': 'a' * 64}
        url = base + '/' + record['path']
        markdown = f'![figure]({url})'
        gate.inspect_html(markdown, self.rendered(f'<img src="{url}">'), [record], base)
        for body in ('<p>missing</p>', '<img src="https://example.com/wrong.png">'):
            with self.assertRaisesRegex(ValueError, '图片'):
                gate.inspect_html(markdown, self.rendered(body), [record], base)

    def test_escaped_brackets_in_image_alt_are_not_counted_as_formula(self):
        base = 'https://example.com/images'
        record = {'path': 'test/aaaaaaaaaaaa/figure-1.png', 'sourceSha256': 'a' * 64}
        url = base + '/' + record['path']
        markdown = rf'![原论文图：输入 f\[k\]，引用 \[5\]]({url})'
        gate.inspect_html(markdown, self.rendered(f'<img src="{url}">'), [record], base)

    def test_online_old_html_and_wrong_image_bytes_fail(self):
        rendered = self.rendered('<p>approved</p>')
        page = gate.inspect_html('approved', rendered, [], 'https://example.com')
        with mock.patch.object(gate, 'fetch_public', return_value={
                'url': page['url'], 'contentType': 'text/html', 'body': self.rendered('<p>stale</p>').encode()}):
            with self.assertRaisesRegex(ValueError, '线上正文'):
                gate.verify_publication_urls([page], [], 'https://example.com')
        with mock.patch.object(gate, 'fetch_public', return_value={
                'url': 'https://example.com/image', 'contentType': 'image/png', 'body': b'wrong'}):
            with self.assertRaisesRegex(ValueError, '图片 MIME'):
                gate.verify_publication_urls([], [{'path': 'image', 'sourceSha256': 'a' * 64}], 'https://example.com')

    def test_fetch_checks_each_redirect_and_uses_shared_pinning(self):
        shared = mock.Mock()
        shared._resolve_proxy_addresses.return_value = {'127.0.0.1'}
        shared._remaining_deadline_seconds.return_value = 10
        shared._validate_public_image_url.side_effect = [{'8.8.8.8'}, ValueError('private DNS')]
        shared._pinned_https_url.return_value = 'https://8.8.8.8/page'
        response = mock.Mock(status=302, headers={'Location': 'https://private.example/page'})
        manager = mock.Mock()
        manager.request.return_value = response
        with mock.patch.object(gate, 'safe_transport', return_value=shared), \
                mock.patch('project_env.get_required_fetch_proxy', return_value='http://127.0.0.1:1'), \
                mock.patch('urllib3.ProxyManager', return_value=manager):
            with self.assertRaisesRegex(ValueError, 'private DNS'):
                gate.fetch_public('https://example.com/page')
        self.assertEqual(shared._validate_public_image_url.call_count, 2)
        shared._validate_response_peer_with_transport.assert_called_once()
        self.assertEqual(manager.request.call_args.args[1], 'https://8.8.8.8/page')
        self.assertFalse(manager.request.call_args.kwargs['redirect'])
        for url in ('http://example.com/', 'https://user:secret@example.com/', 'https://example.com:8443/'):
            with self.assertRaises(ValueError):
                gate.public_url(url)

    def test_fetch_retries_transient_transport_failure_within_url_deadline(self):
        import urllib3
        shared = mock.Mock()
        shared._resolve_proxy_addresses.return_value = {'127.0.0.1'}
        shared._remaining_deadline_seconds.return_value = 10
        shared._validate_public_image_url.return_value = {'8.8.8.8'}
        shared._pinned_https_url.return_value = 'https://8.8.8.8/image.png'
        response = mock.Mock(status=200, headers={'Content-Type': 'image/png'})
        response.read.side_effect = [b'png', b'']
        manager = mock.Mock()
        manager.request.side_effect = [urllib3.exceptions.SSLError('temporary EOF'), response]
        with mock.patch.object(gate, 'safe_transport', return_value=shared), \
                mock.patch('project_env.get_required_fetch_proxy', return_value='http://127.0.0.1:1'), \
                mock.patch('urllib3.ProxyManager', return_value=manager), \
                mock.patch.object(gate.time, 'sleep'):
            result = gate.fetch_public('https://example.com/image.png')
        self.assertEqual(result['body'], b'png')
        self.assertEqual(manager.request.call_count, 2)

    def test_fetch_allows_bounded_repeated_transport_failures(self):
        import urllib3
        shared = mock.Mock()
        shared._resolve_proxy_addresses.return_value = {'127.0.0.1'}
        shared._remaining_deadline_seconds.return_value = 10
        shared._validate_public_image_url.return_value = {'8.8.8.8'}
        shared._pinned_https_url.return_value = 'https://8.8.8.8/image.png'
        response = mock.Mock(status=200, headers={'Content-Type': 'image/png'})
        response.read.side_effect = [b'png', b'']
        manager = mock.Mock()
        manager.request.side_effect = [
            urllib3.exceptions.SSLError('temporary EOF'),
            urllib3.exceptions.ReadTimeoutError(None, 'image.png', 'temporary timeout'),
            urllib3.exceptions.SSLError('temporary EOF'),
            response,
        ]
        with mock.patch.object(gate, 'safe_transport', return_value=shared), \
                mock.patch('project_env.get_required_fetch_proxy', return_value='http://127.0.0.1:1'), \
                mock.patch('urllib3.ProxyManager', return_value=manager), \
                mock.patch.object(gate.time, 'sleep'):
            result = gate.fetch_public('https://example.com/image.png')
        self.assertEqual(result['body'], b'png')
        self.assertEqual(manager.request.call_count, 4)


if __name__ == '__main__':
    unittest.main()

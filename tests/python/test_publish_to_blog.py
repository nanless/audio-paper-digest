import importlib.util
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODULE_PATH = os.path.join(ROOT, 'scripts', 'publish-to-blog.py')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
SPEC = importlib.util.spec_from_file_location('publish_to_blog', MODULE_PATH)
publish_to_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish_to_blog)


def git(repo, *args, check=True):
    return subprocess.run(
        ['git', *args], cwd=repo, check=check, capture_output=True, text=True,
    )


def init_blog_repo(root, with_remote=False):
    repo = Path(root) / 'blog'
    repo.mkdir()
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Publish Test')
    git(repo, 'config', 'user.email', 'publish@example.com')
    posts = repo / 'content' / 'posts'
    posts.mkdir(parents=True)
    readme = repo / 'README.md'
    readme.write_text('blog\n', encoding='utf-8')
    git(repo, 'add', '--', 'README.md')
    git(repo, 'commit', '-m', 'initial')
    remote = None
    if with_remote:
        remote = Path(root) / 'remote.git'
        git(root, 'init', '--bare', str(remote))
        git(repo, 'remote', 'add', 'origin', str(remote))
        git(repo, 'push', '-u', 'origin', 'main')
    return repo, posts, remote


class PublishToBlogReviewTest(unittest.TestCase):
    def test_blog_review_concurrency_defaults_to_eight_and_reads_project_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PD_BLOG_REVIEW_CONCURRENCY', None)
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 8)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CONCURRENCY': '12'}):
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 12)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CONCURRENCY': 'invalid'}):
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 8)

    def test_index_review_chunks_run_concurrently_and_merge_in_source_order(self):
        import threading
        import time

        active = 0
        peak = 0
        lock = threading.Lock()

        def review_chunk(_chunk, _title, **kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.03)
            with lock:
                active -= 1
            label = kwargs['chunk_label']
            return True, [{'severity': 'info', 'description': label}], _chunk

        with mock.patch.object(publish_to_blog, 'get_blog_review_concurrency', return_value=3), \
                mock.patch.object(publish_to_blog, '_llm_review_post_chunk', side_effect=review_chunk):
            passed, issues, _ = publish_to_blog.llm_review_post('A' * 9000, '汇总页')

        self.assertTrue(passed)
        self.assertGreater(peak, 1)
        self.assertEqual([issue['description'] for issue in issues], ['1/3', '2/3', '3/3'])

    def test_review_preserves_valid_table_rows_with_empty_group_cells(self):
        content = '''---
title: "Table"
---
| 方法 | 复杂度 | 参数量 | 阶段 | SI-SIR |
| :--- | :--- | :--- | :--- | :--- |
| TANGO | 65.65 | 1 M | SN-DNN | 3.1/0.0 |
| | | | Filter1 (GEVD) | 9.4/6.7 |
| | | | MN-DNN | 13.0/7.8 |
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            with open(path, 'r', encoding='utf-8') as handle:
                reviewed = handle.read()
            self.assertFalse(fixed)
            self.assertEqual(issues, [])
            self.assertIn('| | | | Filter1 (GEVD) | 9.4/6.7 |', reviewed)
            self.assertIn('| | | | MN-DNN | 13.0/7.8 |', reviewed)
        finally:
            os.unlink(path)

    def test_review_filters_model_name_backtick_style_advice(self):
        issues = [{
            'severity': 'warning',
            'type': 'markdown',
            'description': '模型名称 gemini-2.5-flash 未使用反引号包裹',
            'auto_fixable': False
        }]
        self.assertEqual(publish_to_blog.filter_false_positive_review_issues('正文', issues), [])

    def test_required_text_review_fails_closed_on_non_json_and_missing_fields(self):
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value='无法判断'):
            passed, issues, _ = publish_to_blog.llm_review_post('正文', '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

        malformed = '{"passed": true, "issues": [{"severity": "warning"}]}'
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value=malformed):
            passed, issues, _ = publish_to_blog.llm_review_post('正文', '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_required_image_review_fails_closed_on_non_json_and_invalid_severity(self):
        content = '![结果图](https://arxiv.org/result.png)'
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        with mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value='大概没问题'):
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

        malformed = '{"passed": true, "issues": [{"severity": "critical", "description": "x"}]}'
        with mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=malformed):
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_generate_page_handles_missing_tags_without_key_error(self):
        markdown, slug = publish_to_blog.generate_paper_page({
            'title': 'No tags',
            'arxivId': '2607.00001',
            'parsed': {'score': '1'},
        }, '2026-07-10')
        self.assertEqual(slug, 'no-tags-2607-00001')
        self.assertIn('tags: []', markdown)

    def test_same_title_slug_is_disambiguated_by_normalized_arxiv_id(self):
        first = publish_to_blog.paper_slug('Same title', '2607.00001v2')
        second = publish_to_blog.paper_slug('Same title', '2607.00002')
        self.assertEqual(first, 'same-title-2607-00001')
        self.assertEqual(second, 'same-title-2607-00002')

    def test_text_review_covers_every_chunk(self):
        content = 'A' * 3990 + '\nSECOND-CHUNK-MARKER\n' + 'B' * 100
        valid = '{"passed": true, "issues": []}'
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value=valid) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post(content, '标题', required=True)
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, content)
        self.assertGreater(call.call_count, 1)
        prompts = ''.join(item.args[0] for item in call.call_args_list)
        self.assertIn('SECOND-CHUNK-MARKER', prompts)
        self.assertIn('AAAA', prompts)

    def test_review_split_keeps_table_header_with_separator(self):
        content = 'A' * 20 + '\n| 方法 | 得分 |\n| --- | --- |\n| A | 1 |\n'
        chunks = publish_to_blog.split_review_content(content, limit=36)
        table_chunk = next(chunk for chunk in chunks if '| 方法 | 得分 |' in chunk)
        self.assertIn('| --- | --- |', table_chunk)
        self.assertEqual(''.join(chunks), content)

    def test_image_review_sends_actual_image_payload(self):
        image = {'media_type': 'image/png', 'data': 'cG5nLWJ5dGVz'}
        response = '{"passed": true, "issues": []}'
        with mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=response) as call:
            passed, issues = publish_to_blog.multimodal_review_images(
                '![实验曲线](https://arxiv.org/curve.png)', '标题', required=True
            )
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(call.call_args.kwargs['images'], [image])
        self.assertTrue(call.call_args.kwargs['use_secondary'])
        self.assertIn('正文附近上下文', call.call_args.args[0])

    def test_image_review_prompt_contains_nearby_body_context(self):
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        response = '{"passed": true, "issues": []}'
        content = '## 实验结果\n前文指标提升 12%。\n![消融曲线](https://example.com/a.png)\n后文解释低频误差。'
        with mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=response) as call:
            publish_to_blog.multimodal_review_images(content, '标题', required=True)
        prompt = call.call_args.args[0]
        self.assertIn('前文指标提升 12%', prompt)
        self.assertIn('后文解释低频误差', prompt)

    def test_image_review_keeps_payload_and_context_aligned_after_download_failure(self):
        content = (
            '![失败图](https://example.com/failed.png)\n失败图上下文\n'
            '![成功图](https://example.com/ok.png)\n成功图上下文'
        )
        image = {'media_type': 'image/png', 'data': 'cG5n'}

        def load(url):
            if url.endswith('failed.png'):
                raise publish_to_blog.PublishDataValidationError('模拟超时')
            return image

        with mock.patch.object(publish_to_blog, '_load_review_image', side_effect=load), \
                mock.patch.object(
                    publish_to_blog,
                    'call_llm_api',
                    return_value='{"passed": true, "issues": []}',
                ) as call:
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题')

        self.assertTrue(passed)
        self.assertEqual(len(call.call_args.kwargs['images']), 1)
        prompt = call.call_args.args[0]
        self.assertIn('alt: `成功图`', prompt)
        self.assertNotIn('alt: `失败图`', prompt)
        self.assertEqual(issues[0]['severity'], 'warning')

    def test_image_download_rejects_dns_rebinding_peer(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('10.0.0.8', 443)
        response = mock.Mock()
        response.raw._connection.sock = sock
        response.status_code = 200
        response.headers = {'Content-Type': 'image/png'}
        session = mock.MagicMock()
        session.get.return_value = response
        with mock.patch.object(publish_to_blog.socket, 'getaddrinfo', return_value=[
            (publish_to_blog.socket.AF_INET, publish_to_blog.socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
        ]), mock.patch('requests.Session', return_value=session):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '非公网 peer'):
                publish_to_blog._download_review_image('https://example.com/a.png')
        response.close.assert_called_once()

    def test_image_download_rejects_global_peer_outside_validated_dns_set(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('93.184.216.35', 443)
        response = mock.Mock()
        response.raw._connection.sock = sock
        response.status_code = 200
        response.headers = {'Content-Type': 'image/png'}
        session = mock.MagicMock()
        session.get.return_value = response
        with mock.patch.object(publish_to_blog.socket, 'getaddrinfo', return_value=[
            (publish_to_blog.socket.AF_INET, publish_to_blog.socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
        ]), mock.patch('requests.Session', return_value=session):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'DNS rebinding'):
                publish_to_blog._download_review_image('https://example.com/a.png')

    def test_publish_date_and_content_target_are_strict(self):
        for invalid in ('2026-2-03', '2026-02-30', '../2026-07-10'):
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                publish_to_blog.validate_publish_date(invalid)
        self.assertEqual(publish_to_blog.validate_publish_date('2026-07-10'), '2026-07-10')

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            repo.mkdir()
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                publish_to_blog.validate_publish_target(repo, Path(tmp) / 'outside')

    def test_install_deletes_only_explicitly_owned_stale_paper_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staged = root / 'staged'
            target = root / 'content' / 'posts'
            staged.mkdir()
            target.mkdir(parents=True)
            (staged / '2026-07-10.md').write_text('new index', encoding='utf-8')
            (staged / '2026-07-10-paper-2607-00001.md').write_text('new paper', encoding='utf-8')
            stale = target / '2026-07-10-old-title.md'
            stale.write_text('''---
title: old
date: 2026-07-10
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
---
old
''', encoding='utf-8')
            manual_same_date = target / '2026-07-10-manual-note.md'
            manual_same_date.write_text('manual', encoding='utf-8')
            other_date = target / '2026-07-09-keep.md'
            other_date.write_text('keep', encoding='utf-8')

            changes = publish_to_blog.install_staged_posts(staged, target, '2026-07-10')
            self.assertFalse(stale.exists())
            self.assertTrue(manual_same_date.exists())
            self.assertTrue(other_date.exists())
            self.assertTrue((target / '2026-07-10-paper-2607-00001.md').exists())
            self.assertIn(stale, changes)

    def test_yaml_gate_rejects_duplicate_keys_and_hugo_has_fallback(self):
        markdown = '''---
title: "Test"
title: "Duplicate"
date: 2026-07-10
draft: false
tags: []
categories: [test]
description: "test"
---
body
'''
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            (posts / '2026-07-10.md').write_text(markdown, encoding='utf-8')
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '重复字段'):
                publish_to_blog.validate_staged_posts(posts, '2026-07-10')
            with mock.patch.object(publish_to_blog.shutil, 'which', return_value=None):
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'fallback')

    def test_hugo_gate_uses_staging_destination_without_blog_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            completed = SimpleNamespace(returncode=0, stdout='', stderr='')
            with mock.patch.object(publish_to_blog.shutil, 'which', return_value='/usr/bin/hugo'), \
                    mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed) as run:
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'hugo')
            command = run.call_args.args[0]
            self.assertIn('--contentDir', command)
            self.assertIn('--destination', command)
            self.assertIn('--noBuildLock', command)

    def test_push_requires_hugo_but_skip_push_allows_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            with mock.patch.object(publish_to_blog.shutil, 'which', return_value=None):
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'fallback')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '要求 Hugo'):
                    publish_to_blog.run_hugo_gate(tmp, posts, required=True)

    def test_legacy_publish_entry_rejects_push_mode(self):
        with mock.patch.object(sys, 'argv', ['publish-to-blog.py', '--push']), \
                mock.patch.object(publish_to_blog, 'review_all_posts') as review, \
                mock.patch.object(publish_to_blog, 'git_push') as push, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(SystemExit) as raised:
                publish_to_blog.main()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn('generate-blog.py', output.getvalue())
        review.assert_not_called()
        push.assert_not_called()

    def test_git_push_retries_existing_commit_and_verifies_remote_oid(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, remote = init_blog_repo(tmp, with_remote=True)
            (repo / 'README.md').write_text('local commit\n', encoding='utf-8')
            git(repo, 'add', '--', 'README.md')
            git(repo, 'commit', '-m', 'local pending')
            local_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                self.assertTrue(publish_to_blog.git_push('2026-07-10', []))
            remote_head = git(remote, 'rev-parse', 'refs/heads/main').stdout.strip()
            self.assertEqual(remote_head, local_head)

    def test_git_push_stages_only_manifest_with_vcs_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, remote = init_blog_repo(tmp, with_remote=True)
            path = posts / '2026-07-10.md'
            path.write_text('content', encoding='utf-8')
            original_env = publish_to_blog.build_child_process_env
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'), \
                    mock.patch.object(publish_to_blog, 'build_child_process_env', side_effect=original_env) as env:
                self.assertTrue(publish_to_blog.git_push('2026-07-10', [path]))
            changed_paths = git(repo, 'show', '--pretty=format:', '--name-only', 'HEAD').stdout.splitlines()
            self.assertEqual(changed_paths, ['content/posts/2026-07-10.md'])
            self.assertEqual(
                git(remote, 'rev-parse', 'refs/heads/main').stdout.strip(),
                git(repo, 'rev-parse', 'HEAD').stdout.strip(),
            )
            for call in env.call_args_list:
                self.assertEqual(
                    call.kwargs.get('allowed_keys'),
                    publish_to_blog.VCS_CHILD_ENV_KEYS,
                )

    def test_manifest_rejects_staged_unstaged_and_untracked_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            tracked = posts / '2026-07-10.md'
            tracked.write_text('head\n', encoding='utf-8')
            git(repo, 'add', '--', 'content/posts/2026-07-10.md')
            git(repo, 'commit', '-m', 'track post')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                tracked.write_text('unstaged\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head([tracked])
                git(repo, 'add', '--', 'content/posts/2026-07-10.md')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head([tracked])
                git(repo, 'reset', '--quiet', 'HEAD', '--', 'content/posts/2026-07-10.md')
                tracked.write_text('head\n', encoding='utf-8')
                untracked = posts / '2026-07-10-new.md'
                untracked.write_text('manual\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head([untracked])

    def test_git_commit_failure_restores_preinstall_index_and_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            path = posts / '2026-07-10.md'
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                state = publish_to_blog.capture_git_publish_state([path])
                path.write_text('generated\n', encoding='utf-8')
                hook = repo / '.git' / 'hooks' / 'pre-commit'
                hook.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
                hook.chmod(0o755)
                self.assertFalse(publish_to_blog.git_push(
                    '2026-07-10', [path], rollback_state=state,
                ))
            self.assertFalse(path.exists())
            self.assertEqual(git(repo, 'diff', '--cached', '--name-only').stdout, '')
            self.assertEqual(git(repo, 'status', '--porcelain', '--', 'content/posts').stdout, '')

    def test_git_add_failure_restores_preinstall_index_and_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            path = posts / '2026-07-10.md'
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                state = publish_to_blog.capture_git_publish_state([path])
                path.write_text('generated\n', encoding='utf-8')
                original_run = publish_to_blog.subprocess.run

                def fail_git_add(command, *args, **kwargs):
                    if command[:2] == ['git', 'add']:
                        raise subprocess.CalledProcessError(1, command)
                    return original_run(command, *args, **kwargs)

                with mock.patch.object(publish_to_blog.subprocess, 'run', side_effect=fail_git_add):
                    self.assertFalse(publish_to_blog.git_push(
                        '2026-07-10', [path], rollback_state=state,
                    ))
            self.assertFalse(path.exists())
            self.assertEqual(git(repo, 'diff', '--cached', '--name-only').stdout, '')
            self.assertEqual(git(repo, 'status', '--porcelain', '--', 'content/posts').stdout, '')

    def test_push_failure_preserves_local_commit_and_reports_verifiable_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            git(repo, 'remote', 'add', 'origin', str(Path(tmp) / 'missing-remote.git'))
            path = posts / '2026-07-10.md'
            path.write_text('generated\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertFalse(publish_to_blog.git_push('2026-07-10', [path]))
            local_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            self.assertEqual(git(repo, 'show', '--format=%H', '-s', 'HEAD').stdout.strip(), local_head)
            self.assertEqual(git(repo, 'status', '--porcelain', '--', 'content/posts').stdout, '')
            report = output.getvalue()
            self.assertIn(local_head, report)
            self.assertIn('push origin HEAD:main', report)
            self.assertIn('ls-remote origin refs/heads/main', report)

    def test_formal_publish_rejects_non_main_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, _remote = init_blog_repo(tmp)
            git(repo, 'checkout', '-b', 'feature')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'main'):
                    publish_to_blog.validate_git_publish_branch()

    def test_generation_never_calls_review_or_push(self):
        paper = {
            'title': 'Blocked paper',
            'arxivId': '2607.00001',
            'parsed': {'score': '7', 'tags': []},
        }
        with tempfile.TemporaryDirectory() as tmp:
            content_dir = Path(tmp) / 'content' / 'posts'
            content_dir.mkdir(parents=True)
            current_dir = Path(tmp) / 'data' / 'current'
            old_page = content_dir / '2026-07-10-old.md'
            old_page.write_text('original', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', tmp), \
                    mock.patch.object(publish_to_blog, 'CONTENT_DIR', str(content_dir)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'load_papers', return_value=[paper]), \
                    mock.patch.object(publish_to_blog, 'validate_papers_for_publish', return_value=[paper]), \
                    mock.patch.object(publish_to_blog, 'score_and_sort', return_value=([(7.0, paper, paper['parsed'])], [])), \
                    mock.patch.object(publish_to_blog, 'review_all_posts') as review, \
                    mock.patch.object(publish_to_blog, 'git_push') as push, \
                    mock.patch.object(sys, 'argv', ['publish-to-blog.py', '--all', '--date', '2026-07-10']), \
                    contextlib.redirect_stdout(io.StringIO()):
                publish_to_blog.main()
            review.assert_not_called()
            push.assert_not_called()
            self.assertTrue((current_dir / 'blog-generation-manifest-2026-07-10.json').is_file())
            self.assertTrue(old_page.exists())
            self.assertEqual(old_page.read_text(encoding='utf-8'), 'original')
            self.assertTrue((content_dir / '2026-07-10.md').is_file())

    def test_review_receipt_detects_any_post_review_file_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_to_blog.save_review_receipt('2026-07-10', [page], 'hugo')
                paths, _receipt = publish_to_blog.load_verified_review_receipt('2026-07-10')
                self.assertEqual(paths, [page.resolve()])
                page.write_text('changed after review\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'review 后已变更'):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')


if __name__ == '__main__':
    unittest.main()

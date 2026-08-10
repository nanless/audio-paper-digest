import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load_script(name):
    path = SCRIPTS / name
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


review_blog = load_script('review-blog.py')
push_blog = load_script('push-blog.py')
generate_blog = load_script('generate-blog.py')
plan_visuals = load_script('plan-post-publish-visuals.py')


class BlogStageEntryTest(unittest.TestCase):
    def test_blog_stage_date_parsers_reject_missing_unknown_and_duplicate_flags(self):
        module = SimpleNamespace(
            get_today_bj=lambda value=None: value or '2026-07-10',
            validate_publish_date=lambda value: value,
        )
        for entry, parser in (
            ('review-blog.py', review_blog.parse_date),
            ('push-blog.py', push_blog.parse_date),
        ):
            for argv in (
                [entry, '--date'],
                [entry, '--unknown', 'value'],
                [entry, '--d', '2026-07-10'],
                [entry, '--date', '2026-07-10', '--date', '2026-07-11'],
            ):
                with self.subTest(entry=entry, argv=argv), \
                        mock.patch.object(sys, 'argv', argv), \
                        contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as caught:
                        parser(module)
                    self.assertEqual(caught.exception.code, 2)
        for argv in (
            ['--date'],
            ['--unknown', 'value'],
            ['--d', '2026-07-10'],
            ['--date', '2026-07-10', '--date', '2026-07-11'],
        ):
            with self.subTest(entry='plan-post-publish-visuals.py', argv=argv), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    plan_visuals.parse_date(module, argv)
                self.assertEqual(caught.exception.code, 2)

    def test_generate_entry_only_calls_generation(self):
        generate = mock.Mock()
        module = SimpleNamespace(main=generate)
        with mock.patch.object(generate_blog, 'load_publish_to_blog', return_value=module):
            # The executable guard is not active on import; call the same entry target.
            generate_blog.load_publish_to_blog().main()
        generate.assert_called_once_with()

    def test_review_entry_never_calls_git_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            index = posts / '2026-07-10.md'
            index.write_text('index', encoding='utf-8')
            paper = posts / '2026-07-10-paper-2607-00001.md'
            paper.write_text('''---
title: "Paper"
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
paper_digest_arxiv_id: "2607.00001"
---
body
''', encoding='utf-8')
            git_push = mock.Mock(side_effect=AssertionError('review must not push'))
            receipt_path = Path(tmp) / 'receipt.json'
            failure_path = Path(tmp) / 'failure.json'
            module = SimpleNamespace(
                PublishDataValidationError=ValueError,
                PublishLLMUnavailable=RuntimeError,
                validate_publish_target=lambda: (repo, posts),
                get_today_bj=lambda value=None: value or '2026-07-10',
                validate_publish_date=lambda value: value,
                blog_publication_lock=lambda _date: contextlib.nullcontext(),
                is_visual_summary_asset_path=lambda _path, _date: False,
                load_generation_manifest=lambda _date: ([index, paper], Path('manifest.json')),
                validate_git_publish_branch=mock.Mock(return_value='a' * 40),
                review_receipt_path=mock.Mock(return_value=receipt_path),
                review_failure_path=mock.Mock(return_value=failure_path),
                plan_incremental_review=mock.Mock(return_value={
                    'mode': 'full',
                    'paths': [index, paper],
                    'priorResults': {},
                    'unchangedFailed': [],
                    'reason': None,
                }),
                review_all_posts=mock.Mock(return_value=(0, 0, {
                    str(index.resolve()): {'passed': True},
                    str(paper.resolve()): {'passed': True},
                })),
                validate_staged_posts=mock.Mock(),
                validate_reviewed_file_hashes=mock.Mock(),
                run_hugo_gate=mock.Mock(return_value='hugo'),
                save_review_receipt=mock.Mock(return_value=Path('receipt.json')),
                save_review_failure_state=mock.Mock(),
                git_push=git_push,
            )
            with mock.patch.object(review_blog, 'require_external_runtime'), \
                    mock.patch.object(review_blog, 'load_publish_to_blog', return_value=module), \
                    mock.patch.object(sys, 'argv', ['review-blog.py', '--date', '2026-07-10']), \
                    contextlib.redirect_stdout(io.StringIO()):
                review_blog.main()
            module.review_all_posts.assert_called_once()
            module.save_review_receipt.assert_called_once()
            git_push.assert_not_called()

    def test_push_entry_only_verifies_receipt_and_pushes(self):
        path = Path('/tmp/content/posts/2026-07-10.md')
        module = SimpleNamespace(
            PublishDataValidationError=ValueError,
            validate_publish_target=mock.Mock(),
            get_today_bj=lambda value=None: value or '2026-07-10',
            validate_publish_date=lambda value: value,
            blog_publication_lock=lambda _date: contextlib.nullcontext(),
            load_verified_review_receipt=mock.Mock(return_value=([path], Path('receipt.json'))),
            validate_git_publish_branch=mock.Mock(),
            validate_git_index=mock.Mock(),
            git_push=mock.Mock(return_value=True),
            plan_post_publish_visual_assets=mock.Mock(return_value=True),
            review_all_posts=mock.Mock(side_effect=AssertionError('push must not review')),
            load_papers=mock.Mock(side_effect=AssertionError('push must not load papers')),
        )
        with mock.patch.object(push_blog, 'require_external_runtime'), \
                mock.patch.object(push_blog, 'load_publish_to_blog', return_value=module), \
                mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-07-10']), \
                contextlib.redirect_stdout(io.StringIO()):
            push_blog.main()
        module.load_verified_review_receipt.assert_called_once_with('2026-07-10')
        module.git_push.assert_called_once_with('2026-07-10', [path])
        module.plan_post_publish_visual_assets.assert_called_once_with('2026-07-10')
        module.review_all_posts.assert_not_called()
        module.load_papers.assert_not_called()

    def test_visual_planning_failure_does_not_turn_verified_blog_push_into_failure(self):
        path = Path('/tmp/content/posts/2026-07-10.md')
        module = SimpleNamespace(
            PublishDataValidationError=ValueError,
            validate_publish_target=mock.Mock(),
            get_today_bj=lambda value=None: value or '2026-07-10',
            validate_publish_date=lambda value: value,
            blog_publication_lock=lambda _date: contextlib.nullcontext(),
            load_verified_review_receipt=mock.Mock(return_value=([path], Path('receipt.json'))),
            validate_git_publish_branch=mock.Mock(),
            validate_git_index=mock.Mock(),
            git_push=mock.Mock(return_value=True),
            plan_post_publish_visual_assets=mock.Mock(return_value=False),
        )
        output = io.StringIO()
        with mock.patch.object(push_blog, 'require_external_runtime'), \
                mock.patch.object(push_blog, 'load_publish_to_blog', return_value=module), \
                mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-07-10']), \
                contextlib.redirect_stdout(output):
            push_blog.main()
        self.assertIn('全部博客推送完成；发布后视觉任务尚待重试', output.getvalue())

    def test_daily_push_mode_requires_visual_planning_success(self):
        path = Path('/tmp/content/posts/2026-07-10.md')
        module = SimpleNamespace(
            PublishDataValidationError=ValueError,
            validate_publish_target=mock.Mock(),
            get_today_bj=lambda value=None: value or '2026-07-10',
            validate_publish_date=lambda value: value,
            blog_publication_lock=lambda _date: contextlib.nullcontext(),
            load_verified_review_receipt=mock.Mock(return_value=([path], Path('receipt.json'))),
            validate_git_publish_branch=mock.Mock(),
            validate_git_index=mock.Mock(),
            git_push=mock.Mock(return_value=True),
            plan_post_publish_visual_assets=mock.Mock(return_value=False),
        )
        output = io.StringIO()
        with mock.patch.object(push_blog, 'require_external_runtime'), \
                mock.patch.object(push_blog, 'load_publish_to_blog', return_value=module), \
                mock.patch.object(sys, 'argv', [
                    'push-blog.py', '--date', '2026-07-10', '--require-visual-plan',
                ]), \
                contextlib.redirect_stdout(output), \
                self.assertRaises(SystemExit) as caught:
            push_blog.main()
        self.assertEqual(caught.exception.code, 2)
        self.assertIn('博客已发布并验证远端 OID，但发布后视觉任务规划失败', output.getvalue())


if __name__ == '__main__':
    unittest.main()

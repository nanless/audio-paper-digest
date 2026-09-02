import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
MANUAL_SCRIPTS = ROOT / 'manual' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(MANUAL_SCRIPTS))


def load_script(name, root=SCRIPTS):
    path = root / name
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


review_blog = load_script('review-blog.py')
push_blog = load_script('push-blog.py')
generate_blog = load_script('generate-blog.py')
plan_visuals = load_script('plan-post-publish-visuals.py')
assemble_manual_review = load_script(
    'assemble-manual-review-attestation.py', MANUAL_SCRIPTS,
)
publish_module = load_script('publish-to-blog.py')


class BlogStageEntryTest(unittest.TestCase):
    def test_dynamic_publisher_loader_resolves_manual_compatibility_once(self):
        code = (
            "import json, sys; "
            f"sys.path.insert(0, {str(SCRIPTS)!r}); "
            "from blog_entry_loader import load_publish_to_blog; "
            "first=load_publish_to_blog(); second=load_publish_to_blog(); "
            "manual=str(first.MANUAL_SCRIPTS_DIR); shared=str(first.SHARED_SCRIPTS_DIR); "
            "print(json.dumps({'first':first.__file__,'second':second.__file__,"
            "'manual':manual,'manualCount':sys.path.count(manual),"
            "'sharedCount':sys.path.count(shared)}))"
        )
        completed = subprocess.run(
            [sys.executable, '-c', code], cwd=ROOT,
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = __import__('json').loads(completed.stdout)
        self.assertEqual(Path(payload['first']).resolve(), SCRIPTS / 'publish-to-blog.py')
        self.assertEqual(Path(payload['second']).resolve(), SCRIPTS / 'publish-to-blog.py')
        self.assertEqual(Path(payload['manual']).resolve(), MANUAL_SCRIPTS)
        self.assertEqual(payload['manualCount'], 1)
        self.assertEqual(payload['sharedCount'], 1)

    def test_stage_module_imports_do_not_reload_project_environment(self):
        paths = [
            SCRIPTS / 'generate-blog.py',
            SCRIPTS / 'review-blog.py',
            SCRIPTS / 'push-blog.py',
            SCRIPTS / 'plan-post-publish-visuals.py',
            MANUAL_SCRIPTS / 'manual-review-blog.py',
            MANUAL_SCRIPTS / 'assemble-manual-review-attestation.py',
        ]
        code = (
            "import importlib.util, os, sys; "
            f"sys.path[:0]=[{str(MANUAL_SCRIPTS)!r},{str(SCRIPTS)!r}]; "
            "os.environ['PAPER_ANALYZER_API_KEY']='outer-test-key'; "
            f"paths={list(map(str, paths))!r}; "
            "[(lambda spec: spec.loader.exec_module(importlib.util.module_from_spec(spec)))("
            "importlib.util.spec_from_file_location('stage_probe_'+str(i), p)) "
            "for i,p in enumerate(paths)]; "
            "print(os.environ.get('PAPER_ANALYZER_API_KEY',''))"
        )
        completed = subprocess.run(
            [sys.executable, '-c', code], cwd=ROOT,
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), 'outer-test-key')

    def test_review_entry_rejects_generation_byte_drift_before_llm_or_hugo(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current = Path(tmp) / 'current'
            current.mkdir()
            page = posts / '2026-07-10.md'
            page.write_text('changed after generation\n', encoding='utf-8')
            manifest = {
                'schemaVersion': 3,
                'date': '2026-07-10',
                'templateFingerprint': publish_module.generation_template_fingerprint(),
                'files': [{
                    'path': 'content/posts/2026-07-10.md',
                    'deleted': False,
                    'sha256': '0' * 64,
                }],
            }
            (current / 'blog-generation-manifest-2026-07-10.json').write_text(
                __import__('json').dumps(manifest), encoding='utf-8',
            )
            llm_review = mock.Mock(side_effect=AssertionError('LLM must not run'))
            hugo = mock.Mock(side_effect=AssertionError('Hugo must not run'))
            with mock.patch.object(publish_module, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_module, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        publish_module, 'validate_publish_target',
                        return_value=(repo, posts),
                    ), mock.patch.object(publish_module, 'review_all_posts', llm_review), \
                    mock.patch.object(publish_module, 'run_hugo_gate', hugo), \
                    mock.patch.object(review_blog, 'require_external_runtime'), \
                    mock.patch.object(review_blog, 'load_publish_to_blog', return_value=publish_module), \
                    mock.patch.object(sys, 'argv', [
                        'review-blog.py', '--date', '2026-07-10',
                    ]), contextlib.redirect_stdout(io.StringIO()), \
                    self.assertRaises(SystemExit) as caught:
                review_blog.main()
            self.assertEqual(caught.exception.code, 1)
            llm_review.assert_not_called()
            hugo.assert_not_called()

    def test_cached_review_pass_rechecks_current_canonical_deterministic_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / '2026-07-10-paper.md'
            content = (
                '---\npaper_digest_page_type: paper\n'
                'paper_digest_arxiv_id: "2607.00001"\n---\nbody\n'
            )
            page.write_text(content, encoding='utf-8')
            review_and_fix = mock.Mock(return_value=(False, ['canonical mismatch']))
            module = SimpleNamespace(
                normalize_publish_arxiv_id=lambda value: str(value),
                PublishDataValidationError=ValueError,
                review_and_fix_post=review_and_fix,
            )
            with self.assertRaisesRegex(ValueError, '当前确定性门禁'):
                review_blog.validate_reused_pages(
                    module, '2026-07-10', [page], {
                        str(page.resolve()): {'passed': True},
                    }, {
                        str(page.resolve()): {'content': content},
                    }, [{'arxivId': '2607.00001', 'analysis': 'canonical'}],
                )
            self.assertEqual(
                review_and_fix.call_args.args[1]['analysis'], 'canonical',
            )

    def test_manual_attestation_assembler_preserves_generation_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            shard_dir = current / 'manual-blog-review-pages' / '2026-07-10'
            shard_dir.mkdir(parents=True)
            manifest = {
                'schemaVersion': 3,
                'date': '2026-07-10',
                'files': [
                    {
                        'path': 'content/posts/2026-07-10.md',
                        'deleted': False, 'sha256': 'a' * 64,
                    },
                    {
                        'path': 'content/posts/2026-07-10-stale.md',
                        'deleted': True, 'sha256': None,
                    },
                ],
            }
            (current / 'blog-generation-manifest-2026-07-10.json').write_text(
                __import__('json').dumps(manifest), encoding='utf-8',
            )
            common_subagent = {
                'version': 1, 'singleFileOnly': True, 'isolatedContext': True,
                'model': 'gpt-5.6-terra', 'reasoningEffort': 'high',
            }
            (shard_dir / 'index.json').write_text(__import__('json').dumps({
                'path': 'content/posts/2026-07-10.md',
                'sha256': 'a' * 64,
                'checks': {key: True for key in assemble_manual_review.FILE_CHECKS},
                'notes': '2026-07-10 汇总页逐项核对论文数量、排序、标题和链接均无错误。',
                'issues': [],
                'reviewSubagent': {**common_subagent, 'taskName': 'review-index'},
                'imageFindings': [],
            }), encoding='utf-8')
            (shard_dir / 'deleted.json').write_text(__import__('json').dumps({
                'path': 'content/posts/2026-07-10-stale.md',
                'deleted': True, 'sha256': None,
                'checks': {'deletionVerified': True},
                'notes': '确认删除页面文件名 2026-07-10-stale，旧文件在博客工作树中已经不存在。',
                'issues': [],
                'reviewSubagent': {**common_subagent, 'taskName': 'review-deleted'},
                'imageFindings': [],
            }), encoding='utf-8')
            with mock.patch.object(publish_module, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        assemble_manual_review, 'load_publish_to_blog',
                        return_value=publish_module,
                    ), \
                    mock.patch.object(sys, 'argv', [
                        'assemble-manual-review-attestation.py',
                        '--date', '2026-07-10',
                    ]), contextlib.redirect_stdout(io.StringIO()):
                assemble_manual_review.main()
            output = __import__('json').loads(
                (current / 'manual-review-attestation-2026-07-10.json').read_text(
                    encoding='utf-8',
                )
            )
            deleted = next(item for item in output['files'] if item.get('deleted'))
            self.assertIsNone(deleted['sha256'])
            self.assertEqual(deleted['checks'], {'deletionVerified': True})

    def test_manual_attestation_assembler_uses_isolated_single_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            paper_id = '2607.00001'
            scope = {'mode': 'single-paper', 'includeId': paper_id}
            with mock.patch.object(publish_module, 'CURRENT_DIR', current), \
                    publish_module.publication_scope(paper_id):
                manifest_path = publish_module.generation_manifest_path('2026-07-10')
                shard_dir = publish_module.manual_review_page_dir('2026-07-10')
                output_path = publish_module.manual_review_attestation_path('2026-07-10')
            shard_dir.mkdir(parents=True)
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(__import__('json').dumps({
                'schemaVersion': 3, 'date': '2026-07-10',
                'publicationScope': scope,
                'publishedPapers': [{'arxivId': paper_id}],
                'files': [{
                    'path': 'content/posts/2026-07-10-selected.md',
                    'deleted': False, 'sha256': 'a' * 64,
                }],
            }), encoding='utf-8')
            (shard_dir / 'selected.json').write_text(__import__('json').dumps({
                'path': 'content/posts/2026-07-10-selected.md',
                'sha256': 'a' * 64,
                'checks': {key: True for key in assemble_manual_review.FILE_CHECKS},
                'notes': '2607.00001：核对 Conformer 方法、WER 7.1% 结果和公开测试边界。',
                'issues': [],
                'reviewSubagent': {
                    'version': 1, 'taskName': 'single-review-2607-00001',
                    'paperId': paper_id, 'singleFileOnly': True,
                    'isolatedContext': True, 'model': 'gpt-5.6-terra',
                    'reasoningEffort': 'high',
                },
                'imageFindings': [],
            }), encoding='utf-8')
            batch_output = current / 'manual-review-attestation-2026-07-10.json'
            batch_output.write_text('{"batch":"untouched"}', encoding='utf-8')
            with mock.patch.object(publish_module, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        assemble_manual_review, 'load_publish_to_blog',
                        return_value=publish_module,
                    ), mock.patch.object(sys, 'argv', [
                        'assemble-manual-review-attestation.py',
                        '--date', '2026-07-10', '--include-id', paper_id,
                    ]), contextlib.redirect_stdout(io.StringIO()):
                assemble_manual_review.main()
            payload = __import__('json').loads(output_path.read_text(encoding='utf-8'))
            self.assertEqual(payload['publicationScope'], scope)
            self.assertEqual(len(payload['files']), 1)
            self.assertEqual(batch_output.read_text(encoding='utf-8'), '{"batch":"untouched"}')

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
        for parser, argv in (
            (review_blog.parse_options, [
                '--include-id', '2607.00001', '--include-id', '2607.00002',
            ]),
            (push_blog.parse_options, [
                '--include-id', '2607.00001', '--include-id', '2607.00002',
            ]),
            (push_blog.parse_options, [
                '--include-id', '2607.00001', '--require-visual-plan',
            ]),
        ):
            with self.subTest(parser=parser.__module__, argv=argv), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    parser(module, argv)
                self.assertEqual(caught.exception.code, 2)
        self.assertEqual(
            review_blog.parse_options(module, [
                '--date', '2026-07-10', '--include-id', '2607.00001',
            ]),
            ('2026-07-10', '2607.00001'),
        )
        self.assertEqual(
            push_blog.parse_options(module, [
                '--date', '2026-07-10', '--include-id', '2607.00001',
            ]),
            ('2026-07-10', False, '2607.00001'),
        )

    def test_generate_entry_only_calls_generation(self):
        generate = mock.Mock()
        module = SimpleNamespace(main=generate)
        with mock.patch.object(generate_blog, 'load_publish_to_blog', return_value=module):
            # The executable guard is not active on import; call the same entry target.
            generate_blog.load_publish_to_blog().main()
        generate.assert_called_once_with()

    def test_review_page_loader_restores_manual_v4_canonical_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / '2026-07-10-paper.md'
            page.write_text('''---
title: "Rendered title"
paper_digest_page_type: paper
paper_digest_arxiv_id: "2607.00001"
---
body
''', encoding='utf-8')
            canonical = {
                'arxivId': '2607.00001v1',
                'title': 'Canonical title',
                'analysisManifest': {
                    'contracts': {'manualDepth': 'full-text-evidence-v4'},
                },
            }
            module = SimpleNamespace(
                is_visual_summary_asset_path=lambda _path, _date: False,
                normalize_publish_arxiv_id=lambda value: str(value).removesuffix('v1'),
                PublishDataValidationError=ValueError,
            )
            slugs, scored = review_blog.read_generated_pages(
                module, '2026-07-10', [page], [canonical],
            )
            self.assertEqual(slugs, {'2607.00001': 'paper'})
            self.assertEqual(scored[0][1]['title'], 'Canonical title')
            self.assertEqual(
                scored[0][1]['analysisManifest']['contracts']['manualDepth'],
                'full-text-evidence-v4',
            )

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
                reusable_verified_publication_review=mock.Mock(return_value=None),
                has_publication_evidence_for_generation=mock.Mock(return_value=False),
                _git_relative_manifest=mock.Mock(return_value=[]),
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
                save_review_page_checkpoint=mock.Mock(),
                clear_review_page_checkpoints=mock.Mock(),
                _sha256_file=mock.Mock(return_value='a' * 64),
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
            preflight_post_publish_visual_capability=mock.Mock(return_value=True),
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
        module.preflight_post_publish_visual_capability.assert_called_once_with(
            '2026-07-10', require_visual_plan=False,
        )
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
            preflight_post_publish_visual_capability=mock.Mock(return_value=True),
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
            preflight_post_publish_visual_capability=mock.Mock(return_value=True),
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

    def test_daily_push_rejects_legacy_generation_before_git_push(self):
        path = Path('/tmp/content/posts/2026-07-10.md')
        module = SimpleNamespace(
            PublishDataValidationError=ValueError,
            validate_publish_target=mock.Mock(),
            get_today_bj=lambda value=None: value or '2026-07-10',
            validate_publish_date=lambda value: value,
            blog_publication_lock=lambda _date: contextlib.nullcontext(),
            load_verified_review_receipt=mock.Mock(return_value=([path], Path('receipt.json'))),
            preflight_post_publish_visual_capability=mock.Mock(
                side_effect=ValueError('schema v1 仅支持历史维护发布')
            ),
            validate_git_publish_branch=mock.Mock(),
            validate_git_index=mock.Mock(),
            git_push=mock.Mock(return_value=True),
            plan_post_publish_visual_assets=mock.Mock(return_value=True),
        )
        with mock.patch.object(push_blog, 'require_external_runtime'), \
                mock.patch.object(push_blog, 'load_publish_to_blog', return_value=module), \
                mock.patch.object(sys, 'argv', [
                    'push-blog.py', '--date', '2026-07-10', '--require-visual-plan',
                ]), contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(SystemExit) as caught:
            push_blog.main()
        self.assertEqual(caught.exception.code, 1)
        module.git_push.assert_not_called()
        module.plan_post_publish_visual_assets.assert_not_called()

    def test_legacy_maintenance_push_skips_visual_planning_explicitly(self):
        path = Path('/tmp/content/posts/2026-07-10.md')
        module = SimpleNamespace(
            PublishDataValidationError=ValueError,
            validate_publish_target=mock.Mock(),
            get_today_bj=lambda value=None: value or '2026-07-10',
            validate_publish_date=lambda value: value,
            blog_publication_lock=lambda _date: contextlib.nullcontext(),
            load_verified_review_receipt=mock.Mock(return_value=([path], Path('receipt.json'))),
            preflight_post_publish_visual_capability=mock.Mock(return_value=False),
            validate_git_publish_branch=mock.Mock(),
            validate_git_index=mock.Mock(),
            git_push=mock.Mock(return_value=True),
            plan_post_publish_visual_assets=mock.Mock(return_value=True),
        )
        output = io.StringIO()
        with mock.patch.object(push_blog, 'require_external_runtime'), \
                mock.patch.object(push_blog, 'load_publish_to_blog', return_value=module), \
                mock.patch.object(sys, 'argv', ['push-blog.py', '--date', '2026-07-10']), \
                contextlib.redirect_stdout(output):
            push_blog.main()
        module.git_push.assert_called_once()
        module.plan_post_publish_visual_assets.assert_not_called()
        self.assertIn('历史维护博客推送完成', output.getvalue())


if __name__ == '__main__':
    unittest.main()

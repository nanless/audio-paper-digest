import importlib.util
import contextlib
import hashlib
import io
import json
import os
import subprocess
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODULE_PATH = os.path.join(ROOT, 'scripts', 'publish-to-blog.py')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
SPEC = importlib.util.spec_from_file_location('publish_to_blog', MODULE_PATH)
publish_to_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish_to_blog)


def valid_png(payload_suffix=b'', width=768, height=1200):
    def chunk(kind, payload):
        return (
            struct.pack('>I', len(payload)) + kind + payload
            + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
        )
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)
    # Valid 8-bit grayscale rows. Change the final pixel to produce a distinct
    # but still structurally valid PNG when callers request a suffix.
    scanline = bytearray((width + 1) * height)
    if payload_suffix:
        scanline[-1] = zlib.crc32(payload_suffix) & 0xff
    return publish_to_blog.PNG_SIGNATURE + chunk(b'IHDR', ihdr) + chunk(
        b'IDAT', zlib.compress(bytes(scanline))
    ) + chunk(b'IEND', b'')


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


def save_bound_review_receipt(date_str, paths, hugo_gate='hugo', expected_base_head=None):
    repo = Path(publish_to_blog.BLOG_REPO).resolve()
    paper_id = '2607.99999'
    paper_page = repo / 'content' / 'posts' / f'{date_str}-visual-gate-paper.md'
    paper_page.parent.mkdir(parents=True, exist_ok=True)
    paper_page.write_text(
        '---\npaper_digest_page_type: paper\n'
        f'paper_digest_arxiv_id: "{paper_id}"\n---\n'
        'body\n', encoding='utf-8',
    )
    index_page = repo / 'content' / 'posts' / f'{date_str}-visual-gate-index.md'
    index_page.write_text(
        '---\npaper_digest_page_type: index\n---\n'
        'index\n', encoding='utf-8',
    )
    paths.extend([paper_page, index_page])
    manifest = publish_to_blog.save_generation_manifest(date_str, paths)
    results = {}
    for path in paths:
        path = Path(path).resolve()
        if path.is_file():
            results[str(path)] = {
                'passed': True,
                'reviewedSha256': publish_to_blog._sha256_file(path),
            }
    return publish_to_blog.save_review_receipt(
        date_str, paths, hugo_gate,
        expected_base_head=expected_base_head,
        generation_manifest=manifest,
        reviewed_results=results,
    )


class PublishToBlogReviewTest(unittest.TestCase):
    def test_visual_capability_preflight_rejects_legacy_before_daily_push(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(publish_to_blog, 'CURRENT_DIR', Path(tmp)):
            manifest = publish_to_blog.generation_manifest_path('2026-07-10')
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps({
                'schemaVersion': 1,
                'date': '2026-07-10',
                'files': [{'path': 'content/posts/2026-07-10.md', 'deleted': False}],
                'category': '论文速递',
                'visualSummaryRequired': False,
                'digestCoverRequired': False,
            }), encoding='utf-8')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(publish_to_blog.preflight_post_publish_visual_capability(
                    '2026-07-10', require_visual_plan=False,
                ))
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, '仅支持历史维护发布'
            ):
                publish_to_blog.preflight_post_publish_visual_capability(
                    '2026-07-10', require_visual_plan=True,
                )

    def test_schema_v3_visual_capability_preflight_accepts_bound_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'current'
            page = posts / '2026-07-10-paper.md'
            page.write_text(
                '---\npaper_digest_page_type: paper\n'
                'paper_digest_arxiv_id: "2607.00001"\n---\nbody\n',
                encoding='utf-8',
            )
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_to_blog.save_generation_manifest(
                    '2026-07-10', [page],
                    input_fingerprint='a' * 64,
                    template_fingerprint='b' * 64,
                    base_head='c' * 40,
                    published_papers=[{'arxivId': '2607.00001'}],
                )
                self.assertTrue(publish_to_blog.preflight_post_publish_visual_capability(
                    '2026-07-10', require_visual_plan=True,
                ))

    def test_receipt_reports_actual_per_file_image_review_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            first = posts / '2026-07-10-first.md'
            second = posts / '2026-07-10-second.md'
            first.write_text('first\n', encoding='utf-8')
            second.write_text('second\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [first, second])
                results = {
                    str(first.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(first),
                        'imageReviewMode': 'deterministic_only',
                    },
                    str(second.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(second),
                        'imageReviewMode': 'multimodal',
                    },
                }
                receipt_path = publish_to_blog.save_review_receipt(
                    '2026-07-10', [first, second], 'hugo',
                    generation_manifest=manifest, reviewed_results=results,
                )
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            self.assertEqual(receipt['imageReview']['mode'], 'mixed')
            self.assertEqual(
                receipt['postPublishVisuals'], 'not_applicable_legacy_maintenance'
            )
            self.assertEqual(
                {item['imageReviewMode'] for item in receipt['files']},
                {'deterministic_only', 'multimodal'},
            )

    def test_generation_cli_rejects_missing_unknown_and_duplicate_flags(self):
        for argv in (
            ['--date'],
            ['--unknown', 'value'],
            ['--cat', '论文速递'],
            ['--date', '2026-07-10', '--date', '2026-07-11'],
            ['--push'],
        ):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    publish_to_blog.parse_generation_args(argv)
                self.assertEqual(caught.exception.code, 2)
        parsed = publish_to_blog.parse_generation_args([
            '--date', '2026-07-10',
            '--exclude-id', '2607.00001',
            '--exclude-id', '2607.00002',
        ])
        self.assertEqual(parsed['excluded_ids'], ['2607.00001', '2607.00002'])

    def test_empty_generation_invalidates_same_date_stale_stage_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            current.mkdir()
            names = (
                'blog-generation-manifest-2026-07-10.json',
                'blog-review-receipt-2026-07-10.json',
                'blog-review-failure-2026-07-10.json',
                'blog-generation-journal-2026-07-10.json',
            )
            for name in names:
                (current / name).write_text('{}', encoding='utf-8')
            stage = current / 'blog-generation-stage-2026-07-10'
            stage.mkdir()
            (stage / 'stale.md').write_text('stale', encoding='utf-8')
            options = {
                'data_file': None,
                'target_date': '2026-07-10',
                'category': '论文速递',
                'publish_all': False,
                'excluded_ids': [],
            }
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        publish_to_blog, 'validate_publish_target',
                        return_value=(Path(tmp), Path(tmp) / 'posts'),
                    ), \
                    mock.patch.object(publish_to_blog, 'load_papers', return_value=[]), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '没有论文可生成',
                ):
                    publish_to_blog.generate_main(options)
            for name in names:
                self.assertFalse((current / name).exists(), name)
            self.assertFalse(stage.exists())

    def test_empty_generation_preserves_remote_verified_publication_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            current.mkdir()
            date_str = '2026-07-10'
            generation = current / f'blog-generation-manifest-{date_str}.json'
            receipt = current / f'blog-review-receipt-{date_str}.json'
            generation.write_text('{"schemaVersion":3}', encoding='utf-8')
            receipt.write_text(json.dumps({
                'schemaVersion': 3,
                'date': date_str,
                'publicationCommit': 'a' * 40,
                'remoteVerifiedOid': 'a' * 40,
                'remoteVerifiedAt': '2026-07-10T12:00:00+08:00',
            }), encoding='utf-8')
            options = {
                'data_file': None,
                'target_date': date_str,
                'category': '论文速递',
                'publish_all': False,
                'excluded_ids': [],
            }
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        publish_to_blog, 'validate_publish_target',
                        return_value=(Path(tmp), Path(tmp) / 'posts'),
                    ), \
                    mock.patch.object(publish_to_blog, 'load_papers', return_value=[]), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '已保留既有 generation/review/push 证据',
                ):
                    publish_to_blog.generate_main(options)
            self.assertTrue(generation.is_file())
            self.assertTrue(receipt.is_file())

    def test_historical_generation_prefers_exact_controlled_archive_when_current_is_newer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current-deep.json'
            current.write_text(json.dumps({
                'papers': [{'arxivId': '2607.00002', 'fetchBatchDate': '2026-07-11'}],
            }), encoding='utf-8')
            archive = root / 'archive'
            archived = archive / '2026-07-10' / 'deep-analysis-result.json'
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({
                'papers': [{'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-10'}],
            }), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'ARCHIVE_DIR', archive), \
                    mock.patch.object(
                        publish_to_blog, 'resolve_deep_analysis_result_path',
                        return_value=current,
                    ), \
                    contextlib.redirect_stdout(io.StringIO()):
                selected = publish_to_blog.select_generation_data_file(
                    None, '2026-07-10', publish_all=False,
                )
            self.assertEqual(Path(selected), archived)

    def test_blog_review_concurrency_defaults_to_five_and_reads_project_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PD_BLOG_REVIEW_CONCURRENCY', None)
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CONCURRENCY': '12'}):
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CONCURRENCY': 'invalid'}):
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 5)

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
                mock.patch.object(publish_to_blog, 'get_blog_review_chunk_chars', return_value=4000), \
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

    def test_review_removes_exact_duplicate_long_prose(self):
        paragraph = '训练数据依赖冻结的预训练模型，并使用人工标注档案完成验证。' * 5
        content = f'''---
title: "Duplicate"
---
{paragraph}

中间段落用于分隔两处内容，并保留正常结构。

{paragraph}
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            with open(path, encoding='utf-8') as reviewed_file:
                reviewed = reviewed_file.read()
            self.assertTrue(fixed)
            self.assertEqual(reviewed.count(paragraph), 1)
            self.assertTrue(any('完全重复' in issue for issue in issues))
        finally:
            os.unlink(path)

    def test_review_blocks_inconsistent_markdown_table_shape(self):
        content = '''---
title: "Bad table"
---
| 方法 | 指标 | 速度 |
| --- | --- | --- |
| Baseline | 1.0 |
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            self.assertFalse(fixed)
            self.assertTrue(any('表格列数不一致' in issue for issue in issues))
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

    def test_review_filters_unclosed_fence_claim_when_fences_are_balanced(self):
        issues = [{
            'severity': 'error',
            'type': 'markdown',
            'description': '文档末尾存在孤立的代码块开始标记，但没有结束标记。',
            'auto_fixable': True,
        }]
        self.assertEqual(
            publish_to_blog.filter_false_positive_review_issues('正文没有代码块。', issues),
            [],
        )
        self.assertEqual(
            publish_to_blog.filter_false_positive_review_issues(
                '```text\n未闭合', issues,
            ),
            issues,
        )

    def test_required_text_review_fails_closed_on_non_json_and_missing_fields(self):
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value='无法判断'):
            passed, issues, _ = publish_to_blog.llm_review_post('正文', '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_required_text_review_retries_truncated_protocol_response(self):
        responses = iter([
            '{"passed": }',
            '{"passed": true, "issues": []}',
        ])
        with mock.patch.object(
            publish_to_blog,
            'call_llm_api',
            side_effect=lambda *args, **kwargs: next(responses),
        ) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post('正文', '标题', required=True)

        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, '正文')
        self.assertEqual(call.call_count, 2)
        self.assertIn('上一次响应不完整', call.call_args_list[1].args[0])

        malformed = '{"passed": true, "issues": [{"severity": "warning"}]}'
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value=malformed):
            passed, issues, _ = publish_to_blog.llm_review_post('正文', '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_required_text_review_retries_original_after_format_repair_fails(self):
        responses = iter([
            '审查结论存在，但不是 JSON；这是一个长度超过短响应阈值的非结构化审查结果，必须先尝试格式修复。',
            '{"passed": true, "issues": [',
            '{"passed": true, "issues": []}',
        ])
        with mock.patch.object(
            publish_to_blog,
            'call_llm_api',
            side_effect=lambda *args, **kwargs: next(responses),
        ) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post('正文', '标题', required=True)

        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, '正文')
        self.assertEqual(call.call_count, 3)
        self.assertIn('响应及其格式修复均无效', call.call_args_list[2].args[0])

    def test_required_repaired_text_review_filters_prompt_only_angle_tags(self):
        repaired_issue = {
            'passed': False,
            'issues': [{
                'severity': 'error',
                'type': 'html_tag',
                'description': '文本中出现了 `<S>`，未被反引号包裹。',
                'auto_fixable': False,
                'fix_instruction': '',
            }],
        }
        responses = iter([
            '这不是 JSON，但响应足够长，会先进入格式修复流程。',
            __import__('json').dumps(repaired_issue, ensure_ascii=False),
        ])
        with mock.patch.object(
            publish_to_blog,
            'call_llm_api',
            side_effect=lambda *args, **kwargs: next(responses),
        ):
            passed, issues, reviewed = publish_to_blog.llm_review_post('正文没有尖括号标签。', '标题', required=True)

        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, '正文没有尖括号标签。')

    def test_required_image_review_fails_closed_on_non_json_and_invalid_severity(self):
        content = '![结果图](https://arxiv.org/result.png)'
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value='大概没问题'):
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

        malformed = '{"passed": true, "issues": [{"severity": "critical", "description": "x"}]}'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=malformed):
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_generate_page_handles_missing_tags_without_key_error(self):
        markdown, slug = publish_to_blog.generate_paper_page({
            'title': 'No tags',
            'arxivId': '2607.00001',
            'parsed': {'score': '1'},
            'visualSummaryCards': [
                {'kind': kind, 'label': kind, 'url': f'/card/{kind}.png'}
                for kind in publish_to_blog.VISUAL_SUMMARY_KINDS
            ],
        }, '2026-07-10')
        self.assertEqual(slug, 'no-tags-2607-00001')
        self.assertIn('tags: []', markdown)

    def test_same_title_slug_is_disambiguated_by_normalized_arxiv_id(self):
        first = publish_to_blog.paper_slug('Same title', '2607.00001v2')
        second = publish_to_blog.paper_slug('Same title', '2607.00002')
        self.assertEqual(first, 'same-title-2607-00001')
        self.assertEqual(second, 'same-title-2607-00002')

    def test_text_review_covers_every_chunk(self):
        content = 'A' * 7990 + '\nSECOND-CHUNK-MARKER\n' + 'B' * 100
        valid = '{"passed": true, "issues": []}'
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CHUNK_CHARS': '8000'}), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=valid) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post(content, '标题', required=True)
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, content)
        self.assertGreater(call.call_count, 1)
        prompts = ''.join(item.args[0] for item in call.call_args_list)
        self.assertIn('SECOND-CHUNK-MARKER', prompts)
        self.assertIn('AAAA', prompts)
        self.assertTrue(all(item.kwargs['structured_output'] for item in call.call_args_list))

    def test_review_chunk_budget_defaults_to_8000_and_is_bounded(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(publish_to_blog.get_blog_review_chunk_chars(), 8000)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CHUNK_CHARS': '100'}):
            self.assertEqual(publish_to_blog.get_blog_review_chunk_chars(), 4000)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CHUNK_CHARS': '99999'}):
            self.assertEqual(publish_to_blog.get_blog_review_chunk_chars(), 16000)

    def test_review_split_keeps_table_header_with_separator(self):
        content = 'A' * 20 + '\n| 方法 | 得分 |\n| --- | --- |\n| A | 1 |\n'
        chunks = publish_to_blog.split_review_content(content, limit=36)
        table_chunk = next(chunk for chunk in chunks if '| 方法 | 得分 |' in chunk)
        self.assertIn('| --- | --- |', table_chunk)
        self.assertEqual(''.join(chunks), content)

    def test_image_review_sends_actual_image_payload(self):
        image = {'media_type': 'image/png', 'data': 'cG5nLWJ5dGVz'}
        response = '{"passed": true, "issues": []}'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=response) as call:
            passed, issues = publish_to_blog.multimodal_review_images(
                '![实验曲线](https://arxiv.org/curve.png)', '标题', required=True
            )
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(call.call_args.kwargs['images'], [image])
        self.assertTrue(call.call_args.kwargs['use_secondary'])
        self.assertTrue(call.call_args.kwargs['structured_output'])
        self.assertIn('正文附近上下文', call.call_args.args[0])

    def test_image_review_prompt_contains_nearby_body_context(self):
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        response = '{"passed": true, "issues": []}'
        content = '## 实验结果\n前文指标提升 12%。\n![消融曲线](https://example.com/a.png)\n后文解释低频误差。'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
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

        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', side_effect=load), \
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

    def test_image_review_skips_secondary_call_when_secondary_model_is_unconfigured(self):
        content = '![结果图](https://arxiv.org/result.png)'
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(publish_to_blog, 'call_llm_api') as call:
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        call.assert_not_called()

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
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '已配置代理 peer'):
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
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '已配置代理 peer'):
                publish_to_blog._download_review_image('https://example.com/a.png')

    def test_image_download_accepts_the_explicit_proxy_peer_after_public_url_validation(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('127.0.0.1', 7897)
        response = mock.Mock()
        response.raw._connection.sock = sock
        response.status_code = 200
        response.headers = {'Content-Type': 'image/png', 'Content-Length': '8'}
        response.iter_content.return_value = [b'\x89PNG\r\n\x1a\n']
        session = mock.MagicMock()
        session.get.return_value = response
        def resolve(host, *_args, **_kwargs):
            address = '127.0.0.1' if host == '127.0.0.1' else '93.184.216.34'
            return [(publish_to_blog.socket.AF_INET, publish_to_blog.socket.SOCK_STREAM, 6, '', (address, 443))]

        with mock.patch.object(publish_to_blog.socket, 'getaddrinfo', side_effect=resolve), \
                mock.patch('requests.Session', return_value=session), \
                mock.patch.object(publish_to_blog, 'get_required_fetch_proxy', return_value='http://127.0.0.1:7897'):
            image = publish_to_blog._download_review_image('https://example.com/a.png')
        self.assertEqual(image['media_type'], 'image/png')
        response.close.assert_called_once()

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
                contextlib.redirect_stderr(io.StringIO()) as output:
            with self.assertRaises(SystemExit) as raised:
                publish_to_blog.main()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn('generate-blog.py', output.getvalue())
        review.assert_not_called()
        push.assert_not_called()

    def test_git_push_rejects_unreviewed_existing_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, remote = init_blog_repo(tmp, with_remote=True)
            (repo / 'README.md').write_text('local commit\n', encoding='utf-8')
            git(repo, 'add', '--', 'README.md')
            git(repo, 'commit', '-m', 'local pending')
            local_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                self.assertFalse(publish_to_blog.git_push('2026-07-10', []))
            remote_head = git(remote, 'rev-parse', 'refs/heads/main').stdout.strip()
            self.assertNotEqual(remote_head, local_head)

    def test_git_push_stages_only_manifest_with_vcs_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, remote = init_blog_repo(tmp, with_remote=True)
            path = posts / '2026-07-10.md'
            path.write_text('content', encoding='utf-8')
            original_env = publish_to_blog.build_child_process_env
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', Path(tmp) / 'data' / 'current'), \
                    mock.patch.object(publish_to_blog, 'build_child_process_env', side_effect=original_env) as env:
                paths = [path]
                save_bound_review_receipt('2026-07-10', paths)
                self.assertTrue(publish_to_blog.git_push('2026-07-10', paths))
            changed_paths = git(repo, 'show', '--pretty=format:', '--name-only', 'HEAD').stdout.splitlines()
            self.assertEqual(set(changed_paths), {
                'content/posts/2026-07-10.md',
                'content/posts/2026-07-10-visual-gate-index.md',
                'content/posts/2026-07-10-visual-gate-paper.md',
            })
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
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', Path(tmp) / 'data' / 'current'), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                paths = [path]
                save_bound_review_receipt('2026-07-10', paths)
                self.assertFalse(publish_to_blog.git_push('2026-07-10', paths))
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
            repo, content_dir, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            old_page = content_dir / '2026-07-10-old.md'
            old_page.write_text('original', encoding='utf-8')
            git(repo, 'add', '--', 'content/posts/2026-07-10-old.md')
            git(repo, 'commit', '-m', 'existing generated page')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
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
            self.assertTrue((content_dir / '2026-07-10.md').is_file())

    def test_generation_explicit_exclusion_is_exact_and_fails_on_unknown_id(self):
        papers = [
            {'arxivId': '2607.00001v2', 'title': 'keep'},
            {'arxivId': '2607.00002', 'title': 'exclude'},
        ]
        kept, excluded = publish_to_blog.exclude_papers_for_publish(
            papers, ['arXiv:2607.00002v1']
        )
        self.assertEqual([paper['title'] for paper in kept], ['keep'])
        self.assertEqual(excluded, ['2607.00002'])
        with self.assertRaisesRegex(
            publish_to_blog.PublishDataValidationError, '未命中当前发布批次'
        ):
            publish_to_blog.exclude_papers_for_publish(papers, ['2607.99999'])

    def test_review_receipt_detects_any_post_review_file_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                paths, _receipt = publish_to_blog.load_verified_review_receipt('2026-07-10')
                self.assertEqual(set(paths), {path.resolve() for path in publish_paths})
                page.write_text('changed after review\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'review 后已变更'):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')

    def test_index_blob_must_match_review_receipt_after_git_add(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                receipt, _path, _head = publish_to_blog._load_push_receipt('2026-07-10')
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                page.write_text('unreviewed race\n', encoding='utf-8')
                git(repo, 'add', '--', 'content/posts/2026-07-10.md')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'index.*review',
                ):
                    publish_to_blog.validate_git_index_against_review_receipt(receipt, publish_paths)

    def test_index_deletion_semantics_must_match_review_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10-old.md'
            page.write_text('old\n', encoding='utf-8')
            git(repo, 'add', '--', 'content/posts/2026-07-10-old.md')
            git(repo, 'commit', '-m', 'old page')
            page.unlink()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                receipt, _path, _head = publish_to_blog._load_push_receipt('2026-07-10')
                # Not staged yet: index still contains the supposedly deleted page.
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'index.*仍包含',
                ):
                    publish_to_blog.validate_git_index_against_review_receipt(receipt, publish_paths)
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                publish_to_blog.validate_git_index_against_review_receipt(receipt, publish_paths)

    def test_committed_blob_must_match_review_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                receipt, _path, _head = publish_to_blog._load_push_receipt('2026-07-10')
                page.write_text('changed by hook\n', encoding='utf-8')
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                git(repo, 'commit', '-m', 'tampered commit')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '提交.*review',
                ):
                    publish_to_blog.validate_git_commit_against_review_receipt(receipt, publish_paths)

    def test_incremental_review_selects_only_modified_failed_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            passed = posts / '2026-07-10-passed.md'
            failed = posts / '2026-07-10-failed.md'
            passed.write_text('passed\n', encoding='utf-8')
            failed.write_text('failed before fix\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [passed, failed],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [passed, failed], manifest, 'a' * 40, {
                        str(passed.resolve()): {
                            'passed': True,
                            'reviewedSha256': publish_to_blog._sha256_file(passed),
                        },
                        str(failed.resolve()): {'passed': False},
                    },
                )
                failed.write_text('failed after fix\n', encoding='utf-8')
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [passed, failed], manifest, 'a' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [failed.resolve()])
            self.assertEqual(plan['unchangedFailed'], [])
            self.assertTrue(plan['priorResults'][str(passed.resolve())]['passed'])

    def test_incremental_review_rechecks_only_changed_passed_and_failed_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            passed = posts / '2026-07-10-passed.md'
            failed = posts / '2026-07-10-failed.md'
            passed.write_text('passed\n', encoding='utf-8')
            failed.write_text('failed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [passed, failed],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [passed, failed], manifest, 'b' * 40, {
                        str(passed.resolve()): {
                            'passed': True,
                            'reviewedSha256': publish_to_blog._sha256_file(passed),
                        },
                        str(failed.resolve()): {'passed': False},
                    },
                )
                passed.write_text('tampered\n', encoding='utf-8')
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [passed, failed], manifest, 'b' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertIsNone(plan['reason'])
            self.assertEqual(set(plan['paths']), {passed.resolve(), failed.resolve()})

    def test_incremental_review_reuses_passes_across_manifest_base_and_protocol_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            passed = posts / '2026-07-10-passed.md'
            pending = posts / '2026-07-10-pending.md'
            passed.write_text('passed\n', encoding='utf-8')
            pending.write_text('pending\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='1' * 64):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [passed, pending],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [passed, pending], manifest, 'a' * 40, {
                        str(passed.resolve()): {
                            'passed': True,
                            'reviewedSha256': publish_to_blog._sha256_file(passed),
                        },
                        str(pending.resolve()): {
                            'passed': False, 'completed': False, 'failureKind': 'pending',
                        },
                    },
                )
            manifest_data = json.loads(manifest.read_text(encoding='utf-8'))
            manifest_data['generatedAt'] = 'changed-without-changing-pages'
            manifest.write_text(json.dumps(manifest_data), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='2' * 64):
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [passed, pending], manifest, 'b' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [pending.resolve()])
            self.assertEqual(plan['reusedPassed'], 1)
            self.assertTrue(plan['priorResults'][str(passed.resolve())]['passed'])
            self.assertEqual(
                plan['priorResults'][str(passed.resolve())]['reviewProtocolFingerprint'],
                '1' * 64,
            )

    def test_successful_receipt_passes_survive_new_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='3' * 64):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                reviewed = {
                    str(page.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(page),
                    },
                }
                publish_to_blog.save_review_receipt(
                    '2026-07-10', [page], 'hugo',
                    generation_manifest=manifest, reviewed_results=reviewed,
                )
                cache_path = publish_to_blog.review_pass_cache_path('2026-07-10')
                self.assertTrue(cache_path.is_file())
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                self.assertFalse(publish_to_blog.review_receipt_path('2026-07-10').exists())
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'f' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [])
            self.assertEqual(plan['reusedPassed'], 1)
            cache = json.loads(cache_path.read_text(encoding='utf-8'))
            self.assertEqual(cache['schemaVersion'], 1)
            self.assertEqual(cache['files'][0]['sha256'], publish_to_blog._sha256_file(page))

    def test_incremental_review_retries_unchanged_transient_but_blocks_unchanged_content_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            transient = posts / '2026-07-10-transient.md'
            content = posts / '2026-07-10-content.md'
            transient.write_text('same transient\n', encoding='utf-8')
            content.write_text('same content\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [transient, content],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [transient, content], manifest, 'c' * 40, {
                        str(transient.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'transient',
                        },
                        str(content.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'content',
                        },
                    },
                )
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [transient, content], manifest, 'c' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [transient.resolve()])
            self.assertEqual(plan['unchangedFailed'], [content.resolve()])

    def test_review_worker_exception_becomes_checkpointable_transient_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp)
            paper = posts / '2026-07-10-paper.md'
            paper.write_text('body\n', encoding='utf-8')
            callbacks = []
            with mock.patch.object(
                publish_to_blog, '_review_single_paper',
                side_effect=publish_to_blog.PublishLLMUnavailable('temporary'),
            ):
                fixed, blocking, details = publish_to_blog.review_all_posts(
                    '2026-07-10', {'2607.00001': 'paper'},
                    [(0.0, {'arxivId': '2607.00001', 'title': 'Paper'}, {})],
                    content_dir=str(posts), review_paths=[paper], return_details=True,
                    result_callback=lambda path, result: callbacks.append((path, result)),
                )
            self.assertEqual(fixed, 0)
            self.assertEqual(blocking, 1)
            result = details[str(paper.resolve())]
            self.assertEqual(result['failureKind'], 'transient')
            self.assertTrue(result['completed'])
            self.assertEqual(len(callbacks), 1)

    def test_generation_install_journal_adopts_crash_after_replace_and_rejects_later_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            stage = current_dir / 'blog-generation-stage-2026-07-10' / 'posts'
            stage.mkdir(parents=True)
            staged_index = stage / '2026-07-10.md'
            staged_paper = stage / '2026-07-10-paper.md'
            staged_index.write_text('new index\n', encoding='utf-8')
            staged_paper.write_text('new paper\n', encoding='utf-8')
            journal_path = current_dir / 'blog-generation-journal-2026-07-10.json'
            journal = {'installation': None}
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_to_blog.prepare_generation_installation(
                    journal, journal_path, stage, posts, '2026-07-10',
                )
                first_record = journal['installation']['files'][0]
                first_target = repo / first_record['path']
                first_source = stage / first_target.name
                # Simulate SIGKILL after target replacement but before installed=true flush.
                first_target.write_text(first_source.read_text(encoding='utf-8'), encoding='utf-8')
                installed = publish_to_blog.resume_generation_installation(
                    journal, journal_path, stage,
                )
                self.assertEqual(set(installed), {
                    (posts / '2026-07-10.md').resolve(),
                    (posts / '2026-07-10-paper.md').resolve(),
                })
                self.assertTrue(all(
                    record['installed'] for record in journal['installation']['files']
                ))
                first_target.write_text('manual edit\n', encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '人工修改',
                ):
                    publish_to_blog.resume_generation_installation(
                        journal, journal_path, stage,
                    )

    def test_completed_generation_manifest_is_reusable_only_for_identical_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('generated\n', encoding='utf-8')
            base_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [page], input_fingerprint='a' * 64,
                    template_fingerprint='b' * 64, base_head=base_head,
                    published_papers=[{'arxivId': '2607.00001'}],
                )
                reused = publish_to_blog.reusable_generation_manifest(
                    '2026-07-10', 'a' * 64, 'b' * 64, base_head,
                )
                self.assertEqual(reused, ([page.resolve()], manifest))
                page.write_text('manual review edit\n', encoding='utf-8')
                self.assertIsNone(publish_to_blog.reusable_generation_manifest(
                    '2026-07-10', 'a' * 64, 'b' * 64, base_head,
                ))

    def test_template_fingerprint_includes_base_path_and_dependency_hashes(self):
        with mock.patch.object(publish_to_blog, 'BASE_PATH', '/one'):
            first = publish_to_blog.generation_template_fingerprint()
        with mock.patch.object(publish_to_blog, 'BASE_PATH', '/two'):
            second = publish_to_blog.generation_template_fingerprint()
        self.assertNotEqual(first, second)
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='f' * 64):
            dependency_changed = publish_to_blog.generation_template_fingerprint()
        self.assertNotEqual(first, dependency_changed)

    def test_review_protocol_fingerprint_binds_model_code_hugo_and_is_cached(self):
        completed = SimpleNamespace(stdout='hugo v0.test', stderr='', returncode=0)
        publish_to_blog._REVIEW_PROTOCOL_CACHE.clear()
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='a' * 64), \
                mock.patch.object(publish_to_blog.shutil, 'which', return_value='/missing/hugo'), \
                mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed) as run, \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'model-a'}):
            first = publish_to_blog.review_protocol_fingerprint()
            self.assertEqual(first, publish_to_blog.review_protocol_fingerprint())
            self.assertEqual(run.call_count, 1)
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='a' * 64), \
                mock.patch.object(publish_to_blog.shutil, 'which', return_value='/missing/hugo'), \
                mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'model-b'}):
            second = publish_to_blog.review_protocol_fingerprint()
        self.assertNotEqual(first, second)
        publish_to_blog._REVIEW_PROTOCOL_CACHE.clear()
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='a' * 64), \
                mock.patch.object(publish_to_blog.shutil, 'which', return_value='/missing/hugo'), \
                mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'model-a', 'PD_BLOG_REVIEW_MAX_TOKENS': '8000'}):
            third = publish_to_blog.review_protocol_fingerprint()
        self.assertNotEqual(first, third)

    def test_reusable_generation_manifest_rejects_empty_duplicate_and_bad_sha_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            manifest_path = current_dir / 'blog-generation-manifest-2026-07-10.json'
            base = {
                'schemaVersion': 2,
                'date': '2026-07-10',
                'inputFingerprint': 'a' * 64,
                'templateFingerprint': 'b' * 64,
                'baseHead': 'c' * 40,
            }
            cases = [
                [],
                [
                    {'path': 'content/posts/a.md', 'deleted': False, 'sha256': 'd' * 64},
                    {'path': 'content/posts/a.md', 'deleted': False, 'sha256': 'd' * 64},
                ],
                [{'path': 'content/posts/a.md', 'deleted': False, 'sha256': 'bad'}],
            ]
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                current_dir.mkdir(parents=True)
                for records in cases:
                    manifest_path.write_text(json.dumps({**base, 'files': records}), encoding='utf-8')
                    self.assertIsNone(publish_to_blog.reusable_generation_manifest(
                        '2026-07-10', 'a' * 64, 'b' * 64, 'c' * 40,
                    ))

    def test_reviewed_hash_gate_and_receipt_reject_post_review_deletion_or_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                reviewed = {
                    str(page.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(page),
                    },
                }
                publish_to_blog.validate_reviewed_file_hashes(
                    '2026-07-10', [page], manifest, reviewed,
                )
                page.write_text('changed after worker\n', encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'review 后发生变化',
                ):
                    publish_to_blog.validate_reviewed_file_hashes(
                        '2026-07-10', [page], manifest, reviewed,
                    )
                page.unlink()
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'review 期间消失',
                ):
                    publish_to_blog.save_review_receipt(
                        '2026-07-10', [page], 'hugo',
                        generation_manifest=manifest, reviewed_results=reviewed,
                    )

    def test_push_receipt_rejects_generation_manifest_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                save_bound_review_receipt('2026-07-10', [page])
                manifest_path = publish_to_blog.generation_manifest_path('2026-07-10')
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                manifest['generatedAt'] = 'tampered'
                manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'manifest 缺失或已变化',
                ):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')

    def test_same_date_blog_transaction_lock_is_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            current_dir = Path(tmp) / 'current'
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                with publish_to_blog.blog_transaction_lock('2026-07-10'):
                    with self.assertRaises(TimeoutError):
                        with publish_to_blog.blog_transaction_lock(
                            '2026-07-10', timeout_seconds=0.05,
                        ):
                            self.fail('same-date lock must not be acquired twice')
                with publish_to_blog.blog_transaction_lock(
                    '2026-07-11', timeout_seconds=0.05,
                ):
                    pass

    def test_repository_lock_serializes_different_publication_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            current_dir = Path(tmp) / 'current'
            repo = Path(tmp) / 'blog'
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                with publish_to_blog.blog_publication_lock('2026-07-10'):
                    with self.assertRaises(TimeoutError):
                        with publish_to_blog.blog_publication_lock(
                            '2026-07-11', timeout_seconds=0.05,
                        ):
                            self.fail('repository lock must serialize different dates')

    def test_corrupt_review_failure_kind_falls_back_to_full_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('content\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                state_path = publish_to_blog.save_review_failure_state(
                    '2026-07-10', [page], manifest, 'd' * 40, {
                        str(page.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'content',
                        },
                    },
                )
                state = json.loads(state_path.read_text(encoding='utf-8'))
                state['files'][0]['failureKind'] = 'unknown-kind'
                state_path.write_text(json.dumps(state), encoding='utf-8')
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'd' * 40,
                )
            self.assertEqual(plan['mode'], 'full')
            self.assertIn('失败类型非法', plan['reason'])

    def test_push_retries_exact_publication_commit_without_second_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            missing_remote = Path(tmp) / 'later-remote.git'
            git(repo, 'remote', 'add', 'origin', str(missing_remote))
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('generated\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                self.assertFalse(publish_to_blog.git_push('2026-07-10', publish_paths))
                publication_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                commit_count = git(repo, 'rev-list', '--count', 'HEAD').stdout.strip()
                subprocess.run(
                    ['git', 'init', '--bare', '--initial-branch=main', str(missing_remote)],
                    check=True, capture_output=True, text=True,
                )
                self.assertTrue(publish_to_blog.git_push('2026-07-10', publish_paths))
            self.assertEqual(git(repo, 'rev-parse', 'HEAD').stdout.strip(), publication_head)
            self.assertEqual(git(repo, 'rev-list', '--count', 'HEAD').stdout.strip(), commit_count)
            self.assertEqual(
                git(missing_remote, 'rev-parse', 'refs/heads/main').stdout.strip(),
                publication_head,
            )

    def test_review_receipt_rejects_base_head_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError,
                        '基线发生变化',
                    ):
                save_bound_review_receipt(
                    '2026-07-10', [page], expected_base_head='f' * 40,
                )

    def test_visual_summary_manifest_stages_single_infographic_and_attests_review(self):
        png = valid_png()
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            archive = Path(tmp) / 'data' / 'archive'
            source_root = archive / '2026-07-10' / 'visual-summaries'
            source_root.mkdir(parents=True)
            paper = {'arxivId': '2607.00001', 'analysis': 'audited', 'parsed': {'score': '8'}}
            analysis_sha = publish_to_blog._visual_summary_analysis_sha256(paper)
            prompt_sha = publish_to_blog._sha256_file(Path(ROOT) / 'prompts' / 'visual-summary.md')
            cards = {}
            for kind in publish_to_blog.VISUAL_SUMMARY_KINDS:
                source = source_root / '01-2607.00001-paper.png'
                source.write_bytes(png)
                cards[kind] = {
                    'status': 'complete', 'analysisSha256': analysis_sha,
                    'promptSha256': prompt_sha,
                    'assetSha256': publish_to_blog._sha256_file(source),
                    'assetPath': str(source),
                }
            manifest = current / 'visual-summary-manifest.json'
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps({
                'version': 2, 'batchDate': '2026-07-10', 'promptSha256': prompt_sha,
                'papers': {'2607.00001': {
                    'normalizedArxivId': '2607.00001', 'batchDate': '2026-07-10',
                    'rank': 1,
                    'analysisSha256': analysis_sha, 'promptSha256': prompt_sha,
                    'cards': cards,
                }},
            }), encoding='utf-8')
            stage_posts = current / 'blog-generation-stage-2026-07-10' / 'posts'
            stage_posts.mkdir(parents=True)
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'VISUAL_SUMMARY_ASSET_DIR', archive):
                enriched, assets = publish_to_blog.load_visual_summary_cards(
                    [paper], '2026-07-10', manifest,
                )
                self.assertEqual(len(enriched[0]['visualSummaryCards']), 1)
                self.assertNotIn('sourcePath', enriched[0]['visualSummaryCards'][0])
                staged_assets = publish_to_blog.stage_visual_summary_assets(assets, stage_posts)
                for source in staged_assets:
                    target = repo.resolve() / source.resolve().relative_to(stage_posts.parent.resolve())
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
                page = posts / '2026-07-10-paper.md'
                page.write_text(
                    '---\npaper_digest_page_type: paper\n'
                    'paper_digest_arxiv_id: "2607.00001"\n---\n'
                    + '\n'.join(f'![card]({asset["url"]})' for asset in assets),
                    encoding='utf-8',
                )
                paths = [page, *(repo / asset['repoRelativePath'] for asset in assets)]
                generation = publish_to_blog.save_generation_manifest('2026-07-10', paths)
                page_sha = publish_to_blog._sha256_file(page)
                results = {str(page.resolve()): {
                    'passed': True, 'completed': True, 'failureKind': None,
                    'reviewedSha256': page_sha,
                }}
                self.assertEqual(publish_to_blog.attest_visual_summary_assets(
                    '2026-07-10', paths, generation, results,
                ), 0)
                self.assertTrue(all(
                    results[str(Path(path).resolve())]['passed'] for path in paths
                ))
                publish_to_blog.validate_reviewed_file_hashes(
                    '2026-07-10', paths, generation, results,
                )
                loaded = publish_to_blog._load_review_image(assets[0]['url'])
                self.assertEqual(loaded['media_type'], 'image/png')

                original_manifest = json.loads(manifest.read_text(encoding='utf-8'))
                incomplete = json.loads(json.dumps(original_manifest))
                incomplete['papers']['2607.00001']['cards']['infographic']['status'] = 'pending'
                manifest.write_text(json.dumps(incomplete), encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '未完成',
                ):
                    publish_to_blog.load_visual_summary_cards([paper], '2026-07-10', manifest)

                stale = json.loads(json.dumps(original_manifest))
                stale['papers']['2607.00001']['analysisSha256'] = '0' * 64
                manifest.write_text(json.dumps(stale), encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '指纹已失效',
                ):
                    publish_to_blog.load_visual_summary_cards([paper], '2026-07-10', manifest)

    def test_generate_rejects_missing_visual_summary_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'missing.json'
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, '缺少强制视觉摘要',
            ):
                publish_to_blog.load_visual_summary_cards(
                    [{'arxivId': '2607.00001'}], '2026-07-10', missing,
                )

    def test_digest_cover_manifest_binds_summary_context_and_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'data' / 'current'
            archive = Path(tmp) / 'data' / 'archive'
            source = archive / '2026-07-10' / 'visual-summaries' / '00-digest-cover-2026-07-10.png'
            source.parent.mkdir(parents=True)
            source.write_bytes(valid_png())
            papers = [{
                'arxivId': '2607.00001', 'title': 'Top Paper',
                'parsed': {
                    'score': '9.0', 'primaryTaskTag': '#语音识别',
                    'tags': ['#语音识别'],
                },
            }]
            context = publish_to_blog._digest_cover_context(papers, '2026-07-10')
            data_sha = hashlib.sha256(json.dumps(
                context, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
            ).encode('utf-8')).hexdigest()
            prompt_sha = publish_to_blog._sha256_file(Path(ROOT) / 'prompts' / 'digest-cover.md')
            manifest = current / 'digest-cover-manifests' / '2026-07-10.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({
                'version': 1, 'batchDate': '2026-07-10',
                'dataSha256': data_sha, 'promptSha256': prompt_sha,
                'generationContext': context,
                'cover': {
                    'status': 'complete', 'dataSha256': data_sha,
                    'promptSha256': prompt_sha,
                    'assetPath': str(source),
                    'assetSha256': publish_to_blog._sha256_file(source),
                },
            }), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'DIGEST_COVER_ASSET_DIR', archive):
                loaded = publish_to_blog.load_digest_cover(papers, '2026-07-10', manifest)
                self.assertEqual(loaded['kind'], 'digest-cover')
                self.assertTrue(loaded['url'].endswith('/images/digest-covers/2026-07-10/cover.png'))

            stale = json.loads(manifest.read_text(encoding='utf-8'))
            stale['dataSha256'] = '0' * 64
            manifest.write_text(json.dumps(stale), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'DIGEST_COVER_ASSET_DIR', archive), \
                    self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '指纹'):
                publish_to_blog.load_digest_cover(papers, '2026-07-10', manifest)

    def test_post_publish_visuals_do_not_enter_generation_fingerprint(self):
        papers = [{'arxivId': '2607.1', 'title': 'Paper'}]
        self.assertEqual(
            publish_to_blog.generation_input_fingerprint(
                papers, '2026-07-10', '论文速递', False,
            ),
            publish_to_blog.generation_input_fingerprint(
                papers, '2026-07-10', '论文速递', False,
            ),
        )

    def test_legacy_digest_cover_verifier_uses_same_top10_context(self):
        papers = [
            {
                'arxivId': f'2607.{index:05d}',
                'title': f'Paper {index}',
                'parsed': {
                    'score': f'{10 - index / 10:.1f}',
                    'primaryTaskTag': '#语音识别',
                    'tags': ['#语音识别'],
                },
            }
            for index in range(1, 13)
        ]
        context = publish_to_blog._digest_cover_context(papers, '2026-07-10')
        self.assertEqual(len(context['ranking']), 10)
        self.assertEqual([item['rank'] for item in context['ranking']], list(range(1, 11)))
        self.assertEqual(context['ranking'][-1]['title'], 'Paper 10')

    def test_post_publish_planner_start_failure_does_not_undo_blog_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp)
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                manifest = publish_to_blog.generation_manifest_path('2026-07-10')
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest.write_text(json.dumps({'category': '论文速递'}), encoding='utf-8')
                with mock.patch.object(
                    publish_to_blog.subprocess, 'run', side_effect=OSError('node missing'),
                ):
                    self.assertFalse(
                        publish_to_blog.plan_post_publish_visual_assets('2026-07-10')
                    )

    def test_digest_cover_local_bytes_are_allowed_for_required_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            current = Path(tmp) / 'current'
            cover = repo / 'static/images/digest-covers/2026-07-10/cover.png'
            cover.parent.mkdir(parents=True)
            cover.write_bytes(valid_png())
            manifest_dir = current / 'digest-cover-manifests'
            manifest_dir.mkdir(parents=True)
            context = {
                'title': '语音/音乐/音频论文速递 2026-07-10',
                'batchDate': '2026-07-10', 'paperCount': 1,
                'hotDirections': [{'tag': '#语音识别', 'count': 1}],
                'ranking': [{'rank': 1, 'title': 'Paper', 'score': '8.0', 'primaryTask': '#语音识别'}],
            }
            (manifest_dir / '2026-07-10.json').write_text(json.dumps({
                'generationContext': context,
            }), encoding='utf-8')
            url = f'{publish_to_blog.BASE_PATH}/images/digest-covers/2026-07-10/cover.png'
            with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                    mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'DIGEST_COVER_MANIFEST_DIR', manifest_dir), \
                    mock.patch.object(
                        publish_to_blog, 'call_llm_api',
                        return_value='{"passed": true, "issues": []}',
                    ) as call:
                loaded = publish_to_blog._load_review_image(url)
                passed, issues = publish_to_blog.multimodal_review_images(
                    f'![cover]({url})', '汇总页', required=True,
                )
            self.assertEqual(loaded['media_type'], 'image/png')
            self.assertTrue(passed)
            self.assertEqual(issues, [])
            self.assertIn('TOP 10', call.call_args.args[0])
            self.assertIn('语音识别', call.call_args.args[0])

    def test_review_and_push_allow_generation_without_infographic(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10-paper.md'
            page.write_text('''---
paper_digest_page_type: paper
paper_digest_arxiv_id: "2607.00001"
---
body
''', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_to_blog.save_generation_manifest('2026-07-10', [page])
                loaded, _ = publish_to_blog.load_generation_manifest('2026-07-10')
                self.assertEqual(loaded, [page.resolve()])
                manifest_path = publish_to_blog.generation_manifest_path('2026-07-10')
                reviewed = {str(page.resolve()): {
                    'passed': True,
                    'reviewedSha256': publish_to_blog._sha256_file(page),
                }}
                publish_to_blog.save_review_receipt(
                    '2026-07-10', [page], 'hugo',
                    generation_manifest=manifest_path, reviewed_results=reviewed,
                )
                verified, _ = publish_to_blog.load_verified_review_receipt('2026-07-10')
                self.assertEqual(verified, [page.resolve()])

    def test_generation_rejects_duplicate_digest_cover_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            paths = []
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                save_bound_review_receipt('2026-07-10', paths)
                index = next(
                    Path(item) for item in paths
                    if Path(item).name.endswith('visual-gate-index.md')
                )
                cover_url = f'{publish_to_blog.BASE_PATH}/images/digest-covers/2026-07-10/cover.png'
                index.write_text(
                    index.read_text(encoding='utf-8') + f'![duplicate]({cover_url})\n',
                    encoding='utf-8',
                )
                publish_to_blog.save_generation_manifest('2026-07-10', paths)
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '提前引用',
                ):
                    publish_to_blog.load_generation_manifest('2026-07-10')

    def test_review_and_push_reject_any_post_publish_visual_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            index = posts / '2026-07-10.md'
            index.write_text('index\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_paths = [index]
                save_bound_review_receipt('2026-07-10', publish_paths)
                asset = repo / 'static/images/visual-summaries/2026-07-10/2607.99999/infographic.png'
                asset.parent.mkdir(parents=True, exist_ok=True)
                asset.write_bytes(publish_to_blog.PNG_SIGNATURE)
                publish_paths.append(asset)
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', publish_paths,
                )
                reviewed = {
                    str(path.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(path),
                    }
                    for path in publish_paths if path.is_file()
                }
                publish_to_blog.save_review_receipt(
                    '2026-07-10', publish_paths, 'hugo',
                    generation_manifest=manifest, reviewed_results=reviewed,
                )
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '发布后视觉资产',
                ):
                    publish_to_blog.load_generation_manifest('2026-07-10')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '发布后视觉资产',
                ):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')

    def test_generation_install_crash_adopts_binary_visual_asset(self):
        png = valid_png()
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            stage_posts = current / 'blog-generation-stage-2026-07-10' / 'posts'
            stage_posts.mkdir(parents=True)
            (stage_posts / '2026-07-10.md').write_text('index\n', encoding='utf-8')
            staged_asset = stage_posts.parent / 'static/images/visual-summaries/2026-07-10/2607.1/infographic.png'
            staged_asset.parent.mkdir(parents=True)
            staged_asset.write_bytes(png)
            journal_path = current / 'journal.json'
            journal = {'installation': None}
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                publish_to_blog.prepare_generation_installation(
                    journal, journal_path, stage_posts, posts, '2026-07-10',
                    staged_assets=[staged_asset],
                )
                record = next(item for item in journal['installation']['files'] if item['path'].endswith('.png'))
                target = repo / record['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(png)
                installed = publish_to_blog.resume_generation_installation(
                    journal, journal_path, stage_posts,
                )
                self.assertIn(target.resolve(), installed)
                self.assertEqual(target.read_bytes(), png)

    def test_precommit_hook_cannot_smuggle_unreviewed_commit_delta(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            hook = repo / '.git/hooks/pre-commit'
            hook.write_text('#!/bin/sh\necho injected > injected.txt\ngit add injected.txt\n', encoding='utf-8')
            hook.chmod(0o755)
            base = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                self.assertFalse(publish_to_blog.git_push('2026-07-10', publish_paths))
            self.assertEqual(git(repo, 'rev-parse', 'HEAD').stdout.strip(), base)
            self.assertEqual(git(repo, 'diff', '--cached', '--name-only').stdout, '')

    def test_push_adopts_exact_commit_after_receipt_write_crash_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, remote = init_blog_repo(tmp, with_remote=True)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                publish_paths = [page]
                receipt_path = save_bound_review_receipt('2026-07-10', publish_paths)
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                git(repo, 'commit', '-m', 'simulated commit before receipt persistence')
                committed = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
                self.assertNotIn('publicationCommit', receipt)
                self.assertTrue(publish_to_blog.git_push('2026-07-10', publish_paths))
                adopted = json.loads(receipt_path.read_text(encoding='utf-8'))
                self.assertEqual(adopted['publicationCommit'], committed)
            self.assertEqual(git(remote, 'rev-parse', 'refs/heads/main').stdout.strip(), committed)


if __name__ == '__main__':
    unittest.main()

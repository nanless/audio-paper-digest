import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location(
    'manual_review_blog_test', ROOT / 'scripts' / 'manual-review-blog.py',
)
manual_review_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manual_review_blog)


FILE_CHECKS = {
    'titleAndMetadata': True,
    'technicalNarrative': True,
    'factualClaims': True,
    'experimentComparisons': True,
    'reproducibility': True,
    'limitations': True,
    'scoring': True,
    'images': True,
}


def attestation():
    return {
        'version': 3,
        'mode': 'manual_complete',
        'agent': 'Codex',
        'basis': 'deterministic_and_manual_semantic_review',
        'reason': '逐文件核对技术叙事、事实、实验、复现、局限、评分与图片语义。',
        'checks': {
            'generationManifestVerified': True,
            'baseHeadVerified': True,
            'fileHashesVerified': True,
            'frontmatterVerified': True,
            'markdownVerified': True,
            'contentSemanticsVerified': True,
            'imageReferencesVerified': True,
            'hugoGateVerified': True,
        },
        'files': [{
            'path': 'content/posts/2026-08-25-paper.md',
            'sha256': 'a' * 64,
            'checks': dict(FILE_CHECKS),
            'notes': '已核对问题到方法、实验比较、复现条件和双层局限的论证链。',
            'reviewSubagent': {
                'version': 1, 'taskName': 'paper-review-2608-12345',
                'paperId': '2608.12345', 'singleFileOnly': True,
                'isolatedContext': True, 'model': 'gpt-5.6-terra',
                'reasoningEffort': 'high',
            },
            'imageFindings': [],
        }],
    }


class ManualReviewAttestationTest(unittest.TestCase):
    def write_payload(self, directory, payload):
        path = Path(directory) / 'attestation.json'
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        return path

    def test_accepts_exact_v3_per_file_semantic_attestation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self.write_payload(tmp, attestation())
            expected_digest = hashlib.sha256(path.read_bytes()).hexdigest()
            payload, digest = manual_review_blog._load_attestation(path)
        self.assertEqual(payload['version'], 3)
        self.assertEqual(payload['files'][0]['checks'], FILE_CHECKS)
        self.assertEqual(digest, expected_digest)

    def test_manual_single_cli_is_single_value_and_scope_is_fail_closed(self):
        class Module:
            class PublishDataValidationError(ValueError):
                pass

            @staticmethod
            def validate_publish_date(value):
                return value

            @staticmethod
            def _validate_active_publication_scope(_payload):
                return {'mode': 'single-paper', 'includeId': '2608.12345'}

        parsed = manual_review_blog._parse_args(Module, [
            '--date', '2026-08-25', '--attestation', '/tmp/a.json',
            '--include-id', '2608.12345',
        ])
        self.assertEqual(parsed[2], '2608.12345')
        with mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
            manual_review_blog._parse_args(Module, [
                '--date', '2026-08-25', '--attestation', '/tmp/a.json',
                '--include-id', '2608.12345', '--include-id', '2608.54321',
            ])
        generation = {
            'publicationScope': {'mode': 'single-paper', 'includeId': '2608.12345'},
        }
        exact = attestation()
        exact['publicationScope'] = generation['publicationScope']
        manual_review_blog._validate_attestation_publication_scope(
            Module, generation, exact,
        )
        mismatched = attestation()
        with self.assertRaisesRegex(Module.PublishDataValidationError, '作用域'):
            manual_review_blog._validate_attestation_publication_scope(
                Module, generation, mismatched,
            )

    def test_fresh_manual_v5_generation_rejects_legacy_v2_attestation(self):
        class Module:
            class PublishDataValidationError(ValueError):
                pass

        generation = {
            'schemaVersion': 3,
            'publishedPapers': [{
                'analysisManifest': {
                    'contracts': {'manualDepth': 'full-text-evidence-v5'},
                },
            }],
        }
        with self.assertRaisesRegex(Module.PublishDataValidationError, '必须使用 attestation v3'):
            manual_review_blog._require_current_attestation_version(
                Module, generation, {'version': 2},
            )
        manual_review_blog._require_current_attestation_version(
            Module, generation, {'version': 3},
        )

    def test_rejects_legacy_batch_only_or_incomplete_file_checks(self):
        cases = []
        legacy = attestation()
        legacy['version'] = 1
        cases.append(legacy)
        no_files = attestation()
        del no_files['files']
        cases.append(no_files)
        incomplete = attestation()
        del incomplete['files'][0]['checks']['technicalNarrative']
        cases.append(incomplete)
        duplicate = attestation()
        duplicate['files'].append(dict(duplicate['files'][0]))
        cases.append(duplicate)
        with tempfile.TemporaryDirectory() as tmp:
            for index, payload in enumerate(cases):
                with self.subTest(index=index):
                    path = self.write_payload(tmp, payload)
                    with self.assertRaises(ValueError):
                        manual_review_blog._load_attestation(path)

    def test_rejects_attestation_when_deterministic_review_mutated_final_bytes(self):
        class Module:
            class PublishDataValidationError(ValueError):
                pass

        manual_review_blog._reject_deterministic_fixes(Module, [])
        with self.assertRaisesRegex(Module.PublishDataValidationError, '旧 attestation 已失效'):
            manual_review_blog._reject_deterministic_fixes(Module, [
                {'path': '/tmp/content/posts/changed.md', 'issues': ['重复段落']},
            ])

    def test_semantic_checks_allow_research_boundary_but_reject_placeholder_line(self):
        class Module:
            class PublishDataValidationError(ValueError):
                pass

            @staticmethod
            def parse_markdown_images(_text):
                return []

        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / '2026-08-25-paper.md'
            page.write_text(
                '---\npaper_digest_page_type: paper\n'
                'paper_digest_arxiv_id: "2608.12345"\n---\n'
                '资源与部署测量仍待补充；该边界不影响当前实验结论。\n',
                encoding='utf-8',
            )
            self.assertEqual(
                manual_review_blog._semantic_checks(Module, [page], '2026-08-25'),
                1,
            )
            page.write_text(
                page.read_text(encoding='utf-8') + '\n待补充：替换最终结论\n',
                encoding='utf-8',
            )
            with self.assertRaisesRegex(Module.PublishDataValidationError, '编辑残留'):
                manual_review_blog._semantic_checks(Module, [page], '2026-08-25')

    def test_accepts_deleted_generation_entry_with_explicit_deletion_semantics(self):
        payload = attestation()
        payload['files'].append({
            'path': 'content/posts/2026-08-25-stale-paper.md',
            'deleted': True,
            'sha256': None,
            'checks': {'deletionVerified': True},
            'notes': '已确认删除页面文件名 2026-08-25-stale-paper，且博客工作树中不再存在该旧页。',
            'reviewSubagent': {
                'version': 1, 'taskName': 'deleted-page-review',
                'singleFileOnly': True, 'isolatedContext': True,
                'model': 'gpt-5.6-terra', 'reasoningEffort': 'high',
            },
            'imageFindings': [],
        })
        with tempfile.TemporaryDirectory() as tmp:
            parsed, _digest = manual_review_blog._load_attestation(
                self.write_payload(tmp, payload),
            )
        self.assertTrue(parsed['files'][1]['deleted'])
        self.assertIsNone(parsed['files'][1]['sha256'])

    def test_rejects_reused_batch_template_notes(self):
        payload = attestation()
        duplicate_note = payload['files'][0]['notes']
        payload['files'].append({
            'path': 'content/posts/2026-08-25-second.md',
            'sha256': 'b' * 64,
            'checks': dict(FILE_CHECKS),
            'notes': duplicate_note,
            'reviewSubagent': {
                'version': 1, 'taskName': 'second-paper-review',
                'paperId': '2608.54321',
                'singleFileOnly': True, 'isolatedContext': True,
                'model': 'gpt-5.6-terra', 'reasoningEffort': 'high',
            },
            'imageFindings': [],
        })
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, '逐文件独立'):
                manual_review_blog._load_attestation(self.write_payload(tmp, payload))

    def test_v3_requires_unique_page_tasks_and_paper_id(self):
        payload = attestation()
        second = dict(payload['files'][0])
        second['path'] = 'content/posts/2026-08-25-second.md'
        second['sha256'] = 'b' * 64
        second['notes'] = '2608.54321：核对第二页 Conformer 方法、WER 8.2% 与实验边界。'
        second['reviewSubagent'] = dict(second['reviewSubagent'])
        second['reviewSubagent']['paperId'] = '2608.54321'
        payload['files'].append(second)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'taskName 必须逐页唯一'):
                manual_review_blog._load_attestation(self.write_payload(tmp, payload))
        payload['files'][1]['reviewSubagent']['taskName'] = 'paper-review-2608-54321'
        del payload['files'][1]['reviewSubagent']['paperId']
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'paperId'):
                manual_review_blog._load_attestation(self.write_payload(tmp, payload))

    def test_v3_requires_terra_high_review_subagent(self):
        for field, value in (
            ('model', 'gpt-5.6-sol'),
            ('reasoningEffort', 'medium'),
        ):
            payload = attestation()
            payload['files'][0]['reviewSubagent'][field] = value
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(ValueError, 'gpt-5.6-terra/high'):
                    manual_review_blog._load_attestation(
                        self.write_payload(tmp, payload),
                    )

    def test_file_specific_notes_bind_paper_id_index_date_and_deleted_filename(self):
        class Module:
            class PublishDataValidationError(ValueError):
                pass

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paper = root / 'content/posts/2026-08-25-paper.md'
            paper.parent.mkdir(parents=True)
            paper.write_text(
                '---\npaper_digest_arxiv_id: "2608.12345"\n---\n正文报告 WER 7.1%。\n',
                encoding='utf-8',
            )
            index = root / 'content/posts/2026-08-25.md'
            index.write_text(
                '---\npaper_digest_page_type: index\n---\n汇总列出 TOP 16。\n', encoding='utf-8',
            )
            deleted = root / 'content/posts/2026-08-25-stale.md'
            paths = {
                'content/posts/2026-08-25-paper.md': paper,
                'content/posts/2026-08-25.md': index,
                'content/posts/2026-08-25-stale.md': deleted,
            }
            items = {
                'content/posts/2026-08-25-paper.md': {
                    'notes': '2608.12345：逐段核对流式编码方法、7.1% WER 结果和测试集边界。',
                },
                'content/posts/2026-08-25.md': {
                    'notes': '2026-08-25 汇总页已核对 TOP 16 的论文数量、排序、链接与批次标题。',
                },
                'content/posts/2026-08-25-stale.md': {
                    'notes': '确认删除旧页面 2026-08-25-stale，避免过期条目继续出现在同日汇总中。',
                },
            }
            manual_review_blog._validate_file_specific_notes(
                Module, items, paths, {
                    'content/posts/2026-08-25-paper.md': False,
                    'content/posts/2026-08-25.md': False,
                    'content/posts/2026-08-25-stale.md': True,
                }, '2026-08-25',
            )
            paper_two = root / 'content/posts/2026-08-25-paper-two.md'
            paper_two.write_text(
                '---\npaper_digest_arxiv_id: "2608.54321"\n---\n正文报告 WER 7.1%。\n',
                encoding='utf-8',
            )
            duplicate_paths = dict(paths)
            duplicate_paths['content/posts/2026-08-25-paper-two.md'] = paper_two
            duplicate_items = dict(items)
            duplicate_items['content/posts/2026-08-25-paper-two.md'] = {
                'notes': '2608.54321：逐段核对流式编码方法、7.1% WER 结果和测试集边界。',
            }
            duplicate_deletions = {
                relative: relative.endswith('-stale.md') for relative in duplicate_paths
            }
            with self.assertRaisesRegex(Module.PublishDataValidationError, '去除页面 ID 后仍重复'):
                manual_review_blog._validate_file_specific_notes(
                    Module, duplicate_items, duplicate_paths,
                    duplicate_deletions, '2026-08-25',
                )
            items['content/posts/2026-08-25-paper.md']['notes'] = '只写泛化审查结论，不绑定页面。'
            with self.assertRaisesRegex(Module.PublishDataValidationError, 'arXiv ID'):
                manual_review_blog._validate_file_specific_notes(
                    Module, items, paths, {
                        'content/posts/2026-08-25-paper.md': False,
                        'content/posts/2026-08-25.md': False,
                        'content/posts/2026-08-25-stale.md': True,
                    }, '2026-08-25',
                )


if __name__ == '__main__':
    unittest.main()

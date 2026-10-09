"""新单页审查使用 Sol，旧身份保持原样且不能签发新凭证。"""
import copy
import hashlib
import io
import json
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest import mock

import test_manual_review_arxiv_identity as identity_tests
from test_manual_review_blog import attestation, current_attestation, manual_review_blog
from manual_agent_policy import CURRENT_MODEL_POLICY, LEGACY_MODEL_POLICY, review_model_policy


class ManualReviewModelPolicyTest(unittest.TestCase):
    def test_original_v2_v3_and_current_v4_load_exact_bytes_without_relabeling(self):
        legacy_v2 = attestation()
        legacy_v2['version'] = 2
        for item in legacy_v2['files']:
            item.pop('reviewSubagent')
            item.pop('imageFindings')
        with tempfile.TemporaryDirectory() as tmp:
            for payload in (legacy_v2, attestation(), current_attestation()):
                before = copy.deepcopy(payload)
                path = Path(tmp) / 'statement.json'
                raw = json.dumps(payload, ensure_ascii=False).encode()
                path.write_bytes(raw)
                actual, sha = manual_review_blog._load_review_statement(path)
                self.assertEqual(actual, before)
                self.assertEqual(payload, before)
                self.assertEqual(path.read_bytes(), raw)
                self.assertEqual(sha, hashlib.sha256(raw).hexdigest())
                expected = CURRENT_MODEL_POLICY if payload['version'] == 4 else LEGACY_MODEL_POLICY
                self.assertEqual(review_model_policy(actual), expected)

    def test_outer_version_cannot_borrow_another_model_rule(self):
        cases = [(4, None), (4, LEGACY_MODEL_POLICY), (3, CURRENT_MODEL_POLICY),
                 (3, LEGACY_MODEL_POLICY), (2, CURRENT_MODEL_POLICY), (5, CURRENT_MODEL_POLICY),
                 (4.0, CURRENT_MODEL_POLICY), (True, CURRENT_MODEL_POLICY)]
        with tempfile.TemporaryDirectory() as tmp:
            for version, marker in cases:
                with self.subTest(version=version, marker=marker):
                    payload = current_attestation()
                    payload['version'] = version
                    if marker is None:
                        payload.pop('modelPolicy')
                    else:
                        payload['modelPolicy'] = marker
                    path = Path(tmp) / 'statement.json'
                    path.write_text(json.dumps(payload))
                    with self.assertRaisesRegex(ValueError, '版本|模型规则'):
                        manual_review_blog._load_review_statement(path)

    def test_current_identity_rejects_legacy_unknown_missing_and_mixed_receipts(self):
        mutations = [('model', 'gpt-5.6-terra'), ('model', 'unknown-model'), ('model', None),
                     ('reasoningEffort', 'medium'), ('reasoningEffort', None),
                     ('version', 1), ('version', None), ('version', 2.0),
                     ('modelPolicy', LEGACY_MODEL_POLICY), ('modelPolicy', None),
                     ('singleFileOnly', False), ('isolatedContext', False)]
        with tempfile.TemporaryDirectory() as tmp:
            for field, value in mutations:
                payload = current_attestation()
                subagent = payload['files'][0]['reviewSubagent']
                if value is None:
                    subagent.pop(field)
                else:
                    subagent[field] = value
                with self.subTest(field=field, value=value):
                    path = Path(tmp) / 'statement.json'
                    path.write_text(json.dumps(payload))
                    with self.assertRaisesRegex(ValueError, '独立单页任务'):
                        manual_review_blog._load_review_statement(path)

    def test_current_assembler_loader_and_publisher_accept_real_saved_sol_statement(self):
        helper = identity_tests.ManualReviewArxivIdentityTest()
        with tempfile.TemporaryDirectory() as tmp:
            output = helper.run_assembler(tmp, 'hep-th/9901001')
            actual, sha = manual_review_blog._load_review_statement(output)
            self.assertEqual(actual['version'], 4)
            self.assertEqual(actual['modelPolicy'], CURRENT_MODEL_POLICY)
            self.assertEqual(actual['files'][0]['reviewSubagent']['model'], 'gpt-6.1-sol')
            self.assertEqual(sha, hashlib.sha256(output.read_bytes()).hexdigest())
            self.assertIsNone(helper.receipt_error(Path(tmp), 'hep-th/9901001'))

    def test_old_shard_is_not_issued_as_a_new_sol_attestation(self):
        assembler = identity_tests.assembler
        original = attestation()['files'][0]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shards = root / 'shards'
            shards.mkdir()
            shard = shards / 'page.json'
            raw = json.dumps(original).encode()
            shard.write_bytes(raw)
            manifest = root / 'generation.json'
            manifest.write_text(json.dumps({'files': [original]}))
            output = root / 'assembled.json'
            module = mock.Mock()
            module.manual_cache_reuse_for_file.return_value = None
            module.publication_scope.return_value.__enter__ = mock.Mock()
            module.publication_scope.return_value.__exit__ = mock.Mock()
            module.generation_manifest_path.return_value = manifest
            module.manual_review_page_dir.return_value = shards
            module.manual_review_statement_path.return_value = output
            for plan in (True, False):
                argv = ['assemble', '--date', '2026-08-25'] + (['--plan'] if plan else [])
                with mock.patch.object(assembler, 'load_publish_to_blog', return_value=module), \
                        mock.patch('sys.argv', argv), mock.patch('sys.stdout', new_callable=io.StringIO) as stream:
                    if plan:
                        assembler.main()
                        self.assertEqual(json.loads(stream.getvalue())['counts']['failed'], 1)
                    else:
                        with self.assertRaisesRegex(SystemExit, '未通过核验'):
                            assembler.main()
                self.assertFalse(output.exists())
                self.assertEqual(shard.read_bytes(), raw)

    def test_fresh_publisher_rejects_old_identity_before_any_write_or_result_mutation(self):
        publisher = identity_tests.publisher
        old = attestation()
        before = copy.deepcopy(old)
        reviewed = {'page': {'passed': True, 'reviewProtocolFingerprint': 'original'}}
        with mock.patch.object(publisher, 'save_review_pass_cache') as cache, \
                mock.patch.object(publisher, 'atomic_write_json') as writer:
            with self.assertRaisesRegex(publisher.PublishDataValidationError, '新人工审查.*v4'):
                publisher.save_review_receipt('2026-08-25', [], {},
                    generation_manifest='/missing-never-read.json', reviewed_results=reviewed,
                    manual_review_record=old)
        cache.assert_not_called()
        writer.assert_not_called()
        self.assertEqual(old, before)
        self.assertEqual(reviewed, {'page': {'passed': True, 'reviewProtocolFingerprint': 'original'}})

    def test_existing_verified_receipt_reuse_keeps_original_model_and_avoids_new_issuance(self):
        old = attestation()
        old['publishedHead'] = 'a' * 40
        before = copy.deepcopy(old)
        module = mock.Mock()
        module.validate_publish_target.return_value = (Path('/tmp'), Path('/tmp'))
        module.load_generation_manifest.return_value = ([], Path('/not-read'))
        module.validate_git_publish_branch.return_value = 'a' * 40
        module.reusable_verified_publication_review.return_value = (None, None, old)
        with mock.patch.object(manual_review_blog, '_load_review_statement', side_effect=AssertionError('不应读新声明')):
            actual = manual_review_blog._run(module, '2026-08-25', Path('/not-read'))
        self.assertIs(actual, old)
        self.assertEqual(actual, before)
        module.save_review_receipt.assert_not_called()


    def test_assembler_rejects_short_or_nontext_task_names_before_writing(self):
        assembler = identity_tests.assembler
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shards = root / 'shards'
            shards.mkdir()
            manifest = root / 'generation.json'
            output = root / 'assembled.json'
            module = mock.MagicMock()
            module.manual_cache_reuse_for_file.return_value = None
            module.generation_manifest_path.return_value = manifest
            module.manual_review_page_dir.return_value = shards
            module.manual_review_statement_path.return_value = output
            for task_name in (1234, 'abc', '', None):
                item = current_attestation()['files'][0]
                item['reviewSubagent']['taskName'] = task_name
                shard = shards / 'page.json'
                raw = json.dumps(item).encode()
                shard.write_bytes(raw)
                manifest.write_text(json.dumps({'files': [item]}))
                with self.subTest(task_name=task_name), \
                        mock.patch.object(assembler, 'load_publish_to_blog', return_value=module), \
                        mock.patch('sys.argv', ['assemble', '--date', '2026-08-25']):
                    with self.assertRaisesRegex(SystemExit, '未通过核验'):
                        assembler.main()
                self.assertFalse(output.exists())
                self.assertEqual(shard.read_bytes(), raw)

    def test_fresh_sol_review_receipt_is_actually_saved_with_real_page_hash_and_git_base(self):
        publisher = identity_tests.publisher
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / 'blog'
            repo.mkdir()
            for args in (('init', '-b', 'main'), ('config', 'user.name', 'Local Test'),
                         ('config', 'user.email', 'test@example.com')):
                subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
            (repo / 'hugo.yaml').write_text('baseURL: https://example.test/\n')
            subprocess.run(['git', '-C', str(repo), 'add', 'hugo.yaml'], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'initial'], check=True, capture_output=True)
            page = repo / 'content/posts/2026-08-25-paper.md'
            page.parent.mkdir(parents=True)
            page.write_text('---\npaper_digest_arxiv_id: "2608.12345"\n---\n正文报告 WER 7.1%。\n')
            sha = hashlib.sha256(page.read_bytes()).hexdigest()
            statement = current_attestation()
            statement['files'][0]['sha256'] = sha
            statement['files'][0]['notes'] = '2608.12345：核对 WER 7.1% 实验数字、方法说明、开源范围及局限边界。'
            statement['completedAt'] = '2026-08-25T12:00:00.000+08:00'
            before = copy.deepcopy(statement)
            with mock.patch.object(publisher, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publisher, 'CURRENT_DIR', root / 'current'):
                manifest = publisher.save_generation_manifest('2026-08-25', [page])
                base = publisher.validate_git_publish_branch()
                result = {str(page.resolve()): {'passed': True, 'reviewedSha256': sha,
                                               'imageReviewMode': 'manual_semantic'}}
                saved_path = publisher.save_review_receipt('2026-08-25', [page], 'local-test-gate',
                    expected_base_head=base, generation_manifest=manifest,
                    reviewed_results=result, manual_review_record=statement)
                saved = json.loads(saved_path.read_text())
                def disk_snapshot():
                    return {str(p.relative_to(root / 'current')): p.read_bytes()
                            for p in (root / 'current').rglob('*') if p.is_file()}
                disk_before = disk_snapshot()
                for invalid_kind in ('model', 'notes', 'checks'):
                    invalid = copy.deepcopy(statement)
                    if invalid_kind == 'model':
                        invalid['files'][0]['reviewSubagent']['model'] = 'gpt-5.6-terra'
                    elif invalid_kind == 'notes':
                        invalid['files'][0]['notes'] = '不完整'
                    else:
                        invalid['files'][0]['checks']['technicalNarrative'] = False
                    invalid_before = copy.deepcopy(invalid)
                    results_before = copy.deepcopy(result)
                    with self.subTest(invalid_kind=invalid_kind), \
                            mock.patch.object(publisher, 'save_review_pass_cache', wraps=publisher.save_review_pass_cache) as cache:
                        with self.assertRaises(publisher.PublishDataValidationError):
                            publisher.save_review_receipt('2026-08-25', [page], 'local-test-gate',
                                expected_base_head=base, generation_manifest=manifest,
                                reviewed_results=result, manual_review_record=invalid)
                        cache.assert_not_called()
                    self.assertEqual(disk_snapshot(), disk_before)
                    self.assertEqual(invalid, invalid_before)
                    self.assertEqual(result, results_before)
                self.assertIsNone(publisher._manual_review_record_error(saved,
                    date_str='2026-08-25', generation_manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest(),
                    expected_base_head=base))
            self.assertEqual(saved['reviewProvenance']['version'], 4)
            self.assertEqual(saved['reviewProvenance']['modelPolicy'], CURRENT_MODEL_POLICY)
            self.assertEqual(saved['reviewProvenance']['files'][0]['reviewSubagent']['model'], 'gpt-6.1-sol')
            self.assertEqual(saved['baseHead'], base)
            self.assertEqual(saved['files'][0]['sha256'], sha)
            self.assertEqual(statement, before)


if __name__ == '__main__':
    unittest.main()

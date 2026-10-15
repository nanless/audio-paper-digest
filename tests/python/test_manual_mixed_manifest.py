"""人工审查混合清单回归；合成夹具不代替真实页面审查。"""
import copy
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/python'))
sys.path.insert(0, str(ROOT / 'manual/tests/python'))
from test_blog_stage_scripts import (
    publish_module as pub, assemble_manual_review as assemble,
    load_script, MANUAL_SCRIPTS,
)
manual = load_script('manual-review-blog.py', MANUAL_SCRIPTS)
DATE = '2026-07-10'


class ManualMixedManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = (Path(self.temp.name) / 'blog').resolve()
        self.current = Path(self.temp.name) / 'current'
        self.current.mkdir()
        self.scope = contextlib.ExitStack()
        self.addCleanup(self.scope.close)
        self.scope.enter_context(mock.patch.object(pub, 'BLOG_REPO', str(self.repo)))
        self.scope.enter_context(mock.patch.object(pub, 'CURRENT_DIR', self.current))
        self.page_rel = f'content/posts/{DATE}.md'
        self.image_rel = 'static/images/papers/2607.00001/figure-1-0123456789abcdef.png'
        self.png = pub.PNG_SIGNATURE + b'synthetic-test-only'
        self.image_rel = self.image_rel.replace('0123456789abcdef', hashlib.sha256(self.png).hexdigest()[:16])
        self.page = self.repo / self.page_rel
        self.image = self.repo / self.image_rel
        self.image.parent.mkdir(parents=True)
        self.page.parent.mkdir(parents=True)
        self.image.write_bytes(self.png)
        url = f'{pub.BASE_PATH.rstrip("/")}/{self.image_rel[len("static/"):]}'
        self.page.write_text(f'---\ntitle: fixture\n---\n![synthetic]({url})\n')
        self.manifest = {'schemaVersion': 3, 'date': DATE, 'publishedPapers': [],
            'files': [self.file_record(self.page_rel), self.file_record(self.image_rel)]}

    def file_record(self, relative):
        return {'path': relative, 'deleted': False,
            'sha256': hashlib.sha256((self.repo / relative).read_bytes()).hexdigest()}

    def record(self):
        path = pub.generation_manifest_path(DATE)
        path.write_text(json.dumps(self.manifest))
        return {'version': 4,
            'generationManifestSha256': pub._sha256_file(path),
            'machineAssets': pub.manual_review_machine_assets(self.manifest, DATE),
            'files': [{'path': self.page_rel, 'sha256': self.manifest['files'][0]['sha256']}]}

    def checker(self, record, receipts=None):
        # Qualification is an asserted boundary here; real source replay remains in existing integration tests.
        with mock.patch.object(pub, '_validate_generation_input_integrity') as source_guard, \
                mock.patch.object(pub, '_validate_active_publication_scope'), \
                mock.patch.object(pub, 'validate_current_generation_template'):
            pub._validate_manual_machine_assets(record, receipts or self.manifest['files'], DATE)
            source_guard.assert_called_once()

    def test_partition_keeps_binary_out_of_semantic_files(self):
        pages, assets = pub.manual_review_manifest_partition(self.manifest, DATE)
        self.assertEqual([r['path'] for r in pages], [self.page_rel])
        self.assertEqual([r['path'] for r in assets], [self.image_rel])

    def test_unknown_static_and_post_extension_are_rejected(self):
        for relative in ('static/unknown.bin', f'content/posts/{DATE}-fake.json'):
            manifest = copy.deepcopy(self.manifest)
            manifest['files'][1]['path'] = relative
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                pub.manual_review_manifest_partition(manifest, DATE)

    def test_duplicate_noncanonical_traversal_and_backslash_are_rejected(self):
        for relative in (self.page_rel, './' + self.image_rel, '../escape', 'static\\escape.png'):
            manifest = copy.deepcopy(self.manifest)
            manifest['files'][1]['path'] = relative
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                pub.manual_review_manifest_partition(manifest, DATE)

    def test_deleted_or_legacy_assets_do_not_get_machine_pass(self):
        for schema, deleted in ((2, False), (3, True)):
            manifest = copy.deepcopy(self.manifest)
            manifest['schemaVersion'] = schema
            manifest['files'][1]['deleted'] = deleted
            if deleted:
                manifest['files'][1]['sha256'] = None
            with self.subTest(schema=schema, deleted=deleted), self.assertRaises(ValueError):
                pub.manual_review_manifest_partition(manifest, DATE)

    def test_real_attester_and_exact_union_pass_constructed_image_fixture(self):
        record = self.record()
        self.checker(record)

    def test_asset_byte_drift_is_blocked(self):
        record = self.record()
        self.image.write_bytes(self.png + b'changed')
        with self.assertRaises(ValueError):
            self.checker(record)

    def test_asset_without_reviewed_page_reference_is_blocked(self):
        self.page.write_text('---\ntitle: fixture\n---\nno image\n')
        self.manifest['files'][0] = self.file_record(self.page_rel)
        record = self.record()
        with self.assertRaisesRegex(ValueError, '正常机器核验'):
            self.checker(record)

    def test_asset_partition_cannot_drop_add_or_forge_asset(self):
        for mode in ('drop', 'add', 'sha'):
            record = self.record()
            if mode == 'drop': record['machineAssets']['files'] = []
            elif mode == 'add': record['machineAssets']['files'].append(copy.deepcopy(record['machineAssets']['files'][0]))
            else: record['machineAssets']['files'][0]['sha256'] = '0' * 64
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.checker(record)

    def test_receipt_cannot_omit_duplicate_or_replace_asset(self):
        for mode in ('omit', 'duplicate', 'replace'):
            record = self.record()
            receipts = copy.deepcopy(self.manifest['files'])
            if mode == 'omit': receipts.pop()
            elif mode == 'duplicate': receipts.append(copy.deepcopy(receipts[-1]))
            else: receipts[-1]['sha256'] = '0' * 64
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.checker(record, receipts)

    def test_generation_manifest_substitution_is_blocked(self):
        record = self.record()
        pub.generation_manifest_path(DATE).write_text(json.dumps(self.manifest) + '\n')
        with self.assertRaisesRegex(ValueError, '生成清单 SHA'):
            self.checker(record)

    def test_source_qualification_failure_stops_attestation(self):
        record = self.record()
        with mock.patch.object(pub, '_validate_active_publication_scope'), \
                mock.patch.object(pub, 'validate_current_generation_template'), \
                mock.patch.object(pub, '_validate_generation_input_integrity', side_effect=ValueError('sealed source failed')), \
                mock.patch.object(pub, 'attest_api_reader_assets') as attest:
            with self.assertRaisesRegex(ValueError, 'sealed source'):
                pub._validate_manual_machine_assets(record, self.manifest['files'], DATE)
            attest.assert_not_called()

    def test_assembler_plans_only_page_not_binary_shards(self):
        self.record()
        with mock.patch.object(assemble, 'load_publish_to_blog', return_value=pub), \
                mock.patch.object(pub, '_validate_active_publication_scope'), \
                mock.patch.object(pub, 'manual_cache_reuse_for_file', return_value=None) as reuse, \
                mock.patch.object(sys, 'argv', ['assemble', '--date', DATE, '--plan']), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            assemble.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result['pending'], [self.page_rel])
        self.assertEqual(reuse.call_count, 1)

    def pure_page_receipt(self, version=4):
        from test_manual_review_blog import current_attestation, attestation
        payload = current_attestation() if version == 4 else attestation()
        payload['version'] = version
        self.page.write_text('---\npaper_digest_arxiv_id: "2607.00001"\n---\nWER 7.1% 构造测试正文。\n')
        item = payload['files'][0]
        item.update(path=self.page_rel, sha256=pub._sha256_file(self.page),
            notes='2607.00001：构造测试核对 WER 7.1% 及具体方法、复现和局限说明。')
        if version in (1, 2):
            item.pop('reviewSubagent', None)
            item.pop('imageFindings', None)
        else:
            item['reviewSubagent']['paperId'] = '2607.00001'
        receipt_files = [{'path': self.page_rel, 'sha256': item['sha256'], 'deleted': False}]
        payload.update(completedAt='2026-07-10T12:00:00.000+08:00',
            generationManifestSha256='a' * 64, baseHead='b' * 40, fileCount=1,
            reviewedPathSetSha256=pub._reviewed_path_set_sha256(receipt_files),
            reviewProtocolFingerprint='c' * 64)
        receipt = {'reviewMode': 'manual_complete', 'files': receipt_files, 'reviewProvenance': payload}
        if version == 1:
            receipt.update(publicationCommit='d' * 40, remoteVerifiedOid='d' * 40,
                remoteVerifiedAt='2026-07-10T12:00:00.000+08:00', remoteIdentitySha256='e' * 64)
        return receipt

    def test_pure_page_v1_v2_v3_v4_historical_validation_unchanged(self):
        for version in (1, 2, 3, 4):
            with self.subTest(version=version):
                receipt = self.pure_page_receipt(version)
                self.assertIsNone(pub._manual_review_record_error(receipt, date_str=DATE))
                # Existing arXiv page callers may omit date; do not require the new partition for pure pages.
                self.assertIsNone(pub._manual_review_record_error(receipt))

    def test_statement_assets_only_v4_not_null_or_extra_keys(self):
        for mode in ('v2', 'v3', 'null', 'extra', 'duplicate'):
            receipt = self.pure_page_receipt(4)
            payload = receipt['reviewProvenance']
            payload['machineAssets'] = pub.manual_review_machine_assets(self.manifest, DATE)
            if mode in ('v2', 'v3'):
                from test_manual_review_blog import attestation
                payload = attestation()
                payload['version'] = int(mode[-1])
                payload['machineAssets'] = pub.manual_review_machine_assets(self.manifest, DATE)
                if mode == 'v2':
                    payload['files'][0].pop('reviewSubagent'); payload['files'][0].pop('imageFindings')
            elif mode == 'null': payload['machineAssets'] = None
            elif mode == 'extra': payload['machineAssets']['extra'] = True
            else: payload['machineAssets']['files'] *= 2
            path = Path(self.temp.name) / 'statement.json'
            path.write_text(json.dumps(payload))
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                manual._load_review_statement(path)

    def test_mixed_provenance_none_date_fails_cleanly_not_exception(self):
        receipt = self.pure_page_receipt(4)
        self.manifest['files'][0] = self.file_record(self.page_rel)
        bound = self.record()
        receipt['files'] = self.manifest['files']
        receipt['reviewProvenance'].update(machineAssets=bound['machineAssets'],
            generationManifestSha256=bound['generationManifestSha256'], fileCount=2)
        error = pub._manual_review_record_error(receipt)
        self.assertIsInstance(error, str)
        self.assertIn('机器资产证明', error)

    def test_wrong_batch_date_is_rejected(self):
        for relative in ('content/posts/2026-07-11.md',
                'static/data/papers/2026-07-11/2607-00001/paper.json'):
            manifest = copy.deepcopy(self.manifest)
            manifest['files'][0 if relative.startswith('content/') else 1]['path'] = relative
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                pub.manual_review_manifest_partition(manifest, DATE)

    def test_symlink_file_and_parent_alias_are_rejected(self):
        for parent_alias in (False, True):
            alias = self.repo / ('static/images/papers/2607.00002' if parent_alias else 'static/images/papers/2607.00001/figure-2-' + 'a' * 16 + '.png')
            alias.symlink_to(self.image.parent if parent_alias else self.image, target_is_directory=parent_alias)
            manifest = copy.deepcopy(self.manifest)
            manifest['files'][1]['path'] = (alias / self.image.name if parent_alias else alias).relative_to(self.repo).as_posix()
            with self.subTest(parent_alias=parent_alias), self.assertRaises(ValueError):
                pub.manual_review_manifest_partition(manifest, DATE)

    def test_machine_list_reordering_is_strict_not_silently_normalized(self):
        extra = self.repo / self.image_rel.replace('figure-1-', 'figure-2-')
        extra.write_bytes(self.png)
        self.manifest['files'].append(self.file_record(extra.relative_to(self.repo).as_posix()))
        record = self.record()
        record['machineAssets']['files'].reverse()
        with self.assertRaisesRegex(ValueError, '集合与当前生成清单不一致'):
            self.checker(record)

    def test_real_fixture_pass_cache_requires_exact_path_sha_and_preserves_identity(self):
        # This cache belongs only to a synthetic temporary fixture, never to production pages.
        sha = pub._sha256_file(self.page)
        results = {str(self.page.resolve()): {'passed': True, 'completed': True,
            'reviewedSha256': sha, 'reviewProtocolFingerprint': 'f' * 64,
            'imageReviewMode': 'multimodal'}}
        pub.save_review_pass_cache(DATE, [self.page], results)
        evidence = pub.manual_cache_reuse_for_file(DATE, self.page_rel, sha)
        self.assertIsNotNone(evidence)
        item = {'path': self.page_rel, 'sha256': sha, 'cacheReuse': evidence}
        self.assertEqual(pub.validate_manual_cache_reuse(item, DATE), evidence)
        self.assertEqual(evidence['record']['modelIdentity'], {'status': 'not_recorded'})
        self.assertIsNone(pub.manual_cache_reuse_for_file(DATE, self.page_rel, '0' * 64))
        forged = copy.deepcopy(item)
        forged['cacheReuse']['record']['imageReviewMode'] = 'manual_semantic'
        with self.assertRaises(ValueError):
            pub.validate_manual_cache_reuse(forged, DATE)
        self.page.write_text(self.page.read_text() + 'changed')
        with self.assertRaises(ValueError):
            pub.validate_manual_cache_reuse(item, DATE)

    def test_invalid_mixed_provenance_does_not_write_pass_cache(self):
        receipt = self.pure_page_receipt(4)
        self.manifest['files'][0] = self.file_record(self.page_rel)
        bound = self.record()
        record = receipt['reviewProvenance']
        record.update(machineAssets=bound['machineAssets'],
            generationManifestSha256=bound['generationManifestSha256'], fileCount=2)
        record['machineAssets']['files'][0]['sha256'] = '0' * 64
        with mock.patch.object(pub, 'validate_git_publish_branch', return_value='b' * 40), \
                mock.patch.object(pub, 'review_protocol_fingerprint', return_value='c' * 64), \
                mock.patch.object(pub, '_validate_active_publication_scope'), \
                mock.patch.object(pub, 'validate_current_generation_template'), \
                mock.patch.object(pub, '_validate_generation_input_integrity'), \
                mock.patch.object(pub, 'atomic_write_json') as write:
            with self.assertRaises(ValueError):
                pub.save_review_pass_cache(DATE, [self.page, self.image], {},
                    manual_review_record=record, generation_manifest=pub.generation_manifest_path(DATE))
            write.assert_not_called()

    def test_failed_page_not_in_manual_semantic_set_cannot_authorize_image(self):
        record = self.record()
        record['files'] = []
        with self.assertRaisesRegex(ValueError, '没有精确覆盖'):
            self.checker(record)


    def run_fixture(self, mutate_asset=False):
        from types import SimpleNamespace
        from test_manual_review_blog import current_attestation
        text = self.page.read_text() + '\nWER 7.1% 仅供构造回归。\n'
        self.page.write_text(text)
        self.manifest['files'][0] = self.file_record(self.page_rel)
        bound = self.record()
        payload = current_attestation()
        item = payload['files'][0]
        item.update(path=self.page_rel, sha256=self.manifest['files'][0]['sha256'],
            notes=f'{DATE} 汇总：构造回归逐项核对 WER 7.1% 方法、比较与局限。')
        item['reviewSubagent'].pop('paperId', None)
        image_url = pub.parse_markdown_images(text)[0]['url']
        item['imageFindings'] = [{'url': image_url, 'captionVerified': True,
            'adjacentNarrativeVerified': True, 'mobileReadable': True,
            'visibleFacts': ['这是构造测试用的图像事实，不是真实审查。', '第二条构造测试用的图像事实，同样不是真实审查。'],
            'notes': '仅用于构造测试的完整图片审查形状，不为真实论文或图片签发凭证。'}]
        payload['machineAssets'] = bound['machineAssets']
        statement = Path(self.temp.name) / 'statement.json'
        statement.write_text(json.dumps(payload))
        module = SimpleNamespace(**{name: getattr(pub, name) for name in (
            'PublishDataValidationError', 'normalize_publish_arxiv_id', 'parse_markdown_images',
            'manual_review_manifest_partition', 'manual_review_machine_assets',
            'generation_manifest_expectations', 'validate_manual_cache_reuse',
            'attest_api_reader_assets', 'validate_reviewed_file_hashes', '_sha256_file', 'is_manual_local_image_url')})
        module.validate_publish_target = lambda: (self.repo, self.page.parent)
        module.load_generation_manifest = lambda _date: ([self.page, self.image], pub.generation_manifest_path(DATE))
        module.validate_git_publish_branch = lambda: 'b' * 40
        module.reusable_verified_publication_review = lambda *args: None
        module.has_publication_evidence_for_generation = lambda *args: False
        module._validate_active_publication_scope = lambda *args: None
        module.validate_staged_posts = mock.Mock()
        module.run_hugo_gate = mock.Mock(return_value='hugo')
        module.review_protocol_fingerprint = lambda: 'f' * 64
        module.save_review_receipt = mock.Mock(return_value=Path(self.temp.name)/'synthetic-receipt.json')
        def deterministic(page, paper, dry_run):
            self.assertEqual(page, self.page)
            if mutate_asset:
                self.image.write_bytes(self.png + b'drift')
            return False, []
        module.review_and_fix_post = mock.Mock(side_effect=deterministic)
        return module, statement

    def test_mixed_run_reviews_only_markdown_but_receipts_full_union(self):
        module, statement = self.run_fixture()
        manual._run(module, DATE, statement)
        module.review_and_fix_post.assert_called_once()
        module.save_review_receipt.assert_called_once()
        saved = module.save_review_receipt.call_args
        self.assertEqual(set(saved.args[1]), {self.page, self.image})
        self.assertEqual(set(saved.kwargs['reviewed_results']), {str(self.page.resolve()), str(self.image.resolve())})
        provenance = saved.kwargs['manual_review_record']
        self.assertEqual(provenance['fileCount'], 2)
        self.assertEqual(provenance['checkedFiles'], 1)
        self.assertEqual([item['path'] for item in provenance['files']], [self.page_rel])
        self.assertEqual([item['path'] for item in provenance['machineAssets']['files']], [self.image_rel])

    def test_mixed_run_asset_drift_prevents_any_receipt_write(self):
        module, statement = self.run_fixture(mutate_asset=True)
        with self.assertRaisesRegex(ValueError, '受控资产未通过'):
            manual._run(module, DATE, statement)
        module.save_review_receipt.assert_not_called()


    def test_local_image_validator_allows_only_exact_current_asset_url(self):
        self.record()
        manifest_path = pub.generation_manifest_path(DATE)
        url = f'{pub.BASE_PATH.rstrip("/")}/{self.image_rel[len("static/"):]}'
        self.assertTrue(pub.is_manual_local_image_url(url, manifest_path, DATE))
        bad_urls = (
            '//evil.example/image.png', './image.png', '../image.png',
            url + '?download=1', url + '#figure', url.replace('/images/', '/%2e%2e/images/'),
            url.replace(pub.BASE_PATH, '/wrong-base'), url.replace('figure-1-', 'figure-9-'),
            'http://evil.example/image.png', 'https://evil.example/image.png',
            url.replace('/images/', '/./images/'), url.replace('/images/', '/../images/'),
        )
        for bad in bad_urls:
            with self.subTest(url=bad):
                self.assertFalse(pub.is_manual_local_image_url(bad, manifest_path, DATE))
        self.image.write_bytes(self.png + b'changed')
        self.assertFalse(pub.is_manual_local_image_url(url, manifest_path, DATE))

    def test_local_image_validator_rejects_wrong_manifest_date(self):
        self.record()
        path = pub.generation_manifest_path(DATE)
        manifest = copy.deepcopy(self.manifest)
        manifest['date'] = '2026-07-11'
        path.write_text(json.dumps(manifest))
        url = f'{pub.BASE_PATH.rstrip("/")}/{self.image_rel[len("static/"):]}'
        self.assertFalse(pub.is_manual_local_image_url(url, path, DATE))

    def test_template_change_stops_before_asset_or_cache_identity_write(self):
        record = self.record()
        with mock.patch.object(pub, '_validate_active_publication_scope'), \
                mock.patch.object(pub, 'validate_current_generation_template', side_effect=ValueError('template drift')), \
                mock.patch.object(pub, 'attest_api_reader_assets') as attest, \
                mock.patch.object(pub, 'atomic_write_json') as write:
            with self.assertRaisesRegex(ValueError, 'template drift'):
                pub._validate_manual_machine_assets(record, self.manifest['files'], DATE)
            attest.assert_not_called()
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main()

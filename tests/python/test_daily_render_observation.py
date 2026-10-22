"""Mechanical normal-review integration; does not assert paid scientific qualification.

Hugo, source-file replay, asset/final gates and receipt writer/loader are real.
Only the text-LLM leaf is replaced with an offline response for actual page bytes.
"""
import contextlib
import copy
import errno
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import restore_environment_after
from test_daily_fresh_publish_gate import _daily_payload
from test_publish_to_blog import init_blog_repo, git, publish_to_blog as publisher, review_blog


DATE = '2026-09-07'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class DailyRenderObservationIntegrationTest(unittest.TestCase):
    def setUp(self):
        restore_environment_after(self)
        self.assertIsNotNone(shutil.which('hugo'), 'This integration requires actual Hugo')
        self.tmp = tempfile.TemporaryDirectory(prefix='daily-render-observation-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.repo, self.posts, self.remote = init_blog_repo(self.root, with_remote=True)
        self.current = self.root / 'current'
        self.current.mkdir()
        self.source_root = self.root / 'sources'
        self.observation_root = self.root / 'render-observations'
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (
                ('BLOG_REPO', str(self.repo)), ('CONTENT_DIR', str(self.posts)),
                ('CURRENT_DIR', self.current), ('DAILY_FRESH_SOURCE_RUNS_DIR', self.source_root),
                ('DAILY_RENDER_OBSERVATIONS_DIR', self.observation_root)):
            self.stack.enter_context(mock.patch.object(publisher, name, value, create=True))
        (self.repo / 'hugo.yaml').write_text(
            'baseURL: https://example.test/research/base/\n'
            'languageCode: zh-CN\ndefaultContentLanguage: zh-cn\n'
            'disableKinds: [taxonomy, term]\noutputs:\n  home: [HTML, RSS, JSON]\n',
            encoding='utf-8',
        )
        layouts = self.repo / 'layouts'
        (layouts / '_default').mkdir(parents=True)
        (layouts / '_partials').mkdir()
        (layouts / '_default' / 'baseof.html').write_text(
            '<!doctype html><html><head><meta charset="utf-8">'
            '<link rel="canonical" href="{{ .Permalink }}"><title>{{ .Title }}</title>'
            '{{ range .OutputFormats }}<link rel="alternate" href="{{ .Permalink }}">{{ end }}'
            '</head><body><h1>{{ .Title }}</h1><div class="post-content">'
            '{{ block "main" . }}{{ end }}</div>{{ partial "footer.html" . }}</body></html>',
            encoding='utf-8',
        )
        for name in ('single.html', 'home.html', 'section.html'):
            (layouts / name).write_text('{{ define "main" }}{{ .Content }}{{ end }}', encoding='utf-8')
        (layouts / '_partials' / 'footer.html').write_text(
            '<footer data-root-override="true">受控测试页脚</footer>', encoding='utf-8')
        (layouts / 'home.json.json').write_text('{{ dict "original" "home" | jsonify }}', encoding='utf-8')
        git(self.repo, 'add', '--', 'hugo.yaml', 'layouts')
        git(self.repo, 'commit', '-m', 'Isolated mechanical Hugo fixture')
        git(self.repo, 'push', 'origin', 'main')
        payload = _daily_payload(self.source_root, ['2609.12341', '2609.12342'])
        for paper in payload['papers']:
            paper['title'] = 'Same mechanical title'
        self.input_file = self.root / 'deep-analysis-result.json'
        self.input_file.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        self.paths = []
        for paper, slug in zip(payload['papers'], ('custom-url', '声音模型')):
            page = self.posts / f'{DATE}-{paper["arxivId"].replace(".", "-")}.md'
            page.write_text(
                '---\ntitle: "同名机械页面"\ndate: ' + DATE + '\ndraft: false\n'
                'tags: []\ncategories: []\ndescription: "机械观察测试"\n'
                'paper_digest_page_type: paper\npaper_digest_arxiv_id: "' + paper['arxivId'] + '"\n'
                'slug: "' + slug + '"\n---\n\n'
                '这里仅验证原正常审查的机械关系，不声称真实论文已经完成付费分析。\n\n'
                '原来源文件、页面字节与生成清单都必须经过原程序检查。\n',
                encoding='utf-8',
            )
            self.paths.append(page)
        reference = publisher.build_generation_input_source_reference(self.input_file)
        self.base_head = publisher.validate_git_publish_branch()
        self.manifest_path = publisher.save_generation_manifest(
            DATE, self.paths,
            input_fingerprint=publisher.generation_input_fingerprint(
                payload['papers'], DATE, '论文速递', False, input_source_reference=reference),
            template_fingerprint=publisher.generation_template_fingerprint(),
            base_head=self.base_head, published_papers=payload['papers'],
            publication_mode=publisher.LEGACY_V5_MAINTENANCE_MODE,
            input_source_reference=reference,
        )
        self.actual_builds = []
        self.runner = publisher._run_bounded_subprocess
        self.before_build = lambda _command: None
        self.after_build = lambda _command: None
        self.review_response = lambda content, *args, **kwargs: (True, [], content)

    @staticmethod
    def capture_module():
        return importlib.import_module('daily_hugo_capture')

    def receipt(self):
        return json.loads(publisher.review_receipt_path(DATE).read_text())

    def write_receipt(self, receipt):
        publisher.review_receipt_path(DATE).write_text(json.dumps(receipt, ensure_ascii=False))

    def expected_binding(self, receipt):
        return {**{key: receipt.get(key) for key in (
                    'date', 'publicationScope', 'generationManifestSha256', 'baseHead',
                    'reviewProtocolFingerprint', 'reviewedAt', 'publicationMode')},
                'files': [{key: record[key] for key in ('path', 'deleted', 'sha256')}
                          for record in receipt['files']]}

    def assert_observation_available(self):
        summary = publisher.read_daily_render_observation(DATE)
        self.assertEqual(summary['status'], 'observation_available')
        self.assertEqual(summary['inputBinding'], 'observed_before_after')
        self.assertEqual(summary['fullInputSnapshot'], 'not_established')
        for field in ('productionArtifact', 'bodyProjection', 'publicAssets', 'currentEligibility', 'deployment',
                      'onlineGet', 'browserExecution'):
            self.assertEqual(summary['coverage'][field], 'not_checked')
        for field in ('complete', 'full', 'published', 'currentEligible'):
            self.assertNotIn(field, summary)
        return summary

    def review(self):
        def real_build(command, **kwargs):
            building = '--destination' in command
            if building:
                self.before_build(command)
            result = self.runner(command, **kwargs)
            if building:
                output = Path(command[command.index('--destination') + 1])
                self.actual_builds.append((output, {
                    file.relative_to(output).as_posix(): file.read_bytes()
                    for file in output.rglob('*') if file.is_file()
                }))
                self.after_build(command)
            return result

        with mock.patch.object(publisher, '_run_bounded_subprocess', side_effect=real_build), \
                mock.patch.object(publisher, '_llm_review_post_chunk',
                                  side_effect=self.review_response), \
                mock.patch.object(publisher, 'call_publish_llm_api',
                                  side_effect=AssertionError('No model requests in mechanical integration')), \
                publisher.blog_publication_lock(DATE), contextlib.redirect_stdout(io.StringIO()):
            return review_blog._run_review(publisher, DATE)

    def test_actual_hugo_capture_is_bound_to_normal_receipt(self):
        receipt_path = self.review()
        paths, loaded_path = publisher.load_verified_review_receipt(DATE)
        self.assertEqual(loaded_path, receipt_path)
        self.assertEqual(set(paths), set(self.paths))
        self.assertEqual(len(self.actual_builds), 1)
        destination, outputs = self.actual_builds[0]
        self.assertTrue(any(name.endswith('.html') for name in outputs))
        self.assertFalse(destination.exists(), 'Normal Hugo workspace should already be cleaned')
        receipt = json.loads(receipt_path.read_text())
        self.assertIsInstance(receipt.get('renderObservation'), dict,
                              'Same actual Hugo output needs a durable normal-receipt observation ref')
        summary = self.assert_observation_available()
        self.assertEqual(len(summary['pages']), len(self.paths))
        stored = self.observation_root / receipt['renderObservation']['path']
        for page in summary['pages']:
            blob = stored.parent / page['html']['path']
            self.assertEqual(blob.read_bytes(), outputs[page['html']['actualOutputPath']])
            self.assertTrue(page['permalink'].startswith('https://example.test/research/base/'))
        self.assertEqual(len({page['permalink'] for page in summary['pages']}), 2)
        capture = self.capture_module()
        validated = capture.validate_ref(observation_root=self.observation_root,
                                         ref=receipt['renderObservation'],
                                         expected=self.expected_binding(receipt))
        self.assertEqual(capture.observation_summary(validated)['status'], 'observation_available')

    def test_present_null_or_empty_ref_is_invalid_for_normal_loader(self):
        self.review()
        original = self.receipt()
        for malformed in (None, {}, {'contract': 'unknown', 'path': '../escape', 'sha256': '0' * 64}):
            with self.subTest(ref=malformed):
                receipt = {**original, 'renderObservation': malformed}
                self.write_receipt(receipt)
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher.load_verified_review_receipt(DATE)
        self.write_receipt(original)
        self.assert_observation_available()

    def test_missing_or_corrupt_blob_reaches_normal_ref_gate(self):
        self.review()
        receipt = self.receipt()
        manifest_path = self.observation_root / receipt['renderObservation']['path']
        manifest = json.loads(manifest_path.read_bytes())
        capture = self.capture_module()
        for role in ('html', 'record'):
            blob = manifest_path.parent / manifest['pages'][0][role]['path']
            original = blob.read_bytes()
            for damage in ('missing', 'corrupt'):
                with self.subTest(role=role, damage=damage):
                    if damage == 'missing':
                        blob.unlink()
                    else:
                        blob.write_bytes(original + b'corrupt')
                    with mock.patch.object(capture, 'validate_ref', wraps=capture.validate_ref) as validate:
                        with self.assertRaises(publisher.PublishDataValidationError):
                            publisher.load_verified_review_receipt(DATE)
                        self.assertTrue(validate.called, 'Negative must reach the new ref gate')
                    blob.write_bytes(original)
        self.assert_observation_available()

    def test_store_failure_cannot_write_a_no_ref_success_receipt(self):
        capture = self.capture_module()
        write = capture._write_new_file
        # Fail after real writes as well: the partially durable record remains
        # an orphan, and must never be downgraded to an ordinary passed receipt.
        for role, after_write in (('html', False), ('maps', True), ('manifest.json', True)):
            with self.subTest(role=role, after_write=after_write):
                hit = []
                def failing_write(path, raw, *, mode=0o600):
                    path = Path(path)
                    selected = (path.is_relative_to(self.observation_root)
                                and (path.name == role or role in path.parts))
                    if selected and not hit:
                        hit.append(path)
                        if after_write:
                            write(path, raw, mode=mode)
                        raise OSError(errno.EIO, 'injected observation store failure')
                    return write(path, raw, mode=mode)
                with mock.patch.object(capture, '_write_new_file', side_effect=failing_write):
                    with self.assertRaises((OSError, capture.CaptureError,
                                            publisher.PublishDataValidationError)):
                        self.review()
                self.assertEqual(len(hit), 1)
                self.assertFalse(publisher.review_receipt_path(DATE).exists())

    def test_receipt_write_failure_leaves_unadopted_durable_record(self):
        capture = self.capture_module()
        store = capture._persist_store
        write = publisher.atomic_write_json
        refs = []
        def actual_store(*args, **kwargs):
            ref = store(*args, **kwargs)
            refs.append(ref)
            return ref
        def fail_receipt(path, data, **kwargs):
            if Path(path) == publisher.review_receipt_path(DATE):
                raise OSError(errno.EIO, 'injected normal receipt replace failure')
            return write(path, data, **kwargs)
        with mock.patch.object(capture, '_persist_store', side_effect=actual_store), \
                mock.patch.object(publisher, 'atomic_write_json', side_effect=fail_receipt):
            with self.assertRaises(OSError):
                self.review()
        self.assertEqual(len(refs), 1)
        self.assertTrue((self.observation_root / refs[0]['path']).is_file())
        self.assertFalse(publisher.review_receipt_path(DATE).exists())
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher.load_verified_review_receipt(DATE)

    def test_receipt_directory_fsync_failure_requires_actual_disk_recheck(self):
        write = publisher.atomic_write_json
        real_fsync = os.fsync
        hit = []
        def fail_receipt_directory_sync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                hit.append(True)
                raise OSError(errno.EIO, 'injected post-replace receipt directory fsync failure')
            return real_fsync(fd)
        def receipt_write(path, data, **kwargs):
            if Path(path) != publisher.review_receipt_path(DATE):
                return write(path, data, **kwargs)
            with mock.patch.object(os, 'fsync', side_effect=fail_receipt_directory_sync):
                return write(path, data, **kwargs)
        with mock.patch.object(publisher, 'atomic_write_json', side_effect=receipt_write):
            with self.assertRaises(OSError):
                self.review()
        self.assertEqual(hit, [True])
        # The original atomic writer replaced the receipt before its directory
        # fsync failed. Report the operation as failed, but inspect actual bytes;
        # do not incorrectly claim no receipt exists or delete durable evidence.
        self.assertTrue(publisher.review_receipt_path(DATE).is_file())
        publisher.load_verified_review_receipt(DATE)
        self.assert_observation_available()

    def test_predeclared_standalone_layout_keeps_normal_no_ref_contract(self):
        # Unsupported is selected before capture begins, rather than hiding a
        # supported render/map failure after invoking Hugo.
        single = self.repo / 'layouts' / 'single.html'
        single.write_text(
            '<!doctype html><html><head><meta charset="utf-8">'
            '<link rel="canonical" href="{{ .Permalink }}"><title>{{ .Title }}</title>'
            '</head><body><h1>{{ .Title }}</h1><div class="post-content">'
            '{{ .Content }}</div></body></html>', encoding='utf-8')
        git(self.repo, 'add', '--', 'layouts/single.html')
        git(self.repo, 'commit', '-m', 'Predeclared standalone mechanical template')
        git(self.repo, 'push', 'origin', 'main')
        original = json.loads(self.manifest_path.read_bytes())
        self.base_head = publisher.validate_git_publish_branch()
        self.manifest_path = publisher.save_generation_manifest(
            DATE, self.paths, input_fingerprint=original['inputFingerprint'],
            template_fingerprint=publisher.generation_template_fingerprint(),
            base_head=self.base_head, published_papers=original['publishedPapers'],
            publication_mode=publisher.LEGACY_V5_MAINTENANCE_MODE,
            input_source_reference=original['inputSourceReference'])
        capture = self.capture_module()
        with mock.patch.object(capture, 'collect_actual_render', wraps=capture.collect_actual_render) as collect:
            self.review()
        collect.assert_not_called()
        self.assertEqual(len(self.actual_builds), 1, 'Original Hugo gate must still execute')
        publisher.load_verified_review_receipt(DATE)
        self.assertNotIn('renderObservation', self.receipt())
        self.assertEqual(publisher.read_daily_render_observation(DATE), {'status': 'not_recorded'})

    def test_store_failure_recovery_reuses_real_exact_page_passes(self):
        capture = self.capture_module()
        write = capture._write_new_file
        reviewed = []
        def offline_response(content, *args, **kwargs):
            reviewed.append(sha(content.encode()))
            return True, [], content
        self.review_response = offline_response
        hit = []
        def fail_manifest(path, raw, *, mode=0o600):
            if Path(path).is_relative_to(self.observation_root) and Path(path).name == 'manifest.json':
                hit.append(True)
                raise OSError(errno.EIO, 'injected recoverable observation manifest failure')
            return write(path, raw, mode=mode)
        with mock.patch.object(capture, '_write_new_file', side_effect=fail_manifest):
            with self.assertRaises((OSError, capture.CaptureError,
                                    publisher.PublishDataValidationError)):
                self.review()
        self.assertEqual(hit, [True])
        self.assertGreater(len(reviewed), 0)
        first_calls = list(reviewed)
        self.assertFalse(publisher.review_receipt_path(DATE).exists())
        plan = publisher.plan_incremental_review(DATE, self.paths, self.manifest_path, self.base_head)
        self.assertEqual(plan['paths'], [])
        # A failed private session is never revived. The next normal invocation
        # creates a new capture scope, while the original exact-page cache is
        # replayed by the actual normal consumer with no new text/model leaf.
        self.review()
        self.assertEqual(reviewed, first_calls)
        self.assertEqual(len(self.actual_builds), 2)
        publisher.load_verified_review_receipt(DATE)
        self.assert_observation_available()

    def test_original_normal_failure_precedes_ref_validator(self):
        self.review()
        capture = self.capture_module()
        original = self.receipt()
        self.write_receipt({**original, 'strictReview': False})
        with mock.patch.object(capture, 'validate_ref', wraps=capture.validate_ref) as validate:
            with self.assertRaisesRegex(publisher.PublishDataValidationError, '严格审查'):
                publisher.load_verified_review_receipt(DATE)
        validate.assert_not_called()

    def test_rehashed_record_cannot_shrink_scope_or_change_bound_mode(self):
        self.review()
        original_receipt = self.receipt()
        record_path = self.observation_root / original_receipt['renderObservation']['path']
        original_raw = record_path.read_bytes()
        original_record = json.loads(original_raw)
        capture = self.capture_module()
        for damage in ('shrink-scope', 'empty-known-inputs', 'change-mode'):
            with self.subTest(damage=damage):
                record = copy.deepcopy(original_record)
                if damage == 'shrink-scope':
                    record['pages'] = record['pages'][:1]
                    source = record['pages'][0]['sourcePath']
                    record['copiedSources'] = [row for row in record['copiedSources']
                                                if row['path'] == source]
                    record['coverage']['primaryHtml'] = {
                        'expectedCount': 1, 'capturedCount': 1,
                        'completeForDeclaredSourceSet': True}
                elif damage == 'empty-known-inputs':
                    record['knownInputsBefore'] = {}
                    record['knownInputsAfter'] = {}
                else:
                    record['publicationMode'] = publisher.LLM_API_PRODUCTION_MODE
                raw = json.dumps(record, ensure_ascii=False, sort_keys=True).encode() + b'\n'
                record_path.write_bytes(raw)
                receipt = copy.deepcopy(original_receipt)
                receipt['renderObservation']['sha256'] = sha(raw)
                self.write_receipt(receipt)
                with mock.patch.object(capture, 'validate_ref', wraps=capture.validate_ref) as validate:
                    with self.assertRaises(publisher.PublishDataValidationError):
                        publisher.load_verified_review_receipt(DATE)
                    self.assertTrue(validate.called, 'Original normal checks must pass first')
        record_path.write_bytes(original_raw)
        self.write_receipt(original_receipt)
        self.assert_observation_available()

    def test_rejected_text_review_never_adopts_actual_capture(self):
        self.review_response = lambda content, *args, **kwargs: (
            False, [{'severity': 'error', 'type': 'content', 'description': '受控测试拒绝'}], content)
        with self.assertRaises(publisher.PublishDataValidationError):
            self.review()
        self.assertEqual(len(self.actual_builds), 1)
        self.assertFalse(publisher.review_receipt_path(DATE).exists())
        self.assertTrue(publisher.review_failure_path(DATE).is_file())

    def test_real_asset_gate_failure_after_hugo_cannot_add_a_ref(self):
        attest = publisher.attest_api_reader_assets
        def fail_after_real_asset_gate(*args, **kwargs):
            result = attest(*args, **kwargs)
            if not kwargs.get('preflight_only'):
                raise publisher.PublishDataValidationError('injected post-Hugo asset gate failure')
            return result
        with mock.patch.object(publisher, 'attest_api_reader_assets', side_effect=fail_after_real_asset_gate):
            with self.assertRaisesRegex(publisher.PublishDataValidationError, 'post-Hugo asset gate'):
                self.review()
        self.assertEqual(len(self.actual_builds), 1)
        self.assertFalse(publisher.review_receipt_path(DATE).exists())

    def test_tampered_actual_copied_source_is_not_attached(self):
        def tamper(command):
            content = Path(command[command.index('--contentDir') + 1])
            copied = next((content / 'posts').glob('*.md'))
            copied.write_bytes(copied.read_bytes() + '\n被替换的实际复制输入。\n'.encode())
        self.before_build = tamper
        original = {path: path.read_bytes() for path in self.paths}
        with self.assertRaises((publisher.PublishDataValidationError, self.capture_module().CaptureError)):
            self.review()
        self.assertEqual({path: path.read_bytes() for path in self.paths}, original)
        self.assertFalse(publisher.review_receipt_path(DATE).exists())

    def test_config_drift_after_capture_is_not_silently_downgraded(self):
        changed = []
        change_lock = threading.Lock()
        def response(content, *args, **kwargs):
            with change_lock:
                if not changed:
                    config = self.repo / 'hugo.yaml'
                    config.write_bytes(config.read_bytes() + b'\n# changed after actual capture\n')
                    changed.append(True)
            return True, [], content
        self.review_response = response
        with self.assertRaises((publisher.PublishDataValidationError, self.capture_module().CaptureError)):
            self.review()
        self.assertEqual(changed, [True])
        self.assertEqual(len(self.actual_builds), 1)
        self.assertFalse(publisher.review_receipt_path(DATE).exists())

    def test_missing_ref_does_not_adopt_an_orphan_or_request_more_text(self):
        self.review()
        original = self.receipt()
        observation = self.observation_root / original['renderObservation']['path']
        observation_bytes = observation.read_bytes()
        # This is a normal mechanical cache reuse, not a new paid-source assertion.
        plan = publisher.plan_incremental_review(DATE, self.paths, self.manifest_path, self.base_head)
        self.assertEqual(plan['paths'], [])
        publisher.save_review_receipt(DATE, self.paths, 'hugo', expected_base_head=self.base_head,
                                     generation_manifest=self.manifest_path,
                                     reviewed_results=plan['priorResults'])
        publisher.load_verified_review_receipt(DATE)
        self.assertNotIn('renderObservation', self.receipt())
        self.assertEqual(publisher.read_daily_render_observation(DATE), {'status': 'not_recorded'})
        self.assertEqual(observation.read_bytes(), observation_bytes)

    def test_normal_local_git_publication_keeps_observation_bytes(self):
        self.review()
        original = self.receipt()
        record = self.observation_root / original['renderObservation']['path']
        before = record.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(publisher.git_push(DATE, self.paths))
        updated = self.receipt()
        self.assertEqual(updated['publicationCommit'], updated['remoteVerifiedOid'])
        self.assertEqual(updated['renderObservation'], original['renderObservation'])
        self.assertEqual(record.read_bytes(), before)
        self.assert_observation_available()
        manifest = json.loads(self.manifest_path.read_bytes())
        def reusable():
            return publisher.reusable_verified_publication_generation(
                DATE, manifest['inputFingerprint'], manifest['templateFingerprint'],
                updated['publicationCommit'])
        self.assertIsNotNone(reusable(), 'Original exact publication remains reusable')
        observation = json.loads(before)
        blob = record.parent / observation['pages'][0]['html']['path']
        raw = blob.read_bytes()
        blob.write_bytes(raw + b'corrupt')
        self.assertIsNone(reusable(), 'A present broken ref must block publication reuse too')
        blob.write_bytes(raw)
        self.assertIsNotNone(reusable())


if __name__ == '__main__':
    unittest.main()

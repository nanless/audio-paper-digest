"""Real normal/D1 mechanical integration; no paid scientific Source claim.

The previous fixture is composed, never inherited: its sixteen test methods are
not collected again. Its normal source, Hugo, asset, writer and loader are real;
only the existing offline text transport is used while preparing evidence.
"""
import contextlib
import copy
import hashlib
from html.parser import HTMLParser
import importlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import unittest
from unittest import mock
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_daily_render_observation as normal_fixture
from project_env_isolation import project_env_scope

DATE = normal_fixture.DATE
publisher = normal_fixture.publisher


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class DailyObservedProjectionIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.fixture = normal_fixture.DailyRenderObservationIntegrationTest('runTest')
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.setUp()
        self.fixture.stack.enter_context(mock.patch.object(
            publisher, 'TAG_DISPLAY_POLICY_PATH', self.fixture.root / 'absent-policy.json'))
        self.loaded = []
        self.normal_calls = []
        self.commands = []

    def consumer(self):
        return importlib.import_module('daily_observed_projection')

    def save_generation(self, *, fixture=None, include_id=None, extra_paths=()):
        fixture = fixture or self.fixture
        payload = json.loads(fixture.input_file.read_text())
        reference = publisher.build_generation_input_source_reference(fixture.input_file)
        fixture.base_head = publisher.validate_git_publish_branch()
        paths = [*fixture.paths, *extra_paths]
        fixture.manifest_path = publisher.save_generation_manifest(
            DATE, paths,
            input_fingerprint=publisher.generation_input_fingerprint(
                payload['papers'], DATE, '论文速递', False, include_id,
                input_source_reference=reference),
            template_fingerprint=publisher.generation_template_fingerprint(),
            base_head=fixture.base_head, published_papers=payload['papers'],
            publication_mode=publisher.LEGACY_V5_MAINTENANCE_MODE,
            input_source_reference=reference, include_id=include_id,
        )

    def prepare(self, *, body='', nav='', content_prefix='', include_id=None, asset=False):
        fixture = self.fixture
        if include_id:
            # A real independent one-member sealed source set, never a subset of
            # the earlier two-member input masquerading as complete scope.
            fixture.source_root = fixture.root / 'single-sources'
            payload = normal_fixture._daily_payload(fixture.source_root, [include_id])
            payload['papers'][0]['title'] = 'Same mechanical title'
            fixture.input_file.write_text(json.dumps(payload, ensure_ascii=False))
            fixture.paths[1].unlink()
            fixture.paths = fixture.paths[:1]
            publisher.DAILY_FRESH_SOURCE_RUNS_DIR = fixture.source_root
        if body:
            for path in fixture.paths:
                path.write_text(path.read_text() + '\n' + body + '\n')
        if nav or content_prefix:
            layout = fixture.repo / 'layouts/_default/baseof.html'
            layout.write_text(layout.read_text().replace('<body>', '<body>' + nav).replace(
                '{{ block "main" . }}', content_prefix + '{{ block "main" . }}'))
            normal_fixture.git(fixture.repo, 'add', '--', 'layouts')
            normal_fixture.git(fixture.repo, 'commit', '-m', 'Mechanical navigation variant')
        extras = []
        if asset:
            for relative, raw in publisher.tag_catalog_file_contents(fixture.repo).items():
                path = fixture.repo / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(raw)
                extras.append(path)
            self.asset_path = next(path for path in extras if str(path).endswith('tag-catalog-snapshot.json'))
        with publisher.publication_scope(include_id):
            self.save_generation(include_id=include_id, extra_paths=extras)
            fixture.review()
            publisher.load_verified_review_receipt(DATE)
            fixture.assert_observation_available()

    def inventory(self):
        result = {}
        for path in self.fixture.root.rglob('*'):
            relative = path.relative_to(self.fixture.root)
            if '.git' in relative.parts:
                continue
            meta = path.lstat()
            if path.is_symlink():
                result[str(relative)] = ('link', os.readlink(path))
            elif path.is_file():
                result[str(relative)] = (stat.S_IMODE(meta.st_mode), path.read_bytes())
        return result

    def read(self, *, include_id=None, unchanged=True):
        """Only external leaves are wrapped; both normal gate calls stay real."""
        import blog_entry_loader
        original_load = blog_entry_loader.load_publish_to_blog
        before = self.inventory()
        effects = []

        def load():
            # Match the original fixture's import isolation: re-importing the
            # actual owner must not silently switch its live model environment.
            # The resulting protocol is still calculated by the real function.
            with project_env_scope():
                module = original_load()
            fixture = self.fixture
            for name, value in (
                    ('BLOG_REPO', str(fixture.repo)), ('CONTENT_DIR', str(fixture.posts)),
                    ('CURRENT_DIR', fixture.current), ('DAILY_FRESH_SOURCE_RUNS_DIR', fixture.source_root),
                    ('DAILY_RENDER_OBSERVATIONS_DIR', fixture.observation_root),
                    ('TAG_DISPLAY_POLICY_PATH', fixture.root / 'absent-policy.json')):
                setattr(module, name, value)
            self.loaded.append(module)
            normal = module.load_verified_review_receipt

            def gate(date):
                call = {'module': module, 'scope': module._ACTIVE_PUBLICATION_INCLUDE_ID,
                        'date': date, 'returned': False}
                self.normal_calls.append(call)
                try:
                    result = normal(date)
                except Exception as exc:
                    call['error'] = (type(exc).__name__, str(exc))
                    raise
                call['returned'] = True
                return result

            module.load_verified_review_receipt = gate
            for name in ('call_publish_llm_api', '_llm_review_post_chunk', 'run_hugo_gate',
                         'save_review_receipt', 'save_generation_manifest', 'git_push',
                         'validate_git_commit_against_review_receipt', '_remote_main_oid'):
                if hasattr(module, name):
                    def forbidden(*args, _name=name, **kwargs):
                        effects.append(_name)
                        raise AssertionError('Read-only consumer called ' + _name)
                    setattr(module, name, forbidden)
            return module

        real_run = subprocess.Popen

        def popen(argv, *args, **kwargs):
            tokens = list(argv) if isinstance(argv, (tuple, list)) else [str(argv)]
            self.commands.append(tuple(str(v) for v in tokens))
            joined = ' '.join(str(v) for v in tokens)
            if any(v in tokens for v in ('--destination', '--contentDir', 'curl', 'gh',
                                         'ls-remote', 'push', 'fetch')):
                effects.append(joined)
                raise AssertionError('Consumer attempted build/network/publication')
            return real_run(argv, *args, **kwargs)

        with mock.patch.object(blog_entry_loader, 'load_publish_to_blog', side_effect=load), \
                mock.patch.object(subprocess, 'Popen', side_effect=popen), \
                mock.patch.object(socket, 'socket', side_effect=AssertionError('No GET/model network')):
            result = self.consumer().read_daily_observed_projection(DATE, include_id=include_id)
        self.assertEqual(effects, [])
        if unchanged:
            self.assertEqual(self.inventory(), before)
        return result

    def available(self, result):
        self.assertEqual(result['status'], 'projection_available', (result, self.normal_calls))
        self.assertEqual(result['contract'], 'daily-observed-static-page-set-v1')
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['inputBinding'], 'observed_before_after')
        self.assertEqual(result['fullInputSnapshot'], 'not_established')
        self.assertEqual(result['observationCoverage']['bodyProjection'], 'not_checked')
        self.assertTrue(result['coverage']['completeForReviewedGenerationMarkdown'])
        self.assertEqual(result['coverage']['staticProjection'], 'observed')
        for field in ('productionArtifact', 'publicAssets', 'currentEligibility', 'deployment',
                      'onlineGet', 'browserExecution'):
            self.assertEqual(result['coverage'][field], 'not_checked')
        for page in result['pages']:
            for field in ('sourceSha256', 'htmlSha256', 'identitySha256', 'bodyProjectionSha256',
                          'postContentRefsSha256', 'outsideStaticRefsSha256', 'staticRefsSha256',
                          'projectionPayloadSha256'):
                self.assertRegex(page[field], r'^[a-f0-9]{64}$')
        for field in ('recordSha256', 'reviewedMarkdownSetSha256', 'observedPageSetSha256'):
            self.assertRegex(result[field], r'^[a-f0-9]{64}$')
        self.assertGreaterEqual(len(result['unknownInputs']), 1)
        for field in ('published', 'full', 'currentEligible', 'publicationCommit',
                      'localHead', 'localTree', 'repositoryIdentity'):
            self.assertNotIn(field, result)
        return result

    def blocked(self, result):
        self.assertEqual(result['status'], 'blocked', result)
        self.assertNotIn('pages', result)
        self.assertTrue(result['issues'])

    def record(self):
        receipt = self.fixture.receipt()
        path = self.fixture.observation_root / receipt['renderObservation']['path']
        return path, json.loads(path.read_bytes())

    def raw_paths(self):
        path, record = self.record()
        return [path.parent / page['html']['path'] for page in record['pages']]

    @contextlib.contextmanager
    def after_initial_raw(self, mutation):
        capture = self.fixture.capture_module()
        original = capture.read_profile_file
        final_raw = self.raw_paths()[-1]
        hits = []

        def read(path, *args, **kwargs):
            raw = original(path, *args, **kwargs)
            if Path(path) == final_raw and not hits:
                hits.append(True)
                mutation()
            return raw

        with mock.patch.object(capture, 'read_profile_file', side_effect=read):
            yield hits
        self.assertEqual(hits, [True], 'CAS mutation must reach the actual raw read')

    @contextlib.contextmanager
    def after_projection_feed(self, mutation):
        original = HTMLParser.feed
        hits = []

        def feed(parser, text):
            result = original(parser, text)
            if type(parser).__module__ == '_daily_static_projection_snapshot' and not hits:
                hits.append(True)
                mutation()
            return result

        with mock.patch.object(HTMLParser, 'feed', feed):
            yield hits
        self.assertEqual(hits, [True], 'Mutation must follow real snapshot parser input')

    def test_real_normal_observation_has_a_read_only_projection_consumer(self):
        self.prepare()
        result = self.available(self.read())
        self.assertEqual(len(result['pages']), 2)
        self.assertEqual({page['sourcePath'] for page in result['pages']},
                         {path.relative_to(self.fixture.repo).as_posix() for path in self.fixture.paths})
        urls = {page['canonicalUrl'] for page in result['pages']}
        self.assertEqual(len(urls), 2)
        self.assertTrue(any('/custom-url/' in url for url in urls))
        self.assertTrue(any('/声音模型/' in unquote(url) for url in urls))
        self.assertEqual(result['selector'], {'workflow': 'daily', 'date': DATE, 'includeId': None})
        self.assertEqual(len(self.loaded), 1)
        self.assertEqual(len(self.normal_calls), 2)
        self.assertTrue(all(call['returned'] and call['module'] is self.loaded[0]
                            for call in self.normal_calls))
        receipt = self.fixture.receipt()
        expected = {
            'date': DATE, 'publicationMode': receipt['publicationMode'],
            'publicationScope': receipt.get('publicationScope'),
            'generationManifestSha256': sha(self.fixture.manifest_path.read_bytes()),
            'receiptSha256': sha(publisher.review_receipt_path(DATE).read_bytes()),
            'reviewBaseHead': receipt['baseHead'],
            'reviewProtocolFingerprint': receipt['reviewProtocolFingerprint'],
        }
        self.assertEqual(result['normalBinding'], expected)
        self.assertEqual(result['observationRef'], receipt['renderObservation'])
        record_path, record = self.record()
        by_source = {p['sourcePath']: p for p in record['pages']}
        for page in result['pages']:
            captured = by_source[page['sourcePath']]
            self.assertEqual(page['canonicalUrl'], captured['permalink'])
            self.assertEqual(page['htmlSha256'], captured['html']['sha256'])
            self.assertEqual(page['actualOutputPath'], captured['html']['actualOutputPath'])
            self.assertEqual(page['htmlBytes'], len((record_path.parent / captured['html']['path']).read_bytes()))

    def test_repeated_reads_have_stable_digests_and_use_fresh_real_owners(self):
        self.prepare(body='[正文](https://example.test/reference)')
        first = self.available(self.read())
        second = self.available(self.read())
        self.assertEqual(first, second)
        self.assertEqual(len(self.loaded), 2)
        self.assertIsNot(self.loaded[0], self.loaded[1])
        self.assertEqual([call['module'] for call in self.normal_calls],
                         [self.loaded[0], self.loaded[0], self.loaded[1], self.loaded[1]])

    def test_single_scope_is_entered_on_the_new_real_owner_instance(self):
        include_id = '2609.12341'
        self.prepare(include_id=include_id)
        with publisher.publication_scope('2609.99999'):
            result = self.available(self.read(include_id=include_id))
            self.assertEqual(publisher._ACTIVE_PUBLICATION_INCLUDE_ID, '2609.99999')
        self.assertEqual(len(result['pages']), 1)
        self.assertEqual(result['selector']['includeId'], include_id)
        self.assertEqual(result['normalBinding']['publicationScope'],
                         {'mode': 'single-paper', 'includeId': include_id})
        self.assertIsNot(self.loaded[0], publisher)
        self.assertTrue(all(call['scope'] == include_id for call in self.normal_calls))
        result = self.read()  # No batch receipt: never infer single scope from a manifest.
        self.assertEqual(result['status'], 'not_recorded')

    def test_default_batch_does_not_inherit_another_instance_scope(self):
        self.prepare()
        with publisher.publication_scope('2609.99999'):
            result = self.available(self.read())
        self.assertIsNone(result['selector']['includeId'])
        self.assertTrue(all(call['scope'] is None for call in self.normal_calls))

    def test_missing_receipt_is_not_recorded_without_creating_state(self):
        result = self.read()
        self.assertEqual(result['status'], 'not_recorded')
        self.assertEqual(result['normalQualification'], 'not_checked')
        self.assertNotIn('pages', result)

    def test_no_ref_keeps_orphan_unadopted_and_does_not_rebuild(self):
        self.prepare()
        plan = publisher.plan_incremental_review(DATE, self.fixture.paths,
                                                self.fixture.manifest_path, self.fixture.base_head)
        self.assertEqual(plan['paths'], [])
        publisher.save_review_receipt(DATE, self.fixture.paths, 'hugo',
                                     expected_base_head=self.fixture.base_head,
                                     generation_manifest=self.fixture.manifest_path,
                                     reviewed_results=plan['priorResults'])
        self.assertNotIn('renderObservation', self.fixture.receipt())
        result = self.read()
        self.assertEqual(result['status'], 'not_recorded')
        self.assertEqual(result['normalQualification'], 'not_checked')
        self.assertEqual(self.normal_calls, [])

    def test_present_bad_ref_never_becomes_not_recorded(self):
        self.prepare()
        original = self.fixture.receipt()
        for value in (None, {}, {'contract': 'foreign', 'path': '../escape', 'sha256': '0' * 64}):
            with self.subTest(value=value):
                self.fixture.write_receipt({**original, 'renderObservation': value})
                self.blocked(self.read())

    def test_original_normal_rejection_precedes_projection(self):
        self.prepare()
        receipt = self.fixture.receipt()
        self.fixture.write_receipt({**receipt, 'strictReview': False})
        self.blocked(self.read())
        self.assertEqual(len(self.normal_calls), 1)
        self.assertFalse(self.normal_calls[0]['returned'])

    def test_broken_html_and_map_are_rejected_by_the_real_normal_gate(self):
        self.prepare()
        record_path, record = self.record()
        for kind in ('html', 'record'):
            path = record_path.parent / record['pages'][0][kind]['path']
            original = path.read_bytes()
            for damage in ('missing', 'bad-sha'):
                with self.subTest(kind=kind, damage=damage):
                    path.unlink() if damage == 'missing' else path.write_bytes(original + b' ')
                    start = len(self.normal_calls)
                    self.blocked(self.read())
                    self.assertEqual(len(self.normal_calls), start + 1)
                    self.assertFalse(self.normal_calls[-1]['returned'])
                    path.write_bytes(original)
        self.available(self.read())

    def test_record_rehash_cannot_shrink_scope_or_change_mode(self):
        self.prepare()
        receipt = self.fixture.receipt()
        record_path, record = self.record()
        original = record_path.read_bytes()
        for damage in ('shrink', 'mode', 'known-inputs'):
            with self.subTest(damage=damage):
                value = copy.deepcopy(record)
                if damage == 'shrink':
                    value['pages'] = value['pages'][:1]
                    source = value['pages'][0]['sourcePath']
                    value['copiedSources'] = [v for v in value['copiedSources'] if v['path'] == source]
                    value['coverage']['primaryHtml'] = {
                        'expectedCount': 1, 'capturedCount': 1, 'completeForDeclaredSourceSet': True}
                elif damage == 'mode':
                    value['publicationMode'] = publisher.LLM_API_PRODUCTION_MODE
                else:
                    value['knownInputsBefore'] = value['knownInputsAfter'] = {}
                raw = json.dumps(value, ensure_ascii=False, sort_keys=True).encode() + b'\n'
                record_path.write_bytes(raw)
                changed = copy.deepcopy(receipt)
                changed['renderObservation']['sha256'] = sha(raw)
                self.fixture.write_receipt(changed)
                self.blocked(self.read())
        record_path.write_bytes(original)
        self.fixture.write_receipt(receipt)
        self.available(self.read())

    def test_final_normal_rechecks_markdown_input_and_each_sealed_source_file(self):
        self.prepare()
        self.available(self.read())
        source_files = sorted(self.fixture.source_root.rglob('source*.*'))
        self.assertEqual({p.name for p in source_files},
                         {'source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'})
        targets = [self.fixture.paths[0], self.fixture.input_file, *source_files]
        for target in targets:
            with self.subTest(target=target.name):
                original = target.read_bytes()
                count = len(self.normal_calls)
                with self.after_initial_raw(lambda: target.write_bytes(original + b'\n')):
                    self.blocked(self.read(unchanged=False))
                self.assertEqual(len(self.normal_calls), count + 2)
                self.assertTrue(self.normal_calls[-2]['returned'])
                self.assertFalse(self.normal_calls[-1]['returned'])
                target.write_bytes(original)
        self.available(self.read())

    def test_final_cas_rejects_receipt_generation_ref_map_and_html_drift(self):
        self.prepare()
        record_path, record = self.record()
        targets = [publisher.review_receipt_path(DATE), self.fixture.manifest_path,
                   record_path, record_path.parent / record['pages'][0]['record']['path'],
                   self.raw_paths()[0]]
        for target in targets:
            with self.subTest(target=target.name):
                original = target.read_bytes()
                with self.after_initial_raw(lambda: target.write_bytes(original + b'\n')):
                    self.blocked(self.read(unchanged=False))
                target.write_bytes(original)
        self.available(self.read())

    def test_present_ref_cannot_disappear_during_the_read(self):
        self.prepare()
        path = publisher.review_receipt_path(DATE)
        original = path.read_bytes()

        def remove_ref():
            receipt = json.loads(original)
            del receipt['renderObservation']
            self.fixture.write_receipt(receipt)

        with self.after_initial_raw(remove_ref):
            self.blocked(self.read(unchanged=False))
        path.write_bytes(original)
        self.available(self.read())

    def test_cas_rejects_switch_to_another_genuinely_valid_review_receipt(self):
        self.prepare()
        path = publisher.review_receipt_path(DATE)
        first = path.read_bytes()
        self.fixture.review()  # Real unchanged-page cache reuse, new durable D1 record.
        second = path.read_bytes()
        self.assertNotEqual(json.loads(first)['renderObservation'], json.loads(second)['renderObservation'])
        publisher.load_verified_review_receipt(DATE)
        path.write_bytes(first)
        with self.after_initial_raw(lambda: path.write_bytes(second)):
            self.blocked(self.read(unchanged=False))
        # The second normal gate itself can accept the second real snapshot;
        # only the transaction's physical initial-receipt binding disallows it.
        self.assertTrue(self.normal_calls[-1]['returned'])
        path.write_bytes(first)
        self.available(self.read())

    def test_final_normal_rejects_runtime_and_real_model_identity_drift(self):
        self.prepare()
        config = self.fixture.repo / 'hugo.yaml'
        original = config.read_bytes()
        with self.after_initial_raw(lambda: config.write_bytes(original + b'\n')):
            self.blocked(self.read(unchanged=False))
        config.write_bytes(original)
        old_model = os.environ.get('PAPER_ANALYZER_MODEL')
        with self.after_initial_raw(lambda: os.environ.__setitem__(
                'PAPER_ANALYZER_MODEL', 'offline-protocol-drift-example')):
            self.blocked(self.read())
        if old_model is None:
            os.environ.pop('PAPER_ANALYZER_MODEL', None)
        else:
            os.environ['PAPER_ANALYZER_MODEL'] = old_model
        self.available(self.read())

    def test_final_normal_rechecks_a_real_controlled_catalog_asset(self):
        self.prepare(asset=True)
        self.available(self.read())
        original = self.asset_path.read_bytes()
        count = len(self.normal_calls)
        with self.after_initial_raw(lambda: self.asset_path.write_bytes(original + b'\n')):
            self.blocked(self.read(unchanged=False))
        self.assertEqual(len(self.normal_calls), count + 2)
        self.assertTrue(self.normal_calls[-2]['returned'])
        self.assertFalse(self.normal_calls[-1]['returned'])
        self.asset_path.write_bytes(original)
        self.available(self.read())

    def test_profile_and_owner_disk_drift_are_checked_against_real_snapshot_bytes(self):
        self.prepare()
        self.available(self.read())
        scripts = Path(normal_fixture.__file__).resolve().parents[2] / 'scripts'
        capture = self.fixture.capture_module()
        original_reader = capture.read_profile_file
        for name in ('daily_html_projection.py', 'daily_observed_projection.py'):
            with self.subTest(name=name):
                source = scripts / name
                copied = self.fixture.root / ('source-copy-' + name)
                copied.write_bytes(source.read_bytes())

                def routed(path, *args, **kwargs):
                    return original_reader(copied if Path(path) == source else path, *args, **kwargs)

                with mock.patch.object(capture, 'read_profile_file', side_effect=routed), \
                        self.after_projection_feed(lambda: copied.write_bytes(copied.read_bytes() + b'\n')):
                    self.blocked(self.read(unchanged=False))
                self.assertEqual(source.read_bytes() + b'\n', copied.read_bytes())
                copied.unlink()
        self.available(self.read())

    def test_unsafe_stored_file_shapes_cannot_be_read_as_html(self):
        self.prepare()
        target = self.raw_paths()[0]
        original = target.read_bytes()
        alias = self.fixture.root / 'html-alias.bin'
        alias.write_bytes(original)
        for shape in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(shape=shape):
                target.unlink()
                if shape == 'symlink':
                    target.symlink_to(alias)
                elif shape == 'hardlink':
                    os.link(alias, target)
                else:
                    os.mkfifo(target, 0o600)
                self.blocked(self.read())
                target.unlink()
                target.write_bytes(original)
                target.chmod(0o600)
        alias.unlink()
        self.available(self.read())

    def variant(self, **kwargs):
        """A second legitimately reviewed variant, never rehashed fake evidence."""
        previous = self.fixture
        fixture = normal_fixture.DailyRenderObservationIntegrationTest('runTest')
        try:
            fixture.setUp()
            self.fixture = fixture
            self.prepare(**kwargs)
            return copy.deepcopy(self.available(self.read()))
        finally:
            fixture.doCleanups()
            self.fixture = previous

    def test_outside_navigation_does_not_pollute_body_reference_domains(self):
        base = self.variant(body='[正文链接](https://example.test/paper?a=1&b=2)')
        changed = self.variant(
            body='[正文链接](https://example.test/paper?a=1&b=2)',
            nav='<nav><a href="/navigation/">导航</a>'
                '<img src="/outside.png" alt="导航图"></nav>')
        for first, second in zip(base['pages'], changed['pages']):
            for field in ('sourcePath', 'identitySha256', 'bodyProjectionSha256',
                          'postContentRefsSha256'):
                self.assertEqual(first[field], second[field], field)
            for field in ('outsideStaticRefsSha256', 'staticRefsSha256', 'projectionPayloadSha256'):
                self.assertNotEqual(first[field], second[field], field)

    def test_body_href_src_download_alt_and_order_are_in_body_digests(self):
        original = '<a href="/a.pdf" download>下载</a><img src="/a.png" alt="原图">'
        base = self.variant(content_prefix=original)
        variants = (
            original.replace('/a.pdf', '/b.pdf'),
            original.replace(' download', ' download="paper.pdf"'),
            original.replace('/a.png', '/b.png'),
            original.replace('alt="原图"', 'alt="新图"'),
            '<img src="/a.png" alt="原图"><a href="/a.pdf" download>下载</a>',
        )
        for markup in variants:
            with self.subTest(markup=markup):
                changed = self.variant(content_prefix=markup)
                for first, second in zip(base['pages'], changed['pages']):
                    self.assertEqual(first['identitySha256'], second['identitySha256'])
                    self.assertEqual(first['outsideStaticRefsSha256'], second['outsideStaticRefsSha256'])
                    for field in ('bodyProjectionSha256', 'postContentRefsSha256'):
                        self.assertNotEqual(first[field], second[field], field)

    def test_profile_unsupported_is_whole_set_and_keeps_original_d1_fact(self):
        self.prepare(content_prefix='<img src="/a.png" srcset="/a.png 1x, /b.png 2x" alt="图">')
        self.fixture.assert_observation_available()
        result = self.read()
        self.assertEqual(result['status'], 'unsupported', result)
        self.assertNotIn('pages', result)
        self.assertTrue(result['issues'])

    def test_bad_html_is_blocked_instead_of_partial_projection_success(self):
        # D1 observes bytes and canonical identity; the new profile must reject
        # its own malformed/unsupported distinctions without filtering a page.
        self.prepare(content_prefix='<b>')
        result = self.read()
        self.assertEqual(result['status'], 'blocked', result)
        self.assertEqual(result['issues'][0]['code'], 'invalid_html_structure')
        self.assertTrue(self.normal_calls[0]['returned'], 'Malformed HTML must reach the profile gate')
        self.assertNotIn('pages', result)

    def test_api_does_not_accept_external_roots_or_trusted_json(self):
        consumer = self.consumer()
        for keyword in ('summary', 'ref', 'root', 'owner', 'fingerprint', 'skip', 'trusted'):
            with self.subTest(keyword=keyword), self.assertRaises(TypeError):
                consumer.read_daily_observed_projection(DATE, **{keyword: {}})


if __name__ == '__main__':
    unittest.main()

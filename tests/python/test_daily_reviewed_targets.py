"""Reviewed primary targets through actual normal/D1 mechanical evidence.

Composition reuses only fixture preparation, never collects the previous tests.
No paid scientific qualification or production-artifact proof is asserted.
"""
import contextlib
import copy
import hashlib
from html.parser import HTMLParser
import importlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import unittest
from unittest import mock
from urllib.parse import quote, unquote, urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_daily_observed_projection as observed_fixture
from project_env_isolation import project_env_scope

DATE = observed_fixture.DATE
publisher = observed_fixture.publisher
TARGET_CONTRACT = 'daily-reviewed-primary-targets-v2'


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class DailyReviewedTargetsIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.case = observed_fixture.DailyObservedProjectionIntegrationTest('runTest')
        self.addCleanup(self.case.doCleanups)
        self.case.setUp()
        self.fixture = self.case.fixture
        self.loaded = []
        self.normal_calls = []
        self.commands = []
        self.events = []

    def owner(self):
        return importlib.import_module('daily_observed_projection')

    def read(self, *, projection=False, include_id=None, unchanged=True):
        """Wrap external assembly/effect leaves, never normal/core/protocol."""
        import blog_entry_loader
        real_load = blog_entry_loader.load_publish_to_blog
        before = self.case.inventory()
        effects = []

        def load():
            with project_env_scope():
                module = real_load()
            for name, value in (
                    ('BLOG_REPO', str(self.fixture.repo)), ('CONTENT_DIR', str(self.fixture.posts)),
                    ('CURRENT_DIR', self.fixture.current),
                    ('DAILY_FRESH_SOURCE_RUNS_DIR', self.fixture.source_root),
                    ('DAILY_RENDER_OBSERVATIONS_DIR', self.fixture.observation_root),
                    ('TAG_DISPLAY_POLICY_PATH', self.fixture.root / 'absent-policy.json')):
                setattr(module, name, value)
            self.loaded.append(module)
            normal = module.load_verified_review_receipt
            lock = module.blog_publication_lock

            def gate(date):
                call = {'module': module, 'scope': module._ACTIVE_PUBLICATION_INCLUDE_ID,
                        'returned': False}
                self.normal_calls.append(call)
                self.events.append('normal')
                try:
                    result = normal(date)
                except Exception as exc:
                    call['error'] = (type(exc).__name__, str(exc))
                    raise
                call['returned'] = True
                return result

            @contextlib.contextmanager
            def held(date, **kwargs):
                self.events.append('lock-enter')
                with lock(date, **kwargs):
                    yield
                self.events.append('lock-exit')

            module.load_verified_review_receipt = gate
            module.blog_publication_lock = held
            for name in ('call_publish_llm_api', '_llm_review_post_chunk', 'run_hugo_gate',
                         'save_review_receipt', 'save_generation_manifest', 'git_push',
                         'validate_git_commit_against_review_receipt', '_remote_main_oid',
                         'reusable_verified_publication_generation'):
                if hasattr(module, name):
                    def forbidden(*args, _name=name, **kwargs):
                        effects.append(_name)
                        raise AssertionError('Read-only target called ' + _name)
                    setattr(module, name, forbidden)
            return module

        real_popen = subprocess.Popen

        def popen(argv, *args, **kwargs):
            tokens = list(argv) if isinstance(argv, (tuple, list)) else [str(argv)]
            self.commands.append(tuple(str(v) for v in tokens))
            if any(v in tokens for v in ('--destination', '--contentDir', 'curl', 'gh',
                                         'ls-remote', 'push', 'fetch')):
                effects.append('subprocess')
                raise AssertionError('No build/remote request/publication')
            return real_popen(argv, *args, **kwargs)

        owner = self.owner()
        called_public_projection = []
        projection_code = owner.read_daily_observed_projection.__code__

        def profile(frame, event, _arg):
            if event == 'call' and frame.f_code is projection_code:
                called_public_projection.append(True)

        prior_profile = sys.getprofile()
        try:
            if not projection:
                sys.setprofile(profile)
            with mock.patch.object(blog_entry_loader, 'load_publish_to_blog', side_effect=load), \
                    mock.patch.object(subprocess, 'Popen', side_effect=popen), \
                    mock.patch.object(socket, 'socket', side_effect=AssertionError('No network')):
                function = owner.read_daily_observed_projection if projection else owner.read_daily_reviewed_targets
                result = function(DATE, include_id=include_id)
        finally:
            sys.setprofile(prior_profile)
        self.assertEqual(effects, [])
        self.assertEqual(called_public_projection, [], 'Targets must share the locked driver, not unlock a public read')
        if unchanged:
            self.assertEqual(self.case.inventory(), before)
        return result

    def target(self, result):
        self.assertEqual(result['status'], 'reviewed_targets_observed', (result, self.normal_calls))
        self.assertEqual(result['contract'], TARGET_CONTRACT)
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['profile']['contract'], 'daily-static-html-projection-v2')
        self.assertNotIn('pages', result)
        self.assertEqual(result['inputBinding'], 'observed_before_after')
        self.assertEqual(result['fullInputSnapshot'], 'not_established')
        self.assertEqual(result['observationCoverage']['bodyProjection'], 'not_checked')
        self.assertTrue(result['coverage']['completeForReviewedGenerationMarkdown'])
        self.assertEqual(result['coverage']['staticProjection'], 'observed')
        for field in ('publicationGit', 'productionArtifact', 'publicAssets', 'currentEligibility',
                      'deployment', 'onlineGet', 'browserExecution'):
            self.assertEqual(result['coverage'][field], 'not_checked')
        for field in ('publicationCommit', 'remoteVerifiedOid', 'full', 'published', 'currentEligible'):
            self.assertNotIn(field, result)
            self.assertNotIn(field, result['normalBinding'])
        target_fields = ('contract', 'version', 'selector', 'reviewedSitePolicy',
                         'reviewedFileSetSha256', 'reviewedFileCount', 'primarySourceSetSha256',
                         'primaryPages', 'changes', 'profile', 'coverage')
        self.assertEqual(result['targetsSha256'], sha(canonical({key: result[key] for key in target_fields})))
        self.assertEqual(result['recordSha256'], sha(canonical({key: value for key, value in result.items()
                                                              if key != 'recordSha256'})))
        self.assertEqual(result['changes']['deletedUrls'], None)
        self.assertEqual(result['changes']['deletionUrlCoverage'], 'not_recorded')
        self.assertEqual(result['changes']['aliasCoverage'], 'not_checked')
        return result

    def failure(self, result, status='blocked'):
        self.assertEqual(result['status'], status, result)
        self.assertEqual(result['contract'], TARGET_CONTRACT)
        self.assertEqual(result['version'], 2)
        for field in ('pages', 'primaryPages', 'targetsSha256', 'recordSha256'):
            self.assertNotIn(field, result)
        if status == 'not_recorded':
            self.assertEqual(result['normalQualification'], 'not_checked')
        else:
            self.assertTrue(result['issues'])

    def prepare_changes(self):
        """Real modified/new pages, unchanged catalog assets and two tombstones."""
        fixture = self.fixture
        assets = []
        for relative, raw in publisher.tag_catalog_file_contents(fixture.repo).items():
            path = fixture.repo / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            assets.append(path)
        retired_page = fixture.posts / f'{DATE}-retired-page.md'
        retired_page.write_text('---\ntitle: Retired\nslug: unknowable-old-route\n---\nOld mechanical page.\n')
        retired_asset = fixture.repo / f'static/data/papers/{DATE}/retired-paper/rethink-context.json'
        retired_asset.parent.mkdir(parents=True, exist_ok=True)
        retired_asset.write_text('{"retiredMechanicalFixture":true}\n')
        relative = [path.relative_to(fixture.repo).as_posix()
                    for path in [fixture.paths[0], retired_page, retired_asset, *assets]]
        observed_fixture.normal_fixture.git(fixture.repo, 'add', '--', *relative)
        observed_fixture.normal_fixture.git(fixture.repo, 'commit', '-m', 'Mechanical target base with retired paths')
        retired_page.unlink()
        retired_asset.unlink()
        fixture.paths[0].write_text(fixture.paths[0].read_text() + '\n实际修改后的机械段落。\n')
        self.case.save_generation(extra_paths=[*assets, retired_page, retired_asset])
        fixture.review()
        publisher.load_verified_review_receipt(DATE)
        fixture.assert_observation_available()
        self.deleted = sorted(path.relative_to(fixture.repo).as_posix()
                              for path in (retired_page, retired_asset))
        self.assets = assets

    def test_actual_normal_d1_has_a_reviewed_targets_reader(self):
        self.case.prepare()
        self.fixture.assert_observation_available()
        result = self.target(self.read())
        record_path, record = self.case.record()
        receipt = self.fixture.receipt()
        self.assertEqual(result['reviewedSitePolicy'], record['sitePolicy'])
        self.assertEqual(result['normalBinding']['reviewedAt'], receipt['reviewedAt'])
        self.assertEqual(result['selector'], {'workflow': 'daily', 'date': DATE, 'includeId': None})
        self.assertEqual(len(result['primaryPages']), 2)
        captured = {page['sourcePath']: page for page in record['pages']}
        for page in result['primaryPages']:
            original = captured[page['sourcePath']]
            for key, expected in (
                    ('sourceSha256', original['sourceSha256']), ('canonicalUrl', original['permalink']),
                    ('relPermalink', original['relPermalink']), ('mapSha256', original['record']['sha256']),
                    ('mapBytes', original['record']['bytes']), ('htmlSha256', original['html']['sha256']),
                    ('actualOutputPath', original['html']['actualOutputPath'])):
                self.assertEqual(page[key], expected)
        urls = [page['canonicalUrl'] for page in result['primaryPages']]
        self.assertEqual(len(set(urls)), 2)
        self.assertTrue(any('/custom-url/' in url for url in urls))
        self.assertTrue(any('/声音模型/' in unquote(url) for url in urls))
        self.assertEqual(self.events, ['lock-enter', 'normal', 'normal', 'lock-exit'])
        self.assertEqual(len(self.loaded), 1)
        self.assertTrue(all(call['returned'] and call['module'] is self.loaded[0]
                            for call in self.normal_calls))

    def test_full_file_digest_keeps_assets_and_deleted_paths_but_never_guesses_old_urls(self):
        self.prepare_changes()
        result = self.target(self.read())
        rows = [{key: row[key] for key in ('path', 'deleted', 'sha256')}
                for row in self.fixture.receipt()['files']]
        rows.sort(key=lambda row: row['path'])
        primary = [{'path': row['path'], 'sha256': row['sha256']} for row in rows
                   if not row['deleted'] and row['path'].endswith('.md')]
        self.assertEqual(result['reviewedFileCount'], len(rows))
        self.assertGreater(len(rows), len(primary))
        self.assertEqual(result['reviewedFileSetSha256'], sha(canonical(rows)))
        self.assertEqual(result['primarySourceSetSha256'], sha(canonical(primary)))
        self.assertEqual(result['changes']['deletedPaths'], self.deleted)
        self.assertEqual(result['changes']['deletedPathSetSha256'], sha(canonical(self.deleted)))
        self.assertEqual({page['sourcePath'] for page in result['primaryPages']},
                         {row['path'] for row in primary})
        self.assertTrue(any(not row['deleted'] and row['path'].startswith('static/') for row in rows))
        self.assertNotIn('unknowable-old-route', canonical(result).decode())

    def test_explicit_custom_url_is_taken_from_actual_hugo_map(self):
        path = self.fixture.paths[0]
        path.write_text(path.read_text().replace('slug: "custom-url"',
                                               'url: "/research/base/frozen-explicit/"'))
        self.case.prepare()
        result = self.target(self.read())
        _record_path, record = self.case.record()
        original = {row['sourcePath']: row for row in record['pages']}
        custom = next(page for page in result['primaryPages'] if page['sourcePath'] == path.relative_to(self.fixture.repo).as_posix())
        self.assertIn('frozen-explicit', custom['canonicalUrl'])
        self.assertEqual(custom['canonicalUrl'], original[custom['sourcePath']]['permalink'])
        self.assertNotIn(path.stem, custom['canonicalUrl'])

    def test_single_scope_has_an_independent_complete_source_set(self):
        include_id = '2609.12341'
        self.case.prepare(include_id=include_id)
        with publisher.publication_scope('2609.99999'):
            result = self.target(self.read(include_id=include_id))
            self.assertEqual(publisher._ACTIVE_PUBLICATION_INCLUDE_ID, '2609.99999')
        self.assertEqual(len(result['primaryPages']), 1)
        self.assertEqual(result['selector']['includeId'], include_id)
        self.assertEqual(result['normalBinding']['publicationScope'],
                         {'mode': 'single-paper', 'includeId': include_id})
        self.assertTrue(all(call['scope'] == include_id for call in self.normal_calls))
        self.assertIsNot(self.loaded[0], publisher)
        self.failure(self.read(), 'not_recorded')  # Never infer a single scope.

    def test_batch_does_not_inherit_a_different_publisher_instance_scope(self):
        self.case.prepare()
        with publisher.publication_scope('2609.99999'):
            result = self.target(self.read())
        self.assertIsNone(result['selector']['includeId'])
        self.assertTrue(all(call['scope'] is None for call in self.normal_calls))

    def test_projection_field_shape_and_semantic_digests_stay_independent(self):
        self.case.prepare(body='[正文链接](https://example.test/data?a=1&b=2)')
        old = self.read(projection=True)
        self.case.available(old)
        result = self.target(self.read())
        self.assertEqual(set(old), {'contract', 'version', 'status', 'selector', 'profile',
            'implementationObservation', 'normalBinding', 'observationRef', 'pages',
            'reviewedMarkdownSetSha256', 'observedPageSetSha256', 'inputBinding',
            'fullInputSnapshot', 'observationCoverage', 'coverage', 'unknownInputs', 'recordSha256'})
        self.assertNotIn('reviewedAt', old['normalBinding'])
        self.assertNotIn('publicationGit', old['coverage'])
        self.assertEqual(old['reviewedMarkdownSetSha256'], result['primarySourceSetSha256'])
        self.assertEqual(old['observationCoverage'], result['observationCoverage'])
        old_pages = {page['sourcePath']: page for page in old['pages']}
        for page in result['primaryPages']:
            for key, value in old_pages[page['sourcePath']].items():
                self.assertEqual(page[key], value, key)
        self.assertTrue(set(old['unknownInputs']) <= set(result['unknownInputs']))

    def test_all_missing_and_invalid_ref_results_use_the_new_contract(self):
        self.failure(self.read(), 'not_recorded')
        self.case.prepare()
        original = self.fixture.receipt()
        for value in (None, {}, {'contract': 'foreign', 'path': '../escape', 'sha256': '0' * 64}):
            with self.subTest(ref=value):
                self.fixture.write_receipt({**original, 'renderObservation': value})
                self.failure(self.read())
        self.fixture.write_receipt(original)
        plan = publisher.plan_incremental_review(DATE, self.fixture.paths,
                                                self.fixture.manifest_path, self.fixture.base_head)
        self.assertEqual(plan['paths'], [])
        publisher.save_review_receipt(DATE, self.fixture.paths, 'hugo',
                                     expected_base_head=self.fixture.base_head,
                                     generation_manifest=self.fixture.manifest_path,
                                     reviewed_results=plan['priorResults'])
        self.assertNotIn('renderObservation', self.fixture.receipt())
        result = self.read()
        self.failure(result, 'not_recorded')
        old = self.read(projection=True)
        self.assertEqual(old['contract'], 'daily-observed-static-page-set-v2')
        self.assertEqual(old['status'], 'not_recorded')

    def test_original_normal_ref_and_map_gates_are_not_replaced_by_targets(self):
        self.case.prepare()
        original_receipt = self.fixture.receipt()
        record_path, original_record = self.case.record()
        original_raw = record_path.read_bytes()
        changed = copy.deepcopy(original_receipt)
        changed['strictReview'] = False
        self.fixture.write_receipt(changed)
        self.failure(self.read())
        self.assertFalse(self.normal_calls[-1]['returned'])
        self.fixture.write_receipt(original_receipt)
        for kind in ('html', 'record'):
            path = record_path.parent / original_record['pages'][0][kind]['path']
            raw = path.read_bytes()
            path.write_bytes(raw + b' ')
            self.failure(self.read())
            self.assertFalse(self.normal_calls[-1]['returned'])
            path.write_bytes(raw)
        for damage in ('policy-outside-origin', 'bad-relative-url', 'map-sha', 'reviewed-files'):
            with self.subTest(damage=damage):
                record = copy.deepcopy(original_record)
                if damage == 'policy-outside-origin':
                    record['sitePolicy']['origin'] = 'https://outside.invalid'
                elif damage == 'bad-relative-url':
                    record['pages'][0]['relPermalink'] = '/outside/'
                elif damage == 'map-sha':
                    record['pages'][0]['record']['sha256'] = '0' * 64
                else:
                    record['reviewedFiles'] = record['reviewedFiles'][:1]
                raw = self.fixture.capture_module()._json_bytes(record) + b'\n'
                record_path.write_bytes(raw)
                changed = copy.deepcopy(original_receipt)
                changed['renderObservation']['sha256'] = sha(raw)
                self.fixture.write_receipt(changed)
                start = len(self.normal_calls)
                self.failure(self.read())
                self.assertEqual(len(self.normal_calls), start + 1)
                self.assertFalse(self.normal_calls[-1]['returned'])
        record_path.write_bytes(original_raw)
        self.fixture.write_receipt(original_receipt)
        self.target(self.read())

    def test_target_metadata_and_raw_bytes_share_the_same_final_cas(self):
        self.case.prepare()
        record_path, record = self.case.record()
        targets = [publisher.review_receipt_path(DATE), self.fixture.manifest_path,
                   record_path, record_path.parent / record['pages'][0]['record']['path'],
                   self.case.raw_paths()[0], self.fixture.paths[0], self.fixture.input_file]
        for path in targets:
            with self.subTest(path=path.name):
                raw = path.read_bytes()
                with self.case.after_initial_raw(lambda: path.write_bytes(raw + b'\n')):
                    self.failure(self.read(unchanged=False))
                path.write_bytes(raw)
        self.target(self.read())

    def test_targets_cannot_switch_to_a_second_valid_snapshot(self):
        self.case.prepare()
        receipt_path = publisher.review_receipt_path(DATE)
        first = receipt_path.read_bytes()
        self.fixture.review()
        second = receipt_path.read_bytes()
        self.assertNotEqual(json.loads(first)['renderObservation'], json.loads(second)['renderObservation'])
        publisher.load_verified_review_receipt(DATE)
        receipt_path.write_bytes(first)
        with self.case.after_initial_raw(lambda: receipt_path.write_bytes(second)):
            self.failure(self.read(unchanged=False))
        self.assertTrue(self.normal_calls[-1]['returned'])
        receipt_path.write_bytes(first)
        self.target(self.read())

    def test_profile_unsupported_rejects_the_entire_targets_scope(self):
        # The lexically first source really projects; only the second fails.
        # No returned prefix can masquerade as the complete reviewed scope.
        self.case.prepare(content_prefix='{{ if eq .Params.paper_digest_arxiv_id "2609.12342" }}'
                          '<img src="/a.png" srcset="/a.png 1x, /b.png 2x" alt="图">{{ end }}')
        self.fixture.assert_observation_available()
        actual_feed = HTMLParser.feed
        parsed = []

        def feed(parser, text):
            if type(parser).__module__ == '_daily_static_projection_snapshot':
                parsed.append(True)
            return actual_feed(parser, text)

        with mock.patch.object(HTMLParser, 'feed', feed):
            result = self.read()
        self.assertEqual(len(parsed), 2)
        self.failure(result, 'unsupported')
        self.assertEqual(result['issues'][0]['sourcePath'], self.fixture.paths[1].relative_to(self.fixture.repo).as_posix())
        old = self.read(projection=True)
        self.assertEqual(old['contract'], 'daily-observed-static-page-set-v2')
        self.assertEqual(old['status'], 'unsupported')

    def test_new_target_binding_budget_rejects_a_legal_long_cold_timestamp(self):
        self.case.prepare()
        original_receipt = self.fixture.receipt()
        record_path, original_record = self.case.record()
        timestamp = '2026-09-07T12:00:00.' + '0' * 9000 + '+08:00'
        record = copy.deepcopy(original_record)
        record['reviewedAt'] = timestamp
        raw = self.fixture.capture_module()._json_bytes(record) + b'\n'
        record_path.write_bytes(raw)
        receipt = copy.deepcopy(original_receipt)
        receipt['reviewedAt'] = timestamp
        receipt['renderObservation']['sha256'] = sha(raw)
        self.fixture.write_receipt(receipt)
        publisher.load_verified_review_receipt(DATE)
        result = self.read()
        self.failure(result)
        self.assertEqual(result['issues'][0]['code'], 'limit_exceeded')
        self.assertTrue(self.normal_calls[0]['returned'])
        # The old projection's contract omits reviewedAt and must not acquire
        # this new output restriction through a shared-driver refactor.
        self.case.available(self.read(projection=True))

    def test_actual_unicode_urls_feed_a_token_key_without_rewriting_target_values(self):
        self.case.prepare()
        result = self.target(self.read())
        owner = self.owner()
        policy = result['reviewedSitePolicy']
        actual = next(page['canonicalUrl'] for page in result['primaryPages']
                      if '/声音模型/' in unquote(page['canonicalUrl']))
        parts = urlsplit(actual)
        raw_unicode = urlunsplit((parts.scheme, parts.netloc, unquote(parts.path), '', ''))
        encoded = urlunsplit((parts.scheme, parts.netloc,
                              quote(unquote(parts.path), safe='/'), '', ''))
        # Change only percent-hex case, never the case of literal path letters.
        lower_hex = re.sub(r'%[0-9A-Fa-f]{2}', lambda m: m.group().lower(), encoded)
        keys = [owner._target_url_key(value, policy) for value in (actual, raw_unicode, encoded, lower_hex)]
        self.assertTrue(all(key == keys[0] for key in keys))
        explicit_443 = urlunsplit(('https', parts.hostname.upper() + ':443', parts.path, '', ''))
        self.assertEqual(owner._target_url_key(explicit_443, policy), keys[0])
        self.assertEqual(next(page['canonicalUrl'] for page in result['primaryPages']
                              if page['canonicalUrl'] == actual), actual)

    def test_token_key_preserves_reserved_case_unicode_and_route_distinctions(self):
        owner = self.owner()
        policy = {'origin': 'https://example.test', 'basePath': '/research/base/'}
        prefix = policy['origin'] + policy['basePath']
        for first, second in (
                ('a;b/', 'a%3Bb/'), ('a:b/', 'a%3Ab/'), ('a+b/', 'a%2Bb/'),
                ('a@b/', 'a%40b/'), ('Upper/', 'upper/'), ('café/', 'cafe\u0301/'),
                ('route', 'route/'), ('route/', 'route/index.html'), ('a//b/', 'a/b/')):
            with self.subTest(first=first, second=second):
                self.assertNotEqual(owner._target_url_key(prefix + first, policy),
                                    owner._target_url_key(prefix + second, policy))
        for path in ('%2Fescape/', '%2e%2e/escape/', '%252Fescape/', '%FF/',
                     '../escape/', 'bad%zz/', 'has%00control/'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                owner._target_url_key(prefix + path, policy)

    def test_target_origin_port_zero_is_rejected_after_the_real_legacy_cold_gate(self):
        self.case.prepare()
        self.target(self.read())
        receipt = self.fixture.receipt()
        record_path, record = self.case.record()
        page = record['pages'][0]
        old_url = page['permalink']
        parts = urlsplit(old_url)
        port_zero = urlunsplit((parts.scheme, parts.hostname + ':0', parts.path, '', ''))
        html_path = record_path.parent / page['html']['path']
        html = html_path.read_bytes().replace(old_url.encode(), port_zero.encode())
        html_path.write_bytes(html)
        map_path = record_path.parent / page['record']['path']
        machine = json.loads(map_path.read_bytes())
        machine['permalink'] = port_zero
        for output in machine['outputs']:
            if output['permalink'] == old_url:
                output['permalink'] = port_zero
        map_raw = self.fixture.capture_module()._json_bytes(machine) + b'\n'
        map_path.write_bytes(map_raw)
        page['permalink'] = port_zero
        page['html'].update(sha256=sha(html), bytes=len(html))
        page['record'].update(sha256=sha(map_raw), bytes=len(map_raw))
        record_raw = self.fixture.capture_module()._json_bytes(record) + b'\n'
        record_path.write_bytes(record_raw)
        receipt['renderObservation']['sha256'] = sha(record_raw)
        self.fixture.write_receipt(receipt)
        # A legal legacy cold-schema shape, not a claim that current Hugo
        # naturally produced it. The original port-or-443 gate really accepts.
        publisher.load_verified_review_receipt(DATE)
        self.case.available(self.read(projection=True))
        start = len(self.normal_calls)
        result = self.read()
        self.failure(result)
        self.assertTrue(self.normal_calls[start]['returned'])
        self.assertNotIn(':0', canonical(result).decode())

    def test_target_implementation_drift_is_detected_without_patching_its_functions(self):
        self.case.prepare()
        self.target(self.read())
        source = Path(observed_fixture.__file__).resolve().parents[2] / 'scripts/daily_observed_projection.py'
        copied = self.fixture.root / 'owner-source-copy.py'
        copied.write_bytes(source.read_bytes())
        capture = self.fixture.capture_module()
        actual_read = capture.read_profile_file

        def routed(path, *args, **kwargs):
            return actual_read(copied if Path(path) == source else path, *args, **kwargs)

        with mock.patch.object(capture, 'read_profile_file', side_effect=routed), \
                self.case.after_projection_feed(lambda: copied.write_bytes(copied.read_bytes() + b'\n')):
            self.failure(self.read(unchanged=False))
        self.assertEqual(copied.read_bytes(), source.read_bytes() + b'\n')
        copied.unlink()
        self.target(self.read())

    def test_api_has_no_external_trusted_target_or_root_inputs(self):
        owner = self.owner()
        for keyword in ('targets', 'summary', 'ref', 'root', 'repo', 'owner', 'fingerprint', 'trusted', 'skip'):
            with self.subTest(keyword=keyword), self.assertRaises(TypeError):
                owner.read_daily_reviewed_targets(DATE, **{keyword: {}})


if __name__ == '__main__':
    unittest.main()

"""Bounded mechanical target identities; these facts never grant Source scope."""
import contextlib
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import daily_observed_projection as owner


POLICY = {'origin': 'https://example.test', 'basePath': '/research/base/'}
CONTRACT = 'daily-reviewed-primary-targets-v2'


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def mechanical_facts():
    files = [
        {'path': 'content/posts/new.md', 'deleted': False, 'sha256': 'a' * 64},
        {'path': 'content/posts/old.md', 'deleted': True, 'sha256': None},
        {'path': 'static/old.bin', 'deleted': True, 'sha256': None},
        {'path': 'static/unchanged.bin', 'deleted': False, 'sha256': 'b' * 64},
    ]
    page = {'sourcePath': files[0]['path'], 'sourceSha256': 'a' * 64,
        'permalink': 'https://example.test/research/base/中文/',
        'relPermalink': '/research/base/中文/',
        'html': {'path': 'html/one.html', 'actualOutputPath': 'custom/index.html',
                 'sha256': 'c' * 64, 'bytes': 128},
        'record': {'path': 'maps/one.json', 'sha256': 'd' * 64, 'bytes': 192}}
    expected = {'files': files, 'reviewedAt': '2026-10-23T00:00:00+00:00'}
    manifest = {'reviewedFiles': copy.deepcopy(files), 'sitePolicy': dict(POLICY),
                'pages': [copy.deepcopy(page)]}
    return expected, manifest, [page]


class DailyReviewedTargetIdentityTest(unittest.TestCase):
    def key(self, path, *, policy=POLICY):
        return owner._target_url_key('https://example.test' + path, policy)

    def test_public_sibling_api_exists_with_explicit_selector(self):
        self.assertTrue(callable(getattr(owner, 'read_daily_reviewed_targets', None)))

    def test_unicode_and_percent_utf8_and_hex_case_have_same_key(self):
        expected = self.key('/research/base/中文/~user/')
        self.assertEqual(expected, self.key('/research/base/%E4%B8%AD%E6%96%87/%7euser/'))
        self.assertEqual(expected, self.key('/research/base/%e4%b8%ad%e6%96%87/~user/'))

    def test_key_is_unambiguous_origin_tuple_and_preserves_original_url(self):
        url = 'https://EXAMPLE.test:443/research/base/中文/'
        self.assertEqual(owner._target_url_key(url, POLICY), self.key('/research/base/中文/'))
        self.assertEqual(url, 'https://EXAMPLE.test:443/research/base/中文/')
        ipv6 = {'origin': 'https://[2001:db8::1]', 'basePath': '/'}
        self.assertEqual(owner._target_url_key('https://[2001:db8::1]/x/', ipv6),
                         ('https', '2001:db8::1', 443, '/x/'))

    def test_reserved_literal_and_encoded_tokens_are_not_merged(self):
        for char in ':@;+=&!$\'()*,':
            with self.subTest(char=char):
                self.assertNotEqual(self.key('/research/base/a' + char + 'b/'),
                    self.key('/research/base/a%' + format(ord(char), '02X') + 'b/'))

    def test_explicit_port_zero_never_aliases_the_default_tls_port(self):
        for url, policy in (
                ('https://example.test:0/research/base/x/', POLICY),
                ('https://example.test/research/base/x/',
                 {'origin': 'https://example.test:0', 'basePath': '/research/base/'})):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'target_origin'):
                owner._target_url_key(url, policy)
        zero = {'origin': 'https://example.test:0', 'basePath': '/research/base/'}
        self.assertEqual(owner._target_url_key('https://example.test:0/research/base/x/', zero),
                         ('https', 'example.test', 0, '/research/base/x/'))

    def test_path_unicode_normalization_and_route_shapes_are_not_guessed(self):
        self.assertNotEqual(self.key('/research/base/café/'), self.key('/research/base/cafe\u0301/'))
        variants = ['/research/base/x', '/research/base/x/', '/research/base/x/index.html',
                    '/research/base//x/', '/research/base/X/']
        self.assertEqual(len({self.key(path) for path in variants}), len(variants))

    def test_url_rejects_policy_escapes_and_encoded_ambiguity(self):
        urls = ['http://example.test/research/base/x/',
            'https://example.test.evil/research/base/x/',
            'https://user@example.test/research/base/x/',
            'https://example.test:444/research/base/x/',
            'https://example.test/research/base-other/x/',
            'https://example.test/research/base/x/?q=1',
            'https://example.test/research/base/x/#part']
        urls += ['https://example.test/research/base/' + tail for tail in
                 ('a%2fb/', '%5Cx/', '%2e%2e/x/', '%252Fx/', '%zz/', '%FF/',
                  '%00/', '%7f/', '%C2%85/', 'a\x85b/', 'a\\b/')]
        for url in urls:
            with self.subTest(url=repr(url)), self.assertRaises((ValueError, owner.capture.CaptureError)):
                owner._target_url_key(url, POLICY)

    def test_unknown_host_and_raw_ascii_path_shape_are_unsupported(self):
        for url, policy in [('https://例子.test/x/', {'origin': 'https://例子.test', 'basePath': '/'}),
                            ('https://example.test/research/base/a[b/', POLICY)]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, 'unsupported'):
                owner._target_url_key(url, policy)

    def test_url_identity_budget_is_checked_before_percent_allocation(self):
        with self.assertRaisesRegex(ValueError, 'limit_exceeded'):
            self.key('/research/base/' + '中' * 3000)

    def test_metadata_keeps_full_file_set_deletions_and_actual_map(self):
        expected, manifest, pages = mechanical_facts()
        result = owner._targets_metadata(expected, manifest, pages, result_limit=2 * 1024 * 1024)
        self.assertEqual(result['reviewedFileSetSha256'], digest(expected['files']))
        self.assertEqual(result['reviewedFileCount'], 4)
        self.assertEqual(result['primarySourceSetSha256'], digest([
            {'path': expected['files'][0]['path'], 'sha256': 'a' * 64}]))
        changes = result['changes']
        self.assertEqual(changes['deletedPaths'], ['content/posts/old.md', 'static/old.bin'])
        self.assertIsNone(changes['deletedUrls'])
        self.assertEqual(changes['deletionUrlCoverage'], 'not_recorded')
        self.assertEqual(changes['aliasCoverage'], 'not_checked')
        self.assertEqual(result['pageExtras'][0], {'relPermalink': pages[0]['relPermalink'],
                         'mapSha256': 'd' * 64, 'mapBytes': 192})

    def test_targets_metadata_rejects_encoded_equivalent_source_collision(self):
        expected, manifest, pages = mechanical_facts()
        second = copy.deepcopy(pages[0])
        second['sourcePath'] = 'content/posts/second.md'
        second['permalink'] = 'https://example.test/research/base/%E4%B8%AD%E6%96%87/'
        second['relPermalink'] = '/research/base/%E4%B8%AD%E6%96%87/'
        second['html']['actualOutputPath'] = 'second/index.html'
        pages.append(second)
        expected['files'].append({'path': second['sourcePath'], 'deleted': False, 'sha256': 'a' * 64})
        manifest['reviewedFiles'] = copy.deepcopy(expected['files'])
        manifest['pages'] = copy.deepcopy(pages)
        with self.assertRaisesRegex(ValueError, 'ambiguous_url'):
            owner._targets_metadata(expected, manifest, pages, result_limit=2 * 1024 * 1024)

    def test_new_metadata_budget_and_strict_byte_types(self):
        expected, manifest, pages = mechanical_facts()
        with self.assertRaisesRegex(ValueError, 'limit_exceeded'):
            owner._targets_metadata(expected, manifest, pages, result_limit=100)
        for invalid in (True, '192', -1):
            changed = copy.deepcopy(pages)
            changed[0]['record']['bytes'] = invalid
            manifest['pages'] = copy.deepcopy(changed)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                owner._targets_metadata(expected, manifest, changed, result_limit=2 * 1024 * 1024)
        for invalid in (True, 0, -1, '1000'):
            with self.subTest(limit=invalid), self.assertRaises(ValueError):
                owner._targets_metadata(expected, manifest, pages, result_limit=invalid)

    def test_reviewed_at_and_deleted_path_variables_have_preallocation_caps(self):
        expected, manifest, pages = mechanical_facts()
        expected['reviewedAt'] += 'x' * 8192
        with self.assertRaisesRegex(ValueError, 'limit_exceeded'):
            owner._targets_metadata(expected, manifest, pages, result_limit=2 * 1024 * 1024)
        expected, manifest, pages = mechanical_facts()
        expected['files'][1]['path'] = 'a' * 8193
        manifest['reviewedFiles'] = copy.deepcopy(expected['files'])
        with self.assertRaisesRegex(ValueError, 'limit_exceeded'):
            owner._targets_metadata(expected, manifest, pages, result_limit=2 * 1024 * 1024)

    def test_public_missing_and_exception_results_use_new_contract_only(self):
        with tempfile.TemporaryDirectory() as folder:
            normal = SimpleNamespace(validate_publish_date=lambda date: date,
                publication_scope=lambda include: contextlib.nullcontext(include),
                blog_publication_lock=lambda date: contextlib.nullcontext(),
                review_receipt_path=lambda date: Path(folder) / 'absent.json')
            with mock.patch.object(owner.blog_entry_loader, 'load_publish_to_blog', return_value=normal):
                result = owner.read_daily_reviewed_targets('2026-10-23')
                legacy = owner.read_daily_observed_projection('2026-10-23')
            self.assertEqual(result, {'contract': CONTRACT, 'version': 2,
                'status': 'not_recorded', 'normalQualification': 'not_checked'})
            self.assertEqual(legacy['contract'], owner.CONTRACT)
        with mock.patch.object(owner.blog_entry_loader, 'load_publish_to_blog',
                               side_effect=RuntimeError('/private/key?secret=hidden')):
            result = owner.read_daily_reviewed_targets('2026-10-23')
            legacy = owner.read_daily_observed_projection('2026-10-23')
        self.assertEqual(result['contract'], CONTRACT)
        self.assertEqual(result['version'], 2)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(legacy['contract'], owner.CONTRACT)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('hidden', json.dumps(result))

    def test_new_policy_and_functions_are_in_loaded_implementation_observation(self):
        original = owner._policy_sha()
        with mock.patch.object(owner, 'TARGET_CONTRACT', 'changed', create=True):
            self.assertNotEqual(owner._policy_sha(), original)
        self.assertIn('_target_url_key', owner._FUNCTIONS)
        self.assertIn('read_daily_reviewed_targets', owner._FUNCTIONS)

    def test_manifest_page_order_is_not_a_new_acceptance_requirement(self):
        expected, manifest, pages = mechanical_facts()
        second = copy.deepcopy(pages[0])
        second['sourcePath'] = 'content/posts/second.md'
        second['permalink'] = 'https://example.test/research/base/second/'
        second['relPermalink'] = '/research/base/second/'
        second['html']['actualOutputPath'] = 'second/index.html'
        pages.append(second)
        expected['files'].append({'path': second['sourcePath'], 'deleted': False, 'sha256': 'a' * 64})
        manifest['reviewedFiles'] = copy.deepcopy(expected['files'])
        manifest['pages'] = copy.deepcopy(list(reversed(pages)))
        result = owner._targets_metadata(expected, manifest, pages, result_limit=2 * 1024 * 1024)
        self.assertEqual(len(result['pageExtras']), 2)

    def test_target_hash_and_record_hash_have_the_exact_frozen_key_sets(self):
        expected, manifest, pages = mechanical_facts()
        metadata = owner._targets_metadata(expected, manifest, pages, result_limit=2 * 1024 * 1024)
        projected = {'selector': {'workflow': 'daily', 'date': '2026-10-23', 'includeId': None},
            'normalBinding': {'date': '2026-10-23'}, 'observationRef': {'sha256': 'e' * 64},
            'profile': {'contract': owner.PROFILE, 'fingerprint': 'f' * 64},
            'implementationObservation': {}, 'pages': [{'sourcePath': pages[0]['sourcePath']}],
            'inputBinding': 'observed_before_after', 'fullInputSnapshot': 'not_established',
            'observationCoverage': {}, 'coverage': {'staticProjection': 'observed'}, 'unknownInputs': []}
        result = owner._targets_result(projected, metadata, expected['reviewedAt'])
        keys = ('contract', 'version', 'selector', 'reviewedSitePolicy', 'reviewedFileSetSha256',
                'reviewedFileCount', 'primarySourceSetSha256', 'primaryPages', 'changes', 'profile', 'coverage')
        self.assertEqual(result['targetsSha256'], digest({key: result[key] for key in keys}))
        self.assertEqual(result['recordSha256'], digest({key: value for key, value in result.items()
                                                       if key != 'recordSha256'}))
        self.assertEqual(result['contract'], CONTRACT)
        self.assertEqual(result['coverage']['publicationGit'], 'not_checked')
        self.assertEqual(result['normalBinding']['reviewedAt'], expected['reviewedAt'])


if __name__ == '__main__':
    unittest.main()

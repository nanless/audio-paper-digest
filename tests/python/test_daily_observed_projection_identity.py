"""Mechanical owner identity/domain checks; no Source authority is asserted."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import daily_observed_projection as owner


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def ref(index, domain, local, href):
    return {'index': index, 'domain': domain, 'domainIndex': local, 'tag': 'a',
            'attributes': {'href': {'present': True, 'value': href},
                           'download': {'present': False, 'value': None}}}


class ObservedProjectionIdentityTest(unittest.TestCase):
    def test_private_compile_executes_actual_source_bytes_without_import_cache(self):
        raw = Path(owner._PROFILE_FILE).read_bytes()
        first = owner._compile_profile(raw)
        second = owner._compile_profile(raw)
        self.assertIsNot(first.ProjectionLimits, second.ProjectionLimits)
        html = (b'<html><head><title>Mechanical title</title>'
                b'<link rel="canonical" href="https://example.test/post/">'
                b'</head><body><h1>Mechanical heading</h1><div class="post-content">'
                b'<p>Mechanical body.</p></div></body></html>')
        projected = first.project_daily_html(html, expected_canonical='https://example.test/post/',
                                            limits=first.ProjectionLimits())
        self.assertEqual(projected['payload']['identity']['h1'], 'Mechanical heading')
        with self.assertRaises(first.ProjectionError):
            first.project_daily_html(html, expected_canonical='https://example.test/post/',
                                     limits=second.ProjectionLimits())

    def test_private_compile_rejects_new_project_imports_and_dynamic_execution(self):
        for raw in (b'import blog_entry_loader\n', b'import os\n',
                    b'__import__("pathlib")\n', b'eval("1")\n'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                owner._compile_profile(raw)

    def test_private_compile_never_enters_direct_main_guard(self):
        import runtime_guard
        with mock.patch.object(runtime_guard, 'require_external_runtime',
                               side_effect=AssertionError('direct guard executed during private load')):
            module = owner._compile_profile(Path(owner._PROFILE_FILE).read_bytes())
        self.assertEqual(module.PROFILE, owner.PROFILE)

    def test_body_and_domain_hashes_use_exact_canonical_contract(self):
        post = ref(1, 'post_content', 0, '/paper.json')
        outside = ref(0, 'html_body_outside_post_content', 0, '/archive/')
        payload = {'bodyEvents': [['text', '正文 A B']], 'refs': [outside, post]}
        normalized = [{'domainIndex': 0, 'tag': 'a', 'attributes': post['attributes']}]
        self.assertEqual(owner._body_sha(payload), digest({'contract': owner.PROFILE,
            'version': 1, 'bodyEvents': payload['bodyEvents'], 'bodyRefs': normalized}))
        self.assertEqual(owner._refs_sha(payload['refs'], 'post_content'), digest({
            'contract': owner.PROFILE, 'version': 1, 'domain': 'post_content', 'refs': normalized}))

    def test_external_navigation_indices_do_not_pollute_body(self):
        payload = {'bodyEvents': [['text', '正文']],
                   'refs': [ref(0, 'post_content', 0, '/paper.json')]}
        changed = copy.deepcopy(payload)
        changed['refs'].insert(0, ref(0, 'html_body_outside_post_content', 0, '/archive/'))
        changed['refs'][1]['index'] = 1
        self.assertEqual(owner._body_sha(payload), owner._body_sha(changed))
        self.assertEqual(owner._refs_sha(payload['refs'], 'post_content'),
                         owner._refs_sha(changed['refs'], 'post_content'))
        self.assertNotEqual(digest(payload), digest(changed))
        changed['refs'][1]['attributes']['href']['value'] = '/other-paper.json'
        self.assertNotEqual(owner._body_sha(payload), owner._body_sha(changed))

    def test_domain_index_must_be_contiguous_and_exact_integer(self):
        for local in (True, 1, -1, '0'):
            with self.subTest(local=local), self.assertRaises(ValueError):
                owner._refs_sha([ref(0, 'post_content', local, '/x')], 'post_content')

    def test_owner_warm_source_drift_is_rejected(self):
        original = owner.capture.read_profile_file
        def changed(path, **kwargs):
            raw = original(path, **kwargs)
            return raw + b'\n# changed\n' if Path(path) == owner._OWNER_FILE else raw
        with mock.patch.object(owner.capture, 'read_profile_file', side_effect=changed):
            with self.assertRaisesRegex(ValueError, 'owner_source_changed'):
                owner._implementation(b'profile')

    def test_owner_loaded_function_set_cannot_be_silently_changed(self):
        with mock.patch.object(owner, '_sha', lambda _raw: '0' * 64):
            with self.assertRaisesRegex(ValueError, 'unknown_callable'):
                owner._loaded_code_sha()
        with mock.patch.object(owner, '_unexpected_callable', mock.Mock(), create=True):
            with self.assertRaisesRegex(ValueError, 'unknown_callable'):
                owner._loaded_code_sha()

    def test_owner_policy_drift_and_mutable_defaults_are_rejected(self):
        with mock.patch.object(owner, '_LIMITS', owner._LIMITS + (('extra', 1),)):
            with self.assertRaisesRegex(ValueError, 'owner_code_or_policy_changed'):
                owner._implementation(b'profile')
        for value in ([], {}, set(), float('nan')):
            with self.subTest(value=type(value)), self.assertRaises(ValueError):
                owner._frozen(value)

    def test_fixed_profile_path_is_part_of_loaded_policy(self):
        with mock.patch.object(owner, '_PROFILE_FILE', owner._HERE / 'other_profile.py'):
            with self.assertRaisesRegex(ValueError, 'owner_code_or_policy_changed'):
                owner._implementation(b'profile')

    def test_loaded_code_hash_is_stable_across_repeats_and_actual_compile(self):
        before = owner._loaded_code_sha()
        self.assertEqual(before, owner._STARTUP_CODE_SHA)
        for _ in range(5):
            self.assertEqual(owner._loaded_code_sha(), before)
        owner._compile_profile(owner._read(owner._PROFILE_FILE))
        for _ in range(5):
            self.assertEqual(owner._loaded_code_sha(), before)

    def test_loaded_code_field_hash_changes_with_actual_code(self):
        first = compile('answer = 1', 'same.py', 'exec', dont_inherit=True, optimize=0)
        second = compile('answer = 2', 'same.py', 'exec', dont_inherit=True, optimize=0)
        self.assertNotEqual(owner._json_sha(owner._code_fields(first)),
                            owner._json_sha(owner._code_fields(second)))

    def test_disclosures_are_reserved_before_result_list_copy(self):
        self.assertLess(owner._metadata_reservation({'unknownInputs': ['ordinary disclosure']}), 65536)
        for unknown in (['x' * 8193], ['x'] * 129, ['x' * 6000] * 64, [True]):
            with self.subTest(kind=type(unknown[0])), self.assertRaises(ValueError):
                owner._metadata_reservation({'unknownInputs': unknown})

    def test_json_byte_limit_is_enforced_during_streaming(self):
        value = {'x': '中文'}
        size = len(json.dumps(value, ensure_ascii=False, sort_keys=True,
                              separators=(',', ':')).encode())
        self.assertEqual(owner._json_size(value, size), size)
        with self.assertRaisesRegex(ValueError, 'json_bytes'):
            owner._json_size(value, size - 1)

    def test_json_rejects_oversize_before_encoder_allocates_escaped_chunk(self):
        with mock.patch.object(owner.json.JSONEncoder, 'iterencode',
                               side_effect=AssertionError('encoder reached')):
            with self.assertRaisesRegex(ValueError, 'json_bytes'):
                list(owner._json_parts({'large': '\x00' * 100000}, 1024))

    def test_json_measure_matches_real_encoding_for_supported_values(self):
        value = {'quote': '\\"\b\f\n\r\t\x00\x1f中文😀',
                 'values': [None, True, False, -9223372036854775808, 0, (), {}]}
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False).encode()
        self.assertEqual(owner._json_measure(value, len(raw)), len(raw))
        self.assertEqual(b''.join(owner._json_parts(value, len(raw))), raw)
        for invalid in ({1: 'x'}, {'x': 1.2}, {'x': '\ud800'}):
            with self.subTest(invalid=repr(invalid)), self.assertRaises(ValueError):
                owner._json_measure(invalid, 1024)


if __name__ == '__main__':
    unittest.main()

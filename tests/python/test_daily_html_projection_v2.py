"""Fixed v2 math surface and frozen actual-v1 compatibility, without Source grants."""
import dataclasses
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily_html_projection as projection
import test_daily_html_projection as original

FIXTURE = ROOT / 'tests/fixtures/daily-math-profile-calibration.json'
V2 = 'daily-static-html-projection-v2'


def raw_case(case):
    return case['html'].encode('utf-8')


def baseline(raw, canonical):
    try:
        return {'status': 'projected', 'result': projection.project_daily_html(raw, expected_canonical=canonical)}
    except projection.ProjectionError as error:
        return {'status': 'error', 'code': error.code, 'reason': error.reason,
                'line': error.line, 'column': error.column}


class DailyHtmlProjectionV2Test(unittest.TestCase):
    def setUp(self):
        self.cases = json.loads(FIXTURE.read_text(encoding='utf-8'))['cases']

    def project(self, body, *, limits=None):
        return projection.project_daily_html_v2(original.page(body), expected_canonical=original.URL,
            **({} if limits is None else {'limits': limits}))

    def reject(self, body, reason=None):
        with self.assertRaises(projection.ProjectionError) as caught:
            self.project(body)
        if reason is not None:
            self.assertEqual(caught.exception.reason, reason)
        return caught.exception

    def test_frozen_v1_complete_results_and_errors_for_all_sixteen_actual_html(self):
        self.assertEqual(len(self.cases), 16)
        for case in self.cases:
            with self.subTest(case=case['id']):
                raw = raw_case(case)
                self.assertEqual(len(raw), case['htmlBytes'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), case['htmlSha256'])
                self.assertEqual(baseline(raw, case['canonical']), case['v1Baseline'])

    def test_fixed_v2_entry_and_contract_do_not_change_the_v1_profile(self):
        self.assertEqual(projection.PROFILE, 'daily-static-html-projection-v1')
        self.assertEqual(projection.PROFILE_V2, V2)
        result = self.project(r'\(r + s\)')
        self.assertEqual((result['contract'], result['version']), (V2, 2))
        self.assertEqual(result['payload']['coverage']['math'],
                         'registered-delimiters-single-node-ascii-isolated-internal-space-exact')
        self.assertEqual(result['payloadSha256'], hashlib.sha256(original.stable({key: result[key]
                         for key in ('contract', 'version', 'payload')})).hexdigest())
        self.assertEqual(result['stats']['outputBytes'], len(original.stable(result)))

    def test_actual_new_positive_pairs_preserve_literals_and_equal_v2_payloads(self):
        # Independently observed data-node literals/SHA, not values derived by
        # the parser under test or merely equality between two normalized ends.
        observed = {
            'math-inline-isolated': ('inline', r'\(u + v\)',
                '6bf0092ec1cadc46282fd8f1d4644a9217a0764670db182a944beb7eb68da08a'),
            'math-display-command': ('display', r'\[\alpha + \beta\]',
                'd37ca34fb81e6088076cf883b1ef0c1ea519a04a41d61227997893db8febfb06'),
            'math-brace-escape': ('inline', r'\(\text{a b} + p\ q\)',
                'b0bf132f30ead406a90631aa154d5b277a3c649b4b5a8d6fb5d5370aa359769b'),
        }
        for source, (kind, literal, literal_sha) in observed.items():
            results = []
            for variant in ('normal', 'production_flags'):
                case = next(row for row in self.cases if row['group'] == 'new'
                            and row['source'] == source and row['variant'] == variant)
                results.append(projection.project_daily_html_v2(raw_case(case), expected_canonical=case['canonical']))
            with self.subTest(source=source):
                self.assertEqual(results[0]['payload'], results[1]['payload'])
                self.assertEqual(results[0]['payloadSha256'], results[1]['payloadSha256'])
                self.assertNotEqual(results[0]['evidence']['rawHtmlSha256'], results[1]['evidence']['rawHtmlSha256'])
                for result in results:
                    self.assertEqual(result['stats']['formulas'], 1)
                    events = [event for event in result['payload']['bodyEvents'] if event[0] == 'math']
                    self.assertEqual(events, [['math', kind, literal]])
                    self.assertEqual(hashlib.sha256(events[0][2].encode('utf-8')).hexdigest(), literal_sha)

    def test_actual_old_display_adds_support_without_content_whitelist(self):
        results = []
        for case in self.cases:
            if case['group'] == 'old' and case['source'] == 'display-fixed':
                self.assertEqual(case['v1Baseline']['reason'], 'whitespace')
                results.append(projection.project_daily_html_v2(raw_case(case), expected_canonical=case['canonical']))
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['payloadSha256'], results[1]['payloadSha256'])
        for body in (r'\(a b c\)', r'\[\gamma + \delta\]', r'\(\text{c d} + m\ n\)', r'\(a+b\)'):
            with self.subTest(body=body):
                self.assertIn(body, [event[2] for event in self.project(body)['payload']['bodyEvents'] if event[0] == 'math'])

    def test_actual_spaced_controls_never_become_a_supported_pair(self):
        for case in self.cases:
            if case['source'] in ('math-whitespace-controls', 'display-spaced') or (
                    case['source'] == 'inline-spaced' and case['variant'] == 'normal'):
                with self.subTest(case=case['id']), self.assertRaises(projection.ProjectionError):
                    projection.project_daily_html_v2(raw_case(case), expected_canonical=case['canonical'])
        compressed = next(row for row in self.cases if row['source'] == 'inline-spaced'
                          and row['variant'] == 'production_flags')
        # A supported compressed endpoint cannot repair its unsupported normal peer.
        self.assertEqual(projection.project_daily_html_v2(raw_case(compressed),
            expected_canonical=compressed['canonical'])['stats']['formulas'], 1)

    def test_space_deletion_and_movement_are_never_normalized(self):
        results = [self.project(body)['payloadSha256'] for body in
                   (r'\(a b\)', r'\(ab\)', r'\(x +y\)', r'\(x+ y\)', r'\(\foo x\)', r'\(\foox\)')]
        self.assertEqual(len(set(results)), len(results))
        two = self.project(r'\(a b\) then \[c d\]')
        self.assertEqual(two['stats']['formulas'], 2)
        self.assertEqual([event[1] for event in two['payload']['bodyEvents'] if event[0] == 'math'], ['inline', 'display'])

    def test_whitespace_and_other_original_restrictions_remain(self):
        bodies = [r'\( a\)', r'\(a \)', r'\(a  b\)', '\\(a\tb\\)', '\\[a\nb\\]',
                  '\\(a\rb\\)', '\\(a\fb\\)', '\\(a\u00a0b\\)', r'\(中文\)',
                  r'\(\)', r'\)', r'\(a', r'\(a\[b\]\)', r'\(a &amp; b\)',
                  r'\(a &lt; b\)', r'\(a &gt; b\)']
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.reject(body).code, 'unsupported_math')

    def test_comment_and_markup_boundaries_do_not_join_into_math(self):
        for body in (r'\(a<!--split--> b\)', r'\(a <em>+</em> b\)',
                     r'\<!--split-->(a b\)', r'\(a b\<!--split-->)'):
            with self.subTest(body=body):
                self.reject(body)
        self.assertEqual(self.project(r'Literal \\(a b\\)')['stats']['formulas'], 0)

    def test_entity_once_semantics_and_raw_lexeme_evidence_are_separate(self):
        literal = self.project(r'\(a b\)')
        encoded = self.project(r'\(a&#32;b\)')
        self.assertEqual(literal['payloadSha256'], encoded['payloadSha256'])
        self.assertNotEqual(literal['evidence']['rawHtmlSha256'], encoded['evidence']['rawHtmlSha256'])
        self.reject(r'\(a&amp;#32;b\)', 'html_sensitive')

    def test_policies_are_per_instance_when_calls_are_interleaved(self):
        raw = original.page(r'\(a b\)')
        zero = original.page(r'\(a+b\)')
        before = projection.project_daily_html(zero, expected_canonical=original.URL)
        for _ in range(3):
            self.assertEqual(projection.project_daily_html_v2(raw, expected_canonical=original.URL)['version'], 2)
            with self.assertRaises(projection.ProjectionError):
                projection.project_daily_html(raw, expected_canonical=original.URL)
            self.assertEqual(projection.project_daily_html(zero, expected_canonical=original.URL), before)
        self.assertEqual(projection.PROFILE, 'daily-static-html-projection-v1')

    def test_math_bytes_include_all_spaces_and_delimiters(self):
        body = r'\(a b c\)'
        size = len(body.encode())
        limits = dataclasses.replace(projection.DEFAULT_LIMITS, max_math_bytes=size)
        self.assertEqual(self.project(body, limits=limits)['stats']['formulas'], 1)
        with self.assertRaises(projection.ProjectionError) as caught:
            self.project(body, limits=dataclasses.replace(limits, max_math_bytes=size - 1))
        self.assertEqual((caught.exception.code, caught.exception.reason), ('limit_exceeded', 'math_bytes'))

    def test_output_is_reserved_before_hashing_and_limits_are_not_relaxed(self):
        with mock.patch.object(projection, '_hash_json', side_effect=AssertionError('hash reached')):
            with self.assertRaises(projection.ProjectionError) as caught:
                self.project(r'\(a b\)', limits=dataclasses.replace(projection.DEFAULT_LIMITS, max_output_bytes=100))
        self.assertEqual(caught.exception.reason, 'output_bytes')
        with self.assertRaises(projection.ProjectionError):
            self.project('body', limits=dataclasses.replace(projection.DEFAULT_LIMITS, max_nodes=True))

    def test_v2_has_no_file_or_network_or_environment_effects(self):
        import os
        import socket
        import subprocess
        with mock.patch('builtins.open', side_effect=AssertionError('file IO')), \
             mock.patch.object(os, 'getenv', side_effect=AssertionError('env IO')), \
             mock.patch.object(socket, 'socket', side_effect=AssertionError('network')), \
             mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('process')):
            self.assertEqual(self.project(r'\(a b\)')['stats']['formulas'], 1)


if __name__ == '__main__':
    unittest.main()

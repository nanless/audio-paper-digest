"""Actual Markdown -> normal review -> D1 -> fixed-v2 mechanical observations.

Compose existing factories without inheriting their tests. Normal source,
Hugo, receipt/ref and final gates remain real; this is no paid Source claim.
"""
import importlib
from html.parser import HTMLParser
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_daily_reviewed_targets as target_fixture

publisher = target_fixture.publisher
DATE = target_fixture.DATE
POSITIVE_BODIES = (
    'Inline generic: \\(u + v\\).\n\n\\[\\alpha + \\beta\\]',
    'Brace and escape: \\(\\text{a b} + p\\ q\\).\n\nZero: \\(p+q\\).',
)


class DailyMathProjectionIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.targets = target_fixture.DailyReviewedTargetsIntegrationTest('runTest')
        self.addCleanup(self.targets.doCleanups)
        self.targets.setUp()
        self.case = self.targets.case
        self.fixture = self.targets.fixture
        config = self.fixture.repo / 'hugo.yaml'
        config.write_text(config.read_text() +
            "markup:\n  goldmark:\n    extensions:\n      passthrough:\n"
            "        enable: true\n        delimiters:\n"
            "          block: [['\\[', '\\]']]\n"
            "          inline: [['\\(', '\\)']]\n"
            "    renderer:\n      unsafe: true\n")
        target_fixture.observed_fixture.normal_fixture.git(self.fixture.repo, 'add', '--', 'hugo.yaml')
        target_fixture.observed_fixture.normal_fixture.git(self.fixture.repo, 'commit', '-m',
                                                         'Mechanical math passthrough fixture')

    def prepare(self, bodies=POSITIVE_BODIES):
        for path, body in zip(self.fixture.paths, bodies):
            path.write_text(path.read_text() + '\n\n' + body + '\n')
        self.case.prepare()
        publisher.load_verified_review_receipt(DATE)
        self.fixture.assert_observation_available()
        self.assertEqual(len(self.fixture.actual_builds), 1)

    def raw_pages(self):
        path, record = self.case.record()
        return [(row, (path.parent / row['html']['path']).read_bytes()) for row in record['pages']]

    def test_actual_markdown_math_uses_v2_for_both_existing_owner_apis(self):
        self.prepare()
        before = self.case.inventory()
        projection = self.targets.read(projection=True)
        self.assertEqual(projection['status'], 'projection_available', projection)
        self.assertEqual(projection['contract'], 'daily-observed-static-page-set-v2')
        self.assertEqual(projection['version'], 2)
        targets = self.targets.read()
        self.assertEqual(targets['status'], 'reviewed_targets_observed', targets)
        self.assertEqual(targets['contract'], 'daily-reviewed-primary-targets-v2')
        self.assertEqual(targets['version'], 2)
        for result in (projection, targets):
            self.assertEqual(result['profile']['contract'], 'daily-static-html-projection-v2')
        self.assertEqual(self.case.inventory(), before)
        self.assertEqual(len(self.fixture.actual_builds), 1, 'Consumption must not rebuild')
        pure = importlib.import_module('daily_html_projection')
        summaries = {page['sourcePath']: page for page in projection['pages']}
        all_math = []
        for row, raw in self.raw_pages():
            with self.assertRaises(pure.ProjectionError) as error:
                pure.project_daily_html(raw, expected_canonical=row['permalink'])
            self.assertEqual(error.exception.code, 'unsupported_math')
            projected = pure.project_daily_html_v2(raw, expected_canonical=row['permalink'])
            self.assertEqual(projected['contract'], 'daily-static-html-projection-v2')
            self.assertEqual(projected['version'], 2)
            payload = projected['payload']
            all_math.extend(event for event in payload['bodyEvents'] if event[0] == 'math')
            summary = summaries[row['sourcePath']]
            self.assertEqual(summary['projectionPayloadSha256'], projected['payloadSha256'])
            self.assertEqual(summary['identitySha256'], target_fixture.sha(target_fixture.canonical({
                'contract': 'daily-static-html-projection-v2', 'version': 2,
                'identity': payload['identity']})))
            self.assertEqual(payload['refs'], [])
            self.assertEqual(summary['bodyProjectionSha256'], target_fixture.sha(target_fixture.canonical({
                'contract': 'daily-static-html-projection-v2', 'version': 2,
                'bodyEvents': payload['bodyEvents'], 'bodyRefs': []})))
            for domain, field in (('post_content', 'postContentRefsSha256'),
                                  ('html_body_outside_post_content', 'outsideStaticRefsSha256')):
                self.assertEqual(summary[field], target_fixture.sha(target_fixture.canonical({
                    'contract': 'daily-static-html-projection-v2', 'version': 2,
                    'domain': domain, 'refs': []})))
            self.assertEqual(summary['staticRefsSha256'], target_fixture.sha(target_fixture.canonical({
                'contract': 'daily-static-html-projection-v2', 'version': 2, 'refs': []})))
        self.assertEqual(all_math, [
            ['math', 'inline', '\\(u + v\\)'],
            ['math', 'display', '\\[\\alpha + \\beta\\]'],
            ['math', 'inline', '\\(\\text{a b} + p\\ q\\)'],
            ['math', 'inline', '\\(p+q\\)'],
        ])
        for first, second in zip(projection['pages'], targets['primaryPages']):
            for key, value in first.items():
                self.assertEqual(second[key], value, key)
        self.assertEqual(len(self.targets.normal_calls), 4)
        self.assertTrue(all(call['returned'] for call in self.targets.normal_calls))

    def reject_second_page(self, body, *, status='unsupported', code='unsupported_math', reason=None):
        self.prepare((POSITIVE_BODIES[0], body))
        source = self.fixture.paths[1].relative_to(self.fixture.repo).as_posix()
        original = HTMLParser.feed
        parsed = []

        def feed(parser, text):
            if type(parser).__module__ == '_daily_static_projection_snapshot':
                parsed.append(True)
            return original(parser, text)

        for projection in (True, False):
            with self.subTest(projection=projection), mock.patch.object(HTMLParser, 'feed', feed):
                before = len(parsed)
                result = self.targets.read(projection=projection)
                self.assertEqual(result['status'], status, result)
                self.assertEqual(result['contract'], 'daily-observed-static-page-set-v2' if projection
                                 else 'daily-reviewed-primary-targets-v2')
                self.assertEqual(result['version'], 2)
                self.assertEqual(result['issues'][0]['code'], code)
                if reason is not None:
                    self.assertEqual(result['issues'][0]['reason'], reason)
                self.assertEqual(result['issues'][0]['sourcePath'], source)
                self.assertEqual(len(parsed) - before, 2, 'The valid first page must not become a prefix result')
                for field in ('pages', 'primaryPages', 'recordSha256', 'targetsSha256'):
                    self.assertNotIn(field, result)
        self.assertEqual(len(self.targets.normal_calls), 2)
        self.assertTrue(all(call['returned'] for call in self.targets.normal_calls))
        self.fixture.assert_observation_available()  # Unsupported projection does not erase D1 fact.

    def test_double_space_actual_markdown_rejects_the_whole_scope(self):
        self.reject_second_page('Double: \\(u  +  v\\).')

    def test_display_linefeed_actual_markdown_rejects_the_whole_scope(self):
        self.reject_second_page('\\[\n  \\alpha  +  \\beta\n\\]')

    def test_cross_node_actual_markdown_rejects_the_whole_scope(self):
        # Explicit span markup is rejected by the original Markdown preflight.
        # A legal source comment survives actual passthrough rendering and splits
        # data callbacks without bypassing that original publication gate.
        self.reject_second_page('Cross: \\(u<!-- mechanical boundary --> + v\\).',
                                reason='cross_node')

    def test_spaces_and_delimiters_count_toward_the_original_math_budget(self):
        literal = '\\(' + 'a ' * 4094 + 'a' + '\\)'
        self.assertEqual(len(literal.encode()), 8193)
        self.reject_second_page(literal, status='blocked', code='limit_exceeded', reason='math_bytes')

    def test_math_v2_keeps_the_real_final_normal_source_cas(self):
        self.prepare()
        source = next(self.fixture.source_root.rglob('source.txt'))
        original = source.read_bytes()
        for projection in (True, False):
            with self.subTest(projection=projection):
                before = len(self.targets.normal_calls)
                with self.case.after_initial_raw(lambda: source.write_bytes(original + b'\n')):
                    result = self.targets.read(projection=projection, unchanged=False)
                self.assertEqual(result['status'], 'blocked', result)
                self.assertEqual(len(self.targets.normal_calls) - before, 2)
                self.assertTrue(self.targets.normal_calls[-2]['returned'])
                self.assertFalse(self.targets.normal_calls[-1]['returned'])
                for field in ('pages', 'primaryPages', 'recordSha256', 'targetsSha256'):
                    self.assertNotIn(field, result)
                source.write_bytes(original)
        self.targets.target(self.targets.read())


if __name__ == '__main__':
    unittest.main()

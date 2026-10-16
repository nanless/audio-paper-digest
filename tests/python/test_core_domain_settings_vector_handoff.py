"""Pure contract regression; no source authority, stage receipt or model request."""
import types
import json
import os
from pathlib import Path
import re
import sys
import unittest

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / 'scripts'))
publisher_path = os.environ.get('CORE_SETTING_TEST_PUBLISHER', str(ROOT / 'scripts/publish-to-blog.py'))
publish = types.ModuleType('core_domain_setting_publish')
publish.__file__ = str(ROOT / 'scripts/publish-to-blog.py')
exec(compile(Path(publisher_path).read_text(), publish.__file__, 'exec'), publish.__dict__)
CASES = json.loads(Path(os.environ.get('CORE_SETTING_TEST_FIXTURE', str(ROOT / 'tests/fixtures/core-domain-settings-vector-handoff-cases.json'))).read_text())


class CoreDomainSettingsVectorHandoffTest(unittest.TestCase):
    def test_bounded_setting_roles(self):
        metric = re.compile(r'指标|准确率|正确率|SI-SDR|压缩率|对数似然比代价')
        conference = re.compile(r'声压级|声对比度')
        for text, expected in CASES['settingCases']:
            with self.subTest(text=text):
                self.assertEqual(publish._has_concrete_core_summary_setting(text, metric, conference), expected)

    def test_same_variable_actual_input_role(self):
        for text, expected in CASES['vectorCases']:
            with self.subTest(text=text):
                self.assertEqual(publish._has_explicit_edited_vector_handoff(text), expected)

    def test_metric_alias_and_year_boundaries(self):
        for row in CASES['domainMetricCases']:
            with self.subTest(metric=row['text']):
                self.assertEqual(publish._detailed_core_summary_semantic_issue(row['summary']) is None, row['expected'])
        for text, expected in CASES['yearCases']:
            with self.subTest(year=text):
                self.assertEqual(publish._strip_core_summary_non_result_numerals(text), expected)
        for row in CASES['legacyYearSummaries']:
            with self.subTest(paper=row['paperId']):
                self.assertIsNone(publish._detailed_core_summary_semantic_issue(row['summary']))

    def test_real_saved_summary_surfaces_and_retained_failures(self):
        self.assertEqual(len(CASES['paidSummaries']), 4)
        for row in CASES['paidSummaries']:
            with self.subTest(paper=row['paperId']):
                self.assertIsNone(publish._detailed_core_summary_semantic_issue(row['summary']))
        for row in CASES['retainedFailures']:
            with self.subTest(retained=row['paperId']):
                self.assertIsNotNone(publish._detailed_core_summary_semantic_issue(row['summary']))


if __name__ == '__main__':
    unittest.main()

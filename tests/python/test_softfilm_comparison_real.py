import gzip
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common

FIXTURE = json.loads(gzip.decompress((ROOT / 'tests/fixtures/softfilm-comparison-real.json.gz').read_bytes()))


class SoftfilmComparisonTest(unittest.TestCase):
    def test_real_comparison_and_changed_source_or_table(self):
        validate = publish_common._validate_experiment_table_evidence_depth
        analysis, source = FIXTURE['analysis'], FIXTURE['sourceText']
        self.assertIsNone(validate(analysis, source_text=source))
        self.assertIn('负面证据', validate(analysis, source_text=source.replace('67.55%', '67.50%')))
        self.assertIn('负面证据', validate(analysis.replace('67.55', '67.50'), source_text=source))
        self.assertIn('负面证据', validate(analysis.replace('Dong et al.', '另一方法'), source_text=source))

    def test_observed_comparison_requires_matching_higher_reference_value(self):
        validate = publish_common._validate_experiment_table_evidence_depth
        analysis, source = FIXTURE['analysis'], FIXTURE['sourceText']
        for reference in ['67.50%', '66.00%']:
            with self.subTest(reference=reference):
                self.assertIn('负面证据', validate(
                    analysis, source_text=source.replace('67.55%', reference)))
                self.assertIsNone(validate(analysis.replace('67.55', reference[:-1]),
                                           source_text=source.replace('67.55%', reference)))
        self.assertIsNone(validate(
            analysis.replace('64.11', '65.00').replace('67.55', '67.50'),
            source_text=source.replace('64.11', '65.00').replace('67.55%', '67.50%')))
        self.assertIsNone(validate(analysis.replace('67.55', '60.00'),
                                   source_text=source.replace('67.55%', '60.00%')))
        # A hypothetical comparison cannot introduce an observed-result
        # obligation merely because it mentions the same task and methods.
        hypothetical = source.replace('On the 4-class task',
                                      'Hypothetical example: On the 4-class task')
        self.assertIsNone(validate(analysis, source_text=hypothetical.replace('67.55%', '67.50%')))
        # This hypothetical table cannot satisfy a separate, actually observed
        # negative result merely because its original numbers happen to match.
        separate_negative = hypothetical.replace('\nV Conclusion',
            '\nWe observed degradation in a separate test.\nV Conclusion')
        self.assertIn('负面证据', validate(analysis, source_text=separate_negative))


if __name__ == '__main__':
    unittest.main()

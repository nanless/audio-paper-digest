import json
import hashlib
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from publish_common import validate_manual_editorial_quality_v4


class BinarizationNumeralBoundary(unittest.TestCase):
    def test_real_paid_term_and_original_source_identity(self):
        evidence = json.loads((ROOT / 'tests/fixtures/daily-reader-paid-20261016.json').read_text())
        saved = next(item for item in evidence['cases'] if item['paperId'] == '2610.21691')
        self.assertEqual(hashlib.sha256(saved['sourceText'].encode()).hexdigest(), saved['sealedSourceSha256'])
        self.assertIn('零点五阈值二值化后', saved['sections'][0]['body'])
        self.assertRegex(saved['sourceText'], r'thresholded at 0\.5 to obtain\s+binary state predictions')
        # The number itself still needs ordinary formatting; the fixed operation
        # name does not become a spurious threshold of two in the publish gate.
        self.assertIsNone(validate_manual_editorial_quality_v4('## 核心摘要\n按 0.5 阈值二值化后输出状态。'))

    def test_same_complete_term_boundary_as_node(self):
        cases = json.loads((ROOT / 'tests/fixtures/binarization-numeral-boundary.json').read_text())
        for text in cases['accept']:
            with self.subTest(text=text):
                self.assertIsNone(validate_manual_editorial_quality_v4('## 核心摘要\n' + text))
        for text in cases['reject']:
            with self.subTest(text=text):
                issue = validate_manual_editorial_quality_v4('## 核心摘要\n' + text)
                self.assertIsNotNone(issue)
                self.assertIn('精确定量', issue)

    def test_measured_time_axis_stays_accepted_and_ambiguous_quantity_stays_blocked(self):
        axis = json.loads((ROOT / 'tests/fixtures/reader-measured-axis-20261016.json').read_text())
        for text in [axis['actualSentence'], *axis['constructedAccept']]:
            with self.subTest(text=text):
                self.assertIsNone(validate_manual_editorial_quality_v4('## 核心摘要\n' + text))
        # Python has no independent comparison-unit gate; do not invent one or
        # claim its unrelated quantity checker validates percentage comparisons.
        issue = validate_manual_editorial_quality_v4('## 核心摘要\n有十七八个百分点在静音下还在。')
        self.assertIsNotNone(issue)
        self.assertIn('精确定量', issue)

    def test_real_gpt_version_prose_remains_accepted_in_publish_style_path(self):
        evidence = json.loads((ROOT / 'tests/fixtures/daily-reader-paid-20261016.json').read_text())
        saved = next(item for item in evidence['cases'] if item['paperId'] == '2610.20085')
        self.assertEqual(hashlib.sha256(saved['sourceText'].encode()).hexdigest(), saved['sealedSourceSha256'])
        paragraph = saved['styleSections'][0]['body'].split('\n\n')[0]
        self.assertIn('GPT-4.1', paragraph)
        self.assertIn('Using the same Gemini-generated captions, both Gemini and GPT-4.1 reasoners', saved['sourceText'])
        sentence = next(sentence for sentence in paragraph.split('。') if sentence.startswith('用同样的')) + '。'
        # Reader typography inserts ordinary Han/Latin boundaries before the
        # publish style gate; retain the original paid bytes in the fixture.
        formatted = re.sub(r'(?<=[\u4e00-\u9fff])(?=[A-Za-z])|(?<=[A-Za-z0-9])(?=[\u4e00-\u9fff])', ' ', sentence)
        self.assertIsNone(validate_manual_editorial_quality_v4('## 核心摘要\n' + formatted))


if __name__ == '__main__':
    unittest.main()

import json
import re
import sys
import unicodedata
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts' / 'lib'))
from reader_grouped_vector_column_units import UNITS, _UNITS_PATTERN  # noqa: E402

RULES = json.loads((ROOT / 'scripts' / 'lib' / 'validation-rules.json').read_text(encoding='utf-8'))
FIXTURE = json.loads((ROOT / 'tests' / 'fixtures' / 'validation-parity-cases.json').read_text(encoding='utf-8'))


def _pattern(units):
    """与 reader_grouped_vector_column_units 相同的构造方式，供变异测试使用。"""
    return r'\(\s*(' + '|'.join(re.escape(unit) for unit in sorted(units, key=len, reverse=True)) + r')\s*\)'


class SharedValidationRulesTests(unittest.TestCase):
    def test_python_units_match_shared_rules_and_fixture(self):
        # 夹具是独立测试向量：共享 JSON 删除/改写单位后，这条断言会失败，
        # 不会因为 UNITS 也来自同一份 JSON 而变成重言式。
        self.assertEqual(list(UNITS), RULES['tableHeaderUnits'])
        self.assertEqual(list(UNITS), FIXTURE['headerUnits'])
        self.assertEqual(sorted(RULES['tableHeaderUnits']), sorted(FIXTURE['headerUnits']))

    def test_units_are_registered_in_rules_notes(self):
        self.assertIn('tableHeaderUnits', RULES)
        self.assertTrue(all(isinstance(unit, str) and unit for unit in RULES['tableHeaderUnits']))
        self.assertTrue(all(isinstance(unit, str) and unit for unit in UNITS))

    def test_metric_keywords_shared_field_is_present_for_node(self):
        # Python 只消费 units；metricKeywords 供 Node 使用，但两端共享同一 JSON，
        # 这里断言字段存在且与夹具一致，防止 Node 侧悄悄丢字段。
        self.assertEqual(RULES['metricKeywords'], FIXTURE['metricKeywords'])
        self.assertTrue(RULES['metricKeywords'])
        self.assertTrue(all(isinstance(keyword, str) and keyword for keyword in RULES['metricKeywords']))

    def test_glued_pattern_vectors_are_shared(self):
        self.assertEqual(RULES['gluedPatternExamples'], FIXTURE['gluedPatternExamples'])
        self.assertEqual(RULES['gluedCleanExamples'], FIXTURE['gluedCleanExamples'])

    def test_units_pattern_matches_whitelisted_only(self):
        pattern = re.compile(_UNITS_PATTERN, re.I)
        for unit in FIXTURE['headerUnits']:
            self.assertTrue(pattern.search(f'WER ({unit})'), unit)
        for unit in FIXTURE['invalidHeaderUnits']:
            self.assertIsNone(pattern.search(f'WER ({unit})'), unit)

    def test_fullwidth_sample_is_normalized_before_matching(self):
        sample = unicodedata.normalize('NFKC', FIXTURE['fullWidthUnitSample'])
        self.assertTrue(re.search(_UNITS_PATTERN, sample, re.I))

    def test_units_pattern_is_mutation_sensitive(self):
        # 若共享 JSON 删掉 kHz，UNITS 与 _UNITS_PATTERN 会一起变；用独立构造的
        # 变异 pattern 证明上面的白名单断言真的能抓到删除，而不是恒真。
        self.assertIn('kHz', FIXTURE['headerUnits'])
        full = re.compile(_UNITS_PATTERN, re.I)
        self.assertTrue(full.search('WER (kHz)'))
        mutated_units = [unit for unit in FIXTURE['headerUnits'] if unit != 'kHz']
        mutated = re.compile(_pattern(mutated_units), re.I)
        self.assertIsNone(mutated.search('WER (kHz)'))
        # 删除单位后，模块级 UNITS 与夹具的相等断言会失败。
        self.assertNotEqual(sorted(mutated_units), sorted(FIXTURE['headerUnits']))


if __name__ == '__main__':
    unittest.main()

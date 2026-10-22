import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'scripts' / 'lib'))
from reader_grouped_vector_column_units import UNITS, _UNITS_PATTERN  # noqa: E402


class SharedValidationRulesTests(unittest.TestCase):
    def test_python_units_match_shared_rules(self):
        rules = json.loads((ROOT / 'scripts' / 'lib' / 'validation-rules.json').read_text(encoding='utf-8'))
        self.assertEqual(list(UNITS), rules['tableHeaderUnits'])

    def test_units_are_registered_in_rules_notes(self):
        rules = json.loads((ROOT / 'scripts' / 'lib' / 'validation-rules.json').read_text(encoding='utf-8'))
        self.assertIn('tableHeaderUnits', rules)
        self.assertTrue(all(isinstance(unit, str) and unit for unit in rules['tableHeaderUnits']))

    def test_units_pattern_matches_whitelisted_only(self):
        import re
        pattern = re.compile(_UNITS_PATTERN, re.I)
        for unit in UNITS:
            self.assertTrue(pattern.search(f'WER ({unit})'), unit)
        self.assertIsNone(pattern.search('WER (fps)'))


if __name__ == '__main__':
    unittest.main()

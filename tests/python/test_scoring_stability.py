import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from scoring_stability import scoring_stability_is_resolved


class ScoringStabilityTest(unittest.TestCase):
    def test_shared_fixed_vectors_and_unchanged_inputs(self):
        cases = json.loads((ROOT / 'tests/fixtures/scoring-stability-cases.json').read_text())
        for case in cases:
            with self.subTest(name=case['name']):
                before = json.dumps(case['stage'], sort_keys=True)
                self.assertIs(scoring_stability_is_resolved(case['stage']), case['expected'])
                self.assertEqual(json.dumps(case['stage'], sort_keys=True), before)

    def test_conference_entry_uses_same_predicate(self):
        spec = importlib.util.spec_from_file_location('scoring_conference_renderer', ROOT / 'scripts/conference-page-render.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIs(module.scoring_stability_is_resolved, scoring_stability_is_resolved)

    def test_non_json_numeric_values_never_bypass_proof(self):
        case = json.loads((ROOT / 'tests/fixtures/scoring-stability-cases.json').read_text())[2]['stage']
        for value in (float('nan'), float('inf'), -float('inf'), 10 ** 1000):
            with self.subTest(value=str(value)):
                case['finalScore'] = value
                self.assertFalse(scoring_stability_is_resolved(case))

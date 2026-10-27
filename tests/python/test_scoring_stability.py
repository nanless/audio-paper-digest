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


class ScoringConsensusBoundaryTest(unittest.TestCase):
    def test_same_boundary_vectors_and_original_proof_bytes(self):
        cases = json.loads((ROOT / 'tests/fixtures/scoring-consensus-boundaries.json').read_text())
        for case in cases:
            for method in ('second_pass_consensus', 'multi_pass_consensus'):
                with self.subTest(name=case['name'], method=method):
                    stage = {'stabilityWarning': True, 'finalScore': case['second'],
                             'auditSha256': 'b' * 64, 'stabilityResolution': {
                                 'contract': 'api-scoring-stability-resolution-v1',
                                 'status': 'resolved', 'method': method,
                                 'firstAuditScore': case['first'], 'secondAuditScore': case['second'],
                                 'scoreDifference': case['difference'], 'firstAuditSha256': 'a' * 64,
                                 'secondAuditSha256': 'b' * 64, 'thirdAuditScore': case['second'],
                                 'thirdAuditSha256': 'b' * 64, 'thirdAttempts': 1}}
                    before = json.dumps(stage, sort_keys=True)
                    self.assertIs(scoring_stability_is_resolved(stage), case['expected'])
                    self.assertEqual(json.dumps(stage, sort_keys=True), before)
                    if case['expected']:
                        stage['stabilityResolution']['status'] = 'unresolved'
                        self.assertFalse(scoring_stability_is_resolved(stage))

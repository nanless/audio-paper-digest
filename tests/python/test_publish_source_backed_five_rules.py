"""Pure Python/JS rule parity; never grants an authenticated source capability."""
import gzip
import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = next(parent for parent in Path(__file__).resolve().parents
            if (parent / 'package.json').is_file() and (parent / 'scripts/publish_common.py').is_file())
sys.path.insert(0, str(ROOT / 'scripts'))
import publish_common as api


class PublishSourceBackedFiveRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case_path = ROOT / 'tests/fixtures/publish-source-backed-five-rule-mutations.json'
        cls.cases = json.loads(cls.case_path.read_text())
        original = (ROOT / 'tests/fixtures' / cls.cases['baseFixture']).read_bytes()
        assert hashlib.sha256(original).hexdigest() == cls.cases['baseFixtureSha256']
        cls.papers = {row['paperId']: row for row in json.loads(gzip.decompress(original))['papers']}

    @staticmethod
    def _restore(value, mutation):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        assert hashlib.sha256(text.encode()).hexdigest() == mutation['baseSha256']
        at = mutation['prefixChars']
        changed = text[:at] + mutation['insert'] + text[at + mutation['removedChars']:]
        return changed if isinstance(value, str) else json.loads(changed)

    def test_original_three_complete_pure_table_validators(self):
        for paper_id, row in self.papers.items():
            with self.subTest(paper_id=paper_id):
                self.assertEqual(hashlib.sha256(row['sourceText'].encode()).hexdigest(), row['sourceSha256'])
                self.assertEqual(hashlib.sha256(row['analysisCheckpoint'].encode()).hexdigest(), row['checkpointSha256'])
                self.assertIsNone(api.validate_experiment_table_contract(
                    row['analysisCheckpoint'], api.EXPERIMENT_TABLE_CONTRACT_VERSION,
                    source_text=row['sourceText']))

    def test_source_scope_and_data_boundaries(self):
        for case in self.cases['cases']:
            with self.subTest(kind=case['kind'], name=case['name']):
                if case['kind'] == 'identifier':
                    value = api._is_table_identifier_header(case['header'])
                else:
                    paper = self.papers[case['paperId']]
                    results = api._extract_analysis_section(paper['analysisCheckpoint'], '实验结果')
                    tables = api.extract_markdown_tables(results)
                    material = {'source': paper['sourceText'], 'results': results, 'table': tables[0], 'tables': tables}
                    for field, mutation in case['mutations'].items():
                        material[field] = self._restore(material[field], mutation)
                    if case['kind'] == 'hearing':
                        value = sorted(api._source_backed_identity_columns(material['table'], material['source']))
                    elif case['kind'] == 'placement':
                        value = api._has_source_backed_placement_control(material['results'], material['source'])
                    elif case['kind'] == 'quality':
                        value = api._has_source_backed_quality_audibility_tradeoff(material['results'], material['tables'], material['source'])
                    elif case['kind'] == 'net':
                        value = api._has_source_backed_net_interval_negative(material['results'], material['tables'], material['source'])
                    else:
                        self.fail('Unregistered pure validation fixture kind')
                self.assertEqual(value, case['expected'])

    def test_invalid_rendered_scalar_is_reported_without_crashing(self):
        row = self.papers['2610.29613']
        original = '| N4 有限范围 | 紧凑 | 0.99 |'
        self.assertIn(original, row['analysisCheckpoint'])
        for value in ['未报告', '0.99%']:
            with self.subTest(value=value):
                analysis = row['analysisCheckpoint'].replace(original, '| N4 有限范围 | 紧凑 | ' + value + ' |', 1)
                issue = api.validate_experiment_table_contract(analysis, api.EXPERIMENT_TABLE_CONTRACT_VERSION,
                                                              source_text=row['sourceText'])
                self.assertIsInstance(issue, str)
                self.assertIn('负面证据', issue)


if __name__ == '__main__':
    unittest.main()

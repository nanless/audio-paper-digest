"""Pure Python/JS rule parity; never grants an authenticated source capability."""
import gzip
import hashlib
import json
import copy
import re
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

    def test_js_whitespace_fixed_reference_positions(self):
        reference = json.loads((ROOT / 'tests/fixtures/source-evidence-js-whitespace-expected.json').read_text())
        self.assertEqual(reference['sourceFixtureSha256'], self.cases['baseFixtureSha256'])
        def material(paper_id):
            paper = self.papers[paper_id]
            results = api._extract_analysis_section(paper['analysisCheckpoint'], '实验结果')
            tables = api.extract_markdown_tables(results)
            return {'source': paper['sourceText'], 'results': results, 'tables': tables, 'table': tables[0]}
        for case in reference['probes']:
            with self.subTest(kind=case['kind'], name=case['name']):
                char = chr(int(case['codePoint'][2:], 16)); kind = case['kind']; name = case['name']
                if kind == 'identifier':
                    value = api._is_table_identifier_header(char + '对比' + char)
                else:
                    item = material({'hearing': '2610.29613', 'quality': '2610.29613',
                                     'placement': '2610.29434', 'net': '2610.30385'}[kind])
                    if name.startswith('source-previous-work'):
                        if kind in ('hearing', 'quality'):
                            recipe = next(c for c in self.cases['cases'] if c['kind'] == 'hearing' and c['name'] == 'source-previous-work')
                            position = recipe['mutations']['source']['prefixChars']
                        elif kind == 'placement':
                            position = re.search(r'^(?:(?:[0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)\s+)?Uniform-stride versus adaptive event placement\s*\r?\n', item['source'], re.I | re.M).start()
                        else:
                            position = re.search(r'^[ \t]*[0-9]+(?:\.[0-9]+)*[ \t]+Net effect[ \t]*\r?\n', item['source'], re.I | re.M).start()
                        item['source'] = item['source'][:position] + 'Previous' + char + 'work:\n' + item['source'][position:]
                    elif name.startswith('single-codebook'):
                        item['source'] = item['source'].replace('one codebook (', 'one codebook' + char + '(', 1)
                    elif name.startswith('profile-label'):
                        item['table']['rows'][0][0] = 'N4' + char + '有限范围'
                    elif name.startswith('interval-normalization'):
                        item['source'] = item['source'].replace('pt, interval', 'pt,' + char + 'interval', 1)
                    else:
                        self.fail('Unknown fixed whitespace position')
                    if kind == 'hearing':
                        value = sorted(api._source_backed_identity_columns(item['table'], item['source']))
                    elif kind == 'placement':
                        value = api._has_source_backed_placement_control(item['results'], item['source'])
                    elif kind == 'quality':
                        value = api._has_source_backed_quality_audibility_tradeoff(item['results'], item['tables'], item['source'])
                    else:
                        value = api._has_source_backed_net_interval_negative(item['results'], item['tables'], item['source'])
                self.assertEqual(value, case['expected'])

    def test_exact_js_space_and_local_word_boundaries(self):
        expected = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
        self.assertEqual(api._JS_WHITESPACE, expected)
        pattern = api._source_evidence_pattern(r'^\s$')
        for char in expected:
            with self.subTest(codepoint=ord(char)):
                self.assertIsNotNone(re.fullmatch(pattern, char))
                self.assertTrue(api._is_table_identifier_header(char + '对比' + char))
        for char in '\u001c\u001d\u001e\u001f\u0085':
            with self.subTest(codepoint=ord(char)):
                self.assertIsNone(re.fullmatch(pattern, char))
                self.assertFalse(api._is_table_identifier_header(char + '对比' + char))
        boundary = api._source_evidence_pattern(r'\bif\b')
        for prefix in ('ſ', 'K', 's', 'K'):
            self.assertIsNone(re.search(boundary, prefix + 'if', re.I))
        for prefix in ('ı', 'İ'):
            self.assertIsNotNone(re.search(boundary, prefix + 'if', re.I))
            self.assertFalse(api._source_scope_observed_experiment_claim(prefix + 'if'))
        self.assertFalse(api._own_observed_source_scope('Previous\u00a0work:'))
        self.assertFalse(api._own_observed_source_scope('Previous\ufeffwork:'))
        self.assertTrue(api._source_scope_observed_experiment_claim('ſif'))
        self.assertTrue(api._source_scope_observed_experiment_claim('Kif'))
        self.assertEqual(api._source_evidence_pattern(r'\\s'), r'\\s')

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

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest

ACTUAL = os.environ.get('PD_SOURCE_MULTIPLIER_ACTUAL') == '1'
from test_publish_to_blog import publish_to_blog as blog

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / 'tests/fixtures/reader-source-multiplier-display-cases.json').read_text())['cases']


class ReaderSourceMultiplierDisplayTests(unittest.TestCase):
    def test_same_shared_real_and_negative_cases_as_node(self):
        inputs = [item['input'] for item in CASES]
        node = subprocess.check_output(['node', '-e',
            'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(JSON.parse(process.argv[2]).map(m.normalizeReaderSourceDisplayArtifacts)));',
            str(ROOT / 'scripts/lib/reader-source-display.js'), json.dumps(inputs)], text=True)
        self.assertEqual(json.loads(node), [item['displayText'] for item in CASES])
        for item in CASES:
            with self.subTest(value=item['input']):
                self.assertEqual(blog._normalize_api_reader_explicit_symbol_projection(item['input']), item['displayText'])
        for value in ('1.060×', '1.07×', '1.06×2', '1.06× +1'):
            self.assertNotEqual(blog._normalize_api_reader_source_cell(r'1.06×\times'),
                                blog._normalize_api_reader_source_cell(value))

    def test_complete_binding_accepts_only_same_value_and_retains_all_original_metadata(self):
        from test_table_currency_unit_literals import TableCurrencyUnitLiteralTest
        for item in (item for item in CASES if item['kind'] == 'real-dom'):
            publisher, paper, reseal = TableCurrencyUnitLiteralTest().currency_source_fixture(item['input'])
            paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(item['input'], item['displayText'])
            binding = paper['apiReaderPlan']['tableBindings'][0]
            cell = next(c for c in binding['cellBindings'] if c['sourceText'] == item['input'])
            cell['renderedText'] = item['displayText']
            binding['renderedTableSha256'] = hashlib.sha256(
                publisher._api_reader_markdown_tables(paper['apiReaderArticle'])[0]['markdown'].encode()).hexdigest()
            reseal(paper)
            original = copy.deepcopy(paper)
            publisher._validate_api_reader_source_bindings(paper)
            self.assertEqual(paper, original)
            for field, value in (('sourceText', r'1.07×\times'), ('renderedText', '1.060×'),
                                 ('sourceDomSha256', 'invalid')):
                bad = copy.deepcopy(paper)
                target = next(c for c in bad['apiReaderPlan']['tableBindings'][0]['cellBindings']
                              if c['sourceText'] == item['input'])
                target[field] = value
                reseal(bad)
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher._validate_api_reader_source_bindings(bad)
            wrong = copy.deepcopy(paper)
            wrong['apiReaderPlan']['tableBindings'][0]['renderedTableSha256'] = 'a' * 64
            reseal(wrong)
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher._validate_api_reader_source_bindings(wrong)

    @unittest.skipUnless(ACTUAL, 'requires current immutable Detection daily article and sealed source')
    def test_actual_detection_all_table_bindings_with_four_original_dom_cells(self):
        formal = ROOT / 'data/current/deep-analysis-result.json'
        before = formal.read_bytes()
        paper = next(p for p in json.loads(before)['papers'] if p['arxivId'] == '2610.19235v1')
        original = copy.deepcopy(paper)
        cells = paper['apiReaderPlan']['tableBindings'][0]['cellBindings']
        for item in (item for item in CASES if item['kind'] == 'real-dom'):
            cell = next(c for c in cells if c['sourceRow'] == item['sourceRow'] and c['sourceColumn'] == item['sourceColumn'])
            self.assertEqual(cell['sourceText'], item['input'])
            self.assertEqual(cell['renderedText'], item['displayText'])
        blog._validate_api_reader_source_bindings(paper)
        self.assertEqual(paper, original)
        self.assertEqual(formal.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()

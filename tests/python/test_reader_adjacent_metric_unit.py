import json
from pathlib import Path
import unittest
from test_publish_to_blog import publish_to_blog as publish
FIXTURE=Path(__file__).resolve().parents[1]/'fixtures/reader-adjacent-metric-unit-cases.json'
class ReaderAdjacentMetricUnitTest(unittest.TestCase):
    def test_same_quote_metric_value_unit_and_strict_negative_boundaries(self):
        fixture=json.loads(FIXTURE.read_text())
        for row in fixture['cases']:
            with self.subTest(row=row):
                table={'header':['Method',row['header']],'rows':[['A',row['value']]]}
                self.assertEqual(len(publish._reader_table_header_unit_evidence_failures(table,[row['quote']]))==0,row['expected'])
    def test_exact_saved_quotes_resolve_only_adjacent_metric_case_without_dom_capability(self):
        fixture=json.loads(FIXTURE.read_text())
        for row in fixture['real']:
            with self.subTest(paper=row['id']):
                self.assertEqual(len(publish._reader_table_header_unit_evidence_failures(row['table'],row['quotes']))==0,row['quoteOnlyResolved'])

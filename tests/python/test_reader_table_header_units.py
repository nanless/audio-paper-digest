import copy
import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import (
    publish_to_blog as publish,
    llm_api_publication_fixture,
    reseal_llm_api_reader_fixture,
)


def fixture(quote, header='WER (%)', cell='1.2'):
    paper = llm_api_publication_fixture()
    table = '| Method | ' + header + ' |\n|---|---|\n| A | ' + cell + ' |'
    old = publish._api_reader_markdown_tables(paper['apiReaderArticle'])[0]['markdown']
    paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old, table)
    paper['apiReaderPlan']['tableBindings'][0] = {
        'tableIndex': 1, 'sourceType': 'source_quotes', 'sourceTableOrdinal': None,
        'renderedTableSha256': hashlib.sha256(table.encode()).hexdigest(), 'cellBindings': [],
        'sourceQuotes': [{'quote': quote, 'sourceQuoteSha256': hashlib.sha256(quote.encode()).hexdigest()}]}
    reseal_llm_api_reader_fixture(paper)
    return paper


class ReaderTableHeaderUnitsTest(unittest.TestCase):
    def test_conference_publication_coverage_is_exact_and_does_not_change_original_bindings(self):
        # The bridge's actual cold source replay is exercised separately. This
        # checks the downstream coverage report cannot drift from original bytes.
        paper = fixture('The WER ratio is 1.2 for method A.')
        paper.update(source='conference', id='conference:interspeech:2026:conference-paper-id:test_interspeech')
        original = copy.deepcopy(paper)
        tables = publish._api_reader_markdown_tables(paper['apiReaderArticle'])
        report = {'paperId': paper['id'],
                  'readerArticleSha256': publish._javascript_string_sha256(paper['apiReaderArticle']),
                  'readerPlanSha256': paper['apiReaderPlanSha256'],
                  'tables': [{'tableIndex': index + 1,
                              'tableSha256': publish._javascript_string_sha256(table['markdown']),
                              'headerUnits': [{'row': 1, 'column': 1, 'value': '1.2', 'unit': '%'}] if index == 0 else [],
                              'numericTokens': []}
                             for index, table in enumerate(tables)]}
        self.assertEqual(publish._validate_api_reader_source_bindings(
            paper, publication_table_evidence=report)['tableCount'], len(tables))
        self.assertEqual(paper, original)
        for mutation in ('paper', 'article', 'plan', 'table', 'index', 'unit', 'cell', 'missing'):
            bad = copy.deepcopy(report)
            if mutation == 'paper': bad['paperId'] += '-other'
            elif mutation == 'article': bad['readerArticleSha256'] = '0' * 64
            elif mutation == 'plan': bad['readerPlanSha256'] = '0' * 64
            elif mutation == 'table': bad['tables'][0]['tableSha256'] = '0' * 64
            elif mutation == 'index': bad['tables'][0]['tableIndex'] = 2
            elif mutation == 'unit': bad['tables'][0]['headerUnits'][0]['unit'] = 'ms'
            elif mutation == 'cell': bad['tables'][0]['headerUnits'][0]['value'] = '9.9'
            else: bad['tables'] = []
            with self.subTest(mutation=mutation), self.assertRaises(publish.PublishDataValidationError):
                publish._validate_api_reader_source_bindings(paper, publication_table_evidence=bad)
        with self.assertRaisesRegex(publish.PublishDataValidationError, '列头单位'):
            publish._validate_api_reader_source_bindings(paper)

    def test_self_consistent_old_record_cannot_borrow_header_unit(self):
        for quote, header, cell in [
            ('The WER error-to-reference-word ratio is 1.2 for A.', 'WER (%)', '1.2'),
            ('A has WER ratio 1.2 and CER (%) is 12.', 'WER (%)', '1.2'),
            ('A has WER ratio 1.2. OtherWER (%) is reported separately.', 'WER (%)', '1.2'),
            ('The latency is 1.2 s for method A.', 'Latency (ms)', '1.2 s'),
            ('A has WER ratio 1.2 and CER is 1.2%.', 'WER (%)', '1.2'),
            ('A has WER ratio 1.2. WER (%) of method B is 8.', 'WER (%)', '1.2'),
            ('A has latency 1.2 s and overhead 1.2 ms.', 'Latency (ms)', '1.2'),
            ('WER (%) is not reported and CER (%) is 1.2 for A.', 'WER (%)', '1.2'),
            ('WER (%) of B is unavailable while WER ratio of A is 1.2.', 'WER (%)', '1.2'),
        ]:
            with self.subTest(quote=quote):
                with self.assertRaisesRegex(publish.PublishDataValidationError, '列头单位'):
                    publish._validate_api_reader_source_bindings(fixture(quote, header, cell))

    def test_exact_original_metric_header_or_cell_unit_remains_valid(self):
        for quote, header, cell in [
            ('The WER (%) of method A is 1.2.', 'WER (%)', '1.2'),
            ('该方法的WER（％）为1.2，在原文中逐字列出。', 'WER (%)', '1.2'),
            ('The WER (%) of method A is 1.2.', 'WER（％）↓', '1.2'),
            ('The WER is 1.2% for method A.', 'WER (%)', '1.2%'),
            ('The latency (ms) is 1.2 for method A.', 'Latency (ms)', '1.2'),
        ]:
            with self.subTest(header=header):
                self.assertEqual(publish._validate_api_reader_source_bindings(fixture(quote, header, cell))['tableCount'], 1)

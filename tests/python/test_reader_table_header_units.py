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

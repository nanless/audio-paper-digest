"""Real sealed-source publisher boundary tests, without blog/model writes."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from test_publish_to_blog import (publish_to_blog as publish,
    llm_api_publication_fixture, reseal_llm_api_reader_fixture)


class PdfQuoteTokenBoundaryTests(unittest.TestCase):
    def test_numeric_unit_cannot_be_created_by_joining_distinct_quote_origins(self):
        html_quote = 'A report lists a measured score of 1'
        pdf_quote = 's is a variable in a different explanation.'
        original = '| Method | Value |\n| --- | --- |\n| Measured | 1 |'
        paper = llm_api_publication_fixture()
        paper['apiReaderArticle'] = original
        paper['apiReaderPlan']['formulaBindings'] = []
        paper['apiReaderPlan']['tableBindings'] = [{'tableIndex': 1,
            'sourceType': 'source_quotes', 'sourceTableOrdinal': None,
            'renderedTableSha256': hashlib.sha256(original.encode()).hexdigest(),
            'cellBindings': [], 'sourceQuotes': [{'quote': html_quote,
                'sourceQuoteSha256': hashlib.sha256(html_quote.encode()).hexdigest()}],
            'sealedPdfQuoteEvidence': [{'quote': pdf_quote}]}]
        reseal_llm_api_reader_fixture(paper)
        with patch.object(publish, '_verify_reader_sealed_pdf_quote_bindings', return_value={1: [pdf_quote]}):
            publish._validate_api_reader_source_bindings(paper)
            bad = copy.deepcopy(paper)
            bad['apiReaderArticle'] = original.replace('| 1 |', '| 1 s |')
            bad['apiReaderPlan']['tableBindings'][0]['renderedTableSha256'] = hashlib.sha256(
                bad['apiReaderArticle'].encode()).hexdigest()
            reseal_llm_api_reader_fixture(bad)
            with self.assertRaisesRegex(publish.PublishDataValidationError, '数字|单位'):
                publish._validate_api_reader_source_bindings(bad)


@unittest.skipUnless(os.environ.get('PD_PDF_QUOTE_REAL_PROOFS') and os.environ.get('PD_GENERIC_PDF_REAL_DATA_FILE'),
                     'private sealed PDF quotation fixture required')
class PdfQuotePublisherBoundaryTests(unittest.TestCase):
    def paper(self):
        examples = json.loads(Path(os.environ['PD_PDF_QUOTE_REAL_PROOFS']).read_text())
        batch = json.loads(Path(os.environ['PD_GENERIC_PDF_REAL_DATA_FILE']).read_text())
        example = examples[0]
        paper = copy.deepcopy(next(p for p in batch['papers']
            if publish.normalize_publish_arxiv_id(p['arxivId']) == example['paperId']))
        directory = publish.DAILY_FRESH_SOURCE_RUNS_DIR / paper['freshRewriteProvenance']['runId'] \
            / 'sources' / example['paperId'] / 'generation-000001'
        runtime = json.loads((directory / 'source-runtime.json').read_text())
        paper['apiReaderPlan'] = {'structuredSourcePayload': json.dumps(
            {key: value for key, value in runtime['structuredArtifacts'].items() if key != 'payloadSha256'},
            ensure_ascii=False, sort_keys=True, separators=(',', ':')),
            'tableBindings': [{'tableIndex': 1, 'sourceType': 'source_quotes', 'sourceQuotes': [],
                               'sealedPdfQuoteEvidence': [example['evidence']]}]}
        return paper, directory

    def test_mixed_origin_requires_actual_html_text_not_only_self_hash(self):
        paper, directory = self.paper()
        binding = paper['apiReaderPlan']['tableBindings'][0]
        html_quote = (directory / 'source.txt').read_text()[:180]
        binding['sourceQuotes'] = [{'quote': html_quote, 'sourceQuoteSha256': hashlib.sha256(html_quote.encode()).hexdigest()}]
        before = copy.deepcopy(paper)
        self.assertEqual(len(publish._verify_reader_sealed_pdf_quote_bindings(paper)), 1)
        self.assertEqual(paper, before)
        for quote in ['Invented HTML evidence gives 99.99 percent for an unknown method.', html_quote + ' altered']:
            bad = copy.deepcopy(paper)
            bad['apiReaderPlan']['tableBindings'][0]['sourceQuotes'] = [{
                'quote': quote, 'sourceQuoteSha256': hashlib.sha256(quote.encode()).hexdigest()}]
            with self.assertRaises(publish.PublishDataValidationError):
                publish._verify_reader_sealed_pdf_quote_bindings(bad)

    def test_sixty_five_proofs_across_two_bindings_are_rejected_before_replay(self):
        paper, _ = self.paper()
        original = paper['apiReaderPlan']['tableBindings'][0]
        first = copy.deepcopy(original)
        first['sealedPdfQuoteEvidence'] *= 32
        second = copy.deepcopy(original)
        second['tableIndex'] = 2
        second['sealedPdfQuoteEvidence'] *= 33
        paper['apiReaderPlan']['tableBindings'] = [first, second]
        before = copy.deepcopy(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish._verify_reader_sealed_pdf_quote_bindings(paper)
        self.assertEqual(paper, before)


if __name__ == '__main__':
    unittest.main()

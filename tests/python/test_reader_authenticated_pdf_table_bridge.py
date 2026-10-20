import copy
import hashlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_reader_table_header_units import fixture, publish
from test_publish_to_blog import reseal_llm_api_reader_fixture
from publication_local_replay import LocalReplayFailure


class AuthenticatedPdfTableBridgeTests(unittest.TestCase):
    def fixture(self):
        paper = fixture('The WER ratio is 1.2 for method A.')
        paper.update(source='conference', id='conference:interspeech:2026:conference-paper-id:test_interspeech')
        proof = {'contract': 'reader-authenticated-pdf-table-evidence-v1', 'evidenceSha256': '1' * 64}
        paper['apiReaderPlan']['tableBindings'][0]['authenticatedPdfTableEvidence'] = proof
        reseal_llm_api_reader_fixture(paper)
        tables = publish._api_reader_markdown_tables(paper['apiReaderArticle'])
        report = {'contract': proof['contract'], 'paperId': paper['id'],
                  'sourceTextSha256': paper['sourceSha256'],
                  'readerArticleSha256': publish._javascript_string_sha256(paper['apiReaderArticle']),
                  'readerPlanSha256': paper['apiReaderPlanSha256'],
                  'tables': [{'tableIndex': index + 1,
                              'tableSha256': publish._javascript_string_sha256(table['markdown']),
                              'headerUnits': [{'row': 1, 'column': 1, 'value': '1.2', 'unit': '%'}] if index == 0 else [],
                              'numericTokens': [],
                              **({'authenticatedPdfProofVerified': True,
                                  'authenticatedPdfEvidenceSha256': proof['evidenceSha256']} if index == 0 else {})}
                             for index, table in enumerate(tables)]}
        return paper, report

    def test_fresh_worker_projection_binds_saved_proof_and_exact_source_reader(self):
        paper, report = self.fixture()
        original = copy.deepcopy(paper)
        with patch.object(publish, '_replay_authenticated_pdf_table_bindings', return_value=report) as replay:
            self.assertEqual(publish._validate_api_reader_source_bindings(paper)['tableCount'], 1)
            replay.assert_called_once_with(paper)
        self.assertEqual(paper, original)
        for mutation in ('source', 'proof', 'verified', 'paper', 'table'):
            bad = copy.deepcopy(report)
            if mutation == 'source': bad['sourceTextSha256'] = '0' * 64
            elif mutation == 'proof': bad['tables'][0]['authenticatedPdfEvidenceSha256'] = '0' * 64
            elif mutation == 'verified': bad['tables'][0]['authenticatedPdfProofVerified'] = False
            elif mutation == 'paper': bad['paperId'] += '-other'
            else: bad['tables'][0]['tableSha256'] = '0' * 64
            with self.subTest(mutation=mutation), self.assertRaises(publish.PublishDataValidationError):
                publish._validate_api_reader_source_bindings(paper, publication_table_evidence=bad)

    def test_declared_json_alone_uses_real_worker_and_cannot_grant_capability(self):
        paper, _ = self.fixture()
        with self.assertRaises(publish.PublishDataValidationError) as caught:
            publish._validate_api_reader_source_bindings(paper)
        error = caught.exception
        self.assertIsInstance(error, LocalReplayFailure)
        self.assertEqual(error.worker, 'reader-resource-claims-replay-cli.js')
        self.assertIsInstance(error.returncode, int)
        self.assertNotEqual(error.returncode, 0)
        self.assertFalse(error.timed_out)
        self.assertFalse(error.output_truncated)

    def test_historical_arxiv_uses_direct_canonical_id_without_bypassing_figure_checks(self):
        paper, report = self.fixture()
        paper.update(source='arxiv', directPaperId='arxiv:2601.00001', id='2601.00001')
        report['paperId'] = paper['directPaperId']
        self.assertEqual(publish._validate_api_reader_source_bindings(paper, publication_table_evidence=report)['tableCount'], 1)


if __name__ == '__main__':
    unittest.main()

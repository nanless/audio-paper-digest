import copy
import hashlib
import json
import os
from pathlib import Path
import unittest

from test_publish_to_blog import publish_to_blog as publish


class PdfSelectionPublicationTests(unittest.TestCase):
    def test_selection_declaration_without_actual_full_pdf_proof_never_grants_authority(self):
        with self.assertRaises(publish.PublishDataValidationError):
            publish._verify_reader_sealed_pdf_grid_bindings({'apiReaderPlan': {'tableBindings': [
                {'sealedPdfTableSelection': {'contract': 'reader-compiled-pdf-table-selection-v1'}}]}})

    @unittest.skipUnless(os.environ.get('PD_READER_PDF_SELECTION_REAL_EVIDENCE'),
                         'Requires explicit SHA-bound real paid source/Reader snapshot')
    def test_real_full_source_pdf_and_shared_compiler_replay_selected_cells_and_reject_tampering(self):
        evidence_bytes = Path(os.environ['PD_READER_PDF_SELECTION_REAL_EVIDENCE']).read_bytes()
        self.assertEqual(hashlib.sha256(evidence_bytes).hexdigest(),
                         os.environ.get('PD_READER_PDF_SELECTION_REAL_EVIDENCE_SHA256'))
        data = json.loads(evidence_bytes)
        self.assertEqual(data['candidateSha256'], '83004d869db5813d4c576f3224e27cf817da39c1101093c9cd750eec7aec8f02')
        candidate_file = Path(data['candidateFile'])
        before = candidate_file.read_bytes()
        self.assertEqual(hashlib.sha256(before).hexdigest(), data['candidateSha256'])
        paper = copy.deepcopy(data['paperInput'])
        paper['apiReaderPlan'] = data['result']['plan']
        paper['apiReaderArticle'] = data['result']['article']
        original = copy.deepcopy(paper)
        values = publish._verify_reader_sealed_pdf_grid_bindings(paper)
        self.assertEqual(len(values), 4)
        self.assertEqual(values[2][(1, 1)], '5.87')
        self.assertEqual(values[4][(1, 3)], '4.74')
        self.assertEqual(paper, original)
        for mutate in [lambda b: b['cellBindings'][4].update(sourceRow=6),
                       lambda b: b.update(sourceTableOrdinal=4),
                       lambda b: b['sealedPdfTableEvidence'].update(pdfSha256='a'*64),
                       lambda b: b['cellBindings'].pop(),
                       lambda b: b['sealedPdfTableSelection'].update(sourceRows=[0, 1]),
                       lambda b: b.pop('sealedPdfTableSelection')]:
            changed = copy.deepcopy(paper)
            mutate(changed['apiReaderPlan']['tableBindings'][0])
            with self.assertRaises(publish.PublishDataValidationError):
                publish._verify_reader_sealed_pdf_grid_bindings(changed)
        # Source-binding validation also checks actual rendered values and its
        # normal whole-plan hash; this local test view never changes production.
        source = paper['analysisManifest']['sourceAcquisition']
        bindings_sha = publish._stable_json_sha256({'tableBindings': paper['apiReaderPlan']['tableBindings'],
                                                  'formulaBindings': paper['apiReaderPlan']['formulaBindings']})
        paper['apiReaderPlan']['sourceBindingsSha256'] = bindings_sha
        paper['analysisManifest']['contracts']['apiReaderSourceBindings'] = 'api-reader-source-bindings-v4'
        stage = paper['analysisManifest']['stages']['apiReaderArticle']
        stage.update(sourceBindingsSha256=bindings_sha, sourceBindingsContractVersion='api-reader-source-bindings-v4',
                     sourceBindingsSourceTextSha256=source['sourceSha256'],
                     structuredArtifactsSha256=source['structuredArtifactsSha256'],
                     tableBindingCount=4, formulaBindingCount=len(paper['apiReaderPlan']['formulaBindings']))
        publish._validate_api_reader_source_bindings(paper)
        changed = copy.deepcopy(paper)
        changed['apiReaderArticle'] = changed['apiReaderArticle'].replace('| Long Context | 5.87 |', '| Long Context | 9.99 |')
        table = publish._api_reader_markdown_tables(changed['apiReaderArticle'])[1]
        changed['apiReaderPlan']['tableBindings'][1]['renderedTableSha256'] = publish._javascript_string_sha256(table['markdown'])
        changed['apiReaderPlan']['tableBindings'][1]['cellBindings'][5]['renderedText'] = '9.99'
        changed['apiReaderPlan']['sourceBindingsSha256'] = publish._stable_json_sha256({
            'tableBindings': changed['apiReaderPlan']['tableBindings'], 'formulaBindings': changed['apiReaderPlan']['formulaBindings']})
        changed['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSha256'] = changed['apiReaderPlan']['sourceBindingsSha256']
        with self.assertRaises(publish.PublishDataValidationError):
            publish._validate_api_reader_source_bindings(changed)
        self.assertEqual(candidate_file.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()

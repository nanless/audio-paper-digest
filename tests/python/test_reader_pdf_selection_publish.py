import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
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
        # Actual normal parser + actual sealed author source, with models/network
        # forbidden in the child. These views retain invalid_output stage status:
        # they exercise source components, not manufacture complete paid papers.
        views = json.loads(subprocess.check_output(['node', str(Path(__file__).resolve().parents[1]
            / 'helpers/reader-pdf-selection-source-views.cjs')], cwd=Path(__file__).resolve().parents[2],
            timeout=90))
        self.assertEqual(views[0]['apiReaderArticle'], data['result']['article'])
        self.assertEqual(views[0]['apiReaderPlan'], data['result']['plan'])
        self.assertEqual(views[1]['apiReaderArticle'], views[0]['apiReaderArticle'])
        for view in views:
            self._check_source_view(view)
        self.assertEqual(candidate_file.read_bytes(), before)

    def _check_source_view(self, paper):
        def replay_source(view):
            marked, source_dir, _, _ = publish._read_reader_sealed_pdf_grid_source(view)
            return publish._replay_reader_sealed_pdf_grid(view, marked, source_dir)

        original = copy.deepcopy(paper)
        values = replay_source(paper)
        self.assertEqual(len(values), 4)
        self.assertEqual(values[2][(1, 1)], '5.87')
        self.assertEqual(values[4][(1, 3)], '4.74')
        self.assertEqual(paper, original)
        for mutate in [lambda b: b['cellBindings'][4].update(sourceRow=6),
                       lambda b: b.update(sourceTableOrdinal=4),
                       lambda b: b['sealedPdfTableEvidence'].update(pdfSha256='a'*64),
                       lambda b: b['cellBindings'].pop(),
                       lambda b: b['sealedPdfTableSelection'].update(sourceRows=[0, 1]),
                       lambda b: b.pop('sealedPdfTableSelection'),
                       lambda b: b['sealedPdfTableEvidence'].update(schemaFingerprint='f'*64),
                       lambda b: b['sealedPdfTableSelection'].update(schemaFingerprint='f'*64)]:
            changed = copy.deepcopy(paper)
            mutate(changed['apiReaderPlan']['tableBindings'][0])
            with self.assertRaises(publish.PublishDataValidationError):
                replay_source(changed)
        # A historical draft is not today's completed article. In particular,
        # the live source run has a later real completion index; the full
        # publisher must refuse this earlier component view in both formats.
        with self.assertRaisesRegex(publish.PublishDataValidationError, '资源可用性宣称未通过封存来源核验'):
            publish._verify_reader_sealed_pdf_grid_bindings(paper)
        changed = copy.deepcopy(paper)
        changed['apiReaderArticle'] = changed['apiReaderArticle'].replace('| Long Context | 5.87 |', '| Long Context | 9.99 |')
        table = publish._api_reader_markdown_tables(changed['apiReaderArticle'])[1]
        changed['apiReaderPlan']['tableBindings'][1]['renderedTableSha256'] = publish._javascript_string_sha256(table['markdown'])
        changed['apiReaderPlan']['tableBindings'][1]['cellBindings'][5]['renderedText'] = '9.99'
        changed['apiReaderPlan']['sourceBindingsSha256'] = publish._stable_json_sha256({
            'tableBindings': changed['apiReaderPlan']['tableBindings'], 'formulaBindings': changed['apiReaderPlan']['formulaBindings']})
        changed['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSha256'] = changed['apiReaderPlan']['sourceBindingsSha256']
        # This component produces the authoritative source value, never the
        # supplied rendered text. The whole publisher still refuses the view.
        self.assertEqual(replay_source(changed)[2][(1, 1)], '5.87')
        with self.assertRaises(publish.PublishDataValidationError):
            publish._validate_api_reader_source_bindings(changed)


if __name__ == '__main__':
    unittest.main()

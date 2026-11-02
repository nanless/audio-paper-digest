import copy
import hashlib
import json
import os
from pathlib import Path
import unittest

from test_publish_to_blog import publish_to_blog as publish
from publish_common import strict_source_cell_math_display


class ScientificSourceCellDisplayTests(unittest.TestCase):
    def test_whole_cell_literal_scientific_duplicates_preserve_precision(self):
        for raw, display in [
            (r'20.61×10220.61\times 10^{2}', '20.61×10²'),
            (r'0.41×1020.41\times 10^{2}', '0.41×10²'),
            (r'2.28×1022.28\times 10^{2}', '2.28×10²'),
            (r'1.17×1021.17\times 10^{2}', '1.17×10²'),
            (r'-1.20×10-02-1.20\times10^{-02}', '-1.20×10⁻⁰²'),
            (r'+0.010×10+03+0.010\times 10^{+03}', '+0.010×10⁺⁰³')
        ]:
            self.assertEqual(strict_source_cell_math_display(raw), {
                'contract': 'source-cell-math-display-v1', 'kind': 'scientific-notation-duplicate',
                'sourceText': raw, 'sourceTextSha256': hashlib.sha256(raw.encode()).hexdigest(), 'displayText': display})
            self.assertIsNone(strict_source_cell_math_display(display))
        for raw in [
            r'20.61×10220.62\times 10^{2}', r'20.61×10220.61\times 10^{3}',
            r'-20.61×10220.61\times 10^{2}', r'20.610×10220.61\times 10^{2}',
            r'20.61×10+220.61\times 10^{2}', r'20.61×10220.61\times 10^{02}',
            '20.61×10220.61', r'20.61\times 10^{2}', r'20.61×10220.61\times 10^{2} ms',
            r'20.61×10220.61\times 10^{2} 7', r'x20.61×10220.61\times 10^{2}',
            r'20.61×10220.61\times 10^{2}x', r'20.61×10220.61\unknown 10^{2}',
            r'２０.６１×102２０.６１\times 10^{2}', r'20.61×10220.61\times 10^{2}' + '\n',
            r'20.61×10220.61\times 10^{2}\times10^{3}'
        ]:
            self.assertIsNone(strict_source_cell_math_display(raw), raw)

    @unittest.skipUnless(os.environ.get('PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE'), 'Requires explicit SHA-bound actual paid draft')
    def test_actual_saved_reader_publication_cold_source_binding_and_negative_coordinates(self):
        evidence_bytes = Path(os.environ['PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE']).read_bytes()
        self.assertEqual(hashlib.sha256(evidence_bytes).hexdigest(), os.environ['PD_READER_SCIENTIFIC_DOM_REAL_EVIDENCE_SHA256'])
        evidence = json.loads(evidence_bytes)
        paper = copy.deepcopy(evidence['paperInput'])
        paper['apiReaderPlan'] = evidence['result']['plan']
        paper['apiReaderArticle'] = evidence['result']['article']
        # A local component-validation view, never a completion or stage receipt.
        # Retain the actual stage status and all scientific upstream records.
        stage = paper['analysisManifest']['stages']['apiReaderArticle']
        paper['analysisManifest']['contracts']['apiReaderSourceBindings'] = paper['apiReaderPlan']['sourceBindingsContract']
        stage.update(sourceBindingsSha256=paper['apiReaderPlan']['sourceBindingsSha256'],
                     sourceBindingsContractVersion='api-reader-source-bindings-v4',
                     sourceBindingsSourceTextSha256=evidence['sourceDescriptor']['sourceSha256'],
                     structuredArtifactsSha256=evidence['sourceDescriptor']['structuredArtifactsSha256'],
                     tableBindingCount=len(paper['apiReaderPlan']['tableBindings']),
                     formulaBindingCount=len(paper['apiReaderPlan']['formulaBindings']))
        publish._validate_api_reader_source_bindings(paper)
        for mutate in [lambda c: c.update(sourceText=r'20.61×10220.62\times 10^{2}'),
                       lambda c: c.update(sourceRow=2), lambda c: c.update(sourceColumn=2),
                       lambda c: c.update(sourceDomSha256='a'*64)]:
            changed = copy.deepcopy(paper)
            mutate(changed['apiReaderPlan']['tableBindings'][1]['cellBindings'][7])
            changed['apiReaderPlan']['sourceBindingsSha256'] = publish._stable_json_sha256({
                'tableBindings': changed['apiReaderPlan']['tableBindings'], 'formulaBindings': changed['apiReaderPlan']['formulaBindings']})
            changed['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSha256'] = changed['apiReaderPlan']['sourceBindingsSha256']
            with self.assertRaises(publish.PublishDataValidationError):
                publish._validate_api_reader_source_bindings(changed)
        for drop_payload, padded, fake_pdf in [(False, False, False), (True, False, False),
                                             (False, True, False), (False, False, True)]:
            changed = copy.deepcopy(paper)
            binding = changed['apiReaderPlan']['tableBindings'][1]
            binding['sourceTableDomSha256'] = 'a'*64
            for cell in binding['cellBindings']:
                if (strict_source_cell_math_display(cell['sourceText']) or {}).get('kind') == 'scientific-notation-duplicate':
                    cell.update(sourceText=cell['renderedText'], sourceDomSha256='b'*64)
            if drop_payload:
                changed['apiReaderPlan'].pop('structuredSourcePayload', None)
            if padded:
                for cell in binding['cellBindings']:
                    cell['renderedText'] += ' '
            if fake_pdf:
                binding['sealedPdfTableEvidence'] = {'contract': 'copied-json-is-not-pdf-evidence'}
            changed['apiReaderPlan']['sourceBindingsSha256'] = publish._stable_json_sha256({
                'tableBindings': changed['apiReaderPlan']['tableBindings'], 'formulaBindings': changed['apiReaderPlan']['formulaBindings']})
            changed['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSha256'] = changed['apiReaderPlan']['sourceBindingsSha256']
            with self.assertRaises(publish.PublishDataValidationError):
                publish._validate_api_reader_source_bindings(changed)
        for file, expected in evidence['originals'].items():
            self.assertEqual(hashlib.sha256(Path(file).read_bytes()).hexdigest(), expected)


if __name__ == '__main__':
    unittest.main()

import copy
import hashlib
import json
import unittest
from test_publish_to_blog import (publish_to_blog, llm_api_publication_fixture,
                                 reseal_llm_api_reader_fixture, PublishDataValidationError)


class ReaderFormulaEligibilityTest(unittest.TestCase):
    def paper(self, latex, visible, display):
        paper = llm_api_publication_fixture()
        plan = paper['apiReaderPlan']
        plan.pop('structuredSourcePayload', None)
        binding = copy.deepcopy(plan['formulaBindings'][0])
        binding['latex'] = latex
        paper['apiReaderArticle'] = '\\[' + latex + '\\]'
        binding['renderedBlockSha256'] = hashlib.sha256(paper['apiReaderArticle'].encode()).hexdigest()
        plan['tableBindings'] = []
        plan['formulaBindings'] = [binding]
        source = {'flattenedTextSha256': paper['sourceSha256'], 'formulas': [{
            'ordinal': binding['formulaOrdinal'], 'latex': latex,
            'text': visible, 'mathml': '<math display="' + display + '">',
            'recoveryStatus': 'complete', 'sourceDomSha256': binding['sourceDomSha256']}]}
        payload = json.dumps(source, ensure_ascii=False, separators=(',', ':'))
        structured_sha = hashlib.sha256(payload.encode()).hexdigest()
        paper['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = structured_sha
        paper['analysisManifest']['stages']['apiReaderArticle']['structuredArtifactsSha256'] = structured_sha
        reseal_llm_api_reader_fixture(paper)
        return paper, payload

    def test_public_publication_gate_rejects_missing_and_self_consistent_inline_fragment(self):
        paper, payload = self.paper('(z_1,z_2)', '(z1,z2) = g(x)', 'inline')
        with self.assertRaises(PublishDataValidationError):
            publish_to_blog._validate_api_reader_source_bindings(paper)
        paper['apiReaderPlan']['structuredSourcePayload'] = payload
        reseal_llm_api_reader_fixture(paper)
        with self.assertRaisesRegex(PublishDataValidationError, '片段|完整原始'):
            publish_to_blog._validate_api_reader_source_bindings(paper)

    def test_public_publication_gate_keeps_complete_expression_and_equations(self):
        for latex, visible, display in [('C^*', 'C*', 'block'), ('x=y', 'x = y', 'block'), ('x=y', 'x = y', 'inline')]:
            with self.subTest(latex=latex, display=display):
                paper, payload = self.paper(latex, visible, display)
                paper['apiReaderPlan']['structuredSourcePayload'] = payload
                reseal_llm_api_reader_fixture(paper)
                publish_to_blog._validate_api_reader_source_bindings(paper)

    def test_multiline_loss_prefix_is_not_a_complete_formula(self):
        for name in ['DPO', 'CoPO']:
            latex = r'\displaystyle\mathcal{L}_{\mathrm{' + name + r'}}=-\log\sigma\Bigg('
            paper, payload = self.paper(latex, 'L = -log sigma(a-b)', 'inline')
            paper['apiReaderPlan']['structuredSourcePayload'] = payload
            reseal_llm_api_reader_fixture(paper)
            before = copy.deepcopy(paper)
            with self.assertRaisesRegex(PublishDataValidationError, '片段|完整原始'):
                publish_to_blog._validate_api_reader_source_bindings(paper)
            self.assertEqual(paper, before)
        for latex in [r'\mathcal L=-\log\sigma(a-b)', r'x \in [0,1[']:
            paper, payload = self.paper(latex, latex, 'block')
            paper['apiReaderPlan']['structuredSourcePayload'] = payload
            reseal_llm_api_reader_fixture(paper)
            publish_to_blog._validate_api_reader_source_bindings(paper)


if __name__ == '__main__':
    unittest.main()

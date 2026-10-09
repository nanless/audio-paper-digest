import copy
import hashlib
import json
import sys
import subprocess
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import (publish_to_blog as publish, llm_api_publication_fixture,
                                  reseal_llm_api_reader_fixture)

FORMULA = r'\displaystyle S_{\text{ctc}}(y,X)=-\frac{\mathrm{CTCLoss}\big(\log p_{\text{ctc}}(X),\,\mathrm{tok}(y)\big)}{\max(|\mathrm{tok}(y)|,\,5)}'

def fixture():
    paper = llm_api_publication_fixture()
    binding = paper['apiReaderPlan']['formulaBindings'][0]
    old = '\\[' + binding['latex'] + '\\]'
    binding['latex'] = FORMULA
    block = '\\[' + FORMULA + '\\]'
    binding['renderedBlockSha256'] = hashlib.sha256(block.encode()).hexdigest()
    paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old, block)
    artifacts = {'version': 4, 'flattenedTextSha256': paper['sourceSha256'], 'formulas': [{
        'ordinal': 1, 'latex': FORMULA, 'sourceDomSha256': binding['sourceDomSha256']}]}
    payload = json.dumps(artifacts, ensure_ascii=False, separators=(',', ':'))
    digest = hashlib.sha256(payload.encode()).hexdigest()
    paper['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = digest
    paper['analysisManifest']['stages']['apiReaderArticle']['structuredArtifactsSha256'] = digest
    reseal_llm_api_reader_fixture(paper)
    return paper, payload

class ReaderFormulaSourceTests(unittest.TestCase):
    def test_old_self_consistent_guess_and_boolean_claim_are_rejected(self):
        paper, _ = fixture()
        for claim in (False, True):
            with self.subTest(claim=claim):
                paper['apiReaderPlan']['rawTeXVerified'] = claim
                reseal_llm_api_reader_fixture(paper)
                with self.assertRaisesRegex(publish.PublishDataValidationError, '原始结构化内容'):
                    publish._validate_api_reader_source_bindings(paper)

    def test_actual_same_formula_is_accepted_and_changed_payload_is_rejected(self):
        paper, payload = fixture()
        paper['apiReaderPlan']['structuredSourcePayload'] = payload
        reseal_llm_api_reader_fixture(paper)
        self.assertEqual(publish._validate_api_reader_source_bindings(paper)['formulaCount'], 1)
        paper['apiReaderPlan']['structuredSourcePayload'] = payload.replace('CTCLoss', 'FakeLoss')
        reseal_llm_api_reader_fixture(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish._validate_api_reader_source_bindings(paper)

    def test_wrong_original_tex_location_dom_or_source_remains_rejected(self):
        paper, payload = fixture()
        changes = [('latex', r'S_{\text{ctc}}(y,X)=-'), ('ordinal', 2),
                   ('sourceDomSha256', '0' * 64), ('flattenedTextSha256', '0' * 64)]
        for key, value in changes:
            with self.subTest(key=key):
                current = copy.deepcopy(paper)
                artifacts = json.loads(payload)
                (artifacts if key == 'flattenedTextSha256' else artifacts['formulas'][0])[key] = value
                changed = json.dumps(artifacts, separators=(',', ':'))
                current['apiReaderPlan']['structuredSourcePayload'] = changed
                digest = hashlib.sha256(changed.encode()).hexdigest()
                current['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = digest
                current['analysisManifest']['stages']['apiReaderArticle']['structuredArtifactsSha256'] = digest
                reseal_llm_api_reader_fixture(current)
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._validate_api_reader_source_bindings(current)

    def test_node_real_html_source_payload_replays_in_python(self):
        root = Path(__file__).resolve().parents[2]
        script = r"""
const deep = require('./scripts/deep-analyzer');
const cheerio = require('cheerio');
const latex = process.argv[1];
const html = '<div class="ltx_equation"><math display="block"><semantics><mtext>CTCLoss max</mtext><annotation encoding="application/x-tex">' + latex + '</annotation></semantics></math></div>';
const sourceText = cheerio.load(html)('body').text();
const structuredArtifacts = deep.bindStructuredArtifactsToText(deep.parseArxivStructuredArtifactsFromHtml(html, '2601.12345v1', '2601.12345v1'), sourceText);
const result = deep.bindApiReaderSourceEvidence('[[FORMULA_1]]', [], [{ formulaOrdinal: 1, targetKind: 'component', marker: '[[FORMULA_1]]' }], { sourceText, structuredArtifacts, sections: [{kind: 'component', heading: '训练目标', body: '[[FORMULA_1]]'}] });
process.stdout.write(JSON.stringify({ result, structuredArtifacts }));
"""
        raw = subprocess.check_output(['node', '-e', script, FORMULA], cwd=root, text=True)
        output = json.loads(raw[raw.index('{"result":'):])
        paper, _ = fixture()
        plan, artifacts = paper['apiReaderPlan'], output['structuredArtifacts']
        plan['formulaBindings'] = output['result']['formulaBindings']
        plan['structuredSourcePayload'] = output['result']['structuredSourcePayload']
        paper['sourceSha256'] = artifacts['flattenedTextSha256']
        paper['analysisManifest']['sourceAcquisition'].update(sourceSha256=paper['sourceSha256'], structuredArtifactsSha256=artifacts['payloadSha256'])
        paper['analysisManifest']['stages']['apiReaderArticle'].update(sourceBindingsSourceTextSha256=paper['sourceSha256'], structuredArtifactsSha256=artifacts['payloadSha256'])
        reseal_llm_api_reader_fixture(paper)
        self.assertEqual(publish._validate_api_reader_source_bindings(paper)['formulaCount'], 1)

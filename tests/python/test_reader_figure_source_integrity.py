import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as publish, llm_api_ephemeral_figure_fixture, reseal_llm_api_reader_fixture


def sha(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def fixture():
    paper = llm_api_ephemeral_figure_fixture()
    paper['arxivId'] = '2609.15067'
    figure = paper['apiReaderFigures'][0]
    old_url = figure['url']
    figure['url'] = 'https://arxiv.org/html/2609.15067v1/method.png'
    figure['caption'] = 'Figure 1: Overview of the study.'
    paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old_url, figure['url'])
    artifacts = {'flattenedTextSha256': paper['sourceSha256'], 'figures': [{
        'ordinal': figure['ordinal'], 'label': figure['label'], 'caption': figure['caption'],
        'sourceDomSha256': figure['sourceDomSha256'], 'recoveryStatus': 'complete',
        'images': [{'kind': 'external_url', 'url': figure['url'], 'mediaType': 'image/png'}],
    }]}
    payload = json.dumps(artifacts, ensure_ascii=False, separators=(',', ':'))
    paper['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = sha(payload)
    paper['analysisManifest']['stages']['apiReaderArticle']['structuredArtifactsSha256'] = sha(payload)
    reseal_llm_api_reader_fixture(paper)
    return paper, payload


class ReaderFigureSourceTests(unittest.TestCase):
    def test_regular_publisher_payload_refuses_old_caption_before_rendering(self):
        paper, payload = fixture()
        paper['analysisManifest']['stages']['apiReaderArticle']['figuresSha256'] = publish._stable_json_sha256(paper['apiReaderFigures'])
        with self.assertRaisesRegex(publish.PublishDataValidationError, '旧论文图缺少'):
            publish._api_reader_payload(paper)
        paper['apiReaderPlan']['structuredSourcePayload'] = payload
        reseal_llm_api_reader_fixture(paper)
        result = publish._api_reader_payload(paper)
        self.assertEqual(result['figurePersistence'], publish.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT)
        self.assertIn(paper['apiReaderFigures'][0]['url'], result['renderedArticle'])

    def test_old_self_consistent_caption_needs_actual_source_not_boolean(self):
        paper, payload = fixture()
        for flag in (False, True):
            paper['apiReaderPlan']['figurePixelsVerified'] = flag
            reseal_llm_api_reader_fixture(paper)
            with self.assertRaisesRegex(publish.PublishDataValidationError, '旧论文图缺少'):
                publish._validate_api_reader_source_bindings(paper)
        del paper['apiReaderPlan']['figurePixelsVerified']
        paper['apiReaderPlan']['structuredSourcePayload'] = payload
        reseal_llm_api_reader_fixture(paper)
        self.assertEqual(publish._validate_api_reader_source_bindings(paper)['formulaCount'], 1)
        paper['apiReaderPlan']['structuredSourcePayload'] = payload.replace('Overview', 'Changed')
        reseal_llm_api_reader_fixture(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish._validate_api_reader_source_bindings(paper)

    def test_source_caption_ordinal_label_dom_and_text_must_match(self):
        paper, payload = fixture()
        for field in ('caption', 'ordinal', 'booleanOrdinal', 'label', 'sourceDomSha256', 'flattenedTextSha256'):
            with self.subTest(field=field):
                candidate = copy.deepcopy(paper)
                source = json.loads(payload)
                if field == 'flattenedTextSha256':
                    source[field] = '0' * 64
                elif field == 'booleanOrdinal':
                    source['figures'][0]['ordinal'] = True
                else:
                    source['figures'][0][field] = 2 if field == 'ordinal' else 'changed'
                changed = json.dumps(source, ensure_ascii=False, separators=(',', ':'))
                candidate['apiReaderPlan']['structuredSourcePayload'] = changed
                candidate['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = sha(changed)
                candidate['analysisManifest']['stages']['apiReaderArticle']['structuredArtifactsSha256'] = sha(changed)
                reseal_llm_api_reader_fixture(candidate)
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._validate_api_reader_source_bindings(candidate)

    def test_fixed_pixel_claim_rejected_but_clean_caption_keeps_existing_path(self):
        paper, _ = fixture()
        paper['arxivId'] = '2609.27195'
        figure = paper['apiReaderFigures'][0]
        old_url = figure['url']
        figure['url'] = 'https://arxiv.org/html/2609.27195v1/fig4_placement_ratio_readable.svg'
        figure['caption'] = 'Figure 3: Original caption.'
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old_url, figure['url'])
        clean = paper['apiReaderArticle']
        paper['apiReaderArticle'] += '\n\n绑定图像：四个语料的表示漂移比与任务损伤比随信噪比变化；右侧为停顿位移后的语音帧漂移随距离衰减。原 HTML 图注与像素错配。'
        reseal_llm_api_reader_fixture(paper)
        with self.assertRaisesRegex(publish.PublishDataValidationError, '无像素证据'):
            publish._validate_api_reader_source_bindings(paper)
        paper['apiReaderArticle'] = clean
        reseal_llm_api_reader_fixture(paper)
        self.assertEqual(publish._validate_api_reader_source_bindings(paper)['formulaCount'], 1)

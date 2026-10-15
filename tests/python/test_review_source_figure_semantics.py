"""Offline request capture: source numbering is explained, never an issue waiver."""
import base64
import copy
import hashlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as pub

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/blog-review-source-figure-semantics.json'
PAPERS = json.loads(FIXTURE.read_text())['papers']


@contextmanager
def sealed_excerpt(entry, *, parser='arxiv-html-dom-v4', printed_labels=True):
    """Synthetic envelope; the figure text/URLs/DOM hashes are real saved excerpts."""
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        run = '12345678-1234-4234-8234-123456789abc'
        directory = root / run / 'sources' / entry['paperId'] / 'generation-000001'
        directory.mkdir(parents=True)
        figures = [{'ordinal': f['sourceArtifactOrdinal'], 'label': f['printedLabel'],
                    'caption': ' '.join(f['sourceCaption'].split())[:1200],
                    'url': f['url'], 'sourceDomSha256': f['sourceDomSha256'],
                    'assetSha256': f['readerPixelSha256']} for f in entry['figures']]
        originals = [{**{k: f[k] for k in ('ordinal', 'label', 'caption', 'sourceDomSha256')},
                      'recoveryStatus': 'complete',
                      'images': [{'kind': 'external_url', 'url': f['url']}]} for f in figures]
        if not printed_labels:
            for original, figure in zip(originals, figures):
                original['label'] = ''
                figure['label'] = f"Figure {figure['ordinal']}"
        runtime = {'paperId': 'arxiv:' + entry['paperId'], 'textSha256': 'b' * 64,
                   'structuredArtifacts': {'parserVersion': parser, 'payloadSha256': 'a' * 64,
                       'flattenedTextSha256': 'b' * 64, 'figures': originals}}
        raw = json.dumps(runtime, ensure_ascii=False).encode()
        (directory / 'source-runtime.json').write_bytes(raw)
        manifest = json.dumps({'runtimeMetadata': {
            'responseSha256': hashlib.sha256(raw).hexdigest(), 'responseBytes': len(raw)}}).encode()
        (directory / 'source-manifest.json').write_bytes(manifest)
        for filename in ('source-runtime.json', 'source-manifest.json'):
            (directory / filename).chmod(0o600)
        proof = {'runId': run, 'sourceSha256': 'b' * 64,
                 'sourceManifestSha256': hashlib.sha256(manifest).hexdigest()}
        blocks = []
        for index in range(len(figures)):
            blocks.extend(['这是本张图的独立导读，全部科学事实仍须核对。',
                           '> **看图路径：** 1. 核对原图图例与实际坐标。',
                           *entry['articleImageAndCaptionLines'][2 * index:2 * index + 2],
                           '这是本张原图的说明，来源真实不保证任何科学主张正确。'])
        paper = {'arxivId': entry['paperId'] + 'v1', 'sourceSha256': 'b' * 64,
                 'apiReaderArticle': '\n\n'.join(blocks),
                 'apiReaderPlan': {'version': 3}, 'apiReaderFigures': figures,
                 'freshRewriteProvenance': proof,
                 'analysisManifest': {'contracts': {'apiReaderArticle': pub.LLM_API_READER_CONTRACT},
                     'freshRewriteProvenance': copy.deepcopy(proof),
                     'sourceAcquisition': {'sourceSha256': 'b' * 64, 'structuredArtifactsSha256': 'a' * 64},
                     'stages': {'apiReaderArticle': {'status': 'complete', 'figureCount': len(figures),
                         'structuredArtifactsSha256': 'a' * 64}}}}
        resign(paper)
        with mock.patch.object(pub, 'DAILY_FRESH_SOURCE_RUNS_DIR', root):
            yield paper, directory


def resign(paper):
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    paper['apiReaderArticleSha256'] = pub._javascript_string_sha256(paper['apiReaderArticle'].strip())
    paper['apiReaderPlanSha256'] = pub._reader_record_sha256(paper['apiReaderPlan'], 'fixture plan')
    stage.update(articleSha256=paper['apiReaderArticleSha256'], planSha256=paper['apiReaderPlanSha256'],
                 figuresSha256=pub._reader_record_sha256(paper['apiReaderFigures'], 'fixture figures'))


class ReviewSourceFigureSemanticsTest(unittest.TestCase):
    def test_real_three_numbering_mappings_and_author_caption_get_same_note(self):
        expected = [([1, 3, 4], ['Figure 1:', 'Figure 2:', 'Figure 3:']),
                    ([1, 2, 4], ['Figure 1:', 'Figure 3:', 'Figure 5:']),
                    ([2, 3, 1, 6], ['Figure 2:', 'Figure 3:', 'Figure 1:', 'Figure 8:'])]
        for entry, (ordinals, labels) in zip(PAPERS, expected):
            with self.subTest(paper=entry['paperId']), sealed_excerpt(entry) as (paper, _):
                before = copy.deepcopy(paper)
                note = pub._review_source_figure_semantics_note(paper)
                self.assertIn('不是博客连续自编号', note)
                self.assertIn('具体科学冲突仍须报告', note)
                self.assertEqual([f['ordinal'] for f in paper['apiReaderFigures']], ordinals)
                self.assertEqual([f['label'] for f in paper['apiReaderFigures']], labels)
                self.assertEqual(paper, before)

    def test_actual_text_and_each_image_request_keep_context_and_pixels(self):
        with sealed_excerpt(PAPERS[0]) as (paper, _):
            captured = []
            def api(prompt, **kwargs):
                captured.append((prompt, kwargs))
                return '{"passed":true,"issues":[]}'
            pixels = {'media_type': 'image/png', 'data': base64.b64encode(b'offline fixture pixels').decode()}
            with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'fixture'}), \
                    mock.patch.object(pub, 'call_llm_api', side_effect=api), \
                    mock.patch.object(pub, '_load_review_image', return_value=pixels):
                self.assertTrue(pub.llm_review_post(paper['apiReaderArticle'], 'Paper', required=True, paper=paper)[0])
                self.assertEqual(pub.multimodal_review_images(paper['apiReaderArticle'], 'Paper', required=True, paper=paper), (True, []))
            self.assertEqual(len(captured), 4)
            self.assertIn(paper['apiReaderArticle'], captured[0][0])
            for i, (prompt, kwargs) in enumerate(captured[1:]):
                self.assertIn('不是博客连续自编号', prompt)
                self.assertIn(PAPERS[0]['articleImageAndCaptionLines'][2 * i + 1], prompt)
                self.assertEqual(kwargs['images'], [pixels])
                for other in range(3):
                    if other != i:
                        self.assertNotIn(PAPERS[0]['figures'][other]['url'], prompt)

    def test_unknown_legacy_and_non_dom_sources_get_no_dom_claim(self):
        for value in (None, {}, {'analysisManifest': {'contracts': {'apiReaderArticle': 'beginner-researcher-v2'}}}):
            self.assertEqual(pub._review_source_figure_semantics_note(value), '')
        with sealed_excerpt(PAPERS[0], parser='pdf-layout-v1') as (paper, _):
            self.assertEqual(pub._review_source_figure_semantics_note(paper), '')
        with sealed_excerpt(PAPERS[0], printed_labels=False) as (paper, _):
            self.assertEqual(pub._review_source_figure_semantics_note(paper), '')

    def test_source_bytes_and_parent_cas_drift_rejected_before_model(self):
        for mutation in ('runtime', 'manifest', 'article', 'plan', 'pixels'):
            with self.subTest(mutation=mutation), sealed_excerpt(PAPERS[0]) as (paper, directory):
                if mutation in ('runtime', 'manifest'):
                    file = directory / ('source-' + mutation + '.json')
                    file.write_bytes(file.read_bytes() + b' ')
                elif mutation == 'pixels':
                    paper['apiReaderFigures'][0]['assetSha256'] = 'c' * 64
                elif mutation == 'article':
                    paper['apiReaderArticle'] += '\n改变原文'
                else:
                    paper['apiReaderPlan']['changed'] = True
                with mock.patch.object(pub, 'call_llm_api') as api:
                    with self.assertRaises(pub.PublishDataValidationError):
                        pub.multimodal_review_images(paper['apiReaderArticle'], required=True, paper=paper)
                    api.assert_not_called()

    def test_re_signed_wrong_printed_label_dom_ordinal_or_url_still_rejected(self):
        for key, value in [('label', 'Figure 999:'), ('caption', 'wrong author caption'),
                           ('ordinal', 99), ('sourceDomSha256', 'c' * 64),
                           ('url', 'https://arxiv.org/html/9999.12345/foreign.png')]:
            with self.subTest(key=key), sealed_excerpt(PAPERS[0]) as (paper, _):
                paper['apiReaderFigures'][0][key] = value
                resign(paper)  # Even consistent envelope hashes cannot invent the original source mapping.
                with self.assertRaises(pub.PublishDataValidationError):
                    pub._review_source_figure_semantics_note(paper)

    def test_printed_number_and_scientific_errors_are_never_filtered(self):
        for description in ('同一原论文图号冲突：alt Figure 2，而图注原论文 Figure 3。',
                            '本图高低频两条合成支路与正文只用低通的科学结论冲突。'):
            issue = {'severity': 'error', 'type': 'content', 'description': description,
                     'auto_fixable': False, 'fix_instruction': ''}
            with sealed_excerpt(PAPERS[0]) as (paper, _), \
                    mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'fixture'}), \
                    mock.patch.object(pub, '_load_review_image', return_value={'media_type': 'image/png', 'data': 'eA=='}), \
                    mock.patch.object(pub, 'call_llm_api', return_value=json.dumps({'passed': False, 'issues': [issue]})):
                self.assertEqual(pub.multimodal_review_images(paper['apiReaderArticle'], required=True, paper=paper), (False, [issue] * 3))
                passed, issues, unchanged = pub.llm_review_post(paper['apiReaderArticle'], required=True, paper=paper)
                self.assertFalse(passed)
                self.assertEqual(issues, [issue])
                self.assertEqual(unchanged, paper['apiReaderArticle'])

    def test_he_nac_original_abstract_caption_has_provenance_not_a_science_waiver(self):
        with sealed_excerpt(PAPERS[3]) as (paper, _):
            self.assertIn('Overall reconstruction flow', paper['apiReaderArticle'])
            note = pub._review_source_figure_semantics_note(paper)
            self.assertIn('概括性标题不要求枚举图内全部细节', note)
            self.assertIn('正文或作者图注与实际像素的具体科学冲突仍须报告', note)

    def test_text_unit_identity_explicitly_binds_note_and_empty_default_stays_empty(self):
        with sealed_excerpt(PAPERS[0]) as (paper, _):
            seen = []
            def cache(kind, payload, callback):
                seen.append((kind, payload))
                return True, []
            with mock.patch.object(pub, 'review_cached_unit', side_effect=cache):
                pub.llm_review_post(paper['apiReaderArticle'], paper=paper)
                pub.llm_review_post(paper['apiReaderArticle'])
            self.assertIn('最外层 figure DOM', seen[0][1]['sourceFigureNote'])
            self.assertEqual(seen[1][1]['sourceFigureNote'], '')


if __name__ == '__main__':
    unittest.main()

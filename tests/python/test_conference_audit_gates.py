"""Regression tests for conference audit root-cause fixes:
1. pdf_author_extract: Editors:/1. Background header cutoffs + Mode F PMLR stacked authors.
2. markdown_hugo_gate: raw non-allowlisted <tag>, leaked [[FIGURE_N]] placeholders, split-word & orphan-fragment tables.
3. publish-to-blog: pixel edge-clipping gate in multimodal_review_images.
"""

import base64
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import fitz
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import pdf_author_extract as pae  # noqa: E402
from markdown_hugo_gate import math_and_emphasis_issues  # noqa: E402


def _make_pmlr_pdf(*, grouped=False):
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((90, 90), 'Benchmarking Spoken Audio Retrieval', fontsize=16, fontname='helv')
    if grouped:
        page.insert_text((90, 145), 'Alice Smith', fontsize=11, fontname='hebo')
        page.insert_text((390, 145), 'alice@example.edu', fontsize=10, fontname='cour')
        page.insert_text((90, 162), 'Bob Chen', fontsize=11, fontname='hebo')
        page.insert_text((395, 162), 'bob@example.edu', fontsize=10, fontname='cour')
        page.insert_text((90, 178), 'Institute for Infocomm Research, Singapore', fontsize=10, fontname='heit')
    else:
        page.insert_text((90, 145), 'Alice Smith', fontsize=11, fontname='hebo')
        page.insert_text((390, 145), 'alice@example.edu', fontsize=10, fontname='cour')
        page.insert_text((90, 160), 'Department of Computer Science,', fontsize=10, fontname='heit')
        page.insert_text((90, 174), 'National University of Singapore, Singapore', fontsize=10, fontname='heit')
        page.insert_text((90, 200), 'Bob Chen', fontsize=11, fontname='hebo')
        page.insert_text((395, 200), 'bob@example.edu', fontsize=10, fontname='cour')
        page.insert_text((90, 215), 'Tokyo Metropolitan University', fontsize=10, fontname='heit')
        page.insert_text((90, 229), 'Tokyo, Japan', fontsize=10, fontname='heit')
    page.insert_text((90, 275), 'Editors: Jane Doe, John Roe', fontsize=10, fontname='hebo')
    page.insert_text((90, 310), 'Abstract', fontsize=12, fontname='hebo')
    page.insert_text((90, 330), 'This paper studies audio retrieval.', fontsize=10, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


def _make_no_abstract_background_pdf():
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((110, 75), 'Robust Audio-Visual Speech Recognition', fontsize=15, fontname='hebo')
    page.insert_text((255, 115), 'Zhaofeng Lin', fontsize=12, fontname='helv')
    page.insert_text((210, 138), 'Trinity College Dublin, Ireland', fontsize=12, fontname='helv')
    page.insert_text((260, 154), 'linzh@tcd.ie', fontsize=9, fontname='cour')
    page.insert_text((80, 215), '1. Background and Motivation', fontsize=12, fontname='hebo')
    page.insert_text((60, 236), '1.1. Audio-Visual Speech Recognition', fontsize=10, fontname='helv')
    page.insert_text((60, 252), 'Audio-visual systems exploit lip movements.', fontsize=9, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


def _png_b64(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('ascii')


class ConferenceAuditRootCauseGatesTest(unittest.TestCase):
    def test_pdf_author_extract_pmlr_per_author_and_grouped_and_background_cutoff(self):
        res_per = pae.extract_pdf_page1_authors(_make_pmlr_pdf(grouped=False), contract=pae.CONTRACT_V2)
        self.assertIsNotNone(res_per)
        self.assertEqual(res_per['mode'], 'column_blocks')
        self.assertEqual(
            res_per['authors'],
            [
                {'name': 'Alice Smith', 'affiliations': ['Department of Computer Science, National University of Singapore, Singapore']},
                {'name': 'Bob Chen', 'affiliations': ['Tokyo Metropolitan University, Tokyo, Japan']},
            ],
        )

        res_grp = pae.extract_pdf_page1_authors(_make_pmlr_pdf(grouped=True), contract=pae.CONTRACT_V2)
        self.assertIsNotNone(res_grp)
        self.assertEqual(res_grp['mode'], 'column_blocks')
        self.assertEqual(
            res_grp['authors'],
            [
                {'name': 'Alice Smith', 'affiliations': ['Institute for Infocomm Research, Singapore']},
                {'name': 'Bob Chen', 'affiliations': ['Institute for Infocomm Research, Singapore']},
            ],
        )

        res_bg = pae.extract_pdf_page1_authors(_make_no_abstract_background_pdf(), contract=pae.CONTRACT_V2)
        self.assertIsNotNone(res_bg)
        self.assertEqual(res_bg['mode'], 'single_institution')
        self.assertEqual(
            res_bg['authors'],
            [{'name': 'Zhaofeng Lin', 'affiliations': ['Trinity College Dublin, Ireland']}],
        )

    def test_markdown_hugo_gate_rejects_raw_tags_placeholders_and_split_tables(self):
        # Raw non-allowlisted HTML tags must fail
        issues_tag = math_and_emphasis_issues('模型引入 <sc> 与 <interrupt> 特殊标记。', 'p.md')
        self.assertTrue(any('裸尖括号标签' in i and '<sc>' in i for i in issues_tag), issues_tag)

        # Backticked tags, autolinks, allowed tags, and math comparisons must pass
        ok_text = (
            '模型引入 `<sc>` 与 `<interrupt>`，参考 <https://example.org> 见上标<sup>1</sup>'
            '，且满足 \\(a < b\\) 与 <!-- comment -->。'
        )
        self.assertEqual(math_and_emphasis_issues(ok_text, 'ok.md'), [])

        # Leaked placeholder must fail
        issues_ph = math_and_emphasis_issues('见下文 [[FIGURE_1]] 所示。', 'p.md')
        self.assertTrue(any('[[FIGURE_1]]' in i for i in issues_ph), issues_ph)

        # Split-word table row must fail
        split_tbl = (
            '| Split | Description | Count |\n'
            '| --- | --- | --- |\n'
            '| Train | Single speaker, quiet en- | 120 |\n'
            '| | vironment. | |\n'
        )
        issues_split = math_and_emphasis_issues(split_tbl, 'p.md')
        self.assertTrue(any('跨行断词残片' in i for i in issues_split), issues_split)

        # Orphan single-fragment first row must fail
        orphan_tbl = (
            '| ColA | ColB | ColC |\n'
            '| --- | --- | --- |\n'
            '| | | ments |\n'
            '| A | B | 10 |\n'
        )
        issues_orphan = math_and_emphasis_issues(orphan_tbl, 'p.md')
        self.assertTrue(any('断行残片' in i for i in issues_orphan), issues_orphan)

        # Normal table with multi-column values passes
        good_tbl = (
            '| Model | Emotion | Example |\n'
            '| --- | --- | --- |\n'
            '| | happiness | Please help me. |\n'
            '| Base | neutral | Hello world. |\n'
        )
        self.assertEqual(math_and_emphasis_issues(good_tbl, 'ok.md'), [])

        # R/ANOVA significance stars in tables and prose pass in both Markdown and rendered HTML
        sig_md = (
            '| Term | p-value |\n'
            '| --- | --- |\n'
            '| A | 0.0083780 ** |\n'
            '| B | < 2.2e-16 *** |\n\n'
            '显著性标注 **** p < .0001 或 ** p < .01。\n'
        )
        self.assertEqual(math_and_emphasis_issues(sig_md, 'sig.md'), [])
        sig_html = (
            '<table><tr><td>A</td><td>0.0083780 **</td></tr>'
            '<tr><td>B</td><td>&lt; 2.2e-16 ***</td></tr></table>'
            '<p>显著性标注 **** p &lt; .0001 或 ** p &lt; .01。</p>'
        )
        self.assertEqual(math_and_emphasis_issues(sig_html, 'sig.html', rendered_html=True), [])
        # Genuine unpaired bold still fails in both modes
        self.assertTrue(any('未配对' in i for i in math_and_emphasis_issues('**未闭合加粗', 'bad.md')))
        self.assertTrue(any('未配对' in i for i in math_and_emphasis_issues('<p>**未闭合加粗</p>', 'bad.html', rendered_html=True)))

    def test_pixel_edge_clipping_gate_blocks_chopped_figures_and_allows_clean_or_fullbleed(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('publish_to_blog_mod', SCRIPTS / 'publish-to-blog.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        # 1. Top-chopped figure (dark bar slicing through top edge, white left/right margins)
        chopped = Image.new('RGB', (400, 120), 'white')
        draw = ImageDraw.Draw(chopped)
        draw.rectangle([40, 0, 360, 40], fill=(30, 30, 30))
        chopped_b64 = _png_b64(chopped)

        # 2. Clean intact figure with white margins on all sides
        clean = Image.new('RGB', (400, 200), 'white')
        ImageDraw.Draw(clean).rectangle([40, 20, 360, 180], outline=(20, 20, 20), width=2)
        clean_b64 = _png_b64(clean)

        # 3. Full-bleed spectrogram (dark pixels along all 4 sides)
        fullbleed = Image.new('RGB', (400, 200), (20, 30, 80))
        fullbleed_b64 = _png_b64(fullbleed)

        url = 'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/test-2026/abc/figure-1.png'
        body = f'![原论文 Figure 1: Demo]({url})'
        llm_calls = []

        def fake_llm(*args, **kwargs):
            llm_calls.append(args)
            return json.dumps({'passed': True, 'issues': []})

        with patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'unit-test-model'}), \
                patch.object(mod, 'call_llm_api', side_effect=fake_llm), \
                patch.object(mod, 'review_cached_unit', side_effect=lambda _k, _i, fn: fn()):
            # Chopped figure MUST fail deterministically before LLM call
            with patch.object(mod, '_load_review_image', return_value={'media_type': 'image/png', 'data': chopped_b64}):
                passed, issues = mod.multimodal_review_images(body, 'Test', required=True)
            self.assertFalse(passed)
            self.assertTrue(any('疑似裁切残缺' in str(i.get('description', '')) for i in issues), issues)
            self.assertEqual(len(llm_calls), 0)

            # Clean figure passes pixel gate and reaches LLM
            with patch.object(mod, '_load_review_image', return_value={'media_type': 'image/png', 'data': clean_b64}):
                passed, issues = mod.multimodal_review_images(body, 'Test', required=True)
            self.assertTrue(passed, issues)
            self.assertEqual(len(llm_calls), 1)

            # Full-bleed spectrogram passes pixel gate and reaches LLM
            with patch.object(mod, '_load_review_image', return_value={'media_type': 'image/png', 'data': fullbleed_b64}):
                passed, issues = mod.multimodal_review_images(body, 'Test', required=True)
            self.assertTrue(passed, issues)
            self.assertEqual(len(llm_calls), 2)


if __name__ == '__main__':
    unittest.main()

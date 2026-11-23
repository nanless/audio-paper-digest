"""Wave 4 行为回归测试：覆盖 D-C1/H1..H6/M1..M6/L1..L3、F-P0-3、B-H5(Py) 与 B-L2(Py)。"""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import blog_git_publication
import conference_extractor
import conference_publication_gate as conf_gate
import markdown_hugo_gate as hugo_gate
import paper_reader_presentation as presentation
import protocol_codec as protocols
import publish_common
import reader_inline_svg
import reader_pdf_page_asset
import reader_sealed_pdf_quote_evidence as pdf_quote
import tag_catalog
import utils as py_utils


def load_module(name, rel_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PUB = load_module('wave4_publish_to_blog', 'scripts/publish-to-blog.py')
CONF_RENDER = load_module('wave4_conf_render', 'scripts/conference-page-render.py')
PUB_CONF = load_module('wave4_pub_conf', 'scripts/publish-conference.py')
HIST_REVIEW = load_module('wave4_hist_review', 'scripts/historical-direct-review.py')

MINIMAL_PNG = (
    b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
    b'\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0'
    b'\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82'
)


def _js_core_summary_issue(summary, source_text=''):
    code = (
        "const c = require('./scripts/analysis-contract');"
        "const [summary, sourceText] = JSON.parse(process.argv[1]);"
        "const analysis = '## 核心摘要\\n\\n' + summary + '\\n';"
        "console.log(JSON.stringify(c.validateCoreSummarySemanticContract(analysis, { sourceText })));"
    )
    proc = subprocess.run(
        ['node', '-e', code, json.dumps([summary, source_text])],
        cwd=ROOT, capture_output=True, text=True, check=True, timeout=30,
    )
    return json.loads(proc.stdout)


def _js_experiment_issue(analysis, source_text=''):
    code = (
        "const c = require('./scripts/analysis-contract');"
        "const [analysis, sourceText] = JSON.parse(process.argv[1]);"
        "console.log(JSON.stringify(c.validateExperimentTableContract(analysis, { "
        "contractVersion: c.EXPERIMENT_TABLE_CONTRACT_VERSION, sourceText, documentType: '实证研究' })));"
    )
    proc = subprocess.run(
        ['node', '-e', code, json.dumps([analysis, source_text])],
        cwd=ROOT, capture_output=True, text=True, check=True, timeout=30,
    )
    return json.loads(proc.stdout)


class Wave4PublishRegressionsTest(unittest.TestCase):
    def test_d_c1_inline_svg_blocks_directives_and_html5_breakout_tags_and_uses_offline_context(self):
        cdata_svg = (
            '<svg id="f1" width="100" height="50" viewBox="0 0 100 50">'
            '<text><![CDATA[<img src=x onerror=alert(1)>]]></text></svg>'
        ).encode('utf-8')
        comment_svg = (
            '<svg id="f1" width="100" height="50" viewBox="0 0 100 50">'
            '<!-- <script>alert(1)</script> --><text>ok</text></svg>'
        ).encode('utf-8')
        element_decl_svg = (
            '<!ELEMENT foo EMPTY><svg id="f1" width="100" height="50" viewBox="0 0 100 50">'
            '<text>ok</text></svg>'
        ).encode('utf-8')
        for payload in (cdata_svg, comment_svg, element_decl_svg):
            with self.assertRaises(ValueError):
                reader_inline_svg.validate_svg(payload)
            with self.assertRaises(ValueError):
                reader_inline_svg.source_descriptor({
                    'kind': 'inline_svg',
                    'mediaType': 'image/svg+xml',
                    'inlineSvg': payload.decode('utf-8'),
                    'inlineSvgBytes': len(payload),
                    'inlineSvgSha256': hashlib.sha256(payload).hexdigest(),
                }, '2611.00001')

        # HTML5 §13.2.6.5 breakout tags directly inside <svg> (outside <foreignObject>) must be rejected
        for tag in ('p', 'div', 'span', 'b', 'strong', 'i', 'em', 'sub', 'sup', 'br'):
            body = f'<{tag}/>' if tag == 'br' else f'<{tag} style="position:fixed">hi</{tag}>'
            breakout = (
                f'<svg id="f1" width="100" height="50" viewBox="0 0 100 50">{body}</svg>'
            ).encode('utf-8')
            with self.subTest(breakout_tag=tag), self.assertRaises(ValueError):
                reader_inline_svg.validate_svg(breakout)

        good = (
            '<svg id="f1" width="100" height="50" viewBox="0 0 100 50">'
            '<foreignObject width="100" height="50"><span>a<br/>b</span></foreignObject>'
            '</svg>'
        ).encode('utf-8')
        validated = reader_inline_svg.validate_svg(good)
        canonical = reader_inline_svg._serialize_validated_svg(ET.fromstring(validated))
        self.assertIn('xmlns="http://www.w3.org/2000/svg"', canonical)
        self.assertIn('<span>a<br>b</span>', canonical)
        self.assertNotIn('<![CDATA[', canonical)

        # Confirm render_svg passes offline=True to browser.new_context and feeds canonical markup
        captured = {}

        class FakeLocator:
            def count(self):
                return 1
            def bounding_box(self):
                return {'x': 0, 'y': 0, 'width': 100, 'height': 50}
            def evaluate(self, _fn, *_args):
                return {'left': 0, 'top': 0, 'right': 100, 'bottom': 50}

        class FakePage:
            def route(self, _pattern, _handler):
                pass
            def set_content(self, markup, **_kw):
                captured['markup'] = markup
            def locator(self, _sel):
                return FakeLocator()
            def evaluate(self, _fn):
                return {'x': 0, 'y': 0, 'width': 100, 'height': 50, 'forbidden': []}
            def screenshot(self, **_kw):
                return MINIMAL_PNG

        class FakeContext:
            def new_page(self):
                return FakePage()
            def close(self):
                pass

        class FakeBrowser:
            def new_context(self, **kwargs):
                captured['context_kwargs'] = kwargs
                return FakeContext()
            def close(self):
                pass

        class FakePlaywright:
            class chromium:
                executable_path = sys.executable

                @staticmethod
                def launch(**_kw):
                    return FakeBrowser()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        fake_pw_mod = SimpleNamespace(sync_playwright=lambda: FakePlaywright())
        with mock.patch.dict(sys.modules, {'playwright': SimpleNamespace(sync_api=fake_pw_mod), 'playwright.sync_api': fake_pw_mod}):
            png = reader_inline_svg.render_svg(good)
        self.assertEqual(png, MINIMAL_PNG)
        self.assertTrue(captured['context_kwargs'].get('offline'))
        self.assertIn(canonical, captured['markup'])

    def test_d_h1_experiment_depth_js_python_parity_including_turkish_i_and_measured_fails(self):
        base_analysis = (
            '## 实验结果\n\n'
            '为检验本方法相对强基线的有效性与边界，我们在公开基准上展开系统对照测试。\n\n'
            '| 模型 | 准确率 (%) ↑ | WER (%) ↓ |\n| --- | --- | --- |\n'
            '| Baseline-1 | 75.0 | 9.4 |\n'
            '| Baseline-2 | 78.2 | 8.1 |\n'
            '| Proposed | 82.4 | 6.3 |\n\n'
            '相比 Baseline-2，Proposed 在公开基准上提升 4.2 分，但在极低信噪比条件下该结论仍受训练语料分布边界约束，不宜直接外推至未知噪声域。\n'
        )
        # Every case must match JS analysis-contract.js exactly (both pass/fail parity)
        cases = [
            ('no_ablation', 'Compared to the strong baseline (78.2), our method reaches 82.4. No component ablations were conducted in this study.', False),
            ('attack_metric_def', 'Compared to the baseline (78.2), our method achieves 82.4. Refusal by the target platform is counted as an attack failure. Future experiments should examine whether performance degrades under extreme reverberation.', False),
            ('measured_fails_if', 'Compared to the baseline (78.2), our method reaches 82.4. Our experiments show that the model fails if SNR < 0.', True),
            ('measured_fails_to', 'Compared to the baseline (78.2), our method reaches 82.4. Our model fails to converge on long clips.', True),
            ('turkish_dotted_I', 'Compared to the baseline (78.2), our method reaches 82.4. On İstanbul recordings, our model degrades sharply.', True),
            ('turkish_dotless_i', 'Compared to the baseline (78.2), our method reaches 82.4. On Diyarbakır speech, our model degrades sharply.', True),
        ]
        for label, src_text, expect_reject in cases:
            with self.subTest(case=label):
                py_issue = publish_common.validate_experiment_table_contract(
                    base_analysis,
                    contract_version=publish_common.EXPERIMENT_TABLE_CONTRACT_VERSION,
                    source_text=src_text, document_type='实证研究',
                )
                js_issue = _js_experiment_issue(base_analysis, src_text)
                self.assertEqual(py_issue is not None, expect_reject, f'py={py_issue}')
                self.assertEqual(js_issue is not None, expect_reject, f'js={js_issue}')

        overfit_analysis = base_analysis.replace(
            '不宜直接外推至未知噪声域。',
            '在跨域子集上出现了明显的域过拟合，不宜直接外推至未知噪声域。',
        )
        negative_src = 'Compared to the baseline (78.2), our method reaches 82.4, but degrades noticeably on out-of-domain noisy speech.'
        self.assertIsNone(publish_common.validate_experiment_table_contract(
            overfit_analysis,
            contract_version=publish_common.EXPERIMENT_TABLE_CONTRACT_VERSION,
            source_text=negative_src, document_type='实证研究',
        ))

    def test_d_h2_v4_figure_caption_alignment_including_trailing_dot_and_appendix_labels(self):
        v4_md = (
            '![原论文 Figure 1：Cost is $5 per hour](https://arxiv.org/html/2611.00001v1/f1.png)\n\n'
            '*论文图 1：Cost is $5 per hour（原论文 Figure 1）。*\n'
        )
        escaped = publish_common.escape_literal_source_figure_caption_dollars(v4_md)
        self.assertIn(r'Cost is \$5 per hour（原论文 Figure 1）。*', escaped)
        self.assertIn(r'![原论文 Figure 1：Cost is \$5 per hour]', escaped)

        # Figure 1. trailing dot in alt (as emitted by readerFigureAlt) + Appendix label Figure A.1
        v4_dot_md = (
            '![原论文 Figure 1.：Cost is $5 per hour](https://arxiv.org/html/2611.00001v1/f1.png)\n\n'
            '*论文图 1：Cost is $5 per hour（原论文 Figure 1）。*\n'
        )
        escaped_dot = publish_common.escape_literal_source_figure_caption_dollars(v4_dot_md)
        self.assertIn(r'Cost is \$5 per hour（原论文 Figure 1）。*', escaped_dot)
        self.assertIn(r'![原论文 Figure 1.：Cost is \$5 per hour]', escaped_dot)

        v4_appendix_md = (
            '![原论文 Figure A.1：Budget $10 per run](https://arxiv.org/html/2611.00001v1/fa1.png)\n\n'
            '*论文图 2：Budget $10 per run（原论文 Figure A.1）。*\n'
        )
        escaped_app = publish_common.escape_literal_source_figure_caption_dollars(v4_appendix_md)
        self.assertIn(r'Budget \$10 per run（原论文 Figure A.1）。*', escaped_app)
        self.assertIn(r'![原论文 Figure A.1：Budget \$10 per run]', escaped_app)

        # 旧版带尾随句点图注 `Figure 1.：“...$5...”。*` 与附录 `Figure A.1.：“...$5...”。*`
        legacy_dot_md = (
            '![原论文 Figure 1.：Cost is $5 per hour](https://arxiv.org/html/2611.00001v1/f1.png)\n\n'
            '*论文图 1。原论文 Figure 1.：“Cost is $5 per hour”。*\n'
        )
        escaped_legacy_dot = publish_common.escape_literal_source_figure_caption_dollars(legacy_dot_md)
        self.assertIn(r'*论文图 1。原论文 Figure 1.：“Cost is \$5 per hour”。*', escaped_legacy_dot)
        self.assertIn(r'![原论文 Figure 1.：Cost is \$5 per hour]', escaped_legacy_dot)

        v4_gloss = '*论文图 2：Phoneme [a](“ah”) contour（原论文 Figure 2）。*'
        repaired_v4_gloss = CONF_RENDER.repair_formula_delimiters(v4_gloss)
        self.assertIn('&#91;a&#93;(“ah”)', repaired_v4_gloss)
        self.assertTrue(repaired_v4_gloss.startswith('*论文图 2：'))

        v4_stars = '*论文图 2：Significance p*** on test set（原论文 Figure 2）。*'
        repaired_v4_stars = CONF_RENDER.repair_formula_delimiters(v4_stars)
        self.assertIn('三个星号', repaired_v4_stars)
        self.assertTrue(repaired_v4_stars.startswith('*论文图 2：'))

        fig = {
            'ordinal': 1,
            'label': 'Figure 1:',
            'caption': 'Figure 1: Token <EOS.> triggers termination.',
            'url': 'https://arxiv.org/html/2611.00001v1/f1.png',
        }
        img = '![原论文 Figure 1：Token <EOS.> triggers termination](https://arxiv.org/html/2611.00001v1/f1.png)'
        note = '*论文图 1：Token <EOS.> triggers termination（原论文 Figure 1）。*'
        new_img, new_note = PUB._source_bound_figure_literal_tokens(img, note, fig)
        self.assertIn('`<EOS.>`', new_img)
        self.assertIn('`<EOS.>`', new_note)

    def test_d_h3_index_figure_preview_accepts_limited_and_damaged_pdf_page_labels(self):
        pixel_sha = hashlib.sha256(MINIMAL_PNG).hexdigest()
        source_url = 'https://arxiv.org/html/2611.00001v1/f1.png'
        destination = f'static/images/papers/2611.00001/figure-1-{pixel_sha[:16]}.png'
        public_url = f'{PUB.BASE_PATH.rstrip("/")}/images/papers/2611.00001/figure-1-{pixel_sha[:16]}.png'
        figure = {'ordinal': 1, 'url': source_url, 'assetSha256': pixel_sha}
        paper = {'arxivId': '2611.00001v1', 'apiReaderFigures': [figure]}
        article = f'![原论文 Figure 1：示例]({source_url})\n'

        for valid_label in (
            '原论文 PDF 第 3 页（含图 1）',
            '原论文 PDF 第 3 页（含图 A.1；图注未完整抽取，以原页为准）',
            '原论文 PDF 第 4 页（含图 2；原官方 PNG 文件截断，独立出版展示）',
        ):
            asset = {
                'sourceUrl': source_url,
                'generatedBytes': MINIMAL_PNG,
                'sha256': pixel_sha,
                'destination': destination,
                'publicUrl': public_url,
                'derivedAssetProof': {'displayLabel': valid_label},
            }
            api_reader = {'figures': [figure], 'assets': [asset]}
            with mock.patch.object(PUB, '_publication_raster_recovery_target', return_value={'kind': 'damaged'}), \
                    mock.patch.object(PUB, '_api_reader_payload', return_value=api_reader):
                preview = PUB._index_figure_preview(paper, article, api_reader=api_reader)
            self.assertIn(public_url, preview)
            self.assertIn(valid_label, preview)

        bad_asset = {
            'sourceUrl': source_url,
            'generatedBytes': MINIMAL_PNG,
            'sha256': pixel_sha,
            'destination': destination,
            'publicUrl': public_url,
            'derivedAssetProof': {'displayLabel': '原论文 PDF 第 3 页（含图 1；随意后缀）'},
        }
        bad_reader = {'figures': [figure], 'assets': [bad_asset]}
        with mock.patch.object(PUB, '_publication_raster_recovery_target', return_value={'kind': 'damaged'}), \
                mock.patch.object(PUB, '_api_reader_payload', return_value=bad_reader):
            with self.assertRaises(PUB.PublishDataValidationError):
                PUB._index_figure_preview(paper, article, api_reader=bad_reader)

    def test_d_h4_api_reader_page_binding_rejects_metadata_spoof_and_section_injection_and_preserves_numbered_bold(self):
        # 构造可通过 _api_reader_page_binding_issue 的真实集成 Reader 论文与页面（含编号粗体行）
        from test_publish_to_blog import (
            llm_api_publication_fixture,
            publish_to_blog as publisher,
            reseal_llm_api_reader_fixture,
        )
        paper = llm_api_publication_fixture()
        numbered_line = '1. **编码器特征提取步骤**'
        paper['apiReaderArticle'] = paper['apiReaderArticle'].rstrip() + f'\n\n{numbered_line}'
        reseal_llm_api_reader_fixture(paper)
        page_md, _ = publisher.generate_paper_page(paper, '2026-11-20')
        self.assertIn(numbered_line, page_md)
        self.assertIsNone(publisher._api_reader_page_binding_issue(page_md, paper))

        # Bypass A: 篡改 <details> 论文与评分元数据中的任意内容必须被拒
        spoofed_details = page_md.replace(
            '<summary>📎 论文与评分元数据</summary>\n\n',
            '<summary>📎 论文与评分元数据</summary>\n\n伪造的额外结论段落。\n\n',
            1,
        )
        self.assertIsNotNone(publisher._api_reader_page_binding_issue(spoofed_details, paper))

        # Bypass B: 在深度解读后注入任意 ## 伪造章节必须被拒
        injected_section = page_md.replace(
            '\n<details>\n<summary>📎 论文与评分元数据</summary>',
            '\n## 伪造结论\n\n任意编造内容。\n\n<details>\n<summary>📎 论文与评分元数据</summary>',
            1,
        )
        self.assertIsNotNone(publisher._api_reader_page_binding_issue(injected_section, paper))

        # Bypass C: 在页尾 --- 之后追加未授权内容必须被拒
        injected_footer = page_md.rstrip() + '\n\n未经审查的尾注文本。\n'
        self.assertIsNotNone(publisher._api_reader_page_binding_issue(injected_footer, paper))

        # CommonMark §4.5 & §2.1: 直接单元测试 _find_outside_fence_heading 边界
        heading_pat = r'##\s+🧭\s*深度解读\s*'
        self.assertIsNotNone(publisher._find_outside_fence_heading(
            '```pip install pkg``` 检查。\n## 🧭 深度解读', heading_pat,
        ))
        self.assertIsNotNone(publisher._find_outside_fence_heading(
            '```foo`bar\n## 🧭 深度解读\n', heading_pat,
        ))
        self.assertIsNone(publisher._find_outside_fence_heading(
            '~~~`foo\n## 🧭 深度解读\n~~~\n', heading_pat,
        ))
        self.assertIsNotNone(publisher._find_outside_fence_heading(
            '\t```\n## 🧭 深度解读\n', heading_pat,
        ))
        self.assertIsNone(publisher._find_outside_fence_heading(
            '```\r## 🧭 深度解读\n', heading_pat,
        ))
        self.assertIsNone(publisher._find_outside_fence_heading(
            '```\nbody\n```\u00a0\n## 🧭 深度解读\n', heading_pat,
        ))
        fenced_then_real = '   ```\r\n## 🧭 深度解读\r\n   ``` \t \r\n## 🧭 深度解读'
        span = publisher._find_outside_fence_heading(fenced_then_real, heading_pat)
        self.assertIsNotNone(span)
        self.assertEqual(fenced_then_real[span[0]:span[1]], '## 🧭 深度解读')
        self.assertGreater(span[0], fenced_then_real.index('``` \t '))

        # 端到端集成测试：把行首 ```pip install pkg``` 放在 ## 👥 作者与机构 之前，确保穿过全部前置检查并真正抵达 _find_outside_fence_heading 返回 None
        page_ticks = page_md.replace(
            '## 👥 作者与机构',
            '```pip install pkg``` 可用于本地复现检查。\n\n## 👥 作者与机构',
            1,
        )
        self.assertIn('```pip install pkg```', page_ticks)
        self.assertIsNone(publisher._api_reader_page_binding_issue(page_ticks, paper))

        # Conference page render & gate: 链接图（不同 URL）、f[k](t) + 未配对 [、空 ]() 回归测试
        import conference_publication_gate as conf_gate
        distinct_linked = '[![Figure 1: Range [0, 1)](/images/f1.png)](https://example.org/paper)'
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(distinct_linked),
            r'[![Figure 1: Range \[0, 1)](/images/f1.png)](https://example.org/paper)',
        )
        fk_unpaired = '![Figure 1: f[k](t) over [0, 1)](https://example.org/f1.png)'
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(fk_unpaired),
            r'![Figure 1: f\[k\](t) over \[0, 1)](https://example.org/f1.png)',
        )
        fk_linked = '[![Figure 1: f[k](t) over [0, 1)](https://example.org/f1.png)](https://example.org/f1.png)'
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(fk_linked),
            r'[![Figure 1: f\[k\](t) over \[0, 1)](https://example.org/f1.png)](https://example.org/f1.png)',
        )
        empty_parens = '![Figure 1: empty ]() and [a]](https://example.org/f1.png)'
        repaired_empty = CONF_RENDER.repair_formula_delimiters(empty_parens)
        self.assertEqual(
            repaired_empty,
            r'![Figure 1: empty \]() and \[a\]](https://example.org/f1.png)',
        )
        # R8: 未修复的 `]()` 在 CommonMark/publish_common 下是非法空 URL 图片，修复后才由 _iter_markdown_images 命中
        self.assertEqual(list(conf_gate._iter_markdown_images(empty_parens)), [])
        imgs = list(conf_gate._iter_markdown_images(repaired_empty))
        self.assertEqual(len(imgs), 1)
        self.assertEqual(imgs[0][2], 'https://example.org/f1.png')

        # R5: 链接图图注末尾带 [k](t) / [p](‘beat’) 形成 3 段链接链，以及未配对 [ 前含小数/点分记号 f[k](0.5) / f[k](t.1) / f[k](Sec.A)
        for raw, expected, expected_dest in [
            (
                '[![Figure 1: loss f[k](t)](https://example.org/f1.png)](https://example.org/f1.png)',
                r'[![Figure 1: loss f\[k\](t)](https://example.org/f1.png)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: pitch [p](‘beat’)](https://example.org/f1.png)](https://example.org/f1.png)',
                r'[![Figure 1: pitch \[p\](‘beat’)](https://example.org/f1.png)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: range [0, 1) and f[k](t)](/images/f1.png)](https://example.org/paper)',
                r'[![Figure 1: range \[0, 1) and f\[k\](t)](/images/f1.png)](https://example.org/paper)',
                '/images/f1.png',
            ),
            (
                '![Figure 1: f[k](0.5) over [0, 1)](https://example.org/f1.png)',
                r'![Figure 1: f\[k\](0.5) over \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: f[k](t.1) over [0, 1)](https://example.org/f1.png)',
                r'![Figure 1: f\[k\](t.1) over \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: f[k](Sec.A) over [0, 1)](https://example.org/f1.png)',
                r'![Figure 1: f\[k\](Sec.A) over \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            # R6: 引用链接图、外层非 URL 链接、裸 scheme、以及含斜杠比值/单位（1/2, t/T, dB/Hz, N/A）
            (
                '[![Figure 1: loss f[k](t)](https://example.org/f1.png)][ref]',
                r'[![Figure 1: loss f\[k\](t)](https://example.org/f1.png)][ref]',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: [see [ref](https://example.org/r)](note) overview](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: \[see \[ref\](https://example.org/r)\](note) overview](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '![Fig 1: f[k](https://) over [0, 1)](https://example.org/f1.png)',
                r'![Fig 1: f\[k\](https://) over \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: f[k](1/2) and [x](t/T) and [dB](dB/Hz) and [y](N/A) over [0, 1)](https://example.org/f1.png)',
                r'![Figure 1: f\[k\](1/2) and \[x\](t/T) and \[dB\](dB/Hz) and \[y\](N/A) over \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            # R7: 平衡引用/嵌套链接图含 URL/锚点、同行复合链接不劫持、Payne 字面 `![` 韵律图注、以及双反斜杠 `\\![` 真实图片
            (
                '[![Figure 1: see [k](https://example.org/a)](https://example.org/f1.png)][ref]',
                r'[![Figure 1: see \[k\](https://example.org/a)](https://example.org/f1.png)][ref]',
                'https://example.org/f1.png',
            ),
            (
                '[Note: [![Figure 1: see [k](/a)](https://example.org/f1.png)]]',
                r'[Note: [![Figure 1: see \[k\](/a)](https://example.org/f1.png)]]',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: [see [ref](https://example.org/r)](#sec-1) overview](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: \[see \[ref\](https://example.org/r)\](#sec-1) overview](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: Range [0, 1)](https://example.org/f1.png) and [link](https://example.org/doc)](https://example.org/paper)',
                r'[![Figure 1: Range \[0, 1)](https://example.org/f1.png) and [link](https://example.org/doc)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: Range [0, 1)](https://example.org/f1.png)][ref] and [see [a](https://example.org/a)](https://example.org/b)',
                r'[![Figure 1: Range \[0, 1)](https://example.org/f1.png)][ref] and [see [a](https://example.org/a)](https://example.org/b)',
                'https://example.org/f1.png',
            ),
            (
                '[![原论文 Figure 1：FALL: ![e me](/images/f1.png)](https://example.org/paper)',
                r'[![原论文 Figure 1：FALL: !\[e me](/images/f1.png)](https://example.org/paper)',
                '/images/f1.png',
            ),
            (
                '[![原论文 Figure 1：FALL: ![e me](https://example.org/f1.png)](https://example.org/f1.png)',
                r'[![原论文 Figure 1：FALL: !\[e me](https://example.org/f1.png)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![Range [0, 1) see [k](https://example.org/a)](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Range \[0, 1) see \[k\](https://example.org/a)](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                r'\\![Figure 1: real [a]](https://example.org/f1.png)',
                r'\\![Figure 1: real \[a\]](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            # R8: 完整覆盖 R7 Issues 1-4 的所有对抗用例（含代码段/括号URL/可选标题/尖括号URL/前置未配对括号/复合外链/Payne 韵律）
            (
                '![See [k](https://example.org/a) over [0, 1)](https://example.org/f1.png)',
                r'![See \[k\](https://example.org/a) over \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![See [k](https://example.org/a) over [0, 1)](https://example.org/f1.png)](https://example.org/paper)',
                r'[![See \[k\](https://example.org/a) over \[0, 1)](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: see [a](https://example.org/a) and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: see \[a\](https://example.org/a) and FALL: !\[e me](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                'FALL: ![e me — ![Figure 1: [a]](https://example.org/f1.png)',
                r'FALL: ![e me — ![Figure 1: \[a\]](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: [0, 1) and [2, 3)](https://example.org/f1.png) vs (0, 1] and [see](https://example.org/doc)',
                r'![Figure 1: \[0, 1) and \[2, 3)](https://example.org/f1.png) vs (0, 1] and [see](https://example.org/doc)',
                'https://example.org/f1.png',
            ),
            (
                '[Click ![Range [0, 1)](https://example.org/f1.png)](https://example.org/paper)',
                r'[Click ![Range \[0, 1)](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[[![Figure 1: Range [0, 1)](https://example.org/f1.png)](https://example.org/p1)](https://example.org/outer)',
                r'[[![Figure 1: Range \[0, 1)](https://example.org/f1.png)](https://example.org/p1)](https://example.org/outer)',
                'https://example.org/f1.png',
            ),
            (
                '[Note: [![Fig 1: [0, 1)](https://example.org/f1.png)](https://example.org/p1)][ref]',
                r'[Note: [![Fig 1: \[0, 1)](https://example.org/f1.png)](https://example.org/p1)][ref]',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: left [0, 1)](https://example.org/f1.png)](https://example.org/p1) vs right (0, 1]',
                r'[![Figure 1: left \[0, 1)](https://example.org/f1.png)](https://example.org/p1) vs right (0, 1]',
                'https://example.org/f1.png',
            ),
            (
                'Interval [0, 1) shown in [![Figure 1: see [k](https://example.org/a)](https://example.org/f1.png) caption](https://example.org/paper)',
                r'Interval [0, 1) shown in [![Figure 1: see \[k\](https://example.org/a)](https://example.org/f1.png) caption](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                'Interval [0, 1) shown in [![Figure 1: see [k](https://example.org/a)](https://example.org/f1.png)](https://example.org/paper "Title")',
                r'Interval [0, 1) shown in [![Figure 1: see \[k\](https://example.org/a)](https://example.org/f1.png)](https://example.org/paper "Title")',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: slice `[0, 1)`](https://example.org/f1.png)',
                '![Figure 1: slice `[0, 1)`](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: syntax `](https://example.org/bad.png)` and [a]](https://example.org/f1.png)',
                r'![Figure 1: syntax `](https://example.org/bad.png)` and \[a\]](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1](https://example.org/fig_(1).png)',
                '![Figure 1](https://example.org/fig_(1).png)',
                'https://example.org/fig_(1).png',
            ),
            (
                '[![Figure 1: [0, 1)](fig_(1).png)](https://example.org/paper)',
                r'[![Figure 1: \[0, 1)](fig_(1).png)](https://example.org/paper)',
                'fig_(1).png',
            ),
            (
                '[![Figure 1: Range [0, 1)](https://example.org/f1.png "Figure 1")](https://example.org/paper)',
                r'[![Figure 1: Range \[0, 1)](https://example.org/f1.png "Figure 1")](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: f[k](t) over [0, 1)](https://example.org/f1.png "Figure 1")',
                r'![Figure 1: f\[k\](t) over \[0, 1)](https://example.org/f1.png "Figure 1")',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1]( https://example.org/f1.png )',
                '![Figure 1]( https://example.org/f1.png )',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1](<https://example.org/f1.png>)',
                '![Figure 1](<https://example.org/f1.png>)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1](https://example.org/f1.png "Panel (a) $x$")',
                '![Figure 1](https://example.org/f1.png "Panel (a) $x$")',
                'https://example.org/f1.png',
            ),
            # R9: 完整覆盖 R8 Issues 1-5（未闭合多反引号、非链接括号、尖括号含空格URL、Payne+区间、多图复合外链、![FALL]不劫持、多形态未配对]）
            (
                '![Figure 1: `` and `[0, 1)`](https://example.org/f1.png)',
                '![Figure 1: `` and `[0, 1)`](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: ``` and ``[0, 1)``](https://example.org/f1.png)',
                '![Figure 1: ``` and ``[0, 1)``](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                'Text [x](see ![Figure 1: f[k] = 0](https://example.org/f1.png))',
                r'Text [x](see ![Figure 1: f\[k\] = 0](https://example.org/f1.png))',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: range [0, 1)](<https://example.org/fig 1.png>)',
                r'![Figure 1: range \[0, 1)](<https://example.org/fig 1.png>)',
                'https://example.org/fig 1.png',
            ),
            (
                '[![Figure 1: FALL: ![e me and [0, 1)](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: FALL: !\[e me and \[0, 1)](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: see [a](https://example.org/a)](https://example.org/f1.png)',
                r'[![Figure 1: see \[a\](https://example.org/a)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[Note: [![Fig 1: [0, 1)](https://example.org/f1.png) tail](https://example.org/paper)]',
                r'[Note: [![Fig 1: \[0, 1)](https://example.org/f1.png) tail](https://example.org/paper)]',
                'https://example.org/f1.png',
            ),
            (
                'See ![FALL] and [![Figure 1: (0, 1]](https://example.org/f1.png)](https://example.org/paper)',
                r'See ![FALL] and [![Figure 1: (0, 1\]](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: (0, 1](t) and [a]](https://example.org/f1.png)',
                r'![Figure 1: (0, 1\](t) and \[a\]](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: interval (0, 1](or [0, 1]) over x](https://example.org/f1.png)',
                r'![Figure 1: interval (0, 1\](or \[0, 1\]) over x](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: (0, 1] and (2, 3]](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: (0, 1\] and (2, 3\]](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: (0, 1]](https://example.org/f1.png)][ref]',
                r'[![Figure 1: (0, 1\]](https://example.org/f1.png)][ref]',
                'https://example.org/f1.png',
            ),
            (
                '[[![Fig 1: (0, 1]](https://example.org/f1.png)](https://example.org/p1)](https://example.org/p2)',
                r'[[![Fig 1: (0, 1\]](https://example.org/f1.png)](https://example.org/p1)](https://example.org/p2)',
                'https://example.org/f1.png',
            ),
            (
                '[Note: ![Figure 1: (0, 1]](https://example.org/f1.png)]',
                r'[Note: ![Figure 1: (0, 1\]](https://example.org/f1.png)]',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: (0, 1] and [2, 3)](https://example.org/f1.png)',
                r'![Figure 1: (0, 1\] and \[2, 3)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: (0, 1] and [2, 3)](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: (0, 1\] and \[2, 3)](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            # R10: 覆盖 R9 Issues 2-7（Note+[0,1)、图注内![FALL]、区间+Payne、反斜杠空格非转义、图注<不被公式正则改写）
            (
                '[Note: ![Fig 1: [0, 1)](https://example.org/f1.png)]',
                r'[Note: ![Fig 1: \[0, 1)](https://example.org/f1.png)]',
                'https://example.org/f1.png',
            ),
            (
                '![Fig 1: see ![FALL] here](https://example.org/f1.png)',
                r'![Fig 1: see !\[FALL\] here](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '![Fig 1: see ![FALL] and [0, 1)](https://example.org/f1.png)',
                r'![Fig 1: see !\[FALL\] and \[0, 1)](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: (0, 1] and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: (0, 1\] and FALL: !\[e me](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                '[![Figure 1: [0, 1) and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)',
                r'[![Figure 1: \[0, 1) and FALL: !\[e me](https://example.org/f1.png)](https://example.org/paper)',
                'https://example.org/f1.png',
            ),
            (
                'FALL: ![e me — ![Figure 1: [0, 1)](https://example.org/f1.png) and [range [2, 3)](https://example.org/doc)',
                r'FALL: ![e me — ![Figure 1: \[0, 1)](https://example.org/f1.png) and [range [2, 3)](https://example.org/doc)',
                'https://example.org/f1.png',
            ),
            (
                r'Text [x](see\ ![Fig:[0,1)](https://example.org/f1.png))',
                r'Text [x](see\ ![Fig:\[0,1)](https://example.org/f1.png))',
                'https://example.org/f1.png',
            ),
            (
                '![Figure 1: [a < b]](https://example.org/f1.png)',
                r'![Figure 1: \[a < b\]](https://example.org/f1.png)',
                'https://example.org/f1.png',
            ),
            (
                r'\``a` ![Real: [0, 1)](https://example.org/real.png) `b`',
                r'\``a` ![Real: \[0, 1)](https://example.org/real.png) `b`',
                'https://example.org/real.png',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected)
            gate_imgs = list(conf_gate._iter_markdown_images(repaired))
            self.assertEqual(len(gate_imgs), 1, msg=repaired)
            self.assertEqual(gate_imgs[0][2], expected_dest, msg=repaired)

        # R8/R9/R10: mask_markdown_image_alts 完整遮罩带引号标题里的 $x$，并保留尖括号含空格或非平衡括号 URL
        titled_img = '![Figure 1](https://example.org/f1.png "Panel (a) $x$")'
        self.assertEqual(conf_gate.mask_markdown_image_alts(titled_img), '![](https://example.org/f1.png)')
        spaced_img = '![Figure 1](<https://example.org/fig 1.png>)'
        self.assertEqual(conf_gate.mask_markdown_image_alts(spaced_img), '![](<https://example.org/fig 1.png>)')
        unbal_img = '![Figure 1](<https://example.org/fig)1.png>)'
        self.assertEqual(conf_gate.mask_markdown_image_alts(unbal_img), '![](<https://example.org/fig)1.png>)')

        # R7/R8/R9/R10: 非行内图片（转义 `\![`、引用图、字面 `![FALL]`、正文中孤立 `![e me`、非URL空格括号、代码段、围栏代码块）均不得改写或误识别
        for non_img in [
            r'\![literal [a] $50](https://example.org/doc)',
            '[![Figure 1][img-ref]](https://example.org/paper)',
            '[See ![FALL] notation](https://example.org/paper)',
            '[See ![FALL]](https://example.org/paper)',
            '[![FALL]](https://example.org/paper)',
            '[See ![FALL] notation](https://example.org/paper) and [cite][ref]',
            '[See ![FALL] notation](https://example.org/paper) and [range [0, 1)](https://example.org/doc)',
            '[![FALL] note](https://example.org/paper)',
            'FALL: ![e me — see [paper](https://example.org/paper)',
            'FALL: ![e me — see [paper `` and `)`](https://example.org/paper)',
            'Payne notation ![e [a] me](falling contour) in prose.',
            'See ![FALL] and [range [0, 1)](https://example.org/doc)',
            'See ![FALL] and [link with (0, 1]](https://example.org/doc)',
            'See ![FALL] and [link with (0, 1] and (2, 3]](https://example.org/doc)',
            'See ![FALL] and [link with (0, 1] and [a]](https://example.org/doc)',
            r'\``![Fake](https://example.org/fake.png)`',
            '`![Figure 1: [a]](https://example.org/f1.png)`',
            '```markdown\n![Figure 1: [a]](https://example.org/f1.png)\n```',
        ]:
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(non_img), non_img, msg=non_img)
            self.assertEqual(list(conf_gate._iter_markdown_images(non_img)), [], msg=non_img)
            self.assertEqual(conf_gate.mask_markdown_image_alts(non_img), non_img, msg=non_img)

        # R6/R7/R8/R9: 同行/跨行多图不得跨图窃取，包括复合链接中的双图、各自带未配对 `[` 的双图、标题反引号与前置 `![FALL]`
        for two_imgs_raw, expected_dests in [
            (
                '[![Figure 1: [0, 1)](https://example.org/f1.png)][ref] [![Figure 2](https://example.org/f2.png)](https://example.org/p2)',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                r'\[![Fig 1: [0, 1)](https://example.org/1.png) [![Fig 2](https://example.org/2.png)](https://example.org/p2)',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '[![Fig 1](https://example.org/1.png) ![Fig 2: [0, 1)](https://example.org/2.png)](https://example.org/paper)',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '[![Fig 1: [0, 1)](https://example.org/1.png) ![Fig 2](https://example.org/2.png)](https://example.org/paper)',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '[![Fig 1: [0, 1)](https://example.org/1.png) ![Fig 2](https://example.org/2.png)][ref]',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '[![Fig 1: [0, 1)](https://example.org/1.png) ![Fig 2: [2, 3)](https://example.org/2.png)](https://example.org/paper)',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '[![Fig 1: [0, 1)](https://example.org/1.png)](https://example.org/p1) [![Fig 2: [2, 3)](https://example.org/2.png)](https://example.org/p2)',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                'See ![FALL] then [![Fig 1](https://example.org/1.png)](https://example.org/p1) and [![Fig 2: (0, 1]](https://example.org/2.png)](https://example.org/p2)',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '![one [a]](https://example.org/1.png "literal `")\n![two [0, 1)](https://example.org/2.png)\n`other text`',
                ['https://example.org/1.png', 'https://example.org/2.png'],
            ),
            (
                '![Figure 1: [a]](https://example.org/f1.png "tick ` here") and ![Figure 2: [0, 1)](https://example.org/f2.png) and `end`',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
        ]:
            repaired_two = CONF_RENDER.repair_formula_delimiters(two_imgs_raw)
            gate_dests = [img[2] for img in conf_gate._iter_markdown_images(repaired_two)]
            self.assertEqual(gate_dests, expected_dests, msg=repaired_two)

        # R9/R10: _iter_markdown_images 遵守段落与围栏代码块边界、严格 CommonMark §6.3 目标解析，且失败候选回退 start+2 不吞嵌套/后续真实图片
        import markdown_hugo_gate as mhg
        for bypass_md in [
            'Prosody ![e me.\n\n~~~md\nfoo](https://example.org/fake.png)\n~~~\n\n$raw_dollar$ and **unclosed',
            'Prosody ![e me.\n\n```md\nline 1\n\nfoo](https://example.org/fake.png)\n```\n\n$raw_dollar$ and **unclosed',
            '![Figure 1: $raw_dollar$ and **unclosed](<https://example.org/a> garbage >)',
            '![Figure 1: $x$](<> >)',
            '![Figure 1: $raw$](<https://example.org/a> <https://example.org/b>)',
            '![Figure 1: $raw_dollar$ and **unclosed](<https://example.org/a\\\nb>)',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(bypass_md)), [], msg=bypass_md)
            self.assertTrue(mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(bypass_md), 'Markdown'), msg=bypass_md)
        for nested_md, expected_nested in [
            (r'FALL: ![e me — ![Figure 1: \[a\] and $5](https://example.org/f1.png) over (0, 1]', ['https://example.org/f1.png']),
            ('Section 1 mentions ![e me.\n\nSection 2 shows ![Figure 1](https://example.org/f1.png) over (0, 1].', ['https://example.org/f1.png']),
            ('![prefix ![Figure 1](https://example.org/f1.png) suffix]', ['https://example.org/f1.png']),
            ('![prefix ![Figure 1](https://example.org/f1.png)](https://example.org/bad "unclosed)', ['https://example.org/f1.png']),
            ('![prefix ![Figure 1](https://example.org/f1.png)](https://example.org/x "t1" "t2")', ['https://example.org/f1.png']),
            ('![prefix ![Real](https://example.org/real.png)](<bad> foo >)', ['https://example.org/real.png']),
            ('![bad angle](<https://example.org/f1.png>trailing)', []),
        ]:
            self.assertEqual([img[2] for img in conf_gate._iter_markdown_images(nested_md)], expected_nested, msg=nested_md)
        # R10 (R9 Issue 7): 图注转义产生的 \[ / \] 不得被下游公式正则跨图匹配，破坏中间正文、HTML 标签或行内代码
        cross_fig = (
            '![Figure 1: [0, 1)](https://example.org/f1.png)\n\n'
            'We observe p < 0.05.\n<details><summary>meta</summary></details>\n\n'
            '![Figure 2: (0, 1]](https://example.org/f2.png)'
        )
        expected_cross = (
            '![Figure 1: \\[0, 1)](https://example.org/f1.png)\n\n'
            'We observe p < 0.05.\n<details><summary>meta</summary></details>\n\n'
            '![Figure 2: (0, 1\\]](https://example.org/f2.png)'
        )
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(cross_fig), expected_cross)
        mixed_code_math = r'![Figure 1: [0, 1)](https://example.org/f1.png) and `\[a < b\]` and \(x < y\)'
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(mixed_code_math),
            r'![Figure 1: \[0, 1)](https://example.org/f1.png) and `\[a < b\]` and \(x \lt  y\)',
        )
        self.assertEqual(
            mhg.math_and_emphasis_issues(
                conf_gate.mask_markdown_image_alts(r'FALL: ![e me — ![Figure 1: \[a\] and $5](https://example.org/f1.png) over (0, 1]'),
                'Markdown',
            ),
            [],
        )

    def test_d_h6_blog_git_publication_diff_tree_handles_z_unicode_paths(self):
        unicode_path = 'content/posts/2026-11-20-中文论文.md'
        seen_args = []

        def fake_git(args, **kw):
            seen_args.append((args, kw))
            if args[0] == 'rev-list':
                return SimpleNamespace(returncode=0, stdout=f'{"b" * 40} {"a" * 40}\n')
            if args[0] == 'diff-tree':
                self.assertIn('-z', args)
                self.assertIs(kw.get('text'), False)
                return SimpleNamespace(returncode=0, stdout=unicode_path.encode('utf-8') + b'\x00')
            raise AssertionError(args)

        def fake_batch(rev, _rels):
            if rev == 'a' * 40:
                return {unicode_path: None}
            return {unicode_path: b'hello\n'}

        blog_git_publication.validate_git_commit_against_review_receipt(
            {
                'baseHead': 'a' * 40,
                'files': [{
                    'path': unicode_path,
                    'sha256': hashlib.sha256(b'hello\n').hexdigest(),
                }],
            },
            [unicode_path],
            'b' * 40,
            run_git=fake_git,
            batch_blob_bytes=fake_batch,
            hooks={'_git_relative_manifest': lambda _p: [unicode_path]},
        )
        self.assertTrue(any(args[0] == 'diff-tree' for args, _ in seen_args))

    def test_d_m1_global_caches_survive_concurrent_access_and_eviction(self):
        # 真实并发调用生产函数 reader_pdf_page_asset.derive_page_asset 与 PUB._reader_damaged_raster_pdf_page_asset，
        # 验证生产代码内部真实获取锁并执行有界淘汰，不出现多线程竞态异常。
        import threading
        import reader_damaged_raster_pdf_asset

        class SpyLock:
            def __init__(self):
                self._lock = threading.Lock()
                self.entries = 0
            def __enter__(self):
                self._lock.acquire()
                self.entries += 1
                return self
            def __exit__(self, *args):
                self._lock.release()
                return False

        # 1. 生产函数 reader_pdf_page_asset.derive_page_asset 并发缓存命中、写入与 >=4 淘汰
        from test_conference_extractor import build_pdf
        real_pdf_bytes = build_pdf([['Figure 1: Synthetic concurrent caption for test.']])
        pdf_spy = SpyLock()
        with reader_pdf_page_asset._CACHE_LOCK:
            orig_pdf_cache = dict(reader_pdf_page_asset._CACHE)
            reader_pdf_page_asset._CACHE.clear()
        try:
            def run_derive(idx):
                svg = f'<svg id="f{idx}" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
                svg_bytes = svg.encode('utf-8')
                res = {
                    'kind': 'inline_svg', 'mediaType': 'image/svg+xml',
                    'inlineSvg': svg, 'inlineSvgBytes': len(svg_bytes),
                    'inlineSvgSha256': hashlib.sha256(svg_bytes).hexdigest(),
                }
                desc = reader_inline_svg.source_descriptor(res, '2611.00001')
                fig = {
                    **desc,
                    'ordinal': 1,
                    'label': 'Figure 1:',
                    'caption': 'Figure 1: Synthetic concurrent caption for test.',
                    'sourceDomSha256': hashlib.sha256(f'dom-{idx}'.encode()).hexdigest(),
                    'assetSha256': hashlib.sha256(MINIMAL_PNG).hexdigest(),
                }
                src_files = {
                    'source.txt': hashlib.sha256(b'txt').hexdigest(),
                    'source.pdf': hashlib.sha256(real_pdf_bytes).hexdigest(),
                    'source-runtime.json': hashlib.sha256(b'{}').hexdigest(),
                    'source-manifest.json': hashlib.sha256(b'{}').hexdigest(),
                }
                return reader_pdf_page_asset.derive_page_asset(
                    paper_id='2611.00001', figure=fig, resource=res,
                    old_pixels=MINIMAL_PNG, pdf_bytes=real_pdf_bytes, source_files=src_files,
                )

            with mock.patch.object(reader_pdf_page_asset, '_CACHE_LOCK', pdf_spy), \
                    mock.patch.object(reader_pdf_page_asset, 'dependency_failure', return_value={'reason': 'external_css_icon_glyph'}):
                with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                    out = [f.result() for f in [pool.submit(run_derive, i % 10) for i in range(24)]]
            self.assertEqual(len(out), 24)
            self.assertGreaterEqual(pdf_spy.entries, 24)
            self.assertLessEqual(len(reader_pdf_page_asset._CACHE), 4)
        finally:
            with reader_pdf_page_asset._CACHE_LOCK:
                reader_pdf_page_asset._CACHE.clear()
                reader_pdf_page_asset._CACHE.update(orig_pdf_cache)

        # 2. 生产函数 PUB._reader_damaged_raster_pdf_page_asset 并发访问 _RASTER_RECOVERY_SOURCE_BYTES
        raster_spy = SpyLock()
        with PUB._RASTER_RECOVERY_SOURCE_BYTES_LOCK:
            orig_raster_cache = dict(PUB._RASTER_RECOVERY_SOURCE_BYTES)
            PUB._RASTER_RECOVERY_SOURCE_BYTES.clear()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                runs_root = Path(tmp).resolve()
                run_id = '11111111-1111-4111-8111-111111111111'
                paper_id = '2611.00001'
                gen_dir = runs_root / run_id / 'sources' / paper_id / 'generation-000001'
                gen_dir.mkdir(parents=True)
                url = 'https://arxiv.org/html/2611.00001v1/f1.png'
                dom_sha = hashlib.sha256(b'<figure/>').hexdigest()
                pix_sha = hashlib.sha256(MINIMAL_PNG).hexdigest()
                runtime_doc = {
                    'structuredArtifacts': {
                        'figures': [{
                            'ordinal': 1, 'label': 'Figure 1:', 'caption': 'Figure 1: Demo.',
                            'sourceDomSha256': dom_sha, 'recoveryStatus': 'complete',
                            'images': [{'alt': 'a', 'kind': 'external_url', 'mediaType': 'image/png',
                                        'rasterDownloadEligible': True, 'url': url}],
                        }]
                    }
                }
                (runs_root / run_id / 'run.json').write_text(json.dumps({'batchDate': '2026-11-20'}), encoding='utf-8')
                (gen_dir / 'source.txt').write_bytes(b'txt')
                (gen_dir / 'source.pdf').write_bytes(b'%PDF-1.4\n')
                (gen_dir / 'source-runtime.json').write_text(json.dumps(runtime_doc), encoding='utf-8')
                (gen_dir / 'source-manifest.json').write_text('{}', encoding='utf-8')
                for fpath in [runs_root / run_id / 'run.json', *(gen_dir / n for n in ('source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'))]:
                    os.chmod(fpath, 0o600)
                paper = {'arxivId': '2611.00001v1', 'freshRewriteProvenance': {'runId': run_id}}
                figure = {'ordinal': 1, 'url': url, 'sourceDomSha256': dom_sha, 'assetSha256': pix_sha,
                          'label': 'Figure 1:', 'caption': 'Figure 1: Demo.'}

                tls = threading.local()

                def run_raster(idx):
                    rec_sha = hashlib.sha256(f'rec-{idx % 6}'.encode()).hexdigest()
                    tls.rec_sha = rec_sha
                    recovery = {
                        'file': 'recovery.json', 'sha256': rec_sha, 'receipt': {'ok': True},
                        'value': {'batchDate': '2026-11-20', 'targets': [{'figureOrdinal': 1}]},
                    }
                    return PUB._reader_damaged_raster_pdf_page_asset(paper, figure, recovery)

                with mock.patch.object(PUB, 'DAILY_FRESH_SOURCE_RUNS_DIR', runs_root), \
                        mock.patch.object(PUB, '_RASTER_RECOVERY_SOURCE_BYTES_LOCK', raster_spy), \
                        mock.patch.object(PUB, '_publication_raster_recovery_input', side_effect=lambda: {'sha256': tls.rec_sha}), \
                        mock.patch.object(PUB, '_daily_fresh_validate_bundle', return_value=None), \
                        mock.patch.object(PUB, '_download_review_image', return_value={'raw': MINIMAL_PNG}), \
                        mock.patch.object(reader_damaged_raster_pdf_asset, 'derive_page_asset', return_value=(MINIMAL_PNG, {'displayLabel': 'ok'})):
                    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                        out2 = [f.result() for f in [pool.submit(run_raster, i) for i in range(18)]]
                self.assertEqual(len(out2), 18)
                self.assertGreaterEqual(raster_spy.entries, 18)
                self.assertLessEqual(len(PUB._RASTER_RECOVERY_SOURCE_BYTES), 1)
        finally:
            with PUB._RASTER_RECOVERY_SOURCE_BYTES_LOCK:
                PUB._RASTER_RECOVERY_SOURCE_BYTES.clear()
                PUB._RASTER_RECOVERY_SOURCE_BYTES.update(orig_raster_cache)

    def test_d_m2_conference_balanced_and_escaped_alt_brackets_and_frontmatter_dashes(self):
        # 1. 转义的 \[a\](b) 与未转义但括号平衡的 [a](b) 都不应截断图片
        escaped_line = r'![Figure 1: Model \[a\](b) overview](https://img.example.com/f1.png)'
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(escaped_line), escaped_line)
        self.assertEqual(conf_gate.mask_markdown_image_alts(escaped_line), '![](https://img.example.com/f1.png)')

        balanced_link_like = '![Figure 1: Model [a](b) overview](https://img.example.com/a.png)'
        repaired = CONF_RENDER.repair_formula_delimiters(balanced_link_like)
        self.assertEqual(repaired, r'![Figure 1: Model \[a\](b) overview](https://img.example.com/a.png)')

        # 未配对 `[`（如 `[0, 1)`）在链接图片 `[![...](url)](url)` 与同行后续链接场景下不得跨界吞并
        linked_unpaired = '[![原论文 Figure 2：Range [0, 1)](https://example.org/f.png)](https://example.org/f.png)'
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(linked_unpaired),
            r'[![原论文 Figure 2：Range \[0, 1)](https://example.org/f.png)](https://example.org/f.png)',
        )
        trailing_link = '![Figure 1: Range [0, 1)](https://example.org/f1.png) and [link](https://example.org/doc)'
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(trailing_link),
            r'![Figure 1: Range \[0, 1)](https://example.org/f1.png) and [link](https://example.org/doc)',
        )

        # 2. CommonMark 合法的平衡方括号 [a] 也必须被 conference_publication_gate 识别为图片
        balanced_md = (
            '---\n'
            'title: "A---B Test"\n'
            '---\n\n'
            '正文首段。\n\n'
            '![Figure 1: Model [a] overview](https://img.example.com/a.png)\n'
        )
        rendered = (
            '<!doctype html><html><head><link rel="canonical" href="https://example.com/p/"></head>'
            '<body><div class="post-content"><p>正文首段。</p>'
            '<p><img src="https://img.example.com/a.png" alt="Figure 1: Model [a] overview"></p></div></body></html>'
        )
        conf_gate.inspect_html(
            balanced_md, rendered,
            [{'path': 'a.png'}], 'https://img.example.com',
        )

    def test_d_m3_closed_code_uses_html_line_offsets_with_unicode_line_sep(self):
        html_with_ls = '<p>a\u2028b</p><p><code>$x$</code></p>'
        masked = hugo_gate.mask_closed_code_for_format_gate(html_with_ls, rendered_html=True)
        self.assertNotIn('$x$', masked)

    def test_d_m5_paper_reader_presentation_excluded_count_uses_visible_before_count(self):
        # 当 replay_resource_presentation 增加资源条数、且 exclude_resource_url 真正排除其中 1 条时，
        # excluded 必须为 True（显示预印本排除提示），不能因与原 len(resources) 恰好相等而漏报。
        saved_resources = [{'originalUrl': 'https://github.com/org/repo', 'finalUrl': 'https://github.com/org/repo', 'kind': 'code'}]
        replayed_resources = [
            *saved_resources,
            {'originalUrl': 'https://arxiv.org/abs/2611.99999', 'finalUrl': 'https://arxiv.org/abs/2611.99999', 'kind': 'paper'},
        ]
        plan = {'readerTitle': '测试标题', 'oneSentenceThesis': '测试主线'}
        authors = [{'name': 'Alice', 'affiliations': ['Test Lab']}]
        paper = {
            'analysis': '## 核心摘要\n\n测试摘要\n',
            'apiReaderPlan': plan,
            'apiReaderAuthors': {'authors': authors},
            'apiReaderResources': {'resources': saved_resources},
        }
        fake_pub = SimpleNamespace(
            parse_analysis=lambda _a: {'summary': '测试摘要'},
            render_verified_reader_authors=lambda a, source_note='': 'Alice',
        )
        with mock.patch.object(presentation, 'replay_resource_presentation', return_value=list(replayed_resources)), \
                mock.patch.object(presentation, 'resolve_reader_decision_display', return_value={
                    'summary': '测试摘要', 'resourceBlock': '- 代码仓库：https://github.com/org/repo', 'scoringBlock': '评分明细'
                }):
            out = presentation.build_reader_presentation(
                paper, plan=plan, resources=saved_resources, authors=authors,
                exclude_resource_url=lambda u: bool(u and 'arxiv.org' in u),
                source_text='source text', publisher=fake_pub,
            )
        self.assertIn('预印本/扩展版链接未在会议页展示', out['resourceBlock'])

    def test_d_m6_atomic_json_and_replace_exact_mode_cleanup_and_path_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            p = tmp_path / 'cp.json'
            HIST_REVIEW.atomic_json(p, {'ok': True})
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
            self.assertEqual([x.name for x in tmp_path.iterdir()], ['cp.json'])

            # 模拟 os.replace 失败：临时文件必须被清理，不留脏文件
            with mock.patch.object(os, 'replace', side_effect=OSError('simulated replace error')):
                with self.assertRaises(OSError):
                    HIST_REVIEW.atomic_json(p, {'ok': False})
            self.assertEqual([x.name for x in tmp_path.iterdir()], ['cp.json'])

            r = tmp_path / 'receipt.json'
            r.write_bytes(b'{"v":1}\n')
            os.chmod(r, 0o600)
            PUB_CONF.replace_exact(r, b'{"v":2}\n', mode=0o600)
            self.assertEqual(stat.S_IMODE(r.stat().st_mode), 0o600)
            self.assertEqual(r.read_bytes(), b'{"v":2}\n')

            with mock.patch.object(os, 'replace', side_effect=OSError('simulated replace error')):
                with self.assertRaises(OSError):
                    PUB_CONF.replace_exact(r, b'{"v":3}\n', mode=0o600)
            self.assertEqual(sorted(x.name for x in tmp_path.iterdir()), ['cp.json', 'receipt.json'])

            # historical-direct-review.py review_page 拒绝路径穿越与指向外部的符号链接
            staged = tmp_path / 'staged'
            staged.mkdir()
            outside = tmp_path / 'outside.md'
            outside.write_text('secret', encoding='utf-8')
            escape_link = staged / 'escape.md'
            escape_link.symlink_to(outside)
            for bad_rel in ('../outside.md', 'escape.md'):
                with self.assertRaises(ValueError):
                    HIST_REVIEW.review_page(
                        SimpleNamespace(),
                        {'path': bad_rel, 'sha256': hashlib.sha256(b'secret').hexdigest()},
                        staged, tmp_path / 'cp', {},
                    )

    def test_d_l1_conference_extractor_visual_bytes_matches_raw_png_and_enforces_encoded_cap(self):
        # 端到端构造真实 PDF -> Python conference_extractor -> Node conference-extraction-receipt 校验
        from paper_identity import canonical_conference_paper_id
        from test_conference_extractor import build_pdf
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            pdf_bytes = build_pdf([[f'line-{i:03d}-' + 'a' * 55 for i in range(65)] for _ in range(2)])
            pdf_rel = 'paper.pdf'
            meta_rel = 'paper.json'
            (root / pdf_rel).write_bytes(pdf_bytes)
            meta_bytes = json.dumps({
                'conferenceId': 'icassp-2026', 'year': 2026,
                'identity': {'type': 'icassp-arnumber', 'value': '123'},
                'title': 'Synthetic paper',
            }, separators=(',', ':')).encode('utf-8')
            (root / meta_rel).write_bytes(meta_bytes)
            request = {
                **protocols.record_header(conference_extractor.REQUEST_CONTRACT, 'conference-pdf-extraction-request'),
                'paperId': canonical_conference_paper_id(
                    {'id': 'icassp-2026', 'year': 2026},
                    {'type': 'icassp-arnumber', 'value': '123'},
                ),
                'sourceIdentity': 'icassp-arnumber:123',
                'source': {
                    'metadata': {
                        'file': meta_rel, 'sha256': hashlib.sha256(meta_bytes).hexdigest(),
                        'identityEvidence': {
                            'conferenceIdPointer': '/conferenceId', 'conferenceYearPointer': '/year',
                            'identityTypePointer': '/identity/type', 'identityValuePointer': '/identity/value',
                        },
                        'discoveryBinding': {
                            'catalogSha256': '1' * 64, 'metadataSnapshotSha256': '2' * 64,
                            'metadataIndex': 0, 'metadataRecordSha256': '3' * 64,
                        },
                        'provenance': {
                            'kind': 'official-metadata', 'locator': 'fixture:metadata',
                            'retrievedAt': '2026-09-06T00:00:00.000Z',
                        },
                    },
                    'pdf': {
                        'file': pdf_rel, 'sha256': hashlib.sha256(pdf_bytes).hexdigest(),
                        'provenance': {
                            'kind': 'official-pdf', 'locator': 'fixture:pdf',
                            'retrievedAt': '2026-09-06T00:00:00.000Z',
                        },
                    },
                },
                'outputs': {
                    'textFile': 'out.txt',
                    'artifactsFile': 'out.artifacts.json',
                    'receiptFile': 'out.receipt.json',
                },
                'options': {
                    'minimumTextCharacters': conference_extractor.MINIMUM_TEXT_CHARACTERS,
                    'normalization': conference_extractor.NORMALIZATION,
                    'pageSeparator': conference_extractor.PAGE_SEPARATOR,
                },
            }
            manifest_rel = 'request.json'
            (root / manifest_rel).write_text(json.dumps(request), encoding='utf-8')
            res = conference_extractor.run_extraction(manifest_rel, apply=True, source_root=root)
            self.assertEqual(res['status'], 'ready')
            artifacts = json.loads((root / 'out.artifacts.json').read_text(encoding='utf-8'))
            va = artifacts['visualAudit']
            self.assertEqual(va['visualBytes'], sum(p['bytes'] for p in va['pages']))
            # Node conference-extraction-receipt 校验（含 validateVisualAudit 的 total === visualBytes）必须通过
            node_cmd = (
                "const r = require('./scripts/lib/conference-extraction-receipt');"
                "const h = r.loadExtractionHandle(process.argv[1], process.argv[2]);"
                "console.log(r.extractionHandleSnapshot(h).artifacts.sha256);"
            )
            proc = subprocess.run(
                ['node', '-e', node_cmd, str(root), 'out.receipt.json'],
                cwd=ROOT, capture_output=True, text=True, check=True, timeout=30,
            )
            self.assertEqual(
                proc.stdout.strip(),
                hashlib.sha256((root / 'out.artifacts.json').read_bytes()).hexdigest(),
            )

            # 超出 encoded base64 上限时必须抛 ConferencePdfExtractionError
            with mock.patch.object(conference_extractor, 'MAX_DERIVED_BYTES', 100):
                with self.assertRaises(conference_extractor.ConferencePdfExtractionError):
                    backend = conference_extractor.load_pypdf_backend()
                    backend.extract_visual_audit(pdf_bytes)

    def test_d_l2_packet_bytes_rejects_symlink_and_fifo_without_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / 'packet.json'
            real.write_bytes(b'{"a":1}')
            link = Path(tmp) / 'link.json'
            link.symlink_to(real)
            fifo = Path(tmp) / 'pipe.json'
            os.mkfifo(fifo)
            orig_argv = sys.argv
            try:
                sys.argv = ['conference-page-render.py', '--packet-file', str(real)]
                self.assertEqual(CONF_RENDER.packet_bytes(), b'{"a":1}')
                sys.argv = ['conference-page-render.py', '--packet-file', str(link)]
                with self.assertRaises(ValueError):
                    CONF_RENDER.packet_bytes()
                # O_NONBLOCK 确保 FIFO 立即失败而不阻塞等待写端
                sys.argv = ['conference-page-render.py', '--packet-file', str(fifo)]
                with self.assertRaises(ValueError):
                    CONF_RENDER.packet_bytes()
            finally:
                sys.argv = orig_argv

    def test_d_l3_ascii_hyphen_fold_and_js_whitespace_parity(self):
        folded, _ = pdf_quote._folded_projection('café- au and recog- nition')
        self.assertIn('café- au', folded)
        self.assertIn('recognition', folded)
        self.assertEqual(
            pdf_quote._fold_line_break_hyphen('café- au and recog- nition'),
            folded,
        )
        catalog = tag_catalog.load_tag_catalog()
        active_zh = next(c['preferredLabel']['zh'] for c in catalog['concepts'] if c['status'] == 'active')
        concept, err = py_utils._resolve_analysis_tag(f'\ufeff#{active_zh}\ufeff', catalog)
        self.assertIsNone(err)
        self.assertIsNotNone(concept)
        concept_nel, _ = py_utils._resolve_analysis_tag(f'\u0085#{active_zh}', catalog)
        self.assertIsNone(concept_nel)

    def test_f_p0_3_and_b_h5_py_core_summary_full_js_python_parity(self):
        source = (
            'Table 1: Main Results in WER (%) on TestClean:\n'
            'Baseline achieves 10 and Ours achieves 5 with statistical significance (p < 0.05).\n'
            'Our model runs at 2.4 GHz and 16 kHz with latency 8-12 ms.\n'
            'We use the reference-free DNSMOS P.835 (SIG/BAK/OVL) metric.\n'
            'On AudioSet, CA-SDRi improves from 11.2 dB to 14.6 dB and LVE drops from 3.4 to 2.1.\n'
        )
        # B-H5 py: 合法 5% 不被 p < 0.05 误杀；连字符右端点编造 12.5 和 GHz 编造 3.6 被拦
        self.assertIsNone(PUB._validate_core_summary_source_grounded_claims(
            '在 TestClean 上 WER 降至 5%，运行于 2.4 GHz，延迟为 8-12 ms。', source
        ))
        self.assertIsNotNone(PUB._validate_core_summary_source_grounded_claims(
            '在 TestClean 上 WER 降至 5%，延迟位于 8-12.5 ms。', source
        ))
        self.assertIsNotNone(PUB._validate_core_summary_source_grounded_claims(
            '在 TestClean 上 WER 降至 5%，运行于 3.6 GHz。', source
        ))
        batch_src = 'Table 1: WER (%): Baseline 12.3, Ours 10.1. We use batch size 85 and obtain F1 = 0.85.'
        self.assertIsNotNone(PUB._validate_core_summary_source_grounded_claims(
            '在公开集上 WER 降至 10.1%，且 F1 达到 85%。', batch_src
        ))

        # F-P0-3: 不含“性能/指标/WER/延迟”等泛指标词的隔离模板，逐支验证 JS/Python 完全一致
        def make_summary(result_sentence):
            return (
                '现有流式语音建模方案在强混响条件下存在核心瓶颈，难以在单通道输入波形与输出声学表示之间保持稳定收敛。'
                '本文构建双分支编码器架构，首先由前端滤波器组抽取多尺度时频特征，随后通过门控交叉注意力完成上下文聚合，最后由轻量化解码器输出目标表征。'
                f'{result_sentence}'
                '此外，本文方法在推理阶段需占用额外缓存显存与算力开销，且目前仅在近场英文语料上验证，尚未覆盖远场多说话人重叠场景。'
                '上述架构与参数配置适合低资源边缘部署，并在中等信噪比区间保持稳定，但极端混响环境下仍需联合麦克风阵列进一步校准。'
                '研究团队同时讨论了数据分布偏移带来的边界条件，指出训练语料覆盖度是决定跨域泛化能力的关键因素之一，未来需扩充多语种真实录音与复杂声学环境。'
            )

        parity_cases = [
            # 1. CA-SDRi 作为唯一指标 -> JS & Python 均通过
            ('ca_sdri_pass', '在公开测试集上，相比基线模型，本文方法的 CA-SDRi 从 11.2 dB 提升至 14.6 dB。', source, False),
            # 2. CJK 紧邻 CI 的统计结果 -> JS & Python 均通过
            ('stat_ci_cjk_pass', '在公开测试集上，相比基线组，本文估计的调整后率比为1.42（95%CI为1.10-1.85），优于对照方案。', '', False),
            # 3. 模型名后缀紧接中文（CCC model在...）-> JS & Python 均拒绝
            ('ccc_model_cjk_reject', '在公开测试集上，相比基线方案，CCC model在测试中从1.2提升至2.4。', '', True),
            # 4. LVE 被先前研究/假设修饰 -> JS & Python 均拒绝
            ('lve_denied_reject', '在公开测试集上，先前研究假设LVE从3.4降至2.1。', '', True),
            # 5. additional_metric DAP 被先前研究/假设修饰 -> JS & Python 均拒绝
            ('dap_denied_reject', '在公开测试集上，先前研究假设DAP从0.70提升至0.85。', '', True),
            # 6. 空 source 下 DNSMOS SIG分数 不能靠裸“分数”绕过 -> JS & Python 均拒绝
            ('dnsmos_empty_source_reject', '在公开测试集上，相比基线模型，DNSMOS SIG分数从3.1提升至3.6。', '', True),
            # 7. 有原文定义 DNSMOS P.835 时正向陈述 -> JS & Python 均通过
            ('dnsmos_with_source_pass', '在公开测试集上，相比基线模型，本文方法的 DNSMOS P.835 SIG 从3.1提升至3.6。', source, False),
        ]
        for name, sentence, src_text, expect_reject in parity_cases:
            with self.subTest(parity=name):
                summary = make_summary(sentence)
                py_issue = PUB._detailed_core_summary_semantic_issue(summary, source_text=src_text)
                js_issue = _js_core_summary_issue(summary, src_text)
                self.assertEqual(py_issue is not None, expect_reject, f'{name} py={py_issue}')
                self.assertEqual(js_issue is not None, expect_reject, f'{name} js={js_issue}')

    def test_wave4_r10_commonmark_gate_and_renderer_hardening(self):
        # Defect 1: trailing backslash & bare < / > destinations in mask_markdown_image_alts
        bypass = r'Unclosed \(x + y and ![alt](https://example.org/a\ )'
        masked_bypass = conf_gate.mask_markdown_image_alts(bypass)
        self.assertTrue(
            hugo_gate.math_and_emphasis_issues(masked_bypass, 'Markdown'),
            f'masked trailing backslash must not synthesize \\): {masked_bypass!r}',
        )
        for sample, expected_url in [
            (r'![alt](https://example.org/a\ )', 'https://example.org/a\\'),
            (r'![alt](<https://example.org/a\ >)', 'https://example.org/a\\'),
            (r'![alt](<https://example.org/a b\ >)', 'https://example.org/a b\\'),
            ('![alt](https://example.org/a<b)', 'https://example.org/a<b'),
            ('![alt](https://example.org/a>b)', 'https://example.org/a>b'),
        ]:
            masked = conf_gate.mask_markdown_image_alts(sample)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(masked)], [expected_url], sample)
            self.assertEqual(hugo_gate.math_and_emphasis_issues(masked, 'Markdown'), [], sample)

        # Defect 2: §4.1 spaced thematic break, §4.6 HTML block, quoted link titles, bare-dest control chars
        for bypass_md in [
            'Prosody ![e me $raw_dollar$ and **unclosed\n<details>\nfoo](https://example.org/fake.png)\n</details>',
            'Prosody ![e me $raw_dollar$ and **unclosed\n_ _ _\nfoo](https://example.org/fake.png)',
            '![prefix $raw_dollar$ and **unclosed [x](https://example.org/a "title ](https://example.org/fake.png)")',
            '[outer](https://example.org/a "title ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)")',
            '![alt $raw_dollar$ and **unclosed](https://example.org/a\x0bb.png)',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(bypass_md)), [], bypass_md)
            masked = conf_gate.mask_markdown_image_alts(bypass_md)
            self.assertTrue(hugo_gate.math_and_emphasis_issues(masked, 'Markdown'), bypass_md)

        # Defect 3: literal ![FALL] must not hijack enclosing non-image links
        for non_image in [
            '[See ![FALL]](https://example.org/p1) and [other (0, 1]](https://example.org/p2)',
            '[[See ![FALL]](https://example.org/p1)](https://example.org/p2)',
            '[Outer [See ![FALL]](https://example.org/p1)][ref]',
            '[Range [0, 1) with ![FALL]](https://example.org/paper)',
            '[Panel a) shows ![FALL]](https://example.org/paper)',
            'See ![FALL] and [1) Introduction](https://example.org/doc)',
            'See ![FALL] and [panel a)](https://example.org/doc)',
            'FALL: ![e me — [Note: ![FALL] here](https://example.org/doc)',
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(non_image)
            self.assertEqual(repaired, non_image, non_image)
            self.assertEqual(list(conf_gate._iter_markdown_images(repaired)), [], non_image)

        # Defects 4, 5, 6: ref-image paren validation, inner [1) a](url) link, Payne [a][b]/![FALL]/]()
        for raw, expected_url in [
            ('![Fig 1: (0, 1][b]](https://example.org/f1.png)', 'https://example.org/f1.png'),
            ('![Fig 1: see (0, 1][b] here](https://example.org/f1.png)', 'https://example.org/f1.png'),
            ('See ![FALL] and [![Fig 1: (0, 1][b]](https://example.org/f1.png)](https://example.org/paper)', 'https://example.org/f1.png'),
            ('![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)', 'https://example.org/f1.png'),
            ('[![Fig 1: see [a][b] and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)', 'https://example.org/f1.png'),
            ('[![Fig 1: ![FALL] and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)', 'https://example.org/f1.png'),
            ('[![Fig 1: empty ]() and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)', 'https://example.org/f1.png'),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], [expected_url], raw)

        # Defect 7: orphan ]( must not skip backtick code spans or real images
        orphan_code = r'Text ](https://example.org/doc "literal `") and \[a < b\] and `end`'
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(orphan_code), orphan_code)
        orphan_img_in_code = 'Text ](https://example.org/doc "literal `") and ![Fig 1: [0, 1)](https://example.org/f1.png) and `end`'
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(orphan_img_in_code), orphan_img_in_code)
        orphan_real_img = 'Text (0, 1](not-a-link "![Fig 1: [0, 1)](https://example.org/f1.png)")'
        repaired_orphan_img = CONF_RENDER.repair_formula_delimiters(orphan_real_img)
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired_orphan_img)], ['https://example.org/f1.png'])

        # Defect 8: valid nested image inside outer image alt must keep outer alt protected from formula repair
        nested_img = r'![Outer: see ![Inner](https://example.org/in.png) and \[a < b\]](https://example.org/out.png)'
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(nested_img), nested_img)
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(nested_img)], ['https://example.org/out.png'])

    def test_wave4_r11_delimiter_stack_and_interval_hardening(self):
        # Issue 1: single-pass delimiter stack preserves enclosing link context across inner image / ![FALL] / code span
        md_icon = '[![icon](https://example.org/icon.png)](https://example.org/a "title ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)")'
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(md_icon)], ['https://example.org/icon.png'])
        self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(md_icon), 'Markdown'))

        for bypass_md in [
            '[See ![FALL] note](https://example.org/a "title ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)")',
            '[outer `![in_code](x)`](https://example.org/a "title ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)")',
            '[outer](<> "title ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)")',
            '![prefix $raw_dollar$ and **unclosed [x](<> "title ](https://example.org/fake.png)")',
            '[outer](https://example.org/a\n"title ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)")',
            '![prefix $raw_dollar$ and **unclosed [x](https://example.org/a\n"title ](https://example.org/fake.png)")',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(bypass_md)), [], bypass_md)
            self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(bypass_md), 'Markdown'), bypass_md)

        md_icon_tick = '[![icon](https://example.org/icon.png)](https://example.org/a "title `") ![Real](https://example.org/real.png) `end`'
        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images(md_icon_tick)],
            ['https://example.org/icon.png', 'https://example.org/real.png'],
        )

        # Issue 2: empty angle dest <>, parenthesized (title), multiline dest/title
        for tick_link in [
            '[x](<> "title `") ![Real: [0, 1)](https://example.org/f1.png) `end`',
            '[x](https://example.org/a (`)) ![Real: [0, 1)](https://example.org/f1.png) `end`',
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(tick_link)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], ['https://example.org/f1.png'], tick_link)
        for titled_img in [
            r'![Figure 1: \[a < b\]](https://example.org/f1.png (Panel a))',
            '![Figure 1: \\[a < b\\]](https://example.org/f1.png\n"Panel a")',
        ]:
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(titled_img), titled_img, titled_img)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(titled_img)], ['https://example.org/f1.png'], titled_img)

        # Issue 3, 4, 5, 6: math-interval close forms, surplus baselines, ref-image surplus, Payne 3-chain
        for raw, expected_urls in [
            ('![Fig 1: (0, 1][b] and [2, 3)](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('![Fig 1: (0, 1](t) and [2, 3)](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('![Fig 1: (0, 1]() and [2, 3)](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('[See ![FALL] note](https://example.org/p1) and ![Fig 1: (0, 1][b]](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('![Fig 1: Range [0, 1)](https://example.org/f1.png) and ![Fig 2: (0, 1][b]](https://example.org/f2.png)', ['https://example.org/f1.png', 'https://example.org/f2.png']),
            ('[![Fig 1: (0, 1][b] and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)', ['https://example.org/f1.png']),
            ('[![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)][ref]', ['https://example.org/f1.png']),
            ('[Note: ![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)]', ['https://example.org/f1.png']),
            ('Range [0, 1) shown in ![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('[![FALL] caption](https://example.org/f1.png) over [0, 1)](https://example.org/paper)', ['https://example.org/f1.png']),
            ('![Fig 1: array a][b]](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('![Fig 1: [0, 1]][ref]](https://example.org/f1.png)', ['https://example.org/f1.png']),
            ('[![Fig 1: see [a][b][c] and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)', ['https://example.org/f1.png']),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)

        # Issue 3/4/6/7: non-image links & prose ![e me / ![FALL] must never be corrupted
        for unchanged_non_img in [
            '[See ![FALL] note](https://example.org/p1) and [other (0, 1](t)](https://example.org/p2)',
            '[See ![FALL] note](https://example.org/p1) and [other (0, 1]()](https://example.org/p2)',
            '[See ![FALL] note](https://example.org/p1) over (0, 1][1]',
            r'See [a] and (0, 1](https://example.org/doc "literal `") and \[a < b\] and `end`',
            'See [a] and (0, 1](https://example.org/doc "literal `") and ![Fig 1: [0, 1)](https://example.org/f1.png) and `end`',
            r'See ![FALL] and (0, 1](https://example.org/doc "literal `") and \[a < b\] and `end`',
            'See ![FALL] and (0, 1](https://example.org/doc)',
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(unchanged_non_img)
            self.assertEqual(repaired, unchanged_non_img, unchanged_non_img)
            self.assertEqual(list(conf_gate._iter_markdown_images(repaired)), [], unchanged_non_img)

        # Issue 6: prose [0, 1) + FALL: ![e me before real images must not merge into ![e me
        for prose_case, expected_prefix, expected_urls in [
            (
                'Range [0, 1) in FALL: ![e me — ![Fig 1: [a]](https://example.org/f1.png) and ![Fig 2](https://example.org/f2.png)',
                'Range [0, 1) in FALL: ![e me — ![Fig 1: \\[a\\]](https://example.org/f1.png)',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                'Range [0, 1) in FALL: ![e me — ![Fig 1: [a]](https://example.org/f1.png) and [range [2, 3)](https://example.org/doc)',
                'Range [0, 1) in FALL: ![e me — ![Fig 1: \\[a\\]](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(prose_case)
            self.assertTrue(repaired.startswith(expected_prefix), f'{prose_case} -> {repaired}')
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, prose_case)

        # Issue 7: real image inside non-link string after [a]
        for after_a in [
            'See [a] and (0, 1](not-a-link "![Fig 1: [0, 1)](https://example.org/f1.png)")',
            'See [a] and text](not-a-link "![Fig 1: [0, 1)](https://example.org/f1.png)")',
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(after_a)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], ['https://example.org/f1.png'], after_a)

    def test_wave4_r12_commonmark_blocks_multiline_and_exact_repairs(self):
        # Issue 1: empty-destination outer image suppresses strictly nested inner image
        for empty_outer in [
            '![outer ![Real](https://example.org/real.png)]()',
            '![outer ![Real](https://example.org/real.png)](<> "title")',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(empty_outer)), [], empty_outer)
        nested_mask_bypass = '![outer ![Inner: $raw_dollar$ and **unclosed](https://example.org/in.png)]()'
        self.assertEqual(list(conf_gate._iter_markdown_images(nested_mask_bypass)), [])
        self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(nested_mask_bypass), 'Markdown'))

        # Issue 2: ATX heading, HTML block, URI autolink, and raw HTML tag gate bypasses
        for block_or_html_bypass in [
            '# Heading ![e me $raw_dollar$ and **unclosed\nNext line](https://example.org/fake.png)',
            'Intro.\n<details>\n![e me $raw_dollar$ and **unclosed\nfoo](https://example.org/fake.png)\n</details>',
            '<https://example.org/![Fake:$raw_dollar$](https://example.org/fake.png)>',
            '<a title="![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)">x</a>',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(block_or_html_bypass)), [], block_or_html_bypass)
            self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(block_or_html_bypass), 'Markdown'), block_or_html_bypass)
        heading_tick = '# Heading `unclosed\n![Fig 1: [0, 1)](https://example.org/f1.png) `end`'
        repaired_ht = CONF_RENDER.repair_formula_delimiters(heading_tick)
        self.assertEqual(repaired_ht, '# Heading `unclosed\n![Fig 1: \\[0, 1)](https://example.org/f1.png) `end`')
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired_ht)], ['https://example.org/f1.png'])

        # Issue 3: multiline parse_link_dest + whitespace-only empty parens ]( )
        for raw, expected, expected_urls in [
            (
                '[x](https://example.org/a\n"title `") ![Real: [0, 1)](https://example.org/f1.png) `end`',
                '[x](https://example.org/a\n"title `") ![Real: \\[0, 1)](https://example.org/f1.png) `end`',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [0, 1)](https://example.org/f1.png\n"Panel a")',
                '![Fig 1: \\[0, 1)](https://example.org/f1.png\n"Panel a")',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [0, 1)](\nhttps://example.org/f1.png)',
                '![Fig 1: \\[0, 1)](\nhttps://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [a]](https://example.org/f1.png "line 1\nliteral `") ![Fig 2: [0, 1)](https://example.org/f2.png) `end`',
                '![Fig 1: \\[a\\]](https://example.org/f1.png "line 1\nliteral `") ![Fig 2: \\[0, 1)](https://example.org/f2.png) `end`',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                '[![Fig 1: empty ]( ) and FALL: ![e me](https://example.org/f1.png)](https://example.org/paper)',
                '[![Fig 1: empty \\]( ) and FALL: !\\[e me](https://example.org/f1.png)](https://example.org/paper)',
                ['https://example.org/f1.png'],
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)

        # Issue 4: no prose-to-image fabrication, multi-interval & parenthesized endpoints, no URL replacement
        for unchanged in [
            'See ![FALL] and [0, 1) range](https://example.org/doc)',
            'FALL: ![e me — see [0, 1) range](https://example.org/doc)',
        ]:
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(unchanged), unchanged, unchanged)
            self.assertEqual(list(conf_gate._iter_markdown_images(unchanged)), [], unchanged)

        for raw, expected in [
            (
                '[![FALL] caption](https://example.org/f1.png) over [0, 1) and [2, 3)](https://example.org/paper)',
                '[![FALL\\] caption](https://example.org/f1.png) over [0, 1) and [2, 3)](https://example.org/paper)',
            ),
            (
                '[![FALL] caption](https://example.org/f1.png) over [0, 1)][ref]',
                '[![FALL\\] caption](https://example.org/f1.png) over [0, 1)][ref]',
            ),
            (
                '[![FALL] caption](https://example.org/f1.png) over [f(0), 1)](https://example.org/paper)',
                '[![FALL\\] caption](https://example.org/f1.png) over [f(0), 1)](https://example.org/paper)',
            ),
            (
                '[Panel a) ![Fig 1: [item 1)](https://example.org/f1.png)](https://example.org/paper)',
                '[Panel a) ![Fig 1: \\[item 1)](https://example.org/f1.png)](https://example.org/paper)',
            ),
            (
                '[![Fig 1: [item 1)](https://example.org/f1.png)](https://example.org/paper) and x]',
                '[![Fig 1: \\[item 1)](https://example.org/f1.png)](https://example.org/paper) and x]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], ['https://example.org/f1.png'], raw)

        # Issue 5 & 6: reference-image surplus, prose interval exclusion, outer plain_close ]
        for raw, expected in [
            (
                '[![Fig 1: array a][b]](https://example.org/f1.png)][ref]',
                '[![Fig 1: array a\\]\\[b\\]](https://example.org/f1.png)][ref]',
            ),
            (
                '[Note: ![Fig 1: array a][b]](https://example.org/f1.png)]',
                '[Note: ![Fig 1: array a\\]\\[b\\]](https://example.org/f1.png)]',
            ),
            (
                'Range [0, 1) shown in ![Fig 1: array a][b]](https://example.org/f1.png)',
                'Range [0, 1) shown in ![Fig 1: array a\\]\\[b\\]](https://example.org/f1.png)',
            ),
            (
                '[Note: ![Fig 1: [0, 1]][ref]](https://example.org/f1.png)]',
                '[Note: ![Fig 1: \\[0, 1\\]\\]\\[ref\\]](https://example.org/f1.png)]',
            ),
            (
                '[![Fig 1: [0, 1]][ref]](https://example.org/f1.png)][outer-ref]',
                '[![Fig 1: \\[0, 1\\]\\]\\[ref\\]](https://example.org/f1.png)][outer-ref]',
            ),
            (
                'Range [0, 1) shown in [![FALL] caption](https://example.org/f1.png)](https://example.org/paper)',
                'Range [0, 1) shown in [![FALL\\] caption](https://example.org/f1.png)](https://example.org/paper)',
            ),
            (
                '[Note: [![FALL] caption](https://example.org/f1.png)](https://example.org/paper)]',
                '[Note: [![FALL\\] caption](https://example.org/f1.png)](https://example.org/paper)]',
            ),
            (
                'Range [0, 1) shown in ![FALL] caption](https://example.org/f1.png)',
                'Range [0, 1) shown in ![FALL\\] caption](https://example.org/f1.png)',
            ),
            (
                '[Note: ![FALL] caption](https://example.org/f1.png)]',
                '[Note: ![FALL\\] caption](https://example.org/f1.png)]',
            ),
            (
                '[Note: ![Fig 1: FALL: ![e me](https://example.org/f1.png)]',
                '[Note: ![Fig 1: FALL: !\\[e me](https://example.org/f1.png)]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], ['https://example.org/f1.png'], raw)

        # Issue 7: open_stack cleanup across closed links/notes, ref_close, empty_paren, and (0, 1] captions
        for unchanged in [
            r'[See ![FALL]](https://example.org/p1) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            '[See ![FALL]](https://example.org/p1) and text](https://example.org/doc "literal `") and ![Fig 1: [0, 1)](https://example.org/f1.png) and `end`',
            r'[Note: ![FALL]] and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            r'See ![Figure 1][img-ref] and (0, 1](https://example.org/doc "literal `") and \[a < b\] and `end`',
            r'[x]() and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
        ]:
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(unchanged), unchanged, unchanged)
        for raw, expected in [
            (
                'See ![Figure 1][img-ref] and (0, 1](not-a-link "![Fig 1: [0, 1)](https://example.org/f1.png)")',
                'See ![Figure 1][img-ref] and (0, 1](not-a-link "![Fig 1: \\[0, 1)](https://example.org/f1.png)")',
            ),
            (
                '[x]() and text](not-a-link "![Fig 1: [0, 1)](https://example.org/f1.png)")',
                '[x]() and text](not-a-link "![Fig 1: \\[0, 1)](https://example.org/f1.png)")',
            ),
            (
                '[x]() and ![FALL] caption](https://example.org/f1.png)',
                '[x]() and ![FALL\\] caption](https://example.org/f1.png)',
            ),
            (
                '![FALL] over (0, 1] range](https://example.org/f1.png)',
                '![FALL\\] over (0, 1\\] range](https://example.org/f1.png)',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], ['https://example.org/f1.png'], raw)

    def test_wave4_r13_commonmark_blocks_html_inline_and_exact_repairs(self):
        import conference_publication_gate as conf_gate
        import markdown_hugo_gate as mhg

        # R13 Issue 1: short HTML comments <!--> and <!---> must not swallow to next -->
        for short_comment in ('<!-->', '<!--->'):
            bypass = (
                f'![Real: {short_comment}](https://example.org/real.png) '
                '$raw_dollar$ and **unclosed <!-- x -->](https://example.org/fake.png)'
            )
            self.assertEqual(
                [u for _, _, u in conf_gate._iter_markdown_images(bypass)],
                ['https://example.org/real.png'],
                bypass,
            )
            self.assertTrue(
                mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(bypass), 'Markdown'),
                bypass,
            )
        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images(
                'text <!--> ![Real](https://example.org/real.png) <!-- c -->'
            )],
            ['https://example.org/real.png'],
        )

        # R13 Issue 2: unified CommonMark block scanner (fence inside HTML block, non-CM linebreaks, Type 7, Type 5/6/1 boundaries)
        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images(
                '<!--\n```\n-->\n![Real](https://example.org/real.png)'
            )],
            ['https://example.org/real.png'],
        )
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('<!--\n```\n-->\n![Fig 1: [0, 1)](https://example.org/f1.png)'),
            '<!--\n```\n-->\n![Fig 1: \\[0, 1)](https://example.org/f1.png)',
        )
        parity_case = (
            '<!--\n```\n-->\nNormal text.\n\n```\n'
            '![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n```\n'
        )
        self.assertEqual(list(conf_gate._iter_markdown_images(parity_case)), [])
        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images(
                'hello\u2028```\n![Real](https://example.org/real.png)'
            )],
            ['https://example.org/real.png'],
        )
        for type7_block in [
            '<span>\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</span>',
            'Intro.\n\n<a href="https://example.org">\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</a>',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(type7_block)), [], type7_block)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(type7_block), type7_block, type7_block)
        for non_block_img in [
            '<p/foo ![Real](https://example.org/real.png)',
            '![Real\n</pre>](https://example.org/real.png)',
            '<![cdata[ ![Real](https://example.org/real.png)',
        ]:
            self.assertEqual(
                [u for _, _, u in conf_gate._iter_markdown_images(non_block_img)],
                ['https://example.org/real.png'],
                non_block_img,
            )

        # R13 Issue 3: renderer skips HTML blocks, raw HTML tags, and autolinks
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('<a title="a ` b"> ![Fig 1: [0, 1)](https://example.org/f1.png) `end`'),
            '<a title="a ` b"> ![Fig 1: \\[0, 1)](https://example.org/f1.png) `end`',
        )
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('<!-- `unclosed -->\n![Fig 1: [0, 1)](https://example.org/f1.png) `end`'),
            '<!-- `unclosed -->\n![Fig 1: \\[0, 1)](https://example.org/f1.png) `end`',
        )
        for untouched in [
            '<a title="![Fig 1: [0, 1)](https://example.org/f1.png)">x</a>',
            'Intro.\n<details>\n![Fig 1: [0, 1)](https://example.org/f1.png)\n</details>',
            '<https://example.org/![Fig:a[0]](https://example.org/f1.png)>',
        ]:
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(untouched), untouched, untouched)

        # R13 Issue 4: count_surplus_closers & has_prior_linked_img exact repairs
        for raw, expected, expected_urls in [
            (
                '[![Fig 1: [0, 1)](https://example.org/f1.png)](https://example.org/p1) and [0, 1) range](https://example.org/doc)',
                '[![Fig 1: \\[0, 1)](https://example.org/f1.png)](https://example.org/p1) and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '[![Fig 1: [0, 1)](https://example.org/f1.png)](https://example.org/p1) and [2, 3) range][ref]',
                '[![Fig 1: \\[0, 1)](https://example.org/f1.png)](https://example.org/p1) and [2, 3) range][ref]',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [0, 1)](https://example.org/f1.png) and [0, 1) range](https://example.org/doc)',
                '![Fig 1: \\[0, 1)](https://example.org/f1.png) and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [0, 1)](https://example.org/f1.png) and ![FALL] caption](https://example.org/f2.png)',
                '![Fig 1: \\[0, 1)](https://example.org/f1.png) and ![FALL\\] caption](https://example.org/f2.png)',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                '![Fig 1: [0, 1)](https://example.org/f1.png) and ![Fig 2: array a][b]](https://example.org/f2.png)',
                '![Fig 1: \\[0, 1)](https://example.org/f1.png) and ![Fig 2: array a\\]\\[b\\]](https://example.org/f2.png)',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                '[![Fig 1](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                '[![Fig 1](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)

        # R13 Issue 5: scoped include_plain, [Note: ... over [0, 1)], and [Panel a) prose prefix
        for raw, expected, expected_urls in [
            (
                '[![Figure 1][img-ref]](https://example.org/paper) and x]',
                '[![Figure 1][img-ref]](https://example.org/paper) and x]',
                [],
            ),
            (
                '[See ![FALL] note](https://example.org/paper) and x]',
                '[See ![FALL] note](https://example.org/paper) and x]',
                [],
            ),
            (
                '[![Figure 1][img-ref]](https://example.org/paper) and ![FALL] caption](https://example.org/f1.png)',
                '[![Figure 1][img-ref]](https://example.org/paper) and ![FALL\\] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '[See ![FALL] note](https://example.org/paper) and ![FALL] caption](https://example.org/f1.png)',
                '[See ![FALL] note](https://example.org/paper) and ![FALL\\] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '[Note: ![FALL] caption](https://example.org/f1.png) over [0, 1)]',
                '[Note: ![FALL\\] caption](https://example.org/f1.png) over [0, 1)]',
                ['https://example.org/f1.png'],
            ),
            (
                '[Note: ![Fig 1: array a][b]](https://example.org/f1.png) over [0, 1)]',
                '[Note: ![Fig 1: array a\\]\\[b\\]](https://example.org/f1.png) over [0, 1)]',
                ['https://example.org/f1.png'],
            ),
            (
                '[Panel a) in ![FALL] caption](https://example.org/f1.png)',
                '[Panel a) in ![FALL\\] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)

        # R13 Issue 6: open_stack.clear() & orphan ](doc "literal `") after completed ref/empty-paren/interval images
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters(
                r'![Fig 1: ![FALL] and x] tail](https://example.org/f1.png) and text](https://example.org/doc "literal `") and \[a < b\] and `end`'
            ),
            r'![Fig 1: !\[FALL\] and x\] tail](https://example.org/f1.png) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
        )
        for unchanged in [
            r'See ![Figure 1][img-ref] and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            r'See ![Figure 1][img-ref] and (0, 1] and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            r'See ![Figure 1]( ) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            r'See ![FALL] and (0, 1] and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
        ]:
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(unchanged), unchanged, unchanged)
            self.assertEqual(list(conf_gate._iter_markdown_images(unchanged)), [], unchanged)

    def test_wave4_r14_containers_indented_links_raw_html_and_exact_repairs(self):
        import conference_publication_gate as conf_gate
        import markdown_hugo_gate as mhg

        # R14 Issue 1: ASCII-only blank lines, case-insensitive Type 7 exclusion, indented code (§4.4), link ref defs (§4.7)
        for fake_doc in [
            '<div>\n\u3000\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</div>',
            'Intro.\n\n    ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)',
            'Intro.\n\n \t![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)',
            '[ref]: https://example.org/doc "![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)"',
            '[ref]: https://example.org/ref\n<span>\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</span>',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(fake_doc)), [], fake_doc)
            self.assertTrue(mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(fake_doc), 'Markdown'), fake_doc)

        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images('Para\n\u3000\n<span>\n![Real](https://example.org/real.png)\n</span>')],
            ['https://example.org/real.png'],
        )
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('<PRE/>\n![Real: [0, 1)](https://example.org/real.png)'),
            '<PRE/>\n![Real: \\[0, 1)](https://example.org/real.png)',
        )
        indented_keep = 'Intro.\n\n    ![Fig 1: [0, 1)](https://example.org/f1.png)'
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(indented_keep), indented_keep)
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('    `unclosed\n![Real: [0, 1)](https://example.org/real.png) `end`'),
            '    `unclosed\n![Real: \\[0, 1)](https://example.org/real.png) `end`',
        )
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('[ref]: https://example.org/doc "literal `"\n![Fig 1: [0, 1)](https://example.org/f1.png) `end`'),
            '[ref]: https://example.org/doc "literal `"\n![Fig 1: \\[0, 1)](https://example.org/f1.png) `end`',
        )

        # R14 Issue 2: list-item fences, blockquote fences/code/multiline images, ordered list item boundaries
        for list_fence in [
            '- ```\n  code\n  ```\n\n![Real: [0, 1)](https://example.org/real.png)',
            '1. ```\n   code\n   ```\n\n![Real: [0, 1)](https://example.org/real.png)',
        ]:
            rep = CONF_RENDER.repair_formula_delimiters(list_fence)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(rep)], ['https://example.org/real.png'], list_fence)
            self.assertIn('![Real: \\[0, 1)](https://example.org/real.png)', rep, list_fence)

        for bq_or_ol_fake in [
            '> ```\n> ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n> ```',
            '> `code\n> ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)`',
            '1. Item one ![e me $raw_dollar$ and **unclosed\n2. Item two](https://example.org/fake.png)',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(bq_or_ol_fake)), [], bq_or_ol_fake)
            self.assertTrue(mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(bq_or_ol_fake), 'Markdown'), bq_or_ol_fake)

        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images('> ![Real\n> caption](https://example.org/real.png)')],
            ['https://example.org/real.png'],
        )
        self.assertEqual(
            CONF_RENDER.repair_formula_delimiters('1. Item one `unclosed\n2. ![Real: [0, 1)](https://example.org/real.png) `end`'),
            '1. Item one `unclosed\n2. ![Real: \\[0, 1)](https://example.org/real.png) `end`',
        )

        # R14 Issue 3: raw HTML & autolinks preserved inside image alts and paren checks
        for raw, expected, expected_urls in [
            (
                '![Fig 1: <a title="a ` b"> [0, 1) and `x`](https://example.org/f1.png)',
                '![Fig 1: <a title="a ` b"> \\[0, 1) and `x`](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: <a title="a ` b"> (0, 1] and `x`](https://example.org/f1.png)',
                '![Fig 1: <a title="a ` b"> (0, 1\\] and `x`](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: <a title="]"> and [0, 1)](https://example.org/f1.png)',
                '![Fig 1: <a title="]"> and \\[0, 1)](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: <https://example.org/a[0]> and [0, 1)](https://example.org/f1.png)',
                '![Fig 1: <https://example.org/a[0]> and \\[0, 1)](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: <!-- [a] --> and [0, 1)](https://example.org/f1.png)',
                '![Fig 1: <!-- [a] --> and \\[0, 1)](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                r'[link <a title="("> x] and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                r'[link <a title="("> x] and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                [],
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(repaired, expected, raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)

        # R14 Issues 4, 5, 6, 7: surplus closers, can_peel_paren_link, has_prior_linked_img, effective_stack_metrics, scoped plain, tokenizer
        for raw, expected, expected_urls in [
            (
                '![Fig 1: [0, 1) curve](https://example.org/f1.png) and [0, 1) range](https://example.org/doc)',
                '![Fig 1: \\[0, 1) curve](https://example.org/f1.png) and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '[![Fig 1: [0, 1) curve](https://example.org/f1.png)][ref] and [0, 1) range](https://example.org/doc)',
                '[![Fig 1: \\[0, 1) curve](https://example.org/f1.png)][ref] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '[![Fig 1: [0, 1)](https://example.org/asset?id=1)][ref] and [0, 1) range](https://example.org/doc)',
                '[![Fig 1: \\[0, 1)](https://example.org/asset?id=1)][ref] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/asset?id=1'],
            ),
            (
                '![Fig 1: [0, 1) curve](https://example.org/f1.png) and ![FALL] over [0, 1)](https://example.org/f2.png)',
                '![Fig 1: \\[0, 1) curve](https://example.org/f1.png) and ![FALL\\] over \\[0, 1)](https://example.org/f2.png)',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                '![Fig 1: [item 1)](https://example.org/a) and ![FALL] note](https://example.org/f1.png)',
                '![Fig 1: \\[item 1)\\](https://example.org/a) and !\\[FALL\\] note](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '[![Fig 1: [1) a](https://example.org/a) and ![FALL] note](https://example.org/f1.png)](https://example.org/paper)',
                '[![Fig 1: \\[1) a\\](https://example.org/a) and !\\[FALL\\] note](https://example.org/f1.png)](https://example.org/paper)',
                ['https://example.org/f1.png'],
            ),
            (
                '[![Fig 1: [a, b)](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                '[![Fig 1: \\[a, b)](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '[![Fig 1](https://example.org/f1.png)][ref] and ![FALL] and [0, 1) range](https://example.org/doc)',
                '[![Fig 1](https://example.org/f1.png)][ref] and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '[Note: ![Fig 1](https://example.org/f1.png)] and ![FALL] and [0, 1) range](https://example.org/doc)',
                '[Note: ![Fig 1](https://example.org/f1.png)] and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [0, 1)](https://example.org/f1.png) and ![FALL] and [panel a)](https://example.org/doc)',
                '![Fig 1: \\[0, 1)](https://example.org/f1.png) and ![FALL] and [panel a)](https://example.org/doc)',
                ['https://example.org/f1.png'],
            ),
            (
                '[Note: [![Figure 1][img-ref]](https://example.org/paper)] and x]',
                '[Note: [![Figure 1][img-ref]](https://example.org/paper)] and x]',
                [],
            ),
            (
                '[See ![FALL] note](https://example.org/f1.png) and x]',
                '[See ![FALL] note](https://example.org/f1.png) and x]',
                [],
            ),
            (
                '[[x] Panel a) in ![FALL] caption](https://example.org/f1.png)',
                '[[x] Panel a) in ![FALL\\] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
            ),
            (
                '[[x] ![FALL] caption](https://example.org/f1.png)]',
                '[[x] ![FALL\\] caption](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
            ),
            (
                '[Intro: ![Fig 0](https://example.org/f0.png)] and FALL: ![e me — ![Fig 1: [a]](https://example.org/f1.png) and x]',
                '[Intro: ![Fig 0](https://example.org/f0.png)] and FALL: ![e me — ![Fig 1: \\[a\\]](https://example.org/f1.png) and x]',
                ['https://example.org/f0.png', 'https://example.org/f1.png'],
            ),
            (
                r'![Fig 1: [0, 1)](https://example.org/f1.png) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                r'![Fig 1: \[0, 1)](https://example.org/f1.png) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/f1.png'],
            ),
            (
                '![Fig 1: [0, 1)](https://example.org/f1.png) and text](not-a-link "![Fig 2: [2, 3)](https://example.org/f2.png)")',
                '![Fig 1: \\[0, 1)](https://example.org/f1.png) and text](not-a-link "![Fig 2: \\[2, 3)](https://example.org/f2.png)")',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
            ),
            (
                r'See ![Figure 1][img-ref] and text](https://example.org/doc.png "literal `") and \[a < b\] and `end`',
                r'See ![Figure 1][img-ref] and text](https://example.org/doc.png "literal `") and \[a < b\] and `end`',
                [],
            ),
            (
                r'See ![Figure 1]( ) and text](https://example.org/doc.png "literal `") and \[a < b\] and `end`',
                r'See ![Figure 1]( ) and text](https://example.org/doc.png "literal `") and \[a < b\] and `end`',
                [],
            ),
            (
                '[outer [inner](https://example.org/a)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                '[outer [inner](https://example.org/a)](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
            ),
            (
                r'[outer [inner](https://example.org/a)](https://example.org/b "literal `") and \[a < b\] and `end`',
                r'[outer [inner](https://example.org/a)](https://example.org/b "literal `") and \[a < b\] and `end`',
                [],
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            self.assertEqual(repaired, expected, raw)

    def test_wave4_r15_tabstops_nested_containers_blockquote_inline_and_renderer_exactness(self):
        import markdown_hugo_gate as mhg

        # Issue 1: exact 4-column tab stops across blockquote markers and list indents
        md_tab1 = '   >\t ```\n   > ![Real: [0, 1)](https://example.org/real.png)\n   > $raw_dollar$ and **unclosed'
        rep_tab1 = CONF_RENDER.repair_formula_delimiters(md_tab1)
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(rep_tab1)], ['https://example.org/real.png'])
        self.assertIn(r'![Real: \[0, 1)](https://example.org/real.png)', rep_tab1)

        md_tab2 = '   >\t ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)'
        self.assertEqual(list(conf_gate._iter_markdown_images(md_tab2)), [])
        self.assertTrue(bool(conf_gate._scan_commonmark_ignored_blocks(md_tab2)))

        for md_tab_real in [
            '  >\t  ![Real: [0, 1)](https://example.org/real.png)',
            '>>\t  ![Real: [0, 1)](https://example.org/real.png)',
            '- item\n\n  \t![Real](https://example.org/real.png)',
        ]:
            rep = CONF_RENDER.repair_formula_delimiters(md_tab_real)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(rep)], ['https://example.org/real.png'], md_tab_real)

        # Issue 2: interleaved containers (`- > ``` `), list-first-line link-ref-def, deeper bq resets in_paragraph,
        # lazy continuations preserved, empty list items cannot interrupt paragraphs and end on blank lines,
        # and multiline link-ref-defs stop at paragraph-interrupting blocks
        md_list_bq_fence = '- > ```\n  > code\n  > ```\n> ![Real: [0, 1)](https://example.org/real.png)'
        rep_lbf = CONF_RENDER.repair_formula_delimiters(md_list_bq_fence)
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(rep_lbf)], ['https://example.org/real.png'])
        self.assertIn(r'![Real: \[0, 1)](https://example.org/real.png)', rep_lbf)

        for md_gate_block in [
            '- > ```\n  > ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n  > ```',
            '10. item\n    > ~~~\n    > ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n    > ~~~',
            '- [ref]: https://example.org/doc "![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)"',
            '- [ref]: https://example.org/ref\n  <span>\n  ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n  </span>',
            'Para\n> <span>\n> ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n> </span>',
            'Para\n>     ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)',
            'Para\n> [ref]: https://example.org/doc "![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)"',
            '-\n\n    ![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(md_gate_block)), [], md_gate_block)

        for md_real_preserved in [
            '- item paragraph\n<span>\n![Real](https://example.org/real.png)\n</span>',
            '- item paragraph\n[ref]: https://example.org/doc "![Real](https://example.org/real.png)"',
            'Some paragraph text\n*\n<span>\n![Real](https://example.org/real.png)\n</span>',
            '> Para\n===\n<span>\n![Real](https://example.org/real.png)\n</span>',
            '[ref]: https://example.org/doc "unclosed title\n# ![Real](https://example.org/real.png)\n"',
        ]:
            self.assertEqual(
                [u for _, _, u in conf_gate._iter_markdown_images(md_real_preserved)],
                ['https://example.org/real.png'],
                md_real_preserved,
            )

        # Issue 3: nested list indents >=4, multi-paragraph ordered list sibling `2. `, Unicode whitespace after marker,
        # and blockquote continuation prefix stripping for multiline inline links/titles/HTML
        for md_split_bypass in [
            '   - outer\n     # Heading ![e me $raw_dollar$ and **unclosed\n     foo](https://example.org/fake.png)',
            '   - outer\n     - item 1 ![e me $raw_dollar$ and **unclosed\n     - item 2](https://example.org/fake.png)',
            '10. ![e me $raw_dollar$ and **unclosed\n    ===\n    foo](https://example.org/fake.png)',
            '1. item 1\n\n   para 2 ![e me $raw_dollar$ and **unclosed\n2. item 2](https://example.org/fake.png)',
            'Para ![e me $raw_dollar$ and **unclosed\n- \u3000foo](https://example.org/fake.png)',
            '> ![e me $raw_dollar$ and **unclosed\n> [x](https://example.org/a\n> "title ](https://example.org/fake.png)")',
            '> <a\n> title="![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)">x</a>',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(md_split_bypass)), [], md_split_bypass)
            self.assertTrue(bool(mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(md_split_bypass), 'Markdown')), md_split_bypass)

        self.assertEqual(
            [u for _, _, u in conf_gate._iter_markdown_images('> ![Real](https://example.org/real.png\n> "title")')],
            ['https://example.org/real.png'],
        )

        # Issues 4, 5, 6: renderer tokenizer, can_peel_paren_link, count_surplus_closers, has_prior_linked_img,
        # Step 1 nested note cap, and Step 2 unclosed_enclosing_brks_before
        for raw, expected_urls, expected_exact in [
            (
                '![Fig 1: [`` and `0, 1)`](https://example.org/doc) and (0, 1]](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '![Fig 1: see [0, 1) range](https://example.org/doc) and (0, 1]](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '![Fig 1: see [0, 1) range](https://example.org/doc) and x](https://example.org/f1.png "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                ['https://example.org/f1.png', 'https://example.org/real.png'],
                None,
            ),
            (
                '![FALL] and [inner](https://example.org/a) caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![FALL] caption](https://example.org/asset?id=1)](https://example.org/paper "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                ['https://example.org/asset?id=1', 'https://example.org/real.png'],
                None,
            ),
            (
                r'[outer [inner](#sec)](https://example.org/b "literal `") and \[a < b\] and `end`',
                [],
                r'[outer [inner](#sec)](https://example.org/b "literal `") and \[a < b\] and `end`',
            ),
            (
                r'[outer [inner]()](https://example.org/b "literal `") and \[a < b\] and `end`',
                [],
                r'[outer [inner]()](https://example.org/b "literal `") and \[a < b\] and `end`',
            ),
            (
                '[outer [inner](<>)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer [inner](<>)](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '[outer [inner]()](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer [inner]()](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '[link `code\nspan` text](https://example.org/a "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                ['https://example.org/real.png'],
                None,
            ),
            (
                '[![Fig 1: [0, 1) curve](https://example.org/asset?id=1)][ref]',
                ['https://example.org/asset?id=1'],
                '[![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1)][ref]',
            ),
            (
                '[Note: ![Fig 1: [0, 1) curve](https://example.org/asset?id=1)]',
                ['https://example.org/asset?id=1'],
                '[Note: ![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1)]',
            ),
            (
                '[![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png) and [Note: ![FALL]]](https://example.org/paper)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: [![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png)](https://example.org/paper) over [0, 1)]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1](https://example.org/f1.png) over [0, 1)](https://example.org/p1) and ![FALL] and [2, 3) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1](https://example.org/f1.png) over [0, 1)][ref] and ![FALL] and [2, 3) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: ![Fig 1](https://example.org/f1.png) over [0, 1)] and ![FALL] and [2, 3) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1: ![FALL] here](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: [Inner: ![FALL] caption](https://example.org/f1.png)]]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Intro: (0, 1]] and FALL: ![e me — ![Fig 1: [a]](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                '[Intro: (0, 1]] and FALL: ![e me — ![Fig 1: \\[a\\]](https://example.org/f1.png)]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if expected_exact is not None:
                self.assertEqual(repaired, expected_exact, raw)

    def test_wave4_r16_commonmark_lazy_lrd_list_interrupt_inline_regions_and_deactivation(self):
        # R16 #1: Lazy continuation in blockquote LRDs (gate bypass blocked + real image repaired)
        doc_lrd_bypass = '> [foo]: /url "line1\n"\n<span>\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</span>'
        self.assertEqual(list(conf_gate._iter_markdown_images(doc_lrd_bypass)), [])
        self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(doc_lrd_bypass), 'Markdown'))

        doc_lrd_real = '> [foo]: /url\n"literal `"\n![Real: [0, 1)](https://example.org/real.png) `end`'
        rep_lrd_real = CONF_RENDER.repair_formula_delimiters(doc_lrd_real)
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(rep_lrd_real)], ['https://example.org/real.png'])

        # R16 #2: List-marker paragraph-interruption rule across matched < len(stack) vs matched == len(stack)
        for doc in [
            '- item ![e me $raw_dollar$ and **unclosed\n2. sibling](https://example.org/fake.png)',
            '> para ![e me $raw_dollar$ and **unclosed\n2. sibling](https://example.org/fake.png)',
            '- item ![e me $raw_dollar$ and **unclosed\n*\nfoo](https://example.org/fake.png)',
            '1. item ![e me $raw_dollar$ and **unclosed\n2.\nfoo](https://example.org/fake.png)',
            '> - item ![Fake: $raw$ and **unclosed\n> 2. foo](https://example.org/f.png)',
            '> > para ![Fake: $raw$ and **unclosed\n> 2. foo](https://example.org/f.png)',
        ]:
            self.assertEqual(list(conf_gate._iter_markdown_images(doc)), [], doc)
            self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(doc), 'Markdown'), doc)

        doc_real_ol = '1. item ![Real\n   2. child](https://example.org/r.png)'
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(doc_real_ol)], ['https://example.org/r.png'])

        # R16 #3: Nested empty container inside empty list item marks outer list non-empty
        for doc in [
            '-\n  -\n\n    ![Real](https://example.org/r.png)',
            '-\n  >\n\n    ![Real](https://example.org/r.png)',
        ]:
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(doc)], ['https://example.org/r.png'], doc)

        # R16 #4: Container-stripped inline_regions in escape_markdown_image_alts
        for raw, expected_urls, expected_exact in [
            (
                '> <a\n> title="![Fake: [0, 1)](https://example.org/fake.png)">x</a>',
                [],
                '> <a\n> title="![Fake: [0, 1)](https://example.org/fake.png)">x</a>',
            ),
            (
                '> <a\n> title="literal `"> ![Real: [0, 1)](https://example.org/real.png) `end`',
                ['https://example.org/real.png'],
                '> <a\n> title="literal `"> ![Real: \\[0, 1)](https://example.org/real.png) `end`',
            ),
            (
                '> [x](https://example.org/a\n> "![Fake: [0, 1)](https://example.org/fake.png)")',
                [],
                '> [x](https://example.org/a\n> "![Fake: [0, 1)](https://example.org/fake.png)")',
            ),
            (
                '> [x](https://example.org/a\n> "literal `") ![Real: [0, 1)](https://example.org/real.png) `end`',
                ['https://example.org/real.png'],
                '> [x](https://example.org/a\n> "literal `") ![Real: \\[0, 1)](https://example.org/real.png) `end`',
            ),
            (
                '> ![Real: [0, 1)](https://example.org/real.png\n> "Panel a")',
                ['https://example.org/real.png'],
                '> ![Real: \\[0, 1)](https://example.org/real.png\n> "Panel a")',
            ),
            (
                '[link\ntext](https://example.org/a "![Fake: [0, 1)](https://example.org/fake.png)")',
                [],
                '[link\ntext](https://example.org/a "![Fake: [0, 1)](https://example.org/fake.png)")',
            ),
            (
                '[link `code\nspan`\n](https://example.org/a "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                ['https://example.org/real.png'],
                '[link `code\nspan`\n](https://example.org/a "literal `") and ![Real: \\[0, 1)](https://example.org/real.png) and `end`',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            self.assertEqual(repaired, expected_exact, raw)

        # R16 #5, #6, #7: §6.3 deactivation with OPEN_IMG below, opaque-URL intervals, multi-![FALL], wrapped opaque notes, unclosed interval BRKs
        for raw, expected_urls, expected_exact in [
            (
                '[outer ![FALL] [inner](https://example.org/a)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer ![FALL] [inner](https://example.org/a)](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '[outer ![FALL] [inner]()](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer ![FALL] [inner]()](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                r'[outer ![FALL] [inner](https://example.org/a)](https://example.org/b "literal `") and \[a < b\] and `end`',
                [],
                r'[outer ![FALL] [inner](https://example.org/a)](https://example.org/b "literal `") and \[a < b\] and `end`',
            ),
            (
                'FALL: ![e me — [outer [inner](https://example.org/a)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                'FALL: ![e me — [outer [inner](https://example.org/a)](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '![Fig 1: [0, 1) curve](https://example.org/asset?id=1) and text](not-a-link "![Real: [2, 3)](https://example.org/real.png)")',
                ['https://example.org/asset?id=1', 'https://example.org/real.png'],
                '![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1) and text](not-a-link "![Real: \\[2, 3)](https://example.org/real.png)")',
            ),
            (
                r'![Fig 1: [0, 1) curve](https://example.org/asset?id=1) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/asset?id=1'],
                r'![Fig 1: \[0, 1) curve](https://example.org/asset?id=1) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            (
                '![Fig 1: [0, 1) curve](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                '![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1)',
            ),
            (
                '[Note: ![Fig 1: [0, 1) curve](https://example.org/asset?id=1) caption](https://example.org/paper) and x]',
                ['https://example.org/asset?id=1'],
                '[Note: ![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1) caption](https://example.org/paper) and x]',
            ),
            (
                '[![Fig 1: [0, 1) range](https://example.org/a) and ![FALL] caption](https://example.org/f1.png)](https://example.org/paper)',
                ['https://example.org/f1.png'],
                '[![Fig 1: \\[0, 1) range\\](https://example.org/a) and !\\[FALL\\] caption](https://example.org/f1.png)](https://example.org/paper)',
            ),
            (
                '[![Fig 1: ![FALL1] and ![FALL2]](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: ![FALL] caption](https://example.org/asset?id=1)]',
                ['https://example.org/asset?id=1'],
                '[Note: ![FALL\\] caption](https://example.org/asset?id=1)]',
            ),
            (
                '[Outer: [Inner: ![FALL] caption](https://example.org/asset?id=1)]]',
                ['https://example.org/asset?id=1'],
                '[Outer: [Inner: ![FALL\\] caption](https://example.org/asset?id=1)]]',
            ),
            (
                '[Intro: (0, 1] and [2, 3)] and FALL: ![e me — ![Fig 1: [a]](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                '[Intro: (0, 1] and [2, 3)] and FALL: ![e me — ![Fig 1: \\[a\\]](https://example.org/f1.png)]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if expected_exact is not None:
                self.assertEqual(repaired, expected_exact, raw)

        # R16 #8: Dead leftovers removed
        self.assertFalse(hasattr(conf_gate, '_LIST_MARKER_RE'))
        self.assertFalse(hasattr(conf_gate, '_cm_effective_str'))

    def test_wave4_r17_setext_lrd_ref_links_cond_deact_and_step12_fixes(self):
        import markdown_hugo_gate as mhg

        # R17 #1: Setext underline at exact depth terminates incomplete LRD (label/title/dest) while keeping lazy & post-dest LRDs
        for bypass_md in [
            '[foo\n===\n<span>\n]: /url\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</span>',
            '[foo]: /url "\n===\n<span>\n"\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</span>',
            '[foo]: /url\n"title\n===\n<span>\n"\n![Fake: $raw_dollar$ and **unclosed](https://example.org/fake.png)\n</span>',
        ]:
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(bypass_md)], [], bypass_md)
            self.assertTrue(mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(bypass_md), 'Markdown'), bypass_md)
        dest_setext_md = '[foo]:\n===\n"![Real](https://example.org/real.png)"'
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(dest_setext_md)], ['https://example.org/real.png'])

        # R17 #2: CommonMark §4.7/§6.3/§6.4 full/collapsed/shortcut/forward ref links & empty-dest ref images
        for ref_bypass in [
            '[a]: https://example.org/a\n\n[outer [a]](https://example.org/b "literal `") ![Fake: ` $raw_dollar$ and **unclosed](https://example.org/fake.png)',
            '[a]: https://example.org/a\n\n[outer [a][]](https://example.org/b "literal `") ![Fake: ` $raw_dollar$ and **unclosed](https://example.org/fake.png)',
            '[ref]: https://example.org/a\n\n[outer [a][ref]](https://example.org/b "literal `") ![Fake: ` $raw_dollar$ and **unclosed](https://example.org/fake.png)',
            '[outer [a]](https://example.org/b "literal `") ![Fake: ` $raw_dollar$ and **unclosed](https://example.org/fake.png)\n\n[a]: https://example.org/a',
            '[img]: <>\n\n![outer ![Inner: $raw_dollar$ and **unclosed](https://example.org/in.png)][img]',
        ]:
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(ref_bypass)], [], ref_bypass)
            self.assertTrue(mhg.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(ref_bypass), 'Markdown'), ref_bypass)

        # R17 #2/#3/#4/#5/#6: Renderer exact repairs without image fabrication, real-image loss, or code-span corruption
        for raw, expected_urls, expected_exact in [
            (
                '[a]: https://example.org/a\n\n[outer [a]](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[a]: https://example.org/a\n\n[outer [a]](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '[a]: https://example.org/a\n\n[outer [a]](https://example.org/b "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                [],
                '[a]: https://example.org/a\n\n[outer [a]](https://example.org/b "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
            ),
            (
                '[outer ![Fig 1: [inner](https://example.org/a)]()](https://example.org/b "title ![Real](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer ![Fig 1: [inner](https://example.org/a)]()](https://example.org/b "title ![Real](https://example.org/real.png)")',
            ),
            (
                '[outer ![FALL [inner](https://example.org/a)] note](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer ![FALL [inner](https://example.org/a)] note](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '[outer ![FALL [inner](https://example.org/a)] note](https://example.org/b "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                [],
                '[outer ![FALL [inner](https://example.org/a)] note](https://example.org/b "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
            ),
            (
                'FALL: ![e me — [0, 1) [inner](https://example.org/a)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                'FALL: ![e me — [0, 1) [inner](https://example.org/a)](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '![Fig. 1: [0, 1) curve](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                '![Fig. 1: \\[0, 1) curve](https://example.org/asset?id=1)',
            ),
            (
                '![Figure 1 — [0, 1) curve](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                '![Figure 1 — \\[0, 1) curve](https://example.org/asset?id=1)',
            ),
            (
                '![Figure 1; [0, 1) curve](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                '![Figure 1; \\[0, 1) curve](https://example.org/asset?id=1)',
            ),
            (
                '![Fig 1: see [0, 1) range](https://example.org/doc) and (2, 3]](https://example.org/asset?id=2)',
                ['https://example.org/asset?id=2'],
                '![Fig 1: see \\[0, 1) range\\](https://example.org/doc) and (2, 3\\]](https://example.org/asset?id=2)',
            ),
            (
                r'![Fig 1: [0, 1)](https://example.org/asset?id=1) and text](https://example.org/doc.png "literal `") and \[a < b\] and `end`',
                ['https://example.org/asset?id=1'],
                r'![Fig 1: \[0, 1)](https://example.org/asset?id=1) and text](https://example.org/doc.png "literal `") and \[a < b\] and `end`',
            ),
            (
                r'![Fig 1: [0, 1) curve](https://example.org/asset?id=1) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/asset?id=1'],
                r'![Fig 1: \[0, 1) curve](https://example.org/asset?id=1) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            (
                '[![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png) and ![FALL] caption](https://example.org/p1)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1: [0, 1) range](https://example.org/a)](https://example.org/f1.png) and ![FALL] caption](https://example.org/p1)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: ![Fig 1: [0, 1) curve](https://example.org/asset?id=1) caption](https://example.org/paper) and [2, 3)]',
                ['https://example.org/asset?id=1'],
                '[Note: ![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1) caption](https://example.org/paper) and [2, 3)]',
            ),
            (
                '[Note: ![Fig 1: [0, 1) and ![FALL]](https://example.org/f1.png)] and ![FALL] and [2, 3) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1: [0, 1) and ![FALL]](https://example.org/f1.png)](https://example.org/p1) and FALL: ![e me — see [2, 3) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Intro: (see [Panel b)] and FALL: ![e me — ![Fig 1: [a]](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                '[Intro: (see [Panel b)] and FALL: ![e me — ![Fig 1: \\[a\\]](https://example.org/f1.png)]',
            ),
            (
                '[Note: [0, 1) and ![Fig 1: FALL: ![e me](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                '[Note: [0, 1) and ![Fig 1: FALL: !\\[e me](https://example.org/f1.png)]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if expected_exact is not None:
                self.assertEqual(repaired, expected_exact, raw)

        # R17 #7: Dead helper _commonmark_paragraph_limit removed
        self.assertFalse(hasattr(conf_gate, '_commonmark_paragraph_limit'))

    def test_wave4_r18_ws_shortcut_ref_images_nested_cond_deact_url_close_and_matched_img_masking(self):
        # R18 #1: Whitespace-only [ ] does NOT block CommonMark §4.7/§6.3 shortcut reference links/images
        ws_bypass = '[a]: https://example.org/a\n\n[outer [a][ ]](https://example.org/b "literal `") ![Fake: ` $raw_dollar$ and **unclosed](https://example.org/fake.png)'
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(ws_bypass)], [])
        self.assertTrue(hugo_gate.math_and_emphasis_issues(conf_gate.mask_markdown_image_alts(ws_bypass), 'Markdown'))
        ws_shortcut_img = '[img]: https://example.org/img.png\n\n![img][ ]'
        self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(ws_shortcut_img)], ['https://example.org/img.png'])

        for raw, expected_urls, expected_exact in [
            # R18 #1 renderer parity
            (
                '[a]: https://example.org/a\n\n[outer [a][ ]](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[a]: https://example.org/a\n\n[outer [a][ ]](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                '[a]: https://example.org/a\n\n[outer [a][ ]](https://example.org/b "literal `") and ![Fake: ` [0, 1)](https://example.org/fake.png)',
                [],
                '[a]: https://example.org/a\n\n[outer [a][ ]](https://example.org/b "literal `") and ![Fake: ` [0, 1)](https://example.org/fake.png)',
            ),
            # R18 #2: Resolved full/collapsed ref images & defined [ref] outer links
            (
                '[img]: https://example.org/img.png\n\n[![Figure 1][img]](https://example.org/paper)',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n[![Figure 1][img]](https://example.org/paper)',
            ),
            (
                '[figure 1]: https://example.org/img.png\n\n[![Figure 1][]](https://example.org/paper)',
                ['https://example.org/img.png'],
                '[figure 1]: https://example.org/img.png\n\n[![Figure 1][]](https://example.org/paper)',
            ),
            (
                '[ref]: https://example.org/paper\n\n[![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)][ref]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[ref]: https://example.org/paper\n\n[![FALL] caption](https://example.org/f1.png)][ref]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[ref]: https://example.org/paper\n\n[![FALL] caption](https://example.org/f1.png) over [0, 1)][ref]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[ref]: https://example.org/paper\n\n[![Fig 1: array a][b]](https://example.org/f1.png)][ref]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[ref]: https://example.org/paper\n\n[![Fig 1: FALL: ![e me](https://example.org/f1.png)][ref]',
                ['https://example.org/f1.png'],
                '[ref]: https://example.org/paper\n\n[![Fig 1: FALL: !\\[e me](https://example.org/f1.png)][ref]',
            ),
            # R18 #3: Nested OPEN_IMG conditional deactivation + deactivated-interval bypass
            (
                '[outer ![Fig 1: ![FALL [inner](https://example.org/a)] caption](https://example.org/f1.png)](https://example.org/b "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                ['https://example.org/f1.png', 'https://example.org/real.png'],
                None,
            ),
            (
                '[outer ![Fig 1: ![FALL [inner](https://example.org/a)] caption](https://example.org/f1.png)](https://example.org/b "title ![Fake: [0, 1)](https://example.org/fake.png)")',
                ['https://example.org/f1.png'],
                '[outer ![Fig 1: !\\[FALL \\[inner\\](https://example.org/a)\\] caption](https://example.org/f1.png)](https://example.org/b "title ![Fake: [0, 1)](https://example.org/fake.png)")',
            ),
            (
                'FALL: ![e me — [0, 1) [inner]()](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
            ),
            (
                'FALL: ![e me — [0, 1) [inner](#sec)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
            ),
            (
                'FALL: ![e me — [0, 1) [inner](<>)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
            ),
            (
                '[a]: https://example.org/a\n\nFALL: ![e me — [0, 1) [a]](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
            ),
            (
                '![Fig 1: [0, 1) and [inner](https://example.org/a)](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                None,
            ),
            # R18 #4: url_close, url_close_prose, & multi-sentence/See figure captions
            (
                '![Fig 1: range [0, 1) curve](https://example.org/doc) and (2, 3]](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '![Fig 1: range [0, 1) curve](https://example.org/doc) and x](https://example.org/f1.png "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
                ['https://example.org/f1.png', 'https://example.org/real.png'],
                None,
            ),
            (
                r'FALL: ![e me — see [0, 1) range](https://example.org/doc) and (0, 1]](https://example.org/paper "literal `") and \[a < b\] and `end`',
                [],
                r'FALL: ![e me — see [0, 1) range](https://example.org/doc) and (0, 1]](https://example.org/paper "literal `") and \[a < b\] and `end`',
            ),
            (
                '![Fig. 1: Overview of encoder. Range [0, 1) curve](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                None,
            ),
            (
                '![Fig. 1: See [0, 1) curve](https://example.org/asset?id=1)',
                ['https://example.org/asset?id=1'],
                None,
            ),
            # R18 #5: is_immediate_closed_img must not leak outer `[` when no caption follows closed OPEN_IMG
            (
                r'[![FALL]](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                [],
                r'[![FALL]](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            (
                '[![FALL]](https://example.org/paper) and text](https://example.org/doc "literal `") and ![Fake: [0, 1)](https://example.org/fake.png) and `end`',
                [],
                '[![FALL]](https://example.org/paper) and text](https://example.org/doc "literal `") and ![Fake: [0, 1)](https://example.org/fake.png) and `end`',
            ),
            (
                r'[![Figure 1][img-ref]](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                [],
                r'[![Figure 1][img-ref]](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            # R18 #6: broken_later_imgs PNG override & [Panel a) non-comma unpaired `)`
            (
                '[![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png) and ![FALL] caption](https://example.org/large.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1: [Panel a)](https://example.org/f1.png)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Panel a) ![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Panel a) ![Fig 1: array a][b]](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            # R18 #7: Step 2 enclosing_brks_before_k & unclosed_enclosing_brks_before across matched_img_spans
            (
                '[Intro: (0, 1]] and ![FALL] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Intro: [0, 1)] and ![FALL] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: ![Fig 1: (0, 1]](https://example.org/f1.png)] and FALL: ![e me — ![Fig 2: [a]](https://example.org/f2.png)]',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
                '[Note: ![Fig 1: (0, 1\\]](https://example.org/f1.png)] and FALL: ![e me — ![Fig 2: \\[a\\]](https://example.org/f2.png)]',
            ),
            (
                '[Note: ![Fig 1: [0, 1)](https://example.org/f1.png) and ![Fig 2: FALL: ![e me](https://example.org/f2.png)]',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
                '[Note: ![Fig 1: \\[0, 1)](https://example.org/f1.png) and ![Fig 2: FALL: !\\[e me](https://example.org/f2.png)]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if expected_exact is not None:
                self.assertEqual(repaired, expected_exact, raw)

    def test_wave4_r19_resolved_ref_pop_nested_img_deactivated_brk_paren_and_span_masking(self):
        for raw, expected_urls, expected_exact in [
            # R19 #1: Resolved ref/shortcut images popped from open_stack & unconditionally peeled in Step 1
            (
                '[img]: https://example.org/img.png\n\n![img] caption](https://example.org/paper)',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n![img] caption](https://example.org/paper)',
            ),
            (
                '[img]: https://example.org/img.png\n\n' + r'![Figure 1][img]](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n' + r'![Figure 1][img]](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            (
                '[img]: https://example.org/img.png\n\n' + r'[![Figure 1][img] caption](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n' + r'[![Figure 1][img] caption](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            (
                '[img]: https://example.org/img.png\n\n[![Fig 1: a)][img]](https://example.org/paper)',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n[![Fig 1: a)][img]](https://example.org/paper)',
            ),
            (
                '[img]: https://example.org/img.png\n\n[![Fig 1: (a][img]](https://example.org/paper)',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n[![Fig 1: (a][img]](https://example.org/paper)',
            ),
            (
                '[img]: https://example.org/img.png\n\n[outer ![Fig 1: [inner](https://example.org/a)][img]](https://example.org/b "literal `") and ![Fake: ` [0, 1)](https://example.org/fake.png)',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n[outer ![Fig 1: [inner](https://example.org/a)][img]](https://example.org/b "literal `") and ![Fake: ` [0, 1)](https://example.org/fake.png)',
            ),
            # R19 #2: Step 2 `earlier` image-stealing must not steal inner nested image
            (
                '[![Fig 1: ![sub](https://example.org/sub.png)](https://example.org/f1.png)](https://example.org/paper)',
                ['https://example.org/f1.png'],
                '[![Fig 1: ![sub](https://example.org/sub.png)](https://example.org/f1.png)](https://example.org/paper)',
            ),
            (
                '[Note: ![Fig 1: ![sub](https://example.org/sub.png)](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                '[Note: ![Fig 1: ![sub](https://example.org/sub.png)](https://example.org/f1.png)]',
            ),
            (
                '[img]: https://example.org/img.png\n\n[![Fig 1: ![sub](https://example.org/sub.png)][img]](https://example.org/paper)',
                ['https://example.org/img.png'],
                '[img]: https://example.org/img.png\n\n[![Fig 1: ![sub](https://example.org/sub.png)][img]](https://example.org/paper)',
            ),
            # R19 #3: Deactivated OPEN_BRK with closed OPEN_IMG above or [Panel a) inside
            (
                '[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![FALL [inner](https://example.org/a)] caption](https://example.org/f1.png)](https://example.org/b)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '![Fig 1: [Panel a) and [inner](https://example.org/a)](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                r'![Fig 1: [Panel a)](https://example.org/f1.png) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/f1.png'],
                r'![Fig 1: \[Panel a)](https://example.org/f1.png) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            (
                r'[![Fig 1: [Panel a)](https://example.org/f1.png)](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
                ['https://example.org/f1.png'],
                r'[![Fig 1: \[Panel a)](https://example.org/f1.png)](https://example.org/paper) and text](https://example.org/doc "literal `") and \[a < b\] and `end`',
            ),
            # R19 #4: OPEN_BRK with unpaired `(` always pops/deactivates per CommonMark §6.3
            (
                '[outer [inner (a]()](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                '[outer [inner (a]()](https://example.org/b "title ![Real: \\[0, 1)](https://example.org/real.png)")',
            ),
            (
                r'[outer [inner (a](#sec)](https://example.org/b "literal `") and \[a < b\] and `end`',
                [],
                r'[outer [inner (a](#sec)](https://example.org/b "literal `") and \[a < b\] and `end`',
            ),
            (
                r'[other (0, 1]](https://example.org/p2 "literal `") and \[a < b\] and `end`',
                [],
                r'[other (0, 1]](https://example.org/p2 "literal `") and \[a < b\] and `end`',
            ),
            # R19 #5: url_close_prose accepts non-.png outer closer when no unmatched `]` intervened
            (
                'FALL: ![e me — see [0, 1) range](https://example.org/doc) text](https://example.org/paper "literal `") and ![Real: [2, 3)](https://example.org/real.png) and `end`',
                ['https://example.org/paper', 'https://example.org/real.png'],
                'FALL: ![e me — see \\[0, 1) range\\](https://example.org/doc) text](https://example.org/paper "literal `") and ![Real: \\[2, 3)](https://example.org/real.png) and `end`',
            ),
            # R19 #6: [Panel b) in all_extra_opens_are_intervals & has_prior_linked_img
            (
                '[![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png) over [Panel b)](https://example.org/paper)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[Note: ![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png) over [Panel b)]',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1](https://example.org/f1.png) over [Panel a)](https://example.org/p1) and ![FALL] and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                None,
            ),
            (
                '[![Fig 1](https://example.org/f1.png) and ![Fig 2: [0, 1) range](https://example.org/a)](https://example.org/f2.png)](https://example.org/paper)',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
                None,
            ),
            # R19 #7: Mask closed spans in effective_stack_metrics & Step 1 peeled spans in Step 2
            (
                '[![Fig 1: b)](https://example.org/f1.png) and ![Figure 2][img-ref]](https://example.org/paper)',
                ['https://example.org/f1.png'],
                '[![Fig 1: b)](https://example.org/f1.png) and ![Figure 2][img-ref]](https://example.org/paper)',
            ),
            (
                '[Note: [1) a](https://example.org/a) and ![Fig 1: FALL: ![e me](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                '[Note: [1) a](https://example.org/a) and ![Fig 1: FALL: !\\[e me](https://example.org/f1.png)]',
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if expected_exact is not None:
                self.assertEqual(repaired, expected_exact, raw)

    def test_wave4_r20_skipped_close_ref_interval_unwind_deact_outer_closer_and_exact_cm_spans(self):
        for raw, expected_urls, must_contain, must_not_contain in [
            # R20 #1: had_skipped_close prevents full ref resolution against artificially open OPEN_IMG
            (
                '[img]: https://example.org/img.png\n\n[outer ![Fig 1: (0, 1]][img]](https://example.org/b "literal `") and \\[a < b\\] and `end`',
                [],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                '[img]: https://example.org/img.png\n\n[outer ![Fig 1: (0, 1]][img]](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                r'![Real: \[0, 1)](https://example.org/real.png)',
                None,
            ),
            # R20 #2: unwind interval BRKs before marking has_img + block crossing peeled_ref_img_spans
            (
                '[img]: https://example.org/img.png\n\n![FALL] and [0, 1) and ![img] and [2, 3) range](https://example.org/doc)',
                ['https://example.org/img.png'],
                None,
                None,
            ),
            (
                '![FALL] and [0, 1) and ![Figure 1][img-ref] and [2, 3) range](https://example.org/doc)',
                [],
                None,
                None,
            ),
            (
                '[Note: [0, 1) and ![Fig 1](https://example.org/f1.png) and [2, 3) range](https://example.org/doc) and ![Fig 2: FALL: ![e me](https://example.org/f2.png)]',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
                r'!\[e me',
                None,
            ),
            (
                '[img]: https://example.org/img.png\n\nFALL: ![e me and ![img] and [2, 3) range](https://example.org/doc)',
                ['https://example.org/img.png'],
                None,
                None,
            ),
            # R20 #3: surplus_total upper bound preserves valid nested images inside [Note: ... tail] & saw_closed_non_img_url on outer .png link
            (
                '[Note: ![Fig 1: ![sub](https://example.org/sub.png)](https://example.org/f1.png) tail]',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[Note: [![Fig 1: ![sub](https://example.org/sub.png)](https://example.org/f1.png)](https://example.org/paper) tail]',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[![Fig 1: FALL: ![e me](https://example.org/f1.png)](https://example.org/f1.png) and [0, 1) range](https://example.org/doc)',
                ['https://example.org/f1.png'],
                r'!\[e me',
                None,
            ),
            # R20 #4: find_reparable_closed_img_above requires outer closer, preserves non-image url_close outer pop, cancels only repaired img
            (
                r'[![FALL [inner](https://example.org/a)] caption](https://example.org/b "literal `") and \[a < b\] and `end`',
                [],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                '[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
                None,
            ),
            (
                '[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "title ![Real: [0, 1)](https://example.org/real.png)") and [2, 3) range](https://example.org/doc)',
                ['https://example.org/real.png'],
                None,
                None,
            ),
            (
                r'[![FALL] caption](https://example.org/b) and text](not-a-link "literal `") and \[a < b\] and `end`',
                [],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                r'[outer ![Fig 1: [0, 1) curve](https://example.org/asset?id=1)](https://example.org/b) and more](https://example.org/c "literal `") and \[a < b\] and `end`',
                ['https://example.org/asset?id=1'],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                r'[outer ![FALL1 [inner](https://example.org/a)] and ![FALL2] caption](https://example.org/f1.png)](https://example.org/b "literal `") and \[a < b\] and `end`',
                ['https://example.org/f1.png'],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                '[outer ![FALL1 [inner](https://example.org/a)] and ![FALL2] caption](https://example.org/f1.png)](https://example.org/b "title ![Real: [0, 1)](https://example.org/real.png)")',
                ['https://example.org/f1.png', 'https://example.org/real.png'],
                None,
                None,
            ),
            # R20 #5: probe next_pos boundary & has_unpaired_close_paren skips inline link dest/title
            (
                r'FALL: ![e me — [outer [0, 1) [inner](https://example.org/a)](https://example.org/b.png "literal `") and \[a < b\] and `end`',
                [],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                'FALL: ![e me — [outer [inner](https://example.org/a "Panel a)")](https://example.org/b.png "title ![Real: [2, 3)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
                None,
            ),
            # R20 #6: OPEN_BRK with unpaired '(' pops on ](), ](not-url), shortcut ref, plain ], and resolved ref [1) a][ref] peels
            (
                '[foo (bar]() and ![FALL] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[foo (bar](not-url) and ![FALL] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[foo (bar] and ![FALL] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[(a]: https://example.org/a\n\n[(a] and ![FALL] caption](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[ref]: https://example.org/a\n\n[Note: [1) a][ref] and ![Fig 1: FALL: ![e me](https://example.org/f1.png)]',
                ['https://example.org/f1.png'],
                r'!\[e me',
                None,
            ),
            # R20 #7: url_close_prose never bypasses had_intervening_unmatched_close even for .png URLs
            (
                r'FALL: ![e me — see [0, 1) range](https://example.org/doc) and x] and text](https://example.org/paper.png "literal `") and \[a < b\] and `end`',
                [],
                r'\[a < b\]',
                r'\lt',
            ),
            (
                'FALL: ![e me — see [0, 1) range](https://example.org/doc) and x] and text](https://example.org/paper.png "title ![Real: [2, 3)](https://example.org/real.png)")',
                ['https://example.org/real.png'],
                None,
                None,
            ),
            # R20 #8: effective_stack_metrics limit_pos=ref_pos & note_wrapper_count_on_stack excludes [Panel a)
            (
                '![Fig 1: [0, 1) and [1) a](https://example.org/a)](https://example.org/f1.png)',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[![Fig 1: [0, 1) and [1) a](https://example.org/a)](https://example.org/f1.png)](https://example.org/paper)',
                ['https://example.org/f1.png'],
                None,
                None,
            ),
            (
                '[Panel a) [![Fig 1: [0, 1) curve](https://example.org/asset?id=1) caption](https://example.org/paper)]',
                ['https://example.org/asset?id=1'],
                None,
                None,
            ),
            # R20 #9: mask peeled_spans across Step 1/2 & allow internal links inside note wrappers after an image
            (
                '[img]: https://example.org/img.png\n\nFALL: ![e me — [see ![Fig 2: b)][img] text](https://example.org/doc.png)',
                ['https://example.org/img.png'],
                None,
                None,
            ),
            (
                '[img]: https://example.org/img.png\n\n[![Fig 1: FALL: ![e me](https://example.org/f1.png)](https://example.org/f1.png) and [see ![Fig 2: b)][img] text](https://example.org/doc)',
                ['https://example.org/f1.png', 'https://example.org/img.png'],
                r'!\[e me',
                None,
            ),
            (
                '[Note: ![Fig 1](https://example.org/f1.png) and [1) a](https://example.org/a) and ![Fig 2: FALL: ![e me](https://example.org/f2.png)]',
                ['https://example.org/f1.png', 'https://example.org/f2.png'],
                r'!\[e me',
                None,
            ),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if must_contain is not None:
                self.assertIn(must_contain, repaired, raw)
            if must_not_contain is not None:
                self.assertNotIn(must_not_contain, repaired, raw)

    def test_wave4_r21_math_raw_html_ref_spans_skipped_count_deact_outer_broken_later_and_nested_img(self):
        import conference_publication_gate as conf_gate
        # R21 #1 & #2: TeX math `<tag>` / autolink precedence + full/collapsed/shortcut ref links & empty-dest images
        for raw, expected in [
            (r'\(f<T>(x)\)', r'\(f\lt T\gt (x)\)'),
            (r'\[x < y \text{ with } <EOS>\]', r'\[x \lt  y \text{ with } \lt EOS\gt \]'),
            (r'\\(a <x> b\\)', r'\(a \lt x\gt  b\)'),
            (r'\(a <xy:z> b\)', r'\(a \lt xy:z\gt  b\)'),
            ('<a title="\\(a < b\\)">x</a> \\(f<T>(x)\\)', '<a title="\\(a < b\\)">x</a> \\(f\\lt T\\gt (x)\\)'),
            ('[\\(a < b\\)]: https://example.org/a\n\n[see][\\(a < b\\)]', '[\\(a < b\\)]: https://example.org/a\n\n[see][\\(a < b\\)]'),
            ('[\\[a < b\\]]: https://example.org/a\n\n[see][\\[a < b\\]]', '[\\[a < b\\]]: https://example.org/a\n\n[see][\\[a < b\\]]'),
            ('[a \\[ b]: https://example.org/1\n[c \\] d]: https://example.org/2\n\n[x][a \\[ b] and p < 0.05 and [y][c \\] d]',
             '[a \\[ b]: https://example.org/1\n[c \\] d]: https://example.org/2\n\n[x][a \\[ b] and p < 0.05 and [y][c \\] d]'),
            ('[img]: <>\n\n![a \\[ b][img] and p < 0.05 and ![c \\] d][img]',
             '[img]: <>\n\n![a \\[ b][img] and p < 0.05 and ![c \\] d][img]'),
            ('![\\[a < b\\]](<>)', '![\\[a < b\\]](<>)'),
            # R21 #9a & #9b: internal [Panel a)] inside note wrappers & trailing text note wrapper
            ('[Note: ![Fig 1](https://example.org/f1.png) and [Panel a)](https://example.org/a) and ![Fig 2: FALL: ![e me](https://example.org/f2.png)]',
             '[Note: ![Fig 1](https://example.org/f1.png) and [Panel a)](https://example.org/a) and ![Fig 2: FALL: !\\[e me](https://example.org/f2.png)]'),
            ('[ref]: https://example.org/a\n\n[Note: ![Fig 1](https://example.org/f1.png) and [Panel a)][ref] and ![Fig 2: FALL: ![e me](https://example.org/f2.png)]',
             '[ref]: https://example.org/a\n\n[Note: ![Fig 1](https://example.org/f1.png) and [Panel a)][ref] and ![Fig 2: FALL: !\\[e me](https://example.org/f2.png)]'),
            ('[Note: ![Fig 1: FALL: ![e me](https://example.org/f1.png) tail]',
             '[Note: ![Fig 1: FALL: !\\[e me](https://example.org/f1.png) tail]'),
        ]:
            got = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(got, expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(got), got, raw)

        # R21 #3..#9 image & idempotence cases
        for raw, expected_urls, exact_expected in [
            # #3a, #3b, #3c
            ('[b]: https://example.org/b\n\n[outer ![Fig 1: (0, 1] [inner](https://example.org/a)][b](https://example.org/c "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
             ['https://example.org/real.png'], None),
            ('[b]: https://example.org/b\n\n[outer ![Fig 1: (0, 1] [inner](https://example.org/a)][b](https://example.org/c "title ![Real: [0, 1)](https://example.org/real.png)")',
             [], '[b]: https://example.org/b\n\n[outer ![Fig 1: (0, 1] [inner](https://example.org/a)][b](https://example.org/c "title ![Real: [0, 1)](https://example.org/real.png)")'),
            ('[b]: https://example.org/b\n\n[outer ![Fig 1: (0, 1] and (2, 3]][b](https://example.org/c "literal `") and ![Real: [0, 1)](https://example.org/real.png) and `end`',
             ['https://example.org/real.png'], None),
            ('[outer]: https://example.org/outer\n\n[outer ![Fig 1: (0, 1]][outer] and [0, 1)](https://example.org/doc)',
             [], '[outer]: https://example.org/outer\n\n[outer ![Fig 1: (0, 1]][outer] and [0, 1)](https://example.org/doc)'),
            # #4a & #4b
            ('[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "literal `") and text][ref] and \\[a < b\\] and `end`',
             [], '[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "literal `") and text][ref] and \\[a < b\\] and `end`'),
            ('[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "title ![Real: [0, 1)](https://example.org/real.png)") and text](https://example.org/doc)',
             ['https://example.org/real.png'], None),
            ('[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "literal `") and text](https://example.org/doc) and ![Real: [0, 1)](https://example.org/real.png) and `end`',
             [], '[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png "literal `") and text](https://example.org/doc) and ![Real: [0, 1)](https://example.org/real.png) and `end`'),
            ('[![FALL [inner](https://example.org/a)] caption](https://example.org/f1.png "literal `") and [sub](https://example.org/s) text](https://example.org/b) and ![Real: [0, 1)](https://example.org/real.png) and `end`',
             [], '[![FALL [inner](https://example.org/a)] caption](https://example.org/f1.png "literal `") and [sub](https://example.org/s) text](https://example.org/b) and ![Real: [0, 1)](https://example.org/real.png) and `end`'),
            ('[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png) tail]',
             ['https://example.org/f1.png'], None),
            ('[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/f1.png) over [0, 1)]',
             ['https://example.org/f1.png'], None),
            ('[Note: [link](https://example.org/a) and ![FALL] caption](https://example.org/asset?id=1)]',
             ['https://example.org/asset?id=1'], None),
            # #5
            ('[Panel a)]: https://example.org/a\n\nFALL: ![e me — [outer [inner][Panel a)]](https://example.org/b.png "title ![Real: [2, 3)](https://example.org/real.png)")',
             ['https://example.org/real.png'], None),
            ('FALL: ![e me — [outer [1) a](https://example.org/a)](https://example.org/b.png "title ![Real: [2, 3)](https://example.org/real.png)")',
             ['https://example.org/real.png'], None),
            ('FALL: ![e me — [outer [1) a](https://example.org/a)]',
             [], 'FALL: ![e me — [outer [1) a](https://example.org/a)]'),
            ('FALL: ![e me — [outer [1) a](https://example.org/a)](https://example.org/b)',
             [], 'FALL: ![e me — [outer [1) a](https://example.org/a)](https://example.org/b)'),
            # #6
            ('[Note: ![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png) and [x (y](https://example.org/b)]',
             ['https://example.org/f1.png'], None),
            ('[img]: https://example.org/img.png\n\n[![Fig 1: [1) a](https://example.org/a)](https://example.org/f1.png) and ![Fig 2: (a][img]][ref]',
             ['https://example.org/f1.png', 'https://example.org/img.png'], None),
            ('![FALL] and [x (y](https://example.org/a) caption](https://example.org/f1.png)',
             ['https://example.org/f1.png'], None),
            ('[Outer: [Inner: [0, 1)] and ![Fig 1: [0, 1) range](https://example.org/asset?id=1)](https://example.org/paper)',
             ['https://example.org/asset?id=1'], None),
            ('[[x] ![Fig 1: [1) a](https://example.org/a) and x](https://example.org/f1.png)]',
             ['https://example.org/f1.png'], None),
            # #7
            ('[![Fig 1: [0, 1) range](https://example.org/asset?id=1)](https://example.org/p1) and ![FALL] caption](https://example.org/f2.png)',
             ['https://example.org/asset?id=1', 'https://example.org/f2.png'], None),
            ('![Fig 1: [0, 1) range](https://example.org/asset?id=1) and ![FALL] caption](https://example.org/f2.png)',
             ['https://example.org/asset?id=1', 'https://example.org/f2.png'], None),
            # #8
            ('![Fig 1: [0, 1) curve](https://example.org/asset?id=1) and x] and text](https://example.org/paper.png "literal `") and \\[a < b\\] and `end`',
             ['https://example.org/asset?id=1'],
             '![Fig 1: \\[0, 1) curve](https://example.org/asset?id=1) and x] and text](https://example.org/paper.png "literal `") and \\[a < b\\] and `end`'),
            ('![Fig 1: [0, 1) curve](https://example.org/asset?id=1) and x] and text](https://example.org/paper.png "title ![Real: [2, 3)](https://example.org/real.png)")',
             ['https://example.org/asset?id=1', 'https://example.org/real.png'], None),
            # #9c & #9d
            ('[ref]: https://example.org/paper\n\n[![Fig 1: FALL: ![e me](https://example.org/f1.png)][ref] and [0, 1) range](https://example.org/doc)',
             ['https://example.org/f1.png'], None),
            ('![Fig 1: ![sub](https://example.org/sub.png) over [0, 1)](https://example.org/f1.png)',
             ['https://example.org/f1.png'], None),
            ('[sub]: https://example.org/sub.png\n\n![Fig 1: ![sub] over [0, 1)](https://example.org/f1.png)',
             ['https://example.org/f1.png'], None),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if exact_expected is not None:
                self.assertEqual(repaired, exact_expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(repaired), repaired, f'idempotence: {raw}')

        idem = '![Fig 1: (a][img][0, 1) range](https://example.org/doc)[1) a][ref]![Fig 1: a)][img]](https://example.org/b "Panel a)")'
        p1 = CONF_RENDER.repair_formula_delimiters(idem)
        self.assertEqual(CONF_RENDER.repair_formula_delimiters(p1), p1)

    def test_wave4_r22_live_set_raw_html_frontmatter_blockquote_empty_img_outer_closer_and_perf(self):
        import time
        import conference_publication_gate as conf_gate

        # R22 #2 & #3: raw HTML / autolink / comment non-duplication, YAML frontmatter, blockquote, cross-paragraph
        for raw, expected in [
            ('Literal \\( then <a title="\\(a < b\\)">link</a>', 'Literal \\( then <a title="\\(a < b\\)">link</a>'),
            (r'\(a <http://x/\)> b', r'\(a <http://x/\)> b'),
            (r'\(a <!-- b \) -->', r'\(a <!-- b \) -->'),
            (r'\(a <b c=x\)> d', r'\(a <b c=x\)> d'),
            ('---\ntitle: "Study of \\\\(a < b\\\\) in Audio"\n---\n\nBody.\n',
             '---\ntitle: "Study of \\\\(a < b\\\\) in Audio"\n---\n\nBody.\n'),
            ('> \\[\n> x < y\n> \\]', '> \\[\n> x \\lt  y\n> \\]'),
            ('Para 1 \\(a\n\n> quoted <tag> b\\)', 'Para 1 \\(a\n\n> quoted <tag> b\\)'),
        ]:
            got = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual(got, expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(got), got, raw)

        # R22 #1, #4, #5, #6, #7, #8, #9, #10
        for raw, expected_urls, exact_expected in [
            ('[![Fig 1: ![sub](https://e.org/s.png) [0, 1) range](https://e.org/doc)](https://e.org/f1.png)',
             ['https://e.org/f1.png'], None),
            ('[Note: ![Fig 1: ![sub](https://e.org/s.png) [1) a](https://e.org/a)](https://e.org/f1.png)',
             ['https://e.org/f1.png'], None),
            ('[![empty]()](https://e.org/b)', [], '[![empty]()](https://e.org/b)'),
            ('[![empty](<>)](https://e.org/b)', [], '[![empty](<>)](https://e.org/b)'),
            ('![Fig 1: [Panel a)](https://e.org/pa) and ![empty]()](https://e.org/outer.png)',
             ['https://e.org/outer.png'], None),
            ('[eimg]: <>\n\n![empty]() ![empty][eimg]](https://e.org/f1.png "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`',
             [], '[eimg]: <>\n\n![empty]() ![empty][eimg]](https://e.org/f1.png "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`'),
            ('[a]: https://e.org/a\n\n[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [a][ ] text](https://e.org/b) and ![Real: [0, 1)](https://e.org/real.png) and `end`',
             [], '[a]: https://e.org/a\n\n[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [a][ ] text](https://e.org/b) and ![Real: [0, 1)](https://e.org/real.png) and `end`'),
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [1) a](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], '[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [1) a](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`'),
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [0, 1) range](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], '[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [0, 1) range](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`'),
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [Panel a)](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], '[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [Panel a)](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`'),
            ('![Fig 9: [Panel a)](https://e.org/pa)](https://e.org/outer.png)', ['https://e.org/outer.png'], None),
            ('FALL: ![e me — [Panel a)](https://e.org/pa)', [], 'FALL: ![e me — [Panel a)](https://e.org/pa)'),
            ('[![Fig 1: ![sub](https://e.org/s.png)](https://e.org/f5.png) and [e]()](https://e.org/outer)',
             ['https://e.org/f5.png'], None),
            ('[Note: ![Fig 1: ![sub](https://e.org/s.png)](https://e.org/f5.png)',
             ['https://e.org/f5.png'], None),
            ('[![Fig 1: ![sub](https://e.org/s.png)](https://e.org/f5.png) and ![Fig 1: a)](https://e.org/f1.png) and ![FALL] caption and [x (y](https://e.org/xy)](https://e.org/outer)',
             ['https://e.org/f5.png', 'https://e.org/f1.png'], None),
            ('[ref]: https://e.org/r\n\n![Fig 1: ![Fig 1: [0, 1) curve](https://e.org/asset?id=1) ][ref]](https://e.org/f1.png "title ![Trap: [0, 1)](https://e.org/trap.png)")',
             ['https://e.org/f1.png'], '[ref]: https://e.org/r\n\n![Fig 1: ![Fig 1: [0, 1) curve](https://e.org/asset?id=1) ][ref]](https://e.org/f1.png "title ![Trap: [0, 1)](https://e.org/trap.png)")'),
            ('[outer ![Fig 1: [1) a](https://e.org/a) cap](https://e.org/f3.png)', ['https://e.org/f3.png'], None),
            ('![Fig 9: ![Fig 1: [1) a](https://e.org/a) cap](https://e.org/f3.png)](https://e.org/outer.png)', ['https://e.org/outer.png'], None),
            ('![Fig 9: [0, 1) range](https://e.org/doc) and ![sub](https://e.org/sub.png)](https://e.org/asset?id=9)', ['https://e.org/asset?id=9'], None),
            ('[a]: https://e.org/a\n[img]: https://e.org/img.png\n\nFALL: ![e me — (0, 1] ![cap][img] (0, 1] [a][ ]](https://e.org/f1.png "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`',
             ['https://e.org/img.png'], '[a]: https://e.org/a\n[img]: https://e.org/img.png\n\nFALL: ![e me — (0, 1] ![cap][img] (0, 1] [a][ ]](https://e.org/f1.png "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`'),
            ('[outer ![Fig 1: (0, 1]](not-url "literal `") and text](https://e.org/p.png) and ![Trap: [0, 1)](https://e.org/trap.png) and `end`',
             ['https://e.org/trap.png'], None),
            ('[(0, 1] ![FALL] ![Fig 1: [0, 1) curve](https://e.org/asset?id=1)](https://e.org/asset?id=1 "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`',
             ['https://e.org/asset?id=1'],
             '[(0, 1] ![FALL] ![Fig 1: \\[0, 1) curve](https://e.org/asset?id=1)](https://e.org/asset?id=1 "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`'),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if exact_expected is not None:
                self.assertEqual(repaired, exact_expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(repaired), repaired, f'idempotence: {raw}')

        # R22 #11: Performance bounds (no O(N^3) blowup on nested images or sibling paren links)
        nested_600 = '[![a ' * 300 + '](https://e.org/f.png)' * 300
        t0 = time.perf_counter()
        CONF_RENDER.repair_formula_delimiters(nested_600)
        self.assertLess(time.perf_counter() - t0, 2.0, 'R22 #11 nested_600 must finish well under 2s')
        sibs_300 = '![Fig 1: ' + '[1) a](https://e.org/a) ' * 300 + '](https://e.org/f.png)'
        t0 = time.perf_counter()
        CONF_RENDER.repair_formula_delimiters(sibs_300)
        self.assertLess(time.perf_counter() - t0, 1.0, 'R22 #11 sibs_300 must finish well under 1s')

    def test_wave4_r23_nested_wrap_memo_idempotence_empty_img_frontmatter_and_perf(self):
        import time
        import conference_publication_gate as conf_gate

        # R23 #7: YAML frontmatter heuristic (reject thematic break with prose, accept quoted key & trailing spaces)
        for raw, expected_urls, exact_expected in [
            ('---\n\nNote: see \\(a < b\\) and ![Fig 1: [0, 1)](https://e.org/f.png)\n\n---\n',
             ['https://e.org/f.png'],
             '---\n\nNote: see \\(a \\lt  b\\) and ![Fig 1: \\[0, 1)](https://e.org/f.png)\n\n---\n'),
            ('---\n"title": "Study of \\\\(a < b\\\\)"\n---\n\nBody.\n',
             [], '---\n"title": "Study of \\\\(a < b\\\\)"\n---\n\nBody.\n'),
            ('---   \ntitle: "Study of \\\\(a < b\\\\)"\n---\n\nBody.\n',
             [], '---   \ntitle: "Study of \\\\(a < b\\\\)"\n---\n\nBody.\n'),
        ]:
            got = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(got)], expected_urls, raw)
            self.assertEqual(got, exact_expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(got), got, f'idempotence: {raw}')

        # R23 #1-#6: nested-image wrapping, orig_hard_prot/orig_images safety gate, memo cache, idempotence,
        # empty image wrapping, has_outer_closer_after, and tokenizer deactivation parity.
        for raw, expected_urls, exact_expected in [
            # #1
            ('FALL: ![e me, [![sub](https://e.org/sub.png) (note](https://e.org/f1.png)',
             ['https://e.org/sub.png'],
             'FALL: ![e me, [![sub](https://e.org/sub.png) (note](https://e.org/f1.png)'),
            ('![empty]()[![sub](https://e.org/sub.png) (note](https://e.org/f1.png)',
             ['https://e.org/sub.png'],
             '![empty]()[![sub](https://e.org/sub.png) (note](https://e.org/f1.png)'),
            ('![FALL][link](https://e.org/doc "title ![Fake: [0, 1)](https://e.org/fake.png)")[![sub](https://e.org/sub.png) (note](https://e.org/f9.png)',
             ['https://e.org/sub.png'],
             '![FALL][link](https://e.org/doc "title ![Fake: [0, 1)](https://e.org/fake.png)")[![sub](https://e.org/sub.png) (note](https://e.org/f9.png)'),
            ('![Fig 1: ![sub](https://e.org/sub.png) (a](https://e.org/outer.png)',
             ['https://e.org/outer.png'],
             '![Fig 1: ![sub](https://e.org/sub.png) (a](https://e.org/outer.png)'),
            # #2
            ('[r1]: https://e.org/r1\n\n[![Fig 1: (( [0, 1)][r1] ( ![e2](https://e.org/f2.png)][ref]](https://e.org/p1)',
             ['https://e.org/f2.png'],
             '[r1]: https://e.org/r1\n\n[![Fig 1: (( [0, 1)][r1] ( ![e2](https://e.org/f2.png)][ref]](https://e.org/p1)'),
            ('[r1]: https://e.org/r1\n[ref]: https://e.org/r\n\n[![Fig 1: (( [0, 1)][r1] ( ![e2](https://e.org/f2.png)][ref]](https://e.org/p1)',
             ['https://e.org/f2.png'], None),
            # #3a, #3b, #3c
            ('![Fig 1: [x [0, 1)](https://e.org/f2.png) ]](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/f2.png', 'https://e.org/real.png'], None),
            ('![empty]()![empty](<>)]](https://e.org/f1.png)![empty](<>)(0, 1]](https://e.org/f2.png)',
             ['https://e.org/f1.png', 'https://e.org/f2.png'], None),
            ('![[1) a](https://e.org/a)![][img]](https://e.org/b "Panel a)")](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)") ) ][a]](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/b', 'https://e.org/real.png', 'https://e.org/real.png'], None),
            # #4
            ('![Fig 1: [0, 1) and ![empty]()](https://e.org/outer.png)', ['https://e.org/outer.png'], None),
            ('![Fig 1: ![empty]() and [0, 1)](https://e.org/outer.png)', ['https://e.org/outer.png'], None),
            ('[![Fig 1: [0, 1) and ![empty]()](https://e.org/outer.png)](https://e.org/paper)', ['https://e.org/outer.png'], None),
            # #5a, #5b
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "title ![Real: [0, 1)](https://e.org/real.png)") and [0, 1) range](https://e.org/a)',
             ['https://e.org/real.png'], None),
            ('[img]: https://e.org/img.png\n\n[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png) and ![cap][img]](https://e.org/paper)',
             ['https://e.org/f1.png', 'https://e.org/img.png'], None),
            # #6a, #6b
            ('[outer ![Fig 1: (0, 1] [inner](https://e.org/a)](not-url "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/real.png'], None),
            ('[outer ![Fig 1: ![sub](https://e.org/s.png) [inner](https://e.org/i)](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/img.png', 'https://e.org/real.png'], None),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if exact_expected is not None:
                self.assertEqual(repaired, exact_expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(repaired), repaired, f'idempotence: {raw}')

        # R23 #8a & #8b: eliminate O(N^3) Step 2 performance blowups
        nested_rparen = '[' + '![a ' * 300 + '](https://e.org/f.png) )' * 300 + '](https://e.org/p)'
        t0 = time.perf_counter()
        CONF_RENDER.repair_formula_delimiters(nested_rparen)
        self.assertLess(time.perf_counter() - t0, 0.5, 'R23 #8a nested_rparen N=300 must finish well under 0.5s')
        nested_lparen = '[![a ' * 300 + '](https://e.org/f.png) (' * 300
        t0 = time.perf_counter()
        CONF_RENDER.repair_formula_delimiters(nested_lparen)
        self.assertLess(time.perf_counter() - t0, 0.8, 'R23 #8b nested_lparen N=300 must finish well under 0.8s')

    def test_wave4_r24_owning_brk_gate_memo_idempotence_empty_angle_outer_closer_skip_and_perf(self):
        import time
        import conference_publication_gate as conf_gate

        for raw, expected_urls, exact_expected in [
            # #1: owning `[` before nested image + closed linked image + closed `[Panel ![sub]]`
            ('FALL: ![e me, [![Keep](https://e.org/keep.png) over [0, 1)](https://e.org/f1.png)',
             ['https://e.org/keep.png'], None),
            ('FALL: ![e me, [![Keep](https://e.org/keep.png)](https://e.org/paper) over [0, 1)](https://e.org/f1.png)',
             ['https://e.org/keep.png'], None),
            ('![Fig 1: [Panel ![sub](https://e.org/sub.png)] over (0, 1]](https://e.org/outer.png)',
             ['https://e.org/outer.png'], None),
            # #2: right-side culprit swallowing into empty-dest `![...]()` + outer `[Panel a)/[Note:` code-span preservation
            ('![Outer: ![Keep](https://e.org/keep.png) ![Broken: [0, 1)](https://e.org/a)]()',
             ['https://e.org/keep.png'], None),
            ('[Panel a) ![FALL]](https://e.org/1.png)](https://e.org/doc "literal `") ![Fake: [0, 1)](https://e.org/p.png) `end`',
             [], None),
            ('[Note: ![FALL])](https://e.org/1.png)](https://e.org/doc "literal `") ![Fake: [0, 1)](https://e.org/p.png) `end`',
             [], None),
            # #3: memo cache boundary across `][r2](https://e.org/x "title (")`
            ('[r1]: https://e.org/r1\n[r2]: https://e.org/r2\n\n[![outer ![a1 ![s1](https://e.org/s1.png)][r1] ![a2 ![s2](https://e.org/s2.png)][r2](https://e.org/x "title (") ][r3]',
             ['https://e.org/r1', 'https://e.org/r2'], None),
            # #4: idempotence across non-.png p2 unwind, closed OPEN_IMG, deactivated OPEN_BRK, and broken later ![FALL]]
            ('![Fig 1: [x [0, 1)](https://e.org/asset?id=2) ]](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/asset?id=2', 'https://e.org/real.png'], None),
            ('![[[)](/a)![]](p.png)',
             ['/a', 'p.png'], None),
            ('![Fig 1: ![FALL] [0, 1)](https://e.org/f1.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/f1.png', 'https://e.org/real.png'], None),
            ('![Fig 1: [x [0, 1) [inner](https://e.org/a)](https://e.org/f2.png) ]](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/f2.png', 'https://e.org/real.png'], None),
            ('![Fig 1: [0, 1)](https://e.org/asset?id=1)] ![FALL]](https://e.org/asset?id=2)',
             ['https://e.org/asset?id=1', 'https://e.org/asset?id=2'], None),
            ('![[)](/i)]![]](/1)',
             ['/i', '/1'], None),
            # #5: ![empty](<>) symmetry with ![empty]()
            ('[[![empty](<>)![Keep](https://e.org/keep.png) (0, 1]](https://e.org/f1.png)',
             ['https://e.org/keep.png'], None),
            ('![Outer: ![empty](<>) ![FALL] [0, 1)](https://e.org/f1.png)',
             ['https://e.org/f1.png'],
             '![Outer: !\\[empty\\](<>) !\\[FALL\\] \\[0, 1)](https://e.org/f1.png)'),
            # #6: has_outer_closer_after standalone inline/ref link & whitespace `[ ]`
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [0, 1)](https://e.org/a) and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], None),
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and text][ ] and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], None),
            ('[![FALL [inner](https://e.org/i)] caption](https://e.org/f1.png "literal `") and [0, 1) range][ref] and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], None),
            # #7: l_skip > 0 on ](), Step-2-wrap predicate in nested-image deactivation, & url_close cond_group
            ('[outer ![Fig 1: (0, 1]]() and text](https://e.org/b "literal `") and ![Fake: [0, 1)](https://e.org/fake.png) and `end`',
             [], None),
            ('[outer ![Fig 1: ![sub](https://e.org/s.png) [inner](https://e.org/i) (note](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/img.png', 'https://e.org/real.png'], None),
            ('[outer ![Fig 1: ![sub](https://e.org/s.png) [inner](https://e.org/i) (0, 1]](https://e.org/asset?id=1)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png', 'https://e.org/real.png'], None),
            ('[outer ![Fig 1: ![sub](https://e.org/s.png) [inner](https://e.org/i) and (0, 1]](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png', 'https://e.org/real.png'], None),
            ('[outer ![Fig 1: ![sub][img-ref] [inner](https://e.org/i)](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/img.png', 'https://e.org/real.png'], None),
            ('[outer ![Fig 1: [0, 1) range](https://e.org/doc) and ![sub](https://e.org/s.png) and ![FALL] caption](https://e.org/f1.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/f1.png', 'https://e.org/real.png'], None),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if exact_expected is not None:
                self.assertEqual(repaired, exact_expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(repaired), repaired, f'idempotence: {raw}')

        # #8: eliminate O(N^3) blowups in Step 1 ![e](), Step 2 owning_brk, and can_peel_paren_link
        for label, s in [
            ('8.1 N=200', '[' * 200 + '![e]() ' * 200 + '](https://e.org/f.png) ' * 200),
            ('8.2 N=250', ') ' + '[![a ' * 250 + '![s](https://e.org/s.png) ' + '[0, 1)](https://e.org/f.png) ' * 250),
            ('8.3 N=250', '[![a ' * 250 + '](https://e.org/f.png) [0, 1)' * 250),
            ('8.4 N=250', ') ' + '![a [' * 250 + '![s](https://e.org/s.png) ' + '[0, 1)](https://e.org/f.png) ' * 250),
        ]:
            t0 = time.perf_counter()
            CONF_RENDER.repair_formula_delimiters(s)
            self.assertLess(time.perf_counter() - t0, 1.0, f'R24 {label} must finish under 1.0s')

    def test_wave4_r25_owning_brk_gate_cache_p2_clean_other_ref_fallback_tok_earlier_and_perf(self):
        import time
        import conference_publication_gate as conf_gate

        for raw, expected_urls, exact_expected in [
            # R25 #1: owning_brk across intervening [0, 1) and Step-1-peeled ref-image links
            ('FALL: ![e me, [outer [0, 1) ![Keep](https://e.org/keep.png) over [2, 3)](https://e.org/f1.png)',
             ['https://e.org/keep.png'], None),
            ('[keep]: https://e.org/keep.png\n[paper]: https://e.org/paper\n\nFALL: ![e me, [![Keep][keep]][paper] over [0, 1)](https://e.org/f1.png)',
             ['https://e.org/keep.png'], None),
            ('[keep]: https://e.org/keep.png\n\nFALL: ![e me, [![Keep][keep]](https://e.org/paper) over [0, 1)](https://e.org/f1.png)',
             ['https://e.org/keep.png'], None),
            # R25 #2: post-verification gate only blames culprit inside swallowing image span (preserves earlier paragraphs)
            ('![Good: [0, 1)](https://e.org/good.png)\n\n![Outer: ![Keep](https://e.org/keep.png) ![Broken: [0, 1)](https://e.org/a)](https://e.org/outer.png)',
             ['https://e.org/good.png', 'https://e.org/keep.png', 'https://e.org/outer.png'],
             '![Good: \\[0, 1)](https://e.org/good.png)\n\n![Outer: ![Keep](https://e.org/keep.png) ![Broken: [0, 1)](https://e.org/a)](https://e.org/outer.png)'),
            # R25 #3: pass_stack_metrics_cache soundness across ')' and non-whitespace between ![e1]() and ![e2]()
            ('![Outer: [a ![e1]() ) ![e2]() ](https://e.org/doc)](https://e.org/f1.png)',
             ['https://e.org/doc'],
             '![Outer: \\[a !\\[e1\\]() ) !\\[e2\\]() ](https://e.org/doc)](https://e.org/f1.png)'),
            ('[a ![e1]() ) ![e2]() cap](https://e.org/f1.png)',
             ['https://e.org/f1.png'],
             '[a ![e1]() ) ![e2\\]() cap](https://e.org/f1.png)'),
            ('[![e1]() Note: ![e2]() ](https://e.org/f1.png)]',
             [], None),
            # R25 #4: non-.png [Panel a) p2 unwind idempotence
            ('![Fig 1: [x [Panel a)](https://e.org/asset?id=2) ]](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/asset?id=2', 'https://e.org/real.png'], None),
            # R25 #5: clean_other_close & find_reparable_closed_img_above alignment
            ('[outer ![empty](<>)](https://e.org/f1.png)](https://e.org/b "literal `") and ![Trap: [0, 1)](https://e.org/trap.png) and `end`',
             [], None),
            ('[a![s][r]](/a)](https://e.org/n "`")![R:[0,1)](r.png) ``',
             ['r.png'], None),
            ('[outer ![FALL])](https://e.org/asset?id=1)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/real.png'], None),
            ('[outer ![FALL](](https://e.org/asset?id=1)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/real.png'], None),
            # R25 #6: ref_close with find_clean_ref_span == None falls back to plain_close
            ('[1][link](https://e.org/a) and ![FALL] caption](https://e.org/f1.png)',
             ['https://e.org/f1.png'], None),
            ('[foo][bar](https://e.org/bar) and ![Fig 1: [1) a](https://e.org/a) cap](https://e.org/f1.png)',
             ['https://e.org/f1.png'], None),
            # R25 #7: tokenizer inner_img_stack, will_step2_wrap, balanced [x] in tok_closed_spans, e_rem ref img
            ('[outer ![Fig 1: ![FALL] [foo][bar] [inner](https://e.org/i)](https://e.org/img.png)](https://e.org/b "literal `") and ![Real: [0, 1)](https://e.org/real.png) and `end`',
             ['https://e.org/img.png', 'https://e.org/real.png'], None),
            ('[outer FALL: ![e me — ![sub](https://e.org/s.png) [inner](https://e.org/i) (0, 1]](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png', 'https://e.org/real.png'], None),
            ('[outer ![e me, [![sub](https://e.org/s.png)](https://e.org/p) [inner](https://e.org/i) (0, 1]](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png', 'https://e.org/real.png'], None),
            ('[outer ![Fig 1: ![sub](https://e.org/s.png) [inner](https://e.org/i) (note [x]](https://e.org/img.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/img.png', 'https://e.org/real.png'], None),
            ('[outer ![Fig 1: [0, 1) range](https://e.org/doc) and ![sub][img-ref] and ![FALL] caption](https://e.org/f1.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/f1.png', 'https://e.org/real.png'], None),
            # R25 #8: Step 2 earlier-stealing blocked across prose break / unpaired '(' / empty nested ![![s](s.png)]
            ('[FALL: ![e me — (note ![sub](https://e.org/s.png)(0, 1]](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png'], None),
            ('[[0, 1)FALL: ![e me — ![sub](https://e.org/s.png)[0, 1)FALL: ![e me — ![sub](https://e.org/s.png)](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png', 'https://e.org/b'], None),
            ('[r1]: https://e.org/r1\n\n[outer [a][r1]![![s](https://e.org/s.png)]![FALL] cap](https://e.org/b "title ![Real: [0, 1)](https://e.org/real.png)")',
             ['https://e.org/s.png', 'https://e.org/real.png'], None),
        ]:
            repaired = CONF_RENDER.repair_formula_delimiters(raw)
            self.assertEqual([u for _, _, u in conf_gate._iter_markdown_images(repaired)], expected_urls, raw)
            if exact_expected is not None:
                self.assertEqual(repaired, exact_expected, raw)
            self.assertEqual(CONF_RENDER.repair_formula_delimiters(repaired), repaired, f'idempotence: {raw}')

        # R25 #2 & #9: eliminate O(N^3)-O(N^3.5) scaling blowups
        for label, s in [
            ('R25 #2 gate N=200', '![Good: [0, 1)](https://e.org/g.png)\n\n' * 200 + '![Outer: ![Keep](https://e.org/k.png) ![Broken: [0, 1)](https://e.org/a)](https://e.org/o.png)'),
            ('R25 #9a-A N=200', '[r]: https://e.org/r\n\n' + '![a ' * 200 + '[1) x](https://e.org/a) ' * 200 + '[r] ' * 200),
            ('R25 #9a-B N=200', '[r]: https://e.org/r.png\n\n' + '![a ' * 200 + '[1) x](https://e.org/a) ' * 200 + '![y][r] ' * 200),
            ('R25 #9b-A N=300', '[' * 300 + '![' * 300 + '[x](https://e.org/a)' * 300),
            ('R25 #9b-B N=250', '[' * 250 + '![' * 250 + '[x](https://e.org/a)' * 250 + ']' * 250),
            ('R25 #9c-A N=250', '![x ' + '[a ' * 250 + '[x](https://e.org/a) ' * 250 + '[1) b](https://e.org/b) ' * 250),
            ('R25 #9c-B N=300', '[' * 300 + 'a ) ' + '![e]() ' * 300 + '](https://e.org/f.png) ' * 300),
        ]:
            t0 = time.perf_counter()
            CONF_RENDER.repair_formula_delimiters(s)
            self.assertLess(time.perf_counter() - t0, 1.0, f'{label} must finish under 1.0s')


if __name__ == '__main__':
    unittest.main()

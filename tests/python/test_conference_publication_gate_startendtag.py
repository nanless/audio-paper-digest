import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))

from conference_publication_gate import Page  # noqa: E402
from markdown_hugo_gate import math_and_emphasis_issues  # noqa: E402


class ConferencePublicationGateStartEndTagTest(unittest.TestCase):
    def test_self_closing_katex_tags_do_not_corrupt_subsequent_code_masking(self):
        # Regression test for smc-2026 aggregate: KaTeX SSR emits self-closing
        # <path .../> and <mspace .../>. Page.handle_startendtag must NOT append
        # duplicate </path> or </mspace> tags that break ClosedFormatNodes and
        # unmask literal `$` inside subsequent <code> blocks.
        html_doc = (
            '<!doctype html><html><head><title>T</title>'
            '<link rel="canonical" href="https://example.com/p/"/></head><body>'
            '<h1>T</h1>'
            '<div class="post-content">'
            '<p><span class="katex"><span class="katex-mathml">'
            '<math><mrow><mi>x</mi><mspace width="0.2em"/></mrow></math>'
            '</span><span class="katex-html"><svg><path d="M0 0L1 1"/></svg></span>'
            '</span></p>'
            '<p>示例命令 <code>d1 $ note "c3 e3" # s "superpiano"</code> 可正常运行。</p>'
            '</div></body></html>'
        )
        page = Page(html_doc)
        body_html = ''.join(page.body_html)
        self.assertNotIn('</path>', body_html)
        self.assertNotIn('</mspace>', body_html)
        issues = math_and_emphasis_issues(body_html, 'HTML', rendered_html=True)
        self.assertEqual(issues, [])

    def test_bare_dollar_outside_code_after_self_closing_svg_still_fails(self):
        html_doc = (
            '<!doctype html><html><head><title>T</title>'
            '<link rel="canonical" href="https://example.com/p/"/></head><body>'
            '<h1>T</h1>'
            '<div class="post-content">'
            '<p><svg><path d="M0 0L1 1"/></svg></p>'
            '<p>此处遗漏未转义的裸数学公式 $x + y = z$ 应报错。</p>'
            '</div></body></html>'
        )
        page = Page(html_doc)
        body_html = ''.join(page.body_html)
        issues = math_and_emphasis_issues(body_html, 'HTML', rendered_html=True)
        self.assertTrue(any('$' in msg for msg in issues), f'Expected bare $ issue, got: {issues}')


if __name__ == '__main__':
    unittest.main()

"""KaTeX SSR (`<span class="katex[-display]">`) & MathML (`<math>`) format-gate tests."""
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import markdown_hugo_gate as gate


KATEX_INLINE_DOLLAR = (
    '<span class="katex">'
    '<span class="katex-mathml">'
    '<math xmlns="http://www.w3.org/1998/Math/MathML">'
    '<semantics><mrow><mtext>$100</mtext></mrow>'
    '<annotation encoding="application/x-tex">\\text{\\$100}</annotation>'
    '</semantics></math></span>'
    '<span class="katex-html" aria-hidden="true">'
    '<span class="base">'
    '<span class="strut" style="height:0.8056em;vertical-align:-0.0556em;"></span>'
    '<span class="mord text"><span class="mord">$100</span></span>'
    '</span></span></span>'
)

KATEX_DISPLAY_DOLLAR_AND_SVG = (
    '<span class="katex-display">'
    '<span class="katex">'
    '<span class="katex-mathml">'
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">'
    '<semantics><mrow><mfrac><mrow><mtext>$50</mtext></mrow>'
    '<msup><mi>x</mi><mrow><mo>∗</mo><mo>∗</mo></mrow></msup></mfrac>'
    '<mspace width="0.1667em"/></mrow>'
    '<annotation encoding="application/x-tex">\\frac{\\text{\\$50}}{x^{**}}</annotation>'
    '</semantics></math></span>'
    '<span class="katex-html" aria-hidden="true">'
    '<span class="base">'
    '<span class="mord">$50</span>'
    '<span class="hide-tail"><svg xmlns="http://www.w3.org/2000/svg" width="10em" height="1em">'
    '<path d="M0 0 L10 10"/></svg></span>'
    '</span></span></span></span>'
)

STANDALONE_MATHML_DOLLAR = (
    '<math xmlns="http://www.w3.org/1998/Math/MathML">'
    '<semantics><mrow><mtext>$50</mtext><mo>+</mo><mi>x</mi></mrow>'
    '<annotation encoding="application/x-tex">\\text{\\$50} + x</annotation>'
    '</semantics></math>'
)


def _run_rendered_gate(body_html, markdown_body='正文说明。'):
    page = (
        '<!doctype html><html><head><title>KaTeX Reader</title></head>'
        '<body><article><div class="post-content">'
        f'{body_html}'
        '</div></article></body></html>'
    )
    with tempfile.TemporaryDirectory(prefix='pd-katex-gate-') as tmp:
        output = Path(tmp)
        target = output / 'posts' / 'katex-reader' / 'index.html'
        target.parent.mkdir(parents=True)
        target.write_text(page, encoding='utf-8')
        artifact = {
            'path': 'katex-reader.md',
            'frontmatter': {
                'title': 'KaTeX Reader',
                'paper_digest_api_reader_contract': 'beginner-researcher-v3',
            },
            'body': markdown_body,
        }
        return gate.validate_hugo_rendered_html_gate(output, [artifact])


class KaTeXRenderedHtmlGateTests(unittest.TestCase):
    def test_valid_katex_inline_display_and_mathml_pass_rendered_gate(self):
        single_quoted = (
            "<span class='katex'><span class='katex-html' aria-hidden='true'>"
            "<span class='base'><span class='mord'>$100</span></span></span></span>"
        )
        multi_class = (
            '<span class="math-inline katex extra">'
            '<span class="katex-html"><span class="mord">\\$100</span></span></span>'
        )
        body_html = (
            f'<p>行内公式 {KATEX_INLINE_DOLLAR}，单引号 {single_quoted}，多类 {multi_class}。</p>'
            f'{KATEX_DISPLAY_DOLLAR_AND_SVG}'
            f'<p>纯 MathML {STANDALONE_MATHML_DOLLAR}。</p>'
            '<p>降级代码 <code class="math-fallback">\\text{\\$100}</code>。</p>'
        )
        self.assertEqual(gate.math_and_emphasis_issues(body_html, 'HTML', rendered_html=True), [])
        self.assertEqual(_run_rendered_gate(body_html), [])
        # Masking must preserve exact byte length and line breaks.
        masked = gate.mask_closed_code_for_format_gate(body_html, rendered_html=True)
        self.assertEqual(len(masked), len(body_html))
        self.assertNotIn('$100', masked)
        self.assertNotIn('$50', masked)
        self.assertNotIn('**', masked)

    def test_bare_dollar_outside_katex_or_mathml_still_fails(self):
        for body_html in (
            f'<p>{KATEX_INLINE_DOLLAR} 以及裸价格 $100。</p>',
            f'<p>裸价格 $100 以及 {KATEX_INLINE_DOLLAR}。</p>',
            f'{KATEX_DISPLAY_DOLLAR_AND_SVG}<p>公式外裸美元 $100。</p>',
            f'<p>{STANDALONE_MATHML_DOLLAR} 外侧 $100。</p>',
            '<p>纯正文里的裸 $100。</p>',
        ):
            with self.subTest(body_html=body_html[:60]):
                issues = _run_rendered_gate(body_html)
                self.assertTrue(any('包含裸 $' in item for item in issues), issues)

    def test_unclosed_katex_and_math_fail_closed(self):
        adversarial = [
            '<p><span class="katex"><span>nested</span> $100</p>',
            '<p><span class="katex"><span>$100</span></p>',
            '<span class="katex"><span>$100</span>',
            '<span class="katex">$100',
            '<span class="katex-display"><span class="katex">$100</span>',
            '<span class="katex"/>$100',
            '<p><span class="katex"><span>ok</span><span/>$100</span></p>',
            '<p><math><mtext>$100</mtext></p>',
            '<math><mtext>$100</mtext>',
            '<math><math><mtext>$100</mtext></math> $200',
            '<p><span class="katex">$100</span extra></p>',
            '<p><span class="katex"><span>ok</span bad>$100</span></p>',
        ]
        for snippet in adversarial:
            with self.subTest(snippet=snippet):
                issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in issues), (snippet, issues))
                gate_issues = _run_rendered_gate(snippet)
                self.assertTrue(any('包含裸 $' in item for item in gate_issues), (snippet, gate_issues))

    def test_fake_classes_forbidden_nesting_and_escaped_markup_fail_closed(self):
        adversarial = [
            '<p><span class="my-katex-fake">$100</span></p>',
            '<p><span class="not-katex">$100</span></p>',
            '<p><span class="katex-display-fake">$100</span></p>',
            '<p><span class="katex-html">$100</span></p>',
            '<p><span class="katex" class="other">$100</span></p>',
            '<p><span class="katex"><p>$100</p></span></p>',
            '<p><span class="katex"><code>$50</code> $100</span></p>',
            '<p><math><code>$50</code></math></p>',
            '<p><math><p>$50</p></math></p>',
            '<script><span class="katex">$100</span></script>',
            '<script><math><mtext>$100</mtext></math></script>',
            '<p><span class="katex"><!-- comment -->$100</span></p>',
            '<p><!-- <span class="katex"> -->$100<!-- </span> --></p>',
            '<p>&lt;span class="katex"&gt;$100&lt;/span&gt;</p>',
            '<p><span data-note="class=&quot;katex&quot;">$100</span></p>',
            # Masking KaTeX inside a td must not manufacture a fake plain currency cell.
            '<table><tr><td>$0.2<span class="katex"><span class="katex-html"><span class="mord">x</span></span></span></td></tr></table>',
        ]
        for snippet in adversarial:
            with self.subTest(snippet=snippet):
                issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in issues), (snippet, issues))

    def test_katex_error_and_merror_are_never_masked_and_rejected_by_gate(self):
        for snippet, expected_marker in (
            ('<p><span class="katex-error" title="ParseError">$100</span></p>', 'katex-error'),
            ('<p><span class="katex"><span class="katex-error">$100</span></span></p>', 'katex-error'),
            ('<p><span class="KATEX-ERROR">$100</span></p>', 'katex-error'),
            ('<p><span class="katex"><span class="KaTeX-Error">$100</span></span></p>', 'katex-error'),
            ('<p><span class="katex-error" class="safe">$100</span></p>', 'katex-error'),
            ('<p><span class="safe" class="katex-error">$100</span></p>', 'katex-error'),
            ('<p><math><merror><mtext>$100</mtext></merror></math></p>', '<merror>'),
            ('<p><span class="katex"><math><merror><mtext>$100</mtext></merror></math></span></p>', '<merror>'),
        ):
            with self.subTest(snippet=snippet):
                math_issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in math_issues), (snippet, math_issues))
                self.assertTrue(
                    any('数学渲染包含错误' in item and expected_marker in item for item in math_issues),
                    (snippet, math_issues),
                )
                gate_issues = _run_rendered_gate(snippet)
                err_hits = [item for item in gate_issues if '数学渲染包含错误' in item and expected_marker in item]
                self.assertEqual(len(err_hits), 1, (snippet, gate_issues))
        # Even without a bare dollar, <merror> / katex-error (incl. uppercase, duplicate class,
        # and after unclosed <code>/<pre>) must fail both math_and_emphasis_issues AND rendered gate!
        for snippet, expected_marker in (
            ('<p><span class="katex-error">\\badcmd</span></p>', 'katex-error'),
            ('<p><span class="KATEX-ERROR">\\badcmd</span></p>', 'katex-error'),
            ('<p><span class="katex-error" class="safe">\\badcmd</span></p>', 'katex-error'),
            ('<p><math><merror><mtext>bad</mtext></merror></math></p>', '<merror>'),
            ('<p><code>unclosed<merror><mtext>bad</mtext></merror></p>', '<merror>'),
            ('<p><pre>unclosed<span class="katex-error">bad</span></p>', 'katex-error'),
            ('<p><code><merror>bad</merror></code></p>', '<merror>'),
        ):
            with self.subTest(plain_error=snippet):
                direct_issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(
                    any('数学渲染包含错误' in item and expected_marker in item for item in direct_issues),
                    (snippet, direct_issues),
                )
                gate_issues = _run_rendered_gate(snippet)
                err_hits = [item for item in gate_issues if '数学渲染包含错误' in item and expected_marker in item]
                self.assertEqual(len(err_hits), 1, (snippet, gate_issues))
        # Escaped literal examples inside <code> must not trigger false error reports.
        self.assertEqual(_run_rendered_gate('<p><code>&lt;merror&gt;</code></p>'), [])
        # Parser failure inside _rendered_math_error_issues must fail closed.
        with mock.patch.object(HTMLParser, 'feed', side_effect=RuntimeError('boom')):
            fail_closed = gate._rendered_math_error_issues('<p><merror>x</merror></p>', 'HTML')
            self.assertEqual(fail_closed, ['HTML Hugo HTML 数学渲染错误节点解析失败'])

    def test_r1_adversarial_cdata_outer_invalidation_svg_math_and_katex_payload(self):
        # Finding #2: <![CDATA[...]]> in ClosedFormatNodes and decl/pi/CDATA in CurrencyCells
        for snippet in (
            '<p><code><![CDATA[$100]]></code></p>',
            '<p><span class="katex"><span class="katex-html"><![CDATA[$100]]></span></span></p>',
            '<p><math><mtext><![CDATA[$100]]></mtext></math></p>',
            '<table><tr><td>$0.2<![CDATA[x]]></td></tr></table>',
            '<table><tr><td>$0.2<!DOCTYPE x></td></tr></table>',
            '<table><tr><td>$0.2<?pi?></td></tr></table>',
        ):
            with self.subTest(finding='cdata_decl_pi', snippet=snippet):
                issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in issues), (snippet, issues))

        # Finding #3: corrupted outer format container propagates downward, while sibling isolation holds
        for snippet in (
            '<pre><p>bad</p><code>$100</code></pre>',
            '<span class="katex-display"><p>bad</p><span class="katex"><span class="katex-html">$100</span></span></span>',
            '<span class="katex-display"><!-- c --><math><mtext>$100</mtext></math></span>',
            '<span class="katex-display"><span>ok</span bad><span class="katex"><span class="katex-html">$100</span></span></span>',
            '<span class="katex"><code>$100</code></span>',
        ):
            with self.subTest(finding='outer_invalidation', snippet=snippet):
                issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in issues), (snippet, issues))
        # Sibling isolation: a malformed non-ancestor sibling does not break a clean code sibling.
        self.assertEqual(
            gate.math_and_emphasis_issues('<p><i>x</i bad><code>$100</code></p>', 'HTML', rendered_html=True),
            [],
        )

        # Finding #5: <svg> is a forbidden ancestor for <math>
        for snippet in (
            '<svg><math><mtext>$100</mtext></math></svg>',
            '<svg><foreignObject><math><mtext>$100</mtext></math></foreignObject></svg>',
        ):
            with self.subTest(finding='svg_math', snippet=snippet):
                issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in issues), (snippet, issues))

        # Finding #7: bare <span class="katex"> without real KaTeX payload descendant is NEVER masked
        for snippet in (
            '<p><span class="katex">$100</span></p>',
            '<p><span class="katex">$100 **residual**</span></p>',
            '<p><span class="katex"><span>$100</span></span></p>',
            '<p><span class="katex katex-html">$100</span></p>',
            '<p><span class="katex-display"><span class="katex">$100</span></span></p>',
        ):
            with self.subTest(finding='katex_payload', snippet=snippet):
                issues = gate.math_and_emphasis_issues(snippet, 'HTML', rendered_html=True)
                self.assertTrue(any('包含裸 $' in item for item in issues), (snippet, issues))
        bare_bold = _run_rendered_gate('<p><span class="katex">$100 **residual**</span></p>')
        self.assertTrue(any('包含裸 $' in item for item in bare_bold), bare_bold)
        self.assertTrue(any('残留 Markdown 加粗标记' in item for item in bare_bold), bare_bold)

    def test_raw_markdown_mode_never_masks_katex_or_mathml_html(self):
        for raw_md in (
            KATEX_INLINE_DOLLAR,
            KATEX_DISPLAY_DOLLAR_AND_SVG,
            STANDALONE_MATHML_DOLLAR,
            '<span class="katex">$100</span>',
            '<math><mtext>$100</mtext></math>',
        ):
            with self.subTest(raw_md=raw_md[:50]):
                issues = gate.math_and_emphasis_issues(raw_md, 'Markdown', rendered_html=False)
                self.assertTrue(any('包含裸 $' in item for item in issues), (raw_md, issues))

    def test_linear_time_on_50000_nested_and_unclosed_katex_tags(self):
        unclosed = '<span class="katex">' * 50000 + '$100'
        t0 = time.monotonic()
        unclosed_issues = gate.math_and_emphasis_issues(unclosed, 'perf-unclosed', rendered_html=True)
        elapsed_unclosed = time.monotonic() - t0
        self.assertTrue(any('包含裸 $' in item for item in unclosed_issues), unclosed_issues)
        self.assertLess(elapsed_unclosed, 5.0, f'50k unclosed took {elapsed_unclosed:.2f}s')

        closed = (
            '<span class="katex">' * 50000
            + '<span class="katex-html"><span class="mord">$100</span></span>'
            + '</span>' * 50000
        )
        t1 = time.monotonic()
        closed_issues = gate.math_and_emphasis_issues(closed, 'perf-closed', rendered_html=True)
        elapsed_closed = time.monotonic() - t1
        self.assertEqual(closed_issues, [])
        self.assertLess(elapsed_closed, 5.0, f'50k closed took {elapsed_closed:.2f}s')

        unclosed_math = '<math>' * 50000 + '$100'
        t2 = time.monotonic()
        math_issues = gate.math_and_emphasis_issues(unclosed_math, 'perf-math', rendered_html=True)
        elapsed_math = time.monotonic() - t2
        self.assertTrue(any('包含裸 $' in item for item in math_issues), math_issues)
        self.assertLess(elapsed_math, 5.0, f'50k unclosed math took {elapsed_math:.2f}s')

    @unittest.skipUnless(shutil.which('hugo'), 'Hugo not installed')
    def test_real_hugo_katex_ssr_passes_rendered_html_gate_and_catches_bare_dollar(self):
        body = (
            '行内成本公式为 \\(\\text{\\$100} + \\sqrt{x}\\)。\n\n'
            '\\[\\frac{\\text{\\$50}}{x^{**}}\\]\n'
        )
        with tempfile.TemporaryDirectory(prefix='pd-real-hugo-katex-') as tmp:
            root = Path(tmp)
            (root / 'content/posts').mkdir(parents=True)
            (root / 'layouts/_default/_markup').mkdir(parents=True)
            (root / 'hugo.toml').write_text(
                r'''baseURL = "https://example.invalid/"
[markup.goldmark.extensions.passthrough]
enable = true
[markup.goldmark.extensions.passthrough.delimiters]
block = [['\[', '\]']]
inline = [['\(', '\)']]
''',
                encoding='utf-8',
            )
            (root / 'layouts/_default/single.html').write_text(
                '<!doctype html><html><head><title>{{ .Title }}</title></head>'
                '<body><article><div class="post-content">{{ .Content }}</div></article></body></html>',
                encoding='utf-8',
            )
            (root / 'layouts/_default/_markup/render-passthrough.html').write_text(
                '{{ $opts := dict "output" "htmlAndMathml" "displayMode" (eq .Type "block") }}'
                '{{ with try (transform.ToMath .Inner $opts) }}'
                '{{ with .Err }}<code class="math-fallback">{{ $.Inner }}</code>{{ else }}{{ .Value }}{{ end }}'
                '{{ end }}',
                encoding='utf-8',
            )
            (root / 'content/posts/katex-ssr.md').write_text(
                '---\ntitle: "KaTeX SSR Test"\n---\n\n' + body,
                encoding='utf-8',
            )
            subprocess.run(
                ['hugo', '--source', str(root), '--destination', str(root / 'public'), '--quiet'],
                check=True, capture_output=True, text=True, timeout=30,
            )
            out_file = root / 'public/posts/katex-ssr/index.html'
            rendered = out_file.read_text(encoding='utf-8')
            self.assertIn('class="katex"', rendered)
            self.assertIn('class="katex-display"', rendered)
            self.assertIn('$100', rendered)
            self.assertIn('$50', rendered)
            artifact = {
                'path': 'posts/katex-ssr.md',
                'frontmatter': {
                    'title': 'KaTeX SSR Test',
                    'paper_digest_api_reader_contract': 'beginner-researcher-v3',
                },
                'body': body,
            }
            self.assertEqual(gate.validate_hugo_rendered_html_gate(root / 'public', [artifact]), [])
            # Injecting a bare $100 outside KaTeX must still fail closed.
            out_file.write_text(rendered.replace('</div>', '<p>正文裸价 $100</p></div>'), encoding='utf-8')
            issues = gate.validate_hugo_rendered_html_gate(root / 'public', [artifact])
            self.assertTrue(any('包含裸 $' in item for item in issues), issues)


class KaTeXDisplayFormulaExtractionTests(unittest.TestCase):
    def test_extracts_valid_katex_display_and_block_fallback_formulas(self):
        html_doc = (
            f'<p>行内 {KATEX_INLINE_DOLLAR} 和行内降级 <code class="math-fallback">inline_only</code>。</p>'
            f'{KATEX_DISPLAY_DOLLAR_AND_SVG}'
            '<div><code class="math-fallback">k^* = 1.\\vskip-5.0pt</code></div>'
            '<blockquote><code class="math-fallback">a &amp;lt; b &#43; c</code></blockquote>'
            '<details><summary>展开</summary><code class="math-fallback">d = 2</code></details>'
            # R2 P1 #2: top-level heading anchor span / script / audio in separate block runs
            # must not falsely drop legitimate block math-fallback formulas.
            '<span id="paper-title" aria-hidden="true"></span>'
            '<script>console.log(1)</script>'
            '<p>正文段落</p><code class="math-fallback">e = 3.\\vskip-5pt</code><audio controls></audio>'
        )
        extracted = gate.extract_rendered_display_formulas(html_doc)
        self.assertEqual(
            extracted,
            [
                r'\frac{\text{\$50}}{x^{**}}',
                r'k^* = 1.\vskip-5.0pt',
                'a &lt; b + c',
                'd = 2',
                r'e = 3.\vskip-5pt',
            ],
        )

    def test_rejects_inline_hidden_malformed_and_spoofed_display_formulas(self):
        adversarial = [
            # Inline KaTeX (no katex-display)
            f'<p>{KATEX_INLINE_DOLLAR}</p>',
            # katex-display missing display="block" on <math>
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">x</span></span>'
            '</span></span>',
            # Missing <span class="katex-html">
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span></span></span>',
            # Hidden katex-html via display:none
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" style="display:none">x</span></span></span>',
            # <semantics> with annotation only (no visual MathML child)
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true">x</span></span></span>',
            # Duplicate annotation inside one katex-display
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi>'
            '<annotation encoding="application/x-tex">x</annotation>'
            '<annotation encoding="application/x-tex">y</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true">x</span></span></span>',
            # Nested inside hidden / aria-hidden / script / template / pre / code / katex-error
            f'<div hidden>{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<div style="display:none">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<div aria-hidden="true">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<script>{KATEX_DISPLAY_DOLLAR_AND_SVG}</script>',
            f'<template>{KATEX_DISPLAY_DOLLAR_AND_SVG}</template>',
            f'<pre>{KATEX_DISPLAY_DOLLAR_AND_SVG}</pre>',
            f'<code>{KATEX_DISPLAY_DOLLAR_AND_SVG}</code>',
            f'<span class="katex-error">{KATEX_DISPLAY_DOLLAR_AND_SVG}</span>',
            f'<div class="a" class="b">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            # Nested katex-display inside katex-display
            f'<span class="katex-display">{KATEX_DISPLAY_DOLLAR_AND_SVG}</span>',
            # Comment / <merror> / katex-error / forbidden tag / unclosed / bad close inside katex-display
            KATEX_DISPLAY_DOLLAR_AND_SVG.replace('<semantics>', '<!-- c --><semantics>'),
            KATEX_DISPLAY_DOLLAR_AND_SVG.replace('<mi>x</mi>', '<merror><mtext>x</mtext></merror>'),
            KATEX_DISPLAY_DOLLAR_AND_SVG.replace('<span class="mord">$50</span>', '<span class="katex-error">$50</span>'),
            KATEX_DISPLAY_DOLLAR_AND_SVG.replace('<span class="mord">$50</span>', '<p>$50</p>'),
            KATEX_DISPLAY_DOLLAR_AND_SVG[:-7],
            KATEX_DISPLAY_DOLLAR_AND_SVG[:-7] + '</span bad>',
            # Inline / nested / hidden / malformed math-fallback
            '<p><code class="math-fallback">x = 1</code></p>',
            '<table><tr><td><code class="math-fallback">x = 1</code></td></tr></table>',
            '<h2><code class="math-fallback">x = 1</code></h2>',
            '<pre><code class="math-fallback">x = 1</code></pre>',
            '<div hidden><code class="math-fallback">x = 1</code></div>',
            '<code class="math-fallback"><span>x = 1</span></code>',
            '<code class="math-fallback"><!-- c -->x = 1</code>',
            '<code class="math-fallback" class="dup">x = 1</code>',
            '<code class="math-fallback">x = 1',
            '<code class="math-fallback">x = 1</code bad>',
            # R1 P1 #1: self-closing non-void HTML tags cannot bypass ancestor guards
            f'<div hidden/>{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<div style="display:none"/>{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<template/>{KATEX_DISPLAY_DOLLAR_AND_SVG}</template>',
            f'<script/>{KATEX_DISPLAY_DOLLAR_AND_SVG}</script>',
            f'<span class="katex-error"/>{KATEX_DISPLAY_DOLLAR_AND_SVG}</span>',
            f'<svg/>{KATEX_DISPLAY_DOLLAR_AND_SVG}</svg>',
            '<p/><code class="math-fallback">x = 1</code></p>',
            '<span class="katex-display"/>',
            '<code class="math-fallback"/>',
            # R1 P1 #2: mismatched end-tag unwinding cannot escape hidden/inert/foreign/rawtext barriers
            f'<div><template></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</template>',
            f'<div><noscript></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</noscript>',
            f'<div><svg></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</svg>',
            f'<div><math></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</math>',
            f'<div><pre></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</pre>',
            f'<div><code></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</code>',
            f'<div hidden><math><mtext></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</mtext></math>',
            # R1 P1 #3: inline sibling text/phrasing, empty fallback, disallowed ancestor
            '<ul><li>see <code class="math-fallback">x = 1</code></li></ul>',
            '<ul><li><code class="math-fallback">x = 1</code> trailing</li></ul>',
            '<ul><li><em>note</em><code class="math-fallback">x = 1</code></li></ul>',
            '<div>see <code class="math-fallback">x = 1</code></div>',
            '<div><span class="katex">x</span><code class="math-fallback">x = 1</code></div>',
            '<i><div><code class="math-fallback">x = 1</code></div></i>',
            '<div><code class="math-fallback"></code></div>',
            '<div><code class="math-fallback">   </code></div>',
            # R1 P1 #4: strict KaTeX display skeleton & visibility invariants
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true"></span></span></span>',
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" style="display:none">x</span>'
            '<span class="katex-html" aria-hidden="true">x</span></span></span>',
            KATEX_DISPLAY_DOLLAR_AND_SVG.replace('<span class="base">', '<span class="base" style="display:none">'),
            KATEX_DISPLAY_DOLLAR_AND_SVG.replace('<mi>x</mi>', '<mi hidden>x</mi>'),
            '<span class="katex-display">SPOOF' + KATEX_DISPLAY_DOLLAR_AND_SVG[len('<span class="katex-display">'):],
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math><math><semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true">x</span></span></span>',
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mrow><mi>x</mi><annotation encoding="application/x-tex">y</annotation></mrow>'
            '<annotation encoding="application/x-tex">x</annotation></semantics></math></span>'
            '<span class="katex-html" aria-hidden="true">x</span></span></span>',
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true"><span class="katex">x</span></span>'
            '</span></span>',
            # R1 P2 #5: inline containers and inline katex cannot wrap katex-display
            f'<p>{KATEX_DISPLAY_DOLLAR_AND_SVG}</p>',
            f'<td>{KATEX_DISPLAY_DOLLAR_AND_SVG}</td>',
            f'<p><span class="katex">{KATEX_DISPLAY_DOLLAR_AND_SVG}</span></p>',
            # R1 P2 #6: CSS comments, visibility:collapse, whitespace aria-hidden
            f'<div style="display/*x*/:none">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<div style="visibility:collapse">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<div style="content-visibility:hidden">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            f'<div aria-hidden=" true ">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>',
            # R2 P2 #3: HTML5 scope barriers (object/marquee/applet/caption/td/th)
            f'<div><object data="x"></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</object>',
            f'<div><marquee></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</marquee>',
            f'<div><applet></div>{KATEX_DISPLAY_DOLLAR_AND_SVG}</applet>',
            # R2 P2 #4: empty <svg></svg> or <defs>-only <svg> in katex-html has 0 visible pixels
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true"><svg></svg></span></span></span>',
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true">'
            '<svg><defs><path d="M0 0 L10 10"/></defs></svg></span></span></span>',
            # R3 P2 #1: raw text inside <svg> or <svg><defs> renders 0 visible pixels
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true">'
            '<svg>unrendered</svg></span></span></span>',
            '<span class="katex-display"><span class="katex"><span class="katex-mathml">'
            '<math display="block"><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation>'
            '</semantics></math></span><span class="katex-html" aria-hidden="true">'
            '<svg><defs>unrendered</defs></svg></span></span></span>',
        ]
        for snippet in adversarial:
            with self.subTest(snippet=snippet[:90]):
                self.assertEqual(gate.extract_rendered_display_formulas(snippet), [], snippet)

    def test_parser_failure_returns_none_and_linear_time_on_50000_tags(self):
        with mock.patch.object(HTMLParser, 'feed', side_effect=RuntimeError('boom')):
            self.assertIsNone(gate.extract_rendered_display_formulas(KATEX_DISPLAY_DOLLAR_AND_SVG))
        stress = '<span class="katex-display">' * 25000 + '</div>' * 25000
        t0 = time.monotonic()
        self.assertEqual(gate.extract_rendered_display_formulas(stress), [])
        self.assertLess(time.monotonic() - t0, 5.0)
        # R2 P1 #1: unclosed CSS comments inside style= must stay strictly O(n)
        css_stress = '<div style="' + ('/*a' * 40000) + f'">{KATEX_DISPLAY_DOLLAR_AND_SVG}</div>'
        t1 = time.monotonic()
        self.assertEqual(
            gate.extract_rendered_display_formulas(css_stress),
            [r'\frac{\text{\$50}}{x^{**}}'],
        )
        self.assertLess(time.monotonic() - t1, 2.0)


if __name__ == '__main__':
    unittest.main()

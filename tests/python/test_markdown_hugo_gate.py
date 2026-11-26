"""Regression tests for markdown_table_count, markdown_image_count, and rendered HTML gate safety."""

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from markdown_hugo_gate import (  # noqa: E402
    markdown_image_count,
    markdown_table_count,
    validate_hugo_rendered_html_gate,
)
from publish_common import PublishDataValidationError  # noqa: E402


class MarkdownHugoGateCountTest(unittest.TestCase):
    def test_table_count_ignores_fenced_code_blocks_and_orphan_separators(self):
        # Tables inside backtick, nested 4-backtick, tilde, indented, and unclosed fences must not count.
        fenced_cases = [
            '```markdown\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```',
            '~~~markdown\n| a | b |\n| --- | --- |\n| 1 | 2 |\n~~~',
            '````markdown\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n````',
            '   ```text\n| a | b |\n| --- | --- |\n| 1 | 2 |\n   ```',
            '```markdown\n| a | b |\n| --- | --- |\n| 1 | 2 |',
        ]
        for text in fenced_cases:
            with self.subTest(text=text):
                self.assertEqual(markdown_table_count(text), 0)

        # Orphan separators without a preceding header row must not count.
        orphan_cases = [
            '| --- | --- |',
            '| --- | --- |\n| 1 | 2 |',
            '| --- | --- |\n| --- | --- |\n| 1 | 2 |',
            '| :--- | ---: |',
        ]
        for text in orphan_cases:
            with self.subTest(text=text):
                self.assertEqual(markdown_table_count(text), 0)

        # Real table followed immediately by a fenced code block containing another table counts as 1.
        adjacent = (
            '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
            '```markdown\n| x | y |\n| --- | --- |\n| 3 | 4 |\n```\n'
        )
        self.assertEqual(markdown_table_count(adjacent), 1)

        # Orphan separator followed by a real header + separator counts as 1.
        orphan_then_real = '| --- | --- |\n| a | b |\n| --- | --- |\n| 1 | 2 |'
        self.assertEqual(markdown_table_count(orphan_then_real), 1)

        # Header + separator without body rows is still a valid Goldmark table.
        self.assertEqual(markdown_table_count('| a | b |\n| --- | --- |'), 1)

    def test_image_count_excludes_code_and_handles_bracketed_alt_text(self):
        # Bracketed alt text & self-linked image with brackets must be counted accurately.
        bracketed = '![Figure 1: SNR [dB] comparison](https://example.org/fig1.png)'
        self.assertEqual(markdown_image_count(bracketed), 1)

        self_linked = '[![Figure 1: SNR [dB] comparison](https://example.org/fig1.png)](https://example.org/fig1.png)'
        self.assertEqual(markdown_image_count(self_linked), 1)

        # Fenced code blocks, inline code spans, and escaped markers must not be counted.
        ignored = '\n\n'.join([
            '```markdown\n![Fenced Figure](https://example.org/fenced.png)\n```',
            '~~~markdown\n![Tilde Figure](https://example.org/tilde.png)\n~~~',
            'Inline code `![Inline Figure](https://example.org/inline.png)` should not count.',
            r'Escaped \![Literal Figure](https://example.org/escaped.png) should not count.',
        ])
        self.assertEqual(markdown_image_count(ignored), 0)

        mixed = ignored + '\n\n' + bracketed + '\n\n![Fig 2: Mel [Hz] & RTF](https://example.org/fig2.png)'
        self.assertEqual(markdown_image_count(mixed), 2)

        self.assertEqual(markdown_image_count(''), 0)
        self.assertEqual(markdown_image_count(None), 0)

        with self.assertRaises(PublishDataValidationError):
            markdown_image_count('![Unclosed alt text')

    def test_rendered_html_gate_handles_fenced_blocks_bracketed_alt_and_malformed_image_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'public'
            target = output / 'posts' / 'gate-test' / 'index.html'
            target.parent.mkdir(parents=True)

            body = (
                '```markdown\n'
                '| Fake | Table |\n| --- | --- |\n| 1 | 2 |\n'
                '![Fenced Img](https://example.org/fenced.png)\n'
                '```\n\n'
                '| --- | --- |\n\n'
                '行内代码 `![Inline Img](https://example.org/inline.png)`。\n\n'
                '| Metric | Value |\n| --- | --- |\n| SNR | 12.3 |\n\n'
                '![Figure 1: SNR [dB] comparison](https://example.org/fig1.png)\n'
            )
            rendered_ok = (
                '<html><head><title>Gate Test</title></head><body><article>'
                '<pre><code>| Fake | Table |</code></pre>'
                '<table><thead><tr><th>Metric</th><th>Value</th></tr></thead>'
                '<tbody><tr><td>SNR</td><td>12.3</td></tr></tbody></table>'
                '<p><img src="https://example.org/fig1.png" alt="Figure 1: SNR [dB] comparison"></p>'
                '</article></body></html>'
            )
            target.write_text(rendered_ok, encoding='utf-8')
            artifact = {
                'path': 'gate-test.md',
                'frontmatter': {
                    'title': 'Gate Test',
                    'paper_digest_api_reader_contract': 'beginner-researcher-v3',
                },
                'body': body,
            }
            self.assertEqual(validate_hugo_rendered_html_gate(output, [artifact]), [])

            # Missing rendered <img> for the bracketed-alt image must still fail the gate!
            rendered_missing_img = rendered_ok.replace(
                '<img src="https://example.org/fig1.png" alt="Figure 1: SNR [dB] comparison">',
                '',
            )
            target.write_text(rendered_missing_img, encoding='utf-8')
            issues = validate_hugo_rendered_html_gate(output, [artifact])
            self.assertTrue(any('图片数量不足' in issue for issue in issues), issues)

            # Malformed image markdown must report a structured gate issue instead of crashing the loop.
            target.write_text(rendered_ok, encoding='utf-8')
            bad_artifact = {**artifact, 'body': '![Broken image without closing bracket'}
            bad_issues = validate_hugo_rendered_html_gate(output, [bad_artifact])
            self.assertTrue(any('Markdown 图片语法解析失败' in issue for issue in bad_issues), bad_issues)


if __name__ == '__main__':
    unittest.main()

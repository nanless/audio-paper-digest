import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from markdown_hugo_gate import (
    markdown_table_count,
    mask_rendered_symbolic_table_cells,
    math_and_emphasis_issues,
    validate_hugo_rendered_html_gate,
)
from publish_common import (
    fix_latex_delimiters,
    publish_table_currency_spans,
    sanitize_markdown_for_publish,
)


class MarkdownCurrencyGateTest(unittest.TestCase):
    def test_real_04173_separate_currency_cells_pass_without_byte_changes(self):
        table = ('| 尝试次数 | 1000 例翻译成本 | 1000 例验证成本 | 单接受例成本 | 平均规则数 |\n'
                 '| --- | --- | --- | --- | --- |\n'
                 '| 10 | $0.2 | $1.0/1000 | $0.003344 /trace | 1.9 |')
        self.assertEqual([table[a:b] for a, b in publish_table_currency_spans(table)],
                         ['$0.2', '$1.0/1000', '$0.003344 /trace'])
        self.assertEqual(sanitize_markdown_for_publish(table), table)
        self.assertEqual(math_and_emphasis_issues(table, 'Reader'), [])

    def test_prose_math_operators_and_multiple_dollars_still_fail_closed(self):
        for cell in ('$5$', '$5+2$', '$5x', '$5 + 2', '$5 $6', '$$5$$',
                     '$0.2 and $1.0', 'fee $0.2', '$0.2\\(x\\)'):
            with self.subTest(cell=cell):
                table = '| a | b |\n| --- | --- |\n| ' + cell + ' | text |'
                self.assertEqual(publish_table_currency_spans(table), [])
                self.assertTrue(any('裸 $' in issue for issue in math_and_emphasis_issues(table, 'Reader')))
        for prose in ('$0.2', '$0.2 and $1.0', '| $0.2 | $1.0 |'):
            with self.subTest(prose=prose):
                self.assertEqual(publish_table_currency_spans(prose), [])
                self.assertTrue(math_and_emphasis_issues(prose, 'Reader'))

    def test_prose_usd_ranges_are_rendered_as_currency_not_math(self):
        text = '官方方案价格为 $100-200 USD，普通手柄价格为 $60–80 USD。'
        fixed = sanitize_markdown_for_publish(text)
        self.assertEqual(fixed, '官方方案价格为 100–200 美元，普通手柄价格为 60–80 美元。')
        self.assertEqual(math_and_emphasis_issues(fixed, 'Reader'), [])

    def test_mixed_inr_usd_table_note_is_rendered_as_currency(self):
        table = ('| 合计 | 卢比 | 美元 | 备注 |\n'
                 '| --- | --- | --- | --- |\n'
                 '| 含手机 | INR 10,099 | $115.75 | 原价 INR 6,499 / $74.49 |')
        fixed = sanitize_markdown_for_publish(table)
        self.assertIn('原价 INR 6,499 / 74.49 美元', fixed)
        self.assertEqual(math_and_emphasis_issues(fixed, 'Reader'), [])

    def test_decimal_dollar_amounts_in_prose_are_rendered_as_currency(self):
        text = '均值项目成本为$113.54，高于中位数成本$93.80。'
        fixed = sanitize_markdown_for_publish(text)
        self.assertEqual(fixed, '均值项目成本为113.54 美元，高于中位数成本93.80 美元。')
        self.assertEqual(math_and_emphasis_issues(fixed, 'Reader'), [])

    def test_math_like_dollar_expressions_still_fail_closed(self):
        self.assertEqual(fix_latex_delimiters('$5 + 2'), '$5 + 2')

    def test_quoted_angle_bracket_tokens_cannot_open_html(self):
        fixed = sanitize_markdown_for_publish('迷你记谱法写作 "<1 2>" 和 "<a b c>"。')
        self.assertIn('&lt;1 2&gt;', fixed)
        self.assertIn('&lt;a b c&gt;', fixed)
        self.assertEqual(math_and_emphasis_issues(fixed, 'Reader'), [])

    def test_normalized_same_cell_math_remains_supported(self):
        text = '| a | b |\n| --- | --- |\n| $x+1$ | $5$ |'
        self.assertEqual(math_and_emphasis_issues(sanitize_markdown_for_publish(text), 'Reader'), [])

    def test_display_math_closer_after_tex_linebreak_is_counted(self):
        formula = r'\[x=\begin{bmatrix}1\\ 2\\\end{bmatrix}\\\]'
        self.assertEqual(math_and_emphasis_issues(formula, 'Reader'), [])
        self.assertTrue(any(
            '未配对' in issue
            for issue in math_and_emphasis_issues(formula[:-2], 'Reader')
        ))

    def test_rendered_html_currency_requires_real_separate_plain_table_cells(self):
        html = ('<article><p>价格见表。</p><table><thead><tr><th>$0.2</th><th>成本</th></tr></thead>'
                '<tbody><tr><td> $0.2 </td><td>\n$1.0/1000\n</td></tr></tbody></table></article>')
        self.assertEqual(math_and_emphasis_issues(html, 'Reader', rendered_html=True), [])
        for cell in ('$5$', '$5+2$', '$5x', '$5 + 2', '$5 $6', '$$5$$',
                     '$0.2 and $1.0', '<span>$0.2</span>', '$0.2<!-- note -->'):
            with self.subTest(cell=cell):
                page = '<article><table><tr><td>' + cell + '</td></tr></table></article>'
                self.assertTrue(math_and_emphasis_issues(page, 'Reader', rendered_html=True))
        for page in ('<p>$0.2 and $1.0</p>', '<div>$0.2</div>', '<td>$0.2</td>',
                     '<table><td>$0.2</td></table>', '<!-- <table><tr><td>$0.2</td></tr></table> -->'):
            with self.subTest(page=page):
                self.assertTrue(math_and_emphasis_issues(page, 'Reader', rendered_html=True))

    def test_html_currency_waiver_does_not_leak_into_neighboring_prose_or_math(self):
        table = '<table><tr><td>$0.2</td><td>$1.0/1000</td></tr></table>'
        self.assertTrue(math_and_emphasis_issues(table + '<p>$x$</p>', 'Reader', rendered_html=True))
        self.assertTrue(math_and_emphasis_issues(table + '<p>$0.2</p>', 'Reader', rendered_html=True))

    def test_rendered_symbolic_table_cells_are_not_residual_markdown(self):
        html = ('<table><tr><td>*******___</td><td>_*____****</td></tr></table>'
                '<p>ordinary **broken marker</p>')
        masked = mask_rendered_symbolic_table_cells(html)
        self.assertNotIn('*******___', masked)
        self.assertNotIn('_*____****', masked)
        self.assertIn('**broken marker', masked)

    def test_rendered_statistical_significance_stars_are_data(self):
        html = ('<table><tr><td>W = 2749, p = 0.00908**</td>'
                '<td>p &lt; 2.2e-16***</td></tr></table>')
        masked = mask_rendered_symbolic_table_cells(html)
        self.assertNotIn('0.00908**', masked)
        self.assertNotIn('2.2e-16***', masked)
        self.assertIn('STATISTICAL_SIGNIFICANCE_STARS', masked)
        self.assertEqual(math_and_emphasis_issues(masked, 'Reader', rendered_html=True), [])

    def test_public_html_gate_uses_cell_adapter_on_complete_reader_page(self):
        table = '<table><tr><th>翻译成本</th><th>验证成本</th></tr><tr><td>$0.2</td><td>$1.0/1000</td></tr></table>'
        page = '<!doctype html><html><head><title>Actual Reader</title></head><body><article><div class="post-content"><h3>调用成本</h3>' + table + '</div></article></body></html>'
        with tempfile.TemporaryDirectory() as root:
            output = Path(root)
            target = output / 'posts' / 'reader' / 'index.html'
            target.parent.mkdir(parents=True)
            target.write_text(page, encoding='utf-8')
            artifact = {'path': 'reader.md', 'frontmatter': {
                'title': 'Actual Reader', 'paper_digest_api_reader_contract': 'beginner-researcher-v3'},
                'body': '| 翻译 | 验证 |\n| --- | --- |\n| $0.2 | $1.0/1000 |'}
            self.assertEqual(validate_hugo_rendered_html_gate(output, [artifact]), [])
            target.write_text(page.replace('</div>', '<p>$5+2$</p></div>'), encoding='utf-8')
            self.assertTrue(any('裸 $' in issue for issue in validate_hugo_rendered_html_gate(output, [artifact])))


class MarkdownTableCountTest(unittest.TestCase):
    """markdown_table_count 必须按 Goldmark 语义把连续管道行算作同一张表。"""

    def test_one_block_with_repeated_separators_counts_once(self):
        text = (
            '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
            '| --- | --- |\n| 3 | 4 |\n\n之后的段落'
        )
        self.assertEqual(markdown_table_count(text), 1)

    def test_two_separated_blocks_count_two(self):
        text = (
            '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n'
            '| x | y | z |\n| :--- | :--- | :--- |\n| 7 | 8 | 9 |'
        )
        self.assertEqual(markdown_table_count(text), 2)

    def test_two_dash_style_separators_do_not_count(self):
        # `:--` 不是合法 Markdown 分隔符（需 ≥3 连字符），不得计入
        text = '| a | b |\n| :-- | :-- |\n| 1 | 2 |\n纯文本'
        self.assertEqual(markdown_table_count(text), 0)

    def test_pipe_rows_without_separator_count_zero(self):
        text = '| a | b |\n| 1 | 2 |\n纯文本'
        self.assertEqual(markdown_table_count(text), 0)

    def test_block_at_end_of_text_still_counts(self):
        text = '| a |\n| --- |\n| 1 |'
        self.assertEqual(markdown_table_count(text), 1)

    def test_empty_and_none_are_zero(self):
        self.assertEqual(markdown_table_count(''), 0)
        self.assertEqual(markdown_table_count(None), 0)


class MarkdownImageAltDiagnosticContextTest(unittest.TestCase):
    def test_actual_payne_both_alt_brackets_pass_without_published_byte_changes(self):
        from publish_common import parse_markdown_images
        from markdown_hugo_gate import _mask_literal_markdown_image_alt_brackets
        raw = '[![原论文 Figure 1：f0 contour for broad focus declarative FALL: \\!\\[e me](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-1.png)](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-1.png)\n\n*论文图 1。原论文 Figure 1：“f0 contour for broad focus declarative FALL: [e me”。*\n\n[![原论文 Figure 2：f0 contour for broad focus declarative RISE: \\!\\[mi sto](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-2.png)](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-2.png)\n\n*论文图 2。原论文 Figure 2：“f0 contour for broad focus declarative RISE: [mi sto”。*'
        before = raw.encode()
        images = parse_markdown_images(raw)
        self.assertEqual(len(images), 2)
        self.assertEqual(math_and_emphasis_issues(raw, 'actual-Payne'), [])
        diagnostic = _mask_literal_markdown_image_alt_brackets(raw)
        self.assertNotEqual(diagnostic, raw)
        self.assertEqual(raw.encode(), before)
        self.assertEqual(parse_markdown_images(raw), images)
        self.assertEqual(_mask_literal_markdown_image_alt_brackets(diagnostic), diagnostic)
        self.assertEqual(sanitize_markdown_for_publish(raw), raw)

    def test_only_valid_alt_bracket_escapes_get_formula_pairing_context(self):
        from markdown_hugo_gate import _mask_literal_markdown_image_alt_brackets
        from publish_common import parse_markdown_images, PublishDataValidationError
        image = '![原论文 Figure 1：literal ' + chr(92) + '[e](https://example.org/a.png)'
        for defect in (chr(92) + '[正文未闭合', chr(92) + '(正文未闭合', '正文$50', '正文**未闭合'):
            raw = image + '\n\n' + defect
            self.assertTrue(math_and_emphasis_issues(raw, 'outside-ALT'))
            self.assertTrue(_mask_literal_markdown_image_alt_brackets(raw).endswith(defect))
        for raw in ('![坏图 ' + chr(92) + '[未闭合',
                    image + '\n\n![坏图 ' + chr(92) + '[未闭合',
                    chr(92) + '![转义不是图片 ' + chr(92) + '[e](https://example.org/a.png)',
                    '![合法ALT](https://example.org/' + chr(92) + '[bad.png)'):
            self.assertEqual(_mask_literal_markdown_image_alt_brackets(raw), raw)
            self.assertTrue(math_and_emphasis_issues(raw, 'not-a-literal-ALT-exception'))
        with self.assertRaises(PublishDataValidationError):
            parse_markdown_images('![坏图 ' + chr(92) + '[未闭合')
        self.assertTrue(math_and_emphasis_issues('![ALT $50](https://example.org/a.png)', 'dollars-remain-strict'))
        self.assertTrue(math_and_emphasis_issues('![ALT ' + chr(92) + '(x](https://example.org/a.png)', 'parentheses-remain-strict'))
        html = '<img alt="caption ' + chr(92) + '[x" src="https://example.org/a.png">'
        self.assertTrue(math_and_emphasis_issues(html, 'HTML-unchanged', rendered_html=True))

    def test_alt_slash_parity_and_closed_code_use_same_strict_scanner(self):
        from markdown_hugo_gate import _mask_literal_markdown_image_alt_brackets
        from publish_common import parse_markdown_images
        for n in range(1, 5):
            slashes = chr(92) * n
            raw = '![原论文 Figure 1：' + slashes + '[e' + slashes + ']](https://example.org/a.png)'
            self.assertEqual(len(parse_markdown_images(raw)), 1)
            diagnostic = _mask_literal_markdown_image_alt_brackets(raw)
            self.assertEqual(diagnostic == raw, n % 2 == 0)
            self.assertEqual(math_and_emphasis_issues(raw, 'escape-parity'), [])
        for raw in ('`![代码 ' + chr(92) + '[未闭合`',
                    '```text\n![代码 ' + chr(92) + '[未闭合\n```'):
            self.assertEqual(math_and_emphasis_issues(raw, 'closed-code'), [])
        self.assertTrue(math_and_emphasis_issues('`未闭合代码 ' + chr(92) + '[未闭合', 'unclosed-code'))

    def test_real_hugo_keeps_actual_payne_images_and_literal_summary_visible(self):
        import shutil
        import subprocess
        from html.parser import HTMLParser
        from publish_common import escape_html_like_tags, parse_markdown_images
        if not shutil.which('hugo'):
            self.skipTest('Hugo not installed')
        raw = '[![原论文 Figure 1：f0 contour for broad focus declarative FALL: \\!\\[e me](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-1.png)](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-1.png)\n\n*论文图 1。原论文 Figure 1：“f0 contour for broad focus declarative FALL: [e me”。*\n\n[![原论文 Figure 2：f0 contour for broad focus declarative RISE: \\!\\[mi sto](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-2.png)](https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/1b5b0e9c4c67/figure-2.png)\n\n*论文图 2。原论文 Figure 2：“f0 contour for broad focus declarative RISE: [mi sto”。*'
        self.assertEqual(math_and_emphasis_issues(raw, 'actual-Payne'), [])
        summary = '保留填充词与<unk>的转写与交叉复核'
        body = raw + '\n\n' + escape_html_like_tags(summary)
        class Visible(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=True)
                self.images, self.text = [], []
            def handle_starttag(self, tag, attrs):
                if tag == 'img':
                    values = dict(attrs)
                    self.images.append((values.get('src'), values.get('alt')))
            def handle_data(self, data):
                self.text.append(data)
        with tempfile.TemporaryDirectory(prefix='pd-alt-diagnostic-only-') as temporary:
            root = Path(temporary)
            (root / 'content').mkdir()
            (root / 'layouts/_default').mkdir(parents=True)
            (root / 'hugo.toml').write_text('baseURL="https://example.invalid/"\n[markup.goldmark.renderer]\nunsafe=true\n')
            (root / 'layouts/_default/single.html').write_text('<html><body><article>{{ .Content }}</article></body></html>')
            (root / 'content/reader.md').write_text('---\ntitle: Reader\n---\n' + body)
            output = root / 'public'
            subprocess.run(['hugo', '--source', str(root), '--destination', str(output), '--quiet'], check=True, capture_output=True)
            rendered = (output / 'reader/index.html').read_text()
        visible = Visible(); visible.feed(rendered); visible.close()
        self.assertEqual([url for url, _alt in visible.images], [r['url'] for r in parse_markdown_images(raw)])
        self.assertEqual([alt for _url, alt in visible.images], [
            '原论文 Figure 1：f0 contour for broad focus declarative FALL: ![e me',
            '原论文 Figure 2：f0 contour for broad focus declarative RISE: ![mi sto'])
        self.assertIn('<unk>', ''.join(visible.text))
        self.assertEqual(math_and_emphasis_issues(rendered, 'actual-Hugo', rendered_html=True), [])
        self.assertIn(raw, body)

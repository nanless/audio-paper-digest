import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import daily_html_projection
import test_publish_to_blog as fixture

publish = fixture.publish_to_blog


def _render_with_hugo_passthrough(markdown_map):
    with tempfile.TemporaryDirectory(prefix='hugo-py-formula-parity-') as root_str:
        root = Path(root_str)
        (root / 'content').mkdir(parents=True)
        (root / 'layouts' / '_default').mkdir(parents=True)
        (root / 'hugo.yaml').write_text(
            'baseURL: "https://example.org/"\n'
            'markup:\n'
            '  goldmark:\n'
            '    extensions:\n'
            '      passthrough:\n'
            '        enable: true\n'
            '        delimiters:\n'
            '          block: [["\\\\[", "\\\\]"]]\n'
            '          inline: [["\\\\(", "\\\\)"]]\n'
            '    renderer:\n'
            '      unsafe: true\n',
            encoding='utf-8',
        )
        (root / 'layouts' / '_default' / 'single.html').write_text(
            '<!doctype html><html lang="zh-cn"><head><meta charset="utf-8"><title>{{ .Title }}</title>'
            '<link rel="canonical" href="{{ .Permalink }}"></head><body><main><article><h1>{{ .Title }}</h1>'
            '<div class="post-content">{{ .Content }}</div></article></main></body></html>',
            encoding='utf-8',
        )
        for slug, md in markdown_map.items():
            (root / 'content' / f'{slug}.md').write_text(f'---\ntitle: {slug}\n---\n{md}\n', encoding='utf-8')
        subprocess.run(
            ['hugo', '--source', str(root), '--destination', str(root / 'public'), '--quiet'],
            check=True,
        )
        out = {}
        for slug in markdown_map:
            html_bytes = (root / 'public' / slug.lower() / 'index.html').read_bytes()
            html_text = html_bytes.decode('utf-8')
            # Avoid synthetic wrapper h1_duplicate when testing Setext H1 (`===`)
            proj_input = (
                html_bytes.replace(f'<h1>{slug}</h1>'.encode('utf-8'), b'', 1)
                if '<h1 id=' in html_text
                else html_bytes
            )
            try:
                projected = daily_html_projection.project_current_daily_html(
                    proj_input,
                    expected_canonical=f'https://example.org/{slug.lower()}/',
                )
                proj_math = [
                    event[2]
                    for value in projected['payload'].values()
                    if isinstance(value, list)
                    for event in value
                    if isinstance(event, list) and len(event) >= 3 and event[0] == 'math' and event[1] == 'display'
                ]
                out[slug] = {
                    'html': html_text,
                    'projected_display_math': proj_math,
                    'projection_error': None,
                }
            except daily_html_projection.ProjectionError as exc:
                out[slug] = {
                    'html': html_text,
                    'projected_display_math': None,
                    'projection_error': exc.code,
                }
        return out


class DisplayFormulaExtractionTests(unittest.TestCase):
    def test_truncated_escaped_bracket_in_image_alt_and_tex_double_quotes_preserve_all_formulas(self):
        formula1 = r'\[e_{\text{audio}} = f_{\text{CLAP}}(a_i)\]'
        formula2 = r"\[s_i = \text{sim}\!\left(e_{\text{audio}}, \text{``a'' and ``b''}\right)\]"
        formula3 = '\\[a =\n    b+c\\]'
        article = '\n\n'.join([
            '方法概览如下图所示：',
            r'![原论文 Figure 3：frozen CLAP \[Wu et al.(2023)Wu, Chen,…](https://arxiv.org/html/2611.24410#S3.F3.pic1)',
            '音频编码公式如下：',
            formula1,
            '文本提示对比公式如下：',
            formula2,
            '多行缩进公式如下：',
            formula3,
        ])
        self.assertEqual(
            publish._api_reader_display_formula_blocks(article),
            [formula1, formula2, formula3],
        )

    def test_unmatched_inline_code_open_bracket_does_not_swallow_following_formula(self):
        article = '散文提及起始定界符 `\\[` 后给出展示公式：\n\n\\[e = mc^2\\]'
        self.assertEqual(
            publish._api_reader_display_formula_blocks(article),
            [r'\[e = mc^2\]'],
        )

    def test_paired_inline_code_image_alt_and_fenced_code_are_excluded(self):
        article = '\n\n'.join([
            '成对行内代码：`\\[x = 1\\]` 与带空格的 ` \\[z = 3\\] `。',
            r'![alt \[8\]](https://arxiv.org/html/x/fig.png)',
            '```\n\\[y = 2\\]\n```',
        ])
        self.assertEqual(publish._api_reader_display_formula_blocks(article), [])

    def test_unclosed_prose_open_bracket_and_passthrough_before_bang_match_hugo(self):
        unclosed = r'散文中出现未闭合 \[ 符号 ![alt](https://arxiv.org/html/x/fig.png) 后续无闭合。'
        self.assertEqual(publish._api_reader_display_formula_blocks(unclosed), [])

        passthrough_before_bang = r'散文 \[x=1+![a\]](https://arxiv.org/html/x/fig.png)'
        self.assertEqual(
            publish._api_reader_display_formula_blocks(passthrough_before_bang),
            [r'\[x=1+![a\]'],
        )
        if shutil.which('hugo'):
            rendered = _render_with_hugo_passthrough({'passthroughbeforebang': passthrough_before_bang})
            self.assertEqual(rendered['passthroughbeforebang']['projected_display_math'], [r'\[x=1+![a\]'])

    def test_double_and_triple_backslash_fail_closed_while_quad_and_quint_are_literal(self):
        self.assertEqual(publish._api_reader_display_formula_blocks(r'\\[x=1\\]'), [r'\\[x=1\\]'])
        self.assertEqual(publish._api_reader_display_formula_blocks(r'\\\[x=1\\\]'), [r'\\\[x=1\\\]'])
        self.assertEqual(publish._api_reader_display_formula_blocks(r'\\[x=1 unclosed'), [r'\\[x=1 unclosed'])
        self.assertEqual(
            publish._api_reader_display_formula_blocks('\\\\\\\\[x=1\\\\\\\\]\n\n\\[e = mc^2\\]'),
            [r'\[e = mc^2\]'],
        )
        self.assertEqual(
            publish._api_reader_display_formula_blocks('\\\\\\\\\\[x=1\\\\\\\\\\]\n\n\\[e = mc^2\\]'),
            [r'\[e = mc^2\]'],
        )

        paper = fixture.llm_api_publication_fixture()
        paper['apiReaderArticle'] += '\n\n\\\\[x=1\\\\]'
        fixture.reseal_llm_api_reader_fixture(paper)
        with self.assertRaises(publish.PublishDataValidationError):
            publish._validate_api_reader_source_bindings(paper)

    def test_html_comments_and_alt_passthrough_precedence_match_hugo_and_projection(self):
        cases = {
            'midlinecommentacrossblank': (
                '前文 <!--\n\n\\[live=1\\]\n\n--> 后文 \\[e=mc^2\\]',
                [r'\[live=1\]', r'\[e=mc^2\]'],
            ),
            'midlinecommentclosedsamepara': (
                '前文 <!--\n\\[hidden=1\\]\n--> 后文 \\[e=mc^2\\]',
                [r'\[e=mc^2\]'],
            ),
            'midlinecommentunclosed': (
                '前文 <!-- \\[live=1\\]',
                [r'\[live=1\]'],
            ),
            'escapedcommentlinestart': (
                r'\<!-- \[live=1\] -->',
                [r'\[live=1\]'],
            ),
            'escapedcommentmidline': (
                r'前文 \<!-- \[live=1\] -->',
                [r'\[live=1\]'],
            ),
            'mathbeforeinlinecomment': (
                r'散文 \[x=1+<!--\]-->',
                [r'\[x=1+<!--\]'],
            ),
            'blockcommentsamelinetail': (
                '<!-- comment --> \\[e=mc^2\\]',
                [r'\[e=mc^2\]'],
            ),
            'blockcommentmultiline': (
                '<!--\n\\[hidden=1\\]\n-->\n\n\\[e=mc^2\\]',
                [r'\[e=mc^2\]'],
            ),
            'abruptshortcomment': (
                '<!-->\n\n\\[live=1\\]',
                [r'\[live=1\]'],
            ),
            'altpassthroughsteal': (
                r'![alt \[Wu](https://arxiv.org/html/x/fig.png)+1\]',
                [r'\[Wu](https://arxiv.org/html/x/fig.png)+1\]'],
            ),
            'altpassthroughsamepara': (
                r'![alt \[Wu](https://arxiv.org/html/x/fig.png) \[e=mc^2\]',
                [r'\[Wu](https://arxiv.org/html/x/fig.png) \[e=mc^2\]'],
            ),
            'altpairedpassthrough': (
                r'![alt \[8\]](https://arxiv.org/html/x/fig.png) \[e=mc^2\]',
                [r'\[e=mc^2\]'],
            ),
            'altpairedunbalancedbracket': (
                r'![alt \[a ] b\]](https://arxiv.org/html/x/fig.png) \[e=mc^2\]',
                [r'\[e=mc^2\]'],
            ),
            'divrawcommentmultiline': (
                '正文。\n\n<div>\n<!--\n</div>\n\n\\[bound=1\\]\n\n<div>\n-->\n</div>',
                [],
            ),
            'divrawcommentsingleline': (
                '正文。\n\n<div><!--</div>\n\n\\[bound=1\\]\n\n<div>--></div>',
                [],
            ),
            'divrawbacktickcomment': (
                '正文。\n\n<div>\n`<!--`\n</div>\n\n\\[bound=1\\]\n\n<div>--></div>',
                [],
            ),
            'quoteexitedrawcomment': (
                '> <!--\n\n\\[bound=1\\]\n\n<div>--></div>',
                [],
            ),
            'multicommenttype2line': (
                '<!-- a --> <!--\n\\[bound=1\\]\n-->\n\n\\[live=2\\]',
                [r'\[live=2\]'],
            ),
            'scriptliteralcommentnotleaked': (
                '<script>\n<!--\n</script>\n\n\\[e=mc^2\\]',
                [r'\[e=mc^2\]'],
            ),
        }
        for slug, (md, expected) in cases.items():
            with self.subTest(slug=slug):
                self.assertEqual(publish._api_reader_display_formula_blocks(md), expected)

        if shutil.which('hugo'):
            rendered = _render_with_hugo_passthrough({slug: md for slug, (md, _expected) in cases.items()})
            for slug, (_md, expected) in cases.items():
                with self.subTest(hugo_projection=slug):
                    for formula in expected:
                        self.assertIn(formula, rendered[slug]['html'])
                    if rendered[slug]['projection_error'] is None:
                        self.assertEqual(rendered[slug]['projected_display_math'], expected)

    def test_thematic_breaks_list_containers_continuation_images_balanced_alt_and_block_boundaries(self):
        cases = {
            'thematichr': ('---\n    \\[y = 2\\]', []),
            'quotedthematichr': ('> ---\n>     \\[y = 2\\]', []),
            'setextunderline': ('Heading\n===\n    \\[y = 2\\]\n\nSubheading\n---\n    \\[z = 3\\]', []),
            'listmultiparagraphbullet': ('- item\n\n    \\[e = mc^2\\]', [r'\[e = mc^2\]']),
            'listmultiparagraphordered': ('1. item\n\n    \\[e = mc^2\\]', [r'\[e = mc^2\]']),
            'listindentedcode6': ('- item\n\n      \\[code = 1\\]', []),
            'listindentedfence': ('- item\n    ~~~\n    \\[x=1\\]\n    ~~~', []),
            'nestedlistitems': ('- outer\n    - inner \\[0, 1)\n    - inner2 \\[e = mc^2\\]', [r'\[e = mc^2\]']),
            'contlineimage': (
                '方法概览如下：\n    ![alt \\[Wu](https://arxiv.org/html/x/fig.png)\n\n\\[e = mc^2\\]',
                [r'\[e = mc^2\]'],
            ),
            'balancedaltimage': (
                '![Figure 1 [0, 1] \\[Wu](https://arxiv.org/html/x/fig(1).png "title (1)")\n\n\\[e = mc^2\\]',
                [r'\[e = mc^2\]'],
            ),
            'unclosedbang': (
                '散文感叹号 ![ 未闭合以及 ![alt](https://arxiv.org/html/x/fig.png 未闭合\n\n\\[e = mc^2\\]',
                [r'\[e = mc^2\]'],
            ),
            'orderedlistandquote': (
                '\n'.join([
                    '1. 第一项 \\[0, 1)',
                    '2. 第二项 `\\[skip\\]`',
                    '',
                    '> 引用第一段 \\[0, 1)',
                    '>',
                    '> 引用第二段',
                    '',
                    '`code` # not-a-heading `\\[x\\]`',
                    '',
                    '\\[e = mc^2\\]',
                ]),
                [r'\[e = mc^2\]'],
            ),
            'crossblockhalfopen': (
                '\n'.join([
                    '## 标题区间 \\[0, 1)',
                    '',
                    '散文半开区间 \\[0, 1) 不闭合。',
                    '',
                    '- 列表半开区间 \\[0, 1)',
                    '- 另一列表项',
                    '',
                    '| 列 A | 列 B |',
                    '| --- | --- |',
                    '| \\[0, 1) | \\[e = mc^2\\] |',
                ]),
                [r'\[e = mc^2\]'],
            ),
            'blankinsideformula': ('\\[\na = 1\n\nb = 2\n\\]', []),
        }
        for slug, (md, expected) in cases.items():
            with self.subTest(slug=slug):
                self.assertEqual(publish._api_reader_display_formula_blocks(md), expected)

        if shutil.which('hugo'):
            rendered = _render_with_hugo_passthrough({slug: md for slug, (md, _expected) in cases.items()})
            for slug, (_md, expected) in cases.items():
                with self.subTest(hugo_projection=slug):
                    for formula in expected:
                        self.assertIn(formula, rendered[slug]['html'])
                    if rendered[slug]['projection_error'] is None:
                        self.assertEqual(rendered[slug]['projected_display_math'], expected)
                    else:
                        # Raw HTML comment or nested \[ emitted by passthrough fails closed in both extractor & projection
                        self.assertTrue(len(expected) > 0)

    def test_source_bindings_validation_passes_when_truncated_image_alt_precedes_formula(self):
        paper = fixture.llm_api_ephemeral_figure_fixture()
        formula = publish._api_reader_display_formula_blocks(paper['apiReaderArticle'])[0]
        figure = paper['apiReaderFigures'][0]
        url = figure['url']
        old_image_match = publish.parse_markdown_images(paper['apiReaderArticle'])[0]
        old_image = old_image_match['raw']
        new_image = f'![原论文 Figure 3：frozen CLAP \\[Wu et al.(2023)Wu, Chen,…]({url})'
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old_image, new_image, 1)
        fig_start = paper['apiReaderArticle'].index(figure['leadQuote'])
        fig_end = paper['apiReaderArticle'].index(figure['explanationQuote']) + len(figure['explanationQuote'])
        fig_block = paper['apiReaderArticle'][fig_start:fig_end]
        if fig_start > paper['apiReaderArticle'].index(formula):
            without_fig = (paper['apiReaderArticle'][:fig_start] + paper['apiReaderArticle'][fig_end:]).strip()
            paper['apiReaderArticle'] = without_fig.replace(
                formula,
                fig_block + '\n\n前置符号说明 `\\[` 不开启展示公式。\n\n' + formula,
                1,
            )
        self.assertLess(paper['apiReaderArticle'].index(new_image), paper['apiReaderArticle'].index(formula))
        fixture.reseal_llm_api_reader_fixture(paper)
        publish._validate_api_reader_source_bindings(paper)
        page, _ = publish.generate_paper_page(paper, '2026-08-31')
        self.assertIn(formula, page)

    def test_display_formula_closing_requires_odd_backslash_run_and_table_projection_guards_pipes(self):
        import blog_formula_tex_display as display

        # Even backslashes before `]` (e.g. `\\]`) must NOT terminate a `\[ ... \]` display formula
        self.assertEqual(
            display.api_reader_display_formula_blocks(r'\[ a \\] b \]'),
            [r'\[ a \\] b \]'],
        )
        # Odd backslashes before `]` (e.g. `\\\]`) DO terminate `\[ ... \]`
        self.assertEqual(
            display.api_reader_display_formula_blocks(r'\[ a \\\] trailing'),
            [r'\[ a \\\]'],
        )
        # Missing closing pipe in table row must raise PublishDataValidationError, not IndexError
        malformed_table = '| A | B |\n| --- | --- |\n| x \\| y\n'
        plan = {
            'tableBindings': [{
                'sourceType': 'artifact_table',
                'tableIndex': 1,
                'cellBindings': [{'renderedRow': 1, 'renderedColumn': 1, 'sourceText': 'y'}],
            }],
        }
        with self.assertRaises(display.PublishDataValidationError):
            display.project_artifact_table_cell_tex_display(malformed_table, plan)


if __name__ == '__main__':
    unittest.main()

import copy
import shutil
import subprocess
import tempfile
import unittest
import json
from pathlib import Path

from test_publish_to_blog import publish_to_blog as publish, llm_api_publication_fixture, reseal_llm_api_reader_fixture
from markdown_hugo_gate import mask_source_bound_title_dollars, math_and_emphasis_issues, validate_hugo_rendered_html_gate


TITLE = 'Oído: Open-Vocabulary Speech Recognition on a $5 Microcontroller without a Neural Accelerator'


class TitleLiteralDollarTests(unittest.TestCase):
    def test_literal_title_stars_are_explicit_and_idempotent(self):
        for title, expected in [
                ('Probing the phon* representations of the Mimi codebooks',
                 r'Probing the phon\* representations of the Mimi codebooks'),
                ('H1*-H2* and a $5 System', r'H1\*-H2\* and a \$5 System'),
                (r'Already phon\* and \$5', r'Already phon\* and \$5'),
                ('A **literal** title', r'A \*\*literal\*\* title')]:
            with self.subTest(title=title):
                self.assertEqual(publish.markdown_title_for_publish(title), expected)
                self.assertEqual(publish.markdown_title_for_publish(expected), expected)

    @unittest.skipUnless(shutil.which('hugo'), 'Hugo not installed')
    def test_real_hugo_literal_star_title_keeps_the_same_link_and_visible_text(self):
        title = 'Probing the phon* representations of the Mimi codebooks'
        url = 'https://example.invalid/phon-star'
        with tempfile.TemporaryDirectory(prefix='pd-title-star-test-') as temporary:
            root = Path(temporary)
            (root / 'content').mkdir()
            (root / 'layouts/_default').mkdir(parents=True)
            (root / 'hugo.toml').write_text('baseURL="https://example.invalid/"\n')
            (root / 'layouts/_default/single.html').write_text('{{ .Content }}')
            for name, shown in [('raw', title), ('explicit', publish.markdown_title_for_publish(title))]:
                (root / f'content/{name}.md').write_text(
                    f'---\ntitle: "Literal star"\n---\n\n> 英文题目：*[{shown}]({url})*\n')
            subprocess.run(['hugo', '--source', str(root), '--destination', str(root / 'public'),
                            '--cacheDir', str(root / 'cache'), '--quiet'],
                           check=True, capture_output=True, timeout=30)
            raw = (root / 'public/raw/index.html').read_text()
            explicit = (root / 'public/explicit/index.html').read_text()
            self.assertEqual(explicit, raw)
            self.assertIn(f'<em><a href="{url}">{title}</a></em>', explicit)
            self.assertNotIn(r'phon\*', explicit)

    def test_price_titles_preserve_literal_currency_and_math_compatibility(self):
        for title, expected in [(TITLE, TITLE), ('A $5 and $10 System', 'A $5 and $10 System'),
                                (r'A \$5 System', 'A $5 System'),
                                (r'EXAM$^2$: $\underline{Ex}tending$ Audio', 'EXAM²: Extending Audio'),
                                (r'$F^2$ and $x$ Methods', 'F² and x Methods')]:
            with self.subTest(title=title):
                self.assertEqual(publish.plain_title_for_publish(title), expected)
                shown = publish.markdown_title_for_publish(title)
                self.assertNotIn('$', shown.replace(r'\$', ''))
                self.assertEqual(publish.markdown_title_for_publish(shown), shown)

    def test_summary_scored_unscored_and_individual_share_title_rendering_without_mutation(self):
        paper = llm_api_publication_fixture()
        paper['title'] = TITLE
        before = copy.deepcopy(paper)
        aid = paper['arxivId']
        for scored, unscored in [([(8, paper, paper['parsed'])], []), ([], [paper])]:
            markdown = publish.generate_index_page(scored, unscored, '2026-10-15', {aid: 'dollar-title'})
            self.assertIn(r'Oído: Open-Vocabulary Speech Recognition on a \$5', markdown)
            self.assertIn(r'\$5 Microcontroller without a Neural Accelerator](', markdown)
            self.assertFalse(any('裸 $' in issue for issue in math_and_emphasis_issues(markdown.split('---', 2)[-1], 'index')))
        single, _slug = publish.generate_paper_page(paper, '2026-10-15')
        self.assertIn(f'title: "{TITLE}"', single)
        self.assertIn(r'\$5 Microcontroller without a Neural Accelerator](', single)
        self.assertEqual(paper, before)
        fallback, _slug = publish.generate_paper_page({'title': 'A $5 and $10 System', 'arxivId': '2610.00001', 'parsed': {'score': '7.0', 'tags': []}}, '2026-10-15')
        self.assertIn(r'# 📄 A \$5 and \$10 System', fallback)
        self.assertIn('title: "A $5 and $10 System"', fallback)

    def artifact(self, body):
        return {'path': 'title.md', 'frontmatter': {'title': 'Dollar', 'paper_digest_page_type': 'index',
                'paper_digest_api_reader_contract': 'beginner-researcher-v3'}, 'body': body}

    def test_reader_title_quotes_and_backslashes_keep_plan_and_metadata_identity(self):
        paper = llm_api_publication_fixture()
        title = '读懂 "quoted" 方法与 C:\\models 的 $5 设置'
        paper['apiReaderPlan']['readerTitle'] = title
        reseal_llm_api_reader_fixture(paper)
        before = copy.deepcopy(paper)
        markdown, _slug = publish.generate_paper_page(paper, '2026-10-15')
        self.assertIn('# 📄 ' + title.replace('$', r'\$'), markdown)
        self.assertIn('paper_digest_reader_title: ' + json.dumps(title, ensure_ascii=False), markdown)
        self.assertEqual(paper, before)
        self.assertEqual(paper['apiReaderPlan']['readerTitle'], title)

    def test_exact_source_title_binding_and_multiset_fail_closed(self):
        body = '# Title \\$5\n\n> 英文题目：*[Oído \\$5](https://example.invalid/paper)*\n'
        artifact = self.artifact(body)
        good = '<h1>Title $5</h1><blockquote><p>英文题目：<em><a href="https://example.invalid/paper">Oído $5</a></em></p></blockquote>'
        self.assertEqual(math_and_emphasis_issues(mask_source_bound_title_dollars(good, artifact), 'html', rendered_html=True), [])
        for page in [good.replace('/paper', '/wrong'), good.replace('Oído $5', 'Oído $6'),
                     good.replace('Oído $5', 'Oído $5 $6'), good + '<a href="https://example.invalid/paper">Oído $5</a>',
                     good + '<p>price $5</p>', good + '<p>$x$</p>',
                     *[good.replace('Oído $5', f'<{tag}>Oído $5</{tag}>') for tag in ['script', 'style', 'span']],
                     *[f'<{tag}>' + good + f'</{tag}>' for tag in ['script', 'style', 'pre', 'code', 'template']],
                     '<div hidden>' + good + '</div>',
                     '<span style="display:none">' + good + '</span>',
                     good.replace('href="https://example.invalid/paper"', 'href="https://wrong.invalid/" href="https://example.invalid/paper"'),
                     good.replace('Oído $5', 'Oído <!--hidden-->$5')]:
            with self.subTest(page=page):
                self.assertTrue(math_and_emphasis_issues(mask_source_bound_title_dollars(page, artifact), 'html', rendered_html=True))
        # 标题源绑定仍不接纳 code 子节点；闭合字面代码由独立格式规则处理。
        # 不把格式通过误当作来源标题身份匹配，也不豁免代码外裸美元。
        code_page = good.replace('Oído $5', '<code>Oído $5</code>')
        masked_code = mask_source_bound_title_dollars(code_page, artifact)
        self.assertIn('<code>Oído $5</code>', masked_code)
        self.assertEqual(math_and_emphasis_issues(masked_code, 'html', rendered_html=True), [])
        for outside in ['<p>price $5</p>', '<p>Oído $5</p>', '<p>$x$</p>']:
            self.assertTrue(math_and_emphasis_issues(masked_code + outside, 'html', rendered_html=True))
        for code_label in ['Oído $6', 'Oído $5 $6']:
            mismatched_code = code_page.replace('Oído $5', code_label)
            self.assertIn('<code>' + code_label + '</code>',
                          mask_source_bound_title_dollars(mismatched_code, artifact))
        for source in [body.replace(r'\$', '$'), '[Oído \\$5](https://example.invalid/paper)',
                       '> 英文题目：*[Oído \\$5 $x$](https://example.invalid/paper)*',
                       '```markdown\n' + body + '```', '<!--\n' + body + '-->',
                       '<div hidden>\n' + body + '</div>', '    ' + body.replace('\n', '\n    ')]:
            self.assertTrue(math_and_emphasis_issues(mask_source_bound_title_dollars(good, self.artifact(source)), 'html', rendered_html=True))
        inline_example = '> 英文题目：`[Oído \\$5](https://example.invalid/paper)`'
        actual = '<a href="https://example.invalid/paper">Oído $5</a>'
        self.assertEqual(mask_source_bound_title_dollars(actual, self.artifact(inline_example)), actual)
        self.assertTrue(math_and_emphasis_issues('$x$', 'raw'))

    @unittest.skipUnless(shutil.which('hugo'), 'Hugo not installed')
    def test_real_hugo_escaped_title_survives_full_rendered_gate(self):
        body = '# Title \\$5\n\n> 英文题目：*[Oído \\$5](https://example.invalid/paper)*\n'
        with tempfile.TemporaryDirectory(prefix='pd-title-dollar-test-') as temporary:
            root = Path(temporary)
            (root / 'content').mkdir()
            (root / 'layouts/_default').mkdir(parents=True)
            (root / 'hugo.toml').write_text('baseURL="https://example.invalid/"\n')
            (root / 'layouts/_default/single.html').write_text('<html><head><title>{{ .Title }}</title></head><body><article><div class="post-content">{{ .Content }}</div></article></body></html>')
            (root / 'content/title.md').write_text('---\ntitle: "Dollar"\n---\n' + body)
            subprocess.run(['hugo', '--source', str(root), '--destination', str(root / 'public'), '--quiet'], check=True, capture_output=True)
            output = root / 'public/title/index.html'
            rendered = output.read_text()
            self.assertIn('Oído $5', rendered)
            self.assertNotIn(r'\$5', rendered)
            self.assertEqual(validate_hugo_rendered_html_gate(root / 'public', [self.artifact(body)]), [])
            output.write_text(rendered.replace('</div>', '<p>$x$</p></div>'))
            self.assertTrue(any('裸 $' in issue for issue in validate_hugo_rendered_html_gate(root / 'public', [self.artifact(body)])))


if __name__ == '__main__':
    unittest.main()

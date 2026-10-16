import hashlib
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from publish_common import (escape_markdown_table_currency_units, fix_latex_delimiters,
                            is_publish_currency_unit_literal, sanitize_markdown_for_publish,
                            decode_publish_currency_unit_display, PublishDataValidationError)
from markdown_hugo_gate import math_and_emphasis_issues, validate_hugo_rendered_html_gate

# Exact two original saved AdaFrame Reader tables (2610.19127v1).
# Source SHA c8c369d772847f9ef581a186a774b18bc9bee5be191b3bb974cec02dd5ad334f;
# Reader SHA 1ac103c9ec69915927c973e9bd2062f4a0215d9014c477f843ba0b3812bbf10c.
ADAFRAME_TABLES = '''| Method | Frames | Total Cost ($) | Topic Acc. (%) | Sentiment (%) | Eff. Score |
| --- | --- | --- | --- | --- | --- |
| AdaFrame (Ours) | 24.6 | 1.43 | 86.0 [82.7–88.8] | 79.4 [75.6–82.7] | 4.33 |
| Uniform-1FPS | 47.7 | 5.74 | 84.4 [80.7–87.5] | 71.9 [67.7–75.8] | 4.20 |
| CLIP Only | 74.1 | 6.79 | 83.7 [79.7–87.0] | 71.6 [67.3–75.5] | 4.19 |
| PySceneDetect | 20.4 | 1.47 | 78.8 [74.8–82.3] | 65.7 [61.4–69.8] | 4.12 |
| Gemini Native | — | 5.45 | 84.4 [80.9–87.3] | 71.3 [67.2–75.1] | 4.11 |

| VLM Backend | Total Cost ($) | Topic (%) | Sentiment (%) | Eff. |
| --- | --- | --- | --- | --- |
| Gemini 2.5 Flash | 1.43 | 86.0 | 79.4 | 4.33 |
| Claude 3 Haiku | 1.51 | 85.6 | 80.1 | 4.30 |'''


class TableCurrencyUnitLiteralTest(unittest.TestCase):
    def test_display_decoder_never_generalizes_source_backslash_unescaping(self):
        self.assertEqual(decode_publish_currency_unit_display(r'Total Cost (\$)'), 'Total Cost ($)')
        for value in (r'Total Cost (\\$)', r'Cost (\$x\$)', r'Cost (\$x)', r'Cost \$5',
                      r'Cost (\$) + x', r'`Cost (\$)`', r'\(Cost (\$)\)', r'x (\$)'):
            self.assertEqual(decode_publish_currency_unit_display(value), value)

    def test_node_canonical_cell_boundary_keeps_real_source_backslashes(self):
        module = Path(__file__).resolve().parents[2] / 'scripts/lib/reader-source-display.js'
        values = ['Total Cost ($)', r'Total Cost (\$)', r'Total Cost (\\$)', r'Cost (\$x\$)']
        output = subprocess.check_output(['node', '-e',
            'const m=require(process.argv[1]); console.log(JSON.stringify(JSON.parse(process.argv[2]).map(m.normalizeReaderSourceDisplayArtifacts)));',
            str(module), json.dumps(values)], text=True)
        self.assertEqual(json.loads(output), values)

    def currency_source_fixture(self, header='Total Cost ($)'):
        from test_publish_to_blog import llm_api_publication_fixture, reseal_llm_api_reader_fixture, publish_to_blog
        paper = llm_api_publication_fixture()
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace('| 方法 | WER |', '| 方法 | ' + header + ' |')
        binding = paper['apiReaderPlan']['tableBindings'][0]
        binding['renderedTableSha256'] = hashlib.sha256(publish_to_blog._api_reader_markdown_tables(paper['apiReaderArticle'])[0]['markdown'].encode()).hexdigest()
        for cell in binding['cellBindings']:
            if cell['renderedText'] == 'WER':
                cell['renderedText'] = cell['sourceText'] = header
        reseal_llm_api_reader_fixture(paper)
        return publish_to_blog, paper, reseal_llm_api_reader_fixture

    def test_complete_artifact_binding_accepts_only_view_escape_and_keeps_original_proofs(self):
        publisher, paper, reseal = self.currency_source_fixture()
        original = copy.deepcopy(paper)
        view = sanitize_markdown_for_publish(paper['apiReaderArticle'])
        self.assertEqual(publisher._validate_api_reader_source_bindings(paper, article=view),
                         publisher._validate_api_reader_source_bindings(paper))
        self.assertEqual(paper, original)
        self.assertFalse(publisher._reader_merged_cell_matches(paper,
            paper['apiReaderPlan']['tableBindings'][0],
            paper['apiReaderPlan']['tableBindings'][0]['cellBindings'][1], 'Total Cost ($)'))
        for kind in ('source_backslash', 'wrong_source_unit', 'wrong_dom_sha', 'wrong_canonical_table_sha'):
            with self.subTest(kind=kind):
                bad = copy.deepcopy(paper)
                binding = bad['apiReaderPlan']['tableBindings'][0]
                cell = binding['cellBindings'][1]
                if kind == 'source_backslash': cell['sourceText'] = r'Total Cost (\$)'
                elif kind == 'wrong_source_unit': cell['sourceText'] = 'Total Cost (USD)'
                elif kind == 'wrong_dom_sha': cell['sourceDomSha256'] = 'invalid'
                else: binding['renderedTableSha256'] = 'f' * 64
                reseal(bad)
                with self.assertRaises(PublishDataValidationError):
                    publisher._validate_api_reader_source_bindings(bad, article=view)
        publisher, literal_source, _ = self.currency_source_fixture(r'Total Cost (\$)')
        # A real backslash in canonical source/renderedText must not disappear.
        publisher._validate_api_reader_source_bindings(literal_source)
        with self.assertRaises(PublishDataValidationError):
            publisher._validate_api_reader_source_bindings(literal_source,
                article=literal_source['apiReaderArticle'].replace(r'Total Cost (\$)', 'Total Cost ($)'))

    def test_source_quotes_numeric_and_header_units_keep_the_same_strict_rules(self):
        publisher, paper, reseal = self.currency_source_fixture()
        binding = paper['apiReaderPlan']['tableBindings'][0]
        quote = 'Total Cost ($) is 10.2 for Baseline and 8.4 for Ours under the same setup.'
        binding.update(sourceType='source_quotes', sourceTableOrdinal=None, cellBindings=[],
                       sourceQuotes=[{'quote': quote, 'sourceQuoteSha256': hashlib.sha256(quote.encode()).hexdigest()}])
        del binding['sourceTableDomSha256']
        reseal(paper)
        view = sanitize_markdown_for_publish(paper['apiReaderArticle'])
        publisher._validate_api_reader_source_bindings(paper, article=view)
        raw_table = publisher._api_reader_markdown_tables(paper['apiReaderArticle'])[0]
        view_table = publisher._api_reader_markdown_tables(view)[0]
        self.assertEqual(publisher._api_reader_numeric_tokens(raw_table['markdown']), publisher._api_reader_numeric_tokens(view_table['markdown']))
        self.assertEqual(publisher._reader_table_header_unit_evidence_failures(raw_table, [quote]),
                         publisher._reader_table_header_unit_evidence_failures(view_table, [quote]))
        missing = copy.deepcopy(paper)
        record = missing['apiReaderPlan']['tableBindings'][0]['sourceQuotes'][0]
        record['quote'] = record['quote'].replace('8.4', '9.4')
        record['sourceQuoteSha256'] = hashlib.sha256(record['quote'].encode()).hexdigest()
        reseal(missing)
        with self.assertRaises(PublishDataValidationError):
            publisher._validate_api_reader_source_bindings(missing, article=view)

    def test_saved_adaframe_tables_only_escape_two_literal_units(self):
        before = hashlib.sha256(ADAFRAME_TABLES.encode()).hexdigest()
        fixed = sanitize_markdown_for_publish(ADAFRAME_TABLES)
        self.assertEqual(fixed, ADAFRAME_TABLES.replace('Total Cost ($)', r'Total Cost (\$)'))
        self.assertEqual(fixed.replace(r'\$', '$'), ADAFRAME_TABLES)
        self.assertEqual(sanitize_markdown_for_publish(fixed), fixed)
        self.assertEqual(math_and_emphasis_issues(fixed, 'AdaFrame'), [])
        self.assertTrue(math_and_emphasis_issues(ADAFRAME_TABLES, 'AdaFrame'))
        self.assertEqual(hashlib.sha256(ADAFRAME_TABLES.encode()).hexdigest(), before)

    def test_only_explicit_currency_unit_labels_are_recognized(self):
        for cell in ('Total Cost ($)', 'Training cost ($)', 'Price ($)', '费用 ($)', '预算 ($)'):
            with self.subTest(cell=cell):
                self.assertTrue(is_publish_currency_unit_literal(cell))
        for cell in ('$x$', '$5$', '$cost$', 'Cost ($x)', 'Cost ($x$)', 'Cost ($) + x',
                     'cost ($$)', r'Cost (\$)', '`Cost ($)`', 'x ($)', 'Cost ($5 + 2)', 'cost ($) $x$'):
            with self.subTest(cell=cell):
                self.assertFalse(is_publish_currency_unit_literal(cell))

    def test_preserves_math_escape_code_urls_and_non_tables(self):
        table = '| Cost ($) | Math |\n|---|---|\n| $0.2 | $x_i$ |'
        fixed = fix_latex_delimiters(table)
        self.assertEqual(fixed, '| Cost (\\$) | Math |\n|---|---|\n| $0.2 | \\(x_i\\) |')
        for text in (r'| Cost (\$) | math |', '| Cost ($) | orphan |',
                     'A cost ($) is a prose example.', '`Cost ($)`',
                     '```text\n' + table + '\n```', '````text\n```\n' + table + '\n````',
                     '    | Cost ($) | Math |\n    |---|---|\n    | 1 | 2 |',
                     '| `Cost ($)` | https://example.invalid/$x$ |\n|---|---|\n| 1 | 2 |'):
            with self.subTest(text=text):
                self.assertEqual(escape_markdown_table_currency_units(text), text)

    def test_rendered_gate_requires_direct_real_plain_currency_cells(self):
        for tag in ('th', 'td'):
            text = f'<table><tr><{tag}>Total Cost ($)</{tag}></tr></table>'
            self.assertEqual(math_and_emphasis_issues(text, 'Reader', rendered_html=True), [])
        for text in ('<p>Total Cost ($)</p>', '<td>Total Cost ($)</td>',
                     '<table><td>Total Cost ($)</td></table>',
                     '<table><tr><td><span>Total Cost ($)</span></td></tr></table>',
                     '<table><tr><td>Total Cost ($)<!-- extra --></td></tr></table>',
                     '<table><tr><td>Cost ($x$)</td></tr></table>',
                     '<table><tr><td>$cost$</td></tr></table>',
                     '<table><tr><td>Total Cost ($)</td></tr></table><p>$x$</p>'):
            with self.subTest(text=text):
                self.assertTrue(math_and_emphasis_issues(text, 'Reader', rendered_html=True))

    @unittest.skipUnless(shutil.which('hugo'), 'Hugo unavailable')
    def test_saved_tables_through_normal_sanitize_and_real_hugo_html_gate(self):
        body = sanitize_markdown_for_publish(ADAFRAME_TABLES + '\n\n配对数学为 $x_i$。\n')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'layouts/_default').mkdir(parents=True)
            (root / 'content/posts').mkdir(parents=True)
            (root / 'hugo.toml').write_text(r'''baseURL = 'https://example.invalid/'
[markup.goldmark.extensions.passthrough]
enable = true
[markup.goldmark.extensions.passthrough.delimiters]
inline = [['\(', '\)']]
block = [['\[', '\]']]
''')
            (root / 'layouts/_default/single.html').write_text(
                '<html><head><title>{{ .Title }}</title></head><body><article><div class="post-content">{{ .Content }}</div></article></body></html>')
            (root / 'content/posts/adaframe.md').write_text('---\ntitle: "AdaFrame currency"\n---\n' + body)
            subprocess.run(['hugo', '--source', str(root), '--destination', str(root / 'public'), '--quiet'],
                           check=True, capture_output=True)
            rendered = (root / 'public/posts/adaframe/index.html').read_text()
            self.assertEqual(rendered.count('<th>Total Cost ($)</th>'), 2)
            self.assertIn(r'\(x_i\)', rendered)
            artifact = {'path': 'posts/adaframe.md', 'frontmatter': {'title': 'AdaFrame currency',
                        'paper_digest_api_reader_contract': 'beginner-researcher-v3'}, 'body': body}
            self.assertEqual(validate_hugo_rendered_html_gate(root / 'public', [artifact]), [])


if __name__ == '__main__':
    unittest.main()

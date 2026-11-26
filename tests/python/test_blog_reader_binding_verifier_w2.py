import hashlib
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'scripts'))

from test_publish_to_blog import (
    publish_to_blog as publish,
    llm_api_publication_fixture,
    reseal_llm_api_reader_fixture,
)
import blog_formula_tex_display as formula_display  # noqa: E402


def table_fixture(quote, header, cell):
    paper = llm_api_publication_fixture()
    table = f'| Method | {header} |\n|---|---|\n| A | {cell} |'
    old = publish._api_reader_markdown_tables(paper['apiReaderArticle'])[0]['markdown']
    paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old, table)
    paper['apiReaderPlan']['tableBindings'][0] = {
        'tableIndex': 1,
        'sourceType': 'source_quotes',
        'sourceTableOrdinal': None,
        'renderedTableSha256': hashlib.sha256(table.encode()).hexdigest(),
        'cellBindings': [],
        'sourceQuotes': [{'quote': quote, 'sourceQuoteSha256': hashlib.sha256(quote.encode()).hexdigest()}],
    }
    reseal_llm_api_reader_fixture(paper)
    return paper


class BlogReaderBindingVerifierW2Tests(unittest.TestCase):
    def test_global_numeric_tokens_unchanged_for_cold_replay(self):
        self.assertEqual(publish._api_reader_numeric_tokens('12 MB'), ['12'])
        self.assertEqual(publish._api_reader_numeric_tokens('16 GiB'), ['16'])
        self.assertEqual(publish._api_reader_numeric_tokens('2.5 h'), ['2.5'])
        self.assertEqual(publish._api_reader_numeric_tokens('128 kbps'), ['128'])

    def test_explicit_cell_units_pass_when_quote_matches(self):
        cases = [
            ('The checkpoint takes 12 MB on disk.', 'Size (MB)', '12 MB'),
            ('Peak memory reaches 16 GiB on a single GPU.', 'VRAM (GiB)', '16 GiB'),
            ('Full training completes in 2.5 h across 8 GPUs.', 'Duration (h)', '2.5 h'),
            ('Buffer uses 512 MiB scratchpad.', 'Memory (MiB)', '512 MiB'),
            ('Scratchpad is 64 KiB per stream.', 'Cache (KiB)', '64 KiB'),
            ('Audio bitrate is 128 kbps in streaming mode.', 'Bitrate (kbps)', '128 kbps'),
            ('Transfer rate reaches 4.5 Mbps.', 'Bandwidth (Mbps)', '4.5 Mbps'),
            ('Corpus archive totals 1.2 TB.', 'Storage (TB)', '1.2 TB'),
            ('CPU clock runs at 3.2 GHz.', 'Clock (GHz)', '3.2 GHz'),
            ('Vocabulary file is 256 KB.', 'Vocab (KB)', '256 KB'),
        ]
        for quote, header, cell in cases:
            with self.subTest(header=header, cell=cell):
                res = publish._validate_api_reader_source_bindings(table_fixture(quote, header, cell))
                self.assertEqual(res['tableCount'], 1)

    def test_explicit_cell_units_fail_closed_on_mismatch_missing_or_negation(self):
        cases = [
            ('The checkpoint takes 12 KB on disk.', 'Size (MB)', '12 KB'),
            ('The checkpoint takes 12 on disk.', 'Size (MB)', '12 MB'),
            ('Peak memory reaches 16 GB on a single GPU.', 'VRAM (GiB)', '16 GiB'),
            ('Peak memory is not 16 GiB, it is 32 GiB.', 'VRAM (GiB)', '16 GiB'),
            ('Full training completes in 2.5 min.', 'Duration (h)', '2.5 h'),
            ('Model size is 12 MB.', 'Size (GB)', '12 MB'),
        ]
        for quote, header, cell in cases:
            with self.subTest(header=header, cell=cell, quote=quote):
                with self.assertRaisesRegex(publish.PublishDataValidationError, '列头单位'):
                    publish._validate_api_reader_source_bindings(table_fixture(quote, header, cell))

    def test_zh_si_unit_header_parity_with_node(self):
        # ASCII metric + Chinese SI unit in parentheses matches English SI header in verbatim quote
        valid_paper = table_fixture('Table 2 reports AvLS (ms) = 12.5 for method A.', 'AvLS (毫秒)', '12.5')
        self.assertEqual(publish._validate_api_reader_source_bindings(valid_paper)['tableCount'], 1)

        # Missing matching English unit in quote still fails closed
        bad_paper = table_fixture('Table 2 reports AvLS = 12.5 for method A.', 'AvLS (毫秒)', '12.5')
        with self.assertRaisesRegex(publish.PublishDataValidationError, '列头单位'):
            publish._validate_api_reader_source_bindings(bad_paper)

    def test_blog_formula_tex_display_has_zero_syntax_warnings(self):
        proc = subprocess.run(
            [sys.executable, '-W', 'error::SyntaxWarning', '-m', 'py_compile',
             str(ROOT / 'scripts/blog_formula_tex_display.py'),
             str(ROOT / 'scripts/blog_reader_binding_verifier.py'),
             str(ROOT / 'scripts/utils.py')],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, f'SyntaxWarning detected:\n{proc.stderr}')
        self.assertEqual(formula_display._collapse_parenthesized_signed_double_write('(−1.4)(-1.4)'), '(−1.4)')
        self.assertEqual(formula_display._collapse_parenthesized_signed_double_write('x](−1.4)(-1.4)'), 'x](−1.4)(-1.4)')
        self.assertIsNone(formula_display._rendered_table_bare_tex('| A | \\(\\alpha\\) |'))
        self.assertIsNotNone(formula_display._rendered_table_bare_tex('| A | \\alpha |'))


if __name__ == '__main__':
    unittest.main()

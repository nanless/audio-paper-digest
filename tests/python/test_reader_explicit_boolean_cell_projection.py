import copy
import hashlib
import unittest
from test_publish_to_blog import (
    publish_to_blog as blog, llm_api_publication_fixture,
    reseal_llm_api_reader_fixture,
)


class ExplicitBooleanCellProjectionTest(unittest.TestCase):
    def test_complete_same_symbol_cells_only(self):
        for raw, expected in [(r'✓\checkmark', '✓'), (r'×\times', '×'),
                              (r'| ✓\checkmark | ×\times |', '| ✓ | × |')]:
            self.assertEqual(blog._normalize_api_reader_explicit_symbol_projection(raw), expected)
            self.assertEqual(blog._normalize_api_reader_source_cell(raw), expected)
        for raw in [r'✓\times', r'×\checkmark', r'××\times', r'✓✓', r'\times',
                    r'a×\times', r'×\times b', r'×\times^{2}', r'✓\checkmark _{j}',
                    r'×\times\unknown', r'×\times + 2', r'✓\checkmarker']:
            self.assertEqual(blog._normalize_api_reader_explicit_symbol_projection(raw), raw)

    def test_real_publisher_artifact_binding_rechecks_symbols_and_units(self):
        paper = llm_api_publication_fixture()
        old = blog._api_reader_markdown_tables(paper['apiReaderArticle'])[0]['markdown']
        rendered = '| Method | MP | SI-SDR (dB) ↑ |\n| --- | --- | --- |\n| Baseline | ✓ | 1.44 |\n| Ours | × | 4.6920 |'
        paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(old, rendered)
        rows = [['Method', 'MP', r'SI-SDR (dB) ↑\uparrow'],
                ['Baseline', r'✓\checkmark', '1.44'], ['Ours', r'×\times', '4.6920']]
        visible = [blog._api_reader_markdown_tables(rendered)[0]['header'],
                   *blog._api_reader_markdown_tables(rendered)[0]['rows']]
        binding = paper['apiReaderPlan']['tableBindings'][0]
        binding['renderedTableSha256'] = hashlib.sha256(rendered.encode()).hexdigest()
        binding['cellBindings'] = [dict(renderedRow=r, renderedColumn=c, sourceRow=r,
                                       sourceColumn=c, renderedText=visible[r][c], sourceText=text,
                                       sourceDomSha256=format(11 + r * 3 + c, '064x'))
                                  for r, row in enumerate(rows) for c, text in enumerate(row)]
        reseal_llm_api_reader_fixture(paper)
        self.assertEqual(blog._validate_api_reader_source_bindings(paper)['tableCount'], 1)
        for index, bad_text in [(4, r'×\checkmark'), (7, r'×\times + 2'),
                                (2, r'SI-SDR (ms) ↑\uparrow'), (8, '4.692')]:
            invalid = copy.deepcopy(paper)
            invalid['apiReaderPlan']['tableBindings'][0]['cellBindings'][index]['sourceText'] = bad_text
            reseal_llm_api_reader_fixture(invalid)
            with self.assertRaises(blog.PublishDataValidationError):
                blog._validate_api_reader_source_bindings(invalid)


if __name__ == '__main__':
    unittest.main()

import json
from pathlib import Path
import unittest
from test_publish_to_blog import publish_to_blog as blog


class ExplicitCellProjectionTests(unittest.TestCase):
    def test_shared_exact_projection_and_bindings(self):
        cases = json.loads((Path(__file__).parents[1] / 'fixtures' /
                            'reader-explicit-cell-projection-cases.json').read_text())
        for row in cases:
            with self.subTest(raw=row['raw']):
                self.assertEqual(blog._normalize_api_reader_display_artifacts(row['raw']), row['expected'])
                self.assertEqual(blog._normalize_api_reader_source_cell(row['raw']),
                                 blog._normalize_api_reader_source_cell(row['expected']))
                self.assertEqual(blog._normalize_api_reader_display_artifacts(row['expected']), row['expected'])


if __name__ == '__main__':
    unittest.main()

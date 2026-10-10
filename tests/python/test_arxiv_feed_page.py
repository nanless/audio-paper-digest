import importlib.util
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
spec = importlib.util.spec_from_file_location('arxiv_atom', Path(__file__).resolve().parents[2] / 'scripts' / 'parse-arxiv-atom.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FeedPageTest(unittest.TestCase):
    def feed(self, metadata):
        return f'<feed xmlns="http://www.w3.org/2005/Atom" xmlns:o="http://a9.com/-/spec/opensearch/1.1/">{metadata}</feed>'

    def test_default_array_and_strict_page(self):
        xml = self.feed('<o:totalResults>0</o:totalResults><o:startIndex>0</o:startIndex><o:itemsPerPage>100</o:itemsPerPage>')
        self.assertEqual(module.parse_atom(xml), [])
        self.assertEqual(module.parse_atom(xml, feed_page=True), {'totalResults': 0, 'startIndex': 0, 'itemsPerPage': 100, 'entries': []})

    def test_missing_duplicate_wrong_namespace_and_unsafe_integer(self):
        for metadata in ('', '<o:totalResults>0</o:totalResults><o:totalResults>0</o:totalResults>', '<totalResults>0</totalResults>', '<o:totalResults>9007199254740992</o:totalResults>'):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                module.parse_atom(self.feed(metadata), feed_page=True)

if __name__ == '__main__':
    unittest.main()

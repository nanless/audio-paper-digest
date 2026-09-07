import importlib.util
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
sys.path.insert(0, os.path.join(ROOT, 'tests', 'python'))

from test_publish_to_blog import llm_api_publication_fixture  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    'historical_page_render', os.path.join(ROOT, 'scripts', 'historical-page-render.py'),
)
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


class HistoricalPageRenderTests(unittest.TestCase):
    def test_real_publish_helpers_render_reader_formula_and_sidecars(self):
        paper = llm_api_publication_fixture()
        sealed_summary = paper['parsed']['summary']
        paper['parsed']['summary'] = 'STALE PARSED SUMMARY'
        paper['parsed']['score'] = '0.1'
        assignment = {
            'status': 'assigned',
            'paperId': f'arxiv:{paper["arxivId"]}',
            'primaryTaskId': 'task.spatial-audio',
            'primaryMethodId': 'method.transformer',
            'conceptIds': ['task.spatial-audio', 'method.transformer'],
            'concepts': [
                {'id': 'task.spatial-audio', 'preferredLabel': {'zh': '空间音频'}},
                {'id': 'method.transformer', 'preferredLabel': {'zh': 'Transformer'}},
            ],
        }
        result = renderer.render_packet({
            'paper': paper, 'taxonomy': assignment, 'cohortDate': '2026-09-04',
        })
        self.assertIn('tags: [空间音频, Transformer]', result['markdown'])
        self.assertIn(sealed_summary, result['markdown'])
        self.assertNotIn('STALE PARSED SUMMARY', result['markdown'])
        self.assertIn('评分：**6.1/10**', result['markdown'])
        self.assertNotIn('评分：**0.1/10**', result['markdown'])
        self.assertIn('\\[', result['markdown'])
        paths = {asset['path'] for asset in result['assets']}
        self.assertTrue(any(path.endswith('/citation.json') for path in paths))
        self.assertTrue(any(path.endswith('/rethink-context.json') for path in paths))


if __name__ == '__main__':
    unittest.main()

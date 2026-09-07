import importlib.util
import hashlib
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
sys.path.insert(0, os.path.join(ROOT, 'tests', 'python'))

from test_publish_to_blog import (  # noqa: E402
    llm_api_ephemeral_figure_fixture,
    llm_api_publication_fixture,
)

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

    def test_direct_conference_packet_renders_reader_page_without_inventing_an_arxiv_id(self):
        paper = llm_api_publication_fixture()
        paper.pop('arxivId', None)
        paper['directPaperId'] = 'conference:icassp:2026:icassp-arnumber:100'
        result = renderer.render_packet({
            'directStaging': True, 'paper': paper, 'cohortDate': '2026-09-04',
        })
        self.assertIn('paper_digest_direct_paper_id:', result['markdown'])
        self.assertIn('conference:icassp:2026:icassp-arnumber:100', result['markdown'])
        self.assertIn('## 🧭 深度解读', result['markdown'])
        self.assertNotIn('paper_digest_arxiv_id:', result['markdown'])
        self.assertEqual(result['assets'], [])

    def test_direct_arxiv_renderer_keeps_ephemeral_figure_evidence_without_staging_pixels(self):
        paper = llm_api_ephemeral_figure_fixture()
        figure_url = paper['apiReaderFigures'][0]['url']
        paper['directPaperId'] = f'arxiv:{paper["arxivId"]}'
        # The direct route reparses the sealed canonical surface instead of
        # importing the legacy taxonomy assignment used by the other fixture.
        paper['analysis'] += (
            '\n\n## 标签\n#音乐源分离 #Transformer #鲁棒性\n'
            '主任务标签: #音乐源分离\n主方法标签: #Transformer'
        )
        publisher = renderer.load_publish_to_blog()
        parsed = publisher.parse_analysis(paper['analysis'])
        analysis_sha = hashlib.sha256(paper['analysis'].encode('utf-8')).hexdigest()
        summary_sha = hashlib.sha256(parsed['summary'].encode('utf-8')).hexdigest()
        projection_sha = publisher._core_summary_projection_sha256(paper['analysis'])
        core_stage = paper['analysisManifest']['stages']['coreSummaryRepair']
        core_stage.update({
            'inputAnalysisSha256': analysis_sha,
            'outputAnalysisSha256': analysis_sha,
            'inputSummarySha256': summary_sha,
            'summarySha256': summary_sha,
            'inputStructureProjectionSha256': projection_sha,
            'outputStructureProjectionSha256': projection_sha,
        })
        core_binding = {
            'contractVersion': core_stage['contractVersion'],
            'inputAnalysisSha256': analysis_sha,
            'outputAnalysisSha256': analysis_sha,
            'inputSummarySha256': summary_sha,
            'summarySha256': summary_sha,
            'inputStructureProjectionSha256': projection_sha,
            'outputStructureProjectionSha256': projection_sha,
        }
        core_stage['bindingSha256'] = publisher._stable_json_sha256(core_binding)
        paper['analysisManifest']['stages']['structureRepair']['outputAnalysisSha256'] = analysis_sha
        paper['analysisManifest']['stages']['scoringAudit'].update({
            'outputAnalysisSha256': analysis_sha,
            'coreSummaryInputAnalysisSha256': analysis_sha,
            'inputCoreSummarySha256': summary_sha,
            'outputCoreSummarySha256': summary_sha,
        })
        result = renderer.render_packet({
            'directStaging': True, 'paper': paper, 'cohortDate': '2026-09-07',
        })
        self.assertIn('论文图 1（像素未随页面持久化）', result['markdown'])
        self.assertIn(
            'paper_digest_api_reader_figure_persistence: '
            '"ephemeral-no-persisted-figure-assets-v1"', result['markdown'],
        )
        self.assertNotIn(figure_url, result['markdown'])
        self.assertNotIn('![原论文 Figure 1', result['markdown'])
        self.assertTrue(all(not item['path'].startswith('static/images/papers/')
                            for item in result['assets']))
        self.assertNotRegex(
            str(result), r'(?:cachePath|assetFilename|assetBytes|assetMediaType)',
        )


if __name__ == '__main__':
    unittest.main()

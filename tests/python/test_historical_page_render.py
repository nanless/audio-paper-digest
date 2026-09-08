import importlib.util
import base64
import hashlib
import json
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


def metadata_sidecar(paper, abstract_sha):
    return {
        'contract': renderer.DIRECT_PUBLICATION_METADATA_CONTRACT,
        'paperId': paper['directPaperId'],
        'manifestSha256': 'd' * 64,
        'atomResponseSha256': 'e' * 64,
        'metadataRecordSha256': 'f' * 64,
        'abstractSha256': abstract_sha,
        'entryVersion': 1,
        'entryUpdatedAt': '2026-01-01T00:00:00.000Z',
        'publishedAt': '2025-12-31T00:00:00.000Z',
        'observedAt': '2026-01-03T00:00:00.000Z',
        'sourceId': paper['arxivId'],
        'querySourceId': paper['arxivId'],
        'sourceCapturedAt': '2026-01-02T00:00:00.000Z',
        'sourceEarliestCapturedAt': '2026-01-02T00:00:00.000Z',
        'sourceLatestCapturedAt': '2026-01-02T00:00:00.000Z',
        'sourceName': (
            'https://export.arxiv.org/api/query?'
            f'id_list={paper["arxivId"]}&max_results=1'
        ),
        'sourceManifestSha256': 'c' * 64,
        'sourceSnapshotSha256': 'a' * 64,
        'sourceTextSha256': 'b' * 64,
        'generation': 1,
    }


class HistoricalPageRenderTests(unittest.TestCase):
    def test_real_publish_helpers_render_reader_formula_and_sidecars(self):
        paper = llm_api_publication_fixture()
        sealed_summary = paper['parsed']['summary']
        paper['parsed']['summary'] = 'STALE PARSED SUMMARY'
        paper['parsed']['score'] = '0.1'
        assignment = {
            'status': 'assigned',
            'paperId': f'arxiv:{paper["arxivId"]}',
            'registryVersion': renderer.load_publish_to_blog()._PAGE_TAXONOMY['version'],
            'registrySha256': renderer.load_publish_to_blog()._PAGE_TAXONOMY['registrySha256'],
            'primaryTaskId': 'task.localization',
            'primaryMethodId': 'method.transformer',
            'conceptIds': ['task.localization', 'method.transformer', 'research_focus.robustness'],
            'concepts': [
                {'id': 'task.localization', 'facet': 'task', 'preferredLabel': {'zh': '声源定位'}},
                {'id': 'method.transformer', 'facet': 'method', 'preferredLabel': {'zh': 'Transformer'}},
                {'id': 'research_focus.robustness', 'facet': 'research_focus', 'preferredLabel': {'zh': '鲁棒性'}},
            ],
        }
        result = renderer.render_packet({
            'paper': paper, 'taxonomy': assignment, 'cohortDate': '2026-09-04',
        })
        self.assertIn('tags: [声源定位, Transformer, 鲁棒性]', result['markdown'])
        self.assertIn('paper_digest_primary_method: "Transformer"', result['markdown'])
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
        paper['analysis'] += (
            '\n\n## 标签\n#语音识别 #Transformer #低资源\n'
            '主任务标签: #语音识别\n主方法标签: #Transformer\n补充标签: #低资源'
        )
        result = renderer.render_packet({
            'directStaging': True, 'paper': paper, 'cohortDate': '2026-09-04',
        })
        self.assertIn('paper_digest_direct_paper_id:', result['markdown'])
        self.assertIn('paper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"', result['markdown'])
        self.assertIn('paper_digest_primary_method: "Transformer"', result['markdown'])
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
        abstract = paper.pop('abstract')
        paper['freshRewriteProvenance'] = {
            'sourceSnapshotSha256': 'a' * 64,
            'sourceSha256': 'b' * 64,
            'sourceGeneration': 1,
            'sourceManifestSha256': 'c' * 64,
        }
        publication_source = {
            'contract': renderer.DIRECT_PUBLICATION_SOURCE_CONTRACT,
            'version': 1,
            'paperId': paper['directPaperId'],
            'sourceSnapshotSha256': 'a' * 64,
            'sourceTextSha256': 'b' * 64,
            'abstract': abstract,
            'abstractSha256': hashlib.sha256(abstract.encode('utf-8')).hexdigest(),
        }
        publication_source['metadataSidecar'] = metadata_sidecar(
            paper, publication_source['abstractSha256'],
        )
        result = renderer.render_packet({
            'directStaging': True, 'paper': paper,
            'publicationSource': publication_source,
            'cohortDate': '2026-09-07',
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
        rethink = json.loads(next(
            base64.b64decode(asset['base64'])
            for asset in result['assets']
            if asset['path'].endswith('/rethink-context.json')
        ))
        self.assertEqual(rethink['abstract'], abstract)
        self.assertEqual(rethink['abstractSha256'], publication_source['abstractSha256'])

    def test_direct_arxiv_renderer_rejects_unbound_publication_source(self):
        paper = llm_api_ephemeral_figure_fixture()
        paper['directPaperId'] = f'arxiv:{paper["arxivId"]}'
        abstract = paper.pop('abstract')
        paper['freshRewriteProvenance'] = {
            'sourceSnapshotSha256': 'a' * 64,
            'sourceSha256': 'b' * 64,
            'sourceGeneration': 1,
            'sourceManifestSha256': 'c' * 64,
        }
        proof = {
            'contract': renderer.DIRECT_PUBLICATION_SOURCE_CONTRACT,
            'version': 1,
            'paperId': paper['directPaperId'],
            'sourceSnapshotSha256': 'a' * 64,
            'sourceTextSha256': 'b' * 64,
            'abstract': abstract,
            'abstractSha256': hashlib.sha256(abstract.encode('utf-8')).hexdigest(),
        }
        proof['metadataSidecar'] = metadata_sidecar(
            paper, proof['abstractSha256'],
        )
        for changed in (
                {**proof, 'paperId': 'arxiv:2609.99999'},
                {**proof, 'sourceSnapshotSha256': 'c' * 64},
                {**proof, 'sourceTextSha256': 'c' * 64},
                {**proof, 'abstractSha256': 'c' * 64},
                {**proof, 'unexpected': True}):
            with self.assertRaisesRegex(ValueError, 'publication source proof'):
                renderer.inject_direct_publication_source(dict(paper), changed)
        without_provenance = dict(paper)
        without_provenance.pop('freshRewriteProvenance')
        with self.assertRaisesRegex(ValueError, 'publication source proof'):
            renderer.inject_direct_publication_source(without_provenance, proof)

    def test_direct_arxiv_renderer_validates_metadata_sidecar_binding(self):
        paper = llm_api_ephemeral_figure_fixture()
        paper['directPaperId'] = f'arxiv:{paper["arxivId"]}'
        abstract = paper.pop('abstract')
        paper['freshRewriteProvenance'] = {
            'sourceSnapshotSha256': 'a' * 64,
            'sourceSha256': 'b' * 64,
            'sourceGeneration': 1,
            'sourceManifestSha256': 'c' * 64,
        }
        abstract_sha = hashlib.sha256(abstract.encode('utf-8')).hexdigest()
        sidecar = {
            'contract': renderer.DIRECT_PUBLICATION_METADATA_CONTRACT,
            'paperId': paper['directPaperId'],
            'manifestSha256': 'd' * 64,
            'atomResponseSha256': 'e' * 64,
            'metadataRecordSha256': 'f' * 64,
            'abstractSha256': abstract_sha,
            'entryVersion': 1,
            'entryUpdatedAt': '2026-01-01T00:00:00.000Z',
            'publishedAt': '2025-12-31T00:00:00.000Z',
            'observedAt': '2026-01-03T00:00:00.000Z',
            'sourceId': paper['arxivId'],
            'querySourceId': paper['arxivId'],
            'sourceCapturedAt': '2026-01-02T00:00:00.000Z',
            'sourceEarliestCapturedAt': '2026-01-02T00:00:00.000Z',
            'sourceLatestCapturedAt': '2026-01-02T00:00:00.000Z',
            'sourceName': (
                'https://export.arxiv.org/api/query?'
                f'id_list={paper["arxivId"]}&max_results=1'
            ),
            'sourceManifestSha256': 'c' * 64,
            'sourceSnapshotSha256': 'a' * 64,
            'sourceTextSha256': 'b' * 64,
            'generation': 1,
        }
        proof = {
            'contract': renderer.DIRECT_PUBLICATION_SOURCE_CONTRACT,
            'version': 1,
            'paperId': paper['directPaperId'],
            'sourceSnapshotSha256': 'a' * 64,
            'sourceTextSha256': 'b' * 64,
            'abstract': abstract,
            'abstractSha256': abstract_sha,
            'metadataSidecar': sidecar,
        }
        result = renderer.inject_direct_publication_source(dict(paper), proof)
        self.assertEqual(result['abstract'], abstract)
        for changed in (
                {**sidecar, 'abstractSha256': '0' * 64},
                {**sidecar, 'sourceManifestSha256': '0' * 64},
                {**sidecar, 'generation': 2},
                {**sidecar, 'observedAt': '2025-12-31T12:00:00.000Z',
                 'sourceId': f'{paper["arxivId"]}v1',
                 'querySourceId': f'{paper["arxivId"]}v1',
                 'sourceName': ('https://export.arxiv.org/api/query?'
                                f'id_list={paper["arxivId"]}v1&max_results=1')},
                {**sidecar, 'unexpected': True}):
            with self.assertRaisesRegex(ValueError, 'metadata sidecar proof'):
                renderer.inject_direct_publication_source(
                    dict(paper), {**proof, 'metadataSidecar': changed},
                )

    def test_direct_conference_renderer_rejects_arxiv_publication_source(self):
        paper = {
            'directPaperId': 'conference:icassp:2026:icassp-arnumber:100',
            'id': 'conference:icassp:2026:icassp-arnumber:100',
        }
        with self.assertRaisesRegex(ValueError, 'conference packet'):
            renderer.inject_direct_publication_source(paper, {'contract': 'wrong'})


if __name__ == '__main__':
    unittest.main()

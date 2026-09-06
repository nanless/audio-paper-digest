import hashlib
import importlib.util
import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('conference_page_render', ROOT / 'scripts' / 'conference-page-render.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def stable_sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class ConferencePageRenderTest(unittest.TestCase):
    def packet(self):
        paper_id = 'conference:icassp:2026:icassp-arnumber:100'
        article = '这是只来自会议分析 Reader 的全新解读正文。'
        plan = {'contract': 'beginner-researcher-v3', 'readerTitle': '会议论文解读', 'formulaBindings': []}
        article_sha = hashlib.sha256(article.encode()).hexdigest()
        plan_sha = stable_sha(plan)
        paper = {'id': paper_id, 'conferencePaperId': paper_id, 'paper_id': paper_id, 'title': '会议论文',
                 'parsed': {'summary': '全新 canonical 摘要。', 'score': '8.2', 'scoringReason': '证据完整。'},
                 'apiReaderArticle': article, 'apiReaderArticleSha256': article_sha,
                 'apiReaderPlan': plan, 'apiReaderPlanSha256': plan_sha, 'apiReaderFigures': [],
                 'analysisManifest': {'contracts': {'apiReaderArticle': 'beginner-researcher-v3'},
                                      'stages': {'apiReaderArticle': {'status': 'complete', 'articleSha256': article_sha,
                                                                    'planSha256': plan_sha, 'figureCount': 0,
                                                                    'formulaBindingCount': 0}}}}
        concepts = [{'id': 'task.asr', 'facet': 'task', 'preferredLabel': {'zh': '语音识别', 'en': 'ASR'}},
                    {'id': 'method.transformer', 'facet': 'method', 'preferredLabel': {'zh': 'Transformer', 'en': 'Transformer'}}]
        return {'paper': paper, 'paper_id': paper_id, 'conference': {'id': 'icassp-2026', 'year': 2026},
                'capabilities': dict(MODULE.WEAK), 'date': '2026-09-07', 'aggregateUrl': '/posts/conference-icassp-2026/',
                'taxonomy': {'status': 'assigned', 'paperId': paper_id, 'primaryTaskId': 'task.asr',
                             'primaryMethodId': 'method.transformer', 'conceptIds': ['task.asr', 'method.transformer'],
                             'concepts': concepts}}

    def test_generic_identity_and_unavailable_structure_are_rendered_without_arxiv(self):
        result = MODULE.render_packet(self.packet())
        self.assertIn('paper_digest_paper_id: "conference:icassp:2026:icassp-arnumber:100"', result['markdown'])
        self.assertNotIn('paper_digest_arxiv_id', result['markdown'])
        self.assertNotIn('arxiv.org', result['markdown'].lower())
        self.assertIn('表格、公式与 Figure 均不可用', result['markdown'])
        self.assertEqual(result['assets'], [])

    def test_arxiv_alias_and_structure_injection_fail_closed(self):
        packet = self.packet(); packet['paper']['arxivId'] = '2403.14817'
        with self.assertRaisesRegex(ValueError, 'arXiv alias'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['paper']['apiReaderFigures'] = [{'path': 'fake.png'}]
        with self.assertRaisesRegex(ValueError, 'unavailable structure'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['capabilities']['tables'] = 'available'
        with self.assertRaisesRegex(ValueError, 'source-bound weak'):
            MODULE.render_packet(packet)


if __name__ == '__main__':
    unittest.main()

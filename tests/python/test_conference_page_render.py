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
    def test_pdf_visual_capabilities_render_without_claiming_recovered_tex(self):
        packet = self.packet()
        packet['capabilities'] = dict(MODULE.PDF_VISUAL)
        result = MODULE.render_packet(packet)
        self.assertIn('pdf-visual-quote-evidence-v1', result['markdown'])
        self.assertIn('PDF 文字层不视为原始 TeX', result['markdown'])
        self.assertNotIn('公式文本与 Figure 像素已按 PDF 抽取结果绑定', result['markdown'])

    def test_pdf_visual_capabilities_reject_formula_and_dom_table_bindings(self):
        for field, binding in [('formulaBindings', {'formulaOrdinal': 1}),
                               ('tableBindings', {'sourceType': 'artifact_table', 'sourceTableOrdinal': 1})]:
            packet = self.packet()
            packet['capabilities'] = dict(MODULE.PDF_VISUAL)
            paper = packet['paper']
            plan = paper['apiReaderPlan']
            plan[field] = [binding]
            plan['sourceBindingsSha256'] = stable_sha({
                'tableBindings': plan['tableBindings'], 'formulaBindings': plan['formulaBindings']})
            paper['apiReaderPlanSha256'] = stable_sha(plan)
            stage = paper['analysisManifest']['stages']['apiReaderArticle']
            stage.update(planSha256=stable_sha(plan), sourceBindingsSha256=plan['sourceBindingsSha256'],
                         tableBindingCount=len(plan['tableBindings']), formulaBindingCount=len(plan['formulaBindings']))
            with self.assertRaisesRegex(ValueError, 'structure capability'):
                MODULE.render_packet(packet)

    def packet(self):
        paper_id = 'conference:icassp:2026:icassp-arnumber:100'
        article = '这是只来自会议分析 Reader 的全新解读正文。'
        plan = {'version': 3, 'contract': 'beginner-researcher-v3', 'readerTitle': '会议论文解读',
                'oneSentenceThesis': '一句话说清会议论文的问题、方法和结论。',
                'figurePlacements': [], 'tableBindings': [], 'formulaBindings': [],
                'sourceBindingsContract': 'api-reader-source-bindings-v4'}
        plan['sourceBindingsSha256'] = stable_sha({'tableBindings': [], 'formulaBindings': []})
        article_sha = hashlib.sha256(article.encode()).hexdigest()
        plan_sha = stable_sha(plan)
        authors_identity = {'contract': 'api-reader-author-identity-v1', 'authors': [
            {'name': '作者', 'affiliations': ['测试大学']}], 'sourceTextSha256': '1' * 64}
        authors = {'authors': authors_identity['authors'], 'identity': authors_identity,
                   'identitySha256': stable_sha(authors_identity)}
        resources_identity = {'contract': 'api-reader-resource-identity-v1',
                              'sourceTextSha256': '1' * 64, 'resources': []}
        resources = {**resources_identity, 'identitySha256': stable_sha(resources_identity)}
        analysis = '\n\n'.join(f'## {heading}\n已通过封存证据验证的 canonical 内容。' for heading in MODULE.REQUIRED_ANALYSIS_SECTIONS)
        publication = {'contract': 'conference-official-publication-v1',
                       'recordUrl': 'https://ieeexplore.ieee.org/document/100',
                       'pdfUrl': 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=100'}
        paper = {'id': paper_id, 'conferencePaperId': paper_id, 'paper_id': paper_id, 'title': '会议论文',
                 'analysis': analysis, 'conferencePublication': publication,
                 'parsed': {'summary': '全新 canonical 摘要。', 'score': '8.2',
                            'rankBucket': '前25%', 'documentType': '方法研究', 'scoringReason': '八维证据完整。',
                            'innovationScore': '1.7', 'technicalRigorScore': '1.3',
                            'experimentalSufficiencyScore': '1.2', 'clarityScore': '0.8',
                            'impactScore': '1.2', 'openSourceScore': '0.8',
                            'reproducibilityScore': '0.4', 'engineeringScore': '0.8'},
                 'apiReaderArticle': article, 'apiReaderArticleSha256': article_sha,
                 'apiReaderPlan': plan, 'apiReaderPlanSha256': plan_sha, 'apiReaderFigures': [],
                 'apiReaderAuthors': authors, 'apiReaderResources': resources,
                 'analysisManifest': {'sourceAcquisition': {'analysisSource': 'conference_pdf_text',
                                                           'fullTextAvailable': True,
                                                           'structuredArtifactsSha256': '2' * 64},
                                      'contracts': {'apiReaderArticle': 'beginner-researcher-v3',
                                                    'apiReaderSourceBindings': 'api-reader-source-bindings-v4',
                                                    'apiReaderAuthorIdentity': 'api-reader-author-identity-v1',
                                                    'apiReaderResourceIdentity': 'api-reader-resource-identity-v1',
                                                    'taxonomy': 'paper-taxonomy-selection-v1'},
                                      'stages': {
                                          'taxonomySeal': {'status': 'complete', 'registryVersion': 'paper-taxonomy-v1',
                                                           'registrySha256': 'a' * 64,
                                                           'primaryTaskId': 'task.asr',
                                                           'primaryMethodId': 'method.transformer',
                                                           'conceptIds': ['task.asr', 'method.transformer']},
                                          'scoringAudit': {'status': 'complete', 'scoringContract': 'api-scoring-audit-v2',
                                                           'outputAnalysisSha256': hashlib.sha256(analysis.encode()).hexdigest(),
                                                           'stabilityWarning': False},
                                          'apiReaderArticle': {'status': 'complete', 'articleSha256': article_sha,
                                                               'planSha256': plan_sha, 'figureCount': 0,
                                                               'figuresSha256': stable_sha([]), 'tableBindingCount': 0,
                                                               'formulaBindingCount': 0,
                                                               'sourceBindingsContractVersion': 'api-reader-source-bindings-v4',
                                                               'sourceBindingsSha256': plan['sourceBindingsSha256'],
                                                               'structuredArtifactsSha256': '2' * 64,
                                                               'readerAuthorsSha256': stable_sha(authors),
                                                               'readerAuthorIdentitySha256': authors['identitySha256'],
                                                               'resourceIdentitySha256': resources['identitySha256'],
                                                               'resourceCount': 0}}}}
        concepts = [{'id': 'task.asr', 'facet': 'task', 'preferredLabel': {'zh': '语音识别', 'en': 'ASR'}},
                    {'id': 'method.transformer', 'facet': 'method', 'preferredLabel': {'zh': 'Transformer', 'en': 'Transformer'}}]
        return {'paper': paper, 'paper_id': paper_id, 'conference': {'id': 'icassp-2026', 'year': 2026},
                'capabilities': dict(MODULE.WEAK), 'date': '2026-09-07', 'aggregateUrl': '/posts/conference-icassp-2026/',
                'publication': publication,
                'taxonomy': {'status': 'assigned', 'paperId': paper_id, 'primaryTaskId': 'task.asr',
                             'primaryMethodId': 'method.transformer', 'conceptIds': ['task.asr', 'method.transformer'],
                             'registryVersion': 'paper-taxonomy-v1', 'registrySha256': 'a' * 64,
                             'selectionContract': 'paper-taxonomy-selection-v1',
                             'flatCompatContract': 'paper-taxonomy-flat-tags-compat-v1', 'concepts': concepts}}

    def test_generic_identity_and_unavailable_structure_are_rendered_without_arxiv(self):
        result = MODULE.render_packet(self.packet())
        self.assertIn('paper_digest_paper_id: "conference:icassp:2026:icassp-arnumber:100"', result['markdown'])
        self.assertNotIn('paper_digest_arxiv_id', result['markdown'])
        self.assertNotIn('arxiv.org', result['markdown'].lower())
        self.assertIn('表格、公式与 Figure 均不可用', result['markdown'])
        self.assertIn('paper_digest_taxonomy_contract: "paper-taxonomy-flat-tags-compat-v1"', result['markdown'])
        self.assertIn('paper_digest_api_reader_contract: "beginner-researcher-v3"', result['markdown'])
        self.assertIn('paper_digest_api_reader_source_binding_contract: "api-reader-source-bindings-v4"', result['markdown'])
        self.assertIn('paper_digest_api_reader_decision_projection: "api-reader-decision-projection-v2"', result['markdown'])
        self.assertIn('paper_digest_conference_record_url: "https://ieeexplore.ieee.org/document/100"', result['markdown'])
        self.assertIn('创新 1.7/2', result['markdown'])
        self.assertIn('## 👥 作者与机构', result['markdown'])
        self.assertIn('测试大学', result['markdown'])
        self.assertIn('## 🔗 开源与复现资源', result['markdown'])
        self.assertIn('可达状态仅表示本次链接检查结果', result['markdown'])
        self.assertIn('## ⚖️ 评分明细', result['markdown'])
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

    def test_arxiv_preprint_links_are_hidden_from_conference_projection(self):
        packet = self.packet()
        article = '[扩展版](https://arxiv.org/abs/2403.14817)；https://arxiv.org/pdf/2403.14817.pdf'
        article_sha = hashlib.sha256(article.encode()).hexdigest()
        packet['paper']['apiReaderArticle'] = article
        packet['paper']['apiReaderArticleSha256'] = article_sha
        packet['paper']['analysisManifest']['stages']['apiReaderArticle']['articleSha256'] = article_sha
        resource = {
            'origin': 'paper_source', 'type': 'reproduction',
            'originalUrl': 'https://arxiv.org/abs/2403.14817',
            'finalUrl': 'https://arxiv.org/abs/2403.14817', 'redirects': [], 'status': 200,
            'availability': 'available',
            'sourceQuote': 'Extended version https://arxiv.org/abs/2403.14817',
        }
        resource['sourceQuoteSha256'] = hashlib.sha256(resource['sourceQuote'].encode()).hexdigest()
        identity = {'contract': 'api-reader-resource-identity-v1', 'sourceTextSha256': '1' * 64,
                    'resources': [resource]}
        packet['paper']['apiReaderResources'] = {**identity, 'identitySha256': stable_sha(identity)}
        reader_stage = packet['paper']['analysisManifest']['stages']['apiReaderArticle']
        reader_stage['resourceIdentitySha256'] = stable_sha(identity)
        reader_stage['resourceCount'] = 1
        result = MODULE.render_packet(packet)
        self.assertNotIn('arxiv.org', result['markdown'].lower())
        self.assertIn('预印本链接未在会议页展示', result['markdown'])

    def test_iwslt_dotted_conference_paper_id_is_preserved(self):
        packet = self.packet()
        paper_id = 'conference:iwslt:2026:conference-paper-id:IWSLT.2026.001'
        packet['paper_id'] = paper_id
        packet['paper']['id'] = paper_id
        packet['paper']['conferencePaperId'] = paper_id
        packet['paper']['paper_id'] = paper_id
        packet['conference'] = {'id': 'iwslt-2026', 'year': 2026}
        packet['taxonomy']['paperId'] = paper_id
        publication = {'contract': 'conference-official-publication-v1',
                       'recordUrl': 'https://aclanthology.org/2026.iwslt-1.1',
                       'pdfUrl': 'https://aclanthology.org/2026.iwslt-1.1.pdf'}
        packet['publication'] = publication
        packet['paper']['conferencePublication'] = publication
        result = MODULE.render_packet(packet)
        self.assertIn(f'paper_digest_paper_id: "{paper_id}"', result['markdown'])
        self.assertNotIn('paper_digest_arxiv_id', result['markdown'])

    def test_reader_scoring_taxonomy_and_official_urls_fail_closed(self):
        packet = self.packet(); packet['paper']['apiReaderPlan']['sourceBindingsContract'] = 'api-reader-source-bindings-v3'
        with self.assertRaisesRegex(ValueError, 'source-bindings-v4'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['paper']['analysisManifest']['stages']['scoringAudit']['scoringContract'] = 'legacy'
        with self.assertRaisesRegex(ValueError, 'api-scoring-audit-v2'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['taxonomy']['registrySha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'taxonomy seal'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['publication']['pdfUrl'] = 'https://arxiv.org/pdf/1234.5678.pdf'
        packet['paper']['conferencePublication'] = packet['publication']
        with self.assertRaisesRegex(ValueError, '会议 HTTPS'):
            MODULE.render_packet(packet)

    def test_resolved_scoring_stability_warning_is_accepted(self):
        packet = self.packet()
        packet['paper']['analysisManifest']['stages']['scoringAudit'].update({
            'stabilityWarning': True,
            'stabilityResolution': {
                'contract': 'api-scoring-stability-resolution-v1',
                'status': 'resolved',
                'method': 'second_pass_consensus',
                'firstAuditScore': 8.2,
                'secondAuditScore': 8.1,
                'scoreDifference': 0.1,
                'secondAuditSha256': 'f' * 64,
            },
        })
        self.assertIn('## ⚖️ 评分明细', MODULE.render_packet(packet)['markdown'])

    def test_bare_repository_source_token_binding_is_replayable_and_strict(self):
        token = 'github.com/ZhanqiZhang66/align'
        quote_text = f'Our code is publicly available at {token}.'
        resource = {
            'origin': 'paper_source',
            'originalUrl': 'https://github.com/ZhanqiZhang66/align',
            'sourceQuote': quote_text,
            'sourceQuoteSha256': hashlib.sha256(quote_text.encode()).hexdigest(),
            'sourceUrlBindingContract': 'paper-source-repository-url-normalization-v1',
            'sourceUrlToken': token,
            'sourceUrlTokenSha256': hashlib.sha256(token.encode()).hexdigest(),
        }
        self.assertTrue(MODULE.paper_source_resource_binding(resource))
        for unsafe in ('https://user:pass@github.com/owner/repo',
                       'github.com:8443/owner/repo', 'github.com/owner/repo?token=secret',
                       'github.com/owner/%2e%2e/private'):
            self.assertIsNone(MODULE.normalized_repository_source_token(unsafe))
        resource['sourceUrlTokenSha256'] = '0' * 64
        self.assertFalse(MODULE.paper_source_resource_binding(resource))

    def test_pdf_line_broken_repository_binding_matches_normalization_contract(self):
        safe = (
            ('https://\ngithub.com/owner/repo', 'https://github.com/owner/repo'),
            ('https:\n//github.com/owner/repo', 'https://github.com/owner/repo'),
            ('github.com/owner/\n  repo', 'https://github.com/owner/repo'),
            ('huggingface.co\r\n/owner/model', 'https://huggingface.co/owner/model'),
        )
        for token, original in safe:
            with self.subTest(token=token):
                quote_text = f'Data and code are available at {token}.'
                resource = {
                    'origin': 'paper_source',
                    'originalUrl': original,
                    'sourceQuote': quote_text,
                    'sourceQuoteSha256': hashlib.sha256(quote_text.encode()).hexdigest(),
                    'sourceUrlBindingContract': 'paper-source-repository-url-normalization-v1',
                    'sourceUrlToken': token,
                    'sourceUrlTokenSha256': hashlib.sha256(token.encode()).hexdigest(),
                }
                self.assertEqual(MODULE.normalized_repository_source_token(token), original)
                self.assertTrue(MODULE.paper_source_resource_binding(resource))

        unsafe = (
            'github.com/owner/\n\nrepo',
            'github.com/owner/re\npo',
            'github.com/owner/\trepo',
            'https://user:pass@github.com/owner/repo',
            'github.com:8443/owner/repo',
            'github.com/owner/repo?token=secret',
            'github.com/owner/repo#fragment',
            '127.0.0.1/owner/repo',
            'localhost/owner/repo',
            'github.com/owner/../private',
            'github.com/owner/%2e%2e/private',
        )
        for token in unsafe:
            with self.subTest(token=token):
                self.assertIsNone(MODULE.normalized_repository_source_token(token))

    def test_resource_original_and_final_urls_are_both_public_https(self):
        packet = self.packet()
        quote_text = 'The code is available at http://127.0.0.1/private.'
        resource = {
            'origin': 'paper_source',
            'type': 'code',
            'originalUrl': 'http://127.0.0.1/private',
            'finalUrl': 'https://github.com/example/repository',
            'redirects': [],
            'status': 200,
            'availability': 'available',
            'sourceQuote': quote_text,
            'sourceQuoteSha256': hashlib.sha256(quote_text.encode()).hexdigest(),
        }
        identity = {
            'contract': 'api-reader-resource-identity-v1',
            'sourceTextSha256': '1' * 64,
            'resources': [resource],
        }
        packet['paper']['apiReaderResources'] = {
            **identity,
            'identitySha256': stable_sha(identity),
        }
        reader_stage = packet['paper']['analysisManifest']['stages']['apiReaderArticle']
        reader_stage['resourceIdentitySha256'] = stable_sha(identity)
        reader_stage['resourceCount'] = 1
        with self.assertRaisesRegex(ValueError, 'original URL'):
            MODULE.render_packet(packet)


if __name__ == '__main__':
    unittest.main()

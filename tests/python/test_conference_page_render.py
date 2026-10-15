import copy
import hashlib
import importlib.util
import json
import re
import pathlib
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('conference_page_render', ROOT / 'scripts' / 'conference-page-render.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

# 从仓库根按点分路径单跑（python -m unittest tests.python.<模块>）时，tests/python
# 不在 sys.path 上；补一条引导，让三种运行方式都能导入这个平级 helper。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment  # noqa: E402

# 本模块的用例会走真实入口，入口经 log_setup 读 .env 并写 os.environ。
setUpModule, tearDownModule = isolate_module_environment()


def stable_sha(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class ConferencePageRenderTest(unittest.TestCase):
    def test_current_source_resource_view_preserves_old_identity_and_rejects_release_claims(self):
        packet = self.packet()
        paper = packet['paper']
        source = '1Project page: https://example.com/project/'
        source_sha = hashlib.sha256(source.encode()).hexdigest()
        paper.update(source='conference', sourceSha256=source_sha)
        packet['sourceText'] = source
        paper['analysisManifest']['sourceAcquisition']['sourceSha256'] = source_sha
        paper['apiReaderAuthors']['identity']['sourceTextSha256'] = source_sha
        paper['apiReaderAuthors']['identitySha256'] = stable_sha(paper['apiReaderAuthors']['identity'])
        resource = {'type': 'dataset', 'origin': 'paper_source', 'sourceQuote': source,
                    'sourceQuoteSha256': hashlib.sha256(source.encode()).hexdigest(),
                    'originalUrl': 'https://example.com/project/', 'finalUrl': 'https://example.com/project/',
                    'redirects': [], 'status': 200, 'availability': 'available', 'retryable': False}
        identity = {'contract': 'api-reader-resource-identity-v1', 'sourceTextSha256': source_sha, 'resources': [resource]}
        paper['apiReaderResources'] = {**identity, 'identitySha256': stable_sha(identity)}
        paper['apiReaderPlan'].update(sections=[{'kind': 'reproduction', 'heading': '复现条件'}], conceptBridges=[])
        paper['apiReaderPlanSha256'] = stable_sha(paper['apiReaderPlan'])
        paper['apiReaderArticle'] = '### 复现条件\n\n项目页链接可访问，但数据和模型开放状态尚未确认。'
        paper['apiReaderArticleSha256'] = hashlib.sha256(paper['apiReaderArticle'].encode()).hexdigest()
        stage = paper['analysisManifest']['stages']['apiReaderArticle']
        stage.update(resourceIdentitySha256=stable_sha(identity), resourceCount=1,
                     resourceIdentityContractVersion='api-reader-resource-identity-v1',
                     planSha256=paper['apiReaderPlanSha256'], articleSha256=paper['apiReaderArticleSha256'])
        stage.update(readerAuthorIdentitySha256=paper['apiReaderAuthors']['identitySha256'],
                     readerAuthorsSha256=stable_sha(paper['apiReaderAuthors']))
        original = copy.deepcopy(packet)
        rendered = MODULE.render_packet(packet)
        self.assertIn('- 论文所列链接：', rendered['markdown'])
        self.assertNotIn('- 数据相关资源：', rendered['markdown'])
        self.assertEqual(packet, original)
        for mutation in ('source', 'claim', 'unknown', 'current'):
            bad = copy.deepcopy(packet)
            if mutation == 'source':
                bad['sourceText'] += 'wrong'
            elif mutation == 'claim':
                bad_paper = bad['paper']
                bad_paper['apiReaderArticle'] = '### 复现条件\n\n本文数据集已经公开，可以直接下载。'
                digest = hashlib.sha256(bad_paper['apiReaderArticle'].encode()).hexdigest()
                bad_paper['apiReaderArticleSha256'] = digest
                bad_paper['analysisManifest']['stages']['apiReaderArticle']['articleSha256'] = digest
            else:
                bad['paper']['analysisManifest']['contracts']['readerResourceClaims'] = (
                    'unknown' if mutation == 'unknown' else 'reader-resource-availability-claims-v1')
                if mutation == 'current':
                    bad['paper']['analysisManifest']['stages']['apiReaderArticle']['readerResourceClaimsContractVersion'] = \
                        'reader-resource-availability-claims-v1'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                MODULE.render_packet(bad)

    def test_batched_tag_presentation_has_only_selected_paths_and_no_page_eligibility(self):
        catalog = MODULE.load_tag_catalog()
        by_id = {item['id']: item for item in catalog['concepts']}
        leaf = next(item for item in catalog['concepts'] if item['broaderId'] is not None)
        record = {'registryVersion': catalog['version'], 'registrySha256': catalog['registrySha256'],
                  'concepts': [{'id': leaf['id'], 'facet': leaf['facet'],
                                'label': leaf['preferredLabel']['zh']}]}
        packet = {'tagPresentationBatch': {'catalog': catalog, 'records': [record, copy.deepcopy(record)]}}
        original = copy.deepcopy(packet)
        result = MODULE.render_packet(packet)
        self.assertEqual(set(result), {'tagPresentations', 'facetDisplayLabels'})
        self.assertEqual(result['facetDisplayLabels'], MODULE.FACET_DISPLAY_LABELS)
        self.assertEqual(result['facetDisplayLabels']['method'], '研究方法')
        self.assertEqual(len(result['tagPresentations']), 2)
        self.assertEqual(result['tagPresentations'][0], result['tagPresentations'][1])
        text = result['tagPresentations'][0]
        self.assertIn(f'/papers/?concept={leaf["id"]}', text)
        self.assertIn(f'/papers/?concept={leaf["broaderId"]}', text)
        unrelated = next(item for item in catalog['concepts']
                         if item['id'] not in (leaf['id'], leaf['broaderId'])
                         and item['broaderId'] is None and item['facet'] != leaf['facet'])
        self.assertNotIn(f'/papers/?concept={unrelated["id"]}', text)
        self.assertEqual(packet, original)
        for mutation in ('unknown', 'sha', 'mixed'):
            bad = copy.deepcopy(packet)
            if mutation == 'unknown':
                bad['tagPresentationBatch']['records'][0]['concepts'][0]['id'] = 'task.unknown'
            elif mutation == 'sha':
                bad['tagPresentationBatch']['records'][0]['registrySha256'] = 'f' * 64
            else:
                bad['paper'] = self.packet()['paper']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                MODULE.render_packet(bad)

    def test_conference_workbench_exports_real_identity_without_inventing_arxiv_or_abstract(self):
        publisher = MODULE.load_publish_to_blog()
        paper = self.packet()['paper']
        parsed = {**paper['parsed'], 'primaryTaskTag': '#语音识别', 'primaryMethodTag': '#Transformer'}
        paper.pop('conferencePublication')
        original = copy.deepcopy(paper)
        bundle = publisher.build_verified_conference_workbench_bundle(
            paper, '2026-09-07', paper_id=paper['id'], reader_plan=paper['apiReaderPlan'],
            parsed=parsed, authors=paper['apiReaderAuthors']['authors'])
        exports = {path.name: raw for path, raw in bundle['sidecars'].items()}
        citation = json.loads(exports['citation.json'])
        context = json.loads(exports['rethink-context.json'])
        self.assertEqual(citation['paperId'], paper['id'])
        self.assertEqual(citation['sourceSha256'], paper['sourceSha256'])
        self.assertEqual(citation['publicUrlAvailability'], 'unavailable')
        self.assertIsNone(citation['recordUrl'])
        self.assertIsNone(citation['pdfUrl'])
        self.assertIsNone(context['abstract'])
        self.assertIsNone(context['abstractSha256'])
        self.assertEqual(context['abstractStatus'], 'unavailable')
        self.assertNotIn('arxivId', citation)
        self.assertNotIn('archivePrefix', exports['citation.bib'].decode())
        self.assertTrue(exports['citation.bib'].startswith(b'@inproceedings'))
        self.assertTrue(exports['citation.ris'].startswith(b'TY  - CONF\n'))
        self.assertNotIn('paper_digest_arxiv', publisher._researcher_workbench_frontmatter(bundle))
        self.assertEqual(paper, original)

    def test_conference_workbench_rejects_identity_author_and_source_substitution(self):
        publisher = MODULE.load_publish_to_blog()
        for mutation, error in [
                (lambda p, options: options.update(paper_id='conference:icassp:2026:icassp-arnumber:999'), '身份'),
                (lambda p, options: options.update(authors=[{'name': '替换', 'affiliations': ['测试大学']}]), '作者来源'),
                (lambda p, options: p.update(sourceSha256='f' * 64), '全文 SHA'),
                (lambda p, options: options.update(publication={**p['conferencePublication'], 'recordUrl': 'https://example.com/another'}), '公开来源')]:
            paper = self.packet()['paper']
            options = {'paper_id': paper['id'], 'publication': paper['conferencePublication'],
                       'reader_plan': paper['apiReaderPlan'],
                       'parsed': {**paper['parsed'], 'primaryTaskTag': '#语音识别', 'primaryMethodTag': '#Transformer'},
                       'authors': paper['apiReaderAuthors']['authors']}
            mutation(paper, options)
            with self.assertRaisesRegex(publisher.PublishDataValidationError, error):
                publisher.build_verified_conference_workbench_bundle(paper, '2026-09-07', **options)

    def test_shared_resource_projection_deduplicates_only_verified_full_objects(self):
        packet = self.packet()
        resource = {
            'origin': 'paper_source', 'type': 'code',
            'originalUrl': 'https://github.com/example/research',
            'finalUrl': 'https://github.com/example/research',
            'redirects': [], 'status': 200, 'availability': 'available',
            'sourceQuote': 'Code https://github.com/example/research',
        }
        resource['sourceQuoteSha256'] = hashlib.sha256(resource['sourceQuote'].encode()).hexdigest()
        records = [resource, copy.deepcopy(resource)]
        identity = {'contract': 'api-reader-resource-identity-v1',
                    'sourceTextSha256': '1' * 64, 'resources': records}
        paper = packet['paper']
        paper['apiReaderResources'] = {**identity, 'identitySha256': stable_sha(identity)}
        stage = paper['analysisManifest']['stages']['apiReaderArticle']
        stage.update(resourceIdentitySha256=stable_sha(identity), resourceCount=2)
        original = copy.deepcopy(packet)
        page = MODULE.render_packet(packet)['markdown']
        self.assertEqual(page.count('- 代码相关资源：'), 1)
        self.assertEqual(packet, original)
        # A source change keeps the same URL but is a different verified object.
        records[1]['sourceQuote'] = 'Implementation https://github.com/example/research'
        records[1]['sourceQuoteSha256'] = hashlib.sha256(records[1]['sourceQuote'].encode()).hexdigest()
        paper['apiReaderResources']['identitySha256'] = stable_sha(identity)
        stage['resourceIdentitySha256'] = stable_sha(identity)
        self.assertEqual(MODULE.render_packet(packet)['markdown'].count('- 代码相关资源：'), 2)

    def test_shared_projection_does_not_accept_replacement_author_evidence(self):
        from paper_reader_presentation import build_reader_presentation
        paper = self.packet()['paper']
        with self.assertRaisesRegex(ValueError, '原作者记录'):
            build_reader_presentation(paper, plan=paper['apiReaderPlan'],
                                      resources=paper['apiReaderResources']['resources'],
                                      authors=[{'name': '替换作者', 'affiliations': ['测试大学']}])

    def test_stable_sha_accepts_lone_surrogate(self):
        value = {'text': '\udc53'}
        expected = hashlib.sha256(
            json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            .encode('utf-8', 'backslashreplace')
        ).hexdigest()
        self.assertEqual(MODULE.stable_sha(value), expected)

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

    def test_current_tag_stage_links_to_assignment_without_rewriting_legacy_packet(self):
        legacy = self.packet()
        original = copy.deepcopy(legacy)
        old_result = MODULE.render_packet(legacy)
        current = copy.deepcopy(legacy)
        manifest = current['paper']['analysisManifest']
        manifest['contracts'].pop('taxonomy')
        manifest['contracts']['tagSelectionRecord'] = 'paper-tag-stage-record-v2'
        stage = manifest['stages'].pop('taxonomySeal')
        stage['selectionContract'] = current['taxonomy']['selectionContract']
        manifest['stages']['tagSelection'] = stage
        self.assertEqual(MODULE.render_packet(current), old_result)
        self.assertEqual(legacy, original)
        for contract in (None, 'unknown'):
            bad = copy.deepcopy(current)
            bad['paper']['analysisManifest']['contracts']['tagSelectionRecord'] = contract
            with self.assertRaisesRegex(ValueError, '格式版本无效'):
                MODULE.render_packet(bad)
        bad = copy.deepcopy(current)
        bad['paper']['analysisManifest']['stages']['taxonomySeal'] = stage
        with self.assertRaisesRegex(ValueError, '不能混用新旧格式'):
            MODULE.render_packet(bad)
        bad = copy.deepcopy(current)
        bad['paper']['analysisManifest']['stages']['tagSelection']['primaryTaskId'] = 'task.tts'
        with self.assertRaisesRegex(ValueError, '标签选择记录与分析阶段记录'):
            MODULE.render_packet(bad)

    def test_new_assignment_accepts_known_legacy_stage_without_changing_inputs(self):
        packet = self.packet()
        packet['paper']['analysisManifest']['stages']['taxonomySeal'][
            'selectionContract'] = MODULE.LEGACY_TAG_SELECTION_CONTRACT
        packet['taxonomy']['selectionContract'] = MODULE.TAG_SELECTION_CONTRACT
        original = copy.deepcopy(packet)
        self.assertIn('markdown', MODULE.render_packet(packet))
        self.assertEqual(packet, original)
        for change in (
                lambda p: p['taxonomy'].__setitem__('selectionContract', 'unknown'),
                lambda p: p['paper']['analysisManifest']['contracts'].__setitem__('taxonomy', 'unknown'),
                lambda p: p['paper']['analysisManifest']['stages']['taxonomySeal'].__setitem__(
                    'selectionContract', MODULE.TAG_SELECTION_CONTRACT)):
            bad = copy.deepcopy(packet)
            change(bad)
            with self.assertRaisesRegex(ValueError, '标签选择记录与分析阶段记录'):
                MODULE.render_packet(bad)

    def test_flat_tag_protocol_reads_legacy_assignment_and_only_writes_current_page(self):
        for contract in (MODULE.LEGACY_TAG_FLAT_COMPAT_CONTRACT, MODULE.FLAT_TAG_CONTRACT):
            packet = self.packet()
            packet['taxonomy']['flatCompatContract'] = contract
            original = copy.deepcopy(packet)
            page = MODULE.render_packet(packet)['markdown']
            self.assertIn('paper_digest_tags_contract: "paper-tag-flat-tags-v2"', page)
            self.assertIn('**研究分类**', page)
            self.assertIn('/papers/?concept=task.asr', page)
            self.assertNotRegex(page, r'(?m)^标签：')
            self.assertEqual(len(json.loads(re.search(
                r'^paper_digest_tags_concepts: (.+)$', page, re.MULTILINE).group(1))), 2)
            self.assertEqual(packet, original)
        for contract in (None, '', 'unknown'):
            packet = self.packet()
            packet['taxonomy']['flatCompatContract'] = contract
            with self.assertRaisesRegex(ValueError, '标签选择记录与分析阶段记录'):
                MODULE.render_packet(packet)

    def test_append_only_catalog_reads_real_old_stage_without_rewriting_proof(self):
        from tag_catalog import load_tag_catalog, tag_prompt_text_sha256, TAG_PROMPT_TEXT_CONTRACT
        old_sha = '0a0847314ab2059d95efac33376414498e598a1f02a1486869bee0efc481d1f7'
        original_catalog = load_tag_catalog(ROOT / 'config/tag-catalog-history' / f'{old_sha}.json')
        current = MODULE.load_tag_catalog()
        self.assertNotEqual(original_catalog['registrySha256'], current['registrySha256'])
        packet = self.packet()
        paper, assignment = packet['paper'], packet['taxonomy']
        paper['analysis'] = paper['analysis'].replace(
            '## 标签\n已根据封存资料核验的分析内容。',
            '## 标签\n#语音识别 #Transformer #鲁棒性\n主任务标签: #语音识别\n主方法标签: #Transformer')
        paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = \
            hashlib.sha256(paper['analysis'].encode()).hexdigest()
        assignment['conceptIds'].append('research_focus.robustness')
        assignment['concepts'].append({'id': 'research_focus.robustness', 'facet': 'research_focus',
                                       'preferredLabel': {'zh': '鲁棒性', 'en': 'Robustness'}})
        stage = paper['analysisManifest']['stages']['taxonomySeal']
        stage.update(registrySha256=old_sha, registryVersion=original_catalog['version'],
                     conceptIds=list(assignment['conceptIds']), projectionContract=TAG_PROMPT_TEXT_CONTRACT,
                     projectionSha256=tag_prompt_text_sha256(original_catalog, TAG_PROMPT_TEXT_CONTRACT))
        saved = copy.deepcopy(packet)
        result = MODULE.render_packet(packet)
        self.assertIn(f'paper_digest_tags_registry_sha256: "{current["registrySha256"]}"', result['markdown'])
        self.assertEqual(packet, saved)
        for mutation in ('projection', 'source', 'selection'):
            bad = copy.deepcopy(packet)
            old_stage = bad['paper']['analysisManifest']['stages']['taxonomySeal']
            if mutation == 'projection':
                old_stage['projectionSha256'] = 'f' * 64
            elif mutation == 'source':
                old_stage['registrySha256'] = 'f' * 64
            else:
                old_stage['primaryTaskId'] = 'task.av-asr'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                MODULE.render_packet(bad)

    def test_archived_conference_stage_replays_original_chain_before_current_assignment(self):
        import test_publish_common as saved_stage_fixture
        old_sha = 'a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d'
        original_catalog = MODULE.load_archived_tag_catalog(old_sha)
        packet = self.packet()
        paper, assignment = packet['paper'], packet['taxonomy']
        paper['analysis'] = paper['analysis'].replace(
            '## 标签\n已根据封存资料核验的分析内容。',
            '## 标签\n#语音识别 #Transformer #低资源\n主任务标签：#语音识别\n主方法标签：#Transformer')
        paper['analysis'] = paper['analysis'].replace(
            '## 机器摘要\n已根据封存资料核验的分析内容。',
            '## 机器摘要\nprimary_task_tag: #语音识别\nprimary_method_tag: #Transformer')
        with mock.patch.object(saved_stage_fixture, '_PUBLISH_TAG_CATALOG', original_catalog):
            stage = saved_stage_fixture.attach_tag_stage_record(
                paper, paper['analysisManifest'], status='complete', with_checkpoints=True,
                prompt_text_contract=saved_stage_fixture.LEGACY_TAG_PROMPT_TEXT_CONTRACT,
                selection_contract=MODULE.LEGACY_TAG_SELECTION_CONTRACT)
        # Replays the same pre-existing 15c -> a3 historical chain as the saved conference batch.
        stage['registryUpgradeFrom'] = {
            'contract': 'paper-taxonomy-registry-upgrade-v1', 'version': 1,
            'fromRegistrySha256': '15c82a567ce5a55dc1175684ed08b64c158558639d9c8fb822c9587ec32a8778',
            'fromRegistryVersion': 'paper-taxonomy-v1', 'toRegistrySha256': old_sha,
            'toRegistryVersion': 'paper-taxonomy-v1', 'changeLevel': 'destructive',
            'reasons': ['alias-added', 'alias-removed', 'broader-id-changed', 'concept-added',
                        'definition-updated', 'preferred-label-changed', 'scope-note-updated'],
            'note': '保留原所选概念的旧词表升级记录。',
            'destructiveAcknowledgement': {'acknowledged': True, 'conceptIdImpact': 'none',
                'reasonsHash': 'c4c83e78d845159fc005a3ead0d627fa65ce86fb50d84183bd1768944e9a4914',
                'note': '核验原升级确认，所选概念 ID 不变。'}}
        paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = hashlib.sha256(paper['analysis'].encode()).hexdigest()
        assignment['conceptIds'] = list(stage['conceptIds'])
        current = MODULE.load_tag_catalog()
        by_id = {concept['id']: concept for concept in current['concepts']}
        assignment['concepts'] = [copy.deepcopy(by_id[cid]) for cid in assignment['conceptIds']]
        original = copy.deepcopy(packet)
        result = MODULE.render_packet(packet)
        self.assertIn(f'paper_digest_tags_registry_sha256: "{current["registrySha256"]}"', result['markdown'])
        self.assertEqual(packet, original)
        self.assertIsNone(MODULE.resolve_append_only_proof_catalog(old_sha, current))
        for mutation in ('projection', 'checkpoint', 'binding', 'chain', 'selection', 'archive', 'catalog'):
            bad = copy.deepcopy(packet)
            old_stage = bad['paper']['analysisManifest']['stages']['taxonomySeal']
            if mutation == 'projection':
                old_stage['projectionSha256'] = 'f' * 64
            elif mutation == 'checkpoint':
                bad['paper']['analysisStageCheckpoints']['taxonomySeal'] += '\n篡改'
            elif mutation == 'binding':
                old_stage['bindingSha256'] = 'f' * 64
            elif mutation == 'chain':
                old_stage['registryUpgradeFrom']['destructiveAcknowledgement']['reasonsHash'] = 'f' * 64
            elif mutation == 'selection':
                bad['taxonomy']['primaryTaskId'] = 'task.av-asr'
            elif mutation == 'archive':
                old_stage['registrySha256'] = 'f' * 64
            else:
                bad['tagCatalog'] = copy.deepcopy(current)
                bad['tagCatalog']['registrySha256'] = 'f' * 64
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                MODULE.render_packet(bad)

    def test_tag_metadata_packet_matches_legacy_and_rejects_both_fields(self):
        legacy = self.packet()
        original = copy.deepcopy(legacy)
        expected = MODULE.render_packet(legacy)
        current = copy.deepcopy(legacy)
        current['tagMetadata'] = current.pop('taxonomy')
        current_original = copy.deepcopy(current)
        self.assertEqual(MODULE.render_packet(current), expected)
        self.assertEqual(legacy, original)
        self.assertEqual(current, current_original)
        for value in (None, current['tagMetadata']):
            mixed = copy.deepcopy(current)
            mixed['taxonomy'] = value
            with self.assertRaisesRegex(ValueError, '不能同时包含 tagMetadata 和旧字段 taxonomy'):
                MODULE.render_packet(mixed)
        with self.assertRaisesRegex(ValueError, '不能同时包含 tagMetadata 和旧字段 taxonomy'):
            MODULE.render_packet({'tagMetadata': None, 'taxonomy': None})
        current['tagMetadata'] = None
        with self.assertRaisesRegex(ValueError, '标签记录必须为对象'):
            MODULE.render_packet(current)

    def packet(self):
        catalog = MODULE.load_tag_catalog()
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
        analysis = '\n\n'.join(f'## {heading}\n已根据封存资料核验的分析内容。' for heading in MODULE.REQUIRED_ANALYSIS_SECTIONS)
        publication = {'contract': 'conference-official-publication-v1',
                       'recordUrl': 'https://ieeexplore.ieee.org/document/100',
                       'pdfUrl': 'https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=100'}
        paper = {'id': paper_id, 'conferencePaperId': paper_id, 'paper_id': paper_id, 'title': '会议论文',
                 'analysis': analysis, 'sourceSha256': '1' * 64, 'conferencePublication': publication,
                 'parsed': {'summary': '本次分析生成的摘要。', 'score': '8.2',
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
                                          'taxonomySeal': {'status': 'complete', 'registryVersion': catalog['version'],
                                                           'registrySha256': catalog['registrySha256'],
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
                             'registryVersion': catalog['version'], 'registrySha256': catalog['registrySha256'],
                             'selectionContract': 'paper-taxonomy-selection-v1',
                             'flatCompatContract': 'paper-taxonomy-flat-tags-compat-v1', 'concepts': concepts}}

    def test_evaluation_heading_compatibility_keeps_old_analysis_and_hash(self):
        packet = self.packet()
        paper = packet['paper']
        paper['analysis'] = paper['analysis'].replace('## 论文评价\n', '## 毒舌点评\n')
        stage = paper['analysisManifest']['stages']['scoringAudit']
        stage['outputAnalysisSha256'] = hashlib.sha256(paper['analysis'].encode()).hexdigest()
        old_text = paper['analysis']
        old_sha = stage['outputAnalysisSha256']
        old_page = MODULE.render_packet(packet)['markdown']
        self.assertEqual(paper['analysis'], old_text)
        self.assertEqual(stage['outputAnalysisSha256'], old_sha)
        paper['analysis'] = old_text.replace('## 毒舌点评\n', '## 论文评价\n')
        with self.assertRaisesRegex(ValueError, 'api-scoring-audit-v2'):
            MODULE.render_packet(packet)
        stage['outputAnalysisSha256'] = hashlib.sha256(paper['analysis'].encode()).hexdigest()
        self.assertEqual(MODULE.render_packet(packet)['markdown'], old_page)

    def test_evaluation_duplicate_and_fenced_missing_section_are_rejected(self):
        for suffix in ('## 论文评价\n', '## 毒舌点评\n'):
            packet = self.packet()
            paper = packet['paper']
            paper['analysis'] += '\n\n' + suffix
            paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = (
                hashlib.sha256(paper['analysis'].encode()).hexdigest())
            with self.assertRaisesRegex(ValueError, '论文评价章节重复'):
                MODULE.render_packet(packet)
        packet = self.packet()
        paper = packet['paper']
        paper['analysis'] = paper['analysis'].replace('## 论文评价\n', '```md\n## 论文评价\n```\n')
        paper['analysisManifest']['stages']['scoringAudit']['outputAnalysisSha256'] = (
            hashlib.sha256(paper['analysis'].encode()).hexdigest())
        with self.assertRaisesRegex(ValueError, 'api-scoring-audit-v2'):
            MODULE.render_packet(packet)

    def test_generic_identity_and_unavailable_structure_are_rendered_without_arxiv(self):
        result = MODULE.render_packet(self.packet())
        self.assertIn('paper_digest_paper_id: "conference:icassp:2026:icassp-arnumber:100"', result['markdown'])
        self.assertNotIn('paper_digest_arxiv_id', result['markdown'])
        self.assertNotIn('arxiv.org', result['markdown'].lower())
        self.assertIn('表格、公式和论文图片均不可用', result['markdown'])
        self.assertIn('paper_digest_tags_contract: "paper-tag-flat-tags-v2"', result['markdown'])
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
        self.assertEqual(len(result['assets']), 4)
        self.assertTrue(all(asset['path'].startswith('static/data/papers/') for asset in result['assets']))

    def test_short_proceedings_profile_is_visible_without_abstract_downgrade(self):
        packet = self.packet()
        packet['capabilities'] = dict(MODULE.FULL)
        packet['paper']['analysisManifest']['sourceAcquisition'].update({
            'analysisConfidence': 'short_proceedings',
        })
        result = MODULE.render_packet(packet)
        self.assertIn('会议论文集中的短篇 PDF', result['markdown'])
        self.assertIn('完整 PDF 文本，未降级为摘要', result['markdown'])

    def test_escaped_formula_brackets_in_image_alt_are_not_published_as_math(self):
        markdown = r'![原论文图：s = \[1, 0, ...\]](https://example.org/figure.png)'
        repaired = MODULE.repair_formula_delimiters(markdown)
        self.assertEqual(repaired, markdown)

    def test_literal_brackets_in_image_alt_remain_markdown_safe(self):
        markdown = '![原论文图：输入 f[k]，引用 [5]](https://example.org/figure.png)'
        repaired = MODULE.repair_formula_delimiters(markdown)
        self.assertIn(r'f\[k\]', repaired)
        self.assertIn(r'\[5\]', repaired)

    def test_nested_inline_control_token_is_repaired_before_page_sealing(self):
        markdown = '目标命令是 `turn off `<EOT>``。'
        repaired = MODULE.repair_formula_delimiters(markdown)
        self.assertEqual(repaired, '目标命令是 `turn off &lt;EOT&gt;`。')
        self.assertEqual(MODULE.repair_formula_delimiters(repaired), repaired)

    def test_literal_stars_in_generated_figure_caption_are_verbalized(self):
        markdown = '*论文图 4。原文：“* stands for p < 0.05 and *** for p < 0.001.”。*'
        repaired = MODULE.repair_reader_figure_caption_emphasis(markdown)
        self.assertEqual(
            repaired,
            '*论文图 4。原文：“一个星号 stands for p < 0.05 and 三个星号 for p < 0.001.”。*',
        )

    def test_arxiv_alias_and_structure_injection_fail_closed(self):
        packet = self.packet(); packet['paper']['arxivId'] = '2403.14817'
        with self.assertRaisesRegex(ValueError, 'arXiv alias'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['paper']['apiReaderFigures'] = [{'path': 'fake.png'}]
        with self.assertRaisesRegex(ValueError, 'unavailable structure'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['capabilities']['tables'] = 'available'
        with self.assertRaisesRegex(ValueError, '会议论文的标签记录或来源能力记录无效，标签记录不属于当前论文，或来源能力不在允许范围内。'):
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

    def test_reader_scoring_tag_selection_and_official_urls_fail_closed(self):
        packet = self.packet(); packet['paper']['apiReaderPlan']['sourceBindingsContract'] = 'api-reader-source-bindings-v3'
        with self.assertRaisesRegex(ValueError, 'source-bindings-v4'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['paper']['analysisManifest']['stages']['scoringAudit']['scoringContract'] = 'legacy'
        with self.assertRaisesRegex(ValueError, 'api-scoring-audit-v2'):
            MODULE.render_packet(packet)
        packet = self.packet(); packet['taxonomy']['registrySha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, '会议论文的标签选择记录与分析阶段记录的协议、词表或所选标签不一致，或标签阶段尚未完成。'):
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
        with self.assertRaisesRegex(ValueError, '资源的原始网址'):
            MODULE.render_packet(packet)


if __name__ == '__main__':
    unittest.main()

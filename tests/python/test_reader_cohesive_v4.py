import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import protocol_codec as codec
import reader_record_format as formats
from test_publish_to_blog import (
    publish_to_blog as pub,
    llm_api_publication_fixture,
    reseal_llm_api_reader_fixture,
)


def build_cohesive_v4_publication_paper():
    paper = copy.deepcopy(llm_api_publication_fixture())
    plan = paper['apiReaderPlan']
    plan.pop('version', None)
    v4_plan_header = codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.V4_PLAN_FP)
    plan.update(v4_plan_header)

    # 6 节模块化骨架（含跨 kind 顺序 training -> component，以及单收束节 limitation，0 个术语桥）
    sections = [
        ('problem', '问题本质：短窗流式分离为何会在混响下丢失双耳相位线索'),
        ('method_overview', '方法全景：单个立体声帧块如何经双分支编码还原目标乐器'),
        ('training', '优化机理：多分辨率频谱损失如何稳定掩码收敛'),
        ('component', '核心机制：频变空间增强算子如何抑制旁瓣串扰'),
        ('result', '主实验验证：统一评测口径下的分离增益与延迟代价'),
        ('limitation', '适用边界与复现要点：听损泛化前提、未覆盖场景与配置核对'),
    ]
    plan['sections'] = [{'kind': k, 'heading': h} for k, h in sections]
    plan['conceptBridges'] = []

    fig_url = 'https://arxiv.org/html/2609.00001v1/fig1.png'
    fig_sha = 'c' * 64
    lead_quote = '图前导引自然交代立体声短窗输入与双路编码汇合点的信号流向，帮助读者对准核心模块连接关系。'
    explanation_quote = '结合图中从输入短窗缓冲到频变掩码融合节点的实线路径，主干分支保留双耳时间差，辅助分支抑制非目标方向散射能量。'
    plan['figurePlacements'] = [{
        'figureOrdinal': 1,
        'targetKind': 'method_overview',
        'marker': '[[FIGURE_1]]',
        'leadQuote': lead_quote,
        'explanationQuote': explanation_quote,
        'focusPoints': [],
    }]
    paper['apiReaderFigures'] = [{
        'ordinal': 1,
        'label': 'Figure 1:',
        'caption': 'Figure 1: Overview of the binaural streaming architecture.',
        'url': fig_url,
        'mediaType': 'image/png',
        'sourceDomSha256': 'd' * 64,
        'targetKind': 'method_overview',
        'targetHeading': sections[1][1],
        'assetSha256': fig_sha,
        'marker': '[[FIGURE_1]]',
        'leadQuote': lead_quote,
        'explanationQuote': explanation_quote,
        'focusPoints': [],
    }]
    paper['analysisManifest']['contracts']['apiReaderFigurePersistence'] = pub.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT

    rendered_table = (
        '| 方法 | WER |\n'
        '| --- | ---: |\n'
        '| Baseline | 10.2 |\n'
        '| Ours | 8.4 |'
    )
    latex = r'\mathcal{L}=\lVert y-\hat{y}\rVert_1'
    rendered_formula = f'\\[{latex}\\]'

    body_blocks = []
    for kind, heading in sections:
        body_blocks.append(f'### {heading}')
        body_blocks.append('这是围绕本篇论文证据展开的连贯自然段，完整交代输入信号、中间变换、比较口径与成立条件。')
        if kind == 'method_overview':
            body_blocks.append('图前导引自然交代立体声短窗输入与双路编码汇合点的信号流向，帮助读者对准核心模块连接关系。')
            body_blocks.append(f'![论文图 1：双耳流式分离结构概览]({fig_url})')
            body_blocks.append('*论文图 1：Overview of the binaural streaming architecture（原论文 Figure 1）。*')
            body_blocks.append('结合图中从输入短窗缓冲到频变掩码融合节点的实线路径，主干分支保留双耳时间差，辅助分支抑制非目标方向散射能量。')
            body_blocks.append(rendered_formula)
        if kind == 'result':
            body_blocks.append(rendered_table)
    paper['apiReaderArticle'] = '\n\n'.join(body_blocks)

    source = codec.record_header(codec.contract('api-reader-source-bindings'), 'api-reader-source-bindings')
    plan['sourceBindingsContract'] = source['contract']
    plan['sourceBindingsSchemaFingerprint'] = source['schemaFingerprint']
    source_payload_obj = json.loads(plan['structuredSourcePayload'])
    source_payload_obj['figures'] = [{
        'ordinal': 1,
        'label': 'Figure 1:',
        'caption': 'Figure 1: Overview of the binaural streaming architecture.',
        'sourceDomSha256': 'd' * 64,
        'recoveryStatus': 'complete',
        'images': [{
            'kind': 'external_url',
            'url': fig_url,
            'mediaType': 'image/png',
            'rasterDownloadEligible': True,
        }],
    }]
    source_payload = json.dumps(source_payload_obj, ensure_ascii=False, separators=(',', ':'))
    plan['structuredSourcePayload'] = source_payload
    payload_sha = hashlib.sha256(source_payload.encode()).hexdigest()
    paper['analysisManifest']['sourceAcquisition']['structuredArtifactsSha256'] = payload_sha

    contracts = paper['analysisManifest']['contracts']
    contracts.update(apiReaderArticle=plan['contract'], apiReaderSourceBindings=source['contract'])
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    for key in formats.LEGACY['flatStageFields']:
        stage.pop(key, None)
    pipeline_headers = {
        role: codec.record_header(codec.contract(family), family)
        for role, family in formats.LEGACY['pipelineRoles'].items()
    }
    pipeline_headers['article'] = v4_plan_header
    stage['readerProtocols'] = codec.record('reader-pipeline', pipeline_headers)
    stage['qualityMetrics'] = {**stage['readerProtocols']['qualityMetrics'], 'blockingIssueCount': 0}
    stage['structuredArtifactsSha256'] = payload_sha
    stage['figureCount'] = 1
    stage['figuresSha256'] = pub._reader_record_sha256(paper['apiReaderFigures'], 'API reader 图片记录')

    authors = paper['apiReaderAuthors']
    authors['identity'].pop('contract', None)
    authors['identity'].update(codec.record_header(codec.contract('api-reader-author-identity'), 'api-reader-author-identity'))
    authors['identitySha256'] = pub._stable_json_sha256(authors['identity'])
    resources = paper['apiReaderResources']
    resources.pop('contract', None)
    resources.update(codec.record_header(codec.contract('api-reader-resource-identity'), 'api-reader-resource-identity'))
    resources.pop('identitySha256', None)
    resources['identitySha256'] = pub._stable_json_sha256(resources)
    contracts.update(apiReaderAuthorIdentity=authors['identity']['contract'], apiReaderResourceIdentity=resources['contract'])
    for key in formats.IDENTITY_FIELDS.values():
        stage.pop(key, None)
    stage['readerIdentityProtocols'] = formats.identity_group(authors, resources)
    stage.update(
        readerAuthorsSha256=pub._stable_json_sha256(authors),
        readerAuthorIdentitySha256=authors['identitySha256'],
        resourceIdentitySha256=resources['identitySha256'],
    )
    scan = paper['analysisManifest']['stages']['openSourceScan']
    scan.pop('resourceEvidenceContract', None)
    scan.update(resourceEvidenceProtocol=formats.identity_header(resources, 'resources'), resourceEvidenceSha256=resources['identitySha256'])
    return reseal_llm_api_reader_fixture(paper)


class ReaderCohesiveV4PythonTests(unittest.TestCase):
    def test_reader_record_format_multi_fingerprint_contracts_and_layouts(self):
        current_plan = codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher')
        v4_plan = codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.V4_PLAN_FP)
        old_plan = codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.OLD_PLAN_FP)
        v3_plan = {'version': 3, 'contract': 'beginner-researcher-v3'}
        v2_plan = {'version': 2, 'contract': 'beginner-researcher-v2'}

        # Trap 3: 无 selector 字符串及带 schemaFingerprint 的 dict 均不抛 ValueError
        for raw in ('beginner-researcher', 'beginner-researcher-v3', current_plan, v4_plan, old_plan):
            self.assertTrue(formats.is_integrated_contract(raw))
            self.assertTrue(formats.is_structured_contract(raw))
            self.assertTrue(formats.is_known_contract(raw))
        self.assertFalse(formats.is_integrated_contract('beginner-researcher-v2'))
        self.assertTrue(formats.is_structured_contract('beginner-researcher-v2'))
        self.assertTrue(formats.is_known_contract('beginner-researcher-v1'))
        self.assertFalse(formats.is_known_contract('unregistered-contract'))
        self.assertFalse(formats.is_integrated_contract({'contract': 'beginner-researcher', 'schemaFingerprint': 'f' * 64}))

        v5_layout = formats.publication_layout(current_plan)
        self.assertEqual(v5_layout['minimumSections'], 5)
        self.assertEqual(v5_layout['maximumSections'], 9)
        self.assertEqual(v5_layout['minimumBridges'], 0)
        self.assertEqual(v5_layout['maximumBridges'], 4)
        self.assertFalse(v5_layout['requiresFocusBlockquote'])
        self.assertEqual(v5_layout['editorialProfile'], formats.STRUCTURED_V5)

        v4_layout = formats.publication_layout(v4_plan)
        self.assertEqual(v4_layout['minimumSections'], 5)
        self.assertEqual(v4_layout['maximumSections'], 9)
        self.assertEqual(v4_layout['minimumBridges'], 0)
        self.assertEqual(v4_layout['maximumBridges'], 4)
        self.assertFalse(v4_layout['requiresFocusBlockquote'])
        self.assertEqual(v4_layout['editorialProfile'], formats.COHESIVE_V4)

        for legacy in (old_plan, v3_plan):
            legacy_layout = formats.publication_layout(legacy)
            self.assertEqual(legacy_layout['minimumSections'], 8)
            self.assertEqual(legacy_layout['maximumSections'], 18)
            self.assertEqual(legacy_layout['minimumBridges'], 4)
            self.assertEqual(legacy_layout['maximumBridges'], 10)
            self.assertTrue(legacy_layout['requiresFocusBlockquote'])
            self.assertEqual(legacy_layout['editorialProfile'], formats.LEGACY_INTEGRATED)
        self.assertFalse(formats.publication_layout(v2_plan)['integrated'])

    def test_cohesive_v4_payload_accepts_6_sections_0_bridges_4_block_figure_and_rejects_invalid_mutations(self):
        paper = build_cohesive_v4_publication_paper()
        payload = pub._api_reader_payload_uncached(paper)
        self.assertEqual(len(payload['plan']['sections']), 6)
        self.assertEqual(payload['plan']['conceptBridges'], [])
        self.assertNotIn('看图路径', payload['article'])

        # 缺失所有收束节（既无 limitation 也无 synthesis）必须拒绝
        no_closing = copy.deepcopy(paper)
        no_closing['apiReaderPlan']['sections'][-1]['kind'] = 'ablation'
        reseal_llm_api_reader_fixture(no_closing)
        with self.assertRaisesRegex(pub.PublishDataValidationError, '必需的小节类型'):
            pub._api_reader_payload_uncached(no_closing)

        # 缺失图注必须拒绝
        no_caption = copy.deepcopy(paper)
        no_caption['apiReaderArticle'] = no_caption['apiReaderArticle'].replace(
            '\n\n*论文图 1：Overview of the binaural streaming architecture（原论文 Figure 1）。*', ''
        )
        reseal_llm_api_reader_fixture(no_caption)
        with self.assertRaisesRegex(pub.PublishDataValidationError, '紧凑四块顺序'):
            pub._api_reader_payload_uncached(no_caption)

    def test_image_review_regions_and_figure_removal_support_4_block_v4_and_5_block_legacy(self):
        url = 'https://arxiv.org/html/2609.00001v1/fig1.png'
        v4_md = '\n\n'.join([
            '### 方法全景：双分支流式分离架构',
            '无关前导段落。',
            '图前导引段交代输入输出连接关系与信号流向。',
            f'![论文图 1]({url})',
            '*论文图 1：Overview of the model（原论文 Figure 1）。*',
            '图后实质解释段结合实线箭头说明两条分支的协同方式。',
            '无关后续段落。',
        ])
        img_token = f'![论文图 1]({url})'
        v4_regions = pub._review_image_context_regions(
            v4_md, [{'start': v4_md.index(img_token), 'end': v4_md.index(img_token) + len(img_token), 'raw': img_token}]
        )
        self.assertEqual(len(v4_regions), 1)
        self.assertTrue(v4_regions[0]['readerFigureCluster'])
        v4_slice = v4_md[v4_regions[0]['start']:v4_regions[0]['end']]
        self.assertIn('图前导引段', v4_slice)
        self.assertIn('图后实质解释段', v4_slice)
        self.assertNotIn('无关前导段落', v4_slice)
        self.assertNotIn('无关后续段落', v4_slice)

        v4_removed = pub._remove_api_reader_figure_block(v4_md, url)
        self.assertNotIn(url, v4_removed)
        self.assertNotIn('论文图 1', v4_removed)
        self.assertIn('图前导引段', v4_removed)
        self.assertIn('图后实质解释段', v4_removed)

        legacy_md = v4_md.replace(
            img_token,
            f'> **看图路径：** 1. 先看主干；2. 再看分支。\n\n{img_token}',
        )
        legacy_regions = pub._review_image_context_regions(
            legacy_md, [{'start': legacy_md.index(img_token), 'end': legacy_md.index(img_token) + len(img_token), 'raw': img_token}]
        )
        self.assertTrue(legacy_regions[0]['readerFigureCluster'])
        legacy_removed = pub._remove_api_reader_figure_block(legacy_md, url)
        self.assertNotIn('看图路径', legacy_removed)
        self.assertNotIn(url, legacy_removed)

    def test_workbench_frontmatter_exports_reader_sections_and_keeps_historical_pages_compatible(self):
        v4_paper = build_cohesive_v4_publication_paper()
        v4_payload = pub._api_reader_payload(v4_paper)
        v4_bundle = pub.build_researcher_workbench_bundle(
            v4_paper, '2026-11-20', reader_plan=v4_payload['plan'],
            api_reader_payload=v4_payload, require_reader=True,
        )
        self.assertEqual(len(v4_bundle['readerSections']), 6)
        self.assertEqual(v4_bundle['readerSections'][0], {
            'index': 1,
            'kind': 'problem',
            'roleLabel': '问题与瓶颈',
            'heading': '问题本质：短窗流式分离为何会在混响下丢失双耳相位线索',
        })
        fm_text = pub._researcher_workbench_frontmatter(v4_bundle)
        self.assertIn('paper_digest_reader_sections: ', fm_text)

        parsed_fm, _ = pub._parse_frontmatter_content(
            'paper.md',
            f'---\ndescription: {json.dumps(v4_bundle["oneSentenceThesis"], ensure_ascii=False)}\n{fm_text}---\n\n正文\n',
        )
        parsed_fm['paper_digest_arxiv_id'] = v4_bundle['identity']['baseId']
        self.assertTrue(pub._validate_researcher_workbench_frontmatter(parsed_fm, v4_paper, '2026-11-20'))

        # v4 页面若缺失或篡改 paper_digest_reader_sections 均须被拒绝
        missing_sections_fm = copy.deepcopy(parsed_fm)
        missing_sections_fm.pop('paper_digest_reader_sections', None)
        with self.assertRaisesRegex(pub.PublishDataValidationError, 'paper_digest_reader_sections'):
            pub._validate_researcher_workbench_frontmatter(missing_sections_fm, v4_paper, '2026-11-20')

        tampered_fm = copy.deepcopy(parsed_fm)
        tampered_fm['paper_digest_reader_sections'][0]['roleLabel'] = '被篡改标签'
        with self.assertRaisesRegex(pub.PublishDataValidationError, 'paper_digest_reader_sections'):
            pub._validate_researcher_workbench_frontmatter(tampered_fm, v4_paper, '2026-11-20')

        # 历史已发布页面不含 paper_digest_reader_sections 时保持 100% 兼容通过
        legacy_paper = llm_api_publication_fixture()
        legacy_payload = pub._api_reader_payload(legacy_paper)
        legacy_bundle = pub.build_researcher_workbench_bundle(
            legacy_paper, '2026-11-19', reader_plan=legacy_payload['plan'],
            api_reader_payload=legacy_payload, require_reader=True,
        )
        legacy_fm_text = pub._researcher_workbench_frontmatter(legacy_bundle)
        legacy_parsed_fm, _ = pub._parse_frontmatter_content(
            'paper.md',
            f'---\ndescription: {json.dumps(legacy_bundle["oneSentenceThesis"], ensure_ascii=False)}\n{legacy_fm_text}---\n\n正文\n',
        )
        legacy_parsed_fm['paper_digest_arxiv_id'] = legacy_bundle['identity']['baseId']
        legacy_parsed_fm.pop('paper_digest_reader_sections', None)
        self.assertTrue(pub._validate_researcher_workbench_frontmatter(legacy_parsed_fm, legacy_paper, '2026-11-19'))


if __name__ == '__main__':
    unittest.main()

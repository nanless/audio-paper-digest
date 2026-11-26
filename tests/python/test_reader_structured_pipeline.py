import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'tests' / 'python'))

import protocol_codec as codec
import publish_common as pc
import reader_record_format as formats
from blog_entry_loader import load_publish_to_blog
from test_reader_cohesive_editorial import build_cohesive_v4_publication_paper
from test_publish_to_blog import reseal_llm_api_reader_fixture

pub = load_publish_to_blog()


def reseal_v5(paper):
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    stage['figuresSha256'] = pub._reader_record_sha256(paper['apiReaderFigures'], 'API reader 图片记录')
    return reseal_llm_api_reader_fixture(paper)


def build_structured_v5_publication_paper():
    paper = build_cohesive_v4_publication_paper()
    # Replace plan header with current structured-pipeline-v5 header
    plan = paper['apiReaderPlan']
    plan.update(codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher'))
    plan['figurePlacements'][0]['chineseCaption'] = '双耳流式架构主干与低延迟编码路径示意'
    paper['apiReaderFigures'][0]['chineseCaption'] = '双耳流式架构主干与低延迟编码路径示意'
    paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(
        '*论文图 1：Overview of the binaural streaming architecture（原论文 Figure 1）。*',
        '*论文图 1：双耳流式架构主干与低延迟编码路径示意（原论文 Figure 1）。*',
    )
    plan['implementationSpecs'] = {
        'trainingData': '使用公开语音测试子集，样本量 185 条，采样率 16 kHz。',
        'computeHardware': '原文未披露具体训练 GPU 型号与训练耗时。',
        'keyHyperparams': '采用 <BOS> 起始符与 20 ms 帧移配置。',
        'inferenceCost': '原文未披露端到端实时率 RTF 与显存占用。',
        'openSourceArtifacts': '代码仓库链接可访问，README 覆盖安装与推理说明。',
        'appendixHighlights': '原文未披露额外附录实验。',
    }
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    stage['readerProtocols']['article'] = codec.record_header(
        codec.contract('beginner-researcher'), 'beginner-researcher'
    )
    return reseal_v5(paper)


class ReaderStructuredV5PythonTests(unittest.TestCase):
    def test_manual_editorial_prose_paragraphs_handles_lists_and_fences_like_node(self):
        text = (
            '引语段落。\n'
            '- ' + '第一条较长的要点说明，说明采样率与帧移边界。' * 3 + '\n'
            '- ' + '第二条较长的要点说明，说明双路融合与相位保留。' * 3 + '\n'
            '- ' + '第三条较长的要点说明，说明缓存步长与延迟约束。' * 3 + '\n\n'
            '```python\n'
            'x = "ignored code fence line"\n'
            '```\n\n'
            '$$\n'
            'y = W x + b\n'
            '$$\n\n'
            '收尾段落。'
        )
        paragraphs = pc._manual_editorial_prose_paragraphs(text)
        self.assertEqual(len(paragraphs), 5)
        self.assertEqual(paragraphs[0], '引语段落。')
        self.assertEqual(paragraphs[-1], '收尾段落。')
        self.assertTrue(all('ignored code fence' not in p and 'W x + b' not in p for p in paragraphs))

    def test_v5_payload_validates_chinese_caption_and_implementation_specs_and_renders_page(self):
        paper = build_structured_v5_publication_paper()
        payload = pub._api_reader_payload_uncached(paper)
        self.assertEqual(formats.plan_editorial_profile(payload['plan']), formats.STRUCTURED_EDITORIAL)
        self.assertEqual(payload['plan']['figurePlacements'][0]['chineseCaption'], '双耳流式架构主干与低延迟编码路径示意')
        self.assertIn('trainingData', payload['plan']['implementationSpecs'])

        md, _slug = pub.generate_paper_page(paper, '2026-11-23')
        self.assertIn('## ⚙️ 关键实现与复现规格', md)
        self.assertIn('- **训练与评测数据**：使用公开语音测试子集', md)
        # HTML-like <BOS> token in implementationSpecs must be escaped cleanly as inline code
        self.assertIn('`<BOS>`', md)
        self.assertIsNone(pub._api_reader_page_binding_issue(md, paper))

        # Tampering the implementation specs block must be caught by _api_reader_page_binding_issue
        tampered_md = md.replace('原文未披露额外附录实验。', '已篡改的附录说明。')
        self.assertIsNotNone(pub._api_reader_page_binding_issue(tampered_md, paper))

        # Mismatched chineseCaption between placement and figure record must be rejected
        bad_caption = copy.deepcopy(paper)
        bad_caption['apiReaderFigures'][0]['chineseCaption'] = '与位置计划不一致的另一条中文图注内容'
        reseal_v5(bad_caption)
        with self.assertRaisesRegex(pub.PublishDataValidationError, '图片内容字段与计划不一致'):
            pub._api_reader_payload_uncached(bad_caption)

        # implementationSpecs on historical v4 plan must be rejected
        v4_paper = build_cohesive_v4_publication_paper()
        v4_header = codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.V4_PLAN_FP)
        v4_paper['apiReaderPlan'].update(v4_header)
        v4_paper['analysisManifest']['stages']['apiReaderArticle']['readerProtocols']['article'] = v4_header
        v4_paper['apiReaderPlan']['implementationSpecs'] = copy.deepcopy(paper['apiReaderPlan']['implementationSpecs'])
        reseal_llm_api_reader_fixture(v4_paper)
        with self.assertRaisesRegex(pub.PublishDataValidationError, '非 structured-pipeline'):
            pub._api_reader_payload_uncached(v4_paper)

        # Archived structured-pipeline-v5 header remains 100% valid with implementationSpecs and chineseCaption
        v5_archived = copy.deepcopy(paper)
        v5_archived_header = codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.V5_PLAN_FP)
        v5_archived['apiReaderPlan'].update(v5_archived_header)
        v5_archived['analysisManifest']['stages']['apiReaderArticle']['readerProtocols']['article'] = v5_archived_header
        reseal_v5(v5_archived)
        archived_payload = pub._api_reader_payload_uncached(v5_archived)
        self.assertEqual(formats.plan_editorial_profile(archived_payload['plan']), formats.STRUCTURED_V5_EDITORIAL)
        self.assertTrue(formats.is_structured_editorial(formats.plan_editorial_profile(archived_payload['plan'])))

    def test_partial_readme_documentation_surfaces_only_on_structured_v5_pages(self):
        v5_paper = build_structured_v5_publication_paper()
        v4_paper = build_cohesive_v4_publication_paper()
        v4_header = codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.V4_PLAN_FP)
        v4_paper['apiReaderPlan'].update(v4_header)

        resources = [{
            'type': 'code',
            'origin': 'paper_source',
            'originalUrl': 'https://github.com/example/audio-codec',
            'finalUrl': 'https://github.com/example/audio-codec',
            'availability': 'available',
            'status': 200,
            'redirects': [],
            'sourceQuote': 'Code at https://github.com/example/audio-codec',
            'sourceQuoteSha256': 'a' * 64,
            'documentationEvidence': {
                'contract': 'repository-documentation-evidence-v1',
                'repositoryUrl': 'https://github.com/example/audio-codec',
                'sourceUrl': 'https://raw.githubusercontent.com/example/audio-codec/main/README.md',
                'status': 200,
                'sourceSha256': 'b' * 64,
                'capabilities': {'installation': True, 'inference': True, 'fineTuning': False},
                'completeness': 'partial',
            },
        }]
        v5_rendered = pub.render_verified_reader_resources(resources, paper=v5_paper)
        v4_rendered = pub.render_verified_reader_resources(resources, paper=v4_paper)
        self.assertIn('README 已验证包含安装、推理文档（未见微调文档）', v5_rendered)
        self.assertNotIn('README 已验证包含安装、推理与微调文档', v5_rendered)
        self.assertNotIn('README 已验证包含', v4_rendered)

        # Non-dict capabilities must not crash render_verified_reader_resources (L2)
        malformed_res = copy.deepcopy(resources)
        malformed_res[0]['documentationEvidence']['capabilities'] = ['installation']
        safe_rendered = pub.render_verified_reader_resources(malformed_res, paper=v5_paper)
        self.assertNotIn('README 已验证包含', safe_rendered)

    def test_v5_security_html_injection_caption_smuggling_and_specs_resource_claims(self):
        paper = build_structured_v5_publication_paper()

        # C3: Reject newlines, indented Markdown headings/tables, raw HTML/XSS, and workflow leaks in implementationSpecs
        for bad_val in (
            '正常文本\n  ## 伪造标题\n内容',
            '正常文本\n  | A | B |\n  |---|---|\n  | 1 | 2 |',
            '配置含 <img/src=x/onerror=alert(1)> 载荷',
            '配置含 <details><summary>hijack</summary></details> 标签',
            '本次核验返回 200 且状态为可用，可写作者演示资源当前可用',
        ):
            mut = copy.deepcopy(paper)
            mut['apiReaderPlan']['implementationSpecs']['openSourceArtifacts'] = bad_val
            reseal_v5(mut)
            with self.assertRaisesRegex(pub.PublishDataValidationError, 'implementationSpecs'):
                pub._api_reader_payload_uncached(mut)

        # Direct sanitizer defense-in-depth check
        self.assertEqual(pub._sanitize_implementation_spec_text('使用 <BOS> 与 <EOS>'), '使用 `<BOS>` 与 `<EOS>`')
        sanitized_xss = pub._sanitize_implementation_spec_text('bad <img/src=x/onerror=alert(1)> <details>')
        self.assertNotIn('<img', sanitized_xss)
        self.assertNotIn('<details', sanitized_xss)
        self.assertIn('&lt;img', sanitized_xss)

        # M1: Reject chineseCaption: None smuggling in apiReaderFigures
        smuggled = copy.deepcopy(paper)
        smuggled['apiReaderPlan']['figurePlacements'][0].pop('chineseCaption', None)
        smuggled['apiReaderFigures'][0]['chineseCaption'] = None
        reseal_v5(smuggled)
        with self.assertRaisesRegex(pub.PublishDataValidationError, 'chineseCaption'):
            pub._api_reader_payload_uncached(smuggled)

        # C2: Reject newline or Figure-N prefix in chineseCaption
        for bad_cap in ('双耳流式架构\n含非法换行图注', 'Figure 1 双耳流式架构主干示意'):
            mut = copy.deepcopy(paper)
            mut['apiReaderPlan']['figurePlacements'][0]['chineseCaption'] = bad_cap
            mut['apiReaderFigures'][0]['chineseCaption'] = bad_cap
            reseal_v5(mut)
            with self.assertRaisesRegex(pub.PublishDataValidationError, '图片位置计划'):
                pub._api_reader_payload_uncached(mut)

        # C3: Reject unverified positive resource availability claims inside implementationSpecs on published page
        md, _ = pub.generate_paper_page(paper, '2026-11-23')
        self.assertIsNone(pub._api_reader_page_binding_issue(md, paper))
        unavail_paper = copy.deepcopy(paper)
        # Fixture has available code resource, but NO available model/dataset resource:
        unavail_paper['apiReaderPlan']['implementationSpecs']['openSourceArtifacts'] = '代码链接可访问；模型权重已公开可直接下载。'
        reseal_v5(unavail_paper)
        unavail_md, _ = pub.generate_paper_page(unavail_paper, '2026-11-23')
        issue = pub._api_reader_page_binding_issue(unavail_md, unavail_paper)
        self.assertIsNotNone(issue)
        self.assertIn('关键实现与复现规格', issue)

        # R2-H1: Honest negative wording in openSourceArtifacts AND public benchmark dataset in trainingData must PASS
        honest_paper = copy.deepcopy(paper)
        honest_paper['apiReaderPlan']['implementationSpecs']['trainingData'] = '在已公开的 LibriSpeech 数据集（960 小时）上进行训练与评测。'
        honest_paper['apiReaderPlan']['implementationSpecs']['openSourceArtifacts'] = '论文仓库代码尚未开源，原文未提供可以访问的模型权重下载链接；数据集并非作者公开产物。'
        reseal_v5(honest_paper)
        honest_md, _ = pub.generate_paper_page(honest_paper, '2026-11-23')
        self.assertIsNone(pub._api_reader_page_binding_issue(honest_md, honest_paper))

        # R2-M1 & R3-M1: Double-backtick and backslash-escaped-backtick parser-differential XSS rejected & escaped
        for diff_xss in (
            '``a`b`` <img/src=x/onerror=alert(1)> `',
            r'foo \`<img src=x onerror=alert(1)>`',
        ):
            self.assertTrue(pub._has_forbidden_spec_html_or_markdown(diff_xss))
            sanitized_diff = pub._sanitize_implementation_spec_text(diff_xss)
            self.assertNotIn('<img', sanitized_diff)
            self.assertIn('&lt;img', sanitized_diff)

        # R2-H2: chineseCaption star normalization (* -> 一个星号, *** -> 三个星号, outer quotes, trailing full-width period)
        self.assertEqual(
            pub._format_expected_chinese_caption('在测试集上显著优于基线（p < 0.05*，***代表 p < 0.001）．'),
            '在测试集上显著优于基线（p < 0.05一个星号，三个星号代表 p < 0.001）',
        )
        self.assertEqual(
            pub._format_expected_chinese_caption('“测试显著性 $p^*$ 与 p < 0.05* 对比”'),
            '测试显著性 $p^*$ 与 p < 0.05一个星号 对比',
        )


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Wave 12 Track 12.4 tests: optional audioSignalSpecs, audio demo probe badges, and Daily Roundup 2.0."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / 'scripts'
TESTS_PY_DIR = REPO_ROOT / 'tests' / 'python'
for p in (SCRIPTS_DIR, TESTS_PY_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import protocol_codec as codec  # noqa: E402
import publish_common  # noqa: E402
import reader_record_format as reader_formats  # noqa: E402
from test_reader_structured_v5 import (  # noqa: E402
    build_structured_v5_publication_paper,
    pub as publish_to_blog,
    reseal_v5,
)


class Wave12Track124SpecCardAndRoundupTest(unittest.TestCase):
    def setUp(self):
        policy_directory = tempfile.TemporaryDirectory()
        self.addCleanup(policy_directory.cleanup)
        policy_patch = mock.patch.object(
            publish_to_blog,
            'TAG_DISPLAY_POLICY_PATH',
            Path(policy_directory.name) / 'absent-policy.json',
        )
        policy_patch.start()
        self.addCleanup(policy_patch.stop)

    def test_optional_audio_signal_specs_contract_validation_and_page_binding(self):
        self.assertEqual(
            reader_formats.OPTIONAL_IMPLEMENTATION_SPEC_KEYS,
            ('audioSignalSpecs',),
        )
        self.assertEqual(len(reader_formats.IMPLEMENTATION_SPEC_KEYS), 6)

        # 1. Existing 6-key v5 paper WITHOUT audioSignalSpecs stays 100% valid
        paper_without = build_structured_v5_publication_paper()
        payload_without = publish_to_blog._api_reader_payload_uncached(paper_without)
        self.assertEqual(reader_formats.plan_editorial_profile(payload_without['plan']), reader_formats.STRUCTURED_V5)
        md_without, _ = publish_to_blog.generate_paper_page(paper_without, '2026-11-24')
        self.assertNotIn('音频信号与流式规格', md_without)
        self.assertIn('- **训练与评测数据**：', md_without)
        self.assertIsNone(publish_to_blog._api_reader_page_binding_issue(md_without, paper_without))

        # 2. v5 paper WITH optional audioSignalSpecs validates, renders audioSignalSpecs FIRST, and binds cleanly
        paper_with = copy.deepcopy(paper_without)
        paper_with['apiReaderPlan']['implementationSpecs']['audioSignalSpecs'] = (
            '采样率 24 kHz，帧率 50 Hz（步长 20 ms），码率 1.5 kbps，因果前瞻延迟 40 ms，A100 推理 RTF 0.11。'
        )
        reseal_v5(paper_with)
        payload_with = publish_to_blog._api_reader_payload_uncached(paper_with)
        self.assertIn('audioSignalSpecs', payload_with['plan']['implementationSpecs'])
        md_with, _ = publish_to_blog.generate_paper_page(paper_with, '2026-11-24')
        self.assertIn('- **音频信号与流式规格**：采样率 24 kHz', md_with)
        self.assertLess(
            md_with.index('音频信号与流式规格'),
            md_with.index('训练与评测数据'),
        )
        self.assertIsNone(publish_to_blog._api_reader_page_binding_issue(md_with, paper_with))

        # 3. Malformed HTML or multiline audioSignalSpecs is rejected fail-closed
        bad_html = copy.deepcopy(paper_without)
        bad_html['apiReaderPlan']['implementationSpecs']['audioSignalSpecs'] = '24 kHz <script>alert(1)</script>'
        reseal_v5(bad_html)
        with self.assertRaises(publish_common.PublishDataValidationError):
            publish_to_blog._api_reader_payload_uncached(bad_html)

        bad_multiline = copy.deepcopy(paper_without)
        bad_multiline['apiReaderPlan']['implementationSpecs']['audioSignalSpecs'] = '第一行\n第二行'
        reseal_v5(bad_multiline)
        with self.assertRaises(publish_common.PublishDataValidationError):
            publish_to_blog._api_reader_payload_uncached(bad_multiline)

    def test_render_verified_reader_resources_surfaces_audio_demo_probes_only_on_structured_v5(self):
        v5_plan_header = codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher')
        v4_plan_header = {
            'contract': codec.contract('beginner-researcher'),
            'schemaFingerprint': reader_formats.V4_PLAN_FP,
        }
        resources = [
            {
                'type': 'demo',
                'originalUrl': 'https://audiolab.github.io/streamcodec/',
                'finalUrl': 'https://audiolab.github.io/streamcodec/',
                'availability': 'available',
                'status': 200,
            }
        ]
        manifest = {
            'stages': {
                'demoLinkScan': {
                    'audioDemoProbes': [
                        {
                            'url': 'https://audiolab.github.io/streamcodec/',
                            'reachable': True,
                            'audioSampleCount': 8,
                            'sampleProbe': {'audioSamplesReachable': True, 'probedCount': 2, 'reachableCount': 2},
                            'hasBaselineComparison': True,
                            'spaceStatuses': [
                                {'stage': 'RUNNING', 'hardware': 't4-small', 'isRunning': True}
                            ],
                        }
                    ]
                }
            }
        }
        v5_paper = {'arxivId': '2611.99901', 'apiReaderPlan': v5_plan_header, 'analysisManifest': manifest}
        v5_md = publish_to_blog.render_verified_reader_resources(resources, paper=v5_paper)
        self.assertIn('含 8 条试听样本（已验证可访问）', v5_md)
        self.assertIn('含基线对比表', v5_md)
        self.assertIn('HF Space 状态：RUNNING（t4-small）', v5_md)

        # Legacy / v4 paper must keep zero drift
        v4_paper = {'arxivId': '2611.99901', 'apiReaderPlan': v4_plan_header, 'analysisManifest': manifest}
        v4_md = publish_to_blog.render_verified_reader_resources(resources, paper=v4_paper)
        self.assertNotIn('试听样本', v4_md)
        self.assertNotIn('基线对比表', v4_md)
        self.assertNotIn('HF Space 状态', v4_md)

    def test_paper_resource_badges_ignores_unreviewed_opensource_when_api_reader_resources_present(self):
        modern_paper = {
            'apiReaderResources': {
                'resources': [
                    {'type': 'code', 'availability': 'available'},
                    {'type': 'demo', 'availability': 'unavailable'},
                ]
            },
            'parsed': {
                'hasCode': '否',
                'hasModel': '是',
                'opensource': '- Demo：https://unreviewed.example/demo',
            },
        }
        badges = publish_to_blog._paper_resource_badges(modern_paper, modern_paper['parsed'])
        self.assertTrue(badges['hasCode'])
        self.assertFalse(badges['hasModelOrData'])
        self.assertFalse(badges['hasDemo'])
        self.assertEqual(badges['text'], '💻')

    def test_daily_roundup_2_0_real_2026_11_20_batch_passes_strict_index_quality_gate(self):
        data_path = REPO_ROOT / 'data' / 'current' / 'deep-analysis-result.json'
        if not data_path.exists():
            self.skipTest('data/current/deep-analysis-result.json absent')
        data = json.loads(data_path.read_text('utf-8'))
        papers = data.get('papers') or []
        self.assertGreater(len(papers), 0)

        scored = []
        unscored = []
        slugs = {}
        for paper in papers:
            p = dict(paper)
            parsed = publish_to_blog.parse_analysis(p.get('analysis', '')) or p.get('parsed') or {}
            p['parsed'] = parsed
            slugs[p['arxivId']] = publish_to_blog.slugify(p.get('title', '')) + '-' + p['arxivId'].replace('.', '-')
            if parsed.get('score') is not None:
                scored.append((float(parsed['score']), p, parsed))
            else:
                unscored.append(p)
        scored.sort(key=lambda item: item[0], reverse=True)

        md = publish_to_blog.generate_index_page(scored, unscored, data.get('date', '2026-11-20'), slugs)
        self.assertIsNone(publish_common.validate_digest_index_reader_quality(md, required=True))
        self.assertIn('### 🧭 今日研究脉络', md)
        self.assertIn('### 🎯 三档阅读分级', md)
        self.assertIn('### 🌟 今日精选焦点', md)
        self.assertIn('| 排名 | 论文 | 中文导览 | 总分 | 分档 | 文档类型 | 最上级任务 | 资源 |', md)
        self.assertIn('🔥 精读必看（8.0 分及以上）', md)
        self.assertIn('📌 重点关注（7.0–7.9 分）', md)
        self.assertIn('⚡ 速览参考（7.0 分以下）', md)
        self.assertIn('突出维度：', md)
        top_plan = (scored[0][1].get('apiReaderPlan') or {}) if scored else {}
        if top_plan.get('oneSentenceThesis'):
            self.assertNotIn(top_plan['oneSentenceThesis'], md)

    def test_round1_security_isolation_and_title_sanitization_regressions(self):
        v5_plan_header = codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher')

        # P0-2 + P1-5: normalized URL matching, unavailable demo skipped, hostile stage/hardware & bool count stripped
        resources_avail = [{
            'type': 'demo',
            'originalUrl': 'https://AudioLab.GitHub.io/StreamCodec',
            'finalUrl': 'https://www.audiolab.github.io/StreamCodec/',
            'availability': 'available',
            'status': 200,
        }]
        resources_unavail = [{
            'type': 'demo',
            'originalUrl': 'https://audiolab.github.io/streamcodec/',
            'finalUrl': 'https://audiolab.github.io/streamcodec/',
            'availability': 'unavailable',
            'status': 404,
        }]
        manifest = {
            'stages': {
                'demoLinkScan': {
                    'audioDemoProbes': [{
                        'url': 'https://audiolab.github.io/StreamCodec/',
                        'originalUrl': 'https://audiolab.github.io/StreamCodec',
                        'reachable': True,
                        'audioSampleCount': True,  # bool must not count as 1!
                        'hasBaselineComparison': True,
                        'spaceStatuses': [{
                            'stage': 'RUNNING<script>alert(1)</script>',
                            'hardware': 't4\n## injected',
                        }],
                    }]
                }
            }
        }
        v5_paper = {'arxivId': '2611.99902', 'apiReaderPlan': v5_plan_header, 'analysisManifest': manifest}
        avail_md = publish_to_blog.render_verified_reader_resources(resources_avail, paper=v5_paper)
        self.assertIn('含基线对比表', avail_md)
        self.assertNotIn('试听样本', avail_md)
        self.assertNotIn('<script>', avail_md)
        self.assertNotIn('## injected', avail_md)
        self.assertNotIn('HF Space 状态', avail_md)

        unavail_md = publish_to_blog.render_verified_reader_resources(resources_unavail, paper=v5_paper)
        self.assertNotIn('含基线对比表', unavail_md)

        # P1-1: explicit empty apiReaderResources stays authoritative; non-audio probe never gets 🔊
        empty_modern = {
            'apiReaderResources': {'resources': []},
            'parsed': {'hasCode': '是', 'hasModel': '是', 'opensource': '- Demo：https://x.example/demo'},
            'analysisManifest': manifest,
        }
        self.assertEqual(publish_to_blog._paper_resource_badges(empty_modern, empty_modern['parsed'])['text'], '-')

        legacy_plain_homepage = {
            'parsed': {'hasCode': '否', 'hasModel': '否', 'opensource': ''},
            'analysisManifest': {
                'stages': {
                    'demoLinkScan': {
                        'audioDemoProbes': [{'url': 'https://x.example', 'reachable': True, 'audioTagCount': 0, 'audioSampleCount': 0}]
                    }
                }
            },
        }
        self.assertEqual(publish_to_blog._paper_resource_badges(legacy_plain_homepage, legacy_plain_homepage['parsed'])['text'], '-')

        # P0-4: Audio-unit English fallback + special chars + 3 multi-question titles pass strict quality gate
        tricky_snippet = publish_to_blog._safe_index_overview_snippet(
            '用 A*(x) 与 [24kHz] 在 $100 内提速？真的吗！如何验证？', max_chars=44, for_link_label=True
        )
        self.assertNotIn('\\', tricky_snippet)
        self.assertNotIn('$', tricky_snippet)
        self.assertNotIn('[', tricky_snippet)
        self.assertNotIn(']', tricky_snippet)
        self.assertNotIn('？', tricky_snippet)
        self.assertIn('24 kHz', tricky_snippet)
        self.assertIn('＄100', tricky_snippet)

        en_fallback_paper = {
            'arxivId': '2611.99903',
            'title': 'FastCodec 0: 24kHz Neural Audio Codec at 40ms Latency [v2]',
            'parsed': {},
        }
        disp, is_zh = publish_to_blog._index_paper_display_title(en_fallback_paper, {}, '2026-11-24', max_chars=44)
        self.assertFalse(is_zh)
        self.assertNotIn('[', disp)
        self.assertIn('24 kHz', disp)
        self.assertIsNone(publish_common.validate_manual_reader_quality('## 核心摘要\n' + disp))

        # Round 2 P1-1: Chinese readerTitle with hyphenated model boundaries must NOT be silently dropped
        hyphen_title = publish_to_blog._safe_index_overview_snippet(
            '检查点：DRVEXO-4B-统一系统解读', max_chars=36, for_link_label=True
        )
        self.assertNotEqual(hyphen_title, '')
        self.assertIn('DRVEXO-4B-', hyphen_title)
        self.assertIsNone(publish_common.validate_manual_reader_quality('## 核心摘要\n' + hyphen_title))


if __name__ == '__main__':
    unittest.main()

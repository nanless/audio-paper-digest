#!/usr/bin/env python3
"""Wave 13 Track 13.3 tests: rubric v2.1 metadata, artifact probe badges, and transparent scoring notes."""

import copy
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
import reader_record_format as reader_formats  # noqa: E402
import scoring_rubric as sr  # noqa: E402
from test_reader_structured_pipeline import (  # noqa: E402
    build_structured_v5_publication_paper,
    pub as publish_to_blog,
    reseal_v5,
)


class Wave13Track133ScoringDisplayTest(unittest.TestCase):
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

    def test_scoring_rubric_additive_metadata_and_weights_summary(self):
        self.assertEqual(sr.CURRENT_SCORING_RUBRIC, 'type-aware')
        self.assertTrue(sr.is_unified_rubric('type-aware'))
        self.assertTrue(sr.is_unified_rubric('type-aware-v2'))
        self.assertTrue(sr.is_legacy_rubric('type-aware-v1'))
        self.assertEqual(sr.CALIBRATION_PROFILE, 'audio-rubric-calibration')
        self.assertEqual([a['score'] for a in sr.CALIBRATION_ANCHORS], [5.2, 6.5, 7.5, 8.5, 9.2])
        self.assertEqual(len(sr.DOMAIN_RED_LINES), 4)
        self.assertEqual(
            sr.format_document_type_weights_summary('方法研究'),
            '创新 24% · 严谨 18% · 实验 22% · 清晰 8% · 影响 14% · 复现 7% · 工程 7%（开源上限加分 +0.5）',
        )
        self.assertEqual(
            sr.format_document_type_weights_summary('理论研究'),
            '创新 26% · 严谨 30% · 实验 12% · 清晰 12% · 影响 14% · 复现 6% · 工程 0%（开源上限加分 +0.2）',
        )
        self.assertEqual(sr.format_document_type_weights_summary('未知'), '')
        self.assertEqual(sr.format_document_type_weights_summary(None), '')

    def test_render_verified_reader_resources_artifact_badges_and_v4_isolation(self):
        v5_plan_header = codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher')
        v4_plan_header = {
            'contract': codec.contract('beginner-researcher'),
            'schemaFingerprint': reader_formats.V4_PLAN_FP,
        }
        resources = [
            {
                'type': 'code',
                'originalUrl': 'https://github.com/AudioLab/RichRepo.git',
                'finalUrl': 'https://github.com/AudioLab/RichRepo',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'code',
                'originalUrl': 'https://github.com/AudioLab/EmptyFramework',
                'finalUrl': 'https://github.com/AudioLab/EmptyFramework',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'model',
                'originalUrl': 'https://huggingface.co/models/AudioLab/GatedModel',
                'finalUrl': 'https://huggingface.co/AudioLab/GatedModel',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'dataset',
                'originalUrl': 'https://doi.org/10.5281/zenodo.987654',
                'finalUrl': 'https://zenodo.org/records/987654',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'code',
                'originalUrl': 'https://github.com/AudioLab/DeadRepo',
                'finalUrl': 'https://github.com/AudioLab/DeadRepo',
                'availability': 'unavailable',
                'status': 404,
            },
        ]
        manifest = {
            'stages': {
                'demoLinkScan': {
                    'artifactProbes': [
                        {
                            'platform': 'github',
                            'url': 'https://github.com/audiolab/richrepo',
                            'ok': True,
                            'hasCodeFiles': True,
                            'hasWeightFiles': True,
                            'weightExtensions': ['.safetensors', '.pt', '.onnx', '.gguf', '.evil<script>'],
                            'placeholderSuspected': False,
                            'spdxLicense': 'Apache-2.0',
                        },
                        {
                            'platform': 'github',
                            'url': 'https://github.com/AudioLab/EmptyFramework',
                            'ok': True,
                            'hasCodeFiles': False,
                            'hasWeightFiles': False,
                            'weightExtensions': [],
                            'placeholderSuspected': True,
                            'spdxLicense': 'NOASSERTION',
                        },
                        {
                            'platform': 'huggingface',
                            'url': 'https://huggingface.co/AudioLab/GatedModel',
                            'ok': True,
                            'gated': True,
                            'hasWeightFiles': True,
                            'weightExtensions': ['.safetensors'],
                            'spdxLicense': 'MIT<script>',
                        },
                        {
                            'platform': 'zenodo',
                            'url': 'https://zenodo.org/records/987654',
                            'originalUrl': 'https://doi.org/10.5281/zenodo.987654',
                            'ok': True,
                            'gated': False,
                            'hasDatasetFiles': True,
                            'spdxLicense': 'cc-by-4.0',
                        },
                        {
                            'platform': 'github',
                            'url': 'https://github.com/AudioLab/DeadRepo',
                            'ok': True,
                            'hasWeightFiles': True,
                            'weightExtensions': ['.pt'],
                            'spdxLicense': 'MIT',
                        },
                    ]
                }
            }
        }

        v5_paper = {'arxivId': '2611.93301', 'apiReaderPlan': v5_plan_header, 'analysisManifest': manifest}
        v5_md = publish_to_blog.render_verified_reader_resources(resources, paper=v5_paper)

        # Max 3 validated weight extensions + valid SPDX license
        self.assertIn('含权重文件（.safetensors/.pt/.onnx）', v5_md)
        self.assertNotIn('.gguf', v5_md)
        self.assertNotIn('.evil', v5_md)
        self.assertIn('许可证：Apache-2.0', v5_md)
        # Placeholder warning, NOASSERTION dropped
        self.assertIn('仓库仅见文档框架（未检出代码/权重文件）', v5_md)
        self.assertNotIn('NOASSERTION', v5_md)
        # Gated badge, hostile license stripped
        self.assertIn('受控访问（gated）', v5_md)
        self.assertNotIn('<script>', v5_md)
        # Zenodo DOI matched
        self.assertIn('许可证：cc-by-4.0', v5_md)
        # Unavailable repo gets ZERO artifact badges
        dead_line = next(line for line in v5_md.splitlines() if 'DeadRepo' in line)
        self.assertNotIn('含权重文件', dead_line)
        self.assertNotIn('许可证：MIT', dead_line)
        # CRITICAL: never emit positive_claims trigger phrases
        self.assertNotIn('权重可用', v5_md)
        self.assertNotIn('模型已公开', v5_md)

        # Legacy v4 paper stays 100% unchanged
        v4_paper = {'arxivId': '2611.93301', 'apiReaderPlan': v4_plan_header, 'analysisManifest': manifest}
        v4_md = publish_to_blog.render_verified_reader_resources(resources, paper=v4_paper)
        self.assertNotIn('含权重文件', v4_md)
        self.assertNotIn('仓库仅见文档框架', v4_md)
        self.assertNotIn('受控访问', v4_md)
        self.assertNotIn('许可证：', v4_md)

    def test_code_only_repo_with_weight_files_badge_passes_page_binding_positive_claims_guard(self):
        paper = build_structured_v5_publication_paper()
        # Ensure fixture has code available and model NOT in availableTypes
        res_proof = paper['apiReaderResources']
        code_res = next(r for r in res_proof['resources'] if r.get('type') == 'code')
        paper['analysisManifest'].setdefault('stages', {})['demoLinkScan'] = {
            'status': 'complete',
            'artifactProbes': [
                {
                    'platform': 'github',
                    'url': code_res['originalUrl'],
                    'ok': True,
                    'hasCodeFiles': True,
                    'hasWeightFiles': True,
                    'weightExtensions': ['.safetensors', '.pt'],
                    'spdxLicense': 'MIT',
                }
            ],
        }
        reseal_v5(paper)
        md, _ = publish_to_blog.generate_paper_page(paper, '2026-11-24')
        self.assertIn('含权重文件（.safetensors/.pt）', md)
        self.assertIn('许可证：MIT', md)
        self.assertNotIn('权重可用', md)
        self.assertNotIn('模型已公开', md)
        # Must pass strict _api_reader_page_binding_issue (positive_claims guard for model!)
        self.assertIsNone(publish_to_blog._api_reader_page_binding_issue(md, paper))

    def test_render_verified_reader_scoring_notes_v2_transparent_sanitized_and_v1_byte_identical(self):
        v2_paper = {
            'arxivId': '2611.93302',
            'scoringRubricVersion': 'type-aware-v2',
            'parsed': {'scoringRubricVersion': 'type-aware-v2', 'documentType': '方法研究'},
            'analysisManifest': {
                'stages': {
                    'scoringAudit': {
                        'model': 'muse-spark-1.3-contributor',
                        'protocol': 'openai_responses',
                        'audit': {
                            'documentType': '方法研究',
                            'evidenceProfile': {
                                'primaryStrengths': [
                                    '[A_METHOD] 提出低延迟声学量化结构，推理成本仅 $5 美元且 **RTF** 为 `0.11`。',
                                    '[A_RESULTS] 在 LibriSpeech 上超越强基线\n\t并附带完整消融。',
                                    '[A_OPEN] 代码仓库结构清晰，支持 <script>alert(1)</script> 过滤测试。',
                                    '[A_SUMMARY] 第四条优势应当被截断，不应超过三条。',
                                ],
                                'primaryDefects': [
                                    '[A_LIMITS] 缺少真人盲测协议且出现 **未闭合加粗 与 __未闭合下划线 及 `未闭合反引号。',
                                    '[A_ARTIFACT_PROBE] 仓库未公开模型权重文件。',
                                ],
                            },
                        },
                    }
                }
            },
        }
        v2_notes = publish_to_blog.render_verified_reader_scoring_notes(v2_paper, v2_paper['parsed'])
        self.assertIn(
            '- 维度权重（方法研究）：创新 24% · 严谨 18% · 实验 22% · 清晰 8% · 影响 14% · 复现 7% · 工程 7%（开源上限加分 +0.5）',
            v2_notes,
        )
        # Internal anchors stripped
        for anchor in ('[A_METHOD]', '[A_RESULTS]', '[A_OPEN]', '[A_LIMITS]', '[A_ARTIFACT_PROBE]'):
            self.assertNotIn(anchor, v2_notes)
        # Max 3 strengths
        self.assertEqual(v2_notes.count('- 核心优势：'), 3)
        self.assertEqual(v2_notes.count('- 主要短板：'), 2)
        self.assertNotIn('第四条优势应当被截断', v2_notes)
        # Sanitization checks: raw HTML escaped, $ -> ＄, whitespace collapsed, ** stripped unconditionally, balanced code kept, unmatched stripped
        self.assertNotIn('$', v2_notes)
        self.assertIn('RTF 为 `0.11`', v2_notes)
        self.assertNotIn('**', v2_notes)
        self.assertIn('超越强基线 并附带完整消融。', v2_notes)
        self.assertNotIn('<script>', v2_notes)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', v2_notes)
        defect_line = next(line for line in v2_notes.splitlines() if '缺少真人盲测协议' in line)
        self.assertNotIn('**', defect_line)
        self.assertNotIn('__', defect_line)
        self.assertNotIn('`', defect_line)

        # Legacy v1 paper MUST stay 100% byte-identical (no weights line, no strengths/defects)
        v1_paper = copy.deepcopy(v2_paper)
        v1_paper['scoringRubricVersion'] = 'type-aware-v1'
        v1_paper['parsed']['scoringRubricVersion'] = 'type-aware-v1'
        v1_notes = publish_to_blog.render_verified_reader_scoring_notes(v1_paper, v1_paper['parsed'])
        expected_v1 = '\n\n'.join([
            '评分属于系统判断，不是论文实验结果；八维数值与总分见页首，原始审计记录保留在后端。',
            '- 评分规则：type-aware-v1',
            '- 评分模型：muse-spark-1.3-contributor',
            '- 评分请求协议：openai_responses',
        ])
        self.assertEqual(v1_notes, expected_v1)

        # End-to-end v2 paper page generation + binding check
        v2_full = build_structured_v5_publication_paper()
        v2_full['scoringRubricVersion'] = 'type-aware-v2'
        v2_full['parsed']['scoringRubricVersion'] = 'type-aware-v2'
        v2_full['analysisManifest']['stages']['scoringAudit']['audit'] = {
            'documentType': v2_full['parsed'].get('documentType') or '方法研究',
            'evidenceProfile': {
                'primaryStrengths': ['[A_METHOD] 端到端声学架构设计紧凑，在公开基准上稳定超越基线。'],
                'primaryDefects': ['[A_LIMITS] 未在多语种高噪声场景下开展大规模主观听测。'],
            },
        }
        reseal_v5(v2_full)
        md_v2, _ = publish_to_blog.generate_paper_page(v2_full, '2026-11-24')
        self.assertIn('- 维度权重（', md_v2)
        self.assertIn('- 核心优势：端到端声学架构设计紧凑', md_v2)
        self.assertIn('- 主要短板：未在多语种高噪声场景下开展大规模主观听测。', md_v2)
        self.assertIsNone(publish_to_blog._api_reader_page_binding_issue(md_v2, v2_full))

    def test_round1_finding1_markdown_hugo_gate_compliance_on_adversarial_scoring_claims(self):
        adversarial_paper = {
            'arxivId': '2611.93309',
            'scoringRubricVersion': 'type-aware-v2',
            'parsed': {'scoringRubricVersion': 'type-aware-v2', 'documentType': '方法研究'},
            'analysisManifest': {
                'stages': {
                    'scoringAudit': {
                        'model': 'muse-spark-1.3-contributor',
                        'protocol': 'openai_responses',
                        'audit': {
                            'documentType': '方法研究',
                            'evidenceProfile': {
                                'primaryStrengths': [
                                    '[A_METHOD] **端到端流式**在复杂度 $O(N \\log N)$ 且 $x < y$ 时由 A & B 联合训练。',
                                    '[A_RESULTS] 详见 ![架构图](https://evil.example/a.png) 与 [主页链接](https://evil.example/p)，单卡费用 $88 且有 ```python code``` 与 ~~~sh。',
                                    '[A_OPEN] 支持 {{< rawhtml >}} 与 {{% shortcode %}}，并测试 <script>alert(1)</script> 和 <img src=x onerror=1> 以及未闭合 <script。',
                                ],
                                'primaryDefects': [
                                    r'[A_LIMITS] 未配对公式 \(x + 1 与 \[a + b 及多余右括号 \) 和 \] 还有未闭合 `反引号 和 **未闭合加粗 与 __下划线。',
                                    '[A_RESULTS] 保留合法公式 \\(f(x) < g(y)\\) 与平衡代码 `RTF=0.09` 并转义裸 $$50 成本。',
                                ],
                            },
                        },
                    }
                }
            },
        }
        rendered = publish_to_blog.render_verified_reader_scoring_notes(adversarial_paper, adversarial_paper['parsed'])
        # End-to-end markdown_hugo_gate.validate_markdown_format_gate MUST pass with 0 issues
        gate_issues = publish_to_blog.validate_markdown_format_gate('adversarial-scoring-notes.md', {}, rendered)
        self.assertEqual(gate_issues, [], f'validate_markdown_format_gate failed: {gate_issues}\nRendered:\n{rendered}')

        # Balanced inline math & A & B preserved without mangling
        self.assertIn(r'\(O(N \log N)\)', rendered)
        self.assertIn(r'\(x < y\)', rendered)
        self.assertIn(r'\(f(x) < g(y)\)', rendered)
        self.assertIn('A & B', rendered)
        self.assertNotIn('A &amp; B', rendered)
        self.assertIn('`RTF=0.09`', rendered)
        # Bare $ neutralized, bold/underline/images/links/shortcodes/fences/raw HTML neutralized
        self.assertIn('＄88', rendered)
        self.assertIn('＄＄50', rendered)
        self.assertNotIn('$', rendered)
        self.assertNotIn('**', rendered)
        self.assertNotIn('__', rendered)
        self.assertNotIn('![', rendered)
        self.assertNotIn('](https://evil.example', rendered)
        self.assertIn('架构图', rendered)
        self.assertIn('主页链接', rendered)
        self.assertNotIn('```', rendered)
        self.assertNotIn('~~~', rendered)
        self.assertNotIn('{{<', rendered)
        self.assertNotIn('{{%', rendered)
        self.assertNotIn('<script>', rendered)
        self.assertNotIn('<img', rendered)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', rendered)

    def test_round1_findings8_and_11_third_party_skip_doi_subpath_canonicalization_and_dataset_placeholder(self):
        v5_plan_header = codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher')
        resources = [
            {
                'type': 'third_party',
                'originalUrl': 'https://github.com/AudioLab/ThirdPartyTool',
                'finalUrl': 'https://github.com/AudioLab/ThirdPartyTool',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'code',
                'originalUrl': 'https://github.com/AudioLab/SubpathRepo/tree/main/audio',
                'finalUrl': 'https://github.com/AudioLab/SubpathRepo/tree/main/audio',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'model',
                'originalUrl': 'https://huggingface.co/AudioLab/SubpathModel/tree/main',
                'finalUrl': 'https://huggingface.co/AudioLab/SubpathModel/tree/main',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'dataset',
                'originalUrl': 'https://doi.org/10.5281/zenodo.555666',
                'finalUrl': 'https://doi.org/10.5281/zenodo.555666',
                'availability': 'available',
                'status': 200,
            },
            {
                'type': 'dataset',
                'originalUrl': 'https://github.com/AudioLab/DatasetOnlyRepo',
                'finalUrl': 'https://github.com/AudioLab/DatasetOnlyRepo',
                'availability': 'available',
                'status': 200,
            },
        ]
        manifest = {
            'stages': {
                'demoLinkScan': {
                    'artifactProbes': [
                        {
                            'platform': 'github',
                            'url': 'https://github.com/AudioLab/ThirdPartyTool',
                            'ok': True,
                            'hasWeightFiles': True,
                            'weightExtensions': ['.safetensors'],
                            'spdxLicense': 'MIT',
                        },
                        {
                            'platform': 'github',
                            'url': 'https://github.com/AudioLab/SubpathRepo',
                            'ok': True,
                            'hasCodeFiles': True,
                            'spdxLicense': 'BSD-3-Clause',
                        },
                        {
                            'platform': 'huggingface',
                            'url': 'https://huggingface.co/AudioLab/SubpathModel',
                            'ok': True,
                            'gated': True,
                            'spdxLicense': 'Apache-2.0',
                        },
                        {
                            'platform': 'zenodo',
                            'url': 'https://zenodo.org/records/555666',
                            'ok': True,
                            'hasDatasetFiles': True,
                            'spdxLicense': 'cc-by-4.0',
                        },
                        {
                            'platform': 'github',
                            'url': 'https://github.com/AudioLab/DatasetOnlyRepo',
                            'ok': True,
                            'placeholderSuspected': True,
                            'hasCodeFiles': False,
                            'hasWeightFiles': False,
                            'hasDatasetFiles': True,
                            'spdxLicense': 'cc-by-4.0',
                        },
                    ]
                }
            }
        }
        paper = {'arxivId': '2611.93311', 'apiReaderPlan': v5_plan_header, 'analysisManifest': manifest}
        md = publish_to_blog.render_verified_reader_resources(resources, paper=paper)
        lines_by_key = {
            key: next(line for line in md.splitlines() if key in line)
            for key in ('ThirdPartyTool', 'SubpathRepo', 'SubpathModel', 'zenodo.555666', 'DatasetOnlyRepo')
        }
        # #11: third_party never gets artifact badges
        self.assertNotIn('含权重文件', lines_by_key['ThirdPartyTool'])
        self.assertNotIn('许可证：MIT', lines_by_key['ThirdPartyTool'])
        # #11: GitHub /tree/..., HF /tree/..., and Zenodo DOI canonicalized even without originalUrl on probe
        self.assertIn('许可证：BSD-3-Clause', lines_by_key['SubpathRepo'])
        self.assertIn('受控访问（gated）', lines_by_key['SubpathModel'])
        self.assertIn('许可证：Apache-2.0', lines_by_key['SubpathModel'])
        self.assertIn('许可证：cc-by-4.0', lines_by_key['zenodo.555666'])
        # #8: hasDatasetFiles=True prevents placeholder warning even if placeholderSuspected was set
        self.assertNotIn('仓库仅见文档框架', lines_by_key['DatasetOnlyRepo'])
        self.assertIn('许可证：cc-by-4.0', lines_by_key['DatasetOnlyRepo'])

    def test_round2_fixed_point_convergence_escaped_dollars_mixed_stars_and_html_inside_math(self):
        paper = {
            'arxivId': '2611.93312',
            'scoringRubricVersion': 'type-aware-v2',
            'parsed': {'scoringRubricVersion': 'type-aware-v2', 'documentType': '方法研究'},
            'analysisManifest': {
                'stages': {
                    'scoringAudit': {
                        'model': 'muse-spark-1.3-contributor',
                        'protocol': 'openai_responses',
                        'audit': {
                            'documentType': '方法研究',
                            'evidenceProfile': {
                                'primaryStrengths': [
                                    r'[A_METHOD] 费用 \$5、双斜杠 \\\$5 与反引号 \`$5 全部中和，且 *`* 与 *\*foo\** 及 _\_bar\__ 全部剥离。',
                                    r'[A_RESULTS] 拆分短代码 {`{< rawhtml >}} 经定点收敛彻底中和。',
                                    r'[A_OPEN] 数学内标签 \(<script>alert(1)</script>\)、$<img src=x onerror=1>$ 与 \(<svg/onload=alert(1)>\) 被转义，而 \(x < y\) 与 \(f(x) < g(y)\) 保持原样。',
                                ],
                                'primaryDefects': [
                                    r'[A_LIMITS] 拆分图片 ![alt]`(https://evil.example/a.png) 经定点收敛彻底剥离。',
                                    r'[A_LIMITS] 数学内属性单字母标签 \(<a href="javascript:alert(1)">click</a>\)、斜杠标签 \(<a/onload=alert(1)>\)、未闭合 \(<script alert(1)\) 与注释 \(<!-- x -->\) 转义，正常不等式 \(a < b\) 保留。',
                                    r'[A_LIMITS] 平衡行内代码 `{{< inner >}}`、`**kwargs`、`**`、*`**`* 中的短代码与双星均被剥离，正常代码 `RTF=0.08` 保留。',
                                ],
                            },
                        },
                    }
                }
            },
        }
        rendered = publish_to_blog.render_verified_reader_scoring_notes(paper, paper['parsed'])
        gate_issues = publish_to_blog.validate_markdown_format_gate('round2-adversarial.md', {}, rendered)
        self.assertEqual(gate_issues, [], f'validate_markdown_format_gate failed: {gate_issues}\nRendered:\n{rendered}')

        # Zero $ (even escaped \$ / \\\$ / \`$), zero ** / *\* / __ / _\_, zero shortcodes, zero images
        self.assertNotIn('$', rendered)
        self.assertIn('＄5', rendered)
        self.assertNotIn('**', rendered)
        self.assertNotIn(r'*\*', rendered)
        self.assertNotIn('__', rendered)
        self.assertNotIn(r'_\_', rendered)
        self.assertNotIn('{{<', rendered)
        self.assertNotIn('>}}', rendered)
        self.assertNotIn('![', rendered)
        self.assertNotIn('https://evil.example/a.png', rendered)
        self.assertIn('foo', rendered)
        self.assertIn('bar', rendered)
        self.assertIn('alt', rendered)
        self.assertIn('｛｛＜ rawhtml ＞｝｝', rendered)
        self.assertIn('`｛｛＜ inner ＞｝｝`', rendered)
        self.assertIn('`kwargs`', rendered)
        self.assertNotIn('``', rendered)
        self.assertIn('`RTF=0.08`', rendered)
        # Raw HTML inside balanced math delimiters escaped; inequalities preserved
        self.assertNotIn('<script', rendered)
        self.assertNotIn('<img', rendered)
        self.assertNotIn('<svg', rendered)
        self.assertNotIn('<a href=', rendered)
        self.assertNotIn('<a/onload=', rendered)
        self.assertNotIn('<!--', rendered)
        self.assertIn(r'\(&lt;script&gt;alert(1)&lt;/script&gt;\)', rendered)
        self.assertIn(r'\(&lt;img src=x onerror=1&gt;\)', rendered)
        self.assertIn(r'\(&lt;svg/onload=alert(1)&gt;\)', rendered)
        self.assertIn(r'\(&lt;a/onload=alert(1)&gt;\)', rendered)
        self.assertIn(r'\(&lt;script alert(1)\)', rendered)
        self.assertIn(r'\(x < y\)', rendered)
        self.assertIn(r'\(f(x) < g(y)\)', rendered)
        self.assertIn(r'\(a < b\)', rendered)


if __name__ == '__main__':
    unittest.main()

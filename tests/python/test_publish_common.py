import os
import sys
import contextlib
import copy
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from publish_common import (  # noqa: E402
    PublishLLMUnavailable,
    PublishDataValidationError,
    build_publish_headers,
    build_publish_payload,
    build_publish_api_url,
    build_paper_meta,
    dedupe_image_alts,
    detect_publish_api_type,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    escape_html_like_tags,
    METHOD_DETAIL_CONTRACT_VERSION,
    extract_markdown_tables,
    fix_empty_markdown_links,
    fix_yaml_unbalanced_quotes,
    get_today_bj,
    link_remote_images_to_original,
    normalize_arxiv_math_double_extraction,
    load_papers,
    paper_batch_date,
    call_publish_llm_api,
    count_blocking_review_issues,
    resolve_publish_parsed,
    sanitize_markdown_for_publish,
    select_blog_published_snapshot,
    strip_raw_inline_html,
    validate_publish_api_endpoint_url,
    validate_papers_for_publish,
    validate_experiment_table_contract,
    validate_method_detail_contract,
    validate_image_narrative_contract,
    validate_final_manual_v4_markdown,
    validate_manual_editorial_quality_v4,
    validate_digest_index_reader_quality,
    validate_review_payload,
    MANUAL_AUDIT_CHECKS,
    MANUAL_STAGE_EVIDENCE_STAGES,
    _manual_hash,
    _manual_v4_reader_view,
    _validate_manual_result_claim_bindings,
    _validate_manual_v4_result_claims,
    _validate_manual_takeover_manifest,
)
from utils import parse_analysis  # noqa: E402


def complete_analysis():
    return '''## 评分
7.0/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前50%
confidence: 高

## 标签
#语音识别 #Transformer

## 评分理由
* 创新性 (1/2)：具体理由充分
* 技术严谨性 (1/1.5)：具体理由充分
* 实验充分性 (1/1.5)：具体理由充分
* 清晰度 (1/1)：具体理由充分
* 影响力 (1/1.5)：具体理由充分
* 开源 (0/1.5)：具体理由充分
* 可复现性 (0.5/0.5)：具体理由充分
* 工程/实践价值 (1.5/1.5)：具体理由充分
'''


def complete_paper():
    analysis = complete_analysis()
    return {
        'arxivId': '2607.00001',
        'analysis': analysis,
        'parsed': parse_analysis(analysis),
        'scoringRubricVersion': 'type-aware-v1',
    }


def manual_v2_fixture(*, hardened=True, completed_at=None, v3=False):
    analysis = 'manual provenance body'
    analysis_sha = hashlib.sha256(analysis.encode('utf-8')).hexdigest()
    source_sha = hashlib.sha256(b'controlled full text').hexdigest()
    prompt_sha = hashlib.sha256(b'deep-analysis prompt').hexdigest()
    audit = {
        'version': 1,
        'attempts': 2,
        'passes': [
            {'status': 'revise', 'issues': ['核对阶段证据']},
            {'status': 'pass', 'issues': []},
        ],
        'checks': {key: True for key in MANUAL_AUDIT_CHECKS},
    }
    audit_sha = _manual_hash(audit)
    ledger = [
        {'id': f'E{index:02d}', 'section': '实验结果', 'claim': f'claim {index}', 'sourceQuote': f'quote {index}'}
        for index in range(1, 7)
    ]
    image_manifest = {
        'version': 2 if v3 else 1,
        'candidates': [],
        'downloadOutcomes': [],
        'selected': [],
        'downloadEvidenceSha256': _manual_hash({'candidates': [], 'outcomes': []}),
        'insertionPlan': [],
        'insertionDiagnostics': [],
    }
    image_manifest['selectionEvidenceSha256'] = _manual_hash({
        'selected': [],
        'insertionPlan': [],
        'insertionDiagnostics': [],
    }) if v3 else _manual_hash([])
    stages = {}
    evidence = {}
    for stage in MANUAL_STAGE_EVIDENCE_STAGES:
        claims = [f'{stage} reviewed claim with concrete evidence']
        stage_prompt_sha = prompt_sha if stage == 'primaryAnalysis' else hashlib.sha256(stage.encode('utf-8')).hexdigest()
        context_sha = {
            'imageDownload': image_manifest['downloadEvidenceSha256'],
            'imageSupplement': image_manifest['selectionEvidenceSha256'],
        }.get(stage)
        if hardened:
            input_payload = {
                'stage': stage,
                'sourceSha256': source_sha,
                'analysisSha256': analysis_sha,
                'claims': claims,
                'stagePromptSha256': stage_prompt_sha,
                'stageContextSha256': context_sha,
            }
            if v3:
                input_payload['executionKind'] = 'manual_attestation'
            input_sha = _manual_hash(input_payload)
        else:
            input_sha = _manual_hash({
                'stage': stage,
                'sourceSha256': source_sha,
                'analysisSha256': analysis_sha,
                'claims': claims,
            })
        item = {
            'status': 'manual_complete',
            'inputSha256': input_sha,
            'outputSha256': analysis_sha,
            'auditSha256': _manual_hash({
                'stage': stage,
                'claims': claims,
                'auditSha256': audit_sha,
                'stageInputSha256': input_sha,
            }),
            'attempts': 2,
            'reviewedClaims': claims,
        }
        state = {'status': 'manual_complete'}
        if hardened:
            item.update({
                'protocol': 'manual-offline-review-v1',
                'promptSource': f'prompts/{stage}.md',
                'promptSha256': stage_prompt_sha,
            })
            if context_sha:
                item['contextSha256'] = context_sha
            state.update({
                'protocol': 'manual-offline-review-v1',
                'promptSource': item['promptSource'],
                'promptSha256': stage_prompt_sha,
            })
            if v3:
                item['executionKind'] = 'manual_attestation'
                state['executionKind'] = 'manual_attestation'
        evidence[stage] = item
        stages[stage] = state
    takeover = {
        'version': 2,
        'mode': 'manual_complete',
        'agent': 'Codex',
        'basis': 'full_text',
        'sourceSha256': source_sha,
        'promptSha256': prompt_sha,
        'analysisSha256': analysis_sha,
        'completedAt': completed_at or ('2026-08-25T12:00:00.000+08:00' if hardened else '2026-08-21T12:00:00.000+08:00'),
        'reason': '基于受控全文完成两轮人工审校并记录逐阶段证据。',
        'review': {
            'sourceVerified': True,
            'analysisContractVerified': True,
            'scoringVerified': True,
            'stageEvidenceVerified': True,
        },
        'evidenceLedger': ledger,
        'evidenceLedgerSha256': _manual_hash(ledger),
        'audit': audit,
        'stageEvidence': evidence,
    }
    if v3:
        takeover['manualAuthoringPromptSha256'] = hashlib.sha256(b'manual authoring prompt').hexdigest()
    manifest = {
        'version': 1,
        'contracts': {'manualDepth': 'full-text-evidence-v3'} if v3 else {},
        'sourceAcquisition': {'sourceSha256': source_sha},
        'stages': stages,
        'manualTakeover': takeover,
    }
    paper = {
        'arxivId': '2608.99999',
        'analysis': analysis,
        'sourceSha256': source_sha,
        'imageManifest': image_manifest,
    }
    return paper, manifest


def manual_result_claim_fixture(
        value, *, method='完整方法', source_method='full system',
        baseline='强基线', source_baseline='strong baseline'):
    source_quote = (
        f'On LibriSpeech test-clean, {source_method} versus {source_baseline} '
        f'reports WER {value} percent; lower is better.'
    )
    return {
        'datasetOrSetting': 'LibriSpeech',
        'splitOrCondition': 'test-clean',
        'method': method,
        'baseline': baseline,
        'metric': 'WER',
        'value': value,
        'unit': '%',
        'direction': '越低越好',
        'sourceQuote': source_quote,
        'sourceBindings': {
            'datasetOrSetting': 'LibriSpeech',
            'splitOrCondition': 'test-clean',
            'method': source_method,
            'baseline': source_baseline,
            'metric': 'WER',
            'value': str(value),
            'unit': 'percent',
            'direction': 'lower is better',
        },
        'readerBindings': {
            'datasetOrSetting': 'LibriSpeech',
            'splitOrCondition': 'test-clean',
            'method': method,
            'baseline': baseline,
            'metric': 'WER',
            'value': f'{value}%',
            'unit': f'{value}%',
            'direction': '越低越好',
        },
    }


class PublishCommonSanitizerTest(unittest.TestCase):
    def test_manual_binding_single_character_whitelist_matches_node(self):
        claim = manual_result_claim_fixture('7.1')
        claim['sourceQuote'] += ' unit % direction ↓'
        claim['sourceBindings']['unit'] = '%'
        claim['sourceBindings']['direction'] = '↓'
        self.assertIsNone(_validate_manual_result_claim_bindings(
            claim, 'sourceBindings', claim['sourceQuote'], 'fixture',
        ))
        for field, fragment in (('unit', 'x'), ('direction', '→')):
            invalid = copy.deepcopy(claim)
            invalid['sourceQuote'] += f' {fragment}'
            invalid['sourceBindings'][field] = fragment
            self.assertIn('至少 2 个非空白字符', _validate_manual_result_claim_bindings(
                invalid, 'sourceBindings', invalid['sourceQuote'], 'fixture',
            ))

    def test_manual_v4_reader_lexical_boundaries_and_node_parity(self):
        safe = '''## 核心摘要
系统把标签统一成同一条件；唯一分层用于二分类。目标具有有界项与有限状态，功能能否启用取决于输入，性能能够稳定复现。
模型真实运行 2 次，并分别记录每次运行的计算成本。
'''
        self.assertIsNone(validate_manual_editorial_quality_v4(safe))
        blocked = {
            '五成': '命中率达到五成。',
            '三比二': '类别比例为三比二。',
            '七十亿主干': '系统使用七十亿主干。',
            'ＲＡＮＫ＝八': 'ＲＡＮＫ＝八。',
            '三 GPU 小时': '系统训练三 GPU 小时。',
            '三 mac': '计算开销为三 mac。',
            '三 TOKEN': '输入长度为三 TOKEN。',
            '三 gb': '显存占用为三 gb。',
            '三至五': '评分范围为三至五等级。',
        }
        for token, sentence in blocked.items():
            with self.subTest(token=token):
                issue = validate_manual_editorial_quality_v4(f'## 核心摘要\n{sentence}\n')
                self.assertIsNotNone(issue)
                self.assertIn('精确定量', issue)
        semantic_issue = validate_manual_editorial_quality_v4(
            '## 核心摘要\n长度分组没有消除长上下文的 2 次计算成本。\n',
        )
        self.assertIn('重复或断裂连接表达', semantic_issue)

        malformed_relations = (
            '“听懂内容”区别于能辨别音频质量。',
            '参数高效区别于推理廉价。',
            '客服文本区别于自发客服通话。',
            '素材池规模 5400/4800/4200 区别于题量。',
            '源音频虽来自多数据集，仍区别于真实通话场景。',
        )
        for sentence in malformed_relations:
            with self.subTest(sentence=sentence):
                issue = validate_manual_editorial_quality_v4(
                    f'## 核心摘要\n{sentence}\n',
                )
                self.assertIsNotNone(issue)
                self.assertIn('断裂连接表达', issue)
        legal_comparisons = '''## 核心摘要
方案 A 区别于方案 B；slimmable 共享网络区别于 3 个独立网络。
'''
        self.assertIsNone(validate_manual_editorial_quality_v4(legal_comparisons))

    def test_manual_v4_final_reader_gate_covers_non_core_sections(self):
        cases = {
            '作者与机构': '作者团队包含三人。',
            '毒舌点评': '系统尚尚缺少真实部署证据。',
            '开源详情': '提供Whisper权重。',
        }
        for heading, sentence in cases.items():
            with self.subTest(heading=heading):
                issue = validate_manual_editorial_quality_v4(
                    f'## {heading}\n{sentence}\n',
                )
                self.assertIsNotNone(issue)

    def test_manual_v4_blocks_numeric_spacing_and_fixed_word_damage(self):
        blocked = (
            '该实验包括5个场景。',
            '模型训练50轮。',
            '指标提升19.5个百分点。',
            '误差从81.7降至81.0。',
            '论文发现T=2已足够。',
            '下1步比较同1组数据。',
            '下1 步比较同1 张表。',
            '另 1 个分支追踪哪1 层。',
            '8个候选再归1组合。',
            '芯片功耗约4.9mW。',
            '模型从公开的T=4初始化。',
            '方法与3 种基线比较。',
            '第2 个消融在0.25 MHz执行5 次。',
            '4B 和9B权重，阈值0.96门控并采用3D记忆。',
            '女性256 次发射；官方158 例；模型在2026年完成。',
            '系统根据注意力 一次性保留缓存。',
            '系统一次性 删除全部缓存。',
        )
        for sentence in blocked:
            with self.subTest(sentence=sentence):
                issue = validate_manual_editorial_quality_v4(
                    f'## 核心摘要\n{sentence}\n',
                )
                self.assertIsNotNone(issue)
                self.assertIn('数值排版或固定词损坏', issue)
        safe = (
            '## 核心摘要\n'
            'Qwen2 音频模型与 GPT-4o 比较；arXiv 2608.22072 报告 81.7%，小数为 0.2158。\n'
            '该模型进入前10%，准确率提升19.5%。\n\n'
            '该实验包括 5 个场景，训练 50 轮，提升 19.5 个百分点；误差从 81.7 降至 81.0。\n'
            '第 1 个分支使用 1 张表；变量 T=2 的条件与 Qwen2 模型都写清楚。\n'
            'Qwen2.5-7B-Instruct 与 6-DoF 控制均作为合法技术标识。\n'
            '系统根据注意力一次性保留缓存。\n'
        )
        self.assertIsNone(validate_manual_editorial_quality_v4(safe))

    def test_manual_v4_blocks_rendered_and_implicit_innovation_double_numbering(self):
        rendered = '## 核心创新点\n1. 首要贡献说明机制。\n2. 第 2 个增量说明证据。\n'
        self.assertIn('双重编号', validate_manual_editorial_quality_v4(rendered))

        implicit = '## 核心创新点\n首要贡献说明机制。\n\n第 2 个增量说明证据。\n'
        self.assertIn('自动渲染为列表', validate_manual_editorial_quality_v4(implicit))

        legal_prose = '## 核心摘要\n正文比较第 2 个条件与基线，并说明该序数只用于定位实验条件。\n'
        self.assertIsNone(validate_manual_editorial_quality_v4(legal_prose))

    def test_digest_index_reader_quality_is_marked_and_historical_compatible(self):
        valid = '''---
paper_digest_page_type: index
paper_digest_reader_quality: "reader-facing-v1"
---
# 论文速递

## ⚡ 今日概览

共分析 3 篇论文。

## 📋 论文列表

### Paper A

该论文讨论流式识别的误差与延迟权衡。

| 排名 | 论文 | 总分 | 分档 |
| --- | --- | --- | --- |
| 1 | Paper A | 10.0 | 前10% |
'''
        self.assertIsNone(validate_digest_index_reader_quality(valid, required=True))
        glued_score = valid.replace('| 10.0 | 前10% |', '| 10.0分 | 前10% |')
        self.assertIn('数值排版或固定词损坏', validate_digest_index_reader_quality(glued_score))
        bad = valid.replace('共分析 3 篇', '共分析三篇')
        self.assertIn('精确定量', validate_digest_index_reader_quality(bad))
        historical = bad.replace(
            'paper_digest_reader_quality: "reader-facing-v1"\n', '',
        )
        self.assertIsNone(validate_digest_index_reader_quality(historical))
        self.assertIn('协议标记', validate_digest_index_reader_quality(historical, required=True))

    def test_manual_v4_reader_view_preserves_blank_lines_before_headings(self):
        markdown = '''---
title: "Reader page"
---

上一节的收束段落。


   ### 📊 实验结果

这是实验段落。

### 🚨 局限与问题

这是局限段落。
'''
        reader_view = _manual_v4_reader_view(markdown)
        self.assertIn('上一节的收束段落。\n\n\n## 实验结果\n', reader_view)
        self.assertIn('这是实验段落。\n\n## 局限与问题\n', reader_view)

    def test_final_manual_v4_markdown_rechecks_sanitized_reader_contracts(self):
        url = 'https://arxiv.org/html/2608.29999/figure1.png'
        valid = f'''---
title: "Reader page"
paper_digest_manual_depth: "full-text-evidence-v4"
---

### 📌 核心摘要

本文检验流式识别在固定测试划分中的错误率与速度权衡，并把结论限制在论文实际报告的设置内。

### 🏗️ 方法概述和架构

编码器接收声学特征，经分块注意力与对齐目标产生逐帧表示，解码器再输出文字序列。

承接分块注意力的信号流，下图用于观察编码器、对齐目标与解码器之间的箭头关系。

![Streaming architecture]({url})

图中箭头显示声学特征先进入编码器，再由对齐目标连接解码器；该结构仅说明已绘制的数据流，不能证明未报告的训练阶段。

### 💡 核心创新点

相较固定上下文基线，该方法把分块状态与对齐监督联合起来，并由测试集上的错误率变化提供直接证据。

### 📊 实验结果

在 LibriSpeech test-clean 上，WER 越低越好；关键比较问题是完整方法相对强基线能降低多少识别错误，以及收益是否带来速度代价。表中保留主方法、强基线、参考系统与关键消融。

| 方法 / 设置 | LibriSpeech WER↓ | RTF↓ |
|---|---:|---:|
| 强基线 | 8.4% | 0.72 |
| 完整方法 | 7.1% | 0.81 |
| 去掉对齐损失（消融） | 7.9% | 0.79 |

完整方法相比强基线把 WER 降低 1.3 个百分点，但 RTF 上升 0.09；消融只恢复部分收益，而且这些差异仅适用于该测试划分，不能外推到未测语言。

### 🔬 细节详述

训练采用论文披露的数据划分与优化目标；没有报告的硬件吞吐不能从准确率结果反推。

### ⚖️ 评分理由

清晰度理由只评价章节组织、符号和表格表达，可复现性理由只评价训练配置与缺失硬件信息。

### 🚨 局限与问题

证据覆盖单一测试划分，尚未报告跨语言迁移，因此当前数字不能说明其他语料上的统一收益。
'''
        sanitized = sanitize_markdown_for_publish(valid)
        self.assertIsNone(validate_final_manual_v4_markdown(sanitized))
        self.assertIsNone(validate_final_manual_v4_markdown(sanitized.replace(
            '训练采用论文披露的数据划分与优化目标',
            '这一步承接上一步，下一步逐项核对每一步；训练采用论文披露的数据划分与优化目标',
            1,
        )))

        summary_sentence = '本文检验流式识别在固定测试划分中的错误率与速度权衡，并把结论限制在论文实际报告的设置内。'
        innovation_sentence = '相较固定上下文基线，该方法把分块状态与对齐监督联合起来，并由测试集上的错误率变化提供直接证据。'
        duplicate_paragraph = '这段复核文字完整说明固定测试划分、相同解码预算与未测语言边界，重复出现时必须由最终页面门禁直接阻断。'
        duplicate_case = sanitized.replace(
            '\n### ⚖️ 评分理由',
            f'\n\n{duplicate_paragraph}\n\n{duplicate_paragraph}\n\n### ⚖️ 评分理由',
            1,
        )
        self.assertEqual(duplicate_case.count(duplicate_paragraph), 2)
        cases = {
            '图片叙事': sanitized.replace('下图用于观察', '下图展示'),
            '结论的条件或边界': sanitized.replace(
                '；该结构仅说明已绘制的数据流，不能证明未报告的训练阶段。',
                '，并完整展示编码器到解码器的数据流关系。',
            ),
            'evidence-rich 表格': sanitized.replace(
                '| 方法 / 设置 | LibriSpeech WER↓ | RTF↓ |',
                '| 方法 / 设置 | 结果 | 含义 |',
            ),
            '阿拉伯数字': sanitized.replace('固定测试划分', '百分之五的固定测试划分', 1),
            '三十个': sanitized.replace('固定测试划分', '三十个固定测试划分', 1),
            '十轮': sanitized.replace(
                '清晰度理由只评价章节组织、符号和表格表达',
                '清晰度理由只评价十轮训练、章节组织、符号和表格表达',
                1,
            ),
            '一半': sanitized.replace('固定测试划分', '至少一半样本来自固定测试划分', 1),
            '排名第三': sanitized.replace('强基线', '排名第三的强基线', 1),
            '批量模板句式': sanitized.replace('下图用于观察', '下图用于核对', 1),
            '段落以分号中断': sanitized.replace(
                '训练采用论文披露的数据划分与优化目标；没有报告的硬件吞吐不能从准确率结果反推。',
                '训练采用论文披露的数据划分与优化目标；\n\n没有报告的硬件吞吐不能从准确率结果反推。',
            ),
            '中英文技术词边界': sanitized.replace('编码器接收', '编码器使用Conformer接收', 1),
            '能能': sanitized.replace('编码器接收', '编码器的功能能接收', 1),
            '段落过载': sanitized.replace(
                summary_sentence, '这段文字用于验证最终页面长段门禁是否仍然生效。' * 30,
            ),
            '完全重复': duplicate_case,
            '重复长句': sanitized.replace(
                innovation_sentence,
                summary_sentence + ' 另一句再补充创新机制的局部说明。',
            ),
        }
        for expected, candidate in cases.items():
            with self.subTest(expected=expected):
                self.assertIn(expected, validate_final_manual_v4_markdown(candidate))

        v4_paper = {
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v4'},
            },
            'selectedImageUrls': [url],
            'parsed': {'documentType': '方法研究'},
        }
        self.assertIn('缺少 Manual v4 深度标记', validate_final_manual_v4_markdown(
            sanitized.replace(
                'paper_digest_manual_depth: "full-text-evidence-v4"\n', '',
            ),
            v4_paper,
        ))

        self.assertIsNone(validate_final_manual_v4_markdown(
            sanitized.replace(
                'paper_digest_manual_depth: "full-text-evidence-v4"',
                'paper_digest_manual_depth: "full-text-evidence-v3"',
            ).replace('下图用于观察', '下图展示')
        ))

    def test_final_manual_v4_rechecks_authoritative_claims_after_image_exclusion(self):
        url = 'https://arxiv.org/html/2608.29999/figure1.png'
        excluded_url = 'https://arxiv.org/html/2608.29999/figure2.png'
        markdown = f'''---
title: "Reader page"
paper_digest_manual_depth: "full-text-evidence-v4"
---

### 📌 核心摘要

本文检验流式识别在固定测试划分中的错误率与速度权衡，并把结论限制在论文实际报告的设置内。

### 🏗️ 方法概述和架构

编码器接收声学特征，经分块注意力与对齐目标产生逐帧表示，解码器再输出文字序列。

承接分块注意力的信号流，下图用于观察编码器、对齐目标与解码器之间的箭头关系。

![Streaming architecture]({url})

图中箭头显示声学特征先进入编码器，再由对齐目标连接解码器；该结构仅说明已绘制的数据流，不能证明未报告的训练阶段。

### 💡 核心创新点

相较固定上下文基线，该方法把分块状态与对齐监督联合起来，并由测试集上的错误率变化提供直接证据。

### 📊 实验结果

在 LibriSpeech test-clean 上，WER 越低越好；关键比较问题是完整方法相对强基线能降低多少识别错误，以及收益是否带来速度代价。表中保留主方法、强基线、参考系统与关键消融。

| 方法 / 设置 | LibriSpeech WER↓ | RTF↓ |
|---|---:|---:|
| 强基线 | 8.4% | 0.72 |
| 完整方法 | 7.1% | 0.81 |
| 去掉对齐损失（消融） | 7.9% | 0.79 |

完整方法相比强基线把 WER 降低 1.3 个百分点，但 RTF 上升 0.09；消融只恢复部分收益，而且这些差异仅适用于该测试划分，不能外推到未测语言。

### 🔬 细节详述

训练采用论文披露的数据划分与优化目标；没有报告的硬件吞吐不能从准确率结果反推。

### 🚨 局限与问题

证据覆盖单一测试划分，尚未报告跨语言迁移，因此当前数字不能说明其他语料上的统一收益。
'''
        def bind_to_result_table(claim):
            value = str(claim['value'])
            claim['readerBindings'] = {
                'datasetOrSetting': 'LibriSpeech',
                'splitOrCondition': 'LibriSpeech WER↓',
                'method': claim['method'],
                'baseline': claim['baseline'],
                'metric': 'WER↓',
                'value': f'{value}%',
                'unit': f'{value}%',
                'direction': 'LibriSpeech WER↓',
            }
            return claim

        claims = [
            bind_to_result_table(manual_result_claim_fixture(
                value,
                method=method,
                source_method=source_method,
                baseline=baseline,
                source_baseline=source_baseline,
            ))
            for value, method, source_method, baseline, source_baseline in (
                ('7.1', '完整方法', 'full system', '强基线', 'strong baseline'),
                ('8.4', '强基线', 'strong baseline', '强基线', 'strong baseline'),
                ('6.8', '完整方法', 'full system', '强基线', 'strong baseline'),
            )
        ]
        paper = {
            'arxivId': '2608.29999',
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v4'},
                'manualTakeover': {
                    'documentType': '方法研究',
                    'resultClaims': claims,
                },
            },
            'selectedImageUrls': [url],
            'publishImageExclusions': [{'url': excluded_url}],
            'parsed': {'documentType': '方法研究'},
        }
        issue = validate_final_manual_v4_markdown(markdown, paper)
        self.assertIn('resultClaims 读者可见闭环无效', issue)
        self.assertIn('readerBindings 未共同落在', issue)

        passing = copy.deepcopy(paper)
        passing['analysisManifest']['manualTakeover']['resultClaims'][2] = \
            bind_to_result_table(manual_result_claim_fixture('7.9'))
        self.assertIsNone(validate_final_manual_v4_markdown(markdown, passing))

        no_ablation_markdown = markdown.replace(
            '主方法、强基线、参考系统与关键消融',
            '主方法、强基线与参考系统',
        ).replace(
            '去掉对齐损失（消融）', '参考系统',
        ).replace(
            '；消融只恢复部分收益', '；参考系统只恢复部分收益',
        )
        non_result_ablation = copy.deepcopy(paper)
        non_result_ablation['analysisManifest']['manualTakeover']['resultClaims'][2] = \
            bind_to_result_table(manual_result_claim_fixture(
                '7.9', method='参考系统', source_method='reference system',
            ))
        non_result_ablation['analysis'] = _manual_v4_reader_view(
            no_ablation_markdown,
        ).replace(
            '编码器接收声学特征，经分块注意力与对齐目标产生逐帧表示，解码器再输出文字序列。',
            '编码器接收声学特征，经分块注意力与对齐目标产生逐帧表示，解码器再输出文字序列。论文没有提供逐组件消融。',
            1,
        )
        self.assertIsNone(validate_final_manual_v4_markdown(
            no_ablation_markdown, non_result_ablation,
        ))


    def test_context_bound_image_contract_matches_plan_and_adjacent_prose(self):
        url = 'https://arxiv.org/html/2608.29999/figure1.png'
        lead = '承接 LibriSpeech test-clean 的流式解码比较，下图用于观察不同块长对应的 WER 曲线。'
        explanation = '图中曲线显示不同块长的 WER 差异；该证据只覆盖 test-clean，不能说明其他语料的流式延迟。'
        paper = {
            'analysis': f'''## 实验结果
正文先提出 test-clean 上块长与流式解码误差的比较。

{lead}

![WER curves]({url})

{explanation}

下一段据此收束 test-clean 的结论，并保留延迟边界。''',
            'selectedImageUrls': [url],
            'imageManifest': {
                'insertionPlan': [{
                    'imageNumber': 1,
                    'lead': lead,
                    'explanation': explanation,
                }],
                'insertionDiagnostics': [{'imageNumber': 1, 'inserted': True}],
            },
        }
        self.assertIsNone(validate_image_narrative_contract(paper))

        generic = copy.deepcopy(paper)
        generic_lead = '下图展示论文的关键实验比较；读图时需同时保留正文列出的数据集、指标方向和实验条件。'
        generic_explanation = '这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论。'
        generic['analysis'] = generic['analysis'].replace(lead, generic_lead).replace(explanation, generic_explanation)
        generic['imageManifest']['insertionPlan'][0]['lead'] = generic_lead
        generic['imageManifest']['insertionPlan'][0]['explanation'] = generic_explanation
        self.assertIn('通用模板', validate_image_narrative_contract(generic))

        tampered = copy.deepcopy(paper)
        tampered['analysis'] = tampered['analysis'].replace('不同块长的 WER 差异', '完全不同的图后说明')
        self.assertIn('没有与已审计插图计划精确闭环', validate_image_narrative_contract(tampered))

    def test_context_bound_image_contract_binds_order_and_each_url_to_its_plan(self):
        first_url = 'https://arxiv.org/html/2608.29999/figure1.png'
        second_url = 'https://arxiv.org/html/2608.29999/figure2.png'
        first_lead = '承接编码器的数据流，下图用于观察输入特征如何进入第 1 个声学模块。'
        first_explanation = '图中箭头显示特征进入第 1 个声学模块；该结构仅覆盖已画出的连接，不能证明其他训练分支。'
        second_lead = '承接测试集上的比较，下图用于观察第 2 组 WER 曲线如何随噪声变化。'
        second_explanation = '图中曲线显示第 2 组 WER 随噪声改变；该证据只覆盖当前测试集，不能外推到其他设备。'

        def block(url, lead, explanation, alt):
            return f'{lead}\n\n![{alt}]({url})\n\n{explanation}'

        paper = {
            'analysis': '\n\n'.join((
                '## 方法概述和架构\n方法正文先说明输入、组件和输出之间的连接。',
                block(first_url, first_lead, first_explanation, 'Architecture'),
                '## 实验结果\n实验正文先说明数据集、基线和指标方向。',
                block(second_url, second_lead, second_explanation, 'WER curves'),
            )),
            'selectedImageUrls': [first_url, second_url],
            'imageManifest': {
                'version': 2,
                'selected': [
                    {'index': 1, 'url': first_url},
                    {'index': 2, 'url': second_url},
                ],
                'downloaded': [],
                'insertionPlan': [
                    {'imageNumber': 1, 'lead': first_lead, 'explanation': first_explanation},
                    {'imageNumber': 2, 'lead': second_lead, 'explanation': second_explanation},
                ],
                'insertionDiagnostics': [
                    {'imageNumber': 1, 'inserted': True},
                    {'imageNumber': 2, 'inserted': True},
                ],
            },
        }
        self.assertIsNone(validate_image_narrative_contract(paper))

        swapped_urls = copy.deepcopy(paper)
        swapped_urls['analysis'] = swapped_urls['analysis'] \
            .replace(first_url, '__FIRST__') \
            .replace(second_url, first_url) \
            .replace('__FIRST__', second_url)
        self.assertIn('URL/顺序', validate_image_narrative_contract(swapped_urls))

        swapped_prose = copy.deepcopy(paper)
        swapped_prose['analysis'] = '\n\n'.join((
            '## 方法概述和架构\n方法正文先说明输入、组件和输出之间的连接。',
            block(first_url, second_lead, second_explanation, 'Architecture'),
            '## 实验结果\n实验正文先说明数据集、基线和指标方向。',
            block(second_url, first_lead, first_explanation, 'WER curves'),
        ))
        self.assertIn('相邻正文没有与已审计插图计划精确闭环',
                      validate_image_narrative_contract(swapped_prose))

    def test_manual_v4_publish_result_claims_require_three_nonempty_source_bound_numbers(self):
        analysis = '''## 实验结果
在 LibriSpeech test-clean 上，完整方法相对强基线的 WER 为 7.1%，指标越低越好。强基线相对参考系统的 WER 为 8.4%，指标越低越好。消融版本相对完整方法的 WER 为 7.9%，指标越低越好。'''
        claims = [
            manual_result_claim_fixture(
                value,
                method=method,
                source_method=source_method,
                baseline=baseline,
                source_baseline=source_baseline,
            )
            for value, method, source_method, baseline, source_baseline in (
                ('7.1', '完整方法', 'full system', '强基线', 'strong baseline'),
                ('8.4', '强基线', 'strong baseline', '参考系统', 'reference system'),
                ('7.9', '消融版本', 'ablated system', '完整方法', 'full system'),
            )
        ]
        takeover = {'documentType': '方法研究', 'resultClaims': claims}
        self.assertEqual(
            _validate_manual_v4_result_claims(takeover, analysis, 'fixture'), claims,
        )

        too_few = copy.deepcopy(takeover)
        too_few['resultClaims'] = too_few['resultClaims'][:2]
        with self.assertRaisesRegex(PublishDataValidationError, '至少需要 3 条'):
            _validate_manual_v4_result_claims(too_few, analysis, 'fixture')

        empty = copy.deepcopy(takeover)
        empty['resultClaims'][0]['baseline'] = ''
        with self.assertRaisesRegex(PublishDataValidationError, 'baseline 缺失'):
            _validate_manual_v4_result_claims(empty, analysis, 'fixture')

        quote_drift = copy.deepcopy(takeover)
        quote_drift['resultClaims'][0]['sourceQuote'] = 'The full system improves recognition.'
        with self.assertRaisesRegex(PublishDataValidationError, 'sourceBindings'):
            _validate_manual_v4_result_claims(quote_drift, analysis, 'fixture')

        mixed_not_reported = copy.deepcopy(takeover)
        mixed_not_reported['resultClaims'][0]['unit'] = 'notReported 7.1'
        with self.assertRaisesRegex(PublishDataValidationError, '不得把 notReported 与数值混写'):
            _validate_manual_v4_result_claims(mixed_not_reported, analysis, 'fixture')

        body_drift = copy.deepcopy(takeover)
        body_drift['resultClaims'][0]['value'] = '6.8'
        body_drift['resultClaims'][0] = manual_result_claim_fixture('6.8')
        with self.assertRaisesRegex(PublishDataValidationError, '未共同落在'):
            _validate_manual_v4_result_claims(body_drift, analysis, 'fixture')

        invalid_direction = copy.deepcopy(takeover)
        invalid_direction['resultClaims'][0]['direction'] = '越快越好'
        with self.assertRaisesRegex(PublishDataValidationError, '方向语义'):
            _validate_manual_v4_result_claims(invalid_direction, analysis, 'fixture')

        scalar_not_reported = copy.deepcopy(takeover)
        scalar_not_reported['resultClaims'][0]['unit'] = '未报告'
        with self.assertRaisesRegex(PublishDataValidationError, '必须使用.*notReported'):
            _validate_manual_v4_result_claims(scalar_not_reported, analysis, 'fixture')

        duplicate = copy.deepcopy(takeover)
        duplicate['resultClaims'][1] = copy.deepcopy(duplicate['resultClaims'][0])
        with self.assertRaisesRegex(PublishDataValidationError, '重复'):
            _validate_manual_v4_result_claims(duplicate, analysis, 'fixture')

        missing_binding_field = copy.deepcopy(takeover)
        del missing_binding_field['resultClaims'][0]['readerBindings']['metric']
        with self.assertRaisesRegex(PublishDataValidationError, '必须且只能包含'):
            _validate_manual_v4_result_claims(missing_binding_field, analysis, 'fixture')

        qualitative_claims = copy.deepcopy(takeover)
        qualitative_analysis = analysis + ' 定性结果不可得，只保留论文报告的失败方向。'
        for claim in qualitative_claims['resultClaims']:
            claim['value'] = {
                'notReported': True,
                'reason': '正文仅给出定性失败方向，没有报告可核对标量',
            }
            claim['sourceQuote'] += ' The qualitative result is unavailable.'
            claim['sourceBindings']['value'] = 'qualitative result'
            claim['readerBindings']['value'] = '定性结果不可得'
        with self.assertRaisesRegex(PublishDataValidationError, '实证论文.*至少需要 1 条'):
            _validate_manual_v4_result_claims(
                qualitative_claims, qualitative_analysis, 'fixture',
            )

    def test_manual_v2_publish_provenance_is_cryptographically_closed(self):
        paper, manifest = manual_v2_fixture(hardened=True)
        _validate_manual_takeover_manifest(paper, manifest, 'fixture')

        cases = []
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['agent'] = ''
        cases.append(('agent', candidate, 'agent 缺失'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['sourceSha256'] = 'c' * 64
        cases.append(('source', candidate, 'sourceSha256 与全文来源不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['completedAt'] = '2026-08-25T12:00:00Z'
        cases.append(('completedAt', candidate, 'completedAt 必须为北京时间'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['reason'] = '过短'
        cases.append(('reason', candidate, 'reason 过短'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['review']['stageEvidenceVerified'] = False
        cases.append(('review', candidate, 'review 未确认'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['inputSha256'] = 'c' * 64
        cases.append(('input', candidate, 'inputSha256 闭环校验失败'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['auditSha256'] = 'c' * 64
        cases.append(('audit', candidate, 'auditSha256 闭环校验失败'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['outputSha256'] = 'c' * 64
        cases.append(('output', candidate, 'outputSha256 与最终正文 SHA 不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['promptSource'] = 'prompts/wrong.md'
        cases.append(('prompt source', candidate, 'promptSource 与阶段 manifest 不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['promptSha256'] = 'c' * 64
        cases.append(('prompt sha', candidate, 'promptSha256 与阶段 manifest 不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['protocol'] = 'manual-unknown'
        cases.append(('protocol', candidate, 'protocol 与阶段协议不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['imageDownload']['contextSha256'] = 'c' * 64
        cases.append(('context', candidate, 'contextSha256 与 imageManifest.downloadEvidenceSha256 不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[0]['imageManifest']['downloadOutcomes'].append({'url': 'https://example.com/tampered.png', 'status': 'complete'})
        cases.append(('image context hash', candidate, 'imageManifest.downloadEvidenceSha256 闭环校验失败'))

        for label, (candidate_paper, candidate_manifest), message in cases:
            with self.subTest(label=label), self.assertRaisesRegex(PublishDataValidationError, message):
                _validate_manual_takeover_manifest(candidate_paper, candidate_manifest, 'fixture')

    def test_manual_v2_legacy_migration_boundary_keeps_2026_08_21_only(self):
        paper, manifest = manual_v2_fixture(hardened=False)
        _validate_manual_takeover_manifest(paper, manifest, 'legacy fixture')

        newer_paper, newer_manifest = manual_v2_fixture(
            hardened=False,
            completed_at='2026-08-22T00:00:00.000+08:00',
        )
        with self.assertRaisesRegex(PublishDataValidationError, '逐阶段 prompt/context 绑定'):
            _validate_manual_takeover_manifest(newer_paper, newer_manifest, 'newer legacy fixture')

    def test_manual_v3_publish_provenance_binds_authoring_images_and_execution_kind(self):
        paper, manifest = manual_v2_fixture(hardened=True, v3=True)
        _validate_manual_takeover_manifest(paper, manifest, 'v3 fixture')

        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['manualAuthoringPromptSha256'] = None
        with self.assertRaisesRegex(PublishDataValidationError, 'manualAuthoringPromptSha256'):
            _validate_manual_takeover_manifest(*candidate, 'v3 fixture')

        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['executionKind'] = 'llm_api'
        with self.assertRaisesRegex(PublishDataValidationError, 'executionKind'):
            _validate_manual_takeover_manifest(*candidate, 'v3 fixture')

        candidate = copy.deepcopy((paper, manifest))
        candidate[0]['imageManifest']['insertionDiagnostics'].append({'url': 'https://example.com/tampered.png'})
        with self.assertRaisesRegex(PublishDataValidationError, 'selectionEvidenceSha256'):
            _validate_manual_takeover_manifest(*candidate, 'v3 fixture')

    def test_manual_v4_requires_evidence_rich_table_contract_without_retroactive_v3_change(self):
        paper, manifest = manual_v2_fixture(hardened=True, v3=True)
        _validate_manual_takeover_manifest(paper, manifest, 'historical v3 fixture')

        manifest['contracts']['manualDepth'] = 'full-text-evidence-v4'
        manifest['contracts']['experimentTables'] = EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION
        with self.assertRaisesRegex(
                PublishDataValidationError,
                'manual v4 必须声明 experimentTables=evidence-rich-v2'):
            _validate_manual_takeover_manifest(paper, manifest, 'v4 fixture')

    def test_shared_publish_date_validation_rejects_impossible_dates(self):
        self.assertEqual(get_today_bj('2026-07-13'), '2026-07-13')
        for value in ('2026-02-30', '2026-7-3', 'not-a-date'):
            with self.subTest(value=value), self.assertRaises(PublishDataValidationError):
                get_today_bj(value)

    def test_default_channel_snapshot_missing_manifest_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'missing-generation.json'
            with self.assertRaisesRegex(PublishDataValidationError, '缺少同日博客 generation manifest'):
                select_blog_published_snapshot(
                    [{'arxivId': '2607.00001'}],
                    '2026-07-13',
                    manifest_path=missing,
                )

    def test_type_aware_analysis_and_publish_meta(self):
        analysis = '''## 评分
6.0/10

## 机器摘要
document_type: tech report
rank_bucket: 前50%
confidence: 中

## 标签
#语音识别 #Transformer
'''
        parsed = parse_analysis(analysis)
        self.assertEqual(parsed['documentType'], '系统技术报告')
        self.assertEqual(parsed['scoringRubricVersion'], 'type-aware-v1')
        meta = build_paper_meta(parsed)
        self.assertIn('文档类型：系统技术报告', meta)
        self.assertIn('评分置信度：中', meta)

    def test_python_tag_roles_match_node_primary_task_and_method_rules(self):
        benchmark = '''## 评分
6.0/10

## 机器摘要
document_type: benchmark
primary_task_tag: #模型评估
primary_method_tag: #基准测试

## 标签
#模型评估 #基准测试 #音频理解
主任务标签：#模型评估
主方法标签：#基准测试
'''
        parsed = parse_analysis(benchmark)
        self.assertEqual(parsed['primaryTaskTag'], '#音频理解')
        self.assertEqual(parsed['primaryMethodTag'], '#模型评估')

        foundation = benchmark.replace(
            '#模型评估 #基准测试 #音频理解',
            '#统一音频模型 #音频大模型 #音频理解',
        ).replace('primary_task_tag: #模型评估', 'primary_task_tag: #统一音频模型')
        parsed = parse_analysis(foundation)
        self.assertEqual(parsed['primaryTaskTag'], '#音频理解')
        self.assertEqual(parsed['primaryMethodTag'], '#统一音频模型')

    def test_empty_links_and_duplicate_alts(self):
        text = '![图]()\n![same](a.png)\n![same](b.png)\n[空]()'
        fixed = dedupe_image_alts(fix_empty_markdown_links(text))
        self.assertIn('![图](image_not_available)', fixed)
        self.assertIn('![same](a.png)', fixed)
        self.assertIn('![same - 图2](b.png)', fixed)
        self.assertIn('空', fixed)
        self.assertNotIn('[空]()', fixed)

    def test_remote_paper_images_link_to_full_resolution_without_double_wrapping(self):
        image = '![方法总览](https://arxiv.org/html/2608.00001v1/method.png)'
        linked = link_remote_images_to_original(image)
        self.assertEqual(
            linked,
            '[![方法总览](https://arxiv.org/html/2608.00001v1/method.png)]'
            '(https://arxiv.org/html/2608.00001v1/method.png)',
        )
        self.assertEqual(link_remote_images_to_original(linked), linked)

    def test_remote_paper_image_with_escaped_brackets_is_clickable(self):
        image = (
            r'![T-SNE from LLaMA-2-7B \[5\]]'
            r'(https://arxiv.org/html/2608.24209v1/figures/T-sne.png)'
        )
        linked = link_remote_images_to_original(image)
        self.assertEqual(linked, f'[{image}]'
                         '(https://arxiv.org/html/2608.24209v1/figures/T-sne.png)')
        self.assertEqual(link_remote_images_to_original(linked), linked)

    def test_arxiv_visible_degree_and_tex_fallback_are_not_both_published(self):
        for caption in (
            r'prediction is overlaid on the 360∘360^{\circ} frames',
            r'prediction is overlaid on the 360∘360^{\\circ} frames',
        ):
            self.assertEqual(
                normalize_arxiv_math_double_extraction(caption),
                'prediction is overlaid on the 360° frames',
            )

    def test_strip_raw_inline_html(self):
        self.assertEqual(strip_raw_inline_html('A <u>under</u> B'), 'A under B')
        self.assertEqual(strip_raw_inline_html('A <b>x</b> B'), 'A x B')

    def test_escape_html_like_tags_preserves_generated_scoring_containers(self):
        text = '<details>\n<summary>评分理由</summary>\n<task>paper token</task>\n</details>'
        fixed = escape_html_like_tags(text)
        self.assertIn('<details>', fixed)
        self.assertIn('<summary>评分理由</summary>', fixed)
        self.assertIn('</details>', fixed)
        self.assertIn('`<task>`paper token</task>', fixed)

    def test_yaml_unbalanced_quotes(self):
        text = '---\ntitle: "Bad title\n---\nbody'
        fixed = fix_yaml_unbalanced_quotes(text)
        self.assertIn('title: "Bad title"', fixed)

    def test_sanitize_markdown_for_publish_combines_rules(self):
        text = (
            '---\ntitle: "Bad\n---\n<u>x</u>\n![same](a.png)\n![same](b.png)\n'
            '[empty]()\n配�置\n[A_METHOD] 方法证据\n[SCORING_SOURCE_RESULTS] 实验证据\n'
            '[SCORING_SOURCE_13/28] 编号证据'
        )
        upstream = text
        fixed = sanitize_markdown_for_publish(text)
        self.assertNotIn('<u>', fixed)
        self.assertIn('![same - 图2](b.png)', fixed)
        self.assertNotIn('[empty]()', fixed)
        self.assertIn('title: "Bad"', fixed)
        self.assertIn('配置', fixed)
        self.assertNotIn('�', fixed)
        self.assertNotIn('[A_METHOD]', fixed)
        self.assertNotIn('[SCORING_SOURCE_RESULTS]', fixed)
        self.assertNotIn('[SCORING_SOURCE_13/28]', fixed)
        self.assertIn('方法证据', fixed)
        self.assertIn('实验证据', fixed)
        self.assertIn('[A_METHOD]', upstream)
        self.assertIn('[SCORING_SOURCE_RESULTS]', upstream)

    def test_publish_llm_api_routing(self):
        self.assertEqual(
            detect_publish_api_type('https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5'),
            'anthropic'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1'),
            'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.kimi.com/coding/v1', 'kimi-for-coding'),
            'anthropic'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.kimi.com/coding/', 'k3'),
            'anthropic'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://api.kimi.com/coding/v1'),
            'https://api.kimi.com/coding/v1/messages'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://api.kimi.com/coding/'),
            'https://api.kimi.com/coding/v1/messages'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.deepseek.com/anthropic', 'deepseek-chat'),
            'openai'
        )
        self.assertEqual(
            build_publish_api_url('openai', 'https://api.deepseek.com/anthropic'),
            'https://api.deepseek.com/v1/chat/completions'
        )

    def test_publish_llm_endpoint_requires_https_except_explicit_loopback(self):
        self.assertEqual(
            validate_publish_api_endpoint_url('https://api.example.com/v1').hostname,
            'api.example.com',
        )
        allowed_http = (
            'http://localhost:8080/v1',
            'http://worker.localhost:8080/v1',
            'http://127.0.0.42:8080/v1',
            'http://[::1]:8080/v1',
        )
        for endpoint in allowed_http:
            with self.subTest(endpoint=endpoint):
                self.assertEqual(
                    build_publish_api_url('openai', endpoint),
                    f'{endpoint}/chat/completions',
                )

        rejected = (
            'http://api.example.com/v1',
            'http://0.0.0.0:8080/v1',
            'ftp://127.0.0.1/v1',
            'https://user:password@api.example.com/v1',
            'api.example.com/v1',
        )
        for endpoint in rejected:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                build_publish_api_url('openai', endpoint)

    def test_primary_public_http_endpoint_is_rejected_before_credential_headers(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'http://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.build_publish_headers') as build_headers, \
                mock.patch('urllib.request.Request') as request:
            with self.assertRaisesRegex(PublishLLMUnavailable, 'endpoint 配置不安全'):
                call_publish_llm_api('inspect', required=True, max_retries=1)
        build_headers.assert_not_called()
        request.assert_not_called()

    def test_secondary_public_http_endpoint_is_rejected_before_credential_headers(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
            'PAPER_ANALYZER_SECONDARY_API_KEY': 'secondary-key',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'http://vision.example.com/v1',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.build_publish_headers') as build_headers, \
                mock.patch('urllib.request.Request') as request:
            with self.assertRaisesRegex(PublishLLMUnavailable, 'endpoint 配置不安全'):
                call_publish_llm_api(
                    'inspect', required=True, use_secondary=True, max_retries=1,
                )
        build_headers.assert_not_called()
        request.assert_not_called()

    def test_publish_anthropic_headers_include_claude_version(self):
        headers = build_publish_headers('anthropic', 'key', claude_version='9.8.7')
        self.assertEqual(headers['User-Agent'], 'claude-cli/9.8.7 (external, cli)')

    def test_publish_openai_headers_override_urllib_user_agent(self):
        headers = build_publish_headers('openai', 'key')
        self.assertEqual(headers['User-Agent'], 'audio-paper-digest/1.0')
        self.assertEqual(headers['Authorization'], 'Bearer key')

    def test_publish_multimodal_payload_preserves_protocol_routing(self):
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        anthropic = build_publish_payload(
            'anthropic', 'mimo', 'review', 100, 0.1, images=[image]
        )
        blocks = anthropic['messages'][0]['content']
        self.assertEqual(blocks[0]['type'], 'image')
        self.assertEqual(blocks[0]['source']['data'], 'cG5n')
        self.assertEqual(blocks[-1], {'type': 'text', 'text': 'review'})

        openai = build_publish_payload(
            'openai', 'gpt', 'review', 100, 0.1, images=[image]
        )
        blocks = openai['messages'][0]['content']
        self.assertEqual(blocks[0], {'type': 'text', 'text': 'review'})
        self.assertEqual(blocks[1]['type'], 'image_url')
        self.assertTrue(blocks[1]['image_url']['url'].startswith('data:image/png;base64,'))

    def test_secondary_publish_llm_uses_secondary_model_with_primary_endpoint_and_key_fallback(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'{"choices":[{"message":{"content":"ok"}}]}'
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
                images=[{'media_type': 'image/png', 'data': 'cG5n'}],
            )
        self.assertEqual(result, 'ok')
        request = opener.open.call_args.args[0]
        payload = json.loads(request.data.decode('utf-8'))
        self.assertEqual(request.full_url, 'https://api.example.com/v1/chat/completions')
        self.assertEqual(request.get_header('Authorization'), 'Bearer primary-key')
        self.assertEqual(payload['model'], 'vision-model')

    def test_empty_length_response_adapts_output_budget_before_retry(self):
        first = mock.Mock()
        first.status = 200
        first.read.return_value = (
            b'{"choices":[{"message":{"content":"",'
            b'"reasoning_content":"hidden reasoning"},"finish_reason":"length"}]}'
        )
        first.__enter__ = mock.Mock(return_value=first)
        first.__exit__ = mock.Mock(return_value=False)

        second = mock.Mock()
        second.status = 200
        second.read.return_value = b'{"choices":[{"message":{"content":"{\\"passed\\":true}"}}]}'
        second.__enter__ = mock.Mock(return_value=second)
        second.__exit__ = mock.Mock(return_value=False)

        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'reasoning-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep'):
            result = call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=2,
            )

        self.assertEqual(result, '{"passed":true}')
        requests = [call.args[0] for call in opener.open.call_args_list]
        payloads = [json.loads(request.data.decode('utf-8')) for request in requests]
        self.assertEqual(payloads[0]['max_tokens'], 4000)
        self.assertEqual(payloads[1]['max_tokens'], 8000)

    def test_structured_reasoning_exhaustion_has_one_bounded_json_retry(self):
        responses = []
        for _index in range(2):
            response = mock.Mock()
            response.status = 200
            response.read.return_value = (
                b'{"choices":[{"message":{"content":"",'
                b'"reasoning_content":"hidden reasoning"},"finish_reason":"length"}]}'
            )
            response.__enter__ = mock.Mock(return_value=response)
            response.__exit__ = mock.Mock(return_value=False)
            responses.append(response)

        opener = mock.Mock()
        opener.open.side_effect = responses
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'reasoning-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep') as sleep, \
                self.assertRaises(PublishLLMUnavailable):
            call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=5,
                structured_output=True,
            )

        self.assertEqual(opener.open.call_count, 2)
        requests = [call.args[0] for call in opener.open.call_args_list]
        payloads = [json.loads(request.data.decode('utf-8')) for request in requests]
        self.assertEqual([payload['max_tokens'] for payload in payloads], [4000, 8000])
        self.assertNotIn('立即停止展开推理', payloads[0]['messages'][0]['content'])
        self.assertIn('立即停止展开推理', payloads[1]['messages'][0]['content'])
        sleep.assert_not_called()

    def test_kimi_anthropic_reasoning_response_uses_same_bounded_json_retry(self):
        first = mock.Mock()
        first.status = 200
        first.read.return_value = (
            b'{"content":[{"type":"thinking","thinking":"hidden reasoning"}],'
            b'"stop_reason":"max_tokens"}'
        )
        first.__enter__ = mock.Mock(return_value=first)
        first.__exit__ = mock.Mock(return_value=False)

        second = mock.Mock()
        second.status = 200
        second.read.return_value = (
            b'{"content":[{"type":"text","text":"{\\"passed\\":true,\\"issues\\":[]}"}],'
            b'"stop_reason":"end_turn"}'
        )
        second.__enter__ = mock.Mock(return_value=second)
        second.__exit__ = mock.Mock(return_value=False)

        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.kimi.com/coding/v1',
            'PAPER_ANALYZER_MODEL': 'kimi-k2',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.get_claude_code_version', return_value='9.8.7'), \
                mock.patch('publish_common.time.sleep') as sleep:
            result = call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=5,
                structured_output=True,
            )

        self.assertEqual(result, '{"passed":true,"issues":[]}')
        self.assertEqual(opener.open.call_count, 2)
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(requests[0].full_url, 'https://api.kimi.com/coding/v1/messages')
        payloads = [json.loads(request.data.decode('utf-8')) for request in requests]
        self.assertEqual([payload['max_tokens'] for payload in payloads], [4000, 8000])
        self.assertIn('立即停止展开推理', payloads[1]['messages'][0]['content'])
        sleep.assert_not_called()

    def test_required_secondary_publish_llm_does_not_fallback_to_primary_model(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
        }
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(PublishLLMUnavailable, 'PAPER_ANALYZER_SECONDARY_MODEL'):
                call_publish_llm_api('inspect', required=True, use_secondary=True)

    def test_required_publish_llm_without_key_fails(self):
        names = ('PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_ENDPOINT', 'PAPER_ANALYZER_MODEL')
        old = {name: os.environ.get(name) for name in names}
        try:
            os.environ.pop('PAPER_ANALYZER_API_KEY', None)
            with self.assertRaises(PublishLLMUnavailable):
                call_publish_llm_api('hello', required=True, context='test')
        finally:
            for name, value in old.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_publish_llm_requires_endpoint_and_model_instead_of_using_foreign_defaults(self):
        names = ('PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_ENDPOINT', 'PAPER_ANALYZER_MODEL')
        old = {name: os.environ.get(name) for name in names}
        try:
            os.environ['PAPER_ANALYZER_API_KEY'] = 'provider-specific-key'
            os.environ.pop('PAPER_ANALYZER_ENDPOINT', None)
            os.environ.pop('PAPER_ANALYZER_MODEL', None)
            with self.assertRaises(PublishLLMUnavailable) as raised:
                call_publish_llm_api('hello', required=True, context='test')
            self.assertIn('PAPER_ANALYZER_ENDPOINT', str(raised.exception))
            self.assertIn('PAPER_ANALYZER_MODEL', str(raised.exception))
        finally:
            for name, value in old.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_only_error_review_issues_block_publish(self):
        self.assertEqual(
            count_blocking_review_issues([
                {'severity': 'warning'},
                {'severity': 'info'},
                {'severity': 'error'}
            ]),
            1
        )
        self.assertEqual(count_blocking_review_issues(['代码层硬问题']), 1)

    def test_load_papers_accepts_object_or_list_and_rejects_bad_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            object_file = os.path.join(tmp, 'object.json')
            list_file = os.path.join(tmp, 'list.json')
            bad_file = os.path.join(tmp, 'bad.json')

            with open(object_file, 'w', encoding='utf-8') as f:
                json.dump({'papers': [{'arxivId': '2607.00001'}]}, f)
            with open(list_file, 'w', encoding='utf-8') as f:
                json.dump([{'arxivId': '2607.00002'}], f)
            with open(bad_file, 'w', encoding='utf-8') as f:
                json.dump({'papers': {'bad': True}}, f)

            with contextlib.redirect_stdout(io.StringIO()):
                object_papers = load_papers(object_file)
                list_papers = load_papers(list_file)
            self.assertEqual(object_papers[0]['arxivId'], '2607.00001')
            self.assertEqual(list_papers[0]['arxivId'], '2607.00002')
            with self.assertRaises(ValueError):
                load_papers(bad_file)

    def test_paper_batch_date_prefers_immutable_batch_and_validates_legacy_timestamp(self):
        self.assertEqual(
            paper_batch_date({
                'arxivId': '2607.00001',
                'fetchBatchDate': '2026-07-13',
                'fetchedAt': '2026-07-14T00:00:00.000+08:00',
            }),
            '2026-07-13',
        )
        self.assertEqual(
            paper_batch_date({'fetchedAt': '2026-07-13T10:00:00.000+08:00'}),
            '2026-07-13',
        )
        with self.assertRaisesRegex(PublishDataValidationError, '严格北京时间戳'):
            paper_batch_date({'arxivId': 'bad', 'fetchedAt': '2026-07-13T02:00:00.000Z'})

    def test_publish_preflight_requires_complete_consistent_scoring(self):
        paper = complete_paper()
        validated = validate_papers_for_publish([paper])
        self.assertEqual(validated[0]['parsed']['score'], '7.0')
        self.assertEqual(validated[0]['parsed']['tags'], ['#语音识别', '#Transformer'])

        incomplete = copy.deepcopy(paper)
        incomplete['parsed'].pop('engineeringScore')
        with self.assertRaisesRegex(PublishDataValidationError, 'engineeringScore'):
            resolve_publish_parsed(incomplete)

    def test_publish_preflight_rejects_partial_scoring_reason(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('* 工程/实践价值 (1.5/1.5)：具体理由充分\n', '')
        with self.assertRaisesRegex(PublishDataValidationError, '评分维度|工程/实践价值'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_rejects_dimension_without_reason(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('* 创新性 (1/2)：具体理由充分', '* 创新性 (1/2)')
        with self.assertRaisesRegex(PublishDataValidationError, '创新性.*缺少具体评分理由'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_requires_explicit_manual_override_provenance(self):
        paper = complete_paper()
        paper['parsed']['engineeringScore'] = '1'
        paper['parsed']['score'] = '6.5'
        with self.assertRaisesRegex(PublishDataValidationError, 'parsedOverride'):
            resolve_publish_parsed(paper)

        paper['parsedOverride'] = {
            'type': 'manual',
            'source': 'editor:francis/review-2026-07-10',
            'reason': '人工复核后调整工程价值',
            'fields': ['engineeringScore', 'score'],
        }
        parsed = resolve_publish_parsed(paper)
        self.assertEqual(parsed['score'], '6.5')

    def test_publish_baseline_ignores_stale_cached_body_fields(self):
        paper = complete_paper()
        paper['parsed']['summary'] = '陈旧摘要不得发布'
        paper['parsed']['tags'] = {'invalid': '陈旧标签缓存也必须被忽略'}
        paper['parsed']['results'] = '陈旧实验结果'
        parsed = resolve_publish_parsed(paper)
        self.assertNotEqual(parsed.get('summary'), '陈旧摘要不得发布')
        self.assertEqual(parsed['tags'], ['#语音识别', '#Transformer'])
        self.assertNotEqual(parsed.get('results'), '陈旧实验结果')

    def test_manual_override_rejects_unknown_metadata_and_non_scoring_fields(self):
        paper = complete_paper()
        paper['parsed']['summary'] = '人工摘要'
        paper['parsedOverride'] = {
            'type': 'manual',
            'source': 'editor:test',
            'reason': 'test',
            'fields': ['summary'],
        }
        with self.assertRaisesRegex(PublishDataValidationError, '不允许覆盖'):
            resolve_publish_parsed(paper)

        paper = complete_paper()
        paper['parsed']['score'] = '6.5'
        paper['parsed']['engineeringScore'] = '1'
        paper['parsedOverride'] = {
            'type': 'manual',
            'source': 'editor:test',
            'reason': 'test',
            'fields': ['score', 'engineeringScore'],
            'unknown': True,
        }
        with self.assertRaisesRegex(PublishDataValidationError, '未知字段'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_requires_matching_top_level_version(self):
        paper = complete_paper()
        paper['scoringRubricVersion'] = 'legacy'
        with self.assertRaisesRegex(PublishDataValidationError, '顶层 scoringRubricVersion'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_rejects_duplicate_normalized_arxiv_ids(self):
        first = complete_paper()
        first['arxivId'] = 'https://arxiv.org/abs/2607.00001v2'
        second = complete_paper()
        second['arxivId'] = 'arXiv:2607.00001'
        with self.assertRaisesRegex(PublishDataValidationError, '重复 normalized arXiv ID 2607.00001'):
            validate_papers_for_publish([first, second])

    def test_publish_preflight_blocks_unapproved_abstract_fallback_and_latest_failure(self):
        paper = complete_paper()
        paper['analysisSource'] = 'abstract'
        with self.assertRaisesRegex(PublishDataValidationError, '仅基于摘要分析'):
            validate_papers_for_publish([paper])

        paper['allowAbstractAnalysisPublish'] = True
        self.assertEqual(len(validate_papers_for_publish([paper])), 1)

        paper = complete_paper()
        paper['latestAnalysisAttemptError'] = '全文重分析失败'
        with self.assertRaisesRegex(PublishDataValidationError, '最新一次深度分析失败'):
            validate_papers_for_publish([paper])

    def test_publish_preflight_rejects_present_but_incomplete_analysis_manifest(self):
        paper = complete_paper()
        complete_statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        paper['analysisManifest'] = {
            'version': 1,
            'stages': {name: {'status': status} for name, status in complete_statuses.items()},
        }
        self.assertEqual(len(validate_papers_for_publish([paper])), 1)
        paper['analysisManifest']['stages']['scoringAudit']['status'] = 'transient_failure'
        with self.assertRaisesRegex(PublishDataValidationError, 'scoringAudit'):
            validate_papers_for_publish([paper])

    def test_versioned_publish_preflight_enforces_bounded_experiment_tables(self):
        headers = ['方法', '数据集'] + [f'M{i}' for i in range(1, 9)]
        separator = ['---'] * len(headers)
        rows = [
            [f'Model {i}', 'test'] + [str(i + j) for j in range(8)]
            for i in range(13)
        ]
        table = '\n'.join(
            f"| {' | '.join(row)} |" for row in [headers, separator, *rows]
        )
        paper = complete_paper()
        paper['analysis'] += f'\n\n## 实验结果\n{table}\n'
        paper['parsed'] = parse_analysis(paper['analysis'])
        statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        paper['analysisManifest'] = {
            'version': 1,
            'contracts': {'experimentTables': EXPERIMENT_TABLE_CONTRACT_VERSION},
            'stages': {name: {'status': status} for name, status in statuses.items()},
        }

        self.assertEqual(len(extract_markdown_tables(table)), 1)
        self.assertEqual(len(extract_markdown_tables(f'```markdown\n{table}\n```')), 0)
        self.assertRegex(validate_experiment_table_contract(paper['analysis']), '13 个数据行')
        with self.assertRaisesRegex(PublishDataValidationError, '表格契约无效'):
            validate_papers_for_publish([paper])

        legacy = copy.deepcopy(paper)
        del legacy['analysisManifest']['contracts']
        self.assertEqual(len(validate_papers_for_publish([legacy])), 1)

        mismatch = '| 方法 | 指标 |\n| --- | --- |\n| A | 1 | 多余 |'
        self.assertRegex(validate_experiment_table_contract(
            paper['analysis'].replace(table, mismatch)
        ), '数据行有 3 列')
        one_cell = '| 方法 | 指标 |\n| --- | --- |\n| only |'
        self.assertRegex(validate_experiment_table_contract(
            paper['analysis'].replace(table, one_cell)
        ), '数据行有 1 列')

    def test_evidence_rich_table_contract_rejects_summary_cards_and_checks_narrative(self):
        valid = '''## 实验结果
关键比较问题是完整方法相对强基线能降低多少识别错误，以及收益是否带来速度代价。表中保留主方法、最强基线与关键消融。

| 方法 / 设置 | LibriSpeech WER↓ | RTF↓ |
|---|---:|---:|
| 强基线 | 8.4% | 0.72 |
| 完整方法 | 7.1% | 0.81 |
| 去掉对齐损失（消融） | 7.9% | 0.79 |

完整方法相比强基线把 WER 降低 1.3 个百分点，但 RTF 上升 0.09；消融只恢复部分收益，而且这些差异仅适用于该测试划分，不能外推到未测语言。
'''
        self.assertIsNone(validate_experiment_table_contract(
            valid,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
        ))
        with_inserted_figure = valid.replace(
            '表中保留主方法、最强基线与关键消融。\n\n| 方法 / 设置 |',
            '表中保留主方法、最强基线与关键消融。\n\n'
            '如下图用于解释方法结构。\n\n![方法图](https://example.com/method.png)\n\n'
            '图后说明只负责结构，不替代表格数字。\n\n| 方法 / 设置 |',
        )
        self.assertIsNone(validate_experiment_table_contract(
            with_inserted_figure,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
        ))
        vague = valid.replace(
            '| 方法 / 设置 | LibriSpeech WER↓ | RTF↓ |',
            '| 方法 / 设置 | 结果 | 含义 |',
        )
        self.assertRegex(validate_experiment_table_contract(
            vague,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
        ), '叙述型伪指标列')
        self.assertIsNone(validate_experiment_table_contract(
            vague,
            contract_version=EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
        ))

        no_table = '''## 实验结果
完整方法在固定测试集上优于强基线，但正文没有保留可读的 Markdown 证据表。'''
        self.assertRegex(validate_experiment_table_contract(
            no_table,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='4 Experiments\nTable 2 reports the main comparison.\n5 Conclusion',
        ), '至少一张可读 Markdown 证据表')
        self.assertIsNone(validate_experiment_table_contract(
            no_table,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='4 Experiments\nThe paper reports prose-only results.\n5 Conclusion',
        ))

    def test_evidence_rich_table_accepts_training_stage_identifier_column(self):
        template = '''## 实验结果
关键比较问题是不同训练阶段是否持续降低词错误率，以及后期联合训练的收益是否仍受固定测试条件约束。

| {identifier} | WER↓ |
|---|---:|
| 预热 | 12.4% |
| 对齐 | 10.8% |
| 联合训练 | 9.7% |

联合训练相比预热阶段把 WER 降低 2.7 个百分点，但该方向只由同一测试划分支持，不能外推到未测语言或设备；论文也没有报告跨域置信区间、在线吞吐或长期稳定性测量。
'''
        for identifier in (
                '训练阶段', '解码', '上下文', '指标', '度量', '算法',
                'decoder context', 'metric measure', 'algorithm'):
            with self.subTest(identifier=identifier):
                self.assertIsNone(validate_experiment_table_contract(
                    template.format(identifier=identifier),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                ))

    def test_evidence_rich_source_gates_accept_natural_chinese_comparisons(self):
        def analysis_with(conclusion):
            return f'''## 实验结果
关键比较问题是三种配置在固定测试集上的 WER 差异多大，并核验模型配置改变是否影响结果方向。

| 配置 | WER↓ |
|---|---:|
| A | 12.4% |
| B | 10.8% |
| C | 9.7% |

{conclusion}；同时，这组数字只适用于固定测试划分和相同解码预算，跨语言结论仍需额外验证，论文也没有报告在线吞吐、长期稳定性或跨域置信区间。
'''

        cases = (
            ('The paper compared with Naive RAG.', '方案 C 比 Naive RAG 更强，却也更脆'),
            ('消融实验比较含年龄信息与不含年龄信息的配置。', '配置 C 不含年龄信息，配置 B 排除说话人上下文'),
        )
        for source_text, conclusion in cases:
            with self.subTest(conclusion=conclusion):
                self.assertIsNone(validate_experiment_table_contract(
                    analysis_with(conclusion),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                    source_text=source_text,
                ))
        neutral = analysis_with('配置 C 的报告值为 9.7%，其余条件保持一致')
        self.assertRegex(validate_experiment_table_contract(
            neutral,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='The paper compared with Naive RAG.',
        ), '没有保留比较对象')
        self.assertRegex(validate_experiment_table_contract(
            neutral,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='正文的消融实验去掉年龄特征。',
        ), '没有保留关键消融')
        self.assertRegex(validate_experiment_table_contract(
            neutral,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='The third configuration fails on the hard subset.',
        ), '没有保留负面证据')

        for negative in (
                '退化', '恶化', '失败', '更差', '比基准差', '未改善',
                '没有改善', '无效', '负面结果', '置信区间跨零', '落后', '可测损失'):
            with self.subTest(negative=negative):
                self.assertIsNone(validate_experiment_table_contract(
                    analysis_with(f'配置 C 出现{negative}'),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                    source_text='The third configuration fails on the hard subset.',
                ))

    def test_versioned_publish_preflight_enforces_detailed_method_contract(self):
        paper = complete_paper()
        self.assertRegex(validate_method_detail_contract(paper['analysis']), '中文字符不足')
        statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        paper['analysisManifest'] = {
            'version': 1,
            'contracts': {'methodDetail': METHOD_DETAIL_CONTRACT_VERSION},
            'stages': {name: {'status': status} for name, status in statuses.items()},
        }
        with self.assertRaisesRegex(PublishDataValidationError, '方法契约无效'):
            validate_papers_for_publish([paper])

    def test_required_review_payload_fails_closed_on_malformed_contract(self):
        for payload in (
            [],
            {'issues': []},
            {'passed': True},
            {'passed': True, 'issues': [{'severity': 'critical', 'description': 'bad'}]},
            {'passed': False, 'issues': [{'severity': 'warning', 'description': 'unclear'}]},
            {'passed': True, 'issues': [{'severity': 'info', 'description': '无法判断图片是否正确'}]},
        ):
            passed, issues = validate_review_payload(payload, required=True, context='test')
            self.assertFalse(passed)
            self.assertEqual(count_blocking_review_issues(issues), 1)

    def test_required_review_payload_accepts_valid_warning(self):
        passed, issues = validate_review_payload({
            'passed': True,
            'issues': [{'severity': 'warning', 'description': 'style'}],
        }, required=True, context='test')
        self.assertTrue(passed)
        self.assertEqual(count_blocking_review_issues(issues), 0)

    def test_non_auto_fixable_issue_may_omit_empty_fix_instruction(self):
        passed, issues = validate_review_payload({
            'passed': False,
            'issues': [{
                'severity': 'error',
                'type': 'content',
                'description': '图片与正文论点不匹配',
                'auto_fixable': False,
            }],
        }, required=True, context='test', issue_fields=('type', 'auto_fixable', 'fix_instruction'))
        self.assertFalse(passed)
        self.assertEqual(issues[0]['fix_instruction'], '')

    def test_publish_score_keeps_one_decimal_place(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('7.0/10', '6.0/10').replace(
            '工程/实践价值 (1.5/1.5)',
            '工程/实践价值 (0.5/1.5)',
        )
        paper['parsed'] = parse_analysis(paper['analysis'])
        paper['scoringRubricVersion'] = paper['parsed']['scoringRubricVersion']
        resolved = resolve_publish_parsed(paper)
        self.assertEqual(resolved['score'], '6.0')

    def test_publish_rejects_multi_decimal_and_non_anchor_scores(self):
        paper = complete_paper()
        paper['parsed'] = copy.deepcopy(paper['parsed'])
        paper['parsed']['innovationScore'] = 1.01
        with self.assertRaisesRegex(PublishDataValidationError, '最多只能有一位小数'):
            validate_papers_for_publish([paper])

        paper = complete_paper()
        paper['parsed'] = copy.deepcopy(paper['parsed'])
        paper['parsed']['openSourceScore'] = 0.7
        paper['parsed']['score'] = 7.7
        paper['parsedOverride'] = {
            'type': 'manual_scoring_correction',
            'source': '人工复核论文正文',
            'reason': '根据公开资源状态修正评分字段',
            'fields': ['openSourceScore', 'score'],
        }
        with self.assertRaisesRegex(PublishDataValidationError, '固定锚点集合'):
            validate_papers_for_publish([paper])

    def test_build_paper_meta_deduplicates_equal_primary_tags(self):
        meta = build_paper_meta({
            'score': '6.0',
            'primaryTaskTag': '#多模态模型',
            'primaryMethodTag': '#多模态模型',
            'tags': ['#多模态模型', '#数据集'],
        })
        self.assertEqual(meta.count('#多模态模型'), 1)
        self.assertEqual(meta.count('#数据集'), 1)


if __name__ == '__main__':
    unittest.main()

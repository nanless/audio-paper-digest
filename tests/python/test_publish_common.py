import os
import sys
import contextlib
import copy
import hashlib
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from tag_catalog import (
    TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_PROMPT_TEXT_CONTRACT,
    TAG_SELECTION_CONTRACT, LEGACY_TAG_SELECTION_CONTRACT,
    load_tag_catalog, tag_prompt_text_sha256,
)

from tag_stage_record import (TAG_STAGE_RECORD_CONTRACT,
                              TAG_STAGE_BINDING_FIELDS as CURRENT_TAG_STAGE_BINDING_FIELDS,
                              LEGACY_TAG_STAGE_BINDING_FIELDS, read_tag_stage_record)
from publish_common import (  # noqa: E402
    LlmAccountPoolConfigError,
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
    fix_latex_delimiters,
    METHOD_DETAIL_CONTRACT_VERSION,
    extract_markdown_tables,
    fix_extraction_diacritic_damage,
    fix_empty_markdown_links,
    fix_yaml_unbalanced_quotes,
    get_today_bj,
    link_remote_images_to_original,
    normalize_arxiv_math_double_extraction,
    load_papers,
    parse_publish_arxiv_identity,
    paper_batch_date,
    call_publish_llm_api,
    count_blocking_review_issues,
    resolve_publish_parsed,
    sanitize_markdown_for_publish,
    escape_statistical_significance_stars,
    escape_technical_notation_asterisks,
    strip_internal_scoring_anchors,
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
    _PUBLISH_TAG_CATALOG,
    _PUBLISH_TAG_PROMPT_TEXT_SHA256,
    _mask_classification_fields,
    _hash_tag_section_and_primary_tags,
    _validate_tag_stage_record,
    _validate_tag_catalog_upgrade,
    _classify_registry_change,
    _destructive_reasons_hash,
    _acknowledgement_eligibility,
    _manual_paper_identity_mode,
    _manual_editorial_prose_paragraphs,
    _manual_han_character_count,
    _manual_numeric_lexemes,
    _manual_v4_reader_view,
    _open_publish_json_with_account_pool,
    _final_markdown_image_occurrences,
    _validate_manual_result_claim_bindings,
    _validate_manual_v4_result_claims,
    _validate_manual_v5_all_rejected_images,
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
primary_task_tag: #语音识别
primary_method_tag: #Transformer

## 标签
#语音识别 #Transformer #低资源
主任务标签：#语音识别
主方法标签：#Transformer
补充标签：#低资源

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


def attach_tag_stage_record(paper, manifest, *, input_analysis=None, status='not_needed',
                         with_checkpoints=False,
                         prompt_text_contract=TAG_PROMPT_TEXT_CONTRACT, record_format='legacy',
                         selection_contract=TAG_SELECTION_CONTRACT):
    stage_key = 'tagSelection' if record_format == 'current' else 'taxonomySeal'
    hash_key = 'tagSectionAndPrimaryTagsSha256' if record_format == 'current' else 'taxonomySurfaceSha256'
    output_analysis = paper['analysis']
    input_analysis = output_analysis if input_analysis is None else input_analysis
    parsed = parse_analysis(output_analysis, tag_catalog=_PUBLISH_TAG_CATALOG)
    selection = parsed['tagValidation']
    input_sha = hashlib.sha256(input_analysis.encode('utf-8')).hexdigest()
    output_sha = hashlib.sha256(output_analysis.encode('utf-8')).hexdigest()
    masked_input_analysis_sha256 = hashlib.sha256(
        _mask_classification_fields(input_analysis).encode('utf-8')).hexdigest()
    masked_output_analysis_sha256 = hashlib.sha256(
        _mask_classification_fields(output_analysis).encode('utf-8')).hexdigest()
    binding = {
        'registryVersion': _PUBLISH_TAG_CATALOG['version'],
        'registrySha256': _PUBLISH_TAG_CATALOG['registrySha256'],
        'projectionContract': prompt_text_contract,
        'projectionSha256': tag_prompt_text_sha256(
            _PUBLISH_TAG_CATALOG, prompt_text_contract),
        'selectionContract': selection_contract,
        'inputAnalysisSha256': input_sha,
        'outputAnalysisSha256': output_sha,
        'inputProtectedProjectionSha256': masked_input_analysis_sha256,
        'outputProtectedProjectionSha256': masked_output_analysis_sha256,
        hash_key: _hash_tag_section_and_primary_tags(output_analysis),
        'primaryTaskId': selection['primaryTaskId'],
        'primaryMethodId': selection['primaryMethodId'],
        'conceptIds': selection['conceptIds'],
    }
    if record_format == 'current':
        manifest.setdefault('contracts', {})['tagSelectionRecord'] = TAG_STAGE_RECORD_CONTRACT
    else:
        manifest.setdefault('contracts', {})['taxonomy'] = selection_contract
    manifest.setdefault('stages', {}).setdefault('structureRepair', {})[
        'outputAnalysisSha256'] = input_sha
    manifest.setdefault('stages', {})[stage_key] = {
        'status': status,
        'fingerprint': '1' * 64,
        **binding,
        'bindingSha256': _manual_hash(binding),
    }
    core_summary = manifest['stages'].setdefault('coreSummaryRepair', {
        'status': 'not_needed',
    })
    core_summary['inputAnalysisSha256'] = output_sha
    core_summary['outputAnalysisSha256'] = output_sha
    manifest['stages'].setdefault('scoringAudit', {'status': 'complete'})[
        'coreSummaryInputAnalysisSha256'] = output_sha
    paper['analysisStageCheckpoints'] = {
        stage_key: output_analysis,
        **({'structureRepair': input_analysis} if with_checkpoints else {}),
    }
    return manifest['stages'][stage_key]


# 以下为旧格式标签阶段绑定哈希使用的十三个字段，字段名和顺序与发布检查及 Node 一致。
TAG_STAGE_BINDING_FIELDS = (
    'registryVersion', 'registrySha256', 'projectionContract',
    'projectionSha256', 'selectionContract', 'inputAnalysisSha256',
    'outputAnalysisSha256', 'inputProtectedProjectionSha256',
    'outputProtectedProjectionSha256', 'taxonomySurfaceSha256',
    'primaryTaskId', 'primaryMethodId', 'conceptIds',
)


def cross_end_fixture():
    with open(os.path.join(ROOT, 'tests', 'fixtures',
                           'registry-upgrade-cross-end.json'), encoding='utf-8') as handle:
        return json.load(handle)


def rebind_tag_stage_record(stage, *, registry_sha256=None, annotation=None,
                         drop_annotation=False, projection_sha256=None, concept_ids=None):
    """修改测试中的标签阶段记录后，按本辅助函数使用的十三个字段重新计算 bindingSha256。"""
    if registry_sha256 is not None:
        stage['registrySha256'] = registry_sha256
        snapshot_path = Path(ROOT) / 'config' / 'tag-catalog-history' / f'{registry_sha256}.json'
        if snapshot_path.is_file():
            stage['registryVersion'] = load_tag_catalog(snapshot_path)['version']
    if concept_ids is not None:
        stage['conceptIds'] = concept_ids
    if drop_annotation:
        stage.pop('registryUpgradeFrom', None)
    elif annotation is not None:
        annotation = copy.deepcopy(annotation)
        if annotation.get('toRegistrySha256') == cross_end_fixture()['currentRegistrySha256']:
            annotation['toRegistrySha256'] = _PUBLISH_TAG_CATALOG['registrySha256']
            annotation['toRegistryVersion'] = _PUBLISH_TAG_CATALOG['version']
        stage['registryUpgradeFrom'] = annotation
    if projection_sha256 is not None:
        stage['projectionSha256'] = projection_sha256
    binding = {field: stage.get(field) for field in TAG_STAGE_BINDING_FIELDS}
    stage['bindingSha256'] = _manual_hash(binding)
    return stage


def normalize_seal_error(value):
    """两端原因排列可能受 localeCompare 的运行环境影响。

    将第一个“（”与最后一个“）”之间的文字按分号拆分、排序，再拼回比较；
    外层括号不保留，括号以外的拒绝说明逐字保留。"""
    if value is None:
        return None
    start = value.find('（')
    end = value.rfind('）')
    if start != -1 and end > start:
        return (value[:start] + '；'.join(sorted(value[start + 1:end].split('；')))
                + value[end + 1:])
    return value


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
    def test_arxiv_identity_preserves_only_explicit_version(self):
        self.assertEqual(parse_publish_arxiv_identity('2609.01234'), {
            'baseId': '2609.01234',
            'version': None,
            'versionedId': None,
            'absUrl': 'https://arxiv.org/abs/2609.01234',
            'pdfUrl': 'https://arxiv.org/pdf/2609.01234.pdf',
        })
        self.assertEqual(
            parse_publish_arxiv_identity('https://arxiv.org/pdf/2609.01234v12.pdf'),
            {
                'baseId': '2609.01234',
                'version': 12,
                'versionedId': '2609.01234v12',
                'absUrl': 'https://arxiv.org/abs/2609.01234v12',
                'pdfUrl': 'https://arxiv.org/pdf/2609.01234v12.pdf',
            },
        )
        for value in ('2609.01234v0', '2609.01234v01', '2609.01234v-1'):
            with self.subTest(value=value), self.assertRaises(PublishDataValidationError):
                parse_publish_arxiv_identity(value)

    def test_latex_history_subscript_preserves_less_than_semantics(self):
        self.assertEqual(
            fix_latex_delimiters(r'\(p(y_i\mid\mathbf{y}_{<i})\)'),
            r'\(p(y_i\mid\mathbf{y}_{\lt i})\)',
        )

    def test_scoring_anchor_removal_repairs_reader_facing_connectors(self):
        self.assertEqual(
            strip_internal_scoring_anchors(
                '逻辑自洽且与 [A_LIMITS] 承认的边界一致，'
                '但 [SCORING_SOURCE_3] 限于 2 个方言。'
            ),
            '逻辑自洽且与论文承认的边界一致，但该结论限于 2 个方言。',
        )

    def test_scoring_anchor_removal_preserves_frontmatter_bytes(self):
        frontmatter = (
            '---\n'
            'paper_digest_one_sentence: "刻画网络认法 的二阶模式"\n'
            '---\n'
        )
        self.assertEqual(
            strip_internal_scoring_anchors(
                frontmatter + '[A_METHOD] 中 文方法'
            ),
            frontmatter + '中文方法',
        )

    def test_manual_paper_identity_mode_only_allows_true_historical_fallback(self):
        self.assertEqual(
            _manual_paper_identity_mode(
                {'manualDepth': 'full-text-evidence-v5'}, 'historical fixture'
            ),
            'historical_per_entry',
        )
        for marker in ('freshAuthoring', 'tutorialPayload'):
            with self.subTest(marker=marker), self.assertRaisesRegex(
                    PublishDataValidationError,
                    '声明了新写作或教程材料记录，但缺少逐篇来源身份记录。'):
                _manual_paper_identity_mode({
                    'manualDepth': 'full-text-evidence-v5',
                    marker: f'{marker}-fixture',
                }, 'fresh fixture')
        self.assertEqual(_manual_paper_identity_mode({
            'manualDepth': 'full-text-evidence-v5',
            'freshAuthoring': 'fresh-authoring-v1',
            'tutorialPayload': 'manual-v5-tutorial-payload-v1',
            'paperSourceIdentity': 'manual-paper-source-identity-v1',
        }), 'per_paper_v1')
        with self.assertRaisesRegex(PublishDataValidationError, '契约标记非法'):
            _manual_paper_identity_mode({
                'paperSourceIdentity': 'manual-paper-source-identity-v0',
            })

    def test_manual_numeric_lexemes_preserve_unsupported_duplicate_decimals(self):
        self.assertEqual(_manual_numeric_lexemes('raw 3.73.7'), ['3.73.7'])
        self.assertEqual(_manual_numeric_lexemes('raw 4.644.64 / 1.751.75'), ['4.644.64', '1.751.75'])
        self.assertEqual(_manual_numeric_lexemes('3.7 3.7'), ['3.7', '3.7'])
        self.assertNotIn('4.64', _manual_numeric_lexemes('4.644.65'))

    def test_manual_result_claim_rejects_unsupported_duplicate_decimal_source_quote(self):
        claim = manual_result_claim_fixture('3.7')
        claim['sourceQuote'] = claim['sourceQuote'].replace('3.7', '3.73.7')
        claim['sourceBindings']['value'] = '3.73.7'
        self.assertIn('3.73.7', claim['sourceQuote'])
        self.assertIn('未覆盖', _validate_manual_result_claim_bindings(
            claim, 'sourceBindings', claim['sourceQuote'], 'fixture',
        ))

    def test_manual_v5_all_reject_images_requires_full_specific_coverage(self):
        urls = [
            'https://example.com/pipeline.png',
            'https://example.com/curve.png',
        ]
        paper = {
            'selectedImageUrls': [],
            'imageManifest': {
                'candidates': [{'url': url} for url in urls],
                'selected': [],
                'insertionPlan': [],
            },
        }
        decisions = [
            {
                'url': urls[0], 'decision': 'reject',
                'reason': '已核对受控缓存 PNG 为 1917×989；手机宽度下完整流程的细字缩小到无法辨认，不能为本篇基准构造的论证提供可独立核对的证据。',
                'captionIdentity': 'Figure 2: pipeline overview',
            },
            {
                'url': urls[1], 'decision': 'reject',
                'reason': 'ResponseTokenCurve 缺少受控缓存，无法对像素或裁图作审计性声明；它不能为本篇关键结果比较提供可独立核对的论证证据。',
                'captionIdentity': 'ResponseTokenCurve diagnostic panel',
            },
        ]
        self.assertIsNone(_validate_manual_v5_all_rejected_images(
            paper, decisions, 'fixture',
        ))
        with self.assertRaisesRegex(PublishDataValidationError, '未逐项覆盖'):
            _validate_manual_v5_all_rejected_images(paper, decisions[:-1], 'fixture')
        generic = copy.deepcopy(decisions)
        generic[0]['reason'] = '图片在移动端不够清晰，因此不建议插入正文；它没有提供比文字更有价值的信息，也不适合在博客中展示。'
        with self.assertRaisesRegex(PublishDataValidationError, '不是论文特有'):
            _validate_manual_v5_all_rejected_images(paper, generic, 'fixture')
        duplicated = copy.deepcopy(decisions)
        duplicated[1]['reason'] = duplicated[0]['reason'].replace('1917×989', '1917 × 989')
        with self.assertRaisesRegex(PublishDataValidationError, '不得跨图复用'):
            _validate_manual_v5_all_rejected_images(paper, duplicated, 'fixture')
        inconsistent = copy.deepcopy(paper)
        inconsistent['imageManifest']['insertionPlan'] = [{'imageNumber': 1}]
        with self.assertRaisesRegex(PublishDataValidationError, '空 insertionPlan'):
            _validate_manual_v5_all_rejected_images(inconsistent, decisions, 'fixture')

    def test_manual_v5_all_reject_images_accepts_js_specific_visual_anchors(self):
        """发布端必须接受与 JS 记录/规格闸门相同的具体锚点。"""
        anchors = ['系统总览', '矩阵', '分布', '公式', '箭头', '分桶']
        urls = [f'https://example.com/{index}.png' for index in range(len(anchors))]
        paper = {
            'selectedImageUrls': [],
            'imageManifest': {
                'candidates': [{'url': url} for url in urls],
                'selected': [],
                'insertionPlan': [],
            },
        }
        decisions = [
            {
                'url': url,
                'decision': 'reject',
                'reason': (
                    f'该{anchor}图只服务于第 {index + 1} 个局部说明，'
                    '与本篇跨条件比较的证据链不对应，因此正文以文字保留其限定关系而不单独插入。'
                ),
            }
            for index, (url, anchor) in enumerate(zip(urls, anchors), start=1)
        ]
        self.assertIsNone(_validate_manual_v5_all_rejected_images(
            paper, decisions, 'fixture',
        ))

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
这一类任务采用声学核心与社会学残差的二分解释，形成有趣二分。
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
        complete_double_contrast = '''## 核心摘要
3 类改写均导致性能下降，但 CodecSep 的回落更平缓且在 2 类上保持小幅领先，说明通道级掩蔽对词汇级变化有一定鲁棒性，但未测试含时序或关系结构的提示。
'''
        self.assertIsNone(validate_manual_editorial_quality_v4(complete_double_contrast))
        dangling = validate_manual_editorial_quality_v4(
            '## 核心摘要\n模型在 2 个数据集上有一定鲁棒性，但\n',
        )
        self.assertIn('悬空连接词', dangling)

    def test_manual_v4_quantity_audit_ignores_headings_and_indefinite_one_phrases(self):
        """让 Python 发布端镜像与 editorial-quality.js 保持一致。"""
        safe_cases = (
            '## 核心摘要\n一个好看的示意图不能替代真实实验，正文仍需给出可核对的比较。\n',
            '## 方法概述和架构\n### 冻结之后仍有一段必须学习\n该段说明冻结模块与可训练模块的职责边界。\n',
            '## 方法概述和架构\n### 从 306 通道到一个词标签\n该小节说明输入映射与输出标签之间的语义关系。\n',
            '## 核心摘要\n该系统在主榜排名第二，辅助榜取得第三名。\n',
        )
        for markdown in safe_cases:
            with self.subTest(markdown=markdown):
                self.assertIsNone(validate_manual_editorial_quality_v4(markdown))

        issue = validate_manual_editorial_quality_v4(
            '## 核心摘要\n系统使用三个公开数据集完成评测。\n',
        )
        self.assertIn('精确定量', issue)

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
paper_digest_reader_quality: "reader-facing-v3"
---
# 论文速递

## ⚡ 今日概览

共分析 3 篇论文。

## 📋 论文列表

### 🥇 [论文 A](/audio-paper-digest-blog/posts/2026-09-02-paper-a)

> 英文题目：*[Paper A](/audio-paper-digest-blog/posts/2026-09-02-paper-a)*

评分：**8.3/10**

排名：前25% | 文档类型：方法研究 | [arXiv 原文](https://arxiv.org/abs/2609.00001)

👥 **作者与机构**

- Author A：Institute A

该论文讨论流式识别的误差与延迟权衡。

| 排名 | 论文 | 总分 | 分档 |
| --- | --- | --- | --- |
| 1 | Paper A | 10.0 | 前10% |
'''
        self.assertIsNone(validate_digest_index_reader_quality(valid, required=True))
        wrong_english = valid.replace(
            '/audio-paper-digest-blog/posts/2026-09-02-paper-a)*',
            '/audio-paper-digest-blog/posts/another-paper)*',
        )
        self.assertIn(
            '中英文论文标题',
            validate_digest_index_reader_quality(wrong_english, required=True),
        )
        old_footer = valid.replace(
            '\n| 排名 | 论文 |',
            '\n🔥 **8.3/10** | 评分置信度：高 | [arxiv](https://arxiv.org/abs/2609.00001)\n\n| 排名 | 论文 |',
        )
        self.assertIn(
            '重复的旧版',
            validate_digest_index_reader_quality(old_footer, required=True),
        )
        glued_score = valid.replace('| 10.0 | 前10% |', '| 10.0分 | 前10% |')
        self.assertIn('数值排版或固定词损坏', validate_digest_index_reader_quality(glued_score))
        bad = valid.replace('共分析 3 篇', '共分析三篇')
        self.assertIn('精确定量', validate_digest_index_reader_quality(bad))
        historical = bad.replace(
            'paper_digest_reader_quality: "reader-facing-v3"\n', '',
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

    def test_final_manual_v5_reader_article_replaces_fixed_v4_sections(self):
        """v5 页面发布的是自定义 readerArticle，不是旧版六列表皮。"""
        v5_markdown = '''---
title: "Reader-first page"
paper_digest_manual_depth: "full-text-evidence-v5"
---

### 📌 核心摘要

本文把实时语音系统中的候选压缩、检索延迟与长期记忆边界放进同一条可审计论证链。

### 🧭 深度解读

### 先解释论文特有的矛盾

这段正文说明系统如何把输入、状态分工、比较证据与不能外推的边界串成连续叙事，而不是回退到固定方法栏目。
'''
        self.assertIsNone(validate_final_manual_v4_markdown(v5_markdown))

        missing_article = v5_markdown.replace('### 🧭 深度解读\n\n', '')
        self.assertIn(
            'Manual v5 读者章节: 深度解读',
            validate_final_manual_v4_markdown(missing_article),
        )

    def test_final_manual_image_occurrences_count_sanitized_self_link_once(self):
        url = 'https://arxiv.org/html/2608.29999/figure1.png'
        markdown = f'''---
title: "Reader page"
paper_digest_manual_depth: "full-text-evidence-v5"
---

### 📌 核心摘要

本文把图示机制和公开证据放进同一条可审计的读者论证链。

### 🧭 深度解读

承接论文实际的数据流，下图用于核对模块关系与图中明示的连接边界。

![Architecture]({url})

图中箭头只支持已绘制的数据流关系，不能证明未报告的训练分支或部署结论。
'''
        paper = {
            'analysisManifest': {'contracts': {'manualDepth': 'full-text-evidence-v5'}},
            'selectedImageUrls': [url],
        }
        sanitized = sanitize_markdown_for_publish(markdown)
        self.assertEqual(
            [item[1] for item in _final_markdown_image_occurrences(
                _manual_v4_reader_view(sanitized)
            )],
            [url],
        )
        # 这份精简固定数据故意不带权威的 v5 结论声明载荷。
        # 因此最终检查可能因为这条独立原因拒掉它，
        # 但它不该再把同一个自链图片
        # 当成 selectedImageUrls 顺序不符而重复报错。
        self.assertNotIn(
            '图片 URL/顺序',
            validate_final_manual_v4_markdown(sanitized, paper) or '',
        )

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

        # 让 Python 侧的最终发布检查和 Node 侧的编辑检查保持一致：
        # 它统计汉字数，句末标点另有独立上限，
        # 嵌套的 Markdown 标题会切分正文。
        # 旧的回退实现把五个中文句号也算成字符，
        # 于是这段 258 个汉字、五个句子的段落
        # 被误判成超过 260 的硬失败。
        punctuation_boundary = '\n'.join((
            '### 这是一条嵌套标题，不应并入正文长度',
            '甲' * 258 + '。' * 5,
        ))
        paragraphs = _manual_editorial_prose_paragraphs(punctuation_boundary)
        self.assertEqual(paragraphs, ['甲' * 258 + '。' * 5])
        self.assertEqual(_manual_han_character_count(paragraphs[0]), 258)

        summary_sentence = '本文检验流式识别在固定测试划分中的错误率与速度权衡，并把结论限制在论文实际报告的设置内。'
        at_paragraph_limits = '甲' * 260 + '；!?;！？。'
        self.assertIsNone(validate_final_manual_v4_markdown(sanitized.replace(
            summary_sentence, at_paragraph_limits, 1,
        )))
        for paragraph in ('甲' * 261 + '。', at_paragraph_limits + '?'):
            with self.subTest(paragraph_boundary=paragraph[-8:]):
                self.assertIn('段落过长', validate_final_manual_v4_markdown(sanitized.replace(
                    summary_sentence, paragraph, 1,
                )))
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
            '批量模板句式': sanitized.replace('下图用于观察', '下图用于核对', 1),
            '段落以分号中断': sanitized.replace(
                '训练采用论文披露的数据划分与优化目标；没有报告的硬件吞吐不能从准确率结果反推。',
                '训练采用论文披露的数据划分与优化目标；\n\n没有报告的硬件吞吐不能从准确率结果反推。',
            ),
            '中英文技术词边界': sanitized.replace('编码器接收', '编码器使用Conformer接收', 1),
            '能能': sanitized.replace('编码器接收', '编码器的功能能接收', 1),
            '段落过长': sanitized.replace(
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

        ordinal = sanitized.replace('强基线', '排名第三的强基线', 1)
        self.assertIsNone(validate_final_manual_v4_markdown(ordinal))

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
        self.assertIn('最终页面的结果声明与读者正文的对应检查未通过', issue)
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
        self.assertIn('未找到对应的已审查插图计划', validate_image_narrative_contract(tampered))

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
        self.assertIn('图前导读或图后解释与已审查插图计划不一致',
                      validate_image_narrative_contract(swapped_prose))

    def test_manual_publication_rejects_half_values_with_three_complete_claims(self):
        vectors = [
            ('3.73.7', '3.7'), ('.119.119', '.119'),
            ('+0.15+0.15', '+0.15'), ('−5.6-5.6', '-5.6'),
            ('０.１５0.15', '0.15'), ('130130', '130'),
            ('3.73.7', '3.73.7'), ('.119.119', '.119.119'),
            ('+0.15+0.15', '+0.15+0.15'),
            ('3.73.7 and 2.1', '3.73.7 and 2.1'),
            ('3.734.65 and 2.1', '3.734.65 and 2.1'),
        ]
        for source_value, claimed_value in vectors:
            with self.subTest(source_value=source_value):
                claims = []
                lines = []
                for index in range(3):
                    method = f'完整方法{index}'
                    claim = manual_result_claim_fixture(claimed_value, method=method)
                    claim['sourceQuote'] = claim['sourceQuote'].replace(
                        f'WER {claimed_value} percent', f'WER {source_value} percent')
                    claim['sourceBindings']['value'] = source_value
                    claims.append(claim)
                    lines.append(f'LibriSpeech test-clean {method}相对强基线的 WER 为 '
                                 f'{claimed_value}%，越低越好。')
                with self.assertRaisesRegex(PublishDataValidationError, '数值|未覆盖'):
                    _validate_manual_v4_result_claims(
                        {'documentType': '方法研究', 'resultClaims': claims},
                        '## 实验结果\n' + '\n'.join(lines), 'fixture')

    def test_manual_publication_preserves_exact_numbers_and_tex_values(self):
        for source_value, claimed_value in [
                ('130130', '130130'), ('3.7 3.7', '3.7'),
                (r'\mathrm{3.7}', '3.7'), ('.119', '.119'), ('−5.6', '-5.6')]:
            with self.subTest(source_value=source_value):
                claims = []
                lines = []
                for index in range(3):
                    method = f'完整方法{index}'
                    claim = manual_result_claim_fixture(claimed_value, method=method)
                    claim['sourceQuote'] = claim['sourceQuote'].replace(
                        f'WER {claimed_value} percent', f'WER {source_value} percent')
                    claim['sourceBindings']['value'] = source_value
                    claims.append(claim)
                    lines.append(f'LibriSpeech test-clean {method}相对强基线的 WER 为 '
                                 f'{claimed_value}%，越低越好。')
                self.assertEqual(_validate_manual_v4_result_claims(
                    {'documentType': '方法研究', 'resultClaims': claims},
                    '## 实验结果\n' + '\n'.join(lines), 'fixture'), claims)

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
        cases.append(('input', candidate, 'inputSha256 与该阶段输入记录重新计算的 SHA 不一致'))
        candidate = copy.deepcopy((paper, manifest))
        candidate[1]['manualTakeover']['stageEvidence']['primaryAnalysis']['auditSha256'] = 'c' * 64
        cases.append(('audit', candidate, 'auditSha256 与阶段输入及审核记录重新计算的 SHA 不一致'))
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
        cases.append(('image context hash', candidate, '图片下载记录的 downloadEvidenceSha256 与候选图片及下载结果重新计算的 SHA 不一致'))

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

    def test_python_tag_roles_fail_closed_without_positional_fallback(self):
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
        self.assertEqual(parsed['primaryTaskTag'], '')
        self.assertEqual(parsed['primaryMethodTag'], '')
        self.assertFalse(parsed['tagValidation']['valid'])
        self.assertEqual(parsed['tagValidation']['conceptIds'], [])

        valid = benchmark.replace(
            'primary_task_tag: #模型评估', 'primary_task_tag: #音频理解',
        ).replace(
            'primary_method_tag: #基准测试', 'primary_method_tag: #数据清洗',
        ).replace(
            '主任务标签：#模型评估', '主任务标签：#音频理解',
        ).replace(
            '主方法标签：#基准测试', '主方法标签：#数据清洗',
        ).replace(
            '#模型评估 #基准测试 #音频理解',
            '#模型评估 #数据清洗 #音频理解',
        )
        parsed = parse_analysis(valid)
        self.assertEqual(parsed['primaryTaskTag'], '#音频理解')
        self.assertEqual(parsed['primaryMethodTag'], '#数据清洗')
        self.assertTrue(parsed['tagValidation']['valid'])

        model_family = valid.replace(
            'primary_method_tag: #数据清洗', 'primary_method_tag: #统一音频模型',
        ).replace('主方法标签：#数据清洗', '主方法标签：#统一音频模型')
        parsed = parse_analysis(model_family)
        self.assertEqual(parsed['primaryMethodTag'], '')
        self.assertFalse(parsed['tagValidation']['valid'])

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

    def test_escape_html_like_tags_is_idempotent_for_inline_control_tokens(self):
        text = '控制符 `<O>` 与 `<S>` 已经位于行内代码中。'
        fixed = escape_html_like_tags(text)
        self.assertEqual(fixed, text)
        self.assertEqual(escape_html_like_tags(fixed), fixed)

    def test_escape_html_like_tags_preserves_text_before_inline_control_token(self):
        text = '目标命令是 `turn off <EOT>`。'
        fixed = escape_html_like_tags(text)
        self.assertEqual(fixed, text)
        self.assertEqual(escape_html_like_tags(fixed), fixed)

    def test_escape_html_like_tags_repairs_nested_inline_control_token(self):
        text = '目标命令是 `turn off `<EOT>``。'
        fixed = escape_html_like_tags(text)
        self.assertEqual(fixed, '目标命令是 `turn off &lt;EOT&gt;`。')
        self.assertEqual(escape_html_like_tags(fixed), fixed)

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

    def test_publish_04173_cost_table_keeps_currency_cells_exact(self):
        table = (
            '| 尝试次数 | 1000 例翻译成本 | 1000 例验证成本 | 单接受例成本 | 平均规则数 |\n'
            '| --- | --- | --- | --- | --- |\n'
            '| 10 | $0.2 | $1.0/1000 | 0.12 美元 | 1.9 |'
        )
        self.assertEqual(sanitize_markdown_for_publish(table), table)
        self.assertEqual(sanitize_markdown_for_publish(sanitize_markdown_for_publish(table)), table)

    def test_fix_extraction_diacritic_damage_repairs_pdf_torn_accents(self):
        # PDF 提取把重音撕成反引号/游离音标；孤立反引号会打开不闭合的行内
        # 代码，最终 Markdown 门禁必然失败（Interspeech 2026 review 实测）。
        self.assertIn('Yoruba', fix_extraction_diacritic_damage('the Yor`ub ́a minimal'))
        self.assertIn('Yoruba', fix_extraction_diacritic_damage('the Yor`ub´a minimal'))
        self.assertIn('Concrete', fix_extraction_diacritic_damage('title: "Concr`ete: x"'))
        self.assertIn('Satosphere', fix_extraction_diacritic_damage('the Satosph`ere dom'))
        # 合法行内代码的开闭定界符与围栏必须保持字节不变
        kept = 'pre`code`post 与 `code` 以及 ```python\nx=1\n```'
        self.assertEqual(fix_extraction_diacritic_damage(kept), kept)
        # 数学 tilde 游离时只去标记、保留空格，避免 where ̃vf 粘成 wherevf
        self.assertIn('where vf', fix_extraction_diacritic_damage('where ̃vf denotes'))
        self.assertNotIn('wherevf', fix_extraction_diacritic_damage('where ̃vf denotes'))

    def test_sanitize_escapes_literal_sequence_symbols_only_in_table_cells(self):
        markdown = (
            '**普通加粗**\n\n'
            '| sequence | pattern |\n'
            '| --- | --- |\n'
            '| sequence 1 | *******___ |\n'
            '| sequence 2 | *_*___**** |\n'
            '\n```text\n| code | *******___ |\n```\n'
        )
        fixed = sanitize_markdown_for_publish(markdown)
        self.assertIn('**普通加粗**', fixed)
        self.assertIn(r'| sequence 1 | \*\*\*\*\*\*\*\_\_\_ |', fixed)
        self.assertIn(r'| sequence 2 | \*\_\*\_\_\_\*\*\*\* |', fixed)
        self.assertIn('| code | *******___ |', fixed)
        self.assertEqual(sanitize_markdown_for_publish(fixed), fixed)

    def test_sanitize_escapes_statistical_significance_stars(self):
        table = (
            '| 指标 | p 值 |\n'
            '| --- | --- |\n'
            '| 平均句时长 | p = 1.32e-10*** |\n'
            '| F1 | p = 0.00908** |\n'
            '| 备注 | p < 0.05 |\n'
        )
        fixed = sanitize_markdown_for_publish(table)
        self.assertIn(r'p = 1.32e-10\*\*\*', fixed)
        self.assertIn(r'p = 0.00908\*\*', fixed)
        self.assertIn('p < 0.05', fixed)
        self.assertEqual(sanitize_markdown_for_publish(fixed), fixed)

    def test_statistical_significance_stars_skip_code_fences(self):
        code = '```text\np = 0.00908**\n```\n'
        self.assertEqual(escape_statistical_significance_stars(code), code)

    def test_sanitize_escapes_technical_notation_stars_without_touching_frontmatter(self):
        text = (
            '---\n'
            'description: "H1*-H2* 是技术记号"\n'
            '---\n'
            '**H1*-H2*：** 这里的星号属于校正后的测量名称。\n'
            '```text\nH1*-H2*\n```\n'
        )
        fixed = sanitize_markdown_for_publish(text)
        self.assertIn('description: "H1*-H2* 是技术记号"', fixed)
        self.assertIn(r'**H1\*-H2\*：**', fixed)
        self.assertIn('```text\nH1*-H2*\n```', fixed)
        self.assertEqual(escape_technical_notation_asterisks(fixed), fixed)

    def test_latex_delimiters_do_not_pair_currency_or_cross_table_cells(self):
        for text in ('$0.2 and $1.0', '$20, $30 and $40', r'\$20 and \$30',
                     '| $0.2|$1.0 |', '$0.2\n$1.0', '| $x | y$ |'):
            with self.subTest(text=text):
                self.assertEqual(fix_latex_delimiters(text), text)

    def test_latex_delimiters_preserve_code_urls_and_explicit_math(self):
        literals = (
            '`echo "$a$"`\n``code `$b$` code``\n'
            '```python\nprice = "$0.2"\nformula = "$x$"\n```\n'
            '~~~text\n$x$\n~~~\n'
            'https://example.com/$x$/file\n'
            '[source](https://example.com/$y$/file)'
        )
        self.assertEqual(fix_latex_delimiters(literals), literals)
        self.assertEqual(fix_latex_delimiters(r'$x_i$ and $5$ and $x+1$'),
                         r'\(x_i\) and \(5\) and \(x+1\)')
        self.assertEqual(fix_latex_delimiters(r'| $x_i$ | $5$ |'),
                         r'| \(x_i\) | \(5\) |')
        self.assertEqual(fix_latex_delimiters(r'$p(x|y)$ and | $p(x\|y)$ |'),
                         r'\(p(x|y)\) and | \(p(x\|y)\) |')
        self.assertEqual(fix_latex_delimiters('$$a\nb$$'), '\\[a\nb\\]')
        explicit = r'\(p(y_i\mid\mathbf{y}_{<i})\) and \[x+y\]'
        self.assertEqual(fix_latex_delimiters(explicit),
                         r'\(p(y_i\mid\mathbf{y}_{\lt i})\) and \[x+y\]')

    def test_sanitize_autolinks_bare_https_without_touching_existing_markup(self):
        text = (
            '---\nsource: https://frontmatter.example/item\n---\n'
            '代码：https://github.com/example/repo。\n'
            '备用仓库：github.com/example/bare-repo，模型：huggingface.co/example/model。\n'
            '[已有链接](https://example.com/linked)\n'
            '![图片](https://example.com/image.png)\n'
            '<https://example.com/already>\n'
            '<https://github.com/example/repo，说明文字>\n'
            '| 模型 | 地址 |\n'
            '| --- | --- |\n'
            '| Demo | https://huggingface.co/example/table-model |\n'
            '`https://example.com/inline-code`\n'
            '```text\nhttps://example.com/fenced-code\n```\n'
        )
        fixed = sanitize_markdown_for_publish(text)
        self.assertIn('source: https://frontmatter.example/item', fixed)
        self.assertIn('代码：<https://github.com/example/repo>。', fixed)
        self.assertIn(
            '备用仓库：<https://github.com/example/bare-repo>，'
            '模型：<https://huggingface.co/example/model>。',
            fixed,
        )
        self.assertIn('[已有链接](https://example.com/linked)', fixed)
        self.assertIn('![图片](https://example.com/image.png)', fixed)
        self.assertEqual(fixed.count('<https://example.com/already>'), 1)
        self.assertIn('<https://github.com/example/repo>，说明文字', fixed)
        self.assertIn(
            '| Demo | https://huggingface.co/example/table-model |', fixed,
        )
        self.assertIn('`https://example.com/inline-code`', fixed)
        self.assertIn('```text\nhttps://example.com/fenced-code\n```', fixed)

    def test_sanitize_repairs_only_line_opening_bold_whitespace(self):
        text = (
            '** 概念桥：** 正文\n'
            '> ** 看图路径：** 第一步\n'
            '普通 **合法加粗** 与闭合标记：** 后文\n'
        )
        fixed = sanitize_markdown_for_publish(text)
        self.assertIn('**概念桥：** 正文', fixed)
        self.assertIn('> **看图路径：** 第一步', fixed)
        self.assertIn('普通 **合法加粗** 与闭合标记：** 后文', fixed)

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
        self.assertEqual(
            detect_publish_api_type(
                'https://opencode.ai/zen/go/v1', 'muse-spark-1.2-contributor'
            ),
            'openai_responses'
        )
        self.assertEqual(
            build_publish_api_url(
                'openai_responses', 'https://opencode.ai/zen/go/v1'
            ),
            'https://opencode.ai/zen/go/v1/responses'
        )
        self.assertEqual(
            detect_publish_api_type(
                'https://opencode.ai/zen/go/v1/responses/', 'future-model'
            ),
            'openai_responses'
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

    def test_credential_helper_rejects_api_url_identity_drift_before_headers(self):
        with mock.patch('publish_common.build_publish_headers') as build_headers:
            with self.assertRaisesRegex(
                    LlmAccountPoolConfigError, 'LLM 请求地址或接口类型与配置的端点、模型不匹配，未发送凭据。'):
                _open_publish_json_with_account_pool(
                    api_url='https://evil.example/v1/chat/completions',
                    endpoint='https://api.example.com/v1',
                    model='text-model',
                    api_type='openai',
                    api_keys=['secret-key'],
                    payload={'model': 'text-model'},
                    opener=mock.Mock(),
                    timeout=10,
                )
        build_headers.assert_not_called()

    def test_credential_helper_accepts_equivalent_canonical_default_port_url(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'{"choices":[{"message":{"content":"ok"}}]}'
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        status, payload = _open_publish_json_with_account_pool(
            api_url='https://API.EXAMPLE.COM:443/v1/chat/completions',
            endpoint='https://api.example.com/v1',
            model='text-model',
            api_type='openai',
            api_keys=['secret-key'],
            payload={'model': 'text-model'},
            opener=opener,
            timeout=10,
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload['choices'][0]['message']['content'], 'ok')

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

        responses = build_publish_payload(
            'openai_responses', 'muse-spark-1.2-contributor',
            'review', 100, 0.1, images=[image]
        )
        self.assertEqual(responses['max_output_tokens'], 100)
        self.assertEqual(responses['input'][0]['content'][0]['type'], 'input_text')
        self.assertEqual(responses['input'][0]['content'][1]['type'], 'input_image')

        with mock.patch.dict(os.environ, {
                'PD_OPENAI_RESPONSES_REASONING_EFFORT': 'low'}, clear=False):
            responses = build_publish_payload(
                'openai_responses', 'muse-spark-1.2-contributor',
                'review', 100, 0.1,
            )
        self.assertEqual(responses['reasoning'], {'effort': 'low'})

    def test_muse_responses_api_uses_project_proxy(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = (
            b'{"output":[{"type":"message","content":['
            b'{"type":"output_text","text":"ok"}]}]}'
        )
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'opencode-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=True, max_retries=1, max_tokens=100,
            )
        self.assertEqual(result, 'ok')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://opencode.ai/zen/go/v1/responses')
        payload = json.loads(request.data.decode('utf-8'))
        self.assertEqual(payload['model'], 'muse-spark-1.2-contributor')
        self.assertEqual(payload['max_output_tokens'], 100)
        self.assertNotIn('messages', payload)

    def test_balance_failover_is_forward_and_authentication_is_run_scoped(self):
        from llm_account_pool import select_api_key, mark_quota_exhausted, LlmAccountAuthError
        endpoint = 'https://opencode.ai/zen/go/v1'
        keys = ['a', 'b', 'c', 'd']
        for message in ('Insufficient balance',
                        'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_test_placeholder/billing',
                        'Invalid API key'):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as tmp:
                state_file = Path(tmp) / 'pool.json'
                for now_ms in (1000, 1100):
                    selected = select_api_key(keys, endpoint, state_file, now_ms=now_ms)
                    mark_quota_exhausted(selected, {'blocked_until_ms': 2200}, state_file, now_ms=now_ms)
                select_api_key(keys, endpoint, state_file, now_ms=1200)
                error = urllib.error.HTTPError(
                    endpoint + '/responses', 401, 'Unauthorized', {},
                    io.BytesIO(json.dumps({'error': {'message': message}}).encode()),
                )
                success = mock.MagicMock()
                success.__enter__.return_value = success
                success.status = 200
                success.read.return_value = b'{"status":"completed","output_text":"ok"}'
                opener = mock.Mock()
                opener.open.side_effect = [error, success]
                kwargs = dict(api_url=endpoint + '/responses', endpoint=endpoint,
                              model='muse-spark-1.2-contributor', api_type='openai-responses',
                              api_keys=keys, payload={}, opener=opener, timeout=5,
                              state_file=state_file, usage_sink=lambda _event: None)
                # 要用真实的协议判别字段，不要另抄一份常量。
                from publish_common import detect_publish_api_type
                kwargs['api_type'] = detect_publish_api_type(endpoint, kwargs['model'])
                if message != 'Invalid API key':
                    self.assertEqual(_open_publish_json_with_account_pool(**kwargs)[0], 200)
                    expected = ['Bearer c', 'Bearer d']
                else:
                    with self.assertRaises(LlmAccountAuthError) as caught:
                        _open_publish_json_with_account_pool(**kwargs)
                    self.assertEqual(caught.exception.scope, 'run')
                    expected = ['Bearer c']
                self.assertEqual([call.args[0].get_header('Authorization')
                                  for call in opener.open.call_args_list], expected)

    def test_muse_confirmed_quota_switches_once_and_keeps_fallback_sticky(self):
        quota_body = json.dumps({
            'type': 'GoUsageLimitError',
            'message': '5-hour usage limit reached. Resets in 30min.',
            'metadata': {'limitName': '5-hour rolling'},
        }).encode('utf-8')
        quota_error = urllib.error.HTTPError(
            'https://opencode.ai/zen/go/v1/responses',
            429,
            'Too Many Requests',
            {'Content-Type': 'application/json', 'Retry-After': '1800'},
            io.BytesIO(quota_body),
        )
        success = mock.Mock()
        success.status = 200
        success.read.return_value = b'{"status":"completed","output_text":"ok"}'
        success.__enter__ = mock.Mock(return_value=success)
        success.__exit__ = mock.Mock(return_value=False)
        second_success = mock.Mock()
        second_success.status = 200
        second_success.read.return_value = b'{"status":"completed","output_text":"again"}'
        second_success.__enter__ = mock.Mock(return_value=second_success)
        second_success.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.side_effect = [quota_error, success, second_success]
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'fallback-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.LLM_ACCOUNT_POOL_STATE_FILE', Path(tmp) / 'pool.json'), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep') as sleep:
            self.assertEqual(call_publish_llm_api(
                'inspect', required=True, max_retries=1, max_tokens=100,
            ), 'ok')
            self.assertEqual(call_publish_llm_api(
                'inspect again', required=True, max_retries=1, max_tokens=100,
            ), 'again')
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(
            [request.get_header('Authorization') for request in requests],
            ['Bearer primary-key', 'Bearer fallback-key', 'Bearer fallback-key'],
        )
        self.assertTrue(all(request.get_header('X-opencode-session') for request in requests))
        sleep.assert_not_called()

    def test_muse_all_accounts_quota_exhausted_is_bounded_and_typed(self):
        from llm_account_pool import LlmAccountPoolExhaustedError
        def quota_error():
            return urllib.error.HTTPError(
                'https://opencode.ai/zen/go/v1/responses',
                429,
                'Too Many Requests',
                {'Content-Type': 'application/json', 'Retry-After': '3600'},
                io.BytesIO(json.dumps({
                    'type': 'GoUsageLimitError',
                    'metadata': {'limitName': '5-hour rolling'},
                }).encode('utf-8')),
            )

        opener = mock.Mock()
        opener.open.side_effect = [quota_error(), quota_error()]
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'fallback-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.LLM_ACCOUNT_POOL_STATE_FILE', Path(tmp) / 'pool.json'), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep') as sleep, \
                self.assertRaisesRegex(LlmAccountPoolExhaustedError, '均明确返回额度耗尽') as caught:
            call_publish_llm_api(
                'inspect', required=True, max_retries=5, max_tokens=100,
            )
        self.assertEqual(opener.open.call_count, 2)
        self.assertEqual(caught.exception.code, 'LLM_ACCOUNT_POOL_EXHAUSTED')
        self.assertEqual(caught.exception.scope, 'run')
        sleep.assert_not_called()

    def test_muse_raw_quota_marker_without_valid_json_does_not_switch_account(self):
        quota_error = urllib.error.HTTPError(
            'https://opencode.ai/zen/go/v1/responses',
            429,
            'Too Many Requests',
            {'Content-Type': 'text/plain'},
            io.BytesIO(b'GoUsageLimitError'),
        )
        opener = mock.Mock()
        opener.open.side_effect = [quota_error]
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'fallback-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.LLM_ACCOUNT_POOL_STATE_FILE', Path(tmp) / 'pool.json'), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep'), \
                self.assertRaises(PublishLLMUnavailable):
            call_publish_llm_api(
                'inspect', required=True, max_retries=1, max_tokens=100,
            )
        self.assertEqual(opener.open.call_count, 1)

    def test_muse_incomplete_response_never_accepts_valid_looking_partial_json(self):
        first = mock.Mock()
        first.status = 200
        first.read.return_value = json.dumps({
            'status': 'incomplete',
            'incomplete_details': {'reason': 'max_output_tokens'},
            'output_text': '{"passed":true,"issues":[]}',
        }).encode('utf-8')
        first.__enter__ = mock.Mock(return_value=first)
        first.__exit__ = mock.Mock(return_value=False)
        second = mock.Mock()
        second.status = 200
        second.read.return_value = json.dumps({
            'status': 'completed',
            'output_text': '{"passed":true,"issues":[]}',
        }).encode('utf-8')
        second.__enter__ = mock.Mock(return_value=second)
        second.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep'):
            result = call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=2,
                structured_output=True,
            )
        self.assertEqual(result, '{"passed":true,"issues":[]}')
        self.assertEqual(opener.open.call_count, 2)

    def test_publish_llm_rejects_unsuccessful_status_with_complete_review_json(self):
        review_json = '{"passed":true,"issues":[]}'
        cases = [
            ('openai', {'choices': [{
                'message': {'content': review_json}, 'finish_reason': 'length',
            }]}, 'length'),
            ('anthropic', {
                'content': [{'type': 'text', 'text': review_json}],
                'stop_reason': 'max_tokens',
            }, 'max_tokens'),
        ]
        for finish in ('content_filter', 'tool_calls', 'function_call', 'unexpected_terminal'):
            cases.append(('openai', {'choices': [{'message': {'content': review_json},
                'finish_reason': finish}]}, finish))
        for finish in ('tool_use', 'pause_turn', 'refusal', 'unexpected_terminal'):
            cases.append(('anthropic', {'content': [{'type': 'text', 'text': review_json}],
                'stop_reason': finish}, finish))
        for response_status in ('incomplete', 'failed', 'cancelled', 'in_progress', 'queued'):
            cases.append(('openai_responses', {
                'status': response_status,
                'incomplete_details': {'reason': 'max_output_tokens'},
                'output_text': review_json,
            }, response_status))

        endpoints = {
            'openai': ('https://api.example.com/v1', 'text-model'),
            'anthropic': ('https://api.kimi.com/coding/v1', 'kimi-k2'),
            'openai_responses': ('https://opencode.ai/zen/go/v1', 'muse-spark-1.2-contributor'),
        }
        for protocol, body, expected_reason in cases:
            with self.subTest(protocol=protocol, reason=expected_reason):
                response = mock.MagicMock()
                response.status = 200
                response.read.return_value = json.dumps(body).encode('utf-8')
                response.__enter__.return_value = response
                opener = mock.Mock()
                opener.open.return_value = response
                endpoint, model = endpoints[protocol]
                env = {
                    'PAPER_ANALYZER_API_KEY': 'test-key',
                    'PAPER_ANALYZER_ENDPOINT': endpoint,
                    'PAPER_ANALYZER_MODEL': model,
                    'HTTPS_PROXY': 'http://127.0.0.1:7897',
                }
                with mock.patch.dict(os.environ, env, clear=True), \
                        mock.patch('urllib.request.build_opener', return_value=opener), \
                        mock.patch('publish_common.get_claude_code_version', return_value='9.8.7'), \
                        self.assertRaisesRegex(PublishLLMUnavailable, expected_reason):
                    call_publish_llm_api(
                        'inspect', required=True, max_retries=1,
                        structured_output=True, usage_sink=lambda event: None,
                    )
                self.assertEqual(opener.open.call_count, 1)

    def test_publish_llm_accepts_successful_and_legacy_missing_status_responses(self):
        review_json = '{"passed":true,"issues":[]}'
        cases = [
            ('https://api.example.com/v1', 'text-model', {'choices': [{
                'message': {'content': review_json}, 'finish_reason': 'stop',
            }]}),
            ('https://api.example.com/v1', 'text-model', {'choices': [{
                'message': {'content': review_json},
            }]}),
            ('https://api.kimi.com/coding/v1', 'kimi-k2', {
                'content': [{'type': 'text', 'text': review_json}],
                'stop_reason': 'end_turn',
            }),
            ('https://api.kimi.com/coding/v1', 'kimi-k2', {
                'content': [{'type': 'text', 'text': review_json}],
                'stop_reason': 'stop_sequence',
            }),
            ('https://api.kimi.com/coding/v1', 'kimi-k2', {
                'content': [{'type': 'text', 'text': review_json}],
            }),
            ('https://opencode.ai/zen/go/v1', 'muse-spark-1.2-contributor', {
                'status': 'completed', 'output_text': review_json,
            }),
            ('https://opencode.ai/zen/go/v1', 'muse-spark-1.2-contributor', {
                'output_text': review_json,
            }),
        ]
        for endpoint, model, body in cases:
            with self.subTest(endpoint=endpoint, body=body):
                response = mock.MagicMock()
                response.status = 200
                response.read.return_value = json.dumps(body).encode('utf-8')
                response.__enter__.return_value = response
                opener = mock.Mock()
                opener.open.return_value = response
                env = {
                    'PAPER_ANALYZER_API_KEY': 'test-key',
                    'PAPER_ANALYZER_ENDPOINT': endpoint,
                    'PAPER_ANALYZER_MODEL': model,
                    'HTTPS_PROXY': 'http://127.0.0.1:7897',
                }
                with mock.patch.dict(os.environ, env, clear=True), \
                        mock.patch('urllib.request.build_opener', return_value=opener), \
                        mock.patch('publish_common.get_claude_code_version', return_value='9.8.7'):
                    result = call_publish_llm_api(
                        'inspect', required=True, max_retries=1,
                        usage_sink=lambda event: None,
                    )
                self.assertEqual(result, review_json)
                self.assertEqual(opener.open.call_count, 1)

    def test_partial_text_is_not_misclassified_as_empty_hidden_reasoning(self):
        review_json = '{"passed":true,"issues":[]}'
        responses = []
        for finish_reason in ('length', 'stop'):
            response = mock.MagicMock()
            response.status = 200
            response.read.return_value = json.dumps({'choices': [{
                'message': {'content': review_json, 'reasoning_content': 'hidden reasoning'},
                'finish_reason': finish_reason,
            }]}).encode('utf-8')
            response.__enter__.return_value = response
            responses.append(response)
        opener = mock.Mock()
        opener.open.side_effect = responses
        env = {
            'PAPER_ANALYZER_API_KEY': 'test-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'reasoning-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep'):
            result = call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=2,
                structured_output=True, usage_sink=lambda event: None,
            )
        self.assertEqual(result, review_json)
        self.assertEqual(opener.open.call_count, 2)
        payloads = [json.loads(call.args[0].data) for call in opener.open.call_args_list]
        self.assertEqual([payload['max_tokens'] for payload in payloads], [4000, 4000])
        self.assertEqual([payload['messages'][0]['content'] for payload in payloads], ['inspect', 'inspect'])

    def test_empty_failed_responses_do_not_expand_budget_or_duplicate_usage(self):
        for response_status in ('failed', 'cancelled'):
            with self.subTest(status=response_status):
                response = mock.MagicMock()
                response.status = 200
                response.read.return_value = json.dumps({
                    'status': response_status,
                    'incomplete_details': {'reason': 'max_output_tokens'},
                    'output': [{'type': 'reasoning', 'summary': [
                        {'type': 'summary_text', 'text': 'hidden reasoning'},
                    ]}],
                }).encode('utf-8')
                response.__enter__.return_value = response
                opener = mock.Mock()
                opener.open.return_value = response
                usage_events = []
                env = {
                    'PAPER_ANALYZER_API_KEY': 'test-key',
                    'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
                    'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
                    'HTTPS_PROXY': 'http://127.0.0.1:7897',
                }
                with mock.patch.dict(os.environ, env, clear=True), \
                        mock.patch('urllib.request.build_opener', return_value=opener), \
                        mock.patch('publish_common.time.sleep'), \
                        self.assertRaisesRegex(PublishLLMUnavailable, response_status):
                    call_publish_llm_api(
                        'inspect', required=True, max_tokens=4000, max_retries=2,
                        structured_output=True, usage_sink=usage_events.append,
                    )
                self.assertEqual(opener.open.call_count, 2)
                payloads = [json.loads(call.args[0].data) for call in opener.open.call_args_list]
                self.assertEqual([payload['max_output_tokens'] for payload in payloads], [4000, 4000])
                self.assertEqual([payload['input'][0]['content'][0]['text'] for payload in payloads], ['inspect', 'inspect'])
                self.assertEqual(len(usage_events), 2)
                self.assertEqual([event['outcome'] for event in usage_events], ['provider_error', 'provider_error'])

    def test_optional_publish_llm_returns_none_for_truncated_nonempty_response(self):
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = json.dumps({'choices': [{
            'message': {'content': '{"passed":true,"issues":[]}'},
            'finish_reason': 'length',
        }]}).encode('utf-8')
        response.__enter__.return_value = response
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'test-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=False, max_retries=1, usage_sink=lambda event: None,
            )
        self.assertIsNone(result)

    def test_publish_llm_response_body_has_hard_size_limit(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'x' * (2 * 1024 * 1024 + 1)
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep'), \
                self.assertRaisesRegex(PublishLLMUnavailable, '2 MiB'):
            call_publish_llm_api('inspect', required=True, max_retries=1)
        response.read.assert_called_once_with(2 * 1024 * 1024 + 1)

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
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'primary-go-fallback',
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

    def test_go_primary_cannot_supply_even_one_key_to_non_go_secondary(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'opencode-fallback-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.build_publish_headers') as build_headers, \
                mock.patch('urllib.request.build_opener') as build_opener, \
                self.assertRaisesRegex(LlmAccountPoolConfigError, '属于不同服务'):
            call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        build_headers.assert_not_called()
        build_opener.assert_not_called()

    def test_different_non_go_services_require_explicit_secondary_key(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.primary.example/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://api.secondary.example/v1',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.build_publish_headers') as build_headers, \
                mock.patch('urllib.request.build_opener') as build_opener, \
                self.assertRaisesRegex(LlmAccountPoolConfigError, '属于不同服务'):
            call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        build_headers.assert_not_called()
        build_opener.assert_not_called()

    def test_explicit_secondary_key_allows_cross_service_route(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'{"choices":[{"message":{"content":"ok"}}]}'
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'PAPER_ANALYZER_SECONDARY_API_KEY': 'secondary-provider-key',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        self.assertEqual(result, 'ok')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.example.com/v1/chat/completions')
        self.assertEqual(
            request.get_header('Authorization'), 'Bearer secondary-provider-key'
        )

    def test_non_go_primary_cannot_supply_credentials_to_go_secondary(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-provider-key',
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'stale-primary-fallback',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.primary.example/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'muse-spark-1.2-contributor',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.build_publish_headers') as build_headers, \
                mock.patch('urllib.request.build_opener') as build_opener, \
                self.assertRaisesRegex(LlmAccountPoolConfigError, '必须显式配置'):
            call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        build_headers.assert_not_called()
        build_opener.assert_not_called()

    def test_cross_service_secondary_fallback_requires_explicit_secondary_key(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-provider-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.primary.example/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS': 'secondary-fallback-key',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'muse-spark-1.2-contributor',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.build_publish_headers') as build_headers, \
                mock.patch('urllib.request.build_opener') as build_opener, \
                self.assertRaisesRegex(LlmAccountPoolConfigError, '独立账号池跨服务'):
            call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        build_headers.assert_not_called()
        build_opener.assert_not_called()

    def test_same_go_service_secondary_fallback_can_use_primary_key_anchor(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'{"status":"completed","output_text":"ok"}'
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://opencode.ai/zen/go/v1/responses',
            'PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS': 'secondary-fallback-key',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.LLM_ACCOUNT_POOL_STATE_FILE', Path(tmp) / 'pool.json'), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        self.assertEqual(result, 'ok')
        self.assertEqual(
            opener.open.call_args.args[0].get_header('Authorization'),
            'Bearer primary-key',
        )

    def test_opencode_secondary_without_explicit_key_inherits_primary_pool(self):
        quota_error = urllib.error.HTTPError(
            'https://opencode.ai/zen/go/v1/responses',
            429,
            'Too Many Requests',
            {'Content-Type': 'application/json', 'Retry-After': '60'},
            io.BytesIO(json.dumps({
                'type': 'GoUsageLimitError',
                'metadata': {'limitName': '5-hour rolling'},
            }).encode('utf-8')),
        )
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'{"status":"completed","output_text":"ok"}'
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.side_effect = [quota_error, response]
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_FALLBACK_API_KEYS': 'fallback-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_MODEL': 'muse-spark-1.2-contributor',
            'PAPER_ANALYZER_SECONDARY_ENDPOINT': 'https://opencode.ai/zen/go/v1',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'muse-spark-1.2-contributor',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('publish_common.LLM_ACCOUNT_POOL_STATE_FILE', Path(tmp) / 'pool.json'), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
            )
        self.assertEqual(result, 'ok')
        self.assertEqual(
            [call.args[0].get_header('Authorization') for call in opener.open.call_args_list],
            ['Bearer primary-key', 'Bearer fallback-key'],
        )

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
        self.assertEqual(validated[0]['parsed']['tags'],
                         ['#语音识别', '#Transformer', '#低资源'])

        incomplete = copy.deepcopy(paper)
        incomplete['parsed'].pop('engineeringScore')
        with self.assertRaisesRegex(PublishDataValidationError, 'engineeringScore'):
            resolve_publish_parsed(incomplete)

    def test_publish_preflight_rejects_partial_scoring_reason(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('* 工程/实践价值 (1.5/1.5)：具体理由充分\n', '')
        with self.assertRaisesRegex(PublishDataValidationError, '评分维度|工程/实践价值'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_replays_current_tag_selection_for_manual_or_api_producers(self):
        paper = complete_paper()
        self.assertEqual(
            resolve_publish_parsed(paper)['primaryMethodTag'], '#Transformer')

        non_method = copy.deepcopy(paper)
        non_method['analysis'] = non_method['analysis'].replace(
            'primary_method_tag: #Transformer', 'primary_method_tag: #低资源').replace(
            '主方法标签：#Transformer', '主方法标签：#低资源')
        with self.assertRaisesRegex(PublishDataValidationError, '补充标签的内容或顺序与首行除主任务、主方法外的标签不一致。'):
            resolve_publish_parsed(non_method)

        machine_mismatch = copy.deepcopy(paper)
        machine_mismatch['analysis'] = machine_mismatch['analysis'].replace(
            'primary_method_tag: #Transformer', 'primary_method_tag: #CNN')
        with self.assertRaisesRegex(PublishDataValidationError, '机器摘要中的主任务或主方法与标签章节不一致。'):
            resolve_publish_parsed(machine_mismatch)

        duplicate_machine_role = copy.deepcopy(paper)
        duplicate_machine_role['analysis'] = duplicate_machine_role['analysis'].replace(
            'primary_method_tag: #Transformer',
            'primary_method_tag: #Transformer\nprimary_method_tag: #Transformer')
        with self.assertRaisesRegex(PublishDataValidationError, '必须恰好出现一次'):
            resolve_publish_parsed(duplicate_machine_role)

        role_literal_outside_machine = copy.deepcopy(paper)
        role_literal_outside_machine['analysis'] = role_literal_outside_machine['analysis'].replace(
            '## 作者与机构\n',
            '## 作者与机构\nprimary_method_tag: #Transformer\n')
        self.assertEqual(
            resolve_publish_parsed(role_literal_outside_machine)['primaryMethodTag'],
            '#Transformer')

        extra_line = copy.deepcopy(paper)
        extra_line['analysis'] = extra_line['analysis'].replace(
            '补充标签：#低资源', '补充标签：#低资源\n额外标签说明')
        with self.assertRaisesRegex(PublishDataValidationError, '标签章节必须恰好包含四行非空内容。'):
            resolve_publish_parsed(extra_line)

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

    def test_old_tag_cache_preserves_scoring_baseline_and_rejects_mixed_fields(self):
        original = complete_paper()
        baseline = resolve_publish_parsed(original)
        for key, value in (('taxonomyValidation', original['parsed']['tagValidation']),
                           ('tagValidation', None), ('tagValidation', ['invalid']),
                           (None, None)):
            paper = copy.deepcopy(original)
            paper['parsed'].pop('tagValidation')
            if key is not None:
                paper['parsed'][key] = copy.deepcopy(value)
            before = copy.deepcopy(paper)
            self.assertEqual(resolve_publish_parsed(paper), baseline)
            self.assertEqual(paper, before)

        old = copy.deepcopy(original)
        old['parsed']['taxonomyValidation'] = old['parsed'].pop('tagValidation')
        old['parsed']['engineeringScore'] = '1'
        old['parsed']['score'] = '6.5'
        old['parsedOverride'] = {
            'type': 'manual', 'source': 'editor:fixture', 'reason': '人工复核工程价值',
            'fields': ['engineeringScore', 'score'],
        }
        self.assertEqual(resolve_publish_parsed(old)['score'], '6.5')
        for new_value, old_value in (({}, {}), (None, None),
                                     (baseline['tagValidation'], baseline['tagValidation'])):
            mixed = copy.deepcopy(original)
            mixed['parsed']['tagValidation'] = new_value
            mixed['parsed']['taxonomyValidation'] = old_value
            with self.subTest(new_value=new_value):
                with self.assertRaisesRegex(PublishDataValidationError, '不能同时包含'):
                    resolve_publish_parsed(mixed)

    def test_publish_baseline_ignores_stale_cached_body_fields(self):
        paper = complete_paper()
        paper['parsed']['summary'] = '陈旧摘要不得发布'
        paper['parsed']['tags'] = {'invalid': '陈旧标签缓存也必须被忽略'}
        paper['parsed']['results'] = '陈旧实验结果'
        parsed = resolve_publish_parsed(paper)
        self.assertNotEqual(parsed.get('summary'), '陈旧摘要不得发布')
        self.assertEqual(parsed['tags'], ['#语音识别', '#Transformer', '#低资源'])
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
        attach_tag_stage_record(paper, paper['analysisManifest'])
        self.assertEqual(len(validate_papers_for_publish([paper])), 1)
        missing_tag_stage = copy.deepcopy(paper)
        del missing_tag_stage['analysisManifest']['stages']['taxonomySeal']
        with self.assertRaisesRegex(PublishDataValidationError, '深度分析阶段尚未全部完成: taxonomySeal'):
            validate_papers_for_publish([missing_tag_stage])
        paper['analysisManifest']['stages']['scoringAudit']['status'] = 'transient_failure'
        with self.assertRaisesRegex(PublishDataValidationError, 'scoringAudit'):
            validate_papers_for_publish([paper])

    def test_tag_stage_reader_preserves_partial_records_and_rejects_mixed_formats(self):
        self.assertIsNone(read_tag_stage_record({})['format'])
        for current in (False, True):
            stage_key = 'tagSelection' if current else 'taxonomySeal'
            contract_key = 'tagSelectionRecord' if current else 'taxonomy'
            hash_key = 'tagSectionAndPrimaryTagsSha256' if current else 'taxonomySurfaceSha256'
            other_stage_key = 'taxonomySeal' if current else 'tagSelection'
            other_contract_key = 'taxonomy' if current else 'tagSelectionRecord'
            other_hash_key = 'taxonomySurfaceSha256' if current else 'tagSectionAndPrimaryTagsSha256'
            stage = {'status': 'failed'}
            manifest = {'stages': {stage_key: stage}}
            checkpoints = {stage_key: '原始正文'}
            original = copy.deepcopy((manifest, checkpoints))
            record = read_tag_stage_record(manifest, checkpoints)
            self.assertIs(record['stage'], stage)
            self.assertIs(record['checkpoint'], checkpoints[stage_key])
            self.assertEqual(record['format'], 'current' if current else 'legacy')
            self.assertEqual(record['hashKey'], hash_key)
            self.assertEqual((manifest, checkpoints), original)
            for value in (None, stage):
                bad = copy.deepcopy(manifest)
                bad['stages'][other_stage_key] = value
                with self.assertRaisesRegex(ValueError, '不能混用新旧格式'):
                    read_tag_stage_record(bad, checkpoints)
                with self.assertRaisesRegex(ValueError, '不能混用新旧格式'):
                    read_tag_stage_record(manifest, {**checkpoints, other_stage_key: value})
            bad = copy.deepcopy(manifest)
            bad['contracts'] = {other_contract_key: None}
            with self.assertRaisesRegex(ValueError, '不能混用新旧格式'):
                read_tag_stage_record(bad)
            bad = copy.deepcopy(manifest)
            bad['stages'][stage_key][other_hash_key] = None
            with self.assertRaisesRegex(ValueError, '不能混用新旧格式'):
                read_tag_stage_record(bad)
            contract = TAG_STAGE_RECORD_CONTRACT if current else 'paper-taxonomy-selection-v1'
            for value in (None, contract):
                with self.assertRaisesRegex(ValueError, '不能混用新旧格式'):
                    read_tag_stage_record({'contracts': {contract_key: contract, other_contract_key: value}})
        for value in (None, '', 'paper-tag-stage-record-v3', 2):
            with self.assertRaisesRegex(ValueError, '格式版本无效'):
                read_tag_stage_record({'contracts': {'tagSelectionRecord': value}})

    def test_current_tag_stage_roundtrip_checks_new_binding_and_original_checkpoints(self):
        statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        for status in ('complete', 'not_needed'):
            for prompt_contract in (TAG_PROMPT_TEXT_CONTRACT, LEGACY_TAG_PROMPT_TEXT_CONTRACT):
                with self.subTest(status=status, prompt_contract=prompt_contract):
                    paper = complete_paper()
                    manifest = {'version': 1, 'stages': {
                        name: {'status': terminal} for name, terminal in statuses.items()}}
                    paper['analysisManifest'] = manifest
                    stage = attach_tag_stage_record(
                        paper, manifest, status=status, with_checkpoints=True,
                        prompt_text_contract=prompt_contract, record_format='current')
                    original = copy.deepcopy(paper)
                    with tempfile.TemporaryDirectory() as directory:
                        path = Path(directory) / 'record.json'
                        path.write_text(json.dumps(paper, ensure_ascii=False), encoding='utf-8')
                        restored = json.loads(path.read_text(encoding='utf-8'))
                    self.assertIsNone(_validate_tag_stage_record(restored, restored['analysisManifest'], '论文'))
                    self.assertEqual(len(validate_papers_for_publish([restored])), 1)
                    self.assertEqual(paper, original)
                    self.assertEqual(tuple(field for field in CURRENT_TAG_STAGE_BINDING_FIELDS),
                                     (*LEGACY_TAG_STAGE_BINDING_FIELDS[:9], 'tagSectionAndPrimaryTagsSha256',
                                      *LEGACY_TAG_STAGE_BINDING_FIELDS[10:]))
                    for field in ('tagSectionAndPrimaryTagsSha256', 'bindingSha256', 'primaryTaskId'):
                        bad = copy.deepcopy(restored)
                        bad['analysisManifest']['stages']['tagSelection'][field] = '0' * 64
                        with self.assertRaises(PublishDataValidationError):
                            _validate_tag_stage_record(bad, bad['analysisManifest'], '论文')
                    bad = copy.deepcopy(restored)
                    bad['analysisStageCheckpoints']['tagSelection'] += '\n正文变化'
                    with self.assertRaises(PublishDataValidationError):
                        _validate_tag_stage_record(bad, bad['analysisManifest'], '论文')
                    bad = copy.deepcopy(restored)
                    bad['analysisManifest']['stages']['coreSummaryRepair']['inputAnalysisSha256'] = '0' * 64
                    with self.assertRaises(PublishDataValidationError):
                        _validate_tag_stage_record(bad, bad['analysisManifest'], '论文')
                    bad = copy.deepcopy(restored)
                    new_stage = bad['analysisManifest']['stages']['tagSelection']
                    old_binding = {field: new_stage.get(field) for field in LEGACY_TAG_STAGE_BINDING_FIELDS}
                    old_binding['taxonomySurfaceSha256'] = stage['tagSectionAndPrimaryTagsSha256']
                    new_stage['bindingSha256'] = _manual_hash(old_binding)
                    with self.assertRaisesRegex(PublishDataValidationError, '绑定 SHA'):
                        _validate_tag_stage_record(bad, bad['analysisManifest'], '论文')

    def test_python_replays_tag_stage_production_proof_and_rejects_drift(self):
        paper = complete_paper()
        statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        manifest = {
            'version': 1,
            'stages': {name: {'status': status} for name, status in statuses.items()},
        }
        paper['analysisManifest'] = manifest
        attach_tag_stage_record(paper, manifest)
        self.assertEqual(
            set(paper['analysisStageCheckpoints']), {'taxonomySeal'})
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))
        self.assertEqual(len(validate_papers_for_publish([paper])), 1)

        mutations = {
            'registrySha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('registrySha256', '0' * 64),
            'projectionSha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('projectionSha256', '0' * 64),
            'inputAnalysisSha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('inputAnalysisSha256', '0' * 64),
            'outputAnalysisSha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('outputAnalysisSha256', '0' * 64),
            'protectedProjectionSha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('outputProtectedProjectionSha256', '0' * 64),
            'taxonomySurfaceSha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('taxonomySurfaceSha256', '0' * 64),
            'bindingSha256': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('bindingSha256', '0' * 64),
            'primaryTaskId': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('primaryTaskId', 'task.tts'),
            'conceptIds': lambda candidate: candidate['analysisManifest']['stages']['taxonomySeal'].__setitem__('conceptIds', ['task.tts', 'method.transformer', 'setting.low-resource']),
            'manifestContract': lambda candidate: candidate['analysisManifest']['contracts'].__setitem__('taxonomy', 'legacy'),
            'structureChain': lambda candidate: candidate['analysisManifest']['stages']['structureRepair'].__setitem__('outputAnalysisSha256', '0' * 64),
            'coreSummaryChain': lambda candidate: candidate['analysisManifest']['stages']['coreSummaryRepair'].__setitem__('inputAnalysisSha256', '0' * 64),
            'scoringChain': lambda candidate: candidate['analysisManifest']['stages']['scoringAudit'].__setitem__('coreSummaryInputAnalysisSha256', '0' * 64),
        }
        for name, mutate in mutations.items():
            candidate = copy.deepcopy(paper)
            mutate(candidate)
            with self.subTest(name=name), self.assertRaises(PublishDataValidationError):
                _validate_tag_stage_record(
                    candidate, candidate['analysisManifest'], candidate['arxivId'])

        checkpoint_drift = copy.deepcopy(paper)
        attach_tag_stage_record(
            checkpoint_drift, checkpoint_drift['analysisManifest'],
            status='complete', with_checkpoints=True)
        checkpoint_drift['analysisStageCheckpoints']['taxonomySeal'] += '\nDRIFT'
        with self.assertRaisesRegex(PublishDataValidationError, '标签阶段保存的输出正文无效，或其正文、受保护正文或标签内容的 SHA 与阶段记录不一致。'):
            _validate_tag_stage_record(
                checkpoint_drift, checkpoint_drift['analysisManifest'],
                checkpoint_drift['arxivId'])

        structure_checkpoint_drift = copy.deepcopy(paper)
        attach_tag_stage_record(
            structure_checkpoint_drift,
            structure_checkpoint_drift['analysisManifest'],
            status='complete', with_checkpoints=True)
        structure_checkpoint_drift['analysisStageCheckpoints']['structureRepair'] += '\nDRIFT'
        with self.assertRaisesRegex(PublishDataValidationError, '标签阶段保存的输入正文无效，或其正文或受保护正文 SHA 与阶段记录不一致。'):
            _validate_tag_stage_record(
                structure_checkpoint_drift,
                structure_checkpoint_drift['analysisManifest'],
                structure_checkpoint_drift['arxivId'])

        complete_without_checkpoints = copy.deepcopy(paper)
        attach_tag_stage_record(
            complete_without_checkpoints,
            complete_without_checkpoints['analysisManifest'],
            status='complete', with_checkpoints=False)
        complete_without_checkpoints.pop('analysisStageCheckpoints')
        with self.assertRaisesRegex(PublishDataValidationError, '已完成的标签阶段缺少有效的输出正文。'):
            _validate_tag_stage_record(
                complete_without_checkpoints,
                complete_without_checkpoints['analysisManifest'],
                complete_without_checkpoints['arxivId'])

        # 修复只改变标签字段时，遮盖这些字段后的其余正文保持原字节；
        # 重新计算测试记录的绑定哈希后应通过。
        repaired = copy.deepcopy(paper)
        legacy_input = repaired['analysis'].replace('#语音识别', '#ASR')
        attach_tag_stage_record(
            repaired, repaired['analysisManifest'],
            input_analysis=legacy_input, status='complete', with_checkpoints=True)
        self.assertIsNone(_validate_tag_stage_record(
            repaired, repaired['analysisManifest'], repaired['arxivId']))

        # 即使重新计算了绑定哈希，也不能允许标签字段以外的正文变化。
        protected_drift = copy.deepcopy(paper)
        drifted_input = protected_drift['analysis'].replace(
            '具体理由充分', '输入阶段的其他正文已变化', 1)
        stage = attach_tag_stage_record(
            protected_drift, protected_drift['analysisManifest'],
            input_analysis=drifted_input, status='complete', with_checkpoints=True)
        with self.assertRaisesRegex(PublishDataValidationError, '标签阶段记录中的输入与输出受保护正文哈希不一致。'):
            _validate_tag_stage_record(
                protected_drift, protected_drift['analysisManifest'],
                protected_drift['arxivId'])

    # 以下测试检查词表变化后能否沿用标签阶段记录，与 Node 的升级规则作对照。
    def test_selection_protocols_preserve_old_bindings_and_reject_mismatched_parent(self):
        for selection_contract in (LEGACY_TAG_SELECTION_CONTRACT, TAG_SELECTION_CONTRACT):
            for record_format in ('legacy', 'current'):
                with self.subTest(selection=selection_contract, format=record_format):
                    paper = complete_paper()
                    manifest = {'version': 1}
                    stage = attach_tag_stage_record(
                        paper, manifest, record_format=record_format,
                        selection_contract=selection_contract)
                    original = copy.deepcopy((paper, manifest))
                    self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))
                    self.assertEqual((paper, manifest), original)
                    if record_format == 'legacy':
                        manifest['contracts']['taxonomy'] = (
                            TAG_SELECTION_CONTRACT if selection_contract == LEGACY_TAG_SELECTION_CONTRACT
                            else LEGACY_TAG_SELECTION_CONTRACT)
                        with self.assertRaisesRegex(PublishDataValidationError, '标签选择协议'):
                            _validate_tag_stage_record(paper, manifest, paper['arxivId'])
                        manifest['contracts']['taxonomy'] = selection_contract
                    stage['bindingSha256'] = '0' * 64
                    with self.assertRaisesRegex(PublishDataValidationError, '绑定 SHA'):
                        _validate_tag_stage_record(paper, manifest, paper['arxivId'])

    def test_upgrade_protocol_pairs_accept_old_records_without_rewriting_them(self):
        from_sha = 'a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d'
        snapshot = load_tag_catalog(Path(ROOT) / 'config' / 'tag-catalog-history' / (from_sha + '.json'))
        annotation = {
            'contract': 'paper-tag-catalog-upgrade-v2', 'version': 2,
            'fromRegistrySha256': from_sha, 'fromRegistryVersion': snapshot['version'],
            'toRegistrySha256': _PUBLISH_TAG_CATALOG['registrySha256'],
            'toRegistryVersion': _PUBLISH_TAG_CATALOG['version'],
            'changeLevel': _classify_registry_change(
                snapshot, _PUBLISH_TAG_CATALOG)['changeLevel'],
            'reasons': ['definition-updated', 'scope-note-updated'],
            'note': '迁移词表版本名称，并明确确认 ITN 定义及适用范围的修正。',
        }
        for contract, version in (
                ('paper-taxonomy-registry-upgrade-v1', 1), ('paper-tag-catalog-upgrade-v2', 2)):
            candidate = {**annotation, 'contract': contract, 'version': version}
            original = copy.deepcopy(candidate)
            self.assertTrue(_validate_tag_catalog_upgrade(from_sha, ['task.asr'], candidate)['ok'])
            self.assertEqual(candidate, original)
        for contract, version in (
                ('paper-taxonomy-registry-upgrade-v1', 2), ('paper-tag-catalog-upgrade-v2', 1),
                ('unknown', 2)):
            result = _validate_tag_catalog_upgrade(
                from_sha, ['task.asr'], {**annotation, 'contract': contract, 'version': version})
            self.assertFalse(result['ok'])
            self.assertEqual(result['reasonCode'], 'annotation-invalid')

    def test_tag_stage_upgrade_accepts_legacy_prompt_hash_formats(self):
        additive = next(case for case in cross_end_fixture()['cases']
                        if case['name'] == 'additive-upgrade-allowed')
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(
            paper, manifest, prompt_text_contract=LEGACY_TAG_PROMPT_TEXT_CONTRACT)
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))

        # 阶段记录引用旧词表时，升级说明必须与重新计算的变更一致。
        rebind_tag_stage_record(stage, registry_sha256=additive['fromRegistrySha256'],
                             annotation=additive['annotation'])
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))

        # 此处显式使用旧版提示，保留原兼容规则允许的三种 SHA 格式值；
        # 通过检查不表示已精确认证旧提示全文。
        for projection in ('e' * 64, tag_prompt_text_sha256(
                _PUBLISH_TAG_CATALOG, LEGACY_TAG_PROMPT_TEXT_CONTRACT),
                _PUBLISH_TAG_PROMPT_TEXT_SHA256):
            stage['projectionSha256'] = projection
            rebind_tag_stage_record(stage)
            self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))

    def test_tag_stage_upgrade_gate_allows_acknowledged_destructive_change(self):
        """带有有效破坏性变更确认的标签阶段记录应被发布检查接受；
        删除确认字段后仍须拒绝，与 Node 的结果保持一致。"""
        case = next(item for item in cross_end_fixture()['cases']
                    if item['name'] == 'destructive-acknowledged-allowed')
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(
            paper, manifest, prompt_text_contract=LEGACY_TAG_PROMPT_TEXT_CONTRACT)
        rebind_tag_stage_record(stage, registry_sha256=case['fromRegistrySha256'],
                             annotation=case['annotation'])
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))

        # 删除 destructiveAcknowledgement 后，应以 reason=destructive 拒绝沿用。
        stripped = {key: value for key, value in case['annotation'].items()
                    if key != 'destructiveAcknowledgement'}
        rebind_tag_stage_record(stage, registry_sha256=case['fromRegistrySha256'],
                             annotation=stripped)
        with self.assertRaises(PublishDataValidationError) as caught:
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])
        self.assertIn('reason=destructive', str(caught.exception))
        self.assertIn('显式确认无效', str(caught.exception))

    def test_tag_prompt_versions_bind_exact_text_without_rewriting_stages(self):
        for contract in (LEGACY_TAG_PROMPT_TEXT_CONTRACT, TAG_PROMPT_TEXT_CONTRACT):
            for status in ('complete', 'not_needed'):
                with self.subTest(contract=contract, status=status):
                    paper = complete_paper()
                    manifest = {'version': 1}
                    stage = attach_tag_stage_record(
                        paper, manifest, status=status, with_checkpoints=True,
                        prompt_text_contract=contract)
                    saved_paper = copy.deepcopy(paper)
                    saved_manifest = copy.deepcopy(manifest)
                    self.assertIsNone(_validate_tag_stage_record(
                        paper, manifest, paper['arxivId']))
                    self.assertEqual(paper, saved_paper)
                    self.assertEqual(manifest, saved_manifest)
                    other_contract = (TAG_PROMPT_TEXT_CONTRACT
                                      if contract == LEGACY_TAG_PROMPT_TEXT_CONTRACT
                                      else LEGACY_TAG_PROMPT_TEXT_CONTRACT)
                    stage['projectionSha256'] = tag_prompt_text_sha256(
                        _PUBLISH_TAG_CATALOG, other_contract)
                    rebind_tag_stage_record(stage)
                    with self.assertRaisesRegex(PublishDataValidationError, 'projectionSha256'):
                        _validate_tag_stage_record(paper, manifest, paper['arxivId'])

        for contract in (None, '', 'paper-tag-prompt-text-v3', 2, [], {}):
            with self.subTest(invalid_contract=contract):
                paper = complete_paper()
                manifest = {'version': 1}
                stage = attach_tag_stage_record(paper, manifest)
                stage['projectionContract'] = contract
                rebind_tag_stage_record(stage)
                with self.assertRaisesRegex(PublishDataValidationError, '提示文本协议版本不受支持'):
                    _validate_tag_stage_record(paper, manifest, paper['arxivId'])

    def test_new_tag_prompt_upgrade_uses_one_snapshot_for_all_checks(self):
        case = next(item for item in cross_end_fixture()['cases']
                    if item['name'] == 'additive-upgrade-allowed')
        from_sha = case['fromRegistrySha256']
        snapshot = load_tag_catalog(
            Path(ROOT) / 'config' / 'tag-catalog-history' / f'{from_sha}.json')
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(paper, manifest)
        rebind_tag_stage_record(
            stage, registry_sha256=from_sha, annotation=case['annotation'],
            projection_sha256=tag_prompt_text_sha256(snapshot))
        saved = copy.deepcopy((paper, manifest))
        with mock.patch('publish_common._resolve_registry_snapshot',
                        side_effect=[snapshot, None]) as resolver:
            self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))
            resolver.assert_called_once_with(from_sha)
        self.assertEqual((paper, manifest), saved)

        for omit_sha, missing_sha in ((True, None), (False, None)):
            without_sha = copy.deepcopy(snapshot)
            if omit_sha:
                without_sha.pop('registrySha256')
            else:
                without_sha['registrySha256'] = missing_sha
            before = copy.deepcopy(without_sha)
            with self.subTest(omit_sha=omit_sha, missing_sha=missing_sha), mock.patch(
                    'publish_common._resolve_registry_snapshot', return_value=without_sha) as resolver:
                self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))
                resolver.assert_called_once_with(from_sha)
            self.assertEqual(without_sha, before)

        empty_sha = copy.deepcopy(snapshot)
        empty_sha['registrySha256'] = ''
        with mock.patch('publish_common._resolve_registry_snapshot', return_value=empty_sha):
            with self.assertRaisesRegex(PublishDataValidationError, '旧词表快照中的 SHA'):
                _validate_tag_stage_record(paper, manifest, paper['arxivId'])
        self.assertEqual(empty_sha['registrySha256'], '')

        conflicting = copy.deepcopy(snapshot)
        conflicting['registrySha256'] = '0' * 64
        stage['projectionSha256'] = tag_prompt_text_sha256(conflicting)
        rebind_tag_stage_record(stage)
        with mock.patch('publish_common._resolve_registry_snapshot', return_value=conflicting):
            with self.assertRaisesRegex(PublishDataValidationError, '旧词表快照中的 SHA'):
                _validate_tag_stage_record(paper, manifest, paper['arxivId'])

        for invalid_sha in ('e' * 64, _PUBLISH_TAG_PROMPT_TEXT_SHA256,
                            tag_prompt_text_sha256(snapshot, LEGACY_TAG_PROMPT_TEXT_CONTRACT)):
            with self.subTest(invalid_sha=invalid_sha):
                stage['projectionSha256'] = invalid_sha
                rebind_tag_stage_record(stage)
                with self.assertRaisesRegex(PublishDataValidationError, '新版提示文本 SHA'):
                    _validate_tag_stage_record(paper, manifest, paper['arxivId'])

        stage['projectionSha256'] = tag_prompt_text_sha256(snapshot)
        rebind_tag_stage_record(stage)
        with mock.patch('publish_common._resolve_registry_snapshot', return_value=None):
            with self.assertRaisesRegex(PublishDataValidationError, 'reason=snapshot-missing'):
                _validate_tag_stage_record(paper, manifest, paper['arxivId'])

    def test_catalog_name_migration_checks_the_original_stage_snapshot_and_prompt(self):
        from_sha = 'a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d'
        snapshot = load_tag_catalog(Path(ROOT) / 'config' / 'tag-catalog-history' / (from_sha + '.json'))
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(paper, manifest)
        annotation = {
            'contract': 'paper-taxonomy-registry-upgrade-v1', 'version': 1,
            'fromRegistrySha256': from_sha, 'fromRegistryVersion': snapshot['version'],
            'toRegistrySha256': _PUBLISH_TAG_CATALOG['registrySha256'],
            'toRegistryVersion': _PUBLISH_TAG_CATALOG['version'],
            'changeLevel': _classify_registry_change(
                snapshot, _PUBLISH_TAG_CATALOG)['changeLevel'],
            'reasons': ['definition-updated', 'scope-note-updated'],
            'note': '迁移词表版本名称，并明确确认 ITN 定义及适用范围的修正。',
        }
        rebind_tag_stage_record(stage, registry_sha256=from_sha, annotation=annotation,
                               projection_sha256=tag_prompt_text_sha256(snapshot))
        saved = copy.deepcopy((paper, manifest))
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))
        self.assertEqual((paper, manifest), saved)
        stage['registryVersion'] = _PUBLISH_TAG_CATALOG['version']
        rebind_tag_stage_record(stage)
        with self.assertRaisesRegex(PublishDataValidationError, '与旧词表快照不一致'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])
        stage['registryVersion'] = snapshot['version']
        rebind_tag_stage_record(stage, projection_sha256='e' * 64)
        with self.assertRaisesRegex(PublishDataValidationError, '新版提示文本 SHA'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])

    def test_itn_definition_upgrade_requires_annotation_and_original_snapshot(self):
        from_sha = '85ed9e5a7cde6f58c3cb97b10d61401641dd2e39592680d2c343137bc7669d3a'
        snapshot = load_tag_catalog(
            Path(ROOT) / 'config' / 'tag-catalog-history' / (from_sha + '.json'))
        classified = _classify_registry_change(snapshot, _PUBLISH_TAG_CATALOG)
        self.assertEqual(classified['changeLevel'], 'additive')
        self.assertEqual(
            {reason['code'] for reason in classified['detail']['reasons']},
            {'definition-updated', 'scope-note-updated'})
        annotation = {
            'contract': 'paper-tag-catalog-upgrade-v2', 'version': 2,
            'fromRegistrySha256': from_sha,
            'fromRegistryVersion': snapshot['version'],
            'toRegistrySha256': _PUBLISH_TAG_CATALOG['registrySha256'],
            'toRegistryVersion': _PUBLISH_TAG_CATALOG['version'],
            'changeLevel': 'additive',
            'reasons': ['definition-updated', 'scope-note-updated'],
            'note': '明确确认 ITN 从口语识别结果恢复为书面文本的定义修正。',
        }
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(paper, manifest)
        rebind_tag_stage_record(
            stage, registry_sha256=from_sha, annotation=annotation,
            projection_sha256=tag_prompt_text_sha256(snapshot))
        saved = copy.deepcopy((paper, manifest))
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))
        self.assertEqual((paper, manifest), saved)
        rebind_tag_stage_record(stage, drop_annotation=True)
        with self.assertRaisesRegex(PublishDataValidationError, 'reason=annotation-invalid'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])
        wrong_target = {**annotation, 'toRegistrySha256': '0' * 64}
        rebind_tag_stage_record(stage, annotation=wrong_target)
        with self.assertRaisesRegex(PublishDataValidationError, 'reason=annotation-invalid'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])

    def test_tag_stage_current_catalog_requires_matching_versions_and_hashes(self):
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(paper, manifest)
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))

        # 阶段与当前词表使用同一 SHA 时，词表版本及提示 SHA
        # 必须与当前词表和保存的提示版本逐项对应。
        stage['projectionSha256'] = '0' * 64
        with self.assertRaisesRegex(
                PublishDataValidationError,
                '标签阶段记录中的 projectionSha256 与当前词表、提示文本或标签选择协议不一致。'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])
        stage['projectionSha256'] = _PUBLISH_TAG_PROMPT_TEXT_SHA256

        stage['registryVersion'] = 'paper-taxonomy-v0'
        with self.assertRaisesRegex(
                PublishDataValidationError,
                '标签阶段记录中的 registryVersion 与当前词表、提示文本或标签选择协议不一致。'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])
        stage['registryVersion'] = _PUBLISH_TAG_CATALOG['version']
        self.assertIsNone(_validate_tag_stage_record(paper, manifest, paper['arxivId']))

    def test_tag_stage_upgrade_rejects_invalid_snapshots_annotations_and_concepts(self):
        fixture = cross_end_fixture()
        cases = {case['name']: case for case in fixture['cases']}
        expectations = {
            # 词表更新后，这份旧快照与当前词表之间已有破坏性变更。
            # 人工确认检查先于升级说明检查，所以缺少说明的记录先以 destructive 拒绝；
            # 原输入仍然不能被接受。
            'missing-annotation-rejected': 'reason=destructive',
            'no-snapshot-rejected': 'reason=snapshot-missing',
            'destructive-lying-annotation-rejected': 'reason=destructive',
            'annotation-level-mismatch-rejected': 'reason=annotation-invalid',
            'stale-concept-id-rejected': 'reason=concept-not-active',
            'invalid-from-sha-rejected': 'reason=invalid-from-sha',
        }
        for name, reason_pattern in expectations.items():
            with self.subTest(case=name):
                case = cases[name]
                paper = complete_paper()
                manifest = {'version': 1}
                stage = attach_tag_stage_record(paper, manifest)
                rebind_tag_stage_record(
                    stage,
                    registry_sha256=case['fromRegistrySha256'],
                    annotation=case.get('annotation'),
                    drop_annotation=case.get('annotation') is None,
                    concept_ids=case.get('conceptIds'))
                with self.assertRaises(PublishDataValidationError) as caught:
                    _validate_tag_stage_record(paper, manifest, paper['arxivId'])
                message = str(caught.exception)
                self.assertIn(reason_pattern, message)
                self.assertIn(f"from={case['fromRegistrySha256']}", message)
                self.assertIn(f"to={_PUBLISH_TAG_CATALOG['registrySha256']}", message)
                if name == 'destructive-lying-annotation-rejected':
                    self.assertIn('codes=', message)
                    self.assertIn('alias-removed', message)

        # 提示 SHA 首先必须符合十六进制格式；这个用例用格式无效的值
        # 验证最先触发的拒绝原因。
        paper = complete_paper()
        manifest = {'version': 1}
        stage = attach_tag_stage_record(paper, manifest)
        additive = cases['additive-upgrade-allowed']
        rebind_tag_stage_record(stage, registry_sha256=additive['fromRegistrySha256'],
                             annotation=additive['annotation'],
                             projection_sha256='not-a-sha')
        with self.assertRaisesRegex(PublishDataValidationError, 'reason=projection-sha-invalid'):
            _validate_tag_stage_record(paper, manifest, paper['arxivId'])

    def test_tag_stage_destructive_acknowledgement_gate(self):
        """确认记录的 conceptIdImpact 必须为 none，所选概念仍须在当前词表中有效。

        确认不能替代旧快照、升级说明、当前概念有效性及重新计算的变更检查；
        不允许确认的变更仍须拒绝。"""
        current = _PUBLISH_TAG_CATALOG
        destructive_from = Path(ROOT) / 'config' / 'tag-catalog-history' / (
            '3f9a14c9d753716b428b8ca27a9d93b92b3ae93cfbffc1a24f60573ff8ef234a.json')
        old_registry = json.loads(destructive_from.read_bytes().decode('utf-8'))

        # 同一份变更详情在 Node 和 Python 中应产生相同的原因哈希。
        # 下面的固定值对应 2026-09-30 词表更新后，历史快照与当前词表之间
        # 的别名、上级关系和首选名称变化。
        eligible_detail = _classify_registry_change(
            {**old_registry, 'registrySha256': destructive_from.stem}, current)['detail']
        self.assertEqual(eligible_detail['changeLevel'], 'destructive')
        self.assertEqual(
            _destructive_reasons_hash(eligible_detail),
            '2442f16185af5300754e2b7d948728df085e6895880b9bcfa0c23ba60f9f8273')
        self.assertTrue(_acknowledgement_eligibility(eligible_detail)['eligible'])
        self.assertEqual(
            _acknowledgement_eligibility(eligible_detail)['eligibleReasons'],
            ['alias-removed', 'broader-id-changed', 'preferred-label-changed'])

        confirmation_hash = '2442f16185af5300754e2b7d948728df085e6895880b9bcfa0c23ba60f9f8273'
        reversed_detail = copy.deepcopy(eligible_detail)
        reversed_detail['reasons'].reverse()
        self.assertEqual(_destructive_reasons_hash(reversed_detail), confirmation_hash)
        reworded_detail = copy.deepcopy(eligible_detail)
        for reason in reworded_detail['reasons']:
            reason['message'] = '重新说明这项变化。'
        self.assertEqual(_destructive_reasons_hash(reworded_detail), confirmation_hash)
        changed_structure = copy.deepcopy(eligible_detail)
        destructive_reason = next(reason for reason in changed_structure['reasons']
                                  if reason['level'] == 'destructive')
        destructive_reason['conceptId'] = 'method.another-concept'
        self.assertNotEqual(_destructive_reasons_hash(changed_structure), confirmation_hash)
        repeated_reason = copy.deepcopy(eligible_detail)
        repeated_reason['reasons'].append(copy.deepcopy(next(
            reason for reason in eligible_detail['reasons']
            if reason['level'] == 'destructive')))
        self.assertNotEqual(_destructive_reasons_hash(repeated_reason), confirmation_hash)

        # 这里检查理由的确认资格，不绕过词表校验去触发分类分支。
        # definition 和 scope-note 的实际变化仍由分类器归为 additive。
        allowed_codes = [
            'preferred-label-changed', 'broader-id-changed', 'alias-removed',
            'label-collision', 'definition-updated', 'scope-note-updated',
        ]
        forbidden_codes = [
            'concept-removed', 'facet-removed', 'status-deactivated',
            'version-changed', 'concept-facet-changed',
            'active-label-not-globally-unique', 'unknown-change',
        ]
        for code in allowed_codes:
            with self.subTest(allowed_reason=code):
                detail = {'changeLevel': 'destructive', 'reasons': [
                    {'level': 'destructive', 'code': code, 'message': '说明变化'},
                    {'level': 'additive', 'code': 'concept-added', 'message': '新增概念'},
                ]}
                self.assertEqual(_acknowledgement_eligibility(detail), {
                    'eligible': True, 'eligibleReasons': [code], 'ineligibleReasons': [],
                })
        for code in forbidden_codes:
            for codes in ([code], ['alias-removed', code], [code, 'alias-removed']):
                with self.subTest(forbidden_reasons=codes):
                    detail = {'changeLevel': 'destructive', 'reasons': [
                        {'level': 'destructive', 'code': item, 'message': '说明变化'}
                        for item in codes
                    ]}
                    self.assertEqual(_acknowledgement_eligibility(detail), {
                        'eligible': False,
                        'eligibleReasons': ['alias-removed'] if len(codes) > 1 else [],
                        'ineligibleReasons': [code],
                    })
        for level, expected in [('none', True), ('additive', True),
                                ('destructive', False), ('unknown', False), (None, False)]:
            with self.subTest(empty_reasons_level=level):
                detail = {'reasons': []}
                if level is not None:
                    detail['changeLevel'] = level
                self.assertEqual(_acknowledgement_eligibility(detail), {
                    'eligible': expected, 'eligibleReasons': [], 'ineligibleReasons': [],
                })
        self.assertEqual(_acknowledgement_eligibility(None), {
            'eligible': False, 'eligibleReasons': [], 'ineligibleReasons': [],
        })

        # 旧词表中的概念在新词表已删除，这类变更不允许人工确认。
        synthetic = copy.deepcopy(current)
        synthetic.pop('registrySha256', None)
        synthetic['concepts'] = list(synthetic['concepts']) + [{
            'id': 'task.legacy-only', 'facet': 'task',
            'preferredLabel': {'zh': '旧表独有概念', 'en': 'Legacy Only Concept'},
            'aliases': ['LegacyOnly'], 'broaderId': None,
            'definition': '旧表独有、新表已删除的概念。',
            'scopeNote': '仅用于不可确认集合测试。',
            'status': 'active', 'replacedBy': None,
        }]
        payload = json.dumps(synthetic, ensure_ascii=False, indent=2).encode('utf-8')
        snapshot_sha = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / f'{snapshot_sha}.json').write_bytes(payload)
            with mock.patch('publish_common._tag_catalog_history_dir',
                            return_value=Path(tmp)):
                detail = _classify_registry_change(
                    {**synthetic, 'registrySha256': snapshot_sha}, current)['detail']
                eligibility = _acknowledgement_eligibility(detail)
                self.assertEqual(detail['changeLevel'], 'destructive')
                self.assertFalse(eligibility['eligible'])
                self.assertEqual(eligibility['ineligibleReasons'], ['concept-removed'])

                annotation = {
                    'contract': 'paper-taxonomy-registry-upgrade-v1',
                    'version': 1,
                    'fromRegistrySha256': snapshot_sha,
                    'fromRegistryVersion': current['version'],
                    'toRegistrySha256': current['registrySha256'],
                    'toRegistryVersion': current['version'],
                    'changeLevel': 'destructive',
                    'reasons': ['concept-removed'],
                    'note': '人工确认（这个变更不可确认）',
                    'destructiveAcknowledgement': {
                        'acknowledged': True,
                        'reasonsHash': _destructive_reasons_hash(detail),
                        'conceptIdImpact': 'none',
                        'note': '人工确认：conceptId 影响 none',
                    },
                }
                rejected = _validate_tag_catalog_upgrade(snapshot_sha, ['task.asr'], annotation)
                self.assertFalse(rejected['ok'])
                self.assertEqual(rejected['reasonCode'], 'destructive')
                self.assertIn('不属于可人工确认的范围', rejected['error'])
                self.assertIn('concept-removed', rejected['error'])

                # 不能取得旧快照时，即使提供确认也必须拒绝。
                missing = _validate_tag_catalog_upgrade('0' * 64, ['task.asr'], annotation)
                self.assertFalse(missing['ok'])
                self.assertEqual(missing['reasonCode'], 'snapshot-missing')

        # 非破坏性变更的说明中不能附带破坏性变更确认。真实旧快照当前已不适合
        # 构造新增概念用例，因此在测试临时目录生成一份仅缺少未被引用概念的旧词表；
        # 不改生产历史目录。
        synthetic_old = json.loads(json.dumps(current))
        synthetic_old['concepts'] = [
            c for c in synthetic_old['concepts'] if c['id'] != 'task.wake-word']
        self.assertFalse(any(c.get('broaderId') == 'task.wake-word'
                             for c in synthetic_old['concepts']),
                         'task.wake-word 必须无子节点才可作为合成删除对象')
        # 写入词表文件时只保留 version、facets、concepts 三个字段。
        # registrySha256 是加载后附加的元数据，写回文件会先被词表字段校验拒绝，
        # 快照读取因此返回 None。
        synthetic_old = {k: synthetic_old[k]
                         for k in ('version', 'facets', 'concepts') if k in synthetic_old}
        synthetic_bytes = json.dumps(synthetic_old, ensure_ascii=False, indent=2).encode('utf-8')
        synthetic_sha = hashlib.sha256(synthetic_bytes).hexdigest()
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / f'{synthetic_sha}.json').write_bytes(synthetic_bytes)
            with mock.patch('publish_common._tag_catalog_history_dir',
                            return_value=Path(tmpdir)):
                additive_detail = _classify_registry_change(
                    {**synthetic_old, 'registrySha256': synthetic_sha},
                    current)['detail']
                self.assertEqual(additive_detail['changeLevel'], 'additive')
                annotated = {
                    'contract': 'paper-taxonomy-registry-upgrade-v1',
                    'version': 1,
                    'fromRegistrySha256': synthetic_sha,
                    'fromRegistryVersion': current['version'],
                    'toRegistrySha256': current['registrySha256'],
                    'toRegistryVersion': current['version'],
                    'changeLevel': 'additive',
                    'reasons': ['concept-added'],
                    'note': '合成 additive 快照：验证确认字段只属于 destructive',
                    'destructiveAcknowledgement': {
                        'acknowledged': True,
                        'reasonsHash': _destructive_reasons_hash(additive_detail),
                        'conceptIdImpact': 'none',
                        'note': '不该出现在 additive 上',
                    },
                }
                valid_additive = dict(annotated)
                valid_additive.pop('destructiveAcknowledgement')
                allowed = _validate_tag_catalog_upgrade(
                    synthetic_sha, ['task.asr'], valid_additive)
                self.assertTrue(allowed['ok'], allowed['error'])
                self.assertEqual(allowed['changeLevel'], 'additive')
                lying = _validate_tag_catalog_upgrade(synthetic_sha, ['task.asr'], annotated)
        self.assertFalse(lying['ok'])
        self.assertEqual(lying['reasonCode'], 'annotation-invalid')
        self.assertIn('非破坏性变更', lying['error'])

    def test_python_registry_upgrade_gate_matches_node_fixture(self):
        # Python 与 Node 使用同一份旧词表 SHA、升级说明和概念 ID 输入，逐项比较处理结果。
        # 另一个 JavaScript 测试读取相同 fixture；本 Python 方法不执行 Node。
        display_expectations = {
            'additive-upgrade-allowed': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。',
            },
            'missing-annotation-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。',
                'error': '词表包含破坏性变更，原标签阶段记录不能直接沿用概念 method.flow-matching 删除了别名“flow matching”，使用该别名的旧标签需要重新核对；概念 method.self-supervised 删除了别名“ssl learning”，使用该别名的旧标签需要重新核对；概念 task.speech-spoofing 的上级概念（broaderId）由 null 改为 task.audio-forgery，祖先关系随之改变，也可能影响主任务是否符合最具体概念的要求；显式确认无效：破坏性变更必须在 destructiveAcknowledgement 中提供显式确认。',
            },
            'no-snapshot-rejected': {
                'error': '无法取得更新前的词表快照 0000000000000000000000000000000000000000000000000000000000000000，不能沿用标签阶段记录。',
            },
            'destructive-lying-annotation-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。',
                'error': '词表包含破坏性变更，原标签阶段记录不能直接沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效：破坏性变更必须在 destructiveAcknowledgement 中提供显式确认。',
            },
            'annotation-level-mismatch-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。',
                'error': '词表升级说明未通过核验：registryUpgradeFrom.changeLevel=none 与重新计算的变更等级 destructive 不一致。',
            },
            'stale-concept-id-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×2、broader-id-changed×1、preferred-label-changed×2、alias-added×5、concept-added×58、definition-updated×2、scope-note-updated×8。',
                'error': '原标签阶段记录引用的以下概念在当前词表中缺失或已停用：task.not-a-concept(缺失)',
            },
            'invalid-from-sha-rejected': {
                'error': '标签阶段记录中的 registrySha256 格式无效，不能沿用该记录。',
            },
            'destructive-acknowledged-allowed': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。',
            },
            'destructive-ack-missing-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。',
                'error': '词表包含破坏性变更，原标签阶段记录不能直接沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效：破坏性变更必须在 destructiveAcknowledgement 中提供显式确认。',
            },
            'destructive-ack-wrong-hash-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。',
                'error': '词表包含破坏性变更，原标签阶段记录不能直接沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效：destructiveAcknowledgement.reasonsHash 与本次重新计算的破坏性变更原因不一致。',
            },
            'destructive-ack-concept-impact-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。',
                'error': '词表包含破坏性变更，原标签阶段记录不能直接沿用概念 method.end-to-end-learning 删除了别名“e2e”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“end-to-end”，使用该别名的旧标签需要重新核对；概念 method.end-to-end-learning 删除了别名“端到端”，使用该别名的旧标签需要重新核对；显式确认无效：destructiveAcknowledgement.conceptIdImpact 必须为 none，表明所选概念 ID 不变。',
            },
            'destructive-ack-stale-concept-id-rejected': {
                'summary': '词表变更属于 destructive；各项原因及数量为：alias-removed×5、broader-id-changed×1、preferred-label-changed×2、alias-added×7、concept-added×57、definition-updated×2、scope-note-updated×8。',
                'error': '原标签阶段记录引用的以下概念在当前词表中缺失或已停用：task.not-a-concept(缺失)',
            },
        }
        fixture = cross_end_fixture()
        legacy_current = load_tag_catalog(
            Path(ROOT) / 'config' / 'tag-catalog-history' / (fixture['currentRegistrySha256'] + '.json'))
        for case in fixture['cases']:
            with self.subTest(case=case['name']):
                outcome = _validate_tag_catalog_upgrade(
                    case['fromRegistrySha256'], case.get('conceptIds'),
                    case.get('annotation'), current=legacy_current)
                detail = outcome.get('detail') or {}
                view = {
                    'ok': outcome['ok'],
                    'changeLevel': outcome['changeLevel'],
                    'summary': detail.get('summary'),
                    'reasonCodes': sorted({reason['code']
                                           for reason in detail.get('reasons', [])})
                    if outcome['detail'] is not None else None,
                    'counts': detail.get('counts'),
                    'error': normalize_seal_error(outcome['error']),
                }
                expected = {**case['expect'], **display_expectations[case['name']]}
                self.assertEqual(view, expected)

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
        attach_tag_stage_record(paper, paper['analysisManifest'])

        self.assertEqual(len(extract_markdown_tables(table)), 1)
        self.assertEqual(len(extract_markdown_tables(f'```markdown\n{table}\n```')), 0)
        for identifier_header in ('策略', '谐波聚合方式'):
            synonym_table = (
                f'| {identifier_header} | 指标 ↑ |\n'
                '| --- | --- |\n'
                '| 基线 | 1.0 |\n'
                '| 完整方法 | 2.0 |'
            )
            self.assertGreaterEqual(
                extract_markdown_tables(synonym_table)[0]['identifier_columns'],
                1,
            )
        self.assertRegex(validate_experiment_table_contract(paper['analysis']), '13 个数据行')
        with self.assertRaisesRegex(PublishDataValidationError, '表格契约无效'):
            validate_papers_for_publish([paper])

        legacy = copy.deepcopy(paper)
        del legacy['analysisManifest']['contracts']['experimentTables']
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
        baseline_narrative = valid.replace(
            '关键比较问题是完整方法相对强基线能降低多少识别错误，以及收益是否带来速度代价。表中保留主方法、最强基线与关键消融。',
            '固定测试集与解码预算保持一致，表中保留完整方法、最强基线和关键消融配置。',
        )
        self.assertIsNone(validate_experiment_table_contract(
            baseline_narrative,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
        ))
        latex_direction = valid.replace('LibriSpeech WER↓', r'Macro-F1 $\uparrow$')
        self.assertIsNone(validate_experiment_table_contract(
            latex_direction,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
        ))
        loss_identifier = valid.replace(
            '方法 / 设置',
            '损失函数 (骨干: HyST-Net, 数据集: DNS Challenge)',
        )
        self.assertIsNone(validate_experiment_table_contract(
            loss_identifier,
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
            ('Table 1 compares HCNA w/o extrap. against GCR extrapolation.', '配置 C 无外推，配置 B 保留自适应外推'),
        )
        for source_text, conclusion in cases:
            with self.subTest(conclusion=conclusion):
                self.assertIsNone(validate_experiment_table_contract(
                    analysis_with(conclusion),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                    source_text=source_text,
                ))
        modality_order = analysis_with('配置 C 相比配置 A 降低 2.7 个百分点').replace(
            '| 方法 / 设置 |', '| 阶数 |')
        self.assertIsNone(validate_experiment_table_contract(
            modality_order,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
        ))
        explicit_contrast = analysis_with('配置 C 相比配置 A 降低 2.7 个百分点').replace(
            '关键比较问题是三种配置在固定测试集上的 WER 差异多大，并核验模型配置改变是否影响结果方向。',
            '为核对规模与任务配比谁主导性能，仅对比同一测试划分上的归一化词错误率。',
        )
        self.assertIsNone(validate_experiment_table_contract(
            explicit_contrast,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
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
                '没有改善', '无效', '失效', '崩溃', '接近随机', '低于随机',
                '负面结果', '置信区间跨零', '落后', '可测损失',
                '轻微回退', '呈不单调性', '不保证单调改进'):
            with self.subTest(negative=negative):
                self.assertIsNone(validate_experiment_table_contract(
                    analysis_with(f'配置 C 出现{negative}'),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                    source_text='The third configuration fails on the hard subset.',
                ))
        self.assertIsNone(validate_experiment_table_contract(
            analysis_with('Voxtral Mini 等模型出现负结果'),
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='The held-out result degraded and showed negative returns.',
        ))
        for contextual_negative in (
                '代价是 I2V 动态幅度从 44.58 降至 35.62',
                '移除内容评审器后视觉得分降至 18.67'):
            with self.subTest(contextual_negative=contextual_negative):
                self.assertIsNone(validate_experiment_table_contract(
                    analysis_with(contextual_negative),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                    source_text='The held-out result degraded and showed negative returns.',
                ))
        ordinary_decline = analysis_with(
            '配置 C 的测试误差从 0.91 下降至 0.90，其余设置保持一致')
        self.assertRegex(validate_experiment_table_contract(
            ordinary_decline,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='The third configuration fails on the hard subset.',
        ), '没有保留负面证据')
        for ambiguous_decline in (
                '代价是测试误差从 0.91 下降至 0.90',):
            with self.subTest(ambiguous_decline=ambiguous_decline):
                self.assertRegex(validate_experiment_table_contract(
                    analysis_with(ambiguous_decline),
                    contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
                    document_type='方法研究',
                    source_text='The third configuration fails on the hard subset.',
                ), '没有保留负面证据')
        # explicit_metric_decline: 裸指标（higher-is-better）下降本身即算负面证据，
        # 无需“代价”前缀，因此本例通过门禁（与 Node 侧 analysis-contract 语义一致）。
        self.assertIsNone(validate_experiment_table_contract(
            analysis_with('动态幅度从 44.58 下降至 35.62'),
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='The third configuration fails on the hard subset.',
        ))
        positive_rise = analysis_with(
            '配置 C 的准确率从 0.90 微升至 0.91，其余设置保持一致')
        self.assertRegex(validate_experiment_table_contract(
            positive_rise,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type='方法研究',
            source_text='The third configuration fails on the hard subset.',
        ), '没有保留负面证据')

    def test_evidence_rich_table_accepts_exact_musecp_editing_identifiers(self):
        template = '''## 实验结果
关键比较问题是不同单面编辑下和声与节奏度量如何变化，表中保留原文客观验证的代表操作作对照。

| {identifier} | CoF ↓ | ChromaSim ↑ | ΔBPM ↓ | BeatF ↑ |
|---|---:|---:|---:|---:|
| +7 半音 | 0.18 | 0.94 | 1.26 | 0.90 |
| ABC→AAA | 0.06 | 0.99 | 0.87 | 0.54 |
| 变速 +50% | 0.03 | 0.99 | 26.10 | 0.24 |

ZETA 与 MusicMagus 的 ΔBPM 数值与两个全局适配系统分成两组，后两者在细粒度时序对齐上{negative}；但证据只来自原文不统一的编辑设置，不能外推为跨系统排名。
'''
        options = {
            'contract_version': EXPERIMENT_TABLE_CONTRACT_VERSION,
            'document_type': '方法研究',
            'source_text': (
                'Evaluation\nTable 2 reports objective editing results. '
                'The case study reports clear degradation in rhythm preservation.'
            ),
        }
        for identifier in ('编辑操作', 'Editing', 'Editing Operation'):
            with self.subTest(identifier=identifier):
                self.assertIsNone(validate_experiment_table_contract(
                    template.format(identifier=identifier, negative='暴露短板'),
                    **options,
                ))
        for identifier in ('编辑结果', '编辑操作得分'):
            with self.subTest(identifier=identifier):
                self.assertRegex(validate_experiment_table_contract(
                    template.format(identifier=identifier, negative='暴露短板'),
                    **options,
                ), '缺少方法、数据集或设置识别列')
        self.assertRegex(validate_experiment_table_contract(
            template.format(identifier='编辑操作', negative='存在普通代价'),
            **options,
        ), '没有保留负面证据')

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
        attach_tag_stage_record(paper, paper['analysisManifest'])
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

        compound = build_paper_meta({
            'score': '6.0',
            'primaryTaskTag': '#音频理解',
            'primaryMethodTag': '#模型评估',
            'tags': ['#音频理解', '#模型评估', '#音频事件检测 #可解释性'],
        })
        self.assertIn('#音频事件检测 | #可解释性', compound)
        self.assertNotIn('#音频事件检测 #可解释性', compound)


if __name__ == '__main__':
    unittest.main()

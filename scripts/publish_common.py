#!/usr/bin/env python3
"""
Paper Digest 发布公共模块 (Python)
统一封装：数据加载、评分排序、标签提取、格式化工具
消除 publish-to-blog.py / publish-wechat-full.py / publish-xiaohongshu.py 的重复逻辑
"""

import json
import hashlib
import math
import os
import random
import re
import subprocess
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

_SHARED_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)
from path_config import (
    CURRENT_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    read_json_strict,
    resolve_deep_analysis_result_for_date,
    resolve_deep_analysis_result_path,
)
from project_env import build_child_process_env, get_required_fetch_proxy
from utils import parse_analysis

BJ_TZ = timezone(timedelta(hours=8))
BEIJING_TIMESTAMP_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$'
)


class PublishLLMUnavailable(RuntimeError):
    """Raised when a required publish-time LLM review cannot run."""


class PublishDataValidationError(ValueError):
    """Raised when analysis data is unsafe or inconsistent for publishing."""


SCORING_RUBRIC_VERSION = 'type-aware-v1'
ALLOWED_DOCUMENT_TYPES = {
    '方法研究', '系统技术报告', '模型报告', '数据集与基准',
    '综述', '理论研究', '应用研究'
}
SCORING_DIMENSIONS = (
    ('innovationScore', '创新性', 2.0),
    ('technicalRigorScore', '技术严谨性', 1.5),
    ('experimentalSufficiencyScore', '实验充分性', 1.5),
    ('clarityScore', '清晰度', 1.0),
    ('impactScore', '影响力', 1.5),
    ('openSourceScore', '开源', 1.5),
    ('reproducibilityScore', '可复现性', 0.5),
    ('engineeringScore', '工程/实践价值', 1.5),
)
OPEN_SOURCE_SCORE_ANCHORS = {0.0, 0.2, 0.5, 1.0, 1.2, 1.5}
SCORING_COMPARE_FIELDS = (
    'score', 'documentType', 'scoringRubricVersion',
    *(field for field, _label, _maximum in SCORING_DIMENSIONS),
)
MANUAL_OVERRIDE_ALLOWED_FIELDS = frozenset(SCORING_COMPARE_FIELDS)
MANUAL_OVERRIDE_KEYS = frozenset({'type', 'source', 'reason', 'fields'})
EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION = 'bounded-v1'
EXPERIMENT_TABLE_CONTRACT_VERSION = 'evidence-rich-v2'
EXPERIMENT_TABLE_CONTRACT_VERSIONS = frozenset({
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
})
METHOD_DETAIL_CONTRACT_VERSION = 'detailed-v1'
IMAGE_NARRATIVE_CONTRACT_VERSION = 'context-bound-v1'
EDITORIAL_QUALITY_CONTRACT_VERSION = 'reader-facing-v1'
MANUAL_RESEARCH_CONTRACT_VERSION = 'audio-researcher-v1'
DIGEST_INDEX_READER_QUALITY_VERSION = 'reader-facing-v2'
MANUAL_DEPTH_CONTRACT_VERSION = 'full-text-evidence-v1'
MANUAL_DEPTH_CONTRACT_VERSION_V2 = 'full-text-evidence-v2'
MANUAL_DEPTH_CONTRACT_VERSION_V3 = 'full-text-evidence-v3'
MANUAL_DEPTH_CONTRACT_VERSION_V4 = 'full-text-evidence-v4'
MANUAL_DEPTH_CONTRACT_VERSION_V5 = 'full-text-evidence-v5'
MANUAL_DEPTH_CONTRACT_VERSION_V6 = 'full-text-evidence-v6'
MANUAL_V6_SIGNED_COMPATIBILITY_MODE = 'signed-v6-task-evidence-override-v1'
MANUAL_LONGFORM_CONTRACT_VERSION_V2 = 'reader-longform-v2'
MANUAL_ARTIFACT_PARSER_VERSION_V2 = 'manual-artifact-parser-v2-structured'
MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT = 'manual-paper-source-identity-v1'
MANUAL_DEPTH_CONTRACT_VERSIONS = frozenset({
    MANUAL_DEPTH_CONTRACT_VERSION,
    MANUAL_DEPTH_CONTRACT_VERSION_V2,
    MANUAL_DEPTH_CONTRACT_VERSION_V3,
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    MANUAL_DEPTH_CONTRACT_VERSION_V6,
})
MANUAL_READER_QUALITY_VERSIONS = frozenset({
    MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    MANUAL_DEPTH_CONTRACT_VERSION_V6,
})
MANUAL_COMPLETE_STATUS = 'manual_complete'
MANUAL_COMPLETE_PROVENANCE_VERSION = 2
MANUAL_PROVENANCE_PROTOCOL = 'manual-offline-review-v1'
MANUAL_STAGE_EXECUTION_KIND = 'manual_attestation'
MANUAL_V2_HARDENED_CUTOFF_DATE = '2026-08-22'
MANUAL_AUDIT_CHECKS = frozenset({
    'sourceCoverage', 'promptConformance', 'factualClaimsLedger', 'scoreRecomputed',
    'methodContract', 'tableContract', 'boilerplateScan', 'finalContract',
})
MANUAL_STAGE_EVIDENCE_STAGES = (
    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
    'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement',
)
MANUAL_BOILERPLATE_PATTERNS = (
    re.compile(r'从复现角度(?:看)?[，,:：]'),
    re.compile(r'这样的边界很重要'),
    re.compile(r'本文的实验和图示应'),
    re.compile(r'对于未报告的参数、?硬件、?随机种子或服务版本'),
    re.compile(r'应按数据流逐项复核'),
    re.compile(r'不能把整条流水线的收益都归因'),
    re.compile(r'对于多模态系统，还要区分'),
)
GENERIC_IMAGE_NARRATIVE_PATTERNS = (
    re.compile(r'论文的关键实验比较.*读图时需同时保留正文列出的数据集、指标方向和实验条件'),
    re.compile(r'这项视觉证据只支持图注与正文对应设置下的比较，不能外推为未测试条件中的统一结论'),
    re.compile(r'论文的系统结构或处理流程.*组件职责和数据流逐项对照'),
    re.compile(r'图中的箭头和分支用于说明已披露的组件关系，不代表正文未声明的额外训练阶段'),
    re.compile(r'论文的实现细节或数据示例.*核对实现条件与适用边界'),
    re.compile(r'图示用于补足实现语境，不替代论文未报告的配置、消融或部署测量'),
)
EXPERIMENT_TABLE_LIMITS = {
    'max_tables': 2,
    'max_data_rows': 12,
    'max_metric_columns': 8,
    'min_evidence_rows': 3,
    'min_numeric_cells': 2,
}
TABLE_IDENTIFIER_HEADER_RE = re.compile(
    r'(?:^|\b)(?:method|algorithm|approach|model|system|backbone|front[ -]?end|pipeline|'
    r'variant|representation|embedding|feature|encoder|baseline|'
    r'config(?:uration)?|dataset|corpus|benchmark|task|experiment|evaluation|test|'
    r'comparison|control|boundary|slice|subset|input|query|language|scenario|condition|setting|split|category|'
    r'type|modality|version|stage|phase|step|round|epoch|decoder|decode|context|metric|'
    r'measure)(?:\b|$)|方法|算法|方案|模型|系统|骨干|前端|流程|变体|表征|嵌入|特征|编码器|基线|'
    r'配置|数据集|语料|基准|任务|实验|检验|评估|测试|比较|对照|边界|切片|子集|输入|查询|题数|语言|场景|条件|设置|划分|类别|'
    r'类型|模态|版本|阶段|阶数|步骤|轮次|训练轮|解码|上下文|指标|度量',
    flags=re.IGNORECASE,
)
TABLE_VAGUE_METRIC_HEADER_RE = re.compile(
    r'^(?:结果|数值|数值变化|观察|观察结果|实际观测|报告结果|主要观察|说明|解释|含义|方向|关键条件|结论|结论边界|证据边界|应如何解读|对照或说明|对照或变化|结果或结论)$',
    flags=re.IGNORECASE,
)
TABLE_DIRECTION_MARK_RE = re.compile(
    r'(?:↑|↓|\\(?:uparrow|downarrow|nearrow|searrow)\b|越高越好|越低越好|higher\s+is\s+better|lower\s+is\s+better|max(?:imize)?|min(?:imize)?)',
    flags=re.IGNORECASE,
)
TABLE_DIRECTIONAL_METRIC_RE = re.compile(
    r'(?:accuracy|precision|recall|f[- ]?score|\bf1\b|\bwer\b|\bcer\b|\bder\b|\bauc\b|\bmap\b|\bmiou\b|\biou\b|\bpesq\b|\bstoi\b|\bsdr\b|\bsisdr\b|\bsnr\b|\bbleu\b|\brouge\b|\bmeteor\b|\bclap\b|\bfad\b|\brmse\b|\bmae\b|\berle\b|\bmos\b|准确率|精确率|召回率|错误率|误差|损失|延迟|耗时|速度|吞吐|内存|显存|功耗|能耗|复杂度|参数量|相关系数|相似度)',
    flags=re.IGNORECASE,
)
TABLE_NON_DIRECTIONAL_MEASURE_RE = re.compile(
    r'(?:置信区间|confidence interval|\bci\b|p[- ]?value|p值|显著性|样本数|数量|规模|时长|采样率|方差|标准差|系数|\bbeta\b|\bΔ?AIC\b|复杂度|参数|容量|内存|显存|耗时|延迟|速度|吞吐|功耗|能耗|bytes?|hours?|seconds?|milliseconds?)',
    flags=re.IGNORECASE,
)
TABLE_NUMERIC_CELL_RE = re.compile(
    r'(?:^|[^A-Za-z])[-+]?\d(?:[\d,]*)(?:\.\d+)?(?:\s*(?:%|pp|×|x|ms|s|h|Hz|kHz|MHz|GB|MB|KB|dB|mJ|W))?',
    flags=re.IGNORECASE,
)


def _extract_analysis_section(text, title):
    match = re.search(
        rf'(?:^|\n)##(?!#)\s*{re.escape(title)}[：:\s]*\n([\s\S]*?)(?=\n##(?!#)\s|$)',
        str(text or ''),
    )
    return match.group(1).strip() if match else ''


def _normalize_image_narrative_text(value):
    return re.sub(r'\s+', ' ', str(value or '')).strip()


def _validate_image_narrative_pair(lead, explanation):
    lead = _normalize_image_narrative_text(lead)
    explanation = _normalize_image_narrative_text(explanation)
    if len(lead) < 18 or len(explanation) < 30:
        return '图前阅读任务或图后解释过短'
    if not re.search(r'(?:下图|如下图|原图|图\s*\d+|下面的[^，。；]{0,24}图|图示)', lead) \
            or not re.search(r'(?:核对|观察|比较|追踪|辨认|判断|查看|阅读重点|验证|读图|看清|确认)', lead):
        return '图前文字没有提出针对该图的明确阅读任务'
    if any(pattern.search(lead) or pattern.search(explanation)
           for pattern in GENERIC_IMAGE_NARRATIVE_PATTERNS):
        return '图片邻文命中跨论文通用模板'
    if not re.search(r'(?:图中|图\s*\d+|图示|这个表示|这个比较|编码结构|染色体|基因|曲线|热图|色块|箭头|分支|波形|语谱图|频谱|样例|柱状|散点|轨迹|矩阵|流程)', explanation):
        return '图后文字没有指出图中实际可见的结构或对照'
    if not re.search(r'(?:仅|只|不能|不等于|不直接|未|边界|条件|范围|限于|仍需)', explanation):
        return '图后文字没有交代结论的条件或边界'
    return None


def validate_image_narrative_contract(paper):
    """Validate exact plan-to-canonical adjacency for context-bound image prose."""
    analysis = str(paper.get('analysis') or '')
    image_manifest = paper.get('imageManifest') or {}
    supplement = image_manifest.get('supplement') or {}
    plans = image_manifest.get('insertionPlan') or supplement.get('plans') or []
    diagnostics = image_manifest.get('insertionDiagnostics') or supplement.get('insertionDiagnostics') or []
    exclusions = paper.get('publishImageExclusions') or []
    excluded_urls = {
        item.get('url') for item in exclusions
        if isinstance(item, dict) and isinstance(item.get('url'), str)
    }
    excluded_numbers = {
        item.get('index', position + 1)
        for position, item in enumerate(image_manifest.get('selected') or [])
        if isinstance(item, dict) and item.get('url') in excluded_urls
    }
    if excluded_numbers:
        plans = [
            item for item in plans
            if not isinstance(item, dict) or item.get('imageNumber') not in excluded_numbers
        ]
        diagnostics = [
            item for item in diagnostics
            if not isinstance(item, dict) or item.get('imageNumber') not in excluded_numbers
        ]
    inserted_numbers = {
        item.get('imageNumber') for item in diagnostics
        if isinstance(item, dict) and item.get('inserted') is True
    }
    inserted_plans = [
        item for item in plans
        if isinstance(item, dict)
        and (not inserted_numbers or item.get('imageNumber') in inserted_numbers)
    ]
    selected = paper.get('selectedImageUrls')
    if not isinstance(selected, list):
        selected = [
            item.get('url') if isinstance(item, dict) else item
            for item in image_manifest.get('selected', [])
        ]
    selected = [str(url) for url in selected if isinstance(url, str) and url]
    if any(url in excluded_urls for url in selected):
        return '发布图片排除项仍残留在 selectedImageUrls'
    if len(inserted_plans) != len(selected):
        return f'插图计划与最终选图数量不一致: {len(inserted_plans)}/{len(selected)}'
    if not selected:
        return None

    blocks = [block.strip() for block in re.split(r'\n\s*\n', analysis) if block.strip()]
    occurrences = []
    for index, block in enumerate(blocks):
        match = re.fullmatch(r'!\[(?:\\.|[^\]\\])*\]\((https://[^)]+)\)', block)
        if match and match.group(1) in selected:
            occurrences.append((index, match.group(1)))
    occurrence_urls = [url for _index, url in occurrences]
    if occurrence_urls != selected:
        return '最终正文中的独立图片块 URL/顺序与 selectedImageUrls 不一致'

    manifest_version = image_manifest.get('version', 1)
    selected_manifest = image_manifest.get('selected') or []
    downloaded_manifest = image_manifest.get('downloaded') or []

    def manifest_item_url(item):
        if isinstance(item, dict):
            return item.get('url')
        return item if isinstance(item, str) else None

    def plan_url(plan):
        image_number = plan.get('imageNumber') if isinstance(plan, dict) else None
        if not isinstance(image_number, int) or image_number < 1:
            return None
        # Manual v2 manifests persist the final selected URL together with its
        # canonical image index.  API manifests historically kept selected as
        # strings, while imageNumber indexed the downloaded candidate array.
        for position, item in enumerate(selected_manifest):
            if not isinstance(item, dict):
                continue
            item_number = item.get('index', position + 1)
            if item_number == image_number:
                return manifest_item_url(item)
        if image_number <= len(downloaded_manifest):
            return manifest_item_url(downloaded_manifest[image_number - 1])
        if manifest_version < 2 and len(inserted_plans) == len(selected_manifest):
            ordered_numbers = [item.get('imageNumber') for item in inserted_plans]
            if ordered_numbers == list(range(1, len(inserted_plans) + 1)):
                return manifest_item_url(selected_manifest[image_number - 1])
        return None

    plans_by_url = {}
    unresolved_plans = []
    for plan in inserted_plans:
        bound_url = plan_url(plan)
        if bound_url and bound_url not in plans_by_url:
            plans_by_url[bound_url] = plan
        else:
            unresolved_plans.append(plan)
    strict_plan_binding = manifest_version >= 2 or not unresolved_plans

    for index, url in occurrences:
        if index == 0 or index + 1 >= len(blocks):
            return f'{url} 缺少图前或图后相邻正文'
        lead = _normalize_image_narrative_text(blocks[index - 1])
        explanation = _normalize_image_narrative_text(blocks[index + 1])
        issue = _validate_image_narrative_pair(lead, explanation)
        if issue:
            return f'{url} {issue}'
        plan = plans_by_url.get(url)
        if plan is None and not strict_plan_binding:
            # Compatibility for old unversioned API manifests that did not
            # retain the downloaded-candidate index needed to reconstruct the
            # URL -> imageNumber mapping.  New/versioned manifests never use
            # this prose-only fallback.
            matched_index = next((position for position, candidate in enumerate(unresolved_plans)
                                  if _normalize_image_narrative_text(candidate.get('lead')) == lead
                                  and _normalize_image_narrative_text(candidate.get('explanation')) == explanation), None)
            plan = unresolved_plans.pop(matched_index) if matched_index is not None else None
        if plan is None:
            return (
                f'{url} 没有绑定同一 URL/索引的已审计插图计划，'
                '相邻正文没有与已审计插图计划精确闭环'
            )
        if (_normalize_image_narrative_text(plan.get('lead')) != lead
                or _normalize_image_narrative_text(plan.get('explanation')) != explanation):
            return f'{url} 的相邻正文没有与已审计插图计划精确闭环'
        plans_by_url.pop(url, None)
    if plans_by_url or unresolved_plans:
        return '存在没有落入最终正文的已审计插图计划'
    return None


def _validate_manual_v5_all_rejected_images(paper, decisions, paper_label):
    """Allow zero Manual v5 images only after a complete, specific all-reject review.

    Keep this deliberately isomorphic with
    ``validateManualAllRejectedImageException`` in manual-research-contract.js.
    The record/spec gate has already established the researcher's figure review;
    publish must not add a different (and narrower) requirement such as a
    mobile-resolution defect or a caption token.  A paper-specific visual or
    technical anchor plus its stated editorial consequence is enough.
    """
    image_manifest = paper.get('imageManifest') or {}
    candidates = image_manifest.get('candidates') or []
    if not candidates:
        return
    selected_top_level = paper.get('selectedImageUrls')
    selected_manifest = image_manifest.get('selected') or []
    insertion_plan = image_manifest.get('insertionPlan') or []
    if (not isinstance(selected_top_level, list) or selected_top_level
            or selected_manifest or insertion_plan):
        raise PublishDataValidationError(
            f'{paper_label} manual v5 空选图例外必须同时绑定显式空 selectedImageUrls、空 selected 与空 insertionPlan'
        )
    candidate_urls = [item.get('url') for item in candidates if isinstance(item, dict)]
    decision_urls = [item.get('url') for item in decisions if isinstance(item, dict)]
    if (not candidate_urls or len(candidate_urls) != len(set(candidate_urls))
            or len(decision_urls) != len(candidate_urls)
            or len(decision_urls) != len(set(decision_urls))
            or set(decision_urls) != set(candidate_urls)):
        raise PublishDataValidationError(
            f'{paper_label} manual v5 空选图例外的 figureReview 未逐项覆盖全文候选图'
        )
    normalized_reasons = set()
    specific_anchor = re.compile(
        r'\b\d{2,}\s*[×x]\s*\d{2,}\b'
        r'|[A-Za-z][A-Za-z0-9_-]{1,}'
        r'|(?:流程图|热图|散点|谱图|曲线|坐标|标签|面板|图注|模型|分类器|特征|数据集|设备|录音机|基线图|示意图|系统总览|矩阵|分布|公式|箭头|分桶|点位|声码器)',
        re.I,
    )
    generic_short_conclusion = re.compile(
        r'^(?:该图)?(?:不适合|不需要|无价值|移动端不可读|与正文重复)[，。；;\s]*(?:故)?(?:不选|拒绝)?[。.]?$',
    )
    for index, decision in enumerate(decisions):
        if not isinstance(decision, dict) or decision.get('decision') != 'reject':
            raise PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外必须全部为 reject，不能夹带 select'
            )
        reason = str(decision.get('reason') or '').strip()
        if len(reason) < 40:
            raise PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外的 reject 理由不足 40 字'
            )
        normalized_reason = _normalize_manual_evidence(reason).lower()
        if normalized_reason in normalized_reasons:
            raise PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外的第 {index + 1} 条理由不得跨图复用同一拒绝模板'
            )
        normalized_reasons.add(normalized_reason)
        if not specific_anchor.search(reason) or generic_short_conclusion.fullmatch(reason):
            raise PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外的第 {index + 1} 条理由不是论文特有的像素/缓存/图注事实与论证影响'
            )


def _validate_publish_image_exclusion_view(paper, paper_label):
    """Validate the explicit reader-facing view derived from image exclusions."""
    exclusions = paper.get('publishImageExclusions')
    view = paper.get('publishImageExclusionView')
    if not isinstance(exclusions, list) or not exclusions:
        if view is not None:
            raise PublishDataValidationError(
                f'{paper_label} 无图片排除项却携带 publishImageExclusionView'
            )
        return
    if not isinstance(view, dict):
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除后的派生视图凭证缺失或字段非法'
        )
    version = view.get('version')
    expected_keys = {
        1: {
            'version', 'sourceAnalysisSha256', 'analysisSha256', 'excludedUrls',
            'effectiveSelectedImageUrls', 'imageNarrativeContract',
        },
        2: {
            'version', 'sourceAnalysisSha256', 'analysisSha256',
            'sourceApiReaderArticleSha256', 'apiReaderArticleSha256',
            'sourceApiReaderFiguresSha256', 'apiReaderFiguresSha256',
            'excludedUrls', 'effectiveSelectedImageUrls',
            'effectiveApiReaderFigureUrls', 'imageNarrativeContract',
        },
    }.get(version)
    if expected_keys is None or set(view) != expected_keys \
            or view.get('imageNarrativeContract') != IMAGE_NARRATIVE_CONTRACT_VERSION:
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除后的派生视图版本或图片契约非法'
        )
    source_sha = view.get('sourceAnalysisSha256')
    current_sha = view.get('analysisSha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')) \
            or not re.fullmatch(r'[0-9a-f]{64}', str(current_sha or '')):
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除后的正文 SHA 非法'
        )
    analysis = str(paper.get('analysis') or '')
    expected_current_sha = hashlib.sha256(analysis.encode('utf-8')).hexdigest()
    if current_sha != expected_current_sha:
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除后的正文 SHA 与当前 analysis 不一致'
        )
    excluded_urls = [
        item.get('url') for item in exclusions
        if isinstance(item, dict) and isinstance(item.get('url'), str)
    ]
    if len(excluded_urls) != len(exclusions) or view.get('excludedUrls') != excluded_urls:
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除后的 URL 集合与排除声明不一致'
        )
    selected = paper.get('selectedImageUrls')
    if not isinstance(selected, list) \
            or view.get('effectiveSelectedImageUrls') != selected:
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除后的选图快照与 selectedImageUrls 不一致'
        )
    if any(url in analysis for url in excluded_urls):
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除 URL 仍残留在读者正文'
        )
    if version == 2:
        article = paper.get('apiReaderArticle')
        figures = paper.get('apiReaderFigures')
        if not isinstance(article, str) or not article.strip() or not isinstance(figures, list):
            raise PublishDataValidationError(
                f'{paper_label} API reader 发布图片排除后缺少正文或 figure 数组'
            )
        article_sha = hashlib.sha256(article.encode('utf-8')).hexdigest()
        figures_sha = hashlib.sha256(json.dumps(
            figures, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
        ).encode('utf-8')).hexdigest()
        for field in ('sourceApiReaderArticleSha256', 'sourceApiReaderFiguresSha256'):
            if not re.fullmatch(r'[0-9a-f]{64}', str(view.get(field) or '')):
                raise PublishDataValidationError(
                    f'{paper_label} API reader 发布图片排除前来源 SHA 非法'
                )
        if view.get('apiReaderArticleSha256') != article_sha \
                or view.get('apiReaderFiguresSha256') != figures_sha:
            raise PublishDataValidationError(
                f'{paper_label} API reader 发布图片排除后的正文/figure SHA 不一致'
            )
        effective_urls = [
            item.get('url') for item in figures if isinstance(item, dict)
        ]
        if len(effective_urls) != len(figures) \
                or view.get('effectiveApiReaderFigureUrls') != effective_urls:
            raise PublishDataValidationError(
                f'{paper_label} API reader 发布图片排除后的 figure URL 快照不一致'
            )
        if any(url in article or url in effective_urls for url in excluded_urls):
            raise PublishDataValidationError(
                f'{paper_label} API reader 发布图片排除 URL 仍残留在正文或 figure 数组'
            )
        stage = paper.get('analysisManifest', {}).get('stages', {}).get('apiReaderArticle', {})
        if stage.get('articleSha256') != article_sha \
                or stage.get('figureCount') != len(figures) \
                or stage.get('figuresSha256') != figures_sha:
            raise PublishDataValidationError(
                f'{paper_label} API reader 发布图片排除后的 stage 未闭环'
            )
    manifest = paper.get('analysisManifest')
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    if isinstance(takeover, dict) and takeover.get('analysisSha256') != source_sha:
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除前正文 SHA 与 Manual canonical 不一致'
        )


def _manual_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def _manual_paper_identity_mode(contracts, paper_label='paper'):
    contracts = contracts if isinstance(contracts, dict) else {}
    identity_marker = contracts.get('paperSourceIdentity')
    if identity_marker is None:
        if contracts.get('freshAuthoring') is not None \
                or contracts.get('tutorialPayload') is not None:
            raise PublishDataValidationError(
                f'{paper_label} fresh/tutorial canonical 缺少逐论文来源身份'
            )
        return 'historical_per_entry'
    if identity_marker != MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT:
        raise PublishDataValidationError(
            f'{paper_label} 逐论文来源身份契约标记非法'
        )
    return 'per_paper_v1'


MANUAL_V6_SIGNATURE_CONTRACT = 'stable-json-ascii-keys-exact-ieee754-nfkc-text-v2'


def _manual_v6_signature_value(value, label='manual-v6-signature'):
    """Canonical v6 signature input shared with manual-signature-contract.js.

    Object keys are deliberately restricted to visible ASCII. Safe integers
    remain ordinary JSON integers; finite floats are serialized later from
    their IEEE-754 bits as exact decimal JSON numbers. Unicode remains fully
    supported in string values; NFKC text normalization is explicit in
    ``_manual_v6_text`` rather than an invisible mutation of signed JSON.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise PublishDataValidationError(f'{label} 含非法 Unicode 代理项')
        return value
    if isinstance(value, int):
        if abs(value) > (2 ** 53 - 1):
            raise PublishDataValidationError(f'{label} 含非安全整数')
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or (value == 0.0 and math.copysign(1.0, value) < 0):
            raise PublishDataValidationError(f'{label} 签名对象禁止 NaN/Infinity 或负零')
        if value.is_integer() and abs(value) > (2 ** 53 - 1):
            raise PublishDataValidationError(f'{label} 含非安全整数')
        return value
    if isinstance(value, list):
        return [
            _manual_v6_signature_value(item, f'{label}[{index}]')
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise PublishDataValidationError(f'{label} 签名对象 key 必须是字符串')
        result = {}
        for key in sorted(value):
            if not key or any(ord(character) < 0x20 or ord(character) > 0x7E for character in key):
                raise PublishDataValidationError(f'{label} 签名对象 key 必须是可见 ASCII')
            result[key] = _manual_v6_signature_value(value[key], f'{label}.{key}')
        return result
    raise PublishDataValidationError(f'{label} 含不可签名类型: {type(value).__name__}')


def _manual_v6_number_text(value):
    if isinstance(value, int):
        return str(value)
    bits = struct.unpack('>Q', struct.pack('>d', value))[0]
    negative = bits >> 63 == 1
    exponent_bits = (bits >> 52) & 0x7FF
    fraction = bits & ((1 << 52) - 1)
    significand = fraction if exponent_bits == 0 else (1 << 52) | fraction
    exponent2 = -1074 if exponent_bits == 0 else exponent_bits - 1023 - 52
    scale = 0
    if exponent2 >= 0:
        digits = significand << exponent2
    else:
        scale = -exponent2
        digits = significand * (5 ** scale)
        while scale > 0 and digits % 10 == 0:
            digits //= 10
            scale -= 1
    text = str(digits)
    if scale > 0:
        text = text.rjust(scale + 1, '0')
        text = f'{text[:-scale]}.{text[-scale:]}'
    return f'-{text}' if negative else text


def _manual_v6_canonical_json(value):
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, (int, float)):
        return _manual_v6_number_text(value)
    if isinstance(value, list):
        return '[' + ','.join(_manual_v6_canonical_json(item) for item in value) + ']'
    return '{' + ','.join(
        f'{json.dumps(key, ensure_ascii=False)}:{_manual_v6_canonical_json(value[key])}'
        for key in sorted(value)
    ) + '}'


def _manual_v6_hash(value):
    canonical = _manual_v6_signature_value(value)
    encoded = _manual_v6_canonical_json(canonical).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


_MANUAL_V6_SHA_FIELDS = (
    'specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
    'recordFileSha256', 'artifactIndexSha256', 'artifactIndexFileSha256',
    'recordsEnvelopeFileSha256', 'taskEvidenceSha256', 'readerLongformSha256',
    'readerLongformArticleSha256',
)
_MANUAL_V6_BLOCK_KINDS = frozenset({
    'prerequisites', 'problem', 'related_work', 'signal_path', 'architecture',
    'component', 'training', 'formula', 'experiment_setup', 'result',
    'ablation', 'negative_result', 'reproduction', 'limitation', 'synthesis',
})


def _manual_v6_signed_compatibility(paper, manifest=None):
    if not isinstance(paper, dict):
        return False
    manifest = manifest if isinstance(manifest, dict) else paper.get('analysisManifest')
    if not isinstance(manifest, dict):
        return False
    contracts = manifest.get('contracts')
    takeover = manifest.get('manualTakeover')
    acquisition = manifest.get('sourceAcquisition')
    provenance = paper.get('manualV6Provenance')
    return (
        paper.get('manualV6CompatibilityMode') == MANUAL_V6_SIGNED_COMPATIBILITY_MODE
        and isinstance(contracts, dict)
        and contracts.get('manualDepth') == MANUAL_DEPTH_CONTRACT_VERSION_V6
        and paper.get('manualDepth') == MANUAL_DEPTH_CONTRACT_VERSION_V6
        and isinstance(provenance, dict)
        and provenance.get('runtimeMode') == 'production'
        and provenance.get('v5BridgeMode') == MANUAL_V6_SIGNED_COMPATIBILITY_MODE
        and isinstance(takeover, dict)
        and takeover.get('v6Provenance') == provenance
        and isinstance(acquisition, dict)
        and acquisition.get('v5BridgeMode') == MANUAL_V6_SIGNED_COMPATIBILITY_MODE
    )


def _manual_v6_text(value):
    return unicodedata.normalize(
        'NFKC', '' if value is None else str(value),
    ).replace('\r\n', '\n').replace('\r', '\n').strip()


def _manual_v6_article_uses_term(article, value):
    term = _manual_v6_text(value)
    if len(term) < 2:
        return False
    return re.search(
        rf'(^|[^A-Za-z0-9]){re.escape(term)}(?=$|[^A-Za-z0-9])', article,
    ) is not None


def _manual_v6_text_sha(value):
    # manual-longform-contract.js hashes String(value) bytes directly.  Object
    # identities (ArtifactIndex/workflow) use stable JSON via ``_manual_hash``.
    return hashlib.sha256(str(value or '').encode('utf-8')).hexdigest()


def _manual_v6_require_text(value, label, minimum=1):
    text = _manual_v6_text(value)
    if len(text) < minimum:
        raise PublishDataValidationError(f'{label} 至少需要 {minimum} 个字符')
    return text


def _manual_v6_is_pure_markdown_table_paragraph(value):
    lines = [line.strip() for line in _manual_v6_text(value).splitlines() if line.strip()]
    return len(lines) >= 2 and all(line.startswith('|') and line.endswith('|') for line in lines)


def _manual_v6_sanitize_table_cell(value):
    text = _manual_v6_text(value)
    text = re.sub(r'(binary \{0,1\})\\\{0,1\\\}', r'\1', text)
    text = re.sub(r'U\u200b?\{3,\.\.\.,7\}\\mathcal\{U\}\\\{3,\\ldots,7\\\}', 'U{3,...,7}', text)
    text = text.replace('F1F_{1}', 'F1').replace('α\\alpha', 'α').replace('ρ\\rho', 'ρ')
    text = text.replace('r1r_{1}', 'r1')
    text = text.replace('κmax=α\\kappa_{\\max}=\\sqrt{\\alpha}', 'κ_max = √α')
    text = re.sub(r'r1\u200b?α\\sqrt\{r_\{1\}\\alpha\}', '√(r1 α)', text)
    text = re.sub(r'(\d+)×(\d+)\1\\times\s*\2', r'\1×\2', text)
    text = re.sub(r'[∼~](\d+(?:\.\d+)?)\{\\sim\}\1', r'~\1', text)
    text = re.sub(r'≈(\d+(?:\.\d+)?)\\approx\s*\1', r'≈\1', text)
    text = re.sub(r'(p=0\.5)\1', r'\1', text)
    text = re.sub(r'\b([123]\.0)\1(?=\s*s\b)', r'\1', text)
    text = re.sub(r'\b(n=\d+)\1\b', r'\1', text)
    text = re.sub(r'\+([0-9]+(?:\.[0-9]+)?)\+\1', r'+\1', text)
    text = re.sub(r'−([0-9]+(?:\.[0-9]+)?)-\1', r'−\1', text)
    text = re.sub(r'(?<![\d.])(\d+\.\d+)\1(?![\d.])', r'\1', text)
    text = re.sub(r'\[−(\d+(?:\.\d+)?)(,[^\]]+)\]\[-\1\2\]', r'[−\1\2]', text)
    text = re.sub(r'(\d+)%\1\\%', r'\1%', text)
    text = re.sub(r'(\[[^\]]+\])\1', r'\1', text)
    text = text.replace('++', '+').replace('−-', '−')

    def collapse_numeric(match):
        token = match.group(0)
        if '.' not in token and len(token) < 4:
            return token
        for split in range(1, len(token)):
            if token[:split] == token[split:]:
                return token[:split]
        return token

    return re.sub(r'(?<![\d.])\d+(?:\.\d+)?(?![\d.])', collapse_numeric, text)


def _manual_v6_render_table(table):
    matrix = table.get('matrix') if isinstance(table, dict) else None
    if not isinstance(matrix, list) or not matrix or any(not isinstance(row, list) or not row for row in matrix):
        raise PublishDataValidationError(f'{(table or {}).get("id", "unknown table")} 缺少可确定性渲染矩阵')
    width = max(len(row) for row in matrix)
    rows = []
    for row in matrix:
        rows.append([
            row[index] if index < len(row) else ''
            for index in range(width)
        ])
    header_text = [_manual_v6_text(cell) for cell in rows[0]]
    active_contrast_column = None
    routed = []
    for row_index, row in enumerate(rows):
        if row_index == 0:
            routed.append(row)
            continue
        populated = [_manual_v6_text(cell) for cell in row if _manual_v6_text(cell)]
        if len(populated) == width and len(set(populated)) == 1:
            sample = re.search(r'\bn=(\d+)', populated[0], re.I)
            active_contrast_column = next(
                (index for index, cell in enumerate(header_text)
                 if sample and f'n={sample.group(1)}' in cell), None,
            )
            routed.append([row[0], *([''] * (width - 1))])
            continue
        first = _manual_v6_sanitize_table_cell(row[0])
        if (isinstance(active_contrast_column, int) and active_contrast_column > 0
                and re.fullmatch(r'[A-Z]\s*[−-]\s*[A-Z]', first)):
            value = next((cell for cell in row[1:] if _manual_v6_text(cell)), '')
            output = [''] * width
            output[0] = row[0]
            output[active_contrast_column] = value
            routed.append(output)
            continue
        routed.append(row)
    normalized = []
    for row in routed:
        escaped = [
            _manual_v6_sanitize_table_cell(cell).replace('|', r'\|').replace('\n', '<br>')
            for cell in row
        ]
        populated = [cell for cell in escaped if cell]
        normalized.append(
            [populated[0], *([''] * (width - 1))]
            if len(populated) > 1 and len(set(populated)) == 1 else escaped
        )
    caption = _manual_v6_sanitize_table_cell(table.get('caption') or table.get('id') or '实验表格')
    return '\n'.join([
        f'**{caption}**', '', f'| {" | ".join(normalized[0])} |',
        f'| {" | ".join(["---"] * width)} |',
        *(f'| {" | ".join(row)} |' for row in normalized[1:]),
    ])


def _manual_v6_numeric_cell_ids(table):
    table_id = str(table.get('id') or table.get('sourceTableId') or '').strip()
    result = []
    for row_index, row in enumerate(table.get('matrix') or []):
        for column_index, raw_cell in enumerate(row if isinstance(row, list) else []):
            cell = _manual_v6_text(raw_cell)
            if not re.search(r'(?:^|[^A-Za-z])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)', cell):
                continue
            result.append(
                f'{table_id}:r{row_index}:c{column_index}:{_manual_v6_text_sha(cell)[:12]}'
            )
    return result


def _manual_v6_inventory_ids(index, field):
    result = {}
    for position, item in enumerate(index.get(field) or []):
        if not isinstance(item, dict):
            raise PublishDataValidationError(f'ArtifactIndex.{field}[{position}] 必须是对象')
        item_id = str(item.get('id') or item.get('sourceTableId') or item.get('url') or '').strip()
        if not item_id or item_id in result:
            raise PublishDataValidationError(f'ArtifactIndex.{field} ID 缺失或重复')
        result[item_id] = item
    return result


def validate_manual_v6_payload(paper):
    """Validate and deterministically replay a canonical Manual v6 article.

    The returned article is built exclusively from controlled longform blocks.
    A legacy ``manualTakeover.readerArticle`` is only an optional equality
    witness and is never a rendering input.
    """
    if not isinstance(paper, dict):
        raise PublishDataValidationError('Manual v6 canonical 论文必须是对象')
    paper_label = str(paper.get('arxivId') or paper.get('id') or '<unknown paper>')
    paper_id = normalize_publish_arxiv_id(paper_label)
    manifest = paper.get('analysisManifest')
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if not isinstance(contracts, dict) or contracts.get('manualDepth') != MANUAL_DEPTH_CONTRACT_VERSION_V6:
        raise PublishDataValidationError(f'{paper_label} 未声明 Manual v6')
    required_contracts = {
        'readerLongform': MANUAL_LONGFORM_CONTRACT_VERSION_V2,
        'artifactIndex': MANUAL_ARTIFACT_PARSER_VERSION_V2,
        'experimentTables': EXPERIMENT_TABLE_CONTRACT_VERSION,
        'researcherFocus': MANUAL_RESEARCH_CONTRACT_VERSION,
        'perPaperSubagent': 'isolated-single-paper-v1',
        'authorLineage': 'original-author-final-revision-v1',
    }
    for key, expected in required_contracts.items():
        if contracts.get(key) != expected:
            raise PublishDataValidationError(f'{paper_label} Manual v6 contracts.{key} 必须为 {expected}')
    if paper.get('manualDepth') != MANUAL_DEPTH_CONTRACT_VERSION_V6:
        raise PublishDataValidationError(f'{paper_label} canonical manualDepth 与 contracts 不一致')

    artifact = paper.get('manualArtifactIndex')
    bundle = paper.get('manualReaderLongform')
    provenance = paper.get('manualV6Provenance')
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    takeover_provenance = takeover.get('v6Provenance') if isinstance(takeover, dict) else None
    acquisition = manifest.get('sourceAcquisition') if isinstance(manifest, dict) else None
    if not all(isinstance(value, dict) for value in (artifact, bundle, provenance, takeover_provenance, acquisition)):
        raise PublishDataValidationError(f'{paper_label} Manual v6 artifact/longform/provenance 不完整')
    if provenance.get('specVersion') != 6 or takeover_provenance != provenance:
        raise PublishDataValidationError(f'{paper_label} Manual v6 provenance 副本不一致')
    if provenance.get('runtimeMode') != 'production':
        raise PublishDataValidationError(
            f'{paper_label} Manual v6 canonical 不是 production runtime；shadow 禁止发布'
        )
    if provenance.get('readerLongformContract') != MANUAL_LONGFORM_CONTRACT_VERSION_V2:
        raise PublishDataValidationError(f'{paper_label} Manual v6 readerLongformContract 非法')
    for field in _MANUAL_V6_SHA_FIELDS:
        value = str(provenance.get(field) or '')
        if not re.fullmatch(r'[a-f0-9]{64}', value):
            raise PublishDataValidationError(f'{paper_label} manualV6Provenance.{field} 非法')
        if field in acquisition and acquisition.get(field) != value:
            raise PublishDataValidationError(f'{paper_label} sourceAcquisition.{field} 与 v6 provenance 不一致')
    for field in ('specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
                  'recordFileSha256', 'artifactIndexSha256', 'artifactIndexFileSha256'):
        if acquisition.get(field) != provenance[field]:
            raise PublishDataValidationError(f'{paper_label} sourceAcquisition 缺少 {field} 的强绑定')

    if (artifact.get('version') != 1
            or artifact.get('parserVersion') != MANUAL_ARTIFACT_PARSER_VERSION_V2
            or normalize_publish_arxiv_id(artifact.get('paperId')) != paper_id):
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex 版本/parser/paperId 非法')
    input_identity = artifact.get('inputIdentity')
    if not isinstance(input_identity, dict):
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex.inputIdentity 缺失')
    for field in ('sourceSha256', 'sourceIdentitySha256', 'paperInputSha256'):
        value = str(input_identity.get(field) or '')
        if not re.fullmatch(r'[a-f0-9]{64}', value) or acquisition.get(field) != value:
            raise PublishDataValidationError(f'{paper_label} ArtifactIndex.inputIdentity.{field} 未绑定 sourceAcquisition')
    if not isinstance(artifact.get('inventoryHealth'), dict) \
            or artifact['inventoryHealth'].get('status') != 'complete':
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex inventory 未完整恢复，禁止发布 v6')
    for field in ('sections', 'tables', 'figures', 'formulas', 'references', 'acronyms',
                  'citations', 'baselines', 'datasets', 'metrics', 'sourceSpans'):
        if not isinstance(artifact.get(field), list):
            raise PublishDataValidationError(f'{paper_label} ArtifactIndex.{field} 缺失')
    if artifact.get('images') != artifact.get('figures'):
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex images/figures 兼容投影不一致')
    payload = {key: value for key, value in artifact.items()
               if key not in {'artifactIndexSha256', 'outputSha256'}}
    artifact_sha = _manual_v6_hash(payload)
    if (artifact.get('artifactIndexSha256') != artifact_sha
            or artifact.get('outputSha256') != artifact_sha
            or provenance.get('artifactIndexSha256') != artifact_sha):
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex semantic SHA 漂移')
    counts = artifact.get('counts')
    if not isinstance(counts, dict):
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex.counts 缺失')
    for field in ('sections', 'tables', 'figures', 'formulas', 'references', 'acronyms',
                  'citations', 'baselines', 'datasets', 'metrics'):
        if counts.get(field) != len(artifact[field]):
            raise PublishDataValidationError(f'{paper_label} ArtifactIndex.counts.{field} 不闭环')
    if counts.get('images') != len(artifact['figures']):
        raise PublishDataValidationError(f'{paper_label} ArtifactIndex.counts.images 不闭环')

    if (bundle.get('version') != 2
            or bundle.get('contract') != MANUAL_LONGFORM_CONTRACT_VERSION_V2
            or normalize_publish_arxiv_id(bundle.get('paperId')) != paper_id
            or bundle.get('artifactIndexSha256') != artifact_sha):
        raise PublishDataValidationError(f'{paper_label} reader-longform-v2 身份绑定非法')
    bundle_sha = _manual_v6_hash(bundle)
    if (provenance.get('readerLongformSha256') != bundle_sha
            or acquisition.get('readerLongformSha256') != bundle_sha):
        raise PublishDataValidationError(f'{paper_label} reader-longform-v2 semantic SHA 漂移')
    blocks = bundle.get('blocks')
    if not isinstance(blocks, list) or not 6 <= len(blocks) <= 32:
        raise PublishDataValidationError(f'{paper_label} reader-longform-v2 blocks 必须为 6-32 个')
    block_by_id = {}
    source_ids = {item['id'] for item in artifact['sourceSpans'] if isinstance(item, dict) and item.get('id')}
    signed_legacy_projection = _manual_v6_signed_compatibility(paper, manifest)
    inventory = {field: _manual_v6_inventory_ids(artifact, field)
                 for field in ('tables', 'figures', 'formulas', 'acronyms', 'citations')}
    positions = {}
    for position, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise PublishDataValidationError(f'{paper_label} blocks[{position}] 必须是对象')
        block_id = _manual_v6_require_text(block.get('id'), f'{paper_label}.blocks[{position}].id', 2)
        if block_id in block_by_id or block.get('kind') not in _MANUAL_V6_BLOCK_KINDS:
            raise PublishDataValidationError(f'{paper_label} block ID 重复或 kind 非法')
        _manual_v6_require_text(block.get('heading'), f'{paper_label}.{block_id}.heading', 6)
        _manual_v6_require_text(block.get('learningObjective'), f'{paper_label}.{block_id}.learningObjective', 12)
        markdown = _manual_v6_require_text(block.get('markdown'), f'{paper_label}.{block_id}.markdown', 100)
        if len(markdown) > 4000 or any(
                len(_manual_v6_text(item)) > 1200
                and not _manual_v6_is_pure_markdown_table_paragraph(item)
                for item in re.split(r'\n\s*\n', markdown)):
            raise PublishDataValidationError(f'{paper_label}.{block_id} 过长，未形成递进 block')
        if re.search(r'(?:sourceBindings|readerBindings|evidenceLedger|resultClaims|schema|字段串)', markdown, re.I):
            raise PublishDataValidationError(f'{paper_label}.{block_id} 泄露内部 schema 语言')
        reference_fields = (('evidenceSpanIds', source_ids), ('tableIds', set(inventory['tables'])),
                            ('figureIds', set(inventory['figures'])), ('formulaIds', set(inventory['formulas'])))
        for field, allowed in reference_fields:
            values = block.get(field, [])
            if not isinstance(values, list) or len(values) != len(set(values)) or any(value not in allowed for value in values):
                raise PublishDataValidationError(f'{paper_label}.{block_id}.{field} 引用非法')
        block_by_id[block_id] = block
        positions.setdefault(block['kind'], position)
    method_positions = [positions[kind] for kind in ('signal_path', 'architecture', 'component') if kind in positions]
    result_positions = [positions[kind] for kind in ('result', 'ablation', 'negative_result') if kind in positions]
    required_kinds = {'prerequisites', 'problem', 'related_work', 'reproduction', 'limitation'}
    if str((paper.get('parsed') or {}).get('documentType') or '') != '理论研究':
        required_kinds.update({'training', 'experiment_setup'})
    if (not required_kinds.issubset(positions) or not method_positions or not result_positions
            or not (positions['problem'] < min(method_positions) < min(result_positions) < positions['limitation'])):
        raise PublishDataValidationError(f'{paper_label} v6 正文未按问题→方法→结果→边界递进')
    article = '\n\n'.join(
        f'### {_manual_v6_text(block["heading"])}\n\n{_manual_v6_text(block["markdown"])}'
        for block in blocks
    )
    article_sha = _manual_v6_text_sha(article)
    if bundle.get('articleSha256') != article_sha:
        raise PublishDataValidationError(f'{paper_label} longform article SHA 与 blocks 重放不一致')
    if provenance.get('readerLongformArticleSha256') != article_sha:
        raise PublishDataValidationError(f'{paper_label} provenance 未绑定 longform article SHA')
    if isinstance(takeover.get('readerArticle'), str) \
            and _manual_v6_text(takeover['readerArticle']) != article:
        raise PublishDataValidationError(f'{paper_label} 兼容 readerArticle 与受控 blocks 不一致')
    if takeover.get('readerArticleSha256') not in (None, article_sha):
        raise PublishDataValidationError(f'{paper_label} 兼容 readerArticleSha256 与 blocks 不一致')

    receipt = bundle.get('authorReceipt')
    if (not isinstance(receipt, dict) or normalize_publish_arxiv_id(receipt.get('paperId')) != paper_id
            or receipt.get('singlePaperOnly') is not True or receipt.get('isolatedContext') is not True
            or receipt.get('model') != 'gpt-5.6-terra' or receipt.get('reasoningEffort') != 'high'
            or not re.fullmatch(r'[a-f0-9]{64}', str(receipt.get('articleSha256') or ''))
            or not re.fullmatch(r'[a-f0-9]{64}', str(receipt.get('inputPacketSha256') or ''))
            or not isinstance(receipt.get('revision'), int) or receipt['revision'] < 1):
        raise PublishDataValidationError(f'{paper_label} v6 authorReceipt 未绑定 Terra-high 单篇初稿')
    _manual_v6_require_text(receipt.get('taskName'), f'{paper_label}.authorReceipt.taskName', 4)
    final_receipt = bundle.get('finalRevisionAuthorReceipt')
    if (not isinstance(final_receipt, dict)
            or final_receipt.get('role') != 'author_revision'
            or normalize_publish_arxiv_id(final_receipt.get('paperId')) != paper_id
            or final_receipt.get('singlePaperOnly') is not True
            or final_receipt.get('isolatedContext') is not True
            or final_receipt.get('model') != 'gpt-5.6-terra'
            or final_receipt.get('reasoningEffort') != 'high'
            or final_receipt.get('articleSha256') != article_sha
            or not re.fullmatch(r'[a-f0-9]{64}', str(final_receipt.get('consumedPacketSha256') or ''))
            or not re.fullmatch(r'[a-f0-9]{64}', str(final_receipt.get('outputSha256') or ''))
            or not isinstance(final_receipt.get('revision'), int)
            or final_receipt['revision'] < 1):
        raise PublishDataValidationError(
            f'{paper_label} finalRevisionAuthorReceipt 未绑定最终 readerArticle'
        )
    _manual_v6_require_text(
        final_receipt.get('taskName'), f'{paper_label}.finalRevisionAuthorReceipt.taskName', 4
    )
    if final_receipt['taskName'] == receipt['taskName']:
        raise PublishDataValidationError(f'{paper_label} 初稿 author 与最终 author_revision taskName 重复')
    for receipt_name, current_receipt in (
            ('authorReceipt', receipt), ('finalRevisionAuthorReceipt', final_receipt)):
        times = []
        for field in ('queuedAt', 'startedAt', 'completedAt'):
            value = str(current_receipt.get(field) or '')
            if not BEIJING_TIMESTAMP_RE.fullmatch(value):
                raise PublishDataValidationError(f'{paper_label} {receipt_name}.{field} 非北京时间')
            times.append(datetime.fromisoformat(value))
        if not times[0] <= times[1] <= times[2]:
            raise PublishDataValidationError(f'{paper_label} {receipt_name} 时间顺序非法')
    task_names = provenance.get('taskNames')
    expected_task_name_keys = {
        'author', 'technicalScoring', 'pedagogyReadability', 'authorRevision'
    }
    if (not isinstance(task_names, dict) or set(task_names) != expected_task_name_keys
            or len(set(task_names.values())) != 4
            or task_names.get('author') != receipt.get('taskName')
            or task_names.get('authorRevision') != final_receipt.get('taskName')):
        raise PublishDataValidationError(f'{paper_label} v6 四任务 author/reviewer lineage 不闭环')

    table_dispositions = bundle.get('tables')
    if not isinstance(table_dispositions, list):
        raise PublishDataValidationError(f'{paper_label} v6 tables 处置表缺失')
    seen = set()
    deterministic_tables = []
    for item in table_dispositions:
        if not isinstance(item, dict) or item.get('sourceTableId') in seen:
            raise PublishDataValidationError(f'{paper_label} v6 table disposition 非法或重复')
        table_id = str(item.get('sourceTableId') or '')
        source = inventory['tables'].get(table_id)
        seen.add(table_id)
        if not source or item.get('disposition') not in {'inline', 'appendix', 'omit'}:
            raise PublishDataValidationError(f'{paper_label} v6 table 不属于 ArtifactIndex')
        matrix_sha = _manual_v6_hash(source.get('matrix'))
        if (source.get('matrixSha256') != matrix_sha
                or item.get('sourceMatrixSha256') != matrix_sha):
            raise PublishDataValidationError(f'{paper_label} {table_id} matrix SHA 漂移')
        expected_cells = _manual_v6_numeric_cell_ids(source)
        covered = item.get('coveredNumericCellIds')
        if not isinstance(covered, list) or len(covered) != len(set(covered)):
            raise PublishDataValidationError(f'{paper_label} {table_id} 数值单元格绑定非法')
        if source.get('kind') == 'result' and (item.get('disposition') == 'omit' or set(covered) != set(expected_cells)):
            raise PublishDataValidationError(f'{paper_label} {table_id} 结果表未逐数值完整覆盖')
        if item.get('disposition') != 'omit':
            block = block_by_id.get(item.get('blockId'))
            rendered = (
                _manual_v6_text(item.get('renderedMarkdown'))
                if signed_legacy_projection else _manual_v6_render_table(source)
            )
            if (not block or item.get('renderedMarkdown') != rendered
                    or item.get('renderedFragmentSha256') != _manual_v6_text_sha(rendered)
                    or rendered not in _manual_v6_text(block.get('markdown'))):
                raise PublishDataValidationError(f'{paper_label} {table_id} 未由矩阵确定性渲染进入绑定 block')
            deterministic_tables.append(rendered)
        elif len(_manual_v6_text(item.get('omissionReason'))) < 24:
            raise PublishDataValidationError(f'{paper_label} {table_id} 省略原因过短')
    if seen != set(inventory['tables']):
        raise PublishDataValidationError(f'{paper_label} v6 未逐项处置全部表格')

    def validate_dispositions(field, inventory_field, *, figures=False, formulas=False):
        items = bundle.get(field)
        if not isinstance(items, list):
            raise PublishDataValidationError(f'{paper_label} v6 {field} 处置表缺失')
        handled = set()
        for item in items:
            if not isinstance(item, dict):
                raise PublishDataValidationError(f'{paper_label} v6 {field} 项非法')
            item_id = str(item.get('id') or item.get('url') or '')
            source = inventory[inventory_field].get(item_id)
            if not source or item_id in handled or item.get('disposition') not in {'inline', 'appendix', 'omit'}:
                raise PublishDataValidationError(f'{paper_label} v6 {field} 身份/处置非法')
            handled.add(item_id)
            if item['disposition'] == 'omit':
                if len(_manual_v6_text(item.get('omissionReason'))) < 24:
                    raise PublishDataValidationError(f'{paper_label} {field}.{item_id} 省略原因过短')
                continue
            block = block_by_id.get(item.get('blockId'))
            markdown = _manual_v6_text(block.get('markdown')) if block else ''
            if figures:
                url = str(source.get('url') or '')
                facts = item.get('visibleFacts')
                if not url or url not in markdown or not isinstance(facts, list) or not facts \
                        or any(len(_manual_v6_text(fact)) < 12 or _manual_v6_text(fact) not in markdown for fact in facts):
                    raise PublishDataValidationError(f'{paper_label} 图片 {item_id} 缺 URL/像素事实正文绑定')
            if formulas:
                formula = _manual_v6_text(source.get('raw') or source.get('latex') or source.get('text'))
                explanation = _manual_v6_require_text(item.get('explanation'), f'{paper_label}.formula.{item_id}', 40)
                if explanation not in markdown or (formula and formula not in markdown):
                    raise PublishDataValidationError(f'{paper_label} 公式 {item_id} 缺原式/解释正文绑定')
        if handled != set(inventory[inventory_field]):
            raise PublishDataValidationError(f'{paper_label} v6 未逐项处置全部 {field}')
    validate_dispositions('figures', 'figures', figures=True)
    validate_dispositions('formulas', 'formulas', formulas=True)

    terms = bundle.get('terms')
    if not isinstance(terms, list):
        raise PublishDataValidationError(f'{paper_label} v6 terms 缺失')
    handled_terms = set()
    for item in terms:
        if not isinstance(item, dict) or item.get('id') in handled_terms or item.get('id') not in inventory['acronyms']:
            raise PublishDataValidationError(f'{paper_label} v6 term 身份非法')
        handled_terms.add(item['id'])
        term = _manual_v6_require_text(item.get('term'), f'{paper_label}.term', 2)
        definition = _manual_v6_require_text(item.get('definition'), f'{paper_label}.definition', 16)
        block = block_by_id.get(item.get('firstUseBlockId'))
        if not block or term not in _manual_v6_text(block.get('markdown')) or definition not in _manual_v6_text(block.get('markdown')):
            raise PublishDataValidationError(f'{paper_label} 术语 {term} 未在首次出现处定义')
    required_terms = {
        item_id for item_id, source in inventory['acronyms'].items()
        if _manual_v6_article_uses_term(article, source.get('value') or source.get('term'))
    }
    missing_terms = required_terms - handled_terms
    if missing_terms:
        raise PublishDataValidationError(
            f'{paper_label} v6 未定义正文实际使用的术语: {", ".join(sorted(missing_terms))}'
        )

    related = bundle.get('relatedWorks')
    if not isinstance(related, list):
        raise PublishDataValidationError(f'{paper_label} v6 relatedWorks 缺失')
    # relatedWorks binds bibliography identities.  Structured arXiv sources may
    # expose these as references while leaving the in-text citations projection
    # empty, so validate against the union of both content-addressed inventories.
    related_inventory = _manual_v6_inventory_ids(artifact, 'references')
    related_inventory.update(inventory['citations'])
    handled_related = set()
    for item in related:
        declared_id = item.get('citationId') if isinstance(item, dict) else None
        if not isinstance(item, dict) or declared_id in handled_related \
                or declared_id not in related_inventory:
            raise PublishDataValidationError(f'{paper_label} v6 related-work 身份非法')
        handled_related.add(declared_id)
        relationship = _manual_v6_require_text(item.get('relationship'), f'{paper_label}.relationship', 16)
        difference = _manual_v6_require_text(item.get('difference'), f'{paper_label}.difference', 16)
        block = block_by_id.get(item.get('blockId'))
        if not block or relationship not in _manual_v6_text(block.get('markdown')) or difference not in _manual_v6_text(block.get('markdown')):
            raise PublishDataValidationError(f'{paper_label} related-work 缺关系/差异正文绑定')
    minimum_related = min(2, len(inventory['citations']))
    if len(handled_related) < minimum_related:
        raise PublishDataValidationError(
            f'{paper_label} v6 relatedWorks 必须绑定至少 {minimum_related} 个真实引用'
        )

    return {
        'paperId': paper_id, 'article': article, 'articleSha256': article_sha,
        'artifactIndexSha256': artifact_sha, 'provenance': dict(provenance),
        'bundle': bundle, 'artifactIndex': artifact, 'deterministicTables': deterministic_tables,
    }


def _normalize_manual_evidence(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(value or '')))


def _manual_claim_field_text(value):
    if isinstance(value, dict):
        if value.get('notReported') is True:
            return 'notReported'
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if isinstance(value, list):
        return ' / '.join(_manual_claim_field_text(item) for item in value)
    return str(value or '').strip()


def _manual_claim_not_reported(value):
    if isinstance(value, dict):
        return value.get('notReported') is True
    return bool(re.fullmatch(r'(?:not[_ -]?reported|正文未报告|未报告)', str(value or '').strip(), re.I))


MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS = (
    'datasetOrSetting', 'splitOrCondition', 'method', 'baseline',
    'metric', 'value', 'unit', 'direction',
)
MANUAL_ENGLISH_NUMBER_WORDS = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
    'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
    'fourteen': '14', 'fifteen': '15', 'sixteen': '16',
    'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
}
MANUAL_RESULT_DIRECTION_PATTERNS = (
    re.compile(
        r'^(?:↑|(?:越)?高(?:越)?好|越大越好|'
        r'higher(?:[\s_-]+\w+){0,3}[\s_-]+is[\s_-]+better|'
        r'increase(?:[\s_-]+is)?[\s_-]+better)$', re.I,
    ),
    re.compile(
        r'^(?:↓|(?:越)?低(?:越)?好|越小越好|'
        r'lower(?:[\s_-]+\w+){0,3}[\s_-]+is[\s_-]+better|'
        r'decrease(?:[\s_-]+is)?[\s_-]+better)$', re.I,
    ),
    re.compile(r'^(?:descriptive|描述性)$', re.I),
    re.compile(
        r'^(?:绝对值反映关联强度|'
        r'larger\s+(?:absolute\s+)?magnitude\s+means\s+stronger\s+association)$',
        re.I,
    ),
)


def _manual_canonical_numeric_lexeme(value):
    normalized = unicodedata.normalize('NFKC', str(value or '')).lower()
    normalized = re.sub(r'[\u2212\u2012\u2013\u2014]', '-', normalized).replace(',', '')
    if normalized in MANUAL_ENGLISH_NUMBER_WORDS:
        return MANUAL_ENGLISH_NUMBER_WORDS[normalized]
    try:
        number = float(normalized)
    except (TypeError, ValueError):
        return normalized
    if not math.isfinite(number):
        return normalized
    if number == 0:
        return '0'
    if number.is_integer():
        return str(int(number))
    return format(number, '.15g')


def _manual_numeric_lexemes(value):
    normalized = unicodedata.normalize('NFKC', _manual_claim_field_text(value))
    normalized = re.sub(r'[\u2212\u2012\u2013\u2014]', '-', normalized)
    # HTML/PDF extraction can concatenate a visible decimal and an identical
    # MathML/LaTeX fallback (for example, ``3.73.7`` for ``3.7``).  Keep the
    # source quote untouched, but mirror the Node editorial gate when reading
    # numeric evidence: collapse exactly one immediately-adjacent, identical
    # decimal pair.  The boundary checks deliberately leave normal adjacent
    # numbers and non-identical decimal text alone.
    normalized = re.sub(
        r'(?<![\d.])(\d+\.\d+)\1(?!\d|\.\d)',
        r'\1',
        normalized,
    )
    number_words = '|'.join(MANUAL_ENGLISH_NUMBER_WORDS)
    matches = re.findall(
        rf'[-+]?(?:\d{{1,3}}(?:,\d{{3}})+|\d+)?(?:\.\d+)(?:[eE][-+]?\d+)?'
        rf'|[-+]?(?:\d{{1,3}}(?:,\d{{3}})+|\d+)(?:[eE][-+]?\d+)?'
        rf'|\b(?:{number_words})\b',
        normalized,
        flags=re.I,
    )
    return [_manual_canonical_numeric_lexeme(item) for item in matches]


def _manual_normalized_semantic_text(value):
    normalized = unicodedata.normalize('NFKC', _manual_claim_field_text(value)).lower()
    normalized = re.sub(r'[\u2212\u2012\u2013\u2014]', '-', normalized)
    return re.sub(r'[\s\W_]+', '', normalized, flags=re.UNICODE)


def _manual_binding_reuse_key(value):
    normalized = unicodedata.normalize('NFKC', str(value or '')).lower()
    normalized = re.sub(r'https?://\S+', '', normalized)
    return re.sub(r'[\s\W_]+', '', normalized, flags=re.UNICODE)


def _manual_result_direction_supported(value):
    if _manual_claim_not_reported(value):
        return True
    text = str(value or '').strip()
    return any(pattern.fullmatch(text) for pattern in MANUAL_RESULT_DIRECTION_PATTERNS)


def _manual_result_claim_signature(claim):
    signature = []
    for field in MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS:
        value = claim.get(field)
        if _manual_claim_not_reported(value):
            reason = value.get('reason') if isinstance(value, dict) else ''
            signature.append(f'notReported:{_normalize_manual_evidence(reason)}')
        else:
            signature.append(
                f'{_manual_normalized_semantic_text(value)}:'
                f'{",".join(_manual_numeric_lexemes(value))}'
            )
    return json.dumps(signature, ensure_ascii=False, separators=(',', ':'))


def _manual_reader_result_evidence_blocks(value):
    blocks = []
    table = []
    prose = []

    def flush_table():
        if table:
            blocks.append('\n'.join(table))
            table.clear()

    def flush_prose():
        if not prose:
            return
        paragraph = ' '.join(prose).strip()
        if paragraph:
            blocks.append(paragraph)
            blocks.extend(
                item.strip() for item in re.split(r'(?<=[。！？!?;；])', paragraph)
                if item.strip()
            )
        prose.clear()

    for line in str(value or '').split('\n'):
        if re.fullmatch(r'\s*\|.*\|\s*', line):
            flush_prose()
            table.append(line)
        elif not line.strip():
            flush_table()
            flush_prose()
        else:
            flush_table()
            prose.append(line.strip())
    flush_table()
    flush_prose()
    return list(dict.fromkeys(blocks))


def _validate_manual_result_claim_bindings(
        claim, binding_field, evidence_text, prefix, *, require_membership=True):
    bindings = claim.get(binding_field)
    if not isinstance(bindings, dict):
        return f'{prefix}.{binding_field} 必须是逐字段证据对象'
    if set(bindings) != set(MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS) \
            or len(bindings) != len(MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS):
        return (
            f'{prefix}.{binding_field} 必须且只能包含 '
            f'{", ".join(MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS)}'
        )
    normalized_evidence = _normalize_manual_evidence(evidence_text)
    repeated = {}
    for field in MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS:
        fragment = bindings.get(field)
        normalized_fragment = _normalize_manual_evidence(fragment) \
            if isinstance(fragment, str) else ''
        # 与 Node 门禁使用同一组完整单字符语义；其余任意单字符仍拒绝。
        legitimate_single_character = (
            field == 'unit'
            and re.fullmatch(r'(?:%|s|h|W|分|帧|人)', normalized_fragment, re.I)
        ) or (
            field == 'direction'
            and re.fullmatch(r'(?:↑|↓)', normalized_fragment)
        )
        if len(normalized_fragment) < 2 and not legitimate_single_character:
            return (
                f'{prefix}.{binding_field}.{field} '
                '必须是至少 2 个非空白字符的连续证据片段'
            )
        if require_membership and normalized_fragment not in normalized_evidence:
            return f'{prefix}.{binding_field}.{field} 不存在于本条 sourceQuote'
        reuse_key = _manual_binding_reuse_key(fragment) or normalized_fragment
        repeated[reuse_key] = repeated.get(reuse_key, 0) + 1
        if field == 'value' and not _manual_claim_not_reported(claim.get('value')):
            binding_numbers = _manual_numeric_lexemes(fragment)
            missing = [
                number for number in _manual_numeric_lexemes(claim.get('value'))
                if number not in binding_numbers
            ]
            if missing:
                return (
                    f'{prefix}.{binding_field}.value '
                    f'未覆盖 claim.value 数值 {missing[0]}'
                )
        if _manual_claim_not_reported(claim.get(field)) and not re.search(
                r'not\s+report|not\s+provide|without|unavailable|qualitative|'
                r'degrad\w*|fail\w*|未报告|未给出|未提供|不可得|定性|退化|失败',
                fragment, re.I):
            return f'{prefix}.{binding_field}.{field} 未给出缺失、定性或负面证据片段'
    if any(count > 3 for count in repeated.values()):
        return f'{prefix}.{binding_field} 同一证据片段最多绑定 3 个字段'
    return None


def _manual_result_claim_bound_to_reader_block(claim, reader_blocks):
    expected_numbers = [] if _manual_claim_not_reported(claim.get('value')) \
        else _manual_numeric_lexemes(claim.get('value'))
    bindings = claim.get('readerBindings') or {}
    for block in reader_blocks:
        block_numbers = _manual_numeric_lexemes(block)
        if expected_numbers and any(number not in block_numbers for number in expected_numbers):
            continue
        normalized_block = _normalize_manual_evidence(block)
        if all(
                _normalize_manual_evidence(bindings.get(field)) in normalized_block
                for field in MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS):
            return True
    return False


def _manual_result_claim_source_text(paper):
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    claims = takeover.get('resultClaims') if isinstance(takeover, dict) else None
    if not isinstance(claims, list):
        return ''
    return '\n'.join(
        str(claim.get('sourceQuote') or '')
        for claim in claims
        if isinstance(claim, dict)
    )


def _validate_manual_v4_result_claims(
        takeover, analysis, paper_label, *, reader_section='实验结果'):
    """Mirror the source-bound Manual v4 result-claim shape at publish time.

    The controlled full text is intentionally not embedded in publication data,
    so its original membership check remains an ingestion responsibility.  This
    mirror still rejects weakened/self-consistent payloads: ordinary papers need
    three unique claims, exceptions are type-gated, every semantic field binds
    an exact local source and reader fragment, and empirical papers retain a
    source-bound numeric claim in one reader-visible experiment evidence block.
    """
    claims = takeover.get('resultClaims')
    exception = takeover.get('resultClaimsException')
    document_type = str(takeover.get('documentType') or '')
    minimum_claims = 3
    if exception is not None:
        if not isinstance(exception, dict):
            raise PublishDataValidationError(
                f'{paper_label} manual v4 resultClaimsException 必须是对象'
            )
        exception_type = str(exception.get('type') or '')
        if not re.fullmatch(r'(?:theoretical|qualitative)', exception_type, re.I) \
                or not re.search(r'(?:理论|定性|theor|qualitative)', document_type, re.I):
            raise PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims 例外仅允许理论/定性文档'
            )
        if len(_normalize_manual_evidence(exception.get('reason'))) < 20 \
                or not isinstance(exception.get('sourceQuote'), str) \
                or len(_normalize_manual_evidence(exception.get('sourceQuote'))) < 8:
            raise PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims 例外缺少充分理由或全文原句'
            )
        minimum_claims = 1
    if not isinstance(claims, list) or len(claims) < minimum_claims:
        raise PublishDataValidationError(
            f'{paper_label} manual v4 resultClaims 至少需要 {minimum_claims} 条'
        )
    required_fields = (
        'datasetOrSetting', 'splitOrCondition', 'method', 'baseline',
        'metric', 'value', 'unit', 'direction', 'sourceQuote',
    )
    reader_results = _extract_analysis_section(analysis, reader_section)
    reader_blocks = _manual_reader_result_evidence_blocks(reader_results)
    signatures = {}
    numeric_claim_count = 0
    for index, claim in enumerate(claims):
        if not isinstance(claim, dict):
            raise PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims[{index}] 必须是对象'
            )
        for field in required_fields:
            if field not in claim or not _normalize_manual_evidence(
                    _manual_claim_field_text(claim.get(field))):
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}].{field} 缺失'
                )
            value = claim.get(field)
            if field != 'sourceQuote' and re.search(
                    r'not[_ -]?reported.*\d|\d.*not[_ -]?reported',
                    _manual_claim_field_text(value), re.I):
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}].{field} '
                    '不得把 notReported 与数值混写'
                )
            if field != 'sourceQuote' and _manual_claim_not_reported(value) \
                    and (not isinstance(value, dict)
                         or value.get('notReported') is not True
                         or len(_normalize_manual_evidence(value.get('reason'))) < 8):
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}].{field} '
                    'notReported 必须使用 {notReported:true, reason} 且附理由'
                )
        source_quote = claim.get('sourceQuote')
        if not isinstance(source_quote, str) \
                or len(_normalize_manual_evidence(source_quote)) < 8:
            raise PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims[{index}].sourceQuote 过短'
            )
        prefix = f'{paper_label} manual v4 resultClaims[{index}]'
        if not _manual_result_direction_supported(claim.get('direction')):
            raise PublishDataValidationError(
                f'{prefix}.direction 不是受支持的方向语义'
            )
        binding_issue = _validate_manual_result_claim_bindings(
            claim, 'sourceBindings', source_quote, prefix,
        )
        if binding_issue:
            raise PublishDataValidationError(binding_issue)
        binding_issue = _validate_manual_result_claim_bindings(
            claim, 'readerBindings', reader_results, prefix,
            require_membership=False,
        )
        if binding_issue:
            raise PublishDataValidationError(binding_issue)
        if not _manual_claim_not_reported(claim.get('value')):
            value_numbers = _manual_numeric_lexemes(claim.get('value'))
            if not value_numbers:
                raise PublishDataValidationError(
                    f'{prefix}.value 必须包含可核对数字，'
                    '缺失值应使用带理由的 notReported 对象'
                )
            numeric_claim_count += 1
            quote_numbers = _manual_numeric_lexemes(source_quote)
            missing_quote = [number for number in value_numbers if number not in quote_numbers]
            if missing_quote:
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}] 数值 '
                    f'{missing_quote[0]} 未出现在 sourceQuote'
                )
        if not _manual_result_claim_bound_to_reader_block(claim, reader_blocks):
            raise PublishDataValidationError(
                f'{prefix}.readerBindings '
                f'未共同落在读者正文{reader_section}的同一局部证据块'
            )
        signature = _manual_result_claim_signature(claim)
        if signature in signatures:
            raise PublishDataValidationError(
                f'{prefix} 与 resultClaims[{signatures[signature]}] 重复，'
                '不能重复计入最低条数'
            )
        signatures[signature] = index
    empirical = exception is None and not re.search(
        r'(?:理论|定性|theor|qualitative)', document_type, re.I,
    )
    if empirical and claims and numeric_claim_count == 0:
        raise PublishDataValidationError(
            f'{paper_label} 实证论文的 resultClaims '
            '至少需要 1 条包含可核对数字的声明'
        )
    return claims


def _manual_boilerplate(analysis):
    text = str(analysis or '')
    return [line.strip() for line in text.splitlines() if any(pattern.search(line) for pattern in MANUAL_BOILERPLATE_PATTERNS)]


def _validate_manual_takeover_manifest(paper, manifest, paper_label):
    stages = manifest.get('stages') if isinstance(manifest, dict) else {}
    uses_manual = any(
        isinstance(stage, dict) and stage.get('status') == MANUAL_COMPLETE_STATUS
        for stage in (stages or {}).values()
    )
    if not uses_manual and manifest.get('manualTakeover') is None:
        return
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    if contracts.get('manualDepth') in MANUAL_READER_QUALITY_VERSIONS \
            and contracts.get('experimentTables') != EXPERIMENT_TABLE_CONTRACT_VERSION:
        raise PublishDataValidationError(
            f'{paper_label} manual v4 必须声明 '
            f'experimentTables={EXPERIMENT_TABLE_CONTRACT_VERSION}'
        )
    if contracts.get('manualDepth') in MANUAL_READER_QUALITY_VERSIONS \
            and contracts.get('editorialQuality') != EDITORIAL_QUALITY_CONTRACT_VERSION:
        raise PublishDataValidationError(
            f'{paper_label} manual v4 必须声明 '
            f'editorialQuality={EDITORIAL_QUALITY_CONTRACT_VERSION}'
        )
    takeover = manifest.get('manualTakeover')
    if not isinstance(takeover, dict):
        raise PublishDataValidationError(f'{paper_label} manual_complete 缺少 manualTakeover provenance')
    manual_depth = contracts.get('manualDepth')
    signed_v6_compatibility = _manual_v6_signed_compatibility(paper, manifest)
    if paper.get('manualV6CompatibilityMode') is not None and not signed_v6_compatibility:
        raise PublishDataValidationError(
            f'{paper_label} Manual v6 compatibility 标记未与 production provenance 闭环'
        )
    if signed_v6_compatibility:
        # Production V6 replaces the legacy V4/V5 resultClaims, stageReviews,
        # evidenceLedger and figureReview projections with the content-addressed
        # ArtifactIndex, reader-longform-v2 and four independent task receipts.
        # Always replay the complete V6 validator before accepting that override.
        validate_manual_v6_payload(paper)
        return
    if takeover.get('version') == MANUAL_COMPLETE_PROVENANCE_VERSION:
        if takeover.get('mode') != MANUAL_COMPLETE_STATUS:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.version/mode 必须为 manual_complete v2')
        if not isinstance(takeover.get('agent'), str) or not takeover['agent'].strip():
            raise PublishDataValidationError(f'{paper_label} manualTakeover.agent 缺失')
        if takeover.get('basis') != 'full_text':
            raise PublishDataValidationError(f'{paper_label} manualTakeover.basis 必须为 full_text')
        source_sha = str(paper.get('sourceSha256') or manifest.get('sourceAcquisition', {}).get('sourceSha256') or '')
        if not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('sourceSha256') or '')):
            raise PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 非法')
        if not source_sha or takeover['sourceSha256'] != source_sha:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 与全文来源不一致')
        if not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('promptSha256') or '')):
            raise PublishDataValidationError(f'{paper_label} manualTakeover.promptSha256 非法')
        manual_depth = (manifest.get('contracts') or {}).get('manualDepth')
        if manual_depth in {MANUAL_DEPTH_CONTRACT_VERSION_V3, *MANUAL_READER_QUALITY_VERSIONS} \
                and not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('manualAuthoringPromptSha256') or '')):
            raise PublishDataValidationError(f'{paper_label} manual v3/v4 缺少 manualAuthoringPromptSha256')
        analysis_sha = hashlib.sha256(str(paper.get('analysis') or '').encode('utf-8')).hexdigest()
        if takeover.get('analysisSha256') != analysis_sha:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.analysisSha256 与正文不一致')
        completed_at = takeover.get('completedAt')
        if not isinstance(completed_at, str) or not BEIJING_TIMESTAMP_RE.fullmatch(completed_at):
            raise PublishDataValidationError(f'{paper_label} manualTakeover.completedAt 必须为北京时间 ISO 时间')
        if not isinstance(takeover.get('reason'), str) or len(takeover['reason'].strip()) < 20:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.reason 过短')
        review = takeover.get('review')
        required_review = ('sourceVerified', 'analysisContractVerified', 'scoringVerified', 'stageEvidenceVerified')
        if not isinstance(review, dict) or any(review.get(key) is not True for key in required_review):
            raise PublishDataValidationError(f'{paper_label} manualTakeover.review 未确认来源、正文、评分和阶段证据')
        if manual_depth in MANUAL_READER_QUALITY_VERSIONS \
                and review.get('readerQualityVerified') is not True:
            raise PublishDataValidationError(
                f'{paper_label} manual v4 review 未确认 readerQualityVerified'
            )
        audit = takeover.get('audit')
        if not isinstance(audit, dict) or audit.get('version') != 1:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.audit 必须为 v1')
        if not isinstance(audit.get('attempts'), int) or audit['attempts'] < 2:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.audit 至少需要两轮尝试')
        passes = audit.get('passes')
        if not isinstance(passes, list) or len(passes) < 2 or not isinstance(passes[-1], dict) \
                or passes[-1].get('status') != 'pass' or passes[-1].get('issues') != []:
            raise PublishDataValidationError(f'{paper_label} manualTakeover.audit 最后一轮必须干净通过')
        checks = audit.get('checks')
        if not isinstance(checks, dict) or set(checks) != MANUAL_AUDIT_CHECKS \
                or any(value is not True for value in checks.values()):
            raise PublishDataValidationError(f'{paper_label} manualTakeover.audit.checks 不完整')
        if _manual_boilerplate(paper.get('analysis')):
            raise PublishDataValidationError(f'{paper_label} 正文包含通用 manual 提示词残留')
        ledger = takeover.get('evidenceLedger')
        if not isinstance(ledger, list) or len(ledger) < 6:
            raise PublishDataValidationError(f'{paper_label} manual evidenceLedger 不完整')
        if takeover.get('evidenceLedgerSha256') != _manual_hash(ledger):
            raise PublishDataValidationError(f'{paper_label} manual evidenceLedger SHA 不一致')
        if manual_depth in MANUAL_READER_QUALITY_VERSIONS:
            result_claims = _validate_manual_v4_result_claims(
                takeover, paper.get('analysis'), paper_label,
            )
            expected_claims_sha = _manual_hash({
                'claims': result_claims,
                'exception': takeover.get('resultClaimsException'),
            })
            if takeover.get('resultClaimsSha256') != expected_claims_sha:
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims SHA 不一致'
                )
            rubric = takeover.get('readabilityRubric')
            dimensions = rubric.get('dimensions') if isinstance(rubric, dict) else None
            required_dimensions = {
                'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
                'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
                'antiTemplateOriginality',
            }
            if not isinstance(dimensions, dict) or set(dimensions) != required_dimensions:
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 readabilityRubric 维度不完整'
                )
            scores = []
            for dimension, entry in dimensions.items():
                if not isinstance(entry, dict) or not isinstance(entry.get('score'), int) \
                        or entry['score'] < 0 or entry['score'] > 2 \
                        or len(str(entry.get('reason') or '').strip()) < 12 \
                        or not isinstance(entry.get('evidence'), list) or not entry['evidence']:
                    raise PublishDataValidationError(
                        f'{paper_label} manual v4 readabilityRubric.{dimension} 非法'
                    )
                scores.append(entry['score'])
            if sum(scores) < 12 or 0 in scores:
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 readabilityRubric 未达到 12/14 且无 0 分'
                )
            if takeover.get('readabilityRubricSha256') != _manual_hash(rubric):
                raise PublishDataValidationError(
                    f'{paper_label} manual v4 readabilityRubric SHA 不一致'
                )
        if manual_depth in {
                MANUAL_DEPTH_CONTRACT_VERSION_V5,
                MANUAL_DEPTH_CONTRACT_VERSION_V6,
        }:
            if contracts.get('researcherFocus') != MANUAL_RESEARCH_CONTRACT_VERSION \
                    or contracts.get('perPaperSubagent') != 'isolated-single-paper-v1':
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 缺少 researcherFocus/perPaperSubagent 契约'
                )
            bound_fields = {
                'researchBriefSha256': 'researchBrief',
                'stageReviewsSha256': 'stageReviews',
                'scoringCalibrationSha256': 'scoringCalibration',
                'openSourceEvidenceSha256': 'openSourceEvidence',
                'figureReviewSha256': 'figureReview',
                'externalResourceVerificationSha256': 'externalResourceVerification',
            }
            for sha_field, value_field in bound_fields.items():
                if takeover.get(sha_field) != _manual_hash(takeover.get(value_field)):
                    raise PublishDataValidationError(
                        f'{paper_label} manual v5 {sha_field} 不匹配'
                    )
            brief = takeover.get('researchBrief')
            subagent = brief.get('paperSubagent') if isinstance(brief, dict) else None
            if (not isinstance(brief, dict)
                    or brief.get('contract') != MANUAL_RESEARCH_CONTRACT_VERSION
                    or brief.get('audience') != 'audio_researcher'
                    or not isinstance(subagent, dict)
                    or subagent.get('singlePaperOnly') is not True
                    or subagent.get('isolatedContext') is not True):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 researchBrief/subagent provenance 非法'
                )
            stage_reviews = takeover.get('stageReviews')
            review_stages = stage_reviews.get('stages') if isinstance(stage_reviews, dict) else None
            if (not isinstance(stage_reviews, dict) or stage_reviews.get('version') != 2
                    or not isinstance(review_stages, dict)
                    or set(review_stages) != set(MANUAL_STAGE_EVIDENCE_STAGES)):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 stageReviews 未精确覆盖全部阶段'
                )
            figure_review = takeover.get('figureReview')
            decisions = figure_review.get('decisions') if isinstance(figure_review, dict) else None
            if not isinstance(decisions, list):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 figureReview 缺失'
                )
            selected_urls = [
                item.get('url') for item in (paper.get('imageManifest') or {}).get('selected', [])
                if isinstance(item, dict)
            ]
            reviewed_selected = [
                item.get('url') for item in decisions
                if isinstance(item, dict) and item.get('decision') == 'select'
            ]
            # canonical selected 按最终正文插入位置排序；figureReview 保留研究者
            # 审图时的声明顺序。两者应校验同一组唯一 URL，而不是误把顺序当事实。
            if (len(reviewed_selected) != len(set(reviewed_selected))
                    or len(selected_urls) != len(set(selected_urls))
                    or sorted(reviewed_selected) != sorted(selected_urls)):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 figureReview 与 selected 图片不一致'
                )
            if not selected_urls:
                _validate_manual_v5_all_rejected_images(paper, decisions, paper_label)
            verification = takeover.get('externalResourceVerification')
            declared_urls = (takeover.get('openSourceEvidence') or {}).get('urls') or []
            outcomes = verification.get('outcomes', []) if isinstance(verification, dict) else []
            outcomes_valid = isinstance(outcomes, list) and all(
                isinstance(item, dict)
                and item.get('status') == 'reachable_public_https'
                and item.get('httpStatus') == 200
                and str(item.get('finalUrl') or '').startswith('https://')
                and isinstance(item.get('verifiedAt'), str)
                and re.fullmatch(
                    r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})',
                    item['verifiedAt'],
                )
                and isinstance(item.get('discoveredLinks'), list)
                and all(str(url).startswith('https://') for url in item['discoveredLinks'])
                for item in outcomes
            )
            if (not isinstance(verification, dict) or verification.get('version') != 1
                    or verification.get('state') != (takeover.get('openSourceEvidence') or {}).get('state')
                    or not outcomes_valid
                    or [item.get('url') for item in outcomes
                        if isinstance(item, dict)] != declared_urls):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 外部资源验证未逐 URL 闭环'
                )
            acquisition = manifest.get('sourceAcquisition')
            if not isinstance(acquisition, dict):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 缺少 sourceAcquisition'
                )
            try:
                full_text_path = Path(acquisition.get('fullTextPath', '')).resolve(strict=True)
                controlled_root = (Path(CURRENT_DIR) / 'manual-full-text').resolve(strict=True)
                full_text_path.relative_to(controlled_root)
                source_bytes = full_text_path.read_bytes()
            except (OSError, RuntimeError, ValueError) as exc:
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 全文路径未落在当前受控目录: {exc}'
                ) from exc
            if hashlib.sha256(source_bytes).hexdigest() != acquisition.get('sourceSha256'):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 发布前全文 SHA 漂移'
                )
            source_manifest_path = full_text_path.parent / 'manifest.json'
            try:
                source_manifest_bytes = source_manifest_path.read_bytes()
                source_manifest = json.loads(source_manifest_bytes.decode('utf-8'))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 发布前无法读取全文 manifest: {exc}'
                ) from exc
            source_id = normalize_publish_arxiv_id(acquisition.get('sourceId'))
            source_entry = (source_manifest.get('papers') or {}).get(source_id)
            if (not isinstance(source_entry, dict)
                    or Path(source_entry.get('path', '')).resolve() != full_text_path
                    or source_entry.get('sourceSha256') != acquisition.get('sourceSha256')
                    or source_entry.get('paperInputSha256') != acquisition.get('paperInputSha256')
                    or source_entry.get('sourceIdentitySha256') != acquisition.get('sourceIdentitySha256')):
                raise PublishDataValidationError(
                    f'{paper_label} manual v5 发布前全文 manifest membership 不一致'
                )
            identity_mode = _manual_paper_identity_mode(contracts, paper_label)
            if identity_mode == 'per_paper_v1':
                artifact_manifest_path = source_manifest_path.parent / 'artifacts' / 'manifest.json'
                try:
                    artifact_manifest = json.loads(artifact_manifest_path.read_text(encoding='utf-8'))
                    artifact_entry = (artifact_manifest.get('papers') or {}).get(source_id)
                    artifact_path = Path((artifact_entry or {}).get('path', '')).resolve(strict=True)
                    artifact_path.relative_to(artifact_manifest_path.parent.resolve(strict=True))
                    artifact_bytes = artifact_path.read_bytes()
                    artifact_index = json.loads(artifact_bytes.decode('utf-8'))
                except (OSError, RuntimeError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
                    raise PublishDataValidationError(
                        f'{paper_label} 发布前无法重放逐论文 ArtifactIndex: {exc}'
                    ) from exc
                snapshot = source_entry.get('structuredArtifactsSnapshot')
                if (not isinstance(artifact_entry, dict)
                        or artifact_entry.get('status') != 'complete'
                        or artifact_entry.get('inventoryStatus') != 'complete'
                        or artifact_entry.get('paperId') != source_id
                        or artifact_entry.get('parserVersion') != MANUAL_ARTIFACT_PARSER_VERSION_V2
                        or artifact_entry.get('sourceSha256') != source_entry.get('sourceSha256')
                        or artifact_entry.get('sourceIdentitySha256') != source_entry.get('sourceIdentitySha256')
                        or artifact_entry.get('paperInputSha256') != source_entry.get('paperInputSha256')
                        or not isinstance(snapshot, dict)
                        or snapshot.get('healthStatus') != 'complete'
                        or snapshot.get('payloadSha256') != artifact_entry.get('structuredArtifactsSha256')
                        or artifact_entry.get('bytes') != len(artifact_bytes)
                        or artifact_entry.get('outputSha256') != hashlib.sha256(artifact_bytes).hexdigest()
                        or artifact_index.get('paperId') != source_id
                        or (artifact_index.get('inventoryHealth') or {}).get('status') != 'complete'
                        or artifact_index.get('artifactIndexSha256') != artifact_entry.get('artifactIndexSha256')):
                    raise PublishDataValidationError(
                        f'{paper_label} 逐论文 ArtifactIndex 未与全文、manifest 和真实文件闭环'
                    )
                expected_identity = {
                    'contract': MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
                    'date': source_manifest.get('date'),
                    'paperId': source_id,
                    'fullText': {
                        'requestedArxivId': normalize_publish_arxiv_id(source_entry.get('requestedArxivId')),
                        'sourceSha256': source_entry.get('sourceSha256'),
                        'sourceIdentitySha256': source_entry.get('sourceIdentitySha256'),
                        'paperMetadataSha256': source_entry.get('paperMetadataSha256'),
                        'paperInputSha256': source_entry.get('paperInputSha256'),
                        'bytes': source_entry.get('bytes'),
                        'imageInfosSha256': _manual_hash(source_entry.get('imageInfos') or []),
                        'fileName': Path(source_entry.get('path', '')).name,
                    },
                    'artifactIndex': {
                        'parserVersion': artifact_entry.get('parserVersion'),
                        'structuredArtifactsSha256': artifact_entry.get('structuredArtifactsSha256'),
                        'artifactIndexSha256': artifact_entry.get('artifactIndexSha256'),
                        'fileSha256': artifact_entry.get('outputSha256'),
                        'bytes': artifact_entry.get('bytes'),
                        'fileName': artifact_path.name,
                    },
                }
                declared_identity = acquisition.get('paperSourceIdentity')
                if (not isinstance(declared_identity, dict)
                        or declared_identity.get('contract') != MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT
                        or declared_identity.get('value') != expected_identity
                        or declared_identity.get('sha256') != _manual_hash(expected_identity)
                        or _manual_hash(declared_identity.get('value')) != declared_identity.get('sha256')):
                    raise PublishDataValidationError(
                        f'{paper_label} 逐论文来源身份与当前全文/ArtifactIndex 不一致'
                    )
        evidence = takeover.get('stageEvidence')
        stages = manifest.get('stages') or {}
        if not isinstance(evidence, dict):
            raise PublishDataValidationError(f'{paper_label} manual stageEvidence 缺失')
        audit_sha = _manual_hash(audit)
        hardened_fields = ('protocol', 'promptSource', 'promptSha256', 'contextSha256')
        hardened = any(
            any(key in (evidence.get(stage) or {}) or key in (stages.get(stage) or {}) for key in hardened_fields)
            for stage in MANUAL_STAGE_EVIDENCE_STAGES
        )
        if not hardened and completed_at[:10] >= MANUAL_V2_HARDENED_CUTOFF_DATE:
            raise PublishDataValidationError(
                f'{paper_label} manual stageEvidence 缺少 {MANUAL_V2_HARDENED_CUTOFF_DATE} 起必需的逐阶段 prompt/context 绑定'
            )
        image_manifest = paper.get('imageManifest')
        image_context_fields = {
            'imageDownload': 'downloadEvidenceSha256',
            'imageSupplement': 'selectionEvidenceSha256',
        }
        if hardened:
            if not isinstance(image_manifest, dict) \
                    or not isinstance(image_manifest.get('candidates'), list) \
                    or not isinstance(image_manifest.get('downloadOutcomes'), list) \
                    or not isinstance(image_manifest.get('selected'), list):
                raise PublishDataValidationError(
                    f'{paper_label} manual imageManifest 缺少可重算的 candidates/downloadOutcomes/selected'
                )

            def normalize_image_evidence(info):
                normalized = {
                    'url': info.get('url'),
                    'caption': info.get('caption') or '',
                    'source': info.get('source') or None,
                    'sourceOrder': info.get('sourceOrder'),
                    'candidateScore': info.get('candidateScore'),
                }
                # JS 生成 downloadEvidenceSha256 时，未下载/人工拒绝候选的
                # undefined 二进制字段会被 JSON.stringify 省略，而不是写成 null。
                # Python 重算必须保持同一 JSON 语义。
                for optional_key in ('mime', 'sha256', 'bytes'):
                    if optional_key in info:
                        normalized[optional_key] = info.get(optional_key)
                if manual_depth in {
                        MANUAL_DEPTH_CONTRACT_VERSION_V5,
                        MANUAL_DEPTH_CONTRACT_VERSION_V6,
                }:
                    normalized.update({
                        'reviewDecision': info.get('reviewDecision'),
                        'reviewReason': info.get('reviewReason'),
                        'figureNumber': info.get('figureNumber'),
                        'visibleFacts': info.get('visibleFacts') or [],
                        'renderPlan': info.get('renderPlan'),
                    })
                return normalized

            expected_download_context = _manual_hash({
                'candidates': [normalize_image_evidence(item) for item in image_manifest['candidates']],
                'outcomes': image_manifest['downloadOutcomes'],
            })
            if image_manifest.get('downloadEvidenceSha256') != expected_download_context:
                raise PublishDataValidationError(
                    f'{paper_label} manual imageManifest.downloadEvidenceSha256 闭环校验失败'
                )
            normalized_selected = [
                normalize_image_evidence(item) for item in image_manifest['selected']
            ]
            if image_manifest.get('version', 1) >= 2:
                expected_selection_context = _manual_hash({
                    'selected': normalized_selected,
                    'insertionPlan': image_manifest.get('insertionPlan') or [],
                    'insertionDiagnostics': image_manifest.get('insertionDiagnostics') or [],
                })
            else:
                expected_selection_context = _manual_hash(normalized_selected)
            if image_manifest.get('selectionEvidenceSha256') != expected_selection_context:
                raise PublishDataValidationError(
                    f'{paper_label} manual imageManifest.selectionEvidenceSha256 闭环校验失败'
                )
        for stage in MANUAL_STAGE_EVIDENCE_STAGES:
            item = evidence.get(stage)
            state = stages.get(stage)
            if not isinstance(item, dict) or not isinstance(state, dict) or item.get('status') != state.get('status'):
                raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage} 与阶段状态不一致')
            if manual_depth in {MANUAL_DEPTH_CONTRACT_VERSION_V3, *MANUAL_READER_QUALITY_VERSIONS} \
                    and (item.get('executionKind') != MANUAL_STAGE_EXECUTION_KIND
                         or state.get('executionKind') != MANUAL_STAGE_EXECUTION_KIND):
                raise PublishDataValidationError(
                    f'{paper_label} manual stageEvidence.{stage}.executionKind 必须为 '
                    f'{MANUAL_STAGE_EXECUTION_KIND}'
                )
            if not isinstance(item.get('attempts'), int) or item['attempts'] < 2:
                raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage} 未记录两轮审计')
            for key in ('inputSha256', 'outputSha256', 'auditSha256'):
                if not re.fullmatch(r'[a-f0-9]{64}', str(item.get(key) or '')):
                    raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.{key} 非法')
            if item['outputSha256'] != takeover['analysisSha256']:
                raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.outputSha256 与最终正文 SHA 不一致')
            if not isinstance(item.get('reviewedClaims'), list) or not item['reviewedClaims']:
                raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.reviewedClaims 不能为空')
            claims = item['reviewedClaims']
            if hardened:
                if item.get('protocol') != MANUAL_PROVENANCE_PROTOCOL \
                        or state.get('protocol') != MANUAL_PROVENANCE_PROTOCOL:
                    raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.protocol 与阶段协议不一致')
                if not isinstance(item.get('promptSource'), str) or not item['promptSource'].strip() \
                        or item['promptSource'] != state.get('promptSource'):
                    raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.promptSource 与阶段 manifest 不一致')
                if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('promptSha256') or '')) \
                        or item['promptSha256'] != state.get('promptSha256'):
                    raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.promptSha256 与阶段 manifest 不一致')
                if stage == 'primaryAnalysis' and item['promptSha256'] != takeover['promptSha256']:
                    raise PublishDataValidationError(f'{paper_label} manualTakeover.promptSha256 与 primaryAnalysis 阶段不一致')
                context_field = image_context_fields.get(stage)
                if context_field:
                    if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('contextSha256') or '')):
                        raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.contextSha256 缺失或非法')
                    if not isinstance(image_manifest, dict) \
                            or item['contextSha256'] != image_manifest.get(context_field):
                        raise PublishDataValidationError(
                            f'{paper_label} manual stageEvidence.{stage}.contextSha256 与 imageManifest.{context_field} 不一致'
                        )
                elif 'contextSha256' in item:
                    raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.contextSha256 不应存在')
                expected_input_payload = {
                    'stage': stage,
                    'sourceSha256': takeover['sourceSha256'],
                    'analysisSha256': takeover['analysisSha256'],
                    'claims': claims,
                    'stagePromptSha256': item['promptSha256'],
                    'stageContextSha256': item.get('contextSha256'),
                }
                if manual_depth in {MANUAL_DEPTH_CONTRACT_VERSION_V3, *MANUAL_READER_QUALITY_VERSIONS}:
                    expected_input_payload['executionKind'] = item.get('executionKind')
                expected_input_sha = _manual_hash(expected_input_payload)
            else:
                expected_input_sha = _manual_hash({
                    'stage': stage,
                    'sourceSha256': takeover['sourceSha256'],
                    'analysisSha256': takeover['analysisSha256'],
                    'claims': claims,
                })
            if item['inputSha256'] != expected_input_sha:
                raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.inputSha256 闭环校验失败')
            expected_audit_sha = _manual_hash({
                'stage': stage,
                'claims': claims,
                'auditSha256': audit_sha,
                'stageInputSha256': item['inputSha256'],
            })
            if item['auditSha256'] != expected_audit_sha:
                raise PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.auditSha256 闭环校验失败')
        if manual_depth == MANUAL_DEPTH_CONTRACT_VERSION_V6:
            validate_manual_v6_payload(paper)
        return
    if takeover.get('version') != 1 or takeover.get('mode') != MANUAL_COMPLETE_STATUS:
        raise PublishDataValidationError(f'{paper_label} manualTakeover.version/mode 非法')
    if not isinstance(takeover.get('agent'), str) or not takeover['agent'].strip():
        raise PublishDataValidationError(f'{paper_label} manualTakeover.agent 缺失')
    if takeover.get('basis') != 'full_text':
        raise PublishDataValidationError(f'{paper_label} manualTakeover.basis 必须为 full_text')
    source_sha = str(paper.get('sourceSha256') or manifest.get('sourceAcquisition', {}).get('sourceSha256') or '')
    if not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('sourceSha256') or '')):
        raise PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 非法')
    if source_sha and takeover['sourceSha256'] != source_sha:
        raise PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 与全文来源不一致')
    completed_at = takeover.get('completedAt')
    if not isinstance(completed_at, str) or not BEIJING_TIMESTAMP_RE.fullmatch(completed_at):
        raise PublishDataValidationError(f'{paper_label} manualTakeover.completedAt 必须是北京时间 ISO 时间')
    if not isinstance(takeover.get('reason'), str) or len(takeover['reason'].strip()) < 20:
        raise PublishDataValidationError(f'{paper_label} manualTakeover.reason 过短')
    review = takeover.get('review')
    required_review = ('sourceVerified', 'analysisContractVerified', 'scoringVerified', 'stageEvidenceVerified')
    if not isinstance(review, dict) or any(review.get(key) is not True for key in required_review):
        raise PublishDataValidationError(f'{paper_label} manualTakeover.review 未确认来源、正文、评分和阶段证据')


def split_markdown_table_row(row):
    text = str(row or '').strip()
    if '|' not in text:
        return []
    cells = []
    current = []
    in_code = False
    index = 0
    while index < len(text):
        char = text[index]
        if char == '\\' and index + 1 < len(text):
            current.extend((char, text[index + 1]))
            index += 2
            continue
        if char == '`':
            in_code = not in_code
            current.append(char)
        elif char == '|' and not in_code:
            cells.append(''.join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    cells.append(''.join(current).strip())
    if text.startswith('|') and cells and cells[0] == '':
        cells.pop(0)
    if text.endswith('|') and cells and cells[-1] == '':
        cells.pop()
    return cells


def _is_markdown_table_separator(row):
    cells = split_markdown_table_row(row)
    return len(cells) >= 2 and all(
        re.fullmatch(r':?-{3,}:?', re.sub(r'\s+', '', cell)) for cell in cells
    )


def _strip_fenced_code_blocks(text):
    fence = None
    kept = []
    for line in str(text or '').splitlines():
        match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence is None:
            if match:
                fence = (match.group(1)[0], len(match.group(1)))
                kept.append('')
            else:
                kept.append(line)
            continue
        if (match and match.group(1)[0] == fence[0]
                and len(match.group(1)) >= fence[1]):
            fence = None
        kept.append('')
    return '\n'.join(kept)


def extract_markdown_tables(text):
    lines = _strip_fenced_code_blocks(text).splitlines()
    tables = []
    index = 0
    while index + 1 < len(lines):
        header = split_markdown_table_row(lines[index])
        if len(header) < 2 or not _is_markdown_table_separator(lines[index + 1]):
            index += 1
            continue
        end = index + 2
        data_rows = 0
        rows = []
        invalid_column_counts = []
        separator_columns = len(split_markdown_table_row(lines[index + 1]))
        while end < len(lines):
            cells = split_markdown_table_row(lines[end])
            if not lines[end].strip():
                break
            if len(cells) < 2 and not re.fullmatch(r'\s*\|.*\|\s*', lines[end]):
                break
            data_rows += 1
            rows.append(cells)
            if len(cells) != len(header):
                invalid_column_counts.append((data_rows, len(cells)))
            end += 1
        identifier_columns = 0
        for cell in header:
            normalized = re.sub(r'<br\s*/?>', ' ', cell, flags=re.IGNORECASE)
            normalized = re.sub(r'[*_`]', '', normalized).strip()
            if not normalized or TABLE_IDENTIFIER_HEADER_RE.search(normalized):
                identifier_columns += 1
        tables.append({
            'header': header,
            'rows': rows,
            'start_line': index,
            'end_line': end - 1,
            'data_rows': data_rows,
            'separator_columns': separator_columns,
            'invalid_column_counts': invalid_column_counts,
            'identifier_columns': identifier_columns,
            'metric_columns': max(0, len(header) - identifier_columns),
        })
        index = max(end, index + 2)
    return tables


def _source_experiment_evidence(source_text):
    """Mirror Node's bounded experiment-section evidence selection."""
    source = str(source_text or '')
    start = re.search(
        r'(?:^|\n)\s*(?:\d+(?:\.\d+)*\s+)?'
        r'(?:experiments?|experimental\s+(?:setup|results?)|evaluation|'
        r'results?(?:\s+and\s+discussion)?)\s*(?:\n|$)',
        source,
        re.I,
    )
    if not start:
        return source[:50000]
    tail = source[start.start():start.start() + 60000]
    end = re.search(
        r'(?:^|\n)\s*(?:\d+(?:\.\d+)*\s+)?'
        r'(?:conclusions?|limitations?|references?)\s*(?:\n|$)',
        tail,
        re.I,
    )
    return tail[:end.start()] if end and end.start() > 0 else tail


def _validate_experiment_table_evidence_depth(
        analysis, document_type='', source_text=''):
    results = _extract_analysis_section(analysis, '实验结果')
    tables = extract_markdown_tables(results)
    empirical = document_type not in {'综述', '理论研究'}
    source_text = _source_experiment_evidence(source_text)
    source_has_table = re.search(
        r'\b(?:table|tbl)\.?\s*(?:[a-z]?\d+|[ivxlcdm]+)\b|'
        r'表\s*[（(]?\s*(?:\d+|[一二三四五六七八九十百零]+)|'
        r'\\begin\{tabular\}|<table[\s>]',
        source_text,
        re.I,
    )
    if empirical and source_has_table and not tables:
        return '实证论文的实验结果必须包含至少一张可读 Markdown 证据表'
    total_rows = sum(table['data_rows'] for table in tables)
    if empirical and tables and total_rows < EXPERIMENT_TABLE_LIMITS['min_evidence_rows']:
        return f"实验表格合计只有 {total_rows} 个数据行，至少需要 {EXPERIMENT_TABLE_LIMITS['min_evidence_rows']} 行比较证据"
    numeric_cells = 0
    result_lines = results.splitlines()
    for index, table in enumerate(tables, start=1):
        if table['identifier_columns'] < 1:
            return f'实验结果第 {index} 张表缺少方法、数据集或设置识别列'
        for header in table['header']:
            normalized = re.sub(r'[*_`]', '', header).strip()
            identifier = not normalized or TABLE_IDENTIFIER_HEADER_RE.search(normalized)
            if not identifier and TABLE_VAGUE_METRIC_HEADER_RE.search(normalized):
                return f'实验结果第 {index} 张表含叙述型伪指标列“{normalized}”，应改为可核对指标、设置或比较对象'
            if (not identifier
                    and TABLE_DIRECTIONAL_METRIC_RE.search(normalized)
                    and not TABLE_DIRECTION_MARK_RE.search(normalized)
                    and not TABLE_NON_DIRECTIONAL_MEASURE_RE.search(normalized)):
                return f'实验结果第 {index} 张表指标“{normalized}”缺少 ↑/↓ 方向'
        for row in table['rows']:
            for cell in row[min(table['identifier_columns'], len(row)):]:
                normalized = re.sub(r'[*_`]', '', str(cell or '')).strip()
                if TABLE_NUMERIC_CELL_RE.search(normalized):
                    numeric_cells += 1
                if re.search(r'−|％|(?:^|[<>=±+\-\[(,;/]\s*)\.\d|\d\s+%', normalized):
                    return f'实验结果第 {index} 张表数字格式未规范化：“{normalized}”'
        before = '\n'.join(result_lines[:table['start_line']]).strip()
        after = '\n'.join(result_lines[table['end_line'] + 1:]).strip()
        before_candidates = [
            paragraph for paragraph in re.split(r'\n\s*\n', before)
            if paragraph.strip()
        ][-5:][::-1]
        after_candidates = [
            paragraph for paragraph in re.split(r'\n\s*\n', after)
            if paragraph.strip()
        ][:5]
        before = next((
            paragraph for paragraph in before_candidates
            if len(re.sub(r'[*_`#>\s]', '', paragraph)) >= 20
            and re.search(r'比较|检验|考察|回答|关键问题|差异|收益|代价|是否|何种|多大|哪些', paragraph)
        ), '')
        after = next((
            paragraph for paragraph in after_candidates
            if len(re.sub(r'[*_`#>\s]', '', paragraph)) >= 50
            and re.search(r'相比|相对|差异|提升|下降|降低|增加|减少|但|而|同时|代价|边界|未|不显著|跨零|失败|退化', paragraph)
        ), '')
        if not before:
            return f'实验结果第 {index} 张表前缺少与上下文衔接的具体比较问题'
        if not after:
            return f'实验结果第 {index} 张表后缺少最关键差异、解释与证据边界'
    if empirical and tables and numeric_cells < EXPERIMENT_TABLE_LIMITS['min_numeric_cells']:
        return f"实验表格只有 {numeric_cells} 个可核对数字，至少需要 {EXPERIMENT_TABLE_LIMITS['min_numeric_cells']} 个；纯趋势或结论摘要不能替代结果表"
    source_has_comparison = re.search(
        r'\b(?:baseline|compared?\s+(?:to|with)|comparison|outperform(?:s|ed)?|versus|vs\.)\b|'
        r'基线|对照|相比|优于|弱于',
        source_text,
        re.I,
    )
    result_has_comparison = re.search(
        r'\b(?:baseline|compared?\s+(?:to|with)|comparison|versus|vs\.)\b|'
        r'基线|对照|相比|相对|优于|弱于|'
        r'比(?!较)[^。；\n]{0,30}(?:高|低|强|弱|好|差|大|小|提升|下降)',
        results,
        re.I,
    )
    if empirical and source_has_comparison and not result_has_comparison:
        return '全文包含基线或对照比较，但实验结果没有保留比较对象'
    source_has_ablation = re.search(
        r'\bablation\b|\bw/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|'
        r'消融|移除|去掉',
        source_text,
        re.I,
    )
    result_has_ablation = re.search(
        r'\bablation\b|\bw/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|'
        r'消融|移除|去掉|不含|排除',
        results,
        re.I,
    )
    if empirical and source_has_ablation and not result_has_ablation:
        return '全文包含消融实验，但实验结果没有保留关键消融或组件对照'
    source_has_negative = re.search(
        r'not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|'
        r'fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|'
        r'未显著|不显著|退化|失败|更差|无效|回退|'
        r'不单调(?:性|改进)?|不保证单调(?:改进|提升)',
        source_text,
        re.I,
    )
    result_has_negative = re.search(
        r'not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|'
        r'fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|'
        r'未显著|不显著|退化|恶化|失败|失效|崩溃|接近随机|低于随机|'
        r'更差|比(?!较)[^。；\n]{0,30}差|'
        r'未改善|没有改善|无效|负面|跨零|落后|损失|回退|'
        r'不单调(?:性|改进)?|不保证单调(?:改进|提升)',
        results,
        re.I,
    )
    if empirical and source_has_negative and not result_has_negative:
        return '全文包含退化、不显著或失败结果，但实验结果没有保留负面证据'
    return None


def validate_experiment_table_contract(
        analysis, contract_version=EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
        document_type='', source_text=''):
    results = _extract_analysis_section(analysis, '实验结果')
    if not results:
        return None
    tables = extract_markdown_tables(results)
    if len(tables) > EXPERIMENT_TABLE_LIMITS['max_tables']:
        return (
            f"实验结果包含 {len(tables)} 张 Markdown 表格，最多允许 "
            f"{EXPERIMENT_TABLE_LIMITS['max_tables']} 张"
        )
    for index, table in enumerate(tables, start=1):
        if table['separator_columns'] != len(table['header']):
            return (
                f"实验结果第 {index} 张表分隔行有 {table['separator_columns']} 列，"
                f"表头有 {len(table['header'])} 列"
            )
        if table['invalid_column_counts']:
            row, columns = table['invalid_column_counts'][0]
            return (
                f"实验结果第 {index} 张表第 {row} 个数据行有 {columns} 列，"
                f"表头有 {len(table['header'])} 列"
            )
        if table['data_rows'] > EXPERIMENT_TABLE_LIMITS['max_data_rows']:
            return (
                f"实验结果第 {index} 张表包含 {table['data_rows']} 个数据行，最多允许 "
                f"{EXPERIMENT_TABLE_LIMITS['max_data_rows']} 行"
            )
        if table['metric_columns'] > EXPERIMENT_TABLE_LIMITS['max_metric_columns']:
            return (
                f"实验结果第 {index} 张表包含 {table['metric_columns']} 个指标列，最多允许 "
                f"{EXPERIMENT_TABLE_LIMITS['max_metric_columns']} 列（方法/数据集识别列不计）"
            )
    if contract_version == EXPERIMENT_TABLE_CONTRACT_VERSION:
        return _validate_experiment_table_evidence_depth(
            analysis, document_type, source_text,
        )
    if contract_version != EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION:
        return f'未知实验表格契约版本: {contract_version}'
    return None


def validate_method_detail_contract(analysis):
    method = _extract_analysis_section(analysis, '方法概述和架构')
    chinese_count = len(re.findall(r'[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]', method))
    if chinese_count < 600:
        return f'方法概述中文字符不足: {chinese_count}/600'
    if any(re.search(pattern, method) for pattern in (
        r'详见原文', r'论文描述了详细架构', r'详细方法见', r'具体实现请参考',
    )):
        return '方法概述包含空泛占位表述'
    if not any(keyword in method for keyword in (
        '输入', '输出', '流程', '组件', '模块', '阶段', '结构', '网络', '模型',
    )):
        return '方法概述缺少结构性描述'
    paragraphs = [item for item in re.split(r'\n\s*\n', method) if len(item.strip()) > 20]
    if len(paragraphs) < 3:
        return f'方法概述有效段落不足: {len(paragraphs)}/3'
    return None


def validate_manual_depth_contract(analysis):
    """Fail closed on newly ingested manual text that is only an abstract.

    This mirrors the Node ingestion gate.  It deliberately applies only when
    a manifest opts into ``full-text-evidence-v1`` so historical API records
    and older manual receipts remain compatible.
    """
    method = _extract_analysis_section(analysis, '方法概述和架构')
    results = _extract_analysis_section(analysis, '实验结果')
    details = _extract_analysis_section(analysis, '细节详述')
    chinese_count = lambda value: len(re.findall(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]', str(value or '')))
    if chinese_count(method) < 650:
        return f'manual 全文方法证据不足: {chinese_count(method)}/650'
    if chinese_count(results) < 100:
        return f'manual 全文实验证据不足: {chinese_count(results)}/100'
    if chinese_count(details) < 40:
        return f'manual 全文细节证据不足: {chinese_count(details)}/40'
    if re.search(r'从复现角度|本分析|人工(?:审计|接管)|manual_complete|不能由本分析|不补造|实验数字只采用|按来源逐项核对', str(analysis or ''), re.I):
        return 'manual 正文包含流程/审计元话语，必须改写为论文事实'
    return None


MANUAL_DUP_CHECK_SECTIONS = (
    '核心摘要', '方法概述和架构', '核心创新点', '实验结果',
    '细节详述', '评分理由', '局限与问题', '开源详情',
)
MANUAL_DUP_MIN_SENTENCE_CHARS = 15
MANUAL_DUP_MAX_SENTENCES = 2
MANUAL_DUP_MAX_SECTION_SPREAD = 2
MANUAL_EDITORIAL_TEMPLATE_RE = re.compile(
    r'亮点[：:]?\s*一是|优点[：:]?\s*一是|短板是|不足[：:]?\s*一是[^。]{0,120}二是[^。]{0,120}三是'
)
MANUAL_SCORING_ANCHOR_TAG_MIN = 4
MANUAL_SCORING_ANCHOR_TAG_RE = re.compile(r'\[A_[A-Z_]{2,}\]')


def _normalize_manual_dup_sentence(value):
    normalized = unicodedata.normalize('NFKC', str(value or '')).lower()
    return re.sub(r'[\s\W_]+', '', normalized, flags=re.UNICODE)


def find_cross_section_duplicate_sentences(analysis, limit=3):
    sentence_sections = {}
    for section in MANUAL_DUP_CHECK_SECTIONS:
        body = _extract_analysis_section(analysis, section)
        if not body:
            continue
        seen_in_section = set()
        for raw_sentence in re.split(r'[。！？!?\n]', body):
            normalized = _normalize_manual_dup_sentence(raw_sentence)
            if len(normalized) < MANUAL_DUP_MIN_SENTENCE_CHARS:
                continue
            if normalized in seen_in_section:
                continue
            seen_in_section.add(normalized)
            sentence_sections.setdefault(normalized, set()).add(section)
    duplicates = [
        {'sentence': sentence, 'sections': sorted(sections)}
        for sentence, sections in sentence_sections.items()
        if len(sections) >= 2
    ]
    duplicates.sort(key=lambda item: item['sentence'])
    return duplicates[:limit]


def validate_manual_depth_contract_v2(analysis):
    """Mirror of the Node full-text-evidence-v2 quality gates.

    The open-source URL gate needs the source full text, which is not part of
    the canonical publish record; that gate is enforced at Node ingestion time
    only.  Everything else is checked here as a publish-time fallback.
    """
    base_issue = validate_manual_depth_contract(analysis)
    if base_issue:
        return base_issue
    duplicates = find_cross_section_duplicate_sentences(analysis)
    worst_section_spread = max((len(item['sections']) for item in duplicates), default=0)
    if len(duplicates) > MANUAL_DUP_MAX_SENTENCES or worst_section_spread > MANUAL_DUP_MAX_SECTION_SPREAD:
        example = duplicates[0]
        preview = example['sentence'][:24]
        joined = '、'.join(example['sections'])
        return (
            f'manual 正文存在跨章节自我复制: {len(duplicates)} 个句子重复出现在多个章节'
            f'（如「{preview}…」同时出现在{joined}），每个章节必须独立撰写'
        )
    editorial = _extract_analysis_section(analysis, '毒舌点评')
    if MANUAL_EDITORIAL_TEMPLATE_RE.search(editorial or ''):
        return 'manual 毒舌点评使用固定模板句式（亮点一是二是/短板是），必须改为针对本文的独立审稿人批评'
    scoring_reason = _extract_analysis_section(analysis, '评分理由') or ''
    anchor_tags = set(MANUAL_SCORING_ANCHOR_TAG_RE.findall(scoring_reason))
    if len(anchor_tags) < MANUAL_SCORING_ANCHOR_TAG_MIN:
        return (
            f'manual 评分理由缺少证据锚点标签 [A_*]: 仅 {len(anchor_tags)}'
            f'/{MANUAL_SCORING_ANCHOR_TAG_MIN} 个不同标签，每个维度必须引用可定位的证据组并说明锚点档位'
        )
    return None


def _manual_chinese_count(value):
    return len(re.findall(r'[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]', str(value or '')))


def _manual_prose_paragraphs(value):
    return [
        item.strip() for item in re.split(r'\n\s*\n', str(value or ''))
        if len(item.strip()) > 20 and not item.lstrip().startswith(('|', '!['))
    ]


def _manual_editorial_prose_paragraphs(value):
    """Mirror editorial-quality.js/proseParagraphs for the v4 reader gate.

    The older helper above intentionally serves several legacy depth checks and
    counts a Markdown heading as part of its surrounding blank-line block.
    The Node editorial gate instead treats headings, tables, images and return
    links as paragraph boundaries, strips list markers, and evaluates only
    reader prose.  Keep this narrow helper separate so the publish-time v4
    mirror cannot reject a canonical article solely because it tokenizes a
    paragraph differently from its ingestion-time counterpart.
    """
    paragraphs = []
    pending = []

    def flush():
        if not pending:
            return
        paragraph = re.sub(r'\s+', ' ', ' '.join(pending)).strip()
        if paragraph:
            paragraphs.append(paragraph)
        pending.clear()

    for raw_line in str(value or '').splitlines():
        line = raw_line.strip()
        if not line:
            flush()
            continue
        if re.match(r'^(?:#{1,6}\s|\||!\[|---+$|\[←)', line):
            flush()
            continue
        line = re.sub(r'^[-*+]\s+', '', line)
        line = re.sub(r'^\d+[.)、]\s+', '', line)
        pending.append(line)
    flush()
    return paragraphs


def _manual_han_character_count(value):
    """Count Han script characters as editorial-quality.js does.

    `_manual_chinese_count` is a legacy length heuristic that also counts CJK
    punctuation.  Paragraph overload is a reader-prose parity gate, where
    punctuation has its own sentence-mark threshold, so including it here
    creates false hard failures near the 260-character boundary.
    """
    return len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]', str(value or '')))


def validate_manual_depth_contract_v3(analysis):
    """Publish-time mirror of the reader-visible Manual v3 quality floor.

    Source-bound ledger and numeric-density checks already run during Node
    ingestion.  Publishing repeats every check that can be recomputed from the
    canonical article so a stale or hand-edited record cannot bypass v3.
    """
    v2_issue = validate_manual_depth_contract_v2(analysis)
    if v2_issue:
        return v2_issue

    summary = _extract_analysis_section(analysis, '核心摘要')
    method = _extract_analysis_section(analysis, '方法概述和架构')
    innovations = _extract_analysis_section(analysis, '核心创新点')
    results = _extract_analysis_section(analysis, '实验结果')
    details = _extract_analysis_section(analysis, '细节详述')
    scoring = _extract_analysis_section(analysis, '评分理由')
    limits = _extract_analysis_section(analysis, '局限与问题')

    length_gates = (
        ('核心摘要', summary, 360),
        ('方法证据', method, 650),
        ('核心创新点', innovations, 380),
        ('实验证据', results, 300),
        ('细节证据', details, 450),
        ('评分理由', scoring, 250),
        ('局限分析', limits, 300),
    )
    for label, body, minimum in length_gates:
        count = _manual_chinese_count(body)
        if count < minimum:
            return f'manual v3 {label}过短: {count}/{minimum} 个中文字符'

    summary_sentences = [
        item.strip() for item in re.split(r'[。！？!?]', summary)
        if _manual_chinese_count(item) >= 8
    ]
    if len(summary_sentences) < 5:
        return f'manual v3 核心摘要缺少论证推进: {len(summary_sentences)}/5 个有效句子'

    method_paragraphs = _manual_prose_paragraphs(method)
    if len(method_paragraphs) < 5:
        return f'manual v3 方法段落不足: {len(method_paragraphs)}/5'
    method_signals = (
        r'输入|波形|特征|样本|数据',
        r'模块|编码器|解码器|网络|组件|算子|阶段|结构',
        r'训练|优化|损失|目标|监督|更新|拟合|求解|实验|控制|构造|标注|证明',
        r'输出|推理|解码|预测|生成|检索|评估|结果|结论|决策',
    )
    missing_method_signals = sum(not re.search(pattern, method) for pattern in method_signals)
    if missing_method_signals > 1:
        return f'manual v3 方法缺少输入、组件、训练目标或输出边界中的 {missing_method_signals} 类'

    innovation_items = [
        item for item in _manual_prose_paragraphs(innovations)
        if not re.match(r'引导|总的来说', item)
    ]
    if len(innovation_items) < 3:
        return f'manual v3 创新论证不足: {len(innovation_items)}/3 个独立段落'
    innovation_signals = (
        r'相比|相较|比|既有|传统|标准|过去|不同于|不再|无需|而不|而非|避免|问题|限制|瓶颈|缺口|代价',
        r'机制|通过|采用|引入|设计|改为|拆分|把|将|使用|以|定义|提出',
        r'实验|评测|结果|消融|证据|数据|数值|观察|报告|达到|下降|提升|改善|验证',
    )
    if any(not re.search(pattern, innovations) for pattern in innovation_signals):
        return 'manual v3 创新点必须同时说明既有缺口、新机制和实验证据，不能只列贡献名词'

    if not re.search(
        r'相比|相较|比较|配对|对照|基线|baseline|vs\.?|消融|移除|加入|主方法|提出方法|最强|高于|低于|超过|落后|优于|改善|差距|从[^。]{0,40}(?:升至|降至|到)',
        results,
        re.I,
    ):
        return 'manual v3 实验结果缺少明确比较对象或消融关系'
    if not re.search(
        r'但是|但|不过|仅|尚未|不能|限制|边界|未报告|未说明|'
        r'而非|并非|不存在|退化|失败|更差|不显著|跨零',
        results,
    ):
        return 'manual v3 实验结果缺少结论边界或负面结果'

    reproducibility_signals = (
        r'数据|语料|样本|划分|训练集|测试集',
        r'损失|目标|优化器|学习率|训练|求解',
        r'超参数|批量|轮|epoch|步数|阈值|维度|窗口',
        r'硬件|GPU|CPU|显卡|内存|显存|未说明',
        r'推理|解码|延迟|吞吐|部署|测试时|未说明',
    )
    reproducibility_text = f'{method}\n{details}'
    details_coverage = sum(bool(re.search(pattern, reproducibility_text, re.I)) for pattern in reproducibility_signals)
    if details_coverage < 3:
        return f'manual v3 复现信息覆盖不足: {details_coverage}/5 类'

    score_lines = [item.strip() for item in scoring.splitlines() if item.strip().startswith('*')]
    if len(score_lines) != 8:
        return f'manual v3 评分理由必须恰好 8 条: {len(score_lines)}/8'
    for item in score_lines:
        reason = re.sub(r'^\*[^：:]*[：:]\s*', '', item)
        if _manual_chinese_count(reason) < 25:
            return f'manual v3 评分理由过于概括: {item[:80]}'
    if any(re.search(r'(?:创新|方法|实验|清晰度|实用|开源|可复现性|综合)维度(?:认可|体现|有|中)', item) for item in score_lines):
        return 'manual v3 评分理由仍是“某维度认可/体现”模板，必须直接写论文证据与扣分边界'

    if '论文证据直接支持的边界' not in limits or '进一步审视' not in limits:
        return 'manual v3 局限必须分开标注论文证据支持的边界与进一步审视'
    if _manual_chinese_count(limits) < 300:
        return f'manual v3 局限分析过短: {_manual_chinese_count(limits)}/300'
    return None


def validate_manual_editorial_quality_v4(analysis):
    """Publish-time high-confidence mirror of the Manual v4 reader gate.

    The complete near-duplicate and result-source checks run in Node while the
    controlled full text is available.  Python repeats reader-visible checks
    that remain exactly recomputable from the canonical Markdown.
    """
    sections = {
        name: _extract_analysis_section(analysis, heading)
        for name, heading in (
            ('authors', '作者与机构'), ('review', '毒舌点评'),
            ('summary', '核心摘要'), ('method', '方法概述和架构'),
            ('innovations', '核心创新点'), ('results', '实验结果'),
            ('details', '细节详述'), ('limits', '局限与问题'),
            ('scoring', '评分理由'), ('open_source', '开源详情'),
        )
    }
    numeral_chars = '零〇一二两三四五六七八九十百千万亿'
    simple_count_unit_items = (
        'GPU 小时', 'GPU小时', 'GPU 秒', 'GPU秒',
        '毫秒', '秒', '分钟', '小时', '天', '兆赫', '千赫', '赫兹', '分贝',
        '百分点', '毫焦', '皮焦', '兆字节', '千字节', '字节',
        'GB', 'MB', 'KB', 'mJ', 'dB', 'Hz', 'kHz', 'MHz', 'MAC', 'MACs',
        'token', 'tokens', '像素', '采样', '自由度', '帧', '个随机种子', '随机种子',
        '个', '对', '种', '条', '篇', '张', '段', '轮', '步', '次', '倍', '人', '名',
        '例', '维', '层', '位', '核', '类', '组', '路', '级', '阶', '流',
        '通道', '阶段', '分支', '模型', '基准', '数据集', '物种', '会话',
        '目录', '艺人', '轨道', '模态', '套', '卡', '分制', '男', '女',
        '个组件', '个任务', '个条件', '个类别', '个模型', '个数据集',
        '个时间点', '个方向', '个卷积块', '个流', 'worker', 'workers',
        'episode', 'episodes', 'epoch', 'epochs',
    )
    large_count_unit_items = simple_count_unit_items + (
        '个动作', '个样本', '个片段', '个关键词', '个文件', '个条件',
        '个刺激', '名参与者', '样本', '参数', '词', '批', '折', '参与者',
        '题', '轨迹', '主干',
    )
    unit_pattern = lambda items: '|'.join(
        re.escape(item) for item in sorted(set(items), key=len, reverse=True)
    )
    large_count_units = unit_pattern(large_count_unit_items)
    simple_count_units = unit_pattern(simple_count_unit_items)
    exact_quantity_patterns = (
        re.compile(rf'百分之[{numeral_chars}]+(?:点[{numeral_chars}]+)?', re.I),
        re.compile(rf'[负正]?[{numeral_chars}]+点[{numeral_chars}]+', re.I),
        re.compile(
            rf'(?<![第{numeral_chars}])[负正]?[{numeral_chars}]*[十百千万亿][{numeral_chars}]*\s*'
            rf'(?:{large_count_units})', re.I,
        ),
        re.compile(rf'(?<![第{numeral_chars}])[一二两三四五六七八九]\s*(?:{simple_count_units})', re.I),
        re.compile(rf'[负正]?[{numeral_chars}]+(?:到|至|–|—|-)[负正]?[{numeral_chars}]+(?=\s*(?:的)?(?:分数|评分|范围|区间|等级))', re.I),
        re.compile(rf'[{numeral_chars}]+\s*(?:比|:|：)\s*[{numeral_chars}]+', re.I),
        re.compile(rf'[{numeral_chars}]+\s*乘\s*[{numeral_chars}]+', re.I),
        re.compile(rf'[{numeral_chars}]+点[{numeral_chars}]*\d+', re.I),
        re.compile(rf'[{numeral_chars}]+\d+(?=\s*(?:{large_count_units}))', re.I),
        re.compile(rf'[{numeral_chars}]+\s*(?:到|至|–|—|-)\s*\d+(?=\s*(?:{large_count_units}))', re.I),
        re.compile(r'\d+(?:\.\d+)?\s*[万亿](?=\s*(?:更新|参数|样本|条|次|帧|token|tokens|MAC|MACs))', re.I),
        re.compile(r'(?:至少)?一半|半宽|四分之一(?:宽)?|[一二两三四五六七八九]成(?=(?:左右|上下|或|以内|以上|比例|占比|水平|样本|数据|案例|[，,。；;、]|$))'),
        re.compile(r'(?:最高|满分|得分|评分|至少|超过|低于|高于|达到)\s*[一二两三四五六七八九]\s*分|[一二两三四五六七八九]\s*分(?:制|量表|以上|以下|满分)|[一二两三四五六七八九]\s*分(?=\s*(?:[，,。；;、]|$))'),
        re.compile(r'[几数]\s*\d+(?=\s*(?:毫秒|秒|分钟|小时|天|Hz|kHz|MHz|MB|GB|KB|mJ|dB|帧|步|倍))', re.I),
        re.compile(
            rf'(?:LoRA\s*)?(?:秩|rank|alpha|缩放系数|阈值|beam|batch(?:\s*size)?|hop|'
            rf'窗口|采样率|分辨率|上下文长度|时间步|通道数|层数|维度)'
            rf'\s*(?:=|为|:)?\s*[{numeral_chars}]+', re.I,
        ),
    )
    reader_template_patterns = (
        re.compile(r'关键比较问题是[：:]'),
        re.compile(r'下图用于核对'),
        re.compile(r'证据边界在于'),
        re.compile(r'下一段将(?:解释|说明|展示|讨论)'),
        re.compile(r'^\s*\d+[.)、]\s*是(?=\S)', re.M),
    )
    reader_spaced_quantifiers = (
        '个百分点', '个随机种子', '名参与者', '个文件', '个会话', '个模型', '个候选', '个组合',
        '个病例', '段录音', '个场景', '个样本', '个片段', '个数据集', '个组件', '个任务',
        '个条件', '个类别', '个时间点', '个方向', '个卷积块',
        '个', '次', '名', '组', '套', '层', '种', '段', '轮', '步', '倍', '人', '例', '类',
        '张', '篇', '条', '对', '位', '路', '维', '帧', '卡', '分制', '会话', '模型', '候选',
        '组合', '病例', '录音', '文件', '场景', '样本', '片段', '数据集', '组件', '任务',
        '条件', '类别', '时间点', '方向', '卷积块',
        '毫秒', '秒', '分钟', '小时', '天', '兆赫', '千赫', '赫兹', '分贝', '毫焦', '皮焦',
        '兆字节', '千字节', '字节', 'mW', 'mJ', 'ms', 'dB', 'Hz', 'kHz', 'MHz',
        'KiB', 'KB', 'MB', 'GB', 'MAC', 'MACs', 'token', 'tokens', '像素', '采样', '自由度',
    )
    numeric_connector_prefixes = (
        '分别为', '提高到', '提升至', '增加到', '下降到', '降低至', '降至', '升至',
        '最多保留', '批量分别', '实际选', '每提示', '样本只', '单台',
        '从', '由', '到', '至', '为', '达', '含', '有', '共', '约', '近', '超过', '低于', '高于',
        '提高', '提升', '增加', '下降', '减少', '加入', '读取', '使用', '采用', '包含', '覆盖',
        '处理', '训练', '测试', '运行', '观看', '留出', '选择', '固定', '生成', '组成', '形成',
        '比较', '估算', '执行', '标注', '包括', '总计', '平均', '达到', '放入', '请求',
        '上限', '阈值', '权重', '学习率', '综合分', '版本', '版',
        '第', '在', '以', '把', '与', '和', '及', '或', '是', '只', '各', '选', '转', '加',
        '对', '前', '后', '比', '按', '做', '属于',
    )
    numeric_connector_suffixes = (
        '分别', '以及', '和', '与', '到', '至', '已', '仍', '又', '为', '是', '的', '后', '前',
        '时', '中', '下', '上', '可', '能', '并', '而', '只是', '同时', '属于', '门控',
        '首波', '状态', '地图', '审计', '完整', '主干', '因果', '协议', '声学', '权重',
        '上限', '变化', '设置', '版本', '轨迹', '结果', '记忆',
    )
    reader_number = r'(?<![A-Za-z0-9_.-])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?'
    numeric_typography_patterns = (
        re.compile(r'[\u4e00-\u9fff][-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?'),
        re.compile(rf'{reader_number}(?=[\u4e00-\u9fff])'),
        re.compile(
            rf'{reader_number}(?:{unit_pattern(reader_spaced_quantifiers)})', re.I,
        ),
        re.compile(
            rf'(?:{unit_pattern(numeric_connector_prefixes)}){reader_number}',
        ),
        re.compile(
            rf'{reader_number}(?:{unit_pattern(numeric_connector_suffixes)})',
        ),
        re.compile(
            r'(?:下|上|这|另|哪)\s*1\s*(?:步|层|类|种|段|项|组|张|个)|'
            r'(?:同|唯|统|单)\s*1\s*(?=[\u4e00-\u9fff])|归\s*1\s*(?=(?:化|后|组合|处理|权重))',
        ),
        re.compile(
            r'[\u4e00-\u9fff][\t \u3000]+一次性|一次性[\t \u3000]+[\u4e00-\u9fff]',
        ),
        re.compile(
            r'[\u4e00-\u9fff](?:T|F|K|N|SNR|IoU|batch|beta|top-k)\s*=\s*\d|'
            r'\b(?:T|F|K|N|SNR|IoU|batch|beta|top-k)\s*=\s*\d+(?:\.\d+)?(?=[\u4e00-\u9fff])',
            re.I,
        ),
        re.compile(r'(?:\d+(?:\.\d+)?(?:D|B|K|M|G|bit|DoF|FPS|Vpp|MHz|GB|TB))(?=[\u4e00-\u9fff])', re.I),
    )
    for section, body in sections.items():
        body = unicodedata.normalize('NFKC', body)
        # 百分号属于数值本身；“前10% / 提升19.5%”保留中文常用写法，
        # 不交给连接词粘连规则。等长屏蔽避免改变其余诊断位置。
        typography_body = re.sub(
            r'(?:[\u4e00-\u9fff])?[-+]?\d+(?:\.\d+)?\s*%',
            lambda match: ' ' * len(match.group(0)),
            body,
        )
        # Keep this normalization isomorphic with
        # editorial-quality.js/findQuantitativeChineseNumerals.  Markdown
        # headings are reader-facing labels rather than empirical claims (for
        # example, “从 306 通道到一个词标签”), and a small set of idiomatic
        # “一个 + adjective” phrases is not a measured count.  Replace with
        # equal-length blanks so later matching cannot drift into adjacent
        # text.
        quantity_body = re.sub(
            r'^#{1,6}\s+[^\n]*$',
            lambda match: ' ' * len(match.group(0)),
            body,
            flags=re.M,
        )
        quantity_body = re.sub(
            r'(?:进一步|这一步|下一步|上一步|每一步|一次性|这一类|有趣二分)|'
            r'(?:同一|统一|唯一|单一)(?=[\u4e00-\u9fff])|'
            r'一个(?=(?:好看|漂亮|笼统|粗糙|清晰|完整|简单|直接|孤立|统一))|'
            r'二分(?=(?:解释|结构|视角|框架|法))',
            lambda match: ' ' * len(match.group(0)),
            quantity_body,
        )
        for pattern in exact_quantity_patterns:
            match = pattern.search(quantity_body)
            if match:
                return f'manual v4 {section} 精确定量必须使用阿拉伯数字: {match.group(0)}'
        for pattern in reader_template_patterns:
            match = pattern.search(body)
            if match:
                return f'manual v4 {section} 仍使用批量模板句式: {match.group(0)}'
        for paragraph in re.split(r'\n\s*\n', body):
            if paragraph.strip().endswith(('；', ';')):
                return f'manual v4 {section} 段落以分号中断，必须补成完整论述'
        broken = re.search(
            r'尚尚|只只|分别分别|只有仅有|单单个|能能(?!否|够)|具有有(?:吸引力|优势|价值|能力|作用|意义|效果|潜力|特点|必要性)|'
            r'更接近区别于|存在也区别于其|无明显退化区别于|却区别于|提高现实性却区别于|2\s*次计算成本|'
            r'[“"]?(?:听懂|理解)[^。！？!?]{0,12}[”"]?区别于(?:能|能够|可以|具备)|'
            r'(?:参数|计算|内存)高效区别于(?:推理|训练|部署)(?:廉价|便宜|成本低)|'
            r'(?:客服|模板|提示)文本区别于(?:自发|真实)(?:客服)?(?:通话|对话|语音)|'
            r'(?:素材池|样本池|数据池)规模[^。！？!?]{0,24}区别于(?:最终)?(?:题量|样本量)|'
            r'源(?:音频|语音|数据)[^。！？!?]{0,16}区别于真实(?:通话|设备|场景|分布)|'
            r'但[^。！？!?]{0,80}[，,]但',
            body,
        )
        if broken:
            return f'manual v4 {section} 存在重复或断裂连接表达: {broken.group(0)}'
        for pattern in numeric_typography_patterns:
            match = pattern.search(typography_body)
            if match:
                return f'manual v4 {section} 数值排版或固定词损坏: {match.group(0)}'
        if re.search(
            r'^\s*\d+[.)、]\s*第\s*(?:\d+|[一二两三四五六七八九十百]+)\s*'
            r'(?:项|个|点)(?=[\u4e00-\u9fff\s，,：:])',
            body,
            re.M,
        ):
            return f'manual v4 {section} 存在双重编号'
        if section == 'innovations' and re.search(
            r'(?:^|\n\s*\n)\s*第\s*(?:\d+|[一二两三四五六七八九十百]+)\s*'
            r'(?:项|个)(?=[\u4e00-\u9fff\s，,：:])',
            body,
        ):
            return 'manual v4 innovations 将自动渲染为列表，正文不得重复使用第 N 个/项序数'
        for line in body.splitlines():
            if line.strip() in {'论文证据直接支持的边界', '进一步审视'}:
                return f'manual v4 {section} 暴露裸编辑字段标签'
        visible = re.sub(r'`[^`]*`', '', body)
        visible = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', visible)
        visible = re.sub(r'https?://[^\s)]+|[*_~]+', '', visible)
        adhesion = re.search(r'(?:[\u4e00-\u9fff][A-Za-z][A-Za-z0-9.+-]{1,}|[A-Za-z][A-Za-z0-9.+-]{1,}[\u4e00-\u9fff])', visible)
        if adhesion:
            return f'manual v4 {section} 中英文技术词边界缺少空格: {adhesion.group(0)}'
        for paragraph in _manual_editorial_prose_paragraphs(body):
            if _manual_han_character_count(paragraph) > 260 or len(re.findall(r'[。！？；!?;]', paragraph)) > 7:
                return f'manual v4 {section} 段落过载，必须拆分并建立推进关系'
    seen = {}
    for section, body in sections.items():
        for sentence in re.split(r'(?<=[。！？!?；;])', body):
            normalized = re.sub(r'[\s\W_]+', '', sentence.lower())
            if len(normalized) < 20:
                continue
            prior = seen.get(normalized)
            if prior and prior != section:
                return f'manual v4 {prior}/{section} 存在重复长句'
            seen[normalized] = section
    return None


FINAL_MANUAL_SECTION_HEADINGS = (
    '作者与机构', '毒舌点评', '核心摘要', '方法概述和架构',
    '核心创新点', '实验结果', '细节详述', '评分理由',
    '局限与问题', '开源详情', '补充信息',
    # Manual v5 reader-first pages replace the fixed v4 method/innovation/
    # result/detail/limit facade with a single paper-specific reader article.
    # Normalizing this generated H3 to the reader-view H2 is necessary for
    # final-page evidence checks to address it deterministically.
    '深度解读', '开源与复现资源', '评分依据与证据（展开查看）',
)


def _manual_v4_reader_view(markdown):
    """Turn rendered blog section headings back into the canonical heading view."""
    text = str(markdown or '')
    frontmatter = re.match(r'^---\n.*?\n---\n', text, flags=re.DOTALL)
    if frontmatter:
        text = text[frontmatter.end():]
    headings = '|'.join(re.escape(item) for item in FINAL_MANUAL_SECTION_HEADINGS)
    return re.sub(
        rf'^[^\S\r\n]*#{{1,6}}[^\S\r\n]+'
        rf'(?:[^\w\s#]\ufe0f?[^\S\r\n]*)*({headings})[^\S\r\n]*$',
        lambda match: f'## {match.group(1)}',
        text,
        flags=re.MULTILINE,
    )


def _final_manual_depth_contract(markdown, paper=None):
    if isinstance(paper, dict):
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if isinstance(contracts, dict):
            value = contracts.get('manualDepth')
            if value in MANUAL_READER_QUALITY_VERSIONS:
                return value
    match = re.search(
        rf'^paper_digest_manual_depth:\s*["\']?'
        rf'({re.escape(MANUAL_DEPTH_CONTRACT_VERSION_V4)}|{re.escape(MANUAL_DEPTH_CONTRACT_VERSION_V5)}|{re.escape(MANUAL_DEPTH_CONTRACT_VERSION_V6)})["\']?\s*$',
        str(markdown or ''), flags=re.MULTILINE,
    )
    return match.group(1) if match else None


def _is_final_manual_v4(markdown, paper=None):
    """Backward-compatible predicate for Manual reader-quality pages (v4/v5)."""
    return _final_manual_depth_contract(markdown, paper) is not None


def _final_markdown_image_occurrences(markdown):
    blocks = [block.strip() for block in re.split(r'\n\s*\n', str(markdown or '')) if block.strip()]
    occurrences = []
    for index, block in enumerate(blocks):
        bare = re.fullmatch(
            r'!\[(?:\\.|[^\]\\])*\]\((https://[^)\s]+)(?:\s+["\'][^"\']*["\'])?\)',
            block,
        )
        linked = re.fullmatch(
            r'\[!\[(?:\\.|[^\]\\])*\]\((https://[^)\s]+)\)\]\((https://[^)\s]+)\)',
            block,
        )
        # Publication sanitization wraps remote images in a self-link.  Check
        # that outer form first: its inner `![](...)` is also a valid prefix
        # for the bare-image pattern, which otherwise counted the same image
        # twice and broke selectedImageUrls ordering.
        if linked and linked.group(1) == linked.group(2):
            occurrences.append((index, linked.group(1), blocks))
        elif bare:
            occurrences.append((index, bare.group(1), blocks))
    return occurrences


def validate_final_manual_v4_markdown(markdown, paper=None):
    """Recheck Manual v4 contracts on the exact reader-facing Markdown.

    This intentionally runs after publication sanitization/rendering.  It does
    not trust that a valid canonical analysis stayed valid while headings,
    anchors, images and surrounding prose were assembled into a blog page.
    """
    manual_depth = _final_manual_depth_contract(markdown, paper)
    if manual_depth is None:
        return None
    if isinstance(paper, dict):
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if isinstance(contracts, dict) \
                and contracts.get('manualDepth') in MANUAL_READER_QUALITY_VERSIONS \
                and not re.search(
                    rf'^paper_digest_manual_depth:\s*["\']?(?:{re.escape(MANUAL_DEPTH_CONTRACT_VERSION_V4)}|{re.escape(MANUAL_DEPTH_CONTRACT_VERSION_V5)}|{re.escape(MANUAL_DEPTH_CONTRACT_VERSION_V6)})["\']?\s*$',
                    str(markdown or ''), flags=re.MULTILINE,
                ):
            return '最终 Markdown 缺少 Manual v4 深度标记'

    reader_view = _manual_v4_reader_view(markdown)
    is_v5_reader_article = manual_depth in {
        MANUAL_DEPTH_CONTRACT_VERSION_V5,
        MANUAL_DEPTH_CONTRACT_VERSION_V6,
    }
    required = (
        ('核心摘要', '深度解读', '评分依据与证据（展开查看）')
        if manual_depth == MANUAL_DEPTH_CONTRACT_VERSION_V6 else
        ('核心摘要', '深度解读') if is_v5_reader_article else
        ('核心摘要', '方法概述和架构', '核心创新点', '实验结果',
         '细节详述', '局限与问题')
    )
    missing = [heading for heading in required if not _extract_analysis_section(reader_view, heading)]
    if missing:
        version = 'v6' if manual_depth == MANUAL_DEPTH_CONTRACT_VERSION_V6 \
            else ('v5' if is_v5_reader_article else 'v4')
        return f'最终 Markdown 缺少 Manual {version} 读者章节: {"、".join(missing)}'

    v6_payload = None
    if manual_depth == MANUAL_DEPTH_CONTRACT_VERSION_V6:
        if not isinstance(paper, dict):
            return '最终 Manual v6 页面缺少 authoritative canonical paper'
        try:
            v6_payload = validate_manual_v6_payload(paper)
        except PublishDataValidationError as exc:
            return f'最终 Manual v6 canonical 闭环无效: {exc}'
        provenance = v6_payload['provenance']
        marker_values = {
            'paper_digest_v6_runtime_mode': 'production',
            'paper_digest_reader_longform': MANUAL_LONGFORM_CONTRACT_VERSION_V2,
            'paper_digest_reader_longform_sha256': provenance['readerLongformSha256'],
            'paper_digest_reader_article_sha256': v6_payload['articleSha256'],
            'paper_digest_artifact_index_sha256': v6_payload['artifactIndexSha256'],
            'paper_digest_v6_spec_root_sha256': provenance['specRootSha256'],
            'paper_digest_v6_paper_spec_sha256': provenance['paperSpecSha256'],
            'paper_digest_v6_sealed_record_sha256': provenance['sealedRecordSha256'],
            'paper_digest_v6_record_file_sha256': provenance['recordFileSha256'],
            'paper_digest_v6_artifact_index_file_sha256': provenance['artifactIndexFileSha256'],
            'paper_digest_v6_records_envelope_file_sha256': provenance['recordsEnvelopeFileSha256'],
            'paper_digest_v6_task_evidence_sha256': provenance['taskEvidenceSha256'],
        }
        for field, expected in marker_values.items():
            match = re.search(
                rf'^{re.escape(field)}:\s*["\']?([^"\'\s]+)["\']?\s*$',
                str(markdown or ''), flags=re.MULTILINE,
            )
            if not match or match.group(1) != expected:
                return f'最终 Manual v6 页面 {field} 与 canonical 绑定不一致'
        nested_article = re.sub(
            r'^(#{1,6})(\s+)',
            lambda match: '#' * max(len(match.group(1)), 4) + match.group(2),
            v6_payload['article'], flags=re.MULTILINE,
        )
        expected_article = sanitize_markdown_for_publish(nested_article).strip()
        actual_article = _extract_analysis_section(reader_view, '深度解读').strip()
        actual_article = actual_article.split(
            '\n<details>\n<summary>📎 论文与评分元数据</summary>', 1,
        )[0].strip()
        if actual_article != expected_article:
            return '最终 Manual v6 深度正文不再是 canonical blocks 的确定性渲染'
        scoring_reason = str((paper.get('parsed') or {}).get('scoringReason') or '').strip()
        scoring_section = _extract_analysis_section(
            reader_view, '评分依据与证据（展开查看）',
        )
        expected_scoring = sanitize_markdown_for_publish(re.sub(
            r'^(#{1,6})(\s+)',
            lambda match: '#' * max(len(match.group(1)), 4) + match.group(2),
            scoring_reason, flags=re.MULTILINE,
        )).strip()
        if not expected_scoring or expected_scoring not in scoring_section:
            return '最终 Manual v6 评分依据没有与 canonical scoringReason 闭环'
        for table in v6_payload['deterministicTables']:
            if table not in actual_article:
                return '最终 Manual v6 页面遗漏或改写了 ArtifactIndex 确定性表格'
        bundle = v6_payload['bundle']
        artifact = v6_payload['artifactIndex']
        formulas = {
            str(item.get('id') or item.get('url') or ''): item
            for item in artifact.get('formulas') or [] if isinstance(item, dict)
        }
        for item in bundle.get('formulas') or []:
            if item.get('disposition') == 'omit':
                continue
            source = formulas.get(str(item.get('id') or item.get('url') or ''), {})
            raw = _manual_v6_text(source.get('raw') or source.get('latex') or source.get('text'))
            if (raw and raw not in actual_article) or _manual_v6_text(item.get('explanation')) not in actual_article:
                return '最终 Manual v6 页面公式原式或教学解释缺失'
        for item in bundle.get('terms') or []:
            if (_manual_v6_text(item.get('term')) not in actual_article
                    or _manual_v6_text(item.get('definition')) not in actual_article):
                return '最终 Manual v6 页面术语首次定义缺失'
        for item in bundle.get('relatedWorks') or []:
            if (_manual_v6_text(item.get('relationship')) not in actual_article
                    or _manual_v6_text(item.get('difference')) not in actual_article):
                return '最终 Manual v6 页面 related-work 关系或差异缺失'

    if (isinstance(paper, dict)
            and not _manual_v6_signed_compatibility(
                paper, paper.get('analysisManifest'),
            )):
        manifest = paper.get('analysisManifest')
        takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
        if not isinstance(takeover, dict):
            return '最终 Markdown 缺少 authoritative Manual v4 resultClaims'
        try:
            _validate_manual_v4_result_claims(
                takeover,
                reader_view,
                str(paper.get('arxivId') or paper.get('id') or 'authoritative paper'),
                reader_section='深度解读' if is_v5_reader_article else '实验结果',
            )
        except PublishDataValidationError as exc:
            return f'最终 Markdown resultClaims 读者可见闭环无效: {exc}'

    selected = None
    if isinstance(paper, dict) and isinstance(paper.get('selectedImageUrls'), list):
        excluded = {
            item.get('url') for item in paper.get('publishImageExclusions', [])
            if isinstance(item, dict) and isinstance(item.get('url'), str)
        }
        selected = [
            str(url) for url in paper['selectedImageUrls']
            if isinstance(url, str) and url.startswith('https://') and url not in excluded
        ]
    occurrences = _final_markdown_image_occurrences(reader_view)
    occurrence_urls = [url for _index, url, _blocks in occurrences]
    if v6_payload is not None:
        figure_sources = {
            str(item.get('id') or item.get('url') or ''): str(item.get('url') or '')
            for item in v6_payload['artifactIndex'].get('figures') or []
            if isinstance(item, dict)
        }
        expected_figure_urls = [
            figure_sources.get(str(item.get('id') or item.get('url') or ''), '')
            for item in v6_payload['bundle'].get('figures') or []
            if isinstance(item, dict) and item.get('disposition') != 'omit'
        ]
        if (not all(expected_figure_urls)
                or sorted(occurrence_urls) != sorted(expected_figure_urls)):
            return '最终 Manual v6 图片没有逐项以独立 Markdown 图块进入正文'
    if selected is not None and occurrence_urls != selected:
        return '最终 Markdown 图片 URL/顺序与 selectedImageUrls 不一致'
    for index, url, blocks in occurrences:
        if index == 0 or index + 1 >= len(blocks):
            return f'{url} 在最终 Markdown 中缺少图前或图后相邻正文'
        issue = _validate_image_narrative_pair(blocks[index - 1], blocks[index + 1])
        if issue:
            return f'{url} 最终 Markdown 图片叙事无效: {issue}'

    document_type = ''
    if isinstance(paper, dict):
        document_type = str((paper.get('parsed') or {}).get('documentType') or '')
    if not document_type:
        match = re.search(r'(?:^|[|\n])\s*文档类型[：:]\s*([^|\n]+)', reader_view)
        document_type = match.group(1).strip() if match else ''
    canonical_results = ''
    if isinstance(paper, dict):
        canonical_results = _extract_analysis_section(
            str(paper.get('analysis') or ''), '实验结果',
        )
    if not is_v5_reader_article:
        table_issue = validate_experiment_table_contract(
            reader_view,
            contract_version=EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type=document_type,
            # Node already binds the evidence-rich source gates to the controlled
            # full-text experiment slice.  At final-page time only the canonical
            # experiment section is authoritative: using the whole analysis here
            # lets words such as "消融" or "退化" in methods/limits create false
            # source obligations that never existed in the experiment evidence.
            source_text=canonical_results,
        )
        if table_issue:
            return f'最终 Markdown evidence-rich 表格无效: {table_issue}'

    seen_paragraphs = set()
    for block in re.split(r'\n\s*\n', reader_view):
        stripped = block.strip()
        if not stripped or stripped.startswith(('#', '|', '![', '-', '*', '>', '```', '~~~')):
            continue
        if _manual_chinese_count(stripped) < 30:
            continue
        normalized = re.sub(
            r'[\s\W_]+', '', unicodedata.normalize('NFKC', stripped).casefold(),
        )
        if normalized in seen_paragraphs:
            return '最终 Markdown 存在完全重复的长正文段落'
        seen_paragraphs.add(normalized)

    editorial_issue = validate_manual_editorial_quality_v4(reader_view)
    if editorial_issue:
        return f'最终 Markdown 读者文本质量无效: {editorial_issue}'
    return None


def validate_digest_index_reader_quality(markdown, required=False):
    """Validate exact generated index prose while preserving old unmarked pages.

    New generation explicitly marks the index protocol.  Historical indexes
    predate this reader gate and remain readable unless a caller explicitly
    requests the new contract.
    """
    text = str(markdown or '')
    marker = re.search(
        rf'^paper_digest_reader_quality:\s*["\']?'
        rf'{re.escape(DIGEST_INDEX_READER_QUALITY_VERSION)}["\']?\s*$',
        text,
        flags=re.MULTILINE,
    )
    if not marker:
        return '汇总页缺少读者质量协议标记' if required else None
    if not re.search(r'^paper_digest_page_type:\s*index\s*$', text, re.MULTILINE):
        return '汇总页读者质量协议只能用于 index 页面'
    frontmatter = re.match(r'^---\n.*?\n---\n', text, flags=re.DOTALL)
    body = text[frontmatter.end():] if frontmatter else text
    if not re.search(r'^##\s+.*今日概览', body, re.MULTILINE) \
            or not re.search(r'^##\s+.*论文列表', body, re.MULTILINE):
        return '汇总页缺少今日概览或论文列表'
    # Summary and resource blocks are byte-for-byte projections of sections
    # already validated on each single-paper page. Re-running the generic
    # longform prose heuristic across all 22 concatenated projections creates
    # cross-context false positives (for example two legitimate “但” clauses).
    # Keep structural/duplication checks on the index-owned prose while the
    # generation equality contract protects these reused blocks.
    index_owned_body = re.sub(
        r'^👥 \*\*作者与机构\*\*\n\n[\s\S]*?'
        r'(?=\n\n(?:💡 \*\*毒舌点评\*\*|📌 \*\*核心摘要\*\*))',
        '👥 **作者与机构**\n\n已绑定单篇作者机构。\n\n',
        body,
        flags=re.MULTILINE,
    )
    index_owned_body = re.sub(
        r'^📌 \*\*核心摘要\*\*\n\n[\s\S]*?(?=^🔗 \*\*开源资源\*\*$)',
        '📌 **核心摘要**\n\n单篇已审核心摘要。\n\n',
        index_owned_body,
        flags=re.MULTILINE,
    )
    index_owned_body = re.sub(
        r'^🔗 \*\*开源资源\*\*\n\n[\s\S]*?'
        r'(?=\n\n[^\n]*\*\*\d+(?:\.\d+)?/10\*\*|^---$)',
        '🔗 **开源资源**\n\n单篇已审开源资源。\n\n',
        index_owned_body,
        flags=re.MULTILINE,
    )
    # Keep the complete page in one synthetic section: otherwise its own H2
    # headings would make the generic Manual reader validator inspect only the
    # title preamble.
    synthetic = '## 核心摘要\n' + re.sub(
        r'^##\s+', '### ', index_owned_body, flags=re.MULTILINE,
    )
    issue = validate_manual_editorial_quality_v4(synthetic)
    if issue:
        return f'汇总页读者文本质量无效: {issue}'
    seen = set()
    for block in re.split(r'\n\s*\n', index_owned_body):
        stripped = block.strip()
        if not stripped or stripped.startswith(('#', '|', '---')):
            continue
        if _manual_chinese_count(stripped) < 30:
            continue
        normalized = re.sub(
            r'[\s\W_]+', '', unicodedata.normalize('NFKC', stripped).casefold(),
        )
        if normalized in seen:
            return '汇总页存在完全重复的长正文段落'
        seen.add(normalized)
    return None


def _finite_score(value, field, source):
    try:
        score = float(value)
    except (TypeError, ValueError) as exc:
        raise PublishDataValidationError(f'{source} 的 {field} 不是有效数字') from exc
    if not math.isfinite(score):
        raise PublishDataValidationError(f'{source} 的 {field} 不是有限数字')
    return score


def _dimension_occurrences(scoring_reason, label):
    pattern = re.compile(
        r'^\s*(?:[-+*]\s*)?(?:\*\*)?'
        + re.escape(label)
        + r'(?:\*\*)?\s*(?=[（(:：/]|$)',
        flags=re.MULTILINE,
    )
    return len(pattern.findall(scoring_reason or ''))


def validate_publish_parsed(
    parsed,
    source='parsed',
    require_reason_dimensions=False,
    validate_tags=True,
):
    """Validate and normalize the complete type-aware scoring contract."""
    if not isinstance(parsed, dict):
        raise PublishDataValidationError(f'{source} 必须是对象')

    normalized = dict(parsed)
    document_type = normalized.get('documentType')
    if document_type not in ALLOWED_DOCUMENT_TYPES:
        raise PublishDataValidationError(f'{source} 缺少有效 documentType: {document_type!r}')
    if normalized.get('scoringRubricVersion') != SCORING_RUBRIC_VERSION:
        raise PublishDataValidationError(
            f'{source} 的 scoringRubricVersion 必须为 {SCORING_RUBRIC_VERSION}'
        )

    dimension_total = 0.0
    scoring_reason = normalized.get('scoringReason', '')
    if require_reason_dimensions:
        score_validation = normalized.get('scoreValidation')
        if not isinstance(score_validation, dict) or score_validation.get('valid') is not True:
            validation_errors = score_validation.get('errors', []) if isinstance(score_validation, dict) else []
            details = '；'.join(str(error) for error in validation_errors[:3]) or '八维评分格式非法'
            raise PublishDataValidationError(f'{source} 的评分理由契约无效: {details}')
    for field, label, maximum in SCORING_DIMENSIONS:
        if field not in normalized or normalized.get(field) in (None, ''):
            raise PublishDataValidationError(f'{source} 缺少评分维度 {field}')
        score = _finite_score(normalized[field], field, source)
        if score < 0 or score > maximum:
            raise PublishDataValidationError(
                f'{source} 的 {field}={score:g} 超出 0-{maximum:g}'
            )
        if abs(score * 10 - round(score * 10)) > 1e-9:
            raise PublishDataValidationError(f'{source} 的 {field} 最多只能有一位小数')
        if field == 'openSourceScore' and not any(
            abs(score - anchor) <= 1e-9 for anchor in OPEN_SOURCE_SCORE_ANCHORS
        ):
            raise PublishDataValidationError(
                f'{source} 的 openSourceScore={score:g} 不在固定锚点集合'
            )
        dimension_total += score
        normalized[field] = f'{score:g}'
        if require_reason_dimensions:
            count = _dimension_occurrences(scoring_reason, label)
            if count != 1:
                raise PublishDataValidationError(
                    f'{source} 的评分理由中 {label} 必须且只能出现一个维度条目，当前为 {count}'
                )

    total = _finite_score(normalized.get('score'), 'score', source)
    if abs(total * 10 - round(total * 10)) > 1e-9:
        raise PublishDataValidationError(f'{source} 的 score 最多只能有一位小数')
    expected_total = min(10.0, dimension_total)
    if abs(total - expected_total) > 0.051:
        raise PublishDataValidationError(
            f'{source} 总分 {total:g} 与八维合计 {expected_total:g} 不一致'
        )
    normalized['score'] = f'{total:.1f}'

    if validate_tags:
        tags = normalized.get('tags', [])
        if tags is None:
            tags = []
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise PublishDataValidationError(f'{source} 的 tags 必须是字符串数组')
        normalized['tags'] = tags
    return normalized


def _scoring_mismatches(analysis_parsed, cached_parsed):
    mismatches = []
    for field in SCORING_COMPARE_FIELDS:
        left = analysis_parsed.get(field)
        right = cached_parsed.get(field)
        if field == 'score' or field.endswith('Score'):
            if abs(float(left) - float(right)) > 0.051:
                mismatches.append(field)
        elif left != right:
            mismatches.append(field)
    return mismatches


def _validate_manual_override(paper, mismatches, paper_label):
    override = paper.get('parsedOverride')
    if not isinstance(override, dict):
        raise PublishDataValidationError(
            f'{paper_label} 的 analysis 与 parsed 在 {", ".join(mismatches)} 不一致，'
            '必须提供 parsedOverride 人工覆盖来源'
        )
    unknown_keys = sorted(set(override) - MANUAL_OVERRIDE_KEYS)
    if unknown_keys:
        raise PublishDataValidationError(
            f'{paper_label} 的 parsedOverride 包含未知字段: {", ".join(unknown_keys)}'
        )
    if override.get('type') != 'manual':
        raise PublishDataValidationError(f'{paper_label} 的 parsedOverride.type 必须为 manual')
    source = override.get('source')
    reason = override.get('reason')
    fields = override.get('fields')
    if not isinstance(source, str) or not source.strip():
        raise PublishDataValidationError(f'{paper_label} 的 parsedOverride.source 不能为空')
    if not isinstance(reason, str) or not reason.strip():
        raise PublishDataValidationError(f'{paper_label} 的 parsedOverride.reason 不能为空')
    if not isinstance(fields, list) or any(not isinstance(field, str) for field in fields):
        raise PublishDataValidationError(f'{paper_label} 的 parsedOverride.fields 必须是字符串数组')
    if not fields or len(fields) != len(set(fields)):
        raise PublishDataValidationError(
            f'{paper_label} 的 parsedOverride.fields 必须非空且不能重复'
        )
    unknown_fields = sorted(set(fields) - MANUAL_OVERRIDE_ALLOWED_FIELDS)
    if unknown_fields:
        raise PublishDataValidationError(
            f'{paper_label} 的 parsedOverride.fields 包含不允许覆盖的字段: '
            f'{", ".join(unknown_fields)}'
        )
    missing_fields = sorted(set(mismatches) - set(fields))
    extra_fields = sorted(set(fields) - set(mismatches))
    if missing_fields or extra_fields:
        details = []
        if missing_fields:
            details.append(f'未声明差异字段: {", ".join(missing_fields)}')
        if extra_fields:
            details.append(f'声明了无差异字段: {", ".join(extra_fields)}')
        raise PublishDataValidationError(
            f'{paper_label} 的 parsedOverride.fields 与实际差异不一致（{"；".join(details)}）'
        )
    return fields


def resolve_publish_parsed(paper):
    """Return publish-safe parsed data after cross-checking its analysis source."""
    if not isinstance(paper, dict):
        raise PublishDataValidationError('论文记录必须是对象')
    paper_label = paper.get('arxivId') or paper.get('title') or '<unknown paper>'
    analysis = paper.get('analysis')
    if not isinstance(analysis, str) or not analysis.strip():
        raise PublishDataValidationError(f'{paper_label} 缺少 analysis')
    analysis_parsed = validate_publish_parsed(
        parse_analysis(analysis),
        f'{paper_label}.analysis',
        require_reason_dimensions=True,
    )

    if 'parsed' not in paper or paper.get('parsed') is None:
        raise PublishDataValidationError(f'{paper_label} 缺少 parsed 缓存，禁止未经一致性校验发布')
    cached_parsed = validate_publish_parsed(
        paper.get('parsed'),
        f'{paper_label}.parsed',
        validate_tags=False,
    )

    top_version = paper.get('scoringRubricVersion')
    if top_version != SCORING_RUBRIC_VERSION:
        raise PublishDataValidationError(
            f'{paper_label} 顶层 scoringRubricVersion 必须为 {SCORING_RUBRIC_VERSION}'
        )
    if top_version != cached_parsed['scoringRubricVersion']:
        raise PublishDataValidationError(f'{paper_label} 顶层与 parsed 评分版本不一致')

    mismatches = _scoring_mismatches(analysis_parsed, cached_parsed)
    if mismatches:
        override_fields = _validate_manual_override(paper, mismatches, paper_label)
    elif paper.get('parsedOverride') is not None:
        _validate_manual_override(paper, [], paper_label)
        raise PublishDataValidationError(f'{paper_label} 提供了无实际差异的 parsedOverride')
    else:
        override_fields = []

    # analysis is always the publication baseline. The cache can contribute only
    # explicitly declared, validated manual scoring overrides.
    resolved = dict(analysis_parsed)
    for field in override_fields:
        resolved[field] = cached_parsed[field]
    return validate_publish_parsed(
        resolved,
        f'{paper_label}.publishBaseline',
        require_reason_dimensions=True,
    )


def normalize_publish_arxiv_id(arxiv_id):
    """Normalize an arXiv ID for duplicate checks and stable filenames."""
    value = str(arxiv_id or '').strip().lower()
    value = re.sub(r'^https?://arxiv\.org/(?:abs|pdf)/', '', value)
    value = re.sub(r'^arxiv:', '', value)
    value = re.sub(r'\.pdf$', '', value)
    value = re.sub(r'v\d+$', '', value)
    if not value or not re.fullmatch(r'[a-z0-9][a-z0-9./-]*[a-z0-9]', value):
        raise PublishDataValidationError(f'无效 arXiv ID: {arxiv_id!r}')
    if '..' in value or value.startswith('/') or value.endswith('/'):
        raise PublishDataValidationError(f'不安全 arXiv ID: {arxiv_id!r}')
    return value


def validate_papers_for_publish(papers, *, validate_manual_provenance=True):
    """Validate every paper before creating any publish artifact.

    ``validate_manual_provenance=False`` is reserved for the derived
    publication-image-exclusion view.  Its canonical provenance was validated
    immediately before derivation; all reader-visible contracts are still
    rerun against the modified analysis.
    """
    if not isinstance(papers, list):
        raise PublishDataValidationError('待发布论文必须是数组')
    validated = []
    errors = []
    seen_arxiv_ids = {}
    for paper in papers:
        try:
            if not isinstance(paper, dict):
                raise PublishDataValidationError('论文记录必须是对象')
            paper_label = paper.get('arxivId') or paper.get('title') or '<unknown paper>'
            if not validate_manual_provenance:
                _validate_publish_image_exclusion_view(paper, paper_label)
            if paper.get('latestAnalysisAttemptError'):
                raise PublishDataValidationError(
                    f'{paper_label} 最新一次深度分析失败，禁止使用陈旧成功正文发布'
                )
            manifest = paper.get('analysisManifest')
            if manifest is not None:
                required_stages = (
                    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan',
                    'revision', 'tableRepair', 'methodRepair', 'structureRepair',
                    'scoringAudit', 'imageSupplement',
                )
                terminal_statuses = {
                    'imageDownload': {'complete', 'skipped', 'no_candidates', 'no_downloadable_images', MANUAL_COMPLETE_STATUS},
                    'primaryAnalysis': {'complete', MANUAL_COMPLETE_STATUS},
                    'openSourceScan': {'complete', MANUAL_COMPLETE_STATUS},
                    'demoLinkScan': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'revision': {'complete', MANUAL_COMPLETE_STATUS},
                    'tableRepair': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'methodRepair': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'structureRepair': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'scoringAudit': {'complete', MANUAL_COMPLETE_STATUS},
                    'imageSupplement': {
                        'complete', 'skipped', 'no_candidates',
                        'no_high_value_images', 'no_downloadable_images', MANUAL_COMPLETE_STATUS,
                    },
                }
                stages = manifest.get('stages') if isinstance(manifest, dict) else None
                incomplete = [
                    stage for stage in required_stages
                    if not isinstance(stages, dict)
                    or not isinstance(stages.get(stage), dict)
                    or stages[stage].get('status') not in terminal_statuses[stage]
                ]
                if manifest.get('version') != 1 or incomplete:
                    detail = ', '.join(incomplete) if incomplete else 'manifest version'
                    raise PublishDataValidationError(
                        f'{paper_label} 深度分析阶段尚未全部完成: {detail}'
                    )
                if validate_manual_provenance:
                    _validate_manual_takeover_manifest(paper, manifest, paper_label)
                signed_v6_compatibility = _manual_v6_signed_compatibility(
                    paper, manifest,
                )
                contracts = manifest.get('contracts')
                if contracts is not None and not isinstance(contracts, dict):
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts 必须是对象'
                    )
                table_contract = (
                    contracts.get('experimentTables') if isinstance(contracts, dict) else None
                )
                if table_contract is not None and table_contract not in EXPERIMENT_TABLE_CONTRACT_VERSIONS:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.experimentTables 非法: '
                        f'{table_contract}'
                    )
                if (table_contract in EXPERIMENT_TABLE_CONTRACT_VERSIONS
                        and not signed_v6_compatibility):
                    table_issue = validate_experiment_table_contract(
                        paper.get('analysis'),
                        contract_version=table_contract,
                        document_type=(paper.get('parsed') or {}).get('documentType', ''),
                        source_text=_manual_result_claim_source_text(paper),
                    )
                    if table_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 分析正文表格契约无效: {table_issue}'
                        )
                method_contract = (
                    contracts.get('methodDetail') if isinstance(contracts, dict) else None
                )
                if method_contract is not None and method_contract != METHOD_DETAIL_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.methodDetail 非法: '
                        f'{method_contract}'
                    )
                if (method_contract == METHOD_DETAIL_CONTRACT_VERSION
                        and not signed_v6_compatibility):
                    method_issue = validate_method_detail_contract(paper.get('analysis'))
                    if method_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 分析正文方法契约无效: {method_issue}'
                        )
                manual_depth_contract = (
                    contracts.get('manualDepth') if isinstance(contracts, dict) else None
                )
                if manual_depth_contract is not None and manual_depth_contract not in MANUAL_DEPTH_CONTRACT_VERSIONS:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.manualDepth 非法: '
                        f'{manual_depth_contract}'
                    )
                if manual_depth_contract in MANUAL_READER_QUALITY_VERSIONS \
                        and table_contract != EXPERIMENT_TABLE_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} manual v4 必须声明 '
                        f'experimentTables={EXPERIMENT_TABLE_CONTRACT_VERSION}'
                    )
                if not signed_v6_compatibility and manual_depth_contract in {
                        MANUAL_DEPTH_CONTRACT_VERSION_V3, *MANUAL_READER_QUALITY_VERSIONS}:
                    manual_depth_issue = validate_manual_depth_contract_v3(paper.get('analysis'))
                    if manual_depth_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} manual 全文深度契约无效: {manual_depth_issue}'
                        )
                    if manual_depth_contract in MANUAL_READER_QUALITY_VERSIONS:
                        editorial_issue = validate_manual_editorial_quality_v4(paper.get('analysis'))
                        if editorial_issue:
                            raise PublishDataValidationError(
                                f'{paper_label} manual v4 读者文本质量无效: {editorial_issue}'
                            )
                elif (not signed_v6_compatibility
                        and manual_depth_contract == MANUAL_DEPTH_CONTRACT_VERSION_V2):
                    manual_depth_issue = validate_manual_depth_contract_v2(paper.get('analysis'))
                    if manual_depth_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} manual 全文深度契约无效: {manual_depth_issue}'
                        )
                elif (not signed_v6_compatibility
                        and manual_depth_contract == MANUAL_DEPTH_CONTRACT_VERSION):
                    manual_depth_issue = validate_manual_depth_contract(paper.get('analysis'))
                    if manual_depth_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} manual 全文深度契约无效: {manual_depth_issue}'
                        )
                image_narrative_contract = (
                    contracts.get('imageNarrative') if isinstance(contracts, dict) else None
                )
                if manual_depth_contract in MANUAL_READER_QUALITY_VERSIONS \
                        and image_narrative_contract != IMAGE_NARRATIVE_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} manual v4 必须声明 '
                        f'imageNarrative={IMAGE_NARRATIVE_CONTRACT_VERSION}'
                    )
                if image_narrative_contract is not None \
                        and image_narrative_contract != IMAGE_NARRATIVE_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.imageNarrative 非法: '
                        f'{image_narrative_contract}'
                    )
                if (image_narrative_contract == IMAGE_NARRATIVE_CONTRACT_VERSION
                        and not signed_v6_compatibility):
                    image_narrative_issue = validate_image_narrative_contract(paper)
                    if image_narrative_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 图片上下文契约无效: {image_narrative_issue}'
                        )
                editorial_quality_contract = (
                    contracts.get('editorialQuality') if isinstance(contracts, dict) else None
                )
                if manual_depth_contract in MANUAL_READER_QUALITY_VERSIONS \
                        and editorial_quality_contract != EDITORIAL_QUALITY_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} manual v4 必须声明 '
                        f'editorialQuality={EDITORIAL_QUALITY_CONTRACT_VERSION}'
                    )
                if editorial_quality_contract is not None \
                        and editorial_quality_contract != EDITORIAL_QUALITY_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.editorialQuality 非法: '
                        f'{editorial_quality_contract}'
                    )
            if (paper.get('analysisSource') == 'abstract'
                    and paper.get('allowAbstractAnalysisPublish') is not True):
                raise PublishDataValidationError(
                    f'{paper_label} 仅基于摘要分析；如经人工确认仍需发布，必须显式设置 allowAbstractAnalysisPublish=true'
                )
            normalized_id = normalize_publish_arxiv_id(paper.get('arxivId'))
            if normalized_id in seen_arxiv_ids:
                raise PublishDataValidationError(
                    f'重复 normalized arXiv ID {normalized_id}: '
                    f'{seen_arxiv_ids[normalized_id]!r} 与 {paper.get("arxivId")!r}'
                )
            seen_arxiv_ids[normalized_id] = paper.get('arxivId')
            parsed = resolve_publish_parsed(paper)
            normalized_paper = dict(paper)
            normalized_paper['parsed'] = parsed
            normalized_paper['normalizedArxivId'] = normalized_id
            validated.append(normalized_paper)
        except PublishDataValidationError as exc:
            errors.append(str(exc))
    if errors:
        details = '\n'.join(f'- {error}' for error in errors)
        raise PublishDataValidationError(f'发布数据预检失败（{len(errors)} 篇）:\n{details}')
    return validated


def get_claude_code_version():
    """Return local Claude CLI version for Anthropic-compatible User-Agent."""
    try:
        result = subprocess.run(
            ['claude', '--version'],
            capture_output=True,
            text=True,
            timeout=1,
            check=False,
            env=build_child_process_env(),
        )
        output = (result.stdout or result.stderr or '').strip()
        match = re.match(r'^(\d+\.\d+\.\d+)', output)
        if match:
            return match.group(1)
    except Exception:
        pass
    return '2.1.108'


def detect_publish_api_type(endpoint, model):
    """检测发布脚本使用的 LLM API 协议，与 Node utils.js 保持一致。"""
    ep = (endpoint or '').rstrip('/').lower()
    m = (model or '').lower()
    if 'deepseek.com' in ep or 'deepseek' in m:
        return 'openai'
    if ep.endswith('/responses') or m == 'muse-spark-1.2-contributor':
        return 'openai_responses'
    is_token_plan = 'token-plan' in ep or 'coding' in ep
    is_mimo = 'xiaomimimo.com' in ep or 'mimo' in m
    is_kimi = 'kimi.com' in ep or 'kimi' in m
    if (is_mimo or is_kimi) and is_token_plan:
        return 'anthropic'
    if '/anthropic' in ep:
        return 'anthropic'
    return 'openai'


def _is_publish_loopback_hostname(hostname):
    normalized = str(hostname or '').lower().strip('[]')
    if normalized == 'localhost' or normalized.endswith('.localhost') or normalized == '::1':
        return True
    if not re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}', normalized):
        return False
    octets = [int(part) for part in normalized.split('.')]
    return all(0 <= octet <= 255 for octet in octets) and octets[0] == 127


def validate_publish_api_endpoint_url(endpoint):
    """只允许 HTTPS；明文 HTTP 仅供 loopback 本地测试服务。"""
    try:
        parsed = urllib.parse.urlsplit(endpoint)
        # Accessing these properties also rejects malformed brackets and ports.
        hostname = parsed.hostname
        _ = parsed.port
        username = parsed.username
        password = parsed.password
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(
            'LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）'
        ) from exc

    if not parsed.scheme or not hostname:
        raise ValueError('LLM endpoint 必须是完整的 HTTPS URL（本地测试可用 loopback HTTP）')
    if username is not None or password is not None:
        raise ValueError('LLM endpoint 禁止包含 URL userinfo 凭据')

    protocol = parsed.scheme.lower()
    if protocol == 'https':
        return parsed
    if protocol == 'http' and _is_publish_loopback_hostname(hostname):
        return parsed
    raise ValueError(
        f'LLM endpoint 禁止使用公网明文 {protocol or "协议"}；'
        '请改用 HTTPS，本地 HTTP 仅允许 loopback 地址'
    )


def build_publish_api_url(api_type, endpoint):
    """根据协议构造最终 LLM 请求 URL。"""
    validate_publish_api_endpoint_url(endpoint)
    base = (endpoint or '').rstrip('/')
    if api_type == 'anthropic':
        if 'xiaomimimo.com' in base:
            base = re.sub(r'/v1/?$', '/anthropic', base)
            return f'{base}/v1/messages'
        if 'kimi.com' in base:
            base = re.sub(r'/coding(?:/v1)?$', '/coding/v1', base, flags=re.IGNORECASE)
            return f'{base}/messages'
        return f'{base}/messages'
    if api_type == 'openai_responses':
        return base if base.endswith('/responses') else f'{base}/responses'
    base = re.sub(r'/anthropic/?$', '/v1', base)
    return f'{base}/chat/completions'


def build_publish_headers(api_type, api_key, claude_version=None):
    if api_type == 'anthropic':
        version = claude_version or get_claude_code_version()
        return {
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'User-Agent': f'claude-cli/{version} (external, cli)',
            'Content-Type': 'application/json'
        }
    return {
        'Authorization': f'Bearer {api_key}',
        # urllib's default Python-urllib/* identifier is rejected by some
        # OpenAI-compatible gateways (including OpenCode Go). Use an honest,
        # stable project identifier instead of impersonating a vendor SDK.
        'User-Agent': 'audio-paper-digest/1.0',
        'Content-Type': 'application/json'
    }


def build_publish_payload(api_type, model, prompt, max_tokens, temperature, images=None):
    images = images or []
    if api_type == 'anthropic':
        content = []
        for image in images:
            content.append({
                'type': 'image',
                'source': {
                    'type': 'base64',
                    'media_type': image['media_type'],
                    'data': image['data'],
                },
            })
        content.append({'type': 'text', 'text': prompt})
        return {
            'model': model,
            'max_tokens': max_tokens,
            'messages': [{'role': 'user', 'content': content if images else prompt}]
        }
    if api_type == 'openai_responses':
        content = [{'type': 'input_text', 'text': prompt}]
        for image in images:
            data_uri = f"data:{image['media_type']};base64,{image['data']}"
            content.append({
                'type': 'input_image',
                'image_url': data_uri,
                'detail': 'low',
            })
        payload = {
            'model': model,
            'max_output_tokens': max_tokens,
            'temperature': temperature,
            'input': [{'role': 'user', 'content': content}],
        }
        reasoning_effort = os.environ.get(
            'PD_OPENAI_RESPONSES_REASONING_EFFORT', ''
        ).strip().lower()
        if reasoning_effort in {'low', 'medium', 'high'}:
            payload['reasoning'] = {'effort': reasoning_effort}
        return payload
    content = [{'type': 'text', 'text': prompt}]
    for image in images:
        data_uri = f"data:{image['media_type']};base64,{image['data']}"
        content.append({
            'type': 'image_url',
            'image_url': {'url': data_uri, 'detail': 'low'},
        })
    return {
        'model': model,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'messages': [{'role': 'user', 'content': content if images else prompt}]
    }


def parse_publish_response_text(api_type, data):
    if api_type == 'anthropic':
        if isinstance(data.get('content'), list):
            for block in data['content']:
                if block.get('type') == 'text':
                    return (block.get('text') or '').strip()
        return ''
    if api_type == 'openai_responses':
        if isinstance(data.get('output_text'), str) and data['output_text'].strip():
            return data['output_text'].strip()
        parts = []
        for item in data.get('output') or []:
            if not isinstance(item, dict):
                continue
            for block in item.get('content') or []:
                if isinstance(block, dict) and isinstance(block.get('text'), str):
                    parts.append(block['text'])
        return '\n'.join(part for part in parts if part).strip()
    return (data.get('choices', [{}])[0].get('message', {}).get('content') or '').strip()


def _publish_llm_requires_proxy(endpoint, model):
    return str(model or '').lower() == 'muse-spark-1.2-contributor'


def call_publish_llm_api(
    prompt,
    max_tokens=800,
    temperature=0.1,
    required=False,
    context='LLM review',
    timeout=120,
    max_retries=5,
    images=None,
    use_secondary=False,
    structured_output=False,
):
    """调用发布阶段 LLM API。required=True 时，缺配置或连续失败会抛错。"""
    primary_key = os.environ.get('PAPER_ANALYZER_API_KEY', '')
    primary_endpoint = os.environ.get('PAPER_ANALYZER_ENDPOINT', '')
    if use_secondary:
        api_key = os.environ.get('PAPER_ANALYZER_SECONDARY_API_KEY', '') or primary_key
        endpoint = os.environ.get('PAPER_ANALYZER_SECONDARY_ENDPOINT', '') or primary_endpoint
        model = os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', '')
        config_names = (
            ('PAPER_ANALYZER_SECONDARY_API_KEY 或 PAPER_ANALYZER_API_KEY', api_key),
            ('PAPER_ANALYZER_SECONDARY_ENDPOINT 或 PAPER_ANALYZER_ENDPOINT', endpoint),
            ('PAPER_ANALYZER_SECONDARY_MODEL', model),
        )
    else:
        api_key = primary_key
        endpoint = primary_endpoint
        model = os.environ.get('PAPER_ANALYZER_MODEL', '')
        config_names = (
            ('PAPER_ANALYZER_API_KEY', api_key),
            ('PAPER_ANALYZER_ENDPOINT', endpoint),
            ('PAPER_ANALYZER_MODEL', model),
        )

    missing = [
        name for name, value in config_names if not value
    ]
    if missing:
        message = f"未配置 {', '.join(missing)}，无法执行 {context}"
        if required:
            raise PublishLLMUnavailable(message)
        print(f'  ⚠️  {message}，跳过')
        return None

    api_type = detect_publish_api_type(endpoint, model)
    try:
        # 安全校验必须先于任何包含 API key 的 header 或 Request 构造。
        api_url = build_publish_api_url(api_type, endpoint)
    except ValueError as exc:
        message = f'{context} 的 LLM endpoint 配置不安全: {exc}'
        if required:
            raise PublishLLMUnavailable(message) from exc
        print(f'  ⚠️  {message}，跳过')
        return None
    headers = build_publish_headers(api_type, api_key)
    last_error = None
    current_max_tokens = max(1, int(max_tokens))
    # Strict review responses are tiny JSON objects. Reasoning models may spend
    # the whole budget in hidden reasoning and return no final text; allowing
    # those calls to grow to 16K repeatedly wastes quota without improving the
    # protocol response. Keep generic publishing calls backward compatible,
    # while one structured recovery is capped at 8K unless the caller
    # explicitly configured a larger initial budget.
    adaptive_max_tokens = (
        max(current_max_tokens, 8000) if structured_output else 16000
    )
    request_prompt = prompt
    structured_recovery_used = False
    for attempt in range(max_retries):
        started_at = time.monotonic()
        retry_immediately = False
        try:
            print(
                f'  [publish-api] → {context} '
                f'(尝试 {attempt + 1}/{max_retries}, timeout={timeout}s, '
                f'prompt_chars={len(request_prompt)}, images={len(images or [])}, '
                f'max_tokens={current_max_tokens})'
            )
            payload = build_publish_payload(
                api_type, model, request_prompt, current_max_tokens, temperature, images=images
            )
            request = urllib.request.Request(
                api_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={**headers, 'Content-Type': 'application/json'},
                method='POST',
            )
            # Muse Spark Contributor 有地区限制，必须使用项目 .env 的
            # HTTP CONNECT 代理。其他模型继续显式直连，避免代理污染。
            if _publish_llm_requires_proxy(endpoint, model):
                proxy = get_required_fetch_proxy()
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({'http': proxy, 'https': proxy})
                )
            else:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=timeout) as response:
                status = response.status
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f'HTTP {response.status}')
                response_limit = 2 * 1024 * 1024
                raw_response = response.read(response_limit + 1)
                if len(raw_response) > response_limit:
                    raise RuntimeError('LLM 响应超过 2 MiB 安全上限')
                data = json.loads(raw_response.decode('utf-8'))
            content = parse_publish_response_text(api_type, data)
            # A Responses gateway may return valid-looking partial output_text
            # together with status=incomplete. Terminal state wins over content.
            if api_type == 'openai_responses' and data.get('status') == 'incomplete':
                content = ''
            if content:
                print(
                    f'  [publish-api] ✓ {context} | HTTP {status} | '
                    f'{time.monotonic() - started_at:.1f}s | response_chars={len(content)} '
                    f'| max_tokens={current_max_tokens}'
                )
                return content
            if api_type == 'anthropic':
                finish_reason = data.get('stop_reason')
                content_blocks = data.get('content') if isinstance(data.get('content'), list) else []
                reasoning_chars = sum(
                    len(str(block.get('thinking') or ''))
                    for block in content_blocks
                    if isinstance(block, dict)
                )
            elif api_type == 'openai_responses':
                finish_reason = (data.get('incomplete_details') or {}).get('reason')
                reasoning_chars = sum(
                    len(str(summary.get('text') or ''))
                    for item in data.get('output') or []
                    if isinstance(item, dict) and item.get('type') == 'reasoning'
                    for summary in item.get('summary') or []
                    if isinstance(summary, dict)
                )
            else:
                choice = (data.get('choices') or [{}])[0] or {}
                finish_reason = choice.get('finish_reason')
                message = choice.get('message') or {}
                reasoning_chars = len(str(message.get('reasoning_content') or ''))
            finish_label = finish_reason or 'unknown'
            last_error = RuntimeError(
                f'LLM 返回内容为空 (finish_reason={finish_label}, '
                f'reasoning_chars={reasoning_chars})'
            )
            if finish_reason in {'length', 'max_tokens', 'max_output_tokens'}:
                if structured_output and reasoning_chars > 0:
                    if structured_recovery_used:
                        print(
                            f'  [publish-api] ⛔ {context} 结构化响应再次被隐藏推理耗尽，'
                            f'停止继续扩大输出预算 (max_tokens={current_max_tokens})'
                        )
                        break
                    structured_recovery_used = True
                    request_prompt = (
                        prompt
                        + '\n\n上一次请求将输出预算全部用于隐藏推理。'
                        + '请立即停止展开推理，只输出最终 JSON 对象，不得输出分析过程。'
                    )
                    next_max_tokens = min(current_max_tokens * 2, adaptive_max_tokens)
                    print(
                        f'  [publish-api] ↻ {context} 收紧为纯 JSON 后有界重试，'
                        f'max_tokens {current_max_tokens} → {next_max_tokens}'
                    )
                    current_max_tokens = next_max_tokens
                    retry_immediately = True
                elif current_max_tokens < adaptive_max_tokens:
                    next_max_tokens = min(current_max_tokens * 2, adaptive_max_tokens)
                    print(
                        f'  [publish-api] ↗ {context} 检测到输出被截断，'
                        f'max_tokens {current_max_tokens} → {next_max_tokens}'
                    )
                    current_max_tokens = next_max_tokens
        except urllib.error.HTTPError as exc:
            detail = ''
            try:
                raw_detail = exc.read(4096).decode('utf-8', errors='replace').strip()
                if raw_detail:
                    parsed_detail = json.loads(raw_detail)
                    error_detail = parsed_detail.get('error') if isinstance(parsed_detail, dict) else None
                    if isinstance(error_detail, dict):
                        detail = str(error_detail.get('message') or error_detail.get('type') or '')
                    elif isinstance(error_detail, str):
                        detail = error_detail
                    else:
                        detail = raw_detail[:300]
            except (OSError, UnicodeError, ValueError, AttributeError):
                detail = ''
            last_error = exc
            suffix = f' | provider={detail[:300]}' if detail else ''
            print(
                f'  ⚠️  {context} 调用失败 (尝试 {attempt + 1}/{max_retries}, '
                f'{time.monotonic() - started_at:.1f}s): HTTP {exc.code}{suffix}'
            )
        except Exception as exc:
            last_error = exc
            print(
                f'  ⚠️  {context} 调用失败 (尝试 {attempt + 1}/{max_retries}, '
                f'{time.monotonic() - started_at:.1f}s): {exc}'
            )

        if attempt < max_retries - 1 and not retry_immediately:
            retry_after = None
            if isinstance(last_error, urllib.error.HTTPError):
                raw_retry_after = last_error.headers.get('Retry-After')
                try:
                    retry_after = float(raw_retry_after)
                except (TypeError, ValueError):
                    retry_after = None
            # A malformed or extremely large Retry-After must not stall the
            # whole review batch indefinitely. Formal review retries remain
            # bounded while still respecting normal provider guidance.
            base_delay = min(retry_after if retry_after is not None else 2 ** attempt, 60.0)
            time.sleep(max(0.0, base_delay) + random.uniform(0.0, 0.5))

    if required:
        raise PublishLLMUnavailable(f'{context} 连续失败: {last_error}')
    return None


def review_issue_severity(issue):
    if isinstance(issue, dict):
        return str(issue.get('severity', 'warning')).lower()
    return 'error'


def is_blocking_review_issue(issue):
    return review_issue_severity(issue) == 'error'


def count_blocking_review_issues(issues):
    return sum(1 for issue in issues if is_blocking_review_issue(issue))


def review_protocol_failure(context, message):
    """Build a blocking issue for malformed or indeterminate review output."""
    return False, [{
        'severity': 'error',
        'description': f'{context} 协议校验失败：{message}',
    }]


def validate_review_payload(review, *, required=False, context='LLM review', issue_fields=()):
    """Validate structured review output; required mode fails closed."""
    if not isinstance(review, dict):
        if required:
            return review_protocol_failure(context, '顶层必须是 JSON 对象')
        return True, []

    if 'passed' not in review or not isinstance(review.get('passed'), bool):
        if required:
            return review_protocol_failure(context, '缺少布尔字段 passed')
        passed = bool(review.get('passed', True))
    else:
        passed = review['passed']

    issues = review.get('issues')
    if not isinstance(issues, list):
        if required:
            return review_protocol_failure(context, '缺少数组字段 issues')
        issues = []

    normalized_issues = []
    allowed_severities = {'error', 'warning', 'info'}
    required_issue_fields = {'severity', 'description', *issue_fields}
    for index, issue in enumerate(issues):
        if not isinstance(issue, dict):
            if required:
                return review_protocol_failure(context, f'issues[{index}] 必须是对象')
            normalized_issues.append({
                'severity': 'error',
                'description': str(issue),
            })
            continue
        issue_required_fields = set(required_issue_fields)
        if issue.get('auto_fixable') is False:
            issue_required_fields.discard('fix_instruction')
        missing = sorted(field for field in issue_required_fields if field not in issue)
        if missing and required:
            return review_protocol_failure(
                context,
                f'issues[{index}] 缺少字段: {", ".join(missing)}',
            )
        severity = str(issue.get('severity', 'warning')).lower()
        if severity not in allowed_severities:
            if required:
                return review_protocol_failure(
                    context,
                    f'issues[{index}].severity 非法: {severity!r}',
                )
            severity = 'warning'
        description = issue.get('description')
        if required and (not isinstance(description, str) or not description.strip()):
            return review_protocol_failure(
                context,
                f'issues[{index}].description 必须是非空字符串',
            )
        if required and re.search(
            r'无法判断|不能判断|无法确认|不确定|cannot\s+determine|unable\s+to\s+determine|uncertain|indeterminate',
            description or '',
            flags=re.IGNORECASE,
        ):
            return review_protocol_failure(
                context,
                f'issues[{index}] 表示无法确定审查结论',
            )
        if required and 'type' in issue_fields and (
            not isinstance(issue.get('type'), str) or not issue.get('type', '').strip()
        ):
            return review_protocol_failure(
                context,
                f'issues[{index}].type 必须是非空字符串',
            )
        if required and 'auto_fixable' in issue_fields and not isinstance(issue.get('auto_fixable'), bool):
            return review_protocol_failure(
                context,
                f'issues[{index}].auto_fixable 必须是布尔值',
            )
        if required and 'fix_instruction' in issue_fields and (
            issue.get('auto_fixable') is not False
            and not isinstance(issue.get('fix_instruction'), str)
        ):
            return review_protocol_failure(
                context,
                f'issues[{index}].fix_instruction 必须是字符串',
            )
        normalized = dict(issue)
        normalized['severity'] = severity
        normalized['description'] = str(description or '')
        if 'fix_instruction' in issue_fields and issue.get('auto_fixable') is False:
            normalized.setdefault('fix_instruction', '')
        normalized_issues.append(normalized)

    has_error = any(issue['severity'] == 'error' for issue in normalized_issues)
    if not passed and not has_error:
        normalized_issues.append({
            'severity': 'error',
            'description': f'{context} 返回 passed=false，但没有提供 error 级原因',
        })
        has_error = True
    if passed and has_error:
        passed = False
    return passed, normalized_issues


def load_papers(data_file=None):
    """Load the standard current canonical; legacy inputs must be explicit."""
    if data_file is None:
        data_file = DEEP_ANALYSIS_RESULT_FILE
    with open(data_file, encoding='utf-8') as f:
        raw = json.load(f)
    papers = raw.get('papers') if isinstance(raw, dict) else raw
    if not isinstance(papers, list):
        raise ValueError(f'数据文件格式错误，papers 必须是数组: {data_file}')
    print(f"📚 读取 {len(papers)} 篇论文")
    return papers


def load_papers_for_publication_date(date_str, data_file=None):
    """Load a channel input with controlled historical archive fallback."""
    selected = Path(data_file) if data_file is not None else resolve_deep_analysis_result_for_date(date_str)
    if data_file is None and selected != Path(resolve_deep_analysis_result_path()):
        print(f'♻️ 当前分析文件不属于目标批次，改用受控归档: {selected}')
    return load_papers(selected)


def get_today_bj(target_date=None):
    """返回北京时间日期字符串 YYYY-MM-DD"""
    if target_date is None:
        return datetime.now(BJ_TZ).strftime('%Y-%m-%d')
    value = str(target_date)
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise PublishDataValidationError(f'无效发布日期: {target_date!r}')
    try:
        datetime.strptime(value, '%Y-%m-%d')
    except ValueError as exc:
        raise PublishDataValidationError(f'无效发布日期: {target_date!r}') from exc
    return value


def paper_batch_date(paper):
    """Use the immutable fetch batch date, with strict Beijing fetchedAt fallback."""
    explicit = paper.get('fetchBatchDate') or paper.get('batchDate')
    if explicit:
        explicit = str(explicit)
        try:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', explicit):
                raise ValueError('invalid batch date format')
            datetime.strptime(explicit, '%Y-%m-%d')
        except ValueError:
            raise PublishDataValidationError(
                f"{paper.get('arxivId') or paper.get('title') or '<unknown paper>'} 批次日期无效: {explicit!r}"
            )
        return explicit
    fetched_at = paper.get('fetchedAt')
    match = BEIJING_TIMESTAMP_RE.fullmatch(fetched_at) if isinstance(fetched_at, str) else None
    if not match:
        label = paper.get('arxivId') or paper.get('title') or '<unknown paper>'
        raise PublishDataValidationError(f'{label} fetchedAt 不是严格北京时间戳')
    return match.group(1)


def select_blog_published_snapshot(papers, date_str, manifest_path=None, receipt_path=None):
    """Bind downstream channel content to the exact remotely verified blog snapshot."""
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(date_str or '')):
        raise PublishDataValidationError(f'无效发布日期: {date_str!r}')
    try:
        datetime.strptime(date_str, '%Y-%m-%d')
    except ValueError as exc:
        raise PublishDataValidationError(f'无效发布日期: {date_str!r}') from exc
    path = Path(manifest_path) if manifest_path is not None else (
        CURRENT_DIR / f'blog-generation-manifest-{date_str}.json'
    )
    if not path.is_file():
        raise PublishDataValidationError(f'默认渠道发布缺少同日博客 generation manifest: {path}')
    try:
        manifest = read_json_strict(path)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError(f'博客生成清单无法读取: {path}') from exc
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 3:
        raise PublishDataValidationError(f'博客生成清单不是正式 schema v3: {path}')
    if manifest.get('date') != date_str:
        raise PublishDataValidationError(f'博客生成清单日期不匹配: {path}')
    if (
        not re.fullmatch(r'[0-9a-f]{64}', str(manifest.get('inputFingerprint') or ''))
        or not isinstance(manifest.get('category'), str)
        or not manifest.get('category').strip()
        or manifest.get('visualSummaryRequired') is not False
        or manifest.get('digestCoverRequired') is not False
    ):
        raise PublishDataValidationError('博客 generation manifest 缺少正式发布契约字段')

    receipt_target = Path(receipt_path) if receipt_path is not None else (
        CURRENT_DIR / f'blog-review-receipt-{date_str}.json'
    )
    try:
        receipt = read_json_strict(receipt_target)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise PublishDataValidationError(f'博客尚无可验证的发布凭证: {receipt_target}') from exc
    manifest_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    publication_commit = str(receipt.get('publicationCommit') or '').lower() if isinstance(receipt, dict) else ''
    remote_oid = str(receipt.get('remoteVerifiedOid') or '').lower() if isinstance(receipt, dict) else ''
    remote_verified_at = str(receipt.get('remoteVerifiedAt') or '') if isinstance(receipt, dict) else ''
    if (
        not isinstance(receipt, dict)
        or receipt.get('schemaVersion') != 3
        or receipt.get('date') != date_str
        or receipt.get('strictReview') is not True
        or receipt.get('hugoGate') != 'hugo'
        or not re.fullmatch(r'[0-9a-f]{64}', str(receipt.get('reviewProtocolFingerprint') or ''))
        or receipt.get('generationManifestSha256') != manifest_sha256
        or not re.fullmatch(r'[0-9a-f]{40,64}', publication_commit)
        or remote_oid != publication_commit
        or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00', remote_verified_at)
    ):
        raise PublishDataValidationError('博客发布凭证未通过远端发布绑定校验')

    published = manifest.get('publishedPapers')
    if not isinstance(published, list) or not published:
        raise PublishDataValidationError('博客生成清单缺少已发布论文权威快照')
    available = {}
    for paper in papers:
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        if paper_id in available:
            raise PublishDataValidationError(f'当前批次包含重复 arXiv ID: {paper_id}')
        available[paper_id] = paper
    selected = []
    seen = set()
    for paper in published:
        if not isinstance(paper, dict):
            raise PublishDataValidationError('博客已发布论文权威快照包含非法记录')
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        if paper_id in seen:
            raise PublishDataValidationError(f'博客已发布论文权威快照包含重复 arXiv ID: {paper_id}')
        seen.add(paper_id)
        if paper_id not in available:
            raise PublishDataValidationError(f'博客已发布论文不在受控分析数据中: {paper_id}')
        selected.append(paper)
    print(f'🧾 根据博客发布清单选择: {len(selected)}/{len(papers)} 篇论文')
    return selected


def score_emoji(score):
    """根据评分返回对应 emoji"""
    if score >= 8:
        return '🔥'
    if score >= 6:
        return '✅'
    return '📝'


def format_medal(index):
    """根据排名返回奖牌 emoji 或数字"""
    medals = ['🥇', '🥈', '🥉']
    return medals[index] if index < 3 else f'{index + 1}.'


def fix_latex_delimiters(text):
    r"""将 $...$ 转换为 \(...\)，$$...$$ 转换为 \[...\]。"""
    if not text:
        return text
    text = re.sub(r'(\^|_)\{<([a-zA-Z])\}', r'\1{\\lt \2}', text)
    text = re.sub(r'(?<!\\)\$\$(.+?)\$\$', r'\\[\1\\]', text, flags=re.DOTALL)
    text = re.sub(r'(?<!\\)\$([^\s\$][^$]*?)\$', r'\\(\1\\)', text)
    text = re.sub(r'`([^`]*?)\$([^`]*?)\$([^`]*?)`', r'`\1\\(\2\\)\3`', text)
    return text


def escape_html_like_tags(text):
    r"""转义论文中可能被 Hugo 解析为 HTML 的标记。"""
    if not text:
        return text
    # ``publish-to-blog.py`` deliberately emits these two exact, attribute-free
    # container tags for the collapsible scoring section.  Protect them before
    # the generic paper-token escaping below; otherwise the final catch-all
    # turns our own UI markup into inline code (``<details>``) and the section
    # no longer collapses.  Attribute-bearing/user-authored variants remain
    # subject to the normal sanitizer.
    safe_containers = []

    def protect_safe_container(match):
        safe_containers.append(match.group(0))
        return f'PD_SAFE_HTML_CONTAINER_{len(safe_containers) - 1}'

    text = re.sub(
        r'</?(?:details|summary)>',
        protect_safe_container,
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r'(?<![a-zA-Z])<(/?)([SEse])>(?![a-zA-Z0-9])', r'`<\1\2>`', text)
    text = re.sub(
        r'(?<![a-zA-Z0-9`])<(/?)(task|perception|comprehension|reasoning|agent|action|state|observation|reward|goal|intent|belief|plan|policy|environment|module|component|feature|input|output|label|class|category|type|mode|phase|stage|step|layer|block|unit|node|edge|graph|tree|path|loop|branch|condition|constraint|rule|fact|evidence|proof|hypothesis|assumption|premise|conclusion|result|finding|insight|implication|contribution|limitation|direction|extension|variant|version|update|fix|issue|error|warning|notice|info|trace|log|record|entry|item|element|object|subject|target|source|reference|cite|quote|note|comment|remark|annotation|caption|title|heading|paragraph|sentence|phrase|word|token|char|symbol|sign|mark|tag|badge|identifier|id|key|code|pin|secret|ticket|voucher|license|permit|certificate|credential|award|medal|prize|gift|bonus|benefit|advantage|edge|lead|margin|gap|difference|distance|range|scope|span|scale|size|length|width|height|depth|volume|area|surface|space|place|spot|location|site|position|point|dot|pixel|fragment|shard|piece|part|portion|section|segment|slice|chunk|block|lump|mass|body|entity|thing|article|product|goods|material|substance|matter|fabric|cloth|garment|clothing|wear|dress|costume|uniform|outfit|suit|wardrobe|closet|cabinet|cupboard|pantry|cellar|basement|attic|loft|tower|spire|dome|vault|arch|beam|column|pillar|post|pole|rod|bar|rail|track|path|way|road|route|course|direction|heading|bearing|azimuth|elevation|altitude|latitude|longitude|coordinate|interrupt|backchannel|response|free|BEsound)(?![a-zA-Z0-9`])>',
        r'`<\1\2>`',
        text,
        flags=re.IGNORECASE
    )
    text = re.sub(
        r'(?<![a-zA-Z0-9`])<(/?)([A-Za-z][A-Za-z0-9_†-]{0,40})(?![A-Za-z0-9_†-])>',
        r'`<\1\2>`',
        text
    )
    for index, tag in enumerate(safe_containers):
        text = text.replace(f'PD_SAFE_HTML_CONTAINER_{index}', tag)
    return text


def fix_image_markdown(text):
    r"""将 LLM 输出的非标准图片引用格式转换为标准 Markdown 图片语法。"""
    if not text:
        return text
    text = re.sub(
        r'(?:^|\n)\s*(?:-\s*)?外部\s*URL:\s*(https?://\S+?)\s*\(alt=([^)]+)\)',
        r'\n![\2](\1)',
        text,
        flags=re.MULTILINE
    )
    text = re.sub(
        r'(?:^|\n)\s*(?:-\s*)?外部\s*URL:\s*(https?://\S+?)\s+alt=(.+?)(?=\n|$)',
        r'\n![\2](\1)',
        text,
        flags=re.MULTILINE
    )
    text = re.sub(r'\(https?://[^)]+\.\.\.\)', '(image_url_truncated)', text)
    text = re.sub(r'!\[([^\]]*)\]\(data:;base64,\)', r'![\1](image_not_available)', text)
    return text


def truncate_base64_datauri(text, max_chars=50000):
    r"""截断过长的 base64 data URI，避免影响页面加载性能。"""
    if not text:
        return text

    def replacer(m):
        data = m.group(1)
        if len(data) > max_chars:
            return f'{m.group(0)[:100]}...[truncated {len(data)} chars]...'
        return m.group(0)

    return re.sub(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', replacer, text)


def fix_yaml_double_commas(text):
    r"""修复 YAML frontmatter 中的双逗号问题。"""
    if not text:
        return text
    parts = text.split('---\n', 2)
    if len(parts) >= 3:
        frontmatter = parts[1]
        frontmatter = re.sub(r',\s*,+', ',', frontmatter)
        frontmatter = re.sub(r'tags:\s*\[([^\]]*?),\s*\]', r'tags: [\1]', frontmatter)
        text = parts[0] + '---\n' + frontmatter + '---\n' + parts[2]
    return text


def strip_raw_inline_html(text):
    r"""去掉裸行内 HTML 样式标签，避免 Hugo/浏览器误渲染。"""
    if not text:
        return text
    return re.sub(
        r'<(s|e|b|i|u)(?:\s+[^>]*)?>(.*?)</\1>',
        lambda m: m.group(2),
        text,
        flags=re.IGNORECASE | re.DOTALL
    )


def fix_empty_markdown_links(text):
    r"""修复空 Markdown 链接/图片。"""
    if not text:
        return text
    text = re.sub(r'!\[([^\]]*)\]\s*\(\s*\)', r'![\1](image_not_available)', text)
    text = re.sub(r'(?<!!)\[([^\]]*)\]\s*\(\s*\)', r'\1', text)
    return text


def dedupe_image_alts(text):
    r"""补齐空图片 alt，并为重复 alt 加序号。"""
    if not text:
        return text
    seen = {}
    index = 0

    def repl(m):
        nonlocal index
        index += 1
        alt = (m.group(1) or '').strip()
        url = m.group(2)
        if not alt:
            alt = f"论文图{index}"
        count = seen.get(alt, 0) + 1
        seen[alt] = count
        if count > 1:
            alt = f"{alt} - 图{count}"
        return f"![{alt}]({url})"

    return re.sub(r'!\[([^\]]*)\]\(([^)\n]+)\)', repl, text)


def link_remote_images_to_original(text):
    """让博客中的远程论文图可点击打开原始分辨率，供手机缩放核对。"""
    if not text:
        return text
    return re.sub(
        # Alt text may contain escaped Markdown brackets (for example
        # ``\[5\]`` from a paper caption).  Treat an escaped character as one
        # alt-text atom instead of stopping at its closing bracket.
        r'(?<!\[)(!\[(?:\\.|[^\]\\\n])*\]\((https://[^)\s]+)\))',
        lambda match: f'[{match.group(1)}]({match.group(2)})',
        text,
    )


def normalize_arxiv_math_double_extraction(text):
    """折叠 arXiv HTML 将可见量与 TeX fallback 同时抽取造成的重复。"""
    if not text:
        return text
    return re.sub(
        r'(?P<value>\d+(?:\.\d+)?)∘(?P=value)\^\{\\+circ\}',
        lambda match: f'{match.group("value")}°',
        text,
    )


def fix_yaml_unbalanced_quotes(text):
    r"""修复 frontmatter 中未闭合双引号。"""
    if not text:
        return text
    parts = text.split('---\n', 2)
    if len(parts) < 3:
        return text
    fixed_lines = []
    changed = False
    for line in parts[1].split('\n'):
        if ':' in line and '"' in line and line.count('"') % 2 != 0 and '[' not in line and ']' not in line:
            key, value = line.split(':', 1)
            fixed_lines.append(f"{key}: {json.dumps(value.strip().strip(chr(34)), ensure_ascii=False)}")
            changed = True
        else:
            fixed_lines.append(line)
    if not changed:
        return text
    return parts[0] + '---\n' + '\n'.join(fixed_lines) + '---\n' + parts[2]


def strip_internal_scoring_anchors(text):
    """Strip reader-facing scoring provenance tags from a derived text view."""
    value = str(text or '')
    anchor = r'\[(?:A|SCORING_SOURCE)_[A-Z0-9_/-]+\]'
    value = re.sub(
        rf'(?P<prefix>与|和)[ \t]*{anchor}[ \t]*(?=(?:承认|报告|披露|给出|指出))',
        lambda match: f'{match.group("prefix")}论文',
        value,
    )
    value = re.sub(
        rf'(?P<prefix>但|不过|然而)[ \t]*{anchor}[ \t]*(?=(?:限于|仅|缺少|未))',
        lambda match: f'{match.group("prefix")}该结论',
        value,
    )
    value = re.sub(rf'{anchor}[ \t]*', '', value)
    return re.sub(r'(?<=[㐀-鿿])[ \t]+(?=[㐀-鿿])', '', value)


def sanitize_markdown_for_publish(text):
    """发布前通用 Markdown 清洗。"""
    # LLM 输出偶尔会携带 UTF-8 替换字符；先清理后再进入 staging，
    # 避免最终 Markdown 门禁才发现不可逆的乱码字节。
    text = text.replace('\ufffd\ufffd\ufffd', '。')
    text = text.replace('\ufffd\ufffd', '。')
    text = text.replace('\ufffd', '')
    text = normalize_arxiv_math_double_extraction(text)
    text = fix_latex_delimiters(text)
    text = escape_html_like_tags(text)
    text = strip_raw_inline_html(text)
    text = fix_image_markdown(text)
    text = fix_empty_markdown_links(text)
    text = dedupe_image_alts(text)
    text = link_remote_images_to_original(text)
    text = truncate_base64_datauri(text)
    text = fix_yaml_double_commas(text)
    text = fix_yaml_unbalanced_quotes(text)
    # 评分审计和 manual evidence ledger 需要这些锚点来约束上游事实，
    # 但它们是内部 provenance，不应泄漏到面向读者的博客正文。这里只
    # 清理派生的发布视图，不修改 analysis / parsed canonical 数据。
    text = strip_internal_scoring_anchors(text)
    return text


def score_and_sort(papers):
    """
    解析每篇论文的分析结果，按评分降序排列。
    返回 [(score, paper, parsed), ...]，未评分的排在最后。
    发布排序前强制校验 analysis、parsed、八维评分和版本一致性。
    """
    scored = []
    unscored = []
    for p in papers:
        pa = resolve_publish_parsed(p)
        normalized_paper = dict(p)
        normalized_paper['parsed'] = pa
        if pa and pa.get('score'):
            try:
                scored.append((float(pa['score']), normalized_paper, pa))
            except (ValueError, TypeError):
                unscored.append(normalized_paper)
        else:
            unscored.append(normalized_paper)
    scored.sort(key=lambda x: (
        -x[0],
        normalize_publish_arxiv_id(x[1].get('arxivId') or x[1].get('paper_id')),
    ))
    return scored, unscored


def extract_top_tags(papers, limit=8):
    """
    从论文列表中提取主任务标签并统计频次。
    返回 [(tag, count), ...]，按数量降序。
    优先使用已解析好的 parsed 数据。
    """
    tag_count = {}
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not pa:
            continue
        hot_tag = pa.get('primaryTaskTag') or (pa['tags'][0] if pa.get('tags') else '')
        if hot_tag:
            tag_count[hot_tag] = tag_count.get(hot_tag, 0) + 1
    return sorted(tag_count.items(), key=lambda x: (-x[1], x[0]))[:limit]


def extract_all_tags(papers, limit=10):
    """
    提取所有标签（去重），用于博客标签云。
    返回标签字符串列表（不带 #）。
    优先使用已解析好的 parsed 数据。
    """
    tag_set = set()
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not pa:
            continue
        if pa.get('primaryTaskTag'):
            tag_set.add(pa['primaryTaskTag'].replace('#', '').strip())
        for t in pa.get('tags', []):
            clean = t.replace('#', '').strip()
            if clean:
                tag_set.add(clean)
    return sorted(tag_set)[:limit]


def extract_one_liner(pa):
    """从分析结果中提取一句话亮点，优先用创新点或核心贡献，而非截断摘要"""
    text = ''

    # 1. 优先尝试 innovation 第一条
    innovation = pa.get('innovation', '')
    if innovation:
        first = innovation.split('\n')[0].strip()
        first = re.sub(r'^\d+\.\s*', '', first)
        if len(first) > 15:
            text = first

    # 2. 尝试从 summary 中提取核心贡献句（找"提出了"/"解决了"/"旨在"等）
    if not text:
        summary = pa.get('summary', '')
        if summary:
            sentences = re.split(r'[。\n]', summary)
            for s in sentences:
                s = s.strip()
                if not s or len(s) < 15:
                    continue
                # 优先找包含核心动作词的句子
                if re.search(r'提出了|解决了|旨在|针对|引入|设计|构建|发现|证明', s):
                    text = s
                    break
            if not text and sentences:
                text = sentences[0].strip()

    # 3. 回退到 roast
    if not text:
        roast = pa.get('roast', '')
        if roast:
            text = roast.split('。')[0].strip()

    # 清理 Markdown 和废话前缀
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'`(.+?)`', r'\1', text)
    text = re.sub(r'^这篇论文旨在\s*', '', text)
    text = re.sub(r'^这篇技术报告全面介绍了\s*', '', text)
    text = re.sub(r'^本文针对\s*', '', text)
    text = re.sub(r'^本文提出了\s*', '', text)
    text = re.sub(r'^解决\s*', '', text)
    text = re.sub(r'^核心贡献：\s*', '', text)
    text = re.sub(r'^本文\s*', '', text)
    text = re.sub(r'^该工作\s*', '', text)
    text = re.sub(r'^本文中\s*', '', text)
    text = text.strip()

    if len(text) > 10:
        return text[:110] + ('...' if len(text) > 110 else '')
    return ''


def build_paper_meta(pa, aurl=''):
    """拼接评分、分档、主任务/主方法等关键信息（Markdown 格式）"""
    if not pa:
        return ''

    bits = []
    score = pa.get('score', '')
    if score:
        try:
            score_val = float(score)
            bits.append(f'{score_emoji(score_val)} **{score}/10**')
        except (ValueError, TypeError):
            pass

    if pa.get('rankBucket'):
        bits.append(pa['rankBucket'])
    if pa.get('documentType'):
        bits.append(f'文档类型：{pa["documentType"]}')
    if pa.get('confidence'):
        bits.append(f'评分置信度：{pa["confidence"]}')
    primary_tags = []
    for key in ('primaryTaskTag', 'primaryMethodTag'):
        tag = pa.get(key)
        if tag and tag not in primary_tags:
            primary_tags.append(tag)
            bits.append(tag)

    raw_tags = pa.get('tags', [])
    raw_tags = [raw_tags] if isinstance(raw_tags, str) else list(raw_tags or [])
    flattened_tags = []
    for raw_tag in raw_tags:
        text = str(raw_tag or '').strip()
        hashtags = re.findall(r'#[^\s#|]+', text)
        flattened_tags.extend(hashtags or ([text] if text else []))
    extra_tags = [
        tag for tag in dict.fromkeys(flattened_tags)
        if tag not in set(primary_tags)
    ]
    bits.extend(extra_tags[:2])
    if aurl:
        bits.append(f'[arxiv]({aurl})')

    return ' | '.join(bits)


def parse_cli_args(argv, defaults=None):
    """
    通用命令行参数解析。
    返回 dict，包含 data_file、target_date 及自定义参数。
    """
    defaults = defaults or {}
    args = {
        'data_file': None,
        'target_date': None,
    }
    args.update(defaults)

    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == '--date' and i + 1 < len(argv):
            args['target_date'] = argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            args['data_file'] = arg
        i += 1
    return args

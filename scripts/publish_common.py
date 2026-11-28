#!/usr/bin/env python3
"""
Audio Research Workbench 发布公共模块 (Python)
统一封装：数据加载、评分排序、标签提取、格式化工具
三流程共用的发布请求、来源核验与审查工具
"""

from tag_catalog import tag_catalog_identity, catalog_header, is_catalog_upgrade, is_catalog_identity_upgrade
from protocol_codec import (is_contract as is_protocol_contract, record_header as protocol_record_header,
                            contract as protocol_contract, historical_contract as protocol_historical_contract,
                            has_valid_header as protocol_has_valid_header, schema_fingerprint as protocol_schema_fingerprint)
from tag_catalog import is_current_tag_prompt_text_contract, is_supported_tag_selection_contract
import concurrent.futures
import contextvars
import threading
import json
from protocol_codec import historical_contract as historical_manual_contract
import hashlib
import http.client
import math
import os
import random
import re
import socket
import subprocess
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import weakref
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path

_SHARED_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)
from path_config import (
    CURRENT_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    LLM_ACCOUNT_POOL_STATE_FILE,
    PROJECT_ROOT,
    read_json_strict,
    resolve_deep_analysis_result_for_date,
    resolve_deep_analysis_result_path,
)
import analysis_quality_format as quality_formats
from daily_source_format import is_fresh_source_provenance
from blog_record_format import source_bound_generation, strict_receipt, matches_snapshot_receipt
from manual_agent_policy import (CURRENT_MODEL_POLICY, LEGACY_MODEL_POLICY,
    bound_analysis_model_policy, analysis_identity_error)
from project_env import build_child_process_env, get_required_fetch_proxy
from public_network_policy import (
    is_valid_http_connect_proxy_url,
    resolve_http_connect_proxy_url,
)
from llm_account_pool import (
    LlmAccountPoolExhaustedError,
    LlmAccountAuthError,
    LlmAccountPoolConfigError,
    LlmAccountPoolStateError,
    classify_opencode_go_quota_response,
    get_account_id,
    is_opencode_go_endpoint,
    mark_quota_exhausted,
    normalize_opencode_go_service,
    record_account_usage,
    resolve_api_key_pool,
    resolve_live_sync_timeout_ms,
    resolve_primary_api_key_pool,
    select_api_key,
    sync_opencode_go_pool_usage,
)
from utils import parse_analysis, read_tag_validation
from tag_stage_record import TAG_STAGE_RECORD_CONTRACT, is_tag_stage_record_declaration, read_tag_stage_record
from analysis_sections import (
    EVALUATION_TITLE, LEGACY_EVALUATION_TITLE, normalize_analysis_section_title,
    evaluation_heading_issue, extract_evaluation_section,
)
from tag_catalog import (
    TAG_PROMPT_TEXT_CONTRACT,
    LEGACY_TAG_PROMPT_TEXT_CONTRACT,
    TAG_SELECTION_CONTRACT,
    LEGACY_TAG_SELECTION_CONTRACT,
    load_tag_catalog,
    load_archived_tag_catalog,
    resolve_compatible_proof_catalog,
    tag_prompt_text_sha256,
)
from llm_usage import record_llm_usage, with_llm_usage_context, begin_pending_llm_request, LlmUsagePersistenceError

BJ_TZ = timezone(timedelta(hours=8))
BEIJING_TIMESTAMP_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$'
)
# 发布视图统一剔除的零宽字符集合（零宽空格/非连接符/连接符、词连接符、BOM）。
# publish-to-blog 的来源单元格比较必须复用同一集合，否则封存 DOM 里夹带的
# 200C/200D/2060/FEFF 会让同一单元格在两侧被判定为不同。
PUBLISH_ZERO_WIDTH_CHARACTERS = '\u200b\u200c\u200d\u2060\ufeff'


class PublishLLMUnavailable(RuntimeError):
    """发布时必需的一次 LLM 审查无法执行时抛出。"""


class PublishDataValidationError(ValueError):
    """分析数据不适合或不一致、不能发布时抛出。"""


def run_bounded_llm_tasks(items, worker, max_workers, on_result=None):
    """逐个补派模型任务；运行级故障后，等待已开始的任务结束及结果处理，不再启动新任务。"""
    if not isinstance(max_workers, int) or max_workers < 1:
        raise ValueError('模型任务并发数必须是正整数')
    items = list(items)
    if not items:
        return []
    stopped = threading.Event()
    failure_lock = threading.Lock()
    run_errors = []
    skipped = object()
    results = [None] * len(items)

    def invoke(item):
        if stopped.is_set():
            return skipped
        try:
            return worker(item)
        except BaseException as exc:
            if getattr(exc, 'scope', None) == 'run':
                with failure_lock:
                    if not run_errors:
                        run_errors.append(exc)
                    stopped.set()
            raise

    cursor = 0
    fatal_errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        pending = {}

        def submit_next():
            nonlocal cursor
            if stopped.is_set() or cursor >= len(items):
                return
            index = cursor
            cursor += 1
            context = contextvars.copy_context()
            pending[executor.submit(context.run, invoke, items[index])] = index

        for _ in range(min(max_workers, len(items))):
            submit_next()
        while pending:
            done, _ = concurrent.futures.wait(pending,
                return_when=concurrent.futures.FIRST_COMPLETED)
            # 已完成的异常和保存回调先处理完，再补任务，避免错误与补派竞争。
            for future in sorted(done, key=pending.get):
                index = pending.pop(future)
                if future.exception() is None and future.result() is skipped:
                    continue
                try:
                    if on_result is None:
                        results[index] = future.result()
                    else:
                        on_result(items[index], future)
                except BaseException as exc:
                    stopped.set()
                    fatal_errors.append(exc)
            for _ in done:
                submit_next()
    if run_errors:
        other_errors = [error for error in fatal_errors if error is not run_errors[0]]
        if other_errors:
            cause = other_errors[0] if len(other_errors) == 1 else BaseExceptionGroup(
                '停止运行时还有结果处理或保存失败', other_errors)
            raise run_errors[0] from cause
        raise run_errors[0]
    if fatal_errors:
        raise fatal_errors[0]
    return results


import scoring_rubric as _scoring
SCORING_RUBRIC_VERSION = _scoring.LEGACY_SCORING_RUBRIC
CURRENT_SCORING_RUBRIC_VERSION = _scoring.CURRENT_SCORING_RUBRIC
SUPPORTED_SCORING_RUBRIC_VERSIONS = _scoring.SUPPORTED_SCORING_RUBRIC_VERSIONS
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
EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION = quality_formats.original('experiment-tables', 'size-limits-only')
EXPERIMENT_TABLE_CONTRACT_VERSION = quality_formats.original('experiment-tables', 'evidence-rich')
EXPERIMENT_TABLE_CONTRACT_VERSIONS = frozenset({
    EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
})
METHOD_DETAIL_CONTRACT_VERSION = quality_formats.original('method-detail', 'detailed-method')
IMAGE_NARRATIVE_CONTRACT_VERSION = quality_formats.original('image-narrative', 'context-bound-figures')
EDITORIAL_QUALITY_CONTRACT_VERSION = quality_formats.original('manual-editorial-quality', 'original-reader-facing')
DIGEST_INDEX_READER_QUALITY_CONTRACT = protocol_contract('reader-facing-page')
DIGEST_INDEX_READER_QUALITY_FINGERPRINT = protocol_schema_fingerprint('reader-facing-page')
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
    r'(?:^editing(?: operation)?$|(?:^|\b)(?:method|algorithm|approach|strategy|mechanism|aggregation|model|system|backbone|front[ -]?end|pipeline|'
    r'variant|ablation|representation|embedding|feature|encoder|baseline|'
    r'config(?:uration)?|dataset|corpus|benchmark|task|experiment|evaluation|test|'
    r'comparison|control|boundary|slice|subset|input|query|language|scenario|condition|setting|split|category|'
    r'type|modality|version|stage|phase|step|round|epoch|decoder|decode|context|metric|'
    r'measure|family|language family)(?:\b|$)|^(?:评价|问卷)项目(?:[，,]\s*N\s*=\s*\d+)?$|^编辑操作$|方法|算法|方案|策略|方式|机制|聚合|模型|系统|骨干|前端|流程|变体|消融(?:项|设置|变体)?|表征|嵌入|特征|编码器|基线|'
    r'配置|数据集|语料|基准|任务|实验|检验|评估|测试|比较|对照|边界|切片|子集|输入|查询|题数|语言|语系|语族|场景|条件|设置|划分|类别|'
    r'类型|模态|版本|阶段|阶数|步骤|轮次|训练轮|解码|上下文|指标|度量|拓扑)',
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
    r'(?:accuracy|precision|recall|f[- ]?score|\bf1\b|\bwer\b|\bcer\b|\bder\b|\bauc\b|\bmap\b|\bmiou\b|\biou\b|\bpesq\b|\bstoi\b|\bsdr\b|\bsisdr\b|\bsnr\b|\bbleu\b|\brouge\b|\bmeteor\b|\bclap\b|\bfad\b|\brmse\b|\bmae\b|\bmse\b|\bnmse\b|\bmste\b|\bmr[- ]?stft\b|\berle\b|\bmos\b|\bl[12]\b|准确率|精确率|召回率|错误率|误差|损失|延迟|耗时|速度|吞吐|内存|显存|功耗|能耗|复杂度|参数量|相关系数|相似度|评分|分数|裁判分)',
    flags=re.IGNORECASE,
)
# “无条件 AVG ↑”这类汇总列是可测量的指标，但与 WER、准确率不同，它本身
# 不需要 ↑/↓（例如“Avg Total (s)”）。只在出现方向标记时供识别符分类器使用。
TABLE_GENERIC_METRIC_HEADER_RE = re.compile(
    r'(?:\bavg\b|\bmean\b|\baverage\b|均值|平均)',
    flags=re.IGNORECASE,
)
# 强识别词即使出现在汇总表头里也保持识别符含义：“6 基准平均 ↑”依旧以
# 基准/数据集限定词确定行身份，而“无条件”这类弱条件词则让位于
# “无条件 AVG ↑”的指标读法。
TABLE_STRONG_IDENTITY_HEADER_RE = re.compile(
    r'基准|数据集|语料|任务|语言|语系|语族|类别|类型|模态|版本|阶段|阶数|步骤|轮次|训练轮|划分|切片|子集|场景|配置|拓扑'
)
TABLE_NON_DIRECTIONAL_MEASURE_RE = re.compile(
    r'(?:置信区间|confidence interval|\bci\b|p[- ]?value|p值|显著性|样本数|数量|规模|时长|采样率|方差|标准差|系数|\bbeta\b|\bΔ?AIC\b|复杂度|参数|容量|内存|显存|耗时|延迟|速度|吞吐|功耗|能耗|bytes?|hours?|seconds?|milliseconds?)',
    flags=re.IGNORECASE,
)
TABLE_NUMERIC_CELL_RE = re.compile(
    r'(?:^|[^A-Za-z])[-+]?\d(?:[\d,]*)(?:\.\d+)?(?:\s*(?:%|pp|×|x|ms|s|h|Hz|kHz|MHz|GB|MB|KB|dB|mJ|W))?',
    flags=re.IGNORECASE,
)


def _is_table_identifier_header(value):
    """与 Node 对带方向指标表头的处理保持一致。"""
    raw_header = str(value or '')
    if raw_header.strip(_JS_WHITESPACE) == '对比':
        return True
    if raw_header.strip() == '对比':
        return False
    normalized = raw_header.strip()
    if re.fullmatch(r'推理窗长', normalized):
        return True
    if re.fullmatch(r'(?:(?:检验|统计检验)?统计量|统计检验结果|(?:F|t|z|χ²)\s*统计量|(?:test\s+)?statistics?|[Ftzp][ -]?(?:values?|statistics?))', normalized, flags=re.IGNORECASE):
        return False
    # 与 Node 显式列出的训练条件识别符保持一致。
    if re.fullmatch(r'(?:(?:评价|问卷)项目(?:[，,]\s*N\s*=\s*\d+)?|目标|蒸馏目标|环节|(?:distillation )?objective|训练损失|损失函数|监督目标|训练目标|评估设置|实验设置|提取来源|任务向量来源|表示|检测器|生成器|选择器|selector|组合|声源|音源|乐器|sound sources?|audio sources?|instruments?|分割规则|领域|合并点|合并位置|提示词|对比|对比对象|评测对象|量化水平|操作|被试\s*ID|预训练目标|训练数据|分词器|家族|NFE|number of function evaluations|函数求值次数|词表大小(?:\s*\$\\\|V\\\|\$)?|(?:潜|隐|表征|嵌入|特征|语义)空间|segmentation rule|domain|merge point|prompt|comparison object|participant\s+ID|pretraining objective|training data|tokenizer|vocabulary size)', normalized, flags=re.IGNORECASE):
        return True
    if not normalized:
        return True
    without_direction = TABLE_DIRECTION_MARK_RE.sub(' ', normalized)
    without_direction = re.sub(r'\s+', ' ', without_direction).strip()
    identifier = bool(TABLE_IDENTIFIER_HEADER_RE.search(without_direction))
    if not TABLE_DIRECTION_MARK_RE.search(normalized):
        return identifier
    # “OGI 测试 WER ↓ (%)”同时含设置限定词和指标，方向标记说明它是可测量列，
    # 而不是识别符。这个分支只在有方向标记时执行，所以把“无条件 AVG ↑”
    # 当作指标，不会反过来给“Avg Total (s)”强行加箭头。
    if TABLE_DIRECTIONAL_METRIC_RE.search(without_direction):
        return False
    if (TABLE_GENERIC_METRIC_HEADER_RE.search(without_direction)
            and not TABLE_STRONG_IDENTITY_HEADER_RE.search(without_direction)):
        return False
    return identifier


def _extract_analysis_section(text, title):
    if title in {EVALUATION_TITLE, LEGACY_EVALUATION_TITLE}:
        return extract_evaluation_section(text)
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
    """校验绑定上下文的图片正文是否与插图计划严格相邻。"""
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
        # Manual v2 清单把最终选中的 URL 和它的规范图片序号一起保存。API 清单
        # 历史上把 selected 存成字符串，而 imageNumber 指向的是已下载候选数组
        # 的下标。
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
            # 兼容旧的无版本号 API 清单：它们没有保存重建 URL -> imageNumber
            # 映射所需的下载候选下标。只有这些旧清单按相邻正文匹配图片计划，
            # 带版本号的新清单不能采用此兼容处理。
            matched_index = next((position for position, candidate in enumerate(unresolved_plans)
                                  if _normalize_image_narrative_text(candidate.get('lead')) == lead
                                  and _normalize_image_narrative_text(candidate.get('explanation')) == explanation), None)
            plan = unresolved_plans.pop(matched_index) if matched_index is not None else None
        if plan is None:
            return (
                f'{url} 未找到对应的已审查插图计划；'
                '图片 URL、索引或相邻正文无法与计划对应。'
            )
        if (_normalize_image_narrative_text(plan.get('lead')) != lead
                or _normalize_image_narrative_text(plan.get('explanation')) != explanation):
            return f'{url} 的图前导读或图后解释与已审查插图计划不一致。'
        plans_by_url.pop(url, None)
    if plans_by_url or unresolved_plans:
        return '存在没有落入最终正文的已审计插图计划'
    return None


def _validate_publish_image_exclusion_view(paper, paper_label):
    """校验由图片排除项得出的、给读者看的显式视图。"""
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
                f'{paper_label} 排除发布图片后，读者文章阶段记录的正文 SHA、图片数量或图片记录 SHA 与当前内容不一致。'
            )
    manifest = paper.get('analysisManifest')
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    if isinstance(takeover, dict) and takeover.get('analysisSha256') != source_sha:
        raise PublishDataValidationError(
            f'{paper_label} 发布图片排除前正文 SHA 与 Manual canonical 不一致'
        )


_PUBLISH_TAG_CATALOG = load_tag_catalog()
_PUBLISH_TAG_PROMPT_TEXT_SHA256 = tag_prompt_text_sha256(_PUBLISH_TAG_CATALOG)


def _find_analysis_section_bounds(analysis, title):
    heading = re.compile(
        rf'(^|\n)((#{{2,3}})\s*(?:\d+[.\s]+)?{re.escape(title)}[：:\s]*\n)',
        re.M,
    )
    match = heading.search(analysis)
    if match is None:
        raise PublishDataValidationError(f'标签检查所需的章节缺失：## {title}')
    start = match.start() + len(match.group(1))
    content_start = start + len(match.group(2))
    remainder = analysis[content_start:]
    level = len(match.group(3))
    following = re.search(rf'\n#{{2,{level}}}\s', remainder)
    end = content_start + following.start() if following else len(analysis)
    return content_start, end


def _replace_analysis_section_body(analysis, title, content):
    content_start, end = _find_analysis_section_bounds(analysis, title)
    return f'{analysis[:content_start]}{str(content).strip()}{analysis[end:]}'


def _replace_primary_tag_fields(analysis, task_tag, method_tag):
    content_start, end = _find_analysis_section_bounds(analysis, '机器摘要')
    body = analysis[content_start:end]
    for key, value in (
            ('primary_task_tag', task_tag),
            ('primary_method_tag', method_tag)):
        pattern = re.compile(rf'^{key}\s*[:：]\s*.*$', re.M)
        if len(pattern.findall(body)) != 1:
            raise PublishDataValidationError(
                f'标签检查要求机器摘要中的 {key} 恰好出现一次。')
        body = pattern.sub(f'{key}: {value}', body)
    return f'{analysis[:content_start]}{body}{analysis[end:]}'


def _mask_classification_fields(analysis):
    masked = _replace_primary_tag_fields(
        str(analysis or ''), '__PRIMARY_TASK__', '__PRIMARY_METHOD__')
    return _replace_analysis_section_body(masked, '标签', '__TAXONOMY_SECTION__')


def _hash_tag_section_and_primary_tags(analysis):
    source = str(analysis or '')
    tag_match = re.search(
        r'(^|\n)##(?!#)\s*标签[：:\s]*\n([\s\S]*?)(?=\n##(?!#)\s|$)',
        source,
    )
    machine_match = re.search(
        r'(^|\n)##(?!#)\s*机器摘要[：:\s]*\n([\s\S]*?)(?=\n##(?!#)\s|$)',
        source,
    )
    tag_block = tag_match.group(2).strip() if tag_match else ''
    machine_summary_text = machine_match.group(2).strip() if machine_match else ''
    task_match = re.search(r'^primary_task_tag\s*[:：]\s*(\S+)\s*$', machine_summary_text, re.M)
    method_match = re.search(r'^primary_method_tag\s*[:：]\s*(\S+)\s*$', machine_summary_text, re.M)
    if not tag_block or task_match is None or method_match is None:
        return ''
    tag_hash_input = (
        f'primary_task_tag={task_match.group(1)}\n'
        f'primary_method_tag={method_match.group(1)}\n{tag_block}'
    )
    return hashlib.sha256(tag_hash_input.encode('utf-8')).hexdigest()


# 词表更新后，发布端重新比较新旧词表，并核对升级说明及所选概念是否仍有效。
# 共享变更规则对应 scripts/lib/tag-catalog-change.js；提示文本的版本和 SHA
# 另按本发布检查的兼容规则核验。这里只检查能否沿用标签阶段记录，不重新生成记录。
from tag_catalog import (  # noqa: E402
    _JS_WHITESPACE, normalize_label, validate_tag_catalog,
    TAG_CATALOG_VERSION, LEGACY_TAG_CATALOG_VERSION,
)

_REGISTRY_CHANGE_LEVELS = ('none', 'additive', 'destructive')
_REGISTRY_UPGRADE_CONTRACT = protocol_contract('paper-tag-catalog-upgrade')
_LEGACY_REGISTRY_UPGRADE_CONTRACT = protocol_historical_contract('paper-tag-catalog-upgrade','legacy-concept-change-review')
_REGISTRY_UPGRADE_NOTE_MAX_CHARS = 500
_SHA256_RE = re.compile(r'^[a-f0-9]{64}$')


def _tag_catalog_history_dir():
    """返回标签词表历史目录；它与 Node 配置的 FILES.tagCatalogHistoryDir 指向相同位置。"""
    import tag_paths
    return Path(tag_paths.TAG_CATALOG_FILE).parent / 'tag-catalog-history'


def _normalize_registry(value, label='词表'):
    if isinstance(value, str):
        loaded = load_tag_catalog(value)
        return {**catalog_header(loaded), 'facets': loaded['facets'],
                'concepts': loaded['concepts'], 'registrySha256': loaded['registrySha256']}
    if type(value) is not dict:
        raise ValueError(f'{label} 必须是词表对象或词表文件路径。')
    registry = {**catalog_header(value), 'facets': value.get('facets'),
            'concepts': value.get('concepts')}
    validate_tag_catalog(registry)
    registry_sha = value.get('registrySha256')
    if registry_sha is not None and (
            not isinstance(registry_sha, str) or not _SHA256_RE.fullmatch(registry_sha)):
        raise ValueError(f'{label} 中的 registrySha256 格式无效。')
    return {**registry, 'registrySha256': registry_sha}


def _resolve_registry_snapshot(registry_sha256):
    """按内容字节 SHA 找回升级前快照：文件名必须等于其内容字节 SHA。"""
    sha = str(registry_sha256 or '')
    if not _SHA256_RE.fullmatch(sha):
        return None
    try:
        loaded = load_tag_catalog(_tag_catalog_history_dir() / f'{sha}.json')
    except Exception:  # noqa: BLE001 - 读取或校验失败时返回 None，调用方不能据此沿用旧记录。
        return None
    if loaded.get('registrySha256') != sha:
        return None
    return {**catalog_header(loaded), 'facets': loaded['facets'],
            'concepts': loaded['concepts'], 'registrySha256': loaded['registrySha256']}


def _active_global_tag(registry):
    """检查已启用概念的中文首选名称在整个词表中是否重复。"""
    seen = {}
    for concept in registry['concepts']:
        if concept['status'] != 'active':
            continue
        tag = f"#{concept['preferredLabel']['zh']}"
        if tag in seen:
            return {'tag': tag, 'ids': [seen[tag], concept['id']]}
        seen[tag] = concept['id']
    return None


def _cross_facet_label_collisions(registry):
    """检查整个词表中跨分类维度的名称重复。

    包括已启用及已停用概念的中英文首选名称和别名。名称按同一规则处理后，
    若对应多个维度，查找结果可能产生歧义；变更分类器会将这类情况列为破坏性变更。
    词表自身的名称唯一性只在各维度内检查。
    """
    by_label = {}
    for concept in registry['concepts']:
        labels = (concept['preferredLabel']['zh'], concept['preferredLabel']['en'],
                  *concept['aliases'])
        for raw in labels:
            label = normalize_label(raw)
            if not label:
                continue
            entry = by_label.setdefault(label, {'facets': [], 'conceptIds': []})
            if concept['facet'] not in entry['facets']:
                entry['facets'].append(concept['facet'])
            if concept['id'] not in entry['conceptIds']:
                entry['conceptIds'].append(concept['id'])
    return [{'label': label, **entry} for label, entry in by_label.items()
            if len(entry['facets']) > 1]


def _classify_registry_change(old_registry, new_registry):
    """按与 Node 相同的规则逐项比较词表，返回变更等级和详细结果。"""
    frm = _normalize_registry(old_registry, '旧词表')
    to = _normalize_registry(new_registry, '新词表')
    reasons = []

    def note(level, code, message, **extra):
        reasons.append({'level': level, 'code': code, 'message': message, **extra})

    counts = {
        'oldConcepts': len(frm['concepts']),
        'newConcepts': len(to['concepts']),
        'conceptsAdded': 0,
        'conceptsRemoved': 0,
        'conceptsChanged': 0,
        'aliasesAdded': 0,
        'aliasesRemoved': 0,
        'facetsAdded': 0,
        'facetsRemoved': 0,
    }

    if not is_catalog_upgrade(frm,to):
        note('destructive', 'version-changed',
             f"词表版本从 {tag_catalog_identity(frm)} 改为 {tag_catalog_identity(to)}，必须重新分析整篇论文")

    old_facets = {facet['id']: facet for facet in frm['facets']}
    new_facets = {facet['id']: facet for facet in to['facets']}
    for facet_id in sorted(old_facets):
        if facet_id not in new_facets:
            counts['facetsRemoved'] += 1
            note('destructive', 'facet-removed',
                 f'删除了分面 {facet_id}，旧记录中的这一分类维度在新词表中已没有定义', facet=facet_id)
    for facet_id in sorted(new_facets):
        if facet_id not in old_facets:
            counts['facetsAdded'] += 1
            note('additive', 'facet-added', f'新增了分面 {facet_id}', facet=facet_id)
        elif old_facets[facet_id]['label'] != new_facets[facet_id]['label']:
            note('additive', 'facet-label-updated',
                 f"分面 {facet_id} 的显示名称由“{old_facets[facet_id]['label']}”"
                 f"改为“{new_facets[facet_id]['label']}”，标签解析方式不变",
                 facet=facet_id)

    old_concepts = {concept['id']: concept for concept in frm['concepts']}
    new_concepts = {concept['id']: concept for concept in to['concepts']}

    for concept_id in sorted(old_concepts):
        if concept_id in new_concepts:
            continue
        counts['conceptsRemoved'] += 1
        note('destructive', 'concept-removed',
             f'删除了概念 {concept_id}，引用它的旧分类绑定无法通过当前词表校验', conceptId=concept_id)

    for concept in to['concepts']:
        if concept['id'] in old_concepts:
            continue
        counts['conceptsAdded'] += 1
        if concept['status'] == 'active':
            note('additive', 'concept-added',
                 f"新增了可选择的概念 {concept['id']}", conceptId=concept['id'])
        else:
            note('additive', 'deprecated-concept-added',
                 f"新增了已停用的概念 {concept['id']}，不能用于新的分类选择",
                 conceptId=concept['id'])

    for concept in to['concepts']:
        previous = old_concepts.get(concept['id'])
        if previous is None:
            continue
        changes = []
        if previous['facet'] != concept['facet']:
            changes.append(('destructive', 'concept-facet-changed',
                            f"概念 {concept['id']} 所属分面由 {previous['facet']} 改为 {concept['facet']}"))
        for language in ('zh', 'en'):
            if previous['preferredLabel'][language] != concept['preferredLabel'][language]:
                changes.append(('destructive', 'preferred-label-changed',
                                f"概念 {concept['id']} 的首选标签（preferredLabel.{language}）由"
                                f"“{previous['preferredLabel'][language]}”改为"
                                f"“{concept['preferredLabel'][language]}”"))
        if previous['broaderId'] != concept['broaderId']:
            changes.append(('destructive', 'broader-id-changed',
                            f"概念 {concept['id']} 的上级概念（broaderId）由 "
                            f"{previous['broaderId'] if previous['broaderId'] is not None else 'null'}"
                            f" 改为 "
                            f"{concept['broaderId'] if concept['broaderId'] is not None else 'null'}，"
                            '祖先关系随之改变，也可能影响主任务是否符合最具体概念的要求'))
        if previous['status'] != concept['status']:
            if concept['status'] != 'active':
                changes.append(('destructive', 'status-deactivated',
                                f"概念 {concept['id']} 的状态由可选择改为停用（{concept['status']}），"
                                '引用它的旧分类绑定不能继续沿用'))
            else:
                changes.append(('additive', 'status-reactivated',
                                f"概念 {concept['id']} 已恢复为可选择状态"
                                '，可用于新的分类'))
        old_aliases = {normalize_label(value) for value in previous['aliases']} - {''}
        new_aliases = {normalize_label(value) for value in concept['aliases']} - {''}
        for alias in sorted(old_aliases):
            if alias in new_aliases:
                continue
            counts['aliasesRemoved'] += 1
            changes.append(('destructive', 'alias-removed',
                            f'概念 {concept["id"]} 删除了别名“{alias}”，使用该别名的旧标签需要重新核对'))
        for alias in sorted(new_aliases):
            if alias in old_aliases:
                continue
            counts['aliasesAdded'] += 1
            changes.append(('additive', 'alias-added',
                            f'概念 {concept["id"]} 新增了别名“{alias}”'))
        if previous['definition'] != concept['definition']:
            changes.append(('additive', 'definition-updated',
                            f'概念 {concept["id"]} 的定义（definition）已更新，标签解析规则不变'))
        if previous['scopeNote'] != concept['scopeNote']:
            changes.append(('additive', 'scope-note-updated',
                            f'概念 {concept["id"]} 的适用范围说明（scopeNote）已更新，标签解析规则不变'))
        if previous['replacedBy'] != concept['replacedBy']:
            changes.append(('additive', 'replacement-updated',
                            f"概念 {concept['id']} 的替代概念（replacedBy）由 "
                            f"{previous['replacedBy'] if previous['replacedBy'] is not None else 'null'}"
                            f" 改为 "
                            f"{concept['replacedBy'] if concept['replacedBy'] is not None else 'null'}"
                            '，标签解析规则不变'))
        if changes:
            counts['conceptsChanged'] += 1
        for level, code, message in changes:
            note(level, code, message, conceptId=concept['id'])

    global_tag = _active_global_tag(to)
    if global_tag is not None:
        note('destructive', 'active-label-not-globally-unique',
             f"可选择概念的中文首选标签 {global_tag['tag']} 在概念 {' / '.join(global_tag['ids'])}"
             ' 中重复，分类程序会拒绝这份词表',
             tag=global_tag['tag'], conceptIds=global_tag['ids'])

    for collision in _cross_facet_label_collisions(to):
        note('destructive', 'label-collision',
             f"标签“#{collision['label']}”同时对应分面 {' / '.join(collision['facets'])}"
             f" 中的概念 {' / '.join(collision['conceptIds'])}，无法唯一确定分类概念",
             tag=f"#{collision['label']}", facets=collision['facets'],
             conceptIds=collision['conceptIds'])

    reasons.sort(key=lambda item: (
        item['code'],
        str(item.get('conceptId') or item.get('facet') or ''),
        item['message']))
    destructive = [reason for reason in reasons if reason['level'] == 'destructive']
    additive = [reason for reason in reasons if reason['level'] == 'additive']
    change_level = 'destructive' if destructive else ('additive' if additive else 'none')

    def tally(level):
        grouped = {}
        for item in reasons:
            if item['level'] == level:
                grouped[item['code']] = grouped.get(item['code'], 0) + 1
        return [f'{code}×{count}' for code, count in sorted(grouped.items())]

    if change_level == 'none':
        summary = '本次检查未发现会影响分类的词表变化；文件字节或未检查的内容仍可能不同。'
    else:
        summary = f"词表变更属于 {change_level}；各项原因及数量为：{'、'.join(tally('destructive') + tally('additive'))}。"
    detail = {
        'changeLevel': change_level,
        'oldRegistrySha256': frm['registrySha256'],
        'newRegistrySha256': to['registrySha256'],
        'oldVersion': tag_catalog_identity(frm),
        'newVersion': tag_catalog_identity(to),
        'counts': counts,
        'reasons': reasons,
        'summary': summary,
    }
    return {'changeLevel': change_level, 'detail': detail}


# 人工确认只适用于允许确认的破坏性变更原因，且必须对应本次重新计算的结果。
# 新增概念不妨碍确认，但删除概念等不允许确认的原因仍会阻断沿用。
# 所选概念、旧快照和升级说明还须分别通过检查。
_ACK_ELIGIBLE_CODES = (
    'preferred-label-changed',
    'broader-id-changed',
    'alias-removed',
    'label-collision',
    'definition-updated',
    'scope-note-updated',
)
_ACK_FORBIDDEN_CODES = (
    'concept-removed',
    'facet-removed',
    'status-deactivated',
    'version-changed',
    'concept-facet-changed',
    'active-label-not-globally-unique',
)
_ACK_CONCEPT_ID_IMPACT = 'none'
_ACK_FIELDS = ('acknowledged', 'reasonsHash', 'conceptIdImpact', 'note')


def _destructive_reasons(change_detail):
    reasons = (change_detail or {}).get('reasons')
    if not isinstance(reasons, list):
        return []
    return [reason for reason in reasons
            if isinstance(reason, dict) and reason.get('level') == 'destructive']


def _serialize_destructive_reason(reason):
    """去掉原因中的 level 和 message 后，按键排序生成紧凑 JSON，供破坏性原因哈希计算使用；输出格式与 Node 保持一致。"""
    reason_fields = {key: reason[key] for key in sorted(reason) if key not in ('level', 'message')}
    return json.dumps(reason_fields, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _destructive_reasons_hash(change_detail):
    """将破坏性原因的 JSON 文本排序，用一个换行连接，再按 UTF-8 计算 SHA-256。

    重复原因仍参与计算，原因顺序和 message 改写不影响结果。"""
    serialized_reasons = sorted(_serialize_destructive_reason(reason)
                          for reason in _destructive_reasons(change_detail))
    return hashlib.sha256('\n'.join(serialized_reasons).encode('utf-8')).hexdigest()


def _acknowledgement_eligibility(change_detail):
    """判断这次变更是否允许人工确认，不改变原变更等级。"""
    change_level = (change_detail or {}).get('changeLevel')
    codes = sorted({reason.get('code') for reason in _destructive_reasons(change_detail)
                    if reason.get('code')})
    eligible_reasons = [code for code in codes if code in _ACK_ELIGIBLE_CODES]
    ineligible_reasons = [code for code in codes if code not in _ACK_ELIGIBLE_CODES]
    # 等级缺失或未知、破坏性变更没有可确认原因，或者包含不允许确认的原因时，
    # 都返回不可确认。
    known_level = change_level in _REGISTRY_CHANGE_LEVELS
    if known_level and not ineligible_reasons:
        if change_level == 'destructive':
            eligible = bool(eligible_reasons)
        else:
            eligible = not codes
    else:
        eligible = False
    return {'eligible': eligible, 'eligibleReasons': eligible_reasons,
            'ineligibleReasons': ineligible_reasons}


def _validate_destructive_acknowledgement(annotation, expected):
    """核对破坏性变更的人工确认，返回问题说明；通过时返回 None。"""
    eligibility = _acknowledgement_eligibility(expected.get('detail'))
    if not eligibility['eligible']:
        codes = '、'.join(eligibility['ineligibleReasons']) or '重新计算的变更详情缺失'
        return f'本次破坏性变更不属于可人工确认的范围：{codes}'
    ack = annotation.get('destructiveAcknowledgement') if type(annotation) is dict else None
    if type(ack) is not dict:
        return '破坏性变更必须在 destructiveAcknowledgement 中提供显式确认。'
    unknown = [key for key in ack if key not in _ACK_FIELDS]
    if unknown:
        return 'destructiveAcknowledgement 包含未知字段：' + '、'.join(sorted(unknown))
    if ack.get('acknowledged') is not True:
        return 'destructiveAcknowledgement.acknowledged 必须为 true，以明确确认本次变更。'
    if ack.get('conceptIdImpact') != _ACK_CONCEPT_ID_IMPACT:
        return 'destructiveAcknowledgement.conceptIdImpact 必须为 none，表明所选概念 ID 不变。'
    reasons_hash = ack.get('reasonsHash')
    if not isinstance(reasons_hash, str) or not _SHA256_RE.fullmatch(reasons_hash):
        return 'destructiveAcknowledgement.reasonsHash 必须是 64 位十六进制 SHA。'
    if reasons_hash != _destructive_reasons_hash(expected.get('detail')):
        return 'destructiveAcknowledgement.reasonsHash 与本次重新计算的破坏性变更原因不一致。'
    note = ack.get('note')
    if not isinstance(note, str) or not note.strip(_JS_WHITESPACE) \
            or note != note.strip(_JS_WHITESPACE) \
            or len(note) > _REGISTRY_UPGRADE_NOTE_MAX_CHARS:
        return (f'destructiveAcknowledgement.note 必须是长度为'
                f' 1–{_REGISTRY_UPGRADE_NOTE_MAX_CHARS} 字符的非空说明，且首尾不能有空白。')
    return None


def _validate_registry_upgrade_annotation(annotation, expected):
    """核对词表升级说明与重新计算的结果；通过时返回 None，否则返回问题说明。"""
    if type(annotation) is not dict:
        return 'registryUpgradeFrom 升级说明缺失或不是普通对象。'
    try:
        header = protocol_record_header(annotation.get('contract'),'paper-tag-catalog-upgrade')
    except (ValueError, TypeError):
        return 'registryUpgradeFrom 的格式标识和版本不属于支持的组合。'
    for key in ('contract','schemaFingerprint','version','schemaVersion'):
        if (key in header and (type(annotation.get(key)) is not type(header[key]) or annotation.get(key) != header[key])) or (key not in header and key in annotation):
            return 'registryUpgradeFrom 的格式标识和版本不属于支持的组合。'
    from_sha = annotation.get('fromRegistrySha256')
    if not isinstance(from_sha, str) or not _SHA256_RE.fullmatch(from_sha) \
            or from_sha != expected['fromRegistrySha256']:
        return 'registryUpgradeFrom.fromRegistrySha256 格式无效，或与标签阶段记录中的旧词表 SHA 不一致。'
    to_sha = annotation.get('toRegistrySha256')
    if not isinstance(to_sha, str) or not _SHA256_RE.fullmatch(to_sha) \
            or to_sha != expected['toRegistrySha256']:
        return 'registryUpgradeFrom.toRegistrySha256 格式无效，或与当前词表 SHA 不一致。'
    if not annotation.get('fromRegistryVersion') \
            or annotation.get('fromRegistryVersion') != expected.get('fromRegistryVersion', expected['registryVersion']) \
            or annotation.get('toRegistryVersion') != expected.get('toRegistryVersion', expected['registryVersion']):
        return 'registryUpgradeFrom 中的新旧词表版本缺失或与当前版本不一致。'
    change_level = annotation.get('changeLevel')
    if change_level not in _REGISTRY_CHANGE_LEVELS:
        return 'registryUpgradeFrom.changeLevel 必须为 none、additive 或 destructive。'
    if change_level != expected['changeLevel']:
        return (f'registryUpgradeFrom.changeLevel={change_level} '
                f'与重新计算的变更等级 {expected["changeLevel"]} 不一致。')
    if change_level == 'destructive':
        ack_issue = _validate_destructive_acknowledgement(annotation, expected)
        if ack_issue:
            return ack_issue
    elif annotation.get('destructiveAcknowledgement') is not None:
        return '非破坏性变更不能包含 destructiveAcknowledgement 确认记录。'
    reasons = annotation.get('reasons')
    if not isinstance(reasons, list) or any(
            not isinstance(code, str) or not code for code in reasons):
        return 'registryUpgradeFrom.reasons 必须是数组，且各项必须是非空字符串。'
    note = annotation.get('note')
    if not isinstance(note, str) or not note.strip(_JS_WHITESPACE) \
            or note != note.strip(_JS_WHITESPACE) \
            or len(note) > _REGISTRY_UPGRADE_NOTE_MAX_CHARS:
        return (f'registryUpgradeFrom.note 必须是长度为 1–{_REGISTRY_UPGRADE_NOTE_MAX_CHARS}'
                ' 字符的非空说明，且首尾不能有空白。')
    return None


def _validate_tag_catalog_upgrade(from_registry_sha256, concept_ids, annotation,
                           current=None, current_registry_sha256=None,
                           snapshot_resolver=None, from_registry_version=None):
    """按 Node 的规则核验标签词表升级；无法完成核验时返回拒绝结果。

    本函数先取得旧词表快照并重新判断变更，再核对升级说明和所选概念。
    破坏性变更只有属于可确认范围、且提供与本次结果对应的显式确认时才可继续；
    所选概念仍必须在当前词表中启用，旧快照和升级说明也必须通过检查。
    """
    def fail(error, reason_code, change_level=None, detail=None):
        # 变更分类前失败时，changeLevel 和 detail 为 None。
        # 完成分类后，即使确认、升级说明或所选概念未通过检查，仍返回分类结果。
        return {'ok': False, 'error': error, 'reasonCode': reason_code,
                'changeLevel': change_level, 'detail': detail}

    try:
        current_registry = _normalize_registry(
            _PUBLISH_TAG_CATALOG if current is None else current, '当前词表')
        current_sha = str(current_registry_sha256
                          or current_registry.get('registrySha256') or '')
        if not _SHA256_RE.fullmatch(current_sha):
            return fail('当前词表的 SHA 缺失或格式无效，不能沿用标签阶段记录。', 'current-sha-invalid')
        from_sha = str(from_registry_sha256 or '')
        if not _SHA256_RE.fullmatch(from_sha):
            return fail('标签阶段记录中的 registrySha256 格式无效，不能沿用该记录。', 'invalid-from-sha')
        if from_sha == current_sha:
            return fail('标签阶段记录中的词表 SHA 与当前值相同，无需进行词表升级核验。',
                        'already-current')
        snapshot = (snapshot_resolver or _resolve_registry_snapshot)(from_sha)
        if snapshot is None:
            return fail(f'无法取得更新前的词表快照 {from_sha}，不能沿用标签阶段记录。',
                        'snapshot-missing')
        if from_registry_version is not None and tag_catalog_identity(snapshot) != from_registry_version:
            return fail('标签阶段记录中的词表版本与旧词表快照不一致。', 'annotation-invalid')
        classified = _classify_registry_change(snapshot, current_registry)
        change_level = classified['changeLevel']
        detail = classified['detail']
        # 本次重新计算的破坏性变更必须全部属于可确认范围，
        # 且 destructiveAcknowledgement 必须与这些结果一致，才能继续升级检查。
        # 显式确认不能替代旧快照、升级说明和所选概念的检查；
        # 不可确认或确认无效时，仍以 reasonCode=destructive 拒绝沿用。
        if change_level == 'destructive':
            first = [reason['message'] for reason in detail['reasons']
                     if reason['level'] == 'destructive'][:3]
            ack_issue = _validate_destructive_acknowledgement(annotation, {'detail': detail})
            if ack_issue:
                suffix = (f'；{ack_issue}'
                          if ack_issue.startswith('本次破坏性变更不属于可人工确认的范围')
                          else f'；显式确认无效：{ack_issue}')
                return fail(
                    f"词表包含破坏性变更，原标签阶段记录不能直接沿用"
                    f"（{'；'.join(first)}）{suffix}",
                    'destructive', change_level, detail)
        issue = _validate_registry_upgrade_annotation(annotation, {
            'fromRegistrySha256': from_sha,
            'toRegistrySha256': current_sha,
            'registryVersion': tag_catalog_identity(current_registry),
            'fromRegistryVersion': tag_catalog_identity(snapshot),
            'toRegistryVersion': tag_catalog_identity(current_registry),
            'changeLevel': change_level,
            'detail': detail,
        })
        if issue:
            return fail(f'词表升级说明未通过核验：{issue}', 'annotation-invalid',
                        change_level, detail)
        by_id = {concept['id']: concept for concept in current_registry['concepts']}
        stale = []
        for concept_id in (concept_ids if isinstance(concept_ids, list) else []):
            concept = by_id.get(concept_id)
            if concept is None:
                stale.append(f'{concept_id}(缺失)')
            elif concept['status'] != 'active':
                stale.append(f'{concept_id}({concept["status"]})')
        if stale:
            return fail(
                '原标签阶段记录引用的以下概念在当前词表中缺失或已停用：'
                + '、'.join(stale),
                'concept-not-active', change_level, detail)
        return {'ok': True, 'error': None, 'reasonCode': None,
                'changeLevel': change_level, 'detail': detail}
    except Exception as error:  # noqa: BLE001 - 核验中出现异常时返回拒绝结果，保留异常说明。
        return fail(f'无法完成词表升级核验：{error}', 'classify-failed')


def _validate_tag_stage_catalog_upgrade(stage, paper_label):
    """核验标签阶段记录使用旧词表时能否沿用。

    旧版提示仍按原格式和升级规则检查；新版提示必须根据同一次读取的旧快照
    重新计算 SHA。失败时抛出 PublishDataValidationError。"""
    from_sha = str(stage.get('registrySha256') or '')
    to_sha = _PUBLISH_TAG_CATALOG['registrySha256']
    stage_prompt_text_sha256 = str(stage.get('projectionSha256') or '')
    # 词表升级时，projectionSha256 记录原标签阶段使用的提示文本 SHA。
    # 旧版沿用原有的 SHA 格式检查与升级规则；新版还须按旧词表精确核验提示 SHA。
    if not _SHA256_RE.fullmatch(stage_prompt_text_sha256):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段的词表升级被拒绝 [reason=projection-sha-invalid] '
            f'from={from_sha} to={to_sha}: projectionSha256 必须是 64 位十六进制 SHA')
    if 'registryUpgradeFrom' not in stage:
        original = resolve_compatible_proof_catalog(from_sha, _PUBLISH_TAG_CATALOG)
        if original is not None:
            if (stage.get('registryVersion') != tag_catalog_identity(original)
                    or stage_prompt_text_sha256 != tag_prompt_text_sha256(
                        original, stage.get('projectionContract'))):
                raise PublishDataValidationError(
                    f'{paper_label} 旧词表完整兼容核验的原版本或提示文本 SHA 不一致。')
            return original
    snapshot = None
    if is_current_tag_prompt_text_contract(stage.get('projectionContract')):
        def capture_snapshot(registry_sha256):
            nonlocal snapshot
            snapshot = _resolve_registry_snapshot(registry_sha256)
            if isinstance(snapshot, dict):
                if snapshot.get('registrySha256') not in (None, registry_sha256):
                    raise ValueError('旧词表快照中的 SHA 与标签阶段记录绑定的词表 SHA 不一致。')
                snapshot = {**snapshot, 'registrySha256': registry_sha256}
            return snapshot
        result = _validate_tag_catalog_upgrade(
            from_sha, stage.get('conceptIds'), stage.get('registryUpgradeFrom'),
            snapshot_resolver=capture_snapshot,
            from_registry_version=stage.get('registryVersion'))
    else:
        result = _validate_tag_catalog_upgrade(
            from_sha, stage.get('conceptIds'), stage.get('registryUpgradeFrom'),
            from_registry_version=stage.get('registryVersion'))
    if result['ok']:
        if is_current_tag_prompt_text_contract(stage.get('projectionContract')):
            if not isinstance(snapshot, dict):
                raise PublishDataValidationError(
                    f'{paper_label} 标签阶段使用的旧词表快照无法取得，不能核验新版提示文本。')
            try:
                expected_prompt_sha = tag_prompt_text_sha256(
                    snapshot, stage['projectionContract'])
            except ValueError as error:
                raise PublishDataValidationError(
                    f'{paper_label} 标签阶段使用的旧词表快照无效，不能核验新版提示文本。') from error
            if stage_prompt_text_sha256 != expected_prompt_sha:
                raise PublishDataValidationError(
                    f'{paper_label} 标签阶段记录的新版提示文本 SHA 与旧词表快照生成的文本不一致。')
        return
    reason_code = result.get('reasonCode') or 'rejected'
    codes = ''
    if result.get('detail'):
        destructive_codes = sorted({reason['code'] for reason in result['detail']['reasons']
                                    if reason['level'] == 'destructive'})
        if destructive_codes:
            codes = ' codes=' + ','.join(destructive_codes)
    raise PublishDataValidationError(
        f'{paper_label} 标签阶段的词表升级被拒绝 [reason={reason_code}{codes}] '
        f'from={from_sha} to={to_sha}: {result["error"]}')


def _validate_tag_stage_record(paper, manifest, paper_label, *, original_registry_sha256=None):
    """发布端根据 Node 保存的标签阶段记录，重新核验词表、正文、检查点和所选标签的绑定。"""
    heading_issue = evaluation_heading_issue(paper.get('analysis'))
    if heading_issue:
        raise PublishDataValidationError(f'{paper_label} {heading_issue}')
    try:
        tag_record = read_tag_stage_record(manifest, paper.get('analysisStageCheckpoints'))
    except ValueError as error:
        raise PublishDataValidationError(f'{paper_label} {error}') from error
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    supported_selection_contracts = (LEGACY_TAG_SELECTION_CONTRACT, TAG_SELECTION_CONTRACT)
    if not isinstance(contracts, dict) or (
            not is_tag_stage_record_declaration(contracts.get(tag_record['contractKey']))
            if tag_record['format'] == 'current'
            else not is_supported_tag_selection_contract(contracts.get(tag_record['contractKey']))):
        raise PublishDataValidationError(
            f'{paper_label} 标签选择协议缺失，或不是当前支持的版本。')
    stages = manifest.get('stages') if isinstance(manifest, dict) else None
    stage = tag_record['stage']
    if not isinstance(stage, dict) or stage.get('status') not in {'complete', 'not_needed'}:
        raise PublishDataValidationError(f'{paper_label} 标签阶段记录缺失，或尚未完成。')
    catalog = _PUBLISH_TAG_CATALOG
    if original_registry_sha256 is not None:
        catalog = load_archived_tag_catalog(original_registry_sha256)
        if catalog is None or stage.get('registrySha256') != original_registry_sha256 \
                or stage.get('registryVersion') != tag_catalog_identity(catalog):
            raise PublishDataValidationError(f'{paper_label} 原标签阶段必须绑定真实 SHA 归档及原版本。')
        annotation = stage.get('registryUpgradeFrom')
        if 'registryUpgradeFrom' in stage:
            result = _validate_tag_catalog_upgrade(
                annotation.get('fromRegistrySha256') if isinstance(annotation, dict) else None,
                stage.get('conceptIds'), annotation, current=catalog,
                snapshot_resolver=load_archived_tag_catalog,
                from_registry_version=annotation.get('fromRegistryVersion') if isinstance(annotation, dict) else None)
            if result.get('ok') is not True:
                raise PublishDataValidationError(f'{paper_label} 原标签阶段的历史升级链无效：{result.get("error")}')

    # 按保存记录选择提示版本；读取旧版时不改写提示 SHA 或绑定哈希。
    prompt_text_contract = stage.get('projectionContract')
    if not is_protocol_contract(prompt_text_contract,'paper-tag-prompt-text'):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段记录中的提示文本协议版本不受支持。')
    if not is_supported_tag_selection_contract(stage.get('selectionContract')):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段记录中的 selectionContract 与当前词表、提示文本或标签选择协议不一致。')
    if tag_record['format'] != 'current' \
            and contracts[tag_record['contractKey']] != stage['selectionContract']:
        raise PublishDataValidationError(
            f'{paper_label} 标签选择协议缺失，或不是当前支持的版本。')
    if (stage.get('registryVersion') != tag_catalog_identity(catalog)
            and not (stage.get('registrySha256') != catalog['registrySha256']
                     and is_catalog_identity_upgrade(stage.get('registryVersion'),tag_catalog_identity(catalog)))):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段记录中的 registryVersion 与当前词表、提示文本或标签选择协议不一致。')
    proof_catalog = catalog
    if stage.get('registrySha256') == catalog['registrySha256']:
        for field, expected in (
                ('registrySha256', catalog['registrySha256']),
                ('projectionSha256', tag_prompt_text_sha256(
                    catalog, prompt_text_contract))):
            if stage.get(field) != expected:
                raise PublishDataValidationError(
                    f'{paper_label} 标签阶段记录中的 {field} 与当前词表、提示文本或标签选择协议不一致。')
    else:
        proof_catalog = _validate_tag_stage_catalog_upgrade(stage, paper_label) or _PUBLISH_TAG_CATALOG

    sha_fields = (
        'inputAnalysisSha256', 'outputAnalysisSha256',
        'inputProtectedProjectionSha256', 'outputProtectedProjectionSha256',
        tag_record['hashKey'], 'bindingSha256',
    )
    if any(not re.fullmatch(r'[a-f0-9]{64}', str(stage.get(field) or ''))
           for field in sha_fields):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段记录中的正文、受保护正文、标签内容或绑定 SHA 缺失，或格式无效。')

    text_sha = lambda value: hashlib.sha256(value.encode('utf-8')).hexdigest()
    structure_stage = stages.get('structureRepair')
    if not isinstance(structure_stage, dict) \
            or structure_stage.get('outputAnalysisSha256') \
            != stage['inputAnalysisSha256']:
        raise PublishDataValidationError(
            f'{paper_label} 结构修复阶段的输出 SHA 与标签阶段的输入 SHA 不一致，或结构修复记录缺失。')
    if stage['inputProtectedProjectionSha256'] \
            != stage.get('outputProtectedProjectionSha256'):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段记录中的输入与输出受保护正文哈希不一致。')
    if stage['status'] == 'not_needed' \
            and stage['inputAnalysisSha256'] != stage['outputAnalysisSha256']:
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段标记为无需修复，但记录中的输入与输出正文 SHA 不一致。')

    current_analysis = str(paper.get('analysis') or '')
    if stage[tag_record['hashKey']] != _hash_tag_section_and_primary_tags(current_analysis):
        raise PublishDataValidationError(
            f'{paper_label} 最终正文中的标签章节或主标签字段与标签阶段记录的 SHA 不一致。')
    core_summary_stage = stages.get('coreSummaryRepair')
    scoring_stage = stages.get('scoringAudit')
    if not isinstance(core_summary_stage, dict) \
            or core_summary_stage.get('status') not in {'complete', 'not_needed'} \
            or core_summary_stage.get('inputAnalysisSha256') != stage['outputAnalysisSha256']:
        raise PublishDataValidationError(
            f'{paper_label} 详细摘要阶段记录缺失、尚未完成，或其输入 SHA 与标签阶段的输出 SHA 不一致。')
    core_output_sha = core_summary_stage.get('outputAnalysisSha256')
    if not re.fullmatch(r'[a-f0-9]{64}', str(core_output_sha or '')) \
            or not isinstance(scoring_stage, dict) \
            or scoring_stage.get('coreSummaryInputAnalysisSha256') != core_output_sha:
        raise PublishDataValidationError(
            f'{paper_label} 详细摘要阶段的输出 SHA 无效，评分记录缺失，或评分使用的摘要输入 SHA 与摘要阶段输出不一致。')

    checkpoints = paper.get('analysisStageCheckpoints')
    input_analysis = checkpoints.get('structureRepair') \
        if isinstance(checkpoints, dict) else None
    output_analysis = tag_record['checkpoint']
    if not isinstance(output_analysis, str):
        raise PublishDataValidationError(
            f'{paper_label} 已完成的标签阶段缺少有效的输出正文。')
    masked_output_analysis = _mask_classification_fields(output_analysis)
    if (not masked_output_analysis
            or text_sha(output_analysis) != stage['outputAnalysisSha256']
            or text_sha(masked_output_analysis)
            != stage['outputProtectedProjectionSha256']
            or _hash_tag_section_and_primary_tags(output_analysis)
            != stage[tag_record['hashKey']]):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段保存的输出正文无效，或其正文、受保护正文或标签内容的 SHA 与阶段记录不一致。')
    if stage['status'] == 'complete':
        if not isinstance(input_analysis, str):
            raise PublishDataValidationError(
                f'{paper_label} 已执行标签修复，但结构修复阶段缺少有效的输入正文。')
        masked_input_analysis = _mask_classification_fields(input_analysis)
        if (not masked_input_analysis
                or text_sha(input_analysis) != stage['inputAnalysisSha256']
                or text_sha(masked_input_analysis)
                != stage['inputProtectedProjectionSha256']):
            raise PublishDataValidationError(
                f'{paper_label} 标签阶段保存的输入正文无效，或其正文或受保护正文 SHA 与阶段记录不一致。')

    binding_fields = tag_record['bindingFields']
    binding = {field: stage.get(field) for field in binding_fields}
    if stage['bindingSha256'] != _manual_hash(binding):
        raise PublishDataValidationError(
            f'{paper_label} 标签阶段记录的绑定 SHA 与按原字段重新计算的结果不一致。')

    heading_issue = evaluation_heading_issue(current_analysis)
    if heading_issue:
        raise PublishDataValidationError(f'{paper_label} {heading_issue}')
    current_parsed = parse_analysis(current_analysis, tag_catalog=proof_catalog)
    current_validation = current_parsed.get('tagValidation') or {}
    expected_selection = {
        'primaryTaskId': current_validation.get('primaryTaskId'),
        'primaryMethodId': current_validation.get('primaryMethodId'),
        'conceptIds': current_validation.get('conceptIds'),
    }
    recorded_selection = {field: stage.get(field) for field in expected_selection}
    if not current_validation.get('valid') or expected_selection != recorded_selection:
        raise PublishDataValidationError(
            f'{paper_label} 当前正文中的标签选择无效，或与标签阶段记录的主标签和概念 ID 不一致。')
    if stage['status'] == 'complete':
        heading_issue = evaluation_heading_issue(output_analysis)
        if heading_issue:
            raise PublishDataValidationError(f'{paper_label} 标签阶段输出：{heading_issue}')
        output_validation = parse_analysis(
            output_analysis, tag_catalog=proof_catalog)['tagValidation']
        output_selection = {field: output_validation.get(field) for field in expected_selection}
        if not output_validation.get('valid') or output_selection != recorded_selection:
            raise PublishDataValidationError(
                f'{paper_label} 标签阶段保存的输出正文未通过标签检查，或其中的主标签和概念 ID 与阶段记录不一致。')


class _DailyPublicationTableCapability:
    pass


_DAILY_PUBLICATION_TABLE_READERS = weakref.WeakKeyDictionary()


@contextmanager
def _verified_daily_publication_table_scope(source_reader):
    """Internal owner bridge: no JSON, path or paper field can enable it."""
    if not callable(source_reader):
        raise PublishDataValidationError('daily table source requires its verified operation owner')
    capability = _DailyPublicationTableCapability()
    _DAILY_PUBLICATION_TABLE_READERS[capability] = source_reader
    try:
        yield capability
    finally:
        del _DAILY_PUBLICATION_TABLE_READERS[capability]


def _publication_table_source_text(paper, capability=None):
    if capability is None:
        manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
        proofs = (paper.get('freshRewriteProvenance'),
                  manifest.get('freshRewriteProvenance') if isinstance(manifest, dict) else None)
        if any(is_fresh_source_provenance(proof)
               and ('sourceGeneration' in proof or 'sourceManifestSha256' in proof)
               for proof in proofs):
            raise PublishDataValidationError('daily sealed table source requires the current verified run capability')
        return _manual_result_claim_source_text(paper)
    if type(capability) is not _DailyPublicationTableCapability:
        raise PublishDataValidationError('daily table source capability is not a verified owner handle')
    reader = _DAILY_PUBLICATION_TABLE_READERS.get(capability)
    if reader is None:
        raise PublishDataValidationError('daily table source operation has ended')
    return reader(paper)


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


_HTML_TABLE_BLOCK_START = re.compile(
    r'^ {0,3}</?(?ai:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|'
    r'dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|'
    r'legend|li|main|menu|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)'
    r'(?=[\s/>])',
)


def _reader_literal_html_name(line):
    # Goldmark 原样块采用简单大小写折叠；只接收已证的单字符 ASCII/ſ/K 候选。
    # 不使用任意 Unicode 多字符 casefold（例如连字），也不扩大普通 HTML 标签语法。
    match = re.match(r'^ {0,3}<([A-Za-zſK]+)(?=[\s/>])', line)
    name = match.group(1).casefold() if match else None
    return name if name in {'pre', 'code', 'script', 'style', 'textarea'} else None


def _reader_literal_html_closed(line, name):
    # Hugo 可识别 ſcript 的开始；实际 DOM 的 ASCII script 不由 </ſcript> 结束。
    # 结束仅接收 ASCII 标签，不能与开始的候选范围合并。
    return any(match.group(1).casefold() == name
               for match in re.finditer(r'</([A-Za-z]+)\s*>', line))


def mask_protected_markdown_table_regions(text, *, protect_quotes=True):
    """用等长空格替换隐藏内容，保留原行号；不改可见单元格或来源记录。"""
    fence = None
    quote = False
    html_block = False
    html_literal = None
    comment = False
    html_terminator = None
    output = []
    for line in str(text or '').split('\n'):
        blank = re.sub(r'[^\r]', ' ', line)
        if html_literal:
            if _reader_literal_html_closed(line, html_literal):
                html_literal = None
            output.append(blank)
            continue
        if html_terminator:
            if html_terminator in line:
                html_terminator = None
            output.append(blank)
            continue
        if html_block and not line.strip():
            html_block = False
        markup_line = line if protect_quotes else re.sub(r'^ {0,3}(?:>[ \t]?)+', '', line)
        boundary = None if html_block else re.match(r'^ {0,3}(`{3,}|~{3,})', markup_line)
        if fence:
            if (boundary and boundary.group(1)[0] == fence[0]
                    and len(boundary.group(1)) >= len(fence)
                    and not markup_line[boundary.end():].strip()):
                fence = None
            output.append(blank)
            continue
        if boundary and not comment:
            fence_marker = boundary.group(1)
            rest = markup_line[boundary.end():]
            if not (fence_marker[0] == '`' and '`' in rest):
                fence = fence_marker
                output.append(blank)
                continue
        starts_html_block = bool(_HTML_TABLE_BLOCK_START.match(markup_line))
        # 原样 HTML 里的反引号不是代码；普通单元格里的 HTML 代码示例则须保留。
        probe = line if html_block or comment or starts_html_block else re.sub(
            r'(`+)(?!`)([^\n]*?)\1(?!`)', lambda match: 'x' * len(match.group(0)), line,
        )
        chars = list(line)
        index = 0
        while index < len(line):
            if comment:
                if probe.startswith('-->', index):
                    chars[index:index + 3] = [' '] * 3
                    index += 3
                    comment = False
                    continue
                if line[index] != '\r':
                    chars[index] = ' '
            elif probe.startswith('<!--', index):
                comment = True
                chars[index:index + 4] = [' '] * 4
                index += 4
                continue
            index += 1
        visible = ''.join(chars)
        if html_block:
            output.append(blank)
            continue
        markup_visible = visible if protect_quotes else re.sub(r'^ {0,3}(?:>[ \t]?)+', '', visible)
        literal = _reader_literal_html_name(markup_visible)
        if literal:
            comment = False
            if not _reader_literal_html_closed(probe, literal):
                html_literal = literal
            output.append(blank)
            continue
        terminator = ('?>' if re.match(r'^ {0,3}<\?', markup_visible) else
                      ']]>' if re.match(r'^ {0,3}<!\[CDATA\[', markup_visible) else
                      '>' if re.match(r'^ {0,3}<![A-Z]', markup_visible) else None)
        if terminator:
            if terminator not in probe:
                html_terminator = terminator
            output.append(blank)
            continue
        if not visible.strip():
            quote = False
            html_block = False
        if re.match(r'^ {0,3}#{1,6}(?:[ \t]|$)', visible):
            quote = False
        if protect_quotes and re.match(r'^ {0,3}>', visible):
            quote = True
        if (starts_html_block and visible.strip()) or re.match(r'^ {0,3}</?(?ai:[a-z][\w-]*)(?:\s+[^<>]*)?\s*/?>[ \t]*$', markup_visible):
            html_block = True
        output.append(blank if quote or html_block or re.match(r'^(?: {4}|\t)', markup_visible) else visible)
    return '\n'.join(output)


def extract_markdown_tables(text):
    lines = mask_protected_markdown_table_regions(text).splitlines()
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
            if _is_table_identifier_header(normalized):
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
    """复刻 Node 对实验章节证据的有界选取逻辑。"""
    source = str(source_text or '')
    start = re.search(
        r'(?:^|\n)\s*(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\s+)?'
        r'(?:experiments?|experimental\s+(?:setup|results?)|evaluation|'
        r'results?(?:\s+and\s+discussion)?)\s*(?:\n|$)',
        source,
        re.I,
    )
    if not start:
        return source[:50000]
    tail = source[start.start():start.start() + 60000]
    end = re.search(
        r'(?:^|\n)\s*(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\s+)?'
        r'(?:conclusions?|limitations?|references?)\s*(?:\n|$)',
        tail,
        re.I,
    )
    return tail[:end.start()] if end and end.start() > 0 else tail


def _source_evidence_pattern(pattern):
    """Keep JS whitespace separate from its Unicode-ignore-case word boundary."""
    space = '[' + re.escape(_JS_WHITESPACE) + ']'
    word = r'(?-i:[0-9A-Za-z_ſK])'
    boundary = r'(?:(?<!' + word + r')(?=' + word + r')|(?<=' + word + r')(?!' + word + r'))'
    # Preserve escaped literal backslashes in source-derived model names.
    return re.sub(r'(?<!\\)((?:\\\\)*)\\([sb])',
                  lambda match: match[1] + (space if match[2] == 's' else boundary), pattern)


def _source_evidence_extra_i(*values):
    # Python re.I additionally folds these two letters; they cannot authorize
    # a positive English source profile under the JS /iu rules.
    return any('ı' in str(value) or 'İ' in str(value) for value in values)


def _source_scope_observed_experiment_claim(text):
    if _source_evidence_extra_i(text):
        return False
    return not re.search(
        _source_evidence_pattern(r'\b(?:if|suppos(?:e|ing)|hypothetical)\b|'
        r'\b(?:future|planned|proposed)\s+(?:experiments?|work|evaluation|validation)\b|'
        r'\b(?:should|must|needs?\s+to)\s+(?:compare|report|score|require|validate)\b|'
        r'\b(?:previous|related|other)\s+(?:work|stud(?:y|ies)|models?|systems?)\b|'
        r'\b(?:does|do|did)\s+not\s+(?:identify|explain)\s+why\b|'
        r'\b(?:not|never)\s+(?:observed|reported|obtained)\b|'
        r'(?:如果|假设|假想|计划|未来实验|后续实验|相关工作|先前研究|其他模型|他人|错误说法|'
        r'并非|不是|未报告|尚未报告|未观察到|没有观察到|否认)'), str(text), re.I)


def _observed_source_negative_evidence(source_text):
    """对齐 analysis-contract.js observedSourceNegativeEvidence：仅保留论文实际观测的负面陈述。"""
    # 与 JS /iu 保持一致：使用 _source_evidence_pattern + re.I | re.A，避免中文字符被 Python
    # 视为 \w 破坏词边界，并避免土耳其语 ı/İ 被 Python re.I 误折叠为 i 导致 fail-open 漏检。
    scope_excluded = re.compile(
        _source_evidence_pattern(
            r'\b(?:if|suppos(?:e|ing)|hypothetical)\b|'
            r'\b(?:future|planned|proposed)\s+(?:experiments?|work|evaluation|validation)\b|'
            r'\b(?:should|must|needs?\s+to)\s+(?:compare|report|score|require|validate)\b|'
            r'\b(?:previous|related|other)\s+(?:work|stud(?:y|ies)|models?|systems?)\b|'
            r'\b(?:does|do|did)\s+not\s+(?:identify|explain)\s+why\b|'
            r'\b(?:not|never)\s+(?:observed|reported|obtained)\b|'
            r'(?:如果|假设|假想|计划|未来实验|后续实验|相关工作|先前研究|其他模型|他人|错误说法|'
            r'并非|不是|未报告|尚未报告|未观察到|没有观察到|否认)'
        ),
        re.I | re.A,
    )
    split_re = re.compile(
        _source_evidence_pattern(
            r'(?<=[.!?])\s+(?=[A-Z])|[。；\n]|;\s*|,\s*(?=(?:but|however|yet)\b)|'
            r'[，,]\s*(?=(?:但|然而|实测|测试显示|实验显示))'
        ),
        re.A,
    )
    exec_failure_re = re.compile(
        _source_evidence_pattern(
            r'\b(?:agent execution|execution fail(?:ure|s)|failures? return|'
            r'failure feedback|in the case of failure|when execution fails)\b'
        ),
        re.I | re.A,
    )
    exec_observed_re = re.compile(
        _source_evidence_pattern(
            r'\b(?:observed|measured|experiment|evaluation|test results?|failure rate)\b|\d+(?:\.\d+)?%'
        ),
        re.I | re.A,
    )
    measured_en_re = re.compile(
        _source_evidence_pattern(
            r'^\s*(?:(?:the|our)\s+)?(?:experiments?|tests?|measurements?|results?)\s+'
            r'(?:show|demonstrate|confirm|reveal|indicate)\s+(?:that\s+)?[^;\n]{0,180}?'
            r'\b(?:fails?|failed|degrades?|degraded|worse\s+than)\b[^;\n]{0,100}\bif\b'
        ),
        re.I | re.A,
    )
    measured_zh_re = re.compile(
        _source_evidence_pattern(
            r'^\s*(?:本次)?(?:实测|实验|测试)(?:结果)?(?:显示|表明|发现)[^。；\n]{0,180}(?:失败|退化|不显著)'
        ),
        re.A,
    )
    measured_excluded_re = re.compile(
        _source_evidence_pattern(
            r'(?:hypothetical|suppose|planned|future experiment|previous work|other model|'
            r'not observed|not reported)|'
            r'(?:假设|假想|假定|计划|未来实验|先前研究|其他模型|他人|并非|未观察到|没有观察到)'
        ),
        re.I | re.A,
    )
    propositions = split_re.split(str(source_text or ''))
    kept = []
    for proposition in propositions:
        if exec_failure_re.search(proposition) and not exec_observed_re.search(proposition):
            continue
        if not scope_excluded.search(proposition):
            kept.append(proposition)
            continue
        measured_condition = bool(
            measured_en_re.search(proposition)
            or (measured_zh_re.search(proposition) and re.search(r'(?:若|如果|当)', proposition))
        )
        if measured_condition and not measured_excluded_re.search(proposition):
            kept.append(proposition)
    return '\n'.join(kept)


def _has_affirmed_overfitting_evidence(text):
    """对齐 analysis-contract.js hasAffirmedOverfittingEvidence：确认正向报告过拟合负面证据。"""
    positive_pattern = re.compile(
        r'(?:出现|发生|呈现|表现出|暴露出|导致|造成)(?:了)?[^，,：:\n未无不没]{0,12}(?:域)?过拟合',
        re.I,
    )
    for clause in re.split(r'[。；！？!?\n]', str(text or '')):
        for match in positive_pattern.finditer(clause):
            prefix = clause[max(0, match.start() - 12):match.start()]
            if not re.search(r'(?:未|没有|无|不曾|并未)[^，,：:\n]{0,10}$', prefix):
                return True
    return False


def _own_observed_source_scope(text):
    return _source_scope_observed_experiment_claim(text) and not re.search(
        _source_evidence_pattern(r'\b(?:hypothes(?:is|izes?|ized)|hypothetical|illustrative|proposed only|not our experiment|'
        r'(?:previous|other|related)\s+(?:paper|work|study|method)|(?:did|do|does) not conduct|'
        r'no ablation experiment|not performed|not conducted|withdrawn|revoked|false statement)\b|'
        r'(?:^|\n)\s*[>“"]|(?:他人|其他研究|转述|撤回|不是本研究)'), str(text), re.I)


def _normalize_local_evidence_heading(line):
    heading = str(line or '').strip(_JS_WHITESPACE)
    atx = re.fullmatch(r'#{1,6}[ \t]+([^\n]*)', heading)
    if atx:
        heading = re.sub(r'[ \t]+#+[ \t]*$', '', atx[1]).strip(_JS_WHITESPACE)
    bold = re.fullmatch(r'(\*\*|__)([^\n]+)\1', heading)
    return bold[2].strip(_JS_WHITESPACE) if bold else heading


def _has_own_local_reported_experiment(text, index, sentence):
    if not _own_observed_source_scope(sentence):
        return False
    before = str(text or '')[:index]
    if before[before.rfind('\n') + 1:].strip(_JS_WHITESPACE):
        return True
    adjacent = before[-512:].rstrip(' \t\r\n')
    if not adjacent and before:
        return False
    previous = _normalize_local_evidence_heading(re.split(r'[。；！？!?]', adjacent.split('\n')[-1])[-1])
    notice = (r'^(?:第三方|他人|外部团队|其他研究|相关工作|相关研究|先前研究|既有研究|旧工作|'
              r'基线方法|对照系统|假设|假想|假定|设想|如果|预计|计划|未来|'
              r'previous\s+work|prior\s+research|related\s+work)[^。；.!?\n]{0,140}[：:]$')
    return not re.search(_source_evidence_pattern(notice), previous, re.I)


def _has_source_backed_placement_control(results, source_text):
    if _source_evidence_extra_i(results, source_text):
        return False
    # Exact source-owned single-factor control, not a keyword or a paper allowlist.
    raw_source = str(source_text or '')
    headings = list(re.finditer(
        _source_evidence_pattern(r'^(?:(?:[0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)\s+)?'
        r'Uniform-stride versus adaptive event placement\s*\r?\n'), raw_source, re.I | re.M))
    if len(headings) != 1:
        return False
    tail = raw_source[headings[0].end():headings[0].end() + 16000]
    end = re.search(r'^[ \t]*(?:[0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)[ \t]+[A-Z]', tail, re.M)
    source = tail[:end.start()] if end else tail
    preceding = [line for line in raw_source[:headings[0].start()].split('\n') if line.strip(_JS_WHITESPACE)]
    prefix = preceding[-1] if preceding else ''
    if not _own_observed_source_scope(prefix + '\n' + source):
        return False
    control = re.search(
        r'To isolate event placement, we compare[^\n]{1,600}?Both models share the '
        r'[^\n]{1,100}?latent grid, [^\n]{1,100}?interval aggregator, '
        r'[^\n]{1,100}?quantizer, and causal decoder', source, re.I)
    observed = re.search(
        r'Adaptive placement gives[^\n]{1,1400}?With aggregation and decoding held fixed[^\n]{1,500}', source, re.I)
    def owns(match):
        return match is not None and _own_observed_source_scope(
            source[source.rfind('\n', 0, match.start()) + 1:match.start()] + match[0])
    if not owns(control) or not owns(observed):
        return False
    single = re.search(
        _source_evidence_pattern(r'\bdWER\b[^.!?]{0,180}with one codebook\s*\(([0-9]+(?:\.[0-9]+)?)%\s*'
        r'(?:→\s*(?:\\rightarrow)?|\\rightarrow)\s*([0-9]+(?:\.[0-9]+)?)%\)'), observed[0], re.I)
    depths = re.search(
        _source_evidence_pattern(r'at depths ([1-9][0-9]*) and ([1-9][0-9]*), dWER is close\s*'
        r'\(([0-9]+(?:\.[0-9]+)?)% versus ([0-9]+(?:\.[0-9]+)?)% and '
        r'([0-9]+(?:\.[0-9]+)?)% versus ([0-9]+(?:\.[0-9]+)?)%\)'), observed[0], re.I)
    if not single or not depths or float(single[2]) >= float(single[1]) or depths[1] == depths[2]:
        return False
    pairs = {depths[1]: (depths[3], depths[4]), depths[2]: (depths[5], depths[6])}
    for reported in re.finditer(r'[^。；\n]+', str(results or '')):
        sentence = reported[0]
        if (not _has_own_local_reported_experiment(results, reported.start(), sentence)
                or re.search(_source_evidence_pattern(r'假想|设想|第三方|旧工作|既有研究|先前工作|先前研究|相关工作|相关研究|'
                             r'文献|引用|转述|撤回|否认|不成立|\b(?:previous|prior|related)\s+(?:work|research)\b'),
                             sentence, re.I)):
            continue
        measured = re.search(
            _source_evidence_pattern(r'只改变放置的均匀步长对照中[^。]{1,150}单码本\s+dWER\s+从\s*'
            r'([0-9]+(?:\.[0-9]+)?)%\s+降到\s*([0-9]+(?:\.[0-9]+)?)%[，,]\s*'
            r'([1-9][0-9]*)\s*层时为\s*([0-9]+(?:\.[0-9]+)?)%\s+对\s*([0-9]+(?:\.[0-9]+)?)%'), sentence, re.I)
        pair = pairs.get(measured[3]) if measured else None
        if (measured and pair and float(measured[1]) == float(single[1])
                and float(measured[2]) == float(single[2])
                and float(measured[4]) == float(pair[0]) and float(measured[5]) == float(pair[1])):
            return True
    return False


def _is_reported_experiment_prefix(prefix):
    return not re.search(r'(?:并非|不是|未能|没有|尚未|未曾|不能|不应|如果|假设|假如|倘若|若|未|不|'
                         r'计划|讨论|建议|拟|将|未来|有待|打算|设想)[^，,]{0,30}$', prefix)


def _has_adjacent_affirmative_evidence_withdrawal(text, end, subject_pattern):
    next_line = re.sub(r'^[。；\r\n \t]+', '', str(text)[end:]).split('\n')[0].rstrip('\r')[:600]
    line = _normalize_local_evidence_heading(next_line)
    first_span = re.search(r'^(\*\*|__)([^\n]+?)\1(?=[。； \t]|$)', line)
    heading = re.search(r'^#{1,6}[ \t]+', next_line)
    heading_prefix = heading[0] if heading else ''
    next_claim = _normalize_local_evidence_heading(heading_prefix + (first_span[2] if first_span else line).split('。')[0])
    affirmative = (r'^(?:(?:已经|现已|已)?(?:被)?(?:正式)?撤回(?:了)?|(?:已经|现已|已)?被否认|'
                   r'(?:确实|已经|现已|已)?不成立|(?:确有|有|存在)错误|有误|(?:是)?错误(?:的)?)$')
    for clause in re.split(r'[，,；;]', next_claim):
        for subject in re.finditer(_source_evidence_pattern(subject_pattern), clause, re.I):
            prefix = re.split(r'但是|然而|不过|可是|但|却', clause[:subject.start()])[-1]
            if (_own_observed_source_scope(prefix)
                    and not re.search(_source_evidence_pattern(r'第三方|外部团队|假定|设想|撤回|不成立|并不|'
                                      r'\b(?:withdrawn|revoked|not performed|not conducted|false statement)\b'), prefix, re.I)
                    and _is_reported_experiment_prefix(prefix)
                    and re.fullmatch(_source_evidence_pattern(affirmative), clause[subject.end():].strip(_JS_WHITESPACE))):
                return True
    return False


def _matches_source_audiogram_metric_pairs(table, old_column, new_column, method, metric, baseline, source):
    if _source_evidence_extra_i(table, method, metric, baseline, source):
        return False
    captions = list(re.finditer(_source_evidence_pattern(r'(?:^|\n)Table\s+[0-9]+:\s*Optimization results for profiles '
                               r'[^\n]{1,100}with limited residual DR[^\n]*'), source, re.I))
    if len(captions) != 1:
        return False
    tail = source[captions[0].end():captions[0].start() + 20000]
    following = re.search(_source_evidence_pattern(r'(?:^|\n)Table\s+[0-9]+:'), tail, re.I)
    body = tail[:following.start()] if following else tail
    audiogram = next((i for i, h in enumerate(table['header']) if re.fullmatch(r'(?:听力图|audiograms?)', str(h).strip(_JS_WHITESPACE), re.I)), -1)
    signal = next((i for i, h in enumerate(table['header']) if re.fullmatch(r'(?:信号|signals?)', str(h).strip(_JS_WHITESPACE), re.I)), -1)
    family = re.fullmatch(r'([A-Za-z]+)-[1-9][0-9]*', method)
    if audiogram < 0 or signal < 0 or not family:
        return False
    music_signal = {'紧凑': 'Tight', '常规': 'Normal', '动态': 'Dynamic'}
    for row in table['rows']:
        profile = re.fullmatch(_source_evidence_pattern(r'([A-Z][0-9]{1,2})\s+有限范围'), str(row[audiogram] if audiogram < len(row) else '').strip(_JS_WHITESPACE))
        music = music_signal.get(str(row[signal] if signal < len(row) else '').strip(_JS_WHITESPACE))
        if not profile or not music:
            return False
        begin = re.search(_source_evidence_pattern(r'(?:^|\n)' + re.escape(profile[1]) + r' with limited DR\r?\n'), body)
        if not begin:
            return False
        rest = body[begin.end():]
        end = re.search(_source_evidence_pattern(r'(?:^|\n)(?:[A-Z][0-9]{1,2} with limited DR|Fig\.|Table\s+[0-9]+:)'), rest)
        lines = [line.strip(_JS_WHITESPACE) for line in re.split(r'\r?\n', rest[:end.start()] if end else rest) if line.strip(_JS_WHITESPACE)]
        metric_row = next((i for i, line in enumerate(lines) if line.startswith(metric + ' ') and '↑' in line), -1)
        if metric_row < 0:
            return False
        header = lines[:metric_row]
        methods = [line for line in header if re.fullmatch(_source_evidence_pattern(re.escape(family[1]) + r'-[1-9][0-9]*'), line)]
        index = methods.index(method) if method in methods else -1
        labels = [line for line in header if line == baseline or line == 'Opt.']
        if (not header or header[0] != 'GR' or index < 0 or len(set(methods)) != len(methods)
                or '|'.join(labels) != '|'.join(baseline + '|Opt.' for _ in methods)):
            return False
        metric_tail = lines[metric_row + 1:]
        next_metric = next((i for i, line in enumerate(metric_tail) if re.search(r'[↑↓]', line)), -1)
        cells = metric_tail[:next_metric] if next_metric >= 0 else metric_tail
        starts = [i for i, line in enumerate(cells) if line == music]
        if len(starts) != 1:
            return False
        values = cells[starts[0] + 1:starts[0] + 2 + 2 * len(methods)]
        if (any(column >= len(row) for column in (old_column, new_column))
                or not all(re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', str(row[column]))
                           for column in (old_column, new_column))):
            return False
        if (len(values) != 1 + 2 * len(methods)
                or not all(re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', value) for value in values)
                or float(row[old_column]) != float(values[1 + 2 * index])
                or float(row[new_column]) != float(values[2 + 2 * index])):
            return False
    return True


def _has_source_backed_quality_audibility_tradeoff(results, tables, source_text):
    if _source_evidence_extra_i(results, tables, source_text):
        return False
    source = str(source_text or '')
    pattern = (r'([A-Za-z][A-Za-z0-9-]{1,39}) optimization reduces ([A-Za-z][A-Za-z0-9-]{1,39}) '
               r'compared to the single-channel ([A-Za-z][A-Za-z0-9-]{0,39}) baseline '
               r'\(by up to ([0-9]+(?:\.[0-9]+)?)\), indicating that the single-channel optimizer '
               r'sacrifices quality to improve audibility')
    for match in re.finditer(_source_evidence_pattern(pattern), source):
        line_start = source.rfind('\n', 0, match.start()) + 1
        preceding = [line for line in source[:line_start].split('\n') if line.strip(_JS_WHITESPACE)]
        previous = preceding[-1] if preceding else ''
        if not _own_observed_source_scope(previous[-300:] + '\n' + source[line_start:match.start()] + match[0]):
            continue
        method, metric, baseline, delta = match.groups()
        if float(delta) <= 0:
            continue
        reported = (r'单通道[^。；\n]{0,60}' + re.escape(metric)
                    + r'[^。；\n]{0,80}[，,]\s*优化反而为换可听度让出最多\s*([0-9]+(?:\.[0-9]+)?)\s*的质量')
        prose_matches = False
        for sentence in re.finditer(r'[^。；\n]+', str(results or '')):
            loss = re.search(_source_evidence_pattern(reported), sentence[0])
            if (loss and float(loss[1]) == float(delta)
                    and _has_own_local_reported_experiment(results, sentence.start(), sentence[0])
                    and not re.search(r'假想|设想|第三方|旧工作|既有研究|先前工作|先前研究|相关工作|相关研究|'
                                      r'文献|引用|转述|撤回|否认|并未|没有|不成立', sentence[0], re.I)):
                prose_matches = True
                break
        if not prose_matches:
            continue
        for table in tables:
            clean = lambda header: re.sub(r'[*_`]', '', str(header)).strip(_JS_WHITESPACE)
            old_column = next((i for i, h in enumerate(table['header']) if clean(h) == f'{method} {baseline} {metric} ↑'), -1)
            new_column = next((i for i, h in enumerate(table['header']) if clean(h) == f'{method} 优化 {metric} ↑'), -1)
            if (old_column < 0 or new_column < 0 or len(_source_backed_identity_columns(table, source)) < 2
                    or not _matches_source_audiogram_metric_pairs(table, old_column, new_column, method, metric, baseline, source)):
                continue
            values = [float(row[old_column]) - float(row[new_column])
                      if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', str(row[old_column]))
                      and re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', str(row[new_column])) else math.nan for row in table['rows']]
            if len(values) >= 2 and all(math.isfinite(v) for v in values) and abs(max(values) - float(delta)) < 1e-9:
                return True
    return False


def _has_source_backed_net_interval_negative(results, tables, source_text):
    if _source_evidence_extra_i(results, tables, source_text):
        return False
    raw = str(source_text or '')
    def owns(text, index, body):
        previous = _normalize_local_evidence_heading(text[:index].rstrip(_JS_WHITESPACE).split('\n')[-1])
        joined = previous + '\n' + body
        return _own_observed_source_scope(joined) and not re.search(
            _source_evidence_pattern(r'第三方|外部团队|假定|设想|撤回|不成立|并不|'
            r'\b(?:withdrawn|revoked|not performed|not conducted|false statement)\b'), joined, re.I)
    headings = list(re.finditer(r'^[ \t]*[0-9]+(?:\.[0-9]+)*[ \t]+Net effect[ \t]*\r?\n', raw, re.I | re.M))
    if len(headings) != 1:
        return False
    tail = raw[headings[0].end():headings[0].end() + 12000]
    boundary = re.search(r'^[ \t]*(?:[0-9]+(?:\.[0-9]+)*[ \t]+[A-Z]|#{1,6}[ \t])', tail, re.M)
    block = tail[:boundary.start()] if boundary else tail
    if not owns(raw, headings[0].start(), ''):
        return False
    self_start = re.search(r'Self-correction is less clear\.', block, re.I)
    if not self_start:
        return False
    scope_start = 0
    for line in re.finditer(r'[^\n]+(?:\n|$)', block[:self_start.start()]):
        if re.fullmatch(r'Our measured results:', _normalize_local_evidence_heading(line[0]), re.I):
            scope_start = line.end()
    current = block[scope_start:]
    if not owns('', 0, current):
        return False
    prose = re.sub(_source_evidence_pattern(r'\s+'), ' ', current.replace('−', '-'))
    group = re.search(r'Self-correction is less clear\. ([A-Z]) beats ([A-Z]) on the synthetic corpus', prose, re.I)
    if (not group or group[1] == group[2]
            or not re.search(r'By net WER alone, the audio does nothing for self-correction on natural speech\.', prose, re.I)):
        return False
    signed = r'[+-]?[0-9]+(?:\.[0-9]+)?'
    def interval(name):
        return (r'(?P<' + name + r'>\[(?P<' + name + r'Low>' + signed + r'),[ \t]*(?P<' + name + r'High>'
                + signed + r')\])(?P=' + name + r')?')
    claim = re.search(_source_evidence_pattern(r'On the natural corpora we cannot detect a net difference[ \t]*\([ \t]*'
                      + r'(?P<p1>' + signed + r')(?P=p1)?[ \t]*pt,[ \t]*interval[ \t]*' + interval('i1') + r';[ \t]*'
                      + r'(?P<p2>' + signed + r')(?P=p2)?[ \t]*pt,[ \t]*(?:interval[ \t]*)?' + interval('i2') + r'[ \t]*\)'), prose, re.I)
    if not claim:
        return False
    values = [float(claim['p1']), float(claim['p2'])]
    if not all(math.isfinite(v) for v in values):
        return False
    for index, key in enumerate(['i1', 'i2']):
        low, high = float(claim[key + 'Low']), float(claim[key + 'High'])
        if not math.isfinite(low) or not math.isfinite(high) or not low < 0 < high or not low <= values[index] <= high:
            return False
    primary_match = re.search(_source_evidence_pattern(r'primary corrector is ([^\n\[.]{1,80}(?:\.[0-9]+)?[^\n\[]*)\s*\[[0-9, ]+\]'), raw, re.I)
    primary = primary_match[1].strip(_JS_WHITESPACE) if primary_match else ''
    if not primary or primary not in str(results):
        return False
    captions = list(re.finditer(r'^Table[ \t]+[0-9]+:[ \t]*Effect of the audio,[ \t]*([^:\n]{1,100}):[ \t]*grounded minus text-only\r?\n', raw, re.M))
    natural = [('RuLibri RU', '俄语音频书'), ('Medical EN', '医疗英语')]
    def number_cell(value):
        scalar = re.fullmatch(r'(?:\+\+|−-|--|\+|-|−)?[0-9]+(?:\.[0-9]+)?', str(value))
        return float(re.sub(r'^\+\+', '+', re.sub(r'^(?:−-|--|−)', '-', scalar[0]))) if scalar else math.nan
    bound = []
    for caption in captions:
        if caption[1].strip(_JS_WHITESPACE) != primary:
            continue
        table_tail = raw[caption.end():caption.start() + 20000]
        end = re.search(r'^Table[ \t]+[0-9]+:', table_tail, re.M)
        body = table_tail[:end.start()] if end else table_tail
        if not owns(raw, caption.start(), body):
            continue
        lines = [line.strip(_JS_WHITESPACE) for line in re.split(r'\r?\n', body) if line.strip(_JS_WHITESPACE)]
        header = next((i for i in range(len(lines)) if lines[i:i + 5] == ['rep', 'dam', 'ins', 'net', 'break-rate']), -1)
        expected_group = f'self-correction: {group[1]} (audio) vs. {group[2]} (no audio)'
        group_index = lines.index(expected_group) if expected_group in lines else -1
        if header < 0 or group_index != header + 5 or lines.count(expected_group) != 1:
            continue
        after = lines[group_index + 1:]
        group_end = next((i for i, line in enumerate(after) if re.search(r'^cross-system:', line)), -1)
        rows = after[:group_end] if group_end >= 0 else []
        if (len(rows) == 18 and rows[0] == 'TTS RU'
                and all(rows[(index + 1) * 6] == label and number_cell(rows[(index + 1) * 6 + 4]) == values[index]
                        for index, (label, _) in enumerate(natural))):
            bound.append(caption)
    if len(bound) != 1:
        return False
    matching_tables = []
    for table in tables:
        identity = next((i for i, h in enumerate(table['header']) if re.fullmatch(r'(?:对比|比较|对照)', str(h).strip(_JS_WHITESPACE))), -1)
        net = next((i for i, h in enumerate(table['header']) if re.fullmatch(r'净[ \t]+pt[ \t]*↑', str(h).strip(_JS_WHITESPACE))), -1)
        if identity < 0 or net < 0:
            continue
        def matching_row(index, label):
            rows = [row for row in table['rows'] if row[identity] == f'自我 {group[1]}-{group[2]} {label}']
            return len(rows) == 1 and number_cell(rows[0][net]) == values[index]
        if all(matching_row(index, label) for index, (_, label) in enumerate(natural)):
            matching_tables.append(table)
    if len(matching_tables) != 1:
        return False
    def owner_carrier(value):
        text = _normalize_local_evidence_heading(value)
        if len(text) > 160:
            return None
        for pattern in [r'在[ \t]*(.+?)[ \t]*上[，,]?', r'(.+?)[ \t]*模型[：:]', r'(.+?)[ \t]*的结果如下[：:]', r'(.+?)[ \t]*(?:模型)?的']:
            match = re.fullmatch(_source_evidence_pattern(pattern), text)
            if match and len(match[1].strip(_JS_WHITESPACE)) <= 120:
                return match[1].strip(_JS_WHITESPACE)
        return None
    reported_pattern = (r'^[ \t]*自我校正下(?:合成语料差距为[ \t]*' + signed + r'[ \t]*pt[，,][ \t]*)?'
                        + r'(?:' + re.escape(primary) + r'[ \t]*的[ \t]*)?自然语料净差距为[ \t]*('
                        + signed + r')[ \t]*pt[ \t]*与[ \t]*(' + signed
                        + r')[ \t]*pt[，,][ \t]*区间包含零(?:附近)?[，,][ \t]*单看净[ \t]*WER')
    for sentence in re.finditer(r'[^。；\n]+', str(results or '')):
        previous = _normalize_local_evidence_heading(re.split(r'[。；！？!?]', str(results)[:sentence.start()][-512:].rstrip(_JS_WHITESPACE).split('\n')[-1])[-1])
        pending_owner = owner_carrier(previous)
        if pending_owner and pending_owner != primary:
            continue
        report_start = sentence[0].find('自我校正下')
        if report_start < 0:
            continue
        prefix = sentence[0][:report_start].strip(_JS_WHITESPACE)
        if prefix and owner_carrier(prefix) != primary:
            continue
        statement = sentence[0][report_start:]
        if (not _has_own_local_reported_experiment(results, sentence.start(), sentence[0])
                or not owns(results, sentence.start(), sentence[0])):
            continue
        if _has_adjacent_affirmative_evidence_withdrawal(results, sentence.end(), r'(?<!的)(?:上述|该|这一|前述)(?:净效应|净差距|净[ \t]*WER)?(?:观察|结论|结果)'):
            continue
        reported = re.search(_source_evidence_pattern(reported_pattern), statement, re.I)
        if reported and float(reported[1]) == values[0] and float(reported[2]) == values[1]:
            return True
    return False


def _source_bound_loss_switch_columns(table, source):
    """Only the observed complete eight-variant factorial table types its switches."""
    empty = set()
    if _source_evidence_extra_i(source, table) or len(table['header']) != 4 or len(table['rows']) != 8:
        return empty
    # Quoted HTML/code cannot lend this paper an observed experiment.
    source = _setting_axis_protected_source(source)
    identifier = next((i for i,h in enumerate(table['header']) if re.fullmatch(r'(?:变体|variant|abbrev\.)', str(h).strip(), re.I)), -1)
    controls = [next((i for i,h in enumerate(table['header']) if re.fullmatch(pattern, str(h).strip(), re.I)), -1) for pattern in (
        r'(?:条件注入|conditioning)', r'(?:波形损失归一化|损失归一化|waveform[- ]loss normalization)',
        r'(?:语谱图辅助损失|auxiliary spectrogram loss)')]
    if identifier < 0 or any(i < 0 for i in controls) or any(len(row) != 4 or any(not re.fullmatch(r'(?:是|否)', str(row[i]).strip()) for i in controls) for row in table['rows']):
        return empty
    def denied(text):
        return not _own_observed_source_scope(text) or re.search(
            r'```|~~~|(?:^|\n)\s*[>“”"\'‘’]|\b(?:quoted?|quotation|(?:not|never)\s+(?:actually\s+)?(?:implemented|executed|performed|trained|evaluated)|(?:did|do|does) not (?:actually )?(?:train|evaluate|implement|execute|perform)|abandon(?:ed)?|retract(?:ed)?)\b|\b(?:external|prior|third[- ]party)\s+(?:work|study|paper|experiment)\b|(?:外部研究|第三方|未实际执行|从未执行|没有执行|未实施|未训练|未评估|撤销|撤回)', text, re.I)
    for claim in re.finditer(r'^To isolate the contributions of conditioning, loss normalization, and spectrogram loss, eight model variants are trained and evaluated[^\n]*$', source, re.M):
        reference = re.search(r'The variants are summarized in Table\s+(\d+)\.', claim[0])
        if not reference:
            continue
        before, tail = source[:claim.start()], source[claim.end():]
        if len(re.findall(r'^\s*```[^\n]*$|^\s*~~~[^\n]*$', before, re.M)) % 2:
            continue
        caption = re.search(r'^Table\s+(\d+): Overview of model variants differing in conditioning, waveform-loss normalization, and use of an auxiliary spectrogram loss\.([^\n]*)\n', tail, re.M)
        if not caption or caption[1] != reference[1] or tail[:caption.start()].strip():
            continue
        rest = tail[caption.end():]
        boundary = re.search(r'^(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][^\n]*|(?:Table|Figure)\s+\d+:|Conclusions?|Discussion|References?)\s*$', rest, re.M)
        body = rest[:boundary.start()] if boundary else rest
        next_line = next((line for line in rest[boundary.end():].splitlines() if line.strip()), '') if boundary else ''
        adjacent = re.split(r'(?<=[.!?])\s+(?=[A-Z])', next_line[:400])[0]
        scope = before.strip().split('\n')[-1] + '\n' + claim[0] + '\n' + caption[0] + body + '\n' + adjacent
        if denied(scope):
            continue
        lines = [line.strip() for line in body.splitlines() if line.strip()]
        if len(lines) != 45 or lines[:3] != ['Abbrev.', 'Conditioning', 'Loss Norm.'] or not re.fullmatch(r'LSTFT(?:L_\{\\mathrm\{STFT\}\})?', lines[3]) or lines[4] != 'Description':
            continue
        vectors, names, matches = set(), set(), True
        for i in range(8):
            name, conditioning, normalization, spectrogram = lines[5+i*5:9+i*5]
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9-]*', name) or conditioning not in ('–', 'FiLM') or normalization not in ('–', '✓') or spectrogram not in ('–', '✓'):
                matches = False
                break
            flags = (conditioning == 'FiLM', normalization == '✓', spectrogram == '✓')
            vectors.add(flags); names.add(name)
            if str(table['rows'][i][identifier]).strip() != name or any(str(table['rows'][i][column]).strip() != ('是' if flags[j] else '否') for j,column in enumerate(controls)):
                matches = False
                break
        if matches and len(vectors) == len(names) == 8:
            return set(controls)
    return empty


# Ports only the two observed kernel-setting axes. Neither axis certifies metric
# values or a paper's eligibility; all normal table and scientific gates remain.
def _setting_axis_visible(value):
    value = re.sub(r'\\(?:uparrow|downarrow)', '', str(value or '').replace('$', ''))
    return re.sub(r'\s+', ' ', re.sub(r'[↑↓*_`]', '', value)).strip()


def _setting_axis_protected_source(source):
    source = re.sub(r'```[\s\S]*?```|~~~[\s\S]*?~~~', '\n[quoted material]\n', str(source or ''))
    source = re.sub(r'<(?:blockquote|pre|code)\b[^>]*>[\s\S]*?</(?:blockquote|pre|code)\s*>', '\n[quoted material]\n', source, flags=re.I)
    source = re.sub(r'^[ \t]*>.*$', '[quoted material]', source, flags=re.M)
    return re.sub(r'“[^”]*”|‘[^’]*’|「[^」]*」|"[^"\n]*"|\x27[^\x27\n]*\x27|`[^`\n]*`', '[quoted material]', source)


_SETTING_AXIS_FOREIGN = re.compile(r'^(?:(?:#{1,6}|\d+(?:\.\d+)*)[ .]+)?(?:(?:previous|prior|related|other|third[- ]party)\s+(?:work|research|study|experiment)|hypothetical(?: example| experiment)?|quotation|quoted statement|引述|第三方研究|假设实验)[.:：]?$', re.I)
_SETTING_AXIS_DENIED = re.compile(r'\b(?:if|assuming|suppose|hypothetical|planned|proposed only|not|never|unperformed|unimplemented|withdrawn|revoked|false)\b|\b(?:other|previous|prior|related|third[- ]party|external)\s+(?:authors?|teams?|research|work)\b|第三方|假设|没有|未执行|未实施|撤回|\[quoted material\]', re.I)
_SETTING_AXIS_REVOKED = re.compile(r'^(?:(?:This|That|The (?:preceding|above))\s+(?:(?:experiment|comparison|procedure|study|claim)\s+)?(?:(?:was|is)\s+)?(?:never|not|(?:only )?hypothetical|false|withdrawn)|We\s+(?:never|(?:did|do)\s+not)\s+(?:actually\s+)?(?:conduct|run|perform|implement|compare))', re.I)


def _setting_axis_own_statement(source, pattern):
    match = re.search(pattern, source)
    if not match:
        return False
    opening = source.strip().split('\n')[0]
    if _SETTING_AXIS_FOREIGN.search(opening) or _SETTING_AXIS_DENIED.search(opening):
        return False
    before, after = source[:match.start()], source[match.end():]
    boundaries = list(re.finditer(r'[.!?](?=\s+[A-Z]|\s*$)', before))
    prior = boundaries[-1] if boundaries else None
    start = prior.start()+1 if prior else before.rfind('\n')+1
    end = re.search(r'[.!?](?=\s+[A-Z]|\s*$)', after)
    statement = source[start:match.end()+(end.start() if end else len(after))]
    following = after[end.start()+1:].lstrip() if end else ''
    preceding = before[(boundaries[-2].start() if len(boundaries)>1 else -1)+1:prior.start()+1] if prior else ''
    if _SETTING_AXIS_DENIED.search(statement) or _SETTING_AXIS_DENIED.search(preceding) or _SETTING_AXIS_REVOKED.search(following):
        return False
    for line in reversed(before.split('\n')[-80:]):
        if _SETTING_AXIS_FOREIGN.search(line.strip()):
            return False
        if re.search(r'^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*[ .]+|Appendix\s+[A-Z])\S', line, re.I):
            break
    return True


def _setting_axis_own_table_scope(source, block, reject_prior=None):
    lines = source[:block['index']].rstrip().split('\n')
    sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', block['caption'])
    reject_prior = reject_prior or (lambda line: _SETTING_AXIS_DENIED.search(line))
    if reject_prior(lines[-1] if lines else '') or _SETTING_AXIS_DENIED.search(sentences[0]) or any(_SETTING_AXIS_REVOKED.search(s) for s in sentences[1:]):
        return False
    for line in reversed(lines[-80:]):
        if _SETTING_AXIS_FOREIGN.search(line.strip()):
            return False
        if re.search(r'^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*[ .]+|Appendix\s+[A-Z])\S', line, re.I):
            break
    return True


def _setting_axis_rows_safe(table, width):
    return len(table['header']) == width and all(len(row) == width for row in table['rows'])


def _setting_axis_perturbation_table(block, n):
    if not re.search(r'^Table \d+: Rejections at n='+re.escape(n)+r'(?:n\{=\}'+re.escape(n)+r')? per side\.', block['caption']) or not re.search(r'Music and audio cells give the range over CLaMP\s+2, VGGish and PANNs\.', block['caption']):
        return False
    lines = [line.strip() for line in block['body'].split('\n') if line.strip()]
    if lines[:7] != ['Alternative','Spaces','median','cubic','window','MMDAgg','Fréchet']:
        return False
    cursor = 7
    def take():
        nonlocal cursor
        value = lines[cursor] if cursor < len(lines) else ''; cursor += 1
        return value
    def metrics():
        return all(re.fullmatch(r'(?:[–-]|\d+(?:[–-]\d+)?/\d+(?:[–-]\d+/\d+)?)', take()) for _ in range(5))
    for alternative in ('mean shift','contraction','rotation'):
        if not re.fullmatch(alternative+r', s=0\.1(?:s\{=\}0\.1)?', take()) or take() != 'music, audio' or not metrics() or take() != 'Inception' or not metrics():
            return False
    for alternative in ('rank-2 rotation','rank-1 inflation'):
        if take() != alternative or not re.fullmatch(r'CLaMP\s+2, PANNs', take()) or not metrics() or take() != 'Inception' or not metrics():
            return False
    if take() != 'mode drop, mean-matched' or take() != 'music, audio' or not metrics() or take() != 'mode drop, least-displacing' or take() != 'all five' or not re.fullmatch(r'\d+[–-]\d+/\d+ in every configuration', take()) or not re.fullmatch(r'(?:[–-]|\d+(?:[–-]\d+)?/\d+(?:[–-]\d+/\d+)?)', take()) or take() != 'control' or take() != 'all five' or not re.fullmatch(r'at most \d+/\d+ per cell', take()) or not re.fullmatch(r'(?:[–-]|\d+(?:[–-]\d+)?/\d+(?:[–-]\d+/\d+)?)', take()):
        return False
    return cursor < len(lines) and bool(re.search(r'^\d+\.\d+\s+\S', lines[cursor])) and not _SETTING_AXIS_REVOKED.search(lines[cursor+1] if cursor+1 < len(lines) else '')


def _setting_axis_perturbation(table, source):
    if not _setting_axis_rows_safe(table, 5) or len(table['rows']) != 5:
        return False
    header = re.fullmatch(r'变化[，,]\s*每侧\s*(\d+)', _setting_axis_visible(table['header'][0]))
    if not header or list(map(_setting_axis_visible,table['header'][1:])) != ['中位数高斯','三次核','窄窗口高斯','MMDAgg']:
        return False
    alternatives = {'音乐音频均值平移 s=0.1','音乐音频收缩 s=0.1','音乐音频旋转 s=0.1','Inception 旋转 s=0.1','最小位移模式删除'}
    labels = list(map(lambda row:_setting_axis_visible(row[0]), table['rows']))
    if set(labels) != alternatives or len(set(labels)) != len(labels):
        return False
    n = header[1]
    if not _setting_axis_own_statement(source, r'We apply one known change to an independent sample, and test the two samples with each kernel configuration as a permutation test') or not re.search(r'Unless noted, n='+n+r'(?:n\{=\}'+n+r')?(?:,|\.)',source):
        return False
    captions = list(re.finditer(r'^Table\s+\d+[.:]\s*[^\n]+', source, re.M))
    for i, caption in enumerate(captions):
        block = {'caption':caption[0],'index':caption.start(),'body':source[caption.end():captions[i+1].start() if i+1<len(captions) else len(source)]}
        if _setting_axis_own_table_scope(source,block) and _setting_axis_perturbation_table(block,n):
            return True
    return False


def _setting_axis_sample_size(table, raw_source):
    if not _setting_axis_rows_safe(table,5) or len(table['rows']) != 4 or not re.fullmatch(r'每侧样本量[，,]\s*CIFAR-10\s+旋转\s+s=0\.1',_setting_axis_visible(table['header'][0])) or list(map(_setting_axis_visible,table['header'][1:])) != ['中位数高斯','三次核','窄窗口高斯','MMDAgg']:
        return False
    labels = [_setting_axis_visible(row[0]) for row in table['rows']]
    if set(labels) != {'780','2500','10000','20000'} or len(set(labels)) != 4:
        return False
    source = _setting_axis_protected_source(re.sub(r'“(rotation|real pair)”',r'\1',raw_source))
    if not _setting_axis_own_statement(source,r'We apply one known change to an independent sample, and test the two samples with each kernel configuration as a permutation test'):
        return False
    for caption in re.finditer(r'^A\.\d+ Power against sample size in vision\.[^\n]*$',source,re.M):
        tail = source[caption.end():];boundary=re.search(r'^A\.\d+\s+[^\n]+$',tail,re.M)
        block={'caption':caption[0],'index':caption.start(),'body':tail[:boundary.start()] if boundary else tail}
        if not _setting_axis_own_table_scope(source,block,lambda line:_SETTING_AXIS_REVOKED.search(line.strip()) or re.search(r'^(?:If|Assuming|Suppose|Hypothetical|Not|Never|Other research|Previous (?:work|study)|Third[- ]party|第三方|假设|如果|\[quoted material\])',line.strip(),re.I)) or not re.search(r'Inception embeddings of CIFAR-10 are tested against a pool of 100,000100\{,\}000 DDPM samples\.',block['caption']) or not re.search(r'rotation is matched to the mean shift in 2-Wasserstein distance',block['caption']):
            continue
        lines=[line.strip() for line in block['body'].split('\n') if line.strip()]
        headers=['Arm','Configuration','780780','2,5002{,}500','5,0005{,}000','10,00010{,}000','20,00020{,}000']
        if lines[:len(headers)] != headers:
            continue
        cursor,rotation,valid=len(headers),{},True
        for arm,configs in [('rotation',['median','cubic','window 0.050.05','MMDAgg']),('real pair',['median','cubic','window 0.050.05','MMDAgg']),('control',['median','cubic','window 0.050.05'])]:
            if cursor >= len(lines) or lines[cursor] != arm:
                valid=False;break
            cursor+=1
            for config in configs:
                if cursor >= len(lines) or lines[cursor] != config:
                    valid=False;break
                cursor+=1;values=lines[cursor:cursor+5];cursor+=5
                def bad(value,index):
                    if value == 'n/a':
                        return index in (0,1,2)
                    match=re.fullmatch(r'(\d+)/(\d+)',value)
                    return not match or int(match[2]) != [20,20,20,10,5][index] or int(match[1])>int(match[2])
                if len(values)!=5 or any(bad(v,i) for i,v in enumerate(values)):
                    valid=False;break
                if arm=='rotation':rotation[config]=values
            if not valid:break
        if not valid or cursor>=len(lines):
            continue
        footer=lines[cursor];cursor+=1
        if cursor!=len(lines) or not re.search(r'^Cells marked n/a were not run\.',footer) or not re.search(r'A mean shift of s=0\.1s\{=\}0\.1 is detected in every configuration at every size\.$',footer) or any(_SETTING_AXIS_REVOKED.search(s) for s in re.split(r'(?<=[.!?])\s+(?=[A-Z])',footer)):
            continue
        indexes={'780':0,'2500':1,'10000':3,'20000':4}
        if all(_setting_axis_visible(row[i+1]) == ('未运行' if rotation[config][indexes[_setting_axis_visible(row[0])]]=='n/a' else rotation[config][indexes[_setting_axis_visible(row[0])]]) for row in table['rows'] for i,config in enumerate(['median','cubic','window 0.050.05','MMDAgg'])):
            return True
    return False


def _source_backed_kernel_setting_axes(table, source):
    if _source_evidence_extra_i(source,table):
        return set()
    return {0} if _setting_axis_perturbation(table,_setting_axis_protected_source(source)) or _setting_axis_sample_size(table,source) else set()


def _setting_axis_observed_paragraph_scope(paragraph, result_scope):
    position = result_scope.find(paragraph)
    if position < 0 or result_scope.rfind(paragraph) != position:
        return False
    before,foreign=result_scope[:position],False
    for part in (p.strip() for p in re.split(r'[。！？!?\n]',before)):
        if _SETTING_AXIS_FOREIGN.search(part):foreign=True
        if re.search(r'^(?:#{1,6}\s*)?(?:本研究|本文)(?:独立实验|实测结果|样本量扫描|实验结果|测量结果)[.:：]?$',part):foreign=False
    if foreign or len(re.findall(r'```|~~~',before))%2 or any(len(before.split(q))%2==0 for q in ('"',"'",'`')) or any(len(re.findall('<'+tag+r'\b[^>]*>',before,re.I))>len(re.findall('</'+tag+r'\s*>',before,re.I)) for tag in ('blockquote','pre','code')) or any(before.rfind(op)>before.rfind(cl) for op,cl in [('“','”'),('‘','’'),('「','」'),('<blockquote>','</blockquote>'),('<pre>','</pre>'),('<code>','</code>')]):
        return False
    following=result_scope[position+len(paragraph):].lstrip()
    return not re.search(r'^(?:(?:上述|以上|前述|该|此|这个)(?:样本量)?(?:扫描|比较|实验|结果|结论)[^。\n]{0,30}(?:撤回|撤销|不成立|从未|未(?:实际)?执行|没有(?:实际)?进行)|(?:This|That)\s+(?:(?:result|experiment|comparison)\s+)?(?:was |is )?(?:not|never|(?:only )?hypothetical|withdrawn)|We\s+(?:did not|do not|never)\s+(?:actually\s+)?(?:perform this experiment|compare these models)\b)',following,re.I)


def _source_backed_sample_size_boundary(paragraph,table,source_text,result_scope=None):
    text=str(paragraph or '');result_scope=text if result_scope is None else str(result_scope)
    if _source_evidence_extra_i(text,source_text,result_scope) or not _setting_axis_sample_size(table,source_text) or not _setting_axis_observed_paragraph_scope(text,result_scope) or re.search(r'假设|假想|如果|若|可能|预计|计划|未来|第三方|他人|先前研究|相关工作|外部研究|引用|引述|转述|撤回|撤销|否认|未实测|未报告|没有进行|未(?:实际)?(?:进行|执行|实施)|从未|不是本研究|```|~~~|[“”「」"\'`]|(?:^|\n)\s*>|</?(?:blockquote|pre|code)\b|\b(?:if|assuming|hypothetical|not|never|previous work|other study|quoted|withdrawn|retracted)\b',text,re.I):
        return False
    return bool(re.search(r'中位数带宽[^。]{0,30}780\s*时\s*3/20[^。]{0,30}10000\s*起每次拒绝',text) and re.search(r'窄窗口与聚合检验[^。]{0,20}2500\s*起每次检出旋转',text) and re.search(r'三次核[^。]{0,20}10000\s*为\s*2/10[、，,]\s*20000\s*为\s*2/5',text) and re.search(r'(?:不据此建立高功效趋势|不能推广为三次核的高功效区间)',text))


def _source_backed_identity_columns(table, source_text):
    raw_source = str(source_text or '')
    source = re.sub(r'\s+', '', raw_source)
    captions = list(re.finditer(r'(?:^|\n)(?:Table\s+(?:[A-Z]?\d+|[IVXLCDM]+)|表\s*\d+)\s*[:：]', raw_source, re.I))
    blocks = []
    for index, match in enumerate(captions):
        block = raw_source[match.start():min(captions[index + 1].start() if index + 1 < len(captions) else len(raw_source), match.start() + 20000)]
        heading = re.search(r'(?:^|\n)\s*(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][^\n]{0,100}|(?:conclusions?|discussion|references?|appendix)(?:[ :：][^\n]{0,80})?)(?:\n|$)', block, re.I)
        blocks.append(block[:heading.start()] if heading else block)
    # Audiogram/signal are paired categorical axes only for this observed table.
    hearing_captions = list(re.finditer(_source_evidence_pattern(
        r'(?:^|\n)(?:Table\s+(?:[A-Z]?\d+|[IVXLCDM]+)|表\s*\d+)\s*[:：]'), raw_source, re.I))
    audiogram = next((index for index, header in enumerate(table['header'])
                      if re.fullmatch(r'(?:听力图|audiograms?)', str(header).strip(_JS_WHITESPACE), re.I)), -1)
    signal = next((index for index, header in enumerate(table['header'])
                   if re.fullmatch(r'(?:信号|signals?)', str(header).strip(_JS_WHITESPACE), re.I)), -1)
    music_signal = {'紧凑': 'Tight', '常规': 'Normal', '动态': 'Dynamic'}
    paired_audiogram_signals = False
    if (audiogram >= 0 and signal >= 0 and len(table['rows']) >= 2
            and not _source_evidence_extra_i(raw_source, table)):
        for caption_index, match in enumerate(hearing_captions):
            caption = next((line for line in raw_source[match.start():].split('\n') if line.strip(_JS_WHITESPACE)), '')
            preceding = [line for line in raw_source[:match.start()].split('\n') if line.strip(_JS_WHITESPACE)]
            prefix = preceding[-1] if preceding else ''
            if (not re.search(r'Optimization results for profiles [^\n]{1,100}with limited residual DR', caption, re.I)
                    or not _own_observed_source_scope(prefix + '\n' + caption)):
                continue
            body = raw_source[match.start():min(hearing_captions[caption_index + 1].start()
                if caption_index + 1 < len(hearing_captions) else len(raw_source), match.start() + 20000)]
            def has_pair(row):
                profile = re.fullmatch(_source_evidence_pattern(r'([A-Z][0-9]{1,2})\s+有限范围'), str(row[audiogram] if audiogram < len(row) else '').strip(_JS_WHITESPACE))
                music = music_signal.get(str(row[signal] if signal < len(row) else '').strip(_JS_WHITESPACE))
                if not profile or not music:
                    return False
                begin = re.search(_source_evidence_pattern(r'(?:^|\n)' + re.escape(profile[1]) + r' with limited DR\r?\n'), body)
                if not begin:
                    return False
                tail = body[begin.end():]
                end = re.search(_source_evidence_pattern(r'(?:^|\n)(?:[A-Z][0-9]{1,2} with limited DR|Fig\.|Table\s+[0-9]+:)'), tail)
                return bool(re.search(_source_evidence_pattern(r'(?:^|\n)' + music + r'(?:\r?\n|$)'), tail[:end.start()] if end else tail))
            if all(has_pair(row) for row in table['rows']):
                paired_audiogram_signals = True
                break
    columns = (_source_bound_loss_switch_columns(table, raw_source)
               | _source_backed_kernel_setting_axes(table, raw_source))
    for index, header in enumerate(table['header']):
        if len(table['rows']) < 2:
            continue
        if paired_audiogram_signals and index in (audiogram, signal):
            columns.add(index)
            continue
        labels = [str(row[index] if index < len(row) else '').strip() for row in table['rows']]
        if str(header).strip() == '来源':
            complete_labels = all(1 <= len(label) <= 80 and any(character.isalpha() for character in label) for label in labels)
            for block in blocks:
                lines = set(line.strip() for line in block.split('\n'))
                if complete_labels and 'Source' in lines and all(label in lines for label in labels):
                    columns.add(index)
            continue
        if not re.fullmatch(r'(?:损失|loss)', str(header).strip(), re.I):
            continue
        matches = [re.fullmatch(r'\$?(\\mathcal\{L\}_\{\\(?:text|mathrm)\{[A-Za-z]{1,24}\}\})\$?', label) for label in labels]
        if all(match and match[1] in source for match in matches):
            columns.add(index)
    return columns


def _has_reported_experiment_phrase(text, pattern):
    for match in re.finditer(pattern, text):
        prefix = re.split(r'[。！？；\n]', text[max(0, match.start() - 60):match.start()])[-1]
        if not re.search(r'(?:并非|不是|未能|没有|尚未|未曾|不能|不应|如果|假设|假如|倘若|若|未|不|计划|讨论|建议|拟|将|未来|有待|打算|设想)[^，,]{0,30}$', prefix):
            return True
    return False


def _has_source_backed_presence_comparison(results, tables, source_text):
    # Mirror the Node recognition of measured absence/presence comparisons.
    denied = (
        r'\b(?:if|suppos(?:e|ing)|hypothetical)\b|'
        r'\b(?:future|planned|proposed)\s+(?:experiments?|work|evaluation|validation)\b|'
        r'\b(?:should|must|needs?\s+to)\s+(?:compare|report|score|require|validate)\b|'
        r'\b(?:previous|related|other)\s+(?:work|stud(?:y|ies)|models?|systems?)\b|'
        r'\b(?:does|do|did)\s+not\s+(?:identify|explain)\s+why\b|'
        r'\b(?:not|never)\s+(?:observed|reported|obtained)\b|'
        r'如果|假设|假想|计划|未来实验|后续实验|相关工作|先前研究|其他模型|他人|错误说法|'
        r'并非|不是|未报告|尚未报告|未观察到|没有观察到|否认|'
        r'\b(?:hypothes(?:is|izes?|ized)|hypothetical|illustrative|proposed only|not our experiment|'
        r'(?:previous|other|related)\s+(?:paper|work|study|method)|(?:did|do|does) not conduct|'
        r'no ablation experiment|not performed|not conducted|withdrawn|revoked|false statement)\b|'
        r'(?:^|\n)\s*[>“"]|他人|其他研究|转述|撤回|不是本研究|'
        r'假定|假如|倘若|设想|该研究|该论文|文献|据报告|(?:^|[，,:：\s])若(?=无)|'
        r'(?:拟|预计|将来)[^。；\n]{0,24}无|\bIn\s*\[[\d,–— -]+\]|'
        r"\b[A-Z][A-Za-z'-]+\s+et\s+al\.|\baccording\s+to\b"
    )
    for match in re.finditer(r'无([\u4e00-\u9fffA-Za-z]{1,12})时([^。；\n]{1,300})[。；]\s*有\1后[^。；\n]{1,300}', results):
        context = re.split(r'\n\s*\n', results[:match.start()])[-1] + match[0]
        if re.search(denied, context, re.I):
            continue
        comparison = r'(?:比较|对比)[^。；\n]{0,60}无' + re.escape(match[1]) + r'的[^。；\n]{0,40}与'
        if not _has_reported_experiment_phrase(results, comparison):
            continue
        values = re.findall(r'(?<![\d.])\d+(?:\.\d+)?%', match[2])
        def row_pair_matches(table):
            columns = [column for column, header in enumerate(table['header'])
                       if re.search(r'%|百分', str(header))]
            rows = [[str(cell).strip().removesuffix('%') for cell in row] for row in table['rows']]
            return any(first != second and all(any(
                before[column] == values[index][:-1] and after[column] == values[index + 1][:-1]
                for column in columns) for index in range(0, len(values), 2))
                for first, before in enumerate(rows) for second, after in enumerate(rows))
        if len(set(values)) < 2 or len(values) % 2 or not any(row_pair_matches(table) for table in tables):
            continue
        source_lines = source_text.splitlines()
        for index, line in enumerate(source_lines):
            context = ((source_lines[index - 1][-300:] if index else '') + '\n' + line + '\n'
                       + (source_lines[index + 1][:400] if index + 1 < len(source_lines) else ''))
            if (not re.search(denied, context, re.I) and re.search(r'\bwithout\b', line, re.I)
                    and all(re.search(r'(?<![\d.])' + re.escape(value), line) for value in values)):
                return True
    return False


def _has_source_backed_training_stage_ablation(tables, source_text):
    source = str(source_text or '')
    removal = re.compile(
        r'\b(?:w/?o|without)\s+(?:the\s+)?(?:two[- ]stage\s+training\b|second[- ]stage\s+(?:training|fine[- ]tuning)\b)',
        re.I,
    )
    supported = any(not re.search(
        r'\b(?:no|not|never|plans?|planning|planned|propos(?:e|ed)|hypothetical|may|might|could|would|future)\b[^.;\n]{0,80}$',
        source[max(0, match.start() - 100):match.start()], re.I,
    ) for match in removal.finditer(source))
    if not supported:
        return False
    return any(
        _is_table_identifier_header(re.sub(r'[*_`]', '', str(header)).strip())
        and any(re.fullmatch(r'(?:无|省略)第(?:二|2)阶段(?:训练|微调)',
            re.sub(r'[*_`]', '', str(row[column] if column < len(row) else '')).strip())
            for row in table['rows'])
        for table in tables for column, header in enumerate(table['header'])
    )


def _has_source_backed_zero_correction_ablation(results, source_text):
    source = re.sub(r'\s+', ' ', str(source_text or ''))
    sweep = re.search(r'Role of bidirectional correction\.[\s\S]{0,500}?isolates the correction signal[\s\S]{0,500}?varying only[\s\S]{0,500}?without correction', source, re.I)
    if not sweep or re.search(r'\b(?:future|planned|hypothetical)\b', sweep[0], re.I):
        return False
    for match in re.finditer(r'修正权重\s*为\s*0(?:\.0+)?\s*时\s*(Total)\s*最高\s*[,，]\s*为\s*(\d+(?:\.\d+)?)', results, re.I):
        prefix = results[max(0, match.start() - 60):match.start()]
        if (not re.search(r'(?:如果|假设|计划|未来|可能|预计|并非|不是)[^。；\n]{0,50}$', prefix)
                and re.search(r'λcorr\s+Quality\s+Semantic\s+Total', sweep[0], re.I)
                and re.search(rf'(?:^| )0 +[0-9.]+ +[0-9.]+ +{re.escape(match[2])}(?![0-9.])', sweep[0])):
            return True
    return False


def _has_table_bound_higher_metric_regression(results, tables, source_text):
    prose = '\n'.join(line for line in results.split('\n') if not re.match(r'\s*\|', line))
    denied = r'(?:如果|假设|计划|未来|可能|预计|并非|不是|没有)[^。；\n]{0,50}$'
    source_lines = str(source_text or '').split('\n')
    grouped_tables = []
    for line_index, line in enumerate(source_lines):
        if not re.match(r'\s*Method\s+NFE\s+', line, re.I):
            continue
        caption_context = ' '.join(source_lines[max(0, line_index - 6):line_index])
        if (not re.search(r'\bTable\s+(?:\d+|[IVXLCDM]+)[.:：]', caption_context, re.I)
                or re.search(r'\b(?:hypothetical|future|planned|illustrative|example)\b', caption_context, re.I)):
            continue
        groups = list(re.finditer(r'\b[A-Za-z][A-Za-z0-9_.-]{1,50}\s*↑', line))
        if not groups:
            continue
        leaf_headers = line[groups[-1].end():].strip().split()
        if (not 2 <= len(leaf_headers) <= 12
                or not all(re.fullmatch(r'[A-Za-z][A-Za-z0-9_.-]{0,30}', name) for name in leaf_headers)):
            continue
        rows = []
        for row_line in source_lines[line_index + 1:line_index + 41]:
            row = re.fullmatch(r'\s*(\S(?:.*?\S)?)\s+(\d+(?:\.\d+)?(?:\s*(?:×|x)\s*\d+)?(?:\s+\d+(?:\.\d+)?){2,})\s*', row_line)
            if not row:
                break
            values = re.findall(r'\d+(?:\.\d+)?', row[2])
            minimum = len(leaf_headers) + len(groups)
            if len(values) != minimum + (1 if re.search(r'\s[×x]\s', row[2]) else 0):
                break
            rows.append([row[1], *values[-len(leaf_headers):]])
        if len(rows) >= 2:
            grouped_tables.append({'header': ['Method', *[f'{name} ↑' for name in leaf_headers]], 'rows': rows, 'source_grouped': True})
    def central_value(cell):
        match = re.match(r'\s*(\d+(?:\.\d+)?)(?:\s|$|±)', str(cell or ''))
        return float(match[1]) if match else None
    for table in [*tables, *grouped_tables]:
        for column, header in enumerate(table['header']):
            metric = re.sub(r'(?:↑|\\uparrow)', '', re.sub(r'[*_`$]', '', str(header))).strip()
            if (not re.fullmatch(r'[A-Za-z][A-Za-z0-9.-]{1,30}', metric)
                    or not re.search(r'(?:↑|\\uparrow)', header)
                    or (not table.get('source_grouped') and not re.search(rf'\b{re.escape(metric)}[\s($]*(?:↑|\\uparrow)', source_text, re.I))):
                continue
            pattern = rf'\b{re.escape(metric)}(?![A-Za-z0-9_-])[^。；\n]{{0,60}}?(?:为|是)\s*(\d+(?:\.\d+)?)\s*[,，]\s*(?:略|明显|显著)?低于\s*([^，。；\n]{{1,60}}?)\s*的\s*(\d+(?:\.\d+)?)'
            for match in re.finditer(pattern, prose, re.I):
                prefix = prose[max(0, match.start() - 60):match.start()]
                if (re.search(denied, prefix)
                        or re.search(r'如果|假设|计划|未来|可能|预计|并非|不是|没有', match[0])
                        or not float(match[1]) < float(match[3])):
                    continue
                first = next((row for row in table['rows'] if column < len(row) and central_value(row[column]) == float(match[1])), None)
                second = next((row for row in table['rows'] if column < len(row) and central_value(row[column]) == float(match[3])
                    and any(index != column and _is_table_identifier_header(table['header'][index])
                        and re.sub(r'^Teacher$', '教师', re.sub(r'[*_`]', '', str(cell)).strip(), flags=re.I)
                            == re.sub(r'^Teacher$', '教师', match[2].strip(), flags=re.I)
                        for index, cell in enumerate(row))), None)
                if first is not None and second is not None and first is not second:
                    return True
    return False


def _has_source_backed_reward_switch_ablation(results, tables, source_text):
    if not re.search(r'\bablation\b', source_text, re.I) or not re.search(r'\brewards?\b', source_text, re.I):
        return False
    transitions = []
    for sentence in re.split(r'[。；\n]', results):
        if re.search(r'(?:他人|其他模型|另一(?:个|种)(?:模型|系统)|无关(?:模型|系统)|否定|驳斥|转述)|(?:说法|表述|观点|判断)[^。；\n]{0,20}(?:错误|有误|不成立|不正确)', sentence):
            continue
        if re.search(r'(?:假设|假想|如果|计划|未来|预计|可能|先前工作|相关工作|此前研究|并非|不是|没有|尚未|未曾|未|不|是否|尚无|未知|待评估|值得|有待|否认|反驳|引用|引述|错误说法|[?？])', sentence):
            continue
        match = re.search(r'(?:加入|只开|开启|关闭|移除|去掉)[^。；\n]{1,30}奖励[^。；\n]{0,120}(?:从|由)\s*([0-9]+(?:\.[0-9]+)?)%?\s*(?:升至|降至|升到|降到)\s*([0-9]+(?:\.[0-9]+)?)%?', sentence)
        if match:
            transitions.append((float(match[1]), float(match[2])))
    if not transitions:
        return False

    def state(cell):
        text = str(cell).strip()
        return 1 if text in {'✓', '✔'} else 0 if text in {'-', '—', '✗', '×'} else None

    def value(cell):
        match = re.fullmatch(r'\s*([0-9]+(?:\.[0-9]+)?)%?\s*', str(cell))
        return match[1] if match else None

    lines = [line.strip() for line in source_text.splitlines() if line.strip()]
    for table in tables:
        controls = [index for index, header in enumerate(table['header']) if re.fullmatch(r'R[a-z]{2,12}', str(header).strip())]
        identifier = next((index for index, header in enumerate(table['header']) if _is_table_identifier_header(str(header).strip())), -1)
        if len(controls) < 2 or identifier < 0 or any(
                r'\mathrm{' + str(table['header'][column]).strip()[1:] + '}' not in source_text
                and 'ℛ' + str(table['header'][column]).strip()[1:] not in source_text for column in controls):
            continue
        labels = {str(row[identifier]).strip() for row in table['rows']}

        def matches_source(row):
            for index, line in enumerate(lines):
                if line != str(row[identifier]).strip():
                    continue
                end = index + 1
                while end < len(lines) and lines[end] not in labels:
                    end += 1
                body = lines[index + 1:end]
                if any(state(row[column]) is None or offset >= len(body) or state(body[offset]) != state(row[column])
                       for offset, column in enumerate(controls)):
                    continue
                if all(column == identifier or column in controls or (value(cell) is not None and value(cell) in body)
                       for column, cell in enumerate(row)):
                    return True
            return False

        for index, first in enumerate(table['rows']):
            for second in table['rows'][index + 1:]:
                if first[identifier] == second[identifier] and matches_source(first) and matches_source(second) \
                        and sum(state(first[column]) != state(second[column]) for column in controls) == 1 \
                        and any(column != identifier and column not in controls
                                and value(first[column]) is not None and value(second[column]) is not None
                                and float(value(first[column])) != float(value(second[column]))
                                and any((start == float(value(first[column])) and end == float(value(second[column])))
                                        or (end == float(value(first[column])) and start == float(value(second[column])))
                                        for start, end in transitions) for column in range(len(table['header']))):
                    return True
    return False


def _has_source_backed_component_switch_ablation(results, source_text=''):
    """原文写「加入/引入某组件后指标从 A 升到 B」时，保留同表两值的组件对照就算消融。

    与 scripts/analysis-contract.js 的 hasSourceBackedComponentSwitchAblation 同规则：
    句子里必须有开关动作 + 组件名 + 同一句内的数值变化，且两个数值都能在原文找到。
    """
    source = str(source_text or '')
    denied = re.compile(
        r'(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|讨论|提及|建议|拟|并非|不是|没有|未|不能|不会|他人|第三方|先前(?:研究|工作)|相关工作|引用|引述|转述)')
    switch_pattern = re.compile(
        r'(?:加入|引入|启用|加回|关闭|冻结|去掉|移除|去除)[^。；，,\n]{0,12}?(?:分支|模块|组件|编码器|解码器|损失项?|约束|适配器|监督)')
    change_pattern = re.compile(
        r'从\s*([-+]?\d+(?:\.\d+)?)\s*[A-Za-z%]{0,6}\s*(?:升至|降至|变为|升到|降到)\s*([-+]?\d+(?:\.\d+)?)')
    for sentence in re.split(r'[。；\n]', str(results or '')):
        text = sentence.strip()
        if not text or denied.search(text) or not switch_pattern.search(text):
            continue
        change = change_pattern.search(text)
        if not change or float(change.group(1)) == float(change.group(2)):
            continue
        if not source:
            return True
        if all(re.search(r'(?<![0-9.])' + re.escape(value) + r'(?![0-9])', source)
               for value in (change.group(1), change.group(2))):
            return True
    return False


def _source_bound_matched_acoustic_gap(results, tables, source_text):
    """Replay the same source-owned matched comparison as the Node gate."""
    if _source_evidence_extra_i(results, source_text) or re.search(
            r'```|~~~|(?:^|\n)\s*>|<(?:blockquote|pre|code)\b', str(results or ''), re.I):
        return False

    def quoted(value):
        return (value.rfind('“') > value.rfind('”')
                or value.rfind('‘') > value.rfind('’')
                or len(re.findall(r'(?<!\\)"', value)) % 2 == 1)

    source = str(source_text or '')
    pattern = (r'\b([A-Z][A-Za-z0-9_-]{1,40}) produces recognizable isolated coda-like sounds\s*'
               r'(?:\[[0-9]+\])?\.\s*Yet its generated recordings remain distinguishable from natural codas in '
               r'(one|two|three|four|five|six|seven|eight|nine|ten) of '
               r'(one|two|three|four|five|six|seven|eight|nine|ten) acoustic descriptions, '
               r'including after the strictest matching on measured recording properties '
               r'\(Fig\.\s*[0-9]+; exact estimates in the Supplement\)\.\s*That matched comparison uses '
               r'([1-9][0-9]*) generated clips and (one|two|three|four|five|six|seven|eight|nine|ten) '
               r'independent natural reference groups\.')
    cardinals = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    for match in re.finditer(_source_evidence_pattern(pattern), source):
        name, positive_word, total_word, clips, groups_word = match.groups()
        positive, total, groups = map(cardinals.index, (positive_word, total_word, groups_word))
        if (positive <= 0 or positive > total or groups < 2
                or not _unquoted_observed_comparison(source, match.start(), match[0])):
            continue
        before = source[:match.start()]
        prefix = before.split('\n')[-1]
        previous = _normalize_local_evidence_heading(before[:before.rfind('\n')].rstrip(_JS_WHITESPACE).split('\n')[-1] if '\n' in before else '')
        following = re.split(r'\n\s*\n', source[match.end():], maxsplit=1)[0]
        revoked = (r'(?:(?:this|that|the (?:above|preceding|matched))\s+(?:comparison|result|experiment|test)'
                   r'[^.!?]{0,100}\b(?:never|not\s+(?:actually\s+)?(?:performed|conducted|observed)|false|'
                   r'incorrect|withdrawn|retracted)\b|(?:this|that)\s+(?:was|is)\s+(?:never|not|only hypothetical)\b|'
                   r'we\s+(?:did|do|have|will)\s+not\s+(?:actually\s+)?(?:perform|conduct|run|observe)\s+'
                   r'(?:this|that|the (?:above|preceding|matched))\s+(?:comparison|result|experiment|test)\b)')
        fenced = sum(bool(re.search(r'^\s*(?:```|~~~)', line)) for line in before.split('\n')) % 2 == 1
        html_start = max(before.rfind('</blockquote>'), before.rfind('</pre>'), before.rfind('</code>')) + 1
        if (not _own_observed_source_scope(prefix + '\n' + match[0])
                or re.search(r'[“”‘’"]|(?:^|\s)>', prefix) or quoted(before)
                or re.fullmatch(_source_evidence_pattern(r'(?:(?:previous|prior|related|third[- ]party|other)\s+'
                                  r'(?:work|research|study)|quoted statement|quotation|hypothetical example)[.:]?'), previous, re.I)
                or fenced or re.search(_source_evidence_pattern(revoked), following, re.I)
                or re.search(r'<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$', before[html_start:], re.I)):
            continue
        reported = False
        for fragment in re.finditer(r'[^。；\n]+', str(results)):
            sentence = fragment[0]
            if not _unquoted_observed_comparison(results, fragment.start(), sentence):
                continue
            if quoted(str(results)[:fragment.start()]) or re.search(
                    r'假设|如果|未来|计划|预计|可能|第三方|他人|先前研究|相关工作|引用|引述|转述|并非|并未|不是|'
                    r'未曾|未(?:实际)?(?:观测|观察|测得|发现|报告|执行|进行|比较)|没有|尚未|否认|撤回|错误|[“”‘’"?？]', sentence):
                continue
            measured = re.search(r'([1-9][0-9]*)\s*个孤立生成片段在\s*([1-9][0-9]*)\s*种固定声学描述中有\s*'
                                 r'([1-9][0-9]*)\s*种仍可与自然\s*coda\s*区分', sentence)
            if measured and measured[1] == clips and int(measured[2]) == total and int(measured[3]) == positive:
                reported = True
                break
        if not reported:
            continue
        for table in tables:
            contrast = next((i for i, header in enumerate(table['header']) if str(header).strip(_JS_WHITESPACE) == '数据与对照'), -1)
            count = next((i for i, header in enumerate(table['header']) if re.fullmatch(
                r'可区分描述数\s*/\s*' + str(total), str(header).strip(_JS_WHITESPACE))), -1)
            if contrast >= 0 and count >= 0 and any(
                    str(row[0]).strip(_JS_WHITESPACE) == '自然与 ' + name
                    and str(row[count]).strip(_JS_WHITESPACE) == str(positive)
                    and re.fullmatch(clips + r'\s*个生成片段[，,]\s*' + str(groups)
                                     + r'\s*个独立自然参照组[，,]\s*严格匹配', str(row[contrast]).strip(_JS_WHITESPACE))
                    for row in table['rows']):
                return True
    return False


def _unquoted_observed_comparison(text, index, body):
    raw = str(text or '')
    before = raw[:index]
    prefix = before[before.rfind('\n') + 1:]
    previous = _normalize_local_evidence_heading(before[:before.rfind('\n')].rstrip(_JS_WHITESPACE).split('\n')[-1])
    quoted = (before.rfind('“') > before.rfind('”') or before.rfind('‘') > before.rfind('’')
              or len(re.findall(r'(?<!\\)"', before)) % 2 == 1)
    fenced = sum(bool(re.search(r'^\s*(?:```|~~~)', line)) for line in before.split('\n')) % 2 == 1
    html_start = max(before.rfind('</blockquote>'), before.rfind('</pre>'), before.rfind('</code>')) + 1
    continuation = re.sub(r'^[\s，,;.。；]+', '', raw[index + len(body):])[:500]
    local = re.sub(r'(?<=[A-Za-z])’(?=[A-Za-z])', '', prefix + body)
    return (not _source_evidence_extra_i(text, body) and not quoted and not fenced
            and not re.search(r'[“”‘’"]|(?:^|\s)>', local)
            and not re.search(r'<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$', before[html_start:], re.I)
            and not re.fullmatch(_source_evidence_pattern(r'(?:(?:previous|prior|related|third[- ]party|other)\s+'
                                 r'(?:work|research|study)|quoted statement|quotation|hypothetical example|'
                                 r'引用|引述|转述|相关工作|先前研究|第三方|他人)[.:：]?'), previous, re.I)
            and _own_observed_source_scope(previous)
            and _own_observed_source_scope(prefix + '\n' + body)
            and not re.search(r'(?:假定|设想|转述|引述|引用|否认|驳斥|未进行|未执行|未比较|未发现|没有|不成立|错误|[?？])', prefix + body)
            and not re.search(_source_evidence_pattern(r'^(?:(?:this|that|the above)\s+'
                              r'(?:comparisons?|results?|claims?|experiments?|ablations?|tests?)[^.!?]{0,80}(?:withdrawn|revoked|false|incorrect|'
                              r'not (?:performed|observed))|(?:上述|以上|前述|该|此)(?:比较|结果|说法|结论|实验|消融)'
                              r'[^。；\n]{0,30}(?:撤回|错误|不成立|未观测|未进行))'), continuation, re.I))


def _observed_adverse_comparison(text, index, body):
    # A complete quoted source can contain nested quote pairs of its own.
    raw = str(text or '')
    previous = raw[:index].rstrip(_JS_WHITESPACE).split('\n')[-1]
    return (not re.search(r'^\s*[“"]', raw)
            and not re.search(r'(?:^|[.!?]\s+)(?:quoted statement|quotation|hypothetical example)[.:：]?$', previous, re.I)
            and _unquoted_observed_comparison(raw, index, body))


def _source_bound_listening_score_regression(results, tables, source_text):
    """Require the observed listening contrast and its same-study source/display rows."""
    source = str(source_text or '')
    captions = list(re.finditer(r'^Table\s+[0-9]+: Listening results for cross-content transfer \(similarity to the reference, 0[–-]100\)\.$', source, re.M))
    if len(captions) != 1 or not _observed_adverse_comparison(source, captions[0].start(), captions[0][0]):
        return False
    caption = captions[0]
    tail = source[caption.end():caption.start() + 4500]
    end = tail.find('\nIn Study 1,')
    if end < 0:
        return False
    lines = [line.strip(_JS_WHITESPACE) for line in tail[:end].split('\n') if line.strip(_JS_WHITESPACE)]
    header = lines.index('Condition') if 'Condition' in lines else -1
    if (header < 2 or not re.search(r'^Study 1 \(N=', lines[header - 2])
            or not re.search(r'^Study 3 \(N=', lines[header - 1])
            or lines[header:header + 6] != ['Condition', 'Mean', 'SD', '95% CI', 'Mean', 'SD']):
        return False
    cells = lines[header + 6:]
    if len(cells) != 18 or cells[0] != 'Adversarially fine-tuned' or cells[6] != 'Unprocessed' or cells[12] != 'Reconstruction only':
        return False
    def scalar(value):
        return float(value) if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', value) else None
    input_score, reconstruction = scalar(cells[7]), scalar(cells[13])
    if input_score is None or reconstruction is None or reconstruction >= input_score:
        return False
    observed = r'Listeners rated the reconstruction-only decoder below the unprocessed input, although[^\n]*\.'
    if not any(caption.start() < match.start() < caption.start() + 4500
               and _observed_adverse_comparison(source, match.start(), match[0]) for match in re.finditer(observed, source)):
        return False
    def clean(value):
        return re.sub(r'[*_`]', '', str(value or '')).strip(_JS_WHITESPACE)
    bound = False
    for table in tables:
        columns = [i for i, value in enumerate(table['header']) if re.fullmatch(r'Study\s+1\s+均值\s*↑', clean(value))]
        identity = [i for i, value in enumerate(table['header']) if clean(value) == '条件']
        if len(columns) != 1 or len(identity) != 1:
            continue
        first = [row for row in table['rows'] if clean(row[identity[0]]) == '只重建']
        second = [row for row in table['rows'] if clean(row[identity[0]]) == '未处理输入']
        if (len(first) == len(second) == 1 and scalar(clean(first[0][columns[0]])) == reconstruction
                and scalar(clean(second[0][columns[0]])) == input_score):
            bound = True
    if not bound:
        return False
    for fragment in re.finditer(r'[^。；\n]+', str(results)):
        match = re.search(r'只重建[^。；\n]{0,160}?听感均值\s*([0-9]+(?:\.[0-9]+)?)\s*反而低于输入的\s*([0-9]+(?:\.[0-9]+)?)', fragment[0])
        if (match and float(match[1]) == reconstruction and float(match[2]) == input_score
                and _observed_adverse_comparison(results, fragment.start(), fragment[0])):
            return True
    return False


def _source_bound_rendered_duration_shortfall(results, tables, source_text):
    """A measured target shortfall, bound by locale, not a minus sign or a plan."""
    source = str(source_text or '')
    captions = list(re.finditer(r'^TABLE\s+[IVXLCDM0-9]+: Pilot Measurement: Five Published Stories \(([0-9]+(?:\.[0-9]+)?)-min Target\)$', source, re.M))
    if len(captions) != 1 or not _observed_adverse_comparison(source, captions[0].start(), captions[0][0]):
        return False
    caption = captions[0]
    target = float(caption[1])
    if target <= 0:
        return False
    tail = source[caption.end():caption.start() + 3500]
    end = tail.find('\nV-C Behavioral telemetry')
    if end < 0:
        return False
    lines = [line.strip(_JS_WHITESPACE) for line in tail[:end].split('\n') if line.strip(_JS_WHITESPACE)]
    if lines[:6] != ['Lang.', 'Rendered (min)', 'Error', 'LUFS', 'TP (dBTP)', 'LRA (LU)'] or len(lines) != 36:
        return False
    def scalar(value):
        normalized = value.replace('−', '-').replace('\\%', '%')
        match = re.fullmatch(r'([+-]?[0-9]+(?:\.[0-9]+)?)(%?)(?:([+-]?[0-9]+(?:\.[0-9]+)?)(%?))?', normalized)
        if not match or match[3] and (float(match[1]) != float(match[3]) or match[2] != match[4]):
            return None
        return float(match[1])
    rows = {}
    for i in range(6, len(lines), 6):
        if lines[i] not in ['en', 'de', 'fr', 'hi', 'ja'] or lines[i] in rows or any(scalar(value) is None for value in lines[i + 1:i + 6]):
            return False
        rows[lines[i]] = [scalar(lines[i + 1]), scalar(lines[i + 2])]
    observed = (r'Rendered duration, which no gate checks, was within [0-9]+% of target for English and German but '
                r'([0-9]+)%, ([0-9]+)%, and ([0-9]+)% short for French, Japanese, and Hindi\.')
    order = ['fr', 'ja', 'hi']
    if not any(match.start() < caption.start() < match.start() + 2500
               and _observed_adverse_comparison(source, match.start(), match[0])
               and all(rows[language][0] < target and rows[language][1] < 0
                       and int(-rows[language][1] + 0.5) == int(match[i + 1]) for i, language in enumerate(order))
               for match in re.finditer(observed, source)):
        return False
    def clean(value):
        return re.sub(r'[*_`]', '', str(value or '')).strip(_JS_WHITESPACE)
    bound = False
    for table in tables:
        def find(pattern):
            return [i for i, value in enumerate(table['header']) if re.fullmatch(pattern, clean(value))]
        identity, duration, error = find(r'语言'), find(r'渲染时长\s*\(min\)'), find(r'时长误差\s*↓')
        if any(len(columns) != 1 for columns in [identity, duration, error]) or len(table['rows']) != 5:
            continue
        def matches(language, values):
            selected = [row for row in table['rows'] if clean(row[identity[0]]) == language]
            return (len(selected) == 1 and scalar(clean(selected[0][duration[0]])) == values[0]
                    and clean(selected[0][error[0]]).endswith('%') and scalar(clean(selected[0][error[0]])) == values[1])
        if all(matches(language, values) for language, values in rows.items()):
            bound = True
    if not bound:
        return False
    for fragment in re.finditer(r'[^。；\n]+', str(results)):
        match = re.search(r'法语、日语、印地语分别短\s*([0-9]+(?:\.[0-9]+)?)%、\s*([0-9]+(?:\.[0-9]+)?)%\s*和\s*([0-9]+(?:\.[0-9]+)?)%', fragment[0])
        if (match and '时长' in fragment[0] and all(float(match[i + 1]) == -rows[language][1] for i, language in enumerate(order))
                and _observed_adverse_comparison(results, fragment.start(), fragment[0])):
            return True
    return False


def _source_bound_folded_objective_regression(results, tables, source_text):
    source = str(source_text or '')
    observed = (r'^Table\s+[IVXLCDM0-9]+ compares eight models that all route and meet timing on the same engine\. '
                r'([A-Za-z][A-Za-z0-9_-]{1,40}) gives the lowest measured latency and energy:[^\n]{0,600}?'
                r'Weighting the group-lasso by channel cycle cost does not improve this result\. '
                r'([A-Za-z][A-Za-z0-9_-]{1,40}) skips[^\n]{0,350}?'
                r'so the plain lasso performs better on all three measured outcomes in these runs\.')
    for match in re.finditer(_source_evidence_pattern(observed), source, re.M):
        plain, cycle = match.groups()
        if plain == cycle or not _unquoted_observed_comparison(source, match.start(), match[0]):
            continue
        mapping = (r'(?<![A-Za-z0-9_-])' + re.escape(cycle)
                   + r' learns per-channel widths and adds the cycle-weighted group-lasso[^\n]{0,250}?; '
                   + re.escape(plain) + r' replaces cycle-weighted group-lasso with plain group-lasso[^.\n]*\.')
        if not any(_unquoted_observed_comparison(source, definition.start(), definition[0])
                   for definition in re.finditer(mapping, source)):
            continue
        if not any(_unquoted_observed_comparison(results, fragment.start(), fragment[0])
                   and re.search(r'普通组稀疏在三个实测结果上都优于按通道周期加权的组稀疏', fragment[0])
                   for fragment in re.finditer(r'[^。；\n]+', str(results))):
            continue
        for table in tables:
            clean = lambda value: re.sub(r'[*_`$]', '', str(value or '')).strip(_JS_WHITESPACE)
            find = lambda expression: [i for i, header in enumerate(table['header']) if re.fullmatch(expression, clean(header))]
            identity, objective = find(r'构建'), find(r'训练目标')
            time, energy, quality = find(r'帧时间\s*ms/帧\s*↓'), find(r'动态能耗\s*μJ/帧\s*↓'), find(r'PESQ\s*↑')
            if any(len(columns) != 1 for columns in (identity, objective, time, energy, quality)):
                continue
            first = [row for row in table['rows'] if clean(row[identity[0]]) == plain]
            second = [row for row in table['rows'] if clean(row[identity[0]]) == cycle]
            if (len(first) != 1 or len(second) != 1 or clean(first[0][objective[0]]) != '存储加普通组稀疏'
                    or clean(second[0][objective[0]]) != '存储加周期加权组稀疏'):
                continue
            scalar = lambda cell: float(clean(cell)) if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', clean(cell)) else math.nan
            # Only corroborate the retained adverse conclusion. This is not a
            # source-cell-value or publication qualification gate; never split
            # bare HTML duplicates. Normal scientific checks are unchanged.
            if (all(math.isfinite(scalar(first[0][column])) and math.isfinite(scalar(second[0][column]))
                    for column in (time[0], energy[0], quality[0]))
                    and scalar(first[0][time[0]]) < scalar(second[0][time[0]])
                    and scalar(first[0][energy[0]]) < scalar(second[0][energy[0]])
                    and scalar(first[0][quality[0]]) > scalar(second[0][quality[0]])):
                return True
    return False


def _source_bound_deadline_f1_comparison(results, tables, source_text):
    source = str(source_text or '')

    def source_values(method, deadline, lookahead, dataset):
        captions = list(re.finditer(_source_evidence_pattern(
            r'^Table\s+[0-9]+: Accuracy at the deadline, on the primary truth of each set; all rows are our models\. '
            r'Each cell gives the recording-level macro F1 \(%\)[^\n]*$'), source, re.M))
        if len(captions) != 1 or not _unquoted_observed_comparison(source, captions[0].start(), captions[0][0]):
            return None
        prefix = source[:captions[0].start()]
        start = prefix.rfind('\nDevelopment\nHeld-out\nSystem\n')
        if start < 0 or captions[0].start() - start > 8000:
            return None
        lines = [line.strip(_JS_WHITESPACE) for line in prefix[start:].split('\n') if line.strip(_JS_WHITESPACE)]
        row_pattern = re.escape(method) + r', D=' + deadline + r'(?:D=' + deadline + r')?\s*ms'
        first_row = next((i for i, line in enumerate(lines) if re.fullmatch(_source_evidence_pattern(row_pattern), line)), -1)
        headers = lines[3:first_row]
        if first_row < 5 or len(headers) > 10 or len(set(headers)) != len(headers) or headers.count(dataset) != 1:
            return None
        width = len(headers)
        second_row = first_row + 1 + width
        third_row = second_row + 1 + width * 3
        if (second_row >= len(lines) or lines[second_row] not in {
                f'{method}, full length ({lookahead}\u2009ms lookahead)', f'{method}, full length ({lookahead} ms lookahead)'}
                or third_row >= len(lines) or lines[third_row] != 'Harmonic BiCRNN, offline (whole recording)'
                or len(lines) != third_row + 1 + width * 3):
            return None
        scalar = lambda value: value if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', value) else None
        column = headers.index(dataset)
        a, b = scalar(lines[first_row + 1 + column]), scalar(lines[second_row + 1 + column * 3])
        if a is None or b is None or not all(
                scalar(lines[first_row + 1 + i]) is not None
                and scalar(lines[second_row + 1 + i * 3]) is not None
                and scalar(lines[third_row + 1 + i * 3]) is not None
                and re.fullmatch(r'\[.+,.+\]', lines[second_row + 3 + i * 3])
                and re.fullmatch(r'\[.+,.+\]', lines[third_row + 3 + i * 3]) for i in range(width)):
            return None
        return a, b

    observed = (r'Within ([A-Za-z][A-Za-z0-9_-]{1,40}), answering at ([1-9][0-9]*)\s*ms instead of with '
                r'([1-9][0-9]*)\s*ms of lookahead costs ([0-9]+(?:\.[0-9]+)?) points on ([A-Za-z][A-Za-z0-9_-]{1,40})')
    for match in re.finditer(_source_evidence_pattern(observed), source):
        method, deadline, lookahead, delta, dataset = match.groups()
        values = source_values(method, deadline, lookahead, dataset)
        if (not values or not float(delta) > 0 or int(deadline) >= int(lookahead)
                or not _unquoted_observed_comparison(source, match.start(), match[0])
                or abs(float(values[1]) - float(values[0]) - float(delta)) >= 1e-9):
            continue
        comparison = (r'(?<![A-Za-z0-9_-])' + re.escape(method) + r'\s*' + deadline
                      + r'\s*ms\s*相对自身整曲[^。；\n]{0,80}?(?<![A-Za-z0-9_-])' + re.escape(dataset)
                      + r'\s*-' + re.escape(delta) + r'(?![0-9.])')
        if not any(_unquoted_observed_comparison(results, fragment.start(), fragment[0])
                   and re.search(_source_evidence_pattern(comparison), fragment[0])
                   for fragment in re.finditer(r'[^。；\n]+', str(results))):
            continue
        for table in tables:
            clean = lambda value: re.sub(r'[*_`]', '', str(value or '')).strip(_JS_WHITESPACE)
            identity = [i for i, header in enumerate(table['header']) if clean(header) == '系统']
            metric = [i for i, header in enumerate(table['header']) if clean(header) == dataset + ' 留出 ↑']
            if len(identity) != 1 or len(metric) != 1:
                continue
            first = [row for row in table['rows'] if clean(row[identity[0]]) == f'{method} {deadline} ms']
            second = [row for row in table['rows'] if clean(row[identity[0]]) == f'{method} 整曲 {lookahead} ms 前视']
            if len(first) != 1 or len(second) != 1:
                continue
            def scalar(cell):
                value = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)%', clean(cell))
                return value[1] if value else None
            a, b = scalar(first[0][metric[0]]), scalar(second[0][metric[0]])
            if (a is not None and b is not None and a == values[0] and b == values[1]
                    and float(a) < float(b) and abs(float(b) - float(a) - float(delta)) < 1e-9):
                return True
    return False


def _source_bound_notation_roundtrip_regression(results, source_text):
    # Exact own observed notation-loss ablation; no generic decline word gate.
    source, report = str(source_text or ''), str(results or '')
    def unquoted_at(text, index):
        before = text[:index]
        if (before.rfind('“') > before.rfind('”')
                or before.rfind('‘') > before.rfind('’')
                or len(re.findall(r'(?<!\\)"', before)) % 2):
            return False
        fenced = False
        for line in before.split('\n'):
            if re.search(r'^\s*(?:```|~~~)', line):
                fenced = not fenced
        start = max(before.rfind('</blockquote>'), before.rfind('</pre>'), before.rfind('</code>')) + 1
        return not fenced and not re.search(r'<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$', before[start:], re.I)
    def scope_at(text, index, claim):
        before = text[:index]
        prefix = before.split('\n')[-1]
        previous = _normalize_local_evidence_heading(before[:before.rfind('\n')].rstrip().split('\n')[-1] if '\n' in before else '')
        return (unquoted_at(text, index)
                and _own_observed_source_scope(prefix + '\n' + claim)
                and not re.search(r'[“”‘’"]|(?:^|\s)>', prefix)
                and not re.search(r'^(?:(?:previous|prior|related|third[- ]party|other)\s+(?:work|research|study)|quoted statement|quotation|hypothetical example|第三方研究|其他研究|相关工作|先前研究|假设|引用)[.:：]?$', previous, re.I))
    def source_revoked(after):
        return any(re.search(r'^\s*(?:(?:but|however)[, ]+)?(?:this|that|the (?:above|preceding))\s+(?:ablation|result|finding|comparison|experiment|claim)s?[^.!?\n]{0,100}\b(?:withdrawn|retracted|revoked|false|incorrect|not\s+(?:observed|performed|conducted|supported))\b', part, re.I)
                   for part in re.split(r'(?<=[.!?])\s+|\n', after)[:2])
    pattern = (r'The ablation confirms that notation matters: when scores are first converted to MIDI before tokenisation, MIDI-derived ([A-Za-z][A-Za-z0-9_-]{1,40}) models match the performance of their MIDI counterparts, demonstrating that the advantage of MusicXML lies in the notational content lost upon conversion to MIDI, not in the tokenisation\s+strategy alone\.')
    for observed in re.finditer(pattern, source):
        if (not _unquoted_observed_comparison(source, observed.start(), observed[0])
                or not scope_at(source, observed.start(), observed[0]) or source_revoked(source[observed.end():])):
            continue
        adverse = (r'消融(?:将|把)同一(?:批)?乐谱先转\s*MIDI\s*再转回\s*MusicXML\s*后[，,]\s*' + re.escape(observed[1]) + r'\s*(?:模型)?\s*性能回落到\s*MIDI\s*水平[，,]\s*支持优势来自记谱内容而非分词技巧本身')
        for match in re.finditer(adverse, report):
            start = max(report.rfind('。', 0, match.start()), report.rfind('；', 0, match.start()), report.rfind('\n', 0, match.start())) + 1
            ending = re.search(r'[。；\n]', report[match.start():])
            sentence = report[start:match.start() + ending.start() if ending else len(report)]
            if (not _unquoted_observed_comparison(report, start, sentence) or not scope_at(report, match.start(), sentence)
                    or re.search(r'假设|假如|倘若|如果|(?:^|[，,\s])若|未来|计划|预计|可能|先前研究|相关工作|第三方|他人|引用|引述|转述|并非|不是|未(?:能)?|没有|尚未|否认|反驳|撤回|撤销|错误(?:说法|结论)|[?？]', sentence)):
                continue
            following = [part for part in re.split(r'[。；\n]', report[match.end():]) if part.strip()][:2]
            if any(re.search(r'^\s*(?:(?:但|然而)[，,]?\s*)?(?:上述|前述|该|此)(?:消融)?(?:结论|结果|比较|说法)[^。；\n]{0,40}(?:撤回|撤销|不成立|错误|未(?:实际)?(?:进行|观测)|没有(?:进行|观测))', part) for part in following):
                continue
            return True
    return False


def _validate_experiment_table_evidence_depth(
        analysis, document_type='', source_text=''):
    results = _extract_analysis_section(analysis, '实验结果')
    tables = extract_markdown_tables(results)
    empirical = document_type not in {'综述', '理论研究'}
    complete_source_text = source_text
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
        categorical_loss_columns = _source_backed_identity_columns(table, complete_source_text)
        if table['identifier_columns'] < 1 and not categorical_loss_columns:
            return f'实验结果第 {index} 张表缺少方法、数据集或设置识别列'
        for column, header in enumerate(table['header']):
            normalized = re.sub(r'[*_`]', '', header).strip()
            identifier = _is_table_identifier_header(normalized) or column in categorical_loss_columns
            if not identifier and TABLE_VAGUE_METRIC_HEADER_RE.search(normalized):
                return f'实验结果第 {index} 张表含叙述型伪指标列“{normalized}”，应改为可核对指标、设置或比较对象'
            if (not identifier
                    and TABLE_DIRECTIONAL_METRIC_RE.search(normalized)
                    and not TABLE_DIRECTION_MARK_RE.search(normalized)
                    and not TABLE_NON_DIRECTIONAL_MEASURE_RE.search(normalized)):
                return f'实验结果第 {index} 张表指标“{normalized}”缺少 ↑/↓ 方向'
        metric_indexes = [
            column for column, header in enumerate(table['header'])
            if not _is_table_identifier_header(
                re.sub(r'[*_`]', '', re.sub(r'<br\s*/?>', ' ', header, flags=re.I)).strip())
            and column not in categorical_loss_columns
        ]
        for row in table['rows']:
            for column in metric_indexes:
                cell = row[column] if column < len(row) else ''
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
            and re.search(r'比较|对比|基线|对照|检验|考察|回答|关键问题|差异|收益|代价|是否|能否|何种|多大|哪些', paragraph)
        ), '')
        after = next((
            paragraph for paragraph in after_candidates
            if len(re.sub(r'[*_`#>\s]', '', paragraph)) >= 50
            and (re.search(r'相比|相对|差异|提升|下降|降低|增加|减少|但|而|同时|代价|边界|未|不显著|跨零|失败|退化|仅[^。；\n]{1,40}(?:保持|达到)?显著|只说明|不支持|(?:证据|结论)(?:范围)?限于|不宜(?:直接)?(?:解释|推广|视为|当作)|不能(?:直接)?(?:解释|推广|视为)|不可(?:直接)?(?:解释|推广|视为)|不应(?:直接)?(?:解释|推广|视为)', paragraph) or _source_backed_sample_size_boundary(paragraph, table, complete_source_text, results))
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
        r'基线|对照|比较(?:对象)?是|相比|相对|优于|弱于|对比|超过|高于|低于|升至|降至|'
        r'比(?!较)[^。；\n]{0,30}(?:高|低|强|弱|好|差|大|小|提升|下降)',
        results,
        re.I,
    ) or _has_reported_experiment_phrase(results, r'将[^。；\n]{2,60}(?:排序|模型|系统|方法|结果)与[^。；\n]{2,80}(?:排序|模型|系统|方法|结果)[^。；\n]{0,20}比较')
    if empirical and source_has_comparison and not result_has_comparison:
        return '全文包含基线或对照比较，但实验结果没有保留比较对象'
    ablation_negation_pattern = _source_evidence_pattern(
        r'\bno\s+(?:component\s+)?ablations?\b(?:\s+[^.?!\n]{0,40})?|'
        r'\b(?:controlled\s+)?ablations?\s+(?:were|was)\s+not\s+(?:conducted|performed)\b|'
        r'\babsence\s+of\s+(?:component\s+)?ablations?\b'
    )
    source_ablation_evidence = re.sub(
        ablation_negation_pattern, ' ', source_text, flags=re.I | re.A,
    )
    source_has_ablation = re.search(
        _source_evidence_pattern(
            r'\bablation\b|\bw/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|'
            r'消融|移除|去掉'
        ),
        source_ablation_evidence,
        re.I | re.A,
    )
    source_placement_evidence = source_text if _source_evidence_extra_i(source_text) else source_ablation_evidence
    result_has_ablation = _has_source_backed_placement_control(results, source_placement_evidence) or _has_source_backed_presence_comparison(results, tables, source_placement_evidence) or _has_source_backed_training_stage_ablation(tables, source_placement_evidence) or _has_source_backed_zero_correction_ablation(results, source_placement_evidence) or re.search(
        r'\bablation\b|\bw/?o\b|without\s+(?:the\s+)?(?:module|component|loss)|'
        r'消融|移除|去掉|不含|排除|无外推',
        results,
        re.I,
    ) or re.search(
        r'(?:逐级|逐步|依次)(?:叠加|加入|添加|移除|比较)|'
        r'(?:组件|约束|模块|损失|监督目标|局部配对|竞争归一化)[^。；\n]{0,24}(?:对照|贡献|差异|是否必要|必要性)|'
        r'\+\s*L[_\s]?[A-Za-z](?:\s*\+\s*L[_\s]?[A-Za-z])+',
        results,
        re.I,
    )
    # 原文的训练试点比较三项设置，须在同一表中保留各自的数值。
    pilot_source = str(complete_source_text or '')
    if (re.search(r'eleven pilot runs[\s\S]{0,700}factorial[\s\S]{0,400}BPE-dropout', pilot_source, re.I)
            and re.search(r'CR-CTC[\s\S]{0,100}0\.0115[\s\S]{0,200}CTC.side weight 0\.1 instead of 0\.3[\s\S]{0,100}0\.0020[\s\S]{0,200}BPE-dropout 0\.1 instead of none[\s\S]{0,100}0\.0062', pilot_source, re.I)):
        for table in tables:
            rows = [' '.join(row) for row in table['rows']]
            if (any(re.search(r'CR-CTC', row, re.I) and '0.0115' in row for row in rows)
                    and any(re.search(r'CTC', row, re.I) and all(value in row for value in ('0.1', '0.3', '0.0020')) for row in rows)
                    and any(re.search(r'BPE.dropout', row, re.I) and '0.0062' in row for row in rows)):
                result_has_ablation = True
                break
    result_has_ablation = result_has_ablation or _has_reported_experiment_phrase(
        results, r'(?:分离|隔离)[^。；\n]{1,32}(?:贡献|影响|作用)|'
        r'(?:比较|对照)[^。；\n]{0,24}(?:组件|模块|门控)[^。；\n]{0,12}(?:组合|配置)')

    reported_reward_ablation = _has_source_backed_reward_switch_ablation(results, tables, source_placement_evidence)
    component_switch_ablation = _has_source_backed_component_switch_ablation(results, source_placement_evidence)
    if empirical and source_has_ablation and not result_has_ablation and not reported_reward_ablation and not component_switch_ablation:
        return '全文包含消融实验，但实验结果没有保留关键消融或组件对照'
    source_negative_evidence = re.sub(
        _source_evidence_pattern(
            r'\b(?:does|do|did)\s+not(?:\s+\w+){0,2}\s+'
            r'(?:degrad(?:e|es|ed|ation)|fail(?:s|ed|ure)?)\b|'
            r'\bno\s+(?:degrad(?:e|es|ed|ation)|fail(?:ure|ures)?)\b|'
            r'\bwithout\s+(?:any\s+)?(?:degrad(?:e|es|ed|ation)|fail(?:ure|ures)?)\b|'
            r'(?:未|没有|并未|无)[^。；\n]{0,12}(?:退化|失败)|'
            # "平台拒绝计为攻击失败"只是评测口径定义，不是论文报告的退化或失败结果。
            r'\b(?:count(?:s|ed|ing)?|treated|recorded|considered|scored|classif(?:y|ied))\s+as\s+(?:an?\s+)?(?:[A-Za-z-]+\s+){0,3}fail(?:ure|ures)\b'
        ),
        ' ', _observed_source_negative_evidence(source_text), flags=re.I | re.A
    )
    source_has_negative = re.search(
        r'not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|'
        r'fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|'
        r'未显著|不显著|退化|失败|更差|无效|回退|负(?:面)?结果|性能回落|回落至|降幅|'
        r'不单调(?:性|改进)?|不保证单调(?:改进|提升)',
        source_negative_evidence,
        re.I,
    )
    explicit_higher_is_better_metric = (
        r'(?:性能|质量|得分|分数|准确率|自然度|一致性|合规率|动态幅度|'
        r'多样性|表达力|成功率|召回率|精确率|F1)'
    )
    contextual_negative = re.search(
        rf'(?:代价|牺牲)[^。；\n]{{0,80}}{explicit_higher_is_better_metric}'
        rf'[^。；\n]{{0,40}}(?:下降|降低|降至|减少|受限|受损)',
        results,
    ) or re.search(
        rf'(?:移除|去掉)[^。；\n]{{1,80}}{explicit_higher_is_better_metric}'
        rf'[^。；\n]{{0,40}}(?:下降|降低|降至|受损)',
        results,
    )
    explicit_metric_decline = re.search(
        rf'(?:{explicit_higher_is_better_metric}|转写|关键点覆盖)[^。；\n]{{0,40}}'
        rf'(?:下降|下滑|降低|减少|受限|受损)|'
        rf'(?:下降|下滑|降低|受损)[^。；\n]{{0,40}}'
        rf'(?:{explicit_higher_is_better_metric}|转写|关键点覆盖)',
        results,
    )
    reported_lower_score = _has_reported_experiment_phrase(results,
        rf'{explicit_higher_is_better_metric}(?:\s|[0-9.%:：=（）()，,]|为|是|都|均|仍|却|也|则|反而|明显|显著|略|要){{0,40}}(?:更低|低于|不及)')
    reported_bias_regression = any(
        not re.search(r'(?:他人|其他模型|另一(?:个|种)(?:模型|系统)|无关(?:模型|系统)|否定|驳斥|转述)|(?:说法|表述|观点|判断)[^。；\n]{0,20}(?:错误|有误|不成立|不正确)', sentence)
        and
        not re.search(r'(?:假设|假想|如果|计划|未来|预计|可能|先前工作|相关工作|此前研究|并非|不是|没有|尚未|未曾|未|不|是否|尚无|未知|值得|有待|否认|反驳|引用|引述|错误说法|[?？])', sentence)
        and re.search(r'(?:报告|发现|显示|实测|观测)', sentence)
        and re.search(r'(?:蒸馏|候选)检查点[^。；\n]{0,70}[0-9]+(?:\.[0-9]+)?%[^。；\n]{0,40}比原始模型更偏', sentence)
        and all(re.search(r'distilled checkpoints[^\n]{0,140}(?<![0-9.])' + re.escape(number) + r'%[^\n]{0,140}scored worse on the bias benchmark than the original variants', source_text, re.I)
                for number in re.findall(r'([0-9]+(?:\.[0-9]+)?)%', sentence))
        for sentence in re.split(r'[。；\n]', results))
    # 同一四分类 Score 表同时保留本文与更高的已发表对照时，
    # 按原文明确的任务、方法和数值核对，不套用二分类的结论。
    source_rank_regression = False
    # A reported higher 4-class-only comparator is itself a negative result,
    # even when the authors do not use words such as "worse" in Experiments.
    # Detect the comparison independently of its exact reference value: a
    # changed source value must not disable the obligation to retain it.
    rank_comparison = re.search(
        r'On the 4-class task[\s\S]{0,400}?SoftFiLM\s+([0-9]+(?:\.[0-9]+)?)%'
        r'[\s\S]{0,900}?leading 4-class-only\s+methods[\s\S]{0,120}?'
        r'Dong et al\.[\s\S]{0,40}?([0-9]+(?:\.[0-9]+)?)%',
        source_text, re.I)
    observed_rank_comparison = bool(rank_comparison and _own_observed_source_scope(
        source_text[max(0, rank_comparison.start() - 200):rank_comparison.end()])
        and float(rank_comparison[2]) > float(rank_comparison[1]))
    if observed_rank_comparison:
        source_has_negative = True
        for table in tables:
            for column, header in enumerate(table['header']):
                if not re.search(r'4\s*类.*Score.*↑', header, re.I):
                    continue
                rows = table['rows']
                own = any('SoftFiLM' in ' '.join(row) and column < len(row)
                          and row[column].strip() == rank_comparison[1] for row in rows)
                reference = any(re.search(r'Dong\s+et\s+al\.', ' '.join(row), re.I)
                                and column < len(row) and row[column].strip() == rank_comparison[2] for row in rows)
                if own and reference:
                    source_rank_regression = True
    result_has_negative = _source_bound_listening_score_regression(results, tables, complete_source_text) or _source_bound_rendered_duration_shortfall(results, tables, complete_source_text) or _source_bound_notation_roundtrip_regression(results, complete_source_text) or any(_source_backed_sample_size_boundary(paragraph, table, complete_source_text, results) for table in tables for paragraph in re.split(r'\n\s*\n', results)) or _has_source_backed_quality_audibility_tradeoff(results, tables, source_text) or _has_source_backed_net_interval_negative(results, tables, complete_source_text) or _source_bound_matched_acoustic_gap(results, tables, complete_source_text) or _source_bound_folded_objective_regression(results, tables, complete_source_text) or _source_bound_deadline_f1_comparison(results, tables, complete_source_text) or contextual_negative or _has_table_bound_higher_metric_regression(results, tables, complete_source_text) or explicit_metric_decline or reported_lower_score or reported_bias_regression or source_rank_regression or _has_affirmed_overfitting_evidence(results) or re.search(
        r'not\s+significant|no\s+significant|degrad(?:e|es|ed|ation)|'
        r'fail(?:s|ed|ure)?|worse\s+than|does\s+not\s+(?:improve|outperform)|'
        r'未显著|不显著|无显著(?:差异)?|退化|恶化|失败|未能完成|失效|崩溃|接近随机|低于随机|'
        r'更差|比(?!较)[^。；\n]{0,30}差|净下降|反而[^。；\n]{0,10}(?:下降|变差|降低|退化)|低于(?:基线|对照|原方法|原方案)|'
        r'(?:未|没有|并未|不曾|未能)(?:带来|产生|有)?(?:改善|提升|改进|增益)|'
        r'未改善|没有改善|无效|负(?:面)?结果|负增益|性能回落|回落至|负面|暴露短板|跨零|落后|损失(?!函数|项|权重|率)|回退|'
        r'(?:例外|反例)(?![^。；\n]{0,80}(?:耗时|成本|时间|速度|内存|显存))'
        r'[^。；\n]{0,80}(?:低于|下降|更差)|'
        r'不单调(?:性|改进)?|非单调(?:性|响应|作答|情况|变化)?|不保证单调(?:改进|提升)',
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
    table_profile = quality_formats.profile('experiment-tables', contract_version)
    if table_profile == 'evidence-rich':
        return _validate_experiment_table_evidence_depth(
            analysis, document_type, source_text,
        )
    if table_profile != 'size-limits-only':
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


def parse_markdown_images(content):
    """扫描行内图片，同时检查标签和目标地址的括号配对。

    这里只排除段落里的代码段和顶层围栏；缩进代码
    与容器围栏不做一般化处理。引号标题里可能有
    不配对的圆括号；只有目标地址的圆括号影响 URL 配对。
    行内图片的标签或目标地址括号不配对时直接报错；引用式标签不在处理范围内。
    """
    def is_escaped(position):
        previous = position
        while previous > 0 and content[previous - 1] == '\\':
            previous -= 1
        return (position - previous) % 2 != 0

    def invalid(detail, position):
        raise PublishDataValidationError(
            f'图片 Markdown {detail}（字符位置 {position}）'
        )

    # CommonMark 顶层围栏：前导空格 ≤3 个，标记 ≥3 个且同类；
    # 反引号不能出现在反引号围栏的信息串里。未闭合的
    # 围栏会把文档剩余部分都当作代码，包括字面的 ![。
    fenced_ranges = []
    fence = None
    offset = 0
    for line in content.splitlines(keepends=True):
        if fence:
            close = r' {0,3}' + re.escape(fence[1]) + '{' + str(fence[2]) + r',}[ \t]*\r?\n?$'
            if re.fullmatch(close, line):
                fenced_ranges.append((fence[0], offset + len(line)))
                fence = None
        else:
            opened = re.match(r' {0,3}(`{3,}|~{3,})([^\r\n]*)', line)
            if opened and not (opened.group(1)[0] == '`' and '`' in opened.group(2)):
                fence = (offset, opened.group(1)[0], len(opened.group(1)))
        offset += len(line)
    if fence:
        fenced_ranges.append((fence[0], len(content)))

    images = []
    cursor = 0
    while True:
        start = content.find('![', cursor)
        if start < 0:
            break
        fenced = next((span for span in fenced_ranges if span[0] <= start < span[1]), None)
        if fenced:
            cursor = fenced[1]
            continue
        # 只在下一个图片标记之前查找代码段。图片一旦解析完，
        # 它的标签、URL、标题就整体被消费掉，因此这些字段里的反引号
        # 不会误在后面的图片上开启代码段。
        tick = content.find('`', cursor, start)
        if tick >= 0:
            fenced = next((span for span in fenced_ranges if span[0] <= tick < span[1]), None)
            if fenced:
                cursor = fenced[1]
                continue
            tick_end = tick + 1
            while tick_end < len(content) and content[tick_end] == '`':
                tick_end += 1
            if not is_escaped(tick):
                limit = len(content)
                paragraph_end = re.search(
                    r'(?:\r\n|\r(?!\n)|(?<!\r)\n)(?:[ \t]*(?:\r\n|\r(?!\n)|(?<!\r)\n)| {0,3}(?:#{1,6}(?:[ \t]|(?=\r|\n|$))|'
                    r'>|[-+*][ \t]+(?=\S)|0{0,8}1[.)][ \t]+(?=\S)|'
                    r'(?:-+|\*{3,}|_{3,}|=+)[ \t]*(?=\r|\n|$)))',
                    content[tick_end:],
                )
                if paragraph_end:
                    limit = tick_end + paragraph_end.start()
                for fence_start, _fence_end in fenced_ranges:
                    if tick_end <= fence_start < limit:
                        limit = fence_start
                closing = re.search(
                    r'(?<!`)`{' + str(tick_end - tick) + r'}(?!`)',
                    content[tick_end:limit],
                )
                if closing:
                    cursor = tick_end + closing.end()
                    continue
            cursor = tick_end
            continue
        if is_escaped(start):
            cursor = start + 2
            continue
        depth = 1
        alt_end = start + 2
        escaped = False
        while alt_end < len(content):
            char = content[alt_end]
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '`':
                # 配对成功的代码段属于字面标签内容：
                # 其中的方括号不会改变外层图片标签的嵌套深度。
                tick_end = alt_end + 1
                while tick_end < len(content) and content[tick_end] == '`':
                    tick_end += 1
                boundary = re.search(r'(?:\r\n|\r(?!\n)|(?<!\r)\n)[ \t]*(?:\r\n|\r(?!\n)|(?<!\r)\n)', content[tick_end:])
                limit = tick_end + boundary.start() if boundary else len(content)
                closing = re.search(
                    r'(?<!`)`{' + str(tick_end - alt_end) + r'}(?!`)',
                    content[tick_end:limit],
                )
                if closing:
                    alt_end = tick_end + closing.end()
                    continue
                # 未配对的定界符保持字面含义；其中的方括号
                # 仍照常解析，不会悄悄藏住一张图片。
                alt_end = tick_end
                continue
            elif char == '[':
                depth += 1
            elif char == ']':
                depth -= 1
                if depth == 0:
                    break
            alt_end += 1
        if depth != 0:
            invalid('alt 未闭合', start)
        if content[alt_end + 1:alt_end + 2] != '(':
            cursor = alt_end + 1
            continue
        end = alt_end + 2
        depth = 1
        escaped = False
        angle = False
        title_quote = None
        title_start = None
        title_end = None
        while end < len(content):
            char = content[end]
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif title_quote:
                if char == title_quote:
                    title_quote = None
                    title_end = end
            elif angle:
                if char == '>':
                    angle = False
            elif char == '<' and not content[alt_end + 2:end].strip():
                angle = True
            elif char in ('"', "'") and depth == 1 and content[end - 1:end].isspace():
                if title_start is not None:
                    invalid('存在多个 title', start)
                title_quote = char
                title_start = end
            elif char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
                if depth == 0:
                    break
            end += 1
        if title_quote:
            invalid('title 未闭合', start)
        if angle:
            invalid('尖括号 URL 未闭合', start)
        if depth != 0:
            invalid('URL 括号未闭合', start)
        if title_start is not None:
            if title_end is None or content[title_end + 1:end].strip():
                invalid('title 后存在非法内容', start)
            url = content[alt_end + 2:title_start].strip()
        else:
            # 非标题内容保持之前的原始目标地址行为，
            # 包括旧版被截断的 data URI。未改动的加载器
            # 仍然必须拒绝非法字节、协议和地址。
            url = content[alt_end + 2:end].strip()
        if url.startswith('<') and url.endswith('>'):
            url = url[1:-1].strip()
        if not url:
            invalid('URL 为空', start)
        raw = content[start:end + 1]
        images.append({
            'alt': content[start + 2:alt_end], 'url': url,
            'start': start, 'end': end + 1, 'raw': raw,
        })
        cursor = end + 1
    return images


def validate_digest_index_reader_quality(markdown, required=False):
    """校验生成的索引正文是否精确，同时保留旧的未标记页面。

    新生成流程会显式标记索引协议。历史索引生成于这些读者正文检查之前；只要调用方
    没有明确要求新格式，仍允许读取这些页面。
    """
    text = str(markdown or '')
    frontmatter = re.match(r'^---\r?\n(.*?)\r?\n---(?:\r?\n|$)', text, flags=re.DOTALL)
    header_text = frontmatter.group(1) if frontmatter else ''
    def scalar(field):
        values = re.findall(rf'^{field}:[ \t]*(.*?)[ \t]*\r?$', header_text, re.MULTILINE)
        if len(values) > 1:
            raise ValueError('汇总页的读者质量标记字段重复')
        if not values:
            return None
        value = values[0]
        if value[:1] in {'"', "'"}:
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError('汇总页的读者质量标记不是完整字符串')
            value = value[1:-1]
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*', value):
            raise ValueError('汇总页的读者质量标记格式无效')
        return value
    try:
        marker = scalar('paper_digest_reader_quality')
        fingerprint = scalar('paper_digest_reader_quality_schema_fingerprint')
    except ValueError as error:
        return str(error)
    if marker is None:
        if fingerprint is not None:
            return '汇总页的读者质量指纹没有对应的格式声明'
        return '汇总页缺少读者质量协议标记' if required else None
    header = {'contract': marker}
    if fingerprint is not None:
        header['schemaFingerprint'] = fingerprint
    if not protocol_has_valid_header(header, DIGEST_INDEX_READER_QUALITY_CONTRACT):
        return '汇总页的读者质量格式未知、混合或指纹不匹配'
    if not re.search(r'^paper_digest_page_type:\s*index\s*$', header_text, re.MULTILINE):
        return '汇总页读者质量协议只能用于 index 页面'
    body = text[frontmatter.end():] if frontmatter else text
    # 分类路径是程序生成的元数据；只在检查副本中排除逐字重放相等的规范块。
    # 在复用内容遮蔽之前核验，异常 marker 不能藏入作者/摘要等复用区域。
    from tag_presentation import (mask_verified_tag_hierarchy_for_quality,
                                  mask_verified_overview_root_task_links_for_quality)
    try:
        body = mask_verified_tag_hierarchy_for_quality(body)
        body = mask_verified_overview_root_task_links_for_quality(body)
    except ValueError as error:
        return f'汇总页多级分类元数据无效: {error}'
    if not re.search(r'^##\s+.*今日概览', body, re.MULTILINE) \
            or not re.search(r'^##\s+.*论文列表', body, re.MULTILINE):
        return '汇总页缺少今日概览或论文列表'
    paper_list = re.split(r'^##\s+.*论文列表\s*$', body, maxsplit=1, flags=re.MULTILINE)
    paper_list = paper_list[1] if len(paper_list) == 2 else ''
    if re.search(
            r'^(?:🔥|⭐|✅|⚪|📝).*\*\*\d+(?:\.\d+)?/10\*\*.*'
            r'(?:评分置信度|\[arxiv\])',
            paper_list, flags=re.MULTILINE | re.IGNORECASE):
        return '汇总页仍包含重复的旧版评分/标签/arXiv 尾行'
    entries = re.split(r'(?=^###\s+)', paper_list, flags=re.MULTILINE)
    for entry in entries:
        heading = re.match(
            r'^###\s+[^\n]*?\[([^\]]+)\]\(([^)]+/posts/[^)]+)\)\s*$',
            entry, flags=re.MULTILINE,
        )
        if not heading:
            continue
        blog_target = heading.group(2)
        english = re.search(
            r'^>\s*英文题目：\*\[[^\]]+\]\(([^)]+)\)\*\s*$',
            entry, flags=re.MULTILINE,
        )
        if english and english.group(1) != blog_target:
            return '汇总页中英文论文标题没有指向同一篇独立博客'
        score = re.search(r'^评分：', entry, flags=re.MULTILINE)
        context = re.search(
            r'^(?:排名：[^|\n]+\s*\|\s*)?'
            r'(?:文档类型：[^|\n]+\s*\|\s*)?'
            r'\[arXiv 原文\]\(https://arxiv\.org/abs/[^)]+\)\s*$',
            entry, flags=re.MULTILINE,
        )
        authors = re.search(r'^👥 \*\*作者与机构\*\*$', entry, flags=re.MULTILINE)
        if score and context and context.start() < score.start():
            return '汇总页排名/文档类型/arXiv 必须位于评分之后'
        if context and authors and context.start() > authors.start():
            return '汇总页排名/文档类型/arXiv 必须位于作者机构之前'
    # 汇总页会复用单篇的作者机构、摘要和资源内容。下面先在校验副本中
    # 替换匹配到的内容块，再检查汇总页自身的文字，避免把不同论文的表达合并判断。
    # 复用内容是否一致，由相应生成和页面核验负责。
    component_end = (
        r'(?=^(?:👥 \*\*作者与机构\*\*|📌 \*\*核心摘要\*\*|'
        r'🔗 \*\*开源资源\*\*|💡 \*\*(?:论文评价|毒舌点评)\*\*)$|'
        r'^---[ \t]*$|^#{1,3}[ \t]+|'
        r'\n\n[^\n]*\*\*\d+(?:\.\d+)?/10\*\*|\Z)'
    )
    def mask_component(match, label, placeholder):
        # Image alt text remains subject to the index typography guard even
        # when an image occurs inside a copied decision block.
        images = re.findall(r'!\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)',
                            match.group(0))
        return label + '\n\n' + placeholder + '\n\n' + (
            '\n\n'.join(images) + '\n\n' if images else '')
    owned_entries = []
    for entry in entries:
        if re.match(r'^###\s+[^\n]*?\[[^\]]+\]\([^)]+/posts/[^)]+\)\s*$',
                    entry, flags=re.MULTILINE):
            for label, placeholder in (
                ('👥 **作者与机构**', '已绑定单篇作者机构。'),
                ('📌 **核心摘要**', '单篇已审核心摘要。'),
                ('🔗 **开源资源**', '单篇已审开源资源。'),
            ):
                component_body = (r'(?:- [^\n]*\n)+(?:\n|\Z)'
                    if label == '👥 **作者与机构**' else r'[\s\S]*?' + component_end)
                entry = re.sub('^' + re.escape(label) + r'\n\n' + component_body,
                    lambda match, label=label, placeholder=placeholder:
                        mask_component(match, label, placeholder),
                    entry, flags=re.MULTILINE)
        owned_entries.append(entry)
    list_heading = re.search(r'^##\s+.*论文列表\s*$', body, re.MULTILINE)
    index_owned_body = body[:list_heading.end()] + ''.join(owned_entries)
    # 把整页放进一个合成章节：否则它自己的 H2 标题会让通用 Manual 读者
    # 校验器只检查标题前的引言部分。
    synthetic = '## 核心摘要\n' + re.sub(
        r'^##\s+', '### ', index_owned_body, flags=re.MULTILINE,
    )
    issue = validate_manual_reader_quality(synthetic)
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
    """校验并统一按文档类型区分的评分字段及其表示方式。"""
    if not isinstance(parsed, dict):
        raise PublishDataValidationError(f'{source} 必须是对象')

    try:
        read_tag_validation(parsed)
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error

    normalized = dict(parsed)
    document_type = normalized.get('documentType')
    if document_type not in ALLOWED_DOCUMENT_TYPES:
        raise PublishDataValidationError(f'{source} 缺少有效 documentType: {document_type!r}')
    rubric_version = normalized.get('scoringRubricVersion')
    if rubric_version not in SUPPORTED_SCORING_RUBRIC_VERSIONS:
        raise PublishDataValidationError(
            f'{source} 的 scoringRubricVersion 非法: {rubric_version!r}'
        )
    is_unified = _scoring.is_unified_rubric(rubric_version)
    active_dimensions = _scoring.UNIFIED_PUBLISH_DIMENSIONS if is_unified else SCORING_DIMENSIONS
    active_open_anchors = _scoring.UNIFIED_OPEN_SOURCE_ANCHORS if is_unified else OPEN_SOURCE_SCORE_ANCHORS

    dimension_total = 0.0
    dimension_scores = {}
    scoring_reason = normalized.get('scoringReason', '')
    if require_reason_dimensions:
        score_validation = normalized.get('scoreValidation')
        if not isinstance(score_validation, dict) or score_validation.get('valid') is not True:
            validation_errors = score_validation.get('errors', []) if isinstance(score_validation, dict) else []
            details = '；'.join(str(error) for error in validation_errors[:3]) or '八维评分格式非法'
            raise PublishDataValidationError(f'{source} 的评分理由契约无效: {details}')
    for field, label, maximum in active_dimensions:
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
            abs(score - anchor) <= 1e-9 for anchor in active_open_anchors
        ):
            raise PublishDataValidationError(
                f'{source} 的 openSourceScore={score:g} 不在固定锚点集合'
            )
        dimension_total += score
        dimension_scores[field] = score
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
    expected_total = (
        _scoring.calculate_weighted_total(document_type, dimension_scores)['total']
        if is_unified else min(10.0, dimension_total)
    )
    if abs(total - expected_total) > 0.051:
        raise PublishDataValidationError(
            f'{source} 总分 {total:g} 与八维计算结果 {expected_total:g} 不一致'
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
    """交叉核对分析来源后，返回可安全发布的结构化数据。"""
    if not isinstance(paper, dict):
        raise PublishDataValidationError('论文记录必须是对象')
    paper_label = paper.get('arxivId') or paper.get('title') or '<unknown paper>'
    analysis = paper.get('analysis')
    if not isinstance(analysis, str) or not analysis.strip():
        raise PublishDataValidationError(f'{paper_label} 缺少 analysis')
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        raise PublishDataValidationError(f'{paper_label} {heading_issue}')
    raw_analysis_parsed = parse_analysis(analysis)
    _validate_current_analysis_tags(analysis, raw_analysis_parsed, paper_label)
    analysis_parsed = validate_publish_parsed(
        raw_analysis_parsed,
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
    if top_version not in SUPPORTED_SCORING_RUBRIC_VERSIONS:
        raise PublishDataValidationError(
            f'{paper_label} 顶层 scoringRubricVersion 非法: {top_version!r}'
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

    # analysis 始终是发布基线。缓存只能提供显式声明并通过校验的人工评分覆盖。
    resolved = dict(analysis_parsed)
    for field in override_fields:
        resolved[field] = cached_parsed[field]
    return validate_publish_parsed(
        resolved,
        f'{paper_label}.publishBaseline',
        require_reason_dimensions=True,
    )


def _validate_current_analysis_tags(analysis, parsed, paper_label):
    """核对各类发布输入的四行标签章节、主任务标签和主方法标签。"""
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        raise PublishDataValidationError(f'{paper_label} {heading_issue}')
    match = re.search(r'(^|\n)##(?!#)\s*标签[：:\s]*\n([\s\S]*?)(?=\n##(?!#)\s|$)', analysis)
    lines = [line.strip() for line in (match.group(2) if match else '').splitlines()
             if line.strip()]
    if len(lines) != 4:
        raise PublishDataValidationError(f'{paper_label} 标签章节必须恰好包含四行非空内容。')
    all_tags = re.findall(r'#[^\s,，;；、]+', lines[0])
    if len(all_tags) not in range(3, 6) or ' '.join(all_tags) != lines[0]:
        raise PublishDataValidationError(
            f'{paper_label} 标签章节首行必须包含 3–5 个标签，并用空格分隔。')
    role_patterns = (
        (r'^主任务标签\s*[：:]\s*(#\S+)$', '主任务标签'),
        (r'^主方法标签\s*[：:]\s*(#\S+)$', '主方法标签'),
        (r'^补充标签\s*[：:]\s*(#\S+(?:\s+#\S+)*)$', '补充标签'),
    )
    values = []
    for line, (pattern, label) in zip(lines[1:], role_patterns):
        role_match = re.fullmatch(pattern, line)
        if role_match is None:
            raise PublishDataValidationError(f'{paper_label} 标签章节中的{label}行缺失或格式无效。')
        values.append(role_match.group(1))
    task_tag, method_tag, supplemental_text = values
    supplemental = supplemental_text.split()
    expected_supplemental = [tag for tag in all_tags if tag not in {task_tag, method_tag}]
    if supplemental != expected_supplemental:
        raise PublishDataValidationError(f'{paper_label} 补充标签的内容或顺序与首行除主任务、主方法外的标签不一致。')
    try:
        validation = read_tag_validation(parsed)
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    if not isinstance(validation, dict) or validation.get('valid') is not True:
        detail = (validation or {}).get('errors', ['缺少标签检查结果'])[0]
        raise PublishDataValidationError(f'{paper_label} 当前正文的标签选择未通过检查：{detail}')
    if parsed.get('tags') != all_tags \
            or parsed.get('primaryTaskTag') != task_tag \
            or parsed.get('primaryMethodTag') != method_tag:
        raise PublishDataValidationError(f'{paper_label} 标签章节中的标签、主任务或主方法与词表解析结果不一致。')
    machine = parsed.get('machineSummary') or {}
    machine_start, machine_end = _find_analysis_section_bounds(analysis, '机器摘要')
    machine_body = analysis[machine_start:machine_end]
    for key in ('primary_task_tag', 'primary_method_tag'):
        if len(re.findall(rf'^{key}\s*[:：]\s*\S+\s*$', machine_body, re.M)) != 1:
            raise PublishDataValidationError(
                f'{paper_label} 机器摘要中的 {key} 必须恰好出现一次，并填写一个有效值。')
    if machine.get('primaryTaskTag') != task_tag \
            or machine.get('primaryMethodTag') != method_tag:
        raise PublishDataValidationError(f'{paper_label} 机器摘要中的主任务或主方法与标签章节不一致。')


def normalize_publish_arxiv_id(arxiv_id):
    """归一化 arXiv ID，用于查重和稳定文件名。"""
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


def parse_publish_arxiv_identity(arxiv_id):
    """返回基础 arXiv ID，只保留显式给出的版本号。

    发布元数据不能把没有版本号的标识符变成 ``v1``：arXiv 的 ``abs``/``pdf``
    链接不带后缀时跟随不断更新的当前版本，带后缀的标识符才是不变的版本
    引用。这个解析器有意与 :func:`normalize_publish_arxiv_id` 共用可接受
    的包装形式，并且只在权威输入本身带后缀时才保留后缀。
    """
    raw = str(arxiv_id or '').strip().lower()
    raw = re.sub(r'^https?://arxiv\.org/(?:abs|pdf)/', '', raw)
    raw = re.sub(r'^arxiv:', '', raw)
    raw = re.sub(r'\.pdf$', '', raw)
    if len(raw) > 128:
        raise PublishDataValidationError(f'arXiv ID 超过 128 字符上限: {arxiv_id!r}')
    match = re.fullmatch(
        r'((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*/\d{7}))(?:v([0-9]{1,6}))?',
        raw,
    )
    if not match:
        raise PublishDataValidationError(f'无效 arXiv ID: {arxiv_id!r}')
    version_text = match.group(2)
    if version_text is not None and (
            version_text.startswith('0') or int(version_text) < 1):
        raise PublishDataValidationError(f'arXiv 版本必须是正整数且无前导零: {arxiv_id!r}')
    base_id = normalize_publish_arxiv_id(arxiv_id)
    if match.group(1) != base_id:
        raise PublishDataValidationError(f'arXiv ID 规范化结果不一致: {arxiv_id!r}')
    version = int(version_text) if version_text is not None else None
    versioned_id = f'{base_id}v{version}' if version is not None else None
    resolved_id = versioned_id or base_id
    return {
        'baseId': base_id,
        'version': version,
        'versionedId': versioned_id,
        'absUrl': f'https://arxiv.org/abs/{resolved_id}',
        'pdfUrl': f'https://arxiv.org/pdf/{resolved_id}.pdf',
    }


def is_canonical_publish_arxiv_id(value):
    """审查记录只接受规范基础 ID；允许现代四/五位编号及旧类目编号。"""
    if not isinstance(value, str):
        return False
    try:
        identity = parse_publish_arxiv_identity(value)
    except PublishDataValidationError:
        return False
    return identity['version'] is None and identity['baseId'] == value


def validate_papers_for_publish(papers, *, validate_manual_stage_records=True,
                               _daily_source_capability=None):
    """在生成任何发布文件之前校验每一篇论文。

    ``validate_manual_stage_records=False`` 只留给派生的发布图片排除视图。
    它的规范来源在派生之前刚刚校验过；所有面向读者的发布要求仍会针对改过的分析重新检查。
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
            heading_issue = evaluation_heading_issue(paper.get('analysis'))
            if heading_issue:
                raise PublishDataValidationError(f'{paper_label} {heading_issue}')
            if not validate_manual_stage_records:
                _validate_publish_image_exclusion_view(paper, paper_label)
            if paper.get('latestAnalysisAttemptError'):
                raise PublishDataValidationError(
                    f'{paper_label} 最新一次深度分析失败，禁止使用陈旧成功正文发布'
                )
            if 'dailyScoringRefreshCheckpoint' in paper:
                raise PublishDataValidationError(
                    f'{paper_label} 评分刷新后的 Reader 尚未完成，禁止发布待恢复稿'
                )
            if 'analysisFactReviewObligation' in paper:
                raise PublishDataValidationError(
                    f'{paper_label} 当前来源绑定的事实反馈尚未完成，禁止使用旧正文发布'
                )
            manifest = paper.get('analysisManifest')
            if manifest is not None:
                stages = manifest.get('stages') if isinstance(manifest, dict) else None
                uses_manual_manifest = (
                    isinstance(manifest, dict)
                    and (isinstance(manifest.get('manualTakeover'), dict)
                         or any(isinstance(stage, dict)
                                and stage.get('status') == MANUAL_COMPLETE_STATUS
                                for stage in (stages or {}).values()))
                )
                required_stages = [
                    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan',
                    'revision', 'tableRepair', 'methodRepair', 'structureRepair',
                    'scoringAudit', 'imageSupplement',
                ]
                if not uses_manual_manifest:
                    try:
                        tag_record = read_tag_stage_record(
                            manifest, paper.get('analysisStageCheckpoints'))
                    except ValueError as error:
                        raise PublishDataValidationError(f'{paper_label} {error}') from error
                    required_stages.insert(8, tag_record['stageKey'])
                terminal_statuses = {
                    'imageDownload': {'complete', 'skipped', 'no_candidates', 'no_downloadable_images', MANUAL_COMPLETE_STATUS},
                    'primaryAnalysis': {'complete', MANUAL_COMPLETE_STATUS},
                    'openSourceScan': {'complete', MANUAL_COMPLETE_STATUS},
                    'demoLinkScan': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'revision': {'complete', MANUAL_COMPLETE_STATUS},
                    'tableRepair': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'methodRepair': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'structureRepair': {'complete', 'not_needed', MANUAL_COMPLETE_STATUS},
                    'taxonomySeal': {'complete', 'not_needed'},
                    'tagSelection': {'complete', 'not_needed'},
                    'scoringAudit': {'complete', MANUAL_COMPLETE_STATUS},
                    'imageSupplement': {
                        'complete', 'skipped', 'no_candidates',
                        'no_high_value_images', 'no_downloadable_images', MANUAL_COMPLETE_STATUS,
                    },
                }
                incomplete = [
                    stage for stage in required_stages
                    if not isinstance(stages, dict)
                    or not isinstance(stages.get(stage), dict)
                    or stages[stage].get('status') not in terminal_statuses[stage]
                ]
                saved_header = quality_formats.manifest_header(manifest)
                if (saved_header is None or incomplete
                        or (uses_manual_manifest and 'version' not in saved_header)):
                    detail = ', '.join(incomplete) if incomplete else '阶段记录格式'
                    raise PublishDataValidationError(
                        f'{paper_label} 深度分析阶段尚未全部完成: {detail}'
                    )
                if validate_manual_stage_records:
                    _validate_manual_takeover_manifest(paper, manifest, paper_label)
                if not uses_manual_manifest:
                    _validate_tag_stage_record(paper, manifest, paper_label)
                signed_manual_compatibility = _manual_signed_reader_compatibility(
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
                table_profile = quality_formats.profile('experiment-tables', table_contract)
                if table_contract is not None and not table_profile:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.experimentTables 非法: '
                        f'{table_contract}'
                    )
                if (table_profile
                        and not signed_manual_compatibility):
                    table_issue = validate_experiment_table_contract(
                        paper.get('analysis'),
                        contract_version=table_contract,
                        document_type=(paper.get('parsed') or {}).get('documentType', ''),
                        source_text=_publication_table_source_text(paper, _daily_source_capability),
                    )
                    if table_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 分析正文表格契约无效: {table_issue}'
                        )
                method_contract = (
                    contracts.get('methodDetail') if isinstance(contracts, dict) else None
                )
                method_profile = quality_formats.profile('method-detail', method_contract)
                if method_contract is not None and not method_profile:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.methodDetail 非法: '
                        f'{method_contract}'
                    )
                if (method_profile
                        and not signed_manual_compatibility):
                    method_issue = validate_method_detail_contract(paper.get('analysis'))
                    if method_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 分析正文方法契约无效: {method_issue}'
                        )
                manual_depth_contract = (
                    contracts.get('manualDepth') if isinstance(contracts, dict) else None
                )
                if manual_depth_contract is not None and manual_depth_contract not in MANUAL_DEPTH_CONTRACTS:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.manualDepth 非法: '
                        f'{manual_depth_contract}'
                    )
                if manual_depth_contract in MANUAL_READER_QUALITY_CONTRACTS \
                        and table_contract != EXPERIMENT_TABLE_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} manual v4 必须声明 '
                        f'experimentTables={EXPERIMENT_TABLE_CONTRACT_VERSION}'
                    )
                if not signed_manual_compatibility and manual_depth_contract in {
                        MANUAL_DEPTH_EXPLANATION_CONTRACT, *MANUAL_READER_QUALITY_CONTRACTS}:
                    manual_depth_issue = validate_manual_beginner_explanation(paper.get('analysis'))
                    if manual_depth_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} manual 全文深度契约无效: {manual_depth_issue}'
                        )
                    if manual_depth_contract in MANUAL_READER_QUALITY_CONTRACTS:
                        editorial_issue = validate_manual_reader_quality(paper.get('analysis'))
                        if editorial_issue:
                            raise PublishDataValidationError(
                                f'{paper_label} manual v4 读者文本质量无效: {editorial_issue}'
                            )
                elif (not signed_manual_compatibility
                        and manual_depth_contract == MANUAL_DEPTH_COVERAGE_CONTRACT):
                    manual_depth_issue = validate_manual_source_coverage(paper.get('analysis'))
                    if manual_depth_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} manual 全文深度契约无效: {manual_depth_issue}'
                        )
                elif (not signed_manual_compatibility
                        and manual_depth_contract == MANUAL_DEPTH_SOURCE_CONTRACT):
                    manual_depth_issue = validate_manual_depth_contract(paper.get('analysis'))
                    if manual_depth_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} manual 全文深度契约无效: {manual_depth_issue}'
                        )
                image_narrative_contract = (
                    contracts.get('imageNarrative') if isinstance(contracts, dict) else None
                )
                if manual_depth_contract in MANUAL_READER_QUALITY_CONTRACTS \
                        and image_narrative_contract != IMAGE_NARRATIVE_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} manual v4 必须声明 '
                        f'imageNarrative={IMAGE_NARRATIVE_CONTRACT_VERSION}'
                    )
                image_profile = quality_formats.profile('image-narrative', image_narrative_contract)
                if image_narrative_contract is not None and not image_profile:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.imageNarrative 非法: '
                        f'{image_narrative_contract}'
                    )
                if (image_profile
                        and not signed_manual_compatibility):
                    image_narrative_issue = validate_image_narrative_contract(paper)
                    if image_narrative_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 图片上下文契约无效: {image_narrative_issue}'
                        )
                editorial_quality_contract = (
                    contracts.get('editorialQuality') if isinstance(contracts, dict) else None
                )
                if manual_depth_contract in MANUAL_READER_QUALITY_CONTRACTS \
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



import publish_manual_legacy as _publish_manual_legacy

# Re-export retired Manual v4/v5/v6 constants from publish_manual_legacy.py
MANUAL_RESEARCH_CONTRACT = _publish_manual_legacy.MANUAL_RESEARCH_CONTRACT
MANUAL_DEPTH_SOURCE_CONTRACT = _publish_manual_legacy.MANUAL_DEPTH_SOURCE_CONTRACT
MANUAL_DEPTH_COVERAGE_CONTRACT = _publish_manual_legacy.MANUAL_DEPTH_COVERAGE_CONTRACT
MANUAL_DEPTH_EXPLANATION_CONTRACT = _publish_manual_legacy.MANUAL_DEPTH_EXPLANATION_CONTRACT
MANUAL_DEPTH_READER_QUALITY_CONTRACT = _publish_manual_legacy.MANUAL_DEPTH_READER_QUALITY_CONTRACT
MANUAL_DEPTH_FACT_COVERAGE_CONTRACT = _publish_manual_legacy.MANUAL_DEPTH_FACT_COVERAGE_CONTRACT
MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT = _publish_manual_legacy.MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT
SIGNED_MANUAL_COMPATIBILITY_MODE = _publish_manual_legacy.SIGNED_MANUAL_COMPATIBILITY_MODE
MANUAL_SIGNED_LONGFORM_CONTRACT = _publish_manual_legacy.MANUAL_SIGNED_LONGFORM_CONTRACT
MANUAL_STRUCTURED_ARTIFACT_PARSER_CONTRACT = _publish_manual_legacy.MANUAL_STRUCTURED_ARTIFACT_PARSER_CONTRACT
MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT = _publish_manual_legacy.MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT
MANUAL_DEPTH_CONTRACTS = _publish_manual_legacy.MANUAL_DEPTH_CONTRACTS
MANUAL_READER_QUALITY_CONTRACTS = _publish_manual_legacy.MANUAL_READER_QUALITY_CONTRACTS
MANUAL_COMPLETE_STATUS = _publish_manual_legacy.MANUAL_COMPLETE_STATUS
MANUAL_COMPLETE_PROVENANCE_VERSION = _publish_manual_legacy.MANUAL_COMPLETE_PROVENANCE_VERSION
MANUAL_PROVENANCE_PROTOCOL = _publish_manual_legacy.MANUAL_PROVENANCE_PROTOCOL
MANUAL_STAGE_EXECUTION_KIND = _publish_manual_legacy.MANUAL_STAGE_EXECUTION_KIND
MANUAL_BOUND_STAGE_CUTOFF_DATE = _publish_manual_legacy.MANUAL_BOUND_STAGE_CUTOFF_DATE
MANUAL_AUDIT_CHECKS = _publish_manual_legacy.MANUAL_AUDIT_CHECKS
MANUAL_STAGE_EVIDENCE_STAGES = _publish_manual_legacy.MANUAL_STAGE_EVIDENCE_STAGES
MANUAL_BOILERPLATE_PATTERNS = _publish_manual_legacy.MANUAL_BOILERPLATE_PATTERNS
MANUAL_SIGNATURE_CONTRACT = _publish_manual_legacy.MANUAL_SIGNATURE_CONTRACT
_SIGNED_MANUAL_SHA_FIELDS = _publish_manual_legacy._SIGNED_MANUAL_SHA_FIELDS
_SIGNED_MANUAL_BLOCK_KINDS = _publish_manual_legacy._SIGNED_MANUAL_BLOCK_KINDS
MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS = _publish_manual_legacy.MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS
MANUAL_ENGLISH_NUMBER_WORDS = _publish_manual_legacy.MANUAL_ENGLISH_NUMBER_WORDS
MANUAL_RESULT_DIRECTION_PATTERNS = _publish_manual_legacy.MANUAL_RESULT_DIRECTION_PATTERNS
MANUAL_DUP_CHECK_SECTIONS = _publish_manual_legacy.MANUAL_DUP_CHECK_SECTIONS
MANUAL_DUP_MIN_SENTENCE_CHARS = _publish_manual_legacy.MANUAL_DUP_MIN_SENTENCE_CHARS
MANUAL_DUP_MAX_SENTENCES = _publish_manual_legacy.MANUAL_DUP_MAX_SENTENCES
MANUAL_DUP_MAX_SECTION_SPREAD = _publish_manual_legacy.MANUAL_DUP_MAX_SECTION_SPREAD
MANUAL_EDITORIAL_TEMPLATE_RE = _publish_manual_legacy.MANUAL_EDITORIAL_TEMPLATE_RE
MANUAL_SCORING_ANCHOR_TAG_MIN = _publish_manual_legacy.MANUAL_SCORING_ANCHOR_TAG_MIN
MANUAL_SCORING_ANCHOR_TAG_RE = _publish_manual_legacy.MANUAL_SCORING_ANCHOR_TAG_RE
FINAL_MANUAL_SECTION_HEADINGS = _publish_manual_legacy.FINAL_MANUAL_SECTION_HEADINGS


def _bind_manual_legacy(fn_name):
    target = getattr(_publish_manual_legacy, fn_name)
    def _wrapped(*args, **kwargs):
        with _publish_manual_legacy._hooks_scope(globals()):
            return target(*args, **kwargs)
    _wrapped.__name__ = target.__name__
    _wrapped.__qualname__ = target.__qualname__
    _wrapped.__doc__ = target.__doc__
    return _wrapped


_validate_manual_rejected_image_coverage = _bind_manual_legacy('_validate_manual_rejected_image_coverage')
_manual_js_number_text = _bind_manual_legacy('_manual_js_number_text')
_assert_hash_key_premises = _bind_manual_legacy('_assert_hash_key_premises')
_assert_ecmascript_number_premises = _bind_manual_legacy('_assert_ecmascript_number_premises')
_manual_canonical_json = _bind_manual_legacy('_manual_canonical_json')
_manual_hash = _bind_manual_legacy('_manual_hash')
_manual_paper_identity_mode = _bind_manual_legacy('_manual_paper_identity_mode')
_prepare_manual_signature_input = _bind_manual_legacy('_prepare_manual_signature_input')
_manual_signature_number_text = _bind_manual_legacy('_manual_signature_number_text')
_manual_signature_canonical_json = _bind_manual_legacy('_manual_signature_canonical_json')
_manual_signature_hash = _bind_manual_legacy('_manual_signature_hash')
_manual_signed_reader_compatibility = _bind_manual_legacy('_manual_signed_reader_compatibility')
_normalize_signed_manual_text = _bind_manual_legacy('_normalize_signed_manual_text')
_signed_manual_article_uses_term = _bind_manual_legacy('_signed_manual_article_uses_term')
_signed_manual_text_sha = _bind_manual_legacy('_signed_manual_text_sha')
_require_signed_manual_text = _bind_manual_legacy('_require_signed_manual_text')
_is_signed_manual_table_paragraph = _bind_manual_legacy('_is_signed_manual_table_paragraph')
_sanitize_signed_manual_table_cell = _bind_manual_legacy('_sanitize_signed_manual_table_cell')
_render_signed_manual_table = _bind_manual_legacy('_render_signed_manual_table')
_signed_manual_numeric_cell_ids = _bind_manual_legacy('_signed_manual_numeric_cell_ids')
_signed_manual_inventory_ids = _bind_manual_legacy('_signed_manual_inventory_ids')
_manual_analysis_model_context = _bind_manual_legacy('_manual_analysis_model_context')
_require_manual_analysis_identity = _bind_manual_legacy('_require_manual_analysis_identity')
_validate_current_manual_research_identity = _bind_manual_legacy('_validate_current_manual_research_identity')
validate_signed_manual_payload = _bind_manual_legacy('validate_signed_manual_payload')
_normalize_manual_evidence = _bind_manual_legacy('_normalize_manual_evidence')
_manual_claim_field_text = _bind_manual_legacy('_manual_claim_field_text')
_manual_claim_not_reported = _bind_manual_legacy('_manual_claim_not_reported')
_normalize_manual_numeric_lexeme = _bind_manual_legacy('_normalize_manual_numeric_lexeme')
_manual_numeric_lexemes = _bind_manual_legacy('_manual_numeric_lexemes')
_manual_normalized_semantic_text = _bind_manual_legacy('_manual_normalized_semantic_text')
_manual_binding_reuse_key = _bind_manual_legacy('_manual_binding_reuse_key')
_manual_result_direction_supported = _bind_manual_legacy('_manual_result_direction_supported')
_manual_result_claim_dedup_key = _bind_manual_legacy('_manual_result_claim_dedup_key')
_manual_reader_result_evidence_blocks = _bind_manual_legacy('_manual_reader_result_evidence_blocks')
_validate_manual_result_claim_bindings = _bind_manual_legacy('_validate_manual_result_claim_bindings')
_manual_result_claim_bound_to_reader_block = _bind_manual_legacy('_manual_result_claim_bound_to_reader_block')
_manual_result_claim_source_text = _bind_manual_legacy('_manual_result_claim_source_text')
_validate_manual_attributed_result_claims = _bind_manual_legacy('_validate_manual_attributed_result_claims')
_manual_boilerplate = _bind_manual_legacy('_manual_boilerplate')
_validate_manual_takeover_manifest = _bind_manual_legacy('_validate_manual_takeover_manifest')
validate_manual_depth_contract = _bind_manual_legacy('validate_manual_depth_contract')
_normalize_manual_dup_sentence = _bind_manual_legacy('_normalize_manual_dup_sentence')
find_cross_section_duplicate_sentences = _bind_manual_legacy('find_cross_section_duplicate_sentences')
validate_manual_source_coverage = _bind_manual_legacy('validate_manual_source_coverage')
_manual_chinese_count = _bind_manual_legacy('_manual_chinese_count')
_manual_prose_paragraphs = _bind_manual_legacy('_manual_prose_paragraphs')
_manual_editorial_prose_paragraphs = _bind_manual_legacy('_manual_editorial_prose_paragraphs')
_manual_han_character_count = _bind_manual_legacy('_manual_han_character_count')
validate_manual_beginner_explanation = _bind_manual_legacy('validate_manual_beginner_explanation')
_is_discourse_task_condition_numeral = _bind_manual_legacy('_is_discourse_task_condition_numeral')
_is_person_introduction_numeral = _bind_manual_legacy('_is_person_introduction_numeral')
validate_manual_reader_quality = _bind_manual_legacy('validate_manual_reader_quality')
_manual_structured_reader_view = _bind_manual_legacy('_manual_structured_reader_view')
_final_manual_depth_contract = _bind_manual_legacy('_final_manual_depth_contract')
_is_final_structured_manual = _bind_manual_legacy('_is_final_structured_manual')
_final_markdown_image_occurrences = _bind_manual_legacy('_final_markdown_image_occurrences')
validate_final_structured_manual_markdown = _bind_manual_legacy('validate_final_structured_manual_markdown')


import publish_llm_client as _publish_llm_client


def _bind_llm_client(fn_name):
    target = getattr(_publish_llm_client, fn_name)
    def _wrapped(*args, **kwargs):
        with _publish_llm_client._hooks_scope(globals()):
            return target(*args, **kwargs)
    _wrapped.__name__ = target.__name__
    _wrapped.__qualname__ = target.__qualname__
    _wrapped.__doc__ = target.__doc__
    return _wrapped


get_claude_code_version = _bind_llm_client('get_claude_code_version')
detect_publish_api_type = _publish_llm_client.detect_publish_api_type
_is_publish_loopback_hostname = _publish_llm_client._is_publish_loopback_hostname
validate_publish_api_endpoint_url = _bind_llm_client('validate_publish_api_endpoint_url')
build_publish_api_url = _bind_llm_client('build_publish_api_url')
_canonical_publish_request_url = _bind_llm_client('_canonical_publish_request_url')
_canonical_publish_service_endpoint = _bind_llm_client('_canonical_publish_service_endpoint')
build_publish_headers = _bind_llm_client('build_publish_headers')
build_publish_payload = _bind_llm_client('build_publish_payload')
parse_publish_response_text = _publish_llm_client.parse_publish_response_text
_publish_llm_requires_proxy = _publish_llm_client._publish_llm_requires_proxy
_PUBLISH_OPENCODE_SESSION_ID = None
REASONING_EFFORTS_BY_MODEL = _publish_llm_client.REASONING_EFFORTS_BY_MODEL
REASONING_EFFORTS = _publish_llm_client.REASONING_EFFORTS
reasoning_efforts_for = _publish_llm_client.reasoning_efforts_for
normalize_reasoning_effort = _bind_llm_client('normalize_reasoning_effort')
STAGE_REASONING_EFFORT_TIERS = _publish_llm_client.STAGE_REASONING_EFFORT_TIERS
resolve_stage_reasoning_effort = _bind_llm_client('resolve_stage_reasoning_effort')
PublishSseTerminalEventMissingError = _publish_llm_client.PublishSseTerminalEventMissingError
parse_publish_sse_response = _bind_llm_client('parse_publish_sse_response')
_publish_opencode_session_id = _bind_llm_client('_publish_opencode_session_id')
PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS = _publish_llm_client.PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS
PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS = _publish_llm_client.PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS


class _PublishLLMRedirectError(urllib.error.HTTPError):
    """Redirect denial without retaining a URL, headers or provider body."""

    def __init__(self, code):
        super().__init__('', code, '模型请求禁止自动重定向', {}, None)


class _PublishLLMNoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward model credentials or payloads through an HTTP redirect."""

    def http_error_302(self, req, fp, code, msg, headers):
        if fp is not None:
            try:
                fp.close()
            except Exception:
                pass
        raise _PublishLLMRedirectError(code) from None

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.http_error_302(req, fp, code, msg, headers)


def _enable_tcp_keepalive(sock):
    mod = globals().get('_publish_llm_client')
    if mod is None:
        import sys as _sys
        from pathlib import Path as _Path
        _scripts = next((d for b in (*(_Path(x) for x in _sys.path if x), _Path.cwd()) for c in (b, *b.parents) for d in (c, c / 'scripts') if (d / ('publish_llm_client' + '.py')).is_file()), None)
        if _scripts is not None and str(_scripts) not in _sys.path:
            _sys.path.insert(0, str(_scripts))
        mod = __import__('publish_llm_client')
        globals()['_publish_llm_client'] = mod
    with mod._hooks_scope(globals()):
        return mod._enable_tcp_keepalive(sock)


class _KeepAliveHTTPConnection(http.client.HTTPConnection):
    """将 TCP 连接 + 代理 CONNECT + TLS 握手统一限制在 60s 有效预算内，握手完成后再切换为读取/SSE 空闲超时。"""

    @staticmethod
    def _client_mod():
        mod = globals().get('_publish_llm_client')
        if mod is None:
            import sys as _sys
            from pathlib import Path as _Path
            _scripts = next((d for b in (*(_Path(x) for x in _sys.path if x), _Path.cwd()) for c in (b, *b.parents) for d in (c, c / 'scripts') if (d / ('publish_llm_client' + '.py')).is_file()), None)
            if _scripts is not None and str(_scripts) not in _sys.path:
                _sys.path.insert(0, str(_scripts))
            mod = __import__('publish_llm_client')
            globals()['_publish_llm_client'] = mod
        return mod

    def __init__(self, *args, connect_timeout=None, read_timeout=None, **kwargs):
        mod = self._client_mod()
        with mod._hooks_scope(globals()):
            mod._keepalive_http_init(self, connect_timeout=connect_timeout, read_timeout=read_timeout)
        super().__init__(*args, **kwargs)

    def _apply_handshake_remaining(self):
        mod = self._client_mod()
        with mod._hooks_scope(globals()):
            mod._keepalive_http_apply_handshake_remaining(self)

    def _tunnel(self):
        mod = self._client_mod()
        with mod._hooks_scope(globals()):
            mod._keepalive_http_tunnel(self, super()._tunnel)

    def connect(self):
        mod = self._client_mod()
        with mod._hooks_scope(globals()):
            mod._keepalive_http_connect(self, super().connect)


class _KeepAliveHTTPSConnection(_KeepAliveHTTPConnection, http.client.HTTPSConnection):
    pass


class _KeepAliveHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, *args, connect_timeout=None, read_timeout=None, **kwargs):
        super().__init__(*args, **kwargs)
        default_connect = globals().get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
        self._connect_timeout = default_connect if connect_timeout is None else connect_timeout
        self._read_timeout = read_timeout

    def http_open(self, req):
        return self.do_open(
            _KeepAliveHTTPConnection,
            req,
            connect_timeout=self._connect_timeout,
            read_timeout=self._read_timeout,
        )


class _KeepAliveHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, *args, connect_timeout=None, read_timeout=None, **kwargs):
        super().__init__(*args, **kwargs)
        default_connect = globals().get('PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS', 60.0)
        self._connect_timeout = default_connect if connect_timeout is None else connect_timeout
        self._read_timeout = read_timeout

    def https_open(self, req):
        return self.do_open(
            _KeepAliveHTTPSConnection,
            req,
            context=self._context,
            connect_timeout=self._connect_timeout,
            read_timeout=self._read_timeout,
        )


def _read_publish_http_error(exc):
    mod = globals().get('_publish_llm_client')
    if mod is None:
        import sys as _sys
        from pathlib import Path as _Path
        _scripts = next((d for b in (*(_Path(x) for x in _sys.path if x), _Path.cwd()) for c in (b, *b.parents) for d in (c, c / 'scripts') if (d / ('publish_llm_client' + '.py')).is_file()), None)
        if _scripts is not None and str(_scripts) not in _sys.path:
            _sys.path.insert(0, str(_scripts))
        mod = __import__('publish_llm_client')
        globals()['_publish_llm_client'] = mod
    with mod._hooks_scope(globals()):
        return mod._read_publish_http_error(exc)


def _sanitize_publish_llm_error(value, api_keys=()):
    mod = globals().get('_publish_llm_client')
    if mod is None:
        import sys as _sys
        from pathlib import Path as _Path
        _scripts = next((d for b in (*(_Path(x) for x in _sys.path if x), _Path.cwd()) for c in (b, *b.parents) for d in (c, c / 'scripts') if (d / ('publish_llm_client' + '.py')).is_file()), None)
        if _scripts is not None and str(_scripts) not in _sys.path:
            _sys.path.insert(0, str(_scripts))
        mod = __import__('publish_llm_client')
        globals()['_publish_llm_client'] = mod
    with mod._hooks_scope(globals()):
        return mod._sanitize_publish_llm_error(value, api_keys=api_keys)


def _open_publish_json_with_account_pool(
    *, api_url, endpoint, model, api_type, api_keys, payload, opener, timeout,
    state_file=None, usage_sink=None, usage_directory=None, affinity_key=None,
):
    """已确认的 Go 配额/余额失败才在同一次逻辑请求内切换到下一个账号（每个账号至多一次）。"""
    mod = globals().get('_publish_llm_client')
    if mod is None:
        import sys as _sys
        from pathlib import Path as _Path
        _scripts = next((d for b in (*(_Path(x) for x in _sys.path if x), _Path.cwd()) for c in (b, *b.parents) for d in (c, c / 'scripts') if (d / ('publish_llm_client' + '.py')).is_file()), None)
        if _scripts is not None and str(_scripts) not in _sys.path:
            _sys.path.insert(0, str(_scripts))
        mod = __import__('publish_llm_client')
        globals()['_publish_llm_client'] = mod
    with mod._hooks_scope(globals()):
        return mod._open_publish_json_with_account_pool(
            api_url=api_url,
            endpoint=endpoint,
            model=model,
            api_type=api_type,
            api_keys=api_keys,
            payload=payload,
            opener=opener,
            timeout=timeout,
            state_file=state_file,
            usage_sink=usage_sink,
            usage_directory=usage_directory,
            affinity_key=affinity_key,
        )


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
    usage_context=None,
    usage_sink=None,
    usage_directory=None,
):
    """调用发布阶段模型。required=True 时，缺配置或连续失败会抛错。"""
    mod = globals().get('_publish_llm_client')
    if mod is None:
        import sys as _sys
        from pathlib import Path as _Path
        _scripts = next((d for b in (*(_Path(x) for x in _sys.path if x), _Path.cwd()) for c in (b, *b.parents) for d in (c, c / 'scripts') if (d / ('publish_llm_client' + '.py')).is_file()), None)
        if _scripts is not None and str(_scripts) not in _sys.path:
            _sys.path.insert(0, str(_scripts))
        mod = __import__('publish_llm_client')
        globals()['_publish_llm_client'] = mod
    with mod._hooks_scope(globals()):
        return mod.call_publish_llm_api(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            required=required,
            context=context,
            timeout=timeout,
            max_retries=max_retries,
            images=images,
            use_secondary=use_secondary,
            structured_output=structured_output,
            usage_context=usage_context,
            usage_sink=usage_sink,
            usage_directory=usage_directory,
        )


def review_issue_severity(issue):
    if isinstance(issue, dict):
        return str(issue.get('severity', 'warning')).lower()
    return 'error'


def is_blocking_review_issue(issue):
    return review_issue_severity(issue) == 'error'


def count_blocking_review_issues(issues):
    return sum(1 for issue in issues if is_blocking_review_issue(issue))


def interpret_readonly_text_unit(content, result):
    """Interpret one model unit without editing bytes or issuing permission.

    Workflow-specific checkpoints and whole-page false-positive checks remain
    with callers. Proposed edits are findings to return to generation, never a
    replacement page or a successful unit cache.
    """
    if not isinstance(content, str):
        raise ValueError('只读文本审查需要原始字符串。')
    if not isinstance(result, (tuple, list)) or len(result) != 3 \
            or not isinstance(result[0], bool) or not isinstance(result[1], list) \
            or any(not isinstance(issue, dict) for issue in result[1]) \
            or not isinstance(result[2], str):
        passed, issues = review_protocol_failure('只读文本 review', '响应不完整')
        return passed, issues, content
    passed, findings, proposed = result
    issues = list(findings)
    if proposed != content:
        issues.append({'severity': 'error', 'type': 'readonly_change',
                       'description': '模型建议修改最终页面；审查阶段不能写回文件，请回到生成阶段修复后重新审查。'})
        passed = False
    if not passed and count_blocking_review_issues(issues) == 0:
        _unused, failures = review_protocol_failure('只读文本 review', '明确未通过但缺少有效阻断原因')
        issues.extend(failures)
    return passed and count_blocking_review_issues(issues) == 0, issues, proposed


def classify_review_failure(issues):
    """Shared classification; a transport failure is not a content rejection."""
    blocking = [issue for issue in (issues or []) if is_blocking_review_issue(issue)]
    if not blocking:
        return None
    def transient(issue):
        if not isinstance(issue, dict):
            return False
        kind = issue.get('type')
        if kind == 'infrastructure':
            return True
        # Scientific protocols, inference timeouts and unavailable resources are
        # content. Only trusted diagnostic envelopes classify legacy failures.
        if kind not in (None, '', 'protocol'):
            return False
        description = str(issue.get('description', '')).lower()
        if kind == 'protocol' and description == '页面审查未通过，但结果没有列出阻断问题':
            return True
        if description.startswith('无法加载图片内容用于多模态 review:'):
            return any(marker in description for marker in (
                '下载失败', '超时', '绝对截止时间', 'timeout', 'unavailable'))
        return bool(re.match(
            r'^(?:llm(?:\s+文本)?\s+review|多模态图片\s+review|正文[^\n]{0,30}review|页面审查|审查执行)'
            r'[^\n]{0,300}(?:连续失败|调用失败|返回非 json|响应不完整|协议校验失败|缺少有效)',
            description))
    if all(transient(issue) for issue in blocking):
        return 'transient'
    return 'content'


def unchanged_content_rejection_blocks_retry(*, same_input, completed, failure_kind,
                                             previous_protocol, current_protocol):
    """A negative cache gate, never a request or publication permission."""
    if not same_input or failure_kind != 'content':
        return False
    changed_protocol = (completed is True
                        and re.fullmatch(r'[0-9a-f]{64}', str(previous_protocol or ''))
                        and re.fullmatch(r'[0-9a-f]{64}', str(current_protocol or ''))
                        and previous_protocol != current_protocol)
    return not bool(changed_protocol)


def review_protocol_failure(context, message):
    """为格式错误或无法判定的审查输出构造阻断问题。"""
    return False, [{
        'severity': 'error',
        'type': 'infrastructure',
        'description': f'{context} 协议校验失败：{message}',
    }]


def validate_review_payload(review, *, required=False, context='LLM review', issue_fields=()):
    """校验结构化审查输出；required 模式下按失败处理。"""
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
                'type': 'model_content',
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
        inconclusive_pattern = (
            r'无法判断|不能判断|不确定(?!性)|cannot\s+determine|unable\s+to\s+determine|\buncertain\b|\bindeterminate\b'
            if (passed is True and severity == 'info')
            else r'无法判断|不能判断|无法确认|不确定(?!性)|cannot\s+determine|unable\s+to\s+determine|\buncertain\b|\bindeterminate\b'
        )
        if required and re.search(
            inconclusive_pattern,
            description or '',
            flags=re.IGNORECASE,
        ):
            snippet = re.sub(r'\s+', ' ', (description or '').strip())[:120]
            return review_protocol_failure(
                context,
                f'issues[{index}] 表示无法确定审查结论（{snippet}）',
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
        # Provider-controlled issues cannot impersonate the diagnostic types
        # emitted by our own exception/protocol handlers. Raw responses remain
        # in the original request audit; this only classifies the display result.
        if normalized.get('type') in (None, '', 'infrastructure', 'protocol'):
            normalized['type'] = 'model_content'
        normalized['severity'] = severity
        normalized['description'] = str(description or '')
        if 'fix_instruction' in issue_fields and issue.get('auto_fixable') is False:
            normalized.setdefault('fix_instruction', '')
        normalized_issues.append(normalized)

    has_error = any(issue['severity'] == 'error' for issue in normalized_issues)
    if not passed and not has_error:
        normalized_issues.append({
            'severity': 'error',
            'type': 'infrastructure',
            'description': f'{context} 返回 passed=false，但没有提供 error 级原因',
        })
        has_error = True
    if passed and has_error:
        passed = False
    return passed, normalized_issues


def load_papers(data_file=None):
    """读取论文列表；未指定文件时使用当前正式分析结果。"""
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
    """读取指定发布日期的分析资料；未显式指定文件时，由受控日期解析器选择当前结果或归档。"""
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
    """使用不可变的抓取批次日期，严格回退到北京时间的 fetchedAt。"""
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
    """把下游渠道内容绑定到远端已核验的那份博客快照。"""
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
    if not source_bound_generation(manifest):
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
        or not strict_receipt(receipt)
        or ('contract' in manifest and not matches_snapshot_receipt(manifest, receipt))
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


def is_publish_currency_literal(value):
    """整个单元格只有一个明确的美元金额，绝不算作公式。"""
    return bool(re.fullmatch(
        r'\s*\$\d+(?:,\d{3})*(?:\.\d+)?'
        r'(?:\s*/\s*(?:[1-9]\d*|[A-Za-z][A-Za-z0-9_-]*))?\s*',
        value,
    ))


def is_publish_currency_unit_literal(value):
    """Recognize a cost/price label with a standalone dollar unit, never TeX."""
    # 列名后面常带排序箭头（Cost ($) ↓），箭头不属于标签本身。
    normalized = re.sub(r'\s*[\u2191\u2193\u25b2\u25bc]\s*$', '', str(value or ''))
    label = re.fullmatch(r'\s*([A-Za-z\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff /-]*)\s*\(\s*\$\s*\)\s*', normalized)
    return bool(label and re.search(
        r'\b(?:cost|price|fees?|budget)\b|成本|费用|价格|预算|美元', label[1], re.I))


def decode_publish_currency_unit_display(value):
    """Decode only the one display escape of a complete literal currency unit."""
    if not isinstance(value, str) or value.count(r'\$') != 1:
        return value
    decoded = value.replace(r'\$', '$')
    return decoded if is_publish_currency_unit_literal(decoded) else value


def strict_source_cell_math_display(value):
    """Project only complete, exact same-value duplicate source-cell forms."""
    if not isinstance(value, str) or not value or len(value) > 512 or '\n' in value or '\r' in value:
        return None
    text = value
    number = r'(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)'
    scalar = rf'[+−-]?{number}'
    # The whole original cell must contain two byte-identical coefficients and
    # explicit exponents. Preserve precision/signs; never infer a bare split.
    scientific = re.fullmatch(rf'({scalar})×10([+−-]?[0-9]{{1,6}})\1\\times[ \t]*10\^\{{\2\}}', text)
    if scientific:
        superscript = str.maketrans('+-−0123456789', '⁺⁻⁻⁰¹²³⁴⁵⁶⁷⁸⁹')
        return {**protocol_record_header('source-cell-math-display', 'source-cell-math-display'), 'kind': 'scientific-notation-duplicate',
                'sourceText': value, 'sourceTextSha256': hashlib.sha256(value.encode('utf-8')).hexdigest(),
                'displayText': scientific[1] + '×10' + scientific[2].translate(superscript)}
    # This exact flattened unit has two literal U+200B characters. Its second
    # scalar must preserve every numeric byte; no original MathML is inferred.
    unit_duplicate = re.fullmatch(rf'({scalar})\u200bm\u200bs\1ms', text)
    if unit_duplicate:
        return {**protocol_record_header('source-cell-math-display', 'source-cell-math-display'), 'kind': 'zero-width-unit-duplicate',
                'sourceText': value, 'sourceTextSha256': hashlib.sha256(value.encode('utf-8')).hexdigest(),
                'displayText': f'{unit_duplicate[1]} ms'}
    duplicate = re.fullmatch(r'([^\\{}]+?)(¯?)\\(underline|mathbf)\{([^{}]+)\}', text)
    visible = re.fullmatch(rf'({scalar})[ \t]*±[ \t]*({number})', duplicate[1].rstrip(' \t')) if duplicate else None
    tex = re.fullmatch(rf'({scalar})[ \t]*\\pm[ \t]*({number})', duplicate[4].strip(' \t')) if duplicate else None
    if duplicate and visible and tex and visible[1] == tex[1] and visible[2] == tex[2] \
            and (not duplicate[2] or duplicate[3] == 'underline'):
        return {**protocol_record_header('source-cell-math-display', 'source-cell-math-display'), 'kind': 'numeric-style-duplicate',
                'sourceText': value, 'sourceTextSha256': hashlib.sha256(value.encode('utf-8')).hexdigest(),
                'displayText': f'{visible[1]} ± {visible[2]}', 'style': duplicate[3]}
    # A bounded nested power has one explicit TeX annotation. Its flattened
    # prefix must match every base/exponent character, including trailing zeros.
    power = re.fullmatch(
        r'(?:(?P<label>[A-Za-z]{1,16}) )?(?P<visible>\[[1-9][0-9]{0,11}\][1-9][0-9]{0,5})'
        r'(?P<tex>\[[1-9][0-9]{0,5}(?:\^\{[1-9][0-9]{0,5}\})?\]\^\{[1-9][0-9]{0,5}\})', text)
    if power and power['visible'] == re.sub(r'[\^{}]', '', power['tex']):
        prefix = power['label'] + ' ' if power['label'] else ''
        return {**protocol_record_header('source-cell-math-display', 'source-cell-math-display'), 'kind': 'nested-power-duplicate',
                'sourceText': value, 'sourceTextSha256': hashlib.sha256(value.encode('utf-8')).hexdigest(),
                'displayText': prefix + r'\(' + power['tex'] + r'\)'}
    # MathML exposes a flattened identifier before its literal TeX annotation.
    # A subscript and superscript may be flattened in either visual order, but
    # every base/script character must match; no symbol or value is inferred.
    identifier = re.fullmatch(
        r'(?P<visible>[A-Za-z][A-Za-z0-9\u200b-\u200d\u2061\ufeff]{0,80})'
        r'(?P<tex>[A-Za-z](?:[_^]\{[A-Za-z0-9]{1,16}\}){1,2})', text)
    if identifier:
        atoms = re.findall(r'([_^])\{([A-Za-z0-9]{1,16})\}', identifier['tex'])
        kinds = [kind for kind, _ in atoms]
        flattened = re.sub(r'[\u200b-\u200d\u2061\ufeff]', '', identifier['visible'])
        base = identifier['tex'][0]
        allowed = {base + ''.join(value for _, value in atoms),
                   base + ''.join(value for _, value in reversed(atoms))}
        if len(set(kinds)) == len(kinds) and flattened in allowed:
            return {**protocol_record_header('source-cell-math-display', 'source-cell-math-display'), 'kind': 'identifier-script-duplicate',
                    'sourceText': value, 'sourceTextSha256': hashlib.sha256(value.encode('utf-8')).hexdigest(),
                    'displayText': r'\(' + identifier['tex'] + r'\)'}
    return None


def escape_markdown_table_currency_units(text):
    """Escape only literal dollar units in actual table cells, preserving view text."""
    lines = text.splitlines(keepends=True)
    output, fence, width = [], None, 0
    for index, line in enumerate(lines):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})([^\r\n]*)', line)
        if marker:
            if fence is None:
                fence = (marker[1][0], len(marker[1]))
            elif (fence[0] == marker[1][0] and len(marker[1]) >= fence[1]
                  and not marker[2].strip()):
                fence = None
            width = 0
        if fence is None and marker is None and re.match(r'^ {0,3}\|', line):
            if index + 1 < len(lines) and _is_markdown_table_separator(lines[index + 1]):
                width = len(split_markdown_table_row(lines[index + 1]))
            if width and not _is_markdown_table_separator(line) and len(split_markdown_table_row(line)) == width:
                pipes = list(re.finditer(r'(?<!\\)\|', line))
                for left, right in reversed(list(zip(pipes, pipes[1:]))):
                    cell = line[left.end():right.start()]
                    if is_publish_currency_unit_literal(cell):
                        line = line[:left.end()] + cell.replace('$', r'\$') + line[right.start():]
            elif not _is_markdown_table_separator(line):
                width = 0
        else:
            width = 0
        output.append(line)
    return ''.join(output)


def publish_table_currency_spans(text):
    """只在既有的 Markdown 表格单元格里匹配单独出现的美元金额。

    MathJax 只在同一个 HTML 父元素内配对定界符。被接受的单元格恰好含
    一个美元符号，并且自身就是一个 td；正文被刻意排除。返回保持字节
    不变的字符区间，供渲染器和格式闸共用。
    """
    spans = []
    offset = 0
    table_width = 0
    previous = ''
    previous_offset = 0

    def scan_row(line, line_offset, expected_width=None):
        pipes = list(re.finditer(r'(?<!\\)\|', line))
        if expected_width is not None and len(split_markdown_table_row(line)) != expected_width:
            return
        for left, right in zip(pipes, pipes[1:]):
            cell = line[left.end():right.start()]
            if is_publish_currency_literal(cell) or is_publish_currency_unit_literal(cell):
                start = left.end() + len(cell) - len(cell.lstrip())
                spans.append((line_offset + start,
                              line_offset + right.start() - len(cell) + len(cell.rstrip())))

    for line in text.splitlines(keepends=True):
        if _is_markdown_table_separator(line) and previous.lstrip().startswith('|'):
            table_width = len(split_markdown_table_row(line))
            # 表头行也要扫：Cost ($) 这类列名是合法的单一美元单位。
            scan_row(previous, previous_offset)
        elif table_width and line.lstrip().startswith('|'):
            scan_row(line, offset, table_width)
        else:
            table_width = 0
        previous = line
        previous_offset = offset
        offset += len(line)
    return spans


def normalize_markdown_table_inr_currency(text):
    """归一化 INR/USD 混用的表格单元格，不去猜公式。

    来源绑定的表格可能出现 ``INR 6,499 / $74.49`` 这样的备注。这个单元格
    不适用上面那条例外（只允许单一币种），但同一格已经写了 INR，美元金额
    显然是货币。只对真正的 Markdown 表格单元格、以及后面紧跟单元格边界或
    标点的美元金额做修复；正文和疑似公式的表达式不动，因此按失败处理。
    """
    output = []
    fence = None
    amount = re.compile(
        r'(?<![\\$])\$(\d+(?:,\d{3})*(?:\.\d+)?)(?![\d$])'
        r'(?=\s*(?:\||[,.;:，。；：!?！？)\]]|$))'
    )
    for line in str(text or '').splitlines(keepends=True):
        fence_match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            output.append(line)
            continue
        if fence is None and line.lstrip().startswith('|') and not _is_markdown_table_separator(line):
            pipes = list(re.finditer(r'(?<!\\)\|', line))
            rebuilt = []
            cursor = 0
            for left, right in zip(pipes, pipes[1:]):
                rebuilt.append(line[cursor:left.end()])
                cell = line[left.end():right.start()]
                if re.search(r'(?<![A-Za-z])INR(?![A-Za-z])', cell, flags=re.IGNORECASE):
                    cell = amount.sub(r'\1 美元', cell)
                rebuilt.append(cell)
                cursor = right.start()
            if rebuilt:
                rebuilt.append(line[cursor:])
                line = ''.join(rebuilt)
        output.append(line)
    return ''.join(output)


def fix_latex_delimiters(text):
    r"""转换明确的数学定界符；不把金额、代码或跨表格单元格内容当公式。"""
    if not text:
        return text
    # LaTeXML 会把 \\text 里的字面花括号序列化成私有宏；只解码这些已知标记，
    # 还原成标准 TeX 写法。
    text = text.replace(r'\lx@text@lbrace', r'\{')
    text = text.replace(r'\lx@text@rbrace', r'\}')
    text = normalize_markdown_table_inr_currency(text)
    text = escape_markdown_table_currency_units(text)
    # 这些是来源中的字面字节，不是可以改写成公式的正文。未闭合的围栏块
    # 保守地一直保护到文件末尾。
    protected = re.compile(
        r'^[ \t]{0,3}(?P<fence>`{3,}|~{3,})[^\n]*(?:\n|$).*?'
        r'(?:^[ \t]{0,3}(?P=fence)(?![`~])[ \t]*(?:\n|$)|\Z)'
        r'|(?P<ticks>`+)(?!`).*?(?<!`)(?P=ticks)(?!`)'
        r'|https?://[^\s<>()]+',
        re.MULTILINE | re.DOTALL,
    )

    def convert_prose(prose):
        prose = re.sub(r'(\^|_)\{<([a-zA-Z])\}', r'\1{\\lt \2}', prose)
        prose = re.sub(r'(?<!\\)\$\$(.+?)\$\$', r'\\[\1\\]', prose, flags=re.DOTALL)
        # 读者有时会把价格区间写成 ``$100-200 USD``。它与表格单元格里单独出现
        # 的美元金额不同，不是合法的 Markdown 货币写法：格式闸把它当成可能的
        # 公式定界符，这是对的。这里让金额保持可读，同时把币种写明确。要求
        # 带显式的 USD 标记，是为了让 ``$5 + 2`` 这类表达式按失败处理，而不是
        # 猜成金额。
        prose = re.sub(
            r'(?<![\\$])\$(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*[-–]\s*\$?(\d+(?:,\d{3})*(?:\.\d+)?))?'
            r'\s*(USD|US dollars?)\b',
            lambda match: (
                f'{match.group(1)}'
                + (f'–{match.group(2)}' if match.group(2) else '')
                + ' 美元'
            ),
            prose,
            flags=re.IGNORECASE,
        )
        # 有些读者省略币种后缀，但正文里用的是带小数的金额（例如
        # ``$113.54，高于 $93.80``）。只把整数部分至少两位、且带小数部分的金额
        # 当货币；这个狭窄的形态会让 ``$5 + 2`` 和有歧义的 ``$20, $30 and $40``
        # 按失败处理。
        prose = re.sub(
            r'(?<![\\$])\$(\d{2,}(?:,\d{3})*\.\d+)'
            r'(?=\s*(?:[，。；：、,.!?！？)\]]|$|[\u3400-\u9fff]))',
            r'\1 美元',
            prose,
        )
        # 中文语境下紧邻汉字的个位数小数金额（例如 ``约 $7.8 每分钟``、``与 $1.9 ，``），
        # 要求前紧邻汉字（可带单个空格）且后接中文或标点/行尾，避免误改 ``$0.2``、``$0.2 and $1.0``
        # 或 ``$5.2 + x`` 这类裸金额或公式表达式。
        prose = re.sub(
            r'([\u3400-\u9fff][ \t]?)(?<![\\$])\$(\d\.\d+)'
            r'(?=[ \t]*(?:[，。；：、,.!?！？)\]]|$|[\u3400-\u9fff]))',
            r'\1\2 美元',
            prose,
        )
        # 明确中文价格语境下的整数美元（如“标价 $110 且仍需另配这些部件”），
        # 后面只能跟中文正文或标点，避免把 ``$5 + 2`` 或无语境英文列表误判成货币。
        prose = re.sub(
            r'((?:标价|售价|定价|单价|成本|价格|总价|预算|报价|物料(?:总价|成本)?)(?:约|为|约为|约合|高达|低至|仅|仅需|不足|超过|高于|低于)?\s*)'
            r'(?<![\\$])\$(\d+(?:,\d{3})*)(?=\s*(?:[，。；：、,.!?！？)\]]|$|[\u3400-\u9fff]))',
            r'\1\2 美元',
            prose,
        )

        def inline_math(match):
            body = match.group(1)
            line_start = prose.rfind('\n', 0, match.start()) + 1
            line_end = prose.find('\n', match.end())
            line = prose[line_start:line_end if line_end >= 0 else len(prose)]
            # Markdown 表格里未转义的竖线是单元格边界，不能据此把两个单元格里的
            # 美元符号配成一对。表格之外，普通条件概率公式沿用原有写法。
            if line.lstrip().startswith('|') and re.search(r'(?<!\\)\|', body):
                return match.group(0)
            return r'\(' + body + r'\)'

        # 收尾的美元符号必须紧跟非空白字符，且不能开启下一个数字金额。行内公式
        # 不能跨行。因此 $0.2 | $1.0/1000 保持原样，而 $x$、$5$ 和同单元格内的
        # 公式仍然会转换。
        converted = re.sub(
            r'(?<![\\$])\$(?!\$)([^\s$](?:[^$\n]*?[^\s$])?)\$(?![\d$])',
            inline_math,
            prose,
        )

        # 仅对明确含 TeX 命令或上下标的带内边距单行行内公式（如 ``$ \hat{d}(t) = d_c + \hat{d}_{res}(t) $``）
        # 转为 ``\(...\)``，避免 ``$ 5 + 2 $`` 或两个被中文隔开的裸金额被误转为公式。
        def spaced_tex_inline_math(match):
            raw_inner = match.group(1)
            body = raw_inner.strip()
            if not body or raw_inner == body:
                return match.group(0)
            if re.match(r'^\d', body):
                return match.group(0)
            if not re.search(r'\\[A-Za-z]+|[A-Za-z][_^](?:\{[^}]+\}|[A-Za-z0-9])', body):
                return match.group(0)
            line_start = converted.rfind('\n', 0, match.start()) + 1
            line_end = converted.find('\n', match.end())
            line = converted[line_start:line_end if line_end >= 0 else len(converted)]
            if line.lstrip().startswith('|') and re.search(r'(?<!\\)\|', body):
                return match.group(0)
            return r'\(' + body + r'\)'

        converted = re.sub(
            r'(?<![\\$])\$(?!\$)([ \t]*[^$\n\u3400-\u9fff]+?[ \t]*)\$(?![\d$])',
            spaced_tex_inline_math,
            converted,
        )
        # 少数 arXiv 图注有 TeX 起始定界符，却在单位前漏掉收尾的 ``$``（例如
        # ``f_s=$16\,kHz``）。这种“数字 + TeX 细空格 + 单位”的窄形态是明确的
        # 公式，不是金额；按普通图注文本保留原意。
        return re.sub(
            r'(?<![\\$])\$(\d+(?:\.\d+)?)(?:\\+,)([A-Za-z][A-Za-z0-9]*)\b',
            r'\1 \2',
            converted,
        )

    output = []
    cursor = 0
    protected_spans = [(match.start(), match.end()) for match in protected.finditer(text)]
    protected_spans.extend(publish_table_currency_spans(text))
    for start, end in sorted(protected_spans):
        if start < cursor:
            continue
        output.append(convert_prose(text[cursor:start]))
        output.append(text[start:end])
        cursor = end
    output.append(convert_prose(text[cursor:]))
    return ''.join(output)


def _split_starting_frontmatter(text):
    """只切分文首真正的 YAML frontmatter（支持 LF 与 CRLF），不触碰正文中的 --- 分隔线。"""
    value = str(text or '')
    match = re.match(r'\A(---\r?\n)(?:([\s\S]*?)(\r?\n))?(---(?:\r?\n|\Z))', value)
    if not match:
        return '', '', '', '', value
    return (
        match.group(1),
        match.group(2) or '',
        match.group(3) or '',
        match.group(4),
        value[match.end():],
    )


def _protect_markdown_fences(text, marker_prefix, protected_fences):
    """按 CommonMark 围栏规则保护 ``` 与 ~~~ 代码块，避免内部文本被正则误改。"""
    lines = str(text or '').splitlines(keepends=True)
    output = []
    fence = None
    buf = []
    for line in lines:
        marker = re.match(r'^[ \t]{0,3}(`{3,}|~{3,})', line)
        if fence is None:
            if marker:
                token = marker.group(1)
                fence = (token[0], len(token))
                buf = [line]
            else:
                output.append(line)
        else:
            buf.append(line)
            if (
                marker
                and marker.group(1)[0] == fence[0]
                and len(marker.group(1)) >= fence[1]
                and not line[marker.end():].strip()
            ):
                protected_fences.append(''.join(buf))
                output.append(f'{marker_prefix}FENCE_{len(protected_fences) - 1}_END')
                fence = None
                buf = []
    if buf:
        protected_fences.append(''.join(buf))
        output.append(f'{marker_prefix}FENCE_{len(protected_fences) - 1}_END')
    return ''.join(output)


def escape_html_like_tags(text):
    r"""转义论文中可能被 Hugo 解析为 HTML 的标记。"""
    if not text:
        return text
    marker_prefix = 'PD_PUBLISH_HTML_LITERAL_'
    while marker_prefix in text:
        marker_prefix += 'X'
    protected_fences = []
    text = _protect_markdown_fences(text, marker_prefix, protected_fences)
    # 先保护完整的行内代码段（包含多行代码 span、多反引号与单行反引号），再执行含空白尖括号
    # 与原始 HTML 式标签的转义。否则像 ``在 `if (a < b && c > d)` 中`` 这样的合法代码段会被
    # `<[^>\n]*\s[^>\n]*>` 破坏为实体；像 `` `turn off <EOT>` `` 也会被误拆。
    # 同时保留对模型误套的“双反引号收尾”未配对控制记号（如 `` `turn off `<EOT>``）的显式修复：
    # 当紧跟单反引号代码段后的 `<Tag>`` ` 未被后续任何代码段配对时，将其并入并实体化为字面记号。
    protected_code = []
    inline_spans = markdown_inline_code_ranges(text)
    if inline_spans:
        malformed_tail_re = re.compile(r'<([A-Za-z][A-Za-z0-9_†-]{0,40})>``(?!`)')
        rebuilt = []
        cursor = 0
        for idx, (span_start, span_end) in enumerate(inline_spans):
            if span_start < cursor:
                continue
            rebuilt.append(text[cursor:span_start])
            span_text = text[span_start:span_end]
            next_span_start = inline_spans[idx + 1][0] if idx + 1 < len(inline_spans) else len(text)
            if (
                len(span_text) >= 2
                and span_text.startswith('`')
                and not span_text.startswith('``')
                and span_text.endswith('`')
                and not span_text.endswith('``')
                and '\n' not in span_text
            ):
                tail_match = malformed_tail_re.match(text, span_end)
                if tail_match and tail_match.end() <= next_span_start:
                    span_text = f'`{span_text[1:-1]}&lt;{tail_match.group(1)}&gt;`'
                    span_end = tail_match.end()
            protected_code.append(span_text)
            rebuilt.append(f'{marker_prefix}CODE_{len(protected_code) - 1}_END')
            cursor = span_end
        rebuilt.append(text[cursor:])
        text = ''.join(rebuilt)
    # 幂等：只把自己上次产出的、且会被下方规则重新转义的实体还原成字面尖括号
    # （含空白的迷你记号）。比较用的 &lt;1 或 &lt;details&gt;、&lt;EOT&gt; 保持原样；
    # 行内代码段已于上方保护，因此代码段内的实体绝不会被还原或改写。
    text = re.sub(r'&lt;([^>\n]*\s[^>\n]*)&gt;', r'<\1>', text)
    # 读者正文里常引用 ``<1 2>``、``<a b c>`` 这类迷你语言记号。它们不是标签，
    # 但 CommonMark 仍会交给 HTML 解析器；不匹配的记号或带属性的记号会破坏
    # 渲染出来的嵌套结构。只转义含空白的尖括号片段，普通 URL 和显式标签
    # 的处理保持不变。
    text = re.sub(
        r'(?<![A-Za-z0-9`])<([^>\n]*\s[^>\n]*)>',
        lambda match: f'&lt;{match.group(1)}&gt;',
        text,
    )
    # ``publish-to-blog.py`` 为可折叠的评分区刻意输出这两个不含属性的容器
    # 标签。要在下面通用的论文记号转义之前保护它们；否则后面的通用转义会把
    # 我们自己的 UI 标记（``<details>``）变成行内代码，评分区不再折叠。
    # 带属性的和用户自己写的变体仍走常规清理。
    safe_containers = []

    def protect_safe_container(match):
        safe_containers.append(match.group(0))
        return f'{marker_prefix}CONTAINER_{len(safe_containers) - 1}_END'

    text = re.sub(
        r'</?(?:details|summary)>',
        protect_safe_container,
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r'(?<![a-zA-Z`])<(/?)([SEse])>(?![a-zA-Z0-9`])',
        r'`<\1\2>`',
        text,
    )
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
    # 紧跟字母/数字的非标准闭合控制标签（例如 `` `<answer>`X</answer> ``）仍会被
    # Goldmark 原样输出为裸 HTML 闭合标签，导致严格 HTML 嵌套检查失败；保留常见
    # 行内 HTML 闭合标签，仅转义其余非 HTML 闭合标签。
    _standard_html_closing_tags = frozenset({
        'a', 'abbr', 'b', 'cite', 'code', 'del', 'details', 'div', 'em', 'i',
        'ins', 'kbd', 'mark', 'p', 'q', 'samp', 'small', 'span', 'strong',
        'sub', 'summary', 'sup', 'u', 'var',
    })
    text = re.sub(
        r'(?<!`)</([A-Za-z][A-Za-z0-9_†-]{0,40})(?![A-Za-z0-9_†-])>',
        lambda match: (
            match.group(0)
            if match.group(1).lower() in _standard_html_closing_tags
            else f'`</{match.group(1)}>`'
        ),
        text,
    )
    literals = {
        **{f'{marker_prefix}FENCE_{index}_END': fence
           for index, fence in enumerate(protected_fences)},
        **{f'{marker_prefix}CONTAINER_{index}_END': tag
           for index, tag in enumerate(safe_containers)},
        **{f'{marker_prefix}CODE_{index}_END': code
           for index, code in enumerate(protected_code)},
    }
    # Restore whole tokens once: a token for index 1 must never replace the
    # prefix of index 10, and original literal marker text must stay literal.
    text = re.sub(re.escape(marker_prefix) + r'(?:FENCE|CODE|CONTAINER)_\d+_END',
                  lambda match: literals[match.group(0)], text)
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
    r"""修复文首 YAML frontmatter 中 tags/categories 流式数组行的双逗号问题。"""
    if not text:
        return text
    opening, frontmatter, sep, closing, body = _split_starting_frontmatter(text)
    if not opening:
        return text
    changed = False
    fixed_lines = []
    for line in frontmatter.splitlines(keepends=True):
        if re.match(r'^[ \t]*(?:tags|categories)[ \t]*:[ \t]*\[.*\][ \t]*\r?\n?$', line):
            updated = re.sub(r',\s*,+', ',', line)
            updated = re.sub(r',\s*\]', ']', updated)
            if updated != line:
                changed = True
                line = updated
        fixed_lines.append(line)
    if not changed:
        return text
    return opening + ''.join(fixed_lines) + sep + closing + body


def strip_raw_inline_html(text):
    r"""去掉裸行内 HTML 样式标签（b/i/u），保护代码块与行内代码，不跨行匹配。"""
    if not text:
        return text
    marker_prefix = 'PD_PUBLISH_INLINE_HTML_'
    while marker_prefix in text:
        marker_prefix += 'X'
    protected_fences = []
    working = _protect_markdown_fences(text, marker_prefix, protected_fences)
    protected_code = []
    inline_spans = markdown_inline_code_ranges(working)
    if inline_spans:
        rebuilt = []
        cursor = 0
        for span_start, span_end in inline_spans:
            rebuilt.append(working[cursor:span_start])
            protected_code.append(working[span_start:span_end])
            rebuilt.append(f'{marker_prefix}CODE_{len(protected_code) - 1}_END')
            cursor = span_end
        rebuilt.append(working[cursor:])
        working = ''.join(rebuilt)
    working = re.sub(
        r'<(b|i|u)(?:\s+[^>\n]*)?>([^\n]*?)</\1>',
        lambda m: m.group(2),
        working,
        flags=re.IGNORECASE,
    )
    literals = {
        **{f'{marker_prefix}FENCE_{index}_END': fence
           for index, fence in enumerate(protected_fences)},
        **{f'{marker_prefix}CODE_{index}_END': code
           for index, code in enumerate(protected_code)},
    }
    if literals:
        working = re.sub(
            re.escape(marker_prefix) + r'(?:FENCE|CODE)_\d+_END',
            lambda match: literals[match.group(0)],
            working,
        )
    return working


def fix_extraction_diacritic_damage(text):
    r"""修复 PDF 文本提取撕裂的变音符号，避免孤立反引号破坏 Markdown。

    PDF 提取会把重音从元音上撕下来，落成孤立的 ASCII 反引号与游离的
    ´ / 组合音标（例如 Yoruba → "Yor`ub´a"、Satosphere → "Satosph`ere"、
    Concrète → "Concr`ete"）。行内成对的反引号才是代码边界；字母夹住且
    左侧词干不是代码闭合符的反引号属于提取损伤，会打开永不闭合的代码段，
    最终 Markdown 检查会因此失败。此处只删除这类损伤反引号，并清理同源的
    游离锐音符与"空格 + 组合音标"孤儿，不触碰 YAML frontmatter、围栏代码
    和合法的成对行内代码。
    """
    if not text:
        return text
    opening, frontmatter, sep, closing, body = _split_starting_frontmatter(text)
    prefix = opening + frontmatter + sep + closing
    marker_prefix = 'PD_PUBLISH_DIACRITIC_'
    while marker_prefix in body:
        marker_prefix += 'X'
    protected_fences = []
    working = _protect_markdown_fences(body, marker_prefix, protected_fences)
    protected_code = []
    inline_spans = markdown_inline_code_ranges(working)
    if inline_spans:
        rebuilt = []
        cursor = 0
        for span_start, span_end in inline_spans:
            rebuilt.append(working[cursor:span_start])
            protected_code.append(working[span_start:span_end])
            rebuilt.append(f'{marker_prefix}CODE_{len(protected_code) - 1}_END')
            cursor = span_end
        rebuilt.append(working[cursor:])
        working = ''.join(rebuilt)
    repaired_lines = []
    for line in str(working).split('\n'):
        removals = []
        for match in re.finditer(r'([A-Za-z]+)`([A-Za-z]+)', line):
            run_start = match.start(1)
            if run_start > 0 and line[run_start - 1] == '`':
                continue  # 合法行内代码的闭合定界符，保持字节不变
            run_end = match.end(2)
            if run_end < len(line) and line[run_end] == '`':
                continue  # 合法行内代码的开启定界符（pre`code`post 形态）
            removals.append(run_start + len(match.group(1)))
        for index in reversed(removals):
            line = line[:index] + line[index + 1:]
        line = re.sub(r'(?<=[A-Za-z])´(?=[A-Za-z])', '', line)
        repaired_lines.append(line)
    working = '\n'.join(repaired_lines)
    # 提取器会把重音撕成“空格 + 组合音标”的孤儿。锐音/扬抑符（U+0300/U+0301）
    # 处于这种孤儿位置时是撕裂的字母重音，连同空格一起删除即可还原干净拼写
    # （Yorub ́a → Yoruba）；其余组合符（如数学 tilde “ ̃vf”）只去掉游离标记
    # 本身并保留空格，避免 where ̃vf 被粘成 wherevf。数学否定斜线
    # U+0337/U+0338 有独立语义，即使提取时出现在空格后也必须原样保留。
    working = re.sub(
        r' [̀-ͯ]',
        lambda match: match.group(0) if match.group(0)[1] in '\u0337\u0338'
        else ('' if match.group(0)[1] in '̀́' else ' '),
        working,
    )
    literals = {
        **{f'{marker_prefix}FENCE_{index}_END': fence
           for index, fence in enumerate(protected_fences)},
        **{f'{marker_prefix}CODE_{index}_END': code
           for index, code in enumerate(protected_code)},
    }
    if literals:
        working = re.sub(
            re.escape(marker_prefix) + r'(?:FENCE|CODE)_\d+_END',
            lambda match: literals[match.group(0)],
            working,
        )
    return prefix + working


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
            alt = f"论文图 {index}"
        count = seen.get(alt, 0) + 1
        seen[alt] = count
        if count > 1:
            # 「- 图 N」会被误读成论文图号；这里只是同说明配图在页面里的序号。
            alt = f"{alt}（页面第 {count} 张同说明配图）"
        return f"![{alt}]({url})"

    return re.sub(r'!\[([^\]]*)\]\(([^)\n]+)\)', repl, text)


def link_remote_images_to_original(text):
    """让博客中的远程论文图可点击打开原始分辨率，供手机缩放核对。"""
    if not text:
        return text
    return re.sub(
        # alt 文本里可能含转义的 Markdown 方括号（例如论文图注来的 ``\[5\]``）。
        # 把转义字符当作 alt 文本的一个原子，而不是在它的收尾方括号处停下。
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
    r"""修复文首 YAML frontmatter 中未闭合双引号（忽略转义引号，不触碰正文横线）。"""
    if not text:
        return text
    opening, frontmatter, sep, closing, body = _split_starting_frontmatter(text)
    if not opening:
        return text
    unescaped_quote_re = re.compile(r'(?<!\\)(?:\\\\)*"')
    fixed_lines = []
    changed = False
    for raw_line in frontmatter.splitlines(keepends=True):
        ending = ''
        if raw_line.endswith('\r\n'):
            line, ending = raw_line[:-2], '\r\n'
        elif raw_line.endswith('\n'):
            line, ending = raw_line[:-1], '\n'
        else:
            line = raw_line
        if (
            ':' in line
            and '"' in line
            and len(unescaped_quote_re.findall(line)) % 2 != 0
            and '[' not in line
            and ']' not in line
        ):
            key, value = line.split(':', 1)
            fixed_lines.append(
                f"{key}: {json.dumps(value.strip().strip(chr(34)), ensure_ascii=False)}{ending}"
            )
            changed = True
        else:
            fixed_lines.append(raw_line)
    if not changed:
        return text
    return opening + ''.join(fixed_lines) + sep + closing + body


def strip_internal_scoring_anchors(text):
    """从派生文本视图里去掉读者可见的评分来源标记。"""
    value = str(text or '')
    frontmatter = ''
    frontmatter_match = re.match(
        r'\A---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)',
        value,
    )
    if frontmatter_match:
        frontmatter = frontmatter_match.group(0)
        value = value[len(frontmatter):]
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
    # CJK 字符间的空格压缩只做锚点清理的善后，不得触碰 Markdown 表格行：
    # 表格字节由 source-binding SHA 绑定，修改空格也会使发布检查时计算的 SHA 与保存值不同。
    table_lines = set()
    for table in extract_markdown_tables(value):
        table_lines.update(range(table['start_line'], table['end_line'] + 1))
    lines = value.split('\n')
    for line_number, line in enumerate(lines):
        if line_number in table_lines:
            continue
        lines[line_number] = re.sub(r'(?<=[㐀-鿿])[ \t]+(?=[㐀-鿿])', '', line)
    return frontmatter + '\n'.join(lines)


def linkify_bare_https_urls(text):
    """把读者可见的裸 HTTPS URL 变成 Markdown 自动链接。

    frontmatter、围栏代码、行内代码、已有的 Markdown 链接/图片和已有的
    自动链接都保持字节不变。这样规范 URL 仍然精确，同时每个展示出来的
    资源在 Hugo 里都能点开。
    """
    value = str(text or '')
    invalid_url_suffix = re.compile(
        r'[，。；：！？、（）【】《》“”‘’\u3400-\u9fff]'
    )

    def repair_autolink(match):
        url = match.group(1)
        boundary = invalid_url_suffix.search(url)
        if not boundary:
            return match.group(0)
        return f'<{url[:boundary.start()]}>{url[boundary.start():]}'

    value = re.sub(r'<(https://[^>\s]+)>', repair_autolink, value)
    lines = value.splitlines(keepends=True)
    table_lines = set()
    for table in extract_markdown_tables(value):
        table_lines.update(range(table['start_line'], table['end_line'] + 1))
    in_frontmatter = bool(lines and lines[0].strip() == '---')
    frontmatter_closed = not in_frontmatter
    fence = None
    protected = re.compile(
        r'`+[^`\n]*`+'
        r'|!?\[[^\]\n]*\]\([^\n)]*\)'
        r'|<https://[^>\s]+>',
    )
    bare_url = re.compile(
        r'(?<![<(])https://[^\s<>()\[\]{}"\'`，。；：！？、（）【】《》“”‘’\u3400-\u9fff]+'
    )
    bare_known_host = re.compile(
        r'(?<![\w/@])(?:github\.com|gitlab\.com|huggingface\.co|'
        r'modelscope\.cn|arxiv\.org)/'
        r'[^\s<>()\[\]{}"\'`，。；：！？、（）【】《》“”‘’\u3400-\u9fff]+'
    )
    trailing = '.,;:!?，。；：！？、'

    def linkify_segment(segment):
        def autolink_raw(raw):
            url = raw.rstrip(trailing)
            suffix = raw[len(url):]
            return f'<{url}>{suffix}' if url else raw
        linked = bare_url.sub(lambda match: autolink_raw(match.group(0)), segment)
        return bare_known_host.sub(
            lambda match: autolink_raw(f'https://{match.group(0)}'),
            linked,
        )

    output = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if in_frontmatter and not frontmatter_closed:
            output.append(line)
            if index > 0 and stripped == '---':
                frontmatter_closed = True
            continue
        if index in table_lines:
            output.append(line)
            continue
        fence_match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            output.append(line)
            continue
        if fence is not None:
            output.append(line)
            continue
        cursor = 0
        pieces = []
        for match in protected.finditer(line):
            pieces.append(linkify_segment(line[cursor:match.start()]))
            pieces.append(match.group(0))
            cursor = match.end()
        pieces.append(linkify_segment(line[cursor:]))
        output.append(''.join(pieces))
    return ''.join(output)


def escape_symbolic_markdown_table_cells(text):
    """转义表格单元格里用作序列符号的字面 ``*`` 串。

    声学/生物序列表格会用 ``*******___`` 表示事件。这些符号留在源码里，
    Markdown 会把它们重新解读为奇数个强调定界符。只处理完全由 ``*``/``_``
    构成的单元格，普通正文强调和混合内容单元格仍保留作者写的 Markdown
    语义。
    """
    output = []
    fence = None
    symbolic_cell = re.compile(r'(?<=\|)([ \t]*)([*_]+)([ \t]*)(?=\|)')
    for line in str(text or '').splitlines(keepends=True):
        fence_match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            output.append(line)
            continue
        if fence is None and '|' in line:
            line = symbolic_cell.sub(
                lambda match: match.group(1)
                + match.group(2).replace('*', r'\*').replace('_', r'\_')
                + match.group(3),
                line,
            )
        output.append(line)
    return ''.join(output)


_STATISTICAL_SIGNIFICANCE_STARS = re.compile(
    r'(?P<prefix>\bp\s*(?:=|<|>|≤|≥)\s*'
    r'\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?P<stars>(?<!\\)\*{1,3})'
    r'(?=\s*(?:\||[,.;，。；]|$))',
    flags=re.IGNORECASE,
)


_TECHNICAL_NOTATION_ASTERISK = re.compile(
    r'(?<!\\)(?P<token>\b[A-Za-z]+\d+)(?P<star>\*)(?!\*)'
)


def escape_technical_notation_asterisks(text):
    """转义 ``H1*`` 这类紧凑技术记号里的字面星号。

    声学记号把星号当作名称的一部分（例如 ``H1*-H2*``），不是 Markdown 强调。
    同时转义独立的 Humdrum 格式名 ``**kern``；代码、公式和真实加粗保持原样。
    只转义以星号结尾的字母/数字记号，既保留作者写的强调，也避免 CommonMark
    把这个记号与周围的粗体标记配成一对。YAML frontmatter 保持字节不变，
    因为双引号 YAML 标量里的反斜杠会改变含义。这个操作是幂等的。
    """
    opening, frontmatter, sep, closing, body = _split_starting_frontmatter(text)
    prefix = opening + frontmatter + sep + closing
    literal_kern = re.compile(r'(?<![A-Za-z0-9_\\*])\*\*kern(?![A-Za-z0-9_*])')
    code_math_url_protected = markdown_inline_code_ranges(body)
    code_math_url_protected.extend((match.start(), match.end()) for match in re.finditer(
        r'(?<!\\)\\\([\s\S]*?\\\)|(?<!\\)\\\[[\s\S]*?\\\]|https?://[^\s<>]+', body))
    protected = list(code_math_url_protected)
    # Use the same closed **...** shape as the format gate, with nonblank
    # content edges, permitting a soft line break and nested single emphasis.
    # Never cross a blank paragraph or an intervening double-star delimiter;
    # whitespace before a later independent opener cannot close this pair.
    protected.extend((match.start(), match.end()) for match in re.finditer(
        r'(?<![\\*])\*\*(?=\S)(?:(?!\r?\n[ \t]*\r?\n)[^*]|\*(?!\*))+?(?<=\S)\*\*(?!\*)', body))
    # A terminal nested single-emphasis span closes with one star immediately
    # before the outer strong pair. Recognize this exact three-star run only;
    # neither segment can skip another star delimiter or a blank paragraph.
    protected.extend((match.start(), match.end()) for match in re.finditer(
        r'(?<![\\*])\*\*(?=\S)(?:(?!\r?\n[ \t]*\r?\n)[^*])+?'
        r'(?<!\\)\*(?!\*)(?=\S)(?:(?!\r?\n[ \t]*\r?\n)[^*])+?'
        r'(?<!\\)(?<=\S)\*{3}(?!\*)', body))
    output = []
    fence = None
    offset = 0
    for line in body.splitlines(keepends=True):
        original_length = len(line)
        fence_match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            output.append(line)
            offset += original_length
            continue
        if fence is None:
            edits = []
            for match in literal_kern.finditer(line):
                pos = offset + match.start()
                if not any(start <= pos < end for start, end in protected):
                    edits.append((match.start(), match.end(), r'\*\*kern'))
            for match in _TECHNICAL_NOTATION_ASTERISK.finditer(line):
                pos = offset + match.start()
                if not any(start <= pos < end for start, end in code_math_url_protected):
                    edits.append((match.start(), match.end(), f"{match.group('token')}\\{match.group('star')}"))
            if edits:
                edits.sort(key=lambda item: item[0], reverse=True)
                for start_i, end_i, replacement in edits:
                    line = line[:start_i] + replacement + line[end_i:]
        output.append(line)
        offset += original_length
    return prefix + ''.join(output)


def is_publication_technical_asterisk_cell_view(canonical, displayed, source_text):
    """Recognize only the exact existing sanitizer view of a plain bound cell."""
    if (not isinstance(canonical, str) or not isinstance(displayed, str)
            or not isinstance(source_text, str) or source_text != canonical
            or not canonical or len(canonical) > 512 or displayed == canonical
            or re.search(r'[\\`$<>\[\]{}|\r\n]|https?://', canonical, re.I)):
        return False
    matches = list(_TECHNICAL_NOTATION_ASTERISK.finditer(canonical))
    if (not matches or len(matches) != canonical.count('*')
            or any(not match['token'].isascii() for match in matches)):
        return False
    # Reuse the actual publisher, rather than decoding arbitrary Markdown
    # escapes or inferring what an unmatched star originally meant.
    return displayed == escape_technical_notation_asterisks(canonical)


def escape_statistical_significance_stars(text):
    """转义 p 值后面的字面显著性星号。

    表格常用 ``p = 0.00908**`` 或 ``p < 2.2e-16***`` 表示显著性水平。
    CommonMark 会把裸星号当作强调定界符，于是来源事实本身没问题，发布
    页面却过不了 Markdown 闸。修复只针对未转义的 p 值加上完整的星号串；
    真实表格格值的“百分比估计 [区间]% 星号”也只转义完整尾注。
    普通强调和代码不动。这个操作是幂等的。
    """
    data_lines = {line for table in extract_markdown_tables(text)
                  for line in range(table['start_line'] + 2, table['end_line'] + 1)}
    scalar = r'[+−-]?[0-9]+(?:\.[0-9]+)?'
    interval_stars = re.compile(
        r'(?<=\|)(?P<prefix>[ \t]*(?:'
        + scalar + r'%[ \t]+\[' + scalar + r',[ \t]*' + scalar + r'\]%'
        + r'|' + scalar + r'%?[ \t]*±[ \t]*' + scalar + r'%?'
        + r')[ \t]+)(?P<stars>\*{1,3})(?=[ \t]*\|)')
    output = []
    fence = None
    for line_index, line in enumerate(str(text or '').splitlines(keepends=True)):
        fence_match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            output.append(line)
            continue
        if fence is None:
            line = _STATISTICAL_SIGNIFICANCE_STARS.sub(
                lambda match: match.group('prefix')
                + ''.join('\\' + char for char in match.group('stars')),
                line,
            )
            if line_index in data_lines:
                line = interval_stars.sub(
                    lambda match: match['prefix'] + ''.join('\\' + char for char in match['stars']), line)
        output.append(line)
    return ''.join(output)


def normalize_bold_label_prefix_spacing(text):
    """整理行首说明标签的分隔空格，保留原词与代码、公式、链接字节。"""
    label = r'\*\*[ \t]*([^*\r\n`|$\[\]<> \t][^*\r\n`|$\[\]<>]{0,239}[:：])\*\*'
    label_pattern = re.compile(label)
    prefix_pattern = re.compile(r'^([ \t]{0,3}(?:>[ \t]*)?)((?:' + label + r'[ \t]*)+)')
    protected = markdown_inline_code_ranges(text)
    protected.extend((match.start(), match.end()) for match in re.finditer(
        r'(?<!\\)\\\([\s\S]*?\\\)|(?<!\\)\\\[[\s\S]*?\\\]|'
        r'!?\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)', text))
    output = []
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        line_start = offset
        offset += len(line)
        marker = re.match(r'^[ \t]{0,3}(?:>[ \t]*)?(`{3,}|~{3,})', line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = (token[0], len(token))
            elif token[0] == fence[0] and len(token) >= fence[1] \
                    and not line[marker.end():].strip():
                fence = None
            output.append(line)
            continue
        if fence is None:
            original_prefix = prefix_pattern.match(line)
            if original_prefix and any(start < line_start + original_prefix.end()
                                       and end > line_start for start, end in protected):
                output.append(line)
                continue
            # Keep the existing repair for the first label, and additionally
            # repair each explicitly delimited label in a contiguous prefix.
            line = re.sub(r'^([ \t]{0,3}(?:>[ \t]*)?)\*\*[ \t]+(?=\S)', r'\1**', line)
            prefix = prefix_pattern.match(line)
            if prefix:
                labels = label_pattern.sub(lambda match: '**' + match[1] + '**', prefix[2])
                tail = line[prefix.end():]
                if tail and (tail[0].isalnum() or '\u3400' <= tail[0] <= '\u9fff') \
                        and not labels.endswith((' ', '\t')):
                    labels += ' '
                line = prefix[1] + labels + tail
        output.append(line)
    return ''.join(output)


def escape_literal_source_figure_caption_dollars(text, *, _literal_pairs=None):
    r"""Make literal PDF caption dollars Markdown-safe, without guessing metrics.

    Only the generated standalone image + matching source-caption pair qualifies.
    This is a publication display transformation, not a Reader/source correction.
    Code, URLs, balanced math and existing escapes retain their original bytes.
    """
    if not text or '$' not in text or '*论文图 ' not in text:
        return text
    caption = re.compile(
        r'^(?P<prefix>\*论文图 [1-9][0-9]*。原论文 '
        r'(?P<label>(?:Figure|Fig\.) (?:[A-Z]\.?)?[1-9][0-9]*)[.:]?：“)'
        r'(?P<value>[^\r\n]*)(?P<suffix>”。\*)(?P<ending>\r?\n)?$')
    v4_caption = re.compile(
        r'^(?P<prefix>\*论文图 [1-9][0-9]*：)'
        r'(?P<value>[^\r\n]*)(?P<suffix>（原论文 '
        r'(?P<label>(?:Figure|Fig\.) (?:[A-Z]\.?)?[1-9][0-9]*)(?:；[^）\r\n]*)?）。\*)(?P<ending>\r?\n)?$')
    image = re.compile(
        r'^(?P<wrap>\[)?!\[(?P<alt>[^\r\n]*)\]\((?P<url>[^)\r\n]+)\)'
        r'(?(wrap)\]\((?P=url)\))(?P<ending>\r?\n)?$')
    source_note = re.compile(
        r'^> \*\*图片来源：\*\* (?P<note>原论文 PDF 第 [1-9][0-9]* 页'
        r'(?: Figure (?P<crop>[1-9][0-9]*)（出版显示裁切）'
        r'|，本文讨论 Figure (?P<page>[1-9][0-9]*)（完整原页(?:；图注未完整抽取，以原页为准)?）))。(?:\r?\n)?$')
    protected = re.compile(
        r'(?P<ticks>`+)(?!`).*?(?<!`)(?P=ticks)(?!`)'
        r'|https?://[^\s<>]+'
        r'|(?<!\\)\\\([\s\S]*?\\\)'
        r'|(?<!\\)\\\[[\s\S]*?\\\]'
        r'|(?<!\\)\$\$.+?\$\$'
        r'|(?<![\\$])\$(?!\$)([^\s$](?:[^$\n]*?[^\s$])?)\$(?![\d$])')

    def escape_fragment(value):
        spans = [(m.start(), m.end()) for m in protected.finditer(value)]
        output, span_index, slash_run = [], 0, 0
        for index, char in enumerate(value):
            while span_index < len(spans) and spans[span_index][1] <= index:
                span_index += 1
            guarded = span_index < len(spans) and spans[span_index][0] <= index < spans[span_index][1]
            if char == '$' and slash_run % 2 == 0 and not guarded:
                output.append('\\')
            output.append(char)
            slash_run = slash_run + 1 if char == '\\' else 0
        return ''.join(output)

    lines, outside = text.splitlines(keepends=True), []
    fence = None
    for line in lines:
        marker = re.match(r'^[ \t]{0,3}(`{3,}|~{3,})', line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = (token[0], len(token))
            elif token[0] == fence[0] and len(token) >= fence[1] and not line[marker.end():].strip():
                fence = None
            outside.append(False)
        else:
            outside.append(fence is None)
    # CommonMark inline code may span newlines. Do not treat a generated-looking
    # example inside such a span as an actual figure, including when its lines
    # happen to start at column zero.
    multiline_code = [(m.start(), m.end()) for m in re.finditer(
        r'(?P<ticks>`+)(?!`).*?(?<!`)(?P=ticks)(?!`)', text, flags=re.DOTALL)
        if '\n' in m.group(0)]
    offsets, cursor = [], 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line)
    for index, line in enumerate(lines):
        if not outside[index] or any(start < offsets[index] + len(line) and end > offsets[index]
                                     for start, end in multiline_code):
            continue
        match = caption.fullmatch(line) or v4_caption.fullmatch(line)
        if not match:
            continue
        before = index - 1
        while before >= 0 and not lines[before].strip():
            before -= 1
        note_value = ''
        if before >= 0:
            note = source_note.fullmatch(lines[before])
            if note:
                native_number = re.search(r'(?:[A-Z]\.?)?[0-9]+$', match['label']).group(0)
                if not outside[before] or (note['crop'] or note['page']) != native_number:
                    continue
                note_value = '图片来源： ' + note['note'] + '。'
                before -= 1
                while before >= 0 and not lines[before].strip():
                    before -= 1
        if before < 0 or not outside[before]:
            continue
        node = image.fullmatch(lines[before])
        if node is None or not (
                node['alt'].startswith('原论文 ' + match['label'] + '：')
                or node['alt'].startswith('原论文 ' + match['label'] + '.：')):
            continue
        escaped_caption = match['prefix'] + escape_fragment(match['value']) + match['suffix']
        escaped_alt = escape_fragment(node['alt'])
        if _literal_pairs is not None:
            _literal_pairs.append({'caption': line.rstrip('\r\n'), 'escapedCaption': escaped_caption,
                                   'alt': node['alt'], 'escapedAlt': escaped_alt, 'url': node['url'],
                                   'sourceNote': note_value})
        lines[index] = escaped_caption + (match['ending'] or '')
        # Replace precisely the alt span, preserving URL, wrapper, order, label,
        # punctuation and every byte outside these two literal text fragments.
        start, end = node.span('alt')
        lines[before] = lines[before][:start] + escaped_alt + lines[before][end:]
    return ''.join(lines)


def markdown_inline_code_ranges(article):
    text = str(article or '')
    ranges = []
    cursor = 0
    paragraph_boundary = re.compile(
        r'\n(?:[ \t]*\n| {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]+(?=\S)|'
        r'0{0,8}1[.)][ \t]+(?=\S)|(?:-+|\*{3,}|_{3,}|=+)[ \t]*(?=\n|$)))'
    )
    while cursor < len(text):
        opening = re.search(r'(?<!`)(`+)(?!`)', text[cursor:])
        if not opening:
            break
        start = cursor + opening.start()
        end = cursor + opening.end()
        escaped = start
        while escaped > 0 and text[escaped - 1] == '\\':
            escaped -= 1
        if (start - escaped) % 2:
            cursor = end
            continue
        boundary = paragraph_boundary.search(text, end)
        limit = boundary.start() if boundary else len(text)
        closing = re.search(r'(?<!`)`{' + str(end - start) + r'}(?!`)', text[end:limit])
        if closing:
            closed = end + closing.end()
            ranges.append((start, closed))
            cursor = closed
        else:
            cursor = end
    return ranges


def sanitize_markdown_for_publish(text):
    """发布前通用 Markdown 清洗。"""
    # LLM 输出偶尔会携带 UTF-8 替换字符；先清理后再进入 staging，
    # 避免直到最终 Markdown 检查时才发现无法还原的乱码字符。
    text = text.replace('\ufffd\ufffd\ufffd', '。')
    text = text.replace('\ufffd\ufffd', '。')
    text = text.replace('\ufffd', '')
    # 零宽字符不会显示却会污染表格表头与引用比对（文字里出现看不见的分隔符），
    # 发布前统一去除：零宽空格/连接符、词连接符、BOM。这里与来源单元格比较
    # 共用 PUBLISH_ZERO_WIDTH_CHARACTERS，避免两处集合漂移。
    text = re.sub('[' + PUBLISH_ZERO_WIDTH_CHARACTERS + ']', '', text)
    opening, frontmatter, sep, closing, latex_body = _split_starting_frontmatter(text)
    latex_prefix = opening + frontmatter + sep + closing
    latex_body = escape_literal_source_figure_caption_dollars(latex_body)
    latex_body = normalize_arxiv_math_double_extraction(latex_body)
    latex_body = fix_latex_delimiters(latex_body)
    # 嵌套 TeX 花括号里的论文控制记号可能看起来像 Hugo shortcode（如
    # \text{{<tts_start>}}）。Hugo 的字面 shortcode 转义会在 Markdown/公式
    # 渲染之前还原原始字节。
    def escape_literal_shortcode(match):
        opening, body, closing = match.groups()
        if (opening, closing) not in {('<', '>'), ('%', '%')}:
            return match.group(0)
        return '{{' + opening + '/*' + body + '*/' + closing + '}}'

    latex_body = re.sub(
        r'\{\{(<|%)(?!/\*)(.*?)(>|%)\}\}',
        escape_literal_shortcode, latex_body, flags=re.DOTALL,
    )
    latex_body = re.sub(
        r'(?im)^(#{1,6}\s+)(?:图|Figure|表|Table)\s*\d+'
        r'\s*[:：、.．-]?\s*',
        r'\1',
        latex_body,
    )
    # CommonMark cannot open emphasis after delimiter whitespace. Adjacent
    # explanation labels can have different words; retain all of those words.
    latex_body = normalize_bold_label_prefix_spacing(latex_body)
    # 核心摘要里曾观察到重复的中文 MOS 标签。只修复这个正文前缀，
    # 来源引文和表格单元格不动。
    latex_body = re.sub(
        r'(?m)^(语音质量评估输入待测语音、输出与人耳一致的)'
        r'平均意见分平均意见分（Mean Opinion Score, MOS）',
        r'\1平均意见分（Mean Opinion Score, MOS）', latex_body,
    )
    # 先剥离裸行内样式标签（b/i/u），再转义剩余尖括号控制记号，且仅作用于正文，
    # 避免 frontmatter 被误改或 <u>x</u> 被先套反引号后剥离成空反引号。
    latex_body = strip_raw_inline_html(latex_body)
    latex_body = escape_html_like_tags(latex_body)
    text = latex_prefix + latex_body
    text = fix_extraction_diacritic_damage(text)
    text = fix_image_markdown(text)
    text = fix_empty_markdown_links(text)
    text = dedupe_image_alts(text)
    text = link_remote_images_to_original(text)
    text = truncate_base64_datauri(text)
    text = fix_yaml_double_commas(text)
    text = fix_yaml_unbalanced_quotes(text)
    text = escape_symbolic_markdown_table_cells(text)
    text = escape_technical_notation_asterisks(text)
    text = escape_statistical_significance_stars(text)
    # 评分审计和 manual evidence ledger 需要这些锚点来约束上游事实，
    # 但它们是内部 provenance，不应泄漏到面向读者的博客正文。这里只
    # 清理派生的发布视图，不修改 analysis / parsed canonical 数据。
    text = strip_internal_scoring_anchors(text)
    return linkify_bare_https_urls(text)


def score_and_sort(papers):
    """
    解析每篇论文的分析结果，按评分降序排列。
    返回 [(score, paper, parsed), ...]，未评分的排在最后。
    发布排序前强制校验 analysis、parsed、八维评分和版本一致性。
    """
    scored = []
    unscored = []
    for p in papers:
        parsed_analysis = resolve_publish_parsed(p)
        normalized_paper = dict(p)
        normalized_paper['parsed'] = parsed_analysis
        if parsed_analysis and parsed_analysis.get('score'):
            try:
                scored.append((float(parsed_analysis['score']), normalized_paper, parsed_analysis))
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
        parsed_analysis = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not parsed_analysis:
            continue
        hot_tag = parsed_analysis.get('primaryTaskTag') or (parsed_analysis['tags'][0] if parsed_analysis.get('tags') else '')
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
        parsed_analysis = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not parsed_analysis:
            continue
        if parsed_analysis.get('primaryTaskTag'):
            tag_set.add(parsed_analysis['primaryTaskTag'].replace('#', '').strip())
        for t in parsed_analysis.get('tags', []):
            clean = t.replace('#', '').strip()
            if clean:
                tag_set.add(clean)
    return sorted(tag_set)[:limit]


def extract_one_liner(parsed_analysis):
    """从分析结果中提取一句话亮点，优先用创新点或核心贡献，而非截断摘要"""
    text = ''

    # 1. 优先尝试 innovation 第一条
    innovation = parsed_analysis.get('innovation', '')
    if innovation:
        first = innovation.split('\n')[0].strip()
        first = re.sub(r'^\d+\.\s*', '', first)
        if len(first) > 15:
            text = first

    # 2. 尝试从 summary 中提取核心贡献句（找"提出了"/"解决了"/"旨在"等）
    if not text:
        summary = parsed_analysis.get('summary', '')
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

    # 前两种内容不可用时，取论文评价的第一句。
    if not text:
        evaluation_text = parsed_analysis.get('roast', '')
        if evaluation_text:
            text = evaluation_text.split('。')[0].strip()

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


def build_paper_meta(parsed_analysis, aurl=''):
    """拼接评分、分档、主任务/主方法等关键信息（Markdown 格式）"""
    if not parsed_analysis:
        return ''

    bits = []
    score = parsed_analysis.get('score', '')
    if score:
        try:
            score_val = float(score)
            bits.append(f'{score_emoji(score_val)} **{score}/10**')
        except (ValueError, TypeError):
            pass

    if parsed_analysis.get('rankBucket'):
        bits.append(parsed_analysis['rankBucket'])
    if parsed_analysis.get('documentType'):
        bits.append(f'文档类型：{parsed_analysis["documentType"]}')
    if parsed_analysis.get('confidence'):
        bits.append(f'评分置信度：{parsed_analysis["confidence"]}')
    primary_tags = []
    for key in ('primaryTaskTag', 'primaryMethodTag'):
        tag = parsed_analysis.get(key)
        if tag and tag not in primary_tags:
            primary_tags.append(tag)
            bits.append(tag)

    raw_tags = parsed_analysis.get('tags', [])
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


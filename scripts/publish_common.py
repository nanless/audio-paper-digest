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
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from path_config import (
    CURRENT_DIR,
    read_json_strict,
    resolve_deep_analysis_result_for_date,
    resolve_deep_analysis_result_path,
)
from project_env import build_child_process_env
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
EXPERIMENT_TABLE_CONTRACT_VERSION = 'bounded-v1'
METHOD_DETAIL_CONTRACT_VERSION = 'detailed-v1'
EXPERIMENT_TABLE_LIMITS = {
    'max_tables': 2,
    'max_data_rows': 12,
    'max_metric_columns': 8,
}
TABLE_IDENTIFIER_HEADER_RE = re.compile(
    r'(?:^|\b)(?:method|model|system|config(?:uration)?|dataset|corpus|benchmark|task|'
    r'language|scenario|condition|setting|split|category|type|modality|version)(?:\b|$)'
    r'|方法|模型|系统|配置|数据集|语料|基准|任务|语言|场景|条件|设置|划分|类别|类型|模态|版本',
    flags=re.IGNORECASE,
)


def _extract_analysis_section(text, title):
    match = re.search(
        rf'(?:^|\n)##(?!#)\s*{re.escape(title)}[：:\s]*\n([\s\S]*?)(?=\n##(?!#)\s|$)',
        str(text or ''),
    )
    return match.group(1).strip() if match else ''


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
        invalid_column_counts = []
        separator_columns = len(split_markdown_table_row(lines[index + 1]))
        while end < len(lines):
            cells = split_markdown_table_row(lines[end])
            if not lines[end].strip():
                break
            if len(cells) < 2 and not re.fullmatch(r'\s*\|.*\|\s*', lines[end]):
                break
            data_rows += 1
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
            'data_rows': data_rows,
            'separator_columns': separator_columns,
            'invalid_column_counts': invalid_column_counts,
            'metric_columns': max(0, len(header) - identifier_columns),
        })
        index = max(end, index + 2)
    return tables


def validate_experiment_table_contract(analysis):
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


def validate_papers_for_publish(papers):
    """Validate every paper before creating any publish artifact."""
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
                    'imageDownload': {'complete', 'skipped', 'no_candidates', 'no_downloadable_images'},
                    'primaryAnalysis': {'complete'},
                    'openSourceScan': {'complete'},
                    'demoLinkScan': {'complete', 'not_needed'},
                    'revision': {'complete'},
                    'tableRepair': {'complete', 'not_needed'},
                    'methodRepair': {'complete', 'not_needed'},
                    'structureRepair': {'complete', 'not_needed'},
                    'scoringAudit': {'complete'},
                    'imageSupplement': {
                        'complete', 'skipped', 'no_candidates',
                        'no_high_value_images', 'no_downloadable_images',
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
                contracts = manifest.get('contracts')
                if contracts is not None and not isinstance(contracts, dict):
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts 必须是对象'
                    )
                table_contract = (
                    contracts.get('experimentTables') if isinstance(contracts, dict) else None
                )
                if table_contract is not None and table_contract != EXPERIMENT_TABLE_CONTRACT_VERSION:
                    raise PublishDataValidationError(
                        f'{paper_label} analysisManifest.contracts.experimentTables 非法: '
                        f'{table_contract}'
                    )
                if table_contract == EXPERIMENT_TABLE_CONTRACT_VERSION:
                    table_issue = validate_experiment_table_contract(paper.get('analysis'))
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
                if method_contract == METHOD_DETAIL_CONTRACT_VERSION:
                    method_issue = validate_method_detail_contract(paper.get('analysis'))
                    if method_issue:
                        raise PublishDataValidationError(
                            f'{paper_label} 分析正文方法契约无效: {method_issue}'
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
    ep = (endpoint or '').lower()
    m = (model or '').lower()
    if 'deepseek.com' in ep or 'deepseek' in m:
        return 'openai'
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
    return (data.get('choices', [{}])[0].get('message', {}).get('content') or '').strip()


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
            # Publishing LLM calls must remain direct even when fetch proxies are configured.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=timeout) as response:
                status = response.status
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f'HTTP {response.status}')
                data = json.loads(response.read().decode('utf-8'))
            content = parse_publish_response_text(api_type, data)
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
            if finish_reason in {'length', 'max_tokens'}:
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
    """从 deep-analysis-result.json 加载论文列表"""
    if data_file is None:
        data_file = resolve_deep_analysis_result_path()
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
    text = re.sub(r'(\^|_)\{<([a-zA-Z])\}', r'\1{(\2)}', text)
    text = re.sub(r'(?<!\\)\$\$(.+?)\$\$', r'\\[\1\\]', text, flags=re.DOTALL)
    text = re.sub(r'(?<!\\)\$([^\s\$][^$]*?)\$', r'\\(\1\\)', text)
    text = re.sub(r'`([^`]*?)\$([^`]*?)\$([^`]*?)`', r'`\1\\(\2\\)\3`', text)
    return text


def escape_html_like_tags(text):
    r"""转义论文中可能被 Hugo 解析为 HTML 的标记。"""
    if not text:
        return text
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


def sanitize_markdown_for_publish(text):
    """发布前通用 Markdown 清洗。"""
    # LLM 输出偶尔会携带 UTF-8 替换字符；先清理后再进入 staging，
    # 避免最终 Markdown 门禁才发现不可逆的乱码字节。
    text = text.replace('\ufffd\ufffd\ufffd', '。')
    text = text.replace('\ufffd\ufffd', '。')
    text = text.replace('\ufffd', '')
    text = fix_latex_delimiters(text)
    text = escape_html_like_tags(text)
    text = strip_raw_inline_html(text)
    text = fix_image_markdown(text)
    text = fix_empty_markdown_links(text)
    text = dedupe_image_alts(text)
    text = truncate_base64_datauri(text)
    text = fix_yaml_double_commas(text)
    text = fix_yaml_unbalanced_quotes(text)
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

    extra_tags = [t for t in pa.get('tags', [])
                  if t not in set(primary_tags)]
    if extra_tags:
        bits.append(' '.join(extra_tags[:2]))
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

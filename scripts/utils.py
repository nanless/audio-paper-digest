#!/usr/bin/env python3
"""
Paper Digest 公共工具模块 (Python)
统一封装：Markdown 处理、分析文本解析、时间处理
"""

import math
import re
import os
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone, timedelta

from paper_taxonomy import (LABEL_MODE_LEGACY,
                            active_preferred_labels, ancestors, load_taxonomy,
                            prune_ancestors, resolve_label_candidates)

BJ_TZ = timezone(timedelta(hours=8))
SCORING_RUBRIC_VERSION = 'type-aware-v1'
DOCUMENT_TYPES = (
    '方法研究',
    '系统技术报告',
    '模型报告',
    '数据集与基准',
    '综述',
    '理论研究',
    '应用研究',
)


def normalize_document_type(value):
    """将常见文档类型别名归一化为评分契约中的受控值。"""
    raw = strip_md(value or '').strip()
    if not raw:
        return ''
    if raw in DOCUMENT_TYPES:
        return raw
    normalized = re.sub(r'[\s_-]+', '', raw.lower())
    aliases = {
        '方法论文': '方法研究', '研究论文': '方法研究',
        'methodpaper': '方法研究', 'methodresearch': '方法研究',
        '技术报告': '系统技术报告', '系统报告': '系统技术报告',
        '工业技术报告': '系统技术报告', '白皮书': '系统技术报告',
        'techreport': '系统技术报告', 'technicalreport': '系统技术报告',
        'systemreport': '系统技术报告', 'whitepaper': '系统技术报告',
        '工业模型报告': '模型报告', 'modelreport': '模型报告',
        '数据集': '数据集与基准', '基准': '数据集与基准',
        '基准测试': '数据集与基准', 'dataset': '数据集与基准',
        'benchmark': '数据集与基准', 'datasetbenchmark': '数据集与基准',
        '综述论文': '综述', 'survey': '综述', 'review': '综述',
        '理论论文': '理论研究', 'theory': '理论研究',
        'theoreticalresearch': '理论研究',
        '应用论文': '应用研究', 'application': '应用研究',
        'appliedresearch': '应用研究',
    }
    return aliases.get(normalized, '')


def now_bj_iso():
    """返回北京时间 ISO 字符串（带 +08:00 时区标记）"""
    return datetime.now(BJ_TZ).isoformat()


def now_bj_date():
    """返回北京时间日期字符串 YYYY-MM-DD"""
    return datetime.now(BJ_TZ).strftime('%Y-%m-%d')


def strip_md(t):
    """去除 Markdown 格式标记"""
    if not t:
        return ''
    t = re.sub(r'\*\*(.+?)\*\*', r'\1', t)
    t = re.sub(r'__(.+?)__', r'\1', t)
    t = re.sub(r'\*(.+?)\*', r'\1', t)
    t = re.sub(r'_(.+?)_', r'\1', t)
    t = re.sub(r'`(.+?)`', r'\1', t)
    # 清理残留的不成对 ** 和 __
    t = t.replace('**', '')
    t = t.replace('__', '')
    t = re.sub(r'^#{1,6}\s+', '', t, flags=re.MULTILINE)
    return t.strip()


def parse_machine_summary(analysis):
    """解析 机器摘要 块（兼容 ## 和 ### 标题）"""
    result = {
        'documentType': '',
        'rankBucket': '',
        'innovation': '',
        'technicalRigor': '',
        'experimentalSufficiency': '',
        'clarity': '',
        'impact': '',
        'openSource': '',
        'reproducibility': '',
        'engineeringScore': '',
        'confidence': '',
        'primaryTaskTag': '',
        'primaryMethodTag': '',
        'sotaClaim': '',
        'hasCode': '',
        'hasModel': '',
        'hasDataset': '',
    }
    if not analysis:
        return result

    # 兼容 ## 机器摘要 和 ### 机器摘要，内容到下一个 ##/###/【 或结尾
    m = re.search(r'#{2,3}\s*机器摘要\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n【|$)', analysis)
    if not m:
        return result

    key_map = {
        'document_type': 'documentType',
        'rank_bucket': 'rankBucket',
        'innovation': 'innovation',
        'technical_rigor': 'technicalRigor',
        'experimental_sufficiency': 'experimentalSufficiency',
        'clarity': 'clarity',
        'impact': 'impact',
        'open_source': 'openSource',
        'reproducibility': 'reproducibility',
        'engineering_score': 'engineeringScore',
        'confidence': 'confidence',
        'primary_task_tag': 'primaryTaskTag',
        'primary_method_tag': 'primaryMethodTag',
        'sota_claim': 'sotaClaim',
        'has_code': 'hasCode',
        'has_model': 'hasModel',
        'has_dataset': 'hasDataset',
    }

    for line in m.group(1).splitlines():
        line = line.strip()
        if not line:
            continue
        km = re.match(r'^(?:[-*]\s+)?([a-z_]+)\s*[：:]\s*(.+)$', line, flags=re.I)
        if not km:
            continue
        mapped = key_map.get(km.group(1))
        if mapped:
            val = strip_md(km.group(2))
            if mapped == 'documentType':
                val = normalize_document_type(val)
            # 对于数值型字段，只保留数字部分（去除中文括号说明等）
            if mapped in ('innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity', 'impact', 'openSource', 'reproducibility', 'engineeringScore'):
                num_match = re.search(r'(\d+\.?\d*)', val)
                if num_match:
                    val = num_match.group(1)
            # 对于 rankBucket，只允许四个标准分档，同时映射常见英文输出
            if mapped == 'rankBucket':
                rank_map = {
                    'top-tier': '前10%', 'top': '前10%', '前10': '前10%',
                    'high': '前25%', '前25': '前25%',
                    'mid': '前50%', 'medium': '前50%', '前50': '前50%',
                    'low': '后50%', 'bottom': '后50%', '后50': '后50%',
                }
                val = rank_map.get(val.lower(), val)
                if val not in ('前10%', '前25%', '前50%', '后50%'):
                    val = ''
            if mapped == 'confidence':
                number_match = re.match(r'^(\d+(?:\.\d+)?)', val)
                if number_match:
                    number = float(number_match.group(1))
                    if (number <= 1 and number >= 0.8) or (number > 1 and number >= 4):
                        val = '高'
                    elif (number <= 1 and number >= 0.5) or (number > 1 and number >= 3):
                        val = '中'
                    else:
                        val = '低'
                else:
                    confidence_map = {
                        '高': '高', 'high': '高', 'h': '高',
                        '中': '中', 'medium': '中', '中低': '中', '中等': '中', 'm': '中',
                        '低': '低', 'low': '低', '较低': '低', 'l': '低',
                    }
                    val = confidence_map.get(val.lower(), val)
            result[mapped] = val

    return result


_DEFAULT_TAXONOMY = load_taxonomy()

# These compatibility exports are projections of the registry, never a second
# hand-maintained vocabulary.  A model family remains a supplementary tag and
# cannot occupy the primary method role.
ALLOWED_TAGS = set(active_preferred_labels(_DEFAULT_TAXONOMY))
PRIMARY_TASK_TAGS = set(active_preferred_labels(_DEFAULT_TAXONOMY, ('task',)))
PRIMARY_METHOD_TAGS = set(active_preferred_labels(
    _DEFAULT_TAXONOMY, ('method',)))


def _taxonomy_tag(raw, taxonomy, *, facets=None, legacy_tags=False):
    """Return ``(concept, error)`` for one explicit taxonomy token."""
    if not isinstance(raw, str) or not raw.strip():
        return None, '标签为空'
    token = raw.strip()
    if legacy_tags and facets == ('method',) \
            and token.removeprefix('#') == '端到端':
        candidates = [concept for concept in taxonomy['concepts']
                      if concept['status'] == 'active'
                      and concept['id'] == 'method.end-to-end-learning']
    elif not legacy_tags:
        if not token.startswith('#') or token.count('#') != 1:
            return None, f'current 标签必须精确写成 #preferredLabel.zh: {token}'
        label = token[1:]
        candidates = [concept for concept in taxonomy['concepts']
                      if concept['status'] == 'active'
                      and concept['preferredLabel']['zh'] == label]
    else:
        candidates = resolve_label_candidates(
            taxonomy, token, mode=LABEL_MODE_LEGACY)
    if facets is not None:
        candidates = [concept for concept in candidates if concept['facet'] in facets]
    if len(candidates) != 1:
        role = '/'.join(facets) if facets else 'taxonomy'
        reason = '歧义' if len(candidates) > 1 else '未知或角色不匹配'
        return None, f'{role} 标签{reason}: {token}'
    concept = candidates[0]
    if concept['status'] != 'active':
        return None, f'legacy deprecated 标签不得自动迁移: {token}'
    return concept, None


def _tag_tokens(raw_line, *, legacy_tags=False):
    """Extract explicit hashtags; only legacy mode may add omitted hashes."""
    if not isinstance(raw_line, str):
        return []
    hashtags = re.findall(r'#\S+', raw_line)
    if hashtags or not legacy_tags:
        return hashtags
    return [f'#{token}' for token in re.split(r'[,，;；、\s]+', raw_line.strip())
            if token]


def _canonical_tag(concept):
    return f"#{concept['preferredLabel']['zh']}"


def _current_tag_concept(taxonomy, raw, facet=None):
    if not isinstance(raw, str):
        return None
    token = raw.strip()
    matches = [concept for concept in taxonomy['concepts']
               if concept['status'] == 'active'
               and _canonical_tag(concept) == token
               and (facet is None or concept['facet'] == facet)]
    return matches[0] if len(matches) == 1 else None


def _validate_tag_selection(taxonomy, tags, primary_task_tag, primary_method_tag):
    raw_tags = tags if isinstance(tags, list) else []
    errors = []
    if len(raw_tags) < 3 or len(raw_tags) > 5:
        errors.append('标签总数必须为 3-5 个')
    concepts = [_current_tag_concept(taxonomy, tag) for tag in raw_tags]
    for tag, concept in zip(raw_tags, concepts):
        if concept is None:
            errors.append(f'标签不是 active 中文首选标签: {tag}')
    ids = [concept['id'] for concept in concepts if concept is not None]
    if len(set(ids)) != len(ids):
        errors.append('标签包含重复概念')

    task = _current_tag_concept(taxonomy, primary_task_tag, 'task')
    method = _current_tag_concept(taxonomy, primary_method_tag, 'method')
    if task is None:
        errors.append('主任务标签必须是 active task 中文首选标签')
    if method is None:
        errors.append('主方法标签必须是 active method 中文首选标签')
    if task is not None and task['id'] not in ids:
        errors.append('主任务标签必须出现在完整标签列表')
    if method is not None and method['id'] not in ids:
        errors.append('主方法标签必须出现在完整标签列表')
    if task is not None and any(
            task['id'] in ancestors(taxonomy, cid) for cid in ids):
        errors.append('主任务标签不是所选任务中的最具体概念')
    if ids and len(prune_ancestors(taxonomy, ids)) != len(ids):
        errors.append('标签不得同时包含祖先与后代概念')

    # Match Node's Set-based diagnostic de-duplication while preserving order.
    errors = list(dict.fromkeys(errors))
    return {
        'valid': not errors,
        'errors': errors,
        'registryVersion': taxonomy['version'],
        'registrySha256': taxonomy.get('registrySha256'),
        'primaryTaskId': task['id'] if task is not None else None,
        'primaryMethodId': method['id'] if method is not None else None,
        'conceptIds': [] if errors else ids,
    }


SCORE_DIMENSIONS = {
    'innovationScore': {'label': '创新性', 'max': 2},
    'technicalRigorScore': {'label': '技术严谨性', 'max': 1.5},
    'experimentalSufficiencyScore': {'label': '实验充分性', 'max': 1.5},
    'clarityScore': {'label': '清晰度', 'max': 1},
    'impactScore': {'label': '影响力', 'max': 1.5},
    'openSourceScore': {'label': '开源', 'max': 1.5},
    'reproducibilityScore': {'label': '可复现性', 'max': 0.5},
    'engineeringScore': {'label': '工程/实践价值', 'max': 1.5},
}

OPEN_SOURCE_SCORE_ANCHORS = (0.0, 0.2, 0.5, 1.0, 1.2, 1.5)


def normalize_score_to_one_decimal(value):
    return float(Decimal(str(value)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP))


def is_open_source_score_anchor(value):
    normalized = normalize_score_to_one_decimal(value)
    return any(abs(anchor - normalized) < 1e-9 for anchor in OPEN_SOURCE_SCORE_ANCHORS)


def parse_scoring_dimensions(scoring_text):
    occurrences = {field: [] for field in SCORE_DIMENSIONS}
    errors = []

    for raw_line in str(scoring_text or '').splitlines():
        line = re.sub(r'^(?:[-*+]\s+|\d+[.)]\s+)', '', raw_line.strip())
        line = line.replace('**', '').strip()
        if not line:
            continue

        for field, definition in SCORE_DIMENSIONS.items():
            label = definition['label']
            if not re.match(r'^' + re.escape(label) + r'(?=\s|[（(:：/])', line):
                continue

            rest = line[len(label):].strip()
            patterns = [
                re.compile(r'^[(（]\s*(-?\d+(?:\.\d)?)\s*/\s*(-?\d+(?:\.\d)?)\s*[)）]'),
                re.compile(r'^[:：]\s*(-?\d+(?:\.\d)?)\s*/\s*(-?\d+(?:\.\d)?)'),
                re.compile(r'^[(（]\s*(-?\d+(?:\.\d)?)\s*分\s*[)）]\s*[:：]\s*(-?\d+(?:\.\d)?)\s*/\s*(-?\d+(?:\.\d)?)'),
                re.compile(r'^/\s*(-?\d+(?:\.\d)?)\s*[:：]\s*(?:得分\s*)?(-?\d+(?:\.\d)?)'),
                re.compile(r'^[(（]\s*(-?\d+(?:\.\d)?)\s*分中的\s*(-?\d+(?:\.\d)?)\s*分\s*[)）]'),
                re.compile(r'^[(（]\s*/\s*(-?\d+(?:\.\d)?)\s*[)）]\s*[:：]\s*(-?\d+(?:\.\d)?)(?:\s*/\s*(-?\d+(?:\.\d)?))?'),
            ]

            item = {
                'score': None,
                'denominator': None,
                'declaredMaximum': None,
                'matchedFormat': False,
                'reason': '',
            }
            for index, pattern in enumerate(patterns):
                match = pattern.search(rest)
                if not match:
                    continue
                item['matchedFormat'] = True
                item['reason'] = re.sub(r'^[\s:：—–-]+', '', rest[match.end():]).strip()
                if index <= 1:
                    item['score'] = float(match.group(1))
                    item['denominator'] = float(match.group(2))
                elif index == 2:
                    item['declaredMaximum'] = float(match.group(1))
                    item['score'] = float(match.group(2))
                    item['denominator'] = float(match.group(3))
                elif index in (3, 4):
                    item['denominator'] = float(match.group(1))
                    item['score'] = float(match.group(2))
                else:
                    item['denominator'] = float(match.group(1))
                    item['score'] = float(match.group(2))
                    if match.group(3) is not None:
                        item['declaredMaximum'] = float(match.group(3))
                break

            occurrences[field].append(item)
            break

    scores = {}
    for field, definition in SCORE_DIMENSIONS.items():
        found = occurrences[field]
        label = definition['label']
        maximum = definition['max']
        if not found:
            errors.append(f'缺少评分维度“{label}”')
            continue
        if len(found) > 1:
            errors.append(f'评分维度“{label}”重复出现 {len(found)} 次')
            continue

        item = found[0]
        score = item['score']
        denominator = item['denominator']
        if not item['matchedFormat'] or score is None or denominator is None or not math.isfinite(score) or not math.isfinite(denominator):
            errors.append(f'评分维度“{label}”格式非法，必须写成 得分/{maximum}')
            continue
        if denominator != maximum or (item['declaredMaximum'] is not None and item['declaredMaximum'] != maximum):
            errors.append(f'评分维度“{label}”分母必须为 {maximum}')
            continue
        if score < 0 or score > maximum:
            errors.append(f'评分维度“{label}”得分 {score:g} 超出 0-{maximum}')
            continue
        meaningful_reason_chars = re.findall(r'[A-Za-z0-9\u4e00-\u9fff]', item['reason'])
        if len(meaningful_reason_chars) < 4:
            errors.append(f'评分维度“{label}”缺少具体评分理由')
            continue
        normalized_score = normalize_score_to_one_decimal(score)
        if field == 'openSourceScore' and not is_open_source_score_anchor(normalized_score):
            anchors = '/'.join(f'{value:.1f}' for value in OPEN_SOURCE_SCORE_ANCHORS)
            errors.append(f'评分维度“{label}”得分必须为 {anchors}')
            continue
        scores[field] = normalized_score

    return {'valid': not errors, 'scores': scores, 'errors': errors}


def parse_analysis(analysis, *, taxonomy=None, legacy_tags=False):
    """解析深度分析文本为结构化字典"""
    if not analysis:
        return None
    if type(legacy_tags) is not bool:
        raise ValueError('legacy_tags must be bool')
    registry = _DEFAULT_TAXONOMY if taxonomy is None else taxonomy
    # Validation happens before parsing so a malformed registry can never turn
    # an unknown production label into an accepted string by accident.
    active_preferred_labels(registry)
    r = {
        'machineSummary': None,
        'documentType': '',
        'scoringRubricVersion': '',
        'rankBucket': '',
        'innovationScore': '',
        'technicalRigorScore': '',
        'experimentalSufficiencyScore': '',
        'clarityScore': '',
        'impactScore': '',
        'openSourceScore': '',
        'reproducibilityScore': '',
        'engineeringScore': '',
        'confidence': '',
        'primaryTaskTag': '',
        'primaryMethodTag': '',
        'sotaClaim': '',
        'hasCode': '',
        'hasModel': '',
        'hasDataset': '',
        'scoreValidation': {'valid': False, 'scores': {}, 'errors': ['缺少评分理由']},
        'taxonomyValidation': {
            'valid': False,
            'errors': ['缺少标签章节'],
            'registryVersion': registry['version'],
            'registrySha256': registry.get('registrySha256'),
            'primaryTaskId': None,
            'primaryMethodId': None,
            'conceptIds': [],
        },
    }

    m = re.search(r'##\s*评分\s*\n\s*\*?(\d+\.?\d*)\*?', analysis)
    r['score'] = m.group(1) if m else ''

    # Only explicit role fields are authoritative.  The general tag list is
    # never interpreted as first=task/second=method.
    extracted_task_tag = None
    extracted_method_tag = None
    tag_section_match = re.search(r'##\s*标签\s*\n([\s\S]*?)(?=\n##\s|\n【|$)', analysis)
    if tag_section_match:
        tag_section = tag_section_match.group(1)
        task_line = re.search(r'主任务标签\s*[：:]\s*(.+)', tag_section)
        if task_line:
            extracted_task_tag = strip_md(task_line.group(1)).strip()
        method_line = re.search(r'主方法标签\s*[：:]\s*(.+)', tag_section)
        if method_line:
            extracted_method_tag = strip_md(method_line.group(1)).strip()

    raw_tag_list = []
    r['tags'] = []
    if tag_section_match:
        first_line = next((line.strip() for line in tag_section_match.group(1).splitlines()
                           if line.strip()), '')
        if not re.match(r'^(?:主任务标签|主方法标签|补充标签)\s*[：:]', first_line):
            raw_tag_list = _tag_tokens(first_line, legacy_tags=legacy_tags)
            for token in raw_tag_list:
                if legacy_tags:
                    concept, _error = _taxonomy_tag(
                        token, registry, legacy_tags=True)
                    # Legacy aliases can be globally ambiguous while an exact
                    # explicit task/method role line disambiguates them.  Do
                    # not extend this exception to supplemental tags.
                    if concept is None and token.strip() == str(extracted_task_tag or '').strip():
                        concept, _error = _taxonomy_tag(
                            token, registry, facets=('task',), legacy_tags=True)
                    if concept is None and token.strip() == str(extracted_method_tag or '').strip():
                        concept, _error = _taxonomy_tag(
                            token, registry, facets=('method',), legacy_tags=True)
                else:
                    concept = _current_tag_concept(registry, token)
                if concept is not None:
                    r['tags'].append(_canonical_tag(concept))

    machine_summary = parse_machine_summary(analysis)
    r['machineSummary'] = machine_summary
    r['documentType'] = machine_summary['documentType']
    r['scoringRubricVersion'] = SCORING_RUBRIC_VERSION if r['documentType'] else ''
    r['rankBucket'] = machine_summary['rankBucket']
    r['innovationScore'] = machine_summary['innovation']
    r['technicalRigorScore'] = machine_summary['technicalRigor']
    r['experimentalSufficiencyScore'] = machine_summary['experimentalSufficiency']
    r['clarityScore'] = machine_summary['clarity']
    r['impactScore'] = machine_summary['impact']
    r['openSourceScore'] = machine_summary['openSource']
    r['reproducibilityScore'] = machine_summary['reproducibility']
    r['engineeringScore'] = machine_summary['engineeringScore']
    r['confidence'] = machine_summary['confidence']
    if legacy_tags:
        task_concept, _task_error = _taxonomy_tag(
            extracted_task_tag, registry, facets=('task',), legacy_tags=True)
        method_concept, _method_error = _taxonomy_tag(
            extracted_method_tag, registry, facets=('method',), legacy_tags=True)
    else:
        task_concept = _current_tag_concept(registry, extracted_task_tag, 'task')
        method_concept = _current_tag_concept(registry, extracted_method_tag, 'method')
    if task_concept is not None:
        r['primaryTaskTag'] = _canonical_tag(task_concept)
    if method_concept is not None:
        r['primaryMethodTag'] = _canonical_tag(method_concept)
    selection_tags = r['tags'] if legacy_tags else raw_tag_list
    selection_task = r['primaryTaskTag'] if legacy_tags else extracted_task_tag
    selection_method = r['primaryMethodTag'] if legacy_tags else extracted_method_tag
    r['taxonomyValidation'] = _validate_tag_selection(
        registry, selection_tags, selection_task, selection_method)

    r['sotaClaim'] = machine_summary['sotaClaim']
    r['hasCode'] = machine_summary['hasCode']
    r['hasModel'] = machine_summary['hasModel']
    r['hasDataset'] = machine_summary['hasDataset']

    m = re.search(r'##\s*作者与机构\s*\n([\s\S]*?)(?=\n##|$)', analysis)
    r['authors'] = m.group(1).strip() if m else ''

    m = re.search(r'##\s*毒舌点评\s*\n([\s\S]*?)(?=\n##|$)', analysis)
    r['roast'] = m.group(1).strip() if m else ''

    # 兼容旧格式（有 ## 详细分析 父标题）和新格式（扁平 ## 标题）
    m = re.search(r'##\s*核心摘要\s*\n([\s\S]*?)(?=\n##\s*(?:方法概述和架构|详细分析)|$)', analysis)
    r['summary'] = m.group(1).strip() if m else ''

    # 兼容旧格式有 ## 详细分析 父标题的情况
    detail_block = re.search(r'##\s*详细分析\s*\n([\s\S]*?)(?=\n##\s*(?:开源|局限|图片)|$)', analysis)
    r['detailIntro'] = r['architecture'] = r['innovation'] = r['details'] = r['results'] = r['scoringReason'] = r['limitations'] = ''

    if detail_block:
        block = detail_block.group(1)
    else:
        # Fallback: 在整个文本中搜索子 section（兼容 gap-fill 直接输出 ## 标题的格式）
        block = analysis

    # 解析详细分析的各个子 section（支持 ### 01.xxx、## 01.xxx、### xxx、## xxx 四种格式）
    for key, pat in [
        ('architecture', r'#{2,3}\s*(?:\d+[.\s]+)?方法概述和架构[：:\s]*\n([\s\S]*?)(?=\n#{2,3}\s*(?:\d+[.\s]+)?(?:核心创新点|实验结果|细节详述|评分理由)|\n##\s|$)'),
        ('innovation', r'#{2,3}\s*(?:\d+[.\s]+)?核心创新点[：:\s]*\n([\s\S]*?)(?=\n#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|实验结果|细节详述|评分理由)|\n##\s|$)'),
        ('results', r'#{2,3}\s*(?:\d+[.\s]+)?实验结果[：:\s]*\n([\s\S]*?)(?=\n#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|细节详述|评分理由)|\n##\s|$)'),
        ('details', r'#{2,3}\s*(?:\d+[.\s]+)?细节详[述题][：:\s]*\n([\s\S]*?)(?=\n#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|评分理由)|\n##\s|$)'),
        ('scoringReason', r'#{2,3}\s*(?:\d+[.\s]+)?评分理由.*?\n([\s\S]*?)(?=\n#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|细节详述)|\n##\s|$)'),
    ]:
        sm = re.search(pat, block)
        if sm:
            val = sm.group(1).strip()
            if key == 'scoringReason':
                # 过滤掉 LLM 自己写的"总分"行，避免与代码计算的总分不一致造成困惑
                val = '\n'.join(line for line in val.split('\n') if not re.match(r'^\s*总分[：:]', line))
            r[key] = val

    # 局限与问题（新章节，可能在评分理由之后）
    m = re.search(r'##\s*局限与问题\s*\n([\s\S]*?)(?=\n##\s*(?:开源|$))', analysis)
    if m:
        r['limitations'] = m.group(1).strip()

    m = re.search(r'##\s*开源(?:详情)?[：:]*\s*\n([\s\S]*?)(?=\n##|$)', analysis)
    r['opensource'] = m.group(1).strip() if m else ''

    # 只有八维评分完整、唯一且分母/范围合法时才覆盖 LLM 给出的总分。
    scoring_text = r.get('scoringReason', '')
    if not scoring_text:
        # fallback: 在整个分析文本中搜索
        m = re.search(r'#+\s*(?:\d+[.\s]+)?评分理由.*?\n([\s\S]*?)(?=\n#+\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|细节详述)|\n##\s|$)', analysis)
        if m:
            scoring_text = m.group(1).strip()

    r['scoreValidation'] = parse_scoring_dimensions(scoring_text)
    if r['scoreValidation']['valid']:
            dim_scores = r['scoreValidation']['scores']
            total = min(10.0, sum(normalize_score_to_one_decimal(value) for value in dim_scores.values()))
            r['score'] = f'{normalize_score_to_one_decimal(total):.1f}'

            # 用评分理由的分项覆盖结果字段，确保与总分一致
            for field in SCORE_DIMENSIONS:
                r[field] = f'{normalize_score_to_one_decimal(dim_scores[field]):.1f}'
            if r.get('machineSummary'):
                r['machineSummary']['innovation'] = r['innovationScore']
                r['machineSummary']['technicalRigor'] = r['technicalRigorScore']
                r['machineSummary']['experimentalSufficiency'] = r['experimentalSufficiencyScore']
                r['machineSummary']['clarity'] = r['clarityScore']
                r['machineSummary']['impact'] = r['impactScore']
                r['machineSummary']['openSource'] = r['openSourceScore']
                r['machineSummary']['reproducibility'] = r['reproducibilityScore']
                r['machineSummary']['engineeringScore'] = r['engineeringScore']

    # 理论论文的核心产物可以是正文/附录中的公开证明，资源字段不能完整表达其状态。
    open_score_val = float(r.get('openSourceScore', 0) or 0)
    is_theory_paper = r.get('documentType') == '理论研究'
    has_code_yes = r.get('hasCode') in ('是', 'yes')
    has_model_yes = r.get('hasModel') in ('是', 'yes')
    has_dataset_yes = r.get('hasDataset') in ('是', 'yes')
    if (r['scoreValidation']['valid'] and not is_theory_paper and open_score_val >= 1.0
            and not has_code_yes and not has_model_yes and not has_dataset_yes):
        r['openSourceScore'] = '0.0'
        if r.get('machineSummary'):
            r['machineSummary']['openSource'] = '0.0'
        r['scoreValidation']['scores']['openSourceScore'] = 0.0
        total = sum(
            normalize_score_to_one_decimal(value)
            for value in r['scoreValidation']['scores'].values()
        )
        r['score'] = f'{normalize_score_to_one_decimal(min(10.0, max(0.0, total))):.1f}'

    # rankBucket 推断：始终基于最终 score 重新计算（覆盖 LLM 原始值）
    if r.get('score'):
        try:
            s = float(r['score'])
            if s >= 9.0:
                r['rankBucket'] = '前10%'
            elif s >= 7.5:
                r['rankBucket'] = '前25%'
            elif s >= 5.5:
                r['rankBucket'] = '前50%'
            else:
                r['rankBucket'] = '后50%'
            # 同步 machineSummary
            if r.get('machineSummary'):
                r['machineSummary']['rankBucket'] = r['rankBucket']
        except (ValueError, TypeError):
            pass

    return r


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('utils.py')

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


def _normalize_tag(raw):
    """标准化标签：加 # 前缀，清理分隔符和多余空格"""
    if not raw:
        return ''
    t = raw.strip().strip('`').strip()
    # 如果有分号/逗号/顿号，只取第一部分
    t = re.split(r'[,，;；、]', t)[0].strip()
    # 如果还没有 # 前缀，加上
    if t and not t.startswith('#'):
        t = '#' + t
    return t


# 允许的标签表（必须与 deep-analysis.md 中的标签表 + JS ALLOWED_TAGS 严格一致）
ALLOWED_TAGS = {
    # 任务 — 语音（19个）
    '语音交互', '语音合成', '语音识别', '语音增强', '语音分离',
    '语音克隆', '语音转换', '语音翻译', '语音情感识别', '语音活动检测',
    '说话人验证', '说话人日志', '语音伪造检测', '语音编辑', '语音质量评估',
    '语音超分', '语音编码', '语音唤醒', '语音属性识别',
    # 任务 — 音频（18个）
    '音频交互', '音频生成', '音频分类', '音频事件检测', '音频理解', '音频检索',
    '音频分离', '音频伪造检测', '空间音频', '声源定位', '音频编码', '音频修复', '音频水印', '音频质量评估',
    '音频超分辨', '音频指纹', '主动降噪', '回声消除',
    # 任务 — 音乐（8个）
    '音乐生成', '音乐检索', '音乐理解', '歌唱生成', '音乐转录', '音乐源分离', '音乐推荐', '音乐超分辨',
    # 任务 — 多模态（10个）
    '音视频理解', '音视频生成', '音视频交互', '音视频语音识别', '音视频语音合成', '音视频语音分离',
    '音视频问答', '音视频声源分离', '音频字幕生成', '音乐文本检索',
    # 方法 — 神经网络架构（17个）
    '自回归模型', '扩散模型', '流匹配', 'Transformer', 'CNN', 'RNN', '图神经网络', '胶囊网络',
    '生成对抗网络', '变分自编码器', '音频大模型', '语音大模型', '多模态模型', '统一音频模型',
    '大语言模型', '生成模型', '端到端',
    # 方法 — 训练策略（28个）
    '预训练', '后训练', 'SFT', '自监督学习', '无监督学习', '对比学习', '强化学习',
    '知识蒸馏', '迁移学习', '领域适应', '测试时自适应', '元学习', '持续学习', '课程学习', '对抗训练',
    '多任务学习', '模型压缩', '模型剪枝', '模型融合', '模型集成', '集成学习', '参数高效微调',
    'LoRA', 'Adapter', '前缀微调', '提示学习', '指令微调', '联邦学习',
    # 属性/设置（12个）
    '多语言', '零样本', '少样本', '低资源',
    '流式处理', '实时处理', '多通道', '在线', '离线',
    '鲁棒性', '高效推理', '长音频处理', '理论分析',
    # 数据/工具/评估（6个）
    '基准测试', '数据集', '开源工具', '模型评估', '模型比较', '数据清洗',
    # 领域/应用（11个）
    '音视频', '工业应用', '医疗音频', '智能座舱', '内容审核', '游戏音频', '智能音箱', '助听器', '会议转录', '教育',
    '可解释性',
}

_BAD_TASK_TAG_PATTERNS = [
    r'^#[a-z]+_[a-z]+',           # snake_case
    r'^#cs\.[A-Z]{2}$',            # arXiv 类别
    r'^#eess\.[A-Z]{2}$',
]
_BAD_TASK_TAG_RE = [re.compile(p, re.I) for p in _BAD_TASK_TAG_PATTERNS]


def _is_bad_task_tag(tag):
    """判断标签是否不合格（不在白名单或匹配坏模式）"""
    if not tag:
        return True
    for pat in _BAD_TASK_TAG_RE:
        if pat.search(tag):
            return True
    # 不在允许标签表中
    tag_name = tag[1:] if tag.startswith('#') else tag
    if tag_name not in ALLOWED_TAGS:
        return True
    return False


# 已知错误标签 → 正确标签映射表（LLM 常犯的自创/英文标签）
_TAG_FIX_MAP = {
    # 英文标签 → 中文
    '#DiffusionModels': '#扩散模型',
    '#FlowMatching': '#流匹配',
    '#Benchmark': '#基准测试',
    '#MusicGeneration': '#音乐生成',
    '#RealTimeSystem': '#实时处理',
    '#KV-Caching': '#高效推理',
    '#InteractiveMusicGeneration': '#音乐生成',
    '#AutoregressiveGeneration': '#自回归模型',
    # 旧标签 → 新标签（LLM 可能还在用旧版标签表中的名称）
    '#语音超分辨': '#语音超分',
    '#语音对话系统': '#语音交互',
    '#音频场景理解': '#音频理解',
    '#音频深度伪造检测': '#音频伪造检测',
    '#歌唱语音合成': '#歌唱生成',
    '#音乐信息检索': '#音乐检索',
    '#说话人识别': '#说话人验证',
    '#说话人分离': '#说话人日志',
    '#语音去噪': '#语音增强',
    '#语音检索': '#音频检索',
    '#风格迁移': '#语音合成',
    '#数据增强': '#预训练',
    '#跨模态': '#多模态模型',
    '#声纹识别': '#说话人验证',
    '#语音驱动': '#音视频生成',
    '#3D音频': '#空间音频',
    '#关键词检测': '#语音唤醒',
    '#信号处理': '#音频理解',
    '#深度学习': '#预训练',
    '#神经网络': '#自监督学习',
    '#GAN': '#生成对抗网络',
    '#VAE': '#变分自编码器',
    '#对抗样本': '#鲁棒性',
    '#模型量化': '#高效推理',
    '#评测协议': '#模型评估',
    '#数据隐私': '#可解释性',
    '#注意力机制': '#Transformer',
    # 常见自创标签
    '#盲源分离': '#音频分离',
    '#语音问答': '#语音交互',
    '#语音摘要': '#语音交互',
    '#语音属性编辑': '#语音编辑',
    '#文本到音乐生成': '#音乐生成',
    '#多模态情感识别': '#语音情感识别',
    '#多模态联合推理': '#音视频理解',
    '#音频推理': '#音频理解',
    '#长期助手': '#语音交互',
    '#伪标签学习': '#自监督学习',
    '#参数高效微调': '#LoRA',
    '#多阶段管线': '#模型融合',
}


def _fix_tag(tag):
    """将已知错误标签映射到正确标签，未知标签原样返回"""
    if not tag:
        return tag
    # 先精确匹配
    fixed = _TAG_FIX_MAP.get(tag)
    if fixed:
        return fixed
    # 处理空格分隔的多个标签，取第一个可映射的
    if ' ' in tag:
        parts = tag.split()
        for p in parts:
            fixed = _TAG_FIX_MAP.get(p)
            if fixed:
                return fixed
        # 如果都没映射到，取第一个已在 ALLOWED_TAGS 中的
        for p in parts:
            nt = _normalize_tag(p)
            if nt and not _is_bad_task_tag(nt):
                return nt
        # 全部都不在列表，取第一个
        return _normalize_tag(parts[0]) if parts else ''
    return tag


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

            item = {'score': None, 'denominator': None, 'declaredMaximum': None, 'matchedFormat': False}
            for index, pattern in enumerate(patterns):
                match = pattern.search(rest)
                if not match:
                    continue
                item['matchedFormat'] = True
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
        normalized_score = normalize_score_to_one_decimal(score)
        if field == 'openSourceScore' and not is_open_source_score_anchor(normalized_score):
            anchors = '/'.join(f'{value:.1f}' for value in OPEN_SOURCE_SCORE_ANCHORS)
            errors.append(f'评分维度“{label}”得分必须为 {anchors}')
            continue
        scores[field] = normalized_score

    return {'valid': not errors, 'scores': scores, 'errors': errors}


def parse_analysis(analysis):
    """解析深度分析文本为结构化字典"""
    if not analysis:
        return None
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
    }

    m = re.search(r'##\s*评分\s*\n\s*\*?(\d+\.?\d*)\*?', analysis)
    r['score'] = m.group(1) if m else ''

    # 先尝试从 ## 标签 部分提取"主任务标签"和"主方法标签"行
    extracted_task_tag = ''
    extracted_method_tag = ''
    tag_section_match = re.search(r'##\s*标签\s*\n([\s\S]*?)(?=\n##\s|\n【|$)', analysis)
    if tag_section_match:
        tag_section = tag_section_match.group(1)
        task_line = re.search(r'主任务标签\s*[：:]\s*(.+)', tag_section)
        if task_line:
            extracted_task_tag = _normalize_tag(task_line.group(1))
        method_line = re.search(r'主方法标签\s*[：:]\s*(.+)', tag_section)
        if method_line:
            extracted_method_tag = _normalize_tag(method_line.group(1))

    m = re.search(r'##\s*标签\s*\n\s*([^\n]+)', analysis)
    if m:
        raw = m.group(1)
        # 先尝试匹配带 # 前缀的标签
        hash_tags = re.findall(r'#\S+', raw)
        if hash_tags:
            r['tags'] = [t for t in (_normalize_tag(tag) for tag in hash_tags) if not _is_bad_task_tag(t)]
        else:
            # 没有 # 前缀时，按分隔符拆分并自动添加 # 前缀
            parts = re.split(r'[,，;；、\s]+', raw)
            r['tags'] = []
            for p in parts:
                trimmed = p.strip().strip('`').strip()
                if trimmed:
                    tag = _normalize_tag(trimmed)
                    if not _is_bad_task_tag(tag):
                        r['tags'].append(tag)
    else:
        r['tags'] = []

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
    # 主任务/主方法标签：优先从 ## 标签 部分的"主任务标签"行提取，
    # 其次从机器摘要获取，最后从 tags[0] fallback。
    # 如果机器摘要的标签质量太差（snake_case/arXiv类别/过于宽泛），则优先使用 tags[0]。
    ms_task = _normalize_tag(machine_summary['primaryTaskTag'])
    ms_method = _normalize_tag(machine_summary['primaryMethodTag'])
    first_tag = _normalize_tag(r['tags'][0]) if r['tags'] else ''
    second_tag = _normalize_tag(r['tags'][1]) if len(r['tags']) > 1 else first_tag

    # 从 tags 列表中找到第一个非坏标签
    good_tag = ''
    for t in r['tags']:
        nt = _normalize_tag(t)
        if nt and not _is_bad_task_tag(nt):
            good_tag = nt
            break

    if extracted_task_tag:
        r['primaryTaskTag'] = extracted_task_tag
    elif not _is_bad_task_tag(ms_task):
        r['primaryTaskTag'] = ms_task
    elif good_tag:
        r['primaryTaskTag'] = good_tag
    else:
        r['primaryTaskTag'] = ms_task or first_tag
    r['primaryTaskTag'] = _fix_tag(r['primaryTaskTag'])

    if extracted_method_tag:
        r['primaryMethodTag'] = extracted_method_tag
    elif not _is_bad_task_tag(ms_method):
        r['primaryMethodTag'] = ms_method
    elif good_tag and good_tag != r['primaryTaskTag']:
        r['primaryMethodTag'] = good_tag
    else:
        r['primaryMethodTag'] = ms_method or second_tag
    r['primaryMethodTag'] = _fix_tag(r['primaryMethodTag'])

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

#!/usr/bin/env python3
"""
Paper Digest 公共工具模块 (Python)
统一封装：Markdown 处理、分析文本解析、时间处理
"""

import re
import os
from datetime import datetime, timezone, timedelta

BJ_TZ = timezone(timedelta(hours=8))


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


def parse_analysis(analysis):
    """解析深度分析文本为结构化字典"""
    if not analysis:
        return None
    r = {
        'machineSummary': None,
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
    }

    m = re.search(r'##\s*评分\s*\n\s*\*?(\d+\.?\d*)\*?', analysis)
    r['score'] = m.group(1) if m else ''

    # 如果未匹配到 ## 评分，从机器摘要的 innovation 获取（作为回退）
    if not r['score']:
        ms = parse_machine_summary(analysis)
        if ms.get('innovation'):
            r['score'] = ms['innovation']

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
            r['tags'] = hash_tags
        else:
            # 没有 # 前缀时，按分隔符拆分并自动添加 # 前缀
            parts = re.split(r'[,，;；、\s]+', raw)
            r['tags'] = []
            for p in parts:
                trimmed = p.strip().strip('`').strip()
                if trimmed:
                    r['tags'].append('#' + trimmed)
    else:
        r['tags'] = []

    machine_summary = parse_machine_summary(analysis)
    r['machineSummary'] = machine_summary
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

    # 从评分理由中提取六个分项并计算总分，始终覆盖 LLM 给出的总分
    scoring_text = r.get('scoringReason', '')
    if not scoring_text:
        # fallback: 在整个分析文本中搜索
        m = re.search(r'#+\s*(?:\d+[.\s]+)?评分理由.*?\n([\s\S]*?)(?=\n#+\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|细节详述)|\n##\s|$)', analysis)
        if m:
            scoring_text = m.group(1).strip()

    if scoring_text:
        # 每个维度的上限（用于截断旧格式或 LLM 越界输出）
        dim_max = {
            '创新性': 2,
            '技术严谨性': 1.5,
            '实验充分性': 1.5,
            '清晰度': 1,
            '影响力': 1.5,
            '开源': 1.5,
            '可复现性': 0.5,
            '工程/实践价值': 1.5
        }
        dim_scores = {}
        for dim, max_val in dim_max.items():
            # 支持多种 LLM 输出格式
            # 格式A（10分制，需转换）：dim (max/max)：score/10
            # 格式B（维度分制，直接用）：dim (score/max)：description
            # 格式C：dim：score/max

            # 优先匹配10分制格式（格式A）：dim ... ：score/10
            ten_point_pat = re.compile(
                r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*\d+\.?\d*\s*/\s*\d+\.?\d*\s*[）)]\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(\d+\.?\d*)\s*/\s*10'
            )
            ten_point_match = ten_point_pat.search(scoring_text)
            if ten_point_match:
                try:
                    v10 = float(ten_point_match.group(1))
                    dim_scores[dim] = round((v10 / 10) * max_val, 1)
                    continue
                except (ValueError, TypeError):
                    pass

            # 次优先：dim ... 得分X.Y/max 格式（得分在描述末尾）
            defen_pat = re.compile(
                r'(?:\*\*)?\s*' + re.escape(dim) + r'.*?得分(\d+\.?\d*)\s*(?:/\s*(\d+\.?\d*))?'
            )
            defen_match = defen_pat.search(scoring_text)
            if defen_match:
                try:
                    v_defen = float(defen_match.group(1))
                    v_max_str = defen_match.group(2)
                    v_max = float(v_max_str) if v_max_str else None
                    if v_max and v_max == 10:
                        dim_scores[dim] = round((v_defen / 10) * max_val, 1)
                    elif v_max and v_max > 0:
                        dim_scores[dim] = min(v_defen, max_val)
                    else:
                        # 无/max：假设是维度原始分值
                        dim_scores[dim] = min(v_defen, max_val)
                    continue
                except (ValueError, TypeError):
                    pass

            # 非10分制的常规匹配
            dm = None
            for pat in [
                # 格式0: dim (max分)：score/max（如 HAIM 的格式）
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*\d+\.?\d*分\s*[）)]\s*[:：]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*'),
                # 格式1: dim (score/max)：description（排除有/10的情况）
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*\s*[）)](?!.*/10)'),
                # 格式2: dim：score/max
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[:：]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*\s*(?:\*\*)?'),
                # 格式3: dim/满分：得分 score
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*/\s*\d+\.?\d*\s*[:：]\s*(?:得分\s*)?(\d+\.?\d*)'),
                # 格式4: dim (max分 / 满分max分) -> score分
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*\d+\.?\d*分\s*/\s*满分\s*\d+\.?\d*分\s*[）)]\s*->\s*(\d+\.?\d*)分'),
                # 格式5: dim（/max）：score/max
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*/\s*\d+\.?\d*\s*[）)]\s*[:：]\s*(\d+\.?\d*)'),
                # 格式6: dim (max分中的score分)
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*\d+\.?\d*分中的(\d+\.?\d*)分\s*[）)]'),
            ]:
                dm = pat.search(scoring_text)
                if dm:
                    break
            if dm:
                try:
                    dim_scores[dim] = min(float(dm.group(1)), max_val)
                except (ValueError, TypeError):
                    pass
        if dim_scores:
            total = sum(dim_scores.values())
            total = max(1.0, min(10.0, total))
            r['score'] = str(round(total, 1))

            # 用评分理由的分项覆盖结果字段，确保与总分一致
            r['innovationScore'] = str(round(dim_scores.get('创新性', 0), 1))
            r['technicalRigorScore'] = str(round(dim_scores.get('技术严谨性', 0), 1))
            r['experimentalSufficiencyScore'] = str(round(dim_scores.get('实验充分性', 0), 1))
            r['clarityScore'] = str(round(dim_scores.get('清晰度', 0), 1))
            r['impactScore'] = str(round(dim_scores.get('影响力', 0), 1))
            r['openSourceScore'] = str(round(dim_scores.get('开源', 0), 1))
            r['reproducibilityScore'] = str(round(dim_scores.get('可复现性', 0), 1))
            r['engineeringScore'] = str(round(dim_scores.get('工程/实践价值', 0), 1))
            if r.get('machineSummary'):
                r['machineSummary']['innovation'] = r['innovationScore']
                r['machineSummary']['technicalRigor'] = r['technicalRigorScore']
                r['machineSummary']['experimentalSufficiency'] = r['experimentalSufficiencyScore']
                r['machineSummary']['clarity'] = r['clarityScore']
                r['machineSummary']['impact'] = r['impactScore']
                r['machineSummary']['openSource'] = r['openSourceScore']
                r['machineSummary']['reproducibility'] = r['reproducibilityScore']
                r['machineSummary']['engineeringScore'] = r['engineeringScore']

    # 矛盾检测：开源高分但无任何实际链接
    open_score_val = float(r.get('openSourceScore', 0) or 0)
    has_code_yes = r.get('hasCode') in ('是', 'yes')
    has_model_yes = r.get('hasModel') in ('是', 'yes')
    has_dataset_yes = r.get('hasDataset') in ('是', 'yes')
    if open_score_val >= 1.0 and not has_code_yes and not has_model_yes and not has_dataset_yes:
        r['openSourceScore'] = '0'
        if r.get('machineSummary'):
            r['machineSummary']['openSource'] = '0'
        total = float(r.get('score', 0) or 0)
        total = max(1.0, min(10.0, total - open_score_val))
        r['score'] = str(round(total, 1))

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

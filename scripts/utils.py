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
    t = re.sub(r'^#{1,6}\s+', '', t, flags=re.MULTILINE)
    return t.strip()


def parse_machine_summary(analysis):
    """解析 机器摘要 块（兼容 ## 和 ### 标题）"""
    result = {
        'rankBucket': '',
        'qualityScore': '',
        'valueScore': '',
        'reproducibilityBonus': '',
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
        'quality_score': 'qualityScore',
        'value_score': 'valueScore',
        'reproducibility_bonus': 'reproducibilityBonus',
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
            if mapped in ('qualityScore', 'valueScore', 'reproducibilityBonus'):
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


# 允许的标签表（必须与 deep-analysis.md 中的标签表保持一致）
ALLOWED_TAGS = {
    '音频大模型', '语音大模型', '多模态模型', '统一音频模型', '大语言模型',
    '生成模型', '自回归模型', '端到端', '语音合成', '语音识别', '语音增强',
    '语音分离', '语音克隆', '语音转换', '语音翻译', '语音情感识别',
    '语音活动检测', '说话人识别', '说话人验证', '说话人分离', '说话人日志',
    '语音对话系统', '语音伪造检测', '语音匿名化', '语音生物标志物', '语音编辑',
    '语音质量评估', '语音打断处理', '语音去噪', '语音超分辨', '语音补全',
    '语音风格迁移', '情感语音合成', '语音编码', '语音检索', '语音问答', '语音摘要',
    '音频生成', '音频分类', '音频事件检测', '音频场景理解', '音频问答', '音频检索',
    '音频安全', '音频深度伪造检测', '声景生成', '音频超分辨', '音频指纹',
    '房间声学', '回声消除', '空间音频', '3D音频', '声源定位', '生物声学',
    '音频编码', '音频修复', '音频水印', '音频质量评估',
    '音乐生成', '音乐信息检索', '音乐理解', '歌唱语音合成', '音乐转录',
    '和弦识别', '节拍跟踪', '音乐源分离', '音乐结构分析', '乐器识别',
    '音乐表示学习', '风格迁移', '音乐评估', '舞台技术', '乐谱生成', '音乐推荐',
    '音乐去噪', '音乐超分辨',
    '深度学习', '神经网络', '生成模型', '关键词检测', '声区控制', '数据声化', '认知科学', '统计信号处理',
    '预训练', '自监督学习', '对比学习', '强化学习', '知识蒸馏', '迁移学习',
    '领域适应', '数据增强', '扩散模型', '流匹配',
    'Transformer', 'GAN', 'VAE', '注意力机制', '联邦学习', '提示学习', '指令微调', '模型融合',
    '信号处理', '麦克风阵列', '波束成形', '时频分析', '多任务学习',
    '多语言', '零样本', '少样本', '低资源', '流式处理', '实时处理', '多通道', '在线', '离线',
    '对抗样本', '鲁棒性', '模型量化', '高效推理', '长音频处理', '基准测试',
    '数据集', '开源工具', '模型评估', '模型比较', '数据清洗', '评测协议',
    '数据隐私', '音视频', '跨模态', '工业应用', '医疗音频', '智能座舱',
    '内容审核', '游戏音频', '声纹识别', '语音驱动', '智能音箱', '助听器', '会议转录',
}

_BAD_TASK_TAG_PATTERNS = [
    r'^#[a-z]+_[a-z]+',           # snake_case 如 #uncertainty_estimation
    r'^#cs\.[A-Z]{2}$',            # arXiv 类别如 #cs.CL
    r'^#eess\.[A-Z]{2}$',          # arXiv 类别如 #eess.AS
    r'^#Theory$',                  # 过于宽泛
    r'^#Speech Processing$',       # 过于宽泛
    r'^#System Description$',      # 不是任务标签
    r'^#Audio Generation$',        # 方法 disguised as 任务 (英文)
    r'^#系统描述$',                # 不是具体任务标签
]
_BAD_TASK_TAG_RE = [re.compile(p, re.I) for p in _BAD_TASK_TAG_PATTERNS]


def _is_bad_task_tag(tag):
    """判断任务标签质量是否太差，需要 fallback 到 tags[0]"""
    if not tag:
        return True
    for pat in _BAD_TASK_TAG_RE:
        if pat.search(tag):
            return True
    # 过长且含空格的英文描述（如 #Sound Zone Control）
    if len(tag) > 15 and ' ' in tag and not any('\u4e00' <= c <= '\u9fff' for c in tag):
        return True
    # 包含冒号/论文类型等明显不是任务标签的内容
    if '论文类型' in tag or '类型:' in tag or ('类型' in tag and ':' in tag):
        return True
    # 不在允许标签表中
    tag_name = tag[1:] if tag.startswith('#') else tag
    if tag_name not in ALLOWED_TAGS:
        return True
    return False


# 已知错误标签 -> 正确标签映射表（LLM 常犯的自创/英文标签）
_TAG_FIX_MAP = {
    # 英文标签
    '#InteractiveMusicGeneration': '#音乐生成',
    '#DiffusionModels': '#扩散模型',
    '#FlowMatching': '#流匹配',
    '#Benchmark': '#基准测试',
    '#MusicGeneration': '#音乐生成',
    '#AutoregressiveGeneration': '#自回归模型',
    '#RealTimeSystem': '#实时处理',
    '#KV-Caching': '#高效推理',
    # 自创/不在列表的中文标签
    '#政治演讲中的情感诉求分析': '#语音情感识别',
    '#基于大语言模型的多模态情感分析': '#大语言模型',
    '#音频去噪': '#语音去噪',
    '#条件生成模型': '#生成模型',
    '#用户定义关键词检测': '#关键词检测',
    '#个人声区滤波器生成': '#声区控制',
    '#数据声化': '#数据声化',
    '#参数映射': '#信号处理',
    '#文本到音乐生成': '#音乐生成',
    '#标准化基准': '#基准测试',
    '#多阶段评估': '#模型评估',
    '#非高斯随机过程估计': '#统计信号处理',
    '#Kunchenko随机多项式': '#统计信号处理',
    '#多项式最大化方法': '#统计信号处理',
    '#听觉认知建模': '#认知科学',
    '#语音熵': '#统计信号处理',
    '#语音语言模型内部机制分析': '#大语言模型',
    '#因果中介分析': '#模型评估',
    '#多模态联合推理': '#跨模态',
    '#潜在空间推理': '#跨模态',
    '#交错推理': '#跨模态',
    '#跨模态指代消歧与定位': '#跨模态',
    '#上下文改写与视觉定位解耦': '#跨模态',
    '#视频理解基准测试': '#音视频',
    '#多模态数据集构建': '#数据集',
    '#双阶段匹配': '#迁移学习',
    '#多模态注册': '#迁移学习',
    '#参数高效微调': '#迁移学习',
    '#坐标条件神经网络': '#神经网络',
    '#盲源分离': '#语音分离',
    '#声场重建': '#空间音频',
    '#LMMSE估计': '#信号处理',
    '#伪标签学习': '#自监督学习',
    '#多媒体取证': '#音频安全',
    '#合成媒体与深度伪造检测': '#音频深度伪造检测',
    '#音频推理': '#音频问答',
    '#长期助手': '#语音对话系统',
    '#代理基准测试': '#基准测试',
    '#多模态情感识别': '#语音情感识别',
    '#多编码器融合': '#模型融合',
    '#视频生成': '#音视频',
    '#不确定性估计': '#模型评估',
    '#证据深度学习': '#深度学习',
    '#视觉语言定位': '#跨模态',
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
        'qualityScore': '',
        'valueScore': '',
        'reproducibilityBonus': '',
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

    # 如果未匹配到 ## 评分，从机器摘要的 quality_score 获取
    if not r['score']:
        ms = parse_machine_summary(analysis)
        if ms.get('qualityScore'):
            r['score'] = ms['qualityScore']

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
    r['qualityScore'] = machine_summary['qualityScore']
    r['valueScore'] = machine_summary['valueScore']
    r['reproducibilityBonus'] = machine_summary['reproducibilityBonus']
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
            '创新性': 3,
            '技术严谨性': 1.5,
            '实验充分性': 1.5,
            '清晰度': 1,
            '影响力': 2,
            '开源': 1.5,
            '可复现性': 0.5
        }
        dim_scores = {}
        for dim, max_val in dim_max.items():
            # 支持多种 LLM 输出格式：
            # 1. **创新性 (3分)**：2.2分
            # 2. **创新性 (2.5/3)**：...
            # 3. **创新性: 2.3/3**
            dm = None
            for pat in [
                # 格式1: dim (max/max)**：score 或 dim（max/max）**：score
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*\d+\.?\d*\s*(?:/\s*\d+\.?\d*)?\s*分?\s*[）)]\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(\d+\.?\d*)'),
                # 格式2: dim (score/max) 或 dim（score/max）
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*\s*[）)]'),
                # 格式3: dim: score/max
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[:：]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*\s*(?:\*\*)?'),
                # 格式4: dim（score/max）：description
                re.compile(r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[（(]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*\s*[）)]\s*[:：]'),
            ]:
                dm = pat.search(scoring_text)
                if dm:
                    break
            if dm:
                try:
                    # 截断到该维度的上限，防止旧格式或 LLM 越界输出导致总分异常
                    dim_scores[dim] = min(float(dm.group(1)), max_val)
                except (ValueError, TypeError):
                    pass
        if dim_scores:
            total = sum(dim_scores.values())
            total = max(1.0, min(10.0, total))
            r['score'] = str(round(total, 1))

            # 用评分理由的分项覆盖机器摘要字段，确保与总分一致
            qs = dim_scores.get('创新性', 0) + dim_scores.get('技术严谨性', 0) \
                 + dim_scores.get('实验充分性', 0) + dim_scores.get('清晰度', 0)
            vs = dim_scores.get('影响力', 0)
            rb = dim_scores.get('开源', 0) + dim_scores.get('可复现性', 0)
            r['qualityScore'] = str(round(qs, 1))
            r['valueScore'] = str(round(vs, 1))
            r['reproducibilityBonus'] = str(round(rb, 1))
            if r.get('machineSummary'):
                r['machineSummary']['qualityScore'] = r['qualityScore']
                r['machineSummary']['valueScore'] = r['valueScore']
                r['machineSummary']['reproducibilityBonus'] = r['reproducibilityBonus']

    # rankBucket 推断：在评分计算完成后执行，确保基于最终 score
    if not r.get('rankBucket') and r.get('score'):
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
        except (ValueError, TypeError):
            pass

    return r

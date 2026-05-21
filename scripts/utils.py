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
        km = re.match(r'^([a-z_]+)\s*[：:]\s*(.+)$', line, flags=re.I)
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
            # 对于 rankBucket，验证是否为合理的分档标识
            if mapped == 'rankBucket':
                valid_bucket = re.match(r'^(前\d+%|后\d+%|中等偏上|中等偏下|中等|Top\s*\d+%|Bottom\s*\d+%)$', val)
                if not valid_bucket:
                    val = ''
            result[mapped] = val

    return result


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


    m = re.search(r'##\s*标签\s*\n\s*([^\n]+)', analysis)
    if m:
        raw = m.group(1)
        parts = re.split(r'[,、\s]+', raw)
        r['tags'] = [p.strip() for p in parts if p.strip().startswith('#')]
    else:
        r['tags'] = []

    machine_summary = parse_machine_summary(analysis)
    r['machineSummary'] = machine_summary
    r['rankBucket'] = machine_summary['rankBucket']

    # 如果 rankBucket 为空，根据 score 推断分档
    if not r['rankBucket'] and r['score']:
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
    r['qualityScore'] = machine_summary['qualityScore']
    r['valueScore'] = machine_summary['valueScore']
    r['reproducibilityBonus'] = machine_summary['reproducibilityBonus']
    r['confidence'] = machine_summary['confidence']
    r['primaryTaskTag'] = machine_summary['primaryTaskTag']
    r['primaryMethodTag'] = machine_summary['primaryMethodTag']
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
        ('scoringReason', r'#{2,3}\s*(?:\d+[.\s]+)?评分理由[：:\s]*\n([\s\S]*?)(?=\n#{2,3}\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|细节详述)|\n##\s|$)'),
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
        m = re.search(r'#+\s*(?:\d+[.\s]+)?评分理由[：:\s]*\n([\s\S]*?)(?=\n#+\s*(?:\d+[.\s]+)?(?:方法概述和架构|核心创新点|实验结果|细节详述)|\n##\s|$)', analysis)
        if m:
            scoring_text = m.group(1).strip()

    if scoring_text:
        dim_scores = {}
        for dim in ['创新性', '技术严谨性', '实验充分性', '清晰度', '影响力', '开源', '可复现性']:
            # 匹配 **创新性：2.3/3** 或 创新性: 2.3/3 等变体
            pat = re.compile(
                r'(?:\*\*)?\s*' + re.escape(dim) + r'\s*[:：]\s*(\d+\.?\d*)\s*/\s*\d+\.?\d*\s*(?:\*\*)?'
            )
            dm = pat.search(scoring_text)
            if dm:
                try:
                    dim_scores[dim] = float(dm.group(1))
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

    return r

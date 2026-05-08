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
    """解析 ### 机器摘要 块"""
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

    m = re.search(r'###\s*机器摘要\s*\n([\s\S]*?)(?=\n###\s*评分规则|\n##\s*标签|$)', analysis)
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
            result[mapped] = strip_md(km.group(2))

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

    m = re.search(r'##\s*核心摘要\s*\n([\s\S]*?)(?=\n##|$)', analysis)
    r['summary'] = m.group(1).strip() if m else ''

    detail_block = re.search(r'##\s*详细分析\s*\n([\s\S]*?)(?=\n##\s*(?:开源|图片)|$)', analysis)
    r['detailIntro'] = r['architecture'] = r['innovation'] = r['details'] = r['results'] = r['scoringReason'] = ''

    if detail_block:
        block = detail_block.group(1)
    else:
        # Fallback: if "详细分析" header is corrupted/missing, search the whole text for subsections
        block = analysis
        intro_m = re.match(r'^([\s\S]*?)(?=\n###|$)', block)
        if intro_m and intro_m.group(1).strip():
            r['detailIntro'] = intro_m.group(1).strip()

        for key, pat in [
            ('architecture', r'###\s*\d+\.\s*方法概述和架构\s*\n([\s\S]*?)(?=\n###|\n##|$)'),
            ('innovation', r'###\s*\d+\.\s*核心创新点\s*\n([\s\S]*?)(?=\n###|\n##|$)'),
            ('details', r'###\s*\d+\.\s*细节详[述题]\s*\n([\s\S]*?)(?=\n###|\n##|$)'),
            ('results', r'###\s*\d+\.\s*实验结果\s*\n([\s\S]*?)(?=\n###|\n##|$)'),
            ('scoringReason', r'###\s*\d+\.\s*评分理由\s*\n([\s\S]*?)(?=\n###|\n##|$)'),
        ]:
            sm = re.search(pat, block)
            if sm:
                r[key] = sm.group(1).strip()

    m = re.search(r'##\s*开源(?:详情)?[：:]*\s*\n([\s\S]*?)(?=\n##|$)', analysis)
    r['opensource'] = m.group(1).strip() if m else ''

    return r

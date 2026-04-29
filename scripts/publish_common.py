#!/usr/bin/env python3
"""
Paper Digest 发布公共模块 (Python)
统一封装：数据加载、评分排序、标签提取、格式化工具
消除 publish-to-blog.py / publish-wechat-full.py / publish-xiaohongshu.py 的重复逻辑
"""

import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import parse_analysis

BJ_TZ = timezone(timedelta(hours=8))


def load_papers(data_file=None):
    """从 deep-analysis-result.json 加载论文列表"""
    if data_file is None:
        data_file = os.path.join(
            os.path.dirname(__file__), '..', 'data', 'current', 'deep-analysis-result.json'
        )
    with open(data_file) as f:
        raw = json.load(f)
    papers = raw['papers'] if isinstance(raw, dict) else raw
    print(f"📚 读取 {len(papers)} 篇论文")
    return papers


def get_today_bj(target_date=None):
    """返回北京时间日期字符串 YYYY-MM-DD"""
    return target_date or datetime.now(BJ_TZ).strftime('%Y-%m-%d')


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


def score_and_sort(papers):
    """
    解析每篇论文的分析结果，按评分降序排列。
    返回 [(score, paper, parsed), ...]，未评分的排在最后。
    """
    scored = []
    unscored = []
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if pa and pa.get('score'):
            try:
                scored.append((float(pa['score']), p, pa))
            except (ValueError, TypeError):
                unscored.append(p)
        else:
            unscored.append(p)
    scored.sort(key=lambda x: -x[0])
    return scored, unscored


def extract_top_tags(papers, limit=8):
    """
    从论文列表中提取主任务标签并统计频次。
    返回 [(tag, count), ...]，按数量降序。
    """
    tag_count = {}
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not pa:
            continue
        hot_tag = pa.get('primaryTaskTag') or (pa['tags'][0] if pa.get('tags') else '')
        if hot_tag:
            tag_count[hot_tag] = tag_count.get(hot_tag, 0) + 1
    return sorted(tag_count.items(), key=lambda x: -x[1])[:limit]


def extract_all_tags(papers, limit=10):
    """
    提取所有标签（去重），用于博客标签云。
    返回标签字符串列表（不带 #）。
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
    """从分析结果中提取一句话亮点，清理 Markdown 格式"""
    text = ''
    if pa.get('summary'):
        text = pa['summary'].split('。')[0].strip()
    elif pa.get('roast'):
        text = pa['roast'].split('。')[0].strip()

    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'`(.+?)`', r'\1', text)
    text = re.sub(r'^这篇论文旨在', '', text)
    text = re.sub(r'^这篇技术报告全面介绍了', '', text)
    text = re.sub(r'^本文针对', '', text)
    text = re.sub(r'^本文提出了', '', text)
    text = re.sub(r'^解决', '', text)
    text = re.sub(r'^核心贡献：', '', text)
    text = re.sub(r'^本文', '', text)
    text = text.strip()

    if len(text) > 10:
        return text[:80] + ('...' if len(text) > 80 else '')
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
    if pa.get('primaryTaskTag'):
        bits.append(pa['primaryTaskTag'])
    if pa.get('primaryMethodTag'):
        bits.append(pa['primaryMethodTag'])

    extra_tags = [t for t in pa.get('tags', [])
                  if t not in {pa.get('primaryTaskTag'), pa.get('primaryMethodTag')}]
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

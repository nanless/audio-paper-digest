#!/usr/bin/env python3
from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
补录近期 arXiv 和 HuggingFace 论文元数据，合并写入 papers.json。
请求设置超时；来源抓取失败时停止，不把失败当作没有新论文。
"""

import json
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import requests

from path_config import (
    DATA_DIR,
    PAPERS_FILE,
    atomic_write_json,
    backfill_result_path,
    update_json_file_locked,
)
from project_env import build_fetch_proxies

BJ_TZ = timezone(timedelta(hours=8))

def now_bj():
    return datetime.now(BJ_TZ)

CATEGORIES = [
    ('eess.AS', '音频语音'),
    ('cs.SD', '声音'),
    ('eess.SP', '信号处理'),
    ('cs.CL', '计算语言学'),
    ('cs.LG', '机器学习'),
    ('cs.AI', '人工智能'),
    ('cs.MM', '多媒体'),
]
def fetch_proxies():
    return build_fetch_proxies()

def log(msg):
    line = f"[{now_bj().isoformat()}] {msg}"
    print(line)

def load_papers():
    if os.path.exists(PAPERS_FILE):
        with open(PAPERS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {'papers': {}, 'lastUpdated': None}

def save_papers(data):
    expected_generation = data.get('generation', 0) if isinstance(data, dict) else None
    data['lastUpdated'] = now_bj().isoformat()
    return update_json_file_locked(
        PAPERS_FILE,
        lambda _current: data,
        expected_generation=expected_generation,
    )


def merge_and_save_papers(new_papers):
    counts = {'added': 0, 'skipped': 0}

    def merge(current):
        if current is None:
            current = {'papers': {}, 'lastUpdated': None}
        if not isinstance(current, dict) or not isinstance(current.get('papers'), dict):
            raise RuntimeError('papers.json 结构非法，拒绝覆盖')
        merged = dict(current)
        merged_papers = dict(current['papers'])
        for pid, paper in new_papers.items():
            if pid in merged_papers:
                counts['skipped'] += 1
                continue
            merged_papers[pid] = paper
            counts['added'] += 1
        merged['papers'] = merged_papers
        merged['lastUpdated'] = now_bj().isoformat()
        return merged

    saved = update_json_file_locked(PAPERS_FILE, merge)
    return saved, counts


def save_backfill_result(data, result_path=None):
    target = result_path or backfill_result_path()
    atomic_write_json(target, data)
    return target

def fetch_arxiv_category(category_id, max_results=30, existing_ids=None):
    """抓取单个 arxiv 类别，带重试和提前停止"""
    url = (
        f"https://export.arxiv.org/api/query?"
        f"search_query=cat:{category_id}&"
        f"sortBy=submittedDate&sortOrder=descending&"
        f"max_results={max_results}"
    )
    headers = {'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)'}
    proxies = fetch_proxies()
    last_error = None

    for attempt in range(1, 6):
        try:
            log(f"  请求 {category_id} (尝试 {attempt}/5)...")
            resp = requests.get(url, headers=headers, timeout=30, proxies=proxies)
            if resp.status_code == 429:
                last_error = RuntimeError('arXiv 返回 HTTP 429')
                wait = min(2 ** attempt * 5, 60)
                log(f"  限流，等待 {wait}秒...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            break
        except requests.exceptions.Timeout as exc:
            last_error = exc
            log(f"  超时，{attempt*5}秒后重试...")
            time.sleep(attempt * 5)
        except Exception as e:
            last_error = e
            log(f"  错误: {e}")
            time.sleep(attempt * 5)
    else:
        raise RuntimeError(f'arXiv 类别 {category_id} 抓取失败，不能当作空结果') from last_error

    papers = []
    try:
        root = ET.fromstring(resp.content)
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        if root.tag != '{http://www.w3.org/2005/Atom}feed':
            raise ValueError('响应不是 Atom feed')
        entries = root.findall('atom:entry', ns)
    except Exception as e:
        raise RuntimeError(f'arXiv 类别 {category_id} 的 XML 响应无效') from e

    consecutive_existing = 0
    for entry in entries:
        id_elem = entry.find('atom:id', ns)
        if id_elem is None or not (id_elem.text or '').strip():
            raise RuntimeError(f'arXiv 类别 {category_id} 的记录缺少论文 ID')
        if '/api/errors' in id_elem.text:
            raise RuntimeError(f'arXiv 类别 {category_id} 返回错误记录，不能写入论文库')
        arxiv_id = id_elem.text.split('/abs/')[-1].strip()

        if existing_ids and arxiv_id in existing_ids:
            consecutive_existing += 1
            if consecutive_existing >= 20:
                log(f"  遇到连续{consecutive_existing}篇已知论文，停止")
                break
            continue
        consecutive_existing = 0

        title = entry.find('atom:title', ns)
        title = title.text.replace('\n', ' ').strip() if title is not None and title.text else ''

        summary = entry.find('atom:summary', ns)
        summary = summary.text.replace('\n', ' ').strip() if summary is not None and summary.text else ''

        authors = [name.text for name in entry.findall('atom:author/atom:name', ns) if name.text]

        published = entry.find('atom:published', ns)
        published = published.text if published is not None else ''

        categories = [cat.get('term') for cat in entry.findall('atom:category', ns) if cat.get('term')]

        papers.append({
            'arxivId': arxiv_id,
            'title': title,
            'abstract': summary,
            'authors': authors,
            'published': published,
            'categories': categories,
            'fetchedFrom': category_id,
            'fetchedAt': now_bj().isoformat(),
        })

    return papers

def fetch_hf_papers(existing_ids, days=7):
    """抓取 HuggingFace Papers"""
    cutoff = now_bj() - timedelta(days=days)
    cutoff_str = cutoff.strftime('%Y-%m-%d')
    proxies = fetch_proxies()

    merged = {}

    page = 0
    while page < 20:
        offset = page * 100
        url = f"https://huggingface.co/api/daily_papers?limit=100&offset={offset}"
        try:
            resp = requests.get(url, timeout=30, proxies=proxies)
            resp.raise_for_status()
            data = resp.json()
            if not isinstance(data, list):
                raise ValueError('HuggingFace daily_papers 响应不是列表')
            if not data:
                break

            oldest = None
            for item in data:
                if not isinstance(item, dict):
                    continue
                paper = item.get('paper') or item
                pid = paper.get('id')
                if not pid:
                    continue
                pub = (paper.get('publishedAt') or '').split('T')[0]
                if pub and pub < cutoff_str:
                    continue
                if oldest is None or (pub and pub < oldest):
                    oldest = pub
                if pid not in merged:
                    authors = [a.get('name', '') for a in paper.get('authors', []) if a.get('name')]
                    merged[pid] = {
                        'paper_id': pid,
                        'arxivId': pid,
                        'title': paper.get('title', ''),
                        'authors': authors,
                        'summary': paper.get('summary', ''),
                        'publishedAt': paper.get('publishedAt', ''),
                        'updatedDate': pub,
                        'categories': [],
                        'primaryCategory': '',
                        'pdfLink': f"https://arxiv.org/pdf/{pid}",
                        'absLink': f"https://arxiv.org/abs/{pid}",
                        'source': 'huggingface',
                    }

            log(f"  HF daily_papers 页{page+1}: {len(data)}篇, 最早{oldest}")
            if len(data) < 100 or (oldest and oldest < cutoff_str):
                break
            page += 1
            time.sleep(1)
        except Exception as e:
            raise RuntimeError(f'HuggingFace daily_papers 第 {page + 1} 页抓取失败') from e

    try:
        resp = requests.get("https://huggingface.co/api/papers?limit=100", timeout=30, proxies=proxies)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            raise ValueError('HuggingFace papers 响应不是列表')
        for item in data:
            if not isinstance(item, dict):
                continue
            pid = item.get('id')
            if not pid:
                continue
            pub = (item.get('publishedAt') or '').split('T')[0]
            if pub and pub < cutoff_str:
                continue
            if pid not in merged:
                authors = [a.get('name', '') for a in item.get('authors', []) if a.get('name')]
                merged[pid] = {
                    'paper_id': pid,
                    'arxivId': pid,
                    'title': item.get('title', ''),
                    'authors': authors,
                    'summary': item.get('summary', ''),
                    'publishedAt': item.get('publishedAt', ''),
                    'updatedDate': pub,
                    'categories': [],
                    'primaryCategory': '',
                    'pdfLink': f"https://arxiv.org/pdf/{pid}",
                    'absLink': f"https://arxiv.org/abs/{pid}",
                    'source': 'huggingface',
                }
        log(f"  HF papers API: {len(data)}篇")
    except Exception as e:
        raise RuntimeError('HuggingFace papers 抓取失败') from e

    result = [p for p in merged.values() if p['paper_id'] not in existing_ids]
    return result

def main():
    log(f"=== 补录开始 {now_bj().isoformat()} ===")

    papers_data = load_papers()
    existing_ids = set(papers_data['papers'].keys())
    log(f"当前 papers.json 已有 {len(existing_ids)} 篇")

    log("开始 arxiv 抓取...")
    arxiv_papers = []
    for cat_id, cat_name in CATEGORIES:
        log(f"抓取 {cat_name} ({cat_id})...")
        papers = fetch_arxiv_category(cat_id, max_results=30, existing_ids=existing_ids)
        arxiv_papers.extend(papers)
        log(f"  ✓ {cat_id}: {len(papers)} 篇新论文")

        for p in papers:
            existing_ids.add(p['arxivId'])

        log("  等待 10 秒...")
        time.sleep(10)

    log(f"arxiv 抓取完成: {len(arxiv_papers)} 篇")

    log("HuggingFace 抓取...")
    all_existing = set(papers_data['papers'].keys()) | {p.get('arxivId') for p in arxiv_papers if p.get('arxivId')}
    hf_papers = fetch_hf_papers(all_existing, days=7)
    log(f"HF 抓取完成: {len(hf_papers)} 篇")

    all_papers = {}
    for p in arxiv_papers:
        all_papers[p['arxivId']] = p
    for p in hf_papers:
        pid = p['paper_id'] or p['arxivId']
        if pid not in all_papers:
            all_papers[pid] = p

    log(f"合并去重后: {len(all_papers)} 篇")

    valid_new_papers = {}
    for p in all_papers.values():
        pid = p.get('paper_id') or p.get('arxivId')
        if pid:
            valid_new_papers[pid] = p

    papers_data, counts = merge_and_save_papers(valid_new_papers)
    added = counts['added']
    skipped = counts['skipped']
    log(f"已保存: 新增 {added} 篇，跳过 {skipped} 篇，总计 {len(papers_data['papers'])} 篇")

    result = {
        'timestamp': now_bj().isoformat(),
        'arxivFetched': len(arxiv_papers),
        'hfFetched': len(hf_papers),
        'totalNew': len(all_papers),
        'added': added,
        'skipped': skipped,
        'totalInDb': len(papers_data['papers']),
        'paperIds': list(all_papers.keys()),
    }
    result_path = save_backfill_result(result)
    log(f"详细结果已保存到 {result_path}")

    log("=== 补录完成 ===")

if __name__ == '__main__':
    main()

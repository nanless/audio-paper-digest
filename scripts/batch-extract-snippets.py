#!/usr/bin/env python3
"""
批量提取所有ICASSP论文的PDF文本片段，保存到icassp-2026-snippets.json
支持断点续传和多进程并行
"""

import json
import os
import re
import sys
import fitz
from multiprocessing import Pool, cpu_count
from datetime import datetime, timezone, timedelta

PAPERS_JSON = '/Users/francis7999/Documents/icassp-2026-papers/papers_2026.json'
PDF_DIR = '/Users/francis7999/Documents/icassp-2026-papers/papers_2026'
OUTPUT_FILE = '/Users/francis7999/code/github_repos/audio-paper-digest/data/current/icassp-2026-snippets.json'
PROGRESS_FILE = '/Users/francis7999/code/github_repos/audio-paper-digest/data/current/.extract_progress.json'
SNIPPET_MAX_CHARS = 3000

# 禁用 MuPDF 错误消息输出到 stdout
fitz.set_messages(path='/dev/null')


def normalize_for_filename(title):
    """与 Node.js 代码保持一致的归一化逻辑"""
    return re.sub(r'[^\w\s]', '', title).strip()


def build_pdf_mapping(papers, pdf_dir):
    """构建论文ID到PDF路径的映射"""
    pdfs = [f for f in os.listdir(pdf_dir) if f.endswith('.pdf')]
    pdf_index = {}
    for f in pdfs:
        norm = normalize_for_filename(f.replace('.pdf', '')).lower()
        pdf_index[norm] = os.path.join(pdf_dir, f)

    mapping = []
    unmatched = []
    for paper in papers:
        title = paper.get('title', '')
        norm = normalize_for_filename(title).lower()
        pdf_path = pdf_index.get(norm)
        if pdf_path:
            mapping.append({
                'arnumber': str(paper['arnumber']),
                'title': title,
                'pdf_path': pdf_path
            })
        else:
            unmatched.append(title)

    return mapping, unmatched


def extract_single(item):
    """提取单篇PDF的文本片段"""
    pid = item['arnumber']
    pdf_path = item['pdf_path']

    try:
        doc = fitz.open(pdf_path)
        text_parts = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text()
            if text and text.strip():
                text_parts.append(text)
        doc.close()

        full_text = "\n\n".join(text_parts)
        snippet = full_text[:SNIPPET_MAX_CHARS] if full_text else ''

        # 检测异常内容
        warning = None
        if snippet:
            copyright_markers = snippet.count('©2026 IEEE') + snippet.count('Authorized licensed use')
            non_empty_lines = [l.strip() for l in snippet.split('\n') if l.strip()]
            if copyright_markers >= 3 and len(non_empty_lines) > 0:
                header_lines = non_empty_lines[:5]
                header_text = ' '.join(header_lines)
                if 'IEEE' in header_text and 'ICASSP' in header_text:
                    warning = f"版权页而非论文正文（标记{copyright_markers}次）"

        return {
            'paper_id': pid,
            'snippet': snippet,
            'warning': warning,
            'status': 'ok'
        }
    except Exception as e:
        return {
            'paper_id': pid,
            'snippet': '',
            'warning': None,
            'status': f'error: {e}'
        }


def save_progress(results, total, done_count):
    """保存中间进度"""
    beijing = timezone(timedelta(hours=8))
    data = {
        'timestamp': datetime.now(beijing).isoformat(),
        'total': total,
        'completed': done_count,
        'papers': results
    }
    with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def save_final_output(results):
    """保存最终结果"""
    beijing = timezone(timedelta(hours=8))
    data = {
        'timestamp': datetime.now(beijing).isoformat(),
        'papers': results
    }
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main():
    print("=== 批量提取PDF文本片段 ===")

    # 1. 读取论文列表
    with open(PAPERS_JSON, 'r', encoding='utf-8') as f:
        papers = json.load(f)
    print(f"论文总数: {len(papers)}")

    # 2. 构建PDF映射
    mapping, unmatched = build_pdf_mapping(papers, PDF_DIR)
    print(f"PDF映射成功: {len(mapping)}/{len(papers)}")
    if unmatched:
        print(f"  未匹配: {len(unmatched)} 篇")
        for t in unmatched[:5]:
            print(f"    - {t}")

    # 3. 尝试加载已有进度
    existing_results = {}
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
                progress = json.load(f)
            for p in progress.get('papers', []):
                existing_results[p['paper_id']] = p
            print(f"加载已有进度: {len(existing_results)} 篇")
        except Exception as e:
            print(f"加载进度失败: {e}")

    # 4. 过滤掉已完成的
    todo = [m for m in mapping if m['arnumber'] not in existing_results]
    print(f"待提取: {len(todo)} 篇")

    if not todo:
        print("所有论文已提取完成！")
        save_final_output(list(existing_results.values()))
        return

    # 5. 并行提取
    num_workers = min(cpu_count(), 8)
    print(f"使用进程数: {num_workers}")

    results = list(existing_results.values())
    batch_size = 50
    completed = len(results)

    with Pool(processes=num_workers) as pool:
        for i in range(0, len(todo), batch_size):
            batch = todo[i:i + batch_size]
            batch_results = pool.map(extract_single, batch)

            for r in batch_results:
                results.append(r)
                completed += 1
                if r['warning']:
                    print(f"  ⚠️ {r['paper_id']} | {r['warning']}")
                elif r['status'] != 'ok':
                    print(f"  ✗ {r['paper_id']} | {r['status']}")

            # 保存进度
            save_progress(results, len(mapping), completed)
            print(f"  进度: {completed}/{len(mapping)} ({completed * 100 // len(mapping)}%)")

    # 6. 保存最终结果
    save_final_output(results)

    # 7. 统计报告
    ok_count = sum(1 for r in results if r['status'] == 'ok')
    warn_count = sum(1 for r in results if r['warning'])
    err_count = sum(1 for r in results if r['status'] != 'ok')
    empty_count = sum(1 for r in results if not r['snippet'])

    print("\n=== 提取完成 ===")
    print(f"成功: {ok_count} | 警告: {warn_count} | 错误: {err_count} | 空文本: {empty_count}")
    print(f"输出文件: {OUTPUT_FILE}")

    # 清理进度文件
    if os.path.exists(PROGRESS_FILE):
        os.remove(PROGRESS_FILE)


if __name__ == '__main__':
    main()

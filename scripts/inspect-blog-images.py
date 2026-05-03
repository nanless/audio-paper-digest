#!/usr/bin/env python3
"""
图文符合度检查输入构造工具

给 subagent 用：输入一篇博客 .md，输出该博文的图片清单 + 每张图所在 section、
紧邻上下文、alt 描述、本地绝对路径，方便 subagent Read 图片并对比文本判断
图文是否对得上。

用法：
    python3 inspect-blog-images.py <md_path>                   # 输出文本格式
    python3 inspect-blog-images.py <md_path> --json            # 输出 JSON
    python3 inspect-blog-images.py <md_path> --context-lines 8 # 调上下文行数

URL 到本地路径的映射约定（与 publish-to-blog.py 一致）：
    本地模式: {BASE_PATH}/images/{cat}/{date}/{f}  → {BLOG_REPO}/static/images/{cat}/{date}/{f}
    GitHub Pages 模式: https://{user}.github.io/{repo}/{cat}/{date}/{f}
        → {IMAGES_REPO}/{cat}/{date}/{f}
"""
import argparse
import json
import os
import re
import sys
from urllib.parse import urlparse

BLOG_REPO = os.path.expanduser(
    os.environ.get('PAPER_DIGEST_BLOG_REPO', '~/code/github_repos/audio-paper-digest-blog')
)
IMAGES_REPO = os.path.expanduser(
    os.environ.get('PAPER_DIGEST_IMAGES_REPO', '~/code/github_repos/audio-paper-digest-images')
)
BASE_PATH = os.environ.get('PAPER_DIGEST_BLOG_BASE_PATH', '/audio-paper-digest-blog')
IMAGE_BASE_URL = os.environ.get('PAPER_DIGEST_IMAGE_BASE_URL', '').rstrip('/')


def url_to_local_path(url: str) -> str:
    """把 .md 里的图片 URL 还原成本地绝对路径，找不到返回空串。"""
    if not url:
        return ''
    if url.startswith('http://') or url.startswith('https://'):
        # GitHub Pages 图床: 形如 https://user.github.io/repo/iclr-2026/2026-05-04/x.png
        if IMAGE_BASE_URL and url.startswith(IMAGE_BASE_URL):
            rel = url[len(IMAGE_BASE_URL):].lstrip('/')
            cand = os.path.join(IMAGES_REPO, rel)
            if os.path.exists(cand):
                return cand
        # 任意 https URL — 尝试根据路径段在 IMAGES_REPO 下找
        path = urlparse(url).path
        m = re.search(r'/((?:icassp|iclr|论文速递)[^/]*)/(\d{4}-\d{2}-\d{2})/([^/]+)$', path)
        if m:
            cat, date, fn = m.groups()
            cand = os.path.join(IMAGES_REPO, cat, date, fn)
            if os.path.exists(cand):
                return cand
        return ''
    # 站内绝对路径：/audio-paper-digest-blog/images/iclr-2026/2026-05-04/x.png
    if url.startswith(BASE_PATH + '/'):
        rel = url[len(BASE_PATH) + 1:]
    elif url.startswith('/'):
        rel = url.lstrip('/')
    else:
        rel = url
    # 站内 /images/ 走 static
    if rel.startswith('images/'):
        cand = os.path.join(BLOG_REPO, 'static', rel)
        if os.path.exists(cand):
            return cand
    # 兜底：直接在 BLOG_REPO/static 下找
    cand = os.path.join(BLOG_REPO, 'static', rel)
    return cand if os.path.exists(cand) else ''


def find_section(lines, idx):
    """从 idx 往前找最近的 ## / ### / # 标题，返回 (level, text)。"""
    for j in range(idx, -1, -1):
        m = re.match(r'^(#{1,6})\s+(.*)', lines[j])
        if m:
            return (len(m.group(1)), m.group(2).strip())
    return (0, '')


def collect_context(lines, idx, before=8, after=8):
    """收集图片行前后非空文本行（跳过其他图片行、表格分隔线）。"""
    def is_skippable(s):
        s = s.strip()
        if not s:
            return True
        if re.match(r'^!\[', s):
            return True  # 跳过其他图片
        if re.match(r'^[-|: ]+$', s) and '|' in s:
            return True  # markdown 表格分隔线
        return False

    out_before = []
    j = idx - 1
    while j >= 0 and len(out_before) < before:
        if not is_skippable(lines[j]):
            out_before.append((j + 1, lines[j].rstrip()))
        j -= 1
    out_before.reverse()

    out_after = []
    j = idx + 1
    while j < len(lines) and len(out_after) < after:
        if not is_skippable(lines[j]):
            out_after.append((j + 1, lines[j].rstrip()))
        j += 1
    return out_before, out_after


def collect_figure_mentions(text):
    """收集全文图号引用 (Figure 1/图1/Fig. 2/Table 1)。"""
    mentions = []
    for m in re.finditer(r'(?:Figure|Fig\.?|图)\s*(\d+)', text, re.I):
        mentions.append(('figure', int(m.group(1))))
    for m in re.finditer(r'(?:Table|表)\s*(\d+)', text, re.I):
        mentions.append(('table', int(m.group(1))))
    return mentions


def inspect(md_path, context_lines=8):
    with open(md_path, 'r') as f:
        content = f.read()
    lines = content.split('\n')

    # 文档元信息
    title_m = re.search(r'^title:\s*"?(.+?)"?\s*$', content, re.M)
    cat_m = re.search(r'^categories:\s*\[(.+?)\]', content, re.M)
    paper_id_m = re.search(r'/(?:icassp|iclr)-2026/\d{4}-\d{2}-\d{2}/([A-Za-z0-9]+)-\d+', content)

    images = []
    img_re = re.compile(r'^(\s*)!\[(.*?)\]\((.+?)\)\s*$')
    for i, line in enumerate(lines):
        m = img_re.match(line)
        if not m:
            continue
        alt = m.group(2)
        url = m.group(3)
        local = url_to_local_path(url)
        sec_lvl, sec_text = find_section(lines, i - 1)
        before, after = collect_context(lines, i, before=context_lines, after=context_lines)
        images.append({
            'line': i + 1,
            'alt': alt,
            'url': url,
            'local_path': local,
            'local_exists': bool(local),
            'section': sec_text,
            'section_level': sec_lvl,
            'context_before': before,
            'context_after': after,
        })

    return {
        'md_path': md_path,
        'title': title_m.group(1).strip() if title_m else '',
        'category': cat_m.group(1).strip() if cat_m else '',
        'paper_id': paper_id_m.group(1) if paper_id_m else '',
        'image_count': len(images),
        'figure_mentions': collect_figure_mentions(content),
        'images': images,
    }


def format_text(report):
    out = []
    out.append(f"# 博文图文清单: {report['title']}")
    out.append(f"路径: {report['md_path']}")
    out.append(f"分类: {report['category']} | paper_id: {report['paper_id']}")
    out.append(f"图片数: {report['image_count']}")
    if report['figure_mentions']:
        out.append("正文引用图号: " + ', '.join(f"{k}{n}" for k, n in report['figure_mentions']))
    out.append('')
    for idx, img in enumerate(report['images'], 1):
        out.append(f"## 图 {idx}/{report['image_count']} (第 {img['line']} 行)")
        out.append(f"- alt: {img['alt']!r}")
        out.append(f"- url: {img['url']}")
        out.append(f"- 本地路径: {img['local_path'] or '<未找到>'}")
        out.append(f"- 本地存在: {img['local_exists']}")
        out.append(f"- 所在 section: {img['section']!r} (level={img['section_level']})")
        out.append("- 前文上下文:")
        for ln, t in img['context_before']:
            out.append(f"    L{ln}: {t}")
        out.append("- 后文上下文:")
        for ln, t in img['context_after']:
            out.append(f"    L{ln}: {t}")
        out.append('')
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('md_path')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--context-lines', type=int, default=8)
    args = ap.parse_args()

    if not os.path.exists(args.md_path):
        print(f"❌ 文件不存在: {args.md_path}", file=sys.stderr)
        sys.exit(1)

    report = inspect(args.md_path, context_lines=args.context_lines)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(format_text(report))


if __name__ == '__main__':
    main()

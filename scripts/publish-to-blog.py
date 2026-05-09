#!/usr/bin/env python3
from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
论文速递 → GitHub Pages 博客

产物结构（平铺）：
  content/posts/
    ├── YYYY-MM-DD.md              # 每日汇总页面
    ├── YYYY-MM-DD-<slug-1>.md     # 论文1独立页面
    ├── YYYY-MM-DD-<slug-2>.md     # 论文2独立页面
    └── ...

用法：
    python3 publish-to-blog.py [data_file]
    python3 publish-to-blog.py --skip-push     # 只生成 .md 不推送到 GitHub
    python3 publish-to-blog.py --date YYYY-MM-DD
"""
import json, re, sys, os, subprocess, datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    extract_all_tags, score_emoji, format_medal, build_paper_meta
)
from utils import strip_md, parse_analysis

BLOG_REPO = os.path.expanduser(
    os.environ.get("PAPER_DIGEST_BLOG_REPO", "~/code/github_repos/audio-paper-digest-blog")
)
CONTENT_DIR = os.path.join(BLOG_REPO, "content", "posts")
BASE_PATH = os.environ.get("PAPER_DIGEST_BLOG_BASE_PATH", "/audio-paper-digest-blog")
GITHUB_REMOTE = os.environ.get("PAPER_DIGEST_GITHUB_REMOTE", "origin")


def slugify(text, max_length=50):
    """将标题转换为 URL 友好的 slug（保留中文、英文、数字）"""
    text = text.lower()
    # 保留中文(\u4e00-\u9fff)、日文假名、韩文、英文、数字、空格和连字符
    text = re.sub(r"[^\u4e00-\u9fff\u3005\u3007\u3021-\u3029\u3038-\u303b\uff10-\uff19\uff21-\uff3a\uff41-\uff5aa-z0-9\s-]", '', text)
    # 将空白和连续连字符替换为单个连字符
    text = re.sub(r'[\s-]+', '-', text)
    text = text.strip('-')
    if len(text) > max_length:
        text = text[:max_length].rsplit('-', 1)[0]
    # 如果过滤后为空（极少数情况），返回 "paper" 作为兜底
    return text if text else 'paper'


def yaml_escape(s):
    """安全转义 YAML 双引号字符串中的特殊字符，同时避免 f-string 解析问题"""
    if not s:
        return ''
    return (s.replace('\\', '\\\\')
             .replace('"', '\\"')
             .replace('\n', ' ')
             .replace('{', '{{')
             .replace('}', '}}'))


def generate_index_page(scored, unscored, date_str, paper_slugs):
    """生成每日汇总页面（index.md），包含概览和每篇论文的链接"""
    total = len(scored) + len(unscored)
    tag_set = extract_all_tags([p for _, p, _ in scored] + unscored, limit=10)
    top_tags = extract_top_tags([p for _, p, _ in scored] + unscored, limit=8)

    md = f"""---
title: "语音/音频论文速递 {date_str}"
date: {date_str}
draft: false
tags: [{', '.join(tag_set)}]
categories: [论文速递]
description: "共分析 {total} 篇语音/AI 论文"
layout: "posts"
---

# 语音/音频论文速递 {date_str}

共分析 **{total}** 篇论文

---

## ⚡ 今日概览

📥 抓取 {total} 篇 → 🔬 深度分析完成

### 🏷️ 热门方向

"""
    md += "| 方向 | 数量 | 分布 |\n|------|------|------|\n"
    for tag, cnt in top_tags:
        bar = '█' * min(cnt, 15)
        md += f"| {tag} | {cnt}篇 | {bar} |\n"

    md += f"""
### 📊 论文评分排行榜（{len(scored)} 篇，按分数降序）

"""
    md += "| 排名 | 论文 | 评分 | 分档 | 主任务 |\n|------|------|------|------|------|\n"
    for i, (score, p, pa) in enumerate(scored):
        m = format_medal(i)
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        rank_bucket = pa.get('rankBucket', '') or '-'
        primary_task = pa.get('primaryTaskTag', '') or '-'
        if slug:
            md += f"| {m} | [{title[:55]}]({BASE_PATH}/posts/{date_str}-{slug}) | {score}分 | {rank_bucket} | {primary_task} |\n"
        else:
            md += f"| {m} | {title[:55]} | {score}分 | {rank_bucket} | {primary_task} |\n"
    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        if slug:
            md += f"| {len(scored)+i+1} | [{title[:55]}]({BASE_PATH}/posts/{date_str}-{slug}) | N/A | - | - |\n"
        else:
            md += f"| {len(scored)+i+1} | {title[:55]} | N/A | - | - |\n"

    md += "\n---\n\n"
    md += "## 📋 论文列表\n\n"

    for i, (score, p, pa) in enumerate(scored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        m = format_medal(i)

        if slug:
            md += f"### {m} [{title}]({BASE_PATH}/posts/{date_str}-{slug})\n\n"
        else:
            md += f"### {m} {title}\n\n"

        pa = parse_analysis(p.get('analysis', '')) or {}
        aid = p.get('arxivId', '')
        aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
        meta = build_paper_meta(pa, aurl)
        if meta:
            md += f"{meta}\n\n"

        if pa.get('authors'):
            authors_clean = pa['authors'].replace('- **第一作者**', '第一作者').replace('- **通讯作者**', '通讯作者').replace('- **作者列表**', '作者列表')
            md += f"👥 **作者与机构**\n\n{authors_clean}\n\n"

        if pa.get('roast'):
            md += f"💡 **毒舌点评**\n\n{pa['roast']}\n\n"

        if pa.get('summary'):
            summary = pa['summary']
            # 如果 summary 中混入了详细分析内容（因标题损坏导致解析边界失效），截断到详细分析之前
            cutoff = re.search(r'\n##\s*详细分', summary)
            if cutoff:
                summary = summary[:cutoff.start()].strip()
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        supplementary = ''
        if pa.get('opensource'):
            oss_text = enrich_opensource(pa, p)
            # 清理内容开头可能残留的 Markdown 标题
            oss_text = re.sub(r'^(?:#{1,6}\s*[^\n]+\n+)+', '', oss_text.strip(), count=1)
            # 分离补充信息
            supp_match = re.search(r'##\s*补充信息\s*\n([\s\S]*)', oss_text)
            if supp_match:
                supplementary = supp_match.group(1).strip()
                oss_text = oss_text[:supp_match.start()].strip()
            md += f"🔗 **开源详情**\n\n{oss_text}\n\n"

        # 补充信息放到最后面
        if supplementary:
            md += f"📎 **补充信息**\n\n{supplementary}\n\n"

        md += "---\n\n"

    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        if slug:
            md += f"### {len(scored)+i+1}. [{title}]({BASE_PATH}/posts/{date_str}-{slug})\n\n"
        else:
            md += f"### {len(scored)+i+1}. {title}\n\n"

    return md


import urllib.request

_REPO_URL_PATTERNS = [
    r'https?://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[^\s<>"{}|\\^`\[\]]+)?',
    r'https?://huggingface\.co/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[^\s<>"{}|\\^`\[\]]+)?',
    r'https?://modelscope\.cn/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[^\s<>"{}|\\^`\[\]]+)?',
]

_IGNORED_GH = {'github.com/arXiv', 'github.com/brucemiller', 'github.com/ggml-org'}


def extract_repo_urls(text):
    """从文本中提取 GitHub / HuggingFace / ModelScope 链接"""
    if not text:
        return []
    urls = set()
    for pat in _REPO_URL_PATTERNS:
        for m in re.finditer(pat, text):
            url = m.group(0).rstrip('.,;:)')
            if any(ig in url for ig in _IGNORED_GH):
                continue
            urls.add(url)
    return sorted(urls)


def fetch_arxiv_html_urls(arxiv_id):
    """从 arxiv HTML 页面抓取开源链接"""
    if not arxiv_id:
        return []
    url = f'https://arxiv.org/html/{arxiv_id}'
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            html = resp.read().decode('utf-8', errors='ignore')
        return extract_repo_urls(html)
    except Exception:
        return []


def enrich_opensource(pa, paper):
    """如果 LLM 生成的 opensource 文本缺少具体链接，从论文原始文本或 arxiv HTML 中补充。"""
    oss = pa.get('opensource', '')
    if not oss:
        return ''

    sources = []
    for key in ('abstract', 'analysis', 'comments'):
        val = paper.get(key, '')
        if val:
            sources.append(val)

    urls = extract_repo_urls('\n'.join(sources))
    # 本地文本找不到时，尝试从 arxiv HTML 抓取
    if not urls:
        urls = fetch_arxiv_html_urls(paper.get('arxivId', ''))
    if not urls:
        return oss

    missing = [u for u in urls if u not in oss]
    if not missing:
        return oss

    oss += '\n\n- 补充链接（自动提取）：'
    for url in missing:
        if 'github.com' in url:
            oss += f'\n  - 代码仓库：{url}'
        elif 'huggingface.co' in url:
            oss += f'\n  - HuggingFace：{url}'
        elif 'modelscope.cn' in url:
            oss += f'\n  - ModelScope：{url}'
        else:
            oss += f'\n  - 相关链接：{url}'
    return oss


def generate_paper_page(paper, date_str):
    """生成单篇论文的独立页面"""
    # 优先使用已解析好的 parsed 数据，避免重新解析时因标题损坏导致字段丢失
    pa = paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {}
    # 补充 opensource 中缺失的具体链接
    if pa and pa.get('opensource'):
        pa['opensource'] = enrich_opensource(pa, paper)
    title = paper.get('title', 'Unknown')
    aid = paper.get('arxivId', '')
    aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
    slug = slugify(title)

    score_str = pa['score'] if pa and pa.get('score') else ''
    task_str = pa['primaryTaskTag'].replace('#', '') if pa and pa.get('primaryTaskTag') else ''
    desc = f"{task_str} | {score_str}/10" if score_str and task_str else title
    md = f"""---
title: "{yaml_escape(title)}"
date: {date_str}
draft: false
tags: [{', '.join([t.replace('#', '') for t in (pa['tags'] if pa else [])])}]
categories: [论文速递]
description: "{yaml_escape(desc)}"
hiddenInHomeList: true
---

# 📄 {title}

"""
    if pa:
        if pa['tags']:
            md += f"{' '.join(pa['tags'])}\n\n"

        meta = build_paper_meta(pa, aurl)
        if meta:
            md += f"{meta}\n\n"

        machine_bits = []
        if pa.get('qualityScore'):
            machine_bits.append(f"学术质量 {pa['qualityScore']}/7")
        if pa.get('valueScore'):
            machine_bits.append(f"选题价值 {pa['valueScore']}/2")
        if pa.get('reproducibilityBonus'):
            machine_bits.append(f"复现加成 {pa['reproducibilityBonus']}")
        if pa.get('confidence'):
            machine_bits.append(f"置信度 {pa['confidence']}")
        if machine_bits:
            md += f"{' | '.join(machine_bits)}\n\n"

        if pa.get('authors'):
            md += f"\n### 👥 作者与机构\n\n{pa['authors']}\n"

        # 分离补充信息（从 opensource 中提取）
        opensource_content = pa.get('opensource', '')
        supplementary = ''
        if opensource_content:
            supp_match = re.search(r'##\s*补充信息\s*\n([\s\S]*)', opensource_content)
            if supp_match:
                supplementary = supp_match.group(1).strip()
                opensource_content = opensource_content[:supp_match.start()].strip()

        sections = [
            ('💡 毒舌点评', 'roast'),
            ('📌 核心摘要', 'summary'),
            ('🔗 开源详情', 'opensource', opensource_content),
            ('🏗️ 方法概述和架构', 'architecture'),
            ('💡 核心创新点', 'innovation'),
            ('📊 实验结果', 'results'),
            ('🔬 细节详述', 'details'),
            ('⚖️ 评分理由', 'scoringReason'),
        ]
        for item in sections:
            if len(item) == 3:
                label, key, content = item
            else:
                label, key = item
                content = pa.get(key, '')
            if content:
                # 如果 summary 中混入了详细分析内容（因标题损坏导致解析边界失效），截断到详细分析之前
                if key == 'summary':
                    cutoff = re.search(r'\n##\s*详细分', content)
                    if cutoff:
                        content = content[:cutoff.start()].strip()
                # 清理内容开头可能残留的 Markdown 标题（如 LLM 输出自带了 ## 开源详情）
                content = re.sub(r'^(?:#{1,6}\s*[^\n]+\n+)+', '', content.strip(), count=1)
                content = re.sub(r'^###\s*\d+\.\s*[^\n]+\n', '', content, flags=re.MULTILINE)
                content = re.sub(r'^\d+\.\s*\*\*([^*]+)\*\*\s*$', r'\1', content, flags=re.MULTILINE)
                md += f'\n### {label}\n\n{content}\n'

        # 补充信息放到最后面
        if supplementary:
            md += f'\n### 📎 补充信息\n\n{supplementary}\n'
    else:
        md += '> ⚠️ 该论文分析失败\n'

    md += f'\n---\n\n[← 返回 {date_str} 论文速递]({BASE_PATH}/posts/{date_str}/)\n'

    return md, slug


def git_push(date_str):
    """Commit and push to GitHub"""
    status = subprocess.run(
        ['git', 'status', '--porcelain'],
        capture_output=True, text=True, cwd=BLOG_REPO
    )
    if not status.stdout.strip():
        print("  ℹ️ 没有新内容需要推送")
        return True

    subprocess.run(['git', 'add', '-A'], check=True, cwd=BLOG_REPO)
    subprocess.run(
        ['git', 'commit', '-m', f'add: 论文速递 {date_str}'],
        check=True, cwd=BLOG_REPO
    )
    result = subprocess.run(
        ['git', 'push', GITHUB_REMOTE, 'main'],
        capture_output=True, text=True, cwd=BLOG_REPO
    )

    if result.returncode == 0:
        print(f"  ✅ 已推送到 GitHub，自动部署中...")
        blog_url = os.environ.get('PAPER_DIGEST_BLOG_URL', '')
        if blog_url:
            print(f"  🌐 {blog_url}/{date_str}/")
        return True
    else:
        print(f"  ❌ Push 失败: {result.stderr}")
        return False


def main():
    data_file = None
    skip_push = False
    target_date = None

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--skip-push':
            skip_push = True
        elif arg == '--date' and i + 1 < len(sys.argv):
            target_date = sys.argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            data_file = arg
        i += 1

    papers = load_papers(data_file)
    scored, unscored = score_and_sort(papers)
    today = get_today_bj(target_date)
    print(f"📅 博客日期: {today}")

    if not papers:
        print("⚠️ 没有论文需要发布")
        return

    os.makedirs(CONTENT_DIR, exist_ok=True)

    paper_slugs = {}
    for paper in papers:
        pa = parse_analysis(paper.get('analysis', ''))
        if pa:
            paper_md, slug = generate_paper_page(paper, today)
            paper_file = os.path.join(CONTENT_DIR, f"{today}-{slug}.md")
            with open(paper_file, 'w') as f:
                f.write(paper_md)
            paper_slugs[paper.get('arxivId', '')] = slug

    print(f"📄 生成 {len(paper_slugs)} 篇论文独立页面")

    index_md = generate_index_page(scored, unscored, today, paper_slugs)
    index_file = os.path.join(CONTENT_DIR, f"{today}.md")
    with open(index_file, 'w') as f:
        f.write(index_md)
    print(f"📄 汇总页面: {index_file} ({len(index_md)} chars)")

    if skip_push:
        print("⏭️ 跳过推送")
        return

    git_push(today)

    print(f"\n🎉 博客发布完成！")


if __name__ == '__main__':
    main()

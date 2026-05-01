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
import base64, json, re, sys, os, subprocess, datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    extract_all_tags, score_emoji, format_medal, build_paper_meta
)
from utils import strip_md, parse_analysis
from image_host import (
    is_configured as image_host_configured,
    upload_image,
    get_cached_url,
    build_remote_key,
)

# 图床环境变量（通用 S3 命名，兼容旧 R2 命名）
IMAGE_HOST = os.environ.get('PAPER_DIGEST_IMAGE_HOST', 'local').lower()
S3_ENDPOINT = os.environ.get('PAPER_DIGEST_S3_ENDPOINT', '') or os.environ.get('PAPER_DIGEST_R2_ENDPOINT', '')
S3_BUCKET = os.environ.get('PAPER_DIGEST_S3_BUCKET', '') or os.environ.get('PAPER_DIGEST_R2_BUCKET', '')
S3_ACCESS_KEY = os.environ.get('PAPER_DIGEST_S3_ACCESS_KEY', '') or os.environ.get('PAPER_DIGEST_R2_ACCESS_KEY', '')
S3_SECRET_KEY = os.environ.get('PAPER_DIGEST_S3_SECRET_KEY', '') or os.environ.get('PAPER_DIGEST_R2_SECRET_KEY', '')
IMAGE_BASE_URL = os.environ.get('PAPER_DIGEST_IMAGE_BASE_URL', '').rstrip('/')

BLOG_REPO = os.path.expanduser(
    os.environ.get("PAPER_DIGEST_BLOG_REPO", "~/code/github_repos/audio-paper-digest-blog")
)
CONTENT_DIR = os.path.join(BLOG_REPO, "content", "posts")
BASE_PATH = os.environ.get("PAPER_DIGEST_BLOG_BASE_PATH", "/audio-paper-digest-blog")
GITHUB_REMOTE = os.environ.get("PAPER_DIGEST_GITHUB_REMOTE", "origin")

IO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'current', 'deep_analyzer_input_output')
ICASSP_IMG_SOURCE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'current', 'icassp-images')


def slugify(text, max_length=50):
    """将标题转换为 URL 友好的 slug（保留中文、英文、数字）"""
    text = text.lower()
    text = re.sub(r"[^\u4e00-\u9fff\u3005\u3007\u3021-\u3029\u3038-\u303b\uff10-\uff19\uff21-\uff3a\uff41-\uff5aa-z0-9\s-]", '', text)
    text = re.sub(r'[\s-]+', '-', text)
    text = text.strip('-')
    if len(text) > max_length:
        text = text[:max_length].rsplit('-', 1)[0]
    return text if text else 'paper'


def get_paper_id(paper):
    """获取论文唯一标识，兼容 arXiv 和 ICASSP"""
    return paper.get('arxivId') or paper.get('arnumber') or paper.get('paper_id', '')


def _copy_icassp_images(paper_id, date_str):
    """从 data/current/icassp-images/{paper_id}/ 复制图片到博客 static 目录或上传到图床"""
    source_dir = os.path.join(ICASSP_IMG_SOURCE_DIR, str(paper_id))
    if not os.path.exists(source_dir):
        return {}

    use_r2 = image_host_configured()
    if not use_r2:
        # 本地模式：复制到博客 static 目录
        img_dir = os.path.join(BLOG_REPO, 'static', 'images', 'icassp-2026', date_str)
        os.makedirs(img_dir, exist_ok=True)

    image_map = {}
    for filename in sorted(os.listdir(source_dir)):
        m = re.match(r'^(\d+)\.(png|jpg|jpeg|gif)$', filename, re.I)
        if not m:
            continue
        idx = int(m.group(1))
        ext = m.group(2).lower()
        if ext == 'jpeg':
            ext = 'jpg'
        source_path = os.path.join(source_dir, filename)
        dest_filename = f'{paper_id}-{idx}.{ext}'

        try:
            if use_r2:
                # 图床模式：上传到 R2
                cached = get_cached_url(source_path)
                if cached:
                    web_path = cached
                else:
                    remote_key = build_remote_key(date_str, dest_filename, prefix='icassp-2026')
                    web_path = upload_image(source_path, remote_key)
            else:
                # 本地模式：复制到博客 static 目录
                dest_path = os.path.join(BLOG_REPO, 'static', 'images', 'icassp-2026', date_str, dest_filename)
                os.makedirs(os.path.dirname(dest_path), exist_ok=True)
                with open(source_path, 'rb') as src, open(dest_path, 'wb') as dst:
                    dst.write(src.read())
                web_path = f'{BASE_PATH}/images/icassp-2026/{date_str}/{dest_filename}'

            image_map[rf'icassp-img://{paper_id}/{idx}\.{ext}'] = web_path
            image_map[rf'pdf-image-page\d+-idx{idx}'] = web_path
        except Exception as e:
            print(f"  ⚠️ 图片处理失败 {filename}: {e}")
            continue
    return image_map


def _extract_from_input(paper_id, date_str):
    """从 analyzer input 文件中提取 base64 图片（旧数据 fallback）"""
    input_file = os.path.join(IO_DIR, f'{paper_id}_input.json')
    if not os.path.exists(input_file):
        return {}

    try:
        with open(input_file, 'r') as f:
            data = json.load(f)
    except Exception:
        return {}

    images = []
    msgs = data.get('messages', [])
    for m in msgs:
        if m.get('role') == 'user':
            content = m.get('content', [])
            for c in content:
                if c.get('type') == 'image_url':
                    url = c.get('image_url', {}).get('url', '')
                    if url.startswith('data:'):
                        parts = url.split(',', 1)
                        if len(parts) == 2:
                            header = parts[0]
                            mime = header.split(';')[0].replace('data:', '')
                            images.append((len(images), parts[1], mime))

    if not images:
        return {}

    use_r2 = image_host_configured()
    if not use_r2:
        img_dir = os.path.join(BLOG_REPO, 'static', 'images', 'icassp-2026', date_str)
        os.makedirs(img_dir, exist_ok=True)

    image_map = {}
    for idx, b64_data, mime in images:
        ext = 'jpg' if 'jpeg' in mime else ('png' if 'png' in mime else 'jpg')
        filename = f'{paper_id}-{idx}.{ext}'
        try:
            img_bytes = base64.b64decode(b64_data)

            if use_r2:
                # 图床模式：先写入临时文件再上传
                import tempfile
                with tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False) as tmp:
                    tmp.write(img_bytes)
                    tmp_path = tmp.name
                try:
                    remote_key = build_remote_key(date_str, filename, prefix='icassp-2026')
                    web_path = upload_image(tmp_path, remote_key)
                finally:
                    os.unlink(tmp_path)
            else:
                # 本地模式
                filepath = os.path.join(BLOG_REPO, 'static', 'images', 'icassp-2026', date_str, filename)
                os.makedirs(os.path.dirname(filepath), exist_ok=True)
                with open(filepath, 'wb') as f:
                    f.write(img_bytes)
                web_path = f'{BASE_PATH}/images/icassp-2026/{date_str}/{filename}'

            image_map[rf'pdf-image-page\d+-idx{idx}'] = web_path
        except Exception as e:
            print(f"  ⚠️ base64 图片处理失败 {filename}: {e}")
            continue
    return image_map


def extract_and_replace_images(md, paper_id, date_str):
    """保存 ICASSP 图片到博客 static 目录，替换 markdown 中的内部标识符"""
    image_map = _copy_icassp_images(paper_id, date_str)
    if not image_map:
        image_map = _extract_from_input(paper_id, date_str)

    if not image_map:
        return md

    def _replacer(match):
        url = match.group(2)
        for pattern, web_path in image_map.items():
            if re.fullmatch(pattern, url):
                return match.group(1) + web_path + match.group(3)
        desc = match.group(1)[2:-1]
        return desc

    md = re.sub(r'(!\[.*?\]\()(.*?)(\))', _replacer, md)
    return md


def sanitize_external_images(md):
    """将不可用的外部图片引用降级为纯文本描述"""
    blocked_domains = [
        'ieeexplore.ieee.org',   # 403 防盗链
        'images.unsplash.com',    # LLM 编造的假链接
    ]

    def _replacer(match):
        desc = match.group(1)
        url = match.group(2)
        for domain in blocked_domains:
            if domain in url:
                return desc
        return match.group(0)

    return re.sub(r'!\[(.*?)\]\((.*?)\)', _replacer, md)


def yaml_escape(s):
    """安全转义 YAML 双引号字符串中的特殊字符，同时避免 f-string 解析问题"""
    if not s:
        return ''
    return (s.replace('\\', '\\\\')
             .replace('"', '\\"')
             .replace('\n', ' ')
             .replace('{', '{{')
             .replace('}', '}}'))


def generate_index_page(scored, unscored, date_str, paper_slugs, category="论文速递", task_urls=None):
    """生成每日汇总页面（index.md），包含概览和每篇论文的链接"""
    total = len(scored) + len(unscored)
    tag_set = extract_all_tags([p for _, p, _ in scored] + unscored, limit=10)
    top_tags = extract_top_tags([p for _, p, _ in scored] + unscored, limit=8)

    if category == "icassp-2026":
        page_title = f"ICASSP 2026 语音/音频论文详细分析"
        page_desc = f"共分析 {total} 篇 ICASSP 2026 论文"
        overview = f"📥 {total} 篇 → 🔬 深度分析完成"
    else:
        page_title = f"语音/音频论文速递 {date_str}"
        page_desc = f"共分析 {total} 篇语音/AI 论文"
        overview = f"📥 抓取 {total} 篇 → 🔬 深度分析完成"

    # 按主任务标签分类统计
    task_tag_counts = {}
    for p in [p for _, p, _ in scored] + unscored:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        task = pa.get('primaryTaskTag', '')
        if task:
            task = task.strip().lstrip('#')
            task_tag_counts[task] = task_tag_counts.get(task, 0) + 1
    sorted_tasks = sorted(task_tag_counts.items(), key=lambda x: -x[1])

    md = f"""---
title: "{page_title}"
date: {date_str}
draft: false
tags: [{', '.join(tag_set)}]
categories: [{category}]
description: "{page_desc}"
layout: "posts"
---

# {page_title}

{page_desc}

---

## 🎯 任务分类

点击任务标签查看该方向所有论文：

"""
    for task, cnt in sorted_tasks:
        task_url = task_urls.get(task, f"{BASE_PATH}/posts/icassp2026-summary/") if task_urls else f"{BASE_PATH}/posts/icassp2026-summary/"
        md += f"- [{task}]({task_url})（{cnt}篇）\n"

    md += f"""
---

## ⚡ 今日概览

{overview}

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
        slug = paper_slugs.get(get_paper_id(p), '')
        rank_bucket = pa.get('rankBucket', '') or '-'
        primary_task = pa.get('primaryTaskTag', '') or '-'
        if slug:
            md += f"| {m} | [{title[:55]}]({BASE_PATH}/posts/{date_str}-{slug}) | {score}分 | {rank_bucket} | {primary_task} |\n"
        else:
            md += f"| {m} | {title[:55]} | {score}分 | {rank_bucket} | {primary_task} |\n"
    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(get_paper_id(p), '')
        if slug:
            md += f"| {len(scored)+i+1} | [{title[:55]}]({BASE_PATH}/posts/{date_str}-{slug}) | N/A | - | - |\n"
        else:
            md += f"| {len(scored)+i+1} | {title[:55]} | N/A | - | - |\n"

    md += "\n---\n\n"
    md += "## 📋 论文列表\n\n"

    for i, (score, p, pa) in enumerate(scored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(get_paper_id(p), '')
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

        if pa.get('opensource'):
            md += f"🔗 **开源详情**\n\n{pa['opensource']}\n\n"

        if pa.get('summary'):
            summary = pa['summary']
            # 如果 summary 中混入了详细分析内容（因标题损坏导致解析边界失效），截断到详细分析之前
            cutoff = re.search(r'\n##\s*详细分', summary)
            if cutoff:
                summary = summary[:cutoff.start()].strip()
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        md += "---\n\n"

    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(get_paper_id(p), '')
        if slug:
            md += f"### {len(scored)+i+1}. [{title}]({BASE_PATH}/posts/{date_str}-{slug})\n\n"
        else:
            md += f"### {len(scored)+i+1}. {title}\n\n"

    return md


def generate_task_index_page(task, papers_in_task, date_str, paper_slugs, category="icassp-2026", task_index=0):
    """生成某任务标签下的 ICASSP 论文汇总页面"""
    task_slug = slugify(task, max_length=80)
    # 文件名使用纯 ASCII，避免 Hugo 构建时中文文件名问题
    safe_filename = f"icassp2026-task-{task_index:03d}"
    total = len(papers_in_task)
    # 按分数排序
    scored_in_task = []
    unscored_in_task = []
    for p in papers_in_task:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        score = 0
        if pa.get('score'):
            try:
                score = float(str(pa['score']).replace('分', '').strip())
            except ValueError:
                score = 0
        if score > 0:
            scored_in_task.append((score, p, pa))
        else:
            unscored_in_task.append(p)
    scored_in_task.sort(key=lambda x: -x[0])

    md = f"""---
title: "ICASSP 2026 - {task} 论文列表"
date: {date_str}
draft: false
tags: ["{task}"]
categories: [{category}]
description: "共 {total} 篇 ICASSP 2026 {task} 方向论文"
hiddenInHomeList: true
---

# ICASSP 2026 - {task}

共 **{total}** 篇论文

[← 返回 ICASSP 2026 总览]({BASE_PATH}/posts/icassp2026-summary/)

---

| 排名 | 论文 | 评分 | 分档 |
|------|------|------|------|
"""
    for i, (score, p, pa) in enumerate(scored_in_task):
        m = format_medal(i)
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(get_paper_id(p), '')
        rank_bucket = pa.get('rankBucket', '') or '-'
        if slug:
            md += f"| {m} | [{title[:60]}]({BASE_PATH}/posts/{date_str}-{slug}) | {score}分 | {rank_bucket} |\n"
        else:
            md += f"| {m} | {title[:60]} | {score}分 | {rank_bucket} |\n"
    for i, p in enumerate(unscored_in_task):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(get_paper_id(p), '')
        if slug:
            md += f"| {len(scored_in_task)+i+1} | [{title[:60]}]({BASE_PATH}/posts/{date_str}-{slug}) | N/A | - |\n"
        else:
            md += f"| {len(scored_in_task)+i+1} | {title[:60]} | N/A | - |\n"

    md += "\n---\n\n"
    md += "## 📋 论文详情\n\n"

    all_papers = scored_in_task + [(0, p, parse_analysis(p.get('analysis', '')) or {}) for p in unscored_in_task]
    for i, (score, p, pa) in enumerate(all_papers):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(get_paper_id(p), '')
        m = format_medal(i) if score > 0 else f"{i+1}."

        if slug:
            md += f"### {m} [{title}]({BASE_PATH}/posts/{date_str}-{slug})\n\n"
        else:
            md += f"### {m} {title}\n\n"

        if pa:
            meta = build_paper_meta(pa, '')
            if meta:
                md += f"{meta}\n\n"

            if pa.get('authors'):
                authors_clean = pa['authors'].replace('- **第一作者**', '第一作者').replace('- **通讯作者**', '通讯作者').replace('- **作者列表**', '作者列表')
                md += f"👥 **作者与机构**\n\n{authors_clean}\n\n"

            if pa.get('roast'):
                md += f"💡 **毒舌点评**\n\n{pa['roast']}\n\n"

            if pa.get('opensource'):
                md += f"🔗 **开源详情**\n\n{pa['opensource']}\n\n"

            if pa.get('summary'):
                summary = pa['summary']
                cutoff = re.search(r'\n##\s*详细分', summary)
                if cutoff:
                    summary = summary[:cutoff.start()].strip()
                md += f"📌 **核心摘要**\n\n{summary}\n\n"
        else:
            md += "> ⚠️ 该论文分析失败\n\n"

        md += "---\n\n"

    return md, safe_filename, task_slug


def generate_paper_page(paper, date_str, category="论文速递", summary_slug=None):
    """生成单篇论文的独立页面"""
    # 优先使用已解析好的 parsed 数据，避免重新解析时因标题损坏导致字段丢失
    pa = paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {}
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
categories: [{category}]
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

        sections = [
            ('💡 毒舌点评', 'roast'),
            ('🔗 开源详情', 'opensource'),
            ('📌 核心摘要', 'summary'),
            ('🏗️ 模型架构', 'architecture'),
            ('💡 核心创新点', 'innovation'),
            ('🔬 细节详述', 'details'),
            ('📊 实验结果', 'results'),
            ('⚖️ 评分理由', 'scoringReason'),
        ]
        for label, key in sections:
            content = pa.get(key, '')
            if content:
                # 如果 summary 中混入了详细分析内容（因标题损坏导致解析边界失效），截断到详细分析之前
                if key == 'summary':
                    cutoff = re.search(r'\n##\s*详细分', content)
                    if cutoff:
                        content = content[:cutoff.start()].strip()
                content = re.sub(r'^###\s*\d+\.\s*[^\n]+\n', '', content, flags=re.MULTILINE)
                content = re.sub(r'^\d+\.\s*\*\*([^*]+)\*\*\s*$', r'\1', content, flags=re.MULTILINE)
                md += f'\n### {label}\n\n{content}\n'
    else:
        md += '> ⚠️ 该论文分析失败\n'

    if summary_slug:
        md += f'\n---\n\n[← 返回 ICASSP 2026 论文分析]({BASE_PATH}/posts/{summary_slug}/)\n'
    else:
        md += f'\n---\n\n[← 返回 {date_str} 论文速递]({BASE_PATH}/posts/{date_str}/)\n'

    # 提取并替换内部图片标识符为实际路径
    md = extract_and_replace_images(md, get_paper_id(paper), date_str)
    # 降级不可用的外部图片引用（IEEE 防盗链、假链接等）
    md = sanitize_external_images(md)

    return md, slug


def git_push(date_str, category="论文速递", summary_slug=None):
    """Commit and push to GitHub"""
    status = subprocess.run(
        ['git', 'status', '--porcelain'],
        capture_output=True, text=True, cwd=BLOG_REPO
    )
    if not status.stdout.strip():
        print("  ℹ️ 没有新内容需要推送")
        return True

    subprocess.run(['git', 'add', '-A'], check=True, cwd=BLOG_REPO)
    label = "ICASSP 2026" if category == "icassp-2026" else "论文速递"
    subprocess.run(
        ['git', 'commit', '-m', f'add: {label} {date_str}'],
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
            slug = summary_slug or date_str
            print(f"  🌐 {blog_url}/posts/{slug}/")
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

    # 根据数据文件路径判断分类
    category = "icassp-2026" if data_file and "icassp" in data_file.lower() else "论文速递"
    print(f"🏷️ 分类: {category}")

    # ICASSP 汇总页面使用固定 slug，不再用日期作为文件名
    summary_slug = "icassp2026-summary" if category == "icassp-2026" else today

    os.makedirs(CONTENT_DIR, exist_ok=True)

    paper_slugs = {}
    for paper in papers:
        pa = parse_analysis(paper.get('analysis', ''))
        if pa:
            paper_md, slug = generate_paper_page(paper, today, category, summary_slug)
            paper_file = os.path.join(CONTENT_DIR, f"{today}-{slug}.md")
            with open(paper_file, 'w') as f:
                f.write(paper_md)
            paper_slugs[get_paper_id(paper)] = slug

    print(f"📄 生成 {len(paper_slugs)} 篇论文独立页面")

    # 为 ICASSP 预先构建任务分组和 URL 映射（汇总页面链接需要用到）
    task_urls = None
    task_groups = {}
    if category == "icassp-2026":
        for p in papers:
            pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
            task = pa.get('primaryTaskTag', '')
            if task:
                task = task.strip().lstrip('#')
                task_groups.setdefault(task, []).append(p)
        task_urls = {}
        for task_index, (task, _) in enumerate(sorted(task_groups.items())):
            task_urls[task] = f"{BASE_PATH}/posts/icassp2026-task-{task_index:03d}/"

    index_md = generate_index_page(scored, unscored, today, paper_slugs, category, task_urls)
    index_file = os.path.join(CONTENT_DIR, f"{summary_slug}.md")
    with open(index_file, 'w') as f:
        f.write(index_md)
    print(f"📄 汇总页面: {index_file} ({len(index_md)} chars)")

    # 为 ICASSP 每个任务标签生成独立汇总页面
    if category == "icassp-2026":
        # 清理旧的中文文件名任务页面
        for old_file in os.listdir(CONTENT_DIR):
            if old_file.startswith('icassp2026-') and old_file.endswith('.md') and 'task-' not in old_file and old_file != 'icassp2026-summary.md':
                os.remove(os.path.join(CONTENT_DIR, old_file))

        task_page_count = 0
        for task_index, (task, task_papers) in enumerate(sorted(task_groups.items())):
            task_md, safe_filename, task_slug = generate_task_index_page(
                task, task_papers, today, paper_slugs, category, task_index
            )
            task_file = os.path.join(CONTENT_DIR, f"{safe_filename}.md")
            with open(task_file, 'w') as f:
                f.write(task_md)
            task_page_count += 1
        print(f"📄 生成 {task_page_count} 个任务标签汇总页面")

    if skip_push:
        print("⏭️ 跳过推送")
        return

    git_push(today, category, summary_slug)

    print(f"\n🎉 博客发布完成！")


if __name__ == '__main__':
    main()

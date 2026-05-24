#!/usr/bin/env python3
from dotenv import load_dotenv
load_dotenv()

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
import json, re, sys, os, subprocess, datetime, base64, time, concurrent.futures
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


def fix_latex_delimiters(text):
    r"""将 $...$ 转换为 \(...\)，$$...$$ 转换为 \[...\]，
    配合 Hugo goldmark passthrough 确保 MathJax 正确渲染。"""
    if not text:
        return text
    # 先处理块级公式 $$...$$
    text = re.sub(r'(?<!\\)\$\$(.+?)\$\$', r'\\[\1\\]', text, flags=re.DOTALL)
    # 再处理行内公式 $...$（排除已转换的块级公式和货币符号）
    # 增强：处理反引号包裹的 $...$（代码块内不处理，但反引号包裹的行内代码中的 $...$ 需要处理）
    text = re.sub(r'(?<!\\)\$([^\s\$][^$]*?)\$', r'\\(\1\\)', text)
    # 处理遗漏的反引号包裹的 $...$（如 `v_i^{(1)} = ... + w_vid * ...` 中的 $ 符号）
    text = re.sub(r'`([^`]*?)\$([^`]*?)\$([^`]*?)`', r'`\1\\(\2\\)\3`', text)
    return text


def escape_html_like_tags(text):
    r"""转义论文中可能被 Hugo 解析为 HTML 的标记（如 <S>、<E>、<task> 等），
    避免被渲染为删除线等意外样式。"""
    if not text:
        return text
    # 1. 匹配独立的 <S>、</S>、<E>、</E> 标签（单字母标记）
    # 放宽限制：中文标点、空格、行首后的 <S>/<E> 也需要转义
    text = re.sub(r'(?<![a-zA-Z])<(/?)([SEse])>(?![a-zA-Z0-9])', r'`<\1\2>`', text)
    # 2. 匹配常见的论文文本标记，如 <task>、<perception>、<comprehension>、<reasoning> 等
    # 新增：多模态论文中常见的标记
    text = re.sub(
        r'(?<![a-zA-Z0-9`])<(/?)(task|perception|comprehension|reasoning|agent|action|state|observation|reward|goal|intent|belief|plan|policy|environment|module|component|feature|input|output|label|class|category|type|mode|phase|stage|step|layer|block|unit|node|edge|graph|tree|path|loop|branch|condition|constraint|rule|fact|evidence|proof|hypothesis|assumption|premise|conclusion|result|finding|insight|implication|contribution|limitation|direction|extension|variant|version|update|fix|issue|error|warning|notice|info|trace|log|record|entry|item|element|object|subject|target|source|reference|cite|quote|note|comment|remark|annotation|caption|title|heading|paragraph|sentence|phrase|word|token|char|symbol|sign|mark|tag|badge|identifier|id|key|code|pin|secret|ticket|voucher|license|permit|certificate|credential|award|medal|prize|gift|bonus|benefit|advantage|edge|lead|margin|gap|difference|distance|range|scope|span|scale|size|length|width|height|depth|volume|area|surface|space|place|spot|location|site|position|point|dot|pixel|fragment|shard|piece|part|portion|section|segment|slice|chunk|block|lump|mass|body|entity|thing|article|product|goods|material|substance|matter|fabric|cloth|garment|clothing|wear|dress|costume|uniform|outfit|suit|wardrobe|closet|cabinet|cupboard|pantry|cellar|basement|attic|loft|tower|spire|dome|vault|arch|beam|column|pillar|post|pole|rod|bar|rail|track|path|way|road|route|course|direction|heading|bearing|azimuth|elevation|altitude|latitude|longitude|coordinate|interrupt|backchannel|response|free|BEsound)(?![a-zA-Z0-9`])>',
        r'`<\1\2>`',
        text,
        flags=re.IGNORECASE
    )
    return text


def fix_image_markdown(text):
    r"""将 LLM 输出的非标准图片引用格式转换为标准 Markdown 图片语法。
    处理以下变体：
    - 外部 URL: https://... (alt=描述)
    - 外部 URL: https://... alt=描述
    - - 外部 URL: https://... (alt=描述)
    """
    if not text:
        return text
    # 匹配 "外部 URL: <url> (alt=<alt>)" 及其变体
    text = re.sub(
        r'(?:^|\n)\s*(?:-\s*)?外部\s*URL:\s*(https?://\S+?)\s*\(alt=([^)]+)\)',
        r'\n![\2](\1)',
        text,
        flags=re.MULTILINE
    )
    # 匹配 "外部 URL: <url> alt=<alt>"（无括号）
    text = re.sub(
        r'(?:^|\n)\s*(?:-\s*)?外部\s*URL:\s*(https?://\S+?)\s+alt=(.+?)(?=\n|$)',
        r'\n![\2](\1)',
        text,
        flags=re.MULTILINE
    )
    # 处理被截断的 URL（末尾带 ...）
    text = re.sub(r'\(https?://[^)]+\.\.\.\)', '(image_url_truncated)', text)
    # 处理空的 data URI
    text = re.sub(r'!\[([^\]]*)\]\(data:;base64,\)', r'![\1](image_not_available)', text)
    return text


def truncate_base64_datauri(text, max_chars=50000):
    r"""截断过长的 base64 data URI，避免影响页面加载性能。"""
    if not text:
        return text
    def replacer(m):
        data = m.group(1)
        if len(data) > max_chars:
            return f'{m.group(0)[:100]}...[truncated {len(data)} chars]...'
        return m.group(0)
    text = re.sub(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', replacer, text)
    return text


def fix_yaml_double_commas(text):
    r"""修复 YAML frontmatter 中的双逗号问题。"""
    if not text:
        return text
    # 只处理 frontmatter 区域
    parts = text.split('---\n', 2)
    if len(parts) >= 3:
        frontmatter = parts[1]
        # 修复双逗号
        frontmatter = re.sub(r',\s*,+', ',', frontmatter)
        # 修复 tags 行尾的逗号
        frontmatter = re.sub(r'tags:\s*\[([^\]]*?),\s*\]', r'tags: [\1]', frontmatter)
        text = parts[0] + '---\n' + frontmatter + '---\n' + parts[2]
    return text


def call_llm_api(prompt, max_tokens=800, temperature=0.1):
    """调用 LLM API（MiMo Token Plan / Anthropic 协议）进行通用请求。"""
    api_key = os.environ.get('PAPER_ANALYZER_API_KEY', '')
    endpoint = os.environ.get('PAPER_ANALYZER_ENDPOINT', 'https://token-plan-sgp.xiaomimimo.com/v1')
    model = os.environ.get('PAPER_ANALYZER_MODEL', 'mimo-v2.5')

    if not api_key:
        print("  ⚠️  未配置 PAPER_ANALYZER_API_KEY，跳过 LLM review")
        return None

    base = endpoint.rstrip('/')
    if base.endswith('/v1'):
        base = base[:-3]
    api_url = f"{base}/anthropic/v1/messages"

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [{"role": "user", "content": prompt}]
    }

    for attempt in range(3):
        try:
            import requests
            session = requests.Session()
            session.trust_env = False
            resp = session.post(
                api_url,
                json=payload,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "User-Agent": "claude-cli/2.1.108 (external, cli)",
                    "Content-Type": "application/json"
                },
                timeout=120
            )
            resp.raise_for_status()
            data = resp.json()
            content = ""
            if data.get("content") and isinstance(data["content"], list):
                for block in data["content"]:
                    if block.get("type") == "text":
                        content = block.get("text", "").strip()
                        break
            if content:
                return content
            if attempt < 2:
                time.sleep(2)
        except Exception as e:
            print(f"  ⚠️  LLM API 调用失败 (尝试 {attempt+1}/3): {e}")
            if attempt < 2:
                time.sleep(2)

    return None


def llm_review_post(content, title=""):
    """使用 LLM 审查单篇博客内容，返回 (是否通过, 问题列表, 修复后内容)。"""
    # 截取前 4000 字节省 token，通常问题出现在前面
    truncated = content[:4000] if len(content) > 4000 else content
    prompt = f"""你是一个 Hugo 静态站点博客内容质量审查专家。

请严格审查下面这篇博客的 Markdown 内容，重点检查以下问题：

1. **HTML 标签解析问题**：是否有类似 `<S>`、`<E>`、`<s>`、`<e>` 等文本标记**未被反引号包裹**而被 Hugo 错误解析为 HTML 标签（会导致删除线、粗体等意外样式）。注意：已经被反引号包裹的如 `` `<S>` `` 是正确格式，不要报告。**如果博客中所有 `<S>`/`<E>` 都已用反引号包裹，则此项检查应视为通过，不要报告**。
2. **LaTeX 公式渲染问题**：检查是否存在使用了 `$...$` 或 `$$...$$` 格式的公式。注意：纯文本形式的数学描述（如 "RMS = sqrt(1/N)"）不是 LaTeX 公式，不需要报告；只有明确使用了 `$` 或 `$$` 包裹但未转换为 `\\(...\\)` / `\\[...\\]` 的才需要报告。
3. **Markdown 格式问题**：链接、图片引用、表格、列表等格式是否有语法错误
4. **内容完整性**：是否有乱码、重复、段落错位。注意：以下内容被截断到前4000字符以节省token，**不要因为截断而报告内容不完整**。
5. **图片问题**：图片链接是否为空、格式是否正确（支持 base64 data URI 和普通 URL）
6. **YAML frontmatter 问题**：标题、描述等字段是否有引号不匹配、特殊字符未转义

【重要区分】以下情况**不要**作为错误报告：
- 已经用反引号包裹的 HTML-like 标记（如 `` `<S>` ``）→ 这是正确格式
- 纯文本中的数学符号或公式描述（未使用 `$` 包裹）→ 这不是 LaTeX 格式问题
- 仅属于风格建议的问题（如 alt 文本可以更详细、列表格式可以更统一）→ 这些应评为 info 级别或干脆不报告
- 技术术语未用反引号包裹 → 这不是格式错误，除非它会被 Hugo 解析为 HTML

博客标题：{title}

博客内容（前4000字符）：
```markdown
{truncated}
```

请以 **纯 JSON** 格式返回审查结果，不要添加任何解释文字：
{{
  "passed": true/false,
  "issues": [
    {{
      "severity": "error/warning/info",
      "type": "html_tag/latex/markdown/content/image/yaml",
      "description": "具体问题描述",
      "auto_fixable": true/false,
      "fix_instruction": "修复指令（如: 将 $<S>$ 改为 `\\`<S>\\``）"
    }}
  ]
}}"""

    result = call_llm_api(prompt, max_tokens=1500, temperature=0.1)
    if not result:
        return True, [], content  # LLM 不可用则默认通过

    # 尝试解析 JSON
    try:
        # 清理可能的 markdown 代码块
        cleaned = result
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        review = json.loads(cleaned)
        passed = review.get("passed", True)
        issues = review.get("issues", [])
        # 自动应用可修复的问题
        fixed_content = apply_llm_fixes(content, issues)
        return passed, issues, fixed_content
    except json.JSONDecodeError:
        # 如果 JSON 解析失败，尝试从文本中提取问题
        print(f"  ⚠️  LLM review 返回非 JSON 格式，尝试文本解析")
        issues = []
        if "问题" in result or "错误" in result or "建议" in result:
            issues.append({
                "severity": "warning",
                "type": "unknown",
                "description": "LLM 发现潜在问题（非结构化输出）",
                "auto_fixable": False,
                "fix_instruction": "请手动检查"
            })
            return False, issues, content
        return True, [], content


def multimodal_review_images(content, title=""):
    """使用多模态 LLM 审查博客中的图片。返回 (是否通过, 图片问题列表)。
    当前实现：提取图片信息，用文本方式让 LLM 判断图片引用是否合理。
    如果图片是 base64 data URI，可提取后传给支持多模态的模型。"""
    # 提取所有图片引用
    img_pattern = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')
    images = img_pattern.findall(content)

    if not images:
        return True, []

    img_summary = []
    data_uri_images = []
    for alt, url in images:
        if url.startswith("data:image/svg+xml;base64,"):
            img_summary.append(f"- SVG base64 data URI (alt={alt}), 长度 {len(url)} 字符")
            data_uri_images.append((alt, url))
        elif url.startswith("data:"):
            img_summary.append(f"- 其他 base64 data URI (alt={alt}), 长度 {len(url)} 字符")
            data_uri_images.append((alt, url))
        elif url.startswith("http"):
            # 不截断 URL，避免 review LLM 误判为 URL 不完整
            img_summary.append(f"- 外部图片: {url} | alt: `{alt}`")
        else:
            img_summary.append(f"- 相对路径: {url} (alt={alt})")

    prompt = f"""你是一个博客图片质量审查专家。

请审查下面这篇博客中的图片引用是否合理。

【重要】以下列表是从博客正文中提取的元数据摘要，用于辅助审查：
- 博客正文中的实际图片格式为标准 Markdown：`![alt](url)`
- 摘要中的格式（如"外部图片: url | alt: ..."）只是元数据展示，**不要**因为摘要格式而误判
- 摘要中的 URL 可能为了简洁而截断，但博客正文中的 URL 是完整的
- 如果博客正文中所有图片都使用 `![alt](url)` 格式，则格式检查项应视为通过

博客标题：{title}
图片元数据摘要：
{chr(10).join(img_summary)}

请检查：
1. 博客正文中图片引用格式是否为标准 Markdown `![alt](url)`（基于上述元数据推断）
2. base64 data URI 是否过长（超过 50KB 可能影响页面加载）
3. 外部 URL 是否是常见图片域名（arxiv.org、githubusercontent.com 等）
4. 图片 alt 文本是否为空或重复
5. SVG data URI 是否能被 Hugo 正确渲染

【禁止事项】不要报告以下伪问题：
- 摘要格式（如"外部图片: url | alt: ..."）不是 Markdown 格式 → 这是正常的元数据摘要
- 摘要中 URL 被截断 → 博客正文中的 URL 是完整的
- 图片 alt 文本仅为"图1""图2"等编号 → 这在学术博客中是可以接受的

请以 JSON 格式返回：
{{
  "passed": true/false,
  "issues": [
    {{
      "severity": "error/warning/info",
      "description": "问题描述"
    }}
  ]
}}"""

    result = call_llm_api(prompt, max_tokens=800, temperature=0.1)
    if not result:
        return True, []

    try:
        cleaned = result
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        review = json.loads(cleaned)
        passed = review.get("passed", True)
        issues = review.get("issues", [])
        return passed, issues
    except json.JSONDecodeError:
        return True, []


def apply_llm_fixes(content, issues):
    """根据 LLM 审查结果，自动应用可修复的问题。"""
    if not issues:
        return content

    fixed = content
    fix_count = 0
    for issue in issues:
        if not issue.get("auto_fixable", False):
            continue
        instruction = issue.get("fix_instruction", "")
        if not instruction:
            continue

        # 解析简单替换指令："将 A 改为 B" 或 "replace A with B"
        replace_patterns = [
            r'将\s*[\"\']?(.+?)[\"\']?\s*改为\s*[\"\']?(.+?)[\"\']?\s*$',
            r'replace\s*[\"\']?(.+?)[\"\']?\s*with\s*[\"\']?(.+?)[\"\']?\s*$',
            r'把\s*[\"\']?(.+?)[\"\']?\s*替换成\s*[\"\']?(.+?)[\"\']?\s*$',
        ]
        for pattern in replace_patterns:
            match = re.match(pattern, instruction, re.IGNORECASE)
            if match:
                old, new = match.group(1), match.group(2)
                if old in fixed:
                    fixed = fixed.replace(old, new)
                    fix_count += 1
                    break

    return fixed


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
title: "语音/音乐/音频论文速递 {date_str}"
date: {date_str}
draft: false
tags: [{', '.join(tag_set)}]
categories: [论文速递]
description: "共分析 {total} 篇语音/AI 论文"
layout: "posts"
---

# 语音/音乐/音频论文速递 {date_str}

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

        # unscored 论文也显示完整内容（作者、点评、摘要、开源详情）
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
            cutoff = re.search(r'\n##\s*详细分', summary)
            if cutoff:
                summary = summary[:cutoff.start()].strip()
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        supplementary = ''
        if pa.get('opensource'):
            oss_text = enrich_opensource(pa, p)
            oss_text = re.sub(r'^(?:#{1,6}\s*[^\n]+\n+)+', '', oss_text.strip(), count=1)
            supp_match = re.search(r'##\s*补充信息\s*\n([\s\S]*)', oss_text)
            if supp_match:
                supplementary = supp_match.group(1).strip()
                oss_text = oss_text[:supp_match.start()].strip()
            md += f"🔗 **开源详情**\n\n{oss_text}\n\n"

        if supplementary:
            md += f"📎 **补充信息**\n\n{supplementary}\n\n"

        md += "---\n\n"

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
            machine_bits.append(f"影响力 {pa['valueScore']}/2")
        if pa.get('reproducibilityBonus'):
            machine_bits.append(f"可复现性 {pa['reproducibilityBonus']}/2")
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
            ('🚨 局限与问题', 'limitations'),
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

    # 自动嵌入论文图片（当 analysis 中尚未引用时）
    image_urls = paper.get('imageUrls', []) or paper.get('allImageUrls', [])
    if image_urls and '![' not in md:
        md += '\n### 📷 论文图片\n\n'
        for i, img_url in enumerate(image_urls[:5], 1):
            md += f'![图{i}]({img_url})\n\n'

    md += f'\n---\n\n[← 返回 {date_str} 语音/音乐/音频论文速递]({BASE_PATH}/posts/{date_str}/)\n'

    return md, slug


def review_and_fix_post(file_path):
    """Review 生成的博客文件，自动修复常见问题，返回 (是否修复, 问题列表)"""
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    issues = []

    # 1. 检查未转义的 HTML-like 标签（可能导致删除线等样式问题）
    # 匹配不在反引号、不在 code block 中的 <S>、<E>、<task>、<perception> 等标签
    html_tag_pattern = re.compile(
        r'(?<![a-zA-Z0-9`])<(/?)([SE]|task|perception|comprehension|reasoning|agent|action|state|observation|reward|goal|intent|belief|plan|policy|environment|module|component|feature|input|output|label|class|category|type|mode|phase|stage|step|layer|block|unit|node|edge|graph|tree|path|loop|branch|condition|constraint|rule|fact|evidence|proof|hypothesis|assumption|premise|conclusion|result|finding|insight|implication|contribution|limitation|direction|extension|variant|version|update|fix|issue|error|warning|notice|info|trace|log|record|entry|item|element|object|subject|target|source|reference|cite|quote|note|comment|remark|annotation|caption|title|heading|paragraph|sentence|phrase|word|token|char|symbol|sign|mark|tag|badge|identifier|id|key|code|pin|secret|ticket|voucher|license|permit|certificate|credential|award|medal|prize|gift|bonus|benefit|advantage|edge|lead|margin|gap|difference|distance|range|scope|span|scale|size|length|width|height|depth|volume|area|surface|space|place|spot|location|site|position|point|dot|pixel|fragment|shard|piece|part|portion|section|segment|slice|chunk|block|lump|mass|body|entity|thing|article|product|goods|material|substance|matter|fabric|cloth|garment|clothing|wear|dress|costume|uniform|outfit|suit|wardrobe|closet|cabinet|cupboard|pantry|cellar|basement|attic|loft|tower|spire|dome|vault|arch|beam|column|pillar|post|pole|rod|bar|rail|track|path|way|road|route|course|direction|heading|bearing|azimuth|elevation|altitude|latitude|longitude|coordinate)(?![a-zA-Z0-9`])>',
        re.IGNORECASE
    )
    matches = html_tag_pattern.findall(content)
    if matches:
        issues.append(f"发现 {len(matches)} 个未转义的 HTML-like 标签: {set(matches)}")
        content = escape_html_like_tags(content)

    # 2. 检查未正确转换的 LaTeX 行内公式（$...$ 形式，可能被 Hugo 解析为 markdown）
    # 排除已在 \( ... \) 中的，以及 code block 中的
    latex_pattern = re.compile(r'(?<!\\)\$([^\s$][^$]*?)\$(?!\d)')
    latex_matches = latex_pattern.findall(content)
    if latex_matches:
        issues.append(f"发现 {len(latex_matches)} 个未转换的 LaTeX 行内公式")
        content = fix_latex_delimiters(content)

    # 3. 检查是否有裸的 HTML 标签（如 <s>、<e> 等小写形式）
    raw_html_pattern = re.compile(r'<(s|e|b|i|u)(\s+[^>]*)?>([^<]*)</\1>', re.IGNORECASE)
    raw_matches = raw_html_pattern.findall(content)
    if raw_matches:
        issues.append(f"发现 {len(raw_matches)} 个裸 HTML 标签，可能被浏览器渲染")

    # 4. 检查并修复非标准图片引用格式
    if re.search(r'外部\s*URL:', content):
        issues.append("发现非标准图片引用格式，尝试自动修复")
        content = fix_image_markdown(content)

    # 5. 检查并截断过长的 base64 data URI
    base64_matches = re.findall(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', content)
    long_base64 = [m for m in base64_matches if len(m) > 50000]
    if long_base64:
        issues.append(f"发现 {len(long_base64)} 个过长的 base64 data URI，已截断")
        content = truncate_base64_datauri(content)

    # 6. 修复 YAML frontmatter 双逗号
    if ',,' in content.split('---\n')[1] if len(content.split('---\n')) >= 3 else False:
        issues.append("发现 YAML frontmatter 双逗号，已修复")
        content = fix_yaml_double_commas(content)

    # 7. 检查是否有未闭合的 markdown 链接或图片引用
    broken_link_pattern = re.compile(r'!?\[([^\]]*)\]\s*\(\s*\)')
    broken_links = broken_link_pattern.findall(content)
    if broken_links:
        issues.append(f"发现 {len(broken_links)} 个空链接")

    # 8. 检查 YAML frontmatter 中是否有未闭合的双引号
    yaml_lines = content.split('---\n')
    if len(yaml_lines) >= 3:
        yaml_block = yaml_lines[1]
        for line in yaml_block.split('\n'):
            if ':' in line and '"' in line:
                quote_count = line.count('"')
                if quote_count % 2 != 0:
                    issues.append(f"YAML 行可能存在未闭合引号: {line[:60]}")
                    break

    fixed = content != original
    if fixed:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)

    return fixed, issues


def _review_single_paper(args):
    """并发 review 单篇论文，返回 (title, fixed_count, issue_count, output_lines)"""
    arxiv_id, slug, date_str, title = args
    paper_file = os.path.join(CONTENT_DIR, f"{date_str}-{slug}.md")
    if not os.path.exists(paper_file):
        return None

    fixed_count = 0
    issue_count = 0
    lines = []

    # 1. 代码检查
    fixed, issues = review_and_fix_post(paper_file)
    if fixed:
        fixed_count += 1
        lines.append("    🛠️  代码层自动修复")
    for issue in issues:
        lines.append(f"    ⚠️  代码层: {issue}")

    # 2. LLM 文本审查
    with open(paper_file, 'r', encoding='utf-8') as f:
        content = f.read()
    llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, title)
    if llm_issues:
        issue_count += len(llm_issues)
        for issue in llm_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🤖 LLM ({sev}): {desc}")
        if llm_fixed_content != content:
            with open(paper_file, 'w', encoding='utf-8') as f:
                f.write(llm_fixed_content)
            fixed_count += 1
            lines.append("    🛠️  LLM 自动修复已应用")

    # 3. 多模态图片审查
    img_passed, img_issues = multimodal_review_images(content, title)
    if img_issues:
        issue_count += len(img_issues)
        for issue in img_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🖼️  多模态 ({sev}): {desc}")

    if not issues and not llm_issues and not img_issues:
        lines.append("    ✅ 通过 review")

    return title, fixed_count, issue_count, lines


def review_all_posts(date_str, paper_slugs, scored_papers):
    """三层 review：代码检查 → LLM 文本审查 → 多模态图片审查（论文独立页面并发执行）"""
    print("\n🔍 开始三层 review（代码检查 → LLM 审查 → 多模态图片审查）...")
    total_fixed = 0
    total_issues = 0

    # 构建 arxivId -> title 映射
    title_map = {}
    for score, p, pa in scored_papers:
        title_map[p.get('arxivId', '')] = p.get('title', '')

    # Review 汇总页面（串行，只有1个）
    index_file = os.path.join(CONTENT_DIR, f"{date_str}.md")
    if os.path.exists(index_file):
        print("\n  📋 汇总页面:")
        # 1. 代码检查
        fixed, issues = review_and_fix_post(index_file)
        if fixed:
            total_fixed += 1
            print(f"    🛠️  代码层自动修复")
        for issue in issues:
            print(f"    ⚠️  代码层: {issue}")

        # 2. LLM 文本审查
        with open(index_file, 'r', encoding='utf-8') as f:
            content = f.read()
        llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, "汇总页面")
        if llm_issues:
            total_issues += len(llm_issues)
            for issue in llm_issues:
                sev = issue.get('severity', 'warning')
                desc = issue.get('description', '')
                print(f"    🤖 LLM ({sev}): {desc}")
            if llm_fixed_content != content:
                with open(index_file, 'w', encoding='utf-8') as f:
                    f.write(llm_fixed_content)
                total_fixed += 1
                print(f"    🛠️  LLM 自动修复已应用")

        if not issues and not llm_issues:
            print(f"    ✅ 通过 review")

    # Review 每篇论文独立页面（并发）
    paper_args = [
        (arxiv_id, slug, date_str, title_map.get(arxiv_id, slug))
        for arxiv_id, slug in paper_slugs.items()
    ]

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(_review_single_paper, args) for args in paper_args]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result is None:
                continue
            title, fixed_count, issue_count, lines = result
            print(f"\n  📄 {title[:50]}...")
            for line in lines:
                print(line)
            total_fixed += fixed_count
            total_issues += issue_count

    if total_fixed == 0 and total_issues == 0:
        print("\n  ✅ 所有文件通过三层 review，无问题")
    else:
        print(f"\n  📊 review 结果: {total_fixed} 个文件已修复, {total_issues} 个问题")

    return total_fixed, total_issues


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
        blog_url = os.environ.get('PAPER_DIGEST_BLOG_URL', 'https://nanless.github.io/audio-paper-digest-blog/posts')
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
    today = get_today_bj(target_date)
    print(f"📅 博客日期: {today}")

    # 只发布 fetchedAt 日期等于目标日期的论文（按抓取日期而非 arXiv 发布日期）
    filtered_papers = []
    for p in papers:
        fa = p.get('fetchedAt', '')
        if fa and isinstance(fa, str):
            fa_date = fa[:10]
            if fa_date == today:
                filtered_papers.append(p)

    papers = filtered_papers
    scored, unscored = score_and_sort(papers)
    print(f"📄 过滤后: {len(papers)} 篇论文 (fetchedAt={today})")

    if not papers:
        print("⚠️ 没有论文需要发布")
        return

    os.makedirs(CONTENT_DIR, exist_ok=True)

    paper_slugs = {}
    for paper in papers:
        # 优先使用已解析好的 parsed 数据（包含手动修正的标签等），避免重新解析覆盖
        pa = paper.get('parsed') or parse_analysis(paper.get('analysis', ''))
        if pa:
            paper_md, slug = generate_paper_page(paper, today)
            paper_md = fix_latex_delimiters(paper_md)
            paper_md = escape_html_like_tags(paper_md)
            paper_md = fix_image_markdown(paper_md)
            paper_md = truncate_base64_datauri(paper_md)
            paper_md = fix_yaml_double_commas(paper_md)
            paper_file = os.path.join(CONTENT_DIR, f"{today}-{slug}.md")
            with open(paper_file, 'w') as f:
                f.write(paper_md)
            paper_slugs[paper.get('arxivId', '')] = slug

    print(f"📄 生成 {len(paper_slugs)} 篇论文独立页面")

    index_md = generate_index_page(scored, unscored, today, paper_slugs)
    index_md = fix_latex_delimiters(index_md)
    index_md = escape_html_like_tags(index_md)
    index_md = fix_image_markdown(index_md)
    index_md = truncate_base64_datauri(index_md)
    index_md = fix_yaml_double_commas(index_md)
    index_file = os.path.join(CONTENT_DIR, f"{today}.md")
    with open(index_file, 'w') as f:
        f.write(index_md)
    print(f"📄 汇总页面: {index_file} ({len(index_md)} chars)")

    # 三层 review：代码检查 → LLM 审查 → 多模态图片审查
    review_all_posts(today, paper_slugs, scored)

    if skip_push:
        print("\n⏭️ 跳过推送")
        return

    git_push(today)

    print(f"\n🎉 博客发布完成！")


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
from project_env import load_project_env
load_project_env()

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
    python3 generate-blog.py                   # 只生成并写 generation manifest
    python3 review-blog.py                     # 只 review 并写 SHA-256 审查凭证
    python3 push-blog.py                       # 只验证凭证后 commit/push
    python3 publish-to-blog.py                 # 兼容生成入口
    python3 publish-to-blog.py --date YYYY-MM-DD
"""
import json, re, sys, os, subprocess, datetime, base64, concurrent.futures, hashlib
import ipaddress, shutil, socket, tempfile
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    extract_all_tags, score_emoji, format_medal, build_paper_meta,
    fix_latex_delimiters, escape_html_like_tags, fix_image_markdown,
    truncate_base64_datauri, fix_yaml_double_commas, strip_raw_inline_html,
    fix_empty_markdown_links, dedupe_image_alts, fix_yaml_unbalanced_quotes,
    sanitize_markdown_for_publish, call_publish_llm_api, PublishLLMUnavailable,
    PublishDataValidationError, count_blocking_review_issues,
    normalize_publish_arxiv_id, review_protocol_failure,
    validate_papers_for_publish, validate_review_payload
)
from path_config import CURRENT_DIR, atomic_write_json, atomic_write_text
from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env
from utils import strip_md, parse_analysis

BLOG_REPO = os.path.expanduser(
    os.environ.get("PAPER_DIGEST_BLOG_REPO", "~/code/github_repos/audio-paper-digest-blog")
)
CONTENT_DIR = os.path.join(BLOG_REPO, "content", "posts")
BASE_PATH = os.environ.get("PAPER_DIGEST_BLOG_BASE_PATH", "/audio-paper-digest-blog")
GITHUB_REMOTE = os.environ.get("PAPER_DIGEST_GITHUB_REMOTE", "origin")


def get_blog_review_concurrency():
    """Return the project-scoped concurrency for independent post reviews."""
    raw = os.environ.get("PD_BLOG_REVIEW_CONCURRENCY", "8").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 8
    return max(1, value)

def call_llm_api(
    prompt,
    max_tokens=800,
    temperature=0.1,
    required=False,
    context="LLM review",
    timeout=120,
    images=None,
    use_secondary=False,
):
    """调用发布阶段公共 LLM API client。"""
    return call_publish_llm_api(
        prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        required=required,
        context=context,
        timeout=timeout,
        images=images,
        use_secondary=use_secondary,
    )


def validate_publish_date(value):
    """Return a canonical real Gregorian date in strict YYYY-MM-DD form."""
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise PublishDataValidationError('博客日期必须严格使用 YYYY-MM-DD 格式')
    try:
        parsed = datetime.datetime.strptime(value, '%Y-%m-%d')
    except ValueError as exc:
        raise PublishDataValidationError(f'博客日期不是有效日期: {value}') from exc
    if parsed.strftime('%Y-%m-%d') != value:
        raise PublishDataValidationError(f'博客日期不是规范日期: {value}')
    return value


def validate_publish_target(blog_repo=None, content_dir=None):
    """Constrain publication writes to <blog repo>/content/posts."""
    blog_repo = BLOG_REPO if blog_repo is None else blog_repo
    content_dir = CONTENT_DIR if content_dir is None else content_dir
    repo = Path(blog_repo).expanduser().resolve()
    target = Path(content_dir).expanduser().resolve()
    expected = (repo / 'content' / 'posts').resolve()
    try:
        expected.relative_to(repo)
    except ValueError as exc:
        raise PublishDataValidationError('博客 content/posts 不能通过符号链接逃逸仓库') from exc
    if target != expected:
        raise PublishDataValidationError(
            f'CONTENT_DIR 必须严格为博客仓库的 content/posts: {expected}'
        )
    if not repo.is_dir():
        raise PublishDataValidationError(f'博客仓库不存在或不是目录: {repo}')
    return repo, target


def split_review_content(content, limit=4000):
    """Split the complete body into bounded chunks without dropping any text."""
    if not content:
        return ['']
    chunks = []
    current = ''
    for line in content.splitlines(keepends=True):
        while len(line) > limit:
            if current:
                chunks.append(current)
                current = ''
            chunks.append(line[:limit])
            line = line[limit:]
        if current and len(current) + len(line) > limit:
            if line.lstrip().startswith('|'):
                current_lines = current.splitlines(keepends=True)
                table_start = len(current_lines)
                while table_start > 0 and current_lines[table_start - 1].lstrip().startswith('|'):
                    table_start -= 1
                if 0 < table_start < len(current_lines):
                    chunks.append(''.join(current_lines[:table_start]))
                    current = ''.join(current_lines[table_start:])
            if current and len(current) + len(line) <= limit:
                current += line
                continue
            chunks.append(current)
            current = ''
        current += line
    if current or not chunks:
        chunks.append(current)
    return chunks


def has_unconverted_dollar_math(content):
    """是否仍存在未转换的 $...$ / $$...$$ 公式。"""
    if not content:
        return False
    if re.search(r'(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$', content):
        return True
    return bool(re.search(r'(?<!\\)\$([^\s$][^$]*?[^\s$])(?<!\\)\$', content))


def filter_false_positive_review_issues(content, issues):
    """过滤可由代码确定为误报的 LLM review 问题。"""
    if not issues:
        return issues
    raw_dollar_math = has_unconverted_dollar_math(content)
    unescaped_angle_tags = set(
        m.group(0)
        for m in re.finditer(r'(?<![a-zA-Z0-9`])<(/?)([A-Za-z][A-Za-z0-9_†-]{0,40})(?![A-Za-z0-9_†-])>', content)
    )
    filtered = []
    for issue in issues:
        desc = str(issue.get('description', ''))
        issue_type = str(issue.get('type', '')).lower()
        if ('反引号' in desc or 'backtick' in desc.lower()) and re.search(r'模型名|模型名称|技术术语|model name|technical term', desc, re.IGNORECASE):
            continue
        if not raw_dollar_math and (issue_type == 'latex' or '$' in desc) and ('LaTeX' in desc or '公式' in desc or '$' in desc):
            continue
        mentioned_angle_tags = set(re.findall(r'</?[A-Za-z][A-Za-z0-9_†-]{0,40}>', desc))
        if mentioned_angle_tags and not (mentioned_angle_tags & unescaped_angle_tags):
            continue
        if not unescaped_angle_tags and (issue_type == 'html_tag' or 'HTML-like' in desc or 'HTML标签' in desc):
            continue
        filtered.append(issue)
    return filtered


def _llm_review_post_chunk(content, title="", required=False, chunk_label='1/1'):
    """Review one bounded chunk of a post."""
    title = plain_title_for_publish(title) if title else title
    prompt = f"""你是一个 Hugo 静态站点博客内容质量审查专家。

请严格审查下面这篇博客的 Markdown 内容，重点检查以下问题：

1. **HTML 标签解析问题**：只检查尖括号包裹的文本标记，例如 `<S>`、`<E>`、`<Sigmoid>`、`<B†>`、`<s>`、`<e>` 等是否**未被反引号包裹**而被 Hugo 错误解析为 HTML 标签（会导致删除线、粗体等意外样式）。普通英文名词或数据集名（如 Lakh MIDI、TheoryTab、MELD、CMU-MOSEI）不是 HTML-like 标签，不要报告。注意：已经被反引号包裹的如 `` `<S>` `` 是正确格式，不要报告。
2. **LaTeX 公式渲染问题**：检查是否存在使用了 `$...$` 或 `$$...$$` 格式的公式。注意：纯文本形式的数学描述（如 "RMS = sqrt(1/N)"）不是 LaTeX 公式，不需要报告；只有明确使用了 `$` 或 `$$` 包裹但未转换为 `\\(...\\)` / `\\[...\\]` 的才需要报告。
3. **Markdown 格式问题**：链接、图片引用、表格、列表等格式是否有语法错误
4. **内容完整性**：是否有乱码、重复、段落错位。当前内容是完整正文的分块 {chunk_label}，不要因为分块边界报告内容不完整。
5. **图片问题**：图片链接是否为空、格式是否正确（支持 base64 data URI 和普通 URL）
6. **YAML frontmatter 问题**：标题、描述等字段是否有引号不匹配、特殊字符未转义

【重要区分】以下情况**不要**作为错误报告：
- 已经用反引号包裹的 HTML-like 标记（如 `` `<S>` ``）→ 这是正确格式
- 纯文本中的数学符号或公式描述（未使用 `$` 包裹）→ 这不是 LaTeX 格式问题
- 仅属于风格建议的问题（如 alt 文本可以更详细、列表格式可以更统一）→ 这些应评为 info 级别或干脆不报告
- 技术术语未用反引号包裹 → 这不是格式错误，除非它会被 Hugo 解析为 HTML

博客标题：{title}

博客正文分块 {chunk_label}：
```markdown
{content}
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

    prompt += """

协议一致性要求：
- 只有 `issues` 中至少存在一条 `severity=error` 时，`passed` 才能为 `false`。
- 若只有 `warning` / `info` 或没有问题，`passed` 必须为 `true`。
- `passed=false` 时必须给出至少一条具体、可执行的 `error` 级原因。
"""

    result = call_llm_api(prompt, max_tokens=1500, temperature=0.1, required=required, context=f"LLM 文本 review: {title}")
    if not result:
        if required:
            passed, issues = review_protocol_failure(f"LLM 文本 review: {title}", '响应为空')
            return passed, issues, content
        return True, [], content

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
        passed, issues = validate_review_payload(
            review,
            required=required,
            context=f"LLM 文本 review: {title}",
            issue_fields=('type', 'auto_fixable', 'fix_instruction'),
        )
        issues = filter_false_positive_review_issues(content, issues)
        if not issues:
            passed = True
        # 自动应用可修复的问题
        fixed_content = apply_llm_fixes(content, issues)
        return passed, issues, fixed_content
    except (json.JSONDecodeError, TypeError, ValueError):
        # 如果 JSON 解析失败，尝试从文本中提取问题
        print(f"  ⚠️  LLM review 返回非 JSON 格式，尝试文本解析")
        if required:
            passed, issues = review_protocol_failure(
                f"LLM 文本 review: {title}",
                '响应不是可解析的 JSON',
            )
            return passed, issues, content
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


def llm_review_post(content, title="", required=False):
    """Review every chunk of a post and return merged issues and fixes."""
    chunks = split_review_content(content, 4000)
    all_issues = []
    passed = True
    chunk_results = [None] * len(chunks)

    def review_chunk(index):
        return _llm_review_post_chunk(
            chunks[index],
            title,
            required=required,
            chunk_label=f'{index + 1}/{len(chunks)}',
        )

    # The large daily index is otherwise the serial bottleneck. Paper pages are
    # already parallelized by review_all_posts, so keep their chunks sequential
    # to avoid multiplying page concurrency by chunk concurrency.
    if title == "汇总页" and len(chunks) > 1:
        workers = min(get_blog_review_concurrency(), len(chunks))
        print(f"    🔀 汇总页文本分块 review 并发度: {workers}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(review_chunk, index): index
                for index in range(len(chunks))
            }
            for future in concurrent.futures.as_completed(futures):
                chunk_results[futures[future]] = future.result()
    else:
        for index in range(len(chunks)):
            chunk_results[index] = review_chunk(index)

    for chunk_passed, issues, _unused in chunk_results:
        passed = passed and chunk_passed
        all_issues.extend(issues)
    fixed_content = apply_llm_fixes(content, all_issues)
    if count_blocking_review_issues(all_issues):
        passed = False
    return passed, all_issues, fixed_content


REVIEW_IMAGE_MIME_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
REVIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024


def _validate_public_image_url(url):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise PublishDataValidationError('图片 review 只允许无认证信息的 HTTPS URL')
    hostname = parsed.hostname.lower().rstrip('.')
    if hostname == 'localhost' or hostname.endswith('.local'):
        raise PublishDataValidationError('图片 review 拒绝本地主机 URL')
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except socket.gaierror as exc:
        raise PublishDataValidationError(f'图片域名无法解析: {hostname}') from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise PublishDataValidationError(f'图片 URL 解析到非公网地址: {address}')
    return {str(ipaddress.ip_address(address)) for address in addresses}


def _response_peer_ip(response):
    """Extract the connected peer from requests/urllib3 without trusting DNS twice."""
    raw = getattr(response, 'raw', None)
    candidates = [
        getattr(getattr(raw, '_connection', None), 'sock', None),
        getattr(getattr(raw, 'connection', None), 'sock', None),
    ]
    original = getattr(raw, '_original_response', None)
    try:
        candidates.append(original.fp.raw._sock)
    except AttributeError:
        pass
    for sock in candidates:
        if sock is None:
            continue
        try:
            return str(ipaddress.ip_address(sock.getpeername()[0].split('%', 1)[0]))
        except (AttributeError, OSError, ValueError):
            continue
    raise PublishDataValidationError('无法验证图片 HTTPS 连接的实际 peer IP')


def _validate_response_peer(response, resolved_addresses):
    peer = _response_peer_ip(response)
    if not ipaddress.ip_address(peer).is_global:
        raise PublishDataValidationError(f'图片 HTTPS 连接命中非公网 peer: {peer}')
    if peer not in resolved_addresses:
        raise PublishDataValidationError(
            f'图片 HTTPS peer {peer} 不在预先验证的 DNS 解析结果中，疑似 DNS rebinding'
        )
    return peer


def _download_review_image(url):
    """Download a public image with redirect, MIME, and size validation."""
    import requests

    session = requests.Session()
    session.trust_env = False
    try:
        current = url
        for _redirect in range(4):
            resolved_addresses = _validate_public_image_url(current)
            response = session.get(current, timeout=30, stream=True, allow_redirects=False)
            try:
                _validate_response_peer(response, resolved_addresses)
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get('Location')
                    if not location:
                        raise PublishDataValidationError('图片重定向缺少 Location')
                    from urllib.parse import urljoin
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                media_type = response.headers.get('Content-Type', '').split(';', 1)[0].lower()
                if media_type not in REVIEW_IMAGE_MIME_TYPES:
                    raise PublishDataValidationError(f'图片 MIME 不受支持: {media_type or "unknown"}')
                declared_size = response.headers.get('Content-Length')
                if declared_size and int(declared_size) > REVIEW_IMAGE_MAX_BYTES:
                    raise PublishDataValidationError('图片超过 8 MiB review 上限')
                chunks = []
                size = 0
                for chunk in response.iter_content(65536):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > REVIEW_IMAGE_MAX_BYTES:
                        raise PublishDataValidationError('图片超过 8 MiB review 上限')
                    chunks.append(chunk)
                raw = b''.join(chunks)
                _validate_image_signature(media_type, raw)
                return {
                    'media_type': media_type,
                    'data': base64.b64encode(raw).decode('ascii'),
                }
            finally:
                close = getattr(response, 'close', None)
                if callable(close):
                    close()
        raise PublishDataValidationError('图片重定向次数过多')
    except PublishDataValidationError:
        raise
    except (requests.RequestException, OSError, ValueError) as exc:
        raise PublishDataValidationError(f'图片下载失败: {exc}') from exc
    finally:
        session.close()


def _validate_image_signature(media_type, raw):
    signatures = {
        'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
        'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/gif': raw.startswith((b'GIF87a', b'GIF89a')),
        'image/webp': len(raw) >= 12 and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP',
    }
    if not raw:
        raise PublishDataValidationError('图片内容为空')
    if not signatures.get(media_type, False):
        raise PublishDataValidationError(f'图片内容与 MIME 签名不一致: {media_type}')


def _load_review_image(url):
    if url.startswith('data:'):
        match = re.fullmatch(r'data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)', url)
        if not match:
            raise PublishDataValidationError('图片 data URI 必须是合法 base64')
        media_type = match.group(1).lower()
        if media_type not in REVIEW_IMAGE_MIME_TYPES:
            raise PublishDataValidationError(f'图片 MIME 不受支持: {media_type}')
        try:
            encoded = re.sub(r'\s+', '', match.group(2))
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise PublishDataValidationError('图片 data URI base64 非法') from exc
        if not raw or len(raw) > REVIEW_IMAGE_MAX_BYTES:
            raise PublishDataValidationError('图片 data URI 为空或超过 8 MiB')
        _validate_image_signature(media_type, raw)
        return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}
    if url.startswith('https://'):
        return _download_review_image(url)
    raise PublishDataValidationError('图片 review 不允许相对路径或非 HTTPS URL')


def multimodal_review_images(content, title="", required=False):
    """Send actual image bytes to the routed multimodal publish API."""
    title = plain_title_for_publish(title) if title else title
    # 提取所有图片引用
    img_pattern = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')
    image_matches = list(img_pattern.finditer(content))

    if not image_matches:
        return True, []

    img_summary = []
    image_payloads = []
    load_issues = []
    for match in image_matches:
        alt, url = match.groups()
        nearby = content[max(0, match.start() - 600):min(len(content), match.end() + 600)]
        nearby = nearby.replace(url, '[图片 URL]').strip()
        try:
            image_payload = _load_review_image(url)
        except PublishDataValidationError as exc:
            load_issues.append({
                'severity': 'error' if required else 'warning',
                'description': f'无法加载图片内容用于多模态 review: {exc}',
            })
            continue
        # Keep prompt metadata and attached bytes in the same append path.
        # A failed download must not shift later images onto earlier contexts.
        image_payloads.append(image_payload)
        img_summary.append(
            f"- 图片 {len(img_summary) + 1} | alt: `{alt}` | 来源: {url[:500]}\n"
            f"  正文附近上下文：\n```markdown\n{nearby}\n```"
        )

    if load_issues and required:
        return False, load_issues
    if not image_payloads:
        return (not required), load_issues

    prompt = f"""你是一个博客图片质量审查专家。

请审查下面这篇博客中的图片引用是否合理。

【重要】本请求已按列表顺序附上实际图片字节，以下是正文中提取的对应元数据：
- 博客正文中的实际图片格式为标准 Markdown：`![alt](url)`
- 摘要中的格式（如"外部图片: url | alt: ..."）只是元数据展示，**不要**因为摘要格式而误判
- 摘要中的 URL 可能为了简洁而截断，但博客正文中的 URL 是完整的
- 如果博客正文中所有图片都使用 `![alt](url)` 格式，则格式检查项应视为通过

博客标题：{title}
图片元数据摘要：
{chr(10).join(img_summary)}

请检查：
1. 图片内容是否可解码、清晰且与 alt 和论文正文语义一致
2. 图片是否包含明显错误、空白、损坏、无关内容或隐私信息
3. 图片 alt 文本是否为空、重复或与实际内容冲突

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

    prompt += """

协议一致性要求：只有存在 `severity=error` 的问题时 `passed` 才能为 `false`；仅有 warning/info 或无问题时必须为 `true`。`passed=false` 时必须提供至少一条具体的 error 级原因。
"""

    result = call_llm_api(
        prompt,
        max_tokens=800,
        temperature=0.1,
        required=required,
        context=f"多模态图片 review: {title}",
        images=image_payloads,
        use_secondary=True,
    )
    if not result:
        if required:
            return review_protocol_failure(f"多模态图片 review: {title}", '响应为空')
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
        passed, issues = validate_review_payload(
            review,
            required=required,
            context=f"多模态图片 review: {title}",
        )
        return passed, load_issues + issues
    except (json.JSONDecodeError, TypeError, ValueError):
        fallback = cleaned.strip()
        if required:
            return review_protocol_failure(
                f"多模态图片 review: {title}",
                '响应不是可解析的 JSON',
            )
        lower = fallback.lower()
        error_markers = ['error', '错误', '阻断', '不合理', '无法渲染', '过长', '空 alt', '重复 alt']
        pass_markers = ['passed', '"passed": true', '通过', '无问题', '没有问题', '未发现问题']
        if any(marker in lower for marker in error_markers):
            return False, [{
                "severity": "error",
                "description": f"多模态图片 review 返回非 JSON，但文本中包含错误信号：{fallback[:240]}"
            }]
        if any(marker in lower for marker in pass_markers):
            return True, []
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


def normalize_arxiv_id(arxiv_id):
    """Normalize an arXiv identifier for stable, traversal-safe filenames."""
    return normalize_publish_arxiv_id(arxiv_id)


def paper_slug(title, arxiv_id):
    id_suffix = normalize_arxiv_id(arxiv_id).replace('/', '-').replace('.', '-')
    return f'{slugify(title, max_length=50)}-{id_suffix}'


def yaml_escape(s):
    """安全转义 YAML 双引号字符串中的特殊字符，同时避免 f-string 解析问题"""
    if not s:
        return ''
    # 标题/描述里的短 LaTeX 片段保留内部文本，避免 Best-of-$N$ 变成 Best-of-。
    s = re.sub(r'\\\(([^)]+)\\\)', r'\1', s)
    s = re.sub(r'\\\[([^\]]+)\\\]', r'\1', s)
    s = re.sub(r'\$\$([^$]*?)\$\$', r'\1', s)
    s = re.sub(r'\$([^\s\$][^$]*?)\$', r'\1', s)
    return (s.replace('\\', '\\\\')
             .replace('"', '\\"')
             .replace('\n', ' ')
             .replace('{', '{{')
             .replace('}', '}}'))


def plain_title_for_publish(title):
    """标题中的短数学标记转成普通文本，避免 Hugo/frontmatter 误解析。"""
    return yaml_escape(title).replace('\\\\', '\\')


def generate_index_page(scored, unscored, date_str, paper_slugs, category='论文速递'):
    """生成每日汇总页面（index.md），包含概览和每篇论文的链接"""
    total = len(scored) + len(unscored)
    tag_set = extract_all_tags([p for _, p, _ in scored] + unscored, limit=10)
    top_tags = extract_top_tags([p for _, p, _ in scored] + unscored, limit=8)

    conference_title = f'ICML 2026 论文速递' if category == 'icml-2026' else f'语音/音乐/音频论文速递 {date_str}'
    md = f"""---
title: "{conference_title}"
date: {date_str}
draft: false
tags: [{', '.join(tag_set)}]
categories: [{category}]
description: "共分析 {total} 篇语音/AI 论文"
layout: "posts"
paper_digest_pipeline_owned: true
paper_digest_page_type: index
---

# {conference_title}

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
    md += "| 排名 | 论文 | 总分 | 分档 | 文档类型 | 主任务 |\n|------|------|------|------|----------|--------|\n"
    for i, (score, p, pa) in enumerate(scored):
        m = format_medal(i)
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        rank_bucket = pa.get('rankBucket', '') or '-'
        document_type = pa.get('documentType', '') or '-'
        primary_task = pa.get('primaryTaskTag', '') or '-'
        if slug:
            md += f"| {m} | [{title[:55]}]({BASE_PATH}/posts/{date_str}-{slug}) | {score}分 | {rank_bucket} | {document_type} | {primary_task} |\n"
        else:
            md += f"| {m} | {title[:55]} | {score}分 | {rank_bucket} | {document_type} | {primary_task} |\n"
    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        if slug:
            md += f"| {len(scored)+i+1} | [{title[:55]}]({BASE_PATH}/posts/{date_str}-{slug}) | N/A | - | - | - |\n"
        else:
            md += f"| {len(scored)+i+1} | {title[:55]} | N/A | - | - | - |\n"

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

        pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        aid = p.get('arxivId', '')
        aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
        
        # 显示总分和所有子项得分（单开一行）
        score_line = []
        if pa.get('score'):
            score_line.append(f"**{pa['score']}/10**")
        sub_scores = []
        if pa.get('innovationScore'):
            sub_scores.append(f"创新 {pa['innovationScore']}/2")
        if pa.get('technicalRigorScore'):
            sub_scores.append(f"严谨 {pa['technicalRigorScore']}/1.5")
        if pa.get('experimentalSufficiencyScore'):
            sub_scores.append(f"实验 {pa['experimentalSufficiencyScore']}/1.5")
        if pa.get('clarityScore'):
            sub_scores.append(f"清晰 {pa['clarityScore']}/1")
        if pa.get('impactScore'):
            sub_scores.append(f"影响 {pa['impactScore']}/1.5")
        if pa.get('openSourceScore'):
            sub_scores.append(f"开源 {pa['openSourceScore']}/1.5")
        if pa.get('reproducibilityScore'):
            sub_scores.append(f"复现 {pa['reproducibilityScore']}/0.5")
        if pa.get('engineeringScore'):
            sub_scores.append(f"工程 {pa['engineeringScore']}/1.5")
        if sub_scores:
            score_line.append(' | '.join(sub_scores))
        if score_line:
            md += f"{' | '.join(score_line)}\n\n"
        
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
        pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
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


def generate_paper_page(paper, date_str, category='论文速递'):
    """生成单篇论文的独立页面"""
    # main() replaces parsed with the validated analysis baseline before generation.
    pa = dict(paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {})
    # 补充 opensource 中缺失的具体链接
    if pa and pa.get('opensource'):
        pa['opensource'] = enrich_opensource(pa, paper)
    title = paper.get('title', 'Unknown')
    display_title = plain_title_for_publish(title)
    aid = paper.get('arxivId', '')
    aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
    slug = paper_slug(title, aid)

    score_str = pa['score'] if pa and pa.get('score') else ''
    task_str = pa['primaryTaskTag'].replace('#', '') if pa and pa.get('primaryTaskTag') else ''
    desc = f"{task_str} | {score_str}/10" if score_str and task_str else display_title
    tags = pa.get('tags', []) if pa else []
    md = f"""---
title: "{yaml_escape(display_title)}"
date: {date_str}
draft: false
tags: [{', '.join([t.replace('#', '') for t in tags])}]
categories: [{category}]
description: "{yaml_escape(desc)}"
hiddenInHomeList: true
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
paper_digest_arxiv_id: "{normalize_arxiv_id(aid)}"
---

# 📄 {display_title}

"""
    if paper.get('analysisSource') == 'abstract':
        md += '> ⚠️ 本文仅基于论文摘要生成，未能取得可验证的全文，技术细节与评分置信度有限。\n\n'
    elif paper.get('analysisConfidence') == 'full_text' and paper.get('sourceTextChars', 0) > paper.get('usedTextChars', paper.get('sourceTextChars', 0)):
        md += '> ℹ️ 本文基于论文全文节选生成，超出分析上下文上限的内容未纳入。\n\n'
    if pa:
        if tags:
            md += f"标签：{' '.join(tags)}\n\n"

        # 得分单开一行：总分 + 所有子项
        score_line = []
        if pa.get('score'):
            score_line.append(f"**{pa['score']}/10**")
        sub_scores = []
        if pa.get('innovationScore'):
            sub_scores.append(f"创新 {pa['innovationScore']}/2")
        if pa.get('technicalRigorScore'):
            sub_scores.append(f"严谨 {pa['technicalRigorScore']}/1.5")
        if pa.get('experimentalSufficiencyScore'):
            sub_scores.append(f"实验 {pa['experimentalSufficiencyScore']}/1.5")
        if pa.get('clarityScore'):
            sub_scores.append(f"清晰 {pa['clarityScore']}/1")
        if pa.get('impactScore'):
            sub_scores.append(f"影响 {pa['impactScore']}/1.5")
        if pa.get('openSourceScore'):
            sub_scores.append(f"开源 {pa['openSourceScore']}/1.5")
        if pa.get('reproducibilityScore'):
            sub_scores.append(f"复现 {pa['reproducibilityScore']}/0.5")
        if pa.get('engineeringScore'):
            sub_scores.append(f"工程 {pa['engineeringScore']}/1.5")
        if sub_scores:
            score_line.append(' | '.join(sub_scores))
        if score_line:
            md += f"{' | '.join(score_line)}\n\n"

        meta = build_paper_meta(pa, aurl)
        if meta:
            md += f"{meta}\n\n"

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

    # 自动补足已筛选图片（按 URL 去重，保留 analysis 中已有图片）。
    # 不使用 allImageUrls，避免把未经过副模型筛选的无关图片兜底发布出去。
    image_urls = paper.get('selectedImageUrls', [])
    if image_urls:
        existing_image_urls = set(re.findall(r'!\[[^\]]*\]\(([^)]+)\)', md))
        image_urls = [url for url in image_urls if url not in existing_image_urls]

    if image_urls:
        # 将图片智能插入到对应章节，而非全部堆在最后
        def insert_images_into_sections(markdown, urls):
            if not urls:
                return markdown
            
            # 定义可能插入图片的章节标题（按优先级）
            # 使用 ### 匹配三级标题（博客中 analysis 的一级标题被转换为三级）
            # [^#\n]* 匹配标题名称前的任意内容（包括 emoji）
            section_patterns = [
                (r'(###[^#\n]*方法概述和架构[\s\S]*?)(?=\n###\s|\Z)', '方法概述'),   # 方法概述部分后
                (r'(###[^#\n]*实验结果[\s\S]*?)(?=\n###\s|\Z)', '实验结果'),       # 实验结果部分后
            ]
            
            inserted = 0
            urls_list = list(urls)
            
            for pattern, section_name in section_patterns:
                match = re.search(pattern, markdown)
                if match and inserted < len(urls_list):
                    # 每个章节最多插入2张图片
                    imgs_to_insert = urls_list[inserted:inserted+2]
                    if imgs_to_insert:
                        img_md = '\n'
                        for j, img_url in enumerate(imgs_to_insert, inserted+1):
                            img_md += f'![图{j}]({img_url})\n\n'
                        
                        # 在章节内容结束后插入图片
                        end_pos = match.end(1)
                        markdown = markdown[:end_pos] + img_md + markdown[end_pos:]
                        inserted += len(imgs_to_insert)
            
            # 如果还有剩余图片未插入，放在最后
            if inserted < len(urls_list):
                remaining = urls_list[inserted:]
                img_md = '\n### 📷 论文图片\n\n'
                for j, img_url in enumerate(remaining, inserted+1):
                    img_md += f'![图{j}]({img_url})\n\n'
                # 插入到返回链接之前
                return_link = f'\n---\n\n[← 返回'
                if return_link in markdown:
                    markdown = markdown.replace(return_link, img_md + return_link)
                else:
                    markdown += img_md
            
            return markdown
        
        md = insert_images_into_sections(md, image_urls[:5])

    md += f'\n---\n\n[← 返回 {date_str} 语音/音乐/音频论文速递]({BASE_PATH}/posts/{date_str}/)\n'

    return md, slug


def review_and_fix_post(file_path):
    """Review 生成的博客文件，自动修复常见问题，返回 (是否修复, 问题列表)"""
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    issues = []

    # 0. 修复 UTF-8 乱码字符（U+FFFD），从上下文推断正确汉字
    # 先统一检测，再统一修复，避免逐词替换时的顺序问题
    garbled_count = content.count('\ufffd')
    if garbled_count > 0:
        # 直接删除孤立的替换字符（1-3 字节的 � 没有上下文可推断）
        # 连续的 � 通常是 1 个中文字符损坏，替换为合理占位
        content = content.replace('\ufffd\ufffd\ufffd', '。')
        content = content.replace('\ufffd\ufffd', '。')
        # 单字符乱码：如果是中文语境，替换为空；英文语境保留原意
        content = re.sub(r'\ufffd', '', content)
        issues.append(f"发现并修复 {garbled_count} 个 UTF-8 乱码字符")

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
        issues.append(f"发现 {len(raw_matches)} 个裸 HTML 标签，已转为纯文本")
        content = strip_raw_inline_html(content)

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

    # 7. 检查并修复未闭合的 LaTeX $ 公式（$ \mathcal{L}_D \( 形式）
    broken_latex_pattern = re.compile(r'\$ \\mathcal\{([^}]+)\}[^\\]*\\\(')
    if broken_latex_pattern.search(content):
        issues.append("发现未闭合的 LaTeX $ 公式，已修复")
        content = broken_latex_pattern.sub(lambda m: f'\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 8. 检查并修复表格中错乱的 LaTeX 括号（如 \)\\mathcal{L}_D$）
    broken_latex_table = re.compile(r'\\\)\\\\mathcal\{([^}]+)\}\$')
    if broken_latex_table.search(content):
        issues.append("发现表格中错乱的 LaTeX，已修复")
        content = broken_latex_table.sub(lambda m: f'\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 9. 检查并修复 "仅\)\mathcal{L}_A\(" 这类错乱模式
    broken_paren_latex = re.compile(r'仅\\\)\\mathcal\{([^}]+)\}\\\(')
    if broken_paren_latex.search(content):
        issues.append("发现错乱的 LaTeX 括号，已修复")
        content = broken_paren_latex.sub(lambda m: f'仅\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 10. 检查并修复 \(\\mathcal{L}_X\) 双反斜杠问题
    double_backslash_latex = re.compile(r'\\\(\\\\mathcal\{([^}]+)\}\\\)')
    if double_backslash_latex.search(content):
        issues.append("发现双反斜杠 LaTeX，已修复")
        content = double_backslash_latex.sub(lambda m: f'\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 11. 检查是否有未闭合的 markdown 链接或图片引用
    broken_link_pattern = re.compile(r'!?\[([^\]]*)\]\s*\(\s*\)')
    broken_links = broken_link_pattern.findall(content)
    if broken_links:
        issues.append(f"发现 {len(broken_links)} 个空链接，已修复")
        content = fix_empty_markdown_links(content)

    # 11.5 检查并修复空/重复图片 alt
    deduped_content = dedupe_image_alts(content)
    if deduped_content != content:
        issues.append("发现空或重复图片 alt，已补齐/去重")
        content = deduped_content

    # 12. 检查 YAML frontmatter 中是否有未闭合的双引号
    content_before_yaml_quote_fix = content
    content = fix_yaml_unbalanced_quotes(content)
    if content != content_before_yaml_quote_fix:
        issues.append("发现 YAML frontmatter 未闭合引号，已修复")
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
        atomic_write_text(file_path, content)

    return fixed, issues


def _review_single_paper(args):
    """并发 review 单篇论文，返回 (title, fixed_count, blocking_count, advisory_count, output_lines)"""
    arxiv_id, slug, date_str, title, require_llm, content_dir = args
    paper_file = os.path.join(content_dir, f"{date_str}-{slug}.md")
    if not os.path.exists(paper_file):
        return None

    fixed_count = 0
    blocking_count = 0
    advisory_count = 0
    lines = []

    # 1. 代码检查
    fixed, issues = review_and_fix_post(paper_file)
    if fixed:
        fixed_count += 1
        lines.append("    🛠️  代码层自动修复")
        _, remaining_code_issues = review_and_fix_post(paper_file)
    else:
        remaining_code_issues = issues
    blocking_count += len(remaining_code_issues)
    for issue in issues:
        lines.append(f"    ⚠️  代码层: {issue}")

    # 2. LLM 文本审查
    with open(paper_file, 'r', encoding='utf-8') as f:
        content = f.read()
    llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, title, required=require_llm)
    if llm_issues:
        for issue in llm_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🤖 LLM ({sev}): {desc}")
        if llm_fixed_content != content:
            atomic_write_text(paper_file, llm_fixed_content)
            fixed_count += 1
            lines.append("    🛠️  LLM 自动修复已应用")
            content = llm_fixed_content
            llm_passed, llm_issues, _ = llm_review_post(llm_fixed_content, title, required=require_llm)
        llm_blocking = count_blocking_review_issues(llm_issues)
        blocking_count += llm_blocking
        advisory_count += len(llm_issues) - llm_blocking

    # 3. 多模态图片审查
    img_passed, img_issues = multimodal_review_images(content, title, required=require_llm)
    if img_issues:
        img_blocking = count_blocking_review_issues(img_issues)
        blocking_count += img_blocking
        advisory_count += len(img_issues) - img_blocking
        for issue in img_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🖼️  多模态 ({sev}): {desc}")

    if blocking_count == 0:
        if advisory_count == 0:
            lines.append("    ✅ 通过 review")
        else:
            lines.append(f"    ✅ 无阻断问题（保留 {advisory_count} 个 warning/info）")

    return title, fixed_count, blocking_count, advisory_count, lines


def review_all_posts(date_str, paper_slugs, scored_papers, require_llm=False, content_dir=None):
    """三层 review：代码检查 → LLM 文本审查 → 多模态图片审查（论文独立页面并发执行）"""
    print("\n🔍 开始三层 review（代码检查 → LLM 审查 → 多模态图片审查）...")
    if require_llm:
        print("  🔒 正式发布模式：LLM review 必须可用，失败将阻断推送")
    total_fixed = 0
    total_blocking_issues = 0
    total_advisory_issues = 0

    content_dir = content_dir or CONTENT_DIR
    # 构建 arxivId -> title 映射
    title_map = {}
    for score, p, pa in scored_papers:
        title_map[p.get('arxivId', '')] = p.get('title', '')

    # Review 汇总页面（串行，只有1个）
    index_file = os.path.join(content_dir, f"{date_str}.md")
    if os.path.exists(index_file):
        print("\n  📋 汇总页面:")
        # 1. 代码检查
        fixed, issues = review_and_fix_post(index_file)
        if fixed:
            total_fixed += 1
            print(f"    🛠️  代码层自动修复")
            _, remaining_code_issues = review_and_fix_post(index_file)
        else:
            remaining_code_issues = issues
        total_blocking_issues += len(remaining_code_issues)
        for issue in issues:
            print(f"    ⚠️  代码层: {issue}")

        # 2. LLM 文本审查
        with open(index_file, 'r', encoding='utf-8') as f:
            content = f.read()
        llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, "汇总页面", required=require_llm)
        if llm_issues:
            for issue in llm_issues:
                sev = issue.get('severity', 'warning')
                desc = issue.get('description', '')
                print(f"    🤖 LLM ({sev}): {desc}")
            if llm_fixed_content != content:
                atomic_write_text(index_file, llm_fixed_content)
                total_fixed += 1
                print(f"    🛠️  LLM 自动修复已应用")
                llm_passed, llm_issues, _ = llm_review_post(llm_fixed_content, "汇总页面", required=require_llm)
            llm_blocking = count_blocking_review_issues(llm_issues)
            total_blocking_issues += llm_blocking
            total_advisory_issues += len(llm_issues) - llm_blocking

        if not remaining_code_issues and count_blocking_review_issues(llm_issues) == 0:
            if llm_issues:
                print(f"    ✅ 无阻断问题（保留 {len(llm_issues)} 个 warning/info）")
            else:
                print(f"    ✅ 通过 review")

    # Review 每篇论文独立页面（并发）
    paper_args = [
        (arxiv_id, slug, date_str, title_map.get(arxiv_id, slug), require_llm, content_dir)
        for arxiv_id, slug in paper_slugs.items()
    ]

    review_concurrency = min(get_blog_review_concurrency(), max(1, len(paper_args)))
    print(f"\n  🔀 论文页 review 并发度: {review_concurrency}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=review_concurrency) as executor:
        futures = [executor.submit(_review_single_paper, args) for args in paper_args]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if result is None:
                continue
            title, fixed_count, blocking_count, advisory_count, lines = result
            print(f"\n  📄 {title[:50]}...")
            for line in lines:
                print(line)
            total_fixed += fixed_count
            total_blocking_issues += blocking_count
            total_advisory_issues += advisory_count

    if total_fixed == 0 and total_blocking_issues == 0 and total_advisory_issues == 0:
        print("\n  ✅ 所有文件通过三层 review，无问题")
    else:
        print(f"\n  📊 review 结果: {total_fixed} 个文件已修复, {total_blocking_issues} 个阻断问题, {total_advisory_issues} 个 warning/info")

    return total_fixed, total_blocking_issues


def _load_frontmatter(path):
    try:
        import yaml
    except ImportError as exc:
        raise PublishDataValidationError('缺少 PyYAML，无法执行确定性 frontmatter 门禁') from exc

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in mapping:
                raise PublishDataValidationError(f'{path.name} frontmatter 存在重复字段: {key}')
            mapping[key] = loader.construct_object(value_node, deep=deep)
        return mapping

    UniqueKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
        construct_mapping,
    )
    content = path.read_text(encoding='utf-8')
    match = re.match(r'^---\n(.*?)\n---\n', content, flags=re.DOTALL)
    if not match:
        raise PublishDataValidationError(f'{path.name} 缺少合法 YAML frontmatter')
    try:
        frontmatter = yaml.load(match.group(1), Loader=UniqueKeyLoader)
    except (yaml.YAMLError, PublishDataValidationError) as exc:
        raise PublishDataValidationError(f'{path.name} YAML 解析失败: {exc}') from exc
    if not isinstance(frontmatter, dict):
        raise PublishDataValidationError(f'{path.name} frontmatter 必须是对象')
    return frontmatter, content[match.end():]


def validate_staged_posts(staged_posts_dir, date_str, date_only=False):
    """Deterministically validate YAML and generated Markdown structure."""
    date_str = validate_publish_date(date_str)
    staged = Path(staged_posts_dir)
    files = sorted(staged.glob(f'{date_str}*.md' if date_only else '*.md'))
    if not files:
        raise PublishDataValidationError('staging 目录没有待发布 Markdown 文件')
    for path in files:
        if path.name != f'{date_str}.md' and not path.name.startswith(f'{date_str}-'):
            raise PublishDataValidationError(f'发布文件名不属于本次日期: {path.name}')
        frontmatter, body = _load_frontmatter(path)
        for field in ('title', 'date', 'draft', 'tags', 'categories', 'description'):
            if field not in frontmatter:
                raise PublishDataValidationError(f'{path.name} 缺少 frontmatter.{field}')
        yaml_date = frontmatter['date']
        if hasattr(yaml_date, 'isoformat'):
            yaml_date = yaml_date.isoformat()
        if yaml_date != date_str:
            raise PublishDataValidationError(f'{path.name} frontmatter.date 与发布日期不一致')
        if frontmatter['draft'] is not False:
            raise PublishDataValidationError(f'{path.name} frontmatter.draft 必须为 false')
        if not isinstance(frontmatter['tags'], list) or not isinstance(frontmatter['categories'], list):
            raise PublishDataValidationError(f'{path.name} tags/categories 必须为 YAML 数组')
        if '\ufffd' in body:
            raise PublishDataValidationError(f'{path.name} 正文包含 UTF-8 替换字符')
        if re.search(r'!?\[[^\]]*\]\(\s*\)', body):
            raise PublishDataValidationError(f'{path.name} 正文包含空 Markdown 链接')
    return files


def run_hugo_gate(blog_repo, staged_posts_dir, required=False):
    """Build staged content with Hugo when available; structural gates always run."""
    hugo = shutil.which('hugo')
    if not hugo:
        if required:
            raise PublishDataValidationError('正式 --push 要求 Hugo 可用，当前未找到 hugo 命令')
        print('  ℹ️ Hugo 不可用，已执行严格 YAML/Markdown 回退门禁')
        return 'fallback'
    with tempfile.TemporaryDirectory(prefix='paper-digest-hugo-') as output_dir:
        result = subprocess.run(
            [
                hugo,
                '--contentDir', str(Path(staged_posts_dir).parent),
                '--destination', output_dir,
                '--cleanDestinationDir',
                '--noBuildLock',
            ],
            cwd=blog_repo,
            capture_output=True,
            text=True,
            env=build_child_process_env(),
        )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or '').strip()
        raise PublishDataValidationError(f'Hugo 构建门禁失败: {detail[-2000:]}')
    print('  ✅ Hugo staging 构建通过')
    return 'hugo'


def _is_pipeline_owned_paper(path, date_str):
    """Only explicit pipeline-owned paper pages are eligible for stale deletion."""
    try:
        frontmatter, _body = _load_frontmatter(path)
    except (OSError, UnicodeError, PublishDataValidationError):
        return False
    yaml_date = frontmatter.get('date')
    if hasattr(yaml_date, 'isoformat'):
        yaml_date = yaml_date.isoformat()
    return (
        frontmatter.get('paper_digest_pipeline_owned') is True
        and frontmatter.get('paper_digest_page_type') == 'paper'
        and yaml_date == date_str
    )


def planned_publish_paths(staged_posts_dir, content_dir, date_str):
    staged = Path(staged_posts_dir)
    target = Path(content_dir)
    generated_names = {path.name for path in staged.glob('*.md')}
    expected_index = f'{date_str}.md'
    if expected_index not in generated_names:
        raise PublishDataValidationError(f'staging 缺少汇总页 {expected_index}')
    changed = []
    for name in sorted(generated_names):
        source = staged / name
        destination = target / name
        if not destination.exists() or source.read_bytes() != destination.read_bytes():
            changed.append(destination)
    for old_page in sorted(target.glob(f'{date_str}-*.md')) if target.exists() else []:
        if old_page.name not in generated_names and _is_pipeline_owned_paper(old_page, date_str):
            changed.append(old_page)
    return changed


def publish_manifest_paths(staged_posts_dir, content_dir, date_str):
    """Return every generated path plus explicitly owned stale deletion candidate."""
    staged = Path(staged_posts_dir)
    target = Path(content_dir)
    generated_names = {path.name for path in staged.glob('*.md')}
    manifest = {target / name for name in generated_names}
    for old_page in sorted(target.glob(f'{date_str}-*.md')) if target.exists() else []:
        if old_page.name not in generated_names and _is_pipeline_owned_paper(old_page, date_str):
            manifest.add(old_page)
    return sorted(manifest)


def install_staged_posts(staged_posts_dir, content_dir, date_str):
    """Install the reviewed manifest atomically, rolling back on local failure."""
    staged = Path(staged_posts_dir)
    target = Path(content_dir)
    changes = planned_publish_paths(staged, target, date_str)
    snapshots = {path: path.read_bytes() if path.exists() else None for path in changes}
    generated = {path.name: path for path in staged.glob('*.md')}
    try:
        target.mkdir(parents=True, exist_ok=True)
        for name, source in sorted(generated.items()):
            destination = target / name
            if destination in snapshots:
                atomic_write_text(destination, source.read_text(encoding='utf-8'))
        for path, previous in snapshots.items():
            if path.name not in generated and previous is not None:
                path.unlink()
    except Exception:
        for path, previous in snapshots.items():
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write_text(path, previous.decode('utf-8'))
        raise
    return changes


def _git_relative_manifest(paths):
    repo = Path(BLOG_REPO).expanduser().resolve()
    allowed_root = (repo / 'content' / 'posts').resolve()
    relative = []
    for path in paths:
        resolved = Path(path).expanduser().resolve()
        try:
            resolved.relative_to(allowed_root)
            item = resolved.relative_to(repo).as_posix()
        except ValueError as exc:
            raise PublishDataValidationError(f'git 清单包含 content/posts 外路径: {path}') from exc
        relative.append(item)
    return sorted(set(relative))


def _git_env():
    return build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)


def validate_git_publish_branch():
    """Formal publication is only allowed from the blog repository's main branch."""
    branch = subprocess.run(
        ['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        env=_git_env(),
    )
    current = branch.stdout.strip() if branch.returncode == 0 else '<detached HEAD>'
    if current != 'main':
        raise PublishDataValidationError(
            f'正式发布要求博客仓库当前分支为 main，当前为 {current}'
        )
    head = subprocess.run(
        ['git', 'rev-parse', '--verify', 'HEAD'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        check=True,
        env=_git_env(),
    ).stdout.strip()
    if not re.fullmatch(r'[0-9a-fA-F]{40,64}', head):
        raise PublishDataValidationError(f'无法验证博客仓库 HEAD: {head!r}')
    return head.lower()


def validate_manifest_clean_against_head(paths):
    """Reject any pre-existing staged, unstaged, or untracked manifest edits."""
    manifest = _git_relative_manifest(paths)
    if not manifest:
        return
    result = subprocess.run(
        [
            'git', 'status', '--porcelain=v1', '-z', '--untracked-files=all',
            '--', *manifest,
        ],
        cwd=BLOG_REPO,
        capture_output=True,
        check=True,
        env=_git_env(),
    )
    if result.stdout:
        entries = [item.decode('utf-8', errors='replace') for item in result.stdout.split(b'\0') if item]
        raise PublishDataValidationError(
            '发布清单路径已有相对 HEAD 的人工 staged/unstaged/untracked 修改，拒绝覆盖或删除: '
            + ', '.join(entries)
        )


def capture_git_publish_state(paths):
    """Capture the pre-install Git/index/worktree state for add/commit rollback."""
    manifest = _git_relative_manifest(paths)
    head = validate_git_publish_branch()
    index_tree = subprocess.run(
        ['git', 'write-tree'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        check=True,
        env=_git_env(),
    ).stdout.strip()
    snapshots = {}
    repo = Path(BLOG_REPO).expanduser().resolve()
    for item in manifest:
        path = repo / item
        snapshots[path] = (
            {'content': path.read_bytes(), 'mode': path.stat().st_mode & 0o777}
            if path.exists() else None
        )
    return {
        'head': head,
        'index_tree': index_tree,
        'snapshots': snapshots,
    }


def restore_git_publish_state(state):
    """Restore HEAD (if needed), the complete index, and manifest worktree files."""
    if not state:
        return
    current = subprocess.run(
        ['git', 'rev-parse', '--verify', 'HEAD'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        check=True,
        env=_git_env(),
    ).stdout.strip().lower()
    original = state['head'].lower()
    if current != original:
        subprocess.run(
            ['git', 'update-ref', 'refs/heads/main', original, current],
            cwd=BLOG_REPO,
            check=True,
            env=_git_env(),
        )
    subprocess.run(
        ['git', 'read-tree', state['index_tree']],
        cwd=BLOG_REPO,
        check=True,
        env=_git_env(),
    )
    for path, snapshot in state['snapshots'].items():
        if snapshot is None:
            path.unlink(missing_ok=True)
        else:
            atomic_write_text(
                path,
                snapshot['content'].decode('utf-8'),
                mode=snapshot['mode'],
            )


def validate_git_index(paths):
    allowed = set(_git_relative_manifest(paths))
    result = subprocess.run(
        ['git', 'diff', '--cached', '--name-only', '-z'],
        cwd=BLOG_REPO,
        capture_output=True,
        check=True,
        env=_git_env(),
    )
    staged = {item.decode('utf-8') for item in result.stdout.split(b'\0') if item}
    unrelated = sorted(staged - allowed)
    if unrelated:
        raise PublishDataValidationError(
            f'博客仓库已有无关 staged 文件，拒绝提交: {", ".join(unrelated)}'
        )


def _remote_main_oid():
    result = subprocess.run(
        ['git', 'ls-remote', '--exit-code', GITHUB_REMOTE, 'refs/heads/main'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        env=_git_env(),
    )
    if result.returncode != 0:
        return None, (result.stderr or result.stdout or '').strip()
    first_line = (result.stdout or '').splitlines()[0] if result.stdout else ''
    oid = first_line.split(None, 1)[0].lower() if first_line else ''
    if not re.fullmatch(r'[0-9a-f]{40,64}', oid):
        return None, f'远端返回不可验证的 OID: {oid!r}'
    return oid, ''


def _report_push_retry(local_head, detail):
    print(f'  ❌ Push/远端验证失败，本地提交 {local_head} 已保留，远端发布尚未确认')
    if detail:
        print(f'  原因: {detail}')
    print(f'  可重试: git -C {BLOG_REPO} push {GITHUB_REMOTE} HEAD:main')
    print(f'  可验证: git -C {BLOG_REPO} ls-remote {GITHUB_REMOTE} refs/heads/main')
    print(f'  预期远端 OID: {local_head}')


def git_push(date_str, publish_paths, rollback_state=None):
    """Commit, push HEAD explicitly to main, and verify the remote object ID."""
    manifest = _git_relative_manifest(publish_paths)
    state = rollback_state
    try:
        validate_git_publish_branch()
        validate_git_index(publish_paths)
        if state is None:
            state = capture_git_publish_state(publish_paths)
        if manifest:
            subprocess.run(
                ['git', 'add', '--', *manifest],
                check=True,
                cwd=BLOG_REPO,
                env=_git_env(),
            )
            validate_git_index(publish_paths)
        staged = subprocess.run(
            ['git', 'diff', '--cached', '--quiet', '--', *manifest],
            cwd=BLOG_REPO,
            env=_git_env(),
        ) if manifest else None
        if staged is not None and staged.returncode == 1:
            subprocess.run(
                [
                    'git', 'commit',
                    '-m', f'content: 发布 {date_str} 论文速递并同步评分与审查结果',
                    '-m', '提交已通过严格 LLM、多模态图片与 Hugo gate 的生成清单；'
                          '推送前已逐文件校验审查凭证 SHA-256，本步不重新生成或 review。',
                ],
                check=True, cwd=BLOG_REPO,
                env=_git_env()
            )
        elif staged is not None and staged.returncode > 1:
            raise subprocess.CalledProcessError(staged.returncode, staged.args)
        else:
            print("  ℹ️ 本次清单没有新内容，继续推送已有未同步提交")
        local_head = validate_git_publish_branch()
    except (subprocess.CalledProcessError, PublishDataValidationError, OSError, UnicodeError) as exc:
        try:
            restore_git_publish_state(state)
            print(f"  ❌ Git add/commit 失败，已恢复发布前 index 与工作树: {exc}")
        except Exception as restore_exc:
            print(f"  ❌ Git add/commit 失败，且自动恢复失败: {exc}; 恢复错误: {restore_exc}")
        return False

    result = subprocess.run(
        ['git', 'push', GITHUB_REMOTE, 'HEAD:main'],
        capture_output=True, text=True, cwd=BLOG_REPO,
        env=_git_env(),
    )
    remote_oid, verify_error = _remote_main_oid()
    if remote_oid == local_head:
        if result.returncode != 0:
            print('  ℹ️ git push 返回非零，但远端 main 已与本地 HEAD 一致，以 OID 验证结果为准')
        print(f"  ✅ 已推送并验证远端 main={remote_oid}，自动部署中...")
        blog_url = os.environ.get('PAPER_DIGEST_BLOG_URL', 'https://nanless.github.io/audio-paper-digest-blog/posts')
        if blog_url:
            print(f"  🌐 {blog_url}/{date_str}/")
        return True

    detail = verify_error
    push_detail = (result.stderr or result.stdout or '').strip()
    if push_detail:
        detail = f'{push_detail}; {detail}' if detail else push_detail
    elif remote_oid:
        detail = f'远端 main={remote_oid}，与本地 HEAD 不一致'
    _report_push_retry(local_head, detail)
    return False


def review_receipt_path(date_str):
    return CURRENT_DIR / f'blog-review-receipt-{validate_publish_date(date_str)}.json'


def generation_manifest_path(date_str):
    return CURRENT_DIR / f'blog-generation-manifest-{validate_publish_date(date_str)}.json'


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_record(path, repo):
    path = Path(path).expanduser().resolve()
    try:
        relative = path.relative_to(repo)
    except ValueError as exc:
        raise PublishDataValidationError(f'博客清单路径逃逸仓库: {path}') from exc
    if relative.parts[:2] != ('content', 'posts'):
        raise PublishDataValidationError(f'博客清单只允许 content/posts 路径: {relative}')
    return path, relative.as_posix()


def save_generation_manifest(date_str, publish_paths):
    """Save the exact generated/removed path list for the separate review step."""
    repo = Path(BLOG_REPO).expanduser().resolve()
    records = []
    for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
        path, relative = _manifest_record(item, repo)
        records.append({'path': relative, 'deleted': not path.is_file()})
    manifest = {
        'schemaVersion': 1,
        'date': validate_publish_date(date_str),
        'generatedAt': datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat(),
        'files': records,
    }
    path = generation_manifest_path(date_str)
    atomic_write_json(path, manifest, ensure_ascii=False, indent=2)
    return path


def load_generation_manifest(date_str):
    """Load and constrain the generation manifest without performing review."""
    manifest_path = generation_manifest_path(date_str)
    if not manifest_path.is_file():
        raise PublishDataValidationError(
            f'缺少生成清单: {manifest_path}；请先运行 generate-blog.py'
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'生成清单无法解析: {manifest_path}') from exc
    if manifest.get('schemaVersion') != 1 or manifest.get('date') != date_str:
        raise PublishDataValidationError('生成清单版本或日期不匹配')
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单中没有文件')
    repo = Path(BLOG_REPO).expanduser().resolve()
    paths = []
    seen = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('path'), str):
            raise PublishDataValidationError('生成清单文件记录格式非法')
        relative = Path(record['path'])
        if relative.is_absolute():
            raise PublishDataValidationError(f'生成清单包含绝对路径: {relative}')
        target = (repo / relative).resolve()
        _target, normalized = _manifest_record(target, repo)
        if normalized in seen:
            raise PublishDataValidationError(f'生成清单包含重复路径: {normalized}')
        seen.add(normalized)
        if record.get('deleted') is True:
            if target.exists():
                raise PublishDataValidationError(f'生成清单标记删除但文件仍存在: {normalized}')
        elif not target.is_file():
            raise PublishDataValidationError(f'生成文件缺失: {normalized}')
        paths.append(target)
    return paths, manifest_path


def save_review_receipt(date_str, publish_paths, hugo_gate):
    """Persist the exact reviewed blog manifest for a later push-only command."""
    repo = Path(BLOG_REPO).expanduser().resolve()
    files = []
    for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
        path, relative = _manifest_record(item, repo)
        exists = path.is_file()
        files.append({
            'path': relative,
            'deleted': not exists,
            'sha256': _sha256_file(path) if exists else None,
        })
    receipt = {
        'schemaVersion': 1,
        'date': validate_publish_date(date_str),
        'reviewedAt': datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat(),
        'strictReview': True,
        'hugoGate': hugo_gate,
        'files': files,
    }
    path = review_receipt_path(date_str)
    atomic_write_json(path, receipt, ensure_ascii=False, indent=2)
    return path


def load_verified_review_receipt(date_str):
    """Load a strict review receipt and verify every current blog file hash."""
    path = review_receipt_path(date_str)
    if not path.is_file():
        raise PublishDataValidationError(
            f'缺少已通过审查的发布凭证: {path}；请先不带 --push 运行 review'
        )
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'审查凭证无法解析: {path}') from exc
    if receipt.get('schemaVersion') != 1 or receipt.get('date') != date_str:
        raise PublishDataValidationError('审查凭证版本或日期不匹配')
    if receipt.get('strictReview') is not True:
        raise PublishDataValidationError('审查凭证不是严格 review 结果')
    if receipt.get('hugoGate') != 'hugo':
        raise PublishDataValidationError('审查凭证未通过 Hugo staging gate')
    records = receipt.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('审查凭证没有发布文件清单')

    repo = Path(BLOG_REPO).expanduser().resolve()
    paths = []
    seen = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('path'), str):
            raise PublishDataValidationError('审查凭证文件记录格式非法')
        relative = Path(record['path'])
        if relative.is_absolute() or relative.parts[:2] != ('content', 'posts'):
            raise PublishDataValidationError(f'审查凭证包含非法路径: {relative}')
        target = (repo / relative).resolve()
        try:
            target.relative_to(repo / 'content' / 'posts')
        except ValueError as exc:
            raise PublishDataValidationError(f'审查凭证路径逃逸 content/posts: {relative}') from exc
        key = relative.as_posix()
        if key in seen:
            raise PublishDataValidationError(f'审查凭证包含重复路径: {key}')
        seen.add(key)
        if record.get('deleted') is True:
            if target.exists():
                raise PublishDataValidationError(f'review 后应删除的文件重新出现: {key}')
        else:
            expected = record.get('sha256')
            if not target.is_file() or not re.fullmatch(r'[0-9a-f]{64}', str(expected or '')):
                raise PublishDataValidationError(f'已审查文件缺失或哈希非法: {key}')
            actual = _sha256_file(target)
            if actual != expected:
                raise PublishDataValidationError(f'文件在 review 后已变更，拒绝推送: {key}')
        paths.append(target)
    return paths, path


def generate_main():
    data_file = None
    target_date = None
    category = '论文速递'
    publish_all = False

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--skip-push':
            pass
        elif arg == '--push':
            print('❌ 生成、review 和推送已分离；请依次使用 generate-blog.py、review-blog.py、push-blog.py')
            sys.exit(2)
        elif arg == '--all':
            publish_all = True
        elif arg == '--date' and i + 1 < len(sys.argv):
            target_date = sys.argv[i + 1]
            i += 1
        elif arg == '--category' and i + 1 < len(sys.argv):
            category = sys.argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            data_file = arg
        i += 1

    try:
        blog_repo, content_dir = validate_publish_target()
        today = validate_publish_date(get_today_bj(target_date))
    except PublishDataValidationError as exc:
        print(f"\n❌ 发布目标校验失败: {exc}")
        sys.exit(1)
    papers = load_papers(data_file)
    print(f"📅 博客日期: {today}")

    # 只发布 fetchedAt 日期等于目标日期的论文（按抓取日期而非 arXiv 发布日期）
    if not publish_all:
        filtered_papers = []
        for p in papers:
            fa = p.get('fetchedAt', '')
            if fa and isinstance(fa, str):
                fa_date = fa[:10]
                if fa_date == today:
                    filtered_papers.append(p)
        papers = filtered_papers
    else:
        print("📦 --all: 跳过 fetchedAt 日期过滤，发布输入文件中的全部论文")
    filter_note = '全部论文' if publish_all else f'fetchedAt={today}'
    print(f"📄 过滤后: {len(papers)} 篇论文 ({filter_note})")

    if not papers:
        print("⚠️ 没有论文需要发布")
        return

    try:
        papers = validate_papers_for_publish(papers)
    except PublishDataValidationError as exc:
        print(f"\n❌ 发布数据预检失败，未生成任何博客文件：\n{exc}")
        sys.exit(1)
    scored, unscored = score_and_sort(papers)
    print(f"✅ 发布数据预检通过: {len(papers)} 篇论文以 analysis 重解析结果为发布基线")

    publish_paths = []
    try:
        with tempfile.TemporaryDirectory(prefix='paper-digest-publish-') as transaction_dir:
            staged_posts = Path(transaction_dir) / 'content' / 'posts'
            staged_posts.mkdir(parents=True)

            paper_slugs = {}
            for paper in papers:
                paper_md, slug = generate_paper_page(paper, today, category)
                paper_md = sanitize_markdown_for_publish(paper_md)
                paper_file = staged_posts / f"{today}-{slug}.md"
                if paper_file.exists():
                    raise PublishDataValidationError(
                        f'重复论文会覆盖同一 staging 文件: {paper_file.name}'
                    )
                atomic_write_text(paper_file, paper_md)
                paper_slugs[paper.get('arxivId', '')] = slug

            print(f"📄 staging 生成 {len(paper_slugs)} 篇论文独立页面")
            index_md = generate_index_page(scored, unscored, today, paper_slugs, category)
            index_md = sanitize_markdown_for_publish(index_md)
            index_file = staged_posts / f"{today}.md"
            atomic_write_text(index_file, index_md)
            print(f"📄 staging 汇总页面: {index_file.name} ({len(index_md)} chars)")

            validate_staged_posts(staged_posts, today)
            publish_paths = install_staged_posts(staged_posts, content_dir, today)
    except PublishDataValidationError as exc:
        print(f"\n❌ 生成事务已阻断，博客工作树未写入本次 staging 内容: {exc}")
        sys.exit(1)
    except (subprocess.CalledProcessError, OSError) as exc:
        print(f"\n❌ 生成事务失败，博客工作树未写入本次 staging 内容: {exc}")
        sys.exit(1)

    deleted_count = sum(1 for path in publish_paths if not Path(path).exists())
    print(f"📦 已安装本次清单: {len(publish_paths) - deleted_count} 个更新，{deleted_count} 个旧页删除")
    manifest_path = save_generation_manifest(today, publish_paths)
    print(f"🧾 生成清单: {manifest_path}")
    print(f"\n✅ 博客文件生成完成；下一步: python3 scripts/review-blog.py --date {today}")


def main():
    """Compatibility generation entry point; review and push live in separate scripts."""
    return generate_main()


if __name__ == '__main__':
    main()

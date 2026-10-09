"""对 HTML 与已部署 URL 做机械检查，不涉及语义或视觉判断。

导入本模块不会读取 .env、访问外部服务，也不会写运行时文件。
"""

import hashlib
import html
import io
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlparse

GATE_CONTRACT = 'conference-publication-mechanical-gate-v1'
MAX_BYTES = 16 * 1024 * 1024
FETCH_TRANSPORT_ATTEMPTS = 6

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('conference_publication_gate.py')
    raise SystemExit('此模块只供会议发布器调用；请运行 publish-conference.py status/verify')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def public_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password \
            or parsed.port not in (None, 443) or parsed.fragment \
            or any(ord(char) < 33 for char in url):
        raise ValueError('验收 URL 必须是无凭据的 HTTPS URL')
    return url


class Page(HTMLParser):
    """跟踪配平的 post-content 子树，嵌套 div 一并算在内。"""
    VOID = {'img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'embed', 'param', 'col'}

    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.depth = None
        self.bodies = 0
        self.canonicals = []
        self.images = []
        self.tables = []
        self.cell = None
        self.text = []
        self.body_html = []
        self.math_runtime = False
        self.feed(source)
        self.close()
        if self.bodies != 1 or self.depth is not None:
            raise ValueError('HTML 必须含唯一闭合 post-content 正文')

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'link' and 'canonical' in attrs.get('rel', '').split():
            self.canonicals.append(attrs.get('href', ''))
        if tag == 'script' and re.search(r'mathjax|katex', attrs.get('src', ''), re.I):
            self.math_runtime = True
        if 'post-content' in attrs.get('class', '').split():
            self.bodies += 1
            self.depth = len(self.stack)
        if self.depth is not None:
            self.body_html.append(self.get_starttag_text())
            if tag == 'img':
                self.images.append(attrs.get('src', ''))
            if tag == 'table':
                self.tables.append([])
            if tag in {'th', 'td'}:
                self.cell = []
            if 'katex-error' in attrs.get('class', '').split() or tag == 'merror':
                raise ValueError(f"HTML 数学渲染包含错误：{tag}，class={attrs.get('class', '')!r}")
        if tag not in self.VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if not self.stack or self.stack[-1] != tag:
            raise ValueError(f'HTML 标签嵌套不闭合：遇到 </{tag}>，当前栈顶为 {self.stack[-1] if self.stack else None}')
        if self.depth is not None:
            self.body_html.append(f'</{tag}>')
        if self.depth is not None and tag in {'th', 'td'} and self.cell is not None:
            if not self.tables:
                raise ValueError(f'表格单元格缺少 table：遇到 <{tag}> 时还没有 table')
            self.tables[-1].append(''.join(self.cell).strip())
            self.cell = None
        self.stack.pop()
        if self.depth == len(self.stack):
            self.depth = None

    def handle_data(self, data):
        if self.depth is not None and not any(tag in {'script', 'style'} for tag in self.stack):
            self.text.append(data)
            self.body_html.append(html.escape(data, quote=False))
            if self.cell is not None:
                self.cell.append(data)

    def visible_content_fields(self):
        # 浏览器或压缩工具调整空白，不影响已审内容。
        return {'text': re.sub(r'\s+', '', ''.join(self.text)), 'images': self.images,
                'tables': [[re.sub(r'\s+', '', cell) for cell in table] for table in self.tables]}


def markdown_tables(body):
    lines = body.splitlines()
    tables = []
    index = 0
    separator = re.compile(r'\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*')
    while index < len(lines):
        line = lines[index]
        if index == 0 or not re.fullmatch(separator, line) \
                or not lines[index - 1].strip().startswith('|'):
            index += 1
            continue
        # 找到表头与分隔行之后，把整段连续的竖线行一起读进来。解读稿里
        # 可能在本表首尾放一整行全横线，那是表内数据，不是另一张表的分隔行。
        rows = [lines[index - 1]]
        cursor = index + 1
        while cursor < len(lines) and lines[cursor].strip().startswith('|'):
            rows.append(lines[cursor])
            cursor += 1
        tables.append([cell.strip() for row in rows
                       for cell in re.split(r'(?<!\\)\|', row.strip().strip('|'))])
        index = cursor
    return tables


def mask_markdown_image_alts(text):
    r"""在数学与格式扫描前遮住图片标签里的字节。

    图注里可能出现 ``f\[k\]`` 这类像 TeX 的字面量。它们必须保持转义，
    Markdown 才能正确解析图片；但正文里并没有这些公式，Hugo 也不会把
    这段文字渲染成 post-content 文本节点。
    """
    image = re.compile(r'!\[([^\n]*?)\]\(([^)\n]+)\)')
    return image.sub(lambda match: f'![]({match.group(2)})', str(text))


def mask_rendered_currency_dollars(text):
    """遮住转义 Markdown 渲染出来的金额符号。

    Goldmark 把 ``\\$32`` 渲染成可见文本 ``$32``。会议正文里出现这种金额
    是正常的，所以渲染后的检查要沿用 Markdown 的转义决定，不能见到美元符号
    就当成 TeX。``$5+2$``、``$5x`` 这类像公式的写法不遮，仍由共用的定界符
    检查判失败。
    """
    # 只匹配单独金额或金额区间；美元符号后面跟数学运算符或另一个美元符号的，
    # 不在此列。
    standalone = re.compile(
        r'(?<![\\$A-Za-z0-9_])\$(?=\s*[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)'
        r'(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?'
        r'(?![A-Za-z0-9_.])(?!(?:\s*[+*/^=\$])))'
    )
    return standalone.sub('CURRENCY_DOLLAR', str(text))


def inspect_html(markdown, rendered, image_records, image_base):
    from markdown_hugo_gate import math_and_emphasis_issues, mask_rendered_symbolic_table_cells

    page = Page(rendered)
    if len(page.canonicals) != 1:
        raise ValueError(f'HTML canonical URL 不唯一：实际 {len(page.canonicals)} 个')
    url = public_url(page.canonicals[0])
    body = markdown.split('---', 2)[-1] if markdown.startswith('---\n') else markdown
    body_for_format = mask_markdown_image_alts(body)
    # 走共用的确定性数学检查，这里不会真正执行 MathJax。
    text = ''.join(page.text)
    issues = math_and_emphasis_issues(body_for_format, 'Markdown')
    # 用可见文本核对 TeX 是否保留；表内字面量交给共用的 HTML 遮罩处理。
    rendered_body = mask_rendered_symbolic_table_cells(''.join(page.body_html))
    rendered_body = mask_rendered_currency_dollars(rendered_body)
    issues += math_and_emphasis_issues(rendered_body,
                                      'HTML', rendered_html=True)
    if issues:
        raise ValueError('; '.join(issues))
    formulas = re.findall(r'\\\[(.*?)\\\]|\\\((.*?)\\\)', body_for_format, re.S)
    for display, inline in formulas:
        formula = re.sub(r'\s+', '', html.unescape(display or inline))
        if formula not in re.sub(r'\s+', '', text):
            raise ValueError(f'HTML 公式内容丢失/被 Markdown 改写：{formula}')
    if formulas and not page.math_runtime:
        raise ValueError('HTML 公式缺少数学渲染运行时；仅完成静态检查')
    # 图的替代文本里可能有转义的 Markdown 方括号，例如 ``\[b\]``。
    # 别把转义的右括号当成替代文本的结尾。
    expected = re.findall(r'!\[[^\n]*?\]\(([^)\s]+)(?:\s+[^)]*)?\)', body)
    if page.images != expected:
        raise ValueError(f'HTML 图片 URL/顺序与 Markdown 不一致：Markdown 期望 {expected}，HTML 实际 {page.images}')
    assets = {f'{image_base}/{r["path"]}': r for r in image_records}
    for image in page.images:
        public_url(image)
        if image not in assets:
            raise ValueError(f'HTML 图片未绑定已封存图床资产：{image}')
    tables = markdown_tables(body)
    if len(tables) != len(page.tables):
        raise ValueError(f'HTML 表格数量与 Markdown 不一致：Markdown 为 {len(tables)} 张，HTML 为 {len(page.tables)} 张')
    for expected_cells, cells in zip(tables, page.tables):
        if len(expected_cells) != len(cells):
            raise ValueError(f'HTML 表格单元格数量不一致：Markdown 为 {len(expected_cells)} 个，HTML 为 {len(cells)} 个')
        for source, actual in zip(expected_cells, cells):
            # 核对数字与单位是否留在对应单元格。这里有意忽略格式标记，
            # 不把它当作语义审查。链接目标不算可见的单元格内容，
            # 若把其中像年份、编号的数字也抽出来，只会造成误报。
            visible_source = re.sub(
                r'\[((?:\\.|[^\\\]])*)\]\([^)]*\)', r'\1', source,
            )
            # Goldmark 会把转义标点渲染成标点本身。抽数字前先把转义的小数点
            # 还原，否则 `5\.1` 会被误判成单独的测量值 `5`，而 HTML 单元格里
            # 其实是 `5.1`。
            visible_source = visible_source.replace(r'\.', '.')
            # 同理，标题或区间里转义的连字符就是标点本身。保留成 ``8-10``，
            # 免得第二个数字被当成负的测量值。
            visible_source = visible_source.replace(r'\-', '-')
            # 汇总页标签把括号写成 HTML 实体，避免被当成 TeX 定界符。抽数字前
            # 先解实体，否则 ``&#40;`` 与 ``&#41;`` 会凭空多出 40、41 两个测量值。
            visible_source = html.unescape(visible_source)
            # Qwen3-8B 这类标识符里的连字符不是负号。要求符号出现在字母数字
            # 记号之外，同时保留单元格边界或空白之后真正的 -0.5、+2% 数值。
            # `2023.acl-long.23` 这类标识符的数字前缀不算测量值。旧写法会抽出
            # `2023`，又因为后面的 `.acl` 被当作记号边界而判它失败。小数
            # （例如 `0.7173`）仍然照抽。
            # Goldmark 会把 `00:06--00:24` 这样的 Markdown 时间区间渲染成短破折号。
            # 先把等价的源写法归一化，第二个时间戳才不会被读成负数。
            visible_source = re.sub(
                r'(?<!\d)(\d{1,2}:\d{2})--(?=\d{1,2}:\d{2}(?!\d))',
                r'\1–',
                visible_source,
            )
            # Unicode 字母也算标识符字符。否则 ``λ1*Lalign`` 这样的损失项名在
            # Markdown 里会多出数字记号 ``1``，而 Goldmark 输出的 HTML 是
            # ``λ1Lalign``。
            quantity_pattern = re.compile(r'(?<![^\W_.])(?<!\.)(?!(?:[-+]?\d+)(?:\.\d+){2,}(?![A-Za-z\d.]))[-+]?\d+(?:\.\d+)?(?:%|[A-Za-z]+)?(?![^\W_.])(?!\.)')
            tokens = quantity_pattern.findall(visible_source.replace('−', '-'))
            actual_tokens = quantity_pattern.findall(actual.replace('−', '-'))
            # 两边按同一规则取完整量值，不能从负数中截出正数；区间与标识符沿用原规则。
            if any(token not in actual_tokens for token in tokens):
                raise ValueError(f'HTML 表格数字/单位未在对应单元格保留：Markdown 期望数字 {tokens}，HTML 单元格实际为 {actual!r}')
    visible_content = page.visible_content_fields()
    return {'url': url, 'htmlSha256': digest(rendered.encode()),
            'projectionSha256': digest(json.dumps(visible_content, ensure_ascii=False, sort_keys=True).encode()),
            'imageUrls': page.images, 'tableCount': len(page.tables), 'formulaCount': len(formulas),
            'layers': {'htmlMechanical': 'passed', 'semanticReview': 'not_performed',
                       'visualInspection': 'not_performed', 'mathBrowserExecution': 'not_performed'}}


@lru_cache(maxsize=1)
def safe_transport():
    # 复用发布器那套 SSRF/DNS/CONNECT 对端校验，不用 urllib 自带的代理处理，
    # 也不另做一次未校验的 DNS 解析。
    from blog_entry_loader import load_publish_to_blog
    return load_publish_to_blog()


def fetch_public(url):
    import urllib3
    from project_env import get_required_fetch_proxy

    shared = safe_transport()
    proxy = get_required_fetch_proxy()
    proxy_addresses = shared._resolve_proxy_addresses(proxy)
    deadline = time.monotonic() + 60
    current = public_url(url)
    for _ in range(4):
        addresses = shared._validate_public_image_url(current)
        parsed = urlparse(current)
        redirected = False
        for transport_attempt in range(FETCH_TRANSPORT_ATTEMPTS):
            pinned = shared._pinned_https_url(parsed, sorted(addresses)[0])
            manager = urllib3.ProxyManager(proxy, cert_reqs='CERT_REQUIRED',
                                           assert_hostname=parsed.hostname, server_hostname=parsed.hostname,
                                           retries=False)
            response = None
            try:
                remaining = shared._remaining_deadline_seconds(deadline, '会议 URL 验收')
                response = manager.request('GET', pinned, headers={'Host': parsed.netloc},
                                           redirect=False, preload_content=False, retries=False,
                                           timeout=urllib3.Timeout(connect=min(15, remaining), read=min(15, remaining)))
                shared._validate_response_peer_with_transport(response, addresses, proxy_addresses)
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get('Location')
                    if not location:
                        raise ValueError('URL 重定向缺少 Location')
                    current = public_url(urljoin(current, location))
                    redirected = True
                    break
                if response.status != 200:
                    raise ValueError(f'URL 验收 HTTP {response.status}（期望 200）')
                chunks, size = [], 0
                while True:
                    shared._remaining_deadline_seconds(deadline, '会议 URL 验收')
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError(f'URL 验收响应过大：已读取 {size} 字节，上限 {MAX_BYTES}')
                    chunks.append(chunk)
                return {'url': current, 'body': b''.join(chunks),
                        'contentType': response.headers.get('Content-Type', '').split(';')[0].lower()}
            except (urllib3.exceptions.HTTPError, OSError):
                # GitHub 的 raw 节点偶尔会重置 CONNECT 隧道或关掉 TLS 连接，
                # 而对象本身完全正常。只重试传输层失败，且不超出该 URL 原有的
                # 绝对截止时间；HTTP 状态、摘要、重定向和 HTML 错误一律直接判失败。
                if transport_attempt >= FETCH_TRANSPORT_ATTEMPTS - 1:
                    raise
                remaining = shared._remaining_deadline_seconds(deadline, '会议 URL 验收')
                time.sleep(min(0.5 * (2 ** transport_attempt), max(0.0, remaining - 0.01)))
            finally:
                if response is not None:
                    response.close()
                    response.release_conn()
                manager.clear()
        if redirected:
            continue
    raise ValueError('URL 重定向次数过多')


def verify_publication_urls(pages, image_records, image_base):
    # 会议批次可能有几百个页面、几千张不变的 PNG。传输层校验仍留在
    # fetch_public()，这里只用一个小规模有界线程池发独立 GET。
    # executor.map 保持输入顺序，验收记录里的字节顺序因此是确定的。
    try:
        concurrency = int(os.environ.get(
            'PD_CONFERENCE_ONLINE_VERIFY_CONCURRENCY', '4'))
    except ValueError:
        raise ValueError(f"会议线上验收并发必须是整数：实际 {os.environ.get('PD_CONFERENCE_ONLINE_VERIFY_CONCURRENCY', '')!r}") from None
    if not 1 <= concurrency <= 16:
        raise ValueError(f'会议线上验收并发必须在 1–16 之间：实际 {concurrency}')

    def page_check(expected):
        result = fetch_public(expected['url'])
        if result['contentType'] != 'text/html' or result['url'] != expected['url']:
            raise ValueError(f'线上页面类型/最终 URL 不匹配：实际 {result["url"]}（{result["contentType"]}），期望 {expected["url"]}（text/html）')
        page = Page(result['body'].decode('utf-8'))
        visible_content_sha256 = digest(json.dumps(page.visible_content_fields(), ensure_ascii=False, sort_keys=True).encode())
        if visible_content_sha256 != expected['projectionSha256'] or page.canonicals != [expected['url']] \
                or (expected['formulaCount'] and not page.math_runtime):
            raise ValueError(f'线上正文/图片/表格/公式未匹配已审 HTML：已审摘要 {expected["projectionSha256"]}，线上摘要 {visible_content_sha256}')

        return {'url': expected['url'], 'sha256': digest(result['body'])}

    def image_check(record):
        url = public_url(f'{image_base}/{record["path"]}')
        result = fetch_public(url)
        if result['contentType'] != 'image/png' or digest(result['body']) != record['sourceSha256']:
            raise ValueError(f'线上图片 MIME/实际字节与封存资产不一致：MIME 实际 {result["contentType"]}、'
                             f'期望 image/png；字节 SHA 实际 {digest(result["body"])}、期望 {record["sourceSha256"]}')
        validate_png(result['body'])
        return {'url': url, 'finalUrl': result['url'], 'sha256': digest(result['body'])}

    with ThreadPoolExecutor(max_workers=concurrency,
                            thread_name_prefix='conference-online-verify') as pool:
        page_checks = list(pool.map(page_check, pages))
        image_checks = list(pool.map(image_check, image_records))
    checks = page_checks + image_checks
    return {'status': 'passed', 'contract': GATE_CONTRACT, 'checks': checks,
            'semanticReview': 'not_performed', 'visualInspection': 'not_performed'}


def validate_png(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        if image.format != 'PNG' or image.width <= 0 or image.height <= 0:
            raise ValueError(f'图片不是可解码 PNG：format={image.format!r}，{image.width}x{image.height}')
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()

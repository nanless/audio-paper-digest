"""Mechanical HTML and deployed-URL checks, never semantic or visual attestation.

Imports do not load .env, contact a provider, or write runtime files.
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
    """Track the balanced post-content subtree, including nested divs."""
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
                raise ValueError('HTML 数学渲染包含错误')
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
            raise ValueError('HTML 标签嵌套不闭合')
        if self.depth is not None:
            self.body_html.append(f'</{tag}>')
        if self.depth is not None and tag in {'th', 'td'} and self.cell is not None:
            if not self.tables:
                raise ValueError('表格单元格缺少 table')
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

    def projection(self):
        # Browser/minifier whitespace does not alter the approved content.
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
        # Once a header/separator pair is found, consume the complete
        # contiguous pipe block. A Reader projection may contain an explicit
        # all-dash row at either the beginning or end of the block; it is data
        # in this table, not another table separator.
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
    """Hide image-label bytes from the math/format scan.

    Figure captions may contain TeX-looking literals such as ``f\[k\]``.
    They must stay escaped so Markdown parses the image correctly, but they
    are not formulas in the article body and their text is not emitted as a
    post-content text node by Hugo.
    """
    image = re.compile(r'!\[([^\n]*?)\]\(([^)\n]+)\)')
    return image.sub(lambda match: f'![]({match.group(2)})', str(text))


def mask_rendered_currency_dollars(text):
    """Mask literal numeric currency markers emitted from escaped Markdown.

    Goldmark renders ``\\$32`` as the visible text ``$32``.  Conference
    prose may legitimately contain such amounts, so the rendered gate must
    preserve the Markdown escape decision instead of treating every visible
    dollar as TeX.  Math-like forms such as ``$5+2$`` and ``$5x`` remain
    unmasked and therefore still fail the shared delimiter check.
    """
    # Match standalone/range amounts, keeping a dollar before a mathematical
    # operator or another dollar outside the waiver.
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
        raise ValueError('HTML canonical URL 不唯一')
    url = public_url(page.canonicals[0])
    body = markdown.split('---', 2)[-1] if markdown.startswith('---\n') else markdown
    body_for_format = mask_markdown_image_alts(body)
    # Shared deterministic math validation; this does not execute MathJax.
    text = ''.join(page.text)
    issues = math_and_emphasis_issues(body_for_format, 'Markdown')
    # Use visible text for TeX preservation; shared HTML mask handles literal cells.
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
            raise ValueError('HTML 公式内容丢失/被 Markdown 改写')
    if formulas and not page.math_runtime:
        raise ValueError('HTML 公式缺少数学渲染运行时；仅完成静态检查')
    # A figure alt-text may contain escaped Markdown brackets, e.g. ``\[b\]``.
    # Do not mistake the escaped closing bracket for the end of the alt-text.
    expected = re.findall(r'!\[[^\n]*?\]\(([^)\s]+)(?:\s+[^)]*)?\)', body)
    if page.images != expected:
        raise ValueError('HTML 图片 URL/顺序与 Markdown 不一致')
    assets = {f'{image_base}/{r["path"]}': r for r in image_records}
    for image in page.images:
        public_url(image)
        if image not in assets:
            raise ValueError('HTML 图片未绑定已封存图床资产')
    tables = markdown_tables(body)
    if len(tables) != len(page.tables):
        raise ValueError('HTML 表格数量与 Markdown 不一致')
    for expected_cells, cells in zip(tables, page.tables):
        if len(expected_cells) != len(cells):
            raise ValueError('HTML 表格单元格数量不一致')
        for source, actual in zip(expected_cells, cells):
            # Verify numbers/units remain in the corresponding cell. Formatting
            # markup is deliberately ignored, not mistaken for semantic review.
            # Link destinations are not visible table-cell content; extracting
            # their numeric-looking year/slug tokens would create false failures.
            visible_source = re.sub(
                r'\[((?:\\.|[^\\\]])*)\]\([^)]*\)', r'\1', source,
            )
            # Goldmark renders an escaped punctuation mark as the literal
            # punctuation.  Normalize an escaped decimal point before token
            # extraction; otherwise `5\.1` is incorrectly scanned as the
            # standalone measurement `5`, while the HTML cell contains `5.1`.
            visible_source = visible_source.replace(r'\.', '.')
            # Likewise, an escaped hyphen in a title/range is literal
            # punctuation. Keep it as ``8-10`` so the second number is not
            # misclassified as a negative measurement.
            visible_source = visible_source.replace(r'\-', '-')
            # Aggregate labels encode literal parentheses as HTML entities so
            # they cannot be mistaken for TeX delimiters. Decode entities
            # before extracting numeric tokens; otherwise ``&#40;`` and
            # ``&#41;`` would introduce phantom measurements 40 and 41.
            visible_source = html.unescape(visible_source)
            # A hyphen inside an identifier such as Qwen3-8B is not a
            # negative numeric sign.  Require a sign to start outside an
            # alphanumeric token, while still preserving genuine -0.5/ +2%
            # values at cell boundaries or after whitespace.
            # Do not treat the numeric prefix of an identifier such as
            # `2023.acl-long.23` as a measurement. The previous expression
            # extracted `2023` and then rejected it because the following
            # `.acl` was intentionally considered a token boundary. A
            # decimal value (for example `0.7173`) is still extracted.
            # Goldmark renders a Markdown time range such as `00:06--00:24`
            # with an en dash. Normalize that equivalent source spelling so
            # the second timestamp is not misread as a negative number.
            visible_source = re.sub(
                r'(?<!\d)(\d{1,2}:\d{2})--(?=\d{1,2}:\d{2}(?!\d))',
                r'\1–',
                visible_source,
            )
            # Treat Unicode letters as identifier characters too.  Otherwise
            # a loss name such as ``λ1*Lalign`` yields a phantom numeric token
            # ``1`` in Markdown, while Goldmark emits ``λ1Lalign`` in HTML.
            tokens = re.findall(r'(?<![^\W_.])(?<!\.)(?!(?:[-+]?\d+)(?:\.\d+){2,}(?![A-Za-z\d.]))[-+]?\d+(?:\.\d+)?(?:%|[A-Za-z]+)?(?![^\W_.])(?!\.)', visible_source)
            if any(not re.search(r'(?<![\d.])' + re.escape(token) + r'(?![A-Za-z\d.])', actual)
                   for token in tokens):
                raise ValueError('HTML 表格数字/单位未在对应单元格保留')
    projection = page.projection()
    return {'url': url, 'htmlSha256': digest(rendered.encode()),
            'projectionSha256': digest(json.dumps(projection, ensure_ascii=False, sort_keys=True).encode()),
            'imageUrls': page.images, 'tableCount': len(page.tables), 'formulaCount': len(formulas),
            'layers': {'htmlMechanical': 'passed', 'semanticReview': 'not_performed',
                       'visualInspection': 'not_performed', 'mathBrowserExecution': 'not_performed'}}


@lru_cache(maxsize=1)
def safe_transport():
    # Reuse the publisher's SSRF/DNS/CONNECT peer validation, not urllib's
    # ambient proxy handler or a second unvalidated DNS lookup.
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
                    raise ValueError(f'URL 验收 HTTP {response.status}')
                chunks, size = [], 0
                while True:
                    shared._remaining_deadline_seconds(deadline, '会议 URL 验收')
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError('URL 验收响应过大')
                    chunks.append(chunk)
                return {'url': current, 'body': b''.join(chunks),
                        'contentType': response.headers.get('Content-Type', '').split(';')[0].lower()}
            except (urllib3.exceptions.HTTPError, OSError):
                # GitHub's raw edge can occasionally reset a CONNECT tunnel
                # or close a TLS stream while the immutable object is still
                # perfectly healthy. Retry only transport failures, within
                # this URL's existing absolute deadline; HTTP status, digest,
                # redirect, and HTML errors remain deterministic failures.
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
    # Conference batches can contain hundreds of pages and thousands of
    # immutable PNGs. Keep the transport validation in fetch_public(), but do
    # independent GETs with a small bounded pool. executor.map preserves input
    # order, so the signed acceptance bytes remain deterministic.
    try:
        concurrency = int(os.environ.get(
            'PD_CONFERENCE_ONLINE_VERIFY_CONCURRENCY', '4'))
    except ValueError:
        raise ValueError('会议线上验收并发必须是整数') from None
    if not 1 <= concurrency <= 16:
        raise ValueError('会议线上验收并发必须在 1–16 之间')

    def page_check(expected):
        result = fetch_public(expected['url'])
        if result['contentType'] != 'text/html' or result['url'] != expected['url']:
            raise ValueError('线上页面类型/最终 URL 不匹配')
        page = Page(result['body'].decode('utf-8'))
        projection = digest(json.dumps(page.projection(), ensure_ascii=False, sort_keys=True).encode())
        if projection != expected['projectionSha256'] or page.canonicals != [expected['url']] \
                or (expected['formulaCount'] and not page.math_runtime):
            raise ValueError('线上正文/图片/表格/公式未匹配已审 HTML')

        return {'url': expected['url'], 'sha256': digest(result['body'])}

    def image_check(record):
        url = public_url(f'{image_base}/{record["path"]}')
        result = fetch_public(url)
        if result['contentType'] != 'image/png' or digest(result['body']) != record['sourceSha256']:
            raise ValueError('线上图片 MIME/实际字节与封存资产不一致')
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
            raise ValueError('图片不是可解码 PNG')
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()

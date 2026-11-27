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

import protocol_codec as protocols

GATE_CONTRACT = protocols.contract('conference-publication-mechanical-gate')


def mechanical_gate_header():
    return protocols.record_header(GATE_CONTRACT, 'conference-publication-mechanical-gate')


def has_mechanical_gate_format(value):
    if not isinstance(value, dict):
        return False
    header = {'contract': value.get('contract')}
    if 'schemaFingerprint' in value:
        header['schemaFingerprint'] = value['schemaFingerprint']
    if not protocols.has_valid_header(header, 'conference-publication-mechanical-gate'):
        return False
    # The old record's version is the actual external Hugo version string.
    # Current records spell this body field hugoVersion, so protocol headers
    # cannot accidentally reinterpret a software version as a schema selector.
    return not (protocols.is_current_header(header, 'conference-publication-mechanical-gate')
                and 'version' in value)
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
        self.math_ssr_css = False
        self.math_katex_nodes = False
        self.math_mathml_nodes = False
        self.math_ssr_nodes = False
        self.titles = []
        self.h1s = []
        self.tag_sections = []
        self.tag_depth = None
        self.feed(source)
        self.close()
        if self.bodies != 1 or self.depth is not None:
            raise ValueError('HTML 必须含唯一闭合 post-content 正文')

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title':
            self.titles.append([])
        if tag == 'h1':
            self.h1s.append([])
        if 'paper-tags' in attrs.get('class', '').split():
            if self.tag_depth is not None:
                raise ValueError('研究分类区不应互相嵌套')
            self.tag_depth = len(self.stack)
            self.tag_sections.append({'text': [], 'links': [], 'facets': [], 'nodes': [], 'direct': []})
        if self.tag_depth is not None:
            if tag == 'a':
                self.tag_sections[-1]['links'].append(attrs.get('href', ''))
            if 'data-classification-facet' in attrs:
                self.tag_sections[-1]['facets'].append(attrs['data-classification-facet'])
            if 'data-classification-concept' in attrs:
                self.tag_sections[-1]['nodes'].append(attrs['data-classification-concept'])
                if attrs.get('data-direct-classification') == 'true':
                    self.tag_sections[-1]['direct'].append(attrs['data-classification-concept'])
        if tag == 'link' and 'canonical' in attrs.get('rel', '').split():
            self.canonicals.append(attrs.get('href', ''))
        if tag == 'link' and 'stylesheet' in attrs.get('rel', '').split() \
                and re.search(r'katex', attrs.get('href', ''), re.I):
            self.math_ssr_css = True
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
            if 'katex' in attrs.get('class', '').split():
                self.math_katex_nodes = True
                self.math_ssr_nodes = True
            if tag == 'math':
                self.math_mathml_nodes = True
                self.math_ssr_nodes = True
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
        if self.tag_depth == len(self.stack):
            self.tag_depth = None
        if self.depth == len(self.stack):
            self.depth = None

    def handle_data(self, data):
        if 'title' in self.stack and self.titles:
            self.titles[-1].append(data)
        if 'h1' in self.stack and self.h1s:
            self.h1s[-1].append(data)
        if self.tag_depth is not None:
            self.tag_sections[-1]['text'].append(data)
        if self.depth is not None and not any(tag in {'script', 'style'} for tag in self.stack):
            self.text.append(data)
            self.body_html.append(html.escape(data, quote=False))
            if self.cell is not None:
                self.cell.append(data)

    def has_math_rendering(self):
        if self.math_runtime:
            return True
        if self.math_katex_nodes:
            return bool(self.math_ssr_css)
        return bool(self.math_mathml_nodes)

    def visible_content_fields(self):
        # 浏览器或压缩工具调整空白，不影响已审内容。
        return {'text': re.sub(r'\s+', '', ''.join(self.text)), 'images': self.images,
                'tables': [[re.sub(r'\s+', '', cell) for cell in table] for table in self.tables]}

    def page_identity_fields(self):
        """Current receipts also bind the title and hierarchy outside post-content."""
        normal = lambda parts: re.sub(r'\s+', ' ', ''.join(parts)).strip()
        return {'titles': [normal(parts) for parts in self.titles],
                'h1s': [normal(parts) for parts in self.h1s],
                'tagSections': [{'text': normal(section['text']),
                                 'links': section['links'], 'facets': section['facets'],
                                 'nodes': section['nodes'], 'direct': section['direct']}
                                for section in self.tag_sections]}


def markdown_tables(body):
    lines = str(body or '').splitlines()
    tables = []
    index = 0
    separator = re.compile(r'\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*')
    fence = None
    in_fence_line = [False] * len(lines)
    for pos, raw_line in enumerate(lines):
        if fence is not None:
            in_fence_line[pos] = True
            fence_char, fence_len = fence
            if re.fullmatch(rf' {{0,3}}{re.escape(fence_char)}{{{fence_len},}}[ \t]*$', raw_line):
                fence = None
            continue
        opened = re.match(r'^ {0,3}(`{3,}|~{3,})([^\r\n]*)$', raw_line)
        if opened and not (opened.group(1)[0] == '`' and '`' in opened.group(2)):
            in_fence_line[pos] = True
            fence = (opened.group(1)[0], len(opened.group(1)))
    while index < len(lines):
        line = lines[index]
        if (index == 0 or in_fence_line[index] or in_fence_line[index - 1]
                or not re.fullmatch(separator, line)
                or not lines[index - 1].strip().startswith('|')):
            index += 1
            continue
        # 找到表头与分隔行之后，把整段连续的竖线行一起读进来。解读稿里
        # 可能在本表首尾放一整行全横线，那是表内数据，不是另一张表的分隔行。
        rows = [lines[index - 1]]
        cursor = index + 1
        while cursor < len(lines) and not in_fence_line[cursor] and lines[cursor].strip().startswith('|'):
            rows.append(lines[cursor])
            cursor += 1
        tables.append([cell.strip() for row in rows
                       for cell in re.split(r'(?<!\\)\|', row.strip().strip('|'))])
        index = cursor
    return tables


_HTML_BLOCK_TYPE6_TAGS = (
    r'address|article|aside|base|basefont|blockquote|body|'
    r'caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|'
    r'footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|'
    r'menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|'
    r'tfoot|th|thead|title|tr|track|ul'
)

_COMMONMARK_AUTOLINK_OR_RAW_HTML_RE = re.compile(
    r'<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20\x7f<>]*>'
    r"|<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>"
    r'|<!--(?:>|->|[\s\S]*?-->)'
    r'|<\?[\s\S]*?\?>'
    r'|<![A-Za-z][^>]*>'
    r'|<!\[CDATA\[[\s\S]*?\]\]>'
    r'|</[A-Za-z][A-Za-z0-9-]*[ \t\r\n]*>'
    r'|<[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:[^ \t\r\n"\'=<>`]+|\'[^\']*\'|"[^"]*"))?)*[ \t\r\n]*/?>'
)

_HTML_BLOCK_TYPE1_START_RE = re.compile(r' {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)', re.IGNORECASE)
_HTML_BLOCK_TYPE1_END_RE = re.compile(r'</(?:pre|script|style|textarea)>', re.IGNORECASE)
_HTML_BLOCK_TYPE2_START_RE = re.compile(r' {0,3}<!--')
_HTML_BLOCK_TYPE2_END_RE = re.compile(r'-->')
_HTML_BLOCK_TYPE3_START_RE = re.compile(r' {0,3}<\?')
_HTML_BLOCK_TYPE3_END_RE = re.compile(r'\?>')
_HTML_BLOCK_TYPE4_START_RE = re.compile(r' {0,3}<![A-Za-z]')
_HTML_BLOCK_TYPE4_END_RE = re.compile(r'>')
_HTML_BLOCK_TYPE5_START_RE = re.compile(r' {0,3}<!\[CDATA\[')
_HTML_BLOCK_TYPE5_END_RE = re.compile(r'\]\]>')
_HTML_BLOCK_TYPE6_START_RE = re.compile(
    r' {0,3}</?(?:' + _HTML_BLOCK_TYPE6_TAGS + r')(?:[ \t>]|/>|$)',
    re.IGNORECASE,
)
_HTML_BLOCK_TYPE7_START_RE = re.compile(
    r' {0,3}(?:'
    r'<(?!/?(?:pre|script|style|textarea)(?:[ \t/>]|$))[A-Za-z][A-Za-z0-9-]*'
    r'(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t\r\n"\'=<>`]+|\'[^\'\r\n]*\'|"[^"\r\n]*"))?)*'
    r'[ \t]*/?>'
    r'|</[A-Za-z][A-Za-z0-9-]*[ \t]*>'
    r')[ \t]*$',
    re.IGNORECASE,
)
_THEMATIC_BREAK_RE = re.compile(
    r' {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$'
)
_ATX_HEADING_RE = re.compile(r' {0,3}#{1,6}(?:[ \t]|$)')
_ATX_OR_THEMATIC_LINE_RE = re.compile(
    r' {0,3}(?:#{1,6}(?:[ \t]|$)|(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$)'
)
_SETEXT_UNDERLINE_RE = re.compile(r' {0,3}(?:=+|-+)[ \t]*$')
_LIST_TOKEN_RE = re.compile(r'([-+*]|\d{1,9}[.)])(?=[ \t]|$)')


def _commonmark_line_bounds(content, pos):
    total = len(content)
    nl = content.find('\n', pos)
    cr = content.find('\r', pos)
    if cr >= 0 and (nl < 0 or cr < nl):
        return cr, (cr + 2 if cr + 1 < total and content[cr + 1] == '\n' else cr + 1)
    if nl >= 0:
        return nl, nl + 1
    return total, total


def _cm_peek_ws_cols(raw_line, idx, col, pending_sp):
    """Measure leading ASCII space/tab visual width from exact line column `col` (4-col tab stops, §2.2)."""
    cols = pending_sp
    c = col + pending_sp
    i = idx
    n = len(raw_line)
    while i < n:
        ch = raw_line[i]
        if ch == ' ':
            cols += 1
            c += 1
            i += 1
        elif ch == '\t':
            step = 4 - (c % 4)
            cols += step
            c += step
            i += 1
        else:
            break
    return cols


def _cm_advance_cols(raw_line, idx, col, pending_sp, target_cols):
    """Consume up to `target_cols` columns of leading ASCII whitespace while tracking exact column & tab remainder."""
    if target_cols <= 0:
        return idx, col, pending_sp
    if target_cols <= pending_sp:
        return idx, col + target_cols, pending_sp - target_cols
    rem = target_cols - pending_sp
    col += pending_sp
    pending_sp = 0
    n = len(raw_line)
    while rem > 0 and idx < n:
        ch = raw_line[idx]
        if ch == ' ':
            idx += 1
            col += 1
            rem -= 1
        elif ch == '\t':
            step = 4 - (col % 4)
            idx += 1
            if step <= rem:
                col += step
                rem -= step
            else:
                col += rem
                pending_sp = step - rem
                rem = 0
        else:
            break
    return idx, col, pending_sp


def _cm_effective_with_leading_tabs(raw_line, idx, col, pending_sp):
    """Return remaining text with leading whitespace expanded to exact visual spaces (for `^ {0,3}` regexes)."""
    ws_cols = _cm_peek_ws_cols(raw_line, idx, col, pending_sp)
    n_idx, _n_col, n_pend = _cm_advance_cols(raw_line, idx, col, pending_sp, ws_cols)
    # n_pend is 0 because all leading ws was consumed
    return (' ' * ws_cols) + raw_line[n_idx:]


def _cm_is_blank(raw_line, idx, pending_sp):
    return not raw_line[idx:].strip(' \t')


def _cm_try_strip_bq(raw_line, idx, col, pending_sp):
    """Try to consume one CommonMark §5.1 blockquote marker (` {0,3}> ?`) with exact 4-col tab stops."""
    ws_cols = _cm_peek_ws_cols(raw_line, idx, col, pending_sp)
    if ws_cols > 3:
        return None
    m_idx, m_col, m_pend = _cm_advance_cols(raw_line, idx, col, pending_sp, ws_cols)
    if m_idx >= len(raw_line) or raw_line[m_idx] != '>':
        return None
    # Consume '>'
    n_idx = m_idx + 1
    n_col = m_col + 1
    n_pend = 0
    # Consume optional single space or 1 column of a tab following '>' (§5.1)
    if n_idx < len(raw_line):
        if raw_line[n_idx] == ' ':
            n_idx += 1
            n_col += 1
        elif raw_line[n_idx] == '\t':
            step = 4 - (n_col % 4)
            n_idx += 1
            n_col += 1
            n_pend = step - 1
    return n_idx, n_col, n_pend


def _cm_try_match_list_marker(raw_line, idx, col, pending_sp):
    """Match CommonMark §5.2 list marker at cursor.
    Returns (kind, is_one, req_cols, (n_idx, n_col, n_pend), rest_is_blank) or None.
    """
    ws_cols = _cm_peek_ws_cols(raw_line, idx, col, pending_sp)
    if ws_cols > 3:
        return None
    eff = _cm_effective_with_leading_tabs(raw_line, idx, col, pending_sp)
    # Thematic break (`- - -` or `* * *`) takes precedence over bullet list marker (§4.1/§5.2).
    if _THEMATIC_BREAK_RE.match(eff):
        return None
    m_idx, m_col, _m_pend = _cm_advance_cols(raw_line, idx, col, pending_sp, ws_cols)
    m = _LIST_TOKEN_RE.match(raw_line, m_idx)
    if not m:
        return None
    marker = m.group(1)
    kind = 'ol' if marker[0].isdigit() else 'ul'
    is_one = bool(kind == 'ol' and re.fullmatch(r'0{0,8}1[.)]', marker))
    after_idx = m.end()
    after_col = m_col + len(marker)
    if _cm_is_blank(raw_line, after_idx, 0):
        req_cols = ws_cols + len(marker) + 1
        if after_idx < len(raw_line):
            nxt_cur = _cm_advance_cols(raw_line, after_idx, after_col, 0, 1)
        else:
            nxt_cur = (after_idx, after_col, 0)
        return kind, is_one, req_cols, nxt_cur, True
    post_ws = _cm_peek_ws_cols(raw_line, after_idx, after_col, 0)
    if post_ws >= 5:
        req_cols = ws_cols + len(marker) + 1
        nxt_cur = _cm_advance_cols(raw_line, after_idx, after_col, 0, 1)
    else:
        req_cols = ws_cols + len(marker) + post_ws
        nxt_cur = _cm_advance_cols(raw_line, after_idx, after_col, 0, post_ws)
    return kind, is_one, req_cols, nxt_cur, False


def _cm_match_containers(raw_line, stack):
    """Match active container stack (interleaved ['bq'] and ['list', req_cols, kind, empty_first]) on raw_line.
    Returns (matched_count, (idx, col, pending_sp)).
    """
    cur = (0, 0, 0)
    matched = 0
    for frame in stack:
        if frame[0] == 'bq':
            nxt = _cm_try_strip_bq(raw_line, *cur)
            if nxt is None:
                break
            cur = nxt
            matched += 1
        else:
            if _cm_is_blank(raw_line, cur[0], cur[2]):
                # CommonMark §5.2 Example 278: an empty list item ends on the first blank line.
                if frame[3]:
                    break
                matched += 1
            else:
                ws_cols = _cm_peek_ws_cols(raw_line, *cur)
                if ws_cols < frame[1]:
                    break
                cur = _cm_advance_cols(raw_line, *cur, frame[1])
                matched += 1
    return matched, cur


def _cm_line_interrupts_paragraph(raw_line, cur, stack, matched):
    """Return True if the remainder at `cur` starts a CommonMark block that interrupts a paragraph."""
    if _cm_is_blank(raw_line, cur[0], cur[2]):
        return True
    if _cm_try_strip_bq(raw_line, *cur) is not None:
        return True
    ws_cols = _cm_peek_ws_cols(raw_line, *cur)
    if ws_cols >= 4:
        return False
    eff = _cm_effective_with_leading_tabs(raw_line, *cur)
    if _ATX_OR_THEMATIC_LINE_RE.match(eff):
        return True
    opened = re.match(r'^ {0,3}(`{3,}|~{3,})([^\r\n]*)', eff)
    if opened and not (opened.group(1)[0] == '`' and '`' in opened.group(2)):
        return True
    if (
        _HTML_BLOCK_TYPE1_START_RE.match(eff)
        or _HTML_BLOCK_TYPE2_START_RE.match(eff)
        or _HTML_BLOCK_TYPE3_START_RE.match(eff)
        or _HTML_BLOCK_TYPE4_START_RE.match(eff)
        or _HTML_BLOCK_TYPE5_START_RE.match(eff)
        or _HTML_BLOCK_TYPE6_START_RE.match(eff)
    ):
        return True
    lm = _cm_try_match_list_marker(raw_line, *cur)
    if lm is not None:
        l_kind, is_one, _req_cols, _nxt_cur, rest_is_blank = lm
        if matched < len(stack):
            return True
        if not rest_is_blank and (l_kind == 'ul' or is_one):
            return True
    return False


def _normalize_cm_link_label(raw_label):
    """CommonMark 0.31.2 §4.7 link label normalization: strip ASCII WS, collapse internal WS runs, Unicode casefold."""
    stripped = str(raw_label).strip(' \t\r\n')
    if not stripped:
        return ''
    return re.sub(r'[ \t\r\n]+', ' ', stripped).casefold()


def _is_valid_cm_label_text(raw_label):
    """CommonMark 0.31.2 §4.7/§6.3: link label has <=999 chars, non-blank, no unescaped `[` or `]`."""
    if not raw_label or len(raw_label) > 999 or not raw_label.strip(' \t\r\n'):
        return False
    ascii_punctuation = set(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')
    idx = 0
    length = len(raw_label)
    while idx < length:
        ch = raw_label[idx]
        if ch == '\\' and idx + 1 < length and raw_label[idx + 1] in ascii_punctuation:
            idx += 2
            continue
        if ch in '[]':
            return False
        idx += 1
    return True


def _parse_cm_ref_label(buf, start_pos, limit):
    """Parse CommonMark §6.3 bracketed reference label `[...]` (including empty `[]`) starting at `start_pos`.
    Returns `(close_idx, raw_inside)` if syntactically valid `[...]` (<=999 chars, no unescaped `[`), else `None`.
    """
    if start_pos >= limit or buf[start_pos] != '[':
        return None
    ascii_punctuation = set(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')
    idx = start_pos + 1
    chars = []
    while idx < limit:
        ch = buf[idx]
        if ch == '\\' and idx + 1 < limit and buf[idx + 1] in ascii_punctuation:
            chars.append(ch)
            chars.append(buf[idx + 1])
            idx += 2
        elif ch == '[':
            return None
        elif ch == ']':
            return idx, ''.join(chars)
        else:
            chars.append(ch)
            idx += 1
        if len(chars) > 999:
            return None
    return None


def _parse_link_ref_def(content, first_inner, first_next, stack):
    """Parse CommonMark §4.7 link reference definition starting with already-stripped `first_inner`.
    Continuation lines allow §4.7/§5.1 lazy continuation (stopping at blank lines, paragraph-interrupting blocks,
    or exact-depth Setext heading underlines per §4.3).
    Returns `(end_pos, norm_label, dest_url)` if valid, else `None`.
    """
    total = len(content)
    ascii_punctuation = set(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')

    def read_cont_line(pos):
        l_end, l_next = _commonmark_line_bounds(content, pos)
        raw = content[pos:l_end]
        matched, cur = _cm_match_containers(raw, stack)
        if _cm_is_blank(raw, cur[0], cur[2]):
            return None
        if _cm_line_interrupts_paragraph(raw, cur, stack, matched):
            return None
        inner = _cm_effective_with_leading_tabs(raw, *cur)
        if matched == len(stack) and _cm_peek_ws_cols(raw, *cur) <= 3 and _SETEXT_UNDERLINE_RE.match(inner):
            return None
        return inner, l_next

    m_open = re.match(r'^ {0,3}\[', first_inner)
    if not m_open:
        return None

    # Accumulate lines belonging to the label until `]:`
    lines = [(first_inner, first_next)]
    idx = m_open.end()
    line_i = 0
    label_chars = []
    escaped = False
    found_colon = False
    while True:
        cur_line, cur_next = lines[line_i]
        while idx < len(cur_line):
            ch = cur_line[idx]
            if escaped:
                label_chars.append(ch)
                escaped = False
                idx += 1
            elif ch == '\\' and idx + 1 < len(cur_line) and cur_line[idx + 1] in ascii_punctuation:
                label_chars.append(ch)
                escaped = True
                idx += 1
            elif ch == '[':
                return None
            elif ch == ']':
                if idx + 1 < len(cur_line) and cur_line[idx + 1] == ':':
                    idx += 2
                    found_colon = True
                    break
                return None
            else:
                label_chars.append(ch)
                idx += 1
            if len(label_chars) > 999:
                return None
        if found_colon:
            break
        if cur_next >= total:
            return None
        nxt = read_cont_line(cur_next)
        if nxt is None:
            return None
        lines.append(nxt)
        line_i += 1
        idx = 0
        label_chars.append('\n')
        if len(label_chars) > 999:
            return None

    norm_label = _normalize_cm_link_label(''.join(label_chars))
    if not norm_label:
        return None

    # Optional whitespace + at most one line ending before destination
    cur_line, cur_next = lines[line_i]
    while idx < len(cur_line) and cur_line[idx] in ' \t':
        idx += 1
    if idx == len(cur_line):
        if cur_next >= total:
            return None
        nxt = read_cont_line(cur_next)
        if nxt is None:
            return None
        lines.append(nxt)
        line_i += 1
        cur_line, cur_next = nxt
        idx = 0
        while idx < len(cur_line) and cur_line[idx] in ' \t':
            idx += 1

    # Parse destination on cur_line
    if idx >= len(cur_line):
        return None
    if cur_line[idx] == '<':
        dest_start = idx + 1
        idx += 1
        esc = False
        closed = False
        while idx < len(cur_line):
            ch = cur_line[idx]
            if esc:
                esc = False
            elif ch == '\\' and idx + 1 < len(cur_line) and cur_line[idx + 1] in ascii_punctuation:
                esc = True
            elif ch == '>':
                dest_url = cur_line[dest_start:idx].strip()
                idx += 1
                closed = True
                break
            elif ch == '<':
                return None
            idx += 1
        if not closed:
            return None
    else:
        dest_start = idx
        p_depth = 0
        esc = False
        while idx < len(cur_line):
            ch = cur_line[idx]
            if ch in ' \t':
                break
            if ord(ch) < 0x20 or ord(ch) == 0x7f:
                return None
            if esc:
                esc = False
            elif ch == '\\' and idx + 1 < len(cur_line) and cur_line[idx + 1] in ascii_punctuation:
                esc = True
            elif ch == '(':
                p_depth += 1
            elif ch == ')':
                if p_depth == 0:
                    return None
                p_depth -= 1
            idx += 1
        if idx == dest_start or p_depth != 0 or esc:
            return None
        dest_url = cur_line[dest_start:idx]

    dest_line_next = cur_next
    had_same_line_ws = False
    while idx < len(cur_line) and cur_line[idx] in ' \t':
        had_same_line_ws = True
        idx += 1
    dest_line_clean_eol = (idx == len(cur_line))

    def try_parse_title(t_line, t_next, t_idx):
        if t_idx >= len(t_line) or t_line[t_idx] not in '"\'(':
            return None
        delim = t_line[t_idx]
        end_delim = ')' if delim == '(' else delim
        t_idx += 1
        esc = False
        while True:
            while t_idx < len(t_line):
                ch = t_line[t_idx]
                if esc:
                    esc = False
                elif ch == '\\' and t_idx + 1 < len(t_line) and t_line[t_idx + 1] in ascii_punctuation:
                    esc = True
                elif delim == '(' and ch == '(':
                    return None
                elif ch == end_delim:
                    if not t_line[t_idx + 1:].strip(' \t'):
                        return t_next
                    return None
                t_idx += 1
            if t_next >= total:
                return None
            nxt_t = read_cont_line(t_next)
            if nxt_t is None:
                return None
            t_line, t_next = nxt_t
            t_idx = 0

    if not dest_line_clean_eol:
        if not had_same_line_ws:
            return None
        title_end = try_parse_title(cur_line, cur_next, idx)
        if title_end is None:
            return None
        return title_end, norm_label, dest_url

    # Destination ended cleanly at EOL; optionally consume a title on the next line if it ends cleanly.
    if dest_line_next < total:
        nxt_after = read_cont_line(dest_line_next)
        if nxt_after is not None:
            t_line, t_next = nxt_after
            t_idx = 0
            while t_idx < len(t_line) and t_line[t_idx] in ' \t':
                t_idx += 1
            title_end = try_parse_title(t_line, t_next, t_idx)
            if title_end is not None:
                return title_end, norm_label, dest_url
    return dest_line_next, norm_label, dest_url


def _scan_commonmark_structure(content, *, include_ref_defs=False):
    """Unified single-pass CommonMark 0.31.2 block scanner with exact 4-column tab stops and
    interleaved blockquote/list container stack.

    Returns (ignored_blocks, inline_regions) — or (ignored_blocks, inline_regions, ref_defs)
    when `include_ref_defs=True` — where:
      - ignored_blocks: sorted list of (start, end, kind) for fence/html/code/link_ref_def blocks
      - inline_regions: sorted list of regions, each a non-empty list of (slice_start, slice_end)
        byte ranges into `content` representing one paragraph or ATX/Setext heading with all
        enclosing blockquote/list container prefixes stripped per line.
      - ref_defs: dict mapping normalized §4.7 link label -> destination URL (first definition wins).
    """
    total = len(content)
    blocks = []
    inline_regions = []
    ref_defs = {}
    cur_para_slices = []
    pos = 0
    in_paragraph = False
    stack = []  # interleaved ['bq'] and ['list', req_cols, kind, empty_first_line]

    def flush_paragraph():
        nonlocal cur_para_slices, in_paragraph
        if cur_para_slices:
            inline_regions.append(cur_para_slices)
            cur_para_slices = []
        in_paragraph = False

    def mark_non_empty_lists():
        for frame in stack:
            if frame[0] == 'list' and frame[3]:
                frame[3] = False

    def read_at_exact_stack(cur_pos, req_stack):
        c_end, c_next = _commonmark_line_bounds(content, cur_pos)
        c_raw = content[cur_pos:c_end]
        c_matched, c_cur = _cm_match_containers(c_raw, req_stack)
        if c_matched < len(req_stack):
            return None, c_next, False, None
        c_blank = _cm_is_blank(c_raw, c_cur[0], c_cur[2])
        c_inner = _cm_effective_with_leading_tabs(c_raw, *c_cur)
        return c_inner, c_next, c_blank, c_cur

    while pos < total:
        l_end, next_pos = _commonmark_line_bounds(content, pos)
        raw_line = content[pos:l_end]
        matched, cur = _cm_match_containers(raw_line, stack)

        # Blank line after matching active containers
        if _cm_is_blank(raw_line, cur[0], cur[2]):
            flush_paragraph()
            stack = stack[:matched]
            pos = next_pos
            continue

        # Check lazy paragraph continuation (§5.1/§5.2) when fewer than all containers matched
        if in_paragraph and matched < len(stack):
            if not _cm_line_interrupts_paragraph(raw_line, cur, stack, matched):
                mark_non_empty_lists()
                cur_para_slices.append((pos + cur[0], l_end))
                pos = next_pos
                continue

        # Unwrap any new containers (interleaved blockquotes and list markers) at `cur`.
        opened_new_container = False
        work_stack = list(stack[:matched])
        while True:
            nxt_bq = _cm_try_strip_bq(raw_line, *cur)
            if nxt_bq is not None:
                if not opened_new_container:
                    flush_paragraph()
                    stack = work_stack
                mark_non_empty_lists()
                stack.append(['bq'])
                cur = nxt_bq
                opened_new_container = True
                if _cm_is_blank(raw_line, cur[0], cur[2]):
                    break
                continue
            lm = _cm_try_match_list_marker(raw_line, *cur)
            if lm is not None:
                l_kind, is_one, req_cols, nxt_cur, rest_is_blank = lm
                if not in_paragraph or opened_new_container or matched < len(stack):
                    can_start = True
                elif not rest_is_blank and (l_kind == 'ul' or is_one):
                    can_start = True
                else:
                    can_start = False
                if can_start:
                    if not opened_new_container:
                        flush_paragraph()
                        stack = work_stack
                    mark_non_empty_lists()
                    stack.append(['list', req_cols, l_kind, rest_is_blank])
                    cur = nxt_cur
                    opened_new_container = True
                    if rest_is_blank:
                        break
                    continue
            break

        if opened_new_container and _cm_is_blank(raw_line, cur[0], cur[2]):
            in_paragraph = False
            pos = next_pos
            continue

        ws_cols = _cm_peek_ws_cols(raw_line, *cur)
        inner = _cm_effective_with_leading_tabs(raw_line, *cur)

        # §4.5 Fenced code block
        opened = re.match(r'^ {0,3}(`{3,}|~{3,})([^\r\n]*)', inner) if ws_cols <= 3 else None
        if opened and not (opened.group(1)[0] == '`' and '`' in opened.group(2)):
            flush_paragraph()
            if not opened_new_container:
                stack = work_stack
            mark_non_empty_lists()
            fence_char = opened.group(1)[0]
            fence_len = len(opened.group(1))
            close_re = re.compile(r' {0,3}' + re.escape(fence_char) + '{' + str(fence_len) + r',}[ \t]*$')
            cur_p = next_pos
            blk_end = total
            while cur_p < total:
                c_inner, c_next, _c_blank, _c_cur = read_at_exact_stack(cur_p, stack)
                if c_inner is None:
                    blk_end = cur_p
                    break
                if close_re.fullmatch(c_inner):
                    blk_end = c_next
                    break
                cur_p = c_next
            blocks.append((pos, blk_end, 'fence'))
            in_paragraph = False
            pos = blk_end
            continue

        # §4.6 HTML block Types 1–5
        end_re = None
        if ws_cols <= 3:
            if _HTML_BLOCK_TYPE1_START_RE.match(inner):
                end_re = _HTML_BLOCK_TYPE1_END_RE
            elif _HTML_BLOCK_TYPE2_START_RE.match(inner):
                end_re = _HTML_BLOCK_TYPE2_END_RE
            elif _HTML_BLOCK_TYPE3_START_RE.match(inner):
                end_re = _HTML_BLOCK_TYPE3_END_RE
            elif _HTML_BLOCK_TYPE4_START_RE.match(inner):
                end_re = _HTML_BLOCK_TYPE4_END_RE
            elif _HTML_BLOCK_TYPE5_START_RE.match(inner):
                end_re = _HTML_BLOCK_TYPE5_END_RE
        if end_re is not None:
            flush_paragraph()
            if not opened_new_container:
                stack = work_stack
            mark_non_empty_lists()
            if end_re.search(inner):
                blk_end = next_pos
            else:
                cur_p = next_pos
                blk_end = total
                while cur_p < total:
                    c_inner, c_next, _c_blank, _c_cur = read_at_exact_stack(cur_p, stack)
                    if c_inner is None:
                        blk_end = cur_p
                        break
                    if end_re.search(c_inner):
                        blk_end = c_next
                        break
                    cur_p = c_next
            blocks.append((pos, blk_end, 'html'))
            in_paragraph = False
            pos = blk_end
            continue

        # §4.6 HTML block Types 6–7
        if ws_cols <= 3 and (
            _HTML_BLOCK_TYPE6_START_RE.match(inner)
            or (not in_paragraph and _HTML_BLOCK_TYPE7_START_RE.match(inner))
        ):
            flush_paragraph()
            if not opened_new_container:
                stack = work_stack
            mark_non_empty_lists()
            cur_p = next_pos
            blk_end = total
            while cur_p < total:
                c_inner, c_next, c_blank, _c_cur = read_at_exact_stack(cur_p, stack)
                if c_inner is None:
                    blk_end = cur_p
                    break
                if c_blank:
                    blk_end = c_next
                    break
                cur_p = c_next
            blocks.append((pos, blk_end, 'html'))
            in_paragraph = False
            pos = blk_end
            continue

        # §4.4 Indented code block (4+ visual columns at exact tab stops)
        if not in_paragraph and ws_cols >= 4:
            flush_paragraph()
            if not opened_new_container:
                stack = work_stack
            mark_non_empty_lists()
            last_code_end = next_pos
            cur_p = next_pos
            while cur_p < total:
                c_end, c_next = _commonmark_line_bounds(content, cur_p)
                c_raw = content[cur_p:c_end]
                c_matched, c_cur = _cm_match_containers(c_raw, stack)
                if c_matched < len(stack):
                    break
                if _cm_is_blank(c_raw, c_cur[0], c_cur[2]):
                    cur_p = c_next
                    continue
                if _cm_peek_ws_cols(c_raw, *c_cur) < 4:
                    break
                last_code_end = c_next
                cur_p = c_next
            blocks.append((pos, last_code_end, 'code'))
            in_paragraph = False
            pos = last_code_end
            continue

        # §4.7 Link reference definition
        if not in_paragraph and ws_cols <= 3 and re.match(r'^ {0,3}\[', inner):
            cand_stack = stack if opened_new_container else work_stack
            parsed_def = _parse_link_ref_def(content, inner, next_pos, cand_stack)
            if parsed_def is not None:
                def_end, norm_label, dest_url = parsed_def
                flush_paragraph()
                if not opened_new_container:
                    stack = work_stack
                mark_non_empty_lists()
                if norm_label not in ref_defs:
                    ref_defs[norm_label] = dest_url
                blocks.append((pos, def_end, 'link_ref_def'))
                in_paragraph = False
                pos = def_end
                continue

        # §4.1 Thematic break
        if ws_cols <= 3 and _THEMATIC_BREAK_RE.match(inner):
            flush_paragraph()
            if not opened_new_container:
                stack = work_stack
            mark_non_empty_lists()
            pos = next_pos
            continue

        # §4.2 ATX heading (standalone single-line inline region)
        if ws_cols <= 3 and _ATX_HEADING_RE.match(inner):
            flush_paragraph()
            if not opened_new_container:
                stack = work_stack
            mark_non_empty_lists()
            inline_regions.append([(pos + cur[0], l_end)])
            pos = next_pos
            continue

        # §4.3 Setext heading underline (only when matching exact container depth of active paragraph)
        if in_paragraph and matched == len(stack) and not opened_new_container \
                and ws_cols <= 3 and _SETEXT_UNDERLINE_RE.match(inner):
            flush_paragraph()
            pos = next_pos
            continue

        # Ordinary paragraph line
        if not in_paragraph:
            if not opened_new_container:
                stack = work_stack
            in_paragraph = True
        mark_non_empty_lists()
        cur_para_slices.append((pos + cur[0], l_end))
        pos = next_pos

    flush_paragraph()
    if include_ref_defs:
        return blocks, inline_regions, ref_defs
    return blocks, inline_regions


def _scan_commonmark_ignored_blocks(content):
    """Single-pass CommonMark §4.4/§4.5/§4.6/§4.7 block scanner (returns sorted (start, end, kind))."""
    blocks, _regions = _scan_commonmark_structure(content)
    return blocks


def _iter_markdown_images(text):
    """按 CommonMark 0.31.2 规则（与 publish_common.parse_markdown_images 一致）扫描行内与引用图片，
    基于统一块/容器扫描器 `_scan_commonmark_structure` 逐段落/标题剥离引用块与列表容器前缀，
    完整支持引用块内多行标题/原始 HTML 与 §4.7/§6.3/§6.4 完整/折叠/快捷引用链接及图片解析，
    校验 `![` 反斜杠转义与 `depth == 0` 闭合，返回 (start, end, url)。
    """
    content = str(text)
    _ignored_blocks, inline_regions, ref_defs = _scan_commonmark_structure(content, include_ref_defs=True)
    autolink_or_raw_html_re = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE
    ascii_punctuation = set(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')

    def skip_ws_with_one_nl(buf, pos, limit):
        while pos < limit and buf[pos] in ' \t':
            pos += 1
        if pos < limit and buf[pos] in '\r\n':
            if buf[pos] == '\r' and pos + 1 < limit and buf[pos + 1] == '\n':
                pos += 2
            else:
                pos += 1
            while pos < limit and buf[pos] in ' \t':
                pos += 1
        return pos

    def parse_inline_title(buf, start_pos, limit):
        """Parse CommonMark §6.3 link title delimited by \"...\", '...', or (...)."""
        delim = buf[start_pos]
        end_delim = ')' if delim == '(' else delim
        pos = start_pos + 1
        escaped = False
        while pos < limit:
            char = buf[pos]
            if escaped:
                escaped = False
            elif char == '\\' and pos + 1 < limit and buf[pos + 1] in ascii_punctuation:
                escaped = True
            elif delim == '(' and char == '(':
                return None
            elif char == end_delim:
                return pos + 1
            pos += 1
        return None

    def parse_inline_dest(buf, start_paren, limit, *, allow_empty_dest=False):
        """Strict CommonMark §6.3 inline destination + optional title parser."""
        if start_paren >= limit or buf[start_paren] != '(':
            return None
        pos = skip_ws_with_one_nl(buf, start_paren + 1, limit)
        if pos >= limit:
            return None
        if buf[pos] == ')':
            return (pos, '') if allow_empty_dest else None
        is_angle = False
        if buf[pos] == '<':
            is_angle = True
            dest_start = pos + 1
            pos += 1
            escaped = False
            closed_angle = False
            while pos < limit:
                char = buf[pos]
                if char in ('\r', '\n'):
                    return None
                if escaped:
                    escaped = False
                elif char == '\\' and pos + 1 < limit and buf[pos + 1] in ascii_punctuation:
                    escaped = True
                elif char == '>':
                    closed_angle = True
                    break
                elif char == '<':
                    return None
                pos += 1
            if not closed_angle:
                return None
            url = buf[dest_start:pos].strip()
            pos += 1
        else:
            dest_start = pos
            paren_depth = 0
            escaped = False
            while pos < limit:
                char = buf[pos]
                if char in ' \t\r\n':
                    break
                if ord(char) < 0x20 or ord(char) == 0x7f:
                    return None
                if escaped:
                    escaped = False
                elif char == '\\' and pos + 1 < limit and buf[pos + 1] in ascii_punctuation:
                    escaped = True
                elif char == '(':
                    paren_depth += 1
                elif char == ')':
                    if paren_depth == 0:
                        break
                    paren_depth -= 1
                pos += 1
            if paren_depth != 0 or escaped:
                return None
            url = buf[dest_start:pos]
            if not url:
                return None
        if not url and not (allow_empty_dest and is_angle):
            return None
        ws_start = pos
        pos = skip_ws_with_one_nl(buf, pos, limit)
        if pos >= limit:
            return None
        if buf[pos] == ')':
            return pos, url
        if pos > ws_start and buf[pos] in ('"', "'", '('):
            title_end = parse_inline_title(buf, pos, limit)
            if title_end is None:
                return None
            pos = skip_ws_with_one_nl(buf, title_end, limit)
            if pos < limit and buf[pos] == ')':
                return pos, url
        return None

    # CommonMark §6.3/§6.4 单遍内联定界栈（逐容器剥离后的段落/标题扫描）：
    # 每行剥离 `>` 与列表前缀后保留精确原字符偏移映射 `orig_offsets`，
    # 保证引用块内多行标题/原始 HTML 与顶层段落遵循完全一致的内联解析语义。
    for region in inline_regions:
        buf_parts = []
        orig_offsets = []
        for r_idx, (s_off, e_off) in enumerate(region):
            if r_idx > 0:
                buf_parts.append('\n')
                orig_offsets.append(region[r_idx - 1][1])
            buf_parts.append(content[s_off:e_off])
            orig_offsets.extend(range(s_off, e_off))
        buf = ''.join(buf_parts)
        p_end = len(buf)
        delim_stack = []
        matched_images = []
        all_image_spans = []
        pos = 0
        while pos < p_end:
            char = buf[pos]
            if char == '\\' and pos + 1 < p_end and buf[pos + 1] in ascii_punctuation:
                pos += 2
                continue
            if char == '`':
                tick_end = pos + 1
                while tick_end < p_end and buf[tick_end] == '`':
                    tick_end += 1
                closing = re.search(
                    r'(?<!`)`{' + str(tick_end - pos) + r'}(?!`)',
                    buf[tick_end:p_end],
                )
                if closing:
                    pos = tick_end + closing.end()
                    continue
                pos = tick_end
                continue
            if char == '<':
                raw_match = autolink_or_raw_html_re.match(buf, pos, p_end)
                if raw_match:
                    pos = raw_match.end()
                    continue
            if char == '!' and pos + 1 < p_end and buf[pos + 1] == '[':
                delim_stack.append(['img', pos, True])
                pos += 2
                continue
            if char == '[':
                delim_stack.append(['link', pos, True])
                pos += 1
                continue
            if char == ']':
                if not delim_stack:
                    pos += 1
                    continue
                kind, open_pos, active = delim_stack.pop()
                if not active:
                    pos += 1
                    continue
                if pos + 1 < p_end and buf[pos + 1] == '(':
                    parsed_dest = parse_inline_dest(buf, pos + 1, p_end, allow_empty_dest=True)
                    if parsed_dest is not None:
                        end_paren, url = parsed_dest
                        orig_start = orig_offsets[open_pos]
                        orig_end = orig_offsets[end_paren] + 1
                        if kind == 'img':
                            all_image_spans.append((orig_start, orig_end))
                            if url:
                                matched_images.append((orig_start, orig_end, url))
                        else:
                            for entry in delim_stack:
                                if entry[0] == 'link':
                                    entry[2] = False
                        pos = end_paren + 1
                        continue
                if ref_defs:
                    open_end = open_pos + (2 if kind == 'img' else 1)
                    ref_url = None
                    ref_end_idx = pos
                    shortcut_blocked = False
                    if pos + 1 < p_end and buf[pos + 1] == '[':
                        parsed_ref = _parse_cm_ref_label(buf, pos + 1, p_end)
                        if parsed_ref is not None:
                            ref_close, ref_raw = parsed_ref
                            shortcut_blocked = (ref_raw == '' or bool(_normalize_cm_link_label(ref_raw)))
                            if ref_raw == '':
                                inner_raw = buf[open_end:pos]
                                if _is_valid_cm_label_text(inner_raw):
                                    norm_key = _normalize_cm_link_label(inner_raw)
                                    if norm_key in ref_defs:
                                        ref_url = ref_defs[norm_key]
                                        ref_end_idx = ref_close
                            else:
                                norm_key = _normalize_cm_link_label(ref_raw)
                                if norm_key and norm_key in ref_defs:
                                    ref_url = ref_defs[norm_key]
                                    ref_end_idx = ref_close
                    if ref_url is None and not shortcut_blocked:
                        inner_raw = buf[open_end:pos]
                        if _is_valid_cm_label_text(inner_raw):
                            norm_key = _normalize_cm_link_label(inner_raw)
                            if norm_key in ref_defs:
                                ref_url = ref_defs[norm_key]
                                ref_end_idx = pos
                    if ref_url is not None:
                        orig_start = orig_offsets[open_pos]
                        orig_end = orig_offsets[ref_end_idx] + 1
                        if kind == 'img':
                            all_image_spans.append((orig_start, orig_end))
                            if ref_url:
                                matched_images.append((orig_start, orig_end, ref_url))
                        else:
                            for entry in delim_stack:
                                if entry[0] == 'link':
                                    entry[2] = False
                        pos = ref_end_idx + 1
                        continue
                pos += 1
                continue
            pos += 1
        top_level = [
            (s, e, url)
            for s, e, url in matched_images
            if not any(os <= s and e <= oe and (os, oe) != (s, e) for os, oe in all_image_spans)
        ]
        top_level.sort(key=lambda item: item[0])
        for item in top_level:
            yield item


def _dest_needs_angle_brackets(dest):
    if not dest or dest.startswith('<') or any(ord(c) <= 0x20 or ord(c) == 0x7f for c in dest):
        return True
    ascii_punctuation = set(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')
    depth = 0
    idx = 0
    length = len(dest)
    while idx < length:
        ch = dest[idx]
        if ch == '\\' and idx + 1 < length and dest[idx + 1] in ascii_punctuation:
            idx += 2
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            if depth == 0:
                return True
            depth -= 1
        idx += 1
    return depth != 0


def mask_markdown_image_alts(text):
    r"""在数学与格式扫描前遮住图片标签里的字节。

    图注里可能出现 ``f\[k\]`` 这类像 TeX 的字面量。它们必须保持转义，
    Markdown 才能正确解析图片；但正文里并没有这些公式，Hugo 也不会把
    这段文字渲染成 post-content 文本节点。
    """
    source = str(text)
    out = []
    cursor = 0
    for start, end, dest in _iter_markdown_images(source):
        out.append(source[cursor:start])
        pad = ' ' if dest.endswith('\\') else ''
        formatted_dest = f'<{dest}{pad}>' if _dest_needs_angle_brackets(dest) else f'{dest}{pad}'
        out.append(f'![]({formatted_dest})')
        cursor = end
    out.append(source[cursor:])
    return ''.join(out)


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
    from markdown_hugo_gate import (math_and_emphasis_issues, mask_rendered_symbolic_table_cells,
                                    mask_source_bound_figure_caption_dollars)

    page = Page(rendered)
    body = markdown
    if markdown.startswith('---\n'):
        from markdown_hugo_gate import parse_frontmatter_content
        frontmatter, body = parse_frontmatter_content('conference-page.md', markdown)
        tag_prefixes = [prefix for prefix in ('paper_digest_tags_', 'paper_digest_taxonomy_')
                        if any(key.startswith(prefix) for key in frontmatter)]
        if len(tag_prefixes) > 1:
            raise ValueError('单篇论文不能混用两套分类字段')
        tag_prefix = tag_prefixes[0] if tag_prefixes else 'paper_digest_tags_'
        tag_header = None
        if frontmatter.get('paper_digest_page_type') == 'paper' and tag_prefix+'contract' in frontmatter:
            tag_header = {'contract': frontmatter[tag_prefix+'contract']}
            if tag_prefix+'schema_fingerprint' in frontmatter:
                tag_header['schemaFingerprint'] = frontmatter[tag_prefix+'schema_fingerprint']
            if not protocols.has_valid_header(tag_header,'paper-tag-flat-tags'):
                raise ValueError('单篇论文分类格式或结构指纹不受支持')
        if tag_header is not None and protocols.format(tag_header['contract'],'paper-tag-flat-tags',
                                                       tag_header.get('schemaFingerprint')) == 'selected-preferred-labels':
            concepts = frontmatter.get(tag_prefix+'concepts')
            if not isinstance(concepts, list) or not concepts or len(page.tag_sections) != 1:
                raise ValueError('单篇论文须呈现且仅呈现一组当前多级分类')
            section = page.tag_sections[0]
            ids = [c.get('id') for c in concepts if isinstance(c, dict)]
            if len(ids) != len(concepts) or set(section['direct']) != set(ids) \
                    or len(section['direct']) != len(ids) \
                    or set(section['facets']) != {c.get('facet') for c in concepts} \
                    or any(str(c.get('label', '')) not in ''.join(section['text']) for c in concepts):
                raise ValueError('HTML多级分类的直接概念、标签或分面与本篇所选集合不一致')
            if not page.titles or not any(''.join(t).strip() for t in page.titles) \
                    or not page.h1s or not any(''.join(t).strip() for t in page.h1s):
                raise ValueError('当前论文页面缺少标题或H1')
    if len(page.canonicals) != 1:
        raise ValueError(f'HTML canonical URL 不唯一：实际 {len(page.canonicals)} 个')
    url = public_url(page.canonicals[0])
    body_for_format = mask_markdown_image_alts(body)
    # 走共用的确定性数学检查，这里不会真正执行 MathJax。
    text = ''.join(page.text)
    issues = math_and_emphasis_issues(body_for_format, 'Markdown')
    # 用可见文本核对 TeX 是否保留；表内字面量交给共用的 HTML 遮罩处理。
    rendered_body = mask_rendered_symbolic_table_cells(
        mask_source_bound_figure_caption_dollars(''.join(page.body_html), {'body': body}))
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
    if formulas and not page.has_math_rendering():
        raise ValueError('HTML 公式缺少数学渲染运行时或构建期 KaTeX SSR 输出；仅完成静态检查')
    # 图的替代文本里可能有转义或配对的 Markdown 方括号，例如 ``\[b\]`` 或 ``[a]``。
    # 用 CommonMark 扫描器提取已去空白、去尖括号、去可选标题的真实 URL。
    expected = [dest for _start, _end, dest in _iter_markdown_images(body)]
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
            'pageIdentityContract': protocols.contract('conference-visible-page-identity'),
            'pageIdentitySchemaFingerprint': protocols.schema_fingerprint('conference-visible-page-identity'),
            'pageIdentitySha256': digest(json.dumps(page.page_identity_fields(), ensure_ascii=False, sort_keys=True).encode()),
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
                or (expected['formulaCount'] and not page.has_math_rendering()):
            raise ValueError(f'线上正文/图片/表格/公式未匹配已审 HTML：已审摘要 {expected["projectionSha256"]}，线上摘要 {visible_content_sha256}')
        if 'pageIdentityContract' in expected or 'pageIdentitySha256' in expected:
            identity_sha = digest(json.dumps(page.page_identity_fields(), ensure_ascii=False, sort_keys=True).encode())
            identity_header = {'contract': expected.get('pageIdentityContract')}
            if 'pageIdentitySchemaFingerprint' in expected:
                identity_header['schemaFingerprint'] = expected['pageIdentitySchemaFingerprint']
            if not protocols.has_valid_header(identity_header, 'conference-visible-page-identity') \
                    or not re.fullmatch(r'[a-f0-9]{64}', str(expected.get('pageIdentitySha256', ''))) \
                    or identity_sha != expected['pageIdentitySha256']:
                raise ValueError('线上标题、H1或多级研究分类与已审HTML不一致')

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
    return {'status': 'passed', **mechanical_gate_header(), 'checks': checks,
            'semanticReview': 'not_performed', 'visualInspection': 'not_performed'}


def validate_png(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        if image.format != 'PNG' or image.width <= 0 or image.height <= 0:
            raise ValueError(f'图片不是可解码 PNG：format={image.format!r}，{image.width}x{image.height}')
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()

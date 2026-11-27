"""教程页面的 Markdown 格式与 Hugo 渲染检查。

这些函数只读取页面源码或渲染结果，检查时不修改页面内容。
"""

import html
from html.parser import HTMLParser
import re
import sys
from pathlib import Path

MANUAL_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / 'manual' / 'scripts'
if str(MANUAL_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(MANUAL_SCRIPTS_DIR))

from publish_common import (
    MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
    PublishDataValidationError,
    publish_table_currency_spans,
    is_publish_currency_literal,
    is_publish_currency_unit_literal,
    mask_protected_markdown_table_regions,
    escape_literal_source_figure_caption_dollars,
    markdown_inline_code_ranges,
    parse_markdown_images,
    extract_markdown_tables,
)
from tutorial_payload_verifier import (
    FRESH_AUTHORING_CONTRACT,
    MANUAL_TUTORIAL_PAYLOAD_CONTRACT,
    TUTORIAL_FORMAT_CONTRACT,
)


TUTORIAL_SCORE_DIMENSIONS = (
    ('创新', '2'),
    ('技术严谨', '1.5'),
    ('实验充分', '1.5'),
    ('清晰度', '1'),
    ('影响力', '1.5'),
    ('开源', '1.5'),
    ('可复现', '0.5'),
    ('工程/实践', '1.5'),
)


def parse_frontmatter_content(path, content):
    """从已读入的 UTF-8 文本解析页面开头的 YAML 字段，不读写页面文件。"""
    path = Path(path)
    try:
        import yaml
    except ImportError as exc:
        raise PublishDataValidationError(
            '缺少 PyYAML，无法检查页面开头的 YAML 字段'
        ) from exc

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in mapping:
                raise PublishDataValidationError(
                    f'{path.name} frontmatter 存在重复字段: {key}'
                )
            mapping[key] = loader.construct_object(value_node, deep=deep)
        return mapping

    UniqueKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
        construct_mapping,
    )
    match = re.match(r'^---\n(.*?)\n---\n', content, flags=re.DOTALL)
    if not match:
        raise PublishDataValidationError(f'{path.name} 缺少合法 YAML frontmatter')
    try:
        frontmatter = yaml.load(match.group(1), Loader=UniqueKeyLoader)
    except (yaml.YAMLError, PublishDataValidationError) as exc:
        raise PublishDataValidationError(
            f'{path.name} YAML 解析失败: {exc}'
        ) from exc
    if not isinstance(frontmatter, dict):
        raise PublishDataValidationError(f'{path.name} frontmatter 必须是对象')
    return frontmatter, content[match.end():]


def load_frontmatter(path):
    path = Path(path)
    content = path.read_text(encoding='utf-8')
    return parse_frontmatter_content(path, content)


def strip_fenced_code_for_format_gate(text):
    """排除围栏代码：其中的定界符是字面示例，不是语法。"""
    return re.sub(
        r'(^|\n)(?:```|~~~).*?(?:\n(?:```|~~~)(?=\n|$)|\Z)',
        r'\1', text, flags=re.DOTALL,
    )


def format_gate_is_current_tutorial(frontmatter):
    return (
        isinstance(frontmatter, dict)
        and frontmatter.get('paper_digest_tutorial_contract')
        == TUTORIAL_FORMAT_CONTRACT
    )


def format_gate_is_current_api_reader(frontmatter):
    import protocol_codec
    if not isinstance(frontmatter, dict):
        return False
    value = _reader_projected_header(frontmatter, 'paper_digest_api_reader')
    if not protocol_codec.has_valid_header(value, 'beginner-researcher'):
        if 'schemaFingerprint' in value or value['contract'] == protocol_codec.contract('beginner-researcher'):
            raise PublishDataValidationError('页面 Reader 格式缺少正确的结构指纹。')
        return False
    return protocol_codec.format(value['contract'], 'beginner-researcher', value.get('schemaFingerprint')) == 'integrated-article'


def _reader_projected_header(frontmatter, prefix):
    marker = prefix + '_schema_fingerprint'
    return {'contract': frontmatter.get(prefix + '_contract'),
            **({'schemaFingerprint': frontmatter[marker]} if marker in frontmatter else {})}


def markdown_table_count(text):
    """按 Goldmark 的渲染方式统计连续的 Markdown 表格块。

    在一段不中断的管道块里重复出现分隔行，在 Hugo 中仍属于同一张表；
    逐个分隔行计数会高估应有的 HTML。围栏代码块内的管道行与缺少表头的
    孤立分隔行在 Goldmark 中均不渲染为表格，因此不计入。
    """
    count = 0
    block_rows = 0
    has_separator = False
    fence = None
    for line in str(text or '').splitlines():
        if fence is not None:
            fence_char, fence_len = fence
            close_re = rf' {{0,3}}{re.escape(fence_char)}{{{fence_len},}}[ \t]*$'
            if re.fullmatch(close_re, line):
                fence = None
            continue
        opened = re.match(r'^ {0,3}(`{3,}|~{3,})([^\r\n]*)$', line)
        if opened and not (opened.group(1)[0] == '`' and '`' in opened.group(2)):
            if block_rows >= 1 and has_separator:
                count += 1
            block_rows = 0
            has_separator = False
            fence = (opened.group(1)[0], len(opened.group(1)))
            continue
        is_pipe_row = bool(re.match(r'^\s*\|.*\|\s*$', line))
        if not is_pipe_row:
            if block_rows >= 1 and has_separator:
                count += 1
            block_rows = 0
            has_separator = False
            continue
        if re.match(r'^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$', line):
            if block_rows >= 1:
                has_separator = True
        else:
            block_rows += 1
    if block_rows >= 1 and has_separator:
        count += 1
    return count


def markdown_image_count(text):
    return len(parse_markdown_images(str(text or '')))


def heading_figure_table_number_issues(text, label):
    """图/表应放在图注里，绝不能出现在读者章节标题中。"""
    issues = []
    heading_re = re.compile(r'^#{1,6}\s+(.+?)\s*#*\s*$', re.MULTILINE)
    marker_re = re.compile(
        r'(?<![A-Za-z0-9])(?:图|Figure|表|Table)\s*\d+\b', re.IGNORECASE,
    )
    markdown_headings = heading_re.findall(text)
    headings = markdown_headings if markdown_headings else text.splitlines()
    for heading in headings:
        if marker_re.search(heading):
            issues.append(
                f'{label} 章节标题不得包含图/表编号: {heading.strip()}'
            )
    return issues


def _html_line_offsets(text):
    # HTMLParser 的行号只按 LF 递增；Unicode 分隔符、CR 和 VT 不能另算一行。
    return [0, *(match.end() for match in re.finditer('\n', text))]


_HTML_VOID_TAGS = frozenset({
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
})
_FORBIDDEN_CODE_ANCESTORS = frozenset({
    'script', 'style', 'textarea', 'template', 'noscript', 'svg', 'math',
})
_FORBIDDEN_MATH_ANCESTORS = frozenset({
    'script', 'style', 'textarea', 'template', 'noscript', 'svg',
})
_MATHML_ALLOWED_TAGS = frozenset({
    'math', 'semantics', 'annotation', 'annotation-xml',
    'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms',
    'mfrac', 'msqrt', 'mroot', 'mstyle', 'mpadded', 'mphantom',
    'mfenced', 'menclose',
    'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover',
    'mmultiscripts', 'mprescripts', 'none',
    'mtable', 'mtr', 'mlabeledtr', 'mtd', 'maligngroup', 'malignmark',
    'maction', 'mglyph',
    'mstack', 'mlongdiv', 'msgroup', 'msrow', 'mscarries', 'mscarry', 'msline',
})
_KATEX_SVG_ALLOWED_TAGS = frozenset({
    'svg', 'path', 'line', 'rect', 'circle', 'ellipse',
    'polygon', 'polyline', 'g', 'defs', 'use',
})
_KATEX_SVG_VISIBLE_TAGS = frozenset({
    'path', 'line', 'rect', 'circle', 'ellipse',
    'polygon', 'polyline', 'use',
})
_KATEX_WRAPPER_CLASSES = frozenset({'katex', 'katex-display'})
_KATEX_PAYLOAD_CLASSES = frozenset({'katex-html', 'katex-mathml'})
_KATEX_ANY_CLASSES = frozenset({'katex', 'katex-display', 'katex-html', 'katex-mathml'})
_DISPLAY_ALLOWED_PARENTS = frozenset({
    'div', 'section', 'article', 'main', 'blockquote', 'li', 'dd', 'details',
})
_DISPLAY_ALLOWED_ANCESTORS = frozenset({
    'div', 'section', 'article', 'main', 'blockquote', 'ul', 'ol', 'li',
    'dl', 'dd', 'details', 'body', 'html',
})
_DISPLAY_BLOCK_SIBLING_TAGS = _DISPLAY_ALLOWED_ANCESTORS | frozenset({
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'hr',
    'figure', 'figcaption', 'summary', 'dt', 'header', 'footer',
    'nav', 'aside', 'address', 'form', 'script', 'style', 'audio', 'video',
})
_INLINE_VOID_TAGS = frozenset({'img', 'br', 'wbr', 'input'})
_RAWTEXT_RCDATA_TAGS = frozenset({
    'script', 'style', 'textarea', 'title', 'xmp', 'iframe',
    'noembed', 'noframes', 'plaintext',
})
_DISPLAY_BARRIER_TAGS = _RAWTEXT_RCDATA_TAGS | frozenset({
    'template', 'noscript', 'svg', 'math', 'pre', 'code', 'table',
    'object', 'marquee', 'applet', 'caption', 'td', 'th',
})


def _has_katex_error_class(attrs):
    return any(
        key == 'class'
        and any(tok.lower() == 'katex-error' for tok in str(val or '').split())
        for key, val in attrs
    )


def _is_hidden_style_or_attr(attrs_map, *, check_aria_hidden=True):
    if 'hidden' in attrs_map:
        return True
    if check_aria_hidden and str(attrs_map.get('aria-hidden') or '').strip().lower() == 'true':
        return True
    style = str(attrs_map.get('style') or '')
    if not style:
        return False
    cleaned = re.sub(r'/\*.*?(?:\*/|\Z)', '', style, flags=re.S)
    return bool(re.search(
        r'(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)',
        cleaned,
        re.I,
    ))


def extract_rendered_display_formulas(text):
    """Extract verbatim inner TeX strings from closed KaTeX SSR display formulas.

    Returns a list of decoded inner TeX strings (one per valid display formula)
    in document order, or None if HTML parsing fails (fail-closed).

    Recognizes only two authentic Hugo/KaTeX SSR block-passthrough forms, both
    strictly nested inside block containers (never inline/hidden/inert trees):
      1. Closed `<span class="... katex-display ...">` matching the exact KaTeX
         display skeleton: a single `<span class="katex">` containing a single
         `<span class="katex-mathml">` -> `<math display="block">` ->
         `<semantics>` (with visual MathML child + exactly one
         `<annotation encoding="application/x-tex">`) AND a single non-empty
         visible `<span class="katex-html">`, with zero errors or invalid tags.
      2. Closed block-level `<code class="... math-fallback ...">` emitted by
         `render_katex_formula.html` when KaTeX rejects an unsupported source
         TeX macro (e.g. `\\vskip`), containing non-empty plain text only, with
         no inline sibling text or phrasing elements in its enclosing container.
    """
    text = str(text or '')
    if 'katex-display' not in text and 'math-fallback' not in text:
        return []
    offsets = _html_line_offsets(text)

    class DisplayFormulas(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.stack = []
            self.tag_positions = {}
            self.barrier_indices = []
            self.hidden_depth = 0
            self.disallowed_ancestor_depth = 0
            self.foreign_depth = 0
            self.active_display = None
            self.active_fallback = None
            self.root_frame = {
                'run_has_inline': False,
                'run_pending_fallbacks': [],
                'confirmed_fallbacks': [],
            }
            self.formulas = []

        def position_offset(self):
            line, column = self.getpos()
            return offsets[line - 1] + column

        def _current_container(self):
            return self.stack[-1] if self.stack else self.root_frame

        def _flush_inline_run(self, container):
            if not container['run_has_inline']:
                container['confirmed_fallbacks'].extend(container['run_pending_fallbacks'])
            container['run_pending_fallbacks'].clear()
            container['run_has_inline'] = False

        def _mark_inline_in_run(self, container):
            container['run_has_inline'] = True
            container['run_pending_fallbacks'].clear()

        def _push_frame(self, tag, *, hidden=False, poison=False, class_tokens=frozenset(), inside_active=False):
            idx = len(self.stack)
            disallowed = (
                poison
                or hidden
                or tag not in _DISPLAY_ALLOWED_ANCESTORS
                or (not inside_active and bool(class_tokens & _KATEX_ANY_CLASSES))
            )
            is_barrier = bool(hidden or poison or tag in _DISPLAY_BARRIER_TAGS)
            is_foreign = tag in {'svg', 'math'}
            frame = {
                'tag': tag,
                'hidden': hidden or poison,
                'disallowed': disallowed,
                'is_barrier': is_barrier,
                'is_foreign': is_foreign,
                'run_has_inline': False,
                'run_pending_fallbacks': [],
                'confirmed_fallbacks': [],
            }
            self.stack.append(frame)
            self.tag_positions.setdefault(tag, []).append(idx)
            if is_barrier:
                self.barrier_indices.append(idx)
            if frame['hidden']:
                self.hidden_depth += 1
            if frame['disallowed']:
                self.disallowed_ancestor_depth += 1
            if is_foreign:
                self.foreign_depth += 1

        def _pop_frame(self):
            frame = self.stack.pop()
            self.tag_positions[frame['tag']].pop()
            if frame['is_barrier']:
                self.barrier_indices.pop()
            if frame['hidden']:
                self.hidden_depth -= 1
            if frame['disallowed']:
                self.disallowed_ancestor_depth -= 1
            if frame['is_foreign']:
                self.foreign_depth -= 1
            return frame

        def _commit_container_fallbacks(self, container):
            self._flush_inline_run(container)
            for slot, value in container['confirmed_fallbacks']:
                self.formulas[slot] = value
            container['confirmed_fallbacks'].clear()

        def _invalidate_active(self):
            if self.active_display is not None:
                self.active_display['valid'] = False
            if self.active_fallback is not None:
                self.active_fallback['valid'] = False

        def _clear_active_above(self, depth):
            if self.active_display is not None:
                ad = self.active_display
                if ad['annotation'] is not None and depth <= ad['annotation']['depth']:
                    ad['valid'] = False
                    ad['annotation'] = None
                if ad['semantics'] is not None and depth <= ad['semantics']['depth']:
                    ad['valid'] = False
                    ad['semantics'] = None
                if ad['math_block'] is not None and depth <= ad['math_block']['depth']:
                    ad['valid'] = False
                    ad['math_block'] = None
                if ad['mathml_depth'] is not None and depth <= ad['mathml_depth']:
                    ad['mathml_depth'] = None
                if ad['katex_html_depth'] is not None and depth <= ad['katex_html_depth']:
                    ad['katex_html_depth'] = None
                if ad['katex_depth'] is not None and depth <= ad['katex_depth']:
                    ad['katex_depth'] = None
                if depth <= ad['depth']:
                    self.active_display = None
            if self.active_fallback is not None and depth <= self.active_fallback['depth']:
                self.active_fallback = None

        def handle_starttag(self, tag, attrs):
            attr_map = dict(attrs)
            unique_attrs = len(attr_map) == len(attrs)
            class_tokens = set(str(attr_map.get('class') or '').split())
            has_katex_error = _has_katex_error_class(attrs)

            if self.active_fallback is not None:
                self.active_fallback['valid'] = False
                if tag not in _HTML_VOID_TAGS:
                    self._push_frame(tag, hidden=False, inside_active=True)
                return

            if self.active_display is not None:
                ad = self.active_display
                in_katex_html = ad['katex_html_depth'] is not None
                hidden_desc = _is_hidden_style_or_attr(
                    attr_map, check_aria_hidden=not in_katex_html,
                )
                if (not unique_attrs or has_katex_error
                        or tag in _HTML_VOID_TAGS
                        or 'katex-display' in class_tokens):
                    ad['valid'] = False
                elif ad['annotation'] is not None:
                    ad['valid'] = False
                elif ad['math_depth'] > 0:
                    if (tag not in _MATHML_ALLOWED_TAGS
                            or tag == 'math'
                            or hidden_desc):
                        ad['valid'] = False
                    elif tag == 'semantics':
                        if (ad['math_block'] is not None
                                and len(self.stack) == ad['math_block']['depth'] + 1
                                and not ad['saw_semantics']):
                            ad['saw_semantics'] = True
                            ad['semantics'] = {
                                'depth': len(self.stack),
                                'has_visual_child': False,
                                'saw_tex_annotation': False,
                            }
                        else:
                            ad['valid'] = False
                    elif tag in {'annotation', 'annotation-xml'}:
                        if (ad['semantics'] is not None
                                and len(self.stack) == ad['semantics']['depth'] + 1
                                and tag == 'annotation'
                                and attr_map.get('encoding') == 'application/x-tex'
                                and not ad['semantics']['saw_tex_annotation']):
                            ad['semantics']['saw_tex_annotation'] = True
                            ad['annotation'] = {
                                'depth': len(self.stack),
                                'parts': [],
                            }
                        else:
                            ad['valid'] = False
                    elif ad['semantics'] is None:
                        ad['valid'] = False
                    elif len(self.stack) == ad['semantics']['depth'] + 1:
                        ad['semantics']['has_visual_child'] = True
                elif ad['svg_depth'] > 0:
                    if (tag not in _KATEX_SVG_ALLOWED_TAGS
                            or tag == 'svg'
                            or hidden_desc):
                        ad['valid'] = False
                    elif tag in _KATEX_SVG_VISIBLE_TAGS and ad['defs_depth'] == 0:
                        ad['katex_html_has_content'] = True
                elif in_katex_html:
                    if (tag not in {'span', 'svg'}
                            or bool(class_tokens & _KATEX_ANY_CLASSES)
                            or hidden_desc):
                        ad['valid'] = False
                else:
                    # Exact structural skeleton:
                    # katex-display -> katex -> (katex-mathml -> math[display=block], katex-html)
                    if len(self.stack) == ad['depth'] + 1:
                        if (tag == 'span' and 'katex' in class_tokens
                                and 'katex-mathml' not in class_tokens
                                and 'katex-html' not in class_tokens
                                and not ad['saw_katex']
                                and not hidden_desc):
                            ad['saw_katex'] = True
                            ad['katex_depth'] = len(self.stack)
                        else:
                            ad['valid'] = False
                    elif (ad['katex_depth'] is not None
                            and len(self.stack) == ad['katex_depth'] + 1
                            and tag == 'span'):
                        if ('katex-mathml' in class_tokens
                                and 'katex-html' not in class_tokens
                                and 'katex' not in class_tokens
                                and not ad['saw_mathml']
                                and not hidden_desc):
                            ad['saw_mathml'] = True
                            ad['mathml_depth'] = len(self.stack)
                        elif ('katex-html' in class_tokens
                                and 'katex-mathml' not in class_tokens
                                and 'katex' not in class_tokens
                                and not ad['saw_katex_html']
                                and not _is_hidden_style_or_attr(
                                    attr_map, check_aria_hidden=False)):
                            ad['saw_katex_html'] = True
                            ad['katex_html_depth'] = len(self.stack)
                        else:
                            ad['valid'] = False
                    elif (ad['mathml_depth'] is not None
                            and len(self.stack) == ad['mathml_depth'] + 1
                            and tag == 'math'
                            and str(attr_map.get('display') or '').strip().lower() == 'block'
                            and not ad['saw_math_block']
                            and not hidden_desc):
                        ad['saw_math_block'] = True
                        ad['math_block'] = {'depth': len(self.stack)}
                    else:
                        ad['valid'] = False

                if tag not in _HTML_VOID_TAGS:
                    self._push_frame(tag, hidden=False, inside_active=True)
                    if tag == 'math':
                        ad['math_depth'] += 1
                    elif tag == 'svg':
                        ad['svg_depth'] += 1
                    elif tag == 'defs' and ad['svg_depth'] > 0:
                        ad['defs_depth'] += 1
                return

            if tag in _HTML_VOID_TAGS:
                if tag in _INLINE_VOID_TAGS:
                    self._mark_inline_in_run(self._current_container())
                elif tag in {'hr'}:
                    self._flush_inline_run(self._current_container())
                return

            hidden = _is_hidden_style_or_attr(attr_map)
            poison = (
                has_katex_error
                or tag == 'merror'
                or not unique_attrs
            )
            parent_ok = (not self.stack or self.stack[-1]['tag'] in _DISPLAY_ALLOWED_PARENTS)
            is_display_span = (
                tag == 'span' and 'katex-display' in class_tokens
                and not poison and not hidden and self.hidden_depth == 0
                and self.disallowed_ancestor_depth == 0
                and parent_ok
            )
            is_block_fallback = (
                tag == 'code' and 'math-fallback' in class_tokens
                and not poison and not hidden and self.hidden_depth == 0
                and self.disallowed_ancestor_depth == 0
                and parent_ok
            )
            if is_display_span:
                self.active_display = {
                    'depth': len(self.stack),
                    'valid': True,
                    'saw_katex': False,
                    'katex_depth': None,
                    'saw_mathml': False,
                    'mathml_depth': None,
                    'saw_katex_html': False,
                    'katex_html_depth': None,
                    'katex_html_has_content': False,
                    'saw_math_block': False,
                    'math_block': None,
                    'saw_semantics': False,
                    'semantics': None,
                    'annotation': None,
                    'annotations': [],
                    'math_depth': 0,
                    'svg_depth': 0,
                    'defs_depth': 0,
                }
            elif is_block_fallback:
                self.active_fallback = {
                    'depth': len(self.stack),
                    'valid': True,
                    'parts': [],
                }
            elif tag in _DISPLAY_BLOCK_SIBLING_TAGS:
                self._flush_inline_run(self._current_container())
            else:
                self._mark_inline_in_run(self._current_container())

            self._push_frame(
                tag,
                hidden=hidden,
                poison=poison,
                class_tokens=class_tokens,
                inside_active=(is_display_span or is_block_fallback),
            )

        def handle_startendtag(self, tag, attrs):
            attr_map = dict(attrs)
            unique_attrs = len(attr_map) == len(attrs)
            class_tokens = set(str(attr_map.get('class') or '').split())
            has_katex_error = _has_katex_error_class(attrs)
            if self.active_fallback is not None:
                self.active_fallback['valid'] = False
                return
            if self.active_display is not None:
                ad = self.active_display
                if ad['annotation'] is not None:
                    ad['valid'] = False
                    return
                hidden_desc = _is_hidden_style_or_attr(
                    attr_map, check_aria_hidden=(ad['katex_html_depth'] is None),
                )
                allowed = (
                    (ad['math_depth'] > 0
                     and ad['semantics'] is not None
                     and tag in _MATHML_ALLOWED_TAGS
                     and tag not in {'math', 'semantics', 'annotation', 'annotation-xml'})
                    or (ad['svg_depth'] > 0
                        and tag in _KATEX_SVG_ALLOWED_TAGS
                        and tag != 'svg')
                )
                if not allowed or not unique_attrs or has_katex_error or hidden_desc:
                    ad['valid'] = False
                elif ad['svg_depth'] > 0:
                    if tag in _KATEX_SVG_VISIBLE_TAGS and ad['defs_depth'] == 0:
                        ad['katex_html_has_content'] = True
                elif (ad['semantics'] is not None
                        and len(self.stack) == ad['semantics']['depth'] + 1):
                    ad['semantics']['has_visual_child'] = True
                return

            if tag in _HTML_VOID_TAGS:
                if tag in _INLINE_VOID_TAGS:
                    self._mark_inline_in_run(self._current_container())
                elif tag in {'hr'}:
                    self._flush_inline_run(self._current_container())
                return
            if self.foreign_depth > 0:
                return
            # In HTML5, trailing '/' on non-void HTML elements does not self-close
            # them. Push the opened frame (poisoned for rawtext/RCDATA/foreign/formula
            # tags) without ever activating display/fallback extraction.
            if tag not in _DISPLAY_BLOCK_SIBLING_TAGS:
                self._mark_inline_in_run(self._current_container())
            hidden = _is_hidden_style_or_attr(attr_map)
            poison = (
                has_katex_error
                or tag == 'merror'
                or not unique_attrs
                or tag in _RAWTEXT_RCDATA_TAGS
                or tag in {'svg', 'math'}
                or 'katex-display' in class_tokens
                or 'math-fallback' in class_tokens
            )
            self._push_frame(tag, hidden=hidden, poison=poison, class_tokens=class_tokens)

        def handle_data(self, data):
            if self.active_fallback is not None:
                self.active_fallback['parts'].append(data)
            elif self.active_display is not None:
                ad = self.active_display
                if ad['annotation'] is not None:
                    ad['annotation']['parts'].append(data)
                elif ad['svg_depth'] > 0:
                    if data.strip():
                        ad['valid'] = False
                elif ad['katex_html_depth'] is not None:
                    if data.strip():
                        ad['katex_html_has_content'] = True
                elif ad['math_depth'] > 0:
                    if ad['semantics'] is None and data.strip():
                        ad['valid'] = False
                elif data.strip():
                    ad['valid'] = False
            elif data.strip():
                self._mark_inline_in_run(self._current_container())

        def handle_entityref(self, name):
            self.handle_data(html.unescape(f'&{name};'))

        def handle_charref(self, name):
            self.handle_data(html.unescape(f'&#{name};'))

        def handle_comment(self, _data):
            self._invalidate_active()

        def handle_decl(self, _decl):
            self._invalidate_active()

        def handle_pi(self, _data):
            self._invalidate_active()

        def unknown_decl(self, _data):
            self._invalidate_active()

        def handle_endtag(self, tag):
            if tag in _HTML_VOID_TAGS:
                return
            if not self.stack or self.stack[-1]['tag'] != tag:
                self._invalidate_active()
                positions = self.tag_positions.get(tag)
                if not positions:
                    return
                target = positions[-1]
                # Never unwind across hidden/poison/inert/foreign/rawtext barriers.
                if self.barrier_indices and target < self.barrier_indices[-1]:
                    return
                while self.stack:
                    popped = self._pop_frame()
                    if self.active_display is not None:
                        if popped['tag'] == 'math':
                            self.active_display['math_depth'] = max(
                                0, self.active_display['math_depth'] - 1)
                        elif popped['tag'] == 'svg':
                            self.active_display['svg_depth'] = max(
                                0, self.active_display['svg_depth'] - 1)
                        elif popped['tag'] == 'defs':
                            self.active_display['defs_depth'] = max(
                                0, self.active_display['defs_depth'] - 1)
                    self._clear_active_above(len(self.stack))
                    if popped['tag'] == tag:
                        break
                return

            start = self.position_offset()
            end = text.find('>', start)
            raw = text[start:end + 1] if end >= 0 else ''
            valid_close = bool(re.fullmatch(r'</\s*' + re.escape(tag) + r'\s*>', raw, re.I))
            if not valid_close:
                self._invalidate_active()

            popped = self._pop_frame()
            new_depth = len(self.stack)

            if self.active_fallback is not None and new_depth == self.active_fallback['depth']:
                fb = self.active_fallback
                self.active_fallback = None
                if fb['valid'] and valid_close:
                    value = ''.join(fb['parts'])
                    if value.strip():
                        slot = len(self.formulas)
                        self.formulas.append(None)
                        self._current_container()['run_pending_fallbacks'].append((slot, value))
                else:
                    self._mark_inline_in_run(self._current_container())
                return

            if self.active_display is not None:
                ad = self.active_display
                if popped['tag'] == 'math':
                    ad['math_depth'] -= 1
                elif popped['tag'] == 'svg':
                    ad['svg_depth'] -= 1
                elif popped['tag'] == 'defs' and ad['defs_depth'] > 0:
                    ad['defs_depth'] -= 1
                if ad['annotation'] is not None and new_depth == ad['annotation']['depth']:
                    if ad['valid'] and valid_close:
                        ad['annotations'].append(''.join(ad['annotation']['parts']))
                    ad['annotation'] = None
                if ad['semantics'] is not None and new_depth == ad['semantics']['depth']:
                    sem = ad['semantics']
                    if not (sem['has_visual_child'] and sem['saw_tex_annotation']):
                        ad['valid'] = False
                    ad['semantics'] = None
                if ad['math_block'] is not None and new_depth == ad['math_block']['depth']:
                    ad['math_block'] = None
                if ad['mathml_depth'] is not None and new_depth == ad['mathml_depth']:
                    ad['mathml_depth'] = None
                if ad['katex_html_depth'] is not None and new_depth == ad['katex_html_depth']:
                    ad['katex_html_depth'] = None
                if ad['katex_depth'] is not None and new_depth == ad['katex_depth']:
                    ad['katex_depth'] = None
                if new_depth == ad['depth']:
                    self.active_display = None
                    if (ad['valid'] and valid_close
                            and ad['saw_katex_html']
                            and ad['katex_html_has_content']
                            and len(ad['annotations']) == 1
                            and ad['annotations'][0].strip()):
                        self.formulas.append(ad['annotations'][0])
                    else:
                        self._mark_inline_in_run(self._current_container())
                return

            if valid_close:
                self._commit_container_fallbacks(popped)

    parser = DisplayFormulas()
    try:
        parser.feed(text)
        parser.close()
    except Exception:
        return None
    parser._commit_container_fallbacks(parser.root_frame)
    return [item for item in parser.formulas if item is not None]


def _rendered_currency_dollar_positions(text):
    """保留 HTML td/th 的父元素身份，不把单元格当正文。

    只有真实表格行里的直接纯文本才算数。嵌套标记、注释、公式和多个美元
    符号都不继承货币例外。这里产出的是只读诊断视图，绝不改动渲染字节。
    """
    if '$' not in text:
        return set()
    offsets = _html_line_offsets(text)

    class CurrencyCells(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.stack = []
            self.tag_counts = {}
            self.cell = None
            self.positions = set()

        def handle_starttag(self, tag, attrs):
            if self.cell is not None:
                self.cell['valid'] = False
            if (tag in ('td', 'th') and self.stack and self.stack[-1] == 'tr'
                    and self.tag_counts.get('table', 0) > 0):
                self.cell = {'tag': tag, 'valid': True, 'parts': []}
            if tag not in _HTML_VOID_TAGS:
                self.stack.append(tag)
                self.tag_counts[tag] = self.tag_counts.get(tag, 0) + 1

        def handle_data(self, data):
            if self.cell is not None:
                line, column = self.getpos()
                self.cell['parts'].append((offsets[line - 1] + column, data))

        def handle_endtag(self, tag):
            if self.cell is not None and tag == self.cell['tag']:
                parts = self.cell['parts']
                value = ''.join(data for _position, data in parts)
                if self.cell['valid'] and parts and (is_publish_currency_literal(value)
                        or is_publish_currency_unit_literal(value)):
                    for position, data in parts:
                        if '$' in data:
                            self.positions.add(position + data.index('$'))
                self.cell = None
            if self.tag_counts.get(tag, 0) > 0:
                while self.stack:
                    popped = self.stack.pop()
                    self.tag_counts[popped] -= 1
                    if popped == tag:
                        break

        def handle_comment(self, data):
            if self.cell is not None:
                self.cell['valid'] = False

        def handle_decl(self, decl):
            self.handle_comment(decl)

        def handle_pi(self, data):
            self.handle_comment(data)

        def unknown_decl(self, data):
            self.handle_comment(data)

        def handle_entityref(self, name):
            if self.cell is not None:
                self.cell['valid'] = False

        def handle_charref(self, name):
            self.handle_entityref(name)

    parser = CurrencyCells()
    parser.feed(text)
    parser.close()
    return parser.positions


def mask_closed_code_for_format_gate(text, *, rendered_html=False):
    """Mask only actual closed code/math/KaTeX nodes in a diagnostic copy, never bytes.

    Markdown spans reuse the existing Reader CommonMark delimiter/paragraph
    scanner (never masking HTML spans or MathML in raw Markdown).
    Rendered HTML uses a single-pass O(n) parser that masks only truly closed,
    properly nested `<code>`/`<pre>`, valid MathML `<math>`, and KaTeX SSR
    `<span class="katex">` / `<span class="katex-display">` subtrees; escaped
    markup, attributes elsewhere, unclosed tags, error nodes (`<merror>`,
    `katex-error`), and mismatched nesting never acquire an exemption.
    """
    text = str(text or '')
    if not rendered_html:
        ranges = markdown_inline_code_ranges(text)
    else:
        class ClosedFormatNodes(HTMLParser):
            def __init__(self):
                super().__init__(convert_charrefs=False)
                self.stack = []
                self.nodes = []
                self.starts = _html_line_offsets(text)
                self.code_depth = 0
                self.math_depth = 0
                self.katex_depth = 0
                self.svg_depth = 0

            def position_offset(self):
                line, column = self.getpos()
                return self.starts[line - 1] + column

            def _invalidate_all(self):
                if self.stack:
                    top = self.stack[-1]
                    top['valid'] = False
                    top['prop_invalid'] = True

            def _invalidate_code(self):
                if self.code_depth and self.stack:
                    top = self.stack[-1]
                    top['prop_code_invalid'] = True
                    if top['tag'] in {'code', 'pre'}:
                        top['code_valid'] = False

            def _invalidate_math(self):
                if self.math_depth and self.stack:
                    top = self.stack[-1]
                    top['prop_math_invalid'] = True
                    if top['tag'] == 'math':
                        top['math_valid'] = False

            def _invalidate_katex(self):
                if self.katex_depth and self.stack:
                    top = self.stack[-1]
                    top['prop_katex_invalid'] = True
                    if top['is_katex_root']:
                        top['katex_valid'] = False

            def handle_starttag(self, tag, attrs):
                attr_map = dict(attrs)
                unique_attrs = len(attr_map) == len(attrs)
                class_tokens = set(str(attr_map.get('class') or '').split())
                has_katex_error = _has_katex_error_class(attrs)

                if self.code_depth and tag not in {'code', 'span'}:
                    self._invalidate_code()
                if self.math_depth and (
                        tag not in _MATHML_ALLOWED_TAGS or has_katex_error or not unique_attrs):
                    self._invalidate_math()
                if self.katex_depth:
                    if has_katex_error or not unique_attrs:
                        self._invalidate_katex()
                    elif self.math_depth:
                        if tag not in _MATHML_ALLOWED_TAGS:
                            self._invalidate_katex()
                    elif self.svg_depth:
                        if tag not in _KATEX_SVG_ALLOWED_TAGS:
                            self._invalidate_katex()
                    elif tag not in {'span', 'math', 'svg'}:
                        self._invalidate_katex()

                if tag in _HTML_VOID_TAGS:
                    return

                is_katex_root = (
                    tag == 'span' and unique_attrs and not has_katex_error
                    and bool(class_tokens & _KATEX_WRAPPER_CLASSES)
                )
                is_katex_payload = (
                    tag == 'math'
                    or (tag == 'span' and unique_attrs and not has_katex_error
                        and bool(class_tokens & _KATEX_PAYLOAD_CLASSES))
                )
                node = {
                    'idx': len(self.nodes),
                    'parent': self.stack[-1]['idx'] if self.stack else -1,
                    'tag': tag,
                    'start': self.position_offset(),
                    'end': None,
                    'valid': unique_attrs,
                    'code_valid': True,
                    'math_valid': tag == 'math' and unique_attrs and not has_katex_error,
                    'katex_valid': is_katex_root,
                    'is_katex_root': is_katex_root,
                    'is_katex_payload': is_katex_payload,
                    'has_katex_payload': False,
                    'prop_invalid': False,
                    'prop_code_invalid': False,
                    'prop_math_invalid': False,
                    'prop_katex_invalid': False,
                }
                self.nodes.append(node)
                self.stack.append(node)
                if tag in {'code', 'pre'}:
                    self.code_depth += 1
                if tag == 'math':
                    self.math_depth += 1
                if is_katex_root:
                    self.katex_depth += 1
                if tag == 'svg':
                    self.svg_depth += 1

            def handle_startendtag(self, tag, attrs):
                attr_map = dict(attrs)
                unique_attrs = len(attr_map) == len(attrs)
                has_katex_error = _has_katex_error_class(attrs)

                # HTML nonvoid <code/> is not a genuine closed code element.
                if tag not in _HTML_VOID_TAGS:
                    self._invalidate_code()
                if self.math_depth and (
                        tag not in _MATHML_ALLOWED_TAGS or has_katex_error or not unique_attrs):
                    self._invalidate_math()
                if self.katex_depth:
                    allowed_in_foreign = (
                        (self.math_depth > 0 and tag in _MATHML_ALLOWED_TAGS)
                        or (self.svg_depth > 0 and tag in _KATEX_SVG_ALLOWED_TAGS)
                    )
                    if not allowed_in_foreign or has_katex_error or not unique_attrs:
                        self._invalidate_katex()

            def handle_endtag(self, tag):
                if not self.stack or self.stack[-1]['tag'] != tag:
                    self._invalidate_all()
                    return
                node = self.stack.pop()
                if node['tag'] in {'code', 'pre'}:
                    self.code_depth -= 1
                if node['tag'] == 'math':
                    self.math_depth -= 1
                if node['is_katex_root']:
                    self.katex_depth -= 1
                if node['tag'] == 'svg':
                    self.svg_depth -= 1

                start = self.position_offset()
                end = text.find('>', start)
                raw = text[start:end + 1] if end >= 0 else ''
                if not re.fullmatch(r'</\s*' + re.escape(tag) + r'\s*>', raw, re.I):
                    node['valid'] = False
                    node['prop_code_invalid'] = True
                    node['prop_math_invalid'] = True
                    node['prop_katex_invalid'] = True
                node['end'] = end + 1 if end >= 0 else None

                if self.stack:
                    parent = self.stack[-1]
                    if node['prop_invalid']:
                        parent['valid'] = False
                        parent['prop_invalid'] = True
                    if node['prop_code_invalid'] and self.code_depth:
                        parent['prop_code_invalid'] = True
                        if parent['tag'] in {'code', 'pre'}:
                            parent['code_valid'] = False
                    if node['prop_math_invalid'] and self.math_depth:
                        parent['prop_math_invalid'] = True
                        if parent['tag'] == 'math':
                            parent['math_valid'] = False
                    if node['prop_katex_invalid'] and self.katex_depth:
                        parent['prop_katex_invalid'] = True
                        if parent['is_katex_root']:
                            parent['katex_valid'] = False
                    if (node['has_katex_payload'] or node['is_katex_payload']) and self.katex_depth:
                        parent['has_katex_payload'] = True

            def handle_comment(self, data):
                self._invalidate_code()
                self._invalidate_math()
                self._invalidate_katex()

            def handle_decl(self, decl):
                self.handle_comment(decl)

            def handle_pi(self, data):
                self.handle_comment(data)

            def unknown_decl(self, data):
                self.handle_comment(data)

        parser = ClosedFormatNodes()
        try:
            parser.feed(text)
            parser.close()
        except Exception:
            return text
        count = len(parser.nodes)
        ancestry_valid = [False] * count
        invalid_format_anc = [False] * count
        forbidden_code_anc = [False] * count
        forbidden_math_anc = [False] * count
        forbidden_katex_anc = [False] * count
        ranges = []
        for idx, node in enumerate(parser.nodes):
            parent = node['parent']
            anc_ok = (
                node['valid'] and node['end'] is not None
                and (parent == -1 or ancestry_valid[parent])
            )
            ancestry_valid[idx] = anc_ok
            tag = node['tag']
            self_format_invalid = (
                (tag in {'code', 'pre'} and not node['code_valid'])
                or (tag == 'math' and not node['math_valid'])
                or (node['is_katex_root'] and not node['katex_valid'])
            )
            inv_fmt = self_format_invalid or (parent != -1 and invalid_format_anc[parent])
            invalid_format_anc[idx] = inv_fmt
            fc = (tag in _FORBIDDEN_CODE_ANCESTORS) or (parent != -1 and forbidden_code_anc[parent])
            fm = (tag in _FORBIDDEN_MATH_ANCESTORS) or (parent != -1 and forbidden_math_anc[parent])
            fk = (tag in _FORBIDDEN_CODE_ANCESTORS) or (parent != -1 and forbidden_katex_anc[parent])
            forbidden_code_anc[idx] = fc
            forbidden_math_anc[idx] = fm
            forbidden_katex_anc[idx] = fk
            if not anc_ok or inv_fmt:
                continue
            if tag in {'code', 'pre'} and node['code_valid'] and not fc:
                ranges.append((node['start'], node['end']))
            elif tag == 'math' and node['math_valid'] and not fm:
                ranges.append((node['start'], node['end']))
            elif node['is_katex_root'] and node['katex_valid'] and node['has_katex_payload'] and not fk:
                ranges.append((node['start'], node['end']))
    if not ranges:
        return text
    # Ranges are emitted in pre-order (non-decreasing start); merge nested/overlapping
    # intervals first so character masking touches every index at most once (strict O(n)).
    merged = []
    for start, end in ranges:
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    chars = list(text)
    for start, end in merged:
        for index in range(start, end):
            if chars[index] not in '\r\n':
                chars[index] = ' '
    return ''.join(chars)


def _mask_literal_markdown_image_alt_brackets(text):
    """Only a formula-pairing diagnostic copy; preserve all published bytes."""
    if '![' not in text or (r'\[' not in text and r'\]' not in text):
        return text
    try:
        images = parse_markdown_images(text)
    except PublishDataValidationError:
        # Malformed nodes never receive a literal-ALT exception.
        return text
    chars = list(text)
    for image in images:
        start = image['start'] + 2
        end = start + len(image['alt'])
        if text[image['start']:image['end']] != image['raw'] or text[start:end] != image['alt']:
            return text
        for index in range(start, end):
            if text[index] not in '[]':
                continue
            cursor = index
            while cursor > start and text[cursor - 1] == '\\':
                cursor -= 1
            if (index - cursor) % 2:
                # Only the last Markdown escape slash, never prose or URL bytes.
                chars[index - 1] = ' '
    return ''.join(chars)


def math_and_emphasis_issues(text, label, *, rendered_html=False):
    """Hugo 可能把语法渲染成破碎的纯文本时，这里按失败处理。"""
    base = text if rendered_html else strip_fenced_code_for_format_gate(text)
    clean = mask_closed_code_for_format_gate(base, rendered_html=rendered_html)
    delimiter_view = text if rendered_html else _mask_literal_markdown_image_alt_brackets(text)
    delimiter_clean = (clean if delimiter_view == text else
                       mask_closed_code_for_format_gate(strip_fenced_code_for_format_gate(delimiter_view)))
    issues = []
    if rendered_html:
        issues.extend(_rendered_math_error_issues(text, label))
    for opening, closing, name in (
            (r'\(', r'\)', r'\(…\)'), (r'\[', r'\]', r'\[…\]')):
        # 真正的定界符可能跟在偶数长度的 TeX 转义串后面，例如以 ``\\`` 结尾的
        # 行间公式紧挨着 ``\]``。这里统计完整反斜杠串为奇数个的定界符；
        # 旧实现只看前一个字符，会误判这种情况。
        delimiter_prefix = r'(?<!\\)(?:\\\\)*'
        opens = len(re.findall(delimiter_prefix + re.escape(opening), delimiter_clean))
        closes = len(re.findall(delimiter_prefix + re.escape(closing), delimiter_clean))
        if opens != closes:
            issues.append(
                f'{label} 公式定界符 {name} 未配对: 开={opens}, 闭={closes}'
            )
    display_dollars = len(re.findall(r'(?<!\\)\$\$', clean))
    if display_dollars:
        issues.append(
            f'{label} 包含裸 $$；块级公式必须使用 \\[…\\] 而非 $$…$$'
        )
    currency_dollars = (_rendered_currency_dollar_positions(base) if rendered_html
                        else {start for start, _end in publish_table_currency_spans(clean)})
    if any(match.start() not in currency_dollars
           for match in re.finditer(r'(?<![\\$])\$(?!\$)', clean)):
        issues.append(
            f'{label} 包含裸 $；行内公式必须使用 \\(…\\) 而非 $…$'
        )
    bold_markers = len(re.findall(r'(?<!\\)\*\*', clean))
    if bold_markers % 2:
        issues.append(
            f'{label} Markdown 加粗标记 ** 未配对: {bold_markers} 个'
        )
    # Consume backslash escapes as pairs, including literal stars inside a
    # label. Otherwise adjacent labels can lend their closing/opening markers
    # to a false whitespace-only match, while a real glued closing is missed.
    for match in re.finditer(r'\*\*(?:\\[^\n]|[^\\*\n])+\*\*', clean):
        next_char = clean[match.end():match.end() + 1]
        if next_char and (
                next_char.isalnum() or '\u3400' <= next_char <= '\u9fff'):
            issues.append(
                f'{label} Markdown 加粗结束符后紧贴正文，必须补空格或标点'
            )
            break
    return issues


def mask_source_bound_figure_caption_dollars(rendered, artifact):
    r"""Mask only literal dollars authenticated by an escaped generated image pair.

    A diagnostic copy only. Full source caption, image alt/src, enclosing link,
    closed elements and adjacent paragraphs must all match. No source/HTML write.
    """
    pairs = []
    source = str(artifact.get('body') or '')
    escape_literal_source_figure_caption_dollars(source, _literal_pairs=pairs)

    def fully_escaped(value):
        slash_run = 0
        for char in value:
            if char == '$' and slash_run % 2 == 0:
                return False
            slash_run = slash_run + 1 if char == '\\' else 0
        return True

    def plain(value):
        return html.unescape(re.sub(r'\\([\\`*_{}\[\]()#+\-.!$>])', r'\1', value))

    expected = {}
    for pair in pairs:
        if (pair['caption'] != pair['escapedCaption'] or pair['alt'] != pair['escapedAlt']
                or not fully_escaped(pair['caption']) or not fully_escaped(pair['alt'])
                or not (r'\$' in pair['caption'] or r'\$' in pair['alt'])
                or '`' in pair['caption'] or '`' in pair['alt']):
            continue
        key = (html.unescape(pair['url']), plain(pair['alt']), plain(pair['caption'][1:-1]), pair['sourceNote'])
        expected[key] = expected.get(key, 0) + 1
    expected = {key for key, count in expected.items() if count == 1}
    if not expected:
        return rendered
    offsets = _html_line_offsets(rendered)

    class Nodes(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.root = {'tag': None, 'children': [], 'closed': True, 'hidden': False}
            self.stack = [self.root]
            self.valid = True

        def position(self):
            line, column = self.getpos()
            return offsets[line - 1] + column

        def handle_starttag(self, tag, attrs):
            attributes = dict(attrs)
            hidden = (self.stack[-1]['hidden'] or tag in {'script', 'style', 'pre', 'code', 'textarea', 'template', 'noscript'}
                      or 'hidden' in attributes or str(attributes.get('aria-hidden') or '').lower() == 'true'
                      or bool(re.search(r'(?:display\s*:\s*none|visibility\s*:\s*hidden)', str(attributes.get('style') or ''), re.I)))
            node = {'tag': tag, 'attrs': attributes, 'uniqueAttrs': len(attributes) == len(attrs),
                    'children': [], 'hidden': hidden, 'closed': False,
                    'start': self.position(), 'raw': self.get_starttag_text()}
            self.stack[-1]['children'].append(node)
            if tag in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
                node['closed'] = True
            else:
                self.stack.append(node)

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)
            if len(self.stack) > 1 and self.stack[-1]['tag'] == tag:
                self.stack.pop()['closed'] = True

        def handle_endtag(self, tag):
            if len(self.stack) < 2 or self.stack[-1]['tag'] != tag:
                self.valid = False
                return
            self.stack.pop()['closed'] = True

        def handle_data(self, value):
            self.stack[-1]['children'].append({'text': value, 'start': self.position(), 'literal': True})

        def handle_entityref(self, name):
            self.stack[-1]['children'].append({'text': html.unescape('&' + name + ';'), 'literal': False})

        def handle_charref(self, name):
            self.stack[-1]['children'].append({'text': html.unescape('&#' + name + ';'), 'literal': False})

        def handle_comment(self, value):
            self.stack[-1]['children'].append({'tag': '#comment'})

    parser = Nodes()
    parser.feed(rendered)
    parser.close()
    if not parser.valid or len(parser.stack) != 1:
        return rendered

    def children(node):
        return [c for c in node.get('children', []) if not ('text' in c and not c['text'].strip())]

    def safe(node, tag):
        return node.get('tag') == tag and node.get('closed') and node.get('uniqueAttrs') and not node.get('hidden')

    found = {}

    def visit(parent):
        siblings = children(parent)
        for index, first in enumerate(siblings[:-1]):
            second = siblings[index + 1]
            note_text = ''
            if safe(second, 'blockquote'):
                note_parts = children(second)
                if len(note_parts) != 1 or not safe(note_parts[0], 'p'):
                    continue
                note_parts = children(note_parts[0])
                if (len(note_parts) < 2 or not safe(note_parts[0], 'strong')
                        or any('text' not in c for c in note_parts[0]['children'])
                        or ''.join(c['text'] for c in note_parts[0]['children']) != '图片来源：'
                        or any('text' not in c for c in note_parts[1:]) or index + 2 >= len(siblings)):
                    continue
                note_text = '图片来源：' + ''.join(c['text'] for c in note_parts[1:])
                second = siblings[index + 2]
            if not safe(first, 'p') or not safe(second, 'p'):
                continue
            parts, caption = children(first), children(second)
            if len(parts) != 1 or len(caption) != 1 or not safe(caption[0], 'em'):
                continue
            em = caption[0]
            if any('text' not in item for item in em['children']):
                continue
            linked = parts[0] if safe(parts[0], 'a') else None
            image_parts = children(linked) if linked else parts
            if len(image_parts) != 1 or not safe(image_parts[0], 'img'):
                continue
            image = image_parts[0]
            url, alt = image['attrs'].get('src'), image['attrs'].get('alt')
            if linked and linked['attrs'].get('href') != url:
                continue
            key = (url, alt, ''.join(c['text'] for c in em['children']), note_text)
            if key not in expected:
                continue
            # Only the actual alt attribute is a literal-text target. Dollars in
            # href/src/title/other attributes stay subject to the normal gate.
            attributes = list(re.finditer(r'''(?<!\S)alt\s*=\s*(["'])(.*?)\1''', image['raw'], re.S))
            if len(attributes) != 1 or html.unescape(attributes[0][2]) != alt:
                continue
            positions = {c['start'] + m.start() for c in em['children'] if c['literal']
                         for m in re.finditer(r'\$', c['text'])}
            positions.update(image['start'] + attributes[0].start(2) + m.start()
                             for m in re.finditer(r'\$', attributes[0][2]))
            found.setdefault(key, []).append(positions)
        for child in siblings:
            if 'tag' in child and child.get('children'):
                visit(child)
    visit(parser.root)
    positions = set()
    for key, matches in found.items():
        if len(matches) == 1:
            positions.update(matches[0])
    if not positions:
        return rendered
    result = list(rendered)
    for position in positions:
        if result[position] != '$':
            return rendered
        result[position] = 'X'
    return ''.join(result)


def mask_source_bound_title_dollars(rendered, artifact):
    """Recognize only explicitly escaped source-title dollars after Markdown rendering.

    This changes a diagnostic view, never HTML/source bytes or the raw-dollar
    rule. Both the complete visible title and (for links) href must match.
    """
    expected = {}
    source = str(artifact.get('body') or '')
    visible = mask_protected_markdown_table_regions(source, protect_quotes=False)
    for raw_line, line in zip(source.splitlines(), visible.splitlines()):
        if line != raw_line or '`' in line:
            continue
        if r'\$' not in line:
            continue
        heading = re.match(r'^#{1,3}[ \t]+(.+?)\s*$', line)
        title_line = heading or re.match(r'^>\s*英文题目：', line)
        ranking_line = (artifact.get('frontmatter', {}).get('paper_digest_page_type') == 'index'
                        and re.match(r'^\|\s*(?:🥇|🥈|🥉|\d+\.?)\s*\|', line))
        if not title_line and not ranking_line:
            continue
        links = list(re.finditer(r'\[((?:\\.|[^\]\\\n])+)\]\(([^\s)]+)\)', line))
        for match in links:
            label = match[1]
            if r'\$' in label and not re.search(r'(?<!\\)\$', label):
                label = re.sub(r'\\([\\`*_{}\[\]()#+\-.!$>])', r'\1', label)
                key = ('a', html.unescape(match[2]), html.unescape(label))
                expected[key] = expected.get(key, 0) + 1
        if heading and not links and not re.search(r'(?<!\\)\$', heading[1]):
            label = re.sub(r'\\([\\`*_{}\[\]()#+\-.!$>])', r'\1', heading[1])
            key = ('h' + str(len(line) - len(line.lstrip('#'))), None, html.unescape(label))
            expected[key] = expected.get(key, 0) + 1
    if not expected:
        return rendered
    offsets = _html_line_offsets(rendered)

    class Titles(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.active = []
            self.stack = []
            self.positions = set()

        def handle_starttag(self, tag, attrs):
            for item in self.active:
                item['valid'] = False
            attributes = dict(attrs)
            hidden = (tag in {'script', 'style', 'pre', 'code', 'textarea', 'template', 'noscript'}
                      or 'hidden' in attributes or str(attributes.get('aria-hidden') or '').lower() == 'true'
                      or bool(re.search(r'(?:display\s*:\s*none|visibility\s*:\s*hidden)', str(attributes.get('style') or ''), re.I)))
            if tag in {'a', 'h1', 'h2', 'h3'}:
                self.active.append({'tag': tag, 'href': dict(attrs).get('href') if tag == 'a' else None,
                                    'parts': [], 'dollars': [], 'valid': not hidden and len(attributes) == len(attrs)
                                    and not any(value for _tag, value in self.stack)})
            if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
                self.stack.append((tag, hidden))

        def handle_comment(self, _value):
            for item in self.active:
                item['valid'] = False

        def handle_data(self, value):
            line, column = self.getpos()
            start = offsets[line - 1] + column
            for item in self.active:
                item['parts'].append(value)
                item['dollars'].extend(start + match.start() for match in re.finditer(r'\$', value))

        def handle_entityref(self, name):
            for item in self.active:
                item['parts'].append(html.unescape('&' + name + ';'))

        def handle_charref(self, name):
            for item in self.active:
                item['parts'].append(html.unescape('&#' + name + ';'))

        def handle_endtag(self, tag):
            for index in range(len(self.active) - 1, -1, -1):
                if self.active[index]['tag'] == tag:
                    item = self.active.pop(index)
                    key = (tag, item['href'], ''.join(item['parts']))
                    if item['valid'] and expected.get(key, 0):
                        expected[key] -= 1
                        self.positions.update(item['dollars'])
                    break
            for index in range(len(self.stack) - 1, -1, -1):
                if self.stack[index][0] == tag:
                    del self.stack[index:]
                    break

    parser = Titles()
    parser.feed(rendered)
    parser.close()
    return ''.join(' ' if index in parser.positions else char for index, char in enumerate(rendered))


def mask_source_bound_author_dollars(rendered, artifact):
    """Only complete escaped source author lists can project literal dollar glyphs."""
    from protocol_codec import has_valid_header
    frontmatter = artifact.get('frontmatter') or {}
    single = (has_valid_header(_reader_projected_header(frontmatter, 'paper_digest_api_reader_author_identity'),
                               'api-reader-author-identity')
              and re.fullmatch(r'[a-f0-9]{64}', str(frontmatter.get('paper_digest_api_reader_author_identity_sha256') or ''))
              and type(frontmatter.get('paper_digest_api_reader_author_count')) is int
              and frontmatter['paper_digest_api_reader_author_count'] > 0)
    authors = frontmatter.get('paper_digest_authors')
    if not single or not isinstance(authors, list) or not authors or any(
            not isinstance(author, dict) or not isinstance(author.get('name'), str)
            or not isinstance(author.get('affiliations'), list)
            or any(not isinstance(value, str) for value in author['affiliations']) for author in authors):
        return rendered
    original_items = tuple(author['name'] + '：' + '；'.join(author['affiliations']) for author in authors)
    source = str(artifact.get('body') or '')
    expected = {}
    pattern = re.compile('^##[ \\t]+👥 作者与机构[ \\t]*\\n\\n((?:- [^\\n]+(?:\\n|$))+)', re.MULTILINE)
    for match in pattern.finditer(source):
        block = match[1]
        dollars = [match.start() for match in re.finditer(re.escape('$'), block)]
        if not dollars or '`' in block:
            continue
        if any((position - len(block[:position].rstrip(chr(92)))) % 2 != 1 for position in dollars):
            continue
        # Each list item must be an explicit author/affiliation pair. The
        # normal publication binding still authenticates the original record.
        items = tuple(html.unescape(re.sub(re.escape(chr(92)) + '([' + re.escape('\\`*_{}[]()#+-.!$>') + '])',
                      lambda value: value[1], line[2:])) for line in block.splitlines())
        if items != original_items:
            continue
        expected[items] = expected.get(items, 0) + 1
    if not expected:
        return rendered
    offsets = _html_line_offsets(rendered)

    class Authors(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.stack, self.heading, self.pending, self.block, self.item = [], None, False, None, None
            self.positions = set()
            self.anchor = None

        def handle_starttag(self, tag, attrs):
            attributes = dict(attrs)
            hidden = (tag in {'script', 'style', 'pre', 'code', 'textarea', 'template', 'noscript'}
                      or 'hidden' in attributes or str(attributes.get('aria-hidden') or '').lower() == 'true'
                      or bool(re.search('display\\s*:\\s*none|visibility\\s*:\\s*hidden', str(attributes.get('style') or ''), re.I))
                      or any(value for _tag, value in self.stack) or len(attributes) != len(attrs))
            if self.heading is not None:
                if (tag == 'a' and self.anchor is None and not self.heading.get('anchorSeen')
                        and self.heading.get('id') == '-作者与机构'
                        and self.stack and self.stack[-1][0] == 'h2'
                        and ''.join(self.heading['parts']) == '👥 作者与机构'
                        and len(attrs) == 4 and attributes == {'hidden': None, 'class': 'anchor',
                            'aria-hidden': 'true', 'href': '#-作者与机构'}):
                    self.anchor = []
                else:
                    self.heading['valid'] = False
            if self.block is not None:
                if tag == 'li' and self.item is None and self.stack and self.stack[-1][0] == 'ul':
                    self.item = {'parts': [], 'dollars': []}
                else:
                    self.block['valid'] = False
            if self.pending:
                self.pending = False
                if tag == 'ul' and not hidden:
                    self.block = {'items': [], 'dollars': [], 'valid': True}
            if self.block is None and tag == 'h2':
                self.heading = {'tag': tag, 'id': attributes.get('id'), 'parts': [], 'valid': not hidden}
            if hidden and self.block is not None:
                self.block['valid'] = False
            if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}:
                self.stack.append((tag, hidden))

        def handle_data(self, value):
            if self.anchor is not None:
                self.anchor.append(value)
                return
            if self.heading is not None:
                self.heading['parts'].append(value)
            if self.item is not None:
                self.item['parts'].append(value)
                line, column = self.getpos()
                start = offsets[line - 1] + column
                self.item['dollars'].extend(start + m.start() for m in re.finditer(re.escape('$'), value))
            elif self.pending and value.strip():
                self.pending = False

        def handle_entityref(self, name):
            self._entity(html.unescape('&' + name + ';'))

        def handle_charref(self, name):
            self._entity(html.unescape('&#' + name + ';'))

        def _entity(self, value):
            if self.anchor is not None:
                self.anchor.append(value)
                return
            if self.heading is not None:
                self.heading['parts'].append(value)
            if self.item is not None:
                self.item['parts'].append(value)

        def handle_comment(self, _value):
            self.pending = False
            if self.heading is not None:
                self.heading['valid'] = False
            if self.block is not None:
                self.block['valid'] = False

        def handle_endtag(self, tag):
            if self.anchor is not None and (tag != 'a' or not self.stack or self.stack[-1][0] != 'a'):
                if self.heading is not None:
                    self.heading['valid'] = False
            if self.anchor is not None and tag == 'a':
                if self.heading is not None:
                    self.heading['valid'] = self.heading['valid'] and ''.join(self.anchor) == '#'
                    self.heading['anchorSeen'] = True
                self.anchor = None
            if self.block is not None and (not self.stack or self.stack[-1][0] != tag):
                self.block['valid'] = False
            if self.item is not None and tag == 'li':
                self.block['items'].append(''.join(self.item['parts']))
                self.block['dollars'].extend(self.item['dollars'])
                self.item = None
            if self.block is not None and tag == 'ul':
                key = tuple(self.block['items'])
                if self.block['valid'] and self.item is None and expected.get(key, 0):
                    expected[key] -= 1
                    self.positions.update(self.block['dollars'])
                self.block, self.item = None, None
            if self.heading is not None and tag == self.heading['tag']:
                self.pending = self.heading['valid'] and ''.join(self.heading['parts']).strip() == '👥 作者与机构'
                self.heading = None
                self.anchor = None
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    del self.stack[i:]
                    break

    parser = Authors()
    parser.feed(rendered)
    parser.close()
    return ''.join(' ' if index in parser.positions else char for index, char in enumerate(rendered))




def mask_source_bound_literal_asterisks(rendered, artifact):
    """Mask only exact plain HTML text authorized by explicitly escaped source.

    This is a diagnostic projection, never an HTML rewrite. Whole paragraphs
    bind the technical format name; whole real table cells bind CI footnotes.
    Each escaped source occurrence authorizes one matching visible occurrence.
    """
    source = str(artifact.get('body') or '')
    protected = mask_protected_markdown_table_regions(source, protect_quotes=False)
    expected = {}
    kern = r'\*\*kern'
    for paragraph in re.split(r'\n[ \t]*\n', protected):
        paragraph = paragraph.strip()
        if kern not in paragraph or '\n' in paragraph or paragraph.startswith(('#', '>', '|')):
            continue
        plain = paragraph.replace(kern, '**kern')
        remainder = paragraph.replace(kern, '')
        if re.search(r'[*_`<>\\\[\]]', remainder):
            continue
        key = ('p', html.unescape(plain))
        expected[key] = expected.get(key, 0) + 1
    scalar = r'[+−-]?[0-9]+(?:\.[0-9]+)?'
    ci = re.compile(
        r'(?:' + scalar + r'%[ \t]+\[' + scalar + r',[ \t]*' + scalar + r'\]%'
        + r'|' + scalar + r'%?[ \t]*±[ \t]*' + scalar + r'%?)[ \t]+(?:\\\*){1,3}'
    )
    for table in extract_markdown_tables(source):
        for row in table['rows']:
            for cell in row:
                cell = cell.strip()
                if ci.fullmatch(cell):
                    key = ('cell', html.unescape(cell.replace(r'\*', '*')))
                    expected[key] = expected.get(key, 0) + 1
    if not expected:
        return rendered
    offsets = _html_line_offsets(rendered)

    class LiteralText(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.stack, self.item, self.positions = [], None, set()

        def handle_starttag(self, tag, attrs):
            if self.item is not None:
                self.item['valid'] = False
            attributes = dict(attrs)
            hidden = (tag in {'script', 'style', 'pre', 'code', 'textarea', 'template', 'noscript', 'svg', 'math'}
                      or 'hidden' in attributes or str(attributes.get('aria-hidden') or '').lower() == 'true'
                      or bool(re.search(r'display\s*:\s*none|visibility\s*:\s*hidden',
                                        str(attributes.get('style') or ''), re.I))
                      or any(value for _tag, value in self.stack))
            kind = ('p' if tag == 'p' and not any(t in {'table', 'tr', 'td', 'th'} for t, _h in self.stack)
                    else 'cell' if tag in {'td', 'th'} and self.stack and self.stack[-1][0] == 'tr'
                    and any(t == 'table' for t, _h in self.stack) else None)
            if kind and self.item is None:
                self.item = {'tag': tag, 'kind': kind, 'parts': [], 'stars': [],
                             'valid': not hidden and not attrs}
            if tag not in {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
                           'meta', 'param', 'source', 'track', 'wbr'}:
                self.stack.append((tag, hidden))

        def handle_startendtag(self, tag, attrs):
            if self.item is not None:
                self.item['valid'] = False

        def handle_data(self, value):
            if self.item is not None:
                self.item['parts'].append(value)
                line, column = self.getpos()
                start = offsets[line - 1] + column
                self.item['stars'].extend(start + match.start() for match in re.finditer(r'\*', value))

        def handle_entityref(self, name):
            if self.item is not None:
                self.item['parts'].append(html.unescape('&' + name + ';'))

        def handle_charref(self, name):
            if self.item is not None:
                self.item['parts'].append(html.unescape('&#' + name + ';'))

        def handle_comment(self, _value):
            if self.item is not None:
                self.item['valid'] = False

        def handle_decl(self, _value):
            self.handle_comment(_value)

        def handle_endtag(self, tag):
            if self.item is not None:
                if not self.stack or self.stack[-1][0] != tag:
                    self.item['valid'] = False
                if tag == self.item['tag']:
                    item = self.item
                    key = (item['kind'], ''.join(item['parts']).strip())
                    if item['valid'] and expected.get(key, 0):
                        expected[key] -= 1
                        self.positions.update(item['stars'])
                    self.item = None
            for index in range(len(self.stack) - 1, -1, -1):
                if self.stack[index][0] == tag:
                    del self.stack[index:]
                    break

    parser = LiteralText()
    parser.feed(rendered)
    parser.close()
    return ''.join(' ' if index in parser.positions else char for index, char in enumerate(rendered))


def mask_rendered_symbolic_table_cells(text):
    """在渲染后的 Markdown 扫描中隐藏已校验的序列字面字形。

    读者表格可以有意包含 ``*******___`` 这样的单元格。它们源码里的星号
    已做反斜杠转义，但 Hugo 会在 HTML 文本节点里如实输出字面的 ``*`` 字节。
    这些字节是数据，不是残留的 Markdown，所以只有完全由序列字形构成的
    纯 ``th``/``td`` 单元格会在纯 HTML 闸里被遮住。
    """
    text = re.sub(
        r'(?P<prefix>\bp\s*(?:=|&lt;|&gt;|≤|≥)\s*'
        r'\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?P<stars>(?<!\\)\*{1,3})'
        r'(?=\s*(?:<|[,.;，。；]|$))',
        lambda match: match.group('prefix') + 'STATISTICAL_SIGNIFICANCE_STARS',
        text,
        flags=re.IGNORECASE,
    )
    return re.sub(
        r'(<t[dh]\b[^>]*>)[ \t\r\n]*[*_]+[ \t\r\n]*(</t[dh]>)',
        r'\1SEQUENCE_SYMBOLS\2',
        text,
        flags=re.IGNORECASE,
    )


def tutorial_score_issues(text, label):
    if not re.search(r'(?:\*\*)?八维分项(?:：|:)(?:\*\*)?', text):
        return [f'{label} 缺少八维分项评分']
    issues = []
    for dimension, maximum in TUTORIAL_SCORE_DIMENSIONS:
        escaped = re.escape(dimension)
        if not re.search(
                rf'{escaped}\s+\d+(?:\.\d+)?\s*/\s*{re.escape(maximum)}\b',
                text):
            issues.append(
                f'{label} 八维评分缺少或格式非法: {dimension}/ {maximum}'
            )
    return issues


def validate_markdown_format_gate(path, frontmatter, body):
    """在 Hugo 掩盖缺陷之前，先校验读者可见的 Markdown。"""
    label = Path(path).name
    issues = math_and_emphasis_issues(body, label)
    is_manual_v5 = (
        isinstance(frontmatter, dict)
        and frontmatter.get('paper_digest_manual_depth')
        == MANUAL_DEPTH_FACT_COVERAGE_CONTRACT
    )
    if not (format_gate_is_current_tutorial(frontmatter) or is_manual_v5):
        return issues
    if frontmatter.get('paper_digest_tutorial_contract') \
            != TUTORIAL_FORMAT_CONTRACT:
        issues.append(
            f'{label} Manual v5 缺少或降级了 {TUTORIAL_FORMAT_CONTRACT} 教程格式契约'
        )
    if frontmatter.get('paper_digest_fresh_authoring_contract') \
            != FRESH_AUTHORING_CONTRACT:
        issues.append(
            f'{label} 当前教程缺少 {FRESH_AUTHORING_CONTRACT} 冷启动作者凭证；'
            '旧 analysis/readerArticle/blog post 不得通过重排升级为新教程'
        )
    if frontmatter.get('paper_digest_tutorial_payload_contract') \
            != MANUAL_TUTORIAL_PAYLOAD_CONTRACT:
        issues.append(
            f'{label} 当前教程缺少 {MANUAL_TUTORIAL_PAYLOAD_CONTRACT} sealed payload'
        )
    for field in (
            'paper_digest_fresh_authoring_sha256',
            'paper_digest_reader_article_sha256',
            'paper_digest_tutorial_payload_sha256',
            'paper_digest_tutorial_quality_sha256',
            'paper_digest_tutorial_artifact_plan_sha256'):
        if not re.fullmatch(r'[a-f0-9]{64}', str(frontmatter.get(field) or '')):
            issues.append(
                f'{label} 当前教程缺少合法 64 位 SHA-256: {field}'
            )
    issues.extend(tutorial_score_issues(body, label))
    issues.extend(heading_figure_table_number_issues(body, label))
    return issues


def html_to_text(value):
    without_tags = re.sub(r'<[^>]+>', ' ', value or '')
    return re.sub(r'\s+', ' ', html.unescape(without_tags)).strip()


def rendered_page_candidates(output_dir, title, source_path=None):
    """优先按源文件名查找生成的文章页面；找不到该文件时，再按标题扫描 HTML。"""
    if source_path:
        direct = Path(output_dir) / 'posts' / Path(source_path).stem / 'index.html'
        if direct.is_file():
            try:
                return [(direct, direct.read_text(encoding='utf-8'))]
            except (OSError, UnicodeDecodeError):
                return []
    title = html_to_text(str(title or ''))
    if not title:
        return []
    candidates = []
    for path in Path(output_dir).rglob('*.html'):
        try:
            rendered = path.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        if title in html_to_text(rendered):
            candidates.append((path, rendered))
    return candidates


def rendered_article_fragment(rendered):
    """校验读者可见 HTML 时避开主题的 JavaScript/CSS。"""
    # PaperMod 把真正的 Markdown 正文包在 ``.post-content`` 里，相关文章卡片
    # 可能留在外层 ``article`` 内。那些卡片引用旧文章，可以合法地包含被截断
    # 的旧版 Markdown（例如 ``**S``），不能算到正在审查的页面上。
    # 优先使用只包含正文的元素；主题或测试 HTML 没有该元素时，
    # 依次查找 article/main/body。
    line_offsets = _html_line_offsets(rendered)

    class ArticleContent(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.start = None
            self.end = None
            self.depth = 0

        def source_index(self):
            line, column = self.getpos()
            return line_offsets[line - 1] + column

        def handle_starttag(self, tag, attrs):
            if tag != 'div' or self.end is not None:
                return
            if self.start is not None:
                self.depth += 1
            elif 'post-content' in str(dict(attrs).get('class') or '').split():
                self.start = self.source_index() + len(self.get_starttag_text())
                self.depth = 1

        def handle_endtag(self, tag):
            if tag == 'div' and self.start is not None and self.end is None:
                self.depth -= 1
                if self.depth == 0:
                    self.end = self.source_index()

    content = ArticleContent()
    content.feed(rendered)
    content.close()
    if content.start is not None:
        if content.end is None:
            raise PublishDataValidationError('Hugo 正文容器未闭合，无法核验完整读者页面')
        return rendered[content.start:content.end]
    for tag in ('article', 'main'):
        match = re.search(
            rf'<{tag}\b[^>]*>(.*?)</{tag}>', rendered,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if match:
            return match.group(1)
    body = re.search(
        r'<body\b[^>]*>(.*?)</body>', rendered,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return body.group(1) if body else rendered


def _rendered_math_error_issues(text, label):
    """拒绝 Hugo/KaTeX/MathML 渲染阶段遗留的数学错误节点（<merror> / katex-error）。"""
    text = str(text or '')
    lower = text.lower()
    if 'merror' not in lower and 'katex-error' not in lower:
        return []

    class MathErrors(HTMLParser):
        _skip = frozenset({'script', 'style', 'textarea', 'template', 'noscript'})

        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.skip_stack = []
            self.skip_counts = {}
            self.has_merror = False
            self.has_katex_error = False

        def _inspect(self, tag, attrs):
            if self.skip_stack:
                return
            if tag == 'merror':
                self.has_merror = True
            if _has_katex_error_class(attrs):
                self.has_katex_error = True

        def handle_starttag(self, tag, attrs):
            self._inspect(tag, attrs)
            if tag in self._skip:
                self.skip_stack.append(tag)
                self.skip_counts[tag] = self.skip_counts.get(tag, 0) + 1

        def handle_startendtag(self, tag, attrs):
            self._inspect(tag, attrs)

        def handle_endtag(self, tag):
            if self.skip_counts.get(tag, 0) > 0:
                while self.skip_stack:
                    popped = self.skip_stack.pop()
                    self.skip_counts[popped] -= 1
                    if popped == tag:
                        break

    parser = MathErrors()
    try:
        parser.feed(text)
        parser.close()
    except Exception:
        return [f'{label} Hugo HTML 数学渲染错误节点解析失败']
    issues = []
    if parser.has_merror:
        issues.append(f'{label} Hugo HTML 数学渲染包含错误: <merror>')
    if parser.has_katex_error:
        issues.append(f'{label} Hugo HTML 数学渲染包含错误: katex-error')
    return issues


def validate_hugo_rendered_html_gate(output_dir, source_artifacts):
    """在 Hugo 实际渲染出的 HTML 里校验教程产物。"""
    issues = []
    for artifact in source_artifacts:
        frontmatter = artifact['frontmatter']
        current_tutorial = format_gate_is_current_tutorial(frontmatter)
        current_api_reader = format_gate_is_current_api_reader(frontmatter)
        if not current_tutorial and not current_api_reader:
            continue
        source_label = Path(artifact['path']).name
        title_corruption_re = re.compile(r'\{\{|\}\}|\\\(|\\\)|\\\[|\\\]|\\"')
        fm_title = str(frontmatter.get('title') or '')
        if title_corruption_re.search(fm_title):
            issues.append(f'{source_label} frontmatter title 含疑似双重大括号或转义污染: {fm_title!r}')
        candidates = rendered_page_candidates(
            output_dir, frontmatter.get('title'), artifact.get('path'),
        )
        if len(candidates) != 1:
            issues.append(
                f'{source_label} Hugo 渲染页无法唯一按标题绑定: '
                f'{len(candidates)} 个候选'
            )
            continue
        rendered_path, rendered = candidates[0]
        rendered_title_match = re.search(r'<title[^>]*>([\s\S]*?)</title>', rendered, flags=re.IGNORECASE)
        if rendered_title_match:
            rendered_title = html.unescape(rendered_title_match.group(1)).strip()
            if title_corruption_re.search(rendered_title):
                issues.append(
                    f'{source_label} -> {rendered_path.name} Hugo 渲染页 <title> 含疑似双重大括号或转义污染: {rendered_title!r}'
                )
        reader_html = rendered_article_fragment(rendered)
        gate_html = mask_rendered_symbolic_table_cells(mask_source_bound_literal_asterisks(
            mask_source_bound_author_dollars(mask_source_bound_title_dollars(
                mask_source_bound_figure_caption_dollars(reader_html, artifact), artifact), artifact), artifact))
        rendered_label = f'{source_label} -> {rendered_path.name}'
        issues.extend(math_and_emphasis_issues(gate_html, rendered_label, rendered_html=True))
        if '**' in mask_closed_code_for_format_gate(gate_html, rendered_html=True):
            issues.append(
                f'{rendered_label} Hugo HTML 残留 Markdown 加粗标记 **'
            )
        rendered_text = html_to_text(reader_html)
        if current_tutorial:
            issues.extend(tutorial_score_issues(rendered_text, rendered_label))
        expected_tables = markdown_table_count(artifact['body'])
        try:
            expected_images = markdown_image_count(artifact['body'])
        except PublishDataValidationError as exc:
            issues.append(f'{rendered_label} Markdown 图片语法解析失败: {exc}')
            expected_images = None
        actual_tables = len(re.findall(
            r'<table\b', reader_html, flags=re.IGNORECASE,
        ))
        actual_images = len(re.findall(
            r'<img\b', reader_html, flags=re.IGNORECASE,
        ))
        if actual_tables < expected_tables:
            issues.append(
                f'{rendered_label} Hugo 表格数量不足: '
                f'Markdown={expected_tables}, HTML={actual_tables}'
            )
        if expected_images is not None and actual_images < expected_images:
            issues.append(
                f'{rendered_label} Hugo 图片数量不足: '
                f'Markdown={expected_images}, HTML={actual_images}'
            )
        if current_api_reader:
            expected_focus_paths = len(re.findall(
                r'^>\s*\*\*看图路径：\*\*',
                artifact['body'], flags=re.MULTILINE,
            ))
            actual_focus_paths = rendered_text.count('看图路径：')
            if actual_focus_paths < expected_focus_paths:
                issues.append(
                    f'{rendered_label} Hugo 看图路径数量不足: '
                    f'Markdown={expected_focus_paths}, HTML={actual_focus_paths}'
                )
        headings = '\n'.join(
            html_to_text(value)
            for value in re.findall(
                r'<h[1-6]\b[^>]*>(.*?)</h[1-6]>', reader_html,
                flags=re.IGNORECASE | re.DOTALL,
            )
        )
        issues.extend(
            heading_figure_table_number_issues(headings, rendered_label)
        )
    return issues

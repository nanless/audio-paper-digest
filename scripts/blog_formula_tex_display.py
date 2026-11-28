#!/usr/bin/env python3
"""展示公式 CommonMark/GFM 切分、Markdown 表格提取与表格单元格 TeX 显示投影。"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import re
import sys
import unicodedata
from collections.abc import Mapping
from pathlib import Path

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

from publish_common import (  # noqa: E402
    PublishDataValidationError,
    extract_markdown_tables,
    mask_protected_markdown_table_regions,
    split_markdown_table_row,
    strict_source_cell_math_display,
)


def _hook(hooks: Mapping | None, name: str, default=None):
    if hooks is not None and name in hooks:
        return hooks[name]
    return default


def _require_hook(hooks: Mapping | None, name: str):
    if hooks is not None and name in hooks and hooks[name] is not None:
        return hooks[name]
    raise RuntimeError(f'blog_formula_tex_display 缺少必需运行钩子: {name}')


_FORMULA_THEMATIC_BREAK_RE = re.compile(r'^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$')
_FORMULA_ATX_HEADING_RE = re.compile(r'^#{1,6}(?:[ \t]|$)')
_FORMULA_SETEXT_UNDERLINE_RE = re.compile(r'^(?:=+|-+)[ \t]*$')
_FORMULA_HTML_BLOCK_TAG_RE = re.compile(
    r'^</?(?:address|article|aside|blockquote|body|caption|center|col|colgroup|dd|details|dialog|div|'
    r'dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|main|'
    r'menu|nav|ol|p|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)(?=[\s/>]|$)',
    re.IGNORECASE,
)
_FORMULA_HTML_TYPE7_RE = re.compile(r'^</?(?ai:[a-z][\w-]*)(?:\s+[^<>]*)?\s*/?>[ \t]*$')


def _is_formula_backslash_escaped(text, index, lower_bound=0):
    count = 0
    pos = index - 1
    while pos >= lower_bound and text[pos] == '\\':
        count += 1
        pos -= 1
    return count % 2 == 1


def _find_matching_backtick_run_end(text, open_end, tick_length):
    index = open_end
    length = len(text)
    while index < length:
        if text[index] != '`':
            index += 1
            continue
        run = 0
        while index + run < length and text[index + run] == '`':
            run += 1
        if run == tick_length:
            return index + run
        index += run
    return -1


def _try_parse_inline_html_comment_end(seg, pos):
    if not seg.startswith('<!--', pos):
        return -1
    if seg.startswith('<!-->', pos):
        return pos + 5
    if seg.startswith('<!--->', pos):
        return pos + 6
    close_idx = seg.find('-->', pos + 4)
    return close_idx + 3 if close_idx >= 0 else -1


def _try_parse_commonmark_inline_image_end(seg, start):
    length = len(seg)
    if start + 1 >= length or seg[start] != '!' or seg[start + 1] != '[':
        return -1
    pos = start + 2
    depth = 1
    while pos < length:
        ch = seg[pos]
        if ch == '\\':
            b_run = 0
            while pos + b_run < length and seg[pos + b_run] == '\\':
                b_run += 1
            if b_run == 1 and pos + 1 < length and seg[pos + 1] == '[':
                close_math = seg.find(r'\]', pos + 2)
                pos = close_math + 2 if close_math >= 0 else pos + 2
                continue
            pos += (b_run + 1) if (b_run % 2 == 1 and pos + b_run < length) else b_run
            continue
        if ch == '`':
            tick_length = 0
            while pos + tick_length < length and seg[pos + tick_length] == '`':
                tick_length += 1
            closed = _find_matching_backtick_run_end(seg, pos + tick_length, tick_length)
            pos = closed if closed >= 0 else pos + tick_length
            continue
        if ch == '<':
            comment_end = _try_parse_inline_html_comment_end(seg, pos)
            if comment_end >= 0:
                pos = comment_end
                continue
        if ch == '[':
            depth += 1
            pos += 1
            continue
        if ch == ']':
            depth -= 1
            pos += 1
            if depth == 0:
                break
            continue
        pos += 1
    if depth != 0 or pos >= length or seg[pos] != '(':
        return -1
    pos += 1
    while pos < length and seg[pos] in ' \t\r\n':
        pos += 1
    if pos < length and seg[pos] == ')':
        return pos + 1
    if pos >= length:
        return -1
    if seg[pos] == '<':
        pos += 1
        closed_angle = False
        while pos < length:
            ch = seg[pos]
            if ch == '\\':
                b_run = 0
                while pos + b_run < length and seg[pos + b_run] == '\\':
                    b_run += 1
                pos += (b_run + 1) if (b_run % 2 == 1 and pos + b_run < length) else b_run
                continue
            if ch in '\r\n<':
                return -1
            if ch == '>':
                pos += 1
                closed_angle = True
                break
            pos += 1
        if not closed_angle:
            return -1
    else:
        paren_depth = 0
        while pos < length:
            ch = seg[pos]
            if ch == '\\':
                b_run = 0
                while pos + b_run < length and seg[pos + b_run] == '\\':
                    b_run += 1
                pos += (b_run + 1) if (b_run % 2 == 1 and pos + b_run < length) else b_run
                continue
            if ch in ' \t\r\n':
                break
            code = ord(ch)
            if code < 0x20 or code == 0x7f:
                return -1
            if ch == '(':
                paren_depth += 1
                if paren_depth > 32:
                    return -1
                pos += 1
                continue
            if ch == ')':
                if paren_depth == 0:
                    return pos + 1
                paren_depth -= 1
                pos += 1
                continue
            pos += 1
        if paren_depth != 0:
            return -1
    if pos < length and seg[pos] == ')':
        return pos + 1
    ws_start = pos
    while pos < length and seg[pos] in ' \t\r\n':
        pos += 1
    if pos == ws_start:
        return -1
    if pos < length and seg[pos] == ')':
        return pos + 1
    if pos >= length:
        return -1
    open_quote = seg[pos]
    if open_quote not in ('"', "'", '('):
        return -1
    close_quote = ')' if open_quote == '(' else open_quote
    pos += 1
    closed_title = False
    while pos < length:
        ch = seg[pos]
        if ch == '\\':
            b_run = 0
            while pos + b_run < length and seg[pos + b_run] == '\\':
                b_run += 1
            pos += (b_run + 1) if (b_run % 2 == 1 and pos + b_run < length) else b_run
            continue
        if open_quote == '(' and ch == '(':
            return -1
        if ch == close_quote:
            pos += 1
            closed_title = True
            break
        pos += 1
    if not closed_title:
        return -1
    while pos < length and seg[pos] in ' \t\r\n':
        pos += 1
    return pos + 1 if (pos < length and seg[pos] == ')') else -1


def _scan_formula_indent(clean, idx, col, container_col):
    p_idx = idx
    p_col = col
    length = len(clean)
    while p_idx < length:
        ch = clean[p_idx]
        if ch == ' ':
            p_col += 1
            p_idx += 1
        elif ch == '\t':
            p_col += 4 - (p_col % 4)
            p_idx += 1
        else:
            break
    return {
        'non_ws_idx': p_idx,
        'non_ws_col': p_col,
        'rel_indent': p_col - container_col,
        'is_blank': p_idx >= length,
    }


def _consume_formula_columns(clean, idx, col, target_col):
    p_idx = idx
    p_col = col
    length = len(clean)
    while p_idx < length:
        ch = clean[p_idx]
        if ch == ' ':
            if p_col + 1 > target_col:
                break
            p_col += 1
            p_idx += 1
        elif ch == '\t':
            p_col += 4 - (p_col % 4)
            p_idx += 1
            if p_col >= target_col:
                break
        else:
            break
    return p_idx, p_col


def _parse_formula_fence_start(sub):
    match = re.match(r'^(`{3,}|~{3,})(.*)$', sub)
    if not match:
        return None
    if match.group(1)[0] == '`' and '`' in match.group(2):
        return None
    return {'char': match.group(1)[0], 'length': len(match.group(1))}


def _parse_formula_html_literal_name(sub):
    match = re.match(r'^<([A-Za-zſ]+)(?=[\s/>]|$)', sub)
    if not match:
        return None
    folded = match.group(1).lower().replace('ſ', 's')
    return folded if folded in {'pre', 'code', 'script', 'style', 'textarea'} else None


def _is_formula_html_literal_closed(text, name):
    return any(
        match.group(1).lower() == name
        for match in re.finditer(r'</([A-Za-z]+)\s*>', text)
    )


def _parse_formula_html_terminator(sub):
    if sub.startswith('<?'):
        return '?>'
    if sub.startswith('<![CDATA['):
        return ']]>'
    if re.match(r'^<![A-Z]', sub):
        return '>'
    return None


def _advance_raw_html_comment_state(raw_text, is_open):
    open_state = bool(is_open)
    last_close_end = -1
    p = 0
    length = len(raw_text)
    while p < length:
        if not open_state:
            if raw_text.startswith('<!-->', p):
                last_close_end = p + 5
                p += 5
                continue
            if raw_text.startswith('<!--->', p):
                last_close_end = p + 6
                p += 6
                continue
            if raw_text.startswith('<!--', p):
                open_state = True
                p += 4
                continue
            p += 1
        elif raw_text.startswith('-->', p):
            open_state = False
            last_close_end = p + 3
            p += 3
        else:
            p += 1
    return open_state, last_close_end


def _mask_formula_inline_code_line_probe(text):
    out = list(text)
    pos = 0
    length = len(text)
    while pos < length:
        if text[pos] == '`' and not _is_formula_backslash_escaped(text, pos, 0):
            tick_len = 0
            while pos + tick_len < length and text[pos + tick_len] == '`':
                tick_len += 1
            closed = _find_matching_backtick_run_end(text, pos + tick_len, tick_len)
            if closed >= 0:
                out[pos:closed] = ['x'] * (closed - pos)
                pos = closed
                continue
            pos += tick_len
            continue
        pos += 1
    return ''.join(out)


def _parse_formula_list_marker(clean, idx, col, container_col, interrupts_paragraph):
    ind = _scan_formula_indent(clean, idx, col, container_col)
    if ind['is_blank'] or ind['rel_indent'] > 3:
        return None
    sub = clean[ind['non_ws_idx']:]
    if _FORMULA_THEMATIC_BREAK_RE.match(sub):
        return None
    match = re.match(r'^([-+*]|\d{1,9}[.)])(?=[ \t]|$)', sub)
    if not match:
        return None
    marker = match.group(1)
    after_idx = ind['non_ws_idx'] + len(marker)
    after_col = ind['non_ws_col'] + len(marker)
    after_ind = _scan_formula_indent(clean, after_idx, after_col, after_col)
    if interrupts_paragraph:
        if after_ind['is_blank']:
            return None
        if len(marker) > 1 and marker not in ('1.', '1)'):
            return None
    spaces_after = 1 if (after_ind['is_blank'] or after_ind['rel_indent'] >= 5) else after_ind['rel_indent']
    content_indent = ind['rel_indent'] + len(marker) + spaces_after
    target_col = container_col + content_indent
    if after_ind['is_blank']:
        next_idx, next_col = after_ind['non_ws_idx'], after_ind['non_ws_col']
    else:
        next_idx, next_col = _consume_formula_columns(clean, after_idx, after_col, target_col)
    return {
        'content_indent': content_indent,
        'target_col': target_col,
        'idx': next_idx,
        'col': next_col,
        'is_empty_line': after_ind['is_blank'],
    }


def _split_formula_gfm_table_row_cells(info):
    rest = info['rest']
    trimmed = rest.strip()
    if not trimmed or trimmed == '|' or '|' not in rest:
        return None
    left = 0
    while left < len(rest) and rest[left] in ' \t':
        left += 1
    right = len(rest)
    while right > left and rest[right - 1] in ' \t':
        right -= 1
    if rest[left] == '|':
        left += 1
    if right > left and rest[right - 1] == '|' and not _is_formula_backslash_escaped(rest, right - 1, left):
        right -= 1
    cells = []
    cell_start = left
    for pos in range(left, right):
        if rest[pos] == '|' and not _is_formula_backslash_escaped(rest, pos, left):
            cells.append((info['content_start'] + cell_start, info['content_start'] + pos))
            cell_start = pos + 1
    cells.append((info['content_start'] + cell_start, info['content_start'] + right))
    return cells


def _is_formula_gfm_delimiter_cells(cells, visible):
    return bool(cells) and all(
        re.fullmatch(r'[ \t]*:?-+:?[ \t]*', visible[start:end]) is not None
        for start, end in cells
    )


def _build_formula_surface_and_segments(original):
    raw_lines = original.split('\n')
    visible_lines = []
    infos = []
    containers = []
    next_container_id = 0
    fence = None
    html_literal = None
    html_terminator = None
    html_comment_block = None
    html_block = None
    raw_dom_comment_open = False
    in_paragraph = False
    offset = 0

    for raw_line in raw_lines:
        cr = '\r' if raw_line.endswith('\r') else ''
        clean = raw_line[:-1] if cr else raw_line
        blank_line = (' ' * len(clean)) + cr
        idx = 0
        col = 0
        container_col = 0
        matched = 0

        while matched < len(containers):
            container = containers[matched]
            ind = _scan_formula_indent(clean, idx, col, container_col)
            if container['type'] == 'blockquote':
                if not ind['is_blank'] and ind['rel_indent'] <= 3 and clean[ind['non_ws_idx']] == '>':
                    idx = ind['non_ws_idx'] + 1
                    col = ind['non_ws_col'] + 1
                    container_col = col
                    if idx < len(clean) and clean[idx] in ' \t':
                        container_col = col + 1
                        idx, col = _consume_formula_columns(clean, idx, col, container_col)
                    matched += 1
                else:
                    break
            elif ind['is_blank']:
                if not container['saw_content'] and container['blank_after_empty']:
                    break
                idx = ind['non_ws_idx']
                col = ind['non_ws_col']
                container_col = col
                matched += 1
            elif ind['rel_indent'] >= container['content_indent']:
                target_col = container_col + container['content_indent']
                idx, col = _consume_formula_columns(clean, idx, col, target_col)
                container_col = target_col
                matched += 1
            else:
                break

        if html_literal and html_literal['depth'] > matched:
            html_literal = None
        if html_terminator and html_terminator['depth'] > matched:
            html_terminator = None
        if html_comment_block and html_comment_block['depth'] > matched:
            html_comment_block = None
        if fence and fence['depth'] > matched:
            fence = None
        if html_block and html_block['depth'] > matched:
            html_block = None

        def emit_protected(sig):
            nonlocal offset
            visible_lines.append(blank_line)
            infos.append({
                'content_start': offset + len(clean),
                'line_end': offset + len(raw_line),
                'rest': '',
                'rel_indent': 0,
                'container_sig': sig,
                'is_atx': False,
                'is_setext': False,
                'is_thematic': False,
                'is_single_line_leaf': False,
                'is_lazy': False,
                'is_protected': True,
            })
            offset += len(raw_line) + 1

        def emit_comment_tail(sig, comment_end_in_clean):
            nonlocal offset
            after_comment = clean[comment_end_in_clean:]
            if not after_comment.strip():
                emit_protected(sig)
                return
            visible_lines.append((' ' * comment_end_in_clean) + after_comment + cr)
            infos.append({
                'content_start': offset + comment_end_in_clean,
                'line_end': offset + len(raw_line),
                'rest': after_comment,
                'rel_indent': 0,
                'container_sig': sig,
                'is_atx': False,
                'is_setext': False,
                'is_thematic': False,
                'is_single_line_leaf': True,
                'is_lazy': False,
                'is_protected': False,
            })
            offset += len(raw_line) + 1

        if html_literal or html_terminator or html_comment_block or fence or html_block:
            del containers[matched:]
            in_paragraph = False
            sig = ','.join(str(c['id']) for c in containers)
            sub = clean[idx:]
            ind = _scan_formula_indent(clean, idx, col, container_col)
            if html_literal:
                if _is_formula_html_literal_closed(sub, html_literal['name']):
                    html_literal = None
                emit_protected(sig)
                continue
            if html_terminator:
                if html_terminator['token'] in sub:
                    html_terminator = None
                emit_protected(sig)
                continue
            if html_comment_block:
                open_state, last_close_end = _advance_raw_html_comment_state(sub, raw_dom_comment_open)
                raw_dom_comment_open = open_state
                if not open_state:
                    html_comment_block = None
                    emit_comment_tail(sig, idx + last_close_end)
                else:
                    emit_protected(sig)
                continue
            if fence:
                if not ind['is_blank'] and ind['rel_indent'] <= 3:
                    close_re = re.compile('^' + re.escape(fence['char']) + '{' + str(fence['length']) + r',}[ \t]*$')
                    if close_re.match(clean[ind['non_ws_idx']:]):
                        fence = None
                emit_protected(sig)
                continue
            if html_block:
                if ind['is_blank']:
                    html_block = None
                else:
                    raw_dom_comment_open, _ = _advance_raw_html_comment_state(sub, raw_dom_comment_open)
                    emit_protected(sig)
                    continue

        is_lazy = False
        if matched < len(containers):
            ind = _scan_formula_indent(clean, idx, col, container_col)
            if in_paragraph and not ind['is_blank']:
                sub = clean[ind['non_ws_idx']:]
                interrupts = ind['rel_indent'] <= 3 and (
                    sub.startswith('>')
                    or bool(_FORMULA_ATX_HEADING_RE.match(sub))
                    or bool(_FORMULA_THEMATIC_BREAK_RE.match(sub))
                    or _parse_formula_fence_start(sub) is not None
                    or _parse_formula_list_marker(
                        clean, idx, col, container_col, containers[matched]['type'] != 'list'
                    ) is not None
                    or bool(_FORMULA_HTML_BLOCK_TAG_RE.match(sub))
                    or _parse_formula_html_literal_name(sub) is not None
                    or _parse_formula_html_terminator(sub) is not None
                    or sub.startswith('<!--')
                )
                if not interrupts:
                    is_lazy = True
            if not is_lazy:
                del containers[matched:]
                in_paragraph = False

        if not is_lazy:
            while True:
                ind = _scan_formula_indent(clean, idx, col, container_col)
                if ind['is_blank'] or ind['rel_indent'] > 3:
                    break
                sub = clean[ind['non_ws_idx']:]
                if sub.startswith('>'):
                    in_paragraph = False
                    next_container_id += 1
                    containers.append({'type': 'blockquote', 'id': next_container_id})
                    idx = ind['non_ws_idx'] + 1
                    col = ind['non_ws_col'] + 1
                    container_col = col
                    if idx < len(clean) and clean[idx] in ' \t':
                        container_col = col + 1
                        idx, col = _consume_formula_columns(clean, idx, col, container_col)
                    continue
                if in_paragraph and _FORMULA_SETEXT_UNDERLINE_RE.match(sub):
                    break
                list_info = _parse_formula_list_marker(clean, idx, col, container_col, in_paragraph)
                if list_info:
                    in_paragraph = False
                    for c in containers:
                        if c['type'] == 'list':
                            c['saw_content'] = True
                    next_container_id += 1
                    containers.append({
                        'type': 'list',
                        'id': next_container_id,
                        'content_indent': list_info['content_indent'],
                        'saw_content': not list_info['is_empty_line'],
                        'blank_after_empty': False,
                    })
                    idx = list_info['idx']
                    col = list_info['col']
                    container_col = list_info['target_col']
                    continue
                break

        container_sig = ','.join(str(c['id']) for c in containers)
        ind = _scan_formula_indent(clean, idx, col, container_col)
        if ind['is_blank']:
            in_paragraph = False
            for c in containers:
                if c['type'] == 'list' and not c['saw_content']:
                    c['blank_after_empty'] = True
            visible_lines.append(blank_line)
            infos.append({
                'content_start': offset + len(clean),
                'line_end': offset + len(raw_line),
                'rest': '',
                'rel_indent': 0,
                'container_sig': container_sig,
                'is_atx': False,
                'is_setext': False,
                'is_thematic': False,
                'is_single_line_leaf': False,
                'is_lazy': False,
                'is_protected': False,
            })
            offset += len(raw_line) + 1
            continue

        for c in containers:
            if c['type'] == 'list':
                c['saw_content'] = True

        if not is_lazy and not in_paragraph and ind['rel_indent'] >= 4:
            emit_protected(container_sig)
            continue

        sub_non_ws = clean[ind['non_ws_idx']:]
        if not is_lazy and ind['rel_indent'] <= 3:
            fence_info = _parse_formula_fence_start(sub_non_ws)
            if fence_info:
                in_paragraph = False
                fence = {'char': fence_info['char'], 'length': fence_info['length'], 'depth': len(containers)}
                emit_protected(container_sig)
                continue
            if sub_non_ws.startswith('<!--'):
                in_paragraph = False
                open_state, last_close_end = _advance_raw_html_comment_state(sub_non_ws, raw_dom_comment_open)
                raw_dom_comment_open = open_state
                if open_state:
                    html_comment_block = {'depth': len(containers)}
                    emit_protected(container_sig)
                else:
                    html_comment_block = None
                    emit_comment_tail(container_sig, ind['non_ws_idx'] + last_close_end)
                continue
            literal_name = _parse_formula_html_literal_name(sub_non_ws)
            if literal_name:
                in_paragraph = False
                probe = _mask_formula_inline_code_line_probe(clean[idx:])
                if not _is_formula_html_literal_closed(probe, literal_name):
                    html_literal = {'name': literal_name, 'depth': len(containers)}
                emit_protected(container_sig)
                continue
            term = _parse_formula_html_terminator(sub_non_ws)
            if term:
                in_paragraph = False
                probe = _mask_formula_inline_code_line_probe(clean[idx:])
                if term not in probe:
                    html_terminator = {'token': term, 'depth': len(containers)}
                emit_protected(container_sig)
                continue
            starts_html_block = bool(_FORMULA_HTML_BLOCK_TAG_RE.match(sub_non_ws))
            if starts_html_block or (not in_paragraph and _FORMULA_HTML_TYPE7_RE.match(sub_non_ws)):
                in_paragraph = False
                raw_dom_comment_open, _ = _advance_raw_html_comment_state(clean[idx:], raw_dom_comment_open)
                html_block = {'depth': len(containers)}
                emit_protected(container_sig)
                continue

        vis_tail = clean[idx:]
        vis_non_ws = clean[ind['non_ws_idx']:]
        is_atx = not is_lazy and ind['rel_indent'] <= 3 and bool(_FORMULA_ATX_HEADING_RE.match(vis_non_ws))
        is_setext = not is_lazy and in_paragraph and ind['rel_indent'] <= 3 and bool(_FORMULA_SETEXT_UNDERLINE_RE.match(vis_non_ws))
        is_thematic = not is_lazy and not is_setext and ind['rel_indent'] <= 3 and bool(_FORMULA_THEMATIC_BREAK_RE.match(vis_non_ws))
        in_paragraph = not (is_atx or is_setext or is_thematic)

        if raw_dom_comment_open:
            probe = _mask_formula_inline_code_line_probe(vis_tail)
            closed_at = -1
            for p in range(len(probe)):
                if probe[p] == '<' and not _is_formula_backslash_escaped(probe, p, 0):
                    end = _try_parse_inline_html_comment_end(probe, p)
                    if end >= 0:
                        closed_at = end
                        break
            if closed_at >= 0:
                raw_dom_comment_open = False
                emit_comment_tail(container_sig, idx + closed_at)
            else:
                emit_protected(container_sig)
            continue

        visible_lines.append((' ' * idx) + vis_tail + cr)
        infos.append({
            'content_start': offset + idx,
            'line_end': offset + len(raw_line),
            'rest': vis_tail,
            'rel_indent': ind['rel_indent'],
            'container_sig': container_sig,
            'is_atx': is_atx,
            'is_setext': is_setext,
            'is_thematic': is_thematic,
            'is_single_line_leaf': False,
            'is_lazy': is_lazy,
            'is_protected': False,
        })
        offset += len(raw_line) + 1

    visible = '\n'.join(visible_lines)
    segments = []
    para = None

    def flush_paragraph():
        nonlocal para
        if para is not None:
            segments.append((para['start'], para['end']))
            para = None

    index = 0
    total = len(infos)
    while index < total:
        info = infos[index]
        if info['is_protected'] or not info['rest'].strip():
            flush_paragraph()
            index += 1
            continue
        if para is not None and info['container_sig'] != para['container_sig']:
            flush_paragraph()
        if info['is_atx'] or info['is_single_line_leaf']:
            flush_paragraph()
            segments.append((info['content_start'], info['line_end']))
            index += 1
            continue
        if info['is_setext'] or info['is_thematic']:
            flush_paragraph()
            index += 1
            continue
        header_cells = _split_formula_gfm_table_row_cells(info) if info['rel_indent'] <= 3 else None
        next_info = infos[index + 1] if index + 1 < total else None
        delim_cells = (
            _split_formula_gfm_table_row_cells(next_info)
            if (
                header_cells
                and next_info
                and not next_info['is_protected']
                and next_info['rest'].strip()
                and next_info['container_sig'] == info['container_sig']
                and next_info['rel_indent'] <= 3
                and not next_info['is_atx']
                and not next_info['is_thematic']
                and not next_info['is_single_line_leaf']
            )
            else None
        )
        if (
            header_cells
            and delim_cells
            and len(header_cells) == len(delim_cells)
            and _is_formula_gfm_delimiter_cells(delim_cells, visible)
        ):
            flush_paragraph()
            segments.extend(header_cells)
            index += 2
            while index < total:
                row_info = infos[index]
                if (
                    row_info['is_protected']
                    or not row_info['rest'].strip()
                    or row_info['container_sig'] != info['container_sig']
                    or row_info['is_atx']
                    or row_info['is_thematic']
                    or row_info['is_single_line_leaf']
                ):
                    break
                row_cells = _split_formula_gfm_table_row_cells(row_info) or [
                    (row_info['content_start'], row_info['line_end'])
                ]
                segments.extend(row_cells[:len(header_cells)])
                index += 1
            continue
        if para is None:
            para = {
                'start': info['content_start'],
                'end': info['line_end'],
                'container_sig': info['container_sig'],
            }
        else:
            para['end'] = info['line_end']
        index += 1
    flush_paragraph()
    return visible, segments


def _api_reader_display_formula_blocks(article):
    """只核对可见展示块的位置，返回原始 TeX 字节，保留多行缩进。"""
    original = str(article or '')
    visible, segments = _build_formula_surface_and_segments(original)
    blocks = []
    for seg_start, seg_end in segments:
        seg = visible[seg_start:seg_end]
        seg_len = len(seg)
        pos = 0
        while pos < seg_len:
            ch = seg[pos]
            if ch == '`' and not _is_formula_backslash_escaped(seg, pos, 0):
                tick_length = 0
                while pos + tick_length < seg_len and seg[pos + tick_length] == '`':
                    tick_length += 1
                closed = _find_matching_backtick_run_end(seg, pos + tick_length, tick_length)
                pos = closed if closed >= 0 else pos + tick_length
                continue
            if ch == '<' and not _is_formula_backslash_escaped(seg, pos, 0):
                comment_end = _try_parse_inline_html_comment_end(seg, pos)
                if comment_end >= 0:
                    pos = comment_end
                    continue
            if ch == '!' and pos + 1 < seg_len and seg[pos + 1] == '[' and not _is_formula_backslash_escaped(seg, pos, 0):
                img_end = _try_parse_commonmark_inline_image_end(seg, pos)
                pos = img_end if img_end >= 0 else pos + 2
                continue
            if ch == '\\':
                run = 0
                while pos + run < seg_len and seg[pos + run] == '\\':
                    run += 1
                if pos + run >= seg_len or seg[pos + run] != '[':
                    pos += (run + 1) if (run % 2 == 1 and pos + run < seg_len) else run
                    continue
                if run == 1:
                    math_end = -1
                    search = pos + 2
                    while search < seg_len:
                        candidate = seg.find(r'\]', search)
                        if candidate < 0:
                            break
                        bs_count = 0
                        cursor = candidate
                        while cursor >= pos + 2 and seg[cursor] == '\\':
                            bs_count += 1
                            cursor -= 1
                        if bs_count % 2 == 1:
                            math_end = candidate
                            break
                        search = candidate + 2
                    if math_end >= 0:
                        blocks.append(original[seg_start + pos:seg_start + math_end + 2])
                        pos = math_end + 2
                    else:
                        pos += 2
                    continue
                if run % 4 in (2, 3):
                    scan = pos + run + 1
                    close_end = seg_len
                    while scan < seg_len:
                        if seg[scan] != '\\':
                            scan += 1
                            continue
                        c_run = 0
                        while scan + c_run < seg_len and seg[scan + c_run] == '\\':
                            c_run += 1
                        if (
                            scan + c_run < seg_len
                            and seg[scan + c_run] == ']'
                            and c_run >= 2
                            and c_run % 4 in (2, 3)
                        ):
                            close_end = scan + c_run + 1
                            break
                        scan += (c_run + 1) if (c_run % 2 == 1 and scan + c_run < seg_len) else c_run
                    blocks.append(original[seg_start + pos:seg_start + close_end])
                    pos = close_end
                    continue
                pos += run + 1
                continue
            pos += 1
    return blocks


def api_reader_markdown_tables(article, *, hooks: Mapping | None = None):
    """重放 Node 的表格提取器，同时保留参与哈希的确切字节。"""
    mask_fn = _hook(hooks, 'mask_protected_markdown_table_regions', mask_protected_markdown_table_regions)
    split_row_fn = _hook(hooks, 'split_markdown_table_row', split_markdown_table_row)
    # 共用展示范围判断；还原发布时转义的字面单元格符号，原来源核验继续执行。
    visible_lines = [re.sub(
        r'(?<=\|)([ \t]*)((?:\\[*_]|[*_])+)([ \t]*)(?=\|)',
        lambda cell: cell.group(1)
        + cell.group(2).replace(r'\*', '*').replace(r'\_', '_')
        + cell.group(3), line,
    ) for line in mask_fn(article).split('\n')]

    def separator(row):
        cells = split_row_fn(row)
        return len(cells) >= 2 and all(
            re.fullmatch(r':?-{3,}:?', re.sub(r'\s+', '', cell))
            for cell in cells
        )

    tables = []
    index = 0
    while index + 1 < len(visible_lines):
        header = split_row_fn(visible_lines[index])
        if len(header) < 2 or not separator(visible_lines[index + 1]):
            index += 1
            continue
        end = index + 2
        rows = []
        while end < len(visible_lines):
            line = visible_lines[end]
            cells = split_row_fn(line)
            if not line.strip():
                break
            if len(cells) < 2 and not re.fullmatch(r'\s*\|.*\|\s*', line):
                break
            rows.append(cells)
            end += 1
        tables.append({
            'header': header,
            'rows': rows,
            'markdown': '\n'.join(visible_lines[index:end]),
        })
        index = max(end, index + 2)
    return tables


def source_quoted_codec_display_cells(paper, binding, table, *, hooks: Mapping | None = None):
    """Recognize one codec spelling only from an exact sealed source row."""
    js_sha_fn = _require_hook(hooks, '_javascript_string_sha256')
    read_source_fn = _hook(
        hooks, '_read_daily_publication_source_text',
        lambda p: read_daily_publication_source_text(p, hooks=hooks),
    )
    raw, shown = r'G.711 μ\mu-law', 'G.711 μ-law'
    if (binding.get('sourceType') != 'source_quotes' or table['header'].count('Condition') != 1
            or not isinstance(paper.get('freshRewriteProvenance'), dict)):
        return {}
    column = table['header'].index('Condition')
    candidates = [(i, row) for i, row in enumerate(table['rows'], 1)
                  if len(row) == len(table['header']) and row[column] == raw]
    if len(candidates) != 1:
        return {}
    row_number, row = candidates[0]
    line_block = '\n'.join(row)
    quotes = [record['quote'] for record in binding.get('sourceQuotes', [])
              if isinstance(record, dict) and set(record) == {'quote', 'sourceQuoteSha256'}
              and isinstance(record['quote'], str) and 12 <= len(record['quote']) <= 4000
              and record['sourceQuoteSha256'] == js_sha_fn(record['quote'])
              and re.search(r'(?:^|\n)' + re.escape(line_block) + r'(?:\n|$)', record['quote'])]
    if not quotes:
        return {}
    source_text = read_source_fn(paper)
    if not any(quote in source_text for quote in quotes):
        return {}
    return {(row_number, column): shown}


def read_daily_publication_source_text(paper, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    norm_id_fn = _require_hook(hooks, '_daily_fresh_normalized_paper_id')
    read_identity_fn = _require_hook(hooks, '_daily_fresh_read_bundle_source_identity')
    runs_dir = _require_hook(hooks, 'DAILY_FRESH_SOURCE_RUNS_DIR')
    read_private_fn = _require_hook(hooks, '_daily_fresh_read_private_file')
    sha_fn = _require_hook(hooks, '_daily_fresh_sha256')

    proof = paper['freshRewriteProvenance']
    run_id = proof.get('runId')
    if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', run_id):
        raise err_cls('来源展示核验缺少封存运行身份。')
    paper_id = norm_id_fn(paper)
    source, _ = read_identity_fn(
        Path(runs_dir).resolve() / run_id, paper_id, proof, paper)
    source_path, size, digest, maximum = source['files'][0]
    content = read_private_fn(source_path, 'daily publication source display', maximum)
    if len(content) != size or sha_fn(content) != digest:
        raise err_cls('来源展示核验发现封存文本字节变化。')
    return content.decode('utf-8')


def project_source_quoted_codec_display(article, paper, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    md_tables_fn = _hook(
        hooks, '_api_reader_markdown_tables',
        lambda text: api_reader_markdown_tables(text, hooks=hooks),
    )
    extract_tables_fn = _hook(hooks, 'extract_markdown_tables', extract_markdown_tables)
    codec_cells_fn = _hook(
        hooks, '_source_quoted_codec_display_cells',
        lambda p, b, t: source_quoted_codec_display_cells(p, b, t, hooks=hooks),
    )

    saved = md_tables_fn(paper['apiReaderArticle'])
    tables = extract_tables_fn(article)
    lines = article.split('\n')
    for binding in paper['apiReaderPlan']['tableBindings']:
        index = binding['tableIndex'] - 1
        cells = codec_cells_fn(paper, binding, saved[index])
        for (row, column), displayed in cells.items():
            line_index = tables[index]['start_line'] + row + 1
            line = lines[line_index]
            pipes = list(re.finditer(r'(?<!\\)\|', line))
            if column + 1 >= len(pipes):
                raise err_cls('来源编码器名称的显示列缺失。')
            start, end = pipes[column].end(), pipes[column + 1].start()
            original = line[start:end]
            if original.strip() != saved[index]['rows'][row - 1][column]:
                raise err_cls('来源编码器名称的保存字节与显示投影输入不符。')
            leading = original[:len(original) - len(original.lstrip())]
            trailing = original[len(original.rstrip()):]
            lines[line_index] = line[:start] + leading + displayed + trailing + line[end:]
    return '\n'.join(lines)


def project_bound_source_cell_math_display(article, plan, *, hooks: Mapping | None = None):
    """Change only verified artifact-cell view text; preserve saved Reader bytes."""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    extract_tables_fn = _hook(hooks, 'extract_markdown_tables', extract_markdown_tables)
    strict_math_fn = _hook(hooks, 'strict_source_cell_math_display', strict_source_cell_math_display)

    tables = extract_tables_fn(article)
    lines = article.split('\n')
    for binding in plan.get('tableBindings', []):
        if binding.get('sourceType') != 'artifact_table':
            continue
        index = binding.get('tableIndex')
        if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= len(tables):
            raise err_cls('来源单元格显示投影的表序号不符合已验证计划。')
        table = tables[index - 1]
        for cell in binding.get('cellBindings', []):
            proof = strict_math_fn(cell.get('sourceText'))
            if not proof or cell.get('renderedText') not in (proof['sourceText'], proof['displayText']):
                continue
            row, column = cell['renderedRow'], cell['renderedColumn']
            line_index = table['start_line'] + row + (1 if row else 0)
            line = lines[line_index]
            pipes = list(re.finditer(r'(?<!\\)\|', line))
            if column + 1 >= len(pipes):
                raise err_cls('来源单元格显示投影的列定位不完整。')
            start, end = pipes[column].end(), pipes[column + 1].start()
            original = line[start:end]
            if original.strip() != cell['renderedText']:
                raise err_cls('来源单元格显示投影与当前单元格原字节不一致。')
            leading = original[:len(original) - len(original.lstrip())]
            trailing = original[len(original.rstrip()):]
            lines[line_index] = line[:start] + leading + proof['displayText'] + trailing + line[end:]
    return '\n'.join(lines)


_READER_TEX_SYMBOLS = {
    'uparrow': '↑', 'downarrow': '↓', 'rightarrow': '→', 'leftarrow': '←', 'leftrightarrow': '↔',
    'times': '×', 'pm': '±', 'cdot': '·', 'approx': '≈', 'geq': '≥', 'leq': '≤', 'neq': '≠', 'sim': '∼',
    'sigma': 'σ', 'lambda': 'λ', 'tau': 'τ', 'beta': 'β', 'alpha': 'α', 'mu': 'μ', 'pi': 'π',
    'delta': 'δ', 'eta': 'η', 'theta': 'θ', 'kappa': 'κ', 'rho': 'ρ', 'phi': 'φ', 'chi': 'χ',
    'psi': 'ψ', 'zeta': 'ζ', 'nu': 'ν', 'xi': 'ξ', 'epsilon': 'ε', 'varepsilon': 'ε',
    'Delta': 'Δ', 'omega': 'ω', 'gamma': 'γ', 'checkmark': '✓', 'infty': '∞', 'ell': 'ℓ', 'dagger': '†', 'ddagger': '‡',
    'varnothing': '∅', 'emptyset': '∅', 'circ': '∘', 'star': '⋆', 'bullet': '•', 'prime': '′',
}
_READER_TEX_STYLE_NAMES = re.compile(
    r'\\(?:textnormal|textbf|text|mathrm|mathbf|mathit|mathcal|boldsymbol|mbox|operatorname|'
    r'widehat|overline|underline|tilde|hat|bar)'
)


def _reader_tex_cell_canonical(value):
    text = unicodedata.normalize('NFKC', '' if value is None else str(value))
    text = re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u2061\u2062]', '', text)
    return re.sub(r'\s+', '', text.replace('−', '-')).strip()


def _reader_tex_plain(value):
    output = '' if value is None else str(value)
    if '\\' not in output and not re.search(r'[_^]\{', output) and '{,}' not in output:
        return output
    output = re.sub(r'\\[,;:!]', '', output)
    for _round in range(10):
        before = output
        output = re.sub(r'([A-Za-z0-9]+)\^\{((?:[^{}]|\{[^{}]*\})*)\}_\{((?:[^{}]|\{[^{}]*\})*)\}',
                        r'\1\3\2', output)
        output = re.sub(r'([A-Za-z0-9]+)_\{((?:[^{}]|\{[^{}]*\})*)\}\^\{((?:[^{}]|\{[^{}]*\})*)\}',
                        r'\1\2\3', output)
        output = _READER_TEX_STYLE_NAMES.sub('', output)
        output = re.sub(r'\{([^{}]*)\}', r'\1', output)
        if output == before:
            break

    def command(match):
        name = match.group(1)
        if name in _READER_TEX_SYMBOLS:
            return _READER_TEX_SYMBOLS[name]
        for length in range(len(name) - 1, 1, -1):
            head = name[:length]
            if head in _READER_TEX_SYMBOLS:
                return _READER_TEX_SYMBOLS[head] + name[length:]
        return match.group(0)

    output = re.sub(r'\\([A-Za-z]+)', command, output)
    return re.sub(r'[{}^_]', '', output)


def _reader_tex_align_tail(plain, canonical_prefix):
    for index in range(len(plain) + 1):
        if _reader_tex_cell_canonical(plain[:index]) == canonical_prefix:
            return plain[index:]
    return None


def _fold_reader_tex_cell_duplicate(value):
    text = '' if value is None else str(value)
    # 可见文字后面又跟一段 `{}_{...}^{...}` 上下标副本时，只要副本里的字符
    # 全部已在可见部分出现，就丢弃副本（vv-MF∅CFGmSTFT{}_{\mathrm{mSTFT}}^{...}）。
    dual = re.fullmatch(r'(.*?)\{\}_\{(.+)\}\^\{(.+)\}', text, re.S)
    if dual:
        plain = _reader_tex_plain(dual.group(2) + dual.group(3))
        if plain and '\\' not in plain and all(ch in dual.group(1) for ch in plain):
            return dual.group(1)
    for split in range(1, len(text)):
        suffix_probe = text[split:]
        if '\\' not in suffix_probe and not re.search(r'[_^]\{', suffix_probe) and '{,}' not in suffix_probe:
            # 来源 DOM 里也有不带反斜杠的副本（dz=128d_{z}=128）。
            continue
        prefix, suffix = text[:split], text[split:]
        plain = _reader_tex_plain(suffix)
        if not plain or '\\' in plain:
            continue
        canonical_prefix = _reader_tex_cell_canonical(prefix)
        canonical_plain = _reader_tex_cell_canonical(plain)
        if not canonical_plain:
            continue
        # 整格只有「一个可见符号 + 同义命令」时也是完整的同义双写
        # （∅\varnothing、∘\circ）。命令的纯文本必须和可见值逐字相等，
        # 所以 `2^{2}` 这种真实上标和 `∅\circ` 这种不同值都不会被折叠。
        if len(canonical_prefix) == 1 and canonical_plain == canonical_prefix \
                and suffix.startswith('\\'):
            return prefix
        # 与 JS reader-source-display.js:187-229 保持完全一致的分支顺序：
        # 先检查剥离开头装饰符后的实体前缀，再检查单字符符号+余下文字，最后检查紧邻词元副本。
        stripped_prefix = re.sub(r'^[^0-9A-Za-z\u4e00-\u9fff]+', '', canonical_prefix)
        if len(stripped_prefix) >= 2 and stripped_prefix != canonical_prefix \
                and canonical_plain.startswith(stripped_prefix):
            tail = _reader_tex_align_tail(plain, stripped_prefix)
            if tail is not None and re.match(r'[\s(（\[,:：;；↑↓→←↔±×%°+\-]', tail):
                return prefix + tail
        # 单字符符号前缀 + 副本继续给出余下文字（Δ\DeltaIC → ΔIC）。
        if len(canonical_prefix) == 1 and len(canonical_plain) > 1 \
                and canonical_plain.startswith(canonical_prefix) \
                and re.match(r'[\\{^_]', suffix):
            tail = _reader_tex_align_tail(plain, canonical_prefix)
            if tail is not None and re.match(r'[A-Za-z0-9\u4e00-\u9fff\s(（\[,:：;；]', tail):
                return prefix + tail
        if len(canonical_prefix) < 2:
            continue
        # 副本只重复「紧邻的那个词元」时也折叠：整格开头还有正文
        #（Aligned temporal granularity (†:f×8{}^{\dagger}\!:{f}\times 8）。
        # 纯文本还原会在符号与数字之间插入空格（‡:f× 4），比较时统一去空白。
        squeeze = lambda raw_value: re.sub(r'\s+', '', '' if raw_value is None else str(raw_value))
        trailing_match = re.search(r'[)）】\],.;；]+$', plain)
        trailing = trailing_match.group(0) if trailing_match else ''
        core = plain[:len(plain) - len(trailing)] if trailing else plain
        squeezed_core = squeeze(core)
        if len(canonical_plain) >= 2 and squeezed_core and squeeze(prefix).endswith(squeezed_core):
            head = prefix.rstrip()
            i = len(head) - 1
            j = len(squeezed_core) - 1
            while j >= 0 and i >= 0:
                if head[i].isspace():
                    i -= 1
                    continue
                if head[i] != squeezed_core[j]:
                    break
                i -= 1
                j -= 1
            at = i + 1 if j < 0 else -1
            if at >= 0:
                before = head[:at] if at > 0 else ''
                if not before or not re.search(r'[A-Za-z0-9\u4e00-\u9fff]$', before):
                    return prefix + trailing
        if canonical_plain == canonical_prefix:
            return prefix
        if len(canonical_prefix) > len(canonical_plain) and canonical_prefix.endswith(canonical_plain):
            return prefix
        if canonical_plain.startswith(canonical_prefix):
            remainder = _reader_tex_align_tail(plain, canonical_prefix)
            # 只有 TeX 注解之后是独立正文或尾符号时才保留；注解自己的下标/内容
            # （FD\mathrm{FD_{norm}} 的 norm）不是独立正文，不能当重复删一半。
            if remainder is not None and re.match(r'[\s(（\[,:：;；↑↓→←↔±×%°]', remainder):
                return prefix + remainder
        # 注解只重复可见值开头的一个符号（CRESiST 的 τ、w/o L→ 的箭头），
        # 保留可见副本来替换整个注解；剩余文字里的独立副本仍由下一轮折叠加守。
        # 只有副本首字符是符号（τ、箭头）时才算「重复了一个符号」；
        # 数字/字母开头的副本（−𝟔𝟔\mathbf{-66}）不是。
        if re.match(r'[\\{^_]', suffix) and len(canonical_plain) > 1 \
                and len(canonical_prefix) > 1 \
                and not canonical_plain[0].isdigit() \
                and canonical_prefix.endswith(canonical_plain[0]):
            return prefix + plain[1:]
    return text


def _project_reader_anon_macro(value):
    """匿名投稿自定义宏 `\\anon[匿名写法]{真名}` 在扁平文本里只剩 `\\anon[匿名写法]真名`。

    可见输出是方括号里的匿名写法，紧跟的纯词是投稿版不该出现的真名。
    只在「紧跟一段字母数字短词或一条 URL」时替换，后面接标点或长句就不动。
    URL 必须整条丢掉：只吃掉 `https` 会把仓库地址原样留在页面上。
    """
    value = re.sub(
        r'\\anon\[([^\]]*)\][A-Za-z][A-Za-z0-9+.\-]*://[^\s，。、；：）】]*', r'\1', value)
    return re.sub(r'\\anon\[([^\]]*)\][A-Za-z0-9\-]*(?![A-Za-z0-9])', r'\1', value)


def _fold_reader_duplicate_digits(match):
    """同一个整数写两遍时只留一份；四位年份本身不当作重复。

    `2020-2021`、`trained 2020` 里的年份不是重复写法，不能折成 `20`；
    整格恰好是年份的情况同样由这里兜住，不需要额外的前置判断。
    """
    repeated = match.group(0)
    if re.fullmatch(r'(?:19|20)\d{2}', repeated):
        return repeated
    return match.group(1)


_READER_IDENTIFIER_SYMBOL_COPY = re.compile(
    r'([A-Za-z0-9])([≥≤≈≠±×·∼→←↑↓↔])\1\\([A-Za-z]+)')

_READER_SYMBOL_COMMAND_COPY = re.compile(r'([≥≤≈≠±×·∼])\\([A-Za-z]+)')
_READER_SYMBOL_RUN = re.compile(r'([≥≤≈≠×·∼])\1')
_LEADING_EMPTY_LINK_CELL_PREFIX_RE = re.compile(
    r'^[^\S\r\n]*\[\]\[\][ \t]+(?=[^\s\u200b\u200c\u200d\u2060\ufeff])(?!\[\]\[\])'
)
# LaTeXML 未加载 booktabs 宏包时会把 \toprule / \midrule / \bottomrule 原样漏到表格单元格行首：
# \topruleCodebook → Codebook、\midrule1 → 1、独立 \bottomrule → ''。
# 仅剥离整格行首单个 booktabs 水平线宏（排除格中、连续叠加、\top/\mid/\bot 数学符号及带 _^{} 参数形式）。
_STANDALONE_BOOKTABS_RULE_CELL_RE = re.compile(
    r'^[^\S\r\n]*\\(?:toprule|midrule|bottomrule)[^\S\r\n]*$'
)
_LEADING_BOOKTABS_RULE_CELL_PREFIX_RE = re.compile(
    r'^[^\S\r\n]*\\(?:toprule|midrule|bottomrule)(?!\s*(?:[_^{}]|\\(?:toprule|midrule|bottomrule)))[ \t]*(?=[^\s\u200b\u200c\u200d\u2060\ufeff])'
)
_PARENTHESIZED_SIGNED_DOUBLE_WRITE_RE = re.compile(
    r'(\(([+−-])([0-9]+(?:\.[0-9]+)?%?)\))\(([+−-])([0-9]+(?:\.[0-9]+)?%?)\)'
)


def _collapse_parenthesized_signed_double_write(text):
    if not isinstance(text, str) or ')(' not in text:
        return text
    protected = []

    def _mask(match):
        protected.append(match.group(0))
        return f'\x00PDPARENURL{len(protected) - 1}\x00'

    masked = re.sub(r'\]\([^)\s]+\)', _mask, text)

    def _replace(match):
        first_group, first_sign, first_num, second_sign, second_num = match.groups()
        if first_num != second_num:
            return match.group(0)
        if first_sign.replace('−', '-') != second_sign.replace('−', '-'):
            return match.group(0)
        source = match.string
        start, end = match.start(), match.end()
        if start > 0:
            prev = source[start - 1]
            if unicodedata.category(prev)[0] in ('L', 'N') or prev in '_^\\.])}+−=*×÷-/\x00':
                return match.group(0)
        if end < len(source):
            nxt = source[end]
            if unicodedata.category(nxt)[0] in ('L', 'N') or nxt in '_^\\({%*×÷/\x00':
                return match.group(0)
            if nxt == '.' and end + 1 < len(source) and unicodedata.category(source[end + 1])[0] == 'N':
                return match.group(0)
        return first_group

    collapsed = _PARENTHESIZED_SIGNED_DOUBLE_WRITE_RE.sub(_replace, masked)
    for index, original in enumerate(protected):
        collapsed = collapsed.replace(f'\x00PDPARENURL{index}\x00', original)
    return collapsed


def _strip_leading_empty_link_cell_prefix(value):
    return _LEADING_EMPTY_LINK_CELL_PREFIX_RE.sub('', '' if value is None else str(value), count=1)


def _strip_leading_booktabs_rule_cell_prefix(value):
    text = '' if value is None else str(value)
    if _STANDALONE_BOOKTABS_RULE_CELL_RE.match(text):
        return ''
    return _LEADING_BOOKTABS_RULE_CELL_PREFIX_RE.sub('', text, count=1)


def _project_reader_cell_tex_display_body(value):
    output = '' if value is None else str(value)
    # LaTeXML 脚注残留：n/a11footnotemark: 1 → n/a（在任何提前返回之前处理）。
    output = re.sub(r'(\S*?)\s*11footnotemark:\s*\d+(?![\d.])', r'\1', output)
    output = re.sub(r'\s*\(\s*\)', '', output)
    # 页面渲染会把单元格里的 < > 转成 HTML 实体，比较前先还原成字面尖括号。
    output = output.replace('&lt;', '<').replace('&gt;', '>')
    if '\\anon[' in output:
        output = _project_reader_anon_macro(output)
    # 符号重复：++0.0、−-19.6、+-3.2 只留一个符号（后面必须紧跟数字）。
    output = re.sub(r'([+−])(?:[+−-])(?=[\d.])', r'\1', output)
    # 带括号的有符号标量双写：(−1.4)(-1.4) → (−1.4)、(+0.2)(+0.2) → (+0.2)。
    output = _collapse_parenthesized_signed_double_write(output)
    # 行内公式的定界符 \( \) 只是排版包裹，单元格比较时去掉。
    output = output.replace('\\(', '').replace('\\)', '')
    # 千位分隔的 TeX 写法与紧邻重复：55{,}00855{,}008 → 55,008。
    output = output.replace('{,}', ',')
    output = re.sub(r'(\d{1,3}(?:,\d{3})+)\1(?![\d,])', r'\1', output)
    # 同一个整数写两遍：3232 → 32。小数点和千位分隔符两侧不算同一段数字
    # （0.7070.707 里的 7070 是 0.707 的尾数接下一份的首位，不是重复），
    # 四位年份 2020 与一位数 55/99 也不能折叠。
    output = re.sub(r'(?<![A-Za-z0-9_,.])(\d{2,})\1(?![\d,.])', _fold_reader_duplicate_digits, output)
    if '\\' not in output and not re.search(r'[_^]\{', output) \
            and not re.search(r'([^|\n=]{1,12}=[0-9]+(?:\.[0-9]+)?)\1(?![0-9.])', output):
        return output
    output = re.sub(r'\\[,;:]', '', output)
    # 与 JS reader-source-display.js 同步：PDF ToUnicode CMap 漏出的标准 TeX fontmath.ltx
    # 箭头定界符代码（\uparrow = "3222378, \downarrow = "3223379, \updownarrow = "326C33F）。
    output = re.sub(r'\\delimiter\s*"3222378(?![0-9A-Fa-f])', '↑', output)
    output = re.sub(r'\\delimiter\s*"3223379(?![0-9A-Fa-f])', '↓', output)
    output = re.sub(r'\\delimiter\s*"326C33F(?![0-9A-Fa-f])', '↕', output, flags=re.I)
    # 可见 Unicode 数学字母/粗体与同值 \boldsymbol 注解只保留可见副本。
    def bold(match):
        visible, name = match.group(1), match.group(2)
        command_value = name[1:] if name.startswith('\\') else name
        projected = _READER_TEX_SYMBOLS.get(command_value, command_value)
        return visible if _reader_tex_cell_canonical(visible) == _reader_tex_cell_canonical(projected) else match.group(0)

    output = re.sub(r'([^\s\\|(){}])\\boldsymbol\{(\\?[A-Za-z]+)\}', bold, output)
    # 文本模式下重复可见字符的上标副本（I2{}^{\text{2}}S → I2S），同 JS 侧规则：
    # 只在副本后面紧跟字母/数字（词内副本）时折叠，词尾的属真指数须保留。
    output = re.sub(r'([A-Za-z0-9])\{\}\^\{\\text\{([A-Za-z0-9]{1,3})\}\}(?=[A-Za-z0-9])',
                    lambda m: m.group(1) if m.group(1) == m.group(2) else m.group(0), output)
    output = re.sub(r'([A-Za-z])\^\\(?:hat|widehat)\{([A-Za-z]+)\}',
                    lambda match: match.group(1) + '\u0302'
                    if match.group(1) == match.group(2) else match.group(0), output)
    output = re.sub(r'\\hat\{([A-Za-z])\}', lambda match: match.group(1) + '\u0302', output)
    # 与 JS reader-source-display.js 保持同一顺序：先展开 \overline，再按分号分段递归，
    # 避免分号前含 \overline{x} 且总长 >40 字符时分号后段被二次触发短纯上下标投影。
    output = re.sub(r'([A-Za-z])\u00af\\overline\{([A-Za-z]+)\}',
                    lambda match: match.group(1) + '\u0304'
                    if match.group(1) == match.group(2) else match.group(0), output)
    output = re.sub(r'\\overline\{([A-Za-z])\}', lambda match: match.group(1) + '\u0304', output)
    # 一个单元格里可能有多组「可见值 + TeX 副本」，用分号隔开；先分段折叠再拼回，
    # 否则第一组后面的全部内容会被当成同一个副本而不匹配（JS 侧同规则）。
    if re.search(r'[;；]', output) and '\\' in output:
        parts = re.split(r'([;；])', output)
        output = ''.join(part if re.fullmatch(r'[;；]', part or '') else _project_reader_cell_tex_display_body(part)
                         for part in parts)
    for _round in range(6):
        if '\\' not in output and not re.search(r'[_^]\{', output):
            break
        folded = _fold_reader_tex_cell_duplicate(output)
        if folded == output:
            break
        output = folded
    # 简单指数 10^{-4} 与来源的可见写法 10−4 等价，投影成同一形态。
    # 统一用 U+2212 负号，避免与 ASCII 连字符比较不上。
    output = re.sub(r'(\d)\^\{([-−+]\d+)\}',
                    lambda match: match.group(1) + match.group(2).replace('-', '\u2212'), output)
    # 整格就是一小段纯上下标 TeX（d_{z}）时，按可见形式投影成 dz。
    stripped_cell = output.strip()
    if len(stripped_cell) <= 40 and '\\' not in stripped_cell and re.search(r'[_^]\{', stripped_cell):
        output = _reader_tex_plain(stripped_cell)
    # LaTeXML 在正文型单元格里会把「标识符 + 符号」整体重复一遍，例如
    # `r≥r\geq`；只在命令与可见符号确实是同一符号时合并，未知命令保持原样。
    # 与 JS reader-source-display.js 的同名规则保持同步。
    def _fold_symbol_copy(match):
        head, symbol, command = match.group(1), match.group(2), match.group(3)
        return f'{head}{symbol}' if _READER_TEX_SYMBOLS.get(command) == symbol else match.group(0)
    output = _READER_IDENTIFIER_SYMBOL_COPY.sub(_fold_symbol_copy, output)
    # 同一形态还可能是「符号 + 它自己的命令」，没有重复标识符：`≈\approx`。
    def _fold_symbol_command(match):
        symbol, command = match.group(1), match.group(2)
        return symbol if _READER_TEX_SYMBOLS.get(command) == symbol else match.group(0)
    output = _READER_SYMBOL_COMMAND_COPY.sub(_fold_symbol_command, output)
    # 渲染侧可能已经先把命令换成符号，留下两个相同关系符：`≈≈`。
    output = _READER_SYMBOL_RUN.sub('\\1', output)
    # 「标签=数值」整体重复（r¯=0.643r̄=0.643）：可见副本与 TeX 副本各写一遍。
    # 只在含 = 的单元格里做，并先把长音符两种写法统一，避免影响裸 \\overline 规则。
    if '=' in output:
        # 上划线可能带下标：\overline{R_{\sigma}} → Rσ̄，先投影再折叠重复。
        # 但只有正文里已经存在同一个可见副本时才投影；否则 \overline{ACC} 会被
        # 改写成 ACC̄、\overline{1-\alpha} 会把长音符挂到最后一个字符上，静默改语义。
        output = output.replace('\u00af', '\u0304')
        def project_overline(match):
            visible = _reader_tex_plain(match.group(1)) + '\u0304'
            return visible if visible in output else match.group(0)

        output = re.sub(r'\\overline\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', project_overline, output)
        output = re.sub(r'([^|\n=]{1,12}=[0-9]+(?:\.[0-9]+)?)\1(?![0-9.])', r'\1', output)
    # 变量+下标整体重复（T1T_{1} → T1T1 → T1）：可见副本与 TeX 副本各一遍。
    output = re.sub(r'([A-Za-z]+)(\d+)\1\2(?![A-Za-z0-9])', r'\1\2', output)
    return output


def _project_reader_cell_tex_display(value):
    output = '' if value is None else str(value)
    output = re.sub(r'(\S*?)\s*11footnotemark:\s*\d+(?![\d.])', r'\1', output)
    output = re.sub(r'\s*\(\s*\)', '', output)
    if '\\anon[' in output:
        output = _project_reader_anon_macro(output)
    # LaTeXML 未加载 booktabs 宏包时会在行首漏出 \toprule / \midrule / \bottomrule：
    # 独立规则格投影为空，行首前缀仅在剥离后仍有可见字符且满足不动点时生效，否则保留原文本供校验阻断。
    if _STANDALONE_BOOKTABS_RULE_CELL_RE.match(output):
        return ''
    stripped_booktabs = _LEADING_BOOKTABS_RULE_CELL_PREFIX_RE.sub('', output, count=1)
    if stripped_booktabs != output:
        projected = _project_reader_cell_tex_display_body(stripped_booktabs)
        if re.search(r'[^\s\u200b\u200c\u200d\u2060\ufeff]', projected) \
                and _project_reader_cell_tex_display(projected) == projected:
            return projected
        return output
    # LaTeXML 行首空锚点/图标宏残留：[][] VideoLLaMA2-AV+PACD → VideoLLaMA2-AV+PACD。
    # 仅剥离整格开头后跟横向空白与非空可见正文的单个 [][] 前缀；若剥离后不剩可见字符或非不动点则回退保留 [][]。
    stripped = _strip_leading_empty_link_cell_prefix(output)
    if stripped != output:
        projected = _project_reader_cell_tex_display_body(stripped)
        if re.search(r'[^\s\u200b\u200c\u200d\u2060\ufeff]', projected) \
                and _project_reader_cell_tex_display(projected) == projected:
            return projected
        fallback = _project_reader_cell_tex_display_body(output)
        fallback_cleaned = re.sub(r'\s*\(\s*\)', '', fallback)
        return fallback_cleaned if re.search(r'[^\s\u200b\u200c\u200d\u2060\ufeff]', fallback_cleaned) else fallback
    return _project_reader_cell_tex_display_body(output)


_TRAILING_DIRECTION_RUN = re.compile(r'([↑↓→←↔])\1+')


def reader_cell_comparison(value, *, normalize_source_cell=None, hooks: Mapping | None = None):
    """逐格比较时两侧都先折叠同义 TeX 双写，再按严格来源规范比较。

    来源 DOM 会把同一箭头写成「可见箭头 + LaTeX 命令」两份，折叠后可能剩两个
    相同箭头（↓↓）；比较时按一个处理，显示的仍是折叠后的可见副本。
    Markdown 表格转义竖线（\\|）还原为字面竖线（|）后再比对原表单元格。
    """
    project_fn = _hook(hooks, '_project_reader_cell_tex_display', _project_reader_cell_tex_display)
    norm_fn = (
        normalize_source_cell
        if normalize_source_cell is not None
        else _require_hook(hooks, '_normalize_api_reader_source_cell')
    )
    unescaped = str(value or '').replace('\\|', '|')
    projected = project_fn(unescaped)
    return norm_fn(_TRAILING_DIRECTION_RUN.sub(r'\1', projected))


def _rendered_table_bare_tex(article):
    r"""返回渲染后表格里仍未解释的裸 TeX（排除 \(...\)、$...$、\[...\] 与转义竖线）。"""
    for line in str(article or '').splitlines():
        if not line.startswith('|'):
            continue
        text = line.replace('\\|', '')
        text = re.sub(r'\\\(.*?\\\)', '', text)
        text = re.sub(r'\$[^$]*\$', '', text)
        text = re.sub(r'\\\[.*?\\\]', '', text)
        match = re.search(r'\\[A-Za-z]+', text)
        if match:
            return line.strip()[:160], match.group(0)
    return None


def project_artifact_table_cell_tex_display(article, plan, *, hooks: Mapping | None = None):
    """只改已核对 artifact_table 单元格的显示副本；保存的 Reader 字节不变。"""
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    extract_tables_fn = _hook(hooks, 'extract_markdown_tables', extract_markdown_tables)
    project_fn = _hook(hooks, '_project_reader_cell_tex_display', _project_reader_cell_tex_display)
    compare_fn = _hook(
        hooks, '_reader_cell_comparison',
        lambda v: reader_cell_comparison(v, hooks=hooks),
    )

    tables = extract_tables_fn(article)
    lines = article.split('\n')
    for binding in plan.get('tableBindings', []):
        if binding.get('sourceType') != 'artifact_table':
            continue
        index = binding.get('tableIndex')
        if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= len(tables):
            raise err_cls('来源单元格 TeX 显示投影的表序号不符合已验证计划。')
        table = tables[index - 1]
        for cell in binding.get('cellBindings', []):
            row, column = cell.get('renderedRow'), cell.get('renderedColumn')
            if not isinstance(row, int) or isinstance(row, bool) or not isinstance(column, int) or isinstance(column, bool):
                raise err_cls('来源单元格 TeX 显示投影的单元格坐标无效。')
            if row < 0 or column < 0 or column >= len(table['header']) or row > len(table['rows']):
                raise err_cls('来源单元格 TeX 显示投影的单元格坐标超出表格范围。')
            line_index = table['start_line'] + row + (1 if row else 0)
            if line_index < 0 or line_index >= len(lines):
                raise err_cls('来源单元格 TeX 显示投影的行号超出文章范围。')
            line = lines[line_index]
            pipes = list(re.finditer(r'(?<!\\)\|', line))
            if column + 1 >= len(pipes):
                raise err_cls('来源单元格 TeX 显示投影的表格行管道符数量不足，无法定位目标单元格。')
            start, end = pipes[column].end(), pipes[column + 1].start()
            original = line[start:end]
            current_text = original.strip()
            projected = project_fn(current_text)
            if projected == current_text:
                continue
            if compare_fn(projected) != compare_fn(cell.get('sourceText')):
                raise err_cls(
                    '来源单元格 TeX 显示投影与保存的原 DOM 文本不一致，不能改写页面。'
                    f'（表 {index} 行 {row} 列 {column}'
                    f' 原文={current_text!r} 投影={projected!r}'
                    f' 来源={cell.get("sourceText")!r}）')
            leading = original[:len(original) - len(original.lstrip())]
            trailing = original[len(original.rstrip()):]
            lines[line_index] = line[:start] + leading + projected + trailing + line[end:]
    return '\n'.join(lines)


def assert_rendered_tables_have_no_bare_tex(article, *, hooks: Mapping | None = None):
    err_cls = _hook(hooks, 'PublishDataValidationError', PublishDataValidationError)
    bare_fn = _hook(hooks, '_rendered_table_bare_tex', _rendered_table_bare_tex)
    remaining = bare_fn(article)
    if remaining:
        line, command = remaining
        raise err_cls(
            '读者文章的表格仍有未渲染的 TeX 注解（' + command + '）：' + line
            + '。请让表格单元格使用已验证的显示投影或改为 source_quotes 逐字引文，'
            + '不能把 \\mathrm、\\tau、\\uparrow 等原样发布到页面。')


# 公共命名与既有下划线前缀别名双导出
api_reader_display_formula_blocks = _api_reader_display_formula_blocks
build_formula_surface_and_segments = _build_formula_surface_and_segments
project_reader_cell_tex_display = _project_reader_cell_tex_display
project_reader_cell_tex_display_body = _project_reader_cell_tex_display_body
rendered_table_bare_tex = _rendered_table_bare_tex
collapse_parenthesized_signed_double_write = _collapse_parenthesized_signed_double_write
strip_leading_booktabs_rule_cell_prefix = _strip_leading_booktabs_rule_cell_prefix
strip_leading_empty_link_cell_prefix = _strip_leading_empty_link_cell_prefix
_api_reader_markdown_tables = api_reader_markdown_tables
_source_quoted_codec_display_cells = source_quoted_codec_display_cells
_read_daily_publication_source_text = read_daily_publication_source_text
_project_source_quoted_codec_display = project_source_quoted_codec_display
_project_bound_source_cell_math_display = project_bound_source_cell_math_display
_reader_cell_comparison = reader_cell_comparison
_project_artifact_table_cell_tex_display = project_artifact_table_cell_tex_display
_assert_rendered_tables_have_no_bare_tex = assert_rendered_tables_have_no_bare_tex

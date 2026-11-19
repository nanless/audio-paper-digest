"""Publication-only whole-page assets from the same four sealed daily sources.

The original Reader/model pixels remain authoritative historical evidence. This
separate derivation never edits their SHA, the SVG, or the sealed PDF, and never
claims a page screenshot is an exact Figure crop.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET
from runtime_guard import require_external_runtime

if __name__ == '__main__':
    require_external_runtime('reader-pdf-page-asset')
    raise SystemExit('This helper is called through the normal blog publisher.')

import fitz
from reader_inline_svg import source_descriptor, validate_svg, has_unsaved_latexml_static_layout

CONTRACT = 'reader-sealed-pdf-page-asset-v1'
DPI = 144
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
_CACHE = {}


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stable(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(',', ':')).encode())


def norm(value):
    return re.sub(r'\s+', ' ', value).strip()


def _pdf_caption_text(value):
    # Exact PDF typography only: preserve every hyphen, word and quantity.
    value = value.translate(str.maketrans({'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl',
                                         'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st'}))
    text = norm(re.sub(r'(?<=[A-Za-z])-\r?\n(?=[A-Za-z])', '-', value))
    # 印刷版把标签写成「Fig. 1:」，HTML/LaTeXML 写成「Figure 1:」。两者是同一个
    # 标签的排版差异，比对前统一成 Figure；图注正文仍逐字保留。
    return re.sub(r'^Fig\.\s*((?:[A-Za-z]\.?)?[1-9][0-9]*(?:\.[0-9]+)*)\s*[:.]\s*', r'Figure \1: ', text, flags=re.I)


def _caption_skeleton(value):
    """图注的文字骨架：只保留字母、数字与汉字，去掉数学排版差异。

    印刷版把公式渲染成字形（ˆXn），HTML 图注里是 LaTeX（\\hat{\\mathbf{X}}_{n}）。
    两者是同一段文字的不同排版；骨架相同才接受，词语、数字与顺序仍须逐字一致。
    """
    text = re.sub(r'\\[A-Za-z]+', '', str(value))
    return re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]', '', text).lower()


def _declarations(element):
    return {(key.strip() if key.strip().startswith('--') else key.strip().lower()): value.strip()
            for part in element.get('style', '').split(';')
            if ':' in part for key, value in [part.split(':', 1)]}


def _known_visible_controls(element):
    # This is a proof precondition, not CSS evaluation. Unknown spellings must
    # not make hidden text or its background evidence for a page replacement.
    allowed = {'display': {'inline', 'block', 'inline-block'}, 'visibility': {'visible'},
               'opacity': {'1', '1.0'}, 'fill-opacity': {'1', '1.0'}}
    for key, values in allowed.items():
        if key in element.attrib and element.get(key).strip().lower() not in values:
            return False
    style = element.get('style', '')
    if any(token in style for token in ('/*', '*/', '\\')):
        return False
    # Inspect every declaration: a later inline value cannot erase an earlier
    # hidden !important declaration through the ordinary last-value dictionary.
    for part in style.split(';'):
        if ':' in part:
            key, value = part.split(':', 1)
            key = key.strip().lower()
            if key in allowed and value.strip().lower() not in allowed[key]:
                return False
    return True


def _hex_color(value):
    value = value.strip().lower()
    if value in {'black', 'white'}:
        value = '#000000' if value == 'black' else '#ffffff'
    if re.fullmatch(r'#[0-9a-f]{3}', value):
        value = '#' + ''.join(c * 2 for c in value[1:])
    return value if re.fullmatch(r'#[0-9a-f]{6}', value) else None


def _inherited_property(node, parents, key):
    while node is not None:
        values = _declarations(node)
        if key in values:
            return values[key].strip(), node
        if key == 'color' and node.get('color'):
            return node.get('color'), node
        node = parents.get(node)
    return None, None


def _rounded_rectangle_core(element, *, default_stroke=False):
    """Recognize one closed axis-aligned cubic rounded rectangle, not a bbox guess."""
    if element.tag.split('}')[-1] != 'g' or element.get('transform') or len(element) != 1:
        return None
    shape = element[0]
    if shape.tag.split('}')[-1] != 'path' or shape.get('transform') \
            or (not default_stroke and _declarations(shape).get('stroke') != 'none'):
        return None
    data = shape.get('d', '')
    tokens = re.findall(r'[A-Za-z]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)', data)
    if ''.join(tokens) != re.sub(r'[\s,]+', '', data):
        return None
    commands, offset = [], 0
    for command, count in [('M', 2), ('L', 2), ('C', 6), ('L', 2), ('C', 6),
                           ('L', 2), ('C', 6), ('L', 2), ('C', 6), ('Z', 0), ('M', 2)]:
        if offset >= len(tokens) or tokens[offset] != command:
            return None
        try:
            values = list(map(float, tokens[offset + 1:offset + count + 1]))
        except ValueError:
            return None
        if len(values) != count or not all(math.isfinite(v) for v in values):
            return None
        commands.append(values)
        offset += count + 1
    if offset != len(tokens):
        return None
    p0, p1, c1, p2, c2, p3, c3, p4, c4, _, final = commands
    left, right, bottom, top = p2[0], p4[0], p3[1], p0[1]
    if not (left < p1[0] < p0[0] < right and bottom < p2[1] < c1[5] < top
            and p1[1] == top and c1[4] == left and c2[4:] == [p1[0], bottom]
            and p3[0] == p0[0] and c3[4:] == [right, p2[1]]
            and p4[1] == c1[5] and c4[4:] == p0 and final == [left, bottom]):
        return None
    # Monotone control points stay in their own corner. The two central strips
    # are wholly inside the actual path, even though its outer bbox is larger.
    if not (left <= c1[0] <= p1[0] and c1[1] == top and c1[2] == left
            and c1[5] <= c1[3] <= top
            and c2[0] == left and bottom <= c2[1] <= p2[1]
            and left <= c2[2] <= p1[0] and c2[3] == bottom
            and p0[0] <= c3[0] <= right and c3[1] == bottom
            and c3[2] == right and bottom <= c3[3] <= p2[1]
            and c4[0] == right and p4[1] <= c4[1] <= top
            and p0[0] <= c4[2] <= right and c4[3] == top):
        return None
    paint = _hex_color(_declarations(shape).get('fill', shape.get('fill',
                       _declarations(element).get('fill', element.get('fill', '')))))
    return (left, bottom, right, top, p1[0], p0[0], p2[1], p4[1], paint)


def _white_on_dark_css_failure(root):
    """Prove unreadable black-on-dark badges without supplying missing CSS."""
    parents = {child: parent for parent in root.iter() for child in parent}
    witnesses = []
    default_witnesses = []
    number = r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)'
    for node in root.iter():
        if node.tag.split('}')[-1] != 'span' or not (node.text or '').strip():
            continue
        declared_white = _hex_color(_declarations(node).get('--ltx-fg-color', '')) == '#ffffff'
        if not declared_white and _inherited_property(node, parents, '--ltx-fg-color')[0] is not None:
            continue
        color, owner = _inherited_property(node, parents, 'color')
        if not declared_white and color is not None:
            continue  # Only the exact initial HTML black, never guessed CSS.
        if color is None:
            effective = '#000000'  # Exact initial HTML foreground in the isolated renderer.
        elif re.fullmatch(r'var\(\s*--ltx-fg-color\s*\)', color):
            value, _ = _inherited_property(owner, parents, '--ltx-fg-color')
            effective = _hex_color(value or '')
        else:
            effective = _hex_color(color)
        if effective != '#000000':
            continue
        ancestors, cursor = [], node
        while cursor is not None:
            ancestors.append(cursor)
            cursor = parents.get(cursor)
        foreign = next((a for a in ancestors if a.tag.split('}')[-1] == 'foreignObject'), None)
        wrapper = parents.get(foreign)
        if foreign is None or wrapper is None or wrapper.tag.split('}')[-1] != 'g' \
                or len(wrapper) != 1:
            continue
        # No unaccounted transformations between the text and this shared plane.
        if any(a.get('transform') for a in ancestors[:ancestors.index(foreign)]):
            continue
        translate = re.fullmatch(r'matrix\(1(?:\.0)? 0(?:\.0)? 0(?:\.0)? 1(?:\.0)? ('
                                 + number + r') (' + number + r')\)', wrapper.get('transform', ''))
        flip = re.fullmatch(r'matrix\(1 0 0 -1 0 (' + number + r')\)', foreign.get('transform', ''))
        if not translate or not flip or foreign.get('x', '0') != '0' or foreign.get('y', '0') != '0':
            continue
        try:
            width, height = float(foreign.get('width', '')), float(foreign.get('height', ''))
        except ValueError:
            continue
        if not all(math.isfinite(v) and v > 0 for v in (width, height)):
            continue
        x, y, offset = float(translate[1]), float(translate[2]), float(flip[1])
        box = [x, y + offset - height, x + width, y + offset]
        plane = parents.get(wrapper)
        if plane is None:
            continue
        index = list(plane).index(wrapper)
        if index == 0:
            continue
        background = _rounded_rectangle_core(plane[index - 1], default_stroke=not declared_white)
        if background is None or background[-1] is None:
            continue
        # Transparent, clipped, CSS-transformed, or otherwise hidden geometry
        # cannot prove an opaque shared badge. Leave these cases to old guards.
        controls = ancestors + [plane[index - 1], plane[index - 1][0]]
        if not all(_known_visible_controls(a) for a in controls):
            continue
        def controls_style(a):
            values = _declarations(a)
            # A sealed minipage can specify exactly the foreign object's own
            # TeX width. This cannot move its enclosing rectangle or text box.
            if (not declared_white and a.tag.split('}')[-1] == 'span'
                    and 'ltx_minipage' in a.get('class', '').split()
                    and values.get('width') == _declarations(foreign).get('--ltx-fo-width')
                    and re.fullmatch(r'(?:\d+(?:\.\d+)?|\.\d+)em', values.get('width', ''))):
                values = {k: v for k, v in values.items() if k != 'width'}
            return values
        if any('transform' in controls_style(a)
               or any(key in _declarations(a) or a.get(key) is not None
                      for key in ('clip-path', 'mask', 'filter'))
               or any(key in controls_style(a) for key in ('all', '-webkit-text-fill-color',
                          'background', 'background-color', 'mix-blend-mode', 'text-shadow',
                          'translate', 'rotate', 'scale', 'transform-origin', 'offset', 'offset-path',
                          'offset-distance', 'offset-position', 'offset-rotate', 'offset-anchor', 'zoom', 'position',
                          'inset', 'inset-inline', 'inset-block', 'inset-inline-start', 'inset-inline-end',
                          'inset-block-start', 'inset-block-end', 'left', 'right', 'top', 'bottom',
                          'margin', 'padding', 'width', 'height'))
               or any(key.startswith(('margin-', 'padding-', 'inset-'))
                      for key in controls_style(a))
               for a in controls):
            continue
        if any(any(_declarations(a).get(key, a.get(key, '1')) not in {'1', '1.0'}
                   for key in ('opacity', 'fill-opacity')) for a in controls):
            continue
        left, bottom, right, top, inner_left, inner_right, inner_bottom, inner_top, paint = background
        if not declared_white and paint != '#000000':
            continue  # The new absence proof requires identical opaque black.
        if not declared_white:
            safe_css = {'--ltx-stroke-color', '--ltx-fill-color', '--ltx-fo-width',
                        '--ltx-fo-height', '--ltx-fo-depth', 'font-size', 'width'}
            if any('/*' in a.get('style', '') or '*/' in a.get('style', '')
                   or '\\' in a.get('style', '')
                   or any(key not in safe_css for key in _declarations(a)) for a in controls):
                continue  # No inferred semantics for arbitrary or escaped CSS.
            if any(any(re.search(r'!\s*important\b', value, re.I) for value in _declarations(a).values())
                   or _declarations(a).get('display', 'inline') not in {'inline', 'block', 'inline-block'}
                   or _declarations(a).get('visibility', 'visible') != 'visible'
                   for a in controls):
                continue  # Unknown CSS visibility cannot prove a black badge.
            if any(any(key == '-webkit-text-stroke' or key.startswith('-webkit-text-stroke-')
                       for key in _declarations(a)) for a in controls):
                continue
            background_ancestors, cursor = [], plane[index - 1][0]
            while cursor is not None:
                background_ancestors.append(cursor)
                cursor = parents.get(cursor)
            if any(_declarations(a).get('display', a.get('display', '')).lower() == 'none'
                   or _declarations(a).get('visibility', '').lower() in {'hidden', 'collapse'}
                   for a in background_ancestors):
                continue
            widths = [_declarations(a).get('stroke-width', a.get('stroke-width'))
                      for a in background_ancestors]
            def thin_outline(value):
                if value is None:
                    return True  # SVG initial one-unit outline.
                match = re.fullmatch(r'(\d+(?:\.\d+)?|\.\d+)(px|pt)?', value.strip())
                return bool(match and float(match[1]) <= (.75 if match[2] == 'pt' else 1))
            if not all(thin_outline(value) for value in widths):
                continue
            if not (left + 1 <= box[0] <= box[2] <= right - 1
                    and bottom + 1 <= box[1] <= box[3] <= top - 1
                    and (inner_left + 1 <= box[0] <= box[2] <= inner_right - 1
                         or inner_bottom + 1 <= box[1] <= box[3] <= inner_top - 1)):
                continue
        if not (left <= box[0] <= box[2] <= right and bottom <= box[1] <= box[3] <= top
                and (inner_left <= box[0] <= box[2] <= inner_right
                     or inner_bottom <= box[1] <= box[3] <= inner_top)):
            continue
        channels = [int(paint[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        light = sum(weight * (v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4)
                    for weight, v in zip((.2126, .7152, .0722), channels))
        if (light + .05) / .05 >= 3 or 1.05 / (light + .05) <= 4.5:
            continue
        target = witnesses if declared_white else default_witnesses
        target.append({'textElementId': node.get('id'), 'declaredForeground': '#ffffff' if declared_white else None,
                          'effectiveForeground': effective, 'background': paint,
                          'foreignObjectBox': box, 'backgroundBox': [left, bottom, right, top],
                          'backgroundPathSha256': sha(plane[index - 1][0].get('d', '').encode())})
    if witnesses:
        return {'reason': 'unmapped_latexml_white_text_on_dark_badge', 'witnesses': witnesses}
    return {'reason': 'default_html_black_text_on_black_badge', 'witnesses': default_witnesses} if default_witnesses else None


def _caption_display_projection(caption):
    # Only explicit alphabetic products with the saved TeX thin-space/cdot
    # spelling. Keep the complete caption; unknown TeX still fails exact replay.
    replacements = []
    def product(match):
        projected = match[0].replace(r'\,\cdot\,', ' · ')
        replacements.append({'start': match.start(), 'end': match.end(),
                             'source': match[0], 'display': projected})
        return projected
    displayed = re.sub(r'(?<![A-Za-z\\])(?:[A-Za-z]\\,\\cdot\\,)+[A-Za-z](?![A-Za-z\\])', product, caption)
    if not replacements:
        return caption, None
    return displayed, {'contract': 'caption-explicit-tex-cdot-display-v1',
                       'originalCaptionSha256': sha(caption.encode()),
                       'displayCaption': displayed, 'displayCaptionSha256': sha(displayed.encode()),
                       'replacements': replacements}


def dependency_failure(raw):
    """Probe only; keep the historical renderer/security contract unchanged."""
    root = ET.fromstring(validate_svg(raw))
    ids = {node.attrib['id']: node for node in root.iter() if 'id' in node.attrib}

    def references(node):
        result = []
        for name, value in node.attrib.items():
            if (name.split('}')[-1] == 'href' and node.tag.split('}')[-1].lower()
                    in {'use', 'pattern', 'lineargradient', 'radialgradient'}):
                result.append(value[1:])  # validate_svg already requires local #ID.
            result.extend(re.findall(r'url\(#([A-Za-z_][\w.:-]*)\)', value))
        return result

    missing = sorted({target for node in root.iter() for target in references(node)
                      if target not in ids})
    if missing:
        return {'reason': 'missing_local_fragment_targets', 'targets': missing}
    graph = {key: {target for node in element.iter() for target in references(node)}
             for key, element in ids.items()}
    visiting, visited = set(), set()

    def cycle(key):
        if key in visiting:
            return True
        if key in visited:
            return False
        visiting.add(key)
        found = any(cycle(target) for target in graph[key])
        visiting.remove(key)
        visited.add(key)
        return found

    if any(cycle(key) for key in graph):
        return {'reason': 'cyclic_local_fragment_dependencies', 'targets': []}
    color_failure = _white_on_dark_css_failure(root)
    if color_failure:
        return color_failure
    # LaTeXML minipage spans use an inline width, but the isolated renderer has
    # no stylesheet to turn these spans into inline blocks. Width therefore has
    # no effect and text spills into adjacent cells. Require actual text and the
    # exact unstyled foreignObject wrappers; arbitrary classes are not evidence.
    parents = {child: parent for parent in root.iter() for child in parent}
    witnesses = []
    for node in root.iter():
        classes = set(node.attrib.get('class', '').split())
        declarations = _declarations(node)
        if (node.tag.split('}')[-1] != 'span'
                or not {'ltx_inline-block', 'ltx_minipage'}.issubset(classes)
                or not re.fullmatch(r'(?:\d+(?:\.\d+)?|\.\d+)em', declarations.get('width', ''))
                or 'display' in declarations or not ''.join(node.itertext()).strip()
                or not has_unsaved_latexml_static_layout(node, parents)):
            continue
        witnesses.append({'elementId': node.get('id'), 'width': declarations['width']})
    if len(witnesses) >= 3:
        return {'reason': 'unmapped_latexml_minipage_layout', 'witnesses': witnesses}
    return None


def derive_page_asset(*, paper_id, figure, resource, old_pixels, pdf_bytes, source_files):
    """Return None for self-contained SVGs; otherwise require an exact full page.

    Caller first verifies the normal daily bundle and the original saved model
    pixel replay. All arguments are rechecked here before caching any derivative.
    """
    raw = resource.get('inlineSvg', '').encode()
    failure = dependency_failure(raw)
    if failure is None:
        return None
    descriptor = source_descriptor(resource, paper_id)
    need(all(figure.get(key) == descriptor[key] for key in descriptor),
         'pdf_page_original_svg_identity_changed')
    need(re.fullmatch(r'[a-f0-9]{64}', str(figure.get('sourceDomSha256', ''))),
         'pdf_page_original_dom_sha_missing')
    need(isinstance(old_pixels, bytes) and old_pixels.startswith(b'\x89PNG\r\n\x1a\n')
         and sha(old_pixels) == figure.get('assetSha256'), 'pdf_page_original_pixel_sha_changed')
    need(isinstance(source_files, dict) and set(source_files) == {
        'source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'}
         and all(re.fullmatch(r'[a-f0-9]{64}', str(v)) for v in source_files.values()),
         'pdf_page_four_source_proofs_missing')
    need(isinstance(pdf_bytes, bytes) and pdf_bytes.startswith(b'%PDF-')
         and len(pdf_bytes) <= 512 * 1024 * 1024
         and sha(pdf_bytes) == source_files['source.pdf'], 'pdf_page_pdf_sha_changed')
    caption = norm(figure.get('caption', ''))
    displayed_caption, caption_projection = _caption_display_projection(caption)
    fig_id_pattern = r'(?:[A-Za-z]\.?)?[1-9][0-9]*(?:\.[0-9]+)*'
    # LaTeXML inserts a colon after an otherwise identical printed PDF label.
    # Accept its absence only at the complete caption's opening label.
    colonless_caption = re.sub(
        r'^((?:Figure|Fig\.?)\s+' + fig_id_pattern + r')\s*:\s*',
        r'\1 ',
        displayed_caption,
        flags=re.I,
    )
    # 图号允许附录/补充材料字母前缀（Figure S1、Figure A.1）与子编号（Figure 7.1）；
    # 纯数字编号仍记 int，带字母前缀编号记规范化大写字符串（如 "S1"、"A.1"）。
    numbered = re.match(r'^(?:Figure|Fig\.?)\s+(' + fig_id_pattern + r')\s*[:.]\s*\S', caption, re.I)
    label = re.fullmatch(r'(?:Figure|Fig\.?)\s+(' + fig_id_pattern + r')\s*[:.]?', norm(figure.get('label', '')), re.I)
    def _canonical_figure_id(raw_id):
        head = re.match(r'^(?:[A-Za-z]\.?)?[1-9][0-9]*', raw_id).group(0)
        return int(head) if (head.isascii() and head.isdigit()) else head.upper()
    # 封存来源本身没有图注时（例如 LaTeXML 只抽到空 caption），仍可按原图号
    # 定位唯一整页，但必须显式记为「图注未完整抽取」，不能冒完整图注。
    caption_limited = not caption
    if caption_limited:
        need(label is not None and type(figure.get('ordinal')) is int and figure['ordinal'] > 0,
             'pdf_page_figure_number_or_caption_invalid')
        figure_label = label[1]
        figure_number = _canonical_figure_id(figure_label)
    else:
        need(numbered is not None and label is not None and numbered[1].upper() == label[1].upper()
             and type(figure.get('ordinal')) is int and figure['ordinal'] > 0,
             'pdf_page_figure_number_or_caption_invalid')
        figure_label = numbered[1]
        figure_number = _canonical_figure_id(figure_label)
    renderer = {'contract': 'pymupdf-full-media-box-png-v1', 'dpi': DPI,
                'backend': 'pymupdf', 'version': fitz.version[0],
                'helperSha256': sha(Path(__file__).read_bytes()),
                'svgValidatorSha256': sha(Path(__file__).with_name('reader_inline_svg.py').read_bytes())}
    identity = {'contract': CONTRACT, 'paperId': paper_id, 'figureOrdinal': figure['ordinal'],
                'figureNumber': figure_number, 'sourceUrl': descriptor['url'],
                'sourceDomSha256': figure['sourceDomSha256'],
                'sourceSvgSha256': descriptor['inlineSvgSourceSha256'],
                'originalReaderPixelSha256': figure['assetSha256'],
                'sourceFiles': dict(source_files), 'caption': caption,
                'captionLimited': caption_limited,
                'captionSha256': sha(caption.encode()), 'dependencyFailure': failure,
                'renderer': renderer}
    if caption_projection:
        caption_projection['originalReaderCaptionSha256'] = sha(figure['caption'].encode())
        identity['captionDisplayProjection'] = caption_projection
    key = stable(identity)
    if key in _CACHE:
        pixels, proof = _CACHE[key]
        return pixels, copy.deepcopy(proof)
    with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
        need(not document.needs_pass and 1 <= len(document) <= 2048,
             'pdf_page_document_not_supported')
        matches, numbers = [], []
        for page in document:
            page_blocks = page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT)
            # 整页文字骨架：PyMuPDF 可能把一条长图注拆进多个 block，逐块比对会
            # 只剩前半句；这里用整页拼接做「完整图注是否在这一页」的判定。
            page_skeleton = _caption_skeleton(' '.join(block[4] for block in page_blocks))
            for block in page_blocks:
                text = _pdf_caption_text(block[4])
                # 编号后面允许句点，但不能是更长编号（1 → 10、7.1 → 7.10、S1 → S10）。
                delimited_label = bool(re.match(
                    r'^(?:Figure|Fig\.?)\s+' + re.escape(figure_label)
                    + r'(?!\d)(?!\.\d)\s*[:.]\s*\S', text, re.I))
                bare_label = bool(re.match(
                    r'^(?:Figure|Fig\.?)\s+' + re.escape(figure_label)
                    + r'(?!\d)(?!\.\d)\s+\S', text, re.I))
                standalone_label = caption_limited and bool(re.fullmatch(
                    r'(?:Figure|Fig\.?)\s+' + re.escape(figure_label) + r'\s*[:.]?',
                    text, re.I))
                if not (delimited_label or bare_label or standalone_label):
                    # 只有以本图图号开头的 block 才可能是图注；正文段落、
                    # 图内标注文字都不能当图注候选。
                    continue
                if caption_limited:
                    numbers.append(page.number + 1)
                    matches.append((page.number, text))
                    continue
                # 完整图注已知时，跨页散文引用句（如 "Figure S1 summarizes..."，无冒号/句号分隔
                # 且不等于冒号省略版完整图注）不是图注头，不计入图注头冲突计数。
                if delimited_label or text == colonless_caption:
                    numbers.append(page.number + 1)
                if text in {displayed_caption, colonless_caption}:
                    matches.append((page.number, block[4]))
                elif failure['reason'] == 'unmapped_latexml_minipage_layout':
                    # PDF line-wrap hyphens may split a word, and its caption
                    # may use Fig. N. instead of HTML Figure N:. Only the full
                    # caption equality after these two exact projections counts.
                    wrapped = re.sub(r'(?<=[A-Za-z])-\r?\n(?=[A-Za-z])', '', block[4])
                    wrapped = _pdf_caption_text(wrapped)
                    wrapped = re.sub(
                        r'^(?:Fig\.|Figure)\s+(' + fig_id_pattern + r')\.\s*',
                        r'Figure \1: ',
                        wrapped,
                        flags=re.I,
                    )
                    wrapped = re.sub(
                        r'^Fig\.\s+(' + fig_id_pattern + r')(?=\s)',
                        r'Figure \1',
                        wrapped,
                        flags=re.I,
                    )
                    # 公式排版差异（LaTeX vs 印刷字形）用文字骨架兜底：词语、数字
                    # 与顺序仍须完全一致，只有纯排版符号被忽略。
                    block_skeleton = _caption_skeleton(wrapped)
                    caption_skeleton = _caption_skeleton(displayed_caption)
                    label_only_skeleton = _caption_skeleton(f'Figure {figure_label}')
                    split_caption_in_page = (
                        len(block_skeleton) > len(label_only_skeleton)
                        and caption_skeleton.startswith(block_skeleton)
                        and caption_skeleton in page_skeleton
                    )
                    # 图注被拆到下一页时整页拼接也装不下完整图注；此时要求本块
                    # 已经逐字覆盖图注前 120 个字（骨架），后文可续在下一页。
                    long_prefix = (len(block_skeleton) >= 120
                                   and caption_skeleton.startswith(block_skeleton[:120]))
                    if (wrapped == displayed_caption
                            or block_skeleton == caption_skeleton
                            or split_caption_in_page
                            or long_prefix):
                        if not (delimited_label or text == colonless_caption):
                            numbers.append(page.number + 1)
                        # 同一页完整图注被拆进多个 block 时只记一次首块；独立重复的完整图注仍须记冲突。
                        if wrapped == displayed_caption or block_skeleton == caption_skeleton:
                            matches.append((page.number, block[4]))
                        elif not any(item[0] == page.number for item in matches):
                            matches.append((page.number, block[4]))
        if caption_limited:
            # 无图注时只要求「图号在全文唯一对应一页」；正文里以 Figure N 开头的
            # 引用句与图注同页时不算冲突，但仍不能跨页。
            pages = sorted({page_no for page_no, _text in matches})
            need(len(pages) == 1, 'pdf_page_full_caption_or_figure_number_not_unique')
            index, raw_caption = pages[0], ''
        else:
            need(len(matches) == 1 and numbers == [matches[0][0] + 1],
                 'pdf_page_full_caption_or_figure_number_not_unique')
            index, raw_caption = matches[0]
        page = document[index]
        media = list(page.mediabox)
        need(page.rotation == 0 and list(page.cropbox) == media and list(page.rect) == media
             and media[:2] == [0, 0] and all(math.isfinite(x) for x in media)
             and 0 < media[2] * DPI / 72 <= 4096 and 0 < media[3] * DPI / 72 <= 4096
             and media[2] * media[3] * (DPI / 72) ** 2 <= 16_000_000,
             'pdf_page_full_media_box_not_supported')
        # Same full-page primitive as pdf-layout-extract.py; never pass a clip.
        pixmap = page.get_pixmap(dpi=DPI, alpha=False)
        pixels = pixmap.tobytes('png')
        need(len(pixels) <= MAX_OUTPUT_BYTES and pixels.startswith(b'\x89PNG\r\n\x1a\n'),
             'pdf_page_png_exceeds_limit')
        width, height = struct.unpack('>II', pixels[16:24])
        proof = {**identity, 'page': index + 1, 'mediaBox': media,
                 'rawCaptionSha256': sha(raw_caption.encode()),
                 'pdfCaptionTypography': {'contract': 'pdf-caption-latin-ligature-line-wrap-v1',
                    'text': _pdf_caption_text(raw_caption),
                    'openingLabelColonOmitted': _pdf_caption_text(raw_caption) != displayed_caption},
                 'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode()),
                 'assetSha256': sha(pixels), 'assetBytes': len(pixels),
                 'assetWidth': width, 'assetHeight': height,
                 'displayLabel': (f'原论文 PDF 第 {index + 1} 页（含图 {figure_number}；图注未完整抽取，以原页为准）'
                                 if caption_limited else
                                 f'原论文 PDF 第 {index + 1} 页（含图 {figure_number}）')}
    proof['proofSha256'] = stable(proof)
    if len(_CACHE) >= 4:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (pixels, copy.deepcopy(proof))
    return pixels, proof

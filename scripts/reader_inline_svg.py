#!/usr/bin/env python3
"""把无外部资源的官方内联 SVG 转成当前调用使用的真实像素。"""

import hashlib
from html.entities import html5
from html.parser import HTMLParser
import math
import os
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

from runtime_guard import require_external_runtime

MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
ALLOWED_TAGS = set(('svg g path rect circle ellipse line polyline polygon text tspan defs '
                    'clipPath mask marker linearGradient radialGradient stop pattern symbol use '
                    'foreignObject span div p br b strong i em sub sup a math semantics annotation '
                    'mrow mi mn mo mtext mspace msup msub msubsup mfrac msqrt mroot mover '
                    'munder munderover mtable mtr mtd mphantom').lower().split())
ALLOWED_ATTRIBUTES = set(('id class style x y x1 y1 x2 y2 cx cy r rx ry dx dy d points '
                          'width height viewbox preserveaspectratio transform version overflow '
                          'fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin '
                          'stroke-dasharray stroke-dashoffset stroke-opacity opacity color '
                          'font-family font-size font-weight font-style text-anchor dominant-baseline '
                          'clip-path clip-rule mask marker-start marker-mid marker-end offset '
                          'stop-color stop-opacity gradientunits gradienttransform patternunits '
                          'patterncontentunits patterntransform href title alt alttext display mathcolor '
                          'mathvariant mathsize maxsize minsize lspace rspace intent encoding rowalign columnalign').split())



def normalize_html_svg_entities(text):
    if re.search(r'<!DOCTYPE|<!ENTITY|<\?', text, re.I):
        raise ValueError('内联 SVG 不允许实体或处理指令')
    def replace(match):
        name = match.group(1)
        if name in {'amp', 'lt', 'gt', 'quot', 'apos'}:
            return match.group(0)
        value = html5.get(name + ';')
        if value is None:
            raise ValueError('内联 SVG 含未知的命名实体')
        return ''.join(f'&#{ord(character)};' for character in value)
    return re.sub(r'&([A-Za-z][A-Za-z0-9]+);', replace, text)


def normalize_static_html_breaks(text):
    class BreakTokens(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=False)
            self.replacements = []
            self.has_image = False

        def handle_starttag(self, tag, attrs):
            if tag == 'img':
                self.has_image = True
            if tag != 'br':
                return
            line, column = self.getpos()
            offset = sum(len(part) for part in text.splitlines(keepends=True)[:line - 1]) + column
            token = self.get_starttag_text()
            self.replacements.append((offset, token, token[:-1] + '/>'))

        def handle_startendtag(self, tag, attrs):
            if tag == 'img':
                self.has_image = True

    tokens = BreakTokens()
    tokens.feed(text)
    tokens.close()
    if tokens.has_image:
        return text
    for offset, original, replacement in reversed(tokens.replacements):
        if text[offset:offset + len(original)] != original:
            raise ValueError('内联 SVG 换行节点位置无效')
        text = text[:offset] + replacement + text[offset + len(original):]
    return text


def validate_svg(raw):
    if not raw or len(raw) > MAX_SOURCE_BYTES:
        raise ValueError('内联 SVG 字节为空或超过受控上限')
    text = normalize_static_html_breaks(normalize_html_svg_entities(raw.decode('utf-8')))
    if re.search(r'<!DOCTYPE|<!ENTITY|<\?', text, re.I):
        raise ValueError('内联 SVG 不允许实体或处理指令')
    root = ET.fromstring(text)
    if root.tag.split('}')[-1].lower() != 'svg':
        raise ValueError('内联 SVG 根元素无效')
    parents = {child: parent for parent in root.iter() for child in parent}
    ids = {}
    for node in root.iter():
        identifier = node.attrib.get('id')
        if identifier is not None:
            if identifier in ids:
                raise ValueError('内联 SVG 含重复的元素标识符')
            ids[identifier] = node
    for element in root.iter():
        if element.tag.split('}')[-1].lower() not in ALLOWED_TAGS:
            raise ValueError('内联 SVG 含不允许的元素')
        if element.tag.split('}')[-1].lower() == 'mphantom':
            ancestor = parents.get(element)
            while ancestor is not None and ancestor.tag not in {'math', '{http://www.w3.org/1998/Math/MathML}math'}:
                ancestor = parents.get(ancestor)
            if (element.tag not in {'mphantom', '{http://www.w3.org/1998/Math/MathML}mphantom'}
                    or ancestor is None):
                raise ValueError('内联 SVG 的数学占位元素无效')
        for name, value in element.attrib.items():
            original_name = name
            name = name.split('}')[-1].lower()
            if name in {'accent', 'stretchy'}:
                ancestor = element
                in_math = False
                while ancestor is not None:
                    if ancestor.tag in {'math', '{http://www.w3.org/1998/Math/MathML}math'}:
                        in_math = True
                        break
                    ancestor = parents.get(ancestor)
                allowed_tag = 'mover' if name == 'accent' else 'mo'
                if (original_name != name or element.tag not in {allowed_tag, '{http://www.w3.org/1998/Math/MathML}' + allowed_tag}
                        or not in_math or value not in {'true', 'false'}):
                    raise ValueError('内联 SVG 的数学布尔设置无效')
                continue
            if name not in ALLOWED_ATTRIBUTES or name.startswith('on'):
                raise ValueError('内联 SVG 含事件或资源请求')
            if name == 'href' and not re.fullmatch(r'#[A-Za-z_][\w.:-]*', value):
                raise ValueError('内联 SVG 引用只能指向本图元素')
            if name == 'clip-path' and original_name == name:
                local_clip = re.fullmatch(r'url\(#([A-Za-z_][\w.:-]*)\)', value)
                if local_clip:
                    target = ids.get(local_clip.group(1))
                    if target is None or target.tag not in {'clipPath', '{http://www.w3.org/2000/svg}clipPath'}:
                        raise ValueError('内联 SVG 裁剪引用必须对应本图裁剪元素')
                    continue
            if re.search(r'url\s*\(|@import|expression\s*\(|javascript\s*:|data\s*:|https?\s*:|file\s*:', value, re.I):
                raise ValueError('内联 SVG 含外部资源或动态样式')
            if name == 'style' and ('\\' in value or '@' in value):
                raise ValueError('内联 SVG 样式不允许转义资源或规则')
    box = [float(x) for x in re.split(r'[\s,]+', root.attrib.get('viewBox', '').strip()) if x]
    if len(box) != 4 or not all(math.isfinite(x) for x in box) or min(box[2:]) <= 0:
        raise ValueError('内联 SVG 必须声明有限的正尺寸 viewBox')
    if max(box[2:]) > 4096 or box[2] * box[3] > 16_000_000:
        raise ValueError('内联 SVG 尺寸超过受控上限')
    for key in ('width', 'height'):
        dimension = root.attrib.get(key, '')
        if not re.fullmatch(r'\d+(?:\.\d+)?(?:px)?', dimension):
            raise ValueError('内联 SVG 必须声明有限的像素尺寸')
        if not 0 < float(dimension.removesuffix('px')) <= 4096:
            raise ValueError('内联 SVG 像素尺寸超过受控上限')
    return text


def source_descriptor(resource, arxiv_id):
    identifier = re.sub(r'v\d+$', '', str(arxiv_id or ''))
    if not re.fullmatch(r'\d{4}\.\d{4,5}', identifier) or not isinstance(resource, dict):
        raise ValueError('内联 SVG 的论文身份无效')
    text = resource.get('inlineSvg')
    if resource.get('kind') != 'inline_svg' or resource.get('mediaType') != 'image/svg+xml' or not isinstance(text, str):
        raise ValueError('内联 SVG 的来源类型无效')
    raw = text.encode('utf-8')
    if len(raw) != resource.get('inlineSvgBytes') or hashlib.sha256(raw).hexdigest() != resource.get('inlineSvgSha256'):
        raise ValueError('内联 SVG 的封存原字节不符')
    if not raw or len(raw) > MAX_SOURCE_BYTES or re.search(r'<!DOCTYPE|<!ENTITY|<\?', text, re.I):
        raise ValueError('内联 SVG 不允许实体、处理指令或超限来源')
    root = ET.fromstring(normalize_html_svg_entities(text))
    element_id = root.attrib.get('id')
    if root.tag.split('}')[-1] != 'svg' or not re.fullmatch(r'[A-Za-z0-9_.:-]+', str(element_id or '')):
        raise ValueError('内联 SVG 没有原文元素定位')
    return {'url': f'https://arxiv.org/html/{identifier}#{element_id}',
            'inlineSvgSourceSha256': resource['inlineSvgSha256'],
            'inlineSvgRenderContract': 'reader-official-inline-svg-pixels-v1'}


def render_svg(raw):
    text = validate_svg(raw)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        expected = Path(playwright.chromium.executable_path)
        options = {'headless': True}
        if not expected.is_file():
            candidates = []
            for cache in (Path.home() / 'Library/Caches/ms-playwright', Path.home() / '.cache/ms-playwright'):
                if cache.is_symlink() or not cache.is_dir():
                    continue
                for pattern in ('chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell',
                                'chromium_headless_shell-*/chrome-headless-shell-*/headless_shell'):
                    for candidate in cache.glob(pattern):
                        if candidate.is_symlink() or not candidate.is_file() or not os.access(candidate, os.X_OK):
                            continue
                        candidate.resolve().relative_to(cache.resolve())
                        candidates.append(candidate.resolve())
            if not candidates:
                raise ValueError('当前没有可用的受控浏览器运行时')
            options['executable_path'] = str(sorted(candidates)[-1])
        browser = playwright.chromium.launch(**options)
        try:
            context = browser.new_context(java_script_enabled=False, viewport={'width': 4096, 'height': 4096})
            page = context.new_page()
            page.route('**/*', lambda route: route.abort())
            page.set_content('<!doctype html><meta charset="utf-8">'
                             '<style>html,body{margin:0;background:white}</style>' + text,
                             wait_until='load', timeout=30_000)
            figure = page.locator('body > svg')
            bounds = figure.bounding_box()
            if (not bounds or not all(math.isfinite(bounds[k]) for k in ('width', 'height'))
                    or not 0 < bounds['width'] <= 4096 or not 0 < bounds['height'] <= 4096
                    or bounds['width'] * bounds['height'] > 16_000_000):
                raise ValueError('内联 SVG 实际显示尺寸超过受控上限')
            png = figure.screenshot(type='png', animations='disabled', timeout=30_000)
        finally:
            browser.close()
    if not png.startswith(b'\x89PNG\r\n\x1a\n') or len(png) > MAX_OUTPUT_BYTES:
        raise ValueError('内联 SVG 渲染输出无效或超过受控上限')
    return png


if __name__ == '__main__':
    require_external_runtime('render-reader-inline-svg')
    sys.stdout.buffer.write(render_svg(sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)))

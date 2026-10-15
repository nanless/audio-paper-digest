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

import fitz
from reader_inline_svg import source_descriptor, validate_svg

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
    numbered = re.match(r'^(?:Figure|Fig\.?)\s+(\d+)\s*[:.]\s*\S', caption, re.I)
    label = re.fullmatch(r'(?:Figure|Fig\.?)\s+(\d+)\s*[:.]?', norm(figure.get('label', '')), re.I)
    need(numbered is not None and label is not None and numbered[1] == label[1]
         and type(figure.get('ordinal')) is int and figure['ordinal'] > 0,
         'pdf_page_figure_number_or_caption_invalid')
    renderer = {'contract': 'pymupdf-full-media-box-png-v1', 'dpi': DPI,
                'backend': 'pymupdf', 'version': fitz.version[0],
                'helperSha256': sha(Path(__file__).read_bytes()),
                'svgValidatorSha256': sha(Path(__file__).with_name('reader_inline_svg.py').read_bytes())}
    identity = {'contract': CONTRACT, 'paperId': paper_id, 'figureOrdinal': figure['ordinal'],
                'figureNumber': int(numbered[1]), 'sourceUrl': descriptor['url'],
                'sourceDomSha256': figure['sourceDomSha256'],
                'sourceSvgSha256': descriptor['inlineSvgSourceSha256'],
                'originalReaderPixelSha256': figure['assetSha256'],
                'sourceFiles': dict(source_files), 'caption': caption,
                'captionSha256': sha(caption.encode()), 'dependencyFailure': failure,
                'renderer': renderer}
    key = stable(identity)
    if key in _CACHE:
        pixels, proof = _CACHE[key]
        return pixels, copy.deepcopy(proof)
    with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
        need(not document.needs_pass and 1 <= len(document) <= 2048,
             'pdf_page_document_not_supported')
        matches, numbers = [], []
        for page in document:
            for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
                text = norm(block[4])
                if re.match(r'^(?:Figure|Fig\.?)\s+' + str(int(numbered[1])) + r'(?!\d)\s*[:.]', text, re.I):
                    numbers.append(page.number + 1)
                if text == caption:
                    matches.append((page.number, block[4]))
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
                 'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode()),
                 'assetSha256': sha(pixels), 'assetBytes': len(pixels),
                 'assetWidth': width, 'assetHeight': height,
                 'displayLabel': f'原论文 PDF 第 {index + 1} 页（含图 {int(numbered[1])}）'}
    proof['proofSha256'] = stable(proof)
    if len(_CACHE) >= 4:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (pixels, copy.deepcopy(proof))
    return pixels, proof

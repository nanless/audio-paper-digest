"""Pure shared PDF page geometry: no daily/conference identity or permission.

Callers authenticate original PDF and source independently. This module accepts
no crop, page number, profile, source root, or eligibility flag from a caller.
"""

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader_pdf_page_geometry.py')
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import hashlib
import math
import re
import struct
import fitz

DPI = 144
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000

def need(value, reason):
    if not value:
        raise ValueError(reason)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def norm(value):
    return re.sub(r'\s+', ' ', value).strip()

def locate_unique_figure_caption(document, number, caption):
    need(type(number) is int and 1 <= number <= 512 and isinstance(caption, str),
         'pdf_page_figure_number_or_caption_invalid')
    label = re.compile(r'^(?:Figure|Fig\.?)\s+' + str(number) + r'(?!\d)\s*[:.]', re.I)
    matches, numbers = [], []
    for page in document:
        for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
            text = norm(block[4])
            if label.match(text):
                numbers.append(page.number + 1)
            if text == norm(caption):
                matches.append((page.number, block))
    need(len(matches) == 1 and numbers == [matches[0][0] + 1]
         and label.match(norm(matches[0][1][4])),
         'pdf_page_full_caption_or_figure_number_not_unique')
    index, block = matches[0]
    return {'page': index + 1, 'bbox': list(map(float, block[:4])),
            'rawText': block[4], 'rawTextSha256': sha(block[4].encode())}

def render_complete_pdf_page(page):
    media = list(page.mediabox)
    need(page.rotation == 0 and list(page.cropbox) == media and list(page.rect) == media
         and media[:2] == [0, 0] and all(math.isfinite(x) for x in media)
         and 0 < media[2] * DPI / 72 <= 4096 and 0 < media[3] * DPI / 72 <= 4096
         and media[2] * media[3] * (DPI / 72) ** 2 <= MAX_PIXELS,
         'pdf_page_full_media_box_not_supported')
    # Deliberately no clip, matrix, resize, crop, overlays, or page mutation.
    pixels = page.get_pixmap(dpi=DPI, alpha=False).tobytes('png')
    need(len(pixels) <= MAX_OUTPUT_BYTES and pixels.startswith(b'\x89PNG\r\n\x1a\n'),
         'pdf_page_png_exceeds_limit')
    width, height = struct.unpack('>II', pixels[16:24])
    return pixels, {'mediaBox': media, 'dpi': DPI, 'assetWidth': width, 'assetHeight': height,
                    'assetSha256': sha(pixels), 'assetBytes': len(pixels)}


def clean_extractor_structure_text(value):
    """Same deterministic scalar/NFC/control/whitespace steps as sealed extractor.

    No substring, label search, decimal comparison, or text substitution. Preserve
    whole runs here; the old extractor's 1200-character cap is not a new license
    to call truncated text a complete PDF caption.
    """
    import unicodedata
    need(isinstance(value, str), 'pdf_caption_run_not_text')
    value = value.encode('utf-16', 'surrogatepass').decode('utf-16', 'replace')
    value = unicodedata.normalize('NFC', value.replace('\r\n', '\n').replace('\r', '\n'))
    value = '\n'.join(line.rstrip() for line in value.split('\n')).strip('\n')
    value = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', value)
    return re.sub(r'\s+', ' ', value).strip()


def caption_line_label(value):
    match = re.match(r'^\s*(?:(figure|fig\.?|table|tab\.?)\s*(\d+)|([图表])\s*(\d+))'
                     r'(?:\s*[.．:：;；)）\-–—]|\s*$)', value, re.I)
    if not match:
        return None
    return ('table' if (match[1] or match[3]).lower() in {'table','tab','tab.','表'} else 'figure', int(match[2] or match[4]))


def source_column_caption_runs(document, number):
    """All genuine native caption-line occurrences; never suppress duplicates.

    Mirrors the original extractor's dict/span and same-column continuation.
    The recorded stop reason prevents a typography-overlap truncated legacy run
    from being newly called a complete caption.
    """
    records = []
    for page in document:
        for block_index, block in enumerate(page.get_text('dict', sort=False).get('blocks', [])):
            if block.get('type') != 0:
                continue
            lines = block.get('lines', [])
            for index, line in enumerate(lines):
                raw = ''.join(span.get('text','') for span in line.get('spans', []))
                if caption_line_label(raw) != ('figure', number):
                    continue
                bbox = list(map(float,line['bbox'])); selected = [{'index':index,'rawText':raw,'bbox':list(bbox)}]
                boundary = 'native-block-end'
                for next_index, following in enumerate(lines[index + 1:], index + 1):
                    text = ''.join(span.get('text','') for span in following.get('spans', []))
                    fx0,fy0,fx1,fy1 = map(float,following['bbox'])
                    if caption_line_label(text):
                        boundary='next-native-caption';break
                    if fy0 < bbox[3] - 2:
                        boundary='overlapping-or-earlier-line-unproven-continuation';break
                    if min(bbox[2],fx1) <= max(bbox[0],fx0):
                        boundary='different-column';break
                    raw += ' ' + text
                    bbox=[min(bbox[0],fx0),bbox[1],max(bbox[2],fx1),fy1]
                    selected.append({'index':next_index,'rawText':text,'bbox':[fx0,fy0,fx1,fy1]})
                records.append({'page':page.number+1,'bbox':bbox,'rawText':raw,'rawTextSha256':sha(raw.encode()),
                    'lineRunProof':{'contract':'original-extractor-same-column-caption-lines-v1',
                        'blockIndex':block_index,'firstLineIndex':index,'lines':selected,'boundary':boundary,
                        'cleanedText':clean_extractor_structure_text(raw),
                        'cleanedTextSha256':sha(clean_extractor_structure_text(raw).encode())}})
    return records


def locate_complete_source_line_caption(document, number, expected):
    candidates=source_column_caption_runs(document,number)
    need(len(candidates)==1,'native_caption_line_number_not_unique')
    found=candidates[0];run=found['lineRunProof'];cleaned=clean_extractor_structure_text(expected)
    need(re.search(r'[:.：]\s*\S', cleaned) is not None,'original_caption_has_no_complete_text')
    need(run['cleanedText']==cleaned,'original_caption_not_exact_native_line_run')
    need(run['boundary']!='overlapping-or-earlier-line-unproven-continuation',
         'original_native_line_run_may_be_partial')
    return found

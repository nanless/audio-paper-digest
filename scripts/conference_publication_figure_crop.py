"""Deterministic publication pixels; never Reader/model-input authority.

Four conservative complete-Figure profiles precede one fixed whole-PDF-page
fallback. No caller crop rectangle, page selector, profile, sealed artifact edit,
or scientific/source/publication permission is accepted. The normal Node
publisher authenticates the original complete Reader and original PDF first.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import unicodedata
import fitz
from reader_pdf_page_geometry import (render_complete_pdf_page, locate_unique_figure_caption,
    locate_complete_source_line_caption, source_column_caption_runs, caption_line_label, clean_extractor_structure_text)

CONTRACT = 'conference-publication-pdf-figure-crop-v1'
PROFILE = 'complete-embedded-raster-with-authenticated-top-matter-v1'
DPI = 288
MAX_PDF_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_000_000


def need(value, reason):
    if not value:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stable(value):
    return sha(json.dumps(value, sort_keys=True, ensure_ascii=False,
                          separators=(',', ':')).encode())


def norm(value):
    return re.sub(r'\s+', ' ', value).strip()


def words(value):
    # Only used to locate already-authenticated bibliographic top matter, not
    # to correct author records. Word order may differ in the original PDF.
    return re.findall(r'[^\W\d_]+', unicodedata.normalize('NFC', value).casefold())


def compact(value):
    return ''.join(character for character in unicodedata.normalize('NFC', value).casefold() if character.isalnum())


def rect(value):
    out = list(map(float, value))
    need(len(out) == 4 and all(math.isfinite(v) for v in out)
         and out[0] < out[2] and out[1] < out[3], 'invalid_pdf_rectangle')
    return out


def inside(inner, outer, epsilon=0.15):
    return (inner[0] >= outer[0] - epsilon and inner[1] >= outer[1] - epsilon
            and inner[2] <= outer[2] + epsilon and inner[3] <= outer[3] + epsilon)


def intersect(a, b):
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def text_lines(page):
    return [{'text': ''.join(s.get('text', '') for s in line['spans']),
             'bbox': rect(line['bbox'])}
            for block in page.get_text('dict', flags=fitz.TEXTFLAGS_TEXT)['blocks']
            if block['type'] == 0 for line in block.get('lines', [])]


def _locate_block_caption(document, number, expected):
    """Require one complete text block and one occurrence of this caption label.

    A partial caption, label-only match, prose mention, or independently inferred
    caption continuation cannot authorize a crop. Source hyphenation is retained.
    """
    label = re.compile(r'^(?:Figure|Fig\.?)\s+' + str(number) + r'(?!\d)\s*[:.]', re.I)
    labels, matches = [], []
    for page in document:
        for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
            raw = block[4]
            if label.match(norm(raw)):
                record = {'page': page.number + 1, 'bbox': rect(block[:4]),
                          'rawText': raw, 'rawTextSha256': sha(raw.encode())}
                labels.append(record)
                if norm(raw) == norm(expected):
                    matches.append(record)
    need(len(labels) == len(matches) == 1, 'figure_full_caption_or_number_not_unique')
    return matches[0]


from contextvars import ContextVar
_ALLOW_SOURCE_LINE_CAPTIONS = ContextVar('allow_closed_source_line_caption', default=False)

def locate_caption(document, number, expected):
    try:
        return _locate_block_caption(document, number, expected)
    except ValueError:
        if not _ALLOW_SOURCE_LINE_CAPTIONS.get():
            raise
        # A single native dict line run must be exact and closed. No substring
        # or short-prefix projection can silently manufacture full-caption proof.
        return locate_complete_source_line_caption(document, number, expected)


def authenticated_header(lines, title, authors, caption_y, width, page_number):
    """Only page-one metadata can exclude logo / author ORCID graphics.

    Every name is located uniquely above the Figure, near the complete title.
    Later organization/email text may be ignored only as individual cross-column
    lines. No visual primitive below the actual author band is exempted.
    """
    if page_number != 1:
        return {'visualBottom': 0.0, 'title': None, 'authors': [], 'ignoredText': []}
    ordered = sorted((line for line in lines if line['bbox'][3] < caption_y),
                     key=lambda x: (x['bbox'][1], x['bbox'][0]))
    wanted = compact(title)
    title_candidates = []
    for start in range(len(ordered)):
        for count in range(1, 5):
            group = ordered[start:start + count]
            if len(group) != count:
                break
            if compact(' '.join(row['text'] for row in group)) == wanted:
                if all(group[i + 1]['bbox'][1] - group[i]['bbox'][3] <= 20
                       for i in range(len(group) - 1)):
                    title_candidates.append(group)
    need(bool(wanted) and len(title_candidates) == 1, 'bibliographic_title_not_unique')
    title_group = title_candidates[0]
    title_bottom = max(line['bbox'][3] for line in title_group)
    name_records = []
    need(isinstance(authors, list) and authors and len(set(authors)) == len(authors),
         'bibliographic_authors_missing')
    for name in authors:
        parts = words(name)
        hits = []
        for line in ordered:
            if not title_bottom < line['bbox'][1] < title_bottom + 65:
                continue
            actual = words(line['text'])
            offsets = [offset for offset in range(len(actual) - len(parts) + 1)
                       if actual[offset:offset + len(parts)] == parts]
            if not offsets:
                offsets = [offset for offset in range(len(actual) - len(parts) + 1)
                           if actual[offset:offset + len(parts)] == list(reversed(parts))]
            hits.extend((line, offset) for offset in offsets)
        need(len(parts) >= 2 and len(hits) == 1, 'bibliographic_author_not_unique')
        line, offset = hits[0]
        name_records.append({'nameSha256': sha(name.encode()), 'lineTextSha256': sha(line['text'].encode()),
                             'bbox': line['bbox'], 'wordOffset': offset})
    bottom = max(item['bbox'][3] for item in name_records)
    ignored = []
    for line in ordered:
        box = line['bbox']
        if box[1] <= bottom:
            continue
        full_width = box[0] < width / 2 < box[2] and box[2] - box[0] >= width * .20
        organization = re.search(r'\b(?:University|Institute|Laborator(?:y|ies)|College|Research|Academy|Corporation|Company)\b',
                                 line['text'], re.I)
        email = '@' in line['text']
        if full_width and (organization or email):
            ignored.append({'textSha256': sha(line['text'].encode()), 'bbox': box})
    return {'visualBottom': bottom, 'title': [{'textSha256': sha(row['text'].encode()),
                                             'bbox': row['bbox']} for row in title_group],
            'authors': name_records, 'ignoredText': ignored}


def select_geometry(document, *, figure_number, caption, title, authors):
    found = locate_caption(document, figure_number, caption)
    page = document[found['page'] - 1]
    media = list(map(float, page.mediabox))
    need(page.rotation == 0 and list(page.cropbox) == media and list(page.rect) == media
         and media[:2] == [0., 0.] and media[2] > 0 and media[3] > 0,
         'page_rotation_or_cropbox_not_supported')
    cap = found['bbox']
    middle = media[2] / 2
    # A cross-column caption has no supported single-raster partition in v1.
    need(not cap[0] < middle < cap[2], 'cross_column_figure_requires_stronger_geometry')
    column = [0. if cap[2] <= middle else middle, 0.,
              middle if cap[2] <= middle else media[2], cap[1]]
    lines = text_lines(page)
    header = authenticated_header(lines, title, authors, cap[1], media[2], found['page'])
    band = [column[0], header['visualBottom'], column[2], cap[1]]
    images = []
    all_images = page.get_image_info(xrefs=True, hashes=True)
    excluded_header = []
    for image in all_images:
        box = rect(image['bbox'])
        if not intersect(box, column):
            continue
        evidence = {'bbox': box, 'xref': image.get('xref', 0),
                    'width': image['width'], 'height': image['height'],
                    'decodedPixelMd5': image['digest'].hex(),
                    'transform': list(map(float, image['transform']))}
        if box[3] <= header['visualBottom']:
            excluded_header.append(evidence)
        elif intersect(box, band):
            images.append(evidence)
    need(len(images) == 1, 'not_one_complete_embedded_raster')
    image = images[0]
    box = image['bbox']
    transform = image['transform']
    need(inside(box, band) and 0 < cap[1] - box[3] <= 35
         and image['xref'] > 0 and image['width'] >= 120 and image['height'] >= 60
         and abs(transform[1]) < .001 and abs(transform[2]) < .001
         and transform[0] > 0 and transform[3] > 0,
         'raster_bbox_or_caption_geometry_unsupported')
    # This profile preserves all subpanels/axes/legends inside the whole image.
    # Any independently positioned text or vector outside it rejects the crop;
    # nothing is discarded based merely on vertical distance or a whitespace gap.
    drawings = []
    for drawing in page.get_drawings():
        raw = drawing.get('rect')
        if raw is None or raw.is_empty:
            continue
        bounds = list(map(float, raw))
        if not intersect(bounds, column):
            continue
        if bounds[3] <= header['visualBottom']:
            excluded_header.append({'kind': 'vector', 'bbox': bounds})
            continue
        if intersect(bounds, band):
            need(inside(bounds, box), 'external_vector_or_subpanel_not_preserved')
            drawings.append({'bbox': bounds, 'drawingSha256': sha(repr(drawing).encode())})
    ignored_text = {(row['textSha256'], tuple(row['bbox'])) for row in header['ignoredText']}
    external_text = []
    for line in lines:
        bounds = line['bbox']
        if not intersect(bounds, band):
            continue
        key = (sha(line['text'].encode()), tuple(bounds))
        if key in ignored_text:
            # It is never legal to ignore an organization-like Figure label
            # inside or below the selected image.
            need(bounds[3] < box[1] and not intersect(bounds, box), 'top_matter_overlaps_figure')
            continue
        need(inside(bounds, box), 'external_axis_legend_or_prose_not_preserved')
        external_text.append({'bbox': bounds, 'textSha256': key[0]})
    crop = [max(0., box[0] - 2), max(band[1], box[1] - 2),
            min(media[2], box[2] + 2), min(cap[1] - 1, box[3] + 2)]
    need(inside(box, crop) and crop[2] - crop[0] > 0 and crop[3] - crop[1] > 0,
         'crop_does_not_preserve_full_raster')
    return page, {'profile': PROFILE, 'page': found['page'], 'mediaBox': media,
                  'caption': found, 'column': column, 'completeRaster': image,
                  'bibliographicHeader': header, 'excludedHeaderVisuals': excluded_header,
                  'containedVectors': drawings, 'containedText': external_text,
                  'cropBox': crop,
                  'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode())}


def derive_figure_crop(*, pdf_bytes, pdf_sha256, figure_number, full_caption, title, authors):
    need(isinstance(pdf_bytes, bytes) and pdf_bytes.startswith(b'%PDF-')
         and len(pdf_bytes) <= MAX_PDF_BYTES and sha(pdf_bytes) == pdf_sha256, 'original_pdf_sha_changed')
    need(type(figure_number) is int and 1 <= figure_number <= 512
         and isinstance(full_caption, str) and 16 <= len(full_caption) <= 4000
         and re.match(r'^(?:Figure|Fig\.?)\s+' + str(figure_number) + r'(?!\d)\s*[:.]', norm(full_caption), re.I),
         'figure_number_or_full_caption_invalid')
    with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
        need(not document.needs_pass and 1 <= len(document) <= 2048, 'unsupported_pdf_document')
        page, geometry = select_geometry(document, figure_number=figure_number,
            caption=full_caption, title=title, authors=authors)
        crop = geometry['cropBox']
        need((crop[2] - crop[0]) * DPI / 72 <= 4096
             and (crop[3] - crop[1]) * DPI / 72 <= 4096
             and (crop[2] - crop[0]) * (crop[3] - crop[1]) * (DPI / 72) ** 2 <= MAX_PIXELS,
             'crop_pixel_budget_exceeded')
        # Only the actual PDF renderer produces pixels. There are no overlays,
        # added labels, raster edits, inherited pixels, or caller-specified clips.
        pixels = page.get_pixmap(dpi=DPI, clip=fitz.Rect(crop), alpha=False).tobytes('png')
    need(pixels.startswith(b'\x89PNG\r\n\x1a\n') and len(pixels) <= MAX_OUTPUT_BYTES,
         'crop_png_budget_exceeded')
    width, height = struct.unpack('>II', pixels[16:24])
    proof = {'contract': CONTRACT, 'purpose': 'publication-display-only',
             'originalPdfSha256': pdf_sha256, 'figureNumber': figure_number,
             'fullCaptionSha256': sha(full_caption.encode()), 'geometry': geometry,
             'renderer': {'backend': 'pymupdf', 'version': fitz.version[0], 'dpi': DPI,
                          'implementationSha256': sha(Path(__file__).read_bytes())},
             'assetSha256': sha(pixels), 'assetBytes': len(pixels),
             'assetWidth': width, 'assetHeight': height}
    proof['proofSha256'] = stable(proof)
    return pixels, proof


def _locate_block_caption_with_explicit_prefix(document, number, original_caption):
    """A separate display-only evidence projection; old caption stays unchanged.

    The original sealed caption may have stopped at an inline vector glyph. Only
    a long exact prefix of one whole uniquely numbered block is supported. No
    punctuation, number, hyphenation or word substitution is normalized away.
    """
    expected = norm(original_caption)
    label = re.compile(r'^(?:Figure|Fig\.?)\s+' + str(number) + r'(?!\d)\s*[:.]', re.I)
    records = []
    for page in document:
        for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
            if label.match(norm(block[4])):
                records.append({'page': page.number + 1, 'bbox': rect(block[:4]),
                                'rawText': block[4], 'rawTextSha256': sha(block[4].encode())})
    need(len(records) == 1, 'figure_number_not_unique_for_prefix_projection')
    found = records[0]; complete = norm(found['rawText'])
    need(complete == expected or (len(expected) >= 80 and len(expected) >= len(complete) * .5
         and complete.startswith(expected + ' ')), 'original_caption_not_exact_long_prefix')
    projection = None if complete == expected else {
        'contract': 'publication-original-caption-prefix-evidence-v1',
        'originalCaptionSha256': sha(original_caption.encode()),
        'originalNormalizedCaptionSha256': sha(expected.encode()),
        'fullPdfCaptionSha256': sha(found['rawText'].encode()),
        'originalCaptionWasComplete': False, 'readerCaptionChanged': False}
    return found, projection


def locate_caption_with_explicit_prefix(document, number, original_caption):
    try:
        return _locate_block_caption_with_explicit_prefix(document, number, original_caption)
    except ValueError:
        if not _ALLOW_SOURCE_LINE_CAPTIONS.get():
            raise
        return locate_complete_source_line_caption(document, number, original_caption), None


def _page_constraints(page):
    media = list(map(float, page.mediabox))
    need(page.rotation == 0 and list(page.cropbox) == media and list(page.rect) == media
         and media[:2] == [0., 0.] and media[2] > 0 and media[3] > 0,
         'page_rotation_or_cropbox_not_supported')
    return media



def painted_drawings(page):
    """Conservative actual paint extents under the PDF's real clip hierarchy.

    MuPDF scissor is an enclosing rectangle even for nonrectangular clips. Its
    intersection can only overinclude actual paint, never discard visible paths.
    The whole active clip evidence is recorded; a raw path bbox outside the clip
    is not mistaken for a visible cross-column waveform or axis.
    """
    clips = []
    result = []
    for index, drawing in enumerate(page.get_drawings(extended=True)):
        level = drawing.get('level')
        need(type(level) is int and level >= 0, 'pdf_clip_hierarchy_missing')
        clips = [clip for clip in clips if clip['level'] < level]
        if drawing['type'] == 'clip':
            scissor = rect(drawing['scissor'])
            clips.append({'level': level, 'scissor': scissor,
                          'clipSha256': sha(repr(drawing).encode())})
            continue
        if drawing['type'] == 'group':
            continue
        need(drawing['type'] in ['s', 'f', 'fs'], 'unsupported_pdf_paint_operation')
        raw = list(map(float, drawing['rect']))
        pad = float(drawing.get('width') or 0) / 2 if 's' in drawing['type'] else 0.
        bounds = [raw[0] - pad, raw[1] - pad, raw[2] + pad, raw[3] + pad]
        for clip in clips:
            c = clip['scissor']
            bounds = [max(bounds[0], c[0]), max(bounds[1], c[1]),
                      min(bounds[2], c[2]), min(bounds[3], c[3])]
        if bounds[0] < bounds[2] and bounds[1] < bounds[3]:
            result.append({'index': index, 'bbox': bounds, 'rawPathBox': raw,
                           'strokePadding': pad, 'activeClips': [dict(c) for c in clips],
                           'drawingSha256': sha(repr(drawing).encode())})
    return result


def _complete_band_visuals(page, region):
    """Return every intersecting primitive and line, never choose a subplot.

    An item crossing the boundary rejects; zero-height/width vector paths are
    still inspected. Only actual PDF operations, not their scientific values,
    decide membership. Whole columns also preserve label text outside paths.
    """
    items = []
    for index, image in enumerate(page.get_image_info(xrefs=True, hashes=True)):
        bounds = list(map(float, image['bbox']))
        if intersect(bounds, region):
            need(inside(bounds, region), 'image_crosses_preserved_band')
            items.append({'kind': 'raster', 'index': index, 'bbox': bounds,
                          'decodedPixelMd5': image['digest'].hex(),
                          'pixelDimensions': [image['width'], image['height']]})
    for drawing in painted_drawings(page):
        bounds = drawing['bbox']
        if intersect(bounds, region):
            need(inside(bounds, region), 'vector_crosses_preserved_band')
            items.append({'kind': 'vector', **drawing})
    texts = []
    for line in text_lines(page):
        if intersect(line['bbox'], region):
            need(inside(line['bbox'], region), 'text_crosses_preserved_band')
            texts.append({'bbox': line['bbox'], 'textSha256': sha(line['text'].encode())})
    need(items, 'preserved_band_has_no_actual_figure_visuals')
    return items, texts


def header_band_geometry(document, *, figure_number, full_caption, title, authors):
    found, projection = locate_caption_with_explicit_prefix(document, figure_number, full_caption)
    need(found['page'] == 1 and figure_number == 1, 'header_profile_requires_first_figure_on_page_one')
    page = document[0]; media = _page_constraints(page); cap = found['bbox']; middle = media[2] / 2
    need(not cap[0] < middle < cap[2], 'header_profile_cross_column_not_supported')
    lines = text_lines(page)
    header = authenticated_header(lines, title, authors, cap[1], media[2], 1)
    # Only authenticated bibliographic text extends the cut below actual names;
    # no graphical Figure content is silently deleted in that extension.
    header_bottom = max([header['visualBottom'], *[r['bbox'][3] for r in header['ignoredText']]])
    left, right = (0., middle) if cap[2] <= middle else (middle, media[2])
    extension = [left, header['visualBottom'] + .2, right, header_bottom + .2]
    if extension[3] > extension[1] + .5:
        for image in page.get_image_info():
            need(not intersect(list(image['bbox']), extension), 'visual_below_authors_inside_header_extension')
        for drawing in painted_drawings(page):
            need(not intersect(drawing['bbox'], extension), 'visual_below_authors_inside_header_extension')
    # Do not guess a narrower top/left from nearest vector pieces. Everything
    # below the proven header and above the complete caption stays visible.
    region = [left, header_bottom + 2., right, cap[1] - 2.]
    need(region[3] - region[1] >= 20, 'header_to_caption_band_too_small')
    visuals, texts = _complete_band_visuals(page, region)
    # A boundary must never separate nearby old caption labels / tables.
    for line in lines:
        if intersect(line['bbox'], region):
            need(not re.match(r'^\s*(?:Figure|Fig\.?|Table|Tab\.?)\s+\d+\b', line['text'], re.I),
                 'other_caption_in_preserved_figure_band')
    return page, {'profile': 'certified-page-one-header-band-v1', 'page': 1,
                  'mediaBox': media, 'caption': found, 'captionPrefixProjection': projection,
                  'bibliographicHeader': header, 'headerBottom': header_bottom,
                  'preservedVisuals': visuals, 'preservedText': texts, 'cropBox': region,
                  'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode())}


def ruled_table_then_figure_geometry(document, *, figure_number, full_caption, title, authors):
    """A full-width, three-rule numeric table above a whole Figure region.

    Selection is exclusively caption/rule geometry. Row numeric syntax is checked
    only after that region has been fixed, never to locate or prefer a result.
    This does not validate/publish table values or grant Reader table bindings.
    """
    found = locate_caption(document, figure_number, full_caption)
    page = document[found['page'] - 1]; media = _page_constraints(page); cap = found['bbox']
    need(cap[0] < media[2] / 2 < cap[2], 'table_profile_requires_full_width_figure')
    captions = [b for b in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT)
                if re.match(r'^\s*Table\s+\d+\s*[:.]', norm(b[4]), re.I) and b[3] < cap[1]]
    need(len(captions) == 1, 'not_one_preceding_full_table_caption')
    table_caption = captions[0]; table_cap = rect(table_caption[:4])
    table_number = int(re.match(r'^\s*Table\s+(\d+)\s*[:.]', norm(table_caption[4]), re.I)[1])
    all_table_captions = [block[4] for item in document
        for block in item.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT)
        if re.match(r'^\s*Table\s+' + str(table_number) + r'(?!\d)\s*[:.]', norm(block[4]), re.I)]
    need(len(all_table_captions) == 1 and norm(all_table_captions[0]) == norm(table_caption[4]),
         'preceding_complete_table_caption_not_globally_unique')
    need(table_cap[0] < media[2] / 2 < table_cap[2], 'preceding_table_not_full_width')
    drawings = page.get_drawings(); rules = []
    for index, drawing in enumerate(drawings):
        if drawing['type'] != 's' or len(drawing['items']) != 1 or drawing['items'][0][0] != 'l':
            continue
        _, first, last = drawing['items'][0]
        if abs(first.y - last.y) <= .05 and abs(first.x - last.x) >= media[2] * .75 \
                and table_cap[3] < first.y < cap[1]:
            rules.append({'index': index, 'y': float(first.y),
                          'x0': float(min(first.x, last.x)), 'x1': float(max(first.x, last.x))})
    rules.sort(key=lambda row: row['y'])
    need(len(rules) == 3 and all(abs(row['x0'] - rules[0]['x0']) < .2
         and abs(row['x1'] - rules[0]['x1']) < .2 for row in rules), 'table_outer_and_header_rules_not_unique')
    top, divider, bottom = rules
    need(top['y'] < divider['y'] < bottom['y'], 'table_rule_order_invalid')
    table_box = [top['x0'] - .3, top['y'] - .3, top['x1'] + .3, bottom['y'] + .3]
    # No raster is permitted in the excluded table. A separate upper panel is
    # therefore never discarded as if it were numeric table content.
    for image in page.get_image_info():
        need(not intersect(list(image['bbox']), table_box), 'excluded_table_contains_raster_or_subpanel')
    table_vectors = []
    for index, drawing in enumerate(drawings):
        bounds = list(map(float, drawing['rect']))
        probe = [bounds[0] - .001, bounds[1] - .001, bounds[2] + .001, bounds[3] + .001]
        if intersect(probe, table_box):
            need(inside(bounds, table_box) and drawing['type'] == 's'
                 and all(item[0] == 'l' for item in drawing['items']), 'excluded_table_contains_non_rule_visual')
            table_vectors.append({'index': index, 'bbox': bounds, 'drawingSha256': sha(repr(drawing).encode())})
    raw_words = [list(word[:5]) for word in page.get_text('words')
                 if word[1] >= divider['y'] and word[3] <= bottom['y']]
    need(raw_words and all(inside(word[:4], table_box) for word in raw_words), 'table_rows_escape_outer_rules')
    rows = []
    for word in sorted(raw_words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        center = (word[1] + word[3]) / 2
        if not rows or abs(rows[-1]['centerY'] - center) > 1.:
            rows.append({'centerY': center, 'words': []})
        rows[-1]['words'].append(word)
    need(len(rows) >= 2, 'complete_table_rows_not_present')
    for row in rows:
        row['words'].sort(key=lambda word: word[0])
        for first_half in [True, False]:
            group = [word for word in row['words'] if (word[0] < media[2] / 2) == first_half]
            numbers = [word for word in group if re.fullmatch(r'[+-]?\d+(?:\.\d+)?%?', str(word[4]))]
            need(len(group) >= 8 and len(numbers) >= 6 and len(group) > len(numbers),
                 'excluded_table_has_incomplete_or_non_numeric_row')
    # Full-width strip keeps every Figure subpanel, axis and label after the
    # proven bottom rule; no cropping by selected panel/result/value is allowed.
    region = [0., bottom['y'] + 2., media[2], cap[1] - 2.]
    visuals, texts = _complete_band_visuals(page, region)
    need(all(row['kind'] == 'raster' for row in visuals) and 1 <= len(visuals) <= 8,
         'table_following_vector_or_ambiguous_figure_unsupported')
    labels = []
    for text in texts:
        matching = [line for line in text_lines(page) if sha(line['text'].encode()) == text['textSha256']
                    and line['bbox'] == text['bbox']]
        need(len(matching) == 1 and re.match(r'^\([a-z]\)\s+\S', matching[0]['text']),
             'table_following_external_text_requires_stronger_geometry')
        pairs = [visual for visual in visuals
                 if visual['bbox'][0] <= text['bbox'][0] < text['bbox'][2] <= visual['bbox'][2]
                 and 0 < text['bbox'][1] - visual['bbox'][3] < 20]
        need(len(pairs) == 1, 'subpanel_label_not_bound_to_one_whole_raster')
        labels.append({'text': matching[0]['text'], 'bbox': text['bbox'], 'rasterIndex': pairs[0]['index']})
    need(len({label['text'][1] for label in labels}) == len(labels)
         and len({label['rasterIndex'] for label in labels}) == len(labels), 'duplicate_subpanel_label')
    return page, {'profile': 'closed-three-rule-table-then-full-raster-figure-v1',
                  'page': found['page'], 'mediaBox': media, 'caption': found,
                  'precedingTable': {'caption': table_caption[4], 'captionSha256': sha(table_caption[4].encode()),
                     'captionBox': table_cap, 'rules': rules, 'box': table_box, 'rows': rows,
                     'ruleVisuals': table_vectors, 'excludedRowCount': len(rows)},
                  'preservedVisuals': visuals, 'preservedText': texts, 'subpanelLabels': labels, 'cropBox': region,
                  'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode())}



def between_consecutive_figure_captions_geometry(document, *, figure_number, full_caption, title, authors):
    """Keep the complete strip after the previous unique complete Figure caption.

    This handles a genuine wrong old asset which included the preceding Figure:
    use both real caption boundaries and retain every native Figure primitive,
    rather than editing old PNGs or changing correct Reader explanations.
    """
    need(figure_number >= 2, 'consecutive_caption_profile_needs_previous_figure')
    found = locate_caption(document, figure_number, full_caption)
    previous_number = figure_number - 1
    previous_labels = [(page.number + 1, block) for page in document
        for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT)
        if re.match(r'^\s*(?:Figure|Fig\.?)\s+' + str(previous_number) + r'(?!\d)\s*[:.]', norm(block[4]), re.I)]
    need(len(previous_labels) == 1 and previous_labels[0][0] == found['page'],
         'previous_complete_figure_caption_not_unique_on_same_page')
    previous_block = previous_labels[0][1]; previous = rect(previous_block[:4]); cap = found['bbox']
    need(previous[3] + 4 < cap[1], 'consecutive_caption_regions_overlap')
    overlap = min(previous[2], cap[2]) - max(previous[0], cap[0])
    need(overlap >= (cap[2] - cap[0]) * .8, 'previous_caption_does_not_bound_this_column')
    page = document[found['page'] - 1]; media = _page_constraints(page); middle = media[2] / 2
    if cap[0] < middle < cap[2]: left, right = 0., media[2]
    elif cap[2] <= middle: left, right = 0., middle
    else: left, right = middle, media[2]
    region = [left, previous[3] + 2., right, cap[1] - 2.]
    visuals, texts = _complete_band_visuals(page, region)
    for line in text_lines(page):
        if intersect(line['bbox'], region):
            need(not re.match(r'^\s*(?:Figure|Fig\.?|Table|Tab\.?)\s+\d+\b', line['text'], re.I),
                 'intervening_caption_in_preserved_figure_strip')
    return page, {'profile': 'complete-strip-between-unique-consecutive-figure-captions-v1',
        'page': found['page'], 'mediaBox': media, 'caption': found,
        'previousCompleteCaption': {'figureNumber': previous_number, 'bbox': previous,
            'rawText': previous_block[4], 'rawTextSha256': sha(previous_block[4].encode())},
        'preservedVisuals': visuals, 'preservedText': texts, 'cropBox': region,
        'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode())}


FULL_PAGE_PROFILE = 'authenticated-complete-pdf-page-with-unique-figure-caption-v1'

def complete_source_page_geometry(document, *, figure_number, full_caption, title, authors):
    """Locate the target Figure but preserve every pixel of its actual PDF page.

    No geometric claim about the old defect or exact Figure boundary is made.
    The same strict complete-caption/prefix projection is used; all page content,
    including title/authors/other Figures/axes/legends, remains unchanged.
    """
    found, projection = locate_caption_with_explicit_prefix(document, figure_number, full_caption)
    found_again = locate_complete_source_line_caption(document, figure_number, full_caption) if 'lineRunProof' in found \
        else locate_unique_figure_caption(document, figure_number, found['rawText'])
    need(found_again == found, 'full_page_unique_caption_replay_changed')
    page = document[found['page'] - 1]
    media = _page_constraints(page)
    return page, {'profile': FULL_PAGE_PROFILE, 'page': found['page'], 'mediaBox': media,
        'caption': found, 'captionDisplayProjection': projection,
        'originalReaderCaptionWasComplete': projection is None, 'cropBox': media,
        'fullPage': True, 'pageContentModified': False, 'geometricDefectClaimedFixed': False,
        'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode())}


def derive_authenticated_complete_page(*, pdf_bytes, pdf_sha256, figure_number, full_caption, title, authors):
    """Pure diagnostic/shared primitive. The normal CLI chooses profiles itself."""
    need(isinstance(pdf_bytes, bytes) and pdf_bytes.startswith(b'%PDF-')
         and len(pdf_bytes) <= MAX_PDF_BYTES and sha(pdf_bytes) == pdf_sha256, 'original_pdf_sha_changed')
    need(type(figure_number) is int and 1 <= figure_number <= 512, 'invalid_figure_number')
    with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
        need(not document.needs_pass and 1 <= len(document) <= 2048, 'unsupported_pdf_document')
        page, geometry = complete_source_page_geometry(document, figure_number=figure_number,
            full_caption=full_caption, title=title, authors=authors)
        pixels, rendered = render_complete_pdf_page(page)
    proof = {'contract': CONTRACT, 'purpose': 'publication-display-only', 'readerInputPixelsChanged': False,
        'originalPdfSha256': pdf_sha256, 'figureNumber': figure_number,
        'originalReaderCaptionSha256': sha(full_caption.encode()), 'geometry': geometry,
        'renderer': {'backend': 'pymupdf', 'version': fitz.version[0], 'dpi': rendered['dpi'],
            'implementationSha256': sha(Path(__file__).read_bytes()),
            'sharedPageGeometrySha256': sha(Path(__file__).with_name('reader_pdf_page_geometry.py').read_bytes())},
        **{key: rendered[key] for key in ['assetWidth','assetHeight','assetSha256','assetBytes']}}
    proof['proofSha256'] = stable(proof)
    return pixels, proof


ATTESTED_PAGE_PROFILE = 'attested-source-page-only-v1'

def derive_attested_source_page(*, pdf_bytes, pdf_sha256, figure_number, full_caption, attested_source_ref):
    need(isinstance(pdf_bytes,bytes) and pdf_bytes.startswith(b'%PDF-') and sha(pdf_bytes)==pdf_sha256
         and len(pdf_bytes)<=MAX_PDF_BYTES,'original_pdf_sha_changed')
    ref=attested_source_ref
    keys={'eligible','contract','paperId','executionId','ordinal','figureNumber','page','sourceRef','sourceDomSha256',
          'originalCaptionSha256','readerCaptionSha256','originalSourceAssetSha256','rawArtifactsFileSha256','rawArtifactsPayloadSha256',
          'rawFigureSha256','pdfSha256'}
    need(isinstance(ref,dict) and set(ref)==keys and ref.get('eligible') is True
         and ref.get('contract')=='conference-reader-pdf-attested-figure-ref-v1','attested_original_source_ref_required')
    match=re.fullmatch(r'pdf:figure:([1-9][0-9]*):page:([1-9][0-9]*)',ref.get('sourceRef',''))
    need(match and type(ref['figureNumber']) is int and ref['figureNumber']==figure_number==int(match[1])
         and type(ref['page']) is int and ref['page']==int(match[2]) and ref['pdfSha256']==pdf_sha256
         and ref['readerCaptionSha256']==sha(full_caption.encode()),'attested_source_figure_page_or_caption_sha_changed')
    for name in ['sourceDomSha256','originalCaptionSha256','readerCaptionSha256','originalSourceAssetSha256','rawArtifactsFileSha256',
                 'rawArtifactsPayloadSha256','rawFigureSha256','pdfSha256']:
        need(re.fullmatch(r'[a-f0-9]{64}',str(ref.get(name,''))),'attested_original_source_sha_missing')
    with fitz.open(stream=pdf_bytes,filetype='pdf')as document:
        need(not document.needs_pass and 1<=len(document)<=2048 and 1<=ref['page']<=len(document),
             'attested_original_page_outside_actual_pdf')
        page=document[ref['page']-1]
        labels=[]
        for block in page.get_text('dict',sort=False).get('blocks',[]):
            if block.get('type')!=0:continue
            for line in block.get('lines',[]):
                text=''.join(span.get('text','')for span in line.get('spans',[]))
                if caption_line_label(text)==('figure',figure_number):
                    labels.append({'rawText':text,'rawTextSha256':sha(text.encode()),'bbox':rect(line['bbox'])})
        need(len(labels)==1,'attested_page_printed_figure_label_not_unique')
        pixels,rendered=render_complete_pdf_page(page)
        status='unavailable' if re.fullmatch(r'(?:Figure|Fig\.?)\s+'+str(figure_number)+r'\s*[:.]?',clean_extractor_structure_text(full_caption),re.I) else 'partial'
        geometry={'profile':ATTESTED_PAGE_PROFILE,'evidenceContract':'conference-publication-attested-source-page-only-v1',
            'page':ref['page'],'mediaBox':rendered['mediaBox'],'cropBox':rendered['mediaBox'],'fullPage':True,
            'limitedSourcePageOnly':True,'completeCaptionVerified':False,'completeTargetCaption':None,
            'captionExtractionStatus':status,'printedFigureLabel':labels[0],'sourceRefAttestation':dict(ref),
            'pageContentModified':False,'geometricDefectClaimedFixed':False,
            'pageTextSha256':sha(page.get_text('text',flags=fitz.TEXTFLAGS_TEXT).encode())}
    proof={'contract':CONTRACT,'purpose':'publication-display-only','readerInputPixelsChanged':False,
        'originalPdfSha256':pdf_sha256,'figureNumber':figure_number,'originalReaderCaptionSha256':sha(full_caption.encode()),
        'geometry':geometry,'renderer':{'backend':'pymupdf','version':fitz.version[0],'dpi':rendered['dpi'],
            'implementationSha256':sha(Path(__file__).read_bytes()),
            'sharedPageGeometrySha256':sha(Path(__file__).with_name('reader_pdf_page_geometry.py').read_bytes())},
        **{key:rendered[key]for key in ['assetWidth','assetHeight','assetSha256','assetBytes']}}
    proof['proofSha256']=stable(proof)
    return pixels,proof


def _derive_supported_crop_pass(*, pdf_bytes, pdf_sha256, figure_number, full_caption, title, authors, attested_source_ref=None):
    """Fixed profiles only. Caller cannot supply a crop rectangle or bypass."""
    need(isinstance(pdf_bytes, bytes) and pdf_bytes.startswith(b'%PDF-')
         and len(pdf_bytes) <= MAX_PDF_BYTES and sha(pdf_bytes) == pdf_sha256, 'original_pdf_sha_changed')
    need(type(figure_number) is int and 1 <= figure_number <= 512, 'invalid_figure_number')
    failures = []
    with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
        need(not document.needs_pass and 1 <= len(document) <= 2048, 'unsupported_pdf_document')
        for selector in [select_geometry, header_band_geometry, ruled_table_then_figure_geometry, between_consecutive_figure_captions_geometry]:
            try:
                page, geometry = selector(document, figure_number=figure_number,
                    full_caption=full_caption, title=title, authors=authors) if selector is not select_geometry else \
                    selector(document, figure_number=figure_number, caption=full_caption, title=title, authors=authors)
                break
            except ValueError as error:
                failures.append({'profile': selector.__name__, 'reason': str(error)})
        else:
            # The fixed final fallback preserves the entire authenticated page,
            # not a guessed crop. Caller cannot select a rectangle or profile.
            try:
                pixels, proof = derive_authenticated_complete_page(pdf_bytes=pdf_bytes, pdf_sha256=pdf_sha256,
                    figure_number=figure_number, full_caption=full_caption, title=title, authors=authors)
                proof['geometry']['priorConservativeCropFailures'] = failures
                proof['proofSha256'] = stable({key: value for key, value in proof.items() if key != 'proofSha256'})
                return pixels, proof
            except ValueError as error:
                failures.append({'profile': 'complete_source_page_geometry', 'reason': str(error)})
                if attested_source_ref is not None:
                    try:
                        pixels,proof=derive_attested_source_page(pdf_bytes=pdf_bytes,pdf_sha256=pdf_sha256,
                            figure_number=figure_number,full_caption=full_caption,attested_source_ref=attested_source_ref)
                        proof['geometry']['priorConservativeCaptionFailures']=failures
                        proof['proofSha256']=stable({key:value for key,value in proof.items()if key!='proofSha256'})
                        return pixels,proof
                    except ValueError as limited_error:
                        failures.append({'profile':'attested_source_page_only','reason':str(limited_error)})
                raise ValueError('no_supported_complete_figure_geometry:' + json.dumps(failures, sort_keys=True))
        crop = geometry['cropBox']
        need((crop[2] - crop[0]) * DPI / 72 <= 4096 and (crop[3] - crop[1]) * DPI / 72 <= 4096
             and (crop[2] - crop[0]) * (crop[3] - crop[1]) * (DPI / 72) ** 2 <= MAX_PIXELS,
             'crop_pixel_budget_exceeded')
        pixels = page.get_pixmap(dpi=DPI, clip=fitz.Rect(crop), alpha=False).tobytes('png')
    need(pixels.startswith(b'\x89PNG\r\n\x1a\n') and len(pixels) <= MAX_OUTPUT_BYTES,
         'crop_png_budget_exceeded')
    width, height = struct.unpack('>II', pixels[16:24])
    proof = {'contract': CONTRACT, 'purpose': 'publication-display-only', 'readerInputPixelsChanged': False,
             'originalPdfSha256': pdf_sha256, 'figureNumber': figure_number,
             'originalReaderCaptionSha256': sha(full_caption.encode()), 'geometry': geometry,
             'renderer': {'backend': 'pymupdf', 'version': fitz.version[0], 'dpi': DPI,
                          'implementationSha256': sha(Path(__file__).read_bytes())},
             'assetSha256': sha(pixels), 'assetBytes': len(pixels), 'assetWidth': width, 'assetHeight': height}
    proof['proofSha256'] = stable(proof)
    return pixels, proof


def derive_supported_crop(*, pdf_bytes, pdf_sha256, figure_number, full_caption, title, authors, attested_source_ref=None):
    # Preserve the complete old extraction/render order. MuPDF text/image reads
    # can affect rendering state even with identical clip geometry. New line
    # scans therefore run only after all legacy profiles fail, in a fresh PDF.
    args=dict(pdf_bytes=pdf_bytes,pdf_sha256=pdf_sha256,figure_number=figure_number,
              full_caption=full_caption,title=title,authors=authors)
    try:
        return _derive_supported_crop_pass(**args)
    except ValueError:
        token=_ALLOW_SOURCE_LINE_CAPTIONS.set(True)
        try:
            return _derive_supported_crop_pass(**args,attested_source_ref=attested_source_ref)
        finally:
            _ALLOW_SOURCE_LINE_CAPTIONS.reset(token)


if __name__ == '__main__':
    # The normal publisher owns the authenticated source and fixed private FD.
    # This subprocess only returns deterministic pixels / geometry, never an
    # opaque source handle or standalone publication permission.
    import base64
    import os
    import stat
    import sys
    from runtime_guard import require_external_runtime
    require_external_runtime(Path(__file__).name, enforce_workspace_role=True)
    try:
        need(len(sys.argv) == 2 and sys.argv[1].isdigit() and int(sys.argv[1]) >= 3,
             'private_input_descriptor_required')
        descriptor = int(sys.argv[1]); info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) & 0o077 == 0
             and 2 <= info.st_size <= MAX_PDF_BYTES * 4 // 3 + 65536, 'private_input_file_invalid')
        with os.fdopen(os.dup(descriptor), 'rb') as stream:
            request = json.loads(stream.read(info.st_size + 1))
        need(set(request) in [{'pdfBase64', 'pdfSha256', 'figureNumber', 'fullCaption', 'title', 'authors'},
                              {'pdfBase64', 'pdfSha256', 'figureNumber', 'fullCaption', 'title', 'authors', 'attestedSourceRef'}],
             'unexpected_crop_request_fields')
        pdf = base64.b64decode(request['pdfBase64'], validate=True)
        try:
            pixels, proof = derive_supported_crop(pdf_bytes=pdf, pdf_sha256=request['pdfSha256'],
                figure_number=request['figureNumber'], full_caption=request['fullCaption'],
                title=request['title'], authors=request['authors'],attested_source_ref=request.get('attestedSourceRef'))
        except ValueError as error:
            if not str(error).startswith('no_supported_complete_figure_geometry:'):
                raise
            print(json.dumps({'eligible': False, 'reasonCode': 'unsupported_complete_figure_geometry',
                              'reason': str(error)}))
            raise SystemExit(0)
        body = dict(proof); del body['proofSha256']
        canonical_bytes = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
        print(json.dumps({'generatedBytesBase64': base64.b64encode(pixels).decode(),
                          'proofCanonicalBytesBase64': base64.b64encode(canonical_bytes).decode(),
                          'proof': proof}, ensure_ascii=False))
    except Exception as error:
        print(str(error)[:2000], file=sys.stderr); raise SystemExit(1)

"""Exact continuous PDF quotations, with a separate origin from HTML text."""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-sealed-pdf-quote-evidence')

import base64
import hashlib
import json
import os
import re
import stat
import sys
import fitz

CONTRACT = 'reader-sealed-pdf-quotes-v1'
PROJECTION = 'unicode-whitespace-collapse-and-trim-v1'
MAX_TEXT_CHARS = 4 * 1024 * 1024


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stable(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def normalize_quote(value):
    need(isinstance(value, str), 'quote_must_be_text')
    return re.sub(r'\s+', ' ', value).strip()


def _projection(raw):
    text, spans = [], []
    for token in re.finditer(r'\s+|\S', raw):
        if token.group().isspace():
            if not text:
                continue
            text.append(' ')
        else:
            text.append(token.group())
        spans.append((token.start(), token.end()))
    if text and text[-1] == ' ':
        text.pop()
        spans.pop()
    return ''.join(text), spans


def extract_pdf_quote_document(pdf_bytes):
    need(isinstance(pdf_bytes, bytes) and 5 <= len(pdf_bytes) <= 64 * 1024 * 1024
         and pdf_bytes.startswith(b'%PDF-'), 'pdf_bytes_invalid')
    try:
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')
    except fitz.FileDataError:
        return {'contract': CONTRACT, 'available': False, 'reason': 'pdf_document_unreadable',
                'pdfSha256': sha(pdf_bytes)}
    raw_parts, ranges, offset = [], [], 0
    try:
        for page in doc:
            text = page.get_text('text', sort=False, flags=fitz.TEXTFLAGS_TEXT)
            need(isinstance(text, str), 'pdf_page_text_invalid')
            need(offset + len(text) <= MAX_TEXT_CHARS, 'pdf_text_exceeds_limit')
            ranges.append({'page': page.number + 1, 'rawStartCodePoint': offset,
                           'rawEndCodePoint': offset + len(text), 'pageTextSha256': sha(text.encode())})
            raw_parts.append(text)
            offset += len(text)
            # An explicit page separator is whitespace, never a synthesized word.
            raw_parts.append('\n\f\n')
            offset += 3
    finally:
        doc.close()
    raw = ''.join(raw_parts)
    normalized = normalize_quote(raw)
    return {'contract': CONTRACT, 'available': bool(normalized), 'pdfSha256': sha(pdf_bytes),
            'rawFullText': raw, 'rawFullTextSha256': sha(raw.encode()),
            'normalizedFullText': normalized, 'normalizedFullTextSha256': sha(normalized.encode()),
            'pageRanges': ranges, 'extraction': {'backend': 'pymupdf', 'version': fitz.version[0],
            'method': 'get_text_text_page_order_sort_false', 'flags': fitz.TEXTFLAGS_TEXT,
            'projection': PROJECTION, 'offsetUnit': 'unicode_code_point'}}


def quote_evidence(document, requested_quote):
    need(document.get('contract') == CONTRACT and document.get('available') is True,
         'pdf_quote_document_unavailable')
    quote = normalize_quote(requested_quote)
    need(12 <= len(quote) <= 4000, 'pdf_quote_length_invalid')
    raw = document['rawFullText']
    need(sha(raw.encode()) == document['rawFullTextSha256'], 'pdf_raw_text_changed')
    projected, spans = _projection(raw)
    need(projected == document['normalizedFullText'] and sha(projected.encode())
         == document['normalizedFullTextSha256'], 'pdf_projection_changed')
    starts, offset = [], 0
    while True:
        start = projected.find(quote, offset)
        if start < 0:
            break
        starts.append(start)
        offset = start + 1
    need(len(starts) == 1, 'pdf_quote_not_unique:' + str(len(starts)))
    start, end = starts[0], starts[0] + len(quote)
    # A contiguous substring cannot silently drop a leading digit/sign or a
    # trailing precision digit/unit character from the original PDF token.
    def word_character(character):
        return bool(character) and (character.isalnum() or character == '_')
    previous = projected[start - 1] if start else ''
    following = projected[end] if end < len(projected) else ''
    leading, trailing = quote[0], quote[-1]
    need(not (word_character(previous) and word_character(leading)), 'pdf_quote_start_splits_token')
    need(not (word_character(trailing) and word_character(following)), 'pdf_quote_end_splits_token')
    need(not (leading.isdigit() and re.search(r'[+\-−＋－]\s*$', projected[:start])), 'pdf_quote_start_drops_numeric_sign')
    need(not (previous == '.' and leading.isdigit() and start >= 2 and projected[start - 2].isdigit()), 'pdf_quote_start_splits_decimal')
    need(not (leading == '.' and previous.isdigit()), 'pdf_quote_start_splits_decimal')
    need(not (trailing.isdigit() and following == '.' and end + 1 < len(projected) and projected[end + 1].isdigit()), 'pdf_quote_end_splits_decimal')
    need(not (trailing == '.' and following.isdigit()), 'pdf_quote_end_splits_decimal')
    need(not (previous == ',' and leading.isdigit() and start >= 2 and projected[start - 2].isdigit()), 'pdf_quote_start_splits_number')
    need(not (trailing.isdigit() and following == ',' and end + 1 < len(projected) and projected[end + 1].isdigit()), 'pdf_quote_end_splits_number')
    unit_suffix = re.match(r'^\s*(?:%|(?:dB|ms|kHz|MHz|Hz|GB|MB|KB|pp|s|h)(?![A-Za-z0-9_]))', projected[end:], re.I)
    need(not (trailing.isdigit() and unit_suffix), 'pdf_quote_end_drops_numeric_unit')
    need(not (word_character(leading) and re.search(r'\w[-‐‑]\s*$', projected[:start])), 'pdf_quote_start_splits_hyphenated_token')
    need(not (word_character(trailing) and re.match(r'^[-‐‑]\s*\w', projected[end:])), 'pdf_quote_end_splits_hyphenated_token')
    raw_start, raw_end = spans[start][0], spans[end - 1][1]
    fragment = raw[raw_start:raw_end]
    need(normalize_quote(fragment) == quote, 'pdf_quote_projection_not_continuous')
    pages = []
    for page in document['pageRanges']:
        lo, hi = max(raw_start, page['rawStartCodePoint']), min(raw_end, page['rawEndCodePoint'])
        if lo < hi:
            pages.append({**page, 'fragmentStartCodePoint': lo - page['rawStartCodePoint'],
                          'fragmentEndCodePoint': hi - page['rawStartCodePoint']})
    need(bool(pages), 'pdf_quote_page_missing')
    result = {'contract': CONTRACT, 'valueOrigin': 'sealed_pdf', 'pdfSha256': document['pdfSha256'],
              'rawFullTextSha256': document['rawFullTextSha256'],
              'normalizedFullTextSha256': document['normalizedFullTextSha256'],
              'extraction': document['extraction'], 'quote': quote, 'quoteSha256': sha(quote.encode()),
              'normalizedStartCodePoint': start, 'normalizedEndCodePoint': end,
              'rawStartCodePoint': raw_start, 'rawEndCodePoint': raw_end,
              'rawFragment': fragment, 'rawFragmentSha256': sha(fragment.encode()), 'pages': pages}
    result['evidenceSha256'] = stable(result)
    return result


SCIENTIFIC_CONTRACT = 'reader-sealed-pdf-scientific-quantities-v1'
SCIENTIFIC_OPERATION = 'scientific_glyph_atoms_v1'


def _scientific_glyph_atoms(pdf_bytes, document):
    """Read-only typography, separate from the legacy quotation protocol.

    Flat PDF text cannot distinguish a power from baseline subtraction. Only
    one horizontal source line with a smaller, raised exponent grants an atom.
    This never rewrites the source, its quote, or the original quote evidence.
    """
    coefficient = r'[+−-]?[0-9]+(?:\.[0-9]+)?'
    pattern = re.compile(r'(?<![\w.−+\-])(?P<coefficient>' + coefficient
                         + r')\s*×\s*10(?P<exponent>[+−-]?[0-9]+)')
    units = re.compile(r'^\s*(?P<unit>kHz|MHz|Hz|dB|GB|MB|KB|ms|pp|s|h|%)(?![A-Za-z0-9_/%])')
    boundary = re.compile(r'^(?:$|[,;:!?)]|\.(?![0-9])|\s+(?:$|[,;:!?)]|\.(?![0-9])|and\b|for\b|of\b|in\b|with\b|respectively\b))')
    output = []
    with fitz.open(stream=pdf_bytes, filetype='pdf') as doc:
        for page, page_range in zip(doc, document['pageRanges']):
            page_text = page.get_text('text', sort=False, flags=fitz.TEXTFLAGS_TEXT)
            need(sha(page_text.encode()) == page_range['pageTextSha256'], 'scientific_page_changed')
            cursor = 0
            for block in page.get_text('rawdict', sort=False, flags=fitz.TEXTFLAGS_TEXT)['blocks']:
                for line in block.get('lines', []):
                    chars = [{'c': char['c'], 'x': char['origin'][0], 'y': char['origin'][1],
                              'size': span['size'], 'bbox': list(char['bbox'])}
                             for span in line['spans'] for char in span['chars']]
                    text = ''.join(char['c'] for char in chars)
                    start = page_text.find(text, cursor) if text else -1
                    if start < 0:
                        continue
                    cursor = start + len(text)
                    # Any changed reading order or multi-codepoint glyph fails
                    # this optional capability, without changing old quotes.
                    if len(chars) != len(text) or tuple(line.get('dir', ())) != (1.0, 0.0):
                        continue
                    for match in pattern.finditer(text):
                        end = match.end()
                        tail = text[end:]
                        unit_match = units.match(tail)
                        unit = ''
                        if unit_match:
                            end += unit_match.end()
                            unit = unit_match['unit']
                        if not boundary.match(text[end:]):
                            continue
                        exponent_start, exponent_end = match.span('exponent')
                        core = [char for char in chars[match.start():exponent_start] if not char['c'].isspace()]
                        power = chars[exponent_start:exponent_end]
                        if not core or not power or ''.join(char['c'] for char in power) != match['exponent']:
                            continue
                        size = sum(char['size'] for char in core) / len(core)
                        baseline = sum(char['y'] for char in core) / len(core)
                        if not size > 0 or max(char['y'] for char in core) - min(char['y'] for char in core) > .12 * size:
                            continue
                        if any(not (.5 * size <= char['size'] <= .85 * size
                                    and .18 * size <= baseline - char['y'] <= .8 * size)
                               for char in power):
                            continue
                        if max(char['y'] for char in power) - min(char['y'] for char in power) > .1 * size:
                            continue
                        if not (-.15 * size <= power[0]['x'] - core[-1]['bbox'][2] <= .5 * size):
                            continue
                        if any(not (0 < right['x'] - left['x'] <= size)
                               for left, right in zip(power, power[1:])):
                            continue
                        # A printed unit is part of the same whole quantity;
                        # it must return to the source baseline, not be power text.
                        unit_chars = [char for char in chars[exponent_end:end] if not char['c'].isspace()]
                        if any(abs(char['y'] - baseline) > .12 * size
                               or not .85 * size <= char['size'] <= 1.15 * size for char in unit_chars):
                            continue
                        raw_start = page_range['rawStartCodePoint'] + start + match.start()
                        raw_end = page_range['rawStartCodePoint'] + start + end
                        glyphs = chars[match.start():end]
                        record = {'coefficient': match['coefficient'],
                                  'signedExponent': match['exponent'].replace('−', '-'), 'unit': unit,
                                  'text': normalize_quote(text[match.start():end]), 'page': page.number + 1,
                                  'lineRawStartCodePoint': page_range['rawStartCodePoint'] + start,
                                  'rawStartCodePoint': raw_start, 'rawEndCodePoint': raw_end,
                                  'glyphs': glyphs}
                        record['geometrySha256'] = stable(record)
                        output.append(record)
    return output


def extract_pdf_scientific_quantities(pdf_bytes, quotes):
    """Exact quote + source glyph API; JSON claims never substitute for PDF bytes."""
    need(isinstance(quotes, list) and len(quotes) <= 64
         and all(isinstance(quote, str) for quote in quotes), 'scientific_quotes_invalid')
    document = extract_pdf_quote_document(pdf_bytes)
    atoms = _scientific_glyph_atoms(pdf_bytes, document) if document.get('available') else []
    results = []
    for quote in quotes:
        try:
            evidence = quote_evidence(document, quote)
            projected, spans = _projection(evidence['rawFragment'])
            found = []
            for atom in atoms:
                if not (evidence['rawStartCodePoint'] <= atom['rawStartCodePoint']
                        and atom['rawEndCodePoint'] <= evidence['rawEndCodePoint']):
                    continue
                lo = atom['rawStartCodePoint'] - evidence['rawStartCodePoint']
                hi = atom['rawEndCodePoint'] - evidence['rawStartCodePoint']
                starts = [i for i, span in enumerate(spans) if span[0] == lo]
                ends = [i + 1 for i, span in enumerate(spans) if span[1] == hi]
                if len(starts) != 1 or len(ends) != 1 or projected[starts[0]:ends[0]] != atom['text']:
                    continue
                found.append({**atom, 'quoteStartCodePoint': starts[0], 'quoteEndCodePoint': ends[0],
                              'quoteSha256': evidence['quoteSha256'], 'pdfSha256': evidence['pdfSha256']})
            # First version is an executed, dimensionless three-stage AdamW
            # schedule. This is not a generic inline-number quotation lexer.
            atom_pattern = r'[+−-]?[0-9]+(?:\.[0-9]+)?×10[+−-][0-9]+'
            schedule = re.fullmatch(r'We use AdamW with learning rates of (?P<a>' + atom_pattern
                                    + r'), (?P<b>' + atom_pattern + r'), and (?P<c>' + atom_pattern
                                    + r') for SFT, RL-Stage I, and RL-Stage II, respectively\.', projected)
            before = document['rawFullText'][:evidence['rawStartCodePoint']]
            heading = before.rfind('Model Configuration')
            heading_pages = [page for page in document['pageRanges']
                             if page['rawStartCodePoint'] <= heading < page['rawEndCodePoint']]
            page_index = document['pageRanges'].index(heading_pages[0]) if len(heading_pages) == 1 else 0
            previous_start = document['pageRanges'][max(0,page_index-1)]['rawStartCodePoint']
            scope_start = heading_pages[0]['rawStartCodePoint'] if len(heading_pages) == 1 else 0
            previous_page = document['rawFullText'][previous_start:scope_start]
            scope_text = document['rawFullText'][scope_start:evidence['rawEndCodePoint'] + 900] if heading >= 0 else ''
            scope_text = re.split(r'\bEvaluation Metrics\b', scope_text, maxsplit=1)[0]
            scope_text = normalize_quote(scope_text)
            # A page break is not a reset of an immediately preceding foreign
            # title or a direct withdrawal of this schedule. This bounded
            # family does not replace the manuscript's full attribution audit.
            foreign_heading = re.compile(r'^\s*(?:(?:previous|prior|related|other|external) '
                                         r'(?:work|research|study|studies)|third[- ]party(?: study)?|'
                                         r'quotation|quoted(?: experiment)?|hypothetical(?: experiment)?)\.?\s*$', re.I | re.M)
            foreign_active = bool(foreign_heading.search(previous_page))
            first_line = next((line.strip() for line in document['rawFullText'].splitlines() if line.strip()), '')
            foreign_active = foreign_active or bool(foreign_heading.fullmatch(first_line))
            direct_withdrawal = re.compile(r'\b(?:This|That|These|We)\b[^.!?]{0,180}'
                                           r'\b(?:schedule|settings|learning rates|procedure)\b[^.!?]{0,180}\b(?:not|never|abandon(?:ed)?)\b'
                                           r'|\b(?:This|That|These|We)\b[^.!?]{0,180}\b(?:not|never|abandon(?:ed)?)\b'
                                           r'[^.!?]{0,180}\b(?:schedule|settings|learning rates|procedure)\b', re.I)
            foreign_active = foreign_active or bool(direct_withdrawal.search(normalize_quote(previous_page)))
            denied = re.compile(r'\b(?:(?:previous|prior|related|other|external) (?:work|research|studies)|'
                                r'third[- ]party|hypothetical|quoted|quotation|assuming|suppos(?:e|ed)|'
                                r'if|would|could|might|not|never|unimplemented|'
                                r'abandon(?:ed)?|withdrawn|retracted)\b|[“”‘’\'"`>]', re.I)
            own = heading >= 0 and len(before) - heading <= 1800 and re.search(r'\bOur backbone\b', scope_text)
            family = schedule and own and not foreign_active and not denied.search(scope_text)
            matched = []
            if family:
                for name, role in [('a','SFT'),('b','RL-Stage I'),('c','RL-Stage II')]:
                    candidates = [atom for atom in found if not atom['unit']
                                  and (atom['quoteStartCodePoint'], atom['quoteEndCodePoint']) == schedule.span(name)]
                    if len(candidates) != 1:
                        matched = []
                        break
                    matched.append({**candidates[0], 'role': role})
            if len(matched) != 3 or len({(atom['page'],atom['lineRawStartCodePoint']) for atom in matched}) != 1 \
                    or len(heading_pages) != 1 or matched[0]['page'] != heading_pages[0]['page']:
                matched = []
            results.append({'eligible': True, 'evidence': evidence, 'scientificQuantities': found})
            results[-1]['scientificQuantities'] = matched
            if matched:
                results[-1]['family'] = 'adamw-three-stage-learning-rates-v1'
        except ValueError as error:
            results.append({'eligible': False, 'reason': str(error)})
    return {'contract': SCIENTIFIC_CONTRACT, 'document': document, 'results': results}


def main():
    from runtime_guard import require_external_runtime, require_workspace_role
    require_external_runtime('reader-sealed-pdf-quote-evidence')
    require_workspace_role('daily')
    need(len(sys.argv) == 2 and sys.argv[1].isdigit() and int(sys.argv[1]) >= 3,
         'private_descriptor_required')
    fd = int(sys.argv[1])
    info = os.fstat(fd)
    need(stat.S_ISREG(info.st_mode) and info.st_mode & 0o077 == 0
         and 2 <= info.st_size <= 96 * 1024 * 1024, 'private_bounded_descriptor_required')
    data = json.loads(os.read(fd, info.st_size))
    scientific = data.get('operation') == SCIENTIFIC_OPERATION
    need(set(data) == ({'operation', 'pdfBase64', 'pdfSha256', 'quotes'} if scientific
                       else {'pdfBase64', 'pdfSha256', 'quotes'}) and isinstance(data['quotes'], list)
         and len(data['quotes']) <= 64, 'descriptor_fields_invalid')
    raw = base64.b64decode(data['pdfBase64'], validate=True)
    need(sha(raw) == data['pdfSha256'], 'pdf_sha_changed')
    if scientific:
        print(json.dumps(extract_pdf_scientific_quantities(raw, data['quotes']),
                         ensure_ascii=False, separators=(',', ':')))
        return
    document = extract_pdf_quote_document(raw)
    proofs = []
    for quote in data['quotes']:
        try:
            proofs.append({'eligible': True, 'evidence': quote_evidence(document, quote)})
        except ValueError as error:
            proofs.append({'eligible': False, 'reason': str(error)})
    print(json.dumps({'contract': CONTRACT, 'document': document, 'results': proofs},
                     ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()

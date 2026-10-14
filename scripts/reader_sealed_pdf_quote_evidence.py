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
    need(set(data) == {'pdfBase64', 'pdfSha256', 'quotes'} and isinstance(data['quotes'], list)
         and len(data['quotes']) <= 64, 'descriptor_fields_invalid')
    raw = base64.b64decode(data['pdfBase64'], validate=True)
    need(sha(raw) == data['pdfSha256'], 'pdf_sha_changed')
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

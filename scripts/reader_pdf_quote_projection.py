"""Encode source-derived PDF quotes without changing the extraction algorithm.

The original extractor stays byte-identical because literal-table evidence
binds its file SHA. Headers here describe only a representation of its result.
"""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-pdf-quote-projection')

import base64
import json
import os
import stat
import sys
import protocol_codec as codec
import reader_sealed_pdf_quote_evidence as original

QUOTE = 'reader-sealed-pdf-quotes'
PROJECTION = 'reader-pdf-quote-projection'
SCIENTIFIC = 'reader-sealed-pdf-scientific-quantities'
SCHEDULE = 'reader-pdf-adamw-schedule'
OPERATION = 'scientific-glyph-atoms'
VARIANTS = {QUOTE: 'unique-contiguous-official-pdf-fragment',
            PROJECTION: 'collapse-whitespace-only',
            SCIENTIFIC: 'font-and-position-authenticated-atoms',
            SCHEDULE: 'complete-three-stage-learning-rates'}


def current_header(family):
    return codec.record_header(codec.contract(family), family)


def saved_header(record, family):
    original.need(codec.has_valid_header(record, family), 'unknown_or_mixed_pdf_quote_header')
    header = codec.record_header(record['contract'], family, record.get('schemaFingerprint'))
    original.need(header in (current_header(family), codec.historical_header(family, VARIANTS[family])),
                  'pdf_quote_header_has_no_exact_encoder')
    return header


def _original_header(family):
    return codec.historical_header(family, VARIANTS[family])


def _quote_view(record, destination):
    source = saved_header(record, QUOTE)
    original.need(destination in (current_header(QUOTE), _original_header(QUOTE)), 'invalid_quote_encoder')
    body = {key: value for key, value in record.items() if key not in source}
    if 'extraction' in body:
        before = current_header(PROJECTION) if codec.is_current_header(source, QUOTE) \
            else _original_header(PROJECTION)['contract']
        after = current_header(PROJECTION) if codec.is_current_header(destination, QUOTE) \
            else _original_header(PROJECTION)['contract']
        original.need(body['extraction'].get('projection') == before, 'pdf_quote_projection_header_differs')
        body['extraction'] = {**body['extraction'], 'projection': after}
    sealed = 'evidenceSha256' in body
    if sealed:
        digest = body.pop('evidenceSha256')
        original.need(digest == original.stable({key: value for key, value in record.items()
            if key != 'evidenceSha256'}), 'pdf_quote_evidence_digest_differs')
    output = {**destination, **body}
    if sealed:
        output['evidenceSha256'] = original.stable(output)
    return output


def extract_pdf_quote_document(raw, header=None):
    return _quote_view(original.extract_pdf_quote_document(raw), current_header(QUOTE) if header is None else header)


def quote_evidence(document, text):
    header = saved_header(document, QUOTE)
    original_document = _quote_view(document, _original_header(QUOTE))
    return _quote_view(original.quote_evidence(original_document, text), header)


def extract_pdf_scientific_quantities(raw, quotes, header=None):
    header = current_header(QUOTE) if header is None else header
    result = original.extract_pdf_scientific_quantities(raw, quotes)
    original.need(saved_header(result, SCIENTIFIC) == _original_header(SCIENTIFIC),
                  'original_scientific_response_format_differs')
    if header == _original_header(QUOTE):
        return result
    original.need(header == current_header(QUOTE), 'invalid_scientific_quote_encoder')
    encoded = []
    for entry in result['results']:
        item = {**entry}
        if item.get('eligible'):
            item['evidence'] = _quote_view(item['evidence'], header)
        if 'family' in item:
            original.need(item['family'] == _original_header(SCHEDULE)['contract'], 'unknown_original_schedule')
            item['family'] = current_header(SCHEDULE)
        encoded.append(item)
    return {**current_header(SCIENTIFIC), 'document': _quote_view(result['document'], header), 'results': encoded}


def main():
    from runtime_guard import require_workspace_role
    require_workspace_role('daily')
    original.need(len(sys.argv) == 2 and sys.argv[1].isdigit() and int(sys.argv[1]) >= 3,
                  'private_descriptor_required')
    fd = int(sys.argv[1])
    info = os.fstat(fd)
    original.need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_mode & 0o777 == 0o600
                  and 2 <= info.st_size <= 96 * 1024 * 1024, 'private_bounded_descriptor_required')
    data = json.loads(os.read(fd, info.st_size))
    scientific = data.get('operation') == OPERATION
    original.need(set(data) == ({'operation', 'pdfBase64', 'pdfSha256', 'quotes'} if scientific
                               else {'pdfBase64', 'pdfSha256', 'quotes'}) and isinstance(data['quotes'], list)
                  and len(data['quotes']) <= 64, 'descriptor_fields_invalid')
    raw = base64.b64decode(data['pdfBase64'], validate=True)
    original.need(original.sha(raw) == data['pdfSha256'], 'pdf_sha_changed')
    if scientific:
        result = extract_pdf_scientific_quantities(raw, data['quotes'])
    else:
        document = extract_pdf_quote_document(raw)
        proofs = []
        for quote in data['quotes']:
            try:
                proofs.append({'eligible': True, 'evidence': quote_evidence(document, quote)})
            except ValueError as error:
                proofs.append({'eligible': False, 'reason': str(error)})
        result = {**current_header(QUOTE), 'document': document, 'results': proofs}
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()

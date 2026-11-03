"""Stable envelope around a freshly extracted, byte-identified column proof."""
import base64
import json
import os
from pathlib import Path
import stat
import sys

from protocol_codec import record_header
from reader_sealed_pdf_column_units import CONTRACT as DOM_CONTRACT, prove_pdf_bytes, sha, stable
from reader_sealed_pdf_literal_column_units import CONTRACT as LITERAL_CONTRACT, prove_pdf_bytes as prove_literal

FAMILY = 'reader-pdf-column-unit-projection'
PINNED_FILES = ('reader_sealed_pdf_column_units.py', 'reader_sealed_pdf_quote_evidence.py',
                'reader_sealed_pdf_literal_column_units.py', 'reader_authenticated_pdf_hierarchical_table.py')


def _implementation_files():
    directory = Path(__file__).resolve().parent
    return [{'file': name, 'sha256': sha((directory / name).read_bytes())} for name in PINNED_FILES]


def project_pdf_bytes(pdf_bytes, tables, view, quotes):
    before = _implementation_files()
    try:
        proof = prove_pdf_bytes(pdf_bytes, tables, view, quotes)
    except ValueError as dom_error:
        try:
            proof = prove_literal(pdf_bytes, view, quotes)
        except ValueError as literal_error:
            raise ValueError(f'{dom_error}; {literal_error}') from literal_error
    if _implementation_files() != before:
        raise RuntimeError('PDF column extractors changed during replay')
    kind = proof.get('contract')
    if kind not in {DOM_CONTRACT, LITERAL_CONTRACT} or proof.get('pdfSha256') != sha(pdf_bytes):
        raise RuntimeError('PDF column proof has a different origin')
    if kind == LITERAL_CONTRACT and proof.get('implementationFiles') != before:
        raise RuntimeError('Literal PDF proof differs from the actual extractor files')
    body = {key: value for key, value in proof.items() if key != 'evidenceSha256'}
    digest = stable(body)
    if proof.get('evidenceSha256') != digest:
        raise RuntimeError('Original PDF column proof digest differs')
    return {**record_header(FAMILY, FAMILY), 'originalEvidenceSha256': digest, 'originalProof': proof}


def main():
    from runtime_guard import require_external_runtime, require_workspace_role
    require_external_runtime(FAMILY)
    require_workspace_role('daily')
    if len(sys.argv) != 2 or not sys.argv[1].isdigit() or int(sys.argv[1]) < 3:
        raise ValueError('private_descriptor_required')
    fd = int(sys.argv[1])
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or before.st_mode & 0o077 or not 2 <= before.st_size <= 96 * 1024 * 1024:
        raise ValueError('private_bounded_descriptor_required')
    with os.fdopen(fd, 'rb', closefd=False) as stream:
        raw_packet = stream.read(before.st_size + 1)
    after = os.fstat(fd)
    if len(raw_packet) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) \
            != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('descriptor_bytes_changed')
    data = json.loads(raw_packet)
    if set(data) != {'pdfBase64', 'pdfSha256', 'tables', 'view', 'quotes'}:
        raise ValueError('descriptor_fields_invalid')
    raw_pdf = base64.b64decode(data['pdfBase64'], validate=True)
    if sha(raw_pdf) != data['pdfSha256']:
        raise ValueError('pdf_sha_changed')
    try:
        result = {**project_pdf_bytes(raw_pdf, data['tables'], data['view'], data['quotes']), 'eligible': True}
    except ValueError as error:
        result = {**record_header(FAMILY, FAMILY), 'eligible': False, 'reason': str(error)}
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()

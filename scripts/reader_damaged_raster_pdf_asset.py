"""Explicit single-target publication recovery of a structurally truncated PNG.

The sealed sources and historical Reader pixels are never rewritten. A fresh
protected response must match those pixels and reproduce the archived damage;
the replacement is a separately labelled full PDF page, never a Figure crop.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import zlib
from runtime_guard import require_external_runtime

if __name__ == '__main__':
    require_external_runtime('reader-damaged-raster-pdf-asset')
    raise SystemExit('This helper is called through the normal blog publisher.')

import fitz
from reader_pdf_page_asset import DPI, MAX_OUTPUT_BYTES, _caption_display_projection, norm, stable

CONTRACT = 'reader-damaged-raster-pdf-page-asset-v1'
MANIFEST_CONTRACT = 'daily-publication-damaged-raster-recovery-v1'


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def png_damage(raw):
    """Accept only a real complete PNG header followed by a truncated IDAT."""
    need(isinstance(raw, bytes) and 33 <= len(raw) <= MAX_OUTPUT_BYTES
         and raw.startswith(b'\x89PNG\r\n\x1a\n'), 'damaged_raster_png_signature_or_size')
    offset, chunks, header = 8, [], None
    while offset < len(raw):
        need(offset + 8 <= len(raw), 'damaged_raster_unrecognized_partial_header')
        size = struct.unpack('>I', raw[offset:offset + 4])[0]
        kind = raw[offset + 4:offset + 8]
        need(re.fullmatch(rb'[A-Za-z]{4}', kind), 'damaged_raster_bad_chunk_type')
        if offset + 12 + size > len(raw):
            need(header is not None and kind == b'IDAT' and not any(c['type'] == 'IEND' for c in chunks),
                 'damaged_raster_not_truncated_idat')
            return {'offset': offset, 'type': 'IDAT', 'declaredLength': size,
                    'availableDataAndCRC': len(raw) - offset - 8,
                    'reason': 'chunk extends beyond response bytes'}
        data = raw[offset + 8:offset + 8 + size]
        crc = struct.unpack('>I', raw[offset + 8 + size:offset + 12 + size])[0]
        need(zlib.crc32(kind + data) & 0xffffffff == crc, 'damaged_raster_bad_prior_crc')
        if header is None:
            need(kind == b'IHDR' and size == 13, 'damaged_raster_missing_ihdr')
            header = struct.unpack('>IIBBBBB', data)
            need(0 < header[0] <= 4096 and 0 < header[1] <= 4096
                 and header[0] * header[1] <= 16_000_000 and header[2:] == (8, 2, 0, 0, 0),
                 'damaged_raster_unsupported_ihdr')
        else:
            need(kind != b'IHDR', 'damaged_raster_duplicate_ihdr')
        need(kind != b'IEND', 'damaged_raster_complete_png_is_not_recovery')
        chunks.append({'type': kind.decode(), 'offset': offset, 'length': size})
        offset += size + 12
    raise ValueError('damaged_raster_no_truncated_idat')


def derive_page_asset(*, paper_id, figure, target, old_pixels, pdf_bytes, source_files,
                      recovery_manifest, damage_receipt):
    """All qualification is recomputed from actual bytes on every call."""
    require_external_runtime('reader-damaged-raster-pdf-page-asset')
    implementation_files = [Path(__file__), Path(__file__).with_name('reader_pdf_page_asset.py')]
    implementation_before = {str(file): sha(file.read_bytes()) for file in implementation_files}
    need(target['paperId'] == paper_id and target['figureOrdinal'] == figure['ordinal']
         and target['sourceUrl'] == figure['url']
         and target['sourceDomSha256'] == figure['sourceDomSha256']
         and target['originalReaderPixelSha256'] == figure['assetSha256'] == sha(old_pixels)
         and target['caption'] == figure['caption']
         and target['captionSha256'] == sha(figure['caption'].encode())
         and target['sourceFiles'] == source_files, 'damaged_raster_target_identity_changed')
    need(set(source_files) == {'source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'}
         and all(re.fullmatch(r'[a-f0-9]{64}', value) for value in source_files.values()),
         'damaged_raster_four_sources_missing')
    need(isinstance(pdf_bytes, bytes) and pdf_bytes.startswith(b'%PDF-')
         and len(pdf_bytes) <= 512 * 1024 * 1024 and sha(pdf_bytes) == source_files['source.pdf'],
         'damaged_raster_pdf_changed')
    damage = png_damage(old_pixels)
    receipt = damage_receipt['value']
    need(receipt.get('url') == figure['url'] and receipt.get('signatureValid') is True
         and receipt.get('normalStrictDecodePassed') is False
         and receipt.get('chunkParseError') == damage
         and any(response.get('status') == 200 and response.get('mediaType') == 'image/png'
                 and response.get('bytes') == len(old_pixels) and response.get('sha256') == sha(old_pixels)
                 for response in receipt.get('responses', [])), 'damaged_raster_receipt_does_not_replay')
    caption = norm(figure['caption'])
    displayed_caption, projection = _caption_display_projection(caption)
    numbered = re.match(r'^(?:Figure|Fig\.?)\s+(\d+)\s*[:.]\s*\S', caption, re.I)
    label = re.fullmatch(r'(?:Figure|Fig\.?)\s+(\d+)\s*[:.]?', norm(figure['label']), re.I)
    need(numbered is not None and label is not None and numbered[1] == label[1]
         and int(numbered[1]) == target['printedFigureNumber'], 'damaged_raster_printed_number_changed')
    with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
        need(not document.needs_pass and 1 <= len(document) <= 2048, 'damaged_raster_pdf_unsupported')
        matches, numbers = [], []
        for page in document:
            for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
                text = norm(block[4])
                if re.match(r'^(?:Figure|Fig\.?)\s+' + numbered[1] + r'(?!\d)\s*[:.]', text, re.I):
                    numbers.append(page.number + 1)
                if text == displayed_caption:
                    matches.append((page.number, block[4]))
        need(len(matches) == 1 and numbers == [matches[0][0] + 1], 'damaged_raster_caption_or_number_not_unique')
        index, raw_caption = matches[0]
        page = document[index]
        media = list(page.mediabox)
        need(page.rotation == 0 and list(page.cropbox) == media and list(page.rect) == media
             and media[:2] == [0, 0] and all(math.isfinite(x) for x in media)
             and 0 < media[2] * DPI / 72 <= 4096 and 0 < media[3] * DPI / 72 <= 4096
             and media[2] * media[3] * (DPI / 72) ** 2 <= 16_000_000, 'damaged_raster_media_box_unsupported')
        pixels = page.get_pixmap(dpi=DPI, alpha=False).tobytes('png')
        need(pixels.startswith(b'\x89PNG\r\n\x1a\n') and len(pixels) <= MAX_OUTPUT_BYTES,
             'damaged_raster_output_exceeds_limit')
        width, height = struct.unpack('>II', pixels[16:24])
        proof = {'contract': CONTRACT, 'paperId': paper_id, 'figureOrdinal': figure['ordinal'],
                 'figureNumber': int(numbered[1]), 'sourceUrl': figure['url'],
                 'sourceDomSha256': figure['sourceDomSha256'], 'originalReaderPixelSha256': sha(old_pixels),
                 'sourceFiles': dict(source_files), 'caption': caption, 'captionSha256': sha(caption.encode()),
                 'damage': damage, 'damageReceipt': {key: damage_receipt[key] for key in ('file', 'sha256')},
                 'recoveryManifest': dict(recovery_manifest),
                 'renderer': {'contract': 'pymupdf-full-media-box-png-v1', 'dpi': DPI,
                              'backend': 'pymupdf', 'version': fitz.version[0],
                              'helperSha256': sha(Path(__file__).read_bytes()),
                              'pageHelperSha256': sha(Path(__file__).with_name('reader_pdf_page_asset.py').read_bytes())},
                 'page': index + 1, 'mediaBox': media, 'rawCaptionSha256': sha(raw_caption.encode()),
                 'pageTextSha256': sha(page.get_text('text', flags=fitz.TEXTFLAGS_TEXT).encode()),
                 'assetSha256': sha(pixels), 'assetBytes': len(pixels), 'assetWidth': width, 'assetHeight': height,
                 'displayLabel': f'原论文 PDF 第 {index + 1} 页（含图 {int(numbered[1])}；原官方 PNG 文件截断，独立出版展示）'}
        if projection:
            proof['captionDisplayProjection'] = projection
    need(all(sha(Path(file).read_bytes()) == value for file, value in implementation_before.items()),
         'damaged_raster_implementation_changed_during_derivation')
    proof['proofSha256'] = stable(proof)
    return pixels, proof

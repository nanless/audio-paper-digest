"""Offline structural cases plus a complete, unchanged real paper PDF page.

The RGB PNG bytes are explicitly synthetic: the production damaged response
was deleted after diagnosis. The fixture records that observation without
pretending a constructed raster has its original physical SHA.
"""
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

import fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from reader_damaged_raster_pdf_asset import derive_page_asset, png_damage, MANIFEST_CONTRACT, stable
from test_publish_to_blog import publish_to_blog as publish


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def chunk(kind, value):
    return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff)


def synthetic_png(healthy=False, color=2):
    # Same complete IHDR+pHYs and offset-54 IDAT shape as the archived diagnosis;
    # dimensions, compressed data, lengths and SHA are intentionally synthetic.
    prefix = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, color, 0, 0, 0))
    prefix += chunk(b'pHYs', struct.pack('>IIB', 2835, 2835, 1))
    data = zlib.compress(b'\0' + b'\xff\0\0' * 2 + b'\0' + b'\0\xff\0' * 2)
    complete = prefix + chunk(b'IDAT', data) + chunk(b'IEND', b'')
    return complete if healthy else prefix + chunk(b'IDAT', data)[:-6]


class DamagedRasterPdfAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = Path(__file__).resolve().parents[1] / 'fixtures/damaged-raster-23175-page9'
        cls.meta = json.loads(base.with_suffix('.json').read_text())
        compressed = base.with_suffix('.pdf.gz').read_bytes()
        assert sha(compressed) == cls.meta['fixtureGzipSha256']
        cls.pdf = gzip.decompress(compressed)
        assert sha(cls.pdf) == cls.meta['fixturePdfSha256']

    def setUp(self):
        self.old = synthetic_png()
        self.figure = {**self.meta['figure'], 'assetSha256': sha(self.old)}
        self.sources = {**self.meta['originalSourceFiles'], 'source.pdf': sha(self.pdf)}
        self.target = {'paperId': '2610.23175', 'figureOrdinal': 2, 'printedFigureNumber': 3,
                       'sourceUrl': self.figure['url'], 'sourceDomSha256': self.figure['sourceDomSha256'],
                       'originalReaderPixelSha256': sha(self.old), 'caption': self.figure['caption'],
                       'captionSha256': sha(self.figure['caption'].encode()), 'sourceFiles': self.sources}
        self.receipt = {'file': '/private/synthetic-test-receipt.json', 'sha256': 'a' * 64,
                        'value': {'url': self.figure['url'], 'signatureValid': True,
                                  'normalStrictDecodePassed': False, 'chunkParseError': png_damage(self.old),
                                  'responses': [{'status': 200, 'mediaType': 'image/png',
                                                 'bytes': len(self.old), 'sha256': sha(self.old)}]}}
        self.manifest = {'file': '/private/synthetic-test-manifest.json', 'sha256': 'b' * 64}

    def derive(self, **changes):
        args = dict(paper_id='2610.23175', figure=self.figure, target=self.target, old_pixels=self.old,
                    pdf_bytes=self.pdf, source_files=self.sources, recovery_manifest=self.manifest,
                    damage_receipt=self.receipt)
        args.update(changes)
        return derive_page_asset(**args)

    def test_real_complete_page_full_caption_and_geometry_no_mutation(self):
        before = copy.deepcopy((self.figure, self.target, self.receipt, self.sources))
        png, proof = self.derive()
        self.assertEqual(struct.unpack('>II', png[16:24]), (1224, 1584))
        self.assertEqual(proof['page'], 1)  # Original sealed page 9, extracted intact.
        self.assertEqual(self.meta['originalPage'], 9)
        self.assertEqual(proof['figureNumber'], 3)
        self.assertEqual(proof['figureOrdinal'], 2)
        self.assertEqual(proof['mediaBox'], [0, 0, 612, 792])
        self.assertEqual(proof['assetSha256'], sha(png))
        self.assertNotEqual(proof['assetSha256'], sha(self.old))
        self.assertIn('原官方 PNG 文件截断，独立出版展示', proof['displayLabel'])
        self.assertEqual(proof['caption'], self.figure['caption'])
        self.assertEqual(proof['proofSha256'], stable({k: v for k, v in proof.items() if k != 'proofSha256'}))
        self.assertEqual((self.figure, self.target, self.receipt, self.sources), before)

    def test_only_crc_checked_rgb8_idat_truncation_is_eligible(self):
        damage = png_damage(self.old)
        self.assertEqual((damage['offset'], damage['type']), (54, 'IDAT'))
        cases = [synthetic_png(True), b'HTTP 503 Service Unavailable', self.old[:20], self.old[:58],
                 synthetic_png(color=6), self.old[:29] + bytes([self.old[29] ^ 1]) + self.old[30:],
                 self.old[:54] + struct.pack('>I', 1000) + b'tEXt' + b'incomplete']
        for raw in cases:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                png_damage(raw)

    def test_identity_and_each_sealed_source_sha_are_bound(self):
        for changes in [{'paper_id': '2610.23176'}, {'old_pixels': self.old + b'changed'},
                        {'figure': {**self.figure, 'url': self.figure['url'] + '?wrong'}},
                        {'figure': {**self.figure, 'sourceDomSha256': 'f' * 64}},
                        {'target': {**self.target, 'printedFigureNumber': 2}},
                        {'pdf_bytes': self.pdf + b'changed'}]:
            with self.subTest(changes=list(changes)), self.assertRaises(ValueError):
                self.derive(**changes)
        for name in self.sources:
            changed = {**self.sources, name: 'f' * 64}
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.derive(source_files=changed)

    def test_receipt_http_status_decode_and_original_pixel_identity_are_required(self):
        mutations = [{'url': 'https://example.invalid/other.png'}, {'signatureValid': False},
                     {'normalStrictDecodePassed': True}, {'chunkParseError': {}},
                     {'responses': []}]
        for field, value in [('status', 503), ('mediaType', 'text/html'), ('bytes', 0), ('sha256', 'f' * 64)]:
            mutations.append({'responses': [{**self.receipt['value']['responses'][0], field: value}]})
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.derive(damage_receipt={**self.receipt, 'value': {**self.receipt['value'], **mutation}})

    def test_healthy_png_cannot_be_claimed_as_damaged_even_with_matching_json(self):
        healthy = synthetic_png(True)
        figure = {**self.figure, 'assetSha256': sha(healthy)}
        target = {**self.target, 'originalReaderPixelSha256': sha(healthy)}
        with self.assertRaisesRegex(ValueError, 'complete_png'):
            self.derive(old_pixels=healthy, figure=figure, target=target)

    def altered_pdf(self, *, duplicate=False, same_number=False, rotate=False, crop=False):
        with fitz.open(stream=self.pdf, filetype='pdf') as doc:
            if duplicate:
                doc.insert_pdf(fitz.open(stream=self.pdf, filetype='pdf'))
            if same_number:
                doc.new_page(width=612, height=792).insert_text((72, 72), 'Figure 3: Another source caption.')
            if rotate:
                doc[0].set_rotation(90)
            if crop:
                doc[0].set_cropbox(fitz.Rect(0, 0, 612, 700))
            return doc.tobytes()

    def test_complete_caption_and_unique_printed_number_not_substring_matching(self):
        for caption in [self.figure['caption'] + ' Extra.', self.figure['caption'][:-8],
                        self.figure['caption'].replace('Phoneme Embedding', 'Different Embedding', 1)]:
            figure = {**self.figure, 'caption': caption}
            target = {**self.target, 'caption': caption, 'captionSha256': sha(caption.encode())}
            with self.subTest(caption=caption), self.assertRaisesRegex(ValueError, 'not_unique'):
                self.derive(figure=figure, target=target)
        for raw in [self.altered_pdf(duplicate=True), self.altered_pdf(same_number=True)]:
            sources = {**self.sources, 'source.pdf': sha(raw)}
            with self.assertRaisesRegex(ValueError, 'not_unique'):
                self.derive(pdf_bytes=raw, source_files=sources, target={**self.target, 'sourceFiles': sources})

    def test_rotation_and_crop_cannot_become_a_silent_figure_crop(self):
        for raw in [self.altered_pdf(rotate=True), self.altered_pdf(crop=True)]:
            sources = {**self.sources, 'source.pdf': sha(raw)}
            with self.assertRaisesRegex(ValueError, 'media_box'):
                self.derive(pdf_bytes=raw, source_files=sources, target={**self.target, 'sourceFiles': sources})

    def manifest_input(self, root):
        runtime = root / 'runtime'
        runtime.mkdir()
        receipt = runtime / 'receipt.json'
        receipt.write_text(json.dumps(self.receipt['value']))
        receipt.chmod(0o600)
        target = {**self.target, 'readerArticleSha256': '1' * 64, 'readerPlanSha256': '2' * 64,
                  'readerFiguresSha256': '3' * 64, 'damageReceipt': {'file': str(receipt), 'sha256': sha(receipt.read_bytes())}}
        value = {'contract': MANIFEST_CONTRACT, 'runId': '3cddbc12-19ba-427e-8418-9721390ab5b8',
                 'batchDate': '2026-10-20', 'authorization': 'Explicit test single-target recovery', 'targets': [target]}
        file = runtime / 'recovery.json'
        file.write_text(json.dumps(value))
        file.chmod(0o600)
        return file, receipt, value

    def test_actual_manifest_and_receipt_files_paths_permissions_sha_and_cas(self):
        with tempfile.TemporaryDirectory(prefix='pd-raster-input-test-') as tmp:
            root = Path(tmp).resolve()
            file, receipt, value = self.manifest_input(root)
            paper = {'arxivId': '2610.23175v1', 'freshRewriteProvenance': {'runId': value['runId'], 'batchDate': value['batchDate']},
                     'apiReaderArticleSha256': '1' * 64, 'apiReaderPlanSha256': '2' * 64,
                     'analysisManifest': {'stages': {'apiReaderArticle': {'figuresSha256': '3' * 64}}},
                     'apiReaderFigures': [self.figure]}
            with patch.object(publish, 'CURRENT_DIR', root / 'current'), patch.dict(os.environ, {'PD_PUBLISH_RASTER_RECOVERY_FILE': str(file)}):
                parsed = publish._publication_raster_recovery_target(paper, self.figure)
                self.assertEqual(parsed['receipt']['sha256'], sha(receipt.read_bytes()))
                wrong = {**paper, 'apiReaderArticleSha256': 'f' * 64}
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._publication_raster_recovery_target(wrong, self.figure)
                receipt.write_text('{}')
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._publication_raster_recovery_input()
                receipt.write_text(json.dumps(self.receipt['value']))
                receipt.chmod(0o644)
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._publication_raster_recovery_input()
                receipt.chmod(0o600)
                symlink = receipt.parent / 'receipt-link.json'
                symlink.symlink_to(receipt)
                value['targets'][0]['damageReceipt']['file'] = str(symlink)
                file.write_text(json.dumps(value))
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._publication_raster_recovery_input()
                alias = root / 'outside.json'
                alias.write_text(receipt.read_text()); alias.chmod(0o600)
                value['targets'][0]['damageReceipt']['file'] = str(alias)
                value['targets'][0]['damageReceipt']['sha256'] = sha(alias.read_bytes())
                file.write_text(json.dumps(value))
                with self.assertRaises(publish.PublishDataValidationError):
                    publish._publication_raster_recovery_input()
                with patch.dict(os.environ, {'PD_PUBLISH_RASTER_RECOVERY_FILE': 'relative.json'}), self.assertRaises(publish.PublishDataValidationError):
                    publish._publication_raster_recovery_input()

    def test_network_failure_never_reaches_pdf_fallback_or_creates_a_pass(self):
        # Bundle authentication is separately tested by the daily source suite;
        # this isolated publisher unit asserts the actual failure propagation.
        with tempfile.TemporaryDirectory(prefix='pd-raster-network-test-') as tmp:
            root = Path(tmp).resolve()
            directory = root / 'run' / 'sources/2610.23175/generation-000001'
            directory.mkdir(parents=True)
            run_file = root / 'run/run.json'
            run_file.write_text(json.dumps({'batchDate': '2026-10-20'})); run_file.chmod(0o600)
            artifact = {**self.meta['figure'], 'recoveryStatus': 'complete', 'images': [{'alt': 'test',
                        'kind': 'external_url', 'mediaType': 'image/png', 'rasterDownloadEligible': True,
                        'url': self.figure['url']}]}
            files = {'source.txt': b'explicit isolated publisher unit', 'source.pdf': self.pdf,
                     'source-runtime.json': json.dumps({'structuredArtifacts': {'figures': [artifact]}}).encode(),
                     'source-manifest.json': b'{}'}
            for name, raw in files.items():
                (directory / name).write_bytes(raw); (directory / name).chmod(0o600)
            paper = {'arxivId': '2610.23175v1', 'freshRewriteProvenance': {'runId': 'run'}}
            recovery = {'sha256': '9' * 64, 'value': {'targets': [self.target], 'batchDate': '2026-10-20'}, 'receipt': self.receipt}
            publish._RASTER_RECOVERY_SOURCE_BYTES.clear()
            fault = OSError('original real transport failure represented by test')
            with patch.object(publish, 'DAILY_FRESH_SOURCE_RUNS_DIR', root), \
                    patch.object(publish, '_daily_fresh_validate_bundle') as bundle, \
                    patch.object(publish, '_download_review_image', side_effect=fault), \
                    patch('reader_damaged_raster_pdf_asset.derive_page_asset') as derive:
                with self.assertRaises(OSError) as caught:
                    publish._reader_damaged_raster_pdf_page_asset(paper, self.figure, recovery)
                self.assertIs(caught.exception, fault)
                bundle.assert_called_once()
                derive.assert_not_called()

            # A correctly bound isolated input must still fail after a real
            # source file changes while the page is being derived. This does
            # not mock such a file into a certified daily source capability.
            import reader_damaged_raster_pdf_asset as raster
            actual_derive = raster.derive_page_asset
            recovery.update(file='/private/isolated-test-manifest.json')
            target = {**self.target, 'sourceFiles': {name: sha(raw) for name, raw in files.items()}}
            recovery['value']['targets'] = [target]

            def derive_then_drift(**kwargs):
                result = actual_derive(**kwargs)
                (directory / 'source.txt').write_bytes(b'changed during derive')
                return result

            publish._RASTER_RECOVERY_SOURCE_BYTES.clear()
            with patch.object(publish, 'DAILY_FRESH_SOURCE_RUNS_DIR', root), \
                    patch.object(publish, '_daily_fresh_validate_bundle'), \
                    patch.object(publish, '_download_review_image', return_value={'raw': self.old}), \
                    patch.object(publish, '_publication_raster_recovery_input', return_value=recovery), \
                    patch('reader_damaged_raster_pdf_asset.derive_page_asset', side_effect=derive_then_drift):
                with self.assertRaisesRegex(publish.PublishDataValidationError, '原四源字节发生变化'):
                    publish._reader_damaged_raster_pdf_page_asset(paper, self.figure, recovery)

    def test_generation_review_push_cannot_drop_explicit_input_or_downgrade_to_legacy(self):
        recovery = {'file': '/private/explicit-raster.json', 'sha256': '8' * 64}
        manifest = {'rasterRecoveryInput': recovery, 'derivedFigureAssets': [],
                    'derivedFigureAssetsFingerprint': publish._stable_json_sha256([]), 'files': []}
        with patch.object(publish, '_publication_raster_recovery_input', return_value=None):
            with self.assertRaises(publish.PublishDataValidationError):
                publish._validate_derived_figure_asset_manifest(manifest, [])
            with self.assertRaises(publish.PublishDataValidationError):
                publish._legacy_reader_pixel_assets({'rasterRecoveryInput': recovery, 'files': []}, [])
        with patch.object(publish, '_publication_raster_recovery_input', return_value=recovery):
            without_input = {k: v for k, v in manifest.items() if k != 'rasterRecoveryInput'}
            with self.assertRaises(publish.PublishDataValidationError):
                publish._validate_derived_figure_asset_manifest(without_input, [])
            with self.assertRaises(publish.PublishDataValidationError):
                publish._legacy_reader_pixel_assets({'files': []}, [])


if __name__ == '__main__':
    unittest.main()

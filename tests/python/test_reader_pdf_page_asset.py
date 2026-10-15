import copy
import hashlib
import struct
import sys
import unittest
from pathlib import Path
import tempfile
import json
from unittest.mock import patch

import fitz
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from reader_inline_svg import source_descriptor
from reader_pdf_page_asset import derive_page_asset, dependency_failure, stable, _CACHE
from test_publish_to_blog import publish_to_blog as publish


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def svg(body='<use href="#missing"/>'):
    raw = ('<svg xmlns="http://www.w3.org/2000/svg" id="S1.F9.pic1" '
           'viewBox="0 0 100 100" width="100" height="100">' + body + '</svg>').encode()
    return {'kind': 'inline_svg', 'mediaType': 'image/svg+xml', 'inlineSvg': raw.decode(),
            'inlineSvgBytes': len(raw), 'inlineSvgSha256': sha(raw)}


def pdf(captions=None, crop=False, rotation=0):
    with fitz.open() as doc:
        page = doc.new_page(width=612, height=792)
        for index, caption in enumerate(captions or ['Figure 9: Complete capability filtering diagram.']):
            page.insert_text((72, 100 + 60 * index), caption)
        if crop:
            page.set_cropbox(fitz.Rect(0, 0, 612, 700))
        page.set_rotation(rotation)
        return doc.tobytes()


class PdfPageAssetTests(unittest.TestCase):
    def setUp(self):
        _CACHE.clear()
        self.resource = svg()
        self.old = b'\x89PNG\r\n\x1a\nold-verified-model-pixels'
        self.figure = {**source_descriptor(self.resource, '2610.90001'), 'ordinal': 9,
                       'label': 'Figure 9:', 'caption': 'Figure 9: Complete capability filtering diagram.',
                       'sourceDomSha256': 'a' * 64, 'assetSha256': sha(self.old)}

    def derive(self, raw=None, figure=None, resource=None, old=None, sources=None):
        raw = raw if raw is not None else pdf()
        sources = sources or {name: sha(raw) if name == 'source.pdf' else 'b' * 64 for name in (
            'source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json')}
        return derive_page_asset(paper_id='2610.90001', figure=figure or self.figure,
            resource=resource or self.resource, old_pixels=old or self.old,
            pdf_bytes=raw, source_files=sources)

    def test_full_page_and_independent_prior_pixel_proof_without_mutation(self):
        original = copy.deepcopy(self.figure)
        raw, proof = self.derive()
        self.assertEqual(struct.unpack('>II', raw[16:24]), (1224, 1584))
        self.assertEqual(proof['mediaBox'], [0, 0, 612, 792])
        self.assertEqual(proof['page'], 1)
        self.assertEqual(proof['displayLabel'], '原论文 PDF 第 1 页（含图 9）')
        self.assertEqual(proof['assetSha256'], sha(raw))
        self.assertEqual(proof['originalReaderPixelSha256'], sha(self.old))
        self.assertNotEqual(proof['assetSha256'], proof['originalReaderPixelSha256'])
        self.assertEqual(proof['proofSha256'], stable({k: v for k, v in proof.items() if k != 'proofSha256'}))
        self.assertEqual(self.figure, original)
        proof['mediaBox'][2] = 1
        self.assertEqual(self.derive()[1]['mediaBox'], [0, 0, 612, 792])

    def test_missing_and_cyclic_render_dependencies_but_not_navigation(self):
        self.assertEqual(dependency_failure(self.resource['inlineSvg'].encode())['targets'], ['missing'])
        cyclic = svg('<defs><pattern id="p" href="#p"/></defs><path fill="url(#p)"/>')
        self.assertEqual(dependency_failure(cyclic['inlineSvg'].encode())['reason'], 'cyclic_local_fragment_dependencies')
        for body in ['<a href="#otherFigure"><text>Figure 1</text></a>',
                     '<defs><symbol id="p"><path d="M0 0 L1 1"/></symbol></defs><use href="#p"/>']:
            self.assertIsNone(dependency_failure(svg(body)['inlineSvg'].encode()))
        good = svg('<text>Fully self-contained</text>')
        self.assertIsNone(self.derive(resource=good))

    def test_unsafe_external_duplicate_ids_and_active_svg_are_not_fallbacks(self):
        for body in ['<use href="https://example.invalid/a.svg#x"/>',
                     '<g id="p"/><g id="p"/>', '<script>bad()</script>',
                     '<path fill="url(https://example.invalid/a.svg)"/>']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                dependency_failure(svg(body)['inlineSvg'].encode())

    def test_unique_complete_caption_and_number_are_required(self):
        cases = [pdf(['Figure 9: A different diagram.']),
                 pdf([self.figure['caption'], self.figure['caption']]),
                 pdf([self.figure['caption'], 'Figure 9: Another caption.']),
                 pdf(['Figure 19: Complete capability filtering diagram.']),
                 pdf(['Figure 9: Complete capability filtering'])]
        for raw in cases:
            with self.subTest(sha=sha(raw)), self.assertRaisesRegex(ValueError, 'not_unique'):
                self.derive(raw)
        bad = {**self.figure, 'label': 'Figure 8:'}
        with self.assertRaisesRegex(ValueError, 'number_or_caption'):
            self.derive(figure=bad)

    def test_pdf_sha_old_pixel_and_original_svg_identity_cannot_change(self):
        for changes in [{'old': b'\x89PNG\r\n\x1a\nchanged'},
                        {'figure': {**self.figure, 'url': 'https://arxiv.org/html/2610.90002#S1.F9.pic1'}},
                        {'sources': {name: 'c' * 64 for name in ('source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json')}},
                        {'sources': {'source.pdf': 'c' * 64}}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.derive(**changes)
        changed = copy.deepcopy(self.resource)
        changed['inlineSvg'] += ' '
        with self.assertRaises(ValueError):
            self.derive(resource=changed)

    def test_full_original_media_box_only_never_cropped_or_rotated(self):
        for raw in [pdf(crop=True), pdf(rotation=90)]:
            with self.assertRaisesRegex(ValueError, 'full_media_box'):
                self.derive(raw)

    def test_manifest_derivation_rejects_any_proof_or_output_mismatch(self):
        _raw, proof = self.derive()
        path = f"static/images/papers/2610.90001/figure-9-{proof['assetSha256'][:16]}.png"
        manifest = {'derivedFigureAssets': [proof], 'derivedFigureAssetsFingerprint': publish._stable_json_sha256([proof]),
                    'files': [{'path': path, 'deleted': False, 'sha256': proof['assetSha256']}]}
        publish._validate_derived_figure_asset_manifest(manifest, [proof])
        for field, value in [('page', 2), ('mediaBox', [0, 0, 600, 700]),
                             ('originalReaderPixelSha256', 'c' * 64), ('assetSha256', 'c' * 64),
                             ('sourceFiles', {}), ('renderer', {})]:
            broken = copy.deepcopy(manifest)
            broken['derivedFigureAssets'][0][field] = value
            broken['derivedFigureAssetsFingerprint'] = publish._stable_json_sha256(broken['derivedFigureAssets'])
            with self.subTest(field=field), self.assertRaises(publish.PublishDataValidationError):
                publish._validate_derived_figure_asset_manifest(broken, [proof])
        for change in [{}, {'deleted': True}, {'sha256': 'c' * 64}]:
            broken = copy.deepcopy(manifest)
            broken['files'] = [] if not change else [{**broken['files'][0], **change}]
            with self.assertRaises(publish.PublishDataValidationError):
                publish._validate_derived_figure_asset_manifest(broken, [proof])
        with self.assertRaises(publish.PublishDataValidationError):
            publish._validate_derived_figure_asset_manifest({'files': manifest['files']}, [proof])
        publish._validate_derived_figure_asset_manifest({'files': []}, [])

    def test_normal_manifest_owns_only_the_replaced_old_asset(self):
        with tempfile.TemporaryDirectory(prefix='pd-page-owned-assets-') as temporary:
            root = Path(temporary)
            blog, current, stage = root / 'blog', root / 'current', root / 'stage'
            target, posts = blog / 'content/posts', stage / 'posts'
            target.mkdir(parents=True)
            posts.mkdir(parents=True)
            current.mkdir()
            old_relative = 'static/images/papers/2610.90001/figure-9-' + 'a' * 16 + '.png'
            new_relative = old_relative.replace('a' * 16, 'b' * 16)
            unowned = blog / old_relative.replace('a' * 16, 'c' * 16)
            old, new = blog / old_relative, stage / new_relative
            old.parent.mkdir(parents=True)
            new.parent.mkdir(parents=True)
            old.write_bytes(b'original pixel snapshot')
            new.write_bytes(b'recovered page')
            unowned.write_bytes(b'user owned unrelated image')
            (posts / '2026-10-15-paper.md').write_text('private test page')
            (current / 'blog-generation-manifest-2026-10-15.json').write_text(json.dumps({
                'schemaVersion': 3, 'date': '2026-10-15', 'files': [
                    {'path': old_relative, 'sha256': sha(old.read_bytes()), 'deleted': False}]}))
            with patch.object(publish, 'BLOG_REPO', str(blog)), patch.object(publish, 'CURRENT_DIR', current), \
                    patch.object(publish, '_git_tracked_reader_asset_paths', return_value=set()):
                paths = publish.publish_manifest_paths(posts, target, '2026-10-15', [new])
                journal = {'installation': None}
                # Git cleanliness has its own coverage. This test exercises the
                # real owned-asset/before-byte journal and installation paths.
                with patch.object(publish, 'validate_manifest_clean_against_head') as clean:
                    records = publish.prepare_generation_installation(journal, root / 'journal.json',
                        posts, target, '2026-10-15', [new])
                    self.assertEqual(clean.call_args.kwargs['allow_exact_pipeline_untracked'][old_relative]['sha256'],
                                     sha(b'original pixel snapshot'))
                old_record = next(record for record in records if record['path'] == old_relative)
                self.assertIs(old_record['delete'], True)
                self.assertEqual(old_record['before']['sha256'], sha(b'original pixel snapshot'))
                publish.resume_generation_installation(journal, root / 'journal.json', posts)
            self.assertIn(old.resolve(), paths)
            self.assertIn((blog / new_relative).resolve(), paths)
            self.assertNotIn(unowned.resolve(), paths)
            self.assertFalse(old.exists())
            self.assertEqual((blog / new_relative).read_bytes(), b'recovered page')
            self.assertEqual(unowned.read_bytes(), b'user owned unrelated image')

    def test_legacy_manifest_keeps_old_pixels_but_cannot_disguise_new_assets(self):
        paper = {'arxivId': '2610.90001v1', 'apiReaderFigures': [self.figure]}
        prefix = 'static/images/papers/2610.90001/figure-9-'
        record = {'path': prefix + self.figure['assetSha256'][:16] + '.png',
                  'deleted': False, 'sha256': self.figure['assetSha256']}
        old = {'files': [record]}
        publish._legacy_reader_pixel_assets(old, [paper])
        for broken in [{'files': []}, {'files': [{**record, 'sha256': 'c' * 64}]},
                       {'files': [{**record, 'path': prefix + 'c' * 16 + '.png'}]},
                       {'files': [record, {**record, 'path': prefix + 'c' * 16 + '.png'}]},
                       {**old, 'derivedFigureAssetsFingerprint': 'c' * 64},
                       {**old, 'derivedFigureAssets': []}]:
            with self.subTest(broken=broken), self.assertRaises(publish.PublishDataValidationError):
                publish._legacy_reader_pixel_assets(broken, [paper])


if __name__ == '__main__':
    unittest.main()

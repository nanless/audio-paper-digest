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


def dark_badge(color='#2e2f31', text_style='--ltx-fg-color:#FFF;', wrapper='matrix(1.0 0.0 0.0 1.0 4 2)'):
    # A generic round rectangle (0,0)..(40,20), not the real paper dimensions.
    return (f'<g fill="{color}"><path style="stroke:none" '
            'd="M 36 20 L 4 20 C 2 20 0 18 0 16 L 0 4 C 0 2 2 0 4 0 '
            'L 36 0 C 38 0 40 2 40 4 L 40 16 C 40 18 38 20 36 20 Z M 0 0"/></g>'
            f'<g transform="{wrapper}"><foreignObject width="25" height="10" '
            'transform="matrix(1 0 0 -1 0 10)"><span><span '
            f'style="{text_style}">X · Y</span></span></foreignObject></g>')


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

    def test_white_css_loss_requires_opaque_dark_round_rectangle_and_full_inside_box(self):
        failure = dependency_failure(svg(dark_badge())['inlineSvg'].encode())
        self.assertEqual(failure['reason'], 'unmapped_latexml_white_text_on_dark_badge')
        self.assertEqual(len(failure['witnesses']), 1)
        self.assertEqual(failure['witnesses'][0]['effectiveForeground'], '#000000')
        self.assertEqual(failure['witnesses'][0]['foreignObjectBox'], [4, 2, 29, 12])
        # These are actual readable bar colours in the other saved figure.
        for background in ['#4a8cdc', '#ee7e52', '#fff']:
            self.assertIsNone(dependency_failure(svg(dark_badge(background))['inlineSvg'].encode()))
        for text_style in ['--ltx-fg-color:#000;', '--ltx-fg-color:#808080;',
                           '--ltx-fg-color:#fff;color:#FFF;',
                           '--ltx-fg-color:#fff;COLOR : white;',
                           '--ltx-fg-color:#fff;color:var(--ltx-fg-color);',
                           '--ltx-fg-color:#fff;color:red;',
                           '--ltx-fg-color:#fff;color:inherit;',
                           '--ltx-fg-color:#fff;display:none;',
                           '--ltx-fg-color:#fff;opacity:0;',
                           '--ltx-fg-color:#fff;background:white;',
                           '--ltx-fg-color:#fff;translate:100px;',
                           '--ltx-fg-color:#fff;rotate:90deg;',
                           '--ltx-fg-color:#fff;scale:2;',
                           '--ltx-fg-color:#fff;inset:100px;',
                           '--ltx-fg-color:#fff;margin-left:100px;',
                           '--ltx-fg-color:#fff;padding-left:100px;',
                           '--ltx-fg-color:#fff;width:100px;',
                           '--ltx-fg-color:#fff;position:relative;left:100px;',
                           '--ltx-fg-color:#fff;-webkit-text-fill-color:white;']:
            with self.subTest(style=text_style):
                self.assertIsNone(dependency_failure(svg(dark_badge(text_style=text_style))['inlineSvg'].encode()))
        mutations = [
            dark_badge(wrapper='matrix(1 0 0 1 39 2)'),  # Mostly outside.
            dark_badge(wrapper='translate(4 2)'),  # Unknown transform grammar.
            dark_badge(wrapper='matrix(2 0 0 1 4 2)'),
            dark_badge().replace('M 36 20 L 4 20', 'M 35 20 L 4 20'),
            dark_badge().replace('C 2 20 0 18', 'C 100 20 0 18'),
            dark_badge().replace('fill="#2e2f31"', 'fill="#2e2f31" opacity="0"'),
            dark_badge().replace('style="stroke:none"', 'style="stroke:none;transform:scale(2)"'),
            dark_badge().replace('<foreignObject width=', '<foreignObject style="width:100px" width='),
            dark_badge().replace('</g><g transform=', '</g><g/><g transform='),
        ]
        for body in mutations:
            with self.subTest(body=body):
                self.assertIsNone(dependency_failure(svg(body)['inlineSvg'].encode()))

    def test_white_css_mapping_is_resolved_at_the_color_declaration_not_the_child(self):
        mapped = dark_badge().replace('<span><span ', '<span style="color:var(--ltx-fg-color);--ltx-fg-color:#FFF;"><span ')
        self.assertIsNone(dependency_failure(svg(mapped)['inlineSvg'].encode()))
        # A parent resolves its own black variable before a child changes it.
        black_parent = mapped.replace('--ltx-fg-color:#FFF;\"><span', '--ltx-fg-color:#000;\"><span')
        self.assertEqual(dependency_failure(svg(black_parent)['inlineSvg'].encode())['reason'],
                         'unmapped_latexml_white_text_on_dark_badge')

    def test_default_black_html_text_requires_identical_black_opaque_geometry(self):
        body = dark_badge('#000', text_style='', wrapper='matrix(1.0 0.0 0.0 1.0 6 2)').replace('style="stroke:none" ', '')
        failure = dependency_failure(svg(body)['inlineSvg'].encode())
        self.assertEqual(failure['reason'], 'default_html_black_text_on_black_badge')
        self.assertIsNone(failure['witnesses'][0]['declaredForeground'])
        self.assertEqual(failure['witnesses'][0]['background'], '#000000')
        thin = body.replace('<g fill=', '<g stroke-width="0.4pt" fill=', 1)
        self.assertEqual(dependency_failure(svg(thin)['inlineSvg'].encode())['reason'], failure['reason'])
        minipage = body.replace('<foreignObject width=', '<foreignObject style="--ltx-fo-width:4em" width=')
        minipage = minipage.replace('<span><span ', '<span class="ltx_minipage" style="width:4em"><span ')
        self.assertEqual(dependency_failure(svg(minipage)['inlineSvg'].encode())['reason'], failure['reason'])
        negatives = [body.replace('#000', '#111'),
                     body.replace('style=""', 'style="color:white"'),
                     body.replace('style=""', 'style="--ltx-fg-color:black"'),
                     body.replace('style=""', 'style="color:black"'),
                     body.replace('style=""', 'style="-webkit-text-stroke:1px white"'),
                     body.replace('style=""', 'style="-webkit-text-stroke-color:white;-webkit-text-stroke-width:1px"'),
                     body.replace('<g fill=', '<g stroke-width="2" fill=', 1),
                     body.replace('<g fill=', '<g stroke-width="1pt" fill=', 1),
                     body.replace('fill="#000"', 'fill="#000" opacity="0.5"'),
                     body.replace('<g fill=', '<g style="display:none" fill=', 1),
                     body.replace('<g fill=', '<g style="display:none!important" fill=', 1),
                     body.replace('<g fill=', '<g style="visibility:hidden !important" fill=', 1),
                     body.replace('<g fill=', '<g style="display:/*hidden*/none" fill=', 1),
                     body.replace('<g fill=', '<g style="display/**/:none" fill=', 1),
                     body.replace('<g fill=', '<g style="visibility/**/:hidden" fill=', 1),
                     body.replace('style=""', 'style="text-indent:100px"'),
                     body.replace('style=""', 'style="display:none!important"'),
                     body.replace('<g fill=', '<g display="none" fill=', 1),
                     body.replace('<path ', '<path style="visibility:hidden" ', 1),
                     body.replace('matrix(1.0 0.0 0.0 1.0 6 2)', 'matrix(1 0 0 1 15 2)'),
                     minipage.replace('style="width:4em"', 'style="width:40em"'),
                     minipage.replace('style="width:4em"', 'style="width:4em;left:20px"')]
        for changed in negatives:
            with self.subTest(svg=changed):
                self.assertIsNone(dependency_failure(svg(changed)['inlineSvg'].encode()))
        with self.assertRaises(ValueError):
            dependency_failure(svg(body.replace('<g fill=', '<g style="dis\\70 lay:none" fill=', 1))['inlineSvg'].encode())

    def test_full_caption_cdot_projection_keeps_original_proof_and_all_words(self):
        resource = svg(dark_badge())
        caption = r'Figure 9: Modalities T\,\cdot\,I\,\cdot\,A; text T.'
        figure = {**self.figure, **source_descriptor(resource, '2610.90001'), 'caption': caption}
        raw, proof = self.derive(pdf(['Figure 9: Modalities T · I · A; text T.']),
                                 figure=figure, resource=resource)
        self.assertTrue(raw.startswith(b'\x89PNG'))
        self.assertEqual(proof['caption'], caption)
        self.assertEqual(proof['captionSha256'], sha(caption.encode()))
        projection = proof['captionDisplayProjection']
        self.assertEqual(projection['originalCaptionSha256'], proof['captionSha256'])
        self.assertEqual(projection['displayCaption'], 'Figure 9: Modalities T · I · A; text T.')
        for changed in ['Figure 9: Modalities T · I · B; text T.',
                        'Figure 9: Modalities T · I · A; text missing.',
                        'Figure 9: Modalities T · I · A; text T. Extra.',
                        'Figure 9: Modalities T I A; text T.']:
            with self.subTest(caption=changed), self.assertRaisesRegex(ValueError, 'not_unique'):
                self.derive(pdf([changed]), figure=figure, resource=resource)
        unknown = {**figure, 'caption': caption.replace(r'\cdot', r'\times')}
        with self.assertRaisesRegex(ValueError, 'not_unique'):
            self.derive(pdf(['Figure 9: Modalities T × I × A; text T.']), figure=unknown, resource=resource)

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

    def test_full_pdf_caption_only_typographic_label_ligatures_and_hyphen_wrap(self):
        figure = {**self.figure, 'caption': 'Figure 9: Flow-matching prefix and cross-entropy; rate 0.33.'}
        caption = 'Figure 9 Flow-matching prefix and cross-entropy; rate 0.33.'
        raw, proof = self.derive(pdf([caption]), figure=figure)
        self.assertTrue(raw.startswith(b'\x89PNG'))
        self.assertTrue(proof['pdfCaptionTypography']['openingLabelColonOmitted'])
        self.assertEqual(proof['caption'], figure['caption'])
        from reader_pdf_page_asset import _pdf_caption_text
        self.assertEqual(_pdf_caption_text('cross-\nentropy preﬁx ﬂow'), 'cross-entropy prefix flow')
        self.assertEqual(_pdf_caption_text('cross\nentropy ０.３３'), 'cross entropy ０.３３')
        for bad in [caption.replace('0.33', '0.34'), caption + ' Extra.',
                    caption.replace('cross-entropy', 'crossentropy'),
                    caption.replace('Figure 9 ', 'Figure 19 '),
                    caption.replace('prefix', 'prefixes'),
                    caption.replace('Figure 9 ', 'Figure 9; ')]:
            if bad == caption:
                continue
            with self.subTest(caption=bad), self.assertRaisesRegex(ValueError, 'not_unique'):
                self.derive(pdf([bad]), figure=figure)
        with self.assertRaisesRegex(ValueError, 'not_unique'):
            self.derive(pdf([caption, figure['caption']]), figure=figure)

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

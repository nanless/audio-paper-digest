"""Portable geometry-only tests: these synthetic PDFs have no source authority."""
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
import fitz
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve()
# Installed test layout is tests/python; proposal keeps exactly that layout.
sys.path.insert(0, str(HERE.parents[2] / 'scripts'))
from conference_publication_figure_crop import derive_figure_crop, between_consecutive_figure_captions_geometry

TITLE = 'A Source Bound Example Figure'
AUTHORS = ['Alice Researcher', 'Bob Researcher']
CAPTION = 'Figure 1: Complete two-panel diagram with axis and legend.'


def png():
    image = Image.new('RGB', (600, 180), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((3, 3, 597, 177), outline='black', width=3)
    draw.line((25, 140, 270, 140), fill='black', width=2)
    draw.line((25, 20, 25, 140), fill='black', width=2)
    draw.text((40, 145), 'X axis / condition', fill='black')
    draw.text((40, 20), '(a) complete first panel', fill='black')
    draw.rectangle((315, 20, 575, 140), outline='blue', width=2)
    draw.text((325, 35), '(b) complete second panel', fill='black')
    draw.text((325, 105), 'legend and labels', fill='black')
    out = io.BytesIO(); image.save(out, format='PNG'); return out.getvalue()


def example(modify=None):
    document = fitz.open(); page = document.new_page(width=600, height=800)
    page.insert_text((100, 55), TITLE, fontsize=12)
    page.insert_text((120, 82), ', '.join(AUTHORS), fontsize=10)
    # Actual header raster and ORCID-like drawing, not a mocked geometry record.
    page.insert_image(fitz.Rect(470, 10, 510, 25), stream=png())
    page.draw_circle((480, 77), 3)
    page.insert_text((180, 103), '1 Example University, Country', fontsize=9)
    page.insert_text((185, 120), 'research@example.org', fontsize=9)
    page.insert_image(fitz.Rect(325, 180, 575, 255), stream=png())
    page.insert_text((310, 275), CAPTION, fontsize=8)
    if modify: modify(document, page)
    raw = document.tobytes(); document.close(); return raw


def derive(raw, **overrides):
    args = dict(pdf_bytes=raw, pdf_sha256=hashlib.sha256(raw).hexdigest(),
                figure_number=1, full_caption=CAPTION, title=TITLE, authors=AUTHORS)
    args.update(overrides); return derive_figure_crop(**args)


class ConferencePublicationFigureCrop(unittest.TestCase):
    def test_complete_two_panel_raster_and_header_exclusion(self):
        raw = example(); pixels, proof = derive(raw)
        self.assertEqual(proof['purpose'], 'publication-display-only')
        self.assertEqual(proof['geometry']['completeRaster']['bbox'], [325., 180., 575., 255.])
        self.assertEqual(proof['geometry']['cropBox'], [323., 178., 577., 257.])
        self.assertTrue(proof['geometry']['excludedHeaderVisuals'])
        self.assertEqual(len(proof['geometry']['bibliographicHeader']['authors']), 2)
        self.assertTrue(pixels.startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertEqual(derive(raw), (pixels, proof))

    def test_source_sha_cannot_be_replaced(self):
        with self.assertRaisesRegex(ValueError, 'original_pdf_sha_changed'):
            derive(example(), pdf_sha256='0' * 64)

    def test_wrong_number_or_incomplete_caption(self):
        for change in [dict(figure_number=2), dict(full_caption=CAPTION[:-8])]:
            with self.assertRaises(ValueError): derive(example(), **change)

    def test_duplicate_full_caption_rejected(self):
        def add(document, _):
            page = document.new_page(width=600, height=800)
            page.insert_text((310, 275), CAPTION, fontsize=8)
        with self.assertRaisesRegex(ValueError, 'not_unique'):
            derive(example(add))

    def test_wrong_title_or_author_cannot_exempt_header(self):
        for change in [dict(title='Different Paper'), dict(authors=['Other Person'])]:
            with self.assertRaisesRegex(ValueError, 'bibliographic_'):
                derive(example(), **change)

    def test_additional_upper_subpanel_may_not_be_silently_clipped(self):
        def add(_, page): page.insert_image(fitz.Rect(340, 140, 570, 160), stream=png())
        with self.assertRaisesRegex(ValueError, 'not_one_complete_embedded_raster'):
            derive(example(add))

    def test_external_vector_axis_or_legend_rejected(self):
        def add(_, page): page.draw_rect(fitz.Rect(320, 150, 580, 166))
        with self.assertRaisesRegex(ValueError, 'external_vector_or_subpanel'):
            derive(example(add))

    def test_external_text_axis_or_legend_rejected(self):
        def add(_, page): page.insert_text((350, 163), 'External legend', fontsize=10)
        with self.assertRaisesRegex(ValueError, 'external_axis_legend_or_prose'):
            derive(example(add))

    def test_header_like_text_inside_figure_is_not_discarded(self):
        def add(_, page): page.insert_text((290, 173), '1 Another University', fontsize=10)
        with self.assertRaisesRegex(ValueError, 'external_axis_legend_or_prose|top_matter_overlaps_figure'):
            derive(example(add))

    def test_rotation_and_existing_crop_rejected(self):
        for modify in [lambda _, page: page.set_rotation(90),
                       lambda _, page: page.set_cropbox(fitz.Rect(10, 10, 590, 790))]:
            with self.assertRaisesRegex(ValueError, 'rotation_or_cropbox'):
                derive(example(modify))

    def test_vector_only_diagram_not_guessed(self):
        def remove_image(_, page):
            # A separate PDF with only drawn visual content is deliberately
            # unsupported; do not turn a native vector bbox into permission.
            page.delete_image(page.get_images()[1][0])
        with self.assertRaises(ValueError): derive(example(remove_image))





class ConsecutiveCaptionGeometry(unittest.TestCase):
    def document(self, alter=None):
        doc = fitz.open(); page = doc.new_page(width=600, height=800)
        # The old unrelated native Figure above its own complete caption.
        page.draw_rect(fitz.Rect(40, 40, 280, 145))
        page.insert_text((35, 170), 'Figure 1: Complete previous pipeline description.', fontsize=8)
        page.draw_rect(fitz.Rect(45, 205, 145, 255))
        page.draw_rect(fitz.Rect(180, 205, 275, 255))
        page.insert_text((50, 220), 'All first-panel labels', fontsize=7)
        page.insert_text((185, 220), 'All second labels', fontsize=7)
        page.insert_text((35, 280), 'Figure 2: Entire current two-panel diagram.', fontsize=8)
        if alter: alter(doc, page)
        return doc

    def choose(self, doc):
        return between_consecutive_figure_captions_geometry(doc, figure_number=2,
            full_caption='Figure 2: Entire current two-panel diagram.', title=TITLE, authors=AUTHORS)

    def test_whole_two_panels_and_labels_preserved(self):
        doc = self.document(); page, proof = self.choose(doc)
        self.assertEqual(proof['profile'], 'complete-strip-between-unique-consecutive-figure-captions-v1')
        self.assertEqual(len(proof['preservedVisuals']), 2)
        self.assertEqual(len(proof['preservedText']), 2)
        self.assertGreater(proof['cropBox'][1], 170)
        self.assertLess(proof['cropBox'][1], 205)
        doc.close()

    def test_previous_caption_must_be_globally_unique(self):
        def add(doc, _): doc.new_page().insert_text((35, 170), 'Figure 1: Complete previous pipeline description.', fontsize=8)
        with self.assertRaisesRegex(ValueError, 'not_unique'): self.choose(self.document(add))

    def test_cross_column_axis_or_subpanel_not_cut(self):
        def add(_, page): page.draw_rect(fitz.Rect(290, 205, 320, 255))
        with self.assertRaisesRegex(ValueError, 'crosses_preserved_band'): self.choose(self.document(add))

    def test_caption_boundary_may_not_cut_upper_subpanel(self):
        def add(_, page): page.draw_rect(fitz.Rect(45, 170, 100, 215))
        with self.assertRaisesRegex(ValueError, 'crosses_preserved_band'): self.choose(self.document(add))

    def test_intervening_table_caption_is_not_a_figure_label(self):
        def add(_, page): page.insert_text((35, 195), 'Table 9: Different source table.', fontsize=8)
        with self.assertRaisesRegex(ValueError, 'intervening_caption'): self.choose(self.document(add))


class CompleteSourcePageFallback(unittest.TestCase):
    """Synthetic pure geometry, never authenticated source or publication status."""
    def full(self, raw, **overrides):
        from conference_publication_figure_crop import derive_authenticated_complete_page
        values = dict(pdf_bytes=raw, pdf_sha256=hashlib.sha256(raw).hexdigest(),
            figure_number=1, full_caption=CAPTION, title=TITLE, authors=AUTHORS)
        values.update(overrides)
        return derive_authenticated_complete_page(**values)

    def test_entire_page_pixels_are_exact_common_renderer_without_clip(self):
        from reader_pdf_page_geometry import render_complete_pdf_page
        raw = example(); pixels, proof = self.full(raw)
        with fitz.open(stream=raw, filetype='pdf') as document:
            expected, meta = render_complete_pdf_page(document[0])
        self.assertEqual(pixels, expected)
        self.assertEqual(proof['renderer']['dpi'], 144)
        self.assertEqual(proof['geometry']['mediaBox'], [0., 0., 600., 800.])
        self.assertEqual(proof['geometry']['cropBox'], proof['geometry']['mediaBox'])
        self.assertTrue(proof['geometry']['fullPage'])
        self.assertFalse(proof['geometry']['pageContentModified'])
        self.assertFalse(proof['geometry']['geometricDefectClaimedFixed'])
        self.assertFalse(proof['readerInputPixelsChanged'])
        self.assertEqual(self.full(raw), (pixels, proof))

    def test_all_four_conservative_profiles_must_fail_before_fixed_fallback(self):
        from conference_publication_figure_crop import derive_supported_crop
        # Vector Figure 2 with no previous Figure caption/table/header profile.
        d=fitz.open();page=d.new_page(width=600,height=800)
        page.draw_rect(fitz.Rect(40,120,560,200))
        caption=CAPTION.replace('Figure 1:', 'Figure 2:')
        page.insert_text((40,240), caption, fontsize=8)
        raw=d.tobytes();d.close()
        pixels, proof = derive_supported_crop(pdf_bytes=raw, pdf_sha256=hashlib.sha256(raw).hexdigest(),
            figure_number=2, full_caption=caption, title=TITLE, authors=AUTHORS)
        self.assertTrue(proof['geometry']['fullPage'])
        self.assertEqual(len(proof['geometry']['priorConservativeCropFailures']), 4)
        self.assertEqual(pixels, self.full(raw,figure_number=2,full_caption=caption)[0])

    def test_existing_valid_crop_stays_exact_old_profile_pixels(self):
        from conference_publication_figure_crop import derive_supported_crop
        raw = example(); old, _ = derive(raw)
        pixels, proof = derive_supported_crop(pdf_bytes=raw, pdf_sha256=hashlib.sha256(raw).hexdigest(),
            figure_number=1, full_caption=CAPTION, title=TITLE, authors=AUTHORS)
        self.assertEqual(pixels, old)
        self.assertNotIn('fullPage', proof['geometry'])

    def test_fullpage_does_not_accept_wrong_number_changed_caption_or_pdf_sha(self):
        raw = example()
        for changes in [dict(figure_number=2), dict(full_caption=CAPTION + ' invented'), dict(pdf_sha256='0'*64)]:
            with self.assertRaises(ValueError): self.full(raw, **changes)

    def test_duplicate_complete_caption_remains_ambiguous(self):
        def duplicate(document, _):
            page = document.new_page(width=600, height=800)
            page.insert_text((310, 275), CAPTION, fontsize=8)
        with self.assertRaisesRegex(ValueError, 'not_unique'): self.full(example(duplicate))

    def test_rotation_cropbox_and_oversized_pages_reject(self):
        for mutation in [lambda d,p:p.set_rotation(90), lambda d,p:p.set_cropbox(fitz.Rect(0,0,550,750))]:
            with self.assertRaises(ValueError): self.full(example(mutation))
        d = fitz.open(); page = d.new_page(width=3000,height=3000)
        page.insert_text((40,50), CAPTION, fontsize=9); raw=d.tobytes();d.close()
        with self.assertRaisesRegex(ValueError, 'not_supported'): self.full(raw)

    def test_no_caller_rectangle_profile_or_page_selector(self):
        for field,value in [('rect',[0,0,5,5]),('profile','free'),('page',2)]:
            with self.assertRaises(TypeError): self.full(example(), **{field:value})


class AttestedSourcePage(unittest.TestCase):
    # Pure PDF renderer tests. JSON here is not an authenticated Node capability.
    def limited(self, raw=None, caption='Figure 1:', **change):
        from conference_publication_figure_crop import derive_attested_source_page
        raw = raw or example()
        ref = dict(eligible=True, contract='conference-reader-pdf-attested-figure-ref-v1',
            paperId='conference:test',executionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ordinal=1,
            figureNumber=1,page=1,sourceRef='pdf:figure:1:page:1',originalCaptionSha256=hashlib.sha256(caption.encode()).hexdigest(),
            readerCaptionSha256=hashlib.sha256(caption.encode()).hexdigest(),pdfSha256=hashlib.sha256(raw).hexdigest(),**{k:'a'*64 for k in ['sourceDomSha256','originalSourceAssetSha256',
            'rawArtifactsFileSha256','rawArtifactsPayloadSha256','rawFigureSha256']})
        ref.update(change)
        return derive_attested_source_page(pdf_bytes=raw,pdf_sha256=hashlib.sha256(raw).hexdigest(),
            figure_number=1,full_caption=caption,attested_source_ref=ref)

    def test_label_only_is_honest_full_page_with_null_complete_caption(self):
        pixels, proof = self.limited()
        g=proof['geometry']
        self.assertTrue(g['fullPage']); self.assertTrue(g['limitedSourcePageOnly'])
        self.assertFalse(g['completeCaptionVerified']); self.assertIsNone(g['completeTargetCaption'])
        self.assertEqual(g['captionExtractionStatus'],'unavailable')
        self.assertEqual(g['cropBox'],[0.,0.,600.,800.])
        self.assertFalse(proof['readerInputPixelsChanged'])
        self.assertTrue(pixels.startswith(b'\x89PNG'))

    def test_partial_caption_does_not_become_full_caption(self):
        self.assertEqual(self.limited(caption='Figure 1: Incomplete old excerpt')[1]['geometry']['captionExtractionStatus'],'partial')

    def test_wrong_ref_page_number_sha_and_extra_fields_reject(self):
        for changes in [dict(page=2),dict(figureNumber=2),dict(pdfSha256='0'*64),dict(readerCaptionSha256='0'*64),dict(rect=[0,0,1,1])]:
            with self.assertRaises(ValueError): self.limited(**changes)

    def test_actual_page_label_must_be_unique_not_caption_deduped(self):
        raw=example(lambda d,p:p.insert_text((20,500),CAPTION,fontsize=9))
        with self.assertRaisesRegex(ValueError,'label_not_unique'): self.limited(raw=raw)

    def test_wrong_real_page_and_rotation_reject(self):
        raw=example(lambda d,p:p.set_rotation(90))
        with self.assertRaises(ValueError): self.limited(raw=raw)
        with self.assertRaises(ValueError): self.limited(page=2,sourceRef='pdf:figure:1:page:2')


class NativeCaptionLineClosure(unittest.TestCase):
    def test_exact_actual_native_caption_and_no_substring_match(self):
        from reader_pdf_page_geometry import locate_complete_source_line_caption
        raw=example()
        with fitz.open(stream=raw,filetype='pdf') as d:
            found=locate_complete_source_line_caption(d,1,CAPTION)
            self.assertEqual(found['lineRunProof']['boundary'],'native-block-end')
            with self.assertRaisesRegex(ValueError,'not_exact'):
                locate_complete_source_line_caption(d,1,CAPTION[:-8])

    def test_duplicate_printed_label_is_not_seen_deduplicated(self):
        from reader_pdf_page_geometry import locate_complete_source_line_caption
        raw=example(lambda d,p:p.insert_text((30,500),CAPTION,fontsize=8))
        with fitz.open(stream=raw,filetype='pdf') as d:
            with self.assertRaisesRegex(ValueError,'not_unique'):
                locate_complete_source_line_caption(d,1,CAPTION)

    def test_label_only_cannot_claim_complete_caption(self):
        from reader_pdf_page_geometry import locate_complete_source_line_caption
        d=fitz.open();p=d.new_page();p.insert_text((30,50),'Figure 1:',fontsize=8)
        with self.assertRaisesRegex(ValueError,'no_complete_text'):
            locate_complete_source_line_caption(d,1,'Figure 1:')
        d.close()

    def test_overlap_stop_cannot_claim_complete_even_if_legacy_text_exact(self):
        from reader_pdf_page_geometry import locate_complete_source_line_caption
        class Page:
            number=0
            def get_text(self,*a,**k):
                return {'blocks':[{'type':0,'lines':[
                    {'bbox':[0,0,100,10],'spans':[{'text':CAPTION}]},
                    {'bbox':[0,7,100,18],'spans':[{'text':'A real unconsumed continuation'}]}]}]}
        with self.assertRaisesRegex(ValueError,'may_be_partial'):
            locate_complete_source_line_caption([Page()],1,CAPTION)


if __name__ == '__main__': unittest.main()

#!/usr/bin/env python3
"""Unit tests for deterministic PDF figure-crop & booktabs table extraction."""

import hashlib
import json
import struct
import sys
import unittest
from pathlib import Path

import fitz

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import pdf_figure_table_extract as ext  # noqa: E402


def _make_synthetic_academic_pdf() -> bytes:
    """Create a minimal deterministic single-column academic PDF with a vector figure and a booktabs table."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # Body prose above figure
    page.insert_textbox(
        fitz.Rect(72, 60, 520, 130),
        "This paper introduces a modular acoustic speech recognition pipeline. "
        "We evaluate all baselines under identical training conditions on standard public benchmarks. "
        "The architecture is illustrated in Figure 1 below with full signal flow.",
        fontsize=10,
    )
    # Vector diagram centered across page (straddling page center -> must NOT get half-chopped!)
    shape = page.new_shape()
    shape.draw_rect(fitz.Rect(140, 160, 260, 220))
    shape.draw_rect(fitz.Rect(330, 160, 450, 220))
    shape.draw_line(fitz.Point(260, 190), fitz.Point(330, 190))
    shape.finish(color=(0, 0, 0), width=1.2)
    shape.commit()
    page.insert_text(fitz.Point(165, 194), "Encoder", fontsize=10)
    page.insert_text(fitz.Point(355, 194), "Decoder", fontsize=10)
    # Short centered caption (previously caused false right-column clamping!)
    page.insert_text(fitz.Point(245, 244), "Fig. 1. System overview", fontsize=10)

    # Booktabs table below
    page.insert_text(fitz.Point(210, 310), "Table 1. Main benchmark results", fontsize=10)
    tshape = page.new_shape()
    tshape.draw_line(fitz.Point(140, 325), fitz.Point(455, 325))
    tshape.draw_line(fitz.Point(140, 345), fitz.Point(455, 345))
    tshape.draw_line(fitz.Point(140, 395), fitz.Point(455, 395))
    tshape.finish(color=(0, 0, 0), width=0.8)
    tshape.commit()
    # Header row
    page.insert_text(fitz.Point(150, 339), "Model", fontsize=9)
    page.insert_text(fitz.Point(280, 339), "WER", fontsize=9)
    page.insert_text(fitz.Point(380, 339), "RTF", fontsize=9)
    # Body rows
    page.insert_text(fitz.Point(150, 362), "Baseline", fontsize=9)
    page.insert_text(fitz.Point(280, 362), "5.40", fontsize=9)
    page.insert_text(fitz.Point(380, 362), "0.35", fontsize=9)
    page.insert_text(fitz.Point(150, 382), "Proposed", fontsize=9)
    page.insert_text(fitz.Point(280, 382), "3.85", fontsize=9)
    page.insert_text(fitz.Point(380, 382), "0.18", fontsize=9)

    data = doc.tobytes()
    doc.close()
    return data


class PdfFigureTableExtractTests(unittest.TestCase):
    def test_centered_single_column_figure_not_half_chopped_and_renders_valid_png(self):
        pdf_bytes = _make_synthetic_academic_pdf()
        result = ext.extract_pdf_figures_and_tables(pdf_bytes, arxiv_id="2611.99999")
        self.assertEqual(result["pdfSha256"], hashlib.sha256(pdf_bytes).hexdigest())
        self.assertEqual(len(result["figures"]), 1)
        fig = result["figures"][0]
        self.assertEqual(fig["label"], "Figure 1")
        self.assertEqual(fig["recoveryStatus"], "complete")
        img = fig["images"][0]
        self.assertEqual(img["kind"], "pdf_crop")
        self.assertEqual(img["cropContract"], ext.PDF_FIGURE_CROP_CONTRACT)
        # Verify zero persistent image-byte keys in metadata descriptor
        for forbidden in ("rawBytes", "base64", "cachePath", "tempPath", "assetBytes"):
            self.assertNotIn(forbidden, img)
        # Verify BOTH left box (x=140) and right box (x=450) are inside bbox (not half-chopped!)
        x0, y0, x1, y1 = img["bbox"]
        self.assertLessEqual(x0, 140.0)
        self.assertGreaterEqual(x1, 450.0)
        self.assertLessEqual(y0, 160.0)
        self.assertGreaterEqual(y1, 220.0)
        # Cryptographic descriptor validation passes on clean figure & rejects tampered bbox/url/query
        desc = ext.pdf_crop_source_descriptor(img, "2611.99999")
        self.assertEqual(desc["pdfCropSourceSha256"], img["cropSha256"])
        tampered_bbox = {**img, "bbox": [1.0, 2.0, 3.0, 4.0]}
        with self.assertRaises(ValueError):
            ext.pdf_crop_source_descriptor(tampered_bbox, "2611.99999")
        wrong_paper = {**img}
        with self.assertRaises(ValueError):
            ext.pdf_crop_source_descriptor(wrong_paper, "2611.00001")
        query_url = {**img, "url": img["url"].replace("#", "?bad=1#")}
        with self.assertRaises(ValueError):
            ext.pdf_crop_source_descriptor(query_url, "2611.99999")
        # Deterministic PNG rendering
        png1 = ext.render_pdf_figure_crop_png(pdf_bytes, img["page"], img["bbox"], dpi=216)
        png2 = ext.render_pdf_figure_crop_png(pdf_bytes, img["page"], img["bbox"], dpi=216)
        self.assertTrue(png1.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(png1, png2)
        w, h = struct.unpack(">II", png1[16:24])
        self.assertGreater(w, 600)
        self.assertGreater(h, 150)

    def test_booktabs_table_extracted_cleanly_without_midword_splits(self):
        pdf_bytes = _make_synthetic_academic_pdf()
        result = ext.extract_pdf_figures_and_tables(pdf_bytes, arxiv_id="2611.99999")
        self.assertEqual(len(result["tables"]), 1)
        tab = result["tables"][0]
        self.assertEqual(tab["label"], "Table 1")
        self.assertEqual(tab["headerRows"], [0])
        self.assertEqual(tab["bodyRows"], [1, 2])
        self.assertEqual(tab["matrix"], [
            ["Model", "WER", "RTF"],
            ["Baseline", "5.40", "0.35"],
            ["Proposed", "3.85", "0.18"],
        ])

    def test_prose_reference_sentences_are_not_mistaken_for_captions(self):
        self.assertIsNone(ext._match_caption_header("Figure 1 shows the architecture of our model.", "figure"))
        self.assertIsNone(ext._match_caption_header("Fig. 2 plots latency against interruption rate.", "figure"))
        self.assertIsNone(ext._match_caption_header("Table 1 reports average precision on test split.", "table"))
        self.assertIsNotNone(ext._match_caption_header("Figure 1 Samples of our four-step student.", "figure"))
        self.assertIsNotNone(ext._match_caption_header("TABLE I Comparative Summary of ASR Systems", "table"))

    def test_negative_zero_and_url_params_hardening(self):
        h1 = ext._canonical_crop_sha256("a" * 64, 1, [-0.001, 10.0, 100.0, 80.0], 216)
        h2 = ext._canonical_crop_sha256("a" * 64, 1, [0.0, 10.0, 100.0, 80.0], 216)
        self.assertEqual(h1, h2)
        pdf_bytes = _make_synthetic_academic_pdf()
        img = ext.extract_pdf_figures_and_tables(pdf_bytes, arxiv_id="2611.99999")["figures"][0]["images"][0]
        params_url = dict(img, url=img["url"].replace(".pdf#", ".pdf;foo#"))
        with self.assertRaises(ValueError):
            ext.pdf_crop_source_descriptor(params_url, "2611.99999")

    def test_historical_direct_rewrite_pdf_crop_staging_and_paired_dom_pipe_parity(self):
        import hashlib
        import importlib.util
        import json
        import os
        import tempfile

        spec = importlib.util.spec_from_file_location("publish_to_blog_mod", SCRIPTS_DIR / "publish-to-blog.py")
        pub = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pub)

        # H2b: Historical fetched-arxiv-sources generation-000002 authentication + tamper rejection
        pdf_bytes = _make_synthetic_academic_pdf()
        extracted = ext.extract_pdf_figures_and_tables(pdf_bytes, arxiv_id="2611.99999")
        resource = extracted["figures"][0]["images"][0]
        text_bytes = b"Synthetic historical paper text body."
        runtime_obj = {"structuredArtifacts": {"payloadSha256": "b" * 64}}
        runtime_bytes = json.dumps(runtime_obj).encode("utf-8")
        manifest_obj = {
            "arxivId": "2611.99999",
            "generation": 2,
            "text": {"responseSha256": hashlib.sha256(text_bytes).hexdigest()},
            "runtimeMetadata": {"responseSha256": hashlib.sha256(runtime_bytes).hexdigest()},
            "pdf": {"responseSha256": hashlib.sha256(pdf_bytes).hexdigest()},
        }
        manifest_bytes = json.dumps(manifest_obj).encode("utf-8")
        proof = {
            "runId": "11111111-2222-3333-4444-555555555555",
            "sourceGeneration": 2,
            "sourceManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "sourceSha256": hashlib.sha256(text_bytes).hexdigest(),
            "structuredArtifactsSha256": "b" * 64,
        }
        paper = {
            "arxivId": "2611.99999",
            "sourceSha256": proof["sourceSha256"],
            "freshRewriteProvenance": proof,
            "analysisManifest": {"freshRewriteProvenance": proof},
        }
        with tempfile.TemporaryDirectory() as tmp:
            runtime_root = Path(tmp) / "runtime"
            daily_root = runtime_root / "daily-fresh-source-runs"
            gen_dir = runtime_root / "fetched-arxiv-sources" / "2611.99999" / "generation-000002"
            for d in (runtime_root, daily_root, runtime_root / "fetched-arxiv-sources", runtime_root / "fetched-arxiv-sources" / "2611.99999", gen_dir):
                d.mkdir(parents=True, exist_ok=True)
                os.chmod(d, 0o700)
            for name, data in (
                ("source.txt", text_bytes),
                ("source.pdf", pdf_bytes),
                ("source-runtime.json", runtime_bytes),
                ("source-manifest.json", manifest_bytes),
            ):
                p = gen_dir / name
                p.write_bytes(data)
                os.chmod(p, 0o600)
            old_daily = pub.DAILY_FRESH_SOURCE_RUNS_DIR
            try:
                pub.DAILY_FRESH_SOURCE_RUNS_DIR = daily_root
                png = pub._render_reader_pdf_crop_pixels(paper, resource)
                self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
                bad_paper = dict(paper, freshRewriteProvenance=dict(proof, sourceManifestSha256="f" * 64))
                bad_paper["analysisManifest"] = {"freshRewriteProvenance": bad_paper["freshRewriteProvenance"]}
                with self.assertRaises(pub.PublishDataValidationError):
                    pub._render_reader_pdf_crop_pixels(bad_paper, resource)
            finally:
                pub.DAILY_FRESH_SOURCE_RUNS_DIR = old_daily

        # H3: _verify_reader_paired_dom_bindings accepts escaped pipe \| in renderedText
        raw_pipe = "P(y|x) = 0.85"
        esc_pipe = r"P(y\|x) = 0.85"
        self.assertEqual(pub._reader_cell_comparison(esc_pipe), pub._reader_cell_comparison(raw_pipe))
        unesc = esc_pipe.replace("\\|", "|")
        self.assertIn(unesc, (pub._normalize_api_reader_display_artifacts(raw_pipe), raw_pipe))

    def test_booktabs_preserves_divider_rows_and_broadcasts_superheaders(self):
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 95), "Table 1. Late fusion across disjoint splits", fontsize=10)
        page.draw_line((72, 105), (500, 105), width=0.8)
        # Super-header row 0 (centered over column pairs) + sub-header row 1
        page.insert_text((75, 118), "Features", fontsize=9)
        page.insert_text((240, 118), "Rec.-disjoint", fontsize=9)
        page.insert_text((395, 118), "Spk.-disjoint", fontsize=9)
        page.insert_text((225, 132), "LR", fontsize=9)
        page.insert_text((285, 132), "GB", fontsize=9)
        page.insert_text((380, 132), "LR", fontsize=9)
        page.insert_text((440, 132), "GB", fontsize=9)
        page.draw_line((72, 138), (500, 138), width=0.6)
        # 1-span divider row + data rows + second 1-span divider row + data rows
        page.insert_text((75, 152), "Recording-disjoint", fontsize=9)
        page.insert_text((75, 166), "Timing only", fontsize=9)
        page.insert_text((225, 166), ".644", fontsize=9)
        page.insert_text((285, 166), ".652", fontsize=9)
        page.insert_text((380, 166), ".622", fontsize=9)
        page.insert_text((440, 166), ".615", fontsize=9)
        page.insert_text((75, 180), "Speaker-disjoint", fontsize=9)
        page.insert_text((75, 194), "Timing + text", fontsize=9)
        page.insert_text((225, 194), ".673", fontsize=9)
        page.insert_text((285, 194), ".682", fontsize=9)
        page.insert_text((380, 194), ".631", fontsize=9)
        page.insert_text((440, 194), ".630", fontsize=9)
        page.draw_line((72, 202), (500, 202), width=0.8)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99998")
        self.assertEqual(len(res["tables"]), 1)
        matrix = res["tables"][0]["matrix"]
        self.assertEqual(
            matrix[0],
            ["Features", "Rec.-disjoint LR", "Rec.-disjoint GB", "Spk.-disjoint LR", "Spk.-disjoint GB"],
        )
        self.assertIn(["Recording-disjoint", "", "", "", ""], matrix)
        self.assertIn(["Speaker-disjoint", "", "", "", ""], matrix)

    def test_booktabs_does_not_corrupt_wrapped_single_col_headers_or_multi_key_cols(self):
        # R2-C1 (a): Normal 2-line wrapped header ("Training\nHours") must NOT broadcast across "WER (%)"
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 95), "Table 1. Training hours and WER comparison", fontsize=10)
        page.draw_line((72, 105), (420, 105), width=0.8)
        page.insert_text((215, 118), "Training", fontsize=9)
        page.insert_text((75, 132), "Model", fontsize=9)
        page.insert_text((220, 132), "Hours", fontsize=9)
        page.insert_text((340, 132), "WER (%)", fontsize=9)
        page.draw_line((72, 138), (420, 138), width=0.6)
        page.insert_text((75, 152), "Baseline", fontsize=9)
        page.insert_text((222, 152), "960", fontsize=9)
        page.insert_text((345, 152), "5.40", fontsize=9)
        page.insert_text((75, 166), "Proposed", fontsize=9)
        page.insert_text((222, 166), "480", fontsize=9)
        page.insert_text((345, 166), "3.85", fontsize=9)
        page.draw_line((72, 174), (420, 174), width=0.8)
        pdf_wrapped = doc.tobytes()
        doc.close()

        res_wrapped = ext.extract_pdf_figures_and_tables(pdf_wrapped, "2611.99997")
        self.assertEqual(len(res_wrapped["tables"]), 1)
        self.assertEqual(res_wrapped["tables"][0]["matrix"][0], ["Model", "Training Hours", "WER (%)"])

        # R2-C1 (b): Multi-key-column + single super-header must NOT overwrite col 1 ("Params") or trailing col 4 ("Avg")
        doc2 = fitz.open()
        page2 = doc2.new_page(width=595, height=842)
        page2.insert_text((72, 95), "Table 2. Multi-key column super-header table", fontsize=10)
        page2.draw_line((72, 105), (510, 105), width=0.8)
        page2.insert_text((75, 118), "Model", fontsize=9)
        page2.insert_text((165, 118), "Params", fontsize=9)
        page2.insert_text((275, 118), "LibriSpeech", fontsize=9)
        page2.insert_text((170, 132), "(M)", fontsize=9)
        page2.insert_text((260, 132), "clean", fontsize=9)
        page2.insert_text((325, 132), "other", fontsize=9)
        page2.insert_text((440, 132), "Avg", fontsize=9)
        page2.draw_line((72, 138), (510, 138), width=0.6)
        page2.insert_text((75, 152), "CodecA", fontsize=9)
        page2.insert_text((170, 152), "42.0", fontsize=9)
        page2.insert_text((260, 152), "3.10", fontsize=9)
        page2.insert_text((325, 152), "6.40", fontsize=9)
        page2.insert_text((440, 152), "4.75", fontsize=9)
        page2.insert_text((75, 166), "CodecB", fontsize=9)
        page2.insert_text((170, 166), "28.5", fontsize=9)
        page2.insert_text((260, 166), "2.80", fontsize=9)
        page2.insert_text((325, 166), "5.90", fontsize=9)
        page2.insert_text((440, 166), "4.35", fontsize=9)
        page2.draw_line((72, 174), (510, 174), width=0.8)
        pdf_multi = doc2.tobytes()
        doc2.close()

        res_multi = ext.extract_pdf_figures_and_tables(pdf_multi, "2611.99996")
        self.assertEqual(len(res_multi["tables"]), 1)
        self.assertEqual(
            res_multi["tables"][0]["matrix"][0],
            ["Model", "Params (M)", "LibriSpeech clean", "LibriSpeech other", "Avg"],
        )

        # R3-H1 (a): Compact IEEE/Interspeech flush-left wrapped header (7pt gap) must NOT broadcast across col 2
        doc3 = fitz.open()
        page3 = doc3.new_page(width=595, height=842)
        page3.insert_text((72, 95), "Table 3. Compact left-aligned wrapped header", fontsize=10)
        page3.draw_line((72, 105), (340, 105), width=0.8)
        page3.insert_text((220, 118), "Training", fontsize=9)
        page3.insert_text((75, 132), "Model", fontsize=9)
        page3.insert_text((220, 132), "Hours", fontsize=9)
        page3.insert_text((260, 132), "WER (%)", fontsize=9)
        page3.draw_line((72, 138), (340, 138), width=0.6)
        page3.insert_text((75, 152), "Baseline", fontsize=9)
        page3.insert_text((220, 152), "960", fontsize=9)
        page3.insert_text((260, 152), "5.40", fontsize=9)
        page3.insert_text((75, 166), "Proposed", fontsize=9)
        page3.insert_text((220, 166), "100", fontsize=9)
        page3.insert_text((260, 166), "3.85", fontsize=9)
        page3.draw_line((72, 174), (340, 174), width=0.8)
        pdf_compact = doc3.tobytes()
        doc3.close()
        res_compact = ext.extract_pdf_figures_and_tables(pdf_compact, "2611.99995")
        self.assertEqual(res_compact["tables"][0]["matrix"][0], ["Model", "Training Hours", "WER (%)"])

        # R3-H1 (b): 3-col repeated sub-headers with row-0 col-0 "Features" + compact "F1"/"AUC" super-headers
        doc4 = fitz.open()
        page4 = doc4.new_page(width=595, height=842)
        page4.insert_text((72, 95), "Table 4. Three-column repeated sub-header groups", fontsize=10)
        page4.draw_line((72, 105), (540, 105), width=0.8)
        page4.insert_text((75, 118), "Features", fontsize=9)
        page4.insert_text((237, 118), "F1", fontsize=9)
        page4.insert_text((435, 118), "AUC", fontsize=9)
        page4.insert_text((170, 132), "200ms", fontsize=9)
        page4.insert_text((230, 132), "500ms", fontsize=9)
        page4.insert_text((290, 132), "1000ms", fontsize=9)
        page4.insert_text((370, 132), "200ms", fontsize=9)
        page4.insert_text((430, 132), "500ms", fontsize=9)
        page4.insert_text((490, 132), "1000ms", fontsize=9)
        page4.draw_line((72, 138), (540, 138), width=0.6)
        page4.insert_text((75, 152), "Text", fontsize=9)
        for x, v in [(170, ".61"), (230, ".64"), (290, ".67"), (370, ".72"), (430, ".75"), (490, ".78")]:
            page4.insert_text((x, 152), v, fontsize=9)
        page4.insert_text((75, 166), "Audio", fontsize=9)
        for x, v in [(170, ".63"), (230, ".66"), (290, ".69"), (370, ".74"), (430, ".77"), (490, ".80")]:
            page4.insert_text((x, 166), v, fontsize=9)
        page4.draw_line((72, 174), (540, 174), width=0.8)
        pdf_rep3 = doc4.tobytes()
        doc4.close()
        res_rep3 = ext.extract_pdf_figures_and_tables(pdf_rep3, "2611.99994")
        self.assertEqual(
            res_rep3["tables"][0]["matrix"][0],
            ["Features", "F1 200ms", "F1 500ms", "F1 1000ms", "AUC 200ms", "AUC 500ms", "AUC 1000ms"],
        )


if __name__ == "__main__":
    unittest.main()

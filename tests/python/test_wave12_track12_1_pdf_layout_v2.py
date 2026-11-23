#!/usr/bin/env python3

import sys
import unittest
from pathlib import Path

import fitz

ROOT_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT_DIR / 'scripts'
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import pdf_figure_table_extract as ext  # noqa: E402


def _count_non_white_pixels(png_bytes: bytes) -> int:
    pix = fitz.Pixmap(png_bytes)
    samples = pix.samples
    n = pix.n
    non_white = 0
    for idx in range(0, len(samples), n):
        if samples[idx] < 245 or samples[idx + 1] < 245 or samples[idx + 2] < 245:
            non_white += 1
    return non_white


def _build_real_rotated_pdf(rotation: int, *, nonzero_cropbox: bool = False) -> bytes:
    """Create a realistic LaTeX pdflscape/rotated page by projecting visual upright content onto a rotated page."""
    # Draw cleanly on an upright canvas of the visual dimensions first, then project with rotate=rotation and set /Rotate!
    if rotation in (90, 270):
        vis_w, vis_h = 842.0, 595.0
        raw_w, raw_h = 595.0, 842.0
    else:
        vis_w, vis_h = 595.0, 842.0
        raw_w, raw_h = 595.0, 842.0

    src = fitz.open()
    sp = src.new_page(width=vis_w, height=vis_h)
    if rotation in (90, 270):
        # Left half figure + right half table
        sp.draw_rect(fitz.Rect(60, 60, 360, 230), color=(0.1, 0.2, 0.8), fill=(0.2, 0.4, 0.9))
        sp.insert_text((60, 255), "Figure 1: Landscape architecture diagram.", fontsize=10)
        sp.insert_text((440, 80), "Table 1: Landscape codec benchmark.", fontsize=10)
        sp.draw_line((440, 92), (780, 92), width=1.0)
        sp.insert_text((445, 106), "Model", fontsize=9)
        sp.insert_text((580, 106), "PESQ", fontsize=9)
        sp.insert_text((690, 106), "STOI", fontsize=9)
        sp.draw_line((440, 112), (780, 112), width=0.8)
        sp.insert_text((445, 128), "Baseline", fontsize=9)
        sp.insert_text((580, 128), "3.10", fontsize=9)
        sp.insert_text((690, 128), "0.85", fontsize=9)
        sp.insert_text((445, 144), "Ours", fontsize=9)
        sp.insert_text((580, 144), "3.78", fontsize=9)
        sp.insert_text((690, 144), "0.93", fontsize=9)
        sp.draw_line((440, 154), (780, 154), width=1.0)
    else:
        # 180-deg inverted portrait page
        sp.draw_rect(fitz.Rect(80, 70, 460, 220), color=(0.1, 0.2, 0.8), fill=(0.2, 0.4, 0.9))
        sp.insert_text((80, 245), "Figure 1: Inverted portrait diagram.", fontsize=10)
        sp.insert_text((80, 360), "Table 1: Inverted portrait benchmark.", fontsize=10)
        sp.draw_line((80, 372), (480, 372), width=1.0)
        sp.insert_text((85, 386), "Model", fontsize=9)
        sp.insert_text((260, 386), "PESQ", fontsize=9)
        sp.insert_text((380, 386), "STOI", fontsize=9)
        sp.draw_line((80, 392), (480, 392), width=0.8)
        sp.insert_text((85, 408), "Baseline", fontsize=9)
        sp.insert_text((260, 408), "3.10", fontsize=9)
        sp.insert_text((380, 408), "0.85", fontsize=9)
        sp.insert_text((85, 424), "Ours", fontsize=9)
        sp.insert_text((260, 424), "3.78", fontsize=9)
        sp.insert_text((380, 424), "0.93", fontsize=9)
        sp.draw_line((80, 434), (480, 434), width=1.0)

    out = fitz.open()
    pad = 24.0 if nonzero_cropbox else 0.0
    p = out.new_page(width=raw_w + pad * 2, height=raw_h + pad * 2)
    target_rect = fitz.Rect(pad, pad, raw_w + pad, raw_h + pad)
    p.show_pdf_page(target_rect, src, 0, rotate=rotation)
    if nonzero_cropbox:
        p.set_cropbox(target_rect)
    p.set_rotation(rotation)
    pdf_bytes = out.tobytes()
    out.close()
    src.close()
    return pdf_bytes


class Wave12Track121PdfLayoutV2Tests(unittest.TestCase):
    def test_rotated_pages_90_180_270_and_nonzero_cropbox_extract_painted_crops_and_tables(self):
        for rot, nz in [(90, False), (270, False), (180, False), (90, True)]:
            with self.subTest(rotation=rot, nonzero_cropbox=nz):
                pdf_bytes = _build_real_rotated_pdf(rot, nonzero_cropbox=nz)
                res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99301")
                self.assertEqual(len(res["figures"]), 1)
                self.assertEqual(res["figures"][0]["label"], "Figure 1")
                img = res["figures"][0]["images"][0]
                png = ext.render_pdf_figure_crop_png(pdf_bytes, img["page"], img["bbox"], img["dpi"])
                self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
                # Must actually capture the painted blue figure box, NOT a blank white PNG!
                self.assertGreater(_count_non_white_pixels(png), 5000)

                self.assertEqual(len(res["tables"]), 1)
                self.assertEqual(res["tables"][0]["matrix"][0], ["Model", "PESQ", "STOI"])
                self.assertEqual(res["tables"][0]["matrix"][2], ["Ours", "3.78", "0.93"])

    def test_portrait_sidewaystable_rotation_extracted_upright(self):
        doc = fitz.open()
        p = doc.new_page(width=595, height=842)
        # Simulate LaTeX \begin{sidewaystable} on portrait page (rotation==0, text rotated 90 deg CCW)
        p.insert_text((90, 720), "Table 2: Sideways multi-speaker ASR results.", fontsize=10, rotate=90)
        p.draw_line((105, 730), (105, 320), width=1.0)
        p.insert_text((120, 720), "System", fontsize=9, rotate=90)
        p.insert_text((120, 560), "WER", fontsize=9, rotate=90)
        p.insert_text((120, 440), "CER", fontsize=9, rotate=90)
        p.draw_line((128, 730), (128, 320), width=0.8)
        p.insert_text((144, 720), "Whisper", fontsize=9, rotate=90)
        p.insert_text((144, 560), "5.2%", fontsize=9, rotate=90)
        p.insert_text((144, 440), "2.1%", fontsize=9, rotate=90)
        p.insert_text((162, 720), "Proposed", fontsize=9, rotate=90)
        p.insert_text((162, 560), "3.8%", fontsize=9, rotate=90)
        p.insert_text((162, 440), "1.4%", fontsize=9, rotate=90)
        p.draw_line((176, 730), (176, 320), width=1.0)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99302")
        self.assertEqual(len(res["tables"]), 1)
        self.assertEqual(res["tables"][0]["label"], "Table 2")
        self.assertEqual(res["tables"][0]["matrix"][0], ["System", "WER", "CER"])
        self.assertEqual(res["tables"][0]["matrix"][2], ["Proposed", "3.8%", "1.4%"])

    def test_tall_booktabs_table_above_220pt_extracted_intact(self):
        doc = fitz.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((72, 70), "Table 3: Full-page 24-row audio benchmark.", fontsize=10)
        p.draw_line((72, 84), (480, 84), width=1.0)
        p.insert_text((76, 98), "System", fontsize=9)
        p.insert_text((260, 98), "UTMOS", fontsize=9)
        p.insert_text((380, 98), "WER", fontsize=9)
        p.draw_line((72, 105), (480, 105), width=0.8)
        y = 122
        for i in range(1, 25):
            p.insert_text((76, y), f"Model-{i:02d}", fontsize=9)
            p.insert_text((260, y), f"{3.0 + i * 0.04:.2f}", fontsize=9)
            p.insert_text((380, y), f"{8.0 - i * 0.15:.2f}", fontsize=9)
            y += 18  # Total height ~ 450pt (> 220pt old cap!)
        p.draw_line((72, y + 4), (480, y + 4), width=1.0)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99303")
        self.assertEqual(len(res["tables"]), 1)
        tbl = res["tables"][0]
        self.assertEqual(len(tbl["matrix"]), 25)  # 1 header + 24 body rows!
        self.assertEqual(tbl["matrix"][1], ["Model-01", "3.04", "7.85"])
        self.assertEqual(tbl["matrix"][24], ["Model-24", "3.96", "4.40"])

    def test_multipage_table_continued_stitching_drops_repeated_header(self):
        doc = fitz.open()
        # Page 1: Table 4 part 1
        p1 = doc.new_page(width=595, height=842)
        p1.insert_text((72, 80), "Table 4: Cross-lingual speech synthesis evaluation.", fontsize=10)
        p1.draw_line((72, 92), (480, 92), width=1.0)
        p1.insert_text((76, 106), "Language", fontsize=9)
        p1.insert_text((240, 106), "MOS", fontsize=9)
        p1.insert_text((360, 106), "SIM", fontsize=9)
        p1.draw_line((72, 112), (480, 112), width=0.8)
        p1.insert_text((76, 128), "English", fontsize=9)
        p1.insert_text((240, 128), "4.21", fontsize=9)
        p1.insert_text((360, 128), "0.78", fontsize=9)
        p1.insert_text((76, 146), "Mandarin", fontsize=9)
        p1.insert_text((240, 146), "4.18", fontsize=9)
        p1.insert_text((360, 146), "0.81", fontsize=9)
        p1.draw_line((72, 156), (480, 156), width=1.0)

        # Page 2: Table 4 (continued)
        p2 = doc.new_page(width=595, height=842)
        p2.insert_text((72, 80), "Table 4 (continued): Cross-lingual speech synthesis evaluation.", fontsize=10)
        p2.draw_line((72, 92), (480, 92), width=1.0)
        p2.insert_text((76, 106), "Language", fontsize=9)
        p2.insert_text((240, 106), "MOS", fontsize=9)
        p2.insert_text((360, 106), "SIM", fontsize=9)
        p2.draw_line((72, 112), (480, 112), width=0.8)
        p2.insert_text((76, 128), "Japanese", fontsize=9)
        p2.insert_text((240, 128), "4.09", fontsize=9)
        p2.insert_text((360, 128), "0.76", fontsize=9)
        p2.insert_text((76, 146), "Korean", fontsize=9)
        p2.insert_text((240, 146), "4.05", fontsize=9)
        p2.insert_text((360, 146), "0.75", fontsize=9)
        p2.draw_line((72, 156), (480, 156), width=1.0)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99304")
        self.assertEqual(len(res["tables"]), 1)
        tbl = res["tables"][0]
        self.assertEqual(tbl["label"], "Table 4")
        self.assertEqual(tbl["headerRows"], [0])
        self.assertEqual(tbl["bodyRows"], [1, 2, 3, 4])
        self.assertEqual(tbl["matrix"], [
            ["Language", "MOS", "SIM"],
            ["English", "4.21", "0.78"],
            ["Mandarin", "4.18", "0.81"],
            ["Japanese", "4.09", "0.76"],
            ["Korean", "4.05", "0.75"],
        ])
        self.assertEqual(len(tbl["cells"]), 15)

    def test_two_column_booktabs_table_not_blocked_by_opposite_column_prose(self):
        doc = fitz.open()
        p = doc.new_page(width=595, height=842)
        # Left column booktabs table (x = 50..280, y = 82..210)
        p.insert_text((50, 72), "Table 1: Left-column acoustic model results.", fontsize=9)
        p.draw_line((50, 82), (280, 82), width=1.0)
        p.insert_text((54, 96), "Model", fontsize=8.5)
        p.insert_text((160, 96), "WER", fontsize=8.5)
        p.insert_text((225, 96), "CER", fontsize=8.5)
        p.draw_line((50, 102), (280, 102), width=0.8)
        for idx, (m, wer, cer) in enumerate([
            ("Base", "6.4", "2.8"), ("Small", "5.1", "2.1"), ("Medium", "4.3", "1.7"),
            ("Large", "3.7", "1.4"), ("Ours", "3.1", "1.1"),
        ]):
            y = 118 + idx * 18
            p.insert_text((54, y), m, fontsize=8.5)
            p.insert_text((160, y), wer, fontsize=8.5)
            p.insert_text((225, y), cer, fontsize=8.5)
        p.draw_line((50, 206), (280, 206), width=1.0)

        # Right column body prose vertically overlapping the left table (x = 315..545, y = 110..220)
        prose = (
            "In our experiments, we evaluate acoustic representations across diverse reverberant "
            "and noisy recording environments to measure robustness against real-world channel "
            "distortion, speaker overlap, and low-bitrate compression artifacts."
        )
        p.insert_textbox(fitz.Rect(315, 110, 545, 230), prose, fontsize=9)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99305")
        self.assertEqual(len(res["tables"]), 1)
        self.assertEqual(len(res["tables"][0]["matrix"]), 6)
        self.assertEqual(res["tables"][0]["matrix"][-1], ["Ours", "3.1", "1.1"])

    def test_single_column_full_width_figure_not_sliced_by_lower_right_caption(self):
        doc = fitz.open()
        p = doc.new_page(width=595, height=842)
        # Full-width figure at top (x = 72..523, y = 60..220) with short left-aligned caption
        p.draw_rect(fitz.Rect(72, 60, 523, 220), color=(0.1, 0.2, 0.8), fill=(0.85, 0.9, 1.0))
        p.insert_text((72, 240), "Figure 1: Full-width system overview.", fontsize=10)
        # Narrow right-positioned Table caption much lower on the same single-column page
        p.insert_text((310, 560), "Table 1: Auxiliary latency summary.", fontsize=10)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99306")
        self.assertEqual(len(res["figures"]), 1)
        bbox = res["figures"][0]["images"][0]["bbox"]
        # Right edge must cover full figure (~523), NOT be clamped to ~302!
        self.assertGreater(bbox[2], 500.0)

    def test_continued_table_appendix_A1_headerless_page2_and_prose_rejection(self):
        doc = fitz.open()
        p1 = doc.new_page(width=595, height=842)
        p1.insert_text((72, 80), "Table A.1: Appendix per-speaker breakdown.", fontsize=10)
        p1.draw_line((72, 92), (480, 92), width=1.0)
        p1.insert_text((76, 106), "Speaker", fontsize=9)
        p1.insert_text((260, 106), "PESQ", fontsize=9)
        p1.insert_text((380, 106), "STOI", fontsize=9)
        p1.draw_line((72, 112), (480, 112), width=0.8)
        p1.insert_text((76, 128), "Spk-01", fontsize=9)
        p1.insert_text((260, 128), "3.60", fontsize=9)
        p1.insert_text((380, 128), "0.89", fontsize=9)
        p1.insert_text((76, 146), "Spk-02", fontsize=9)
        p1.insert_text((260, 146), "3.71", fontsize=9)
        p1.insert_text((380, 146), "0.91", fontsize=9)
        p1.draw_line((72, 156), (480, 156), width=1.0)

        # Page 2: prose mentioning Table A.1 (continued) shows ... (must NOT trigger caption!),
        # followed by genuine Table A.1 (continued) WITHOUT repeated header row (row 0 is Spk-03 data!)
        p2 = doc.new_page(width=595, height=842)
        p2.insert_text((72, 55), "Table A.1 (continued) shows additional test speakers from the held-out split.", fontsize=9)
        p2.insert_text((72, 100), "Table A.1 (continued): Appendix per-speaker breakdown.", fontsize=10)
        p2.draw_line((72, 112), (480, 112), width=1.0)
        p2.insert_text((76, 128), "Spk-03", fontsize=9)
        p2.insert_text((260, 128), "3.82", fontsize=9)
        p2.insert_text((380, 128), "0.92", fontsize=9)
        p2.insert_text((76, 146), "Spk-04", fontsize=9)
        p2.insert_text((260, 146), "3.79", fontsize=9)
        p2.insert_text((380, 146), "0.90", fontsize=9)
        p2.draw_line((72, 156), (480, 156), width=1.0)
        pdf_bytes = doc.tobytes()
        doc.close()

        res = ext.extract_pdf_figures_and_tables(pdf_bytes, "2611.99307")
        self.assertEqual(len(res["tables"]), 1)
        tbl = res["tables"][0]
        self.assertEqual(tbl["label"], "Table A.1")
        # Spk-03 MUST be preserved (not dropped as a fake repeated header!)
        self.assertEqual(tbl["matrix"], [
            ["Speaker", "PESQ", "STOI"],
            ["Spk-01", "3.60", "0.89"],
            ["Spk-02", "3.71", "0.91"],
            ["Spk-03", "3.82", "0.92"],
            ["Spk-04", "3.79", "0.90"],
        ])


if __name__ == '__main__':
    unittest.main()

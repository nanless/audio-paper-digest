"""Offline PDF fixtures: no model calls and no production runtime writes."""
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from conference_extractor import _caption_candidate, load_pypdf_backend
import fitz


def layout_pdf(offset=0):
    document = fitz.open()
    page = document.new_page(width=600, height=800)
    page.draw_rect(fitz.Rect(45, 80, 250, 220), color=(1, 0, 0), fill=(1, 0, 0))
    page.draw_rect(fitz.Rect(345, 80, 550, 220), color=(0, 0, 1), fill=(0, 0, 1))
    page.insert_text((45, 245), "Fig. 2: Left red result", fontsize=11)
    page.insert_text((345, 245 + offset), "Figure 3: Right blue result", fontsize=11)
    page.insert_text((45, 290), "Figure 2 presents the main result.", fontsize=11)
    page.insert_text((45, 310), "Figure 2 shows another comparison.", fontsize=11)
    page.insert_text((45, 330), "Fig. 2: Duplicate caption", fontsize=11)
    page.insert_text((45, 380), "Table 1: Accuracy and latency", fontsize=11)
    xs, ys = [45, 190, 320, 550], [395, 425, 455, 485, 515]
    for x in xs:
        page.draw_line((x, ys[0]), (x, ys[-1]))
    for y in ys:
        page.draw_line((xs[0], y), (xs[-1], y))
    for row, values in enumerate([
        ["Method", "Accuracy", "Latency"],
        ["Model 2", "95.2%", "12 ms"],
        ["Baseline", "91.0%", "-"],
        ["Other", "90.1%", "15 ms"],
    ]):
        for col, value in enumerate(values):
            page.insert_text((xs[col] + 5, ys[row] + 20), value, fontsize=11)
    page.insert_text((45, 575), "x = y^2 + z", fontsize=11)
    # Actual positioned fraction/superscript/multi-line matrix, whose PDF
    # reading order cannot establish original LaTeX semantics.
    page.insert_text((345, 555), "L =", fontsize=11)
    page.insert_text((380, 547), "a + b", fontsize=11)
    page.draw_line((378, 552), (415, 552))
    page.insert_text((382, 565), "c", fontsize=11)
    page.insert_text((390, 558), "2", fontsize=7)
    page.insert_text((440, 550), "[ a b ]", fontsize=11)
    page.insert_text((440, 565), "[ c d ]", fontsize=11)
    page.insert_text((45, 630), "Fig. 9: No adjacent drawing", fontsize=11)
    return document.tobytes()


class PdfStructureSafetyTest(unittest.TestCase):
    def test_caption_aliases_exclude_prose(self):
        for text in ["Figure 2 presents a result", "Figure 2 shows this", "Table 1 lists data"]:
            self.assertIsNone(_caption_candidate(text))
        for text in ["Fig. 2: Result", "Figure 2. Result", "FIG 2 - Result"]:
            self.assertEqual(_caption_candidate(text), ("figure", 2))

    def test_parallel_crops_and_original_numbers(self):
        backend = load_pypdf_backend()
        for offset in [0, 7, -7]:
            with self.subTest(offset=offset):
                pdf = layout_pdf(offset)
                artifacts = backend.extract_structures(pdf, backend.extract_pages(pdf))
                figures = artifacts["figures"]
                self.assertEqual(len(figures), 2)
                self.assertEqual([f["sourceRef"] for f in figures],
                                 ["pdf:figure:2:page:1", "pdf:figure:3:page:1"] if offset >= 0
                                 else ["pdf:figure:3:page:1", "pdf:figure:2:page:1"])
                for figure in figures:
                    pixels = fitz.Pixmap(base64.b64decode(figure["asset"]["base64"]))
                    self.assertGreater(pixels.height, 220)
                    self.assertLessEqual(pixels.width, 480)
                    center = pixels.pixel(pixels.width // 2, pixels.height // 2)
                    self.assertEqual(center, (255, 0, 0) if ":2:" in figure["sourceRef"] else (0, 0, 255))
                audit = backend.extract_visual_audit(pdf)
                self.assertEqual([c["number"] for c in audit["figureCandidates"]].count(2), 1)

    def test_tables_and_formulas_remain_candidates_with_literal_cells(self):
        backend = load_pypdf_backend()
        pdf = layout_pdf()
        structures = backend.extract_structures(pdf, backend.extract_pages(pdf))
        self.assertEqual(structures["tables"], [])
        self.assertEqual(structures["formulas"], [])
        audit = backend.extract_visual_audit(pdf)
        tables = [t for t in audit["tableCandidates"] if "rawCells" in t]
        self.assertTrue(tables)
        self.assertEqual(tables[0]["rawCells"][1], ["Model 2", "95.2%", "12 ms"])
        self.assertEqual(tables[0]["rawCells"][2], ["Baseline", "91.0%", "-"])
        self.assertEqual(len(tables[0]["cellBboxes"]), 12)
        self.assertEqual(tables[0]["status"], "needs-review")
        self.assertTrue(audit["formulaCandidates"])
        self.assertTrue(all(c["status"] == "visual-only-no-tex" for c in audit["formulaCandidates"]))


if __name__ == "__main__":
    if os.environ.get("PD_PDF_QA_EXPORT") == "1":
        output = Path(tempfile.mkdtemp(prefix="conference-pdf-safety-"))
        pdf = layout_pdf()
        (output / "parallel.pdf").write_bytes(pdf)
        with fitz.open(stream=pdf, filetype="pdf") as document:
            document[0].get_pixmap(dpi=100, alpha=False).save(output / "page.png")
        backend = load_pypdf_backend()
        for figure in backend.extract_structures(pdf, backend.extract_pages(pdf))["figures"]:
            (output / f"crop-{figure['ordinal']}.png").write_bytes(base64.b64decode(figure["asset"]["base64"]))
        print(f"PDF_QA_PATH={output}")
    unittest.main()

"""Real PDF glyph positioning regressions; no network or model calls."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

import fitz

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from conference_extractor import load_pypdf_backend  # noqa: E402


class FormulaLayoutTest(unittest.TestCase):
    def extract(self, draw):
        with fitz.open() as document:
            page = document.new_page(width=612, height=792)
            draw(page)
            pdf = document.tobytes()
        backend = load_pypdf_backend()
        structures = backend.extract_structures(pdf, backend.extract_pages(pdf))
        audit = backend.extract_visual_audit(pdf)
        return structures, audit

    def assert_pixel_bound(self, structures, audit):
        for formula in structures["formulas"]:
            self.assertEqual(formula["tex"], "")
            self.assertEqual(formula["recoveryStatus"], "layout-preserved")
            expression = formula["sourceExpression"]
            self.assertFalse(expression["originalTexAvailable"])
            self.assertEqual(expression["kind"], "recovered-from-pdf-layout")
            png = base64.b64decode(audit["pages"][formula["page"] - 1]["pngBase64"])
            self.assertEqual(hashlib.sha256(png).hexdigest(), expression["renderSha256"])
            self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
            candidates = [c for c in audit["formulaCandidates"] if c["layoutSha256"] == expression["layoutSha256"]]
            self.assertEqual(len(candidates), 1)
            candidate = candidates[0]
            self.assertEqual(candidate["derivedTex"], expression["recoveredTex"])
            crop = expression["crop"]
            crop_png = base64.b64decode(crop["base64"])
            self.assertEqual(crop["dpi"], 144)
            self.assertEqual(hashlib.sha256(crop_png).hexdigest(), crop["sha256"])
            self.assertEqual(candidate["cropBBox"], crop["bbox"])
            for glyph in candidate["layout"]["glyphs"]:
                self.assertLessEqual(crop["bbox"][0], glyph["bbox"][0])
                self.assertLessEqual(crop["bbox"][1], glyph["bbox"][1])
                self.assertGreaterEqual(crop["bbox"][2], glyph["bbox"][2])
                self.assertGreaterEqual(crop["bbox"][3], glyph["bbox"][3])
            # The formula rectangle points to real, retained page pixels.
            pixmap = fitz.Pixmap(png)
            self.assertLess(candidate["bbox"][0], candidate["bbox"][2])
            self.assertLessEqual(candidate["bbox"][2], pixmap.width)

    def test_isolated_superscript_is_retained_not_published_as_original_tex(self):
        def draw(p):
            p.insert_text((60, 100), "y=", fontsize=7)
            p.insert_text((71, 100), "x", fontsize=7)
            p.insert_text((75, 96), "2", fontsize=5)
        structures, audit = self.extract(draw)
        self.assertEqual(len(structures["formulas"]), 1)
        self.assertEqual(structures["formulas"][0]["sourceExpression"]["recoveredTex"], "y=x^{2}")
        self.assert_pixel_bound(structures, audit)

    def test_subscript_and_superscript_with_same_x_attach_to_same_base(self):
        def draw(p):
            p.insert_text((60, 100), "y=", fontsize=12)
            p.insert_text((80, 100), "x", fontsize=12)
            p.insert_text((87, 94), "2", fontsize=8)
            p.insert_text((87, 105), "i", fontsize=8)
        structures, audit = self.extract(draw)
        self.assertEqual(structures["formulas"][0]["sourceExpression"]["recoveredTex"], "y=x_{i}^{2}")
        self.assert_pixel_bound(structures, audit)

    def test_simple_baseline_remains_available_as_layout_evidence(self):
        structures, audit = self.extract(lambda p: p.insert_text((60, 100), "y=x+1", fontsize=12))
        self.assertEqual(structures["formulas"][0]["sourceExpression"]["recoveredTex"], "y=x+1")
        self.assert_pixel_bound(structures, audit)

    def test_stacked_fraction_keeps_numerator_denominator_and_rule_pixels(self):
        def draw(p):
            p.insert_text((60, 100), "y=", fontsize=12)
            p.insert_text((80, 93), "a", fontsize=10)
            p.insert_text((80, 110), "b", fontsize=10)
            p.draw_line((78, 99), (90, 99))
        structures, audit = self.extract(draw)
        self.assertIsNone(structures["formulas"][0]["sourceExpression"]["recoveredTex"])
        chars = [g["text"] for g in audit["formulaCandidates"][0]["layout"]["glyphs"]]
        self.assertIn("a", chars)
        self.assertIn("b", chars)
        self.assert_pixel_bound(structures, audit)

    def test_nested_superscript_is_not_flattened_to_one_level(self):
        def draw(p):
            p.insert_text((60, 100), "y=", fontsize=12)
            p.insert_text((80, 100), "x", fontsize=12)
            p.insert_text((87, 94), "2", fontsize=8)
            p.insert_text((92, 90), "3", fontsize=5)
        structures, audit = self.extract(draw)
        self.assertIsNone(structures["formulas"][0]["sourceExpression"]["recoveredTex"])
        self.assertIn("3", [g["text"] for g in audit["formulaCandidates"][0]["layout"]["glyphs"]])
        self.assert_pixel_bound(structures, audit)

    def test_two_adjacent_equations_are_not_joined_into_publishable_tex(self):
        def draw(p):
            p.insert_text((60, 100), "y=x+1", fontsize=12)
            p.insert_text((60, 115), "z=x-1", fontsize=12)
        structures, audit = self.extract(draw)
        self.assertGreaterEqual(len(structures["formulas"]), 1)
        self.assert_pixel_bound(structures, audit)

    def test_english_paragraphs_and_neighbouring_column_are_not_formula_images(self):
        def draw(p):
            for y in (60, 75, 90):
                p.insert_text((40, y), 'The proposed model uses y=x in this paragraph.', fontsize=10)
                p.insert_text((320, y), 'The neighbouring column contains prose.', fontsize=10)
            p.insert_text((60, 200), 'y=x+1', fontsize=12)
        structures, audit = self.extract(draw)
        self.assertEqual(len(structures['formulas']), 1)
        crop = structures['formulas'][0]['sourceExpression']['crop']
        self.assertLess(crop['bbox'][2] - crop['bbox'][0], 60)
        self.assertLess(crop['bbox'][3] - crop['bbox'][1], 25)
        self.assertTrue(any(c['regionStatus'] == 'needs-region-review' for c in audit['formulaCandidates']))
        self.assert_pixel_bound(structures, audit)

    def test_formula_count_limit_retains_overflow_candidates(self):
        def draw(p):
            for index in range(36):
                p.insert_text((60, 40 + index * 20), 'y=x+1', fontsize=7)
        structures, audit = self.extract(draw)
        self.assertEqual(len(structures['formulas']), 32)
        self.assertEqual(len(audit['formulaCandidates']), 36)
        self.assert_pixel_bound(structures, audit)

    def test_page_size_drawing_cannot_turn_formula_into_a_whole_page_image(self):
        def draw(p):
            p.insert_text((60, 100), 'y=x+1', fontsize=12)
            p.draw_rect(fitz.Rect(0, 0, 612, 792))
        structures, audit = self.extract(draw)
        self.assertEqual(structures['formulas'], [])
        self.assertEqual(audit['formulaCandidates'][0]['regionStatus'], 'needs-region-review')
        self.assertTrue(audit['pages'][0]['pngBase64'])

    def test_node_gates_accept_layout_and_reject_tex_promotion_and_evidence_drift(self):
        structures, audit = self.extract(lambda p: p.insert_text((60, 100), "y=x+1", fontsize=12))
        script = r"""
const fs = require('node:fs'), assert = require('node:assert/strict');
const {validatePdfFormulaRecord} = require('./scripts/lib/conference-extraction-receipt.js');
const {formula, audit} = JSON.parse(fs.readFileSync(0, 'utf8'));
validatePdfFormulaRecord(formula, 0, audit, 1);
for (const change of [f => f.tex = 'y=x+1', f => f.recoveryStatus = 'complete',
    f => f.sourceExpression.originalTexAvailable = true,
    f => f.sourceExpression.renderSha256 = 'a'.repeat(64),
    f => f.sourceExpression.layoutSha256 = 'b'.repeat(64),
    f => f.sourceExpression.recoveredTex = 'y=x-1']) {
    const f = structuredClone(formula); change(f);
    assert.throws(() => validatePdfFormulaRecord(f, 0, audit, 1));
}
const drifted = structuredClone(audit);
drifted.formulaCandidates[0].layout.glyphs[0].origin[1] += 4;
assert.throws(() => validatePdfFormulaRecord(formula, 0, drifted, 1));
console.log('formula evidence gate: 8 checks passed');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps({
            "formula": structures["formulas"][0], "audit": audit,
        }), text=True, capture_output=True, check=True)
        self.assertIn("8 checks passed", result.stdout)

    def test_formula_crops_reach_real_page_renderer_as_visible_image_assets(self):
        from test_conference_page_render import ConferencePageRenderTest, MODULE

        def draw(p):
            p.insert_text((60, 100), "y=", fontsize=12)
            p.insert_text((80, 93), "a", fontsize=10)
            p.insert_text((80, 110), "b", fontsize=10)
            p.draw_line((78, 99), (90, 99))
        structures, audit = self.extract(draw)
        source = {"structuredArtifacts": {**structures, "visualAudit": audit, "pages": audit["pages"]},
                  "sourceBinding": {"pdfSha256": "a" * 64}, "sourceSnapshotSha256": "b" * 64}
        result = subprocess.run(["node", "-e", """
const fs = require('node:fs');
const {formulaEvidenceProjection} = require('./scripts/lib/conference-postprocess.js');
process.stdout.write(JSON.stringify(formulaEvidenceProjection(JSON.parse(fs.readFileSync(0, 'utf8')))));
"""], cwd=ROOT, input=json.dumps(source), text=True, capture_output=True, check=True)
        packet = ConferencePageRenderTest().packet()
        packet["capabilities"] = dict(MODULE.FULL)
        packet["formulaEvidence"] = json.loads(result.stdout)
        rendered = MODULE.render_packet(packet)
        self.assertIn("## 📐 原文公式与排版", rendered["markdown"])
        self.assertIn("![原文数学表达区域 1，PDF 第 1 页]", rendered["markdown"])
        self.assertIn("#page=1", rendered["markdown"])
        self.assertEqual(len(rendered["assets"]), 1)
        asset = rendered["assets"][0]
        self.assertRegex(asset["path"], r"^static/images/conference/icassp-2026/[a-f0-9]{12}/figure-1\.png$")
        self.assertEqual(asset["base64"], structures["formulas"][0]["sourceExpression"]["crop"]["base64"])
        self.assertNotIn("$$", rendered["markdown"])
        self.assertEqual(packet["paper"]["apiReaderPlan"]["formulaBindings"], [])
        self.assertIsNone(packet["formulaEvidence"]["regions"][0]["sourceExpression"]["recoveredTex"])
        packet["formulaEvidence"]["regions"][0]["sourceExpression"]["crop"]["base64"] = "AAAA"
        with self.assertRaisesRegex(ValueError, 'formula image evidence'):
            MODULE.render_packet(packet)


if __name__ == "__main__":
    unittest.main()

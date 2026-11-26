"""Self-contained SVG dependency classification, without browser or network."""
import hashlib
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_inline_svg as renderer


def svg(body):
    return ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
            '<foreignObject width="160" height="80">' + body + '</foreignObject></svg>').encode()


class ReaderInlineSvgDependencyTest(unittest.TestCase):
    def test_real_sealed_math_alttext_keeps_original_bytes_and_value(self):
        fixture = json.loads((Path(__file__).resolve().parents[1] / 'fixtures' /
                              'reader-inline-svg-2610-32637.json').read_text())
        raw = fixture['inlineSvg'].encode()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), fixture['inlineSvgSha256'])
        with self.assertRaises(ET.ParseError):
            ET.fromstring(renderer.normalize_static_html_breaks(
                renderer.normalize_html_svg_entities(raw.decode())))
        projected = renderer.validate_svg(raw)
        root = ET.fromstring(projected)
        self.assertIn('y_{<u}', [node.attrib.get('alttext') for node in root.iter()])
        self.assertEqual(projected.replace('alttext="y_{&lt;u}"', 'alttext="y_{<u}"'),
                         renderer.normalize_static_html_breaks(
                             renderer.normalize_html_svg_entities(raw.decode())))
        descriptor = renderer.source_descriptor({
            'kind': 'inline_svg', 'mediaType': 'image/svg+xml', 'inlineSvg': fixture['inlineSvg'],
            'inlineSvgBytes': len(raw), 'inlineSvgSha256': fixture['inlineSvgSha256']}, '2610.32637v1')
        self.assertEqual(descriptor['inlineSvgSourceSha256'], fixture['inlineSvgSha256'])
        png = renderer.render_svg(raw)
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        self.assertGreater(len(png), 1000)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), fixture['inlineSvgSha256'])

    def test_only_quoted_math_alttext_is_projected(self):
        for body in ('<math alttext="x<y"><mi>x</mi></math>',
                     "<math alttext='x<y'><mi>x</mi></math>",
                     '<math alttext="x&lt;y"><mi>x</mi></math>',
                     '<math alttext="x<y"/>',
                     '<span>prefix\u2028text</span>\n<math\n alttext="x<y"><mi>x</mi></math>'):
            with self.subTest(body=body):
                root = ET.fromstring(renderer.validate_svg(svg(body)))
                self.assertEqual(root.find('.//math').attrib['alttext'], 'x<y')
        raw = '<math title=\'alttext="x<y"\'><mi>x</mi></math>'
        self.assertEqual(renderer.normalize_math_alttext_less_than(raw), raw)

    def test_alttext_projection_does_not_admit_malformed_or_active_content(self):
        for body in ('<math alttext=x<y><mi>x</mi></math>',
                     '<math alttext="x<y" alttext="z"><mi>x</mi></math>',
                     '<math alttext="x<y" onclick="x()"><mi>x</mi></math>',
                     '<math alttext="x<y"><script>x()</script></math>',
                     '<math alttext="x<y" style="background:url(https://example.invalid/x)"></math>',
                     '<span alttext="x<y"></span>',
                     '<math alttext="x<y"><mi>&unknown;</mi></math>'):
            with self.subTest(body=body), self.assertRaises(Exception):
                renderer.validate_svg(svg(body))

    def test_empty_css_icons_are_unavailable_without_rewriting_bytes(self):
        for body in ('<span class="ltx_inline-block fas fa-fire" aria-hidden="true"></span>',
                     '<span class="far fa-circle" aria-hidden="false"></span>'):
            with self.subTest(body=body):
                raw = svg(body)
                before = hashlib.sha256(raw).hexdigest()
                with self.assertRaises(renderer.UnsupportedSvgDependency):
                    renderer.validate_svg(raw)
                self.assertEqual(hashlib.sha256(raw).hexdigest(), before)

    def test_plain_content_and_partial_class_names_are_not_missing_dependencies(self):
        for body in ('<span class="fa-fire"></span>', '<span class="fas">text</span>',
                     '<span class="fas fa-fire">literal text</span>',
                     '<span class="fas fa-fire"><span>literal text</span></span>'):
            with self.subTest(body=body):
                self.assertIsInstance(renderer.validate_svg(svg(body)), str)

    def test_latexml_mathml_layout_attributes_are_admitted(self):
        raw = ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
               '<math display="block"><mtable columnspacing="5pt" rowspacing="0pt"><mtr>'
               '<mtd mathbackground="#E0FFE0"><mtext>p</mtext><mo stretchy="false">=</mo>'
               '<mn>0.05</mn></mtd></mtr></mtable></math></svg>').encode()
        projected = renderer.validate_svg(raw)
        self.assertIn('mathbackground="#E0FFE0"', projected)
        self.assertIn('columnspacing="5pt"', projected)
        png = renderer.render_svg(raw)
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')

    def test_events_and_external_resources_remain_integrity_errors(self):
        for body in ('<span class="fas fa-fire" onclick="alert(1)"></span>',
                     '<span class="fas fa-fire" style="background:url(https://example.invalid/font)"></span>',
                     '<span class="fas fa-fire" src="https://example.invalid/font"></span>',
                     '<span class="fas fa-fire"><img src="https://example.invalid/a.png"></span>'):
            with self.subTest(body=body), self.assertRaises(Exception) as raised:
                renderer.validate_svg(svg(body))
            self.assertNotIsInstance(raised.exception, renderer.UnsupportedSvgDependency)

    def test_aria_is_not_added_to_general_rendering_allowlist(self):
        for body in ('<span aria-hidden="true"></span>',
                     '<span class="fas fa-fire" aria-hidden="maybe"></span>'):
            with self.subTest(body=body), self.assertRaises(ValueError) as raised:
                renderer.validate_svg(svg(body))
            self.assertNotIsInstance(raised.exception, renderer.UnsupportedSvgDependency)

    def test_invalid_dimensions_still_block_despite_icon_dependency(self):
        raw = svg('<span class="fas fa-fire"></span>').replace(b'width="160"', b'width="5000"', 1)
        with self.assertRaises(ValueError) as raised:
            renderer.validate_svg(raw)
        self.assertNotIsInstance(raised.exception, renderer.UnsupportedSvgDependency)

    def test_mpadded_admitted_only_inside_math(self):
        for raw in (
            svg('<math><mrow><mpadded style="width:0.380em;" width="0.380em"><mi>x</mi></mpadded></mrow></math>'),
            svg('<math xmlns="http://www.w3.org/1998/Math/MathML">'
                '<mpadded width="0.5em" depth="0.2em" voffset="-0.1em"><mn>1</mn></mpadded></math>'),
            ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
             '<math><mpadded width="+2px" voffset=".5ex"><mi>y</mi></mpadded></math></svg>').encode(),
        ):
            with self.subTest(raw=raw):
                projected = renderer.validate_svg(raw)
                self.assertIn('mpadded', projected)
        png = renderer.render_svg(
            svg('<math><mrow><mpadded style="width:0.380em;" width="0.380em"><mi>x</mi></mpadded></mrow></math>'))
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')

        for bad in (
            ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
             '<mpadded width="0.380em"/></svg>').encode(),
            ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
             '<g><mpadded width="0.380em"/></g></svg>').encode(),
            svg('<mpadded width="0.380em">x</mpadded>'),
            svg('<span><mpadded width="0.380em">x</mpadded></span>'),
            svg('<math><foreignObject width="20" height="20"><mpadded width="0.3em"/></foreignObject></math>'),
            svg('<math><foreignobject width="20" height="20"><mpadded width="0.3em"/></foreignobject></math>'),
            svg('<math><div><mpadded width="0.3em"/></div></math>'),
            svg('<math><MPADDED width="0.380em"><mi>x</mi></MPADDED></math>'),
            svg('<span depth="0.2em">x</span>'),
            svg('<math><mrow voffset="0.1em"><mi>x</mi></mrow></math>'),
            svg('<math><mpadded depth="10rem"><mi>x</mi></mpadded></math>'),
            svg('<math><mpadded depth="１em"><mi>x</mi></mpadded></math>'),
            svg('<math><mpadded voffset="1em;url(https://example.invalid)"><mi>x</mi></mpadded></math>'),
            svg('<math><mpadded Depth="0.2em"><mi>x</mi></mpadded></math>'),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError) as raised:
                renderer.validate_svg(bad)
            self.assertNotIsInstance(raised.exception, renderer.UnsupportedSvgDependency)

    def test_rowspan_and_colspan_scoped_to_math_mtd_and_latexml_eqn_cell(self):
        for good in (
            svg('<span class="ltx_equation ltx_eqn_table"><span class="ltx_eqn_row">'
                '<span rowspan="1" class="ltx_eqn_cell ltx_eqn_eqno ltx_align_middle ltx_align_right">(1)</span>'
                '<span colspan="2" class="ltx_eqn_cell ltx_align_center">x = 1</span>'
                '</span></span>'),
            svg('<math display="block"><mtable><mtr>'
                '<mtd rowspan="2" colspan="3"><mi>a</mi></mtd></mtr></mtable></math>'),
            ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
             '<math xmlns="http://www.w3.org/1998/Math/MathML"><mtable><mtr>'
             '<mtd rowspan="1"><mn>42</mn></mtd></mtr></mtable></math></svg>').encode(),
        ):
            with self.subTest(good=good):
                self.assertIsInstance(renderer.validate_svg(good), str)

        latexml_box = (
            '<svg id="S6.SS3.pic1" width="200" height="100" viewBox="0 0 200 100">'
            '<foreignObject width="200" height="100" '
            'style="--ltx-fo-width:12.0em;--ltx-fo-height:4.0em;--ltx-fo-depth:0.0em;font-size:10pt">'
            '<span class="ltx_foreignobject_container"><span class="ltx_foreignobject_content">'
            '<cite class="ltx_cite">[1]</cite>'
            '<span class="ltx_equation ltx_eqn_table"><span class="ltx_eqn_row">'
            '<span rowspan="1" class="ltx_eqn_cell ltx_eqn_eqno ltx_align_middle ltx_align_right">(2)</span>'
            '</span></span>'
            '</span></span></foreignObject></svg>'
        ).encode()
        with self.assertRaises(renderer.UnsupportedSvgDependency) as dep:
            renderer.validate_svg(latexml_box)
        self.assertEqual(dep.exception.reason, 'external_latexml_layout_css')

        for bad in (
            ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
             '<g rowspan="1"/></svg>').encode(),
            ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
             '<span rowspan="1" class="ltx_eqn_cell">(1)</span></svg>').encode(),
            svg('<span rowspan="1">(1)</span>'),
            svg('<span rowspan="1" class="ltx_align_middle">(1)</span>'),
            svg('<span colspan="2" class="ltx_eqn_cell_fake">(1)</span>'),
            svg('<math><span rowspan="1" class="ltx_eqn_cell">(1)</span></math>'),
            svg('<MATH><span rowspan="1" class="ltx_eqn_cell">(1)</span></MATH>'),
            svg('<svg width="20" height="20" viewBox="0 0 20 20"><span rowspan="1" class="ltx_eqn_cell">(1)</span></svg>'),
            svg('<math><div><mtd rowspan="1"><mi>x</mi></mtd></div></math>'),
            svg('<mtd rowspan="1">x</mtd>'),
            svg('<span rowspan="0" class="ltx_eqn_cell">(1)</span>'),
            svg('<span rowspan="-1" class="ltx_eqn_cell">(1)</span>'),
            svg('<span rowspan="1x" class="ltx_eqn_cell">(1)</span>'),
            svg('<span rowspan="1０" class="ltx_eqn_cell">(1)</span>'),
            svg('<span rowspan="1000" class="ltx_eqn_cell">(1)</span>'),
            svg('<span rowspan="1;url(https://example.invalid)" class="ltx_eqn_cell">(1)</span>'),
            svg('<span RowSpan="1" class="ltx_eqn_cell">(1)</span>'),
            svg('<math><mtable><mtr><mtd colspan="0"><mi>x</mi></mtd></mtr></mtable></math>'),
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError) as raised:
                renderer.validate_svg(bad)
            self.assertNotIsInstance(raised.exception, renderer.UnsupportedSvgDependency)

    def test_hidpi_step_down_falls_back_to_1x_without_crashing(self):
        small_svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80">'
            b'<rect x="4" y="4" width="152" height="72" fill="#2266aa" stroke="#111" stroke-width="2"/>'
            b'<text x="20" y="46" font-size="18" fill="#ffffff">HiDPI</text></svg>'
        )
        png_1x = renderer.render_svg(small_svg, hidpi=False)
        png_hi = renderer.render_svg(small_svg, hidpi=True)
        self.assertGreater(len(png_hi), len(png_1x))
        orig_limit = renderer.MAX_OUTPUT_BYTES
        try:
            # Force all scales > 1.0 to exceed MAX_OUTPUT_BYTES while 1.0x fits cleanly.
            renderer.MAX_OUTPUT_BYTES = len(png_1x) + 64
            fallback_png = renderer.render_svg(small_svg, hidpi=True)
            self.assertTrue(fallback_png.startswith(b'\x89PNG\r\n\x1a\n'))
            self.assertLessEqual(len(fallback_png), renderer.MAX_OUTPUT_BYTES)
        finally:
            renderer.MAX_OUTPUT_BYTES = orig_limit

    def test_latexml_foreignobject_table_classifies_as_unsupported_layout_and_bare_table_rejected(self):
        latexml_table_svg = (
            b'<svg width="320" height="120" viewBox="0 0 320 120">'
            b'<foreignObject style="--ltx-fg-color:#595959;--ltx-fo-width:17.72em;--ltx-fo-height:1.45em;--ltx-fo-depth:0.95em;font-size:10pt;" width="245" height="33">'
            b'<span class="ltx_foreignobject_container"><span class="ltx_foreignobject_content">'
            b'<table class="ltx_tabular"><tbody class="ltx_tbody">'
            b'<tr class="ltx_tr"><th class="ltx_th">X-axis:</th><td class="ltx_td">Time</td></tr>'
            b'</tbody></table></span></span></foreignObject></svg>'
        )
        with self.assertRaises(renderer.UnsupportedSvgDependency) as ctx:
            renderer.validate_svg(latexml_table_svg)
        self.assertEqual(ctx.exception.reason, 'external_latexml_layout_css')

        bare_table_svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">'
            b'<table><tbody><tr><td>outside foreignObject</td></tr></tbody></table></svg>'
        )
        with self.assertRaises(ValueError) as bad_ctx:
            renderer.validate_svg(bare_table_svg)
        self.assertNotIsInstance(bad_ctx.exception, renderer.UnsupportedSvgDependency)

    def test_replay_saved_inline_svg_pixels_retries_v2_jitter_and_rejects_mismatch(self):
        import hashlib
        from unittest import mock
        import reader_inline_svg_pixel_replay as replay_mod

        raw = (
            b'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40">'
            b'<rect x="2" y="2" width="76" height="36" fill="#336699"/></svg>'
        )
        png_jitter = b'\x89PNG\r\n\x1a\njitter-variant'
        png_exact = b'\x89PNG\r\n\x1a\nexact-saved-bytes'
        expected_sha = hashlib.sha256(png_exact).hexdigest()

        calls = []

        def flaky_render(svg_bytes, **kwargs):
            calls.append(kwargs)
            if kwargs == {'hidpi': True, 'deterministic_v2': True}:
                return png_exact if len(calls) == 3 else png_jitter
            return png_jitter

        with mock.patch.object(renderer, 'render_svg', side_effect=flaky_render):
            replayed, provenance = replay_mod.replay_saved_inline_svg_pixels(
                raw, expected_sha, contract=renderer.CONTRACT
            )
        self.assertEqual(replayed, png_exact)
        self.assertIsNone(provenance)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(c == {'hidpi': True, 'deterministic_v2': True} for c in calls))

        with mock.patch.object(renderer, 'render_svg', return_value=png_jitter), \
             mock.patch.object(replay_mod, '_trusted_renderers', return_value=iter(())):
            with self.assertRaisesRegex(ValueError, 'No trusted original SVG renderer'):
                replay_mod.replay_saved_inline_svg_pixels(
                    raw, expected_sha, contract=renderer.CONTRACT
                )

    def test_replay_breaks_early_on_deterministic_svg_error_and_normalizes_line_breaks(self):
        from unittest import mock
        import reader_inline_svg_pixel_replay as replay_mod

        raw = (
            b'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40">'
            b'<defs><rect x="0" y="0" width="9999" height="9999"/></defs>'
            b'<rect x="2" y="2" width="76" height="36" fill="#336699"/></svg>'
        )
        png = renderer.render_svg(raw, hidpi=False)
        self.assertTrue(png.startswith(b'\x89PNG\r\n\x1a\n'))

        # Deterministic UnsupportedSvgDependency breaks out immediately instead of looping 16x
        calls = 0

        def fail_once(_svg_bytes, **_kwargs):
            nonlocal calls
            calls += 1
            raise renderer.UnsupportedSvgDependency('external_css')

        with mock.patch.object(renderer, 'render_svg', side_effect=fail_once), \
             mock.patch.object(replay_mod, '_trusted_renderers', return_value=iter(())):
            with self.assertRaises(renderer.UnsupportedSvgDependency):
                replay_mod.replay_saved_inline_svg_pixels(raw, '0' * 64, contract=renderer.CONTRACT)
        self.assertEqual(calls, 1)


if __name__ == '__main__':
    unittest.main()

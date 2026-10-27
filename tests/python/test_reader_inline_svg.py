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


if __name__ == '__main__':
    unittest.main()

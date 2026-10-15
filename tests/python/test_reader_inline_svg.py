"""Self-contained SVG dependency classification, without browser or network."""
import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_inline_svg as renderer


def svg(body):
    return ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">'
            '<foreignObject width="160" height="80">' + body + '</foreignObject></svg>').encode()


class ReaderInlineSvgDependencyTest(unittest.TestCase):
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

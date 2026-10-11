import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
module_path = Path(__file__).resolve().parents[2] / 'scripts' / 'reader_inline_svg.py'
spec = importlib.util.spec_from_file_location('inline_svg_mathml', module_path)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class MathmlBooleanTests(unittest.TestCase):
    def test_static_booleans_require_mathml_element_and_ancestor(self):
        source = ('<svg width="100" height="100" viewBox="0 0 100 100">'
                  '<foreignObject><math><mover accent="true"><mi>x</mi>'
                  '<mo stretchy="false">^</mo></mover></math></foreignObject></svg>')
        self.assertEqual(renderer.validate_svg(source.encode()), source)
        invalid_sources = [
            source.replace('accent="true"', 'accent="evil"'),
            source.replace('mover', 'mrow'),
            source.replace('<math>', '<g>').replace('</math>', '</g>'),
            source.replace('stretchy="false"', 'stretchy="url(https://evil)"'),
            source.replace('stretchy="false"', 'onclick="true"'),
            source.replace('<mover accent="true">', '<mover xmlns:evil="urn:evil" evil:accent="true">'),
        ]
        for invalid_source in invalid_sources:
            with self.subTest(source=invalid_source):
                with self.assertRaises(ValueError):
                    renderer.validate_svg(invalid_source.encode())

    def test_static_break_tokens_preserve_attribute_text_and_reject_missing_structure(self):
        source = '<svg width="100" height="100" viewBox="0 0 100 100"><foreignObject><span title="literal &lt;br&gt;">before<br class="ltx_break">after</span></foreignObject></svg>'
        normalized = renderer.validate_svg(source.encode())
        self.assertEqual(normalized, source.replace('<br class="ltx_break">', '<br class="ltx_break"/>'))
        quoted = '<svg data-note="fake <br>" width="100" height="100" viewBox="0 0 100 100"></svg>'
        self.assertEqual(renderer.normalize_static_html_breaks(quoted), quoted)
        for invalid in [source.replace('</span>', ''), source.replace('<br class="ltx_break">', '<br onclick="bad">'), source.replace('<br class="ltx_break">', '<img src="remote"><br>')]:
            with self.subTest(source=invalid):
                with self.assertRaises((ValueError, renderer.ET.ParseError)):
                    renderer.validate_svg(invalid.encode())


if __name__ == '__main__':
    unittest.main()

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_inline_svg as renderer


class LocalClipTests(unittest.TestCase):
    def test_mathml_phantom_requires_real_math_ancestor(self):
        """数学占位仅接受真实数学祖先和正确命名空间。"""
        source = (
            '<svg width="100" height="100" viewBox="0 0 100 100">'
            '<foreignObject><math><mphantom><mi>x</mi></mphantom></math>'
            '</foreignObject></svg>'
        )
        namespaced = source.replace(
            '<math>', '<math xmlns="http://www.w3.org/1998/Math/MathML">'
        ).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
        for valid in [source, namespaced]:
            with self.subTest(source=valid):
                self.assertEqual(renderer.validate_svg(valid.encode()), valid)
        invalid_sources = [
            source.replace('<math>', '<g>').replace('</math>', '</g>'),
            source.replace(
                '<mphantom>', '<evil:mphantom xmlns:evil="urn:evil">'
            ).replace('</mphantom>', '</evil:mphantom>'),
        ]
        for invalid in invalid_sources:
            with self.subTest(source=invalid):
                with self.assertRaises(ValueError):
                    renderer.validate_svg(invalid.encode())

    def test_fill_and_latex_color_require_existing_local_paint(self):
        source = ('<svg width="100" height="100" viewBox="0 0 100 100">'
                  '<defs><pattern id="paint1"><rect width="10" height="10"/></pattern></defs>'
                  '<g style="--ltx-stroke-color:#52514E;--ltx-fill-color:url(#paint1);" '
                  'fill="url(#paint1)"><rect width="20" height="20"/></g></svg>')
        for tag in ['pattern', 'linearGradient', 'radialGradient']:
            valid = source.replace('pattern', tag)
            for text in [valid, valid.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')]:
                self.assertEqual(renderer.validate_svg(text.encode()), text)
        invalid_sources = [source.replace('url(#paint1)', reference) for reference in [
            'url(https://evil/#paint1)', 'url(other.svg#paint1)', 'url(#missing)',
            'url(#paint1) url(https://evil)', 'URL(#paint1)', 'url( #paint1 )',
        ]]
        invalid_sources += [
            source.replace('pattern', 'g'),
            source.replace('<pattern ', '<pattern xmlns="urn:evil" '),
            source.replace('--ltx-fill-color:', 'background:'),
            source.replace('--ltx-stroke-color:#52514E;', 'background:url(https://evil);'),
            source.replace('<g style=', '<g id="paint1" style='),
            source.replace('--ltx-fill-color:', '--ltx-fill-color:expression(bad);x:'),
        ]
        for invalid in invalid_sources:
            with self.subTest(source=invalid):
                with self.assertRaises(ValueError):
                    renderer.validate_svg(invalid.encode())

    def test_negative_paint_keeps_existing_svg_margin_and_edge_pixels(self):
        """页面整体平移不能覆盖原图边距，更不能只检查输出尺寸。"""
        import io
        from PIL import Image
        source = ('<svg width="160" height="80" viewBox="0 0 160 80" '
                  'overflow="visible" style="margin-left:100px;margin-top:80px">'
                  '<rect x="-150" y="-100" width="330" height="200" fill="black"/>'
                  '</svg>')
        with Image.open(io.BytesIO(renderer.render_svg(source.encode()))) as image:
            self.assertEqual(image.size, (330, 200))
            pixels = image.convert('RGB')
            for point in [(1, 1), (328, 1), (1, 198), (328, 198)]:
                self.assertEqual(pixels.getpixel(point), (0, 0, 0), point)

    def test_stroke_extent_is_bounded_and_edge_pixels_are_not_cropped(self):
        import io
        from PIL import Image
        source = ('<svg width="20" height="20" viewBox="0 0 20 20" overflow="visible">'
                  '<circle cx="10" cy="10" r="8" fill="white" stroke="black" '
                  'stroke-width="20" stroke-linejoin="round"/></svg>')
        with Image.open(io.BytesIO(renderer.render_svg(source.encode()))) as image:
            pixels = image.convert('RGB')
            self.assertGreaterEqual(image.width, 36)
            self.assertGreaterEqual(image.height, 36)
            # 圆外描边直径 36；左右两端必须都包含在截图里。
            cx, cy = image.width // 2, image.height // 2
            self.assertEqual(pixels.getpixel((cx - 16, cy)), (0, 0, 0))
            self.assertEqual(pixels.getpixel((cx + 16, cy)), (0, 0, 0))
        for invalid in [
            source.replace('stroke-width="20"', 'stroke-width="10000"'),
            source.replace('stroke-width="20"', 'stroke-width="1%"'),
            source.replace('<circle ', '<circle transform="scale(1000)" '),
            source.replace('<circle ', '<circle style="filter:blur(10000px)" '),
            source.replace('<svg ', '<svg style="filter:blur(10000px)" '),
        ]:
            with self.subTest(source=invalid):
                with self.assertRaises(Exception) as error:
                    renderer.render_svg(invalid.encode())
                self.assertIn('范围', str(error.exception))

    def test_clip_requires_exact_local_existing_clip_path(self):
        """裁剪引用只允许当前图中唯一的真实裁剪节点。"""
        source = (
            '<svg width="100" height="100" viewBox="0 0 100 100">'
            '<defs><clipPath id="clip1"><rect width="10" height="10"/>'
            '</clipPath></defs><g clip-path="url(#clip1)">'
            '<rect width="10" height="10"/></g></svg>'
        )
        namespaced = source.replace(
            '<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '
        )
        for valid in [source, namespaced]:
            with self.subTest(source=valid):
                self.assertEqual(renderer.validate_svg(valid.encode()), valid)
        invalid_references = [
            'url(https://evil/#clip1)',
            'url(other.svg#clip1)',
            'url(#missing)',
            'url(#1invalid)',
            'url(#clip1) url(https://evil)',
            'URL(#clip1)',
            'url( #clip1 )',
        ]
        invalid_sources = [
            source.replace('url(#clip1)', value)
            for value in invalid_references
        ]
        invalid_sources.extend([
            source.replace(
                'clip-path="url(#clip1)"', 'style="clip-path:url(#clip1)"'
            ),
            source.replace('<clipPath', '<g').replace('</clipPath>', '</g>'),
            source.replace(
                '<rect width="10" height="10"/>',
                '<rect id="clip1" width="10" height="10"/>', 1
            ),
            source.replace(
                '<clipPath ', '<clipPath xmlns="urn:evil" '
            ),
        ])
        for invalid in invalid_sources:
            with self.subTest(source=invalid):
                with self.assertRaises(ValueError):
                    renderer.validate_svg(invalid.encode())


if __name__ == '__main__':
    unittest.main()

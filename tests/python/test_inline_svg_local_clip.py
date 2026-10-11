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

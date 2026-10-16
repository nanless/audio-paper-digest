"""Static original pre/cite support, without granting resource dependencies."""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import reader_inline_svg as renderer


def svg(body, foreign=True):
    inner = '<foreignObject width="160" height="80">' + body + '</foreignObject>' if foreign else body
    return ('<svg id="figure" width="160" height="80" viewBox="0 0 160 80">' + inner + '</svg>').encode()


def latexml(body='<cite>Author, 2020</cite>'):
    return svg(body).replace(b'<foreignObject ',
        b'<foreignObject style="--ltx-fo-width:10em;--ltx-fo-height:2em;--ltx-fo-depth:0em;font-size:10pt;" ').replace(
        body.encode(), ('<span class="ltx_foreignobject_container"><span class="ltx_foreignobject_content">'
                        + body + '</span></span>').encode())


class StaticHtmlTest(unittest.TestCase):
    def test_static_pre_and_cite_preserve_bytes(self):
        for body in ['<pre class="ltx_verbatim">line 1\nline 2</pre>',
                     '<cite><a href="#bib.bib1">Author, 2020</a></cite>',
                     '<pre xmlns="http://www.w3.org/1999/xhtml">line 1</pre>']:
            raw = svg(body)
            self.assertEqual(renderer.validate_svg(raw), raw.decode())
        for body in ['<pre>static</pre>', '<cite>Author</cite>', '<pre xmlns="urn:invented">static</pre>']:
            with self.assertRaises(ValueError):
                renderer.validate_svg(svg(body, foreign=False))

    def test_external_resources_scripts_events_and_css_dependencies_remain_blocked(self):
        for body in ['<pre onclick="x">text</pre>', '<cite onload="x">text</cite>',
                     '<pre><script>1</script></pre>', '<cite><img src="https://example.invalid/a"/></cite>',
                     '<cite><a href="https://example.invalid/a">author</a></cite>',
                     '<pre style="background:url(https://example.invalid/a)">text</pre>',
                     '<cite style="@import url(a)">text</cite>']:
            with self.assertRaises(ValueError):
                renderer.validate_svg(svg(body))
        with self.assertRaises(renderer.UnsupportedSvgDependency):
            renderer.validate_svg(svg('<cite><span class="fas fa-fire" aria-hidden="true"></span></cite>'))

    def test_complete_unstyled_latexml_box_is_a_distinct_dependency(self):
        for tag in ['pre', 'cite']:
            with self.assertRaises(renderer.UnsupportedSvgDependency) as caught:
                renderer.validate_svg(latexml('<' + tag + '>original static text</' + tag + '>'))
            self.assertEqual(caught.exception.reason, 'external_latexml_layout_css')
        for unsafe in ['<cite onclick="x">text</cite>', '<pre><script>1</script></pre>',
                       '<cite><a href="https://example.invalid/">text</a></cite>']:
            with self.assertRaises(ValueError) as caught:
                renderer.validate_svg(latexml(unsafe))
            self.assertNotIsInstance(caught.exception, renderer.UnsupportedSvgDependency)

    def test_missing_contract_parts_or_inline_layout_do_not_invent_dependency(self):
        raw = latexml()
        for changed in [
                raw.replace(b'--ltx-fo-width:10em;', b''), raw.replace(b'--ltx-fo-height:2em;', b''),
                raw.replace(b'--ltx-fo-depth:0em;', b''), raw.replace(b'font-size:10pt;', b''),
                raw.replace(b'--ltx-fo-depth:0em;', b'--ltx-fo-depth:unknown;'),
                raw.replace(b'ltx_foreignobject_container', b'unrelated_container'),
                raw.replace(b'ltx_foreignobject_content', b'unrelated_content'),
                raw.replace(b'<cite>', b'<span>').replace(b'</cite>', b'</span>'),
                raw.replace(b'class="ltx_foreignobject_container"', b'class="ltx_foreignobject_container" style="display:flex;width:var(--ltx-fo-width);height:100%;align-items:end;"').replace(
                    b'class="ltx_foreignobject_content"', b'class="ltx_foreignobject_content" style="display:block;font-size:1em;line-height:1.2;"')]:
            self.assertEqual(renderer.validate_svg(changed), changed.decode())

    @unittest.skipUnless(os.environ.get('PD_READER_REAL_SOURCE_RUN'), 'optional original sealed sources')
    def test_original_ped_and_anuvani_static_sources(self):
        root = Path(os.environ['PD_READER_REAL_SOURCE_RUN'])
        for identity, ordinal in [('2610.20830', 5), ('2610.20327', 4), ('2610.20263', 3)]:
            path = root / 'sources' / identity / 'generation-000001/source-runtime.json'
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            source = json.loads(path.read_text())
            figure = next(item for item in source['structuredArtifacts']['figures'] if item['ordinal'] == ordinal)
            image = next(item for item in figure['images'] if item['kind'] == 'inline_svg')
            raw = image['inlineSvg'].encode()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), image['inlineSvgSha256'])
            with self.assertRaises(renderer.UnsupportedSvgDependency) as caught:
                renderer.validate_svg(raw)
            self.assertEqual(caught.exception.reason, 'external_latexml_layout_css')
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)


if __name__ == '__main__':
    unittest.main()

"""Finite daily static projection; fixtures are mechanical HTML, not Source proof."""
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import daily_html_projection as projection

URL = 'https://example.invalid/base/posts/test/'


def page(body, *, before='', after='', title='Same 中文 title', h1=None):
    return ('<!doctype html><html><head><meta charset="utf-8">'
            '<link rel="canonical" href="' + URL + '"><title>' + title + '</title>'
            '</head><body><h1>' + (title if h1 is None else h1) + '</h1>' + before +
            '<div class="post-content">' + body + '</div>' + after + '</body></html>').encode()


def stable(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode()


def body_digest(result):
    p = result['payload']
    return hashlib.sha256(stable(dict(contract=result['contract'], version=1,
        bodyEvents=p['bodyEvents'], bodyRefs=[{key: ref[key] for key in
            ('domainIndex', 'tag', 'attributes')} for ref in p['refs']
            if ref['domain'] == 'post_content']))).hexdigest()


# Verbatim retained output of the authorized temp Hugo 0.160.1 probe; no rebuild.
NORMAL_HTML = b'<!doctype html>\n<html>\n  <head><meta charset="utf-8"><link rel="canonical" href="https://example.invalid/base/posts/test/"><title>Same \xe4\xb8\xad\xe6\x96\x87 title</title></head>\n  <body><h1>Same \xe4\xb8\xad\xe6\x96\x87 title</h1>\n    <div class="post-content"><p>not <strong>able</strong>, notable.</p>\n<p>First paragraph.</p>\n<p>Second paragraph with <a href="https://example.invalid/x?a=1&amp;b=2">query</a>.</p>\n<table>\n  <thead>\n      <tr>\n          <th>A</th>\n          <th>B</th>\n      </tr>\n  </thead>\n  <tbody>\n      <tr>\n          <td>1</td>\n          <td>2</td>\n      </tr>\n      <tr>\n          <td>3</td>\n          <td>4</td>\n      </tr>\n  </tbody>\n</table>\n<div class="highlight"><pre tabindex="0" style="color:#f8f8f2;background-color:#272822;-moz-tab-size:4;-o-tab-size:4;tab-size:4;-webkit-text-size-adjust:none;"><code class="language-text" data-lang="text"><span style="display:flex;"><span>  keep  spaces\n</span></span><span style="display:flex;"><span>    second line\n</span></span></code></pre></div><p>Literal formula: [x + y].</p>\n</div>\n    <footer>Outside observed body</footer>\n  </body>\n</html>\n'
MINIFIED_HTML = b'<!doctype html><html><head><meta charset=utf-8><link rel=canonical href=https://example.invalid/base/posts/test/><title>Same \xe4\xb8\xad\xe6\x96\x87 title</title></head><body><h1>Same \xe4\xb8\xad\xe6\x96\x87 title</h1><div class=post-content><p>not <strong>able</strong>, notable.</p><p>First paragraph.</p><p>Second paragraph with <a href="https://example.invalid/x?a=1&amp;b=2">query</a>.</p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table><div class=highlight><pre tabindex=0 style=color:#f8f8f2;background-color:#272822;-moz-tab-size:4;-o-tab-size:4;tab-size:4;-webkit-text-size-adjust:none><code class=language-text data-lang=text><span style=display:flex><span>  keep  spaces\n</span></span><span style=display:flex><span>    second line\n</span></span></code></pre></div><p>Literal formula: [x + y].</p></div><footer>Outside observed body</footer></body></html>'
MATH_HTML = {('normal', 'inline-fixed'): b'<!doctype html>\n<html><head><meta charset="utf-8"><link rel="canonical" href="https://example.invalid/base/posts/inline-fixed/"><title>Fixed math inline-fixed</title></head>\n<body><h1>Fixed math inline-fixed</h1><div class="post-content"><p>Inline formula: \\(x+y\\).</p>\n</div></body></html>\n', ('normal', 'display-fixed'): b'<!doctype html>\n<html><head><meta charset="utf-8"><link rel="canonical" href="https://example.invalid/base/posts/display-fixed/"><title>Fixed math display-fixed</title></head>\n<body><h1>Fixed math display-fixed</h1><div class="post-content">\\[\\mathcal{L}=\\lVert y-\\hat{y}\\rVert_1\\]</div></body></html>\n', ('normal', 'display-spaced'): b'<!doctype html>\n<html><head><meta charset="utf-8"><link rel="canonical" href="https://example.invalid/base/posts/display-spaced/"><title>Fixed math display-spaced</title></head>\n<body><h1>Fixed math display-spaced</h1><div class="post-content">\\[\n  \\mathcal{L}  =  \\lVert y-\\hat{y}\\rVert_1\n\\]</div></body></html>\n', ('normal', 'inline-spaced'): b'<!doctype html>\n<html><head><meta charset="utf-8"><link rel="canonical" href="https://example.invalid/base/posts/inline-spaced/"><title>Fixed math inline-spaced</title></head>\n<body><h1>Fixed math inline-spaced</h1><div class="post-content"><p>Inline formula: \\(x  +  y\\).</p>\n</div></body></html>\n', ('production_flags', 'inline-fixed'): b'<!doctype html><html><head><meta charset=utf-8><link rel=canonical href=https://example.invalid/base/posts/inline-fixed/><title>Fixed math inline-fixed</title></head><body><h1>Fixed math inline-fixed</h1><div class=post-content><p>Inline formula: \\(x+y\\).</p></div></body></html>', ('production_flags', 'display-fixed'): b'<!doctype html><html><head><meta charset=utf-8><link rel=canonical href=https://example.invalid/base/posts/display-fixed/><title>Fixed math display-fixed</title></head><body><h1>Fixed math display-fixed</h1><div class=post-content>\\[\\mathcal{L}=\\lVert y-\\hat{y}\\rVert_1\\]</div></body></html>', ('production_flags', 'display-spaced'): b'<!doctype html><html><head><meta charset=utf-8><link rel=canonical href=https://example.invalid/base/posts/display-spaced/><title>Fixed math display-spaced</title></head><body><h1>Fixed math display-spaced</h1><div class=post-content>\\[\n\\mathcal{L} = \\lVert y-\\hat{y}\\rVert_1\n\\]</div></body></html>', ('production_flags', 'inline-spaced'): b'<!doctype html><html><head><meta charset=utf-8><link rel=canonical href=https://example.invalid/base/posts/inline-spaced/><title>Fixed math inline-spaced</title></head><body><h1>Fixed math inline-spaced</h1><div class=post-content><p>Inline formula: \\(x + y\\).</p></div></body></html>'}

class ProjectionTest(unittest.TestCase):
    def project(self, raw, limits=None):
        return projection.project_daily_html(raw, expected_canonical=URL,
            **({} if limits is None else {'limits': limits}))

    def rejected(self, raw, code, reason=None, limits=None):
        with self.assertRaises(projection.ProjectionError) as caught:
            self.project(raw, limits)
        self.assertEqual(caught.exception.code, code)
        if reason is not None:
            self.assertEqual(caught.exception.reason, reason)
        return caught.exception

    def test_basic_schema_hash_and_exact_output_size(self):
        result = self.project(page('<p>Hello <em>world</em>.</p>'))
        self.assertEqual(set(result), {'contract', 'version', 'payload', 'payloadSha256', 'evidence', 'stats'})
        self.assertEqual(result['contract'], 'daily-static-html-projection-v1')
        self.assertEqual(result['stats']['outputBytes'], len(stable(result)))
        self.assertEqual(result['payloadSha256'], hashlib.sha256(stable({k: result[k]
            for k in ('contract', 'version', 'payload')})).hexdigest())
        self.assertEqual(result['payload']['coverage']['productionArtifact'], 'not_checked')

    def test_comment_runs_and_inline_word_boundaries(self):
        self.assertEqual(self.project(page('<p>A <!--x--> B</p>'))['payloadSha256'],
                         self.project(page('<p>A B</p>'))['payloadSha256'])
        self.assertNotEqual(self.project(page('<p>not <em>able</em></p>'))['payloadSha256'],
                            self.project(page('<p>not<em>able</em></p>'))['payloadSha256'])
        self.assertNotEqual(self.project(page('<span>A</span> <span>B</span>'))['payloadSha256'],
                            self.project(page('<span>A</span><span>B</span>'))['payloadSha256'])

    def test_navigation_does_not_renumber_body(self):
        body = '<p><a href="/paper" download>data</a><img src="/fig.png" alt="A"></p>'
        plain = self.project(page(body))
        nav = self.project(page(body, before='<nav><a href="/nav">Nav</a></nav>'))
        self.assertEqual(plain['payload']['bodyEvents'], nav['payload']['bodyEvents'])
        self.assertEqual(body_digest(plain), body_digest(nav))
        self.assertNotEqual(plain['payloadSha256'], nav['payloadSha256'])
        self.assertEqual([r['domainIndex'] for r in nav['payload']['refs']], [0, 0, 1])
        self.assertEqual([r['index'] for r in nav['payload']['refs']], [0, 1, 2])
        self.assertNotEqual(body_digest(plain), body_digest(self.project(page(body.replace('/paper', '/other')))))

    def test_math_exact_and_unsupported_surfaces(self):
        for body in (r'\(x+y\)', r'\[x+y\]'):
            result = self.project(page(body))
            self.assertEqual(result['stats']['formulas'], 1)
            self.assertIn(body, [e[2] for e in result['payload']['bodyEvents'] if e[0] == 'math'])
        for body in (r'\(x  +  y\)', r'\[\mathcal{L}=\lVert y-\hat{y}\rVert_1\]',
                     '\\[\nx+y\n\\]', r'\(x<!--split-->+y\)',
                     r'\(x<em>+</em>y\)', r'\(中文\)', r'\(\)', r'\)', r'\(x'):
            with self.subTest(body=body):
                self.rejected(page(body), 'unsupported_math')

    def test_no_fallback_or_duplicate_identities(self):
        raw = page('<p>body</p>')
        cases = [raw.replace(b'class="post-content"', b'class="other"'),
                 raw.replace(b'</head>', b'<title>Second</title></head>'),
                 raw.replace(b'</body>', b'<h1>Second</h1></body>'),
                 raw.replace(b'</head>', ('<link rel="canonical" href="'+URL+'"></head>').encode())]
        for bad in cases:
            with self.subTest(raw=bad):
                self.rejected(bad, 'invalid_identity')

    def test_pre_exact_and_table_rows_preserved(self):
        self.assertNotEqual(self.project(page('<pre><code>a  b\n</code></pre>'))['payloadSha256'],
                            self.project(page('<pre><code>a b\n</code></pre>'))['payloadSha256'])
        table = '<table><tbody><tr><td>A</td><td></td></tr><tr><td>B</td></tr></tbody></table>'
        plain = self.project(page(table))
        self.assertEqual(plain['stats']['tableCells'], 3)
        self.assertNotEqual(plain['payloadSha256'], self.project(page(table.replace('</tr><tr>', '')))['payloadSha256'])
        self.rejected(page(table.replace('<td>A', '<td colspan="2">A')), 'unsupported_html', 'table_span')

    def test_actual_retained_hugo_normal_minify_and_seven_mutations(self):
        self.assertEqual(hashlib.sha256(NORMAL_HTML).hexdigest(),
            'a0d6e7ad4a9572992ee6f938a7271f967bb69755ee6c14678e19f9145222fc29')
        self.assertEqual(hashlib.sha256(MINIFIED_HTML).hexdigest(),
            'c3facae18ead9db8565bc12990dd497bb798e74e106e9c3ef9797f319cb0b24d')
        normal, mini = self.project(NORMAL_HTML), self.project(MINIFIED_HTML)
        self.assertEqual(normal['payload'], mini['payload'])
        self.assertEqual(normal['payloadSha256'], mini['payloadSha256'])
        self.assertNotEqual(normal['evidence']['rawHtmlSha256'], mini['evidence']['rawHtmlSha256'])
        changes = [(b'not <strong>able', b'not<strong>able'),
            (b'  keep  spaces', b' keep  spaces'), (b'</tr><tr>', b''),
            (b'https://example.invalid/x?a=1&amp;b=2', b'https://example.invalid/other?a=1&amp;b=2'),
            (b'<a href=', b'<a download="changed.json" href='),
            (b'<title>Same ', b'<title>Other '), (b'<h1>Same ', b'<h1>Other ')]
        for before, after in changes:
            with self.subTest(before=before):
                changed = MINIFIED_HTML.replace(before, after, 1)
                self.assertNotEqual(changed, MINIFIED_HTML)
                self.assertNotEqual(self.project(changed)['payloadSha256'], mini['payloadSha256'])

    def test_actual_math_calibration_and_honest_display_exclusion(self):
        results = []
        for kind in ('normal', 'production_flags'):
            raw = MATH_HTML[(kind, 'inline-fixed')]
            results.append(projection.project_daily_html(raw,
                expected_canonical=URL.replace('test/', 'inline-fixed/')))
            for name in ('display-fixed', 'display-spaced', 'inline-spaced'):
                with self.subTest(kind=kind, name=name):
                    with self.assertRaises(projection.ProjectionError) as caught:
                        projection.project_daily_html(MATH_HTML[(kind, name)],
                            expected_canonical=URL.replace('test/', name + '/'))
                    self.assertEqual(caught.exception.code, 'unsupported_math')
                    self.assertEqual(caught.exception.reason, 'whitespace')
        self.assertEqual(results[0]['payloadSha256'], results[1]['payloadSha256'])

    def test_entities_decode_once_nbsp_and_valueless_download(self):
        plain = self.project(page('<a href="/x?a=1&amp;b=2" download>Text</a>'))
        empty = self.project(page('<a href="/x?a=1&amp;b=2" download="">Text</a>'))
        absent = self.project(page('<a href="/x?a=1&amp;b=2">Text</a>'))
        self.assertEqual(plain['payloadSha256'], empty['payloadSha256'])
        self.assertNotEqual(plain['payloadSha256'], absent['payloadSha256'])
        self.assertEqual(plain['payload']['refs'][0]['attributes']['href']['value'], '/x?a=1&b=2')
        double = self.project(page('<a href="/x?a=1&amp;amp;b=2">Text</a>'))
        self.assertIn('&amp;', double['payload']['refs'][0]['attributes']['href']['value'])
        self.assertNotEqual(self.project(page('<p>A&nbsp;B</p>'))['payloadSha256'],
                            self.project(page('<p>A B</p>'))['payloadSha256'])

    def test_navigation_changes_only_outside_and_global_refs(self):
        body = '<p><a href="/x">Text</a><img src="/f" alt="F"></p>'
        a = self.project(page(body, before='<a href="/nav">Nav</a>'))
        b = self.project(page(body, before='<img src="/nav.png" alt="N"><a href="/nav">Nav</a>'))
        self.assertEqual(body_digest(a), body_digest(b))
        self.assertEqual(a['payload']['identity'], b['payload']['identity'])
        for before, after in (('/x', '/changed'), ('/f', '/other'), ('alt="F"', 'alt="Other"')):
            self.assertNotEqual(body_digest(a), body_digest(self.project(page(body.replace(before, after)))))
        reversed_refs = '<p><img src="/f" alt="F"><a href="/x">Text</a></p>'
        self.assertNotEqual(body_digest(a), body_digest(self.project(page(reversed_refs))))

    def test_strict_argument_and_limits_types(self):
        raw = page('<p>Good</p>')
        class Bytes(bytes):
            pass
        for value in (raw.decode(), bytearray(raw), memoryview(raw), Bytes(raw), None):
            self.rejected(value, 'invalid_argument', 'input_type')
        for value in (None, 7, False):
            with self.assertRaises(projection.ProjectionError) as caught:
                projection.project_daily_html(raw, expected_canonical=value)
            self.assertEqual(caught.exception.reason, 'canonical_type')
        for field in dataclasses.fields(projection.ProjectionLimits):
            for value in (True, 1.0, '1', 0, -1, getattr(projection.DEFAULT_LIMITS, field.name) + 1):
                with self.subTest(field=field.name, value=value):
                    limits = dataclasses.replace(projection.DEFAULT_LIMITS, **{field.name: value})
                    self.rejected(raw, 'invalid_argument', 'limits_field', limits)
        self.rejected(raw, 'invalid_argument', 'limits_type', {})

    def test_every_low_limit_fails_in_its_own_budget(self):
        base = page('<p>Good</p>')
        cases = [
            ('max_html_bytes', len(base)-1, base, 'html_bytes'),
            ('max_nodes', 1, base, 'nodes'), ('max_depth', 1, base, 'depth'),
            ('max_attrs_per_element', 1, base, 'attrs_per_element'),
            ('max_attrs_total', 1, base, 'attrs_total'),
            ('max_attr_value_bytes', 1, base, 'attr_value_bytes'),
            ('max_text_bytes', 1, base, 'text_bytes'), ('max_run_bytes', 1, base, 'run_bytes'),
            ('max_events', 1, base, 'events'),
            ('max_refs', 1, page('<a>A</a><a>B</a>'), 'refs'),
            ('max_table_cells', 1, page('<table><tr><td>A</td><td>B</td></tr></table>'), 'table_cells'),
            ('max_math_bytes', 4, page(r'\(x+y\)'), 'math_bytes'),
            ('max_output_bytes', 1, base, 'output_bytes')]
        for field, value, raw, reason in cases:
            with self.subTest(field=field):
                self.rejected(raw, 'limit_exceeded', reason,
                    dataclasses.replace(projection.DEFAULT_LIMITS, **{field: value}))

    def test_output_reservation_stops_before_final_hash_and_never_overdraws(self):
        original = projection._Budget.reserve
        rejected = []
        def reserve(budget, amount):
            before = budget.used
            try:
                return original(budget, amount)
            except projection.ProjectionError:
                rejected.append((before, amount, budget.used, budget.limits.max_output_bytes))
                raise
        with mock.patch.object(projection._Budget, 'reserve', reserve), \
             mock.patch.object(projection, '_hash_json', side_effect=AssertionError('late budget')):
            self.rejected(page('<p>' + 'x'*5000 + '</p>'), 'limit_exceeded', 'output_bytes',
                dataclasses.replace(projection.DEFAULT_LIMITS, max_output_bytes=1600))
        self.assertTrue(rejected)
        self.assertTrue(all(before == after and before <= limit < before + amount
                            for before, amount, after, limit in rejected))

    def test_malformed_duplicate_attrs_and_document_order(self):
        good = page('<p>Good</p>')
        for raw in (good.replace(b'</p>', b''), good+b'<div>tail</div>',
                    good.replace(b'<p>', b'<p id="a" ID="b">'),
                    good.replace(b'</body>', b'</br></body>'),
                    good.replace(b'</head><body>', b'<body></head>'),
                    good.replace(b'<p>', b'<p><div>'),
                    good.replace(b'<p>', b'<ul>Bad<p>')):
            with self.subTest(raw=raw):
                self.rejected(raw, 'invalid_html_structure')

    def test_supported_void_closure_and_unsupported_nonvoid_self_close(self):
        self.assertEqual(self.project(page('<p>A<br>B</p>'))['payloadSha256'],
                         self.project(page('<p>A<br/>B</p>'))['payloadSha256'])
        self.rejected(page('<p>A<span/>B</p>'), 'unsupported_html', 'nonvoid_self_close')

    def test_body_unknown_dynamic_shapes_are_not_silently_erased(self):
        for body in ('<script>bad()</script>', '<iframe></iframe>', '<svg></svg>',
                     '<picture><img src="/f"></picture>', '<img src="/f" srcset="/g 2x">',
                     '<p onclick="bad()">Text</p>', '<p data-unknown="x">Text</p>',
                     '<span class="math">x+y</span>'):
            with self.subTest(body=body):
                self.rejected(page(body), 'unsupported_math' if 'class="math"' in body else 'unsupported_html')
        result = self.project(page('<p>Text</p>', after='<script>outside()</script><footer>Text</footer>'))
        self.assertEqual(result['payload']['coverage']['dynamicDOM'], 'not_checked')

    def test_head_refs_are_not_body_refs_and_redirects_are_unsupported(self):
        raw = page('<p>Text</p>').replace(b'</head>', b'<link rel="stylesheet" href="/style.css"></head>')
        self.assertEqual(self.project(raw)['payload']['refs'], [])
        for extra in (b'<base href="https://other.invalid/">', b'<meta http-equiv="refresh" content="0">'):
            self.rejected(raw.replace(b'</head>', extra+b'</head>'), 'unsupported_html', 'document_redirect')

    def test_control_characters_utf8_and_canonical_binding(self):
        self.rejected(b'\xff', 'invalid_utf8', 'decode')
        self.rejected(b'\xef\xbb\xbf'+page('<p>Text</p>'), 'invalid_html_structure', 'control_character')
        for c in ('\x00', '\x0b', '\x7f', '\x85'):
            self.rejected(page('<p>A'+c+'B</p>'), 'invalid_html_structure', 'control_character')
        self.rejected(page('<p>Good</p>').replace(URL.encode(), b'https://other.invalid/'),
                      'canonical_mismatch', 'expected_literal')
        for url in ('', 'http://example.invalid/', 'https://user@example.invalid/',
                    'https://example.invalid:bad/', 'https://example.invalid/#fragment', 'https://exa mple.invalid/'):
            with self.subTest(url=url):
                with self.assertRaises(projection.ProjectionError) as caught:
                    projection.project_daily_html(page('<p>Good</p>'), expected_canonical=url)
                self.assertEqual(caught.exception.code, 'invalid_argument')

    def test_table_span_one_is_normalized_and_local_empty_cells_retained(self):
        table = '<table><tbody><tr><th>A</th><td></td></tr></tbody></table>'
        a = self.project(page(table))
        b = self.project(page(table.replace('<td>', '<td rowspan="1" colspan="1">')))
        self.assertEqual(a['payloadSha256'], b['payloadSha256'])
        for value in ('0', '2', '01', '+1', '', '１'):
            self.rejected(page(table.replace('<td>', '<td colspan="'+value+'">')),
                          'unsupported_html', 'table_span')
        for malformed in ('<table></table>', '<table><tbody></tbody></table>', '<table><tr></tr></table>'):
            self.rejected(page(malformed), 'unsupported_html', 'empty_table_structure')
        for malformed in ('<td>A</td>', '<table>Bad<tr><td>A</td></tr></table>',
                          '<table><tr><td><table><tr><td>A</td></tr></table></td></tr></table>'):
            with self.assertRaises(projection.ProjectionError):
                self.project(page(malformed))

    def test_whole_body_empty_is_rejected_but_local_empty_paragraph_is_valid(self):
        self.rejected(page('<p> </p><!--x-->'), 'invalid_html_structure', 'empty_post_content')
        self.assertTrue(self.project(page('<p></p><p>Good</p>')))

    def test_error_is_fixed_and_has_no_input_material_or_partial_payload(self):
        err = self.rejected(page('<p title="secret-value" title="other">SECRET TEXT</p>'),
                            'invalid_html_structure', 'duplicate_attribute')
        self.assertNotIn('secret', str(err).lower())
        self.assertFalse(hasattr(err, 'payload'))
        self.assertIs(type(err.line), int)
        self.assertIs(type(err.column), int)

    def test_private_exec_uses_its_own_dataclass_without_sys_modules_registration(self):
        namespace = {'__name__': '_daily_projection_private_test'}
        exec(compile((ROOT/'scripts/daily_html_projection.py').read_bytes(), '<private-projection>', 'exec'), namespace)
        self.assertNotIn(namespace['__name__'], sys.modules)
        self.assertIs(namespace['ProjectionLimits'].__annotations__['max_nodes'], int)
        result = namespace['project_daily_html'](page('<p>Good</p>'), expected_canonical=URL,
                                                limits=namespace['ProjectionLimits']())
        self.assertEqual(result['payloadSha256'], self.project(page('<p>Good</p>'))['payloadSha256'])
        with self.assertRaises(namespace['ProjectionError']) as caught:
            namespace['project_daily_html'](page('<p>Good</p>'), expected_canonical=URL,
                                           limits=projection.DEFAULT_LIMITS)
        self.assertEqual(caught.exception.reason, 'limits_type')

    def test_api_has_no_business_io_or_environment_effects(self):
        import builtins
        import io
        import socket
        before = dict(os.environ)
        with mock.patch.object(builtins, 'open', side_effect=AssertionError('file IO')), \
             mock.patch.object(io, 'open', side_effect=AssertionError('path IO')), \
             mock.patch.object(os, 'open', side_effect=AssertionError('fd IO')), \
             mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('process IO')), \
             mock.patch.object(socket, 'socket', side_effect=AssertionError('network IO')):
            self.project(page('<p>Good</p>'))
        self.assertEqual(dict(os.environ), before)

    def test_direct_script_retains_runtime_guard(self):
        env = dict(os.environ, CODEX_SANDBOX='projection-test-sandbox')
        result = subprocess.run([sys.executable, '-B', str(ROOT/'scripts/daily_html_projection.py')],
                                env=env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('必须在沙箱外运行', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_special_browser_containers_cannot_supply_post_content(self):
        for tag in ('textarea', 'select', 'xmp', 'plaintext', 'template', 'noscript', 'svg', 'math'):
            with self.subTest(tag=tag):
                raw = page('<p>Fake target</p>').replace(b'<div class="post-content">',
                    ('<'+tag+'><div class="post-content">').encode()).replace(
                    b'</div></body>', ('</div></'+tag+'></body>').encode())
                self.rejected(raw, 'unsupported_html', 'post_content_container')

    def test_unsupported_declarations_never_escape_as_raw_stdlib_assertions(self):
        for declaration in ('<![wat]>', '<![CDATA[raw]]>', '<?secret-processor?>', '<!doctype svg>'):
            with self.subTest(declaration=declaration):
                with self.assertRaises(projection.ProjectionError) as caught:
                    self.project(page('<p>Good</p>').replace(b'<!doctype html>', declaration.encode()))
                self.assertEqual(caught.exception.code, 'unsupported_html')

    def test_existing_conference_identity_and_text_hashes_remain_independent_goldens(self):
        from conference_publication_gate import Page
        for raw in (NORMAL_HTML, MINIFIED_HTML):
            old = Page(raw.decode())
            self.assertEqual(hashlib.sha256(json.dumps(old.page_identity_fields(),
                ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                'a46035b78a06fac45e371d4ead2e08513173ccd4e05388ea1df6d02b1cf9ea7d')
            self.assertEqual(hashlib.sha256(json.dumps(old.visible_content_fields(),
                ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                '0613cb4635aa1154c76234e2701080ceee090cb3d5bdf3c878fea83a6c1d4b42')

    def test_private_import_and_api_under_business_io_guards(self):
        import builtins
        import io
        import socket
        source = (ROOT/'scripts/daily_html_projection.py').read_bytes()
        namespace = {'__name__': '_projection_import_noio'}
        original_import = builtins.__import__
        def standard_only(name, *args, **kwargs):
            if name.split('.')[0] not in ('dataclasses', 'hashlib', 'html', 'json', 'urllib'):
                raise AssertionError('nonstandard import: ' + name)
            return original_import(name, *args, **kwargs)
        with mock.patch.object(builtins, '__import__', side_effect=standard_only), \
             mock.patch.object(builtins, 'open', side_effect=AssertionError('file IO')), \
             mock.patch.object(io, 'open', side_effect=AssertionError('path IO')), \
             mock.patch.object(os, 'open', side_effect=AssertionError('fd IO')), \
             mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('process IO')), \
             mock.patch.object(socket, 'socket', side_effect=AssertionError('network IO')):
            exec(compile(source, '<private-projection>', 'exec'), namespace)
            namespace['project_daily_html'](page('<p>Good</p>'), expected_canonical=URL)

    def test_known_external_noscript_and_svg_are_bounded_unobserved_domains(self):
        plain = page('<p>Good</p>')
        head = plain.replace(b'</head>', b'<noscript><style>.theme-toggle{display:none}</style></noscript></head>')
        nav = page('<p>Good</p>', before='<nav><svg viewBox="0 0 20 20"><title>Icon only</title>'
            '<a href="/not-an-observed-html-link"><path d="M0 0"/></a></svg></nav>')
        expected = self.project(plain)
        for raw in (head, nav):
            with self.subTest(raw=raw):
                result = self.project(raw)
                self.assertEqual(result['payload']['identity'], expected['payload']['identity'])
                self.assertEqual(result['payload']['refs'], [])
                self.assertEqual(body_digest(result), body_digest(expected))
                self.assertEqual(result['payload']['coverage']['opaqueContainers'], 'not_checked')
        self.rejected(page('<svg><path d="M0 0"/></svg>'), 'unsupported_html')
        self.rejected(plain.replace(b'</head>', b'<noscript><div class="post-content">Fake</div></noscript></head>'),
                      'unsupported_html', 'post_content_container')
        self.rejected(page('<p>Good</p>', before='<svg><g></svg></g>'), 'invalid_html_structure')
        self.rejected(nav, 'limit_exceeded', 'nodes',
                      dataclasses.replace(projection.DEFAULT_LIMITS, max_nodes=8))

    def test_html_noscript_and_style_self_close_are_not_xml_void_elements(self):
        raw = page('<p>Good</p>')
        for extra in (b'<noscript/>', b'<noscript><style/></noscript>'):
            with self.subTest(extra=extra):
                self.rejected(raw.replace(b'</head>', extra+b'</head>'),
                              'unsupported_html', 'nonvoid_self_close')

    def test_document_redirect_gate_also_precedes_every_opaque_start_path(self):
        for element in ('<base href="https://other.invalid/">',
                        '<base href="https://other.invalid/"/>',
                        '<meta http-equiv="refresh" content="0;url=https://other.invalid/">',
                        '<meta http-equiv="refresh" content="0;url=https://other.invalid/"/>'):
            for domain in ('head_noscript', 'body_svg'):
                with self.subTest(element=element, domain=domain):
                    raw = page('<p>Good</p>')
                    if domain == 'head_noscript':
                        raw = raw.replace(b'</head>', ('<noscript>'+element+'</noscript></head>').encode())
                    else:
                        raw = page('<p>Good</p>', before='<svg>'+element+'</svg>')
                    self.rejected(raw, 'unsupported_html', 'document_redirect')


if __name__ == '__main__':
    unittest.main()

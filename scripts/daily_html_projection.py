"""Finite mechanical static HTML projection, with no Source or publication authority.

Import/API calls perform no business IO. Direct script invocation retains the
project runtime guard; this library has no standalone command.
"""
from dataclasses import dataclass, fields
import hashlib
from html.parser import HTMLParser
import json
from urllib.parse import urlsplit

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('daily_html_projection.py')
    raise SystemExit('此模块只供日更静态观察内部调用。')

PROFILE = 'daily-static-html-projection-v1'
PROFILE_V2 = 'daily-static-html-projection-v2'
_WS = '\t\n\f\r '
_VOID = frozenset('area base br col embed hr img input link meta param source track wbr'.split())
_BLOCK = frozenset(('address article aside blockquote caption dd details div dl dt figcaption '
    'figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary '
    'table tbody td tfoot th thead tr ul').split())
_INLINE = frozenset(('a abbr b bdi bdo br cite code del dfn em i img kbd mark q s samp '
    'small span strong sub sup time u var wbr').split())
_GLOBAL = ('id', 'title', 'lang', 'dir')
_SEMANTIC = (('a', ('rel', 'target')), ('img', ('width', 'height', 'loading', 'decoding')),
    ('ol', ('start',)), ('li', ('value',)), ('blockquote', ('cite',)),
    ('q', ('cite',)), ('time', ('datetime',)))
_MATH_WRAPPERS = frozenset(('math', 'MathJax', 'katex', 'math-inline', 'math-display'))
_SPECIAL_CONTAINERS = frozenset(('textarea', 'select', 'option', 'optgroup', 'xmp',
    'plaintext', 'listing', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'))
_COVERAGE = (('identity', 'observed'), ('staticTextStructure', 'observed'),
    ('staticReferences', 'observed'),
    ('math', 'registered-delimiters-single-node-ascii-no-whitespace-exact'),
    ('presentationAttributes', 'not_checked'), ('dynamicDOM', 'not_checked'),
    ('assets', 'not_checked'), ('cssVisibility', 'not_checked'),
    ('opaqueContainers', 'not_checked'),
    ('browserExecution', 'not_checked'), ('mathRendering', 'not_checked'),
    ('productionArtifact', 'not_checked'))
_COVERAGE_V2 = tuple((key, 'registered-delimiters-single-node-ascii-isolated-internal-space-exact'
                     if key == 'math' else value) for key, value in _COVERAGE)


@dataclass(frozen=True)
class ProjectionLimits:
    max_html_bytes: int = 16 * 1024 * 1024
    max_nodes: int = 100000
    max_depth: int = 128
    max_attrs_per_element: int = 64
    max_attrs_total: int = 500000
    max_attr_value_bytes: int = 64 * 1024
    max_text_bytes: int = 8 * 1024 * 1024
    max_run_bytes: int = 1024 * 1024
    max_events: int = 200000
    max_refs: int = 20000
    max_table_cells: int = 100000
    max_math_bytes: int = 8 * 1024
    max_output_bytes: int = 8 * 1024 * 1024


DEFAULT_LIMITS = ProjectionLimits()


class ProjectionError(ValueError):
    def __init__(self, code, reason, line=None, column=None):
        super().__init__(code + ': ' + reason)
        self.code = code
        self.reason = reason
        self.line = line
        self.column = column


def _fail(code, reason):
    raise ProjectionError(code, reason)


def _measure(text, *, controls=True):
    """UTF-8 byte count without first allocating an encoded copy."""
    total = 0
    for ch in text:
        n = ord(ch)
        if 0xD800 <= n <= 0xDFFF or (controls and
                (n < 32 and ch not in _WS or 0x7F <= n <= 0x9F)):
            _fail('invalid_html_structure', 'control_character')
        total += 1 if n < 0x80 else 2 if n < 0x800 else 3 if n < 0x10000 else 4
    return total


def _json_size(value):
    """Count the one canonical JSON encoding, without serializing large values."""
    if type(value) is str:
        size = 2
        for c in value:
            n = ord(c)
            size += (2 if c in '\\"\b\f\n\r\t' else 6 if n < 32 else
                     1 if n < 0x80 else 2 if n < 0x800 else 3 if n < 0x10000 else 4)
        return size
    if value is None:
        return 4
    if type(value) is bool:
        return 4 if value else 5
    if type(value) is int:
        return len(str(value))
    if type(value) is list:
        return 2 + max(0, len(value) - 1) + sum(_json_size(v) for v in value)
    if type(value) is dict:
        return 2 + max(0, len(value) - 1) + sum(_json_size(k) + 1 + _json_size(v)
                                                       for k, v in value.items())
    raise TypeError('Internal non-JSON value')


def _hash_json(value):
    digest = hashlib.sha256()
    encoder = json.JSONEncoder(ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    for chunk in encoder.iterencode(value):
        digest.update(chunk.encode('utf-8'))
    return digest.hexdigest()


def _split_ws(text):
    tokens = []
    start = None
    for i, c in enumerate(text):
        if c in _WS:
            if start is not None:
                tokens.append(text[start:i])
                start = None
        elif start is None:
            start = i
    if start is not None:
        tokens.append(text[start:])
    return tokens


def _collapse(text):
    chars = []
    in_space = False
    for c in text:
        if c in _WS:
            if not in_space:
                chars.append(' ')
            in_space = True
        else:
            chars.append(c)
            in_space = False
    return ''.join(chars)


def _presence(values, key):
    return {'present': key in values, 'value': (values[key] or '') if key in values else None}


class _Budget:
    def __init__(self, limits, initial):
        self.limits = limits
        self.used = 0
        self.reserve(initial)

    def reserve(self, amount):
        if self.used + amount > self.limits.max_output_bytes:
            _fail('limit_exceeded', 'output_bytes')
        self.used += amount

    def release(self, amount):
        self.used -= amount
        assert self.used >= 0


def _shell(raw, version):
    return {'contract': PROFILE if version == 1 else PROFILE_V2, 'version': version,
        'payload': {'identity': {'canonical': '', 'title': '', 'h1': ''},
                    'bodyEvents': [], 'refs': [], 'coverage': dict(_COVERAGE if version == 1 else _COVERAGE_V2)},
        'payloadSha256': '0' * 64,
        'evidence': {'rawHtmlSha256': hashlib.sha256(raw).hexdigest(), 'rawHtmlBytes': len(raw)},
        'stats': {'nodes': 0, 'maxDepth': 0, 'attrs': 0, 'textBytes': 0, 'events': 0,
                  'refs': 0, 'tableCells': 0, 'formulas': 0, 'outputBytes': 0}}


class _Projection(HTMLParser):
    def __init__(self, raw, expected, limits, version):
        super().__init__(convert_charrefs=True)
        self.limits = limits
        self.version = version
        self.result = _shell(raw, version)
        self.payload = self.result['payload']
        self.stats = self.result['stats']
        # Reserve fixed envelope and maximum possible numeric widths up front.
        self.budget = _Budget(limits, _json_size(self.result) + 128)
        self.expected = expected
        self.stack = []
        self.stage = 0  # before html, html, head, after head, body, after body, done
        self.doctype = False
        self.counts = {'title': 0, 'h1': 0, 'canonical': 0, 'post_content': 0}
        self.post_depth = None
        self.identity_parts = []
        self.identity_bytes = 0
        self.identity_hold = 0
        self.identity_tag = None
        self.parts = []
        self.run_bytes = 0
        self.run_chars = 0
        self.run_hold = 0
        self.boundaries = []
        self.exact = False
        self.pending_space = None
        self.domain_counts = {'post_content': 0, 'html_body_outside_post_content': 0}
        self.content = False

    def _take(self, stat, amount, limit, reason):
        if self.stats[stat] + amount > getattr(self.limits, limit):
            _fail('limit_exceeded', reason)
        self.stats[stat] += amount

    def _node(self):
        self._take('nodes', 1, 'max_nodes', 'nodes')

    def _text(self, data):
        self._take('textBytes', _measure(data), 'max_text_bytes', 'text_bytes')

    def _tags(self):
        return [f['tag'] for f in self.stack]

    def _is_post(self):
        return self.post_depth is not None

    def _is_opaque(self):
        return bool(self.stack and self.stack[-1].get('opaque'))

    def _opaque_start(self, tag, values, self_closing=False):
        if tag in ('html', 'head', 'body') or 'post-content' in _split_ws(values.get('class') or ''):
            _fail('unsupported_html', 'post_content_container')
        if not self_closing and tag not in _VOID:
            if len(self.stack) + 1 > self.limits.max_depth:
                _fail('limit_exceeded', 'depth')
        if self.stack:
            self.stack[-1]['children'] += 1
        if not self_closing and tag not in _VOID:
            self.stack.append({'tag': tag, 'children': 0, 'opaque': True})
            self.stats['maxDepth'] = max(self.stats['maxDepth'], len(self.stack))

    def _can_start_opaque(self, tag):
        return (not self._is_post() and self.identity_tag is None and
                (tag == 'noscript' and self.stage in (2, 4) or tag == 'svg' and self.stage == 4))

    def _event(self, event):
        events = self.payload['bodyEvents']
        if self.pending_space is not None:
            pending = self.pending_space
            self.pending_space = None
            block = lambda e: e is not None and e[0] in ('open', 'close') and e[1] in _BLOCK
            if block(events[-1] if events else None) and block(event):
                self.budget.release(_json_size(pending) + 1)
            else:
                self._append_event(pending, reserved=True)
        if event[0] == 'text' and event[1] == ' ':
            self._check_event_limit()
            self.budget.reserve(_json_size(event) + 1)
            self.pending_space = event
        else:
            self._append_event(event)

    def _check_event_limit(self):
        if self.stats['events'] >= self.limits.max_events:
            _fail('limit_exceeded', 'events')

    def _append_event(self, event, reserved=False):
        self._check_event_limit()
        if not reserved:
            self.budget.reserve(_json_size(event) + 1)
        self.payload['bodyEvents'].append(event)
        self.stats['events'] += 1

    def _add_identity(self, data):
        size = _measure(data)
        if self.identity_bytes + size > self.limits.max_run_bytes:
            _fail('limit_exceeded', 'run_bytes')
        hold = _json_size(data) + 32
        self.budget.reserve(hold)
        self.identity_hold += hold
        self.identity_bytes += size
        self.identity_parts.append(data)

    def _finish_identity(self):
        text = ''.join(self.identity_parts)
        # Title/H1 math is deliberately outside this first identity profile.
        if any(token in text for token in ('\\(', '\\)', '\\[', '\\]')):
            _fail('unsupported_math', 'identity_math')
        value = _collapse(text).strip(_WS)
        if not value:
            _fail('invalid_identity', self.identity_tag + '_empty')
        self.budget.reserve(_json_size(value) - 2)
        self.payload['identity'][self.identity_tag] = value
        self.budget.release(self.identity_hold)
        self.identity_parts = []
        self.identity_bytes = self.identity_hold = 0
        self.identity_tag = None

    def _add_run(self, data):
        size = _measure(data)
        if self.run_bytes + size > self.limits.max_run_bytes:
            _fail('limit_exceeded', 'run_bytes')
        hold = _json_size(data) + 64
        self.budget.reserve(hold)
        self.run_hold += hold
        self.run_bytes += size
        self.run_chars += len(data)
        self.parts.append(data)

    def _math_segments(self, text):
        # Linear scanner; no TeX syntax or mathematical semantics are inferred.
        i = start = 0
        opening = None
        math_start = 0
        slash_count = 0
        boundary_index = 0
        while i < len(text):
            c = text[i]
            active = c == '\\' and slash_count % 2 == 0 and i + 1 < len(text)
            marker = text[i + 1] if active else ''
            if marker in ('(', '[', ')', ']'):
                if opening is None:
                    if marker in (')', ']'):
                        _fail('unsupported_math', 'orphan_close')
                    if i > start:
                        yield ['text', _collapse(text[start:i])]
                    opening = marker
                    math_start = i
                elif marker != (')' if opening == '(' else ']'):
                    _fail('unsupported_math', 'nested')
                else:
                    end = i + 2
                    while boundary_index < len(self.boundaries) and self.boundaries[boundary_index] <= math_start:
                        boundary_index += 1
                    if boundary_index < len(self.boundaries) and self.boundaries[boundary_index] < end:
                        _fail('unsupported_math', 'cross_node')
                    length = end - math_start
                    if length > self.limits.max_math_bytes:
                        _fail('limit_exceeded', 'math_bytes')
                    inner_start = math_start + 2
                    if i == inner_start:
                        _fail('unsupported_math', 'empty')
                    for position in range(inner_start, i):
                        char = text[position]
                        if char in _WS:
                            if (self.version != 2 or char != ' ' or position == inner_start
                                    or position + 1 == i or text[position - 1] == ' '):
                                _fail('unsupported_math', 'whitespace')
                        if not (0x21 <= ord(char) <= 0x7E or self.version == 2 and char == ' '):
                            _fail('unsupported_math', 'non_ascii')
                        if char in '<>&':
                            _fail('unsupported_math', 'html_sensitive')
                    literal = text[math_start:end]
                    yield ['math', 'inline' if opening == '(' else 'display', literal]
                    self.stats['formulas'] += 1
                    opening = None
                    start = end
                i += 2
                slash_count = 0
                continue
            slash_count = slash_count + 1 if c == '\\' else 0
            i += 1
        if opening is not None:
            _fail('unsupported_math', 'unclosed')
        if start < len(text):
            yield ['text', _collapse(text[start:])]

    def _flush(self):
        if not self.parts:
            return
        text = ''.join(self.parts)  # all parts/combined bytes were reserved before append
        if self.exact:
            self._event(['exact', text])
        else:
            for event in self._math_segments(text):
                if event[1 if event[0] == 'text' else 2]:
                    self._event(event)
        self.budget.release(self.run_hold)
        self.parts = []
        self.boundaries = []
        self.run_bytes = self.run_chars = self.run_hold = 0

    def _attrs(self, attrs):
        if len(attrs) > self.limits.max_attrs_per_element:
            _fail('limit_exceeded', 'attrs_per_element')
        self._take('attrs', len(attrs), 'max_attrs_total', 'attrs_total')
        seen = set()
        for key, value in attrs:
            _measure(key)
            if key in seen:
                _fail('invalid_html_structure', 'duplicate_attribute')
            seen.add(key)
            if value is not None and _measure(value) > self.limits.max_attr_value_bytes:
                _fail('limit_exceeded', 'attr_value_bytes')
        return dict(attrs)

    def _table(self, tag):
        parent = self.stack[-1] if self.stack else None
        p = parent['tag'] if parent else None
        table = next((f for f in reversed(self.stack) if f['tag'] == 'table'), None)
        if tag == 'table' and table:
            _fail('unsupported_html', 'tag')
        if p == 'table':
            if tag not in ('caption', 'thead', 'tbody', 'tfoot', 'tr'):
                _fail('invalid_html_structure', 'table_structure')
            if tag == 'caption':
                if parent['children']:
                    _fail('invalid_html_structure', 'table_structure')
            elif tag == 'thead':
                if parent['phase'] > 0:
                    _fail('invalid_html_structure', 'table_structure')
                parent['phase'] = 1
            elif tag in ('tbody', 'tr'):
                mode = 'section' if tag == 'tbody' else 'direct'
                if parent['phase'] == 3 or parent['mode'] not in (None, mode):
                    _fail('invalid_html_structure', 'table_structure')
                parent['mode'] = mode
                parent['phase'] = 2
            elif tag == 'tfoot':
                if parent['phase'] == 3:
                    _fail('invalid_html_structure', 'table_structure')
                parent['phase'] = 3
        if p in ('thead', 'tbody', 'tfoot') and tag != 'tr':
            _fail('invalid_html_structure', 'table_structure')
        if p == 'tr' and tag not in ('th', 'td'):
            _fail('invalid_html_structure', 'table_structure')
        if tag in ('caption', 'thead', 'tbody', 'tfoot') and p != 'table':
            _fail('invalid_html_structure', 'table_structure')
        if tag == 'tr':
            if p not in ('table', 'thead', 'tbody', 'tfoot'):
                _fail('invalid_html_structure', 'table_structure')
            table['rows'] += 1
        if tag in ('th', 'td'):
            if p != 'tr':
                _fail('invalid_html_structure', 'table_structure')
            self._take('tableCells', 1, 'max_table_cells', 'table_cells')

    def _post_attrs(self, tag, values, ref_index):
        semantic_keys = next((keys for name, keys in _SEMANTIC if name == tag), ())
        extra = {'a': ('href', 'download'), 'img': ('src', 'alt'),
                 'th': ('rowspan', 'colspan'), 'td': ('rowspan', 'colspan'),
                 'ol': ('reversed',)}.get(tag, ())
        for key in values:
            if (key in _GLOBAL or key in semantic_keys or key in extra or
                    key in ('class', 'style', 'role', 'tabindex') or key.startswith('aria-') or
                    tag == 'code' and key == 'data-lang'):
                continue
            _fail('unsupported_html', 'attribute')
        semantic = {key: _presence(values, key) for key in semantic_keys}
        if tag == 'ol':
            semantic['reversed'] = 'reversed' in values
        if tag in ('th', 'td'):
            for key in ('rowspan', 'colspan'):
                if key in values and values[key] != '1':
                    _fail('unsupported_html', 'table_span')
                semantic[key] = 1
        return {'global': {key: _presence(values, key) for key in _GLOBAL},
                'semantic': semantic, 'refIndex': ref_index}

    def _reject_document_redirect(self, tag, values):
        if tag == 'base' or tag == 'meta' and (values.get('http-equiv') or '').lower() == 'refresh':
            _fail('unsupported_html', 'document_redirect')

    def handle_starttag(self, tag, attrs):
        self._node()
        values = self._attrs(attrs)
        self._reject_document_redirect(tag, values)
        tags = self._tags()
        parent = tags[-1] if tags else None
        if self._is_opaque() or self._can_start_opaque(tag):
            self._opaque_start(tag, values)
            return
        if tag in _SPECIAL_CONTAINERS:
            # HTMLParser does not implement browser RCDATA/foreign/inert trees.
            # Reject rather than taking a textual fake div or href as a DOM target.
            _fail('unsupported_html', 'post_content_container')
        if tag == 'html':
            if self.stage != 0 or tags:
                _fail('invalid_html_structure', 'duplicate_document')
            self.stage = 1
        elif tag == 'head':
            if self.stage != 1 or parent != 'html':
                _fail('invalid_html_structure', 'document_order')
            self.stage = 2
        elif tag == 'body':
            if self.stage != 3 or parent != 'html':
                _fail('invalid_html_structure', 'document_order')
            self.stage = 4
        elif not tags or parent == 'html':
            _fail('invalid_html_structure', 'document_order')
        if 'title' in tags or 'h1' in tags and (tag not in _INLINE or tag in ('br', 'img', 'wbr')):
            _fail('unsupported_html', 'identity_markup')
        if self.stage == 2 and parent == 'head' and tag not in ('meta', 'link', 'title', 'style', 'script', 'noscript'):
            _fail('unsupported_html', 'tag')
        if tag in ('title', 'h1'):
            if tag == 'title' and self.stage != 2 or tag == 'h1' and self.stage != 4:
                _fail('invalid_html_structure', 'document_order')
            self.counts[tag] += 1
            if self.counts[tag] != 1:
                _fail('invalid_identity', tag + '_duplicate')
            self.identity_tag = tag
        if tag == 'link' and any(token.translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))
                                 == 'canonical' for token in _split_ws(values.get('rel') or '')):
            if self.stage != 2:
                _fail('invalid_identity', 'canonical_missing')
            self.counts['canonical'] += 1
            if self.counts['canonical'] > 1:
                _fail('invalid_identity', 'canonical_duplicate')
            url = values.get('href')
            if not url:
                _fail('invalid_identity', 'canonical_empty')
            if url != self.expected:
                _fail('canonical_mismatch', 'expected_literal')
            self.budget.reserve(_json_size(url) - 2)
            self.payload['identity']['canonical'] = url
        starts_post = 'post-content' in _split_ws(values.get('class') or '')
        if starts_post:
            if tag != 'div' or self.stage != 4:
                _fail('unsupported_html', 'post_content_container')
            self.counts['post_content'] += 1
            if self.counts['post_content'] > 1:
                _fail('invalid_identity', 'post_content_duplicate')
            self.post_depth = len(self.stack)
        in_post = self._is_post()
        if tag == 'a' and 'a' in tags:
            _fail('invalid_html_structure', 'document_order')
        if in_post:
            if tag not in _BLOCK | _INLINE:
                _fail('unsupported_html', 'tag')
            if _MATH_WRAPPERS.intersection(_split_ws(values.get('class') or '')):
                _fail('unsupported_math', 'wrapper')
            if 'p' in tags and tag in _BLOCK or 'pre' in tags and (tag not in _INLINE or tag in ('br', 'img')):
                _fail('invalid_html_structure', 'document_order')
            if parent in ('ol', 'ul') and tag != 'li' or parent == 'dl' and tag not in ('dt', 'dd'):
                _fail('invalid_html_structure', 'document_order')
            if parent == 'details' and self.stack[-1]['children'] == 0 and tag != 'summary':
                _fail('unsupported_html', 'tag')
            self._table(tag)
            self._flush()
        ref_index = None
        if self.stage == 4 and tag in ('a', 'img'):
            if self.stats['refs'] >= self.limits.max_refs:
                _fail('limit_exceeded', 'refs')
            domain = 'post_content' if in_post else 'html_body_outside_post_content'
            ref_index = self.domain_counts[domain]
            keys = ('href', 'download') if tag == 'a' else ('src', 'alt')
            ref = {'index': len(self.payload['refs']), 'domainIndex': ref_index,
                   'tag': tag, 'domain': domain,
                   'attributes': {key: _presence(values, key) for key in keys}}
            self.budget.reserve(_json_size(ref) + 1)
            self.payload['refs'].append(ref)
            self.domain_counts[domain] += 1
            self.stats['refs'] += 1
            if in_post and tag == 'img' and values.get('src'):
                self.content = True
        if in_post:
            self._event(['open', tag, self._post_attrs(tag, values, ref_index)])
            if tag in _VOID:
                self._event(['close', tag])
        if self.stack:
            self.stack[-1]['children'] += 1
        if tag not in _VOID:
            if len(self.stack) + 1 > self.limits.max_depth:
                _fail('limit_exceeded', 'depth')
            self.stack.append({'tag': tag, 'children': 0, 'rows': 0, 'phase': 0, 'mode': None})
            self.stats['maxDepth'] = max(self.stats['maxDepth'], len(self.stack))
        self.exact = any(f['tag'] in ('pre', 'code') for f in self.stack)

    def handle_startendtag(self, tag, attrs):
        if self._is_opaque() or self._can_start_opaque(tag):
            self._node()
            if tag not in _VOID and tag != 'svg' and not any(
                    f['tag'] == 'svg' and f.get('opaque') for f in self.stack):
                _fail('unsupported_html', 'nonvoid_self_close')
            values = self._attrs(attrs)
            self._reject_document_redirect(tag, values)
            self._opaque_start(tag, values, self_closing=True)
            return
        if tag not in _VOID:
            self._node()
            _fail('unsupported_html', 'nonvoid_self_close')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in _VOID or not self.stack or self.stack[-1]['tag'] != tag:
            _fail('invalid_html_structure', 'mismatched_close')
        if self._is_opaque():
            self.stack.pop()
            return
        if self._is_post():
            self._flush()
            frame = self.stack[-1]
            if tag in ('table', 'thead', 'tbody', 'tfoot', 'tr'):
                if (tag == 'table' and frame['rows'] == 0 or
                        tag != 'table' and frame['children'] == 0):
                    _fail('unsupported_html', 'empty_table_structure')
            self._event(['close', tag])
        if tag == self.identity_tag:
            self._finish_identity()
        self.stack.pop()
        if self.post_depth == len(self.stack):
            self.post_depth = None
        if tag == 'head':
            self.stage = 3
        elif tag == 'body':
            self.stage = 5
        elif tag == 'html':
            if self.stage != 5:
                _fail('invalid_html_structure', 'document_order')
            self.stage = 6
        self.exact = any(f['tag'] in ('pre', 'code') for f in self.stack)

    def handle_data(self, data):
        if not data:
            return
        self._node()
        self._text(data)
        if self._is_opaque():
            return
        tags = self._tags()
        if self.stage in (0, 1, 3, 5, 6) and data.strip(_WS):
            _fail('invalid_html_structure', 'document_order')
        if self.stage == 2 and tags[-1] == 'head' and data.strip(_WS):
            _fail('invalid_html_structure', 'document_order')
        if self.identity_tag:
            self._add_identity(data)
        if self._is_post():
            parent = tags[-1]
            structural = parent in ('table', 'thead', 'tbody', 'tfoot', 'tr', 'ol', 'ul', 'dl')
            if (structural or parent == 'details' and self.stack[-1]['children'] == 0) and data.strip(_WS):
                _fail('invalid_html_structure', 'table_structure' if 'table' in tags else 'document_order')
            if data.strip(_WS):
                self.content = True
            self._add_run(data)

    def handle_comment(self, data):
        self._node()
        self._text(data)
        if self.parts:
            self.boundaries.append(self.run_chars)

    def handle_decl(self, decl):
        self._node()
        if self.doctype or self.stage != 0 or decl.lower() != 'doctype html':
            _fail('unsupported_html', 'doctype')
        self.doctype = True

    def unknown_decl(self, data):
        self._node()
        _fail('unsupported_html', 'doctype')

    def handle_pi(self, data):
        self._node()
        _fail('unsupported_html', 'processing_instruction')

    def finish(self):
        self.close()
        if self.stack or self.stage != 6:
            _fail('invalid_html_structure', 'unclosed')
        for key in ('title', 'h1', 'canonical', 'post_content'):
            if self.counts[key] != 1:
                _fail('invalid_identity', key + '_missing')
        if not self.content:
            _fail('invalid_html_structure', 'empty_post_content')
        assert self.pending_space is None
        # Indices originate solely from counters, never externally supplied JSON.
        counts = {'post_content': 0, 'html_body_outside_post_content': 0}
        for index, ref in enumerate(self.payload['refs']):
            assert type(ref['index']) is int and ref['index'] == index
            domain = ref['domain']
            assert type(ref['domainIndex']) is int and ref['domainIndex'] == counts[domain]
            counts[domain] += 1
        self.result['payloadSha256'] = _hash_json({key: self.result[key]
                                                 for key in ('contract', 'version', 'payload')})
        for _ in range(8):
            size = _json_size(self.result)
            if size > self.limits.max_output_bytes:
                _fail('limit_exceeded', 'output_bytes')
            if size == self.stats['outputBytes']:
                break
            self.stats['outputBytes'] = size
        else:
            raise AssertionError('JSON size fixed point did not converge')
        return self.result


def _project_daily_html(html_bytes, expected_canonical, limits, version):
    if type(html_bytes) is not bytes:
        _fail('invalid_argument', 'input_type')
    if type(expected_canonical) is not str:
        _fail('invalid_argument', 'canonical_type')
    if type(limits) is not ProjectionLimits:
        _fail('invalid_argument', 'limits_type')
    for field in fields(ProjectionLimits):
        value = getattr(limits, field.name)
        if type(value) is not int or not 1 <= value <= getattr(DEFAULT_LIMITS, field.name):
            _fail('invalid_argument', 'limits_field')
    if len(html_bytes) > limits.max_html_bytes:
        _fail('limit_exceeded', 'html_bytes')
    try:
        if not expected_canonical or _measure(expected_canonical) > 8192 or any(c in _WS for c in expected_canonical):
            _fail('invalid_argument', 'canonical_syntax')
        parsed = urlsplit(expected_canonical)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or
                parsed.password is not None or parsed.fragment):
            _fail('invalid_argument', 'canonical_syntax')
        parsed.port
    except (ValueError, ProjectionError):
        _fail('invalid_argument', 'canonical_syntax')
    try:
        text = html_bytes.decode('utf-8', 'strict')
    except UnicodeError:
        _fail('invalid_utf8', 'decode')
    if text.startswith('\ufeff'):
        _fail('invalid_html_structure', 'control_character')
    _measure(text)
    parser = _Projection(html_bytes, expected_canonical, limits, version)
    try:
        parser.feed(text)
        return parser.finish()
    except ProjectionError as exc:
        if exc.line is None:
            exc.line, exc.column = parser.getpos()
        raise


def project_daily_html(html_bytes, *, expected_canonical, limits=DEFAULT_LIMITS):
    """Retain the fixed v1 no-whitespace surface; results convey no qualification."""
    return _project_daily_html(html_bytes, expected_canonical, limits, 1)


def project_daily_html_v2(html_bytes, *, expected_canonical, limits=DEFAULT_LIMITS):
    """Fixed v2 exact literals with isolated internal spaces, never TeX normalization."""
    return _project_daily_html(html_bytes, expected_canonical, limits, 2)

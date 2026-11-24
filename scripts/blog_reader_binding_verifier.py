#!/usr/bin/env python3
"""API Reader 数值/单位/引文投影、图表/SVG/PDF 资产解析、DOM/PDF 表格绑定与页面绑定核验。"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import contextvars
import copy
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import unicodedata
import weakref
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

import protocol_codec as public_protocols  # noqa: E402
import reader_record_format as reader_formats  # noqa: E402
from analysis_sections import find_evaluation_headings  # noqa: E402
from daily_source_format import is_daily_source_run, is_fresh_source_provenance  # noqa: E402
from project_env import build_child_process_env  # noqa: E402
from publish_common import (  # noqa: E402
    PublishDataValidationError,
    decode_publish_currency_unit_display,
    is_publication_technical_asterisk_cell_view,
    is_publish_currency_unit_literal,
    normalize_publish_arxiv_id,
    parse_markdown_images,
    sanitize_markdown_for_publish,
    strict_source_cell_math_display,
)
from utils import parse_analysis  # noqa: E402

_ACTIVE_HOOKS: contextvars.ContextVar[Mapping | None] = contextvars.ContextVar(
    'blog_reader_binding_verifier_hooks', default=None,
)


@contextmanager
def _hooks_scope(hooks: Mapping | None):
    if hooks is None:
        yield
        return
    token = _ACTIVE_HOOKS.set(hooks)
    try:
        yield
    finally:
        _ACTIVE_HOOKS.reset(token)


class _HookAccessor:
    def __getattr__(self, name: str):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        if name in globals():
            return globals()[name]
        raise RuntimeError(f'blog_reader_binding_verifier 缺少必需运行钩子: {name}')

    def get(self, name: str, default=None):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        return globals().get(name, default)


_H = _HookAccessor()


def _normalize_api_reader_numeric_token(raw):
    """规范化读者文章和来源引文中的数字，便于比较。

    这里处理千分位、空白、大小写和多余尾零，并对年份及秒数采用与
    Node 端对应的约定。数字输出沿用 Python 现有的浮点格式，
    不保证任意输入都与 JavaScript 得到逐字相同的结果。
    """
    # NFKC 不映射数学减号 U+2212 与全角连字符 U+FF0D，显式归一（与 Node 一致）。
    normalized_text = unicodedata.normalize('NFKC', str(raw or '')).replace('−', '-').replace('－', '-')
    token = normalized_text
    previous = None

    while token != previous:
        previous = token
        token = re.sub(r'(\d),(\d{3})(?!\d)', r'\1\2', token)
    token = re.sub(r'\s+', '', token).lower()
    match = re.match(r'^([-+]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$', token, flags=re.DOTALL)
    if not match:
        return token
    try:
        number = float(match.group(1))
    except ValueError:
        return token
    if not (number == number and abs(number) != float('inf')):
        return token
    suffix = match.group(2) or ''
    if re.fullmatch(r'\d{4}s', normalized_text.strip(), flags=re.IGNORECASE) \
            and re.fullmatch(r'\d{4}', match.group(1)) \
            and 1000 <= int(match.group(1)) <= 2999 and suffix == 's':
        suffix = ''
    if suffix in {'second', 'seconds'}:
        suffix = 's'
    number_text = str(int(number)) if float(number).is_integer() else str(number)
    return f'{number_text}{suffix}'


def _reader_adjacent_metric_unit_evidence(quote, metric, value, unit, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        def surface(text):
            return re.sub(r'\s+', ' ', re.sub(r'[`*_↑↓]', '', unicodedata.normalize('NFKC', str(text or '')).lower())).strip()
        name = r'\s+'.join(re.escape(part) for part in surface(metric).split())
        if not name:
            return False
        quantity = re.escape(value) + r'\s*' + re.escape(unit)
        adjacent = re.compile(r'(?<![a-z0-9_.+−－–—/\-])(?:' + quantity + r'\s+' + name
            + '|' + name + r'(?![a-z0-9_])\s*(?:(?:is|was|为|是|=|:)\s*)?' + quantity + r')(?![a-z0-9_%])', re.I)
        for clause in re.split(r'(?<!\d)[.!?;。！？；\n]|[.!?](?!\d)|[,，]', unicodedata.normalize('NFKC', str(quote or ''))):
            text = surface(clause)
            if re.search(r'\b(?:not|no|never|unavailable|unknown|missing)\b|未报告|未提供|不可得|未知|没有|并非|不是|未达到|不等于|不超过', text):
                continue
            if adjacent.search(text):
                return True
        return False


def _reader_table_header_unit_evidence_failures(table, quotes, *, hooks: Mapping | None = None):
    # 列头的单位同样改变数字含义，不能只凭同一个裸数值认可百分数或时长。
    with _hooks_scope(hooks):
        def surface(value):
            text = unicodedata.normalize('NFKC', str(value or '')).lower()
            return re.sub(r'\s+', ' ', re.sub(r'[`*_↑↓]', '', text)).strip()
        failures = []
        unit_pattern = r'%|db|ms|s|h|hz|khz|mhz|gb|mb|kb|pp'
        for column, original_header in enumerate(table.get('header', [])):
            header = surface(original_header)
            match = re.fullmatch(rf'(.*?)(?:\(\s*({unit_pattern})\s*\)|\[\s*({unit_pattern})\s*\]|\s+({unit_pattern}))', header)
            if not match:
                continue
            quantity_condition = re.search(r'(?:^|\s)[-+−－]?\d+(?:\.\d+)?\s*$', match.group(1))
            if quantity_condition and (match.group(4)
                    or re.search(r'(?:^|\s)[-+−－]\d+(?:\.\d+)?\s*$', match.group(1))):
                continue
            unit = next(value for value in match.groups()[1:] if value)
            metric = match.group(1).strip()
            declaration = re.escape(re.sub(r'\s*([([])', r' \1', header)).replace(r'\ ', r'\s*')
            declared_unit = re.compile(rf'(?<![a-z0-9_])' + declaration + r'(?![a-z0-9_])')
            for row, cells in enumerate(table.get('rows', [])):
                for token in _H._api_reader_numeric_tokens(cells[column] if column < len(cells) else ''):
                    number = re.fullmatch(r'([-+]?\d+(?:\.\d+)?)([a-z%]*)', token, re.I)
                    if not number:
                        continue
                    consistent = not number.group(2) or number.group(2).lower() == unit
                    def directly_declared(quote):
                        for sentence in re.split(r'(?<!\d)[.!?;。！？；\n]|[.!?](?!\d)', unicodedata.normalize('NFKC', quote)):
                            text = surface(sentence)
                            for declared in declared_unit.finditer(text):
                                clause = re.split(r'\b(?:and|while|but|whereas)\b|[,，]', text[declared.end():])[0]
                                if re.search(r'\b(?:not|no|never|unavailable|unknown|missing)\b|未报告|未提供|不可得|未知|没有', clause):
                                    continue
                                if (_H._api_reader_numeric_tokens(clause) or [None])[0] == token:
                                    return True
                        return False
                    covered = consistent and (bool(number.group(2)) or any(_H._reader_adjacent_metric_unit_evidence(quote, metric, number.group(1), unit) for quote in quotes) or (metric and any(directly_declared(quote) for quote in quotes)))
                    if not covered:
                        failures.append((row + 1, column, token, unit))
        return failures


class _ReaderScientificPdfQuoteCapability:
    __slots__ = ('__weakref__',)


_READER_SCIENTIFIC_PDF_QUOTES = weakref.WeakKeyDictionary()


def _reader_verified_scientific_pdf_quotes(capability, source_binding, quote_corpus, *, hooks: Mapping | None = None):
    # A JSON proof, a quotation string or a boolean cannot issue this capability.
    with _hooks_scope(hooks):
        bound = _H._READER_SCIENTIFIC_PDF_QUOTES.get(capability) if type(capability) is _H._ReaderScientificPdfQuoteCapability else None
        if bound is None or source_binding is not bound['binding'] \
                or _H._stable_json_sha256(source_binding) != bound['bindingSha256'] \
                or _H._javascript_string_sha256(bound['paper'].get('apiReaderArticle', '')) != bound['articleSha256'] \
                or _H._daily_fresh_normalized_paper_id(bound['paper']) != bound['paperId'] \
                or bound['paper'].get('freshRewriteProvenance') != bound['provenance'] \
                or _H._stable_json_sha256(bound['paper'].get('analysisManifest', {}).get('sourceAcquisition')) != bound['sourceAcquisitionSha256']:
            raise _H.PublishDataValidationError('科学计数量缺少本次真实 PDF 与原表绑定能力。')
        _H._daily_fresh_validate_bundle(bound['runDir'], bound['paperId'], bound['provenance'], bound['paper'])
        actual_pdf = _H._daily_fresh_read_private_file(bound['pdfFile'], '科学计数量来源 PDF', 64 * 1024 * 1024)
        if actual_pdf != bound['pdfBytes']:
            raise _H.PublishDataValidationError('科学计数量来源 PDF 在同次核验中变化。')
        from reader_pdf_quote_projection import (extract_pdf_scientific_quantities, saved_header, current_header,
                                                 QUOTE, SCIENTIFIC, SCHEDULE)
        header = saved_header(bound['document'], QUOTE)
        current = public_protocols.is_current_header(header, QUOTE)
        result = extract_pdf_scientific_quantities(actual_pdf, [proof['quote'] for proof in bound['proofs']], header)
        scientific_header = current_header(SCIENTIFIC) if current else public_protocols.historical_header(
            SCIENTIFIC, 'font-and-position-authenticated-atoms')
        schedule = current_header(SCHEDULE) if current else public_protocols.historical_contract(
            SCHEDULE, 'complete-three-stage-learning-rates')
        if saved_header(result, SCIENTIFIC) != scientific_header \
                or result.get('document') != bound['document'] or len(result.get('results', [])) != len(bound['proofs']):
            raise _H.PublishDataValidationError('科学计数量提取未保留原 PDF 引文来源。')
        atoms = {}
        for original, response in zip(bound['proofs'], result['results']):
            if response.get('eligible') is not True or response.get('evidence') != original:
                raise _H.PublishDataValidationError('科学计数量未重放完整原始 PDF 引文。')
            if original['quote'] not in quote_corpus:
                raise _H.PublishDataValidationError('科学计数量来源引文不属于本表。')
            quantities = response.get('scientificQuantities', [])
            if quantities and response.get('family') != schedule:
                raise _H.PublishDataValidationError('科学计数量不属于获准的完整 AdamW 三阶段句。')
            for atom in quantities:
                role = atom.get('role')
                if role not in ('SFT', 'RL-Stage I', 'RL-Stage II') or atom.get('unit') != '' or role in atoms:
                    raise _H.PublishDataValidationError('科学计数量不属于唯一完整三阶段学习率。')
                if not isinstance(atom.get('coefficient'), str) or not re.fullmatch(r'[+−-]?[0-9]+(?:\.[0-9]+)?', atom['coefficient']) \
                        or not isinstance(atom.get('signedExponent'), str) or not re.fullmatch(r'[+-][0-9]+', atom['signedExponent']):
                    raise _H.PublishDataValidationError('科学计数量系数或带符号指数不完整。')
                atoms[role] = {**atom, 'quoteIndex': quote_corpus.index(original['quote']), 'origin': 'verified_pdf_glyph'}
        if _H._daily_fresh_read_private_file(bound['pdfFile'], '科学计数量来源 PDF', 64 * 1024 * 1024) != actual_pdf:
            raise _H.PublishDataValidationError('科学计数量来源 PDF 在提取后变化。')
        _H._daily_fresh_validate_bundle(bound['runDir'], bound['paperId'], bound['provenance'], bound['paper'])
        return atoms if set(atoms) == {'SFT', 'RL-Stage I', 'RL-Stage II'} else {}


def _api_reader_scientific_quote_projection(rendered, quote_corpus, *, scientific_pdf_capability=None, source_binding=None, hooks: Mapping | None = None):
    """Ephemeral whole-cell coverage only; never changes text, tokens or provenance.

    A complete signed coefficient/exponent/unit must occur in one bound quote
    line. An explicit LaTeXML visible+TeX pair grants nothing unless both copies
    have the same coefficient and signed exponent. Unrelated scalar digits or
    quantities cannot support a missing complete atom.
    """
    with _hooks_scope(hooks):
        old_tokens = set(_H._api_reader_numeric_tokens(rendered['markdown']))
        cells = [(0, column, str(value)) for column, value in enumerate(rendered['header'])]
        cells.extend((row + 1, column, str(value)) for row, values in enumerate(rendered['rows'])
                     for column, value in enumerate(values))
        marker = re.compile(r'(?:×|\\times|\{\\times\})\s*10(?!\d)')
        if not any(marker.search(value) or marker.search(unicodedata.normalize('NFKC', value)) for _, _, value in cells):
            return {'tokens': old_tokens, 'failures': [], 'proofs': []}
        # Preserve the existing whole-Markdown lexical meaning. Only equivalent
        # cell boundaries can be projected; cross-cell token changes fail closed.
        cell_tokens = {token for _, _, value in cells for token in _H._api_reader_numeric_tokens(value)}
        if cell_tokens != old_tokens:
            return {'tokens': old_tokens, 'failures': [{'reason': 'scientific_cell_lexical_boundaries_differ'}], 'proofs': []}
        coefficient = r'[+−-]?[0-9]+(?:\.[0-9]+)?'
        signed_exponent = r'[+−-]?[0-9]+'
        superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹'
        superscript_digits = str.maketrans(superscripts, '0123456789')
        unit = r'(?:kHz|MHz|Hz|dB|GB|MB|KB|ms|pp|s|h|%)'
        # No implicit powers, Unicode digit normalization, arbitrary TeX decoding,
        # unit conversion, precision rounding or coefficient/exponent recombination.
        atom = (r'(?P<coefficient>' + coefficient + r')\s*(?:'
                r'×10(?P<sup>[⁺⁻]?[' + superscripts + r']+)'
                r'|(?:\\times|\{\\times\}|×)\s*10\^\{(?P<tex>' + signed_exponent + r')\}'
                r'|(?:\\times|\{\\times\}|×)\s*10(?P<plain>[+−-][0-9]+))'
                r'(?P<unit>\s*' + unit + r')?')
        line_atom = re.compile(r'\s*' + atom + r'\s*')
        # Exact positive/negative coefficients must repeat literally in the two
        # source copies. Their exponent signs and digits are checked separately.
        dual = re.compile(r'\s*(?P<coefficient>' + coefficient + r')×10'
                          r'(?P<visible_sign>[+−-]?)(?P<visible_exponent>[0-9]+)'
                          r'(?P=coefficient)(?:\\times|\{\\times\})\s*10\^\{'
                          r'(?P<tex_sign>[+−-]?)(?P<tex_exponent>[0-9]+)\}'
                          r'(?P<unit>\s*' + unit + r')?\s*')
        def exponent_key(value):
            value = value.replace('−', '-').replace('⁻', '-').replace('⁺', '+').translate(superscript_digits)
            return ('-' if value.startswith('-') else '+') + value.lstrip('+-')

        def quantity_key(match, exponent):
            return (match['coefficient'].replace('−', '-').lstrip('+'), exponent_key(exponent),
                    (match['unit'] or '').strip().lower())

        source_atoms = {}
        for quote_index, quote in enumerate(quote_corpus):
            if not isinstance(quote, str):
                continue
            # No atom can span lines or quote objects. A partial pair never falls
            # through to its valid-looking TeX suffix.
            for line_index, line in enumerate(re.split(r'\r?\n', quote)):
                duplicate = dual.fullmatch(line)
                if duplicate:
                    if exponent_key((duplicate['visible_sign'] or '+') + duplicate['visible_exponent']) != exponent_key((duplicate['tex_sign'] or '+') + duplicate['tex_exponent']):
                        continue
                    key = quantity_key(duplicate, (duplicate['tex_sign'] or '+') + duplicate['tex_exponent'])
                else:
                    single = line_atom.fullmatch(line)
                    if not single:
                        # HTML/LaTeXML often prints a coefficient-one quantity as a
                        # bare 10^-4. It is the same complete atom as 1×10^-4, not
                        # a licence to borrow another coefficient. Only scan this
                        # line when it has no explicit coefficient atom.
                        if re.search(r'\d+(?:\.\d+)?\s*(?:×|\\times|\{\\times\})\s*10', line):
                            continue
                        bare = re.compile(r'(?<![A-Za-z0-9_])10([+−-][0-9]+)(?:\s*(kHz|MHz|Hz|dB|GB|MB|KB|ms|pp|s|h|%))?(?![A-Za-z0-9_])')
                        for match in bare.finditer(line):
                            bare_key = ('1', exponent_key(match.group(1)), (match.group(2) or '').strip().lower())
                            source_atoms.setdefault(bare_key, (quote_index, line_index))
                        continue
                    key = quantity_key(single, single['sup'] or single['tex'] or single['plain'])
                source_atoms.setdefault(key, (quote_index, line_index))

        glyph_schedule = {}
        roles = ('SFT', 'RL-Stage I', 'RL-Stage II')
        schedule_profile = (rendered['header'] == ['阶段', '学习率', '采样与复用', '组与奖励']
            and len(rendered['rows']) == 3 and all(len(values) == 4 for values in rendered['rows'])
            and [values[0] for values in rendered['rows']] == list(roles))
        # Other tables keep the old projection and do not trigger new PDF work.
        if scientific_pdf_capability is not None and schedule_profile:
            atoms = _H._reader_verified_scientific_pdf_quotes(scientific_pdf_capability, source_binding, quote_corpus)
            if set(atoms) == set(roles):
                baseline = re.compile(r'\s*(?P<coefficient>' + coefficient + r')\s*×\s*10(?P<base>[+−-][0-9]+)(?P<unit>\s*' + unit + r')?\s*')
                admitted = {}
                for row, role in enumerate(roles, 1):
                    value = str(rendered['rows'][row - 1][1])
                    parsed = line_atom.fullmatch(value.strip()) or baseline.fullmatch(value.strip())
                    if parsed is None:
                        break
                    exponent = parsed.groupdict().get('sup') or parsed.groupdict().get('tex') or parsed.groupdict().get('plain') or parsed.groupdict().get('base')
                    atom = atoms[role]
                    source_key = (atom['coefficient'].replace('−', '-').lstrip('+'), exponent_key(atom['signedExponent']), atom['unit'])
                    if quantity_key(parsed, exponent) != source_key:
                        break
                    admitted[(row, 1)] = atom
                if len(admitted) == 3:
                    glyph_schedule = admitted

        failures, proofs, tokens = [], [], set()
        for row, column, value in cells:
            if not (marker.search(value) or marker.search(unicodedata.normalize('NFKC', value))):
                tokens.update(_H._api_reader_numeric_tokens(value))
                continue
            # Publication currently needs whole-cell quantities only. Requiring a
            # complete cell prevents unknown/composite units, prose, model labels,
            # footnotes, or additional scalars from being mistaken for a unitless
            # prefix. No substring or fallback atom can grant coverage.
            stripped = value.strip()
            if (row, column) in glyph_schedule:
                atom = glyph_schedule[(row, column)]
                proofs.append({'row': row, 'column': column, 'start': len(value) - len(value.lstrip()),
                    'end': len(value.rstrip()), 'coefficient': atom['coefficient'], 'signedExponent': atom['signedExponent'],
                    'unit': '', 'quoteIndex': atom['quoteIndex'], 'origin': atom['origin'], 'role': atom['role'],
                    'pdfGlyphEvidence': atom})
                continue  # Only the three complete role-bound LR cells gain new coverage.
            match = line_atom.fullmatch(stripped)
            if not match:
                failures.append({'row': row, 'column': column, 'value': value,
                                 'reason': 'scientific_quantity_not_complete_or_supported'})
                tokens.update(_H._api_reader_numeric_tokens(value))
                continue
            key = quantity_key(match, match['sup'] or match['tex'] or match['plain'])
            if key not in source_atoms:
                failures.append({'row': row, 'column': column, 'value': value,
                                 'reason': 'scientific_quantity_missing_exact_bound_quote'})
                tokens.update(_H._api_reader_numeric_tokens(value))
                continue
            start = len(value) - len(value.lstrip())
            end = start + len(stripped)
            quote_index, line_index = source_atoms[key]
            proofs.append({'row': row, 'column': column, 'start': start, 'end': end,
                           'coefficient': key[0], 'signedExponent': key[1], 'unit': key[2],
                           'quoteIndex': quote_index, 'lineIndex': line_index})
            # Replace only the authenticated quantity range; other cells retain
            # every legacy numeric token. Actual input text is never modified.
            projected = value[:start] + ' ' * (end - start) + value[end:]
            tokens.update(_H._api_reader_numeric_tokens(projected))
        return {'tokens': tokens, 'failures': failures, 'proofs': proofs}


def _api_reader_numeric_tokens(value, *, hooks: Mapping | None = None):
    # 千位分组分支必须吃掉逗号之后的整段数字。
    # 否则 ``10^-4,2000`` 会被截成一个凭空造出的词元
    # ``-4,200`` / ``-4200``，而不是正确解析出 ``-4`` 和 ``2000``。
    with _hooks_scope(hooks):
        grouped_integer = r'(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)'
        pattern = re.compile(
            # 损坏的小数表面整体保留，不能截成部分数字或猜测半值。
            rf'(?<![A-Za-z0-9])(?:(?:\+(\d*\.\d+)\+\1|[-−－](\d*\.\d+)[-−－]\2|[-+−－]?(\d*\.\d+)\3)(?!\d|\.\d)|[-+−－]?(?:{grouped_integer}(?:\.\d+)?|\.\d+))'
            r'(?:\s*%|\s*(?:seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)(?![A-Za-z0-9_]))?',
            flags=re.IGNORECASE,
        )
        # 和 Node 一样，只处理明确支持的 LaTeXML 具名颜色写法，不改引号、
        # 数字符号、单位，也不动普通标识符的边界。
        original_surface = str(value or '')

        def mask_color(match):
            # 命令之外的符号不能变成一个脱落的正值
            # （也不能露出小数尾巴）。这种有歧义的形式不进索引。
            if re.search(r'[-+－−]\s*$', original_surface[:match.start()]):
                return ' ' * len(match.group(0))
            return ' ' * len(match.group(1)) + match.group(2)

        numeric_surface = re.sub(
            r'(\\textcolor(?:black|blue|brown|cyan|darkgray|gray|green|lightgray|lime|magenta|olive|orange|pink|purple|red|teal|violet|white|yellow))([-+－−]?[0-9０-９][0-9.０-９．]*)',
            mask_color, original_surface,
        )
        # Mirror the Reader's exact LaTeXML duplicate-operator boundary. Keep the
        # original scalar, precision, units and offsets; do not decode other TeX.
        numeric_surface = re.sub(
            r'±\\pm(?=(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?![A-Za-z0-9_.]))',
            lambda match: ' ' * len(match.group(0)), numeric_surface,
        )
        tokens = []
        for match in pattern.finditer(unicodedata.normalize('NFKC', numeric_surface)):
            normalized_numeric_token = _H._normalize_api_reader_numeric_token(match.group(0))
            tokens.append(normalized_numeric_token)
        # 和 Node 的 LaTeXML 统计别名完全一致。HTML 文本提取器可能
        # 把一个显示出来的千位分组值连同它的 TeX 注解扁平化成
        # `4,852\mu=4{,}852 ms`。只有跨过这道确切桥梁、且数字写法完全相同的情况
        # 才继承尾部的单位；数值、符号、精度、
        # 桥梁或单位任一不同，都不产生别名。这个判断只在
        # 已经受 SHA 约束的 sourceQuote 字节内进行，绝不靠模糊全文搜索。
        tex_statistic = re.compile(
            r'(?<![A-Za-z0-9])'
            r'([+\-−－]?(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)(?:[.．][0-9０-９]+)?)'
            r'\\mu\s*=\s*'
            r'([+\-−－]?[0-9０-９{}.,，．]+)\s*'
            r'(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp|[%％])'
            r'(?![A-Za-z0-9_])',
            flags=re.IGNORECASE,
        )

        def exact_number(raw):
            surface = unicodedata.normalize('NFKC', str(raw or '')) \
                .replace('−', '-').replace('－', '-')
            if not re.fullmatch(
                    r'[+\-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?', surface):
                return None
            return surface

        for match in tex_statistic.finditer(original_surface):
            left = exact_number(match.group(1))
            right = exact_number(match.group(2).replace('{', '').replace('}', ''))
            if not left or left != right:
                continue
            alias = _H._normalize_api_reader_numeric_token(
                f'{match.group(1)} {match.group(3)}'
            )
            tokens.append(alias)
        # 照搬 Node 明确的「可见测量值 + TeX 注解」别名规则。
        # 在受 SHA 约束的引文里，两侧的数字和解码后的单位都必须一致。
        number_surface = r'[+\-−－]?(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)(?:[.．][0-9０-９]+)?'
        tex_measurement = re.compile(
            rf'(?<![A-Za-z0-9])({number_surface})\s*'
            rf'(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)({number_surface})'
            r'(?:\s|\\text\{\\[,;!]\}|\\[,;!])*'
            r'((?:\\(?:mathrm|textrm|text)\{[A-Za-z]+\}){1,8})'
            r'(?![A-Za-z0-9_]|\\(?:mathrm|textrm|text)\{[A-Za-z])',
            flags=re.IGNORECASE,
        )
        for match in tex_measurement.finditer(original_surface):
            left = exact_number(match.group(1))
            right = exact_number(match.group(3))
            tex_unit = ''.join(re.findall(
                r'\\(?:mathrm|textrm|text)\{([A-Za-z]+)\}', match.group(4)))
            if left and left == right and tex_unit.lower() == match.group(2).lower():
                tokens.append(_H._normalize_api_reader_numeric_token(
                    f'{match.group(1)} {match.group(2)}'))
        return tokens


_READER_CITATION_GROUP = re.compile(r'\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]')


_READER_CIRCLED_LABEL = re.compile(r'[\u2460-\u2473]')


def _reader_circled_label_numeric_tokens(table, *, hooks: Mapping | None = None):
    """①②③ 这类带圈序号是行标签，不是测量值。

    NFKC 会把 ① 归一成数字 1，于是行标签被当成「表里出现过数字 1」要求引文证据。
    只有同一数字在别处以普通数字出现时才仍按测量值处理。
    """
    with _hooks_scope(hooks):
        texts = [str(value or '') for value in table.get('header') or []]
        for row in table.get('rows') or []:
            texts.extend(str(value or '') for value in row)
        labels, plain = set(), set()
        for text in texts:
            for match in _READER_CIRCLED_LABEL.finditer(text):
                labels.update(_H._api_reader_numeric_tokens(match.group(0)))
            plain.update(_H._api_reader_numeric_tokens(_READER_CIRCLED_LABEL.sub(' ', text)))
        return labels - plain


def _reader_citation_only_numeric_tokens(table, *, hooks: Mapping | None = None):
    """表格方法名里的 [37]、[12, 37] 是参考文献编号，不是测量值。

    只有同一数字在方括号之外也以数值形式出现时，才仍按测量值要求原文引文；
    方括号里的编号本身仍由单元格的 DOM/SHA 证据绑定。
    """
    with _hooks_scope(hooks):
        texts = [str(value or '') for value in table.get('header') or []]
        for row in table.get('rows') or []:
            texts.extend(str(value or '') for value in row)
        outside = set()
        citations = set()
        for text in texts:
            outside.update(_H._api_reader_numeric_tokens(
                _READER_CITATION_GROUP.sub(' ', text)
            ))
            for group in _READER_CITATION_GROUP.findall(text):
                citations.update(_H._api_reader_numeric_tokens(group))
        return citations - outside


def _reader_source_payload_artifacts(payload, structured_sha, source_sha, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        if (not isinstance(payload, str)
                or _H._javascript_string_sha256(payload) != structured_sha
                or not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or ''))):
            return None
        try:
            artifacts = json.loads(payload)
        except (ValueError, TypeError):
            return None
        return artifacts if (isinstance(artifacts, dict)
                             and artifacts.get('flattenedTextSha256') == source_sha) else None


def _reader_formula_source_eligible(formula, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        latex = str(formula.get('latex') or '').strip()
        if formula.get('recoveryStatus') != 'complete' or not latex or re.search(r'=\s*[-+−]?\s*$', latex):
            return False
        if re.search(r'\(\s*$', latex):
            return False
        inline_math = re.search(r"<math\b[^>]*\bdisplay\s*=\s*[\"']inline[\"']", str(formula.get('mathml') or ''), re.I)
        text_has_relation = re.search(r'[=≤≥≠≈∝↦→]', str(formula.get('text') or ''))
        latex_has_relation = re.search(r'[=<>≤≥≠≈∝↦→]|\\(?:leq?|geq?|neq?|approx|sim|propto|mapsto|to)(?![A-Za-z])', latex)
        return not (inline_math and text_has_relation and not latex_has_relation)


def _validate_reader_formula_source(binding, plan, structured_sha, source_sha, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        artifacts = _H._reader_source_payload_artifacts(plan.get('structuredSourcePayload'), structured_sha, source_sha)
        if artifacts is None or not isinstance(artifacts.get('formulas'), list):
            raise _H.PublishDataValidationError('展示公式缺少与既有来源 SHA 对应的完整结构化内容；请通过正常长文恢复入口重建。')
        formulas = [formula for formula in artifacts['formulas'] if isinstance(formula, dict)
                    and type(formula.get('ordinal')) is int
                    and formula['ordinal'] == binding['formulaOrdinal']]
        if (len(formulas) != 1 or not _H._reader_formula_source_eligible(formulas[0])
                or formulas[0].get('sourceDomSha256') != binding['sourceDomSha256']
                or not isinstance(formulas[0].get('latex'), str)
                or formulas[0]['latex'].strip() != binding['latex'].strip()):
            raise _H.PublishDataValidationError('展示公式与完整原始 TeX、公式位置或 DOM SHA 不一致；不能接受片段或猜补结果。')


_LEGACY_READER_FIGURE_CAPTIONS = {'method.png': 'Figure 1: Overview of the study.', 'overview.png': 'Figure 2: Controlled procedural source and pre-training pipeline. FormulaBank separates formula-class coverage C from rendering diversity I, with N(C,I)=C\\times I clips.'}


_LEGACY_READER_PIXEL_NARRATIVES = ['官方 HTML 将此资源标为 Figure 3，图注称七种声音在语音或停顿中的放置比例相近；但绑定 URL 的实际像素对应 Figure 4，左侧显示四个语料上表示漂移比与任务损伤比随信噪比变化，右侧显示停顿位移后的语音帧漂移随距离衰减。图注与像素错配，本段按绑定图像说明，不把原图注当成图像事实。', '绑定图像：四个语料的表示漂移比与任务损伤比随信噪比变化；右侧为停顿位移后的语音帧漂移随距离衰减。原 HTML 图注与像素错配。']


def _reader_inline_svg_resource(paper, plan, figure, structured_sha, source_sha, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        from reader_inline_svg import source_descriptor
        artifacts = _H._reader_source_payload_artifacts(plan.get('structuredSourcePayload'), structured_sha, source_sha)
        if not artifacts or not isinstance(artifacts.get('figures'), list):
            raise _H.PublishDataValidationError('内联论文图缺少已绑定的原始结构化来源。')
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        matches = []
        for source in artifacts['figures']:
            if (not isinstance(source, dict) or source.get('recoveryStatus') != 'complete'
                    or source.get('ordinal') != figure.get('ordinal')
                    or source.get('sourceDomSha256') != figure.get('sourceDomSha256')):
                continue
            images = source.get('images')
            if not isinstance(images, list) or len(images) != 1:
                continue
            try:
                descriptor = source_descriptor(images[0], paper_id)
            except ValueError:
                continue
            if (descriptor['url'] == figure.get('url')
                    and figure.get('sourceLocationUrl') == descriptor['url']
                    and all(descriptor[key] == figure.get(key) for key in
                            ('inlineSvgSourceSha256', 'inlineSvgRenderContract'))
                    and re.sub(r'\s+', ' ', source.get('label') or f"Figure {source['ordinal']}").strip() == figure.get('label')
                    and re.sub(r'\s+', ' ', source.get('caption') or '').strip()[:1200] == figure.get('caption')):
                matches.append(images[0])
        if len(matches) != 1:
            raise _H.PublishDataValidationError('内联论文图与原始 SVG、DOM、图注或来源位置不一致。')
        return matches[0]


def _publication_raster_recovery_input(*, hooks: Mapping | None = None):
    """An explicit process input, independently reread by all publication stages."""
    with _hooks_scope(hooks):
        filename = os.environ.get('PD_PUBLISH_RASTER_RECOVERY_FILE', '')
        if not filename:
            return None
        from reader_damaged_raster_pdf_asset import MANIFEST_CONTRACT
        file = Path(filename)
        if not file.is_absolute() or file != file.resolve():
            raise _H.PublishDataValidationError('坏 PNG 出版恢复清单须为绝对运行路径。')
        root = Path(_H.CURRENT_DIR).parent / 'runtime'
        try:
            file.resolve().relative_to(root.resolve())
        except ValueError as exc:
            raise _H.PublishDataValidationError('坏 PNG 出版恢复清单须在本项目运行目录。') from exc
        raw = _H._daily_fresh_read_private_file(file, '坏 PNG 出版恢复清单', 4 * 1024 * 1024)
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != {'contract', 'runId', 'batchDate', 'authorization', 'targets'}
                or value['contract'] != MANIFEST_CONTRACT
                or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', str(value['runId']))
                or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(value['batchDate']))
                or not isinstance(value['authorization'], str) or not value['authorization'].strip()
                or not isinstance(value['targets'], list) or len(value['targets']) != 1):
            raise _H.PublishDataValidationError('坏 PNG 出版恢复仅接受显式完整身份的单一目标。')
        target = value['targets'][0]
        keys = {'paperId', 'figureOrdinal', 'sourceUrl', 'sourceDomSha256', 'printedFigureNumber',
                'caption', 'captionSha256', 'readerArticleSha256', 'readerPlanSha256', 'readerFiguresSha256',
                'originalReaderPixelSha256', 'sourceFiles', 'damageReceipt'}
        if (not isinstance(target, dict) or set(target) != keys
                or not re.fullmatch(r'\d{4}\.\d{4,5}', str(target['paperId']))
                or type(target['figureOrdinal']) is not int or target['figureOrdinal'] < 1
                or type(target['printedFigureNumber']) is not int or target['printedFigureNumber'] < 1
                or not isinstance(target['sourceUrl'], str)
                or any(not re.fullmatch(r'[a-f0-9]{64}', str(target[key])) for key in (
                    'sourceDomSha256', 'captionSha256', 'readerArticleSha256', 'readerPlanSha256',
                    'readerFiguresSha256', 'originalReaderPixelSha256'))
                or not isinstance(target['caption'], str) or not target['caption']
                or not isinstance(target['sourceFiles'], dict)
                or set(target['sourceFiles']) != {'source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json'}
                or any(not re.fullmatch(r'[a-f0-9]{64}', str(v)) for v in target['sourceFiles'].values())
                or not isinstance(target['damageReceipt'], dict)
                or set(target['damageReceipt']) != {'file', 'sha256'}
                or not isinstance(target['damageReceipt']['file'], str)
                or not re.fullmatch(r'[a-f0-9]{64}', str(target['damageReceipt']['sha256']))):
            raise _H.PublishDataValidationError('坏 PNG 出版恢复目标的逐项来源身份不完整。')
        receipt = Path(target['damageReceipt']['file'])
        if not receipt.is_absolute() or receipt != receipt.resolve():
            raise _H.PublishDataValidationError('坏 PNG 原结构回执须为无软链的绝对路径。')
        try:
            receipt.resolve().relative_to(root.resolve())
        except ValueError as exc:
            raise _H.PublishDataValidationError('坏 PNG 原损坏回执须在项目运行目录。') from exc
        receipt_raw = _H._daily_fresh_read_private_file(receipt, '坏 PNG 原结构回执', 4 * 1024 * 1024)
        if hashlib.sha256(receipt_raw).hexdigest() != target['damageReceipt']['sha256']:
            raise _H.PublishDataValidationError('坏 PNG 原结构回执字节发生变化。')
        return {'file': str(file.resolve()), 'sha256': hashlib.sha256(raw).hexdigest(), 'value': value,
                'receipt': {'file': str(receipt.resolve()), 'sha256': target['damageReceipt']['sha256'],
                            'value': json.loads(receipt_raw)}}


def _publication_raster_recovery_target(paper, figure=None, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        recovery = _H._publication_raster_recovery_input()
        if recovery is None:
            return None
        target = recovery['value']['targets'][0]
        if target['paperId'] != _H._daily_fresh_normalized_paper_id(paper):
            return None
        stage = (paper.get('analysisManifest') or {}).get('stages', {}).get('apiReaderArticle', {})
        if (recovery['value']['runId'] != (paper.get('freshRewriteProvenance') or {}).get('runId')
                or target['readerArticleSha256'] != paper.get('apiReaderArticleSha256')
                or target['readerPlanSha256'] != paper.get('apiReaderPlanSha256')
                or target['readerFiguresSha256'] != stage.get('figuresSha256')):
            raise _H.PublishDataValidationError('坏 PNG 恢复与当前原 Reader 身份不同。')
        figures = [f for f in paper.get('apiReaderFigures') or [] if f.get('ordinal') == target['figureOrdinal']]
        if len(figures) != 1:
            raise _H.PublishDataValidationError('坏 PNG 恢复缺少唯一原 Reader 图。')
        original = figures[0]
        if (target['sourceUrl'] != original.get('url')
                or target['sourceDomSha256'] != original.get('sourceDomSha256')
                or target['originalReaderPixelSha256'] != original.get('assetSha256')
                or target['caption'] != original.get('caption')
                or target['captionSha256'] != hashlib.sha256(target['caption'].encode()).hexdigest()):
            raise _H.PublishDataValidationError('坏 PNG 恢复目标与原图身份、像素或完整图注不同。')
        if figure is not None and figure.get('ordinal') != target['figureOrdinal']:
            return None
        return recovery


def _reader_damaged_raster_pdf_page_asset(paper, figure, recovery, *, hooks: Mapping | None = None):
    """Only this explicit target may read original broken bytes for PDF recovery."""
    with _hooks_scope(hooks):
        from reader_damaged_raster_pdf_asset import derive_page_asset
        proof = paper['freshRewriteProvenance']
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / proof['runId']
        _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
        directory = run_dir / 'sources' / paper_id / 'generation-000001'
        sources = {name: _H._daily_fresh_read_private_file(directory / name, '坏 PNG 的原四源', 512 * 1024 * 1024)
                   for name in ('source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json')}
        run_bytes = _H._daily_fresh_read_private_file(run_dir / 'run.json', '坏 PNG 原运行身份', 32 * 1024 * 1024)
        if json.loads(run_bytes).get('batchDate') != recovery['value']['batchDate']:
            raise _H.PublishDataValidationError('坏 PNG 出版恢复日期与原封存运行不同。')
        files = {name: hashlib.sha256(raw).hexdigest() for name, raw in sources.items()}
        runtime = json.loads(sources['source-runtime.json'])
        originals = [f for f in runtime['structuredArtifacts']['figures']
                     if f.get('ordinal') == figure['ordinal'] and f.get('sourceDomSha256') == figure['sourceDomSha256']]
        if (len(originals) != 1 or originals[0].get('recoveryStatus') != 'complete'
                or originals[0].get('images') != [{'alt': originals[0]['images'][0].get('alt', ''),
                    'kind': 'external_url', 'mediaType': 'image/png', 'rasterDownloadEligible': True, 'url': figure['url']}]
                or re.sub(r'\s+', ' ', originals[0].get('caption', '')).strip() != figure['caption']
                or re.sub(r'\s+', ' ', originals[0].get('label', '')).strip() != figure['label']):
            raise _H.PublishDataValidationError('坏 PNG 原资源、DOM、图号或完整图注未绑定唯一封存来源。')
        target = recovery['value']['targets'][0]
        cache_key = (recovery['sha256'], figure['url'], figure['assetSha256'])
        with _H._RASTER_RECOVERY_SOURCE_BYTES_LOCK:
            original = _H._RASTER_RECOVERY_SOURCE_BYTES.get(cache_key)
        if original is None:
            observed = _H._download_review_image(figure['url'], _recovery_source_read=_H._RASTER_RECOVERY_SOURCE_READ)
            raw_bytes = observed['raw']
            with _H._RASTER_RECOVERY_SOURCE_BYTES_LOCK:
                if cache_key not in _H._RASTER_RECOVERY_SOURCE_BYTES:
                    _H._RASTER_RECOVERY_SOURCE_BYTES.clear()
                    _H._RASTER_RECOVERY_SOURCE_BYTES[cache_key] = raw_bytes
                original = _H._RASTER_RECOVERY_SOURCE_BYTES[cache_key]
        try:
            result = derive_page_asset(paper_id=paper_id, figure=figure, target=target,
                old_pixels=original, pdf_bytes=sources['source.pdf'], source_files=files,
                recovery_manifest={k: recovery[k] for k in ('file', 'sha256')}, damage_receipt=recovery['receipt'])
        except (ValueError, RuntimeError) as exc:
            raise _H.PublishDataValidationError(f'坏 PNG 独立 PDF 出版恢复无法完整重放：{exc}') from exc
        after = _H._publication_raster_recovery_input()
        if after['sha256'] != recovery['sha256']:
            raise _H.PublishDataValidationError('坏 PNG 恢复清单在派生期间发生变化。')
        if any(hashlib.sha256(_H._daily_fresh_read_private_file(directory / name, '坏 PNG 派生后原四源',
                   512 * 1024 * 1024)).hexdigest() != digest for name, digest in files.items()):
            raise _H.PublishDataValidationError('坏 PNG 派生期间原四源字节发生变化。')
        if _H._daily_fresh_read_private_file(run_dir / 'run.json', '坏 PNG 派生后运行身份', 32 * 1024 * 1024) != run_bytes:
            raise _H.PublishDataValidationError('坏 PNG 派生期间原运行字节发生变化。')
        return result


def _reader_pdf_page_asset(paper, figure, resource, original_pixels, *, hooks: Mapping | None = None):
    """Derive a separate publication asset; never rewrite saved model pixels."""
    with _hooks_scope(hooks):
        from reader_pdf_page_asset import dependency_failure, derive_page_asset
        if dependency_failure(resource['inlineSvg'].encode('utf-8')) is None:
            return None
        proof = paper.get('freshRewriteProvenance') or {}
        run_id = proof.get('runId')
        if not isinstance(run_id, str) or not re.fullmatch(
                r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('PDF 整页派生图片缺少本篇日更封存来源。')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, 'PDF 图片来源根目录')
        _H._daily_fresh_safe_directory(run_dir, 'PDF 图片来源运行目录')
        _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
        directory = run_dir / 'sources' / paper_id / 'generation-000001'
        sources = {name: _H._daily_fresh_read_private_file(directory / name,
                   f'PDF 图片 {name}', 512 * 1024 * 1024) for name in (
                       'source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json')}
        source_manifest = json.loads(sources['source-manifest.json'])
        if (hashlib.sha256(sources['source-manifest.json']).hexdigest() != proof.get('sourceManifestSha256')
                or hashlib.sha256(sources['source.txt']).hexdigest() != paper.get('sourceSha256')
                or any(source_manifest.get(key, {}).get('responseSha256')
                       != hashlib.sha256(sources[name]).hexdigest()
                       or source_manifest.get(key, {}).get('responseBytes') != len(sources[name])
                       for key, name in [('pdf', 'source.pdf'), ('runtimeMetadata', 'source-runtime.json')])):
            raise _H.PublishDataValidationError('PDF 图片的四份来源在完整核验后发生变化。')
        runtime = json.loads(sources['source-runtime.json'])
        originals = [item for item in runtime['structuredArtifacts']['figures']
                     if item.get('ordinal') == figure['ordinal']
                     and item.get('sourceDomSha256') == figure['sourceDomSha256']]
        sealed_caption = re.sub(r'\s+', ' ', originals[0].get('caption', '')).strip() if len(originals) == 1 else ''
        figure_caption = re.sub(r'\s+', ' ', figure.get('caption', '')).strip()
        # 模型偶尔把长图注截短；只要它是封存图注的逐字前缀，就用封存原文派生并
        # 显示完整图注，避免半截图注泄漏到页面。其余不一致仍拒绝。
        caption_matches = bool(sealed_caption) and (
            sealed_caption == figure_caption or sealed_caption.startswith(figure_caption))
        if (len(originals) != 1 or originals[0].get('images') != [resource] or not caption_matches):
            raise _H.PublishDataValidationError(
                f'PDF 图片的原 SVG、图号或完整图注与封存来源不一致（{paper_id} 图 {figure.get("ordinal")}）。'
            )
        if sealed_caption != figure_caption:
            figure = {**figure, 'caption': sealed_caption}
        try:
            return derive_page_asset(paper_id=paper_id, figure=figure, resource=resource,
                old_pixels=original_pixels, pdf_bytes=sources['source.pdf'],
                source_files={name: hashlib.sha256(raw).hexdigest() for name, raw in sources.items()})
        except (ValueError, RuntimeError) as exc:
            raise _H.PublishDataValidationError(
                f'PDF 整页派生图片无法严格重验（{paper_id} 图 {figure.get("ordinal")}）：{exc}'
            ) from exc


def _is_pdf_crop_figure(figure):
    if not isinstance(figure, dict):
        return False
    if 'pdfCropSourceSha256' in figure or 'pdfCropContract' in figure:
        return True
    frag = urlparse(str(figure.get('url') or '')).fragment
    return bool(re.fullmatch(r'pd-pdf-figure-\d+-[0-9a-f]{16}', frag))


def _reader_pdf_crop_resource(paper, plan, figure, structured_sha, source_sha, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        from pdf_figure_table_extract import pdf_crop_source_descriptor
        artifacts = _H._reader_source_payload_artifacts(plan.get('structuredSourcePayload'), structured_sha, source_sha)
        if not artifacts or not isinstance(artifacts.get('figures'), list):
            raise _H.PublishDataValidationError('PDF 裁切论文图缺少已绑定的原始结构化来源。')
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        matches = []
        for source in artifacts['figures']:
            if (not isinstance(source, dict) or source.get('recoveryStatus') != 'complete'
                    or source.get('ordinal') != figure.get('ordinal')
                    or source.get('sourceDomSha256') != figure.get('sourceDomSha256')):
                continue
            images = source.get('images')
            if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
                continue
            res = images[0]
            try:
                descriptor = pdf_crop_source_descriptor(res, paper_id)
            except ValueError:
                continue
            if (all(descriptor[key] == figure.get(key) for key in (
                    'url', 'sourceLocationUrl', 'pdfCropSourceSha256', 'pdfCropContract'))
                    and re.sub(r'\s+', ' ', source.get('label') or f"Figure {source['ordinal']}").strip() == figure.get('label')
                    and re.sub(r'\s+', ' ', source.get('caption') or '').strip()[:1200] == figure.get('caption')):
                matches.append(res)
        if len(matches) != 1:
            raise _H.PublishDataValidationError('PDF 裁切论文图与原始来源坐标、图注或位置不一致。')
        return matches[0]


def _read_authenticated_historical_arxiv_pdf_bytes(paper, paper_id, proof, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        gen = proof.get('sourceGeneration')
        manifest_sha = proof.get('sourceManifestSha256')
        source_sha = proof.get('sourceSha256')
        if (type(gen) is not int or gen < 1
                or not isinstance(manifest_sha, str) or not re.fullmatch(r'[0-9a-f]{64}', manifest_sha)
                or not isinstance(source_sha, str) or not re.fullmatch(r'[0-9a-f]{64}', source_sha)):
            raise _H.PublishDataValidationError('PDF 裁切论文图缺少有效的历史封存来源世代或清单 SHA。')
        analysis_manifest = paper.get('analysisManifest')
        if (not isinstance(analysis_manifest, dict)
                or analysis_manifest.get('freshRewriteProvenance') != proof
                or paper.get('sourceSha256') != source_sha):
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存来源证明未闭合到分析清单。')
        fetched_root = _H.DAILY_FRESH_SOURCE_RUNS_DIR.parent / 'fetched-arxiv-sources'
        paper_dir = fetched_root / paper_id
        source_dir = paper_dir / f'generation-{gen:06d}'
        for directory, label in (
                (fetched_root, '历史 PDF 裁切来源根目录'),
                (paper_dir, '历史 PDF 裁切论文目录'),
                (source_dir, '历史 PDF 裁切世代目录'),
        ):
            _H._daily_fresh_safe_directory(directory, label)
        entries = sorted(item.name for item in source_dir.iterdir())
        if entries != ['source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt']:
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存来源目录文件集合不完整或包含多余文件。')
        manifest_bytes = _H._daily_fresh_read_private_file(source_dir / 'source-manifest.json', '历史封存来源清单', 1024 * 1024)
        if hashlib.sha256(manifest_bytes).hexdigest() != manifest_sha:
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存来源清单 SHA 不一致。')
        try:
            manifest = json.loads(manifest_bytes.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存来源清单 JSON 无效。') from exc
        if (not isinstance(manifest, dict) or manifest.get('arxivId') != paper_id
                or manifest.get('generation') != gen):
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存来源清单与论文或世代不匹配。')
        text_bytes = _H._daily_fresh_read_private_file(source_dir / 'source.txt', '历史封存正文', 64 * 1024 * 1024)
        runtime_bytes = _H._daily_fresh_read_private_file(source_dir / 'source-runtime.json', '历史封存运行元数据', 64 * 1024 * 1024)
        pdf_bytes = _H._daily_fresh_read_private_file(source_dir / 'source.pdf', '历史封存 PDF 原文件', 512 * 1024 * 1024)
        if (hashlib.sha256(text_bytes).hexdigest() != source_sha
                or manifest.get('text', {}).get('responseSha256') != source_sha
                or manifest.get('runtimeMetadata', {}).get('responseSha256') != hashlib.sha256(runtime_bytes).hexdigest()
                or manifest.get('pdf', {}).get('responseSha256') != hashlib.sha256(pdf_bytes).hexdigest()):
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存四文件哈希与清单声明不一致。')
        try:
            runtime = json.loads(runtime_bytes.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存运行元数据 JSON 无效。') from exc
        expected_art_sha = proof.get('structuredArtifactsSha256')
        actual_art_sha = (runtime.get('structuredArtifacts') or {}).get('payloadSha256') if isinstance(runtime, dict) else None
        if expected_art_sha and actual_art_sha != expected_art_sha:
            raise _H.PublishDataValidationError(f'{paper_id} 历史封存结构化来源 SHA 不一致。')
        return pdf_bytes


def _render_reader_pdf_crop_pixels(paper, resource, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        from pdf_figure_table_extract import pdf_crop_source_descriptor, render_pdf_figure_crop_png
        proof = paper.get('freshRewriteProvenance') or {}
        run_id = proof.get('runId')
        if not isinstance(run_id, str) or not re.fullmatch(
                r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('PDF 裁切论文图缺少本篇封存来源运行标识。')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        try:
            pdf_crop_source_descriptor(resource, paper_id)
        except ValueError as exc:
            raise _H.PublishDataValidationError(f'PDF 裁切论文图描述无效：{exc}') from exc
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        if run_dir.is_symlink():
            raise _H.PublishDataValidationError('PDF 裁切图片来源运行目录不能是符号链接。')
        if run_dir.exists():
            _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, 'PDF 裁切图片来源根目录')
            _H._daily_fresh_safe_directory(run_dir, 'PDF 裁切图片来源运行目录')
            _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
            pdf_path = run_dir / 'sources' / paper_id / 'generation-000001' / 'source.pdf'
            pdf_bytes = _H._daily_fresh_read_private_file(pdf_path, 'PDF 裁切原文件', 512 * 1024 * 1024)
        else:
            pdf_bytes = _H._read_authenticated_historical_arxiv_pdf_bytes(paper, paper_id, proof)
        if hashlib.sha256(pdf_bytes).hexdigest() != resource.get('pdfSha256'):
            raise _H.PublishDataValidationError('封存 PDF 字节 SHA 与 PDF 裁切图来源声明不一致。')
        try:
            return render_pdf_figure_crop_png(
                pdf_bytes, resource['page'], resource['bbox'], dpi=resource['dpi']
            )
        except (ValueError, RuntimeError) as exc:
            raise _H.PublishDataValidationError(f'PDF 裁切论文图渲染失败：{exc}') from exc


def _validate_legacy_reader_figure_source(paper, plan, article, structured_sha, source_sha, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        figures = paper.get('apiReaderFigures') or []
        if not isinstance(figures, list):
            return  # 完整图片列表由正式 Reader 发布检查核验。
        if (paper_id == '2609.27195'
                and any(isinstance(item, dict) and item.get('url') == 'https://arxiv.org/html/2609.27195v1/fig4_placement_ratio_readable.svg' for item in figures)
                and any(text in article for text in _H._LEGACY_READER_PIXEL_NARRATIVES)):
            raise _H.PublishDataValidationError('旧论文图仍含无像素证据的固定叙述；请根据封存来源重建 Reader。')
        for figure in figures:
            if isinstance(figure, dict) and _H._is_pdf_crop_figure(figure):
                _H._reader_pdf_crop_resource(paper, plan, figure, structured_sha, source_sha)
            elif isinstance(figure, dict) and ('inlineSvgSourceSha256' in figure or 'inlineSvgRenderContract' in figure
                    or urlparse(str(figure.get('url') or '')).fragment):
                _H._reader_inline_svg_resource(paper, plan, figure, structured_sha, source_sha)
        if paper_id != '2609.15067':
            return
        for figure in figures:
            if not isinstance(figure, dict):
                continue
            match = re.fullmatch(r'https://(?:www\.)?arxiv\.org/html/2609\.15067(?:v\d+)?/(method\.png|overview\.png)', str(figure.get('url') or ''), re.I)
            if not match or figure.get('caption') != _H._LEGACY_READER_FIGURE_CAPTIONS[match.group(1).lower()]:
                continue
            artifacts = _H._reader_source_payload_artifacts(plan.get('structuredSourcePayload'), structured_sha, source_sha)
            if not artifacts or not isinstance(artifacts.get('figures'), list):
                raise _H.PublishDataValidationError('旧论文图缺少与既有来源 SHA 对应的原始结构化内容；请重建 Reader。')
            candidates = []
            for source in artifacts['figures']:
                if (not isinstance(source, dict) or source.get('recoveryStatus') != 'complete'
                        or type(source.get('ordinal')) is not int
                        or not re.fullmatch(r'[0-9a-f]{64}', str(source.get('sourceDomSha256') or ''))):
                    continue
                images = source.get('images')
                if (isinstance(images, list) and len(images) == 1 and isinstance(images[0], dict)
                        and images[0].get('kind') == 'external_url' and images[0].get('url') == figure.get('url')):
                    candidates.append(source)
            if len(candidates) != 1:
                raise _H.PublishDataValidationError('旧论文图的 URL 未唯一对应原始来源；请重建 Reader。')
            source = candidates[0]
            # 与 Node 的来源图片清单规范化保持一致。
            expected = {'ordinal': source.get('ordinal'), 'sourceDomSha256': source.get('sourceDomSha256'),
                        'label': re.sub(r'\s+', ' ', str(source.get('label') or f"Figure {source.get('ordinal')}" )).strip(),
                        'caption': re.sub(r'\s+', ' ', str(source.get('caption') or '')).strip()[:1200]}
            if any(figure.get(key) != value for key, value in expected.items()):
                raise _H.PublishDataValidationError('旧论文图的图号、图注或 DOM SHA 与原始来源不一致；请重建 Reader。')


def _validate_legacy_reader_dataset_claims(tables, table_bindings, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        for index, table in enumerate(tables):
            if ([str(cell).strip() for cell in table['header']]
                    != ['策略', '数据集', '评测任务', 'EER (%)', '运行条件']
                    or not any(len(row) >= 3 and str(row[1]).strip() == 'TidyVoice'
                               and str(row[2]).strip() == 'validation set' for row in table['rows'])):
                continue
            binding = table_bindings[index]
            if binding.get('sourceType') != 'source_quotes':
                continue
            supported = False
            for item in binding.get('sourceQuotes', []):
                normalized = unicodedata.normalize('NFKC', str(item.get('quote') or ''))

                def extends_name(character):
                    return bool(character) and not '\u3400' <= character <= '\u9fff' and (
                        unicodedata.category(character)[0] in 'LMN' or character in '_-'
                    )

                def exact_dataset_name(match):
                    before = normalized[match.start() - 1] if match.start() else ''
                    after = normalized[match.end()] if match.end() < len(normalized) else ''
                    return '其他数据集' if extends_name(before) or extends_name(after) else match.group()

                normalized = re.sub(r'TidyVoice', exact_dataset_name, normalized, flags=re.I)
                for sentence in re.split(r'[。！？.!?;；\n]+', normalized):
                    if re.search(r'\b(?:not|no|never|neither|without|except|rather than)\b|不是|并非|不属于|并不|未用|未使用', sentence, re.I):
                        continue
                    if any(re.search(pattern, sentence, re.I) for pattern in (
                            r'TidyVoice(?:[\'’]s)?\s+(?:validation|development)\s+(?:set|split|partition)\b',
                            r'\b(?:validation|development)\s+(?:set|split|partition)\s+(?:(?:is|was)\s+)?(?:from|of|for)\s+TidyVoice',
                            r'\b(?:validation|development)\s+(?:set|split|partition)\s+(?:is|was|=)\s+TidyVoice',
                            r'TidyVoice\s*(?:的\s*)?验证(?:集|集合)',
                            r'验证(?:集|集合)\s*(?:来自|取自|使用|采用|为|是)\s*TidyVoice')):
                        supported = True
            if not supported:
                raise _H.PublishDataValidationError('旧 TidyVoice/validation set 对应关系缺少逐字原文依据；请根据封存来源重建 Reader。')


def _reader_merged_cell_matches(paper, binding, cell, displayed, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        if displayed != '' or cell.get('renderedText') != '' or type(cell.get('sourceRow')) is not int \
                or cell['sourceRow'] < 0 or type(cell.get('sourceColumn')) is not int or cell['sourceColumn'] <= 0:
            return False
        source = (paper.get('analysisManifest') or {}).get('sourceAcquisition') or {}
        if paper.get('sourceSha256') != source.get('sourceSha256'):
            return False
        artifacts = _H._reader_source_payload_artifacts((paper.get('apiReaderPlan') or {}).get('structuredSourcePayload'),
            source.get('structuredArtifactsSha256'), source.get('sourceSha256'))
        if not artifacts:
            return False
        tables = [table for table in artifacts.get('tables', []) if table.get('ordinal') == binding.get('sourceTableOrdinal')
                  and table.get('sourceDomSha256') == binding.get('sourceTableDomSha256')]
        if len(tables) != 1:
            return False
        table = tables[0]
        row, column = cell['sourceRow'], cell['sourceColumn']
        matrix = table.get('matrix') or []
        if row >= len(matrix) or not isinstance(matrix[row], list) or len(matrix[row]) < 2 \
                or any(not isinstance(values, list) or len(values) != len(matrix[row]) for values in matrix):
            return False
        cells = [item for item in table.get('cells', []) if isinstance(item, dict)
                 and type(item.get('row')) is int and type(item.get('rowspan', 1)) is int
                 and item.get('rowspan', 1) > 0
                 and item['row'] <= row < item['row'] + item.get('rowspan', 1)]
        if len(cells) != 1:
            return False
        original = cells[0]
        text = original.get('text')
        return (table.get('recoveryStatus') == 'complete'
                and re.fullmatch(r'[a-f0-9]{64}', str(table.get('sourceDomSha256') or '')) is not None
                and original['row'] == row and original.get('column') == 0
                and original.get('colspan') == len(matrix[row]) and original.get('rowspan', 1) == 1
                and isinstance(text, str) and any(char.isalpha() for char in text)
                and all(value == text for value in matrix[row]) and column < len(matrix[row])
                and original.get('sourceDomSha256') == cell.get('sourceDomSha256')
                and re.fullmatch(r'[a-f0-9]{64}', str(original.get('sourceDomSha256') or '')) is not None
                and text == cell.get('sourceText'))


def _reader_html_blank_span_keys(paper, article, rendered_tables, *, hooks: Mapping | None = None):
    """Batch replay only actual blank/source mismatches through the shared Node DOM rule."""
    with _hooks_scope(hooks):
        bindings = (paper.get('apiReaderPlan') or {}).get('tableBindings') or []
        proof = paper.get('freshRewriteProvenance') or {}
        if not proof or not isinstance(bindings, list):
            return set()
        needed = False
        for binding, table in zip(bindings, rendered_tables):
            if not isinstance(binding, dict) or binding.get('sourceType') != 'artifact_table' or binding.get('pdfCellConfirmation'):
                continue
            rows = [table['header'], *table['rows']]
            for cell in binding.get('cellBindings') or []:
                if not isinstance(cell, dict):
                    continue
                row, column = cell.get('renderedRow'), cell.get('renderedColumn')
                if type(row) is int and type(column) is int and 0 <= row < len(rows) and 0 <= column < len(rows[row]) \
                        and rows[row][column] == '' and cell.get('renderedText') == '' \
                        and _H._normalize_api_reader_source_cell(cell.get('sourceText')) != '':
                    needed = True
        if not needed:
            return set()
        node = shutil.which('node')
        if not node:
            raise _H.PublishDataValidationError('HTML 合并分类行来源重放需要 Node.js')
        payload = _H._daily_fresh_compact_json_bytes({'paper': paper, 'article': article,
            'sealedBundleRoot': str(_H.DAILY_FRESH_SOURCE_RUNS_DIR / str(proof.get('runId')) / 'sources')})
        if len(payload) > 128 * 1024 * 1024:
            raise _H.PublishDataValidationError('HTML 合并分类行来源重放输入超过上限')
        cli = _H.SHARED_SCRIPTS_DIR / 'lib' / 'reader-dom-span-replay-cli.js'
        replay_env = {key: value for key, value in os.environ.items() if key not in {'NODE_OPTIONS', 'NODE_PATH'}}
        replay_runner = _H.get("_run_node_replay_cli")
        if replay_runner is not None:
            result = replay_runner(
                cli, payload, node=node, cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                env=replay_env, timeout_seconds=30, max_output_bytes=1024 * 1024,
            )
        else:
            with tempfile.TemporaryFile() as source_file:
                source_file.write(payload)
                source_file.flush()
                source_file.seek(0)
                result = _H._run_bounded_subprocess(
                    [node, str(cli), str(source_file.fileno())],
                    cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                    env=replay_env,
                    timeout_seconds=30, max_output_bytes=1024 * 1024, pass_fds=(source_file.fileno(),))
        if result.returncode != 0 or result.timed_out or result.output_truncated:
            return set()
        try:
            keys = json.loads(result.stdout)['keys']
            if not isinstance(keys, list) or any(not isinstance(key, list) or len(key) != 3
                    or any(type(value) is not int or value < 0 for value in key) for key in keys):
                return set()
            return {tuple(key) for key in keys}
        except (ValueError, KeyError, TypeError):
            return set()


def _verify_reader_paired_dom_bindings(paper, *, hooks: Mapping | None = None):
    """Reject-only actual-source replay for complete paired-arrow/unit DOM views."""
    with _hooks_scope(hooks):
        bindings = [b for b in (paper.get('apiReaderPlan') or {}).get('tableBindings', [])
                    if isinstance(b, dict) and b.get('sourceType') == 'artifact_table'
                    and not b.get('pdfCellConfirmation') and not b.get('sealedPdfTableEvidence')]
        proof = paper.get('freshRewriteProvenance') or {}
        if not bindings or not is_fresh_source_provenance(proof):
            return
        run_id = proof.get('runId')
        if proof != (paper.get('analysisManifest') or {}).get('freshRewriteProvenance') or not isinstance(run_id, str) \
                or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('配对DOM显示缺少真实日更来源身份。')
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        # Component selection only: historical publication keeps its own complete
        # source route; the daily top-level plan gate still requires its real run.
        run_file = run_dir / 'run.json'
        if not run_file.exists() and not run_file.is_symlink():
            return
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, '配对DOM来源根目录')
        _H._daily_fresh_safe_directory(run_dir, '配对DOM运行目录')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        _H._daily_fresh_read_bundle_source_identity(run_dir, paper_id, proof, paper)
        _, runtime = _H._daily_fresh_read_canonical_json(run_dir / 'sources' / paper_id / 'generation-000001' / 'source-runtime.json',
            '配对DOM结构化来源', 64 * 1024 * 1024)
        artifacts = runtime['structuredArtifacts']
        def has_pair(text):
            return re.search(r'[↑↓]\{\\(?:uparrow|downarrow)\}', text) or re.fullmatch(
                r'[+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[ \t]*±[ \t]*\\pm[ \t]*(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[ \t]+(?:ms|s)[ \t]*', text)
        if not any(has_pair(c['text']) for t in artifacts['tables'] for c in t['cells']):
            return
        source = paper['analysisManifest']['sourceAcquisition']
        payload = _H._reader_source_payload_artifacts(paper['apiReaderPlan'].get('structuredSourcePayload'),
            source['structuredArtifactsSha256'], paper['sourceSha256'])
        if payload != {key: value for key, value in artifacts.items() if key != 'payloadSha256'}:
            raise _H.PublishDataValidationError('配对DOM显示与完整封存结构化来源不一致。')
        displayed = _H._api_reader_markdown_tables(paper.get('apiReaderArticle') or '')
        for binding in bindings:
            originals = [t for t in artifacts['tables'] if t.get('ordinal') == binding.get('sourceTableOrdinal')]
            index = binding.get('tableIndex')
            if len(originals) != 1 or type(index) is not int or index < 1 or index > len(displayed):
                raise _H.PublishDataValidationError('配对DOM显示不能定位完整原表。')
            table = originals[0]
            view = displayed[index - 1]
            matrix = [view['header'], *view['rows']]
            cells = binding.get('cellBindings')
            if table.get('recoveryStatus') != 'complete' or binding.get('sourceTableDomSha256') != table.get('sourceDomSha256') \
                    or binding.get('sourceQuotes') != [] or len(matrix) != len(table['matrix']) \
                    or any(len(row) != len(table['matrix'][r]) for r, row in enumerate(matrix)) \
                    or not isinstance(cells, list) or len(cells) != sum(map(len, table['matrix'])):
                raise _H.PublishDataValidationError('配对DOM显示必须保留全部原表行列。')
            seen = set()
            for cell in cells:
                r, c = cell.get('sourceRow'), cell.get('sourceColumn')
                if type(r) is not int or type(c) is not int or r < 0 or c < 0 or (r, c) in seen \
                        or r >= len(table['matrix']) or c >= len(table['matrix'][r]):
                    raise _H.PublishDataValidationError('配对DOM显示的原坐标不完整。')
                owners = [item for item in table['cells'] if item['row'] <= r < item['row'] + item['rowspan']
                          and item['column'] <= c < item['column'] + item['colspan']]
                rendered_text = cell.get('renderedText')
                unescaped_rendered = str(rendered_text or '').replace('\\|', '|') if isinstance(rendered_text, str) else rendered_text
                owner_texts = (_H._normalize_api_reader_display_artifacts(owners[0]['text']), owners[0]['text']) if len(owners) == 1 else ()
                if len(owners) != 1 or cell.get('renderedRow') != r or cell.get('renderedColumn') != c \
                        or table['matrix'][r][c] != owners[0]['text'] or cell.get('sourceText') != owners[0]['text'] \
                        or cell.get('sourceDomSha256') != owners[0]['sourceDomSha256'] \
                        or (rendered_text not in owner_texts and unescaped_rendered not in owner_texts) \
                        or matrix[r][c] != rendered_text:
                    raise _H.PublishDataValidationError('配对DOM显示的原文、数值单位、坐标或DOM身份不一致。')
                seen.add((r, c))


def _verify_reader_scientific_dom_bindings(paper, *, hooks: Mapping | None = None):
    """New scientific displays retain the actual complete sealed DOM grid."""
    with _hooks_scope(hooks):
        _H._verify_reader_paired_dom_bindings(paper)
        displayed = _H._api_reader_markdown_tables(paper.get('apiReaderArticle') or '')
        marked = [binding for binding in (paper.get('apiReaderPlan') or {}).get('tableBindings', [])
                  if isinstance(binding, dict) and binding.get('sourceType') == 'artifact_table'
                  and not binding.get('pdfCellConfirmation') and not binding.get('sealedPdfTableEvidence') and (any(
                      (strict_source_cell_math_display(cell.get('sourceText')) or {}).get('kind') == 'scientific-notation-duplicate'
                      or re.fullmatch(r'[+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)×10[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+', str(cell.get('renderedText') or ''))
                      for cell in binding.get('cellBindings', []) if isinstance(cell, dict))
                      or (type(binding.get('tableIndex')) is int and 1 <= binding['tableIndex'] <= len(displayed)
                          and re.search(r'[0-9.]×10[+−-]?[0-9]+', re.sub(r'[\s*_`]', '', unicodedata.normalize(
                              'NFKC', displayed[binding['tableIndex'] - 1]['markdown'])))))]
        if not marked:
            return
        proof = paper.get('freshRewriteProvenance') or {}
        run_id = proof.get('runId')
        if not is_fresh_source_provenance(proof) or not isinstance(run_id, str) or not re.fullmatch(
                r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('科学计数显示缺少真实封存来源。')
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, '科学计数来源根目录')
        _H._daily_fresh_safe_directory(run_dir, '科学计数运行目录')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
        _, runtime = _H._daily_fresh_read_canonical_json(run_dir / 'sources' / paper_id / 'generation-000001' / 'source-runtime.json',
            '科学计数结构化来源', 64 * 1024 * 1024)
        source = paper['analysisManifest']['sourceAcquisition']
        artifacts = _H._reader_source_payload_artifacts(paper['apiReaderPlan'].get('structuredSourcePayload'),
            source['structuredArtifactsSha256'], paper['sourceSha256'])
        if artifacts != {key: value for key, value in runtime['structuredArtifacts'].items() if key != 'payloadSha256'}:
            raise _H.PublishDataValidationError('科学计数显示与真实封存结构化来源不一致。')
        for binding in marked:
            tables = [table for table in artifacts['tables'] if table.get('ordinal') == binding.get('sourceTableOrdinal')]
            if len(tables) != 1 or binding.get('sourceType') != 'artifact_table' or binding.get('sourceQuotes') != []:
                raise _H.PublishDataValidationError('科学计数显示必须绑定唯一完整原表。')
            table = tables[0]
            cells = binding.get('cellBindings') or []
            if table.get('recoveryStatus') != 'complete' or binding.get('sourceTableDomSha256') != table.get('sourceDomSha256') \
                    or len(cells) != sum(len(row) for row in table['matrix']):
                raise _H.PublishDataValidationError('科学计数显示必须保留原表全部单元格和DOM身份。')
            seen = set()
            for cell in cells:
                row, column = cell.get('sourceRow'), cell.get('sourceColumn')
                original = [item for item in table['cells'] if item.get('row') == row and item.get('column') == column]
                if type(row) is not int or type(column) is not int or row < 0 or column < 0 \
                        or row >= len(table['matrix']) or column >= len(table['matrix'][row]) or (row, column) in seen \
                        or cell.get('renderedRow') != row or cell.get('renderedColumn') != column or len(original) != 1 \
                        or original[0].get('rowspan') != 1 or original[0].get('colspan') != 1 \
                        or original[0].get('text') != cell.get('sourceText') \
                        or table['matrix'][row][column] != cell.get('sourceText') \
                        or original[0].get('sourceDomSha256') != cell.get('sourceDomSha256'):
                    raise _H.PublishDataValidationError('科学计数显示的原始单元格、完整坐标或DOM身份不一致。')
                seen.add((row, column))


def _verify_reader_sealed_pdf_grid_bindings(paper, *, hooks: Mapping | None = None):
    """Replay the independent PDF protocol against all four official sealed sources."""
    with _hooks_scope(hooks):
        source = _H._read_reader_sealed_pdf_grid_source(paper)
        if source is None:
            return {}
        marked, source_dir, details, paper_id = source
        _H._validate_current_model_text_reuse_for_publish(paper, details, paper_id,
                                                     sealed_bundle_root=source_dir.parent.parent)
        return _H._replay_reader_sealed_pdf_grid(paper, marked, source_dir)


def _read_reader_sealed_pdf_grid_source(paper, *, hooks: Mapping | None = None):
    """Verify all source files, without asserting any analysis completed."""
    with _hooks_scope(hooks):
        bindings = (paper.get('apiReaderPlan') or {}).get('tableBindings') or []
        if any(isinstance(binding, dict) and 'sealedPdfTableSelection' in binding
               and ('sealedPdfTableEvidence' not in binding or 'pdfCellConfirmation' in binding)
               for binding in bindings):
            raise _H.PublishDataValidationError('PDF 选择投影必须保留独立完整原表证明。')
        marked = [binding for binding in bindings if 'sealedPdfTableEvidence' in binding]
        if not marked:
            return None
        proof = paper.get('freshRewriteProvenance') or {}
        run_id = proof.get('runId')
        if not isinstance(run_id, str) or not re.fullmatch(
                r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('独立 PDF 表格证明缺少受控封存运行。')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, '独立 PDF 来源根目录')
        _H._daily_fresh_safe_directory(run_dir, '独立 PDF 来源运行目录')
        _, details = _H._daily_fresh_read_bundle_source_identity(run_dir, paper_id, proof, paper)
        source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
        return marked, source_dir, details, paper_id


def _replay_reader_sealed_pdf_grid(paper, marked, source_dir, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        from reader_sealed_pdf_table_evidence import prove_pdf_bytes
        from reader_proof_format import grid_header
        _, runtime = _H._daily_fresh_read_canonical_json(source_dir / 'source-runtime.json',
            '独立 PDF 表格来源元数据', 64 * 1024 * 1024)
        source = paper['analysisManifest']['sourceAcquisition']
        artifacts = _H._reader_source_payload_artifacts(paper['apiReaderPlan'].get('structuredSourcePayload'),
            source['structuredArtifactsSha256'], paper['sourceSha256'])
        sealed_artifacts = {key: value for key, value in runtime['structuredArtifacts'].items()
                            if key != 'payloadSha256'}
        if artifacts != sealed_artifacts:
            raise _H.PublishDataValidationError('独立 PDF 表格输入与封存结构化来源不一致。')
        pdf_bytes = _H._daily_fresh_read_private_file(source_dir / 'source.pdf',
            '独立 PDF 表格来源文件', 64 * 1024 * 1024)
        result = {}
        for binding in marked:
            if binding.get('sourceType') != 'artifact_table' \
                    or type(binding.get('tableIndex')) is not int or binding['tableIndex'] < 1:
                raise _H.PublishDataValidationError('独立 PDF 证明只能绑定完整原表及正整数序号。')
            saved = binding['sealedPdfTableEvidence']
            tables = [table for table in artifacts['tables']
                      if table.get('ordinal') == binding.get('sourceTableOrdinal')]
            if (len(tables) != 1 or not isinstance(saved, dict)
                    or not public_protocols.has_valid_header(saved, 'reader-sealed-pdf-table-grid')
                    or binding.get('sourceTableDomSha256') != tables[0].get('sourceDomSha256')):
                raise _H.PublishDataValidationError('独立 PDF 表格来源、协议或 DOM 身份不唯一。')
            table = tables[0]
            declared_header = grid_header(public_protocols.record_header(saved['contract'],
                'reader-sealed-pdf-table-grid', saved.get('schemaFingerprint')))
            replayed = prove_pdf_bytes(pdf_bytes, [table], declared_header)[0]
            if not replayed.get('eligible') or replayed.get('evidence') != saved:
                raise _H.PublishDataValidationError('独立 PDF 表格证明不能由封存原文件完整重放。')
            matrix = table['matrix']
            cells = binding.get('cellBindings') or []
            selected = 'sealedPdfTableSelection' in binding
            if selected:
                # The Python side has authenticated all four source files and the
                # full PDF grid above. Replay the exact same normal JS compiler;
                # a JSON projection alone is never a source capability.
                node = shutil.which('node')
                if not node:
                    raise _H.PublishDataValidationError('PDF 选择投影冷核需要正常 Node 运行时。')
                encoded = json.dumps({'artifacts': artifacts, 'binding': binding, 'proof': saved},
                                     ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                selection_cli = _H.SHARED_SCRIPTS_DIR / 'lib' / 'reader-pdf-selection-replay-cli.js'
                selection_env = _H.build_child_process_env()
                replay_runner = _H.get("_run_node_replay_cli")
                if replay_runner is not None:
                    replay = replay_runner(
                        selection_cli, encoded, node=node, cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                        env=selection_env, timeout_seconds=30, max_output_bytes=1024 * 1024,
                        use_named_temp=True, temp_prefix='pd-reader-pdf-selection-', temp_suffix='.json',
                    )
                else:
                    with tempfile.NamedTemporaryFile(prefix='pd-reader-pdf-selection-', suffix='.json') as selection_input:
                        selection_input.write(encoded); selection_input.flush(); selection_input.seek(0)
                        replay = _H._run_bounded_subprocess(
                            [node, str(selection_cli), str(selection_input.fileno())],
                            cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                            env=selection_env, timeout_seconds=30,
                            max_output_bytes=1024 * 1024, pass_fds=(selection_input.fileno(),))
                try:
                    accepted = json.loads(replay.stdout)
                except (ValueError, TypeError):
                    accepted = None
                if (replay.returncode != 0 or replay.timed_out or replay.output_truncated
                        or not public_protocols.has_valid_header(accepted, 'reader-pdf-selection-replay-result')
                        or accepted != {**public_protocols.record_header(accepted['contract'],
                            'reader-pdf-selection-replay-result', accepted.get('schemaFingerprint')), 'valid': True}):
                    raise _H.PublishDataValidationError('PDF 选择投影未通过正常来源编译程序重放。')
            if not selected and len(cells) != sum(map(len, matrix)):
                raise _H.PublishDataValidationError('独立 PDF 表格必须保留完整原表。')
            seen, values = set(), {}
            for cell in cells:
                row, column = cell.get('sourceRow'), cell.get('sourceColumn')
                if (type(row) is not int or type(column) is not int or not 0 <= row < len(matrix)
                        or not 0 <= column < len(matrix[row])
                        or (not selected and (cell.get('renderedRow') != row or cell.get('renderedColumn') != column))
                        or (row, column) in seen):
                    raise _H.PublishDataValidationError('独立 PDF 原表坐标不可重排、重复或越界。')
                originals = [item for item in table['cells'] if item['row'] == row and item['column'] == column]
                if (len(originals) != 1 or cell.get('sourceText') != originals[0]['text']
                        or cell.get('sourceDomSha256') != originals[0]['sourceDomSha256']):
                    raise _H.PublishDataValidationError('独立 PDF 单元格未对应封存原 DOM。')
                seen.add((row, column))
                rendered_key = (cell.get('renderedRow'), cell.get('renderedColumn')) if selected else (row, column)
                values[rendered_key] = saved['displayMatrix'][row][column]
            if binding['tableIndex'] in result:
                raise _H.PublishDataValidationError('独立 PDF 表格绑定序号重复。')
            result[binding['tableIndex']] = values
        return result


def _verify_reader_sealed_pdf_quote_bindings(paper, *, scientific_capabilities=None, hooks: Mapping | None = None):
    """Verify separate PDF quotations by re-extracting the official sealed file."""
    with _hooks_scope(hooks):
        from reader_pdf_quote_projection import extract_pdf_quote_document, quote_evidence, saved_header, QUOTE
        bindings = (paper.get('apiReaderPlan') or {}).get('tableBindings') or []
        marked = [binding for binding in bindings
                  if isinstance(binding, dict) and 'sealedPdfQuoteEvidence' in binding]
        if not marked:
            return {}
        proof = paper.get('freshRewriteProvenance') or {}
        run_id = proof.get('runId')
        if not isinstance(run_id, str) or not re.fullmatch(
                r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('独立 PDF 引文缺少受控封存运行。')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, '独立 PDF 来源根目录')
        _H._daily_fresh_safe_directory(run_dir, '独立 PDF 来源运行目录')
        _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
        source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
        _, runtime = _H._daily_fresh_read_canonical_json(source_dir / 'source-runtime.json',
            '独立 PDF 引文来源元数据', 64 * 1024 * 1024)
        source = paper['analysisManifest']['sourceAcquisition']
        artifacts = _H._reader_source_payload_artifacts(
            paper['apiReaderPlan'].get('structuredSourcePayload'),
            source['structuredArtifactsSha256'], paper['sourceSha256'])
        if artifacts != {key: value for key, value in runtime['structuredArtifacts'].items()
                         if key != 'payloadSha256'}:
            raise _H.PublishDataValidationError('独立 PDF 引文输入与封存结构化来源不一致。')
        pdf_file = source_dir / 'source.pdf'
        pdf_bytes = _H._daily_fresh_read_private_file(pdf_file, '独立 PDF 引文来源文件', 64 * 1024 * 1024)
        document = header = None
        if sum(len(binding.get('sealedPdfQuoteEvidence', []))
               for binding in marked if isinstance(binding.get('sealedPdfQuoteEvidence'), list)) > 64:
            raise _H.PublishDataValidationError('独立 PDF 引文总数超过来源核验上限。')
        source_text = _H._daily_fresh_read_private_file(source_dir / 'source.txt',
            '独立 PDF 引文对应 HTML 全文', 64 * 1024 * 1024).decode('utf-8')
        result = {}
        for binding in marked:
            index = binding.get('tableIndex')
            quotes = binding['sealedPdfQuoteEvidence']
            if (binding.get('sourceType') != 'source_quotes' or type(index) is not int
                    or index < 1 or index in result or not isinstance(quotes, list)
                    or not 1 <= len(quotes) <= 64):
                raise _H.PublishDataValidationError('独立 PDF 引文只能绑定唯一序号的逐字引文表格。')
            actual_quotes = []
            html_quotes = binding.get('sourceQuotes')
            if not isinstance(html_quotes, list) or any(
                    not isinstance(item, dict) or set(item) != {'quote', 'sourceQuoteSha256'}
                    or not isinstance(item.get('quote'), str) or not 12 <= len(item['quote']) <= 4000
                    or item['quote'] not in source_text or item.get('sourceQuoteSha256')
                    != _H._javascript_string_sha256(item['quote']) for item in html_quotes):
                raise _H.PublishDataValidationError('混合来源的 HTML 引文未逐字对应封存全文。')
            for saved in quotes:
                if not isinstance(saved, dict) or not isinstance(saved.get('quote'), str):
                    raise _H.PublishDataValidationError('独立 PDF 引文格式不完整。')
                declared = saved_header(saved, QUOTE)
                if document is None:
                    header, document = declared, extract_pdf_quote_document(pdf_bytes, declared)
                if declared != header or quote_evidence(document, saved['quote']) != saved:
                    raise _H.PublishDataValidationError('独立 PDF 引文不能由封存原文件完整重放。')
                actual_quotes.append(saved['quote'])
            result[index] = actual_quotes
            if scientific_capabilities is not None:
                capability = _H._ReaderScientificPdfQuoteCapability()
                _H._READER_SCIENTIFIC_PDF_QUOTES[capability] = {'binding': binding,
                    'bindingSha256': _H._stable_json_sha256(binding), 'paper': paper,
                    'articleSha256': _H._javascript_string_sha256(paper.get('apiReaderArticle', '')),
                    'sourceAcquisitionSha256': _H._stable_json_sha256(paper.get('analysisManifest', {}).get('sourceAcquisition')),
                    'runDir': run_dir, 'paperId': paper_id, 'provenance': copy.deepcopy(proof),
                    'pdfFile': pdf_file, 'pdfBytes': pdf_bytes, 'document': copy.deepcopy(document), 'proofs': copy.deepcopy(quotes)}
                scientific_capabilities[index] = capability
        return result


def _reader_merged_caption_unit_coverage(rendered, quotes, tables, *, hooks: Mapping | None = None):
    """Only a complete original merged DOM grid and exact caption metric path."""
    with _hooks_scope(hooks):
        import unicodedata
        def text(value):
            value = unicodedata.normalize('NFKC', _H._normalize_api_reader_source_cell(str(value or '')))
            return re.sub(r'\s+', ' ', re.sub(r'[*_`]', '', value)).strip()
        def compact(value):
            return re.sub(r'\s+', '', text(value))
        def caption_text(value):
            return re.sub(r'\(ρ×(\d+(?:\.\d+)?)\\rho\\times\s*\1\)', lambda m: '(\\rho\\times ' + m[1] + ')', text(value))
        def numbers(value):
            match = re.fullmatch(r'([+-]?\d+(?:\.\d+)?)(?:±(\d+(?:\.\d+)?))?', compact(value))
            if not match:
                return None
            result = []
            for part in match.groups():
                if part is None:
                    continue
                integer, _, fraction = part.lstrip('+').partition('.')
                negative = integer.startswith('-')
                integer, fraction = integer.lstrip('-').lstrip('0') or '0', fraction.rstrip('0')
                result.append(('-' if negative and (integer != '0' or fraction) else '') + integer + ('.' + fraction if fraction else ''))
            return result
        def expanded_grid(table):
            matrix, cells = table.get('matrix'), table.get('cells')
            if (table.get('recoveryStatus') != 'complete' or type(table.get('ordinal')) is not int or table['ordinal'] < 1
                    or not re.fullmatch(r'[a-f0-9]{64}', table.get('sourceDomSha256', ''))
                    or not isinstance(matrix, list) or not 3 <= len(matrix) <= 65 or not isinstance(matrix[0], list)
                    or not 3 <= len(matrix[0]) <= 16 or not isinstance(cells, list) or len(cells) > len(matrix) * len(matrix[0])
                    or any(not isinstance(row, list) or len(row) != len(matrix[0]) or any(not isinstance(v, str) for v in row) for row in matrix)):
                return None
            grid = [[None] * len(matrix[0]) for _ in matrix]
            for cell in cells:
                if (not isinstance(cell, dict) or any(type(cell.get(key)) is not int for key in ['row', 'column', 'rowspan', 'colspan'])
                        or cell['row'] < 0 or cell['column'] < 0 or cell['rowspan'] < 1 or cell['colspan'] < 1
                        or cell['row'] + cell['rowspan'] > len(matrix) or cell['column'] + cell['colspan'] > len(matrix[0])
                        or not isinstance(cell.get('text'), str) or not re.fullmatch(r'[a-f0-9]{64}', cell.get('sourceDomSha256', ''))):
                    return None
                for r in range(cell['row'], cell['row'] + cell['rowspan']):
                    for c in range(cell['column'], cell['column'] + cell['colspan']):
                        if grid[r][c] is not None or matrix[r][c] != cell['text']:
                            return None
                        grid[r][c] = cell
            if any(cell is None for row in grid for cell in row):
                return None
            first = grid[0][0]
            height = first['rowspan']
            if (first['row'] != 0 or first['column'] != 0 or first['colspan'] != 1 or first.get('header') is not True or text(first['text']) != 'Method'
                    or not 2 <= height <= 4 or height >= len(grid)
                    or any(cell['row'] < height < cell['row'] + cell['rowspan'] for cell in cells)):
                return None
            paths = []
            for column in range(len(matrix[0])):
                path = []
                for row in grid[:height]:
                    if all(cell is not row[column] for cell in path):
                        path.append(row[column])
                paths.append(path)
            return grid, height, paths
        headers, rows = rendered.get('header', []), rendered.get('rows', [])
        if len(headers) < 2 or not rows or any(not isinstance(row, list) or len(row) != len(headers) for row in rows):
            return set()
        quote_strings = [caption_text(quote) for quote in quotes if isinstance(quote, str)]
        result = set()
        for column in range(1, len(headers)):
            match = re.fullmatch(r'(.+?)\s*\(%\)', re.sub('[↑↓]', '', text(headers[column])))
            if not match or sum(compact(value) == compact(headers[column]) for value in headers) != 1:
                continue
            wanted, candidates = compact(match[1]), []
            for table in tables:
                expanded, caption = expanded_grid(table), caption_text(table.get('caption', ''))
                if (not expanded or len(caption) < 24 or not any(caption in quote for quote in quote_strings)
                        or compact(headers[0]) != compact(expanded[0][0][0]['text'])):
                    continue
                grid, height, paths = expanded
                declarations = [(compact(m[1].removesuffix('.')), m[2].strip())
                    for m in re.finditer(r'\(([A-Za-z][A-Za-z0-9 ._-]{0,63}?),\s*([^()]{1,16})\)', caption)]
                for source_column, path in enumerate(paths[1:], 1):
                    leaf = path[-1]
                    if (len(path) < 2 or leaf['row'] != height - 1 or leaf['rowspan'] != 1 or leaf['colspan'] != 1
                            or any(not text(cell['text']) for cell in path) or ''.join(compact(cell['text']) for cell in path) != wanted):
                        continue
                    declaration = [unit for metric, unit in declarations if metric == compact(leaf['text'])]
                    if declaration != ['%'] or sum(''.join(compact(cell['text']) for cell in p) == wanted for p in paths) != 1:
                        continue
                    candidates.append((table, grid, height, source_column))
            if len(candidates) != 1:
                continue
            table, grid, height, source_column = candidates[0]
            for row, values in enumerate(rows):
                row_name, rendered_values = text(values[0]), numbers(values[column])
                if not row_name or not rendered_values:
                    continue
                matches = [(r, cells) for r, cells in enumerate(grid[height:], height) if text(cells[0]['text']) == row_name]
                if len(matches) != 1:
                    continue
                source_row, cells = matches[0]
                label, cell = cells[0], cells[source_column]
                if (any(item['row'] != source_row or item['rowspan'] != 1 or item['colspan'] != 1 for item in [label, cell])
                        or cell['column'] != source_column or compact(cell['text']) != compact(values[column])):
                    continue
                result.update((row + 1, column, value, '%') for value in rendered_values)
        return result


def _reader_merged_accuracy_unit_coverage(rendered, quotes, tables, *, hooks: Mapping | None = None):
    """Exact Accuracy (%) parent, split leaf and Model+Optimizer identity."""
    with _hooks_scope(hooks):
        def text(value):
            return re.sub(r'\s+', ' ', re.sub(r'[*_`]', '', _H._normalize_api_reader_source_cell(str(value or '')))).strip()
        def compact(value):
            return re.sub(r'\s+', '', text(value))
        def leaf_name(value):
            return compact(re.sub(r'^Δ\\Delta(?=\s|$)', 'Δ', text(value)))
        def row_name(value, markdown=False):
            raw = re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', _H._normalize_api_reader_display_artifacts(str(value or '')))).strip()
            if markdown:
                for wrapper in ['**', '__', '`', '*', '_']:
                    if len(raw) > len(wrapper) * 2 and raw.startswith(wrapper) and raw.endswith(wrapper):
                        raw = raw[len(wrapper):-len(wrapper)].strip()
                        break
            return raw
        def numbers(value):
            match = re.fullmatch(r'([+-]?\d+(?:\.\d+)?)(?:±(\d+(?:\.\d+)?))?', compact(value))
            if not match:
                return None
            result = []
            for part in match.groups():
                if part is None:
                    continue
                integer, _, fraction = part.lstrip('+').partition('.')
                negative = integer.startswith('-')
                integer, fraction = integer.lstrip('-').lstrip('0') or '0', fraction.rstrip('0')
                result.append(('-' if negative and (integer != '0' or fraction) else '') + integer + ('.' + fraction if fraction else ''))
            return result
        def expanded(table):
            matrix, cells = table.get('matrix'), table.get('cells')
            if (table.get('recoveryStatus') != 'complete' or type(table.get('ordinal')) is not int or table['ordinal'] < 1
                    or not re.fullmatch(r'[a-f0-9]{64}', table.get('sourceDomSha256', ''))
                    or not isinstance(matrix, list) or not 3 <= len(matrix) <= 65 or not isinstance(matrix[0], list)
                    or not 3 <= len(matrix[0]) <= 16 or not isinstance(cells, list) or len(cells) > len(matrix) * len(matrix[0])
                    or any(not isinstance(row, list) or len(row) != len(matrix[0]) or any(not isinstance(v, str) for v in row) for row in matrix)):
                return None
            grid = [[None] * len(matrix[0]) for _ in matrix]
            for cell in cells:
                if (not isinstance(cell, dict) or any(type(cell.get(k)) is not int for k in ['row', 'column', 'rowspan', 'colspan'])
                        or cell['row'] < 0 or cell['column'] < 0 or cell['rowspan'] < 1 or cell['colspan'] < 1
                        or cell['row'] + cell['rowspan'] > len(matrix) or cell['column'] + cell['colspan'] > len(matrix[0])
                        or not isinstance(cell.get('text'), str) or not re.fullmatch(r'[a-f0-9]{64}', cell.get('sourceDomSha256', ''))):
                    return None
                for row in range(cell['row'], cell['row'] + cell['rowspan']):
                    for column in range(cell['column'], cell['column'] + cell['colspan']):
                        if grid[row][column] is not None or matrix[row][column] != cell['text']:
                            return None
                        grid[row][column] = cell
            return grid if all(cell is not None for row in grid for cell in row) else None
        headers, rows = rendered.get('header', []), rendered.get('rows', [])
        if (len(headers) < 3 or not rows or any(not isinstance(row, list) or len(row) != len(headers) for row in rows)
                or text(headers[0]) not in ['Model', '模型'] or text(headers[1]) not in ['Optimizer', '优化器']):
            return set()
        quote_strings, result = [text(value) for value in quotes if isinstance(value, str)], set()
        for column in range(2, len(headers)):
            match = re.fullmatch(r'(.+?)\s+Accuracy\s*\(%\)', text(headers[column]))
            if not match or sum(compact(value) == compact(headers[column]) for value in headers) != 1:
                continue
            candidates = []
            for table in tables:
                grid, caption = expanded(table), re.split(r'(?<=\.)\s', text(table.get('caption', '')))[0]
                if not grid or len(caption) < 24 or not any(caption in quote for quote in quote_strings):
                    continue
                model, optimizer, parent = grid[0][:3]
                if (model['row'] != 0 or model['column'] != 0 or model['rowspan'] != 2 or model['colspan'] != 1
                        or model.get('header') is not True or text(model['text']) != 'Model'
                        or optimizer['row'] != 0 or optimizer['column'] != 1 or optimizer['rowspan'] != 2 or optimizer['colspan'] != 1
                        or optimizer.get('header') is not True or text(optimizer['text']) != 'Optimizer'
                        or parent['row'] != 0 or parent['column'] != 2 or parent['rowspan'] != 1
                        or parent['colspan'] != len(grid[0]) - 2 or parent.get('header') is not True
                        or text(parent['text']) != 'Accuracy (%)' or any(cell is not parent for cell in grid[0][2:])):
                    continue
                leaves = grid[1][2:]
                if any(cell['row'] != 1 or cell['column'] != index + 2 or cell['rowspan'] != 1 or cell['colspan'] != 1
                       or cell.get('header') is not True or not text(cell['text']) for index, cell in enumerate(leaves)):
                    continue
                # Select one complete original table, never borrow split leaves.
                wanted_headers = [leaf_name(re.sub(r'\s+Accuracy\s*\(%\)$', '', text(header))) for header in headers[2:]]
                if (len(headers) != len(grid[0]) or any(leaf_name(leaves[index]['text']) != wanted
                        or sum(leaf_name(cell['text']) == wanted for cell in leaves) != 1
                        for index, wanted in enumerate(wanted_headers))):
                    continue
                if any(not row_name(values[0], True) or not row_name(values[1], True) or sum(
                        row_name(cells[0]['text']) == row_name(values[0], True) and row_name(cells[1]['text']) == row_name(values[1], True)
                        for cells in grid[2:]) != 1 for values in rows):
                    continue
                matching = [cell for cell in leaves if compact(cell['text']) == compact(match[1])]
                if len(matching) == 1:
                    candidates.append((grid, matching[0]))
            if len(candidates) != 1:
                continue
            grid, leaf = candidates[0]
            for row, values in enumerate(rows):
                rendered_values = numbers(values[column])
                if not rendered_values or not row_name(values[0], True) or not row_name(values[1], True):
                    continue
                matching = [(index, cells) for index, cells in enumerate(grid[2:], 2)
                            if row_name(cells[0]['text']) == row_name(values[0], True) and row_name(cells[1]['text']) == row_name(values[1], True)]
                if len(matching) != 1:
                    continue
                source_row, cells = matching[0]
                model, optimizer, cell = cells[0], cells[1], cells[leaf['column']]
                if (model['column'] != 0 or model['colspan'] != 1 or optimizer['row'] != source_row or optimizer['column'] != 1
                        or optimizer['rowspan'] != 1 or optimizer['colspan'] != 1 or cell['row'] != source_row
                        or cell['column'] != leaf['column'] or cell['rowspan'] != 1 or cell['colspan'] != 1
                        or numbers(cell['text']) != rendered_values):
                    continue
                result.update((row + 1, column, value, '%') for value in rendered_values)
        return result


def _reader_full_width_body_bands(table, *, hooks: Mapping | None = None):
    """Mirror the Reader's complete DOM ownership proof for condition bands."""
    with _hooks_scope(hooks):
        matrix, cells = table.get('matrix'), table.get('cells')
        if (table.get('recoveryStatus') != 'complete' or type(table.get('ordinal')) is not int
                or table['ordinal'] < 1 or not re.fullmatch(r'[a-f0-9]{64}', table.get('sourceDomSha256', ''))
                or not isinstance(matrix, list) or not 3 <= len(matrix) <= 65
                or not isinstance(matrix[0], list) or not 3 <= len(matrix[0]) <= 16
                or any(not isinstance(row, list) or len(row) != len(matrix[0])
                       or any(not isinstance(value, str) for value in row) for row in matrix)
                or not isinstance(cells, list) or len(cells) > len(matrix) * len(matrix[0])):
            return False
        width = len(matrix[0])
        grid = [[None] * width for _ in matrix]
        for cell in cells:
            if (not isinstance(cell, dict)
                    or any(type(cell.get(key)) is not int for key in ('row', 'column', 'rowspan', 'colspan'))
                    or cell['row'] < 0 or cell['column'] < 0 or cell['rowspan'] < 1 or cell['colspan'] < 1
                    or cell['row'] + cell['rowspan'] > len(matrix) or cell['column'] + cell['colspan'] > width
                    or not isinstance(cell.get('text'), str)
                    or not re.fullmatch(r'[a-f0-9]{64}', cell.get('sourceDomSha256', ''))):
                return False
            for row in range(cell['row'], cell['row'] + cell['rowspan']):
                for column in range(cell['column'], cell['column'] + cell['colspan']):
                    if grid[row][column] is not None or matrix[row][column] != cell['text']:
                        return False
                    grid[row][column] = cell
        if any(cell is None for row in grid for cell in row):
            return False
        if any(cell['row'] != 0 or cell['rowspan'] != 1 or cell['colspan'] != 1 for cell in grid[0]):
            return False
        bands = 0
        for row in range(1, len(grid)):
            owners = {id(cell) for cell in grid[row]}
            first = grid[row][0]
            if (len(owners) == 1 and first['row'] == row and first['column'] == 0
                    and first['rowspan'] == 1 and first['colspan'] == width
                    and re.sub(r'[*_`\s]', '', _H._normalize_api_reader_source_cell(first['text']))):
                if row + 1 == len(grid) or len({id(cell) for cell in grid[row + 1]}) == 1:
                    return False
                bands += 1
            elif (len(owners) != width or any(cell['row'] != row or cell['column'] != column
                    or cell['rowspan'] != 1 or cell['colspan'] != 1 for column, cell in enumerate(grid[row]))):
                return False
        return bands > 0


def _reader_dom_table_unit_coverage(rendered, quotes, tables, *, hooks: Mapping | None = None):
    """Original DOM columns, exact rows and values, plus bounded merged paths."""
    with _hooks_scope(hooks):
        def text(value):
            return re.sub(r'\s+', ' ', re.sub(r'[*_`]', '', _H._normalize_api_reader_source_cell(str(value or '')))).strip()
        def compact(value):
            return re.sub(r'\s+', '', text(value))
        def decimal(value):
            integer, _, fraction = value.lstrip('+').partition('.')
            negative = integer.startswith('-')
            integer = integer.lstrip('-').lstrip('0') or '0'
            fraction = fraction.rstrip('0')
            return ('-' if negative and (integer != '0' or fraction) else '') + integer + ('.' + fraction if fraction else '')
        def numbers(value):
            match = re.fullmatch(r'([+-]?\d+(?:\.\d+)?)(?:±(\d+(?:\.\d+)?))?', compact(value))
            return [decimal(value) for value in match.groups() if value is not None] if match else None
        def row_identity(value):
            # 原表行标签会把可见文本再附一遍同名 TeX 注释；只在“可见前缀 + 带 TeX 标记
            # 的后缀”边界上折叠，两半去掉命令与花括号后须逐字相同，单个 \mathrm{1010} 不折叠。
            folded = compact(value)
            plain = lambda text: re.sub(r'\\[A-Za-z]+', '', text).replace('{', '').replace('}', '')
            for index in range(1, len(folded)):
                visible, annotated = folded[:index], folded[index:]
                if '\\' in visible or '\\' not in annotated:
                    continue
                if plain(annotated) == visible:
                    return visible
            return folded
        headers, rows = rendered.get('header', []), rendered.get('rows', [])
        if len(headers) < 2 or not rows or any(not isinstance(row, list) or len(row) != len(headers) for row in rows):
            return set()
        quote_strings = [text(quote) for quote in quotes if isinstance(quote, str)]
        result = set()
        for column in range(1, len(headers)):
            header = re.sub('[↑↓]', '', compact(headers[column]))
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9 ._\-\[\]]*\(%\)', header):
                continue
            candidates = []
            for table in tables:
                matrix, cells = table.get('matrix'), table.get('cells')
                if (table.get('recoveryStatus') != 'complete' or not re.fullmatch(r'[a-f0-9]{64}', table.get('sourceDomSha256', ''))
                        or not isinstance(matrix, list) or len(matrix) < 2 or not isinstance(cells, list)
                        or any(not re.fullmatch(r'[a-f0-9]{64}', cell.get('sourceDomSha256', '')) for cell in cells)
                        or (any(cell.get('rowspan') != 1 or cell.get('colspan') != 1 for cell in cells)
                            and not _H._reader_full_width_body_bands(table))
                        or any(not isinstance(row, list) or len(row) != len(headers) for row in matrix)):
                    continue
                caption = re.split(r'(?<=\.)\s', text(table.get('caption', '')))[0]
                if (len(caption) >= 24 and any(caption in quote for quote in quote_strings)
                        and compact(matrix[0][0]) == compact(headers[0]) and compact(matrix[0][column]) == compact(headers[column])):
                    candidates.append(table)
            if len(candidates) != 1:
                continue
            source = candidates[0]
            if sum(re.sub('[↑↓]', '', compact(value)) == header for value in source['matrix'][0]) != 1:
                continue
            header_cells = [cell for cell in source['cells'] if cell.get('row') == 0 and cell.get('column') == column]
            if len(header_cells) != 1 or compact(header_cells[0]['text']) != compact(source['matrix'][0][column]):
                continue
            for row, values in enumerate(rows):
                row_name, rendered_values = row_identity(values[0]), numbers(values[column])
                if not row_name or not rendered_values:
                    continue
                matches = [(index + 1, value) for index, value in enumerate(source['matrix'][1:]) if row_identity(value[0]) == row_name]
                if len(matches) != 1:
                    continue
                source_row, source_values = matches[0]
                if numbers(source_values[column]) != rendered_values:
                    continue
                cells = [cell for cell in source['cells'] if cell.get('row') == source_row and cell.get('column') in [0, column]]
                if len(cells) != 2 or any(compact(cell['text']) != compact(source_values[cell['column']]) for cell in cells):
                    continue
                result.update((row + 1, column, value, '%') for value in rendered_values)
        return (result | _H._reader_merged_caption_unit_coverage(rendered, quotes, tables)
                | _H._reader_merged_accuracy_unit_coverage(rendered, quotes, tables))


def _reader_dom_column_unit_coverage(paper, rendered, binding, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        proof = paper.get('freshRewriteProvenance') or {}
        if not is_fresh_source_provenance(proof):
            return set()
        run_id = proof.get('runId')
        if not isinstance(run_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            return set()
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        if not (run_dir / 'run.json').exists():
            return set()
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, 'DOM列单位来源根目录')
        _H._daily_fresh_safe_directory(run_dir, 'DOM列单位运行目录')
        _, run = _H._daily_fresh_read_canonical_json(run_dir / 'run.json', 'DOM列单位运行清单', 64 * 1024 * 1024)
        if not is_daily_source_run(run) or run.get('runId') != run_id:
            return set()
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
        source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
        _, runtime = _H._daily_fresh_read_canonical_json(source_dir / 'source-runtime.json', 'DOM列单位结构化来源', 64 * 1024 * 1024)
        source = paper['analysisManifest']['sourceAcquisition']
        artifacts = _H._reader_source_payload_artifacts(paper['apiReaderPlan'].get('structuredSourcePayload'), source['structuredArtifactsSha256'], paper['sourceSha256'])
        if artifacts != {key: value for key, value in runtime['structuredArtifacts'].items() if key != 'payloadSha256'}:
            raise _H.PublishDataValidationError('DOM列单位与封存结构化来源不一致。')
        source_text = _H._daily_fresh_read_private_file(source_dir / 'source.txt', 'DOM列单位原文', 64 * 1024 * 1024).decode('utf-8')
        quotes = [item['quote'] for item in binding.get('sourceQuotes', []) if isinstance(item, dict) and isinstance(item.get('quote'), str) and item['quote'] in source_text]
        covered = _H._reader_dom_table_unit_coverage(rendered, quotes, artifacts['tables'])
        if binding.get('sealedPdfQuoteEvidence') and any(
                table.get('matrix') and table['matrix'][0] and table['matrix'][0][0] == ''
                and len(table['matrix']) > 2 and str(table['matrix'][2][0]).strip().startswith('(')
                for table in artifacts['tables']):
            # Replay the actual sealed quotations here too: callers cannot grant
            # column units with copied proof objects or unverified PDF strings.
            verified_quotes = _H._verify_reader_sealed_pdf_quote_bindings(paper).get(binding.get('tableIndex'), [])
            from reader_grouped_vector_column_units import coverage as grouped_coverage
            covered |= grouped_coverage(rendered, quotes, verified_quotes, artifacts['tables'],
                                        _H._normalize_api_reader_source_cell)
        return covered


def _reader_sealed_pdf_column_unit_coverage(paper, rendered, binding, *, hooks: Mapping | None = None):
    """Only a replayed full PDF matrix can assign a bare value its column unit."""
    with _hooks_scope(hooks):
        from reader_pdf_column_unit_projection import project_pdf_bytes
        saved_quotes = binding.get('sealedPdfQuoteEvidence')
        if not isinstance(saved_quotes, list) or not saved_quotes:
            return set()
        proof = paper.get('freshRewriteProvenance') or {}
        run_id = proof.get('runId')
        if not isinstance(run_id, str) or not re.fullmatch(
                r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id):
            raise _H.PublishDataValidationError('列单位缺少封存来源运行。')
        run_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id
        _H._daily_fresh_safe_directory(_H.DAILY_FRESH_SOURCE_RUNS_DIR, '列单位来源根目录')
        _H._daily_fresh_safe_directory(run_dir, '列单位来源运行目录')
        paper_id = _H._daily_fresh_normalized_paper_id(paper)
        _H._daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)
        source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
        _, runtime = _H._daily_fresh_read_canonical_json(source_dir / 'source-runtime.json',
            '列单位结构化来源', 64 * 1024 * 1024)
        source = paper['analysisManifest']['sourceAcquisition']
        artifacts = _H._reader_source_payload_artifacts(paper['apiReaderPlan'].get('structuredSourcePayload'),
            source['structuredArtifactsSha256'], paper['sourceSha256'])
        if artifacts != {key: value for key, value in runtime['structuredArtifacts'].items()
                         if key != 'payloadSha256'}:
            raise _H.PublishDataValidationError('列单位的完整原表与封存结构化来源不一致。')
        pdf_bytes = _H._daily_fresh_read_private_file(source_dir / 'source.pdf',
            '列单位来源 PDF', 64 * 1024 * 1024)
        try:
            actual = project_pdf_bytes(pdf_bytes, artifacts['tables'],
                [rendered['header']] + rendered['rows'], [item['quote'] for item in saved_quotes])['originalProof']
        except ValueError:
            return set()
        return {(row + 1, column['column'], token, column['unit'])
                for column in actual['units'] for row, value in enumerate(column['values'])
                for token in _H._api_reader_numeric_tokens(value)}


def _replay_authenticated_pdf_table_bindings(paper, *, hooks: Mapping | None = None):
    """Only the shared private-FD worker can reopen a canonical authenticated source."""
    with _hooks_scope(hooks):
        from publication_local_replay import publication_replay_result, checked_replay_response
        same_render = publication_replay_result(paper)
        if same_render is not None:
            if not isinstance(same_render.get('tableEvidence'), dict):
                raise _H.PublishDataValidationError('同次真实来源重放缺少表格证明。')
            return same_render['tableEvidence']
        node = shutil.which('node')
        if not node:
            raise _H.PublishDataValidationError('PDF 表格原来源冷重放需要 Node.js。')
        payload = _H._daily_fresh_compact_json_bytes({'paper': paper, 'authenticatedPdfTables': True})
        if len(payload) > 128 * 1024 * 1024:
            raise _H.PublishDataValidationError('PDF 表格原来源冷重放输入超过上限。')
        cli = _H.SHARED_SCRIPTS_DIR / 'lib' / 'reader-resource-claims-replay-cli.js'
        replay_env = {key: value for key, value in os.environ.items() if key not in {'NODE_OPTIONS', 'NODE_PATH'}}
        replay_runner = _H.get("_run_node_replay_cli")
        if replay_runner is not None:
            result = replay_runner(
                cli, payload, node=node, cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                env=replay_env, timeout_seconds=180, max_output_bytes=1024 * 1024,
            )
        else:
            with tempfile.TemporaryFile() as source:
                source.write(payload); source.flush(); source.seek(0)
                result = _H._run_bounded_subprocess([node, str(cli),
                    str(source.fileno())], cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                    env=replay_env,
                    timeout_seconds=180, max_output_bytes=1024 * 1024, pass_fds=(source.fileno(),))
        response = checked_replay_response(result, worker='reader-resource-claims-replay-cli.js', timeout_seconds=180)
        if response.get('verified') is not True \
                or not isinstance(response.get('tableEvidence'), dict):
            raise _H.PublishDataValidationError('PDF 表格证明未由同一原规范来源冷重放。')
        return response['tableEvidence']


def _validate_api_reader_source_bindings(paper, article=None, *, publication_table_evidence=None, hooks: Mapping | None = None):
    """按 v4 来源记录核对读者文章中的表格和公式，并返回核验结果。"""
    with _hooks_scope(hooks):
        manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        contracts = contracts if isinstance(contracts, dict) else {}
        stage = (manifest.get('stages') or {}).get('apiReaderArticle') \
            if isinstance(manifest, dict) else None
        stage = stage if isinstance(stage, dict) else {}
        source = manifest.get('sourceAcquisition') if isinstance(manifest, dict) else None
        plan = paper.get('apiReaderPlan') if isinstance(paper, dict) else None
        article = paper.get('apiReaderArticle') if article is None and isinstance(paper, dict) else article
        if isinstance(article, str) and '原文中没有可逐字绑定的数值证据' in article:
            raise _H.PublishDataValidationError(
                '读者文章中仍有内部绑定失败占位说明，请修复正文后重新生成页面。'
            )
        if not isinstance(plan, dict) or not isinstance(stage, dict) \
                or not isinstance(source, dict) or not isinstance(article, str):
            raise _H.PublishDataValidationError('读者文章的编辑计划、阶段记录、来源记录或正文缺失，或格式无效。')
        if re.search(r'\[\[FORMULA_\d+\]\]', article):
            raise _H.PublishDataValidationError('读者文章中仍有未对应原文公式的占位符。')
        if not reader_formats.validate_bindings(contracts, stage, plan):
            raise _H.PublishDataValidationError('读者文章的表格与公式来源记录未采用 v4 规则。')

        table_bindings = plan.get('tableBindings')
        formula_bindings = plan.get('formulaBindings')
        if not isinstance(table_bindings, list) or not isinstance(formula_bindings, list):
            raise _H.PublishDataValidationError('读者文章的表格或公式来源记录必须是列表。')
        if publication_table_evidence is None and any(isinstance(binding, dict)
                and 'authenticatedPdfTableEvidence' in binding for binding in table_bindings):
            publication_table_evidence = _H._replay_authenticated_pdf_table_bindings(paper)
        bindings_sha = _H._stable_json_sha256({
            'tableBindings': table_bindings,
            'formulaBindings': formula_bindings,
        })
        source_sha = source.get('sourceSha256')
        structured_sha = source.get('structuredArtifactsSha256')
        if plan.get('sourceBindingsSha256') != bindings_sha \
                or stage.get('sourceBindingsSha256') != bindings_sha:
            raise _H.PublishDataValidationError('读者文章的表格或公式来源记录 SHA 与编辑计划或阶段记录不一致。')
        if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')) \
                or paper.get('sourceSha256') != source_sha \
                or stage.get('sourceBindingsSourceTextSha256') != source_sha:
            raise _H.PublishDataValidationError('Reader 所用论文全文的 SHA 缺失、格式无效，或与论文记录、当前阶段的来源记录不一致。')
        if not re.fullmatch(r'[0-9a-f]{64}', str(structured_sha or '')) \
                or stage.get('structuredArtifactsSha256') != structured_sha:
            raise _H.PublishDataValidationError('论文结构化证据的 SHA 缺失、格式无效，或与读者文章阶段记录不一致。')
        if stage.get('tableBindingCount') != len(table_bindings) \
                or stage.get('formulaBindingCount') != len(formula_bindings):
            raise _H.PublishDataValidationError('读者文章的表格或公式来源记录条数与阶段记录不一致。')

        _H._verify_reader_scientific_dom_bindings(paper)

        pdf_values = {}
        if any(isinstance(b, dict) and 'pdfCellConfirmation' in b for b in table_bindings):
            import reader_pdf_cell_evidence
            from reader_pdf_visual_audit_cache import verify_saved_bindings_cached
            try:
                legacy_view = {**paper, 'apiReaderPlan': {**plan, 'tableBindings': [
                    binding for binding in table_bindings if 'pdfCellConfirmation' in binding]}}
                pdf_values = verify_saved_bindings_cached(reader_pdf_cell_evidence, legacy_view, _H.DAILY_FRESH_SOURCE_RUNS_DIR)
            except Exception as error:
                raise _H.PublishDataValidationError('封存PDF逐格来源不能重放：' + str(error)) from error
        try:
            generic_pdf_values = _H._verify_reader_sealed_pdf_grid_bindings(paper)
        except Exception as error:
            raise _H.PublishDataValidationError('独立封存 PDF 整表证据不能重放：' + str(error)) from error
        if pdf_values.keys() & generic_pdf_values.keys():
            raise _H.PublishDataValidationError('同一表格不能混用两种 PDF 来源证明。')
        pdf_values.update(generic_pdf_values)
        try:
            scientific_pdf_capabilities = {}
            pdf_quote_values = _H._verify_reader_sealed_pdf_quote_bindings(paper, scientific_capabilities=scientific_pdf_capabilities)
        except Exception as error:
            raise _H.PublishDataValidationError('独立封存 PDF 逐字引文不能重放：' + str(error)) from error

        rendered_tables = _H._api_reader_markdown_tables(article)
        publication_tables = {}
        if publication_table_evidence is not None:
            evidence = publication_table_evidence
            authenticated_pdf = isinstance(evidence, dict) and evidence.get('contract') == 'reader-authenticated-pdf-table-evidence-v1'
            canonical_id = paper.get('directPaperId') or paper.get('id') if authenticated_pdf else paper.get('id')
            if (not isinstance(evidence, dict) or (paper.get('source') != 'conference' and not authenticated_pdf)
                    or evidence.get('paperId') != canonical_id
                    or (authenticated_pdf and evidence.get('sourceTextSha256') != paper.get('sourceSha256'))
                    or evidence.get('readerArticleSha256') != _H._javascript_string_sha256(paper.get('apiReaderArticle', ''))
                    or evidence.get('readerPlanSha256') != paper.get('apiReaderPlanSha256')
                    or not isinstance(evidence.get('tables'), list)
                    or len(evidence['tables']) != len(rendered_tables)):
                raise _H.PublishDataValidationError('会议出版补充引文未绑定原论文、Reader及完整表格集合。')
            for position, record in enumerate(evidence['tables']):
                if (not isinstance(record, dict) or record.get('tableIndex') != position + 1
                        or record.get('tableSha256') != _H._javascript_string_sha256(rendered_tables[position]['markdown'])
                        or not isinstance(record.get('headerUnits'), list)
                        or not isinstance(record.get('numericTokens'), list)
                        or any(not isinstance(token, str) for token in record['numericTokens'])):
                    raise _H.PublishDataValidationError('会议出版补充引文的表格字节、序号或覆盖结果不一致。')
                publication_tables[position + 1] = record
        saved_reader_article = paper.get('apiReaderArticle')
        saved_reader_tables = _H._api_reader_markdown_tables(saved_reader_article) \
            if isinstance(saved_reader_article, str) else rendered_tables
        if len(rendered_tables) != len(table_bindings):
            raise _H.PublishDataValidationError('Reader 正文中的表格数与 plan.tableBindings 条目数不一致。')
        html_blank_span_keys = _H._reader_html_blank_span_keys(paper, article, rendered_tables)
        for index, (binding, rendered) in enumerate(zip(table_bindings, rendered_tables), 1):
            required = {
                'tableIndex', 'sourceType', 'sourceTableOrdinal',
                'renderedTableSha256', 'cellBindings', 'sourceQuotes',
            }
            if not isinstance(binding, dict) or set(binding) not in (required, required | {'sealedPdfQuoteEvidence'}, required | {'authenticatedPdfTableEvidence'}, required | {'sourceTableDomSha256'}, required | {'sourceTableDomSha256', 'pdfCellConfirmation'}, required | {'sourceTableDomSha256', 'sealedPdfTableEvidence'}, required | {'sourceTableDomSha256', 'sealedPdfTableEvidence', 'sealedPdfTableSelection'}):
                raise _H.PublishDataValidationError(f'表格来源记录 tableBindings[{index - 1}] 格式无效、缺少必要字段，或含有不允许的字段。')
            if 'authenticatedPdfTableEvidence' in binding:
                proof = binding['authenticatedPdfTableEvidence']
                replayed = publication_tables.get(index, {})
                if (binding.get('sourceType') != 'source_quotes' or not isinstance(proof, dict)
                        or proof.get('contract') != 'reader-authenticated-pdf-table-evidence-v1'
                        or replayed.get('authenticatedPdfProofVerified') is not True
                        or replayed.get('authenticatedPdfEvidenceSha256') != proof.get('evidenceSha256')
                        or not re.fullmatch(r'[a-f0-9]{64}', str(proof.get('evidenceSha256') or ''))):
                    raise _H.PublishDataValidationError('PDF 表格证明必须由同一原规范来源冷重放，不能仅凭 JSON 声明通过。')
            saved_rendered_table = saved_reader_tables[index - 1] \
                if index <= len(saved_reader_tables) else None
            if binding.get('tableIndex') != index or saved_rendered_table is None \
                    or binding.get('renderedTableSha256') != _H._javascript_string_sha256(
                        saved_rendered_table['markdown']
                    ):
                raise _H.PublishDataValidationError(f'第 {index} 个表格的序号、保存正文中的表格或渲染 SHA 与来源记录不一致。')
            rendered_rows = [rendered['header'], *rendered['rows']]
            if binding.get('sourceType') == 'artifact_table':
                if set(binding) not in (required | {'sourceTableDomSha256'}, required | {'sourceTableDomSha256', 'pdfCellConfirmation'}, required | {'sourceTableDomSha256', 'sealedPdfTableEvidence'}, required | {'sourceTableDomSha256', 'sealedPdfTableEvidence', 'sealedPdfTableSelection'}) \
                        or not isinstance(binding.get('sourceTableOrdinal'), int) \
                        or isinstance(binding.get('sourceTableOrdinal'), bool) \
                        or binding['sourceTableOrdinal'] < 1 \
                        or not re.fullmatch(r'[0-9a-f]{64}', str(binding.get('sourceTableDomSha256') or '')) \
                        or binding.get('sourceQuotes') != [] \
                        or not isinstance(binding.get('cellBindings'), list):
                    raise _H.PublishDataValidationError(f'第 {index} 个表格的原表来源记录缺失或不符合要求。')
                expected_cells = sum(len(row) for row in rendered_rows)
                if len(binding['cellBindings']) != expected_cells:
                    raise _H.PublishDataValidationError(f'第 {index} 个表格的单元格来源记录条数与显示的单元格数不一致。')
                seen = set()
                for cell_index, cell in enumerate(binding['cellBindings']):
                    cell_keys = {
                        'renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn',
                        'renderedText', 'sourceText', 'sourceDomSha256',
                    }
                    if not isinstance(cell, dict) or set(cell) != cell_keys:
                        raise _H.PublishDataValidationError(
                            f'第 {index} 个表格的单元格记录 cellBindings[{cell_index}] 格式无效、缺少必要字段，或含有不允许的字段。'
                        )
                    coordinates = [cell.get(key) for key in (
                        'renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn',
                    )]
                    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0
                           for value in coordinates):
                        raise _H.PublishDataValidationError(f'第 {index} 个表格的单元格坐标必须是非负整数。')
                    rendered_row, rendered_column = coordinates[:2]
                    key = (rendered_row, rendered_column)
                    if key in seen or rendered_row >= len(rendered_rows) \
                            or rendered_column >= len(rendered_rows[rendered_row]):
                        raise _H.PublishDataValidationError(f'第 {index} 个表格的单元格来源记录重复，或显示坐标超出表格范围。')
                    actual_text = rendered_rows[rendered_row][rendered_column]
                    # Decode only this publication-view cell, after the canonical
                    # table hash was checked. Source/renderedText retain their raw
                    # backslashes and the ordinary strict source normalizer.
                    display_source_text = decode_publish_currency_unit_display(actual_text) \
                        if article is not None and isinstance(cell.get('renderedText'), str) \
                        and is_publish_currency_unit_literal(cell['renderedText']) else actual_text
                    canonical_comparison_text = cell.get('renderedText')
                    if is_publication_technical_asterisk_cell_view(canonical_comparison_text, actual_text, cell.get('sourceText')):
                        # Exact published view only; source text, DOM identity,
                        # canonical table/article hashes and all other cells stay strict.
                        display_source_text = canonical_comparison_text
                    math_display = strict_source_cell_math_display(cell.get('sourceText'))
                    if math_display and actual_text == math_display['displayText'] \
                            and canonical_comparison_text in (math_display['sourceText'], math_display['displayText']):
                        # The canonical table SHA above and original source DOM
                        # still bind both copies. Decode only this exact view.
                        canonical_comparison_text = math_display['sourceText']
                        display_source_text = math_display['sourceText']
                    if _H._reader_cell_comparison(canonical_comparison_text) \
                            != _H._reader_cell_comparison(display_source_text) \
                            or (_H._reader_cell_comparison(display_source_text) \
                            != _H._reader_cell_comparison(pdf_values[index][(rendered_row, rendered_column)] if index in pdf_values else cell.get('sourceText')) \
                            and not (_H._reader_merged_cell_matches(paper, binding, cell, display_source_text)
                                if index in pdf_values or not paper.get('freshRewriteProvenance')
                                else (index, rendered_row, rendered_column) in html_blank_span_keys)) \
                            or not re.fullmatch(r'[0-9a-f]{64}', str(cell.get('sourceDomSha256') or '')):
                        raise _H.PublishDataValidationError(
                            f'第 {index} 个表格的单元格文本与显示内容或来源文本不一致，或来源 DOM 的 SHA 无效。'
                            f'（渲染={canonical_comparison_text!r} 显示={display_source_text!r}'
                            f' 来源={cell.get("sourceText")!r}）'
                        )
                    seen.add(key)
                if len(seen) != expected_cells:
                    raise _H.PublishDataValidationError(f'第 {index} 个表格仍有单元格缺少来源记录。')
            elif binding.get('sourceType') == 'source_quotes':
                codec_cells = _H._source_quoted_codec_display_cells(paper, binding, saved_rendered_table)
                codec_raw = r'G.711 μ\mu-law'
                saved_has_codec = any(codec_raw in row for row in saved_rendered_table['rows'])
                if saved_has_codec and (rendered['header'], rendered['rows']) != (
                        saved_rendered_table['header'], saved_rendered_table['rows']):
                    expected = [row.copy() for row in saved_rendered_table['rows']]
                    for (row, column), displayed in codec_cells.items():
                        expected[row - 1][column] = displayed
                    if not codec_cells or rendered['header'] != saved_rendered_table['header'] or rendered['rows'] != expected:
                        raise _H.PublishDataValidationError('来源编码器名称显示不能改变同一表中的其他原值。')
                if set(binding) not in (required, required | {'sealedPdfQuoteEvidence'}, required | {'authenticatedPdfTableEvidence'}) or binding.get('sourceTableOrdinal') is not None \
                        or binding.get('cellBindings') != [] \
                        or not isinstance(binding.get('sourceQuotes'), list) \
                        or not (binding['sourceQuotes'] or pdf_quote_values.get(index)):
                    raise _H.PublishDataValidationError(f'第 {index} 个表格的逐字引文来源记录缺失或不符合要求。')
                quote_corpus = []
                for quote_index, quote_binding in enumerate(binding['sourceQuotes']):
                    if not isinstance(quote_binding, dict) \
                            or set(quote_binding) != {'quote', 'sourceQuoteSha256'} \
                            or not isinstance(quote_binding.get('quote'), str) \
                            or not 12 <= len(quote_binding['quote']) <= 4000 \
                            or quote_binding.get('sourceQuoteSha256') \
                            != _H._javascript_string_sha256(quote_binding['quote']):
                        raise _H.PublishDataValidationError(
                            f'第 {index} 个表格的引文记录 sourceQuotes[{quote_index}] 字段、长度或 SHA 不符合要求。'
                        )
                    quote_corpus.append(quote_binding['quote'])
                quote_corpus.extend(pdf_quote_values.get(index, []))
                unit_failures = _H._reader_table_header_unit_evidence_failures(rendered, quote_corpus)
                if unit_failures:
                    dom_units = _H._reader_dom_column_unit_coverage(paper, rendered, binding)
                    unit_failures = [failure for failure in unit_failures if failure not in dom_units]
                if unit_failures and index in pdf_quote_values:
                    column_units = _H._reader_sealed_pdf_column_unit_coverage(paper, rendered, binding)
                    unit_failures = [failure for failure in unit_failures if failure not in column_units]
                if unit_failures and index in publication_tables:
                    units = publication_tables[index]['headerUnits']
                    unit_failures = [failure for failure in unit_failures if not any(
                        isinstance(unit, dict) and (unit.get('row'), unit.get('column'), unit.get('value'), unit.get('unit')) == failure
                        for unit in units)]
                if unit_failures:
                    raise _H.PublishDataValidationError(f'第 {index} 个表格的列头单位缺少对应原文证据。')
                quote_tokens = (set(_H._api_reader_numeric_tokens('\n'.join(
                    item['quote'] for item in binding['sourceQuotes']))).union(
                    *[set(_H._api_reader_numeric_tokens(quote)) for quote in pdf_quote_values[index]])
                    if index in pdf_quote_values
                    else set(_H._api_reader_numeric_tokens('\n'.join(quote_corpus))))
                scientific_projection = _H._api_reader_scientific_quote_projection(rendered, quote_corpus,
                    scientific_pdf_capability=scientific_pdf_capabilities.get(index), source_binding=binding)
                if scientific_projection['failures']:
                    raise _H.PublishDataValidationError(
                        f'第 {index} 个表格中的完整科学计数量未被本表来源引文精确覆盖：'
                        f"{scientific_projection['failures']}"
                    )
                missing = scientific_projection['tokens'] - quote_tokens
                # 参考文献编号（如 Orig. CFM [37]）不是测量值，不要求数值引文证据；
                # 同一数字若在方括号之外出现，仍按测量值要求证据。
                missing -= _H._reader_citation_only_numeric_tokens(rendered)
                missing -= _H._reader_circled_label_numeric_tokens(rendered)
                if index in publication_tables:
                    missing -= set(publication_tables[index]['numericTokens'])
                if missing:
                    raise _H.PublishDataValidationError(
                        f'第 {index} 个表格中的数字或单位未被来源引文完整覆盖：{sorted(missing)}'
                    )
            else:
                raise _H.PublishDataValidationError(f'第 {index} 个表格的来源类型不符合要求。')

        _H._validate_legacy_reader_dataset_claims(rendered_tables, table_bindings)
        display_blocks = _H._api_reader_display_formula_blocks(article)
        if len(display_blocks) != len(formula_bindings):
            raise _H.PublishDataValidationError('读者文章中的展示公式数量与公式来源记录条数不一致。')
        seen_ordinals = set()
        for index, binding in enumerate(formula_bindings):
            expected_keys = {
                'formulaOrdinal', 'targetKind', 'marker', 'latex',
                'sourceDomSha256', 'renderedBlockSha256',
            }
            if not isinstance(binding, dict) or set(binding) != expected_keys:
                raise _H.PublishDataValidationError(f'公式来源记录 formulaBindings[{index}] 格式无效、缺少必要字段，或含有不允许的字段。')
            ordinal = binding.get('formulaOrdinal')
            latex = binding.get('latex')
            rendered_block = f'\\[{str(latex or "").strip()}\\]'
            # 发布清理会将 _{<k} 改为 _{\lt k}，并处理 \texttt{<answer>} 等标记，
            # 避免 Hugo 将其当作 HTML。保存正文中是原始公式块，最终页面可能是清理后的块。
            # 两种形式合计必须恰好出现一次；缺失、重复或清理后发生碰撞时均拒绝。
            # renderedBlockSha256 仍核对原始公式块，不能用清理后的字节重新签署来源记录。
            published_block = sanitize_markdown_for_publish(rendered_block)
            if published_block == rendered_block:
                formula_occurrences = display_blocks.count(rendered_block)
            else:
                formula_occurrences = display_blocks.count(rendered_block) \
                    + display_blocks.count(published_block)
            if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal < 1 \
                    or ordinal in seen_ordinals \
                    or binding.get('marker') != f'[[FORMULA_{ordinal}]]' \
                    or binding.get('targetKind') not in (
                        'background', 'related_work', 'problem', 'method_overview',
                        'component', 'training', 'experiment_setup', 'result',
                        'ablation', 'limitation', 'reproduction', 'synthesis',
                    ) \
                    or not isinstance(latex, str) or not latex.strip() \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(binding.get('sourceDomSha256') or '')) \
                    or binding.get('renderedBlockSha256') \
                    != _H._javascript_string_sha256(rendered_block) \
                    or formula_occurrences != 1 \
                    or binding['marker'] in article:
                raise _H.PublishDataValidationError(f'第 {index + 1} 个公式的来源记录或正文显示内容不符合要求。')
            _H._validate_reader_formula_source(binding, plan, structured_sha, paper.get('sourceSha256'))
            seen_ordinals.add(ordinal)
        # The authenticated conference bridge checks table/formula quality here;
        # its renderer separately verifies every official conference figure/asset.
        # The legacy figure exception below is specific to sealed arXiv sources.
        if publication_table_evidence is None or paper.get('source') != 'conference':
            _H._validate_legacy_reader_figure_source(paper, plan, article, structured_sha, paper.get('sourceSha256'))
        return {
            **reader_formats.source_header(plan),
            'sha256': bindings_sha,
            'tableCount': len(table_bindings),
            'formulaCount': len(formula_bindings),
            'structuredArtifactsSha256': structured_sha,
        }


def _validate_api_reader_author_identity(paper, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        contracts = contracts if isinstance(contracts, dict) else {}
        stage = (manifest.get('stages') or {}).get('apiReaderArticle') \
            if isinstance(manifest, dict) else None
        payload = paper.get('apiReaderAuthors') if isinstance(paper, dict) else None
        if not isinstance(payload, dict) or set(payload) != {
                'authors', 'sourceDomSha256', 'identity', 'identitySha256'}:
            raise _H.PublishDataValidationError('读者文章的作者记录格式无效、缺少必要字段，或含有不允许的字段。')
        identity = payload.get('identity')
        try:
            identity_header = reader_formats.identity_header(identity, 'authors')
        except (ValueError, TypeError) as error:
            raise _H.PublishDataValidationError('读者文章的作者来源格式头不符合要求。') from error
        base_identity_keys = set(identity_header) | {
            'sourceDomSha256', 'sourceTextSha256', 'metadataSha256', 'authors'}
        is_conference_paper = not paper.get('arxivId')
        conference_author_parser = identity.get('conferencePdfAuthorParser') if isinstance(identity, dict) else None
        allowed_identity_keys = (
            base_identity_keys | {'conferencePdfAuthorParser'}
            if (is_conference_paper and conference_author_parser in {
                'conference-pdf-author-lines-v2',
                'conference-pdf-author-pdf-page1-v3',
            })
            else base_identity_keys
        )
        if not isinstance(identity, dict) or set(identity) != allowed_identity_keys:
            raise _H.PublishDataValidationError('读者文章的作者来源记录格式无效、缺少必要字段，或含有不允许的字段。')
        allowed_dom_source_kinds = (
            {'html_dom', 'pdf_text', 'official_metadata'}
            if (is_conference_paper and conference_author_parser == 'conference-pdf-author-pdf-page1-v3')
            else {'html_dom', 'pdf_text'}
        )
        identity_sha = _H._reader_record_sha256(identity, 'API reader 作者来源记录')
        source_sha = paper.get('sourceSha256')
        metadata_sha = _H._reader_record_sha256(
            paper.get('authors') if isinstance(paper.get('authors'), list) else [],
            'API reader 作者元数据',
        )
        if not reader_formats.identity_binding(paper, 'authors') \
                or payload.get('identitySha256') != identity_sha \
                or stage.get('readerAuthorIdentitySha256') != identity_sha \
                or identity.get('sourceTextSha256') != source_sha \
                or identity.get('metadataSha256') != metadata_sha:
            raise _H.PublishDataValidationError('读者文章的作者来源规则不匹配，或作者记录、论文全文及论文元数据的 SHA 与对应记录不一致。')
        source_dom_sha = identity.get('sourceDomSha256')
        if source_dom_sha != '' and not re.fullmatch(r'[0-9a-f]{64}', str(source_dom_sha or '')):
            raise _H.PublishDataValidationError('作者来源记录中的 DOM SHA 必须为空字符串或有效的 SHA-256。')
        if not re.fullmatch(r'[0-9a-f]{64}', str(payload.get('sourceDomSha256') or '')):
            raise _H.PublishDataValidationError('读者文章作者记录中的来源 DOM SHA 缺失或格式无效。')
        public_authors = payload.get('authors')
        bound_authors = identity.get('authors')
        if not isinstance(public_authors, list) or not isinstance(bound_authors, list) \
                or not public_authors or len(public_authors) != len(bound_authors):
            raise _H.PublishDataValidationError('展示作者列表或来源作者列表无效、为空，或两者数量不一致。')
        for index, (author, bound) in enumerate(zip(public_authors, bound_authors)):
            if not isinstance(author, dict) or set(author) != {'name', 'affiliations'} \
                    or not isinstance(bound, dict) or set(bound) != {
                        'name', 'affiliations', 'nameBinding', 'affiliationBindings'} \
                    or bound.get('name') != author.get('name') \
                    or bound.get('affiliations') != author.get('affiliations') \
                    or not isinstance(author.get('name'), str) or not author['name'].strip() \
                    or not isinstance(author.get('affiliations'), list) \
                    or not author['affiliations']:
                raise _H.PublishDataValidationError(f'第 {index + 1} 位作者的字段、姓名或机构列表无效，或与来源记录不一致。')
            if not all(isinstance(value, str) and value.strip()
                       for value in author['affiliations']):
                raise _H.PublishDataValidationError(f'第 {index + 1} 位作者的每个机构名称都必须是非空字符串。')
            name_binding = bound.get('nameBinding')
            if not isinstance(name_binding, dict) \
                    or name_binding.get('sourceValue') != author['name']:
                raise _H.PublishDataValidationError(f'第 {index + 1} 位作者缺少姓名来源记录，或记录中的姓名不一致。')
            if name_binding.get('sourceKind') in allowed_dom_source_kinds:
                if set(name_binding) != {'sourceKind', 'sourceValue', 'sourceDomSha256'} \
                        or not source_dom_sha \
                        or name_binding.get('sourceDomSha256') != source_dom_sha:
                    raise _H.PublishDataValidationError(f'第 {index + 1} 位作者的来源姓名字段或来源 SHA 不符合要求。')
            elif name_binding.get('sourceKind') == 'paper_metadata':
                if set(name_binding) != {'sourceKind', 'sourceValue', 'metadataSha256'} \
                        or name_binding.get('metadataSha256') != metadata_sha:
                    raise _H.PublishDataValidationError(f'第 {index + 1} 位作者的论文元数据姓名来源字段或 SHA 不符合要求。')
            else:
                raise _H.PublishDataValidationError(f'第 {index + 1} 位作者的姓名来源类型不符合要求。')
            affiliation_bindings = bound.get('affiliationBindings')
            if not isinstance(affiliation_bindings, list) \
                    or len(affiliation_bindings) != len(author['affiliations']):
                raise _H.PublishDataValidationError(f'第 {index + 1} 位作者的机构来源记录必须是列表，且条数须与机构列表一致。')
            for affiliation_index, (affiliation, binding) in enumerate(zip(
                    author['affiliations'], affiliation_bindings)):
                if not isinstance(binding, dict) or binding.get('sourceValue') != affiliation:
                    raise _H.PublishDataValidationError(
                        f'第 {index + 1} 位作者的第 {affiliation_index + 1} 个机构缺少来源记录，或机构名称不一致。'
                    )
                if binding.get('sourceKind') in allowed_dom_source_kinds:
                    if set(binding) != {
                            'sourceKind', 'association', 'sourceValue', 'sourceDomSha256'} \
                            or binding.get('association') not in {
                                'direct_author', 'single_global_affiliation'} \
                            or not source_dom_sha \
                            or binding.get('sourceDomSha256') != source_dom_sha:
                        raise _H.PublishDataValidationError('作者机构的来源字段、对应关系或来源 SHA 不符合要求。')
                elif binding.get('sourceKind') == 'explicit_unavailable':
                    if set(binding) != {
                            'sourceKind', 'sourceValue', 'sourceTextSha256'} \
                            or not affiliation.startswith('机构信息未') \
                            or binding.get('sourceTextSha256') != source_sha:
                        raise _H.PublishDataValidationError('API reader 作者机构 unavailable binding 非法')
                else:
                    raise _H.PublishDataValidationError('作者机构的来源类型不符合要求。')
        if stage.get('readerAuthorsSha256') != _H._reader_record_sha256(payload, 'API reader 作者记录'):
            raise _H.PublishDataValidationError('读者文章作者记录的 SHA 与阶段记录不一致。')
        return {
            **identity_header,
            'sha256': identity_sha,
            'payloadSha256': _H._reader_record_sha256(payload, 'API reader 作者记录'),
            'count': len(public_authors),
            'authors': public_authors,
        }


def _validated_https_identity_url(value, label, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        try:
            parsed = urlparse(value)
        except (TypeError, ValueError) as exc:
            raise _H.PublishDataValidationError(f'{label} 的 URL 无法解析。') from exc
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise _H.PublishDataValidationError(f'{label} 必须是包含主机名且不带用户名或密码的 HTTPS URL。')
        return value


def _validate_api_reader_resource_identity(paper, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        contracts = contracts if isinstance(contracts, dict) else {}
        stages = manifest.get('stages') if isinstance(manifest, dict) else None
        reader_stage = stages.get('apiReaderArticle') if isinstance(stages, dict) else None
        reader_stage = reader_stage if isinstance(reader_stage, dict) else {}
        open_stage = stages.get('openSourceScan') if isinstance(stages, dict) else None
        open_stage = open_stage if isinstance(open_stage, dict) else {}
        demo_stage = stages.get('demoLinkScan') if isinstance(stages, dict) else None
        payload = paper.get('apiReaderResources') if isinstance(paper, dict) else None
        try:
            resource_header = reader_formats.identity_header(payload, 'resources')
        except (ValueError, TypeError) as error:
            raise _H.PublishDataValidationError('读者文章的资源来源格式头不符合要求。') from error
        if not isinstance(payload, dict) or set(payload) != set(resource_header) | {
                'sourceTextSha256', 'resources', 'identitySha256'}:
            raise _H.PublishDataValidationError('读者文章的资源记录格式无效、缺少必要字段，或含有不允许的字段。')
        identity = {key: value for key, value in payload.items() if key != 'identitySha256'}
        identity_sha = _H._stable_json_sha256(identity)
        if not reader_formats.identity_binding(paper, 'resources') \
                or not reader_formats.resource_source_binding(open_stage, payload) \
                or payload.get('identitySha256') != identity_sha \
                or reader_stage.get('resourceIdentitySha256') != identity_sha \
                or open_stage.get('resourceEvidenceSha256') != identity_sha \
                or payload.get('sourceTextSha256') != paper.get('sourceSha256'):
            raise _H.PublishDataValidationError('读者文章的资源来源规则不匹配，或资源记录、论文全文及分析阶段保存的 SHA 不一致。')
        resources = payload.get('resources')
        if not isinstance(resources, list) or len(resources) > 12 \
                or reader_stage.get('resourceCount') != len(resources):
            raise _H.PublishDataValidationError('读者文章的资源记录必须是最多 12 条的列表，且条数须与阶段记录一致。')
        discovered_links = demo_stage.get('discoveredLinks') if isinstance(demo_stage, dict) else []
        allowed_types = {'code', 'model', 'dataset', 'demo', 'reproduction', 'third_party'}
        available_types = set()
        for index, resource in enumerate(resources):
            required = {
                'type', 'origin', 'sourceQuote', 'sourceQuoteSha256',
                'originalUrl', 'finalUrl', 'redirects', 'status', 'availability',
            }
            allowed = required | {'retryable', 'failureCode', 'documentationEvidence', 'authenticatedPdfFootnoteEvidence'}
            if not isinstance(resource, dict) or not required.issubset(resource) \
                    or not set(resource).issubset(allowed):
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 格式无效、缺少必要字段，或含有不允许的字段。')
            if resource.get('type') not in allowed_types \
                    or resource.get('origin') not in {'paper_source', 'validated_demo'}:
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的类型或来源不符合要求。')
            if 'authenticatedPdfFootnoteEvidence' in resource:
                proof = resource['authenticatedPdfFootnoteEvidence']
                if not public_protocols.has_valid_header(proof, 'reader-authenticated-pdf-footnote-evidence') \
                        or resource.get('origin') != 'paper_source' \
                        or proof.get('originalUrl') != resource.get('originalUrl') \
                        or proof.get('sourceTextSha256') != paper.get('sourceSha256') \
                        or proof.get('sourceQuote') != resource.get('sourceQuote') \
                        or proof.get('sourceQuoteSha256') != resource.get('sourceQuoteSha256') \
                        or not re.fullmatch(r'[0-9a-f]{64}', str(proof.get('evidenceSha256') or '')):
                    raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的认证 PDF 脚注证明无效。')
            original_url = _H._validated_https_identity_url(
                resource.get('originalUrl'), f'资源记录 resources[{index}] 的原始地址 originalUrl',
            )
            final_url = _H._validated_https_identity_url(
                resource.get('finalUrl'), f'资源记录 resources[{index}] 的最终地址 finalUrl',
            )
            source_quote = resource.get('sourceQuote')
            if not isinstance(source_quote, str) or not source_quote.strip() \
                    or original_url not in source_quote \
                    or resource.get('sourceQuoteSha256') \
                    != _H._javascript_string_sha256(source_quote):
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 缺少有效的来源引文、引文未包含原始地址，或引文 SHA 不一致。')
            if resource['origin'] == 'validated_demo' \
                    and original_url not in (discovered_links or []):
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的演示页原始地址未包含在已发现链接的记录中。')
            redirects = resource.get('redirects')
            if not isinstance(redirects, list) or len(redirects) > 3:
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的重定向记录必须是最多 3 条的列表。')
            expected_from = original_url
            for redirect_index, redirect in enumerate(redirects):
                if not isinstance(redirect, dict) or set(redirect) != {'from', 'to', 'status'} \
                        or redirect.get('from') != expected_from \
                        or redirect.get('status') not in {301, 302, 303, 307, 308}:
                    raise _H.PublishDataValidationError(
                        f'资源记录 resources[{index}] 的重定向条目 redirects[{redirect_index}] 字段、起点或 HTTP 状态码不符合要求。'
                    )
                _H._validated_https_identity_url(redirect.get('from'), '资源重定向的起始地址')
                expected_from = _H._validated_https_identity_url(
                    redirect.get('to'), '资源重定向的目标地址',
                )
            if expected_from != final_url:
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的重定向终点与最终地址不一致。')
            availability = resource.get('availability')
            status = resource.get('status')
            if isinstance(status, bool) or (status is not None and not isinstance(status, int)):
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的 HTTP 状态码必须是整数或空值。')
            retryable = resource.get('retryable')
            if retryable is not None and not isinstance(retryable, bool):
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的重试标记必须是布尔值或空值。')
            if availability == 'available':
                valid_terminal = status is not None and 200 <= status < 400 and retryable in {None, False}
                available_types.add(resource['type'])
            elif availability == 'unavailable':
                valid_terminal = status is not None and 400 <= status < 500 \
                    and status not in {408, 425, 429} and retryable in {None, False}
            elif availability == 'temporarily_unreachable':
                valid_terminal = retryable is True and (
                    status is None or status in {408, 425, 429} or status >= 500
                )
            else:
                valid_terminal = False
            if not valid_terminal:
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的可达状态与 HTTP 状态码或重试标记不一致。')
            failure_code = resource.get('failureCode')
            if failure_code is not None and (
                    availability != 'temporarily_unreachable' or status is not None
                    or not isinstance(failure_code, str) or not failure_code.strip()
                    or len(failure_code) > 100):
                raise _H.PublishDataValidationError(f'资源记录 resources[{index}] 的失败原因代码格式无效，或不适用于当前可达状态和 HTTP 状态码。')
            documentation = resource.get('documentationEvidence')
            if documentation is not None:
                # README 证据来自独立的 raw.githubusercontent.com 地址。
                # 仓库页面暂时不可达时，仍可能已取得有效的 README 响应。
                documentation_keys = {
                    'contract', 'repositoryUrl', 'sourceUrl', 'status',
                    'sourceSha256', 'capabilities', 'completeness',
                }
                capabilities = documentation.get('capabilities') \
                    if isinstance(documentation, dict) else None
                capability_keys = {'installation', 'inference', 'fineTuning'}
                complete_documentation = isinstance(capabilities, dict) \
                    and set(capabilities) == capability_keys \
                    and all(value is True for value in capabilities.values())
                partial_documentation = isinstance(capabilities, dict) \
                    and set(capabilities) == capability_keys \
                    and all(isinstance(value, bool) for value in capabilities.values()) \
                    and not complete_documentation
                if not isinstance(documentation, dict) \
                        or set(documentation) != documentation_keys \
                        or resource.get('type') != 'code' \
                        or documentation.get('contract') \
                        != 'repository-documentation-evidence-v1' \
                        or documentation.get('repositoryUrl') != original_url \
                        or documentation.get('status') != 200 \
                        or not re.fullmatch(r'[0-9a-f]{64}', str(
                            documentation.get('sourceSha256') or '',
                        )) \
                        or not (complete_documentation or partial_documentation) \
                        or documentation.get('completeness') != (
                            'complete' if complete_documentation else 'partial'
                        ):
                    raise _H.PublishDataValidationError(
                        f'资源记录 resources[{index}] 的 README 文档证据不符合要求。请核对记录格式、代码仓库地址、访问结果和文档完整性。'
                    )
                source_url = _H._validated_https_identity_url(
                    documentation.get('sourceUrl'),
                    f'资源记录 resources[{index}] 的 README 文档证据来源地址',
                )
                parsed_repository = urlparse(original_url)
                repository_parts = [part for part in parsed_repository.path.split('/') if part]
                expected_sources = (
                    {
                        f'https://raw.githubusercontent.com/{repository_parts[0]}/{repository_parts[1]}/{branch}/{filename}'
                        for branch in ('main', 'master')
                        for filename in ('README.md', 'readme.md', 'README.rst')
                    }
                    if parsed_repository.hostname == 'github.com'
                    and len(repository_parts) == 2 else set()
                )
                if source_url not in expected_sources:
                    raise _H.PublishDataValidationError(
                        f'资源记录 resources[{index}] 的 README 文档证据地址不是该仓库 main/master 分支的指定地址。'
                    )

        if any('authenticatedPdfFootnoteEvidence' in resource for resource in resources):
            _H._validate_authenticated_pdf_resource_identity_replay(paper)
        parsed_analysis = parse_analysis(paper.get('analysis', '')) or {}
        for field, resource_type in (
                ('hasCode', 'code'), ('hasModel', 'model'), ('hasDataset', 'dataset')):
            expected_yes = resource_type in available_types
            actual_yes = str(parsed_analysis.get(field) or '').strip().lower() in {'是', 'yes'}
            if actual_yes != expected_yes:
                raise _H.PublishDataValidationError(
                    f'读者文章资源记录的可达状态与机器摘要中的 {field} 标记不一致。'
                )
        availability_summary = (
            '未发现可验证的官方 HTTPS 资源 URL。' if not resources else
            '；'.join(
                f'{resource["type"]}={resource["availability"]}'
                + ('' if resource['status'] is None else f'(HTTP {resource["status"]})')
                for resource in resources
            )
        )
        if availability_summary not in str(parsed_analysis.get('opensource') or ''):
            raise _H.PublishDataValidationError('开源说明中缺少与资源记录一致的可达性摘要。')
        return {
            **resource_header,
            'sha256': identity_sha,
            'count': len(resources),
            'availableTypes': sorted(available_types),
            'resources': resources,
        }


def _validate_authenticated_pdf_resource_identity_replay(paper, *, hooks: Mapping | None = None):
    """Never promote an explicit PDF resource proof from JSON alone."""
    with _hooks_scope(hooks):
        from publication_local_replay import publication_replay_result, checked_replay_response
        same_render = publication_replay_result(paper)
        if same_render is not None:
            return same_render
        node = shutil.which('node')
        if not node:
            raise _H.PublishDataValidationError('认证 PDF 资源冷重放需要 Node.js。')
        payload = _H._daily_fresh_compact_json_bytes({'paper': paper, 'authenticatedPdfResources': True})
        if len(payload) > 128 * 1024 * 1024:
            raise _H.PublishDataValidationError('认证 PDF 资源重放输入超过上限。')
        cli = _H.SHARED_SCRIPTS_DIR / 'lib' / 'reader-resource-claims-replay-cli.js'
        replay_env = {key: value for key, value in os.environ.items() if key not in {'NODE_OPTIONS', 'NODE_PATH'}}
        replay_runner = _H.get("_run_node_replay_cli")
        if replay_runner is not None:
            result = replay_runner(
                cli, payload, node=node, cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                env=replay_env, timeout_seconds=180, max_output_bytes=1024 * 1024,
            )
        else:
            with tempfile.TemporaryFile() as source_file:
                source_file.write(payload); source_file.flush(); source_file.seek(0)
                result = _H._run_bounded_subprocess(
                    [node, str(cli), str(source_file.fileno())],
                    cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                    env=replay_env,
                    timeout_seconds=180, max_output_bytes=1024 * 1024, pass_fds=(source_file.fileno(),))
        response = checked_replay_response(result, worker='reader-resource-claims-replay-cli.js', timeout_seconds=180)
        if response.get('verified') is not True:
            reason = response.get('message', '') if isinstance(response, dict) else '响应必须为对象'
            raise _H.PublishDataValidationError('认证 PDF 脚注资源未通过真实来源冷重放：' + str(reason))
        return response


def _validate_local_source_scoring_replay(paper, *, hooks: Mapping | None = None):
    # The same inherited private FD cold-loads the configured canonical package,
    # verifies physical before/receipt/source, and runs all normal Node gates.
    # JSON declarations, local strings or this digest are not capabilities.
    with _hooks_scope(hooks):
        from publish_common import _manual_hash
        response = _H._validate_authenticated_pdf_resource_identity_replay(paper)
        proof = response.get('localSourceCorrection')
        locator = paper.get('conferenceSourceCorrection') or {}
        stage = ((paper.get('analysisManifest') or {}).get('stages') or {}).get('scoringAudit') or {}
        from protocol_codec import has_valid_header
        from conference_source_correction_format import locator_family
        if not locator_family(locator) or not has_valid_header(proof, 'conference-source-correction-verification') \
                or proof.get('verified') is not True or proof.get('newApiRequests') != 0 \
                or proof.get('executionId') != locator.get('executionId') \
                or proof.get('sourceCorrectionContract') != locator.get('contract') \
                or ('sourceCorrectionSchemaFingerprint' in proof) != ('schemaFingerprint' in locator) \
                or proof.get('sourceCorrectionSchemaFingerprint') != locator.get('schemaFingerprint') \
                or proof.get('scopeKind') != {'deterministic_source_resource_audit': 'source_resource_correction', \
                                            'deterministic_source_core_audit': 'source_core_correction'}.get(stage.get('executionKind')) \
                or proof.get('presentedPaperSha256') != _manual_hash(paper) \
                or proof.get('scoringStageSha256') != _manual_hash(stage) \
                or proof.get('sourceSha256') != paper.get('sourceSha256') \
                or not all(re.fullmatch(r'[a-f0-9]{64}', str(proof.get(key, ''))) for key in \
                           ('canonicalPaperSha256', 'receiptSha256')):
            raise _H.PublishDataValidationError('本地来源评分未通过整篇、原回执及真实 PDF 冷重放。')
        return True


def _find_outside_fence_heading(text, pattern):
    fence = None
    for line_match in re.finditer(r'[^\r\n]*(?:\r\n|\n|\r|$)', text):
        raw_line = line_match.group(0)
        if not raw_line:
            continue
        cursor = line_match.start()
        stripped = raw_line.rstrip('\r\n')
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', stripped)
        if marker:
            tok = marker.group(1)
            rest = stripped[marker.end():]
            if fence is None:
                if tok[0] == '`' and '`' in rest:
                    pass
                else:
                    fence = (tok[0], len(tok))
                    continue
            elif tok[0] == fence[0] and len(tok) >= fence[1] and not rest.strip(' \t'):
                fence = None
                continue
        if fence is None and re.fullmatch(pattern, stripped):
            return cursor, cursor + len(stripped)
    return None


def _api_reader_page_binding_issue(content, paper, *, hooks: Mapping | None = None):
    """核对最终页面的来源标记及显示内容，并重新检查表格和公式的来源记录。"""
    with _hooks_scope(hooks):
        if not isinstance(paper, dict):
            return None
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if not isinstance(contracts, dict) \
                or not reader_formats.is_integrated_contract(contracts.get('apiReaderArticle')):
            return None
        try:
            payload = _H._api_reader_payload(paper)
            proof = payload.get('sourceBindingProof') if isinstance(payload, dict) else None
            author_proof = payload.get('authorIdentityProof') if isinstance(payload, dict) else None
            resource_proof = payload.get('resourceIdentityProof') if isinstance(payload, dict) else None
            if not isinstance(proof, dict):
                raise _H.PublishDataValidationError('读者文章页面缺少表格与公式的 v4 来源核验结果。')
            if not isinstance(author_proof, dict) or not isinstance(resource_proof, dict):
                raise _H.PublishDataValidationError('读者文章页面缺少作者来源或资源核验结果。')
            def frontmatter_value(field, pattern):
                match = re.search(
                    rf'^{re.escape(field)}:\s*{pattern}\s*$', content, flags=re.MULTILINE,
                )
                return match.group(1) if match else None

            marker_contract = re.search(
                r'^paper_digest_api_reader_source_binding_contract:\s*"([^"]+)"\s*$',
                content, flags=re.MULTILINE,
            )
            marker_sha = re.search(
                r'^paper_digest_api_reader_source_bindings_sha256:\s*"([0-9a-f]+)"\s*$',
                content, flags=re.MULTILINE,
            )
            marker_table_count = re.search(
                r'^paper_digest_api_reader_source_table_count:\s*(\d+)\s*$',
                content, flags=re.MULTILINE,
            )
            marker_formula_count = re.search(
                r'^paper_digest_api_reader_source_formula_count:\s*(\d+)\s*$',
                content, flags=re.MULTILINE,
            )
            marker_structured_sha = re.search(
                r'^paper_digest_api_reader_structured_artifacts_sha256:\s*"([0-9a-f]+)"\s*$',
                content, flags=re.MULTILINE,
            )
            if marker_contract is None or marker_contract.group(1) != proof['contract'] \
                    or marker_sha is None or marker_sha.group(1) != proof['sha256']:
                raise _H.PublishDataValidationError('页面头部的表格与公式来源标记或 SHA 缺失，或与正式 Reader 记录不一致。')
            if marker_table_count is None \
                    or int(marker_table_count.group(1)) != proof['tableCount'] \
                    or marker_formula_count is None \
                    or int(marker_formula_count.group(1)) != proof['formulaCount'] \
                    or marker_structured_sha is None \
                    or marker_structured_sha.group(1) != proof['structuredArtifactsSha256']:
                raise _H.PublishDataValidationError('最终页面的表格或公式来源条数、结构化证据 SHA 缺失，或与保存的核验结果不一致。')
            identity_markers = {
                'authorContract': frontmatter_value(
                    'paper_digest_api_reader_author_identity_contract', r'"([^"]+)"',
                ),
                'authorSha': frontmatter_value(
                    'paper_digest_api_reader_author_identity_sha256', r'"([0-9a-f]+)"',
                ),
                'authorCount': frontmatter_value(
                    'paper_digest_api_reader_author_count', r'(\d+)',
                ),
                'resourceContract': frontmatter_value(
                    'paper_digest_api_reader_resource_identity_contract', r'"([^"]+)"',
                ),
                'resourceSha': frontmatter_value(
                    'paper_digest_api_reader_resource_identity_sha256', r'"([0-9a-f]+)"',
                ),
                'resourceCount': frontmatter_value(
                    'paper_digest_api_reader_resource_count', r'(\d+)',
                ),
            }
            if identity_markers != {
                    'authorContract': author_proof['contract'],
                    'authorSha': author_proof['sha256'],
                    'authorCount': str(author_proof['count']),
                    'resourceContract': resource_proof['contract'],
                    'resourceSha': resource_proof['sha256'],
                    'resourceCount': str(resource_proof['count']),
            }:
                raise _H.PublishDataValidationError('最终页面的作者或资源核验标记缺失，或其中的规则、SHA、条数与保存的核验结果不一致。')
            figure_persistence_marker = frontmatter_value(
                'paper_digest_api_reader_figure_persistence', r'"([^"]+)"',
            )
            if payload.get('figurePersistence') == _H.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT:
                if figure_persistence_marker != _H.EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT:
                    raise _H.PublishDataValidationError('最终页面的图片保存方式标记缺失，或与读者文章记录不一致。')
            elif figure_persistence_marker is not None:
                raise _H.PublishDataValidationError('未采用临时图片保存方式的读者文章页面不得声明该方式。')

            def h2_section(label):
                heading_match = re.search(
                    rf'^##\s+{re.escape(label)}\s*$', content, flags=re.MULTILINE,
                )
                if heading_match is None:
                    return None
                start = heading_match.end()
                start += len(content[start:]) - len(content[start:].lstrip('\n'))
                next_heading = re.search(r'^##\s+', content[start:], flags=re.MULTILINE)
                end = start + next_heading.start() if next_heading else len(content)
                return content[start:end].strip()

            actual_authors = h2_section('👥 作者与机构')
            expected_authors = sanitize_markdown_for_publish(
                _H._render_api_reader_author_block(paper, payload)
            ).strip()
            if actual_authors != expected_authors:
                raise _H.PublishDataValidationError('页面中的作者和机构与已绑定来源的作者记录不一致。')
            reader_display_fields = _H._build_api_reader_display_fields(paper, payload)
            projection_header = {'contract': frontmatter_value('paper_digest_api_reader_decision_projection', r'"([^"]+)"')}
            projection_fp = frontmatter_value('paper_digest_api_reader_decision_projection_schema_fingerprint', r'"([^"]+)"')
            if projection_fp is not None:
                projection_header['schemaFingerprint'] = projection_fp
            if not public_protocols.has_valid_header(projection_header, 'api-reader-decision-projection'):
                raise _H.PublishDataValidationError('页面缺少有效的 Reader 展示字段标记 paper_digest_api_reader_decision_projection。')
            if h2_section('📌 核心摘要') != sanitize_markdown_for_publish(reader_display_fields['summary']).strip():
                raise _H.PublishDataValidationError('页面核心摘要与当前 Reader 记录中应展示的摘要不一致。')
            if find_evaluation_headings(content, rendered=True) or re.search(r'^##\s+(?:💡\s*研究者判断|📎\s*补充信息|⚖️\s*评分依据与证据)',
                         content, flags=re.MULTILINE):
                raise _H.PublishDataValidationError('读者文章页面混入了未经独立事实审查的分析解释栏目。')
            expected_resources = reader_display_fields['opensource']
            expected_resources = sanitize_markdown_for_publish(
                _H._nest_reader_headings(expected_resources.strip(), minimum_level=3)
            ).strip()
            actual_resources = h2_section('🔗 开源与复现资源')
            if not expected_resources or actual_resources != expected_resources:
                raise _H.PublishDataValidationError('最终页面缺少有效的开源与复现资源说明，或说明与资源核验记录的展示结果不一致。')
            actual_scores = h2_section('⚖️ 评分明细')
            if actual_scores is not None:
                actual_scores = re.split(r'^---\s*$', actual_scores, maxsplit=1, flags=re.MULTILINE)[0].strip()
            if actual_scores != sanitize_markdown_for_publish(reader_display_fields['scoringReason']).strip():
                raise _H.PublishDataValidationError('页面评分明细与按当前评分记录生成的说明不一致。')
            positive_claims = {
                'code': r'代码[^\n]{0,18}(?:已开源|已经开源|可以访问|可直接下载|仓库可用)',
                'model': r'(?:模型|权重)[^\n]{0,18}(?:已公开|已经公开|可以访问|可直接下载|权重可用)',
                'dataset': r'数据集[^\n]{0,18}(?:已公开|已经公开|可以访问|可直接下载|数据可用)',
            }
            specs_positive_claims = {
                'code': r'代码[^\n，,。；;：:]{0,18}(?:已开源|已经开源|可以访问|可直接下载|仓库可用)',
                'model': r'(?:模型|权重)[^\n，,。；;：:]{0,18}(?:已公开|已经公开|可以访问|可直接下载|权重可用)',
                'dataset': r'数据集[^\n，,。；;：:]{0,18}(?:已公开|已经公开|可以访问|可直接下载|数据可用)',
            }
            specs_negation_re = re.compile(
                r'(?:未|尚无|尚未|没有|无|不|非|未能|无法|不可|禁止|不得|不能|并非|不代表|不能确认|声称|称|拟|计划|将在|待)'
            )
            available_types = set(resource_proof['availableTypes'])
            actual_specs_section = h2_section('⚙️ 关键实现与复现规格') or ''
            open_source_spec_lines = [
                line for line in actual_specs_section.splitlines()
                if re.match(r'^\s*-\s*\*\*开源产物与协议状态\*\*[：:]', line)
            ]
            open_source_spec_text = '\n'.join(open_source_spec_lines)
            for resource_type, pattern in positive_claims.items():
                if resource_type not in available_types:
                    if re.search(pattern, actual_resources, flags=re.IGNORECASE):
                        raise _H.PublishDataValidationError(
                            f'最终页面把 {resource_type} 的 temporary/unavailable 资源写成可用'
                        )
                    if open_source_spec_text:
                        specs_pattern = specs_positive_claims[resource_type]
                        for match in re.finditer(specs_pattern, open_source_spec_text, flags=re.IGNORECASE):
                            clause_prefix = re.split(
                                r'[\n，,。；;：:]',
                                open_source_spec_text[max(0, match.start() - 32):match.start()],
                            )[-1]
                            if not specs_negation_re.search(clause_prefix) \
                                    and not specs_negation_re.search(match.group(0)):
                                raise _H.PublishDataValidationError(
                                    f'最终页面关键实现与复现规格把 {resource_type} 的未核验/不可用资源写成可用'
                                )
            heading_span = _H._find_outside_fence_heading(content, r'##\s+🧭\s*深度解读\s*')
            if heading_span is None:
                raise _H.PublishDataValidationError('最终页面缺少读者文章的深度解读部分。')
            article_start = heading_span[1]
            if content[article_start:article_start + 4] == '\r\n\r\n':
                article_start += 4
            elif content[article_start:article_start + 2] == '\n\n':
                article_start += 2
            else:
                article_start += len(content[article_start:]) - len(content[article_start:].lstrip('\r\n'))
            expected_article = sanitize_markdown_for_publish(_H._nest_reader_headings(
                payload['renderedArticle'].strip(), minimum_level=3,
            )).strip()
            page_article = content[article_start:article_start + len(expected_article)]
            if page_article != expected_article:
                raise _H.PublishDataValidationError('页面深度解读与正式 Reader 正文的渲染结果不一致。')
            after_article = content[article_start + len(expected_article):]
            if after_article and not after_article.startswith(('\n', '\r\n', '\r')):
                raise _H.PublishDataValidationError('页面深度解读末尾混入了未绑定的额外文本。')
            parsed_analysis = dict(paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {})
            aurl = _H._visible_arxiv_source_url(paper)
            date_str = frontmatter_value('date', r'(\d{4}-\d{2}-\d{2})')
            expected_tail_parts = []
            implementation_specs_block = _H._render_api_reader_implementation_specs(payload.get('plan'))
            if implementation_specs_block:
                expected_tail_parts.append(
                    f'## ⚙️ 关键实现与复现规格\n\n{implementation_specs_block}'
                )
            if parsed_analysis:
                metadata_line = (_H.build_index_context_line(parsed_analysis, aurl) or '').strip()
                expected_tail_parts.append(
                    f'<details>\n<summary>📎 论文与评分元数据</summary>\n\n{metadata_line}\n\n</details>'
                )
            expected_tail_parts.append(
                f'## ⚖️ 评分明细\n\n{reader_display_fields["scoringReason"]}'
            )
            if date_str:
                expected_tail_parts.append(
                    f'---\n\n[← 返回 {date_str} 语音/音乐/音频论文速递]({_H.BASE_PATH}/posts/{date_str}/)'
                )
            expected_tail = sanitize_markdown_for_publish('\n\n'.join(expected_tail_parts)).strip()
            if after_article.strip() != expected_tail:
                raise _H.PublishDataValidationError('页面深度解读章节末尾存在未经核验的额外内容或篡改元数据/尾注。')
            page_proof = _H._validate_api_reader_source_bindings(paper, article=page_article)
            if page_proof != proof:
                raise _H.PublishDataValidationError('最终页面表格或公式的来源核验结果与保存记录不一致。')
        except _H.PublishDataValidationError as exc:
            return str(exc)
        return None


# 公共命名导出（同时保留既有带下划线内部名称）
normalize_api_reader_numeric_token = _normalize_api_reader_numeric_token
validate_api_reader_source_bindings = _validate_api_reader_source_bindings
validate_api_reader_author_identity = _validate_api_reader_author_identity
validate_api_reader_resource_identity = _validate_api_reader_resource_identity
api_reader_page_binding_issue = _api_reader_page_binding_issue
reader_dom_table_unit_coverage = _reader_dom_table_unit_coverage
reader_dom_column_unit_coverage = _reader_dom_column_unit_coverage
find_outside_fence_heading = _find_outside_fence_heading

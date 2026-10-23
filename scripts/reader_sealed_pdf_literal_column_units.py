"""Independent complete PDF grids for daily column units; no DOM projection."""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-sealed-pdf-literal-column-units')
    raise SystemExit('Private module: use the sealed daily column-unit entry point')

import itertools
import re
from pathlib import Path
import fitz
from reader_sealed_pdf_quote_evidence import extract_pdf_quote_document, quote_evidence, need, sha, stable, normalize_quote
from reader_authenticated_pdf_hierarchical_table import (complete_glyphs, rows_of, TABLE_CAPTION, NEXT_CAPTION,
                                                       raw_header_items, assign_level, caption_metric_unit)

CONTRACT = 'reader-sealed-pdf-literal-column-units-v1'
UNIT = re.compile(r'(.+?)\s*(?:\(\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\)|\[\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\])\Z', re.I)
SCALAR = re.compile(r'[+−-]?\d+(?:\.\d+)?\Z')
COMPOUND = re.compile(r'[+−-]?\d+(?:\.\d+)?[KMB]\s+\([+−-]?\d+(?:\.\d+)?%\)\Z')
MEAN_CI = re.compile(r'[+−-]?\d+(?:\.\d+)?±\d+(?:\.\d+)?\Z')


def surface(value):
    # The same mathematical delta glyph already supported by the sealed grid.
    # No TeX rewrite, case folding, rounding, sign or precision conversion.
    return normalize_quote(value.replace('∆', 'Δ'))


def cx(word):
    return (word[0] + word[2]) / 2


def cy(word):
    return (word[1] + word[3]) / 2


def literal(words):
    return ' '.join(w[4] for w in sorted(words, key=lambda w: w[0]))


def header_path(value):
    return re.sub(r'\s+|[↑↓→]', '', surface(value))


def uncertainty_surface(value):
    return re.sub(r'\s*±\s*', '±', surface(value))


def pdf_lines(page):
    return [line for block in page.get_text('dict', flags=fitz.TEXTFLAGS_TEXT)['blocks']
            for line in block.get('lines', [])]


def line_text(line):
    return ''.join(span['text'] for span in line['spans'])


def columns_from_header(page, words, top, separator):
    lines = [line for line in pdf_lines(page) if top[0] - .1 <= line['bbox'][0]
             and line['bbox'][2] <= top[2] + .1 and top[1] < (line['bbox'][1] + line['bbox'][3]) / 2 < separator]
    groups = []
    for line in sorted(lines, key=lambda v: v['bbox'][0]):
        lo, hi = line['bbox'][0], line['bbox'][2]
        matches = [g for g in groups if min(g['right'], hi) > max(g['left'], lo)]
        need(len(matches) <= 1, 'header_column_overlap_ambiguous')
        if matches:
            g = matches[0]
            g['left'], g['right'] = min(g['left'], lo), max(g['right'], hi)
            g['lines'].append(line)
        else:
            groups.append({'left': lo, 'right': hi, 'lines': [line]})
    groups.sort(key=lambda g: g['left'])
    need(2 <= len(groups) <= 16 and all(a['right'] < b['left'] for a, b in zip(groups, groups[1:])),
         'complete_header_columns_missing')
    for g in groups:
        g['text'] = ' '.join(line_text(line) for line in sorted(g['lines'], key=lambda v: v['bbox'][1]))
        g['words'] = [w for w in words if top[1] < cy(w) < separator and g['left'] - .1 <= w[0]
                      and w[2] <= g['right'] + .1]
        need(g['words'], 'header_words_missing')
    need(sum(len(g['words']) for g in groups) == sum(top[1] < cy(w) < separator for w in words),
         'unowned_header_word')
    return groups


def column_edges(groups, words, left, right):
    merged = []
    for lo, hi in sorted((w[0], w[2]) for w in words):
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(hi, merged[-1][1])
        else:
            merged.append([lo, hi])
    gaps = [(a[1], b[0]) for a, b in zip(merged, merged[1:])]
    options, count = [], 1
    for a, b in zip(groups, groups[1:]):
        choices = [(lo + hi) / 2 for lo, hi in gaps if lo >= a['right'] - .01 and hi <= b['left'] + .01]
        need(choices, 'complete_column_gap_missing')
        count *= len(choices)
        need(count <= 64, 'complete_column_search_exceeded')
        options.append(choices)
    return [[left, *choice, right] for choice in itertools.product(*options)]


def source_grid(page, caption, document):
    cap = caption[:4]
    rules = sorted(set((float(d['rect'].x0), float(d['rect'].y0), float(d['rect'].x1))
                       for d in page.get_drawings() if d['rect'].height < .1 and d['rect'].width > 40), key=lambda r: r[1])
    tops = [r for r in rules if 0 <= r[1] - cap[3] <= 40 and r[0] <= (cap[0] + cap[2]) / 2 <= r[2]]
    need(tops, 'literal_table_top_missing')
    top = min(tops, key=lambda r: r[1])
    following = [b[1] for b in page.get_text('blocks') if NEXT_CAPTION.match(b[4])
                 and b[1] > cap[3] and max(b[0], top[0]) < min(b[2], top[2])]
    limit = min(following or [page.rect.height])
    horizontal = sorted(r[1] for r in rules if abs(r[0] - top[0]) < .1 and abs(r[2] - top[2]) < .1
                        and top[1] <= r[1] < limit)
    need(3 <= len(horizontal) <= 16, 'literal_complete_rules_missing')
    separator, bottom = horizontal[1], horizontal[-1]
    words = [list(w[:5]) for w in page.get_text('words', sort=False, flags=fitz.TEXTFLAGS_TEXT)
             if top[0] < cx(w) < top[2] and top[1] < cy(w) < bottom]
    need(words and len(words) <= 8192, 'literal_table_words_invalid')
    groups = columns_from_header(page, words, top, separator)
    headers = [surface(g['text']) for g in groups]
    # Only an explicit original label axis can identify rows. Numeric results
    # never become a label or an implicit dataset/condition dimension.
    merged = headers[:2] == ['Dataset', 'Method']
    need(merged or headers[0] in ('Method', 'Generator'), 'literal_method_axis_not_explicit')
    label_column = 1 if merged else 0
    units = {c: (m.group(2) or m.group(3)).lower() for c, header in enumerate(headers)
             if c > label_column and (m := UNIT.fullmatch(re.sub(r'\s*[↑↓]$', '', header)))}
    need(units, 'literal_header_units_missing')

    # A bound quote must continuously cover the entire actual PDF caption and
    # physical table. Preserve PDF extraction order, including each merged
    # dataset label only once; never synthesize a repeated-label quotation.
    table_lines = [line_text(line) for line in pdf_lines(page)
                   if top[0] - .1 <= line['bbox'][0] and line['bbox'][2] <= top[2] + .1
                   and top[1] < (line['bbox'][1] + line['bbox'][3]) / 2 < bottom]
    complete_quote = normalize_quote(caption[4] + ' ' + ' '.join(table_lines))
    full_quote = quote_evidence(document, complete_quote)
    possibilities = {}
    for edges in column_edges(groups, words, top[0], top[2]):
        try:
            body = [w for w in words if separator < cy(w) < bottom]
            label_words = [w for w in body if edges[label_column] < cx(w) < edges[label_column + 1]]
            lines = rows_of(label_words)
            need(2 <= len(lines) <= 64, 'literal_method_rows_missing')
            ys = [y for y, _ in lines]
            need(all(b - a >= 4 for a, b in zip(ys, ys[1:])), 'literal_method_rows_overlap')
            row_edges = [separator, *[(a + b) / 2 for a, b in zip(ys, ys[1:])], bottom]
            condition_bands = []
            if merged:
                condition_words = [w for w in body if edges[0] < cx(w) < edges[1]]
                for a, b in zip(horizontal[1:], horizontal[2:]):
                    values = [w for w in condition_words if a < cy(w) < b]
                    need(len(rows_of(values)) == 1 and 1 <= len(values) <= 16, 'literal_dataset_band_not_unique')
                    indices = [i for i, y in enumerate(ys) if a < y < b]
                    need(len(indices) >= 2, 'literal_dataset_band_incomplete')
                    condition_bands.append({'text': literal(values), 'words': values, 'top': a, 'bottom': b,
                                            'sourceRows': [i + 1 for i in indices]})
                need(len(condition_bands) >= 2, 'literal_dataset_conditions_missing')
            else:
                need(len(horizontal) == 3, 'literal_unlabelled_body_bands')
            cells, rows = [], []
            for c, g in enumerate(groups):
                cells.append({'row': 0, 'column': c, 'words': g['words'], 'text': g['text']})
            for r, (y, method_words) in enumerate(lines):
                row = []
                for c in range(len(groups)):
                    if merged and c == 0:
                        bands = [band for band in condition_bands if band['top'] < y < band['bottom']]
                        need(len(bands) == 1, 'literal_method_condition_not_unique')
                        row.append(bands[0]['text'])
                        continue
                    values = [w for w in body if row_edges[r] < cy(w) < row_edges[r + 1]
                              and edges[c] < cx(w) < edges[c + 1]]
                    need(values and len(rows_of(values)) == 1, 'literal_cell_missing_or_multiline')
                    text = literal(values)
                    if c == label_column:
                        need(values == method_words or sorted(values) == sorted(method_words), 'literal_method_cell_changed')
                        need(re.match(r'^[A-Za-z]', text) and len(text) <= 240, 'literal_method_not_label')
                    else:
                        need(SCALAR.fullmatch(text) or text in ('–', '—', '-') or COMPOUND.fullmatch(text),
                             'literal_data_cell_not_complete')
                        if c in units:
                            need(SCALAR.fullmatch(text) or text in ('–', '—', '-'), 'literal_unit_value_not_scalar')
                    row.append(text)
                    cells.append({'row': r + 1, 'column': c, 'words': values, 'text': text})
                rows.append(row)
            identities = [tuple(row[:label_column + 1]) for row in rows]
            need(len(set(identities)) == len(identities), 'literal_row_identity_not_unique')
            owned = [tuple(w) for cell in cells for w in cell['words']]
            owned += [tuple(w) for band in condition_bands for w in band['words']]
            need(len(owned) == len(words) and len(set(owned)) == len(words), 'literal_unowned_or_repeated_word')
            box = [top[0], top[1], top[2], bottom]
            glyphs = complete_glyphs(page, words, box)
            grid = {'page': page.number + 1, 'bbox': box, 'headers': headers, 'rows': rows,
                    'rowIdentities': [list(identity) for identity in identities], 'identityColumns': list(range(label_column + 1)),
                    'columnBoundaries': edges, 'rowBoundaries': row_edges, 'horizontalRules': horizontal,
                    'conditionBands': condition_bands, 'cells': cells, 'words': words, 'glyphs': glyphs,
                    'wordBoxCount': len(words), 'fullTableQuoteEvidence': full_quote,
                    'units': [{'column': c, 'unit': unit, 'values': [row[c] for row in rows]} for c, unit in units.items()]}
            # Different arbitrary cut points within the same empty gap prove
            # the same complete physical cells. Different cell ownership does
            # not: reject rather than select a grid using candidate results.
            key = stable({'headers': headers, 'rows': rows, 'cells': cells, 'conditions': condition_bands})
            possibilities.setdefault(key, grid)
        except ValueError:
            continue
    need(len(possibilities) == 1, 'literal_source_grid_not_unique:' + str(len(possibilities)))
    return next(iter(possibilities.values()))


def grouped_source_grid(page, caption, document):
    """A fully observed two-level header and complete literal mean±CI grid.

    Partial header rules certify parent spans. Body columns are obtained from
    every original scalar/mean±CI word's disjoint physical extents, never from
    candidate values. Header glyph ownership also handles PDF words that join
    a direction arrow to the NEXT column's label without a whitespace glyph.
    """
    cap = caption[:4]
    rules = sorted(set((float(d['rect'].x0), float(d['rect'].y0), float(d['rect'].x1))
                       for d in page.get_drawings() if d['rect'].height < .1 and d['rect'].width > 20), key=lambda r: r[1])
    tops = [r for r in rules if 0 <= r[1] - cap[3] <= 40 and r[0] <= (cap[0] + cap[2]) / 2 <= r[2]]
    need(tops, 'grouped_table_top_missing')
    top = min(tops, key=lambda r: r[1])
    following = [b[1] for b in page.get_text('blocks') if NEXT_CAPTION.match(b[4])
                 and b[1] > cap[3] and max(b[0], top[0]) < min(b[2], top[2])]
    limit = min(following or [page.rect.height])
    full = sorted(r[1] for r in rules if abs(r[0] - top[0]) < .1 and abs(r[2] - top[2]) < .1 and top[1] <= r[1] < limit)
    need(3 <= len(full) <= 16, 'grouped_full_rules_missing')
    separator, bottom = full[1], full[-1]
    parents = [r for r in rules if top[1] < r[1] < separator and top[0] < r[0] < r[2] < top[2]]
    need(1 <= len(parents) <= 8, 'grouped_parent_rules_missing')
    words = [list(w[:5]) for w in page.get_text('words', sort=False, flags=fitz.TEXTFLAGS_TEXT)
             if top[0] < cx(w) < top[2] and top[1] < cy(w) < bottom]
    body = [w for w in words if separator < cy(w) < bottom]
    numbers = [w for w in body if SCALAR.fullmatch(w[4]) or MEAN_CI.fullmatch(w[4])]
    need(numbers and any(MEAN_CI.fullmatch(w[4]) for w in numbers), 'grouped_mean_ci_cells_missing')
    extents = []
    for lo, hi in sorted((w[0], w[2]) for w in numbers):
        if extents and lo <= extents[-1][1]:
            extents[-1][1] = max(hi, extents[-1][1])
        else:
            extents.append([lo, hi])
    need(2 <= len(extents) <= 15, 'grouped_numeric_columns_incomplete')
    method_words = [w for w in body if w[2] < extents[0][0]]
    need(method_words, 'grouped_method_cells_missing')
    method_right = max(w[2] for w in method_words)
    edges = [top[0], (method_right + extents[0][0]) / 2,
             *[(a[1] + b[0]) / 2 for a, b in zip(extents, extents[1:])], top[2]]
    need(all(a < b for a, b in zip(edges, edges[1:])), 'grouped_columns_overlap')
    box = [top[0], top[1], top[2], bottom]
    glyphs = complete_glyphs(page, words, box)
    header_glyphs = [i for i, g in enumerate(glyphs) if top[1] < cy(g['bbox']) < separator]
    owners, parent_paths = {}, []
    for rule in parents:
        span = [c + 1 for c, (lo, hi) in enumerate(extents) if rule[0] <= lo and hi <= rule[2]]
        need(len(span) >= 2 and span == list(range(span[0], span[-1] + 1)), 'grouped_parent_span_incomplete')
        left_limit = method_right if span[0] == 1 else extents[span[0] - 2][1]
        right_limit = top[2] if span[-1] == len(extents) else extents[span[-1]][0]
        need(left_limit < rule[0] < extents[span[0] - 1][0]
             and extents[span[-1] - 1][1] < rule[2] < right_limit, 'grouped_rule_cuts_or_borrows_column')
        need(not any(set(span) & set(p['columns']) for p in parent_paths), 'grouped_parent_spans_overlap')
        ids = [i for i in header_glyphs if rule[0] < cx(glyphs[i]['bbox']) < rule[2] and cy(glyphs[i]['bbox']) < rule[1]]
        need(ids, 'grouped_parent_glyphs_missing')
        parent_paths.append({'columns': span, 'rule': list(rule), 'glyphIndices': ids})
        for i in ids:
            need(i not in owners, 'grouped_parent_glyph_repeated')
            owners[i] = 'parent'
    # Parent glyphs sit above several child columns and do not define a leaf
    # gap. Every remaining header glyph AND every body word must share one
    # complete empty physical gap between adjacent source data columns. This
    # splits e.g. the PDF word "→Skating" at its actual glyph gap, rather than
    # cutting a label at an arbitrary midpoint of the numeric columns.
    intervals = [(w[0], w[2]) for w in body] + [(glyphs[i]['bbox'][0], glyphs[i]['bbox'][2])
                 for i in header_glyphs if i not in owners]
    occupied = []
    for lo, hi in sorted(intervals):
        if occupied and lo <= occupied[-1][1]:
            occupied[-1][1] = max(hi, occupied[-1][1])
        else:
            occupied.append([lo, hi])
    gaps = [(a[1], b[0]) for a, b in zip(occupied, occupied[1:])]
    bounds = [(method_right, extents[0][0]), *[(a[1], b[0]) for a, b in zip(extents, extents[1:])]]
    edges = [top[0]]
    for lo, hi in bounds:
        choices = [(a + b) / 2 for a, b in gaps if a >= lo - .01 and b <= hi + .01]
        need(len(choices) == 1, 'grouped_complete_glyph_gap_not_unique')
        edges.append(choices[0])
    edges.append(top[2])
    leaf_ids = []
    for c in range(len(edges) - 1):
        ids = [i for i in header_glyphs if i not in owners and edges[c] < cx(glyphs[i]['bbox']) < edges[c + 1]]
        need(ids, 'grouped_leaf_glyphs_missing')
        for i in ids:
            owners[i] = c
        leaf_ids.append(ids)
    need(len(owners) == len(header_glyphs), 'grouped_unowned_header_glyph')

    def glyph_text(ids):
        values = [(*glyphs[i]['bbox'], glyphs[i]['char']) for i in ids]
        lines = rows_of(values)
        need(len(lines) == 1, 'grouped_header_not_single_baseline')
        return ''.join(w[4] for w in lines[0][1])

    leaves = [glyph_text(ids) for ids in leaf_ids]
    need(leaves[0] in ('Method', 'Generator'), 'grouped_method_axis_not_explicit')
    paths = list(leaves)
    for parent in parent_paths:
        name = glyph_text(parent['glyphIndices'])
        need(re.search(r'[A-Za-z]', name), 'grouped_parent_metric_missing')
        need(not UNIT.fullmatch(re.sub(r'[↑↓→]', '', name)), 'grouped_parent_unit_not_leaf_authority')
        parent['text'] = name
        child_ids = [i for c in parent['columns'] for i in leaf_ids[c]]
        need(all(cy(glyphs[i]['bbox']) > parent['rule'][1] for i in child_ids), 'grouped_leaf_not_below_parent_rule')
        lo = min(glyphs[i]['bbox'][0] for i in child_ids)
        hi = max(glyphs[i]['bbox'][2] for i in child_ids)
        plo = min(glyphs[i]['bbox'][0] for i in parent['glyphIndices'])
        phi = max(glyphs[i]['bbox'][2] for i in parent['glyphIndices'])
        need(abs((lo + hi - plo - phi) / 2) <= .75, 'grouped_parent_child_extent_not_aligned')
        for c in parent['columns']:
            paths[c] = name + ' ' + leaves[c]
    need(len(set(header_path(v) for v in paths)) == len(paths), 'grouped_full_header_paths_not_unique')
    units = {c: (m.group(2) or m.group(3)).lower() for c, leaf in enumerate(leaves)
             if c and (m := UNIT.fullmatch(re.sub(r'[↑↓→]', '', leaf)))}
    need(units, 'grouped_explicit_leaf_units_missing')
    lines = rows_of(method_words)
    need(2 <= len(lines) <= 64, 'grouped_method_rows_incomplete')
    ys = [y for y, _ in lines]
    need(all(b - a >= 4 for a, b in zip(ys, ys[1:])), 'grouped_method_rows_overlap')
    row_edges = [separator, *[(a + b) / 2 for a, b in zip(ys, ys[1:])], bottom]
    need(all(any(a < y < b for y in ys) for a, b in zip(full[1:], full[2:])), 'grouped_empty_or_unparsed_body_band')
    rows, cells, owned = [], [], []
    for r, (_, labels) in enumerate(lines):
        row = []
        for c in range(len(edges) - 1):
            values = [w for w in body if row_edges[r] < cy(w) < row_edges[r + 1] and edges[c] < cx(w) < edges[c + 1]]
            need(values and len(rows_of(values)) == 1, 'grouped_cell_missing_or_multiline')
            value = literal(values)
            need((c == 0 and re.match(r'^[A-Za-z]', value)) or (c > 0 and (SCALAR.fullmatch(value) or MEAN_CI.fullmatch(value))),
                 'grouped_cell_not_complete_scalar_or_mean_ci')
            row.append(value)
            owned.extend(tuple(w) for w in values)
            cells.append({'row': r + 1, 'column': c, 'words': values, 'text': value})
        rows.append(row)
    need(len(owned) == len(body) and len(set(owned)) == len(body), 'grouped_unowned_or_repeated_body_word')
    identities = [[row[0]] for row in rows]
    need(len(set(tuple(row) for row in identities)) == len(identities), 'grouped_method_identity_not_unique')
    table_lines = [line_text(line) for line in pdf_lines(page) if top[0] - .1 <= line['bbox'][0]
                   and line['bbox'][2] <= top[2] + .1 and top[1] < (line['bbox'][1] + line['bbox'][3]) / 2 < bottom]
    full_quote = quote_evidence(document, normalize_quote(caption[4] + ' ' + ' '.join(table_lines)))
    return {'page': page.number + 1, 'bbox': box, 'headers': paths, 'rows': rows, 'rowIdentities': identities,
            'identityColumns': [0], 'columnBoundaries': edges, 'rowBoundaries': row_edges, 'horizontalRules': full,
            'conditionBands': [], 'cells': cells, 'words': words, 'glyphs': glyphs, 'wordBoxCount': len(words),
            'headerProfile': 'complete-two-level-parent-leaf-v1', 'headerParents': parent_paths,
            'headerLeaves': [{'column': c, 'text': leaf, 'glyphIndices': leaf_ids[c]} for c, leaf in enumerate(leaves)],
            'fullTableQuoteEvidence': full_quote,
            'units': [{'column': c, 'unit': unit, 'values': [row[c] for row in rows]} for c, unit in units.items()]}


def caption_uncertainty_source_grid(page, caption, document):
    """A complete ruled table with parent headers and vertically stacked mean/SD.

    Rows come from explicit textual labels; disjoint physical columns come from
    all original numeric extents. Neither is selected from rendered values.
    Every original word and glyph stays owned; parentheses and precision stay literal.
    """
    cap = caption[:4]
    rules = sorted(set((float(d['rect'].x0), float(d['rect'].y0), float(d['rect'].x1))
                       for d in page.get_drawings() if d['rect'].height < .1 and d['rect'].width > 40), key=lambda r: r[1])
    tops = [r for r in rules if 0 <= r[1] - cap[3] <= 40 and r[0] <= (cap[0] + cap[2]) / 2 <= r[2]]
    need(tops, 'stacked_table_top_missing')
    top = min(tops, key=lambda r: r[1])
    following = [b[1] for b in page.get_text('blocks') if NEXT_CAPTION.match(b[4])
                 and b[1] > cap[3] and max(b[0], top[0]) < min(b[2], top[2])]
    limit = min(following or [page.rect.height])
    full = sorted(r[1] for r in rules if abs(r[0] - top[0]) < .1 and abs(r[2] - top[2]) < .1 and top[1] <= r[1] < limit)
    need(3 <= len(full) <= 16, 'stacked_complete_rules_missing')
    separator, bottom = full[1], full[-1]
    words = [list(w[:5]) for w in page.get_text('words', flags=fitz.TEXTFLAGS_TEXT)
             if top[0] < cx(w) < top[2] and top[1] < cy(w) < bottom]
    need(words and len(words) <= 8192, 'stacked_words_invalid')
    body = [w for w in words if separator < cy(w) < bottom]
    numeric_words = [w for w in body if SCALAR.fullmatch(w[4]) or re.fullmatch(r'\(?±?\d+(?:\.\d+)?\)?|\(±', w[4])]
    extents = []
    for lo, hi in sorted((w[0], w[2]) for w in numeric_words):
        if extents and lo <= extents[-1][1]:
            extents[-1][1] = max(hi, extents[-1][1])
        else:
            extents.append([lo, hi])
    need(2 <= len(extents) <= 15, 'stacked_numeric_columns_invalid')
    label_words = [w for w in body if w[2] < extents[0][0]]
    labels = rows_of(label_words)
    need(2 <= len(labels) <= 64, 'stacked_explicit_rows_missing')
    need(all(re.match(r'^[A-Za-z]', literal(ws)) for _, ws in labels), 'stacked_row_not_textual')
    edges = [top[0], (max(w[2] for w in label_words) + extents[0][0]) / 2,
             *[(a[1] + b[0]) / 2 for a, b in zip(extents, extents[1:])], top[2]]
    need(all(a < b for a, b in zip(edges, edges[1:])), 'stacked_columns_overlap')
    header = [w for w in words if cy(w) < separator]
    leaf_rows = [(y, [[w for w in ws if edges[c + 1] < cx(w) < edges[c + 2]] for c in range(len(extents))])
                 for y, ws in rows_of([w for w in header if cx(w) > edges[1]])]
    leaf_rows = [(y, cells) for y, cells in leaf_rows if all(cells)]
    need(len(leaf_rows) == 1, 'stacked_leaf_headers_not_unique')
    leaf_y, leaves = leaf_rows[0]
    levels = [assign_level(items, leaves) for _, items in rows_of(raw_header_items(page, top[1], leaf_y, edges[1], top[2]))]
    need(len(levels) == 1 and any(p['endColumn'] - p['startColumn'] > 1 for p in levels[0]), 'stacked_parent_headers_missing')
    label_header = [w for w in header if cx(w) < edges[1]]
    need(surface(literal(label_header)) in ('System', 'Method'), 'stacked_label_header_invalid')
    headers, units, columns = [surface(literal(label_header))], {}, []
    for c, cell in enumerate(leaves):
        metric = surface(literal(cell))
        need(not SCALAR.fullmatch(metric), 'stacked_numeric_leaf')
        unit, origin = caption_metric_unit(metric, None, None, normalize_quote(caption[4]))
        groups = [p['text'] for p in levels[0] if p['startColumn'] <= c < p['endColumn']]
        need(len(groups) == 1, 'stacked_parent_scope_ambiguous')
        headers.append(' '.join([*groups, metric]) + (f' ({"dB" if unit == "db" else unit})' if unit else ''))
        columns.append({'column': c + 1, 'groups': groups, 'metric': metric, 'unit': unit, 'unitOrigin': origin})
        if unit:
            units[c + 1] = unit
    need(units and len(set(headers)) == len(headers), 'stacked_caption_units_missing_or_ambiguous')
    boundaries = [separator, *[(a[0] + b[0]) / 2 for a, b in zip(labels, labels[1:])], bottom]
    rows, owned = [], len(header)
    for r, (label_y, ws) in enumerate(labels):
        row = [surface(literal(ws))]
        owned += len(ws)
        for c in range(len(extents)):
            values = [w for w in body if edges[c + 1] < cx(w) < edges[c + 2] and boundaries[r] < cy(w) < boundaries[r + 1]]
            lines = rows_of(values)
            need(len(lines) == 2 and lines[0][0] < label_y < lines[1][0], 'stacked_mean_sd_not_paired')
            mean, sd = literal(lines[0][1]), literal(lines[1][1])
            need(SCALAR.fullmatch(mean) and re.fullmatch(r'\(±\d+(?:\.\d+)?\)', re.sub(r'\s+', '', sd)), 'stacked_cell_not_literal_mean_sd')
            row.append(mean + ' ' + sd)
            owned += len(values)
        rows.append(row)
    need(owned == len(words), 'stacked_unowned_words')
    need(len(set(row[0] for row in rows)) == len(rows), 'stacked_row_labels_duplicate')
    box = [top[0], top[1], top[2], bottom]
    table_lines = [line_text(line) for line in pdf_lines(page)
                   if top[0] - .1 <= line['bbox'][0] and line['bbox'][2] <= top[2] + .1
                   and top[1] < (line['bbox'][1] + line['bbox'][3]) / 2 < bottom]
    full_quote = quote_evidence(document, normalize_quote(caption[4] + ' ' + ' '.join(table_lines)))
    return {'page': page.number + 1, 'bbox': box, 'headers': headers, 'rows': rows,
            'identityColumns': [0], 'rowIdentities': [[row[0]] for row in rows], 'conditionBands': [],
            'headerProfile': 'complete-caption-parent-leaf-stacked-uncertainty-v1', 'headerParents': levels,
            'sourceColumns': columns, 'words': words, 'wordBoxCount': len(words),
            'glyphs': complete_glyphs(page, words, box), 'rawWordsSha256': stable(words),
            'fullTableQuoteEvidence': full_quote,
            'units': [{'column': c, 'unit': unit, 'values': [row[c] for row in rows]} for c, unit in units.items()]}


def complete_quote_coverage(document, full, quotes):
    cursor = full['rawStartCodePoint']
    end = full['rawEndCodePoint']
    for quote in sorted(quotes, key=lambda q: q['rawStartCodePoint']):
        lo, hi = max(cursor, quote['rawStartCodePoint']), min(end, quote['rawEndCodePoint'])
        if hi <= cursor:
            continue
        need(not document['rawFullText'][cursor:lo].strip(), 'literal_complete_table_quote_gap')
        cursor = hi
    need(not document['rawFullText'][cursor:end].strip(), 'literal_complete_table_not_bound')


def prove_pdf_bytes(raw, view, quotes):
    need(isinstance(view, list) and 3 <= len(view) <= 65 and all(isinstance(row, list) and 2 <= len(row) <= 16
         and all(isinstance(v, str) and len(v) <= 4000 for v in row) for row in view), 'literal_view_invalid')
    need(all(len(row) == len(view[0]) for row in view), 'literal_view_incomplete')
    need(isinstance(quotes, list) and 1 <= len(quotes) <= 64, 'literal_quotes_invalid')
    document = extract_pdf_quote_document(raw)
    quote_proofs = [quote_evidence(document, quote) for quote in quotes]
    grids = []
    with fitz.open(stream=raw, filetype='pdf') as doc:
        need(len(doc) <= 256, 'literal_pdf_page_limit')
        for page in doc:
            for caption in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
                if not TABLE_CAPTION.match(caption[4]):
                    continue
                try:
                    try:
                        grid = source_grid(page, caption, document)
                    except ValueError:
                        try:
                            grid = grouped_source_grid(page, caption, document)
                        except ValueError:
                            grid = caption_uncertainty_source_grid(page, caption, document)
                    full = grid['fullTableQuoteEvidence']
                    if grid.get('headerProfile') == 'complete-caption-parent-leaf-stacked-uncertainty-v1':
                        complete_quote_coverage(document, full, quote_proofs)
                    else:
                        need(any(q['rawStartCodePoint'] <= full['rawStartCodePoint'] and full['rawEndCodePoint'] <= q['rawEndCodePoint']
                                 for q in quote_proofs), 'literal_complete_table_not_bound')
                    # Header + complete textual conditions identify the source
                    # first. No result value participates in this selection.
                    header_surface = header_path if grid.get('headerProfile') else surface
                    need([header_surface(v) for v in view[0]] == [header_surface(v) for v in grid['headers']], 'literal_headers_changed')
                    if grid.get('headerProfile'):
                        need(all(not re.findall(r'[↑↓→]', rendered) or re.findall(r'[↑↓→]', rendered) == re.findall(r'[↑↓→]', original)
                                 for rendered, original in zip(view[0], grid['headers'])), 'literal_explicit_header_direction_changed')
                    ids = [[surface(row[c]) for c in grid['identityColumns']] for row in view[1:]]
                    need(ids == [[surface(v) for v in identity] for identity in grid['rowIdentities']],
                         'literal_complete_row_identity_changed')
                    grids.append(grid)
                except ValueError:
                    continue
    need(len(grids) == 1, 'literal_bound_table_not_unique:' + str(len(grids)))
    grid = grids[0]
    cell_surface = uncertainty_surface if grid.get('headerProfile') else surface
    need([[cell_surface(v) for v in row] for row in view[1:]] == [[cell_surface(v) for v in row] for row in grid['rows']],
         'literal_complete_cell_value_changed')
    proof = {'contract': CONTRACT, 'valueOrigin': 'sealed_pdf', 'sourceBasis': 'independent-complete-pdf-grid',
             'projectionProfile': ('whitespace-same-delta-parent-leaf-direction-omission-and-mean-ci-spacing-v1'
                                   if grid.get('headerProfile') else 'whitespace-same-delta-and-explicit-merged-dataset-v1'),
             'pdfSha256': sha(raw),
             'rawFullTextSha256': document['rawFullTextSha256'], 'normalizedFullTextSha256': document['normalizedFullTextSha256'],
             'viewSha256': stable(view), 'renderedView': view, 'quoteEvidence': quote_proofs, **grid,
             'implementationFiles': [{'file': name, 'sha256': sha(Path(__file__).with_name(name).read_bytes())} for name in
                                     ['reader_sealed_pdf_column_units.py', 'reader_sealed_pdf_quote_evidence.py',
                                      'reader_sealed_pdf_literal_column_units.py', 'reader_authenticated_pdf_hierarchical_table.py']],
             'backend': {'name': 'pymupdf', 'version': fitz.version[0]}}
    proof['evidenceSha256'] = stable(proof)
    return proof

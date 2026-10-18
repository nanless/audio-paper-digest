"""Complete, uniquely located PDF header hierarchies; no HTML/DOM authority."""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-authenticated-pdf-hierarchical-table')

import base64
import json
import os
import re
import stat
import sys
import fitz
from reader_sealed_pdf_quote_evidence import extract_pdf_quote_document, quote_evidence, sha, stable, need, normalize_quote

CONTRACT = 'reader-authenticated-pdf-hierarchical-table-v1'
NUMBER = re.compile(r'[+−-]?\d+(?:\.\d+)?(?:±\d+(?:\.\d+)?)?\Z')
UNIT = r'%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp'
DECLARATION = re.compile(r'(.+?)\s*(?:\(\s*(' + UNIT + r')\s*\)|\[\s*(' + UNIT + r')\s*\])\Z', re.I)


def surface(value):
    return re.sub(r'\s+', ' ', str(value).replace('↑', '').replace('↓', '').replace('*', '').replace('`', '')).strip()


def compact(value):
    return re.sub(r'\s+', '', surface(value))


def numeric_surface(value):
    # Normal Reader typography spaces the plus/minus operator. Retain every
    # digit and decimal place; this permits no precision, unit or value change.
    return re.sub(r'(?<=\d)\s*±\s*(?=[+−-]?\d)', '±', surface(value))


def cx(word):
    return (word[0] + word[2]) / 2


def cy(word):
    return (word[1] + word[3]) / 2


def rows_of(words):
    rows = []
    for word in sorted(words, key=lambda w: (cy(w), w[0])):
        matches = [r for r in rows if abs(r[0] - cy(word)) <= 1.25]
        need(len(matches) <= 1, 'ambiguous_pdf_baseline')
        if matches:
            matches[0][1].append(word)
        else:
            rows.append([cy(word), [word]])
    return [(y, sorted(ws, key=lambda w: w[0])) for y, ws in rows]


def literal(words):
    return ' '.join(w[4] for w in words)


def numeric_row(words):
    first = next((i for i, w in enumerate(words) if NUMBER.fullmatch(w[4])), len(words))
    if 0 < first < len(words) - 1 and all(NUMBER.fullmatch(w[4]) for w in words[first:]):
        return words[:first], words[first:]
    return None


def raw_header_items(page, top, leaf_y, left, right):
    items = []
    for block in page.get_text('dict', sort=False, flags=fitz.TEXTFLAGS_TEXT)['blocks']:
        for line in block.get('lines', []):
            box = line['bbox']
            if top < (box[1] + box[3]) / 2 < leaf_y - 2 and left < (box[0] + box[2]) / 2 < right:
                value = ''.join(span['text'] for span in line['spans']).strip()
                need(value and '\n' not in value, 'header_line_invalid')
                items.append([*box, value])
    return items


def complete_glyphs(page, words, box):
    glyphs = []
    for block in page.get_text('rawdict', sort=False, flags=fitz.TEXTFLAGS_TEXT)['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                for char in span['chars']:
                    b = char['bbox']
                    if char['c'].isspace() or not (box[0] < (b[0] + b[2]) / 2 < box[2] and box[1] < (b[1] + b[3]) / 2 < box[3]):
                        continue
                    owners = [i for i, w in enumerate(words) if w[0] - .05 <= b[0] and b[2] <= w[2] + .05
                              and w[1] - .05 <= b[1] and b[3] <= w[3] + .05]
                    need(len(owners) == 1, 'glyph_word_ownership_ambiguous')
                    glyphs.append({'char': char['c'], 'bbox': list(b), 'origin': list(char['origin']), 'word': owners[0]})
    for i, w in enumerate(words):
        need(''.join(g['char'] for g in glyphs if g['word'] == i) == w[4], 'word_glyph_text_not_exact')
    return glyphs


def assign_level(items, leaves):
    # Parent centres must agree with the complete child glyph extent. There is
    # no nearest-header choice; enumerate all complete partitions and reject ties.
    solutions, visits = [], [0]

    def visit(index, start, chosen):
        visits[0] += 1
        need(visits[0] <= 256, 'hierarchy_partition_search_exceeded')
        need(len(solutions) <= 1, 'hierarchy_partition_ambiguous')
        if index == len(items):
            if start == len(leaves):
                solutions.append(chosen)
            return
        parent = items[index]
        for end in range(start + 1, len(leaves) + 1):
            lo = min(w[0] for cell in leaves[start:end] for w in cell)
            hi = max(w[2] for cell in leaves[start:end] for w in cell)
            if parent[0] >= lo - .1 and parent[2] <= hi + .1 and abs(cx(parent) - (lo + hi) / 2) <= .75:
                visit(index + 1, end, chosen + [{'text': parent[4], 'bbox': parent[:4], 'startColumn': start, 'endColumn': end}])
    visit(0, 0, [])
    need(len(solutions) == 1, 'hierarchy_partition_not_unique')
    return solutions[0]


def table_grid(page, caption, document, flat_condition_bands=False, merged_condition_column=False):
    cap = caption[:4]
    rules = []
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0] == 'l' and abs(item[1].y - item[2].y) < .02:
                x0, x1 = sorted([item[1].x, item[2].x])
                if x1 - x0 > 40:
                    rules.append([x0, item[1].y, x1])
    tops = [r for r in rules if 0 <= r[1] - cap[3] <= 40 and r[0] <= (cap[0] + cap[2]) / 2 <= r[2]]
    need(tops, 'table_top_rule_missing')
    top = min(tops, key=lambda r: r[1])
    following = [b[1] for b in page.get_text('blocks') if re.match(r'^\s*(?:Table|Figure|Fig\.)\s*\d+\s*[:.]', b[4])
                 and b[1] > cap[3] and max(b[0], top[0]) < min(b[2], top[2])]
    limit = min(following or [page.rect.height])
    full_rules = sorted(set(r[1] for r in rules if abs(r[0] - top[0]) < .1 and abs(r[2] - top[2]) < .1
                            and top[1] <= r[1] < limit))
    need(len(full_rules) >= 3, 'complete_table_rules_missing')
    bottom = full_rules[-1]
    words = [list(w[:5]) for w in page.get_text('words', sort=False, flags=fitz.TEXTFLAGS_TEXT)
             if top[0] < cx(w) < top[2] and top[1] < cy(w) < bottom]
    lines = rows_of(words)
    data = [(y, ws, numeric_row(ws)) for y, ws in lines if numeric_row(ws)]
    need(2 <= len(data) <= 64, 'complete_numeric_rows_missing')
    width = len(data[0][2][1])
    need(2 <= width <= 15 and all(len(r[2][1]) == width for r in data), 'data_columns_incomplete')
    first_y = data[0][0]
    label_words = [w for _, _, row in data for w in row[0]]
    column_words = [[row[1][c] for _, _, row in data] for c in range(width)]
    need(max(w[2] for w in label_words) < min(w[0] for w in column_words[0]), 'row_labels_overlap_data')
    bounds = [top[0], (max(w[2] for w in label_words) + min(w[0] for w in column_words[0])) / 2]
    for a, b in zip(column_words, column_words[1:]):
        hi, lo = max(w[2] for w in a), min(w[0] for w in b)
        need(hi < lo, 'numeric_columns_overlap')
        bounds.append((hi + lo) / 2)
    bounds.append(top[2])
    header_rows = []
    for y, ws in lines:
        if y >= first_y:
            continue
        cells = [[w for w in ws if bounds[c + 1] < cx(w) < bounds[c + 2]] for c in range(width)]
        if all(cells):
            header_rows.append((y, cells))
    if (flat_condition_bands or merged_condition_column) and not header_rows:
        # PDF words can join adjacent metric headings without whitespace. Split
        # only at the already closed data-column geometry, retaining every real
        # glyph and its original word ownership in the complete grid proof.
        glyphs = complete_glyphs(page, words, [top[0], top[1], top[2], bottom])
        for y, ws in lines:
            if y >= first_y:
                continue
            chars = [g for g in glyphs if abs((g['bbox'][1] + g['bbox'][3]) / 2 - y) <= 1.25]
            cells = []
            for c in range(width):
                group = [g for g in chars if bounds[c + 1] < (g['bbox'][0] + g['bbox'][2]) / 2 < bounds[c + 2]]
                if not group:
                    break
                group.sort(key=lambda g: g['bbox'][0])
                cells.append([[min(g['bbox'][0] for g in group), min(g['bbox'][1] for g in group),
                               max(g['bbox'][2] for g in group), max(g['bbox'][3] for g in group),
                               ''.join(g['char'] for g in group)]])
            if len(cells) == width:
                need(all(sum(1 for c in range(width) if bounds[c + 1] < (g['bbox'][0] + g['bbox'][2]) / 2 < bounds[c + 2]) == 1
                         for g in chars if (g['bbox'][0] + g['bbox'][2]) / 2 > bounds[1]), 'uncovered_flat_header_glyph')
                header_rows.append((y, cells))
    need(header_rows, 'complete_leaf_headers_missing')
    leaf_y, leaves = header_rows[-1]
    need(all(not NUMBER.fullmatch(literal(cell)) for cell in leaves), 'leaf_header_is_numeric')
    need(all((bounds[c + 1] < cx(cell[0]) < bounds[c + 2]) if (flat_condition_bands or merged_condition_column) else
             (bounds[c + 1] - .1 <= min(w[0] for w in cell) and max(w[2] for w in cell) <= bounds[c + 2] + .1)
             for c, cell in enumerate(leaves)), 'leaf_headers_cross_column')
    parents = raw_header_items(page, top[1], leaf_y, bounds[1], top[2])
    levels = []
    for _, items in rows_of(parents):
        need(len(levels) < 3, 'header_depth_exceeded')
        level = assign_level(items, leaves)
        if levels:
            need(all(any(p['startColumn'] <= child['startColumn'] and child['endColumn'] <= p['endColumn']
                         for p in levels[-1]) for child in level), 'crossing_header_levels')
        levels.append(level)
    if flat_condition_bands or merged_condition_column:
        need(not levels, 'flat_condition_table_has_parent_headers')
    else:
        need(levels and any(p['endColumn'] - p['startColumn'] > 1 for level in levels for p in level), 'hierarchical_headers_missing')
    label_header = [w for w in words if cy(w) <= leaf_y + 2 and cx(w) < bounds[1]]
    need(label_header and all(w[2] <= bounds[1] for w in label_header), 'row_label_header_missing_or_overlapping')
    merged_header, merged_boundary, merged_bands = None, None, []
    if merged_condition_column:
        ordered = sorted(label_header, key=lambda w: w[0])
        need(len(ordered) >= 2 and ordered[0][4] in ('Dataset', 'Separator'), 'merged_condition_header_not_explicit')
        merged_header = ordered[0]
        need(merged_header[2] < min(w[0] for w in ordered[1:]), 'merged_condition_header_overlaps_features')
        merged_boundary = (merged_header[2] + min(w[0] for w in ordered[1:])) / 2
        for a, b in zip(full_rules, full_rules[1:]):
            band_data = [(y, ws, values) for y, ws, values in data if a < y < b]
            if not band_data:
                continue
            condition_words = [w for w in words if a < cy(w) < b and cx(w) < merged_boundary]
            condition_lines = rows_of(condition_words)
            need(len(condition_lines) == 1 and 1 <= len(condition_words) <= 8, 'merged_condition_band_not_unique')
            condition_words = condition_lines[0][1]
            need(all(w[2] <= merged_boundary for w in condition_words), 'merged_condition_crosses_feature_column')
            merged_bands.append({'header': merged_header[4], 'text': literal(condition_words),
                                 'words': condition_words, 'top': a, 'bottom': b})
        need(merged_bands and sum(sum(a['top'] < y < a['bottom'] for a in merged_bands) for y, _, _ in data) == len(data),
             'merged_condition_data_band_incomplete')
    # Every glyph above the body must belong to the label, a leaf or one exact
    # parent line. Do not silently drop a unit, additional header or condition.
    parent_words = [w for w in words if cy(w) < leaf_y - 2 and cx(w) > bounds[1]]
    for w in parent_words:
        need(sum(1 for level in levels for p in level if p['bbox'][0] - .1 <= w[0] and w[2] <= p['bbox'][2] + .1
                 and p['bbox'][1] - .1 <= w[1] and w[3] <= p['bbox'][3] + .1) == 1, 'uncovered_parent_glyph')
    caption_text = normalize_quote(caption[4])
    caption_proof = quote_evidence(document, caption_text)
    source_columns = []
    for c, cell in enumerate(leaves):
        value = surface(literal(cell))
        decl = DECLARATION.fullmatch(value)
        metric = surface(decl[1] if decl else value)
        unit = (decl[2] or decl[3]).lower() if decl else None
        origin = {'kind': 'leaf', 'words': cell} if decl else None
        matches = list(re.finditer(r'(?<![A-Za-z0-9_])' + re.escape(metric) + r'\s*\(\s*(' + UNIT + r')\s*\)', caption_text, re.I))
        if matches:
            need(len(matches) == 1, 'caption_metric_unit_ambiguous')
            need(not re.search(r'\b(?:not|without|unlike|previous|incorrect|hypothetical)\b', caption_text, re.I), 'caption_unit_qualification_ambiguous')
            if unit:
                need(unit == matches[0][1].lower(), 'caption_leaf_unit_conflict')
            else:
                unit = matches[0][1].lower()
                origin = {'kind': 'caption_metric', 'start': matches[0].start(), 'end': matches[0].end(), 'text': matches[0][0]}
        groups = [next(p['text'] for p in level if p['startColumn'] <= c < p['endColumn']) for level in levels]
        source_columns.append({'sourceColumn': c + 1, 'groups': groups, 'metric': metric, 'unit': unit,
                               'unitOrigin': origin, 'leafWords': cell})
    identities = [tuple([*c['groups'], compact(c['metric'])]) for c in source_columns]
    need(len(set(identities)) == width, 'duplicate_full_header_identity')
    source_rows, condition, seen_condition_bands = [], [], []
    for y, ws in lines:
        if y <= leaf_y + 2:
            continue
        if merged_condition_column:
            matches = [band for band in merged_bands if band['top'] < y < band['bottom']]
            need(len(matches) == 1, 'merged_condition_row_outside_band')
            condition = [matches[0]]
            ws = [w for w in ws if cx(w) >= merged_boundary]
            if not ws:
                continue
        parsed = numeric_row(ws)
        if not parsed:
            # Conditions occupy their own full-rule bounded band, with no data
            # row in that band. Ordinary narrative cannot become a group label.
            before = [r for r in full_rules if r < y]
            after = [r for r in full_rules if r > y]
            need(before and after, 'condition_band_unbounded')
            a, b = max(before), min(after)
            if flat_condition_bands:
                band_data = [(dy, values) for dy, _, values in data if a < dy < b]
                need(band_data and all(y < dy for dy, _ in band_data), 'condition_does_not_precede_complete_band')
                need(sum(1 for yy, values in lines if a < yy < b and not numeric_row(values)) == 1,
                     'condition_band_unparsed_glyphs')
                need(re.fullmatch(r'(?:Latent dimension(?:ality)?|Model capacity|Refinement (?:strategy|setting))\s+\((?:Dim|D)(?:=\d+)?\)', literal(ws)),
                     'dimension_condition_band_not_explicit')
                need(abs(min(w[0] for w in ws) - min(w[0] for w in label_header)) <= 1,
                     'condition_band_label_alignment_changed')
                need(not any(previous['top'] == a for previous in seen_condition_bands), 'condition_band_repeated')
            else:
                need(not any(a < dy < b for dy, _, _ in data), 'unparsed_body_glyphs')
                need(sum(1 for yy, _ in lines if a < yy < b) == 1, 'condition_band_not_single_line')
                need(re.match(r'^(?:Trained|Training|Evaluated|Evaluation|Tested|Testing|Dataset|Condition|Setting|Protocol)\b', literal(ws)),
                     'condition_band_not_explicit')
                need(abs((min(w[0] for w in ws) + max(w[2] for w in ws)) / 2 - (top[0] + top[2]) / 2) <= 1,
                     'condition_band_not_centred')
            condition = [{'text': literal(ws), 'words': ws, 'top': a, 'bottom': b}]
            seen_condition_bands.append(condition[0])
            continue
        label, values = parsed
        if flat_condition_bands:
            need(condition and condition[0]['top'] < y < condition[0]['bottom'], 'row_has_no_complete_condition_band')
        need(all(bounds[c + 1] < cx(w) < bounds[c + 2] for c, w in enumerate(values)), 'row_column_geometry_changed')
        row_text = literal(ws)
        row_proof = quote_evidence(document, row_text)
        source_rows.append({'sourceRow': len(source_rows) + 1, 'rowLabel': literal(label), 'conditionPath': condition,
                            'labelWords': label, 'cells': [{'text': w[4], 'bbox': w[:4]} for w in values],
                            'quoteEvidence': row_proof})
    need(len(source_rows) == len(data), 'incomplete_source_rows')
    if flat_condition_bands:
        need(len(seen_condition_bands) >= 2, 'flat_table_condition_bands_missing')
    row_ids = [(tuple(p['text'] for p in row['conditionPath']), row['rowLabel']) for row in source_rows]
    need(len(set(row_ids)) == len(row_ids), 'duplicate_row_within_condition')
    box = [top[0], top[1], top[2], bottom]
    return {'page': page.number + 1, 'bbox': box, 'captionEvidence': caption_proof,
            **({'headerKind': 'flat-explicit-dimension-condition-bands-v1'} if flat_condition_bands else {}),
            **({'headerKind': 'flat-explicit-merged-condition-column-v1',
                'rowLabelHeader': literal(ordered[1:]),
                'conditionColumns': [{'header': merged_header[4], 'words': [merged_header],
                                      'left': top[0], 'right': merged_boundary}]} if merged_condition_column else {}),
            'columnBoundaries': bounds, 'fullHorizontalRules': full_rules, 'levels': levels,
            'sourceColumns': source_columns, 'sourceRows': source_rows,
            'labelHeaderWords': label_header, 'wordBoxCount': len(words), 'words': words,
            'glyphs': complete_glyphs(page, words, box), 'rawWordsSha256': stable(words)}


def map_view(grid, table, quotes, document):
    quote_proofs = [quote_evidence(document, quote) for quote in quotes]
    columns, all_columns, condition_columns = [], [], []
    label_index = 0
    if grid.get('conditionColumns'):
        labels = [i for i, header in enumerate(table['header']) if surface(header) == grid['rowLabelHeader']]
        need(len(labels) == 1, 'rendered_feature_header_not_unique')
        label_index = labels[0]
    for i, header in enumerate(table['header']):
        if i == label_index:
            continue
        matching_conditions = [c for c in grid.get('conditionColumns', []) if surface(header) == c['header']]
        if matching_conditions:
            need(len(matching_conditions) == 1, 'rendered_condition_header_not_unique')
            condition_columns.append((i, matching_conditions[0]['header']))
            continue
        decl = DECLARATION.fullmatch(surface(header))
        metric = compact(decl[1] if decl else header)
        unit = (decl[2] or decl[3]).lower() if decl else None
        candidates = [c for c in grid['sourceColumns'] if compact(' '.join([*c['groups'], c['metric']])) == metric
                      and (not unit or c['unit'] == unit)]
        need(len(candidates) == 1, 'rendered_header_path_not_unique')
        original = candidates[0]
        all_columns.append((i, original))
        if unit:
            columns.append({'column': i, 'sourceColumn': original['sourceColumn'] - 1, 'metric': metric, 'unit': unit})
    need(columns and len(set(c['sourceColumn'] for _, c in all_columns)) == len(all_columns), 'rendered_columns_duplicate_or_unitless')
    if grid.get('conditionColumns'):
        need(len(condition_columns) == len(grid['conditionColumns'])
             and len(set(header for _, header in condition_columns)) == len(condition_columns), 'rendered_condition_column_missing_or_repeated')
        need(len(all_columns) == len(grid['sourceColumns']), 'merged_condition_numeric_columns_incomplete')
    need([c['sourceColumn'] for _, c in all_columns] == sorted(c['sourceColumn'] for _, c in all_columns), 'rendered_columns_reordered')
    mapped = []
    for index, row in enumerate(table['rows'], 1):
        matches = []
        for original in grid['sourceRows']:
            # The already source-bound complete original row quote locates the
            # physical condition band; equal selected numbers alone never do.
            q = original['quoteEvidence']
            if compact(row[label_index]) != compact(original['rowLabel']) or not any(p['rawStartCodePoint'] <= q['rawStartCodePoint']
                    and q['rawEndCodePoint'] <= p['rawEndCodePoint'] for p in quote_proofs):
                continue
            if any(sum(p.get('header') == header and surface(row[i]) == p['text'] for p in original['conditionPath']) != 1
                   for i, header in condition_columns):
                continue
            if all(numeric_surface(row[i]) == numeric_surface(original['cells'][c['sourceColumn'] - 1]['text']) for i, c in all_columns):
                matches.append(original)
        need(len(matches) == 1, 'rendered_row_not_uniquely_quoted_complete_original')
        original = matches[0]
        mapped.append({'row': index, 'sourceRow': original['sourceRow'], 'rowLabel': original['rowLabel'],
                       'values': [{'column': c['column'], 'sourceColumn': c['sourceColumn'] + 1,
                                   'value': row[c['column']], 'sourceValue': original['cells'][c['sourceColumn']]['text'], 'unit': c['unit']}
                                  for c in columns]})
    need(len(set(r['sourceRow'] for r in mapped)) == len(mapped), 'rendered_row_repeated')
    need([r['sourceRow'] for r in mapped] == sorted(r['sourceRow'] for r in mapped), 'rendered_rows_reordered')
    return columns, mapped


def prove_pdf_bytes(raw, table, quotes):
    need(isinstance(table, dict) and set(table) == {'markdown', 'header', 'rows'} and isinstance(table['markdown'], str), 'rendered_table_invalid')
    need(isinstance(table['header'], list) and 2 <= len(table['header']) <= 16 and all(isinstance(v, str) for v in table['header']), 'rendered_headers_invalid')
    need(isinstance(table['rows'], list) and 1 <= len(table['rows']) <= 64 and all(isinstance(r, list) and len(r) == len(table['header'])
         and all(isinstance(v, str) and len(v) <= 4000 for v in r) for r in table['rows']), 'rendered_rows_invalid')
    need(isinstance(quotes, list) and 1 <= len(quotes) <= 64 and all(isinstance(q, str) for q in quotes), 'quotes_invalid')
    document = extract_pdf_quote_document(raw)
    need(document.get('available'), 'pdf_unavailable')
    candidates = []
    with fitz.open(stream=raw, filetype='pdf') as doc:
        need(len(doc) <= 256, 'pdf_page_limit')
        for page in doc:
            for block in page.get_text('blocks', flags=fitz.TEXTFLAGS_TEXT):
                if not re.match(r'^\s*Table\s+\d+\s*[:.]', block[4]):
                    continue
                try:
                    grid = table_grid(page, block, document)
                    columns, rows = map_view(grid, table, quotes, document)
                    candidates.append({'grid': grid, 'columns': columns, 'rows': rows})
                except ValueError:
                    try:
                        grid = table_grid(page, block, document, flat_condition_bands=True)
                        columns, rows = map_view(grid, table, quotes, document)
                        candidates.append({'grid': grid, 'columns': columns, 'rows': rows})
                    except ValueError:
                        try:
                            grid = table_grid(page, block, document, merged_condition_column=True)
                            columns, rows = map_view(grid, table, quotes, document)
                            candidates.append({'grid': grid, 'columns': columns, 'rows': rows})
                        except ValueError:
                            continue
    need(len(candidates) == 1, 'complete_hierarchical_table_not_unique:' + str(len(candidates)))
    body = {'contract': CONTRACT, 'pdfSha256': sha(raw), 'rawFullTextSha256': document['rawFullTextSha256'],
            'renderedTableSha256': sha(table['markdown'].encode()), 'extraction': document['extraction'], **candidates[0]}
    return {**body, 'evidenceSha256': stable(body)}


def main():
    from runtime_guard import require_external_runtime, require_workspace_role
    require_external_runtime('reader-authenticated-pdf-hierarchical-table')
    require_workspace_role('daily')
    need(len(sys.argv) == 2 and sys.argv[1].isdigit() and int(sys.argv[1]) >= 3, 'private_descriptor_required')
    fd = int(sys.argv[1])
    info = os.fstat(fd)
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_mode & 0o077 == 0
         and 2 <= info.st_size <= 96 * 1024 * 1024, 'private_bounded_descriptor_required')
    chunks, remaining = [], info.st_size
    while remaining:
        chunk = os.read(fd, remaining)
        need(bool(chunk), 'descriptor_truncated')
        chunks.append(chunk)
        remaining -= len(chunk)
    data = json.loads(b''.join(chunks))
    need(set(data) == {'pdfBase64', 'pdfSha256', 'table', 'quotes'}, 'descriptor_fields_invalid')
    raw = base64.b64decode(data['pdfBase64'], validate=True)
    need(sha(raw) == data['pdfSha256'], 'pdf_sha_changed')
    try:
        result = {'contract': CONTRACT, 'eligible': True, 'evidence': prove_pdf_bytes(raw, data['table'], data['quotes'])}
    except ValueError as error:
        result = {'contract': CONTRACT, 'eligible': False, 'reason': str(error)}
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()

"""Complete DOM/PDF vector-grid unit coverage, mirrored from the normal Reader.

The publication caller must authenticate the four source files and replay every
PDF quote before passing strings here. This pure matcher grants no source proof.
"""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-grouped-vector-column-units')

import re
import json
import unicodedata
from pathlib import Path

_RULES = json.loads((Path(__file__).with_name('lib') / 'validation-rules.json').read_text(encoding='utf-8'))
UNITS = tuple(_RULES['tableHeaderUnits'])
_UNITS_PATTERN = r'\(\s*(' + '|'.join(re.escape(unit) for unit in sorted(UNITS, key=len, reverse=True)) + r')\s*\)'


def coverage(rendered, html_quotes, pdf_quotes, tables, display=str):
    def text(value):
        value = unicodedata.normalize('NFKC', display(str(value)))
        value = re.sub(r'\s+', ' ', re.sub(r'[*_`]', '', value)).strip()
        return re.sub(r'([A-Za-z])\\mathbf\{\1\}', r'\1', value.replace('−', '-').replace('∆', 'Δ'))

    def dense(value):
        return re.sub(r'\s+', '', text(value))

    def number(value):
        if not re.fullmatch(r'[+-]?[0-9]+(?:\.[0-9]+)?', value):
            return None
        integer, _, fraction = value.lstrip('+').partition('.')
        negative = integer.startswith('-')
        integer, fraction = integer.lstrip('-').lstrip('0') or '0', fraction.rstrip('0')
        return ('-' if negative and (integer != '0' or fraction) else '') + integer + ('.' + fraction if fraction else '')

    def vector(value):
        raw = dense(value)
        if not re.fullmatch(r'\([-+0-9.,]+\)', raw):
            return None
        parts = raw[1:-1].split(',')
        if not 2 <= len(parts) <= 4:
            return None
        values = [number(re.sub(r'^([-+]?)\.', r'\g<1>0.', part)) for part in parts]
        return ','.join(values) if all(value is not None for value in values) else None

    def scalar(value):
        raw = dense(value)
        if number(raw) is not None:
            return raw
        match = re.fullmatch(r'([+-]?[0-9]+(?:\.[0-9]+)?)\1', raw) or re.fullmatch(r'([+-]?[0-9]+(?:\.[0-9]+)?)\\mathbf\{\1\}', raw)
        return match[1] if match else None

    def grid_for(table):
        matrix, cells = table.get('matrix'), table.get('cells')
        if (table.get('recoveryStatus') != 'complete' or type(table.get('ordinal')) is not int or table['ordinal'] < 1
                or not re.fullmatch(r'[a-f0-9]{64}', table.get('sourceDomSha256', ''))
                or not isinstance(matrix, list) or not 4 <= len(matrix) <= 65 or not isinstance(matrix[0], list)
                or not 3 <= len(matrix[0]) <= 16 or not isinstance(cells, list) or len(cells) > len(matrix) * len(matrix[0])
                or any(not isinstance(row, list) or len(row) != len(matrix[0]) or any(not isinstance(v, str) for v in row) for row in matrix)):
            return None
        grid = [[None] * len(matrix[0]) for _ in matrix]
        for cell in cells:
            if (not isinstance(cell, dict) or any(type(cell.get(k)) is not int for k in ('row', 'column', 'rowspan', 'colspan'))
                    or cell['row'] < 0 or cell['column'] < 0 or cell['rowspan'] < 1 or cell['colspan'] < 1
                    or cell['row'] + cell['rowspan'] > len(matrix) or cell['column'] + cell['colspan'] > len(matrix[0])
                    or not isinstance(cell.get('text'), str) or not re.fullmatch(r'[a-f0-9]{64}', cell.get('sourceDomSha256', ''))):
                return None
            for row in range(cell['row'], cell['row'] + cell['rowspan']):
                for column in range(cell['column'], cell['column'] + cell['colspan']):
                    if grid[row][column] is not None or matrix[row][column] != cell['text']:
                        return None
                    grid[row][column] = cell
        return grid if all(all(cell is not None for cell in row) for row in grid) else None

    units_pattern = _UNITS_PATTERN
    directions = lambda value: ''.join(dict.fromkeys(re.findall('[↑↓→]', value)))
    caption_key = lambda value: re.sub(r'Table([0-9]+)[.:]', r'Table\1:', dense(value), flags=re.I)
    headers, rows = rendered.get('header', []), rendered.get('rows', [])
    if not pdf_quotes or not headers or not rows:
        return set()
    matches = []
    for table in tables:
        grid = grid_for(table)
        if not grid or table.get('headerRows') not in ([], [0, 1]) or grid[0][0]['text'] != '' or grid[0][0]['rowspan'] != 1 or grid[0][0]['colspan'] != 1 or not re.search('[A-Za-z]', text(grid[1][0]['text'])):
            continue
        flags = [cell.get('header') for row in grid[:2] for cell in row[1:]]
        if any(type(flag) is not bool or flag is not flags[0] for flag in flags) or table['headerRows'] != ([0, 1] if flags[0] else []):
            continue
        names, units, paths, valid = [], [], [], True
        for column in range(len(grid[0])):
            parent, leaf = grid[0][column], grid[1][column]
            if (parent['row'] != 0 or leaf['row'] != 1 or parent['rowspan'] != 1 or leaf['rowspan'] != 1 or leaf['colspan'] != 1
                    or (column == 0 and (parent.get('header') is not True or leaf.get('header') is not True))
                    or (column > 0 and not 2 <= parent['colspan'] <= 8)):
                valid = False
                break
            path = text(parent['text']) + ' ' + text(leaf['text']) if column else text(leaf['text'])
            declarations = re.findall(units_pattern, path, re.I)
            if len(declarations) > 1:
                valid = False
                break
            unit = declarations[0] if declarations else None
            base = re.sub(units_pattern, '', re.sub('[↑↓→]', '', path), flags=re.I)
            names.append(dense(base + (' (' + unit + ')' if unit else '')))
            units.append(unit.lower() if unit else None)
            paths.append(directions(path))
        caption = re.split(r'(?<=[.!?])\s+(?=[A-Z])', str(table.get('caption', '')))[0]
        if (not valid or len(set(names)) != len(names) or len(headers) != len(grid[0]) or len(rows) != len(grid) - 2
                or not any(caption_key(caption) in caption_key(quote) for quote in html_quotes)
                or any(dense(re.sub('[↑↓→]', '', text(h))) != names[c] or directions(str(h)) != paths[c] for c, h in enumerate(headers))):
            continue
        parents = list({id(cell): cell for cell in grid[0]}.values())
        printed_headers = dense(' '.join([text(cell['text']) for cell in parents if text(cell['text'])] + [text(cell['text']) for cell in grid[1]]))
        complete = []
        for quote in pdf_quotes:
            if caption_key(caption) not in caption_key(quote):
                continue
            quoted = dense(quote)
            if quoted.count(printed_headers) != 1:
                continue
            position, valid, covered = quoted.index(printed_headers) + len(printed_headers) - 1, True, set()
            for row, values in enumerate(rows):
                cells, label = grid[row + 2], grid[row + 2][0]
                if len(values) != len(headers) or label['row'] != row + 2 or label['column'] != 0 or label['rowspan'] != 1 or label['colspan'] != 1:
                    valid = False
                    break
                delta = bool(re.fullmatch(r'Mean\s*Δ', text(label['text']))) and row == len(rows) - 1
                printed = text(label['text'])
                if not delta:
                    repeated = re.fullmatch(r'(\([^()]{1,80}\))\1', dense(label['text']))
                    printed = repeated[1] if repeated else printed
                    if vector(printed) is None or vector(printed) != vector(values[0]):
                        valid = False
                        break
                elif dense(values[0]) != dense(label['text']):
                    valid = False
                    break
                printed_values = []
                for column in range(1, len(values)):
                    cell = cells[column]
                    if (cell['row'] != row + 2 or cell['rowspan'] != 1 or cell.get('header') is not False
                            or (not delta and cell['colspan'] != 1)
                            or (delta and (cell['colspan'] != 2 or units[cell['column']] != units[cell['column'] + 1] or grid[0][cell['column']] is not grid[0][cell['column'] + 1]))):
                        valid = False
                        break
                    if delta and column < cell['column'] + cell['colspan'] - 1:
                        if str(values[column]).strip() != '—':
                            valid = False
                            break
                        continue
                    original, actual = scalar(cell['text']), number(dense(values[column]))
                    if original is None or actual is None or number(original) != actual:
                        valid = False
                        break
                    printed_values.append(original)
                    if units[column]:
                        covered.add((row + 1, column, actual, units[column]))
                if not valid:
                    break
                token = dense(printed + ''.join(printed_values))
                if quoted.count(token) != 1 or quoted.index(token) <= position:
                    valid = False
                    break
                position = quoted.index(token)
            if valid and covered:
                complete.append(covered)
        if len(complete) == 1:
            matches.append(complete[0])
    return matches[0] if len(matches) == 1 else set()

import copy
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_authenticated_pdf_hierarchical_table as rule


def fixture(*, caption='Table 1: WER (%) with parameter counts.', missing=False):
    doc = rule.fitz.open()
    page = doc.new_page(width=600, height=280)
    page.insert_text((40, 45), caption, fontsize=8)
    for y in [70, 120, 200]:
        if not (missing and y == 200):
            page.draw_line((40, y), (550, y))
    def centred(x, y, text):
        page.insert_text((x - rule.fitz.get_text_length(text, fontsize=8) / 2, y), text, fontsize=8)
    page.insert_text((40, 110), 'Method', fontsize=8)
    centred(200, 110, 'Layers')
    for x, text in zip([290, 370, 450], ['Params (M)', 'Params (M)', 'WER (%)']):
        centred(x, 110, text)
    for x, text in zip([290, 370], ['Total', 'Used']):
        centred(x, 90, text)
    rows = [['Alpha', '1-16', '13.1', '13.1', '11.33'], ['Beta', '6-16', '13.6', '13.2', '10.43']]
    for y, row in zip([145, 170], rows):
        page.insert_text((40, y), row[0], fontsize=8)
        centred(200, y, row[1])
        for x, value in zip([290, 370, 450], row[2:]):
            centred(x, y, value)
    raw = doc.tobytes()
    doc.close()
    table = {'header': ['Method', 'Layers', 'Total Params (M)', 'Used Params (M)', 'WER (%)'], 'rows': rows}
    table['markdown'] = '| ' + ' | '.join(table['header']) + ' |\n| --- | --- | --- | --- | --- |\n' + '\n'.join('| ' + ' | '.join(row) + ' |' for row in rows)
    return raw, table, [' '.join(row) for row in rows]


class CompleteFlatTableTests(unittest.TestCase):
    def test_partial_total_used_parents_and_explicit_layers_are_complete(self):
        raw, table, quotes = fixture()
        proof = rule.prove_pdf_bytes(raw, table, quotes)
        self.assertEqual(proof['grid']['headerKind'], 'complete-flat-or-partial-header-v1')
        self.assertEqual([c['header'] for c in proof['grid']['labelColumns']], ['Method', 'Layers'])
        self.assertEqual([c['groups'] for c in proof['grid']['sourceColumns']], [['Total'], ['Used'], []])
        self.assertEqual([r['labelCells'] for r in proof['grid']['sourceRows']], [r[:2] for r in table['rows']])
        self.assertEqual([c['unit'] for c in proof['grid']['sourceColumns']], ['m', 'm', '%'])

    def test_missing_layers_swapped_conditions_values_units_or_rule_reject(self):
        raw, table, quotes = fixture()
        for change in ['drop', 'swap', 'value', 'unit', 'parent', 'quote']:
            bad, evidence = copy.deepcopy(table), quotes[:]
            if change == 'drop':
                bad['header'].pop(1)
                for row in bad['rows']:
                    row.pop(1)
            elif change == 'swap':
                bad['rows'][0][1], bad['rows'][1][1] = bad['rows'][1][1], bad['rows'][0][1]
            elif change == 'value':
                bad['rows'][0][-1] = bad['rows'][1][-1]
            elif change == 'unit':
                bad['header'][-1] = 'WER (dB)'
            elif change == 'parent':
                bad['header'][2] = 'Used Params (M)'
            else:
                evidence[0] = 'Alpha 13.1 13.1 11.33'
            with self.subTest(change=change), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, evidence)
        broken, _, _ = fixture(missing=True)
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(broken, table, quotes)

    def test_partial_partition_ambiguity_is_not_resolved_by_metrics(self):
        leaves = [[[float(i), 20., float(i) + .05, 21., 'Params']] for i in range(4)]
        with self.assertRaisesRegex(ValueError, 'partial_parent_not_unique'):
            rule.assign_partial_level([[1., 10., 1., 11., 'Total']], leaves)


@unittest.skipUnless(os.environ.get('PD_COMPLETE_PDF_REAL_INPUT_DIR'), 'private original PDF opt-in')
class ActualSavedPdfTableTests(unittest.TestCase):
    def inputs(self):
        directory = Path(os.environ['PD_COMPLETE_PDF_REAL_INPUT_DIR'])
        fixture_file = Path(__file__).resolve().parents[1] / 'fixtures/reader-pdf-complete-flat-real-source.json'
        for data in json.loads(fixture_file.read_text())['cases']:
            raw = (directory / data['pdfFile']).read_bytes()
            self.assertEqual(rule.sha(raw), data['pdfSha256'])
            yield data['name'], data, raw

    def test_actual_paid_views_close_complete_grid_not_only_selected_rows(self):
        expected = {'dahal-table5': (15, 3, 2), 'dahal-table6': (4, 7, 1), 'liao-table2': (9, 3, 4)}
        for name, data, raw in self.inputs():
            with self.subTest(name=name):
                proof = rule.prove_pdf_bytes(raw, data['table'], data['quotes'])
                self.assertEqual((len(proof['grid']['sourceRows']), len(proof['grid']['sourceColumns']), len(proof['grid']['labelColumns'])), expected[name])
                if name == 'dahal-table5':
                    self.assertTrue(any('∼' in c['text'] for r in proof['grid']['sourceRows'] for c in r['cells']))
                if name == 'dahal-table6':
                    self.assertTrue(all(c['unitOrigin']['kind'] == 'caption_metric_condition' for c in proof['grid']['sourceColumns']))
                    caption = rule.normalize_quote(proof['grid']['captionEvidence']['quote'])
                    for column in proof['grid']['sourceColumns']:
                        origin = column['unitOrigin']
                        self.assertEqual(origin['text'], caption[origin['start']:origin['end']])
                if name == 'liao-table2':
                    self.assertEqual([r['labelCells'][0] for r in proof['grid']['sourceRows']], ['A', 'B', '1', '2', '3', '4', '5', '6', '7'])
                    self.assertTrue(all('(' in c['text'] for r in proof['grid']['sourceRows'] for c in r['cells']))

    def test_actual_conditions_wrong_cells_units_precision_and_partial_quotes_reject(self):
        for name, data, raw in self.inputs():
            for change in ['value', 'unit', 'precision', 'condition', 'quote']:
                bad, quotes = copy.deepcopy(data['table']), data['quotes'][:]
                if change == 'value':
                    bad['rows'][0][-1] = bad['rows'][1][-1]
                elif change == 'unit':
                    bad['header'][-1] = bad['header'][-1].replace('(%)', '(dB)')
                elif change == 'precision':
                    bad['rows'][0][-1] += '0'
                elif change == 'condition':
                    bad['rows'][0][0] = bad['rows'][1][0]
                else:
                    quotes = [' '.join(bad['rows'][0][:1] + bad['rows'][0][-1:])]
                with self.subTest(name=name, change=change), self.assertRaises(ValueError):
                    rule.prove_pdf_bytes(raw, bad, quotes)

    def test_missing_unselected_real_cell_rejects_entire_original_table(self):
        name, data, raw = next(self.inputs())
        proof = rule.prove_pdf_bytes(raw, data['table'], data['quotes'])
        cell = proof['grid']['sourceRows'][0]['cells'][0]['bbox']
        with rule.fitz.open(stream=raw, filetype='pdf') as doc:
            page = doc[proof['grid']['page'] - 1]
            page.add_redact_annot(rule.fitz.Rect(cell), fill=(1, 1, 1))
            page.apply_redactions()
            broken = doc.tobytes()
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(broken, data['table'], data['quotes'])


if __name__ == '__main__':
    unittest.main()

import copy
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_authenticated_pdf_hierarchical_table as rule


def fixture(*, missing_condition=False, missing_rule=False, same_identity=False, header='Dataset', unit='dB'):
    doc = rule.fitz.open()
    page = doc.new_page(width=560, height=400)
    page.insert_text((40, 45), 'Table 1: Complete feature comparison under explicit dataset conditions.', fontsize=9)
    for y in [70, 95, 175, 255]:
        if not (missing_rule and y == 175):
            page.draw_line((40, y), (520, y))
    for x, label in [(40, header), (170, 'Features'), (310, 'SI-SDRi (' + unit + ')'), (420, 'Accuracy (%)')]:
        page.insert_text((x, 88), label, fontsize=9)
    rows = []
    for group, condition in enumerate(['DatasetA', 'DatasetB']):
        yy = 122 + group * 80
        if not (missing_condition and group == 1):
            page.insert_text((40, yy), condition, fontsize=9)
        for index, label in enumerate(['AlphaMethod', 'AlphaMethod' if same_identity else 'BetaMethod']):
            values = [str(1 + group + index / 10), str(91 + group + index)]
            y = yy + index * 24
            page.insert_text((170, y), label, fontsize=9)
            for x, value in zip([310, 420], values):
                page.insert_text((x, y), value, fontsize=9)
            rows.append([condition, label, *values])
    raw = doc.tobytes()
    doc.close()
    table = {'header': [header, 'Features', 'SI-SDRi (dB)', 'Accuracy (%)'], 'rows': rows}
    table['markdown'] = '|Dataset|Features|SI-SDRi (dB)|Accuracy (%)|\n|---|---|---|---|\n' + '\n'.join('|' + '|'.join(row) + '|' for row in rows)
    return raw, table, [' '.join(row[1:]) for row in rows]


class MergedConditionColumnTests(unittest.TestCase):
    def test_complete_original_condition_column_and_numeric_grid(self):
        raw, table, quotes = fixture()
        proof = rule.prove_pdf_bytes(raw, table, quotes)
        self.assertEqual(proof['grid']['headerKind'], 'flat-explicit-merged-condition-column-v1')
        self.assertEqual(proof['grid']['rowLabelHeader'], 'Features')
        self.assertEqual([r['conditionPath'][0]['text'] for r in proof['grid']['sourceRows']], ['DatasetA'] * 2 + ['DatasetB'] * 2)
        self.assertEqual(len(proof['grid']['glyphs']), sum(len(w[4]) for w in proof['grid']['words']))
        self.assertEqual(len(proof['rows']), 4)

    def test_missing_condition_rule_or_same_identity_cannot_be_resolved_by_results(self):
        for options in [{'missing_condition': True}, {'missing_rule': True}, {'same_identity': True}, {'header': 'MeasuredScore'}]:
            raw, table, quotes = fixture(**options)
            with self.subTest(options=options), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, table, quotes)

    def test_wrong_group_missing_condition_column_and_wrong_unit_reject(self):
        raw, table, quotes = fixture()
        for change in ['wrong_group', 'missing_condition_column', 'missing_result_column', 'wrong_unit', 'wrong_feature', 'wrong_result']:
            bad = copy.deepcopy(table)
            if change == 'wrong_group':
                bad['rows'][0][0] = 'DatasetB'
            elif change == 'missing_condition_column':
                bad['header'] = bad['header'][1:]
                bad['rows'] = [row[1:] for row in bad['rows']]
            elif change == 'missing_result_column':
                bad['header'].pop()
                for row in bad['rows']:
                    row.pop()
            elif change == 'wrong_unit':
                bad['header'][2] = 'SI-SDRi (ms)'
            elif change == 'wrong_feature':
                bad['rows'][0][1] = 'Other'
            else:
                bad['rows'][0][2] = '2.0'
            with self.subTest(change=change), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, quotes)
        wrong_source, _, _ = fixture(unit='ms')
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(wrong_source, table, quotes)

    @unittest.skipUnless(os.environ.get('PD_MERGED_CONDITION_PDF_REAL_INPUT'), 'private actual source opt-in')
    def test_actual_zhang_all_original_rows_conditions_and_same_table_units(self):
        data = json.loads(Path(os.environ['PD_MERGED_CONDITION_PDF_REAL_INPUT']).read_text())
        raw = Path(data['pdfPath']).read_bytes()
        self.assertEqual(rule.sha(raw), '0461d572c9acfc61bc0f01671ede9f72b6bb568424679e2b2156ab39244c173f')
        for index, item in enumerate(data['tables']):
            document = rule.extract_pdf_quote_document(raw)
            quotes = []
            for quote in item['quotes']:
                try:
                    rule.quote_evidence(document, quote)
                    quotes.append(quote)
                except ValueError:
                    pass
            proof = rule.prove_pdf_bytes(raw, item['table'], quotes)
            self.assertEqual(len(proof['grid']['sourceRows']), 5)
            self.assertEqual(len(proof['rows']), 5)
            self.assertEqual(proof['grid']['conditionColumns'][0]['header'], 'Dataset' if index == 0 else 'Separator')
            wrong = copy.deepcopy(item['table'])
            wrong['rows'][0][0] = 'NBC2' if index else 'OtherDataset'
            with self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, wrong, quotes)


if __name__ == '__main__':
    unittest.main()

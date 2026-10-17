import copy
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import reader_authenticated_pdf_hierarchical_table as rule


def fixture(*, repeat=False, missing=False, ambiguous=False, missing_group=False,
            group_names=('Client1', 'Client2'), caption='Table 1: Comparing EER (%) and minDCF.'):
    doc = rule.fitz.open()
    page = doc.new_page(width=540, height=400)
    page.insert_text((40, 45), caption, fontsize=9)
    for y in [75, 105, 130, 190]:
        page.draw_line((40, y), (500, y))
    page.insert_text((40, 115), 'Method', fontsize=9)
    xs = [150, 220, 350, 420]
    for x, label in zip(xs, ['EER', 'minDCF', 'EER', 'minDCF']):
        page.insert_text((x, 120), label, fontsize=9)
    for index, label in enumerate(group_names):
        if missing_group and index == 1:
            continue
        start = xs[index * 2]
        end = xs[index * 2 + 1] + rule.fitz.get_text_length('minDCF', fontsize=9)
        center = (start + end) / 2
        if ambiguous:
            center += 20
        page.insert_text((center - rule.fitz.get_text_length(label, fontsize=9) / 2, 95), label, fontsize=9)
    rows = [('Alpha', ['1.20', '0.81', '2.30', '0.72']), ('Beta', ['1.40', '0.79', '2.50', '0.70'])]
    for index, (label, values) in enumerate(rows):
        y = 150 + index * 20
        page.insert_text((40, y), label, fontsize=9)
        for column, (x, value) in enumerate(zip(xs, values)):
            if not (missing and index == 1 and column == 3):
                page.insert_text((x, y), value, fontsize=9)
    if repeat:
        # A second complete table with the same rows must make their quotations
        # ambiguous, rather than permit selecting the first matching numbers.
        duplicate = doc.new_page(width=540, height=400)
        duplicate.show_pdf_page(duplicate.rect, rule.fitz.open(stream=doc.tobytes(), filetype='pdf'), 0)
    raw = doc.tobytes()
    doc.close()
    rendered = {'header': ['Method', 'Client1 EER (%)', 'Client1 minDCF', 'Client2 EER (%)', 'Client2 minDCF'],
                'rows': [[label, *values] for label, values in rows]}
    rendered['markdown'] = '|Method|Client1 EER (%)|Client1 minDCF|Client2 EER (%)|Client2 minDCF|\n|---|---|---|---|---|\n' + '\n'.join('|' + '|'.join(row) + '|' for row in rendered['rows'])
    return raw, rendered, [' '.join([label, *values]) for label, values in rows]


class HierarchicalPdfTableTests(unittest.TestCase):
    def test_complete_geometry_units_and_opaque_columns(self):
        raw, table, quotes = fixture()
        proof = rule.prove_pdf_bytes(raw, table, quotes)
        self.assertEqual(proof['contract'], rule.CONTRACT)
        self.assertEqual([c['unit'] for c in proof['grid']['sourceColumns']], ['%', None, '%', None])
        self.assertEqual([c['groups'] for c in proof['grid']['sourceColumns']], [['Client1'], ['Client1'], ['Client2'], ['Client2']])
        self.assertEqual(len(proof['grid']['sourceRows']), 2)
        self.assertEqual(len(proof['rows']), 2)
        self.assertEqual([c['sourceColumn'] for c in proof['columns']], [0, 2])
        digest = proof.pop('evidenceSha256')
        self.assertEqual(digest, rule.stable(proof))

    def test_strict_subset_still_checks_complete_original_grid(self):
        raw, table, quotes = fixture()
        subset = copy.deepcopy(table)
        subset['header'] = ['Method', 'Client2 EER (%)']
        subset['rows'] = [[row[0], row[3]] for row in table['rows'][:1]]
        proof = rule.prove_pdf_bytes(raw, subset, quotes[:1])
        self.assertEqual(len(proof['grid']['sourceColumns']), 4)
        self.assertEqual(len(proof['grid']['sourceRows']), 2)
        self.assertEqual(proof['columns'][0]['sourceColumn'], 2)
        broken, _, _ = fixture(missing=True)
        with self.assertRaisesRegex(ValueError, 'not_unique:0'):
            rule.prove_pdf_bytes(broken, subset, quotes[:1])

    def test_wrong_group_reorder_bare_leaf_and_unowned_unit_reject(self):
        raw, table, quotes = fixture()
        for change in ['wrong_group', 'bare_leaf', 'opaque_unit', 'reorder', 'duplicate']:
            bad = copy.deepcopy(table)
            if change == 'wrong_group':
                bad['header'][1] = 'Client9 EER (%)'
            elif change == 'bare_leaf':
                bad['header'][1] = 'EER (%)'
            elif change == 'opaque_unit':
                bad['header'][2] += ' (%)'
            elif change == 'reorder':
                bad['header'][1], bad['header'][3] = bad['header'][3], bad['header'][1]
                for row in bad['rows']:
                    row[1], row[3] = row[3], row[1]
            else:
                bad['header'][3] = bad['header'][1]
            with self.subTest(change=change), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, quotes)

    def test_full_row_quote_not_selected_cells_or_another_group_same_number(self):
        raw, table, quotes = fixture()
        subset = copy.deepcopy(table)
        subset['header'] = ['Method', 'Client1 EER (%)']
        subset['rows'] = [['Alpha', '1.20']]
        for q in [['Alpha 1.20 0.81'], ['Alpha 2.30 0.72'], ['Alpha 1.20 0.81 2.30 0.73']]:
            with self.subTest(q=q), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, subset, q)
        self.assertTrue(rule.prove_pdf_bytes(raw, subset, quotes[:1]))

    def test_wrong_numeric_precision_missing_cell_and_unlocated_header_reject(self):
        raw, table, quotes = fixture()
        for value in ['1.21', '1.2', '0.81']:
            bad = copy.deepcopy(table)
            bad['rows'][0][1] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(raw, bad, quotes)
        for options in [{'missing': True}, {'ambiguous': True}, {'repeat': True},
                        {'missing_group': True}, {'group_names': ('Client1', 'Client1')},
                        {'caption': 'Table 1: Results [%] for grouped metrics.'},
                        {'caption': 'Table 1: Unlike EER (%), these values describe minDCF.'}]:
            changed, _, _ = fixture(**options)
            with self.subTest(options=options), self.assertRaises(ValueError):
                rule.prove_pdf_bytes(changed, table, quotes)

    def test_ambiguous_parent_partition_is_not_resolved_by_column_order(self):
        leaves = [[[float(i), 20., float(i) + .05, 21., 'EER']] for i in range(4)]
        parents = [[1., 10., 1., 11., 'A'], [3., 10., 3., 11., 'B']]
        with self.assertRaisesRegex(ValueError, 'ambiguous|not_unique'):
            rule.assign_level(parents, leaves)

    @unittest.skipUnless(os.environ.get('PD_HIERARCHICAL_PDF_REAL_INPUT'), 'private source opt-in')
    def test_actual_meng_full_groups_and_conditions_without_modifying_paid_draft(self):
        import json
        data = json.loads(Path(os.environ['PD_HIERARCHICAL_PDF_REAL_INPUT']).read_text())
        raw = Path(data['pdfPath']).read_bytes()
        self.assertEqual(rule.sha(raw), '464eb076f43b020579c90ac5158b18d8e15ca6901051d96bc19bc705591f09cc')
        proofs = [rule.prove_pdf_bytes(raw, item['table'], item['quotes']) for item in data['tables']]
        self.assertEqual([p['grid']['page'] for p in proofs], [3, 4])
        self.assertEqual([len(p['grid']['sourceRows']) for p in proofs], [28, 7])
        self.assertEqual([len(p['grid']['sourceColumns']) for p in proofs], [8, 4])
        self.assertEqual([len(p['rows']) for p in proofs], [3, 7])
        self.assertEqual([r['conditionPath'][0]['text'] for r in proofs[0]['grid']['sourceRows'][::7]], [
            'Trained on VoxCeleb1, Evaluated on Vox-O.', 'Trained on VoxCeleb2, Evaluated on Vox-O.',
            'Trained on VoxCeleb2, Evaluated on Vox-E.', 'Trained on VoxCeleb2, Evaluated on Vox-H.'])
        # A different condition's identically named method cannot lend its
        # quotation to the selected first condition, even within the same table.
        changed = copy.deepcopy(data['tables'][0])
        changed['quotes'][0] = proofs[0]['grid']['sourceRows'][7]['quoteEvidence']['quote']
        with self.assertRaises(ValueError):
            rule.prove_pdf_bytes(raw, changed['table'], changed['quotes'])


if __name__ == '__main__':
    unittest.main()

import copy,json,os,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import reader_sealed_pdf_column_units as rule

def fixture(mean_sd=False,internal_gap=False,duplicate_bottom=False):
    doc=rule.fitz.open();page=doc.new_page()
    matrix=[['Method','Value (%)','Time (ms)'],['LongerAlpha mark' if internal_gap else 'Alpha','0.50 ± 0.10' if mean_sd else '0.50','10.00'],['Beta','-0.25 ± 0.20' if mean_sd else '-0.25','12.00']]
    for y in ([45,68,124,125] if duplicate_bottom else [45,68,125]):page.draw_line((40,y),(450,y))
    for r,row in enumerate(matrix):
        for c,value in enumerate(row):page.insert_text(([50,230,360][c],[60,86,110][r]),value,fontsize=10)
    caption=('Table 1. Complete methods and literal measurements.' if mean_sd else 'Table 1: Complete methods and literal measurements.');page.insert_text((40,148),caption,fontsize=10)
    raw=doc.tobytes();doc.close()
    table={'ordinal':1,'sourceDomSha256':'a'*64,'caption':caption,'matrix':copy.deepcopy(matrix),'cells':[]}
    if mean_sd:
        table['caption']=caption.replace('1.','1:');table['matrix'][1][1]='0.50 ±\\pm 0.10'
    for r,row in enumerate(table['matrix']):
        for c,v in enumerate(row):table['cells'].append({'row':r,'column':c,'rowspan':1,'colspan':1,'text':v,'sourceDomSha256':rule.sha((str(r)+':'+str(c)).encode())})
    document=rule.extract_pdf_quote_document(raw);quote=document['normalizedFullText']
    return raw,table,matrix,[quote]

class PdfColumnUnitsTests(unittest.TestCase):
    def test_full_literal_geometry_only_assigns_its_real_columns(self):
        raw,table,view,quotes=fixture();proof=rule.prove_pdf_bytes(raw,[table],view,quotes)
        self.assertEqual(proof['contract'],rule.CONTRACT);self.assertEqual(len(proof['cells']),9)
        self.assertEqual(proof['wordBoxCount'],sum(len(c['words']) for c in proof['cells']))
        self.assertEqual(proof['units'],[{'column':1,'unit':'%','values':['0.50','-0.25']},{'column':2,'unit':'ms','values':['10.00','12.00']}])
        digest=proof.pop('evidenceSha256');self.assertEqual(digest,rule.stable(proof))

    def test_mean_sd_uses_complete_literal_geometry_and_exact_source_values(self):
        doc=rule.fitz.open();page=doc.new_page()
        view=[['Method','Value (%)','Time (ms)'],['Alpha','0.50 ± 0.10','10.00'],['Beta','-0.25 ± 0.20','12.00']]
        for y in [45,68,125]:page.draw_line((40,y),(450,y))
        for r,row in enumerate(view):
            for c,value in enumerate(row):page.insert_text(([50,230,360][c],[60,86,110][r]),value,fontsize=10)
        caption='Table 2. Complete uncertainty values and literal measurements.'
        page.insert_text((40,148),caption,fontsize=10);raw=doc.tobytes();doc.close()
        table={'ordinal':2,'sourceDomSha256':'b'*64,'caption':caption.replace('2.','2:'),'matrix':copy.deepcopy(view),'cells':[]}
        table['matrix'][1][1]='0.50 ±\\pm 0.10'
        for r,row in enumerate(table['matrix']):
            for c,value in enumerate(row):table['cells'].append({'row':r,'column':c,'rowspan':1,'colspan':1,'text':value,'sourceDomSha256':rule.sha((str(r)+':'+str(c)).encode())})
        quotes=[rule.extract_pdf_quote_document(raw)['rawFullText']]
        proof=rule.prove_pdf_bytes(raw,[table],view,quotes)
        self.assertEqual(proof['units'][0],{'column':1,'unit':'%','values':['0.50 ± 0.10','-0.25 ± 0.20']})
        self.assertEqual(len(proof['cells']),9);self.assertTrue(proof['differences'])
        for name,change in [
            ('uncertainty_sign',lambda v:v[1].__setitem__(1,'0.50 ± -0.10')),
            ('uncertainty_precision',lambda v:v[1].__setitem__(1,'0.50 ± 0.1')),
            ('uncertainty_changed',lambda v:v[1].__setitem__(1,'0.50 ± 0.20')),
            ('mean_changed',lambda v:v[1].__setitem__(1,'0.51 ± 0.10')),
            ('mean_precision',lambda v:v[1].__setitem__(1,'0.5 ± 0.10')),
            ('mean_only',lambda v:v[1].__setitem__(1,'0.50')),
            ('other_unit',lambda v:v[0].__setitem__(1,'Value (ms)')),
            ('scaled',lambda v:v[1].__setitem__(1,'50 ± 10')),
            ('borrowed_row',lambda v:v[1].__setitem__(1,v[2][1]))]:
            changed=copy.deepcopy(view);change(changed)
            with self.subTest(name=name),self.assertRaises(ValueError):rule.prove_pdf_bytes(raw,[table],changed,quotes)
        for wrong in ['Table 3: Complete uncertainty values and literal measurements.','Table 2: Different experiment measurements.']:
            changed=copy.deepcopy(table);changed['caption']=wrong
            with self.subTest(caption=wrong),self.assertRaises(ValueError):rule.prove_pdf_bytes(raw,[changed],view,quotes)
        duplicated=rule.fitz.open(stream=raw,filetype='pdf');duplicated[0].insert_text((40,170),caption,fontsize=10)
        duplicate_raw=duplicated.tobytes();duplicated.close()
        with self.assertRaisesRegex(ValueError,'source_table_not_unique:0'):rule.prove_pdf_bytes(duplicate_raw,[table],view,[rule.extract_pdf_quote_document(duplicate_raw)['rawFullText']])
        with self.assertRaises(ValueError):rule.prove_pdf_bytes(raw,[table],view,[quotes[0].replace('0.10','0.11')])
        self.assertFalse(rule.numeric_source_equal('0.500.50 ± 0.10','0.50 ± 0.10'))
        self.assertFalse(rule.numeric_source_equal('0.50 ± -0.10','0.50 ± -0.10'))
        self.assertFalse(rule.numeric_source_equal('0.50 ± 0.10','0.50 ± 0.100'))

    def test_explicit_direction_projection_and_single_line_footnote_order_are_narrow(self):
        self.assertEqual(rule.header_norm('CER (%) ↓\\downarrow'),rule.header_norm('CER (%) ↓'))
        self.assertNotEqual(rule.header_norm('CER (%) ↓\\uparrow'),rule.header_norm('CER (%) ↓'))
        words=[(40,80,60,90,'Alpha'),(62,78.6,72,88.6,'ref')]
        self.assertEqual([w[4] for w in rule.ordered_cell_words(words)],['Alpha','ref'])
        # The previous unrelated multiline ordering remains unchanged.
        separated=[(40,100,60,110,'second'),(62,70,72,80,'first')]
        self.assertEqual([w[4] for w in rule.ordered_cell_words(separated)],['first','second'])
        self.assertNotEqual([w[4] for w in rule.ordered_cell_words(separated)],['second','first'])

    def test_real_multiline_cell_cannot_use_x_order_to_forge_a_single_line(self):
        doc=rule.fitz.open();page=doc.new_page()
        for y in [45,68,130]:page.draw_line((40,y),(450,y))
        for x,value in [(50,'Method'),(230,'Value (%)'),(360,'Time (ms)')]:page.insert_text((x,60),value,fontsize=10)
        # PDF insertion order makes the continuous quote say ref Alpha, while
        # its actual two printed baselines read Alpha then ref.
        page.insert_text((50,92),'ref',fontsize=10);page.insert_text((80,86),'Alpha',fontsize=10)
        for x,value in [(230,'0.50'),(360,'10.00')]:page.insert_text((x,86),value,fontsize=10)
        for x,value in [(50,'Beta'),(230,'-0.25'),(360,'12.00')]:page.insert_text((x,115),value,fontsize=10)
        caption='Table 8: Complete methods and literal measurements.';page.insert_text((40,150),caption,fontsize=10)
        raw=doc.tobytes();doc.close();matrix=[['Method','Value (%)','Time (ms)'],['ref Alpha','0.50','10.00'],['Beta','-0.25','12.00']]
        table={'ordinal':8,'sourceDomSha256':'c'*64,'caption':caption,'matrix':matrix,'cells':[]}
        for r,row in enumerate(matrix):
            for c,value in enumerate(row):table['cells'].append({'row':r,'column':c,'text':value,'rowspan':1,'colspan':1,'sourceDomSha256':rule.sha(f'{r}:{c}'.encode())})
        quote=rule.extract_pdf_quote_document(raw)['rawFullText']
        with self.assertRaises(ValueError):rule.prove_pdf_bytes(raw,[table],matrix,[quote])

    def test_mean_uncertainty_only_adjacent_numeric_whitespace_is_equivalent(self):
        raw,table,view,quotes=fixture(mean_sd=True)
        compact=copy.deepcopy(view)
        for row in compact[1:]:row[1]=row[1].replace(' ± ','±')
        proof=rule.prove_pdf_bytes(raw,[table],compact,quotes)
        self.assertEqual(proof['units'][0]['values'],['0.50±0.10','-0.25±0.20'])
        # Rebuild an actual compact PDF, then replay the spaced normal Reader view.
        doc=rule.fitz.open();page=doc.new_page()
        for y in [45,68,125]:page.draw_line((40,y),(450,y))
        for r,row in enumerate(compact):
            for c,value in enumerate(row):page.insert_text(([50,230,360][c],[60,86,110][r]),value,fontsize=10)
        page.insert_text((40,148),table['caption'],fontsize=10);compact_raw=doc.tobytes();doc.close()
        compact_quotes=[rule.extract_pdf_quote_document(compact_raw)['rawFullText']]
        proof=rule.prove_pdf_bytes(compact_raw,[table],view,compact_quotes)
        self.assertEqual(proof['units'][0]['values'],['0.50 ± 0.10','-0.25 ± 0.20'])
        for wrong in ['0.50 ± -0.10','0.50 ± 0.100','0.51 ± 0.10','0.50 + 0.10','0.50 ∓ 0.10']:
            changed=copy.deepcopy(view);changed[1][1]=wrong
            with self.subTest(value=wrong),self.assertRaises(ValueError):rule.prove_pdf_bytes(compact_raw,[table],changed,compact_quotes)
        self.assertEqual(rule.norm('alpha ± beta'),'alpha ± beta')
        self.assertEqual(rule.norm('x1 ± 2y'),'x1 ± 2y')

    def test_internal_label_gap_enumerates_all_boundaries_and_keeps_only_exact_grid(self):
        raw,table,view,quotes=fixture(internal_gap=True)
        proof=rule.prove_pdf_bytes(raw,[table],view,quotes)
        self.assertEqual(proof['displayMatrix'],view)
        self.assertEqual(len(proof['cells']),9)
        changed=copy.deepcopy(view);changed[1][0]='LongerAlpha'
        with self.assertRaises(ValueError):rule.prove_pdf_bytes(raw,[table],changed,quotes)

    def test_two_real_grid_windows_remain_ambiguous_and_combinations_are_bounded(self):
        raw,table,view,quotes=fixture(duplicate_bottom=True)
        with self.assertRaisesRegex(ValueError,'source_table_not_unique:0'):rule.prove_pdf_bytes(raw,[table],view,quotes)
        self.assertEqual(len(rule.bounded_column_boundaries([[1,2]]*6,0,20)),64)
        with self.assertRaisesRegex(ValueError,'exceed_64'):rule.bounded_column_boundaries([[1,2]]*7,0,20)
        with self.assertRaisesRegex(ValueError,'boundary_missing'):rule.bounded_column_boundaries([[]],0,20)

    def test_changed_or_incomplete_matrix_cases_refuse(self):
        raw,original,view,quotes=fixture()
        cases=[('unit',lambda t,v,q:v[0].__setitem__(1,'Value (ms)')),
               ('sign',lambda t,v,q:v[2].__setitem__(1,'0.25')),
               ('precision',lambda t,v,q:v[1].__setitem__(1,'0.5')),
               ('moved_column',lambda t,v,q:v[1].__setitem__(slice(1,3),v[1][1:3][::-1])),
               ('deleted_row',lambda t,v,q:v.pop()),
               ('reordered_rows',lambda t,v,q:v.__setitem__(slice(1,3),v[1:3][::-1])),
               ('method',lambda t,v,q:v[1].__setitem__(0,'Gamma')),
               ('missing_cell',lambda t,v,q:t['cells'].pop()),
               ('duplicate_cell',lambda t,v,q:t['cells'].__setitem__(1,copy.deepcopy(t['cells'][0]))),
               ('wrong_source_numeric',lambda t,v,q:t['matrix'][1].__setitem__(1,'0.51')),
               ('unknown_header_alias',lambda t,v,q:t['matrix'][0].__setitem__(1,'Value \\fake (%)')),
               ('partial_quote',lambda t,v,q:q.__setitem__(0,'Alpha 0.50 10.00 Beta -0.25 12.00')),
               ('quote_digit_changed',lambda t,v,q:q.__setitem__(0,q[0].replace('0.50','0.51'))),
               ('fullwidth_digit',lambda t,v,q:v[1].__setitem__(1,'０.50'))]
        for name,change in cases:
            t=copy.deepcopy(original);v=copy.deepcopy(view);q=copy.deepcopy(quotes);change(t,v,q)
            with self.subTest(name=name),self.assertRaises(ValueError):rule.prove_pdf_bytes(raw,[t],v,q)
        with self.assertRaisesRegex(ValueError,'source_table_not_unique:2'):
            second=copy.deepcopy(original);second['ordinal']=2;rule.prove_pdf_bytes(raw,[original,second],view,quotes)

    def test_cross_column_boxes_refuse_even_if_words_remain_literal(self):
        raw,table,view,quotes=fixture();doc=rule.fitz.open(stream=raw,filetype='pdf')
        class BadPage:
            number=0
            def get_text(self,kind):
                values=doc[0].get_text(kind)
                if kind=='words':
                    values=copy.deepcopy(values);w=list(values[0]);w[2]=300;values[0]=tuple(w)
                return values
            def get_drawings(self):return doc[0].get_drawings()
        with self.assertRaises(ValueError):rule.table_proofs([BadPage()],table,view)
        doc.close()

    @unittest.skipUnless(os.environ.get('PD_PDF_COLUMN_REAL_SOURCE_ROOT'),'real source opt-in')
    def test_actual_full_mixed_matrix_retains_pdf_origin_and_all_values(self):
        root=Path(os.environ['PD_PDF_COLUMN_REAL_SOURCE_ROOT'])/'2610.11787'/'generation-000001'
        source=json.loads((root/'source-runtime.json').read_text());document=rule.extract_pdf_quote_document((root/'source.pdf').read_bytes())
        start=document['rawFullText'].index('Edited Concepts\nModality');end=document['rawFullText'].index('Table 4:',start)
        start=document['rawFullText'].rfind('Table 3 reports',0,start)
        quote=document['rawFullText'][start:end].strip()
        view=json.loads(Path('/tmp/reader-11787-pdf-complete-matrix-unit-diagnostic.json').read_text())['rendered'];matrix=[view['header']]+view['rows']
        proof=rule.prove_pdf_bytes((root/'source.pdf').read_bytes(),source['structuredArtifacts']['tables'],matrix,[quote])
        self.assertEqual(len(proof['cells']),35);self.assertEqual(proof['wordBoxCount'],99)
        self.assertEqual(proof['units'][0]['values'],['-0.11','-0.25','-0.27','-1.84','-3.35','-4.58'])
        self.assertTrue(proof['differences']);self.assertTrue(all(c['valueOrigin']=='sealed_pdf' for c in proof['cells']))
if __name__=='__main__':unittest.main()

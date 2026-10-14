import copy,json,os,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import reader_sealed_pdf_column_units as rule

def fixture():
    doc=rule.fitz.open();page=doc.new_page()
    matrix=[['Method','Value (%)','Time (ms)'],['Alpha','0.50','10.00'],['Beta','-0.25','12.00']]
    for y in [45,68,125]:page.draw_line((40,y),(450,y))
    for r,row in enumerate(matrix):
        for c,value in enumerate(row):page.insert_text(([50,230,360][c],[60,86,110][r]),value,fontsize=10)
    caption='Table 1: Complete methods and literal measurements.';page.insert_text((40,148),caption,fontsize=10)
    raw=doc.tobytes();doc.close()
    table={'ordinal':1,'sourceDomSha256':'a'*64,'caption':caption,'matrix':copy.deepcopy(matrix),'cells':[]}
    for r,row in enumerate(matrix):
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

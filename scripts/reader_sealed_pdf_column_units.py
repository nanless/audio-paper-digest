"""Independent full PDF matrix geometry for column units; never a prose-unit inference."""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-sealed-pdf-column-units')
import base64, hashlib, itertools, json, os, re, stat, sys, unicodedata
import fitz
from reader_sealed_pdf_quote_evidence import extract_pdf_quote_document, quote_evidence
CONTRACT = 'reader-sealed-pdf-column-units-v1'
def need(ok, why):
    if not ok: raise ValueError(why)
def sha(value): return hashlib.sha256(value).hexdigest()
def stable(value): return sha(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
def norm(value):
    return re.sub(r'\s+',' ',value.replace('∆','Δ').replace('→',' → ')).strip()
def compact(value): return re.sub(r'\s+','',norm(value))
def header_norm(value):
    # Explicit same-symbol HTML/TeX duplicate, never number/unit conversion.
    return compact(value).replace('Δ\\Delta','Δ')
def center(word): return ((word[0]+word[2])/2,(word[1]+word[3])/2)
NUM = re.compile(r'[-+]?\d+(?:\.\d+)?\Z')
UNIT = re.compile(r'(.+?)(?:\(\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\)|\[\s*(%|dB|ms|s|h|Hz|kHz|MHz|GB|MB|KB|pp)\s*\])\Z',re.I)
def source_grid(table):
    matrix=table.get('matrix'); need(isinstance(matrix,list) and 2<=len(matrix)<=65,'source_matrix_missing')
    width=len(matrix[0]);need(2<=width<=16 and all(isinstance(row,list) and len(row)==width and all(isinstance(v,str) for v in row) for row in matrix),'source_matrix_not_complete')
    need(type(table.get('ordinal')) is int and table['ordinal']>0 and re.fullmatch('[a-f0-9]{64}',table.get('sourceDomSha256','')) is not None,'source_table_identity_missing')
    need(isinstance(table.get('caption'),str) and table['caption'].strip(),'caption_missing')
    cells=table.get('cells');need(isinstance(cells,list) and len(cells)==len(matrix)*width,'source_cells_missing')
    for r,row in enumerate(matrix):
        for c,text in enumerate(row):
            found=[cell for cell in cells if cell.get('row')==r and cell.get('column')==c]
            need(len(found)==1 and found[0].get('text')==text and found[0].get('rowspan')==1 and found[0].get('colspan')==1 and re.fullmatch('[a-f0-9]{64}',found[0].get('sourceDomSha256','')) is not None,'source_cell_not_unique')
    return matrix,width

def table_proofs(doc,table,view):
    matrix,width=source_grid(table)
    need(len(view)==len(matrix) and all(len(row)==width for row in view),'view_shape_changed')
    need(all(header_norm(a)==header_norm(b) for a,b in zip(matrix[0],view[0])),'view_header_changed')
    numeric=[c for c in range(width) if all(NUM.fullmatch(row[c]) for row in matrix[1:])]
    units={c:UNIT.fullmatch(norm(view[0][c])) for c in numeric};units={c:m.group(2) or m.group(3) for c,m in units.items() if m}
    need(units,'no_literal_numeric_unit_column')
    need(all(view[r][c]==matrix[r][c] for r in range(1,len(matrix)) for c in numeric),'source_numeric_coordinate_changed')
    captions=[(page,b) for page in doc for b in page.get_text('blocks') if compact(b[4])==compact(table['caption'])]
    need(len(captions)==1,'caption_not_unique')
    page,caption=captions[0];all_words=page.get_text('words')
    rules=sorted([list(d['rect']) for d in page.get_drawings() if d['rect'].height<1 and d['rect'].width>40],key=lambda x:x[1]);results={}
    for top,separator,bottom in itertools.combinations(rules,3):
        if not all(abs(r[0]-top[0])<.1 and abs(r[2]-top[2])<.1 for r in [separator,bottom]):continue
        above=0<=top[1]-caption[3]<=40;below=0<=caption[1]-bottom[1]<=40
        if not (above or below):continue
        if any(b!=caption and re.match(r'^\s*(?:Table|Figure|Fig\.)\s*\d+',b[4],re.I) and b[1]<max(bottom[1],caption[3]) and b[3]>min(top[1],caption[1]) for b in page.get_text('blocks')):continue
        words=[w for w in all_words if top[0]<center(w)[0]<top[2] and top[1]<center(w)[1]<bottom[1]]
        header=sorted([w for w in words if center(w)[1]<separator[1]],key=lambda w:w[0]);hc=[];pos=0
        for expected in matrix[0]:
            stops=[stop for stop in range(pos+1,len(header)+1) if header_norm(' '.join(w[4] for w in header[pos:stop]))==header_norm(expected)]
            if len(stops)!=1:break
            stop=stops[0];hc.append(header[pos:stop]);pos=stop
        if len(hc)!=width or pos!=len(header):continue
        merged=[]
        for a,b in sorted((w[0],w[2]) for w in words):
            if merged and a<=merged[-1][1]:merged[-1][1]=max(b,merged[-1][1])
            else:merged.append([a,b])
        gaps=[(a[1],b[0]) for a,b in zip(merged,merged[1:])];edges=[top[0]]
        for left,right in zip(hc,hc[1:]):
            candidates=[g for g in gaps if g[0]>=max(w[2] for w in left) and g[1]<=min(w[0] for w in right)]
            if len(candidates)!=1:break
            edges.append(sum(candidates[0])/2)
        if len(edges)!=width:continue
        edges.append(top[2]);body=[w for w in words if center(w)[1]>separator[1]]
        for anchor_col in range(1,width):
            anchors=sorted([w for w in body if edges[anchor_col]<center(w)[0]<edges[anchor_col+1]],key=lambda w:center(w)[1])
            if len(anchors)!=len(matrix)-1:continue
            ys=[center(w)[1] for w in anchors]
            if any(b-a<6 for a,b in zip(ys,ys[1:])):continue
            rowedges=[separator[1]]+[(a+b)/2 for a,b in zip(ys,ys[1:])]+[bottom[1]]
            projected=[[' '.join(w[4] for w in c) for c in hc]];cells=[{'row':0,'column':c,'words':[list(w[:5]) for w in values]} for c,values in enumerate(hc)]
            valid=True
            for r in range(len(anchors)):
                row=[]
                for c in range(width):
                    values=[w for w in body if rowedges[r]<center(w)[1]<rowedges[r+1] and edges[c]<center(w)[0]<edges[c+1]]
                    if not values:valid=False;break
                    values=sorted(values,key=lambda w:(round(center(w)[1]/3),w[0]));row.append(' '.join(w[4] for w in values));cells.append({'row':r+1,'column':c,'words':[list(w[:5]) for w in values]})
                if not valid:break
                projected.append(row)
            if not valid or any(norm(a)!=norm(b) for row,want in zip(projected,view) for a,b in zip(row,want)):continue
            used=[tuple(w) for cell in cells for w in cell['words']]
            if len(used)!=len(words) or len(set(used))!=len(words):continue
            if any(max(w[2] for cell in cells if cell['column']==c for w in cell['words'])>=min(w[0] for cell in cells if cell['column']==c+1 for w in cell['words']) for c in range(width-1)):continue
            for cell in cells:
                original=next(c for c in table['cells'] if c['row']==cell['row'] and c['column']==cell['column'])
                cell.update(sourceDomSha256=original['sourceDomSha256'],sourceHtmlText=original['text'],pdfText=projected[cell['row']][cell['column']],valueOrigin='sealed_pdf')
            proof={'page':page.number+1,'bbox':[top[0],top[1],top[2],bottom[1]],'caption':caption[4],'columnBoundaries':edges,'rowBoundaries':rowedges,'displayMatrix':projected,'cells':cells,'wordBoxCount':len(words),'units':[{'column':c,'unit':unit.lower(),'values':[view[r][c] for r in range(1,len(view))]} for c,unit in units.items()]}
            key=stable({k:v for k,v in proof.items() if k!='rowBoundaries'})
            results.setdefault(key,proof)
    need(len(results)==1,'complete_matrix_geometry_not_unique:'+str(len(results)))
    return next(iter(results.values()))

def prove_pdf_bytes(pdf_bytes,tables,view,quotes):
    need(isinstance(view,list) and 2<=len(view)<=65 and all(isinstance(row,list) and 2<=len(row)<=16 and all(isinstance(v,str) and len(v)<=4000 for v in row) for row in view),'view_invalid')
    need(isinstance(quotes,list) and 1<=len(quotes)<=64,'quotes_invalid')
    document=extract_pdf_quote_document(pdf_bytes)
    valid=[]
    for quote in quotes:
        try:valid.append(quote_evidence(document,quote))
        except ValueError:continue
    full=norm(' '.join(v for row in view for v in row))
    valid=[q for q in valid if norm(q['quote']).count(full)==1]
    need(valid,'complete_matrix_not_in_bound_pdf_quote')
    doc=fitz.open(stream=pdf_bytes,filetype='pdf');results=[]
    try:
        for table in tables:
            try:
                proof=table_proofs(doc,table,view)
                proof.update(contract=CONTRACT,valueOrigin='sealed_pdf',projectionProfile='whitespace-same-mathematical-delta-and-arrow-spacing-v1',viewSha256=stable(view),displayMatrixSha256=stable(proof['displayMatrix']),projectedEquivalent=True,pdfSha256=sha(pdf_bytes),sourceTableOrdinal=table['ordinal'],sourceTableDomSha256=table['sourceDomSha256'],sourceTableSha256=stable(table),quoteEvidence=valid,backend={'name':'pymupdf','version':fitz.version[0]})
                proof['differences']=[{'row':r,'column':c,'sourceHtmlText':table['matrix'][r][c],'pdfText':v,'valueOrigin':'sealed_pdf'} for r,row in enumerate(proof['displayMatrix']) for c,v in enumerate(row) if v!=table['matrix'][r][c]]
                proof['evidenceSha256']=stable(proof);results.append(proof)
            except (ValueError,KeyError,TypeError,IndexError):continue
    finally:doc.close()
    need(len(results)==1,'source_table_not_unique:'+str(len(results)))
    return results[0]

def main():
    from runtime_guard import require_external_runtime,require_workspace_role
    require_external_runtime('reader-sealed-pdf-column-units');require_workspace_role('daily')
    need(len(sys.argv)==2 and sys.argv[1].isdigit() and int(sys.argv[1])>=3,'private_descriptor_required');fd=int(sys.argv[1]);st=os.fstat(fd)
    need(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_mode&0o077==0 and 2<=st.st_size<=96*1024*1024,'private_bounded_descriptor_required')
    data=json.loads(os.read(fd,st.st_size));need(set(data)=={'pdfBase64','pdfSha256','tables','view','quotes'},'descriptor_fields_invalid');raw=base64.b64decode(data['pdfBase64'],validate=True);need(sha(raw)==data['pdfSha256'],'pdf_sha_changed')
    try:result={'contract':CONTRACT,'eligible':True,'evidence':prove_pdf_bytes(raw,data['tables'],data['view'],data['quotes'])}
    except ValueError as e:result={'contract':CONTRACT,'eligible':False,'reason':str(e)}
    print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()

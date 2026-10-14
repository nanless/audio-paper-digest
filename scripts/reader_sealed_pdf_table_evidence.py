"""Generic exact PDF grid evidence; PDF display values retain their own origin."""
if __name__ == '__main__':
 from runtime_guard import require_external_runtime
 require_external_runtime('reader-sealed-pdf-table-evidence')
import json,re,unicodedata,fitz
from pathlib import Path
import hashlib,base64,sys,os,stat
CONTRACT='reader-sealed-pdf-table-grid-v1'
def need(condition,reason):
 if not condition:raise ValueError(reason)
def stable(value):
 return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def validate_source_grid(table):
 need(type(table.get('ordinal')) is int and table['ordinal']>0,'source_ordinal_invalid');need(isinstance(table.get('caption'),str) and table['caption'].strip(),'source_caption_missing');need(re.fullmatch(r'[a-f0-9]{64}',str(table.get('sourceDomSha256',''))) is not None,'source_dom_sha_missing')
 cells=table.get('cells',[]);need(isinstance(cells,list) and len(cells)==sum(len(row) for row in table['matrix']),'source_cells_incomplete');need(all(isinstance(text,str) for row in table['matrix'] for text in row),'source_cell_text_invalid')
 for r,row in enumerate(table['matrix']):
  for c,text in enumerate(row):
   matches=[v for v in cells if v.get('row')==r and v.get('column')==c]
   need(len(matches)==1 and matches[0].get('rowspan')==1 and matches[0].get('colspan')==1 and matches[0].get('text')==text,'source_dom_cell_not_unique_or_spanned')
   need(re.fullmatch(r'[a-f0-9]{64}',str(matches[0].get('sourceDomSha256',''))) is not None,'source_cell_dom_sha_missing')
SYMBOLS={'alpha':'α','dagger':'†','uparrow':'↑','downarrow':'↓'}
def norm(s):
 s=unicodedata.normalize('NFKC',str(s));s=re.sub(r'(?<=-)\s+(?=[A-Za-z])','',s)
 for k,v in SYMBOLS.items():
  s=re.sub(re.escape(v)+r'\s*\\+'+k+r'(?![A-Za-z])',v,s);s=re.sub(r'\\+'+k+r'(?![A-Za-z])',v,s)
 s=re.sub(r'^Table\s*(\d+)\s*[.:]',r'Table\1:',s)
 return re.sub(r'\s+','',s)
def centre(w):return((w[0]+w[2])/2,(w[1]+w[3])/2)
def group(ws):
 out=[]
 for w in sorted(ws,key=lambda w:(centre(w)[1],w[0])):
  y=centre(w)[1];matched=[g for g in out if abs(g[0]-y)<=3.0]
  if len(matched)>1:raise ValueError('ambiguous_row_baseline')
  if matched:matched[0][1].append(w)
  else:out.append([y,[w]])
 return[(y,sorted(ws,key=lambda w:w[0]))for y,ws in out]
def header(words,expected):
 words=sorted(words,key=lambda w:w[0]);pos=0;cells=[]
 for want in expected:
  found=[]
  for stop in range(pos+1,len(words)+1):
   if norm(' '.join(w[4]for w in words[pos:stop]))==norm(want):found.append(stop)
  if len(found)!=1:raise ValueError('header_not_exact:'+want)
  stop=found[0];cells.append(words[pos:stop]);pos=stop
 if pos!=len(words):raise ValueError('uncovered_header_unit_or_token')
 return cells
def prove_table(doc,table):
 matrix=table.get('matrix');need(isinstance(matrix,list) and len(matrix)>1 and isinstance(matrix[0],list),'source_grid_missing');width=len(matrix[0]);need(width>1 and all(isinstance(row,list) and len(row)==width for row in matrix),'source_grid_not_rectangular');validate_source_grid(table)
 expected_caption=norm(table['caption']);caps=[]
 for page in doc:
  for b in page.get_text('blocks'):
   if norm(b[4])==expected_caption:caps.append((page,b))
 if len(caps)!=1:raise ValueError('caption_not_unique:'+str(len(caps)))
 page,cap=caps[0];lines=[];other_captions=[b for b in page.get_text('blocks') if b!=cap and re.match(r'^\s*(?:Table|Figure|Fig\.)\s*\d+',b[4],re.I)]
 for draw in page.get_drawings():
  box=draw['rect']
  if box.height<1 and box.width>40 and box.y0>=cap[3]-1 and box.x0<=((cap[0]+cap[2])/2)<=box.x1:lines.append(box)
 lines.sort(key=lambda b:b.y0)
 matches=[]
 methods=[norm(row[0]) for row in matrix[1:]]
 need(all(methods) and len(set(methods))==len(methods),'method_rows_not_unique')
 for top in lines:
  same=[b for b in lines if abs(b.x0-top.x0)<.1 and abs(b.x1-top.x1)<.1 and b.y0>=top.y0]
  if len(same)<2:continue
  words=page.get_text('words');hw=[w for w in words if top.x0<=centre(w)[0]<=top.x1 and top.y0<=centre(w)[1]<same[1].y0]
  try:hc=header(hw,matrix[0])
  except ValueError:continue
  centers=[sum(centre(w)[0]for w in c)/len(c)for c in hc];edges=[top.x0]+[(a+b)/2 for a,b in zip(centers,centers[1:])]+[top.x1]
  for bottom in same[1:]:
   if any(b[3]>=cap[3]-1 and b[1]<bottom.y0 and max(b[0],top.x0)<min(b[2],top.x1) for b in other_captions):continue
   body=[w for w in words if top.x0<=centre(w)[0]<=top.x1 and same[1].y0<=centre(w)[1]<bottom.y0]
   rows=group(body)
   if len(rows)!=len(matrix)-1:continue
   parsed=[];proof=[];valid=True
   for index,(y,ws)in enumerate(rows,1):
    cells=[]
    for col in range(width):
     values=[w for w in ws if edges[col]<=centre(w)[0]<edges[col+1]];text=' '.join(w[4]for w in values).strip()
     if not values:valid=False;break
     cells.append(text);proof.append({'row':index,'column':col,'words':[list(w[:5])for w in values]})
    if not valid or norm(cells[0])!=norm(matrix[index][0]):valid=False;break
    # A data row must consist solely of the one exact method label and complete literal numeric/dash/units cells.
    if any(not re.fullmatch(r'(?:[+−-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+−-]?\d+)?|[–−-])(?:\s+(?:[A-Za-z%]+))?',c)for c in cells[1:]):valid=False;break
    parsed.append(cells)
   if valid:
    column_words=[list(values) for values in hc]
    for cell in proof:column_words[cell['column']].extend(cell['words'])
    actual_edges=[top.x0]
    for column in range(width-1):
     right=max(word[2] for word in column_words[column]);left=min(word[0] for word in column_words[column+1])
     if right>=left:valid=False;break
     actual_edges.append((right+left)/2)
    if not valid:continue
    actual_edges.append(top.x1)
    matches.append({'page':page.number+1,'bbox':[top.x0,top.y0,top.x1,bottom.y0],'columnBoundaries':actual_edges,'displayMatrix':[[' '.join(w[4] for w in c) for c in hc]]+parsed,'cells':[{'row':0,'column':c,'words':[list(w[:5]) for w in values]} for c,values in enumerate(hc)]+proof,'caption':{'text':cap[4].strip(),'bbox':list(cap[:4]),'words':[list(w[:5]) for w in words if w[5]==cap[5]]}})
 if len(matches)!=1:raise ValueError('full_grid_not_unique:'+str(len(matches)))
 return matches[0]

def prove_pdf_bytes(pdf_bytes,tables):
 need(isinstance(pdf_bytes,bytes) and len(pdf_bytes)<=64*1024*1024 and pdf_bytes.startswith(b'%PDF-'),'pdf_bytes_invalid');need(isinstance(tables,list) and len(tables)<=256,'tables_input_invalid')
 try:doc=fitz.open(stream=pdf_bytes,filetype='pdf')
 except fitz.FileDataError:
  return[{'sourceTableOrdinal':table.get('ordinal'),'sourceTableDomSha256':table.get('sourceDomSha256'),'eligible':False,'reason':'pdf_document_unreadable'}for table in tables]
 results=[]
 for table in tables:
  entry={'sourceTableOrdinal':table.get('ordinal'),'sourceTableDomSha256':table.get('sourceDomSha256')}
  try:
   result=prove_table(doc,table)
   matrix=result['displayMatrix'];need(len(matrix)==len(table['matrix']) and all(len(row)==len(table['matrix'][0]) for row in matrix),'display_shape_changed')
   cell_by_coord={(cell['row'],cell['column']):cell for cell in table['cells']}
   for cell in result['cells']:
    original=cell_by_coord[(cell['row'],cell['column'])];cell.update(sourceDomSha256=original['sourceDomSha256'],sourceHtmlText=original['text'],pdfText=matrix[cell['row']][cell['column']],valueOrigin='sealed_pdf')
   result.update(contract=CONTRACT,valueOrigin='sealed_pdf',pdfSha256=hashlib.sha256(pdf_bytes).hexdigest(),sourceTableSha256=stable(table),sourceTableDomSha256=table['sourceDomSha256'],sourceTableOrdinal=table['ordinal'],backend={'name':'pymupdf','version':fitz.version[0]},normalizationProfile='whitespace-typographic-hyphen-and-explicit-symbols-v1')
   result['differences']=[{'row':r,'column':c,'sourceHtmlText':table['matrix'][r][c],'pdfText':value,'originDifference':True}for r,row in enumerate(matrix)for c,value in enumerate(row)if value!=table['matrix'][r][c]]
   result['evidenceSha256']=stable(result);entry.update(eligible=True,evidence=result)
  except (ValueError,TypeError,KeyError,IndexError)as error:entry.update(eligible=False,reason=str(error))
  results.append(entry)
 doc.close();return results

def main():
 from runtime_guard import require_external_runtime,require_workspace_role
 require_external_runtime('reader_sealed_pdf_table_evidence.py');require_workspace_role('daily')
 need(len(sys.argv)==2 and sys.argv[1].isdigit() and int(sys.argv[1])>=3,'private_descriptor_required');fd=int(sys.argv[1]);st=os.fstat(fd)
 need(stat.S_ISREG(st.st_mode) and st.st_mode&0o077==0 and 2<=st.st_size<=96*1024*1024,'private_bounded_descriptor_required')
 data=json.loads(os.read(fd,st.st_size));need(set(data)=={'pdfBase64','pdfSha256','tables'},'descriptor_fields_invalid');raw=base64.b64decode(data['pdfBase64'],validate=True);need(hashlib.sha256(raw).hexdigest()==data['pdfSha256'],'pdf_sha_changed')
 print(json.dumps({'contract':CONTRACT,'results':prove_pdf_bytes(raw,data['tables'])},ensure_ascii=False,separators=(',',':')))
if __name__=='__main__':main()

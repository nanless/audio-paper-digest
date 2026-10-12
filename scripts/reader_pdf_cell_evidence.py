"""依照封存 PDF 原字形与表格位置逐格核验数值双写，不修改原来源。"""
from pathlib import Path
import json,hashlib,re,sys,copy,os,stat
try:
    import fitz
except ImportError as error:
    raise RuntimeError('PDF逐格确认缺少PyMuPDF，不能接受未重放的确认记录') from error
sys.path.insert(0,str(Path(__file__).resolve().parent))
from conference_extractor import load_pypdf_backend

def sha(b): return hashlib.sha256(b).hexdigest()
def norm(s): return re.sub(r'\s+',' ',s).strip()
def caption(s): return re.sub(r'^Table\s+(\d+)\s*[.:]\s*',r'Table \1: ',norm(s))
def need(condition,message):
    if not condition: raise ValueError(message)
def words_in(words,box):
    return [w for w in words if w[0]>=box[0]-.02 and w[2]<=box[2]+.02 and w[1]>=box[1]-.02 and w[3]<=box[3]+.02]
def lines(words):
    grouped=[]
    for w in sorted(words,key=lambda w:((w[1]+w[3])/2,w[0])):
        cy=(w[1]+w[3])/2
        match=next((g for g in grouped if abs(g[0]-cy)<=.75),None)
        if match is None: grouped.append([cy,[w]])
        else: match[1].append(w)
    return [(cy,sorted(ws,key=lambda w:w[0])) for cy,ws in grouped]
def text(words): return norm(' '.join(w[4] for w in words))
def proof(pdf_bytes,table,audit,doc):
    captions=[c for c in audit['tableCandidates'] if c.get('status')=='caption-detected' and caption(c['caption'])==caption(table['caption'])]
    need(len(captions)==1,'完整图注不能唯一对应')
    cap=captions[0]; page=doc[cap['page']-1]
    next_caption_top=min([c['bbox'][1] for c in audit['tableCandidates'] if c.get('status')=='caption-detected' and c.get('page')==cap['page'] and c['bbox'][1]>cap['bbox'][3]] or [float(page.rect.height)])
    allwords=page.get_text('words',sort=False)
    width=len(table['matrix'][0])
    need(all(len(row)==width for row in table['matrix']),'原DOM行列数不一致')
    for ri,row in enumerate(table['matrix']):
        for ci,value in enumerate(row):
            covers=[c for c in table['cells'] if c['row']<=ri<c['row']+c['rowspan'] and c['column']<=ci<c['column']+c['colspan']]
            need(len(covers)==1 and covers[0]['text']==value,'原DOM完整网格/文字不能逐格重放')
    data_start=min(c['row'] for c in table['cells'] if c['column']>=2 and re.fullmatch(r'[+\-\d.]+',c['text']))
    data_rows=table['matrix'][data_start:]
    candidates=[c for c in audit['tableCandidates'] if c.get('page')==cap['page'] and c.get('columns')==width and c.get('bbox',[0,0])[1]>cap['bbox'][3] and c['bbox'][3]<next_caption_top]
    matches=[]
    for data in candidates:
        ws=words_in(allwords,data['bbox'])
        boxes=data['cellBboxes']; group_count=data['rows']
        need(len(boxes)==width*group_count,'PDF几何单元格缺失')
        edges=[boxes[c*group_count][0] for c in range(width)]+[boxes[(width-1)*group_count][2]]
        label_lines=lines([w for w in ws if w[0]>=edges[1]-.02 and w[2]<=edges[2]+.02])
        if [text(w) for _,w in label_lines]==[norm(r[1]) for r in data_rows]: matches.append((data,edges,label_lines,ws))
    need(len(matches)==1,'全部行标签/完整列数不能唯一对应')
    data,edges,label_lines,ws=matches[0]
    header_candidates=[c for c in audit['tableCandidates'] if c.get('page')==cap['page'] and c.get('rawCells') and c['bbox'][1]>cap['bbox'][3] and c['bbox'][3]<data['bbox'][1] and c['bbox'][3]<next_caption_top]
    need(len(header_candidates)==1,'原表头几何块不能唯一对应')
    header=header_candidates[0]; hwords=words_in(allwords,header['bbox']); header_proofs=[]
    covered_header_words=set()
    header_matches=[]
    for cell in [c for c in table['cells'] if c['row']<data_start]:
        x0,x1=edges[cell['column']],edges[cell['column']+cell['colspan']]
        possible=[]
        local=[w for w in hwords if w[0]>=x0-.02 and w[2]<=x1+.02]
        # 多行列头需要全部原字形；普通列头逐字匹配原行。
        if text([w for _,group in lines(local) for w in group])==norm(cell['text']): possible=[local]
        else:
            for _,group in lines(local):
                for start in range(len(group)):
                    for end in range(start+1,len(group)+1):
                        if text(group[start:end])==norm(cell['text']): possible.append(group[start:end])
        need(len(possible)==1,'缺列头或列头不能唯一对应: '+cell['text'])
        header_matches.append((cell,possible[0]))
        covered_header_words.update(tuple(word) for word in possible[0])
        header_proofs.append({'row':cell['row'],'column':cell['column'],'text':cell['text'],'glyphs':[list(w[:5]) for w in possible[0]]})
    need(covered_header_words==set(tuple(w) for w in hwords),'PDF实际列头字形有未覆盖的单位/箭头/组别')
    anchors=[]
    for row in range(data_start):
        points=[(word[1]+word[3])/2 for cell,matched in header_matches if cell['row']==row and cell['rowspan']==1 for word in matched]
        need(points and max(points)-min(points)<=.75,'单行表头层无法唯一定位')
        anchors.append(sum(points)/len(points))
    need(all(anchors[i]<anchors[i+1] for i in range(len(anchors)-1)),'多层列头上下顺序不一致')
    bands=[header['bbox'][1]]+[(anchors[i]+anchors[i+1])/2 for i in range(len(anchors)-1)]+[header['bbox'][3]]
    for cell,matched in header_matches:
        for word in matched:
            cy=(word[1]+word[3])/2
            need(bands[cell['row']]-.02<=cy<=bands[cell['row']+cell['rowspan']]+.02,'列头字形不在DOM row/rowspan对应层内')

    corrected=[]; confirmations=[]
    for row_index,row in enumerate(data_rows):
        baseline=label_lines[row_index][0]
        # 当前规则只接收每行指标在同一PDF原基线的结构，无基线一致性就拒绝。
        row_words=[w for w in ws if abs((w[1]+w[3])/2-baseline)<=.75]
        output=[]
        for col,value in enumerate(row):
            cells=[c for c in table['cells'] if c['row']<=data_start+row_index<c['row']+c['rowspan'] and c['column']<=col<c['column']+c['colspan']]
            need(len(cells)==1,'原DOM坐标不唯一')
            original=cells[0]
            if col<2:
                # 跨行类别由对应PDF原格完整文本覆盖，不能从其他行猜标签。
                group_candidates=[]
                for group in range(data['rows']):
                    b=data['cellBboxes'][col*data['rows']+group]
                    if b[1]<=baseline<=b[3]: group_candidates.append(b)
                need(len(group_candidates)==1,'行标签几何位置不唯一')
                candidate=words_in(ws,group_candidates[0])
                if col==1: candidate=[w for w in candidate if abs((w[1]+w[3])/2-baseline)<=.75]
                need(text(candidate)==norm(value),'行标签或rowspan与原PDF不一致')
                output.append(value); continue
            candidate=[w for w in row_words if w[0]>=edges[col]-.02 and w[2]<=edges[col+1]+.02]
            need(len(candidate)==1,'PDF数值单元格不是唯一完整字形token')
            visible=candidate[0][4]
            need(re.fullmatch(r'[+\-]?\d+(?:\.\d+)?',visible) is not None,'非普通数字或含单位需其他明确协议')
            if value==visible:
                output.append(value); status='unchanged'
            else:
                need(value==visible+visible,'原cell不是PDF完整原值恰好重复两次')
                output.append(visible); status='pdf-confirmed-double-rendering'
            confirmations.append({'row':data_start+row_index,'column':col,'originalText':value,
                'originalCellDomSha256':original['sourceDomSha256'],'visibleText':visible,'status':status,
                'glyph':list(candidate[0][:5])})
        corrected.append(output)
    return {'contract':'sealed-pdf-cell-confirmation-v1','origin':'program-replay-from-sealed-pdf-not-model-input','pdfSha256':sha(pdf_bytes),'backend':{'name':'pymupdf','version':fitz.VersionBind},'page':cap['page'],
        'originalTableDomSha256':table['sourceDomSha256'],'originalCaption':table['caption'],'pdfCaption':cap['caption'],
        'pdfTableBBox':data['bbox'],'headerProofs':header_proofs,'confirmedCells':confirmations,'displayDataRows':corrected}



def stable(value):
    return sha(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())

def read_stable(filename,expected_sha):
    path=Path(filename)
    need(path.is_absolute(),'封存路径须为绝对路径')
    for parent in path.parents:
        need(not parent.is_symlink(),'封存文件父目录不能是符号链接')
    before=path.lstat()
    need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=512*1024*1024,'封存文件不是独立普通文件')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        opened=os.fstat(fd);need((opened.st_dev,opened.st_ino)==(before.st_dev,before.st_ino),'封存文件身份变化')
        with os.fdopen(os.dup(fd),'rb') as stream: data=stream.read()
        need(sha(data)==expected_sha,'封存文件SHA不匹配')
        after=os.fstat(fd);named=path.lstat()
        attrs=['st_dev','st_ino','st_size','st_mtime_ns','st_ctime_ns','st_mode','st_nlink']
        need(all(getattr(before,k)==getattr(after,k)==getattr(named,k) for k in attrs),'封存文件读取期间变化')
        return data
    finally: os.close(fd)

def supported(table):
    matrix=table.get('matrix') or []
    if not matrix or len(matrix[0])<3 or matrix[0][:2]!=['Dataset SNR Setting','Test set']: return False
    # 仅筛选小数两次双写；输出仍必须由真实PDF字形逐格确认，不能凭该形状切半。
    return any(re.fullmatch(r'([+\-]?\d+\.\d+)\1',c.get('text','')) for c in table.get('cells',[]))

def backend_directories():
    import pymupdf
    return sorted(set([str(Path(pymupdf.__file__).resolve().parent),str(Path(fitz.__file__).resolve().parent)]))

def backend_files():
    paths=[p for directory in backend_directories() for p in Path(directory).rglob('*') if p.is_file()]
    paths += [Path(sys.executable).resolve()]
    return [{'path':str(p),'sha256':sha(p.read_bytes())} for p in sorted(set(paths))]


def derive(request):
    backend_record=backend_files()
    backend_sha=stable([{'name':Path(f['path']).name,'sha256':f['sha256']} for f in backend_record])
    expected=request['provenance']; need(expected.get('contract')=='fresh-source-analysis-v1','缺少正常封存来源证明')
    root=Path(request['sourceDirectory'])
    manifest_bytes=read_stable(root/'source-manifest.json',expected['sourceManifestSha256'])
    manifest=json.loads(manifest_bytes)
    need(manifest.get('contract')=='fresh-arxiv-rewrite-source-v1' and manifest.get('generation')==1
         and manifest.get('arxivId')==request['paperId'],'封存manifest的论文或代际不同')
    files={'source.txt':manifest['text']['responseSha256'],'source.pdf':manifest['pdf']['responseSha256'],
           'source-runtime.json':manifest['runtimeMetadata']['responseSha256'],'source-manifest.json':expected['sourceManifestSha256']}
    contents={name:read_stable(root/name,digest) for name,digest in files.items()}
    need(files['source.txt']==expected['sourceSha256'],'原文证明与封存全文不一致')
    runtime=json.loads(contents['source-runtime.json'])
    actual=runtime['structuredArtifacts']; offered=dict(request['artifacts']); offered.pop('payloadSha256',None)
    raw=dict(actual); raw.pop('payloadSha256',None)
    need(actual['payloadSha256']==expected['structuredArtifactsSha256'] and offered==raw,'原DOM内容与真实封存runtime不一致')
    tables=[t for t in actual.get('tables',[]) if supported(t)]
    if not tables:return []
    pdf_bytes=contents['source.pdf'];need(pdf_bytes.startswith(b'%PDF-'),'封存PDF头非法')
    backend=load_pypdf_backend();audit=backend.extract_visual_audit(pdf_bytes);doc=fitz.open(stream=pdf_bytes,filetype='pdf')
    try:
        result=[]
        for table in tables:
            item=proof(pdf_bytes,table,audit,doc)
            item.update({'sourceManifestSha256':expected['sourceManifestSha256'],
                'sourceRuntimeSha256':files['source-runtime.json'],'sourceTextSha256':files['source.txt'],
                'structuredArtifactsSha256':expected['structuredArtifactsSha256'],
                'ruleSha256':sha(Path(__file__).read_bytes()),'extractorSha256':sha((Path(__file__).parent/'conference_extractor.py').read_bytes()),'originalTablePayloadSha256':stable(table),
                'sourceTableOrdinal':table['ordinal'],'backendImplementationSha256':backend_sha})
            result.append(item)
    finally:doc.close()
    for name,digest in files.items():read_stable(root/name,digest)
    need(backend_files()==backend_record,'PDF提取后端清单或字节在重放期间变化')
    return result

def verify_saved_bindings(paper, runtime_root):
    bindings=paper.get('apiReaderPlan',{}).get('tableBindings',[])
    marked=[b for b in bindings if 'pdfCellConfirmation' in b]
    if not marked: return {}
    provenance=paper.get('freshRewriteProvenance')
    need(isinstance(provenance,dict) and provenance==paper.get('analysisManifest',{}).get('freshRewriteProvenance'),'论文与阶段封存来源证明不同')
    paper_id=re.sub(r'v\d+$','',str(paper.get('arxivId','')).removeprefix('arxiv:'))
    need(re.fullmatch(r'\d{4}\.\d{4,5}',paper_id) and re.fullmatch(r'[a-fA-F0-9-]{36}',provenance.get('runId','')) and provenance.get('sourceGeneration')==1,'封存论文或运行身份非法')
    artifacts=json.loads(paper['apiReaderPlan']['structuredSourcePayload'])
    proofs=derive({'paperId':paper_id,'sourceDirectory':str(Path(runtime_root)/provenance['runId']/'sources'/paper_id/'generation-000001'),'provenance':provenance,'artifacts':artifacts})
    result={}
    for binding in marked:
        matches=[t for t in artifacts['tables'] if t['ordinal']==binding.get('sourceTableOrdinal')]
        matching_proofs=[p for p in proofs if p['sourceTableOrdinal']==binding.get('sourceTableOrdinal')]
        need(len(matches)==len(matching_proofs)==1,'表格或PDF确认记录不唯一')
        table=matches[0];confirmed=matching_proofs[0]
        need(binding['pdfCellConfirmation']==confirmed and binding.get('sourceTableDomSha256')==table['sourceDomSha256'],'保存证明不能由当前真实PDF重放')
        cells=binding.get('cellBindings',[]);matrix=table['matrix']
        need(len(cells)==sum(map(len,matrix)),'PDF显示校正必须覆盖完整原表')
        seen=set();display={(c['row'],c['column']):c['visibleText'] for c in confirmed['confirmedCells']}
        values={}
        for c in cells:
            r,cidx=c.get('sourceRow'),c.get('sourceColumn')
            need(isinstance(r,int) and not isinstance(r,bool) and isinstance(cidx,int) and not isinstance(cidx,bool) and 0<=r<len(matrix) and 0<=cidx<len(matrix[r]),'原表坐标非法')
            need(c.get('renderedRow')==r and c.get('renderedColumn')==cidx and (r,cidx) not in seen,'原表不得删列、重排或重复坐标')
            originals=[x for x in table['cells'] if x['row']<=r<x['row']+x['rowspan'] and x['column']<=cidx<x['column']+x['colspan']]
            need(len(originals)==1 and originals[0]['text']==c.get('sourceText') and originals[0]['sourceDomSha256']==c.get('sourceDomSha256'),'原DOM文本或身份改变')
            values[(r,cidx)]=display.get((r,cidx),matrix[r][cidx]);seen.add((r,cidx))
        result[binding['tableIndex']]=values
    return result

if __name__=='__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader_pdf_cell_evidence.py')
    try:
        request=json.loads(sys.stdin.read())
        proofs=derive(request)
        print(json.dumps({'proofs':proofs,'backendFiles':backend_files(),'backendDirectories':backend_directories()},ensure_ascii=False,separators=(',',':')))
    except Exception as error:
        raise SystemExit('封存PDF逐格确认拒绝：'+str(error))

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
def proof_snr(pdf_bytes,table,audit,doc):
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



def hindi_caption(value):
    value=re.sub(r'-\s*\n\s*', '-',value)
    for original,visible in [('N_{w}','Nw'),('p_{90}','p90'),('{\\leq}50','≤50')]:
        value=value.replace(original,visible)
    return caption(value)

def proof_hindi(pdf_bytes,table,audit,doc,profile):
    matrix=table['matrix'];width=len(matrix[0]);data_start=2
    need(all(len(row)==width for row in matrix),'原DOM行列数不一致')
    for ri,row in enumerate(matrix):
        for ci,value in enumerate(row):
            cells=[c for c in table['cells'] if c['row']<=ri<c['row']+c['rowspan'] and c['column']<=ci<c['column']+c['colspan']]
            need(len(cells)==1 and cells[0]['text']==value,'原DOM完整网格或文字不能逐格重放')
    caption_matches=[]
    for page_index,page in enumerate(doc):
        for block in page.get_text('blocks'):
            if hindi_caption(block[4])==hindi_caption(table['caption']):
                caption_matches.append((page_index,page,block))
    need(len(caption_matches)==1,'完整图注不能唯一对应原PDF段落')
    page_index,page,cap=caption_matches[0]
    next_top=min([b[1] for b in page.get_text('blocks') if re.match(r'^Table\s+\d+\.',b[4]) and b[1]>cap[3]] or [page.rect.height])
    widths=set((round(c['bbox'][0],3),round(c['bbox'][2],3)) for c in audit['tableCandidates'] if c.get('page')==page_index+1 and c.get('columns')==width and c['bbox'][1]>cap[3] and c['bbox'][3]<next_top)
    need(len(widths)==1,'同图注区间内原表完整列宽不能唯一定位')
    x0,x1=next(iter(widths));rules=[]
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0]=='l' and abs(item[1].y-item[2].y)<.02 and abs(min(item[1].x,item[2].x)-x0)<.02 and abs(max(item[1].x,item[2].x)-x1)<.02 and cap[3]<item[1].y<next_top:
                rules.append(float(item[1].y))
    need(len(set(rules))>=3,'完整表格边界与表头分隔线不充分')
    top,bottom=min(rules),max(rules)
    words=words_in(page.get_text('words',sort=False),[x0,top,x1,bottom])
    grouped=lines(words);data_lines=[]
    for label in [row[0] for row in matrix[data_start:]]:
        matches=[]
        for cy,group in grouped:
            for count in range(1,len(group)+1):
                if text(group[:count])==label and len(group)-count==width-1:
                    matches.append((cy,group[:count],[[word] for word in group[count:]]))
        need(len(matches)==1,'所有数据行标签与完整列数不能唯一对应: '+label)
        data_lines.append(matches[0])
    need(all(data_lines[i][0]<data_lines[i+1][0] for i in range(len(data_lines)-1)),'原PDF数据行顺序与DOM不一致')
    column_words=[[word for _,label,_ in data_lines for word in label]]
    for ci in range(width-1):column_words.append([cell[ci][0] for _,_,cell in data_lines])
    preliminary_headers=[word for word in words if (word[1]+word[3])/2<data_lines[0][0]-.75]
    leaf_values=[HINDI_HEADERS.get(value,value) for value in matrix[1]]
    leaf_lines=[group for _,group in lines(preliminary_headers) if [w[4] for w in group]==leaf_values]
    need(len(leaf_lines)==1,'完整底层列头与列顺序不能唯一定位')
    for ci,word in enumerate(leaf_lines[0]):column_words[ci].append(word)
    for cell in table['cells']:
        if cell['row']!=0 or cell['colspan']!=1 or not cell['text']:continue
        candidates=[w for w in preliminary_headers if w[4]==cell['text']]
        need(len(candidates)==1,'顶层单列标题不能唯一定位')
        column_words[cell['column']].append(candidates[0])
    edges=[x0]
    for ci in range(width-1):
        left=max(w[2] for w in column_words[ci]);right=min(w[0] for w in column_words[ci+1])
        need(left<right,'PDF相邻列实际字形重叠，不能猜测列归属')
        edges.append((left+right)/2)
    edges.append(x1)
    data_words={tuple(word) for _,label,cells in data_lines for word in [*label,*[c[0] for c in cells]]}
    header_words=[word for word in words if (word[1]+word[3])/2<data_lines[0][0]-.75]
    need(set(tuple(w) for w in words)==data_words|set(tuple(w) for w in header_words),'表格区域存在未覆盖数据、标签或其他字形')
    header_matches=[];header_proofs=[];covered=set();confirmations=[]
    for cell in [c for c in table['cells'] if c['row']<data_start]:
        visible=HINDI_HEADERS.get(cell['text'],cell['text']);possible=[]
        if not visible:
            header_matches.append((cell,[]));header_proofs.append({'row':cell['row'],'column':cell['column'],'text':cell['text'],'glyphs':[]});continue
        local=[w for w in header_words if w[0]>=edges[cell['column']]-.02 and w[2]<=edges[cell['column']+cell['colspan']]+.02]
        for _,group in lines(local):
            for start in range(len(group)):
                for end in range(start+1,len(group)+1):
                    if text(group[start:end])==visible:possible.append(group[start:end])
        need(len(possible)==1,'列头单位或数学名称不能唯一对应: '+cell['text'])
        matched=possible[0];header_matches.append((cell,matched));covered.update(tuple(w) for w in matched)
        header_proofs.append({'row':cell['row'],'column':cell['column'],'text':cell['text'],'glyphs':[list(w[:5]) for w in matched]})
        if visible!=cell['text']:
            confirmations.append({'row':cell['row'],'column':cell['column'],'originalText':cell['text'],'originalCellDomSha256':cell['sourceDomSha256'],'visibleText':visible,'status':'pdf-confirmed-mathml-header','glyphs':[list(w[:5]) for w in matched]})
    need(covered==set(tuple(w) for w in header_words),'PDF实际列头字形含未覆盖单位、组别或符号')
    anchors=[]
    for row in range(data_start):
        points=[(w[1]+w[3])/2 for c,matched in header_matches if c['row']==row and c['rowspan']==1 for w in matched]
        need(points and max(points)-min(points)<=.75,'单行表头上下层不能唯一定位')
        anchors.append(sum(points)/len(points))
    need(anchors[0]<anchors[1],'两层表头上下关系与DOM不同')
    bands=[top,(anchors[0]+anchors[1])/2,data_lines[0][0]-.75]
    for c,matched in header_matches:
        need(all(bands[c['row']]-.02<=(w[1]+w[3])/2<=bands[c['row']+c['rowspan']]+.02 for w in matched),'表头字形或合并行层级与DOM不同')
        if not matched:
            need(not any(edges[c['column']]<=((w[0]+w[2])/2)<edges[c['column']+c['colspan']] and bands[c['row']]<=(w[1]+w[3])/2<bands[c['row']+c['rowspan']] for w in header_words),'DOM空表头格在PDF中不是空格')
    corrected=[]
    for ri,(cy,label,cells) in enumerate(data_lines,data_start):
        output=[matrix[ri][0]]
        for ci,matched in enumerate(cells,1):
            word=matched[0];visible=word[4];original=matrix[ri][ci]
            need(edges[ci]-.02<=word[0] and word[2]<=edges[ci+1]+.02,'数值字形越过原列位置')
            status='unchanged'
            if original!=visible:
                need(re.fullmatch(r'[+−-]?\d+\.\d+',visible) is not None and original in [visible+visible,visible+visible.replace('−','-')],'原数值不是同一PDF完整值双分支显示，不能修补错数或符号')
                status='pdf-confirmed-double-rendering'
            else:need(visible=='—' or re.fullmatch(r'[+−-]?\d+(?:\.\d+)?',visible) is not None,'数值格含未知单位或文字')
            source_cell=next(c for c in table['cells'] if c['row']==ri and c['column']==ci)
            confirmations.append({'row':ri,'column':ci,'originalText':original,'originalCellDomSha256':source_cell['sourceDomSha256'],'visibleText':visible,'status':status,'glyph':list(word[:5])})
            output.append(visible)
        corrected.append(output)
    return {'contract':'sealed-pdf-cell-confirmation-v1','origin':'program-replay-from-sealed-pdf-not-model-input','profile':profile,'pdfSha256':sha(pdf_bytes),'backend':{'name':'pymupdf','version':fitz.VersionBind},'page':page_index+1,'originalTableDomSha256':table['sourceDomSha256'],'originalCaption':table['caption'],'pdfCaption':cap[4],'pdfTableBBox':[x0,top,x1,bottom],'headerProofs':header_proofs,'confirmedCells':confirmations,'displayDataRows':corrected}

STEERING_HEADERS={'Intensity (α\\alpha)':'Intensity (α)','Δ\\Delta':'∆'}
def steering_caption(value):
    return caption(value.replace('Steer-\nSpeech','SteerSpeech').replace('(\\alpha)','(α)'))
def steering_label(value):
    match=re.fullmatch(r'([0-9]\.[0-9])→([0-9]\.[0-9])\1\\rightarrow ?\2',value)
    need(match is not None,'强度行标签不是明确同值Unicode和TeX替代表达')
    return match[1]+' →'+match[2]
def proof_steering(pdf_bytes,table,audit,doc,profile):
    matrix=table['matrix'];width=len(matrix[0]);data_start=2
    need(all(len(row)==width for row in matrix),'原DOM行列数不一致')
    for ri,row in enumerate(matrix):
        for ci,value in enumerate(row):
            cells=[c for c in table['cells'] if c['row']<=ri<c['row']+c['rowspan'] and c['column']<=ci<c['column']+c['colspan']]
            need(len(cells)==1 and cells[0]['text']==value,'原DOM完整网格或文字不能逐格重放')
    caption_matches=[]
    for page_index,page in enumerate(doc):
        for block in page.get_text('blocks'):
            if steering_caption(block[4])==steering_caption(table['caption']):
                caption_matches.append((page_index,page,block))
    need(len(caption_matches)==1,'完整图注不能唯一对应原PDF段落')
    page_index,page,cap=caption_matches[0]
    next_top=min([b[1] for b in page.get_text('blocks') if re.match(r'^Table\s+\d+\.',b[4]) and b[1]>cap[3]] or [page.rect.height])
    full_rules=[]
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0]=='l' and abs(item[1].y-item[2].y)<.02 and cap[3]<item[1].y<next_top:
                full_rules.append((float(min(item[1].x,item[2].x)),float(max(item[1].x,item[2].x)),float(item[1].y)))
    need(full_rules,'原表边界缺失')
    widest=max(x1-x0 for x0,x1,_ in full_rules)
    widths={(x0,x1) for x0,x1,_ in full_rules if abs(x1-x0-widest)<.02}
    need(len(widths)==1,'原表完整边界不能唯一定位')
    x0,x1=next(iter(widths));rules=[]
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0]=='l' and abs(item[1].y-item[2].y)<.02 and abs(min(item[1].x,item[2].x)-x0)<.02 and abs(max(item[1].x,item[2].x)-x1)<.02 and cap[3]<item[1].y<next_top:
                rules.append(float(item[1].y))
    need(len(set(rules))>=3,'完整表格边界与表头分隔线不充分')
    top,bottom=min(rules),max(rules)
    raw_words=page.get_text('words',sort=False)
    chars=[c for block in page.get_text('rawdict')['blocks'] for line in block.get('lines',[]) for span in line['spans'] for c in span['chars']]
    expanded=[]
    for word in raw_words:
        if word[4]=='∆Ours':
            inside=[c for c in chars if c['bbox'][0]>=word[0]-.02 and c['bbox'][2]<=word[2]+.02 and c['bbox'][1]>=word[1]-.02 and c['bbox'][3]<=word[3]+.02]
            need(''.join(c['c'] for c in inside)=='∆Ours','列头合并字形不能从原PDF逐字重放')
            for group in [inside[:1],inside[1:]]:
                expanded.append((min(c['bbox'][0] for c in group),min(c['bbox'][1] for c in group),max(c['bbox'][2] for c in group),max(c['bbox'][3] for c in group),''.join(c['c'] for c in group)))
        else:expanded.append(word)
    words=words_in(expanded,[x0,top,x1,bottom])
    grouped=lines(words);data_lines=[]
    for label in [steering_label(row[0]) for row in matrix[data_start:]]:
        matches=[]
        for cy,group in grouped:
            for count in range(1,len(group)+1):
                if norm(text(group[:count])).replace(' ','')==label.replace(' ','') and len(group)-count==width-1:
                    matches.append((cy,group[:count],[[word] for word in group[count:]]))
        need(len(matches)==1,'所有数据行标签与完整列数不能唯一对应: '+label)
        data_lines.append(matches[0])
    need(all(data_lines[i][0]<data_lines[i+1][0] for i in range(len(data_lines)-1)),'原PDF数据行顺序与DOM不一致')
    column_words=[[word for _,label,_ in data_lines for word in label]]
    for ci in range(width-1):column_words.append([cell[ci][0] for _,_,cell in data_lines])
    preliminary_headers=[word for word in words if (word[1]+word[3])/2<data_lines[0][0]-.75]
    leaf_values=[STEERING_HEADERS.get(value,value) for value in matrix[1]]
    leaf_lines=[group for _,group in lines(preliminary_headers) if text(group)== ' '.join(leaf_values)]
    need(len(leaf_lines)==1,'完整底层列头与列顺序不能唯一定位')
    remaining=leaf_lines[0][:]
    for ci,value in enumerate(leaf_values):
        count=next((n for n in range(1,len(remaining)+1) if text(remaining[:n])==value),None)
        need(count is not None,'完整底层列头不能逐列拆分')
        column_words[ci].extend(remaining[:count]);remaining=remaining[count:]
    need(not remaining,'底层列头有多余字形')
    for cell in table['cells']:
        if cell['row']!=0 or cell['colspan']!=1 or not cell['text']:continue
        candidates=[w for w in preliminary_headers if w[4]==cell['text']]
        need(len(candidates)==1,'顶层单列标题不能唯一定位')
        column_words[cell['column']].append(candidates[0])
    edges=[x0]
    for ci in range(width-1):
        left=max(w[2] for w in column_words[ci]);right=min(w[0] for w in column_words[ci+1])
        need(left<right,'PDF相邻列实际字形重叠，不能猜测列归属')
        edges.append((left+right)/2)
    edges.append(x1)
    data_words={tuple(word) for _,label,cells in data_lines for word in [*label,*[c[0] for c in cells]]}
    header_words=[word for word in words if (word[1]+word[3])/2<data_lines[0][0]-.75]
    need(set(tuple(w) for w in words)==data_words|set(tuple(w) for w in header_words),'表格区域存在未覆盖数据、标签或其他字形')
    header_matches=[];header_proofs=[];covered=set();confirmations=[]
    for cell in [c for c in table['cells'] if c['row']<data_start]:
        visible=STEERING_HEADERS.get(cell['text'],cell['text']);possible=[]
        if not visible:
            header_matches.append((cell,[]));header_proofs.append({'row':cell['row'],'column':cell['column'],'text':cell['text'],'glyphs':[]});continue
        local=[w for w in header_words if edges[cell['column']]<=((w[0]+w[2])/2)<=edges[cell['column']+cell['colspan']]]
        for _,group in lines(local):
            for start in range(len(group)):
                for end in range(start+1,len(group)+1):
                    if text(group[start:end])==visible:possible.append(group[start:end])
        need(len(possible)==1,'列头单位或数学名称不能唯一对应: '+cell['text'])
        matched=possible[0];header_matches.append((cell,matched));covered.update(tuple(w) for w in matched)
        header_proofs.append({'row':cell['row'],'column':cell['column'],'text':cell['text'],'glyphs':[list(w[:5]) for w in matched]})
        if visible!=cell['text']:
            confirmations.append({'row':cell['row'],'column':cell['column'],'originalText':cell['text'],'originalCellDomSha256':cell['sourceDomSha256'],'visibleText':visible,'status':'pdf-confirmed-mathml-header','glyphs':[list(w[:5]) for w in matched]})
    need(covered==set(tuple(w) for w in header_words),'PDF实际列头字形含未覆盖单位、组别或符号')
    anchors=[]
    for row in range(data_start):
        points=[(w[1]+w[3])/2 for c,matched in header_matches if c['row']==row and c['rowspan']==1 for w in matched]
        need(points and max(points)-min(points)<=.75,'单行表头上下层不能唯一定位')
        anchors.append(sum(points)/len(points))
    need(anchors[0]<anchors[1],'两层表头上下关系与DOM不同')
    bands=[top,(anchors[0]+anchors[1])/2,data_lines[0][0]-.75]
    for c,matched in header_matches:
        need(all(bands[c['row']]-.02<=(w[1]+w[3])/2<=bands[c['row']+c['rowspan']]+.02 for w in matched),'表头字形或合并行层级与DOM不同')
        if not matched:
            need(not any(edges[c['column']]<=((w[0]+w[2])/2)<edges[c['column']+c['colspan']] and bands[c['row']]<=(w[1]+w[3])/2<bands[c['row']+c['rowspan']] for w in header_words),'DOM空表头格在PDF中不是空格')
    corrected=[]
    for ri,(cy,label,cells) in enumerate(data_lines,data_start):
        output=[steering_label(matrix[ri][0])]; original_label=next(c for c in table['cells'] if c['row']==ri and c['column']==0); confirmations.append({'row':ri,'column':0,'originalText':matrix[ri][0],'originalCellDomSha256':original_label['sourceDomSha256'],'visibleText':output[0],'status':'pdf-confirmed-mathml-header','glyphs':[list(w[:5]) for w in label]})
        for ci,matched in enumerate(cells,1):
            word=matched[0];visible=word[4];original=matrix[ri][ci]
            need(edges[ci]-.02<=word[0] and word[2]<=edges[ci+1]+.02,'数值字形越过原列位置')
            status='unchanged'
            if original!=visible:
                need(re.fullmatch(r'[+−-]?\d+\.\d+',visible) is not None and original in [visible+visible,visible+visible.replace('−','-')],'原数值不是同一PDF完整值双分支显示，不能修补错数或符号')
                status='pdf-confirmed-double-rendering'
            else:need(visible=='—' or re.fullmatch(r'[+−-]?\d+(?:\.\d+)?',visible) is not None,'数值格含未知单位或文字')
            source_cell=next(c for c in table['cells'] if c['row']==ri and c['column']==ci)
            confirmations.append({'row':ri,'column':ci,'originalText':original,'originalCellDomSha256':source_cell['sourceDomSha256'],'visibleText':visible,'status':status,'glyph':list(word[:5])})
            output.append(visible)
        corrected.append(output)
    return {'contract':'sealed-pdf-cell-confirmation-v1','origin':'program-replay-from-sealed-pdf-not-model-input','profile':profile,'pdfSha256':sha(pdf_bytes),'backend':{'name':'pymupdf','version':fitz.VersionBind},'page':page_index+1,'originalTableDomSha256':table['sourceDomSha256'],'originalCaption':table['caption'],'pdfCaption':cap[4],'pdfTableBBox':[x0,top,x1,bottom],'headerProofs':header_proofs,'confirmedCells':confirmations,'displayDataRows':corrected}

def proof(pdf_bytes,table,audit,doc):
    profile=table_profile(table)
    need(profile is not None,'当前来源表不符合准确支持的完整结构')
    return proof_steering(pdf_bytes,table,audit,doc,profile) if profile=='steering-strength-double' else proof_hindi(pdf_bytes,table,audit,doc,profile) if profile.startswith('hindi-') else proof_snr(pdf_bytes,table,audit,doc)


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

HINDI_HEADERS = {
    'NwN_{w}': 'Nw',
    'p90p_{90}': 'p90',
    '≤50{\\leq}50': '≤50',
}

def table_profile(table):
    matrix=table.get('matrix') or []
    if not matrix or len(matrix[0])<3: return None
    if table.get('ordinal')==3 and table.get('caption')=='Table 3: Subjective Evaluation: Effect of steering strength. SteerSpeech better preserves speaker identity at high intensity (\\alpha).' and len(matrix)==7 and all(len(r)==7 for r in matrix): return 'steering-strength-double'
    if matrix[0][:2]==['Dataset SNR Setting','Test set'] and any(re.fullmatch(r'([+\-]?\d+\.\d+)\1',c.get('text','')) for c in table.get('cells',[])):
        return 'snr-decimal-double'
    if table.get('ordinal')==2 and table.get('caption','').startswith('Table 2: Boundary error against manual annotation (ms) over the full 125-utterance test set.') and matrix[:2]==[['','Raw','Raw','Bias','Bias','Calibrated','Calibrated'],['System','mean','med.','onset','offset','mean','med.']] and [r[0] for r in matrix[2:]]==['Inter annotator','wav2vec2.0','M1','M2','M3','M4','M5','M6','NFA']:
        return 'hindi-boundary-offsets'
    if table.get('ordinal')==3 and table.get('caption','').startswith('Table 3: ASR and word-boundary estimation performance on the IndicVoices-R test set.') and matrix[:2]==[['','ASR (%)','ASR (%)','','vs. wav2vec2.0','vs. wav2vec2.0','vs. wav2vec2.0','vs. wav2vec2.0','Manual'],['Conf.','WER','CER','NwN_{w}','Mean','Med.','p90p_{90}','≤50{\\leq}50','Mean']] and [r[0] for r in matrix[2:]]==['M1','M2','M3','M4','M5','M6','CW']:
        return 'hindi-boundary-math-headers'
    return None

def supported(table):
    return table_profile(table) is not None


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

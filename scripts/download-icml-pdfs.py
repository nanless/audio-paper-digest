#!/usr/bin/env python3
"""Download PDFs for filtered ICML papers and extract text"""
import subprocess, sqlite3, shutil, os, re, json, hashlib, sys
from Crypto.Cipher import AES
from curl_cffi.requests import Session

# --- Auth ---
result = subprocess.run(['security', 'find-generic-password', '-w', '-s', 'Chrome Safe Storage'], capture_output=True, text=True)
aes_key = hashlib.pbkdf2_hmac('sha1', result.stdout.strip().encode(), b'saltysalt', 1003, 16)

def decrypt(enc):
    if not enc or len(enc)<=19: return ''
    iv=enc[3:19]; ct=enc[19:]
    try:
        c=AES.new(aes_key, AES.MODE_CBC, iv); d=c.decrypt(ct); p=d[-1]
        if p<=16: d=d[:-p]
        return d.decode('utf-8',errors='replace')
    except: return ''

def tok(val):
    m=re.search(r'(eyJ[A-Za-z0-9._-]+)',val)
    return m.group(1) if m else ''.join(c for c in val if ord(c)<128 and c.isprintable()).strip()

tmp_db='/tmp/chrome_cookies.sqlite'
shutil.copy2(os.path.expanduser('~/Library/Application Support/Google/Chrome/Default/Cookies'), tmp_db)
conn=sqlite3.connect(tmp_db)
cur=conn.cursor()
cur.execute("SELECT name,encrypted_value FROM cookies WHERE host_key LIKE '%openreview%' AND encrypted_value IS NOT NULL")
cookies={}
for name,enc in cur.fetchall():
    v=decrypt(enc)
    if not v: continue
    if name in ('openreview.accessToken','openreview.refreshToken'):
        t=tok(v); 
        if t: cookies[name]=t
    elif name=='GCILB':
        m=re.search(r'([0-9a-f]{16,})',v)
        if m: cookies[name]=m.group(1)
conn.close()
cookie_str='; '.join(f'{n}={v}' for n,v in cookies.items() if v and all(ord(c)<128 for c in v))

if not cookies.get('openreview.accessToken'):
    print('❌ 未找到 OpenReview 登录 Cookie！')
    print('   请先在 Chrome 中登录 https://openreview.net，然后重试。')
    print('   提示：需使用默认 Chrome Profile 登录。')
    sys.exit(1)

print(f'🔑 已获取 OpenReview 认证 (accessToken: {"✓" if "openreview.accessToken" in cookies else "✗"})')

# --- Load filtered papers ---
with open('data/current/icml_2026_filtered.json') as f:
    data = json.load(f)
papers = data['papers']
print(f'{len(papers)} papers to process')

PDF_DIR = 'data/pdfs/icml2026'
os.makedirs(PDF_DIR, exist_ok=True)

session = Session(impersonate="chrome131")
pdf_map = {}
if os.path.exists('data/current/icml_2026_pdf_map.json'):
    with open('data/current/icml_2026_pdf_map.json') as f:
        pdf_map = json.load(f)

import pdfplumber

for i, paper in enumerate(papers):
    pid = paper['id']
    pdf_path = paper.get('pdf', '')
    
    # Build filename
    safe_id = pid.replace('/', '_')
    pdf_file = os.path.join(PDF_DIR, f'{safe_id}.pdf')
    txt_file = os.path.join(PDF_DIR, f'{safe_id}.txt')
    
    # Check if already done
    if os.path.exists(txt_file) and os.path.getsize(txt_file) > 500:
        pdf_map[pid] = {'arxivId': safe_id, 'status': 'done'}
        if (i+1) % 10 == 0:
            print(f'  [{i+1}/{len(papers)}] {pid}: already done')
        continue
    
    if not pdf_path:
        print(f'  [{i+1}/{len(papers)}] {pid}: NO PDF')
        pdf_map[pid] = {'arxivId': safe_id, 'status': 'no_pdf'}
        continue
    
    pdf_url = f'https://openreview.net{pdf_path}'
    
    try:
        # Download PDF
        print(f'  [{i+1}/{len(papers)}] {pid}: downloading...', end=' ')
        resp = session.get(pdf_url, headers={'Cookie': cookie_str}, timeout=30)
        
        if resp.status_code != 200 or len(resp.content) < 1000:
            print(f'FAILED (status={resp.status_code}, size={len(resp.content)})')
            pdf_map[pid] = {'arxivId': safe_id, 'status': 'download_failed'}
            continue
        
        with open(pdf_file, 'wb') as f:
            f.write(resp.content)
        
        # Extract text with tables preserved
        try:
            with pdfplumber.open(pdf_file) as pdf:
                text_parts = []
                for page_num, page in enumerate(pdf.pages, 1):
                    # Extract tables first (to preserve structure)
                    tables = page.extract_tables()
                    
                    # Get page text
                    page_text = page.extract_text(x_tolerance=2, y_tolerance=2) or ''
                    
                    if tables:
                        page_text += '\n\n'
                        for ti, table in enumerate(tables, 1):
                            if not table:
                                continue
                            # Filter out None rows and format as markdown table
                            clean_rows = [[cell or '' for cell in row] for row in table if any(cell for cell in row)]
                            if not clean_rows:
                                continue
                            page_text += f'[Table {ti} on page {page_num}]\n'
                            # Header row
                            page_text += '| ' + ' | '.join(str(c).strip() for c in clean_rows[0]) + ' |\n'
                            page_text += '|' + '|'.join(['---' for _ in clean_rows[0]]) + '|\n'
                            # Data rows
                            for row in clean_rows[1:]:
                                page_text += '| ' + ' | '.join(str(c).strip() for c in row) + ' |\n'
                            page_text += '\n'
                    
                    if page_text.strip():
                        text_parts.append(f'[Page {page_num}]\n{page_text}')
                
                text = '\n\n'.join(text_parts)
        except Exception as e:
            # Fallback: try pypdf
            from pypdf import PdfReader
            reader = PdfReader(pdf_file)
            text_parts = []
            for i, page in enumerate(reader.pages, 1):
                t = page.extract_text()
                if t:
                    text_parts.append(f'[Page {i}]\n{t}')
            text = '\n\n'.join(text_parts)
        
        with open(txt_file, 'w', encoding='utf-8') as f:
            f.write(text)
        
        print(f'OK ({len(text)} chars)')
        pdf_map[pid] = {'arxivId': safe_id, 'status': 'ok', 'chars': len(text)}
        
    except Exception as e:
        print(f'ERROR: {e}')
        pdf_map[pid] = {'arxivId': safe_id, 'status': f'error: {str(e)[:50]}'}
    
    # Save map every 10 papers
    if (i+1) % 10 == 0:
        with open('data/current/icml_2026_pdf_map.json', 'w') as f:
            json.dump(pdf_map, f, indent=2)

# Final save
with open('data/current/icml_2026_pdf_map.json', 'w') as f:
    json.dump(pdf_map, f, indent=2)

done = sum(1 for v in pdf_map.values() if v.get('status') in ('done', 'ok'))
print(f'\nDone: {done}/{len(papers)} papers')
PYEOF
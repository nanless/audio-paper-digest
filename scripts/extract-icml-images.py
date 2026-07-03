#!/usr/bin/env python3
"""Extract valid images from ICML 2026 PDFs — clean, no warnings"""
import json, os, io, hashlib, sys, warnings, logging
from concurrent.futures import ThreadPoolExecutor, as_completed

# Silence ALL pdfplumber/pdfminer/PIL noise
warnings.filterwarnings('ignore')
logging.getLogger('pdfminer').setLevel(logging.ERROR)
logging.getLogger('pdfplumber').setLevel(logging.ERROR)
os.environ['PYTHONWARNINGS'] = 'ignore'

import pdfplumber
from PIL import Image

IMAGE_REPO = os.path.expanduser('~/code/github_repos/audio-paper-digest-images')
FILTERED_FILE = 'data/current/icml_2026_filtered.json'
R2_MAP_FILE = 'data/current/r2-image-mapping.json'
PDF_DIR = 'data/pdfs/icml2026'
BASE_URL = 'https://nanless.github.io/audio-paper-digest-images'
TODAY = '2026-07-04'

out_dir = os.path.join(IMAGE_REPO, 'icml-2026', TODAY)
os.makedirs(out_dir, exist_ok=True)

def extract(pid, pdf_path):
    results = []
    sid = pid.replace('/', '_')
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for pn, page in enumerate(pdf.pages, 1):
                for img in page.images:
                    try:
                        raw = img['stream'].get_data()
                        # Reject anything PIL can't open — not a real image
                        try:
                            im = Image.open(io.BytesIO(raw))
                        except:
                            continue
                        
                        w, h = im.size
                        if w < 80 and h < 80:
                            continue  # too small
                        
                        if im.mode in ('RGBA', 'P', 'L', 'CMYK'):
                            im = im.convert('RGB')
                        if w > 2000 or h > 2000:
                            r = min(2000 / w, 2000 / h)
                            im = im.resize((int(w * r), int(h * r)), Image.LANCZOS)
                        
                        buf = io.BytesIO()
                        im.save(buf, 'JPEG', quality=80, optimize=True)
                        jpg = buf.getvalue()
                        if len(jpg) > 3 * 1024 * 1024:
                            buf = io.BytesIO()
                            im.save(buf, 'JPEG', quality=50, optimize=True)
                            jpg = buf.getvalue()
                        if len(jpg) > 3 * 1024 * 1024:
                            continue  # still too big, skip
                        
                        hh = hashlib.md5(jpg).hexdigest()[:8]
                        results.append((f'{sid}-{pn}-{hh}.jpg', jpg))
                    except:
                        pass
    except:
        pass
    return results

def main():
    papers = json.load(open(FILTERED_FILE))['papers']
    print(f'{len(papers)} papers')
    
    total = done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {}
        for p in papers:
            pid = p['id']
            pdf = os.path.join(PDF_DIR, f'{pid.replace("/","_")}.pdf')
            if os.path.exists(pdf):
                futures[pool.submit(extract, pid, pdf)] = pid
        
        for future in as_completed(futures):
            images = future.result()
            done += 1
            for fname, data in images:
                with open(os.path.join(out_dir, fname), 'wb') as f:
                    f.write(data)
            total += len(images)
            if done % 30 == 0:
                print(f'  {done}/{len(papers)} | {total} images')
    
    # Stats
    sizes = sorted([os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir)], reverse=True)
    print(f'\nTotal: {total} images, {sum(sizes)//1024//1024}MB')
    print(f'Largest: {[f"{s//1024//1024}MB" for s in sizes[:3]] if sizes else "N/A"}')
    
    # R2 mapping
    r2 = json.load(open(R2_MAP_FILE))
    r2 = {k: v for k, v in r2.items() if 'icml-2026' not in k}
    for fname in sorted(os.listdir(out_dir)):
        r2[f'icml-2026/{TODAY}/{fname}'] = f'{BASE_URL}/icml-2026/{TODAY}/{fname}'
    with open(R2_MAP_FILE, 'w') as f:
        json.dump(r2, f, indent=2, ensure_ascii=False)
    print(f'R2: {len(r2)}')

if __name__ == '__main__':
    main()

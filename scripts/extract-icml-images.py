#!/usr/bin/env python3
"""
ICML 2026 PDF image extraction — dual-engine:
  A. pdfplumber → embedded raster images
  B. PyMuPDF (fitz) → vector graphics rendered as bitmaps
Filtering: min 150px, max 5:1 AR, min 50Kpx² area, max 30 per paper
"""
import json, os, io, hashlib, logging, sys

# Suppress ALL pdfminer/pdfplumber noise before imports
for mod in ['pdfminer', 'pdfplumber', 'pdfminer.pdfinterp', 'pdfminer.pdfpage',
            'pdfminer.pdftypes', 'pdfminer.pdfparser', 'pdfminer.pdfdocument',
            'pdfminer.pdfinterp', 'pdfminer.converter', 'pdfminer.layout',
            'pdfminer.image', 'PIL', 'PIL.Image']:
    logging.getLogger(mod).setLevel(logging.CRITICAL)
    logging.getLogger(mod).propagate = False

class StderrSuppress:
    """Temporarily redirect stderr to suppress pdfplumber internal noise during PDF loading"""
    def __enter__(self):
        self._stderr = sys.stderr
        sys.stderr = open(os.devnull, 'w')
    def __exit__(self, *args):
        sys.stderr.close()
        sys.stderr = self._stderr

import pdfplumber
import fitz  # PyMuPDF
from PIL import Image
from concurrent.futures import ThreadPoolExecutor, as_completed

IMAGE_REPO = os.path.expanduser('~/code/github_repos/audio-paper-digest-images')
FILTERED_FILE = 'data/current/icml_2026_filtered.json'
R2_MAP_FILE = 'data/current/r2-image-mapping.json'
PDF_DIR = 'data/pdfs/icml2026'
BASE_URL = 'https://nanless.github.io/audio-paper-digest-images'
TODAY = '2026-07-04'
MAX_PER_PAPER = 30
MIN_PX = 150       # both dimensions must be >= this
MIN_AREA = 50000   # ~224x224
MAX_AR_RATIO = 5   # max aspect ratio

out_dir = os.path.join(IMAGE_REPO, 'icml-2026', TODAY)
os.makedirs(out_dir, exist_ok=True)

def is_valid(w, h):
    return w >= MIN_PX and h >= MIN_PX and (w * h) >= MIN_AREA and (max(w, h) / max(min(w, h), 1)) <= MAX_AR_RATIO

def save_jpeg(im, max_size=2*1024*1024):
    """Convert to RGB JPEG, enforce size limit, return (data, ok)"""
    if im.mode in ('RGBA', 'P', 'L', 'CMYK'):
        im = im.convert('RGB')
    # Resize if >2000px
    w, h = im.size
    if w > 2000 or h > 2000:
        r = min(2000 / w, 2000 / h)
        im = im.resize((int(w * r), int(h * r)), Image.LANCZOS)
    # JPEG at quality 80
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=80, optimize=True)
    data = buf.getvalue()
    if len(data) > max_size:
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=50, optimize=True)
        data = buf.getvalue()
    if len(data) > max_size:
        return None, False
    return data, True

def extract_raster(pid, pdf_path):
    """Engine A: pdfplumber embedded images"""
    results = []
    sid = pid.replace('/', '_')
    try:
        with StderrSuppress(), pdfplumber.open(pdf_path) as pdf:
            for pn, page in enumerate(pdf.pages, 1):
                for img in page.images:
                    try: raw = img['stream'].get_data(); im = Image.open(io.BytesIO(raw))
                    except: continue
                    if not is_valid(*im.size): continue
                    data, ok = save_jpeg(im)
                    if not ok: continue
                    hh = hashlib.md5(data).hexdigest()[:8]
                    results.append((f'{sid}-p{pn}-r{hh}.jpg', data, im.size[0] * im.size[1]))
    except: pass
    return results

def extract_vector(pid, pdf_path):
    """Engine B: PyMuPDF vector graphics rendered as bitmaps"""
    results = []
    sid = pid.replace('/', '_')
    try:
        doc = fitz.open(pdf_path)
        for pn, page in enumerate(doc, 1):
            # 1. Try to find clustered vector graphics regions
            rects = page.cluster_drawings()
            if not rects:
                continue
            
            # 2. Also check for standard embedded images via pixmap
            img_list = page.get_images(full=True)
            for img_info in img_list:
                try:
                    xref = img_info[0]
                    base = doc.extract_image(xref)
                    raw = base['image']
                    im = Image.open(io.BytesIO(raw))
                except:
                    continue
                if not is_valid(*im.size):
                    continue
                data, ok = save_jpeg(im)
                if not ok:
                    continue
                hh = hashlib.md5(data).hexdigest()[:8]
                results.append((f'{sid}-p{pn}-e{hh}.jpg', data, im.size[0] * im.size[1]))
            
            # 3. Render vector graphic regions as bitmaps (high DPI)
            for rect in rects:
                if rect.width < MIN_PX or rect.height < MIN_PX:
                    continue
                if (rect.width * rect.height) < MIN_AREA:
                    continue
                try:
                    # Render at 200 DPI
                    pix = page.get_pixmap(clip=rect, dpi=200)
                    if pix.width < MIN_PX or pix.height < MIN_PX:
                        continue
                    # Convert to PIL
                    if pix.n == 4:
                        im = Image.frombytes('RGBA', [pix.width, pix.height], pix.samples)
                    elif pix.n == 3:
                        im = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
                    else:
                        im = Image.frombytes('L', [pix.width, pix.height], pix.samples)
                    
                    if not is_valid(*im.size):
                        continue
                    data, ok = save_jpeg(im)
                    if not ok:
                        continue
                    hh = hashlib.md5(data).hexdigest()[:8]
                    results.append((f'{sid}-p{pn}-v{hh}.jpg', data, im.size[0] * im.size[1]))
                except:
                    pass
        doc.close()
    except:
        pass
    return results

def process_paper(paper):
    pid = paper['id']
    pdf_path = os.path.join(PDF_DIR, f'{pid.replace("/", "_")}.pdf')
    if not os.path.exists(pdf_path):
        return pid, []
    
    # Extract from both engines (suppress internal library noise)
    with StderrSuppress():
        raster = extract_raster(pid, pdf_path)
        vector = extract_vector(pid, pdf_path)
    all_images = raster + vector
    
    # Deduplicate by MD5 (keep first occurrence = prefer raster, then vector)
    seen_hashes = set()
    unique = []
    for fname, data, area in sorted(all_images, key=lambda x: -x[2]):  # sort by area desc
        h = hashlib.md5(data).hexdigest()
        if h in seen_hashes:
            continue
        seen_hashes.add(h)
        unique.append((fname, data))
    
    # Cap at MAX_PER_PAPER (already sorted largest first)
    return pid, unique[:MAX_PER_PAPER]

def main():
    with open(FILTERED_FILE) as f:
        papers = json.load(f)['papers']
    print(f'{len(papers)} papers\n')
    
    total = done = with_pics = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(process_paper, p): p for p in papers}
        for future in as_completed(futures):
            pid, images = future.result()
            done += 1
            if images:
                with_pics += 1
                for fname, data in images:
                    with open(os.path.join(out_dir, fname), 'wb') as f:
                        f.write(data)
                total += len(images)
            if done % 30 == 0:
                print(f'  {done}/{len(papers)} | {total} images from {with_pics} papers')
    
    # Stats
    all_sizes = []
    for fname in os.listdir(out_dir):
        all_sizes.append(os.path.getsize(os.path.join(out_dir, fname)))
    all_sizes.sort(reverse=True)
    total_mb = sum(all_sizes) / 1024 / 1024
    
    print(f'\n=== Results ===')
    print(f'Papers with images: {with_pics}/{len(papers)}')
    print(f'Total images: {total}')
    print(f'Total size: {total_mb:.0f}MB')
    print(f'Largest: {[f"{s/1024/1024:.1f}MB" for s in all_sizes[:3]]}')
    print(f'Images >1MB: {sum(1 for s in all_sizes if s > 1024*1024)}')
    
    # R2 mapping
    r2 = json.load(open(R2_MAP_FILE))
    r2 = {k: v for k, v in r2.items() if 'icml-2026' not in k}
    for fname in sorted(os.listdir(out_dir)):
        r2[f'icml-2026/{TODAY}/{fname}'] = f'{BASE_URL}/icml-2026/{TODAY}/{fname}'
    with open(R2_MAP_FILE, 'w') as f:
        json.dump(r2, f, indent=2, ensure_ascii=False)
    print(f'R2: {len(r2)} entries')

if __name__ == '__main__':
    main()

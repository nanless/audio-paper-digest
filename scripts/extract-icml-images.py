#!/usr/bin/env python3
"""Extract images from ICML 2026 PDFs — optimized batch processing"""
import json, os, io, hashlib, subprocess
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import pdfplumber
from PIL import Image

IMAGE_REPO = os.path.expanduser('~/code/github_repos/audio-paper-digest-images')
FILTERED_FILE = 'data/current/icml_2026_filtered.json'
R2_MAP_FILE = 'data/current/r2-image-mapping.json'
PDF_DIR = 'data/pdfs/icml2026'
IMAGE_BASE_URL = 'https://nanless.github.io/audio-paper-digest-images'
CONCURRENCY = 8

today = datetime.now().strftime('%Y-%m-%d')
out_dir = os.path.join(IMAGE_REPO, 'icml-2026', today)
os.makedirs(out_dir, exist_ok=True)

def extract_images_from_pdf(pid, pdf_path):
    """Extract all images from one PDF, return list of (filename, image_data)"""
    results = []
    safe_id = pid.replace('/', '_')
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                for img_info in page.images:
                    try:
                        raw = img_info['stream'].get_data()
                        # Skip tiny images (< 50px in both dimensions — icons/logos)
                        try:
                            img = Image.open(io.BytesIO(raw))
                            if img.width < 50 and img.height < 50:
                                continue
                        except:
                            pass  # Can't open, try to save anyway
                        
                        content_hash = hashlib.md5(raw).hexdigest()[:8]
                        fname = f'{safe_id}-{page_num}-{content_hash}.jpg'
                        results.append((fname, raw))
                    except:
                        pass
    except Exception as e:
        print(f'  [{pid}] Error: {e}')
    return results

def process_paper(paper):
    pid = paper['id']
    safe_id = pid.replace('/', '_')
    pdf_path = os.path.join(PDF_DIR, f'{safe_id}.pdf')
    
    if not os.path.exists(pdf_path):
        return pid, 0
    
    images = extract_images_from_pdf(pid, pdf_path)
    saved = 0
    for fname, data in images:
        fpath = os.path.join(out_dir, fname)
        # Skip if already extracted (from interrupted previous run)
        if os.path.exists(fpath):
            saved += 1
            continue
        with open(fpath, 'wb') as f:
            f.write(data)
        saved += 1
    
    return pid, saved

def main():
    # Load papers
    with open(FILTERED_FILE) as f:
        data = json.load(f)
    papers = data['papers']
    print(f'{len(papers)} papers to process\n')
    
    # Process concurrently
    total = 0
    done = 0
    with_pics = 0
    
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(process_paper, p): p for p in papers}
        for future in as_completed(futures):
            pid, saved = future.result()
            done += 1
            total += saved
            if saved > 0:
                with_pics += 1
            if done % 10 == 0:
                print(f'  Progress: {done}/{len(papers)} | {total} images')
    
    print(f'\n=== Summary ===')
    print(f'Papers with images: {with_pics}/{len(papers)}')
    print(f'Total images: {total}')
    
    # Build R2 mapping
    r2 = json.load(open(R2_MAP_FILE)) if os.path.exists(R2_MAP_FILE) else {}
    added = 0
    for fname in sorted(os.listdir(out_dir)):
        key = f'icml-2026/{today}/{fname}'
        if key not in r2:
            r2[key] = f'{IMAGE_BASE_URL}/icml-2026/{today}/{fname}'
            added += 1
    
    with open(R2_MAP_FILE, 'w') as f:
        json.dump(r2, f, indent=2, ensure_ascii=False)
    print(f'R2 mapping: {len(r2)} entries ({added} new)')
    
    if added:
        print(f'\nNext:')
        print(f'  cd {IMAGE_REPO} && git add icml-2026/ && git commit -m "add: ICML 2026 images {today}" && git push')

if __name__ == '__main__':
    main()

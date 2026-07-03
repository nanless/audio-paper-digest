#!/usr/bin/env python3
"""Extract images from ICML 2026 PDFs and save to image hosting repo"""
import json, os, io, shutil, hashlib, re, subprocess
from datetime import datetime
import pdfplumber
from PIL import Image

IMAGE_REPO = os.path.expanduser('~/code/github_repos/audio-paper-digest-images')
FILTERED_FILE = 'data/current/icml_2026_filtered.json'
R2_MAP_FILE = 'data/current/r2-image-mapping.json'
PDF_DIR = 'data/pdfs/icml2026'
IMAGE_BASE_URL = 'https://nanless.github.io/audio-paper-digest-images'

today = datetime.now().strftime('%Y-%m-%d')

def extract_images_from_pdf(pdf_path, paper_id):
    """Extract all images from a PDF file using pdfplumber"""
    images = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages, 1):
                for img_idx, img_info in enumerate(page.images):
                    try:
                        img_data = img_info['stream'].get_data()
                        # Determine format
                        img = Image.open(io.BytesIO(img_data))
                        # Skip very small images (icons, logos)
                        if img.width < 50 or img.height < 50:
                            continue
                        # Convert RGBA to RGB if needed
                        if img.mode == 'RGBA':
                            # Create white background
                            bg = Image.new('RGB', img.size, (255, 255, 255))
                            bg.paste(img, mask=img.split()[3])
                            img = bg
                        elif img.mode != 'RGB':
                            img = img.convert('RGB')
                        
                        # Generate hash-based filename
                        content_hash = hashlib.md5(img_data).hexdigest()[:8]
                        ext = 'png' if img_info.get('name', '').lower().endswith('.png') else 'jpg'
                        fname = f'{paper_id}-{page_num}-{content_hash}.{ext}'
                        
                        images.append({
                            'filename': fname,
                            'page': page_num,
                            'width': img.width,
                            'height': img.height,
                            'paper_id': paper_id,
                        })
                    except Exception as e:
                        continue
    except Exception as e:
        print(f'  Error extracting images: {e}')
    return images

def main():
    # Load filtered papers
    with open(FILTERED_FILE) as f:
        data = json.load(f)
    papers = data['papers']
    
    # Load existing R2 mapping
    r2_map = {}
    if os.path.exists(R2_MAP_FILE):
        with open(R2_MAP_FILE) as f:
            r2_map = json.load(f)
    
    # Load existing analysis results (to update imageUrls — optional, may not exist yet)
    analysis_file = 'data/current/icml_2026_deep_analysis.json'
    analysis_data = {}
    if os.path.exists(analysis_file):
        with open(analysis_file) as f:
            analysis_data = json.load(f)
    
    # Create output dir
    out_dir = os.path.join(IMAGE_REPO, 'icml-2026', today)
    os.makedirs(out_dir, exist_ok=True)
    
    total_images = 0
    papers_with_images = 0
    new_images = []
    
    for paper in papers:
        pid = paper['id']
        safe_id = pid.replace('/', '_')
        pdf_path = os.path.join(PDF_DIR, f'{safe_id}.pdf')
        
        if not os.path.exists(pdf_path):
            continue
        
        # Extract images
        images = extract_images_from_pdf(pdf_path, pid)
        if not images:
            continue
        
        papers_with_images += 1
        paper_images = []
        
        for img in images:
            # Check if already in mapping
            local_key = f'icml-2026/{today}/{img["filename"]}'
            if local_key in r2_map:
                paper_images.append(r2_map[local_key])
                continue
            
            # Extract and save the image
            try:
                with pdfplumber.open(pdf_path) as pdf:
                    for page in pdf.pages:
                        for pimg in page.images:
                            img_data = pimg['stream'].get_data()
                            content_hash = hashlib.md5(img_data).hexdigest()[:8]
                            if content_hash == img['filename'].split('-')[-1].split('.')[0]:
                                # Save to image repo
                                img_path = os.path.join(out_dir, img['filename'])
                                with open(img_path, 'wb') as f:
                                    f.write(img_data)
                                
                                # Generate URL
                                gh_url = f'{IMAGE_BASE_URL}/icml-2026/{today}/{img["filename"]}'
                                r2_map[local_key] = gh_url
                                paper_images.append(gh_url)
                                new_images.append(img['filename'])
                                total_images += 1
                                break
            except Exception as e:
                print(f'  Error saving {img["filename"]}: {e}')
        
        if paper_images:
            # Update analysis data with image URLs
            for ap in analysis_data.get('papers', []):
                if ap.get('id') == pid:
                    ap['imageUrls'] = paper_images
                    ap['allImageUrls'] = paper_images
                    break
        
        print(f'  [{pid}] {len(paper_images)} images extracted')
    
    # Save R2 mapping
    with open(R2_MAP_FILE, 'w') as f:
        json.dump(r2_map, f, indent=2, ensure_ascii=False)
    print(f'\nR2 mapping updated: {len(r2_map)} total entries')
    
    # Save analysis data with image URLs
    if analysis_data.get('papers'):
        with open(analysis_file, 'w') as f:
            json.dump(analysis_data, f, indent=2, ensure_ascii=False)
        print(f'Analysis data updated with imageUrls')
    
    print(f'\n=== Summary ===')
    print(f'Papers with images: {papers_with_images}/{len(papers)}')
    print(f'Total images extracted: {total_images}')
    print(f'New images: {len(new_images)}')
    print(f'Image repo: {out_dir}')
    
    if new_images:
        print(f'\nNext steps:')
        print(f'  cd {IMAGE_REPO}')
        print(f'  git add icml-2026/')
        print(f'  git commit -m "add: ICML 2026 images {today}"')
        print(f'  git push origin main')

if __name__ == '__main__':
    main()

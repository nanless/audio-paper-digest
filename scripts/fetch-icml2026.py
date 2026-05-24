#!/usr/bin/env python3
"""
Fetch complete ICML 2026 accepted papers list from icml.cc
"""
import json
import re
import sys
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

BASE_URL = "https://icml.cc"
PAPERS_URL = f"{BASE_URL}/virtual/2026/papers.html"
CONCURRENCY = 20
TIMEOUT = 30

session = requests.Session()

def fetch_paper_list():
    """Fetch paper IDs and titles from the papers list page."""
    resp = session.get(PAPERS_URL, timeout=TIMEOUT)
    resp.raise_for_status()
    html = resp.text

    papers = []
    for match in re.finditer(r'<a href="/virtual/2026/poster/(\d+)">([^<]+)</a>', html):
        paper_id = match.group(1)
        title = match.group(2).strip()
        papers.append({"id": paper_id, "title": title})

    return papers

def fetch_paper_detail(paper_id, title):
    """Fetch detailed info for a single paper."""
    url = f"{BASE_URL}/virtual/2026/poster/{paper_id}"
    try:
        resp = session.get(url, timeout=TIMEOUT)
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        print(f"  Error fetching {paper_id}: {e}", file=sys.stderr)
        return {"id": paper_id, "title": title, "error": str(e)}

    # Extract JSON-LD
    authors = []
    date_published = None
    ld_match = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL)
    if ld_match:
        try:
            ld = json.loads(ld_match.group(1))
            if "author" in ld:
                authors = [a.get("name", "") for a in ld["author"]]
            date_published = ld.get("datePublished")
        except json.JSONDecodeError:
            pass

    # Extract abstract
    abstract = None
    abs_match = re.search(r'<div class="abstract-text-inner">\s*<p>(.*?)</p>', html, re.DOTALL)
    if abs_match:
        abstract = re.sub(r'<[^>]+>', '', abs_match.group(1))
        abstract = abstract.strip()

    return {
        "id": paper_id,
        "title": title,
        "authors": authors,
        "date_published": date_published,
        "abstract": abstract,
        "url": url
    }

def main():
    print("Fetching ICML 2026 paper list...")
    papers = fetch_paper_list()
    print(f"Found {len(papers)} papers")

    if not papers:
        print("No papers found!")
        return

    print(f"Fetching details for {len(papers)} papers (concurrency={CONCURRENCY})...")
    results = []
    completed = 0

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        future_to_paper = {
            executor.submit(fetch_paper_detail, p["id"], p["title"]): p
            for p in papers
        }
        for future in as_completed(future_to_paper):
            result = future.result()
            results.append(result)
            completed += 1
            if completed % 100 == 0:
                print(f"  Progress: {completed}/{len(papers)}")

    # Save results
    output = {
        "conference": "ICML 2026",
        "count": len(results),
        "fetched_at": datetime.now().isoformat(),
        "papers": results
    }

    import os
    os.makedirs("data", exist_ok=True)
    output_file = "data/icml2026_papers.json"

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nSaved {len(results)} papers to {output_file}")

    # Stats
    with_abstract = sum(1 for p in results if p.get("abstract"))
    with_authors = sum(1 for p in results if p.get("authors"))
    errors = sum(1 for p in results if p.get("error"))
    print(f"  With abstract: {with_abstract}/{len(results)}")
    print(f"  With authors: {with_authors}/{len(results)}")
    if errors:
        print(f"  Errors: {errors}")

if __name__ == "__main__":
    main()

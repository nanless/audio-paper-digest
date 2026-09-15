#!/usr/bin/env python3
"""Extract and split the official ICMC 2026 combined proceedings PDF.

ICMC publishes one official proceedings volume rather than one PDF per paper.
The PDF outline supplies stable paper numbers and physical start pages.  This
helper derives page ranges and paper metadata from that volume, and can make
page-range PDFs without rasterising their figures, tables, or formulas.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
from pathlib import Path

import fitz
from pypdf import PdfReader, PdfWriter

from runtime_guard import require_external_runtime


PAPER_TOC = re.compile(r"^\s*(\d+)\s+Paper\s+(\d+)\s*$", re.IGNORECASE)
ABSTRACT = re.compile(r"^\s*ABSTRACT\s*$", re.IGNORECASE)
EMAIL = re.compile(r"@")
TOC_RECORD = re.compile(r"^(?P<body>.+?)(?:\s*|\.)?(?P<page>\d{1,3})\s+(?P<authors>[A-ZÀ-ÖØ-Ý].+)$")


def clean(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def paper_entries(document: fitz.Document) -> list[tuple[int, int, int]]:
    entries: list[tuple[int, int, int]] = []
    for row in document.get_toc():
        if len(row) < 3 or not isinstance(row[2], int):
            continue
        match = PAPER_TOC.fullmatch(clean(row[1]))
        if not match:
            continue
        order, paper_number = (int(match.group(1)), int(match.group(2)))
        start_page = row[2]
        if start_page < 1 or start_page > document.page_count:
            raise ValueError(f"outline page is outside the document: {start_page}")
        entries.append((order, paper_number, start_page))
    if not entries:
        raise ValueError("official ICMC PDF has no Paper entries in its outline")
    entries.sort(key=lambda item: item[0])
    if [item[0] for item in entries] != list(range(1, len(entries) + 1)):
        raise ValueError("ICMC PDF outline paper order is not contiguous")
    if len({item[1] for item in entries}) != len(entries):
        raise ValueError("ICMC PDF outline contains duplicate paper numbers")
    if any(left[2] >= right[2] for left, right in zip(entries, entries[1:])):
        raise ValueError("ICMC PDF outline page ranges are not increasing")
    return entries


def authors_from_first_page(page: fitz.Page, title: str) -> list[str]:
    blocks = page.get_text("blocks", sort=True)
    abstract_top = None
    for block in blocks:
        if ABSTRACT.fullmatch(clean(block[4])):
            abstract_top = block[1]
            break
    if abstract_top is None:
        raise ValueError("paper first page has no exact ABSTRACT heading")
    candidates: list[str] = []
    for block in blocks:
        if block[1] >= abstract_top:
            break
        lines = [clean(line) for line in str(block[4]).splitlines() if clean(line)]
        if not lines:
            continue
        first = lines[0]
        if first == title or EMAIL.search(first):
            continue
        # The first line of each author block is the author display name.  Do
        # not mistake a standalone affiliation block for an author when a PDF
        # uses separate text boxes for the same author row.
        if re.search(
            r"\b(?:university|institute|college|school|faculty|department|laboratory|lab|centre|center|academy|conservatory|studio|nkua|calarts|orpheus)\b",
            first,
            re.IGNORECASE,
        ):
            continue
        if len(first) <= 160:
            candidates.append(first)
    result: list[str] = []
    for candidate in candidates:
        if candidate not in result:
            result.append(candidate)
    if not result:
        raise ValueError("paper first page has no author display name")
    return result


def toc_records(document: fitz.Document) -> list[tuple[str, list[str]]]:
    """Read the title/author rows from the volume's printed table of contents.

    One first-page entry in the source volume has a damaged font resource, so
    first-page text is used only as a diagnostic.  The TOC is the official
    title/author listing and remains extractable for all 60 papers.
    """
    records: list[tuple[str, list[str]]] = []
    for page_number in range(14, 18):
        page = document[page_number - 1]
        for block in page.get_text("blocks", sort=True):
            raw = clean(block[4])
            if not raw or "Table of Contents" in raw or raw.startswith("ICMC 2026"):
                continue
            match = TOC_RECORD.fullmatch(raw)
            if not match:
                continue
            title = re.sub(r"(?:\s*\.\s*)+$", "", clean(match.group("body")))
            authors = [clean(value) for value in re.split(r"\s*,\s*|\s+and\s+", match.group("authors")) if clean(value)]
            if not title or not authors:
                raise ValueError(f"invalid ICMC table-of-contents row: {raw[:200]}")
            records.append((title, authors))
    return records


def extract_metadata(source: Path, index_url: str, combined_pdf_url: str) -> dict:
    document = fitz.open(source)
    try:
        entries = paper_entries(document)
        toc = toc_records(document)
        if len(toc) != len(entries):
            raise ValueError(f"ICMC table of contents has {len(toc)} papers; outline has {len(entries)}")
        papers = []
        page_ranges = []
        for index, (order, paper_number, start_page) in enumerate(entries):
            end_page = (entries[index + 1][2] - 1
                        if index + 1 < len(entries) else document.page_count)
            title, authors = toc[index]
            paper_id = f"paper-{paper_number}"
            papers.append({
                "id": paper_id,
                "title": title,
                "authors": authors,
                "abstract": "",
                "pdfFile": f"pdfs/{paper_id}.pdf",
                "pdfUrl": combined_pdf_url,
                "recordUrl": index_url,
                "doi": None,
                "track": f"Paper {paper_number}",
            })
            page_ranges.append({
                "id": paper_id,
                "paperNumber": paper_number,
                "outlineOrder": order,
                "startPage": start_page,
                "endPage": end_page,
            })
        papers.sort(key=lambda item: item["id"])
        page_ranges.sort(key=lambda item: item["id"])
        return {
            "metadata": {"conference": {"id": "icmc-2026", "year": 2026}, "papers": papers},
            "pageMap": {
                "contract": "icmc-combined-proceedings-page-map-v1",
                "version": 1,
                "sourcePages": document.page_count,
                "papers": page_ranges,
            },
        }
    finally:
        document.close()


def split_papers(source: Path, page_map_file: Path, output_dir: Path) -> dict:
    page_map = json.loads(page_map_file.read_text(encoding="utf-8"))
    ranges = page_map.get("papers")
    if not isinstance(ranges, list) or not ranges:
        raise ValueError("page map has no paper ranges")
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    document = fitz.open(source)
    try:
        written = []
        for item in ranges:
            paper_id = item["id"]
            start_page = int(item["startPage"])
            end_page = int(item["endPage"])
            target = output_dir / f"{paper_id}.pdf"
            if target.exists():
                continue
            if not (1 <= start_page <= end_page <= document.page_count):
                raise ValueError(f"invalid page range for {paper_id}")
            # MuPDF is needed here because the source page tree advertises two
            # trailing pages that pypdf does not enumerate.  Rewrite that
            # exact slice with pypdf afterward so the derived bytes have a
            # stable document ID and metadata on every replay.
            slice_document = fitz.open()
            try:
                slice_document.insert_pdf(document, from_page=start_page - 1, to_page=end_page - 1)
                slice_bytes = slice_document.tobytes(garbage=4, deflate=True)
            finally:
                slice_document.close()
            slice_reader = PdfReader(io.BytesIO(slice_bytes), strict=False)
            output = PdfWriter()
            for page in slice_reader.pages:
                output.add_page(page)
            output.add_metadata({
                "/Producer": "audio-paper-digest-icmc-split-v1",
                "/Creator": "audio-paper-digest",
            })
            with target.open("xb") as stream:
                output.write(stream)
            os.chmod(target, 0o600)
            written.append(paper_id)
        return {"written": written, "total": len(ranges)}
    finally:
        document.close()


def main(argv: list[str]) -> int:
    require_external_runtime("icmc-proceedings.py")
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    metadata = subparsers.add_parser("metadata")
    metadata.add_argument("source", type=Path)
    metadata.add_argument("--index-url", required=True)
    metadata.add_argument("--pdf-url", required=True)
    split = subparsers.add_parser("split")
    split.add_argument("source", type=Path)
    split.add_argument("page_map", type=Path)
    split.add_argument("output_dir", type=Path)
    args = parser.parse_args(argv)
    if args.command == "metadata":
        print(json.dumps(extract_metadata(args.source, args.index_url, args.pdf_url), ensure_ascii=False, separators=(",", ":")))
    else:
        print(json.dumps(split_papers(args.source, args.page_map, args.output_dir), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, fitz.FileDataError) as exc:
        print(f"[icmc-proceedings] {exc}", file=sys.stderr)
        raise SystemExit(1)

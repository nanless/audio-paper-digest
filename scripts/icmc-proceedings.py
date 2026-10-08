#!/usr/bin/env python3
"""拆分 ICMC 2026 官方会议论文集 PDF。

ICMC 只出一整本论文集，不是每篇论文一个 PDF。论文编号和正文起始页取自 PDF
大纲。这个脚本据此推出页码范围和各篇元数据，也能切出按页范围划分的 PDF，且
不把其中的图、表、公式栅格化。
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
            raise ValueError(f"目录里的起始页超出 PDF 总页数：{start_page}")
        entries.append((order, paper_number, start_page))
    if not entries:
        raise ValueError("官方 ICMC PDF 的目录里没有 Paper 条目")
    entries.sort(key=lambda item: item[0])
    if [item[0] for item in entries] != list(range(1, len(entries) + 1)):
        raise ValueError("ICMC PDF 目录里的论文序号不连续")
    if len({item[1] for item in entries}) != len(entries):
        raise ValueError("ICMC PDF 目录里有重复的论文编号")
    if any(left[2] >= right[2] for left, right in zip(entries, entries[1:])):
        raise ValueError("ICMC PDF 目录里的起始页没有递增")
    return entries


def toc_records(document: fitz.Document) -> list[tuple[str, list[str]]]:
    """从论文集印刷目录里读出题目和作者行。

    源论文集有一条首页记录的字体资源已损坏，所以首页文字只当诊断用。目录才是
    官方的题目和作者清单，60 篇全都读得出来。
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
                raise ValueError(f"ICMC 印刷目录里有读不出题目和作者的行：{raw[:200]}")
            records.append((title, authors))
    return records


def extract_metadata(source: Path, index_url: str, combined_pdf_url: str) -> dict:
    document = fitz.open(source)
    try:
        entries = paper_entries(document)
        toc = toc_records(document)
        if len(toc) != len(entries):
            raise ValueError(f"ICMC 印刷目录读出 {len(toc)} 篇，PDF 书签只有 {len(entries)} 篇，两者对不上")
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
        raise ValueError("页码映射里没有 papers 区间")
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
                raise ValueError(f"{paper_id} 的页码范围不合法：起止页要落在 1 到 PDF 总页数之间，且起始页不大于结束页")
            # 这里必须用 MuPDF：源文件的页面树声称末尾还有两页，而 pypdf
            # 数不出来。随后再用 pypdf 重写这一段，好让派生出的字节在每次
            # 重跑时都有稳定的文档 ID 和元数据。
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

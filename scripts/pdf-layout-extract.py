#!/usr/bin/env python3
"""Shared PyMuPDF extraction for PDF-only source routes.

The command deliberately separates two products:

* ``extract`` returns page text and a visual audit without PNG base64.  The
  audit is durable metadata and can be replayed against the source PDF.
* ``render`` materializes selected pages as temporary PNG files for the one
  model request that needs pixels.  The caller owns and removes that directory.

PDFs do not carry the author's original TeX or an HTML DOM.  Therefore this
utility never claims that a formula has been recovered as publishable TeX, and
never promotes an incomplete table candidate to a semantic table.
"""

from __future__ import annotations

import argparse
import copy
import contextlib
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

import fitz

from conference_extractor import PAGE_SEPARATOR, _stable_hash, load_pypdf_backend
from runtime_guard import require_external_runtime


CONTRACT = "pdf-layout-extraction-result-v1"
VERSION = 1
RENDER_DPI = 144
MAX_PDF_BYTES = 512 * 1024 * 1024


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"pdf-layout-extract: {message}")


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_pdf(path: Path) -> bytes:
    if not path.is_absolute():
        fail("PDF path must be absolute")
    try:
        info = path.lstat()
    except OSError as exc:
        fail(f"PDF cannot be inspected: {exc}")
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        fail("PDF must be a regular non-symlink single-link file")
    if info.st_size > MAX_PDF_BYTES:
        fail(f"PDF exceeds {MAX_PDF_BYTES} bytes")
    try:
        data = path.read_bytes()
    except OSError as exc:
        fail(f"PDF cannot be read: {exc}")
    if len(data) != info.st_size or not data.startswith(b"%PDF-"):
        fail("PDF changed while reading or has an invalid header")
    return data


def strip_pixels(audit: dict) -> dict:
    """Remove the extractor's page PNG payload before durable JSON output."""
    result = copy.deepcopy(audit)
    for page in result.get("pages", []):
        page.pop("pngBase64", None)
    body = dict(result)
    body.pop("auditSha256", None)
    result["auditSha256"] = _stable_hash(body)
    return result


def extract(path: Path) -> dict:
    data = read_pdf(path)
    backend = load_pypdf_backend()
    with contextlib.redirect_stdout(sys.stderr):
        pages = backend.extract_pages(data)
        audit = backend.extract_visual_audit(data)
    text = "".join(f"{page}{PAGE_SEPARATOR}" for page in pages)
    visual = strip_pixels(audit)
    return {
        "contract": CONTRACT,
        "version": VERSION,
        "backend": {"name": backend.name, "version": backend.version},
        "pageCount": len(pages),
        "pdfSha256": sha256(data),
        "textSha256": sha256(text.encode("utf-8")),
        "text": text,
        "visualAudit": visual,
    }


def safe_output_directory(path: Path) -> Path:
    if not path.is_absolute():
        fail("output directory must be absolute")
    try:
        info = path.lstat()
    except OSError as exc:
        fail(f"output directory cannot be inspected: {exc}")
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail("output directory must be a real directory")
    return path


def render(path: Path, directory: Path, pages: list[int], dpi: int) -> dict:
    data = read_pdf(path)
    output = safe_output_directory(directory)
    if not pages or any(page < 1 for page in pages):
        fail("render page list must contain positive page numbers")
    with contextlib.redirect_stdout(sys.stderr):
        document = fitz.open(stream=data, filetype="pdf")
        try:
            if document.needs_pass:
                fail("encrypted PDFs are unsupported")
            if any(page > len(document) for page in pages):
                fail("render page is outside the PDF")
            files = []
            for index, page_number in enumerate(pages, start=1):
                pixmap = document[page_number - 1].get_pixmap(dpi=dpi, alpha=False)
                filename = output / f"page-{index}.png"
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                fd = os.open(filename, flags, 0o600)
                try:
                    payload = pixmap.tobytes("png")
                    written = os.write(fd, payload)
                    if written != len(payload):
                        fail("short PNG write")
                    os.fsync(fd)
                finally:
                    os.close(fd)
                files.append({
                    "ordinal": index,
                    "page": page_number,
                    "filename": filename.name,
                    "sha256": sha256(payload),
                    "bytes": len(payload),
                    "mediaType": "image/png",
                })
        finally:
            document.close()
    return {"contract": CONTRACT, "version": VERSION, "renderDpi": dpi, "files": files}


def main() -> None:
    require_external_runtime('pdf-layout-extract.py')
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--pdf", required=True, type=Path)
    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--pdf", required=True, type=Path)
    render_parser.add_argument("--directory", required=True, type=Path)
    render_parser.add_argument("--pages", required=True)
    render_parser.add_argument("--dpi", default=str(RENDER_DPI), type=int)
    args = parser.parse_args()
    if args.command == "extract":
        result = extract(args.pdf)
    else:
        try:
            pages = [int(item) for item in args.pages.split(",") if item]
        except ValueError:
            fail("--pages must be a comma-separated integer list")
        result = render(args.pdf, args.directory, pages, args.dpi)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()

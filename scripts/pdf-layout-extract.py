#!/usr/bin/env python3
"""只有 PDF 的来源路线共用的 PyMuPDF 抽取逻辑。

命令刻意分成两种产物：

* ``extract`` 返回页面文字和一份视觉审计，不带 PNG base64。审计是长期保留的
  元数据，可以拿源 PDF 重新核对。
* ``render`` 把选中的页面写成临时 PNG，专供那一次需要像素的模型请求。这个
  目录由调用方负责创建和删除。

PDF 里没有作者的原始 TeX，也没有 HTML DOM。所以这个工具从不声称公式已经还原
成可发布的 TeX，也不会把不完整的表格候选当成语义表格。
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
        fail("PDF 路径必须是绝对路径")
    try:
        info = path.lstat()
    except OSError as exc:
        fail(f"读不到 PDF 的文件状态：{exc}")
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        fail("PDF 必须是普通文件、不是符号链接、硬链接数为 1")
    if info.st_size > MAX_PDF_BYTES:
        fail(f"PDF 超过体积上限 {MAX_PDF_BYTES} 字节")
    try:
        data = path.read_bytes()
    except OSError as exc:
        fail(f"PDF 读不出来：{exc}")
    if len(data) != info.st_size or not data.startswith(b"%PDF-"):
        fail("读 PDF 的过程中文件被改过，或者文件头不是 %PDF-")
    return data


def strip_pixels(audit: dict) -> dict:
    """写长期 JSON 之前，先去掉抽取器带出来的页面 PNG 数据。"""
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
        fail("输出目录必须是绝对路径")
    try:
        info = path.lstat()
    except OSError as exc:
        fail(f"读不到输出目录的文件状态：{exc}")
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail("输出目录必须是真实目录，不能是符号链接")
    return path


def render(path: Path, directory: Path, pages: list[int], dpi: int) -> dict:
    data = read_pdf(path)
    output = safe_output_directory(directory)
    if not pages or any(page < 1 for page in pages):
        fail("要渲染的页码必须都是正整数")
    with contextlib.redirect_stdout(sys.stderr):
        document = fitz.open(stream=data, filetype="pdf")
        try:
            if document.needs_pass:
                fail("不支持加密的 PDF")
            if any(page > len(document) for page in pages):
                fail("要渲染的页码超出 PDF 总页数")
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
                        fail("写 PNG 时没有写全")
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
            fail("--pages 必须是逗号分隔的整数列表")
        result = render(args.pdf, args.directory, pages, args.dpi)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()

"""pdf-layout-extract.py 的回归测试。

只碰临时目录里的 PDF。覆盖三类路径：正常的抽取与渲染、边界上的哈希复算与
权限位、失败时必须说清哪一项不对。
"""
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import fitz

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from conference_extractor import PAGE_SEPARATOR, _stable_hash  # noqa: E402
# 从仓库根按点分路径单跑（python -m unittest tests.python.<模块>）时，tests/python
# 不在 sys.path 上；补一条引导，让三种运行方式都能导入这个平级 helper。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()

# 文件名带连字符，不能直接 import，只能按路径加载。
_SPEC = importlib.util.spec_from_file_location(
    "pdf_layout_extract_under_test", SCRIPTS / "pdf-layout-extract.py")
layout = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(layout)


def build_pdf(pages, **save_kwargs):
    """pages 是「每页若干行文字」，返回 PDF 字节。"""
    document = fitz.open()
    try:
        for lines in pages:
            page = document.new_page(width=612, height=792)
            for index, line in enumerate(lines):
                page.insert_text((60, 100 + index * 18), line, fontsize=11)
        return document.tobytes(**save_kwargs)
    finally:
        document.close()


def write_pdf(directory, pages, name="source.pdf", **save_kwargs):
    path = Path(directory) / name
    path.write_bytes(build_pdf(pages, **save_kwargs))
    return path


class PdfLayoutExtractTest(unittest.TestCase):
    def assert_failure(self, message, call):
        with self.assertRaises(SystemExit) as caught:
            call()
        text = str(caught.exception)
        self.assertTrue(text.startswith("pdf-layout-extract: "), text)
        self.assertIn(message, text)
        return text

    # ── 正常路径 ────────────────────────────────────────────────

    def test_extract_reports_page_text_and_recomputable_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_pdf(directory, [["Alpha table 1"], ["Beta formula y=x^2"]])
            result = layout.extract(path)

            self.assertEqual(result["contract"], layout.CONTRACT)
            self.assertEqual(result["version"], 1)
            self.assertEqual(result["pageCount"], 2)
            self.assertEqual(result["backend"]["name"], "pymupdf")
            self.assertEqual(result["pdfSha256"],
                             hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(result["textSha256"],
                             hashlib.sha256(result["text"].encode("utf-8")).hexdigest())
            self.assertIn("Alpha table 1", result["text"])
            self.assertIn("Beta formula", result["text"])
            self.assertEqual(result["text"].count(PAGE_SEPARATOR), 2)

            audit = result["visualAudit"]
            self.assertEqual(audit["contract"], "conference-pdf-visual-audit-v1")
            self.assertEqual(len(audit["pages"]), 2)
            for page in audit["pages"]:
                self.assertNotIn("pngBase64", page)
            body = dict(audit)
            body.pop("auditSha256")
            self.assertEqual(audit["auditSha256"], _stable_hash(body))

    def test_cli_extract_prints_only_json_on_stdout(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_pdf(directory, [["Only page"]])
            completed = subprocess.run(
                [sys.executable, str(SCRIPTS / "pdf-layout-extract.py"),
                 "extract", "--pdf", str(path)],
                capture_output=True, text=True, cwd=str(ROOT))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertEqual(payload["contract"], "pdf-layout-extraction-result-v1")
            self.assertEqual(payload["pageCount"], 1)
            self.assertIn("Only page", payload["text"])

    # ── 边界 ────────────────────────────────────────────────────

    def test_strip_pixels_drops_page_png_and_recomputes_audit_sha(self):
        audit = {
            "contract": "conference-pdf-visual-audit-v1",
            "version": 1,
            "backend": {"name": "pymupdf", "version": "test"},
            "renderDpi": 144,
            "pages": [{"page": 1, "width": 8, "height": 8, "bytes": 4,
                       "sha256": "a" * 64, "mediaType": "image/png",
                       "pngBase64": "AAAA"}],
            "embeddedImages": [],
            "tableCandidates": [],
            "formulaCandidates": [],
            "figureCandidates": [],
        }
        stripped = layout.strip_pixels(audit)

        self.assertNotIn("pngBase64", stripped["pages"][0])
        # 只去掉像素，页面尺寸、字节数和 SHA 都原样保留。
        self.assertEqual(stripped["pages"][0]["sha256"], "a" * 64)
        self.assertEqual(stripped["pages"][0]["bytes"], 4)
        body = dict(stripped)
        body.pop("auditSha256")
        self.assertEqual(stripped["auditSha256"], _stable_hash(body))
        # 调用方的对象不能被就地改掉。
        self.assertEqual(audit["pages"][0]["pngBase64"], "AAAA")
        self.assertNotIn("auditSha256", audit)

    def test_render_writes_png_with_hash_bytes_and_0600(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_pdf(directory, [["one"], ["two"]])
            output = Path(directory) / "out"
            output.mkdir()

            result = layout.render(path, output, [2, 1], 144)

            self.assertEqual(result["contract"], layout.CONTRACT)
            self.assertEqual(result["renderDpi"], 144)
            self.assertEqual([item["page"] for item in result["files"]], [2, 1])
            self.assertEqual([item["ordinal"] for item in result["files"]], [1, 2])
            for item in result["files"]:
                target = output / item["filename"]
                blob = target.read_bytes()
                self.assertEqual(item["mediaType"], "image/png")
                self.assertEqual(item["bytes"], len(blob))
                self.assertEqual(item["sha256"], hashlib.sha256(blob).hexdigest())
                self.assertTrue(blob.startswith(b"\x89PNG\r\n\x1a\n"))
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)

            # 目标文件已存在时必须拒绝覆盖，而不是悄悄改写上次的渲染结果。
            with self.assertRaises(FileExistsError):
                layout.render(path, output, [1], 144)

    def test_render_cli_reports_requested_page_count(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_pdf(directory, [["one"], ["two"]])
            output = Path(directory) / "out"
            output.mkdir()
            completed = subprocess.run(
                [sys.executable, str(SCRIPTS / "pdf-layout-extract.py"),
                 "render", "--pdf", str(path), "--directory", str(output),
                 "--pages", "1,2", "--dpi", "144"],
                capture_output=True, text=True, cwd=str(ROOT))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertEqual(len(payload["files"]), 2)
            self.assertEqual(payload["renderDpi"], 144)

    # ── 失败路径 ────────────────────────────────────────────────

    def test_read_pdf_rejects_relative_missing_and_unsafe_files(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assert_failure("必须是绝对路径",
                                lambda: layout.read_pdf(Path("source.pdf")))
            self.assert_failure("读不到 PDF 的文件状态",
                                lambda: layout.read_pdf(Path(directory) / "missing.pdf"))
            self.assert_failure("必须是普通文件、不是符号链接、硬链接数为 1",
                                lambda: layout.read_pdf(Path(directory)))
            real = write_pdf(directory, [["real"]], name="real.pdf")
            link = Path(directory) / "link.pdf"
            link.symlink_to(real)
            self.assert_failure("必须是普通文件、不是符号链接、硬链接数为 1",
                                lambda: layout.read_pdf(link))
            hard = Path(directory) / "hard.pdf"
            os.link(real, hard)
            self.assert_failure("必须是普通文件、不是符号链接、硬链接数为 1",
                                lambda: layout.read_pdf(hard))

    def test_read_pdf_rejects_wrong_header_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            broken = Path(directory) / "broken.pdf"
            broken.write_bytes(b"not a pdf at all")
            self.assert_failure("文件头不是 %PDF-", lambda: layout.read_pdf(broken))

            real = write_pdf(directory, [["real"]], name="real.pdf")
            with mock.patch.object(layout, "MAX_PDF_BYTES", 10):
                self.assert_failure("PDF 超过体积上限", lambda: layout.read_pdf(real))

    def test_read_pdf_rejects_file_changed_between_lstat_and_read(self):
        with tempfile.TemporaryDirectory() as directory:
            real = write_pdf(directory, [["real"]], name="real.pdf")
            with mock.patch.object(Path, "read_bytes", return_value=b"%PDF-"):
                self.assert_failure("读 PDF 的过程中文件被改过",
                                    lambda: layout.read_pdf(real))

    def test_safe_output_directory_requires_real_absolute_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assert_failure("输出目录必须是绝对路径",
                                lambda: layout.safe_output_directory(Path("out")))
            self.assert_failure("读不到输出目录的文件状态",
                                lambda: layout.safe_output_directory(
                                    Path(directory) / "missing"))
            plain = Path(directory) / "file.txt"
            plain.write_text("x", encoding="utf-8")
            self.assert_failure("输出目录必须是真实目录，不能是符号链接",
                                lambda: layout.safe_output_directory(plain))
            real = Path(directory) / "real"
            real.mkdir()
            link = Path(directory) / "link"
            link.symlink_to(real)
            self.assert_failure("输出目录必须是真实目录，不能是符号链接",
                                lambda: layout.safe_output_directory(link))

    def test_render_rejects_bad_pages_and_encrypted_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_pdf(directory, [["one"], ["two"]])
            output = Path(directory) / "out"
            output.mkdir()
            self.assert_failure("要渲染的页码必须都是正整数",
                                lambda: layout.render(path, output, [0], 144))
            self.assert_failure("要渲染的页码超出 PDF 总页数",
                                lambda: layout.render(path, output, [3], 144))

            encrypted = Path(directory) / "locked.pdf"
            encrypted.write_bytes(build_pdf(
                [["locked"]], encryption=fitz.PDF_ENCRYPT_AES_256,
                owner_pw="owner", user_pw="user"))
            self.assert_failure("不支持加密的 PDF",
                                lambda: layout.render(encrypted, output, [1], 144))

    def test_cli_rejects_non_integer_page_list(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write_pdf(directory, [["one"]])
            output = Path(directory) / "out"
            output.mkdir()
            completed = subprocess.run(
                [sys.executable, str(SCRIPTS / "pdf-layout-extract.py"),
                 "render", "--pdf", str(path), "--directory", str(output),
                 "--pages", "1,x"],
                capture_output=True, text=True, cwd=str(ROOT))
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("--pages 必须是逗号分隔的整数列表", completed.stderr)

    def test_main_requires_absolute_pdf_path(self):
        buffer = io.StringIO()
        with mock.patch.object(sys, "argv", ["pdf-layout-extract.py", "extract",
                                             "--pdf", "relative.pdf"]):
            with redirect_stdout(buffer):
                self.assert_failure("必须是绝对路径", layout.main)


if __name__ == "__main__":
    unittest.main()

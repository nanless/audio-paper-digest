"""icmc-proceedings.py 的回归测试。

ICMC 2026 只出一整本论文集，论文编号和正文起始页只能从 PDF 书签里读。页码区间
算错就会把相邻论文的正文切进同一篇，所以这里既核对页码推算，也核对切出来的 PDF
本身。全部用临时目录里的自造 PDF 和假文档，不碰仓库 data/，也不联网。
"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import errno
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
# 从仓库根按点分路径单跑（python -m unittest tests.python.<模块>）时，tests/python
# 不在 sys.path 上；补一条引导，让三种运行方式都能导入这个平级 helper。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()

# 文件名带连字符，不能直接 import，只能按路径加载。
_SPEC = importlib.util.spec_from_file_location(
    "icmc_proceedings_under_test", SCRIPTS / "icmc-proceedings.py")
icmc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(icmc)

TOC_LINES = [
    "Audio Rendering Study 1 A. Author",
    "Deep Learning for Music 12 B. Composer, C. Other",
    "Spatial Audio 3 D. One and E. Two",
    "Perceptual Evaluation 4 F. Judge",
]
TOC_ENTRIES = [
    [1, "1 Paper 1", 1],
    [1, "2 Paper 2", 5],
    [1, "3 Paper 3", 9],
    [1, "4 Paper 4", 13],
]
SOURCE_PAGES = 20


class FakePage:
    """只提供 toc_records 需要的 get_text("blocks")。"""

    def __init__(self, lines):
        self._blocks = [(0, 0, 0, 0, f"{line}\n", 0, 0) for line in lines]

    def get_text(self, kind, sort=False):
        if kind != "blocks":
            raise AssertionError(f"意外的抽取类型: {kind}")
        return list(self._blocks)


class FakeDocument:
    """假 PDF 文档：书签与印刷目录都直接给，免得测试依赖真实版面。"""

    def __init__(self, toc, page_count, toc_lines=None):
        self._toc = toc
        self.page_count = page_count
        # 印刷目录固定读第 14 到 17 页；没有给行的那几页也要存在，只是空着。
        lines = list(toc_lines or [])
        self._pages = {index: FakePage([lines[index - 13]] if index - 13 < len(lines) else [])
                       for index in range(13, 17)}

    def get_toc(self):
        return list(self._toc)

    def __getitem__(self, index):
        return self._pages[index]


def build_pdf(directory, page_count=SOURCE_PAGES, toc=None, toc_lines=None):
    """造一本临时论文集：页数、书签、印刷目录行都由调用方指定。"""
    document = fitz.open()
    try:
        for _ in range(page_count):
            document.new_page()
        for offset, line in enumerate(toc_lines or []):
            document[13 + offset].insert_text((72, 100), line, fontsize=11)
        if toc:
            document.set_toc(toc)
        target = directory / "combined.pdf"
        document.save(target)
    finally:
        document.close()
    return target


class IcmcTestCase(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="icmc-proceedings-")
        self.addCleanup(self._temporary.cleanup)
        self.directory = Path(self._temporary.name)

    def fixture_pdf(self):
        return build_pdf(self.directory, toc=TOC_ENTRIES, toc_lines=TOC_LINES)

    def page_map_file(self, papers, name="page-map.json"):
        target = self.directory / name
        target.write_text(json.dumps({
            "contract": "icmc-combined-proceedings-page-map-v1",
            "version": 1,
            "sourcePages": SOURCE_PAGES,
            "papers": papers,
        }), encoding="utf-8")
        return target


class CleanTests(IcmcTestCase):
    def test_normal_合并空白(self):
        self.assertEqual(icmc.clean("  Audio \n Rendering\tStudy  "), "Audio Rendering Study")

    def test_boundary_空值与非字符串都归零(self):
        for value in (None, "", "   ", "\n\t", 0, False):
            with self.subTest(value=value):
                self.assertEqual(icmc.clean(value), "")


class PaperEntriesTests(IcmcTestCase):
    def test_normal_按书签顺序返回序号编号与起始页(self):
        document = FakeDocument(TOC_ENTRIES, SOURCE_PAGES)
        self.assertEqual(icmc.paper_entries(document), [(1, 1, 1), (2, 2, 5), (3, 3, 9), (4, 4, 13)])

    def test_normal_乱序书签按序号重排(self):
        # 序号与论文编号故意错开：只能按序号排，按编号排会得到另一个顺序。
        document = FakeDocument([
            [1, "1 Paper 2", 1],
            [1, "2 Paper 1", 5],
            [1, "3 Paper 3", 9],
        ], SOURCE_PAGES)
        self.assertEqual(icmc.paper_entries(document), [(1, 2, 1), (2, 1, 5), (3, 3, 9)])

    def test_boundary_起始页等于总页数仍算合法(self):
        document = FakeDocument([[1, "1 Paper 1", SOURCE_PAGES]], SOURCE_PAGES)
        self.assertEqual(icmc.paper_entries(document), [(1, 1, SOURCE_PAGES)])

    def test_boundary_非Paper行与页码非整数一律跳过(self):
        # 三条不合格的行（标题不匹配、页码是字符串、行本身只有两列）混在合法行里，
        # 解析结果只应留下序号连续的 1、2 两条。
        document = FakeDocument([
            [1, "Introduction", 1],
            [1, "1 Paper 1", 2],
            [1, "2 Paper 2", 5],
            [1, "3 Paper 3", "7"],
            [1, "4 Paper 4"],
        ], SOURCE_PAGES)
        self.assertEqual(icmc.paper_entries(document), [(1, 1, 2), (2, 2, 5)])

    def test_failure_没有Paper条目必须报错(self):
        document = FakeDocument([[1, "Introduction", 1]], SOURCE_PAGES)
        with self.assertRaisesRegex(ValueError, "目录里没有 Paper 条目"):
            icmc.paper_entries(document)

    def test_failure_序号不连续与编号重复必须报错(self):
        with self.subTest("序号不连续"):
            document = FakeDocument([[1, "2 Paper 2", 1], [1, "3 Paper 3", 2]], SOURCE_PAGES)
            with self.assertRaisesRegex(ValueError, "论文序号不连续"):
                icmc.paper_entries(document)
        with self.subTest("编号重复"):
            # 序号连续（1、2）但论文编号都是 1，只能由编号去重这一条拦下。
            document = FakeDocument([[1, "1 Paper 1", 1], [1, "2 Paper 1", 2]], SOURCE_PAGES)
            with self.assertRaisesRegex(ValueError, "有重复的论文编号"):
                icmc.paper_entries(document)

    def test_failure_起始页越界与不递增必须报错(self):
        with self.subTest("越界"):
            document = FakeDocument([[1, "1 Paper 1", SOURCE_PAGES + 1]], SOURCE_PAGES)
            with self.assertRaisesRegex(ValueError, "起始页超出 PDF 总页数"):
                icmc.paper_entries(document)
        with self.subTest("第 0 页"):
            document = FakeDocument([[1, "1 Paper 1", 0]], SOURCE_PAGES)
            with self.assertRaisesRegex(ValueError, "起始页超出 PDF 总页数"):
                icmc.paper_entries(document)
        with self.subTest("不递增"):
            document = FakeDocument([[1, "1 Paper 1", 5], [1, "2 Paper 2", 5]], SOURCE_PAGES)
            with self.assertRaisesRegex(ValueError, "起始页没有递增"):
                icmc.paper_entries(document)


class TocRecordsTests(IcmcTestCase):
    def test_normal_读出题目与作者并拆开作者分隔符(self):
        document = FakeDocument(TOC_ENTRIES, SOURCE_PAGES, TOC_LINES)
        self.assertEqual(icmc.toc_records(document), [
            ("Audio Rendering Study", ["A. Author"]),
            ("Deep Learning for Music", ["B. Composer", "C. Other"]),
            ("Spatial Audio", ["D. One", "E. Two"]),
            ("Perceptual Evaluation", ["F. Judge"]),
        ])

    def test_boundary_页眉被跳过且题目末尾的点被去掉(self):
        document = FakeDocument(TOC_ENTRIES, SOURCE_PAGES, [
            "Table of Contents",
            "ICMC 2026 Proceedings",
            "Title With Dots . . 7 B. Author",
        ])
        self.assertEqual(icmc.toc_records(document), [("Title With Dots", ["B. Author"])])

    def test_failure_题目被清成空串时报错并带上原始行(self):
        document = FakeDocument(TOC_ENTRIES, SOURCE_PAGES, [". 5 A. Author"])
        with self.assertRaisesRegex(ValueError, "读不出题目和作者的行：\. 5 A\. Author"):
            icmc.toc_records(document)


class ExtractMetadataTests(IcmcTestCase):
    def test_normal_页码区间到下一篇的前一页最后一篇到卷末(self):
        result = icmc.extract_metadata(self.fixture_pdf(), "https://icmc/index", "https://icmc/combined.pdf")
        self.assertEqual(result["pageMap"]["contract"], "icmc-combined-proceedings-page-map-v1")
        self.assertEqual(result["pageMap"]["sourcePages"], SOURCE_PAGES)
        self.assertEqual(
            [(item["id"], item["startPage"], item["endPage"]) for item in result["pageMap"]["papers"]],
            [("paper-1", 1, 4), ("paper-2", 5, 8), ("paper-3", 9, 12), ("paper-4", 13, SOURCE_PAGES)])
        first = result["metadata"]["papers"][0]
        self.assertEqual(first["title"], "Audio Rendering Study")
        self.assertEqual(first["authors"], ["A. Author"])
        self.assertEqual(first["pdfUrl"], "https://icmc/combined.pdf")
        self.assertEqual(first["recordUrl"], "https://icmc/index")
        self.assertEqual(first["track"], "Paper 1")
        self.assertEqual(first["abstract"], "")

    def test_boundary_只有一篇时区间覆盖到卷末(self):
        target = build_pdf(self.directory, toc=[[1, "1 Paper 1", 3]], toc_lines=["Only Paper 3 A. Author"])
        result = icmc.extract_metadata(target, "https://icmc/index", "https://icmc/combined.pdf")
        self.assertEqual(result["pageMap"]["papers"],
                         [{"id": "paper-1", "paperNumber": 1, "outlineOrder": 1,
                           "startPage": 3, "endPage": SOURCE_PAGES}])

    def test_failure_印刷目录与书签数量对不上必须报错(self):
        target = build_pdf(self.directory, toc=TOC_ENTRIES, toc_lines=TOC_LINES[:3])
        with self.assertRaisesRegex(ValueError, "印刷目录读出 3 篇，PDF 书签只有 4 篇"):
            icmc.extract_metadata(target, "https://icmc/index", "https://icmc/combined.pdf")


class SplitPapersTests(IcmcTestCase):
    RANGES = [
        {"id": "paper-1", "paperNumber": 1, "outlineOrder": 1, "startPage": 1, "endPage": 4},
        {"id": "paper-2", "paperNumber": 2, "outlineOrder": 2, "startPage": 5, "endPage": 8},
    ]

    def test_normal_按区间切出独立PDF并写成0600(self):
        source = self.fixture_pdf()
        output = self.directory / "out"
        result = icmc.split_papers(source, self.page_map_file(self.RANGES), output)
        self.assertEqual(result, {"written": ["paper-1", "paper-2"], "total": 2})
        self.assertEqual(sorted(item.name for item in output.iterdir()),
                         ["paper-1.pdf", "paper-2.pdf"])
        for paper_id, pages in (("paper-1", 4), ("paper-2", 4)):
            target = output / f"{paper_id}.pdf"
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            with fitz.open(target) as sliced:
                self.assertEqual(sliced.page_count, pages)
                self.assertEqual(sliced.metadata.get("producer"), "audio-paper-digest-icmc-split-v1")

    def test_boundary_重跑不改已切出的字节(self):
        source = self.fixture_pdf()
        output = self.directory / "out"
        page_map = self.page_map_file(self.RANGES)
        icmc.split_papers(source, page_map, output)
        before = {item.name: item.read_bytes() for item in output.iterdir()}
        self.assertEqual(icmc.split_papers(source, page_map, output), {"written": [], "total": 2})
        after = {item.name: item.read_bytes() for item in output.iterdir()}
        self.assertEqual(after, before)

    def test_failure_页码范围不合法时报错且不为该篇留下文件(self):
        source = self.fixture_pdf()
        output = self.directory / "out"
        bad = [dict(self.RANGES[0], startPage=8, endPage=4)]
        with self.assertRaisesRegex(ValueError, "paper-1 的页码范围不合法"):
            icmc.split_papers(source, self.page_map_file(bad), output)
        self.assertFalse(output.exists())

    def test_failure_页码映射没有区间时必须报错(self):
        source = self.fixture_pdf()
        for papers in ([], None, "not-a-list"):
            with self.subTest(papers=papers):
                page_map = self.page_map_file(papers, name=f"page-map-{papers!r}.json".replace("/", "_"))
                with self.assertRaisesRegex(ValueError, "页码映射里没有 papers 区间"):
                    icmc.split_papers(source, page_map, self.directory / "out")

    def test_failure_全部身份与页码在创建任何输出之前验证(self):
        source = self.fixture_pdf()
        cases = [dict(self.RANGES[0], id=value) for value in
                 ("../escaped", "/absolute", "paper-1/child", "paper-1\\child", "paper-１", "paper-01", "", 1)]
        cases += [dict(self.RANGES[0], startPage=value) for value in (True, 1.5, "1")]
        for index, invalid in enumerate(cases):
            with self.subTest(invalid=invalid):
                output = self.directory / f"invalid-{index}"
                with self.assertRaises(ValueError):
                    icmc.split_papers(source, self.page_map_file([self.RANGES[1], invalid]), output)
                self.assertFalse(output.exists())
                self.assertFalse((self.directory / "escaped.pdf").exists())
        with self.assertRaisesRegex(ValueError, "重复论文编号"):
            icmc.split_papers(source, self.page_map_file([self.RANGES[0], self.RANGES[0]]), self.directory / "duplicate")

    def test_failure_已有损坏或错误页码PDF不能被当成完成且保持原字节(self):
        source = self.fixture_pdf()
        for name, contents in (("partial", b"%PDF-"), ("other-source-pages", source.read_bytes())):
            with self.subTest(name=name):
                output = self.directory / name
                output.mkdir()
                target = output / "paper-1.pdf"
                target.write_bytes(contents)
                with self.assertRaises(ValueError):
                    icmc.split_papers(source, self.page_map_file([self.RANGES[0]]), output)
                self.assertEqual(target.read_bytes(), contents)

    def test_failure_已有链接和特殊文件不能被当成拆分结果(self):
        source = self.fixture_pdf()
        for kind in ("symlink", "hardlink", "fifo", "directory"):
            with self.subTest(kind=kind):
                output = self.directory / kind
                output.mkdir()
                target = output / "paper-1.pdf"
                if kind == "symlink":
                    target.symlink_to(source)
                elif kind == "hardlink":
                    os.link(source, target)
                elif kind == "fifo":
                    os.mkfifo(target)
                else:
                    target.mkdir()
                with self.assertRaises((OSError, ValueError)):
                    icmc.split_papers(source, self.page_map_file([self.RANGES[0]]), output)
                self.assertTrue(target.exists())

    def test_failure_PDF序列化半途失败不留下正式半文件且可重跑(self):
        source = self.fixture_pdf()
        output = self.directory / "writer-failure"
        page_map = self.page_map_file([self.RANGES[0]])
        original_error = OSError(errno.EIO, "测试 PDF 输出短写")
        def short_write(_writer, stream):
            stream.write(b"%PDF-")
            raise original_error
        with mock.patch.object(icmc.PdfWriter, "write", short_write):
            with self.assertRaises(OSError) as caught:
                icmc.split_papers(source, page_map, output)
        self.assertIs(caught.exception, original_error)
        self.assertFalse((output / "paper-1.pdf").exists())
        self.assertEqual(icmc.split_papers(source, page_map, output)["written"], ["paper-1"])

    def test_failure_临时文件真实短写清理后可正常重跑(self):
        source = self.fixture_pdf()
        output = self.directory / "temporary-write-failure"
        page_map = self.page_map_file([self.RANGES[0]])
        original_write = icmc.os.write
        original_error = OSError(errno.EIO, "测试临时 PDF 短写")
        def short_write(fd, data):
            original_write(fd, data[:4])
            raise original_error
        with mock.patch.object(icmc.os, "write", short_write):
            with self.assertRaises(OSError) as caught:
                icmc.split_papers(source, page_map, output)
        self.assertIs(caught.exception, original_error)
        self.assertEqual(list(output.iterdir()), [])
        self.assertEqual(icmc.split_papers(source, page_map, output)["written"], ["paper-1"])

    def test_failure_竞争者正式文件与替换后的临时文件均保留(self):
        source = self.fixture_pdf()
        page_map = self.page_map_file([self.RANGES[0]])
        winner = b"another writer"
        output = self.directory / "competitor"
        original_link = icmc.os.link
        def create_winner_then_link(src, dst, **kwargs):
            (output / dst).write_bytes(winner)
            return original_link(src, dst, **kwargs)
        with mock.patch.object(icmc.os, "link", create_winner_then_link):
            with self.assertRaises(ValueError):
                icmc.split_papers(source, page_map, output)
        self.assertEqual((output / "paper-1.pdf").read_bytes(), winner)
        self.assertEqual([p.name for p in output.iterdir()], ["paper-1.pdf"])
        output = self.directory / "temporary-competitor"
        original_write = icmc.os.write
        original_error = OSError(errno.EIO, "临时文件换主后写入失败")
        def replace_temporary(fd, data):
            original_write(fd, data[:4])
            temporary = next(output.glob(".icmc-write-*.tmp"))
            temporary.unlink()
            temporary.write_bytes(winner)
            raise original_error
        with mock.patch.object(icmc.os, "write", replace_temporary):
            with self.assertRaises(OSError) as caught:
                icmc.split_papers(source, page_map, output)
        self.assertIs(caught.exception, original_error)
        self.assertIsInstance(caught.exception.__cause__, ValueError)
        self.assertEqual(next(output.glob(".icmc-write-*.tmp")).read_bytes(), winner)
        self.assertFalse((output / "paper-1.pdf").exists())


class CommandLineTests(IcmcTestCase):
    def test_normal_split子命令把结果打成一行JSON(self):
        source = self.fixture_pdf()
        page_map = self.page_map_file(SplitPapersTests.RANGES)
        output = self.directory / "out"
        stream = StringIO()
        with redirect_stdout(stream):
            code = icmc.main(["split", str(source), str(page_map), str(output)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stream.getvalue()),
                         {"written": ["paper-1", "paper-2"], "total": 2})

    def test_boundary_缺少子命令时argparse以退出码2拒绝(self):
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit) as caught:
                icmc.main([])
        self.assertEqual(caught.exception.code, 2)

    def test_failure_坏页码映射的子进程退出码为1且stderr带前缀(self):
        source = self.fixture_pdf()
        page_map = self.page_map_file([{"id": "paper-1", "startPage": 8, "endPage": 4}])
        environment = dict(os.environ)
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "icmc-proceedings.py"), "split",
             str(source), str(page_map), str(self.directory / "out")],
            capture_output=True, text=True, env=environment, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.startswith("[icmc-proceedings] "), result.stderr)
        self.assertIn("paper-1 的页码范围不合法", result.stderr)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()

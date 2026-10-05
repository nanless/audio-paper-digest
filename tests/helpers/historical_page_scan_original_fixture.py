"""只在测试中装载完整原扫描器；不给当前生成器增加旧格式入口。"""
from pathlib import Path
from types import ModuleType
import hashlib


ORIGINAL_SHA256 = "702aa7c869290618d27e2a318343295af1be6c05206d79fbb6ef044b5295bac4"
ORIGINAL_COMMIT = "d13197e8406532327074145137ea8b6a98c1b361"
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tests" / "fixtures" / "historical-page-scan-v4-source.txt"


def load_original_page_scan():
    raw = SOURCE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != ORIGINAL_SHA256:
        raise AssertionError("原扫描器源码归档的完整字节与固定 SHA 不一致。")
    module = ModuleType("original_historical_page_scan")
    module.__file__ = str(ROOT / "scripts" / "historical_page_scan.py")
    # 保留原生产文件位置供相对来源说明使用，不更改 sys.modules 或原生产模块。
    exec(compile(raw, module.__file__, "exec"), module.__dict__)
    return module

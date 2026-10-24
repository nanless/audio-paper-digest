"""From an explicitly supplied public PDF, prepare ignored local UI fixtures."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    args = parser.parse_args()
    base = Path(__file__).resolve().parent
    sample = json.loads((base / "sample.json").read_text())
    source = args.pdf.expanduser().resolve(strict=True)
    if digest(source) != sample["pdf"]["sha256"]:
        raise SystemExit("PDF 内容与 MiCLA v1 样稿身份不符，未写入资产。")
    import fitz
    if fitz.VersionBind != "1.26.5":
        raise SystemExit("裁图配方需要 PyMuPDF 1.26.5，未写入资产。")
    destination = base / "assets"
    destination.mkdir(exist_ok=True)
    # Verify every output before copying any fixture into the live sample directory.
    with tempfile.TemporaryDirectory(prefix="paper-mac-fixtures-") as temporary:
        staged = Path(temporary)
        with fitz.open(source) as document:
            if len(document) != sample["pdf"]["pageCount"]:
                raise SystemExit("PDF 页数不符，未写入资产。")
            for figure in sample["figures"]:
                output = staged / figure["src"]
                document[figure["pdfPage"] - 1].get_pixmap(
                    matrix=fitz.Matrix(3, 3), clip=fitz.Rect(figure["cropPdfPoints"])
                ).save(output)
                if digest(output) != figure["sha256"]:
                    raise SystemExit(f"{figure['id']} 裁图指纹不符，未写入资产。")
        shutil.copyfile(source, staged / sample["pdf"]["src"])
        for path in staged.iterdir():
            target = destination / path.name
            pending = destination / (path.name + ".tmp")
            shutil.copyfile(path, pending)
            pending.replace(target)
    print("已准备原始 PDF 与 3 张真实科学图；所有内容指纹一致。")


if __name__ == "__main__":
    main()

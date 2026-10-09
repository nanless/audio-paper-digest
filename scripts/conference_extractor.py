#!/usr/bin/env python3
"""对暂存的会议 PDF 做本地确定性抽取。

抽取器以原始 PDF 为准，从它派生可重放的逐页文本映射，以及尽量保守的表格、
公式和插图记录。全程不联网，也不用 LLM。只有 PDF 的文字或版面提供了足够证据、
能把结构绑到某一页时才输出；拿不准的结构宁可不写，也不臆造。
"""

from __future__ import annotations

import hashlib
import base64
import contextlib
import importlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from paper_identity import assert_canonical_conference_paper_id
from path_config import CONFERENCE_STAGING_SOURCE_DIR


DEFAULT_STAGING_SOURCE_DIR = CONFERENCE_STAGING_SOURCE_DIR

REQUEST_CONTRACT = "conference-pdf-extraction-request-v2"
ARTIFACT_CONTRACT = "conference-structured-artifacts-v2"
RECEIPT_CONTRACT = "conference-pdf-extraction-receipt-v2"
VERIFICATION_CONTRACT = "conference-pdf-extraction-verification-v2"
BLOCKED_VERIFICATION_CONTRACT = "conference-pdf-extraction-blocked-verification-v1"
CONTRACT_VERSION = 2
EXTRACTOR_NAME = "audio-paper-digest-conference-structured"
EXTRACTOR_VERSION = "2.3.1"
PROFILE = "replayable-pdf-layout-v1"
VISUAL_AUDIT_CONTRACT = "conference-pdf-visual-audit-v1"
VISUAL_AUDIT_VERSION = 1
VISUAL_RENDER_DPI = 72
MAX_VISUAL_AUDIT_BYTES = 48 * 1024 * 1024
OFFSET_UNIT = "utf8-byte"
MINIMUM_TEXT_CHARACTERS = 5000
SHORT_PROCEEDINGS_MINIMUM_TEXT_CHARACTERS = 3000
SUPPORTED_MINIMUM_TEXT_CHARACTERS = frozenset({MINIMUM_TEXT_CHARACTERS, SHORT_PROCEEDINGS_MINIMUM_TEXT_CHARACTERS})
PAGE_SEPARATOR = "\n\f\n"
NORMALIZATION = "unicode-nfc-lf-rstrip-v1"
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_PDF_BYTES = 256 * 1024 * 1024
MAX_DERIVED_BYTES = 64 * 1024 * 1024
MAX_FIGURE_ASSET_BYTES = 2 * 1024 * 1024
MAX_TOTAL_FIGURE_ASSET_BYTES = 24 * 1024 * 1024
MAX_PAGES = 10000
MAX_FORMULA_IMAGES = 32
MAX_FORMULA_IMAGE_BYTES = 512 * 1024
MAX_TOTAL_FORMULA_IMAGE_BYTES = 8 * 1024 * 1024
MAX_FORMULA_CROP_WIDTH = 420
MAX_FORMULA_CROP_HEIGHT = 96
SAFE_JSON_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.json$")
SAFE_PDF_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.pdf$")
SAFE_TEXT_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.txt$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
SOURCE_KINDS = {"official-metadata", "official-pdf", "conference-proceedings", "openreview", "local-confirmed-copy"}
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class ConferenceExtractionError(RuntimeError):
    """抽取被拒绝时的基类异常。"""


class ConferenceExtractionIntegrityError(ConferenceExtractionError):
    """请求、来源或输出位置越过了可信边界。"""


class ConferenceExtractionDependencyError(ConferenceExtractionError):
    """固定版本的 PDF 抽取后端不可用。"""


class ConferencePdfExtractionError(ConferenceExtractionError):
    """PDF 后端无法抽取暂存文档。"""


@dataclass(frozen=True)
class ExtractionBackend:
    name: str
    version: str
    extract_pages: Callable[[bytes], list[str]]
    extract_structures: Callable[[bytes, list[str]], dict[str, list[dict[str, Any]]]] | None = None
    extract_visual_audit: Callable[[bytes], dict[str, Any]] | None = None


@contextlib.contextmanager
def _quiet_pymupdf_output():
    """别让 MuPDF 的原生诊断混进抽取器 stdout 上的 JSON。"""
    try:
        sys.stdout.flush()
    except Exception:
        pass
    saved_stdout = os.dup(1)
    try:
        # PyMuPDF 会绕过 Python 层，把 C 层诊断直接写到 fd 1。
        # redirect_stdout 拦不住这些字节，而 Node 读取抽取结果时要求 stdout 上
        # 只能有一个 JSON 对象。
        os.dup2(2, 1)
        with contextlib.redirect_stdout(io.StringIO()):
            yield
    finally:
        try:
            sys.stdout.flush()
        except Exception:
            pass
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)


def _fail(message: str) -> ConferenceExtractionIntegrityError:
    return ConferenceExtractionIntegrityError(f"Conference PDF extraction rejected: {message}")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _exact_object(value: Any, fields: Iterable[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _fail(f"{label} must be an object")
    expected = sorted(fields)
    if sorted(value.keys()) != expected:
        raise _fail(f"{label} has unknown or missing fields: expected {expected}, actual {sorted(value.keys())}")
    return value


def _plain_text(value: Any, label: str, maximum: int = 500) -> str:
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > maximum or re.search(r"[\x00-\x1f\x7f]", value)):
        raise _fail(f"{label} must be a trimmed text value without controls")
    return value


def _safe_name(value: Any, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise _fail(f"{label} must be a safe direct filename")
    return value


def _expected_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise _fail(f"{label} must be a lowercase SHA-256")
    return value


def _json_pointer(value: Any, label: str) -> str:
    value = _plain_text(value, label)
    if not value.startswith("/") or re.search(r"~(?:[^01]|$)", value):
        raise _fail(f"{label} must be a strict JSON Pointer")
    return value


def _identity_evidence(value: Any) -> dict[str, str]:
    evidence = _exact_object(value, ["conferenceIdPointer", "conferenceYearPointer",
        "identityTypePointer", "identityValuePointer"], "source.metadata.identityEvidence")
    return {field: _json_pointer(evidence[field], f"source.metadata.identityEvidence.{field}") for field in evidence}


def _discovery_binding(value: Any) -> dict[str, Any]:
    binding = _exact_object(value, ["catalogSha256", "metadataSnapshotSha256",
        "metadataIndex", "metadataRecordSha256"], "source.metadata.discoveryBinding")
    metadata_index = binding["metadataIndex"]
    if not isinstance(metadata_index, int) or isinstance(metadata_index, bool) or metadata_index < 0:
        raise _fail("source.metadata.discoveryBinding.metadataIndex must be a nonnegative integer")
    return {
        "catalogSha256": _expected_sha(binding["catalogSha256"],
            "source.metadata.discoveryBinding.catalogSha256"),
        "metadataSnapshotSha256": _expected_sha(binding["metadataSnapshotSha256"],
            "source.metadata.discoveryBinding.metadataSnapshotSha256"),
        "metadataIndex": metadata_index,
        "metadataRecordSha256": _expected_sha(binding["metadataRecordSha256"],
            "source.metadata.discoveryBinding.metadataRecordSha256"),
    }


def _validate_source_acquisition_details(value: Any, label: str) -> dict[str, str]:
    acquisition_details = _exact_object(value, ["kind", "locator", "retrievedAt"], f"{label}.provenance")
    kind = _plain_text(acquisition_details["kind"], f"{label}.provenance.kind")
    if kind not in SOURCE_KINDS:
        raise _fail(f"{label}.provenance.kind is unsupported: actual {kind!r}, supported {sorted(SOURCE_KINDS)}")
    retrieved_at = _plain_text(acquisition_details["retrievedAt"], f"{label}.provenance.retrievedAt")
    if not ISO_TIMESTAMP_RE.fullmatch(retrieved_at):
        raise _fail(f"{label}.provenance.retrievedAt must be a canonical UTC timestamp: actual {retrieved_at!r}")
    try:
        from datetime import datetime
        if datetime.fromisoformat(retrieved_at.replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z") != retrieved_at:
            raise ValueError("timestamp does not round-trip")
    except ValueError as exc:
        raise _fail(f"{label}.provenance.retrievedAt must be a canonical UTC timestamp: actual {retrieved_at!r}") from exc
    return {"kind": kind, "locator": _plain_text(acquisition_details["locator"], f"{label}.provenance.locator", 2000),
        "retrievedAt": retrieved_at}


def _resolve_pointer(document: Any, pointer: str, label: str) -> Any:
    current = document
    for encoded in pointer[1:].split("/"):
        key = encoded.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            if not re.fullmatch(r"(?:0|[1-9]\d*)", key) or int(key) >= len(current):
                raise _fail(f"{label} does not resolve in metadata: {pointer!r}")
            current = current[int(key)]
        elif isinstance(current, dict) and key in current:
            current = current[key]
        else:
            raise _fail(f"{label} does not resolve in metadata: {pointer!r}")
    return current


def _validate_metadata_identity(metadata: dict[str, Any], request: dict[str, Any]) -> None:
    evidence = request["source"]["metadata"]["identityEvidence"]
    conference_id = _resolve_pointer(metadata, evidence["conferenceIdPointer"], "conferenceIdPointer")
    conference_year = _resolve_pointer(metadata, evidence["conferenceYearPointer"], "conferenceYearPointer")
    identity_type = _resolve_pointer(metadata, evidence["identityTypePointer"], "identityTypePointer")
    identity_value = _resolve_pointer(metadata, evidence["identityValuePointer"], "identityValuePointer")
    if (not isinstance(conference_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,79}", conference_id)
            or not isinstance(conference_year, int) or isinstance(conference_year, bool)
            or not 1900 <= conference_year <= 2100):
        raise _fail(f"metadata conference identity is malformed: conferenceId={conference_id!r}, conferenceYear={conference_year!r}")
    if request["sourceIdentity"] != f"{identity_type}:{identity_value}":
        raise _fail(f"metadata identity evidence does not bind paperId/sourceIdentity: evidence {identity_type!r}:{identity_value!r}, actual sourceIdentity {request['sourceIdentity']!r}")
    try:
        assert_canonical_conference_paper_id(request["paperId"],
            {"id": conference_id, "year": conference_year},
            {"type": identity_type, "value": identity_value})
    except ValueError as exc:
        raise _fail(f"metadata identity evidence does not bind canonical paperId: {request['paperId']!r} vs {conference_id!r}/{conference_year} {identity_type}:{identity_value}") from exc


def _strict_json_object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        source = raw.decode("utf-8", errors="strict")

        def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"duplicate key: {key}")
                result[key] = value
            return result

        value = json.loads(source, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise _fail(f"{label} must be strict UTF-8 JSON without duplicate keys") from exc
    if not isinstance(value, dict):
        raise _fail(f"{label} must contain a JSON object")
    return value


def validate_request(value: Any, manifest_name: str) -> dict[str, Any]:
    request = _exact_object(
        value,
        ["contract", "version", "paperId", "sourceIdentity", "source", "outputs", "options"],
        "extraction request",
    )
    if request["contract"] != REQUEST_CONTRACT or request["version"] != CONTRACT_VERSION:
        raise _fail(f"extraction request contract/version is unsupported: expected {REQUEST_CONTRACT!r} v{CONTRACT_VERSION}, actual {request['contract']!r} v{request['version']!r}")
    paper_id = _plain_text(request["paperId"], "paperId")
    source_identity = _plain_text(request["sourceIdentity"], "sourceIdentity")
    source = _exact_object(request["source"], ["metadata", "pdf"], "source")
    metadata = _exact_object(source["metadata"], ["file", "sha256", "identityEvidence",
        "discoveryBinding", "provenance"], "source.metadata")
    pdf = _exact_object(source["pdf"], ["file", "sha256", "provenance"], "source.pdf")
    outputs = _exact_object(request["outputs"], ["textFile", "artifactsFile", "receiptFile"], "outputs")
    options = _exact_object(
        request["options"],
        ["minimumTextCharacters", "normalization", "pageSeparator"],
        "options",
    )
    normalized = {
        "contract": REQUEST_CONTRACT,
        "version": CONTRACT_VERSION,
        "paperId": paper_id,
        "sourceIdentity": source_identity,
        "source": {
            "metadata": {
                "file": _safe_name(metadata["file"], SAFE_JSON_NAME, "source.metadata.file"),
                "sha256": _expected_sha(metadata["sha256"], "source.metadata.sha256"),
                "identityEvidence": _identity_evidence(metadata["identityEvidence"]),
                "discoveryBinding": _discovery_binding(metadata["discoveryBinding"]),
                "provenance": _validate_source_acquisition_details(metadata["provenance"], "source.metadata"),
            },
            "pdf": {
                "file": _safe_name(pdf["file"], SAFE_PDF_NAME, "source.pdf.file"),
                "sha256": _expected_sha(pdf["sha256"], "source.pdf.sha256"),
                "provenance": _validate_source_acquisition_details(pdf["provenance"], "source.pdf"),
            },
        },
        "outputs": {
            "textFile": _safe_name(outputs["textFile"], SAFE_TEXT_NAME, "outputs.textFile"),
            "artifactsFile": _safe_name(outputs["artifactsFile"], SAFE_JSON_NAME, "outputs.artifactsFile"),
            "receiptFile": _safe_name(outputs["receiptFile"], SAFE_JSON_NAME, "outputs.receiptFile"),
        },
        "options": {
            "minimumTextCharacters": options["minimumTextCharacters"],
            "normalization": options["normalization"],
            "pageSeparator": options["pageSeparator"],
        },
    }
    if (normalized["options"]["minimumTextCharacters"] not in SUPPORTED_MINIMUM_TEXT_CHARACTERS
            or normalized["options"]["normalization"] != NORMALIZATION
            or normalized["options"]["pageSeparator"] != PAGE_SEPARATOR):
        raise _fail(f"extraction options must exactly match the supported conference profile: minimumTextCharacters={normalized['options']['minimumTextCharacters']!r} (supported {sorted(SUPPORTED_MINIMUM_TEXT_CHARACTERS)}), normalization={normalized['options']['normalization']!r} (supported {NORMALIZATION!r}), pageSeparator={normalized['options']['pageSeparator']!r} (supported {PAGE_SEPARATOR!r})")
    names = [manifest_name, metadata["file"], pdf["file"], *normalized["outputs"].values()]
    if len(set(names)) != len(names):
        raise _fail(f"manifest, input, and output filenames must all differ: duplicated {sorted({name for name in names if names.count(name) > 1})}")
    return normalized


def _open_root(root: Path) -> int:
    requested = Path(root)
    if not requested.is_absolute():
        raise _fail("staging source root must be absolute")
    try:
        info = requested.lstat()
        resolved = requested.resolve(strict=True)
    except OSError as exc:
        raise _fail("staging source root must already exist") from exc
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or resolved != requested:
        raise _fail("staging source root must be a real, non-symbolic directory")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    return os.open(requested, flags)


def _read_regular_single_link(root_fd: int, name: str, maximum: int, label: str) -> bytes:
    try:
        before = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
    except OSError as exc:
        raise _fail(f"{label} is missing or inaccessible") from exc
    if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
            or before.st_nlink != 1 or before.st_size > maximum):
        raise _fail(f"{label} must be a bounded regular single-link file: mode={oct(before.st_mode)}, nlink={before.st_nlink}, size={before.st_size}, max={maximum}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(name, flags, dir_fd=root_fd)
    except OSError as exc:
        raise _fail(f"{label} could not be opened safely") from exc
    try:
        opened = os.fstat(fd)
        named = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino, opened.st_size)
                != (named.st_dev, named.st_ino, named.st_size)):
            raise _fail(f"{label} changed while it was opened")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                raise _fail(f"{label} changed while it was read")
            chunks.append(chunk)
            remaining -= len(chunk)
        extra = os.read(fd, 1)
        if extra:
            raise _fail(f"{label} grew while it was read")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _normalize_page_text(value: Any) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ConferencePdfExtractionError("PDF backend returned non-text page content")
    # 有些 PDF 本身能读，只是字体编码表里带了 UTF-16 代理码位。合法的代理对
    # 按 Unicode 标量值保留，只替换落单的代理码位；这样保存的抽取结果仍是严格
    # UTF-8，不至于把本可恢复的一页变成 PDF_EXTRACTION_FAILED。
    value = value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    value = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    return "\n".join(line.rstrip() for line in value.split("\n")).strip("\n")


def _visual_text(value: str, maximum: int = 4000) -> str:
    value = _normalize_page_text(value)
    return value[:maximum]


def _json_safe_deep(value: Any) -> Any:
    """递归把每个字符串都收拾成严格 UTF-8，供规范化 JSON 封存使用。

    PyMuPDF 会从损坏的字体编码表里带出落单的 UTF-16 代理码位（公式字形串和
    表格候选单元格里都见过）。`_normalize_page_text` 已经能恢复这类页面文本，
    但审计正文和结构化产物还会嵌入没经过它的原始候选字符串。少了这一遍，
    在计算视觉审计哈希时 `json.dumps(..., ensure_ascii=False)` 会抛
    UnicodeEncodeError，把本可恢复的一页变成整批失败的
    PDF_VISUAL_AUDIT_FAILED。合法代理对解码成标量值，只有落单的代理码位被
    替换，与 `_normalize_page_text` 的策略保持一致。
    """
    if isinstance(value, str):
        if any("\ud800" <= character <= "\udfff" for character in value):
            return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
        return value
    if isinstance(value, list):
        return [_json_safe_deep(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_safe_deep(item) for key, item in value.items()}
    return value


def _bbox(value: Any) -> list[float]:
    normalized = []
    for item in value:
        rounded = round(float(item), 3)
        # JavaScript 的 JSON.stringify 把整数写成 1，Python 的 json.dumps 写成
        # 1.0。这里先归一化，视觉审计哈希在 Python 抽取器和 Node 检查器两边
        # 才能计算出同一个 SHA。
        normalized.append(int(rounded) if rounded.is_integer() else rounded)
    return normalized


def _formula_candidate(text: str) -> bool:
    if not text or len(text) > 240:
        return False
    operators = sum(text.count(symbol) for symbol in "=±≤≥∑∏∫√×·^_")
    greek = bool(re.search(r"[α-ωΑ-ΩλμσθφψΔΓΣΠΩ]", text))
    return operators >= 1 and (operators >= 2 or greek)


def _layout_tex(glyphs: list[dict[str, Any]]) -> str | None:
    """只还原范围有限、同一基线、且上下标各不超过一层的那种式子。

    这是从版面推出来的写法，绝不是作者原始的 TeX。分式、根号、未知字形、
    基线重叠以及上下标归属不清的，都有意留在与像素绑定的候选记录里。
    结果只作来源标注，进不了可发布的 tex。
    """
    if not glyphs or len(glyphs) > 160:
        return None
    if any(not re.fullmatch(r"[A-Za-z0-9=+\-()/.,\[\]]", g["text"])
           or g["direction"] != [1, 0] for g in glyphs):
        return None
    equals = [g for g in glyphs if g["text"] == "="]
    if len(equals) != 1:
        return None
    anchor = equals[0]
    size, baseline = anchor["size"], anchor["origin"][1]
    if size <= 0:
        return None
    bases, scripts = [], []
    for g in glyphs:
        dy = g["origin"][1] - baseline
        if abs(dy) <= size * 0.12 and abs(g["size"] - size) <= size * 0.12:
            bases.append(g)
        elif (size * 0.4 <= g["size"] <= size * 0.85
              and size * 0.2 <= abs(dy) <= size * 0.85
              and re.fullmatch(r"[A-Za-z0-9+\-]", g["text"])):
            scripts.append((g, "sup" if dy < 0 else "sub"))
        else:
            return None
    bases.sort(key=lambda g: g["origin"][0])
    if not bases or bases[0]["text"] == "=" or bases[-1]["text"] in "=+-/":
        return None
    if any(b["origin"][0] < a["bbox"][2] - size * 0.15
           or b["origin"][0] - a["bbox"][2] > size * 1.5
           for a, b in zip(bases, bases[1:])):
        return None
    if re.search(r"[A-Za-z]{3,}", "".join(g["text"] for g in bases)):
        return None
    attached: dict[int, dict[str, list[dict[str, Any]]]] = {}
    for g, role in sorted(scripts, key=lambda item: item[0]["origin"][0]):
        preceding = [i for i, base in enumerate(bases) if base["origin"][0] < g["origin"][0]]
        if not preceding:
            return None
        index = preceding[-1]
        base = bases[index]
        if not re.fullmatch(r"[A-Za-z0-9)\]]", base["text"]):
            return None
        group = attached.setdefault(index, {"sup": [], "sub": []})[role]
        previous = group[-1] if group else base
        gap = g["origin"][0] - previous["bbox"][2]
        if gap < -size * 0.3 or gap > size * 0.6:
            return None
        if group and abs(g["origin"][1] - group[0]["origin"][1]) > size * 0.1:
            return None
        group.append(g)
    result = ""
    for index, base in enumerate(bases):
        result += base["text"]
        for role, marker in (("sub", "_"), ("sup", "^")):
            group = attached.get(index, {}).get(role, [])
            if group:
                result += marker + "{" + "".join(g["text"] for g in group) + "}"
    return result


def _formula_layout_candidates(page: Any) -> list[dict[str, Any]]:
    """把附近的字形都收进来，孤立的上下标行也不例外。"""
    glyphs = []
    for block in page.get_text("rawdict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    if char["c"].isspace():
                        continue
                    glyphs.append({"text": _normalize_page_text(str(char["c"])), "bbox": _bbox(char["bbox"]),
                                   "origin": _bbox(char["origin"]), "size": _bbox([span["size"]])[0],
                                   "font": _normalize_page_text(str(span["font"])),
                                   "direction": _bbox(line.get("dir", (1, 0)))})
    seeds = [i for i, g in enumerate(glyphs) if g["text"] in "=≤≥≠∑∫√"]
    consumed: set[int] = set()
    result = []
    drawings = page.get_drawings()
    prose_boxes = [word[:4] for word in page.get_text("words")
                   if re.fullmatch(r"[A-Za-z]{3,}[.,;:]?", word[4])
                   and word[4] not in {"sin", "cos", "tan", "log", "exp", "max", "min", "lim"}]
    for seed in seeds:
        if seed in consumed:
            continue
        selected = {seed}
        pending = [seed]
        # 取连通的字形邻域，而不是只看含运算符的行。保留竖直相邻的字形，
        # 堆叠分式才不会被误当成一个完整却缩短了的基线式子。
        while pending:
            current = glyphs[pending.pop()]
            a = current["bbox"]
            for i, g in enumerate(glyphs):
                if i in selected:
                    continue
                if abs(g["origin"][1] - glyphs[seed]["origin"][1]) > glyphs[seed]["size"] * 1.8:
                    continue
                b = g["bbox"]
                dx = max(a[0] - b[2], b[0] - a[2], 0)
                dy = abs(current["origin"][1] - g["origin"][1])
                if dx <= max(current["size"], g["size"]) * 0.8 and dy <= max(current["size"], g["size"]) * 1.1:
                    selected.add(i)
                    pending.append(i)
        consumed.update(selected)
        members = sorted((glyphs[i] for i in selected), key=lambda g: (g["origin"][0], g["origin"][1]))
        bbox = [min(g["bbox"][0] for g in members), min(g["bbox"][1] for g in members),
                max(g["bbox"][2] for g in members), max(g["bbox"][3] for g in members)]
        layout = {"contract": "pdf-formula-glyph-layout-v1", "bbox": bbox, "glyphs": members}
        tex = _layout_tex(members)
        # 式子内部的横线或其他绘图可能表示分式、上划线、根号等。那是证据，
        # 不是装饰。
        overlapping_drawings = [d["rect"] for d in drawings
                                if d["rect"].x0 <= bbox[2] and d["rect"].x1 >= bbox[0]
                                and d["rect"].y0 <= bbox[3] and d["rect"].y1 >= bbox[1]]
        if overlapping_drawings:
            tex = None
        crop_bbox = _bbox([
            max(page.rect.x0, min([bbox[0], *[r.x0 for r in overlapping_drawings]]) - 3),
            max(page.rect.y0, min([bbox[1], *[r.y0 for r in overlapping_drawings]]) - 3),
            min(page.rect.x1, max([bbox[2], *[r.x1 for r in overlapping_drawings]]) + 3),
            min(page.rect.y1, max([bbox[3], *[r.y1 for r in overlapping_drawings]]) + 3),
        ])
        contains_prose = any(r[0] < crop_bbox[2] and r[2] > crop_bbox[0]
                             and r[1] < crop_bbox[3] and r[3] > crop_bbox[1] for r in prose_boxes)
        bounded = (len(members) >= 3 and not contains_prose
                   and 0 < crop_bbox[2] - crop_bbox[0] <= MAX_FORMULA_CROP_WIDTH
                   and 0 < crop_bbox[3] - crop_bbox[1] <= MAX_FORMULA_CROP_HEIGHT)
        if not bounded:
            tex = None
        result.append({"layout": layout, "layoutSha256": _stable_hash(layout),
                       "derivedTex": tex, "cropBBox": crop_bbox,
                       "regionStatus": "bounded-formula-region" if bounded else "needs-region-review"})
    return result


def _caption_candidate(text: str) -> tuple[str, int] | None:
    """认出真正的图注行，别把正文里提到图表的句子也算进来。

    PDF 文本层里常有 ``Figure 2 presents`` 这样的正文句子。若把每行都当成
    视觉候选，选页范围会扩大到接近整篇论文。支持的会议版式里，图注都以
    标签加编号开头；这个判断有意保守，因为原页 PNG 才是权威的视觉证据。
    """
    match = re.match(
        r"^\s*(?:(figure|fig\.?|table|tab\.?)\s*(\d+)|([图表])\s*(\d+))"
        r"(?:\s*[.．:：;；)）\-–—]|\s*$)",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    raw_label = (match.group(1) or match.group(3) or "figure").lower()
    raw_number = match.group(2) or match.group(4)
    label = "table" if raw_label in {"table", "tab", "tab.", "表"} else "figure"
    return label, int(raw_number)


def _build_visual_audit(document: Any) -> dict[str, Any]:
    """用 PyMuPDF 文档生成确定的视觉证据。"""
    pages: list[dict[str, Any]] = []
    table_candidates: list[dict[str, Any]] = []
    formula_candidates: list[dict[str, Any]] = []
    figure_candidates: list[dict[str, Any]] = []
    embedded_images: list[dict[str, Any]] = []
    visual_bytes = 0
    for page_number, page in enumerate(document, start=1):
        pixmap = page.get_pixmap(matrix=None, dpi=VISUAL_RENDER_DPI, alpha=False)
        png_bytes = pixmap.tobytes("png")
        visual_bytes += len(png_bytes)
        if visual_bytes > MAX_VISUAL_AUDIT_BYTES:
            raise ConferencePdfExtractionError(
                f"visual audit exceeds the derived artifact limit ({MAX_VISUAL_AUDIT_BYTES} bytes): actual {visual_bytes}"
            )
        render_sha = sha256_bytes(png_bytes)
        pages.append({
            "page": page_number,
            "mediaType": "image/png",
            "dpi": VISUAL_RENDER_DPI,
            "width": int(pixmap.width),
            "height": int(pixmap.height),
            "sha256": render_sha,
            "bytes": len(png_bytes),
            "pngBase64": base64.b64encode(png_bytes).decode("ascii"),
        })

        for candidate in _formula_layout_candidates(page):
            formula_candidates.append({
                "page": page_number, "bbox": candidate["layout"]["bbox"],
                "text": "".join(g["text"] for g in candidate["layout"]["glyphs"]),
                "renderSha256": render_sha,
                "sourceRef": f"pdf://page/{page_number}/formula/{len(formula_candidates) + 1}",
                "status": "visual-only-no-tex", **candidate,
            })

        for image_index, image in enumerate(page.get_images(full=True), start=1):
            xref = int(image[0])
            try:
                extracted = document.extract_image(xref)
                image_bytes = bytes(extracted["image"])
                embedded_images.append({
                    "page": page_number,
                    "ordinal": image_index,
                    "xref": xref,
                    "mediaType": str(extracted.get("ext", "bin")),
                    "width": int(extracted.get("width", 0)),
                    "height": int(extracted.get("height", 0)),
                    "sha256": sha256_bytes(image_bytes),
                    "bytes": len(image_bytes),
                    "renderSha256": render_sha,
                })
            except Exception as exc:
                embedded_images.append({
                    "page": page_number,
                    "ordinal": image_index,
                    "xref": xref,
                    "mediaType": "unavailable",
                    "width": 0,
                    "height": 0,
                    "sha256": "0" * 64,
                    "bytes": 0,
                    "renderSha256": render_sha,
                    "error": type(exc).__name__,
                })

        blocks = page.get_text("dict", sort=True).get("blocks", [])
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                line_text = _normalize_page_text("".join(span.get("text", "") for span in line.get("spans", [])))
                caption = _caption_candidate(line_text)
                if caption:
                    label, number = caption
                    target = table_candidates if label == "table" else figure_candidates
                    if any(item.get("number") == number for item in target):
                        continue
                    target.append({
                        "page": page_number,
                        "number": number,
                        "bbox": _bbox(line.get("bbox", (0, 0, 0, 0))),
                        "caption": _visual_text(line_text, 1000),
                        "renderSha256": render_sha,
                        "sourceRef": f"pdf://page/{page_number}/{label}/{number}",
                        "status": "caption-detected",
                    })

        try:
            finder = page.find_tables()
            for table_index, table in enumerate(finder.tables, start=1):
                matrix = table.extract()
                rectangular = bool(matrix) and all(
                    isinstance(row, list) and row and len(row) == len(matrix[0])
                    and all(isinstance(cell, str) and cell.strip() for cell in row)
                    for row in matrix
                )
                table_candidates.append({
                    "page": page_number,
                    "ordinal": table_index,
                    "bbox": _bbox(table.bbox),
                    "rows": len(matrix),
                    "columns": len(matrix[0]) if matrix else 0,
                    "matrixSha256": _stable_hash(matrix) if rectangular else None,
                    # 原样保留单元格与坐标供复核。仅仅结果是个矩形，
                    # 并不能说明阅读顺序或单位正确。
                    "rawCells": matrix,
                    "cellBboxes": [(_bbox(cell) if cell is not None else None)
                                   for cell in table.cells],
                    "status": "needs-review",
                    "renderSha256": render_sha,
                })
        except Exception as exc:
            table_candidates.append({
                "page": page_number,
                "ordinal": 1,
                "bbox": [0, 0, 0, 0],
                "rows": 0,
                "columns": 0,
                "matrixSha256": None,
                "status": "needs-review",
                "renderSha256": render_sha,
                "error": type(exc).__name__,
            })

    body = {
        "contract": VISUAL_AUDIT_CONTRACT,
        "version": VISUAL_AUDIT_VERSION,
        "backend": {"name": "pymupdf", "version": str(document.__class__.__module__)},
        "renderDpi": VISUAL_RENDER_DPI,
        "pages": pages,
        "embeddedImages": embedded_images,
        "tableCandidates": table_candidates,
        "formulaCandidates": formula_candidates,
        "figureCandidates": figure_candidates,
        "visualBytes": visual_bytes,
        "limitations": [
            "PDF 没有作者原始 TeX；公式仅保存原页视觉证据和抽取文本，不转写为可发布 TeX。",
            "表格候选保留原始单元格和坐标，仅供复核；不得将启发式矩阵作为可发布原表。",
            "Figure/图片通过原页 PNG SHA 和 PDF 内嵌图片 SHA 绑定，未把坐标或曲线语义交给自动推断。",
        ],
    }
    body = _json_safe_deep(body)
    body["auditSha256"] = _stable_hash(body)
    return body


def load_pypdf_backend() -> ExtractionBackend:
    """按需加载固定版本的 PyMuPDF 后端（沿用旧函数名）。"""
    try:
        fitz = importlib.import_module("fitz")
    except ImportError as exc:
        raise ConferenceExtractionDependencyError(
            "PyMuPDF is required for conference PDF extraction; install requirements.txt"
        ) from exc
    version = str(getattr(fitz, "VersionBind", "unknown"))
    pymupdf = fitz

    def extract_pages(pdf_bytes: bytes) -> list[str]:
        try:
            with _quiet_pymupdf_output():
                document = fitz.open(stream=pdf_bytes, filetype="pdf")
                if document.needs_pass:
                    raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
                if len(document) > MAX_PAGES:
                    raise ConferencePdfExtractionError(f"PDF page count exceeds {MAX_PAGES}: actual {len(document)}")
                pages = []
                extracted_bytes = 0
                for page in document:
                    text = _normalize_page_text(page.get_text("text", sort=True))
                    extracted_bytes += len(text.encode("utf-8")) + len(PAGE_SEPARATOR.encode("utf-8"))
                    if extracted_bytes > MAX_DERIVED_BYTES:
                        raise ConferencePdfExtractionError(f"extracted text exceeds the derived artifact limit: {extracted_bytes} > {MAX_DERIVED_BYTES}")
                    pages.append(text)
                document.close()
        except ConferencePdfExtractionError:
            raise
        except Exception as exc:  # PyMuPDF 的解析异常因版本而异。
            raise ConferencePdfExtractionError(
                f"PyMuPDF could not extract the PDF ({type(exc).__name__})"
            ) from exc
        if not pages:
            raise ConferencePdfExtractionError("PDF contains no pages")
        return pages

    def clean_structure_text(value: str, maximum: int = 4000) -> str:
        value = _normalize_page_text(value)
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
        return re.sub(r"\s+", " ", value).strip()[:maximum]

    def fitz_words(page: Any) -> list[dict[str, Any]]:
        return [{"x0": float(word[0]), "y0": float(word[1]), "x1": float(word[2]),
                 "y1": float(word[3]), "text": _normalize_page_text(str(word[4]))}
                for word in page.get_text("words", sort=False)]

    def word_lines(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        grouped: list[list[dict[str, Any]]] = []
        for word in sorted(words, key=lambda item: (item["y0"], item["x0"])):
            center = (word["y0"] + word["y1"]) / 2
            target = next((line for line in grouped
                           if abs(line[0]["y0"] + line[0]["y1"] - 2 * center) <= 5), None)
            if target is None:
                grouped.append([word])
            else:
                target.append(word)
        return [sorted(line, key=lambda item: item["x0"]) for line in grouped]

    def block_caption(block: dict[str, Any], kind: str) -> tuple[int, str] | None:
        raw = " ".join(str(block.get("text", "")).split())
        label = {
            "Figure": r"(?:Figure|Fig\.?|图)",
            "Table": r"(?:Table|Tab\.?|表)",
        }.get(kind, re.escape(kind))
        match = re.match(rf"^\s*{label}\s+(\d+)(?:\s*([:.\-–—])\s*|\s+)(.*)$", raw, re.IGNORECASE)
        if not match:
            return None
        # “Table 2 shows ...” 这类正文引用不是图注，不能当作下一条图注的
        # 边界。真正的图注要么在编号后带标点，要么标题以大写字母或汉字开头。
        # 这样既支持换行的图注，也不会让叙述段落截断它正下方的表格。
        title = match.group(3).strip()
        if match.group(2) is None and title and title[0].islower():
            return None
        return int(match.group(1)), clean_structure_text(f"{kind.title()} {match.group(1)}: {title}", 1200)

    def caption_blocks(page: Any, kind: str) -> list[dict[str, Any]]:
        result = []
        seen = set()
        for block in page.get_text("dict", sort=False).get("blocks", []):
            if block.get("type") != 0:
                continue
            # 一个文本块可能把并排的两条图注并在一起。在行一级找标签，
            # 续行只接到同一栏里。
            lines = block.get("lines", [])
            for index, line in enumerate(lines):
                raw = "".join(span.get("text", "") for span in line.get("spans", []))
                parsed = _caption_candidate(raw)
                if not parsed or parsed[0] != kind.lower() or parsed[1] in seen:
                    continue
                seen.add(parsed[1])
                bbox = list(line["bbox"])
                for following in lines[index + 1:]:
                    text = "".join(span.get("text", "") for span in following.get("spans", []))
                    fx0, fy0, fx1, fy1 = following["bbox"]
                    if _caption_candidate(text) or fy0 < bbox[3] - 2 or min(bbox[2], fx1) <= max(bbox[0], fx0):
                        break
                    raw += " " + text
                    bbox = [min(bbox[0], fx0), bbox[1], max(bbox[2], fx1), fy1]
                result.append({"number": parsed[1], "caption": clean_structure_text(raw, 1200),
                               "bbox": tuple(bbox)})
        return sorted(result, key=lambda item: (item["bbox"][1], item["bbox"][0]))

    def numeric_token(text: str) -> bool:
        value = text.strip()
        if value in {"±", "+/-", "−", "–", "—", "-"}:
            return False
        return bool(re.fullmatch(
            r"[+\-−]?(?:\d+(?:[.,]\d+)?(?:[eE][+\-−]?\d+)?|Top[-–]\d+|\d+[x×]\d+)(?:%|[A-Za-z]+)?",
            value,
        ))

    def table_data_row(words: list[dict[str, Any]]) -> tuple[str, list[str], list[float]] | None:
        numeric_indices = [index for index, word in enumerate(words) if numeric_token(word["text"])]
        if len(numeric_indices) < 2:
            return None
        first = numeric_indices[0]
        label = clean_structure_text(" ".join(word["text"] for word in words[:first]), 500)
        raw_values = [(word["text"], word["x0"]) for word in words[first:]
                      if numeric_token(word["text"]) or word["text"] in {"±", "+/-", "−", "–", "—", "-"}]
        values: list[str] = []
        anchors: list[float] = []
        index = 0
        while index < len(raw_values):
            text, x0 = raw_values[index]
            if text in {"±", "+/-", "−"} and values:
                if index + 1 < len(raw_values):
                    values[-1] = clean_structure_text(f"{values[-1]} {text} {raw_values[index + 1][0]}", 120)
                    index += 2
                    continue
            values.append(clean_structure_text(text, 120))
            anchors.append(x0)
            index += 1
        if len(values) < 2:
            return None
        return label, values[:40], anchors[:40]

    def table_header_row(words: list[dict[str, Any]], anchors: list[float], region_x0: float) -> list[str]:
        width = len(anchors) + 1
        cells = ["" for _ in range(width)]
        first_value_x = anchors[0] if anchors else region_x0
        for word in words:
            x0 = word["x0"]
            if x0 < (region_x0 + first_value_x) / 2:
                cell = 0
            else:
                cell = min(range(len(anchors)), key=lambda index: abs(anchors[index] - x0)) + 1
            cells[cell] = clean_structure_text(f"{cells[cell]} {word['text']}", 300)
        return cells

    TABLE_MISSING_VALUES = {"-", "–", "—"}

    def table_value_token(text: str) -> bool:
        return numeric_token(text) or text.strip() in TABLE_MISSING_VALUES

    def cluster_positions(values: list[float], maximum_gap: float = 18.0) -> list[float]:
        clusters: list[list[float]] = []
        for value in sorted(values):
            if not clusters or value - clusters[-1][-1] > maximum_gap:
                clusters.append([value])
            else:
                clusters[-1].append(value)
        return [sum(cluster) / len(cluster) for cluster in clusters]

    def layout_table_records(page: Any, page_number: int, next_ordinal: int) -> list[dict[str, Any]]:
        """按图注围出的词坐标，恢复没有框线的表格。

        会议论文里相当一部分表格没有框线，``find_tables`` 取不到。这个兜底
        办法用表头给出的指标列位置，单元格一律保留抽取到的文本，不凭空补值，
        也不把结果转成数值矩阵。
        """
        captions = caption_blocks(page, "Table")
        records: list[dict[str, Any]] = []
        page_width = float(page.rect.width)
        metric_words = {"wer", "f1", "accuracy", "precision", "recall", "auc", "eer",
                        "cer", "der", "ser", "per", "map", "mrr", "change", "score",
                        "loss", "bleu", "rouge", "r@1", "r@5", "r@10"}
        for caption_index, caption in enumerate(captions):
            x0, y0, x1, y1 = caption["bbox"]
            full_width = x1 - x0 >= page_width * 0.60
            region_x0 = 50.0 if full_width else max(0.0, x0 - 3.0)
            region_x1 = page_width - 50.0 if full_width else min(page_width, x1 + 3.0)
            # 双栏 PDF 的图注按竖直位置交错。页面上后一条图注可能属于另一栏，
            # 所以只有横向重叠的图注才算本表的边界，否则表格可能被截到半行。
            stop_y = float(page.rect.height)
            for following in captions[caption_index + 1:]:
                if min(region_x1, following["bbox"][2]) - max(region_x0, following["bbox"][0]) > 10:
                    stop_y = following["bbox"][1]
                    break
            lines = word_lines([word for word in fitz_words(page)
                                if word["x0"] >= region_x0 - 1 and word["x1"] <= region_x1 + 1
                                and word["y0"] > y1 + 2 and word["y0"] < stop_y - 1])
            if not lines:
                continue
            header_index = None
            numeric_column_count = 0
            for index, line in enumerate(lines[:8]):
                metric_count = sum(1 for word in line
                                   if word["text"].strip().lower() in metric_words
                                   or re.fullmatch(r"(?:f1|r@[0-9]+|[a-z]+)\.?", word["text"].strip().lower())
                                   and word["text"].strip().lower() in metric_words)
                if metric_count >= 2:
                    header_index = index
                    numeric_column_count = metric_count
                    break
            if header_index is None:
                continue
            value_positions = [word["x0"] for line in lines[header_index + 1:]
                               for word in line if table_value_token(word["text"])]
            anchors = cluster_positions(value_positions)
            if len(anchors) < numeric_column_count:
                continue
            anchors = anchors[-numeric_column_count:]

            def cells_for(line: list[dict[str, Any]]) -> list[str]:
                cells = ["" for _ in range(len(anchors) + 1)]
                for word in line:
                    if word["x0"] < anchors[0] - 20:
                        cell = 0
                    else:
                        cell = min(range(len(anchors)), key=lambda index: abs(anchors[index] - word["x0"])) + 1
                    cells[cell] = clean_structure_text(f"{cells[cell]} {word['text']}", 500)
                return cells

            header = cells_for(lines[header_index])
            rows: list[list[str]] = []
            current: list[str] | None = None
            last_data_y: float | None = None
            for line in lines[header_index + 1:]:
                cells = cells_for(line)
                has_value = any(table_value_token(word["text"])
                                for word in line
                                if word["x0"] >= anchors[0] - 20)
                if has_value:
                    if current is not None:
                        if any(current[index] for index in range(1, len(current))):
                            rows.append(current)
                        elif current[0]:
                            # 凭证约定（conference-pdf-extraction-receipt-v2）
                            # 把每个单元格限制在 500 字符内；合并换行标签时也要
                            # 守住这个上限，长标签才不会让后续读取和核验失败。
                            cells[0] = clean_structure_text(f"{current[0]} {cells[0]}", 500)
                    current = cells
                    last_data_y = line[0]["y0"]
                elif current is not None:
                    if last_data_y is not None and line[0]["y0"] - last_data_y > 22:
                        break
                    # 无框线表格常把新的方法或配置标签单独换到指标单元格之前
                    # 一行。首字母大写或加号开头表示新的一行；小写的续行仍算
                    # 当前单元格的一部分。
                    first_token = cells[0].split(" ", 1)[0] if cells[0] else ""
                    if first_token and (first_token[0].isupper() or first_token[0] in "+−"):
                        rows.append(current)
                        current = cells
                        last_data_y = line[0]["y0"]
                        continue
                    if cells[0]:
                        current[0] = clean_structure_text(f"{current[0]} {cells[0]}", 500)
                    last_data_y = line[0]["y0"]
            if current is not None:
                rows.append(current)
            rows = [row for row in rows if len(row) >= 3 and all(row[index] for index in range(1, len(row)))]
            if len(rows) < 2:
                continue
            matrix = [header, *rows]
            records.append({"ordinal": next_ordinal + len(records), "page": page_number,
                            "caption": caption["caption"], "cells": matrix,
                            "sourceRef": f"pdf:table:{next_ordinal + len(records)}:page:{page_number}",
                            "recoveryStatus": "complete"})
        return records

    def table_records(page: Any, page_number: int, next_ordinal: int) -> tuple[list[dict[str, Any]], int]:
        captions = caption_blocks(page, "Table")
        records: list[dict[str, Any]] = []
        base_ordinal = next_ordinal
        page_width = float(page.rect.width)
        for caption_index, caption in enumerate(captions):
            x0, y0, x1, y1 = caption["bbox"]
            full_width = x1 - x0 >= page_width * 0.60
            region_x0 = 50.0 if full_width else max(0.0, x0 - 3.0)
            region_x1 = page_width - 50.0 if full_width else min(page_width, x1 + 3.0)
            stop_y = float(page.rect.height)
            for following in captions[caption_index + 1:]:
                if min(region_x1, following["bbox"][2]) - max(region_x0, following["bbox"][0]) > 10:
                    stop_y = following["bbox"][1]
                    break
            candidates: list[tuple[float, list[dict[str, Any]], tuple[str, list[str], list[float]] | None]] = []
            data_started = False
            for line in word_lines([word for word in fitz_words(page)
                                    if word["x0"] >= region_x0 - 1 and word["x1"] <= region_x1 + 1
                                    and word["y0"] > y1 + 2 and word["y0"] < stop_y - 1]):
                text = clean_structure_text(" ".join(word["text"] for word in line), 300)
                if not text or len(text) > 150:
                    continue
                data = table_data_row(line)
                if data is not None:
                    candidates.append((line[0]["y0"], line, data))
                    data_started = True
                elif not data_started and len(text) <= 100 and not re.search(r"[.!?]", text):
                    candidates.append((line[0]["y0"], line, None))
                elif data_started and line[0]["y0"] - candidates[-1][0] > 18:
                    break
            data_rows = [item for item in candidates if item[2] is not None]
            if len(data_rows) < 2:
                continue
            widths: dict[int, int] = {}
            for _, _, data in data_rows:
                assert data is not None
                width = 1 + len(data[1])
                widths[width] = widths.get(width, 0) + 1
            width = max(widths, key=lambda candidate: (widths[candidate], candidate))
            valid_data = [data for _, _, data in data_rows if data is not None and 1 + len(data[1]) == width]
            if len(valid_data) < 2 or width < 2:
                continue
            anchors = []
            for index in range(width - 1):
                values = [data[2][index] for data in valid_data if len(data[2]) > index]
                anchors.append(sorted(values)[len(values) // 2])
            matrix: list[list[str]] = []
            header_candidates = [item for item in candidates if item[2] is None]
            for _, line, _ in header_candidates[-3:]:
                header = table_header_row(line, anchors, region_x0)
                if any(header):
                    matrix.append(header)
            for data in valid_data[:100]:
                matrix.append([data[0], *data[1]])
            if len(matrix) < 3:
                continue
            records.append({"ordinal": next_ordinal, "page": page_number,
                            "caption": caption["caption"], "cells": matrix,
                            "sourceRef": f"pdf:table:{next_ordinal}:page:{page_number}",
                            "recoveryStatus": "complete"})
            next_ordinal += 1
        # 上面的按行恢复可能找到了一页里的一张表，却漏掉另一张（多见于第二张
        # 无框线，或配置列换行）。按几何位置恢复表格的方法也要运行，补漏表或替换同图注但更不完整的结果；
        # 一页里本来就可以有多张互不相干的表。
        existing_captions = {record["caption"] for record in records}
        fallback_records = layout_table_records(page, page_number, next_ordinal)
        for record in fallback_records:
            existing_index = next((index for index, current in enumerate(records)
                                   if current["caption"] == record["caption"]), None)
            if existing_index is not None:
                # 启发式解析只恢复了部分数据行时（例如某行指标就是一个单独
                # 的横线），优先用几何方法的结果。序号沿用原来的，下游来源
                # 引用才不会变。
                current_cells = records[existing_index].get("cells", [])
                candidate_cells = record.get("cells", [])
                current_score = sum(bool(cell) for row in current_cells for cell in row)
                candidate_score = sum(bool(cell) for row in candidate_cells for cell in row)
                if (len(candidate_cells), candidate_score) > (len(current_cells), current_score):
                    ordinal = records[existing_index]["ordinal"]
                    record = {**record, "ordinal": ordinal,
                              "sourceRef": f"pdf:table:{ordinal}:page:{page_number}"}
                    records[existing_index] = record
                continue
            records.append(record)
            existing_captions.add(record["caption"])
            next_ordinal += 1
        # 按几何位置恢复的方法会给每条恢复出的图注预分序号，但上面的合并丢掉了那些
        # 按行路径已恢复的同名图注，于是序号出现空档（还会和下一页冲突，
        # 因为下一页的基数是 len(tables)+1）。凭证约定不接受这种记录
        # ("table records must be ordered and complete")。这里按插入顺序
        # 重新连续编号，返回的基数才能和调用方累加的序号接上。
        for index, record in enumerate(records):
            ordinal = base_ordinal + index
            if record.get("ordinal") != ordinal or record.get("sourceRef") != f"pdf:table:{ordinal}:page:{page_number}":
                records[index] = {**record, "ordinal": ordinal,
                                  "sourceRef": f"pdf:table:{ordinal}:page:{page_number}"}
        return records, base_ordinal + len(records)

    def formula_records(pdf_document: Any, page_number: int, next_ordinal: int,
                        render_sha: str | None = None) -> tuple[list[dict[str, Any]], int]:
        page = pdf_document[page_number - 1]
        candidates = _formula_layout_candidates(page)
        if not candidates:
            return [], next_ordinal
        # 让结构记录绑定到 visual_audit 已经留下的那张原页渲染图。少数 PDF 用
        # 第二个 PyMuPDF 文档重渲染时，PNG 元数据会有差异，那样真公式反而
        # 看起来没有绑定。
        render_sha = render_sha or sha256_bytes(page.get_pixmap(dpi=VISUAL_RENDER_DPI, alpha=False).tobytes("png"))
        records = []
        for candidate in candidates:
            if candidate["regionStatus"] != "bounded-formula-region" or len(records) >= MAX_FORMULA_IMAGES:
                continue
            ordinal = next_ordinal + len(records)
            crop = page.get_pixmap(dpi=144, clip=pymupdf.Rect(candidate["cropBBox"]), alpha=False).tobytes("png")
            if len(crop) > MAX_FORMULA_IMAGE_BYTES:
                continue
            records.append({
                "ordinal": ordinal, "page": page_number, "tex": "",
                "sourceRef": f"pdf:formula:{ordinal}:page:{page_number}",
                "recoveryStatus": "layout-preserved",
                "sourceExpression": {
                    "contract": "pdf-formula-source-expression-v1",
                    "kind": "recovered-from-pdf-layout",
                    "originalTexAvailable": False,
                    "layoutSha256": candidate["layoutSha256"],
                    "renderSha256": render_sha,
                    "recoveredTex": candidate["derivedTex"],
                    "crop": {"bbox": candidate["cropBBox"], "dpi": 144, "mediaType": "image/png",
                             "sha256": sha256_bytes(crop), "base64": base64.b64encode(crop).decode("ascii")},
                },
            })
        return records, next_ordinal + len(records)

    def figure_records(pdf_document: Any) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        seen_numbers: set[int] = set()
        total_asset_bytes = 0
        for page_number, page in enumerate(pdf_document, 1):
            captions = caption_blocks(page, "Figure")
            if not captions:
                continue
            visual_blocks = page.get_text("dict").get("blocks", [])
            for caption_index, caption in enumerate(captions):
                if caption["number"] in seen_numbers:
                    continue
                x0, y0, x1, _ = caption["bbox"]
                midpoint = float(page.rect.width) / 2
                # 跨过栏间空白（bbox 越过页面中线）的图注属于跨栏插图。只看
                # 60% 宽度会漏掉这类插图常用的约 52% 宽图注，退回按栏处理又会
                # 裁掉插图留在另一栏的子图（interspeech_2026 aghniya26 的
                # 图 3 已核对到左边缘像素被切）。
                full_width = (x1 - x0 >= float(page.rect.width) * 0.60) \
                    or (x0 < midpoint < x1)
                # 图注短，不代表插图的横向范围就短。按栏取范围，绝不用另一栏
                # 的图注当竖直裁切边界。
                region_x0 = 0.0 if full_width or (x0 + x1) / 2 < midpoint else midpoint
                region_x1 = float(page.rect.width) if full_width or (x0 + x1) / 2 >= midpoint else midpoint
                previous_y = max([0.0, *[other["bbox"][3] + 5
                    for other in captions[:caption_index]
                    if other["bbox"][3] + 5 < y0
                    and min(x1, other["bbox"][2]) > max(x0, other["bbox"][0])]])
                all_drawings = []
                for drawing in page.get_drawings():
                    rect = drawing.get("rect")
                    if not rect or rect.width < 2 or rect.height < 2:
                        continue
                    # 少数会议 PDF 会把插图的裁切路径暴露成超出页面框的绘图。
                    # 那是整页的遮罩，不是插图内容；收下它会让裁切范围吞掉
                    # 旁边的文字栏。
                    if (rect.x0 < -1.0 or rect.y0 < -1.0
                            or rect.x1 > float(page.rect.width) + 1.0
                            or rect.y1 > float(page.rect.height) + 1.0):
                        continue
                    if rect.width > float(page.rect.width) * 0.80 and rect.height > float(page.rect.height) * 0.50:
                        continue
                    all_drawings.append(rect)
                wide_containers = [rect for rect in all_drawings
                                   if rect.width >= float(page.rect.width) * 0.55
                                   # 双栏会议 PDF 里的通栏插图常常只占页高的
                                   # 20–35%；卡到 35% 会把四联插图误判成图注
                                   # 所在的那一窄栏。
                                   and rect.height >= float(page.rect.height) * 0.20
                                   and rect.y0 < y0 - 2 and rect.y1 >= previous_y]
                if wide_containers:
                    # 有些会议 PDF 把标签放在绘图内容框之外一点点。要扩到真正的
                    # 通栏插图容器，而不是整页（整页会把旁边的文字栏也卷进裁切）。
                    region_x0 = max(0.0, min(rect.x0 for rect in wide_containers) - 8.0)
                    region_x1 = min(float(page.rect.width), max(rect.x1 for rect in wide_containers) + 8.0)
                rects = []
                for rect in all_drawings:
                    if rect.x1 >= region_x0 and rect.x0 <= region_x1 and rect.y1 <= y0 - 2 and rect.y1 >= previous_y:
                        rects.append(rect)
                for block in visual_blocks:
                    if block.get("type") != 1:
                        continue
                    rect = pymupdf.Rect(block.get("bbox"))
                    if rect.x1 >= region_x0 and rect.x0 <= region_x1 and rect.y1 <= y0 - 2 and rect.y1 >= previous_y:
                        rects.append(rect)
                asset = None
                # 光有图注，不能把页面上别处不相干的图形变成插图。离得远的
                # 候选只留作视觉证据。
                if rects and y0 - max(rect.y1 for rect in rects) > 60:
                    rects = []
                if rects:
                    # 按栏给的范围只是安全的默认值：当绘图与图片的并集越过栏间
                    # 空白，说明插图确实跨栏。把范围扩到并集再加减标签余量
                    # （只扩不缩），子图及其坐标轴标签才不会被左右边缘切掉。
                    region_x0 = max(0.0, min(region_x0, min(rect.x0 for rect in rects) - 8.0))
                    region_x1 = min(float(page.rect.width), max(region_x1, max(rect.x1 for rect in rects) + 8.0))
                    if wide_containers:
                        visual = pymupdf.Rect(
                            region_x0,
                            max(0.0, min(rect.y0 for rect in wide_containers) - 5.0),
                            region_x1,
                            min(y0 - 2, max(rect.y1 for rect in wide_containers) + 5.0),
                        )
                    else:
                        visual = pymupdf.Rect(min(rect.x0 for rect in rects), min(rect.y0 for rect in rects),
                                              max(rect.x1 for rect in rects), max(rect.y1 for rect in rects))
                        # “Lookup Embedding”、“Patch + Position Embedding”
                        # 这类文字标签不属于绘图或图片块，只按视觉图元求并集会
                        # 偏窄。这些标签的横向安全范围就是图注所在栏的边界。
                        visual = pymupdf.Rect(region_x0, max(previous_y, visual.y0 - 5),
                                              region_x1, min(y0 - 2, visual.y1 + 5))
                    for scale in (1.6, 1.3, 1.0, 0.8, 0.6):
                        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=visual, alpha=False)
                        raw = pixmap.tobytes("png")
                        if len(raw) <= MAX_FIGURE_ASSET_BYTES and total_asset_bytes + len(raw) <= MAX_TOTAL_FIGURE_ASSET_BYTES:
                            asset = {"mediaType": "image/png", "sha256": sha256_bytes(raw),
                                     "base64": base64.b64encode(raw).decode("ascii")}
                            total_asset_bytes += len(raw)
                            break
                if asset is None:
                    # 视觉审计里仍留有候选和原页。没有裁切图，就没有完整、
                    # 可发布的插图。
                    continue
                seen_numbers.add(caption["number"])
                ordinal = len(records) + 1
                records.append({"ordinal": ordinal, "page": page_number,
                                "caption": caption["caption"],
                                "sourceRef": f"pdf:figure:{caption['number']}:page:{page_number}",
                                "recoveryStatus": "complete", "asset": asset})
        return records[:64]

    def _extract_structures(pdf_bytes: bytes, pages: list[str],
                            visual_audit: dict[str, Any] | None = None) -> dict[str, list[dict[str, Any]]]:
        try:
            pdf_document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
            # 调用方没有提供经认证的原页审计，就无法说明含表格的版面可以安全
            # 作为可重新核验的单元格或公式裁切图使用。这些区域一律只留作视觉审计
            # 候选；生产抽取会先显式传入已封存的审计，再启用更完整的 FULL
            # 投影。这样随手直接调用这个辅助函数时，不会悄悄把任意 PDF 几何
            # 变成来源结构。
            conservative_visual_only = False
            if visual_audit is None:
                audit_probe = _build_visual_audit(pdf_document)
                conservative_visual_only = any(
                    isinstance(candidate, dict) and (
                        candidate.get("rows", 0) > 0 or "rawCells" in candidate)
                    for candidate in audit_probe.get("tableCandidates", []))
            tables: list[dict[str, Any]] = []
            formulas: list[dict[str, Any]] = []
            if not conservative_visual_only:
                for page_number in range(pdf_document.page_count):
                    page_tables, _ = table_records(pdf_document[page_number], page_number + 1, len(tables) + 1)
                    tables.extend(page_tables)
                    audit_page = next((item for item in (visual_audit or {}).get("pages", [])
                                       if item.get("page") == page_number + 1), None)
                    page_formulas, _ = formula_records(
                        pdf_document, page_number + 1, len(formulas) + 1,
                        str(audit_page["sha256"]) if audit_page else None,
                    )
                    formulas.extend(page_formulas)
            retained_formulas = []
            formula_bytes = 0
            for formula in formulas:
                size = len(base64.b64decode(formula["sourceExpression"]["crop"]["base64"]))
                if len(retained_formulas) >= MAX_FORMULA_IMAGES or formula_bytes + size > MAX_TOTAL_FORMULA_IMAGE_BYTES:
                    break
                retained_formulas.append(formula)
                formula_bytes += size
            formulas = retained_formulas
            figures = figure_records(pdf_document)
            pdf_document.close()
            return _json_safe_deep({"tables": tables, "formulas": formulas, "figures": figures})
        except ConferenceExtractionError:
            raise
        except Exception:
            return {"tables": [], "formulas": [], "figures": []}

    def extract_structures(pdf_bytes: bytes, pages: list[str],
                           visual_audit: dict[str, Any] | None = None) -> dict[str, list[dict[str, Any]]]:
        with _quiet_pymupdf_output():
            return _extract_structures(pdf_bytes, pages, visual_audit)

    def extract_visual_audit(pdf_bytes: bytes) -> dict[str, Any]:
        try:
            with _quiet_pymupdf_output():
                document = fitz.open(stream=pdf_bytes, filetype="pdf")
                if document.needs_pass:
                    raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
                result = _build_visual_audit(document)
                result["backend"] = {"name": "pymupdf", "version": version}
                result.pop("auditSha256", None)
                result["auditSha256"] = _stable_hash(result)
                document.close()
            return result
        except ConferencePdfExtractionError:
            raise
        except Exception as exc:
            raise ConferencePdfExtractionError(
                f"PyMuPDF visual audit failed ({type(exc).__name__})"
            ) from exc

    return ExtractionBackend(name="pymupdf", version=version, extract_pages=extract_pages,
        extract_structures=extract_structures, extract_visual_audit=extract_visual_audit)


def _page_ranges(pages: list[str]) -> tuple[bytes, list[dict[str, Any]]]:
    payload = bytearray()
    ranges: list[dict[str, Any]] = []
    separator = PAGE_SEPARATOR.encode("utf-8")
    for index, page in enumerate(pages):
        encoded = page.encode("utf-8")
        start = len(payload)
        payload.extend(encoded)
        # 现行来源上下文约定要求每页区间非空，且各区间正好拼成整段扁平文本。
        # 末尾补一个分隔符，真正空白的 PDF 页也能拿到明确且安全的区间，
        # 不必为它编造文字内容。
        payload.extend(separator)
        ranges.append({
            "page": index + 1,
            "textStart": start,
            "textEnd": len(payload),
        })
    return bytes(payload), ranges


def _json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _compact_json_bytes(value: dict[str, Any]) -> bytes:
    """让这里自己生成的 JSON 值与 JavaScript 的 JSON.stringify 一致。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _stable_hash(value: Any) -> str:
    return sha256_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _build_receipt(body: dict[str, Any]) -> dict[str, Any]:
    return {**body, "receiptSha256": _stable_hash(body)}


def _reserve_and_write(root_fd: int, outputs: list[tuple[str, bytes]]) -> None:
    opened: list[tuple[str, int]] = []
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        for name, _ in outputs:
            fd = os.open(name, flags, 0o600, dir_fd=root_fd)
            opened.append((name, fd))
        for (_, fd), (_, content) in zip(opened, outputs):
            written = 0
            while written < len(content):
                count = os.write(fd, content[written:])
                if count <= 0:
                    raise OSError("short write while materializing extraction output")
                written += count
            os.fsync(fd)
            os.fchmod(fd, 0o600)
        os.fsync(root_fd)
    except Exception as error:
        cleanup_errors = []
        for name, fd in opened:
            try:
                try:
                    named = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                owned = os.fstat(fd)
                if (not stat.S_ISREG(named.st_mode) or named.st_nlink != 1
                        or (named.st_dev, named.st_ino) != (owned.st_dev, owned.st_ino)):
                    raise _fail("抽取输出文件已换主，拒绝清理")
                os.unlink(name, dir_fd=root_fd)
            except Exception as cleanup_error:
                cleanup_errors.append(cleanup_error)
        if cleanup_errors:
            raise error from ExceptionGroup("抽取失败后部分输出不能安全清理", cleanup_errors)
        raise
    finally:
        for _, fd in opened:
            os.close(fd)



def run_extraction(
    manifest_name: str,
    *,
    apply: bool,
    source_root: Path = DEFAULT_STAGING_SOURCE_DIR,
    backend: ExtractionBackend | None = None,
) -> dict[str, Any]:
    """校验一份不可变的抽取结果，指定 apply 时保存文件。"""
    manifest_name = _safe_name(manifest_name, SAFE_JSON_NAME, "manifest name")
    root_fd = _open_root(Path(source_root))
    try:
        manifest_bytes = _read_regular_single_link(root_fd, manifest_name, MAX_MANIFEST_BYTES, "manifest")
        request = validate_request(_strict_json_object(manifest_bytes, "manifest"), manifest_name)
        metadata_name = request["source"]["metadata"]["file"]
        pdf_name = request["source"]["pdf"]["file"]
        metadata_bytes = _read_regular_single_link(root_fd, metadata_name, MAX_METADATA_BYTES, "metadata")
        metadata = _strict_json_object(metadata_bytes, "metadata")
        pdf_bytes = _read_regular_single_link(root_fd, pdf_name, MAX_PDF_BYTES, "PDF")
        if sha256_bytes(metadata_bytes) != request["source"]["metadata"]["sha256"]:
            raise _fail(f"metadata SHA-256 differs from the extraction request: actual {sha256_bytes(metadata_bytes)}, expected {request['source']['metadata']['sha256']}")
        _validate_metadata_identity(metadata, request)
        pdf_sha = sha256_bytes(pdf_bytes)
        if pdf_sha != request["source"]["pdf"]["sha256"]:
            raise _fail(f"PDF SHA-256 differs from the extraction request: actual {pdf_sha}, expected {request['source']['pdf']['sha256']}")
        if not pdf_bytes.startswith(b"%PDF-"):
            raise _fail("PDF source does not have a standard PDF header")
        for output_name in request["outputs"].values():
            try:
                os.stat(output_name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise _fail(f"output already exists: {output_name}")

        active_backend = backend
        extraction_error: ConferenceExtractionError | None = None
        pages: list[str] | None = None
        if active_backend is None:
            active_backend = load_pypdf_backend()
        if active_backend is not None:
            try:
                pages = active_backend.extract_pages(pdf_bytes)
            except ConferenceExtractionError as exc:
                extraction_error = exc
            except Exception as exc:
                extraction_error = ConferencePdfExtractionError(str(exc))

        options = dict(request["options"])
        backend_info = None if active_backend is None else {"name": active_backend.name, "version": active_backend.version}
        text_bytes: bytes | None = None
        artifact_bytes: bytes | None = None
        structures: dict[str, list[dict[str, Any]]] = {"tables": [], "formulas": [], "figures": []}
        visual_audit: dict[str, Any] | None = None
        page_count: int | None = None
        non_whitespace: int | None = None
        status = "blocked"
        blocked_reason: dict[str, str] | None = None
        if pages is not None:
            if not isinstance(pages, list) or len(pages) > MAX_PAGES:
                pages = None
                extraction_error = ConferencePdfExtractionError("PDF backend returned an invalid page collection (expected list with at most MAX_PAGES pages)")
            elif not pages:
                extraction_error = ConferencePdfExtractionError("PDF contains no pages")
            else:
                pages = [_normalize_page_text(page) for page in pages]
                text_bytes, ranges = _page_ranges(pages)
                page_count = len(pages)
                non_whitespace = sum(1 for character in text_bytes.decode("utf-8") if not character.isspace())
                if len(text_bytes) > MAX_DERIVED_BYTES:
                    extraction_error = ConferencePdfExtractionError(f"extracted text exceeds the derived artifact limit: {len(text_bytes)} > {MAX_DERIVED_BYTES}")
                    text_bytes = None
                if text_bytes is None:
                    status = "blocked"
                    blocked_reason = {"code": "PDF_EXTRACTION_FAILED", "message": str(extraction_error)}
                else:
                    if active_backend.extract_visual_audit is None:
                        extraction_error = ConferencePdfExtractionError(
                            "PDF backend does not provide a replayable visual audit"
                        )
                        status = "blocked"
                        blocked_reason = {"code": "PDF_VISUAL_AUDIT_UNAVAILABLE", "message": str(extraction_error)}
                        text_bytes = None
                    else:
                        try:
                            visual_audit = active_backend.extract_visual_audit(pdf_bytes)
                        except ConferenceExtractionError as exc:
                            extraction_error = exc
                            status = "blocked"
                            blocked_reason = {"code": "PDF_VISUAL_AUDIT_FAILED", "message": str(exc)}
                            text_bytes = None
                    if text_bytes is None:
                        status = "blocked"
                        blocked_reason = {"code": blocked_reason["code"], "message": blocked_reason["message"]}
                    else:
                        if active_backend.extract_structures is not None:
                            structures = active_backend.extract_structures(pdf_bytes, pages, visual_audit)
                        minimum_text_characters = options["minimumTextCharacters"]
                        short = non_whitespace < minimum_text_characters
                        status = "blocked" if short else "ready"
                        blocked_reason = ({"code": "TEXT_TOO_SHORT", "message":
                            f"extracted non-whitespace text is below {minimum_text_characters} characters: actual {non_whitespace}"}
                            if short else None)
                        artifact = {
                            "contract": ARTIFACT_CONTRACT,
                            "version": CONTRACT_VERSION,
                            "profile": PROFILE,
                            "offsetUnit": OFFSET_UNIT,
                            "flattenedTextSha256": sha256_bytes(text_bytes),
                            "pages": ranges,
                            "tables": structures.get("tables", []),
                            "formulas": structures.get("formulas", []),
                            "figures": structures.get("figures", []),
                            "visualAudit": visual_audit,
                        }
                        artifact["payloadSha256"] = sha256_bytes(_compact_json_bytes(artifact))
                        artifact_bytes = _json_bytes(artifact)
                        if len(artifact_bytes) > MAX_DERIVED_BYTES:
                            raise _fail(f"structured artifact exceeds the derived artifact limit: {len(artifact_bytes)} > {MAX_DERIVED_BYTES}")
        if pages is None or extraction_error is not None and artifact_bytes is None:
            status = "blocked"
            blocked_reason = blocked_reason or {
                "code": "PDF_EXTRACTION_FAILED",
                "message": str(extraction_error or "PDF extraction failed"),
            }

        text_descriptor = None if text_bytes is None else {
            "file": request["outputs"]["textFile"],
            "sha256": sha256_bytes(text_bytes),
            "utf8Bytes": len(text_bytes),
            "nonWhitespaceCharacters": non_whitespace,
        }
        artifact_descriptor = None if artifact_bytes is None else {
            "file": request["outputs"]["artifactsFile"],
            "sha256": sha256_bytes(artifact_bytes),
        }
        receipt_body = {
            "contract": RECEIPT_CONTRACT,
            "version": CONTRACT_VERSION,
            "status": status,
            "textReplayable": status == "ready",
            "structuredReplayable": status == "ready",
            "paperId": request["paperId"],
            "sourceIdentity": request["sourceIdentity"],
            "request": {"file": manifest_name, "sha256": sha256_bytes(manifest_bytes)},
            "source": {
                "metadata": {**request["source"]["metadata"], "sha256": sha256_bytes(metadata_bytes)},
                "pdf": {**request["source"]["pdf"], "sha256": pdf_sha},
            },
            "extractor": {"name": EXTRACTOR_NAME, "version": EXTRACTOR_VERSION, "backend": backend_info},
            "options": options,
            "pageCount": page_count,
            "text": text_descriptor,
            "artifacts": artifact_descriptor,
            "blockedReason": blocked_reason,
        }
        receipt = _build_receipt(receipt_body)
        receipt_bytes = _json_bytes(receipt)
        outputs_to_write: list[tuple[str, bytes]] = []
        if text_bytes is not None and artifact_bytes is not None:
            outputs_to_write.extend([
                (request["outputs"]["textFile"], text_bytes),
                (request["outputs"]["artifactsFile"], artifact_bytes),
            ])
        outputs_to_write.append((request["outputs"]["receiptFile"], receipt_bytes))
        if apply:
            _reserve_and_write(root_fd, outputs_to_write)
        return {
            "status": status,
            "mode": "apply" if apply else "dry-run",
            "paperId": request["paperId"],
            "pageCount": page_count,
            "textCharacters": non_whitespace,
            "textReplayable": status == "ready",
            "structuredReplayable": status == "ready",
            "receiptSha256": receipt["receiptSha256"],
            "outputs": [name for name, _ in outputs_to_write] if apply else [],
        }
    finally:
        os.close(root_fd)


def verify_extraction(manifest_name: str, *, source_root: Path = DEFAULT_STAGING_SOURCE_DIR) -> dict[str, Any]:
    """从原始 PDF 重跑固定版本的结构抽取器，逐字节比对每个输出。"""
    manifest_name = _safe_name(manifest_name, SAFE_JSON_NAME, "manifest name")
    root_fd = _open_root(Path(source_root))
    try:
        manifest_bytes = _read_regular_single_link(root_fd, manifest_name, MAX_MANIFEST_BYTES, "manifest")
        request = validate_request(_strict_json_object(manifest_bytes, "manifest"), manifest_name)
        metadata_name = request["source"]["metadata"]["file"]
        pdf_name = request["source"]["pdf"]["file"]
        metadata_bytes = _read_regular_single_link(root_fd, metadata_name, MAX_METADATA_BYTES, "metadata")
        pdf_bytes = _read_regular_single_link(root_fd, pdf_name, MAX_PDF_BYTES, "PDF")
        current_outputs = {
            key: _read_regular_single_link(
                root_fd,
                name,
                MAX_DERIVED_BYTES,
                f"existing {key}",
            )
            for key, name in request["outputs"].items()
        }
    finally:
        os.close(root_fd)

    with tempfile.TemporaryDirectory(prefix="conference-extraction-verify-") as temporary:
        replay_root = Path(temporary).resolve()
        for name, raw in ((manifest_name, manifest_bytes), (metadata_name, metadata_bytes), (pdf_name, pdf_bytes)):
            target = replay_root / name
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                written = 0
                while written < len(raw):
                    count = os.write(fd, raw[written:])
                    if count <= 0:
                        raise OSError("short write while preparing extraction replay")
                    written += count
                os.fsync(fd)
            finally:
                os.close(fd)
        result = run_extraction(manifest_name, apply=True, source_root=replay_root)
        if result["status"] != "ready":
            raise _fail(f"replayed extraction is not ready: status={result['status']!r}")
        replayed_outputs = {
            key: (replay_root / name).read_bytes()
            for key, name in request["outputs"].items()
        }

    for key in request["outputs"]:
        if current_outputs[key] != replayed_outputs[key]:
            raise _fail(f"existing {key} differs from a fresh pinned extraction replay: actual {sha256_bytes(current_outputs[key])}, expected {sha256_bytes(replayed_outputs[key])}")
    receipt = _strict_json_object(replayed_outputs["receiptFile"], "replayed receipt")
    body = {
        "contract": VERIFICATION_CONTRACT,
        "version": CONTRACT_VERSION,
        "status": "verified",
        "paperId": request["paperId"],
        "sourceIdentity": request["sourceIdentity"],
        "requestSha256": sha256_bytes(manifest_bytes),
        "metadataSha256": sha256_bytes(metadata_bytes),
        "pdfSha256": sha256_bytes(pdf_bytes),
        "textSha256": sha256_bytes(replayed_outputs["textFile"]),
        "artifactsSha256": sha256_bytes(replayed_outputs["artifactsFile"]),
        "receiptFileSha256": sha256_bytes(replayed_outputs["receiptFile"]),
        "receiptSha256": _expected_sha(receipt.get("receiptSha256"), "replayed receipt.receiptSha256"),
    }
    return {**body, "verificationSha256": _stable_hash(body)}


def verify_blocked_extraction(manifest_name: str, *, source_root: Path = DEFAULT_STAGING_SOURCE_DIR) -> dict[str, Any]:
    """重放被阻断的抽取，但不把它升格成可用于暂存的凭证。"""
    manifest_name = _safe_name(manifest_name, SAFE_JSON_NAME, "manifest name")
    root_fd = _open_root(Path(source_root))
    try:
        manifest_bytes = _read_regular_single_link(root_fd, manifest_name, MAX_MANIFEST_BYTES, "manifest")
        request = validate_request(_strict_json_object(manifest_bytes, "manifest"), manifest_name)
        metadata_name = request["source"]["metadata"]["file"]
        pdf_name = request["source"]["pdf"]["file"]
        metadata_bytes = _read_regular_single_link(root_fd, metadata_name, MAX_METADATA_BYTES, "metadata")
        pdf_bytes = _read_regular_single_link(root_fd, pdf_name, MAX_PDF_BYTES, "PDF")
    finally:
        os.close(root_fd)

    with tempfile.TemporaryDirectory(prefix="conference-blocked-extraction-verify-") as temporary:
        replay_root = Path(temporary).resolve()
        for name, raw in ((manifest_name, manifest_bytes), (metadata_name, metadata_bytes), (pdf_name, pdf_bytes)):
            target = replay_root / name
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                written = 0
                while written < len(raw):
                    count = os.write(fd, raw[written:])
                    if count <= 0:
                        raise OSError("short write while preparing blocked extraction replay")
                    written += count
                os.fsync(fd)
            finally:
                os.close(fd)
        result = run_extraction(manifest_name, apply=True, source_root=replay_root)
        if result["status"] != "blocked":
            raise _fail(f"replayed extraction is not blocked: status={result['status']!r}")
        produced = set(result["outputs"])
        if request["outputs"]["receiptFile"] not in produced:
            raise _fail(f"blocked extraction replay did not produce its receipt: produced {sorted(produced)}")
        replayed_outputs = {key: (replay_root / name).read_bytes()
            for key, name in request["outputs"].items() if name in produced}

    root_fd = _open_root(Path(source_root))
    try:
        if (_read_regular_single_link(root_fd, manifest_name, MAX_MANIFEST_BYTES, "current manifest") != manifest_bytes
                or _read_regular_single_link(root_fd, metadata_name, MAX_METADATA_BYTES, "current metadata") != metadata_bytes
                or _read_regular_single_link(root_fd, pdf_name, MAX_PDF_BYTES, "current PDF") != pdf_bytes):
            raise _fail("blocked extraction inputs changed during replay: manifest, metadata, or PDF")
        current_outputs: dict[str, bytes] = {}
        for key, name in request["outputs"].items():
            if name in produced:
                current_outputs[key] = _read_regular_single_link(
                    root_fd, name, MAX_DERIVED_BYTES, f"existing blocked {key}")
            else:
                try:
                    os.stat(name, dir_fd=root_fd, follow_symlinks=False)
                except FileNotFoundError:
                    continue
                raise _fail(f"blocked extraction has unexpected output: {name}")
    finally:
        os.close(root_fd)

    for key, replayed in replayed_outputs.items():
        if current_outputs[key] != replayed:
            raise _fail(f"existing blocked {key} differs from a fresh pinned extraction replay: actual {sha256_bytes(current_outputs[key])}, expected {sha256_bytes(replayed)}")
    receipt = _strict_json_object(replayed_outputs["receiptFile"], "replayed blocked receipt")
    _exact_object(receipt, ["contract", "version", "status", "textReplayable", "structuredReplayable",
        "paperId", "sourceIdentity", "request", "source", "extractor", "options", "pageCount", "text",
        "artifacts", "blockedReason", "receiptSha256"], "blocked extraction receipt")
    if (receipt["contract"] != RECEIPT_CONTRACT or receipt["version"] != CONTRACT_VERSION
            or receipt["status"] != "blocked" or receipt["textReplayable"] is not False
            or receipt["structuredReplayable"] is not False):
        raise _fail(f"blocked extraction receipt contract/status is invalid: contract={receipt['contract']!r} (expected {RECEIPT_CONTRACT!r}), version={receipt['version']!r} (expected {CONTRACT_VERSION}), status={receipt['status']!r} (expected 'blocked'), textReplayable={receipt['textReplayable']!r}, structuredReplayable={receipt['structuredReplayable']!r}")
    reason = _exact_object(receipt["blockedReason"], ["code", "message"], "blockedReason")
    if reason["code"] not in {"TEXT_TOO_SHORT", "PDF_EXTRACTION_FAILED"}:
        raise _fail(f"blocked extraction reason code is unsupported: actual {reason['code']!r}, supported ['PDF_EXTRACTION_FAILED', 'TEXT_TOO_SHORT']")
    _plain_text(reason["message"], "blockedReason.message", 2000)
    receipt_body = dict(receipt)
    receipt_sha = _expected_sha(receipt_body.pop("receiptSha256"), "blocked receipt.receiptSha256")
    if receipt_sha != _stable_hash(receipt_body):
        raise _fail(f"blocked extraction receipt self-SHA drifted: declared {receipt_sha}, recomputed {_stable_hash(receipt_body)}")
    text_sha = None if "textFile" not in replayed_outputs else sha256_bytes(replayed_outputs["textFile"])
    artifacts_sha = None if "artifactsFile" not in replayed_outputs else sha256_bytes(replayed_outputs["artifactsFile"])
    body = {
        "contract": BLOCKED_VERIFICATION_CONTRACT,
        "version": 1,
        "status": "verified-blocked",
        "paperId": request["paperId"],
        "sourceIdentity": request["sourceIdentity"],
        "blockedReason": {"code": reason["code"], "message": reason["message"]},
        "requestSha256": sha256_bytes(manifest_bytes),
        "metadataSha256": sha256_bytes(metadata_bytes),
        "pdfSha256": sha256_bytes(pdf_bytes),
        "textSha256": text_sha,
        "artifactsSha256": artifacts_sha,
        "receiptFileSha256": sha256_bytes(replayed_outputs["receiptFile"]),
        "receiptSha256": receipt_sha,
    }
    return {**body, "verificationSha256": _stable_hash(body)}


def parse_args(argv: list[str]) -> tuple[str, str, Path]:
    if len(argv) == 3 and argv[0] in {"--dry-run", "--apply"} and argv[1] == "--manifest":
        return argv[0][2:], _safe_name(argv[2], SAFE_JSON_NAME, "manifest name"), DEFAULT_STAGING_SOURCE_DIR
    if (len(argv) == 5 and argv[0] == "--verify" and argv[1] == "--manifest"
            and argv[3] == "--source-root"):
        root = Path(argv[4])
        if not root.is_absolute():
            raise ConferenceExtractionIntegrityError("verify source root must be absolute")
        return "verify", _safe_name(argv[2], SAFE_JSON_NAME, "manifest name"), root
    raise ConferenceExtractionIntegrityError(
        "usage: --dry-run|--apply --manifest NAME.json; or --verify --manifest NAME.json --source-root ABS"
    )


__all__ = [
    "ARTIFACT_CONTRACT",
    "CONTRACT_VERSION",
    "ConferenceExtractionDependencyError",
    "ConferenceExtractionError",
    "ConferenceExtractionIntegrityError",
    "ConferencePdfExtractionError",
    "DEFAULT_STAGING_SOURCE_DIR",
    "EXTRACTOR_NAME",
    "EXTRACTOR_VERSION",
    "ExtractionBackend",
    "MINIMUM_TEXT_CHARACTERS",
    "SHORT_PROCEEDINGS_MINIMUM_TEXT_CHARACTERS",
    "MAX_PAGES",
    "NORMALIZATION",
    "OFFSET_UNIT",
    "PAGE_SEPARATOR",
    "PROFILE",
    "RECEIPT_CONTRACT",
    "VERIFICATION_CONTRACT",
    "REQUEST_CONTRACT",
    "load_pypdf_backend",
    "parse_args",
    "run_extraction",
    "sha256_bytes",
    "validate_request",
    "verify_extraction",
]


if __name__ == "__main__":
    from runtime_guard import require_external_runtime

    require_external_runtime("conference_extractor.py")

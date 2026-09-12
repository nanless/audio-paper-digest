#!/usr/bin/env python3
"""Deterministic, local extraction for staged conference PDFs.

The extractor keeps the original PDF as the authority and derives a
replayable page-text map plus conservative table, formula, and Figure records
from that PDF.  It never uses the network or an LLM.  A structure is only
emitted when the PDF text/layout contains enough evidence to bind it to a
page; uncertain structures are omitted rather than invented.
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
import base64
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
EXTRACTOR_VERSION = "2.2.0"
PROFILE = "replayable-pdf-layout-v1"
VISUAL_AUDIT_CONTRACT = "conference-pdf-visual-audit-v1"
VISUAL_AUDIT_VERSION = 1
VISUAL_RENDER_DPI = 72
MAX_VISUAL_AUDIT_BYTES = 48 * 1024 * 1024
OFFSET_UNIT = "utf8-byte"
MINIMUM_TEXT_CHARACTERS = 5000
PAGE_SEPARATOR = "\n\f\n"
NORMALIZATION = "unicode-nfc-lf-rstrip-v1"
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_PDF_BYTES = 256 * 1024 * 1024
MAX_DERIVED_BYTES = 64 * 1024 * 1024
MAX_FIGURE_ASSET_BYTES = 2 * 1024 * 1024
MAX_TOTAL_FIGURE_ASSET_BYTES = 24 * 1024 * 1024
MAX_PAGES = 10000
SAFE_JSON_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.json$")
SAFE_PDF_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.pdf$")
SAFE_TEXT_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.txt$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
SOURCE_KINDS = {"official-metadata", "official-pdf", "conference-proceedings", "openreview", "local-confirmed-copy"}
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class ConferenceExtractionError(RuntimeError):
    """Base class for rejected extraction work."""


class ConferenceExtractionIntegrityError(ConferenceExtractionError):
    """The request, source, or destination crossed the trusted boundary."""


class ConferenceExtractionDependencyError(ConferenceExtractionError):
    """The pinned PDF extraction backend is not available."""


class ConferencePdfExtractionError(ConferenceExtractionError):
    """The PDF backend could not extract the staged document."""


@dataclass(frozen=True)
class ExtractionBackend:
    name: str
    version: str
    extract_pages: Callable[[bytes], list[str]]
    extract_structures: Callable[[bytes, list[str]], dict[str, list[dict[str, Any]]]] | None = None
    extract_visual_audit: Callable[[bytes], dict[str, Any]] | None = None


def _fail(message: str) -> ConferenceExtractionIntegrityError:
    return ConferenceExtractionIntegrityError(f"Conference PDF extraction rejected: {message}")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _exact_object(value: Any, fields: Iterable[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _fail(f"{label} must be an object")
    expected = sorted(fields)
    if sorted(value.keys()) != expected:
        raise _fail(f"{label} has unknown or missing fields")
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


def _source_provenance(value: Any, label: str) -> dict[str, str]:
    provenance = _exact_object(value, ["kind", "locator", "retrievedAt"], f"{label}.provenance")
    kind = _plain_text(provenance["kind"], f"{label}.provenance.kind")
    if kind not in SOURCE_KINDS:
        raise _fail(f"{label}.provenance.kind is unsupported")
    retrieved_at = _plain_text(provenance["retrievedAt"], f"{label}.provenance.retrievedAt")
    if not ISO_TIMESTAMP_RE.fullmatch(retrieved_at):
        raise _fail(f"{label}.provenance.retrievedAt must be a canonical UTC timestamp")
    try:
        from datetime import datetime
        if datetime.fromisoformat(retrieved_at.replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z") != retrieved_at:
            raise ValueError("timestamp does not round-trip")
    except ValueError as exc:
        raise _fail(f"{label}.provenance.retrievedAt must be a canonical UTC timestamp") from exc
    return {"kind": kind, "locator": _plain_text(provenance["locator"], f"{label}.provenance.locator", 2000),
        "retrievedAt": retrieved_at}


def _resolve_pointer(document: Any, pointer: str, label: str) -> Any:
    current = document
    for encoded in pointer[1:].split("/"):
        key = encoded.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            if not re.fullmatch(r"(?:0|[1-9]\d*)", key) or int(key) >= len(current):
                raise _fail(f"{label} does not resolve in metadata")
            current = current[int(key)]
        elif isinstance(current, dict) and key in current:
            current = current[key]
        else:
            raise _fail(f"{label} does not resolve in metadata")
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
        raise _fail("metadata conference identity is malformed")
    if request["sourceIdentity"] != f"{identity_type}:{identity_value}":
        raise _fail("metadata identity evidence does not bind paperId/sourceIdentity")
    try:
        assert_canonical_conference_paper_id(request["paperId"],
            {"id": conference_id, "year": conference_year},
            {"type": identity_type, "value": identity_value})
    except ValueError as exc:
        raise _fail("metadata identity evidence does not bind canonical paperId") from exc


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
        raise _fail("extraction request contract/version is unsupported")
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
                "provenance": _source_provenance(metadata["provenance"], "source.metadata"),
            },
            "pdf": {
                "file": _safe_name(pdf["file"], SAFE_PDF_NAME, "source.pdf.file"),
                "sha256": _expected_sha(pdf["sha256"], "source.pdf.sha256"),
                "provenance": _source_provenance(pdf["provenance"], "source.pdf"),
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
    if normalized["options"] != {
        "minimumTextCharacters": MINIMUM_TEXT_CHARACTERS,
        "normalization": NORMALIZATION,
        "pageSeparator": PAGE_SEPARATOR,
    }:
        raise _fail("extraction options must exactly match the supported conference profile")
    names = [manifest_name, metadata["file"], pdf["file"], *normalized["outputs"].values()]
    if len(set(names)) != len(names):
        raise _fail("manifest, input, and output filenames must all differ")
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
        raise _fail(f"{label} must be a bounded regular single-link file")
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
    # Some otherwise readable PDFs contain UTF-16 surrogate code points in a
    # font encoding map.  Keep valid pairs as their Unicode scalar value and
    # replace only unpaired surrogates so the sealed artifact remains strict
    # UTF-8 instead of turning a recoverable page into PDF_EXTRACTION_FAILED.
    value = value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")
    value = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    return "\n".join(line.rstrip() for line in value.split("\n")).strip("\n")


def _visual_text(value: str, maximum: int = 4000) -> str:
    value = _normalize_page_text(value)
    return value[:maximum]


def _bbox(value: Any) -> list[float]:
    normalized = []
    for item in value:
        rounded = round(float(item), 3)
        # JSON.stringify emits 1 for an integral JavaScript Number while
        # Python's json.dumps emits 1.0. Normalize here so the visual-audit
        # hash replays identically across the Python extractor and Node gate.
        normalized.append(int(rounded) if rounded.is_integer() else rounded)
    return normalized


def _formula_candidate(text: str) -> bool:
    if not text or len(text) > 240:
        return False
    operators = sum(text.count(symbol) for symbol in "=±≤≥∑∏∫√×·^_")
    greek = bool(re.search(r"[α-ωΑ-ΩλμσθφψΔΓΣΠΩ]", text))
    return operators >= 1 and (operators >= 2 or greek)


def _caption_candidate(text: str) -> tuple[str, int] | None:
    """Recognize a caption line, not a prose citation to a Figure/Table.

    A PDF text layer commonly contains sentences such as ``Figure 2 presents``
    in the body. Treating every such line as a visual candidate made page
    selection drift toward nearly the whole paper. Captions in the supported
    conference layouts start with their label and number; keep this heuristic
    deliberately conservative because the page PNG remains the authoritative
    visual evidence.
    """
    match = re.match(
        r"^\s*(?:(figure|fig\.?|table|tab\.?)\s*(\d+)|([图表])\s*(\d+))"
        r"(?:\s*[.．:：;；)）\-–—]|\s+|$)",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    raw_label = (match.group(1) or match.group(3) or "figure").lower()
    raw_number = match.group(2) or match.group(4)
    label = "table" if raw_label in {"table", "tab.", "表"} else "figure"
    return label, int(raw_number)


def _build_visual_audit(document: Any) -> dict[str, Any]:
    """Build deterministic visual evidence using a PyMuPDF document."""
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
                f"visual audit exceeds the derived artifact limit ({MAX_VISUAL_AUDIT_BYTES} bytes)"
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
                if _formula_candidate(line_text):
                    formula_candidates.append({
                        "page": page_number,
                        "bbox": _bbox(line.get("bbox", (0, 0, 0, 0))),
                        "text": _visual_text(line_text, 240),
                        "renderSha256": render_sha,
                        "sourceRef": f"pdf://page/{page_number}/formula/{len(formula_candidates) + 1}",
                        "status": "visual-only-no-tex",
                    })
                caption = _caption_candidate(line_text)
                if caption:
                    label, number = caption
                    target = table_candidates if label == "table" else figure_candidates
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
                    "status": "matrix-extracted" if rectangular else "needs-review",
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
            "表格候选只有 status=matrix-extracted 且矩阵完整时才允许后续人工/规则复核。",
            "Figure/图片通过原页 PNG SHA 和 PDF 内嵌图片 SHA 绑定，未把坐标或曲线语义交给自动推断。",
        ],
    }
    body["auditSha256"] = _stable_hash(body)
    return body


def load_pypdf_backend() -> ExtractionBackend:
    """Load the pinned PyMuPDF backend lazily (legacy function name retained)."""
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
            with contextlib.redirect_stdout(io.StringIO()):
                document = fitz.open(stream=pdf_bytes, filetype="pdf")
                if document.needs_pass:
                    raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
                if len(document) > MAX_PAGES:
                    raise ConferencePdfExtractionError(f"PDF page count exceeds {MAX_PAGES}")
                pages = []
                extracted_bytes = 0
                for page in document:
                    text = _normalize_page_text(page.get_text("text", sort=True))
                    extracted_bytes += len(text.encode("utf-8")) + len(PAGE_SEPARATOR.encode("utf-8"))
                    if extracted_bytes > MAX_DERIVED_BYTES:
                        raise ConferencePdfExtractionError("extracted text exceeds the derived artifact limit")
                    pages.append(text)
                document.close()
        except ConferencePdfExtractionError:
            raise
        except Exception as exc:  # PyMuPDF exposes version-specific parse exceptions.
            raise ConferencePdfExtractionError(
                f"PyMuPDF could not extract the PDF ({type(exc).__name__})"
            ) from exc
        if not pages:
            raise ConferencePdfExtractionError("PDF contains no pages")
        return pages

    def clean_structure_text(value: str, maximum: int = 4000) -> str:
        value = unicodedata.normalize("NFC", value or "")
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
        return re.sub(r"\s+", " ", value).strip()[:maximum]

    def clean_formula_text(value: str, maximum: int = 1000) -> str:
        value = unicodedata.normalize("NFC", value or "")
        value = value.replace("\x10", "[").replace("\x11", "]")
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
        return re.sub(r"\s+", " ", value).strip()[:maximum]

    def fitz_lines(page: Any) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for block in page.get_text("dict").get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                text = "".join(str(span.get("text", "")) for span in spans)
                if text.strip():
                    result.append({"bbox": tuple(line["bbox"]), "text": text,
                                   "spans": spans})
        return result

    def fitz_words(page: Any) -> list[dict[str, Any]]:
        return [{"x0": float(word[0]), "y0": float(word[1]), "x1": float(word[2]),
                 "y1": float(word[3]), "text": str(word[4])}
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
        match = re.match(rf"^\s*{kind}\s+(\d+)\s*[:.\-]?\s*(.*)$", raw, re.IGNORECASE)
        if not match:
            return None
        return int(match.group(1)), clean_structure_text(f"{kind.title()} {match.group(1)}: {match.group(2)}", 1200)

    def caption_blocks(page: Any, kind: str) -> list[dict[str, Any]]:
        result = []
        for block in page.get_text("blocks", sort=False):
            if len(block) < 5:
                continue
            parsed = block_caption({"text": block[4]}, kind)
            if parsed:
                result.append({"number": parsed[0], "caption": parsed[1],
                               "bbox": tuple(block[:4])})
        return sorted(result, key=lambda item: item["bbox"][1])

    def numeric_token(text: str) -> bool:
        value = text.strip()
        if value in {"±", "+/-", "−"}:
            return False
        return bool(re.fullmatch(
            r"[+\-−]?(?:\d+(?:[.,]\d+)?(?:[eE][+\-]?\d+)?|Top[-–]\d+|\d+[x×]\d+)",
            value,
        ))

    def table_data_row(words: list[dict[str, Any]]) -> tuple[str, list[str], list[float]] | None:
        numeric_indices = [index for index, word in enumerate(words) if numeric_token(word["text"])]
        if len(numeric_indices) < 2:
            return None
        first = numeric_indices[0]
        label = clean_structure_text(" ".join(word["text"] for word in words[:first]), 500)
        raw_values = [(word["text"], word["x0"]) for word in words[first:]
                      if numeric_token(word["text"]) or word["text"] in {"±", "+/-", "−"}]
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

    def table_records(page: Any, page_number: int, next_ordinal: int) -> tuple[list[dict[str, Any]], int]:
        captions = caption_blocks(page, "Table")
        records: list[dict[str, Any]] = []
        page_width = float(page.rect.width)
        for caption_index, caption in enumerate(captions):
            x0, y0, x1, y1 = caption["bbox"]
            full_width = x1 - x0 >= page_width * 0.60
            region_x0 = 50.0 if full_width else max(0.0, x0 - 3.0)
            region_x1 = page_width - 50.0 if full_width else min(page_width, x1 + 3.0)
            stop_y = (captions[caption_index + 1]["bbox"][1]
                      if caption_index + 1 < len(captions) else float(page.rect.height))
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
        return records, next_ordinal

    def formula_records(pdf_document: Any, page_number: int, next_ordinal: int) -> tuple[list[dict[str, Any]], int]:
        page = pdf_document[page_number - 1]
        line_records = []
        for line in fitz_lines(page):
            spans = line["spans"]
            text = clean_formula_text(line["text"], 500)
            if len(text) < 3 or len(text) > 240 or "http" in text.lower():
                continue
            if not ("=" in text or re.search(r"[∑∫√≤≥≠∈→←↔‖]", text)):
                continue
            chars = max(1, sum(len(str(span.get("text", ""))) for span in spans))
            math_chars = sum(len(str(span.get("text", ""))) for span in spans
                             if str(span.get("font", "")).startswith(("CMMI", "CMSY", "CMR"))
                             or float(span.get("size", 10)) < 8)
            ratio = math_chars / chars
            prose_words = len(re.findall(r"\b[A-Za-z]{3,}\b", text))
            if ratio < 0.45 and not (ratio >= 0.28 and prose_words <= 4):
                continue
            if re.fullmatch(r"[A-Za-z](?:\s*\w)?\s*=\s*\d+[,.]?", text):
                continue
            line_records.append({**line, "text": text, "ratio": ratio})
        candidates: list[str] = []
        seen: set[str] = set()
        unused = set(range(len(line_records)))
        page_width = float(page.rect.width)
        while unused:
            root_index = min(unused, key=lambda index: (line_records[index]["bbox"][1],
                                                         line_records[index]["bbox"][0]))
            unused.remove(root_index)
            group = [root_index]
            changed = True
            while changed:
                changed = False
                current = [line_records[index] for index in group]
                min_y = min(item["bbox"][1] for item in current)
                max_y = max(item["bbox"][3] for item in current)
                min_x = min(item["bbox"][0] for item in current)
                max_x = max(item["bbox"][2] for item in current)
                column = 0 if (min_x + max_x) / 2 < page_width / 2 else 1
                for index in list(unused):
                    other = line_records[index]
                    ox0, oy0, ox1, oy1 = other["bbox"]
                    other_column = 0 if (ox0 + ox1) / 2 < page_width / 2 else 1
                    horizontal_gap = max(min_x - ox1, ox0 - max_x, 0)
                    if (other_column == column and oy0 <= max_y + 18 and oy1 >= min_y - 18
                            and horizontal_gap <= 90):
                        group.append(index)
                        unused.remove(index)
                        changed = True
                        min_y = min(min_y, oy0)
                        max_y = max(max_y, oy1)
                        min_x = min(min_x, ox0)
                        max_x = max(max_x, ox1)
            related = sorted((line_records[index] for index in group),
                             key=lambda value: (value["bbox"][1], value["bbox"][0]))
            value = clean_formula_text(" ".join(part["text"] for part in related), 1000)
            for marker in (" where ", " which ", " Since ", " This ", " The ", " denotes"):
                if marker in value:
                    value = value.split(marker, 1)[0].strip()
            if "," in value and len(re.findall(r"\b[A-Za-z]{3,}\b", value)) >= 3:
                value = value.split(",", 1)[0].strip()
            if re.match(r"^[A-Za-z](?:\s*=\s*\d+)?\s+", value) or value.endswith("="):
                continue
            if re.match(r"^(?:tions|ing|model|bars|cross|percentages)\b", value, re.IGNORECASE):
                continue
            if value and value not in seen:
                seen.add(value)
                candidates.append(value)
        records = [{"ordinal": next_ordinal + index, "page": page_number,
                    "tex": value, "sourceRef": f"pdf:formula:{next_ordinal + index}:page:{page_number}",
                    "recoveryStatus": "complete"}
                   for index, value in enumerate(candidates[:64])]
        return records, next_ordinal + len(records)

    def figure_records(pdf_document: Any) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        total_asset_bytes = 0
        for page_number, page in enumerate(pdf_document, 1):
            captions = caption_blocks(page, "Figure")
            if not captions:
                continue
            visual_blocks = page.get_text("dict").get("blocks", [])
            for caption_index, caption in enumerate(captions):
                x0, y0, x1, _ = caption["bbox"]
                previous_y = (captions[caption_index - 1]["bbox"][3] + 5
                              if caption_index else 50.0)
                full_width = x1 - x0 >= float(page.rect.width) * 0.60
                region_x0 = 50.0 if full_width else max(0.0, x0 - 3.0)
                region_x1 = float(page.rect.width) - 50.0 if full_width else min(float(page.rect.width), x1 + 3.0)
                all_drawings = []
                for drawing in page.get_drawings():
                    rect = drawing.get("rect")
                    if not rect or rect.width < 2 or rect.height < 2:
                        continue
                    # A few conference PDFs expose the figure's clipping
                    # path as a drawing that extends beyond the media box.
                    # It is a page-level mask, not figure content; accepting
                    # it makes the crop swallow the neighbouring text column.
                    if (rect.x0 < -1.0 or rect.y0 < -1.0
                            or rect.x1 > float(page.rect.width) + 1.0
                            or rect.y1 > float(page.rect.height) + 1.0):
                        continue
                    if rect.width > float(page.rect.width) * 0.80 and rect.height > float(page.rect.height) * 0.50:
                        continue
                    all_drawings.append(rect)
                wide_containers = [rect for rect in all_drawings
                                   if rect.width >= float(page.rect.width) * 0.55
                                   # Full-width figures in two-column conference
                                   # PDFs are often only 20–35% of a page tall;
                                   # requiring 35% misclassifies a four-panel
                                   # figure as the caption's narrow column.
                                   and rect.height >= float(page.rect.height) * 0.20
                                   and rect.y0 < y0 - 2 and rect.y1 >= previous_y]
                if wide_containers:
                    # Some conference PDFs place labels just outside the
                    # drawing's inner content box.  Expand to the actual
                    # wide figure container, not to the whole page (which
                    # could pull the neighbouring text column into the crop).
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
                if rects:
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
                        # Text labels such as "Lookup Embedding" and
                        # "Patch + Position Embedding" are not drawing/image
                        # blocks, so the union of visual primitives alone is
                        # too narrow.  The caption's column bounds are the
                        # safe horizontal envelope for those labels.
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
                ordinal = len(records) + 1
                records.append({"ordinal": ordinal, "page": page_number,
                                "caption": caption["caption"],
                                "sourceRef": f"pdf:figure:{ordinal}:page:{page_number}",
                                "recoveryStatus": "complete", "asset": asset})
        return records[:64]

    def extract_structures(pdf_bytes: bytes, pages: list[str]) -> dict[str, list[dict[str, Any]]]:
        try:
            pdf_document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
            tables: list[dict[str, Any]] = []
            formulas: list[dict[str, Any]] = []
            for page_number in range(pdf_document.page_count):
                page_tables, _ = table_records(pdf_document[page_number], page_number + 1, len(tables) + 1)
                tables.extend(page_tables)
                page_formulas, _ = formula_records(pdf_document, page_number + 1, len(formulas) + 1)
                formulas.extend(page_formulas)
            figures = figure_records(pdf_document)
            pdf_document.close()
            return {"tables": tables, "formulas": formulas, "figures": figures}
        except ConferenceExtractionError:
            raise
        except Exception:
            return {"tables": [], "formulas": [], "figures": []}

    def extract_visual_audit(pdf_bytes: bytes) -> dict[str, Any]:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
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
        # The current source-context contract requires every page range to be
        # non-empty and the ranges to exactly partition the flattened text.
        # A trailing separator also gives a genuinely blank PDF page a safe,
        # explicit range without inventing textual content for that page.
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
    """Match JavaScript JSON.stringify for the JSON values authored here."""
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
    except Exception:
        for _, fd in opened:
            try:
                os.close(fd)
            except OSError:
                pass
        for name, _ in opened:
            try:
                os.unlink(name, dir_fd=root_fd)
            except OSError:
                pass
        raise
    else:
        for _, fd in opened:
            os.close(fd)


def run_extraction(
    manifest_name: str,
    *,
    apply: bool,
    source_root: Path = DEFAULT_STAGING_SOURCE_DIR,
    backend: ExtractionBackend | None = None,
) -> dict[str, Any]:
    """Validate and optionally materialize one immutable extraction bundle."""
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
            raise _fail("metadata SHA-256 differs from the extraction request")
        _validate_metadata_identity(metadata, request)
        pdf_sha = sha256_bytes(pdf_bytes)
        if pdf_sha != request["source"]["pdf"]["sha256"]:
            raise _fail("PDF SHA-256 differs from the extraction request")
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
                extraction_error = ConferencePdfExtractionError("PDF backend returned an invalid page collection")
            elif not pages:
                extraction_error = ConferencePdfExtractionError("PDF contains no pages")
            else:
                pages = [_normalize_page_text(page) for page in pages]
                text_bytes, ranges = _page_ranges(pages)
                page_count = len(pages)
                non_whitespace = sum(1 for character in text_bytes.decode("utf-8") if not character.isspace())
                if len(text_bytes) > MAX_DERIVED_BYTES:
                    extraction_error = ConferencePdfExtractionError("extracted text exceeds the derived artifact limit")
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
                            structures = active_backend.extract_structures(pdf_bytes, pages)
                        short = non_whitespace < MINIMUM_TEXT_CHARACTERS
                        status = "blocked" if short else "ready"
                        blocked_reason = ({"code": "TEXT_TOO_SHORT", "message":
                            f"extracted non-whitespace text is below {MINIMUM_TEXT_CHARACTERS} characters"}
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
                            raise _fail("structured artifact exceeds the derived artifact limit")
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
    """Re-run the pinned structured extractor from the original PDF and compare every output byte."""
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
            raise _fail("replayed extraction is not ready")
        replayed_outputs = {
            key: (replay_root / name).read_bytes()
            for key, name in request["outputs"].items()
        }

    for key in request["outputs"]:
        if current_outputs[key] != replayed_outputs[key]:
            raise _fail(f"existing {key} differs from a fresh pinned extraction replay")
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
    """Replay a blocked extraction without promoting it to a staging-ready receipt."""
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
            raise _fail("replayed extraction is not blocked")
        produced = set(result["outputs"])
        if request["outputs"]["receiptFile"] not in produced:
            raise _fail("blocked extraction replay did not produce its receipt")
        replayed_outputs = {key: (replay_root / name).read_bytes()
            for key, name in request["outputs"].items() if name in produced}

    root_fd = _open_root(Path(source_root))
    try:
        if (_read_regular_single_link(root_fd, manifest_name, MAX_MANIFEST_BYTES, "current manifest") != manifest_bytes
                or _read_regular_single_link(root_fd, metadata_name, MAX_METADATA_BYTES, "current metadata") != metadata_bytes
                or _read_regular_single_link(root_fd, pdf_name, MAX_PDF_BYTES, "current PDF") != pdf_bytes):
            raise _fail("blocked extraction inputs changed during replay")
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
            raise _fail(f"existing blocked {key} differs from a fresh pinned extraction replay")
    receipt = _strict_json_object(replayed_outputs["receiptFile"], "replayed blocked receipt")
    _exact_object(receipt, ["contract", "version", "status", "textReplayable", "structuredReplayable",
        "paperId", "sourceIdentity", "request", "source", "extractor", "options", "pageCount", "text",
        "artifacts", "blockedReason", "receiptSha256"], "blocked extraction receipt")
    if (receipt["contract"] != RECEIPT_CONTRACT or receipt["version"] != CONTRACT_VERSION
            or receipt["status"] != "blocked" or receipt["textReplayable"] is not False
            or receipt["structuredReplayable"] is not False):
        raise _fail("blocked extraction receipt contract/status is invalid")
    reason = _exact_object(receipt["blockedReason"], ["code", "message"], "blockedReason")
    if reason["code"] not in {"TEXT_TOO_SHORT", "PDF_EXTRACTION_FAILED"}:
        raise _fail("blocked extraction reason code is unsupported")
    _plain_text(reason["message"], "blockedReason.message", 2000)
    receipt_body = dict(receipt)
    receipt_sha = _expected_sha(receipt_body.pop("receiptSha256"), "blocked receipt.receiptSha256")
    if receipt_sha != _stable_hash(receipt_body):
        raise _fail("blocked extraction receipt self-SHA drifted")
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

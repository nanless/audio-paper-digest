#!/usr/bin/env python3
"""Deterministic, text-only extraction for staged conference PDFs.

This module deliberately produces a weak structural profile.  Page text and
UTF-8 byte ranges are replayable, but formulas, tables, and images are always
declared unavailable.  It never uses the network or an LLM.
"""

from __future__ import annotations

import hashlib
import importlib
import io
import json
import os
import re
import stat
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
CONTRACT_VERSION = 2
EXTRACTOR_NAME = "audio-paper-digest-conference-text"
EXTRACTOR_VERSION = "1.0.0"
PROFILE = "weak-pdf-layout-v1"
OFFSET_UNIT = "utf8-byte"
MINIMUM_TEXT_CHARACTERS = 5000
PAGE_SEPARATOR = "\n\f\n"
NORMALIZATION = "unicode-nfc-lf-rstrip-v1"
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 16 * 1024 * 1024
MAX_PDF_BYTES = 256 * 1024 * 1024
MAX_DERIVED_BYTES = 64 * 1024 * 1024
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
        raise _fail("extraction options must exactly match the supported weak profile")
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
    value = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
    return "\n".join(line.rstrip() for line in value.split("\n")).strip("\n")


def load_pypdf_backend() -> ExtractionBackend:
    """Load the pinned backend lazily so validation can fail with a typed error."""
    try:
        pypdf = importlib.import_module("pypdf")
    except ImportError as exc:
        raise ConferenceExtractionDependencyError(
            "pypdf is required for conference PDF extraction; install requirements.txt"
        ) from exc
    version = str(getattr(pypdf, "__version__", "unknown"))

    def extract_pages(pdf_bytes: bytes) -> list[str]:
        try:
            reader = pypdf.PdfReader(io.BytesIO(pdf_bytes), strict=True)
            if getattr(reader, "is_encrypted", False):
                raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
            if len(reader.pages) > MAX_PAGES:
                raise ConferencePdfExtractionError(f"PDF page count exceeds {MAX_PAGES}")
            pages = []
            extracted_bytes = 0
            for page in reader.pages:
                text = _normalize_page_text(page.extract_text())
                extracted_bytes += len(text.encode("utf-8")) + len(PAGE_SEPARATOR.encode("utf-8"))
                if extracted_bytes > MAX_DERIVED_BYTES:
                    raise ConferencePdfExtractionError("extracted text exceeds the derived artifact limit")
                pages.append(text)
        except ConferencePdfExtractionError:
            raise
        except Exception as exc:  # pypdf exposes version-specific parse exceptions.
            raise ConferencePdfExtractionError(
                f"pypdf could not extract the PDF ({type(exc).__name__})"
            ) from exc
        if not pages:
            raise ConferencePdfExtractionError("PDF contains no pages")
        return pages

    return ExtractionBackend(name="pypdf", version=version, extract_pages=extract_pages)


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
        page_count: int | None = None
        non_whitespace: int | None = None
        status = "blocked"
        blocked_reason: dict[str, str] | None
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
                        "tables": [],
                        "formulas": [],
                        "figures": [],
                    }
                    artifact["payloadSha256"] = sha256_bytes(_compact_json_bytes(artifact))
                    artifact_bytes = _json_bytes(artifact)
                    if len(artifact_bytes) > MAX_DERIVED_BYTES:
                        raise _fail("structured artifact exceeds the derived artifact limit")
        if pages is None or extraction_error is not None and artifact_bytes is None:
            status = "blocked"
            blocked_reason = {
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
            "structuredReplayable": False,
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
            "structuredReplayable": False,
            "receiptSha256": receipt["receiptSha256"],
            "outputs": [name for name, _ in outputs_to_write] if apply else [],
        }
    finally:
        os.close(root_fd)


def verify_extraction(manifest_name: str, *, source_root: Path = DEFAULT_STAGING_SOURCE_DIR) -> dict[str, Any]:
    """Re-run the pinned extractor from the original PDF and compare every output byte."""
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

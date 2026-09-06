import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from conference_extractor import (  # noqa: E402
    ARTIFACT_CONTRACT,
    MINIMUM_TEXT_CHARACTERS,
    NORMALIZATION,
    OFFSET_UNIT,
    PAGE_SEPARATOR,
    RECEIPT_CONTRACT,
    REQUEST_CONTRACT,
    ConferenceExtractionDependencyError,
    ConferenceExtractionIntegrityError,
    load_pypdf_backend,
    run_extraction,
    sha256_bytes,
    verify_extraction,
)
from paper_identity import canonical_conference_paper_id  # noqa: E402
from path_config import CONFERENCE_STAGING_SOURCE_DIR  # noqa: E402


def build_pdf(page_lines):
    """Build a small valid Helvetica PDF without requiring a PDF authoring lib."""
    objects = {}
    page_ids = []
    next_id = 4
    for lines in page_lines:
        page_id = next_id
        content_id = next_id + 1
        next_id += 2
        page_ids.append(page_id)
        escaped = []
        for line in lines:
            safe = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            escaped.append(f"({safe}) Tj T*")
        stream = ("BT /F1 9 Tf 30 760 Td 10 TL " + " ".join(escaped) + " ET").encode("ascii")
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        ).encode("ascii")
        objects[content_id] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode("ascii")
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    payload = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0] * (max(objects) + 1)
    for object_id in sorted(objects):
        offsets[object_id] = len(payload)
        payload.extend(f"{object_id} 0 obj\n".encode("ascii"))
        payload.extend(objects[object_id])
        payload.extend(b"\nendobj\n")
    xref = len(payload)
    payload.extend(f"xref\n0 {len(offsets)}\n".encode("ascii"))
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        payload.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    payload.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(payload)


class ConferenceExtractorTest(unittest.TestCase):
    def test_default_source_root_uses_central_python_path_config(self):
        from conference_extractor import DEFAULT_STAGING_SOURCE_DIR

        self.assertEqual(DEFAULT_STAGING_SOURCE_DIR, CONFERENCE_STAGING_SOURCE_DIR)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.metadata = json.dumps({"conferenceId": "icassp-2026", "year": 2026,
            "identity": {"type": "icassp-arnumber", "value": "123"},
            "title": "Synthetic paper"}, separators=(",", ":")).encode()
        (self.root / "paper.json").write_bytes(self.metadata)

    def tearDown(self):
        self.temporary.cleanup()

    def write_request(self, pdf_bytes, *, name="extract.json", prefix="paper"):
        (self.root / "paper.pdf").write_bytes(pdf_bytes)
        request = {
            "contract": REQUEST_CONTRACT,
            "version": 2,
            "paperId": canonical_conference_paper_id(
                {"id": "icassp-2026", "year": 2026},
                {"type": "icassp-arnumber", "value": "123"}),
            "sourceIdentity": "icassp-arnumber:123",
            "source": {
                "metadata": {"file": "paper.json", "sha256": sha256_bytes(self.metadata),
                    "identityEvidence": {"conferenceIdPointer": "/conferenceId", "conferenceYearPointer": "/year",
                        "identityTypePointer": "/identity/type", "identityValuePointer": "/identity/value"},
                    "discoveryBinding": {"catalogSha256": "1" * 64,
                        "metadataSnapshotSha256": "2" * 64, "metadataIndex": 0,
                        "metadataRecordSha256": "3" * 64},
                    "provenance": {"kind": "official-metadata", "locator": "fixture:metadata",
                        "retrievedAt": "2026-09-06T00:00:00.000Z"}},
                "pdf": {"file": "paper.pdf", "sha256": sha256_bytes(pdf_bytes),
                    "provenance": {"kind": "official-pdf", "locator": "fixture:pdf",
                        "retrievedAt": "2026-09-06T00:00:00.000Z"}},
            },
            "outputs": {
                "textFile": f"{prefix}.txt",
                "artifactsFile": f"{prefix}.artifacts.json",
                "receiptFile": f"{prefix}.receipt.json",
            },
            "options": {
                "minimumTextCharacters": MINIMUM_TEXT_CHARACTERS,
                "normalization": NORMALIZATION,
                "pageSeparator": PAGE_SEPARATOR,
            },
        }
        (self.root / name).write_text(json.dumps(request), encoding="utf-8")
        return name, request

    def test_real_pypdf_extracts_pages_and_utf8_byte_offsets(self):
        page_one = [f"page-one-line-{index:03d}-" + "a" * 48 for index in range(65)]
        page_two = [f"page-two-line-{index:03d}-" + "b" * 48 for index in range(65)]
        manifest, request = self.write_request(build_pdf([page_one, page_two]))

        result = run_extraction(manifest, apply=True, source_root=self.root)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["pageCount"], 2)
        self.assertTrue(result["textReplayable"])
        text_bytes = (self.root / request["outputs"]["textFile"]).read_bytes()
        artifacts = json.loads((self.root / request["outputs"]["artifactsFile"]).read_text())
        receipt = json.loads((self.root / request["outputs"]["receiptFile"]).read_text())
        self.assertEqual(artifacts["contract"], ARTIFACT_CONTRACT)
        self.assertEqual(artifacts["profile"], "weak-pdf-layout-v1")
        self.assertEqual(len(artifacts["pages"]), 2)
        self.assertIn(PAGE_SEPARATOR.encode(), text_bytes)
        previous_end = 0
        for index, page in enumerate(artifacts["pages"], 1):
            self.assertEqual(page["page"], index)
            self.assertEqual(page["textStart"], previous_end)
            text_bytes[page["textStart"]:page["textEnd"]].decode("utf-8", errors="strict")
            previous_end = page["textEnd"]
        self.assertEqual(previous_end, len(text_bytes))
        self.assertIn(b"page-one-line-000", text_bytes)
        self.assertIn(b"page-two-line-064", text_bytes)
        self.assertEqual(receipt["contract"], RECEIPT_CONTRACT)
        self.assertEqual(receipt["source"]["pdf"]["sha256"], sha256_bytes((self.root / "paper.pdf").read_bytes()))
        self.assertEqual(receipt["text"]["sha256"], sha256_bytes(text_bytes))
        self.assertEqual(receipt["artifacts"]["sha256"], sha256_bytes((self.root / request["outputs"]["artifactsFile"]).read_bytes()))
        self.assertFalse(receipt["structuredReplayable"])
        self.assertEqual(artifacts["offsetUnit"], OFFSET_UNIT)
        self.assertEqual(artifacts["flattenedTextSha256"], sha256_bytes(text_bytes))
        self.assertEqual(artifacts["tables"], [])
        self.assertEqual(artifacts["formulas"], [])
        self.assertEqual(artifacts["figures"], [])
        payload_sha = artifacts.pop("payloadSha256")
        compact = json.dumps(artifacts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertEqual(payload_sha, sha256_bytes(compact))
        for name in result["outputs"]:
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o600)

    def test_dry_run_extracts_and_validates_without_writing(self):
        lines = ["dry-run-" + "x" * 64 for _ in range(80)]
        manifest, request = self.write_request(build_pdf([lines]))
        result = run_extraction(manifest, apply=False, source_root=self.root)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["outputs"], [])
        for name in request["outputs"].values():
            self.assertFalse((self.root / name).exists())

    def test_verify_reexecutes_pinned_extraction_and_rejects_derived_drift(self):
        lines = ["verify-" + "v" * 64 for _ in range(90)]
        manifest, request = self.write_request(build_pdf([lines]))
        run_extraction(manifest, apply=True, source_root=self.root)
        verified = verify_extraction(manifest, source_root=self.root)
        self.assertEqual(verified["status"], "verified")
        self.assertEqual(verified["paperId"], request["paperId"])
        (self.root / request["outputs"]["textFile"]).write_text("fabricated text", encoding="utf-8")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "fresh pinned extraction replay"):
            verify_extraction(manifest, source_root=self.root)

    def test_short_text_is_blocked_and_never_replayable(self):
        manifest, request = self.write_request(build_pdf([["too short"]]))
        result = run_extraction(manifest, apply=True, source_root=self.root)
        self.assertEqual(result["status"], "blocked")
        self.assertFalse(result["textReplayable"])
        receipt = json.loads((self.root / request["outputs"]["receiptFile"]).read_text())
        artifacts = json.loads((self.root / request["outputs"]["artifactsFile"]).read_text())
        self.assertEqual(receipt["blockedReason"]["code"], "TEXT_TOO_SHORT")
        self.assertFalse(receipt["textReplayable"])
        self.assertEqual(artifacts["profile"], "weak-pdf-layout-v1")

    def test_parse_failure_writes_only_a_blocked_receipt(self):
        manifest, request = self.write_request(b"%PDF-1.4\nnot a valid PDF\n%%EOF\n")
        result = run_extraction(manifest, apply=True, source_root=self.root)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["outputs"], [request["outputs"]["receiptFile"]])
        receipt = json.loads((self.root / request["outputs"]["receiptFile"]).read_text())
        self.assertEqual(receipt["blockedReason"]["code"], "PDF_EXTRACTION_FAILED")
        self.assertIsNone(receipt["text"])
        self.assertIsNone(receipt["artifacts"])

    def test_missing_backend_raises_a_typed_dependency_error_at_loader(self):
        with mock.patch("conference_extractor.importlib.import_module", side_effect=ImportError("missing")):
            with self.assertRaises(ConferenceExtractionDependencyError):
                load_pypdf_backend()

    def test_sha_drift_is_rejected_before_outputs(self):
        manifest, request = self.write_request(build_pdf([["content"]]))
        request["source"]["pdf"]["sha256"] = "0" * 64
        (self.root / manifest).write_text(json.dumps(request), encoding="utf-8")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "PDF SHA-256 differs"):
            run_extraction(manifest, apply=True, source_root=self.root)
        self.assertFalse((self.root / request["outputs"]["receiptFile"]).exists())

    def test_symlink_and_hardlink_inputs_are_rejected(self):
        pdf = build_pdf([["content"]])
        manifest, request = self.write_request(pdf)
        (self.root / "paper.pdf").unlink()
        (self.root / "actual.pdf").write_bytes(pdf)
        (self.root / "paper.pdf").symlink_to("actual.pdf")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "single-link"):
            run_extraction(manifest, apply=False, source_root=self.root)
        (self.root / "paper.pdf").unlink()
        os.link(self.root / "actual.pdf", self.root / "paper.pdf")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "single-link"):
            run_extraction(manifest, apply=False, source_root=self.root)

    def test_unsafe_paths_duplicate_json_and_existing_output_are_rejected(self):
        pdf = build_pdf([["content"]])
        manifest, request = self.write_request(pdf)
        request["source"]["pdf"]["file"] = "../paper.pdf"
        (self.root / manifest).write_text(json.dumps(request), encoding="utf-8")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "safe direct filename"):
            run_extraction(manifest, apply=False, source_root=self.root)

        manifest, request = self.write_request(pdf, name="second.json", prefix="second")
        (self.root / "second.txt").write_text("occupied")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "output already exists"):
            run_extraction(manifest, apply=True, source_root=self.root)

        duplicate = b'{"title":"one","title":"two"}'
        (self.root / "paper.json").write_bytes(duplicate)
        request["source"]["metadata"]["sha256"] = sha256_bytes(duplicate)
        (self.root / "third.json").write_text(json.dumps({**request, "outputs": {
            "textFile": "third.txt", "artifactsFile": "third.artifacts.json", "receiptFile": "third.receipt.json"
        }}), encoding="utf-8")
        with self.assertRaisesRegex(ConferenceExtractionIntegrityError, "without duplicate keys"):
            run_extraction("third.json", apply=False, source_root=self.root)


if __name__ == "__main__":
    unittest.main()

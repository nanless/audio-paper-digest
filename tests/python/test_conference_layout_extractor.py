import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import fitz

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import conference_extractor as legacy  # noqa: E402
import conference_layout_extractor as enhanced  # noqa: E402
import protocol_codec as protocols  # noqa: E402
from project_env_isolation import isolate_module_environment  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()

CLI_SPEC = importlib.util.spec_from_file_location("conference_extract_cli", ROOT / "scripts" / "conference-extract.py")
CLI = importlib.util.module_from_spec(CLI_SPEC)
CLI_SPEC.loader.exec_module(CLI)


def _build_pdf_with_table_and_figure() -> bytes:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text(
        (50, 52),
        "Neural Speech Codec with Streaming Quantization",
        fontsize=14,
    )
    page.insert_text(
        (50, 74),
        "Alice Chen1, Bob Wang2",
        fontsize=10,
    )
    page.insert_text(
        (50, 90),
        "1Speech Lab, Tsinghua University  2Audio Group, MIT",
        fontsize=9,
    )
    # Draw a booktabs-style table so v2 recovers structured table cells.
    page.insert_text((50, 120), "Table 1: Speech enhancement results on DNS Challenge.", fontsize=10)
    y_top, y_mid, y_bot = 132, 152, 200
    page.draw_line((50, y_top), (520, y_top), width=1.2)
    page.draw_line((50, y_mid), (520, y_mid), width=0.8)
    page.draw_line((50, y_bot), (520, y_bot), width=1.2)
    rows = [
        (145, ["Model", "WER", "PESQ", "SI-SDR"]),
        (168, ["Baseline", "8.4", "2.91", "14.2"]),
        (188, ["Proposed", "5.1", "3.42", "17.8"]),
    ]
    xs = [60, 210, 320, 430]
    for y, cols in rows:
        for x, val in zip(xs, cols):
            page.insert_text((x, y), val, fontsize=10)

    # Body text to comfortably clear the 5000 non-whitespace character gate.
    y_cursor = 230
    sentence = (
        "Acoustic speech tokenization models learn compact discrete representations "
        "that preserve prosody, speaker identity, and intelligibility across noisy channels. "
    )
    for page_index in range(2):
        target = page if page_index == 0 else doc.new_page(width=595, height=842)
        y = y_cursor if page_index == 0 else 60
        for line_idx in range(26):
            target.insert_text((50, y), f"Paragraph {page_index + 1}.{line_idx + 1}: {sentence}", fontsize=9)
            y += 22
    raw = doc.tobytes()
    doc.close()
    return raw


def _write_request_fixture(root: Path, *, paper_num: str = "701") -> tuple[str, dict]:
    pdf_bytes = _build_pdf_with_table_and_figure()
    metadata = {
        "conferenceId": "icassp-2026",
        "year": 2026,
        "identity": {"type": "icassp-arnumber", "value": paper_num},
        "title": "Neural Speech Codec with Streaming Quantization",
        "authors": [
            {"name": "Alice Chen", "affiliations": ["Speech Lab, Tsinghua University"]},
            {"name": "Bob Wang", "affiliations": ["Audio Group, MIT"]},
        ],
        "abstract": "Compact streaming neural speech codec.",
        "recordUrl": f"https://ieeexplore.ieee.org/document/{paper_num}",
        "pdfUrl": f"https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber={paper_num}",
    }
    metadata_bytes = (json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (root / f"paper-{paper_num}.metadata.json").write_bytes(metadata_bytes)
    (root / f"paper-{paper_num}.pdf").write_bytes(pdf_bytes)
    paper_id = f"conference:icassp:2026:icassp-arnumber:{paper_num}"
    request = {
        **protocols.record_header("conference-pdf-extraction-request", "conference-pdf-extraction-request"),
        "paperId": paper_id,
        "sourceIdentity": f"icassp-arnumber:{paper_num}",
        "source": {
            "metadata": {
                "file": f"paper-{paper_num}.metadata.json",
                "sha256": hashlib.sha256(metadata_bytes).hexdigest(),
                "identityEvidence": {
                    "conferenceIdPointer": "/conferenceId",
                    "conferenceYearPointer": "/year",
                    "identityTypePointer": "/identity/type",
                    "identityValuePointer": "/identity/value",
                },
                "discoveryBinding": {
                    "catalogSha256": "a" * 64,
                    "metadataSnapshotSha256": "b" * 64,
                    "metadataIndex": 0,
                    "metadataRecordSha256": hashlib.sha256(metadata_bytes).hexdigest(),
                },
                "provenance": {
                    "kind": "official-metadata",
                    "locator": f"https://ieeexplore.ieee.org/document/{paper_num}",
                    "retrievedAt": "2026-09-07T00:00:00.000Z",
                },
            },
            "pdf": {
                "file": f"paper-{paper_num}.pdf",
                "sha256": hashlib.sha256(pdf_bytes).hexdigest(),
                "provenance": {
                    "kind": "official-pdf",
                    "locator": f"https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber={paper_num}",
                    "retrievedAt": "2026-09-07T00:00:00.000Z",
                },
            },
        },
        "outputs": {
            "textFile": f"paper-{paper_num}.txt",
            "artifactsFile": f"paper-{paper_num}.artifacts.json",
            "receiptFile": f"paper-{paper_num}.receipt.json",
        },
        "options": {
            "minimumTextCharacters": 5000,
            "normalization": protocols.contract("conference-pdf-text-normalization"),
            "pageSeparator": "\n\f\n",
        },
    }
    manifest_name = f"paper-{paper_num}.request.json"
    (root / manifest_name).write_bytes((json.dumps(request, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return manifest_name, request


class ConferenceLayoutExtractorRoutingTest(unittest.TestCase):
    def test_legacy_extractor_remains_byte_frozen(self):
        legacy_bytes = (ROOT / "scripts" / "conference_extractor.py").read_bytes()
        self.assertEqual(
            hashlib.sha256(legacy_bytes).hexdigest(),
            "36254b211c07e4070c6b1ed805764ce04b2b63572907ab581d9b21b75f03406b",
        )

    def test_cli_routes_enhanced_and_auto_detects_legacy_and_enhanced_on_verify(self):
        with tempfile.TemporaryDirectory(prefix="conf-extract-enhanced-cli-") as tmp:
            root_enhanced = Path(tmp).resolve() / "enhanced"
            root_legacy = Path(tmp).resolve() / "legacy"
            root_enhanced.mkdir(mode=0o700)
            root_legacy.mkdir(mode=0o700)

            manifest_enh, req_enh = _write_request_fixture(root_enhanced, paper_num="701")
            out_enh = CLI.main(["--apply", "--extractor", "enhanced", "--manifest", manifest_enh, "--source-root", str(root_enhanced)])
            self.assertEqual(out_enh["contract"], enhanced.EXTRACTOR_ENHANCED_CONTRACT)
            self.assertEqual(out_enh["status"], "ready")
            receipt_enh = json.loads((root_enhanced / req_enh["outputs"]["receiptFile"]).read_text(encoding="utf-8"))
            self.assertEqual(receipt_enh["contract"], enhanced.RECEIPT_ENHANCED_CONTRACT)
            artifact_enh = json.loads((root_enhanced / req_enh["outputs"]["artifactsFile"]).read_text(encoding="utf-8"))
            self.assertEqual(artifact_enh["contract"], enhanced.ARTIFACT_ENHANCED_CONTRACT)
            self.assertEqual(artifact_enh["profile"], enhanced.ARTIFACT_ENHANCED_PROFILE)
            self.assertGreaterEqual(len(artifact_enh["tables"]), 1)

            # --verify without --extractor auto-detects enhanced from the receipt!
            verified_enh = CLI.main(["--verify", "--manifest", manifest_enh, "--source-root", str(root_enhanced)])
            self.assertEqual(verified_enh["contract"], enhanced.VERIFICATION_ENHANCED_CONTRACT)
            self.assertEqual(verified_enh["status"], "verified")

            # Explicit --extractor legacy (and v1 compat alias) produces legacy receipt and --verify auto-detects legacy!
            manifest_leg, req_leg = _write_request_fixture(root_legacy, paper_num="702")
            out_leg = CLI.main(["--apply", "--extractor", "legacy", "--manifest", manifest_leg, "--source-root", str(root_legacy)])
            self.assertEqual(out_leg["status"], "ready")
            receipt_leg = json.loads((root_legacy / req_leg["outputs"]["receiptFile"]).read_text(encoding="utf-8"))
            self.assertNotEqual(receipt_leg["contract"], enhanced.RECEIPT_ENHANCED_CONTRACT)
            verified_leg = CLI.main(["--verify", "--manifest", manifest_leg, "--source-root", str(root_legacy)])
            self.assertEqual(verified_leg["status"], "verified")
            self.assertNotEqual(verified_leg["contract"], enhanced.VERIFICATION_ENHANCED_CONTRACT)

    def test_enhanced_receipt_replays_cleanly_through_node_extraction_receipt_loader(self):
        with tempfile.TemporaryDirectory(prefix="conf-extract-enhanced-node-") as tmp:
            root = Path(tmp).resolve()
            manifest_name, req = _write_request_fixture(root, paper_num="703")
            out = CLI.main(["--apply", "--extractor", "v2", "--manifest", manifest_name, "--source-root", str(root)])
            self.assertEqual(out["status"], "ready")
            node_code = (
                "const api = require('./scripts/lib/conference-extraction-receipt.js');"
                "const h = api.loadExtractionHandle(process.argv[1], process.argv[2], { replay: true });"
                "const snap = api.extractionHandleSnapshot(h);"
                "console.log(JSON.stringify({ contract: snap.contract, profile: snap.profile, "
                "extractor: snap.text.provenance.extractor, verificationContract: snap.verification.contract }));"
            )
            proc = subprocess.run(
                ["node", "-e", node_code, str(root), req["outputs"]["receiptFile"]],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                check=True,
            )
            loaded = json.loads(proc.stdout.strip())
            self.assertEqual(loaded["contract"], enhanced.RECEIPT_ENHANCED_CONTRACT)
            self.assertEqual(loaded["profile"], enhanced.ARTIFACT_ENHANCED_PROFILE)
            self.assertEqual(loaded["extractor"], enhanced.EXTRACTOR_ENHANCED_NAME)
            self.assertEqual(loaded["verificationContract"], enhanced.VERIFICATION_ENHANCED_CONTRACT)

    def test_invalid_extractor_flag_fails_closed(self):
        with self.assertRaises(legacy.ConferenceExtractionError):
            CLI.main(["--apply", "--extractor", "v99", "--manifest", "paper.request.json"])


if __name__ == "__main__":
    unittest.main()

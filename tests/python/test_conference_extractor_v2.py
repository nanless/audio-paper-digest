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

import conference_extractor as v1  # noqa: E402
import conference_extractor_v2 as v2  # noqa: E402
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


class ConferenceExtractorV2RoutingTest(unittest.TestCase):
    def test_v1_extractor_remains_byte_frozen(self):
        v1_bytes = (ROOT / "scripts" / "conference_extractor.py").read_bytes()
        self.assertEqual(
            hashlib.sha256(v1_bytes).hexdigest(),
            "36254b211c07e4070c6b1ed805764ce04b2b63572907ab581d9b21b75f03406b",
        )

    def test_cli_routes_v2_and_auto_detects_v1_and_v2_on_verify(self):
        with tempfile.TemporaryDirectory(prefix="conf-extract-v2-cli-") as tmp:
            root_v2 = Path(tmp).resolve() / "v2"
            root_v1 = Path(tmp).resolve() / "v1"
            root_v2.mkdir(mode=0o700)
            root_v1.mkdir(mode=0o700)

            manifest_v2, req_v2 = _write_request_fixture(root_v2, paper_num="701")
            out_v2 = CLI.main(["--apply", "--extractor", "v2", "--manifest", manifest_v2, "--source-root", str(root_v2)])
            self.assertEqual(out_v2["contract"], v2.EXTRACTOR_V2_CONTRACT)
            self.assertEqual(out_v2["status"], "ready")
            receipt_v2 = json.loads((root_v2 / req_v2["outputs"]["receiptFile"]).read_text(encoding="utf-8"))
            self.assertEqual(receipt_v2["contract"], v2.RECEIPT_V2_CONTRACT)
            artifact_v2 = json.loads((root_v2 / req_v2["outputs"]["artifactsFile"]).read_text(encoding="utf-8"))
            self.assertEqual(artifact_v2["contract"], v2.ARTIFACT_V2_CONTRACT)
            self.assertEqual(artifact_v2["profile"], v2.ARTIFACT_V2_PROFILE)
            self.assertGreaterEqual(len(artifact_v2["tables"]), 1)

            # --verify without --extractor auto-detects v2 from the receipt!
            verified_v2 = CLI.main(["--verify", "--manifest", manifest_v2, "--source-root", str(root_v2)])
            self.assertEqual(verified_v2["contract"], v2.VERIFICATION_V2_CONTRACT)
            self.assertEqual(verified_v2["status"], "verified")

            # Explicit --extractor v1 produces v1 receipt and --verify auto-detects v1!
            manifest_v1, req_v1 = _write_request_fixture(root_v1, paper_num="702")
            out_v1 = CLI.main(["--apply", "--extractor", "v1", "--manifest", manifest_v1, "--source-root", str(root_v1)])
            self.assertEqual(out_v1["status"], "ready")
            receipt_v1 = json.loads((root_v1 / req_v1["outputs"]["receiptFile"]).read_text(encoding="utf-8"))
            self.assertNotEqual(receipt_v1["contract"], v2.RECEIPT_V2_CONTRACT)
            verified_v1 = CLI.main(["--verify", "--manifest", manifest_v1, "--source-root", str(root_v1)])
            self.assertEqual(verified_v1["status"], "verified")
            self.assertNotEqual(verified_v1["contract"], v2.VERIFICATION_V2_CONTRACT)

    def test_v2_receipt_replays_cleanly_through_node_extraction_receipt_loader(self):
        with tempfile.TemporaryDirectory(prefix="conf-extract-v2-node-") as tmp:
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
            self.assertEqual(loaded["contract"], v2.RECEIPT_V2_CONTRACT)
            self.assertEqual(loaded["profile"], v2.ARTIFACT_V2_PROFILE)
            self.assertEqual(loaded["extractor"], v2.EXTRACTOR_V2_NAME)
            self.assertEqual(loaded["verificationContract"], v2.VERIFICATION_V2_CONTRACT)

    def test_invalid_extractor_flag_fails_closed(self):
        with self.assertRaises(v1.ConferenceExtractionError):
            CLI.main(["--apply", "--extractor", "v99", "--manifest", "paper.request.json"])


if __name__ == "__main__":
    unittest.main()

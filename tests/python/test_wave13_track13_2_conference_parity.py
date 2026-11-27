import base64
import copy
import hashlib
import importlib.util
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests" / "python"))

import conference_extractor as v1_extractor  # noqa: E402
import conference_layout_extractor as layout_extractor  # noqa: E402
from paper_identity import canonical_conference_paper_id  # noqa: E402
import protocol_codec as protocols  # noqa: E402
from project_env_isolation import (  # noqa: E402
    isolate_module_environment,
    restore_environment_after,
)
from test_publish_to_blog import llm_api_publication_fixture  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()

_HIST_SPEC = importlib.util.spec_from_file_location(
    "historical_page_render_track13_2",
    str(ROOT / "scripts" / "historical-page-render.py"),
)
historical_renderer = importlib.util.module_from_spec(_HIST_SPEC)
_HIST_SPEC.loader.exec_module(historical_renderer)


def _build_two_column_conference_pdf() -> bytes:
    """用 PyMuPDF 构造带双栏正文、上标作者机构、矢量图、Booktabs 音频指标表与无框音频指标表的真实会议 PDF。"""
    doc = fitz.open()
    # Page 1: Title + Superscript Authors/Affiliations + 2-column body text + Vector Figure 1
    p1 = doc.new_page(width=612, height=792)
    p1.insert_text((72, 54), "Neural Streaming Speech Enhancement with Causal Conformer", fontsize=14, fontname="helv")
    # Superscript author row: Alice Zhang^1, Bob Li^2
    p1.insert_text((150, 82), "Alice Zhang", fontsize=10, fontname="helv")
    p1.insert_text((204, 78), "1", fontsize=6.5, fontname="helv")
    p1.insert_text((210, 82), ", Bob Li", fontsize=10, fontname="helv")
    p1.insert_text((246, 78), "2", fontsize=6.5, fontname="helv")
    # Superscript affiliation lines
    p1.insert_text((130, 102), "1", fontsize=6.5, fontname="helv")
    p1.insert_text((137, 106), "Department of Electronic Engineering, Tsinghua University, Beijing, China", fontsize=9, fontname="helv")
    p1.insert_text((130, 118), "2", fontsize=6.5, fontname="helv")
    p1.insert_text((137, 122), "Language Technologies Institute, Carnegie Mellon University, Pittsburgh, USA", fontsize=9, fontname="helv")
    p1.insert_text((210, 138), "alice@tsinghua.edu.cn, bob@cmu.edu", fontsize=8.5, fontname="helv")

    # Left column body (x=54..285, ~48 chars/line so bbox stays strictly in left half x1 <= 290)
    left_lines = [
        "Abstract",
        "LEFT_COL_LINE_01 Causal speech enhancement",
        "LEFT_COL_LINE_02 under low latency requires",
        "LEFT_COL_LINE_03 careful causal modeling.",
        "LEFT_COL_LINE_04 High PESQ, STOI and UTMOS",
        "1. Introduction",
        "LEFT_COL_LINE_05 Real-time audio pipelines",
        "LEFT_COL_LINE_06 demand sub-20ms lookahead.",
        "LEFT_COL_LINE_07 Neural speech enhancers",
        "LEFT_COL_LINE_08 improve perceptual quality.",
        "LEFT_COL_LINE_09 Unified causal benchmarks",
        "LEFT_COL_LINE_10 verify unseen reverberation.",
    ]
    y = 172
    for ln in left_lines:
        p1.insert_text((54, y), ln, fontsize=8.5, fontname="helv")
        y += 13

    # Right column body (x=325..560) — SAME y-range as left column to verify de-interleaving!
    right_lines = [
        "2. Proposed Architecture",
        "RIGHT_COL_LINE_01 Waveform sampled at 16 kHz",
        "RIGHT_COL_LINE_02 framed with 20ms windows.",
        "RIGHT_COL_LINE_03 Complex STFT encoder uses",
        "RIGHT_COL_LINE_04 257 bins and causal conv.",
        "RIGHT_COL_LINE_05 Residual VQ compresses",
        "RIGHT_COL_LINE_06 features down to 1.5 kbps.",
        "RIGHT_COL_LINE_07 Multi-resolution STFT and",
        "RIGHT_COL_LINE_08 GAN loss boost naturalness.",
        "RIGHT_COL_LINE_09 Real-time factor stays",
        "RIGHT_COL_LINE_10 below 0.08 on mobile CPU.",
        "RIGHT_COL_LINE_11 Code and demos released.",
    ]
    y = 172
    for ln in right_lines:
        p1.insert_text((325, y), ln, fontsize=8.5, fontname="helv")
        y += 13

    # Vector Figure 1 (full-width diagram in lower half of Page 1)
    shape = p1.new_shape()
    shape.draw_rect(fitz.Rect(90, 420, 520, 565))
    shape.finish(color=(0.1, 0.2, 0.5), fill=(0.94, 0.96, 1.0), width=1.5)
    shape.draw_rect(fitz.Rect(120, 455, 240, 525))
    shape.finish(color=(0.2, 0.4, 0.2), fill=(0.90, 0.98, 0.90), width=1.2)
    shape.draw_rect(fitz.Rect(340, 455, 480, 525))
    shape.finish(color=(0.6, 0.2, 0.2), fill=(1.0, 0.92, 0.92), width=1.2)
    shape.draw_line(fitz.Point(240, 490), fitz.Point(340, 490))
    shape.finish(color=(0, 0, 0), width=1.5)
    shape.commit()
    p1.insert_text((135, 493), "Causal STFT Enc", fontsize=9, fontname="helv")
    p1.insert_text((355, 493), "Conformer Dec", fontsize=9, fontname="helv")
    p1.insert_text(
        (90, 585),
        "Figure 1: Overall causal speech enhancement architecture with STFT encoder and conformer decoder.",
        fontsize=9,
        fontname="helv",
    )

    # Page 2: Booktabs Table 1 (with audio metrics) + Borderless Table 2 (with audio metrics) + padding text
    p2 = doc.new_page(width=612, height=792)
    p2.insert_text((72, 60), "Table 1: Speech enhancement comparison on DNS-2024 test set.", fontsize=9.5, fontname="helv")
    # Booktabs horizontal rules: toprule (72), midrule (94), bottomrule (156)
    tb = p2.new_shape()
    for ry in (72, 94, 156):
        tb.draw_line(fitz.Point(72, ry), fitz.Point(520, ry))
        tb.finish(color=(0, 0, 0), width=1.0)
    tb.commit()
    cols_x = [80, 210, 275, 340, 405, 470]
    t1_rows = [
        ["System", "UTMOS", "PESQ", "STOI", "SI-SDR", "RTF"],
        ["NoisyInput", "2.14", "1.52", "0.78", "4.20", "0.00"],
        ["DCCRN", "3.21", "2.74", "0.89", "14.10", "0.14"],
        ["CausalConf", "3.88", "3.32", "0.95", "18.60", "0.07"],
    ]
    row_ys = [87, 110, 128, 146]
    for ry, row in zip(row_ys, t1_rows):
        for cx, cell in zip(cols_x, row):
            p2.insert_text((cx, ry), cell, fontsize=9, fontname="helv")

    # Borderless Table 2 (no lines at all — relies on AUDIO_METRIC_WORDS!)
    p2.insert_text((72, 215), "Table 2: Zero-shot audio generation quality across codec backbones.", fontsize=9.5, fontname="helv")
    t2_rows = [
        ["Model", "FAD", "CLAP", "ViSQOL", "RTF"],
        ["AudioGen", "3.42", "0.31", "3.65", "0.42"],
        ["MusicLDM", "2.89", "0.36", "3.92", "0.31"],
        ["Ours", "1.74", "0.44", "4.38", "0.09"],
    ]
    t2_cols = [80, 220, 295, 370, 455]
    t2_ys = [238, 256, 274, 292]
    for ry, row in zip(t2_ys, t2_rows):
        for cx, cell in zip(t2_cols, row):
            p2.insert_text((cx, ry), cell, fontsize=9, fontname="helv")

    # Padding prose so non-whitespace chars >= 5000 for full run_extraction_enhanced test
    y = 350
    for idx in range(38):
        p2.insert_text(
            (54, y),
            f"Section 4.{idx:02d}: Detailed acoustic evaluation confirms consistent gains across reverberant rooms, babble noise, and multi-talker scenarios.",
            fontsize=8,
            fontname="helv",
        )
        y += 11

    raw = doc.tobytes()
    doc.close()
    return raw


class Wave13Track132ConferenceParityTests(unittest.TestCase):
    def test_v1_conference_extractor_remains_completely_untouched(self):
        v1_sha = hashlib.sha256((ROOT / "scripts" / "conference_extractor.py").read_bytes()).hexdigest()
        self.assertEqual(
            v1_sha,
            "36254b211c07e4070c6b1ed805764ce04b2b63572907ab581d9b21b75f03406b",
            "冻结的 v1 scripts/conference_extractor.py 字节不得被修改",
        )

    def test_v2_two_column_reading_order_fixes_interleaving(self):
        pdf_bytes = _build_two_column_conference_pdf()
        pages_v2 = layout_extractor.extract_pages_enhanced(pdf_bytes)
        self.assertEqual(len(pages_v2), 2)
        page1 = pages_v2[0]
        # Title must appear before left column; ALL left column lines must appear before right column!
        pos_title = page1.index("Neural Streaming Speech Enhancement")
        pos_left_first = page1.index("LEFT_COL_LINE_01")
        pos_left_last = page1.index("LEFT_COL_LINE_10")
        pos_right_first = page1.index("RIGHT_COL_LINE_01")
        pos_right_last = page1.index("RIGHT_COL_LINE_11")
        pos_fig_cap = page1.index("Figure 1:")
        self.assertLess(pos_title, pos_left_first)
        self.assertLess(pos_left_first, pos_left_last)
        self.assertLess(pos_left_last, pos_right_first)
        self.assertLess(pos_right_first, pos_right_last)
        self.assertLess(pos_right_last, pos_fig_cap)

        # Confirm v1 sort=True DOES interleave left and right lines on this exact same PDF
        v1_backend = v1_extractor.load_pypdf_backend()
        v1_page1 = v1_backend.extract_pages(pdf_bytes)[0]
        self.assertLess(v1_page1.index("RIGHT_COL_LINE_01"), v1_page1.index("LEFT_COL_LINE_10"))

    def test_v2_high_dpi_figures_and_booktabs_plus_audio_metric_tables(self):
        pdf_bytes = _build_two_column_conference_pdf()
        pdf_sha = layout_extractor.sha256_bytes(pdf_bytes)
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            figures = layout_extractor.extract_figures_enhanced(doc)
            tables = layout_extractor.extract_tables_enhanced(doc, pdf_sha)
        finally:
            doc.close()

        self.assertEqual(len(figures), 1)
        fig = figures[0]
        self.assertEqual(fig["ordinal"], 1)
        self.assertEqual(fig["page"], 1)
        self.assertIn("Figure 1:", fig["caption"])
        png = base64.b64decode(fig["asset"]["base64"])
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(hashlib.sha256(png).hexdigest(), fig["asset"]["sha256"])
        width, height = struct.unpack(">II", png[16:24])
        # Vector figure is ~430pt wide; at 288 DPI (4x) width >= 1500px (vs v1 1.6x ~688px)!
        self.assertGreaterEqual(width, 1400)
        self.assertLessEqual(max(width, height), layout_extractor.MAX_FIGURE_LONG_EDGE_PX)

        # Both Booktabs Table 1 (UTMOS/PESQ/STOI/SI-SDR/RTF) and Borderless Table 2 (FAD/CLAP/ViSQOL/RTF) recovered!
        self.assertEqual(len(tables), 2)
        self.assertIn("Table 1", tables[0]["caption"])
        self.assertIn("UTMOS", " ".join(tables[0]["cells"][0]))
        self.assertIn("SI-SDR", " ".join(tables[0]["cells"][0]))
        self.assertIn("3.88", " ".join(tables[0]["cells"][-1]))
        self.assertIn("Table 2", tables[1]["caption"])
        self.assertIn("FAD", " ".join(tables[1]["cells"][0]))
        self.assertIn("ViSQOL", " ".join(tables[1]["cells"][0]))
        self.assertIn("4.38", " ".join(tables[1]["cells"][-1]))

    def test_v2_extracts_page1_authors_and_preserves_official_metadata_affiliations(self):
        pdf_bytes = _build_two_column_conference_pdf()
        meta = {
            "conferenceId": "interspeech-2026",
            "year": 2026,
            "identity": {"type": "isca-paper-id", "value": "zhang26_interspeech"},
            "title": "Neural Streaming Speech Enhancement with Causal Conformer",
            "authors": ["Alice Zhang", "Bob Li"],
            "authorAffiliations": {
                "Alice Zhang": ["Tsinghua University", "N/A"],
                "Bob Li": ["Carnegie Mellon University", "Carnegie Mellon University"],
            },
        }
        meta_bytes = json.dumps(meta, ensure_ascii=False).encode("utf-8")
        meta_sha = layout_extractor.sha256_bytes(meta_bytes)

        extracted = layout_extractor.extract_conference_authors_enhanced(pdf_bytes, meta, meta_sha)
        pdf_auth = extracted["pdfPage1Authors"]
        self.assertIsNotNone(pdf_auth)
        self.assertEqual(pdf_auth["contract"], "pdf-page1-author-evidence-v2")
        self.assertEqual(len(pdf_auth["authors"]), 2)
        self.assertIn("Tsinghua University", pdf_auth["authors"][0]["affiliations"][0])
        self.assertIn("Carnegie Mellon University", pdf_auth["authors"][1]["affiliations"][0])

        meta_auth = extracted["officialMetadataAuthors"]
        self.assertIsNotNone(meta_auth)
        self.assertEqual(meta_auth["contract"], layout_extractor.OFFICIAL_METADATA_AUTHOR_CONTRACT)
        self.assertEqual(meta_auth["metadataSha256"], meta_sha)
        self.assertEqual(meta_auth["authors"], [
            {"name": "Alice Zhang", "affiliations": ["Tsinghua University"]},
            {"name": "Bob Li", "affiliations": ["Carnegie Mellon University"]},
        ])

        # Also test object-form authors (OpenReview / IEEE) and parallel affiliations array
        obj_meta = {
            "authors": [
                {"name": "Carol Wu", "affiliations": ["MIT"]},
                {"name": "Dave Park", "institution": "KAIST"},
            ]
        }
        obj_auth = layout_extractor.extract_official_metadata_authors(obj_meta, "a" * 64)
        self.assertEqual(obj_auth["authors"], [
            {"name": "Carol Wu", "affiliations": ["MIT"]},
            {"name": "Dave Park", "affiliations": ["KAIST"]},
        ])

        parallel_meta = {
            "authors": ["Eva Chen", "Frank Liu"],
            "affiliations": ["EPFL", ["ETH Zurich", "Unknown"]],
        }
        par_auth = layout_extractor.extract_official_metadata_authors(parallel_meta, "b" * 64)
        self.assertEqual(par_auth["authors"], [
            {"name": "Eva Chen", "affiliations": ["EPFL"]},
            {"name": "Frank Liu", "affiliations": ["ETH Zurich"]},
        ])

    def test_v2_run_and_verify_replay_and_reject_drift(self):
        pdf_bytes = _build_two_column_conference_pdf()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            metadata = {
                "conferenceId": "interspeech-2026",
                "year": 2026,
                "identity": {"type": "conference-paper-id", "value": "zhang26_interspeech"},
                "title": "Neural Streaming Speech Enhancement with Causal Conformer",
                "authors": ["Alice Zhang", "Bob Li"],
                "authorAffiliations": {
                    "Alice Zhang": ["Tsinghua University"],
                    "Bob Li": ["Carnegie Mellon University"],
                },
            }
            meta_bytes = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
            (root / "paper.json").write_bytes(meta_bytes)
            (root / "paper.pdf").write_bytes(pdf_bytes)
            request = {
                **protocols.record_header(v1_extractor.REQUEST_CONTRACT, "conference-pdf-extraction-request"),
                "paperId": canonical_conference_paper_id(
                    {"id": "interspeech-2026", "year": 2026},
                    {"type": "conference-paper-id", "value": "zhang26_interspeech"},
                ),
                "sourceIdentity": "conference-paper-id:zhang26_interspeech",
                "source": {
                    "metadata": {
                        "file": "paper.json",
                        "sha256": layout_extractor.sha256_bytes(meta_bytes),
                        "identityEvidence": {
                            "conferenceIdPointer": "/conferenceId",
                            "conferenceYearPointer": "/year",
                            "identityTypePointer": "/identity/type",
                            "identityValuePointer": "/identity/value",
                        },
                        "discoveryBinding": {
                            "catalogSha256": "1" * 64,
                            "metadataSnapshotSha256": "2" * 64,
                            "metadataIndex": 0,
                            "metadataRecordSha256": "3" * 64,
                        },
                        "provenance": {
                            "kind": "official-metadata",
                            "locator": "https://www.isca-archive.org/interspeech_2026/zhang26_interspeech.html",
                            "retrievedAt": "2026-09-06T00:00:00.000Z",
                        },
                    },
                    "pdf": {
                        "file": "paper.pdf",
                        "sha256": layout_extractor.sha256_bytes(pdf_bytes),
                        "provenance": {
                            "kind": "official-pdf",
                            "locator": "https://www.isca-archive.org/interspeech_2026/zhang26_interspeech.pdf",
                            "retrievedAt": "2026-09-06T00:00:00.000Z",
                        },
                    },
                },
                "outputs": {
                    "textFile": "paper-v2.txt",
                    "artifactsFile": "paper-v2.artifacts.json",
                    "receiptFile": "paper-v2.receipt.json",
                },
                "options": {
                    "minimumTextCharacters": 3000,
                    "normalization": v1_extractor.NORMALIZATION,
                    "pageSeparator": v1_extractor.PAGE_SEPARATOR,
                },
            }
            (root / "extract-v2.json").write_text(json.dumps(request), encoding="utf-8")

            res = layout_extractor.run_extraction_enhanced("extract-v2.json", apply=True, source_root=root)
            self.assertEqual(res["status"], "ready")
            self.assertEqual(res["contract"], layout_extractor.EXTRACTOR_ENHANCED_CONTRACT)
            artifacts = json.loads((root / "paper-v2.artifacts.json").read_text(encoding="utf-8"))
            self.assertEqual(artifacts["contract"], layout_extractor.ARTIFACT_ENHANCED_CONTRACT)
            self.assertEqual(artifacts["extractorProfile"]["figureTargetDpi"], 288)
            self.assertEqual(len(artifacts["figures"]), 1)
            self.assertEqual(len(artifacts["tables"]), 2)
            self.assertIsNotNone(artifacts["authorEvidence"]["pdfPage1Authors"])
            self.assertIsNotNone(artifacts["authorEvidence"]["officialMetadataAuthors"])

            verified = layout_extractor.verify_extraction_enhanced("extract-v2.json", source_root=root)
            self.assertEqual(verified["status"], "verified")
            self.assertEqual(verified["contract"], layout_extractor.VERIFICATION_ENHANCED_CONTRACT)

            # Tampering with derived text must fail byte-for-byte replay
            (root / "paper-v2.txt").write_text("tampered", encoding="utf-8")
            with self.assertRaisesRegex(v1_extractor.ConferenceExtractionIntegrityError, "fresh pinned enhanced extraction replay"):
                layout_extractor.verify_extraction_enhanced("extract-v2.json", source_root=root)

    def test_historical_direct_conference_renders_v5_implementation_specs_and_audio_signal_specs(self):
        restore_environment_after(self)
        from test_reader_structured_pipeline import build_structured_v5_publication_paper, reseal_v5
        paper = build_structured_v5_publication_paper()
        paper.pop("arxivId", None)
        paper["directPaperId"] = "conference:interspeech:2026:conference-paper-id:zhang26_interspeech"
        paper["analysis"] += (
            "\n\n## 标签\n#语音增强 #Transformer #低资源\n"
            "主任务标签: #语音增强\n主方法标签: #Transformer\n补充标签: #低资源"
        )
        paper["apiReaderPlan"]["implementationSpecs"]["audioSignalSpecs"] = (
            "16 kHz 采样率、20 ms 帧长 / 10 ms 帧移、严格因果 20 ms 前瞻、RTF 0.07。"
        )
        reseal_v5(paper)
        paper["analysisManifest"]["stages"]["scoringAudit"]["outputAnalysisSha256"] = (
            hashlib.sha256(paper["analysis"].encode()).hexdigest()
        )

        result = historical_renderer.render_packet({
            "directStaging": True,
            "paper": copy.deepcopy(paper),
            "cohortDate": "2026-10-15",
        })
        md = result["markdown"]
        self.assertIn("## ⚙️ 关键实现与复现规格", md)
        self.assertIn("**音频信号与流式规格**：16 kHz 采样率", md)
        self.assertIn("**训练与评测数据**：", md)
        self.assertIn("**开源产物与协议状态**：", md)
        # Specs section must appear after 深度解读 and before back-link
        self.assertLess(md.index("## 🧭 深度解读"), md.index("## ⚙️ 关键实现与复现规格"))
        self.assertLess(md.index("## ⚙️ 关键实现与复现规格"), md.index("[← 返回 2026-10-15"))

        # Verify legacy non-v5 direct conference pages stay completely untouched (no specs heading)
        legacy_paper = llm_api_publication_fixture()
        legacy_paper.pop("arxivId", None)
        legacy_paper["directPaperId"] = "conference:interspeech:2026:conference-paper-id:legacy26"
        legacy_paper["analysis"] += (
            "\n\n## 标签\n#语音增强 #Transformer #低资源\n"
            "主任务标签: #语音增强\n主方法标签: #Transformer\n补充标签: #低资源"
        )
        legacy_paper["analysisManifest"]["stages"]["scoringAudit"]["outputAnalysisSha256"] = (
            hashlib.sha256(legacy_paper["analysis"].encode()).hexdigest()
        )
        legacy_res = historical_renderer.render_packet({
            "directStaging": True,
            "paper": copy.deepcopy(legacy_paper),
            "cohortDate": "2026-10-15",
        })
        self.assertNotIn("## ⚙️ 关键实现与复现规格", legacy_res["markdown"])

    def test_r1_publish_validator_accepts_conference_v3_and_rejects_arxiv_official_metadata(self):
        restore_environment_after(self)
        publisher = historical_renderer.load_publish_to_blog()
        paper = llm_api_publication_fixture()
        paper.pop("arxivId", None)
        paper["directPaperId"] = "conference:interspeech:2026:conference-paper-id:v3meta26"
        paper["authors"] = [a["name"] for a in paper["apiReaderAuthors"]["authors"]]
        source_sha = paper["sourceSha256"]
        meta_sha = publisher._reader_record_sha256(paper["authors"], "API reader 作者元数据")
        dom_sha = "e" * 64
        identity_header = publisher.reader_formats.identity_header(
            paper["apiReaderAuthors"]["identity"], "authors"
        )
        v3_identity = {
            **identity_header,
            "conferencePdfAuthorParser": "conference-pdf-author-pdf-page1",
            "sourceDomSha256": dom_sha,
            "sourceTextSha256": source_sha,
            "metadataSha256": meta_sha,
            "authors": [
                {
                    "name": paper["authors"][0],
                    "affiliations": ["Tsinghua University"],
                    "nameBinding": {
                        "sourceKind": "official_metadata",
                        "sourceValue": paper["authors"][0],
                        "sourceDomSha256": dom_sha,
                    },
                    "affiliationBindings": [
                        {
                            "sourceKind": "official_metadata",
                            "association": "direct_author",
                            "sourceValue": "Tsinghua University",
                            "sourceDomSha256": dom_sha,
                        }
                    ],
                }
            ],
        }
        v3_identity_sha = publisher._reader_record_sha256(v3_identity, "API reader 作者来源记录")
        paper["apiReaderAuthors"] = {
            "authors": [{"name": paper["authors"][0], "affiliations": ["Tsinghua University"]}],
            "sourceDomSha256": dom_sha,
            "identity": v3_identity,
            "identitySha256": v3_identity_sha,
        }
        paper["analysisManifest"]["stages"]["apiReaderArticle"]["readerAuthorIdentitySha256"] = v3_identity_sha
        paper["analysisManifest"]["stages"]["apiReaderArticle"]["readerAuthorsSha256"] = (
            publisher._reader_record_sha256(paper["apiReaderAuthors"], "API reader 作者记录")
        )

        # Conference v3 official_metadata MUST be accepted cleanly
        publisher._validate_api_reader_author_identity(paper)

        # arXiv paper claiming official_metadata or conferencePdfAuthorParser MUST be rejected fail-closed!
        arxiv_spoof = copy.deepcopy(paper)
        arxiv_spoof["arxivId"] = "2611.99999"
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher._validate_api_reader_author_identity(arxiv_spoof)

        # Conference v2 parser claiming official_metadata MUST be rejected fail-closed!
        v2_spoof = copy.deepcopy(paper)
        v2_spoof["apiReaderAuthors"]["identity"]["conferencePdfAuthorParser"] = "conference-pdf-author-lines-v2"
        v2_sha = publisher._reader_record_sha256(v2_spoof["apiReaderAuthors"]["identity"], "v2")
        v2_spoof["apiReaderAuthors"]["identitySha256"] = v2_sha
        v2_spoof["analysisManifest"]["stages"]["apiReaderArticle"]["readerAuthorIdentitySha256"] = v2_sha
        v2_spoof["analysisManifest"]["stages"]["apiReaderArticle"]["readerAuthorsSha256"] = (
            publisher._reader_record_sha256(v2_spoof["apiReaderAuthors"], "v2 authors")
        )
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher._validate_api_reader_author_identity(v2_spoof)

    def test_r1_v2_extractor_rejects_prose_table_hallucination_and_malformed_authors(self):
        # 1. Borderless fallback must NOT hallucinate prose containing "is"/"score"/"mean"/"loss" as a table
        doc = fitz.open()
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 100), "Table 1: Summary of speech enhancement behavior.", fontsize=9, fontname="helv")
        page.insert_text((72, 120), "This model is achieving high score and low loss overall across mean conditions.", fontsize=9, fontname="helv")
        page.insert_text((72, 136), "In 2024 the baseline achieved 12.5 and 0.85 on reverberant benchmarks.", fontsize=9, fontname="helv")
        page.insert_text((72, 152), "In 2025 the proposed method reached 15.2 and 0.91 on clean subsets.", fontsize=9, fontname="helv")
        pdf_bytes = doc.tobytes()
        doc.close()
        with fitz.open(stream=pdf_bytes, filetype="pdf") as opened:
            tables = layout_extractor.extract_tables_enhanced(opened, layout_extractor.sha256_bytes(pdf_bytes))
        self.assertEqual(tables, [])

        # 2. Malformed non-dict author entries must not crash and dependencySha256s covers all 4 modules
        malformed = {"authors": [123, ["bad"], "Alice Zhang"], "authorAffiliations": {"Alice Zhang": ["MIT"]}}
        extracted = layout_extractor.extract_official_metadata_authors(malformed, "f" * 64)
        self.assertIsNotNone(extracted)
        self.assertEqual(extracted["authors"], [{"name": "Alice Zhang", "affiliations": ["MIT"]}])
        deps = layout_extractor.extractor_enhanced_dependency_sha256s()
        self.assertEqual(
            set(deps.keys()),
            {
                "conference_layout_extractor.py",
                "conference_extractor.py",
                "pdf_figure_table_extract.py",
                "pdf_author_extract.py",
            },
        )

        # 3. R2 P2-1: Short centered 2-column caption above borderless left-column table must NOT clip right columns
        doc2 = fitz.open()
        p2 = doc2.new_page(width=612, height=792)
        p2.insert_text((115, 90), "Table 1: WER.", fontsize=9, fontname="helv")
        p2.insert_text((45, 110), "Model", fontsize=8.5, fontname="helv")
        p2.insert_text((130, 110), "WER", fontsize=8.5, fontname="helv")
        p2.insert_text((205, 110), "PESQ", fontsize=8.5, fontname="helv")
        p2.insert_text((260, 110), "STOI", fontsize=8.5, fontname="helv")
        p2.insert_text((45, 126), "Baseline", fontsize=8.5, fontname="helv")
        p2.insert_text((130, 126), "9.8", fontsize=8.5, fontname="helv")
        p2.insert_text((205, 126), "3.10", fontsize=8.5, fontname="helv")
        p2.insert_text((260, 126), "0.91", fontsize=8.5, fontname="helv")
        p2.insert_text((45, 142), "Ours", fontsize=8.5, fontname="helv")
        p2.insert_text((130, 142), "7.4", fontsize=8.5, fontname="helv")
        p2.insert_text((205, 142), "3.62", fontsize=8.5, fontname="helv")
        p2.insert_text((260, 142), "0.95", fontsize=8.5, fontname="helv")
        # Add right column prose so page is genuinely 2-column
        p2.insert_text((340, 90), "Right column speech enhancement discussion text.", fontsize=8.5, fontname="helv")
        p2.insert_text((340, 106), "Evaluating causal streaming models across scenes.", fontsize=8.5, fontname="helv")
        pdf2 = doc2.tobytes()
        doc2.close()
        with fitz.open(stream=pdf2, filetype="pdf") as opened2:
            t2 = layout_extractor.extract_tables_enhanced(opened2, layout_extractor.sha256_bytes(pdf2))
        self.assertEqual(len(t2), 1)
        self.assertIn("STOI", " ".join(t2[0]["cells"][0]))
        self.assertIn("0.95", " ".join(t2[0]["cells"][-1]))

        # 4. R2 P2-2: 300-char truncation trims trailing space identically to JS
        long_aff = ("A" * 299) + " University"
        self.assertEqual(layout_extractor._clean_structure_text(long_aff, 300), "A" * 299)


if __name__ == "__main__":
    unittest.main()

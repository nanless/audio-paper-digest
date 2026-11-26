#!/usr/bin/env python3
"""会议 PDF 增强型确定性本地布局抽取器。

与冻结的旧版抽取器 `scripts/conference_extractor.py` 保持完全隔离：
- `conference_extractor.py` 及其历史冷重放 SHA 锚点零修改，旧版 `verify_extraction` 原样保留；
- 本模块面向新会议批次提供与日更齐平的版面与证据能力：
  1. 双栏感知文本重排（解决 IEEE/ISCA/ICASSP/Interspeech `sort=True` 左右栏交错）；
  2. 288 DPI 高清自适应插图裁切（兼容图注在图下或图上、跨栏图、旋转页与 2 MiB/24 MiB 体积上限）；
  3. Booktabs 横线表 + 严格网格表 + 旋转 `sidewaystable` + 跨页 `Table N (continued)` 拼接 + 音频/语音/音乐专业指标词典无框表回退；
  4. 接入 `pdf_author_extract.py` 首页几何作者机构抽取，并保留 OpenReview / IEEE / ISCA / ACL / NeurIPS 官方元数据中的原始机构信息；
  5. 完整继承旧版的 `O_NOFOLLOW`/`O_EXCL` 安全文件读取、严格防重键 JSON 解析、原页视觉审计与逐字节 `verify_extraction_enhanced` 重放核验。
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib
import io
import json
import math
import os
import re
import stat
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any

from conference_extractor import (
    ConferenceExtractionDependencyError,
    ConferenceExtractionError,
    ConferenceExtractionIntegrityError,
    ConferencePdfExtractionError,
    DEFAULT_STAGING_SOURCE_DIR,
    MAX_DERIVED_BYTES,
    MAX_FIGURE_ASSET_BYTES,
    MAX_FORMULA_IMAGES,
    MAX_FORMULA_IMAGE_BYTES,
    MAX_MANIFEST_BYTES,
    MAX_METADATA_BYTES,
    MAX_PAGES,
    MAX_PDF_BYTES,
    MAX_TOTAL_FIGURE_ASSET_BYTES,
    MAX_TOTAL_FORMULA_IMAGE_BYTES,
    OFFSET_UNIT,
    PAGE_SEPARATOR,
    SAFE_JSON_NAME,
    SAFE_PDF_NAME,
    SAFE_TEXT_NAME,
    VISUAL_RENDER_DPI,
    _build_receipt,
    _build_visual_audit,
    _compact_json_bytes,
    _expected_sha,
    _fail,
    _formula_layout_candidates,
    _header_for_request,
    _json_bytes,
    _json_safe_deep,
    _normalize_page_text,
    _open_root,
    _page_ranges,
    _quiet_pymupdf_output,
    _read_regular_single_link,
    _reserve_and_write,
    _safe_name,
    _stable_hash,
    _strict_json_object,
    _validate_metadata_identity,
    sha256_bytes,
    validate_request,
)
from git_file_bytes import read_regular_bytes
import pdf_author_extract
import pdf_figure_table_extract


EXTRACTOR_ENHANCED_NAME = "audio-paper-digest-conference-structured-enhanced"
EXTRACTOR_ENHANCED_CONTRACT = "conference-pdf-extraction-enhanced"
ARTIFACT_ENHANCED_CONTRACT = "conference-structured-artifacts-enhanced"
ARTIFACT_ENHANCED_PROFILE = "conference-pdf-replayable-layout-enhanced"
RECEIPT_ENHANCED_CONTRACT = "conference-pdf-extraction-receipt-enhanced"
VERIFICATION_ENHANCED_CONTRACT = "conference-pdf-extraction-verification-enhanced"
OFFICIAL_METADATA_AUTHOR_CONTRACT = "conference-official-metadata-author-evidence-v1"

FIGURE_TARGET_DPI = 288
FIGURE_SCALE_LADDER: tuple[float, ...] = (4.0, 3.0, 2.0, 1.6, 1.3, 1.0, 0.8, 0.6)
MAX_FIGURE_LONG_EDGE_PX = 2400
MAX_FIGURE_PIXELS = 12_000_000
MAX_FIGURES_ENHANCED = 64
MAX_TABLES_ENHANCED = 64

# 覆盖 ASR / 说话人 / 语音增强与分离 / TTS 与音质 / 音频编解码 / 音乐与通用音频生成 / 效率与通用 ML 指标。
# 避免将常见英文正文单词（如 is/map/mean/score/loss/change/avg/overall）纳入小写匹配。
AUDIO_METRIC_WORDS: frozenset[str] = frozenset({
    # ASR / Translation / Diarization
    "wer", "cer", "mer", "wil", "wip", "der", "jer", "ser", "per", "ter", "uem",
    "bleu", "chrf", "comet", "meteor", "rouge", "sacrebleu",
    # Speech quality / intelligibility / enhancement / separation
    "mos", "cmos", "smos", "nmos", "pmos", "qmos", "dmos", "utmos", "dnsmos",
    "wvmos", "wv-mos", "nisqa", "pesq", "wb-pesq", "nb-pesq", "stoi", "estoi",
    "visqol", "polqa", "sdr", "si-sdr", "sisdr", "si-snr", "sisnr",
    "si-sdri", "sisdri", "sdri", "snri", "snr", "sar", "sir", "lsd", "mcd",
    "rmse", "vuv", "gpe", "ffe", "csig", "cbak", "covl", "p808",
    # Speaker / Spoofing / Verification
    "eer", "dcf", "min-dcf", "mindcf", "cllr", "asv", "cos-sim", "spk-sim", "secos", "secs",
    # Audio / Music generation / Codec / SSL
    "fad", "kld", "kld-pa", "clap", "clap-score", "mel-l1", "stft",
    "bitrate", "kbps", "bps", "khz", "frame-rate", "tok/s", "rvq", "codebook",
    # Latency / Efficiency / General ML
    "rtf", "rtfx", "ttfa", "ttft", "latency", "params", "flops", "macs", "gmacs", "fps",
    "throughput", "acc", "accuracy", "precision", "recall", "auc", "auroc", "auprc",
    "mrr", "ndcg", "r@1", "r@5", "r@10", "top-1", "top-5", "psnr", "ssim",
})

# 短缩写仅在原文全大写（或 F0/F1）时视作指标表头，防止将普通英文正文里的 "is"/"map"/"sig" 误判为表头。
AUDIO_METRIC_UPPER_ACRONYMS: frozenset[str] = frozenset({
    "IS", "FD", "KL", "F0", "F1", "MAP", "SIG", "BAK", "OVL", "SIM", "HZ",
})

_EXTRACTOR_ENHANCED_DEPENDENCY_FILES: tuple[str, ...] = (
    "conference_layout_extractor.py",
    "conference_extractor.py",
    "pdf_figure_table_extract.py",
    "pdf_author_extract.py",
)

_PLACEHOLDER_AFFILIATION_RE = re.compile(
    r"^(?:n/?a|none|null|unknown|anonymous|unspecified|[-–—_.]+)$",
    re.IGNORECASE,
)


def extractor_enhanced_dependency_sha256s() -> dict[str, str]:
    base = Path(__file__).absolute().parent
    return {
        name: sha256_bytes(read_regular_bytes(base / name))
        for name in _EXTRACTOR_ENHANCED_DEPENDENCY_FILES
    }


def extractor_enhanced_implementation_sha256() -> str:
    return _stable_hash(extractor_enhanced_dependency_sha256s())


def _clean_structure_text(value: str, maximum: int = 4000) -> str:
    value = _normalize_page_text(value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    return re.sub(r"\s+", " ", value).strip()[:maximum].strip()


def _normalize_metric_token(token: str) -> str:
    cleaned = token.strip().lower()
    cleaned = re.sub(r"^[(\[{«\"'`]+|[)\]}»\"'`,;:.↑↓*%]+$", "", cleaned)
    return cleaned


def _is_audio_metric_token(token: str) -> bool:
    raw_stripped = re.sub(r"^[(\[{«\"'`]+|[)\]}»\"'`,;:.↑↓*%]+$", "", token.strip())
    raw_base = re.sub(r"\([^)]*\)$", "", raw_stripped).strip()
    if raw_stripped in AUDIO_METRIC_UPPER_ACRONYMS or raw_base in AUDIO_METRIC_UPPER_ACRONYMS:
        return True
    norm = _normalize_metric_token(token)
    if not norm:
        return False
    if norm in AUDIO_METRIC_WORDS:
        return True
    # 兼容带单位括号后缀的指标，如 `WER(%)` / `SI-SDR(dB)` / `RTF↓`
    stripped = re.sub(r"\([^)]*\)$", "", norm).strip()
    if stripped in AUDIO_METRIC_WORDS:
        return True
    if re.fullmatch(r"(?:r@[0-9]+|top-[0-9]+|p@[0-9]+)", norm):
        return True
    return False


def _format_dict_line(line: dict[str, Any]) -> str:
    spans = sorted(
        line.get("spans") or (),
        key=lambda sp: (float((sp.get("bbox") or (0, 0, 0, 0))[0]), float((sp.get("bbox") or (0, 0, 0, 0))[1])),
    )
    parts: list[str] = []
    prev_x1: float | None = None
    for sp in spans:
        txt = str(sp.get("text") or "")
        if not txt:
            continue
        bbox = sp.get("bbox")
        if prev_x1 is not None and bbox and len(bbox) == 4:
            gap = float(bbox[0]) - prev_x1
            # 同一视觉行内两个非粘连词之间若缺空格且横向间距明显，补单个空格避免粘词。
            if gap > 1.8 and parts and not parts[-1].endswith((" ", "\t", "-", "–", "—")) and not txt.startswith((" ", "\t", ",", ".", ";", ":", ")", "]", "}")):
                parts.append(" ")
        parts.append(txt)
        if bbox and len(bbox) == 4:
            prev_x1 = float(bbox[2])
    return "".join(parts).rstrip()


def _split_tight_gutter_block(block: dict[str, Any], mid: float, page_w: float) -> list[dict[str, Any]] | None:
    """若双栏 PDF 的窄栏间距导致 PyMuPDF 把左右两栏合进同一个文本块，按中线空隙拆回左右子块。"""
    lines = block.get("lines") or []
    if len(lines) < 2:
        return None
    left_lines: list[tuple[float, float, float, float, str]] = []
    right_lines: list[tuple[float, float, float, float, str]] = []
    split_count = 0
    gutter_min = max(8.0, page_w * 0.015)

    for ln in lines:
        spans = [sp for sp in (ln.get("spans") or ()) if str(sp.get("text") or "").strip()]
        if not spans:
            continue
        spans.sort(key=lambda sp: float(sp["bbox"][0]))
        left_sp = [sp for sp in spans if float(sp["bbox"][2]) <= mid + 4.0]
        right_sp = [sp for sp in spans if float(sp["bbox"][0]) >= mid - 4.0]
        # 若存在横跨中线的单个 span，说明这是真正的通栏行（如标题/图注），绝不拆栏。
        if len(left_sp) + len(right_sp) != len(spans):
            return None
        if left_sp and right_sp:
            gap = float(right_sp[0]["bbox"][0]) - float(left_sp[-1]["bbox"][2])
            if gap < gutter_min:
                return None
            split_count += 1
        if left_sp:
            lx0 = min(float(sp["bbox"][0]) for sp in left_sp)
            ly0 = min(float(sp["bbox"][1]) for sp in left_sp)
            lx1 = max(float(sp["bbox"][2]) for sp in left_sp)
            ly1 = max(float(sp["bbox"][3]) for sp in left_sp)
            ltxt = _format_dict_line({"spans": left_sp})
            if ltxt.strip():
                left_lines.append((lx0, ly0, lx1, ly1, ltxt))
        if right_sp:
            rx0 = min(float(sp["bbox"][0]) for sp in right_sp)
            ry0 = min(float(sp["bbox"][1]) for sp in right_sp)
            rx1 = max(float(sp["bbox"][2]) for sp in right_sp)
            ry1 = max(float(sp["bbox"][3]) for sp in right_sp)
            rtxt = _format_dict_line({"spans": right_sp})
            if rtxt.strip():
                right_lines.append((rx0, ry0, rx1, ry1, rtxt))

    if split_count < 2 or not left_lines or not right_lines:
        return None
    # 保护通栏实验表：若左右两侧呈现明显的表格数值行特征（右侧主要为数字/短标号且非双栏正文），不按中线切开表格。
    right_numeric_lines = 0
    for _, _, _, _, rtxt in right_lines:
        toks = rtxt.split()
        if toks and sum(1 for tok in toks if _table_value_token(tok)) >= max(1, (len(toks) + 1) // 2):
            right_numeric_lines += 1
    left_short_lines = sum(1 for _, _, _, _, ltxt in left_lines if len(ltxt.split()) <= 4)
    if right_numeric_lines >= 2 and right_numeric_lines >= len(right_lines) * 0.5 and left_short_lines >= len(left_lines) * 0.5:
        return None
    left_lines.sort(key=lambda item: (item[1], item[0]))
    right_lines.sort(key=lambda item: (item[1], item[0]))
    out: list[dict[str, Any]] = []
    for side_lines in (left_lines, right_lines):
        out.append({
            "bbox": (
                min(x[0] for x in side_lines),
                min(x[1] for x in side_lines),
                max(x[2] for x in side_lines),
                max(x[3] for x in side_lines),
            ),
            "text": "\n".join(x[4] for x in side_lines),
        })
    return out


def _extract_page_text_two_column_aware(doc: Any, page: Any) -> str:
    """按双栏几何版面重排单页文本，避免 IEEE/ISCA 左右栏逐行交错。"""
    temp_doc = None
    work_page = page
    try:
        if int(page.rotation) != 0:
            temp_doc, work_page = pdf_figure_table_extract._open_upright_page_view(doc, page)
        page_w = float(work_page.rect.width)
        mid = page_w / 2.0
        raw_dict = work_page.get_text("dict", flags=importlib.import_module("fitz").TEXTFLAGS_TEXT)
        blocks: list[dict[str, Any]] = []
        for blk in raw_dict.get("blocks") or ():
            if blk.get("type") != 0:
                continue
            bx0, by0, bx1, by1 = map(float, blk.get("bbox") or (0, 0, 0, 0))
            if bx0 < mid < bx1 and (bx1 - bx0) >= page_w * 0.50:
                split_parts = _split_tight_gutter_block(blk, mid, page_w)
                if split_parts is not None:
                    blocks.extend(split_parts)
                    continue
            lines = sorted(
                blk.get("lines") or (),
                key=lambda ln: (float((ln.get("bbox") or (0, 0, 0, 0))[1]), float((ln.get("bbox") or (0, 0, 0, 0))[0])),
            )
            line_texts = [_format_dict_line(ln) for ln in lines]
            line_texts = [t for t in line_texts if t.strip()]
            if not line_texts:
                continue
            blocks.append({
                "bbox": (bx0, by0, bx1, by1),
                "text": "\n".join(line_texts),
            })

        if not blocks:
            return ""

        left_narrow = 0
        right_narrow = 0
        for blk in blocks:
            x0, y0, x1, y1 = blk["bbox"]
            w = x1 - x0
            if w < page_w * 0.16 or w > page_w * 0.48:
                continue
            cleaned = blk["text"].strip()
            if len(cleaned.split()) < 5 and len(cleaned) < 28:
                continue
            if x1 <= page_w * 0.525:
                left_narrow += 1
            elif x0 >= page_w * 0.475:
                right_narrow += 1
        is_two_col = (left_narrow >= 1 and right_narrow >= 1)

        if not is_two_col:
            ordered = sorted(blocks, key=lambda b: (round(b["bbox"][1], 1), b["bbox"][0]))
            return _normalize_page_text("\n".join(b["text"] for b in ordered))

        spanning: list[dict[str, Any]] = []
        column_blocks: list[dict[str, Any]] = []
        for blk in blocks:
            x0, y0, x1, y1 = blk["bbox"]
            w = x1 - x0
            crosses_gutter = (x0 < page_w * 0.45) and (x1 > page_w * 0.55)
            if w >= page_w * 0.56 or crosses_gutter:
                spanning.append(blk)
            else:
                column_blocks.append(blk)

        spanning.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
        bands: list[dict[str, Any]] = []
        for blk in spanning:
            y0, y1 = blk["bbox"][1], blk["bbox"][3]
            if bands and y0 <= bands[-1]["y1"] + 6.0:
                bands[-1]["y1"] = max(bands[-1]["y1"], y1)
                bands[-1]["blocks"].append(blk)
            else:
                bands.append({"y0": y0, "y1": y1, "blocks": [blk]})

        # 将非通栏块按通栏带切分为若干垂直条带，每个条带内严格先左栏从上到下、再右栏从上到下。
        strips: list[list[dict[str, Any]]] = [[] for _ in range(len(bands) + 1)]
        for blk in column_blocks:
            cy = (blk["bbox"][1] + blk["bbox"][3]) / 2.0
            placed = len(bands)
            for idx, band in enumerate(bands):
                if cy < band["y0"]:
                    placed = idx
                    break
            strips[placed].append(blk)

        ordered_texts: list[str] = []
        for strip_idx, strip_blocks in enumerate(strips):
            left_col = [b for b in strip_blocks if ((b["bbox"][0] + b["bbox"][2]) / 2.0) < mid]
            right_col = [b for b in strip_blocks if ((b["bbox"][0] + b["bbox"][2]) / 2.0) >= mid]
            left_col.sort(key=lambda b: (round(b["bbox"][1], 1), b["bbox"][0]))
            right_col.sort(key=lambda b: (round(b["bbox"][1], 1), b["bbox"][0]))
            for blk in left_col:
                ordered_texts.append(blk["text"])
            for blk in right_col:
                ordered_texts.append(blk["text"])
            if strip_idx < len(bands):
                band_blocks = sorted(bands[strip_idx]["blocks"], key=lambda b: (round(b["bbox"][1], 1), b["bbox"][0]))
                for blk in band_blocks:
                    ordered_texts.append(blk["text"])

        return _normalize_page_text("\n".join(ordered_texts))
    finally:
        if temp_doc is not None:
            temp_doc.close()


def extract_pages_enhanced(pdf_bytes: bytes) -> list[str]:
    """双栏感知的逐页 PDF 文本抽取。"""
    try:
        fitz = importlib.import_module("fitz")
    except ImportError as exc:
        raise ConferenceExtractionDependencyError(
            "PyMuPDF is required for conference PDF enhanced extraction; install requirements.txt"
        ) from exc
    try:
        with _quiet_pymupdf_output():
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            try:
                if doc.needs_pass:
                    raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
                if len(doc) > MAX_PAGES:
                    raise ConferencePdfExtractionError(f"PDF page count exceeds {MAX_PAGES}: actual {len(doc)}")
                pages: list[str] = []
                extracted_bytes = 0
                for page in doc:
                    text = _extract_page_text_two_column_aware(doc, page)
                    extracted_bytes += len(text.encode("utf-8")) + len(PAGE_SEPARATOR.encode("utf-8"))
                    if extracted_bytes > MAX_DERIVED_BYTES:
                        raise ConferencePdfExtractionError(
                            f"extracted text exceeds the derived artifact limit: {extracted_bytes} > {MAX_DERIVED_BYTES}"
                        )
                    pages.append(text)
            finally:
                doc.close()
    except ConferencePdfExtractionError:
        raise
    except Exception as exc:
        raise ConferencePdfExtractionError(
            f"PyMuPDF enhanced extractor could not extract the PDF ({type(exc).__name__})"
        ) from exc
    if not pages:
        raise ConferencePdfExtractionError("PDF contains no pages")
    return pages


def _numeric_token(text: str) -> bool:
    value = text.strip()
    if value in {"±", "+/-", "−", "–", "—", "-"}:
        return False
    return bool(re.fullmatch(
        r"[+\-−]?(?:\d+(?:[.,]\d+)?(?:[eE][+\-−]?\d+)?|Top[-–]\d+|\d+[x×]\d+)(?:%|[A-Za-z]+)?",
        value,
    ))


def _table_value_token(text: str) -> bool:
    return _numeric_token(text) or text.strip() in {"-", "–", "—"}


def _cluster_positions(values: list[float], maximum_gap: float = 18.0) -> list[float]:
    clusters: list[list[float]] = []
    for value in sorted(values):
        if not clusters or value - clusters[-1][-1] > maximum_gap:
            clusters.append([value])
        else:
            clusters[-1].append(value)
    return [sum(cluster) / len(cluster) for cluster in clusters]


def _word_lines(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: list[list[dict[str, Any]]] = []
    for word in sorted(words, key=lambda item: (item["y0"], item["x0"])):
        center = (word["y0"] + word["y1"]) / 2.0
        target = next(
            (line for line in grouped if abs(line[0]["y0"] + line[0]["y1"] - 2.0 * center) <= 5.0),
            None,
        )
        if target is None:
            grouped.append([word])
        else:
            target.append(word)
    return [sorted(line, key=lambda item: item["x0"]) for line in grouped]


_SECTION_HEADING_LINE_RE = re.compile(
    r"^(?:\d+(?:\.\d+)*\.?\s+[A-Z]|[IVX]+\.\s+[A-Z]|Abstract\b|Introduction\b|References\b|Conclusion\b|Acknowledgements?\b)",
)


def _is_prose_sentence_line(line: list[dict[str, Any]]) -> bool:
    text = " ".join(w["text"] for w in line).strip()
    if not text:
        return False
    tokens = text.split()
    if len(tokens) > 12:
        return True
    if text.endswith(".") and len(tokens) >= 6:
        return True
    alpha_words = [t for t in tokens if re.fullmatch(r"[A-Za-z][A-Za-z'-]{1,}", t)]
    if len(alpha_words) >= 8 and not any(_table_value_token(t) for t in tokens):
        return True
    return False


def _audio_borderless_tables_on_page(
    work_page: Any,
    page_number: int,
    existing_numbers: set[str],
    precomputed_captions: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """使用扩展的音频/语音/音乐专业指标词典，为未命中 booktabs/网格的页面补回无框线实验表。"""
    fitz = importlib.import_module("fitz")
    captions = (
        precomputed_captions
        if precomputed_captions is not None
        else pdf_figure_table_extract._collect_page_captions(work_page, "table")
    )
    if not captions:
        return []
    fig_captions = pdf_figure_table_extract._collect_page_captions(work_page, "figure")
    text_blocks = [
        (float(b[0]), float(b[1]), float(b[2]), float(b[3]), str(b[4] or ""))
        for b in work_page.get_text("blocks", flags=fitz.TEXTFLAGS_TEXT)
        if b[6] == 0
    ]
    page_w = float(work_page.rect.width)
    raw_words = [
        {
            "x0": float(w[0]),
            "y0": float(w[1]),
            "x1": float(w[2]),
            "y1": float(w[3]),
            "text": _normalize_page_text(str(w[4])),
        }
        for w in work_page.get_text("words", sort=False)
        if str(w[4]).strip()
    ]
    records: list[dict[str, Any]] = []
    for cap_idx, cap in enumerate(captions):
        num_key = str(cap["number"]).upper()
        if num_key in existing_numbers:
            continue
        x0, y0, x1, y1 = cap["bbox"]
        col_side = cap.get("col_side")
        full_width = (
            col_side is None
            or (x1 - x0) >= page_w * 0.56
            or (x0 < page_w / 2.0 < x1)
        )
        region_x0 = 36.0 if full_width else (36.0 if col_side == "left" else min(page_w * 0.48, max(36.0, x0 - 12.0)))
        region_x1 = page_w - 36.0 if full_width else (max(page_w * 0.52, min(page_w - 36.0, x1 + 12.0)) if col_side == "left" else page_w - 36.0)
        stop_y = float(work_page.rect.height)
        for following in (*captions[cap_idx + 1:], *fig_captions):
            if following["bbox"][1] <= y1 + 2.0:
                continue
            if min(region_x1, following["bbox"][2]) - max(region_x0, following["bbox"][0]) > 10.0:
                stop_y = min(stop_y, float(following["bbox"][1]))
        for bx0, by0, bx1, by1, btxt in text_blocks:
            if by0 <= y1 + 2.0 or by0 >= stop_y:
                continue
            if min(region_x1, bx1) - max(region_x0, bx0) <= 10.0:
                continue
            stripped_blk = btxt.strip()
            if _SECTION_HEADING_LINE_RE.match(stripped_blk):
                stop_y = min(stop_y, by0)
                continue
            if pdf_figure_table_extract._is_body_prose_block(btxt, (bx0, by0, bx1, by1), page_w):
                # 仅当正文段落本身不像指标表头或数据块时在此截断。
                blk_tokens = stripped_blk.split()
                if not any(_is_audio_metric_token(t) for t in blk_tokens[:12]) and not any(_table_value_token(t) for t in blk_tokens[:12]):
                    stop_y = min(stop_y, by0)
        lines = _word_lines([
            w for w in raw_words
            if w["x0"] >= region_x0 - 1.0 and w["x1"] <= region_x1 + 1.0
            and w["y0"] > y1 + 2.0 and w["y0"] < stop_y - 1.0
        ])
        if len(lines) < 3:
            continue
        header_idx = None
        metric_col_count = 0
        for idx, ln in enumerate(lines[:6]):
            if _is_prose_sentence_line(ln):
                continue
            metric_hits = [w for w in ln if _is_audio_metric_token(w["text"])]
            if len(metric_hits) >= 2:
                header_idx = idx
                metric_col_count = len(metric_hits)
                break
        if header_idx is None:
            continue
        # 截断到第一个明显正文段落或节标题行之前，防止下文年份/编号污染列锚点。
        candidate_data_lines: list[list[dict[str, Any]]] = []
        for ln in lines[header_idx + 1:]:
            ln_text = " ".join(w["text"] for w in ln).strip()
            if _SECTION_HEADING_LINE_RE.match(ln_text) or _is_prose_sentence_line(ln):
                break
            candidate_data_lines.append(ln)
        if len(candidate_data_lines) < 2:
            continue
        value_positions = [
            w["x0"]
            for ln in candidate_data_lines
            for w in ln
            if _table_value_token(w["text"])
        ]
        anchors = _cluster_positions(value_positions)
        if len(anchors) < metric_col_count:
            continue
        anchors = anchors[-metric_col_count:]

        def _cells_for(line: list[dict[str, Any]]) -> list[str]:
            cells = ["" for _ in range(len(anchors) + 1)]
            for w in line:
                if w["x0"] < anchors[0] - 20.0:
                    col = 0
                else:
                    col = min(range(len(anchors)), key=lambda i: abs(anchors[i] - w["x0"])) + 1
                cells[col] = _clean_structure_text(f"{cells[col]} {w['text']}", 500)
            return cells

        header = _cells_for(lines[header_idx])
        rows: list[list[str]] = []
        current: list[str] | None = None
        last_data_y: float | None = None
        for ln in candidate_data_lines:
            cells = _cells_for(ln)
            has_value = any(_table_value_token(w["text"]) for w in ln if w["x0"] >= anchors[0] - 20.0)
            if has_value:
                if current is not None:
                    if any(current[i] for i in range(1, len(current))):
                        rows.append(current)
                    elif current[0]:
                        cells[0] = _clean_structure_text(f"{current[0]} {cells[0]}", 500)
                current = cells
                last_data_y = ln[0]["y0"]
            elif current is not None:
                if last_data_y is not None and (ln[0]["y0"] - last_data_y) > 22.0:
                    break
                if _is_prose_sentence_line(ln):
                    break
                # 仅当无数值续行是短方法名标签（<=4 词）时允许并入行首，绝不把正文段落当成新表行。
                if cells[0] and len(cells[0].split()) <= 4 and not any(cells[i] for i in range(1, len(cells))):
                    current[0] = _clean_structure_text(f"{current[0]} {cells[0]}", 500)
                else:
                    break
        if current is not None:
            rows.append(current)
        rows = [row for row in rows if len(row) >= 3 and all(row[i] for i in range(1, len(row)))]
        if len(rows) < 2:
            continue
        matrix = [header, *rows]
        if pdf_figure_table_extract._is_garbled_table_matrix(matrix, [0]):
            continue
        existing_numbers.add(num_key)
        records.append({
            "page": page_number,
            "sort_y0": float(y0),
            "sort_x0": float(x0),
            "caption": _clean_structure_text(cap["caption"], 1200),
            "cells": matrix,
            "recoveryStatus": "complete",
        })
    return records


def extract_tables_enhanced(doc: Any, pdf_sha: str) -> list[dict[str, Any]]:
    """融合 booktabs/网格/旋转表/跨页续表与音频指标无框表的会议表格抽取。"""
    primary_tables = pdf_figure_table_extract._extract_pdf_tables(doc, pdf_sha)
    records: list[dict[str, Any]] = []
    recovered_numbers: set[str] = set()

    # 仅 O(P) 预扫描一次每页表题位置与旋转方向，避免 O(T*P) 重复打开页面。
    caption_loc_by_num: dict[str, tuple[int, float, float]] = {}
    page_captions: dict[int, tuple[int | None, list[dict[str, Any]]]] = {}
    for p_idx, pg in enumerate(doc, start=1):
        temp_doc = None
        wp = pg
        explicit_rot: int | None = None
        try:
            if int(pg.rotation) != 0:
                temp_doc, wp = pdf_figure_table_extract._open_upright_page_view(doc, pg)
            else:
                sw = pdf_figure_table_extract._detect_sideways_table_rotation(pg)
                if sw is not None:
                    explicit_rot = sw
                    temp_doc, wp = pdf_figure_table_extract._open_upright_page_view(doc, pg, explicit_rotate=sw)
            caps = pdf_figure_table_extract._collect_page_captions(wp, "table")
            page_captions[p_idx] = (explicit_rot, caps)
            for cap in caps:
                key = str(cap["number"]).upper()
                if key not in caption_loc_by_num:
                    caption_loc_by_num[key] = (p_idx, float(cap["bbox"][1]), float(cap["bbox"][0]))
        finally:
            if temp_doc is not None:
                temp_doc.close()

    for tbl in primary_tables:
        label = str(tbl.get("label") or "")
        num_match = re.search(r"([A-Z]\.?\d+(?:\.\d+)*|\d+(?:\.\d+)*|[IVX]{1,5})", label, re.IGNORECASE)
        num_key = num_match.group(1).upper() if num_match else None
        # 先登记主提取器已处理（含因行数超限而标记 unrecovered 的续表）的编号，防止无框回退将截断表误标 complete。
        if num_key:
            recovered_numbers.add(num_key)
        if tbl.get("recoveryStatus") != "complete":
            continue
        raw_matrix = tbl.get("matrix") or []
        if len(raw_matrix) < 2 or not raw_matrix[0]:
            continue
        width = len(raw_matrix[0])
        if width < 2 or any(len(row) != width for row in raw_matrix):
            continue
        clean_matrix = [
            [_clean_structure_text(str(cell or ""), 500) for cell in row]
            for row in raw_matrix
        ]
        page_num, sort_y0, sort_x0 = caption_loc_by_num.get(num_key or "", (1, 0.0, 0.0))
        cap_text = _clean_structure_text(str(tbl.get("caption") or label), 1200)
        records.append({
            "page": page_num,
            "sort_y0": sort_y0,
            "sort_x0": sort_x0,
            "caption": cap_text,
            "cells": clean_matrix,
            "recoveryStatus": "complete",
        })

    # 对 booktabs / 网格未覆盖的实验表，补跑音频专业指标无框表回退（同时兼容旋转页与 sidewaystable）。
    for page_idx, page in enumerate(doc, start=1):
        if len(records) >= MAX_TABLES_ENHANCED:
            break
        explicit_rot, caps = page_captions.get(page_idx, (None, []))
        if not caps or all(str(c["number"]).upper() in recovered_numbers for c in caps):
            continue
        temp_doc = None
        work_page = page
        try:
            if int(page.rotation) != 0:
                temp_doc, work_page = pdf_figure_table_extract._open_upright_page_view(doc, page)
            elif explicit_rot is not None:
                temp_doc, work_page = pdf_figure_table_extract._open_upright_page_view(doc, page, explicit_rotate=explicit_rot)
            fallback = _audio_borderless_tables_on_page(
                work_page, page_idx, recovered_numbers, precomputed_captions=caps
            )
            records.extend(fallback)
        finally:
            if temp_doc is not None:
                temp_doc.close()

    records.sort(key=lambda item: (item["page"], item["sort_y0"], item["sort_x0"], item["caption"]))
    final_records: list[dict[str, Any]] = []
    for idx, rec in enumerate(records[:MAX_TABLES_ENHANCED], start=1):
        final_records.append({
            "ordinal": idx,
            "page": rec["page"],
            "caption": rec["caption"],
            "cells": rec["cells"],
            "sourceRef": f"pdf:table:{idx}:page:{rec['page']}",
            "recoveryStatus": "complete",
        })
    return final_records


def _render_figure_png_enhanced(
    page: Any,
    clip_bbox: list[float] | tuple[float, float, float, float],
    remaining_total_bytes: int,
) -> tuple[dict[str, str], int] | None:
    """以 288 DPI（4.0×）为首选，在像素与 2 MiB/24 MiB 体积上限内自适应降档渲染 PNG。"""
    fitz = importlib.import_module("fitz")
    clip = fitz.Rect(clip_bbox[0], clip_bbox[1], clip_bbox[2], clip_bbox[3]) & page.rect
    if clip.is_empty or clip.width < 10.0 or clip.height < 10.0:
        return None
    max_single = min(MAX_FIGURE_ASSET_BYTES, remaining_total_bytes)
    if max_single < 24:
        return None
    for base_scale in FIGURE_SCALE_LADDER:
        scale = base_scale
        w_px = clip.width * scale
        h_px = clip.height * scale
        if max(w_px, h_px) > MAX_FIGURE_LONG_EDGE_PX:
            scale *= MAX_FIGURE_LONG_EDGE_PX / max(w_px, h_px)
            w_px = clip.width * scale
            h_px = clip.height * scale
        if w_px * h_px > MAX_FIGURE_PIXELS:
            scale *= math.sqrt(MAX_FIGURE_PIXELS / (w_px * h_px))
        if scale <= 0.1:
            continue
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
        raw = pix.tobytes("png")
        if raw.startswith(b"\x89PNG\r\n\x1a\n") and len(raw) <= max_single:
            w, h = struct.unpack(">II", raw[16:24])
            if w > 0 and h > 0:
                return (
                    {
                        "mediaType": "image/png",
                        "sha256": sha256_bytes(raw),
                        "base64": base64.b64encode(raw).decode("ascii"),
                    },
                    len(raw),
                )
    return None


def extract_figures_enhanced(doc: Any) -> list[dict[str, Any]]:
    """使用几何图框定位与 288 DPI 阶梯渲染提取会议论文插图。"""
    fitz = importlib.import_module("fitz")
    records: list[dict[str, Any]] = []
    seen_numbers: set[str] = set()
    total_asset_bytes = 0

    for page_num, page in enumerate(doc, start=1):
        if len(records) >= MAX_FIGURES_ENHANCED:
            break
        temp_doc = None
        work_page = page
        offset_x = 0.0
        offset_y = 0.0
        try:
            if int(page.rotation) != 0:
                temp_doc, work_page = pdf_figure_table_extract._open_upright_page_view(doc, page)
                offset_x = float(page.rect.x0)
                offset_y = float(page.rect.y0)
            fig_caps = pdf_figure_table_extract._collect_page_captions(work_page, "figure")
            if not fig_caps:
                continue
            tab_caps = pdf_figure_table_extract._collect_page_captions(work_page, "table")
            all_caps = fig_caps + tab_caps
            text_blocks = [
                (float(b[0]), float(b[1]), float(b[2]), float(b[3]), str(b[4] or ""))
                for b in work_page.get_text("blocks", flags=fitz.TEXTFLAGS_TEXT)
                if b[6] == 0
            ]
            visual_rects = pdf_figure_table_extract._collect_visual_rects(work_page)
            if not visual_rects:
                continue
            for cap in fig_caps:
                if len(records) >= MAX_FIGURES_ENHANCED:
                    break
                num_key = str(cap["number"]).upper()
                if num_key in seen_numbers:
                    continue
                crop_bbox = pdf_figure_table_extract._extract_figure_crop_bbox(
                    work_page, cap, all_caps, text_blocks, visual_rects
                )
                if crop_bbox is None:
                    continue
                render_bbox = [
                    crop_bbox[0] + offset_x,
                    crop_bbox[1] + offset_y,
                    crop_bbox[2] + offset_x,
                    crop_bbox[3] + offset_y,
                ]
                rendered = _render_figure_png_enhanced(
                    page, render_bbox, MAX_TOTAL_FIGURE_ASSET_BYTES - total_asset_bytes
                )
                if rendered is None:
                    continue
                asset, asset_size = rendered
                total_asset_bytes += asset_size
                seen_numbers.add(num_key)
                ordinal = len(records) + 1
                records.append({
                    "ordinal": ordinal,
                    "page": page_num,
                    "caption": _clean_structure_text(cap["caption"], 1200),
                    "sourceRef": f"pdf:figure:{cap['number']}:page:{page_num}",
                    "recoveryStatus": "complete",
                    "asset": asset,
                })
        finally:
            if temp_doc is not None:
                temp_doc.close()
    return records


def _clean_aff_list(raw_affs: Any) -> list[str]:
    if isinstance(raw_affs, str):
        items = [raw_affs]
    elif isinstance(raw_affs, list):
        items = raw_affs
    else:
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            continue
        val = _clean_structure_text(item, 300)
        if not val or len(val) < 2 or _PLACEHOLDER_AFFILIATION_RE.fullmatch(val):
            continue
        key = val.lower()
        if key not in seen:
            seen.add(key)
            cleaned.append(val)
    return cleaned


def _extract_first_official_affs(item: dict[str, Any], fields: tuple[str, ...]) -> list[str]:
    for field in fields:
        if field not in item:
            continue
        affs = _clean_aff_list(item.get(field))
        if affs:
            return affs
    return []


def extract_official_metadata_authors(
    metadata: dict[str, Any],
    metadata_sha256: str,
) -> dict[str, Any] | None:
    """保留 OpenReview / IEEE / ISCA / ACL / NeurIPS 官方元数据中自带的逐人机构归属。"""
    if not isinstance(metadata, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(metadata_sha256 or "")):
        return None
    pairs: list[dict[str, Any]] = []
    raw_authors = metadata.get("authors")
    if raw_authors is None:
        raw_authors = metadata.get("author")

    # 形态 1：metadata.authors 为结构化对象数组 [{"name": ..., "affiliations": [...]}]
    if isinstance(raw_authors, list) and any(isinstance(item, dict) for item in raw_authors):
        for item in raw_authors:
            if isinstance(item, str):
                name = _clean_structure_text(item, 200)
                if name:
                    pairs.append({"name": name, "affiliations": []})
                continue
            if not isinstance(item, dict):
                continue
            raw_name = item.get("name")
            name = _clean_structure_text(raw_name, 200) if isinstance(raw_name, str) else ""
            affs = _extract_first_official_affs(item, ("affiliations", "affiliation", "institution", "institutions"))
            if name:
                pairs.append({"name": name, "affiliations": affs})

    # 形态 2：metadata.authorAffiliations 为对象数组或姓名→机构映射
    if not any(p["affiliations"] for p in pairs) and "authorAffiliations" in metadata:
        pairs = []
        raw_map = metadata.get("authorAffiliations")
        if isinstance(raw_map, list):
            for item in raw_map:
                if not isinstance(item, dict):
                    continue
                raw_name = item.get("name")
                name = _clean_structure_text(raw_name, 200) if isinstance(raw_name, str) else ""
                affs = _extract_first_official_affs(item, ("affiliations", "affiliation", "institution", "institutions"))
                if name:
                    pairs.append({"name": name, "affiliations": affs})
        elif isinstance(raw_map, dict):
            normalized_map: dict[str, list[str]] = {}
            for k, v in raw_map.items():
                norm_k = _clean_structure_text(str(k), 200)
                if not norm_k:
                    continue
                affs = _clean_aff_list(v)
                if norm_k not in normalized_map or (not normalized_map[norm_k] and affs):
                    normalized_map[norm_k] = affs
            ordered_names: list[str] = []
            if isinstance(raw_authors, list):
                for item in raw_authors:
                    if isinstance(item, str):
                        raw_nm = item
                    elif isinstance(item, dict) and isinstance(item.get("name"), str):
                        raw_nm = item["name"]
                    else:
                        raw_nm = ""
                    nm = _clean_structure_text(raw_nm, 200)
                    if nm and nm not in ordered_names:
                        ordered_names.append(nm)
            elif isinstance(raw_authors, str):
                for part in re.split(r"\s*;\s*", raw_authors):
                    nm = _clean_structure_text(part, 200)
                    if nm and nm not in ordered_names:
                        ordered_names.append(nm)
            for norm_k in normalized_map:
                if norm_k not in ordered_names:
                    ordered_names.append(norm_k)
            for nm in ordered_names:
                affs = normalized_map.get(nm, [])
                if nm:
                    pairs.append({"name": nm, "affiliations": affs})

    # 形态 3：平行数组 authors: [str, ...] 与 affiliations: [str | [str], ...]（长度必须严格相等）
    if not any(p["affiliations"] for p in pairs) and isinstance(raw_authors, list) and isinstance(metadata.get("affiliations"), list):
        pairs = []
        aff_list = metadata["affiliations"]
        if len(raw_authors) == len(aff_list) and len(raw_authors) > 0:
            for a_item, aff_item in zip(raw_authors, aff_list):
                if isinstance(a_item, str):
                    raw_nm = a_item
                elif isinstance(a_item, dict) and isinstance(a_item.get("name"), str):
                    raw_nm = a_item["name"]
                else:
                    raw_nm = ""
                nm = _clean_structure_text(raw_nm, 200)
                affs = _clean_aff_list(aff_item)
                if nm:
                    pairs.append({"name": nm, "affiliations": affs})

    if not pairs or not any(p["affiliations"] for p in pairs):
        return None
    dom_payload = {
        "contract": OFFICIAL_METADATA_AUTHOR_CONTRACT,
        "metadataSha256": metadata_sha256,
        "authors": pairs,
    }
    return {
        **dom_payload,
        "sourceDomSha256": _stable_hash(dom_payload),
    }


def extract_conference_authors_enhanced(
    pdf_bytes: bytes,
    metadata: dict[str, Any] | None = None,
    metadata_sha256: str | None = None,
) -> dict[str, Any]:
    """同时提取 PDF 首页几何作者机构与官方元数据机构信息。"""
    pdf_page1 = None
    try:
        with _quiet_pymupdf_output():
            pdf_page1 = pdf_author_extract.extract_pdf_page1_authors(
                pdf_bytes, contract=pdf_author_extract.CONTRACT_V2
            )
    except (RuntimeError, ValueError, OSError, ConferencePdfExtractionError):
        pdf_page1 = None
    official_meta = (
        extract_official_metadata_authors(metadata, metadata_sha256)
        if metadata is not None and metadata_sha256 is not None
        else None
    )
    return {
        "pdfPage1Authors": pdf_page1,
        "officialMetadataAuthors": official_meta,
    }


def _extract_formulas_enhanced(
    doc: Any,
    visual_audit: dict[str, Any],
    format_reference: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    fitz = importlib.import_module("fitz")
    formulas: list[dict[str, Any]] = []
    formula_bytes = 0
    for page_index in range(doc.page_count):
        page_number = page_index + 1
        page = doc[page_index]
        candidates = _formula_layout_candidates(page, format_reference)
        if not candidates:
            continue
        audit_page = next(
            (item for item in (visual_audit or {}).get("pages", []) if item.get("page") == page_number),
            None,
        )
        render_sha = (
            str(audit_page["sha256"])
            if audit_page
            else sha256_bytes(page.get_pixmap(dpi=VISUAL_RENDER_DPI, alpha=False).tobytes("png"))
        )
        for candidate in candidates:
            if candidate["regionStatus"] != "bounded-formula-region" or len(formulas) >= MAX_FORMULA_IMAGES:
                continue
            crop = page.get_pixmap(dpi=144, clip=fitz.Rect(candidate["cropBBox"]), alpha=False).tobytes("png")
            if len(crop) > MAX_FORMULA_IMAGE_BYTES or formula_bytes + len(crop) > MAX_TOTAL_FORMULA_IMAGE_BYTES:
                continue
            ordinal = len(formulas) + 1
            formulas.append({
                "ordinal": ordinal,
                "page": page_number,
                "tex": "",
                "sourceRef": f"pdf:formula:{ordinal}:page:{page_number}",
                "recoveryStatus": "layout-preserved",
                "sourceExpression": {
                    **_header_for_request(format_reference, "pdf-formula-source-expression", "pdf-layout-not-author-tex"),
                    "kind": "recovered-from-pdf-layout",
                    "originalTexAvailable": False,
                    "layoutSha256": candidate["layoutSha256"],
                    "renderSha256": render_sha,
                    "recoveredTex": candidate["derivedTex"],
                    "crop": {
                        "bbox": candidate["cropBBox"],
                        "dpi": 144,
                        "mediaType": "image/png",
                        "sha256": sha256_bytes(crop),
                        "base64": base64.b64encode(crop).decode("ascii"),
                    },
                },
            })
            formula_bytes += len(crop)
    return formulas


def extract_structures_enhanced(
    pdf_bytes: bytes,
    visual_audit: dict[str, Any],
    format_reference: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    try:
        fitz = importlib.import_module("fitz")
    except ImportError as exc:
        raise ConferenceExtractionDependencyError(
            "PyMuPDF is required for conference PDF enhanced structured extraction"
        ) from exc
    pdf_sha = sha256_bytes(pdf_bytes)
    try:
        with _quiet_pymupdf_output():
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            try:
                if doc.needs_pass:
                    raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
                tables = extract_tables_enhanced(doc, pdf_sha)
                figures = extract_figures_enhanced(doc)
                formulas = _extract_formulas_enhanced(doc, visual_audit, format_reference)
                return _json_safe_deep({
                    "tables": tables,
                    "formulas": formulas,
                    "figures": figures,
                })
            finally:
                doc.close()
    except ConferenceExtractionError:
        raise
    except Exception as exc:
        raise ConferencePdfExtractionError(
            f"PyMuPDF enhanced structured extraction failed ({type(exc).__name__})"
        ) from exc


def run_extraction_enhanced(
    manifest_name: str,
    *,
    apply: bool,
    source_root: Path = DEFAULT_STAGING_SOURCE_DIR,
) -> dict[str, Any]:
    """运行增强版会议 PDF 确定性抽取，继承旧版全部文件安全与不可变落盘边界。"""
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
        metadata_sha = sha256_bytes(metadata_bytes)
        if metadata_sha != request["source"]["metadata"]["sha256"]:
            raise _fail(
                f"metadata SHA-256 differs from the extraction request: actual {metadata_sha}, expected {request['source']['metadata']['sha256']}"
            )
        _validate_metadata_identity(metadata, request)
        pdf_sha = sha256_bytes(pdf_bytes)
        if pdf_sha != request["source"]["pdf"]["sha256"]:
            raise _fail(
                f"PDF SHA-256 differs from the extraction request: actual {pdf_sha}, expected {request['source']['pdf']['sha256']}"
            )
        if not pdf_bytes.startswith(b"%PDF-"):
            raise _fail("PDF source does not have a standard PDF header")
        for output_name in request["outputs"].values():
            try:
                os.stat(output_name, dir_fd=root_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise _fail(f"output already exists: {output_name}")

        try:
            fitz = importlib.import_module("fitz")
        except ImportError as exc:
            raise ConferenceExtractionDependencyError(
                "PyMuPDF is required for conference PDF enhanced extraction; install requirements.txt"
            ) from exc
        backend_info = {"name": "pymupdf", "version": str(getattr(fitz, "VersionBind", "unknown"))}
        options = dict(request["options"])
        text_bytes: bytes | None = None
        artifact_bytes: bytes | None = None
        page_count: int | None = None
        non_whitespace: int | None = None
        status = "blocked"
        blocked_reason: dict[str, str] | None = None

        try:
            pages = extract_pages_enhanced(pdf_bytes)
            pages = [_normalize_page_text(p) for p in pages]
            text_bytes, ranges = _page_ranges(pages)
            page_count = len(pages)
            non_whitespace = sum(1 for ch in text_bytes.decode("utf-8") if not ch.isspace())
            if len(text_bytes) > MAX_DERIVED_BYTES:
                raise ConferencePdfExtractionError(
                    f"extracted text exceeds the derived artifact limit: {len(text_bytes)} > {MAX_DERIVED_BYTES}"
                )
            try:
                with _quiet_pymupdf_output():
                    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
                    try:
                        if doc.needs_pass:
                            raise ConferencePdfExtractionError("encrypted PDFs are unsupported")
                        visual_audit = _build_visual_audit(doc, request)
                        visual_audit["backend"] = dict(backend_info)
                        visual_audit.pop("auditSha256", None)
                        visual_audit["auditSha256"] = _stable_hash(visual_audit)
                    finally:
                        doc.close()
            except ConferencePdfExtractionError:
                raise
            except Exception as exc:
                raise ConferencePdfExtractionError(
                    f"PDF visual audit failed ({type(exc).__name__})"
                ) from exc
            structures = extract_structures_enhanced(pdf_bytes, visual_audit, request)
            author_evidence = extract_conference_authors_enhanced(pdf_bytes, metadata, metadata_sha)
            minimum_text_characters = options["minimumTextCharacters"]
            short = non_whitespace < minimum_text_characters
            status = "blocked" if short else "ready"
            blocked_reason = (
                {
                    "code": "TEXT_TOO_SHORT",
                    "message": (
                        f"extracted non-whitespace text is below {minimum_text_characters} characters: "
                        f"actual {non_whitespace}"
                    ),
                }
                if short
                else None
            )
            artifact = {
                "contract": ARTIFACT_ENHANCED_CONTRACT,
                "profile": ARTIFACT_ENHANCED_PROFILE,
                "offsetUnit": OFFSET_UNIT,
                "flattenedTextSha256": sha256_bytes(text_bytes),
                "pages": ranges,
                "tables": structures.get("tables", []),
                "formulas": structures.get("formulas", []),
                "figures": structures.get("figures", []),
                "visualAudit": visual_audit,
                "authorEvidence": author_evidence,
                "extractorProfile": {
                    "readingOrder": "two-column-aware",
                    "figureTargetDpi": FIGURE_TARGET_DPI,
                    "tableRecovery": "booktabs-grid-audio-metrics",
                },
            }
            artifact = _json_safe_deep(artifact)
            artifact["payloadSha256"] = sha256_bytes(_compact_json_bytes(artifact))
            artifact_bytes = _json_bytes(artifact)
            if len(artifact_bytes) > MAX_DERIVED_BYTES:
                raise _fail(
                    f"structured artifact exceeds the derived artifact limit: {len(artifact_bytes)} > {MAX_DERIVED_BYTES}"
                )
        except ConferencePdfExtractionError as exc:
            text_bytes = None
            artifact_bytes = None
            status = "blocked"
            blocked_reason = {"code": "PDF_EXTRACTION_FAILED", "message": str(exc)}

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
            "contract": RECEIPT_ENHANCED_CONTRACT,
            "status": status,
            "textReplayable": status == "ready",
            "structuredReplayable": status == "ready",
            "paperId": request["paperId"],
            "sourceIdentity": request["sourceIdentity"],
            "request": {"file": manifest_name, "sha256": sha256_bytes(manifest_bytes)},
            "source": {
                "metadata": {**request["source"]["metadata"], "sha256": metadata_sha},
                "pdf": {**request["source"]["pdf"], "sha256": pdf_sha},
            },
            "extractor": {
                "contract": EXTRACTOR_ENHANCED_CONTRACT,
                "name": EXTRACTOR_ENHANCED_NAME,
                "implementationSha256": extractor_enhanced_implementation_sha256(),
                "dependencySha256s": extractor_enhanced_dependency_sha256s(),
                "backend": backend_info,
            },
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
            "contract": EXTRACTOR_ENHANCED_CONTRACT,
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


def verify_extraction_enhanced(manifest_name: str, *, source_root: Path = DEFAULT_STAGING_SOURCE_DIR) -> dict[str, Any]:
    """从原始封存 PDF 重跑增强布局抽取器，逐字节比对每个派生文件。"""
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
            key: _read_regular_single_link(root_fd, name, MAX_DERIVED_BYTES, f"existing {key}")
            for key, name in request["outputs"].items()
        }
    finally:
        os.close(root_fd)

    with tempfile.TemporaryDirectory(prefix="conference-extraction-enhanced-verify-") as temporary:
        replay_root = Path(temporary).resolve()
        for name, raw in ((manifest_name, manifest_bytes), (metadata_name, metadata_bytes), (pdf_name, pdf_bytes)):
            target = replay_root / name
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                written = 0
                while written < len(raw):
                    count = os.write(fd, raw[written:])
                    if count <= 0:
                        raise OSError("short write while preparing enhanced extraction replay")
                    written += count
                os.fsync(fd)
            finally:
                os.close(fd)
        result = run_extraction_enhanced(manifest_name, apply=True, source_root=replay_root)
        if result["status"] != "ready":
            raise _fail(f"replayed enhanced extraction is not ready: status={result['status']!r}")
        replayed_outputs = {
            key: (replay_root / name).read_bytes()
            for key, name in request["outputs"].items()
        }

    for key in request["outputs"]:
        if current_outputs[key] != replayed_outputs[key]:
            raise _fail(
                f"existing {key} differs from a fresh pinned enhanced extraction replay: "
                f"actual {sha256_bytes(current_outputs[key])}, expected {sha256_bytes(replayed_outputs[key])}"
            )
    receipt = _strict_json_object(replayed_outputs["receiptFile"], "replayed enhanced receipt")
    body = {
        "contract": VERIFICATION_ENHANCED_CONTRACT,
        "status": "verified",
        "paperId": request["paperId"],
        "sourceIdentity": request["sourceIdentity"],
        "requestSha256": sha256_bytes(manifest_bytes),
        "metadataSha256": sha256_bytes(metadata_bytes),
        "pdfSha256": sha256_bytes(pdf_bytes),
        "textSha256": sha256_bytes(replayed_outputs["textFile"]),
        "artifactsSha256": sha256_bytes(replayed_outputs["artifactsFile"]),
        "receiptFileSha256": sha256_bytes(replayed_outputs["receiptFile"]),
        "receiptSha256": _expected_sha(receipt.get("receiptSha256"), "replayed enhanced receipt.receiptSha256"),
    }
    return {**body, "verificationSha256": _stable_hash(body)}


__all__ = [
    "ARTIFACT_ENHANCED_CONTRACT",
    "ARTIFACT_ENHANCED_PROFILE",
    "AUDIO_METRIC_UPPER_ACRONYMS",
    "AUDIO_METRIC_WORDS",
    "EXTRACTOR_ENHANCED_CONTRACT",
    "EXTRACTOR_ENHANCED_NAME",
    "FIGURE_SCALE_LADDER",
    "FIGURE_TARGET_DPI",
    "OFFICIAL_METADATA_AUTHOR_CONTRACT",
    "RECEIPT_ENHANCED_CONTRACT",
    "VERIFICATION_ENHANCED_CONTRACT",
    "extract_conference_authors_enhanced",
    "extract_figures_enhanced",
    "extract_official_metadata_authors",
    "extract_pages_enhanced",
    "extract_structures_enhanced",
    "extract_tables_enhanced",
    "extractor_enhanced_dependency_sha256s",
    "extractor_enhanced_implementation_sha256",
    "run_extraction_enhanced",
    "verify_extraction_enhanced",
]


if __name__ == "__main__":
    from runtime_guard import require_external_runtime

    require_external_runtime("conference_layout_extractor.py")

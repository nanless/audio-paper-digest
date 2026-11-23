#!/usr/bin/env python3
"""Deterministic PyMuPDF figure-bbox and table extractor for sealed PDF sources.

Two modes:
  1) Metadata extraction (--pdf <path> --json [--arxiv-id <id>]):
     Returns deterministic structured figure crop descriptors (kind='pdf_crop',
     ZERO image bytes stored in source-runtime.json) and rectangular table
     matrices anchored to genuine printed captions.
  2) Deterministic PNG crop renderer (--pdf <path> --render-crop page:x0,y0,x1,y1 [--dpi 288]):
     Renders the exact PDF clip rectangle at high DPI (clamped safely to <=2400px
     long edge and <=8 MiB PNG) to stdout for ephemeral model vision input or
     deterministic publish-time staging into static/images/papers/<id>/.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import math
import re
import struct
import sys
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF

from runtime_guard import require_external_runtime

fitz.TOOLS.mupdf_display_errors(False)

PDF_FIGURE_CROP_CONTRACT = "reader-pdf-figure-crop-v1"
PDF_TABLE_EXTRACT_CONTRACT = "reader-pdf-table-extract-v1"
DEFAULT_DPI = 288
MAX_PDF_BYTES = 128 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_LONG_EDGE_PX = 2400
MAX_PIXELS = 12_000_000
MAX_FIGURES = 64
MAX_TABLES = 64

_NUM_TOKEN = r"(?:[A-Z]?\d+(?:\.\d+)?|[IVX]{1,4})"
_PROSE_LEAD_VERBS = {
    "shows", "show", "illustrates", "illustrate", "presents", "present",
    "depicts", "depict", "plots", "plot", "compares", "compare", "reports",
    "report", "summarizes", "summarize", "lists", "list", "demonstrates",
    "demonstrate", "displays", "display", "provides", "provide", "contains",
    "contain", "gives", "give", "describes", "describe", "visualizes",
    "visualize", "evaluates", "evaluate", "measures", "measure", "analyzes",
    "analyze", "outlines", "outline", "highlights", "highlight", "reveals",
    "reveal", "confirms", "confirm", "indicates", "indicate", "tracks",
    "is", "are", "was", "were", "can", "may", "will", "has", "have",
    "in", "of", "and", "for", "to", "with", "at", "on", "from", "also",
}

FIG_CAPTION_STRICT_RE = re.compile(
    rf"^\s*(?:Figure|Fig\.?)\s+({_NUM_TOKEN})(?!\d)\s*(?:[:.\u2013\u2014-]\s*|\(([a-zA-Z])\)\s*)(.+)",
    re.IGNORECASE | re.DOTALL,
)
FIG_CAPTION_LOOSE_RE = re.compile(
    rf"^\s*(Figure|FIGURE|Fig\.?|FIG\.?)\s+({_NUM_TOKEN})(?!\d)\s+([A-Z0-9(\[\u201c\"].+)",
    re.DOTALL,
)
TAB_CAPTION_STRICT_RE = re.compile(
    rf"^\s*(?:Table|Tab\.?)\s+({_NUM_TOKEN})(?!\d)\s*[:.\u2013\u2014-]\s*(.+)",
    re.IGNORECASE | re.DOTALL,
)
TAB_CAPTION_LOOSE_RE = re.compile(
    rf"^\s*(Table|TABLE|Tab\.?|TAB\.?)\s+({_NUM_TOKEN})(?!\d)\s+([A-Z0-9(\[\u201c\"].+)",
    re.DOTALL,
)
ANY_CAPTION_RE = re.compile(
    rf"^\s*(?:Figure|Fig\.?|Table|Tab\.?|Algorithm|Listing)\s+{_NUM_TOKEN}(?!\d)\s*(?:[:.\u2013\u2014-]|\([a-zA-Z]\)|\s+[A-Z])",
    re.IGNORECASE,
)
SECTION_HEADING_RE = re.compile(
    r"^\s*(?:(?:[IVX]+|[A-Z]|\d+(?:\.\d+)*)\.?\s+[A-Z][A-Za-z0-9 ,:/()-]{2,80}|Abstract|Introduction|References|Acknowledgments?|Appendix)\s*$",
    re.IGNORECASE,
)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def _clean_ws(text: str) -> str:
    s = str(text or "")
    s = s.translate(str.maketrans({
        "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
        "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st",
    }))
    s = re.sub(r"(?<=[A-Za-z])-\r?\n(?=[A-Za-z])", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _clean_cell_text(text: str) -> str:
    s = str(text or "")
    s = s.translate(str.maketrans({
        "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl",
        "\ufb03": "ffi", "\ufb04": "ffl", "\ufb05": "st", "\ufb06": "st",
    }))
    s = re.sub(r"[\r\n]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _match_caption_header(cleaned: str, kind: str) -> tuple[str, str] | None:
    """Return (number_str, remainder) if cleaned text is a genuine caption start, else None."""
    if kind == "figure":
        m = FIG_CAPTION_STRICT_RE.match(cleaned)
        if m:
            num, sub, rest = m.group(1), m.group(2), m.group(3)
            first_word = re.match(r"^\s*([A-Za-z]+)", rest)
            if sub and first_word and first_word.group(1).lower() in _PROSE_LEAD_VERBS:
                return None
            # Reject single-letter Roman numeral 'I' unless uppercase FIGURE or followed by ':'/'.'
            if num == "I" and not re.match(r"^\s*(?:FIGURE|FIG\.?)\b", cleaned) and ":" not in cleaned[:18] and "." not in cleaned[:18]:
                return None
            return num, rest
        m2 = FIG_CAPTION_LOOSE_RE.match(cleaned)
        if m2:
            prefix, num, rest = m2.group(1), m2.group(2), m2.group(3)
            first_word = re.match(r"^\s*([A-Za-z]+)", rest)
            if first_word and first_word.group(1).lower() in _PROSE_LEAD_VERBS:
                return None
            # For loose (colon-less) match, reject lowercase verb after short phrase or single 'I' unless ALL-CAPS prefix
            if re.fullmatch(r"[IVX]+", num) and prefix != prefix.upper():
                return None
            return num, rest
        return None

    m = TAB_CAPTION_STRICT_RE.match(cleaned)
    if m:
        num, rest = m.group(1), m.group(2)
        first_word = re.match(r"^\s*([A-Za-z]+)", rest)
        if first_word and first_word.group(1).lower() in _PROSE_LEAD_VERBS:
            return None
        return num, rest
    m2 = TAB_CAPTION_LOOSE_RE.match(cleaned)
    if m2:
        prefix, num, rest = m2.group(1), m2.group(2), m2.group(3)
        first_word = re.match(r"^\s*([A-Za-z]+)", rest)
        if first_word and first_word.group(1).lower() in _PROSE_LEAD_VERBS:
            return None
        if re.fullmatch(r"[IVX]+", num) and prefix != prefix.upper():
            return None
        return num, rest
    return None


def _is_two_column_page(raw_blocks: list[tuple[Any, ...]], page_w: float) -> bool:
    """Detect whether a page genuinely uses a 2-column text layout."""
    left_narrow = 0
    right_narrow = 0
    for blk in raw_blocks:
        x0, y0, x1, y1, raw_txt = float(blk[0]), float(blk[1]), float(blk[2]), float(blk[3]), str(blk[4] or "")
        w = x1 - x0
        if w < page_w * 0.24 or w > page_w * 0.48:
            continue
        if len(_clean_ws(raw_txt).split()) < 10:
            continue
        if x1 <= page_w * 0.525:
            left_narrow += 1
        elif x0 >= page_w * 0.475:
            right_narrow += 1
    return (left_narrow >= 1 and right_narrow >= 1) or left_narrow >= 3 or right_narrow >= 3


def _is_body_prose_block(text: str, bbox: tuple[float, float, float, float], page_w: float) -> bool:
    """Heuristic distinguishing dense body prose paragraphs from short plot/diagram text labels."""
    cleaned = _clean_ws(text)
    if not cleaned:
        return False
    if _match_caption_header(cleaned, "figure") or _match_caption_header(cleaned, "table"):
        return True
    words = cleaned.split()
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    if len(words) >= 24 and w >= page_w * 0.34 and h >= 22.0:
        sentence_punct = len(re.findall(r"[.;?!](?:\s|$)", cleaned))
        if sentence_punct >= 1:
            return True
    if len(words) >= 40 and w >= page_w * 0.30:
        return True
    if SECTION_HEADING_RE.match(cleaned) and len(words) <= 10 and w < page_w * 0.65:
        return True
    return False


def _collect_page_captions(page: fitz.Page, kind: str) -> list[dict[str, Any]]:
    """Collect genuine Figure or Table captions on a page with merged multi-line continuation blocks."""
    raw_blocks = sorted(
        (b for b in page.get_text("blocks", flags=fitz.TEXTFLAGS_TEXT) if b[6] == 0),
        key=lambda b: (round(b[1], 1), round(b[0], 1)),
    )
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    two_col = _is_two_column_page(raw_blocks, page_w)
    captions: list[dict[str, Any]] = []
    used: set[int] = set()
    for idx, blk in enumerate(raw_blocks):
        if idx in used:
            continue
        x0, y0, x1, y1, raw_txt = float(blk[0]), float(blk[1]), float(blk[2]), float(blk[3]), str(blk[4] or "")
        if x1 < 42.0 and (y1 - y0) > 120.0:
            continue
        if y0 < 15.0 or y1 > page_h - 12.0:
            continue
        cleaned = _clean_ws(raw_txt)
        matched = _match_caption_header(cleaned, kind)
        if not matched:
            continue
        num_str, _rest = matched
        # Guard: if a long multi-sentence prose block (>=55 words) starts with loose "Figure N ..."
        # without bold/colon and looks like normal body prose, skip it.
        if len(cleaned.split()) >= 60 and not re.match(
            rf"^\s*(?:Figure|FIGURE|Fig\.?|Table|TABLE|Tab\.?)\s+{_NUM_TOKEN}\s*(?:[:.\u2013\u2014-]|\([a-zA-Z]\))",
            cleaned,
        ):
            continue
        cap_bbox = [x0, y0, x1, y1]
        cap_parts = [cleaned]
        used.add(idx)
        for nxt_idx in range(idx + 1, min(len(raw_blocks), idx + 4)):
            if nxt_idx in used:
                continue
            nb = raw_blocks[nxt_idx]
            nx0, ny0, nx1, ny1, nraw = float(nb[0]), float(nb[1]), float(nb[2]), float(nb[3]), str(nb[4] or "")
            nclean = _clean_ws(nraw)
            if not nclean or _match_caption_header(nclean, "figure") or _match_caption_header(nclean, "table") or SECTION_HEADING_RE.match(nclean):
                break
            dy = ny0 - cap_bbox[3]
            if dy < -2.0 or dy > 9.0:
                break
            overlap = min(cap_bbox[2], nx1) - max(cap_bbox[0], nx0)
            if overlap <= 0.45 * min(cap_bbox[2] - cap_bbox[0], nx1 - nx0):
                break
            if cap_parts[-1].endswith(".") and len(nclean.split()) >= 22 and abs(nx0 - cap_bbox[0]) > 6.0:
                break
            cap_parts.append(nclean)
            cap_bbox = [min(cap_bbox[0], nx0), cap_bbox[1], max(cap_bbox[2], nx1), max(cap_bbox[3], ny1)]
            used.add(nxt_idx)
        full_caption = _clean_ws(" ".join(cap_parts))
        label_prefix = "Figure" if kind == "figure" else "Table"
        col_side = None
        if two_col:
            # Strict containment: a caption straddling page center belongs to a full-width figure*/table*!
            if cap_bbox[2] <= page_w * 0.53:
                col_side = "left"
            elif cap_bbox[0] >= page_w * 0.47:
                col_side = "right"
        captions.append({
            "number": num_str,
            "label": f"{label_prefix} {num_str}",
            "caption": full_caption[:1200],
            "bbox": cap_bbox,
            "col_side": col_side,
        })
    return captions


def _collect_visual_rects(page: fitz.Page) -> list[tuple[float, float, float, float]]:
    """Collect bounding boxes of real embedded images, XObjects, and non-rule vector drawings."""
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    rects: list[tuple[float, float, float, float]] = []

    for info in page.get_image_info(xrefs=True):
        b = info.get("bbox")
        if not b or len(b) != 4:
            continue
        x0, y0, x1, y1 = map(float, b)
        if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
            continue
        w, h = x1 - x0, y1 - y0
        if w < 12.0 or h < 12.0:
            continue
        if w > page_w * 0.94 and h > page_h * 0.92:
            continue
        rects.append((max(0.0, x0), max(0.0, y0), min(page_w, x1), min(page_h, y1)))

    try:
        drawings = page.get_drawings()
    except Exception:
        drawings = []
    for d in drawings:
        r = d.get("rect")
        if r is None:
            continue
        x0, y0, x1, y1 = float(r.x0), float(r.y0), float(r.x1), float(r.y1)
        if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
            continue
        w, h = x1 - x0, y1 - y0
        if w > page_w * 0.94 and h > page_h * 0.90:
            continue
        if w < 1.5 and h < 1.5:
            continue
        if h < 1.8 and w > page_w * 0.25:
            continue
        if y0 < 22.0 or y1 > page_h - 22.0:
            continue
        rects.append((max(0.0, x0), max(0.0, y0), min(page_w, x1), min(page_h, y1)))

    return rects


def _extract_figure_crop_bbox(
    page: fitz.Page,
    cap: dict[str, Any],
    all_captions: list[dict[str, Any]],
    text_blocks: list[tuple[float, float, float, float, str]],
    visual_rects: list[tuple[float, float, float, float]],
) -> list[float] | None:
    """Compute a clean, tight figure crop rectangle anchored above (or if top-captioned, below) a caption."""
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    cx0, cy0, cx1, cy1 = cap["bbox"]
    col_side = cap["col_side"]

    if col_side == "left":
        col_x0, col_x1 = 18.0, page_w * 0.515
    elif col_side == "right":
        col_x0, col_x1 = page_w * 0.485, page_w - 18.0
    else:
        col_x0, col_x1 = 18.0, page_w - 18.0

    # Promote narrow left/right caption to full-width if a visual element right above/below it
    # actually spans across the page center (e.g., Frontiers/Wiley full-width figure* with short left-aligned caption).
    if col_side is not None:
        spanning_visuals = [
            r for r in visual_rects
            if r[0] < page_w * 0.44 and r[2] > page_w * 0.56
            and (
                (r[3] <= cy0 + 22.0 and r[3] >= cy0 - 120.0)
                or (r[1] >= cy1 - 22.0 and r[1] <= cy1 + 120.0)
            )
        ]
        if spanning_visuals:
            sv_y0 = min(r[1] for r in spanning_visuals)
            sv_y1 = max(r[3] for r in spanning_visuals)
            opposing_prose = any(
                _is_body_prose_block(btxt, (bx0, by0, bx1, by1), page_w)
                and by1 > sv_y0 + 8.0 and by0 < sv_y1 - 8.0
                and ((col_side == "left" and bx0 >= page_w * 0.48) or (col_side == "right" and bx1 <= page_w * 0.52))
                for bx0, by0, bx1, by1, btxt in text_blocks
            )
            if not opposing_prose:
                col_side = None
                col_x0, col_x1 = 18.0, page_w - 18.0

    def _in_col(b: tuple[float, float, float, float]) -> bool:
        if col_side is None:
            return True
        bx_mid = (b[0] + b[2]) / 2.0
        return col_x0 - 8.0 <= bx_mid <= col_x1 + 8.0

    def _search_band(y_min: float, y_max: float) -> list[float] | None:
        if y_max - y_min < 36.0:
            return None
        band_visuals = [
            r for r in visual_rects
            if _in_col(r)
            and r[3] > y_min + 2.0
            and r[1] < y_max - 2.0
            and r[1] >= y_min - 18.0
            and r[3] <= y_max + 22.0
        ]
        if not band_visuals:
            return None
        vx0 = min(r[0] for r in band_visuals)
        vy0 = max(y_min, min(r[1] for r in band_visuals))
        vx1 = max(r[2] for r in band_visuals)
        vy1 = min(y_max, max(r[3] for r in band_visuals))
        if (vx1 - vx0) < 55.0 or (vy1 - vy0) < 34.0:
            return None
        # Expand iteratively to absorb nearby plot axis titles, tick labels, legends & subplot captions
        pad_x, pad_y = 24.0, 18.0
        fx0, fy0, fx1, fy1 = vx0, vy0, vx1, vy1
        for _pass in range(2):
            changed = False
            for bx0, by0, bx1, by1, btxt in text_blocks:
                if not _in_col((bx0, by0, bx1, by1)):
                    continue
                if by1 <= y_min or by0 >= y_max:
                    continue
                if _is_body_prose_block(btxt, (bx0, by0, bx1, by1), page_w):
                    continue
                if bx1 >= fx0 - pad_x and bx0 <= fx1 + pad_x and by1 >= fy0 - pad_y and by0 <= fy1 + pad_y:
                    nx0, ny0, nx1, ny1 = min(fx0, bx0), min(fy0, by0), max(fx1, bx1), max(fy1, by1)
                    if (nx0, ny0, nx1, ny1) != (fx0, fy0, fx1, fy1):
                        fx0, fy0, fx1, fy1 = nx0, ny0, nx1, ny1
                        changed = True
            if not changed:
                break
        margin = 6.0
        out = [
            round(max(col_x0, fx0 - margin), 2),
            round(max(max(24.0, y_min), fy0 - margin), 2),
            round(min(col_x1, fx1 + margin), 2),
            round(min(min(page_h - 24.0, y_max), fy1 + margin), 2),
        ]
        if out[2] - out[0] < 60.0 or out[3] - out[1] < 40.0:
            return None
        return out

    upper_y = 32.0
    for other in all_captions:
        ob = other["bbox"]
        if other is cap:
            continue
        if ob[3] <= cy0 - 4.0 and (col_side is None or other["col_side"] is None or other["col_side"] == col_side):
            upper_y = max(upper_y, ob[3] + 4.0)
    for bx0, by0, bx1, by1, btxt in text_blocks:
        if by1 <= cy0 - 4.0 and _in_col((bx0, by0, bx1, by1)) and _is_body_prose_block(btxt, (bx0, by0, bx1, by1), page_w):
            upper_y = max(upper_y, by1 + 4.0)

    crop = _search_band(upper_y, cy0 + 1.5)
    if crop is not None:
        return crop

    lower_y = page_h - 32.0
    for other in all_captions:
        ob = other["bbox"]
        if other is cap:
            continue
        if ob[1] >= cy1 + 4.0 and (col_side is None or other["col_side"] is None or other["col_side"] == col_side):
            lower_y = min(lower_y, ob[1] - 4.0)
    for bx0, by0, bx1, by1, btxt in text_blocks:
        if by0 >= cy1 + 4.0 and _in_col((bx0, by0, bx1, by1)) and _is_body_prose_block(btxt, (bx0, by0, bx1, by1), page_w):
            lower_y = min(lower_y, by0 - 4.0)
    return _search_band(cy1 + 2.0, lower_y)


_NUMERIC_CELL_RE = re.compile(r"^[+\-\u2212]?(?:\d+(?:\.\d+)?|\.\d+)%?(?:\s+[+\-\u2212]?(?:\d+(?:\.\d+)?|\.\d+)%?)*$")
_MERGED_FLOATS_RE = re.compile(r"(?:^|\s)[+\-\u2212]?(?:\d+\.\d+|\.\d+)(?:\s+[+\-\u2212]?(?:\d+\.\d+|\.\d+))+")


def _is_garbled_table_matrix(matrix: list[list[str]], header_rows: list[int]) -> bool:
    """Reject corrupted PDF table extractions (numeric headers, column-merged floats, mid-word splits)."""
    if not matrix or not matrix[0] or _has_midword_column_split(matrix):
        return True
    hdr0 = [c.strip() for c in matrix[0] if c.strip()]
    if len(hdr0) < max(2, math.ceil(len(matrix[0]) * 0.5)):
        return True
    hdr0_numeric = sum(1 for c in hdr0 if _NUMERIC_CELL_RE.match(c) or _MERGED_FLOATS_RE.search(c))
    if hdr0_numeric >= max(1, math.ceil(len(hdr0) * 0.45)):
        return True
    body = [matrix[i] for i in range(len(matrix)) if i not in header_rows]
    if not body:
        return True
    non_empty_body = [c.strip() for r in body for c in r if c.strip()]
    merged_float_cells = sum(1 for c in non_empty_body if _MERGED_FLOATS_RE.search(c))
    if non_empty_body and (merged_float_cells / len(non_empty_body)) >= 0.25:
        return True
    return False


def _has_midword_column_split(matrix: list[list[str]]) -> bool:
    """Detect PyMuPDF column slicing right through the middle of English words (e.g. 'Backe' | 'nd')."""
    suspicious = 0
    total_pairs = 0
    for row in matrix:
        for c in range(len(row) - 1):
            left = row[c].strip()
            right = row[c + 1].strip()
            if not left or not right:
                continue
            total_pairs += 1
            # Lowercase fragment continuing immediately into lowercase letters with short fragment
            lm = re.search(r"([A-Za-z]+)$", left)
            rm = re.match(r"^([a-z]+)\b", right)
            if lm and rm:
                lw, rw = lm.group(1), rm.group(1)
                if len(rw) <= 5 and lw.lower() not in {
                    "and", "or", "for", "the", "with", "from", "in", "on", "at", "by", "to", "of", "vs", "per",
                    "cpu", "gpu", "npu", "wer", "cer", "rtf", "fid", "auc", "ap", "ece", "mos", "psnr", "ssim",
                } and rw not in {
                    "and", "or", "for", "the", "with", "from", "in", "on", "at", "by", "to", "of", "vs", "per",
                    "s", "ms", "hz", "khz", "db", "mb", "gb", "kb", "test", "val", "dev", "clean", "other", "all",
                    "mean", "std", "min", "max", "ours", "base", "large", "small", "tiny", "full", "none", "yes", "no",
                }:
                    suspicious += 1
    return suspicious >= 2 or (total_pairs > 0 and suspicious >= 1 and len(matrix) <= 4)


def _extract_booktabs_table_from_rules(
    page: fitz.Page,
    cap: dict[str, Any],
    rule_stacks: list[dict[str, Any]],
    used_stacks: set[int],
) -> tuple[list[list[str]], list[int], list[float], int] | None:
    """Extract clean academic booktabs table using horizontal rules + phrase-span column clustering."""
    cx0, cy0, cx1, cy1 = cap["bbox"]
    best_si = -1
    best_dist = 1e9
    for si, stack in enumerate(rule_stacks):
        if si in used_stacks:
            continue
        sx0, sy0, sx1, sy1 = stack["bbox"]
        if min(cx1, sx1) - max(cx0, sx0) < 20.0:
            continue
        if sy0 >= cy1 - 8.0 and (sy0 - cy1) <= 75.0:
            dist = sy0 - cy1
        elif cy0 >= sy1 - 8.0 and (cy0 - sy1) <= 75.0:
            dist = (cy0 - sy1) + 25.0
        else:
            continue
        if dist < best_dist:
            best_dist = dist
            best_si = si
    if best_si < 0:
        return None

    stack = rule_stacks[best_si]
    sx0, sy0, sx1, sy1 = stack["bbox"]
    rules_y = stack["ys"]
    clip = fitz.Rect(sx0 - 4.0, sy0 - 2.0, sx1 + 4.0, sy1 + 2.0)
    words = page.get_text("words", clip=clip)
    if not words:
        return None

    # 1. Cluster words into visual text lines by vertical center
    words_sorted = sorted(words, key=lambda w: ((w[1] + w[3]) / 2.0, w[0]))
    lines: list[list[tuple[float, float, float, float, str]]] = []
    for w in words_sorted:
        wx0, wy0, wx1, wy1, txt = float(w[0]), float(w[1]), float(w[2]), float(w[3]), str(w[4])
        if not txt.strip():
            continue
        ymid = (wy0 + wy1) / 2.0
        if lines and abs(ymid - sum((x[1] + x[3]) / 2.0 for x in lines[-1]) / len(lines[-1])) <= 3.6:
            lines[-1].append((wx0, wy0, wx1, wy1, txt))
        else:
            lines.append([(wx0, wy0, wx1, wy1, txt)])
    for ln in lines:
        ln.sort(key=lambda x: x[0])
    if len(lines) < 2:
        return None

    # Determine header boundary from first interior horizontal rule (within top 42pt)
    header_cut_y = None
    for ry in rules_y[1:-1]:
        if 8.0 <= (ry - sy0) <= 46.0:
            header_cut_y = ry
            break

    # 2. Estimate normal inter-word space vs inter-column gap from line word gaps
    # Typical academic table font (7-10pt) has inter-word space ~1.5-3.6pt and column gap >=5.5pt.
    median_h = sorted((w[3] - w[1]) for ln in lines for w in ln)[len(words_sorted) // 2]
    phrase_gap = max(4.2, min(7.0, median_h * 0.56))

    # Build phrase spans per line: consecutive words separated by <= phrase_gap stay together!
    line_spans: list[tuple[float, list[tuple[float, float, str]]]] = []
    for ln in lines:
        ymid = sum((w[1] + w[3]) / 2.0 for w in ln) / len(ln)
        spans: list[tuple[float, float, str]] = []
        for wx0, wy0, wx1, wy1, txt in ln:
            if spans and (wx0 - spans[-1][1]) <= phrase_gap:
                px0, px1, ptxt = spans[-1]
                spans[-1] = (px0, max(px1, wx1), f"{ptxt} {txt}")
            else:
                spans.append((wx0, wx1, txt))
        line_spans.append((ymid, spans))

    # 3. Split header lines vs body lines
    if header_cut_y is not None:
        hdr_indices = [i for i, (ym, _) in enumerate(line_spans) if ym < header_cut_y]
        body_indices = [i for i, (ym, _) in enumerate(line_spans) if ym >= header_cut_y]
    else:
        hdr_indices = [0]
        body_indices = list(range(1, len(line_spans)))
    if not hdr_indices or not body_indices:
        return None

    # 4. Compute column intervals from body lines with >=2 spans (ignoring single-span section dividers)
    body_multi = [line_spans[i][1] for i in body_indices if len(line_spans[i][1]) >= 2]
    if not body_multi:
        return None
    # Collect all body spans and merge overlapping x-intervals to discover clean vertical column bands
    all_body_intervals = sorted((sp[0], sp[1]) for spans in body_multi for sp in spans)
    col_bands: list[list[float]] = []
    for x0, x1 in all_body_intervals:
        if col_bands and x0 <= col_bands[-1][1] + 2.0:
            col_bands[-1][1] = max(col_bands[-1][1], x1)
        else:
            col_bands.append([x0, x1])
    if len(col_bands) < 2 or len(col_bands) > 24:
        return None

    # Verify body lines align cleanly with discovered column bands (no single span spanning multiple bands)
    # Build rectangular matrix: merge multi-line wrapped header rows into 1 or 2 header rows cleanly
    def _assign_spans_to_cols(spans: list[tuple[float, float, str]]) -> list[str]:
        row = [""] * len(col_bands)
        for spx0, spx1, sptxt in spans:
            sp_mid = (spx0 + spx1) / 2.0
            best_c = -1
            best_ov = -1.0
            for ci, (bx0, bx1) in enumerate(col_bands):
                ov = min(spx1, bx1) - max(spx0, bx0)
                if ov > best_ov:
                    best_ov = ov
                    best_c = ci
            if best_ov <= 0:
                best_c = min(range(len(col_bands)), key=lambda ci: abs(sp_mid - (col_bands[ci][0] + col_bands[ci][1]) / 2.0))
            row[best_c] = _clean_cell_text((row[best_c] + " " + sptxt) if row[best_c] else sptxt)
        return row

    matrix: list[list[str]] = []
    # Check if header has 2 distinct rows (e.g., super-header + sub-header) vs single wrapped header
    hdr_rows_raw = [_assign_spans_to_cols(line_spans[i][1]) for i in hdr_indices]
    # Broadcast row-0 spans ONLY when they genuinely act as multi-column super-headers
    # (never corrupt normal 2-line wrapped single-column headers or multi-key-column labels).
    if len(hdr_rows_raw) == 2:
        r0_spans = line_spans[hdr_indices[0]][1]
        r0_nonempty = [i for i, v in enumerate(hdr_rows_raw[0]) if v]
        r1_nonempty = [i for i, v in enumerate(hdr_rows_raw[1]) if v]
        if len(r0_nonempty) < len(col_bands) and len(r1_nonempty) >= 2:
            broadcast_r0 = list(hdr_rows_raw[0])
            if 1 <= len(r0_spans) < len(col_bands):
                sorted_r0 = sorted(r0_spans, key=lambda sp: sp[0])
                # Widen each body-derived column band with its assigned row-1 sub-header span
                # so narrow numeric body values never underestimate header column widths.
                eff_bands = [list(b) for b in col_bands]
                for spx0, spx1, _sptxt in line_spans[hdr_indices[1]][1]:
                    sp_mid = (spx0 + spx1) / 2.0
                    best_c = -1
                    best_ov = -1.0
                    for ci, (bx0, bx1) in enumerate(col_bands):
                        ov = min(spx1, bx1) - max(spx0, bx0)
                        if ov > best_ov:
                            best_ov = ov
                            best_c = ci
                    if best_ov <= 0:
                        best_c = min(
                            range(len(col_bands)),
                            key=lambda ci: abs(sp_mid - (col_bands[ci][0] + col_bands[ci][1]) / 2.0),
                        )
                    eff_bands[best_c][0] = min(eff_bands[best_c][0], spx0)
                    eff_bands[best_c][1] = max(eff_bands[best_c][1], spx1)

                # Map each row-0 span to the exact effective column bands it physically overlaps (>=0.5pt)
                span_overlaps = [
                    [
                        ci for ci, (bx0, bx1) in enumerate(eff_bands)
                        if min(sp[1], bx1) - max(sp[0], bx0) > 0.5
                    ]
                    for sp in sorted_r0
                ]
                # Standalone single-column row-0 labels (e.g. "Model", "Params", or wrapped "Training\nHours")
                # own ONLY their single overlapped column and must never be treated as super-headers.
                direct_groups: list[tuple[tuple[float, float, str], list[int]]] = []
                standalone_cols: set[int] = {
                    ci for ci in range(len(col_bands)) if not hdr_rows_raw[1][ci]
                }
                gap_groups: list[tuple[tuple[float, float, str], list[int]]] = []
                for sp, ov_cols in zip(sorted_r0, span_overlaps):
                    r1_ov = [ci for ci in ov_cols if hdr_rows_raw[1][ci]]
                    if len(r1_ov) >= 2:
                        direct_groups.append((sp, r1_ov))
                        continue
                    sp_mid = (sp[0] + sp[1]) / 2.0
                    # Check if a super-header sits centered in the gap between two adjacent
                    # non-empty sub-header columns (e.g., "LibriSpeech" or "LS" centered between
                    # "clean" and "other"). A flush-left span aligned with col c's left edge
                    # (sp[0] <= eff_bands[c][0] + 2.0) is a wrapped single-column header, never a super-header.
                    gap_pair = None
                    if len(r1_ov) <= 1:
                        for c in range(len(eff_bands) - 1):
                            if (
                                eff_bands[c][1] - 1.0 <= sp_mid <= eff_bands[c + 1][0] + 1.0
                                and sp[0] > eff_bands[c][0] + 2.0
                                and sp[1] <= eff_bands[c + 1][1] + 4.0
                                and hdr_rows_raw[1][c]
                                and hdr_rows_raw[1][c + 1]
                            ):
                                gap_pair = [c, c + 1]
                                break
                    if gap_pair is not None:
                        gap_groups.append((sp, gap_pair))
                    elif len(ov_cols) == 1:
                        standalone_cols.add(ov_cols[0])

                # Apply direct multi-column overlap and gap-straddling super-headers strictly to their covered columns
                for sp, target_cols in direct_groups + gap_groups:
                    text_clean = _clean_cell_text(sp[2])
                    for ci in target_cols:
                        if ci not in standalone_cols:
                            broadcast_r0[ci] = text_clean

                # Fallback for compact super-headers centered over repeated sub-header groups of size >= 3
                # (e.g. "F1" over [200ms, 500ms, 1000ms] and "AUC" over [200ms, 500ms, 1000ms]),
                # where each short label physically overlaps only the middle column of its group.
                if not direct_groups and not gap_groups and len(sorted_r0) >= 2:
                    # Skip leading left-hand standalone columns (e.g. "Features", "Model", "Params")
                    candidate_r0 = [
                        sp for sp in sorted_r0
                        if any(
                            min(sp[1], bx1) - max(sp[0], bx0) > 0.5 and hdr_rows_raw[1][ci]
                            for ci, (bx0, bx1) in enumerate(eff_bands)
                        )
                    ]
                    if len(candidate_r0) >= 2:
                        first_cand_x0 = candidate_r0[0][0]
                        k = len(candidate_r0)
                        for start_col in range(0, len(eff_bands) - k * 2 + 1):
                            rem_cols = [c for c in range(start_col, len(eff_bands)) if hdr_rows_raw[1][c]]
                            if len(rem_cols) != len(eff_bands) - start_col:
                                continue
                            if len(rem_cols) % k != 0 or len(rem_cols) // k < 2:
                                continue
                            # Ensure all skipped leading columns sit strictly to the left of candidate_r0[0]
                            if start_col > 0 and eff_bands[start_col - 1][1] >= first_cand_x0 - 2.0:
                                continue
                            grp_sz = len(rem_cols) // k
                            chunks = [rem_cols[g * grp_sz:(g + 1) * grp_sz] for g in range(k)]
                            tuples = [tuple(hdr_rows_raw[1][c].lower() for c in ch) for ch in chunks]
                            if len(set(tuples)) != 1:
                                continue
                            # Verify each candidate super-header center sits inside its corresponding chunk x-range
                            aligned = True
                            for sp, ch in zip(candidate_r0, chunks):
                                sp_mid = (sp[0] + sp[1]) / 2.0
                                if not (eff_bands[ch[0]][0] - 4.0 <= sp_mid <= eff_bands[ch[-1]][1] + 4.0):
                                    aligned = False
                                    break
                            if aligned:
                                for sp, ch in zip(candidate_r0, chunks):
                                    text_clean = _clean_cell_text(sp[2])
                                    for ci in ch:
                                        broadcast_r0[ci] = text_clean
                                break
            merged_hdr = [
                _clean_cell_text(f"{broadcast_r0[c]} {hdr_rows_raw[1][c]}")
                for c in range(len(col_bands))
            ]
            matrix.append(merged_hdr)
        else:
            matrix.extend(hdr_rows_raw)
    elif len(hdr_rows_raw) == 1:
        matrix.append(hdr_rows_raw[0])
    else:
        # Merge 3+ wrapped header lines vertically per column
        merged_hdr = [
            _clean_cell_text(" ".join(r[c] for r in hdr_rows_raw if r[c]))
            for c in range(len(col_bands))
        ]
        matrix.append(merged_hdr)

    header_rows = list(range(len(matrix)))
    for bi in body_indices:
        spans = line_spans[bi][1]
        # Preserve semantic 1-span divider rows (e.g. "Recording-disjoint", "Speaker-disjoint")
        # as clean full-width section-label rows [label, "", ...] so split groups stay unambiguous!
        if len(spans) == 1 and not re.search(r"\d", spans[0][2]):
            divider_label = _clean_cell_text(spans[0][2])
            if 2 <= len(divider_label) <= 80:
                matrix.append([divider_label] + [""] * (len(col_bands) - 1))
            continue
        row = _assign_spans_to_cols(spans)
        if any(row):
            matrix.append(row)

    if len(matrix) <= len(header_rows) or len(matrix) < 2:
        return None
    if _is_garbled_table_matrix(matrix, header_rows):
        return None
    # Reject if any column in body is completely empty
    body_only = matrix[len(header_rows):]
    if any(all(not r[c] for r in body_only) for c in range(len(col_bands))):
        return None
    return matrix, header_rows, [sx0, sy0, sx1, sy1], best_si


def _collect_booktabs_rule_stacks(page: fitz.Page, stop_ys: list[float] | None = None) -> list[dict[str, Any]]:
    """Group horizontally aligned horizontal rules into candidate booktabs table stacks."""
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    stop_points = sorted(stop_ys or [])
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    hrules: list[tuple[float, float, float]] = []
    for d in drawings:
        r = d.get("rect")
        if r is not None:
            x0, y0, x1, y1 = float(r.x0), float(r.y0), float(r.x1), float(r.y1)
            if all(math.isfinite(v) for v in (x0, y0, x1, y1)):
                w, h = x1 - x0, y1 - y0
                if h <= 2.5 and 75.0 <= w <= page_w * 0.96 and 30.0 <= y0 and y1 <= page_h - 30.0:
                    hrules.append((x0, x1, (y0 + y1) / 2.0))
                    continue
        # Also unpack grouped multi-segment stroke paths containing individual horizontal rules
        for item in d.get("items") or ():
            if not item:
                continue
            if item[0] == "l" and len(item) >= 3:
                p1, p2 = item[1], item[2]
                if abs(float(p1.y) - float(p2.y)) <= 1.5:
                    lx0, lx1 = min(float(p1.x), float(p2.x)), max(float(p1.x), float(p2.x))
                    ly = (float(p1.y) + float(p2.y)) / 2.0
                    if 75.0 <= (lx1 - lx0) <= page_w * 0.96 and 30.0 <= ly <= page_h - 30.0:
                        hrules.append((lx0, lx1, ly))
            elif item[0] == "re" and len(item) >= 2:
                rr = item[1]
                rx0, ry0, rx1, ry1 = float(rr.x0), float(rr.y0), float(rr.x1), float(rr.y1)
                if (ry1 - ry0) <= 2.5 and 75.0 <= (rx1 - rx0) <= page_w * 0.96 and 30.0 <= ry0 and ry1 <= page_h - 30.0:
                    hrules.append((rx0, rx1, (ry0 + ry1) / 2.0))
    if len(hrules) < 2:
        return []

    # Deduplicate overlapping rules at nearly identical y & x
    hrules.sort(key=lambda item: (round(item[2], 1), round(item[0], 1)))
    dedup: list[tuple[float, float, float]] = []
    for x0, x1, ym in hrules:
        if dedup and abs(ym - dedup[-1][2]) <= 1.5 and abs(x0 - dedup[-1][0]) <= 3.0 and abs(x1 - dedup[-1][1]) <= 3.0:
            continue
        dedup.append((x0, x1, ym))

    # Booktabs \toprule/\midrule/\bottomrule for the same table share identical [x0, x1] within <=3pt.
    # Never bridge across a caption, section heading, or body prose paragraph between rules.
    stacks: list[dict[str, Any]] = []
    for x0, x1, ym in dedup:
        placed = False
        for st in stacks:
            prev_y = st["ys"][-1]
            if abs(x0 - st["x0"]) <= 3.5 and abs(x1 - st["x1"]) <= 3.5 and 0 < (ym - prev_y) <= 220.0:
                if any(prev_y + 2.0 < sy < ym - 2.0 for sy in stop_points):
                    continue
                st["x0"] = min(st["x0"], x0)
                st["x1"] = max(st["x1"], x1)
                st["ys"].append(ym)
                placed = True
                break
        if not placed:
            stacks.append({"x0": x0, "x1": x1, "ys": [ym]})

    valid: list[dict[str, Any]] = []
    for st in stacks:
        if len(st["ys"]) >= 2 and (st["ys"][-1] - st["ys"][0]) >= 22.0:
            st["bbox"] = [st["x0"], st["ys"][0], st["x1"], st["ys"][-1]]
            valid.append(st)
    return valid


def _extract_pdf_tables(doc: fitz.Document, pdf_sha: str) -> list[dict[str, Any]]:
    """Extract clean structured rectangular tables anchored to printed Table captions."""
    tables: list[dict[str, Any]] = []
    seen_numbers: set[str] = set()
    ordinal = 0

    for page in doc:
        if len(tables) >= MAX_TABLES:
            break
        tab_captions = _collect_page_captions(page, "table")
        if not tab_captions:
            continue

        page_w = float(page.rect.width)
        stop_ys: list[float] = []
        for cap in tab_captions:
            stop_ys.append((cap["bbox"][1] + cap["bbox"][3]) / 2.0)
        for blk in page.get_text("blocks", flags=fitz.TEXTFLAGS_TEXT):
            if blk[6] != 0:
                continue
            bx0, by0, bx1, by1, btxt = float(blk[0]), float(blk[1]), float(blk[2]), float(blk[3]), str(blk[4] or "")
            if _is_body_prose_block(btxt, (bx0, by0, bx1, by1), page_w):
                stop_ys.append((by0 + by1) / 2.0)
        rule_stacks = _collect_booktabs_rule_stacks(page, stop_ys=stop_ys)
        used_stacks: set[int] = set()

        # Also run PyMuPDF strict ruled grid finder (with stdout silenced!) for fully gridded tables only.
        # Never use non-strict "lines", which invents noisy vertical cuts on borderless booktabs tables.
        found_grid_tabs = []
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                finder = page.find_tables(vertical_strategy="lines_strict", horizontal_strategy="lines_strict")
                if finder and finder.tables:
                    found_grid_tabs = list(finder.tables)
            except Exception:
                found_grid_tabs = []
        used_grid_idxs: set[int] = set()

        for cap in tab_captions:
            if cap["number"] in seen_numbers:
                continue

            matrix: list[list[str]] | None = None
            header_rows: list[int] = [0]
            tab_bbox: list[float] | None = None

            # Primary 1: Booktabs horizontal-rule + phrase-span column clustering (best for academic LaTeX tables)
            if rule_stacks:
                bt = _extract_booktabs_table_from_rules(page, cap, rule_stacks, used_stacks)
                if bt is not None:
                    matrix, header_rows, tab_bbox, si = bt
                    used_stacks.add(si)

            # Primary 2: PyMuPDF strict ruled grid table fallback (for boxed/shaded tables without booktabs stacks)
            if matrix is None:
                cx0, cy0, cx1, cy1 = cap["bbox"]
                best_gi = -1
                best_gdist = 1e9
                for gi, gtab in enumerate(found_grid_tabs):
                    if gi in used_grid_idxs:
                        continue
                    tx0, ty0, tx1, ty1 = map(float, gtab.bbox)
                    if min(cx1, tx1) - max(cx0, tx0) < 20.0:
                        continue
                    if ty0 >= cy1 - 8.0 and (ty0 - cy1) <= 85.0:
                        dist = ty0 - cy1
                    elif cy0 >= ty1 - 8.0 and (cy0 - ty1) <= 85.0:
                        dist = (cy0 - ty1) + 25.0
                    else:
                        continue
                    if dist < best_gdist:
                        best_gdist = dist
                        best_gi = gi

                if best_gi >= 0:
                    raw_rows = found_grid_tabs[best_gi].extract()
                    if raw_rows and len(raw_rows) >= 2:
                        width = max(len(r) for r in raw_rows)
                        if 2 <= width <= 32 and len(raw_rows) <= 128:
                            cand = [
                                [_clean_cell_text(r[c] if c < len(r) else "") for c in range(width)]
                                for r in raw_rows
                            ]
                            cand = [r for r in cand if any(r)]
                            if len(cand) >= 2:
                                non_empty = sum(1 for r in cand for c in r if c)
                                avg_len = sum(len(c) for r in cand for c in r if c) / max(1, non_empty)
                                cand_hdr = [0]
                                if len(cand) >= 3:
                                    r1_num = sum(1 for c in cand[1][1:] if re.search(r"\d", c))
                                    r2_num = sum(1 for c in cand[2][1:] if re.search(r"\d", c))
                                    if r1_num == 0 and r2_num >= max(1, (width - 1) // 2) and sum(1 for c in cand[1] if c) >= 2:
                                        cand_hdr = [0, 1]
                                if (
                                    non_empty / max(1, len(cand) * width) >= 0.45
                                    and avg_len <= 85.0
                                    and not _is_garbled_table_matrix(cand, cand_hdr)
                                ):
                                    matrix = cand
                                    header_rows = cand_hdr
                                    tab_bbox = [round(float(v), 2) for v in found_grid_tabs[best_gi].bbox]
                                    used_grid_idxs.add(best_gi)

            if matrix is None or tab_bbox is None:
                continue

            body_rows = [r_idx for r_idx in range(len(matrix)) if r_idx not in header_rows]
            if not body_rows:
                continue

            seen_numbers.add(cap["number"])
            ordinal += 1
            cells = []
            for r_idx, row in enumerate(matrix):
                is_hdr = r_idx in header_rows
                for c_idx, txt in enumerate(row):
                    cells.append({
                        "row": r_idx,
                        "column": c_idx,
                        "header": is_hdr,
                        "rowspan": 1,
                        "colspan": 1,
                        "text": txt,
                        "sourceDomSha256": _sha256_text(f"{pdf_sha}:table:{ordinal}:p{page.number + 1}:r{r_idx}:c{c_idx}:{txt}"),
                    })
            table_sig = _sha256_text(json.dumps({
                "contract": PDF_TABLE_EXTRACT_CONTRACT,
                "pdfSha256": pdf_sha,
                "page": page.number + 1,
                "bbox": [round(float(v), 2) for v in tab_bbox],
                "label": cap["label"],
                "caption": cap["caption"],
                "matrix": matrix,
            }, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
            tables.append({
                "ordinal": ordinal,
                "label": cap["label"],
                "caption": cap["caption"],
                "sourceDomSha256": table_sig,
                "headerRows": header_rows,
                "bodyRows": body_rows,
                "cells": cells,
                "matrix": matrix,
                "recoveryStatus": "complete",
            })
    return tables


def _canonical_bbox(bbox: list[float] | tuple[float, float, float, float]) -> list[int | float]:
    out: list[int | float] = []
    for v in bbox:
        rv = round(float(v), 2)
        if rv == 0.0:
            out.append(0)
        elif rv.is_integer():
            out.append(int(rv))
        else:
            out.append(rv)
    return out


def _canonical_crop_sha256(
    pdf_sha: str,
    page_num: int,
    bbox: list[float] | tuple[float, float, float, float],
    dpi: int,
) -> str:
    """Language-neutral crop hash (fixed 2-decimal bbox strings, identical in Python and JS)."""
    norm_bbox = []
    for v in bbox:
        rv = round(float(v), 2)
        if rv == 0.0:
            rv = 0.0
        norm_bbox.append(f"{rv:.2f}")
    crop_meta = {
        "bbox": norm_bbox,
        "cropContract": PDF_FIGURE_CROP_CONTRACT,
        "dpi": int(dpi),
        "page": int(page_num),
        "pdfSha256": str(pdf_sha),
    }
    return _sha256_text(json.dumps(crop_meta, sort_keys=True, separators=(",", ":")))


def pdf_crop_source_descriptor(resource: Any, arxiv_id: str = "") -> dict[str, str]:
    """Cryptographically validate a pdf_crop resource descriptor and its paper-bound URL."""
    from urllib.parse import urlparse

    if not isinstance(resource, dict):
        raise ValueError("PDF 裁切图资源必须是对象")
    if (
        resource.get("kind") != "pdf_crop"
        or resource.get("cropContract") != PDF_FIGURE_CROP_CONTRACT
        or resource.get("mediaType") != "image/png"
    ):
        raise ValueError("PDF 裁切图资源类型或协议标识无效")
    pdf_sha = resource.get("pdfSha256")
    crop_sha = resource.get("cropSha256")
    if not isinstance(pdf_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", pdf_sha):
        raise ValueError("PDF 裁切图缺少有效的 pdfSha256")
    if not isinstance(crop_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", crop_sha):
        raise ValueError("PDF 裁切图缺少有效的 cropSha256")
    page_num = resource.get("page")
    dpi = resource.get("dpi")
    if type(page_num) is not int or page_num < 1:
        raise ValueError("PDF 裁切图页码必须是正整数")
    if type(dpi) is not int or not (72 <= dpi <= 432):
        raise ValueError("PDF 裁切图 DPI 超出受控范围")
    bbox = resource.get("bbox")
    if (
        not isinstance(bbox, list)
        or len(bbox) != 4
        or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)) for v in bbox)
        or float(bbox[0]) >= float(bbox[2])
        or float(bbox[1]) >= float(bbox[3])
    ):
        raise ValueError("PDF 裁切图坐标 bbox 无效")
    expected_sha = _canonical_crop_sha256(pdf_sha, page_num, bbox, dpi)
    if expected_sha != crop_sha:
        raise ValueError("PDF 裁切图 cropSha256 与规范几何元数据不符")
    url = str(resource.get("url") or "").strip()
    parsed = urlparse(url)
    clean_id = re.sub(r"^arxiv:", "", str(arxiv_id or "").strip(), flags=re.IGNORECASE)
    clean_id = re.sub(r"v\d+$", "", clean_id, flags=re.IGNORECASE).lower()
    path_match = re.fullmatch(r"/pdf/(\d{4}\.\d{4,5}|[a-f0-9]{12})\.pdf", parsed.path, re.IGNORECASE)
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in {"arxiv.org", "www.arxiv.org"}
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.params)
        or bool(parsed.query)
        or not path_match
        or (clean_id and re.fullmatch(r"\d{4}\.\d{4,5}", clean_id) and path_match.group(1).lower() != clean_id)
        or not re.fullmatch(r"pd-pdf-figure-\d+-[a-f0-9]{16}", parsed.fragment or "")
        or not (parsed.fragment or "").endswith(f"-{crop_sha[:16]}")
    ):
        raise ValueError("PDF 裁切图 URL 与论文身份或 cropSha256 不符")
    return {
        "url": url,
        "sourceLocationUrl": url,
        "pdfCropSourceSha256": crop_sha,
        "pdfCropContract": PDF_FIGURE_CROP_CONTRACT,
    }


def extract_pdf_figures_and_tables(pdf_bytes: bytes, arxiv_id: str = "") -> dict[str, Any]:
    """Deterministically extract figure crop descriptors (NO bytes) and tables from a PDF."""
    if not isinstance(pdf_bytes, (bytes, bytearray)) or len(pdf_bytes) < 5 or len(pdf_bytes) > MAX_PDF_BYTES or not bytes(pdf_bytes).startswith(b"%PDF-"):
        raise ValueError("Invalid PDF bytes")
    raw = bytes(pdf_bytes)
    pdf_sha = _sha256_bytes(raw)
    clean_id = re.sub(r"^arxiv:", "", str(arxiv_id or "").strip(), flags=re.IGNORECASE)
    clean_id = re.sub(r"v\d+$", "", clean_id, flags=re.IGNORECASE).lower()

    doc = fitz.open(stream=raw, filetype="pdf")
    try:
        if doc.needs_pass or len(doc) == 0:
            return {"pdfSha256": pdf_sha, "figures": [], "tables": []}

        figures: list[dict[str, Any]] = []
        seen_fig_nums: set[str] = set()
        ordinal = 0

        for page in doc:
            if len(figures) >= MAX_FIGURES:
                break
            if page.rotation != 0:
                continue
            fig_caps = _collect_page_captions(page, "figure")
            if not fig_caps:
                continue
            tab_caps = _collect_page_captions(page, "table")
            all_caps = fig_caps + tab_caps
            text_blocks = [
                (float(b[0]), float(b[1]), float(b[2]), float(b[3]), str(b[4] or ""))
                for b in page.get_text("blocks", flags=fitz.TEXTFLAGS_TEXT)
                if b[6] == 0
            ]
            visual_rects = _collect_visual_rects(page)
            if not visual_rects:
                continue

            for cap in fig_caps:
                if cap["number"] in seen_fig_nums:
                    continue
                crop_bbox = _extract_figure_crop_bbox(page, cap, all_caps, text_blocks, visual_rects)
                if crop_bbox is None:
                    continue
                seen_fig_nums.add(cap["number"])
                ordinal += 1
                page_num = page.number + 1
                norm_bbox = _canonical_bbox(crop_bbox)
                crop_sha = _canonical_crop_sha256(pdf_sha, page_num, norm_bbox, DEFAULT_DPI)
                url_id = clean_id or pdf_sha[:12]
                canonical_url = f"https://arxiv.org/pdf/{url_id}.pdf#pd-pdf-figure-{ordinal}-{crop_sha[:16]}"
                fig_dom_sha = _sha256_text(json.dumps({
                    "kind": "pdf_crop",
                    "cropSha256": crop_sha,
                    "label": cap["label"],
                    "caption": cap["caption"],
                }, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
                figures.append({
                    "ordinal": ordinal,
                    "label": cap["label"],
                    "caption": cap["caption"],
                    "images": [{
                        "kind": "pdf_crop",
                        "url": canonical_url,
                        "alt": cap["caption"][:256],
                        "mediaType": "image/png",
                        "rasterDownloadEligible": False,
                        "cropContract": PDF_FIGURE_CROP_CONTRACT,
                        "pdfSha256": pdf_sha,
                        "page": page_num,
                        "bbox": norm_bbox,
                        "dpi": DEFAULT_DPI,
                        "cropSha256": crop_sha,
                    }],
                    "sourceDomSha256": fig_dom_sha,
                    "recoveryStatus": "complete",
                })

        tables = _extract_pdf_tables(doc, pdf_sha)
        return {
            "pdfSha256": pdf_sha,
            "figures": figures,
            "tables": tables,
        }
    finally:
        doc.close()


def render_pdf_figure_crop_png(
    pdf_bytes: bytes,
    page_num: int,
    bbox: list[float] | tuple[float, float, float, float],
    dpi: int = DEFAULT_DPI,
) -> bytes:
    """Deterministically render a validated PDF figure crop rectangle as crisp white-background PNG."""
    if not isinstance(pdf_bytes, (bytes, bytearray)) or len(pdf_bytes) < 5 or len(pdf_bytes) > MAX_PDF_BYTES or not bytes(pdf_bytes).startswith(b"%PDF-"):
        raise ValueError("Invalid PDF bytes")
    if not isinstance(page_num, int) or page_num < 1:
        raise ValueError("Invalid 1-based page number")
    coords = [float(v) for v in bbox]
    if len(coords) != 4 or not all(math.isfinite(v) for v in coords) or coords[0] >= coords[2] or coords[1] >= coords[3]:
        raise ValueError("Invalid crop bbox")
    target_dpi = max(72, min(432, int(dpi or DEFAULT_DPI)))

    doc = fitz.open(stream=bytes(pdf_bytes), filetype="pdf")
    try:
        if page_num > len(doc):
            raise ValueError(f"Page {page_num} out of range (1..{len(doc)})")
        page = doc[page_num - 1]
        clip = fitz.Rect(coords[0], coords[1], coords[2], coords[3]) & page.rect
        if clip.is_empty or clip.width < 10.0 or clip.height < 10.0:
            raise ValueError("Empty clip rectangle")
        scale = target_dpi / 72.0
        w_px = clip.width * scale
        h_px = clip.height * scale
        if max(w_px, h_px) > MAX_LONG_EDGE_PX:
            scale *= MAX_LONG_EDGE_PX / max(w_px, h_px)
            w_px = clip.width * scale
            h_px = clip.height * scale
        if w_px * h_px > MAX_PIXELS:
            scale *= math.sqrt(MAX_PIXELS / (w_px * h_px))
        for _attempt in range(3):
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip, alpha=False)
            png = pix.tobytes("png")
            if png.startswith(b"\x89PNG\r\n\x1a\n") and len(png) <= MAX_OUTPUT_BYTES:
                w, h = struct.unpack(">II", png[16:24])
                if w > 0 and h > 0:
                    return png
            scale *= 0.78
        raise ValueError("Rendered PDF figure crop exceeded size limit")
    finally:
        doc.close()


def _parse_crop_spec(spec: str) -> tuple[int, list[float]]:
    if ":" not in spec:
        raise ValueError("Crop spec must be page:x0,y0,x1,y1")
    page_part, rect_part = spec.split(":", 1)
    page_num = int(page_part.strip())
    coords = [float(x.strip()) for x in rect_part.split(",")]
    if len(coords) != 4:
        raise ValueError("Crop bbox must have 4 comma-separated floats")
    return page_num, coords


def main() -> int:
    require_external_runtime("pdf-figure-table-extract")
    ap = argparse.ArgumentParser(description="Deterministic PDF figure crop & table extractor")
    ap.add_argument("--pdf", required=True, help="Path to sealed PDF file")
    ap.add_argument("--arxiv-id", default="", help="Optional arXiv ID for canonical pdf_crop URLs")
    ap.add_argument("--json", action="store_true", help="Output extracted figure descriptors and tables as JSON")
    ap.add_argument("--render-crop", default="", help="Render crop as PNG to stdout: page:x0,y0,x1,y1")
    ap.add_argument("--dpi", type=int, default=DEFAULT_DPI, help="Target DPI for --render-crop (default 288)")
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    if pdf_path.is_symlink() or not pdf_path.is_file():
        raise ValueError("PDF 路径必须是普通文件且不得是符号链接")
    pdf_size = pdf_path.stat().st_size
    if pdf_size < 5 or pdf_size > MAX_PDF_BYTES:
        raise ValueError("PDF 文件大小超出受控上限")
    pdf_bytes = pdf_path.read_bytes()
    if args.render_crop:
        page_num, bbox = _parse_crop_spec(args.render_crop)
        png = render_pdf_figure_crop_png(pdf_bytes, page_num, bbox, dpi=args.dpi)
        sys.stdout.buffer.write(png)
        return 0
    result = extract_pdf_figures_and_tables(pdf_bytes, arxiv_id=args.arxiv_id)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Shared Python engine for scoring rubric `type-aware-v2`.

Loads `config/scoring-rubric-v2.json` and mirrors `scripts/lib/scoring-rubric-v2.js`
using exact integer thousandths arithmetic so Python and Node.js agree bit-for-bit.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

SPEC_PATH = Path(__file__).resolve().parent.parent / "config" / "scoring-rubric-v2.json"
SPEC: dict[str, Any] = json.loads(SPEC_PATH.read_text(encoding="utf-8"))

SCORING_RUBRIC_V1: str = SPEC["legacyRubricVersion"]
SCORING_RUBRIC_V2: str = SPEC["rubricVersion"]
SUPPORTED_SCORING_RUBRIC_VERSIONS = frozenset({SCORING_RUBRIC_V1, SCORING_RUBRIC_V2})

_ALL_DIMS_BY_KEY: dict[str, dict[str, Any]] = {
    **{item["key"]: {**item, "max": float(SPEC["scaleMax"]), "isCore": True} for item in SPEC["coreDimensions"]},
    SPEC["openSourceDimension"]["key"]: {
        **SPEC["openSourceDimension"],
        "max": float(SPEC["scaleMax"]),
        "isCore": False,
    },
}

V2_DIMENSIONS: tuple[dict[str, Any], ...] = tuple(_ALL_DIMS_BY_KEY[k] for k in SPEC["dimensionDisplayOrder"])
V2_CORE_DIMENSIONS: tuple[dict[str, Any], ...] = tuple(_ALL_DIMS_BY_KEY[item["key"]] for item in SPEC["coreDimensions"])
V2_OPEN_SOURCE_ANCHORS: tuple[float, ...] = tuple(float(v) for v in SPEC["openSourceDimension"]["anchors"])
V2_OPEN_SOURCE_RELEASED_THRESHOLD: float = float(SPEC["openSourceDimension"]["releasedThreshold"])
V2_SCORE_DIMENSIONS: dict[str, dict[str, Any]] = {
    item["parsedField"]: {"label": item["label"], "max": float(item["max"]), "shortLabel": item["shortLabel"]}
    for item in V2_DIMENSIONS
}
V2_PUBLISH_DIMENSIONS: tuple[tuple[str, str, float], ...] = tuple(
    (item["parsedField"], item["label"], float(item["max"])) for item in V2_DIMENSIONS
)
V2_PRESENTATION_DIMENSIONS: tuple[tuple[str, str, str], ...] = tuple(
    (item["parsedField"], item["shortLabel"], "10") for item in V2_DIMENSIONS
)


def is_v2_rubric(version: Any) -> bool:
    return str(version or "").strip() == SCORING_RUBRIC_V2


def normalize_tenths(value: Any) -> int:
    if value is None or isinstance(value, bool):
        raise ValueError(f"无效分值: {value!r}")
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            raise ValueError(f"无效分值: {value!r}")
        raw_str = stripped
    else:
        raw_str = str(value)
    try:
        num = float(raw_str)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"无效分值: {value!r}") from exc
    if not math.isfinite(num):
        raise ValueError(f"无效分值: {value!r}")
    return int((Decimal(raw_str) * Decimal("10")).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def is_v2_open_source_anchor(value: Any) -> bool:
    try:
        tenths = normalize_tenths(value)
    except (ValueError, TypeError):
        return False
    return any(int(round(anchor * 10)) == tenths for anchor in V2_OPEN_SOURCE_ANCHORS)


def get_document_type_policy(document_type: Any) -> dict[str, Any]:
    key = str(document_type or "").strip()
    policy = SPEC["documentTypes"].get(key)
    if not policy:
        raise ValueError(f"type-aware-v2 不支持的文档类型: {key!r}")
    return policy


def rank_bucket_for_v2_score(score: Any) -> str:
    tenths = normalize_tenths(score)
    for bucket in SPEC["rankBuckets"]:
        if tenths >= int(round(float(bucket["minScore"]) * 10)):
            return str(bucket["label"])
    return "后50%"


def rank_bucket_for_rubric(score: Any, rubric_version: Any = SCORING_RUBRIC_V1) -> str:
    if is_v2_rubric(rubric_version):
        return rank_bucket_for_v2_score(score)
    tenths = normalize_tenths(score)
    if tenths >= 90:
        return "前10%"
    if tenths >= 75:
        return "前25%"
    if tenths >= 55:
        return "前50%"
    return "后50%"


def calculate_v2_weighted_total(document_type: Any, scores_map: dict[str, Any]) -> dict[str, Any]:
    """Compute exact type-aware-v2 total score with integer thousandths math matching JS bit-for-bit."""
    policy = get_document_type_policy(document_type)

    def read_dim(dim: dict[str, Any]) -> int:
        raw = None
        for key in (dim["key"], dim["parsedField"], dim["machineKey"]):
            if key in scores_map and scores_map[key] not in (None, ""):
                raw = scores_map[key]
                break
        if isinstance(raw, dict):
            raw = raw.get("score")
        tenths = normalize_tenths(raw)
        if tenths < 0 or tenths > 100:
            raise ValueError(f"type-aware-v2 维度 {dim['key']} 分数越界: {raw!r}")
        return tenths

    core_scaled = 0
    for dim in V2_CORE_DIMENSIONS:
        weight_pct = int(policy["coreWeightPct"][dim["key"]])
        core_scaled += weight_pct * read_dim(dim)
    open_source_tenths = read_dim(_ALL_DIMS_BY_KEY["openSource"])
    bonus_tenths = int(policy["openSourceMaxBonusTenths"])
    bonus_scaled = open_source_tenths * bonus_tenths
    raw_total_scaled = core_scaled + bonus_scaled
    total_tenths = min(100, (raw_total_scaled + 50) // 100)
    total = total_tenths / 10.0
    return {
        "coreWeighted": round(core_scaled / 1000.0, 3),
        "openSourceBonus": round(bonus_scaled / 1000.0, 3),
        "openSourceMaxBonus": bonus_tenths / 10.0,
        "rawTotal": round(raw_total_scaled / 1000.0, 3),
        "total": total,
        "rankBucket": rank_bucket_for_v2_score(total),
    }

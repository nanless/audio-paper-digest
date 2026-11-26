#!/usr/bin/env python3
"""Shared Python engine for the unified type-aware scoring rubric.

Loads `config/scoring-rubric.json` and mirrors `scripts/lib/scoring-rubric.js`
using exact integer thousandths arithmetic so Python and Node.js agree bit-for-bit.
"""

from __future__ import annotations

if __name__ == "__main__":
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit("This pure helper is imported by the normal pipeline, not a direct CLI.")

import json
import math
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

SPEC_PATH = Path(__file__).resolve().parent.parent / "config" / "scoring-rubric.json"
SPEC: dict[str, Any] = json.loads(SPEC_PATH.read_text(encoding="utf-8"))

LEGACY_SCORING_RUBRIC: str = SPEC["legacyRubricVersion"]
CURRENT_SCORING_RUBRIC: str = SPEC["rubricVersion"]
HISTORICAL_UNIFIED_SCORING_RUBRICS: tuple[str, ...] = ("type-aware-v2",)
UNIFIED_SCORING_RUBRIC_VERSIONS = frozenset({CURRENT_SCORING_RUBRIC, *HISTORICAL_UNIFIED_SCORING_RUBRICS})
SUPPORTED_SCORING_RUBRIC_VERSIONS = frozenset({LEGACY_SCORING_RUBRIC, *HISTORICAL_UNIFIED_SCORING_RUBRICS, CURRENT_SCORING_RUBRIC})

_ALL_DIMS_BY_KEY: dict[str, dict[str, Any]] = {
    **{item["key"]: {**item, "max": float(SPEC["scaleMax"]), "isCore": True} for item in SPEC["coreDimensions"]},
    SPEC["openSourceDimension"]["key"]: {
        **SPEC["openSourceDimension"],
        "max": float(SPEC["scaleMax"]),
        "isCore": False,
    },
}

UNIFIED_DIMENSIONS: tuple[dict[str, Any], ...] = tuple(_ALL_DIMS_BY_KEY[k] for k in SPEC["dimensionDisplayOrder"])
UNIFIED_CORE_DIMENSIONS: tuple[dict[str, Any], ...] = tuple(_ALL_DIMS_BY_KEY[item["key"]] for item in SPEC["coreDimensions"])
UNIFIED_OPEN_SOURCE_ANCHORS: tuple[float, ...] = tuple(float(v) for v in SPEC["openSourceDimension"]["anchors"])
UNIFIED_OPEN_SOURCE_RELEASED_THRESHOLD: float = float(SPEC["openSourceDimension"]["releasedThreshold"])
UNIFIED_SCORE_DIMENSIONS: dict[str, dict[str, Any]] = {
    item["parsedField"]: {"label": item["label"], "max": float(item["max"]), "shortLabel": item["shortLabel"]}
    for item in UNIFIED_DIMENSIONS
}
UNIFIED_PUBLISH_DIMENSIONS: tuple[tuple[str, str, float], ...] = tuple(
    (item["parsedField"], item["label"], float(item["max"])) for item in UNIFIED_DIMENSIONS
)
UNIFIED_PRESENTATION_DIMENSIONS: tuple[tuple[str, str, str], ...] = tuple(
    (item["parsedField"], item["shortLabel"], "10") for item in UNIFIED_DIMENSIONS
)
CALIBRATION_PROFILE: str = str(SPEC.get("calibrationProfile") or "audio-rubric-calibration").strip() or "audio-rubric-calibration"
CALIBRATION_ANCHORS: tuple[dict[str, Any], ...] = tuple(
    dict(card) for card in (SPEC.get("calibrationAnchors") or []) if isinstance(card, dict)
)
DOMAIN_RED_LINES: tuple[dict[str, Any], ...] = tuple(
    dict(item) for item in (SPEC.get("domainRedLines") or []) if isinstance(item, dict)
)
_COMPACT_WEIGHT_LABELS: dict[str, str] = {
    "innovation": "创新",
    "technicalRigor": "严谨",
    "experimentalSufficiency": "实验",
    "clarity": "清晰",
    "impact": "影响",
    "reproducibility": "复现",
    "engineering": "工程",
}


def is_unified_rubric(version: Any) -> bool:
    return str(version or "").strip() in UNIFIED_SCORING_RUBRIC_VERSIONS


def is_legacy_rubric(version: Any) -> bool:
    return str(version or "").strip() == LEGACY_SCORING_RUBRIC


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


def is_open_source_anchor(value: Any) -> bool:
    try:
        tenths = normalize_tenths(value)
    except (ValueError, TypeError):
        return False
    return any(int(round(anchor * 10)) == tenths for anchor in UNIFIED_OPEN_SOURCE_ANCHORS)


def get_document_type_policy(document_type: Any) -> dict[str, Any]:
    key = str(document_type or "").strip()
    policy = SPEC["documentTypes"].get(key)
    if not policy:
        raise ValueError(f"{CURRENT_SCORING_RUBRIC} 不支持的文档类型: {key!r}")
    return policy


def format_document_type_weights_summary(document_type: Any) -> str:
    key = str(document_type or "").strip()
    policy = SPEC["documentTypes"].get(key)
    if not policy:
        return ""
    parts = [
        f"{_COMPACT_WEIGHT_LABELS.get(dim['key'], dim.get('shortLabel') or dim['label'])} {int(policy['coreWeightPct'][dim['key']])}%"
        for dim in UNIFIED_CORE_DIMENSIONS
    ]
    bonus = int(policy["openSourceMaxBonusTenths"]) / 10.0
    return f"{' · '.join(parts)}（开源上限加分 +{bonus:.1f}）"


def rank_bucket_for_score(score: Any) -> str:
    tenths = normalize_tenths(score)
    for bucket in SPEC["rankBuckets"]:
        if tenths >= int(round(float(bucket["minScore"]) * 10)):
            return str(bucket["label"])
    return "后50%"


def rank_bucket_for_rubric(score: Any, rubric_version: Any = LEGACY_SCORING_RUBRIC) -> str:
    if is_unified_rubric(rubric_version):
        return rank_bucket_for_score(score)
    tenths = normalize_tenths(score)
    if tenths >= 90:
        return "前10%"
    if tenths >= 75:
        return "前25%"
    if tenths >= 55:
        return "前50%"
    return "后50%"


def calculate_weighted_total(document_type: Any, scores_map: dict[str, Any]) -> dict[str, Any]:
    """Compute exact unified type-aware total score with integer thousandths math matching JS bit-for-bit."""
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
            raise ValueError(f"{CURRENT_SCORING_RUBRIC} 维度 {dim['key']} 分数越界: {raw!r}")
        return tenths

    core_scaled = 0
    for dim in UNIFIED_CORE_DIMENSIONS:
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
        "rankBucket": rank_bucket_for_score(total),
    }

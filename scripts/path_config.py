#!/usr/bin/env python3
"""Shared Python-side project and runtime data paths."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
CURRENT_DIR = DATA_DIR / "current"
ARCHIVE_DIR = DATA_DIR / "archive"
LOGS_DIR = PROJECT_ROOT / "logs"

PAPERS_FILE = CURRENT_DIR / "papers.json"
PAPERS_LEGACY_FILE = DATA_DIR / "papers.json"
RAW_CANDIDATES_FILE = CURRENT_DIR / "raw-candidates.json"
FILTER_DECISIONS_FILE = CURRENT_DIR / "filter-decisions.json"
FILTERED_PAPERS_FILE = CURRENT_DIR / "filtered-papers.json"
DEEP_ANALYSIS_RESULT_FILE = CURRENT_DIR / "deep-analysis-result.json"
DEEP_ANALYSIS_RESULT_LEGACY_FILE = DATA_DIR / "deep-analysis-result.json"
ANALYZED_FILE = CURRENT_DIR / "analyzed.json"
ANALYZED_LEGACY_FILE = DATA_DIR / "analyzed.json"


def resolve_deep_analysis_result_path(current_path=DEEP_ANALYSIS_RESULT_FILE, legacy_path=DEEP_ANALYSIS_RESULT_LEGACY_FILE):
    if current_path.exists() or not legacy_path.exists():
        return current_path
    return legacy_path


def xiaohongshu_markdown_path(target_date, suffix):
    return CURRENT_DIR / f"xiaohongshu-{target_date}-{suffix}.md"


def wechat_preview_path(target_date):
    return CURRENT_DIR / f"wechat-preview-{target_date}.html"


def backfill_result_path():
    return DATA_DIR / "backfill-result.json"

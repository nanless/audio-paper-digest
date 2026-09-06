#!/usr/bin/env python3
"""CLI for a source-only historical-page ledger and paired receipt."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from runtime_guard import require_external_runtime
from project_env import load_project_env
from historical_page_scan import (
    DEFAULT_OUTPUT_DIR,
    HistoricalPageInventoryError,
    SAFE_JSON_NAME,
    scan_historical_pages,
    write_inventory_pair,
)


USAGE = "--dry-run | --apply --ledger NAME.json --receipt NAME.json"


def parse_args(argv: list[str]) -> dict[str, object]:
    if argv == ["--dry-run"]:
        return {"apply": False, "ledgerName": None, "receiptName": None}
    if (len(argv) == 5 and argv[0] == "--apply" and argv[1] == "--ledger"
            and argv[3] == "--receipt" and SAFE_JSON_NAME.fullmatch(argv[2] or "")
            and SAFE_JSON_NAME.fullmatch(argv[4] or "") and argv[2] != argv[4]):
        return {"apply": True, "ledgerName": argv[2], "receiptName": argv[4]}
    raise HistoricalPageInventoryError(f"usage: {USAGE}")


def _configured_blog_repo() -> Path:
    value = os.environ.get("PAPER_DIGEST_BLOG_REPO")
    if not value:
        raise HistoricalPageInventoryError("PAPER_DIGEST_BLOG_REPO is required")
    return Path(value).expanduser().absolute()


def main(argv=None, *, blog_repo=None, output_dir=None):
    require_external_runtime("history-inventory.py")
    options = parse_args(list(sys.argv[1:] if argv is None else argv))
    if blog_repo is None:
        load_project_env()
        blog_repo = _configured_blog_repo()
    ledger = scan_historical_pages(Path(blog_repo), require_clean_main=bool(options["apply"]),
                                   remote_name=os.environ.get("PAPER_DIGEST_GITHUB_REMOTE", "origin"))
    outputs = {"ledger": None, "receipt": None}
    if options["apply"]:
        outputs = write_inventory_pair(Path(output_dir or DEFAULT_OUTPUT_DIR),
                                       str(options["ledgerName"]), str(options["receiptName"]), ledger,
                                       expected_repo=Path(blog_repo),
                                       remote_name=os.environ.get("PAPER_DIGEST_GITHUB_REMOTE", "origin"))
    result = {"status": "written" if options["apply"] else "dry-run",
              "pages": ledger["counts"]["pages"], "papers": ledger["counts"]["papers"],
              "head": ledger["source"]["head"], "pageSetSha256": ledger["pageSetSha256"], **outputs}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return result


if __name__ == "__main__":
    try:
        main()
    except (HistoricalPageInventoryError, OSError) as exc:
        print(f"[history-inventory] {exc}", file=sys.stderr)
        raise SystemExit(1)

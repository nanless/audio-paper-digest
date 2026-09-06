#!/usr/bin/env python3
"""CLI for immutable text-only extraction of one staged conference PDF."""

import json
import sys

from runtime_guard import require_external_runtime
from conference_extractor import ConferenceExtractionError, parse_args, run_extraction, verify_extraction


def main(argv=None):
    require_external_runtime("conference-extract.py")
    mode, manifest_name, source_root = parse_args(list(sys.argv[1:] if argv is None else argv))
    result = (verify_extraction(manifest_name, source_root=source_root)
              if mode == "verify"
              else run_extraction(manifest_name, apply=mode == "apply", source_root=source_root))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return result


if __name__ == "__main__":
    try:
        main()
    except ConferenceExtractionError as exc:
        print(f"[conference-extract] {exc}", file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
"""CLI for immutable text-only extraction of one staged conference PDF."""

import json
import sys

from runtime_guard import require_external_runtime
from conference_extractor import ConferenceExtractionError, parse_args, run_extraction, verify_extraction


def main(argv=None):
    # Reject a sandboxed direct invocation before even parsing CLI arguments.
    # The second, mode-aware check below adds the history role for mutating
    # modes while allowing pinned read-only replay from an already guarded flow.
    require_external_runtime("conference-extraction-replay")
    mode, manifest_name, source_root = parse_args(list(sys.argv[1:] if argv is None else argv))
    # Verification is also used as a pinned, read-only replay inside already
    # role-gated Node production flows.  Apply/dry-run remain direct history
    # entrypoints; npm wrappers additionally bind every mode to history.
    require_external_runtime(
        "conference-extract.py" if mode != "verify" else "conference-extraction-replay"
    )
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

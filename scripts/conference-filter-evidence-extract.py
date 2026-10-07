#!/usr/bin/env python3
"""按工作区角色放行的适配层，在证据项根目录里调用现有的确定性抽取器。"""

import json
import sys
from pathlib import Path

from conference_extractor import (ConferenceExtractionError, run_extraction,
    verify_blocked_extraction, verify_extraction)
from runtime_guard import require_external_runtime


def parse_args(argv):
    if (len(argv) != 5 or argv[0] not in {"--apply", "--verify"}
            or argv[1] != "--manifest" or argv[3] != "--source-root"):
        raise ConferenceExtractionError(
            "usage: --apply|--verify --manifest NAME.json --source-root ABS")
    root = Path(argv[4])
    if not root.is_absolute():
        raise ConferenceExtractionError("source root must be absolute")
    return argv[0][2:], argv[2], root


def main(argv=None):
    # 直接执行时只认这个日更专用的入口名。这里若传底层抽取器的名字，
    # runtime_guard 的直接命令识别就会在缺少 Node 包装层时漏掉这个适配层。
    require_external_runtime("conference-filter-evidence-extract.py")
    mode, manifest, root = parse_args(list(sys.argv[1:] if argv is None else argv))
    if mode == "apply":
        result = run_extraction(manifest, apply=True, source_root=root)
        if result["status"] == "blocked":
            result = verify_blocked_extraction(manifest, source_root=root)
    else:
        try:
            result = verify_extraction(manifest, source_root=root)
        except ConferenceExtractionError as ready_error:
            try:
                result = verify_blocked_extraction(manifest, source_root=root)
            except ConferenceExtractionError:
                raise ready_error
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return result


if __name__ == "__main__":
    try:
        main()
    except ConferenceExtractionError as exc:
        print(f"[conference-filter-evidence-extract] {exc}", file=sys.stderr)
        raise SystemExit(1)

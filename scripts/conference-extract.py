#!/usr/bin/env python3
"""对已暂存的一篇会议 PDF 做文本与视觉审计抽取，产物不再改动；这是它的命令行入口。"""

import json
import sys

from runtime_guard import require_external_runtime
from conference_extractor import ConferenceExtractionError, parse_args, run_extraction, verify_extraction


def main(argv=None):
    # 先挡掉沙箱内的直接调用，连命令行参数都还没解析。下面那次按模式区分的
    # 检查会给写操作补上 history 角色，同时允许从已经过角色校验的流程里做
    # 固定版本的只读重放。
    require_external_runtime("conference-extraction-replay")
    mode, manifest_name, source_root = parse_args(list(sys.argv[1:] if argv is None else argv))
    # 校验模式也用作已过角色校验的 Node 生产流程内部的固定版本只读重放。
    # apply 和 dry-run 仍是 history 的直接入口；npm 包装层还会把每种模式都
    # 绑到 history 上。
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
